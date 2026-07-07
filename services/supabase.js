// Supabase connector — cloud (off-site) storage for database backups.
//
// Uses the Storage REST API directly (no SDK needed):
//   SUPABASE_URL = https://<project>.supabase.co
//   SUPABASE_KEY = service_role key (Settings -> API -> service_role, eyJ...)
//
// ensureBucket() creates the private "backups" bucket on first use.
// uploadBackup(localPath, name) uploads/overwrites an object in it.

const fs = require('fs');

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = () => process.env.SUPABASE_KEY || '';

function configured() {
  return Boolean(URL_() && KEY() && KEY().startsWith('eyJ'));
}

function headers(extra = {}) {
  return { 'Authorization': `Bearer ${KEY()}`, 'apikey': KEY(), ...extra };
}

async function ensureBucket(name = 'backups') {
  const res = await fetch(`${URL_()}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: name, name, public: false })
  });
  if (res.ok) return true;
  const json = await res.json().catch(() => ({}));
  // 409 / "already exists" is fine
  if (res.status === 409 || /exist/i.test(json.error || json.message || '')) return true;
  throw new Error(`bucket create failed: ${json.message || json.error || res.status}`);
}

async function uploadBackup(localPath, objectName, bucket = 'backups') {
  const body = fs.readFileSync(localPath);
  const res = await fetch(`${URL_()}/storage/v1/object/${bucket}/${objectName}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }),
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload failed: ${json.message || json.error || res.status}`);
  return json;
}

async function listBackups(bucket = 'backups') {
  const res = await fetch(`${URL_()}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: '', limit: 100, sortBy: { column: 'name', order: 'desc' } })
  });
  const json = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return json;
}

module.exports = { configured, ensureBucket, uploadBackup, listBackups };
