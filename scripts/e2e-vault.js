#!/usr/bin/env node
/**
 * U盾保护端到端回归（驱动真实界面，不是 mock）。
 *
 * 用法：npm run test:e2e   （或 node scripts/e2e-vault.js）
 *
 * 脚本会：
 *   1. 在 .tmp-e2e/ 里准备临时数据目录和一枚软件令牌（不碰真实数据）；
 *   2. 启动 Electron（--remote-debugging-port=9226）；
 *   3. 通过 CDP 走完整用户流程：
 *      添加文档 → 启用向导 → 加密迁移校验 → 手动锁定 → 错误 PIN →
 *      正确 PIN 解锁 → 拔盾自动锁 → 插回解锁 → 恢复码 + 新令牌救回数据；
 *   4. 关闭应用，打印结果。任何一步失败退出码非 0。
 *
 * 依赖：node_modules 里的 electron（npm install 之后即可）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '.tmp-e2e');
const DATA = path.join(ROOT, 'data');
const TOKEN_DIR = path.join(ROOT, 'token');
// 令牌现在按系统分目录存放（<目录>/mac/DocVault.key），不能再硬编码根目录路径，
// 否则"拔盾"步骤 rename 会 ENOENT。实际路径以 createToken 的返回值为准。
let TOKEN_FILE = null;
const PORT = 9226;
const PIN = '123456';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => fs.writeSync(1, '[e2e] ' + s + '\n');

let electronProc = null;
const sockets = new Set();
function cleanup() {
  for (const ws of sockets) {
    try { ws.close(); } catch { /* 忽略 */ }
  }
  sockets.clear();
  if (electronProc && !electronProc.killed) {
    try { electronProc.kill(); } catch { /* 忽略 */ }
  }
}
// 先关句柄再退出，避免 Windows 上 libuv 的 UV_HANDLE_CLOSING 断言
function finish(code) {
  cleanup();
  setTimeout(() => process.exit(code), 300);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect(match) {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) throw new Error(`no target: ${match} (have: ${list.map((t) => t.url).join(', ')})`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  sockets.add(ws);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  const failAll = (reason) => {
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  };
  ws.onclose = () => failAll('target closed');
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new Error('cdp: ' + m.error.message));
      } else if (m.result && m.result.exceptionDetails) {
        const d = m.result.exceptionDetails;
        p.reject(new Error('page: ' + ((d.exception && d.exception.description) || d.text)));
      } else {
        p.resolve(m.result ? m.result.result.value : null);
      }
    }
  };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('evaluate timeout'));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return { ws, evaluate };
}

async function waitFor(fn, timeout = 20000, step = 400) {
  const end = Date.now() + timeout;
  let lastErr;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (err) { lastErr = err; }
    await sleep(step);
  }
  throw new Error('waitFor timeout' + (lastErr ? `: ${lastErr.message}` : ''));
}

const CLICK = (sel, text) => `(() => {
  const n = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)}));
  if (!n) throw new Error('button not found: ' + ${JSON.stringify(text)});
  n.click(); return true;
})()`;

// 侧栏底部的文字链接已改成品牌行右侧的「⋯」菜单（桌面端另有系统菜单栏），
// 这里通过窗口内那个入口驱动界面，文案不变。
const OPEN_MORE_MENU = `document.getElementById('moreBtn').click()`;
const INIT_RENDERED = `document.querySelector('.side-foot').textContent.includes('条记录')`;
// 等渲染层的 state.info 更新（renderFoot 会写这个状态点），而不只是主进程状态：
// 启用后紧接着要点「⋯」菜单里的「锁定」，菜单内容取决于渲染层这一份 info。
const VAULT_UI_ENABLED = `(() => {
  const node = document.querySelector('.menubar-status');
  return Boolean(node && node.title.includes('U盾保护中'));
})()`;

const SUBMIT_PIN = (pin) => `(() => {
  document.getElementById('pinInput').value = ${JSON.stringify(pin)};
  document.getElementById('pinForm').requestSubmit();
  return true;
})()`;

