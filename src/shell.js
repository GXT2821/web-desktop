// 渲染进程脚本：顶部导航 + 多标签页
// 每个打开的页面对应一个 webview，点击导航打开/聚焦标签，可切换、可关闭。
const nav = document.getElementById('nav');
const tabbar = document.getElementById('tabbar');
const content = document.getElementById('content');
const placeholder = document.getElementById('placeholder');

const tabs = []; // { name, url, navBtn, tab, view }

// 高亮顶部导航中的当前项
function highlightNav(activeBtn) {
  document
    .querySelectorAll('.nav-item')
    .forEach((b) => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
}

// 激活指定标签（切换 webview + 标签高亮 + 导航高亮）
function activateTab(item) {
  tabs.forEach((t) => {
    const on = t === item;
    t.tab.classList.toggle('active', on);
    t.view.classList.toggle('active', on);
  });
  highlightNav(item.navBtn);
}

// 刷新空状态：无标签时显示占位、隐藏标签栏
function updateEmptyState() {
  const isEmpty = tabs.length === 0;
  placeholder.classList.toggle('hidden', !isEmpty);
  tabbar.classList.toggle('hidden', isEmpty);
}

// 打开（或聚焦）一个页面
function openTab(name, url, navBtn) {
  // 同一网址已打开时直接聚焦，不重复开
  const existing = tabs.find((t) => t.url === url);
  if (existing) {
    activateTab(existing);
    return;
  }

  // 每个标签一个 webview
  const view = document.createElement('webview');
  view.setAttribute('src', url);

  // 标签：标题 + 关闭按钮
  const tab = document.createElement('div');
  tab.className = 'tab';
  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = name;
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = '关闭';
  tab.append(label, close);

  const item = { name, url, navBtn, tab, view };
  tabs.push(item);

  tab.addEventListener('click', () => activateTab(item));
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(item);
  });

  // 页面加载出真实标题后，更新标签文字
  view.addEventListener('page-title-updated', (e) => {
    if (e.title && e.title.trim()) label.textContent = e.title.trim();
  });

  tabbar.appendChild(tab);
  content.appendChild(view);
  activateTab(item);
  updateEmptyState();
}

// 关闭标签
function closeTab(item) {
  const idx = tabs.indexOf(item);
  const wasActive = item.tab.classList.contains('active');

  tabs.splice(idx, 1);
  item.tab.remove();
  item.view.remove();

  updateEmptyState();

  if (tabs.length === 0) {
    highlightNav(null);
    return;
  }
  // 若关掉的是当前激活标签，则切换到相邻标签
  if (wasActive) {
    activateTab(tabs[Math.min(idx, tabs.length - 1)]);
  }
}

window.api.getPages().then((pages) => {
  pages.forEach((page) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.textContent = page.name;
    btn.addEventListener('click', () => openTab(page.name, page.url, btn));
    nav.appendChild(btn);
  });

  // 默认打开第一页
  if (pages.length) {
    const firstBtn = nav.querySelector('.nav-item');
    openTab(pages[0].name, pages[0].url, firstBtn);
  }
});