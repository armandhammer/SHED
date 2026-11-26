// Shruthi-1 editor shell: connection strip, header (display, actions),
// the panel, librarian and log. The Ambika's counterpart is app.ts.

import { MidiAccess } from '../midi/access';
import { SHRUTHI_PARAMS, nrpnParam, shruthiInitPatch } from '../model/params/shruthi';
import { formatValue } from '../model/params/types';
import { shoozVersionString } from '../protocol/shruthi';
import { ShruthiTimeout } from '../protocol/shruthi-client';
import { createVirtualShruthiMidi, virtualShruthiFromQuery } from '../sim/virtual-midi';
import { SHRUTHI_OUT_MODE } from '../sim/virtual-shruthi';
import { SHRUTHI_SYS, ShruthiEngine } from '../sync/shruthi-engine';
import { ControlRegistry } from './controls';
import { deviceSwitch } from './device';
import { clear, h } from './dom';
import { librarianPanel } from './librarian';
import { ShruthiControls, shruthiDef } from './shruthi-defs';
import { shruthiPanel } from './shruthi-panels';

export function startShruthiApp(root: HTMLElement): void {
  // `?virtual=shooz|shruthi`: a simulated Shruthi instead of real MIDI ports.
  const virtualSetup = virtualShruthiFromQuery(location.search);
  const virtual = virtualSetup ? createVirtualShruthiMidi(virtualSetup) : null;
  const midi = new MidiAccess(virtual ? async () => virtual.access : undefined);
  if (virtual) (window as unknown as { virtualShruthi: unknown }).virtualShruthi = virtual.synth;
  const engine = new ShruthiEngine({
    send: (b) => {
      const ok = midi.send(b);
      if (ok) blink(outLed);
      return ok;
    },
  });
  const reg = new ControlRegistry(new ShruthiControls(engine));

  // ---- Log ---------------------------------------------------------------
  const logList = h('ol', { class: 'log', 'aria-live': 'polite' });
  const log = (level: 'info' | 'warn' | 'error', text: string) => {
    const time = new Date().toLocaleTimeString();
    logList.prepend(h('li', { class: `log-${level}` }, h('time', {}, time), ' ', text));
    while (logList.childElementCount > 60) logList.lastElementChild?.remove();
  };
  engine.on('log', ({ level, text }) => log(level, text));

  // ---- Connection strip ----------------------------------------------------
  const connectBtn = h('button', { type: 'button', class: 'primary' }, 'Connect MIDI');
  const inSel = h('select', { 'aria-label': 'MIDI input' });
  const outSel = h('select', { 'aria-label': 'MIDI output' });
  const fwBadge = h('span', { class: 'fw-badge', title: 'Firmware detected with the version request (SysEx 0x1c)' }, 'not connected');
  const led = h('span', { class: 'led off', title: 'Link status' });
  const queueInfo = h('span', { class: 'queue' });
  const strip = h('div', { class: 'conn-strip' }, deviceSwitch('shruthi'), connectBtn, h('label', {}, 'In ', inSel), h('label', {}, 'Out ', outSel), led, fwBadge, queueInfo);
  const notices = h('div', { class: 'notices' });

  // ---- Header ----------------------------------------------------------------
  const vfdTop = h('div', { class: 'vfd-line vfd-main' });
  const vfdBottom = h('div', { class: 'vfd-line vfd-sub' });
  const vfd = h('div', { class: 'vfd', role: 'status', 'aria-live': 'polite' }, vfdTop, vfdBottom);
  const action = (label: string, title: string) => h('button', { type: 'button', class: 'panel-btn', title }, label);
  const pullBtn = action('Pull', 'Read the patch and system settings from the Shruthi (SysEx 0x11, 0x14)');
  const pushBtn = action('Push', 'Send the whole patch to the Shruthi’s edit buffer (SysEx 0x01)');
  const initBtn = action('Init', 'Reset to the init patch and send it');
  const writeBtn = action('Write…', 'Store the edit buffer in a patch slot on the Shruthi (SysEx 0x21)');
  const libraryBtn = action('Library', 'Jump to the librarian');
  libraryBtn.addEventListener('click', () => document.getElementById('librarian')?.scrollIntoView({ behavior: 'smooth' }));
  const header = h(
    'header',
    { class: 'panel-header' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-name' }, 'SHED'), h('div', { class: 'brand-sub' }, 'Shruthi-1 editor')),
    vfd,
    h('div', { class: 'header-right' }, h('div', { class: 'panel-actions' }, pullBtn, pushBtn, initBtn, writeBtn, libraryBtn)),
  );

  const inLed = h('span', { class: 'status-led' });
  const outLed = h('span', { class: 'status-led' });
  const footer = h(
    'footer',
    { class: 'panel-footer' },
    h('span', {}, inLed, 'MIDI in'),
    h('span', {}, outLed, 'MIDI out'),
    h('span', { class: 'footer-right' }, h('span', { class: 'badge-plus' }, '+'), ' SHOOZ only'),
  );
  const instrument = h(
    'div',
    { class: 'instrument instrument-shruthi' },
    h('div', { class: 'cheek cheek-left', 'aria-hidden': 'true' }),
    h('main', { class: 'panel-body' }, header, shruthiPanel(reg), footer),
    h('div', { class: 'cheek cheek-right', 'aria-hidden': 'true' }),
  );
  const rack = h(
    'div',
    { class: 'rack' },
    librarianPanel({
      device: 'shruthi',
      log,
      suggestedName: () => engine.name,
      defaultName: () => `Shruthi ${new Date().toLocaleString()}`,
      programs: false,
      snapshot: () => ({ patch: engine.wirePatch() }),
      load: (entry) => engine.loadPatch(entry.patch),
      loadTitle: () => 'Load into the editor and send to the Shruthi',
    }),
    h('section', { class: 'rack-panel' }, h('h2', {}, 'Activity'), logList),
  );
  root.append(strip, notices, instrument, rack);

  // ---- Behaviour ---------------------------------------------------------
  const blink = (el: HTMLElement) => {
    el.classList.add('on');
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(setTimeout(() => el.classList.remove('on'), 120));
  };

  let lastEdit = '';
  const renderVfd = () => {
    const name = engine.synced ? engine.name || '(no name)' : 'not pulled yet';
    vfdTop.replaceChildren(h('span', {}, name.toUpperCase()));
    const ch = engine.mem[SHRUTHI_SYS.midiChannel];
    const fw = engine.mode === 'shooz' ? `SHOOZ ${shoozVersionString(engine.client.firmware?.shooz?.version ?? 0)}` : engine.mode === 'stock' ? 'YAM' : '';
    vfdBottom.replaceChildren(
      ...[h('span', {}, lastEdit || 'READY'), h('span', {}, engine.systemKnown ? (ch === 0 ? 'OMNI' : `CH ${ch}`) : 'CH ?'), fw ? h('span', {}, fw) : null].filter((x) => x !== null),
    );
  };

  const renderNotices = () => {
    clear(notices);
    const add = (cls: string, ...content: (string | Node)[]) => notices.append(h('div', { class: `notice ${cls}` }, ...content));
    if (!midi.supported) {
      add('error', 'This browser has no Web MIDI. Use Chrome or Edge on desktop.');
      return;
    }
    if (virtual) {
      const synth = virtual.synth;
      const cutoff = SHRUTHI_PARAMS[12];
      const knob = h(
        'button',
        { type: 'button', onclick: () => synth.edit(cutoff, (synth.value(cutoff) + 17) % 128) },
        'Turn its cutoff knob',
      );
      const outName = Object.entries(SHRUTHI_OUT_MODE).find(([, v]) => v === synth.outMode)?.[0] ?? String(synth.outMode);
      add('info', `Simulated Shruthi (${synth.firmware === 'shooz' ? 'SHOOZ' : 'stock YAM'}, MIDI out ${outName}): no hardware involved. `, knob);
    }
    if (midi.status === 'denied') add('error', 'MIDI access was blocked. Allow MIDI and SysEx for this site in the browser’s site settings, then reload.');
    if (midi.status === 'ready' && (!midi.selectedInput || !midi.selectedOutput)) add('warn', 'Pick the MIDI input and output connected to the Shruthi.');
    if (engine.mode === 'absent') {
      add('error', 'No reply from a Shruthi: check both MIDI cables, and that the Shruthi listens on the channel it shows (system page “midi chan”).');
    }
    if (midi.status === 'ready' && midi.selectedInput && engine.mode !== 'absent' && !engine.hardwareEditsSeen) {
      add(
        'info',
        'Turn a knob on the Shruthi: if SHED doesn’t follow, set the system page’s ',
        h('strong', {}, 'midi out'),
        ' to ',
        h('code', {}, 'ctrl'),
        ' or ',
        h('code', {}, 'full'),
        ' (the factory setting ',
        h('code', {}, 'thru'),
        ' only echoes).',
      );
    }
    if (engine.mode === 'stock') add('info', 'Stock YAM detected: SHOOZ parameters (envelope curves, vintage, marked +) are disabled.');
  };

  const renderFirmware = () => {
    const fw = engine.client.firmware;
    if (engine.mode === 'shooz' && fw?.shooz) {
      fwBadge.textContent = `SHOOZ ${shoozVersionString(fw.shooz.version)}`;
      fwBadge.title = `${fw.shooz.waveforms} waveforms, patch layout ${fw.shooz.patchLayout}, free stack ${fw.shooz.freeStack} B, ${fw.shooz.glitches} audio glitches since power-on`;
      fwBadge.className = 'fw-badge plus';
    } else if (engine.mode === 'stock') {
      fwBadge.textContent = 'YAM (stock)';
      fwBadge.title = 'Version reply without the SHOOZ capability bytes';
      fwBadge.className = 'fw-badge stock';
    } else if (engine.mode === 'absent') {
      fwBadge.textContent = 'no reply';
      fwBadge.className = 'fw-badge';
    } else {
      fwBadge.textContent = midi.selectedOutput ? 'detecting…' : 'not connected';
      fwBadge.className = 'fw-badge';
    }
    reg.refreshAvailability();
    renderVfd();
  };

  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof ShruthiTimeout ? `${(e as Error).message}: check the cables, the ports and the Shruthi’s MIDI channel` : (e as Error).message;
      log('error', `${what}: ${msg}`);
    }
  };

  const pull = async () => {
    await guard('Pull', async () => {
      await engine.pullSystem();
      await engine.pullPatch();
      log('info', `Pulled “${engine.name}” and the system settings`);
    });
  };

  const connectLink = async () => {
    engine.resetLink();
    renderFirmware();
    renderNotices();
    if (!midi.selectedInput || !midi.selectedOutput) return;
    await guard('Detect', async () => {
      const mode = await engine.detect();
      log(mode === 'absent' ? 'warn' : 'info', mode === 'shooz' ? 'SHOOZ firmware detected' : mode === 'stock' ? 'Stock YAM firmware detected' : 'No reply to the version request');
    });
    renderFirmware();
    if (engine.mode !== 'absent') await pull();
    renderNotices();
  };

  const fillPorts = () => {
    const fill = (sel: HTMLSelectElement, ports: { id: string; name: string; state: string }[], current: string | undefined) => {
      clear(sel);
      sel.append(h('option', { value: '' }, ports.length ? '— choose —' : '— none —'));
      for (const port of ports) sel.append(h('option', { value: port.id, disabled: port.state !== 'connected' }, port.name));
      sel.value = current ?? '';
    };
    fill(inSel, midi.inputs(), midi.selectedInput?.id);
    fill(outSel, midi.outputs(), midi.selectedOutput?.id);
  };

  connectBtn.addEventListener('click', async () => {
    if (midi.status === 'ready') {
      void connectLink();
      return;
    }
    const ok = await midi.request();
    if (!ok) {
      log('error', `MIDI access failed${midi.error ? `: ${midi.error}` : ''}`);
      renderNotices();
      return;
    }
    connectBtn.textContent = 'Reconnect';
    fillPorts();
    renderNotices();
  });
  inSel.addEventListener('change', () => midi.selectInput(inSel.value || null));
  outSel.addEventListener('change', () => midi.selectOutput(outSel.value || null));

  let lastSelection = '';
  midi.on('selection', ({ input, output }) => {
    fillPorts();
    const key = `${input?.id ?? ''}|${output?.id ?? ''}`;
    if (key === lastSelection) return;
    lastSelection = key;
    if (input && output) void connectLink();
    else {
      engine.resetLink();
      renderFirmware();
      renderNotices();
    }
  });
  midi.on('ports', fillPorts);
  midi.on('status', renderNotices);
  midi.on('message', ({ data }) => {
    blink(inLed);
    engine.handleMidi(data);
  });

  pullBtn.addEventListener('click', () => void pull());
  pushBtn.addEventListener('click', () => {
    engine.pushPatch();
    log('info', `Sent “${engine.name}” to the Shruthi`);
  });
  initBtn.addEventListener('click', () => {
    if (!confirm('Replace the edit buffer with the init patch? (Stored patches are not touched.)')) return;
    engine.loadPatch(shruthiInitPatch());
  });
  writeBtn.addEventListener('click', () => {
    const typed = prompt('Store the edit buffer in patch slot (1–16 internal, 17+ on an EEPROM bank):', '1');
    if (typed === null) return;
    const n = Number(typed);
    if (!Number.isInteger(n) || n < 1 || n > 16 + 64 * 8) {
      log('warn', `“${typed}” is not a patch slot`);
      return;
    }
    if (!confirm(`Overwrite patch ${n} on the Shruthi with “${engine.name}”?`)) return;
    engine.writeSlot(n - 1);
    log('info', `Wrote “${engine.name}” to patch ${n}`);
  });

  engine.on('param', ({ address, origin }) => {
    reg.update(address);
    if (origin === 'hardware') reg.flash(address);
    const p = nrpnParam(address);
    if (p && !p.uiOnly) {
      const def = shruthiDef(p, address);
      lastEdit = `${def.name.toUpperCase()} ${formatValue(def, reg.value(def))}`;
      renderVfd();
    }
  });
  engine.on('patch', () => {
    reg.refreshAll();
    renderVfd();
  });
  engine.on('hardwareEdit', () => {
    if (notices.querySelector('.notice.info')) renderNotices();
  });
  engine.on('busy', (busy) => led.classList.toggle('busy', busy));

  setInterval(() => {
    const connected = !!(midi.selectedInput && midi.selectedOutput);
    led.classList.toggle('off', !connected);
    led.classList.toggle('on', connected);
    const pending = engine.scheduler.pending();
    queueInfo.textContent = pending ? `${pending} queued` : '';
  }, 250);

  reg.refreshAll();
  renderFirmware();
  renderNotices();
  log('info', 'Ready. Click “Connect MIDI” and allow MIDI + SysEx access.');
}
