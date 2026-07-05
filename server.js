require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);   // correct client IPs for rate-limit behind tunnel/Caddy
const PORT = process.env.PORT || 3000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later' }
});
app.use(limiter);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ads', require('./routes/ads'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/inquiries', require('./routes/inquiries'));

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

// Initialize DB then start server
async function start() {
  const { getDb } = require('./database');
  await getDb();
  console.log('Database initialized');

  app.listen(PORT, () => {
    console.log(`Souq marketplace running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
