// Librarian sidebar: IndexedDB entries, .syx import/export.

import { Library } from '../librarian/db';
import { exportEntries, exportEntry, fileName, importSyx, type LibraryEntry } from '../librarian/syx';
import type { SyncEngine } from '../sync/engine';
import { clear, download, h } from './dom';

export interface LibrarianHooks {
  selectedPart(): number;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /** Suggested name for a new entry (e.g. the SD name reported by BAMBI). */
  suggestedName(): string;
}

export function librarianPanel(engine: SyncEngine, hooks: LibrarianHooks): HTMLElement {
  const lib = new Library();
  const list = h('ul', { class: 'lib-list' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name', maxlength: 32, 'aria-label': 'Entry name' });
  const fileInput = h('input', { type: 'file', accept: '.syx,application/octet-stream', multiple: true, hidden: true });
  let entries: LibraryEntry[] = [];

  const refresh = async () => {
    try {
      entries = await lib.list();
    } catch (e) {
      hooks.log('error', `Librarian storage unavailable: ${(e as Error).message}`);
      entries = [];
    }
    clear(list);
    if (!entries.length) {
      list.append(h('li', { class: 'muted' }, 'No patches yet. Save the current part or import a .syx file.'));
      return;
    }
    for (const entry of entries) {
      list.append(
        h(
          'li',
          { class: 'lib-item' },
          h('span', { class: 'lib-name', title: entry.source ? `from ${entry.source}` : '' }, entry.name),
          h('span', { class: `kind kind-${entry.kind}` }, entry.kind === 'program' ? 'prog' : 'patch'),
          h(
            'span',
            { class: 'lib-actions' },
            h('button', { type: 'button', title: `Load into part ${hooks.selectedPart() + 1} and send to the synth`, onclick: () => load(entry) }, 'Load'),
            h('button', { type: 'button', title: 'Download as .syx', onclick: () => download(exportEntry(entry), fileName(entry.name)) }, '.syx'),
            h('button', { type: 'button', class: 'danger', title: 'Delete from this browser', onclick: () => remove(entry) }, '✕'),
          ),
        ),
      );
    }
  };

  const load = (entry: LibraryEntry) => {
    const part = hooks.selectedPart();
    engine.loadPart(part, entry.patch, entry.kind === 'program' ? entry.part : undefined);
    hooks.log('info', `Loaded “${entry.name}” into part ${part + 1}`);
  };

  const remove = async (entry: LibraryEntry) => {
    if (entry.id === undefined || !confirm(`Delete “${entry.name}” from this browser's library?`)) return;
    await lib.remove(entry.id);
    await refresh();
  };

  const save = async (kind: 'patch' | 'program') => {
    const part = hooks.selectedPart();
    const m = engine.parts[part];
    const name = nameInput.value.trim() || hooks.suggestedName() || `Part ${part + 1} ${new Date().toLocaleString()}`;
    await lib.put({
      name,
      kind,
      patch: m.patch.slice(),
      part: kind === 'program' ? m.part.slice() : undefined,
      created: Date.now(),
    });
    nameInput.value = '';
    hooks.log('info', `Saved ${kind} “${name}”`);
    await refresh();
  };

  const importFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = importSyx(bytes, file.name.replace(/\.syx$/i, ''));
      if (result.entries.length) await lib.putMany(result.entries);
      hooks.log(
        result.entries.length ? 'info' : 'warn',
        `${file.name}: ${result.entries.length} imported${result.skipped.length ? `, ${result.skipped.length} skipped (${result.skipped[0]}${result.skipped.length > 1 ? ', …' : ''})` : ''}`,
      );
    }
    await refresh();
  };

  fileInput.addEventListener('change', () => {
    if (fileInput.files) void importFiles(fileInput.files);
    fileInput.value = '';
  });

  const panel = h(
    'section',
    { class: 'panel librarian', id: 'librarian' },
    h('h2', {}, 'Librarian'),
    h(
      'div',
      { class: 'lib-save' },
      nameInput,
      h('button', { type: 'button', onclick: () => void save('patch'), title: 'Store the patch (sound) of the selected part' }, 'Save patch'),
      h('button', { type: 'button', onclick: () => void save('program'), title: 'Store patch + part settings' }, 'Save program'),
    ),
    h(
      'div',
      { class: 'lib-io' },
      h('button', { type: 'button', onclick: () => fileInput.click() }, 'Import .syx…'),
      h(
        'button',
        {
          type: 'button',
          onclick: () => entries.length && download(exportEntries(entries), 'shed-library.syx'),
        },
        'Export all',
      ),
      fileInput,
    ),
    h('p', { class: 'hint' }, 'Stored in this browser only (IndexedDB). Drop .syx files here.'),
    list,
  );
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    panel.classList.add('drop');
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('drop');
    if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
  });
  void refresh();
  return panel;
}
