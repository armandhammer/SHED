// The Shruthi-1 patch laid out as an instrument panel: oscillators, mixer,
// filter (with the controls of the selected filter board), two envelopes
// with graphs and curve presets, LFOs, the 12-row modulation matrix, the two
// CV operators, sequencer/arpeggiator, keyboard and system settings.

import { FILTER_BOARDS, FILTER_BOARD_NAMES, type FilterBoard } from '../model/params/shruthi';
import { fader, knob, leds, ledToggle, menu, type ControlRegistry, type KnobSize } from './controls';
import { h } from './dom';
import { adsrGraph, row, section } from './panels';
import { CURVE_PRESET_VALUES, boardParams, sdef } from './shruthi-defs';

const k = (reg: ControlRegistry, id: string, label: string, size: KnobSize = 'md') => knob(reg, sdef(id), label, size);
const m = (reg: ControlRegistry, id: string, label: string) => menu(reg, sdef(id), label);

function oscillator(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  return section(
    'osc',
    `Oscillator ${n}`,
    3,
    null,
    row('controls menus', m(reg, `osc${n}.shape`, 'Wave')),
    row('controls', k(reg, `osc${n}.param`, 'Param'), k(reg, `osc${n}.range`, 'Range'), n === 2 ? k(reg, 'osc2.detune', 'Detune') : null),
  );
}

function mixer(reg: ControlRegistry): HTMLElement {
  return section(
    'mix',
    'Mixer',
    6,
    null,
    row('controls menus', m(reg, 'mix.operator', 'Operator'), m(reg, 'mix.subShape', 'Sub wave')),
    row('controls', k(reg, 'mix.balance', 'Osc 1·2'), k(reg, 'mix.sub', 'Sub'), k(reg, 'mix.noise', 'Noise')),
  );
}

/** Controls of one expansion board's page, shown only while that board is selected. */
function boardPage(reg: ControlRegistry, board: FilterBoard): HTMLElement | null {
  const defs = boardParams(board);
  if (!defs.length) return null;
  const controls = defs.map((d) => {
    if (d.unit === 'bool') return ledToggle(reg, d, d.name);
    if (d.unit === 'enum') return d.max - d.min <= 3 ? leds(reg, d, d.name) : menu(reg, d, d.name);
    return knob(reg, d, d.name);
  });
  return h('div', { class: 'board-page', 'data-board': board }, h('h3', { class: 'sub-heading' }, h('span', {}, FILTER_BOARD_NAMES[board])), row('controls', ...controls));
}

function filter(reg: ControlRegistry): HTMLElement {
  const boardDef = sdef('sys.filterBoard');
  const note = h('span', {});
  const pages = FILTER_BOARDS.map((b) => boardPage(reg, b)).filter((x): x is HTMLElement => x !== null);
  reg.register(boardDef.address, () => {
    const board = FILTER_BOARDS[reg.value(boardDef)] ?? 'lpf';
    note.textContent = FILTER_BOARD_NAMES[board];
    for (const page of pages) page.hidden = page.dataset.board !== board;
  });
  return section(
    'filter',
    'Filter',
    6,
    note,
    row('filter-knobs', k(reg, 'filter.cutoff', 'Cutoff', 'lg'), k(reg, 'filter.resonance', 'Resonance', 'lg'), k(reg, 'filter.env1', 'Env 1', 'lg'), k(reg, 'filter.lfo2', 'LFO 2', 'lg')),
    ...pages,
  );
}

function envelope(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  const [A, D, S, R] = ['attack', 'decay', 'sustain', 'release'].map((key) => sdef(`env${n}.${key}`));
  const curve = sdef(`env${n}.curve`);
  const graph = adsrGraph(
    reg,
    { A, D, S, R, curve, curveValue: () => (reg.engine.supports(curve) ? CURVE_PRESET_VALUES[reg.value(curve)] ?? 0 : 0) },
    `Envelope ${n}`,
  );
  const curveMenu = menu(reg, curve, 'Curve', { compact: true });
  curveMenu.querySelector('.ctl-name')?.setAttribute('title', 'SHOOZ curve preset: 0 = exponential (stock), 4 = linear, 7 = inverse exponential');
  return section(
    'env',
    `Env ${n}`,
    6,
    n === 1 ? 'Filter (env1→vcf)' : 'Amp',
    row('env-row', graph, row('faders', fader(reg, A, 'A'), fader(reg, D, 'D'), fader(reg, S, 'S'), fader(reg, R, 'R'))),
    row('controls menus', curveMenu),
  );
}

function lfoCard(reg: ControlRegistry, n: 1 | 2): HTMLElement {
  return h(
    'div',
    { class: 'lfo-card' },
    k(reg, `lfo${n}.rate`, 'Rate', 'sm'),
    h(
      'div',
      { class: 'lfo-body' },
      h('div', { class: 'lfo-head' }, h('span', { class: 'lfo-name' }, `LFO ${n}`), menu(reg, sdef(`lfo${n}.shape`), `LFO ${n} shape`, { hideLabel: true })),
      leds(reg, sdef(`lfo${n}.mode`), 'Mode', { hideLabel: true, small: true }),
    ),
    k(reg, `lfo${n}.attack`, 'Fade in', 'sm'),
  );
}

