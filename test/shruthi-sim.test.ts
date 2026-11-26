// End-to-end: ShruthiClient and raw MIDI against the simulated Shruthi, over
// a serial link that delivers bytes in order at 31.25 kbaud. The synth
// answers requests after its 100 ms Delay(), like the firmware.

import { describe, expect, it } from 'vitest';
import { DEVICE_SHRUTHI, encodeSysEx } from '../src/midi/framer';
import { encodeNrpn } from '../src/midi/nrpn';
import { wireTimeMs } from '../src/midi/scheduler';
import { SHRUTHI_OFFSET, shruthiInitPatch, shruthiParam } from '../src/model/params/shruthi';
import { PATCH_MARKER, SHRUTHI_CMD, packPatch, shruthiRequest, unpackPatch } from '../src/protocol/shruthi';
import { SHRUTHI_REQUEST_DELAY_MS, ShruthiClient, ShruthiTimeout } from '../src/protocol/shruthi-client';
import { SHRUTHI_OUT_MODE, VirtualShruthi } from '../src/sim/virtual-shruthi';
import { splitMessages } from '../src/sync/echo';
import { FakeClock } from './fake-clock';

function rig(opts: { firmware: 'stock' | 'shooz'; outMode?: number; banks?: number; connected?: boolean }) {
  const clock = new FakeClock();
  const line = () => {
    let busyUntil = 0;
    return (msg: Uint8Array, deliver: (m: Uint8Array) => void, extraDelay = 0) => {
      const at = Math.max(clock.now() + extraDelay, busyUntil) + wireTimeMs(msg.length);
      busyUntil = at;
      clock.setTimer(() => deliver(msg), at - clock.now());
    };
  };
  const toSynth = line();
  const toShed = line();
  const fromSynth: Uint8Array[] = [];
  let synth!: VirtualShruthi;
  const connected = opts.connected ?? true;
  const client = new ShruthiClient(
    {
      send: (bytes) => {
        if (!connected) return;
        for (const m of splitMessages(bytes)) toSynth(m.slice(), (x) => synth.receive(x));
      },
    },
    clock,
  );
  const sendRaw = (bytes: Uint8Array) => {
    for (const m of splitMessages(bytes)) toSynth(m.slice(), (x) => synth.receive(x));
  };
  synth = new VirtualShruthi({
    ...opts,
    send: (m) => {
      // Replies (SysEx other than echoes) leave after the firmware's Delay(100).
      const isReply = m[0] === 0xf0 && m[6] !== undefined && (m[6] & 0xf0) !== 0x10;
      toShed(
        m,
        (x) => {
          fromSynth.push(x);
          if (x[0] === 0xf0) client.handleSysEx(x);
        },
        isReply ? SHRUTHI_REQUEST_DELAY_MS : 0,
      );
    },
  });
  const settle = async <T>(p: Promise<T>, ms = 5000): Promise<T> => {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    p.then(
      (v) => ((done = true), (value = v)),
      (e) => ((done = true), (error = e)),
    );
    for (let t = 0; t < ms && !done; t += 5) {
      clock.advance(5);
      await Promise.resolve();
      await Promise.resolve();
    }
    if (!done) throw new Error('promise did not settle');
    if (error) throw error;
    return value as T;
  };
  const flush = (ms = 300) => clock.advance(ms);
  return { clock, client, synth, settle, sendRaw, flush, fromSynth };
}

