# Running PocketVision 24/7 on a Windows VPS (Kamatera)

Your VPS: Windows Server 2025, 4 CPU / 4 GB RAM — more than enough.
Only RDP (remote desktop) is reachable from outside, so deployment happens
through an RDP session. Total time: ~15 minutes, three steps.

## Step 1 — Build the bundle (on your PC)

Stop the scanner if it's running (press ENTER in its window), then:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\make-bundle.ps1
```

This creates `pocketvision-vps.zip` (~100 MB) containing the code, your `.env`
(Telegram + Supabase keys) and your logged-in `.auth` browser profile.

## Step 2 — Copy it to the VPS over RDP

1. Press `Win`, type `mstsc`, Enter.
2. Computer: `103.125.218.46` → **Show Options → Local Resources → Clipboard ✓**
   (for drag-free copy-paste), then Connect.
3. User `administrator`, your VPS password.
4. On your PC, right-click `pocketvision-vps.zip` → **Copy**. In the RDP window,
   open the VPS desktop, right-click → **Paste** (RDP clipboard carries files).
5. On the VPS: right-click the zip → **Extract All…** → extract to `C:\pocketvision`
   (make sure the files land directly in `C:\pocketvision`, not a nested subfolder).

## Step 3 — Run the installer (on the VPS)

Open PowerShell **as Administrator** on the VPS:

```powershell
cd C:\pocketvision
powershell -ExecutionPolicy Bypass -File deploy\vps-setup-windows.ps1
```

The script installs Node, the dependencies, and Chromium; registers a
**PocketVision** scheduled task (starts at logon, auto-restarts if it crashes);
and offers **auto-logon** — answer `y` so a VPS reboot brings the bot back
without you. Then start it:

```powershell
Start-ScheduledTask -TaskName PocketVision
Get-Content logs\service.log -Wait -Tail 20     # live log
```

You should see the usual banner, `Supabase: ENABLED`, connections climbing,
and the Telegram heartbeat within the hour. Disconnect RDP (just close the
window — do NOT "sign out") and the bot keeps running.

## Expected first-run hiccup: Pocket Option and the new IP

Your login profile was created from your home IP; the VPS is in Sydney. PO may
accept the copied session — or it may demand a fresh login. If the log says
`No auth frame was captured — the session may have expired`:

1. In the RDP session, run: `cd C:\pocketvision; npm run login`
2. Log in to Pocket Option in the browser window that opens (solve any
   verification email/captcha), then close it.
3. `Start-ScheduledTask -TaskName PocketVision` — from then on the session
   renews itself with daily use.

## Upgrading to the money engine (2026-07-06 build)

The build adds holdout/decay validation, the risk manager, the PO timestamp
fix, and two new **paper** streams (crypto scan + funding harvester — public
data, no keys, no browser). To upgrade a VPS that already runs PocketVision:

On your PC: stop the local scanner, then `deploy\make-bundle.ps1`, copy the
zip over RDP as usual. On the VPS (PowerShell as Administrator):

```powershell
cd C:\pocketvision
Stop-ScheduledTask -TaskName PocketVision
Get-Process node, chrome -ErrorAction SilentlyContinue | Stop-Process -Force
# Extract the new zip over C:\pocketvision (replace all). Keep the VPS's own
# .auth if its session is newer than the bundled one.
npm run migrate:tz          # one-time: shifts old outcome records to true UTC
powershell -ExecutionPolicy Bypass -File deploy\vps-add-streams.ps1
Start-ScheduledTask -TaskName PocketVision
Start-ScheduledTask -TaskName PocketVisionCrypto
Start-ScheduledTask -TaskName PocketVisionFunding
```

Then stop any copies still running on your PC — two scanners on one Telegram
chat means every alert arrives twice.

## Day-to-day

| What | How |
|---|---|
| Is it alive? | 💓 heartbeat on Telegram every hour; `heartbeats` table in Supabase |
| See logs | RDP in → `Get-Content C:\pocketvision\logs\service.log -Wait -Tail 50` |
| Stop / start | `Stop-ScheduledTask` / `Start-ScheduledTask -TaskName PocketVision` |
| Change settings | edit `C:\pocketvision\.env`, then restart the task |
| Win-rate report | `cd C:\pocketvision; npm run report` (or query Supabase from anywhere) |
| Update the code | re-run Step 1 + 2 with a new zip, extract over the old folder (keep `.auth`), restart task |

Security notes: consider changing the VPS password after setup (it travelled
through email/chat), and remember the bundle zip contains your secrets —
delete it from the VPS desktop after extracting.
