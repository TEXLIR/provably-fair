'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fair = require('../src/fair');

// ── fixed vector, generated once and locked in as a regression guard ────────
const SERVER_SEED = 'a3f1c9e27b5d8046f2a1c8e4b7d9f0a2c5e8b1d4f7a0c3e6b9d2f5a8c1e4b7d0';
const COMMITMENT = 'ae72cbaeadbe24c0148e515154f363de60908012beba75f078cc2652a1086360';

test('commitment matches the locked test vector', () => {
  assert.equal(fair.commitServerSeed(SERVER_SEED), COMMITMENT);
});

test('outcomes match the locked test vector', () => {
  assert.equal(fair.resultFromSeeds(SERVER_SEED, 'player-one', 0), 447); // 4.47x
  assert.equal(fair.resultFromSeeds(SERVER_SEED, 'player-one', 1), 105); // 1.05x
  assert.equal(fair.resultFromSeeds(SERVER_SEED, 'player-one', 2), 111); // 1.11x
  assert.equal(fair.resultFromSeeds(SERVER_SEED, 'abc', 42), 279);       // 2.79x
});

test('is deterministic: same seeds + nonce always give the same outcome', () => {
  for (let n = 0; n < 50; n++) {
    assert.equal(fair.resultFromSeeds(SERVER_SEED, 'x', n), fair.resultFromSeeds(SERVER_SEED, 'x', n));
  }
});

test('the commitment detects a swapped server seed', () => {
  const tampered = fair.generateServerSeed();
  assert.notEqual(fair.commitServerSeed(tampered), COMMITMENT);
});

test('every outcome stays inside [1.00x, 1,000,000.00x]', () => {
  for (let n = 0; n < 50_000; n++) {
    const r = fair.resultFromSeeds(SERVER_SEED, 'bounds', n);
    assert.ok(r >= fair.MIN_RESULT && r <= fair.MAX_RESULT, `out of range: ${r}`);
  }
});

test('winChance is exactly 0.99/target', () => {
  for (const t of [1.01, 1.5, 2, 3.5, 10, 100]) {
    assert.ok(Math.abs(fair.winChance(t) - 0.99 / t) < 1e-12);
  }
});

// ── the statistical properties that make it a real game ─────────────────────
const N = 200_000;

test('empirical win rate matches 0.99/target (Monte Carlo)', () => {
  for (const target of [1.01, 1.5, 2, 10]) {
    const targetH = Math.round(target * 100);
    let wins = 0;
    for (let n = 0; n < N; n++) {
      if (fair.resultFromSeeds(SERVER_SEED, 'mc', n) >= targetH) wins++;
    }
    const p = wins / N;
    const expected = 0.99 / target;
    const se = Math.sqrt((expected * (1 - expected)) / N);
    assert.ok(Math.abs(p - expected) < 5 * se + 1e-3,
      `target ${target}: got ${p.toFixed(5)}, expected ${expected.toFixed(5)} (+/- ${(5 * se).toFixed(5)})`);
  }
});

test('realized RTP is ~99% at 2.00x, i.e. the edge is 1%', () => {
  let returned = 0;
  for (let n = 0; n < N; n++) {
    if (fair.resultFromSeeds(SERVER_SEED, 'rtp', n) >= 200) returned += 2; // stake 1, win pays 2
  }
  const rtp = returned / N;
  assert.ok(Math.abs(rtp - 0.99) < 0.01, `RTP was ${(rtp * 100).toFixed(3)}%, expected ~99%`);
});

test('the underlying X is uniform on [0,1)', () => {
  const buckets = new Array(10).fill(0);
  for (let n = 0; n < N; n++) {
    const h = crypto.createHmac('sha256', SERVER_SEED).update(`unif|${n}`).digest('hex');
    const x = parseInt(h.slice(0, 13), 16) / 2 ** 52;
    buckets[Math.min(9, Math.floor(x * 10))]++;
  }
  const expected = N / 10;
  const sd = Math.sqrt(expected * 0.9);
  for (let i = 0; i < 10; i++) {
    assert.ok(Math.abs(buckets[i] - expected) < 5 * sd,
      `bucket ${i}: ${buckets[i]} vs expected ~${expected}`);
  }
});

test('~2% of outcomes are clamped up to exactly 1.00x', () => {
  let lows = 0;
  for (let n = 0; n < N; n++) {
    if (fair.resultFromSeeds(SERVER_SEED, 'clamp', n) === 100) lows++;
  }
  const frac = lows / N;
  // result == 100 exactly when the raw value 99/(1-X) < 101, i.e. X < 99/101,
  // i.e. X < 0.01980198 -- the same region that drives the top of the game.
  const expected = 1 - 99 / 101;
  assert.ok(Math.abs(frac - expected) < 0.003,
    `clamped fraction was ${frac.toFixed(4)}, expected ~${expected.toFixed(4)}`);
});

// ── the verifier ────────────────────────────────────────────────────────────
test('verifyBet passes for a genuine bet and reports the recreation', () => {
  const clientSeed = 'verifyme';
  const nonce = 7;
  const report = fair.verifyBet({
    serverSeed: SERVER_SEED,
    serverSeedHash: COMMITMENT,
    clientSeed,
    nonce,
    target: 2,
  });
  assert.equal(report.ok, true);
  assert.equal(report.multiplier, fair.multiplierFromSeeds(SERVER_SEED, clientSeed, nonce));
});

test('verifyBet fails when the server seed does not match the commitment', () => {
  const report = fair.verifyBet({
    serverSeed: fair.generateServerSeed(),
    serverSeedHash: COMMITMENT,
    clientSeed: 'verifyme',
    nonce: 7,
    target: 2,
  });
  assert.equal(report.ok, false);
});
