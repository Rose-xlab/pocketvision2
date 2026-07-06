# PocketVision AI — Candle Streak Scanner

Detects 7+ consecutive red/green 1-minute candles on Pocket Option pairs and sends Telegram alerts.
**Analysis and alerts only — this tool never places trades.**

Built in phases (per the developer brief). We are currently on **Phase 1**.

---

## Phase 1 — Feed-discovery spike ⬅ *you are here*

**Goal:** answer one question before anything else is built — does the Pocket Option feed
expose **all pairs at once**, or **only the currently-selected pair**? The whole design
(multi-pair scan vs. asset-cycling fallback) depends on the answer.

### Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # adjust PO_BASE_URL if your region differs
```

### Run

```bash
# 1. Log in ONCE (headed browser, persistent profile). Your password is typed into
#    Pocket Option only — never read or stored here. The logged-in session is kept
#    in .auth/chrome-profile/ (gitignored) and reused by every later run.
npm run login

# 2. Record the feed. Keep ONE pair selected — do not switch assets during the run.
#    No re-login needed; it reuses the profile from step 1.
npm run spike

# 3. (optional) Re-analyze a saved capture without reopening the browser.
npm run analyze -- logs/frames-<timestamp>.jsonl

# 4. Multi-subscribe probe — decides Phase 3 architecture. Injects extra `subfor`
#    subscriptions on the live market socket and checks if one connection can
#    stream many pairs. Run while OTC markets are active.
npm run probe
```

### What you get
- `logs/frames-<ts>.jsonl` — every WebSocket text frame, **redacted** (tokens/keys/cookies/sessions masked).
- `diagnostics/spike-<ts>.json` — per-event stats, distinct symbols, samples, and a verdict.
- A console summary ending in **`VERDICT: ALL-PAIRS | SELECTED-ONLY | INCONCLUSIVE`**.

That verdict decides Phase 3's shape. We build nothing past this until it's answered.

### Phase 1 result (2026-07-02): **SELECTED-ONLY**
- Live candle stream (`updateStream`) delivers only the subscribed pair.
- A catalog of ~207 pairs is available via `updateAssets` (watchlist source).
- Sockets: `wss://api-*.po.market/socket.io/` (Socket.IO v4); the market feed uses **binary** events.
- **Open sub-question:** does one socket accept many simultaneous `subfor` subscriptions? Probe decides multi-pair-on-one-session vs. asset-cycling.

---

## Phase 2 — one pair, end-to-end ⬅ *in progress*

Ticks → 1-min candles → streak engine → Telegram alert, for the selected pair.

```bash
# Deterministic core tests (no browser/network): candle building + streak logic.
npm run test:core

# Live single-pair scan: reuses your session, seeds from history, prints closed
# candles + running streak, and (if configured) sends Telegram alerts.
npm run scan:one

# Verify Telegram credentials by sending one test alert.
npm run test:telegram
```

Telegram config (in `.env`, gitignored):
```
TELEGRAM_BOT_TOKEN=...   # from BotFather
TELEGRAM_CHAT_ID=...     # your user/group/channel id
STREAK_THRESHOLD=7       # optional overrides
BREAK_ON_DOJI=true
```

**Feed shape:** `updateStream` is a tick feed (`[symbol, epochSec, price]`), so candles are built locally (`src/scanner/candles.ts`); the open convention (first-tick vs previous-close) is validated against the live PO chart.

## Phase 3 — multi-pair scan ⬅ *in progress*

Verified: PO allows **parallel connections on one session**, **one active pair per connection**
(`changeSymbol` is the stream trigger; the auth frame is reusable). So the scanner opens one
Socket.IO connection per watchlist pair, all feeding the same candle/streak engine.

```bash
npm run probe:multiconn   # the spike that proved this (diagnostic)
npm run scan              # the multi-pair scanner
```

