# Souq · خفض لى — test deployment guide

## Free public URL (Cloudflare quick tunnel — no account needed)

The app runs locally (`node server.js` or PM2 on port 3000) and is exposed
publicly through a free Cloudflare quick tunnel:

```
cloudflared tunnel --url http://localhost:3000 --protocol http2
```

(`--protocol http2` matters on this network: the default QUIC/UDP transport
only gets 1 of 4 connections up and requests flap with "Origin DNS error";
HTTP/2 over TCP is stable.)

- The command prints a fresh `https://<random>.trycloudflare.com` URL each run.
- Works as long as this PC is on and the tunnel process is running.
- No signup, no cost, HTTPS included.

cloudflared.exe download:
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe

### If the URL doesn't open on your own network
This router's DNS blocks `*.trycloudflare.com` (NXDOMAIN). The URL still works
for everyone else. To open it yourself: use mobile data, or set the device DNS
to `1.1.1.1`.

## WhatsApp OTP (real sending)

The OTP pipeline (generate -> save hashed -> send) is live. By default it runs
in dev mode: the code is logged and shown on screen so testing needs no account.

To send REAL WhatsApp messages (free to start):
1. https://developers.facebook.com -> create app -> add "WhatsApp" product.
2. Meta gives you a FREE test sender number; verify up to 5 recipient numbers.
3. Copy the temporary access token + phone number ID into `.env`:
   ```
   WHATSAPP_PROVIDER=meta
   WHATSAPP_TOKEN=EAAG...
   WHATSAPP_PHONE_ID=1234567890
   DEV_SHOW_OTP=false
   ```
4. `pm2 restart souq-api --update-env` — codes now arrive in WhatsApp and the
   on-screen demo code disappears.

For launch: complete Meta business verification to message any number
(~First 1,000 conversations/month free), or use Twilio WhatsApp instead.


## Cloud-persistent database (Supabase)

The app keeps its fast local SQLite engine, but the database file's lifecycle is
cloud-backed so it survives on ANY host (including free/ephemeral ones):

- **On startup:** if there is no local `souq.db`, the newest cloud snapshot is
  downloaded from the Supabase `backups` bucket (`souq-latest.db`) and restored.
- **While running:** a full snapshot is mirrored to the cloud every 5 minutes.
- **On shutdown (SIGTERM/SIGINT):** a final snapshot is flushed to the cloud, so
  a redeploy/restart loses nothing.
- **Nightly:** a timestamped historical backup (keeps 14) for point-in-time recovery.

Effect: you can deploy the app on a free host that wipes its disk on restart and
your data still persists — it lives in Supabase. On a normal server/PC the local
file is always the source of truth (restore only runs when no local DB exists).

Requires `SUPABASE_URL` + `SUPABASE_KEY` in `.env` (already configured).

## Admin access
- Username `admin`, password from `.env` → `ADMIN_PASSWORD` (default `admin123`).
- Change it in `.env` before sharing the URL widely; delete `.env` default in production.

## Durable free option (later): Render.com
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect repo.
3. Build command: `npm install` · Start command: `node server.js`.
4. Add env var `ADMIN_PASSWORD`. Free instance sleeps when idle;
   **SQLite data resets on redeploy** (fine for evaluation, not for launch).

## Real launch (paid, ~$5/mo)
VPS + `pm2 start ecosystem.config.js` + Caddy (`Caddyfile` included) with a
real domain; daily backup of `souq.db` + `uploads/`.
