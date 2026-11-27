import { describe, expect, it } from 'vitest';
import {
  AMBIKA_PARAMS,
  INIT_PART,
  INIT_PATCH,
  MOD_SOURCES,
  NUM_OSC_SHAPES,
  OSC_SHAPES,
  OSC_SHAPE_GROUPS,
  PART_SIZE,
  PATCH_SIZE,
  RAGAS,
  isNrpnAddress,
  param,
  paramAt,
  parseMulti,
  receivesOn,
  txChannel,
} from '../src/model/params/ambika';
import { clamp, formatValue, fromByte, toByte } from '../src/model/params/types';

// `midi_nrpn_map` from BAMBI controller/parameter.cc: address → parameter id
// (255 = none, 254 = raw sequencer byte).
// prettier-ignore
const FIRMWARE_NRPN_MAP = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 31, 30, 255, 29,
  25, 26, 27, 28, 31, 30, 255, 29, 25, 26, 27, 28, 31, 30, 255, 29,
  33, 32, 35, 36, 37, 35, 36, 37, 35, 36, 37, 35, 36, 37, 35, 36,
  37, 35, 36, 37, 35, 36, 37, 35, 36, 37, 35, 36, 37, 35, 36, 37,
  35, 36, 37, 35, 36, 37, 35, 36, 37, 35, 36, 37, 39, 40, 41, 39,
  40, 41, 39, 40, 41, 39, 40, 41, 73, 74, 75, 76, 77, 78, 255, 255,
  42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
  ...new Array(64).fill(254),
  79, ...new Array(63).fill(255),
];

// `midi_cc_map` from the same file: CC → parameter id (255 = none).
// prettier-ignore
const FIRMWARE_CC_MAP = [
  255, 255, 255, 22, 255, 48, 255, 42, 255, 23, 255, 255, 14, 15, 2, 3,
  0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19, 20, 21,
  255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 29, 30, 31, 32,
  33, 255, 255, 255, 29, 30, 31, 255, 255, 255, 255, 255, 29, 30, 31, 255,
  255, 255, 255, 255, 47, 255, 27, 17, 28, 25, 16, 26, 255, 255, 27, 255,
  28, 25, 255, 26, 255, 255, 27, 255, 28, 25, 255, 26, 255, 255, 44, 45,
  255, 255, 255, 255, 255, 255, 49, 50, 51, 52, 53, 57, 73, 74, 75, 76,
  77, 78, 79, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
];

