'use strict';

/* Provably-fair dice — play-money client.
 *
 * The interesting part: verification runs HERE, in your browser, with Web
 * Crypto. You do not have to trust the server's answer — you recompute it from
 * the revealed server seed yourself. The server's /api/verify is only used to
 * check that a seed was actually committed to before the bets were made.
 */

const MIN_TARGET = 1.01;
const MAX_TARGET = 1000;
const SAT_PER_BIT = 100;

let PLAYER_ID = Number(localStorage.getItem('pfPlayerId') || 1);

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function bits(sat) {
  return (sat / SAT_PER_BIT).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' bits';
}

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return res.json();
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function hexToBytes(hex) {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ── verification crypto (mirrors src/fair.js exactly) ──────────────────────
async function sha256Hex(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmacSha256Hex(keyStr, msgStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(msgStr)));
}

/** Recompute a bet outcome from first principles. No server involved. */
async function computeOutcome(serverSeed, clientSeed, nonce) {
  const message = `${clientSeed}|${nonce}`;
  const hash = await hmacSha256Hex(serverSeed, message);
  const X = parseInt(hash.slice(0, 13), 16) / 2 ** 52;
  const result = Math.max(100, Math.min(Math.floor(99 / (1 - X)), 100000000));
  return { hash, X, result, multiplier: result / 100 };
}

// ── target slider (logarithmic — 2.00x is not 0.1% away) ───────────────────
const sliderToTarget = (v) => MIN_TARGET * Math.pow(MAX_TARGET / MIN_TARGET, v / 1000);
const targetToSlider = (t) => 1000 * Math.log(t / MIN_TARGET) / Math.log(MAX_TARGET / MIN_TARGET);
const currentTarget = () => Math.round(sliderToTarget(Number($('target').value)) * 100) / 100;

// ── rendering ──────────────────────────────────────────────────────────────
let lastState = null;

function render(state) {
  lastState = state;
  $('h-bankroll').textContent = bits(state.bankrollSat);
  $('h-maxprofit').textContent = bits(state.maxProfitSat);
  $('h-bets').textContent = state.totals.bets.toLocaleString();
  $('h-wagered').textContent = bits(state.totals.wageredSat);
  $('h-rtp').textContent = state.totals.bets ? (state.totals.realizedRtp * 100).toFixed(2) + '%' : '—';
  $('h-edge').textContent = state.totals.bets ? (state.totals.edge * 100).toFixed(3) + '%' : '—';

  const p = state.player;
  if (p) {
    $('p-balance').textContent = bits(p.balanceSat);
    $('p-bets').textContent = p.stats.bets.toLocaleString();
    $('p-net').textContent = bits(p.stats.netSat);
    $('p-net').style.color = p.stats.netSat >= 0 ? 'var(--win)' : 'var(--loss)';
    $('p-wins').textContent = p.stats.bets ? ((p.stats.wins / p.stats.bets) * 100).toFixed(1) + '%' : '—';
    $('p-nonce').textContent = p.nonce;
    $('p-commit').textContent = p.serverSeedHash;
    if (document.activeElement !== $('p-client')) $('p-client').value = p.clientSeed;

    $('revealed').innerHTML = p.revealed.length
      ? p.revealed.map((r) =>
          `<div style="margin-bottom:6px">pair #${p.revealed.indexOf(r) + 1} <span class="mono">${r.serverSeed}</span></div>`,
        ).join('')
      : 'none yet — rotate your seed to reveal one';
  }

  $('feed').innerHTML = state.feed.map((b) => `
    <tr>
      <td>${b.playerName}</td>
      <td>${(b.amountSat / SAT_PER_BIT).toLocaleString()}</td>
      <td>${b.target.toFixed(2)}x</td>
      <td class="${b.won ? 'win' : 'loss'}"><b>${b.multiplier.toFixed(2)}x</b></td>
      <td class="${b.won ? 'win' : 'loss'}">${b.won ? '+' : '−'}${Math.abs(b.profitSat / SAT_PER_BIT).toLocaleString()}</td>
    </tr>`).join('');
}

async function refresh() {
  let state = await api(`/api/state?playerId=${PLAYER_ID}`);
  // No such player yet (fresh store, or a reset one) — create one and remember it.
  if (!state.player) {
    const created = await api('/api/players', { name: 'player' });
    if (created.player) {
      PLAYER_ID = created.player.id;
      localStorage.setItem('pfPlayerId', String(PLAYER_ID));
      state = await api(`/api/state?playerId=${PLAYER_ID}`);
    }
  }
  render(state);
  await updatePreview();
}

