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

async function sendViaMeta(to, body) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_TOKEN / WHATSAPP_PHONE_ID not set');

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

async function sendOtp(to, code, lang) {
  const body = lang === 'ar'
    ? `رمز التحقق الخاص بك في خفض لى: ${code}\nصالح لمدة 5 دقائق. لا تشاركه مع أحد.`
    : `Your Souq verification code: ${code}\nValid for 5 minutes. Do not share it.`;

  const provider = process.env.WHATSAPP_PROVIDER || 'none';

  if (provider === 'meta') {
    await sendViaMeta(to, body);
    return { sent: true, dev: false };
  }

  // dev mode: no gateway — log it; caller may expose dev_code to the client
  console.log(`[whatsapp:dev] to=${to} :: ${body.replace(/\n/g, ' | ')}`);
  return { sent: true, dev: true };
}

module.exports = { sendOtp };
