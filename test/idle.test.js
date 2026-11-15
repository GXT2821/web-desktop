/**
 * 空闲判定：系统级空闲时间（秒）→ 是否该锁定。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isIdleLock } = require('../src/idle');

test('空闲判定：达到阈值才锁', () => {
  assert.equal(isIdleLock(0, 10), false);
  assert.equal(isIdleLock(9 * 60, 10), false);
  assert.equal(isIdleLock(10 * 60, 10), true);
  assert.equal(isIdleLock(11 * 60, 10), true);
});

test('空闲判定：阈值非法时按最少 1 分钟处理', () => {
  assert.equal(isIdleLock(30, 0), false);
  assert.equal(isIdleLock(60, 0), true);
  assert.equal(isIdleLock(60, 'abc'), true);
});