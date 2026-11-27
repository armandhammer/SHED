// A simulated Shruthi-1 for end-to-end tests (and, later, for trying SHED
// without the hardware). It models the firmware's MIDI behaviour, read from
// SHOOZ `shruthi/storage.cc`, `part.cc`, `patch.cc`, `midi_dispatcher.h`
// and checked against the firmware's native tests, not the sound engine:
//
//   - SysEx reception (`Storage::SysExReceive`): MI header, exact payload
//     size per command, checksum; transfers 0x01–0x07 applied, requests
//     0x11–0x1c answered, writes 0x21/0x22 stored. The LCD status is '+'
//     on success and '#' otherwise (including after 0x05/0x06, which the
//     firmware applies but never flags as successful).
//   - Patch acceptance (`Patch::CheckBuffer`): bytes 8–23 must be 7-bit and
//     the marker '!' or '%' (stock) or also '&' (SHOOZ). A refused patch
//     leaves the sound and renames it "--------".
//   - SHOOZ clamps everything it loads to the parameter ranges
//     (`Part::SanitizeParameters`); stock doesn't.
//   - SHOOZ filter calibration (offsets 159–161): set by NRPN, reported at
//     the end of the version reply, saved by a system dump (0x04) into
//     `savedFilterCal` (the EEPROM). Stock has no parameters past 156.
//   - NRPN reception (`Part::ControlChange`), with the firmware's 8-bit
//     latches: MSB 1 adds 128 to the address and to the value; values out
//     of range are ignored; data increment/decrement step the parameter.
//   - CCs mapped to parameters are scaled (`Parameter::Scale`).
//   - Front-panel edits (`MidiDispatcher::OnEdit`): a CC when the parameter
//     has one, otherwise NRPN; only in ctrl/full/chain modes, never for the
//     system settings from master tuning on (nor the SHOOZ curves).
//   - MIDI out "thru" echoes every incoming byte; full and chain modes
//     forward messages (and SysEx).

import { DEVICE_SHRUTHI, decodeSysEx, encodeSysEx, isMutableSysEx, type SysExFrame } from '../midi/framer';
import {
  SHRUTHI_ADDRESS_SPACE,
  SHRUTHI_FIRMWARE,
  SHRUTHI_NAME_LENGTH,
  SHRUTHI_NAME_OFFSET,
  SHRUTHI_OFFSET,
  SHRUTHI_PARAMS,
  SHRUTHI_SEQUENCE_DUMP_SIZE,
  SHRUTHI_SEQUENCER_SIZE,
  SHRUTHI_SYSTEM_SIZE,
  ccParam,
  nrpnParam,
  shruthiClamp,
  shruthiFromByte,
  shruthiInitPatch,
  shruthiInitSequencer,
  shruthiInitSystem,
  shruthiScale,
  type ShruthiParam,
} from '../model/params/shruthi';
import {
  SHRUTHI_CMD,
  acceptsPatch,
  applyWirePatch,
  shruthiSlotCount,
  unpackPatch,
  wirePatchFromSpace,
} from '../protocol/shruthi';

/** `SystemSettings::midi_out_mode` (UNIT_MIDI_MODE). */
export const SHRUTHI_OUT_MODE = { off: 0, thru: 1, seq: 2, ctrl: 3, full: 4, chain: 5 } as const;

const SYS = SHRUTHI_OFFSET.system;
const SYS_MIDI_CHANNEL = SYS + 5;
const SYS_MIDI_OUT = SYS + 6;
const SEQ = SHRUTHI_OFFSET.sequencer;
const SEQ_STEPS = SEQ + 10;

