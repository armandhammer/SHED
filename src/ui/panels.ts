// Editor panels for the Ambika patch and part.

import { MOD_DESTINATIONS, MOD_SOURCES, param } from '../model/params/ambika';
import { control, select, segmented, slider, toggle, type ControlRegistry } from './controls';
import { cssVar, fitCanvas, h } from './dom';
import { cutoffHz, envelopeLayout, envelopeShape, resonanceQ, svfMagnitudeDb, type SvfMode } from './viz-math';

const p = param;

function card(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h3', {}, title), ...children);
}

function section(id: string, title: string, ...children: HTMLElement[]): HTMLElement {
  return h('section', { class: 'panel', id }, h('h2', {}, title), h('div', { class: 'cards' }, ...children));
}

/** Adds a tooltip to a control's name (the control itself shows its NRPN/CC). */
function withTitle(el: HTMLElement, title: string): HTMLElement {
  const name = el.querySelector<HTMLElement>('.ctl-name');
  (name ?? el).title = title;
  return el;
}

// ---------------------------------------------------------------------------

export function voicePanel(reg: ControlRegistry): HTMLElement {
  const osc = (n: 1 | 2) =>
    card(
      `Oscillator ${n}`,
      select(reg, p(`osc${n}.shape`), 'Shape'),
      slider(reg, p(`osc${n}.param`), 'Parameter'),
      slider(reg, p(`osc${n}.range`), 'Range (semitones)'),
      slider(reg, p(`osc${n}.detune`), 'Detune'),
    );
  const mixer = card(
    'Mixer',
    slider(reg, p('mix.balance'), 'Osc 1 ↔ 2'),
    select(reg, p('mix.operator'), 'Crossmod'),
    slider(reg, p('mix.param'), 'Crossmod amount'),
    select(reg, p('mix.subShape'), 'Sub osc shape'),
    slider(reg, p('mix.sub'), 'Sub osc'),
    slider(reg, p('mix.noise'), 'Noise'),
    slider(reg, p('mix.fuzz'), 'Fuzz'),
    slider(reg, p('mix.crush'), 'Crush'),
  );
  return section('voice', 'Oscillators & mixer', osc(1), osc(2), mixer);
}

// ---------------------------------------------------------------------------

function filterResponse(reg: ControlRegistry): HTMLElement {
  const canvas = h('canvas', { class: 'viz viz-filter', 'aria-label': 'Filter response' });
  const legend = h('div', { class: 'viz-legend' });
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
    // Grid: decades and 0 dB.
    ctx.strokeStyle = cssVar('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [100, 1000, 10000]) {
      ctx.moveTo(xOf(f), 0);
      ctx.lineTo(xOf(f), hh);
    }
    ctx.moveTo(0, yOf(0));
    ctx.lineTo(w, yOf(0));
    ctx.stroke();
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('100', xOf(100) + 3, hh - 4);
    ctx.fillText('1k', xOf(1000) + 3, hh - 4);
    ctx.fillText('10k', xOf(10000) + 3, hh - 4);
    ctx.fillText('0 dB', 3, yOf(0) - 3);

    const curve = (mode: SvfMode, cutoff: number, reso: number, color: string, width: number, fill: boolean) => {
      const fc = cutoffHz(cutoff);
      const q = resonanceQ(reso);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 1) {
        const f = fMin * Math.pow(fMax / fMin, x / w);
        const y = yOf(Math.max(minDb - 6, svfMagnitudeDb(mode, f, fc, q)));
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(w, hh);
        ctx.lineTo(0, hh);
        ctx.closePath();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    };
    const v = (id: string) => reg.value(p(id));
    curve(v('filter2.mode') as SvfMode, v('filter2.cutoff'), v('filter2.resonance'), cssVar('--accent-2'), 1.25, false);
    curve(v('filter1.mode') as SvfMode, v('filter1.cutoff'), v('filter1.resonance'), cssVar('--accent'), 2, true);
    legend.replaceChildren(
      h('span', { class: 'swatch s1' }), `Filter 1 · ${Math.round(cutoffHz(v('filter1.cutoff')))} Hz  `,
      h('span', { class: 'swatch s2' }), `Filter 2 · ${Math.round(cutoffHz(v('filter2.cutoff')))} Hz`,
    );
  };
  for (const id of ['filter1.cutoff', 'filter1.resonance', 'filter1.mode', 'filter2.cutoff', 'filter2.resonance', 'filter2.mode']) {
    reg.register(p(id).address, () => requestAnimationFrame(draw));
  }
  new ResizeObserver(() => draw()).observe(canvas);
  return h(
    'figure',
    { class: 'viz-wrap' },
    canvas,
    h('figcaption', {}, legend, h('span', { class: 'muted' }, 'Ideal 2-pole SVF response; frequency scale is approximate.')),
  );
}

