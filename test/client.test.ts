import { describe, expect, it } from 'vitest';
import { DEVICE_AMBIKA, decodeSysEx, encodeSysEx, type SysExFrame } from '../src/midi/framer';
import { CMD, StorageObject, parseLocations, parseName } from '../src/protocol/ambika';
import { AmbikaClient, DETECT_TIMEOUT_MS, RequestTimeout } from '../src/protocol/client';
import { FakeClock } from './fake-clock';

const reply = (cmd: number, arg: number, payload: ArrayLike<number>) => encodeSysEx(DEVICE_AMBIKA, cmd, arg, payload);
const filled = (n: number, v: number) => new Uint8Array(n).fill(v);

function setup() {
  const clock = new FakeClock();
  const sent: SysExFrame[] = [];
  const client = new AmbikaClient(
    {
      send: (bytes, _lane, onSent) => {
        sent.push(decodeSysEx(bytes));
        onSent();
      },
    },
    clock,
  );
  const unsolicited: SysExFrame[] = [];
  client.on('unsolicited', (f) => unsolicited.push(f));
  return { clock, sent, client, unsolicited };
}

const VERSION_PAYLOAD = [1, 0x10, 0x01, 43, 1, 1, 1, 0x11, 1, 0x11, 1, 0x11, 1, 0x11, 1, 0x11, 0xff, 0xff];

