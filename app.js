/* Play-Along Live — free static giveaway picker for any live MyPrize room.
 *
 * Design rules (Bill, 2026-08-02):
 *  - PUBLIC MyPrize endpoints ONLY (verified CORS-open from any origin):
 *      GET /api/rooms                          → live room dropdown (no typing!)
 *      GET /api/rooms/{id}/bet_round_metrics   → play-along rounds + participant ids
 *      GET /api/user/{id}                      → id → username
 *  - Zero signup, zero setup, zero backend: all state in this tab + localStorage.
 *  - Gentle on the API: one metrics poll / 5s while collecting; usernames cached
 *    forever; resolution trickled max 3/s.
 */

const API = 'https://myprize.us/api';
const POLL_MS = 5000;
const $ = (id) => document.getElementById(id);

// ── state ────────────────────────────────────────────────────────────────
const state = {
  room: null,               // { id, name, slug }
  collecting: false,
  pollTimer: null,
  seenRounds: new Set(),    // round ids already counted
  entries: new Map(),       // user_id → rounds participated
  names: new Map(),         // user_id → username (persisted cache)
  pendingNames: [],         // ids awaiting resolution
  resolving: false,
};

const storeKey = () => `pal_${state.room?.id}`;

function saveLocal() {
  if (!state.room) return;
  localStorage.setItem(storeKey(), JSON.stringify({
    seenRounds: [...state.seenRounds],
    entries: [...state.entries],
  }));
  localStorage.setItem('pal_names', JSON.stringify([...state.names]));
}

function loadLocal() {
  try {
    const names = JSON.parse(localStorage.getItem('pal_names') || '[]');
    state.names = new Map(names);
    const s = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (s) {
      state.seenRounds = new Set(s.seenRounds);
      state.entries = new Map(s.entries);
    } else {
      state.seenRounds = new Set();
      state.entries = new Map();
    }
  } catch { /* fresh start beats a broken save */ }
}

// ── step 1: live rooms dropdown ──────────────────────────────────────────
async function loadRooms() {
  const sel = $('room-select');
  sel.disabled = true;
  sel.innerHTML = '<option>Loading live rooms…</option>';
  try {
    const d = await fetch(`${API}/rooms?page=1&page_size=100`).then(r => r.json());
    const live = (d.results || []).filter(r => r.stream_status === 'online');
    sel.innerHTML = '<option value="">— pick a live room —</option>' +
      live.map(r => `<option value="${r.id}" data-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}${r.stream_title ? ' — ' + escapeHtml(r.stream_title).slice(0, 40) : ''}</option>`).join('');
    sel.disabled = false;
    if (!live.length) sel.innerHTML = '<option value="">no rooms live right now — hit ↻ later</option>';
  } catch {
    sel.innerHTML = '<option value="">could not reach MyPrize — hit ↻</option>';
  }
}

function pickRoom() {
  const sel = $('room-select');
  const id = sel.value;
  if (!id) return;
  stopCollecting();
  state.room = { id, name: sel.selectedOptions[0].dataset.name };
  loadLocal();
  $('track-step').classList.remove('hidden');
  $('draw-step').classList.remove('hidden');
  renderRoster();
}

// ── step 2: collect entries from rounds ──────────────────────────────────
function startCollecting() {
  if (!state.room || state.collecting) return;
  state.collecting = true;
  $('track-toggle').textContent = '⏸ Pause';
  $('entry-status').textContent = '· live';
  poll();
  state.pollTimer = setInterval(poll, POLL_MS);
}

function stopCollecting() {
  state.collecting = false;
  clearInterval(state.pollTimer);
  $('track-toggle').textContent = '▶ Start collecting entries';
  $('entry-status').textContent = '';
}

async function poll() {
  try {
    const d = await fetch(`${API}/rooms/${state.room.id}/bet_round_metrics`).then(r => r.json());
    // Count each COMPLETED round once; every participant earns one entry.
    for (const round of [d.last_round, d.active_round]) {
      if (!round || round.status !== 'complete' || state.seenRounds.has(round.id)) continue;
      state.seenRounds.add(round.id);
      for (const uid of round.bet_round_user_ids || []) {
        state.entries.set(uid, (state.entries.get(uid) || 0) + 1);
        if (!state.names.has(uid)) state.pendingNames.push(uid);
      }
    }
    resolveNames();
    saveLocal();
    renderRoster();
  } catch { $('entry-status').textContent = '· reconnecting…'; }
}

