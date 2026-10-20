# 文档库（doc-vault）

用 Electron 做的**在线文档收藏夹**：把散落在浏览器标签里的在线文档链接长期存下来，需要时一键在应用内打开。

浏览器关掉标签就找不回来了，收藏夹又容易越堆越乱。这个软件只做一件事——**帮你记住链接**（不抓取网页内容、不做离线快照），并用文件夹树、标签和搜索让它们随时能被找回来。登录态由应用自己保留，常用站点不用反复登录。

## 功能

- **文件夹树**：可任意嵌套，父文件夹视图包含子文件夹的文档；删除文件夹时可选"仅删文件夹（文档移到未分类）"或"连同内容删除"。
- **标签 + 搜索**：标签跨文件夹标记，多个标签同时满足（AND）；搜索框对标题、链接、备注、标签做多关键词匹配（空格分隔 = AND）。
- **内置视图**：全部文档 / 星标 / 最近打开 / 未分类。
- **侧栏可折叠**：点品牌行右侧的按钮把侧栏收成 64px 图标栏（只留品牌与四个视图，鼠标悬停有提示），状态会记住；看长文档时把横向空间全留给正文，`⌘F/Ctrl+F` 会自动展开再聚焦搜索。
- **应用内打开**：每条文档一个标签页，标题栏显示当前地址，可就地后退、刷新、复制链接、切换系统浏览器；隐藏标签不渲染，降低占用。
- **标题自动补全**：添加时标题可以留空，第一次打开后自动取网页真实标题（只补一次，之后你改过的标题不会被覆盖）。
- **记录打开次数与最近打开时间**，方便回顾"存了但一直没用"的东西。
- **数据完全在本地**，一个可读的 JSON 文件，随时备份、迁移、手工编辑。

## 运行

```bash
npm install     # 首次运行，下载 Electron
npm start
```

> Windows 上如果 PowerShell 拦 `npm.ps1`，请用 `npm.cmd`。

## 数据存在哪

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/DocVault/library.json` |
| Windows | `%APPDATA%\DocVault\library.json` |
| Linux | `~/.config/DocVault/library.json` |

- 写入采用"临时文件 + 原子替换"，覆盖前会留一份 `library.json.bak`；
- **主文件损坏时自动回退备份**，并把坏文件改名为 `library.json.corrupt-<时间>` 留档，不会静默丢数据；
- 侧栏底部「打开数据文件位置」可直接在访达/资源管理器中定位；
- 想把数据放到 iCloud、移动硬盘或做便携运行，可以用环境变量指定目录：
  ```bash
  DOCVAULT_DATA_DIR="/Volumes/U盘/DocVault" npm start
  ```

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Cmd/Ctrl + N` | 添加文档 |
| `Cmd/Ctrl + F` | 聚焦搜索框 |
| `Cmd/Ctrl + W` | 关闭当前网页标签（「文档库」标签固定不关） |
| `Cmd/Ctrl + R` | 刷新当前网页 |
| `Cmd/Ctrl + 1~9` | 切换到第 N 个标签 |
| `F12` / `Cmd(Ctrl) + Alt + I` | 打开调试器（焦点在网页里时由主进程转发） |

## 目录结构

```
doc-vault/
├── main.js          主进程：窗口、IPC、webview 策略（UA 清洗 / 弹窗拦截 / 导航白名单）、窗口尺寸记忆
├── preload.js       安全桥：只暴露 window.api 的具体方法
├── src/
│   ├── store.js     数据层：library.json 的读写、字段校验、原子写 + 备份 + 损坏恢复
│   ├── shell.html   外壳结构（侧栏 + 标签栏 + 工具条 + 内容区 + 弹窗）
│   ├── shell.css    全部样式
│   ├── library.js   文档库：侧栏视图、文件夹树、标签、搜索、列表、增删改弹窗
│   └── shell.js     标签页与 webview 管理、错误页、快捷键
├── build/           图标资源（icon.svg 为设计源，icns/ico/多尺寸 png 为产物）
└── scripts/
    ├── build.js         跨平台打包入口
    └── build-icons.js   图标生成：超椭圆形状 + 三个方案 + 设计评审图
```

## 应用图标

图标是**方案 A · 书签徽章**：靛蓝渐变方块 + 底部书签缺口 + 白色 **GT** 字标（GT 既是个人标识，也让图标在 48px 以上能直接被认出）。

- 画布 1024×1024，图形区 824×824（四周留 100 安全边距），轮廓是 **n=5 超椭圆**（贴近 macOS Big Sur 的 squircle，比普通圆角矩形更"顺"）；
- 主色沿用应用主题的靛蓝 `#8B93FF → #5B54E8 → #3B32B8`，浅色/深色背景下都够清楚；
- 侧栏左上角的品牌标记是同一套视觉的 CSS 版（渐变方块 + GT），见 `src/shell.css` 的 `.brand-mark`。

