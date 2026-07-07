const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const { sendOtp } = require('../services/whatsapp');

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

// ---- OTP: User -> Express API -> Generate OTP -> Save OTP -> WhatsApp API ----
const OTP_TTL_MS = 5 * 60 * 1000;        // code valid 5 minutes
const OTP_MAX_ATTEMPTS = 5;              // wrong tries before the code dies
const OTP_RESEND_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 3;            // max sends per contact per window

const hashOtp = (code, contact) =>
  crypto.createHash('sha256').update(`${code}:${contact}:${process.env.OTP_PEPPER || 'souq'}`).digest('hex');

router.post('/otp/request', async (req, res) => {
  try {
    const { wa, email, lang } = req.body;
    let contact, type;
    if (wa) {
      if (!validWa(wa)) return res.status(400).json({ error: 'Error in the WhatsApp number' });
      contact = String(wa).replace(/[\s\-()]/g, ''); type = 'wa';
    } else if (email) {
      if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
      contact = String(email).toLowerCase(); type = 'email';
    } else return res.status(400).json({ error: 'WhatsApp number or email required' });

    const { getSync, runSync, saveDb } = await getDb();

    // throttle: max OTP_MAX_PER_WINDOW sends per contact per window
    const recent = getSync('SELECT COUNT(*) AS c FROM otps WHERE contact = ? AND created > ?',
      [contact, Date.now() - OTP_RESEND_WINDOW_MS]);
    if (recent.c >= OTP_MAX_PER_WINDOW)
      return res.status(429).json({ error: 'Too many codes requested. Try again later.' });

    // Generate OTP
    const code = String(crypto.randomInt(100000, 1000000));
    // Save OTP (hashed — the plain code is never stored)
    runSync('UPDATE otps SET used = 1 WHERE contact = ? AND used = 0', [contact]); // invalidate older codes
    runSync(`INSERT INTO otps (contact, contact_type, code_hash, purpose, expires, created)
      VALUES (?, ?, ?, 'register', ?, ?)`, [contact, type, hashOtp(code, contact), Date.now() + OTP_TTL_MS, Date.now()]);
    saveDb();

    // Phone channel: Meta WhatsApp first, else Supabase SMS (needs an SMS
    // provider connected in the Supabase dashboard), else dev fallback.
    // Email channel: Supabase Auth mailer.
    let dev = true;
    if (type === 'wa') {
      if (['meta', 'twilio'].includes(process.env.WHATSAPP_PROVIDER || 'none')) {
        const r = await sendOtp(contact, code, lang || 'en');
        dev = r.dev;
      } else {
        const supa = require('../services/supabase');
        if (supa.configured()) {
          try {
            await supa.sendSmsOtp(contact, process.env.OTP_PHONE_CHANNEL || 'whatsapp');
            runSync('UPDATE otps SET code_hash = ? WHERE contact = ? AND used = 0', ['supabase-sms', contact]);
            saveDb();
            dev = false;
          } catch (e) {
            console.log('[sms] supabase phone provider not ready, dev fallback:', e.message);
            const r = await sendOtp(contact, code, lang || 'en');   // dev logger
            dev = r.dev;
          }
        } else {
          const r = await sendOtp(contact, code, lang || 'en');
          dev = r.dev;
        }
      }
    } else {
      const supa = require('../services/supabase');
      if (supa.configured()) {
        // Supabase generates AND emails its own code; our local row just
        // gates the flow — verification is delegated in /otp/verify.
        await supa.sendEmailOtp(contact);
        runSync('UPDATE otps SET code_hash = ? WHERE contact = ? AND used = 0', ['supabase', contact]);
        saveDb();
        dev = false;
      } else {
        console.log(`[email:dev] to=${contact} :: code ${code}`);
      }
    }

    const out = { sent: true, channel: type, expires_in: OTP_TTL_MS / 1000 };
    // In dev mode (no gateway configured) expose the code so testing can continue.
    if (dev && (process.env.DEV_SHOW_OTP || 'true') === 'true') out.dev_code = code;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const { wa, email, code } = req.body;
    const contact = wa ? String(wa).replace(/[\s\-()]/g, '') : (email ? String(email).toLowerCase() : null);
    if (!contact || !code) return res.status(400).json({ error: 'Contact and code required' });

    const { getSync, runSync, saveDb } = await getDb();
    const row = getSync('SELECT * FROM otps WHERE contact = ? AND used = 0 ORDER BY id DESC LIMIT 1', [contact]);
    if (!row) return res.status(400).json({ error: 'No code requested for this contact' });
    if (row.expires < Date.now()) return res.status(400).json({ error: 'Code expired. Request a new one.' });
    if (row.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });

    if (row.code_hash === 'supabase' || row.code_hash === 'supabase-sms') {
      const supa = require('../services/supabase');
      const ok = row.code_hash === 'supabase-sms'
        ? await supa.verifySmsOtp(contact, String(code))
        : await supa.verifyEmailOtp(contact, String(code));
      if (!ok) {
        runSync('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [row.id]); saveDb();
        return res.status(400).json({ error: 'Incorrect code' });
      }
    } else if (hashOtp(String(code), contact) !== row.code_hash) {
      runSync('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [row.id]); saveDb();
      return res.status(400).json({ error: 'Incorrect code' });
    }

    // success: single-use verification token that register must present
    const token = uuidv4();
    runSync('UPDATE otps SET verify_token = ? WHERE id = ?', [token, row.id]); saveDb();
    res.json({ verified: true, otp_token: token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/register', async (req, res) => {
  try {
    const { name, password, email, wa, city, dept, role, otp_token, age_confirmed } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    // Age approval is a registration requirement for every role.
    if (age_confirmed !== true && age_confirmed !== 'true' && age_confirmed !== 1)
      return res.status(400).json({ error: 'You must confirm you are 18 or older' });

    // Contact: WhatsApp number or email is required, and must be valid.
    if (!wa && !email) return res.status(400).json({ error: 'WhatsApp number or email required' });
    if (wa && !validWa(wa)) return res.status(400).json({ error: 'Error in the WhatsApp number' });
    if (email && !validEmail(email)) return res.status(400).json({ error: 'Invalid email address' });

    // Role whitelist — 'admin' can never be self-assigned.
    const roleMap = { buyer: 'buyer', seller: 'seller', merchant: 'merchant_app' };
    const safeRole = roleMap[role] || 'buyer';

    const { getSync, runSync, lastId, saveDb } = await getDb();

    // The contact must have been verified via OTP just before registering.
    const contactKey = wa ? String(wa).replace(/[\s\-()]/g, '') : String(email).toLowerCase();
    const otp = otp_token
      ? getSync('SELECT * FROM otps WHERE verify_token = ? AND contact = ? AND used = 0', [otp_token, contactKey])
      : null;
    if (!otp) return res.status(403).json({ error: 'Contact not verified. Complete the code step first.' });
    runSync('UPDATE otps SET used = 1 WHERE id = ?', [otp.id]);   // single use
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

    runSync(`INSERT INTO users (name, email, wa, city, dept, role, password_hash, salt, joined, contact_verified, age_confirmed, age_confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, [
        name, email ? String(email).toLowerCase() : '', waNorm, city || '', dept || '',
        safeRole, password_hash, salt, joined, waNorm ? 'wa' : 'email', Date.now()
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

// Store image upload (logo/cover)
const storeImg = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, 'store_' + uuidv4() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|gif|webp)$/i.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Only images allowed'));
  }
});

router.post('/store-image', storeImg.single('image'), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const { getSync, runSync, saveDb } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const { kind } = req.body;
    if (!kind || !['logo', 'cover'].includes(kind)) return res.status(400).json({ error: 'kind must be logo or cover' });

    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const url = '/uploads/' + req.file.filename;
    if (kind === 'logo') runSync('UPDATE users SET store_logo = ? WHERE id = ?', [url, session.user_id]);
    else runSync('UPDATE users SET store_cover = ? WHERE id = ?', [url, session.user_id]);
    saveDb();

    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merchant identity document (proof of identity). Stored locally and, when
// Supabase is configured, mirrored to the private "identity" cloud bucket.
const idProofUp = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => cb(null, 'id_' + uuidv4() + path.extname(file.originalname))
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|pdf)$/i.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Only images or PDF allowed'));
  }
});

router.post('/id-proof', idProofUp.single('file'), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
    const { getSync, runSync, saveDb } = await getDb();
    const session = getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    runSync('UPDATE users SET id_proof_file = ? WHERE id = ?', [req.file.filename, session.user_id]);
    saveDb();

    const supa = require('../services/supabase');
    if (supa.configured()) {
      try {
        const fs = require('fs');
        await supa.uploadObject('identity', req.file.filename, fs.readFileSync(req.file.path));
      } catch (e) { console.error('[supabase] identity mirror failed:', e.message); }
    }
    res.status(201).json({ ok: true, file: req.file.filename });
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
