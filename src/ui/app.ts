// Application shell: header (MIDI, firmware, part selector, sync actions),
// editor panels, librarian and log.

import { MidiAccess } from '../midi/access';
import { initPatch, NUM_PARTS, paramAt, txChannel, type PartMapping } from '../model/params/ambika';
import { formatValue } from '../model/params/types';
import { formatLocation, StorageObject, versionString } from '../protocol/ambika';
import { RequestTimeout } from '../protocol/client';
import { createVirtualMidi, virtualSetupFromQuery } from '../sim/virtual-midi';
import { SyncEngine } from '../sync/engine';
import { ControlRegistry } from './controls';
import { clear, h } from './dom';
import { deviceSwitch } from './device';
import { librarianPanel } from './librarian';
import { instrumentPanel } from './panels';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export function startApp(root: HTMLElement): void {
  // `?virtual=bambi|stock`: a simulated Ambika instead of real MIDI ports.
  const virtualSetup = virtualSetupFromQuery(location.search);
  const virtual = virtualSetup ? createVirtualMidi(virtualSetup) : null;
  const midi = new MidiAccess(virtual ? async () => virtual.access : undefined);
  if (virtual) (window as unknown as { virtualAmbika: unknown }).virtualAmbika = virtual.synth;
  let selected = 0;
  const names: string[] = new Array(NUM_PARTS).fill('');
  const locations: string[] = new Array(NUM_PARTS).fill('');
  const engine = new SyncEngine({
    send: (b) => {
      const ok = midi.send(b);
      if (ok) blink(outLed);
      return ok;
    },
  });
  const reg = new ControlRegistry(engine, () => selected);

  // ---- Log ---------------------------------------------------------------
  const logList = h('ol', { class: 'log', 'aria-live': 'polite' });
  const log = (level: 'info' | 'warn' | 'error', text: string) => {
    const time = new Date().toLocaleTimeString();
    logList.prepend(h('li', { class: `log-${level}` }, h('time', {}, time), ' ', text));
    while (logList.childElementCount > 60) logList.lastElementChild?.remove();
  };
  engine.on('log', ({ level, text }) => log(level, text));

  // ---- Connection strip (above the instrument) -----------------------------
  const connectBtn = h('button', { type: 'button', class: 'primary' }, 'Connect MIDI');
  const inSel = h('select', { 'aria-label': 'MIDI input' });
  const outSel = h('select', { 'aria-label': 'MIDI output' });
  const fwBadge = h('span', { class: 'fw-badge', title: 'Firmware detected with the version request (SysEx 0x1c)' }, 'not connected');
  const led = h('span', { class: 'led off', title: 'Link status' });
  const queueInfo = h('span', { class: 'queue' });
  const strip = h(
    'div',
    { class: 'conn-strip' },
    deviceSwitch('ambika'),
    connectBtn,
    h('label', {}, 'In ', inSel),
    h('label', {}, 'Out ', outSel),
    led,
    fwBadge,
    queueInfo,
  );
  const notices = h('div', { class: 'notices' });

  // ---- Instrument header: name, display, part keys, actions ----------------
  const vfdTop = h('div', { class: 'vfd-line vfd-main' });
  const vfdBottom = h('div', { class: 'vfd-line vfd-sub' });
  const vfd = h('div', { class: 'vfd', role: 'status', 'aria-live': 'polite' }, vfdTop, vfdBottom);
  const partKeys = h('div', { class: 'part-keys', role: 'tablist', 'aria-label': 'Part' });
  const partButtons: HTMLButtonElement[] = [];
  for (let i = 0; i < NUM_PARTS; i++) {
    const b = h('button', { type: 'button', role: 'tab', class: 'part-key', onclick: () => selectPart(i), title: `Part ${i + 1}` }, String(i + 1));
    partButtons.push(b);
    partKeys.append(b);
  }
  const action = (label: string, title: string) => h('button', { type: 'button', class: 'panel-btn', title }, label);
  const pullBtn = action('Pull', 'Request patch + part of the selected part (SysEx 0x13)');
  const pullAllBtn = action('Pull all', 'Request the multi with all six parts (SysEx 0x14)');
  const pushBtn = action('Push', 'Send the whole patch of the selected part (SysEx 0x01)');
  const initBtn = action('Init', 'Reset the selected part to the YAM init patch and send it');
  const libraryBtn = action('Library', 'Jump to the librarian');
  libraryBtn.addEventListener('click', () => document.getElementById('librarian')?.scrollIntoView({ behavior: 'smooth' }));

  const header = h(
    'header',
    { class: 'panel-header' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-name' }, 'SHED'), h('div', { class: 'brand-sub' }, 'Six-part hybrid poly editor')),
    vfd,
    h('div', { class: 'header-right' }, partKeys, h('div', { class: 'panel-actions' }, pullBtn, pullAllBtn, pushBtn, initBtn, libraryBtn)),
  );

  // ---- Panel ---------------------------------------------------------------
  const mappingInfo = h('span', { class: 'mapping' });
  const inLed = h('span', { class: 'status-led' });
  const outLed = h('span', { class: 'status-led' });
  const footer = h(
    'footer',
    { class: 'panel-footer' },
    h('span', {}, inLed, 'MIDI in'),
    h('span', {}, outLed, 'MIDI out'),
    h('span', { class: 'footer-right' }, h('span', { class: 'badge-plus' }, '+'), ' BAMBI only'),
  );
  const instrument = h(
    'div',
    { class: 'instrument' },
    h('div', { class: 'cheek cheek-left', 'aria-hidden': 'true' }),
    h('main', { class: 'panel-body' }, header, instrumentPanel(reg, mappingInfo), footer),
    h('div', { class: 'cheek cheek-right', 'aria-hidden': 'true' }),
  );
  const rack = h(
    'div',
    { class: 'rack' },
    librarianPanel({
      device: 'ambika',
      log,
      suggestedName: () => names[selected],
      defaultName: () => `Part ${selected + 1} ${new Date().toLocaleString()}`,
      programs: true,
      snapshot: () => engine.parts[selected],
      load: (entry) => {
        engine.loadPart(selected, entry.patch, entry.kind === 'program' ? entry.part : undefined);
        return true;
      },
      loadTitle: () => `Load into part ${selected + 1} and send to the synth`,
    }),
    h('section', { class: 'rack-panel' }, h('h2', {}, 'Activity'), logList),
  );
  root.append(strip, notices, instrument, rack);

  // ---- Behaviour ---------------------------------------------------------
  /** Flashes a status LED for a moment (MIDI in/out activity). */
  const blink = (el: HTMLElement) => {
    el.classList.add('on');
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(setTimeout(() => el.classList.remove('on'), 120));
  };

  let lastEdit = '';
  const renderVfd = () => {
    const loc = locations[selected];
    const name =
      names[selected] ||
      (!engine.parts[selected].synced ? 'not pulled yet' : engine.firmware === 'stock' ? 'names need BAMBI' : '');
    vfdTop.replaceChildren(
      ...[h('span', { class: 'vfd-dim' }, `P${selected + 1}`), loc ? h('span', {}, loc) : null, h('span', {}, name.toUpperCase())].filter((x) => x !== null),
    );
    const m = engine.mappings[selected];
    const fw = engine.firmware === 'yamplus' ? `BAMBI ${versionString(engine.client.firmware?.yamPlusVersion ?? 0)}` : engine.firmware === 'stock' ? 'YAM' : '';
    vfdBottom.replaceChildren(
      ...[h('span', {}, lastEdit || 'READY'), h('span', {}, m.channel === 0 ? 'OMNI' : `CH ${m.channel}`), fw ? h('span', {}, fw) : null].filter((x) => x !== null),
    );
  };

  const renderMapping = () => {
    const m: PartMapping = engine.mappings[selected];
    const known = engine.mappingsKnown;
    const voices = [...Array(6).keys()].filter((v) => m.voices & (1 << v)).map((v) => v + 1);
    const ch = m.channel === 0 ? 'omni' : `ch ${m.channel}`;
    mappingInfo.textContent = known
      ? `${ch} · ${noteName(m.keyLow)} to ${noteName(m.keyHigh)} · voices ${voices.join(', ') || 'none'}`
      : `${ch} (assumed: pull all to read it)`;
    mappingInfo.title = 'Channel, key range and voice allocation are multi settings; edit them on the Ambika.';
    renderVfd();
  };

  const renderNotices = () => {
    clear(notices);
    const add = (cls: string, ...content: (string | Node)[]) => notices.append(h('div', { class: `notice ${cls}` }, ...content));
    if (!midi.supported) {
      add('error', 'This browser has no Web MIDI. Use Chrome or Edge on desktop (Safari has none, Firefox needs a site-permission add-on).');
      return;
    }
    if (virtual) {
      const synth = virtual.synth;
      const knob = h(
        'button',
        {
          type: 'button',
          onclick: () => {
            const cutoffAddress = 16;
            const current = synth.byte(selected, cutoffAddress);
            synth.turnKnob(selected, cutoffAddress, (current + 17) % 128);
          },
        },
        'Turn its cutoff knob',
      );
      add(
        'info',
        `Simulated Ambika (${synth.firmware === 'yamplus' ? 'BAMBI' : 'stock YAM'}, outp mode ${synth.outMode}): no hardware involved. `,
        knob,
      );
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
        h('code', {}, 'controllr'),
        ' (or ',
        h('code', {}, 'full'),
        '). ',
        h('strong', {}, 'inpt filter'),
        ' must not show ',
        h('code', {}, 'n'),
        ' or ',
        h('code', {}, 's'),
        ', or the Ambika ignores SHED’s edits and requests.',
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
      b.tabIndex = i === selected ? 0 : -1;
      b.classList.toggle('synced', engine.parts[i].synced);
    });
    renderVfd();
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
        locations[part - 1] = reply.status === 0 ? formatLocation(reply.location) : '';
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
      const msg = e instanceof RequestTimeout ? `${(e as Error).message}: check the cable and ports, and that System → inpt filter on the Ambika doesn’t block SysEx (no “s”)` : (e as Error).message;
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
  midi.on('message', ({ data }) => {
    blink(inLed);
    engine.handleMidi(data);
  });

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
    locations[selected] = '';
    renderPartTitle();
  });

  engine.on('param', ({ part, address, origin }) => {
    if (part !== selected) return;
    reg.update(address);
    if (origin === 'hardware') reg.flash(address);
    const def = paramAt(address);
    if (def) {
      lastEdit = `${def.name.toUpperCase()} ${formatValue(def, engine.value(part, def))}`;
      renderVfd();
    }
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
