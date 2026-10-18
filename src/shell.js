// 渲染进程脚本：生成左侧导航，点击时切换右侧 webview
const nav = document.getElementById('nav');
const view = document.getElementById('view');

window.api.getPages().then((pages) => {
  pages.forEach((page, i) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.textContent = page.name;

    btn.addEventListener('click', () => {
      // 高亮当前项
      document
        .querySelectorAll('.nav-item')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      // 切换 webview 加载的地址
      view.setAttribute('src', page.url);
    });

    nav.appendChild(btn);
    // 默认打开第一页
    if (i === 0) btn.click();
  });
});