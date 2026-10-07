'use strict';
// POST /api/verify { playerId, serverSeed, clientSeed, nonce, target }
module.exports = require('../src/vercel').route('verify');
