// 令牌发现层：在"可移动介质"的常见挂载点里找 DocVault.key。
//
// 为什么不用原生 API 枚举 USB：node-hid/驱动枚举都要原生依赖，
// 而软件令牌阶段只需要"文件在不在"。扫描几个固定挂载点成本极低（几次 existsSync），
// 硬件令牌（HID）接入后，这里换成设备枚举即可，上层接口不变。
//
// DOCVAULT_TOKEN_DIR 可以追加扫描目录（开发/演示时没有 U 盘也能跑）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const soft = require('./soft-token');

// 各平台的候选根目录（只列"外部介质"出现的地方 + 环境变量指定处）
function candidateRoots() {
  const roots = [];
  const extra = process.env.DOCVAULT_TOKEN_DIR;
  if (extra) {
    for (const dir of extra.split(path.delimiter)) {
      if (dir.trim()) roots.push(dir.trim());
    }
  }
  if (process.platform === 'win32') {
    // 逐个盘符探测（跳过系统盘 C:，令牌不该放系统盘）
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code);
      if (letter === 'C') continue;
      roots.push(`${letter}:\\`);
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Volumes');
  } else {
    roots.push('/media', '/mnt');
    // os.userInfo() 在无 passwd 条目的容器里会抛错：没有 /run/media/<user> 就不加这个根
    try {
      roots.push(path.join('/run/media', os.userInfo().username));
    } catch {
      /* 忽略 */
    }
  }
  return roots;
}

// 一个目录里所有令牌文件（同一张盘可能放多枚：DocVault.key、DocVault-mac.key …）
function scanDir(dir) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // 盘符不存在 / 无权限：正常情况
  }
  for (const entry of entries) {
    if (!entry.isFile() || !soft.TOKEN_PATTERN.test(entry.name)) continue;
    const info = soft.readTokenInfo(path.join(dir, entry.name));
    if (info) found.push(info);
  }
  return found;
}

// 根目录（U 盘根）直接找；挂载点目录（/Volumes、/media）再下探。
// 令牌现在放在 <U盘>/<平台>/DocVault.key，如果用户选的是 U 盘里的子目录，
// 还会再深一层（<U盘>/DocVault/mac/DocVault.key），所以最多下探两层。
const MAX_DEPTH = 2;

function scanTree(root, depth) {
  const found = scanDir(root);
  if (depth <= 0) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 跳过明显的系统目录，避免在 /Volumes 之外误扫
    if (entry.name.startsWith('.')) continue;
    found.push(...scanTree(path.join(root, entry.name), depth - 1));
  }
  return found;
}

function scanRoot(root) {
  return scanTree(root, MAX_DEPTH);
}

// 返回当前插着的所有令牌（按序列号去重，同一枚令牌出现在两个挂载点只算一次）
function discover() {
  const bySerial = new Map();
  for (const root of candidateRoots()) {
    for (const info of scanRoot(root)) {
      if (!bySerial.has(info.serial)) bySerial.set(info.serial, info);
    }
  }
  return [...bySerial.values()];
}

function findBySerial(serial) {
  return discover().find((token) => token.serial === serial) || null;
}

module.exports = { candidateRoots, discover, findBySerial };
