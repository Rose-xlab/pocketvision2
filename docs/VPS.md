# Running PocketVision 24/7 on a VPS (Linux)

> **Got a Windows VPS?** Use [VPS-WINDOWS.md](VPS-WINDOWS.md) instead — this
> guide is for Ubuntu/Debian servers.

The scanner drives a real Chromium with your logged-in Pocket Option profile, so the VPS
needs a little more than a bare Node app: ~2 GB RAM, the Playwright browser, and a virtual
display. Total setup is ~20 minutes.

## 0. What you need

- A VPS: Ubuntu 22.04/24.04, **2 GB RAM minimum** (Chromium is hungry), any provider
  (Hetzner ~€4/mo, Contabo, DigitalOcean, Vultr…). You get an IP + SSH root access.
- Your local project working (you can `npm run scan` locally and get alerts).

> Tip: pick a VPS region whose IP is "boring" for your PO account (same country you
> normally log in from, if possible). A sudden datacenter IP can trigger a re-login.

## 1. Prepare the VPS (run on the VPS via SSH)

```bash
# Create a non-root user that will run the bot
adduser --disabled-password --gecos "" pocket

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs xvfb

# Everything else happens as the bot user
su - pocket
mkdir -p ~/pocketvision
exit
```

## 2. Copy the project from your PC (run on your PC, PowerShell)

```powershell
# From the project folder. node_modules is rebuilt on the VPS — don't copy it.
scp -r src package.json package-lock.json tsconfig.json supabase deploy docs pocket@YOUR_VPS_IP:~/pocketvision/

# Secrets + login session (the two things that make it YOUR bot):
scp .env pocket@YOUR_VPS_IP:~/pocketvision/.env
scp -r .auth pocket@YOUR_VPS_IP:~/pocketvision/.auth
```

The `.auth/chrome-profile` folder carries your logged-in PO session to the VPS —
that's the documented design (log in once locally, reuse everywhere).

## 3. Install on the VPS (as the `pocket` user)

```bash
su - pocket
cd ~/pocketvision
npm install
npx playwright install --with-deps chromium   # if it asks for sudo deps, run this line as root once

# One manual smoke test under the virtual display:
xvfb-run -a npm run scan
# You should see the banner, connections climbing, and a Telegram test alert path.
# Ctrl+C to stop (graceful: drains Telegram, closes the browser).
```

Check `.env` on the VPS — everything you tuned locally applies. Two VPS notes:
- keep `HEADLESS=false` and run under `xvfb-run` (headful in a virtual display is the
  least bot-detectable), or set `HEADLESS=true` and drop xvfb-run;
- fill `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for cloud persistence (see §5).

## 4. Run it forever (systemd)

```bash
# as root
cp /home/pocket/pocketvision/deploy/pocketvision.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pocketvision

journalctl -u pocketvision -f     # live logs
```

What you now have:
- **Crash → auto-restart** (`Restart=always`, 30 s delay).
- **Reboot → auto-start** (`enable`).
- **Feed dies → the built-in watchdog** reloads the terminal and reconnects, and
  Telegram-warns you either way.
- **Hourly 💓 heartbeat** on Telegram — if the pings stop, the box itself is down.

Useful commands: `systemctl stop|start|restart pocketvision`, `systemctl status pocketvision`.

## 5. Supabase (cloud history of alerts + outcomes)

1. Create a free project at https://supabase.com → New project.
2. Dashboard → SQL Editor → paste the contents of `supabase/schema.sql` → Run.
3. Dashboard → Settings → API: copy the **Project URL** and the **service_role key**.
4. Put them in the VPS `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
5. `systemctl restart pocketvision` — the banner should show `Supabase: ENABLED`.

Every alert, every outcome, and every heartbeat now lands in Supabase (Table Editor →
`alerts` / `outcomes` / `heartbeats`), regardless of which machine wrote it. The
service-role key stays on the VPS only — it bypasses row security by design.

## 6. When the PO session eventually expires

Pocket Option sessions last a long time with daily use, but not forever. Symptoms: the
scanner exits at startup with "No auth frame was captured — session may have expired",
or the watchdog warns repeatedly and never recovers. Fix:

```powershell
# On your PC: log in fresh, then re-ship the profile
npm run login
scp -r .auth pocket@YOUR_VPS_IP:~/pocketvision/.auth
```
then `systemctl restart pocketvision` on the VPS.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `browserType.launchPersistentContext` fails | `npx playwright install --with-deps chromium` not run, or no xvfb with HEADLESS=false |
| Catalog timeout, "market-data servers not responding" | PO-side throttle — wait; the service auto-retries every 30 s via systemd restart |
| Telegram silent but service running | check `journalctl` for `Telegram send failed` (token/chat id) |
| Heartbeats stopped | `systemctl status pocketvision`; if active, check journal for watchdog messages |
