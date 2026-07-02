/**
 * In-page multi-connection feed manager (Phase 3).
 *
 * Installed via page.addInitScript so it runs before Pocket Option's own code.
 * It:
 *   1. Taps window.WebSocket to capture PO's own `auth` frame + market socket URL.
 *   2. Exposes window.__feedAdd(symbols[]) to open ONE raw connection per symbol
 *      (proven model: one active pair per connection), each running the full
 *      handshake → auth → changeSymbol + subfor, with auto-reconnect.
 *
 * The connections use the ORIGINAL WebSocket, so Playwright still observes their
 * frames and our Node-side capture decodes the tick stream per symbol.
 *
 * This function is serialized to the browser — it must be fully self-contained.
 */
export function installFeed(): void {
  // tsx/esbuild wraps the named inner functions below in a `__name(...)` helper
  // that lives at MODULE scope — it is not carried along when Playwright
  // serializes this function into the page, so shim it or the script throws
  // `__name is not defined` before __feedAdd/__feedStatus are ever defined.
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;

  const w = window as unknown as Record<string, any>;
  if (w.__feedInstalled) return;
  w.__feedInstalled = true;

  const OrigWS = window.WebSocket;
  w.__po = { auth: null as string | null, marketUrl: null as string | null, conns: {} as Record<string, unknown>, connected: {} as Record<string, boolean> };

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

  function connect(symbol: string): void {
    if (!w.__po.auth || !w.__po.marketUrl) return;
    if (w.__po.conns[symbol]) return; // already tracked — never double-connect

    let stopped = false;
    let ws: WebSocket;
    let retryMs = 2000;
    const open = () => {
      // Re-read on every (re)connect: PO rotates its session, and replaying a
      // stale auth frame makes every reconnect fail forever. The proxy above
      // keeps __po.auth refreshed whenever PO's own socket re-authenticates.
      const auth: string = w.__po.auth;
      ws = new OrigWS(w.__po.marketUrl);
      ws.onmessage = (e: MessageEvent) => {
        const d = e.data;
        if (typeof d !== 'string') return;
        if (d[0] === '0') ws.send('40');
        else if (d.slice(0, 2) === '40') ws.send(auth);
        else if (d.indexOf('successauth') >= 0) {
          ws.send(`42["changeSymbol",{"asset":"${symbol}","period":1}]`);
          ws.send(`42["subfor","${symbol}"]`);
          w.__po.connected[symbol] = true;
          retryMs = 2000; // healthy again → reset backoff
        }
      };
      ws.onclose = () => {
        w.__po.connected[symbol] = false;
        if (stopped) return;
        // Exponential backoff + jitter. A fixed 2s retry across 40 sockets is
        // a connection storm that gets the whole IP throttled server-side.
        retryMs = Math.min(retryMs * 2, 60_000);
        setTimeout(open, retryMs + Math.floor(Math.random() * 1000));
      };
      ws.onerror = () => { /* close handler reconnects */ };
    };
    open();
    w.__po.conns[symbol] = { stop: () => { stopped = true; try { ws.close(); } catch { /* ignore */ } } };
  }

  // Open connections, staggered, to avoid a thundering herd on the server.
  w.__feedAdd = (symbols: string[]): number => {
    const fresh = symbols.filter((s) => !w.__po.conns[s]);
    fresh.forEach((s, i) => setTimeout(() => connect(s), i * 50));
    return fresh.length;
  };

  // Stop + forget connections (dynamic watchlist refresh).
  w.__feedRemove = (symbols: string[]): number => {
    let n = 0;
    for (const s of symbols) {
      const c = w.__po.conns[s];
      if (c && typeof c.stop === 'function') { c.stop(); n++; }
      delete w.__po.conns[s];
      delete w.__po.connected[s];
    }
    return n;
  };

  w.__feedStatus = () => {
    const conns = Object.keys(w.__po.conns).length;
    const live = Object.values(w.__po.connected).filter(Boolean).length;
    return { conns, live, authReady: Boolean(w.__po.auth) };
  };
}
