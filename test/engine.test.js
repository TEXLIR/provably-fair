'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Casino, SAT_PER_BIT } = require('../src/engine');
const { MemoryStore } = require('../src/store');
const fair = require('../src/fair');

async function fresh(opts = {}) {
  const store = new MemoryStore();
  const casino = await new Casino({
    store,
    bankrollSat: opts.bankrollSat ?? 100_000 * SAT_PER_BIT,
    maxProfitFraction: 0.01,
    maxPlayers: opts.maxPlayers ?? 200,
  }).init();
  const player = await casino.addPlayer('tester', 10_000);
  return { casino, player, store };
}

test('money is conserved: player profit is exactly the house loss', async () => {
  const { casino, player } = await fresh();
  const bankroll0 = await casino.bankrollSat();
  for (let n = 0; n < 500; n++) {
    await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
  }
  const p = await casino.getPlayer(player.id);
  const playerNet = p.stats.netSat;                       // + = player up
  const houseNet = (await casino.bankrollSat()) - bankroll0; // + = house up
  assert.equal(playerNet + houseNet, 0);
  assert.equal(p.stats.netSat, p.balanceSat - 10_000 * SAT_PER_BIT);
});

test('nonce increments once per bet and never repeats', async () => {
  const { casino, player } = await fresh();
  const seen = new Set();
  for (let n = 0; n < 100; n++) {
    const { bet } = await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
    assert.equal(seen.has(bet.nonce), false, 'nonce reused!');
    seen.add(bet.nonce);
    assert.equal(bet.nonce, n);
  }
});

test('the profit cap is enforced (this is what protects the bankroll)', async () => {
  const { casino, player } = await fresh();
  const cap = await casino.maxBetSat(2);
  assert.equal(cap, await casino.maxProfitSat()); // target 2 => payout equals stake

  const tooBig = await casino.placeBet(player.id, cap + SAT_PER_BIT, 2);
  assert.ok(tooBig.error, 'expected a rejection above the cap');
  assert.match(tooBig.error, /max bet/);

  const ok = await casino.placeBet(player.id, cap, 2);
  assert.ok(ok.bet, 'a bet exactly at the cap must be allowed');
});

test('whole-bit stakes, positive amounts and sufficient balance are required', async () => {
  const { casino, player } = await fresh();
  assert.ok((await casino.placeBet(player.id, 150, 2)).error, '150 sat is not a whole bit');
  assert.ok((await casino.placeBet(player.id, 0, 2)).error, 'zero stake');
  assert.ok((await casino.placeBet(player.id, -100, 2)).error, 'negative stake');
  assert.ok((await casino.placeBet(player.id, 20_000 * SAT_PER_BIT, 2)).error, 'more than the balance');
});

test('invalid targets are rejected', async () => {
  const { casino, player } = await fresh();
  assert.ok((await casino.placeBet(player.id, 100 * SAT_PER_BIT, 1.0)).error);
  assert.ok((await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2_000_000)).error);
});

test('a winning bet pays stake*(target-1) and a losing bet costs the stake', async () => {
  const { casino, player } = await fresh();
  const stake = 100 * SAT_PER_BIT;
  const before = (await casino.getPlayer(player.id)).balanceSat;
  const { bet } = await casino.placeBet(player.id, stake, 2);
  const expected = bet.won ? Math.floor((stake * (200 - 100)) / 100) : -stake;
  assert.equal(bet.profitSat, expected);
  assert.equal((await casino.getPlayer(player.id)).balanceSat, before + expected);
});

test('rotating a seed reveals the old one, commits a new one, and resets the nonce', async () => {
  const { casino, player } = await fresh();
  const oldHash = (await casino.getPlayer(player.id)).serverSeedHash;
  await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
  await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);

  const { revealed, newPair } = await casino.rotateSeed(player.id, 'new-client-seed');

  assert.equal(revealed.serverSeedHash, oldHash);
  assert.equal(fair.commitServerSeed(revealed.serverSeed), oldHash); // the reveal checks out
  assert.equal(revealed.nonceCount, 2);

  const after = await casino.getPlayer(player.id);
  assert.notEqual(newPair.serverSeedHash, oldHash);
  assert.equal(after.nonce, 0);
  assert.equal(after.clientSeed, 'new-client-seed');
});

