'use strict';

/**
 * House-side game engine — PLAY MONEY ONLY.
 *
 * Stateless by design: every method reads what it needs from a Store, computes,
 * and writes back. That is what makes it runnable on Vercel, where a request
 * may land on any instance and module memory cannot be trusted to survive.
 *
 * Money model: integer satoshis (100 sat = 1 bit). No floating point dollars.
 *
 * Risk model: the house caps the profit it pays on one bet at
 * `maxProfitFraction` of the bankroll (default 1%, bustabit's documented cap).
 * That cap — not luck — is what stops one whale emptying the bankroll.
 *
 * Concurrency: shared counters (bankroll, totals) use atomic INCRBY, so two
 * players betting at once cannot corrupt them. Per-player state (nonce, seeds,
 * balance) is a read-modify-write, so it is wrapped in a short per-player lock.
 */

const crypto = require('crypto');
const fair = require('./fair');

const SAT_PER_BIT = 100;
const FEED_SIZE = 60;

const K = {
  bankroll: 'pf:bankroll',
  startBankroll: 'pf:startBankroll',
  config: 'pf:config',
  nextPlayerId: 'pf:nextPlayerId',
  wagered: 'pf:wagered',
  bets: 'pf:bets',
  houseNet: 'pf:houseNet',
  feed: 'pf:feed',
  player: (id) => `pf:player:${id}`,
  lock: (id) => `pf:lock:${id}`,
};

class Casino {
  /**
   * @param {object} opts
   * @param {object} opts.store              a Store (see store.js)
   * @param {number} opts.bankrollSat        starting house bankroll
   * @param {number} opts.maxProfitFraction  max profit per bet, as a fraction of bankroll
   * @param {number} opts.maxPlayers         cap on player creation (no auth on this demo)
   */
  constructor({ store, bankrollSat = 100_000 * SAT_PER_BIT, maxProfitFraction = 0.01, maxPlayers = 200 }) {
    if (!store) throw new Error('Casino needs a store');
    this.store = store;
    this.defaultBankrollSat = bankrollSat;
    this.maxProfitFraction = maxProfitFraction;
    this.maxPlayers = maxPlayers;
  }

  /** Idempotent: writes defaults only if they are not already there. */
  async init() {
    await this.store.setIfAbsent(K.bankroll, String(this.defaultBankrollSat));
    await this.store.setIfAbsent(K.startBankroll, String(this.defaultBankrollSat));
    await this.store.setIfAbsent(K.config, JSON.stringify({ maxProfitFraction: this.maxProfitFraction }));
    await this.store.setIfAbsent(K.nextPlayerId, '1');
    return this;
  }

  // ── numbers ──────────────────────────────────────────────────────────────
  async bankrollSat() {
    return Number((await this.store.get(K.bankroll)) || 0);
  }

  async maxProfitSat() {
    const cfg = (await this.store.getJSON(K.config)) || { maxProfitFraction: this.maxProfitFraction };
    return Math.floor((await this.bankrollSat()) * cfg.maxProfitFraction);
  }

  async maxBetSat(target) {
    return Math.floor((await this.maxProfitSat()) / (target - 1));
  }

  // ── players ──────────────────────────────────────────────────────────────
  async getPlayer(id) {
    const p = await this.store.getJSON(K.player(Number(id)));
    if (!p) throw new Error(`no such player: ${id}`);
    return p;
  }

  async savePlayer(p) {
    await this.store.setJSON(K.player(p.id), p);
  }

  async addPlayer(name, startingBalanceBits = 10_000) {
    if ((await this.playerCount()) >= this.maxPlayers) {
      throw new Error(`player limit reached (${this.maxPlayers})`);
    }
    const id = await this.store.incr(K.nextPlayerId);
    const player = {
      id,
      name: name || `player-${id}`,
      balanceSat: Math.round(startingBalanceBits * SAT_PER_BIT),
      clientSeed: `seed-${id}-${Date.now().toString(36)}`,
      serverSeed: fair.generateServerSeed(),
      nonce: 0,
      stats: { bets: 0, wageredSat: 0, netSat: 0, wins: 0 },
      revealed: [],
    };
    player.serverSeedHash = fair.commitServerSeed(player.serverSeed);
    await this.savePlayer(player);
    return player;
  }

  async playerCount() {
    // cheap approximation: highest id handed out so far
    return Number((await this.store.get(K.nextPlayerId)) || 1) - 1;
  }

  /** Serialise read-modify-write on one player. Uses SET NX PX as a lock. */
  async withPlayerLock(id, fn) {
    const key = K.lock(id);
    const token = crypto.randomUUID(); // only release the lock if it is still ours
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await this.store.setIfAbsent(key, token, 3000)) {
        try {
          return await fn();
        } finally {
          await this.store.delIfEquals(key, token);
        }
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the table is busy — try again');
  }

  // ── seed rotation (commit / reveal) ──────────────────────────────────────
  async rotateSeed(playerId, clientSeed) {
    return this.withPlayerLock(playerId, async () => {
      const p = await this.getPlayer(playerId);
      const revealed = {
        serverSeed: p.serverSeed,
        serverSeedHash: p.serverSeedHash,
        clientSeed: p.clientSeed,
        nonceCount: p.nonce, // how many bets were resolved with this seed
      };
      p.revealed.push(revealed);
      p.serverSeed = fair.generateServerSeed();
      p.serverSeedHash = fair.commitServerSeed(p.serverSeed);
      if (typeof clientSeed === 'string' && clientSeed.length > 0) p.clientSeed = clientSeed;
      p.nonce = 0;
      await this.savePlayer(p);
      return {
        revealed,
        newPair: { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed },
        player: this.publicPlayer(p),
      };
    });
  }