function lfos(reg: ControlRegistry): HTMLElement {
  return section('lfo', 'LFOs', 6, null, row('lfo-row lfo-row-stack', lfoCard(reg, 1), lfoCard(reg, 2)));
}

function modRow(reg: ControlRegistry, i: number): HTMLElement {
  const amt = sdef(`mod${i}.amount`);
  const slot = h(
    'div',
    { class: 'mod-slot' },
    h('span', { class: 'mod-index' }, String(i)),
    menu(reg, sdef(`mod${i}.source`), `Row ${i} source`, { hideLabel: true, compact: true }),
    h('span', { class: 'mod-arrow', 'aria-hidden': 'true' }, '▼'),
    menu(reg, sdef(`mod${i}.destination`), `Row ${i} destination`, { hideLabel: true, compact: true }),
    knob(reg, amt, `Row ${i} amount`, 'sm'),
  );
  reg.register(amt.address, () => slot.classList.toggle('inactive', reg.value(amt) === 0));
  return slot;
}

function operator(reg: ControlRegistry, i: 1 | 2): HTMLElement {
  const out = sdef(`op${i}.out`);
  const slot = h(
    'div',
    { class: 'modifier-slot' },
    h('span', { class: 'mod-index' }, `Op ${i}`),
    menu(reg, sdef(`op${i}.in1`), 'In 1', { compact: true }),
    menu(reg, out, 'Operator', { compact: true }),
    menu(reg, sdef(`op${i}.in2`), 'In 2', { compact: true }),
  );
  reg.register(out.address, () => slot.classList.toggle('inactive', reg.value(out) === 0));
  return slot;
}

function modulation(reg: ControlRegistry): HTMLElement {
  const rows: HTMLElement[] = [];
  for (let i = 1; i <= 12; i++) rows.push(modRow(reg, i));
  return section(
    'mod',
    'Modulation',
    12,
    '12 rows · source / destination / amount',
    h('div', { class: 'mod-grid mod-grid-6' }, ...rows),
    h('h3', { class: 'sub-heading' }, h('span', {}, 'Operators'), h('span', { class: 'sec-note' }, 'outputs are sources “op. 1” and “op. 2”')),
    h('div', { class: 'modifier-grid modifier-grid-2' }, operator(reg, 1), operator(reg, 2)),
  );
}

function sequencer(reg: ControlRegistry): HTMLElement {
  return section(
    'part',
    'Sequencer / Arp',
    7,
    null,
    row('controls', leds(reg, sdef('seq.mode'), 'Mode'), m(reg, 'seq.groove', 'Groove'), m(reg, 'arp.direction', 'Direction'), m(reg, 'arp.division', 'Grid')),
    row(
      'controls',
      k(reg, 'seq.tempo', 'Tempo', 'sm'),
      k(reg, 'seq.grooveAmount', 'Amount', 'sm'),
      k(reg, 'arp.range', 'Range', 'sm'),
      k(reg, 'arp.pattern', 'Pattern', 'sm'),
      k(reg, 'seq.start', 'Start', 'sm'),
      k(reg, 'seq.length', 'Length', 'sm'),
    ),
  );
}

function keyboard(reg: ControlRegistry): HTMLElement {
  return section(
    'part',
    'Keyboard',
    5,
    null,
    row('controls', m(reg, 'sys.raga', 'Raga'), ledToggle(reg, sdef('sys.legato'), 'Legato')),
    row('controls', k(reg, 'sys.octave', 'Octave'), k(reg, 'sys.portamento', 'Glide')),
  );
}

function system(reg: ControlRegistry, saveButton: HTMLElement | null): HTMLElement {
  return section(
    'part',
    'System',
    12,
    'applied live; saved with “Save system” or the Shruthi’s system page',
    row(
      'controls',
      m(reg, 'sys.filterBoard', 'Filter board'),
      m(reg, 'sys.midiChannel', 'MIDI channel'),
      m(reg, 'sys.midiOut', 'MIDI out'),
      k(reg, 'sys.tuning', 'Tuning'),
      k(reg, 'sys.vintage', 'Vintage'),
    ),
    // SHOOZ "filter cal" page: how this unit's filter board responds.
    h('h3', { class: 'sub-heading' }, h('span', {}, 'Filter calibration'), h('span', { class: 'sec-note' }, 'per unit, not per patch')),
    row(
      'controls',
      m(reg, 'sys.filterProfile', 'Profile'),
      k(reg, 'sys.filterCutoffOffset', 'Cutoff offset', 'sm'),
      k(reg, 'sys.filterResonanceMax', 'Reso max', 'sm'),
      saveButton,
    ),
  );
}

/**
 * Every section of the Shruthi panel, in reading order. `saveSystemButton`
 * (wired by the app) goes next to the filter calibration.
 */
export function shruthiPanel(reg: ControlRegistry, saveSystemButton: HTMLElement | null = null): HTMLElement {
  return h(
    'div',
    { class: 'panel-grid' },
    oscillator(reg, 1),
    oscillator(reg, 2),
    mixer(reg),
    filter(reg),
    lfos(reg),
    envelope(reg, 1),
    envelope(reg, 2),
    modulation(reg),
    sequencer(reg),
    keyboard(reg),
    system(reg, saveSystemButton),
  );
}
