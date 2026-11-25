import { describe, expect, it } from 'vitest';
import {
  DEVICE_AMBIKA,
  SysExError,
  checksum,
  decodeSysEx,
  encodeSysEx,
  frameLength,
  splitSysEx,
} from '../src/midi/framer';

const HEADER = [0xf0, 0x00, 0x21, 0x02, 0x00, 0x04];

describe('SysEx framer', () => {
  it('encodes a request with an empty payload and a 00 00 checksum (as Ixox sends)', () => {
    expect([...encodeSysEx(DEVICE_AMBIKA, 0x11, 0)]).toEqual([...HEADER, 0x11, 0x00, 0x00, 0x00, 0xf7]);
  });

  it('matches the yamplus_sysex.py name request encoding', () => {
    expect([...encodeSysEx(DEVICE_AMBIKA, 0x16, 1, [2])]).toEqual([...HEADER, 0x16, 1, 0, 2, 0, 2, 0xf7]);
  });

  it('nibble-encodes payload bytes hi then lo, including bit 7', () => {
    const msg = encodeSysEx(DEVICE_AMBIKA, 0x01, 3, [0x00, 0x7f, 0x80, 0xff, 0xa5]);
    expect([...msg.slice(8, 18)]).toEqual([0x0, 0x0, 0x7, 0xf, 0x8, 0x0, 0xf, 0xf, 0xa, 0x5]);
    const ck = (0x7f + 0x80 + 0xff + 0xa5) & 0xff;
    expect([...msg.slice(18, 20)]).toEqual([ck >> 4, ck & 0xf]);
    expect(msg.every((b, i) => i === 0 || i === msg.length - 1 || b < 0x80)).toBe(true);
  });

  it('round-trips every byte value', () => {
    const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
    const frame = decodeSysEx(encodeSysEx(DEVICE_AMBIKA, 0x05, 6, payload));
    expect(frame).toMatchObject({ device: DEVICE_AMBIKA, command: 0x05, argument: 6 });
    expect([...frame.payload]).toEqual([...payload]);
  });

  it('computes the wire length of a patch dump', () => {
    expect(frameLength(112)).toBe(235);
    expect(encodeSysEx(DEVICE_AMBIKA, 1, 0, new Uint8Array(112)).length).toBe(235);
  });

  it('checksum is the low byte of the payload sum', () => {
    expect(checksum([0xff, 0x02])).toBe(0x01);
  });

  it('rejects a corrupted checksum, odd nibbles, invalid nibbles and foreign headers', () => {
    const good = encodeSysEx(DEVICE_AMBIKA, 0x01, 0, [1, 2, 3]);
    const badCk = good.slice();
    badCk[badCk.length - 2] ^= 1;
    expect(() => decodeSysEx(badCk)).toThrow(SysExError);
    const odd = Uint8Array.from([...good.slice(0, -2), 0xf7]);
    expect(() => decodeSysEx(odd)).toThrow(/odd/);
    const badNibble = good.slice();
    badNibble[8] = 0x10;
    expect(() => decodeSysEx(badNibble)).toThrow(/nibble/);
    expect(() => decodeSysEx([0xf0, 0x43, 0x10, 0xf7])).toThrow(/Mutable/);
  });

  it('decodes a PEEK reply whose checksum includes the address bytes', () => {
    // Reply to PEEK: cmd 0x0f, payload = addr lo, addr hi, data…
    const payload = [0x34, 0x12, 0xaa, 0xbb];
    const frame = decodeSysEx(encodeSysEx(DEVICE_AMBIKA, 0x0f, 2, payload));
    expect([...frame.payload]).toEqual(payload);
  });

  it('splits a .syx stream, skipping junk, realtime bytes and interrupted messages', () => {
    const a = encodeSysEx(DEVICE_AMBIKA, 0x01, 0, [1, 2]);
    const b = encodeSysEx(DEVICE_AMBIKA, 0x05, 0, [3]);
    const withClock = [...b.slice(0, 5), 0xf8, ...b.slice(5)];
    const stream = [0x90, 0x40, 0x7f, ...a, 0xf0, 0x00, 0x21, 0x80, ...withClock];
    const out = splitSysEx(stream);
    expect(out.map((m) => [...m])).toEqual([[...a], [...b]]);
  });
});
