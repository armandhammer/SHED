// Ambika SysEx command set (YAM `controller/storage.cc`) plus the BAMBI
// (YAM+) additions from YAMPLUS.md.

import { DEVICE_AMBIKA, encodeSysEx, frameLength } from '../midi/framer';
import { MULTI_SIZE, NUM_PARTS, PART_SIZE, PATCH_SIZE, SEQUENCE_SIZE } from '../model/params/ambika';

export const CMD = {
  PATCH: 0x01,
  SEQUENCE: 0x02,
  PROGRAM: 0x03,
  MULTI: 0x04,
  PART: 0x05,
  NAME: 0x06, // YAM+ reply
  LOCATIONS: 0x0a, // YAM+ reply
  VERSION: 0x0c, // YAM+ reply
  POKE: 0x0f,
  REQUEST: 0x10, // + object command
  REQUEST_NAME: 0x16, // YAM+
  REQUEST_LOCATIONS: 0x1a, // YAM+
  REQUEST_VERSION: 0x1c, // YAM+
  PEEK: 0x1f,
} as const;

/** `StorageObject` in the firmware; dump command = object + 1, request = object + 0x11. */
export enum StorageObject {
  Patch = 0,
  Sequence = 1,
  Program = 2,
  Multi = 3,
  Part = 4,
}

export const OBJECT_NAMES: Record<StorageObject, string> = {
  [StorageObject.Patch]: 'patch',
  [StorageObject.Sequence]: 'sequence',
  [StorageObject.Program]: 'program',
  [StorageObject.Multi]: 'multi',
  [StorageObject.Part]: 'part',
};

export function objectSize(object: StorageObject): number {
  switch (object) {
    case StorageObject.Patch:
      return PATCH_SIZE;
    case StorageObject.Sequence:
      return SEQUENCE_SIZE;
    case StorageObject.Multi:
      return MULTI_SIZE;
    case StorageObject.Part:
      return PART_SIZE;
    case StorageObject.Program:
      return PATCH_SIZE + PART_SIZE;
  }
}

/** Expected wire size of the reply(ies) to a dump request, for timeouts. */
export function replyWireBytes(object: StorageObject): number {
  switch (object) {
    case StorageObject.Program:
      return frameLength(PATCH_SIZE) + frameLength(PART_SIZE);
    case StorageObject.Multi:
      return frameLength(MULTI_SIZE) + NUM_PARTS * (frameLength(PATCH_SIZE) + frameLength(PART_SIZE));
    default:
      return frameLength(objectSize(object));
  }
}

const sx = (cmd: number, arg = 0, payload: ArrayLike<number> = []) => encodeSysEx(DEVICE_AMBIKA, cmd, arg, payload);

/** Part argument on the wire: 0 = active part, 1–6 = part n. */
export type PartArg = number;

export function dumpRequest(object: StorageObject, part: PartArg = 0): Uint8Array {
  return sx(CMD.REQUEST + object + 1, part);
}

export function patchDump(data: ArrayLike<number>, part: PartArg = 0): Uint8Array {
  if (data.length !== PATCH_SIZE) throw new Error(`patch must be ${PATCH_SIZE} bytes`);
  return sx(CMD.PATCH, part, data);
}

export function partDump(data: ArrayLike<number>, part: PartArg = 0): Uint8Array {
  if (data.length !== PART_SIZE) throw new Error(`part must be ${PART_SIZE} bytes`);
  return sx(CMD.PART, part, data);
}

export function multiDump(data: ArrayLike<number>): Uint8Array {
  if (data.length !== MULTI_SIZE) throw new Error(`multi must be ${MULTI_SIZE} bytes`);
  return sx(CMD.MULTI, 0, data);
}

export function versionRequest(): Uint8Array {
  return sx(CMD.REQUEST_VERSION);
}

export function locationsRequest(): Uint8Array {
  return sx(CMD.REQUEST_LOCATIONS);
}

export function nameRequest(part: PartArg, object: StorageObject): Uint8Array {
  return sx(CMD.REQUEST_NAME, part, [object]);
}

// ---------------------------------------------------------------------------
// Replies.

export interface VoicecardInfo {
  port: number; // 1–6
  present: boolean;
  slaveId: number;
  version: number; // 0x11 = v1.1
}

export interface FirmwareInfo {
  family: 'yamplus' | 'unknown';
  familyId: number;
  controllerVersion: number;
  yamPlusVersion: number; // major << 4 | minor
  oscShapes: number;
  patchLayout: number;
  partLayout: number;
  voicecards: VoicecardInfo[];
}

export function versionString(v: number): string {
  return `${v >> 4}.${v & 0x0f}`;
}

export function parseVersion(payload: Uint8Array): FirmwareInfo {
  if (payload.length < 6) throw new Error('short version reply');
  const voicecards: VoicecardInfo[] = [];
  for (let port = 0; port < NUM_PARTS; port++) {
    const slaveId = payload[6 + 2 * port] ?? 0xff;
    const version = payload[7 + 2 * port] ?? 0;
    voicecards.push({ port: port + 1, slaveId, version, present: slaveId > 0 && slaveId < 0xff });
  }
  return {
    family: payload[0] === 1 ? 'yamplus' : 'unknown',
    familyId: payload[0],
    controllerVersion: payload[1],
    yamPlusVersion: payload[2],
    oscShapes: payload[3],
    patchLayout: payload[4],
    partLayout: payload[5],
    voicecards,
  };
}

export interface Location {
  bank: number; // 0 = A
  slot: number;
}

export function formatLocation(l: Location): string {
  return `${String.fromCharCode(65 + l.bank)}-${String(l.slot).padStart(3, '0')}`;
}

export interface Locations {
  parts: { patch: Location; sequence: Location; program: Location }[];
  multi: Location;
}

export function parseLocations(payload: Uint8Array): Locations {
  if (payload.length < 38) throw new Error('short locations reply');
  const word = (i: number): Location => ({ bank: payload[2 * i + 1], slot: payload[2 * i] });
  const parts = [];
  for (let p = 0; p < NUM_PARTS; p++) {
    parts.push({ patch: word(p * 3), sequence: word(p * 3 + 1), program: word(p * 3 + 2) });
  }
  return { parts, multi: word(18) };
}

export const FS_STATUS = [
  'ok', 'not ready', 'error', 'no file', 'no path', 'bad name',
  'denied', 'exists', 'eof', 'bad format', 'copy error', 'timeout',
];

export interface NameReply {
  part: number; // 1–6, 0 for the multi
  object: StorageObject;
  location: Location;
  status: number;
  name: string;
}

export function parseName(argument: number, payload: Uint8Array): NameReply {
  if (payload.length < 20) throw new Error('short name reply');
  return {
    part: argument,
    object: payload[0] as StorageObject,
    location: { bank: payload[1], slot: payload[2] },
    status: payload[3],
    name: String.fromCharCode(...payload.subarray(4, 20)).trimEnd(),
  };
}