export function filterPanel(reg: ControlRegistry): HTMLElement {
  const main = card(
    'Filter 1',
    filterResponse(reg),
    segmented(reg, p('filter1.mode'), 'Mode'),
    slider(reg, p('filter1.cutoff'), 'Cutoff'),
    slider(reg, p('filter1.resonance'), 'Resonance'),
  );
  const mod = card(
    'Cutoff modulation',
    slider(reg, p('filter.env'), 'Env 2 amount'),
    slider(reg, p('filter.lfo'), 'LFO 2 amount'),
    slider(reg, p('filter.velocity'), 'Velocity'),
    slider(reg, p('filter.keytrack'), 'Key tracking'),
  );
  const second = card(
    'Filter 2',
    h('p', { class: 'hint' }, 'Second filter stage, on voicecards that have one.'),
    segmented(reg, p('filter2.mode'), 'Mode'),
    slider(reg, p('filter2.cutoff'), 'Cutoff'),
    slider(reg, p('filter2.resonance'), 'Resonance'),
  );
  return section('filter', 'Filter', main, mod, second);
}

// ---------------------------------------------------------------------------

function envelopeEditor(reg: ControlRegistry, n: number): HTMLElement {
  const ids = ['attack', 'decay', 'sustain', 'release', 'curve'].map((k) => p(`env${n}.${k}`));
  const [A, D, S, R, C] = ids;
  const canvas = h('canvas', { class: 'viz viz-env', 'aria-label': `Envelope ${n}`, tabindex: -1 });
  let dragging: number | null = null;

  const layout = () => {
    const { width, height } = canvas.getBoundingClientRect();
    return envelopeLayout(reg.value(A), reg.value(D), reg.value(S), reg.value(R), width, height);
  };

  const draw = () => {
    if (!canvas.isConnected) return;
    const ctx = fitCanvas(canvas);
    const { width: w, height: hh } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, w, hh);
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
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    seg(pts[0], pts[1], true);
    seg(pts[1], pts[2], true);
    seg(pts[2], pts[3], false);
    seg(pts[3], pts[4], true);
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineTo(pts[0].x, pts[0].y);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = cssVar('--accent');
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--fg');
    for (const i of [1, 2, 4]) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, i === dragging ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // Drag the attack peak (time), decay/sustain point (time + level) and release end (time).
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pts = layout().points;
    let best: number | null = null;
    let bestD = 14;
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
    const seg = (r.width - 12) * 0.26;
    const toTime = (dx: number) => Math.round(((dx - 2) / seg) * 127);
    const toLevel = (yy: number) => Math.round(((r.height - 6 - yy) / (r.height - 12)) * 127);
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
  return canvas;
}

export function envelopePanel(reg: ControlRegistry): HTMLElement {
  const env = (n: number) =>
    card(
      `Envelope ${n}${n === 2 ? ' · filter' : n === 3 ? ' · amp' : ''}`,
      envelopeEditor(reg, n),
      slider(reg, p(`env${n}.attack`), 'Attack'),
      slider(reg, p(`env${n}.decay`), 'Decay'),
      slider(reg, p(`env${n}.sustain`), 'Sustain'),
      slider(reg, p(`env${n}.release`), 'Release'),
      withTitle(slider(reg, p(`env${n}.curve`), 'Curve'), '0 = exponential (YAM), 64 = linear, 127 = inverse exponential'),
    );
  return section('envelopes', 'Envelopes', env(1), env(2), env(3));
}

// ---------------------------------------------------------------------------