describe('Ambika parameter map', () => {
  it('covers exactly the addresses the firmware accepts over NRPN', () => {
    expect(FIRMWARE_NRPN_MAP).toHaveLength(256);
    const firmware = FIRMWARE_NRPN_MAP.flatMap((id, address) => (id !== 255 && id !== 254 ? [address] : []));
    expect(AMBIKA_PARAMS.map((d) => d.address)).toEqual(firmware);
    for (let address = 0; address < 256; address++) {
      expect(isNrpnAddress(address)).toBe(FIRMWARE_NRPN_MAP[address] !== 255);
    }
  });

  it('maps addresses that share a firmware parameter id to the same kind of parameter', () => {
    const kindById = new Map<number, string>();
    FIRMWARE_NRPN_MAP.forEach((id, address) => {
      if (id >= 254) return;
      const def = paramAt(address)!;
      const kind = `${def.unit}:${def.min}:${def.max}:${def.id.replace(/\d+/g, '#')}`;
      if (kindById.has(id)) expect(kind).toBe(kindById.get(id));
      else kindById.set(id, kind);
    });
  });

  it('uses the same CC numbers as the firmware', () => {
    const firmwareCcs = FIRMWARE_CC_MAP.flatMap((id, cc) => (id !== 255 ? [cc] : [])).sort((a, b) => a - b);
    const ours = AMBIKA_PARAMS.flatMap((d) => (d.cc !== undefined ? [d.cc] : [])).sort((a, b) => a - b);
    expect(ours).toEqual(firmwareCcs);
    // Same firmware id ⇔ same parameter kind (instances of envelopes/LFOs).
    const byId = new Map<number, string>();
    for (const d of AMBIKA_PARAMS) {
      if (d.cc === undefined) continue;
      const id = FIRMWARE_CC_MAP[d.cc];
      const kind = d.id.replace(/\d+/g, '#');
      if (byId.has(id)) expect(kind).toBe(byId.get(id));
      else byId.set(id, kind);
    }
  });

  it('has unique ids and addresses inside patch + part', () => {
    expect(new Set(AMBIKA_PARAMS.map((d) => d.id)).size).toBe(AMBIKA_PARAMS.length);
    for (const d of AMBIKA_PARAMS) {
      expect(d.address).toBeGreaterThanOrEqual(0);
      expect(d.address).toBeLessThan(PATCH_SIZE + PART_SIZE);
      expect(d.level).toBe(d.address < PATCH_SIZE ? 'patch' : 'part');
      if (d.labels && d.unit === 'enum') expect(d.labels.length).toBeGreaterThanOrEqual(d.max - d.min + 1);
    }
  });

  it('round-trips every value of every parameter through the wire byte', () => {
    for (const d of AMBIKA_PARAMS) {
      for (let v = d.min; v <= d.max; v++) {
        const b = toByte(d, v);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(256);
        expect(fromByte(d, b)).toBe(v);
      }
    }
  });

  it('encodes signed parameters as two-complement bytes and clamps', () => {
    const range = param('osc1.range');
    expect(toByte(range, -24)).toBe(232);
    expect(fromByte(range, 232)).toBe(-24);
    expect(toByte(range, -100)).toBe(232);
    expect(clamp(param('mod1.amount'), 99)).toBe(63);
    expect(fromByte(param('part.tuning'), 0x81)).toBe(-127);
  });

  it('offers all 43 YAM oscillator shapes, including 38–42 that Ixox could not select', () => {
    expect(NUM_OSC_SHAPES).toBe(43);
    const shape = param('osc2.shape');
    expect(shape.max).toBe(42);
    expect(formatValue(shape, 37)).toBe('wavquence');
    expect(formatValue(shape, 42)).toBe('vowel 2');
    const grouped = OSC_SHAPE_GROUPS.flatMap((g) => g.shapes).sort((a, b) => a - b);
    expect(grouped).toEqual(OSC_SHAPES.map((_, i) => i));
  });

  it('places the BAMBI additions at the documented addresses', () => {
    expect(['env1.curve', 'env2.curve', 'env3.curve', 'voice.vintage', 'part.spreadMode'].map((id) => [param(id).address, param(id).cc, param(id).since])).toEqual([
      [106, 110, 'yamplus'],
      [107, 111, 'yamplus'],
      [108, 112, 'yamplus'],
      [109, 113, 'yamplus'],
      [192, 114, 'yamplus'],
    ]);
    expect(formatValue(param('part.spreadMode'), 1)).toBe('center');
  });

  it('has the YAM+ 0.2 polyphony and spread mode values, gated to BAMBI 0.2', () => {
    // Order of PolyphonyMode / SpreadMode in BAMBI controller/part.h.
    const mode = param('part.polyphony');
    expect(mode.labels).toEqual(['mono', 'poly', '2x unison', 'cyclic', 'chain', '3x unison', '4x unison']);
    expect(mode.valuesSince).toEqual({ from: 5, yamPlus: 0x02 });
    const spread = param('part.spreadMode');
    expect(spread.max).toBe(3);
    expect(formatValue(spread, 3)).toBe('sub oct');
    expect(spread.valuesSince).toEqual({ from: 3, yamPlus: 0x02 });
  });

  it('formats LFO rates as synced divisions then free values', () => {
    const rate = param('lfo1.rate');
    expect(rate.max).toBe(142);
    expect(formatValue(rate, 0)).toBe('1/1');
    expect(formatValue(rate, 14)).toBe('1/96');
    expect(formatValue(rate, 15)).toBe('0');
    expect(formatValue(rate, 142)).toBe('127');
  });

  it('limits matrix sources to constant 256 while modifiers take every source', () => {
    expect(param('mod1.source').max).toBe(24);
    expect(MOD_SOURCES[24]).toBe('= 256');
    expect(param('modifier1.in1').max).toBe(MOD_SOURCES.length - 1);
    expect(RAGAS).toHaveLength(32);
  });

  it('ships init data of the right sizes, in range for every parameter', () => {
    expect(INIT_PATCH).toHaveLength(PATCH_SIZE);
    expect(INIT_PART).toHaveLength(PART_SIZE);
    for (const d of AMBIKA_PARAMS) {
      const byte = d.address < PATCH_SIZE ? INIT_PATCH[d.address] : INIT_PART[d.address - PATCH_SIZE];
      const v = fromByte(d, byte);
      expect(v, d.id).toBeGreaterThanOrEqual(d.min);
      expect(v, d.id).toBeLessThanOrEqual(d.max);
    }
  });

  it('parses the multi part mappings and channel rules', () => {
    const multi = new Uint8Array(56);
    multi.set([0, 0, 127, 0x3f, 3, 36, 60, 0x01]);
    const { parts } = parseMulti(multi);
    expect(parts[0]).toEqual({ channel: 0, keyLow: 0, keyHigh: 127, voices: 0x3f });
    expect(txChannel(parts[0])).toBe(0);
    expect(receivesOn(parts[0], 9)).toBe(true);
    expect(txChannel(parts[1])).toBe(2);
    expect(receivesOn(parts[1], 2)).toBe(true);
    expect(receivesOn(parts[1], 0)).toBe(false);
  });
});
