/**
 * 加密导出 / 导入：加解密、文件格式、合并规则。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const transfer = require('../src/transfer');

const LIB = {
  version: 1,
  folders: [
    { id: 'f1', name: '工作', parentId: null },
    { id: 'f2', name: '子文件夹', parentId: 'f1' },
  ],
  docs: [
    { id: 'd1', title: '文档一', url: 'https://example.com/a', folderId: 'f1', tags: ['x'] },
    { id: 'd2', title: '文档二', url: 'https://example.com/b', folderId: 'f2', tags: [] },
  ],
};

test('加密导出：口令正确才解得开，文件里没有明文', () => {
  const blob = transfer.encryptLibrary(LIB, 'passphrase-123');
  assert.equal(blob.subarray(0, 4).toString('ascii'), 'DVE1');
  assert.equal(blob.includes(Buffer.from('example.com/a')), false);

  const payload = transfer.decryptExport(blob, 'passphrase-123');
  assert.equal(payload.v, 1);
  assert.deepEqual(payload.library, LIB);

  assert.throws(() => transfer.decryptExport(blob, 'wrong-passphrase'), /口令不正确/);
});

test('加密导出：不是本应用的文件会被明确拒绝', () => {
  assert.throws(() => transfer.decryptExport(Buffer.from('hello world'), 'passphrase-123'), /文件头不正确/);
});

test('合并：同 URL（归一化后）不重复，新文档/文件夹会补进来', () => {
  const current = {
    version: 1,
    folders: [{ id: 'f1', name: '工作', parentId: null }],
    docs: [{ id: 'd1', title: '已有', url: 'https://example.com/a/', folderId: 'f1', tags: [] }],
  };
  const incoming = {
    version: 1,
    folders: [
      { id: 'f1', name: '工作（重名）', parentId: null },
      { id: 'f3', name: '学习', parentId: null },
      { id: 'f4', name: '孤儿', parentId: 'missing' },
    ],
    docs: [
      { id: 'x1', title: '重复链接', url: 'https://example.com/a', folderId: 'f1', tags: [] },
      { id: 'x2', title: '新文档', url: 'https://example.com/new', tags: [] },
    ],
  };

  const { library, stats } = transfer.mergeLibraries(current, incoming);
  assert.equal(library.docs.length, 2, '重复链接不新增');
  assert.equal(stats.docsAdded, 1);
  assert.equal(stats.docsSkipped, 1);
  assert.ok(library.docs.some((d) => d.url === 'https://example.com/new'));
  assert.equal(library.folders.find((f) => f.id === 'f1').name, '工作', '同 id 保留现有');
  assert.ok(library.folders.some((f) => f.id === 'f3'));
  assert.equal(library.folders.find((f) => f.id === 'f4').parentId, null, '父级不存在时挂根');
});

test('合并：导入内容会经过字段清洗（非法链接丢弃）', () => {
  const { library, stats } = transfer.mergeLibraries(
    { version: 1, folders: [], docs: [] },
    { version: 1, folders: [], docs: [{ id: 'bad', title: 'x', url: 'javascript:alert(1)', tags: [] }] }
  );
  assert.equal(library.docs.length, 0);
  assert.equal(stats.docsAdded, 0);
});

test('合并：同 URL 不同文件夹视为两条；id 冲突会重新分配', () => {
  const base = {
    version: 1,
    folders: [
      { id: 'f1', name: 'A', parentId: null },
      { id: 'f2', name: 'B', parentId: null },
    ],
    docs: [{ id: 'd1', title: '旧', url: 'https://example.com/x', folderId: 'f1', tags: [] }],
  };
  const incoming = {
    version: 1,
    folders: [],
    docs: [
      { id: 'd1', title: '同 id 不同内容', url: 'https://example.com/y', folderId: 'f2', tags: [] },
      { id: 'd2', title: '同 URL 在另一个文件夹', url: 'https://example.com/x', folderId: 'f2', tags: [] },
    ],
  };
  const { library, stats } = transfer.mergeLibraries(base, incoming);
  assert.equal(library.docs.length, 3);
  assert.equal(stats.docsAdded, 2);
  assert.equal(new Set(library.docs.map((d) => d.id)).size, 3, 'id 必须唯一');
  assert.notEqual(library.docs.find((d) => d.title === '同 id 不同内容').id, 'd1');
  assert.equal(library.docs.find((d) => d.title === '同 URL 在另一个文件夹').folderId, 'f2');
});

test('导出文件名带日期', () => {
  const name = transfer.exportFilename(new Date(2026, 10, 15, 9, 5));
  assert.equal(name, 'DocVault-20261115-0905.dve');
});