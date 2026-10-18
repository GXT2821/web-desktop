# web-desktop

用 Electron 把多个网页合并成一个桌面应用（左侧导航 + 右侧 `<webview>` 内容区）。

## 目录结构

```
web-desktop/
├── main.js          # 主进程：创建窗口、读取页面配置
├── preload.js       # 安全桥接：暴露 window.api.getPages()
├── config.json      # ★ 页面清单（在这里增删你的页面）
├── package.json     # 项目信息 + 启动脚本
├── src/
│   ├── shell.html   # 应用外壳（导航 + webview）
│   ├── shell.css    # 样式
│   └── shell.js     # 生成导航、切换页面
└── pages/           # 本地 HTML 页面放这里
    ├── page1.html
    └── page2.html
```

## 如何运行

> 注意：本机 PowerShell 会拦 `npm.ps1`，请用 `npm.cmd`。

```bash
cd C:\idea_workspace\web-desktop
npm.cmd install        # 首次运行，下载 Electron
npm.cmd start          # 启动应用
```

如果 Electron 下载慢，可先设置国内镜像：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm.cmd install
```

## 如何增删页面

编辑 `config.json`：

- **本地页面**（自己写的 HTML，放 `pages/` 目录）：

```json
{ "name": "我的页面", "type": "local", "file": "pages/mypage.html" }
```

- **远程网页**（直接嵌入一个网站）：

```json
{ "name": "百度", "type": "remote", "url": "https://www.baidu.com" }
```

改完 `config.json` 后重启应用即可。

## 如何打包

用一个跨平台脚本统一打包，自动适配操作系统：

```bash
node scripts/build.js           # 打包当前系统
node scripts/build.js win       # Windows：NSIS 安装包 + portable 绿色版
node scripts/build.js mac       # macOS：dmg + zip
node scripts/build.js linux     # Linux：AppImage + deb
node scripts/build.js all       # 三端依次打包
```

等价 npm 命令：`npm run build` / `build:win` / `build:mac` / `build:linux` / `build:all`。

产物在 `dist/` 目录。

**跨平台注意：**

- macOS 的 dmg/签名基本只能在 macOS 上生成；
- Windows 的 NSIS 在非 Windows 上需要 Wine；
- Linux 的 deb 建议在 Linux 上构建，AppImage 更通用；
- 默认使用 Electron 自带图标，可在 `package.json` 的 `build` 里配置 `.ico`(Win) / `.icns`(mac) / png 目录(Linux)。

## 常见问题

- `npm` 命令报错 → 用 `npm.cmd` 代替 `npm`；
- 某些网站无法嵌入 → 对方设置了 `X-Frame-Options` 拒绝被内嵌，这类网站无法以页面形式放进 webview；
- 想换窗口标题 → 改 `main.js` 里的 `title` 和 `config.json`/`shell.html` 中的品牌名。