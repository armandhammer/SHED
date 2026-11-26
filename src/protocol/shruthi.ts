// Shruthi-1 SysEx protocol (YAM 0.05 and SHOOZ), from `shruthi/storage.cc`.
//
// Same Mutable Instruments framing as the Ambika (device 0x02). The Shruthi
// has a single part, so the argument is unused except for step numbers and
// the bank count. Requests have no payload.
//
// Patch on the wire: the first 92 bytes of the RAM patch, with the filter
// modes packed into byte 86 and the two operators into bytes 87–90
// (`Patch::PrepareForWrite` / `Patch::Update`). Byte 91 is the format marker:
// '!' (old), '%' (YAM: bytes 76–83 carry legato/portamento and the
// sequencer settings) and, on SHOOZ, '&' when an envelope curve is not 0
// (curves in the high bits of byte 77). Stock YAM refuses '&' patches: the
// current sound stays and its name becomes "--------".

import { DEVICE_SHRUTHI, encodeSysEx } from '../midi/framer';
import {
  SHRUTHI_OFFSET,
  SHRUTHI_PATCH_RAM_SIZE,
  SHRUTHI_PATCH_SIZE,
} from '../model/params/shruthi';

export const SHRUTHI_CMD = {
  patch: 0x01,
  sequence: 0x02,
  wavetable: 0x03,
  system: 0x04,
  step: 0x05,
  name: 0x06,
  sequencerState: 0x07,
  numbersReply: 0x0a,
  banksReply: 0x0b,
  versionReply: 0x0c,
  patchRequest: 0x11,
  sequenceRequest: 0x12,
  systemRequest: 0x14,
  stepRequest: 0x15,
  nameRequest: 0x16,
  sequencerStateRequest: 0x17,
  numbersRequest: 0x1a,
  banksRequest: 0x1b,
  versionRequest: 0x1c,
  writePatch: 0x21,
  writeSequence: 0x22,
  randomizePatch: 0x31,
  randomizeSequence: 0x32,
} as const;

export const PATCH_MARKER = { old: 0x21, yam: 0x25, shooz: 0x26 } as const; // '!', '%', '&'

/** Byte 77 of the wire patch: seq mode (bits 0–1), SHOOZ curves (2–4, 5–7). */
export const PATCH_EXTRA_SEQ = 77;
export const PATCH_TOPOLOGY = 86;
export const PATCH_OP_DATA = 87;
export const PATCH_MARKER_BYTE = 91;

/** Patch slots: 16 internal + 64 per external EEPROM bank. */
export function shruthiSlotCount(banks: number): number {
  return 16 + 64 * banks;
}

export function shruthiRequest(command: number, argument = 0): Uint8Array {
  return encodeSysEx(DEVICE_SHRUTHI, command, argument);
}

export function shruthiPatchDump(wire: ArrayLike<number>): Uint8Array {
  return encodeSysEx(DEVICE_SHRUTHI, SHRUTHI_CMD.patch, 0, wire);
}

export function shruthiWriteRequest(command: number, slot: number): Uint8Array {
  return encodeSysEx(DEVICE_SHRUTHI, command, 0, [(slot >> 8) & 0xff, slot & 0xff]);
}

/** Which firmware family answered the version request. */
export interface ShruthiFirmware {
  /** ROM version bytes as stock sends them. */
  rom: [number, number];
  /** Present when the reply carries the SHOOZ capability bytes. */
  shooz?: {
    family: number;
    version: number;
    waveforms: number;
    patchLayout: number;
    freeStack: number;
    glitches: number;
  };
}

export function parseShruthiVersion(payload: Uint8Array): ShruthiFirmware {
  if (payload.length < 2) throw new Error(`version reply too short (${payload.length} bytes)`);
  const info: ShruthiFirmware = { rom: [payload[0], payload[1]] };
  if (payload.length >= 8 && payload[2] === 2) {
    info.shooz = {
      family: payload[2],
      version: payload[3],
      waveforms: payload[4],
      patchLayout: payload[5],
      freeStack: payload[6],
      glitches: payload[7],
    };
  }
  return info;
}

