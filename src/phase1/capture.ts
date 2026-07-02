/**
 * Shared WebSocket capture wiring for Phase 1 tools.
 *
 * Attaches to every WebSocket a context opens, reassembles Socket.IO binary
 * events, and hands each completed frame to a sink. A `null` frame signals an
 * orphan binary chunk (a binary frame with no pending event header).
 */
import type { BrowserContext, Page } from 'playwright';
import { SocketIOReassembler, type ParsedFrame } from '../lib/socketio.js';

export type FrameSink = (frame: ParsedFrame | null, dir: 'recv' | 'send', url: string) => void;

export function attachCapture(context: BrowserContext, sink: FrameSink): void {
  const hook = (page: Page) => {
    page.on('websocket', (ws) => {
      const url = ws.url();
      const reassembler = new SocketIOReassembler();

      const handle = (payload: string | Buffer, dir: 'recv' | 'send') => {
        if (typeof payload === 'string') {
          const res = reassembler.textFrame(payload);
          if (res.done) sink(res.done, dir, url);
        } else {
          const res = reassembler.binaryFrame(payload);
          if (res.done) sink(res.done, dir, url);
          else if (res.orphan) sink(null, dir, url);
        }
      };

      ws.on('framereceived', (d) => handle(d.payload, 'recv'));
      ws.on('framesent', (d) => handle(d.payload, 'send'));
    });
  };

  for (const page of context.pages()) hook(page);
  context.on('page', hook);
}
