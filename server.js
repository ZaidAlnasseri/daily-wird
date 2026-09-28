const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---- storage: Postgres (Render's managed instance), with an in-memory
// fallback so the app still runs (non-persistently) if no database is
// configured yet, e.g. during local development. ----
let pool = null;
let ready = null; // promise that resolves once the table exists
let memoryFallback = null; // object | null
let memoryFallbackWarned = false;

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function ensureReady() {
  const p = getPool();
  if (!p) {
    if (!memoryFallbackWarned) {
      console.warn('[wird] DATABASE_URL not set — using a non-persistent in-memory store.');
      memoryFallbackWarned = true;
    }
    return null;
  }
  if (!ready) {
    ready = p.query(
      `CREATE TABLE IF NOT EXISTS wird_state (
         id INT PRIMARY KEY DEFAULT 1,
         data JSONB NOT NULL,
         CONSTRAINT single_row CHECK (id = 1)
       )`
    );
  }
  await ready;
  return p;
}

async function readState() {
  const p = await ensureReady();
  if (!p) return memoryFallback;
  const { rows } = await p.query('SELECT data FROM wird_state WHERE id = 1');
  return rows.length ? rows[0].data : null;
}

async function writeState(state) {
  const p = await ensureReady();
  if (!p) { memoryFallback = state; return; }
  await p.query(
    `INSERT INTO wird_state (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [state]
  );
}

// ---- API ----
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- helpers shared with the client's own logic (public/index.html) ----
const UAE_TZ = 'Asia/Dubai';

// Must stay in sync with DAY_ROLLOVER_HOUR in public/index.html — the "wird
// day" rolls over at 3am Dubai time, not midnight.
const DAY_ROLLOVER_HOUR = 3;

function todayKeyServer() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: UAE_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const rolledNow = new Date(Date.now() - DAY_ROLLOVER_HOUR * 60 * 60 * 1000);
  return fmt.format(rolledNow);
}

// Must stay byte-for-byte identical to seededPick() in public/index.html so
// the widget/shortcut and the web app always agree on "today's minimum".
function seededPick(seedStr, n) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) { h = (h * 31 + seedStr.charCodeAt(i)) >>> 0; }
  return h % n;
}

// Lightweight, read-only endpoint for the iOS Shortcuts home-screen widget:
// today's minimum wird + whether each of you has checked it off yet.
app.get('/api/minimum', async (req, res) => {
  try {
    const state = await readState();
    if (!state || !Array.isArray(state.tasks) || !state.tasks.length) {
      return res.json({ ok: true, ready: false, message: 'لم يتم إعداد التطبيق بعد' });
    }
    const today = todayKeyServer();
    const day = (state.days && state.days[today]) || null;
    const minimumId = (day && day.minimumId != null)
      ? day.minimumId
      : state.tasks[seededPick(today, state.tasks.length)].id;
    const task = state.tasks.find(t => t.id === minimumId) || state.tasks[0];
    const names = state.names || {};
    const meDone = !!(day && day.me && day.me.checked && day.me.checked[minimumId]);
    const herDone = !!(day && day.her && day.her.checked && day.her.checked[minimumId]);

    res.json({
      ok: true,
      ready: true,
      date: today,
      task: task ? task.label : '',
      meName: names.me || '',
      herName: names.her || '',
      meDone,
      herDone,
      bothDone: meDone && herDone
    });
  } catch (err) {
    console.error('[wird] minimum failed', err);
    res.status(500).json({ ok: false, error: 'minimum_failed' });
  }
});

app.get('/api/state', async (req, res) => {
  try {
    const state = await readState();
    res.json({ ok: true, state });
  } catch (err) {
    console.error('[wird] read failed', err);
    res.status(500).json({ ok: false, error: 'read_failed' });
  }
});

app.post('/api/state', async (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }
  try {
    await writeState(state);
    res.json({ ok: true });
  } catch (err) {
    console.error('[wird] write failed', err);
    res.status(500).json({ ok: false, error: 'write_failed' });
  }
});

// SPA fallback: serve index.html for any other GET (no client routing used
// today, but harmless and future-proof).
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[wird] listening on ${PORT}`);
});
