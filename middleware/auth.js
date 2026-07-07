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

    const user = dbs.getSync('SELECT id, name, role, city, wa, email, dept, status, freed, permissions, store_logo, store_cover, store_bio FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    req.user = user;
    req.sessionId = sessionId;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// The 7 permission areas of the control panel.
const PERMISSIONS = ['users', 'ads', 'billing', 'verification', 'content', 'reports', 'support'];

function isAdminRole(role) {
  return role === 'admin' || role === 'super_admin';
}

// Super admin has every permission implicitly; a sub-admin has only the keys
// stored in users.permissions (JSON array).
function hasPerm(user, key) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (user.role !== 'admin') return false;
  let perms = [];
  try { perms = JSON.parse(user.permissions || '[]'); } catch { perms = []; }
  return Array.isArray(perms) && perms.includes(key);
}

async function requireAdmin(req, res, next) {
  try {
    await requireAuth(req, res, () => {
      if (!isAdminRole(req.user.role)) return res.status(403).json({ error: 'Admin only' });
      next();
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Route-level guard for a specific control-panel area. Assumes requireAdmin
// already populated req.user (mount after `router.use(requireAdmin)`).
function requirePerm(key) {
  return (req, res, next) => {
    if (hasPerm(req.user, key)) return next();
    return res.status(403).json({ error: `You do not have permission for the "${key}" section` });
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.user && req.user.role === 'super_admin') return next();
  return res.status(403).json({ error: 'Super admin only' });
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

module.exports = { requireAuth, requireAdmin, optionalAuth, requirePerm, requireSuperAdmin, hasPerm, PERMISSIONS };
