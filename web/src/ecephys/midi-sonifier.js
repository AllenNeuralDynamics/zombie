/**
 * midi-sonifier.js — Web Audio engine that turns spike trains into notes in
 * sync with the standard session-playback transport.
 *
 * "MIDI" refers to the note-number + musical-scale model borrowed from ViSoND;
 * the actual sound is synthesized with the Web Audio API (oscillator + AD
 * envelope per spike), so there is no SoundFont, no .mid file, and no external
 * MIDI hardware dependency.
 *
 * The engine holds, per mapped unit, a sorted Float64Array of spike times (in
 * transport-relative seconds) plus a MIDI note number. Each transport tick it
 * advances a per-unit cursor over the spikes in (tPrev, t] and schedules a
 * note for each — subject to a pitch-preserving throttle (§ SYNTH).
 */

import { SCALES, SYNTH } from './midi-config.js';

/** Convert a MIDI note number to frequency in Hz (A4 = 69 = 440 Hz). */
export function midiToHz(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

/** Note names for display, e.g. midiName(48) === 'C3'. */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiName(note) {
  const n = Math.round(note);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * Build the "scale ladder": successive MIDI note numbers stepping through the
 * given scale's degrees, starting at rootMidi, wrapping up an octave each time
 * the degrees run out, for `count` steps.
 *
 * @param {string} scaleKey - key into SCALES
 * @param {number} rootMidi - starting MIDI note
 * @param {number} count    - how many pitches to generate
 * @param {number} octaveSpan - max octaves before reusing pitches
 * @returns {number[]} MIDI note numbers, ascending
 */
export function scaleLadder(scaleKey, rootMidi, count, octaveSpan = SYNTH.octaveSpan) {
  const degrees = SCALES[scaleKey] ?? SCALES.chromatic;
  const maxSemitone = octaveSpan * 12;
  const out = [];
  for (let i = 0; i < count; i++) {
    const octave = Math.floor(i / degrees.length);
    const semitone = degrees[i % degrees.length] + octave * 12;
    out.push(rootMidi + (semitone % maxSemitone));
  }
  return out;
}

/** Binary search: index of first element in `arr` strictly greater than `t`. */
function firstGT(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Create the sonifier.
 *
 * @param {object} [cfg] - overrides merged over SYNTH.
 * @returns {object} sonifier API
 */
export function createSonifier(cfg = {}) {
  const conf = { ...SYNTH, ...cfg };

  let audio = null;         // AudioContext (lazily created on first play)
  let master = null;        // master GainNode
  let units = [];           // [{ unitName, times:Float64Array, note, hz, timbre, cursor, lastNoteReal, onFire }]
  let voices = [];          // active { osc, gain, endsAt } for voice stealing
  let enabled = false;

  function ensureAudio() {
    if (audio) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    audio = new AC();
    master = audio.createGain();
    master.gain.value = conf.masterGain;
    master.connect(audio.destination);
  }

  /** Reap finished voices; enforce the voice budget by stealing the oldest. */
  function reap(now) {
    voices = voices.filter((v) => v.endsAt > now);
    while (voices.length > conf.maxVoices) {
      const v = voices.shift();
      try { v.gain.gain.cancelScheduledValues(now); v.gain.gain.setValueAtTime(0, now); v.osc.stop(now); } catch { /* already stopped */ }
    }
  }

  /** Schedule one note at Web Audio time `when` (seconds). */
  function scheduleNote(hz, timbre, when) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = timbre;
    osc.frequency.value = hz;
    const dur = conf.noteDurationS;
    // Fast attack, exponential-ish decay to near-silence.
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(conf.velocity, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(when);
    osc.stop(when + dur + 0.02);
    voices.push({ osc, gain, endsAt: when + dur });
  }

  return {
    /**
     * Install the mapping + spike data.
     * @param {Array<{unitName:string, times:Float64Array, note:number,
     *   timbre?:string, onFire?:(u:object)=>void}>} mappedUnits
     */
    setMapping(mappedUnits) {
      units = mappedUnits.map((u) => ({
        unitName: u.unitName,
        times: u.times,
        note: u.note,
        hz: midiToHz(u.note),
        timbre: u.timbre ?? conf.timbres[0],
        cursor: 0,
        lastNoteReal: -Infinity,
        onFire: u.onFire ?? null,
      }));
    },

    /** Enable/disable sound output (visual raster keeps running regardless). */
    setEnabled(on) {
      enabled = on;
      if (on) { ensureAudio(); audio.resume?.(); }
    },
    isEnabled() { return enabled; },

    setMasterGain(g) { if (master) master.gain.value = g; conf.masterGain = g; },

    /**
     * Advance to transport time `t` from `tPrev`, scheduling notes for spikes
     * crossed. Detects seeks (backwards or large jumps) and re-seats cursors
     * without firing. Safe to call every frame.
     *
     * @param {number} t     - current transport time (s)
     * @param {number} tPrev - previous transport time (s)
     * @param {object} state - { playing, speed }
     */
    tick(t, tPrev, state = {}) {
      const speed = state.speed ?? 1;
      // Seek detection: backwards, or a forward jump far larger than a plausible
      // single-frame advance at the current speed.
      const maxFrameAdvance = Math.max(0.5, speed * 0.2);
      if (!(t >= tPrev) || (t - tPrev) > maxFrameAdvance) {
        this.reseek(t);
        return;
      }
      if (!enabled || !state.playing) return;
      ensureAudio();
      const now = audio.currentTime;
      reap(now);
      const minGap = 1 / conf.maxNotesPerSecPerUnit; // real-time throttle
      for (const u of units) {
        const end = firstGT(u.times, t);
        let fired = false;
        // Only the last few spikes in the window can realistically be heard;
        // throttle to the max per-unit note rate (pitch-preserving decimation).
        for (let i = u.cursor; i < end; i++) {
          const realNow = now; // notes in this frame collapse to ~now
          if (realNow - u.lastNoteReal >= minGap) {
            scheduleNote(u.hz, u.timbre, now + conf.scheduleLookaheadS);
            u.lastNoteReal = realNow;
            fired = true;
          }
        }
        u.cursor = end;
        if (fired && u.onFire) u.onFire(u);
      }
    },

    /** Re-seat all cursors to time `t` (used on scrub/seek); fires nothing. */
    reseek(t) {
      for (const u of units) {
        u.cursor = firstGT(u.times, t);
        u.lastNoteReal = -Infinity;
      }
    },

    /** Hard-stop all sound (e.g. on teardown). */
    stop() {
      if (!audio) return;
      const now = audio.currentTime;
      for (const v of voices) {
        try { v.gain.gain.cancelScheduledValues(now); v.gain.gain.setValueAtTime(0, now); v.osc.stop(now); } catch { /* noop */ }
      }
      voices = [];
    },

    /** Play a single preview note (used by the modal's per-unit preview). */
    preview(note, timbre) {
      ensureAudio();
      audio.resume?.();
      scheduleNote(midiToHz(note), timbre ?? conf.timbres[0], audio.currentTime + 0.01);
    },

    destroy() {
      this.stop();
      try { audio?.close(); } catch { /* noop */ }
      audio = null; master = null; units = [];
    },
  };
}
