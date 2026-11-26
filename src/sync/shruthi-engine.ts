// Bidirectional sync between the browser model and a Shruthi-1 (stock YAM or
// SHOOZ). The counterpart of `engine.ts` for a single-part synth.
//
// The model is the firmware's whole parameter address space (159 bytes:
// patch RAM, sequencer settings, system settings, SHOOZ curves), so a
// parameter's byte offset is both its model index and its NRPN number.
//
// Browser → hardware
//   - edits go out as NRPN (always with the address: the Shruthi resets its
//     data-entry latch on every CC98/99, and its own sender never uses a
//     running address either) on the Shruthi's channel, coalesced and
//     rate-limited per parameter like the Ambika's;
//   - a whole patch goes out as SysEx 0x01 (bulk lane). SHOOZ curves are
//     packed only for SHOOZ: stock YAM refuses '&' patches.
// Hardware → browser
//   - front-panel edits (MIDI out ctrl/full/chain) arrive as a CC when the
//     parameter has one, NRPN otherwise (`MidiDispatcher::OnEdit`);
//   - in thru/full/chain mode the Shruthi also returns SHED's own messages:
//     those are dropped by the echo filter;
//   - a patch dump sent from the front panel replaces the patch.

import { NrpnDecoder, encodeNrpn } from '../midi/nrpn';
import { OutboundScheduler, systemClock, type Clock } from '../midi/scheduler';
import type { SysExFrame } from '../midi/framer';
import {
  SHRUTHI_ADDRESS_SPACE,
  SHRUTHI_OFFSET,
  SHRUTHI_PATCH_SIZE,
  SHRUTHI_SYSTEM_SIZE,
  FILTER_BOARDS,
  ccParam,
  nrpnParam,
  shruthiFromByte,
  shruthiInitPatch,
  shruthiInitSequencer,
  shruthiInitSystem,
  shruthiScale,
  type FilterBoard,
  type ShruthiParam,
} from '../model/params/shruthi';
import {
  SHRUTHI_CMD,
  acceptsPatch,
  applyWirePatch,
  shruthiPatchDump,
  shruthiWriteRequest,
  wirePatchFromSpace,
} from '../protocol/shruthi';
import { ShruthiClient, type ShruthiMode } from '../protocol/shruthi-client';
import { Emitter } from '../util/emitter';
import { EchoFilter } from './echo';
import type { MidiPort, Origin } from './engine';
import { ECHO_SUPPRESS_MS, EDIT_INTERVAL_MS, PATCH_PUSH_GAP_MS } from './engine';

const SYS = SHRUTHI_OFFSET.system;
export const SHRUTHI_SYS = {
  midiChannel: SYS + 5,
  midiOut: SYS + 6,
  filterBoard: SYS + 9,
} as const;

interface ShruthiEngineEvents {
  /** One byte of the address space changed. */
  param: { address: number; byte: number; origin: Origin };
  /** The patch (and possibly system settings) was replaced. */
  patch: { origin: Origin };
  mode: ShruthiMode;
  log: { level: 'info' | 'warn' | 'error'; text: string };
  /** The synth sent an edit (proves MIDI out mode ctrl/full/chain). */
  hardwareEdit: { address: number };
  busy: boolean;
}

export class ShruthiEngine extends Emitter<ShruthiEngineEvents> {
  readonly mem = new Uint8Array(SHRUTHI_ADDRESS_SPACE);
  /** True once the patch came from the synth (or was pushed to it). */
  synced = false;
  /** True once the system settings (channel, board) came from the synth. */
  systemKnown = false;
  hardwareEditsSeen = false;
  readonly scheduler: OutboundScheduler;
  readonly client: ShruthiClient;
  private readonly decoder = new NrpnDecoder();
  private readonly echo: EchoFilter;
  private readonly lastLocalEdit = new Map<number, number>();
  private readonly dragging = new Set<number>();

