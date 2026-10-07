'use strict';
// GET /api/state?playerId=1 — bankroll, edge stats, live feed, your state
module.exports = require('../src/vercel').route('state');
