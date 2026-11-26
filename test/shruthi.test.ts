// Shruthi parameter map (exported from the SHOOZ firmware) and patch codec.

import { describe, expect, it } from 'vitest';
import {
  FILTER_BOARDS,
  SHRUTHI_OFFSET,
  SHRUTHI_PARAMS,
  SHRUTHI_PATCH_RAM_SIZE,
  ccParam,
  nrpnParam,
  paramsForBoard,
  shruthiClamp,
  shruthiInitPatch,
  shruthiLabel,
  shruthiParam,
  shruthiPatchName,
  shruthiScale,
} from '../src/model/params/shruthi';
import {
  PATCH_MARKER,
  acceptsPatch,
  packPatch,
  parseShruthiVersion,
  patchCurves,
  unpackPatch,
} from '../src/protocol/shruthi';

describe('Shruthi parameter map', () => {
  it('has the firmware table: 94 parameters, one label per value', () => {
    expect(SHRUTHI_PARAMS).toHaveLength(94);
    for (const p of SHRUTHI_PARAMS) {
      expect(p.labels, p.id).toHaveLength(p.max - p.min + 1);
      expect(p.min, p.id).toBeLessThanOrEqual(p.max);
      expect(p.address, p.id).toBeLessThanOrEqual(SHRUTHI_OFFSET.envCurve2);
    }
    expect(new Set(SHRUTHI_PARAMS.map((p) => p.id)).size).toBe(94);
  });

  it('agrees with the firmware on which parameter owns each NRPN offset', () => {
    for (const p of SHRUTHI_PARAMS) {
      expect(nrpnParam(p.address) === p, `${p.id} @${p.address}`).toBe(p.nrpnOwner);
    }
    // Mod matrix rows 2–12 and operator 2 map onto row 1's definitions.
    expect(nrpnParam(32 + 3 * 11)?.id).toBe('mod.source');
    expect(nrpnParam(34 + 3 * 11)?.id).toBe('mod.amount');
    expect(nrpnParam(97)?.id).toBe('op.in1');
    // The name and extra bytes have none.
    for (let a = 68; a < 84; a++) expect(nrpnParam(a)).toBeUndefined();
    expect(nrpnParam(200)).toBeUndefined();
  });

  it('knows the units and labels the LCD shows', () => {
    const shape = shruthiParam('osc1.shape');
    expect(shruthiLabel(shape, 1)).toBe('saw');
    expect(shape.max).toBe(43);
    const range = shruthiParam('osc2.range');
    expect(range.unit).toBe('int');
    expect([range.min, range.max]).toEqual([-24, 24]);
    expect(shruthiLabel(shruthiParam('seq.tempo'), 39)).toBe('extern');
    expect(shruthiParam('env1.curve').since).toBe('shooz');
    expect(shruthiParam('sys.vintage').since).toBe('shooz');
    expect(shruthiParam('filter.cutoff').cc).toBe(14);
    expect(shruthiParam('filter.cutoff').cc2).toBe(74);
  });

  it('scales CCs like Parameter::Scale', () => {
    const sub = shruthiParam('mix.subShape'); // 0–10
    expect(shruthiScale(sub, 0)).toBe(0);
    expect(shruthiScale(sub, 127)).toBe(10);
    const tempo = shruthiParam('seq.tempo');
    expect(shruthiScale(tempo, 0)).toBe(39); // SHOOZ fix (stock: 38)
    expect(shruthiScale(tempo, 127)).toBe(240);
    expect(shruthiScale(shruthiParam('filter.cutoff'), 99)).toBe(99); // raw
    for (const p of SHRUTHI_PARAMS) {
      for (let v = 0; v < 128; v++) {
        const s = shruthiScale(p, v);
        expect(shruthiClamp(p, s), `${p.id} ${v}`).toBe(s);
      }
    }
  });

  it('maps CCs to parameters, later table entries winning', () => {
    expect(ccParam(14)?.address).toBe(12);
    expect(ccParam(74)?.id).toBe('filter.cutoff');
    expect(ccParam(85)?.id).toBe('svf.mode1');
    expect(ccParam(1)).toBeUndefined(); // mod wheel: a modulation source
  });

  it('shows each filter board its own page', () => {
    const ids = (b: (typeof FILTER_BOARDS)[number]) => paramsForBoard(b).map((p) => p.id);
    expect(ids('lpf')).toContain('filter.cutoff');
    expect(ids('lpf')).not.toContain('svf.mode1');
    expect(ids('svf')).toEqual(expect.arrayContaining(['svf.cutoff2', 'svf.mode1', 'svf.mode2']));
    expect(ids('pvk')).toEqual(expect.arrayContaining(['pvk.mode', 'pvk.overdrive', 'pvk.fm']));
    expect(ids('4pm')).toEqual(expect.arrayContaining(['4pm.mode', '4pm.flavour']));
    expect(ids('sp')).toEqual(expect.arrayContaining(['sp.mode', 'sp.feedback']));
    for (const b of FILTER_BOARDS) {
      const patch = paramsForBoard(b).filter((p) => p.section === 'patch');
      expect(new Set(patch.map((p) => p.address)).size, b).toBe(patch.length);
    }
  });
});