/** Payload size each transfer command expects (`Storage::SysExParseCommand`). */
function expectedSize(command: number): number | null {
  switch (command) {
    case SHRUTHI_CMD.patch: return 92;
    case SHRUTHI_CMD.sequence: return SHRUTHI_SEQUENCE_DUMP_SIZE;
    case SHRUTHI_CMD.wavetable: return 8 * 129;
    case SHRUTHI_CMD.system: return SHRUTHI_SYSTEM_SIZE;
    case SHRUTHI_CMD.step: return 2;
    case SHRUTHI_CMD.name: return SHRUTHI_NAME_LENGTH;
    case SHRUTHI_CMD.sequencerState: return SHRUTHI_SEQUENCER_SIZE;
    case 0x11: case 0x12: case 0x14: case 0x15: case 0x16: case 0x17:
    case 0x1a: case 0x1b: case 0x1c: case 0x31: case 0x32: case 0x50:
      return 0;
    case SHRUTHI_CMD.writePatch: case SHRUTHI_CMD.writeSequence: return 2;
    case 0x40: case 0x41: case 0x42: case 0x43: return 128;
    default: return null;
  }
}

export interface VirtualShruthiOptions {
  firmware: 'stock' | 'shooz';
  /** MIDI out mode; the firmware default is thru. */
  outMode?: number;
  /** Installed external EEPROM banks (0–7). */
  banks?: number;
  /** Called with each complete message the synth sends. */
  send: (msg: Uint8Array) => void;
}

export class VirtualShruthi {
  readonly firmware: 'stock' | 'shooz';
  /** Parameter address space: patch RAM 0–99, sequencer 100–141, system 142–156, curves 157–158, filter calibration 159–161. */
  readonly mem = new Uint8Array(SHRUTHI_ADDRESS_SPACE);
  readonly banks: number;
  /** Stored patches and sequences by slot (wire format). */
  readonly patchSlots = new Map<number, Uint8Array>();
  readonly sequenceSlots = new Map<number, Uint8Array>();
  currentPatch = 0;
  /** LCD status after the last SysEx: '+' accepted, '#' refused. */
  sysexStatus = ' ';
  freeStack = 200;
  glitches = 0;
  /** The filter calibration as last saved (EEPROM bytes 2045–2047); null: never saved. */
  savedFilterCal: Uint8Array | null = null;
  private bank = 0;
  private nrpn = 0xff;
  private nrpnMsb = 0;
  private dataEntryMsb = 0;
  private rng = 0x2a;
  private readonly send: (msg: Uint8Array) => void;

  constructor(options: VirtualShruthiOptions) {
    this.firmware = options.firmware;
    this.banks = options.banks ?? 1;
    this.send = options.send;
    this.mem.set(unpackPatch(shruthiInitPatch()), 0);
    this.mem.set(shruthiInitSequencer(), SEQ);
    this.mem.set(shruthiInitSystem(), SYS);
    this.mem[SHRUTHI_OFFSET.filterResonanceMax] = 127;
    if (options.outMode !== undefined) this.mem[SYS_MIDI_OUT] = options.outMode;
  }

  get outMode(): number {
    return this.mem[SYS_MIDI_OUT];
  }
  set outMode(mode: number) {
    this.mem[SYS_MIDI_OUT] = mode;
  }

  get curves(): [number, number] {
    return [this.mem[SHRUTHI_OFFSET.envCurve1], this.mem[SHRUTHI_OFFSET.envCurve2]];
  }

  get patchName(): string {
    return String.fromCharCode(...this.mem.subarray(SHRUTHI_NAME_OFFSET, SHRUTHI_NAME_OFFSET + SHRUTHI_NAME_LENGTH));
  }

  value(p: ShruthiParam | number): number {
    return this.mem[typeof p === 'number' ? p : p.address];
  }

  /** The current patch as `Patch::PrepareForWrite` would send it. */
  wirePatch(): Uint8Array {
    return wirePatchFromSpace(this.mem, this.firmware);
  }

  // -------------------------------------------------------------------------
  // MIDI in.

  /** Feeds one complete MIDI message, as Web MIDI delivers them. */
  receive(msg: Uint8Array): void {
    const mode = this.outMode;
    if (mode === SHRUTHI_OUT_MODE.thru) this.send(msg.slice());
    const status = msg[0];
    if (status === 0xf0) {
      if (mode >= SHRUTHI_OUT_MODE.full) this.send(msg.slice());
      this.receiveSysEx(msg);
      return;
    }
    if (status >= 0xf0) return;
    const accepted = this.listensOn(status & 0x0f);
    const hi = status & 0xf0;
    if (mode >= SHRUTHI_OUT_MODE.full) {
      const isNote = hi === 0x80 || hi === 0x90;
      if (!isNote || mode === SHRUTHI_OUT_MODE.full || !accepted) this.send(msg.slice());
    }
    if (!accepted) return;
    if (hi === 0xb0 && msg.length >= 3) this.controlChange(msg[1], msg[2]);
    else if (hi === 0xc0 && msg.length >= 2) this.programChange(msg[1]);
  }