重新生成（改了设计后执行，产物会覆盖 `build/`）：

```bash
npm run icons
```

产物：`build/icon.icns`（macOS，含 16→1024 全部 10 个尺寸）、`build/icon.ico`（Windows，7 个尺寸）、`build/icons/*.png`（Linux）、`build/icon.png`（1024，开发期 Dock/窗口图标）、`build/preview.png`（设计评审图：三个方案对比 + 多尺寸观感 + 浅色/深色/Dock 场景）。

想换方案：打开 `scripts/build-icons.js`，把 `CONCEPTS` 里想要的方案标成 `chosen: true`，再跑一次 `npm run icons`。备选方案（B 文档叠层 / C 字标霓虹）的 SVG 也在 `build/concepts/` 里，可以直接拿去改。图标只在打包时用到，`build/` 不会打进应用包。

## 打包

```bash
node scripts/build.js            # 当前系统
node scripts/build.js win        # Windows：NSIS 安装包 + portable
node scripts/build.js mac        # macOS：dmg + zip
node scripts/build.js linux      # Linux：AppImage + deb
node scripts/build.js all        # 三端依次打包
```

等价 npm 命令：`npm run build` / `build:win` / `build:mac` / `build:linux` / `build:all`，产物在 `dist/`。

macOS 上会得到 `dist/DocVault-<版本>-<架构>.dmg`（拖进「应用程序」安装）、同名的 `.zip`（绿色版）以及 `dist/mac-arm64/文档库.app`（未压缩的包，可直接运行）。

打包环境的两点说明：

- **只做 ad-hoc 签名**：打包时 `scripts/after-pack.js` 会补一次 ad-hoc 签名（`codesign -s -`），保证翻转 fuses 后产物在本机能正常启动；这**不等于**正式分发签名——把安装包发给别人，对方打开时仍会提示"无法验证开发者"，需要右键 →「打开」，或先执行 `xattr -dr com.apple.quarantine /Applications/文档库.app`。要正式分发得配 Apple Developer ID 证书并公证，届时脚本检测到有效签名会自动跳过，不会覆盖。
- **dmg 需要能创建磁盘映像的环境**：electron-builder 调 `hdiutil` 生成 dmg，在权限受限的沙箱/CI 里会报 `hdiutil: create failed - 操作不被允许`，此时只能拿到 zip（zip 在任何环境都能出）。

## 安全说明

信任边界很清晰：**主进程是唯一可信边界**，渲染层只能通过 `window.api` 暴露的固定方法操作数据。

- **数据校验**：所有写操作都在 `src/store.js` 里做字段白名单校验，链接只接受 `http/https`（`javascript:`、`file:`、`data:` 一律拒绝），文本去控制字符并按上限截断；不抓取网页内容、不存快照。
- **外壳隔离**：外壳窗口 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`；`<webview>` 挂载前会强制清掉 preload、关掉 Node 与 webSecurity；外壳窗口**有导航守卫**，把链接或 HTML 文件拖到窗口上不会再替换外壳页面（否则新页面会继承 preload，直接拿到 `window.api` 读写整个文档库）。
- **权限与下载**：网页权限默认拒绝，只放行全屏和"复制到剪贴板"两项；网页发起的下载会先暂停并弹窗确认，且**同一时刻只允许一个确认框、3 秒内只问一次**，页面循环触发下载也无法刷屏。
- **外壳 CSP**：`script-src 'self'`（内联脚本已被实测挡住）+ `object-src 'none'` / `base-uri 'none'` / `form-action 'none'`；所有用户数据走 `textContent`，`el()` 不提供 `innerHTML` 入口。
- **数据文件**：数据目录 `0700`、`library.json` 与备份 `0600`（每次启动会把历史遗留的 0644 一并纠正，见 `Store#tighten`），原子写 + 备份 + 损坏留档；留档的 `.corrupt-*` 只保留最近 5 个。超大文件（>50 MB）按损坏处理，原文件留档而不是硬解析。
- **启动即建数据目录**：Chromium 的单实例锁要往数据目录写 `SingletonLock`，目录不存在时锁会静默失败（两个实例会互相覆盖库文件），所以启动第一件事就是建目录。
- **打包产物加固（fuses）**：`RunAsNode` / `NODE_OPTIONS` / `--inspect` 全部关闭，只从 `app.asar` 加载。翻转 fuses 会改写二进制，Apple Silicon 上必须重签才能运行，因此 `scripts/after-pack.js` 在打包时自动补一次 ad-hoc 签名（配了 Developer ID 就会跳过，不会覆盖正式签名）。
- **调试器**：`F12` / `Cmd+Shift+I` 只在开发模式生效；打包版默认关闭（发布版里开着调试器等于把脚本执行入口摆在界面上），排查时用 `DOCVAULT_DEVTOOLS=1` 启动。

