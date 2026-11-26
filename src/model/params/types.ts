// Parameter definitions shared by the device maps.

export type ParamUnit =
  | 'raw' // 0–127 continuous (UNIT_RAW_UINT8)
  | 'uint' // unsigned integer (UNIT_UINT8)
  | 'int' // signed integer, two's complement on the wire (UNIT_INT8)
  | 'index' // displayed 1-based (UNIT_INDEX)
  | 'bool'
  | 'enum' // value - min indexes `labels`
  | 'lfoRate' // 0–14 tempo-synced divisions, then free-running 0–127
  | 'none'; // not user-editable (sequencer bytes)

export type ParamLevel = 'patch' | 'part';

export interface ParamDef {
  /** NRPN number = byte offset into Patch (0–111) followed by PartData (112–195). */
  readonly address: number;
  /** Stable identifier, e.g. `osc1.shape`, `env2.attack`, `mod5.amount`. */
  readonly id: string;
  readonly name: string;
  /** Firmware short label (≤ 5 chars), shown as a hint. */
  readonly short: string;
  readonly group: string;
  readonly level: ParamLevel;
  readonly unit: ParamUnit;
  /** Range in the display domain (signed for `int`). */
  readonly min: number;
  readonly max: number;
  readonly labels?: readonly string[];
  /** MIDI CC (scaled 0–127 → range on the synth, lossy for small ranges). */
  readonly cc?: number;
  /** Instance index for repeated objects (envelopes, LFOs, mod slots). */
  readonly instance?: number;
  /** Present only in BAMBI (YAM+) / SHOOZ; a harmless no-op on stock YAM. */
  readonly since?: 'yamplus' | 'shooz';
  /** Default value used by the init patch. */
  readonly init?: number;
}

export function isSigned(def: ParamDef): boolean {
  return def.unit === 'int';
}

/** Wire byte (0–255) → display value. */
export function fromByte(def: ParamDef, byte: number): number {
  const b = byte & 0xff;
  return isSigned(def) ? (b << 24) >> 24 : b;
}

/** Display value → wire byte (0–255). Clamps first. */
export function toByte(def: ParamDef, value: number): number {
  return clamp(def, value) & 0xff;
}

export function clamp(def: ParamDef, value: number): number {
  const v = Math.round(value);
  return v < def.min ? def.min : v > def.max ? def.max : v;
}

/** Human-readable value. */
export function formatValue(def: ParamDef, value: number): string {
  switch (def.unit) {
    case 'enum':
      return def.labels?.[value - def.min] ?? String(value);
    case 'bool':
      return value ? 'on' : 'off';
    case 'index':
      return String(value + 1);
    case 'int':
      return value > 0 ? `+${value}` : String(value);
    case 'lfoRate':
      return value < LFO_SYNCED_RATES.length ? LFO_SYNCED_RATES[value] : String(value - LFO_SYNCED_RATES.length);
    default:
      return def.labels?.[value - def.min] ?? String(value);
  }
}

/** Tempo-synced LFO divisions (`kNumSyncedLfoRates` = 15). */
export const LFO_SYNCED_RATES = [
  '1/1', '3/4', '2/3', '1/2', '3/8', '1/3', '1/4', '1/6',
  '1/8', '1/12', '1/16', '1/24', '1/32', '1/48', '1/96',
] as const;
