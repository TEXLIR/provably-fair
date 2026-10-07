'use strict';
// POST /api/rotate { playerId, clientSeed } — reveal the old seed, commit a new one
module.exports = require('../src/vercel').route('rotate');
