# SHED

SHED is a Web MIDI editor and librarian for the Mutable Instruments
**Ambika**. It runs in the browser with nothing to install and no server: open
the page, connect MIDI, and edit. It works with
[BAMBI](https://github.com/armandhammer/BAMBI) (YAM+ firmware) and with stock
YAM. Shruthi-1 support ([SHOOZ](https://github.com/armandhammer/SHOOZ)) is
planned but only stubbed for now.

Status: v0.1, not yet tested against hardware.

## What it does

- Edits every patch parameter of a part: oscillators (all 43 YAM shapes,
  including the ones past 37 that other editors cap), mixer, filter with a
  view of the SVF response, envelopes with draggable ADSR handles, LFOs, the
  modulation matrix and modifiers, and the part settings (volume, tuning,
  voice mode, spread, legato, portamento, raga, arpeggiator).
- Follows the synth: knob turns on the Ambika arrive as NRPN and move the
  matching controls. While you drag a control, echoes from the synth are
  ignored so the control doesn't jump back.
- Protects the MIDI link. The Ambika's DIN input runs at 31.25 kbaud, and some
  USB interfaces drop data if you send faster. SHED paces everything it sends
  (about 2.5 kB/s), coalesces fast drags, and limits each parameter to 40
  updates per second.
- Pulls a part (patch + part settings) or the whole multi from the synth,
  pushes a patch back as one SysEx dump, and resets a part to the init patch.
- Librarian: save patches or programs (patch + part settings), import and
  export `.syx` files, and load entries into the selected part.

## Running it

You need Node.js 20 or newer.

```sh
npm install
npm run dev
```

Then open the URL Vite prints (normally http://localhost:5173) in Chrome or
Edge. Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (Vitest) |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

Pushes to `main` are tested, built and deployed to GitHub Pages by
[.github/workflows/ci.yml](.github/workflows/ci.yml).

## Browser support

SHED needs Web MIDI with SysEx, so it runs in **Chrome or Edge** on desktop.
Safari has no Web MIDI. Firefox only offers it through a site-permission
add-on, which SHED isn't tested with.

When you click **Connect MIDI**, the browser asks whether the page may use
MIDI devices *and* send system-exclusive messages. Allow both: SHED uses SysEx
for patch dumps and firmware detection. If you blocked it by mistake, allow
MIDI for the site in the browser's site settings and reload. Web MIDI only
works on `https://` pages and on `localhost`.

## Setting up the Ambika

1. Connect the Ambika's MIDI in and out to your interface, then pick that
   input and output in SHED. SHED remembers the ports by name.
2. For front-panel edits to show up in SHED, set **System → outp mode** to
   `controllr` (recommended) or `full`. In `thru` and `sequencer` modes the
   Ambika doesn't send its knob moves. In `full` (and `chain`) mode it also
   forwards everything SHED sends; SHED recognises those echoes and ignores
   them.
3. Check **System → inpt filter**. It shows four characters, `cnps`, and each
   letter that appears is a message type the Ambika *ignores*: `c` control
   change, `n` NRPN, `p` program change, `s` SysEx. SHED needs NRPN and SysEx,
   so neither `n` nor `s` may show; `....` lets everything in. With `s`
   showing, every request times out and SHED takes the synth for stock YAM.
4. If two parts share a MIDI channel, an edit sent on that channel changes
   all of them. SHED mirrors such edits to every part on the channel and warns
   you.

## BAMBI and stock YAM

On connect, SHED sends the BAMBI version request (SysEx `0x1c`).

- **BAMBI replies**, and SHED shows the firmware and voicecard versions. You
  get the YAM+ parameters (envelope curves, vintage, spread mode; marked `+`
  in the UI), patch names and current locations. Dump replies carry the part
  number, so several requests can be in flight at once and each reply goes to
  the right part.
- **No reply within 700 ms** means stock YAM (or another Ambika firmware). The
  `+` parameters are disabled, and SHED sends one request at a time so it
  always knows which part a reply belongs to. Stock YAM doesn't know the
  version request, so its display briefly shows `#` (SysEx not accepted) when
  SHED connects; that's expected.

## Librarian

The library lives in the browser's IndexedDB storage, on this computer and in
this browser profile only. Nothing is uploaded. Clearing site data deletes
it, so export anything you want to keep as `.syx`. Imported `.syx` files may
hold several dumps; SHED skips messages it can't use (bad checksums, other
devices, sequencer data) and tells you why.

## Protocol references

- Protocol notes extracted from the YAM firmware and the Ixox editor:
  [BAMBI docs/AUDIT.md](https://github.com/armandhammer/BAMBI/blob/main/docs/AUDIT.md), §4.
- BAMBI's MIDI, NRPN and SysEx additions:
  [BAMBI YAMPLUS.md](https://github.com/armandhammer/BAMBI/blob/main/YAMPLUS.md).
- Reference Python client:
  [BAMBI utils/yamplus_sysex.py](https://github.com/armandhammer/BAMBI/blob/main/utils/yamplus_sysex.py).

## License

SHED is free software under the GNU General Public License, version 3 or (at
your option) any later version, the same terms as the Ambika firmware. See
[LICENSE](LICENSE).
