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
    },
    // ---- LEVEL 2 additions -------------------------------------------------
    // Soaked concrete is still concrete underneath, but the boot displaces a
    // film of standing water: brighter click, and a shower of fine droplet
    // grains that dry concrete does not have. This is the single loudest cue
    // that the harbor is wet.
    wet_concrete: {
      level: 0.98, subF: 104, subDec: 0.050, subG: 0.40,
      bodyF: 760, bodyQ: 0.80, bodyDec: 0.058, bodyG: 0.78,
      clickF: 3600, clickQ: 2.4, clickG: 0.30, clickDec: 0.014,
      grains: 6, grainLo: 2600, grainHi: 9000, grainG: 0.26, rustle: 0.14
    },
    // Open steel grating: almost no body, all ring and rattle.
    grate: {
      level: 1.00, subF: 128, subDec: 0.035, subG: 0.26,
      bodyF: 1500, bodyQ: 1.5, bodyDec: 0.045, bodyG: 0.55,
      clickF: 5600, clickQ: 4.2, clickG: 0.46, clickDec: 0.011,
      grains: 3, grainLo: 3000, grainHi: 9000, grainG: 0.16,
      partials: [640, 1310, 2480, 3970, 5820], partialDec: 0.32, partialG: 0.24,
      rustle: 0.13
    }
  };
  // Aliases so a level that reports material names straight from the collider
  // table still lands on something sensible.
  var SURFACE_ALIAS = {
    concrete_wall: 'concrete', plaster: 'concrete', brick: 'concrete',
    stone: 'concrete', rock: 'gravel', painted_metal: 'metal',
    rusted_metal: 'metal', corrugated_metal: 'metal', wood_plank: 'wood',
    plank: 'wood', foliage: 'dirt', grass: 'dirt', fabric: 'carpet',
    rubber: 'carpet', sandbag: 'sand', debris: 'rubble', road: 'asphalt',
    // ---- LEVEL 2 (Cold Harbor) material names -----------------------------
    container_steel: 'metal', container_red: 'metal', container_blue: 'metal',
    container_green: 'metal', reefer_panel: 'metal', ship_hull: 'metal',
    deck_plate: 'metal', corrugated_roof: 'metal', chainlink: 'metal',
    steel_grate: 'grate',
    dock_concrete: 'wet_concrete', painted_line: 'wet_concrete',
    puddle: 'wet_concrete', apron: 'wet_concrete',
    sea_water: 'water', tarpaulin: 'carpet', rope: 'carpet',
    rubber_fender: 'carpet'
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
    },
    // A shipping container is a 12m steel drum. A round through the flank is
    // not a "ting" - it is a bright strike on top of a long, low, hollow BOOM
    // as the whole box rings. Level 2 lives or dies on this sound.
    hollow_metal: {
      level: 1.12, crackF: 4200, crackQ: 1.9, crackDec: 0.022, crackG: 1.00,
      bodyF0: 2200, bodyF1: 480, bodyQ: 1.1, bodyDec: 0.10, bodyG: 0.72,
      subF0: 120, subF1: 62, subDec: 0.14, subG: 0.55,
      partials: [148, 337, 692, 1245, 2310, 3880], partialDec: 0.85,
      partialG: 0.34, grains: 0, span: 0.05
    }
  };
  var IMPACT_ALIAS = {
    concrete_wall: 'concrete', asphalt: 'concrete', tile: 'concrete',
    stone: 'concrete', brick: 'concrete', rubble: 'concrete',
    gravel: 'dirt', rock: 'concrete',
    painted_metal: 'metal', rusted_metal: 'metal', corrugated_metal: 'metal',
    steel: 'metal', wood_plank: 'wood', plank: 'wood', crate: 'wood',
    body: 'flesh', head: 'flesh', blood: 'flesh', enemy: 'flesh',
    rubber: 'fabric', carpet: 'fabric', cloth: 'fabric', canopy: 'fabric',
    // ---- LEVEL 2 (Cold Harbor) material names -----------------------------
    container_steel: 'hollow_metal', container_red: 'hollow_metal',
    container_blue: 'hollow_metal', container_green: 'hollow_metal',
    reefer_panel: 'hollow_metal', ship_hull: 'hollow_metal',
    corrugated_roof: 'hollow_metal',
    deck_plate: 'metal', steel_grate: 'metal', chainlink: 'metal',
    wet_concrete: 'concrete', dock_concrete: 'concrete',
    painted_line: 'concrete', puddle: 'water', sea_water: 'water',
    tarpaulin: 'fabric', rope: 'fabric', rubber_fender: 'fabric'
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
    },

    // ---- LEVEL 2: COLD HARBOR ----------------------------------------------
    // The open terminal. Enormous, hard, and WET - soaked steel and standing
    // water absorb almost nothing, so the high end survives far longer than it
    // does in the dusty market and the tail runs out past half a second of
    // discrete slap-back off container walls and the freighter hull across the
    // water. Sparse, late, LOUD reflections: this is what makes a gunshot here
    // sound like it is happening in a place the size of a car park.
    harbor: {
      len: 3.10, predelay: 0.022, build: 0.010, decay: 2.05,
      hf0: 8600, hfDecay: 1.30, diffuse: 0.62, wet: 0.46,
      er: [[0.034, 0.62], [0.061, 0.50], [0.089, 0.55], [0.128, 0.40],
           [0.171, 0.34], [0.223, 0.28], [0.287, 0.22], [0.361, 0.17],
           [0.447, 0.13], [0.552, 0.095]]
    },
    // Inside the container canyons. Two parallel corrugated steel walls ~5m
    // apart: a flutter echo like the alley but tighter, brighter and far more
    // metallic, because steel reflects the top octave that plaster eats.
    container: {
      len: 1.70, predelay: 0.004, build: 0.002, decay: 4.0,
      hf0: 9800, hfDecay: 1.90, diffuse: 0.80, wet: 0.52,
      er: [[0.0148, 0.72], [0.0296, 0.60], [0.0444, 0.50], [0.0592, 0.42],
           [0.0740, 0.35], [0.0888, 0.29], [0.1036, 0.24], [0.1184, 0.19],
           [0.1332, 0.15], [0.1480, 0.12]]
    },
    // The warehouse interior: big volume, concrete floor, steel roof deck,
    // racking breaking up the diffusion. Darker than the open quay - a roof
    // and a back wall do absorb something.
    warehouse: {
      len: 2.30, predelay: 0.009, build: 0.006, decay: 3.0,
      hf0: 5400, hfDecay: 2.30, diffuse: 1.0, wet: 0.50,
      er: [[0.0092, 0.58], [0.0171, 0.50], [0.0263, 0.44], [0.0374, 0.38],
           [0.0508, 0.32], [0.0669, 0.26], [0.0862, 0.21], [0.1093, 0.16],
           [0.1368, 0.12]]
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
    },
    // Long, wide, and only gently darkened: 0.13s is a container stack 22m
    // away, 0.61s is the freighter hull across 100m of black water.
    harbor: {
      times: [0.132, 0.238, 0.394, 0.611], gains: [0.42, 0.32, 0.21, 0.13],
      cuts: [4200, 3000, 2100, 1300], pans: [-0.78, 0.70, -0.44, 0.30], fb: 0.10
    },
    container: {
      times: [0.0154, 0.0301, 0.0468, 0.0951], gains: [0.48, 0.38, 0.30, 0.18],
      cuts: [7600, 6000, 4400, 2900], pans: [-0.88, 0.84, -0.56, 0.38], fb: 0.50
    },
    warehouse: {
      times: [0.0246, 0.0472, 0.0783, 0.1364], gains: [0.34, 0.27, 0.20, 0.12],
      cuts: [4800, 3400, 2400, 1600], pans: [-0.62, 0.55, -0.34, 0.24], fb: 0.28
    }
  };

  // --------------------------------------------------------------------------
  // LEVEL 2 positional anchors.
  //
  // level_harbor.js owns the layout and is authored in parallel with this file,
  // so nothing here may *depend* on a field it publishes. Each anchor resolves
  // in three steps: an explicit level.audioAnchors entry, else an offset from
  // a published camera pose (the harbor level is contractually required to
  // publish quay/containers/warehouse/crane/gangway/overview), else a hardcoded
  // fallback consistent with the art bible - the apron runs along -Z, the
  // player spawns at the landward south end, so the water is at negative Z.
  // --------------------------------------------------------------------------
  var HARBOR_ANCHORS = {
    quay:      { pose: 'quay',       off: [0, -1.0, -8],   def: [0, 0.6, -26] },
    water:     { pose: 'quay',       off: [0, -2.2, -15],  def: [0, -0.6, -34] },
    hull:      { pose: 'gangway',    off: [0, 3.0, -11],   def: [6, 6.0, -42] },
    reefer:    { pose: 'containers', off: [11, 0.6, 7],    def: [16, 1.4, -6] },
    crane:     { pose: 'crane',      off: [0, 7.0, -6],    def: [-4, 12.0, -22] },
    machinery: { pose: 'overview',   off: [-26, -8, 28],   def: [-38, 2.0, 22] },
    horn:      { pose: 'quay',       off: [-22, 5, -66],   def: [-24, 6.0, -95] },
    fence:     { pose: 'overview',   off: [22, -9, 20],    def: [30, 1.6, 20] }
  };

  // Which of the harbor material names read as "rain drumming on steel" versus
  // "rain hissing into water and concrete". Drives the surface-dependent rain
  // layers - the whole point of the requirement that rain on metal differs.
  var RAIN_METAL = {
    container_steel: 1, container_red: 1, container_blue: 1, container_green: 1,
    reefer_panel: 1, ship_hull: 1, corrugated_roof: 1, deck_plate: 1,
    steel_grate: 0.8, chainlink: 0.6, corrugated_metal: 1, rusted_metal: 0.9,
    painted_metal: 0.9, metal: 1, steel: 1
  };
  var RAIN_DULL = {
    wet_concrete: 1, dock_concrete: 1, painted_line: 1, concrete: 1,
    concrete_wall: 0.8, sea_water: 1, water: 1, puddle: 1, asphalt: 0.9,
    tarpaulin: 0.7, rubber_fender: 0.6, rope: 0.5
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

    // ---- LEVEL 2 (Cold Harbor) state ---------------------------------------
    // `_env` is the ambience/reverb family, resolved from ctx.levelId unless an
    // explicit preset was forced through setAmbience(). Level 1 must resolve to
    // 'street' and take exactly the code path it always did, so every harbor
    // behaviour in this file is gated on this one flag.
    this._ambiencePreset = null;   // null = derive from ctx.levelId
    this._env = 'street';
    this._harbor = false;
    this._rain = null;             // rain sub-graph, built with harbor ambience
    this._rainLevel = 0;
    this._covered = 0;             // 0..1 overhead occlusion (under a roof)
    this._coverTarget = 0;
    this._metalNear = 0;           // 0..1 how much steel is around us
    this._dullNear = 0.5;          // 0..1 how much concrete/water is around us
    this._probeTimer = 0.2;
    this._windGains = null;
    this._fenceGain = null;
    this._thunderQueue = [];
    this._thunderConv = [];
    this._thunderIRs = [];
    this._thunderIdx = 0;
    this._lastStrike = -1e9;
    this._prevFlash = 0;
    this._windPan = 0;
    this._anchors = null;
    this._reefer = null;

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

  // Rain. NOT noise: a dense field of individual droplet impacts, each a very
  // short decaying burst with its own amplitude. Filtered white noise is
  // spectrally similar but perceptually wrong - the ear resolves the leading
  // edges of nearby drops, and a source without them reads as hiss forever,
  // however cleverly it is EQ'd. `drops` is impacts per second per channel;
  // 2600 is heavy rain on a hard surface, 9000 is the fine sheet in the air.
  Audio.prototype._makeRainPatter = function (seconds, channels, drops) {
    var sr = this.sampleRate, n = Math.floor(sr * seconds);
    channels = channels || 2;
    var buf = this.actx.createBuffer(channels, n, sr);
    var rng = this.rng;
    var count = Math.floor(seconds * drops);
    for (var c = 0; c < channels; c++) {
      var d = buf.getChannelData(c);
      for (var k = 0; k < count; k++) {
        var i = (rng.next() * (n - 96)) | 0;
        // Squared amplitude distribution: a lot of faint distant drops, a few
        // loud close ones. Uniform amplitudes sound like applause.
        var u = rng.next();
        var amp = u * u * rng.range(0.6, 1.0);
        var len = 6 + ((rng.next() * rng.next() * 90) | 0);
        var inv = 1 / len;
        for (var j = 0; j < len; j++) {
          // Each drop is its own micro burst of noise under a linear decay.
          d[i + j] += rng.range(-1, 1) * amp * (1 - j * inv);
        }
      }
      // Normalise so layer gains mean the same thing at any density.
      var peak = 0;
      for (var s = 0; s < n; s++) { var v = d[s] < 0 ? -d[s] : d[s]; if (v > peak) peak = v; }
      if (peak > 1e-6) {
        var g = 0.72 / peak;
        for (var q = 0; q < n; q++) d[q] *= g;
      }
    }
    return buf;
  };

  // Thunder impulse response.
  //
  // Thunder is not one event. The channel is kilometres of turbulent, layered
  // air, and the report of a discharge several kilometres long arrives as a
  // smeared train of arrivals from different parts of the bolt at different
  // distances - which is why real thunder ROLLS: it swells, dies back, swells
  // again, and finally trails off. Modelling that as an envelope on a noise
  // burst never works, because the swells have to be applied to the *channel*,
  // not to the source. So: build a long IR with irregular gaussian swells and
  // a handful of discrete arrivals, then push a short excitation through it.
  // Excite it with a bright burst and you get a close crack that decays into a
  // roll; excite it with a dark, soft one and you get distant rumble.
  Audio.prototype._makeThunderIR = function (seconds, variant) {
    var sr = this.sampleRate;
    var n = Math.floor(sr * seconds);
    var buf = this.actx.createBuffer(2, n, sr);
    // Deterministic per variant so two runs produce identical thunder.
    var rng = new GAME.RNG((0x7B0DE7 ^ hashStr('thunder' + variant)) >>> 0);

    // 4-8 swells: the audible "roll". Centres are biased early but the widest
    // ones sit late, which is what makes thunder trail rather than stop.
    var nSw = 4 + (variant % 3) + rng.int(0, 2);
    var sw = [];
    for (var s = 0; s < nSw; s++) {
      var frac = Math.pow(rng.next(), 0.75);
      sw.push({
        c: frac * seconds,
        w: rng.range(0.18, 0.55) + frac * rng.range(0.4, 1.5),
        g: rng.range(0.35, 1.35) * (1 - frac * 0.45)
      });
    }
    // Discrete arrivals - separate branches of the bolt, or a reflection off
    // the cloud base. These are what give a strike its "cracks within cracks".
    var nAr = 2 + rng.int(0, 3);
    var ar = [];
    for (var b = 0; b < nAr; b++) {
      ar.push({ t: rng.range(0.01, seconds * 0.55), g: rng.range(0.25, 0.9) });
    }

    // Precompute the swell x decay envelope at 64-sample (~1.3ms) resolution.
    // Evaluating nine gaussians per sample for half a million samples is the
    // whole cost of this function, and the envelope is smooth on a scale
    // thousands of times coarser than that.
    var STEP = 64;
    var nb = ((n / STEP) | 0) + 2;
    var ampTab = new Float32Array(nb);
    for (var e0 = 0; e0 < nb; e0++) {
      var te = (e0 * STEP) / sr;
      var acc = 0.16;
      for (var q0 = 0; q0 < sw.length; q0++) {
        var du = (te - sw[q0].c) / sw[q0].w;
        acc += sw[q0].g * Math.exp(-du * du);
      }
      ampTab[e0] = acc * Math.exp(-te * 0.30);
    }

    var total = 0;
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var lp = 0, lp2 = 0, hp = 0, hpPrev = 0;
      // Decorrelate the ears: the two paths through the air are not identical.
      var jitter = ch ? 1.06 : 0.95;
      // Two cascaded one-poles whose corner collapses with time: distance eats
      // the top end, and it keeps eating it as the roll goes on. Tabled at the
      // same coarse resolution as the envelope for the same reason.
      var kTab = new Float32Array(nb);
      for (var k0 = 0; k0 < nb; k0++) {
        var tk = (k0 * STEP) / sr;
        var cut = (1400 * Math.exp(-tk * 0.55) + 55) * jitter;
        kTab[k0] = 1 - Math.exp(-2 * Math.PI * Math.min(cut, sr * 0.45) / sr);
      }
      for (var i = 0; i < n; i++) {
        var b0 = i / STEP | 0;
        var w = rng.range(-1, 1);
        var k = kTab[b0];
        lp += (w - lp) * k;
        lp2 += (lp - lp2) * k;
        // Kill DC so the limiter is not fighting an offset.
        hp = 0.9975 * (hp + lp2 - hpPrev);
        hpPrev = lp2;
        d[i] = hp * ampTab[b0];
      }
      for (var a2 = 0; a2 < ar.length; a2++) {
        var idx = Math.floor((ar[a2].t + (ch ? 0.004 : -0.004)) * sr);
        if (idx < 2 || idx >= n - 400) continue;
        // Smeared arrival, not a click: 8ms of decaying noise.
        var alen = Math.floor(sr * 0.008);
        for (var m = 0; m < alen; m++) {
          d[idx + m] += rng.range(-1, 1) * ar[a2].g * (1 - m / alen) * 0.55;
        }
      }
      for (var e = 0; e < n; e++) total += d[e] * d[e];
    }
    // Constant-energy normalisation so all three variants sit at one level.
    var norm = total > 1e-9 ? (1.0 / Math.sqrt(total)) * 26 : 0;
    for (var cc = 0; cc < 2; cc++) {
      var dd = buf.getChannelData(cc);
      for (var z = 0; z < n; z++) dd[z] *= norm;
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
      this._resolveEnv();

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
        var names = this._harbor
          ? ['harbor', 'container', 'warehouse', 'outdoor', 'interior']
          : ['outdoor', 'interior', 'alley', 'hall'];
        for (var i = 0; i < names.length; i++) {
          this.irs[names[i]] = this._makeIR(names[i]);
          await GAME.yieldFrame();
        }
        if (this._harbor) {
          this.reverbPreset = 'harbor';
          this.convA.buffer = this.irs.harbor;
          this.convB.buffer = this.irs.harbor;
          this._applyEchoPreset('harbor', 0);
        } else {
          this.convA.buffer = this.irs.outdoor;
          this.convB.buffer = this.irs.outdoor;
        }
      }

      // Storm-only material. None of this is generated for level 1, so the
      // market's boot cost and its buffer table are byte-for-byte unchanged.
      if (this._harbor && !GAME.headless) {
        // Individually resolvable drop impacts, not a hiss. Rain that is only
        // filtered noise reads as tape hiss no matter how it is EQ'd.
        this.buffers.rainPatter =
          this._sealLoop(this._makeRainPatter(5.0, 2, 2600), 0.35);
        await GAME.yieldFrame();
        this.buffers.rainFine =
          this._sealLoop(this._makeRainPatter(4.0, 2, 9000), 0.30);
        await GAME.yieldFrame();

        // Three thunder impulse responses. A single decaying blob does not
        // sound like thunder; these carry irregular amplitude swells so the
        // rumble rolls, doubles back and dies unevenly like the real thing.
        var tLens = [5.2, 7.4, 9.6];
        for (var k = 0; k < tLens.length; k++) {
          this._thunderIRs.push(this._makeThunderIR(tLens[k], k));
          await GAME.yieldFrame();
        }
      }

      this._driveCurve = driveCurve(1.0);
      this._bindEvents();
      this._resetAmbienceSchedule();
    } catch (e) {
      GAME.logError('audio.build', e);
      this.available = false;
    }
  };

  // Which ambience/reverb family we are in. Called from build(), from _arm()
  // and from setAmbience(); never per frame, because flipping it after the
  // ambience graph exists would require a teardown.
  Audio.prototype._resolveEnv = function () {
    var id = this.ctx && this.ctx.levelId;
    var def = this.ctx && this.ctx.levelDef;
    // levelId is authoritative and is only 'harbor' once GAME.LevelHarbor has
    // actually loaded - when the harbor module is missing, main.js falls back
    // to the market and reports 'market'. That fallback still runs weather.js,
    // so a market-id scene CAN be visibly raining; deliberately keep the
    // street ambience there rather than risk level 1's mix on a broken boot.
    // levelDef.weather is only consulted when levelId is absent entirely.
    var storm = (id === 'harbor') ||
                (!id && def && def.weather === 'storm');
    var preset = this._ambiencePreset || (storm ? 'harbor' : 'street');
    this._env = preset;
    this._harbor = (preset === 'harbor');
    return preset;
  };

  // Public: force an ambience family regardless of ctx.levelId. Safe to call
  // before or after the ambience graph is built - it tears down and rebuilds.
  Audio.prototype.setAmbience = function (name) {
    try {
      if (name !== 'harbor' && name !== 'street') return;
      if (this._ambiencePreset === name) return;
      this._ambiencePreset = name;
      var was = this._ambBuilt;
      this._resolveEnv();
      this._resetAmbienceSchedule();
      if (was) {
        this._teardownAmbience();
        this._buildAmbience();
      }
      this.setReverb(this._harbor ? 'harbor' : 'outdoor');
    } catch (e) {
      GAME.logError('audio.setAmbience', e);
    }
  };

  // Stop and detach every persistent ambience node. Looping BufferSources keep
  // running after a disconnect, so they must be stopped explicitly or they
  // burn CPU forever behind a silent gain.
  Audio.prototype._teardownAmbience = function () {
    for (var i = 0; i < this._ambNodes.length; i++) {
      var n = this._ambNodes[i];
      try { if (n.stop) n.stop(); } catch (e) { /* not a source, or not started */ }
      try { n.disconnect(); } catch (e2) { /* already detached */ }
    }
    this._ambNodes.length = 0;
    this._ambBuilt = false;
    this._rain = null;
    this._reefer = null;
    this._thunderConv.length = 0;
    this._thunderQueue.length = 0;
    this._windGains = null;
    this._fenceGain = null;
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
    this._resolveEnv();
    try {
      // Make sure the reverb has a buffer even if build() skipped IR generation.
      if (!this.convA.buffer) {
        if (this._harbor && this.reverbPreset === 'outdoor') this.reverbPreset = 'harbor';
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

    // The harbor is a bigger, harder, colder room than the market and the tail
    // is most of what makes it read that way. `envTail` is exactly 1 on level
    // 1, so the market's send/slap arithmetic is bit-identical to before.
    var envTail = this._harbor ? 1.32 : 1.0;

    var h = this._open('weapon', {
      position: firstPerson ? null : pos,
      volume: lvl,
      delay: delay,
      refDistance: 9,
      rolloff: 0.85,
      send: (firstPerson ? 0.26 * P.tail : 0.34 * P.tail) * envTail,
      slap: (firstPerson ? 0.55 * P.tail : 0.34 * P.tail) * envTail,
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

    // ---- 5. LEVEL 2 only: the terminal answering ---------------------------
    // A rifle report inside a container yard does something the market never
    // did: it dumps energy into acres of thin steel plate, and the boxes ring.
    // The reverb and slap-back presets carry the size; these two layers carry
    // the METAL, which is what makes the same weapon unmistakably a different
    // gun here. Gated so level 1 never sees a single extra node.
    if (this._harbor) {
      end = Math.max(end, this._partials(h, {
        t: t + rng.range(0.010, 0.026),
        partials: [172, 396, 745, 1290, 2180, 3560],
        dec: 0.62 * P.tail, g: 0.085 * P.level * rng.range(0.8, 1.25),
        pitch: rng.range(0.90, 1.12)
      }));
      // The cold, boxy return off a container flank a dozen metres away. Long
      // decay, no transient - the transient was eaten by the trip out and back.
      end = Math.max(end, this._burst(h, {
        t: t + rng.range(0.055, 0.105), type: 'bandpass',
        f0: 780 * rng.range(0.85, 1.2), f1: 300, q: 1.15,
        g: 0.30 * P.tail, atk: 0.010, dec: 0.34 * rng.range(0.8, 1.3),
        sweepDur: 0.28
      }));
      // Wet air: the top octave survives over water far better than it did in
      // the market's dust, so put a little of the crack back on the tail.
      end = Math.max(end, this._burst(h, {
        t: t + rng.range(0.030, 0.070), type: 'highpass',
        f0: 4200, q: 0.6, g: 0.10 * P.crackG, atk: 0.006, dec: 0.14
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
  Audio.prototype._loopSource = function (name, out, gainVal, rate) {
    var a = this.actx, buf = this.buffers[name];
    if (!buf) return null;
    var s = a.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.loopStart = 0;
    // _sealLoop crossfaded the tail into the head; loop before the dead zone.
    s.loopEnd = buf._loopEnd || buf.duration;
    if (rate && rate !== 1) s.playbackRate.value = rate;
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
    if (this._harbor) { this._buildHarborAmbience(); return; }
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

  // ==========================================================================
  // LEVEL 2: COLD HARBOR
  //
  // Everything from here to the end of the harbor section is reached only when
  // _harbor is true. The market's ambience graph, schedule, reverb mapping and
  // gunshot layering above are untouched.
  // ==========================================================================

  // Resolve a world position for a named ambience source. Three fallbacks deep
  // so a level that publishes nothing still puts the foghorn out over the water
  // instead of inside the player's head.
  Audio.prototype._harborAnchor = function (key) {
    var D = HARBOR_ANCHORS[key];
    if (!D) return { x: 0, y: 2, z: -20 };
    try {
      var lvl = this.ctx && this.ctx.level;
      var pts = lvl && (lvl.audioAnchors || lvl.soundAnchors);
      var v = pts && pts[key];
      if (v && typeof v.x === 'number') return { x: v.x, y: v.y, z: v.z };
      var poses = lvl && lvl.cameraPoses;
      var p = poses && poses[D.pose] && poses[D.pose].position;
      if (p && typeof p.x === 'number') {
        return { x: p.x + D.off[0], y: p.y + D.off[1], z: p.z + D.off[2] };
      }
    } catch (e) { /* level still building - use the fallback */ }
    return { x: D.def[0], y: D.def[1], z: D.def[2] };
  };

  // A persistent (non-pooled) panner for a continuous positional bed.
  Audio.prototype._ambPanner = function (p, refDist, rolloff, dest) {
    var a = this.actx;
    var pan = a.createPanner();
    // equalpower, not HRTF: these run forever and never need pinpoint imaging.
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = refDist;
    pan.maxDistance = 400;
    pan.rolloffFactor = rolloff;
    pan.coneInnerAngle = 360; pan.coneOuterAngle = 360; pan.coneOuterGain = 1;
    pos3(pan, p.x, p.y, p.z, a.currentTime);
    pan.connect(dest || this.buses.ambient);
    this._ambNodes.push(pan);
    return pan;
  };

  // A persistent tonal oscillator for a continuous bed (reefer hum).
  Audio.prototype._ambOsc = function (type, freq, gainVal, dest) {
    var a = this.actx;
    var o = a.createOscillator();
    o.type = type || 'sine';
    o.frequency.value = freq;
    var g = a.createGain();
    g.gain.value = gainVal;
    o.connect(g); g.connect(dest);
    try { o.start(a.currentTime + 0.02); } catch (e) { return null; }
    this._ambNodes.push(o, g);
    return { osc: o, gain: g };
  };

  Audio.prototype._buildHarborAmbience = function () {
    var a = this.actx, bus = this.buses.ambient;
    var i;

    // Thunder gets its own bus. It must NOT be pulled down by the ambience
    // duck that gunfire applies to the wind, because a strike landing during a
    // firefight is the one moment the storm should win.
    if (!this.buses.thunder) {
      var tb = a.createGain();
      tb.gain.value = 0.95;
      tb.connect(this.preMaster);
      var tsend = a.createGain();
      tsend.gain.value = 0.34;
      tb.connect(tsend); tsend.connect(this.reverbIn);
      this.buses.thunder = tb;
      this.busTrim.thunder = 0.95;
      this.busSend.thunder = tsend;
    }

    // ---- layer 1: storm wind, two decorrelated halves ----------------------
    this._windGains = [];
    for (var side = 0; side < 2; side++) {
      var lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520;
      lp.Q.value = 0.55;
      var pan = a.createStereoPanner ? a.createStereoPanner() : null;
      var g = a.createGain();
      g.gain.value = 0.40;
      lp.connect(g);
      if (pan) { pan.pan.value = side ? 0.74 : -0.74; g.connect(pan); pan.connect(bus); this._ambNodes.push(pan); }
      else { g.connect(bus); }
      this._ambNodes.push(lp, g);
      this._loopSource('pink', lp, 1.0);
      // Incommensurate rates: the gusting must never fall into a pattern.
      this._lfo(0.061 + side * 0.023, 300, lp.frequency);
      this._lfo(0.017 + side * 0.008, 170, lp.frequency);
      // Depth stays under the smallest base the weather can drive this to, so
      // the gust never modulates the gain through zero and flips polarity.
      this._lfo(0.047 + side * 0.029, 0.13, g.gain);
      this._windGains.push(g);
    }

    // ---- layer 2: wind IN THE CHAIN-LINK FENCE -----------------------------
    // A wire mesh is a comb of resonators. What you actually hear in a gale is
    // not the wind, it is those resonances being excited and dropped as the
    // gust front moves through - which is why one bandpass sounds like a kazoo
    // and five sound like a fence.
    var fenceIn = a.createGain(); fenceIn.gain.value = 1;
    var fenceOut = a.createGain(); fenceOut.gain.value = 0.30;
    var fencePan = a.createStereoPanner ? a.createStereoPanner() : null;
    if (fencePan) { fencePan.pan.value = 0.35; fenceOut.connect(fencePan); fencePan.connect(bus); this._ambNodes.push(fencePan); }
    else { fenceOut.connect(bus); }
    this._ambNodes.push(fenceIn, fenceOut);
    var fq = [420, 880, 1620, 2950, 4380];
    var fQ = [8, 11, 9, 13, 7];
    var fg = [1.00, 0.80, 0.62, 0.40, 0.24];
    for (i = 0; i < fq.length; i++) {
      var fb = a.createBiquadFilter();
      fb.type = 'bandpass'; fb.frequency.value = fq[i]; fb.Q.value = fQ[i];
      var fgn = a.createGain();
      // Narrowband make-up: a Q=11 band passes ~1/11th of the noise energy.
      fgn.gain.value = fg[i] * NB * 0.085;
      fenceIn.connect(fb); fb.connect(fgn); fgn.connect(fenceOut);
      this._ambNodes.push(fb, fgn);
      this._lfo(0.021 + i * 0.013, fq[i] * 0.035, fb.frequency);
      this._lfo(0.033 + i * 0.017, fg[i] * NB * 0.045, fgn.gain);
    }
    this._loopSource('pink', fenceIn, 1.0);
    this._lfo(0.083, 0.13, fenceOut.gain);
    this._lfo(0.031, 0.08, fenceOut.gain);
    this._fenceGain = fenceOut;

    // ---- layer 3: rigging and crane cables ---------------------------------
    // Vortex shedding off a taut cable: a narrow, drifting whine. Very quiet,
    // but it is the difference between "a storm" and "a storm in a shipyard".
    var rigOut = a.createGain(); rigOut.gain.value = 0.16;
    rigOut.connect(bus);
    this._ambNodes.push(rigOut);
    var rigF = [640, 1490, 2360];
    for (i = 0; i < rigF.length; i++) {
      var rb = a.createBiquadFilter();
      rb.type = 'bandpass'; rb.frequency.value = rigF[i]; rb.Q.value = 24 - i * 4;
      var rg2 = a.createGain(); rg2.gain.value = NB * (0.14 - i * 0.035);
      rb.connect(rg2); rg2.connect(rigOut);
      this._ambNodes.push(rb, rg2);
      this._loopSource('pink', rb, 1.0);
      // The whine slides as the wind speed over the cable changes.
      this._lfo(0.013 + i * 0.007, rigF[i] * 0.13, rb.frequency);
      this._lfo(0.029 + i * 0.011, NB * 0.06, rg2.gain);
    }

    // ---- layer 4: the low roar of the storm --------------------------------
    var rl = a.createBiquadFilter();
    rl.type = 'lowpass'; rl.frequency.value = 175; rl.Q.value = 0.7;
    var rhp = a.createBiquadFilter();
    rhp.type = 'highpass'; rhp.frequency.value = 28;
    var rg = a.createGain(); rg.gain.value = 0.50;
    rl.connect(rhp); rhp.connect(rg); rg.connect(bus);
    this._ambNodes.push(rl, rhp, rg);
    this._loopSource('brown', rl, 1.0);
    this._lfo(0.019, 0.16, rg.gain);
    this._lfo(0.007, 48, rl.frequency);

    // ---- layer 5: water working against the quay ---------------------------
    var quay = this._harborAnchor('quay');
    var qPan = this._ambPanner(quay, 11, 0.85, bus);
    var wl = a.createBiquadFilter();
    wl.type = 'lowpass'; wl.frequency.value = 640; wl.Q.value = 0.8;
    var wg = a.createGain(); wg.gain.value = 0.46;
    wl.connect(wg); wg.connect(qPan);
    this._ambNodes.push(wl, wg);
    this._loopSource('pink', wl, 1.0);
    // Three swell rates that never line up = the irregular set of a chop.
    this._lfo(0.113, 0.20, wg.gain);
    this._lfo(0.191, 0.13, wg.gain);
    this._lfo(0.071, 0.16, wg.gain);
    this._lfo(0.087, 260, wl.frequency);
    // Fizz: entrained air coming back out of the water after each slap.
    var wf = a.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 2600; wf.Q.value = 0.8;
    var wfg = a.createGain(); wfg.gain.value = 0.055;
    wf.connect(wfg); wfg.connect(qPan);
    this._ambNodes.push(wf, wfg);
    this._loopSource('rainFine', wf, 1.0, 0.8);
    this._lfo(0.137, 0.035, wfg.gain);

    // ---- layer 6: the reefer stack -----------------------------------------
    // The only TONAL source in the level. Refrigeration units run off mains,
    // so the hum is at twice line frequency and its harmonics, not at some
    // arbitrary pitch - and two units running slightly out of step beat
    // against each other. Tight rolloff so it is a local landmark you can
    // navigate by, not a wash over the whole terminal.
    var reef = this._harborAnchor('reefer');
    var rPan = this._ambPanner(reef, 4.5, 1.35, bus);
    var reefGain = a.createGain(); reefGain.gain.value = 0.80;
    reefGain.connect(rPan);
    this._ambNodes.push(reefGain);
    this._reefer = { gain: reefGain, pan: rPan };
    this._ambOsc('sine', 100.0, 0.42, reefGain);
    this._ambOsc('sine', 100.31, 0.30, reefGain);   // second unit, beating
    this._ambOsc('sine', 200.0, 0.20, reefGain);
    this._ambOsc('triangle', 300.0, 0.085, reefGain);
    this._ambOsc('sine', 400.6, 0.038, reefGain);
    // Compressor whine and the condenser fan.
    var cw = this._ambOsc('triangle', 1183, 0.020, reefGain);
    if (cw) this._lfo(0.09, 6, cw.osc.frequency);
    var fanBp = a.createBiquadFilter();
    fanBp.type = 'bandpass'; fanBp.frequency.value = 720; fanBp.Q.value = 1.1;
    var fanG = a.createGain(); fanG.gain.value = 0.14;
    fanBp.connect(fanG); fanG.connect(reefGain);
    this._ambNodes.push(fanBp, fanG);
    this._loopSource('pink', fanBp, 1.0);
    this._lfo(0.011, 0.10, reefGain.gain);

    // ---- layer 7: the rain itself, and the thunder channel -----------------
    this._buildRain();
    this._buildThunderChain();
  };

  // --------------------------------------------------------------------------
  // RAIN BED
  //
  // Six layers on their own path to the master. Rain is not one sound: it is
  // the sheet of drops still in the air (fine, bright, continuous), the drops
  // landing near you (mid-band, individually resolvable), what they land ON
  // (hard bright ticks off steel, a dull wash off concrete and water), and the
  // low roar of the whole downpour. The surface-dependent layers are driven by
  // what the level actually reports around the player, so walking from the
  // apron into the container canyon audibly changes the rain.
  // --------------------------------------------------------------------------
  Audio.prototype._buildRain = function () {
    var a = this.actx;
    if (!this.buffers.rainPatter || !this.buffers.rainFine) return;

    // Own path to preMaster rather than the ambient bus: rain must duck only
    // slightly under gunfire (the wind ducks hard), and the overhead-occlusion
    // lowpass must not touch anything else in the mix.
    var out = a.createGain(); out.gain.value = 0.0001;
    var lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.value = 19000;
    var send = a.createGain(); send.gain.value = 0.10;
    out.connect(lp);
    lp.connect(this.preMaster);
    lp.connect(send); send.connect(this.reverbIn);
    this._ambNodes.push(out, lp, send);

    var R = this._rain = { out: out, lp: lp, layers: {} };
    var self = this;

    function layer(name, gainVal) {
      var g = a.createGain();
      g.gain.value = gainVal;
      g.connect(out);
      self._ambNodes.push(g);
      R.layers[name] = g;
      return g;
    }

    // 1. the sheet in the air - fine, bright, wide.
    for (var side = 0; side < 2; side++) {
      var sg = a.createGain(); sg.gain.value = 0.30;
      var sp = a.createStereoPanner ? a.createStereoPanner() : null;
      var shp = a.createBiquadFilter();
      shp.type = 'highpass'; shp.frequency.value = 2400; shp.Q.value = 0.5;
      shp.connect(sg);
      if (sp) { sp.pan.value = side ? 0.8 : -0.8; sg.connect(sp); sp.connect(out); this._ambNodes.push(sp); }
      else { sg.connect(out); }
      this._ambNodes.push(shp, sg);
      this._loopSource('rainFine', shp, 1.0, side ? 1.07 : 0.94);
      this._lfo(0.053 + side * 0.019, 0.07, sg.gain);
      this._lfo(0.029 + side * 0.013, 520, shp.frequency);
    }

    // 2. the patter - individual drops landing within a few metres of you.
    var pg = layer('patter', 0.44);
    var pbp = a.createBiquadFilter();
    pbp.type = 'bandpass'; pbp.frequency.value = 1450; pbp.Q.value = 0.85;
    pbp.connect(pg);
    this._ambNodes.push(pbp);
    this._loopSource('rainPatter', pbp, 1.0);
    this._lfo(0.037, 0.09, pg.gain);
    this._lfo(0.023, 380, pbp.frequency);

    // 3. rain on STEEL - harder, brighter, with real transient edges. Rides up
    //    when the probe finds container flanks or a metal roof nearby.
    var mg = layer('metal', 0.10);
    var mhp = a.createBiquadFilter();
    mhp.type = 'highpass'; mhp.frequency.value = 3400; mhp.Q.value = 0.6;
    var mpk = a.createBiquadFilter();
    mpk.type = 'peaking'; mpk.frequency.value = 5600; mpk.Q.value = 1.3; mpk.gain.value = 7;
    mhp.connect(mpk); mpk.connect(mg);
    this._ambNodes.push(mhp, mpk);
    // Sped up: shorter, snappier impacts than the same drops on concrete.
    this._loopSource('rainPatter', mhp, 1.0, 1.45);
    this._lfo(0.041, 0.03, mg.gain);

    // 4. rain on WATER and CONCRETE - duller, no edge, more wash.
    var dg = layer('dull', 0.30);
    var dlp = a.createBiquadFilter();
    dlp.type = 'lowpass'; dlp.frequency.value = 880; dlp.Q.value = 0.7;
    dlp.connect(dg);
    this._ambNodes.push(dlp);
    this._loopSource('rainPatter', dlp, 1.0, 0.72);
    this._lfo(0.031, 0.07, dg.gain);
    this._lfo(0.017, 190, dlp.frequency);

    // 5. rain DRUMMING ON A ROOF overhead - silent until you are under one.
    //    No LFO on this gain: its base is driven to near zero when you are in
    //    the open, and a modulator around zero would leak the layer out.
    var rg = layer('roof', 0.0001);
    var rbp = a.createBiquadFilter();
    rbp.type = 'bandpass'; rbp.frequency.value = 340; rbp.Q.value = 1.5;
    var rlp = a.createBiquadFilter();
    rlp.type = 'lowpass'; rlp.frequency.value = 1600; rlp.Q.value = 0.6;
    rbp.connect(rlp); rlp.connect(rg);
    this._ambNodes.push(rbp, rlp);
    this._loopSource('rainPatter', rbp, 1.0, 0.88);
    this._lfo(0.047, 55, rbp.frequency);

    // 6. the roar of the whole downpour.
    var og = layer('roar', 0.18);
    var olp = a.createBiquadFilter();
    olp.type = 'lowpass'; olp.frequency.value = 215; olp.Q.value = 0.7;
    var ohp = a.createBiquadFilter();
    ohp.type = 'highpass'; ohp.frequency.value = 30;
    olp.connect(ohp); ohp.connect(og);
    this._ambNodes.push(olp, ohp);
    this._loopSource('brown', olp, 1.0);
    this._lfo(0.013, 0.05, og.gain);
  };

  // --------------------------------------------------------------------------
  // THUNDER
  //
  // The rumble is generated by pushing a noise excitation through a long
  // generated impulse response (see _makeThunderIR) with irregular amplitude
  // swells, so it rolls instead of decaying smoothly. Close strikes add direct,
  // unconvolved layers in front of it: a sub-millisecond crack, a tearing rip,
  // and a sub. Distant ones get no transient at all - all that survives four
  // kilometres of air is the low end.
  // --------------------------------------------------------------------------
  Audio.prototype._buildThunderChain = function () {
    var a = this.actx;
    if (!this._thunderIRs.length) return;
    var dest = this.buses.thunder || this.preMaster;
    for (var i = 0; i < this._thunderIRs.length; i++) {
      var conv = a.createConvolver();
      conv.normalize = false;
      try { conv.buffer = this._thunderIRs[i]; }
      catch (e) { continue; }
      var inG = a.createGain(); inG.gain.value = 1;
      var outG = a.createGain(); outG.gain.value = 1;
      var pan = a.createStereoPanner ? a.createStereoPanner() : null;
      inG.connect(conv); conv.connect(outG);
      if (pan) { outG.connect(pan); pan.connect(dest); this._ambNodes.push(pan); }
      else { outG.connect(dest); }
      this._ambNodes.push(inG, conv, outG);
      this._thunderConv.push({
        inp: inG, out: outG, pan: pan, free: 0,
        dur: this._thunderIRs[i].duration
      });
    }
  };

  // Public: queue thunder for a strike. weather.js drives this through the
  // lightning event, but scenarios or a debug key may call it directly.
  //   opts: {distance (m) | km, delay (s, overrides propagation), flash 0..1}
  Audio.prototype.thunder = function (opts) {
    if (!this.armed) return;
    try {
      opts = opts || EMPTY;
      var dist = opts.distance;
      if (typeof opts.km === 'number' && opts.km > 0) dist = opts.km * 1000;
      if (typeof dist !== 'number' || !(dist > 0)) {
        var w = this.ctx && this.ctx.weather;
        var flash = opts.flash;
        if (typeof flash !== 'number') {
          flash = (w && typeof w.flash === 'number') ? w.flash : 0;
        }
        // A bright flash is a close strike. Deriving distance from the flash
        // keeps the ear and the eye telling the same story about the storm.
        dist = M.lerp(4400, 280, M.saturate(flash)) * this.rng.range(0.75, 1.30);
      }
      dist = M.clamp(dist, 60, 12000);
      var delay = (typeof opts.delay === 'number') ? opts.delay : dist / SPEED_OF_SOUND;
      if (this._thunderQueue.length >= 5) return;
      this._thunderQueue.push({ at: this.actx.currentTime + Math.max(0, delay), dist: dist });
    } catch (e) {
      GAME.logError('audio.thunder', e);
    }
  };

  Audio.prototype._onLightning = function (payload) {
    if (!this.armed || !this._harbor) return;
    try {
      var now = this.actx.currentTime;
      // weather.js may emit an event AND raise weather.flash; both routes land
      // here, so collapse anything within a third of a second into one strike.
      if (now - this._lastStrike < 0.33) return;
      this._lastStrike = now;
      var o = (payload && typeof payload === 'object') ? payload : EMPTY;
      var f = (typeof o.flash === 'number') ? o.flash
            : (typeof o.intensity === 'number') ? o.intensity
            : (typeof o.strength === 'number') ? o.strength : undefined;
      this.thunder({
        distance: o.distance || o.dist || 0,
        km: o.km || 0,
        flash: f
      });
    } catch (e) {
      GAME.logError('audio.lightning', e);
    }
  };

  Audio.prototype._fireThunder = function (dist) {
    if (!this.armed) return;
    var a = this.actx, rng = this.rng;
    var km = M.clamp(dist / 1000, 0.05, 12);
    // far: 0 = overhead, 1 = the far side of the storm.
    var far = M.saturate((km - 0.30) / 4.2);
    var close = 1 - far;
    var lvl = M.clamp(1.30 - km * 0.085, 0.34, 1.30);

    // Where it came from, so the roll is not dead centre.
    var panv = 0;
    try {
      var w = this.ctx && this.ctx.weather;
      var d = w && w.flashDir;
      var cam = this.ctx && this.ctx.camera;
      if (d && cam && cam.matrixWorld) {
        var e = cam.matrixWorld.elements;
        panv = M.clamp(-(d.x * e[0] + d.y * e[1] + d.z * e[2]), -0.85, 0.85);
      }
    } catch (e2) { panv = 0; }
    if (panv === 0) panv = rng.range(-0.6, 0.6);

    var t0 = a.currentTime + LOOKAHEAD;

    // ---- the roll: excitation through the generated thunder IR -------------
    var chain = null, oldest = null;
    for (var i = 0; i < this._thunderConv.length; i++) {
      var c = this._thunderConv[(this._thunderIdx + i) % this._thunderConv.length];
      if (!oldest || c.free < oldest.free) oldest = c;
      if (c.free <= a.currentTime) { chain = c; break; }
    }
    if (!chain) chain = oldest;
    if (chain) {
      this._thunderIdx = (this._thunderIdx + 1) % this._thunderConv.length;
      var rec = this._pending.acquire();
      // A far strike is excited by a long, dark, soft push; a close one by a
      // short bright slap. Same IR, completely different character.
      var exDur = M.lerp(0.085, 0.60, far);
      var src = a.createBufferSource();
      src.buffer = (far > 0.45 ? this.buffers.brown : this.buffers.white) || this.buffers.white;
      if (src.buffer) {
        src.playbackRate.value = rng.range(0.85, 1.15);
        var f = a.createBiquadFilter();
        f.type = 'lowpass'; f.Q.value = 0.6;
        f.frequency.setValueAtTime(M.lerp(5400, 430, far), t0);
        f.frequency.exponentialRampToValueAtTime(M.lerp(1100, 145, far), t0 + exDur + 0.05);
        var hp = a.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 24;
        var g = a.createGain(); g.gain.value = 0;
        src.connect(f); f.connect(hp); hp.connect(g); g.connect(chain.inp);
        envAHD(g.gain, t0, 1.0, M.lerp(0.0015, 0.19, far), exDur * 0.30, exDur * 0.75);
        var maxOff = Math.max(0, src.buffer.duration - exDur - 0.4);
        try { src.start(t0, maxOff > 0 ? rng.range(0, maxOff) : 0); } catch (e3) { /* ignore */ }
        try { src.stop(t0 + exDur + 0.35); } catch (e4) { /* ignore */ }
        rec.nodes.push(src, f, hp, g);
      }
      var oT = a.currentTime;
      chain.out.gain.cancelScheduledValues(oT);
      chain.out.gain.setValueAtTime(lvl * M.lerp(0.85, 1.25, far), oT);
      if (chain.pan) chain.pan.pan.setValueAtTime(panv * 0.7, oT);
      chain.free = t0 + chain.dur + 0.25;
      rec.t = t0 + exDur + 0.6;
      if (this._pending.active.length > MAX_PENDING) this._reapOldest(24);
    }

    // ---- direct layers -----------------------------------------------------
    var h = this._open('thunder', {
      volume: lvl, send: 0.40 + far * 0.25, slap: 0.30 + close * 0.35
    });
    if (h) {
      var t = h.t0, end = t;
      if (close > 0.22) {
        // The crack. Sub-millisecond attack, and gone almost immediately -
        // everything after it is the channel, not the source.
        end = Math.max(end, this._burst(h, {
          t: t, type: 'highpass', f0: 3200 * rng.range(0.9, 1.15), q: 0.7,
          g: 1.15 * close, atk: 0.0004, dec: 0.055 * rng.range(0.8, 1.3)
        }));
        end = Math.max(end, this._burst(h, {
          t: t + 0.0006, type: 'highpass', f0: 8200, q: 0.6,
          g: 0.55 * close * close, atk: 0.0003, dec: 0.014
        }));
        // The rip: the discharge channel tearing open, sweeping down and
        // stuttering as different segments arrive microseconds apart.
        var ripDur = rng.range(0.28, 0.55);
        var rs = this._src(h, 'white', t + 0.004, ripDur + 0.05, rng.range(0.9, 1.1));
        if (rs) {
          var rbp = this._filter(h, 'bandpass', 5200, 1.1);
          var rgn = this._gain(h, 0);
          rs.connect(rbp); rbp.connect(rgn); rgn.connect(h.dest);
          rbp.frequency.setValueAtTime(5200 * rng.range(0.85, 1.2), t + 0.004);
          rbp.frequency.exponentialRampToValueAtTime(620, t + 0.004 + ripDur);
          var tt = t + 0.004, amp = 0.95 * close;
          rgn.gain.setValueAtTime(FLOOR, tt);
          while (tt < t + 0.004 + ripDur) {
            var seg = rng.range(0.012, 0.055);
            rgn.gain.linearRampToValueAtTime(
              Math.max(FLOOR * 2, amp * rng.range(0.25, 1.0)), tt + seg * 0.45);
            rgn.gain.linearRampToValueAtTime(
              Math.max(FLOOR * 2, amp * rng.range(0.06, 0.55)), tt + seg);
            tt += seg;
            amp *= 0.90;
          }
          rgn.gain.exponentialRampToValueAtTime(FLOOR, tt + 0.12);
          rgn.gain.setValueAtTime(0, tt + 0.14);
          end = Math.max(end, tt + 0.16);
        }
      }
      // The sub. Present at every distance - it is the only part of a strike
      // eight kilometres away that still reaches you.
      end = Math.max(end, this._tone(h, {
        t: t + M.lerp(0.004, 0.09, far), type: 'sine',
        f0: M.lerp(62, 33, far) * rng.range(0.92, 1.10),
        f1: M.lerp(27, 19, far),
        glide: M.lerp(0.6, 1.9, far), g: M.lerp(1.05, 0.75, far),
        atk: M.lerp(0.006, 0.22, far), dec: M.lerp(0.95, 2.6, far),
        drive: 0.6
      }));
      h.end = end;
      this._close(h, 0.2);
    }

    // A strike displaces the whole mix for a moment.
    this._duck = Math.min(1, Math.max(this._duck, 0.20 + close * 0.55));
  };

  // --------------------------------------------------------------------------
  // Harbor one-shots
  // --------------------------------------------------------------------------

  // Jittered point near a named anchor.
  Audio.prototype._nearAnchor = function (key, spread, ySpread) {
    var p = this._harborAnchor(key), r = this.rng;
    return {
      x: p.x + r.range(-spread, spread),
      y: p.y + r.range(-(ySpread || 0), ySpread || 0),
      z: p.z + r.range(-spread, spread)
    };
  };

  // Water slapping the quay wall: a broadband surge, a hollow thump as the
  // trapped air under the coping is compressed, then the fizz of it escaping.
  Audio.prototype._ambWaterSlap = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('quay', 9, 0.6),
      volume: r.range(0.45, 0.95), refDistance: 9, rolloff: 1.1,
      send: 0.35, slap: 0.12, occlude: false
    });
    if (!h) return;
    var t = h.t0, end = t;
    end = Math.max(end, this._burst(h, {
      t: t, type: 'lowpass', f0: r.range(1400, 2400), f1: r.range(280, 460),
      q: 0.7, g: 0.85, atk: r.range(0.010, 0.035), dec: r.range(0.22, 0.48),
      sweepDur: 0.3, rate: r.range(0.85, 1.15)
    }));
    end = Math.max(end, this._tone(h, {
      t: t + 0.008, type: 'sine', f0: r.range(78, 140), f1: r.range(40, 62),
      glide: 0.12, g: 0.38, atk: 0.008, dec: r.range(0.16, 0.30)
    }));
    end = Math.max(end, this._grains(h, {
      t: t + r.range(0.04, 0.10), count: 9 + r.int(0, 7), span: r.range(0.3, 0.7),
      fLo: 2400, fHi: 9500, g: 0.22, q: 2.0
    }));
    h.end = end;
    this._close(h, 0.1);
  };

  // The freighter working against her fenders. Steel plate under load: a very
  // low stick-slip groan with a sub under it, nothing like the market's tin.
  Audio.prototype._ambHullGroan = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('hull', 7, 3),
      volume: r.range(0.4, 0.85), refDistance: 14, rolloff: 0.8,
      send: 0.5, slap: 0.30, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    var dur = r.range(1.3, 3.4);
    var f = r.range(38, 88);
    var o = this._osc(h, 'sawtooth', t, dur + 0.28);
    var end = t + dur + 0.2;
    if (o) {
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * r.range(1.15, 1.75), t + dur * 0.62);
      o.frequency.linearRampToValueAtTime(f * r.range(0.75, 1.02), t + dur);
      var bp = this._filter(h, 'bandpass', r.range(190, 460), 16);
      var g = this._gain(h, 0);
      o.connect(bp); bp.connect(g); g.connect(h.dest);
      // Stick-slip: the plate grips, releases, grips again. Without the
      // stutter this is a foghorn, not a groan.
      g.gain.setValueAtTime(FLOOR, t);
      var tt = t, amp = 0.34 * NB * 0.55;
      while (tt < t + dur) {
        var seg = r.range(0.03, 0.14);
        g.gain.linearRampToValueAtTime(Math.max(FLOOR * 2, amp * r.range(0.18, 1.0)), tt + seg * 0.5);
        g.gain.linearRampToValueAtTime(Math.max(FLOOR * 2, amp * r.range(0.05, 0.55)), tt + seg);
        tt += seg;
      }
      g.gain.exponentialRampToValueAtTime(FLOOR, t + dur + 0.12);
      g.gain.setValueAtTime(0, t + dur + 0.15);
    }
    // Mass. A 20,000 tonne hull moving is felt before it is heard.
    end = Math.max(end, this._tone(h, {
      t: t + r.range(0, 0.3), type: 'sine', f0: r.range(34, 52), f1: r.range(24, 33),
      glide: dur * 0.7, g: 0.42, atk: 0.25, dec: dur * 0.8
    }));
    if (r.bool(0.45)) {
      // A plate letting go with a bang somewhere down the hull.
      end = Math.max(end, this._partials(h, {
        t: t + dur * r.range(0.4, 0.9), partials: [118, 268, 545, 980, 1760],
        dec: 0.9, g: 0.22, pitch: r.range(0.9, 1.15)
      }));
    }
    h.end = end;
    this._close(h, 0.2);
  };

  // Mooring rope under load. Polyester hawser stretching: a fibrous creak that
  // rises in pitch as it takes the strain, punctuated by fibres letting go.
  Audio.prototype._ambRopeStrain = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('quay', 6, 1.2),
      volume: r.range(0.3, 0.6), refDistance: 7, rolloff: 1.2,
      send: 0.30, slap: 0.12, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    var dur = r.range(0.8, 2.1);
    var f0 = r.range(320, 620);
    var s = this._src(h, 'white', t, dur + 0.06, r.range(0.9, 1.1));
    var end = t + dur + 0.2;
    if (s) {
      var bp = this._filter(h, 'bandpass', f0, 20);
      var bp2 = this._filter(h, 'bandpass', f0 * 2.4, 14);
      var g = this._gain(h, 0);
      s.connect(bp); bp.connect(g);
      s.connect(bp2); bp2.connect(g);
      g.connect(h.dest);
      bp.frequency.setValueAtTime(f0, t);
      bp.frequency.exponentialRampToValueAtTime(f0 * r.range(1.3, 2.0), t + dur);
      bp2.frequency.setValueAtTime(f0 * 2.4, t);
      bp2.frequency.exponentialRampToValueAtTime(f0 * 2.4 * r.range(1.25, 1.9), t + dur);
      g.gain.setValueAtTime(FLOOR, t);
      var tt = t, amp = 0.30 * NB * 0.42;
      while (tt < t + dur) {
        var seg = r.range(0.012, 0.06);
        g.gain.linearRampToValueAtTime(Math.max(FLOOR * 2, amp * r.range(0.1, 1.0)), tt + seg * 0.45);
        g.gain.linearRampToValueAtTime(Math.max(FLOOR * 2, amp * r.range(0.03, 0.5)), tt + seg);
        tt += seg;
      }
      g.gain.exponentialRampToValueAtTime(FLOOR, t + dur + 0.06);
      g.gain.setValueAtTime(0, t + dur + 0.09);
    }
    // Individual fibres going.
    end = Math.max(end, this._grains(h, {
      t: t + dur * 0.35, count: 2 + r.int(0, 3), span: dur * 0.6,
      fLo: 900, fHi: 3600, g: 0.14, q: 4
    }));
    h.end = end;
    this._close(h, 0.1);
  };

  // A ship's horn out in the channel. Two detuned low reeds through a
  // resonant horn body, slow attack, very long tail, and a second short blast
  // on maybe a third of them. Deliberately irregular interval.
  Audio.prototype._ambFoghorn = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('horn', 22, 3),
      volume: r.range(0.55, 0.95), refDistance: 60, rolloff: 0.35,
      send: 0.70, slap: 0.45, occlude: false
    });
    if (!h) return;
    var base = r.range(58, 82);
    var blasts = r.bool(0.34) ? 2 : 1;
    var t = h.t0, end = t;
    for (var b = 0; b < blasts; b++) {
      var dur = b === 0 ? r.range(2.6, 4.8) : r.range(0.9, 1.6);
      var body = this._gain(h, 1);
      var lp = this._filter(h, 'lowpass', r.range(520, 820), 1.4);
      var pk = this._filter(h, 'peaking', base * 3, 2.0);
      pk.gain.value = 6;
      body.connect(pk); pk.connect(lp);
      var og = this._gain(h, 0);
      lp.connect(og); og.connect(h.dest);
      // Two reeds a few cents apart give the horn its characteristic beat.
      var f = [base, base * r.range(1.006, 1.016), base * 1.5];
      var amps = [0.55, 0.42, 0.14];
      // The oscillators must outlive the envelope or the long tail - the whole
      // point of a foghorn - gets cut off mid-decay.
      var oscDur = dur * 1.4 + 1.35;
      for (var i = 0; i < f.length; i++) {
        var o = this._osc(h, i === 2 ? 'triangle' : 'sawtooth', t, oscDur);
        if (!o) continue;
        o.frequency.setValueAtTime(f[i] * 0.985, t);
        o.frequency.linearRampToValueAtTime(f[i], t + 0.22);
        o.frequency.linearRampToValueAtTime(f[i] * 0.988, t + dur + 0.5);
        var ag = this._gain(h, amps[i]);
        o.connect(ag); ag.connect(body);
      }
      // Air noise through the horn throat. Capped to the white buffer's own
      // length - _src does not loop, so asking for more yields silence.
      var nz = this._src(h, 'white', t, 2.2, 1);
      if (nz) {
        var nbp = this._filter(h, 'bandpass', r.range(700, 1300), 1.6);
        var ng = this._gain(h, 0.05);
        nz.connect(nbp); nbp.connect(ng); ng.connect(body);
      }
      end = Math.max(end, envAHD(og.gain, t, 0.95, 0.22, dur, dur * 0.28 + 0.75));
      t += dur + r.range(0.55, 1.1);
    }
    h.end = end;
    this._close(h, 0.4);
  };

  // Harbour gulls. Harsh, not pretty: a rasping glottal source through a
  // wide-open tract, falling in pitch, two to five cries.
  Audio.prototype._ambGulls = function () {
    var r = this.rng;
    var p = this._ambPoint(12, 45, 4, 16);
    var h = this._open('ambient', {
      position: p, volume: r.range(0.25, 0.55), refDistance: 18, rolloff: 0.9,
      send: 0.45, slap: 0.20, occlude: false
    });
    if (!h) return;
    var t = h.t0, end = t;
    var n = 2 + r.int(0, 3);
    var base = r.range(680, 1150);
    for (var i = 0; i < n; i++) {
      var dur = r.range(0.16, 0.34);
      var f = base * r.range(0.88, 1.14);
      var o = this._osc(h, 'sawtooth', t, dur + 0.04);
      var mix = this._gain(h, 1);
      if (o) {
        o.frequency.setValueAtTime(f * 1.28, t);
        o.frequency.exponentialRampToValueAtTime(f, t + dur * 0.22);
        o.frequency.exponentialRampToValueAtTime(f * 0.66, t + dur);
        var og = this._gain(h, 0.8);
        o.connect(og); og.connect(mix);
      }
      var nz = this._src(h, 'white', t, dur + 0.04, 1);
      if (nz) {
        var ng = this._gain(h, 0.34);
        nz.connect(ng); ng.connect(mix);
      }
      var out = this._gain(h, 0);
      var fr = [900, 2100, 3400];
      for (var k = 0; k < 3; k++) {
        var bp = this._filter(h, 'bandpass', fr[k] * r.range(0.9, 1.12), 7);
        var ag = this._gain(h, [1, 0.55, 0.25][k]);
        mix.connect(bp); bp.connect(ag); ag.connect(out);
      }
      out.connect(h.dest);
      end = Math.max(end, envAHD(out.gain, t, 0.85, 0.012, dur * 0.30, dur * 0.65));
      t += r.range(0.20, 0.48);
    }
    h.end = end;
    this._close(h);
  };

  // Water running off a container lip and hitting a puddle. The signature
  // "plink" is a pitch that RISES as the cavity the drop punched closes.
  Audio.prototype._ambDrip = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._ambPoint(1.6, 9, -1.2, 2.4),
      volume: r.range(0.25, 0.6), refDistance: 3.5, rolloff: 1.5,
      send: 0.28, slap: 0.10, occlude: false
    });
    if (!h) return;
    var t = h.t0, end = t;
    var n = 2 + r.int(0, 4);
    for (var i = 0; i < n; i++) {
      var f = r.range(680, 2400);
      end = Math.max(end, this._tone(h, {
        t: t, type: 'sine', f0: f * 0.62, f1: f, glide: r.range(0.014, 0.032),
        g: r.range(0.22, 0.48), atk: 0.0008, dec: r.range(0.030, 0.075)
      }));
      end = Math.max(end, this._burst(h, {
        t: t, type: 'bandpass', f0: f * 2.4, q: 4, g: 0.10,
        atk: 0.0004, dec: 0.008
      }));
      t += r.range(0.14, 0.62);
    }
    h.end = end;
    this._close(h);
  };

  // Chain-link slapping its posts in a gust front.
  Audio.prototype._ambFenceRattle = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('fence', 12, 1.5),
      volume: r.range(0.22, 0.5), refDistance: 9, rolloff: 1.1,
      send: 0.30, slap: 0.14, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    var e1 = this._grains(h, {
      t: t, count: 14 + r.int(0, 10), span: r.range(0.5, 1.3),
      fLo: 2200, fHi: 9000, g: 0.26, q: 5
    });
    var e2 = this._burst(h, {
      t: t, type: 'bandpass', f0: r.range(2400, 4200), f1: r.range(1200, 2000),
      q: 1.0, g: 0.16, atk: 0.09, dec: r.range(0.5, 1.1), sweepDur: 0.7
    });
    var e3 = this._partials(h, {
      t: t + r.range(0.05, 0.4), partials: [780, 1690, 3120], dec: 0.22,
      g: 0.09, pitch: r.range(0.9, 1.2)
    });
    h.end = Math.max(e1, e2, e3);
    this._close(h, 0.1);
  };

  // Something big and diesel working at the far end of the terminal, with the
  // irregular clank of a container being landed.
  Audio.prototype._ambMachinery = function () {
    var r = this.rng;
    var h = this._open('ambient', {
      position: this._nearAnchor('machinery', 14, 3),
      volume: r.range(0.30, 0.62), refDistance: 34, rolloff: 0.45,
      send: 0.45, slap: 0.25, occlude: false
    });
    if (!h) return;
    var t = h.t0;
    // Capped under the brown buffer's 7s so the drone does not run off the
    // end of its own source before the envelope has finished.
    var dur = r.range(3.5, 6.4);
    var end = t + dur + 0.2;
    var s = this._src(h, 'brown', t, dur + 0.1, r.range(0.8, 1.2));
    if (s) {
      var lp = this._filter(h, 'lowpass', 260, 0.9);
      var g = this._gain(h, 0);
      s.connect(lp); lp.connect(g); g.connect(h.dest);
      lp.frequency.setValueAtTime(150, t);
      lp.frequency.linearRampToValueAtTime(r.range(320, 520), t + dur * 0.45);
      lp.frequency.linearRampToValueAtTime(140, t + dur);
      g.gain.setValueAtTime(FLOOR, t);
      g.gain.linearRampToValueAtTime(1.0, t + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
      g.gain.setValueAtTime(0, t + dur + 0.02);
    }
    // Engine order under it.
    var o = this._osc(h, 'sawtooth', t, dur + 0.05);
    if (o) {
      var f = r.range(38, 62);
      o.frequency.setValueAtTime(f, t);
      o.frequency.linearRampToValueAtTime(f * r.range(1.2, 1.5), t + dur * 0.45);
      o.frequency.linearRampToValueAtTime(f * 0.88, t + dur);
      var olp = this._filter(h, 'lowpass', 220, 1.3);
      var og = this._gain(h, 0);
      o.connect(olp); olp.connect(og); og.connect(h.dest);
      og.gain.setValueAtTime(FLOOR, t);
      og.gain.linearRampToValueAtTime(0.20, t + dur * 0.45);
      og.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
      og.gain.setValueAtTime(0, t + dur + 0.02);
    }
    // Twistlocks and steel landing on steel.
    var clanks = 1 + r.int(0, 3);
    var ct = t + r.range(0.4, 1.4);
    for (var i = 0; i < clanks; i++) {
      end = Math.max(end, this._partials(h, {
        t: ct, partials: [162, 388, 740, 1420, 2610], dec: r.range(0.5, 1.1),
        g: r.range(0.14, 0.26), pitch: r.range(0.88, 1.18)
      }));
      end = Math.max(end, this._burst(h, {
        t: ct, type: 'lowpass', f0: 1800, f1: 420, q: 1.0,
        g: 0.22, atk: 0.001, dec: 0.09
      }));
      ct += r.range(0.5, 1.8);
    }
    h.end = end;
    this._close(h, 0.2);
  };

  // A strike far enough away that there is no flash to see - just the storm
  // grumbling somewhere over the water.
  Audio.prototype._ambDistantThunder = function () {
    var w = this.ctx && this.ctx.weather;
    // Only in real weather. In a drizzle or a clear preset this would be a lie.
    if (w && typeof w.rainIntensity === 'number' && w.rainIntensity < 0.25) return;
    this._fireThunder(this.rng.range(6200, 11500));
  };

  // The reefer compressor cycling. A relay clunk, then the hum swells back up.
  Audio.prototype._ambReeferCycle = function () {
    var r = this.rng;
    var R = this._reefer;
    var h = this._open('ambient', {
      position: this._harborAnchor('reefer'),
      volume: r.range(0.3, 0.55), refDistance: 5, rolloff: 1.4,
      send: 0.22, slap: 0.10, occlude: false
    });
    if (h) {
      var t = h.t0;
      var e1 = this._burst(h, {
        t: t, type: 'bandpass', f0: r.range(1600, 2600), q: 4.5,
        g: 0.42, atk: 0.0005, dec: 0.022
      });
      var e2 = this._partials(h, {
        t: t, partials: [242, 590, 1180], dec: 0.16, g: 0.20, pitch: r.range(0.9, 1.1)
      });
      var e3 = this._burst(h, {
        t: t + 0.02, type: 'lowpass', f0: 900, f1: 260, q: 0.9,
        g: 0.24, atk: 0.002, dec: 0.10
      });
      h.end = Math.max(e1, e2, e3);
      this._close(h);
    }
    if (R && R.gain) {
      // The unit loads up: hum dips as the motor starts, then settles louder.
      var a = this.actx, tt = a.currentTime;
      R.gain.gain.cancelScheduledValues(tt);
      R.gain.gain.setValueAtTime(R.gain.gain.value, tt);
      R.gain.gain.linearRampToValueAtTime(0.42, tt + 0.20);
      R.gain.gain.linearRampToValueAtTime(r.range(0.72, 1.0), tt + r.range(2.0, 4.5));
    }
  };

  // --------------------------------------------------------------------------
  // Harbor per-frame mix: rain level, surface colour, overhead occlusion.
  // --------------------------------------------------------------------------
  Audio.prototype._harborProbe = function () {
    var lvl = this.ctx && this.ctx.level;
    if (!lvl || !lvl.raycast) { this._coverTarget = 0; return; }
    var o = this._listener;
    var org = { x: o.x, y: o.y, z: o.z };
    var metal = 0, dull = 0, n = 0, cov = 0;
    try {
      // Straight up: are we under the warehouse roof or a container overhang?
      var up = lvl.raycast(org, { x: 0, y: 1, z: 0 }, 14);
      if (up && up.hit) {
        cov = 1;
        var um = up.material ? String(up.material).toLowerCase() : '';
        // A steel roof does not just block the rain, it AMPLIFIES it.
        if (RAIN_METAL[um]) { metal += RAIN_METAL[um] * 2.0; n += 2; }
        else { dull += 0.8; n += 1; }
      }
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < 4; i++) {
        var r = lvl.raycast(org, { x: dirs[i][0], y: 0, z: dirs[i][1] }, 7);
        if (r && r.hit) {
          var mm = r.material ? String(r.material).toLowerCase() : '';
          var w = 1 - M.saturate((r.distance || 0) / 9);
          if (RAIN_METAL[mm]) metal += RAIN_METAL[mm] * w;
          else if (RAIN_DULL[mm] !== undefined) dull += RAIN_DULL[mm] * w;
          else dull += 0.5 * w;
          n++;
        }
      }
      // Whatever is underfoot is always contributing.
      var dn = lvl.raycast(org, { x: 0, y: -1, z: 0 }, 4);
      if (dn && dn.hit) {
        var dm = dn.material ? String(dn.material).toLowerCase() : '';
        if (RAIN_METAL[dm]) metal += RAIN_METAL[dm];
        else dull += (RAIN_DULL[dm] !== undefined ? RAIN_DULL[dm] : 0.8);
        n++;
      }
    } catch (e) { return; }      // level still building - keep the last read
    var inv = 1 / Math.max(2, n);
    this._metalNear = M.saturate(metal * inv * 1.7);
    this._dullNear = M.saturate(0.30 + dull * inv * 1.3);
    this._coverTarget = cov;
  };

  Audio.prototype._updateHarborMix = function (dt) {
    var a = this.actx, t = a.currentTime;
    var w = this.ctx && this.ctx.weather;
    var intensity = (w && typeof w.rainIntensity === 'number')
      ? M.saturate(w.rainIntensity) : 0.85;
    var windSpeed = (w && typeof w.windSpeed === 'number') ? w.windSpeed : 12;

    if (this._coverTarget === undefined) this._coverTarget = 0;
    this._covered += (this._coverTarget - this._covered) * Math.min(1, dt * 3.0);
    this._rainLevel = intensity;

    var R = this._rain;
    if (R) {
      // Loudness of rain is not linear in drop count.
      var lvl = Math.pow(intensity, 0.75) * 0.70;
      lvl *= (1 - this._duck * 0.25);              // ducks slightly under fire
      lvl *= M.lerp(1, 0.40, this._covered);       // muffled under a roof
      R.out.gain.setTargetAtTime(Math.max(0.0001, lvl), t, 0.20);
      R.lp.frequency.setTargetAtTime(M.lerp(19000, 740, this._covered), t, 0.30);
      var L = R.layers;
      if (L.metal) L.metal.gain.setTargetAtTime(
        Math.max(0.0001, intensity * (0.09 + this._metalNear * 0.62)), t, 0.5);
      if (L.dull) L.dull.gain.setTargetAtTime(
        Math.max(0.0001, intensity * (0.18 + this._dullNear * 0.40)), t, 0.5);
      if (L.roof) L.roof.gain.setTargetAtTime(
        Math.max(0.0001, intensity * this._covered * 0.85), t, 0.35);
      if (L.roar) L.roar.gain.setTargetAtTime(
        Math.max(0.0001, 0.10 + intensity * 0.14), t, 0.6);
    }

    // Wind gusting tracks the weather's wind speed. The lower clamp keeps the
    // base above the LFO depths so a gust cannot drive a gain negative.
    var wg = M.clamp(windSpeed / 15, 0.55, 1.6);
    if (this._windGains) {
      for (var i = 0; i < this._windGains.length; i++) {
        this._windGains[i].gain.setTargetAtTime(0.38 * wg, t, 0.9);
      }
    }
    if (this._fenceGain) this._fenceGain.gain.setTargetAtTime(0.30 * wg, t, 0.9);

    // Thunder scheduled by earlier strikes.
    if (this._thunderQueue.length) {
      for (var q = this._thunderQueue.length - 1; q >= 0; q--) {
        if (this._thunderQueue[q].at <= t) {
          var item = this._thunderQueue[q];
          this._thunderQueue.splice(q, 1);
          try { this._fireThunder(item.dist); }
          catch (e) { GAME.logError('audio.thunderFire', e); }
        }
      }
    }

    // Rising edge on weather.flash, in case weather.js publishes state without
    // emitting an event. Guarded exactly as the contract demands.
    if (w && typeof w.flash === 'number') {
      if (w.flash > 0.12 && this._prevFlash <= 0.12) this._onLightning({ flash: w.flash });
      this._prevFlash = w.flash;
    }

    // Surface/occlusion probe, at 2Hz.
    this._probeTimer -= dt;
    if (this._probeTimer <= 0) {
      this._probeTimer = 0.5;
      this._harborProbe();
    }
  };

  // ==========================================================================
  // End of the Cold Harbor section.
  // ==========================================================================

  Audio.prototype._resetAmbienceSchedule = function () {
    var r = this.rng;
    if (this._harbor) {
      // A working terminal at 02:00 in a gale. Intervals are deliberately
      // co-prime-ish so no two events ever settle into a rhythm.
      this._ambTimers = [
        { t: r.range(3.0, 9.0), lo: 7.0, hi: 19.0, fn: '_ambWaterSlap' },
        { t: r.range(5.0, 14.0), lo: 9.0, hi: 26.0, fn: '_ambHullGroan' },
        { t: r.range(8.0, 20.0), lo: 14.0, hi: 38.0, fn: '_ambRopeStrain' },
        { t: r.range(12.0, 34.0), lo: 26.0, hi: 62.0, fn: '_ambFoghorn' },
        { t: r.range(6.0, 18.0), lo: 18.0, hi: 55.0, fn: '_ambGulls' },
        { t: r.range(4.0, 11.0), lo: 6.0, hi: 17.0, fn: '_ambDrip' },
        { t: r.range(9.0, 22.0), lo: 15.0, hi: 42.0, fn: '_ambFenceRattle' },
        { t: r.range(16.0, 40.0), lo: 30.0, hi: 78.0, fn: '_ambMachinery' },
        { t: r.range(20.0, 50.0), lo: 34.0, hi: 90.0, fn: '_ambDistantThunder' },
        { t: r.range(25.0, 60.0), lo: 45.0, hi: 120.0, fn: '_ambReeferCycle' },
        { t: r.range(11.0, 26.0), lo: 20.0, hi: 48.0, fn: '_ambDistantGunfire' }
      ];
      return;
    }
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
    ui_click: function (o) { this.playUI('ui_click', o); },

    // ---- LEVEL 2: COLD HARBOR ---------------------------------------------
    // Every one of these degrades to silence rather than throwing if the
    // harbor ambience graph was never built (level 1, or a headless run).
    thunder: function (o) { this.thunder(o); },
    lightning: function (o) { this._onLightning(o); },
    foghorn: function (o) { this._ambFoghorn(); },
    gull: function (o) { this._ambGulls(); },
    gulls: function (o) { this._ambGulls(); },
    hull_groan: function (o) { this._ambHullGroan(); },
    creak_hull: function (o) { this._ambHullGroan(); },
    rope: function (o) { this._ambRopeStrain(); },
    rope_strain: function (o) { this._ambRopeStrain(); },
    water_slap: function (o) { this._ambWaterSlap(); },
    drip: function (o) { this._ambDrip(); },
    fence_rattle: function (o) { this._ambFenceRattle(); },
    machinery: function (o) { this._ambMachinery(); },
    reefer: function (o) { this._ambReeferCycle(); }
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
    on('audio:ambience', function (a) { self.setAmbience(strOf(a, ['preset', 'name'], null)); });
    on('game:start', function () { self.unlock(); });

    // ---- weather (LEVEL 2) -------------------------------------------------
    // weather.js is authored in parallel with this file and the event name is
    // not pinned by the contract, so subscribe to every plausible spelling.
    // _onLightning de-duplicates within a third of a second, and update() also
    // watches weather.flash for a rising edge, so a strike produces exactly
    // one thunder however weather.js chooses to announce it.
    function strike(a) { self._onLightning(a); }
    on('weather:lightning', strike);
    on('weather:strike', strike);
    on('weather:flash', strike);
    on('lightning', strike);
    on('lightning:strike', strike);
    on('thunder', function (a) {
      var o = (a && typeof a === 'object') ? a : EMPTY;
      self.thunder(o);
    });
    on('weather:preset', function (a) {
      // A preset change does not move us between levels; it only tells us how
      // hard it is raining, which update() already reads from ctx.weather.
      var n = strOf(a, ['preset', 'name'], null);
      if (n === 'clear' && self._rain && self.armed) {
        try {
          self._rain.out.gain.setTargetAtTime(0.0001, self.actx.currentTime, 1.2);
        } catch (e) { /* ignore */ }
      }
    });
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
    var harbor = this._harbor;
    var preset = harbor ? 'harbor' : 'outdoor';
    try {
      var up = lvl.raycast({ x: o.x, y: o.y, z: o.z }, { x: 0, y: 1, z: 0 }, 9);
      if (up && up.hit) {
        // Roofed. Big volume overhead reads as a hall, low ceiling as a room.
        // In the harbor the only real interior is the warehouse; a low roof is
        // a container overhang, which is still a hard steel box.
        if (harbor) {
          preset = (up.distance !== undefined && up.distance > 4.5) ? 'warehouse' : 'container';
        } else {
          preset = (up.distance !== undefined && up.distance > 6.0) ? 'hall' : 'interior';
        }
      } else {
        // Open above: check for two close parallel walls -> flutter echo.
        // The container canyons are wider than the market's alleys, so the
        // harbor probes further before deciding it is in one.
        var reach = harbor ? 4.6 : 3.4;
        var near = 0, side = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var i = 0; i < 4; i++) {
          var r = lvl.raycast({ x: o.x, y: o.y, z: o.z },
            { x: side[i][0], y: 0, z: side[i][1] }, reach);
          if (r && r.hit) near++;
        }
        if (near >= 2) preset = harbor ? 'container' : 'alley';
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

      // --- storm mix (LEVEL 2 only) ----------------------------------------
      if (this._harbor && this._ambBuilt) this._updateHarborMix(dt);

      // A gesture can arm the context before build() finished generating the
      // noise beds, in which case _buildAmbience bailed out with nothing built.
      // Retry rather than leaving the world silent for the whole session.
      if (!this._ambBuilt && this.buffers.pink && this.buffers.brown) {
        this._buildAmbience();
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
      ring: this._ringLevel,
      env: this._env,
      rain: this._rain ? this._rainLevel : 0,
      covered: this._covered,
      metalNear: this._metalNear,
      thunderPending: this._thunderQueue.length
    };
  };

  GAME.Audio = Audio;
})(window.GAME, window.THREE);
