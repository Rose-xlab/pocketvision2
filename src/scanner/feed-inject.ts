/**
 * In-page rotating feed manager (Phase 3, v2).
 *
 * Installed via page.addInitScript so it runs before Pocket Option's own code.
 * It:
 *   1. Taps window.WebSocket to capture PO's own `auth` frame + market socket URL.
 *   2. Keeps a SMALL POOL of persistent connections (default 6) and rotates each
 *      one across the watchlist with `changeSymbol` every dwell interval. One
 *      socket streams exactly one pair at a time (proven by the multiconn probe:
 *      extra `subfor` subscriptions are ignored), but every `changeSymbol` also
 *      triggers a 7–10 min `updateHistoryNewFast` backfill — so a pair visited
 *      every sweep never misses a candle.
 *   3. Supports PINNING: a hot pair (streak near threshold) claims a socket and
 *      stays live on it until unpinned, so alert candles stream in real time.
 *
 * Re-pointing a live socket avoids connection churn entirely — the pool is
 * opened once and reused, which is what keeps us under PO's per-IP socket
 * ceiling (hammering reconnects is what got the IP throttled before).
 *
 * The connections use the ORIGINAL WebSocket, so Playwright still observes
 * their frames and our Node-side capture decodes the tick stream per symbol.
 *
 * This function is serialized to the browser — it must be fully self-contained.
 */
