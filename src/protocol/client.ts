// Ambika request/reply correlation.
//
// Stock YAM answers a single-object dump request with argument 0, so a reply
// can only be attributed to "the request that is outstanding": with stock
// firmware SHED keeps exactly one request in flight, with a timeout. BAMBI
// (YAM+) tags replies with the part (1–6); in that mode requests for an
// explicit part may overlap, and a reply whose tag doesn't match is treated as
// unsolicited instead of being misfiled. Multi dumps (whose inner patch/part
// messages carry 1–6 on both firmwares) and "active part" requests always run
// alone.

import { DEVICE_AMBIKA, decodeSysEx, isMutableSysEx, type SysExFrame } from '../midi/framer';
import type { Clock, Lane } from '../midi/scheduler';
import { systemClock, wireTimeMs } from '../midi/scheduler';
import { NUM_PARTS } from '../model/params/ambika';
import { Emitter } from '../util/emitter';
import {
  CMD,
  StorageObject,
  dumpRequest,
  locationsRequest,
  nameRequest,
  parseLocations,
  parseName,
  parseVersion,
  replyWireBytes,
  versionRequest,
  type FirmwareInfo,
  type Locations,
  type NameReply,
} from './ambika';

export type FirmwareMode = 'unknown' | 'stock' | 'yamplus';

export interface Transport {
  /** Queue bytes on a lane; call `onSent` when they actually leave. */
  send(bytes: Uint8Array, lane: Lane, onSent: () => void): void;
}

interface Expectation {
  command: number;
  /** Exact argument required (multi inner messages); otherwise matched by part rules. */
  argument?: number;
}

interface Pending {
  label: string;
  bytes: Uint8Array;
  part: number; // request argument: 0 = active part
  expect: Expectation[];
  received: SysExFrame[];
  exclusive: boolean;
  timeoutMs: number;
  timer: unknown;
  sent: boolean;
  resolve: (frames: SysExFrame[]) => void;
  reject: (e: Error) => void;
}

export class RequestTimeout extends Error {
  constructor(label: string) {
    super(`no reply to ${label}`);
    this.name = 'RequestTimeout';
  }
}

interface ClientEvents {
  /** A valid Ambika frame that no request claimed (front-panel sends, other editors). */
  unsolicited: SysExFrame;
  /** Every valid frame, claimed or not (for the log). */
  frame: SysExFrame;
  error: string;
}

export interface ProgramDump {
  part: number; // 1–6 when known, 0 if the firmware didn't say
  patch: Uint8Array;
  partData: Uint8Array;
}

export interface MultiDumpResult {
  multi: Uint8Array;
  programs: ProgramDump[];
}

const BASE_TIMEOUT_MS = 1200;
export const DETECT_TIMEOUT_MS = 700;

export class AmbikaClient extends Emitter<ClientEvents> {
  mode: FirmwareMode = 'unknown';
  firmware: FirmwareInfo | null = null;
  private readonly queue: Pending[] = [];
  private readonly active: Pending[] = [];

  constructor(
    private readonly transport: Transport,
    private readonly clock: Clock = systemClock,
  ) {
    super();
  }

  /** Feed every incoming SysEx message here. Returns true if it was an Ambika frame. */
  handleSysEx(msg: Uint8Array): boolean {
    if (!isMutableSysEx(msg)) return false;
    let frame: SysExFrame;
    try {
      frame = decodeSysEx(msg);
    } catch (e) {
      this.emit('error', `bad SysEx: ${(e as Error).message}`);
      return false;
    }
    if (frame.device !== DEVICE_AMBIKA) return false;
    this.emit('frame', frame);
    if (!this.claim(frame)) this.emit('unsolicited', frame);
    return true;
  }

  get busy(): boolean {
    return this.active.length > 0 || this.queue.length > 0;
  }

  /** Drop everything in flight (port change). */
  reset(): void {
    for (const p of [...this.active, ...this.queue]) {
      if (p.timer !== null) this.clock.clearTimer(p.timer);
      p.reject(new Error('cancelled'));
    }
    this.active.length = 0;
    this.queue.length = 0;
  }

  // -------------------------------------------------------------------------
  // High-level requests.

  /** Version probe: a reply means BAMBI (YAM+); silence means stock YAM. */
  async detect(): Promise<FirmwareMode> {
    try {
      const [frame] = await this.request('version', versionRequest(), 0, [{ command: CMD.VERSION, argument: 0 }], {
        exclusive: true,
        timeoutMs: DETECT_TIMEOUT_MS,
      });
      this.firmware = parseVersion(frame.payload);
      this.mode = 'yamplus';
    } catch (e) {
      if (!(e instanceof RequestTimeout)) throw e;
      this.firmware = null;
      this.mode = 'stock';
    }
    return this.mode;
  }

  async requestPatch(part: number): Promise<{ part: number; data: Uint8Array }> {
    const [f] = await this.dump(StorageObject.Patch, part, [{ command: CMD.PATCH }]);
    return { part: f.argument, data: f.payload };
  }

