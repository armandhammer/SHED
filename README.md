# SHED

SHED is a Web MIDI editor and librarian for the Mutable Instruments
**Ambika**. It runs in the browser with nothing to install and no server: open
the page, connect MIDI, and edit. It works with
[BAMBI](https://github.com/armandhammer/BAMBI) (YAM+ firmware) and with stock
YAM. It also edits the **Shruthi-1**, with
[SHOOZ](https://github.com/armandhammer/SHOOZ) or stock YAM firmware: pick
the synth in the **Synth** menu at the top left.

Status: v0.1, not yet tested against hardware. The checklist for the first
hardware session is [docs/HARDWARE-TEST.md](docs/HARDWARE-TEST.md).

## What it does

- Edits every patch parameter of a part on one hardware-style panel:
  oscillators (all 43 YAM shapes, including the ones past 37 that other
  editors cap), mixer, both filters with a response graph each, LFOs, three
  envelopes with a graph (drag its points) and faders, the modulation matrix
  and modifiers, and the part settings (volume, tuning, voice mode, spread,
  legato, portamento, raga, arpeggiator).
- Knobs: drag up or right (Shift for fine steps), scroll, or use the arrow
  keys; double-click a value to type it. Faders work the same way. Value
  windows step with ◀ ▶ or open a list when clicked.
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

### Without an Ambika

Add `?virtual=bambi` or `?virtual=stock` to the URL (for example
http://localhost:5173/?virtual=bambi) to connect to a simulated Ambika instead
of real MIDI ports. Add `&outp=full` to simulate the `full` output mode. The
simulator ([src/sim/virtual-ambika.ts](src/sim/virtual-ambika.ts)) models the
controller's MIDI behaviour as read from the firmware: SysEx requests and
replies, NRPN reception per part, front-panel edits sent with the firmware's
running address, echoes in `full` mode and the input filter. It makes no
sound. The end-to-end tests in [test/sim.test.ts](test/sim.test.ts) run SHED
against it.

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

## Shruthi-1

Pick **Shruthi-1** in the Synth menu (or open `?device=shruthi`). The panel
has every patch parameter (oscillators, mixer, filter, both envelopes with
draggable graphs, LFOs, the 12-row modulation matrix and the two CV
operators), the sequencer/arpeggiator settings, keyboard settings and the
system settings that matter for editing.

- **Filter board.** The firmware's *filter board* system setting decides
  which extra controls the filter section shows (SVF modes and second
  cutoff, Polivoks overdrive and FM, 4PM modes, and so on). Set it in the
  System section or on the Shruthi; SHED follows. Boards without their own
  page (the standard SMR4 board, and boards that run as `lpf`) show the
  main filter controls only.
- **Filter calibration (SHOOZ).** The System section's *Filter calibration*
  row is SHOOZ's per-unit "filter cal" page: a profile for the board
  (CS-80, IR3109, Polivoks, SMR4: resonance taper, level compensation and
  cutoff shift), a cutoff offset to match several Shruthis, and a resonance
  ceiling. SHED reads it from the version reply when it connects.
- **SHOOZ vs stock YAM.** SHED sends the version request (SysEx `0x1c`) when
  it connects. SHOOZ answers with capability bytes; stock YAM answers
  without them, and SHED then disables the SHOOZ-only parameters (envelope
  curve presets, vintage, filter calibration, marked **+**) and sends patches in the stock format.
  No answer at all means no Shruthi on those ports, or the wrong MIDI channel.
- **Following the knobs.** Set the Shruthi's **midi out** (system page) to
  `ctrl` or `full`. The factory setting `thru` only echoes SHED's own
  messages back, which SHED recognises and ignores.
- **Push / Write.** Push sends the patch to the edit buffer; **Write…**
  stores the edit buffer in a slot on the Shruthi after a confirmation.
  System settings change live. **Save system** (next to the filter
  calibration) sends them back as SysEx `0x04`, which the Shruthi saves;
  SHOOZ saves the filter calibration with them. It works only after a Pull,
  so SHED never overwrites the synth's settings with its defaults. Saving
  on the Shruthi's own system page does the same.

`?virtual=shooz` or `?virtual=shruthi` (stock YAM) connects to a simulated
Shruthi ([src/sim/virtual-shruthi.ts](src/sim/virtual-shruthi.ts)), with
MIDI out `ctrl` unless you add `&outp=thru|full|off`.

## Librarian

The library lives in the browser's IndexedDB storage, on this computer and in
this browser profile only. Nothing is uploaded. Clearing site data deletes
it, so export anything you want to keep as `.syx`. Imported `.syx` files may
hold several dumps; SHED skips messages it can't use (bad checksums, other
devices, sequencer data) and tells you why. One library holds both synths'
patches: the Ambika editor lists Ambika entries and the Shruthi editor lists
Shruthi patches (92-byte SysEx `0x01` dumps, named after the name stored in
the patch).

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
