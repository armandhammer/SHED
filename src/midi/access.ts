// Web MIDI access: permission (with SysEx), port selection persisted by name,
// and hot-plug handling. Chrome and Edge only; Firefox needs a site-permission
// add-on and Safari has no Web MIDI at all.

import { Emitter } from '../util/emitter';

export interface PortInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: MIDIPortDeviceState;
}

export type MidiStatus = 'unsupported' | 'idle' | 'requesting' | 'denied' | 'ready';

interface MidiEvents {
  status: MidiStatus;
  ports: void;
  selection: { input: PortInfo | null; output: PortInfo | null };
  message: { data: Uint8Array; timeStamp: number };
}

const STORAGE_KEY = 'shed.midi.ports';

interface Persisted {
  input?: string;
  output?: string;
}

function readPersisted(): Persisted {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Persisted;
  } catch {
    return {};
  }
}

function writePersisted(p: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the selection just won't survive a reload.
  }
}

function info(port: MIDIPort): PortInfo {
  return {
    id: port.id,
    name: port.name ?? port.id,
    manufacturer: port.manufacturer ?? '',
    state: port.state,
  };
}

/** Port names that look like an Ambika or a common interface to it. */
const PREFERRED = /ambika|shruthi|mutable/i;

export class MidiAccess extends Emitter<MidiEvents> {
  status: MidiStatus = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'idle' : 'unsupported';
  error: string | null = null;
  private access: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  private readonly onMidiMessage = (e: MIDIMessageEvent) => {
    if (e.data) this.emit('message', { data: e.data, timeStamp: e.timeStamp });
  };

  get supported(): boolean {
    return this.status !== 'unsupported';
  }

  async request(): Promise<boolean> {
    if (!this.supported) return false;
    this.setStatus('requesting');
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.setStatus('denied');
      return false;
    }
    this.access.addEventListener('statechange', () => this.onStateChange());
    this.setStatus('ready');
    this.restoreSelection();
    this.emit('ports', undefined);
    return true;
  }

  inputs(): PortInfo[] {
    return this.access ? [...this.access.inputs.values()].map(info) : [];
  }

  outputs(): PortInfo[] {
    return this.access ? [...this.access.outputs.values()].map(info) : [];
  }

  get selectedInput(): PortInfo | null {
    return this.input ? info(this.input) : null;
  }

  get selectedOutput(): PortInfo | null {
    return this.output ? info(this.output) : null;
  }

  selectInput(id: string | null): void {
    if (this.input) this.input.removeEventListener('midimessage', this.onMidiMessage as EventListener);
    this.input = id && this.access ? this.access.inputs.get(id) ?? null : null;
    if (this.input) {
      this.input.addEventListener('midimessage', this.onMidiMessage as EventListener);
      // Opening explicitly surfaces errors early (port busy in another app).
      this.input.open().catch(() => undefined);
    }
    this.persist();
    this.emitSelection();
  }

  selectOutput(id: string | null): void {
    this.output = id && this.access ? this.access.outputs.get(id) ?? null : null;
    this.output?.open().catch(() => undefined);
    this.persist();
    this.emitSelection();
  }

  /** Sends one or more complete MIDI messages. Returns false if no output. */
  send(bytes: Uint8Array): boolean {
    if (!this.output || this.output.state !== 'connected') return false;
    try {
      this.output.send(bytes);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private setStatus(s: MidiStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private persist(): void {
    writePersisted({ input: this.input?.name ?? undefined, output: this.output?.name ?? undefined });
  }

  private emitSelection(): void {
    this.emit('selection', { input: this.selectedInput, output: this.selectedOutput });
  }

  /** Re-select ports by persisted name, else the first port that looks like an Ambika. */
  private restoreSelection(): void {
    const saved = readPersisted();
    const pick = (ports: PortInfo[], name?: string) =>
      ports.find((p) => p.name === name && p.state === 'connected') ??
      ports.find((p) => PREFERRED.test(p.name) && p.state === 'connected') ??
      null;
    if (!this.input) {
      const p = pick(this.inputs(), saved.input);
      if (p) this.selectInput(p.id);
    }
    if (!this.output) {
      const p = pick(this.outputs(), saved.output);
      if (p) this.selectOutput(p.id);
    }
  }

  private onStateChange(): void {
    // A selected port that vanished is dropped; one that comes back (same name)
    // is picked up again by restoreSelection.
    if (this.input && this.input.state === 'disconnected') {
      this.input.removeEventListener('midimessage', this.onMidiMessage as EventListener);
      this.input = null;
      this.emitSelection();
    }
    if (this.output && this.output.state === 'disconnected') {
      this.output = null;
      this.emitSelection();
    }
    const before = readPersisted();
    this.restoreSelection();
    writePersisted({ input: this.input?.name ?? before.input, output: this.output?.name ?? before.output });
    this.emit('ports', undefined);
  }
}
