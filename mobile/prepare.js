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

console.log(`[prepare] 已生成 ${path.relative(process.cwd(), outDir)}（${SHARED.length + fs.readdirSync(ownDir).length} 个文件）`);