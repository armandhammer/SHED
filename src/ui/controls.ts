// Parameter controls bound to the sync engine.

import { OSC_SHAPE_GROUPS, OSC_SHAPES } from '../model/params/ambika';
import { formatValue, type ParamDef } from '../model/params/types';
import type { SyncEngine } from '../sync/engine';
import { h } from './dom';

type Refresh = () => void;

/** Keeps every on-screen control in step with the selected part's model. */
export class ControlRegistry {
  private readonly byAddress = new Map<number, Set<Refresh>>();
  private readonly availability = new Set<Refresh>();
  private readonly flashers = new Map<number, Set<HTMLElement>>();

  constructor(
    readonly engine: SyncEngine,
    readonly selectedPart: () => number,
  ) {}

  register(address: number, refresh: Refresh): void {
    let set = this.byAddress.get(address);
    if (!set) this.byAddress.set(address, (set = new Set()));
    set.add(refresh);
    refresh();
  }

  registerAvailability(refresh: Refresh): void {
    this.availability.add(refresh);
    refresh();
  }

  registerFlash(address: number, el: HTMLElement): void {
    let set = this.flashers.get(address);
    if (!set) this.flashers.set(address, (set = new Set()));
    set.add(el);
  }

  update(address: number): void {
    this.byAddress.get(address)?.forEach((r) => r());
  }

  refreshAll(): void {
    this.byAddress.forEach((set) => set.forEach((r) => r()));
  }

  refreshAvailability(): void {
    this.availability.forEach((r) => r());
  }

  /** Brief highlight when the synth changed a value. */
  flash(address: number): void {
    this.flashers.get(address)?.forEach((el) => {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  value(def: ParamDef): number {
    return this.engine.value(this.selectedPart(), def);
  }

  set(def: ParamDef, v: number): void {
    this.engine.set(this.selectedPart(), def, v);
  }
}

function availabilityTitle(def: ParamDef, supported: boolean): string {
  const base = `${def.name} · NRPN ${def.address}${def.cc !== undefined ? ` · CC ${def.cc}` : ''}`;
  return supported ? base : `${base} · needs BAMBI (YAM+) firmware`;
}

function wrap(reg: ControlRegistry, def: ParamDef, input: HTMLElement, output?: HTMLElement, label = def.name): HTMLElement {
  const el = h(
    'label',
    { class: `ctl ctl-${def.unit}${def.since ? ' yamplus' : ''}`, 'data-address': def.address },
    h('span', { class: 'ctl-name' }, label, def.since ? h('span', { class: 'badge-plus', title: 'BAMBI (YAM+) parameter' }, '+') : null),
    input,
    output ?? null,
  );
  reg.registerFlash(def.address, el);
  reg.registerAvailability(() => {
    const ok = reg.engine.supports(def);
    el.classList.toggle('unsupported', !ok);
    el.title = availabilityTitle(def, ok);
    (input as HTMLInputElement).disabled = !ok;
  });
  return el;
}

/** Range slider for continuous and integer parameters. */
export function slider(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  const input = h('input', { type: 'range', min: def.min, max: def.max, step: 1 });
  const output = h('output', { class: 'ctl-value' });
  const bipolar = def.min < 0;
  const paint = (v: number) => {
    output.textContent = formatValue(def, v);
    const span = def.max - def.min || 1;
    const pos = (v - def.min) / span;
    if (bipolar) {
      const zero = -def.min / span;
      const lo = Math.min(zero, pos) * 100;
      const hi = Math.max(zero, pos) * 100;
      input.style.setProperty('--lo', `${lo}%`);
      input.style.setProperty('--hi', `${hi}%`);
    } else {
      input.style.setProperty('--lo', '0%');
      input.style.setProperty('--hi', `${pos * 100}%`);
    }
  };
  const part = () => reg.selectedPart();
  input.addEventListener('pointerdown', () => reg.engine.beginDrag(part(), def.address));
  const end = () => reg.engine.endDrag(part(), def.address);
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('blur', end);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    reg.set(def, v);
    paint(reg.value(def));
  });
  // Double-click the value to type an exact number.
  output.addEventListener('dblclick', () => {
    const typed = prompt(`${def.name} (${def.min} … ${def.max})`, String(reg.value(def)));
    if (typed !== null && typed.trim() !== '' && !Number.isNaN(Number(typed))) reg.set(def, Number(typed));
  });
  reg.register(def.address, () => {
    const v = reg.value(def);
    input.value = String(v);
    paint(v);
  });
  return wrap(reg, def, input, output, label);
}

/** Drop-down for enumerations. */
export function select(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  const sel = h('select');
  const isOscShape = def.labels === OSC_SHAPES;
  if (isOscShape) {
    for (const g of OSC_SHAPE_GROUPS) {
      const og = h('optgroup', { label: g.label });
      for (const s of g.shapes) og.append(h('option', { value: s }, `${OSC_SHAPES[s]}`));
      sel.append(og);
    }
  } else {
    for (let v = def.min; v <= def.max; v++) sel.append(h('option', { value: v }, formatValue(def, v)));
  }
  sel.addEventListener('change', () => reg.set(def, Number(sel.value)));
  reg.register(def.address, () => {
    sel.value = String(reg.value(def));
  });
  if (isOscShape) {
    reg.registerAvailability(() => {
      const max = reg.engine.oscShapeMax;
      for (const opt of sel.querySelectorAll('option')) opt.disabled = Number(opt.value) > max;
    });
  }
  return wrap(reg, def, sel, undefined, label);
}

/** Segmented buttons for short enumerations (filter mode, spread mode). */
export function segmented(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  const group = h('span', { class: 'segmented', role: 'radiogroup' });
  const buttons: HTMLButtonElement[] = [];
  for (let v = def.min; v <= def.max; v++) {
    const b = h('button', { type: 'button', role: 'radio', onclick: () => reg.set(def, v) }, formatValue(def, v));
    buttons.push(b);
    group.append(b);
  }
  reg.register(def.address, () => {
    const cur = reg.value(def);
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', String(def.min + i === cur));
    });
  });
  const el = wrap(reg, def, group, undefined, label);
  reg.registerAvailability(() => {
    const ok = reg.engine.supports(def);
    buttons.forEach((b) => (b.disabled = !ok));
  });
  return el;
}

export function toggle(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  const box = h('input', { type: 'checkbox' });
  box.addEventListener('change', () => reg.set(def, box.checked ? 1 : 0));
  reg.register(def.address, () => {
    box.checked = reg.value(def) !== 0;
  });
  return wrap(reg, def, box, undefined, label);
}

/** Picks a widget from the parameter's unit. */
export function control(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  if (def.unit === 'bool') return toggle(reg, def, label);
  if (def.unit === 'enum') return def.max - def.min <= 3 ? segmented(reg, def, label) : select(reg, def, label);
  return slider(reg, def, label);
}
