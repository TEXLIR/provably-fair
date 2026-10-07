'use strict';
// GET /api/maxbet?target=2 — largest stake allowed at that target (profit cap)
module.exports = require('../src/vercel').route('maxbet');