describe('Shruthi patch codec', () => {
  it('round-trips the init patch', () => {
    const wire = shruthiInitPatch();
    expect(wire).toHaveLength(92);
    expect(wire[91]).toBe(PATCH_MARKER.yam);
    expect(shruthiPatchName(wire)).toBe('init');
    const ram = unpackPatch(wire);
    expect(ram).toHaveLength(SHRUTHI_PATCH_RAM_SIZE);
    expect(packPatch(ram, { extra: wire.subarray(76, 84) })).toEqual(wire);
  });

  it('packs filter modes and operators like Patch::PrepareForWrite', () => {
    const ram = unpackPatch(shruthiInitPatch());
    for (let trial = 0; trial < 200; trial++) {
      ram[92] = trial % 6;
      ram[93] = (trial * 7) % 16;
      for (let k = 0; k < 2; k++) {
        ram[94 + 3 * k] = (trial * 13 + k) % 32; // in1: modulation source
        ram[95 + 3 * k] = (trial * 5 + k) % 32;
        ram[96 + 3 * k] = (trial + k) % 10; // cv operator
      }
      const back = unpackPatch(packPatch(ram));
      expect(back.subarray(0, 86)).toEqual(ram.subarray(0, 86));
      expect(back.subarray(92)).toEqual(ram.subarray(92));
    }
  });

  it("marks curve patches '&' and keeps the sequencer mode bits", () => {
    const ram = unpackPatch(shruthiInitPatch());
    const extra = [0, 2, 120, 0, 0, 0x01, 0, 4];
    const wire = packPatch(ram, { extra, curves: [3, 6] });
    expect(wire[91]).toBe(PATCH_MARKER.shooz);
    expect(patchCurves(wire)).toEqual([3, 6]);
    expect(wire[77] & 3).toBe(2);
    expect(acceptsPatch(wire, 'shooz')).toBe(true);
    expect(acceptsPatch(wire, 'stock')).toBe(false);
    const plain = packPatch(ram, { extra });
    expect(plain[91]).toBe(PATCH_MARKER.yam);
    expect(patchCurves(plain)).toEqual([0, 0]);
    // A '%' patch with junk in the spare bits carries no curves.
    plain[77] |= 0xfc;
    expect(patchCurves(plain)).toEqual([0, 0]);
  });

  it('parses both version replies', () => {
    expect(parseShruthiVersion(Uint8Array.of(1, 0))).toEqual({ rom: [1, 0] });
    const v = parseShruthiVersion(Uint8Array.of(1, 0, 2, 0x01, 44, 1, 180, 3));
    expect(v.shooz).toMatchObject({ version: 1, waveforms: 44, freeStack: 180, glitches: 3 });
    expect(() => parseShruthiVersion(Uint8Array.of(1))).toThrow();
  });
});
