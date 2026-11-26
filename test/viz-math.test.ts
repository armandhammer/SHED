import { describe, expect, it } from 'vitest';
import { cutoffHz, envelopeLayout, envelopeShape, resonanceQ, svfMagnitudeDb } from '../src/ui/viz-math';

describe('filter response math', () => {
  it('spans roughly 20 Hz to 20 kHz', () => {
    expect(cutoffHz(0)).toBeCloseTo(20);
    expect(cutoffHz(127)).toBeCloseTo(20000);
  });

  it('has the textbook SVF shapes', () => {
    const fc = 1000;
    const q = resonanceQ(0);
    expect(svfMagnitudeDb(0, 10, fc, q)).toBeCloseTo(0, 1); // LP passes lows
    expect(svfMagnitudeDb(0, 10000, fc, q)).toBeLessThan(-35); // 12 dB/oct above
    expect(svfMagnitudeDb(2, 10, fc, q)).toBeLessThan(-70); // HP blocks lows
    expect(svfMagnitudeDb(2, 100000, fc, q)).toBeCloseTo(0, 1);
    expect(svfMagnitudeDb(1, fc, fc, q)).toBeCloseTo(0, 5); // BP unity at fc
    expect(svfMagnitudeDb(3, fc, fc, q)).toBeLessThan(-100); // notch
    // Resonance raises the LP peak at fc to Q.
    const qHigh = resonanceQ(63);
    expect(svfMagnitudeDb(0, fc, fc, qHigh)).toBeCloseTo(20 * Math.log10(qHigh), 5);
  });
});

describe('envelope curve math', () => {
  it('maps 0 / 64 / 127 to exponential, ~linear and inverse shapes', () => {
    expect(envelopeShape(0, 0)).toBe(0);
    expect(envelopeShape(1, 127)).toBe(1);
    expect(envelopeShape(0.5, 0)).toBeGreaterThan(0.8); // fast start
    expect(envelopeShape(0.5, 64)).toBeCloseTo(0.5, 1);
    expect(envelopeShape(0.5, 127)).toBeLessThan(0.2); // slow start
  });

  it('lays out the ADSR left to right with sustain level on the y axis', () => {
    const { points } = envelopeLayout(0, 127, 127, 64, 300, 100);
    const xs = points.map((p) => p.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(points[2].y).toBeCloseTo(points[1].y); // full sustain = peak
  });
});
