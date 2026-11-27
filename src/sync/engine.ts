// Bidirectional sync between the browser model and the Ambika.
//
// Browser → hardware
//   - single edits go out as NRPN on the part's channel, coalesced per
//     parameter (latest value wins) and rate-limited to ~40 Hz per parameter;
//   - a full patch goes out as one SysEx 0x01 (bulk lane), part settings as
//     paced NRPNs (bulk lane).
// Hardware → browser
//   - NRPN edits from the front panel (MIDI out mode ctrl/chain/full) update
//     every part that listens on that channel, except a parameter the browser
//     is dragging or edited in the last 150 ms (echo suppression). The
//     decoder shares one address latch across channels, like the Ambika's
//     sender does;
//   - in full/chain mode the synth also forwards SHED's own messages; those
//     are recognised and dropped (see echo.ts);
//   - dumps (pulled or sent from the front panel) replace the model.

import { NrpnDecoder, NrpnEncoder, type NrpnEvent } from '../midi/nrpn';
import { OutboundScheduler, systemClock, type Clock, type Lane } from '../midi/scheduler';
import {
  NUM_OSC_SHAPES,
  NUM_PARTS,
  PART_BASE,
  PART_SIZE,
  PATCH_SIZE,
  AMBIKA_PARAMS,
  initPart,
  initPatch,
  isNrpnAddress,
  paramAt,
  parseMulti,
  receivesOn,
  txChannel,
  type PartMapping,
} from '../model/params/ambika';
import { clamp, fromByte, toByte, type ParamDef } from '../model/params/types';
import { CMD, patchDump } from '../protocol/ambika';
import { AmbikaClient, type FirmwareMode, type ProgramDump } from '../protocol/client';
import { Emitter } from '../util/emitter';
import { EchoFilter } from './echo';

export const EDIT_INTERVAL_MS = 25; // 40 Hz per parameter
export const ECHO_SUPPRESS_MS = 150;
export const PATCH_PUSH_GAP_MS = 40; // let the controller digest a dump

export type Origin = 'ui' | 'hardware' | 'load';

export interface PartModel {
  patch: Uint8Array;
  part: Uint8Array;
  /** True once the data came from the synth (or was pushed to it). */
  synced: boolean;
}

interface EngineEvents {
  /** One byte changed (address 0–195) on part index 0–5. */
  param: { part: number; address: number; byte: number; origin: Origin };
  /** A whole part was replaced. */
  part: { part: number; origin: Origin };
  mappings: PartMapping[];
  firmware: FirmwareMode;
  log: { level: 'info' | 'warn' | 'error'; text: string };
  /** The synth sent an edit (proves MIDI out mode ≥ ctrl). */
  hardwareEdit: { part: number; address: number };
  busy: boolean;
}

export interface MidiPort {
  send(bytes: Uint8Array): boolean;
}

export class SyncEngine extends Emitter<EngineEvents> {
  readonly parts: PartModel[] = [];
  mappings: PartMapping[];
  mappingsKnown = false;
  readonly scheduler: OutboundScheduler;
  readonly client: AmbikaClient;
  private readonly encoder = new NrpnEncoder();
  private readonly decoder = new NrpnDecoder({ sharedAddress: true });
  private readonly echo: EchoFilter;
  private readonly lastLocalEdit = new Map<string, number>();
  private readonly dragging = new Set<string>();
  /** Multi dump being received unsolicited (front-panel send). */
  private unsolicitedMulti = false;
  hardwareEditsSeen = false;

  constructor(
    private readonly port: MidiPort,
    private readonly clock: Clock = systemClock,
    /** Part (0–5) shown in the UI; untagged unsolicited dumps go there. */
    public selectedPart = 0,
  ) {
    super();
    for (let i = 0; i < NUM_PARTS; i++) this.parts.push({ patch: initPatch(), part: initPart(), synced: false });
    // Until a multi dump says otherwise, assume part n listens on channel n.
    this.mappings = Array.from({ length: NUM_PARTS }, (_, i) => ({ channel: i + 1, keyLow: 0, keyHigh: 127, voices: 0 }));
    this.echo = new EchoFilter(clock, () =>
      this.log('info', 'The Ambika forwards what SHED sends (outp mode full or chain); SHED ignores those echoes.'),
    );
    this.scheduler = new OutboundScheduler((bytes) => {
      this.port.send(bytes);
      this.echo.record(bytes);
    }, { clock });
    this.client = new AmbikaClient(
      {
        send: (bytes: Uint8Array, lane: Lane, onSent: () => void) =>
          this.scheduler.enqueue({ lane, build: () => bytes, onSent }),
      },
      clock,
    );
    this.client.on('unsolicited', (f) => this.onUnsolicited(f.command, f.argument, f.payload));
    this.client.on('error', (text) => this.log('warn', text));
  }

  /** True once the synth was seen echoing SHED's own messages (outp mode full/chain). */
  get echoing(): boolean {
    return this.echo.active;
  }

  get firmware(): FirmwareMode {
    return this.client.mode;
  }