export function shoozVersionString(v: number): string {
  return `${v >> 4}.${v & 0x0f}`;
}

/** Envelope curve presets carried by a wire patch (0 unless the marker is '&'). */
export function patchCurves(wire: Uint8Array): [number, number] {
  if (wire[PATCH_MARKER_BYTE] !== PATCH_MARKER.shooz) return [0, 0];
  const b = wire[PATCH_EXTRA_SEQ];
  return [(b >> 2) & 7, (b >> 5) & 7];
}

/**
 * Wire patch (92 bytes) → RAM image (100 bytes): bytes 92–93 filter modes,
 * 94–99 the two operators (in1, in2, op), as `Patch::Update` unpacks them.
 */
export function unpackPatch(wire: ArrayLike<number>): Uint8Array {
  const ram = new Uint8Array(SHRUTHI_PATCH_RAM_SIZE);
  for (let i = 0; i < SHRUTHI_PATCH_SIZE; i++) ram[i] = wire[i] & 0xff;
  // Patches from very old firmware: clear the HPF and the new bytes.
  if (ram[89] === 0x6e && ram[90] === 0x67) ram.fill(0, 84, 92); // 'n', 'g'
  const op = ram.subarray(PATCH_OP_DATA, PATCH_OP_DATA + 4);
  for (let k = 0; k < 2; k++) {
    const a = op[2 * k];
    const b = op[2 * k + 1];
    let in2 = b >> 3;
    let operator = b & 0x07;
    if (a & 0x80) operator |= 0x08;
    if (a & 0x40) in2 |= 0x20;
    ram[94 + 3 * k] = a & 0x3f;
    ram[95 + 3 * k] = in2;
    ram[96 + 3 * k] = operator;
  }
  ram[93] = ram[PATCH_TOPOLOGY] & 0x0f;
  ram[92] = ram[PATCH_TOPOLOGY] >> 4;
  return ram;
}

export interface PackContext {
  /** Envelope curve presets (SHOOZ); [0, 0] keeps the stock format. */
  curves?: readonly [number, number];
  /** Bytes 76–83 (legato/portamento + sequencer settings); kept if omitted. */
  extra?: ArrayLike<number>;
}

/** RAM image (100 bytes) → wire patch (92 bytes), as `Patch::PrepareForWrite`. */
export function packPatch(ram: ArrayLike<number>, context: PackContext = {}): Uint8Array {
  const wire = new Uint8Array(SHRUTHI_PATCH_SIZE);
  for (let i = 0; i < SHRUTHI_PATCH_SIZE; i++) wire[i] = ram[i] & 0xff;
  wire[PATCH_MARKER_BYTE] = PATCH_MARKER.yam;
  wire[PATCH_TOPOLOGY] = ((ram[92] & 0x0f) << 4) | (ram[93] & 0x0f);
  for (let k = 0; k < 2; k++) {
    const in1 = ram[94 + 3 * k];
    const in2 = ram[95 + 3 * k];
    const operator = ram[96 + 3 * k];
    let a = in1 & 0xff;
    const b = ((in2 << 3) | (operator & 0x07)) & 0xff;
    if (operator & 0x08) a |= 0x80;
    if (in2 & 0x20) a |= 0x40;
    wire[PATCH_OP_DATA + 2 * k] = a;
    wire[PATCH_OP_DATA + 2 * k + 1] = b;
  }
  if (context.extra) for (let i = 0; i < 8; i++) wire[76 + i] = context.extra[i] & 0xff;
  const [c1, c2] = context.curves ?? [0, 0];
  const curves = ((c1 & 7) << 2) | ((c2 & 7) << 5);
  wire[PATCH_EXTRA_SEQ] = (wire[PATCH_EXTRA_SEQ] & 0x03) | curves;
  if (curves) wire[PATCH_MARKER_BYTE] = PATCH_MARKER.shooz;
  return wire;
}

