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

// 文档库 / 保险库 / 下载记录，以及原子写留下的临时文件
const APP_FILES = [
  'library.json',
  'library.json.bak',
  'library.json.tmp',
  'library.enc',
  'library.enc.bak',
  'library.enc.tmp',
  'vault.json',
  'vault.json.tmp',
  'downloads.json',
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

// deleteToken：是否连 U 盘上的令牌文件一起删（用户明确勾选才做）
// keepBackup：重置前先把要删的文件复制到 reset-backup-<时间>/，
// 避免"点错一次，数据直接没了"（这个目录不会被下次重置删掉）。
function resetDataDir(dataDir, { deleteToken = false, tokenPath = null, keepBackup = true } = {}) {
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
    const tokenFile = path.resolve(tokenPath);
    for (const file of [tokenFile, `${tokenFile}.tmp`]) {
      try {
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
          removed.push(path.basename(file));
        }
      } catch (err) {
        failed.push({ name: path.basename(file), error: err.message });
      }
    }
  }

  return { removed, failed, backupDir };
}

module.exports = { resetDataDir, listTargets, APP_FILES };