test('verifyBet accepts a genuine revealed seed and rejects a swap', async () => {
  const { casino, player } = await fresh();
  await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
  const { revealed } = await casino.rotateSeed(player.id);

  const good = await casino.verifyBet(player.id, {
    serverSeed: revealed.serverSeed,
    clientSeed: revealed.clientSeed,
    nonce: 0,
    target: 2,
  });
  assert.equal(good.ok, true, JSON.stringify(good.checks));

  const bad = await casino.verifyBet(player.id, {
    serverSeed: fair.generateServerSeed(), // never committed to
    clientSeed: revealed.clientSeed,
    nonce: 0,
    target: 2,
  });
  assert.equal(bad.ok, false);
});

test('the house edge shows up as realized RTP ~99% over many bets', async () => {
  const { casino } = await fresh({ bankrollSat: 100_000_000 * SAT_PER_BIT });
  const player = await casino.addPlayer('whale', 10_000_000);
  for (let n = 0; n < 100_000; n++) {
    const r = await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
    assert.ok(!r.error, `bet ${n} unexpectedly rejected: ${r.error}`);
  }
  const s = await casino.state();
  assert.ok(Math.abs(s.totals.edge - 0.01) < 0.01,
    `realized edge was ${(s.totals.edge * 100).toFixed(3)}%`);
});

test('players can never go negative in free play', async () => {
  const { casino, player } = await fresh();
  for (let n = 0; n < 5_000; n++) {
    const out = await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2);
    if (out.error) continue; // max-bet / balance rejections are expected
    assert.ok(out.player.balanceSat >= 0);
  }
});

// ── the property that makes it serverless-safe ──────────────────────────────
test('state survives across engine instances sharing one store', async () => {
  const store = new MemoryStore();
  const a = await new Casino({ store }).init();
  const player = await a.addPlayer('cross-instance', 10_000);
  await a.placeBet(player.id, 100 * SAT_PER_BIT, 2);
  await a.placeBet(player.id, 100 * SAT_PER_BIT, 2);

  // A "cold start": brand new Casino, same store — as on Vercel.
  const b = await new Casino({ store }).init();
  const st = await b.state();
  assert.equal(st.totals.bets, 2, 'bet counter did not survive the instance swap');
  assert.equal((await b.playerState(player.id)).nonce, 2, 'nonce did not survive');

  // init() must be idempotent — it must not reset the bankroll.
  const c = await new Casino({ store }).init();
  assert.equal((await c.state()).bankrollSat, st.bankrollSat, 'init() clobbered the bankroll');
});

test('concurrent bets from different players do not corrupt the shared bankroll', async () => {
  const { casino } = await fresh();
  const players = await Promise.all([0, 1, 2, 3, 4].map((i) => casino.addPlayer(`p${i}`, 10_000)));
  const bankroll0 = await casino.bankrollSat();

  await Promise.all(players.flatMap((p) =>
    Array.from({ length: 20 }, () => casino.placeBet(p.id, 100 * SAT_PER_BIT, 2))));

  const net = players.reduce(async (accP, p) => (await accP) + (await casino.getPlayer(p.id)).stats.netSat, Promise.resolve(0));
  const houseNet = (await casino.bankrollSat()) - bankroll0;
  assert.equal((await net) + houseNet, 0, 'bankroll and player balances disagree after concurrency');
});

test('the player cap is enforced when creating players', async () => {
  const { casino } = await fresh({ maxPlayers: 2 }); // 'tester' is player 1
  await casino.addPlayer('a');                       // player 2 -> at the cap
  assert.equal(await casino.playerCount(), 2);
  await assert.rejects(() => casino.addPlayer('b'), /player limit/);
});

test('state() never leaks the current server seed', async () => {
  const { casino, player } = await fresh();
  const st = await casino.state();
  const ps = await casino.playerState(player.id);
  const raw = JSON.stringify({ st, ps });
  const secret = (await casino.getPlayer(player.id)).serverSeed;
  assert.equal(raw.includes(secret), false, 'the unrevealed server seed leaked into the API view');
  assert.ok(ps.serverSeedHash, 'the commitment must be published');
});

test('bet ids stay unique across seed rotations', async () => {
  const { casino, player } = await fresh();
  const first = (await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2)).bet;
  await casino.rotateSeed(player.id);
  const second = (await casino.placeBet(player.id, 100 * SAT_PER_BIT, 2)).bet;
  assert.equal(first.id, `${player.id}-1-0`);
  assert.equal(second.id, `${player.id}-2-0`);
});