describe('AmbikaClient', () => {
  it('detects BAMBI from the version reply', async () => {
    const { client, sent } = setup();
    const p = client.detect();
    expect(sent[0]).toMatchObject({ command: 0x1c, argument: 0 });
    client.handleSysEx(reply(CMD.VERSION, 0, VERSION_PAYLOAD));
    expect(await p).toBe('yamplus');
    expect(client.firmware).toMatchObject({ family: 'yamplus', yamPlusVersion: 0x01, oscShapes: 43, patchLayout: 1 });
    expect(client.firmware!.voicecards.filter((c) => c.present)).toHaveLength(5);
    expect(client.firmware!.voicecards[0].version).toBe(0x11);
  });

  it('falls back to stock YAM when the version request times out', async () => {
    const { client, clock } = setup();
    const p = client.detect();
    clock.advance(DETECT_TIMEOUT_MS + 1);
    expect(await p).toBe('stock');
    expect(client.firmware).toBeNull();
  });

  it('keeps one request in flight on stock YAM and attributes untagged replies to it', async () => {
    const { client, sent } = setup();
    client.mode = 'stock';
    const a = client.requestProgram(3);
    const b = client.requestPatch(4);
    expect(sent.map((f) => [f.command, f.argument])).toEqual([[0x13, 3]]);
    client.handleSysEx(reply(CMD.PATCH, 0, filled(112, 7)));
    client.handleSysEx(reply(CMD.PART, 0, filled(84, 8)));
    const prog = await a;
    expect(prog.part).toBe(0);
    expect(prog.patch[0]).toBe(7);
    expect(prog.partData[0]).toBe(8);
    expect(sent.map((f) => [f.command, f.argument])).toEqual([
      [0x13, 3],
      [0x11, 4],
    ]);
    client.handleSysEx(reply(CMD.PATCH, 0, filled(112, 9)));
    expect((await b).data[0]).toBe(9);
  });

  it('overlaps part-addressed requests on BAMBI and matches replies by part tag', async () => {
    const { client, sent } = setup();
    client.mode = 'yamplus';
    const a = client.requestPatch(2);
    const b = client.requestPatch(3);
    expect(sent).toHaveLength(2);
    client.handleSysEx(reply(CMD.PATCH, 3, filled(112, 33)));
    client.handleSysEx(reply(CMD.PATCH, 2, filled(112, 22)));
    expect(await a).toMatchObject({ part: 2 });
    expect((await a).data[0]).toBe(22);
    expect((await b).data[0]).toBe(33);
  });

  it('treats a reply for another part as unsolicited instead of misfiling it', async () => {
    const { client, unsolicited } = setup();
    client.mode = 'yamplus';
    const a = client.requestPatch(2);
    client.handleSysEx(reply(CMD.PATCH, 5, filled(112, 55)));
    expect(unsolicited.map((f) => f.argument)).toEqual([5]);
    client.handleSysEx(reply(CMD.PATCH, 2, filled(112, 22)));
    expect((await a).data[0]).toBe(22);
  });

  it('collects a multi dump (multi, then patch + part for parts 1–6)', async () => {
    const { client, sent } = setup();
    client.mode = 'yamplus';
    const p = client.requestMulti();
    expect(sent[0]).toMatchObject({ command: 0x14, argument: 0 });
    client.handleSysEx(reply(CMD.MULTI, 0, filled(56, 1)));
    for (let part = 1; part <= 6; part++) {
      client.handleSysEx(reply(CMD.PATCH, part, filled(112, part * 10)));
      client.handleSysEx(reply(CMD.PART, part, filled(84, part * 10 + 1)));
    }
    const dump = await p;
    expect(dump.multi[0]).toBe(1);
    expect(dump.programs.map((x) => [x.part, x.patch[0], x.partData[0]])).toEqual([
      [1, 10, 11],
      [2, 20, 21],
      [3, 30, 31],
      [4, 40, 41],
      [5, 50, 51],
      [6, 60, 61],
    ]);
  });

  it('times out, rejects, and moves on to the next request', async () => {
    const { client, clock, sent } = setup();
    client.mode = 'stock';
    const a = client.requestPatch(1);
    const b = client.requestPatch(2);
    // The patch timeout is about 1350 ms; stop before b's own timeout runs out.
    clock.advance(1400);
    await expect(a).rejects.toBeInstanceOf(RequestTimeout);
    expect(sent).toHaveLength(2);
    client.handleSysEx(reply(CMD.PATCH, 0, filled(112, 2)));
    expect((await b).data[0]).toBe(2);
  });

  it('reports corrupt frames and ignores non-Ambika SysEx', () => {
    const { client } = setup();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e));
    const bad = reply(CMD.PATCH, 0, [1, 2, 3]);
    bad[bad.length - 2] ^= 1;
    expect(client.handleSysEx(bad)).toBe(false);
    expect(errors[0]).toMatch(/checksum/);
    expect(client.handleSysEx(encodeSysEx(0x02, 0x01, 0, [1]))).toBe(false);
    expect(client.handleSysEx(Uint8Array.from([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]))).toBe(false);
  });

  it('refuses YAM+ requests on stock firmware', async () => {
    const { client } = setup();
    client.mode = 'stock';
    await expect(client.requestName(1, StorageObject.Program)).rejects.toThrow(/BAMBI/);
  });

  it('parses name and location replies', async () => {
    const { client } = setup();
    client.mode = 'yamplus';
    const p = client.requestName(2, StorageObject.Program);
    const name = [...'BRASS PAD       '].map((c) => c.charCodeAt(0));
    client.handleSysEx(reply(CMD.NAME, 2, [2, 0, 7, 0, ...name]));
    expect(await p).toEqual({ part: 2, object: StorageObject.Program, location: { bank: 0, slot: 7 }, status: 0, name: 'BRASS PAD' });
    expect(parseName(1, Uint8Array.from([0, 1, 2, 3, ...name])).location).toEqual({ bank: 1, slot: 2 });
    const words = new Uint8Array(38);
    words[2 * 2] = 5; // part 1 program slot 5
    words[2 * 2 + 1] = 1; // bank B
    words[36] = 9; // multi slot 9
    const loc = parseLocations(words);
    expect(loc.parts[0].program).toEqual({ bank: 1, slot: 5 });
    expect(loc.multi).toEqual({ bank: 0, slot: 9 });
  });
});
