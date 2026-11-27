// Parameter controls bound to the sync engine, drawn as hardware: knobs,
// faders, menu windows (◀ value ▶ with a drop-down list) and LED buttons.

import { OSC_SHAPE_GROUPS, OSC_SHAPES } from '../model/params/ambika';
import { formatValue, type ParamDef } from '../model/params/types';
import { faderValue, knobAngle, knobDragValue, sliderKey, stepEnum, fraction } from './control-math';
import { h } from './dom';

type Refresh = () => void;

/**
 * What the controls need from a device engine (the Ambika's SyncEngine, or
 * the Shruthi adapter). `part` is the Ambika part; single-part synths ignore it.
 */
export interface ControlEngine {
  value(part: number, def: ParamDef): number;
  set(part: number, def: ParamDef, value: number): void;
  /** False when the connected firmware lacks the parameter. */
  supports(def: ParamDef): boolean;
  beginDrag(part: number, address: number): void;
  endDrag(part: number, address: number): void;
  /** Highest value the connected firmware accepts (enum values added later). */
  valueMax(def: ParamDef): number;
}

/** Keeps every on-screen control in step with the selected part's model. */
export class ControlRegistry {
  private readonly byAddress = new Map<number, Set<Refresh>>();
  private readonly availability = new Set<Refresh>();
  private readonly flashers = new Map<number, Set<HTMLElement>>();

