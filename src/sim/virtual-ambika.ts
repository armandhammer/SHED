// A simulated Ambika for end-to-end tests and for trying SHED without the
// hardware (`?virtual=bambi` or `?virtual=stock`).
//
// It models the controller's MIDI behaviour as read from the firmware source
// (BAMBI `controller/storage.cc`, `part.cc`, `multi.h`, `midi_dispatcher.h`),
// not the sound engine:
//   - SysEx reception (`Storage::SysExReceive`): MI header, expected payload
//     size per command, checksum, the "s" input filter; dumps 0x01–0x05 are
//     stored, requests 0x11–0x15 answered (`ForEachObject`: a multi request
//     sends the multi, then patch + part of each part tagged 1–6). Stock YAM
//     answers a single-object request with argument 0, BAMBI with the part
//     (1–6), and only BAMBI knows 0x16 / 0x1a / 0x1c.
//   - NRPN reception (`Part::ControlChange`): one latch per part, applied to
//     every part listening on the channel, values clamped to the parameter
//     range, the "n" input filter.
//   - Front-panel edits (`MidiDispatcher::OnEdit`): NRPN on the part's
//     channel when outp mode is controllr or above, with ONE running address
//     for all channels, refreshed every 32 values.
//   - outp mode full/chain forwards every incoming message to the output.

import { DEVICE_AMBIKA, decodeSysEx, encodeSysEx, isMutableSysEx } from '../midi/framer';
import {
  MULTI_SIZE,
  NUM_OSC_SHAPES,
  NUM_PARTS,
  PART_BASE,
  PART_SIZE,
  PATCH_SIZE,
  SEQUENCE_SIZE,
  initPart,
  initPatch,
  isNrpnAddress,
  paramAt,
  receivesOn,
  txChannel,
  type PartMapping,
} from '../model/params/ambika';
import { clamp, fromByte, toByte, type ParamDef } from '../model/params/types';
import { CMD, StorageObject } from '../protocol/ambika';

export type OutMode = 'thru' | 'sequencer' | 'controllr' | 'chain' | 'full';
const OUT_MODE_ORDER: OutMode[] = ['thru', 'sequencer', 'controllr', 'chain', 'full'];

/** `midi_in_mask` bits: a set bit blocks that message type ("cnps" on the LCD). */
export const IN_FILTER = { sysex: 1, programChange: 2, nrpn: 4, cc: 8 } as const;

export interface VirtualAmbikaOptions {
  firmware: 'stock' | 'yamplus';
  /** YAM+ version reported by BAMBI (major << 4 | minor), default 0.2. */
  yamPlusVersion?: number;
  outMode?: OutMode;
  inFilter?: number;
  /** Called with each message the synth sends (one complete MIDI message). */
  send: (msg: Uint8Array) => void;
}

interface PartState {
  patch: Uint8Array;
  data: Uint8Array;
  nrpn: number;
  nrpnMsb: number;
  dataEntryMsb: number;
}

/** Default multi from `controller/multi.cc` (`init_settings`). */
function initMulti(): Uint8Array {
  const m = new Uint8Array(MULTI_SIZE);
  const voices = [0x15, 0x2a, 0, 0, 0, 0];
  for (let i = 0; i < NUM_PARTS; i++) m.set([i + 1, 0, 127, voices[i]], i * 4);
  m.set([120, 0, 0, 4], 24);
  return m;
}

export class VirtualAmbika {
  firmware: 'stock' | 'yamplus';
  yamPlusVersion: number;
  outMode: OutMode;
  inFilter: number;
  activePart = 0;
  readonly parts: PartState[] = [];
  multi = initMulti();
  /** Status character the LCD would show after the last SysEx ('+' ok, '#' error). */
  sysexStatus = ' ';
  /** Program names for the BAMBI name request, per part. */
  names = Array.from({ length: NUM_PARTS }, (_, i) => `Program ${i + 1}`.padEnd(16).slice(0, 16));
  private runningAddress = -1;
  private dataEntryCounter = 0;
  private readonly send: (msg: Uint8Array) => void;

  constructor(options: VirtualAmbikaOptions) {
    this.firmware = options.firmware;
    this.yamPlusVersion = options.yamPlusVersion ?? 0x02;
    this.outMode = options.outMode ?? 'controllr';
    this.inFilter = options.inFilter ?? 0;
    this.send = options.send;
    for (let i = 0; i < NUM_PARTS; i++) {
      this.parts.push({ patch: initPatch(), data: initPart(), nrpn: 0, nrpnMsb: 0, dataEntryMsb: 0 });
    }
  }

  mapping(part: number): PartMapping {
    const m = this.multi;
    return { channel: m[part * 4], keyLow: m[part * 4 + 1], keyHigh: m[part * 4 + 2], voices: m[part * 4 + 3] };
  }

  byte(part: number, address: number): number {
    const p = this.parts[part];
    return address < PART_BASE ? p.patch[address] : p.data[address - PART_BASE];
  }

