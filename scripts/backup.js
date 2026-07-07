// Daily database backup. Run standalone or under PM2 cron:
//   pm2 start scripts/backup.js --name souq-backup --cron "0 3 * * *" --no-autorestart
//
// Uses SQLite's online-backup API (safe while the server is running — WAL
// readers/writers are not blocked). Keeps the newest KEEP copies, prunes older.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB = path.join(__dirname, '..', 'souq.db');
const DIR = path.join(__dirname, '..', 'backups');
const KEEP = 14;

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dest = path.join(DIR, `souq-${stamp}.db`);

  const db = new Database(DB, { readonly: true });
  await db.backup(dest);
  db.close();
  console.log(`[backup] wrote ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);

  const old = fs.readdirSync(DIR).filter(f => f.startsWith('souq-') && f.endsWith('.db')).sort().reverse().slice(KEEP);
  for (const f of old) { fs.unlinkSync(path.join(DIR, f)); console.log(`[backup] pruned ${f}`); }
  process.exit(0);
})().catch(e => { console.error('[backup] FAILED:', e.message); process.exit(1); });
