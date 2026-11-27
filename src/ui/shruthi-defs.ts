// The Shruthi parameter map seen through the panel controls' ParamDef, and
// the ShruthiEngine seen through ControlEngine. Kept free of DOM code so it
// can be unit-tested.

import {
  FILTER_PROFILES,
  FILTER_PROFILE_NAMES,
  SHRUTHI_MOD_ROWS,
  SHRUTHI_PARAMS,
  shruthiParam,
  type FilterBoard,
  type ShruthiParam,
} from '../model/params/shruthi';
import { fromByte, type ParamDef, type ParamUnit } from '../model/params/types';
import type { ShruthiEngine } from '../sync/shruthi-engine';
import type { ControlEngine } from './controls';

/** LCD text with the Shruthi's custom characters spelled out. */
export function lcdText(s: string): string {
  return s
    .replace(/\u0003/g, '↑')
    .replace(/\u0004/g, '↓')
    .replace(/\u0005/g, '≈')
    .replace(/~/g, '→')
    .trim();
}

const UNIT: Partial<Record<ParamUnit, ParamUnit>> = {
  lfoRate: 'uint', // the LCD labels already read x1…x16, 0…127
  index: 'enum',
};

/** Friendlier names than the LCD's for a few values. */
const LABELS: Record<string, string[]> = {
  'sys.midiChannel': ['omni', ...Array.from({ length: 16 }, (_, i) => String(i + 1))],
  'env1.curve': ['0 exp', '1', '2', '3', '4 lin', '5', '6', '7 inv'],
  'env2.curve': ['0 exp', '1', '2', '3', '4 lin', '5', '6', '7 inv'],
  'sys.filterProfile': FILTER_PROFILES.map((p) => FILTER_PROFILE_NAMES[p]),
};

/** A Shruthi parameter as a ParamDef, optionally moved to another address (mod rows, operators). */
export function shruthiDef(p: ShruthiParam, address = p.address, id = p.id): ParamDef {
  return {
    address,
    id,
    name: lcdText(p.name),
    short: lcdText(p.short),
    group: p.group,
    level: 'patch',
    unit: UNIT[p.unit] ?? p.unit,
    min: p.min,
    max: p.max,
    labels: LABELS[p.id] ?? p.labels.map(lcdText),
    ...(p.cc ? { cc: p.cc } : {}),
    ...(p.since ? { since: p.since } : {}),
  };
}

const cache = new Map<string, ParamDef>();

/** ParamDef for a parameter id (`filter.cutoff`), `mod{1–12}.{source,destination,amount}` or `op{1,2}.{in1,in2,out}`. */
export function sdef(id: string): ParamDef {
  let d = cache.get(id);
  if (d) return d;
  const mod = /^mod(\d+)\.(source|destination|amount)$/.exec(id);
  const op = /^op(\d)\.(in1|in2|out)$/.exec(id);
  if (mod) {
    const row = Number(mod[1]) - 1;
    if (row < 0 || row >= SHRUTHI_MOD_ROWS) throw new Error(`no mod row ${id}`);
    const field = ['source', 'destination', 'amount'].indexOf(mod[2]);
    d = shruthiDef(shruthiParam(`mod.${mod[2]}`), 32 + row * 3 + field, id);
  } else if (op) {
    const k = Number(op[1]) - 1;
    if (k < 0 || k > 1) throw new Error(`no operator ${id}`);
    const field = ['in1', 'in2', 'out'].indexOf(op[2]);
    d = shruthiDef(shruthiParam(`op.${op[2]}`), 94 + k * 3 + field, id);
  } else {
    d = shruthiDef(shruthiParam(id));
  }
  cache.set(id, d);
  return d;
}

/** Parameters of the per-board page (the ones that aren't main filter repeats). */
export function boardParams(board: FilterBoard): ParamDef[] {
  return SHRUTHI_PARAMS.filter((p) => p.boards?.includes(board) && !p.id.includes('#')).map((p) => sdef(p.id));
}

/** Envelope curve preset (0–7) on BAMBI's continuous curve scale (`docs/PLAN.md` M5). */
export const CURVE_PRESET_VALUES = [0, 16, 32, 48, 64, 85, 106, 127] as const;

/** ControlEngine over a ShruthiEngine (single part: the part index is ignored). */
export class ShruthiControls implements ControlEngine {
  readonly oscShapeMax = 0; // the Ambika shape list isn't used here

  constructor(readonly engine: ShruthiEngine) {}

  value(_part: number, def: ParamDef): number {
    return fromByte(def, this.engine.byte(def.address));
  }

  set(_part: number, def: ParamDef, value: number): void {
    const v = Math.min(def.max, Math.max(def.min, Math.round(value)));
    this.engine.setByte(def.address, v & 0xff);
  }

  supports(def: ParamDef): boolean {
    return !def.since || this.engine.mode !== 'stock';
  }

  beginDrag(_part: number, address: number): void {
    this.engine.beginDrag(address);
  }

  endDrag(_part: number, address: number): void {
    this.engine.endDrag(address);
  }
}
