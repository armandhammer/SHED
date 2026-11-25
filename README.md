# SHED

A zero-install **Web MIDI editor and librarian** for Mutable Instruments
**Ambika** and **Shruthi-1** running [BAMBI](https://github.com/armandhammer/BAMBI)
/ [SHOOZ](https://github.com/armandhammer/SHOOZ) (YAM-based firmware), also
compatible with stock YAM.

Runs in Chrome or Edge, no install and no backend: TypeScript + Vite, hosted
on GitHub Pages (Web MIDI needs https and SysEx permission).

> **Status:** not started yet. This repository holds the plan.

## Planned features

- Full patch, part/multi and voice-allocation editing, including all 43 YAM
  oscillator shapes and the BAMBI additions (envelope curves, vintage, spread
  mode), a visual mod matrix, and SVF filter-mode visualization.
- Bidirectional sync: front-panel edits arrive as NRPN (MIDI out mode
  `ctrl`/`full`) and update the browser; browser edits are coalesced and
  throttled to protect the 31.25 kbaud MIDI link, with echo suppression while
  a control is dragged.
- Librarian: IndexedDB banks, `.syx` import/export, A/B compare, patch
  morphing and constrained randomization.

## Protocol

- Design and the protocol extracted from the YAM firmware and the Ixox JUCE
  editor: [BAMBI docs/AUDIT.md](https://github.com/armandhammer/BAMBI/blob/main/docs/AUDIT.md), §4.
- BAMBI MIDI/NRPN/SysEx additions (version, current locations, names,
  part-tagged dumps): [BAMBI YAMPLUS.md](https://github.com/armandhammer/BAMBI/blob/main/YAMPLUS.md).
- Reference client: [BAMBI utils/yamplus_sysex.py](https://github.com/armandhammer/BAMBI/blob/main/utils/yamplus_sysex.py).
