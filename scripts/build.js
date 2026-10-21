#!/usr/bin/env node
/**
 * 跨平台打包脚本（统一入口，自动适配操作系统）
 *
 * 用法（在项目根目录执行）：
 *   node scripts/build.js           # 打包「当前操作系统」对应的安装包
 *   node scripts/build.js win       # Windows → NSIS 安装包 + portable 绿色版
 *   node scripts/build.js mac       # macOS   → dmg + zip
 *   node scripts/build.js linux     # Linux   → AppImage + deb
 *   node scripts/build.js all       # 三端依次打包（注意下方限制）
 *
 * 等价 npm 命令：
 *   npm run build        → 当前系统
 *   npm run build:win / build:mac / build:linux / build:all
 *
 * 各平台具体产物类型在 package.json 的 "build" 字段配置，本脚本只决定打哪个平台。
 */

const { spawnSync } = require('child_process');

// Electron 运行时（100MB+ 压缩包）默认从国内镜像取。
// 原因：github.com 的 DNS 在部分网络下会偶发 ENOTFOUND，一失败整个打包就中断；
// 镜像同时提供三端产物，不影响 win/linux 打包。
// 需要回官方源：ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ npm run build
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  console.log(`Electron 镜像：${process.env.ELECTRON_MIRROR}（可用 ELECTRON_MIRROR 覆盖）`);
}

// Electron 运行时（~120MB）缓存放在仓库里，和 Android 的 .cache-android 一个思路：
// 默认的 ~/Library/Caches/electron 在沙箱/CI/多用户机器上经常不可写（EPERM），
// 而构建痕迹留在仓库里可以随时删掉重来，行为也更可预测。此目录已在 .gitignore。
if (!process.env.ELECTRON_CACHE) {
  const path = require('path');
  process.env.ELECTRON_CACHE = path.join(__dirname, '..', '.cache-electron');
  console.log(`Electron 缓存：${process.env.ELECTRON_CACHE}（可用 ELECTRON_CACHE 覆盖）`);
}

// 目标平台 → electron-builder 命令行参数
const FLAGS = {
  win: ['--win'],
  mac: ['--mac'],
  linux: ['--linux'],
  all: ['--mac', '--win', '--linux'],
};

// process.platform → 默认目标
const CURRENT_PLATFORM = {
  win32: 'win',
  darwin: 'mac',
  linux: 'linux',
}[process.platform];

// 解析参数（默认打包当前系统）
const input = (process.argv[2] || 'current').toLowerCase();
const target = input === 'current' ? CURRENT_PLATFORM : input;

if (!FLAGS[target]) {
  console.error('用法: node scripts/build.js [win|mac|linux|all|current]');
  process.exit(1);
}

// 跨平台构建限制提示（仅提醒，不阻断执行）
const CROSS_TIPS = {
  win: '在非 Windows 上打 NSIS 安装包需要 Wine（Linux/macOS）。',
  mac: 'macOS 的 dmg/签名基本只能在 macOS 上完成；其他系统通常无法生成可用安装包。',
  linux: 'deb 等建议在 Linux 上构建；AppImage 更通用，多数环境可出包。',
};
const SELF_PLATFORM = { win: 'win32', mac: 'darwin', linux: 'linux' };
if (
  target !== 'all' &&
  SELF_PLATFORM[target] !== process.platform &&
  CROSS_TIPS[target]
) {
  console.warn(`\n⚠️  ${CROSS_TIPS[target]}\n`);
}

console.log(`\n===== 开始打包：${target} =====\n`);

// 复用 electron-builder 的 CLI 入口，避免 .bin 在 Linux/macOS(可执行脚本)、
// Windows(cmd/ps1) 之间的 shim 差异；直接用 node 跑其 js 入口最稳。
let cli;
try {
  cli = require.resolve('electron-builder/out/cli/cli.js');
} catch (e) {
  console.error('未找到 electron-builder，请先执行：npm install');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, ...FLAGS[target]], {
  stdio: 'inherit',
});

if (result.status === 0) {
  // 把这次真正产出的文件列出来，省得靠猜（也方便脚本/CI 判断成功与否）
  const fs = require('fs');
  const path = require('path');
  const dist = path.join(__dirname, '..', 'dist');
  try {
    const files = fs
      .readdirSync(dist)
      .filter((name) => /\.(dmg|zip|exe|AppImage|deb)$/i.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(dist, name));
        return `  ${(stat.size / 1024 / 1024).toFixed(0)} MB  dist/${name}`;
      });
    if (files.length) console.log(`\n===== 打包完成 =====\n${files.join('\n')}\n`);
    else console.log('\n===== 打包完成（dist/ 里没有安装包，可能只生成了目录）=====\n');
  } catch {
    console.log('\n===== 打包完成，产物在 dist/ 目录 =====\n');
  }
} else {
  console.error(`\n===== 打包失败（exit code ${result.status}）=====\n`);
}
process.exit(result.status == null ? 1 : result.status);