  listensOn(channel: number): boolean {
    const c = this.mem[SYS_MIDI_CHANNEL];
    return c === 0 || c === channel + 1;
  }

  private controlChange(controller: number, value: number): void {
    switch (controller) {
      case 0: // bank MSB (handled by the dispatcher)
        this.bank = value;
        return;
      case 6:
        this.dataEntryMsb = (value << 7) & 0xff;
        return;
      case 98:
        this.nrpn = (value | this.nrpnMsb) & 0xff;
        this.nrpnMsb = 0;
        this.dataEntryMsb = 0;
        return;
      case 99:
        this.nrpnMsb = (value << 7) & 0xff;
        this.dataEntryMsb = 0;
        return;
      case 38:
      case 96:
      case 97: {
        const v = (value | this.dataEntryMsb) & 0xff;
        if (this.nrpn === 0xff) return;
        const p = nrpnParam(this.nrpn);
        if (!p) return;
        // Stock YAM's offset table has nothing for the SHOOZ curves and calibration.
        if (this.firmware === 'stock' && this.nrpn >= SHRUTHI_OFFSET.envCurve1) return;
        if (controller === 38) {
          const display = shruthiFromByte(p, v);
          if (display >= p.min && display <= p.max) this.mem[this.nrpn] = v;
        } else {
          const next = shruthiFromByte(p, this.mem[this.nrpn]) + (controller === 96 ? 1 : -1);
          if (next >= p.min && next <= p.max) this.mem[this.nrpn] = next & 0xff;
        }
        return;
      }
      default: {
        const p = ccParam(controller);
        if (p) this.mem[p.address] = shruthiScale(p, value);
      }
    }
  }

  private programChange(program: number): void {
    if (this.bank >= 0x40) {
      const n = program + ((this.bank - 0x40) << 7);
      if (n < shruthiSlotCount(this.banks)) this.loadSequence(n);
      return;
    }
    const n = program + (this.bank << 7);
    if (n < shruthiSlotCount(this.banks)) {
      this.currentPatch = n;
      this.acceptPatch(this.patchSlots.get(n) ?? new Uint8Array(92).fill(0xff));
      this.loadSequence(n);
    }
  }

  private loadSequence(n: number): void {
    const steps = this.sequenceSlots.get(n) ?? new Uint8Array(32).fill(0xff);
    this.mem.set(steps, SEQ_STEPS);
    this.updatePatternSize();
    this.sanitize();
  }

  // -------------------------------------------------------------------------
  // Front panel.

  /** Turns a knob: sets the value and echoes it as `OnEdit` would. */
  edit(p: ShruthiParam, value: number): void {
    const byte = shruthiClamp(p, value & 0xff);
    if (this.mem[p.address] === byte) return;
    this.mem[p.address] = byte;
    this.onEdit(p, byte);
  }

  private onEdit(p: ShruthiParam, byte: number): void {
    if (p.address >= SHRUTHI_OFFSET.masterTuning) return;
    const mode = this.outMode;
    if (mode < SHRUTHI_OUT_MODE.full && mode !== SHRUTHI_OUT_MODE.ctrl) return;
    const channel = this.txChannel();
    if (p.cc) {
      let v = byte;
      if (p.firmwareUnit !== 'raw_uint8') {
        v = (v - p.min) & 0xff;
        const range = (p.max - p.min + 1) & 0xff;
        v = Math.floor((v * 128) / (range || 256)) & 0xff;
        if (v !== 127 && shruthiScale(p, v) !== byte) ++v;
        if (v !== 0 && shruthiScale(p, v) !== byte) --v;
      }
      this.send(Uint8Array.of(0xb0 | channel, p.cc, v & 0x7f));
    } else {
      this.send(Uint8Array.of(0xb0 | channel, 99, 0));
      this.send(Uint8Array.of(0xb0 | channel, 98, p.address & 0x7f));
      this.send(Uint8Array.of(0xb0 | channel, 6, byte & 0x80 ? 1 : 0));
      this.send(Uint8Array.of(0xb0 | channel, 38, byte & 0x7f));
    }
  }

