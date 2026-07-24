/**
 * midi-config.js — tunable configuration for the (semi-hidden) spike → MIDI
 * sonification tool ("Spike Jukebox").
 *
 * This is intentionally a standalone, comment-heavy config file so the defaults
 * can be tuned later without touching the engine/modal/view code. Every value
 * here is a *default*; the modal exposes the musically-relevant ones as live
 * controls, but the numbers below are what the tool starts from.
 *
 * See midi-plan.md for the design rationale and the mapping onto the ViSoND
 * notebook's unit-selection metrics.
 */

/**
 * "Good unit" selection thresholds — the notebook's firing-rate / RPV / top-K
 * filters mapped onto the columns of platform_ecephys_units.
 *
 * NOTE: these defaults are placeholders to be tuned against real sessions.
 * Loosen/tighten here (or via the modal controls) until a one-click mapping
 * reliably sounds musical.
 */
export const UNIT_SELECTION = {
  /** Require the portal's QC pass flag (default_qc = TRUE). */
  requireDefaultQc: true,
  /** Keep only these decoder_label values (well-isolated single units). */
  decoderLabels: ['sua'],
  /** ViSoND firing-rate window (Hz). Units outside this are excluded. */
  minFiringRateHz: 0.5,
  maxFiringRateHz: 20,
  /** ViSoND refractory-period-violation ceiling (isi_violations_ratio). */
  maxIsiViolationsRatio: 0.05,
  /** Optional presence-ratio floor (0..1); null disables. */
  minPresenceRatio: null,
  /** Top-K after filtering; ranked by the ORDER BY below. */
  topK: 12,
  /**
   * Ranking for top-K, applied as SQL ORDER BY. First key is primary.
   * Each entry is [column, 'ASC'|'DESC'].
   */
  rankBy: [['snr', 'DESC'], ['num_spikes', 'DESC']],
};

/**
 * Musical scales as semitone offsets from the root (one octave). The pitch
 * "ladder" walks these degrees and wraps up an octave when it runs out, so any
 * number of units can be mapped (unlike ViSoND, which errors when units exceed
 * the available degrees).
 */
export const SCALES = {
  chromatic:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:            [0, 2, 4, 5, 7, 9, 11],          // Ionian
  minor:            [0, 2, 3, 5, 7, 8, 10],          // Aeolian
  dorian:           [0, 2, 3, 5, 7, 9, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues:            [0, 3, 5, 6, 7, 10],
  japanese:         [0, 1, 5, 7, 8],                 // Hirajoshi-ish
  ethiopian:        [0, 2, 4, 5, 7, 9, 11],          // A Tizita major variant
};

/**
 * Synth / playback defaults. "MIDI" here is the note-number + scale model from
 * ViSoND; sound is produced with the Web Audio API (no SoundFont, no external
 * MIDI device), so it stays self-contained and CSP-friendly.
 */
export const SYNTH = {
  /** Default scale + tonal center for the auto-mapping ladder. */
  defaultScale: 'minor_pentatonic',
  /** Root as a MIDI note number. 48 = C3. */
  rootMidi: 48,
  /** How many octaves the ladder may climb before reusing pitches. */
  octaveSpan: 4,
  /**
   * Per-probe default timbres, cycled by probe order so multiple probes are
   * audibly distinct. Each is an oscillator type understood by Web Audio.
   */
  timbres: ['sine', 'triangle', 'square'],
  /** Note (spike) duration in seconds — envelope release. */
  noteDurationS: 0.12,
  /** Per-note gain (0..1), analogous to MIDI velocity. */
  velocity: 0.35,
  /** Master output gain (0..1). */
  masterGain: 0.6,
  /**
   * Pitch-preserving throttle: the maximum note rate PER UNIT, in real
   * (wall-clock) seconds. At high playback speeds a unit's spikes are decimated
   * down to this rate so the texture stays intelligible rather than smearing
   * into noise. Notes are dropped, not pitch-shifted (no toggle — this is the
   * fixed behavior requested).
   */
  maxNotesPerSecPerUnit: 18,
  /** Global cap on simultaneously-scheduled oscillators (oldest are stolen). */
  maxVoices: 48,
  /** Web Audio scheduling look-ahead (seconds) for sample-accurate onsets. */
  scheduleLookaheadS: 0.05,
};

/**
 * Clock alignment policy. Per the current decision, "0 means 0 across
 * everything": the ecephys recording's zero is lined up with the behavioral
 * session's t=0. We take the recording zero as MIN(spike_time) for the probe
 * and subtract it, so a spike at recording-start plays at transport t=0.
 *
 * If this proves wrong for some sessions, revisit here (e.g. anchor to the
 * first trial/site absolute time instead).
 */
export const CLOCK = {
  /** 'min_spike' → t0 = MIN(spike_time); 'zero' → use spike_time as-is. */
  t0Policy: 'min_spike',
};

/**
 * Spike-raster view (the unit-row lane strip inserted between the behavior plot
 * and the videos). It scrolls on the SAME spatial (cm) axis as the corridor.
 */
export const RASTER_VIEW = {
  /**
   * Total time window shown across the strip, in transport seconds. The strip
   * scrolls by real (transport) time — NOT by corridor position — so notes move
   * left at a steady rate; the width is chosen so it reads roughly like the
   * corridor's distance scale without racing.
   */
  windowS: 20,
  /** Height in px of each unit's lane. */
  laneHeightPx: 14,
  /** Gap in px between lanes. */
  laneGapPx: 2,
  /** Spike tick half-width in px. */
  tickWidthPx: 2,
  /** Extra bottom/top padding px. */
  padPx: 6,
  /** Flash duration (s, real time) when a unit fires, for the lane highlight. */
  flashS: 0.12,
};