export function lfoPanel(reg: ControlRegistry): HTMLElement {
  const lfo = (n: number) =>
    card(
      `LFO ${n}`,
      select(reg, p(`lfo${n}.shape`), 'Shape'),
      slider(reg, p(`lfo${n}.rate`), 'Rate'),
      segmented(reg, p(`lfo${n}.sync`), 'Trigger'),
    );
  const voice = card(
    'Voice LFO (LFO 4) & voice',
    segmented(reg, p('lfo4.shape'), 'Shape'),
    slider(reg, p('lfo4.rate'), 'Rate'),
    slider(reg, p('voice.vintage'), 'Vintage'),
  );
  return section('lfos', 'LFOs', lfo(1), lfo(2), lfo(3), voice);
}

// ---------------------------------------------------------------------------

export function matrixPanel(reg: ControlRegistry): HTMLElement {
  const rows: HTMLElement[] = [];
  for (let i = 1; i <= 14; i++) {
    const src = p(`mod${i}.source`);
    const dst = p(`mod${i}.destination`);
    const amt = p(`mod${i}.amount`);
    const row = h(
      'div',
      { class: 'mod-row' },
      h('span', { class: 'mod-index' }, String(i)),
      select(reg, src, 'Source'),
      h('span', { class: 'mod-arrow', 'aria-hidden': 'true' }, '→'),
      select(reg, dst, 'Destination'),
      slider(reg, amt, 'Amount'),
    );
    reg.register(amt.address, () => row.classList.toggle('inactive', reg.value(amt) === 0));
    rows.push(row);
  }
  const matrix = h('section', { class: 'card card-wide' }, h('h3', {}, 'Modulation matrix'), h('div', { class: 'mod-grid' }, ...rows));

  const mods: HTMLElement[] = [];
  for (let i = 1; i <= 4; i++) {
    const op = p(`modifier${i}.operator`);
    const row = h(
      'div',
      { class: 'modifier-row' },
      h('span', { class: 'mod-index' }, `mod ${i}`),
      select(reg, p(`modifier${i}.in1`), 'Input 1'),
      select(reg, op, 'Operator'),
      select(reg, p(`modifier${i}.in2`), 'Input 2'),
    );
    reg.register(op.address, () => row.classList.toggle('inactive', reg.value(op) === 0));
    mods.push(row);
  }
  const modifiers = h(
    'section',
    { class: 'card card-wide' },
    h('h3', {}, 'Modifiers'),
    h('p', { class: 'hint' }, `Outputs appear as sources “${MOD_SOURCES[7]}” … “${MOD_SOURCES[10]}”. Destinations: ${MOD_DESTINATIONS.length}.`),
    h('div', { class: 'modifier-grid' }, ...mods),
  );
  return section('matrix', 'Modulation', matrix, modifiers);
}

// ---------------------------------------------------------------------------

export function partPanel(reg: ControlRegistry, mappingInfo: HTMLElement): HTMLElement {
  const settings = card(
    'Part',
    slider(reg, p('part.volume'), 'Volume'),
    slider(reg, p('part.octave'), 'Octave'),
    slider(reg, p('part.tuning'), 'Tuning'),
    select(reg, p('part.polyphony'), 'Voice mode'),
    slider(reg, p('part.spread'), 'Spread'),
    segmented(reg, p('part.spreadMode'), 'Spread mode'),
    toggle(reg, p('part.legato'), 'Legato'),
    slider(reg, p('part.portamento'), 'Portamento'),
    select(reg, p('part.raga'), 'Raga'),
  );
  const arp = card(
    'Arpeggiator',
    segmented(reg, p('arp.mode'), 'Mode'),
    select(reg, p('arp.direction'), 'Direction'),
    slider(reg, p('arp.octave'), 'Range (octaves)'),
    slider(reg, p('arp.pattern'), 'Pattern'),
    select(reg, p('arp.resolution'), 'Grid'),
    control(reg, p('seq.length1'), 'Seq 1 length'),
    control(reg, p('seq.length2'), 'Seq 2 length'),
    control(reg, p('seq.length3'), 'Pattern length'),
  );
  return section('part', 'Part settings', settings, arp, card('MIDI & voices', mappingInfo));
}