  txChannel(): number {
    const c = this.mem[SYS_MIDI_CHANNEL];
    return c === 0 ? 0 : (c - 1) & 0x0f;
  }

  // -------------------------------------------------------------------------
  // SysEx.

  private receiveSysEx(msg: Uint8Array): void {
    if (!isMutableSysEx(msg)) return; // not for us: ignored up to the next F0
    let frame: SysExFrame;
    try {
      frame = decodeSysEx(msg);
    } catch {
      this.sysexStatus = '#';
      return;
    }
    if (frame.device !== DEVICE_SHRUTHI) return;
    const size = expectedSize(frame.command);
    if (size === null || frame.payload.length !== size) {
      this.sysexStatus = '#';
      return;
    }
    this.sysexStatus = this.accept(frame) ? '+' : '#';
  }

  private accept({ command, argument, payload }: SysExFrame): boolean {
    switch (command) {
      case SHRUTHI_CMD.patch:
        return this.acceptPatch(payload);
      case SHRUTHI_CMD.sequence:
        this.mem.set(payload, SEQ_STEPS);
        this.updatePatternSize();
        this.sanitize();
        return true;
      case SHRUTHI_CMD.wavetable:
        return true;
      case SHRUTHI_CMD.system:
        this.mem.set(payload, SYS);
        this.sanitize();
        if (this.firmware === 'shooz') {
          this.savedFilterCal = this.mem.slice(SHRUTHI_OFFSET.filterProfile, SHRUTHI_OFFSET.filterResonanceMax + 1);
        }
        return true;
      case SHRUTHI_CMD.step:
        this.mem.set(payload, SEQ_STEPS + 2 * (argument & 0x0f));
        return false; // applied, but the firmware reports '#'
      case SHRUTHI_CMD.name:
        this.mem.set(payload, SHRUTHI_NAME_OFFSET);
        return false; // ditto
      case SHRUTHI_CMD.sequencerState:
        this.mem.set(payload, SEQ);
        this.updatePatternSize();
        this.sanitize();
        return true;
      case SHRUTHI_CMD.patchRequest:
        this.reply(SHRUTHI_CMD.patch, 0, this.wirePatch());
        return true;
      case SHRUTHI_CMD.sequenceRequest:
        this.reply(SHRUTHI_CMD.sequence, 0, this.mem.slice(SEQ_STEPS, SEQ_STEPS + 32));
        return true;
      case SHRUTHI_CMD.systemRequest:
        this.reply(SHRUTHI_CMD.system, 0, this.mem.slice(SYS, SYS + SHRUTHI_SYSTEM_SIZE));
        return true;
      case SHRUTHI_CMD.stepRequest: {
        const step = argument & 0x0f;
        this.reply(SHRUTHI_CMD.step, step, this.mem.slice(SEQ_STEPS + 2 * step, SEQ_STEPS + 2 * step + 2));
        return true;
      }
      case SHRUTHI_CMD.nameRequest:
        this.reply(SHRUTHI_CMD.name, 0, this.mem.slice(SHRUTHI_NAME_OFFSET, SHRUTHI_NAME_OFFSET + 8));
        return true;
      case SHRUTHI_CMD.sequencerStateRequest:
        this.reply(SHRUTHI_CMD.sequencerState, 0, this.mem.slice(SEQ, SEQ + SHRUTHI_SEQUENCER_SIZE));
        return true;
      case SHRUTHI_CMD.numbersRequest: {
        const n = this.currentPatch;
        this.reply(SHRUTHI_CMD.numbersReply, 0, [n & 0xff, n >> 8, n & 0xff, n >> 8]);
        return true;
      }
      case SHRUTHI_CMD.banksRequest:
        this.reply(SHRUTHI_CMD.banksReply, this.banks, []);
        return true;
      case SHRUTHI_CMD.versionRequest: {
        const [a, b] = SHRUTHI_FIRMWARE.rom_version;
        const reply =
          this.firmware === 'shooz'
            ? [a, b, SHRUTHI_FIRMWARE.family, SHRUTHI_FIRMWARE.version, SHRUTHI_FIRMWARE.waveforms,
               SHRUTHI_FIRMWARE.patch_layout, this.freeStack, this.glitches,
               ...this.mem.subarray(SHRUTHI_OFFSET.filterProfile, SHRUTHI_OFFSET.filterResonanceMax + 1)]
            : [a, b];
        this.reply(SHRUTHI_CMD.versionReply, 0, reply);
        return true;
      }
      case SHRUTHI_CMD.writePatch:
      case SHRUTHI_CMD.writeSequence: {
        const slot = (payload[0] << 8) | payload[1];
        if (slot >= shruthiSlotCount(this.banks)) {
          // SHOOZ refuses; stock wrote somewhere else in the EEPROM.
          return this.firmware !== 'shooz';
        }
        if (command === SHRUTHI_CMD.writePatch) this.patchSlots.set(slot, this.wirePatch());
        else this.sequenceSlots.set(slot, this.mem.slice(SEQ_STEPS, SEQ_STEPS + 32));
        return true;
      }
      case SHRUTHI_CMD.randomizePatch:
        this.randomizePatch();
        return true;
      case SHRUTHI_CMD.randomizeSequence:
        for (let i = 0; i < 32; i++) this.mem[SEQ_STEPS + i] = this.random();
        return true;
      default:
        return true; // bulk blocks: accepted, not modelled
    }
  }

