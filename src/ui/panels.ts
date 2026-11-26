// The Ambika patch and part, laid out as one instrument panel: oscillators,
// mixer, two filters with response graphs, LFOs, three envelope rows with
// graphs and faders, the modulation matrix and modifiers, part and arp.

import { MOD_SOURCES, param } from '../model/params/ambika';
import { fader, knob, leds, ledToggle, menu, type ControlRegistry, type KnobSize } from './controls';
import { cssVar, fitCanvas, h } from './dom';
import { cutoffHz, envelopeLayout, envelopeShape, resonanceQ, svfMagnitudeDb, type SvfMode } from './viz-math';

const p = param;

type Accent = 'osc' | 'mix' | 'filter' | 'lfo' | 'env' | 'mod' | 'part';

/** A panel section: heading with a coloured rule, spanning `span` of 12 columns. */
function section(accent: Accent, title: string, span: number, note: string | HTMLElement | null, ...children: (HTMLElement | null)[]): HTMLElement {
  return h(
    'section',
    { class: `sec sec-${accent}`, style: `--span: ${span}` },
    h('h2', {}, h('span', {}, title), note ? h('span', { class: 'sec-note' }, note) : null),
    ...children,
  );
}

const row = (cls: string, ...children: (HTMLElement | null)[]) => h('div', { class: cls }, ...children);

const k = (reg: ControlRegistry, id: string, label: string, size: KnobSize = 'md') => knob(reg, p(id), label, size);

// ---------------------------------------------------------------------------
// Oscillators and mixer

function oscillator(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  return section(
    'osc',
    `Oscillator ${n}`,
    3,
    null,
    row('controls menus', menu(reg, p(`osc${n}.shape`), 'Wave')),
    row('controls', k(reg, `osc${n}.param`, 'Param'), k(reg, `osc${n}.range`, 'Range'), k(reg, `osc${n}.detune`, 'Detune')),
  );
}

