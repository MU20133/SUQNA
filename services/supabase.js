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

// Generic object upload (receipts, identity documents, ...).
async function uploadObject(bucket, objectName, buffer, contentType = 'application/octet-stream') {
  await ensureBucket(bucket);
  const res = await fetch(`${URL_()}/storage/v1/object/${bucket}/${objectName}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: buffer
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload failed: ${json.message || json.error || res.status}`);
  return json;
}

// --- Email OTP via Supabase Auth (built-in mailer, no SMTP account needed) ---
// Sends a 6-digit code to the address; verify with the same endpoint pair.
async function sendEmailOtp(email) {
  const res = await fetch(`${URL_()}/auth/v1/otp`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email, create_user: true })
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`email otp failed: ${json.msg || json.error_description || res.status}`);
  }
  return true;
}

async function verifyEmailOtp(email, token) {
  const res = await fetch(`${URL_()}/auth/v1/verify`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ type: 'email', email, token })
  });
  return res.ok;
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

module.exports = { configured, ensureBucket, uploadBackup, listBackups, uploadObject, sendEmailOtp, verifyEmailOtp };