  /** `Storage::AcceptData<Patch>`: CheckBuffer, copy, Update, sanitize. */
  private acceptPatch(wire: ArrayLike<number>): boolean {
    if (!acceptsPatch(wire, this.firmware)) {
      this.mem.fill(0x2d, SHRUTHI_NAME_OFFSET, SHRUTHI_NAME_OFFSET + SHRUTHI_NAME_LENGTH); // '-'
      return false;
    }
    applyWirePatch(this.mem, wire, this.firmware);
    this.sanitize();
    return true;
  }

  private updatePatternSize(): void {
    let size = 16;
    for (let i = 0; i < 16; i++) {
      // SequenceStep::blank(): both bytes 0xff.
      if (this.mem[SEQ_STEPS + 2 * i] === 0xff && this.mem[SEQ_STEPS + 2 * i + 1] === 0xff) {
        size = i;
        break;
      }
    }
    this.mem[SEQ + 8] = size;
  }

  /** `Part::SanitizeParameters` (SHOOZ only). */
  private sanitize(): void {
    if (this.firmware !== 'shooz') return;
    for (let offset = 0; offset < SHRUTHI_ADDRESS_SPACE; offset++) {
      if (offset === 84 || offset === 85 || offset === 92 || offset === 93) continue;
      const p = nrpnParam(offset);
      if (p) this.mem[offset] = shruthiClamp(p, this.mem[offset]);
    }
  }

  private random(): number {
    // xorshift8; the firmware's sequence isn't reproduced, only "random".
    let x = this.rng;
    x ^= (x << 7) & 0xff;
    x ^= x >> 5;
    x ^= (x << 3) & 0xff;
    this.rng = x & 0xff;
    return this.rng;
  }

  /** `Editor::RandomizePatch`: a random in-range value for each patch parameter. */
  private randomizePatch(): void {
    for (const p of SHRUTHI_PARAMS) {
      if (p.section !== 'patch' || p.uiOnly || p.address >= 92) continue;
      if (p.address >= SHRUTHI_NAME_OFFSET && p.address < 84) continue;
      const range = p.max - p.min + 1;
      this.mem[p.address] = (p.min + (this.random() % range)) & 0xff;
    }
  }

  private reply(command: number, argument: number, payload: ArrayLike<number>): void {
    this.send(encodeSysEx(DEVICE_SHRUTHI, command, argument, payload));
  }
}
