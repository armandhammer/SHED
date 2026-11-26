# SHED v0.1 hardware test checklist

The unit and end-to-end tests run SHED against a simulated Ambika built from
the firmware source (`?virtual=bambi`). This list covers what the simulator
can't prove: real ports and permission, the USB interface's buffering, sound,
and anything where the firmware might differ from my reading of it.

Run it once with **stock YAM** and once with **BAMBI**. Note the interface
used, since buffer overflows are interface-specific.

Start with `npm run dev`, open http://localhost:5173 in Chrome or Edge, and
keep the Activity log at the bottom of the page in view.

## 0. Ambika settings

- [ ] System → **outp mode** = `controllr`
- [ ] System → **inpt filter** = `....` (no `n`, no `s`)
- [ ] Note which part is selected on the front panel (the "active part")

## 1. Connect and detect

- [ ] Connect MIDI → Chrome asks for MIDI *and* SysEx; allow.
- [ ] The Ambika's ports are picked automatically (or pick them); after a
      reload they come back by themselves.
- [ ] **Stock:** badge says `YAM (stock)`, log says "No version reply". The
      Ambika's LCD shows `#` briefly (expected: it rejected the BAMBI version
      request). BAMBI parameters (`+`) are greyed out.
- [ ] **BAMBI:** badge says `BAMBI · YAM+ 0.1`; hover it: controller version,
      43 shapes and one entry per voicecard that's fitted. The log lists the
      six program names and locations (A-000…).
- [ ] "Pulled all six parts and the multi" appears within about 2 s. No
      timeout errors.
- [ ] Part 1's controls match the patch on the synth (compare 4–5 values on
      the LCD).

## 2. Browser → synth

- [ ] Drag Filter 1 cutoff while holding a note: the sound follows smoothly,
      no stuck or late steps, and the LCD value matches when you stop.
- [ ] Drag quickly over several controls at once (cutoff, resonance, env 2
      amount): no MIDI errors, no stuck notes, the queue counter in the
      connection strip drains.
- [ ] Osc 1 shape: pick `wavquence`, `oldsaw`, `qpwm`, `fmfb`, `csaw`,
      `vowel 2` (shapes 37–42). Each sounds different. These need voicecard
      firmware that has them.
- [ ] A negative value (Osc 2 detune −20) lands as −20 on the LCD.
- [ ] Part settings: change voice mode (poly → mono → poly), legato,
      portamento, arpeggiator mode. Each takes effect on the synth.
- [ ] **BAMBI:** env curve 0 / 64 / 127 changes the envelope shape; vintage
      at 50 detunes voices slightly; spread mode stack / center / wide with
      spread > 0 changes the detune pattern.
- [ ] Push patch: LCD shows `+`, the sound doesn't change (same data).
- [ ] Init patch: part 1 becomes the init sound (saw + square, filter
      open-ish); the synth's stored program is untouched until saved there.

## 3. Synth → browser

- [ ] Turn the cutoff encoder on the Ambika: SHED's cutoff knob follows and
      flashes. The "Turn a knob" hint disappears.
- [ ] **Running-address case:** set parts 1 and 2 to different MIDI channels
      (default). Edit filter cutoff on part 1 from the front panel, switch the
      front panel to part 2, edit filter cutoff again. In SHED, part 2's
      cutoff must change (press part key 2 in SHED to see it) and part 1's must
      keep its value. This is the case the per-channel decoder got wrong.
- [ ] Turn one encoder continuously for a few seconds (more than 32 steps):
      SHED keeps following.
- [ ] On the Library page, select the multi and press the third button
      (send): SHED updates all parts and logs "Multi received from the synth".
- [ ] Same with a patch: BAMBI tags it with the part, so SHED updates the
      synth's active part. Stock YAM sends it untagged, so SHED puts it in
      the part selected in SHED; select the same part in both first.
- [ ] Load a different program on the synth: SHED doesn't know until you
      press Pull part (expected in `controllr` mode).

## 4. Output mode full

- [ ] Set outp mode = `full`, press Reconnect. The log says the Ambika
      forwards what SHED sends and that SHED ignores the echoes.
- [ ] Repeat the section 3 running-address case and a knob drag in SHED:
      values still land on the right parameters, and Push patch doesn't log
      "Patch received".
- [ ] Set outp mode back to `controllr`.

## 5. Input filter

- [ ] Set inpt filter to show `s`, Reconnect: SHED says stock YAM (even on
      BAMBI) and Pull part fails with a hint about the filter. Expected.
- [ ] Set inpt filter to show `n`: edits in SHED do nothing on the synth.
      Expected.
- [ ] Set it back to `....`.

## 6. Shared channels

- [ ] Set part 3 to the same MIDI channel as part 1 on the synth, Pull all.
      Selecting part 1 shows a warning that edits change both parts; an edit
      changes both on the synth and in SHED.

## 7. Librarian

- [ ] Save patch and Save program for part 1; both appear in the list.
- [ ] Download `.syx` of an entry; re-import it: identical entry.
- [ ] Import a `.syx` from your existing library (YAM or Ixox exports): good
      patches appear, anything else is listed as skipped with a reason.
- [ ] Load an entry into part 2: the synth plays it; part settings arrive
      when a program was loaded.
- [ ] Reload the page: the library is still there.

## 8. Robustness

- [ ] Unplug the USB interface, plug it back in: the ports are selected again
      and Reconnect works.
- [ ] Pull all while playing notes: no hanging notes, no timeouts.
- [ ] Turn the Ambika off and on with SHED connected: requests time out with
      a clear message, then Reconnect works.

## Firmware notes found while auditing

These are in the firmware (stock YAM and BAMBI), not in SHED:

- `MidiDispatcher::OnEdit` keeps **one** running NRPN address for all
  channels. SHED now decodes with a shared latch, but other editors that
  track the address per channel will mis-file edits made on different parts.
- `midi_nrpn_map` in `controller/parameter.cc` declares 256 entries but
  initialises 240. Entries 240–255 are therefore 0 (Osc 1 shape), so an NRPN
  to address 240–255 makes `Part::SetValue` write past the end of the part's
  data. SHED never sends those addresses. Original Mutable firmware has the
  same table. Padding the table with 255 fixes it.
