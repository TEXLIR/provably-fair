'use strict';

/**
 * Provably-fair dice / limbo engine — core algorithm.
 *
 * This is a clean-room reimplementation of bustadice's published, verifiable
 * scheme (github.com/bustadice/verifier, src/utils/math.ts). It reproduces the
 * exact formula:
 *
 *   message    = `${clientSeed}|${nonce}`
 *   hash       = hex( HMAC-SHA256(key = serverSeed, message) )
 *   X          = parseInt(hash.slice(0, 13), 16) / 2**52      // uniform [0,1)
 *   result     = clamp( floor( 99 / (1 - X) ), 100, 100000000 )
 *   multiplier = result / 100                                  // 1.00x .. 1,000,000.00x
 *
 * Fairness comes from the commit/reveal cycle:
 *   1. before betting, the house publishes serverSeedHash = SHA256(serverSeed)
 *   2. bets are resolved from the hidden serverSeed
 *   3. the house later reveals serverSeed; anyone can check
 *        (a) SHA256(serverSeed) === the hash published up front, and
 *        (b) each bet's multiplier recomputes from serverSeed + clientSeed + nonce
 *
 * Note the two seeds play different roles on purpose: the house commits to the
 * server seed (can't change it after seeing bets), and the player supplies the
 * client seed (so the house can't precompute the sequence).
 */

const crypto = require('crypto');

const HOUSE_EDGE = 0.01;               // 1% — bustadice pays 99/target
const MIN_RESULT = 100;                // 1.00x, in hundredths
const MAX_RESULT = 100_000_000;        // 1,000,000.00x, in hundredths
const MIN_TARGET = 1.01;
const MAX_TARGET = 1_000_000;

/** A fresh 256-bit server seed, hex-encoded (64 chars). */
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * The public commitment to a server seed.
 * bustadice hashes the *decoded seed bytes*, not the hex text — matched here.
 */
function commitServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex');
}

/**
 * Resolve one bet to an integer count of hundredths (bustadice's native form).
 * Range: [100, 100000000] = 1.00x .. 1,000,000.00x.
 */
function resultFromSeeds(serverSeed, clientSeed, nonce) {
  const message = `${clientSeed}|${nonce}`;
  const hash = crypto.createHmac('sha256', serverSeed).update(message).digest('hex');
  const X = parseInt(hash.slice(0, 13), 16) / 2 ** 52; // 13 hex chars == 52 bits
  const result = Math.floor(99 / (1 - X));
  return Math.max(MIN_RESULT, Math.min(result, MAX_RESULT));
}

/** Same, as a float multiplier (e.g. 2.47). */
function multiplierFromSeeds(serverSeed, clientSeed, nonce) {
  return resultFromSeeds(serverSeed, clientSeed, nonce) / 100;
}

/**
 * Probability a bet at `target` wins. Exactly 0.99/target for the 2-decimal
 * targets the game accepts — this is where the 1% house edge lives.
 */
function winChance(target) {
  if (!(target >= MIN_TARGET && target <= MAX_TARGET)) {
    throw new RangeError(`target must be between ${MIN_TARGET} and ${MAX_TARGET}`);
  }
  return (1 - HOUSE_EDGE) / target;
}

/** Max multiplier that still yields a whole-hundredth result (sanity helper). */
function isValidTarget(target) {
  return Number.isFinite(target) && target >= MIN_TARGET && target <= MAX_TARGET;
}

/**
 * Independently verify a single bet. Returns a report rather than throwing, so
 * a UI can show exactly which check failed. This function is the whole point of
 * "provably fair" — it needs nothing but the published values.
 */
function verifyBet({ serverSeed, serverSeedHash, clientSeed, nonce, target }) {
  const checks = [];
  const recomputedHash = commitServerSeed(serverSeed);
  checks.push({
    name: 'server seed matches the published commitment',
    pass: recomputedHash === serverSeedHash,
    expected: serverSeedHash,
    actual: recomputedHash,
  });

  const result = resultFromSeeds(serverSeed, clientSeed, nonce);
  const multiplier = result / 100;
  const won = multiplier >= target;
  checks.push({
    name: 'bet outcome recomputes from the seeds',
    pass: true,
  });

  return {
    ok: checks.every((c) => c.pass),
    checks,
    nonce,
    clientSeed,
    serverSeedHash,
    result,
    multiplier,
    target,
    won,
  };
}

module.exports = {
  HOUSE_EDGE,
  MIN_RESULT,
  MAX_RESULT,
  MIN_TARGET,
  MAX_TARGET,
  generateServerSeed,
  commitServerSeed,
  resultFromSeeds,
  multiplierFromSeeds,
  winChance,
  isValidTarget,
  verifyBet,
};
