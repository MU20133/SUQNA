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
    const convs = dbs.allSync(
      'SELECT * FROM conversations WHERE buyer = ? OR seller = ? ORDER BY id DESC',
      [req.user.name, req.user.name]
    );

    const result = [];
    for (const c of convs) {
      const lastMsg = dbs.getSync('SELECT body FROM conversation_messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1', [c.id]);
      result.push({ ...c, lastMessage: lastMsg?.body || '' });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/with/:seller', async (req, res) => {
  try {
    const dbs = await getDb();
    const { ad_title } = req.body;
    const buyer = req.user.name;
    const seller = req.params.seller;

    if (buyer === seller) return res.status(400).json({ error: 'Cannot message yourself' });

    let conv = dbs.getSync(
      'SELECT * FROM conversations WHERE buyer = ? AND seller = ? AND ad_title = ?',
      [buyer, seller, ad_title || '']
    );
    if (!conv) {
      dbs.runSync('INSERT INTO conversations (buyer, seller, ad_title) VALUES (?, ?, ?)', [buyer, seller, ad_title || '']);
      dbs.saveDb();
      conv = { id: dbs.lastId(), buyer, seller, ad_title: ad_title || '', unread: 1 };
    }
    res.json(conv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const dbs = await getDb();
    const conv = dbs.getSync('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.buyer !== req.user.name && conv.seller !== req.user.name) return res.status(403).json({ error: 'Not your conversation' });

    const messages = dbs.allSync('SELECT * FROM conversation_messages WHERE conv_id = ? ORDER BY id ASC', [conv.id]);

    if (conv.seller === req.user.name || conv.buyer === req.user.name) {
      dbs.runSync('UPDATE conversations SET unread = 0 WHERE id = ?', [conv.id]);
      dbs.saveDb();
    }

    res.json(messages);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/messages', async (req, res) => {
  try {
    const dbs = await getDb();
    const conv = dbs.getSync('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.buyer !== req.user.name && conv.seller !== req.user.name) return res.status(403).json({ error: 'Not your conversation' });

    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body required' });

    dbs.runSync('INSERT INTO conversation_messages (conv_id, from_text, body) VALUES (?, ?, ?)', [conv.id, req.user.name, body.trim()]);
    dbs.runSync('UPDATE conversations SET unread = 1 WHERE id = ?', [conv.id]);
    dbs.saveDb();
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
