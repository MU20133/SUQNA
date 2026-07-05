const express = require('express');
const router = express.Router();

let dbs = null;
async function getDb() {
  if (!dbs) dbs = await require('../database').getDb();
  return dbs;
}

async function requireAdmin(req, res, next) {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account not active' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  try {
    const dbs = await getDb();
    const totalUsers = dbs.getSync('SELECT COUNT(*) as c FROM users').c;
    const totalAds = dbs.getSync('SELECT COUNT(*) as c FROM ads').c;
    const pendingAds = dbs.getSync("SELECT COUNT(*) as c FROM ads WHERE status = 'pending_review'").c;
    const approvedAds = dbs.getSync("SELECT COUNT(*) as c FROM ads WHERE status = 'approved'").c;
    const totalRevenue = dbs.getSync('SELECT COALESCE(SUM(amount), 0) as s FROM revenue').s;
    const merchants = dbs.getSync("SELECT COUNT(*) as c FROM users WHERE role LIKE '%merchant%'").c;
    const totalViews = dbs.getSync('SELECT COALESCE(SUM(views), 0) as s FROM ads').s;
    res.json({ totalUsers, totalAds, pendingAds, approvedAds, totalRevenue, merchants, totalViews });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/users', async (req, res) => {
  try {
    const dbs = await getDb();
    const { page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const users = dbs.allSync('SELECT id, name, role, city, wa, email, status, joined, freed FROM users ORDER BY joined DESC LIMIT ? OFFSET ?', [parseInt(limit), offset]);
    const total = dbs.getSync('SELECT COUNT(*) as c FROM users').c;
    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/toggle', async (req, res) => {
  try {
    const dbs = await getDb();
    const user = dbs.getSync('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot suspend admin' });

    const newStatus = user.status === 'suspended' ? 'active' : 'suspended';
    dbs.runSync('UPDATE users SET status = ? WHERE id = ?', [newStatus, user.id]);
    dbs.saveDb();
    res.json({ status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/approve-merchant', async (req, res) => {
  try {
    const dbs = await getDb();
    const user = dbs.getSync('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'merchant_app') return res.status(400).json({ error: 'User is not a merchant applicant' });

    dbs.runSync("UPDATE users SET role = 'merchant' WHERE id = ?", [user.id]);
    dbs.saveDb();
    res.json({ role: 'merchant' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/ads', async (req, res) => {
  try {
    const dbs = await getDb();
    const { status, page = 1, limit = 50 } = req.query;
    let sql = 'SELECT a.*, GROUP_CONCAT(ap.filename) as photos FROM ads a LEFT JOIN ad_photos ap ON ap.ad_id = a.id';
    const params = [];
    if (status) { sql += ' WHERE a.status = ?'; params.push(status); }
    sql += ' GROUP BY a.id ORDER BY a.created DESC';

    let countSql = 'SELECT COUNT(DISTINCT a.id) as c FROM ads a LEFT JOIN ad_photos ap ON ap.ad_id = a.id';
    if (status) countSql += ' WHERE a.status = ?';

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    sql += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const ads = dbs.allSync(sql, params);
    const countParams = status ? [status] : [];
    const total = dbs.getSync(countSql, countParams).c;

    res.json({ ads, total, page: parseInt(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ads/:id/status', async (req, res) => {
  try {
    const dbs = await getDb();
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    dbs.runSync('UPDATE ads SET status = ? WHERE id = ?', [status, ad.id]);
    if (status === 'approved') {
      const fee = dbs.getSync("SELECT value FROM admin_settings WHERE key = 'ad_publishing'");
      if (fee) {
        dbs.runSync('INSERT INTO revenue (amount, type, date) VALUES (?, ?, ?)', [parseInt(fee.value), 'ad_publishing', Date.now()]);
      }
    }
    dbs.saveDb();
    res.json({ status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ads/:id/feature', async (req, res) => {
  try {
    const dbs = await getDb();
    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const newVal = ad.featured ? 0 : 1;
    dbs.runSync('UPDATE ads SET featured = ? WHERE id = ?', [newVal, ad.id]);
    dbs.saveDb();
    res.json({ featured: newVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/settings', async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync('SELECT * FROM admin_settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const dbs = await getDb();
    const allowed = ['ad_publishing', 'featured', 'ad_appearance', 'highlight', 'mark_new', 'merchant_opening', 'commission_percent'];
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        dbs.runSync('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)', [key, String(value)]);
      }
    }
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/promos', async (req, res) => {
  try {
    const dbs = await getDb();
    const promos = dbs.allSync('SELECT * FROM promos');
    res.json(promos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/promos', async (req, res) => {
  try {
    const dbs = await getDb();
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    dbs.runSync('INSERT INTO promos (text) VALUES (?)', [text]);
    dbs.saveDb();
    res.status(201).json({ id: dbs.lastId(), text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/promos/:id', async (req, res) => {
  try {
    const dbs = await getDb();
    dbs.runSync('DELETE FROM promos WHERE id = ?', [req.params.id]);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/revenue', async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync('SELECT * FROM revenue ORDER BY date DESC LIMIT 200');
    const total = dbs.getSync('SELECT COALESCE(SUM(amount), 0) as s FROM revenue').s;
    res.json({ rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/codes', async (req, res) => {
  try {
    const dbs = await getDb();
    const codes = dbs.allSync('SELECT * FROM codes ORDER BY id DESC');
    res.json(codes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/codes', async (req, res) => {
  try {
    const dbs = await getDb();
    const { code, role } = req.body;
    if (!code || !role) return res.status(400).json({ error: 'Code and role required' });
    dbs.runSync('INSERT INTO codes (code, role) VALUES (?, ?)', [code, role]);
    dbs.saveDb();
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/codes/:id', async (req, res) => {
  try {
    const dbs = await getDb();
    dbs.runSync('DELETE FROM codes WHERE id = ?', [req.params.id]);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reset', async (req, res) => {
  try {
    const dbs = await getDb();
    const tables = ['user_engagements', 'conversation_messages', 'conversations', 'inquiry_messages', 'inquiries', 'ad_attachments', 'ad_photos', 'codes', 'revenue', 'promos', 'sessions', 'ads'];
    for (const t of tables) dbs.runSync(`DELETE FROM ${t}`);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
