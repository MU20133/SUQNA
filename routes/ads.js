const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

let dbs = null;
async function getDb() {
  if (!dbs) dbs = await require('../database').getDb();
  return dbs;
}

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|pdf|doc|docx|heic)$/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('File type not allowed'));
  }
});

router.get('/', async (req, res) => {
  try {
    const dbs = await getDb();
    const { cat, search, city, seller, featured, status, sort, page = 1, limit = 20 } = req.query;

    // First check auth
    const sessionId = req.headers['x-session-id'];
    let user = null;
    if (sessionId) {
      const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
      if (session) user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);
    }

    let sql = 'SELECT a.*, GROUP_CONCAT(ap.filename) as photos FROM ads a LEFT JOIN ad_photos ap ON ap.ad_id = a.id';
    const where = [];
    const params = [];

    const isOwnerQuery = user && seller && seller === user.name;
    if (user && user.role === 'admin') {
      if (status) { where.push('a.status = ?'); params.push(status); }
    } else if (isOwnerQuery) {
      // Owners see ALL their own ads (pending/rejected included) so the
      // account page can show review status and the ad confirmation code.
      if (status) { where.push('a.status = ?'); params.push(status); }
    } else {
      where.push("a.status = 'approved'");
    }

    if (cat) { where.push('a.cat = ?'); params.push(cat); }
    if (city) { where.push('a.city = ?'); params.push(city); }
    if (seller) { where.push('a.seller = ?'); params.push(seller); }
    if (search) { where.push('(a.title LIKE ? OR a.desc LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }

    sql += where.length ? ' WHERE ' + where.join(' AND ') : '';
    sql += ' GROUP BY a.id';

    if (featured === '1') sql += ' ORDER BY a.featured DESC, a.created DESC';
    else if (sort === 'price_asc') sql += ' ORDER BY a.price ASC';
    else if (sort === 'price_desc') sql += ' ORDER BY a.price DESC';
    else if (sort === 'oldest') sql += ' ORDER BY a.created ASC';
    else sql += ' ORDER BY a.created DESC';

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    sql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const ads = dbs.allSync(sql, params);

    // Count query without LIMIT/OFFSET
    let countSql = 'SELECT COUNT(DISTINCT a.id) as c FROM ads a LEFT JOIN ad_photos ap ON ap.ad_id = a.id';
    const countWhere = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const countParams = params.slice(0, -2);
    const totalRow = dbs.getSync(countSql + countWhere, countParams);
    const total = totalRow ? totalRow.c : 0;
    const fullCountRow = dbs.getSync('SELECT COUNT(*) as c FROM ads');
    const fullCount = fullCountRow ? fullCountRow.c : 0;

    // Engagements
    let userEngagements = {};
    if (user) {
      const engRows = dbs.allSync('SELECT ad_id, liked, saved FROM user_engagements WHERE user_id = ?', [user.id]);
      for (const e of engRows) userEngagements[e.ad_id] = { liked: e.liked, saved: e.saved };
    }

    res.json({
      ads: ads.map(a => ({
        ...a,
        liked: !!userEngagements[a.id]?.liked,
        saved: !!userEngagements[a.id]?.saved
      })),
      total,
      fullCount,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const dbs = await getDb();
    const ad = dbs.getSync('SELECT a.*, GROUP_CONCAT(ap.filename) as photos FROM ads a LEFT JOIN ad_photos ap ON ap.ad_id = a.id WHERE a.id = ? GROUP BY a.id', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const attachments = dbs.allSync('SELECT * FROM ad_attachments WHERE ad_id = ?', [ad.id]);

    dbs.runSync('UPDATE ads SET views = views + 1 WHERE id = ?', [ad.id]);
    dbs.saveDb();

    const sessionId = req.headers['x-session-id'];
    let liked = false, saved = false;
    if (sessionId) {
      const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
      if (session) {
        const eng = dbs.getSync('SELECT liked, saved FROM user_engagements WHERE user_id = ? AND ad_id = ?', [session.user_id, ad.id]);
        if (eng) { liked = !!eng.liked; saved = !!eng.saved; }
      }
    }

    res.json({ ad: { ...ad, liked, saved, attachments } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', upload.array('photos', 10), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const { title, cat, price, cur, city, dist, desc, neg, pay_method } = req.body;
    if (!title || title.trim().length < 5) return res.status(400).json({ error: 'Title must be at least 5 characters' });

    const created = Date.now();
    const status = user.role === 'admin' ? 'approved' : 'pending_review';

    dbs.runSync(`INSERT INTO ads (title, cat, price, cur, city, dist, desc, neg, pay_method, status, created, owner, owner_role, seller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        title.trim(), cat || '', parseInt(price) || 0, cur || 'SDG',
        city || '', dist || '', desc || '', neg === '0' ? 0 : 1,
        pay_method || '', status, created, user.name, user.role, user.name
    ]);
    const adId = dbs.lastId();

    if (req.files && req.files.length) {
      for (const f of req.files) {
        dbs.runSync('INSERT INTO ad_photos (ad_id, filename) VALUES (?, ?)', [adId, f.filename]);
      }
    }
    dbs.saveDb();
    res.status(201).json({ ad: { id: adId } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', upload.array('photos', 10), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.owner !== user.name && user.role !== 'admin') return res.status(403).json({ error: 'Not your ad' });

    const { title, cat, price, cur, city, dist, desc, neg } = req.body;
    if (title && title.trim().length < 5) return res.status(400).json({ error: 'Title must be at least 5 characters' });

    const updates = [];
    const values = [];
    if (title !== undefined) { updates.push('title = ?'); values.push(title.trim()); }
    if (cat !== undefined) { updates.push('cat = ?'); values.push(cat); }
    if (price !== undefined) { updates.push('price = ?'); values.push(parseInt(price) || 0); }
    if (cur !== undefined) { updates.push('cur = ?'); values.push(cur); }
    if (city !== undefined) { updates.push('city = ?'); values.push(city); }
    if (dist !== undefined) { updates.push('dist = ?'); values.push(dist); }
    if (desc !== undefined) { updates.push('desc = ?'); values.push(desc); }
    if (neg !== undefined) { updates.push('neg = ?'); values.push(neg === '0' ? 0 : 1); }

    if (updates.length) {
      values.push(ad.id);
      dbs.runSync(`UPDATE ads SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    if (req.files && req.files.length) {
      for (const f of req.files) {
        dbs.runSync('INSERT INTO ad_photos (ad_id, filename) VALUES (?, ?)', [ad.id, f.filename]);
      }
    }
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.owner !== user.name && user.role !== 'admin') return res.status(403).json({ error: 'Not your ad' });

    dbs.runSync('DELETE FROM ads WHERE id = ?', [ad.id]);
    dbs.saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Payment receipt for the publishing fee. The admin checks it (spec item 3);
// a copy goes to the Supabase "receipts" cloud bucket when configured.
router.post('/:id/receipt', upload.single('receipt'), async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });
    const user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);

    const ad = dbs.getSync('SELECT * FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.owner !== user.name && user.role !== 'admin') return res.status(403).json({ error: 'Not your ad' });

    const fname = req.file ? req.file.filename : '';
    dbs.runSync('UPDATE ads SET receipt_file = ?, receipt_note = ?, pay_method = ?, pay_status = ? WHERE id = ?',
      [fname, req.body.note || '', 'cash', 'pending', ad.id]);
    dbs.saveDb();

    if (req.file) {
      const supa = require('../services/supabase');
      if (supa.configured()) {
        try {
          const fs = require('fs');
          await supa.uploadObject('receipts', `ad${ad.id}_${fname}`, fs.readFileSync(req.file.path));
        } catch (e) { console.error('[supabase] receipt mirror failed:', e.message); }
      }
    }
    res.status(201).json({ ok: true, pay_status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/like', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const ad = dbs.getSync('SELECT id FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const existing = dbs.getSync('SELECT id, liked FROM user_engagements WHERE user_id = ? AND ad_id = ?', [user.id, ad.id]);
    if (existing) {
      const newVal = existing.liked ? 0 : 1;
      dbs.runSync('UPDATE user_engagements SET liked = ? WHERE id = ?', [newVal, existing.id]);
      dbs.runSync('UPDATE ads SET likes = likes + ? WHERE id = ?', [newVal ? 1 : -1, ad.id]);
      dbs.saveDb();
      res.json({ liked: !!newVal });
    } else {
      dbs.runSync('INSERT INTO user_engagements (user_id, ad_id, liked) VALUES (?, ?, 1)', [user.id, ad.id]);
      dbs.runSync('UPDATE ads SET likes = likes + 1 WHERE id = ?', [ad.id]);
      dbs.saveDb();
      res.json({ liked: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/save', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    const ad = dbs.getSync('SELECT id FROM ads WHERE id = ?', [req.params.id]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const existing = dbs.getSync('SELECT id, saved FROM user_engagements WHERE user_id = ? AND ad_id = ?', [user.id, ad.id]);
    if (existing) {
      const newVal = existing.saved ? 0 : 1;
      dbs.runSync('UPDATE user_engagements SET saved = ? WHERE id = ?', [newVal, existing.id]);
      dbs.saveDb();
      res.json({ saved: !!newVal });
    } else {
      dbs.runSync('INSERT INTO user_engagements (user_id, ad_id, saved) VALUES (?, ?, 1)', [user.id, ad.id]);
      dbs.saveDb();
      res.json({ saved: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/report', async (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
