// End-to-end: SHED's sync engine against the simulated Ambika, over a serial
// link that delivers bytes in order at 31.25 kbaud.

import { describe, expect, it } from 'vitest';
import { wireTimeMs } from '../src/midi/scheduler';
import { NUM_PARTS, PART_BASE, param } from '../src/model/params/ambika';
import { fromByte } from '../src/model/params/types';
import { StorageObject } from '../src/protocol/ambika';
import { RequestTimeout } from '../src/protocol/client';
import { IN_FILTER, VirtualAmbika, type OutMode } from '../src/sim/virtual-ambika';
import { splitMessages } from '../src/sync/echo';
import { SyncEngine } from '../src/sync/engine';
import { FakeClock } from './fake-clock';

function rig(opts: { firmware: 'stock' | 'yamplus'; yamPlusVersion?: number; outMode?: OutMode; inFilter?: number }) {
  const clock = new FakeClock();
  const logs: string[] = [];
  // One serial line per direction: a message arrives after the previous one
  // and its own wire time.
  const line = () => {
    let busyUntil = 0;
    return (msg: Uint8Array, deliver: (m: Uint8Array) => void) => {
      const at = Math.max(clock.now(), busyUntil) + wireTimeMs(msg.length);
      busyUntil = at;
      clock.setTimer(() => deliver(msg), at - clock.now());
    };
  };
  const toSynth = line();
  const toShed = line();
  let synth!: VirtualAmbika;
  const engine = new SyncEngine(
    {
      send: (bytes) => {
        for (const m of splitMessages(bytes)) toSynth(m.slice(), (x) => synth.receive(x));
        return true;
      },
    },
    clock,
  );
  synth = new VirtualAmbika({ ...opts, send: (m) => toShed(m, (x) => engine.handleMidi(x)) });
  engine.on('log', (l) => logs.push(l.text));
  /** Runs a promise to completion while advancing the fake clock. */
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
  return { clock, engine, synth, logs, settle };
}

const cutoff = param('filter1.cutoff');
const resonance = param('filter1.resonance');
const detune = param('osc2.detune');

