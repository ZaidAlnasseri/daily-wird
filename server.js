const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const STATE_KEY = 'wird:state';
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || process.env.RENDER_KEY_VALUE_URL || '';

// ---- storage: Redis-compatible key-value store, with an in-memory
// fallback so the app still runs (non-persistently) if no store is
// configured yet, e.g. during local development. ----
let redisClient = null;
let memoryFallback = null; // string | null

async function getStore() {
  if (!REDIS_URL) {
    if (!memoryFallbackWarned) {
      console.warn('[wird] REDIS_URL not set — using a non-persistent in-memory store.');
      memoryFallbackWarned = true;
    }
    return null;
  }
  if (redisClient) return redisClient;
  const { createClient } = require('redis');
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('error', (err) => console.error('[wird] redis error', err));
  await redisClient.connect();
  return redisClient;
}
let memoryFallbackWarned = false;

async function readState() {
  const client = await getStore();
  if (!client) return memoryFallback ? JSON.parse(memoryFallback) : null;
  const raw = await client.get(STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function writeState(state) {
  const json = JSON.stringify(state);
  const client = await getStore();
  if (!client) { memoryFallback = json; return; }
  await client.set(STATE_KEY, json);
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
