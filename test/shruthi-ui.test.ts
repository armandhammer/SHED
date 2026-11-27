// The Shruthi panel's parameter adapter and the synth choice (no DOM needed).

import { describe, expect, it } from 'vitest';
import { FILTER_BOARDS, SHRUTHI_PARAMS, shruthiParam } from '../src/model/params/shruthi';
import { formatValue } from '../src/model/params/types';
import { ShruthiEngine } from '../src/sync/shruthi-engine';
import { chosenDevice } from '../src/ui/device';
import { CURVE_PRESET_VALUES, ShruthiControls, boardParams, lcdText, sdef } from '../src/ui/shruthi-defs';
import { FakeClock } from './fake-clock';

describe('Shruthi panel definitions', () => {
  it('places the 12 mod rows and 2 operators at their RAM addresses', () => {
    for (let r = 1; r <= 12; r++) {
      expect(sdef(`mod${r}.source`).address).toBe(32 + (r - 1) * 3);
      expect(sdef(`mod${r}.destination`).address).toBe(33 + (r - 1) * 3);
      expect(sdef(`mod${r}.amount`)).toMatchObject({ address: 34 + (r - 1) * 3, unit: 'int', min: -63, max: 63 });
    }
    expect([sdef('op1.in1'), sdef('op1.in2'), sdef('op1.out'), sdef('op2.in1'), sdef('op2.in2'), sdef('op2.out')].map((d) => d.address)).toEqual([94, 95, 96, 97, 98, 99]);
    expect(() => sdef('mod13.source')).toThrow();
    expect(() => sdef('op3.in1')).toThrow();
  });

  it('spells out the LCD custom characters', () => {
    expect(lcdText('\u0003\u0004')).toBe('↑↓');
    expect(lcdText('env1~vcf')).toBe('env1→vcf');
    expect(formatValue(sdef('arp.direction'), 0)).toBe('↑');
    expect(formatValue(sdef('lfo1.shape'), 5)).toBe('≈1');
    expect(formatValue(sdef('lfo1.rate'), 0)).toBe('x1');
    expect(formatValue(sdef('lfo1.rate'), 16)).toBe('0');
    expect(formatValue(sdef('sys.midiChannel'), 0)).toBe('omni');
    expect(formatValue(sdef('env1.curve'), 4)).toBe('4 lin');
    expect(formatValue(sdef('osc2.range'), -12)).toBe('-12');
  });

  it('gives every board page its own controls and none to the plain LPF', () => {
    expect(boardParams('lpf')).toEqual([]);
    expect(boardParams('svf').map((d) => d.id)).toEqual(['svf.cutoff2', 'svf.resonance2', 'svf.mode1', 'svf.mode2']);
    expect(boardParams('pvk').map((d) => d.id)).toEqual(['pvk.mode', 'pvk.overdrive', 'pvk.fm']);
    expect(boardParams('ssm').map((d) => d.id)).toEqual(['ssm.hpf']);
    for (const b of FILTER_BOARDS) for (const d of boardParams(b)) expect([84, 85, 92, 93]).toContain(d.address);
  });

  it('marks the SHOOZ-only parameters', () => {
    const shooz = SHRUTHI_PARAMS.filter((p) => !p.id.includes('#') && sdef(p.id).since === 'shooz').map((p) => p.id);
    expect(shooz).toEqual([
      'sys.vintage',
      'env1.curve',
      'env2.curve',
      'sys.filterProfile',
      'sys.filterCutoffOffset',
      'sys.filterResonanceMax',
    ]);
    expect(CURVE_PRESET_VALUES).toHaveLength(sdef('env1.curve').max + 1);
  });

  it('drives the engine through the controls interface, signed and clamped', () => {
    const out: Uint8Array[] = [];
    const engine = new ShruthiEngine({ send: (b) => (out.push(b), true) }, new FakeClock());
    const c = new ShruthiControls(engine);
    c.set(0, sdef('mod3.amount'), -70);
    expect(c.value(0, sdef('mod3.amount'))).toBe(-63);
    expect(engine.mem[40]).toBe(-63 & 0xff);
    c.set(0, sdef('osc1.shape'), 999);
    expect(engine.value(shruthiParam('osc1.shape'))).toBe(shruthiParam('osc1.shape').max);
    expect(c.supports(sdef('env1.curve'))).toBe(true); // unknown firmware
    engine.client.mode = 'stock';
    expect(c.supports(sdef('env1.curve'))).toBe(false);
    expect(c.supports(sdef('filter.cutoff'))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('synth choice', () => {
  it('follows ?virtual, then ?device, then the stored choice', () => {
    expect(chosenDevice('', null)).toBe('ambika');
    expect(chosenDevice('', 'shruthi')).toBe('shruthi');
    expect(chosenDevice('?device=ambika', 'shruthi')).toBe('ambika');
    expect(chosenDevice('?device=shruthi', null)).toBe('shruthi');
    expect(chosenDevice('?virtual=shooz', 'ambika')).toBe('shruthi');
    expect(chosenDevice('?virtual=shruthi&device=ambika', null)).toBe('shruthi');
    expect(chosenDevice('?virtual=bambi', 'shruthi')).toBe('ambika');
  });
});
