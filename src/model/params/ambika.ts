// Ambika (YAM / BAMBI YAM+) parameter map.
//
// Single source of truth, transcribed from BAMBI `controller/parameter.cc`
// (ranges, units, CC numbers), `common/patch.h` (Patch layout) and
// `controller/part.h` (PartData layout). The NRPN number of a parameter is its
// raw byte address: 0–111 = Patch, 112–195 = PartData.

import { LFO_SYNCED_RATES, type ParamDef, type ParamLevel, type ParamUnit } from './types';

export const PATCH_SIZE = 112;
export const PART_SIZE = 84;
export const PART_BASE = PATCH_SIZE;
export const MULTI_SIZE = 56;
export const SEQUENCE_SIZE = 72;
export const NUM_PARTS = 6;

// ---------------------------------------------------------------------------
// Enumerations (labels follow the firmware's string resources).

/** All 43 YAM oscillator shapes (`WAVEFORM_NONE` … `WAVEFORM_VOWEL_2`). */
export const OSC_SHAPES = [
  'none', 'saw', 'square', 'triangle', 'sine',
  'zsaw', 'lpzsaw', 'pkzsaw', 'bpzsaw', 'hpzsaw',
  'lpzpulse', 'pkzpulse', 'bpzpulse', 'hpzpulse', 'ztriangle',
  'pad', 'fm', '8bits', 'pwm', 'noise', 'vowel',
  // Wavetables 1–16.
  'male', 'female', 'choir', 'tampura', 'bowed', 'cello', 'vibes', 'slap',
  'epiano', 'organ', 'waves', 'digital', 'drone 1', 'drone 2', 'metallic', 'bell',
  'wavquence', 'oldsaw', 'qpwm', 'fmfb', 'csaw', 'vowel 2',
] as const;

export const NUM_OSC_SHAPES = OSC_SHAPES.length; // 43 = WAVEFORM_LAST

/** Grouping for the shape picker. */
export const OSC_SHAPE_GROUPS: readonly { label: string; shapes: readonly number[] }[] = [
  { label: 'Classic', shapes: [0, 1, 2, 3, 4, 38, 41, 39, 18] },
  { label: 'Phase distortion', shapes: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14] },
  { label: 'Digital', shapes: [15, 16, 40, 17, 19, 20, 42] },
  { label: 'Wavetables', shapes: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37] },
];

export const SUB_SHAPES = [
  'square −1', 'triangle −1', 'pulse −1', 'square −2', 'triangle −2', 'pulse −2',
  'click', 'glitch', 'blow', 'metallic', 'pop',
] as const;

export const MIX_OPERATORS = ['sum', 'sync', 'ring mod', 'xor', 'fold', 'bits'] as const;
export const FILTER_MODES = ['LP', 'BP', 'HP', 'Notch'] as const;
export const LFO_SYNC_MODES = ['free', 'env→lfo', 'lfo→env'] as const;
export const LFO_SHAPES = [
  'triangle', 'square', 's&h', 'ramp',
  'sine', 'harm 2', 'harm 3', 'harm 5', 'grg 1', 'grg 2', 'bat 1', 'bat 2',
  'spike 1', 'spike 2', 'lsaw', 'lsqr', 'rsaw', 'rsqr', 'step 1', 'step 2',
] as const;
export const VOICE_LFO_SHAPES = LFO_SHAPES.slice(0, 4);

export const MOD_SOURCES = [
  'env 1', 'env 2', 'env 3',
  'lfo 1', 'lfo 2', 'lfo 3', 'lfo 4',
  'mod 1', 'mod 2', 'mod 3', 'mod 4',
  'seq 1', 'seq 2', 'arp step',
  'velocity', 'aftertouch', 'bender', 'mod wheel', 'wheel 2', 'pedal',
  'note', 'gate', 'noise', 'random',
  '= 256', '= 128', '= 64', '= 32', '= 16', '= 8', '= 4',
] as const;
/** Mod matrix sources stop at `MOD_SRC_CONSTANT_256`; modifiers accept all. */
export const MOD_MATRIX_SOURCE_MAX = 24;

