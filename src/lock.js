// 锁定页逻辑：检测令牌 → PIN 解锁；或 恢复码 → 绑定新令牌 → 进入文档库。
// 所有数据操作都在主进程完成，这里只负责展示与收集输入。

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const dom = {
    unlockView: $('unlockView'),
    unlockTitle: $('unlockTitle'),
    unlockSub: $('unlockSub'),
    autoFlow: $('autoFlow'),
    pinFlow: $('pinFlow'),
    usbScene: $('usbScene'),
    readSteps: $('readSteps'),
    readProgress: $('readProgress'),
    enterBtn: $('enterBtn'),
    autoHint: $('autoHint'),
    recoverView: $('recoverView'),
    tokenState: $('tokenState'),
    pinForm: $('pinForm'),
    pinInput: $('pinInput'),
    unlockBtn: $('unlockBtn'),
    unlockError: $('unlockError'),
    toRecover: $('toRecover'),
    recoverForm: $('recoverForm'),
    codeInput: $('codeInput'),
    recoverError: $('recoverError'),
    bindStep: $('bindStep'),
    bindTokenList: $('bindTokenList'),
    bindCreateBtn: $('bindCreateBtn'),
    bindForm: $('bindForm'),
    bindPin: $('bindPin'),
    bindPin2: $('bindPin2'),
    bindFree: $('bindFree'),
    bindError: $('bindError'),
    newCodeStep: $('newCodeStep'),
    newCodeText: $('newCodeText'),
    newCodeSaved: $('newCodeSaved'),
    finishBtn: $('finishBtn'),
    backToUnlock: $('backToUnlock'),
    lockFoot: $('lockFoot'),
  };

  let mode = 'unlock'; // unlock | recover（恢复流程中停止轮询，避免界面被刷掉）
  let boundSerial = null;
  let boundPresent = false;
  let busy = false;
  let bindTarget = null; // { path } 或 { createDir }

  function showError(node, message) {
    node.textContent = message;
    node.hidden = !message;
  }

  function setTokenState(kind, text) {
    dom.tokenState.className = `token-state${kind ? ` ${kind}` : ''}`;
    dom.tokenState.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dom.tokenState.append(dot, document.createTextNode(text));
  }

  // ---- 免 PIN：读取密钥动画状态机 ----
  // 阶段：idle → detect(320ms) → read(900ms，带进度条) → verify(等密钥就绪) → done
  // 每一步只允许"向前"，避免定时器把已完成的步骤改回进行中（之前就是这样一直转圈的）。
  const STEP_RANK = { '': 0, active: 1, done: 2 };
  let autoPhase = 'idle';
  let autoReady = false; // 主进程已把密钥解包好
  let verifyStartAt = 0;
  let verifySettled = false;
  let autoTimers = [];

  function clearAutoTimers() {
    for (const t of autoTimers) clearTimeout(t);
    autoTimers = [];
  }

  function later(fn, ms) {
    autoTimers.push(setTimeout(fn, ms));
  }

  function markStep(name, state) {
    const li = dom.readSteps.querySelector(`li[data-step="${name}"]`);
    if (!li) return;
    const current = STEP_RANK[li.dataset.state || ''] || 0;
    if (STEP_RANK[state] <= current) return; // 不回退
    li.dataset.state = state;
  }

  function resetAutoFlow() {
    clearAutoTimers();
    autoPhase = 'idle';
    autoReady = false;
    verifyStartAt = 0;
    verifySettled = false;
    dom.autoFlow.hidden = true;
    dom.pinFlow.hidden = false;
    dom.usbScene.classList.remove('inserted', 'scanning', 'verified');
    dom.enterBtn.hidden = true;
    dom.autoHint.textContent = '';
    dom.autoHint.className = 'auto-hint';
    dom.readProgress.classList.remove('run');
    dom.readProgress.querySelector('span').style.width = '';
    dom.readSteps.querySelectorAll('li').forEach((li) => {
      li.dataset.state = '';
    });
  }

  // 检测到免 PIN 令牌：开始整套流程
  function startAutoFlow() {
    if (autoPhase !== 'idle') return;
    autoPhase = 'detect';
    dom.pinFlow.hidden = true;
    dom.autoFlow.hidden = false;
    dom.unlockTitle.textContent = '正在读取密钥';
    dom.unlockSub.textContent = '已检测到令牌 U 盘，正在安全地读取加密密钥。';
    dom.usbScene.classList.add('inserted');
    dom.readSteps.querySelector('li[data-step="detect"]').dataset.state = 'active';
    dom.usbScene.classList.add('scanning');

    // 1) 检测到令牌（320ms）
    later(() => {
      markStep('detect', 'done');
      markStep('read', 'active');
      autoPhase = 'read';
      dom.readProgress.classList.add('run');
      // 2) 读取密钥：进度条 900ms 走满
      later(() => {
        autoPhase = 'verify';
        verifyStartAt = Date.now();
        markStep('read', 'done');
        markStep('verify', 'active');
        maybeFinishVerify();
      }, 900);
    }, 320);
  }

  // 主进程报"密钥已读"：若已进入校验阶段就收尾，否则等读取动画走完再收尾
  function onKeyReady() {
    autoReady = true;
    if (autoPhase === 'verify') maybeFinishVerify();
  }

  // 校验完成 → 出现「确定」；密钥没就绪就继续转，最多等 8 秒再提示失败
  function maybeFinishVerify() {
    if (autoPhase !== 'verify') return;
    if (!autoReady) {
      // 只挂一次超时，避免每 400ms 轮询都叠加一个定时器
      if (!autoTimers.some((t) => t.__waiting)) {
        const timer = setTimeout(() => {
          if (autoPhase === 'verify' && !autoReady) {
            autoFailed('密钥读取超时，请重新插入令牌或使用恢复码。');
          }
        }, 8000);
        timer.__waiting = true;
        autoTimers.push(timer);
      }
      return;
    }
    if (verifySettled) return;
    verifySettled = true;
    const wait = Math.max(0, 300 - (Date.now() - verifyStartAt)); // 让"校验"也看得见
    later(() => {
      autoPhase = 'done';
      markStep('verify', 'done');
      dom.usbScene.classList.remove('scanning');
      dom.usbScene.classList.add('verified');
      dom.unlockTitle.textContent = '密钥已读取';
      dom.unlockSub.textContent = '已验证通过。确认后进入文档库。';
      dom.enterBtn.hidden = false;
      dom.autoHint.textContent = '数据密钥已解包，本地校验通过。';
      dom.enterBtn.focus();
    }, wait);
  }

  function autoFailed(message) {
    clearAutoTimers();
    autoPhase = 'error';
    dom.enterBtn.hidden = true;
    dom.readProgress.classList.remove('run');
    dom.usbScene.classList.remove('scanning');
    dom.autoHint.className = 'auto-hint error';
    dom.autoHint.textContent = message || '读取失败，请重新插入令牌或使用恢复码。';
  }

  // ---------- 轮询：令牌在不在（500ms，只读元数据，不扫全盘） ----------
  async function poll() {
    if (mode !== 'unlock') return;
    try {
      const status = await window.lockApi.status();
      boundSerial = status.serial;
      if (status.error) {
        setTokenState('warn', status.error);
        dom.pinInput.disabled = true;
        dom.unlockBtn.disabled = true;
        return;
      }
      boundPresent = status.present === true;
      if (boundPresent && status.pinFree) {
        // 免 PIN：插上就开始读密钥动画，读完后由用户点「确定」
        if (autoPhase === 'idle') startAutoFlow();
        if (status.ready) onKeyReady();
      } else if (boundPresent && status.locked) {
        resetAutoFlow();
        dom.unlockTitle.textContent = '文档库已锁定';
        dom.unlockSub.textContent = '插入绑定的令牌 U 盘，输入 PIN 解锁。';
        dom.pinForm.hidden = false;
        setTokenState('warn', '令牌已锁定（PIN 错误次数过多），请用恢复码解锁');
        dom.pinInput.disabled = true;
        dom.unlockBtn.disabled = true;
      } else if (boundPresent) {
        // 带 PIN 的令牌：保持原来的 PIN 解锁流程
        resetAutoFlow();
        dom.unlockTitle.textContent = '文档库已锁定';
        dom.unlockSub.textContent = '插入绑定的令牌 U 盘，输入 PIN 解锁。';
        dom.pinForm.hidden = false;
        setTokenState('ok', `已检测到令牌 · ${String(boundSerial || '').slice(0, 8)}…`);
        dom.pinInput.disabled = false;
        dom.unlockBtn.disabled = false;
        if (document.activeElement !== dom.pinInput && !dom.pinInput.value) dom.pinInput.focus();
      } else {
        resetAutoFlow();
        dom.unlockTitle.textContent = '文档库已锁定';
        dom.unlockSub.textContent = '插入绑定的令牌 U 盘，输入 PIN 解锁。';
        dom.pinForm.hidden = false;
        setTokenState('', '未检测到绑定的令牌，请插入对应的 U 盘');
        dom.pinInput.disabled = true;
        dom.unlockBtn.disabled = true;
      }
    } catch (err) {
      setTokenState('warn', `检测失败：${err.message}`);
    }
  }

  // 主进程推送：密钥已读 / 令牌被拔 / 读取失败
  window.lockApi.onReady(() => {
    if (mode !== 'unlock') return;
    if (autoPhase === 'idle') startAutoFlow();
    onKeyReady();
  });
  window.lockApi.onReset(() => {
    resetAutoFlow();
    setTokenState('', '令牌已移除，文档库重新上锁');
  });
  window.lockApi.onError(({ message }) => autoFailed(message));

  // 用户确认进入：主进程加载数据并打开主窗口
  dom.enterBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    dom.enterBtn.disabled = true;
    dom.autoHint.className = 'auto-hint';
    dom.autoHint.textContent = '正在打开文档库…';
    try {
      await window.lockApi.finish();
    } catch (err) {
      dom.autoHint.className = 'auto-hint error';
      dom.autoHint.textContent = err.message;
      dom.enterBtn.disabled = false;
      busy = false;
    }
  });

  // ---------- PIN 解锁 ----------
  dom.pinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !boundPresent) return;
    const pin = dom.pinInput.value;
    if (!pin) return;
    busy = true;
    dom.unlockBtn.disabled = true;
    showError(dom.unlockError, '');
    try {
      await window.lockApi.unlock(pin);
      setTokenState('ok', '解锁成功，正在打开文档库…');
      // 主进程会销毁本窗口并打开主窗口
    } catch (err) {
      showError(dom.unlockError, err.message);
      dom.pinInput.select();
      busy = false;
      dom.unlockBtn.disabled = false;
      poll(); // PIN 错误可能扣减了次数，刷新状态
    }
  });

  // ---------- 恢复码流程 ----------
  dom.toRecover.addEventListener('click', () => {
    mode = 'recover';
    dom.unlockView.hidden = true;
    dom.recoverView.hidden = false;
    dom.codeInput.focus();
  });

  dom.backToUnlock.addEventListener('click', () => {
    mode = 'unlock';
    dom.recoverView.hidden = true;
    dom.unlockView.hidden = false;
    showError(dom.recoverError, '');
    poll();
  });

  dom.recoverForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    showError(dom.recoverError, '');
    try {
      await window.lockApi.recover(dom.codeInput.value.trim());
      dom.recoverForm.hidden = true;
      dom.codeInput.disabled = true;
      dom.bindStep.hidden = false;
      await renderBindTokens();
    } catch (err) {
      showError(dom.recoverError, err.message);
    } finally {
      busy = false;
    }
  });

  async function renderBindTokens() {
    const tokens = await window.lockApi.detect();
    dom.bindTokenList.textContent = '';
    if (!tokens.length) {
      const empty = document.createElement('p');
      empty.className = 'lock-sub';
      empty.textContent = '没有检测到令牌。插入一枚令牌 U 盘，或在下面新建一枚。';
      dom.bindTokenList.append(empty);
      return;
    }
    for (const token of tokens) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'token-item';
      const name = document.createElement('span');
      name.textContent = `令牌 · ${token.serial.slice(0, 8)}…`;
      const serial = document.createElement('span');
      serial.className = 'serial';
      serial.textContent = token.path;
      item.append(name, serial);
      if (token.locked) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '已锁定';
        item.append(badge);
        item.disabled = true;
      }
      item.addEventListener('click', () => {
        dom.bindTokenList.querySelectorAll('.token-item').forEach((n) => n.classList.remove('selected'));
        item.classList.add('selected');
        bindTarget = { path: token.path };
        // 已有的免 PIN 令牌无需再设 PIN
        dom.bindFree.checked = token.pinFree === true;
        dom.bindForm.hidden = false;
        if (!dom.bindFree.checked) dom.bindPin.focus();
      });
      dom.bindTokenList.append(item);
    }
  }

  dom.bindCreateBtn.addEventListener('click', async () => {
    showError(dom.bindError, '');
    try {
      const picked = await window.lockApi.pickDir();
      if (picked.canceled || !picked.dir) return;
      bindTarget = { createDir: picked.dir };
      dom.bindForm.hidden = false;
      dom.bindPin.focus();
    } catch (err) {
      showError(dom.bindError, err.message);
    }
  });

  dom.bindForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !bindTarget) return;
    const free = dom.bindFree.checked;
    const pin = dom.bindPin.value;
    if (!free) {
      if (pin.length < 4 || pin.length > 16) {
        showError(dom.bindError, 'PIN 需要 4–16 位');
        return;
      }
      if (pin !== dom.bindPin2.value) {
        showError(dom.bindError, '两次输入的 PIN 不一致');
        return;
      }
    }
    busy = true;
    showError(dom.bindError, '');
    const attempt = (force) => window.lockApi.rebind({
      tokenPath: bindTarget.path,
      createDir: bindTarget.createDir,
      pin,
      pinFree: free,
      force,
    });
    const showNewCode = (result) => {
      dom.bindStep.hidden = true;
      dom.newCodeStep.hidden = false;
      dom.newCodeText.textContent = result.recoveryCode;
      dom.backToUnlock.hidden = true;
    };
    try {
      showNewCode(await attempt(false));
    } catch (err) {
      if (bindTarget.createDir && /已经有一枚令牌/.test(err.message)) {
        // 目标目录已有令牌：确认后覆盖
        const ok = window.confirm('该目录里已经有一枚 DocVault.key。继续会覆盖它，旧令牌立即失效。确定覆盖？');
        if (ok) {
          try {
            showNewCode(await attempt(true));
          } catch (retryErr) {
            showError(dom.bindError, retryErr.message);
          }
        }
      } else {
        showError(dom.bindError, err.message);
      }
    } finally {
      busy = false;
    }
  });

  dom.newCodeSaved.addEventListener('change', () => {
    dom.finishBtn.disabled = !dom.newCodeSaved.checked;
  });

  dom.finishBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    dom.finishBtn.disabled = true;
    try {
      await window.lockApi.finish();
      // 主进程随后销毁本窗口
    } catch (err) {
      showError(dom.bindError, err.message);
      dom.finishBtn.disabled = false;
      busy = false;
    }
  });

  dom.lockFoot.textContent = '数据已加密存储在本机 · 没有令牌与 PIN 无法读取';
  poll();
  setInterval(poll, 400);

  // 就绪标记：自动化测试用它确认事件绑定已完成
  window.__lockReady = true;
})();
