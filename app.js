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
  roundTimes: new Map(),    // round id → ms timestamp it was counted
  entries: new Map(),       // user_id → [ms timestamps, one per round entered]
  names: new Map(),         // user_id → username (persisted cache)
  pendingNames: [],         // ids awaiting resolution
  resolving: false,
  allRooms: [],             // last rooms payload, for links + the streamer card
};

const storeKey = () => `pal_${state.room?.id}`;

function saveLocal() {
  if (!state.room) return;
  localStorage.setItem(storeKey(), JSON.stringify({
    seenRounds: [...state.seenRounds],
    roundTimes: [...state.roundTimes],
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
      state.roundTimes = new Map(s.roundTimes || []);
      // Legacy saves have round ids but no times — stamp them at load too, so
      // the "rounds seen" stat doesn't read 0 the moment a window is picked.
      if (!state.roundTimes.size) {
        for (const id of state.seenRounds) state.roundTimes.set(id, Date.now());
      }
      // Saves from before the live-window feature stored a plain count per user.
      // Migrate them to timestamps at load time so nothing silently disappears
      // the first time someone picks a window — they just start ageing from now.
      const now = Date.now();
      state.entries = new Map((s.entries || []).map(([uid, v]) =>
        [uid, Array.isArray(v) ? v : Array(v).fill(now)]));
    } else {
      state.seenRounds = new Set();
      state.roundTimes = new Map();
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
    state.allRooms = d.results || [];
    const live = state.allRooms.filter(r => r.stream_status === 'online');
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
  const full = state.allRooms.find(r => r.id === id);
  state.room = { id, name: sel.selectedOptions[0].dataset.name, ...(full || {}) };
  $('copy-link').disabled = false;
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
      const now = Date.now();
      state.seenRounds.add(round.id);
      state.roundTimes.set(round.id, now);
      for (const uid of round.bet_round_user_ids || []) {
        const ts = state.entries.get(uid) || [];
        ts.push(now);
        state.entries.set(uid, ts);
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

/* ---- Live window ------------------------------------------------------- */
/* Bill, 2026-08-18: a rolling window so a giveaway only counts people who are
   actually still in the room. There is deliberately NO "all time" — a draw is
   for people who are here now, and an all-time option invites forgetting the
   window is on. Entries age out on their own and the roster re-renders on a
   timer, so what you see is always current. */
const WINDOWS = [
  { v: 5*60e3,  label: '5 min'  },
  { v: 10*60e3, label: '10 min' },
  { v: 15*60e3, label: '15 min' },
  { v: 30*60e3, label: '30 min' },
  { v: 60*60e3, label: '1 hour' },
];
const DEFAULT_WINDOW = 15*60e3;
const WINDOW_KEY = 'pal-live-window';
let windowTimer = null;

function getWindow() {
  const v = Number(localStorage.getItem(WINDOW_KEY));
  return WINDOWS.some(w => w.v === v) ? v : DEFAULT_WINDOW;
}

function setWindow(ms) {
  localStorage.setItem(WINDOW_KEY, String(ms));
  clearInterval(windowTimer);
  windowTimer = setInterval(renderRoster, 10000);
  renderRoster();
}

function initWindow() {
  const sel = $('window-select');
  sel.innerHTML = WINDOWS.map(w => `<option value="${w.v}">${w.label}</option>`).join('');
  sel.value = String(getWindow());
  sel.addEventListener('change', () => setWindow(Number(sel.value)));
  setWindow(getWindow());
}

/* The roster, after the window is applied. `n` is entries still inside it. */
function liveRoster() {
  const cutoff = Date.now() - getWindow();
  const out = [];
  for (const [uid, times] of state.entries) {
    const n = times.filter(t => t >= cutoff).length;
    if (n > 0) out.push({ uid, n, name: state.names.get(uid) || '…' });
  }
  return out.sort((a, b) => b.n - a.n);
}

function liveRoundCount() {
  const cutoff = Date.now() - getWindow();
  let c = 0;
  for (const t of state.roundTimes.values()) if (t >= cutoff) c++;
  return c;
}

/* The clock time of the oldest spin still inside the window — so a streamer can
   say out loud exactly how far back the draw reaches, instead of doing the
   arithmetic in their head while live. */
function oldestLiveTime() {
  const cutoff = Date.now() - getWindow();
  let oldest = Infinity;
  for (const times of state.entries.values()) {
    for (const t of times) if (t >= cutoff && t < oldest) oldest = t;
  }
  return oldest === Infinity ? null : new Date(oldest);
}

function renderRoster() {
  const roster = liveRoster();
  $('stat-rounds').textContent = liveRoundCount();
  $('stat-players').textContent = roster.length;
  $('stat-entries').textContent = roster.reduce((s, r) => s + r.n, 0);
  $('roster').innerHTML = roster.map(r =>
    `<li><span class="r-name">${escapeHtml(r.name)}</span><span class="r-count">${r.n}</span></li>`).join('');
  $('draw-btn').disabled = roster.length === 0;

  $('obs-num').textContent = roster.length;
  $('obs-window').textContent = (WINDOWS.find(w => w.v === getWindow()) || {}).label || '';

  const since = oldestLiveTime();
  $('window-since').textContent = since
    ? `counting spins back to ${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`
    : 'no spins in this window yet';
}

// Copy the roster as plain text — one name per line. Weighted repeats each
// name by rounds played (paste-ready for wheel-of-names style sites), so
// streamers can use this page purely as a name feed for their own display.
async function copyList(weighted) {
  const lines = [];
  for (const r of liveRoster()) {
    const name = state.names.get(r.uid) || r.uid.slice(0, 8);
    for (let i = 0; i < (weighted ? r.n : 1); i++) lines.push(name);
  }
  if (!lines.length) return;
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    const el = $('copy-done');
    el.textContent = `copied ${lines.length} ${weighted ? 'entries' : 'names'} ✓`;
    setTimeout(() => { el.textContent = ''; }, 2500);
  } catch {
    const el = $('copy-done');
    el.textContent = 'copy blocked — select the list manually';
    setTimeout(() => { el.textContent = ''; }, 3500);
  }
}

// Reset arms itself instead of raising a browser confirm() — a native modal
// steals focus and, on a live stream, blocks everything behind it until it's
// dismissed. Click once to arm, again within 4s to clear; it disarms on its own.
let resetArmed = null;

function resetEntries() {
  const btn = $('reset-entries');
  if (!resetArmed) {
    btn.textContent = 'Tap again to clear';
    btn.classList.add('armed');
    resetArmed = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  state.seenRounds = new Set();
  state.roundTimes = new Map();
  state.entries = new Map();
  saveLocal();
  renderRoster();
  const el = $('copy-done');
  el.textContent = 'entries cleared';
  setTimeout(() => { el.textContent = ''; }, 2500);
}

function disarmReset() {
  clearTimeout(resetArmed);
  resetArmed = null;
  const btn = $('reset-entries');
  btn.textContent = 'Reset';
  btn.classList.remove('armed');
}

// ── step 3: the draw (VQS-style opposite scrolling names) ────────────────
/* ---- OBS overlay mode (?obs=1) -----------------------------------------
   A streamer keeps the control page on their second monitor and puts this same
   URL + &obs=1 into an OBS browser source. The overlay never has its own
   opinion about who won — the control tab broadcasts the result through
   localStorage and the overlay just performs it. Two pages disagreeing about a
   winner on stream is the one failure that can't be walked back. */
const DRAW_CH = 'pal-draw';
const isOBS  = () => new URLSearchParams(location.search).has('obs');
const isDock = () => new URLSearchParams(location.search).has('dock');

/* The DOCK is the other half of the pair: the same page in "controls only"
   form, added to OBS as a Custom Browser Dock. Dock and overlay then live in
   the SAME OBS browser profile, which is what lets them share localStorage —
   the sync will NOT work between an OBS browser source and a separate Chrome
   window, because those are different profiles. Both go in OBS. */
function initDock() {
  if (!isDock()) return;
  document.body.classList.add('dock');
  $('track-step').classList.remove('hidden');
  $('draw-step').classList.remove('hidden');
  document.querySelector('#track-step h2').textContent = 'Entries';
  document.querySelector('#draw-step h2').textContent = '';
}

/* The overlay re-reads the control page's saved state whenever it changes, and
   on a slow tick as a safety net in case a storage event is missed. */
function mirrorControlTab() {
  window.addEventListener('storage', (e) => {
    if (!state.room || e.key !== `pal_${state.room.id}`) return;
    loadLocal();
    renderRoster();
  });
  setInterval(() => { loadLocal(); renderRoster(); }, 5000);
}

function initOBS() {
  if (!isOBS()) return;
  document.body.classList.add('obs');
  document.querySelector('#track-step h2').textContent = 'Giveaway entries';
  $('track-step').classList.remove('hidden');
  // Mirror whatever the control tab draws.
  window.addEventListener('storage', (e) => {
    if (e.key !== DRAW_CH || !e.newValue) return;
    try {
      const { name } = JSON.parse(e.newValue);
      if (name) performReveal(name);
    } catch { /* ignore a malformed broadcast rather than break the stream */ }
  });
}

function drawWinner() {
  const weighted = $('weighted-toggle').checked;
  const pool = [];
  for (const r of liveRoster()) pool.push(...Array(weighted ? r.n : 1).fill(r.uid));
  if (!pool.length) return;
  const winnerUid = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
  const winnerName = state.names.get(winnerUid) || winnerUid.slice(0, 8);

  if (!isOBS()) localStorage.setItem(DRAW_CH, JSON.stringify({ name: winnerName, at: Date.now() }));
  // The dock is a control strip, not a stage — the reveal belongs on the
  // overlay. Show the winner inline instead so the streamer can read it.
  if (isDock()) {
    const el = $('dock-winner');
    el.textContent = `🎉 ${winnerName}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 15000);
    return;
  }
  performReveal(winnerName);
}

/* The full-screen reveal. Split out so the OBS overlay can run exactly the
   same moment the control tab does, from a broadcast rather than its own draw. */
function performReveal(winnerName) {
  // Fill both side columns with the roster, shuffled differently, looped for
  // seamless scroll. Left scrolls up, right scrolls down (CSS handles motion).
  // Prefer the live roster; if the window has emptied, fall back to every name
  // we know so the columns still scroll. A reveal with two names in it looks
  // broken on stream even when the winner is correct.
  let names = liveRoster().map(r => r.name === '…' ? r.uid.slice(0, 8) : r.name);
  if (names.length < 8) {
    const extra = [...state.names.values()].filter(n => !names.includes(n));
    names = [...names, ...extra];
  }
  if (!names.length) names = [winnerName];
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
  // Tick count and the ramp set the total length. SLOW is the original v0 feel
  // (~6s); NORMAL and FAST were added 2026-08-18 so a streamer can match the
  // moment — a long build for a big prize, a quick one for rapid-fire draws.
  // FAST is the default (Bill): most draws are rapid-fire, and a streamer who
  // wants the long build for a big prize can reach for it deliberately.
  const { ticks, base, ramp } = SPEEDS[getSpeed()];
  let t = 0;
  const spin = () => {
    t += 1;
    drum.textContent = names[Math.floor(Math.random() * names.length)];
    if (t < ticks) setTimeout(spin, base + t * ramp);
    else {
      drum.classList.add('hidden');
      const w = $('winner-name');
      w.textContent = `🎉 ${winnerName} 🎉`;
      w.classList.remove('hidden');
      if (isOBS()) setTimeout(() => $('draw-overlay').classList.add('hidden'), 12000);
      else $('winner-close').classList.remove('hidden');
      confettiBurst();
    }
  };
  spin();
}

/* ---- Spin speed -------------------------------------------------------- */
/* ticks = how many names flash by; base+ramp = the slowdown curve, in ms.
   Rough totals: slow ~6.2s, normal ~2.7s, fast ~0.9s. scroll = the side
   columns' loop duration, kept in step so the whole moment reads as one speed. */
const SPEEDS = {
  slow:   { ticks: 40, base: 40, ramp: 6,   scroll: '14s' },
  normal: { ticks: 32, base: 28, ramp: 3.5, scroll: '8s'  },
  fast:   { ticks: 24, base: 18, ramp: 1.6, scroll: '4s'  },
};
const SPEED_KEY = 'pal-spin-speed';

function getSpeed() {
  const v = localStorage.getItem(SPEED_KEY);
  return SPEEDS[v] ? v : 'fast';
}

function setSpeed(v) {
  if (!SPEEDS[v]) return;
  localStorage.setItem(SPEED_KEY, v);
  document.documentElement.style.setProperty('--scroll-dur', SPEEDS[v].scroll);
  document.querySelectorAll('.speed-opt').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.speed === v));
  });
}

function initSpeed() {
  document.querySelectorAll('.speed-opt').forEach(b => {
    b.addEventListener('click', () => setSpeed(b.dataset.speed));
  });
  setSpeed(getSpeed());
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

/* ---- Streamer link (?r=slug) -------------------------------------------
   A streamer drops ONE link in chat and the page opens on their room wearing
   their name and face. Step 1 disappears — nobody has to find them in a list.
   Same instinct as naming the players: the room's own people come first.
   Offline rooms still resolve, so the link keeps working between streams. */

const roomLink = (room) =>
  `${location.origin}${location.pathname}?r=${encodeURIComponent(room.url_path || room.id)}`;

function renderStreamerCard(room) {
  const live = room.stream_status === 'online';
  const chip = (label, val) => val == null ? '' :
    `<span class="chip"><b>${escapeHtml(String(val))}</b> ${label}</span>`;

  const card = $('streamer-card');
  if (room.stream_thumbnail) card.style.setProperty('--shot', `url("${room.stream_thumbnail}")`);
  card.classList.toggle('has-shot', !!room.stream_thumbnail);

  card.innerHTML = `
    <div class="streamer-inner">
      ${room.avatar ? `<div class="av-wrap ${live ? 'is-live' : ''}"><img src="${escapeHtml(room.avatar)}" alt=""></div>` : ''}
      <div class="streamer-who">
        <div class="streamer-name">
          ${escapeHtml(room.name)}
          ${room.is_creator_verified ? '<span class="verified" title="Verified creator">✔</span>' : ''}
          ${live ? '<span class="live-pill"><i></i>LIVE</span>' : '<span class="off-pill">offline</span>'}
        </div>
        ${live && room.stream_title ? `<div class="streamer-title">${escapeHtml(room.stream_title)}</div>` : ''}
        <div class="chips">
          ${chip('followers', room.follower_count != null ? Number(room.follower_count).toLocaleString() : null)}
          ${live ? chip('watching', room.current_user_count != null ? Number(room.current_user_count).toLocaleString() : null) : ''}
          ${room.last_igame_played_name ? `<span class="chip game">${room.last_igame_played_image ? `<img src="${escapeHtml(room.last_igame_played_image)}" alt="">` : ''}${escapeHtml(room.last_igame_played_name)}</span>` : ''}
        </div>
      </div>
      ${room.url_path ? `<a class="watch" target="_blank" rel="noopener"
          href="https://myprize.us/${encodeURIComponent(room.url_path)}">${live ? 'Watch live' : 'Visit room'} ↗</a>` : ''}
    </div>`;
  card.classList.remove('hidden');

  $('title').innerHTML = `${escapeHtml(room.name)}<span class="accent">'s Giveaway</span>`;
  $('tagline').innerHTML =
    `Play along in the room and you're in the draw. <button class="switch-room" id="switch-room">not ${escapeHtml(room.name)}? pick another room</button>`;
  document.title = `${room.name} · Play-Along Live`;
  $('room-step').classList.add('hidden');
  if (isOBS()) {
    document.querySelector('#track-step h2').textContent = `${room.name}'s Giveaway`;
  } else {
    showStreamLinks(room);
  }
  $('switch-room').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    location.reload();
  });
}

/* Resolve ?r= against the rooms list. Paged so an offline room deep in the
   list still resolves — the link has to survive between streams. */
async function applyStreamerLink() {
  const want = new URLSearchParams(location.search).get('r')
            || new URLSearchParams(location.search).get('room');
  if (!want) return false;
  const key = want.toLowerCase();
  for (let page = 1; page <= 4; page++) {
    let d;
    try { d = await fetch(`${API}/rooms?page=${page}&page_size=100`).then(r => r.json()); }
    catch { break; }
    const rooms = d.results || [];
    if (!rooms.length) break;
    state.allRooms = [...state.allRooms, ...rooms];
    const hit = rooms.find(r =>
      (r.url_path || '').toLowerCase() === key ||
      r.id === want ||
      (r.name || '').toLowerCase() === key);
    if (hit) {
      state.room = { ...hit };
      renderStreamerCard(hit);
      loadLocal();
      $('track-step').classList.remove('hidden');
      $('draw-step').classList.remove('hidden');
      renderRoster();
      // The overlay does NOT collect. It mirrors whatever the control page has
      // saved — two tabs polling independently drift apart, and an overlay that
      // disagrees with the dock about who is in the draw is worse than useless.
      if (isOBS()) mirrorControlTab();
      return true;
    }
  }
  // Unknown slug: say so rather than silently showing the generic page.
  $('tagline').textContent = `Couldn't find a room called "${want}" — pick one below.`;
  return false;
}

/* A streamer should never have to be told what to paste — show all three URLs
   with the exact place in OBS each one goes. */
function showStreamLinks(room) {
  const base = roomLink(room);
  $('url-obs').textContent = base + '&obs=1';
  $('url-dock').textContent = base + '&dock=1';
  $('stream-step').classList.remove('hidden');
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const txt = $(btn.dataset.copy).textContent;
      const el = $('stream-copied');
      try { await navigator.clipboard.writeText(txt); el.textContent = 'copied ✓'; }
      catch { el.textContent = 'select the link and copy it manually'; }
      setTimeout(() => { el.textContent = ''; }, 2500);
    });
  });
}

async function copyMyLink() {
  if (!state.room) return;
  const el = $('link-done');
  const url = roomLink(state.room);
  try {
    await navigator.clipboard.writeText(url);
    el.textContent = 'link copied ✓';
  } catch {
    el.textContent = url;
  }
  setTimeout(() => { el.textContent = ''; }, 4000);
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
$('copy-link').addEventListener('click', copyMyLink);
initDock();
initOBS();
initSpeed();
initWindow();
applyStreamerLink().then(found => { if (!found) loadRooms(); else loadRooms(); });