  /** True if the parameter exists on the connected firmware. */
  supports(def: ParamDef): boolean {
    return !def.since || this.client.mode !== 'stock';
  }

  /**
   * Highest value the connected firmware accepts for `def`: the oscillator
   * shape count from the version reply, and `valuesSince` gates (newer BAMBI
   * enum values). Permissive until the firmware is known.
   */
  valueMax(def: ParamDef): number {
    if (def.id.endsWith('.shape') && def.group.startsWith('osc')) return this.oscShapeMax;
    const gate = def.valuesSince;
    if (gate) {
      const mode = this.client.mode;
      const version = this.client.firmware?.yamPlusVersion ?? 0;
      if (mode === 'stock' || (mode === 'yamplus' && version < gate.yamPlus)) return gate.from - 1;
    }
    return def.max;
  }

  /** Highest selectable oscillator shape (from the BAMBI version reply, else all 43). */
  get oscShapeMax(): number {
    const n = this.client.firmware?.oscShapes;
    return (n && n <= NUM_OSC_SHAPES ? n : NUM_OSC_SHAPES) - 1;
  }

  // -------------------------------------------------------------------------
  // Model access.

  byte(part: number, address: number): number {
    const m = this.parts[part];
    return address < PART_BASE ? m.patch[address] : m.part[address - PART_BASE];
  }

  value(part: number, def: ParamDef): number {
    return fromByte(def, this.byte(part, def.address));
  }

  private writeByte(part: number, address: number, byte: number): boolean {
    const m = this.parts[part];
    const arr = address < PART_BASE ? m.patch : m.part;
    const i = address < PART_BASE ? address : address - PART_BASE;
    if (arr[i] === byte) return false;
    arr[i] = byte;
    return true;
  }

  /** Parts whose hardware state an NRPN on `channel` changes. */
  partsOnChannel(channel: number): number[] {
    const out: number[] = [];
    this.mappings.forEach((m, i) => receivesOn(m, channel) && out.push(i));
    return out;
  }

  /** Other parts that share the selected part's channel (an edit hits them too). */
  channelSiblings(part: number): number[] {
    return this.partsOnChannel(txChannel(this.mappings[part])).filter((p) => p !== part);
  }

  // -------------------------------------------------------------------------
  // Browser → hardware.

  /** Sets a parameter from the UI (display value) and sends it as NRPN. */
  set(part: number, def: ParamDef, value: number): void {
    const v = Math.min(clamp(def, value), this.valueMax(def));
    this.setByte(part, def.address, toByte(def, v));
  }

  setByte(part: number, address: number, byte: number): void {
    const channel = txChannel(this.mappings[part]);
    const key = `${part}:${address}`;
    this.lastLocalEdit.set(key, this.clock.now());
    // The synth applies the NRPN to every part on that channel: mirror it.
    for (const p of this.partsOnChannel(channel).concat(part)) {
      if (this.writeByte(p, address, byte) || p === part) {
        this.emit('param', { part: p, address, byte, origin: 'ui' });
      }
    }
    if (!isNrpnAddress(address)) return;
    this.scheduler.enqueue({
      lane: 'realtime',
      key: `nrpn:${channel}:${address}`,
      minIntervalMs: EDIT_INTERVAL_MS,
      // Built at send time: carries the latest value and the right running address.
      build: () => this.encoder.encode(channel, address, this.byte(part, address)),
    });
  }

  beginDrag(part: number, address: number): void {
    this.dragging.add(`${part}:${address}`);
  }

  endDrag(part: number, address: number): void {
    const key = `${part}:${address}`;
    this.dragging.delete(key);
    this.lastLocalEdit.set(key, this.clock.now());
  }

  /** Sends the whole patch of a part as SysEx 0x01 (bulk lane). */
  pushPatch(part: number): void {
    this.scheduler.enqueue({
      lane: 'bulk',
      key: `patch:${part}`,
      gapAfterMs: PATCH_PUSH_GAP_MS,
      build: () => patchDump(this.parts[part].patch, part + 1),
    });
  }

  /** Sends the part settings (volume, tuning, voice mode, arp…) as paced NRPNs. */
  pushPartSettings(part: number): void {
    const channel = txChannel(this.mappings[part]);
    for (const def of AMBIKA_PARAMS) {
      if (def.level !== 'part' || !this.supports(def)) continue;
      this.scheduler.enqueue({
        lane: 'bulk',
        key: `partnrpn:${channel}:${def.address}`,
        build: () => this.encoder.encode(channel, def.address, this.byte(part, def.address)),
      });
    }
  }

