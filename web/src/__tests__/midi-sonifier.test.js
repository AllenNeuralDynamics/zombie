import { describe, it, expect } from 'vitest';
import { midiToHz, midiName, scaleLadder, createSonifier } from '../ecephys/midi-sonifier.js';

describe('midiToHz', () => {
  it('maps A4 (69) to 440 Hz', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
  });
  it('is one octave up at +12 semitones', () => {
    expect(midiToHz(81)).toBeCloseTo(880, 6);
  });
});

describe('midiName', () => {
  it('names middle-ish notes', () => {
    expect(midiName(48)).toBe('C3');
    expect(midiName(69)).toBe('A4');
    expect(midiName(60)).toBe('C4');
  });
});

describe('scaleLadder', () => {
  it('walks pentatonic degrees then wraps up an octave', () => {
    // minor_pentatonic = [0,3,5,7,10]
    const ladder = scaleLadder('minor_pentatonic', 48, 7, 4);
    expect(ladder.slice(0, 5)).toEqual([48, 51, 53, 55, 58]);
    // 6th step wraps: octave 1 => degree 0 + 12 = 12
    expect(ladder[5]).toBe(60);
    expect(ladder[6]).toBe(63);
  });
  it('is ascending for chromatic', () => {
    const ladder = scaleLadder('chromatic', 60, 12, 4);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
  });
});

describe('sonifier cursor / seek logic (no audio)', () => {
  it('reseek positions the cursor past times <= t', () => {
    const snd = createSonifier();
    const times = Float64Array.from([1, 2, 3, 4, 5]);
    snd.setMapping([{ unitName: 'u', times, note: 60 }]);
    // reseek is pure (no AudioContext needed)
    snd.reseek(3.5);
    // A backwards jump is treated as a seek and must not throw without audio.
    expect(() => snd.tick(2.0, 3.5, { playing: true, speed: 1 })).not.toThrow();
  });

  it('tick is a no-op (no audio) when paused', () => {
    const snd = createSonifier();
    snd.setMapping([{ unitName: 'u', times: Float64Array.from([0.1, 0.2]), note: 60 }]);
    expect(() => snd.tick(0.25, 0.0, { playing: false, speed: 1 })).not.toThrow();
  });
});
