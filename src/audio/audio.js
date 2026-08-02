// ============================================================================
// OPERATION BLACKOUT - procedural audio
// Owner: audio agent. Exports GAME.Audio.
//
// EVERY sound in this game is synthesised at runtime with the Web Audio API.
// There are no audio files, no network, no decoding. Noise beds, impulse
// responses, formant vocalisations and every weapon layer are generated from
// oscillators, generated noise buffers and biquad filters.
//
// Signal flow (matches the architecture contract):
//
//   [sources] -> [head gain] -> [panner (HRTF)] -> [air/occlusion lowpass]
//             -> [voice gain] -> [bus] -+-> [pre-master]
//                                       +-> [bus send] -> [convolver reverb]
//   [gunshot tail] -> [multi-tap canyon echo] -> [pre-master]
//   pre-master -> [muffle lowpass (ear ringing)] -> [master] -> [limiter] -> out
//
// Design constraints that shaped this file:
//   * Never throw. A headless capture run has no audio device; the whole module
//     must degrade to a silent no-op without blocking boot or logging fatals.
//   * Never leak nodes. Web Audio sources are one-shot and cannot be reused, so
//     we pool the *channel* (panner/filter/gain) and sweep finished sub-graphs
//     from update() using the audio clock rather than relying on onended.
//   * Deterministic. We fork our own RNG from ctx.seed instead of drawing from
//     ctx.rng, so audio randomisation cannot perturb the visual capture stream.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

  // --------------------------------------------------------------------------
  // Tunables
  // --------------------------------------------------------------------------
  // Scheduling everything a hair in the future avoids the "setValueAtTime in
  // the past" glitch where the first millisecond of an envelope is skipped.
  var LOOKAHEAD = 0.012;
  var MAX_VOICES = 32;          // concurrent positional channels
  var MAX_PENDING = 220;        // hard cap on live sub-graphs before we reap
  var SPEED_OF_SOUND = 343;     // m/s - used for propagation delay
  var EMPTY = {};

  // --------------------------------------------------------------------------
  // Weapon spectral profiles.
  // A gunshot is: supersonic crack (bright, ~2ms), muzzle blast body (noise,
  // 80-150ms), sub thump (pitch-dropping tone) and a mechanical bolt cycle.
  // The differences between weapons live almost entirely in the balance of
  // those four layers and in where the crack/body filters sit.
  // --------------------------------------------------------------------------
  var WEAPON_PROFILES = {
    rifle: {
      level: 1.00,
      crackF0: 5600, crackF1: 1150, crackQ: 1.05, crackDec: 0.042, crackG: 1.00,
      bodyF0: 1150, bodyF1: 190, bodyQ: 0.85, bodyDec: 0.125, bodyG: 0.85,
      subF0: 175, subF1: 46, subDec: 0.155, subG: 0.62, subType: 'triangle',
      boltAt: 0.052, boltF: 3150, boltG: 0.30,
      tail: 0.95, drive: 0.55
    },
    smg: {
      level: 0.82,
      crackF0: 6400, crackF1: 1450, crackQ: 1.2, crackDec: 0.030, crackG: 0.95,
      bodyF0: 1350, bodyF1: 260, bodyQ: 0.9, bodyDec: 0.085, bodyG: 0.68,
      subF0: 195, subF1: 62, subDec: 0.10, subG: 0.42, subType: 'triangle',
      boltAt: 0.038, boltF: 3900, boltG: 0.38,
      tail: 0.7, drive: 0.45
    },
    pistol: {
      level: 0.74,
      crackF0: 5200, crackF1: 1600, crackQ: 1.4, crackDec: 0.026, crackG: 0.9,
      bodyF0: 1500, bodyF1: 320, bodyQ: 1.0, bodyDec: 0.070, bodyG: 0.6,
      subF0: 210, subF1: 78, subDec: 0.085, subG: 0.34, subType: 'sine',
      boltAt: 0.044, boltF: 4300, boltG: 0.42,
      tail: 0.6, drive: 0.35
    },
    shotgun: {
      level: 1.12,
      crackF0: 4200, crackF1: 780, crackQ: 0.8, crackDec: 0.055, crackG: 0.85,
      bodyF0: 900, bodyF1: 130, bodyQ: 0.7, bodyDec: 0.185, bodyG: 1.05,
      subF0: 140, subF1: 34, subDec: 0.24, subG: 0.85, subType: 'triangle',
      boltAt: 0.30, boltF: 2100, boltG: 0.30,
      tail: 1.15, drive: 0.7
    },
    sniper: {
      level: 1.25,
      crackF0: 6800, crackF1: 900, crackQ: 1.0, crackDec: 0.055, crackG: 1.15,
      bodyF0: 1000, bodyF1: 150, bodyQ: 0.8, bodyDec: 0.175, bodyG: 0.95,
      subF0: 155, subF1: 38, subDec: 0.23, subG: 0.80, subType: 'triangle',
      boltAt: 0.09, boltF: 2600, boltG: 0.34,
      tail: 1.35, drive: 0.6
    },
    lmg: {
      level: 1.08,
      crackF0: 5200, crackF1: 1050, crackQ: 1.0, crackDec: 0.048, crackG: 1.0,
      bodyF0: 1050, bodyF1: 165, bodyQ: 0.85, bodyDec: 0.145, bodyG: 0.95,
      subF0: 165, subF1: 42, subDec: 0.18, subG: 0.72, subType: 'triangle',
      boltAt: 0.048, boltF: 2900, boltG: 0.34,
      tail: 1.05, drive: 0.6
    },
    suppressed: {
      level: 0.42,
      crackF0: 2600, crackF1: 700, crackQ: 1.6, crackDec: 0.022, crackG: 0.35,
      bodyF0: 700, bodyF1: 210, bodyQ: 1.2, bodyDec: 0.055, bodyG: 0.5,
      subF0: 150, subF1: 70, subDec: 0.06, subG: 0.28, subType: 'sine',
      boltAt: 0.030, boltF: 4600, boltG: 0.70,   // action noise dominates
      tail: 0.22, drive: 0.2
    }
  };

  // --------------------------------------------------------------------------
  // Footstep surfaces. `grains` drives an impulsive micro-cluster (gravel/glass
  // are a shower of tiny transients, not one broadband whoosh); `partials`
  // adds inharmonic ringing for metal.
  // --------------------------------------------------------------------------
  var SURFACES = {
    concrete: {
      level: 0.95, subF: 108, subDec: 0.048, subG: 0.42,
      bodyF: 820, bodyQ: 0.85, bodyDec: 0.052, bodyG: 0.80,
      clickF: 3300, clickQ: 2.6, clickG: 0.34, clickDec: 0.013,
      grains: 0, partials: null, rustle: 0.14
    },
    asphalt: {
      level: 0.85, subF: 96, subDec: 0.055, subG: 0.44,
      bodyF: 620, bodyQ: 0.7, bodyDec: 0.062, bodyG: 0.78,
      clickF: 2400, clickQ: 2.0, clickG: 0.20, clickDec: 0.014,
      grains: 3, grainLo: 1800, grainHi: 4200, grainG: 0.16, rustle: 0.14
    },
    tile: {
      level: 0.98, subF: 130, subDec: 0.04, subG: 0.34,
      bodyF: 1150, bodyQ: 1.3, bodyDec: 0.045, bodyG: 0.72,
      clickF: 4600, clickQ: 3.4, clickG: 0.46, clickDec: 0.011,
      grains: 0, partials: [1900, 4300], partialDec: 0.09, partialG: 0.10,
      rustle: 0.13
    },
    sand: {
      level: 0.70, subF: 74, subDec: 0.075, subG: 0.40,
      bodyF: 430, bodyQ: 0.45, bodyDec: 0.135, bodyG: 0.92,
      clickF: 1600, clickQ: 1.0, clickG: 0.05, clickDec: 0.03,
      grains: 0, partials: null, rustle: 0.17
    },
    dirt: {
      level: 0.76, subF: 86, subDec: 0.062, subG: 0.44,
      bodyF: 520, bodyQ: 0.6, bodyDec: 0.10, bodyG: 0.88,
      clickF: 2000, clickQ: 1.4, clickG: 0.10, clickDec: 0.02,
      grains: 3, grainLo: 1400, grainHi: 3600, grainG: 0.14, rustle: 0.16
    },
    gravel: {
      level: 0.95, subF: 92, subDec: 0.05, subG: 0.34,
      bodyF: 700, bodyQ: 0.7, bodyDec: 0.070, bodyG: 0.60,
      clickF: 2800, clickQ: 2.0, clickG: 0.12, clickDec: 0.016,
      grains: 8, grainLo: 2400, grainHi: 7000, grainG: 0.42, rustle: 0.15
    },
    rubble: {
      level: 1.0, subF: 100, subDec: 0.055, subG: 0.40,
      bodyF: 760, bodyQ: 0.8, bodyDec: 0.085, bodyG: 0.72,
      clickF: 2600, clickQ: 2.2, clickG: 0.20, clickDec: 0.018,
      grains: 7, grainLo: 1800, grainHi: 6000, grainG: 0.40, rustle: 0.16
    },
    metal: {
      level: 1.02, subF: 140, subDec: 0.035, subG: 0.30,
      bodyF: 1300, bodyQ: 1.6, bodyDec: 0.05, bodyG: 0.62,
      clickF: 5200, clickQ: 4.0, clickG: 0.42, clickDec: 0.012,
      grains: 0, partials: [1480, 2870, 4390, 6110], partialDec: 0.26,
      partialG: 0.20, rustle: 0.13
    },
    wood: {
      level: 0.88, subF: 152, subDec: 0.05, subG: 0.46,
      bodyF: 460, bodyQ: 1.1, bodyDec: 0.075, bodyG: 0.80,
      clickF: 2200, clickQ: 2.2, clickG: 0.24, clickDec: 0.014,
      grains: 0, partials: [238, 690], partialDec: 0.13, partialG: 0.22,
      rustle: 0.14
    },
    glass: {
      level: 0.92, subF: 120, subDec: 0.035, subG: 0.24,
      bodyF: 1600, bodyQ: 1.4, bodyDec: 0.04, bodyG: 0.40,
      clickF: 6200, clickQ: 3.0, clickG: 0.30, clickDec: 0.010,
      grains: 12, grainLo: 4200, grainHi: 12000, grainG: 0.46,
      partials: [5400, 8100], partialDec: 0.12, partialG: 0.10, rustle: 0.12
    },
    water: {
      level: 0.80, subF: 78, subDec: 0.06, subG: 0.28,
      bodyF: 900, bodyQ: 0.5, bodyDec: 0.16, bodyG: 0.95,
      clickF: 3400, clickQ: 1.2, clickG: 0.18, clickDec: 0.05,
      grains: 5, grainLo: 2600, grainHi: 8000, grainG: 0.22, rustle: 0.14
    },
    carpet: {
      level: 0.55, subF: 84, subDec: 0.05, subG: 0.34,
      bodyF: 380, bodyQ: 0.5, bodyDec: 0.07, bodyG: 0.55,
      clickF: 1400, clickQ: 1.0, clickG: 0.04, clickDec: 0.02,
      grains: 0, partials: null, rustle: 0.20
    }
  };
  // Aliases so a level that reports material names straight from the collider
  // table still lands on something sensible.
  var SURFACE_ALIAS = {
    concrete_wall: 'concrete', plaster: 'concrete', brick: 'concrete',
    stone: 'concrete', rock: 'gravel', painted_metal: 'metal',
    rusted_metal: 'metal', corrugated_metal: 'metal', wood_plank: 'wood',
    plank: 'wood', foliage: 'dirt', grass: 'dirt', fabric: 'carpet',
    rubber: 'carpet', sandbag: 'sand', debris: 'rubble', road: 'asphalt'
  };

  // --------------------------------------------------------------------------
  // Bullet impact materials.
  // --------------------------------------------------------------------------
  var IMPACTS = {
    concrete: {
      level: 1.0, crackF: 2800, crackQ: 1.4, crackDec: 0.026, crackG: 0.9,
      bodyF0: 1700, bodyF1: 420, bodyQ: 0.9, bodyDec: 0.095, bodyG: 0.75,
      subF0: 145, subF1: 70, subDec: 0.06, subG: 0.40,
      grains: 5, grainLo: 1600, grainHi: 5200, grainG: 0.26, span: 0.13
    },
    plaster: {
      level: 0.85, crackF: 2200, crackQ: 1.2, crackDec: 0.022, crackG: 0.7,
      bodyF0: 1300, bodyF1: 340, bodyQ: 0.8, bodyDec: 0.11, bodyG: 0.8,
      subF0: 130, subF1: 62, subDec: 0.05, subG: 0.30,
      grains: 4, grainLo: 1200, grainHi: 3800, grainG: 0.22, span: 0.16
    },
    metal: {
      level: 1.08, crackF: 4600, crackQ: 2.0, crackDec: 0.020, crackG: 1.1,
      bodyF0: 2600, bodyF1: 900, bodyQ: 1.4, bodyDec: 0.055, bodyG: 0.5,
      subF0: 190, subF1: 110, subDec: 0.04, subG: 0.24,
      partials: [1870, 3310, 5230, 7480], partialDec: 0.38, partialG: 0.30,
      grains: 0, span: 0.05
    },
    wood: {
      level: 0.92, crackF: 1900, crackQ: 1.5, crackDec: 0.024, crackG: 0.85,
      bodyF0: 1100, bodyF1: 300, bodyQ: 1.1, bodyDec: 0.10, bodyG: 0.72,
      subF0: 150, subF1: 80, subDec: 0.07, subG: 0.34,
      partials: [318, 742], partialDec: 0.16, partialG: 0.22,
      grains: 3, grainLo: 1400, grainHi: 4200, grainG: 0.18, span: 0.10
    },
    glass: {
      level: 1.0, crackF: 7200, crackQ: 1.6, crackDec: 0.016, crackG: 1.0,
      bodyF0: 3800, bodyF1: 1500, bodyQ: 1.2, bodyDec: 0.05, bodyG: 0.40,
      subF0: 240, subF1: 150, subDec: 0.03, subG: 0.12,
      partials: [4900, 7300, 9800], partialDec: 0.20, partialG: 0.22,
      grains: 16, grainLo: 3800, grainHi: 13000, grainG: 0.55, span: 0.55
    },
    sand: {
      level: 0.72, crackF: 1400, crackQ: 0.7, crackDec: 0.02, crackG: 0.35,
      bodyF0: 900, bodyF1: 200, bodyQ: 0.5, bodyDec: 0.13, bodyG: 0.95,
      subF0: 110, subF1: 55, subDec: 0.07, subG: 0.34,
      grains: 3, grainLo: 900, grainHi: 2600, grainG: 0.12, span: 0.18
    },
    dirt: {
      level: 0.78, crackF: 1700, crackQ: 0.9, crackDec: 0.02, crackG: 0.45,
      bodyF0: 1000, bodyF1: 240, bodyQ: 0.6, bodyDec: 0.115, bodyG: 0.9,
      subF0: 120, subF1: 58, subDec: 0.07, subG: 0.36,
      grains: 5, grainLo: 1100, grainHi: 3400, grainG: 0.20, span: 0.22
    },
    water: {
      level: 0.80, crackF: 3200, crackQ: 0.8, crackDec: 0.02, crackG: 0.5,
      bodyF0: 2200, bodyF1: 400, bodyQ: 0.5, bodyDec: 0.20, bodyG: 0.95,
      subF0: 220, subF1: 90, subDec: 0.09, subG: 0.30,
      grains: 8, grainLo: 2200, grainHi: 9000, grainG: 0.30, span: 0.35
    },
    flesh: {
      level: 0.88, crackF: 1500, crackQ: 1.0, crackDec: 0.014, crackG: 0.5,
      bodyF0: 700, bodyF1: 180, bodyQ: 0.9, bodyDec: 0.085, bodyG: 0.9,
      subF0: 165, subF1: 62, subDec: 0.075, subG: 0.55,
      grains: 4, grainLo: 700, grainHi: 2200, grainG: 0.20, span: 0.12
    },
    foliage: {
      level: 0.6, crackF: 4200, crackQ: 1.0, crackDec: 0.02, crackG: 0.4,
      bodyF0: 3000, bodyF1: 1200, bodyQ: 0.6, bodyDec: 0.14, bodyG: 0.55,
      subF0: 260, subF1: 160, subDec: 0.04, subG: 0.10,
      grains: 10, grainLo: 2600, grainHi: 9000, grainG: 0.34, span: 0.30
    },
    fabric: {
      level: 0.6, crackF: 2400, crackQ: 0.8, crackDec: 0.014, crackG: 0.35,
      bodyF0: 1200, bodyF1: 400, bodyQ: 0.6, bodyDec: 0.075, bodyG: 0.55,
      subF0: 170, subF1: 90, subDec: 0.05, subG: 0.20,
      grains: 3, grainLo: 1800, grainHi: 5200, grainG: 0.14, span: 0.10
    }
  };
  var IMPACT_ALIAS = {
    concrete_wall: 'concrete', asphalt: 'concrete', tile: 'concrete',
    stone: 'concrete', brick: 'concrete', rubble: 'concrete',
    gravel: 'dirt', rock: 'concrete',
    painted_metal: 'metal', rusted_metal: 'metal', corrugated_metal: 'metal',
    steel: 'metal', wood_plank: 'wood', plank: 'wood', crate: 'wood',
    body: 'flesh', head: 'flesh', blood: 'flesh', enemy: 'flesh',
    rubber: 'fabric', carpet: 'fabric', cloth: 'fabric', canopy: 'fabric'
  };

  // --------------------------------------------------------------------------
  // Reverb presets. `er` = discrete early reflections (time, gain).
  // The late field is exponentially decaying noise whose lowpass corner falls
  // over time, because in a real room the high frequencies die first.
  // --------------------------------------------------------------------------
  var IR_PRESETS = {
    outdoor: {
      len: 1.45, predelay: 0.012, build: 0.006, decay: 4.6,
      hf0: 9500, hfDecay: 2.4, diffuse: 0.72, wet: 0.34,
      er: [[0.011, 0.55], [0.021, 0.42], [0.034, 0.34], [0.052, 0.26],
           [0.078, 0.20], [0.112, 0.15], [0.163, 0.11], [0.241, 0.075]]
    },
    interior: {
      len: 0.95, predelay: 0.004, build: 0.002, decay: 7.4,
      hf0: 4600, hfDecay: 3.4, diffuse: 1.0, wet: 0.42,
      er: [[0.0035, 0.62], [0.0072, 0.52], [0.0118, 0.44], [0.0175, 0.36],
           [0.0244, 0.30], [0.0331, 0.24], [0.0448, 0.18], [0.0612, 0.13]]
    },
    alley: {
      len: 1.25, predelay: 0.006, build: 0.003, decay: 5.4,
      hf0: 7200, hfDecay: 2.6, diffuse: 0.86, wet: 0.46,
      // Evenly spaced reflections between two parallel walls = flutter echo.
      er: [[0.0182, 0.62], [0.0364, 0.50], [0.0546, 0.41], [0.0728, 0.33],
           [0.0910, 0.26], [0.1092, 0.21], [0.1274, 0.16], [0.1456, 0.12],
           [0.1638, 0.09]]
    },
    hall: {
      len: 2.55, predelay: 0.019, build: 0.012, decay: 2.6,
      hf0: 7800, hfDecay: 1.55, diffuse: 1.0, wet: 0.48,
      er: [[0.019, 0.50], [0.031, 0.42], [0.046, 0.36], [0.067, 0.30],
           [0.094, 0.24], [0.128, 0.19], [0.171, 0.14], [0.229, 0.10]]
    }
  };

  // Multi-tap "slap-back off the buildings" network, per environment.
  var ECHO_PRESETS = {
    outdoor: {
      times: [0.086, 0.157, 0.271, 0.442], gains: [0.36, 0.25, 0.155, 0.09],
      cuts: [5400, 3500, 2200, 1250], pans: [-0.72, 0.62, -0.36, 0.28], fb: 0.0
    },
    alley: {
      times: [0.0195, 0.0381, 0.0592, 0.1210], gains: [0.42, 0.34, 0.26, 0.15],
      cuts: [6800, 5200, 3800, 2500], pans: [-0.85, 0.80, -0.52, 0.34], fb: 0.44
    },
    interior: {
      times: [0.0112, 0.0236, 0.0418, 0.0715], gains: [0.28, 0.21, 0.145, 0.085],
      cuts: [4200, 3000, 2100, 1500], pans: [-0.55, 0.48, -0.30, 0.22], fb: 0.20
    },
    hall: {
      times: [0.062, 0.121, 0.203, 0.334], gains: [0.30, 0.24, 0.175, 0.115],
      cuts: [3800, 2700, 1900, 1200], pans: [-0.65, 0.58, -0.34, 0.26], fb: 0.30
    }
  };

  // Formant tables (F1,F2,F3) for abstract shouting. Real vowels, no words.
  var VOWELS = {
    a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010],
    o: [570, 840, 2410], u: [325, 700, 2240], ae: [660, 1720, 2410]
  };
  var VOCALS = {
    shout:  { f0: [165, 235], slide: -0.22, dur: [0.34, 0.52], v: ['a', 'e'],  noise: 0.30, level: 1.00 },
    alert:  { f0: [180, 250], slide: 0.16,  dur: [0.24, 0.36], v: ['e', 'i'],  noise: 0.26, level: 0.95 },
    order:  { f0: [140, 190], slide: -0.14, dur: [0.42, 0.66], v: ['o', 'a'],  noise: 0.24, level: 0.90 },
    pain:   { f0: [200, 300], slide: -0.30, dur: [0.26, 0.40], v: ['a', 'o'],  noise: 0.42, level: 0.95 },
    death:  { f0: [185, 240], slide: -0.62, dur: [0.65, 0.95], v: ['a', 'u'],  noise: 0.50, level: 1.00 },
    grunt:  { f0: [120, 165], slide: -0.18, dur: [0.14, 0.22], v: ['u', 'o'],  noise: 0.38, level: 0.75 },
    taunt:  { f0: [155, 215], slide: 0.10,  dur: [0.40, 0.60], v: ['ae', 'o'], noise: 0.28, level: 0.85 }
  };

  // --------------------------------------------------------------------------
  // Tiny scheduling helpers. These exist because raw AudioParam scheduling is
  // extremely easy to get subtly wrong (exponential ramps to zero throw).
  // --------------------------------------------------------------------------
  var FLOOR = 0.0006;

  // Percussive envelope: near-instant attack, exponential decay, hard zero.
  function env(param, t0, peak, atk, dec) {
    if (!param) return t0;
    peak = Math.max(FLOOR * 2, peak);
    param.setValueAtTime(FLOOR, t0);
    if (atk > 0.00005) param.linearRampToValueAtTime(peak, t0 + atk);
    else param.setValueAtTime(peak, t0 + 0.00005);
    var end = t0 + atk + dec;
    param.exponentialRampToValueAtTime(FLOOR, end);
    param.setValueAtTime(0, end + 0.004);
    return end + 0.006;
  }

  // Envelope with a sustain plateau - for anything with body (vocals, wind).
  function envAHD(param, t0, peak, atk, hold, dec) {
    if (!param) return t0;
    peak = Math.max(FLOOR * 2, peak);
    param.setValueAtTime(FLOOR, t0);
    param.linearRampToValueAtTime(peak, t0 + atk);
    param.setValueAtTime(peak, t0 + atk + hold);
    var end = t0 + atk + hold + dec;
    param.exponentialRampToValueAtTime(FLOOR, end);
    param.setValueAtTime(0, end + 0.004);
    return end + 0.006;
  }

  function sweep(param, t0, f0, f1, dur) {
    if (!param) return;
    param.setValueAtTime(Math.max(10, f0), t0);
    param.exponentialRampToValueAtTime(Math.max(10, f1), t0 + Math.max(0.002, dur));
  }

  function pos3(panner, x, y, z, t) {
    if (!panner) return;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(x, t);
      panner.positionY.setValueAtTime(y, t);
      panner.positionZ.setValueAtTime(z, t);
    } else if (panner.setPosition) {
      panner.setPosition(x, y, z);
    }
  }

  // Pull a Vector3-like out of whatever an event handed us.
  function vecOf(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.x === 'number' && typeof o.z === 'number') return o;
    if (o.position && typeof o.position.x === 'number') return o.position;
    if (o.point && typeof o.point.x === 'number') return o.point;
    if (o.origin && typeof o.origin.x === 'number') return o.origin;
    return null;
  }

  function strOf(o, keys, fallback) {
    if (typeof o === 'string') return o;
    if (o && typeof o === 'object') {
      for (var i = 0; i < keys.length; i++) {
        var v = o[keys[i]];
        if (typeof v === 'string' && v) return v;
        if (v && typeof v.name === 'string') return v.name;
      }
    }
    return fallback;
  }

  // Narrowband make-up gain.
  // A bandpass only passes ~f0/Q Hz of a broadband noise source, so a burst
  // with Q=8 comes out roughly 20dB below its nominal gain while a Q=1 burst
  // comes out near it. The layered weapon/impact sounds are balanced by ear
  // around wide filters; the few deliberately narrow ones (UI ticks) need this
  // compensation or they measure ~-34dBFS and vanish under gunfire.
  var NB = 9.0;

  // Soft-clip curve. A little saturation on the low layers of a gunshot adds
  // harmonics, which is what makes the sub audible on laptop speakers.
  function driveCurve(amount) {
    var n = 1024, c = new Float32Array(n);
    var k = 1 + amount * 24;
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / Math.tanh(k);
    }
    return c;
  }

  // ==========================================================================
  // Audio system
  // ==========================================================================
  function Audio(ctx) {
    this.ctx = ctx || null;
    this.actx = null;
    this.available = false;     // an AudioContext exists
    this.armed = false;         // context running; safe to schedule
    this.muted = false;
    this.reverbPreset = 'outdoor';
    this.masterVolume = 0.85;

    // Own RNG so audio jitter never perturbs the shared deterministic stream
    // that the visual capture pipeline depends on.
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = new GAME.RNG((seed ^ 0x00A0D109) >>> 0);

    this.buffers = Object.create(null);
    this.irs = Object.create(null);
    this.buses = Object.create(null);
    this._voices = [];
    this._freeVoices = [];
    this._pending = null;       // GAME.Pool of live sub-graph records
    this._ambNodes = [];
    this._ambBuilt = false;

    this._listener = { x: 0, y: 1.6, z: 0 };
    this._duck = 0;             // 0..1 ambience ducking amount
    this._ringLevel = 0;        // 0..1 ear-ringing amount (see _earRing)
    this._ringOscUntil = 0;
    this._occBudget = 6;
    this._lastShot = -1;
    this._lastStep = -1;
    this._lastImpact = -1;
    this._shotIndex = 0;
    this._pendingEcho = null;
    this._autoReverbTimer = 0.4;
    this._ambTimers = [];
    this._boundUnlock = null;
    this._suspendedWarned = false;

    try { this._createContext(); }
    catch (e) { this.available = false; GAME.logError('audio.ctor', e); }
  }

  // --------------------------------------------------------------------------
  // Context + master graph
  // --------------------------------------------------------------------------
  Audio.prototype._createContext = function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                       // headless / unsupported: stay silent
    try {
      this.actx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      try { this.actx = new AC(); } catch (e2) { this.actx = null; }
    }
    if (!this.actx) return;
    this.available = true;
    this.sampleRate = this.actx.sampleRate || 48000;
    this._buildGraph();
    this._bindGestureUnlock();
  };

  Audio.prototype._buildGraph = function () {
    var a = this.actx;

    // --- final stage ---------------------------------------------------------
    // A limiter, not a musical compressor: fast attack, high ratio. Gunshots
    // have 30dB of crest factor and would clip the DAC without it.
    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.0025;
    this.limiter.release.value = 0.18;
    this.limiter.connect(a.destination);

    this.master = a.createGain();
    this.master.gain.value = 0;          // faded up on unlock
    this.master.connect(this.limiter);

    // Ear-ringing muffle. Sits at 20k (transparent) until an explosion.
    this.muffle = a.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.Q.value = 0.6;
    this.muffle.frequency.value = Math.min(21000, this.sampleRate * 0.46);
    this.muffle.connect(this.master);

    this.preMaster = a.createGain();
    this.preMaster.gain.value = 1;
    this.preMaster.connect(this.muffle);

    // Tinnitus tone bypasses the muffle - it is generated *inside your head*.
    this.tinnitusOut = a.createGain();
    this.tinnitusOut.gain.value = 1;
    this.tinnitusOut.connect(this.master);

    // --- reverb --------------------------------------------------------------
    this.reverbIn = a.createGain();
    this.reverbIn.gain.value = 1;
    this.reverbOut = a.createGain();
    this.reverbOut.gain.value = 1;
    this.reverbOut.connect(this.preMaster);

    // Two convolvers so setReverb() can crossfade instead of clicking when the
    // buffer is swapped mid-tail.
    this.convA = a.createConvolver(); this.convA.normalize = false;
    this.convB = a.createConvolver(); this.convB.normalize = false;
    this.convAGain = a.createGain(); this.convAGain.gain.value = 1;
    this.convBGain = a.createGain(); this.convBGain.gain.value = 0;
    this.reverbIn.connect(this.convA); this.convA.connect(this.convAGain);
    this.convAGain.connect(this.reverbOut);
    this.reverbIn.connect(this.convB); this.convB.connect(this.convBGain);
    this.convBGain.connect(this.reverbOut);
    this._activeConv = 'A';

    // Pre-reverb highpass: convolving sub-bass just makes mud.
    this.reverbHP = a.createBiquadFilter();
    this.reverbHP.type = 'highpass';
    this.reverbHP.frequency.value = 130;
    this.reverbHP.Q.value = 0.5;
    // rewire: reverbIn -> HP -> convolvers
    this.reverbIn.disconnect();
    this.reverbIn.connect(this.reverbHP);
    this.reverbHP.connect(this.convA);
    this.reverbHP.connect(this.convB);

    this._buildEcho();

    // --- buses ---------------------------------------------------------------
    var busDefs = [
      ['weapon', 1.00, 0.20],
      ['world', 0.88, 0.17],
      ['ambient', 0.55, 0.05],
      ['voice', 0.82, 0.22],
      ['ui', 0.60, 0.00]
    ];
    this.busTrim = Object.create(null);
    this.busSend = Object.create(null);
    for (var i = 0; i < busDefs.length; i++) {
      var d = busDefs[i];
      var g = a.createGain();
      g.gain.value = d[1];
      g.connect(this.preMaster);
      if (d[2] > 0) {
        var s = a.createGain();
        s.gain.value = d[2];
        g.connect(s);
        s.connect(this.reverbIn);
        this.busSend[d[0]] = s;
      }
      this.buses[d[0]] = g;
      this.busTrim[d[0]] = d[1];
    }
    this._ambientBase = this.busTrim.ambient;

    // --- pools ---------------------------------------------------------------
    this._pending = new GAME.Pool(
      function () { return { t: 0, nodes: [], voice: null }; },
      function (r) { r.nodes.length = 0; r.voice = null; r.t = 0; },
      48);

    this._buildVoices();
  };

  // Multi-tap delay network: the discrete slap-back off building faces. This is
  // the single biggest reason a gunshot sounds like it is happening in a PLACE
  // rather than in a vacuum, and it is far cheaper than a longer convolution.
  Audio.prototype._buildEcho = function () {
    var a = this.actx;
    this.slapIn = a.createGain();
    this.slapIn.gain.value = 1;
    this.echoOut = a.createGain();
    this.echoOut.gain.value = 1;
    this.echoOut.connect(this.preMaster);

    // Echoes should themselves be reverberant - they bounced off a wall 40m away.
    this.echoToVerb = a.createGain();
    this.echoToVerb.gain.value = 0.30;
    this.echoOut.connect(this.echoToVerb);
    this.echoToVerb.connect(this.reverbIn);

    this.echoTaps = [];
    for (var i = 0; i < 4; i++) {
      var d = a.createDelay(1.5);
      var f = a.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 0.4;
      var g = a.createGain(); g.gain.value = 0;
      var p = a.createStereoPanner ? a.createStereoPanner() : null;
      this.slapIn.connect(d);
      d.connect(f);
      f.connect(g);
      if (p) { g.connect(p); p.connect(this.echoOut); }
      else { g.connect(this.echoOut); }
      this.echoTaps.push({ delay: d, filter: f, gain: g, pan: p });
    }
    // Feedback around tap 1 gives the alley its flutter. The DelayNode in the
    // loop is what makes the cycle legal in the Web Audio graph.
    this.echoFb = a.createGain();
    this.echoFb.gain.value = 0;
    this.echoFbFilter = a.createBiquadFilter();
    this.echoFbFilter.type = 'lowpass';
    this.echoFbFilter.frequency.value = 3200;
    this.echoTaps[1].filter.connect(this.echoFbFilter);
    this.echoFbFilter.connect(this.echoFb);
    this.echoFb.connect(this.echoTaps[1].delay);

    this._applyEchoPreset('outdoor', 0);
  };

  Audio.prototype._buildVoices = function () {
    // Voices are created lazily up to MAX_VOICES; pre-warm a handful so the
    // first burst of fire does not allocate mid-frame.
    for (var i = 0; i < 8; i++) this._voices.push(this._makeVoice());
    for (var j = 0; j < this._voices.length; j++) this._freeVoices.push(this._voices[j]);
  };

  Audio.prototype._makeVoice = function () {
    var a = this.actx;
    var panner = a.createPanner();
    var hrtf = !(this.ctx && this.ctx.quality && this.ctx.quality.level === 'low');
    panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 6;
    panner.maxDistance = 320;
    panner.rolloffFactor = 1.0;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1;

    // Air absorption + occlusion live here. Filtering after the HRTF panner is
    // mathematically identical to filtering before it (both LTI), and matches
    // the documented chain order.
    var filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.35;
    filter.frequency.value = 20000;

    var gain = a.createGain();
    gain.gain.value = 1;

    panner.connect(filter);
    filter.connect(gain);
    return { panner: panner, filter: filter, out: gain, bus: null };
  };

  Audio.prototype._acquireVoice = function () {
    if (this._freeVoices.length) return this._freeVoices.pop();
    if (this._voices.length < MAX_VOICES) {
      var v = this._makeVoice();
      this._voices.push(v);
      return v;
    }
    return null;   // voice-limited: drop the sound rather than steal a tail
  };

  Audio.prototype._releaseVoice = function (v) {
    if (!v) return;
    try { v.out.disconnect(); } catch (e) { /* already gone */ }
    v.bus = null;
    this._freeVoices.push(v);
  };

  // --------------------------------------------------------------------------
  // Generated source material: noise beds and impulse responses.
  // --------------------------------------------------------------------------

  // White noise. Everything percussive starts here.
  Audio.prototype._makeWhite = function (seconds) {
    var sr = this.sampleRate, n = Math.floor(sr * seconds);
    var buf = this.actx.createBuffer(1, n, sr);
    var d = buf.getChannelData(0), rng = this.rng;
    for (var i = 0; i < n; i++) d[i] = rng.range(-1, 1);
    return buf;
  };

  // Pink noise (-3dB/oct) via the Voss-McCartney style Paul Kellet filter.
  // Wind and distant city ambience are pink, not white - white noise as an
  // ambience bed is the classic "this sounds like a broken TV" mistake.
  Audio.prototype._makePink = function (seconds, channels) {
    var sr = this.sampleRate, n = Math.floor(sr * seconds);
    channels = channels || 2;
    var buf = this.actx.createBuffer(channels, n, sr);
    var rng = this.rng;
    for (var c = 0; c < channels; c++) {
      var d = buf.getChannelData(c);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (var i = 0; i < n; i++) {
        var w = rng.range(-1, 1);
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    return buf;
  };

  // Brown/red noise (-6dB/oct): distant traffic rumble, explosion body.
  Audio.prototype._makeBrown = function (seconds, channels) {
    var sr = this.sampleRate, n = Math.floor(sr * seconds);
    channels = channels || 2;
    var buf = this.actx.createBuffer(channels, n, sr);
    var rng = this.rng;
    for (var c = 0; c < channels; c++) {
      var d = buf.getChannelData(c), last = 0;
      for (var i = 0; i < n; i++) {
        var w = rng.range(-1, 1);
        last = (last + 0.017 * w) / 1.017;
        d[i] = last * 4.2;
      }
    }
    return buf;
  };

  // Sparse impulsive noise - the raw material for gravel, glass and debris
  // patter. Grains, not a wash.
  Audio.prototype._makeGrain = function (seconds) {
    var sr = this.sampleRate, n = Math.floor(sr * seconds);
    var buf = this.actx.createBuffer(1, n, sr);
    var d = buf.getChannelData(0), rng = this.rng;
    var i = 0;
    while (i < n) {
      var gap = Math.floor(rng.range(0.0006, 0.004) * sr);
      var len = Math.floor(rng.range(0.0004, 0.0018) * sr);
      var amp = rng.range(0.35, 1.0);
      for (var k = 0; k < len && i + k < n; k++) {
        d[i + k] = rng.range(-1, 1) * amp * (1 - k / len);
      }
      i += gap + len;
    }
    return buf;
  };

  // Crossfade a buffer's tail into its head so a looping source has no seam.
  Audio.prototype._sealLoop = function (buffer, fadeSec) {
    var sr = this.sampleRate;
    var f = Math.min(Math.floor(fadeSec * sr), Math.floor(buffer.length * 0.25));
    for (var c = 0; c < buffer.numberOfChannels; c++) {
      var d = buffer.getChannelData(c);
      var n = buffer.length;
      for (var i = 0; i < f; i++) {
        var t = i / f;                 // equal-power crossfade
        var a = Math.cos(t * Math.PI * 0.5), b = Math.sin(t * Math.PI * 0.5);
        d[i] = d[i] * b + d[n - f + i] * a;
      }
      // The tail region is now duplicated at the head; taper it so the loop
      // point lands on the faded copy.
      for (var j = 0; j < f; j++) d[n - f + j] = 0;
      buffer._loopEnd = (n - f) / sr;
    }
    return buffer;
  };

  // Impulse response: exponentially decaying, progressively darkening noise
  // with explicit early reflections stamped on top. Generated per preset.
  Audio.prototype._makeIR = function (name) {
    var P = IR_PRESETS[name] || IR_PRESETS.outdoor;
    var sr = this.sampleRate;
    var pre = Math.floor(P.predelay * sr);
    var len = Math.floor(P.len * sr) + pre;
    var buf = this.actx.createBuffer(2, len, sr);
    // Deterministic per preset so two runs produce byte-identical reverb.
    var rng = new GAME.RNG((0x5EED ^ hashStr(name)) >>> 0);
    var total = 0;

    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c);
      var lp = 0, hpPrev = 0, hp = 0;
      for (var i = pre; i < len; i++) {
        var t = (i - pre) / sr;
        var n = rng.range(-1, 1);
        // One-pole lowpass whose corner falls exponentially: HF dies first,
        // which is what actually makes a tail sound like air and plaster.
        var cut = P.hf0 * Math.exp(-t * P.hfDecay) + 220;
        var k = 1 - Math.exp(-2 * Math.PI * Math.min(cut, sr * 0.45) / sr);
        lp += (n - lp) * k;
        // One-pole highpass kills the DC/rumble build-up.
        hp = 0.9965 * (hp + lp - hpPrev);
        hpPrev = lp;
        var build = t < P.build ? (t / P.build) : 1;
        d[i] = hp * Math.exp(-t * P.decay) * build * P.diffuse;
      }
      // Early reflections. Small per-channel time and gain offsets decorrelate
      // the two ears, which is what gives the reverb width.
      for (var e = 0; e < P.er.length; e++) {
        var er = P.er[e];
        var jitter = rng.range(-0.0016, 0.0016) + (c ? 0.0011 : -0.0011);
        var idx = pre + Math.floor((er[0] + jitter) * sr);
        if (idx < 1 || idx >= len - 2) continue;
        var g = er[1] * rng.range(0.78, 1.18) * (rng.bool() ? 1 : -1);
        // Smear each reflection over 3 samples so it is a slap, not a tick.
        d[idx - 1] += g * 0.35;
        d[idx] += g;
        d[idx + 1] += g * 0.45;
      }
      for (var s = 0; s < len; s++) total += d[s] * d[s];
    }

    // Normalise total energy so switching presets does not jump the wet level.
    var norm = total > 1e-9 ? (1.0 / Math.sqrt(total)) * 14 * P.wet : 0;
    for (var cc = 0; cc < 2; cc++) {
      var dd = buf.getChannelData(cc);
      for (var q = 0; q < len; q++) dd[q] *= norm;
    }
    return buf;
  };

  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // --------------------------------------------------------------------------
  // build() - heavy generation, yields so the loading bar can paint.
  // --------------------------------------------------------------------------
  Audio.prototype.build = async function () {
    if (!this.available) return;
    try {
      this.buffers.white = this._makeWhite(2.5);
      this.buffers.grain = this._makeGrain(1.2);
      await GAME.yieldFrame();

      this.buffers.pink = this._sealLoop(this._makePink(6.0, 2), 0.5);
      await GAME.yieldFrame();

      this.buffers.brown = this._sealLoop(this._makeBrown(7.0, 2), 0.6);
      await GAME.yieldFrame();

      // In a headless capture there is no audio device and nothing is ever
      // unlocked, so skip ~700k samples of convolution data we would never use.
      if (!GAME.headless) {
        var names = ['outdoor', 'interior', 'alley', 'hall'];
        for (var i = 0; i < names.length; i++) {
          this.irs[names[i]] = this._makeIR(names[i]);
          await GAME.yieldFrame();
        }
        this.convA.buffer = this.irs.outdoor;
        this.convB.buffer = this.irs.outdoor;
      }

      this._driveCurve = driveCurve(1.0);
      this._bindEvents();
      this._resetAmbienceSchedule();
    } catch (e) {
      GAME.logError('audio.build', e);
      this.available = false;
    }
  };

  Audio.prototype._ensureIR = function (name) {
    if (!this.available) return null;
    if (!this.irs[name]) {
      try { this.irs[name] = this._makeIR(name); }
      catch (e) { GAME.logError('audio.ir:' + name, e); return null; }
    }
    return this.irs[name];
  };

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------
  Audio.prototype._bindGestureUnlock = function () {
    if (GAME.headless || !window.addEventListener) return;
    var self = this;
    // main.js unlocks on the Deploy button, but pointer-lock clicks and key
    // presses are equally valid gestures - never leave the player in silence
    // because they skipped the button.
    var fn = this._boundUnlock = function () { self.unlock(); };
    window.addEventListener('pointerdown', fn, true);
    window.addEventListener('keydown', fn, true);
    window.addEventListener('touchstart', fn, true);
  };

  Audio.prototype._unbindGestureUnlock = function () {
    if (!this._boundUnlock || !window.removeEventListener) return;
    window.removeEventListener('pointerdown', this._boundUnlock, true);
    window.removeEventListener('keydown', this._boundUnlock, true);
    window.removeEventListener('touchstart', this._boundUnlock, true);
    this._boundUnlock = null;
  };

  Audio.prototype.unlock = function () {
    if (!this.available || this.armed) return;
    var self = this;
    try {
      if (this.actx.state === 'suspended' && this.actx.resume) {
        var p = this.actx.resume();
        if (p && p.then) p.then(function () { self._arm(); },
          function () { /* no device; stay silent */ });
        else this._arm();
      } else {
        this._arm();
      }
    } catch (e) {
      GAME.logError('audio.unlock', e);
    }
  };

  Audio.prototype._arm = function () {
    if (this.armed || !this.available) return;
    if (this.actx.state !== 'running') return;   // no device: remain silent
    this.armed = true;
    this._unbindGestureUnlock();
    try {
      // Make sure the reverb has a buffer even if build() skipped IR generation.
      if (!this.convA.buffer) {
        var ir = this._ensureIR(this.reverbPreset) || this._ensureIR('outdoor');
        if (ir) { this.convA.buffer = ir; this.convB.buffer = ir; }
      }
      var t = this.actx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(0.0001, t);
      this.master.gain.linearRampToValueAtTime(
        this.muted ? 0.0001 : this.masterVolume, t + 0.45);
      this._buildAmbience();
    } catch (e) {
      GAME.logError('audio.arm', e);
    }
  };

  Audio.prototype.setMasterVolume = function (v) {
    this.masterVolume = M.clamp(v, 0, 1.5);
    if (!this.armed) return;
    try {
      var t = this.actx.currentTime;
      this.master.gain.setTargetAtTime(
        this.muted ? 0.0001 : this.masterVolume, t, 0.05);
    } catch (e) { /* ignore */ }
  };

  Audio.prototype.setMuted = function (m) {
    this.muted = !!m;
    this.setMasterVolume(this.masterVolume);
  };

  Audio.prototype.suspend = function () {
    if (!this.available) return;
    try { if (this.actx.suspend) this.actx.suspend(); } catch (e) { /* ignore */ }
  };

  Audio.prototype.dispose = function () {
    this._unbindGestureUnlock();
    if (!this.available) return;
    try {
      this._reapAll();
      if (this.actx.close) this.actx.close();
    } catch (e) { /* ignore */ }
    this.available = false;
    this.armed = false;
  };

  // --------------------------------------------------------------------------
  // Sub-graph lifetime.
  //
  // Web Audio sources are single-use, so we pool the expensive part (the
  // panner/filter channel) and rebuild only the cheap source nodes. Every
  // sub-graph is recorded with the audio-clock time at which it is guaranteed
  // silent, and update() disconnects it then. Using the clock rather than
  // `onended` means a suspended or throttled context can never strand nodes.
  // --------------------------------------------------------------------------
  Audio.prototype._open = function (busName, opts) {
    if (!this.armed || this.muted) return null;
    opts = opts || EMPTY;
    var a = this.actx;
    var bus = this.buses[busName] || this.buses.world;
    var voice = null;

    if (opts.position) {
      voice = this._acquireVoice();
      if (!voice) return null;          // over budget: drop, do not fall back to 2D
    }

    var rec = this._pending.acquire();
    rec.t = a.currentTime + 6;          // safety reap if _close is never called

    var head = a.createGain();
    var vol = opts.volume === undefined ? 1 : opts.volume;
    head.gain.value = Math.max(0, vol);
    rec.nodes.push(head);

    if (voice) {
      this._placeVoice(voice, opts);
      voice.out.connect(bus);
      voice.bus = bus;
      head.connect(voice.panner);
      rec.voice = voice;
    } else {
      head.connect(bus);
    }

    // Per-sound reverb/echo sends on top of the bus send. Gunshots need far
    // more tail than a footstep even though they share the world bus.
    if (opts.send > 0) {
      var sg = a.createGain();
      sg.gain.value = opts.send;
      head.connect(sg);
      sg.connect(this.reverbIn);
      rec.nodes.push(sg);
    }
    if (opts.slap > 0) {
      var sl = a.createGain();
      sl.gain.value = opts.slap;
      head.connect(sl);
      sl.connect(this.slapIn);
      rec.nodes.push(sl);
    }

    var t0 = a.currentTime + LOOKAHEAD + Math.max(0, opts.delay || 0);
    return { a: a, dest: head, t0: t0, end: t0, rec: rec };
  };

  Audio.prototype._close = function (h, extraTail) {
    if (!h) return;
    h.rec.t = h.end + (extraTail || 0) + 0.05;
    // Guard against runaway node counts if something spams play().
    if (this._pending.active.length > MAX_PENDING) this._reapOldest(24);
  };

  Audio.prototype._track = function (h, node) {
    if (h && node) h.rec.nodes.push(node);
    return node;
  };

  Audio.prototype._reap = function (rec) {
    for (var i = 0; i < rec.nodes.length; i++) {
      try { rec.nodes[i].disconnect(); } catch (e) { /* already detached */ }
    }
    if (rec.voice) this._releaseVoice(rec.voice);
  };

  Audio.prototype._sweep = function () {
    var act = this._pending.active;
    var now = this.actx.currentTime;
    for (var i = act.length - 1; i >= 0; i--) {
      if (act[i].t <= now) {
        this._reap(act[i]);
        this._pending.releaseAt(i);
      }
    }
  };

  Audio.prototype._reapOldest = function (n) {
    var act = this._pending.active;
    for (var i = 0; i < n && act.length; i++) {
      // active[] order is scrambled by releaseAt, so just take from the front.
      this._reap(act[0]);
      this._pending.releaseAt(0);
    }
  };

  Audio.prototype._reapAll = function () {
    var act = this._pending && this._pending.active;
    if (!act) return;
    for (var i = act.length - 1; i >= 0; i--) {
      this._reap(act[i]);
      this._pending.releaseAt(i);
    }
  };

  // Distance attenuation, air absorption and (budgeted) geometric occlusion.
  Audio.prototype._placeVoice = function (voice, opts) {
    var a = this.actx, t = a.currentTime;
    var p = opts.position;
    pos3(voice.panner, p.x, p.y, p.z, t);
    voice.panner.refDistance = opts.refDistance || 6;
    voice.panner.rolloffFactor = opts.rolloff === undefined ? 1.0 : opts.rolloff;

    var lx = p.x - this._listener.x, ly = p.y - this._listener.y, lz = p.z - this._listener.z;
    var dist = Math.sqrt(lx * lx + ly * ly + lz * lz);

    // Air absorption: high frequencies scrub off with distance. A rifle at 80m
    // is all low-mid thud, which is exactly the cue that tells you it is far.
    var cut = 21000 * Math.exp(-dist * 0.030);
    var gainMul = 1;

    if (opts.occlude !== false && dist > 2.5 && this._occBudget > 0) {
      var lvl = this.ctx && this.ctx.level;
      if (lvl && lvl.raycast) {
        this._occBudget--;
        try {
          var inv = 1 / dist;
          var hit = lvl.raycast(
            { x: this._listener.x, y: this._listener.y, z: this._listener.z },
            { x: lx * inv, y: ly * inv, z: lz * inv },
            dist - 0.35);
          if (hit && hit.hit) {
            // Muffled through a wall: mostly low end, well down in level.
            cut = Math.min(cut, 420);
            gainMul = 0.42;
          }
        } catch (e) { /* level may still be building */ }
      }
    }
    if (opts.muffle) { cut = Math.min(cut, opts.muffle); }

    voice.filter.frequency.setValueAtTime(
      M.clamp(cut, 180, this.sampleRate * 0.45), t);
    voice.out.gain.setValueAtTime(gainMul, t);
  };

  // --------------------------------------------------------------------------
  // Synth primitives
  // --------------------------------------------------------------------------
  Audio.prototype._src = function (h, name, t0, dur, rate) {
    var buf = this.buffers[name] || this.buffers.white;
    if (!buf) return null;
    var s = this.actx.createBufferSource();
    s.buffer = buf;
    if (rate && rate !== 1) s.playbackRate.value = rate;
    var maxOff = Math.max(0, buf.duration - 0.05 - dur * (rate || 1));
    try { s.start(t0, maxOff > 0 ? this.rng.range(0, maxOff) : 0); }
    catch (e) { return null; }
    try { s.stop(t0 + dur + 0.02); } catch (e) { /* ignore */ }
    this._track(h, s);
    return s;
  };

  Audio.prototype._osc = function (h, type, t0, dur) {
    var o = this.actx.createOscillator();
    o.type = type || 'sine';
    try { o.start(t0); o.stop(t0 + dur + 0.02); } catch (e) { return null; }
    this._track(h, o);
    return o;
  };

  Audio.prototype._filter = function (h, type, freq, q) {
    var f = this.actx.createBiquadFilter();
    f.type = type;
    f.frequency.value = M.clamp(freq, 10, this.sampleRate * 0.46);
    if (q !== undefined) f.Q.value = q;
    this._track(h, f);
    return f;
  };

  Audio.prototype._gain = function (h, v) {
    var g = this.actx.createGain();
    g.gain.value = v === undefined ? 1 : v;
    this._track(h, g);
    return g;
  };

  // A band-limited noise burst - the atom of nearly every sound in this file.
  // Returns the time at which it is silent.
  Audio.prototype._burst = function (h, opts) {
    var t0 = opts.t;
    var dur = opts.atk + opts.dec;
    var s = this._src(h, opts.buffer || 'white', t0, dur, opts.rate || 1);
    if (!s) return t0;
    var g = this._gain(h, 0);
    var node = s;
    if (opts.type) {
      var f = this._filter(h, opts.type, opts.f0, opts.q);
      if (opts.f1 && opts.f1 !== opts.f0) sweep(f.frequency, t0, opts.f0, opts.f1, opts.sweepDur || dur);
      node.connect(f);
      node = f;
    }
    if (opts.hp) {
      var hp = this._filter(h, 'highpass', opts.hp, 0.6);
      node.connect(hp);
      node = hp;
    }
    node.connect(g);
    g.connect(opts.dest || h.dest);
    env(g.gain, t0, opts.g, opts.atk, opts.dec);
    return t0 + dur + 0.01;
  };

  // A decaying tone with an optional pitch drop - "weight" in one call.
  Audio.prototype._tone = function (h, opts) {
    var t0 = opts.t;
    var dur = (opts.atk || 0.001) + opts.dec;
    var o = this._osc(h, opts.type || 'sine', t0, dur);
    if (!o) return t0;
    if (opts.f1 && opts.f1 !== opts.f0) sweep(o.frequency, t0, opts.f0, opts.f1, opts.glide || opts.dec);
    else o.frequency.setValueAtTime(Math.max(10, opts.f0), t0);
    var g = this._gain(h, 0);
    var node = o;
    if (opts.drive) {
      var ws = this.actx.createWaveShaper();
      ws.curve = this._driveCurve || driveCurve(opts.drive);
      ws.oversample = '2x';
      this._track(h, ws);
      node.connect(ws);
      node = ws;
    }
    node.connect(g);
    g.connect(opts.dest || h.dest);
    env(g.gain, t0, opts.g, opts.atk || 0.0008, opts.dec);
    return t0 + dur + 0.01;
  };

  // A shower of micro-transients sharing one source and one filter. Doing this
  // with N separate sources would triple the node churn for no audible gain -
  // the amplitude gaps between grains hide the filter jumps completely.
  Audio.prototype._grains = function (h, opts) {
    var t0 = opts.t, n = opts.count | 0;
    if (n <= 0) return t0;
    var span = opts.span || 0.12;
    var s = this._src(h, 'grain', t0, span + 0.06, opts.rate || 1);
    if (!s) return t0;
    var f = this._filter(h, 'bandpass', opts.fLo, opts.q || 2.2);
    var g = this._gain(h, 0);
    s.connect(f); f.connect(g);
    g.connect(opts.dest || h.dest);

    g.gain.setValueAtTime(FLOOR, t0);
    var last = t0;
    for (var i = 0; i < n; i++) {
      // Front-loaded: debris and gravel scatter dense then thin out.
      var u = Math.pow(this.rng.next(), 1.6);
      var gt = t0 + u * span;
      if (gt <= last + 0.0018) gt = last + 0.0018;
      var gd = this.rng.range(0.006, 0.020);
      var amp = opts.g * this.rng.range(0.25, 1.0) * (1 - u * 0.55);
      f.frequency.setValueAtTime(
        M.clamp(this.rng.range(opts.fLo, opts.fHi), 20, this.sampleRate * 0.46), gt);
      g.gain.setValueAtTime(FLOOR, gt);
      g.gain.linearRampToValueAtTime(Math.max(FLOOR * 2, amp), gt + 0.0008);
      g.gain.exponentialRampToValueAtTime(FLOOR, gt + gd);
      last = gt + gd;
    }
    g.gain.setValueAtTime(0, last + 0.005);
    return last + 0.01;
  };

  // Inharmonic ringing partials - metal, glass, bells, shell casings.
  Audio.prototype._partials = function (h, opts) {
    var t0 = opts.t, list = opts.partials, end = t0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i] * (opts.pitch || 1) * this.rng.range(0.985, 1.015);
      if (f > this.sampleRate * 0.45) continue;
      var dec = opts.dec * Math.pow(0.72, i);   // upper partials die first
      var o = this._osc(h, 'sine', t0, dec + 0.01);
      if (!o) continue;
      o.frequency.setValueAtTime(f, t0);
      // A touch of downward drift stops it sounding like a pure test tone.
      o.frequency.exponentialRampToValueAtTime(f * 0.985, t0 + dec);
      var g = this._gain(h, 0);
      o.connect(g); g.connect(opts.dest || h.dest);
      var e = env(g.gain, t0, opts.g * Math.pow(0.68, i), 0.0006, dec);
      if (e > end) end = e;
    }
    return end;
  };

  // --------------------------------------------------------------------------
  // GUNSHOT
  // Four layers, each doing a job the others cannot:
  //   1. crack  - the supersonic snap. Sub-2ms attack, bandpass sweeping down.
  //   2. body   - the muzzle blast. Broadband noise collapsing to low-mid.
  //   3. sub    - a pitch-dropping tone. This is the "weight" / chest punch.
  //   4. bolt   - the mechanical action, offset a few tens of ms behind.
  // plus the tail: convolution reverb + discrete slap-back off the buildings.
  // --------------------------------------------------------------------------
  Audio.prototype._profile = function (weapon) {
    var name = strOf(weapon, ['name', 'id', 'type', 'weapon', 'class'], 'rifle');
    name = String(name).toLowerCase();
    if (weapon && weapon.suppressed) return WEAPON_PROFILES.suppressed;
    if (name.indexOf('suppress') >= 0 || name.indexOf('silenc') >= 0) return WEAPON_PROFILES.suppressed;
    if (name.indexOf('shot') >= 0 || name.indexOf('12g') >= 0 || name.indexOf('870') >= 0) return WEAPON_PROFILES.shotgun;
    if (name.indexOf('snip') >= 0 || name.indexOf('dmr') >= 0 || name.indexOf('marksman') >= 0 ||
        name.indexOf('barrett') >= 0 || name.indexOf('50cal') >= 0) return WEAPON_PROFILES.sniper;
    if (name.indexOf('lmg') >= 0 || name.indexOf('mg') === 0 || name.indexOf('saw') >= 0 ||
        name.indexOf('pkm') >= 0) return WEAPON_PROFILES.lmg;
    if (name.indexOf('pistol') >= 0 || name.indexOf('handgun') >= 0 || name.indexOf('glock') >= 0 ||
        name.indexOf('m9') >= 0 || name.indexOf('deagle') >= 0 || name.indexOf('revolver') >= 0) return WEAPON_PROFILES.pistol;
    if (name.indexOf('smg') >= 0 || name.indexOf('mp5') >= 0 || name.indexOf('mp7') >= 0 ||
        name.indexOf('uzi') >= 0 || name.indexOf('vector') >= 0) return WEAPON_PROFILES.smg;
    return WEAPON_PROFILES.rifle;
  };

  Audio.prototype.playGunshot = function (weapon, position, opts) {
    if (!this.armed) return;
    try {
      var now = this.actx.currentTime;
      // Some builds both emit 'weapon:fire' AND call playGunshot directly.
      // Collapse anything inside one frame into a single report.
      if (now - this._lastShot < 0.022) return;
      this._lastShot = now;
      this._gunshot(weapon, position, opts || EMPTY);
    } catch (e) {
      GAME.logError('audio.gunshot', e);
    }
  };

  Audio.prototype._gunshot = function (weapon, position, opts) {
    var P = this._profile(weapon);
    var rng = this.rng;
    var n = this._shotIndex++;

    // Per-shot variation. Without this a 900rpm burst turns into a buzzsaw:
    // real full-auto fire is audibly different shot to shot because the barrel
    // heats, the gas port pressure varies and the room answers differently.
    var pitch = (opts.pitch || 1) * rng.range(0.955, 1.048);
    var lvl = P.level * (opts.volume === undefined ? 1 : opts.volume) * rng.range(0.90, 1.06);
    // A slow cyclic wobble on top of the per-shot jitter so a long burst has
    // an arc rather than white-noise randomness.
    lvl *= 1 + Math.sin(n * 1.37) * 0.035;

    var pos = vecOf(position) || (opts.position ? vecOf(opts.position) : null);
    var dist = pos ? this._distance(pos) : 0;
    var firstPerson = !pos || dist < 2.2;

    // Sound travels. A shot 90m down the street arrives a quarter second late,
    // and the ear reads that delay as distance more reliably than volume does.
    var delay = (opts.delay || 0) + (firstPerson ? 0 : dist / SPEED_OF_SOUND);

    var h = this._open('weapon', {
      position: firstPerson ? null : pos,
      volume: lvl,
      delay: delay,
      refDistance: 9,
      rolloff: 0.85,
      send: firstPerson ? 0.26 * P.tail : 0.34 * P.tail,
      slap: firstPerson ? 0.55 * P.tail : 0.34 * P.tail,
      occlude: !firstPerson
    });
    if (!h) return;

    var t = h.t0, end = t;

    // ---- 1. transient crack ------------------------------------------------
    // Sub-millisecond attack. The bandpass sweeping down through the first
    // 40ms is what turns a noise blip into a rifle "CRACK".
    var cf0 = P.crackF0 * pitch * rng.range(0.93, 1.08);
    var cf1 = P.crackF1 * pitch * rng.range(0.90, 1.12);
    var cDec = P.crackDec * rng.range(0.88, 1.15);
    end = Math.max(end, this._burst(h, {
      t: t, type: 'bandpass', f0: cf0, f1: cf1, q: P.crackQ * rng.range(0.85, 1.2),
      hp: 620, g: P.crackG * 0.9, atk: 0.0006, dec: cDec, sweepDur: cDec * 0.8,
      rate: rng.range(0.95, 1.08)
    }));
    // A second, brighter tick riding on top gives the crack its "edge".
    end = Math.max(end, this._burst(h, {
      t: t + 0.0004, type: 'highpass', f0: 5200 * pitch, q: 0.7,
      g: P.crackG * 0.42, atk: 0.0004, dec: 0.010
    }));

    // ---- 2. muzzle blast body ----------------------------------------------
    var bDec = P.bodyDec * rng.range(0.9, 1.14);
    end = Math.max(end, this._burst(h, {
      t: t + 0.0012, type: 'lowpass',
      f0: P.bodyF0 * pitch * rng.range(0.92, 1.10),
      f1: P.bodyF1 * pitch, q: P.bodyQ,
      g: P.bodyG, atk: 0.0018, dec: bDec, sweepDur: bDec * 0.85,
      rate: rng.range(0.9, 1.1)
    }));
    // A resonant peak around 400Hz is the "boxy" component of a real report.
    end = Math.max(end, this._burst(h, {
      t: t + 0.001, type: 'bandpass', f0: 430 * pitch, q: 1.9,
      g: P.bodyG * 0.55, atk: 0.002, dec: bDec * 1.25
    }));

    // ---- 3. sub thump ------------------------------------------------------
    end = Math.max(end, this._tone(h, {
      t: t + 0.0015, type: P.subType,
      f0: P.subF0 * rng.range(0.94, 1.07), f1: P.subF1,
      glide: P.subDec * 0.7, g: P.subG, atk: 0.0022,
      dec: P.subDec * rng.range(0.9, 1.12), drive: P.drive
    }));

    // ---- 4. mechanical bolt cycle ------------------------------------------
    // Offset behind the report; two metallic clicks (unlock + carrier return).
    var bt = t + P.boltAt * rng.range(0.85, 1.2);
    end = Math.max(end, this._burst(h, {
      t: bt, type: 'bandpass', f0: P.boltF * rng.range(0.9, 1.12), q: 5.5,
      g: P.boltG * 0.7, atk: 0.0006, dec: 0.014
    }));
    end = Math.max(end, this._burst(h, {
      t: bt + rng.range(0.016, 0.030), type: 'bandpass',
      f0: P.boltF * 1.75 * rng.range(0.9, 1.1), q: 7,
      g: P.boltG * 0.45, atk: 0.0005, dec: 0.010
    }));
    if (firstPerson) {
      // Spring twang from the buffer tube - only audible with the gun at your
      // shoulder, which is exactly why it sells the first-person perspective.
      end = Math.max(end, this._partials(h, {
        t: bt + 0.004, partials: [1180, 2670, 4210], dec: 0.075,
        g: P.boltG * 0.20, pitch: rng.range(0.94, 1.07)
      }));
    }

    h.end = end;
    this._close(h, 0.05);

    // ---- mix reaction ------------------------------------------------------
    this._duck = Math.min(1, Math.max(this._duck, firstPerson ? 0.62 : 0.34));
    if (firstPerson) {
      // Sustained unprotected fire accumulates a faint temporary threshold
      // shift. Capped low so it colours the mix without ever muffling it.
      this._ringLevel = Math.min(0.20, this._ringLevel + 0.016 * P.level);
    }
  };

  // A gunshot heard from far away: the crack and the mechanical layer have been
  // absorbed by the air entirely, and only the low-mid boom survives.
  Audio.prototype._distantShot = function (pos, scale, volume) {
    var h = this._open('ambient', {
      position: pos, volume: volume === undefined ? 1 : volume,
      refDistance: 26, rolloff: 0.55, send: 0.55, slap: 0.42, occlude: false
    });
    if (!h) return;
    var t = h.t0, rng = this.rng, end = t;
    end = Math.max(end, this._burst(h, {
      t: t, type: 'lowpass', f0: 900 * scale, f1: 190 * scale, q: 0.8,
      g: 0.9, atk: 0.0025, dec: 0.16 * rng.range(0.85, 1.2)
    }));
    end = Math.max(end, this._burst(h, {
      t: t, type: 'bandpass', f0: 1500 * scale, q: 1.1,
      g: 0.30, atk: 0.001, dec: 0.045
    }));
    end = Math.max(end, this._tone(h, {
      t: t, type: 'sine', f0: 128 * scale, f1: 44, glide: 0.14,
      g: 0.55, atk: 0.003, dec: 0.22
    }));
    h.end = end;
    this._close(h, 0.1);
  };

  // --------------------------------------------------------------------------
  // Supersonic crack for a near miss.
  // The bullet outruns its own report, so the N-wave reaches you FIRST and the
  // muzzle blast follows dist/343 seconds later. Getting this order right is
  // one of the most convincing details in a shooter.
  // --------------------------------------------------------------------------
  Audio.prototype.nearMiss = function (point, shooterPosition, weapon) {
    if (!this.armed) return;
    try {
      var p = vecOf(point);
      var h = this._open('world', {
        position: p, volume: 1.0, refDistance: 3.2, rolloff: 1.4,
        send: 0.18, slap: 0.30, occlude: false
      });
      if (h) {
        var t = h.t0, rng = this.rng, end = t;
        // The N-wave itself: brutally short, brutally bright.
        end = Math.max(end, this._burst(h, {
          t: t, type: 'highpass', f0: rng.range(1100, 1700), q: 0.7,
          g: 1.15, atk: 0.00035, dec: 0.0075
        }));
        end = Math.max(end, this._burst(h, {
          t: t + 0.0006, type: 'bandpass', f0: rng.range(2600, 4200), q: 1.4,
          g: 0.75, atk: 0.0004, dec: 0.018
        }));
        // The little "whip" of displaced air closing behind it.
        end = Math.max(end, this._burst(h, {
          t: t + 0.004, type: 'bandpass', f0: 1800, f1: 420, q: 1.1,
          g: 0.28, atk: 0.002, dec: 0.075, sweepDur: 0.06
        }));
        h.end = end;
        this._close(h, 0.05);
      }
      // ...and only then the report, delayed by the real travel time.
      var sp = vecOf(shooterPosition);
      if (sp) {
        var d = this._distance(sp);
        this._lastShot = -1;             // this is a different shooter
        this.playGunshot(weapon || 'rifle', sp, { delay: d / SPEED_OF_SOUND });
      }
    } catch (e) {
      GAME.logError('audio.nearMiss', e);
    }
  };

  // --------------------------------------------------------------------------
  // Reload - a timed mechanical sequence, not one sample.
  // Fractions of `duration` so it stays in sync with whatever reload animation
  // weapons.js is actually playing.
  // --------------------------------------------------------------------------
  Audio.prototype.playReload = function (weapon, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var dur = opts.duration || (weapon && weapon.reloadTime) || 2.2;
      var empty = !!opts.empty;
      var rng = this.rng;
      var pos = vecOf(opts.position) || null;
      var vol = (opts.volume === undefined ? 1 : opts.volume);

      var h = this._open('weapon', {
        position: pos, volume: vol * 0.62, refDistance: 5,
        send: 0.14, slap: 0.10, occlude: !!pos
      });
      if (!h) return;
      var t = h.t0, end = t;

      function at(frac) { return t + dur * frac + rng.range(-0.012, 0.012); }

      // 1. magazine release button - a small, dry, high click.
      end = Math.max(end, this._burst(h, {
        t: at(0.02), type: 'bandpass', f0: 3400 * rng.range(0.94, 1.07), q: 6.5,
        g: 0.55, atk: 0.0005, dec: 0.012
      }));
      end = Math.max(end, this._burst(h, {
        t: at(0.02) + 0.008, type: 'bandpass', f0: 1500, q: 3.5,
        g: 0.22, atk: 0.0006, dec: 0.02
      }));

      // 2. mag sliding out of the well - polymer-on-aluminium rustle + rattle.
      var t2 = at(0.11);
      end = Math.max(end, this._burst(h, {
        t: t2, type: 'bandpass', f0: 2200, f1: 900, q: 1.1,
        g: 0.30, atk: 0.008, dec: 0.075, sweepDur: 0.07
      }));
      end = Math.max(end, this._grains(h, {
        t: t2 + 0.01, count: 4, span: 0.07, fLo: 1800, fHi: 5200, g: 0.16, q: 3
      }));

      // 3. spent mag hits the ground (only when discarding a live one).
      var t3 = at(0.30);
      end = Math.max(end, this._burst(h, {
        t: t3, type: 'bandpass', f0: 620 * rng.range(0.9, 1.1), q: 2.4,
        g: 0.34, atk: 0.0008, dec: 0.06
      }));
      end = Math.max(end, this._partials(h, {
        t: t3, partials: [340, 780, 1620], dec: 0.11, g: 0.16
      }));
      end = Math.max(end, this._burst(h, {
        t: t3 + rng.range(0.055, 0.09), type: 'bandpass', f0: 900, q: 3,
        g: 0.13, atk: 0.0008, dec: 0.035
      }));

      // 4. fresh mag in: heavy seat, low body plus a hard click.
      var t4 = at(0.50);
      end = Math.max(end, this._burst(h, {
        t: t4, type: 'lowpass', f0: 1700, f1: 480, q: 1.0,
        g: 0.55, atk: 0.0012, dec: 0.055
      }));
      end = Math.max(end, this._tone(h, {
        t: t4, type: 'sine', f0: 190, f1: 92, glide: 0.045, g: 0.30,
        atk: 0.0015, dec: 0.07
      }));
      end = Math.max(end, this._burst(h, {
        t: t4 + 0.004, type: 'bandpass', f0: 2700, q: 5.5,
        g: 0.40, atk: 0.0005, dec: 0.016
      }));

      // 5. palm slap to confirm the mag is seated.
      var t5 = at(0.64);
      end = Math.max(end, this._burst(h, {
        t: t5, type: 'lowpass', f0: 2200, f1: 700, q: 0.8,
        g: 0.30, atk: 0.0015, dec: 0.040
      }));

      // 6. bolt release / charging handle - spring, then the carrier slamming.
      if (empty || opts.bolt !== false) {
        var t6 = at(empty ? 0.80 : 0.86);
        end = Math.max(end, this._burst(h, {
          t: t6, type: 'bandpass', f0: 3800, q: 7, g: 0.42, atk: 0.0004, dec: 0.010
        }));
        // Carrier slam: a sharp metallic clack with real low-mid behind it.
        end = Math.max(end, this._burst(h, {
          t: t6 + 0.012, type: 'lowpass', f0: 3000, f1: 620, q: 1.2,
          g: 0.70, atk: 0.0008, dec: 0.055
        }));
        end = Math.max(end, this._partials(h, {
          t: t6 + 0.012, partials: [1420, 2980, 5100, 7300], dec: 0.10, g: 0.30,
          pitch: rng.range(0.95, 1.06)
        }));
        end = Math.max(end, this._tone(h, {
          t: t6 + 0.012, type: 'triangle', f0: 165, f1: 78, glide: 0.05,
          g: 0.26, atk: 0.001, dec: 0.075
        }));
      }

      h.end = end;
      this._close(h, 0.05);
    } catch (e) {
      GAME.logError('audio.reload', e);
    }
  };

  Audio.prototype.playDryFire = function (opts) {
    var h = this._open('weapon', { volume: 0.8, send: 0.05, slap: 0.04 });
    if (!h) return;
    var t = h.t0;
    var e1 = this._burst(h, { t: t, type: 'bandpass', f0: 2600, q: 8, g: 0.55, atk: 0.0004, dec: 0.011 });
    var e2 = this._burst(h, { t: t + 0.006, type: 'bandpass', f0: 5400, q: 6, g: 0.22, atk: 0.0004, dec: 0.008 });
    var e3 = this._partials(h, { t: t, partials: [1900, 4400], dec: 0.05, g: 0.10 });
    h.end = Math.max(e1, e2, e3);
    this._close(h);
  };

  Audio.prototype.playWeaponSwitch = function (opts) {
    var h = this._open('weapon', { volume: 0.7, send: 0.08, slap: 0.05 });
    if (!h) return;
    var t = h.t0, rng = this.rng;
    // sling/fabric drag, then the new weapon settling into the hands
    var e1 = this._burst(h, { t: t, type: 'bandpass', f0: 2600, f1: 1200, q: 0.9, g: 0.26, atk: 0.010, dec: 0.13, sweepDur: 0.12 });
    var e2 = this._burst(h, { t: t + 0.16, type: 'lowpass', f0: 2400, f1: 700, q: 1.0, g: 0.40, atk: 0.001, dec: 0.05 });
    var e3 = this._partials(h, { t: t + 0.16, partials: [1250, 2760, 4900], dec: 0.08, g: 0.18, pitch: rng.range(0.94, 1.08) });
    h.end = Math.max(e1, e2, e3);
    this._close(h);
  };

  Audio.prototype.playADS = function (into) {
    var h = this._open('weapon', { volume: 0.5, send: 0.04 });
    if (!h) return;
    var t = h.t0;
    // Cloth-on-cloth plus a soft optic mount tick. Quiet, but its absence is
    // one of the things that makes an FPS feel unfinished.
    var e1 = this._burst(h, {
      t: t, type: 'bandpass', f0: into ? 2400 : 1900, f1: into ? 1100 : 2600,
      q: 0.8, g: 0.22, atk: 0.006, dec: 0.085, sweepDur: 0.08
    });
    var e2 = this._burst(h, {
      t: t + 0.03, type: 'bandpass', f0: 4200, q: 6, g: 0.09, atk: 0.0005, dec: 0.012
    });
    h.end = Math.max(e1, e2);
    this._close(h);
  };

  Audio.prototype._distance = function (p) {
    var dx = p.x - this._listener.x, dy = p.y - this._listener.y, dz = p.z - this._listener.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };

  Audio.prototype._surface = function (name) {
    if (!name) return SURFACES.concrete;
    var k = String(name).toLowerCase();
    if (SURFACES[k]) return SURFACES[k];
    if (SURFACE_ALIAS[k] && SURFACES[SURFACE_ALIAS[k]]) return SURFACES[SURFACE_ALIAS[k]];
    return SURFACES.concrete;
  };

  Audio.prototype._impactMat = function (name) {
    if (!name) return IMPACTS.concrete;
    var k = String(name).toLowerCase();
    if (IMPACTS[k]) return IMPACTS[k];
    if (IMPACT_ALIAS[k] && IMPACTS[IMPACT_ALIAS[k]]) return IMPACTS[IMPACT_ALIAS[k]];
    return IMPACTS.concrete;
  };

  // --------------------------------------------------------------------------
  // FOOTSTEPS
  // Sub thump (the mass of a person) + body (the surface) + click/grains (the
  // boot) + gear rustle (webbing, sling, mag pouches). Every parameter is
  // jittered per step; identical footsteps are instantly noticeable.
  // --------------------------------------------------------------------------
  Audio.prototype.playFootstep = function (surface, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var now = this.actx.currentTime;
      if (now - this._lastStep < 0.075) return;      // de-dupe double emits
      this._lastStep = now;

      var S = this._surface(surface);
      var rng = this.rng;
      var pos = vecOf(opts.position) || null;
      var effort = opts.effort === undefined ? 1 : M.clamp(opts.effort, 0.25, 1.8);
      var pitch = (opts.pitch || 1) * rng.range(0.90, 1.12);
      var vol = (opts.volume === undefined ? 1 : opts.volume) * S.level *
                effort * rng.range(0.82, 1.10);

      var h = this._open('world', {
        position: pos, volume: vol * (pos ? 1.0 : 0.36),
        refDistance: 4, rolloff: 1.5,
        send: 0.14, slap: 0.05, occlude: !!pos
      });
      if (!h) return;
      var t = h.t0, end = t;

      // Weight landing on the ground.
      end = Math.max(end, this._tone(h, {
        t: t, type: 'sine', f0: S.subF * pitch * rng.range(0.9, 1.1),
        f1: S.subF * pitch * 0.55, glide: S.subDec * 0.8,
        g: S.subG * effort, atk: 0.0025, dec: S.subDec * rng.range(0.85, 1.2)
      }));

      // The surface answering.
      end = Math.max(end, this._burst(h, {
        t: t + 0.0008, type: 'bandpass',
        f0: S.bodyF * pitch * rng.range(0.88, 1.14), q: S.bodyQ,
        g: S.bodyG, atk: 0.0025, dec: S.bodyDec * rng.range(0.85, 1.25),
        rate: rng.range(0.9, 1.15)
      }));

      // Boot sole / heel click.
      if (S.clickG > 0.02) {
        end = Math.max(end, this._burst(h, {
          t: t + rng.range(0.0004, 0.004), type: 'bandpass',
          f0: S.clickF * pitch * rng.range(0.85, 1.2), q: S.clickQ,
          g: S.clickG * effort, atk: 0.0006, dec: S.clickDec * rng.range(0.8, 1.4)
        }));
      }

      // Loose material scattering under the boot.
      if (S.grains) {
        end = Math.max(end, this._grains(h, {
          t: t + 0.002, count: S.grains + rng.int(-1, 2), span: rng.range(0.06, 0.11),
          fLo: S.grainLo, fHi: S.grainHi, g: S.grainG * effort, q: 2.6,
          rate: rng.range(0.9, 1.15)
        }));
      }

      // Structural ringing - metal grating, hollow wood, tile.
      if (S.partials) {
        end = Math.max(end, this._partials(h, {
          t: t + 0.001, partials: S.partials, dec: S.partialDec,
          g: S.partialG * effort, pitch: pitch * rng.range(0.96, 1.05)
        }));
      }

      // Gear rustle: webbing, sling swivels, the mag in the pouch. Slightly
      // behind the step because the kit keeps moving after the boot lands.
      end = Math.max(end, this._burst(h, {
        t: t + rng.range(0.012, 0.034), type: 'bandpass',
        f0: rng.range(2600, 4400), f1: rng.range(1400, 2100), q: 0.85,
        hp: 900, g: S.rustle * effort * rng.range(0.7, 1.3),
        atk: 0.012, dec: rng.range(0.07, 0.13), sweepDur: 0.08
      }));
      // Every few steps a sling swivel or a buckle actually taps the rifle.
      if (rng.bool(0.22)) {
        end = Math.max(end, this._partials(h, {
          t: t + rng.range(0.02, 0.06), partials: [2400, 5100], dec: 0.05,
          g: 0.07 * effort, pitch: rng.range(0.85, 1.2)
        }));
      }

      h.end = end;
      this._close(h);
    } catch (e) {
      GAME.logError('audio.footstep', e);
    }
  };

  Audio.prototype.playLand = function (surface, opts) {
    opts = opts || EMPTY;
    this._lastStep = -1;
    this.playFootstep(surface, {
      position: opts.position, effort: 1.7,
      volume: (opts.volume === undefined ? 1 : opts.volume) * 1.25,
      pitch: 0.86
    });
    // Add the grunt of absorbing the landing.
    var h = this._open('world', {
      position: vecOf(opts.position) || null, volume: 0.45, delay: 0.02,
      send: 0.10, refDistance: 4
    });
    if (!h) return;
    h.end = this._burst(h, {
      t: h.t0, type: 'bandpass', f0: 640, f1: 300, q: 1.4,
      g: 0.5, atk: 0.006, dec: 0.14, sweepDur: 0.12
    });
    this._close(h);
  };

  Audio.prototype.playJump = function (opts) {
    opts = opts || EMPTY;
    var h = this._open('world', {
      position: vecOf(opts.position) || null, volume: 0.5, send: 0.08, refDistance: 4
    });
    if (!h) return;
    var t = h.t0;
    var e1 = this._burst(h, { t: t, type: 'bandpass', f0: 1400, f1: 3200, q: 0.9, g: 0.3, atk: 0.005, dec: 0.09, sweepDur: 0.07 });
    var e2 = this._burst(h, { t: t + 0.01, type: 'bandpass', f0: 380, q: 1.2, g: 0.28, atk: 0.004, dec: 0.07 });
    h.end = Math.max(e1, e2);
    this._close(h);
  };

  // --------------------------------------------------------------------------
  // IMPACTS
  // --------------------------------------------------------------------------
  Audio.prototype.playImpact = function (material, position, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var now = this.actx.currentTime;
      if (now - this._lastImpact < 0.012) return;
      this._lastImpact = now;

      var I = this._impactMat(material);
      var rng = this.rng;
      var pos = vecOf(position) || vecOf(opts.position);
      var pitch = (opts.pitch || 1) * rng.range(0.88, 1.16);
      var dist = pos ? this._distance(pos) : 0;

      var h = this._open('world', {
        position: pos, volume: (opts.volume === undefined ? 1 : opts.volume) * I.level * rng.range(0.85, 1.1),
        delay: (opts.delay || 0) + (dist > 12 ? dist / SPEED_OF_SOUND : 0),
        refDistance: 5, rolloff: 1.25,
        send: 0.24, slap: 0.16, occlude: !!pos
      });
      if (!h) return;
      var t = h.t0, end = t;

      // The strike itself.
      end = Math.max(end, this._burst(h, {
        t: t, type: 'bandpass', f0: I.crackF * pitch * rng.range(0.9, 1.12),
        q: I.crackQ, g: I.crackG, atk: 0.0005, dec: I.crackDec * rng.range(0.8, 1.3)
      }));
      // The material's own voice, collapsing downward.
      end = Math.max(end, this._burst(h, {
        t: t + 0.0008, type: 'lowpass',
        f0: I.bodyF0 * pitch, f1: I.bodyF1 * pitch, q: I.bodyQ,
        g: I.bodyG, atk: 0.0015, dec: I.bodyDec * rng.range(0.85, 1.25),
        rate: rng.range(0.9, 1.12)
      }));
      // Energy transferred into the structure.
      end = Math.max(end, this._tone(h, {
        t: t + 0.001, type: 'sine', f0: I.subF0 * pitch, f1: I.subF1 * pitch,
        glide: I.subDec * 0.8, g: I.subG, atk: 0.0015, dec: I.subDec
      }));
      if (I.partials) {
        end = Math.max(end, this._partials(h, {
          t: t + 0.0008, partials: I.partials, dec: I.partialDec,
          g: I.partialG, pitch: pitch * rng.range(0.94, 1.08)
        }));
      }
      // Spall, dust, shards, splinters falling away.
      if (I.grains) {
        end = Math.max(end, this._grains(h, {
          t: t + 0.004, count: I.grains + rng.int(-2, 3), span: I.span,
          fLo: I.grainLo, fHi: I.grainHi, g: I.grainG, q: 2.4
        }));
      }

      h.end = end;
      this._close(h);
    } catch (e) {
      GAME.logError('audio.impact', e);
    }
  };

  // Ricochet: a resonant band sweeping up then down, which is the Doppler-ish
  // signature of a deformed bullet tumbling away from you.
  Audio.prototype.playRicochet = function (position, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var rng = this.rng;
      var h = this._open('world', {
        position: vecOf(position) || vecOf(opts.position),
        volume: (opts.volume === undefined ? 1 : opts.volume) * rng.range(0.6, 1.0),
        refDistance: 6, rolloff: 1.0, send: 0.42, slap: 0.30, occlude: false
      });
      if (!h) return;

      var t = h.t0;
      var dur = rng.range(0.34, 0.78);
      var fStart = rng.range(1200, 1900);
      var fPeak = rng.range(2900, 5400);
      var fEnd = rng.range(560, 980);
      var rise = dur * rng.range(0.15, 0.30);

      // Noise through a very narrow resonant band = the "whine".
      var s = this._src(h, 'white', t, dur + 0.04, rng.range(0.9, 1.1));
      if (s) {
        var bp = this._filter(h, 'bandpass', fStart, 26);
        var bp2 = this._filter(h, 'bandpass', fStart * 2.02, 20);
        var g = this._gain(h, 0);
        s.connect(bp); bp.connect(g);
        s.connect(bp2); bp2.connect(g);
        g.connect(h.dest);
        bp.frequency.setValueAtTime(fStart, t);
        bp.frequency.exponentialRampToValueAtTime(fPeak, t + rise);
        bp.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
        bp2.frequency.setValueAtTime(fStart * 2.02, t);
        bp2.frequency.exponentialRampToValueAtTime(fPeak * 1.94, t + rise);
        bp2.frequency.exponentialRampToValueAtTime(fEnd * 2.1, t + dur);
        envAHD(g.gain, t, 1.5, 0.0025, rise * 0.5, dur - rise * 0.5);
      }
      // A sine tracking the same contour gives the whine a definite pitch.
      var o = this._osc(h, 'sine', t, dur + 0.02);
      if (o) {
        var og = this._gain(h, 0);
        o.connect(og); og.connect(h.dest);
        o.frequency.setValueAtTime(fStart, t);
        o.frequency.exponentialRampToValueAtTime(fPeak, t + rise);
        o.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
        envAHD(og.gain, t, 0.16, 0.006, rise * 0.4, dur - rise * 0.4);
      }
      // The strike that launched it.
      var e2 = this._burst(h, {
        t: t, type: 'bandpass', f0: rng.range(3200, 5200), q: 3.5,
        g: 0.55, atk: 0.0005, dec: 0.016
      });
      h.end = Math.max(t + dur + 0.05, e2);
      this._close(h, 0.05);
    } catch (e) {
      GAME.logError('audio.ricochet', e);
    }
  };

  // --------------------------------------------------------------------------
  // Shell casings - a few bright, inharmonic metallic pings with bounce timing.
  // --------------------------------------------------------------------------
  Audio.prototype.playShell = function (position, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var rng = this.rng;
      var h = this._open('world', {
        position: vecOf(position) || vecOf(opts.position),
        volume: (opts.volume === undefined ? 1 : opts.volume) * rng.range(0.5, 0.85),
        refDistance: 2.6, rolloff: 1.9, send: 0.20, slap: 0.10, occlude: false
      });
      if (!h) return;

      var soft = /sand|dirt|carpet|fabric|water|foliage/.test(String(opts.surface || ''));
      var pitch = rng.range(0.82, 1.30);
      var bounces = soft ? 1 : (2 + rng.int(0, 2));
      var t = h.t0, end = t, gap = rng.range(0.055, 0.11);

      for (var i = 0; i < bounces; i++) {
        var amp = Math.pow(soft ? 0.4 : 0.56, i) * (soft ? 0.35 : 1);
        // brass tinkle: strongly inharmonic, which is what makes it read
        // as a small hollow tube rather than a bell.
        end = Math.max(end, this._partials(h, {
          t: t, partials: [3950, 6180, 8420, 11200], dec: soft ? 0.03 : 0.085,
          g: 0.42 * amp, pitch: pitch * rng.range(0.94, 1.08)
        }));
        end = Math.max(end, this._burst(h, {
          t: t, type: 'bandpass', f0: 5400 * pitch * rng.range(0.9, 1.15), q: 7,
          g: 0.34 * amp, atk: 0.0004, dec: 0.014
        }));
        if (!soft) {
          end = Math.max(end, this._burst(h, {
            t: t, type: 'lowpass', f0: 1500, f1: 600, q: 1.0,
            g: 0.10 * amp, atk: 0.0006, dec: 0.02
          }));
        }
        t += gap;
        gap *= rng.range(0.55, 0.78);      // bounces get closer together
      }
      // Final roll/settle on hard ground.
      if (!soft && rng.bool(0.6)) {
        end = Math.max(end, this._grains(h, {
          t: t, count: 5, span: rng.range(0.10, 0.22),
          fLo: 4200, fHi: 9500, g: 0.09, q: 5
        }));
      }
      h.end = end;
      this._close(h);
    } catch (e) {
      GAME.logError('audio.shell', e);
    }
  };

  // --------------------------------------------------------------------------
  // EXPLOSION
  // --------------------------------------------------------------------------
  Audio.prototype.playExplosion = function (position, radius, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var rng = this.rng;
      var r = radius || 4.5;
      var scale = M.clamp(r / 4.5, 0.5, 2.6);
      var pos = vecOf(position) || vecOf(opts.position);
      var dist = pos ? this._distance(pos) : 0;

      var h = this._open('weapon', {
        position: pos,
        volume: (opts.volume === undefined ? 1 : opts.volume) * 1.15,
        delay: (opts.delay || 0) + dist / SPEED_OF_SOUND,
        refDistance: 22, rolloff: 0.6,
        send: 0.75, slap: 0.65, occlude: false
      });
      if (!h) return;
      var t = h.t0, end = t;

      // Detonation transient - the flash of the charge going off.
      end = Math.max(end, this._burst(h, {
        t: t, type: 'highpass', f0: 2600, q: 0.7, g: 0.85, atk: 0.0006, dec: 0.035
      }));
      // Blast body: broadband collapsing into the low end over ~0.9s.
      end = Math.max(end, this._burst(h, {
        t: t, buffer: 'brown', type: 'lowpass',
        f0: 1400 / scale, f1: 62, q: 0.9,
        g: 1.25, atk: 0.004, dec: 0.85 * scale, sweepDur: 0.7 * scale,
        rate: rng.range(0.85, 1.05)
      }));
      end = Math.max(end, this._burst(h, {
        t: t + 0.002, type: 'bandpass', f0: 620, f1: 180, q: 0.8,
        g: 0.75, atk: 0.003, dec: 0.42 * scale, sweepDur: 0.35
      }));
      // The sub. This is the part you feel rather than hear.
      end = Math.max(end, this._tone(h, {
        t: t + 0.002, type: 'sine', f0: 78 * (1 / scale) * rng.range(0.9, 1.1),
        f1: 21, glide: 0.55 * scale, g: 1.5, atk: 0.006, dec: 1.05 * scale,
        drive: 0.8
      }));
      end = Math.max(end, this._tone(h, {
        t: t + 0.004, type: 'triangle', f0: 145, f1: 42, glide: 0.30,
        g: 0.55, atk: 0.004, dec: 0.55 * scale, drive: 0.6
      }));

      // Debris patter: masonry raining back down over the next couple seconds.
      end = Math.max(end, this._grains(h, {
        t: t + 0.28, count: 22, span: 1.6 * scale, fLo: 900, fHi: 4200,
        g: 0.22, q: 2.0
      }));
      end = Math.max(end, this._grains(h, {
        t: t + 0.55, count: 16, span: 2.1 * scale, fLo: 2200, fHi: 8000,
        g: 0.12, q: 3.0
      }));
      // A sheet of glass letting go somewhere nearby.
      if (rng.bool(0.6)) {
        end = Math.max(end, this._grains(h, {
          t: t + rng.range(0.18, 0.5), count: 14, span: 0.9,
          fLo: 4200, fHi: 12000, g: 0.14, q: 4
        }));
      }

      h.end = end;
      this._close(h, 0.2);

      // Mix reaction: hard duck, and if it went off in your face, ear ringing.
      this._duck = 1.0;
      var prox = M.saturate(1 - dist / (r * 3.2));
      if (prox > 0.08) this._earRing(M.clamp(prox * 1.1, 0, 1) * 0.95, t);
    } catch (e) {
      GAME.logError('audio.explosion', e);
    }
  };

  // --------------------------------------------------------------------------
  // ENEMY VOCALISATIONS
  // Deliberately abstract: a glottal buzz plus breath noise pushed through a
  // three-band formant filter, gliding between two vowel targets. That is
  // literally how the vocal tract works, so it reads as a human being shouting
  // without ever forming a word - which is exactly what we want.
  // --------------------------------------------------------------------------
  Audio.prototype.playVoice = function (kind, position, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var V = VOCALS[kind] || VOCALS.shout;
      var rng = this.rng;
      var h = this._open('voice', {
        position: vecOf(position) || vecOf(opts.position),
        volume: (opts.volume === undefined ? 1 : opts.volume) * V.level * rng.range(0.85, 1.1),
        refDistance: 8, rolloff: 1.05, send: 0.30, slap: 0.14, occlude: true
      });
      if (!h) return;

      var t = h.t0;
      var dur = rng.range(V.dur[0], V.dur[1]) * (opts.pitch ? 1 / opts.pitch : 1);
      var f0 = rng.range(V.f0[0], V.f0[1]) * (opts.pitch || 1);
      var f0End = f0 * Math.pow(2, V.slide);
      var vA = VOWELS[V.v[0]] || VOWELS.a;
      var vB = VOWELS[V.v[1]] || VOWELS.o;
      // Individual throats differ; shift the whole formant set per enemy.
      var tract = opts.tract || rng.range(0.90, 1.10);

      // Glottal source: a sawtooth is a decent stand-in for a glottal pulse
      // train because it has the same 1/n harmonic series.
      var glot = this._osc(h, 'sawtooth', t, dur + 0.05);
      var mix = this._gain(h, 1);
      if (glot) {
        glot.frequency.setValueAtTime(f0, t);
        glot.frequency.exponentialRampToValueAtTime(f0 * 1.06, t + dur * 0.18);
        glot.frequency.exponentialRampToValueAtTime(Math.max(40, f0End), t + dur);
        // Vibrato - a held shout is never dead steady.
        var lfo = this._osc(h, 'sine', t, dur + 0.05);
        if (lfo) {
          lfo.frequency.setValueAtTime(rng.range(4.5, 7.0), t);
          var lg = this._gain(h, f0 * 0.022);
          lfo.connect(lg);
          lg.connect(glot.frequency);
        }
        var gg = this._gain(h, 1 - V.noise);
        glot.connect(gg); gg.connect(mix);
      }
      // Breath / turbulence component.
      var br = this._src(h, 'white', t, dur + 0.05, 1);
      if (br) {
        var bhp = this._filter(h, 'highpass', 380, 0.7);
        var bg = this._gain(h, V.noise * 0.55);
        br.connect(bhp); bhp.connect(bg); bg.connect(mix);
      }

      // Three parallel formant resonators gliding from vowel A to vowel B.
      var out = this._gain(h, 0);
      var fq = [10, 7.5, 5.5], amps = [1.0, 0.52, 0.24];
      for (var i = 0; i < 3; i++) {
        var bp = this._filter(h, 'bandpass', vA[i] * tract, fq[i]);
        var ag = this._gain(h, amps[i]);
        bp.frequency.setValueAtTime(vA[i] * tract, t);
        bp.frequency.exponentialRampToValueAtTime(vB[i] * tract, t + dur * 0.75);
        mix.connect(bp); bp.connect(ag); ag.connect(out);
      }
      // A little unfiltered signal keeps it from sounding like a vocoder.
      var thru = this._gain(h, 0.13);
      mix.connect(thru); thru.connect(out);
      out.connect(h.dest);

      envAHD(out.gain, t, 1.0, dur * 0.09, dur * 0.42, dur * 0.55);
      h.end = t + dur * 1.1 + 0.06;
      this._close(h);
    } catch (e) {
      GAME.logError('audio.voice', e);
    }
  };

  // A body hitting the floor - the audible half of a death.
  Audio.prototype.playBodyfall = function (position, opts) {
    opts = opts || EMPTY;
    var rng = this.rng;
    var h = this._open('world', {
      position: vecOf(position) || vecOf(opts.position),
      volume: (opts.volume === undefined ? 1 : opts.volume) * 0.95,
      refDistance: 6, rolloff: 1.2, send: 0.24, slap: 0.12, occlude: true
    });
    if (!h) return;
    var t = h.t0, end = t;
    for (var i = 0; i < 3; i++) {
      var a = Math.pow(0.55, i);
      end = Math.max(end, this._tone(h, {
        t: t, type: 'sine', f0: rng.range(72, 105), f1: 44, glide: 0.08,
        g: 0.7 * a, atk: 0.003, dec: 0.16
      }));
      end = Math.max(end, this._burst(h, {
        t: t, type: 'lowpass', f0: rng.range(700, 1200), f1: 260, q: 0.8,
        g: 0.55 * a, atk: 0.003, dec: 0.13
      }));
      // gear and webbing slapping the ground
      end = Math.max(end, this._burst(h, {
        t: t + 0.012, type: 'bandpass', f0: rng.range(2400, 4200), q: 0.9,
        g: 0.18 * a, atk: 0.006, dec: 0.10
      }));
      t += rng.range(0.09, 0.17);
    }
    h.end = end;
    this._close(h);
  };

  // --------------------------------------------------------------------------
  // UI - dry, non-positional, no reverb. These must cut through gunfire, so
  // they live on their own bus with zero send.
  // --------------------------------------------------------------------------
  Audio.prototype.playUI = function (kind, opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var h = this._open('ui', { volume: opts.volume === undefined ? 1 : opts.volume });
      if (!h) return;
      var t = h.t0, end = t, p = opts.pitch || 1;

      if (kind === 'headshot') {
        // Bright two-partial ding - unmistakably different from a body hit.
        end = this._partials(h, { t: t, partials: [2650, 3980, 5300], dec: 0.19, g: 0.30, pitch: p });
        end = Math.max(end, this._burst(h, {
          t: t, type: 'bandpass', f0: 4200 * p, q: 6, g: 0.22, atk: 0.0004, dec: 0.012
        }));
      } else if (kind === 'kill') {
        end = this._partials(h, { t: t, partials: [1400, 2100], dec: 0.10, g: 0.26, pitch: p });
        end = Math.max(end, this._partials(h, { t: t + 0.075, partials: [2100, 3150], dec: 0.16, g: 0.24, pitch: p }));
      } else if (kind === 'lowammo') {
        // Dry mechanical tick - a warning, not a chime.
        end = this._partials(h, { t: t, partials: [1700, 2560], dec: 0.032, g: 0.15, pitch: p });
        end = Math.max(end, this._burst(h, { t: t, type: 'bandpass', f0: 1700 * p, q: 9, g: NB * 0.34, atk: 0.0004, dec: 0.020 }));
        end = Math.max(end, this._partials(h, { t: t + 0.055, partials: [1450, 2180], dec: 0.028, g: 0.11, pitch: p }));
        end = Math.max(end, this._burst(h, { t: t + 0.055, type: 'bandpass', f0: 1450 * p, q: 9, g: NB * 0.24, atk: 0.0004, dec: 0.018 }));
      } else if (kind === 'ui_click' || kind === 'click') {
        end = this._partials(h, { t: t, partials: [2400, 3620], dec: 0.020, g: 0.10, pitch: p });
        end = Math.max(end, this._burst(h, { t: t, type: 'bandpass', f0: 2400 * p, q: 5, g: NB * 0.24, atk: 0.0005, dec: 0.014 }));
      } else if (kind === 'damage') {
        // Taking a hit: a dull thud plus a short low-mid smear.
        end = this._tone(h, { t: t, type: 'sine', f0: 165 * p, f1: 70, glide: 0.09, g: 0.55, atk: 0.002, dec: 0.16 });
        end = Math.max(end, this._burst(h, { t: t, type: 'lowpass', f0: 900, f1: 260, q: 0.9, g: 0.45, atk: 0.002, dec: 0.13 }));
      } else if (kind === 'lowhealth') {
        end = this._tone(h, { t: t, type: 'sine', f0: 120, f1: 96, glide: 0.5, g: 0.24, atk: 0.05, dec: 0.75 });
      } else {
        // 'hit' (default hitmarker). The most important feedback sound in the
        // game: it has to be legible underneath a full-auto burst, so the core
        // is tonal (predictable level) with the noise only adding texture.
        end = this._partials(h, { t: t, partials: [1500, 2250], dec: 0.030, g: 0.17, pitch: p });
        end = Math.max(end, this._burst(h, { t: t, type: 'bandpass', f0: 1450 * p, q: 8, g: NB * 0.30, atk: 0.0004, dec: 0.020 }));
        end = Math.max(end, this._partials(h, { t: t + 0.022, partials: [2180, 3270], dec: 0.034, g: 0.12, pitch: p }));
        end = Math.max(end, this._burst(h, { t: t + 0.022, type: 'bandpass', f0: 2180 * p, q: 8, g: NB * 0.24, atk: 0.0004, dec: 0.026 }));
      }
      h.end = end;
      this._close(h);
    } catch (e) {
      GAME.logError('audio.ui', e);
    }
  };

  // --------------------------------------------------------------------------
  // Dynamic mix: ear ringing.
  // A close blast overloads the cochlea - everything goes muffled and a tone
  // sits on top of it while hearing recovers. Cheap to fake, enormously
  // effective, and it gives an explosion a consequence.
  // --------------------------------------------------------------------------
  Audio.prototype._earRing = function (strength, when) {
    strength = M.saturate(strength);
    if (strength <= 0.02) return;
    this._ringLevel = Math.max(this._ringLevel, strength);
    var a = this.actx, t = when || a.currentTime;
    if (t < a.currentTime) t = a.currentTime;

    // Don't stack tone generators if several blasts land together.
    if (t < this._ringOscUntil) return;
    var dur = 2.5 + 5.5 * strength;
    this._ringOscUntil = t + dur * 0.55;

    var rec = this._pending.acquire();
    rec.t = t + dur + 0.3;
    var mix = a.createGain();
    mix.gain.value = 0;
    mix.connect(this.tinnitusOut);
    rec.nodes.push(mix);

    // Two close, slightly detuned tones beat against each other, which is what
    // real tinnitus after a blast actually sounds like.
    var freqs = [4180 * this.rng.range(0.95, 1.05), 6350 * this.rng.range(0.95, 1.05)];
    for (var i = 0; i < freqs.length; i++) {
      var o = a.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freqs[i], t);
      o.frequency.linearRampToValueAtTime(freqs[i] * 0.94, t + dur);
      var g = a.createGain();
      g.gain.value = 0;
      envAHD(g.gain, t, 0.030 * strength * (i ? 0.55 : 1), 0.09, dur * 0.28, dur * 0.66);
      o.connect(g); g.connect(mix);
      try { o.start(t); o.stop(t + dur + 0.05); } catch (e) { /* ignore */ }
      rec.nodes.push(o, g);
    }
    // A hiss layer under the tones.
    var hs = a.createBufferSource();
    if (this.buffers.white) {
      hs.buffer = this.buffers.white;
      hs.loop = true;
      var hf = a.createBiquadFilter();
      hf.type = 'bandpass'; hf.frequency.value = 5200; hf.Q.value = 1.1;
      var hg = a.createGain(); hg.gain.value = 0;
      envAHD(hg.gain, t, 0.020 * strength, 0.10, dur * 0.25, dur * 0.68);
      hs.connect(hf); hf.connect(hg); hg.connect(mix);
      try { hs.start(t); hs.stop(t + dur + 0.05); } catch (e) { /* ignore */ }
      rec.nodes.push(hs, hf, hg);
    }
    mix.gain.setValueAtTime(1, t);
  };

  // --------------------------------------------------------------------------
  // AMBIENCE BED
  // A continuous generative layer. Silence in a game reads as a bug, and a
  // static loop reads as cheap - so this is three modulated noise layers plus
  // sparse randomised one-shots that never repeat on a fixed period.
  // --------------------------------------------------------------------------
  Audio.prototype._loopSource = function (name, out, gainVal) {
    var a = this.actx, buf = this.buffers[name];
    if (!buf) return null;
    var s = a.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.loopStart = 0;
    // _sealLoop crossfaded the tail into the head; loop before the dead zone.
    s.loopEnd = buf._loopEnd || buf.duration;
    var g = a.createGain();
    g.gain.value = gainVal;
    s.connect(g);
    g.connect(out);
    try { s.start(a.currentTime + 0.02, this.rng.range(0, s.loopEnd * 0.8)); }
    catch (e) { return null; }
    this._ambNodes.push(s, g);
    return { src: s, gain: g };
  };

  // A slow LFO driving an AudioParam. Wind that does not breathe is a hiss.
  Audio.prototype._lfo = function (rate, depth, target, phaseType) {
    var a = this.actx;
    var o = a.createOscillator();
    o.type = phaseType || 'sine';
    o.frequency.value = rate;
    var g = a.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(target);
    try { o.start(a.currentTime + this.rng.range(0, 1 / Math.max(0.01, rate))); }
    catch (e) { /* ignore */ }
    this._ambNodes.push(o, g);
    return o;
  };

  Audio.prototype._buildAmbience = function () {
    if (this._ambBuilt || !this.armed || GAME.headless) return;
    if (!this.buffers.pink || !this.buffers.brown) return;
    this._ambBuilt = true;
    var a = this.actx, bus = this.buses.ambient;

    // ---- layer 1: wind through the street, two decorrelated halves ---------
    for (var side = 0; side < 2; side++) {
      var lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 430;
      lp.Q.value = 0.6;
      var pan = a.createStereoPanner ? a.createStereoPanner() : null;
      var g = a.createGain();
      g.gain.value = 0.34;
      lp.connect(g);
      if (pan) { pan.pan.value = side ? 0.65 : -0.65; g.connect(pan); pan.connect(bus); }
      else { g.connect(bus); }
      this._ambNodes.push(lp, g);
      if (pan) this._ambNodes.push(pan);
      this._loopSource('pink', lp, 1.0);
      // Two LFOs at incommensurate rates so the gusting never repeats audibly.
      this._lfo(0.043 + side * 0.017, 210, lp.frequency);
      this._lfo(0.011 + side * 0.006, 120, lp.frequency);
      this._lfo(0.037 + side * 0.021, 0.13, g.gain);
    }

    // ---- layer 2: wind whistling round a corner ---------------------------
    var bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 980;
    bp.Q.value = 3.2;
    var bg = a.createGain();
    bg.gain.value = 0.055;
    bp.connect(bg); bg.connect(bus);
    this._ambNodes.push(bp, bg);
    this._loopSource('pink', bp, 1.0);
    this._lfo(0.029, 320, bp.frequency);
    this._lfo(0.019, 0.045, bg.gain);

    // ---- layer 3: distant city / traffic rumble ---------------------------
    var rl = a.createBiquadFilter();
    rl.type = 'lowpass';
    rl.frequency.value = 190;
    rl.Q.value = 0.7;
    var rhp = a.createBiquadFilter();
    rhp.type = 'highpass';
    rhp.frequency.value = 32;      // keep inaudible DC out of the limiter
    var rg = a.createGain();
    rg.gain.value = 0.42;
    rl.connect(rhp); rhp.connect(rg); rg.connect(bus);
    this._ambNodes.push(rl, rhp, rg);
    this._loopSource('brown', rl, 1.0);
    this._lfo(0.023, 0.12, rg.gain);
    this._lfo(0.008, 55, rl.frequency);

    // ---- layer 4: high-air "presence" so the top octave is not dead --------
    var hp = a.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    var hg = a.createGain();
    hg.gain.value = 0.020;
    hp.connect(hg); hg.connect(bus);
    this._ambNodes.push(hp, hg);
    this._loopSource('pink', hp, 1.0);
    this._lfo(0.017, 0.008, hg.gain);
  };

  Audio.prototype._resetAmbienceSchedule = function () {
    var r = this.rng;
    // {timer, min, max, method}
    this._ambTimers = [
      { t: r.range(2.0, 6.0), lo: 5.5, hi: 15.0, fn: '_ambBirds' },
      { t: r.range(6.0, 14.0), lo: 11.0, hi: 30.0, fn: '_ambDistantGunfire' },
      { t: r.range(14.0, 30.0), lo: 22.0, hi: 55.0, fn: '_ambDog' },
      { t: r.range(9.0, 20.0), lo: 13.0, hi: 34.0, fn: '_ambCreak' },
      { t: r.range(20.0, 45.0), lo: 30.0, hi: 80.0, fn: '_ambVehicle' },
      { t: r.range(8.0, 18.0), lo: 12.0, hi: 28.0, fn: '_ambDebris' }
    ];
  };

  // Place an ambience event somewhere plausible around the listener.
  Audio.prototype._ambPoint = function (minR, maxR, minY, maxY) {
    var r = this.rng;
    var ang = r.range(0, M.TAU), d = r.range(minR, maxR);
    return {
      x: this._listener.x + Math.cos(ang) * d,
      y: this._listener.y + r.range(minY, maxY),
      z: this._listener.z + Math.sin(ang) * d
    };
  };

  Audio.prototype._ambBirds = function () {
    var r = this.rng;
    var p = this._ambPoint(9, 34, 3, 11);
    var n = 2 + r.int(0, 3);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.35, 0.75), refDistance: 14, rolloff: 0.9,
      send: 0.35, occlude: false
    });
    if (!h) return;
    var t = h.t0, end = t;
    for (var i = 0; i < n; i++) {
      var f = r.range(2900, 6200);
      var dur = r.range(0.045, 0.095);
      var o = this._osc(h, r.bool(0.5) ? 'sine' : 'triangle', t, dur + 0.02);
      if (o) {
        // Fast up-down chirp - the shape is what makes it read as a bird.
        o.frequency.setValueAtTime(f * 0.72, t);
        o.frequency.exponentialRampToValueAtTime(f, t + dur * 0.35);
        o.frequency.exponentialRampToValueAtTime(f * 0.82, t + dur);
        var g = this._gain(h, 0);
        o.connect(g); g.connect(h.dest);
        end = Math.max(end, envAHD(g.gain, t, 0.55, 0.006, dur * 0.4, dur * 0.6));
      }
      t += r.range(0.07, 0.19);
    }
    h.end = end;
    this._close(h);
  };

  Audio.prototype._ambDistantGunfire = function () {
    var r = this.rng;
    var p = this._ambPoint(55, 150, -2, 12);
    var shots = 1 + r.int(0, 5);
    var rpm = r.range(520, 780);
    var gap = 60 / rpm;
    var scale = r.range(0.75, 1.25);
    var vol = r.range(0.35, 0.8);
    for (var i = 0; i < shots; i++) {
      // Scheduled on the audio clock via opts.delay, not with setTimeout -
      // JS timers drift and would smear the cadence of the burst.
      this._distantShotDelayed(p, scale, vol, i * gap * r.range(0.94, 1.08));
    }
  };

  Audio.prototype._distantShotDelayed = function (pos, scale, vol, delay) {
    var h = this._open('ambient', {
      position: pos, volume: vol, delay: delay,
      refDistance: 30, rolloff: 0.5, send: 0.6, slap: 0.35, occlude: false
    });
    if (!h) return;
    var t = h.t0, r = this.rng, end = t;
    end = Math.max(end, this._burst(h, {
      t: t, type: 'lowpass', f0: 850 * scale, f1: 165 * scale, q: 0.8,
      g: 0.95, atk: 0.003, dec: 0.19 * r.range(0.85, 1.25)
    }));
    end = Math.max(end, this._tone(h, {
      t: t, type: 'sine', f0: 118 * scale, f1: 42, glide: 0.15,
      g: 0.6, atk: 0.004, dec: 0.26
    }));
    h.end = end;
    this._close(h, 0.1);
  };

  Audio.prototype._ambDog = function () {
    var r = this.rng;
    var p = this._ambPoint(18, 60, -1, 2);
    var barks = 2 + r.int(0, 3);
    var base = r.range(210, 330);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.4, 0.8), refDistance: 16, rolloff: 0.9,
      send: 0.45, slap: 0.2, occlude: false
    });
    if (!h) return;
    var t = h.t0, end = t;
    for (var i = 0; i < barks; i++) {
      var f = base * r.range(0.9, 1.15);
      var dur = r.range(0.10, 0.17);
      // Same formant trick as the enemy shouts, tuned to a canine tract.
      var o = this._osc(h, 'sawtooth', t, dur + 0.03);
      var mix = this._gain(h, 1);
      if (o) {
        o.frequency.setValueAtTime(f * 1.25, t);
        o.frequency.exponentialRampToValueAtTime(f * 0.62, t + dur);
        var og = this._gain(h, 0.75);
        o.connect(og); og.connect(mix);
      }
      var nz = this._src(h, 'white', t, dur + 0.03, 1);
      if (nz) {
        var ng = this._gain(h, 0.30);
        nz.connect(ng); ng.connect(mix);
      }
      var out = this._gain(h, 0);
      var fr = [520, 1420, 2600];
      for (var k = 0; k < 3; k++) {
        var bp = this._filter(h, 'bandpass', fr[k] * r.range(0.92, 1.08), 6);
        var ag = this._gain(h, [1, 0.5, 0.2][k]);
        mix.connect(bp); bp.connect(ag); ag.connect(out);
      }
      out.connect(h.dest);
      end = Math.max(end, envAHD(out.gain, t, 0.9, 0.008, dur * 0.35, dur * 0.6));
      t += r.range(0.24, 0.46);
    }
    h.end = end;
    this._close(h);
  };

  Audio.prototype._ambCreak = function () {
    var r = this.rng;
    var p = this._ambPoint(5, 22, -1, 8);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.25, 0.6), refDistance: 8,
      send: 0.35, slap: 0.15, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    var dur = r.range(0.5, 1.4);
    var f = r.range(95, 240);
    // Corrugated metal or a hanging sign flexing: a stick-slip squeal.
    var o = this._osc(h, 'sawtooth', t, dur + 0.05);
    if (o) {
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * r.range(1.1, 1.6), t + dur * 0.6);
      o.frequency.linearRampToValueAtTime(f * r.range(0.8, 1.05), t + dur);
      var bp = this._filter(h, 'bandpass', r.range(700, 2100), 18);
      var g = this._gain(h, 0);
      o.connect(bp); bp.connect(g); g.connect(h.dest);
      // Amplitude stutter = the stick-slip that makes it a creak not a tone.
      g.gain.setValueAtTime(FLOOR, t);
      // Q=18 on a sawtooth throws away most of the harmonic series, so this
      // needs the same narrowband make-up as the UI ticks.
      var tt = t, amp = 0.30 * NB * 0.65;
      while (tt < t + dur) {
        var seg = r.range(0.02, 0.09);
        g.gain.linearRampToValueAtTime(amp * r.range(0.15, 1.0), tt + seg * 0.5);
        g.gain.linearRampToValueAtTime(amp * r.range(0.05, 0.6), tt + seg);
        tt += seg;
      }
      g.gain.exponentialRampToValueAtTime(FLOOR, t + dur + 0.08);
      g.gain.setValueAtTime(0, t + dur + 0.1);
    }
    h.end = t + dur + 0.15;
    this._close(h);
  };

  Audio.prototype._ambVehicle = function () {
    var r = this.rng;
    var p = this._ambPoint(50, 130, -2, 1);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.3, 0.6), refDistance: 34, rolloff: 0.5,
      send: 0.3, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    var dur = r.range(3.5, 7.0);
    var s = this._src(h, 'brown', t, dur + 0.1, r.range(0.8, 1.2));
    if (s) {
      var lp = this._filter(h, 'lowpass', 300, 0.8);
      var g = this._gain(h, 0);
      s.connect(lp); lp.connect(g); g.connect(h.dest);
      // Approach and recede: level swells, and the spectrum opens then closes.
      lp.frequency.setValueAtTime(180, t);
      lp.frequency.linearRampToValueAtTime(520, t + dur * 0.5);
      lp.frequency.linearRampToValueAtTime(150, t + dur);
      g.gain.setValueAtTime(FLOOR, t);
      g.gain.linearRampToValueAtTime(1.0, t + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
      g.gain.setValueAtTime(0, t + dur + 0.02);
    }
    // An engine order component so it is a vehicle, not just a whoosh.
    var o = this._osc(h, 'sawtooth', t, dur + 0.05);
    if (o) {
      var f = r.range(46, 78);
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * 1.35, t + dur * 0.5);
      o.frequency.linearRampToValueAtTime(f * 0.85, t + dur);
      var olp = this._filter(h, 'lowpass', 260, 1.2);
      var og = this._gain(h, 0);
      o.connect(olp); olp.connect(og); og.connect(h.dest);
      og.gain.setValueAtTime(FLOOR, t);
      og.gain.linearRampToValueAtTime(0.16, t + dur * 0.5);
      og.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
      og.gain.setValueAtTime(0, t + dur + 0.02);
    }
    h.end = t + dur + 0.15;
    this._close(h);
  };

  Audio.prototype._ambDebris = function () {
    var r = this.rng;
    var p = this._ambPoint(4, 18, -1, 5);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.2, 0.5), refDistance: 7,
      send: 0.35, slap: 0.15, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    // A little rubble letting go somewhere out of sight.
    var e1 = this._grains(h, {
      t: t, count: 4 + r.int(0, 5), span: r.range(0.2, 0.6),
      fLo: 1200, fHi: 5200, g: 0.35, q: 2.4
    });
    var e2 = this._burst(h, {
      t: t, type: 'lowpass', f0: 700, f1: 220, q: 0.9, g: 0.2, atk: 0.003, dec: 0.12
    });
    h.end = Math.max(e1, e2);
    this._close(h);
  };

  // --------------------------------------------------------------------------
  // Reverb presets
  // --------------------------------------------------------------------------
  Audio.prototype.setReverb = function (preset) {
    try {
      if (!IR_PRESETS[preset]) preset = 'outdoor';
      if (preset === this.reverbPreset) return;
      this.reverbPreset = preset;
      if (!this.available) return;

      var ir = this._ensureIR(preset);
      if (ir && this.armed) {
        // Crossfade between the two convolvers so the running tail is not cut.
        var t = this.actx.currentTime;
        var incoming = this._activeConv === 'A' ? 'B' : 'A';
        var inConv = incoming === 'A' ? this.convA : this.convB;
        var inGain = incoming === 'A' ? this.convAGain : this.convBGain;
        var outGain = incoming === 'A' ? this.convBGain : this.convAGain;
        inConv.buffer = ir;
        inGain.gain.cancelScheduledValues(t);
        outGain.gain.cancelScheduledValues(t);
        inGain.gain.setValueAtTime(inGain.gain.value, t);
        outGain.gain.setValueAtTime(outGain.gain.value, t);
        inGain.gain.linearRampToValueAtTime(1, t + 0.45);
        outGain.gain.linearRampToValueAtTime(0, t + 0.45);
        this._activeConv = incoming;
      } else if (ir) {
        this.convA.buffer = ir;
        this.convB.buffer = ir;
      }
      this._applyEchoPreset(preset, 0.35);
    } catch (e) {
      GAME.logError('audio.setReverb', e);
    }
  };

  Audio.prototype._applyEchoPreset = function (preset, fade) {
    var E = ECHO_PRESETS[preset] || ECHO_PRESETS.outdoor;
    if (!this.echoTaps) return;
    var a = this.actx, t = a.currentTime;
    for (var i = 0; i < this.echoTaps.length; i++) {
      var tap = this.echoTaps[i];
      if (fade > 0) {
        // Duck the tap, then re-time it once it is silent. Ramping delayTime
        // directly would pitch-shift whatever is still in the line.
        tap.gain.gain.cancelScheduledValues(t);
        tap.gain.gain.setValueAtTime(tap.gain.gain.value, t);
        tap.gain.gain.linearRampToValueAtTime(0.0001, t + fade * 0.4);
        tap.delay.delayTime.setValueAtTime(E.times[i], t + fade * 0.45);
        tap.filter.frequency.setValueAtTime(E.cuts[i], t + fade * 0.45);
        tap.gain.gain.linearRampToValueAtTime(E.gains[i], t + fade);
      } else {
        tap.delay.delayTime.value = E.times[i];
        tap.filter.frequency.value = E.cuts[i];
        tap.gain.gain.value = E.gains[i];
      }
      if (tap.pan) tap.pan.pan.value = E.pans[i];
    }
    if (this.echoFb) {
      if (fade > 0) this.echoFb.gain.setTargetAtTime(E.fb, t, fade * 0.4);
      else this.echoFb.gain.value = E.fb;
    }
  };

  // --------------------------------------------------------------------------
  // Public play() registry.
  // Names are deliberately forgiving: other modules were written independently
  // and a mismatched string should degrade to a sensible sound, never silence.
  // --------------------------------------------------------------------------
  var PLAYERS = {
    gunshot: function (o) { this.playGunshot(o.weapon || 'rifle', o.position, o); },
    shot: function (o) { this.playGunshot(o.weapon || 'rifle', o.position, o); },
    fire: function (o) { this.playGunshot(o.weapon || 'rifle', o.position, o); },
    distant_gunshot: function (o) { this._distantShotDelayed(vecOf(o.position) || this._ambPoint(60, 120, 0, 6), o.pitch || 1, o.volume === undefined ? 0.7 : o.volume, o.delay || 0); },

    footstep: function (o) { this.playFootstep(o.surface || o.material, o); },
    step: function (o) { this.playFootstep(o.surface || o.material, o); },
    land: function (o) { this.playLand(o.surface || o.material, o); },
    jump: function (o) { this.playJump(o); },

    reload: function (o) { this.playReload(o.weapon, o); },
    dryfire: function (o) { this.playDryFire(o); },
    empty: function (o) { this.playDryFire(o); },
    weapon_switch: function (o) { this.playWeaponSwitch(o); },
    ads_in: function (o) { this.playADS(true); },
    ads_out: function (o) { this.playADS(false); },

    impact: function (o) { this.playImpact(o.material || o.surface, o.position, o); },
    ricochet: function (o) { this.playRicochet(o.position, o); },
    whizby: function (o) { this.nearMiss(o.position, o.from || o.shooter, o.weapon); },
    crack: function (o) { this.nearMiss(o.position, o.from || o.shooter, o.weapon); },
    shell: function (o) { this.playShell(o.position, o); },
    explosion: function (o) { this.playExplosion(o.position, o.radius, o); },
    bodyfall: function (o) { this.playBodyfall(o.position, o); },

    shout: function (o) { this.playVoice('shout', o.position, o); },
    alert: function (o) { this.playVoice('alert', o.position, o); },
    order: function (o) { this.playVoice('order', o.position, o); },
    pain: function (o) { this.playVoice('pain', o.position, o); },
    death: function (o) { this.playVoice('death', o.position, o); },
    grunt: function (o) { this.playVoice('grunt', o.position, o); },
    taunt: function (o) { this.playVoice('taunt', o.position, o); },

    hitmarker: function (o) { this.playUI('hit', o); },
    hit: function (o) { this.playUI('hit', o); },
    headshot: function (o) { this.playUI('headshot', o); },
    kill: function (o) { this.playUI('kill', o); },
    lowammo: function (o) { this.playUI('lowammo', o); },
    lowhealth: function (o) { this.playUI('lowhealth', o); },
    damage: function (o) { this.playUI('damage', o); },
    ui_click: function (o) { this.playUI('ui_click', o); }
  };

  Audio.prototype.play = function (name, opts) {
    if (!this.armed || !name) return;
    try {
      var fn = PLAYERS[name];
      if (!fn) {
        // Unknown name: try the material tables before giving up, so a call
        // like play('concrete', {...}) still produces something.
        var k = String(name).toLowerCase();
        if (IMPACTS[k] || IMPACT_ALIAS[k]) { this.playImpact(k, (opts || EMPTY).position, opts); return; }
        if (SURFACES[k] || SURFACE_ALIAS[k]) { this.playFootstep(k, opts); return; }
        return;
      }
      fn.call(this, opts || EMPTY);
    } catch (e) {
      GAME.logError('audio.play:' + name, e);
    }
  };

  // --------------------------------------------------------------------------
  // Event bus wiring.
  // Every handler is written to survive an unexpected payload shape, because
  // the modules emitting these were authored in parallel with this one.
  // --------------------------------------------------------------------------
  Audio.prototype._bindEvents = function () {
    var bus = (this.ctx && this.ctx.bus) || GAME.bus;
    if (!bus || !bus.on) return;
    var self = this;

    function on(evt, fn) { bus.on(evt, fn); }

    // ---- movement ----------------------------------------------------------
    function footstep(a, b) {
      var surf = strOf(a, ['surface', 'material', 'ground', 'kind'], null) ||
                 strOf(b, ['surface', 'material'], null) || 'concrete';
      var o = (a && typeof a === 'object') ? a : (b && typeof b === 'object' ? b : EMPTY);
      self.playFootstep(surf, {
        position: vecOf(o) || (self.ctx && self.ctx.player ? self.ctx.player.position : null),
        volume: o.volume, effort: o.effort || o.speed ? M.clamp((o.effort || o.speed / 4.5), 0.4, 1.7) : 1
      });
    }
    on('player:footstep', footstep);
    on('footstep', footstep);
    on('ai:footstep', function (a, b) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self._lastStep = -1;             // AI steps must not de-dupe against ours
      self.playFootstep(strOf(a, ['surface', 'material'], 'concrete'), {
        position: vecOf(o), volume: 0.7, effort: o.effort || 1
      });
    });
    on('player:land', function (a) { self.playLand(strOf(a, ['surface', 'material'], 'concrete'), a || EMPTY); });
    on('player:jump', function (a) { self.playJump(a || EMPTY); });

    // ---- weapons -----------------------------------------------------------
    on('weapon:fire', function (a, b) {
      var w = (a && (a.weapon || a.name)) ? (a.weapon || a) : (a || 'rifle');
      var p = vecOf(a) || vecOf(b) || null;
      self.playGunshot(w, p, (a && typeof a === 'object') ? a : EMPTY);
    });
    on('weapon:reload', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playReload(o.weapon || a, o);
    });
    on('weapon:reloadStart', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playReload(o.weapon || a, o);
    });
    on('weapon:dryfire', function () { self.playDryFire(); });
    on('weapon:empty', function () { self.playDryFire(); });
    on('weapon:switch', function () { self.playWeaponSwitch(); });
    on('weapon:ads', function (a) { self.playADS(a === undefined ? true : !!(a && (a.on !== undefined ? a.on : a))); });
    on('weapon:shell', function (a) { self.playShell(vecOf(a), a || EMPTY); });
    on('shell:eject', function (a) { self.playShell(vecOf(a), a || EMPTY); });
    on('shell:land', function (a) { self.playShell(vecOf(a), a || EMPTY); });
    on('weapon:lowammo', function () { self.playUI('lowammo'); });

    // ---- ballistics --------------------------------------------------------
    function impact(a, b) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      var mat = strOf(a, ['material', 'surface', 'kind', 'mat'], null) ||
                strOf(b, ['material', 'surface', 'kind'], null) || 'concrete';
      self.playImpact(mat, vecOf(o) || vecOf(b), o);
    }
    on('bullet:impact', impact);
    on('impact', impact);
    on('vfx:impact', impact);
    on('bullet:ricochet', function (a) { self.playRicochet(vecOf(a), a || EMPTY); });
    on('ricochet', function (a) { self.playRicochet(vecOf(a), a || EMPTY); });
    on('bullet:nearmiss', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.nearMiss(vecOf(o), o.from || o.shooter || o.origin, o.weapon);
    });
    on('explosion', function (a, b) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playExplosion(vecOf(o) || vecOf(b), o.radius || (typeof b === 'number' ? b : 4.5), o);
    });
    on('vfx:explosion', function (a, b) {
      self.playExplosion(vecOf(a), typeof b === 'number' ? b : 4.5, EMPTY);
    });

    // ---- combat feedback ---------------------------------------------------
    on('hud:hitmarker', function (a) {
      var k = strOf(a, ['kind', 'type'], 'hit');
      self.playUI(k === 'headshot' ? 'headshot' : (k === 'kill' ? 'kill' : 'hit'));
    });
    on('enemy:hit', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playImpact('flesh', vecOf(o), o);
      if (self.rng.bool(0.45)) self.playVoice(self.rng.bool(0.5) ? 'pain' : 'grunt', vecOf(o), EMPTY);
    });
    on('enemy:death', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playVoice('death', vecOf(o), EMPTY);
      self.playBodyfall(vecOf(o), { delay: self.rng.range(0.25, 0.5) });
    });
    on('enemy:alert', function (a) { self.playVoice('alert', vecOf(a), EMPTY); });
    on('enemy:shout', function (a) { self.playVoice(strOf(a, ['kind'], 'shout'), vecOf(a), EMPTY); });
    on('enemy:fire', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self._lastShot = -1;             // a different shooter than the player
      self.playGunshot(o.weapon || 'rifle', vecOf(o), o);
    });
    on('enemy:reload', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.playReload(o.weapon, { position: vecOf(o), volume: 0.7 });
    });
    on('player:hurt', function () { self.playUI('damage'); });
    on('player:damage', function () { self.playUI('damage'); });

    // ---- environment -------------------------------------------------------
    on('audio:reverb', function (a) { self.setReverb(strOf(a, ['preset', 'name'], 'outdoor')); });
    on('game:start', function () { self.unlock(); });
  };

  // --------------------------------------------------------------------------
  // Listener + per-frame mix
  // --------------------------------------------------------------------------
  Audio.prototype._updateListener = function (cam) {
    var L = this.actx.listener;
    if (!L || !cam) return;
    var e = cam.matrixWorld.elements;
    var px = e[12], py = e[13], pz = e[14];
    this._listener.x = px; this._listener.y = py; this._listener.z = pz;
    // three.js cameras look down -Z; the up vector is the matrix Y axis.
    var fx = -e[8], fy = -e[9], fz = -e[10];
    var ux = e[4], uy = e[5], uz = e[6];
    var t = this.actx.currentTime;

    if (L.positionX) {
      // A short time-constant smooths the zipper noise of a fast mouse turn
      // without introducing audible lag.
      L.positionX.setTargetAtTime(px, t, 0.012);
      L.positionY.setTargetAtTime(py, t, 0.012);
      L.positionZ.setTargetAtTime(pz, t, 0.012);
      L.forwardX.setTargetAtTime(fx, t, 0.012);
      L.forwardY.setTargetAtTime(fy, t, 0.012);
      L.forwardZ.setTargetAtTime(fz, t, 0.012);
      L.upX.setTargetAtTime(ux, t, 0.02);
      L.upY.setTargetAtTime(uy, t, 0.02);
      L.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      if (L.setPosition) L.setPosition(px, py, pz);
      if (L.setOrientation) L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  };

  // Pick a reverb preset from the geometry actually around the listener, so
  // stepping into the gutted shop or the alley changes the space without
  // level.js needing to know anything about audio.
  Audio.prototype._autoReverb = function () {
    var lvl = this.ctx && this.ctx.level;
    if (!lvl || !lvl.raycast) return;
    var o = this._listener;
    var preset = 'outdoor';
    try {
      var up = lvl.raycast({ x: o.x, y: o.y, z: o.z }, { x: 0, y: 1, z: 0 }, 9);
      if (up && up.hit) {
        // Roofed. Big volume overhead reads as a hall, low ceiling as a room.
        preset = (up.distance !== undefined && up.distance > 6.0) ? 'hall' : 'interior';
      } else {
        // Open above: check for two close parallel walls -> alley flutter.
        var near = 0, side = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var i = 0; i < 4; i++) {
          var r = lvl.raycast({ x: o.x, y: o.y, z: o.z },
            { x: side[i][0], y: 0, z: side[i][1] }, 3.4);
          if (r && r.hit) near++;
        }
        if (near >= 2) preset = 'alley';
      }
    } catch (e) { return; }         // level not ready: keep the current preset
    if (preset !== this.reverbPreset) this.setReverb(preset);
  };

  Audio.prototype.update = function (dt, ctx) {
    if (!this.available) return;
    try {
      if (ctx) this.ctx = ctx;
      if (!this.armed) {
        // Chrome can move the context to 'running' asynchronously after a
        // gesture we did not see; pick it up rather than staying mute.
        if (this.actx.state === 'running') this._arm();
        return;
      }
      dt = Math.min(dt || 0, 0.25);

      this._occBudget = 6;
      this._sweep();
      this._updateListener((ctx && ctx.camera) || (this.ctx && this.ctx.camera));

      // --- ambience ducking under gunfire ----------------------------------
      // Combat should feel like it displaces the world, not sit on top of it.
      if (this._duck > 0.001) {
        this._duck *= Math.exp(-dt * 1.9);
        if (this._duck < 0.004) this._duck = 0;
        var amb = this.buses.ambient;
        if (amb) {
          amb.gain.setTargetAtTime(
            this._ambientBase * (1 - this._duck * 0.72), this.actx.currentTime, 0.09);
        }
      }

      // --- ear-ringing recovery --------------------------------------------
      if (this._ringLevel > 0.001) {
        // Slower recovery for a heavier dose, like real temporary threshold shift.
        this._ringLevel *= Math.exp(-dt / (1.9 + 4.5 * this._ringLevel));
        if (this._ringLevel < 0.006) this._ringLevel = 0;
        var open = Math.min(21000, this.sampleRate * 0.46);
        var f = M.lerp(open, 520, M.saturate(this._ringLevel));
        this.muffle.frequency.setTargetAtTime(f, this.actx.currentTime, 0.05);
        // Duck the world slightly too - a blast does not just filter, it deafens.
        this.preMaster.gain.setTargetAtTime(
          1 - this._ringLevel * 0.35, this.actx.currentTime, 0.06);
      }

      // --- sparse ambience events ------------------------------------------
      if (this._ambBuilt) {
        for (var i = 0; i < this._ambTimers.length; i++) {
          var e = this._ambTimers[i];
          e.t -= dt;
          if (e.t <= 0) {
            e.t = this.rng.range(e.lo, e.hi);
            var fn = this[e.fn];
            if (fn) { try { fn.call(this); } catch (err) { GAME.logError('audio.amb', err); } }
          }
        }
      }

      // --- environment-driven reverb ---------------------------------------
      this._autoReverbTimer -= dt;
      if (this._autoReverbTimer <= 0) {
        this._autoReverbTimer = 0.4;
        this._autoReverb();
      }
    } catch (e) {
      GAME.logError('audio.update', e);
    }
  };

  // Diagnostics for the integration layer / debug overlay.
  Audio.prototype.stats = function () {
    return {
      available: this.available,
      armed: this.armed,
      state: this.actx ? this.actx.state : 'none',
      voices: this._voices.length - this._freeVoices.length,
      live: this._pending ? this._pending.active.length : 0,
      reverb: this.reverbPreset,
      duck: this._duck,
      ring: this._ringLevel
    };
  };

  GAME.Audio = Audio;
})(window.GAME, window.THREE);