export const MOD_DESTINATIONS = [
  'param 1', 'param 2', 'osc 1', 'osc 2', 'osc 1+2', 'vibrato',
  'mix', 'xmod', 'noise', 'sub osc', 'fuzz', 'crush',
  'cutoff', 'resonance',
  'attack', 'decay', 'release', 'lfo 4',
  'vca',
] as const;

export const MODIFIERS = [
  'off', 'sum', 'product', 'attenuate', 'max', 'min', 'xor', '≥', '≤', 'quantize', 'lag',
] as const;

export const ARP_MODES = ['step seq', 'arpeggio', 'pattern'] as const;
export const ARP_DIRECTIONS = ['up', 'down', 'up&down', 'played', 'random', 'chord'] as const;
export const POLYPHONY_MODES = ['mono', 'poly', '2x unison', 'cyclic', 'chain', '3x unison', '4x unison'] as const;
export const SPREAD_MODES = ['stack', 'center', 'wide', 'sub oct'] as const;
/** YAM+ 0.2 (BAMBI): 3x/4x unison (polyphony 5, 6) and the sub-octave spread mode (3). */
export const YAMPLUS_0_2 = 0x02;
export const NUM_ARP_PATTERNS = 22;
export const RAGAS = [
  'equal', 'just', 'pythagorean', '1/4 eb', '1/4 e', '1/4 ea',
  'bhairav', 'gunakri', 'marwa', 'shree', 'purvi', 'bilawal', 'yaman', 'kafi',
  'bhimpalasree', 'darbari', 'bageshree', 'rageshree', 'khamaj', "mi'mal",
  'parameshwari', 'rangeshwari', 'gangeshwari', 'kameshwari', 'pa. kafi',
  'natbhairav', 'm.kauns', 'bairagi', 'b.todi', 'chandradeep', 'kaushik todi',
  'jogeshwari', 'rasia',
].slice(0, 32);

// ---------------------------------------------------------------------------
// Definitions.

interface Spec {
  id: string;
  name: string;
  short: string;
  group: string;
  unit: ParamUnit;
  min: number;
  max: number;
  labels?: readonly string[];
  cc?: number;
  instance?: number;
  since?: 'yamplus';
  valuesSince?: { from: number; yamPlus: number; fallback: number };
}

const defs: ParamDef[] = [];

function add(address: number, spec: Spec): void {
  const level: ParamLevel = address < PART_BASE ? 'patch' : 'part';
  defs.push({ address, level, ...spec });
}

function e(labels: readonly string[]): { unit: ParamUnit; min: number; max: number; labels: readonly string[] } {
  return { unit: 'enum', min: 0, max: labels.length - 1, labels };
}

// Oscillators: 0–7.
for (let i = 0; i < 2; i++) {
  const base = i * 4;
  const group = `osc${i + 1}`;
  const label = `Osc ${i + 1}`;
  add(base + 0, { id: `${group}.shape`, name: `${label} shape`, short: 'wave', group, ...e(OSC_SHAPES), cc: 16 + i * 2, instance: i });
  add(base + 1, { id: `${group}.param`, name: `${label} parameter`, short: 'prm', group, unit: 'raw', min: 0, max: 127, cc: 17 + i * 2, instance: i });
  add(base + 2, { id: `${group}.range`, name: `${label} range`, short: 'rnge', group, unit: 'int', min: -24, max: 24, cc: i ? 20 : 14, instance: i });
  add(base + 3, { id: `${group}.detune`, name: `${label} detune`, short: 'tune', group, unit: 'int', min: -64, max: 64, cc: i ? 21 : 15, instance: i });
}