// Trickle username resolution: max ~3/s, cached forever.
async function resolveNames() {
  if (state.resolving) return;
  state.resolving = true;
  while (state.pendingNames.length) {
    const uid = state.pendingNames.shift();
    if (state.names.has(uid)) continue;
    try {
      const u = await fetch(`${API}/user/${uid}`).then(r => r.json());
      state.names.set(uid, u.username || uid.slice(0, 8));
      renderRoster();
    } catch { state.pendingNames.push(uid); break; }
    await new Promise(res => setTimeout(res, 350));
  }
  state.resolving = false;
  saveLocal();
}

function renderRoster() {
  const roster = [...state.entries.entries()]
    .map(([uid, n]) => ({ uid, n, name: state.names.get(uid) || '…' }))
    .sort((a, b) => b.n - a.n);
  $('stat-rounds').textContent = state.seenRounds.size;
  $('stat-players').textContent = roster.length;
  $('stat-entries').textContent = roster.reduce((s, r) => s + r.n, 0);
  $('roster').innerHTML = roster.map(r =>
    `<li><span class="r-name">${escapeHtml(r.name)}</span><span class="r-count">${r.n}</span></li>`).join('');
  $('draw-btn').disabled = roster.length === 0;
}

// Copy the roster as plain text — one name per line. Weighted repeats each
// name by rounds played (paste-ready for wheel-of-names style sites), so
// streamers can use this page purely as a name feed for their own display.
async function copyList(weighted) {
  const lines = [];
  for (const [uid, n] of state.entries) {
    const name = state.names.get(uid) || uid.slice(0, 8);
    for (let i = 0; i < (weighted ? n : 1); i++) lines.push(name);
  }
  if (!lines.length) return;
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    const el = $('copy-done');
    el.textContent = `copied ${lines.length} ${weighted ? 'entries' : 'names'} ✓`;
    setTimeout(() => { el.textContent = ''; }, 2500);
  } catch { alert('Copy blocked by browser — select the list manually.'); }
}

function resetEntries() {
  if (!confirm('Clear all collected entries for this room?')) return;
  state.seenRounds = new Set();
  state.entries = new Map();
  saveLocal();
  renderRoster();
}

// ── step 3: the draw (VQS-style opposite scrolling names) ────────────────
function drawWinner() {
  const weighted = $('weighted-toggle').checked;
  const pool = [];
  for (const [uid, n] of state.entries) pool.push(...Array(weighted ? n : 1).fill(uid));
  if (!pool.length) return;
  const winnerUid = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
  const winnerName = state.names.get(winnerUid) || winnerUid.slice(0, 8);

  // Fill both side columns with the roster, shuffled differently, looped for
  // seamless scroll. Left scrolls up, right scrolls down (CSS handles motion).
  const names = [...state.entries.keys()].map(u => state.names.get(u) || u.slice(0, 8));
  const fill = (el, list) => {
    const loop = [...list, ...list, ...list];
    el.innerHTML = loop.map(n => `<div class="scroll-name">${escapeHtml(n)}</div>`).join('');
  };
  fill($('scroll-left'), shuffle([...names]));
  fill($('scroll-right'), shuffle([...names]));

  $('draw-overlay').classList.remove('hidden');
  $('winner-name').classList.add('hidden');
  $('winner-close').classList.add('hidden');
  const drum = $('winner-drum');
  drum.classList.remove('hidden');

  // Drum-roll: cycle random names fast, slow down, land on the winner.
  let t = 0;
  const spin = () => {
    t += 1;
    drum.textContent = names[Math.floor(Math.random() * names.length)];
    if (t < 40) setTimeout(spin, 40 + t * 6);
    else {
      drum.classList.add('hidden');
      const w = $('winner-name');
      w.textContent = `🎉 ${winnerName} 🎉`;
      w.classList.remove('hidden');
      $('winner-close').classList.remove('hidden');
      confettiBurst();
    }
  };
  spin();
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function confettiBurst() {
  for (let i = 0; i < 80; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.animationDelay = Math.random() * 0.8 + 's';
    c.style.background = `hsl(${Math.random() * 360},90%,60%)`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

// ── wire up ──────────────────────────────────────────────────────────────
$('room-select').addEventListener('change', pickRoom);
$('room-refresh').addEventListener('click', loadRooms);
$('track-toggle').addEventListener('click', () => state.collecting ? stopCollecting() : startCollecting());
$('reset-entries').addEventListener('click', resetEntries);
$('copy-names').addEventListener('click', () => copyList(false));
$('copy-weighted').addEventListener('click', () => copyList(true));
$('draw-btn').addEventListener('click', drawWinner);
$('winner-close').addEventListener('click', () => $('draw-overlay').classList.add('hidden'));
loadRooms();
