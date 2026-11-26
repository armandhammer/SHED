// Shruthi-1 (YAM / SHOOZ) parameter map.
//
// The table itself is exported from the SHOOZ firmware
// (`test/native/tools/export_params.cc`, run with
// `make -f test/native/makefile export`) into `shooz-params.json`: the
// firmware's own PROGMEM parameter structs, the LCD text for every value,
// and the init patch. This module adds stable ids, groups and filter-board
// visibility on top.
//
// Addressing (`shruthi/part.h`, `parameter.h`):
//   - every parameter is a byte offset into the RAM image patch (0–99),
//     sequencer settings (100–141), system settings (142–156) and the SHOOZ
//     envelope curves (157–158); NRPN number = offset (MSB 1 = +128);
//   - the 92-byte wire patch is the RAM image's first 92 bytes, with the
//     filter modes (92–93) packed into byte 86 and the two operators (94–99)
//     into bytes 87–90 (`Patch::PrepareForWrite`);
//   - several parameters share an offset: the per-filter-board pages reuse
//     cutoff 2 / resonance 2 / the filter modes, and the mod-matrix and
//     operator "row" selectors are UI-only. NRPN reception uses the one
//     `ParameterManager::at_offset` returns (`nrpnOwner`).

import table from './shooz-params.json';
import type { ParamUnit } from './types';

export const SHRUTHI_PATCH_SIZE = table.sizes.patch; // 92 on the wire
export const SHRUTHI_PATCH_RAM_SIZE = table.sizes.patch_ram; // 100 in RAM
export const SHRUTHI_SEQUENCER_SIZE = table.sizes.sequencer; // 42 in RAM
export const SHRUTHI_SEQUENCE_DUMP_SIZE = table.sizes.sequence_dump; // 32: the steps
export const SHRUTHI_SYSTEM_SIZE = table.sizes.system; // 15
export const SHRUTHI_NAME_OFFSET = 68;
export const SHRUTHI_NAME_LENGTH = 8;
export const SHRUTHI_MOD_ROWS = 12;

/** Base offsets of the parameter address space. */
export const SHRUTHI_OFFSET = {
  sequencer: table.offsets.seq,
  system: table.offsets.sys,
  envCurve1: table.offsets.env_curve_1,
  envCurve2: table.offsets.env_curve_2,
  vintage: table.offsets.sys_vintage,
  /** System settings from here on are never echoed by OnEdit. */
  masterTuning: table.offsets.sys + 4,
} as const;

/** Total size of the parameter address space (offsets 0–158). */
export const SHRUTHI_ADDRESS_SPACE = SHRUTHI_OFFSET.envCurve2 + 1;

export const SHRUTHI_FIRMWARE = table.firmware;

export const FILTER_BOARDS = ['lpf', 'ssm', 'svf', 'dsp', 'pvk', '4pm', 'dly', 'sp'] as const;
export type FilterBoard = (typeof FILTER_BOARDS)[number];

/** Display names for `sys.filterBoard` (UNIT_FILTER_BOARD). */
export const FILTER_BOARD_NAMES: Record<FilterBoard, string> = {
  lpf: 'Standard (SMR4 / no expansion)',
  ssm: 'SSM2044 + HPF',
  svf: 'SVF (dual multimode)',
  dsp: 'Digital FX',
  pvk: 'Polivoks',
  '4pm': '4PM (4-pole mission)',
  dly: 'Delay',
  sp: 'Steiner-Parker',
};

export type ShruthiSection = 'patch' | 'sequencer' | 'system' | 'curve';

