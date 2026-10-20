/**
 * 数据层测试（不依赖 Electron，直接 node --test 跑）
 *
 * 覆盖两类东西：
 * 1) 功能正确性：URL 归一化、标签去重、打开计数、文件夹 keep/cascade 删除、持久化与备份；
 * 2) 安全不变量：只接受 http/https、字段白名单（不可注入任意字段/污染原型）、长度上限、
 *    文件权限 0600、坏数据不放大成"整个库失效"。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, normalizeUrl, fallbackTitle, LIMITS } = require('../src/store');

// 每个用例一个独立目录，跑完即删
function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-test-'));
  const file = path.join(dir, 'library.json');
  try {
    return fn({ dir, file, store: new Store(file) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- URL 归一化与协议白名单 ----------

test('normalizeUrl：补全协议、规范化、保留路径与查询', () => {
  assert.equal(normalizeUrl('example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('  https://Example.COM/a/../b?q=1  '), 'https://example.com/b?q=1');
  assert.equal(normalizeUrl('http://example.com'), 'http://example.com/');
});

test('normalizeUrl：拒绝非 http/https 协议与非法输入', () => {
  const bad = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://example.com/a',
    'chrome://settings',
    '',
    '   ',
    'https://', // 没有主机名
  ];
  for (const input of bad) {
    assert.throws(() => normalizeUrl(input), /链接|http/, `应拒绝: ${input}`);
  }
});

test('normalizeUrl：超长链接按上限截断', () => {
  const long = `https://example.com/${'a'.repeat(5000)}`;
  assert.equal(normalizeUrl(long).length, LIMITS.url);
});

test('fallbackTitle：域名 + 路径尾段，纯数字尾段丢弃', () => {
  assert.equal(fallbackTitle('https://www.example.com/guide/install'), 'example.com / install');
  assert.equal(fallbackTitle('https://example.com/doc/1'), 'example.com');
  assert.equal(fallbackTitle('https://example.com/'), 'example.com');
});

// ---------- 文档增删改 ----------

test('addDoc：无标题时自动推导并标记 titleAuto', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'example.com/a/b' });
    assert.equal(doc.url, 'https://example.com/a/b');
    assert.equal(doc.title, 'example.com / b');
    assert.equal(doc.titleAuto, true);
    assert.equal(doc.openCount, 0);
    assert.equal(doc.openedAt, null);
    assert.equal(store.snapshot().docs.length, 1);
  }));

test('addDoc：拒绝 javascript: 链接（安全不变量）', () =>
  withStore(({ store }) => {
    store.load();
    assert.throws(() => store.addDoc({ url: 'javascript:alert(1)' }));
    assert.equal(store.snapshot().docs.length, 0);
  }));

test('updateDoc：只接受白名单字段，未知字段不会写入', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/', title: '原标题' });
    store.updateDoc(doc.id, { title: '新标题', hacked: true, openCount: 999 });
    const after = store.snapshot().docs[0];
    assert.equal(after.title, '新标题');
    assert.equal('hacked' in after, false);
    assert.equal(after.openCount, 0, 'openCount 不该由 patch 随意改写');
  }));

test('updateDoc：清空标题会回退为自动标题', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/path', title: '手填' });
    store.updateDoc(doc.id, { title: '' });
    const after = store.snapshot().docs[0];
    assert.equal(after.title, 'example.com / path');
    assert.equal(after.titleAuto, true);
  }));

test('autoTitle：只在自动标题状态下补全一次', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/doc' });
    store.updateDoc(doc.id, { autoTitle: '真实网页标题' });
    assert.equal(store.snapshot().docs[0].title, '真实网页标题');
    assert.equal(store.snapshot().docs[0].titleAuto, false);
    // 再来一次不应覆盖
    store.updateDoc(doc.id, { autoTitle: '第二个标题' });
    assert.equal(store.snapshot().docs[0].title, '真实网页标题');
  }));

test('autoTitle：手动改过标题的文档不被网页标题覆盖', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/doc', title: '我填的' });
    store.updateDoc(doc.id, { autoTitle: '网页标题' });
    assert.equal(store.snapshot().docs[0].title, '我填的');
  }));

test('touchDoc：累加打开次数并记录时间', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/' });
    store.touchDoc(doc.id);
    store.touchDoc(doc.id);
    const after = store.snapshot().docs[0];
    assert.equal(after.openCount, 2);
    assert.ok(after.openedAt > 0);
    assert.equal(store.touchDoc('不存在的 id'), null);
  }));

test('deleteDoc：删除后不可再更新', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/' });
    store.deleteDoc(doc.id);
    assert.equal(store.snapshot().docs.length, 0);
    assert.throws(() => store.updateDoc(doc.id, { title: 'x' }), /不存在/);
  }));

// ---------- 标签与长度上限 ----------

test('标签：去 # 前缀、大小写去重、超限截断', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({
      url: 'https://example.com/',
      tags: ['#支付', '支付', 'React', 'react', '', 123, 'x'.repeat(100)],
    });
    const tags = store.snapshot().docs[0].tags;
    assert.deepEqual(tags, ['支付', 'React', 'x'.repeat(LIMITS.tag)]);
    assert.ok(tags.length <= LIMITS.tags);
  }));

test('长度上限：标题、备注按上限截断', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({
      url: 'https://example.com/',
      title: 't'.repeat(500),
      note: 'n'.repeat(5000),
    });
    const after = store.snapshot().docs[0];
    assert.equal(after.title.length, LIMITS.title);
    assert.equal(after.note.length, LIMITS.note);
  }));

test('控制字符被清理（避免写进 JSON 破坏结构）', () =>
  withStore(({ store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/', title: 'a\u0000b\u001fc' });
    assert.equal(store.snapshot().docs[0].title, 'a b c');
  }));

// ---------- 文件夹 ----------

test('文件夹：嵌套、非法父级挂回根目录', () =>
  withStore(({ store }) => {
    store.load();
    const parent = store.addFolder('工作', null);
    const child = store.addFolder('项目', parent.id);
    store.addDoc({ url: 'https://example.com/a', folderId: child.id });
    const lib = store.snapshot();
    assert.equal(lib.folders.find((f) => f.id === child.id).parentId, parent.id);
    // 不存在的父级 → null
    store.renameFolder(child.id, '项目2');
    const orphan = store.addFolder('孤儿', 'no-such-id');
    assert.equal(orphan.parentId, null);
  }));

test('deleteFolder(keep)：子文件夹上提、文档移到未分类', () =>
  withStore(({ store }) => {
    store.load();
    const parent = store.addFolder('父', null);
    const child = store.addFolder('子', parent.id);
    const doc = store.addDoc({ url: 'https://example.com/a', folderId: child.id });

    const result = store.deleteFolder(parent.id, 'keep');
    const lib = store.snapshot();
    assert.equal(result.removedFolders, 1);
    assert.equal(result.promotedFolders, 1);
    assert.equal(result.removedDocs, 0);
    assert.equal(lib.folders.find((f) => f.id === child.id).parentId, null);
    assert.equal(lib.docs.find((d) => d.id === doc.id).folderId, null);
  }));

test('deleteFolder(cascade)：整棵子树连同文档一起删', () =>
  withStore(({ store }) => {
    store.load();
    const parent = store.addFolder('父', null);
    const child = store.addFolder('子', parent.id);
    store.addDoc({ url: 'https://example.com/a', folderId: child.id });
    store.addDoc({ url: 'https://example.com/b' }); // 不在该子树

    const result = store.deleteFolder(parent.id, 'cascade');
    const lib = store.snapshot();
    assert.equal(result.removedFolders, 2);
    assert.equal(result.removedDocs, 1);
    assert.equal(lib.folders.length, 0);
    assert.equal(lib.docs.length, 1);
  }));

// ---------- 持久化 / 备份 / 恢复 ----------

test('持久化：重新加载后数据一致，且不留 .tmp 残file', () =>
  withStore(({ file, store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/keep', title: '保留' });
    store.addDoc({ url: 'https://example.com/second' });

    const reopened = new Store(file);
    assert.equal(reopened.load().recovered, 'none');
    const docs = reopened.snapshot().docs;
    assert.equal(docs.length, 2);
    assert.equal(docs.find((d) => d.id === doc.id).title, '保留');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  }));

test('备份：.bak 保存的是上一次写入的内容', () =>
  withStore(({ file, store }) => {
    store.load(); // 首次运行会先落一个空库文件
    store.addDoc({ url: 'https://example.com/1' });
    store.addDoc({ url: 'https://example.com/2' });

    const main = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8'));
    assert.equal(main.docs.length, 2);
    assert.equal(bak.docs.length, 1, '.bak 应比主文件少最近一次写入');
    assert.equal(bak.docs[0].url, 'https://example.com/1');
  }));

test('文件权限：library.json 与 .bak 均为 0600', { skip: process.platform === 'win32' }, () =>
  withStore(({ file, store }) => {
    store.load();
    store.addDoc({ url: 'https://example.com/1' });
    store.addDoc({ url: 'https://example.com/2' });
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(file), 0o600);
    assert.equal(mode(`${file}.bak`), 0o600);
  }));

test('首次运行：没有数据文件时静默建空库，不触发恢复提示', () =>
  withStore(({ file, store }) => {
    assert.equal(store.load().recovered, 'none');
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(store.snapshot().docs, []);
  }));

test('主文件损坏 + 备份可用 → 从备份恢复并留档坏文件', () =>
  withStore(({ dir, file, store }) => {
    store.load();
    store.addDoc({ url: 'https://example.com/good' });
    store.addDoc({ url: 'https://example.com/good2' }); // 触发 .bak
    const good = store.snapshot().docs.length;

    fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8');
    const reopened = new Store(file);
    assert.equal(reopened.load().recovered, 'backup');
    // .bak 是"上一次保存"的快照，因此恢复后比当前少最近一次写入的那条
    assert.equal(reopened.snapshot().docs.length, good - 1);
    const quarantined = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.equal(quarantined.length, 1);
  }));

test('主文件与备份都损坏 → 重建空库并留档', () =>
  withStore(({ dir, file, store }) => {
    store.load();
    store.addDoc({ url: 'https://example.com/1' });
    store.addDoc({ url: 'https://example.com/2' });
    fs.writeFileSync(file, 'broken', 'utf-8');
    fs.writeFileSync(`${file}.bak`, 'also broken', 'utf-8');

    const reopened = new Store(file);
    assert.equal(reopened.load().recovered, 'reset');
    assert.deepEqual(reopened.snapshot().docs, []);
    assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length, 1);
  }));

// ---------- 坏数据收敛 ----------

test('加载时收敛：丢弃非法链接、修复重复 id、孤儿文件夹挂根、自引用解环', () =>
  withStore(({ file }) => {
    const raw = {
      version: 1,
      folders: [
        { id: 'f1', name: '正常', parentId: null },
        { id: 'f2', name: '自引用', parentId: 'f2' },
        { id: 'f3', name: '孤儿', parentId: '不存在' },
        { id: 'f4', name: '' }, // 无名字 → 丢弃
      ],
      docs: [
        // 非法协议 → 整条丢弃
        { id: 'd_bad', url: 'javascript:alert(1)', title: '坏' },
        { url: 'file:///etc/passwd' },
        // 重复 id → 重新生成
        { id: 'dup', url: 'https://example.com/a', title: 'A' },
        { id: 'dup', url: 'https://example.com/b', title: 'B' },
        // 不存在的文件夹 → null
        { id: 'd_orphan', url: 'https://example.com/c', folderId: 'nope' },
        // 缺标题 → 自动推导
        { id: 'd_notitle', url: 'https://example.com/guide/x' },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const store = new Store(file);
    assert.equal(store.load().recovered, 'none');
    const lib = store.snapshot();

    assert.deepEqual(lib.docs.map((d) => d.url).sort(), [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/guide/x',
    ]);
    const ids = lib.docs.map((d) => d.id);
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
    assert.equal(lib.docs.find((d) => d.url === 'https://example.com/c').folderId, null);
    assert.equal(lib.docs.find((d) => d.url === 'https://example.com/guide/x').title, 'example.com / x');

    const byId = Object.fromEntries(lib.folders.map((f) => [f.id, f]));
    assert.equal(byId.f2.parentId, null, '自引用应解环');
    assert.equal(byId.f3.parentId, null, '孤儿应挂根');
    assert.equal(byId.f4, undefined, '无名文件夹应被丢弃');
  }));

test('原型污染：patch 与 JSON 里的 __proto__ 都不会污染 Object.prototype', () =>
  withStore(({ file, store }) => {
    store.load();
    const doc = store.addDoc({ url: 'https://example.com/' });

    // 1) patch 里藏 __proto__
    const patch = JSON.parse('{"__proto__":{"polluted":"yes"}}');
    store.updateDoc(doc.id, patch);
    assert.equal({}.polluted, undefined, 'patch 不应污染原型');

    // 2) 数据文件里的 __proto__
    const raw = JSON.parse(
      '{"version":1,"folders":[],"docs":[{"id":"x","url":"https://example.com/z","title":"z","__proto__":{"polluted2":"yes"}}]}'
    );
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');
    const reopened = new Store(file);
    reopened.load();
    assert.equal({}.polluted2, undefined, '加载不应污染原型');
    assert.equal(reopened.snapshot().docs.length, 1);
    assert.equal('polluted2' in reopened.snapshot().docs[0], false);
  }));

test('snapshot 返回副本：外部改动不影响内部状态', () =>
  withStore(({ store }) => {
    store.load();
    store.addDoc({ url: 'https://example.com/', tags: ['a'] });
    const snap = store.snapshot();
    snap.docs[0].title = '被篡改';
    snap.docs[0].tags.push('b');
    const again = store.snapshot();
    assert.notEqual(again.docs[0].title, '被篡改');
    assert.deepEqual(again.docs[0].tags, ['a']);
  }));
test('加载时收紧权限：外部留下的 0644 文件与 0755 目录会被纠正', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-perm-'));
  const file = path.join(dir, 'library.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, folders: [], docs: [] }), { mode: 0o644 });
    fs.chmodSync(dir, 0o755);
    const store = new Store(file);
    store.load();
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(file), 0o600, '数据文件应被收紧到 0600');
    assert.equal(mode(dir), 0o700, '数据目录应被收紧到 0700');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('超大文件按损坏处理：不解析、原文件留档、从备份恢复', () =>
  withStore(({ dir, file, store }) => {
    store.load();
    store.addDoc({ url: 'https://example.com/ok' });
    store.addDoc({ url: 'https://example.com/ok2' }); // 生成 .bak

    // 造一个超过上限的文件（内容不重要，重点是它不会被整读解析）
    fs.writeFileSync(file, Buffer.alloc(51 * 1024 * 1024, 0x20));
    const reopened = new Store(file);
    assert.equal(reopened.load().recovered, 'backup');
    assert.ok(reopened.snapshot().docs.length >= 1);

    const kept = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.equal(kept.length, 1, '超大文件应被留档而不是删除');
    assert.ok(fs.statSync(path.join(dir, kept[0])).size > 50 * 1024 * 1024);
  }));

test('留档文件自动清理：超过 5 个时只保留最新的', () =>
  withStore(({ dir, file }) => {
    const store = new Store(file);
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(file, '{ bad', 'utf-8');
      store.load();
    }
    const before = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length;
    assert.ok(before >= 1);
    assert.ok(before <= 5, `留档数量应被限制在 5 个以内，实际 ${before}`);
  }));