  /** Replaces a part's data locally (librarian load) and pushes it. */
  loadPart(part: number, patch: Uint8Array, partData?: Uint8Array): void {
    if (patch.length !== PATCH_SIZE) throw new Error('bad patch size');
    this.parts[part].patch.set(patch);
    if (partData) {
      if (partData.length !== PART_SIZE) throw new Error('bad part size');
      // Keep the hardware's sequencer data: only the settings travel as NRPN.
      this.parts[part].part.set(partData.subarray(0, 16), 0);
      this.parts[part].part[80] = partData[80];
      // A part saved from newer BAMBI firmware: values this synth lacks
      // (e.g. 3x unison on stock YAM) become its highest one, as the
      // firmware would clamp the NRPN anyway.
      for (const def of AMBIKA_PARAMS) {
        if (def.level !== 'part' || !def.valuesSince) continue;
        const i = def.address - PART_BASE;
        this.parts[part].part[i] = Math.min(this.parts[part].part[i], this.valueMax(def));
      }
    }
    this.emit('part', { part, origin: 'load' });
    this.pushPatch(part);
    if (partData) this.pushPartSettings(part);
  }

  // -------------------------------------------------------------------------
  // Hardware → browser.

  /** Feed every incoming MIDI message. */
  handleMidi(data: Uint8Array): void {
    if (this.echo.isEcho(data)) return;
    if (data[0] === 0xf0) {
      this.client.handleSysEx(data);
      return;
    }
    if ((data[0] & 0xf0) === 0xb0) {
      const ev = this.decoder.message(data);
      if (ev) this.onNrpn(ev);
    }
  }

  private suppressed(part: number, address: number): boolean {
    const key = `${part}:${address}`;
    if (this.dragging.has(key)) return true;
    const t = this.lastLocalEdit.get(key);
    return t !== undefined && this.clock.now() - t < ECHO_SUPPRESS_MS;
  }

  private onNrpn(ev: NrpnEvent): void {
    const def = paramAt(ev.address);
    if (!def && !isNrpnAddress(ev.address)) return;
    for (const part of this.partsOnChannel(ev.channel)) {
      if (this.suppressed(part, ev.address)) continue;
      let byte: number;
      if (ev.kind === 'set') {
        byte = def ? toByte(def, fromByte(def, ev.value)) : ev.value;
      } else {
        if (!def) continue;
        const cur = fromByte(def, this.byte(part, ev.address));
        byte = toByte(def, cur + (ev.delta === 1 ? 1 : -1));
      }
      this.hardwareEditsSeen = true;
      this.emit('hardwareEdit', { part, address: ev.address });
      if (this.writeByte(part, ev.address, byte)) {
        this.emit('param', { part, address: ev.address, byte, origin: 'hardware' });
      }
    }
  }

  private applyProgram(part: number, patch?: Uint8Array, partData?: Uint8Array): void {
    const m = this.parts[part];
    if (patch && patch.length === PATCH_SIZE) m.patch.set(patch);
    if (partData && partData.length === PART_SIZE) m.part.set(partData);
    m.synced = true;
    this.emit('part', { part, origin: 'hardware' });
  }

  private applyMulti(multi: Uint8Array): void {
    this.mappings = parseMulti(multi).parts;
    this.mappingsKnown = true;
    this.encoder.invalidate();
    this.emit('mappings', this.mappings);
  }

  private onUnsolicited(command: number, argument: number, payload: Uint8Array): void {
    // Tagged (1–6): BAMBI single dumps and multi dumps on any firmware.
    // Untagged (0): stock YAM single dump, e.g. sent from the front panel.
    const part = argument >= 1 && argument <= NUM_PARTS ? argument - 1 : this.selectedPart;
    switch (command) {
      case CMD.MULTI:
        this.unsolicitedMulti = true;
        this.applyMulti(payload);
        this.log('info', 'Multi received from the synth');
        break;
      case CMD.PATCH:
        this.applyProgram(part, payload);
        if (!this.unsolicitedMulti) this.log('info', `Patch received for part ${part + 1}`);
        break;
      case CMD.PART:
        this.applyProgram(part, undefined, payload);
        if (argument === NUM_PARTS) this.unsolicitedMulti = false;
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Pull.

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.emit('busy', true);
    try {
      return await fn();
    } finally {
      this.emit('busy', this.client.busy);
    }
  }

  /** Version probe; reports BAMBI or stock YAM. */
  async detect(): Promise<FirmwareMode> {
    const mode = await this.withBusy(() => this.client.detect());
    this.emit('firmware', mode);
    return mode;
  }

  async pullPart(part: number): Promise<void> {
    await this.withBusy(async () => {
      const dump: ProgramDump = await this.client.requestProgram(part + 1);
      if (dump.part && dump.part !== part + 1) {
        this.log('warn', `asked for part ${part + 1}, synth answered for part ${dump.part}`);
      }
      this.applyProgram(dump.part ? dump.part - 1 : part, dump.patch, dump.partData);
    });
  }

  async pullAll(): Promise<void> {
    await this.withBusy(async () => {
      const dump = await this.client.requestMulti();
      this.applyMulti(dump.multi);
      dump.programs.forEach((p, i) => this.applyProgram(i, p.patch, p.partData));
    });
  }

  /** Port changed: forget receiver state and pending requests. */
  resetLink(): void {
    this.encoder.invalidate();
    this.decoder.reset();
    this.echo.reset();
    this.scheduler.clear();
    this.client.reset();
    this.hardwareEditsSeen = false;
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit('log', { level, text });
  }
}

