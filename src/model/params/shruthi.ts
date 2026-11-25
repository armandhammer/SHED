// Shruthi-1 (YAM / SHOOZ) parameter map — stub.
//
// Wire facts from BAMBI docs/AUDIT.md §4.1, kept here so the protocol layer
// can already recognise Shruthi traffic:
//   - device id 0x02, Patch = 92 bytes on the wire, name at bytes 68–75;
//   - NRPN: MSB = 0, LSB = patch offset; signed values are range-checked on rx;
//   - OnEdit sends a CC if the parameter has one, otherwise an NRPN.
//
// TODO(shruthi): transcribe `shruthi/parameter.cc` from SHOOZ once that
// firmware is set up, with the per-filter-board pages (SMR4, SSM, 4PM, …).

import type { ParamDef } from './types';

export const SHRUTHI_PATCH_SIZE = 92;
export const SHRUTHI_NAME_OFFSET = 68;
export const SHRUTHI_NAME_LENGTH = 8;

export const SHRUTHI_PARAMS: readonly ParamDef[] = [];

export function shruthiPatchName(patch: Uint8Array): string {
  return String.fromCharCode(...patch.subarray(SHRUTHI_NAME_OFFSET, SHRUTHI_NAME_OFFSET + SHRUTHI_NAME_LENGTH)).trimEnd();
}
