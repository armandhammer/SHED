// Pure math behind the filter and envelope visuals (unit-testable, no DOM).

export type SvfMode = 0 | 1 | 2 | 3; // LP, BP, HP, Notch

/**
 * Approximate cutoff frequency of the Ambika SVF card for a cutoff value
 * 0–127: exponential, ~20 Hz to ~20 kHz. Illustrative, not calibrated.
 */
export function cutoffHz(cutoff: number): number {
  return 20 * Math.pow(2, (cutoff / 127) * Math.log2(1000));
}

/** Resonance 0–63 → Q, from 0.5 (no peak) to ~20 (near self-oscillation). */
export function resonanceQ(resonance: number): number {
  return 0.5 * Math.pow(40, resonance / 63);
}

/** Magnitude in dB of a 2-pole state-variable filter output at `f` Hz. */
export function svfMagnitudeDb(mode: SvfMode, f: number, fc: number, q: number): number {
  const w = f / fc;
  // Denominator: (1 - w²) + j·w/Q
  const re = 1 - w * w;
  const im = w / q;
  const den = Math.hypot(re, im);
  let num: number;
  switch (mode) {
    case 0:
      num = 1;
      break;
    case 1:
      num = w / q;
      break;
    case 2:
      num = w * w;
      break;
    default:
      num = Math.abs(1 - w * w);
      break;
  }
  const mag = num / den;
  return 20 * Math.log10(Math.max(mag, 1e-6));
}

/**
 * Envelope segment shape for YAM+ curves: fraction of the segment's travel
 * reached at time fraction x ∈ [0, 1].
 *   curve 0   exponential (YAM): fast start
 *   curve 64  linear
 *   curve 127 inverse exponential: slow start
 */
export function envelopeShape(x: number, curve: number): number {
  const fast = 1 - Math.pow(1 - x, 3);
  const slow = Math.pow(x, 3);
  const c = Math.min(127, Math.max(0, curve)) / 127;
  if (c <= 0.5) {
    const t = c / 0.5;
    return fast + (x - fast) * t;
  }
  const t = (c - 0.5) / 0.5;
  return x + (slow - x) * t;
}

export interface EnvelopeLayout {
  points: { x: number; y: number }[]; // start, attack peak, decay end, sustain end, release end
}

/** Screen layout of an ADSR in a w × h box (shared by drawing and hit-testing). */
export function envelopeLayout(
  a: number,
  d: number,
  s: number,
  r: number,
  w: number,
  h: number,
  pad = 6,
): EnvelopeLayout {
  const seg = (w - 2 * pad) * 0.26;
  const hold = (w - 2 * pad) * 0.22 - 0.0001;
  const top = pad;
  const bottom = h - pad;
  const sy = bottom - (s / 127) * (bottom - top);
  const x0 = pad;
  const x1 = x0 + 2 + (a / 127) * seg;
  const x2 = x1 + 2 + (d / 127) * seg;
  const x3 = x2 + hold;
  const x4 = x3 + 2 + (r / 127) * seg;
  return {
    points: [
      { x: x0, y: bottom },
      { x: x1, y: top },
      { x: x2, y: sy },
      { x: x3, y: sy },
      { x: x4, y: bottom },
    ],
  };
}