// Mixer: 8–15.
add(8, { id: 'mix.balance', name: 'Osc mix', short: 'mix', group: 'mixer', unit: 'uint', min: 0, max: 63, cc: 22 });
add(9, { id: 'mix.operator', name: 'Crossmod', short: 'xmod', group: 'mixer', ...e(MIX_OPERATORS), cc: 23 });
add(10, { id: 'mix.param', name: 'Crossmod amount', short: 'amnt', group: 'mixer', unit: 'uint', min: 0, max: 63, cc: 24 });
add(11, { id: 'mix.subShape', name: 'Sub osc shape', short: 'wave', group: 'mixer', ...e(SUB_SHAPES), cc: 25 });
add(12, { id: 'mix.sub', name: 'Sub osc level', short: 'sub', group: 'mixer', unit: 'uint', min: 0, max: 63, cc: 26 });
add(13, { id: 'mix.noise', name: 'Noise', short: 'nois', group: 'mixer', unit: 'uint', min: 0, max: 63, cc: 27 });
add(14, { id: 'mix.fuzz', name: 'Fuzz', short: 'fuzz', group: 'mixer', unit: 'uint', min: 0, max: 63, cc: 12 });
add(15, { id: 'mix.crush', name: 'Crush', short: 'crsh', group: 'mixer', unit: 'uint', min: 0, max: 31, cc: 13 });

// Filters: 16–23, plus 104–105.
add(16, { id: 'filter1.cutoff', name: 'Cutoff', short: 'freq', group: 'filter', unit: 'raw', min: 0, max: 127, cc: 74 });
add(17, { id: 'filter1.resonance', name: 'Resonance', short: 'reso', group: 'filter', unit: 'uint', min: 0, max: 63, cc: 71 });
add(18, { id: 'filter1.mode', name: 'Filter mode', short: 'mode', group: 'filter', ...e(FILTER_MODES), cc: 28 });
add(19, { id: 'filter2.cutoff', name: 'Filter 2 cutoff', short: 'freq', group: 'filter2', unit: 'raw', min: 0, max: 127, cc: 29 });
add(20, { id: 'filter2.resonance', name: 'Filter 2 resonance', short: 'reso', group: 'filter2', unit: 'uint', min: 0, max: 63, cc: 30 });
add(21, { id: 'filter2.mode', name: 'Filter 2 mode', short: 'mode', group: 'filter2', ...e(FILTER_MODES), cc: 31 });
add(22, { id: 'filter.env', name: 'Env 2 → cutoff', short: 'env2', group: 'filter', unit: 'uint', min: 0, max: 63, cc: 3 });
add(23, { id: 'filter.lfo', name: 'LFO 2 → cutoff', short: 'lfo2', group: 'filter', unit: 'uint', min: 0, max: 63, cc: 9 });

// Envelopes and LFOs: 24–47, stride 8. Byte 30 + 8n is padding.
for (let i = 0; i < 3; i++) {
  const base = 24 + i * 8;
  const env = `env${i + 1}`;
  const lfo = `lfo${i + 1}`;
  const cc = (c: number) => c + i * 8;
  add(base + 0, { id: `${env}.attack`, name: `Env ${i + 1} attack`, short: 'attk', group: env, unit: 'raw', min: 0, max: 127, cc: cc(73), instance: i });
  add(base + 1, { id: `${env}.decay`, name: `Env ${i + 1} decay`, short: 'deca', group: env, unit: 'raw', min: 0, max: 127, cc: cc(75), instance: i });
  add(base + 2, { id: `${env}.sustain`, name: `Env ${i + 1} sustain`, short: 'sust', group: env, unit: 'raw', min: 0, max: 127, cc: cc(70), instance: i });
  add(base + 3, { id: `${env}.release`, name: `Env ${i + 1} release`, short: 'rele', group: env, unit: 'raw', min: 0, max: 127, cc: cc(72), instance: i });
  add(base + 4, { id: `${lfo}.shape`, name: `LFO ${i + 1} shape`, short: 'wave', group: lfo, ...e(LFO_SHAPES), cc: cc(46), instance: i });
  add(base + 5, { id: `${lfo}.rate`, name: `LFO ${i + 1} rate`, short: 'rate', group: lfo, unit: 'lfoRate', min: 0, max: LFO_SYNCED_RATES.length + 127, cc: cc(45), instance: i });
  add(base + 7, { id: `${lfo}.sync`, name: `LFO ${i + 1} trigger`, short: 'trig', group: lfo, ...e(LFO_SYNC_MODES), cc: cc(44), instance: i });
}

