// 打开中的标签页（会话）持久化。
//
// 目的：关闭应用再打开时，能把上次打开的网页标签放回来。
// 安全边界：标签里是文档链接，属于隐私数据——
//   - 未启用 U盾：与 library.json 同级别的明文，写 session.json（0600）
//   - 已启用 U盾：**必须加密**，写 session.enc（AES-256-GCM，用保险库的 DEK）。
//     锁定时解密不出来，所以此时只能返回 null；解锁后（DEK 在内存里）才读得到。
// 两种模式互斥：切换时会清掉另一种文件，避免明文残留。

const fs = require('fs');
const path = require('path');

const PLAIN_FILE = 'session.json';
const ENC_FILE = 'session.enc';
const MAX_TABS = 50;

// 只保留恢复所需字段，并做长度限制
function normalize(state) {
  if (!state || !Array.isArray(state.tabs)) return null;
  return {
    tabs: state.tabs
      .filter((t) => t && typeof t.url === 'string' && t.url)
      .slice(0, MAX_TABS)
      .map((t) => ({
        url: String(t.url).slice(0, 2048),
        title: String(t.title || '').slice(0, 200),
        docId: t.docId ? String(t.docId).slice(0, 64) : null,
      })),
    // -1 表示停在「文档库」列表页
    activeIndex: Number.isInteger(state.activeIndex) ? state.activeIndex : 0,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.dataDir 数据目录
 * @param {() => boolean} deps.isVaultEnabled
 * @param {() => boolean} deps.isVaultLocked
 * @param {() => {encode:Function, decode:Function}} deps.codec 保险库编解码（锁定时调用会抛）
 */
function createSessionStore({ dataDir, isVaultEnabled, isVaultLocked, codec }) {
  const plainFile = path.join(dataDir, PLAIN_FILE);
  const encFile = path.join(dataDir, ENC_FILE);

  function remove(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 忽略 */
    }
  }

  function save(state) {
    const clean = normalize(state);
    if (!clean) return false;
    try {
      if (isVaultEnabled()) {
        // 锁定时 DEK 不在内存里，写不了加密文件——保留磁盘上的上一份即可
        if (isVaultLocked()) return false;
        const buf = codec().encode(Buffer.from(JSON.stringify(clean), 'utf-8'));
        fs.writeFileSync(encFile, buf, { mode: 0o600 });
        remove(plainFile); // 别留明文
      } else {
        fs.writeFileSync(plainFile, `${JSON.stringify(clean, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
        remove(encFile);
      }
      return true;
    } catch (err) {
      console.error(`[session] 保存失败：${err.message}`);
      return false;
    }
  }

  function load() {
    try {
      if (isVaultEnabled()) {
        if (isVaultLocked() || !fs.existsSync(encFile)) return null;
        const raw = codec().decode(fs.readFileSync(encFile));
        return normalize(JSON.parse(raw.toString('utf-8')));
      }
      if (!fs.existsSync(plainFile)) return null;
      return normalize(JSON.parse(fs.readFileSync(plainFile, 'utf-8')));
    } catch (err) {
      // 密文损坏 / 换了保险库 / JSON 坏了：当作没有会话，不阻断启动
      console.error(`[session] 读取失败：${err.message}`);
      return null;
    }
  }

  function clear() {
    remove(plainFile);
    remove(encFile);
  }

  return { save, load, clear, files: { plainFile, encFile } };
}

module.exports = { createSessionStore, normalize, PLAIN_FILE, ENC_FILE };
