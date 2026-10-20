#!/usr/bin/env node
/**
 * 图标生成脚本（开发工具，不参与运行时）
 *
 * 用法：
 *   npm run icons            # 生成 build/ 下的 icon.svg / icon.png / icon.icns / icon.ico / icons/*.png
 *                            # 以及设计评审用的 build/preview.png 与三个方案的 SVG
 *
 * 说明：
 * - 图标形状用 n=5 超椭圆（近似 macOS Big Sur 的 squircle），画布 1024，图形区 824（四周留 100 安全边距）；
 * - 用 Electron 自己渲染 SVG，因此文字/渐变/阴影的效果与最终 Chromium 渲染完全一致；
 * - .icns 用系统 iconutil 打包（仅 macOS），.ico 由本脚本直接写 PNG-in-ICO（现代 Windows 支持）。
 *
 * 环境注意：如果所在终端设了 ELECTRON_RUN_AS_NODE=1，需要 `env -u ELECTRON_RUN_AS_NODE npm run icons`。
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const CANVAS = 1024;
const INSET = 100;
const SHAPE = CANVAS - INSET * 2; // 824

// ---------- 形状 ----------

// 超椭圆路径：按弧长等距取样，避免拐角处被拉直
function squirclePath(size, exponent = 5, samples = 220) {
  const half = size / 2;
  const dense = 4096;
  const raw = [];
  for (let i = 0; i <= dense; i += 1) {
    const t = (i / dense) * Math.PI * 2;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    raw.push([
      half + Math.sign(cos) * Math.abs(cos) ** (2 / exponent) * half,
      half + Math.sign(sin) * Math.abs(sin) ** (2 / exponent) * half,
    ]);
  }
  const cumulative = [0];
  for (let i = 1; i < raw.length; i += 1) {
    cumulative.push(cumulative[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];
  const points = [];
  let cursor = 0;
  for (let k = 0; k < samples; k += 1) {
    const target = (k / samples) * total;
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor += 1;
    const span = cumulative[cursor + 1] - cumulative[cursor] || 1;
    const ratio = (target - cumulative[cursor]) / span;
    points.push([
      raw[cursor][0] + (raw[cursor + 1][0] - raw[cursor][0]) * ratio,
      raw[cursor][1] + (raw[cursor + 1][1] - raw[cursor][1]) * ratio,
    ]);
  }
  return `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
}

const SQUIRCLE = squirclePath(SHAPE);
const SHAPE_MASK_ID = 'shapeMask';

// 统一的字体栈（macOS 上 -apple-system → SF Pro）
const FONT = "-apple-system, 'SF Pro Display', 'Helvetica Neue', 'PingFang SC', Arial, sans-serif";

// ---------- 三个设计方案 ----------

// 方案 A：书签徽章 —— 靛蓝渐变 squircle + 底部书签缺口 + 白色 GT
function conceptA() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="aBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8B93FF"/>
      <stop offset="0.45" stop-color="#5B54E8"/>
      <stop offset="1" stop-color="#3B32B8"/>
    </linearGradient>
    <radialGradient id="aGlow" cx="0.28" cy="0.16" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.34"/>
      <stop offset="0.6" stop-color="#FFFFFF" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <mask id="${SHAPE_MASK_ID}">
      <path d="${SQUIRCLE}" fill="#fff"/>
      <!-- 底部中间挖出书签缺口（保留圆角轮廓的其余部分） -->
      <path d="M269,${SHAPE + 10}L412,${SHAPE - 118}L555,${SHAPE + 10}Z" fill="#000"/>
    </mask>
    <filter id="aShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#1E1B4B" flood-opacity="0.26"/>
    </filter>
  </defs>
  <g transform="translate(${INSET},${INSET})" filter="url(#aShadow)">
    <g mask="url(#${SHAPE_MASK_ID})">
      <path d="${SQUIRCLE}" fill="url(#aBg)"/>
      <path d="${SQUIRCLE}" fill="url(#aGlow)"/>
      <!-- 内侧高光描边，浅色背景下轮廓更清晰 -->
      <path d="${SQUIRCLE}" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="5"/>
    </g>
  </g>
  <text x="512" y="372" text-anchor="middle" dominant-baseline="central"
        font-family="${FONT}" font-size="326" font-weight="800" letter-spacing="-8"
        fill="#FFFFFF">GT</text>
</svg>`;
}

// 方案 B：文档叠层 —— 深色底 + 两张文档页，GT 印在前页
function conceptB() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2E3350"/>
      <stop offset="1" stop-color="#151827"/>
    </linearGradient>
    <linearGradient id="bPage" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#E9ECF8"/>
    </linearGradient>
    <linearGradient id="bHead" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6D66F0"/>
      <stop offset="1" stop-color="#4338CA"/>
    </linearGradient>
    <clipPath id="bClip">
      <rect x="322" y="200" width="400" height="556" rx="34"/>
    </clipPath>
    <filter id="bShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#0B0D16" flood-opacity="0.45"/>
    </filter>
  </defs>
  <g filter="url(#bShadow)">
    <path d="${SQUIRCLE}" fill="url(#bBg)" transform="translate(${INSET},${INSET})"/>
  </g>
  <g transform="translate(${INSET},${INSET})">
    <!-- 后面那张纸 -->
    <g transform="rotate(-9 412 412)" opacity="0.5">
      <rect x="152" y="232" width="356" height="466" rx="30" fill="#FFFFFF"/>
    </g>
    <!-- 前面那张纸 -->
    <rect x="322" y="200" width="400" height="556" rx="34" fill="url(#bPage)"/>
    <g clip-path="url(#bClip)">
      <rect x="322" y="200" width="400" height="96" fill="url(#bHead)"/>
    </g>
    <text x="522" y="520" text-anchor="middle" dominant-baseline="central"
          font-family="${FONT}" font-size="238" font-weight="800" letter-spacing="-6"
          fill="#3B32B8">GT</text>
  </g>
</svg>`;
}

// 方案 C：字标霓虹 —— 深空底 + 渐变发光 GT
function conceptC() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <radialGradient id="cBg" cx="0.5" cy="0.34" r="0.78">
      <stop offset="0" stop-color="#323A6B"/>
      <stop offset="0.62" stop-color="#1D2140"/>
      <stop offset="1" stop-color="#12142A"/>
    </radialGradient>
    <linearGradient id="cText" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#C7D2FE"/>
      <stop offset="0.5" stop-color="#8B93FF"/>
      <stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <filter id="cGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="0" stdDeviation="26" flood-color="#6366F1" flood-opacity="0.75"/>
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0B0D16" flood-opacity="0.5"/>
    </filter>
    <filter id="cShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#07080F" flood-opacity="0.5"/>
    </filter>
  </defs>
  <g filter="url(#cShadow)">
    <path d="${SQUIRCLE}" fill="url(#cBg)" transform="translate(${INSET},${INSET})"/>
    <path d="${SQUIRCLE}" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="6"
          transform="translate(${INSET},${INSET})"/>
  </g>
  <g filter="url(#cGlow)">
    <text x="512" y="512" text-anchor="middle" dominant-baseline="central"
          font-family="${FONT}" font-size="336" font-weight="800" letter-spacing="-8"
          fill="url(#cText)">GT</text>
  </g>
</svg>`;
}

const CONCEPTS = [
  { id: 'A', name: '书签徽章', desc: '靛蓝渐变 + 书签缺口 + 白色 GT', svg: conceptA, chosen: true },
  { id: 'B', name: '文档叠层', desc: '深色底 + 两张文档页，GT 印在前页', svg: conceptB, chosen: false },
  { id: 'C', name: '字标霓虹', desc: '深空底 + 渐变发光 GT', svg: conceptC, chosen: false },
];

// ---------- 渲染 ----------

function loadWindow() {
  return new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 判断截图是不是全透明（show:false 时个别系统可能不合成）
function isBlank(image) {
  const bitmap = image.toBitmap();
  for (let i = 3; i < bitmap.length; i += 4 * 97) {
    if (bitmap[i] !== 0) return false;
  }
  return true;
}

async function renderHtml(win, html, width, height, attempt = 1) {
  win.setContentSize(width, height);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await wait(attempt === 1 ? 700 : 1400);
  const image = await win.webContents.capturePage();
  if (isBlank(image) && attempt < 2) {
    win.showInactive(); // 兜底：某些环境需要窗口真正显示才能合成
    return renderHtml(win, html, width, height, attempt + 1);
  }
  return image;
}

function pngBuffer(image, size) {
  const resized = size === image.getSize().width ? image : image.resize({ width: size, height: size, quality: 'best' });
  return resized.toPNG();
}

// ---------- 打包 icns / ico / linux png ----------

const ICNS_SIZES = [
  ['icon_16x16', 16],
  ['icon_16x16@2x', 32],
  ['icon_32x32', 32],
  ['icon_32x32@2x', 64],
  ['icon_128x128', 128],
  ['icon_128x128@2x', 256],
  ['icon_256x256', 256],
  ['icon_256x256@2x', 512],
  ['icon_512x512', 512],
  ['icon_512x512@2x', 1024],
];

function writeIcns(baseImage, outFile) {
  const iconset = path.join(BUILD_DIR, 'icon.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  for (const [name, size] of ICNS_SIZES) {
    fs.writeFileSync(path.join(iconset, `${name}.png`), pngBuffer(baseImage, size));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outFile]);
  fs.rmSync(iconset, { recursive: true, force: true });
}

// ICO：直接写 PNG-in-ICO（Vista 以后支持），无需额外依赖
function writeIco(baseImage, outFile, sizes = [16, 24, 32, 48, 64, 128, 256]) {
  const entries = sizes.map((size) => ({ size, buf: pngBuffer(baseImage, size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, index) => {
    const at = 16 * index;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4); // color planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(entry.buf.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.buf.length;
  });

  fs.writeFileSync(outFile, Buffer.concat([header, dir, ...entries.map((entry) => entry.buf)]));
}

function writeLinuxIcons(baseImage) {
  const dir = path.join(BUILD_DIR, 'icons');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(dir, `${size}x${size}.png`), pngBuffer(baseImage, size));
  }
}

// ---------- 设计评审预览图 ----------

function previewHtml(svgs) {
  const at = (svg, size) =>
    `<span class="slot" style="width:${size}px;height:${size}px">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</span>`;

  const concepts = CONCEPTS.map(
    (concept) => `
    <figure class="card">
      ${at(svgs[concept.id], 220)}
      <figcaption><b>方案 ${concept.id} · ${concept.name}</b><span>${concept.desc}</span></figcaption>
    </figure>`
  ).join('');

  const sizes = [16, 24, 32, 48, 64, 96, 128, 256];
  const sizeRow = sizes
    .map(
      (size) => `<div class="sizeItem">${at(svgs.A, size)}<span>${size}px</span></div>`
    )
    .join('');

  const dockIcons = ['#4B5563', '#0EA5E9', '#F59E0B']
    .map((color) => `<span class="dockIcon" style="background:${color}"></span>`)
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: 1360px; height: 1040px; font-family: ${FONT}; background: #EFF0F5; color: #1A1A1F; padding: 26px 30px; }
    h1 { font-size: 20px; font-weight: 700; }
    h1 span { font-weight: 400; font-size: 13px; color: #6B6B7B; margin-left: 10px; }
    .row { display: flex; gap: 18px; margin-top: 20px; }
    .card { flex: 1; background: #fff; border-radius: 16px; padding: 20px 16px 14px; text-align: center;
            box-shadow: 0 6px 20px rgba(20,20,45,.07); display: flex; flex-direction: column; align-items: center; gap: 14px; }
    figcaption { display: flex; flex-direction: column; gap: 3px; }
    figcaption b { font-size: 13.5px; }
    figcaption span { font-size: 11.5px; color: #77778A; }
    .slot { display: inline-flex; align-items: center; justify-content: center; }
    .slot svg { display: block; }
    .panel { margin-top: 18px; background: #fff; border-radius: 16px; padding: 16px 20px; box-shadow: 0 6px 20px rgba(20,20,45,.07); }
    .panel h2 { font-size: 12px; letter-spacing: .5px; text-transform: uppercase; color: #8A8A9A; margin-bottom: 14px; }
    .sizeRow { display: flex; align-items: flex-end; gap: 22px; }
    .sizeItem { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .sizeItem span { font-size: 10.5px; color: #9A9AAA; }
    .split { display: flex; gap: 18px; margin-top: 18px; }
    .tile { flex: 1; border-radius: 16px; padding: 18px; display: flex; align-items: center; gap: 18px; }
    .tile.light { background: #fff; box-shadow: 0 6px 20px rgba(20,20,45,.07); }
    .tile.dark { background: #22242F; color: #fff; }
    .tile p { font-size: 12px; color: #8A8A9A; margin-top: 4px; }
    .tile.dark p { color: #9A9AAD; }
    .dock { flex: 1; height: 92px; border-radius: 16px; background: rgba(240,240,248,.72);
            border: 1px solid rgba(255,255,255,.7); backdrop-filter: blur(14px);
            display: flex; align-items: center; justify-content: center; gap: 12px;
            box-shadow: 0 6px 20px rgba(20,20,45,.07); }
    .dockIcon { width: 58px; height: 58px; border-radius: 14px; display: inline-block; opacity: .55; }
    .brandRow { display: flex; align-items: center; gap: 10px; }
    .brandMark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
                 background: linear-gradient(145deg, #8B93FF, #5B54E8 55%, #3B32B8);
                 color: #fff; font-weight: 800; font-size: 13px; letter-spacing: .2px; }
    .brandText { display: flex; flex-direction: column; line-height: 1.2; }
    .brandText b { font-size: 15px; }
    .brandText i { font-style: normal; font-size: 11.5px; color: #8A8A9A; }
  </style></head><body>
    <h1>文档库 · 应用图标设计稿<span>画布 1024 · n=5 超椭圆 · 图形区 824（四周 100 安全边距）</span></h1>
    <div class="row">${concepts}</div>
    <div class="panel"><h2>方案 A 多尺寸观感（16px 起是否还能认出 GT）</h2><div class="sizeRow">${sizeRow}</div></div>
    <div class="split">
      <div class="tile light"><div class="slot" style="width:132px;height:132px">${svgs.A.replace(/width="\d+" height="\d+"/, 'width="132" height="132"')}</div>
        <div><b>浅色环境</b><p>白色/浅灰背景下的对比与投影</p></div></div>
      <div class="tile dark"><div class="slot" style="width:132px;height:132px">${svgs.A.replace(/width="\d+" height="\d+"/, 'width="132" height="132"')}</div>
        <div><b>深色环境</b><p>深色背景/深色模式下的辨识度</p></div></div>
    </div>
    <div class="split">
      <div class="dock">${dockIcons}${at(svgs.A, 58)}${dockIcons}</div>
      <div class="tile light" style="flex:1;justify-content:flex-start">
        <span class="brandMark">GT</span>
        <span class="brandText"><b>文档库</b><i>在线文档收藏</i></span>
        <span style="font-size:11.5px;color:#9A9AAA;margin-left:auto">← 侧栏内的品牌标记（CSS 版）</span>
      </div>
    </div>
  </body></html>`;
}

// ---------- 主流程 ----------

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.mkdirSync(path.join(BUILD_DIR, 'concepts'), { recursive: true });

  const svgs = {};
  for (const concept of CONCEPTS) {
    svgs[concept.id] = concept.svg().trim();
    fs.writeFileSync(path.join(BUILD_DIR, 'concepts', `${concept.id}-${concept.name}.svg`), `${svgs[concept.id]}\n`);
  }

  const chosen = CONCEPTS.find((concept) => concept.chosen);
  const iconSvg = svgs[chosen.id];
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.svg'), `${iconSvg}\n`);

  const win = loadWindow();
  const master = await renderHtml(win, iconSvg, CANVAS, CANVAS);
  const size = master.getSize();
  if (size.width !== CANVAS) {
    console.log(`[icons] 渲染尺寸 ${size.width}px，已按 1024 缩放（建议加 --force-device-scale-factor=1）`);
  }
  const master1024 = size.width === CANVAS ? master : master.resize({ width: CANVAS, height: CANVAS, quality: 'best' });

  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), master1024.toPNG());
  writeLinuxIcons(master1024);
  writeIco(master1024, path.join(BUILD_DIR, 'icon.ico'));
  if (process.platform === 'darwin') writeIcns(master1024, path.join(BUILD_DIR, 'icon.icns'));

  const preview = await renderHtml(win, previewHtml(svgs), 1360, 1040);
  fs.writeFileSync(path.join(BUILD_DIR, 'preview.png'), preview.toPNG());

  win.destroy();
  console.log(`[icons] 已生成：build/icon.svg, icon.png, icon.ico${process.platform === 'darwin' ? ', icon.icns' : ''}, icons/*.png, preview.png`);
  console.log(`[icons] 采用方案 ${chosen.id} · ${chosen.name}（其余方案见 build/concepts/）`);
  app.quit();
});