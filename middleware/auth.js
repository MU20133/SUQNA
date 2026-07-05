async function getDb() {
  const { getDb } = require('../database');
  return await getDb();
}

async function requireAuth(req, res, next) {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) return res.status(401).json({ error: 'Session expired or invalid' });

    const user = dbs.getSync('SELECT id, name, role, city, wa, email, dept, status, freed, store_logo, store_cover, store_bio FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    req.user = user;
    req.sessionId = sessionId;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function requireAdmin(req, res, next) {
  try {
    await requireAuth(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      next();
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function optionalAuth(req, res, next) {
  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) { req.user = null; return next(); }

    const dbs = await getDb();
    const session = dbs.getSync('SELECT * FROM sessions WHERE id = ? AND expires > ?', [sessionId, Date.now()]);
    if (!session) { req.user = null; return next(); }

    const user = dbs.getSync('SELECT id, name, role, city, wa, email, dept, status FROM users WHERE id = ?', [session.user_id]);
    req.user = user || null;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
