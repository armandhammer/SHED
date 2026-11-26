// Which synth SHED edits: the Ambika (default) or a Shruthi-1. Chosen with
// `?device=ambika|shruthi`, implied by `?virtual=…`, else remembered in
// localStorage. Switching reloads the page: each editor owns its MIDI link.

import type { Device } from '../librarian/syx';
import { h } from './dom';

export const DEVICE_KEY = 'shed.device';

export function chosenDevice(search: string, stored: string | null): Device {
  const q = new URLSearchParams(search);
  const v = q.get('virtual');
  if (v === 'shooz' || v === 'shruthi') return 'shruthi';
  if (v !== null) return 'ambika';
  const d = q.get('device') ?? stored;
  return d === 'shruthi' ? 'shruthi' : 'ambika';
}

function storedDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

export function currentDevice(): Device {
  return chosenDevice(location.search, storedDevice());
}

/** Synth selector for the connection strip. */
export function deviceSwitch(current: Device): HTMLElement {
  const sel = h(
    'select',
    { 'aria-label': 'Synth', title: 'Synth to edit (reloads SHED)' },
    h('option', { value: 'ambika' }, 'Ambika'),
    h('option', { value: 'shruthi' }, 'Shruthi-1'),
  );
  sel.value = current;
  sel.addEventListener('change', () => {
    try {
      localStorage.setItem(DEVICE_KEY, sel.value);
    } catch {
      // Private mode: the query string still carries the choice.
    }
    const q = new URLSearchParams(location.search);
    q.delete('virtual');
    q.delete('outp');
    q.set('device', sel.value);
    location.search = q.toString();
  });
  return h('label', { class: 'device-switch' }, 'Synth ', sel);
}