describe('virtual Shruthi: detection and dumps', () => {
  it('detects SHOOZ from its capability bytes', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    expect(await r.settle(r.client.detect())).toBe('shooz');
    expect(r.client.firmware?.shooz).toMatchObject({ waveforms: 44, patchLayout: 1 });
  });

  it('detects stock YAM from the 2-byte reply', async () => {
    const r = rig({ firmware: 'stock', outMode: SHRUTHI_OUT_MODE.off });
    expect(await r.settle(r.client.detect())).toBe('stock');
    expect(r.client.firmware).toEqual({ rom: [1, 0] });
  });

  it('times out to "absent" when nothing answers, then keeps working', async () => {
    const r = rig({ firmware: 'shooz', connected: false });
    const t0 = r.clock.now();
    expect(await r.settle(r.client.detect())).toBe('absent');
    const waited = r.clock.now() - t0;
    expect(waited).toBeGreaterThan(SHRUTHI_REQUEST_DELAY_MS);
    expect(waited).toBeLessThan(1000);
    await expect(r.settle(r.client.fetchPatch())).rejects.toBeInstanceOf(ShruthiTimeout);
    expect(r.client.busy).toBe(false);
  });

  it('ignores its own echo in soft-thru mode (the firmware default)', async () => {
    const r = rig({ firmware: 'shooz' });
    expect(r.synth.outMode).toBe(SHRUTHI_OUT_MODE.thru);
    const unsolicited: number[] = [];
    r.client.on('unsolicited', (f) => unsolicited.push(f.command));
    expect(await r.settle(r.client.detect())).toBe('shooz');
    expect(unsolicited).toEqual([SHRUTHI_CMD.versionRequest]); // the echo
  });

  it('dumps the init patch, name, banks and system settings', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off, banks: 2 });
    expect(await r.settle(r.client.fetchPatch())).toEqual(shruthiInitPatch());
    expect(await r.settle(r.client.fetchName())).toBe('init');
    expect(await r.settle(r.client.fetchBanks())).toBe(2);
    const system = await r.settle(r.client.fetchSystem());
    expect(system).toHaveLength(15);
  });

  it('queues requests and answers them in order', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    const all = Promise.all([r.client.fetchName(), r.client.fetchPatch(), r.client.detect()]);
    const [name, patch, mode] = await r.settle(all);
    expect(name).toBe('init');
    expect(patch[91]).toBe(PATCH_MARKER.yam);
    expect(mode).toBe('shooz');
  });
});

describe('virtual Shruthi: live edits', () => {
  it('applies NRPN edits, rejects out-of-range values, handles signed values', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    const cutoff = shruthiParam('filter.cutoff');
    const range = shruthiParam('osc2.range');
    r.sendRaw(encodeNrpn(0, cutoff.address, 77));
    r.sendRaw(encodeNrpn(0, range.address, -12));
    r.sendRaw(encodeNrpn(0, shruthiParam('mix.subShape').address, 11)); // max 10
    r.flush();
    expect(r.synth.value(cutoff)).toBe(77);
    expect((r.synth.value(range) << 24) >> 24).toBe(-12);
    expect(r.synth.value(shruthiParam('mix.subShape'))).toBe(0);
    const patch = await r.settle(r.client.fetchPatch());
    expect(patch[12]).toBe(77);
  });

  it("carries SHOOZ envelope curves in the patch ('&')", async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    r.sendRaw(encodeNrpn(0, SHRUTHI_OFFSET.envCurve1, 3));
    r.sendRaw(encodeNrpn(0, SHRUTHI_OFFSET.envCurve2, 7));
    r.flush();
    expect(r.synth.curves).toEqual([3, 7]);
    const patch = await r.settle(r.client.fetchPatch());
    expect(patch[91]).toBe(PATCH_MARKER.shooz);
    // Back into a fresh synth: the curves come with it.
    const r2 = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    r2.client.sendPatch(patch);
    r2.flush(400);
    expect(r2.synth.sysexStatus).toBe('+');
    expect(r2.synth.curves).toEqual([3, 7]);
  });

  it("stock YAM refuses a curve patch and shows '--------'", () => {
    const r = rig({ firmware: 'stock', outMode: SHRUTHI_OUT_MODE.off });
    const ram = unpackPatch(shruthiInitPatch());
    ram[12] = 5;
    r.client.sendPatch(packPatch(ram, { curves: [1, 0] }));
    r.flush(400);
    expect(r.synth.sysexStatus).toBe('#');
    expect(r.synth.patchName).toBe('--------');
    expect(r.synth.value(12)).not.toBe(5);
  });

  it('SHOOZ clamps an out-of-range patch on load; stock keeps it', () => {
    const wire = shruthiInitPatch();
    wire[0] = 200; // oscillator 1 shape
    wire[24] = 99; // LFO 1 waveform
    for (const fw of ['shooz', 'stock'] as const) {
      const r = rig({ firmware: fw, outMode: SHRUTHI_OUT_MODE.off });
      r.client.sendPatch(wire);
      r.flush(400);
      expect(r.synth.sysexStatus).toBe('+');
      expect(r.synth.value(0)).toBe(fw === 'shooz' ? 43 : 200);
      expect(r.synth.value(24)).toBe(fw === 'shooz' ? 20 : 99);
    }
  });

  it('rejects bad checksums and wrong sizes', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    const msg = encodeSysEx(DEVICE_SHRUTHI, SHRUTHI_CMD.patch, 0, shruthiInitPatch());
    msg[msg.length - 2] ^= 1;
    r.sendRaw(msg);
    r.flush(400);
    expect(r.synth.sysexStatus).toBe('#');
    r.sendRaw(encodeSysEx(DEVICE_SHRUTHI, SHRUTHI_CMD.patch, 0, new Uint8Array(91)));
    r.flush(400);
    expect(r.synth.sysexStatus).toBe('#');
  });

  it('stores patches and recalls them with bank select + program change', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off, banks: 1 });
    for (const [slot, cutoff] of [[3, 30], [70, 70]] as const) {
      r.sendRaw(encodeNrpn(0, 12, cutoff));
      r.client.writePatch(slot);
      r.flush(400);
      expect(r.synth.sysexStatus).toBe('+');
    }
    r.client.writePatch(80); // 16 + 64 slots with one bank: refused
    r.flush(400);
    expect(r.synth.sysexStatus).toBe('#');
    r.sendRaw(Uint8Array.of(0xb0, 0, 0, 0xc0, 3));
    r.flush();
    expect(r.synth.value(12)).toBe(30);
    r.sendRaw(Uint8Array.of(0xc0, 70));
    r.flush();
    expect(r.synth.value(12)).toBe(70);
  });

  it('scales mapped CCs and respects the MIDI channel', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    r.sendRaw(Uint8Array.of(0xb0, 23, 127)); // sub-oscillator shape
    r.flush();
    expect(r.synth.value(shruthiParam('mix.subShape'))).toBe(10);
    r.synth.mem[SHRUTHI_OFFSET.system + 5] = 2; // listen on channel 2
    r.sendRaw(Uint8Array.of(0xb0, 14, 10)); // channel 1: ignored
    r.sendRaw(Uint8Array.of(0xb1, 74, 99)); // channel 2: cutoff
    r.flush();
    expect(r.synth.value(12)).toBe(99);
  });
});