async function main() {
  // ---- 准备临时环境 ----
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const soft = require('../src/token/soft-token');
  TOKEN_FILE = (await soft.createToken(TOKEN_DIR, PIN)).path;
  log('临时令牌已创建');

  // ---- 启动应用 ----
  const electronBin = require('electron'); // 纯 Node 环境下返回二进制路径
  const env = {
    ...process.env,
    DOCVAULT_DATA_DIR: DATA,
    DOCVAULT_TOKEN_DIR: TOKEN_DIR,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electronProc = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'ignore',
  });
  await waitFor(async () => {
    try { await targets(); return true; } catch { return null; }
  }, 30000);
  log('应用已启动');

  // 1. 主界面：添加一条文档（幂等：页面加载竞态下重试不会重复添加）
  let shell = await connect('shell.html');
  await waitFor(() => shell.evaluate(`window.api.getLibrary().then(lib =>
    lib.docs.some(d => d.url === 'https://example.com/e2e-secret')
      ? true
      : window.api.addDoc({ url: 'https://example.com/e2e-secret', title: 'E2E 机密文档', note: '加密迁移验证' }).then(() => true)
  )`));
  log('文档已添加');

  // 2. 打开启用向导 → 选择令牌（等侧栏渲染完成再点）
  await waitFor(() => shell.evaluate(INIT_RENDERED));
  await shell.evaluate(OPEN_MORE_MENU);
  await shell.evaluate(CLICK('.menubar-entry', '启用 U盾保护'));
  await waitFor(() => shell.evaluate(`document.querySelectorAll('.token-item').length > 0`));
  await shell.evaluate(`document.querySelector('.token-item').click()`);
  log('向导：已选择令牌');

  // 3. 输入 PIN → 加密并启用
  await waitFor(() => shell.evaluate(`Boolean(document.querySelector('.modal-form input[type=password]'))`));
  await shell.evaluate(`(() => {
    const inputs = document.querySelectorAll('.modal-form input[type=password]');
    inputs[0].value = ${JSON.stringify(PIN)};
    if (inputs[1]) inputs[1].value = ${JSON.stringify(PIN)};
    document.querySelector('.modal-form').requestSubmit();
    return true;
  })()`);
  const code = await waitFor(() => shell.evaluate(`(document.querySelector('.recovery-code') || {}).textContent || ''`));
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(code)) throw new Error('恢复码格式不对: ' + code);
  log('向导：恢复码已展示 ' + code.slice(0, 9) + '…');

  // 4. 确认保存 → 完成
  await shell.evaluate(`(() => {
    const cb = document.querySelector('.modal input[type=checkbox]');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await shell.evaluate(CLICK('.modal button', '完成'));
  await waitFor(() => shell.evaluate(VAULT_UI_ENABLED));
  log('保护已启用，侧栏状态正确');

  // 5. 文件层面：密文存在、明文被抹掉
  if (!fs.existsSync(path.join(DATA, 'library.enc'))) throw new Error('library.enc 不存在');
  if (fs.existsSync(path.join(DATA, 'library.json'))) throw new Error('明文 library.json 未被清理');
  const enc = fs.readFileSync(path.join(DATA, 'library.enc'));
  if (enc.includes(Buffer.from('e2e-secret'))) throw new Error('密文里出现了明文链接！');
  log('文件校验：library.enc 存在，明文已清理，密文不含明文');

  // 6. 手动锁定 → 锁定页（点击后主窗口立即销毁，应答可能丢失，属预期）
  await shell.evaluate(OPEN_MORE_MENU).catch(() => {});
  await shell.evaluate(CLICK('.menubar-entry', '锁定')).catch(() => {});
  let lock = await waitFor(async () => {
    try { return await connect('lock.html'); } catch { return null; }
  });
  try { shell.ws.close(); } catch { /* 忽略 */ }
  log('已锁定，锁定页出现');

  // 7. 等令牌检测到 → 先输错 PIN
  await waitFor(() => lock.evaluate(`document.getElementById('tokenState').classList.contains('ok')`));
  await lock.evaluate(SUBMIT_PIN('999999')).catch(() => {});
  await waitFor(() => lock.evaluate(`(document.getElementById('unlockError').textContent || '').includes('PIN 不正确')`));
  log('错误 PIN 被拒绝：' + (await lock.evaluate(`document.getElementById('unlockError').textContent`)));

  // 8. 正确 PIN 解锁 → 回到主界面，数据完好
  await lock.evaluate(SUBMIT_PIN(PIN)).catch(() => {});
  shell = await waitFor(async () => {
    try { return await connect('shell.html'); } catch { return null; }
  });
  try { lock.ws.close(); } catch { /* 忽略 */ }
  const lib = await waitFor(() => shell.evaluate(`window.api.getLibrary()`));
  if (!lib.docs.some((d) => d.url === 'https://example.com/e2e-secret')) throw new Error('解锁后数据丢失');
  log('PIN 解锁成功，数据完好（' + lib.docs.length + ' 条）');

  // 9. 拔盾（移走令牌文件）→ 自动锁定
  fs.renameSync(TOKEN_FILE, TOKEN_FILE + '.away');
  lock = await waitFor(async () => {
    try { return await connect('lock.html'); } catch { return null; }
  }, 12000);
  try { shell.ws.close(); } catch { /* 忽略 */ }
  log('拔盾后自动锁定 ✓');

  // 10. 插回令牌 → 再次解锁
  fs.renameSync(TOKEN_FILE + '.away', TOKEN_FILE);
  await waitFor(() => lock.evaluate(`document.getElementById('tokenState').classList.contains('ok')`));
  await lock.evaluate(SUBMIT_PIN(PIN)).catch(() => {});
  shell = await waitFor(async () => {
    try { return await connect('shell.html'); } catch { return null; }
  });
  try { lock.ws.close(); } catch { /* 忽略 */ }
  const lib2 = await waitFor(() => shell.evaluate(`window.api.getLibrary()`));
  if (lib2.docs.length !== lib.docs.length) throw new Error('二次解锁数据不一致');
  log('插回令牌后解锁成功 ✓');

  // 11. 再锁一次（等新窗口侧栏渲染完再点）
  await waitFor(() => shell.evaluate(INIT_RENDERED));
  await shell.evaluate(OPEN_MORE_MENU).catch(() => {});
  await shell.evaluate(CLICK('.menubar-entry', '锁定')).catch(() => {});
  lock = await waitFor(async () => {
    try { return await connect('lock.html'); } catch { return null; }
  });
  try { shell.ws.close(); } catch { /* 忽略 */ }
  log('再次锁定 ✓');

  // 12. 恢复码流程：模拟"令牌丢了"——移走旧令牌，用恢复码 + 新令牌救回数据
  await waitFor(() => lock.evaluate(`window.__lockReady === true`));
  fs.renameSync(TOKEN_FILE, TOKEN_FILE + '.lost');
  const newTokenDir = path.join(TOKEN_DIR, 'newtoken');
  fs.mkdirSync(newTokenDir, { recursive: true });
  await soft.createToken(newTokenDir, '654321');

  await lock.evaluate(`document.getElementById('toRecover').click()`);
  await waitFor(() => lock.evaluate(`!document.getElementById('recoverView').hidden`));
  await lock.evaluate(`(() => {
    document.getElementById('codeInput').value = ${JSON.stringify(code)};
    document.getElementById('recoverForm').requestSubmit();
    return true;
  })()`);
  await waitFor(async () => {
    const shown = await lock.evaluate(`!document.getElementById('bindStep').hidden`);
    if (!shown) {
      const err = await lock.evaluate(`(document.getElementById('recoverError').textContent || '')`);
      if (err) throw new Error('恢复码被拒绝: ' + err);
    }
    return shown;
  });
  log('恢复码验证通过，进入绑定新令牌步骤');

  // 13. 选择新令牌 → PIN → 绑定
  await waitFor(() => lock.evaluate(`document.querySelectorAll('#bindTokenList .token-item').length > 0`));
  await lock.evaluate(`(() => {
    const items = [...document.querySelectorAll('#bindTokenList .token-item')];
    const fresh = items.find(x => x.textContent.includes('newtoken')) || items[items.length - 1];
    fresh.click();
    return true;
  })()`);
  await waitFor(() => lock.evaluate(`!document.getElementById('bindForm').hidden`));
  await lock.evaluate(`(() => {
    document.getElementById('bindPin').value = '654321';
    document.getElementById('bindPin2').value = '654321';
    document.getElementById('bindForm').requestSubmit();
    return true;
  })()`);
  const newCode = await waitFor(async () => {
    const v = await lock.evaluate(`(document.getElementById('newCodeText').textContent || '')`);
    if (!v) {
      const err = await lock.evaluate(`(document.getElementById('bindError').textContent || '')`);
      if (err) throw new Error('绑定失败: ' + err);
    }
    return v;
  });
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(newCode)) throw new Error('新恢复码格式不对: ' + newCode);
  if (newCode === code) throw new Error('换绑后恢复码应当更新');
  log('新令牌绑定成功，新恢复码已生成');

  // 14. 确认保存 → 进入文档库，数据完好
  await lock.evaluate(`(() => {
    const cb = document.getElementById('newCodeSaved');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    document.getElementById('finishBtn').click();
    return true;
  })()`).catch(() => {});
  shell = await waitFor(async () => {
    try { return await connect('shell.html'); } catch { return null; }
  });
  try { lock.ws.close(); } catch { /* 忽略 */ }
  const lib3 = await waitFor(() => shell.evaluate(`window.api.getLibrary()`));
  if (!lib3.docs.some((d) => d.url === 'https://example.com/e2e-secret')) throw new Error('恢复后数据丢失');
  log('恢复码救回数据成功 ✓');
}

main()
  .then(() => {
    log('E2E 全部通过 ✅');
    finish(0);
  })
  .catch((err) => {
    fs.writeSync(2, '[e2e] FAIL: ' + err.message + '\n');
    finish(1);
  });
