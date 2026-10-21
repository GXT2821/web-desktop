#!/usr/bin/env node
/**
 * 把共享渲染层和 Android 端专用文件拼成 Tauri 的 frontendDist（mobile/web）。
 *
 * 为什么要有这一步：桌面端（Electron）和 Android 端（Tauri）共用同一套
 * library.js / shell.css / store-core.js，但 Tauri 只会把 frontendDist 目录里的
 * 内容打包进 APK，没法引用目录外的文件，所以构建前复制一份。
 *
 * 用法：node prepare.js（tauri 的 beforeBuildCommand 也会调用它）
 */

const fs = require('fs');
const path = require('path');

const root = __dirname;
const srcDir = path.resolve(root, '..', 'src');
const outDir = path.join(root, 'web');

// 桌面端与 Android 端共用的文件（单一来源，不复制进仓库）
const SHARED = ['library.js', 'shell.css', 'store-core.js'];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of SHARED) {
  const from = path.join(srcDir, file);
  if (!fs.existsSync(from)) {
    console.error(`[prepare] 缺少共享文件: ${from}`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(outDir, file));
}

// Android 端自己的入口文件
const ownDir = path.join(root, 'web-src');
for (const file of fs.readdirSync(ownDir)) {
  fs.copyFileSync(path.join(ownDir, file), path.join(outDir, file));
}

// Android 启动图标：tauri icon 只写 src-tauri/icons/，不会回头覆盖已经生成的工程，
// 结果 APK 里还是 Tauri 默认图标（和桌面端对不上）。每次构建前同步一次，省得手动拷。
function syncAndroidIcons() {
  const from = path.join(root, 'src-tauri', 'icons', 'android');
  const to = path.join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res');
  if (!fs.existsSync(from) || !fs.existsSync(to)) return 0;

  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
      count += 1;
    }
  }
  return count;
}

const iconCount = syncAndroidIcons();
if (iconCount) console.log(`[prepare] 已同步 Android 图标 ${iconCount} 个文件`);

console.log(`[prepare] 已生成 ${path.relative(process.cwd(), outDir)}（${SHARED.length + fs.readdirSync(ownDir).length} 个文件）`);