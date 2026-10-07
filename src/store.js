'use strict';

/**
 * Storage abstraction.
 *
 * The game state used to live in module memory, which cannot work on Vercel:
 * serverless functions get a fresh (or reused-but-not-guaranteed) instance per
 * request, so bankrolls, nonces and — critically — unrevealed server seeds
 * would evaporate between the bet and the verification.
 *
 * Two implementations behind one interface:
 *   MemoryStore  — process memory. Used by the tests and local dev.
 *   RedisStore   — Upstash Redis over HTTP (the only serverless-friendly Redis
 *                  client; plain TCP clients like ioredis don't fit per-request
 *                  invocation). Used on Vercel.
 *
 * `@upstash/redis` is required LAZILY so the test suite and local server run
 * with zero installed dependencies.
 */

class MemoryStore {
  constructor() {
    this.strings = new Map();
    this.lists = new Map();
  }

  async get(key) { return this.strings.has(key) ? this.strings.get(key) : null; }
  async set(key, value) { this.strings.set(key, String(value)); }

  async getJSON(key) {
    const raw = await this.get(key);
    return raw === null ? null : JSON.parse(raw);
  }
  async setJSON(key, value) { await this.set(key, JSON.stringify(value)); }

  async incr(key) { return this.incrBy(key, 1); }

  /**
   * Must be ATOMIC: the engine relies on INCRBY semantics (real Redis executes
   * it as one command). An `await` between the read and the write would let two
   * concurrent callers interleave and lose an update — the concurrency test
   * caught exactly that. This body has no await, so it runs to completion
   * without yielding.
   */
  async incrBy(key, n) {
    const next = Number(this.strings.has(key) ? this.strings.get(key) : 0) + n;
    this.strings.set(key, String(next));
    return next;
  }

  /** SET key value NX [PX ttl] -> true if it was set. */
  async setIfAbsent(key, value, ttlMs) {
    if (this.strings.has(key)) return false;
    await this.set(key, value);
    if (ttlMs) {
      setTimeout(() => this.delIfEquals(key, String(value)), ttlMs).unref?.();
    }
    return true;
  }

  async del(key) { this.strings.delete(key); }
  async delIfEquals(key, value) { if (this.strings.get(key) === value) this.strings.delete(key); }

  /** LPUSH + LTRIM, atomically enough for one process. */
  async pushCapped(key, value, cap) {
    const list = this.lists.get(key) || [];
    list.unshift(value);
    while (list.length > cap) list.pop();
    this.lists.set(key, list);
  }

  async range(key, start, stop) {
    const list = this.lists.get(key) || [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }
}

class RedisStore {
  constructor(url, token) {
    if (!url || !token) throw new Error('RedisStore needs a url and token');
    // eslint-disable-next-line global-require
    const { Redis } = require('@upstash/redis');
    this.redis = new Redis({ url, token });
  }

  async get(key) { const v = await this.redis.get(key); return v === undefined ? null : v; }
  async set(key, value) { await this.redis.set(key, String(value)); }
  async getJSON(key) {
    const v = await this.redis.get(key);
    if (v === null || v === undefined) return null;
    return typeof v === 'string' ? JSON.parse(v) : v; // the client auto-parses JSON
  }
  async setJSON(key, value) { await this.redis.set(key, JSON.stringify(value)); }

  async incr(key) { return this.redis.incr(key); }
  async incrBy(key, n) { return this.redis.incrby(key, n); }

  async setIfAbsent(key, value, ttlMs) {
    const opts = { nx: true };
    if (ttlMs) opts.px = ttlMs;
    const res = await this.redis.set(key, String(value), opts);
    return res === 'OK' || res === true;
  }

  async del(key) { await this.redis.del(key); }

  /** Compare-and-delete in one round trip, so we never drop someone else's lock. */
  async delIfEquals(key, value) {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      [key], [value],
    );
  }

  async pushCapped(key, value, cap) {
    await this.redis.lpush(key, value);
    await this.redis.ltrim(key, 0, cap - 1);
  }

  async range(key, start, stop) {
    const out = await this.redis.lrange(key, start, stop);
    return out || [];
  }
}

/**
 * Pick a store. On Vercel the Upstash Marketplace integration injects either
 * UPSTASH_REDIS_REST_* (Upstash's own names) or the legacy KV_REST_API_*
 * names from the migrated Vercel KV — accept both.
 */
function createStore(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(url, token);
  return new MemoryStore();
}

module.exports = { MemoryStore, RedisStore, createStore };
