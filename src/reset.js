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
function resetDataDir(dataDir, { deleteToken = false, tokenPath = null } = {}) {
  const removed = [];
  const failed = [];
  for (const name of listTargets(dataDir)) {
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

  return { removed, failed };
}

module.exports = { resetDataDir, listTargets, APP_FILES };