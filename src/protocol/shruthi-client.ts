// Shruthi request/reply correlation.
//
// The Shruthi tags nothing (its replies always carry argument 0, except the
// step and bank replies), so SHED keeps exactly one request in flight and
// attributes the next matching reply to it. Every request has a timeout:
// a missing reply means the synth is absent, the MIDI cable or channel is
// wrong, or the firmware doesn't know the command.
//
// Detection: the version request (0x1c) is answered by both firmwares;
// stock YAM sends 2 bytes, SHOOZ appends its capability bytes. Silence means
// no Shruthi (or one with MIDI in disabled).

import { DEVICE_SHRUTHI, decodeSysEx, isMutableSysEx, type SysExFrame } from '../midi/framer';
import type { Clock } from '../midi/scheduler';
import { systemClock, wireTimeMs } from '../midi/scheduler';
import { SHRUTHI_PATCH_SIZE } from '../model/params/shruthi';
import { Emitter } from '../util/emitter';
import {
  SHRUTHI_CMD,
  parseShruthiVersion,
  shruthiPatchDump,
  shruthiRequest,
  shruthiWriteRequest,
  type ShruthiFirmware,
} from './shruthi';

export type ShruthiMode = 'unknown' | 'absent' | 'stock' | 'shooz';

/** Base wait for a reply, plus the reply's own wire time. */
export const SHRUTHI_REPLY_SLACK_MS = 400;
/** The firmware waits 100 ms before answering any request (`Delay(100)`). */
export const SHRUTHI_REQUEST_DELAY_MS = 100;

export class ShruthiTimeout extends Error {
  constructor(readonly label: string) {
    super(`no reply to ${label}`);
    this.name = 'ShruthiTimeout';
  }
}

interface Pending {
  label: string;
  bytes: Uint8Array;
  replyCommand: number;
  timeoutMs: number;
  timer: unknown;
  resolve: (frame: SysExFrame) => void;
  reject: (e: Error) => void;
}

interface ShruthiClientEvents {
  unsolicited: SysExFrame;
  error: string;
}

export interface ShruthiTransport {
  send(bytes: Uint8Array): void;
}

function timeoutFor(replyPayload: number): number {
  return SHRUTHI_REQUEST_DELAY_MS + SHRUTHI_REPLY_SLACK_MS + wireTimeMs(10 + 2 * replyPayload);
}

export class ShruthiClient extends Emitter<ShruthiClientEvents> {
  mode: ShruthiMode = 'unknown';
  firmware: ShruthiFirmware | null = null;
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;

  constructor(
    private readonly transport: ShruthiTransport,
    private readonly clock: Clock = systemClock,
  ) {
    super();
  }

  /** Feed every incoming SysEx message here. Returns true for a Shruthi frame. */
  handleSysEx(msg: Uint8Array): boolean {
    if (!isMutableSysEx(msg)) return false;
    let frame: SysExFrame;
    try {
      frame = decodeSysEx(msg);
    } catch (e) {
      this.emit('error', `bad SysEx: ${(e as Error).message}`);
      return false;
    }
    if (frame.device !== DEVICE_SHRUTHI) return false;
    const a = this.active;
    if (a && frame.command === a.replyCommand) {
      this.clock.clearTimer(a.timer);
      this.active = null;
      a.resolve(frame);
      this.pump();
    } else {
      this.emit('unsolicited', frame);
    }
    return true;
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  reset(): void {
    const all = this.active ? [this.active, ...this.queue] : [...this.queue];
    if (this.active) this.clock.clearTimer(this.active.timer);
    this.active = null;
    this.queue.length = 0;
    for (const p of all) p.reject(new Error('cancelled'));
  }

  // -------------------------------------------------------------------------

  /** Version probe; sets `mode` to shooz, stock or absent. */
  async detect(): Promise<ShruthiMode> {
    try {
      const frame = await this.request('version', shruthiRequest(SHRUTHI_CMD.versionRequest), SHRUTHI_CMD.versionReply, 8);
      this.firmware = parseShruthiVersion(frame.payload);
      this.mode = this.firmware.shooz ? 'shooz' : 'stock';
    } catch (e) {
      if (!(e instanceof ShruthiTimeout)) throw e;
      this.firmware = null;
      this.mode = 'absent';
    }
    return this.mode;
  }

  async fetchPatch(): Promise<Uint8Array> {
    const frame = await this.request('patch', shruthiRequest(SHRUTHI_CMD.patchRequest), SHRUTHI_CMD.patch, SHRUTHI_PATCH_SIZE);
    if (frame.payload.length !== SHRUTHI_PATCH_SIZE) throw new Error(`patch reply has ${frame.payload.length} bytes`);
    return frame.payload;
  }

  async fetchSystem(): Promise<Uint8Array> {
    return (await this.request('system settings', shruthiRequest(SHRUTHI_CMD.systemRequest), SHRUTHI_CMD.system, 16)).payload;
  }

  async fetchName(): Promise<string> {
    const frame = await this.request('name', shruthiRequest(SHRUTHI_CMD.nameRequest), SHRUTHI_CMD.name, 8);
    return String.fromCharCode(...frame.payload).trimEnd();
  }

  async fetchBanks(): Promise<number> {
    return (await this.request('banks', shruthiRequest(SHRUTHI_CMD.banksRequest), SHRUTHI_CMD.banksReply, 0)).argument;
  }

  /** Sends a patch to the edit buffer (no reply; the LCD shows + or #). */
  sendPatch(wire: ArrayLike<number>): void {
    this.transport.send(shruthiPatchDump(wire));
  }

  writePatch(slot: number): void {
    this.transport.send(shruthiWriteRequest(SHRUTHI_CMD.writePatch, slot));
  }

  request(label: string, bytes: Uint8Array, replyCommand: number, replyPayload: number): Promise<SysExFrame> {
    return new Promise((resolve, reject) => {
      this.queue.push({ label, bytes, replyCommand, timeoutMs: timeoutFor(replyPayload), timer: null, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || !this.queue.length) return;
    const p = this.queue.shift()!;
    this.active = p;
    this.transport.send(p.bytes);
    // Counted from the moment the request is handed over, plus its own
    // wire time.
    p.timer = this.clock.setTimer(() => {
      if (this.active !== p) return;
      this.active = null;
      p.reject(new ShruthiTimeout(p.label));
      this.pump();
    }, p.timeoutMs + wireTimeMs(p.bytes.length));
  }
}