export interface ShruthiParam {
  /** Index in the firmware parameter table (0–93). */
  readonly index: number;
  /** Byte offset = NRPN number. */
  readonly address: number;
  readonly id: string;
  readonly name: string;
  readonly short: string;
  readonly group: string;
  readonly section: ShruthiSection;
  readonly unit: ParamUnit;
  /** Firmware unit name (UNIT_*), lower case. */
  readonly firmwareUnit: string;
  readonly min: number;
  readonly max: number;
  /** LCD text for each value from min to max. */
  readonly labels: readonly string[];
  readonly cc?: number;
  readonly cc2?: number;
  /** Receives NRPN for its offset (see header). */
  readonly nrpnOwner: boolean;
  /** Shown only with these filter boards (undefined: all). */
  readonly boards?: readonly FilterBoard[];
  /** Only meaningful on SHOOZ (a harmless no-op on stock YAM). */
  readonly since?: 'shooz';
  /** UI-only selector; not a stored value. */
  readonly uiOnly?: boolean;
}

// Per-index ids, groups and board visibility. The order is the firmware
// table's (`shruthi/parameter.cc`).
type Extra = [id: string, group: string, boards?: FilterBoard[]];
const EXTRA: Extra[] = [
  ['osc1.shape', 'Oscillator 1'],
  ['osc1.param', 'Oscillator 1'],
  ['osc1.range', 'Oscillator 1'],
  ['mix.subShape', 'Mixer'],
  ['osc2.shape', 'Oscillator 2'],
  ['osc2.param', 'Oscillator 2'],
  ['osc2.range', 'Oscillator 2'],
  ['osc2.detune', 'Oscillator 2'],
  ['mix.operator', 'Mixer'],
  ['mix.balance', 'Mixer'],
  ['mix.sub', 'Mixer'],
  ['mix.noise', 'Mixer'],
  ['filter.cutoff', 'Filter'],
  ['filter.resonance', 'Filter'],
  ['filter.env1', 'Filter'],
  ['filter.lfo2', 'Filter'],
  ['env1.attack', 'Envelope 1'],
  ['env1.decay', 'Envelope 1'],
  ['env1.sustain', 'Envelope 1'],
  ['env1.release', 'Envelope 1'],
  ['env2.attack', 'Envelope 2'],
  ['env2.decay', 'Envelope 2'],
  ['env2.sustain', 'Envelope 2'],
  ['env2.release', 'Envelope 2'],
  ['lfo1.shape', 'LFO 1'],
  ['lfo1.rate', 'LFO 1'],
  ['lfo1.attack', 'LFO 1'],
  ['lfo1.mode', 'LFO 1'],
  ['lfo2.shape', 'LFO 2'],
  ['lfo2.rate', 'LFO 2'],
  ['lfo2.attack', 'LFO 2'],
  ['lfo2.mode', 'LFO 2'],
  ['mod.row', 'Modulation'],
  ['mod.source', 'Modulation'],
  ['mod.destination', 'Modulation'],
  ['mod.amount', 'Modulation'],
  ['seq.mode', 'Sequencer'],
  ['seq.tempo', 'Sequencer'],
  ['seq.groove', 'Sequencer'],
  ['seq.grooveAmount', 'Sequencer'],
  ['arp.direction', 'Arpeggiator'],
  ['arp.range', 'Arpeggiator'],
  ['arp.pattern', 'Arpeggiator'],
  ['arp.division', 'Arpeggiator'],
  ['sys.octave', 'Keyboard'],
  ['sys.raga', 'Keyboard'],
  ['sys.portamento', 'Keyboard'],
  ['sys.legato', 'Keyboard'],
  ['sys.tuning', 'MIDI'],
  ['sys.midiChannel', 'MIDI'],
  ['sys.midiOut', 'MIDI'],
  ['sys.vintage', 'MIDI'],
  ['sys.displayPause', 'System'],
  ['sys.snap', 'System'],
  ['sys.filterBoard', 'System'],
  ['sys.startPage', 'System'],
  ['seq.start', 'Sequencer'],
  ['seq.length', 'Sequencer'],
  ['op.row', 'Operators'],
  ['op.in1', 'Operators'],
  ['op.in2', 'Operators'],
  ['op.out', 'Operators'],
  // The "filters" page: 4 entries per expansion board, from index 62
  // (`Editor::ConfigureFilterMenu`). Entries marked # repeat a main filter
  // parameter (same offset) and are hidden.
  ['ssm.cutoff#', 'Filter', ['ssm']],
  ['ssm.resonance#', 'Filter', ['ssm']],
  ['ssm.env1#', 'Filter', ['ssm']],
  ['ssm.hpf', 'SSM', ['ssm']],
  ['svf.cutoff2', 'SVF', ['svf']],
  ['svf.resonance2', 'SVF', ['svf']],
  ['svf.mode1', 'SVF', ['svf']],
  ['svf.mode2', 'SVF', ['svf']],
  ['dsp.mode', 'Digital FX', ['dsp']],
  ['dsp.program', 'Digital FX', ['dsp']],
  ['dsp.param1', 'Digital FX', ['dsp']],
  ['dsp.param2', 'Digital FX', ['dsp']],
  ['pvk.cutoff#', 'Filter', ['pvk']],
  ['pvk.mode', 'Polivoks', ['pvk']],
  ['pvk.overdrive', 'Polivoks', ['pvk']],
  ['pvk.fm', 'Polivoks', ['pvk']],
  ['4pm.cutoff#', 'Filter', ['4pm']],
  ['4pm.resonance#', 'Filter', ['4pm']],
  ['4pm.mode', '4PM', ['4pm']],
  ['4pm.flavour', '4PM', ['4pm']],
  ['dly.time', 'Delay', ['dly']],
  ['dly.level', 'Delay', ['dly']],
  ['dly.feedback', 'Delay', ['dly']],
  ['dly.eq', 'Delay', ['dly']],
  ['sp.cutoff#', 'Filter', ['sp']],
  ['sp.resonance#', 'Filter', ['sp']],
  ['sp.mode', 'Steiner-Parker', ['sp']],
  ['sp.feedback', 'Steiner-Parker', ['sp']],
  ['env1.curve', 'Envelope curves'],
  ['env2.curve', 'Envelope curves'],
  ['env2.curve#2', 'Envelope curves'],
  ['env2.curve#3', 'Envelope curves'],
];