  constructor(
    private readonly port: MidiPort,
    private readonly clock: Clock = systemClock,
  ) {
    super();
    this.mem.set(shruthiInitSequencer(), SHRUTHI_OFFSET.sequencer);
    this.mem.set(shruthiInitSystem(), SYS);
    applyWirePatch(this.mem, shruthiInitPatch(), 'shooz');
    this.echo = new EchoFilter(clock, () =>
      this.log('info', 'The Shruthi returns what SHED sends (MIDI out thru, full or chain); SHED ignores those echoes.'),
    );
    this.scheduler = new OutboundScheduler((bytes) => {
      this.port.send(bytes);
      this.echo.record(bytes);
    }, { clock });
    this.client = new ShruthiClient({ send: (bytes) => this.scheduler.enqueue({ lane: 'request', build: () => bytes }) }, clock);
    this.client.on('unsolicited', (f) => this.onUnsolicited(f));
    this.client.on('error', (text) => this.log('warn', text));
  }

  get mode(): ShruthiMode {
    return this.client.mode;
  }

  get echoing(): boolean {
    return this.echo.active;
  }

  /** Firmware family for packing patches: unknown counts as stock (the safe format). */
  get family(): 'stock' | 'shooz' {
    return this.client.mode === 'shooz' ? 'shooz' : 'stock';
  }

  /** True if the parameter exists on the connected firmware. */
  supports(p: ShruthiParam): boolean {
    return !p.since || this.client.mode !== 'stock';
  }

  /** The filter board the firmware is set to (`sys.filterBoard`). */
  get board(): FilterBoard {
    return FILTER_BOARDS[this.mem[SHRUTHI_SYS.filterBoard]] ?? 'lpf';
  }

  /** MIDI channel index (0–15) SHED talks on: the Shruthi's channel, omni → 1. */
  get txChannel(): number {
    const c = this.mem[SHRUTHI_SYS.midiChannel];
    return c === 0 ? 0 : (c - 1) & 0x0f;
  }

  listensOn(channel: number): boolean {
    const c = this.mem[SHRUTHI_SYS.midiChannel];
    return c === 0 || c === channel + 1;
  }

  byte(address: number): number {
    return this.mem[address];
  }

  value(p: ShruthiParam): number {
    return shruthiFromByte(p, this.mem[p.address]);
  }

  /** Patch name (8 characters, trailing spaces trimmed). */
  get name(): string {
    return String.fromCharCode(...this.mem.subarray(68, 76)).trimEnd();
  }

  /** The current patch as a 92-byte wire patch for this firmware. */
  wirePatch(): Uint8Array {
    return wirePatchFromSpace(this.mem, this.family);
  }

  // -------------------------------------------------------------------------
  // Browser → hardware.

  /** Sets a parameter from the UI (display value) and sends it as NRPN. */
  set(p: ShruthiParam, value: number): void {
    if (p.uiOnly) return;
    const v = Math.min(p.max, Math.max(p.min, Math.round(value)));
    this.setByte(p.address, v & 0xff);
  }

  setByte(address: number, byte: number): void {
    this.lastLocalEdit.set(address, this.clock.now());
    const channel = this.txChannel;
    if (this.mem[address] !== byte) {
      this.mem[address] = byte;
      this.emit('param', { address, byte, origin: 'ui' });
    }
    // Changing the Shruthi's channel: the NRPN goes out on the old one.
    this.scheduler.enqueue({
      lane: 'realtime',
      key: `nrpn:${address}`,
      minIntervalMs: EDIT_INTERVAL_MS,
      build: () => encodeNrpn(channel, address, this.mem[address]),
    });
  }

  beginDrag(address: number): void {
    this.dragging.add(address);
  }

  endDrag(address: number): void {
    this.dragging.delete(address);
    this.lastLocalEdit.set(address, this.clock.now());
  }

  /** Sends the whole patch as SysEx 0x01 to the edit buffer. */
  pushPatch(): void {
    this.scheduler.enqueue({
      lane: 'bulk',
      key: 'patch',
      gapAfterMs: PATCH_PUSH_GAP_MS,
      build: () => shruthiPatchDump(this.wirePatch()),
    });
    this.synced = true;
  }

