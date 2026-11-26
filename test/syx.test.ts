import { describe, expect, it } from 'vitest';
import { DEVICE_AMBIKA, DEVICE_SHRUTHI, decodeSysEx, encodeSysEx, splitSysEx } from '../src/midi/framer';
import { initPart, initPatch } from '../src/model/params/ambika';
import { CMD } from '../src/protocol/ambika';
import { shruthiInitPatch } from '../src/model/params/shruthi';
import { exportEntries, exportEntry, fileName, importSyx, type LibraryEntry } from '../src/librarian/syx';

const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

describe('.syx librarian format', () => {
  it('exports a patch as one 0x01 message for the active part', () => {
    const entry: LibraryEntry = { name: 'Pad', kind: 'patch', patch: initPatch(), created: 0 };
    const msgs = splitSysEx(exportEntry(entry)).map((m) => decodeSysEx(m));
    expect(msgs.map((m) => [m.command, m.argument, m.payload.length])).toEqual([[0x01, 0, 112]]);
  });

  it('exports a program as patch then part and imports it back', () => {
    const patch = initPatch();
    patch[16] = 42;
    const part = initPart();
    part[0] = 99;
    const bytes = exportEntry({ name: 'Lead', kind: 'program', patch, part, created: 0 });
    const { entries, skipped } = importSyx(bytes, 'Lead', 5);
    expect(skipped).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Lead', kind: 'program', created: 5 });
    expect(entries[0].patch[16]).toBe(42);
    expect(entries[0].part![0]).toBe(99);
  });

  it('imports a whole bank and names entries after the file', () => {
    const e = (v: number): LibraryEntry => {
      const p = initPatch();
      p[0] = v;
      return { name: String(v), kind: 'patch', patch: p, created: 0 };
    };
    const { entries } = importSyx(exportEntries([e(1), e(2), e(3)]), 'bank');
    expect(entries.map((x) => [x.name, x.patch[0]])).toEqual([
      ['bank', 1],
      ['bank 2', 2],
      ['bank 3', 3],
    ]);
  });

  it('splits a multi dump into one program per part', () => {
    const msgs = [encodeSysEx(DEVICE_AMBIKA, CMD.MULTI, 0, new Uint8Array(56))];
    for (let p = 1; p <= 6; p++) {
      msgs.push(encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, p, new Uint8Array(112).fill(p)));
      msgs.push(encodeSysEx(DEVICE_AMBIKA, CMD.PART, p, new Uint8Array(84).fill(p)));
    }
    const { entries, multis } = importSyx(concat(...msgs), 'live');
    expect(multis).toHaveLength(1);
    expect(entries.map((x) => [x.name, x.kind, x.patch[0]])).toEqual([1, 2, 3, 4, 5, 6].map((p) => [`live p${p}`, 'program', p]));
  });

  it('skips corrupt, foreign and non-patch messages with a reason', () => {
    const bad = encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, 0, initPatch());
    bad[20] ^= 1;
    const shruthi = encodeSysEx(DEVICE_SHRUTHI, 0x01, 0, new Uint8Array(92));
    const seq = encodeSysEx(DEVICE_AMBIKA, CMD.SEQUENCE, 0, new Uint8Array(72));
    const roland = Uint8Array.from([0xf0, 0x41, 0x10, 0x42, 0xf7]);
    const { entries, skipped } = importSyx(concat(bad, shruthi, seq, roland), 'mixed');
    expect(entries).toEqual([]);
    expect(skipped).toHaveLength(4);
    // Framing problems are reported per message as they are read; content
    // problems (like a sequence dump) after the whole file has been grouped.
    expect(skipped[0]).toMatch(/message 1: .*checksum/);
    expect(skipped[1]).toMatch(/message 2: Shruthi patch .*refuse/);
    expect(skipped[2]).toMatch(/message 4: not Mutable/);
    expect(skipped[3]).toMatch(/^sequence dump/);
  });

  it('round-trips Shruthi patches, named after the name they carry', () => {
    const a = shruthiInitPatch();
    a.set([...'Fat Bass'].map((c) => c.charCodeAt(0)), 68);
    const b = shruthiInitPatch();
    b.fill(0, 68, 76); // no printable name: falls back to the file name
    const bytes = exportEntries([
      { name: 'x', kind: 'patch', device: 'shruthi', patch: a, created: 0 },
      { name: 'y', kind: 'patch', device: 'shruthi', patch: b, created: 0 },
    ]);
    expect(splitSysEx(bytes).map((m) => decodeSysEx(m)).map((f) => [f.device, f.command, f.payload.length])).toEqual([
      [DEVICE_SHRUTHI, 1, 92],
      [DEVICE_SHRUTHI, 1, 92],
    ]);
    const { entries, skipped } = importSyx(bytes, 'shruthi-bank');
    expect(skipped).toEqual([]);
    expect(entries.map((e) => [e.name, e.device, e.kind])).toEqual([
      ['Fat Bass', 'shruthi', 'patch'],
      ['shruthi-bank', 'shruthi', 'patch'],
    ]);
    expect(entries[0].patch).toEqual(a);
  });

  it('keeps Ambika and Shruthi entries apart in a mixed file', () => {
    const bytes = concat(
      encodeSysEx(DEVICE_AMBIKA, CMD.PATCH, 0, initPatch()),
      encodeSysEx(DEVICE_SHRUTHI, 0x01, 0, shruthiInitPatch()),
      encodeSysEx(DEVICE_SHRUTHI, 0x02, 0, new Uint8Array(32)),
    );
    const { entries, skipped } = importSyx(bytes, 'mix');
    expect(entries.map((e) => e.device ?? 'ambika')).toEqual(['ambika', 'shruthi']);
    expect(skipped).toEqual(['message 3: Shruthi command 0x2 (only patches are stored)']);
  });

  it('makes safe download names', () => {
    expect(fileName('Brass/Pad: 1')).toBe('Brass_Pad_ 1.syx');
    expect(fileName('  ')).toBe('patch.syx');
  });
});
