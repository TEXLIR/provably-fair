'use strict';

/**
 * Exercises the same `handle()` entry point that the Vercel functions call,
 * so the deployed routing is covered without needing Vercel to run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../src/app');
const { Casino, SAT_PER_BIT } = require('../src/engine');
const { MemoryStore } = require('../src/store');

async function ctx() {
  const store = new MemoryStore();
  const casino = await new Casino({ store }).init();
  const player = await casino.addPlayer('api-tester', 10_000);
  return { casino, player };
}

test('GET /api/state returns bankroll, totals and the player', async () => {
  const { casino, player } = await ctx();
  const out = await handle('state', { query: { playerId: String(player.id) } }, casino);
  assert.equal(out.status, 200);
  assert.ok(out.json.bankrollSat > 0);
  assert.equal(out.json.totals.bets, 0);
  assert.equal(out.json.player.id, player.id);
});

test('GET /api/state with an unknown player returns player:null, not an error', async () => {
  const { casino } = await ctx();
  const out = await handle('state', { query: { playerId: '9999' } }, casino);
  assert.equal(out.status, 200);
  assert.equal(out.json.player, null);
});

test('GET /api/maxbet reports the profit cap for a target', async () => {
  const { casino } = await ctx();
  const out = await handle('maxbet', { query: { target: '2' } }, casino);
  assert.equal(out.status, 200);
  assert.equal(out.json.maxBetSat, out.json.maxProfitSat);
  assert.equal(out.json.maxBetBits, 1000); // 1% of a 100,000-bit bankroll
});

test('POST /api/bet settles a bet and updates state', async () => {
  const { casino, player } = await ctx();
  const out = await handle('bet', { body: { playerId: player.id, amountBits: 100, target: 2 } }, casino);
  assert.equal(out.status, 200);
  assert.ok(out.json.bet);
  assert.equal(out.json.state.totals.bets, 1);
  assert.equal(out.json.state.totals.wageredSat, 100 * SAT_PER_BIT);
});

test('POST /api/bet rejects a stake above the cap with 400', async () => {
  const { casino, player } = await ctx();
  const out = await handle('bet', { body: { playerId: player.id, amountBits: 5000, target: 2 } }, casino);
  assert.equal(out.status, 400);
  assert.match(out.json.error, /max bet/);
});

test('POST /api/bet rejects an invalid target with 400', async () => {
  const { casino, player } = await ctx();
  const out = await handle('bet', { body: { playerId: player.id, amountBits: 100, target: 1 } }, casino);
  assert.equal(out.status, 400);
});

test('the full commit -> reveal -> verify cycle works through the API', async () => {
  const { casino, player } = await ctx();

  const bet = await handle('bet', { body: { playerId: player.id, amountBits: 100, target: 2 } }, casino);
  assert.equal(bet.status, 200);
  const { proof, multiplier } = bet.json.bet;

  const rot = await handle('rotate', { body: { playerId: player.id, clientSeed: 'mine' } }, casino);
  assert.equal(rot.status, 200);
  const revealedSeed = rot.json.revealed.serverSeed;

  const ver = await handle('verify', {
    body: {
      playerId: player.id,
      serverSeed: revealedSeed,
      clientSeed: proof.clientSeed,
      nonce: proof.nonce,
      target: proof.target,
    },
  }, casino);

  assert.equal(ver.status, 200);
  assert.equal(ver.json.ok, true, JSON.stringify(ver.json.checks));
  assert.equal(ver.json.multiplier, multiplier, 'recomputed multiplier must match the bet');
  assert.equal(ver.json.serverSeedHash, proof.serverSeedHash, 'reveal must match the earlier commitment');
});

test('the API never returns the unrevealed server seed', async () => {
  const { casino, player } = await ctx();
  await handle('bet', { body: { playerId: player.id, amountBits: 100, target: 2 } }, casino);
  const state = await handle('state', { query: { playerId: String(player.id) } }, casino);
  const secret = (await casino.getPlayer(player.id)).serverSeed;
  assert.equal(JSON.stringify(state.json).includes(secret), false);
});

test('POST /api/players creates a player and enforces the cap', async () => {
  const store = new MemoryStore();
  const casino = await new Casino({ store, maxPlayers: 2 }).init();
  assert.equal((await handle('players', { body: { name: 'a' } }, casino)).status, 200);
  assert.equal((await handle('players', { body: { name: 'b' } }, casino)).status, 200);
  const third = await handle('players', { body: { name: 'c' } }, casino);
  assert.equal(third.status, 429);
});

test('unknown routes return 404', async () => {
  const { casino } = await ctx();
  const out = await handle('nope', {}, casino);
  assert.equal(out.status, 404);
});

test('rotating an unknown player returns 404, not 500', async () => {
  const { casino } = await ctx();
  const out = await handle('rotate', { body: { playerId: 4242 } }, casino);
  assert.equal(out.status, 404);
});