// Voice LFO: 48–49.
add(48, { id: 'lfo4.shape', name: 'Voice LFO shape', short: 'wave', group: 'lfo4', ...e(VOICE_LFO_SHAPES), cc: 48 });
add(49, { id: 'lfo4.rate', name: 'Voice LFO rate', short: 'rate', group: 'lfo4', unit: 'raw', min: 0, max: 127, cc: 47 });

// Modulation matrix: 50–91, 14 slots × (source, destination, amount).
for (let i = 0; i < 14; i++) {
  const base = 50 + i * 3;
  const group = 'matrix';
  const id = `mod${i + 1}`;
  add(base + 0, { id: `${id}.source`, name: `Mod ${i + 1} source`, short: 'srce', group, unit: 'enum', min: 0, max: MOD_MATRIX_SOURCE_MAX, labels: MOD_SOURCES, instance: i });
  add(base + 1, { id: `${id}.destination`, name: `Mod ${i + 1} destination`, short: 'dest', group, ...e(MOD_DESTINATIONS), instance: i });
  add(base + 2, { id: `${id}.amount`, name: `Mod ${i + 1} amount`, short: 'amnt', group, unit: 'int', min: -63, max: 63, instance: i });
}

// Modifiers: 92–103, 4 × (operand 1, operand 2, operator).
for (let i = 0; i < 4; i++) {
  const base = 92 + i * 3;
  const group = 'modifiers';
  const id = `modifier${i + 1}`;
  add(base + 0, { id: `${id}.in1`, name: `Modifier ${i + 1} input 1`, short: 'in1', group, ...e(MOD_SOURCES), instance: i });
  add(base + 1, { id: `${id}.in2`, name: `Modifier ${i + 1} input 2`, short: 'in2', group, ...e(MOD_SOURCES), instance: i });
  add(base + 2, { id: `${id}.operator`, name: `Modifier ${i + 1} operator`, short: 'op', group, ...e(MODIFIERS), instance: i });
}

add(104, { id: 'filter.velocity', name: 'Velocity → cutoff', short: 'velo', group: 'filter', unit: 'uint', min: 0, max: 63, cc: 108 });
add(105, { id: 'filter.keytrack', name: 'Keyboard → cutoff', short: 'keyb', group: 'filter', unit: 'int', min: -63, max: 63, cc: 109 });

// BAMBI (YAM+) additions: 106–109. Bytes 110–111 are spare.
for (let i = 0; i < 3; i++) {
  add(106 + i, { id: `env${i + 1}.curve`, name: `Env ${i + 1} curve`, short: `crv${i + 1}`, group: `env${i + 1}`, unit: 'uint', min: 0, max: 127, cc: 110 + i, instance: i, since: 'yamplus' });
}
add(109, { id: 'voice.vintage', name: 'Vintage', short: 'vint', group: 'voice', unit: 'uint', min: 0, max: 127, cc: 113, since: 'yamplus' });

