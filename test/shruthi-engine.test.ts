// ShruthiEngine end-to-end against the simulated Shruthi over a 31.25 kbaud
// link in each direction (replies leave after the firmware's 100 ms delay).

import { describe, expect, it } from 'vitest';
import { encodeNrpn } from '../src/midi/nrpn';
import { wireTimeMs } from '../src/midi/scheduler';
import { SHRUTHI_OFFSET, shruthiInitPatch, shruthiParam } from '../src/model/params/shruthi';
import { PATCH_MARKER } from '../src/protocol/shruthi';
import { SHRUTHI_REQUEST_DELAY_MS } from '../src/protocol/shruthi-client';
import { SHRUTHI_OUT_MODE, VirtualShruthi } from '../src/sim/virtual-shruthi';
import { splitMessages } from '../src/sync/echo';
import { ECHO_SUPPRESS_MS, EDIT_INTERVAL_MS } from '../src/sync/engine';
import { SHRUTHI_SYS, ShruthiEngine } from '../src/sync/shruthi-engine';
import { FakeClock } from './fake-clock';

function rig(opts: { firmware: 'stock' | 'shooz'; outMode?: number; channel?: number; connected?: boolean }) {
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
  const sent: Uint8Array[] = [];
  let synth!: VirtualShruthi;
  const connected = opts.connected ?? true;
  const engine = new ShruthiEngine(
    {
      send: (bytes) => {
        sent.push(bytes.slice());
        if (connected) for (const m of splitMessages(bytes)) toSynth(m.slice(), (x) => synth.receive(x));
        return true;
      },
    },
    clock,
  );
  synth = new VirtualShruthi({
    firmware: opts.firmware,
    outMode: opts.outMode,
    send: (m) => {
      const isReply = m[0] === 0xf0 && (m[6] & 0xf0) !== 0x10;
      toShed(m, (x) => engine.handleMidi(x), isReply ? SHRUTHI_REQUEST_DELAY_MS : 0);
    },
  });
  if (opts.channel !== undefined) synth.mem[SHRUTHI_SYS.midiChannel] = opts.channel;
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
  const connect = async () => {
    await settle(engine.detect());
    await settle(engine.pullSystem());
    await settle(engine.pullPatch());
  };
  return { clock, engine, synth, sent, settle, connect, flush: (ms = 400) => clock.advance(ms) };
}

