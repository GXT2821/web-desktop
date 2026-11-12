// U 盘身份：把令牌绑定到"这张盘"，而不是"这个文件"。
//
// 用卷序列号（volume serial）做指纹：
//   Windows:  cmd /c vol D:   →  "Volume Serial Number is 2E2A-723A"（约 20ms）
//   macOS:    diskutil info   →  Volume UUID（较慢，按需启用）
//   Linux:    /dev/disk/by-uuid（暂未实现，返回 null 表示不绑定）
//
// 为什么不用磁盘硬件序列号：Win32_DiskDrive.SerialNumber 要 WMI 关联查询，
// 单次约 400ms，放在解锁路径上会明显拖慢启动。卷序列号通常随格式化生成，
// 复制文件到另一张 U 盘时必然不同——足以挡住"把 DocVault.key 拷走"。
// 代价：专业工具可以改写卷序列号，对抗克隆盘需要硬件令牌（见 README）。

const { execFileSync } = require('child_process');
const path = require('path');

const TIMEOUT_MS = 3000;

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
  const root = path.parse(path.resolve(file)).root;
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
  } catch {
    // vol/diskutil 不存在、盘已拔出、超时：都当作"无法识别"
    return null;
  }
  return null;
}

module.exports = { identify, parseVolOutput, parseDiskutilUuid };