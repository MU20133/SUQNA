// Storage engine: better-sqlite3 (native SQLite, WAL mode).
//
// Replaces sql.js (WASM), which kept the whole DB in memory and rewrote the
// ENTIRE file on every saveDb() — slow as data grows and corruptible if the
// process died mid-write. better-sqlite3 writes only changed pages, WAL keeps
// readers and the writer from blocking each other, and a crash can lose at
// most the last transaction — never the file.
//
// The exported interface is unchanged (getSync/runSync/allSync/lastId/saveDb),
// so every route works as before. saveDb() is now a no-op kept for
// compatibility: durability is handled by SQLite itself.

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'souq.db');
let db = null;
let _lastId = 0;

// better-sqlite3 rejects undefined/boolean bind values — normalize them.
function clean(params) {
  if (!params) return params;
  return params.map(v => v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
}

function runSync(sql, params) {
  if (params) {
    const info = db.prepare(sql).run(clean(params));
    _lastId = Number(info.lastInsertRowid) || _lastId;
  } else {
    db.exec(sql);
  }
}

function allSync(sql, params) {
  const stmt = db.prepare(sql);
  return params ? stmt.all(clean(params)) : stmt.all();
}

function getSync(sql, params) {
  const stmt = db.prepare(sql);
  const row = params ? stmt.get(clean(params)) : stmt.get();
  return row === undefined ? null : row;
}

function prepareSync(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(clean(params));
  return stmt;
}

function lastId() {
  return _lastId;
}

// No-op: with WAL every committed statement is already durable on disk.
function saveDb() {}

async function getDb() {
  if (db) return { db, prepareSync, runSync, allSync, getSync, lastId, saveDb, exec: (sql) => db.exec(sql) };

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');     // fast, crash-safe concurrent access
  db.pragma('synchronous = NORMAL');   // fsync at critical moments (WAL-safe)
  db.pragma('foreign_keys = ON');

  migrate();
  seed();
  return { db, prepareSync, runSync, allSync, getSync, lastId, saveDb, exec: (sql) => db.exec(sql) };
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      wa TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'buyer',
      city TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      freed INTEGER DEFAULT 0,
      joined INTEGER NOT NULL,
      failed_attempts INTEGER DEFAULT 0,
      lock_until INTEGER,
      contact_verified TEXT DEFAULT '',
      store_logo TEXT DEFAULT '',
      store_cover TEXT DEFAULT '',
      store_bio TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      cat TEXT DEFAULT '',
      price INTEGER DEFAULT 0,
      cur TEXT DEFAULT 'SDG',
      city TEXT DEFAULT '',
      dist TEXT DEFAULT '',
      desc TEXT DEFAULT '',
      seller TEXT NOT NULL,
      neg INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending_review',
      pay_method TEXT DEFAULT '',
      pay_status TEXT DEFAULT '',
      created INTEGER NOT NULL,
      owner TEXT DEFAULT '',
      owner_role TEXT DEFAULT '',
      featured INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      conf_code TEXT,
      receipt_note TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ad_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ad_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      role TEXT DEFAULT '',
      user TEXT DEFAULT '',
      used INTEGER DEFAULT 0,
      ad_id INTEGER,
      auto INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS inquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_id INTEGER NOT NULL,
      ad_title TEXT DEFAULT '',
      seller TEXT DEFAULT '',
      buyer TEXT DEFAULT '',
      FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS inquiry_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_id INTEGER NOT NULL,
      from_text TEXT NOT NULL,
      body TEXT NOT NULL,
      FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer TEXT NOT NULL,
      seller TEXT NOT NULL,
      ad_title TEXT DEFAULT '',
      unread INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL,
      from_text TEXT NOT NULL,
      body TEXT NOT NULL,
      FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS revenue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      date INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact TEXT NOT NULL,
      contact_type TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT DEFAULT 'register',
      expires INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      verify_token TEXT,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_engagements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ad_id INTEGER NOT NULL,
      liked INTEGER DEFAULT 0,
      saved INTEGER DEFAULT 0,
      session_id TEXT,
      FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
    );

    -- Recall-speed indexes: cover the hot lookups (feed filters, owner pages,
    -- session auth on every request, OTP throttling, engagement joins).
    CREATE INDEX IF NOT EXISTS ix_ads_status_created ON ads(status, created DESC);
    CREATE INDEX IF NOT EXISTS ix_ads_seller ON ads(seller);
    CREATE INDEX IF NOT EXISTS ix_ads_cat ON ads(cat);
    CREATE INDEX IF NOT EXISTS ix_ads_city ON ads(city);
    CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires);
    CREATE INDEX IF NOT EXISTS ix_otps_contact_created ON otps(contact, created);
    CREATE INDEX IF NOT EXISTS ix_engage_user_ad ON user_engagements(user_id, ad_id);
    CREATE INDEX IF NOT EXISTS ix_photos_ad ON ad_photos(ad_id);
    CREATE INDEX IF NOT EXISTS ix_inquiries_people ON inquiries(seller, buyer);
    CREATE INDEX IF NOT EXISTS ix_users_wa ON users(wa);
    CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);
  `);
}

function seed() {
  const row = getSync('SELECT COUNT(*) as c FROM admin_settings');
  if (!row || row.c === 0) {
    const defaults = {
      ad_publishing: '1000',
      featured: '5000',
      ad_appearance: '2500',
      highlight: '3000',
      mark_new: '1500',
      merchant_opening: '50000',
      commission_percent: '5'
    };
    for (const [k, v] of Object.entries(defaults)) {
      runSync('INSERT OR IGNORE INTO admin_settings (key, value) VALUES (?, ?)', [k, v]);
    }
  }

  const admin = getSync('SELECT id, password_hash FROM users WHERE name = ? AND role = ?', ['admin', 'admin']);
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (!admin) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(adminPw, salt);
    runSync(`INSERT INTO users (name, role, password_hash, salt, joined, status)
      VALUES (?, ?, ?, ?, ?, ?)`, ['admin', 'admin', hash, salt, Date.now(), 'active']);
  } else if (!bcrypt.compareSync(adminPw, admin.password_hash)) {
    // .env is the source of truth: sync the admin password on every startup
    // so editing ADMIN_PASSWORD + restart is all it takes to change it.
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(adminPw, salt);
    runSync('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, admin.id]);
  }

  const promoCount = getSync('SELECT COUNT(*) as c FROM promos');
  if (promoCount.c === 0) {
    const offers = [
      '🛒 Welcome to Souq خفض لى — buy & sell across Sudan',
      '📢 Post your first ad today — quick admin review',
      '⭐ Featured ads reach thousands of buyers',
      '🏪 Open your merchant store on Souq',
      '💰 Negotiate directly with sellers in-app'
    ];
    for (const t of offers) runSync('INSERT INTO promos (text) VALUES (?)', [t]);
  }
}

module.exports = { getDb };