describe('ShruthiEngine', () => {
  it('connects: detects SHOOZ, reads the system settings and the patch', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.ctrl, channel: 3 });
    r.synth.edit(shruthiParam('filter.cutoff'), 33);
    r.synth.mem[SHRUTHI_OFFSET.envCurve1] = 5;
    r.flush();
    await r.connect();
    expect(r.engine.mode).toBe('shooz');
    expect(r.engine.systemKnown).toBe(true);
    expect(r.engine.txChannel).toBe(2);
    expect(r.engine.value(shruthiParam('filter.cutoff'))).toBe(33);
    expect(r.engine.value(shruthiParam('env1.curve'))).toBe(5);
    expect(r.engine.name).toBe('init');
    expect(r.engine.synced).toBe(true);
  });

  it('reports "absent" when nothing answers', async () => {
    const r = rig({ firmware: 'shooz', connected: false });
    expect(await r.settle(r.engine.detect())).toBe('absent');
    expect(r.engine.supports(shruthiParam('env1.curve'))).toBe(true); // unknown is not stock
  });

  it('sends edits as NRPN on the synth channel, coalesced to ~40 Hz', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off, channel: 2 });
    await r.connect();
    r.sent.length = 0;
    const cutoff = shruthiParam('filter.cutoff');
    for (let v = 10; v <= 60; v++) r.engine.set(cutoff, v);
    r.flush(EDIT_INTERVAL_MS + 50);
    const ccs = r.sent.flatMap((b) => splitMessages(b)).map((m) => Array.from(m));
    expect(ccs.slice(0, 4)).toEqual([[0xb1, 99, 0], [0xb1, 98, 12], [0xb1, 6, 0], [0xb1, 38, 10]]);
    expect(ccs.length).toBe(8); // first value, then only the latest
    expect(r.synth.value(cutoff)).toBe(60);
  });

  it('round-trips signed values, high addresses and SHOOZ-only parameters', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    await r.connect();
    r.engine.set(shruthiParam('osc2.range'), -24);
    r.engine.set(shruthiParam('mod.amount'), -63);
    r.engine.set(shruthiParam('sys.vintage'), 99);
    r.engine.set(shruthiParam('env2.curve'), 6);
    r.engine.set(shruthiParam('sys.octave'), -2);
    r.flush();
    expect((r.synth.value(shruthiParam('osc2.range')) << 24) >> 24).toBe(-24);
    expect((r.synth.value(34) << 24) >> 24).toBe(-63);
    expect(r.synth.value(SHRUTHI_OFFSET.vintage)).toBe(99);
    expect(r.synth.curves).toEqual([0, 6]);
    expect((r.synth.value(shruthiParam('sys.octave')) << 24) >> 24).toBe(-2);
  });

  it('edits every mod-matrix row and operator at its own address', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    await r.connect();
    const dest = shruthiParam('mod.destination');
    for (let row = 0; row < 12; row++) r.engine.setByte(33 + row * 3, (row + 1) % (dest.max + 1));
    const in1 = shruthiParam('op.in1');
    r.engine.setByte(94, 3);
    r.engine.setByte(97, Math.min(in1.max, 7));
    r.flush(1000);
    for (let row = 0; row < 12; row++) expect(r.synth.value(33 + row * 3)).toBe((row + 1) % (dest.max + 1));
    expect(r.synth.value(94)).toBe(3);
    expect(r.synth.value(97)).toBe(Math.min(in1.max, 7));
    // And they survive a patch dump (operators are packed into bytes 87–90).
    // (Bytes 86–91 are the packed copies and the marker, rebuilt by the dump.)
    const unpacked = (m: Uint8Array) => [...m.slice(0, 86), ...m.slice(92, 100)];
    const before = unpacked(r.engine.mem);
    await r.settle(r.engine.pullPatch());
    expect(unpacked(r.engine.mem)).toEqual(before);
  });

  it('follows front-panel edits (CC and NRPN) in ctrl mode', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.ctrl });
    await r.connect();
    const seen: number[] = [];
    r.engine.on('param', (e) => e.origin === 'hardware' && seen.push(e.address));
    r.synth.edit(shruthiParam('filter.cutoff'), 101); // CC 14
    r.synth.edit(shruthiParam('mix.subShape'), 7); // CC 23, scaled
    r.synth.edit(shruthiParam('mod.amount'), -5); // NRPN 34
    r.synth.edit(shruthiParam('seq.tempo'), 140); // NRPN 101
    r.flush();
    expect(r.engine.hardwareEditsSeen).toBe(true);
    expect(r.engine.value(shruthiParam('filter.cutoff'))).toBe(101);
    expect(r.engine.value(shruthiParam('mix.subShape'))).toBe(7);
    expect(r.engine.value(shruthiParam('mod.amount'))).toBe(-5);
    expect(r.engine.value(shruthiParam('seq.tempo'))).toBe(140);
    expect(seen).toEqual([12, 11, 34, 101]);
  });

  it('ignores hardware echoes of a parameter being dragged', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.ctrl });
    await r.connect();
    const res = shruthiParam('filter.resonance');
    r.engine.beginDrag(res.address);
    r.engine.set(res, 10);
    r.synth.edit(res, 50);
    r.flush(50);
    expect(r.engine.value(res)).toBe(10);
    r.engine.endDrag(res.address);
    r.clock.advance(ECHO_SUPPRESS_MS + 10);
    r.synth.edit(res, 51);
    r.flush(50);
    expect(r.engine.value(res)).toBe(51);
  });

  it('drops its own echoes in thru mode (the factory default)', async () => {
    const r = rig({ firmware: 'shooz' });
    await r.connect();
    expect(r.engine.echoing).toBe(true);
    const cutoff = shruthiParam('filter.cutoff');
    r.engine.set(cutoff, 20);
    r.clock.advance(ECHO_SUPPRESS_MS + 50);
    r.engine.set(cutoff, 90);
    r.flush(1000);
    expect(r.engine.value(cutoff)).toBe(90);
    expect(r.engine.hardwareEditsSeen).toBe(false);
    expect(r.synth.value(cutoff)).toBe(90);
  });

  it('pushes a patch with curves to SHOOZ, without them to stock YAM', async () => {
    for (const firmware of ['shooz', 'stock'] as const) {
      const r = rig({ firmware, outMode: SHRUTHI_OUT_MODE.off });
      await r.connect();
      r.engine.mem[12] = 44;
      r.engine.mem[SHRUTHI_OFFSET.envCurve1] = 2;
      r.engine.pushPatch();
      r.flush(600);
      expect(r.synth.sysexStatus, firmware).toBe('+');
      expect(r.synth.value(12)).toBe(44);
      expect(r.synth.curves).toEqual(firmware === 'shooz' ? [2, 0] : [0, 0]);
    }
  });

  it('loads a library patch and keeps the synth in step', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    await r.connect();
    const wire = shruthiInitPatch();
    wire[12] = 77;
    wire.set([0x62, 0x61, 0x73, 0x73, 0x20, 0x20, 0x20, 0x20], 68); // "bass"
    expect(r.engine.loadPatch(wire)).toBe(true);
    r.flush(600);
    expect(r.engine.name).toBe('bass');
    expect(r.synth.value(12)).toBe(77);
    expect(r.synth.patchName.trimEnd()).toBe('bass');
    const corrupt = shruthiInitPatch();
    corrupt[91] = 0;
    expect(r.engine.loadPatch(corrupt)).toBe(false);
    expect(r.engine.name).toBe('bass');
  });

  it('takes a patch sent from the front panel', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.ctrl });
    await r.connect();
    const other = new VirtualShruthi({ firmware: 'shooz', send: () => undefined });
    other.mem[12] = 5;
    other.mem[SHRUTHI_OFFSET.envCurve2] = 3;
    const wire = other.wirePatch();
    expect(wire[91]).toBe(PATCH_MARKER.shooz);
    // As if the user hit "send" on the synth: an unsolicited 0x01 dump.
    const { shruthiPatchDump } = await import('../src/protocol/shruthi');
    r.engine.handleMidi(shruthiPatchDump(wire));
    expect(r.engine.mem[12]).toBe(5);
    expect(r.engine.value(shruthiParam('env2.curve'))).toBe(3);
  });

  it('writes the edit buffer to a slot', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off });
    await r.connect();
    r.engine.set(shruthiParam('filter.cutoff'), 12);
    r.engine.writeSlot(5);
    r.flush(600);
    expect(r.synth.patchSlots.get(5)?.[12]).toBe(12);
  });

  it('ignores NRPN on another channel and out-of-range values, like the firmware', async () => {
    const r = rig({ firmware: 'shooz', outMode: SHRUTHI_OUT_MODE.off, channel: 1 });
    await r.connect();
    r.engine.handleMidi(Uint8Array.of(0xb1, 74, 0)); // channel 2: ignored
    for (const m of splitMessages(encodeNrpn(0, shruthiParam('mix.subShape').address, 11))) r.engine.handleMidi(m);
    expect(r.engine.value(shruthiParam('mix.subShape'))).toBe(0);
    expect(r.engine.hardwareEditsSeen).toBe(false);
  });
});