  // ── the game ─────────────────────────────────────────────────────────────
  async placeBet(playerId, amountSat, target) {
    return this.withPlayerLock(playerId, async () => {
      const p = await this.getPlayer(playerId);
      amountSat = Math.round(amountSat);

      if (!fair.isValidTarget(target)) {
        return { error: `target must be between ${fair.MIN_TARGET} and ${fair.MAX_TARGET}` };
      }
      if (!Number.isFinite(amountSat) || amountSat <= 0) {
        return { error: 'amount must be a positive number of satoshis' };
      }
      if (amountSat % SAT_PER_BIT !== 0) {
        return { error: 'amount must be a whole number of bits (divisible by 100 sat)' };
      }
      if (amountSat > p.balanceSat) {
        return { error: `insufficient balance: you have ${p.balanceSat} sat` };
      }
      const cap = await this.maxBetSat(target);
      if (amountSat > cap) {
        return { error: `max bet for ${target}x is ${cap} sat (${cap / SAT_PER_BIT} bits) — profit cap` };
      }

      const nonce = p.nonce;
      const result = fair.resultFromSeeds(p.serverSeed, p.clientSeed, nonce);
      const multiplier = result / 100;
      const targetH = Math.round(target * 100);
      const won = result >= targetH;
      const profitSat = won ? Math.floor((amountSat * (targetH - 100)) / 100) : -amountSat;

      p.nonce += 1;
      p.balanceSat += profitSat;
      p.stats.bets += 1;
      p.stats.wageredSat += amountSat;
      p.stats.netSat += profitSat;
      if (won) p.stats.wins += 1;
      await this.savePlayer(p);

      // atomic, so concurrent players can't clobber the shared totals
      await this.store.incrBy(K.bankroll, -profitSat);
      await this.store.incrBy(K.wagered, amountSat);
      await this.store.incr(K.bets);
      await this.store.incrBy(K.houseNet, -profitSat);
      await this.store.pushCapped(K.feed, JSON.stringify({
        id: `${p.id}-${nonce}`,
        playerName: p.name,
        amountSat,
        target,
        multiplier,
        won,
        profitSat,
      }), FEED_SIZE);

      const bet = {
        id: `${p.id}-${nonce}`,
        playerId: p.id,
        playerName: p.name,
        nonce,
        amountSat,
        target,
        multiplier,
        result,
        won,
        profitSat,
        balanceSat: p.balanceSat,
        // everything a third party needs to verify — the seed itself is only
        // revealed when the pair rotates
        proof: { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce, target },
      };
      return { bet, player: this.publicPlayer(p) };
    });
  }

  /** Verify a bet against a revealed server seed + the commitment history. */
  async verifyBet(playerId, { serverSeed, clientSeed, nonce, target }) {
    const p = await this.getPlayer(playerId);
    const committed = [p.serverSeedHash, ...p.revealed.map((r) => r.serverSeedHash)];
    const report = fair.verifyBet({
      serverSeed,
      serverSeedHash: fair.commitServerSeed(serverSeed),
      clientSeed,
      nonce,
      target,
    });
    report.checks.push({
      name: 'this seed was committed to in advance',
      pass: committed.includes(report.serverSeedHash),
      actual: report.serverSeedHash,
    });
    report.ok = report.checks.every((c) => c.pass);
    return report;
  }

  // ── views ────────────────────────────────────────────────────────────────
  /** Never includes the current server seed — that is the whole point. */
  publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      balanceSat: p.balanceSat,
      balanceBits: p.balanceSat / SAT_PER_BIT,
      clientSeed: p.clientSeed,
      serverSeedHash: p.serverSeedHash,
      nonce: p.nonce,
      stats: p.stats,
      revealed: p.revealed,
    };
  }

  async playerState(playerId) {
    return this.publicPlayer(await this.getPlayer(playerId));
  }

  async state() {
    const [bankroll, start, wagered, bets, houseNet, feedRaw] = await Promise.all([
      this.store.get(K.bankroll),
      this.store.get(K.startBankroll),
      this.store.get(K.wagered),
      this.store.get(K.bets),
      this.store.get(K.houseNet),
      this.store.range(K.feed, 0, FEED_SIZE - 1),
    ]);

    const w = Number(wagered || 0);
    const hn = Number(houseNet || 0);
    // RTP = value returned to players / wagered = 1 - houseNet/wagered
    const rtp = w > 0 ? 1 - hn / w : 0;

    return {
      bankrollSat: Number(bankroll || 0),
      bankrollBits: Number(bankroll || 0) / SAT_PER_BIT,
      startBankrollBits: Number(start || 0) / SAT_PER_BIT,
      maxProfitSat: await this.maxProfitSat(),
      maxProfitFraction: this.maxProfitFraction,
      totals: {
        bets: Number(bets || 0),
        wageredSat: w,
        wageredBits: w / SAT_PER_BIT,
        houseNetSat: hn,
        realizedRtp: rtp,
        edge: 1 - rtp,
      },
      feed: (feedRaw || []).map((x) => (typeof x === 'string' ? JSON.parse(x) : x)),
    };
  }
}

module.exports = { Casino, K, FEED_SIZE, SAT_PER_BIT };
