import { describe, expect, it } from 'vitest';
import { param } from '../src/model/params/ambika';
import { faderValue, fraction, KNOB_DRAG_PX, knobAngle, knobDragValue, sliderKey, stepEnum } from '../src/ui/control-math';

const cutoff = param('filter1.cutoff'); // 0–127
const detune = param('osc1.detune'); // −64…64
const shape = param('osc1.shape'); // enum 0–42
const attack = param('env1.attack'); // 0–127

describe('control math', () => {
  it('maps values to knob angles, centred for bipolar parameters', () => {
    expect(knobAngle(cutoff, 0)).toBe(-135);
    expect(knobAngle(cutoff, 127)).toBe(135);
    expect(knobAngle(detune, 0)).toBe(0);
    expect(fraction(cutoff, 500)).toBe(1);
  });

  it('drags a knob over its full range in KNOB_DRAG_PX, slower in fine mode', () => {
    expect(knobDragValue(cutoff, 0, 0, -KNOB_DRAG_PX)).toBe(127); // up
    expect(knobDragValue(cutoff, 64, KNOB_DRAG_PX / 2, 0)).toBe(127); // right, clamped
    expect(knobDragValue(cutoff, 64, 0, KNOB_DRAG_PX / 2)).toBe(1); // down
    expect(knobDragValue(cutoff, 64, 0, -KNOB_DRAG_PX / 2, true)).toBe(80);
    expect(knobDragValue(detune, 0, 0, KNOB_DRAG_PX)).toBe(-64);
  });

  it('maps a fader position to a value, top = max', () => {
    expect(faderValue(attack, 0, 132)).toBe(127);
    expect(faderValue(attack, 132, 132)).toBe(0);
    expect(faderValue(attack, 66, 132)).toBe(64);
    expect(faderValue(attack, -20, 132)).toBe(127);
  });

  it('steps sliders with the keyboard', () => {
    expect(sliderKey(cutoff, 10, 'ArrowUp')).toBe(11);
    expect(sliderKey(cutoff, 10, 'ArrowLeft')).toBe(9);
    expect(sliderKey(cutoff, 10, 'ArrowUp', true)).toBe(23);
    expect(sliderKey(cutoff, 120, 'PageUp')).toBe(127);
    expect(sliderKey(detune, 0, 'Home')).toBe(-64);
    expect(sliderKey(cutoff, 10, 'a')).toBeNull();
  });

  it('steps menu windows with wrap-around, skipping shapes the voicecards lack', () => {
    expect(stepEnum(shape, 0, 1)).toBe(1);
    expect(stepEnum(shape, 0, -1)).toBe(42);
    expect(stepEnum(shape, 42, 1)).toBe(0);
    expect(stepEnum(shape, 36, 1, 36)).toBe(0); // stock voicecards stop at 36
    expect(stepEnum(shape, 0, -1, 36)).toBe(36);
  });
});
