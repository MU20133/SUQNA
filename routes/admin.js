const express = require('express');
const { requirePerm, requireSuperAdmin, hasPerm, PERMISSIONS } = require('../middleware/auth');
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
    if (user.role !== 'admin' && user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });

    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.use(requireAdmin);

router.get('/stats', requirePerm('reports'), async (req, res) => {
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

router.get('/users', requirePerm('users'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { page = 1, limit = 50 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const users = dbs.allSync('SELECT id, name, role, city, wa, email, status, joined, freed FROM users ORDER BY joined DESC LIMIT ? OFFSET ?', [parseInt(limit), offset]);
    const total = dbs.getSync('SELECT COUNT(*) as c FROM users').c;
    res.json({ users, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/toggle', requirePerm('users'), async (req, res) => {
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

router.put('/users/:id/approve-merchant', requirePerm('users'), async (req, res) => {
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

router.get('/ads', requirePerm('ads'), async (req, res) => {
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

router.put('/ads/:id/status', requirePerm('ads'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    dbs.runSync('UPDATE ads SET status = ? WHERE id = ?', [status, ad.id]);
    let confCode = ad.conf_code || null;
    if (status === 'approved') {
      const fee = dbs.getSync("SELECT value FROM admin_settings WHERE key = 'ad_publishing'");
      if (fee) {
        dbs.runSync('INSERT INTO revenue (amount, type, date) VALUES (?, ?, ?)', [parseInt(fee.value), 'ad_publishing', Date.now()]);
      }
      // Spec item 3: once the admin's check completes, a confirmation code is
      // issued and shown directly on the advertiser's page.
      if (!confCode) {
        confCode = String(Math.floor(100000 + Math.random() * 900000));
        dbs.runSync('UPDATE ads SET conf_code = ?, pay_status = ? WHERE id = ?', [confCode, 'success', ad.id]);
        dbs.runSync('INSERT INTO codes (code, role, user, used, ad_id, auto) VALUES (?, ?, ?, 0, ?, 1)',
          [confCode, 'ad', ad.owner || ad.seller, ad.id]);
      }
    }
    dbs.saveDb();
    res.json({ status, conf_code: confCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/ads/:id/feature', requirePerm('ads'), async (req, res) => {
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

router.get('/settings', requirePerm('content'), async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync('SELECT * FROM admin_settings');
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', requirePerm('content'), async (req, res) => {
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

router.get('/promos', requirePerm('content'), async (req, res) => {
  try {
    const dbs = await getDb();
    const promos = dbs.allSync('SELECT * FROM promos');
    res.json(promos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/promos', requirePerm('content'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    dbs.runSync('INSERT INTO promos (text) VALUES (?)', [text]);
    dbs.saveDb();
    res.status(201).json({ id: dbs.lastId(), text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/promos/:id', requirePerm('content'), async (req, res) => {
  try {
    const dbs = await getDb();
    dbs.runSync('DELETE FROM promos WHERE id = ?', [req.params.id]);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/revenue', requirePerm('reports'), async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync('SELECT * FROM revenue ORDER BY date DESC LIMIT 200');
    const total = dbs.getSync('SELECT COALESCE(SUM(amount), 0) as s FROM revenue').s;
    res.json({ rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/codes', requirePerm('billing'), async (req, res) => {
  try {
    const dbs = await getDb();
    const codes = dbs.allSync('SELECT * FROM codes ORDER BY id DESC');
    res.json(codes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/codes', requirePerm('billing'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { code, role } = req.body;
    if (!code || !role) return res.status(400).json({ error: 'Code and role required' });
    dbs.runSync('INSERT INTO codes (code, role) VALUES (?, ?)', [code, role]);
    dbs.saveDb();
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/codes/:id', requirePerm('billing'), async (req, res) => {
  try {
    const dbs = await getDb();
    dbs.runSync('DELETE FROM codes WHERE id = ?', [req.params.id]);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/codes/verify', requirePerm('billing'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { code, user } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const matches = dbs.allSync(
      'SELECT * FROM codes WHERE code = ? AND role = ? AND used = 0 ORDER BY id DESC',
      [code, 'merchant']
    );
    const match = matches.find(m => !m.user || m.user === user || m.user === '');
    if (!match) return res.status(400).json({ error: 'Incorrect or already-used code' });

    dbs.runSync('UPDATE codes SET used = 1 WHERE id = ?', [match.id]);
    dbs.saveDb();
    res.json({ ok: true, code: match.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reset', requireSuperAdmin, async (req, res) => {
  try {
    const dbs = await getDb();
    const tables = ['user_engagements', 'conversation_messages', 'conversations', 'inquiry_messages', 'inquiries', 'ad_attachments', 'ad_photos', 'codes', 'revenue', 'promos', 'sessions', 'ads'];
    for (const t of tables) dbs.runSync(`DELETE FROM ${t}`);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- who am I (drives which tabs the UI shows) ----------
router.get('/me', async (req, res) => {
  let perms = [];
  if (req.user.role === 'super_admin') perms = PERMISSIONS.slice();
  else { try { perms = JSON.parse(req.user.permissions || '[]'); } catch { perms = []; } }
  res.json({ name: req.user.name, role: req.user.role, permissions: perms });
});

// ---------- Team: super-admin manages sub-admins ----------
const bcrypt = require('bcryptjs');

function safeParse(v) { try { return JSON.parse(v || '[]'); } catch { return []; } }
function cleanPerms(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(k => PERMISSIONS.includes(k));
}

router.get('/team', requireSuperAdmin, async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync("SELECT id, name, role, status, permissions, joined FROM users WHERE role IN ('admin','super_admin') ORDER BY id ASC");
    res.json(rows.map(r => ({ ...r, permissions: safeParse(r.permissions) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team', requireSuperAdmin, async (req, res) => {
  try {
    const { name, password, permissions } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const perms = cleanPerms(permissions);
    const dbs = await getDb();
    if (dbs.getSync('SELECT id FROM users WHERE name = ?', [name])) return res.status(409).json({ error: 'Name already taken' });
    const salt = bcrypt.genSaltSync(12);
    const hash = bcrypt.hashSync(password, salt);
    dbs.runSync("INSERT INTO users (name, role, password_hash, salt, joined, status, permissions, age_confirmed) VALUES (?, 'admin', ?, ?, ?, 'active', ?, 1)",
      [name, hash, salt, Date.now(), JSON.stringify(perms)]);
    res.status(201).json({ id: dbs.lastId(), name, role: 'admin', permissions: perms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/team/:id', requireSuperAdmin, async (req, res) => {
  try {
    const dbs = await getDb();
    const target = dbs.getSync('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!target || target.role !== 'admin') return res.status(404).json({ error: 'Sub-admin not found' });
    const { permissions, status, password } = req.body;
    if (permissions !== undefined) dbs.runSync('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify(cleanPerms(permissions)), target.id]);
    if (status && ['active', 'suspended'].includes(status)) dbs.runSync('UPDATE users SET status = ? WHERE id = ?', [status, target.id]);
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      const salt = bcrypt.genSaltSync(12);
      dbs.runSync('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [bcrypt.hashSync(password, salt), salt, target.id]);
    }
    const u = dbs.getSync('SELECT id, name, role, status, permissions FROM users WHERE id = ?', [target.id]);
    res.json({ ...u, permissions: safeParse(u.permissions) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/team/:id', requireSuperAdmin, async (req, res) => {
  try {
    const dbs = await getDb();
    const target = dbs.getSync('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
    if (!target || target.role !== 'admin') return res.status(404).json({ error: 'Sub-admin not found (super admins cannot be deleted here)' });
    dbs.runSync('DELETE FROM sessions WHERE user_id = ?', [target.id]);
    dbs.runSync('DELETE FROM users WHERE id = ?', [target.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Verification & security area ----------
router.get('/verifications', requirePerm('verification'), async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync("SELECT id, name, role, wa, email, id_proof_file, id_verified FROM users WHERE id_proof_file != '' ORDER BY id_verified ASC, id DESC");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/verifications/:id', requirePerm('verification'), async (req, res) => {
  try {
    const dbs = await getDb();
    const approve = req.body.approve ? 1 : 0;
    dbs.runSync('UPDATE users SET id_verified = ? WHERE id = ?', [approve, req.params.id]);
    res.json({ ok: true, id_verified: approve });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Support & disputes area ----------
router.get('/tickets', requirePerm('support'), async (req, res) => {
  try {
    const dbs = await getDb();
    const rows = dbs.allSync("SELECT * FROM tickets ORDER BY (status = 'open') DESC, id DESC LIMIT 200");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/tickets/:id', requirePerm('support'), async (req, res) => {
  try {
    const dbs = await getDb();
    const { status, admin_note } = req.body;
    if (status && ['open', 'closed'].includes(status)) dbs.runSync('UPDATE tickets SET status = ? WHERE id = ?', [status, req.params.id]);
    if (admin_note !== undefined) dbs.runSync('UPDATE tickets SET admin_note = ? WHERE id = ?', [admin_note, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;

