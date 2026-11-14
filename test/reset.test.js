/**
 * 重置逻辑测试：删除清单、令牌可选删除、失败收集。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resetDataDir, listTargets } = require('../src/reset');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docvault-reset-test-'));
}

test('重置：删除库/保险库/下载记录/留档，保留其他文件', () => {
  const dir = tmpDir();
  const files = [
    'library.json',
    'library.json.bak',
    'library.enc',
    'library.enc.bak',
    'vault.json',
    'downloads.json',
    'downloads.json.tmp', // 原子写残留也要清掉
    'library.json.corrupt-2026-01-01',
    'library.enc.corrupt-2026-01-02',
    'window-state.json', // 不属于数据，保留
    'Preferences',
  ];
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');

  const listed = listTargets(dir).sort();
  assert.ok(listed.includes('library.enc'));
  assert.ok(listed.includes('library.json.corrupt-2026-01-01'));
  assert.ok(!listed.includes('window-state.json'));

  const result = resetDataDir(dir);
  assert.equal(result.failed.length, 0);
  for (const name of ['library.json', 'library.enc', 'vault.json', 'downloads.json', 'downloads.json.tmp']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 应被删除`);
  }
  // 删除前必须留一份备份
  assert.ok(result.backupDir && fs.existsSync(result.backupDir), '应生成 reset-backup-* 目录');
  assert.ok(fs.existsSync(path.join(result.backupDir, 'library.json')), '备份里应有原数据文件');
  assert.ok(fs.existsSync(path.join(dir, 'window-state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'Preferences')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重置：默认不动令牌，显式勾选才删', () => {
  const dir = tmpDir();
  const tokenDir = tmpDir();
  const tokenFile = path.join(tokenDir, 'DocVault.key');
  fs.writeFileSync(path.join(dir, 'library.enc'), 'x');
  fs.writeFileSync(tokenFile, '{"type":"docvault-soft-token"}');

  resetDataDir(dir, { deleteToken: false, tokenPath: tokenFile });
  assert.ok(fs.existsSync(tokenFile), '未勾选时令牌必须保留');

  fs.writeFileSync(path.join(dir, 'library.enc'), 'x');
  const second = resetDataDir(dir, { deleteToken: true, tokenPath: tokenFile });
  assert.equal(fs.existsSync(tokenFile), false);
  assert.ok(second.removed.includes('DocVault.key'));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tokenDir, { recursive: true, force: true });
});

test('重置：空目录也能安全执行（不产生空备份目录）', () => {
  const dir = tmpDir();
  const result = resetDataDir(dir);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.backupDir, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重置：keepBackup=false 时不留备份（供测试/特殊场景）', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'library.json'), '{"version":1,"folders":[],"docs":[]}');
  const result = resetDataDir(dir, { keepBackup: false });
  assert.equal(result.backupDir, null);
  assert.equal(fs.existsSync(path.join(dir, 'library.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重置：目录不存在不抛错', () => {
  const dir = path.join(tmpDir(), 'missing');
  const result = resetDataDir(dir);
  assert.deepEqual(result.removed, []);
});