  constructor(
    readonly engine: ControlEngine,
    readonly selectedPart: () => number = () => 0,
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

let nextId = 0;
const uid = (prefix: string) => `${prefix}-${++nextId}`;

const FIRMWARE_NAME = { yamplus: 'BAMBI (YAM+)', shooz: 'SHOOZ' } as const;

function availabilityTitle(def: ParamDef, supported: boolean): string {
  const base = `${def.name} · NRPN ${def.address}${def.cc !== undefined ? ` · CC ${def.cc}` : ''}`;
  return supported || !def.since ? base : `${base} · needs ${FIRMWARE_NAME[def.since]} firmware`;
}

function nameEl(def: ParamDef, label: string, id: string): HTMLElement {
  return h(
    'span',
    { class: 'ctl-name', id },
    label,
    def.since ? h('span', { class: 'badge-plus', title: `${FIRMWARE_NAME[def.since]} parameter` }, '+') : null,
  );
}

/** Flash on hardware edits; disable when the firmware lacks the parameter. */
function bind(reg: ControlRegistry, def: ParamDef, el: HTMLElement, onAvailability: (ok: boolean) => void): void {
  reg.registerFlash(def.address, el);
  reg.registerAvailability(() => {
    const ok = reg.engine.supports(def);
    el.classList.toggle('unsupported', !ok);
    el.title = availabilityTitle(def, ok);
    onAvailability(ok);
  });
}

/** Double-click a value readout to type an exact number. */
function typeIn(reg: ControlRegistry, def: ParamDef, out: HTMLElement): void {
  out.addEventListener('dblclick', () => {
    const typed = prompt(`${def.name} (${def.min} … ${def.max})`, String(reg.value(def)));
    if (typed !== null && typed.trim() !== '' && !Number.isNaN(Number(typed))) reg.set(def, Number(typed));
  });
}

/** Pointer drag + wheel + keyboard for a role="slider" element. */
function sliderBehaviour(
  reg: ControlRegistry,
  def: ParamDef,
  el: HTMLElement,
  enabled: () => boolean,
  onPointer: (e: PointerEvent, start: number, x0: number, y0: number) => number,
): void {
  const part = () => reg.selectedPart();
  let drag: { id: number; start: number; x0: number; y0: number } | null = null;
  const set = (v: number) => {
    if (v !== reg.value(def)) reg.set(def, v);
  };
  el.addEventListener('pointerdown', (e) => {
    if (!enabled() || e.button !== 0) return;
    e.preventDefault();
    el.focus();
    el.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, start: reg.value(def), x0: e.clientX, y0: e.clientY };
    el.classList.add('dragging');
    reg.engine.beginDrag(part(), def.address);
    set(onPointer(e, drag.start, drag.x0, drag.y0));
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    set(onPointer(e, drag.start, drag.x0, drag.y0));
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    el.classList.remove('dragging');
    reg.engine.endDrag(part(), def.address);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener(
    'wheel',
    (e) => {
      if (!enabled()) return;
      e.preventDefault();
      const v = sliderKey(def, reg.value(def), e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown', e.shiftKey);
      if (v !== null) set(v);
    },
    { passive: false },
  );
  el.addEventListener('keydown', (e) => {
    if (!enabled()) return;
    const v = sliderKey(def, reg.value(def), e.key, e.shiftKey);
    if (v === null) return;
    e.preventDefault();
    set(v);
  });
}

function sliderAria(el: HTMLElement, def: ParamDef, v: number): void {
  el.setAttribute('aria-valuenow', String(v));
  el.setAttribute('aria-valuetext', formatValue(def, v));
}

// ---------------------------------------------------------------------------

export type KnobSize = 'lg' | 'md' | 'sm';

/**
 * Rotary knob. Drag up or right to increase (Shift: fine), scroll the wheel,
 * or use the arrow keys; double-click the readout to type a value.
 */
export function knob(reg: ControlRegistry, def: ParamDef, label = def.name, size: KnobSize = 'md'): HTMLElement {
  const id = uid('k');
  const skirt = h('span', { class: 'knob-skirt' }, h('span', { class: 'knob-cap' }));
  const dial = h(
    'span',
    { class: 'knob-dial', role: 'slider', tabindex: 0, 'aria-labelledby': id, 'aria-valuemin': def.min, 'aria-valuemax': def.max },
    h('span', { class: 'knob-ticks', 'aria-hidden': 'true' }),
    skirt,
  );
  const out = h('output', { class: 'ctl-value', title: 'Double-click to type a value' });
  const el = h('div', { class: `ctl knob knob-${size}`, 'data-address': def.address }, nameEl(def, label, id), dial, out);
  let ok = true;
  sliderBehaviour(reg, def, dial, () => ok, (e, start, x0, y0) => knobDragValue(def, start, e.clientX - x0, e.clientY - y0, e.shiftKey));
  typeIn(reg, def, out);
  reg.register(def.address, () => {
    const v = reg.value(def);
    skirt.style.transform = `rotate(${knobAngle(def, v)}deg)`;
    out.textContent = formatValue(def, v);
    sliderAria(dial, def, v);
  });
  bind(reg, def, el, (supported) => {
    ok = supported;
    dial.tabIndex = supported ? 0 : -1;
    dial.setAttribute('aria-disabled', String(!supported));
  });
  return el;
}

/** Vertical fader. Drag the cap or click the track; keys and wheel as for knobs. */
export function fader(reg: ControlRegistry, def: ParamDef, label = def.name): HTMLElement {
  const id = uid('f');
  const cap = h('span', { class: 'fader-cap' });
  const track = h(
    'span',
    { class: 'fader-track', role: 'slider', tabindex: 0, 'aria-orientation': 'vertical', 'aria-labelledby': id, 'aria-valuemin': def.min, 'aria-valuemax': def.max },
    h('span', { class: 'fader-slot', 'aria-hidden': 'true' }),
    cap,
  );
  const out = h('output', { class: 'ctl-value', title: 'Double-click to type a value' });
  const el = h('div', { class: 'ctl fader', 'data-address': def.address }, track, nameEl(def, label, id), out);
  let ok = true;
  sliderBehaviour(reg, def, track, () => ok, (e) => {
    // The cap travels between 4 px margins (see .fader-cap in style.css).
    const r = track.getBoundingClientRect();
    const capH = cap.offsetHeight;
    return faderValue(def, e.clientY - r.top - 4 - capH / 2, r.height - capH - 8);
  });
  typeIn(reg, def, out);
  reg.register(def.address, () => {
    const v = reg.value(def);
    track.style.setProperty('--pos', String(fraction(def, v)));
    out.textContent = formatValue(def, v);
    sliderAria(track, def, v);
  });
  bind(reg, def, el, (supported) => {
    ok = supported;
    track.tabIndex = supported ? 0 : -1;
    track.setAttribute('aria-disabled', String(!supported));
  });
  return el;
}

// ---------------------------------------------------------------------------
// Menu windows. One list is open at a time; a click outside closes it.

let closeOpenMenu: (() => void) | null = null;
let outsideListener = false;

function watchOutside(): void {
  if (outsideListener) return;
  outsideListener = true;
  document.addEventListener('pointerdown', (e) => {
    const open = document.querySelector('.menu.open');
    if (open && !open.contains(e.target as Node)) closeOpenMenu?.();
  });
}

/** First BAMBI-only oscillator shape (wavquence); shapes from here on are marked +. */
const FIRST_BAMBI_SHAPE = 37;

export interface MenuOptions {
  /** No visible name (the slot or section names it). */
  hideLabel?: boolean;
  /** Smaller window for the mod matrix. */
  compact?: boolean;
  /** Extra element shown inside the window after the value (e.g. an LFO glyph). */
  adornment?: HTMLElement;
}

/**
 * Teal display window with ◀ ▶ steppers; clicking the value opens a list of
 * every option (grouped for oscillator shapes).
 */
export function menu(reg: ControlRegistry, def: ParamDef, label = def.name, opts: MenuOptions = {}): HTMLElement {
  const id = uid('m');
  const listId = uid('ml');
  const isOscShape = def.labels === OSC_SHAPES;
  const valueText = h('span', { class: 'menu-text' });
  const mark = h('span', { class: 'menu-mark' });
  const valueBtn = h(
    'button',
    { type: 'button', class: 'menu-value', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-labelledby': `${id} ${id}-v` },
    h('span', { id: `${id}-v`, class: 'menu-current' }, valueText, mark),
    opts.adornment ?? null,
    h('span', { class: 'menu-caret', 'aria-hidden': 'true' }, '▼'),
  );
  const prev = h('button', { type: 'button', class: 'menu-step', 'aria-label': `Previous ${label}` }, '◀');
  const next = h('button', { type: 'button', class: 'menu-step', 'aria-label': `Next ${label}` }, '▶');
  const list = h('div', { class: 'menu-list', role: 'listbox', id: listId, 'aria-labelledby': id, hidden: true });
  const name = nameEl(def, label, id);
  if (opts.hideLabel) name.classList.add('sr-only');
  const el = h(
    'div',
    { class: `ctl menu${opts.compact ? ' menu-compact' : ''}`, 'data-address': def.address },
    name,
    h('div', { class: 'menu-row' }, prev, valueBtn, next),
    list,
  );

  const maxValue = () => reg.engine.valueMax(def);
  const bambiValue = (v: number) =>
    isOscShape ? v >= FIRST_BAMBI_SHAPE : def.valuesSince !== undefined && v >= def.valuesSince.from;
  const choose = (v: number) => {
    if (v !== reg.value(def)) reg.set(def, v);
  };

  const option = (v: number, current: number) =>
    h(
      'button',
      {
        type: 'button',
        role: 'option',
        class: 'menu-option',
        'aria-selected': String(v === current),
        'data-value': v,
        disabled: v > maxValue(),
        onclick: () => {
          choose(v);
          close(true);
        },
      },
      h('span', {}, formatValue(def, v)),
      bambiValue(v) ? h('span', { class: 'menu-mark', title: isOscShape ? 'BAMBI voicecard shape' : 'BAMBI 0.2 value' }, '+') : null,
    );

  const fill = () => {
    const current = reg.value(def);
    list.replaceChildren();
    if (isOscShape) {
      for (const g of OSC_SHAPE_GROUPS) {
        list.append(h('div', { class: 'menu-group', role: 'presentation' }, g.label));
        for (const s of g.shapes) list.append(option(s, current));
      }
    } else {
      for (let v = def.min; v <= def.max; v++) list.append(option(v, current));
    }
  };

  const options = () => [...list.querySelectorAll<HTMLButtonElement>('.menu-option:not(:disabled)')];

  const open = () => {
    if (closeOpenMenu) closeOpenMenu();
    watchOutside();
    fill();
    list.hidden = false;
    el.classList.add('open');
    valueBtn.setAttribute('aria-expanded', 'true');
    // Open upwards when there's no room below.
    el.classList.remove('up');
    const r = list.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8 && el.getBoundingClientRect().top > r.height + 8) el.classList.add('up');
    const sel = list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? options()[0];
    sel?.focus();
    sel?.scrollIntoView({ block: 'nearest' });
    closeOpenMenu = () => close(false);
  };

  function close(refocus: boolean): void {
    if (list.hidden) return;
    list.hidden = true;
    el.classList.remove('open', 'up');
    valueBtn.setAttribute('aria-expanded', 'false');
    if (closeOpenMenu) closeOpenMenu = null;
    if (refocus) valueBtn.focus();
  }

  valueBtn.addEventListener('click', () => (list.hidden ? open() : close(true)));
  prev.addEventListener('click', () => choose(stepEnum(def, reg.value(def), -1, maxValue())));
  next.addEventListener('click', () => choose(stepEnum(def, reg.value(def), 1, maxValue())));
  valueBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (e) => {
    const all = options();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = all[Math.min(all.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      n?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? all[0] : all[all.length - 1])?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  });

  reg.register(def.address, () => {
    const v = reg.value(def);
    valueText.textContent = formatValue(def, v);
    mark.textContent = bambiValue(v) ? '+' : '';
    if (!list.hidden) fill();
  });
  bind(reg, def, el, (supported) => {
    for (const b of [prev, next, valueBtn]) b.disabled = !supported;
    if (!supported) close(false);
  });
  return el;
}

// ---------------------------------------------------------------------------

/** Row of LED push-buttons for a short enumeration (filter mode, spread mode). */
export function leds(reg: ControlRegistry, def: ParamDef, label = def.name, opts: { hideLabel?: boolean; small?: boolean } = {}): HTMLElement {
  const id = uid('l');
  const group = h('div', { class: 'led-group', role: 'radiogroup', 'aria-labelledby': id });
  const buttons: HTMLButtonElement[] = [];
  for (let v = def.min; v <= def.max; v++) {
    const b = h(
      'button',
      { type: 'button', role: 'radio', class: 'led-btn', onclick: () => reg.set(def, v) },
      h('span', { class: 'led-dot', 'aria-hidden': 'true' }),
      opts.small ? null : h('span', { class: 'led-key', 'aria-hidden': 'true' }),
      h('span', { class: 'led-label' }, formatValue(def, v)),
    );
    buttons.push(b);
    group.append(b);
  }
  // Arrow keys move between options, as in a radio group.
  group.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const v = stepEnum(def, reg.value(def), dir as 1 | -1, reg.engine.valueMax(def));
    reg.set(def, v);
    buttons[v - def.min]?.focus();
  });
  const name = nameEl(def, label, id);
  if (opts.hideLabel) name.classList.add('sr-only');
  const el = h('div', { class: `ctl leds${opts.small ? ' leds-small' : ''}`, 'data-address': def.address }, name, group);
  reg.register(def.address, () => {
    const cur = reg.value(def);
    buttons.forEach((b, i) => {
      const on = def.min + i === cur;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  // Values the connected firmware doesn't have stay visible but disabled.
  bind(reg, def, el, (ok) => buttons.forEach((b, i) => (b.disabled = !ok || def.min + i > reg.engine.valueMax(def))));
  return el;
}

/** Single LED push-button for an on/off parameter (legato). */
export function ledToggle(reg: ControlRegistry, def: ParamDef, label = def.name): HTMLElement {
  const id = uid('t');
  const b = h(
    'button',
    { type: 'button', class: 'led-btn', 'aria-labelledby': id, onclick: () => reg.set(def, reg.value(def) ? 0 : 1) },
    h('span', { class: 'led-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'led-key', 'aria-hidden': 'true' }),
  );
  const el = h('div', { class: 'ctl led-toggle', 'data-address': def.address }, nameEl(def, label, id), b);
  reg.register(def.address, () => b.setAttribute('aria-pressed', String(reg.value(def) !== 0)));
  bind(reg, def, el, (ok) => (b.disabled = !ok));
  return el;
}

/** Picks a control from the parameter's unit. */
export function control(reg: ControlRegistry, def: ParamDef, label?: string): HTMLElement {
  if (def.unit === 'bool') return ledToggle(reg, def, label);
  if (def.unit === 'enum') return def.max - def.min <= 3 ? leds(reg, def, label) : menu(reg, def, label);
  return knob(reg, def, label);
}