  /**
   * Replaces the patch (librarian load) and pushes it. Returns false, and
   * changes nothing, for a patch the connected firmware would refuse.
   */
  loadPatch(wire: Uint8Array): boolean {
    if (wire.length !== SHRUTHI_PATCH_SIZE) throw new Error('bad patch size');
    if (!acceptsPatch(wire, 'shooz')) return false;
    applyWirePatch(this.mem, wire, this.family);
    this.emit('patch', { origin: 'load' });
    this.pushPatch();
    return true;
  }

  /** Stores the edit buffer in a slot (0-based) on the synth. */
  writeSlot(slot: number): void {
    this.scheduler.enqueue({ lane: 'bulk', build: () => shruthiWriteRequest(SHRUTHI_CMD.writePatch, slot), gapAfterMs: PATCH_PUSH_GAP_MS });
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
    if ((data[0] & 0xf0) !== 0xb0 || data.length < 3) return;
    const channel = data[0] & 0x0f;
    if (!this.listensOn(channel)) return;
    const ev = this.decoder.message(data);
    if (ev) {
      const p = nrpnParam(ev.address);
      if (!p) return;
      let byte: number;
      if (ev.kind === 'set') {
        const v = shruthiFromByte(p, ev.value);
        if (v < p.min || v > p.max) return; // the firmware ignores it too
        byte = ev.value & 0xff;
      } else {
        const v = shruthiFromByte(p, this.mem[ev.address]) + ev.delta;
        if (v < p.min || v > p.max) return;
        byte = v & 0xff;
      }
      this.hardwareWrite(ev.address, byte);
      return;
    }
    const controller = data[1];
    if (controller === 6 || controller === 38 || (controller >= 96 && controller <= 99)) return;
    const p = ccParam(controller);
    if (p) this.hardwareWrite(p.address, shruthiScale(p, data[2]));
  }

  private hardwareWrite(address: number, byte: number): void {
    this.hardwareEditsSeen = true;
    this.emit('hardwareEdit', { address });
    if (this.suppressed(address)) return;
    if (this.mem[address] === byte) return;
    this.mem[address] = byte;
    this.emit('param', { address, byte, origin: 'hardware' });
  }

  private suppressed(address: number): boolean {
    if (this.dragging.has(address)) return true;
    const t = this.lastLocalEdit.get(address);
    return t !== undefined && this.clock.now() - t < ECHO_SUPPRESS_MS;
  }

  private onUnsolicited(f: SysExFrame): void {
    if (f.command === SHRUTHI_CMD.patch && f.payload.length === SHRUTHI_PATCH_SIZE && acceptsPatch(f.payload, this.family)) {
      applyWirePatch(this.mem, f.payload, this.family);
      this.synced = true;
      this.emit('patch', { origin: 'hardware' });
      this.log('info', `Patch “${this.name}” received from the Shruthi`);
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

  /** Version probe: SHOOZ, stock YAM or no Shruthi at all. */
  async detect(): Promise<ShruthiMode> {
    const mode = await this.withBusy(() => this.client.detect());
    this.emit('mode', mode);
    return mode;
  }

  /** Reads the system settings (channel, filter board, MIDI out mode…). */
  async pullSystem(): Promise<void> {
    await this.withBusy(async () => {
      const sys = await this.client.fetchSystem();
      if (sys.length !== SHRUTHI_SYSTEM_SIZE) throw new Error(`system reply has ${sys.length} bytes`);
      // The SHOOZ vintage amount is the last system byte; stock sends 0 there.
      this.mem.set(sys, SYS);
      this.systemKnown = true;
      });
    this.emit('patch', { origin: 'hardware' });
  }

  /** Reads the edit buffer. */
  async pullPatch(): Promise<void> {
    await this.withBusy(async () => {
      const wire = await this.client.fetchPatch();
      applyWirePatch(this.mem, wire, this.family);
      this.synced = true;
    });
    this.emit('patch', { origin: 'hardware' });
  }

  /** Port changed: forget receiver state and pending requests. */
  resetLink(): void {
    this.decoder.reset();
    this.echo.reset();
    this.scheduler.clear();
    this.client.reset();
    this.client.mode = 'unknown';
    this.client.firmware = null;
    this.hardwareEditsSeen = false;
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit('log', { level, text });
  }
}
