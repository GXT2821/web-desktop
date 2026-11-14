/**
 * 下载管理测试（不依赖 Electron：require('electron') 在纯 Node 下取不到 app，
 * downloadDir 会自动退回数据目录下的 downloads/）。
 *
 * 覆盖：url 字段记录（getURL 是方法）、notified 集合随历史清理、基本状态流转。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Downloads, safeFilename } = require('../src/downloads');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-dl-test-'));
}

// 假的 DownloadItem：只实现 register 用到的接口
function fakeItem(filename, url) {
  const item = new EventEmitter();
  item.getFilename = () => filename;
  item.getURL = () => url;
  item.getTotalBytes = () => 100;
  item.getReceivedBytes = () => 50;
  item.setSavePath = (p) => { item.savePath = p; };
  item.cancel = () => {};
  return item;
}

function withDownloads(fn) {
  const dir = tmpDir();
  const pushes = [];
  const downloads = new Downloads({ dataDir: dir, broadcast: (channel, payload) => pushes.push({ channel, payload }) });
  try {
    return fn({ dir, downloads, pushes });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('safeFilename：清洗路径分隔符与控制字符，空名兜底', () => {
  assert.equal(safeFilename('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeFilename(''), 'download');
  assert.equal(safeFilename('..'), 'download');
  assert.equal(safeFilename('a'.repeat(300) + '.pdf').length <= 160, true);
});

test('register：url 字段来自 item.getURL()（方法而非字符串）', () =>
  withDownloads(({ downloads }) => {
    const item = fakeItem('doc.pdf', 'https://example.com/doc.pdf');
    downloads.register(item, null);
    const entry = downloads.snapshot()[0];
    assert.equal(entry.url, 'https://example.com/doc.pdf', 'url 不能恒为空串');
    assert.equal(entry.state, 'progressing');
    item.emit('done', {}, 'completed');
    assert.equal(downloads.snapshot()[0].state, 'completed');
  }));

test('notified：失败提示只记一次，且随 clearFinished / 历史裁剪清理', () =>
  withDownloads(({ downloads }) => {
    const item = fakeItem('bad.bin', 'https://example.com/bad.bin');
    downloads.register(item, null);
    const id = downloads.snapshot()[0].id;

    item.emit('updated', {}, 'interrupted');
    item.emit('done', {}, 'interrupted');
    assert.equal(downloads.notified.has(id), true);
    assert.equal(downloads.notified.size, 1);

    // 清除已结束的记录后，notified 不应再留着这条 id（否则只增不减）
    downloads.clearFinished();
    assert.equal(downloads.notified.size, 0, 'clearFinished 应清理 notified');

    // 历史超过 50 条时，被裁掉的条目也要从 notified 里清掉。
    // 每次注册前清空频率窗口：40 次/分钟的限制是给真实页面防刷屏的，不是本用例的对象
    for (let i = 0; i < 55; i += 1) {
      downloads.recent = [];
      const it = fakeItem(`f${i}.bin`, `https://example.com/f${i}.bin`);
      downloads.register(it, null);
      it.emit('done', {}, 'interrupted');
    }
    assert.equal(downloads.items.length, 50);
    assert.ok(downloads.notified.size <= 50, `notified 应随历史裁剪，实际 ${downloads.notified.size}`);
    for (const notifiedId of downloads.notified) {
      assert.ok(downloads.items.some((entry) => entry.id === notifiedId));
    }
  }));

test('register：并发的同名下载拿到不同保存路径，不会互相覆盖', () =>
  withDownloads(({ downloads }) => {
    const a = fakeItem('same.pdf', 'https://example.com/a');
    const b = fakeItem('same.pdf', 'https://example.com/b');
    downloads.register(a, null);
    downloads.register(b, null);
    assert.notEqual(a.savePath, b.savePath, '同名并发下载不能写同一个文件');
    assert.match(path.basename(b.savePath), /^same \(1\)\.pdf$/);
    assert.equal(downloads.snapshot().length, 2);
  }));

test('持久化：记录跨实例保留，坏文件不影响启动', () =>
  withDownloads(({ dir, downloads }) => {
    const item = fakeItem('keep.pdf', 'https://example.com/keep.pdf');
    downloads.register(item, null);
    item.emit('done', {}, 'completed');

    const again = new Downloads({ dataDir: dir });
    assert.equal(again.snapshot().length, 1);
    assert.equal(again.snapshot()[0].state, 'completed');

    fs.writeFileSync(path.join(dir, 'downloads.json'), '{ bad json');
    const third = new Downloads({ dataDir: dir });
    assert.deepEqual(third.snapshot(), []);
  }));