const UNIT_MAP: Record<string, ParamUnit> = {
  raw_uint8: 'raw',
  uint8: 'uint',
  int8: 'int',
  boolean: 'bool',
  index: 'index',
  lfo_rate: 'lfoRate',
};

function sectionOf(address: number): ShruthiSection {
  if (address >= SHRUTHI_OFFSET.envCurve1) return 'curve';
  if (address >= SHRUTHI_OFFSET.system) return 'system';
  if (address >= SHRUTHI_OFFSET.sequencer) return 'sequencer';
  return 'patch';
}

export const SHRUTHI_PARAMS: readonly ShruthiParam[] = table.parameters.map((p) => {
  const [id, group, boards] = EXTRA[p.index];
  const section = sectionOf(p.offset);
  return {
    index: p.index,
    address: p.offset,
    id,
    name: p.long,
    short: p.short,
    group,
    section,
    unit: UNIT_MAP[p.unit] ?? 'enum',
    firmwareUnit: p.unit,
    min: p.min,
    max: p.max,
    labels: p.labels,
    ...(p.cc[0] ? { cc: p.cc[0] } : {}),
    ...(p.cc[1] ? { cc2: p.cc[1] } : {}),
    nrpnOwner: p.nrpn_owner === 1,
    ...(boards ? { boards } : {}),
    ...(section === 'curve' || p.offset === SHRUTHI_OFFSET.vintage ? { since: 'shooz' as const } : {}),
    ...(id === 'mod.row' || id === 'op.row' ? { uiOnly: true } : {}),
  };
});

const byId = new Map(SHRUTHI_PARAMS.map((p) => [p.id, p]));

export function shruthiParam(id: string): ShruthiParam {
  const p = byId.get(id);
  if (!p) throw new Error(`unknown Shruthi parameter ${id}`);
  return p;
}

/**
 * The parameter that receives NRPN for `address`, with the mod-matrix and
 * operator rows mapped onto row 1's definitions (`ParameterManager::Init`).
 */
export function nrpnParam(address: number): ShruthiParam | undefined {
  return nrpnTable[address];
}

