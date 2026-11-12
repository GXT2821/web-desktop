#!/usr/bin/env node
/**
 * 免 PIN（物理钥匙）端到端回归：npm run test:e2e:auto
 *
 * 场景与真实使用一致：
 *   1. U 盘里放一枚免 PIN 令牌 → 启用保护（无需输入 PIN）；
 *   2. 关掉应用再打开（令牌插着）→ 应当直接进文档库，不出现锁定页；
 *   3. 拔掉令牌 → 自动上锁，出现锁定页；
 *   4. 插回令牌 → 自动解锁，回到文档库。
 *
 * 全部使用 .tmp-e2e-auto/ 临时目录，不碰真实数据。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '.tmp-e2e-auto');
const DATA = path.join(ROOT, 'data');
const TOKEN_DIR = path.join(ROOT, 'token');
const TOKEN_FILE = path.join(TOKEN_DIR, 'DocVault.key');
const PORT = 9227;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => fs.writeSync(1, '[auto] ' + s + '\n');

let electronProc = null;
const sockets = new Set();
function cleanup() {
  for (const ws of sockets) { try { ws.close(); } catch { /* 忽略 */ } }
  sockets.clear();
  if (electronProc && !electronProc.killed) { try { electronProc.kill(); } catch { /* 忽略 */ } }
}
function finish(code) {
  cleanup();
  setTimeout(() => process.exit(code), 300);
}
process.on('exit', cleanup);

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect(match) {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && t.url.includes(match));
  if (!page) throw new Error(`no target: ${match}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  sockets.add(ws);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0;
  const pending = new Map();
  ws.onclose = () => {
    for (const [, p] of pending) p.reject(new Error('target closed'));
    pending.clear();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error('cdp: ' + m.error.message));
      else if (m.result && m.result.exceptionDetails) {
        const d = m.result.exceptionDetails;
        p.reject(new Error('page: ' + ((d.exception && d.exception.description) || d.text)));
      } else p.resolve(m.result ? m.result.result.value : null);
    }
  };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('evaluate timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return { ws, evaluate };
}

async function waitFor(fn, timeout = 25000, step = 350) {
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

function launch() {
  const electronBin = require('electron');
  const env = { ...process.env, DOCVAULT_DATA_DIR: DATA, DOCVAULT_TOKEN_DIR: TOKEN_DIR };
  delete env.ELECTRON_RUN_AS_NODE;
  electronProc = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'ignore',
  });
}

async function stopApp() {
  if (electronProc && !electronProc.killed) {
    electronProc.kill();
    electronProc = null;
  }
  // 等端口释放，避免重启时连到旧进程
  for (let i = 0; i < 40; i += 1) {
    try { await targets(); } catch { return; }
    await sleep(250);
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const soft = require('../src/token/soft-token');
  await soft.createToken(TOKEN_DIR, '', { pinFree: true });
  log('已准备免 PIN 令牌');

  // ---------- 首次启动：启用保护 ----------
  launch();
  await waitFor(async () => { try { await targets(); return true; } catch { return null; } }, 30000);
  let shell = await connect('shell.html');
  await waitFor(() => shell.evaluate(`[...document.querySelectorAll('.side-foot button')].some(b => b.textContent.includes('启用 U盾保护'))`));
  await shell.evaluate(`window.api.addDoc({ url: 'https://example.com/auto-unlock', title: '自动解锁验证' })`);
  log('文档已添加');

  await shell.evaluate(CLICK('.side-foot button', '启用 U盾保护'));
  await waitFor(() => shell.evaluate(`document.querySelectorAll('.token-item').length > 0`));
  await shell.evaluate(`document.querySelector('.token-item').click()`);
  const hasPinField = await shell.evaluate(`Boolean(document.querySelector('.modal-form input[type=password]:not([disabled])'))`);
  if (hasPinField) throw new Error('免 PIN 令牌不应要求输入 PIN');
  await shell.evaluate(CLICK('.modal button', '加密并启用'));
  const code = await waitFor(() => shell.evaluate(`(document.querySelector('.recovery-code') || {}).textContent || ''`));
  if (!/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(code)) throw new Error('恢复码格式不对');
  await shell.evaluate(`(() => {
    const cb = document.querySelector('.modal input[type=checkbox]');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await shell.evaluate(CLICK('.modal button', '完成'));
  await waitFor(() => shell.evaluate(`document.querySelector('.side-foot').textContent.includes('U盾保护中')`));
  log('保护已启用（免 PIN），无需输入 PIN');

  if (!fs.existsSync(path.join(DATA, 'library.enc'))) throw new Error('library.enc 不存在');
  if (fs.existsSync(path.join(DATA, 'library.json'))) throw new Error('明文库未被清理');
  log('加密文件已生成，明文已清理');

  // ---------- 重启：插着令牌应停在“读取完成”界面，点确定才进 ----------
  try { shell.ws.close(); } catch { /* 忽略 */ }
  await stopApp();
  launch();
  await waitFor(async () => { try { await targets(); return true; } catch { return null; } }, 30000);
  let lock = await waitFor(async () => {
    try { return await connect('lock.html'); } catch { return null; }
  }, 15000);
  // 动画播完后出现「确定进入文档库」，点了才进主界面
  await waitFor(() => lock.evaluate(`window.__lockReady === true`));
  await waitFor(() => lock.evaluate(`(() => {
    const b = document.getElementById('enterBtn');
    return Boolean(b) && !b.hidden && !b.disabled;
  })()`), 15000);
  log('重启后读取完成，出现「确定进入」按钮 ✓');
  await lock.evaluate(`document.getElementById('enterBtn').click()`).catch(() => {});
  shell = await waitFor(async () => {
    try { return await connect('shell.html'); } catch { return null; }
  }, 15000);
  try { lock.ws.close(); } catch { /* 忽略 */ }
  const lib = await waitFor(() => shell.evaluate(`window.api.getLibrary()`));
  if (!lib.docs.some((d) => d.url === 'https://example.com/auto-unlock')) throw new Error('自动解锁后数据丢失');
  log('点确定后进入文档库，数据完好 ✓');

  // ---------- 拔掉令牌 → 自动上锁 ----------
  fs.renameSync(TOKEN_FILE, TOKEN_FILE + '.away');
  lock = await waitFor(async () => {
    try { return await connect('lock.html'); } catch { return null; }
  }, 12000);
  try { shell.ws.close(); } catch { /* 忽略 */ }
  await waitFor(() => lock.evaluate(`window.__lockReady === true`));
  log('拔掉令牌后自动上锁 ✓');

  // ---------- 插回令牌 → 读取 → 点确定 → 进入 ----------
  fs.renameSync(TOKEN_FILE + '.away', TOKEN_FILE);
  await waitFor(() => lock.evaluate(`(() => {
    const b = document.getElementById('enterBtn');
    return Boolean(b) && !b.hidden && !b.disabled;
  })()`), 15000);
  log('插回令牌后读取完成，等待确认 ✓');
  await lock.evaluate(`document.getElementById('enterBtn').click()`).catch(() => {});
  shell = await waitFor(async () => {
    try { return await connect('shell.html'); } catch { return null; }
  }, 15000);
  try { lock.ws.close(); } catch { /* 忽略 */ }
  const lib2 = await waitFor(() => shell.evaluate(`window.api.getLibrary()`));
  if (!lib2.docs.some((d) => d.url === 'https://example.com/auto-unlock')) throw new Error('插回后数据丢失');
  log('插回并确认后自动解锁 ✓');

  log('免 PIN 自动解锁 E2E 全部通过 ✅');
}

main()
  .then(() => finish(0))
  .catch((err) => {
    fs.writeSync(2, '[auto] FAIL: ' + err.message + '\n');
    finish(1);
  });