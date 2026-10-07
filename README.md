# Provably-Fair Dice — free-play engine

A working implementation of a bustadice-style dice/limbo game: the
**provably-fair** commit/reveal scheme, a house-side bankroll engine with a 1%
edge, a playable browser client that verifies its own bets, and a serverless
layout that deploys to Vercel with Redis for state.

> **PLAY MONEY ONLY.** There is no deposit, withdrawal, wallet, payment or
> cashout code anywhere in this project, and there is intentionally no place to
> put real funds. It is an educational/portfolio implementation of the *game
> mechanics*. Operating a real-money gambling site is a licensed activity in
> most jurisdictions and is a criminal offence without a licence — see
> [Legal](#legal).

## The algorithm

A clean-room reimplementation of bustadice's published verifier
(`github.com/bustadice/verifier`, `src/utils/math.ts`):

```
message    = `${clientSeed}|${nonce}`
hash       = hex( HMAC-SHA256(key = serverSeed, message) )
X          = parseInt(hash.slice(0, 13), 16) / 2**52     // 13 hex chars == 52 bits, uniform [0,1)
result     = clamp( floor( 99 / (1 - X) ), 100, 100000000 )
multiplier = result / 100                                 // 1.00x .. 1,000,000.00x
```

The commitment is `SHA256( the seed's decoded bytes )`, not the hex text.

Two consequences worth knowing:

- **Win chance is exactly `0.99 / target`** for 2-decimal targets. That is where
  the 1% house edge lives — in the formula, not in a hidden knob.
- Values below 1.00x are clamped up, so **~1.98% of outcomes are exactly 1.00x**
  (`X < 99/101`). The test suite pins this.

## Why it's provably fair

A **commit/reveal** cycle, which only works because you can't hold both seeds:

1. Before you bet, the house publishes `serverSeedHash = SHA256(serverSeed)`.
   It is now committed — it cannot swap the seed later without the hash changing.
2. Bets resolve from the hidden `serverSeed` + **your** `clientSeed` + a nonce.
   You choose the client seed, so the house can't precompute the sequence.
3. On rotation the house **reveals** `serverSeed`. Anyone can check that
   `SHA256(revealed) == the hash published in step 1`, and recompute every bet.

`public/app.js` does this verification **locally with Web Crypto** — it does not
ask the server for the answer. The `/api/verify` endpoint is used only for the
thing the client can't check alone: that the seed was committed to *before* the
bets were placed.

## Run it locally

```bash
npm start            # -> http://127.0.0.1:8080   (node src/server.js)
npm test             # 43 tests, no dependencies required
```

Without Redis env vars it uses an in-memory store (state resets on restart).
Set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to use the same store
the deployment uses.

`npm test` deliberately needs **no install**: `@upstash/redis` is required
lazily, only when a Redis store is actually constructed.

## Deploy to Vercel

```bash
npm install          # pulls @upstash/redis
vercel               # or import the repo in the Vercel dashboard
```

Then add the Redis integration once:

1. **Vercel dashboard → Storage → Marketplace → Upstash Redis** (create a free
   database). Note: **Vercel KV was discontinued** in Dec 2024 and migrated to
   Upstash, so there is no "KV" product to pick any more.
2. Connect it to the project. It injects the credentials automatically.
3. Redeploy. No other configuration is needed — `vercel.json` only sets a
   function timeout.

The app reads **either** env-var naming convention
(`UPSTASH_REDIS_REST_URL`/`_TOKEN` or the legacy `KV_REST_API_URL`/`_TOKEN`), so
either integration works unmodified.

**Why Redis is required:** the previous version kept state in module memory.
Serverless functions may get a fresh instance per request, so bankrolls, nonces
and — critically — *unrevealed server seeds* would vanish between the bet and
the verification, which destroys the commit/reveal guarantee. Redis is the only
storage that survives across invocations.

> Without the integration connected, `/api/state` returns HTTP 500
> `storage unavailable` — that is the app failing closed rather than silently
> pretending to be fair.

## Project layout

```
api/                 Vercel serverless functions (one per route)
src/fair.js          the algorithm: commitment, outcome, independent verifier
src/engine.js        house side: bankroll, players, profit cap, seed rotation
src/store.js         storage: MemoryStore (local/tests) + RedisStore (Upstash)
src/app.js           route dispatch, shared by Vercel and the local server
src/vercel.js        thin adapter: route -> Vercel Node handler
src/server.js        local dev server (raw Node http)
public/              playable UI (vanilla JS, verifies bets client-side)
test/                43 tests: vectors, fairness stats, accounting, API, store
```

## Design notes

- **Money is integer satoshis** (100 sat = 1 bit). No floating-point dollars.
- **Shared counters are atomic.** Bankroll, wagered, bet count and house net use
  `INCRBY`, so concurrent players can't clobber each other. Per-player state
  (nonce, seeds, balance) is a read-modify-write, so it takes a short per-player
  lock (`SET NX PX`).
- **The profit cap is the risk control.** Max profit per bet = 1% of the
  bankroll (bustabit's documented cap). A bankroll too small for its bettors is
  how houses go broke; `/api/bet` rejects any stake that would pay more than the
  cap.
- **The unrevealed server seed never leaves the store.** A test asserts it does
  not appear anywhere in the API responses.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state?playerId=1` | bankroll, edge stats, live feed, your state |
| GET | `/api/maxbet?target=2` | largest stake allowed at that target |
| POST | `/api/players` | `{name}` — create a player |
| POST | `/api/bet` | `{playerId, amountBits, target}` |
| POST | `/api/rotate` | `{playerId, clientSeed}` — reveal + start a new seed pair |
| POST | `/api/verify` | `{playerId, serverSeed, clientSeed, nonce, target}` |

## Legal

This is a **free-play demo of game mechanics**, not a gambling product. It has no
payment rails by design. Real-money gambling is regulated: it requires a licence
from an approved jurisdiction, KYC/AML compliance, segregated player funds, and
(for most player markets) it is illegal to serve players without a local
licence. Nothing here grants or implies that permission — if you want to run a
real-money site, talk to a gambling lawyer in your jurisdiction first.

## Licence

MIT.
