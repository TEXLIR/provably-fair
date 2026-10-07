'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../src/store');

test('incr / incrBy start from zero and accumulate', async () => {
  const s = new MemoryStore();
  assert.equal(await s.incr('a'), 1);
  assert.equal(await s.incr('a'), 2);
  assert.equal(await s.incrBy('a', 10), 12);
  assert.equal(await s.incrBy('a', -2), 10);
});

test('setIfAbsent only writes the first time (this is how init() stays idempotent)', async () => {
  const s = new MemoryStore();
  assert.equal(await s.setIfAbsent('k', 'first'), true);
  assert.equal(await s.setIfAbsent('k', 'second'), false);
  assert.equal(await s.get('k'), 'first');
});

test('setIfAbsent with a ttl releases the key (the player lock)', async () => {
  const s = new MemoryStore();
  assert.equal(await s.setIfAbsent('lock', '1', 10), true);
  assert.equal(await s.setIfAbsent('lock', '1', 10), false); // held
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await s.setIfAbsent('lock', '1', 10), true); // expired -> reusable
});

test('getJSON / setJSON round-trip objects', async () => {
  const s = new MemoryStore();
  await s.setJSON('obj', { a: 1, b: [1, 2, 3] });
  assert.deepEqual(await s.getJSON('obj'), { a: 1, b: [1, 2, 3] });
  assert.equal(await s.getJSON('missing'), null);
});

test('pushCapped keeps the newest first and respects the cap', async () => {
  const s = new MemoryStore();
  for (let i = 1; i <= 5; i++) await s.pushCapped('feed', `v${i}`, 3);
  assert.deepEqual(await s.range('feed', 0, 2), ['v5', 'v4', 'v3']);
  assert.deepEqual(await s.range('feed', 0, -1), ['v5', 'v4', 'v3']);
});

test('del removes a key', async () => {
  const s = new MemoryStore();
  await s.set('x', '1');
  await s.del('x');
  assert.equal(await s.get('x'), null);
});
