const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
let dbs = null;
async function getDb() {
  if (!dbs) dbs = await require('../database').getDb();
  return dbs;
}

const SESSION_DAYS = 7;

async function createSession(userId) {
  const { runSync, saveDb } = await getDb();
  const id = uuidv4();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  runSync('INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)', [id, userId, expires]);
  saveDb();
  return id;
}

router.post('/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

    const { getSync, runSync, saveDb } = await getDb();
    const user = getSync('SELECT * FROM users WHERE name = ?', [name]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    if (user.lock_until && user.lock_until > Date.now()) {
      const minutes = Math.ceil((user.lock_until - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${minutes} minute(s)` });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? Date.now() + 900000 : null;
      runSync('UPDATE users SET failed_attempts = ?, lock_until = ? WHERE id = ?', [attempts, lockUntil, user.id]);
      saveDb();
      const msg = lockUntil ? 'Too many failed attempts. Account locked for 15 minutes.' : 'Invalid credentials';
      return res.status(401).json({ error: msg });
    }

    runSync('UPDATE users SET failed_attempts = 0, lock_until = NULL WHERE id = ?', [user.id]);
    saveDb();
    const sessionId = await createSession(user.id);

    res.json({
      sessionId,
      user: {
        id: user.id, name: user.name, role: user.role, city: user.city,
        wa: user.wa, email: user.email, dept: user.dept, status: user.status,
        freed: user.freed, store_logo: user.store_logo, store_cover: user.store_cover,
        store_bio: user.store_bio
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WhatsApp rule (spec): ONLY +<12 digits>, 00<12 digits> or 00<14 digits>.
function validWa(wa) {
  const d = String(wa).replace(/[\s\-()]/g, '');
  return /^\+\d{12}$/.test(d) || /^00\d{12}$/.test(d) || /^00\d{14}$/.test(d);
}
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e));

router.post('/register', async (req, res) => {
  try {
    const { name, password, email, wa, city, dept, role } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Contact: WhatsApp number or email is required, and must be valid.
    if (!wa && !email) return res.status(400).json({ error: 'WhatsApp number or email required' });
    if (wa && !validWa(wa)) return res.status(400).json({ error: 'Error in the WhatsApp number' });
    if (email && !validEmail(email)) return res.status(400).json({ error: 'Invalid email address' });

    // Role whitelist — 'admin' can never be self-assigned.
    const roleMap = { buyer: 'buyer', seller: 'seller', merchant: 'merchant_app' };
    const safeRole = roleMap[role] || 'buyer';

    const { getSync, runSync, lastId, saveDb } = await getDb();
    const existing = getSync('SELECT id FROM users WHERE name = ?', [name]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    const waNorm = wa ? String(wa).replace(/[\s\-()]/g, '') : '';
    if (waNorm && getSync('SELECT id FROM users WHERE wa = ?', [waNorm]))
      return res.status(409).json({ error: 'That WhatsApp number is already registered' });
    if (email && getSync('SELECT id FROM users WHERE email = ? AND email != ?', [String(email).toLowerCase(), '']))
      return res.status(409).json({ error: 'That email is already registered' });

    const salt = bcrypt.genSaltSync(12);
    const password_hash = bcrypt.hashSync(password, salt);
    const joined = Date.now();

    runSync(`INSERT INTO users (name, email, wa, city, dept, role, password_hash, salt, joined, contact_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        name, email ? String(email).toLowerCase() : '', waNorm, city || '', dept || '',
        safeRole, password_hash, salt, joined, waNorm ? 'wa' : 'email'
    ]);
    saveDb();

    // Find the inserted user by name (more reliable than last_insert_rowid)
    const user = getSync('SELECT id, name, role, city, wa, email, dept, status FROM users WHERE name = ?', [name]);
    if (!user) return res.status(500).json({ error: 'Failed to create user' });

    const sessionId = await createSession(user.id);

    res.status(201).json({ sessionId, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (sessionId) {
      const { runSync, saveDb } = await getDb();
      runSync('DELETE FROM sessions WHERE id = ?', [sessionId]);
      saveDb();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.json({ user: null });

    const { getSync } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.json({ user: null });

    const user = getSync('SELECT id, name, role, city, wa, email, dept, status, freed, store_logo, store_cover, store_bio FROM users WHERE id = ?', [session.user_id]);
    res.json({ user: user || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/profile', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const { getSync, runSync, saveDb } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const { wa, email, city, dept, store_bio } = req.body;
    const updates = [];
    const values = [];
    if (wa !== undefined) { updates.push('wa = ?'); values.push(wa); }
    if (email !== undefined) { updates.push('email = ?'); values.push(email); }
    if (city !== undefined) { updates.push('city = ?'); values.push(city); }
    if (dept !== undefined) { updates.push('dept = ?'); values.push(dept); }
    if (store_bio !== undefined) { updates.push('store_bio = ?'); values.push(store_bio); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(session.user_id);
    runSync(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    saveDb();

    const user = getSync('SELECT id, name, role, city, wa, email, dept, status, freed, store_logo, store_cover, store_bio FROM users WHERE id = ?', [session.user_id]);
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/password', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const { getSync, runSync, saveDb } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Old and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const user = getSync('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const salt = bcrypt.genSaltSync(12);
    const hash = bcrypt.hashSync(newPassword, salt);
    runSync('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, user.id]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/account', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const { getSync, runSync, saveDb } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    runSync('DELETE FROM users WHERE id = ?', [session.user_id]);
    runSync('DELETE FROM sessions WHERE user_id = ?', [session.user_id]);
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