function mixer(reg: ControlRegistry): HTMLElement {
  return section(
    'mix',
    'Mixer',
    6,
    null,
    row('controls menus', menu(reg, p('mix.operator'), 'Crossmod'), menu(reg, p('mix.subShape'), 'Sub wave')),
    row(
      'controls',
      k(reg, 'mix.balance', 'Osc 1·2'),
      k(reg, 'mix.param', 'Xmod amt'),
      k(reg, 'mix.sub', 'Sub'),
      k(reg, 'mix.noise', 'Noise'),
      k(reg, 'mix.fuzz', 'Fuzz'),
      k(reg, 'mix.crush', 'Crush'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Filters

/** Response graph of one filter stage, drawn in the display's teal. */
function filterGraph(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  const canvas = h('canvas', { class: 'graph graph-filter', role: 'img' });
  const label = h('span', { class: 'screen-label' });
  const ids = [`filter${n}.mode`, `filter${n}.cutoff`, `filter${n}.resonance`];
  const draw = () => {
    if (!canvas.isConnected) return;
    const ctx = fitCanvas(canvas);
    const { width: w, height: hh } = canvas.getBoundingClientRect();
    const minDb = -36;
    const maxDb = 24;
    const fMin = 20;
    const fMax = 20000;
    const xOf = (f: number) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
    const yOf = (db: number) => ((maxDb - db) / (maxDb - minDb)) * hh;
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = cssVar('--screen-grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [100, 1000, 10000]) {
      ctx.moveTo(Math.round(xOf(f)) + 0.5, 0);
      ctx.lineTo(Math.round(xOf(f)) + 0.5, hh);
    }
    ctx.moveTo(0, Math.round(yOf(0)) + 0.5);
    ctx.lineTo(w, Math.round(yOf(0)) + 0.5);
    ctx.stroke();

    const mode = reg.value(p(ids[0])) as SvfMode;
    const cutoff = reg.value(p(ids[1]));
    const reso = reg.value(p(ids[2]));
    const fc = cutoffHz(cutoff);
    const q = resonanceQ(reso);
    const teal = cssVar('--vfd');
    // Cutoff marker.
    ctx.strokeStyle = cssVar('--vfd-dim');
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(xOf(fc)) + 0.5, 0);
    ctx.lineTo(Math.round(xOf(fc)) + 0.5, hh);
    ctx.stroke();
    ctx.setLineDash([]);
    // Curve with a soft glow and a faint fill.
    ctx.beginPath();
    for (let x = 0; x <= w; x += 1) {
      const f = fMin * Math.pow(fMax / fMin, x / w);
      const y = yOf(Math.max(minDb - 6, svfMagnitudeDb(mode, f, fc, q)));
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.shadowColor = teal;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = teal;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(w, hh);
    ctx.lineTo(0, hh);
    ctx.closePath();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = teal;
    ctx.fill();
    ctx.globalAlpha = 1;

    const hz = fc >= 1000 ? `${(fc / 1000).toFixed(1)} kHz` : `${Math.round(fc)} Hz`;
    const modeName = ['LP', 'BP', 'HP', 'Notch'][mode] ?? '';
    label.textContent = `${modeName} · ${hz}`;
    canvas.setAttribute('aria-label', `Filter ${n} response: ${modeName}, cutoff about ${hz}, resonance ${reso}`);
  };
  for (const id of ids) reg.register(p(id).address, () => requestAnimationFrame(draw));
  new ResizeObserver(() => draw()).observe(canvas);
  return h('div', { class: 'screen screen-filter' }, canvas, label);
}

function filter(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  const main = row(
    'filter-main',
    h('div', { class: 'filter-left' }, filterGraph(reg, n), leds(reg, p(`filter${n}.mode`), 'Mode', { hideLabel: true })),
    row('filter-knobs', k(reg, `filter${n}.cutoff`, 'Cutoff', 'lg'), k(reg, `filter${n}.resonance`, 'Resonance', 'lg')),
  );
  const mod =
    n === 1
      ? row('filter-mod', k(reg, 'filter.env', 'Env 2', 'lg'), k(reg, 'filter.lfo', 'LFO 2', 'lg'), k(reg, 'filter.velocity', 'Velocity', 'lg'), k(reg, 'filter.keytrack', 'Key track', 'lg'))
      : null;
  return section('filter', `Filter ${n}`, 6, n === 2 ? '2nd-stage voicecards' : null, main, mod);
}

// ---------------------------------------------------------------------------
// LFOs

const LFO_GLYPHS: Record<string, string> = {
  triangle: 'M0 12 L14 2 L42 22 L56 12',
  square: 'M0 20 V4 H28 V20 H56',
  's&h': 'M0 16 H10 V6 H20 V19 H30 V9 H40 V14 H50 V4 H56',
  ramp: 'M0 22 L56 2',
  sine: 'M0 12 Q7 -6 14 12 T28 12 T42 12 T56 12',
};

/** Small waveform picture for the common LFO shapes (none for the rest). */
function lfoGlyph(reg: ControlRegistry, id: string): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 56 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('lfo-glyph');
  const path = document.createElementNS(NS, 'path');
  svg.append(path);
  const def = p(id);
  reg.register(def.address, () => {
    const name = def.labels?.[reg.value(def) - def.min] ?? '';
    const d = LFO_GLYPHS[name];
    path.setAttribute('d', d ?? '');
    svg.style.display = d ? '' : 'none';
  });
  return svg as unknown as HTMLElement;
}

function lfoCard(reg: ControlRegistry, n: 1 | 2 | 3 | 4): HTMLElement {
  const name = n === 4 ? 'Voice' : `LFO ${n}`;
  const shape = menu(reg, p(`lfo${n}.shape`), `${name} shape`, { hideLabel: true, adornment: lfoGlyph(reg, `lfo${n}.shape`) });
  const extra = n === 4 ? k(reg, 'voice.vintage', 'Vintage', 'sm') : leds(reg, p(`lfo${n}.sync`), 'Trigger', { hideLabel: true, small: true });
  return h(
    'div',
    { class: 'lfo-card' },
    k(reg, `lfo${n}.rate`, 'Rate', 'sm'),
    h('div', { class: 'lfo-body' }, h('div', { class: 'lfo-head' }, h('span', { class: 'lfo-name' }, name), shape), extra),
  );
}

function lfos(reg: ControlRegistry): HTMLElement {
  return section('lfo', 'LFOs', 12, null, row('lfo-row', lfoCard(reg, 1), lfoCard(reg, 2), lfoCard(reg, 3), lfoCard(reg, 4)));
}

// ---------------------------------------------------------------------------
// Envelopes

/** Envelope graph; drag the attack peak, decay/sustain point and release end. */
function envelopeGraph(reg: ControlRegistry, n: number): HTMLElement {
  const ids = ['attack', 'decay', 'sustain', 'release', 'curve'].map((key) => p(`env${n}.${key}`));
  const [A, D, S, R, C] = ids;
  const canvas = h('canvas', { class: 'graph graph-env', role: 'img', 'aria-label': `Envelope ${n} shape; drag its points to edit` });
  let dragging: number | null = null;

  const layout = () => {
    const { width, height } = canvas.getBoundingClientRect();
    return envelopeLayout(reg.value(A), reg.value(D), reg.value(S), reg.value(R), width, height, 10);
  };

  const draw = () => {
    if (!canvas.isConnected) return;
    const ctx = fitCanvas(canvas);
    const { width: w, height: hh } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = cssVar('--screen-grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = Math.round((w * i) / 4) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, hh);
    }
    ctx.moveTo(0, hh - 10.5);
    ctx.lineTo(w, hh - 10.5);
    ctx.stroke();

    const pts = layout().points;
    const curve = reg.engine.supports(C) ? reg.value(C) : 0;
    const seg = (a: { x: number; y: number }, b: { x: number; y: number }, shaped: boolean) => {
      const steps = 32;
      for (let i = 1; i <= steps; i++) {
        const x = i / steps;
        const t = shaped ? envelopeShape(x, curve) : x;
        ctx.lineTo(a.x + (b.x - a.x) * x, a.y + (b.y - a.y) * t);
      }
    };
    const teal = cssVar('--vfd');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    seg(pts[0], pts[1], true);
    seg(pts[1], pts[2], true);
    seg(pts[2], pts[3], false);
    seg(pts[3], pts[4], true);
    ctx.shadowColor = teal;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = teal;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(pts[0].x, pts[0].y);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = teal;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = teal;
    for (const i of [1, 2, 4]) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, i === dragging ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pts = layout().points;
    let best: number | null = null;
    let bestD = 16;
    for (const i of [1, 2, 3, 4]) {
      const d = Math.hypot(pts[i].x - x, pts[i].y - y);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best === null) return;
    dragging = best;
    canvas.setPointerCapture(e.pointerId);
    for (const d of [A, D, S, R]) reg.engine.beginDrag(reg.selectedPart(), d.address);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pts = layout().points;
    const segW = (r.width - 20) * 0.26;
    const toTime = (dx: number) => Math.round(((dx - 2) / segW) * 127);
    const toLevel = (yy: number) => Math.round(((r.height - 10 - yy) / (r.height - 20)) * 127);
    if (dragging === 1) reg.set(A, toTime(x - pts[0].x));
    if (dragging === 2) {
      reg.set(D, toTime(x - pts[1].x));
      reg.set(S, toLevel(y));
    }
    if (dragging === 3) reg.set(S, toLevel(y));
    if (dragging === 4) reg.set(R, toTime(x - pts[3].x));
  });
  const end = () => {
    if (dragging === null) return;
    dragging = null;
    for (const d of [A, D, S, R]) reg.engine.endDrag(reg.selectedPart(), d.address);
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  for (const d of ids) reg.register(d.address, () => requestAnimationFrame(draw));
  reg.registerAvailability(() => requestAnimationFrame(draw));
  new ResizeObserver(() => draw()).observe(canvas);
  return h('div', { class: 'screen screen-env' }, canvas);
}

function envelope(reg: ControlRegistry, n: number): HTMLElement {
  const role = n === 1 ? 'Mod' : n === 2 ? 'Filter' : 'Amp';
  const curve = fader(reg, p(`env${n}.curve`), 'C');
  curve.querySelector('.ctl-name')!.setAttribute('title', 'Curve: 0 = exponential (YAM), 64 = linear, 127 = inverse exponential');
  return section(
    'env',
    `Env ${n}`,
    12,
    role,
    row(
      'env-row',
      envelopeGraph(reg, n),
      row('faders', fader(reg, p(`env${n}.attack`), 'A'), fader(reg, p(`env${n}.decay`), 'D'), fader(reg, p(`env${n}.sustain`), 'S'), fader(reg, p(`env${n}.release`), 'R'), curve),
    ),
  );
}

// ---------------------------------------------------------------------------
// Modulation

function modSlot(reg: ControlRegistry, i: number): HTMLElement {
  const amt = p(`mod${i}.amount`);
  const slot = h(
    'div',
    { class: 'mod-slot' },
    h('span', { class: 'mod-index' }, String(i)),
    menu(reg, p(`mod${i}.source`), `Slot ${i} source`, { hideLabel: true, compact: true }),
    h('span', { class: 'mod-arrow', 'aria-hidden': 'true' }, '▼'),
    menu(reg, p(`mod${i}.destination`), `Slot ${i} destination`, { hideLabel: true, compact: true }),
    knob(reg, amt, `Slot ${i} amount`, 'sm'),
  );
  reg.register(amt.address, () => slot.classList.toggle('inactive', reg.value(amt) === 0));
  return slot;
}

function modifierSlot(reg: ControlRegistry, i: number): HTMLElement {
  const op = p(`modifier${i}.operator`);
  const slot = h(
    'div',
    { class: 'modifier-slot' },
    h('span', { class: 'mod-index' }, `Mod ${i}`),
    menu(reg, p(`modifier${i}.in1`), 'In 1', { compact: true }),
    menu(reg, op, 'Operator', { compact: true }),
    menu(reg, p(`modifier${i}.in2`), 'In 2', { compact: true }),
  );
  reg.register(op.address, () => slot.classList.toggle('inactive', reg.value(op) === 0));
  return slot;
}

function modulation(reg: ControlRegistry): HTMLElement {
  const slots: HTMLElement[] = [];
  for (let i = 1; i <= 14; i++) slots.push(modSlot(reg, i));
  const modifiers: HTMLElement[] = [];
  for (let i = 1; i <= 4; i++) modifiers.push(modifierSlot(reg, i));
  return section(
    'mod',
    'Modulation',
    12,
    '14 slots · source / destination / amount',
    h('div', { class: 'mod-grid' }, ...slots),
    h('h3', { class: 'sub-heading' }, h('span', {}, 'Modifiers'), h('span', { class: 'sec-note' }, `outputs are sources “${MOD_SOURCES[7]}” … “${MOD_SOURCES[10]}”`)),
    h('div', { class: 'modifier-grid' }, ...modifiers),
  );
}

// ---------------------------------------------------------------------------
// Part and arpeggiator

function part(reg: ControlRegistry, mappingInfo: HTMLElement): HTMLElement {
  return section(
    'part',
    'Part',
    7,
    mappingInfo,
    row(
      'controls',
      menu(reg, p('part.polyphony'), 'Voice mode'),
      menu(reg, p('part.raga'), 'Raga'),
      leds(reg, p('part.spreadMode'), 'Spread mode'),
      ledToggle(reg, p('part.legato'), 'Legato'),
    ),
    row('controls', k(reg, 'part.volume', 'Volume'), k(reg, 'part.octave', 'Octave'), k(reg, 'part.tuning', 'Tuning'), k(reg, 'part.spread', 'Spread'), k(reg, 'part.portamento', 'Glide')),
  );
}

function arp(reg: ControlRegistry): HTMLElement {
  return section(
    'part',
    'Arp / Sequencer',
    5,
    null,
    row('controls', leds(reg, p('arp.mode'), 'Mode'), menu(reg, p('arp.direction'), 'Direction'), menu(reg, p('arp.resolution'), 'Grid')),
    row(
      'controls',
      k(reg, 'arp.octave', 'Range', 'sm'),
      k(reg, 'arp.pattern', 'Pattern', 'sm'),
      k(reg, 'seq.length1', 'Seq 1', 'sm'),
      k(reg, 'seq.length2', 'Seq 2', 'sm'),
      k(reg, 'seq.length3', 'Patt len', 'sm'),
    ),
  );
}

/** Every section of the panel, in reading order. */
export function instrumentPanel(reg: ControlRegistry, mappingInfo: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'panel-grid' },
    oscillator(reg, 1),
    oscillator(reg, 2),
    mixer(reg),
    filter(reg, 1),
    filter(reg, 2),
    lfos(reg),
    envelope(reg, 1),
    envelope(reg, 2),
    envelope(reg, 3),
    modulation(reg),
    part(reg, mappingInfo),
    arp(reg),
  );
}