/** `Patch::CheckBuffer`: what the firmware accepts as a patch. */
export function acceptsPatch(wire: ArrayLike<number>, firmware: 'stock' | 'shooz'): boolean {
  for (let i = 8; i < 24; i++) if (wire[i] >= 128) return false;
  const m = wire[PATCH_MARKER_BYTE];
  return m === PATCH_MARKER.old || m === PATCH_MARKER.yam || (firmware === 'shooz' && m === PATCH_MARKER.shooz);
}

/** True for offsets inside the parameter address space (NRPN 0–158). */
export function isEditableOffset(address: number): boolean {
  return address >= 0 && address <= SHRUTHI_OFFSET.envCurve2;
}

// ---------------------------------------------------------------------------
// The whole parameter address space (patch RAM 0–99, sequencer settings
// 100–141, system settings 142–156, SHOOZ curves 157–158) against a wire
// patch. A patch carries more than the patch RAM: bytes 76–83 hold
// legato/portamento (system settings) and the sequencer settings, and on
// SHOOZ the curves live in byte 77.

const SEQ = SHRUTHI_OFFSET.sequencer;
const SYS_PORTAMENTO = SHRUTHI_OFFSET.system + 2;
const SYS_LEGATO = SHRUTHI_OFFSET.system + 3;

/** The address-space bytes a patch dump carries, as `Patch::PrepareForWrite` packs them. */
export function wirePatchFromSpace(mem: ArrayLike<number>, firmware: 'stock' | 'shooz'): Uint8Array {
  const extra = new Uint8Array(8);
  extra[0] = (mem[SYS_LEGATO] ? 0x40 : 0) | (mem[SYS_PORTAMENTO] & 0x3f);
  extra[1] = mem[SEQ] & 0x03;
  for (let i = 0; i < 3; i++) extra[2 + i] = mem[SEQ + 1 + i];
  extra[5] = ((mem[SEQ + 4] << 4) | (mem[SEQ + 5] & 0x0f)) & 0xff;
  extra[6] = mem[SEQ + 6];
  extra[7] = mem[SEQ + 7];
  const curves: [number, number] =
    firmware === 'shooz' ? [mem[SHRUTHI_OFFSET.envCurve1], mem[SHRUTHI_OFFSET.envCurve2]] : [0, 0];
  return packPatch(mem, { extra, curves });
}

/**
 * Applies an accepted wire patch to the address space (`Storage::AcceptData`
 * + `Part::UpdatePatch`): the patch RAM, the curves (0 unless SHOOZ and
 * '&'), and for '%'/'&' patches the legato/portamento and sequencer settings.
 */
export function applyWirePatch(mem: Uint8Array, wire: ArrayLike<number>, firmware: 'stock' | 'shooz'): void {
  const bytes = Uint8Array.from(wire);
  mem.set(unpackPatch(bytes), 0);
  const [c1, c2] = firmware === 'shooz' ? patchCurves(bytes) : [0, 0];
  mem[SHRUTHI_OFFSET.envCurve1] = c1;
  mem[SHRUTHI_OFFSET.envCurve2] = c2;
  const marker = bytes[PATCH_MARKER_BYTE];
  if (marker === PATCH_MARKER.yam || marker === PATCH_MARKER.shooz) {
    const extra = bytes.subarray(76, 84);
    mem[SYS_LEGATO] = extra[0] & 0x40 ? 1 : 0;
    mem[SYS_PORTAMENTO] = extra[0] & 0x3f;
    mem[SEQ] = extra[1] & 0x03;
    mem.set(extra.subarray(2, 5), SEQ + 1);
    mem[SEQ + 4] = extra[5] >> 4;
    mem[SEQ + 5] = extra[5] & 0x0f;
    mem[SEQ + 6] = extra[6];
    mem[SEQ + 7] = extra[7];
  }
}
