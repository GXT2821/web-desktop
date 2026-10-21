#!/usr/bin/env node
/**
 * 给 Tauri 生成的 Android 工程换上 Google Maven 镜像。
 *
 * 背景：这台机器直连 dl.google.com 的 maven 仓库会 TLS 握手失败
 * （Could not GET ... aaptcompiler-9.3.1.pom > Remote host terminated the handshake），
 * 而阿里云的 google 镜像可用。gen/android 是 `tauri android init` 生成的，
 * 重新生成会把改动冲掉，所以放到脚本里每次构建前跑一遍（幂等）。
 *
 * 用法：node scripts/patch-gradle.js
 */

const fs = require('fs');
const path = require('path');

const androidDir = path.resolve(__dirname, '..', 'src-tauri', 'gen', 'android');
const MIRROR = 'maven { url = uri("https://maven.aliyun.com/repository/google") }';
const MARKER = 'aliyun.com/repository/google';

const TARGETS = ['build.gradle.kts', 'buildSrc/build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];

let patched = 0;

for (const rel of TARGETS) {
  const file = path.join(androidDir, rel);
  if (!fs.existsSync(file)) continue;

  const source = fs.readFileSync(file, 'utf-8');
  if (source.includes(MARKER)) continue;

  const lines = source.split('\n');
  const out = [];
  let changed = false;

  for (const line of lines) {
    const isGoogle = /^\s*google\(\)\s*$/.test(line);
    if (isGoogle) {
      const indent = line.match(/^\s*/)[0];
      out.push(`${indent}${MIRROR}`);
      changed = true;
    }
    out.push(line);
  }

  if (changed) {
    fs.writeFileSync(file, out.join('\n'), 'utf-8');
    patched += 1;
    console.log(`[patch-gradle] 已插入镜像: ${rel}`);
  }
}

// 生成 `src-tauri/tauri` 转发脚本：Gradle 的 rust 任务用 `node tauri ...` 调本地 CLI，
// 而 node 把参数当"当前目录下的文件"，没有这个文件就会 MODULE_NOT_FOUND。
const shim = path.resolve(__dirname, '..', 'src-tauri', 'tauri');
const SHIM_BODY = [
  '// 由 scripts/patch-gradle.js 生成（勿手改，删了会自动重建）',
  '//',
  '// Tauri 生成的 Gradle 任务用 `node tauri android android-studio-script ...` 来调本地 CLI，',
  '// 而 node 会把第一个参数当成"相对当前工作目录的文件"，不是模块名，',
  '// 所以这里放一个同名转发脚本，工作目录正是 src-tauri。',
  "require('@tauri-apps/cli/tauri.js');",
  '',
].join('\n');

if (!fs.existsSync(shim) || fs.readFileSync(shim, 'utf-8') !== SHIM_BODY) {
  fs.writeFileSync(shim, SHIM_BODY, 'utf-8');
  console.log('[patch-gradle] 已生成 src-tauri/tauri 转发脚本');
}

// 应用名：Gradle 工程名用 ASCII 更稳（productName=DocVault），但桌面图标下要显示中文
const stringsFile = path.join(androidDir, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
if (fs.existsSync(stringsFile)) {
  const xml = fs.readFileSync(stringsFile, 'utf-8');
  const wanted = [
    '<string name="app_name">"文档库"</string>',
    '<string name="main_activity_title">"文档库"</string>',
  ];
  let next = xml
    .replace(/<string name="app_name">.*?<\/string>/, wanted[0])
    .replace(/<string name="main_activity_title">.*?<\/string>/, wanted[1]);
  if (next !== xml) {
    fs.writeFileSync(stringsFile, next, 'utf-8');
    console.log('[patch-gradle] 应用名已改为 文档库');
  }
}

if (!patched) console.log('[patch-gradle] 无需改动（镜像已存在或工程还没生成）');