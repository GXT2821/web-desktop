// 重置：清空文档库与本机保护配置（应用内「重置」按钮的后端）。
//
// 只删除"应用数据"文件，不动 Chromium 的网页缓存/Cookie——
// 保留登录态是产品特性；要连登录态一起清，直接删整个数据目录
// （README「常见问题」里给了路径）。
//
// 单独放一个模块是为了能脱离 Electron 做断言：删除清单、令牌可选删除、
// 部分文件删不掉时的错误收集，都在这里测。

const fs = require('fs');
const path = require('path');
const soft = require('./token/soft-token');

// 文档库 / 保险库 / 下载记录，以及原子写留下的临时文件
const APP_FILES = [
  'library.json',
  'library.json.bak',
  'library.json.tmp',
  'library.enc',
  'library.enc.bak',
  'library.enc.tmp',
  'vault.json',
  'vault.json.bak',
  'vault.json.tmp',
  'downloads.json',
  // downloads.js 的原子写同样会留 .tmp：漏了它，重置后残留文件会被下次启动读回
  'downloads.json.tmp',
  // 打开中的标签页（明文 / 加密两种形态）
  'session.json',
  'session.enc',
];

// 列出本次会删除的文件（含 library.*.corrupt-* 留档）
function listTargets(dataDir) {
  const names = new Set(APP_FILES);
  let entries = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (/^library\.(json|enc)\.corrupt-/.test(name)) names.add(name);
  }
  return [...names].filter((name) => fs.existsSync(path.join(dataDir, name)));
}

// 删除一枚令牌文件：先校验序列号，避免盘符复用后误删别的库的令牌。
// 返回 { removed, path?, error? }；供重置和"停用保护"共用。
function removeTokenFile({ tokenPath = null, expectedSerial = null } = {}) {
  if (!tokenPath) return { removed: false };
  const file = path.resolve(tokenPath);
  const info = soft.readTokenInfo(file);
  if (!info) return { removed: false, error: '令牌文件不存在或无效' };
  if (expectedSerial && info.serial !== expectedSerial) {
    return { removed: false, error: '令牌序列号与当前库不匹配，已跳过删除' };
  }
  try {
    fs.rmSync(file, { force: true });
    return { removed: true, path: file };
  } catch (err) {
    return { removed: false, error: err.message };
  }
}

// deleteToken：是否连 U 盘上的令牌文件一起删（用户明确勾选才做）
// expectedSerial：本库绑定的令牌序列号。盘符可能被复用，删除前必须确认
//                 "这个路径上的令牌确实是本库的"，否则会误删别人/别的库的令牌。
// keepBackup：重置前先把要删的文件复制到 reset-backup-<时间>/，
// 避免"点错一次，数据直接没了"（这个目录不会被下次重置删掉）。
function resetDataDir(
  dataDir,
  { deleteToken = false, tokenPath = null, expectedSerial = null, keepBackup = true } = {}
) {
  const removed = [];
  const failed = [];
  const targets = listTargets(dataDir);

  let backupDir = null;
  if (keepBackup && targets.length) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupDir = path.join(dataDir, `reset-backup-${stamp}`);
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      for (const name of targets) {
        fs.copyFileSync(path.join(dataDir, name), path.join(backupDir, name));
      }
    } catch (err) {
      backupDir = null;
      failed.push({ name: '（备份）', error: err.message });
      // 备份失败就不要继续删——宁可这次重置失败，也不能悄悄丢数据
      return { removed, failed, backupDir };
    }
  }

  for (const name of targets) {
    const file = path.join(dataDir, name);
    try {
      fs.rmSync(file, { force: true });
      removed.push(name);
    } catch (err) {
      failed.push({ name, error: err.message });
    }
  }

  if (deleteToken && tokenPath) {
    const result = removeTokenFile({ tokenPath, expectedSerial });
    if (result.removed) removed.push(path.basename(result.path));
    else if (result.error) failed.push({ name: path.basename(tokenPath), error: result.error });
  }

  return { removed, failed, backupDir };
}

module.exports = { resetDataDir, listTargets, removeTokenFile, APP_FILES };