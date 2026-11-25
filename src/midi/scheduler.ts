// Outbound MIDI scheduler.
//
// The Ambika listens on a 31.25 kbaud DIN port (3125 bytes/s). USB-MIDI
// interfaces accept data much faster and some overflow their DIN buffer, so
// every byte we send goes through a per-port token bucket (default
// 2500 bytes/s, ~80% of the wire, leaving room for notes) and three priority
// lanes:
//
//   realtime  single-parameter edits (coalesced per key, rate-limited per key)
//   request   dump / version / name requests
//   bulk      full patch pushes, part pushes, librarian sends
//
// Items are built lazily (`build()` runs when the item is sent) so a patch push
// queued before an edit still carries the edit, and the NRPN running-address
// cache sees the order in which bytes really leave.

export type Lane = 'realtime' | 'request' | 'bulk';
const LANES: Lane[] = ['realtime', 'request', 'bulk'];

export interface OutboundItem {
  lane: Lane;
  /** Coalescing key: a queued item with the same key and lane is replaced in place. */
  key?: string;
  /** Minimum time between two sends of the same key (needs `key`). */
  minIntervalMs?: number;
  /** Silence after this item, e.g. to let the synth digest a SysEx dump. */
  gapAfterMs?: number;
  build: () => Uint8Array;
  onSent?: (bytes: Uint8Array) => void;
}

export interface Clock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  bytesPerSecond?: number;
  /** Bucket depth: how many bytes may leave back to back after a pause. */
  burstBytes?: number;
  clock?: Clock;
}

export const DEFAULT_BYTES_PER_SECOND = 2500;
export const DEFAULT_BURST_BYTES = 96;

/** Wire time of `bytes` on a 31.25 kbaud link, in ms (10 bits per byte). */
export function wireTimeMs(bytes: number): number {
  return (bytes * 10 * 1000) / 31250;
}

export class OutboundScheduler {
  private readonly queues: Record<Lane, OutboundItem[]> = { realtime: [], request: [], bulk: [] };
  private readonly lastSentByKey = new Map<string, number>();
  private readonly clock: Clock;
  private tokens: number;
  private lastRefill: number;
  private blockedUntil = 0;
  private timer: unknown = null;
  private timerAt = Infinity;
  bytesPerSecond: number;
  readonly burstBytes: number;
  /** Bytes handed to `send` since creation (for the UI's traffic meter). */
  bytesSent = 0;

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    options: SchedulerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.bytesPerSecond = options.bytesPerSecond ?? DEFAULT_BYTES_PER_SECOND;
    this.burstBytes = options.burstBytes ?? DEFAULT_BURST_BYTES;
    this.tokens = this.burstBytes;
    this.lastRefill = this.clock.now();
  }

  enqueue(item: OutboundItem): void {
    const queue = this.queues[item.lane];
    if (item.key !== undefined) {
      const index = queue.findIndex((q) => q.key === item.key);
      if (index >= 0) {
        queue[index] = item;
        this.pump();
        return;
      }
    }
    queue.push(item);
    this.pump();
  }

  /** Number of queued items, optionally for one lane. */
  pending(lane?: Lane): number {
    return lane ? this.queues[lane].length : LANES.reduce((n, l) => n + this.queues[l].length, 0);
  }

  clear(lane?: Lane): void {
    for (const l of lane ? [lane] : LANES) this.queues[l].length = 0;
  }

  dispose(): void {
    this.clear();
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    this.lastRefill = now;
    this.tokens = Math.min(this.burstBytes, this.tokens + (elapsed * this.bytesPerSecond) / 1000);
  }

  /** Earliest time a keyed item may be sent again. */
  private readyAt(item: OutboundItem): number {
    if (item.key === undefined || !item.minIntervalMs) return 0;
    const last = this.lastSentByKey.get(item.key);
    return last === undefined ? 0 : last + item.minIntervalMs;
  }

  /** Next item to send at `now`, or the earliest time something becomes eligible. */
  private pick(now: number): { lane: Lane; index: number } | { wakeAt: number } | null {
    let wakeAt = Infinity;
    for (const lane of LANES) {
      const queue = this.queues[lane];
      // Realtime edits are independent per key, so any eligible one may go.
      // Requests and bulk transfers keep strict FIFO order.
      const scan = lane === 'realtime' ? queue.length : Math.min(1, queue.length);
      for (let i = 0; i < scan; i++) {
        const at = this.readyAt(queue[i]);
        if (at <= now) return { lane, index: i };
        wakeAt = Math.min(wakeAt, at);
      }
    }
    return wakeAt === Infinity ? null : { wakeAt };
  }

  /** Sends whatever the budget allows now and arms a timer for the rest. */
  pump(): void {
    for (;;) {
      const now = this.clock.now();
      this.refill(now);
      if (now < this.blockedUntil) return this.arm(this.blockedUntil);
      if (this.tokens <= 0) {
        return this.arm(now + (-this.tokens * 1000) / this.bytesPerSecond + 1);
      }
      const choice = this.pick(now);
      if (choice === null) return;
      if ('wakeAt' in choice) return this.arm(choice.wakeAt);
      const [item] = this.queues[choice.lane].splice(choice.index, 1);
      const bytes = item.build();
      if (bytes.length === 0) continue;
      this.send(bytes);
      this.bytesSent += bytes.length;
      // The bucket may go into debt for a message larger than its depth (a
      // 235-byte patch dump); the debt is paid back before anything else goes.
      this.tokens -= bytes.length;
      if (item.key !== undefined) this.lastSentByKey.set(item.key, now);
      if (item.gapAfterMs) this.blockedUntil = now + item.gapAfterMs;
      item.onSent?.(bytes);
    }
  }

  private arm(at: number): void {
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timerAt = at;
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump();
    }, Math.max(0, at - this.clock.now()));
  }
}