Config (`.env`): `WATCHLIST=auto` (all open assets across every class — currencies, crypto,
commodities, stocks, indices — with payout ≥ `MIN_PAYOUT`, best payout first) or a comma list;
`MIN_PAYOUT=87` sets the payout floor; `MAX_PAIRS=40` caps parallel connections. Alerts for a
pair whose payout drops below the floor mid-session are suppressed. Each connection
auto-reconnects; gaps reset that pair's streak so non-consecutive candles are never treated
as consecutive.

Hardening (all tunable in `.env`):
- **Body-size filter** (`MIN_BODY_PCT=10`): a candle only counts as green/red if its body is
  ≥ that % of the asset's average range (rolling 20 candles) — micro-bodies are dojis and
  break streaks, killing the noisiest false signals.
- **Watchdog + heartbeat** (`STALE_FEED_SEC`, `HEARTBEAT_MIN`): no ticks for 60 s → Telegram
  warning + automatic page reload/reconnect (and a "recovered" message); an hourly 💓 ping
  proves the bot is alive, so silence always means "no signals", never "bot died".
- **Outcome tracking v2 (trade intelligence)**: every alert is scored the way a real binary
  trade would resolve — entry = open of the next candle, win/loss at 1-, 2- and 3-candle
  expiries — with features (asset class, body/range, payout) appended to `logs/outcomes.jsonl`.
  Old-format records stay readable.
- **Directional alerts with evidence**: the 2026-07-03/04 data proved fading streaks LOSES
  (46.8% win, EV −10%) while RIDING them is promising (forex: 57.3%, EV +9.8%). Alerts now
  carry a trade instruction (`TRADE: CALL/PUT — ride the streak`) stamped with the live
  measured edge for that asset class (win rate, n, CI, EV), or `OBSERVE ONLY` where no
  positive edge exists. A setup is marked VALIDATED only when its CI lower bound is
  profitable on n ≥ 200 — until then every alert says PAPER ONLY.
- **Edge dashboard**: `npm run report` prints EV + Wilson 95% CI per direction × asset class,
  streak length, expiry, and hour, ending in explicit verdicts (GRADUATED / paper only /
  do not trade) — the evidence layer that decides what is ever traded with real money.
- **Dynamic watchlist** (`WATCHLIST_REFRESH_MIN=10`): the watchlist is rebuilt from live
  payouts/market hours during the session — pairs that drop below the floor are disconnected,
  newly eligible ones are added.

## Phase 4 — Supabase + 24/7 VPS

The scanner persists every alert, outcome, and heartbeat to Supabase when
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set in `.env` (run
`supabase/schema.sql` once in the Supabase SQL Editor first; RLS is on and only
the service key can write). Telegram stays the instant-alert path — Supabase is
the durable, queryable history behind it.

For always-on remote operation see **[docs/VPS-WINDOWS.md](docs/VPS-WINDOWS.md)**
(Windows Server: one-file bundle via `deploy/make-bundle.ps1`, one-shot installer
`deploy/vps-setup-windows.ps1`, scheduled task + auto-logon) or
**[docs/VPS.md](docs/VPS.md)** (Ubuntu: systemd unit under xvfb). Either way you
get crash-restart, reboot-start, watchdog recovery, and hourly heartbeats; the
scanner shuts down cleanly on SIGTERM (drains Telegram, closes the browser).

## Roadmap
- **Phase 5** — access: login-protected realtime dashboard (anon key + read policies), CSV export.

## Security notes (from the brief, section 10)
- Pocket Option password is **never** stored — you log in by hand; only cookies/localStorage are saved locally.
- Debug/spike output is **redacted** for tokens, keys, cookies, and session ids.
- Credentials (Telegram/Supabase) will live in env vars, never hardcoded.
- Supabase **service role key** will live only on the VPS scanner — never shipped to the browser.
- `.auth/`, `logs/`, `diagnostics/`, and `.env` are all gitignored.
