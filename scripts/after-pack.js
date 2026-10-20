#!/usr/bin/env node
/**
 * electron-builder 的 afterPack 钩子：负责 macOS 产物的两件事——翻转 fuses、ad-hoc 签名。
 *
 * 为什么不用 package.json 里的 electronFuses 配置：
 *   electron-builder 在 afterPack 之后才翻转 fuses，会把这里刚做好的签名又作废；
 *   而 Apple Silicon 上签名失效的二进制会被系统直接 SIGKILL（"Killed: 9"，窗口都出不来）。
 *   所以顺序必须由我们自己控制：先翻 fuses → 再签名。
 *
 * fuses 的作用：
 *   runAsNode=off                       环境里若有 ELECTRON_RUN_AS_NODE=1，不再把应用当 Node 跑
 *   enableNodeOptionsEnvironmentVariable=off  忽略 NODE_OPTIONS（挡住 --require 注入）
 *   enableNodeCliInspectArguments=off   忽略 --inspect 参数
 *   onlyLoadAppFromAsar=on              只从 app.asar 加载，顺带挡住"改资源文件注入代码"
 *
 * 配了 Developer ID（CSC_LINK / CSC_NAME）时，这里检测到有效签名就跳过，不覆盖正式签名。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// macOS 靠 .lproj 目录 + Info.plist 的 CFBundleLocalizations 判断应用支持哪些语言。
// electron-builder 打包时会把 Electron 自带的 55 个 .lproj 全部裁掉，Info.plist 也没声明，
// 结果系统按英文对待应用：app.getLocale() 与 navigator.language 都变成 en-US，文档站整页英文。
// 这里把中文/英文的本地化目录补回去（目录内容可以为空，界面文案在 resources.pak 里）。
const LOCALIZATIONS = ['zh-Hans.lproj', 'zh_CN.lproj', 'en.lproj'];

function ensureLocalizations(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  for (const name of LOCALIZATIONS) {
    fs.mkdirSync(path.join(resources, name), { recursive: true });
  }
}

// 注意 CLI 用的是 PascalCase 的 fuse 名
const FUSES = {
  RunAsNode: 'off',
  EnableNodeOptionsEnvironmentVariable: 'off',
  EnableNodeCliInspectArguments: 'off',
  OnlyLoadAppFromAsar: 'on',
};

function isSigned(appPath) {
  try {
    execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // 本地化目录要在签名之前补，否则又会把签名改坏
  ensureLocalizations(appPath);

  if (!isSigned(appPath)) {
    const args = ['write', '--app', appPath, ...Object.entries(FUSES).map(([k, v]) => `${k}=${v}`)];
    try {
      execFileSync(process.execPath, [require.resolve('@electron/fuses/dist/bin.js'), ...args], {
        stdio: 'inherit',
      });
      console.log('  • 已翻转 electron fuses');
    } catch (err) {
      console.warn(`  • 翻转 fuses 失败（继续打包）: ${err.message}`);
    }
  }

  if (isSigned(appPath)) {
    console.log('  • macOS 签名有效，跳过 ad-hoc 重签');
    return;
  }

  console.log('  • 补一次 ad-hoc 签名');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], {
    stdio: 'inherit',
  });
};