describe('ShruthiEngine: SHOOZ filter calibration', () => {
  const PROFILE = SHRUTHI_OFFSET.filterProfile;
  const OFFSET = SHRUTHI_OFFSET.filterCutoffOffset;
  const RES_MAX = SHRUTHI_OFFSET.filterResonanceMax;

  it('reads the calibration from the version reply on connect', async () => {
    const r = rig({ firmware: 'shooz' });
    r.synth.mem.set([4, 0xf6, 99], PROFILE); // smr4, -10, 99
    const seen: number[] = [];
    r.engine.on('param', ({ address, origin }) => origin === 'hardware' && seen.push(address));
    await r.connect();
    expect(r.engine.client.firmware?.shooz?.filterCal).toEqual([4, 0xf6, 99]);
    expect(r.engine.value(shruthiParam('sys.filterProfile'))).toBe(4);
    expect(r.engine.value(shruthiParam('sys.filterCutoffOffset'))).toBe(-10);
    expect(r.engine.value(shruthiParam('sys.filterResonanceMax'))).toBe(99);
    expect(seen).toEqual(expect.arrayContaining([PROFILE, OFFSET, RES_MAX]));
  });

  it('defaults match the firmware before anything is read', () => {
    const r = rig({ firmware: 'shooz' });
    expect([r.engine.byte(PROFILE), r.engine.byte(OFFSET), r.engine.byte(RES_MAX)]).toEqual([0, 0, 127]);
    expect([r.synth.mem[PROFILE], r.synth.mem[OFFSET], r.synth.mem[RES_MAX]]).toEqual([0, 0, 127]);
  });

  it('edits go out as NRPN 159-161, signed offset included', async () => {
    const r = rig({ firmware: 'shooz' });
    await r.connect();
    r.engine.set(shruthiParam('sys.filterProfile'), 2);
    r.engine.set(shruthiParam('sys.filterCutoffOffset'), -63);
    r.engine.set(shruthiParam('sys.filterResonanceMax'), 64);
    r.engine.set(shruthiParam('sys.filterCutoffOffset'), -80); // clamped to -63
    r.flush(EDIT_INTERVAL_MS * 4 + 200);
    expect(r.synth.mem[PROFILE]).toBe(2);
    expect(r.synth.mem[OFFSET]).toBe(0xc1);
    expect(r.synth.mem[RES_MAX]).toBe(64);
    // Live only: not saved yet.
    expect(r.synth.savedFilterCal).toBeNull();
  });

  it('saves the system settings and the calibration only after reading them', async () => {
    const r = rig({ firmware: 'shooz', channel: 5 });
    expect(r.engine.saveSystem()).toBe(false); // would overwrite channel 5 with omni/1
    await r.connect();
    r.engine.set(shruthiParam('sys.filterProfile'), 1);
    r.engine.set(shruthiParam('sys.vintage'), 40);
    expect(r.engine.saveSystem()).toBe(true);
    r.flush(1500);
    expect(r.synth.sysexStatus).toBe('+');
    expect(r.synth.mem[SHRUTHI_SYS.midiChannel]).toBe(5);
    expect(r.synth.mem[SHRUTHI_OFFSET.vintage]).toBe(40);
    expect(Array.from(r.synth.savedFilterCal ?? [])).toEqual([1, 0, 127]);
  });

  it('stock YAM: no calibration in the reply, NRPN ignored, controls disabled', async () => {
    const r = rig({ firmware: 'stock' });
    await r.connect();
    expect(r.engine.client.firmware?.shooz).toBeUndefined();
    expect(r.engine.supports(shruthiParam('sys.filterProfile'))).toBe(false);
    r.engine.setByte(PROFILE, 3);
    r.flush(400);
    expect(r.synth.mem[PROFILE]).toBe(0);
  });
});

