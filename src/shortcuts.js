// 网页标签（webview）里，哪些组合键仍然交回应用处理。
//
// 关键：这里**不含 f**。命令键 + F 是网页自己的「查找」，在线文档（金山文档、
// 飞书之类）都靠它打开页内搜索；如果应用拦下来，文档里的搜索就永远打不开。
// 早先的实现把 f 一起转发了，用户点开文档后按 Cmd/Ctrl+F 只会跳回文档库搜索，
// 看起来就像「文档的查找坏了」。
//
// w / r / n / 1-9 是应用自己的标签操作（关闭、刷新、新建、切换），网页用不到，
// 保持拦截。
const GUEST_FORWARDED = /^([1-9]|w|n|r)$/;

/**
 * 判断网页里的按键是否要转发给应用。
 * @param {{meta?: boolean, control?: boolean, shift?: boolean, alt?: boolean, key?: string}} input
 * @param {boolean} isMac
 */
function shouldForwardFromGuest(input, isMac) {
  if (input.shift || input.alt) return false;
  const mod = isMac ? input.meta : input.control;
  if (!mod) return false;
  return GUEST_FORWARDED.test(String(input.key || '').toLowerCase());
}

/**
 * 把上面这条规则挂到网页进程上：命中就拦下并转发给渲染进程。
 * 抽出来是为了能脱离 Electron 直接单测（假的 guest 发事件即可）。
 * @param {{webContents: {send: Function}}} win
 * @param {import('node:events').EventEmitter} guest
 * @param {{isMac?: boolean}} [options]
 */
function bindGuestShortcuts(win, guest, options = {}) {
  const isMac = options.isMac ?? process.platform === 'darwin';
  guest.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    if (!shouldForwardFromGuest(input, isMac)) return;
    event.preventDefault();
    win.webContents.send('shortcut', { key: String(input.key).toLowerCase() });
  });
}

/**
 * 应用界面（非网页）里要拦截的组合键。
 * f 在文档库界面仍然要拦截——那里没有网页，Cmd/Ctrl+F 就是搜文档库。
 */
const HOST_INTERCEPTED = /^([1-9]|w|n|f|r)$/;

module.exports = { shouldForwardFromGuest, bindGuestShortcuts, GUEST_FORWARDED, HOST_INTERCEPTED };