  // -------------------------------------------------------------------------
  // MIDI in.

  /** Feeds one complete MIDI message, as Web MIDI delivers them. */
  receive(msg: Uint8Array): void {
    const forwards = this.outMode === 'full' || this.outMode === 'chain';
    const status = msg[0];
    if (status === 0xf0) {
      if (forwards) this.send(msg.slice());
      this.receiveSysEx(msg);
      return;
    }
    if (forwards && !(this.outMode === 'chain' && (status & 0xe0) === 0x80)) this.send(msg.slice());
    if ((status & 0xf0) === 0xb0 && msg.length >= 3) this.controlChange(status & 0x0f, msg[1], msg[2]);
  }

  private controlChange(channel: number, controller: number, value: number): void {
    for (let i = 0; i < NUM_PARTS; i++) {
      if (receivesOn(this.mapping(i), channel)) this.partControlChange(i, controller, value);
    }
  }

  /** `Part::ControlChange` for the NRPN controllers. */
  private partControlChange(part: number, controller: number, value: number): void {
    const p = this.parts[part];
    switch (controller) {
      case 6:
        p.dataEntryMsb = value ? 128 : 0;
        return;
      case 98:
        p.nrpn = value | p.nrpnMsb;
        p.nrpnMsb = 0;
        p.dataEntryMsb = 0;
        return;
      case 99:
        p.nrpnMsb = value ? 128 : 0;
        p.dataEntryMsb = 0;
        return;
      case 38:
      case 96:
      case 97: {
        const address = p.nrpn;
        if (!isNrpnAddress(address)) return;
        const def = paramAt(address);
        let byte: number;
        if (controller === 38) {
          const raw = value | p.dataEntryMsb;
          byte = def ? this.toFirmwareByte(def, fromByte(def, raw)) : raw;
        } else {
          if (!def) return;
          byte = this.toFirmwareByte(def, fromByte(def, this.byte(part, address)) + (controller === 96 ? 1 : -1));
        }
        if (!(this.inFilter & IN_FILTER.nrpn)) this.setValue(part, address, byte, false);
        return;
      }
      default:
        return;
    }
  }

  private receiveSysEx(msg: Uint8Array): void {
    if (!isMutableSysEx(msg) || msg[5] !== DEVICE_AMBIKA) return; // header mismatch: ignored
    const ok = this.acceptSysEx(msg);
    this.sysexStatus = ok ? '+' : '#';
  }

  /** `SysExParseCommand` + `SysExAcceptCommand`. Returns false on RECEPTION_ERROR. */
  private acceptSysEx(msg: Uint8Array): boolean {
    let frame;
    try {
      frame = decodeSysEx(msg);
    } catch {
      return false;
    }
    if (this.inFilter & IN_FILTER.sysex) return false;
    const { command, argument, payload } = frame;
    const yamplus = this.firmware === 'yamplus';
    const expected = this.expectedSize(command, argument);
    if (expected === null || payload.length !== expected) return false;
    const part = argument === 0 ? this.activePart : argument - 1;
    if (part >= NUM_PARTS && command !== 0x0f && command !== 0x1f) return false;
    switch (command) {
      case 0x01:
        this.parts[part].patch.set(payload);
        return true;
      case 0x02:
        this.parts[part].data.set(payload, 16);
        return true;
      case 0x03:
        return true; // program: object_size() is 0, nothing to read
      case 0x04:
        this.multi.set(payload);
        return true;
      case 0x05:
        this.parts[part].data.set(payload);
        return true;
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
        this.sendObjects(command - 0x11, part);
        return true;
      case 0x16:
        if (!yamplus) return false;
        this.sendName(part, payload[0]);
        return true;
      case 0x1a:
        if (!yamplus) return false;
        this.reply(CMD.LOCATIONS, 0, new Uint8Array((NUM_PARTS * 3 + 1) * 2));
        return true;
      case 0x1c:
        if (!yamplus) return false;
        this.reply(CMD.VERSION, 0, this.versionPayload());
        return true;
      default:
        return false;
    }
  }