运行时为 **Electron 41.10.7**（41.x 是当前维护分支）。升级前 33.4.11 已停止安全更新，`npm audit` 对其报出 38 条公告（含 webview 在 Worker 里开 Node、沙箱文档经 window.open 丢失限制、HTTP 重定向进入 file loader 等 high 级问题）；升级后 `npm audit` 无 high/critical，仅剩构建期依赖（electron-builder 链）的 moderate 条目，这些不进最终产物。

另外仓库不做代码签名与公证：产物在本机可用，分发给他人需自行配置 Developer ID 并公证（见「打包」）。

## 测试

数据层有独立断言（不依赖 Electron），覆盖 URL 协议白名单、字段白名单、标签/长度限制、文件夹 keep/cascade 删除、备份与损坏恢复、文件权限 `0600`、原型污染：

```bash
npm test        # node --test test/store.test.js
```

## 常见问题

- **内嵌打不开 / 登录跳转异常**：部分站点（飞书、Google、企业 SSO 等）限制在 Electron 里登录。用卡片上的「用系统浏览器打开」；或者先在内嵌窗口里走一遍登录，Electron 的 session 是持久化的，下次打开仍是登录状态。
- **页面白屏**：应用内会显示错误页（含错误码），可以直接重试、复制链接或切浏览器。停用（ERR_ABORTED）等正常打断不会报错。
- **打开的网页是英文**：应用默认把网页语言固定为简体中文（请求头 `Accept-Language: zh-CN`、`navigator.language` 也是 `zh-CN`）。这一步是必需的——electron-builder 会把 Electron 自带的 `.lproj` 本地化目录全部裁掉，macOS 因此把未声明中文的 `.app` 当英文对待，打包版会比开发模式多出一层"英文"。想换语言用 `DOCVAULT_LANG=ja-JP` 之类启动即可。
- **`npm install` 报 `EPERM ... ~/.npm/_cacache`**：本机 npm 缓存里有 root 属主的文件。不动全局缓存，改用项目内缓存即可：
  ```bash
  npm install --cache ./.npm-cache
  ```
- **Electron 二进制下载慢或失败**：缓存目录也指向工作区，并走国内镜像：
  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  electron_config_cache="$PWD/.electron-cache" \
  npm install --cache ./.npm-cache
  ```
- **打包时卡在下载 Electron / 报 `connect ETIMEDOUT …:443`**：electron-builder 默认从 github.com 取 Electron 本体和它自己的工具（dmg-builder 等）。网络不通时走国内镜像：

  ```bash
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run build:mac
  ```

- **完全离线打包**：把 `.electron-cache` 里的 Electron zip 解开，直接让 electron-builder 用它，不联网也能出包：

  ```bash
  unzip -q .electron-cache/*/electron-v41.10.7-darwin-arm64.zip -d .electron-cache/dist
  ./node_modules/.bin/electron-builder --mac --config.electronDist="$PWD/.electron-cache/dist"
  ```

- **换窗口标题 / 应用名**：改 `main.js` 里的窗口 `title` 与 `package.json` 的 `productName`。数据目录已固定为 `DocVault`，改名不会导致数据"搬家"。同理改 `build.appId`（当前 `com.gt.docvault`）也不会影响数据位置，因为 `userData` 是显式写死的。
- **启动就报 `Cannot read properties of undefined (reading 'setPath')`**：说明环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成普通 Node 跑了。这只影响开发模式（`npm start`）：打包版已经把 `RunAsNode` fuse 关掉，会忽略该环境变量。开发时用 `env -u ELECTRON_RUN_AS_NODE npm start`，或在终端里先 `unset ELECTRON_RUN_AS_NODE`。
- **打包版双击没反应 / 日志里 `Killed: 9`**：二进制被改过（翻 fuses、改 Info.plist）而没重签，Apple Silicon 会直接杀掉进程。仓库的 `scripts/after-pack.js` 已自动补 ad-hoc 签名；如果你手动改过 fuses 配置，请重新跑一次打包，别只替换 `.app` 里的文件。
- **终端里出现 `Electron Security Warning (Insecure Content-Security-Policy)`**：开发模式对 `file://` 页面的误报（CSP 写在 HTML 的 meta 里，Electron 只检查响应头），打包后不再出现，可以忽略。
- **`<webview>` 里页面只显示一小条 / 布局错乱**：外壳的 CSP 必须给 `style-src` 留 `'unsafe-inline'`，否则 Electron 给 webview 元素设的内部样式会被拒绝。