  async requestPart(part: number): Promise<{ part: number; data: Uint8Array }> {
    const [f] = await this.dump(StorageObject.Part, part, [{ command: CMD.PART }]);
    return { part: f.argument, data: f.payload };
  }

  /** Patch + part of one part (a program dump arrives as 0x01 then 0x05). */
  async requestProgram(part: number): Promise<ProgramDump> {
    const [patch, partData] = await this.dump(StorageObject.Program, part, [
      { command: CMD.PATCH },
      { command: CMD.PART },
    ]);
    return { part: patch.argument, patch: patch.payload, partData: partData.payload };
  }

  /** Everything: multi + patch and part of all six parts, unambiguous on any firmware. */
  async requestMulti(): Promise<MultiDumpResult> {
    const expect: Expectation[] = [{ command: CMD.MULTI, argument: 0 }];
    for (let p = 1; p <= NUM_PARTS; p++) {
      expect.push({ command: CMD.PATCH, argument: p }, { command: CMD.PART, argument: p });
    }
    const frames = await this.dump(StorageObject.Multi, 0, expect);
    const programs: ProgramDump[] = [];
    for (let p = 0; p < NUM_PARTS; p++) {
      programs.push({ part: p + 1, patch: frames[1 + 2 * p].payload, partData: frames[2 + 2 * p].payload });
    }
    return { multi: frames[0].payload, programs };
  }

  async requestName(part: number, object: StorageObject): Promise<NameReply> {
    this.requireYamPlus('name');
    const [f] = await this.request(`name of part ${part}`, nameRequest(part, object), part, [{ command: CMD.NAME }], {
      exclusive: part === 0,
    });
    return parseName(f.argument, f.payload);
  }

  async requestLocations(): Promise<Locations> {
    this.requireYamPlus('locations');
    const [f] = await this.request('current locations', locationsRequest(), 0, [{ command: CMD.LOCATIONS, argument: 0 }], {
      exclusive: false,
    });
    return parseLocations(f.payload);
  }

  // -------------------------------------------------------------------------

  private requireYamPlus(what: string): void {
    if (this.mode !== 'yamplus') throw new Error(`${what} request needs BAMBI (YAM+) firmware`);
  }

  private dump(object: StorageObject, part: number, expect: Expectation[]): Promise<SysExFrame[]> {
    const label = `${StorageObject[object].toLowerCase()} dump${part ? ` of part ${part}` : ''}`;
    const exclusive = this.mode !== 'yamplus' || object === StorageObject.Multi || part === 0;
    const timeoutMs = BASE_TIMEOUT_MS + 2 * wireTimeMs(replyWireBytes(object));
    return this.request(label, dumpRequest(object, part), part, expect, { exclusive, timeoutMs });
  }

  request(
    label: string,
    bytes: Uint8Array,
    part: number,
    expect: Expectation[],
    opts: { exclusive?: boolean; timeoutMs?: number } = {},
  ): Promise<SysExFrame[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        label,
        bytes,
        part,
        expect,
        received: [],
        exclusive: opts.exclusive ?? true,
        timeoutMs: opts.timeoutMs ?? BASE_TIMEOUT_MS,
        timer: null,
        sent: false,
        resolve,
        reject,
      });
      this.startNext();
    });
  }

  private startNext(): void {
    while (this.queue.length) {
      const next = this.queue[0];
      const blocked = this.active.some((a) => a.exclusive) || (next.exclusive && this.active.length > 0);
      if (blocked) return;
      this.queue.shift();
      this.active.push(next);
      this.transport.send(next.bytes, 'request', () => {
        next.sent = true;
        next.timer = this.clock.setTimer(() => this.fail(next, new RequestTimeout(next.label)), next.timeoutMs);
      });
    }
  }

  private finish(p: Pending): void {
    if (p.timer !== null) this.clock.clearTimer(p.timer);
    const i = this.active.indexOf(p);
    if (i >= 0) this.active.splice(i, 1);
    this.startNext();
  }

  private fail(p: Pending, e: Error): void {
    p.timer = null;
    this.finish(p);
    p.reject(e);
  }

  private argumentMatches(p: Pending, exp: Expectation, argument: number): boolean {
    if (exp.argument !== undefined) return argument === exp.argument;
    // Stock YAM: 0. BAMBI: the part (1–6). A request for the active part (0)
    // accepts any tag; BAMBI then tells us which part was active.
    return argument === 0 || p.part === 0 || argument === p.part;
  }

  private claim(frame: SysExFrame): boolean {
    for (const p of this.active) {
      if (!p.sent) continue;
      const exp = p.expect[p.received.length];
      if (!exp || exp.command !== frame.command || !this.argumentMatches(p, exp, frame.argument)) continue;
      p.received.push(frame);
      if (p.received.length === p.expect.length) {
        this.finish(p);
        p.resolve(p.received);
      }
      return true;
    }
    return false;
  }
}
