// Supabase connector — cloud (off-site) storage for database backups.
//
// Uses the Storage REST API directly (no SDK needed):
//   SUPABASE_URL = https://<project>.supabase.co
//   SUPABASE_KEY = service_role key (Settings -> API -> service_role, eyJ...)
//
// ensureBucket() creates the private "backups" bucket on first use.
// uploadBackup(localPath, name) uploads/overwrites an object in it.

const fs = require('fs');

// Normalize whatever the user pasted into SUPABASE_URL: tolerate a missing
// scheme ("host", "//host") or a trailing slash, always yield "https://host".
const URL_ = () => {
  let u = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  else if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
};
const KEY = () => process.env.SUPABASE_KEY || '';

function configured() {
  // Accept both key generations: legacy JWT service_role (eyJ...) and the
  // newer secret API keys (sb_secret_...).
  const k = KEY();
  return Boolean(URL_() && k && (k.startsWith('eyJ') || k.startsWith('sb_secret_')));
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

// --- SMS OTP via Supabase Auth ---
// Works once an SMS provider (Twilio/Vonage/MessageBird) is connected in the
// Supabase dashboard (Authentication -> Providers -> Phone). Until then the
// endpoint errors and callers fall back to dev mode.
function e164(phone) {
  const d = String(phone).replace(/[\s\-()]/g, '');
  return d.startsWith('00') ? '+' + d.slice(2) : d;
}

// channel: 'whatsapp' delivers the code as a WhatsApp message (requires the
// Twilio provider in the Supabase dashboard with WhatsApp enabled); 'sms'
// delivers a plain text message. Verification is identical for both.
async function sendSmsOtp(phone, channel = 'sms') {
  const res = await fetch(`${URL_()}/auth/v1/otp`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ phone: e164(phone), create_user: true, channel })
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`phone otp (${channel}) failed: ${json.msg || json.error_description || res.status}`);
  }
  return true;
}

async function verifySmsOtp(phone, token) {
  const res = await fetch(`${URL_()}/auth/v1/verify`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ type: 'sms', phone: e164(phone), token })
  });
  return res.ok;
}

// Download an object's bytes; returns a Buffer, or null if it doesn't exist.
async function downloadObject(bucket, objectName) {
  const res = await fetch(`${URL_()}/storage/v1/object/${bucket}/${objectName}`, {
    headers: headers()
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
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

module.exports = { configured, ensureBucket, uploadBackup, listBackups, uploadObject, downloadObject, sendEmailOtp, verifyEmailOtp, sendSmsOtp, verifySmsOtp };
