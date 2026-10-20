// User-Agent 处理（主进程）
//
// 为什么要改 UA：Electron 默认 UA 里带 `Electron/33.x` 和应用名标识，
// 部分文档站点（Google 登录、企业 SSO 等）会因此判定为"不受支持的浏览器"而拒绝服务。
//
// 这里不靠"删关键词"（漏一个就白干），而是用原 UA 里的平台信息 + 当前 Chromium 版本
// 重建一个标准 Chrome UA：输出确定，且与应用名/Electron 版本无关。

const PLATFORM_FALLBACK = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

function buildCleanUA(ua, { platform = process.platform, chromeVersion = process.versions.chrome } = {}) {
  const source = String(ua || '');
  const platformPart = /\(([^)]*)\)/.exec(source)?.[1] || PLATFORM_FALLBACK[platform] || PLATFORM_FALLBACK.linux;
  return `Mozilla/5.0 (${platformPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

module.exports = { buildCleanUA };