describe('virtual Shruthi: front-panel edits (OnEdit)', () => {
  it('sends a CC for mapped parameters and NRPN for the rest, in ctrl mode', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.ctrl });
    r.synth.edit(shruthiParam('filter.cutoff'), 64);
    r.synth.edit(shruthiParam('mix.subShape'), 10);
    r.synth.edit(shruthiParam('mod.amount'), -5);
    r.synth.edit(shruthiParam('env1.curve'), 4); // never echoed
    r.flush();
    const out = r.fromSynth.map((m) => Array.from(m));
    expect(out[0]).toEqual([0xb0, 14, 64]);
    expect(out[1]).toEqual([0xb0, 23, 117]); // the firmware's rounding; Scale(117) = 10
    // NRPN: address 34 (mod row 1 amount), value -5 = 0xfb: MSB 1, LSB 0x7b.
    expect(out.slice(2)).toEqual([[0xb0, 99, 0], [0xb0, 98, 34], [0xb0, 6, 1], [0xb0, 38, 0x7b]]);
  });

  it('echo values decode back to the edited value', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.full });
    const mirror = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    for (const id of ['mix.subShape', 'lfo1.shape', 'arp.division', 'mix.balance', 'seq.groove']) {
      const p = shruthiParam(id);
      for (let v = p.min; v <= p.max; v++) r.synth.edit(p, v === r.synth.value(p) ? p.min : v);
    }
    r.flush(2000);
    for (const m of r.fromSynth) mirror.sendRaw(m);
    mirror.flush(2000);
    for (const id of ['mix.subShape', 'lfo1.shape', 'arp.division', 'mix.balance', 'seq.groove']) {
      expect(mirror.synth.value(shruthiParam(id)), id).toBe(r.synth.value(shruthiParam(id)));
    }
  });

  it('stays quiet in thru, seq and off modes', () => {
    for (const mode of [SHRUTHI_OUT_MODE.off, SHRUTHI_OUT_MODE.thru, SHRUTHI_OUT_MODE.seq]) {
      const r = rig({ firmware: 'shooz', outMode: mode });
      r.synth.edit(shruthiParam('filter.cutoff'), 64);
      r.flush();
      expect(r.fromSynth).toHaveLength(0);
    }
  });

  it('forwards incoming SysEx in full mode', () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.full });
    const req = shruthiRequest(SHRUTHI_CMD.nameRequest);
    r.sendRaw(req);
    r.flush(400);
    expect(Array.from(r.fromSynth[0])).toEqual(Array.from(req));
    expect(r.fromSynth[1][6]).toBe(SHRUTHI_CMD.name);
  });
});