// Part: 112–127, 192.
add(112, { id: 'part.volume', name: 'Volume', short: 'volu', group: 'part', unit: 'raw', min: 0, max: 127, cc: 7 });
add(113, { id: 'part.octave', name: 'Octave', short: 'octv', group: 'part', unit: 'int', min: -2, max: 2 });
add(114, { id: 'part.tuning', name: 'Tuning', short: 'tune', group: 'part', unit: 'int', min: -127, max: 127, cc: 94 });
add(115, { id: 'part.spread', name: 'Spread', short: 'sprd', group: 'part', unit: 'uint', min: 0, max: 40, cc: 95 });
add(116, { id: 'part.raga', name: 'Raga', short: 'raga', group: 'part', unit: 'enum', min: 0, max: 31, labels: RAGAS });
add(117, { id: 'part.legato', name: 'Legato', short: 'lega', group: 'part', unit: 'bool', min: 0, max: 1, cc: 68 });
add(118, { id: 'part.portamento', name: 'Portamento', short: 'port', group: 'part', unit: 'uint', min: 0, max: 63, cc: 5 });
add(119, { id: 'arp.mode', name: 'Arp/seq mode', short: 'a/sq', group: 'arp', ...e(ARP_MODES), cc: 102 });
add(120, { id: 'arp.direction', name: 'Arp direction', short: 'dir', group: 'arp', ...e(ARP_DIRECTIONS), cc: 103 });
// UNIT_INT8 in the firmware, but the range is positive so it is unsigned on the wire.
add(121, { id: 'arp.octave', name: 'Arp range', short: 'rnge', group: 'arp', unit: 'uint', min: 1, max: 4, cc: 104 });
add(122, { id: 'arp.pattern', name: 'Arp pattern', short: 'patt', group: 'arp', unit: 'index', min: 0, max: NUM_ARP_PATTERNS - 1, cc: 105 });
add(123, { id: 'arp.resolution', name: 'Arp grid', short: 'grid', group: 'arp', unit: 'enum', min: 0, max: 14, labels: LFO_SYNCED_RATES, cc: 106 });
for (let i = 0; i < 3; i++) {
  add(124 + i, { id: `seq.length${i + 1}`, name: i < 2 ? `Seq ${i + 1} length` : 'Pattern length', short: i < 2 ? `len${i + 1}` : 'lenp', group: 'seq', unit: 'uint', min: 1, max: 32, instance: i });
}
add(127, { id: 'part.polyphony', name: 'Voice mode', short: 'mode', group: 'part', ...e(POLYPHONY_MODES), cc: 107, valuesSince: { from: 5, yamPlus: YAMPLUS_0_2, fallback: 2 } });
add(192, { id: 'part.spreadMode', name: 'Spread mode', short: 'sprm', group: 'part', ...e(SPREAD_MODES), cc: 114, since: 'yamplus', valuesSince: { from: 3, yamPlus: YAMPLUS_0_2, fallback: 1 } });

export const AMBIKA_PARAMS: readonly ParamDef[] = defs.sort((a, b) => a.address - b.address);

const byAddress = new Map(AMBIKA_PARAMS.map((d) => [d.address, d]));
const byId = new Map(AMBIKA_PARAMS.map((d) => [d.id, d]));

export function paramAt(address: number): ParamDef | undefined {
  return byAddress.get(address);
}

export function param(id: string): ParamDef {
  const d = byId.get(id);
  if (!d) throw new Error(`unknown Ambika parameter ${id}`);
  return d;
}

/**
 * True for addresses the firmware accepts over NRPN: every defined parameter
 * plus the raw sequencer bytes 128–191 (`midi_nrpn_map` = 254).
 */
export function isNrpnAddress(address: number): boolean {
  return byAddress.has(address) || (address >= 128 && address <= 191);
}

/** Address → (object, offset within the object). */
export function splitAddress(address: number): { level: ParamLevel; offset: number } {
  return address < PART_BASE ? { level: 'patch', offset: address } : { level: 'part', offset: address - PART_BASE };
}

// ---------------------------------------------------------------------------
// Init data (`init_patch` / `init_part` in controller/part.cc).

const LFO_FREE = LFO_SYNCED_RATES.length;

