// U 盘身份：把令牌绑定到"这张盘"，而不是"这个文件"。
//
// 各平台拿到的是各自的"卷标识"，**互不相同**（实测同一个 FAT 卷：
// Windows 报 FB7C-00BC，macOS 报 815CF869-0410-33F0-8AEC-DB21AF0C4CAB）。
// 所以跨系统共用时不能拿一方的值去比另一方——这正是"每套系统一枚令牌"
// （tokens 数组）存在的原因：每枚令牌只在自己的系统上比对。
//
//   Windows:  cmd /c vol D:            →  "Volume Serial Number is 2E2A-723A"
//   macOS:    diskutil info <挂载点>    →  Volume UUID
//   Linux:    findmnt + blkid          →  文件系统 UUID（vfat/exfat 即卷序列号）
//
// 为什么不用磁盘硬件序列号：Win32_DiskDrive.SerialNumber 要 WMI 关联查询，
// 单次约 400ms，放在解锁路径上会明显拖慢启动。卷序列号通常随格式化生成，
// 复制文件到另一张 U 盘时必然不同——足以挡住"把 DocVault.key 拷走"。
// 代价：专业工具可以改写卷序列号，对抗克隆盘需要硬件令牌（见 README）。

const { execFileSync } = require('child_process');
const path = require('path');

const TIMEOUT_MS = 3000;

// 令牌文件所在的"卷"，不是"文件所在目录"。
// Windows 是盘符根；macOS/Linux 必须解析到挂载点——path.parse('/Volumes/U盘/x').root
// 返回的是 '/'，直接用它会把令牌绑到系统盘上（macOS 上曾经就是这个 bug）。
function mountRoot(file) {
  const abs = path.resolve(file);
  if (process.platform === 'darwin') {
    const match = abs.match(/^\/Volumes\/([^/]+)/);
    return match ? `/Volumes/${match[1]}` : '/';
  }
  if (process.platform === 'linux') {
    const patterns = [/^\/media\/[^/]+\/[^/]+/, /^\/run\/media\/[^/]+\/[^/]+/, /^\/mnt\/[^/]+/];
    for (const pattern of patterns) {
      const match = abs.match(pattern);
      if (match) return match[0];
    }
    return '/';
  }
  return path.parse(abs).root;
}

function parseVolOutput(text) {
  const match = String(text || '').match(/([0-9A-F]{4})-([0-9A-F]{4})/i);
  return match ? `${match[1].toUpperCase()}-${match[2].toUpperCase()}` : null;
}

function parseDiskutilUuid(text) {
  const match = String(text || '').match(/Volume UUID:\s*([0-9A-F-]{36})/i);
  return match ? match[1].toUpperCase() : null;
}

// 令牌文件所在卷的身份；无法识别时返回 null（不绑定，保持可用）
function identify(file) {
  const root = mountRoot(file);
  if (!root) return null;
  try {
    if (process.platform === 'win32') {
      // cmd 的 vol 不接受带尾部反斜杠的盘符（"D:\" 会报找不到驱动器），要用 "D:"
      const letter = root.replace(/[\\/]+$/, '');
      const out = execFileSync('cmd', ['/c', 'vol', letter], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        windowsHide: true,
      });
      const volumeSerial = parseVolOutput(out);
      return volumeSerial ? { root: letter, volumeSerial } : null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('diskutil', ['info', root], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      const volumeSerial = parseDiskutilUuid(out);
      return volumeSerial ? { root, volumeSerial } : null;
    }
    if (process.platform === 'linux') {
      // 先找挂载点对应的块设备，再读文件系统 UUID。
      // vfat/exfat 的 UUID 就是卷序列号，和 Windows `vol` 报的是同一个值。
      const device = execFileSync('findmnt', ['-no', 'SOURCE', '--target', root], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      }).trim();
      if (!device) return null;
      const uuid = execFileSync('blkid', ['-s', 'UUID', '-o', 'value', device], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      }).trim();
      return uuid ? { root, volumeSerial: uuid.toUpperCase() } : null;
    }
  } catch {
    // vol/diskutil 不存在、盘已拔出、超时：都当作"无法识别"
    return null;
  }
  return null;
}

module.exports = { identify, mountRoot, parseVolOutput, parseDiskutilUuid };