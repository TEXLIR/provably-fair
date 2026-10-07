'use strict';

/**
 * Adapter that turns a route into a Vercel Node.js serverless function.
 *
 * Vercel's /api handlers get `req.query` and a parsed `req.body`, plus the
 * `res.status().json()` helpers (which plain Node `http` handlers do NOT have —
 * hence the separate local server in src/server.js).
 */

const { handle } = require('./app');

function route(name) {
  return async function handler(req, res) {
    // A malformed JSON body makes Vercel throw while parsing req.body.
    let body = {};
    try {
      body = req.body || {};
      if (typeof body === 'string') body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    const out = await handle(name, { query: req.query || {}, body });
    return res.status(out.status).json(out.json);
  };
}

module.exports = { route };