describe('SHED against the simulated Ambika', () => {
  it('detects BAMBI and pulls everything with tagged replies', async () => {
    const { engine, synth, settle } = rig({ firmware: 'yamplus' });
    synth.turnKnob(3, cutoff.address, 7);
    synth.parts[5].patch[0] = 30;
    expect(await settle(engine.detect())).toBe('yamplus');
    expect(engine.client.firmware?.oscShapes).toBe(43);
    await settle(engine.pullAll());
    for (let p = 0; p < NUM_PARTS; p++) {
      expect([...engine.parts[p].patch]).toEqual([...synth.parts[p].patch]);
      expect([...engine.parts[p].part]).toEqual([...synth.parts[p].data]);
    }
    expect(engine.mappings[1]).toEqual({ channel: 2, keyLow: 0, keyHigh: 127, voices: 0x2a });
    const name = await settle(engine.client.requestName(2, StorageObject.Program));
    expect(name.name).toBe('Program 2');
  });

  it('falls back to stock YAM and still attributes a pulled part correctly', async () => {
    const { engine, synth, settle } = rig({ firmware: 'stock' });
    expect(await settle(engine.detect())).toBe('stock');
    expect(synth.sysexStatus).toBe('#'); // the LCD shows # after the unknown version request
    synth.parts[2].patch[cutoff.address] = 11;
    await settle(engine.pullPart(2));
    expect(engine.parts[2].patch[cutoff.address]).toBe(11);
    await settle(engine.pullAll());
    expect([...engine.parts[4].part]).toEqual([...synth.parts[4].data]);
  });

  it('sends UI edits that land on the synth, mirrored to parts on the same channel', async () => {
    const { clock, engine, synth } = rig({ firmware: 'yamplus' });
    synth.multi[2 * 4] = 1; // part 3 listens on channel 1, like part 1
    engine.mappings[2] = { ...engine.mappings[2], channel: 1 };
    for (let v = 0; v <= 100; v += 5) {
      engine.set(0, cutoff, v);
      clock.advance(3);
    }
    engine.set(0, detune, -20);
    clock.advance(200);
    expect(synth.byte(0, cutoff.address)).toBe(100);
    expect(synth.byte(2, cutoff.address)).toBe(100);
    expect(engine.value(2, cutoff)).toBe(100);
    expect(fromByte(detune, synth.byte(0, detune.address))).toBe(-20);
    expect(synth.byte(1, cutoff.address)).not.toBe(100);
  });

  it('follows front-panel edits, including the running address shared across channels', async () => {
    const { clock, engine, synth } = rig({ firmware: 'yamplus' });
    synth.turnKnob(0, cutoff.address, 40);
    synth.turnKnob(1, cutoff.address, 70); // goes out without CC99/98, on channel 2
    synth.turnKnob(1, resonance.address, 12);
    for (let i = 0; i < 40; i++) synth.turnKnob(1, resonance.address, 13 + (i % 20)); // crosses the 32-value refresh
    clock.advance(500);
    expect(engine.value(0, cutoff)).toBe(40);
    expect(engine.value(1, cutoff)).toBe(70);
    expect(engine.value(1, resonance)).toBe(synth.byte(1, resonance.address));
    expect(engine.hardwareEditsSeen).toBe(true);
  });

  it('ignores the echoes of outp mode full and still attributes knob turns', async () => {
    const { clock, engine, synth, logs, settle } = rig({ firmware: 'yamplus', outMode: 'full' });
    await settle(engine.detect());
    expect(engine.echoing).toBe(true);
    synth.turnKnob(0, cutoff.address, 50); // synth's running address: cutoff
    clock.advance(100);
    engine.set(0, detune, 9); // SHED sends CC99/98 for detune; the synth forwards them
    clock.advance(30);
    synth.turnKnob(0, cutoff.address, 51); // value only: still cutoff for the synth
    clock.advance(300);
    expect(engine.value(0, cutoff)).toBe(51);
    expect(engine.value(0, detune)).toBe(9);
    expect(fromByte(detune, synth.byte(0, detune.address))).toBe(9);
    const before = logs.length;
    engine.pushPatch(0);
    clock.advance(500);
    expect(logs.slice(before).some((l) => /Patch received/.test(l))).toBe(false);
  });

  it('does not take a pulled dump identical to a push for an echo (BAMBI, controllr)', async () => {
    const { engine, synth, settle } = rig({ firmware: 'yamplus' });
    await settle(engine.detect());
    engine.pushPatch(0);
    await settle(engine.pullPart(0)); // reply: 0x01, part 1, same bytes as the push
    expect(engine.echoing).toBe(false);
    expect([...engine.parts[0].patch]).toEqual([...synth.parts[0].patch]);
  });

  it('pushes a patch and part settings that the synth stores', async () => {
    const { clock, engine, synth } = rig({ firmware: 'yamplus' });
    const patch = engine.parts[4].patch.slice();
    patch[cutoff.address] = 99;
    patch[0] = 42; // osc 1 shape past 37
    const part = engine.parts[4].part.slice();
    part[0] = 77; // volume
    part[80] = 2; // spread mode wide (YAM+)
    engine.loadPart(4, patch, part);
    clock.advance(2000);
    expect([...synth.parts[4].patch]).toEqual([...patch]);
    expect(synth.byte(4, PART_BASE + 0)).toBe(77);
    expect(synth.byte(4, PART_BASE + 80)).toBe(2);
  });

  it('accepts a multi sent from the front panel', async () => {
    const { clock, engine, synth } = rig({ firmware: 'stock' });
    synth.multi[0] = 9;
    synth.parts[3].patch[cutoff.address] = 3;
    synth.sendMultiFromPanel();
    clock.advance(2000);
    expect(engine.mappings[0].channel).toBe(9);
    expect(engine.parts[3].patch[cutoff.address]).toBe(3);
  });

  it('times out cleanly when the input filter blocks SysEx, and edits do nothing when it blocks NRPN', async () => {
    const blocked = rig({ firmware: 'yamplus', inFilter: IN_FILTER.sysex });
    expect(await blocked.settle(blocked.engine.detect())).toBe('stock');
    await expect(blocked.settle(blocked.engine.pullPart(0))).rejects.toBeInstanceOf(RequestTimeout);

    const deaf = rig({ firmware: 'yamplus', inFilter: IN_FILTER.nrpn });
    deaf.engine.set(0, cutoff, 5);
    deaf.clock.advance(100);
    expect(deaf.synth.byte(0, cutoff.address)).not.toBe(5);
  });

  describe('BAMBI 0.2 values (3x/4x unison, sub-octave spread)', () => {
    const mode = param('part.polyphony');
    const spreadMode = param('part.spreadMode');

    it('offers and sends them to BAMBI 0.2', async () => {
      const { clock, engine, synth, settle } = rig({ firmware: 'yamplus' });
      await settle(engine.detect());
      expect(engine.valueMax(mode)).toBe(6);
      expect(engine.valueMax(spreadMode)).toBe(3);
      engine.set(0, mode, 6);
      engine.set(0, spreadMode, 3);
      clock.advance(200);
      expect(synth.byte(0, mode.address)).toBe(6);
      expect(synth.byte(0, spreadMode.address)).toBe(3);
      // A front-panel change to 3x unison shows up in SHED.
      synth.turnKnob(0, mode.address, 5);
      clock.advance(200);
      expect(engine.value(0, mode)).toBe(5);
    });

    it('stops at the old maximum on BAMBI 0.1 and stock YAM', async () => {
      for (const opts of [{ firmware: 'yamplus' as const, yamPlusVersion: 0x01 }, { firmware: 'stock' as const }]) {
        const { clock, engine, synth, settle } = rig(opts);
        await settle(engine.detect());
        expect(engine.valueMax(mode)).toBe(4);
        engine.set(0, mode, 5); // e.g. typed in: 3x unison -> 2x unison, not chain
        clock.advance(200);
        expect(engine.value(0, mode)).toBe(2);
        expect(synth.byte(0, mode.address)).toBe(2);
      }
      const old = rig({ firmware: 'yamplus', yamPlusVersion: 0x01 });
      await old.settle(old.engine.detect());
      expect(old.engine.valueMax(spreadMode)).toBe(2);
    });

    it('loads a librarian part with 4x unison into stock YAM as 2x unison', async () => {
      const { clock, engine, synth, settle } = rig({ firmware: 'stock' });
      await settle(engine.detect());
      const patch = new Uint8Array(synth.parts[1].patch);
      const part = new Uint8Array(synth.parts[1].data);
      part[mode.address - PART_BASE] = 6;
      engine.loadPart(1, patch, part);
      clock.advance(2000);
      expect(engine.value(1, mode)).toBe(2);
      expect(synth.byte(1, mode.address)).toBe(2);
    });

    it('is permissive before the firmware is known', () => {
      const { engine } = rig({ firmware: 'yamplus' });
      expect(engine.valueMax(mode)).toBe(6);
    });

    it('the simulated stock YAM clamps the NRPN itself', () => {
      const { clock, synth } = rig({ firmware: 'stock' });
      synth.receive(Uint8Array.of(0xb0, 99, 0));
      synth.receive(Uint8Array.of(0xb0, 98, mode.address));
      synth.receive(Uint8Array.of(0xb0, 6, 0));
      synth.receive(Uint8Array.of(0xb0, 38, 6));
      clock.advance(10);
      expect(synth.byte(0, mode.address)).toBe(4);
    });
  });

  describe('BAMBI 0.3 voice steal mode', () => {
    const steal = param('part.stealMode');

    it('offers every mode to BAMBI 0.3 and sends it by NRPN 193', async () => {
      const { clock, engine, synth, settle } = rig({ firmware: 'yamplus' });
      await settle(engine.detect());
      expect(engine.firmware).toBe('yamplus');
      expect(engine.valueMax(steal)).toBe(3);
      engine.set(2, steal, 2);
      clock.advance(200);
      expect(synth.byte(2, PART_BASE + 81)).toBe(2);
      // A front-panel change shows up in SHED.
      synth.turnKnob(2, steal.address, 3);
      clock.advance(200);
      expect(engine.value(2, steal)).toBe(3);
    });

    it('reports part layout 2 from BAMBI 0.3 and 1 from 0.2', async () => {
      for (const [version, layout] of [[0x03, 2], [0x02, 1]]) {
        const { engine, settle } = rig({ firmware: 'yamplus', yamPlusVersion: version });
        await settle(engine.detect());
        expect(engine.client.firmware?.partLayout).toBe(layout);
      }
    });

    it('keeps BAMBI 0.2 and stock YAM on "oldest"', async () => {
      for (const opts of [{ firmware: 'yamplus' as const, yamPlusVersion: 0x02 }, { firmware: 'stock' as const }]) {
        const { clock, engine, synth, settle } = rig(opts);
        await settle(engine.detect());
        expect(engine.valueMax(steal)).toBe(0);
        const patch = new Uint8Array(synth.parts[0].patch);
        const part = new Uint8Array(synth.parts[0].data);
        part[81] = 3; // a library part saved from BAMBI 0.3
        engine.loadPart(0, patch, part);
        clock.advance(2000);
        expect(engine.value(0, steal)).toBe(0);
        expect(synth.byte(0, PART_BASE + 81)).toBe(0);
      }
    });

    it('loads a library part with its steal mode into BAMBI 0.3', async () => {
      const { clock, engine, synth, settle } = rig({ firmware: 'yamplus' });
      await settle(engine.detect());
      const patch = new Uint8Array(synth.parts[5].patch);
      const part = new Uint8Array(synth.parts[5].data);
      part[80] = 2;
      part[81] = 1;
      engine.loadPart(5, patch, part);
      clock.advance(2000);
      expect(synth.byte(5, PART_BASE + 80)).toBe(2);
      expect(synth.byte(5, PART_BASE + 81)).toBe(1);
    });
  });
});
