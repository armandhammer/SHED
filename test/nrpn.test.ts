import { describe, expect, it } from 'vitest';
import { NrpnDecoder, NrpnEncoder, encodeNrpn, type NrpnEvent } from '../src/midi/nrpn';

const msgs = (bytes: Uint8Array) => {
  const out: number[][] = [];
  for (let i = 0; i < bytes.length; i += 3) out.push([...bytes.slice(i, i + 3)]);
  return out;
};

describe('NRPN encoder', () => {
  it('puts address bit 7 in CC99 and value bit 7 in CC6, in firmware order', () => {
    // Address 192 (spread mode), value 200, channel 3.
    expect(msgs(encodeNrpn(2, 192, 200))).toEqual([
      [0xb2, 99, 1],
      [0xb2, 98, 192 & 0x7f],
      [0xb2, 6, 1],
      [0xb2, 38, 200 & 0x7f],
    ]);
  });

  it('encodes a signed value as a two-complement byte', () => {
    expect(msgs(encodeNrpn(0, 2, -24 & 0xff))).toEqual([
      [0xb0, 99, 0],
      [0xb0, 98, 2],
      [0xb0, 6, 1],
      [0xb0, 38, (-24 & 0xff) & 0x7f],
    ]);
  });

  it('uses a running address and refreshes it every 32 values', () => {
    const enc = new NrpnEncoder();
    expect(enc.encode(0, 16, 10).length).toBe(12);
    let withAddress = 0;
    for (let i = 0; i < 64; i++) if (enc.encode(0, 16, i).length === 12) withAddress++;
    expect(withAddress).toBe(2);
    expect(enc.encode(0, 17, 1).length).toBe(12); // address change
    expect(enc.encode(1, 17, 1).length).toBe(12); // other channel has its own cache
    enc.invalidate();
    expect(enc.encode(0, 17, 1).length).toBe(12);
  });
});

describe('NRPN decoder', () => {
  const feed = (dec: NrpnDecoder, bytes: Uint8Array) => {
    const events: NrpnEvent[] = [];
    for (const m of msgs(bytes)) {
      const e = dec.message(m);
      if (e) events.push(e);
    }
    return events;
  };

  it('round-trips every address and value through the encoder', () => {
    const enc = new NrpnEncoder();
    const dec = new NrpnDecoder();
    for (let address = 0; address < 256; address++) {
      for (const value of [0, 1, 63, 64, 127, 128, 200, 255]) {
        const [e] = feed(dec, enc.encode(5, address, value));
        expect(e).toEqual({ kind: 'set', channel: 5, address, value });
      }
    }
  });

  it('accepts value-only messages after the address was latched (firmware OnEdit compression)', () => {
    const dec = new NrpnDecoder();
    feed(dec, encodeNrpn(0, 130, 5));
    expect(feed(dec, encodeNrpn(0, 130, 250, false))).toEqual([{ kind: 'set', channel: 0, address: 130, value: 250 }]);
  });

  it('CC98 consumes the address MSB latch and resets the data MSB', () => {
    const dec = new NrpnDecoder();
    dec.controlChange(0, 99, 1);
    dec.controlChange(0, 98, 0); // address 128
    dec.controlChange(0, 6, 1);
    dec.controlChange(0, 98, 5); // latch consumed: address 5, data MSB reset
    expect(dec.controlChange(0, 38, 3)).toEqual({ kind: 'set', channel: 0, address: 5, value: 3 });
  });

  it('ignores data entry before any address and reports increments', () => {
    const dec = new NrpnDecoder();
    expect(dec.controlChange(0, 38, 3)).toBeNull();
    dec.controlChange(0, 99, 0);
    dec.controlChange(0, 98, 9);
    expect(dec.controlChange(0, 96, 0)).toEqual({ kind: 'step', channel: 0, address: 9, delta: 1 });
    expect(dec.controlChange(0, 97, 0)).toEqual({ kind: 'step', channel: 0, address: 9, delta: -1 });
    expect(dec.message([0x90, 60, 100])).toBeNull();
  });
});