const nrpnTable: (ShruthiParam | undefined)[] = (() => {
  const t: (ShruthiParam | undefined)[] = new Array(160).fill(undefined);
  for (const p of SHRUTHI_PARAMS) if (p.address < 160) t[p.address] = p;
  // The firmware's own fix-ups, in its order.
  t[92] = SHRUTHI_PARAMS[84];
  t[93] = SHRUTHI_PARAMS[85];
  for (let row = 0; row < SHRUTHI_MOD_ROWS; row++) {
    t[32 + row * 3] = SHRUTHI_PARAMS[33];
    t[33 + row * 3] = SHRUTHI_PARAMS[34];
    t[34 + row * 3] = SHRUTHI_PARAMS[35];
  }
  for (let op = 0; op < 2; op++) {
    t[94 + op * 3] = SHRUTHI_PARAMS[59];
    t[95 + op * 3] = SHRUTHI_PARAMS[60];
    t[96 + op * 3] = SHRUTHI_PARAMS[61];
  }
  return t;
})();

/** Parameter for an incoming CC (`ParameterManager::for_cc`; later entries win). */
export function ccParam(cc: number): ShruthiParam | undefined {
  return ccTable[cc & 0x7f];
}

const ccTable: (ShruthiParam | undefined)[] = (() => {
  const t: (ShruthiParam | undefined)[] = new Array(128).fill(undefined);
  for (const p of SHRUTHI_PARAMS) {
    if (p.cc) t[p.cc] = p;
    if (p.cc2) t[p.cc2] = p;
  }
  return t;
})();

/** Parameters visible for a filter board (patch section, stored values only). */
export function paramsForBoard(board: FilterBoard): ShruthiParam[] {
  const seen = new Set<number>();
  return SHRUTHI_PARAMS.filter((p) => {
    if (p.uiOnly || p.id.includes('#')) return false;
    if (p.boards && !p.boards.includes(board)) return false;
    if (seen.has(p.address) && p.section === 'patch') return false;
    seen.add(p.address);
    return true;
  });
}

/** Wire byte → display value (signed for `int`). */
export function shruthiFromByte(p: ShruthiParam, byte: number): number {
  const b = byte & 0xff;
  return p.unit === 'int' ? (b << 24) >> 24 : b;
}

/** `Parameter::Clamp`: in-range values pass, others go to the nearest end. */
export function shruthiClamp(p: ShruthiParam, byte: number): number {
  const v = shruthiFromByte(p, byte);
  return (v < p.min ? p.min : v > p.max ? p.max : v) & 0xff;
}

/** `Parameter::Scale`: a 7-bit CC value onto the parameter range. */
export function shruthiScale(p: ShruthiParam, value7: number): number {
  if (p.firmwareUnit === 'raw_uint8') return value7 & 0x7f;
  const range = (p.max - p.min + 1) & 0xff;
  let v = (((range * ((value7 << 1) & 0xff)) >> 8) + p.min) & 0xff;
  if (p.firmwareUnit === 'tempo_with_external_clock') {
    if (v >= 239) v = 240;
    v &= 0xfe;
    if (v < 40) v = 39; // SHOOZ fix; stock gives 38
  }
  return v;
}

/** LCD text for a value. */
export function shruthiLabel(p: ShruthiParam, value: number): string {
  return p.labels[value - p.min] ?? String(value);
}

export function shruthiPatchName(patch: Uint8Array): string {
  return String.fromCharCode(...patch.subarray(SHRUTHI_NAME_OFFSET, SHRUTHI_NAME_OFFSET + SHRUTHI_NAME_LENGTH)).trimEnd();
}

/** Factory init patch, as sent on the wire (92 bytes). */
export function shruthiInitPatch(): Uint8Array {
  return Uint8Array.from(table.init_patch);
}

export function shruthiInitSequencer(): Uint8Array {
  return Uint8Array.from(table.init_sequencer);
}

export function shruthiInitSystem(): Uint8Array {
  return Uint8Array.from(table.init_system);
}
