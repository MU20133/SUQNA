require('dotenv').config();
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const fs = require('fs');
// Guard uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.set('trust proxy', 1);   // correct client IPs for rate-limit behind tunnel/Caddy
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

app.use(compression());   // gzip every response (HTML/JSON shrink ~70-85%)
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Uploaded images never change under the same name -> long cache.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/inquiries', require('./routes/inquiries'));

// Public fees endpoint (no auth needed — used to display current publishing fee)
app.get('/api/settings/fees', async (req, res) => {
  try {
    const { getDb } = require('./database');
    const dbs = await getDb();
    const rows = dbs.allSync('SELECT * FROM admin_settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public promos endpoint (no auth)
app.get('/api/promos', async (req, res) => {
  try {
    const { getDb } = require('./database');
    const dbs = await getDb();
    const promos = dbs.allSync('SELECT * FROM promos');
    res.json(promos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve index.html for any unmatched route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Cloud-persistent SQLite: restore from Supabase on a fresh host, keep the
// cloud mirror fresh while running, and flush on shutdown. The engine and
// every query are unchanged — only the file's lifecycle is cloud-backed.
const backup = require('./scripts/backup');
const MIRROR_EVERY_MS = 5 * 60 * 1000;   // live cloud snapshot every 5 minutes
let shuttingDown = false;

async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — flushing DB to cloud…`);
  try { await backup.mirrorLive(); } catch (e) { console.error('[shutdown] mirror failed:', e.message); }
  process.exit(0);
}

// Initialize DB then start server
async function start() {
  // 1) Fresh/ephemeral host with no local DB? Pull the latest cloud snapshot.
  await backup.restoreOnBoot();

  const { getDb } = require('./database');
  await getDb();
  console.log('Database initialized');

  app.listen(PORT, () => {
    console.log(`Souq marketplace running on http://localhost:${PORT}`);
  });

  // 2) Keep a fresh full snapshot in the cloud while running.
  const supa = require('./services/supabase');
  if (supa.configured()) {
    setInterval(() => { backup.mirrorLive().catch(() => {}); }, MIRROR_EVERY_MS).unref();
    await backup.mirrorLive().catch(() => {});   // initial mirror right after boot
    console.log('[cloud] live mirror active (every 5 min + on shutdown)');
  }

  // 3) Flush to cloud on graceful stop (PM2 restart, host redeploy, Ctrl+C).
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
  process.on('SIGINT', () => gracefulExit('SIGINT'));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
