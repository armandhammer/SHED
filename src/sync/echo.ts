// Echo filter for MIDI out modes that forward the Ambika's input.
//
// With System → outp mode set to `full` (or `chain`), the Ambika copies every
// message it receives to its output, so SHED hears its own NRPNs and SysEx
// back, interleaved with the synth's own edits. Two things go wrong if those
// echoes are decoded as hardware edits:
//   - an echoed CC99/98 moves SHED's NRPN address latch, but not the Ambika's
//     own running address, so the next knob turn on the synth (sent without
//     an address) lands on the wrong parameter;
//   - an echoed patch push looks like a dump sent from the front panel.
//
// The filter remembers what SHED sent for a short while. An exact echo of a
// SysEx *request* SHED sent (the version request at connect, at the latest)
// proves that the synth forwards its input: the Ambika only ever sends
// replies and dumps (commands 0x01–0x0f) itself, never requests (0x10–0x1f).
// A dump can't serve as proof, because BAMBI's reply to "pull part 1" right
// after "push part 1" is byte for byte the push. From then on, incoming
// messages that match something SHED sent recently are dropped. Forwarding
// keeps the order, so a match also retires everything SHED sent before it.

import type { Clock } from '../midi/scheduler';

export const ECHO_WINDOW_MS = 1000;

/** Length of a MIDI message from its status byte (SysEx excluded). */
function messageLength(status: number): number {
  if (status >= 0x80 && status < 0xc0) return 3;
  if (status >= 0xc0 && status < 0xe0) return 2;
  if (status >= 0xe0 && status < 0xf0) return 3;
  if (status === 0xf1 || status === 0xf3) return 2;
  if (status === 0xf2) return 3;
  return 1;
}

/** Splits bytes SHED sent into the messages Web MIDI delivers one at a time. */
export function splitMessages(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const status = bytes[i];
    if (status === 0xf0) {
      let end = bytes.indexOf(0xf7, i);
      if (end < 0) end = bytes.length - 1;
      out.push(bytes.subarray(i, end + 1));
      i = end + 1;
    } else if (status < 0x80) {
      i++; // stray data byte: SHED never uses running status
    } else {
      const n = messageLength(status);
      out.push(bytes.subarray(i, i + n));
      i += n;
    }
  }
  return out;
}

/** An MI SysEx request (command 0x10–0x1f): something only SHED sends. */
function isRequest(msg: Uint8Array): boolean {
  return msg[0] === 0xf0 && msg.length > 7 && msg[6] >= 0x10 && msg[6] <= 0x1f;
}

function key(msg: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < msg.length; i++) s += (msg[i] < 16 ? '0' : '') + msg[i].toString(16);
  return s;
}

export class EchoFilter {
  /** True once the synth has been seen forwarding SHED's messages. */
  active = false;
  private pending: { key: string; request: boolean; t: number }[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly onDetect: () => void = () => {},
  ) {}

  /** Call with every byte string handed to the output port. */
  record(bytes: Uint8Array): void {
    const t = this.clock.now();
    this.expire(t);
    for (const msg of splitMessages(bytes)) this.pending.push({ key: key(msg), request: isRequest(msg), t });
  }

  /** True if `msg` is an echo of something SHED sent (and should be ignored). */
  isEcho(msg: Uint8Array): boolean {
    this.expire(this.clock.now());
    if (!this.active && !isRequest(msg)) return false;
    const k = key(msg);
    const i = this.pending.findIndex((p) => p.key === k && (this.active || p.request));
    if (i < 0) return false;
    this.pending.splice(0, i + 1);
    if (!this.active) {
      this.active = true;
      this.onDetect();
    }
    return true;
  }

  reset(): void {
    this.active = false;
    this.pending = [];
  }

  private expire(now: number): void {
    let n = 0;
    while (n < this.pending.length && now - this.pending[n].t > ECHO_WINDOW_MS) n++;
    if (n) this.pending.splice(0, n);
  }
}
