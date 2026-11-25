// Application shell: header (MIDI, firmware, part selector, sync actions),
// editor panels, librarian and log.

import { MidiAccess } from '../midi/access';
import { initPatch, NUM_PARTS, txChannel, type PartMapping } from '../model/params/ambika';
import { formatLocation, StorageObject, versionString } from '../protocol/ambika';
import { RequestTimeout } from '../protocol/client';
import { SyncEngine } from '../sync/engine';
import { ControlRegistry } from './controls';
import { clear, h } from './dom';
import { librarianPanel } from './librarian';
import { envelopePanel, filterPanel, lfoPanel, matrixPanel, partPanel, voicePanel } from './panels';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export function startApp(root: HTMLElement): void {
  const midi = new MidiAccess();
  let selected = 0;
  const names: string[] = new Array(NUM_PARTS).fill('');
  const engine = new SyncEngine({ send: (b) => midi.send(b) });
  const reg = new ControlRegistry(engine, () => selected);

  // ---- Log ---------------------------------------------------------------
  const logList = h('ol', { class: 'log', 'aria-live': 'polite' });
  const log = (level: 'info' | 'warn' | 'error', text: string) => {
    const time = new Date().toLocaleTimeString();
    logList.prepend(h('li', { class: `log-${level}` }, h('time', {}, time), ' ', text));
    while (logList.childElementCount > 60) logList.lastElementChild?.remove();
  };
  engine.on('log', ({ level, text }) => log(level, text));

  // ---- Header ------------------------------------------------------------
  const connectBtn = h('button', { type: 'button', class: 'primary' }, 'Connect MIDI');
  const inSel = h('select', { 'aria-label': 'MIDI input' });
  const outSel = h('select', { 'aria-label': 'MIDI output' });
  const fwBadge = h('span', { class: 'fw-badge', title: 'Firmware detected with the version request (SysEx 0x1c)' }, 'not connected');
  const led = h('span', { class: 'led off', title: 'Link status' });
  const queueInfo = h('span', { class: 'queue muted' });
  const partTabs = h('nav', { class: 'part-tabs', 'aria-label': 'Part' });
  const partButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < NUM_PARTS; i++) {
    const b = h('button', { type: 'button', role: 'tab', onclick: () => selectPart(i) }, String(i + 1));
    partButtons.push(b);
    partTabs.append(b);
  }
  const pullBtn = h('button', { type: 'button', title: 'Request patch + part of the selected part (SysEx 0x13)' }, 'Pull part');
  const pullAllBtn = h('button', { type: 'button', title: 'Request the multi with all six parts (SysEx 0x14)' }, 'Pull all');
  const pushBtn = h('button', { type: 'button', title: 'Send the whole patch of the selected part (SysEx 0x01)' }, 'Push patch');
  const initBtn = h('button', { type: 'button', title: 'Reset the selected part to the YAM init patch and send it' }, 'Init patch');
  const partTitle = h('span', { class: 'part-title' });

  const notices = h('div', { class: 'notices' });

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('strong', {}, 'SHED'), h('span', { class: 'muted' }, ' Ambika editor')),
    h(
      'div',
      { class: 'midi-ports' },
      connectBtn,
      h('label', {}, 'In ', inSel),
      h('label', {}, 'Out ', outSel),
      led,
      fwBadge,
      queueInfo,
    ),
    h('div', { class: 'part-bar' }, h('span', { class: 'muted' }, 'Part'), partTabs, partTitle),
    h('div', { class: 'actions' }, pullBtn, pullAllBtn, pushBtn, initBtn),
  );

  // ---- Panels ------------------------------------------------------------
  const mappingInfo = h('div', { class: 'mapping' });
  const sections = [
    voicePanel(reg),
    filterPanel(reg),
    envelopePanel(reg),
    lfoPanel(reg),
    matrixPanel(reg),
    partPanel(reg, mappingInfo),
  ];
  const nav = h(
    'nav',
    { class: 'section-nav', 'aria-label': 'Sections' },
    ...sections.map((s) => h('a', { href: `#${s.id}` }, s.querySelector('h2')?.textContent ?? s.id)),
    h('a', { href: '#librarian' }, 'Librarian'),
  );
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    librarianPanel(engine, {
      selectedPart: () => selected,
      log,
      suggestedName: () => names[selected],
    }),
    h('section', { class: 'panel' }, h('h2', {}, 'Activity'), logList),
  );
  root.append(header, notices, h('div', { class: 'layout' }, h('main', { class: 'editor' }, nav, ...sections), sidebar));

  // ---- Behaviour ---------------------------------------------------------
  const renderMapping = () => {
    clear(mappingInfo);
    const m: PartMapping = engine.mappings[selected];
    const known = engine.mappingsKnown;
    const voices = [...Array(6).keys()].filter((v) => m.voices & (1 << v)).map((v) => v + 1);
    mappingInfo.append(
      h(
        'dl',
        {},
        h('dt', {}, 'MIDI channel'),
        h('dd', {}, m.channel === 0 ? 'omni (NRPN on 1)' : String(m.channel), known ? '' : ' (assumed — pull all to read it)'),
        h('dt', {}, 'Key range'),
        h('dd', {}, known ? `${noteName(m.keyLow)} – ${noteName(m.keyHigh)}` : '—'),
        h('dt', {}, 'Voicecards'),
        h('dd', {}, known ? voices.join(', ') || 'none' : '—'),
      ),
      h('p', { class: 'hint' }, 'Channel, key range and voice allocation are multi settings; edit them on the Ambika.'),
    );
  };

  const renderNotices = () => {
    clear(notices);
    const add = (cls: string, ...content: (string | Node)[]) => notices.append(h('div', { class: `notice ${cls}` }, ...content));
    if (!midi.supported) {
      add('error', 'This browser has no Web MIDI. Use Chrome or Edge on desktop (Safari has none, Firefox needs a site-permission add-on).');
      return;
    }
    if (midi.status === 'denied') {
      add('error', 'MIDI access was blocked. Allow MIDI and SysEx for this site in the browser’s site settings, then reload.');
    }
    if (midi.status === 'ready' && (!midi.selectedInput || !midi.selectedOutput)) {
      add('warn', 'Pick the MIDI input and output connected to the Ambika.');
    }
    if (midi.status === 'ready' && midi.selectedInput && !engine.hardwareEditsSeen) {
      add(
        'info',
        'Turn a knob on the Ambika: if SHED doesn’t follow, set ',
        h('strong', {}, 'System → outp mode'),
        ' to ',
        h('code', {}, 'ctrl'),
        ' or ',
        h('code', {}, 'full'),
        ' (and ',
        h('strong', {}, 'inpt filter'),
        ' must let NRPN in).',
      );
    }
    const siblings = engine.channelSiblings(selected);
    if (siblings.length) {
      add(
        'warn',
        `Part ${selected + 1} shares MIDI channel ${txChannel(engine.mappings[selected]) + 1} with part${siblings.length > 1 ? 's' : ''} ${siblings
          .map((s) => s + 1)
          .join(', ')}: edits change all of them.`,
      );
    }
    if (engine.firmware === 'stock') {
      add('info', 'Stock YAM detected: BAMBI parameters (marked +) are disabled; requests run one at a time.');
    }
  };

  const renderFirmware = () => {
    const fw = engine.client.firmware;
    if (engine.firmware === 'yamplus' && fw) {
      const cards = fw.voicecards.filter((c) => c.present).map((c) => `v${versionString(c.version)}`);
      fwBadge.textContent = `BAMBI · YAM+ ${versionString(fw.yamPlusVersion)}`;
      fwBadge.title = `Controller ${versionString(fw.controllerVersion)}, ${fw.oscShapes} oscillator shapes, patch layout ${fw.patchLayout}, part layout ${fw.partLayout}, voicecards: ${cards.join(' ') || 'none'}`;
      fwBadge.className = 'fw-badge plus';
    } else if (engine.firmware === 'stock') {
      fwBadge.textContent = 'YAM (stock)';
      fwBadge.title = 'No reply to the version request: stock YAM or another Ambika firmware';
      fwBadge.className = 'fw-badge stock';
    } else {
      fwBadge.textContent = midi.selectedOutput ? 'detecting…' : 'not connected';
      fwBadge.className = 'fw-badge';
    }
    reg.refreshAvailability();
  };

  const renderPartTitle = () => {
    partButtons.forEach((b, i) => {
      b.setAttribute('aria-selected', String(i === selected));
      b.classList.toggle('synced', engine.parts[i].synced);
    });
    partTitle.textContent = names[selected] ? `“${names[selected]}”` : engine.parts[selected].synced ? '' : '(not pulled yet)';
  };

  const selectPart = (i: number) => {
    selected = i;
    engine.selectedPart = i;
    reg.refreshAll();
    renderPartTitle();
    renderMapping();
    renderNotices();
  };

  const fetchNames = async () => {
    if (engine.firmware !== 'yamplus') return;
    try {
      for (let part = 1; part <= NUM_PARTS; part++) {
        const reply = await engine.client.requestName(part, StorageObject.Program);
        names[part - 1] = reply.status === 0 ? reply.name : '';
        if (reply.status === 0) log('info', `Part ${part}: ${formatLocation(reply.location)} “${reply.name}”`);
      }
    } catch (e) {
      log('warn', `Names: ${(e as Error).message}`);
    }
    renderPartTitle();
  };

  const guard = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof RequestTimeout ? `${(e as Error).message} — check the cable, ports and that SysEx reaches the Ambika` : (e as Error).message;
      log('error', `${what}: ${msg}`);
    }
  };

  const connectLink = async () => {
    engine.resetLink();
    renderFirmware();
    renderNotices();
    if (!midi.selectedInput || !midi.selectedOutput) return;
    await guard('Detect', async () => {
      const mode = await engine.detect();
      log('info', mode === 'yamplus' ? 'BAMBI (YAM+) firmware detected' : 'No version reply: assuming stock YAM');
    });
    renderFirmware();
    await guard('Pull all', async () => {
      await engine.pullAll();
      log('info', 'Pulled all six parts and the multi');
    });
    await fetchNames();
    renderNotices();
  };

  const fillPorts = () => {
    const fill = (sel: HTMLSelectElement, ports: { id: string; name: string; state: string }[], current: string | undefined) => {
      clear(sel);
      sel.append(h('option', { value: '' }, ports.length ? '— choose —' : '— none —'));
      for (const port of ports) {
        sel.append(h('option', { value: port.id, disabled: port.state !== 'connected' }, port.name));
      }
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
    // Restored ports fire a selection event, which starts the link.
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
    if (key !== lastSelection) {
      lastSelection = key;
      if (input && output) void connectLink();
      else {
        engine.resetLink();
        renderFirmware();
        renderNotices();
      }
    }
  });
  midi.on('ports', fillPorts);
  midi.on('status', renderNotices);
  midi.on('message', ({ data }) => engine.handleMidi(data));

  pullBtn.addEventListener('click', () =>
    guard('Pull part', async () => {
      await engine.pullPart(selected);
      log('info', `Pulled part ${selected + 1}`);
    }),
  );
  pullAllBtn.addEventListener('click', () =>
    guard('Pull all', async () => {
      await engine.pullAll();
      log('info', 'Pulled all six parts and the multi');
      await fetchNames();
    }),
  );
  pushBtn.addEventListener('click', () => {
    engine.pushPatch(selected);
    log('info', `Sent patch to part ${selected + 1}`);
  });
  initBtn.addEventListener('click', () => {
    if (!confirm(`Replace part ${selected + 1}'s patch with the init patch? (The synth's stored program is not touched until you save it there.)`)) return;
    engine.loadPart(selected, initPatch());
    names[selected] = '';
    renderPartTitle();
  });

  engine.on('param', ({ part, address, origin }) => {
    if (part !== selected) return;
    reg.update(address);
    if (origin === 'hardware') reg.flash(address);
  });
  engine.on('part', ({ part }) => {
    if (part === selected) reg.refreshAll();
    renderPartTitle();
  });
  engine.on('mappings', () => {
    renderMapping();
    renderNotices();
  });
  engine.on('hardwareEdit', () => {
    if (notices.querySelector('.notice.info')) renderNotices();
  });
  engine.on('busy', (busy) => {
    led.classList.toggle('busy', busy);
  });

  // Link LED and queue meter.
  setInterval(() => {
    const connected = !!(midi.selectedInput && midi.selectedOutput);
    led.classList.toggle('off', !connected);
    led.classList.toggle('on', connected);
    const pending = engine.scheduler.pending();
    queueInfo.textContent = pending ? `${pending} queued` : '';
  }, 250);

  selectPart(0);
  renderFirmware();
  renderNotices();
  log('info', 'Ready. Click “Connect MIDI” and allow MIDI + SysEx access.');
}
