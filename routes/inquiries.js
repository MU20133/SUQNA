const express = require('express');
const router = express.Router();

let dbs = null;
async function getDb() {
  if (!dbs) dbs = await require('../database').getDb();
  return dbs;
}

async function requireAuth(req, res, next) {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired' });

    const user = dbs.getSync('SELECT id, name, role FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const dbs = await getDb();
    const inquiries = dbs.allSync(
      'SELECT * FROM inquiries WHERE seller = ? OR buyer = ? ORDER BY id DESC',
      [req.user.name, req.user.name]
    );

    const result = [];
    for (const i of inquiries) {
      const msgs = dbs.allSync('SELECT * FROM inquiry_messages WHERE inquiry_id = ? ORDER BY id ASC', [i.id]);
      result.push({ ...i, messages: msgs });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/on/:adId', async (req, res) => {
  try {
    const dbs = await getDb();
    const ad = dbs.getSync('SELECT id, title, seller FROM ads WHERE id = ?', [req.params.adId]);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    if (ad.seller === req.user.name) return res.status(400).json({ error: 'Cannot inquire on your own ad' });

    const existing = dbs.getSync('SELECT * FROM inquiries WHERE ad_id = ? AND buyer = ?', [ad.id, req.user.name]);
    if (existing) return res.json(existing);

    dbs.runSync('INSERT INTO inquiries (ad_id, ad_title, seller, buyer) VALUES (?, ?, ?, ?)', [ad.id, ad.title, ad.seller, req.user.name]);
    dbs.saveDb();
    const inquiry = { id: dbs.lastId(), ad_id: ad.id, ad_title: ad.title, seller: ad.seller, buyer: req.user.name };
    res.status(201).json(inquiry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/messages', async (req, res) => {
  try {
    const dbs = await getDb();
    const inquiry = dbs.getSync('SELECT * FROM inquiries WHERE id = ?', [req.params.id]);
    if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });

    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body required' });

    dbs.runSync('INSERT INTO inquiry_messages (inquiry_id, from_text, body) VALUES (?, ?, ?)', [inquiry.id, req.user.name, body.trim()]);
    dbs.saveDb();
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
