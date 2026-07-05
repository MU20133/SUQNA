# Souq · خفض لى — test deployment guide

## Free public URL (Cloudflare quick tunnel — no account needed)

The app runs locally (`node server.js` or PM2 on port 3000) and is exposed
publicly through a free Cloudflare quick tunnel:

```
cloudflared tunnel --url http://localhost:3000
```

- The command prints a fresh `https://<random>.trycloudflare.com` URL each run.
- Works as long as this PC is on and the tunnel process is running.
- No signup, no cost, HTTPS included.

cloudflared.exe download:
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe

### If the URL doesn't open on your own network
This router's DNS blocks `*.trycloudflare.com` (NXDOMAIN). The URL still works
for everyone else. To open it yourself: use mobile data, or set the device DNS
to `1.1.1.1`.

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