export function installFeed(): void {
  // tsx/esbuild wraps the named inner functions below in a `__name(...)` helper
  // that lives at MODULE scope — it is not carried along when Playwright
  // serializes this function into the page, so shim it or the script throws
  // `__name is not defined` before the __feed* API is ever defined.
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;

  const w = window as unknown as Record<string, any>;
  if (w.__feedInstalled) return;
  w.__feedInstalled = true;

  const OrigWS = window.WebSocket;
  w.__po = {
    auth: null as string | null,
    marketUrl: null as string | null,
    // Circuit breaker: recent close timestamps (all sockets) + global pause.
    drops: [] as number[],
    pausedUntil: 0,
  };

  // Tap PO's own socket to steal the auth frame (reused for our connections).
  w.WebSocket = new Proxy(OrigWS, {
    construct(target, args: unknown[]) {
      const ws = Reflect.construct(target, args) as WebSocket;
      const url = String(args[0]);
      const origSend = ws.send.bind(ws);
      ws.send = (d: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        try {
          if (typeof d === 'string' && d.startsWith('42["auth"') && url.includes('po.market')) {
            w.__po.auth = d;
            w.__po.marketUrl = url;
          }
        } catch { /* ignore */ }
        return origSend(d as string);
      };
      return ws;
    },
  });

  interface Sock {
    idx: number;
    ws: WebSocket | null;
    alive: boolean;
    /** Symbol this socket is currently streaming (null while down/idle). */
    current: string | null;
    /** Pinned symbol: rotation stops and the socket holds this pair live. */
    pin: string | null;
    /** Rotation visits since this socket was (re)opened — drives recycling. */
    visits: number;
    /** Intentional close in progress: skip breaker/backoff, reconnect fast. */
    recycling: boolean;
    retryMs: number;
    stableTimer: ReturnType<typeof setTimeout> | undefined;
    dwellTimer: ReturnType<typeof setTimeout> | undefined;
    /** App-level keepalive: the real client sends 42["ps"] every ~60s. */
    psTimer: ReturnType<typeof setInterval> | undefined;
    stopped: boolean;
  }

  // Long-run hygiene: retire a rotating socket every ~40 visits (≈17 min).
  // The 2–4 min shed cycle turned out to be heartbeat starvation (no ps/pong),
  // not a visit budget — recycling stays only as cheap insurance against
  // slow server-side state buildup on very long sessions.
  const RECYCLE_AFTER_VISITS = 40;

  const pool: Sock[] = [];
  const rot = { list: [] as string[], cursor: 0, dwellMs: 12_000, started: false };

  const heldBy = (sym: string): Sock | undefined => pool.find((s) => s.alive && s.current === sym);

  /** Next watchlist symbol not already streamed or pinned on another socket. */
  function nextSymbol(): string | null {
    const list = rot.list;
    if (list.length === 0) return null;
    for (let i = 0; i < list.length; i++) {
      const sym = list[rot.cursor % list.length]!;
      rot.cursor++;
      if (!heldBy(sym) && !pool.some((s) => s.pin === sym)) return sym;
    }
    return null; // watchlist smaller than pool — everything is already covered
  }

  function subscribe(sock: Sock, sym: string): void {
    try {
      // Unsubscribe the pair we're leaving — the real PO terminal does this on
      // every chart switch. Without it a rotating socket accumulates server-side
      // subscriptions until PO kills it (~7–10 visits, the observed shed cycle).
      if (sock.current && sock.current !== sym) sock.ws!.send(`42["unsubfor","${sock.current}"]`);
      sock.current = sym;
      sock.ws!.send(`42["changeSymbol",{"asset":"${sym}","period":1}]`);
      sock.ws!.send(`42["subfor","${sym}"]`);
    } catch { /* dead socket — onclose will handle it */ }
  }

  /** One dwell step: hold the pin, advance to the next symbol, or recycle. */
  function rotate(sock: Sock): void {
    clearTimeout(sock.dwellTimer);
    if (!sock.stopped) sock.dwellTimer = setTimeout(() => rotate(sock), rot.dwellMs);
    if (!sock.alive) return;
    if (sock.pin) {
      if (sock.current !== sock.pin) subscribe(sock, sock.pin);
      return;
    }
    // Planned retirement — but only while every other socket is up, so at
    // most one socket is ever in handover and coverage never dips.
    if (sock.visits >= RECYCLE_AFTER_VISITS && pool.every((s) => s === sock || s.alive)) {
      sock.visits = 0;
      sock.recycling = true;
      try { sock.ws!.close(); } catch { /* already dead */ }
      return;
    }
    const sym = nextSymbol();
    if (sym) { sock.visits++; subscribe(sock, sym); }
  }

  function openSock(sock: Sock): void {
    if (sock.stopped) return;
    if (!w.__po.auth || !w.__po.marketUrl) {
      setTimeout(() => openSock(sock), 2000); // auth not captured yet
      return;
    }
    // Re-read on every (re)connect: PO rotates its session, and replaying a
    // stale auth frame makes every reconnect fail forever. The proxy above
    // keeps __po.auth refreshed whenever PO's own socket re-authenticates.
    const auth: string = w.__po.auth;
    const ws = new OrigWS(w.__po.marketUrl);
    sock.ws = ws;
    ws.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (typeof d !== 'string') return;
      // Engine.IO protocol ping → pong. The real Socket.IO client does this
      // automatically; a raw socket that never pongs gets disconnected.
      if (d[0] === '2') { ws.send('3' + d.slice(1)); return; }
      if (d[0] === '0') ws.send('40');
      else if (d.slice(0, 2) === '40') ws.send(auth);
      else if (d.indexOf('successauth') >= 0) {
        sock.alive = true;
        sock.visits = 0; // fresh connection → fresh server-side budget
        // App-level heartbeat: the real PO terminal sends 42["ps"] every ~60s.
        // Sockets that never send it are culled after a few minutes — the
        // shed cycle that plagued every earlier architecture.
        clearInterval(sock.psTimer);
        sock.psTimer = setInterval(() => { try { ws.send('42["ps"]'); } catch { /* dying */ } }, 55_000);
        // Only reset the backoff after the socket has STAYED up for a while.
        // Resetting on auth alone lets an authed-then-dropped socket retry at
        // ~2s forever — the flapping storm that gets the IP banned.
        clearTimeout(sock.stableTimer);
        sock.stableTimer = setTimeout(() => { sock.retryMs = 2000; }, 60_000);
        rotate(sock); // start streaming immediately (pin or next in line)
      }
    };
    ws.onclose = () => {
      sock.alive = false;
      sock.current = null;
      clearTimeout(sock.stableTimer);
      clearInterval(sock.psTimer);
      if (sock.stopped) return;
      if (sock.recycling) {
        // Planned handover, not a failure: no breaker, no backoff — reopen
        // almost immediately with a fresh server-side budget.
        sock.recycling = false;
        setTimeout(() => openSock(sock), 500 + Math.floor(Math.random() * 1000));
        return;
      }
      // Circuit breaker: when the server is shedding connections en masse,
      // reconnecting individually only escalates a per-socket limit into an
      // IP-level throttle. If half the pool dropped inside a minute, pause
      // ALL reconnects for 4 minutes.
      const now = Date.now();
      const drops: number[] = w.__po.drops;
      drops.push(now);
      while (drops.length > 0 && now - drops[0]! > 60_000) drops.shift();
      // Pause 2 min, not 4: a 6-socket pool reconnecting is not a storm, and
      // every extra paused minute is a coverage gap for the whole watchlist.
      if (now >= w.__po.pausedUntil && pool.length >= 2 && drops.length >= pool.length / 2) {
        w.__po.pausedUntil = now + 120_000;
        drops.length = 0;
      }
      sock.retryMs = Math.min(sock.retryMs * 2, 60_000);
      const paused = w.__po.pausedUntil - now;
      // Wide jitter after a breaker pause so the pool doesn't resume at once.
      const jitter = paused > 0 ? 15_000 : 1000;
      setTimeout(() => openSock(sock), Math.max(sock.retryMs, paused) + Math.floor(Math.random() * jitter));
    };
    ws.onerror = () => { /* close handler reconnects */ };
  }

  /** Start the pool (idempotent) and set the rotation watchlist. */
  w.__feedStart = (symbols: string[], poolSize: number, dwellSec: number): number => {
    rot.list = symbols.slice();
    rot.dwellMs = Math.max(3, dwellSec) * 1000;
    if (!rot.started) {
      rot.started = true;
      const n = Math.max(1, Math.floor(poolSize));
      for (let i = 0; i < n; i++) {
        const sock: Sock = { idx: i, ws: null, alive: false, current: null, pin: null, visits: 0, recycling: false, retryMs: 2000, stableTimer: undefined, dwellTimer: undefined, psTimer: undefined, stopped: false };
        pool.push(sock);
        setTimeout(() => openSock(sock), i * 400); // stagger the pool open
      }
    }
    return rot.list.length;
  };

  /** Replace the rotation watchlist (dynamic refresh). Clears orphaned pins. */
  w.__feedSetWatchlist = (symbols: string[]): number => {
    rot.list = symbols.slice();
    const wanted = new Set(symbols);
    for (const s of pool) if (s.pin && !wanted.has(s.pin)) s.pin = null;
    return rot.list.length;
  };

  /** Pin a hot pair to a socket for real-time streaming. Returns success. */
  w.__feedPin = (sym: string): boolean => {
    if (pool.some((s) => s.pin === sym)) return true;
    const holder = heldBy(sym);
    if (holder && !holder.pin) { holder.pin = sym; return true; }
    const free = pool.find((s) => s.alive && !s.pin) ?? pool.find((s) => !s.pin);
    if (!free) return false;
    free.pin = sym;
    if (free.alive) subscribe(free, sym);
    return true;
  };

  /** Release a pinned pair back into the rotation. */
  w.__feedUnpin = (sym: string): boolean => {
    const s = pool.find((x) => x.pin === sym);
    if (!s) return false;
    s.pin = null;
    return true;
  };

  w.__feedStatus = () => ({
    conns: pool.length,
    live: pool.filter((s) => s.alive).length,
    authReady: Boolean(w.__po.auth),
    paused: w.__po.pausedUntil > Date.now(),
    pinned: pool.filter((s) => s.pin).map((s) => s.pin as string),
    watchlist: rot.list.length,
  });
}
