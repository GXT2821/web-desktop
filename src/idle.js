// 空闲判定的纯函数：便于单测，也避免把策略散在定时器里。
//
// 为什么不在主窗口上自己记 lastActivity：
//   - webview 是独立的 webContents，键盘/鼠标事件不会冒泡到外壳窗口；
//   - 用鼠标滚轮读文档也属于活跃，但窗口收不到事件。
// 所以交给系统：powerMonitor.getSystemIdleTime() 是"整个系统最后一次键鼠输入
// 距今多少秒"，网页里打字、滚轮都会续期。

function isIdleLock(idleSeconds, limitMinutes) {
  const limit = Math.max(1, Number(limitMinutes) || 0) * 60;
  return Number(idleSeconds) >= limit;
}

module.exports = { isIdleLock };