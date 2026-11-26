// A stand-in for the browser's MIDIAccess, wired to a simulated synth.
// Enabled with `?virtual=bambi` or `?virtual=stock` (Ambika, optionally
// `&outp=full`) or `?virtual=shooz` / `?virtual=shruthi` (Shruthi with SHOOZ
// or stock YAM, optionally `&outp=thru|ctrl|full|off`), so the editor can be
// tried and tested without hardware or MIDI permission.

import { wireTimeMs } from '../midi/scheduler';
import { splitMessages } from '../sync/echo';
import { SHRUTHI_REQUEST_DELAY_MS } from '../protocol/shruthi-client';
import { VirtualAmbika, type OutMode } from './virtual-ambika';
import { SHRUTHI_OUT_MODE, VirtualShruthi } from './virtual-shruthi';

type Listener = (e: { data: Uint8Array; timeStamp: number }) => void;

export interface VirtualSetup {
  firmware: 'stock' | 'yamplus';
  outMode: OutMode;
}

/** Reads `?virtual=bambi|stock&outp=…` from a query string; null if absent. */
export function virtualSetupFromQuery(search: string): VirtualSetup | null {
  const q = new URLSearchParams(search);
  const v = q.get('virtual');
  if (v === null || v === 'shooz' || v === 'shruthi') return null;
  const outp = q.get('outp');
  const outModes: OutMode[] = ['thru', 'sequencer', 'controllr', 'chain', 'full'];
  return {
    firmware: v === 'stock' ? 'stock' : 'yamplus',
    outMode: outModes.includes(outp as OutMode) ? (outp as OutMode) : 'controllr',
  };
}

export interface VirtualShruthiSetup {
  firmware: 'stock' | 'shooz';
  outMode: number;
}

/** Reads `?virtual=shooz|shruthi&outp=…` from a query string; null if absent. */
export function virtualShruthiFromQuery(search: string): VirtualShruthiSetup | null {
  const q = new URLSearchParams(search);
  const v = q.get('virtual');
  if (v !== 'shooz' && v !== 'shruthi') return null;
  const outp = q.get('outp') as keyof typeof SHRUTHI_OUT_MODE | null;
  return {
    firmware: v === 'shooz' ? 'shooz' : 'stock',
    // ctrl by default, so the simulated knob turns show up in SHED.
    outMode: outp && outp in SHRUTHI_OUT_MODE ? SHRUTHI_OUT_MODE[outp] : SHRUTHI_OUT_MODE.ctrl,
  };
}

/** The serial-line pacing and the MIDIAccess shape, for any simulated synth. */
function virtualAccess(
  id: string,
  label: string,
  connect: (toShed: (msg: Uint8Array, delayMs?: number) => void) => (msg: Uint8Array) => void,
): MIDIAccess {
  const listeners = new Set<Listener>();
  // One serial line per direction, paced at 31.25 kbaud like the real link.
  const line = () => {
    let busyUntil = 0;
    return (msg: Uint8Array, deliver: () => void, delayMs = 0) => {
      const now = performance.now();
      const at = Math.max(now + delayMs, busyUntil) + wireTimeMs(msg.length);
      busyUntil = at;
      setTimeout(deliver, at - now);
    };
  };
  const toSynth = line();
  const toShed = line();
  const receive = connect((msg, delayMs) =>
    toShed(
      msg,
      () => {
        for (const l of listeners) l({ data: msg, timeStamp: performance.now() });
      },
      delayMs,
    ),
  );
  const common = { manufacturer: 'SHED', state: 'connected', connection: 'open', open: async () => undefined, close: async () => undefined };
  const input = {
    ...common,
    id: `${id}-in`,
    name: label,
    type: 'input',
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
  };
  const output = {
    ...common,
    id: `${id}-out`,
    name: label,
    type: 'output',
    send: (bytes: ArrayLike<number>) => {
      for (const msg of splitMessages(Uint8Array.from(bytes))) toSynth(msg, () => receive(msg));
    },
  };
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map([[output.id, output]]),
    sysexEnabled: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return access as unknown as MIDIAccess;
}

/** Creates the simulated Ambika and a MIDIAccess-shaped object connected to it. */
export function createVirtualMidi(setup: VirtualSetup): { synth: VirtualAmbika; access: MIDIAccess } {
  let synth!: VirtualAmbika;
  const label = `Virtual Ambika (${setup.firmware === 'yamplus' ? 'BAMBI' : 'stock YAM'})`;
  const access = virtualAccess('virtual-ambika', label, (toShed) => {
    synth = new VirtualAmbika({ ...setup, send: (msg) => toShed(msg) });
    return (msg) => synth.receive(msg);
  });
  return { synth, access };
}

/** Creates the simulated Shruthi; its replies leave after the firmware's 100 ms delay. */
export function createVirtualShruthiMidi(setup: VirtualShruthiSetup): { synth: VirtualShruthi; access: MIDIAccess } {
  let synth!: VirtualShruthi;
  const label = `Virtual Shruthi (${setup.firmware === 'shooz' ? 'SHOOZ' : 'stock YAM'})`;
  const access = virtualAccess('virtual-shruthi', label, (toShed) => {
    synth = new VirtualShruthi({
      ...setup,
      send: (msg) => {
        // SysEx replies (commands below 0x10), not forwarded requests.
        const isReply = msg[0] === 0xf0 && msg.length > 6 && msg[6] < 0x10;
        toShed(msg, isReply ? SHRUTHI_REQUEST_DELAY_MS : 0);
      },
    });
    return (msg) => synth.receive(msg);
  });
  return { synth, access };
}
