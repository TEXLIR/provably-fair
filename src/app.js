'use strict';

/**
 * Route dispatch, shared by the Vercel functions (api/*) and the local dev
 * server (src/server.js). Keeping it in one place means the deployed app and
 * `node src/server.js` cannot drift apart.
 *
 * `handle(route, req)` returns `{ status, json }` and never throws, so callers
 * only have to worry about writing the response in their own dialect.
 */

const { Casino, SAT_PER_BIT } = require('./engine');
const { createStore } = require('./store');

/**
 * One Casino per process. `init()` is idempotent (SET NX), so a cold start
 * re-running it is harmless — that is what lets this run on serverless.
 */
let casinoPromise = null;
function getCasino() {
  if (!casinoPromise) {
    casinoPromise = new Casino({ store: createStore() }).init();
  }
  return casinoPromise;
}

const asNumber = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function handle(route, req = {}, injectedCasino) {
  const query = req.query || {};
  const body = req.body || {};

  let casino;
  try {
    casino = injectedCasino || (await getCasino());
  } catch (e) {
    return { status: 500, json: { error: `storage unavailable: ${e.message}` } };
  }

  try {
    switch (route) {
      case 'state': {
        const playerId = asNumber(query.playerId, 1);
        const state = await casino.state();
        let player = null;
        try { player = await casino.playerState(playerId); } catch { /* unknown player is fine */ }
        return { status: 200, json: { ...state, player } };
      }

      case 'maxbet': {
        const target = asNumber(query.target, 2);
        if (!(target > 1)) return { status: 400, json: { error: 'target must be > 1' } };
        const sat = await casino.maxBetSat(target);
        return {
          status: 200,
          json: { target, maxBetSat: sat, maxBetBits: sat / SAT_PER_BIT, maxProfitSat: await casino.maxProfitSat() },
        };
      }

      case 'players': {
        // The cap lives in the engine; map its refusal to a 429 here.
        try {
          const p = await casino.addPlayer(String(body.name || '').slice(0, 24), 10_000);
          return { status: 200, json: { player: casino.publicPlayer(p) } };
        } catch (e) {
          if (/player limit/.test(e.message)) return { status: 429, json: { error: e.message } };
          throw e;
        }
      }

      case 'bet': {
        const amountSat = Math.round(asNumber(body.amountBits, 0) * SAT_PER_BIT);
        const out = await casino.placeBet(body.playerId, amountSat, asNumber(body.target, 0));
        if (out.error) return { status: 400, json: out };
        return {
          status: 200,
          json: { bet: out.bet, state: await casino.state(), player: out.player },
        };
      }

      case 'rotate': {
        const out = await casino.rotateSeed(body.playerId, body.clientSeed);
        return { status: 200, json: out };
      }

      case 'verify': {
        const report = await casino.verifyBet(body.playerId, {
          serverSeed: String(body.serverSeed || '').trim(),
          clientSeed: String(body.clientSeed || ''),
          nonce: asNumber(body.nonce, NaN),
          target: asNumber(body.target, NaN),
        });
        return { status: 200, json: report };
      }

      default:
        return { status: 404, json: { error: `unknown route: ${route}` } };
    }
  } catch (e) {
    const missing = /no such player/.test(e.message);
    return { status: missing ? 404 : e instanceof RangeError ? 400 : 500, json: { error: e.message } };
  }
}

module.exports = { handle, getCasino };
