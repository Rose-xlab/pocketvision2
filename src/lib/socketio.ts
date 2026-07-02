/**
 * Minimal Engine.IO / Socket.IO v3/v4 text-frame parser — enough to classify
 * Pocket Option feed frames for the Phase 1 discovery spike. We do NOT need a
 * full client; we only need to pull the event name and payload out of frames
 * so we can answer "does the feed carry all pairs or just the selected one?".
 *
 * Engine.IO packet types (first char):  0 open, 1 close, 2 ping, 3 pong,
 *   4 message, 5 upgrade, 6 noop.
 * Socket.IO packet types (char after a "4"): 0 connect, 1 disconnect,
 *   2 event, 3 ack, 4 connect_error, 5 binary_event, 6 binary_ack.
 */

export interface ParsedFrame {
  /** Raw frame text, untouched. */
  raw: string;
  /** Engine.IO packet type digit, if the frame started with one. */
  engineType?: number;
  /** Socket.IO packet type digit, for message frames. */
  socketType?: number;
  /** Optional Socket.IO namespace (e.g. "/live"). */
  namespace?: string;
  /** Event name (first array element) for EVENT frames. */
  event?: string;
  /** Payload = the array elements after the event name (EVENT frames). */
  args?: unknown[];
  /** Full parsed JSON if the frame body parsed cleanly. */
  json?: unknown;
  /** True when the frame is a plain ping/pong/open heartbeat. */
  heartbeat?: boolean;
  /** For BINARY_EVENT (5)/BINARY_ACK (6): number of binary frames that follow. */
  binaryAttachments?: number;
}

/** Locate the first JSON value (array or object) in a frame body and parse it. */
function extractJson(body: string): { json?: unknown; jsonStart: number } {
  const firstBracket = body.search(/[[{]/);
  if (firstBracket === -1) return { jsonStart: -1 };
  try {
    return { json: JSON.parse(body.slice(firstBracket)), jsonStart: firstBracket };
  } catch {
    return { jsonStart: firstBracket };
  }
}

export function parseFrame(raw: string): ParsedFrame {
  if (raw.length === 0) return { raw, heartbeat: true };

  const engineType = Number(raw[0]);
  const result: ParsedFrame = { raw, engineType };

  // Ping / pong / open / close heartbeats carry no event payload.
  if (engineType === 2 || engineType === 3) return { ...result, heartbeat: true };
  if (engineType !== 4) {
    // open(0)/upgrade(5)/noop(6) or a non-EngineIO frame — try to grab JSON anyway.
    const { json } = extractJson(raw.slice(1));
    return { ...result, json, heartbeat: engineType === 0 };
  }

  // Engine.IO message → the rest is a Socket.IO packet.
  let body = raw.slice(1);
  const socketType = Number(body[0]);
  result.socketType = socketType;
  body = body.slice(1);

  // BINARY_EVENT (5) / BINARY_ACK (6) prefix the payload with "<count>-".
  if (socketType === 5 || socketType === 6) {
    const attMatch = body.match(/^(\d+)-/);
    if (attMatch) {
      result.binaryAttachments = Number(attMatch[1]);
      body = body.slice(attMatch[0].length);
    }
  }

  // Optional namespace prefix: "/name," before the payload / ack id.
  const nsMatch = body.match(/^(\/[^,]+),/);
  if (nsMatch) {
    result.namespace = nsMatch[1];
    body = body.slice(nsMatch[0].length);
  }

  const { json } = extractJson(body);
  result.json = json;

  // EVENT (2) / BINARY_EVENT (5): payload is [eventName, ...args].
  if ((socketType === 2 || socketType === 5) && Array.isArray(json) && typeof json[0] === 'string') {
    result.event = json[0];
    result.args = json.slice(1);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Binary attachment handling
// ─────────────────────────────────────────────────────────────

export interface DecodedBinary {
  /** 'json' if the buffer was UTF-8 JSON; 'binary' if opaque (e.g. msgpack). */
  kind: 'json' | 'binary';
  value?: unknown;
  /** For opaque buffers: first bytes as hex, to fingerprint the encoding. */
  hexHead?: string;
  base64?: string;
  length: number;
}

/** Try to decode a binary attachment. PO often ships JSON as a binary buffer. */
export function decodeBinary(buf: Buffer): DecodedBinary {
  try {
    const text = buf.toString('utf8').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      return { kind: 'json', value: JSON.parse(text), length: buf.length };
    }
  } catch {
    /* fall through to opaque */
  }
  return {
    kind: 'binary',
    hexHead: buf.subarray(0, 16).toString('hex'),
    base64: buf.subarray(0, 192).toString('base64'),
    length: buf.length,
  };
}

/** Replace {_placeholder:true,num:k} nodes with the k-th decoded attachment. */
function substitutePlaceholders(value: unknown, decoded: DecodedBinary[]): unknown {
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, decoded));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj._placeholder === true && typeof obj.num === 'number') {
      const d = decoded[obj.num];
      if (!d) return obj;
      return d.kind === 'json' ? d.value : { __binary: true, length: d.length, hexHead: d.hexHead };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = substitutePlaceholders(v, decoded);
    return out;
  }
  return value;
}

/**
 * Reassembles Socket.IO binary events across WebSocket frames. A BINARY_EVENT
 * text header (`45<n>-[event,{_placeholder…}]`) is followed by <n> binary
 * frames; we buffer them, decode, and splice them back into the event args so
 * the analyzer sees the real payload (candles/ticks), not a placeholder.
 *
 * One instance per WebSocket (frame order is per-socket).
 */
export class SocketIOReassembler {
  private pending: { frame: ParsedFrame; need: number; buffers: Buffer[] } | null = null;

  /** Feed a text frame. Returns the completed frame unless it opens a binary event. */
  textFrame(raw: string): { done?: ParsedFrame; waitingForBinary?: boolean } {
    const frame = parseFrame(raw);
    if (frame.socketType === 5 && frame.binaryAttachments && frame.binaryAttachments > 0) {
      this.pending = { frame, need: frame.binaryAttachments, buffers: [] };
      return { waitingForBinary: true };
    }
    return { done: frame };
  }

  /** Feed a binary frame. Returns the completed event once all attachments arrive. */
  binaryFrame(buf: Buffer): { done?: ParsedFrame; orphan?: boolean; partial?: boolean } {
    if (!this.pending) return { orphan: true };
    this.pending.buffers.push(buf);
    if (this.pending.buffers.length < this.pending.need) return { partial: true };

    const { frame, buffers } = this.pending;
    this.pending = null;
    const decoded = buffers.map(decodeBinary);
    const args = substitutePlaceholders(frame.args, decoded) as unknown[];
    const anyOpaque = decoded.some((d) => d.kind === 'binary');
    return { done: { ...frame, args, json: args, binaryAttachments: anyOpaque ? frame.binaryAttachments : 0 } };
  }
}
