// WhatsApp message sender — pluggable provider layer.
//
//   WHATSAPP_PROVIDER=none   (default) dev mode: logs the message; the OTP
//                            endpoint returns dev_code so testing works with
//                            no external account.
//   WHATSAPP_PROVIDER=meta   Meta WhatsApp Cloud API. Needs:
//                            WHATSAPP_TOKEN     (permanent or 24h dev token)
//                            WHATSAPP_PHONE_ID  (sender phone-number ID)
//                            Free to start: Meta gives a TEST number that can
//                            message up to 5 verified recipients at no cost.
//
// sendOtp(waNumber, code, lang) -> { sent: boolean, dev: boolean }

async function metaSendWith(phoneId, token, to, body) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, '').replace(/^00/, ''),
      type: 'text',
      text: { body }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Meta API error ${res.status}`);
  return json;
}

// The API Setup page shows two long IDs (phone-number ID and WABA ID) that are
// easy to mix up — try the primary, and on an id-related error fall back to
// WHATSAPP_PHONE_ID_ALT, remembering whichever worked.
let workingPhoneId = null;
async function sendViaMeta(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const ids = [workingPhoneId, process.env.WHATSAPP_PHONE_ID, process.env.WHATSAPP_PHONE_ID_ALT]
    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  if (!token || !ids.length) throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_ID not set');

  let lastErr;
  for (const id of ids) {
    try {
      const out = await metaSendWith(id, token, to, body);
      if (workingPhoneId !== id) { workingPhoneId = id; console.log(`[whatsapp:meta] using phone id ${id}`); }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// --- Twilio WhatsApp (works with the free sandbox for testing) ---
// TWILIO_ACCOUNT_SID (AC...), TWILIO_AUTH_TOKEN, and optionally
// TWILIO_WA_FROM (defaults to the sandbox sender whatsapp:+14155238886).
// Sandbox note: each recipient joins once by WhatsApp-ing the join code
// to the sandbox number; then they receive real OTPs.
async function sendViaTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  const from = process.env.TWILIO_WA_FROM || 'whatsapp:+14155238886';
  const toE164 = to.startsWith('00') ? '+' + to.slice(2) : to;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: from, To: `whatsapp:${toE164}`, Body: body })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Twilio error ${res.status}`);
  return json;
}

// Plain SMS via Twilio (From = your Twilio number in TWILIO_SMS_FROM).
async function sendViaTwilioSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;
  if (!sid || !token) throw new Error('Twilio credentials not set');
  if (!from) throw new Error('TWILIO_SMS_FROM not set (no SMS sender number)');
  const toE164 = to.startsWith('00') ? '+' + to.slice(2) : to;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: from, To: toE164, Body: body })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `Twilio SMS error ${res.status}`);
  return json;
}

// --- Infobip (SMS + WhatsApp) — strong coverage in Sudan / Africa / MENA ---
// INFOBIP_BASE_URL  e.g. https://xxxxx.api.infobip.com  (shown on your Infobip
//                   dashboard home / API key page)
// INFOBIP_API_KEY   the API key (Authorization: App <key>)
// INFOBIP_SMS_FROM  sender id/number for SMS (e.g. "Souq" or a number)
// INFOBIP_WA_FROM   your Infobip WhatsApp sender number (digits only)
function infobipBase() {
  const b = (process.env.INFOBIP_BASE_URL || '').replace(/\/$/, '');
  if (!b) throw new Error('INFOBIP_BASE_URL not set');
  return b.startsWith('http') ? b : 'https://' + b;
}
function infobipHeaders() {
  const key = process.env.INFOBIP_API_KEY;
  if (!key) throw new Error('INFOBIP_API_KEY not set');
  return { 'Authorization': `App ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}
const digitsOnly = (to) => to.replace(/^\+/, '').replace(/^00/, '');

async function sendViaInfobipSms(to, body) {
  const from = process.env.INFOBIP_SMS_FROM || 'Souq';
  const res = await fetch(`${infobipBase()}/sms/2/text/advanced`, {
    method: 'POST',
    headers: infobipHeaders(),
    body: JSON.stringify({ messages: [{ destinations: [{ to: digitsOnly(to) }], from, text: body }] })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.requestError?.serviceException?.text || `Infobip SMS error ${res.status}`);
  return json;
}

async function sendViaInfobipWa(to, body) {
  const from = process.env.INFOBIP_WA_FROM;
  if (!from) throw new Error('INFOBIP_WA_FROM not set (no WhatsApp sender)');
  const res = await fetch(`${infobipBase()}/whatsapp/1/message/text`, {
    method: 'POST',
    headers: infobipHeaders(),
    body: JSON.stringify({ from: digitsOnly(from), to: digitsOnly(to), content: { text: body } })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.requestError?.serviceException?.text || `Infobip WhatsApp error ${res.status}`);
  return json;
}

async function sendOtp(to, code, lang) {
  const body = lang === 'ar'
    ? `رمز التحقق الخاص بك في خفض لى: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`
    : `Your Souq verification code: ${code}\nValid for 5 minutes. Do not share it.`;

  const provider = process.env.WHATSAPP_PROVIDER || 'none';

  if (provider === 'infobip') {
    // Verification plan: SMS first; if not possible for any reason, WhatsApp;
    // last resort dev mode so testing never breaks.
    try {
      await sendViaInfobipSms(to, body);
      console.log(`[otp] delivered by Infobip SMS to ${to}`);
      return { sent: true, dev: false };
    } catch (smsErr) {
      console.log('[otp] Infobip SMS not possible (' + smsErr.message + ') -> trying WhatsApp');
      try {
        await sendViaInfobipWa(to, body);
        console.log(`[otp] delivered by Infobip WhatsApp to ${to}`);
        return { sent: true, dev: false };
      } catch (waErr) {
        console.error('[otp] Infobip WhatsApp also failed (' + waErr.message + ') -> dev fallback');
        console.log(`[whatsapp:dev] to=${to} :: ${body.replace(/\n/g, ' | ')}`);
        return { sent: true, dev: true };
      }
    }
  }

  if (provider === 'meta') {
    await sendViaMeta(to, body);
    return { sent: true, dev: false };
  }
  if (provider === 'twilio') {
    // Verification plan: try SMS first; if SMS is not possible for any
    // reason, fall back to a WhatsApp message; last resort dev mode.
    try {
      await sendViaTwilioSms(to, body);
      console.log(`[otp] delivered by SMS to ${to}`);
      return { sent: true, dev: false };
    } catch (smsErr) {
      console.log('[otp] SMS not possible (' + smsErr.message + ') -> trying WhatsApp');
      try {
        await sendViaTwilio(to, body);
        console.log(`[otp] delivered by WhatsApp to ${to}`);
        return { sent: true, dev: false };
      } catch (waErr) {
        console.error('[otp] WhatsApp also failed (' + waErr.message + ') -> dev fallback');
        console.log(`[whatsapp:dev] to=${to} :: ${body.replace(/\n/g, ' | ')}`);
        return { sent: true, dev: true };
      }
    }
  }

  // dev mode: no gateway — log it; caller may expose dev_code to the client
  console.log(`[whatsapp:dev] to=${to} :: ${body.replace(/\n/g, ' | ')}`);
  return { sent: true, dev: true };
}

module.exports = { sendOtp };
