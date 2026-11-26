// A stand-in for the browser's MIDIAccess, wired to a simulated Ambika.
// Enabled with `?virtual=bambi` or `?virtual=stock` (optionally
// `&outp=full`), so the editor can be tried and tested without hardware or
// MIDI permission.

import { wireTimeMs } from '../midi/scheduler';
import { splitMessages } from '../sync/echo';
import { VirtualAmbika, type OutMode } from './virtual-ambika';

type Listener = (e: { data: Uint8Array; timeStamp: number }) => void;

export interface VirtualSetup {
  firmware: 'stock' | 'yamplus';
  outMode: OutMode;
}

/** Reads `?virtual=bambi|stock&outp=…` from a query string; null if absent. */
export function virtualSetupFromQuery(search: string): VirtualSetup | null {
  const q = new URLSearchParams(search);
  const v = q.get('virtual');
  if (v === null) return null;
  const outp = q.get('outp');
  const outModes: OutMode[] = ['thru', 'sequencer', 'controllr', 'chain', 'full'];
  return {
    firmware: v === 'stock' ? 'stock' : 'yamplus',
    outMode: outModes.includes(outp as OutMode) ? (outp as OutMode) : 'controllr',
  };
}

/** Creates the simulated synth and a MIDIAccess-shaped object connected to it. */
export function createVirtualMidi(setup: VirtualSetup): { synth: VirtualAmbika; access: MIDIAccess } {
  const listeners = new Set<Listener>();
  // One serial line per direction, paced at 31.25 kbaud like the real link.
  const line = () => {
    let busyUntil = 0;
    return (msg: Uint8Array, deliver: () => void) => {
      const now = performance.now();
      const at = Math.max(now, busyUntil) + wireTimeMs(msg.length);
      busyUntil = at;
      setTimeout(deliver, at - now);
    };
  };
  const toSynth = line();
  const toShed = line();
  const synth = new VirtualAmbika({
    ...setup,
    send: (msg) =>
      toShed(msg, () => {
        for (const l of listeners) l({ data: msg, timeStamp: performance.now() });
      }),
  });
  const label = `Virtual Ambika (${setup.firmware === 'yamplus' ? 'BAMBI' : 'stock YAM'})`;
  const common = { manufacturer: 'SHED', state: 'connected', connection: 'open', open: async () => undefined, close: async () => undefined };
  const input = {
    ...common,
    id: 'virtual-ambika-in',
    name: label,
    type: 'input',
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
  };
  const output = {
    ...common,
    id: 'virtual-ambika-out',
    name: label,
    type: 'output',
    send: (bytes: ArrayLike<number>) => {
      for (const msg of splitMessages(Uint8Array.from(bytes))) toSynth(msg, () => synth.receive(msg));
    },
  };
  const access = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map([[output.id, output]]),
    sysexEnabled: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { synth, access: access as unknown as MIDIAccess };
}
