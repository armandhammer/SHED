// Pure math behind the panel controls (knobs, faders, menu windows).
// No DOM, so it can be unit-tested.

import type { ParamDef } from '../model/params/types';

/** Knob sweep in degrees, centred on 12 o'clock. */
export const KNOB_SWEEP = 270;

/** Pixels of pointer travel for a knob's full range (fine mode: ×4). */
export const KNOB_DRAG_PX = 220;

/** Position 0–1 of a value within the parameter's range. */
export function fraction(def: ParamDef, value: number): number {
  const span = def.max - def.min;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - def.min) / span));
}

/** Pointer angle for a knob, −135° (min) … +135° (max). */
export function knobAngle(def: ParamDef, value: number): number {
  return -KNOB_SWEEP / 2 + fraction(def, value) * KNOB_SWEEP;
}

function clampRound(def: ParamDef, v: number): number {
  const r = Math.round(v);
  return r < def.min ? def.min : r > def.max ? def.max : r;
}

/**
 * Value after dragging a knob: `dx` right and `dy` up (screen pixels, up is
 * negative clientY) both increase it. `fine` slows the knob down 4×.
 */
export function knobDragValue(def: ParamDef, start: number, dx: number, dy: number, fine = false): number {
  const px = KNOB_DRAG_PX * (fine ? 4 : 1);
  const delta = ((dx - dy) / px) * (def.max - def.min);
  return clampRound(def, start + delta);
}

/** Value for a fader whose cap centre is at `y` px from the top of a track of `travel` px. */
export function faderValue(def: ParamDef, y: number, travel: number): number {
  if (travel <= 0) return def.min;
  const t = 1 - Math.min(1, Math.max(0, y / travel));
  return clampRound(def, def.min + t * (def.max - def.min));
}

/** Keyboard steps shared by knobs and faders (ARIA slider conventions). */
export function sliderKey(def: ParamDef, value: number, key: string, shift = false): number | null {
  const span = def.max - def.min;
  const big = Math.max(1, Math.round(span / 10));
  const step = shift ? big : 1;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return clampRound(def, value + step);
    case 'ArrowDown':
    case 'ArrowLeft':
      return clampRound(def, value - step);
    case 'PageUp':
      return clampRound(def, value + big);
    case 'PageDown':
      return clampRound(def, value - big);
    case 'Home':
      return def.min;
    case 'End':
      return def.max;
    default:
      return null;
  }
}

/**
 * Next value of a menu window when stepping with ◀ ▶. Wraps around and skips
 * values above `max` (oscillator shapes the voicecards don't have).
 */
export function stepEnum(def: ParamDef, value: number, dir: 1 | -1, max = def.max): number {
  const hi = Math.min(def.max, max);
  if (hi <= def.min) return def.min;
  let v = value + dir;
  if (v > hi) v = def.min;
  if (v < def.min) v = hi;
  return v;
}
