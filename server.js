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