// ── bet preview ────────────────────────────────────────────────────────────
async function updatePreview() {
  const target = currentTarget();
  $('target-label').textContent = target.toFixed(2) + 'x';
  $('winchance').textContent = ((0.99 / target) * 100).toFixed(2) + '%';

  const amt = Number($('amount').value) || 0;
  $('payout').textContent = bits(Math.floor(amt * SAT_PER_BIT * (target - 1) / 1) ) + ' profit';

  const mb = await api(`/api/maxbet?target=${target}`);
  $('maxbet').textContent = bits(mb.maxBetSat);
  $('amount').max = mb.maxBetBits;
}

// ── actions ────────────────────────────────────────────────────────────────
async function placeBet() {
  $('err').textContent = '';
  const body = { playerId: PLAYER_ID, amountBits: Number($('amount').value), target: currentTarget() };
  const out = await api('/api/bet', body);
  if (out.error) { $('err').textContent = out.error; return; }

  const b = out.bet;
  const el = $('result');
  el.style.display = 'block';
  el.className = 'result ' + (b.won ? 'win' : 'loss');
  $('res-mult').textContent = b.multiplier.toFixed(2) + 'x';
  $('res-detail').textContent =
    `${b.won ? 'WIN' : 'LOSS'} — ${b.won ? '+' : ''}${b.profitSat / SAT_PER_BIT} bits  ·  nonce ${b.nonce}`;

  // prefill the verifier with this bet's proof
  $('v-client').value = b.proof.clientSeed;
  $('v-nonce').value = b.proof.nonce;
  $('v-target').value = b.proof.target;

  render({ ...out.state, player: out.player });
}

async function rotate() {
  const out = await api('/api/rotate', { playerId: PLAYER_ID, clientSeed: $('p-client').value });
  if (out.error) { $('err').textContent = out.error; return; }
  $('v-seed').value = out.revealed.serverSeed;
  $('v-client').value = out.revealed.clientSeed;
  $('v-nonce').value = 0;
  render({ ...lastState, player: out.player });
  await refresh();
}

async function verify() {
  const serverSeed = $('v-seed').value.trim();
  const clientSeed = $('v-client').value;
  const nonce = Number($('v-nonce').value);
  const target = Number($('v-target').value);
  const report = $('v-report');

  if (!serverSeed) { report.innerHTML = '<div class="check fail">paste a revealed server seed first</div>'; return; }

  // (1) the math, recomputed locally
  let local;
  try {
    local = await computeOutcome(serverSeed, clientSeed, nonce);
  } catch (e) {
    report.innerHTML = `<div class="check fail">could not parse that server seed (${e.message})</div>`;
    return;
  }
  const commit = await sha256Hex(hexToBytes(serverSeed));

  // (2) did the house commit to this seed in advance? (needs server history)
  let committedBefore = false;
  try {
    const srv = await api('/api/verify', { playerId: PLAYER_ID, serverSeed, clientSeed, nonce, target });
    committedBefore = srv.ok === true;
  } catch { /* offline verify is still valid for the math */ }

  const shownCommit = $('p-commit').textContent.trim();
  const matchesShown = commit === shownCommit;

  report.innerHTML = `
    <div class="check ${local.multiplier >= target ? 'pass' : 'fail'}">
      recomputed multiplier: <b>${local.multiplier.toFixed(2)}x</b> vs target ${target.toFixed(2)}x
      → ${local.multiplier >= target ? 'WIN' : 'LOSS'}</div>
    <div class="check ${matchesShown || committedBefore ? 'pass' : 'fail'}">
      SHA256(server seed) matches the commitment published before betting</div>
    <div class="check pass">computed locally in your browser — the server was not asked for this number</div>`;
}

// ── wiring ─────────────────────────────────────────────────────────────────
$('target').addEventListener('input', updatePreview);
$('amount').addEventListener('input', updatePreview);
$('bet').addEventListener('click', placeBet);
$('rotate').addEventListener('click', rotate);
$('verify').addEventListener('click', verify);

document.querySelectorAll('[data-amt]').forEach((btn) => btn.addEventListener('click', async () => {
  const v = btn.dataset.amt;
  if (v === 'max') {
    const mb = await api(`/api/maxbet?target=${currentTarget()}`);
    $('amount').value = Math.max(1, Math.floor(mb.maxBetBits));
  } else {
    $('amount').value = Math.max(1, Math.round((Number($('amount').value) || 0) * Number(v)));
  }
  updatePreview();
}));

$('target').value = targetToSlider(2.0);
refresh();
setInterval(refresh, 4000);
