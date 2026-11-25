import { describe, expect, it } from 'vitest';
import { DEVICE_AMBIKA, decodeSysEx, encodeSysEx } from '../src/midi/framer';
import { encodeNrpn } from '../src/midi/nrpn';
import { initPatch, param } from '../src/model/params/ambika';
import { CMD } from '../src/protocol/ambika';
import { ECHO_SUPPRESS_MS, EDIT_INTERVAL_MS, SyncEngine } from '../src/sync/engine';
import { FakeClock } from './fake-clock';

function setup() {
  const clock = new FakeClock();
  const out: Uint8Array[] = [];
  const engine = new SyncEngine({ send: (b) => (out.push(b), true) }, clock);
  return { clock, out, engine };
}

/** Splits sent bytes into 3-byte CC messages (non-SysEx output only). */
function ccs(out: Uint8Array[]): number[][] {
  const res: number[][] = [];
  for (const b of out) {
    if (b[0] === 0xf0) continue;
    for (let i = 0; i < b.length; i += 3) res.push([...b.slice(i, i + 3)]);
  }
  return res;
}

const feed = (engine: SyncEngine, bytes: Uint8Array) => {
  for (let i = 0; i < bytes.length; i += 3) engine.handleMidi(bytes.slice(i, i + 3));
};

describe('SyncEngine', () => {
  it('sends an edit as NRPN on the part channel, coalescing a drag to ~40 Hz', () => {
    const { clock, out, engine } = setup();
    const cutoff = param('filter1.cutoff');
    engine.set(1, cutoff, 10); // part 2 → channel 2 (index 1) by default
    for (let v = 11; v <= 60; v++) engine.set(1, cutoff, v);
    expect(ccs(out)).toEqual([
      [0xb1, 99, 0],
      [0xb1, 98, 16],
      [0xb1, 6, 0],
      [0xb1, 38, 10],
    ]);
    clock.advance(EDIT_INTERVAL_MS);
    // Only the latest value, with the running address (no CC99/98).
    expect(ccs(out).slice(4)).toEqual([
      [0xb1, 6, 0],
      [0xb1, 38, 60],
    ]);
    expect(engine.value(1, cutoff)).toBe(60);
  });

  it('sends signed values as two-complement bytes and clamps the oscillator shape', () => {
    const { out, engine } = setup();
    engine.set(0, param('osc1.detune'), -5);
    expect(ccs(out).slice(2)).toEqual([
      [0xb0, 6, 1],
      [0xb0, 38, (-5 & 0xff) & 0x7f],
    ]);
    engine.set(0, param('osc1.shape'), 99);
    expect(engine.value(0, param('osc1.shape'))).toBe(42);
  });

  it('applies hardware NRPN echoes, with echo suppression while dragging', () => {
    const { clock, engine } = setup();
    const res = param('filter1.resonance');
    const seen: string[] = [];
    engine.on('param', (e) => seen.push(`${e.part}:${e.address}:${e.byte}:${e.origin}`));

    feed(engine, encodeNrpn(0, res.address, 40));
    expect(engine.value(0, res)).toBe(40);
    expect(seen).toEqual([`0:17:40:hardware`]);
    expect(engine.hardwareEditsSeen).toBe(true);

    engine.beginDrag(0, res.address);
    engine.set(0, res, 10);
    feed(engine, encodeNrpn(0, res.address, 50));
    expect(engine.value(0, res)).toBe(10); // ignored while dragging
    engine.endDrag(0, res.address);
    clock.advance(ECHO_SUPPRESS_MS - 10);
    feed(engine, encodeNrpn(0, res.address, 51));
    expect(engine.value(0, res)).toBe(10); // still inside the suppression window
    clock.advance(20);
    feed(engine, encodeNrpn(0, res.address, 52));
    expect(engine.value(0, res)).toBe(52);
  });

  it('decodes signed hardware values and value-only (running address) messages', () => {
    const { engine } = setup();
    const kbt = param('filter.keytrack');
    feed(engine, encodeNrpn(2, kbt.address, -20 & 0xff));
    expect(engine.value(2, kbt)).toBe(-20);
    feed(engine, encodeNrpn(2, kbt.address, 30, false));
    expect(engine.value(2, kbt)).toBe(30);
  });

  it('updates every part listening on the channel once the multi is known', async () => {
    const { engine, out } = setup();
    engine.client.mode = 'yamplus';
    const pull = engine.pullAll();
    expect(decodeSysEx(out[0])).toMatchObject({ command: 0x14 });
    const multi = new Uint8Array(56);
    multi.set([1, 0, 127, 0x07, 1, 0, 127, 0x38, 0, 0, 127, 0], 0); // parts 1, 2 on ch 1; part 3 omni
    for (let i = 3; i < 6; i++) multi[i * 4] = i + 1;
    engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.MULTI, 0, multi));
    for (let p = 1; p <= 6; p++) {
      const patch = initPatch();
      patch[16] = p * 10;
      engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, p, patch));
      engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.PART, p, new Uint8Array(84).fill(p)));
    }
    await pull;
    expect(engine.mappingsKnown).toBe(true);
    expect(engine.parts.map((m) => m.patch[16])).toEqual([10, 20, 30, 40, 50, 60]);
    expect(engine.parts[3].part[0]).toBe(4);
    expect(engine.channelSiblings(0)).toEqual([1, 2]);
    feed(engine, encodeNrpn(0, 16, 99));
    expect(engine.parts.map((m) => m.patch[16])).toEqual([99, 99, 99, 40, 50, 60]);
  });

  it('pulls one part with a program request and files an untagged stock reply under it', async () => {
    const { engine, out } = setup();
    engine.client.mode = 'stock';
    const pull = engine.pullPart(4);
    expect(decodeSysEx(out[0])).toMatchObject({ command: 0x13, argument: 5 });
    const patch = initPatch();
    patch[0] = 16;
    engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, 0, patch));
    engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.PART, 0, new Uint8Array(84).fill(3)));
    await pull;
    expect(engine.parts[4].patch[0]).toBe(16);
    expect(engine.parts[4].synced).toBe(true);
  });

  it('pushes a full patch as SysEx 0x01 tagged with the part, built from the latest model', () => {
    const { clock, out, engine } = setup();
    engine.pushPatch(2);
    engine.parts[2].patch[16] = 77; // edited after the first push went out
    const first = decodeSysEx(out[0]);
    expect(first).toMatchObject({ command: 0x01, argument: 3 });
    expect(first.payload).toHaveLength(112);
    // A second push while the bucket is in debt is coalesced and carries 77.
    engine.pushPatch(2);
    engine.pushPatch(2);
    clock.advance(1000);
    const pushes = out.filter((b) => b[0] === 0xf0).map((b) => decodeSysEx(b));
    expect(pushes).toHaveLength(2);
    expect(pushes[1].payload[16]).toBe(77);
  });

  it('applies an unsolicited untagged dump to the selected part', () => {
    const { engine } = setup();
    engine.selectedPart = 3;
    const patch = initPatch();
    patch[8] = 5;
    engine.handleMidi(encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, 0, patch));
    expect(engine.parts[3].patch[8]).toBe(5);
    expect(engine.parts[0].patch[8]).toBe(32);
  });

  it('hides BAMBI parameters on stock firmware', async () => {
    const { engine, clock } = setup();
    expect(engine.supports(param('voice.vintage'))).toBe(true);
    const d = engine.detect();
    clock.advance(1000);
    expect(await d).toBe('stock');
    expect(engine.supports(param('voice.vintage'))).toBe(false);
    expect(engine.supports(param('filter1.cutoff'))).toBe(true);
  });
});
