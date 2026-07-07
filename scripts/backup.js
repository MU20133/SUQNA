// Database backup + cloud sync helpers.
//
// Run standalone (CLI) for a timestamped historical backup:
//   node scripts/backup.js                 (also under PM2 cron at 03:00)
//
// Or require() the exported functions from the server:
//   historicalBackup()  timestamped copy, keeps KEEP locally + uploads to cloud
//   mirrorLive()        overwrite souq-latest.db locally + in the cloud (the
//                       freshest full snapshot; used for restore-on-boot)
//   restoreOnBoot()     if there's NO local DB, pull the latest cloud snapshot
//                       so a fresh/ephemeral host comes up with all the data
//
// Uses SQLite's online-backup API (safe while the server runs — WAL is not
// blocked). The engine and every query stay exactly as they are.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB = path.join(__dirname, '..', 'souq.db');
const DIR = path.join(__dirname, '..', 'backups');
const LATEST = 'souq-latest.db';   // the always-overwritten "live mirror" object
const KEEP = 14;

function supa() { return require('../services/supabase'); }

// Snapshot the live DB (readonly connection = never blocks writers) to destPath.
async function snapshot(destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const db = new Database(DB, { readonly: true, fileMustExist: true });
  await db.backup(destPath);
  db.close();
  return fs.statSync(destPath).size;
}

// Timestamped historical backup + prune + upload (nightly).
async function historicalBackup() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dest = path.join(DIR, `souq-${stamp}.db`);
  const size = await snapshot(dest);
  console.log(`[backup] wrote ${dest} (${(size / 1024).toFixed(0)} KB)`);

  const old = fs.readdirSync(DIR).filter(f => /^souq-\d.*\.db$/.test(f)).sort().reverse().slice(KEEP);
  for (const f of old) { fs.unlinkSync(path.join(DIR, f)); console.log(`[backup] pruned ${f}`); }

  const s = supa();
  if (s.configured()) {
    try {
      await s.uploadBackup(dest, path.basename(dest));
      console.log(`[backup] uploaded to Supabase: backups/${path.basename(dest)}`);
    } catch (e) { console.error('[backup] Supabase upload failed:', e.message); }
  } else {
    console.log('[backup] Supabase not configured — local backup only');
  }
  return dest;
}

// Overwrite the single "live mirror" object locally + in the cloud. Cheap to
// run often; restore-on-boot reads exactly this object.
async function mirrorLive() {
  const dest = path.join(DIR, LATEST);
  try {
    await snapshot(dest);
    const s = supa();
    if (s.configured()) await s.uploadBackup(dest, LATEST);
    return true;
  } catch (e) {
    console.error('[mirror] failed:', e.message);
    return false;
  }
}

// If there's no local DB yet (fresh host / ephemeral disk), restore the newest
// cloud snapshot so the app boots with all existing data. Never overwrites an
// existing local DB — the local file is always treated as the source of truth.
async function restoreOnBoot() {
  if (fs.existsSync(DB)) return false;
  const s = supa();
  if (!s.configured()) return false;
  try {
    // Prefer the live mirror; fall back to the newest timestamped backup.
    let buf = await s.downloadObject('backups', LATEST);
    let from = LATEST;
    if (!buf) {
      const list = await s.listBackups('backups');
      const newest = (list || []).map(f => f.name).filter(n => /^souq-\d.*\.db$/.test(n)).sort().reverse()[0];
      if (newest) { buf = await s.downloadObject('backups', newest); from = newest; }
    }
    if (!buf) { console.log('[boot] no cloud snapshot to restore — starting fresh'); return false; }
    fs.writeFileSync(DB, buf);
    console.log(`[boot] restored DB from Supabase cloud (${from}, ${(buf.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (e) {
    console.error('[boot] restore failed:', e.message);
    return false;
  }
}

module.exports = { historicalBackup, mirrorLive, restoreOnBoot };

// CLI: run the historical backup.
if (require.main === module) {
  historicalBackup()
    .then(() => process.exit(0))
    .catch(e => { console.error('[backup] FAILED:', e.message); process.exit(1); });
}
