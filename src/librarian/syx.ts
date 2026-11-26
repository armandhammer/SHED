// .syx import/export in the Mutable Instruments format (compatible with the
// Ambika's and the Shruthi's own dumps and the Ixox editor's files).

import { DEVICE_AMBIKA, DEVICE_SHRUTHI, decodeSysEx, isMutableSysEx, splitSysEx, type SysExFrame } from '../midi/framer';
import { MULTI_SIZE, PART_SIZE, PATCH_SIZE } from '../model/params/ambika';
import { SHRUTHI_PATCH_SIZE, shruthiPatchName } from '../model/params/shruthi';
import { CMD, partDump, patchDump } from '../protocol/ambika';
import { SHRUTHI_CMD, acceptsPatch, shruthiPatchDump } from '../protocol/shruthi';

export type EntryKind = 'patch' | 'program';
export type Device = 'ambika' | 'shruthi';

export interface LibraryEntry {
  id?: number;
  name: string;
  kind: EntryKind;
  /** Synth the entry belongs to; entries from before SHED 0.2 have none (Ambika). */
  device?: Device;
  /** Ambika: 112-byte patch. Shruthi: 92-byte wire patch. */
  patch: Uint8Array;
  /** PartData for programs. */
  part?: Uint8Array;
  created: number;
  source?: string;
}

export interface ImportResult {
  entries: LibraryEntry[];
  multis: Uint8Array[];
  skipped: string[];
}

export function entryDevice(entry: LibraryEntry): Device {
  return entry.device ?? 'ambika';
}

/** Printable patch name stored in a Shruthi patch, or '' if it isn't text. */
function shruthiName(patch: Uint8Array): string {
  const name = shruthiPatchName(patch);
  return /^[ -~]+$/.test(name) && name.trim() ? name.trim() : '';
}

/**
 * Parses a .syx file. Ambika: patch (0x01) followed by part (0x05) with the
 * same argument becomes a program; a lone patch stays a patch; multi dumps
 * yield one program per part. Shruthi: each patch (0x01, 92 bytes) becomes a
 * patch named after the name it carries. Other and corrupt messages are
 * reported in `skipped`.
 */
export function importSyx(bytes: Uint8Array, baseName: string, now = Date.now()): ImportResult {
  const frames: SysExFrame[] = [];
  const skipped: string[] = [];
  splitSysEx(bytes).forEach((msg, i) => {
    if (!isMutableSysEx(msg)) {
      skipped.push(`message ${i + 1}: not Mutable Instruments`);
      return;
    }
    try {
      const f = decodeSysEx(msg);
      if (f.device === DEVICE_SHRUTHI) {
        if (f.command !== SHRUTHI_CMD.patch || f.payload.length !== SHRUTHI_PATCH_SIZE) {
          skipped.push(`message ${i + 1}: Shruthi command 0x${f.command.toString(16)} (only patches are stored)`);
        } else if (!acceptsPatch(f.payload, 'shooz')) {
          skipped.push(`message ${i + 1}: Shruthi patch the firmware would refuse (bad format marker)`);
        } else frames.push(f);
      } else if (f.device !== DEVICE_AMBIKA) skipped.push(`message ${i + 1}: not an Ambika or Shruthi dump (device ${f.device})`);
      else frames.push(f);
    } catch (e) {
      skipped.push(`message ${i + 1}: ${(e as Error).message}`);
    }
  });

  const entries: LibraryEntry[] = [];
  const multis: Uint8Array[] = [];
  let count = 0;
  const name = () => (++count === 1 ? baseName : `${baseName} ${count}`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.device === DEVICE_SHRUTHI) {
      const label = shruthiName(f.payload) || name();
      entries.push({ name: label, kind: 'patch', device: 'shruthi', patch: f.payload, created: now, source: baseName });
    } else if (f.command === CMD.MULTI && f.payload.length === MULTI_SIZE) {
      multis.push(f.payload);
    } else if (f.command === CMD.PATCH && f.payload.length === PATCH_SIZE) {
      const next = frames[i + 1];
      const inMulti = f.argument >= 1 && f.argument <= 6;
      const label = inMulti ? `${baseName} p${f.argument}` : name();
      if (next && next.command === CMD.PART && next.argument === f.argument && next.payload.length === PART_SIZE) {
        entries.push({ name: label, kind: 'program', patch: f.payload, part: next.payload, created: now, source: baseName });
        i++;
      } else {
        entries.push({ name: label, kind: 'patch', patch: f.payload, created: now, source: baseName });
      }
    } else if (f.command === CMD.PART) {
      skipped.push('part settings without a patch');
    } else if (f.command === CMD.SEQUENCE) {
      skipped.push('sequence dump (sequencer data is not edited by SHED)');
    } else {
      skipped.push(`command 0x${f.command.toString(16)} with ${f.payload.length} bytes`);
    }
  }
  return { entries, multis, skipped };
}

/** One entry as SysEx, addressed to the active part (argument 0), like a front-panel dump. */
export function exportEntry(entry: LibraryEntry): Uint8Array {
  if (entryDevice(entry) === 'shruthi') return shruthiPatchDump(entry.patch);
  const patch = patchDump(entry.patch, 0);
  if (entry.kind !== 'program' || !entry.part) return patch;
  const part = partDump(entry.part, 0);
  const out = new Uint8Array(patch.length + part.length);
  out.set(patch, 0);
  out.set(part, patch.length);
  return out;
}

export function exportEntries(entries: LibraryEntry[]): Uint8Array {
  const chunks = entries.map(exportEntry);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** File-system-safe name for downloads. */
export function fileName(name: string): string {
  return (name.trim() || 'patch').replace(/[^\w\-. ]+/g, '_') + '.syx';
}
