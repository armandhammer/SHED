import { describe, expect, it } from 'vitest';
import { encodeNrpn } from '../src/midi/nrpn';
import { versionRequest } from '../src/protocol/ambika';
import { ECHO_WINDOW_MS, EchoFilter, splitMessages } from '../src/sync/echo';
import { FakeClock } from './fake-clock';

describe('EchoFilter', () => {
  it('splits concatenated output into single messages', () => {
    const sx = versionRequest();
    const parts = splitMessages(Uint8Array.from([...encodeNrpn(2, 130, 5), ...sx, 0xc0, 3]));
    expect(parts.map((m) => [...m])).toEqual([
      [0xb2, 99, 1], [0xb2, 98, 2], [0xb2, 6, 0], [0xb2, 38, 5],
      [...sx],
      [0xc0, 3],
    ]);
  });

  it('stays off until a SysEx echo proves the synth forwards its input', () => {
    const clock = new FakeClock();
    let detected = 0;
    const f = new EchoFilter(clock, () => detected++);
    const nrpn = encodeNrpn(0, 16, 40);
    f.record(nrpn);
    // ctrl mode: an identical CC from the synth is a real edit.
    expect(f.isEcho(nrpn.subarray(0, 3))).toBe(false);
    f.record(versionRequest());
    expect(f.isEcho(versionRequest())).toBe(true);
    expect(f.active).toBe(true);
    expect(detected).toBe(1);
    // Now CC echoes are dropped, once each.
    const next = encodeNrpn(0, 17, 3, false);
    f.record(next);
    expect(f.isEcho(next.subarray(0, 3))).toBe(true);
    expect(f.isEcho(next.subarray(3, 6))).toBe(true);
    expect(f.isEcho(next.subarray(3, 6))).toBe(false);
  });

  it('forgets what it sent after the window and on reset', () => {
    const clock = new FakeClock();
    const f = new EchoFilter(clock);
    f.record(versionRequest());
    clock.advance(ECHO_WINDOW_MS + 1);
    expect(f.isEcho(versionRequest())).toBe(false);
    f.record(versionRequest());
    f.reset();
    expect(f.isEcho(versionRequest())).toBe(false);
    expect(f.active).toBe(false);
  });
});