  private expectedSize(command: number, argument: number): number | null {
    switch (command) {
      case 0x01:
        return PATCH_SIZE;
      case 0x02:
        return SEQUENCE_SIZE;
      case 0x03:
        return 0;
      case 0x04:
        return MULTI_SIZE;
      case 0x05:
        return PART_SIZE;
      case 0x0f:
        return 2 + argument;
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
        return 0;
      case 0x1f:
        return 2;
      case 0x16:
        return this.firmware === 'yamplus' ? 1 : null;
      case 0x1a:
      case 0x1c:
        return this.firmware === 'yamplus' ? 0 : null;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // MIDI out.

  private reply(command: number, argument: number, payload: Uint8Array): void {
    this.send(encodeSysEx(DEVICE_AMBIKA, command, argument, payload));
  }

  /** `Storage::SysExSend` → `ForEachObject` → `SysExSendObject`. */
  private sendObjects(object: StorageObject, part: number): void {
    const single = (obj: StorageObject, p: number, alias: number) => {
      let argument = alias;
      if (!argument && obj !== StorageObject.Multi && this.firmware === 'yamplus') argument = p + 1;
      this.reply(obj + 1, argument, this.objectData(obj, p));
    };
    switch (object) {
      case StorageObject.Patch:
      case StorageObject.Sequence:
      case StorageObject.Part:
        single(object, part, 0);
        break;
      case StorageObject.Program:
        single(StorageObject.Patch, part, 0);
        single(StorageObject.Part, part, 0);
        break;
      case StorageObject.Multi:
        single(StorageObject.Multi, part, 0);
        for (let i = 0; i < NUM_PARTS; i++) {
          single(StorageObject.Patch, i, i + 1);
          single(StorageObject.Part, i, i + 1);
        }
        break;
    }
  }

  private objectData(object: StorageObject, part: number): Uint8Array {
    switch (object) {
      case StorageObject.Patch:
        return this.parts[part].patch.slice();
      case StorageObject.Sequence:
        return this.parts[part].data.slice(16, 16 + SEQUENCE_SIZE);
      case StorageObject.Part:
        return this.parts[part].data.slice();
      case StorageObject.Multi:
        return this.multi.slice();
      default:
        return new Uint8Array(0);
    }
  }

  private sendName(part: number, object: number): void {
    if (object > StorageObject.Multi) return;
    const payload = new Uint8Array(20);
    payload[0] = object;
    payload[1] = 0; // bank A
    payload[2] = part; // slot
    payload[3] = 0; // FS_OK
    const name = object === StorageObject.Multi ? 'Multi'.padEnd(16) : this.names[part];
    for (let i = 0; i < 16; i++) payload[4 + i] = name.charCodeAt(i) & 0x7f;
    this.reply(CMD.NAME, object === StorageObject.Multi ? 0 : part + 1, payload);
  }

  private versionPayload(): Uint8Array {
    const p = new Uint8Array(6 + 2 * NUM_PARTS);
    p.set([1, 0x10, this.yamPlusVersion, NUM_OSC_SHAPES, 1, 1]);
    const voicecard = this.yamPlusVersion >= 0x02 ? 0x12 : 0x11;
    for (let i = 0; i < NUM_PARTS; i++) p.set([i + 1, voicecard], 6 + 2 * i);
    return p;
  }

  /**
   * Clamps to the parameter range of this firmware: enum values newer than
   * it (polyphony 5–6, spread mode 3 before YAM+ 0.2) stop at its maximum,
   * as the firmware's parameter table would.
   */
  private toFirmwareByte(def: ParamDef, value: number): number {
    let v = clamp(def, value);
    const gate = def.valuesSince;
    if (gate && (this.firmware === 'stock' || this.yamPlusVersion < gate.yamPlus)) v = Math.min(v, gate.from - 1);
    return toByte(def, v);
  }

  // -------------------------------------------------------------------------
  // Front panel.

  /** `Part::SetValue`. A user-initiated change is sent out by `OnEdit`. */
  setValue(part: number, address: number, byte: number, userInitiated: boolean): void {
    const p = this.parts[part];
    if (address < PART_BASE) p.patch[address] = byte & 0xff;
    else p.data[address - PART_BASE] = byte & 0xff;
    if (userInitiated) this.onEdit(part, address, byte & 0xff);
  }

  /** Turns an encoder on the front panel: sets a parameter (display value) on a part. */
  turnKnob(part: number, address: number, value: number): void {
    const def = paramAt(address);
    if (!def) throw new Error(`no parameter at ${address}`);
    this.setValue(part, address, this.toFirmwareByte(def, value), true);
  }

  /** Selects the part the front panel shows (argument 0 in SysEx means this part). */
  selectPart(part: number): void {
    this.activePart = part;
  }

  /** `MidiDispatcher::OnEdit`: one running address for every channel. */
  private onEdit(part: number, address: number, value: number): void {
    if (OUT_MODE_ORDER.indexOf(this.outMode) < OUT_MODE_ORDER.indexOf('controllr')) return;
    if (this.outMode === 'chain' && address === 127 && value === 4) value = 1;
    const status = 0xb0 | txChannel(this.mapping(part));
    ++this.dataEntryCounter;
    if (this.runningAddress !== address || this.dataEntryCounter >= 32) {
      this.send(Uint8Array.of(status, 99, address & 0x80 ? 1 : 0));
      this.send(Uint8Array.of(status, 98, address & 0x7f));
      this.runningAddress = address;
      this.dataEntryCounter = 0;
    }
    this.send(Uint8Array.of(status, 6, value & 0x80 ? 1 : 0));
    this.send(Uint8Array.of(status, 38, value & 0x7f));
  }

  /** Sends a multi dump from the front panel (Library → send). */
  sendMultiFromPanel(): void {
    this.sendObjects(StorageObject.Multi, this.activePart);
  }
}