export const INIT_PATCH: readonly number[] = [
  // Oscillators: saw; pwm 32, −12, +12.
  1, 0, 0, 0,
  2, 32, (-12) & 0xff, 12,
  // Mixer.
  32, 0, 31, 0, 0, 0, 0, 0,
  // Filters, env/lfo amounts.
  96, 0, 0, 0, 0, 0, 24, 0,
  // Envelopes / LFOs.
  0, 40, 20, 60, 0, LFO_FREE + 24, 0, 0,
  0, 40, 0, 40, 0, LFO_FREE + 32, 0, 0,
  0, 40, 100, 40, 0, LFO_FREE + 48, 0, 0,
  // Voice LFO: triangle, 72.
  0, 72,
  // Modulation matrix.
  0, 0, 0,
  0, 1, 0,
  3, 2, 0,
  3, 3, 0,
  4, 0, 0,
  4, 1, 0,
  5, 6, 0,
  6, 12, 0,
  11, 12, 0,
  12, 6, 0,
  2, 18, 63,
  14, 18, 16,
  16, 4, 32,
  6, 4, 16,
  // Modifiers.
  3, 4, 0,
  4, 5, 0,
  5, 11, 0,
  11, 12, 0,
  // Filter velo/kbt, env curves, vintage, spare.
  0, 0, 0, 0, 0, 0, 0, 0,
];

export const INIT_PART: readonly number[] = (() => {
  const p = new Array<number>(PART_SIZE).fill(0);
  p[0] = 120; // volume
  p[9] = 1; // arp octave
  p[11] = 10; // arp divider: 1/16
  p[12] = p[13] = p[14] = 16; // sequence lengths
  p[15] = 1; // poly
  const seq1 = [0xff, 0xff, 0x80, 0x80, 0xcc, 0xcc, 0x20, 0x20, 0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xff];
  const seq2 = [0x00, 0x10, 0x20, 0x40, 0x80, 0xff, 0x80, 0x40, 0x20, 0x20, 0x20, 0x20, 0x00, 0x00, 0x80, 0x40];
  seq1.forEach((v, i) => (p[16 + i] = v));
  seq2.forEach((v, i) => (p[32 + i] = v));
  for (let step = 0; step < 16; step++) {
    const note = step % 4 < 2 ? 60 : 48;
    p[48 + step * 2] = note | (step % 2 === 0 ? 0x80 : 0);
    p[49 + step * 2] = 100;
  }
  // Step 12 also has its gate and legato flags set in the firmware's init part.
  p[48 + 11 * 2] |= 0x80;
  p[49 + 11 * 2] |= 0x80;
  p[80] = 1; // spread mode: center for new parts (YAM+)
  return p;
})();

export function initPatch(): Uint8Array {
  return Uint8Array.from(INIT_PATCH);
}

export function initPart(): Uint8Array {
  return Uint8Array.from(INIT_PART);
}

// ---------------------------------------------------------------------------
// Multi (56 bytes): per part {channel (0 = omni), key low, key high, voice
// allocation bitmask}, then clock and knob assignments.

export interface PartMapping {
  channel: number; // 0 = omni, 1–16
  keyLow: number;
  keyHigh: number;
  voices: number; // bit n = voicecard n
}

export function parseMulti(multi: Uint8Array): { parts: PartMapping[]; bpm: number } {
  const parts: PartMapping[] = [];
  for (let i = 0; i < NUM_PARTS; i++) {
    parts.push({ channel: multi[i * 4], keyLow: multi[i * 4 + 1], keyHigh: multi[i * 4 + 2], voices: multi[i * 4 + 3] });
  }
  return { parts, bpm: multi[24] };
}

/** MIDI channel (0-based) a part transmits/receives NRPN on; omni → channel 1. */
export function txChannel(mapping: PartMapping): number {
  return mapping.channel === 0 ? 0 : mapping.channel - 1;
}

/** True if a part with this mapping receives messages on 0-based `channel`. */
export function receivesOn(mapping: PartMapping, channel: number): boolean {
  return mapping.channel === 0 || mapping.channel === channel + 1;
}
