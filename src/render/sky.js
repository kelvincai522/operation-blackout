// ============================================================================
// OPERATION BLACKOUT - src/render/sky.js  ->  GAME.Sky
//
// Physically-based atmosphere, sun, IBL environment, height fog and air dust.
//
// WHAT THIS MODULE OWNS
//   * The visible sky (a camera-locked inverted sphere running an atmospheric
//     scattering shader).
//   * sky.envMap    - a PMREM-prefiltered image-based-lighting probe generated
//                     from that same sky, so ambient light always agrees with
//                     what you can see.
//   * sky.sunDirection / sunColor / sunIntensity - what lighting.js hangs its
//                     directional light on.
//   * The GLOBAL FOG. This module patches THREE.ShaderChunk.fog_* so every
//     material in the game gets exponential *height* fog with sun-direction
//     dependent inscattering and aerial perspective. See "FOG" below.
//   * sky.dustParticles - a cheap additive mote field that thickens the air.
//   * sky.setWeather(preset) - 'clear' (the default and every prior behaviour)
//                     or 'storm' / 'overcast' / 'drizzle', which paint a
//                     procedural nimbostratus deck over the atmosphere for
//                     LEVEL 2. See the STORM WEATHER section below. Level 1
//                     never calls it and never reaches a line of it.
//
// THE ATMOSPHERE MODEL
//   Single-scattering Rayleigh + Mie + ozone through a spherical, exponentially
//   stratified atmosphere. The expensive part (the in-scattering integral along
//   a view ray) is evaluated on the CPU into a small "sky-view" LUT, exactly
//   once per meaningful change of sun elevation. Because the atmosphere is
//   rotationally symmetric about the sun, that LUT only needs
//   (azimuth-relative-to-sun, elevation) - two dimensions, 128x64 texels.
//
//   The LUT deliberately stores the Rayleigh and Mie integrals WITHOUT their
//   phase functions:
//       lutA.rgb = integral of  T_view * T_sun * betaR * densityR  ds
//       lutB.rgb = integral of  T_view * T_sun * betaM * densityM  ds
//       lutC.rgb = everything isotropic (multiple-scatter approximation,
//                  ground bounce, twilight afterglow, night airglow)
//   The phase functions are then applied per-pixel in the sky shader. That is
//   what keeps the Mie forward-scattering glow around the sun razor sharp at
//   full screen resolution even though the LUT itself is tiny, and it is why
//   the sun's aureole does not band.
//
//   Mie is stored per channel, not as one achromatic number: over a horizon
//   path the aerosol extinction differs enough between R and B that collapsing
//   it turns the golden-hour horizon band from ochre into flat white.
//
//   The sun disc, its limb darkening, the moon and the stars are analytic in
//   the fragment shader for the same reason.
//
// COLOUR SPACE / HDR
//   Everything here is LINEAR HDR radiance. Nothing is tone mapped - postfx
//   owns that. The whole module is calibrated against ONE number, keyRef: the
//   radiance of an 18% grey card lying flat in full sun. See _keyRef for why
//   that reference (and not the 0.5-albedo one it replaced) is the difference
//   between a photograph and a white wall with a street underneath it. At the
//   golden-hour default keyRef is 0.084; the fog is capped at 0.9 x that, the
//   LUT dome shoulder at 1.6 x pi x that, and the sun disc sits at 260 x it.
//
//   THE DOME IS SPLIT IN TWO, and this is the other structural idea in the
//   file. The radiance the scene is LIT by and the radiance the player SEES are
//   the same physical field, but one is consumed by an irradiance integral and
//   the other by a tone curve, and those two have wildly different usable
//   ranges. The IBL probe therefore captures the unmodified physical dome,
//   while the visible dome gets DAY_GAIN plus a soft knee on top. Measured
//   against a full inversion of the postfx chain, that puts the visible zenith
//   near 0.033 and the horizon band near 0.088 - inside the part of the curve
//   that still holds colour - without moving the light by a single percent.
//
//   The LUT textures are data, so they stay THREE.NoColorSpace.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var PI = Math.PI;

  // ==========================================================================
  // Float32 -> half float. The sky LUT is uploaded as a HalfFloatType
  // DataTexture: half is the only float format WebGL2 guarantees is linearly
  // filterable without an extension, and 10 bits of mantissa is far more than a
  // smooth radiance gradient needs.
  // ==========================================================================
  var _f32 = new Float32Array(1);
  var _i32 = new Int32Array(_f32.buffer);
  function toHalf(val) {
    _f32[0] = val;
    var x = _i32[0];
    var bits = (x >> 16) & 0x8000;
    var m = (x >> 12) & 0x07ff;
    var e = (x >> 23) & 0xff;
    if (e < 103) return bits;                       // underflow -> signed zero
    if (e > 142) return bits | 0x7c00;              // overflow  -> inf
    if (e < 113) {                                  // subnormal
      m |= 0x0800;
      return bits | ((m >> (114 - e)) + ((m >> (113 - e)) & 1));
    }
    bits |= ((e - 112) << 10) | (m >> 1);
    return bits + (m & 1);
  }

  // ==========================================================================
  // Atmosphere constants. Lengths in kilometres, coefficients per kilometre.
  //
  // Rayleigh values are the standard sea-level scattering coefficients at
  // 680/550/440 nm.
  //
  // TWO AEROSOL LAYERS, NOT ONE. This is the single most important structural
  // decision in the file and it was got wrong for a whole round.
  //
  // A single Mie column thick enough to produce a golden-hour horizon band
  // (AOD 0.095 over a 1.2 km scale height) also drapes that same near-achromatic
  // aerosol over the ENTIRE dome, because a 1.2 km layer still has a meaningful
  // slant column at 40 degrees of elevation. Measured on the model: at 30 deg
  // elevation, 60 deg from the sun, a single 0.095 column gives a linear
  // saturation of 0.29 - and once AgX has compressed that through the tone
  // curve it prints as the featureless off-white wall the critics measured
  // (top-band saturation 0.063-0.153, R=G=B to within 3%).
  //
  // Splitting the same haze into
  //     * a thin, clean-ish Mie background (AOD 0.020 over 1.2 km), and
  //     * a heavy near-ground mineral-dust layer (AOD 0.048 over 260 m)
  // moves the aerosol OUT of the upward view rays and INTO the horizontal ones.
  // A ray at 30 deg only crosses 2 x the dust column; a ray at 2 deg crosses
  // 25 x it. Same measurement after the split: saturation 0.43 at 30 deg
  // elevation (up from 0.29) while the 3-degree horizon band actually gets
  // WARMER (rgb 1.29/0.87/0.41, saturation 0.68, was 1.36/0.89/0.41 at 0.70).
  // Ochre horizon over a blue zenith, which is the whole point.
  //
  // Mineral dust scatters long and absorbs blue - single-scattering albedo is
  // about 0.93 in the red and 0.56 in the blue - so betaDs is tilted hard and
  // betaDe barely at all. That asymmetry, not the extinction, is what makes the
  // band read ochre rather than grey.
  // ==========================================================================
  var Rg = 6360.0;                 // planet radius
  var Rt = 6460.0;                 // top of atmosphere
  var Hr = 8.0;                    // Rayleigh scale height
  var Hm = 1.2;                    // Mie (background aerosol) scale height
  var Hd = 0.26;                   // near-ground mineral dust scale height
  var CAM_H = 0.01;                // observer altitude used for the LUT (10 m)

  var betaR = [5.802e-3, 13.558e-3, 33.1e-3];
  // Background aerosol optical depth at 550 nm. Deliberately low: the dust
  // layer below carries the haze that the art direction wants, and every unit
  // of THIS one greys the zenith out.
  var MIE_AOD = 0.020;
  // Near-ground dust, as a multiple of MIE_AOD, so setTurbidity() keeps the two
  // layers in proportion instead of letting a caller create a hazy zenith over
  // clean ground (which is not a thing).
  var DUST_RATIO = 2.4;
  var DUST_AOD = MIE_AOD * DUST_RATIO;
  var betaMs = new Float64Array(3);
  var betaMe = new Float64Array(3);
  var betaDs = new Float64Array(3);
  var betaDe = new Float64Array(3);
  var betaO = [0.650e-3, 1.881e-3, 0.085e-3];   // ozone absorption at peak
  var OZ_COLUMN = 15.0;            // tent profile area, centred 25km, halfwidth 15

  function setTurbidity(aod) {
    MIE_AOD = aod;
    DUST_AOD = aod * DUST_RATIO;
    var b = aod / Hm;
    betaMs[0] = b * 0.90 * 1.07; betaMs[1] = b * 0.90; betaMs[2] = b * 0.90 * 0.88;
    betaMe[0] = b * 1.00;        betaMe[1] = b * 1.03; betaMe[2] = b * 1.12;
    var d = DUST_AOD / Hd;
    betaDs[0] = d * 0.93; betaDs[1] = d * 0.80; betaDs[2] = d * 0.56;
    betaDe[0] = d * 1.00; betaDe[1] = d * 1.02; betaDe[2] = d * 1.06;
  }
  setTurbidity(MIE_AOD);

  var MIE_G = 0.72;                // atmospheric Mie anisotropy
  var MS_FACTOR = 0.32;            // crude multiple-scattering top-up
  var GROUND_ALBEDO = [0.28, 0.24, 0.18];   // sun-baked sand, per ART_DIRECTION

  // --------------------------------------------------------------------------
  // Raw model radiance -> game HDR units.
  //
  // This number is not free: it fixes the ratio between the sky and everything
  // lit by lighting.js.
  //
  // RADIANCE vs IRRADIANCE - the trap this constant fell into once already.
  // A THREE.DirectionalLight intensity is an IRRADIANCE (W/m^2 on a surface
  // facing it). Everything in this module is a RADIANCE (W/m^2/sr). They are
  // not comparable. A Lambertian receiver under a hemisphere of uniform
  // radiance L collects E = pi * L, so a sky whose mean radiance is L competes
  // with the sun at a ratio of sunIntensity : pi*L, NOT sunIntensity : L.
  //
  // Budget: the key lands on 5.2 at the golden-hour default. Real clear-sky
  // measurements at a 14 degree sun put diffuse-horizontal at roughly 11% of
  // direct-normal, i.e. a sky irradiance near 0.58, i.e. a cosine-weighted mean
  // sky radiance near 0.58/pi = 0.185. The raw model integrates to about 0.079
  // per unit of scale at that elevation, so SKY_SCALE lands on ~2.2.
  //
  // The previous value of 7.0 compared the sun's irradiance against the sky's
  // radiance directly and therefore over-lit the IBL by a factor of pi. The
  // measured cost was 0.86 stops of key-to-fill on a continuous plaster wall
  // (sunlit 0.630 / own cast shadow 0.481), window reveals casting nothing, and
  // anodised-black metal integrating enough environment to read as light grey
  // plastic. Too high and the image-based ambient swamps the sun, cast shadows
  // vanish and the frame goes flat - item 1 on the ART_DIRECTION instant-fail
  // list. Too low and shadows crush to black - item 2 on the same list.
  //
  // DO NOT RETUNE THIS TO CHANGE HOW THE SKY LOOKS. Since the dome was split
  // into a light path and a picture path, SKY_SCALE governs only the LIGHT: the
  // IBL probe, the hemisphere fill, every derived fog colour. Moving it to fix
  // a bright or dull sky moves the whole scene's exposure with it and the sky
  // ends up back where it started, because the auto-exposure chases it. The
  // picture knob is DAY_GAIN.
  // --------------------------------------------------------------------------
  var SKY_SCALE = 2.2;

  // Twilight / night additions. Expressed as FRACTIONS of SKY_SCALE so that
  // retuning the exposure balance above cannot silently desynchronise the
  // authored dusk and night layers from the physical daylight ones.
  var AFTERGLOW_LOW = [0.1594, 0.0638, 0.0288];   // burning band on the horizon
  var AFTERGLOW_HIGH = [0.0213, 0.0138, 0.0288];  // violet belt above it
  // Night airglow. Physically a moonlit sky is ~1e-6 of daylight, which no
  // exposure curve can present alongside a readable moon key. These are pitched
  // against the CINEMATIC moon (moonIntensity 0.34, plus lighting.js's own
  // floor): they put the night sky irradiance about 1/13 of the moon key, the
  // same order as the sun:sky ratio by day, so a night street is sculpted
  // rather than a black rectangle with a few lamps in it. Still 7.6 stops under
  // the daylight sky, so "night is dark" survives.
  var NIGHT_ZENITH = [0.00210, 0.00290, 0.00550];
  var NIGHT_HORIZON = [0.00670, 0.00560, 0.00460];
  // --------------------------------------------------------------------------
  // CITY SKYGLOW (sodium). The airglow above is the sky of an empty desert; a
  // city has a second, WARM, horizon-hugging layer - low-pressure sodium and
  // tungsten scattered back off the same dust the daylight haze rides on.
  //
  // Measured on night.png before this existed: the row profile fell from 0.142
  // in the sky band to 0.033 by mid-frame with no intermediate plateau. Both
  // NIGHT_* layers above are cool AND flat, and every fog colour is derived
  // from them, so the far end of a night street faded to near-black instead of
  // into a lifted band - the frame lost the one depth cue that carries every
  // daylight capture, and the brightest 15% of the image was the (blue) zenith,
  // which is why the grade measured INVERTED after dark (-0.0198) while every
  // other capture measured +0.03 to +0.19.
  //
  // The falloff exponent is the important number, not the magnitude, and 6 is
  // measured rather than chosen. At 4 the layer reaches into the 12-30 degree
  // wedge a street framing actually SEES between the buildings, and there it
  // does not warm the sky, it CANCELS it: the night capture's sky wedge went
  // from 0.185 luminance at saturation 0.412 to 0.330 at 0.154 - a milky
  // neutral lid, which is worse than the flat blue it replaced and is the exact
  // failure the daylight dome was rebuilt to escape a round ago. At 6 the layer
  // is spent by ~12 degrees, i.e. it sits behind and just above the far
  // rooftops where a city glow belongs, the wedge keeps its blue, and the two
  // consumers that carry most of the benefit are barely touched: the fog
  // colours are sampled at 2.5 and 9 degrees of elevation, which still keep 77%
  // and 36% of the band.
  //
  // Biased toward the sun's (i.e. after dark, the down-street) azimuth so it
  // reads as a city over the far rooftops rather than a uniform dome lift, with
  // a substantial floor so it never becomes a single glowing patch.
  var NIGHT_SODIUM = [0.01250, 0.00800, 0.00420];
  var NIGHT_SODIUM_POW = 6.0;
  var NIGHT_SODIUM_FLOOR = 0.45;   // fraction reaching the anti-sun azimuth
  // The disc is the one term in the file that is a deliberate *ratio* to the
  // sky rather than a physical value (a real sun is ~1e5 x the sky, which no
  // 16-bit target and no bloom kernel wants).
  //
  // It used to be a multiple of SKY_SCALE, which meant its ratio to the sky
  // silently changed every time the dome's level was retuned - and the dome's
  // level has now been retuned twice. Expressed as a multiple of keyRef so the
  // disc tracks time of day and stays
  // a fixed RATIO to the sky no matter how the dome below is compressed.
  // 260 x keyRef lands ~21 radiance at the golden-hour default, i.e. ~240x the
  // displayed horizon band: it clips hard (which is the point - it is the one
  // element in the frame that feeds postfx's bloom core, its anamorphic streak
  // and its flare) without handing the flare taps a four-figure number that
  // turns the ghosts into the subject.
  var SUN_DISC_K = 260.0;          // x keyRef, at the disc centre
  // Dome shoulder, as a multiple of pi x keyRef. See _buildLut.
  var SKY_CAP_K = 1.6;

  // --------------------------------------------------------------------------
  // RAYLEIGH CHROMA EXPANSION
  //
  // A luminance-preserving chroma expansion applied to the Rayleigh integral
  // ONLY (never to Mie/dust), in the LUT, so the IBL and every derived fill
  // colour inherit it too.
  //
  // Why this is needed and why it is not a cheat: the physical model produces a
  // zenith of linear saturation 0.50, which is CORRECT - but postfx tone maps
  // with AgX, whose entire design goal is to desaturate toward white as values
  // approach the top of its range, and it does so after an auto-exposure that
  // measures ~8.5x on this scene. Measured end to end: a dome pixel of linear
  // (0.096, 0.122, 0.179) - saturation 0.43 - prints as (0.82, 0.82, 0.85),
  // saturation 0.035. The chroma is destroyed by the transfer function, not by
  // the atmosphere. ART_DIRECTION asks for a #4a7fb5 zenith, whose LINEAR
  // saturation is 0.85 - far MORE saturated than the physical model, so pushing
  // toward it is following the brief, not breaking it.
  //
  // Applying it to Rayleigh alone is what keeps it honest: Rayleigh is the blue,
  // Mie and mineral dust are the warm horizon band, so the zenith gets bluer
  // while the golden-hour band keeps exactly the ochre the dust layer computes.
  // --------------------------------------------------------------------------
  var RAY_CHROMA = 2.0;

  // --------------------------------------------------------------------------
  // DISPLAY SHOULDER (visible dome only - the IBL never sees it)
  //
  // The dome the player SEES and the dome the scene is LIT by are the same
  // radiance field physically, but they are consumed by two things with wildly
  // different dynamic ranges: an irradiance integral (which wants the physical
  // value) and a tone curve (which does not have room for it). At the metered
  // exposure this build actually runs, everything above ~0.05 radiance prints
  // between 0.65 and 0.95 and arrives desaturated; the physical sky sits at
  // 0.078 (zenith) to 0.89 (horizon), i.e. the ENTIRE sky lives inside the top
  // 0.15 of the print range. That is the white wall, and no amount of retuning
  // the atmosphere moves it, because the atmosphere is right.
  //
  // So the visible dome gets a gain plus a soft knee, and _regenerateEnvironment
  // switches both off while it captures the probe. The light is unchanged; the
  // picture gets its sky back. Measured target: zenith ~0.033 (prints ~0.59),
  // 35 deg ~0.050 (prints ~0.68), horizon band ~0.088 (prints ~0.79) - a real
  // gradient, in the part of the curve that still holds colour.
  //
  // Gated on sun elevation: dusk and night are authored layers that already sit
  // where they should, and compressing them would gut the one time of day where
  // the sky is legitimately the brightest thing in the frame.
  // --------------------------------------------------------------------------
  var DAY_GAIN = 0.42;             // multiplier on the physical daylight dome
  var DAY_SHOULDER_K = 1.05;       // asymptote, x keyRef
  var DAY_KNEE_F = 0.30;           // knee as a fraction of the asymptote
  var MOON_LUM = 0.043;            // x SKY_SCALE
  var STAR_LUM = 0.060;            // x SKY_SCALE
  var MILKYWAY_LUM = 0.0012;       // x SKY_SCALE
  // Analytic cloud band. Coverage is a THRESHOLD on the fbm, so lower = more
  // cloud; 0.50 is a broken cirrus/altocumulus deck that leaves most of the
  // dome open. Beer controls how hard the underside of a cloud goes to its
  // shadow colour.
  // The planar projection is scaled so SEVERAL cells cross the visible sky. At
  // the original 0.62 the whole upper dome sampled roughly ONE fbm cell, so the
  // "cloud deck" was a single blob covering everything - a flat, near-white,
  // structureless layer painted over the atmosphere, which is most of why the
  // sky measured saturation 0.06 and a standard deviation of 0.006 across the
  // top band. Both cloud radiances are multiples of keyRef (see _pushUniforms)
  // so a cloud is ~1-2.5x the sky beside it, which is what a thin deck does,
  // rather than 4x, which is what a wall does.
  // Coverage is a THRESHOLD on an fbm whose distribution is centred on 0.5 with
  // a spread of about 0.11, so 0.62 leaves roughly a seventh of the dome under
  // cloud - a broken cirrus band with clean blue between, which is the point.
  // Anything denser and the deck's (warm, sunlit) colour averages against the
  // (cool) atmosphere over most of the frame and the two cancel into the grey
  // the whole rest of this file is fighting.
  var CLOUD_SCALE = 3.2;
  var CLOUD_COVER = 0.62;
  var CLOUD_AMOUNT = 0.45;
  var CLOUD_BEER = 3.4;

  // ==========================================================================
  // STORM WEATHER  -  LEVEL 2, "COLD HARBOR"
  //
  // EVERYTHING IN THIS SECTION IS INERT UNTIL setWeather('storm') RUNS.
  // The single gate is Sky._stormF, which is 0 for the market level and for
  // every existing caller. Every added branch - in the dome shader, in the haze
  // schedule, in the derived ambient, in the fog parameters - tests it first
  // and falls through to the untouched clear-sky path when it is zero, so
  // level 1 renders the frame it rendered before, bit for bit.
  //
  // WHAT A STORM NIGHT SKY ACTUALLY IS, and why the clear-sky machinery cannot
  // produce one by being retuned:
  //
  //   The atmosphere model above integrates a CLEAR column. A 2 km-thick
  //   nimbostratus deck is not a turbidity setting - it is an opaque scattering
  //   slab that (a) removes the moon, the stars and the airglow entirely, (b)
  //   substitutes its own underside as the visible sky, and (c) is lit almost
  //   exclusively FROM BELOW, by the terminal's own sodium lamps. There is no
  //   value of MIE_AOD that does any of that; a thicker aerosol just makes a
  //   brighter grey dome, which is the flat grey card the art direction calls
  //   an instant fail.
  //
  //   So the deck is a separate layer painted over the finished atmosphere, and
  //   the three things that make it read as weather rather than as a texture
  //   are all structural:
  //
  //   1. TWO DECKS AT DIFFERENT HEIGHTS. The projection d.xz / (elev + h) is a
  //      plane at height ~1/h; using two different h values and drifting them
  //      at different rates gives real parallax between the near ragged scud
  //      and the far ceiling. A single layer, however detailed, reads as a
  //      painted dome the instant the camera turns.
  //   2. LIT FROM BELOW, MODULATED BY THICKNESS. A sodium underglow that is a
  //      flat warm wash is worthless; it has to land on the sagging cells of
  //      the cloud base and leave the gaps between them dark. That is the
  //      hallmark of a lit industrial site under low cloud and it is the whole
  //      reason this module knows about the terminal's lamps at all.
  //   3. THIN PATCHES. An overcast that is uniformly opaque has no depth. The
  //      deck's brightness therefore runs on 1/thickness, not on coverage - you
  //      never see through it, but where it is thin, light from above leaks and
  //      the sky is two or three stops brighter than the bruise beside it.
  //
  // The numbers are ABSOLUTE linear HDR radiances, not multiples of keyRef.
  // That is deliberate and it is the one place this file departs from its own
  // convention: keyRef is the radiance of a mid-grey card in the KEY, and under
  // a storm deck at 02:00 there is no key - the moon is behind two kilometres
  // of water. Referencing the deck to a key that is itself a floor value would
  // make the sky's level an accident of the floor. The reference that matters
  // here is the terminal's own lit ground, which ART_DIRECTION_HARBOR puts at
  // roughly 0.076 radiance under a sodium head; the deck is authored an order
  // of magnitude under that, and the underglow about a third of the way up to
  // it, so the lamps stay the brightest thing in the frame.
  // ==========================================================================

  // Deck radiance at the zenith and at the horizon, in its MEAN thickness
  // state. Cold blue-grey: a night overcast has no warm content of its own,
  // every warm thing in this sky comes from the ground.
  // These are MEASURED against the real stack, twice, and the second
  // measurement changed the shape of the curve as well as its level.
  //
  // Pass 1 authored a steep dome - zenith 0.0030, horizon 0.0092, plus an
  // underglow that tripled the horizon again - on the reasoning that a horizon
  // ray crosses far more deck. That is true, and it is still in the model, but
  // it produced a NINEFOLD zenith-to-horizon ramp, and the harbor's postfx runs
  // a deliberately narrow exposure window (exposureMin 1.10 / Max 5.20 against
  // the market's 0.16 / 18.0, todBiasFloor 0.62) because this level is pools of
  // light in a black field. Under that window the two ends of the ramp landed
  // on opposite failures at the same time: the crane framing measured its sky
  // at 0.023 / 0.022 / 0.022 - crushed, the stacks silhouetted against nothing,
  // no lid at all - while postfx measured the horizon band on the quay framing
  // at RGB(148,79,35) and had to pull its whole reference gain 30% to stop the
  // sky being the brightest thing in a 02:00 frame.
  //
  // Both readings are right, and a level shift cannot fix them because they
  // point in opposite directions. The ramp itself was wrong. A night overcast
  // lit from below is FLAT in luminance - the underside of a cloud deck is
  // nearly a Lambertian sheet a few hundred metres up, and what varies across
  // it is hue and structure, not brightness. So: the zenith comes up 4x, the
  // horizon only 2x, the underglow only 1.6x, and the ramp collapses from 9x to
  // about 2.6x. The interest now comes from where it should - thick against
  // thin, warm against cold - and the whole dome sits between 3x and 7x under
  // the wet apron beneath a sodium mast (~0.076), which is where a real one is.
  //
  // PASS 3, and this one is the reason the level did not read as night at all.
  // Measured on the real quay framing: the deck filled the upper half of the
  // frame at a printed RGB(148,79,35) and a row-mean luminance of 0.339 against
  // a ground at 0.030 - an ELEVEN-fold sky-over-ground ratio, top-half mean
  // 0.2344 against bottom-half 0.0620, coverage.vertical_imbalance 3.78. The
  // brightest object in a two-in-the-morning frame was the sky, which is the
  // "flat, uniformly-lit scene" instant-fail wearing a cloud texture: at 02:00
  // the luminance hierarchy MUST run lamp core > lamp pool > wet reflection >
  // cloud deck, and it ran cloud deck first.
  //
  // Two separate faults, and only one of them was a level:
  //
  //   1. LEVEL. The deck integrated to ~0.013 mean radiance across the visible
  //      dome, i.e. a sixth of the wet apron under a mast (0.076) - which is
  //      the right ORDER but the wrong side of it once you remember the sky is
  //      50% of the pixels in every harbor framing and the lit apron is about
  //      8%. A lid that is one sixth as bright as the brightest surface but
  //      six times as large is still the subject of the photograph. Cut to
  //      about 0.45x, which puts the mean deck around a thirteenth of the
  //      apron and lands the sky UNDER the lamp pools where it belongs.
  //
  //   2. UNIFORMITY, and this is the structural one. The underglow was a pure
  //      function of ELEVATION - identical in every compass direction - so it
  //      painted a continuous amber ring right round the sky. Nothing in nature
  //      does that. A terminal is a FINITE lit patch; the cloud over it glows
  //      and the cloud over the black water two hundred metres away does not,
  //      which is why a real port at night has warm PATCHES on the base with
  //      cold bruised gaps between them. See stAz in the shader: the glow now
  //      rides a smooth field around the compass with hot lobes and real gaps,
  //      and its elevation falloff is tightened from 0.30 to 0.16 so it is a
  //      band ON the skyline rather than a wash climbing forty degrees up.
  //
  // Net effect at the horizon: 0.0145 radiance inside a lit lobe (0.56x the
  // old figure), 0.0069 in the gaps between them (0.26x). Same sky, two stops
  // of variation across it instead of none.
  //
  // PASS 4. Measured on harbor_overview: the sky occupies the top third of the
  // establishing shot and runs 0.123 at the top edge to 0.199 just above the
  // skyline, against a terminal-region median of 0.115. The brightest third of
  // the frame was empty sky, which is why the shot has no focal point and why
  // postfx's meter was being driven by pixels with no subject in them.
  //
  // The LEVEL was only half of it. The other half is that the ramp ran the
  // wrong way for this camera. STORM_GLOW below models a DISTANT lit place -
  // its falloff is in elevation, so it banks on the SKYLINE - and that is the
  // correct model for a town you are looking at from outside. It is the wrong
  // model for a terminal you are standing IN. The cloud a hundred metres over
  // your head is the part directly above the lamps; the cloud on the skyline is
  // three hundred metres out over black water and there is nothing under it to
  // light it. So the horizon band comes down (x0.82 here, and STORM_GLOW itself
  // to 0.45x) and the energy moves into STORM_BOUNCE, a dome centred on the
  // terminal's own lamp cluster in WORLD space. See _stormDome.
  //
  // Net: the top edge of a downward-looking establishing shot darkens (it is
  // aimed at cloud beyond the lit patch), while the upper frame of anything
  // looking UP - the crane, the canyon slot - gains the warm lit base the art
  // direction asks for and the crane finally has something to silhouette
  // against.
  var STORM_ZENITH = [0.0092, 0.0116, 0.0162];
  var STORM_HORIZON = [0.0113, 0.0130, 0.0161];
  // Peak sodium underglow radiance on the cloud base, INSIDE a lit lobe.
  // #ff9a3c broadened by multiple scattering through the deck (a cloud is a
  // very effective diffuser, so the glow arrives less saturated than the lamp
  // that made it).
  // The peak is barely down on the old 0.048 - the fix was never to make the
  // sodium dimmer, it was to stop it being everywhere. Averaged over the
  // compass by STORM_MEAN_AZ and over elevation by the tighter falloff, the
  // glow now delivers about 40% of the light it used to while looking MORE
  // like sodium, because it is now the bright half of a contrast rather than a
  // floor under the whole dome.
  //
  // PASS 4 cuts it to 0.45x and hands the difference to STORM_BOUNCE. This term
  // is now what it always physically was - the glow of everything OUTSIDE the
  // terminal (the port beyond the fence, the town behind it, the far basin)
  // banked on the skyline - and it is no longer asked to also be the light the
  // terminal itself is throwing at the ceiling directly overhead, which it
  // could never be: a function of elevation alone is a ring round the horizon,
  // and the one place it puts NO light is straight up, which is exactly where
  // the cloud over a lit apron is brightest.
  var STORM_GLOW = [0.0149, 0.0063, 0.0019];
  // e-folding elevation (sin) of the underglow. 0.16, not 0.30: at 0.30 the
  // band still held 19% of peak at thirty degrees and 37% at seventeen, i.e.
  // it covered the entire wedge of sky a ground-level framing actually sees.
  // At 0.16 it is 12% by twenty degrees and gone by thirty-five - the glow sits
  // on the skyline and dies into the cloud above it.
  var STORM_GLOW_FALL = 0.16;
  // Fraction of the peak underglow reaching the DARKEST compass bearings, i.e.
  // how black the sky gets over the unlit water. Not zero - light scattered
  // sideways inside the deck itself carries some of it everywhere - but low
  // enough that the lobes read as lit places rather than as a modulation.
  var STORM_GLOW_FLOOR = 0.13;
  // Mean of the azimuthal lobe over a full turn of the compass. Used ONLY by
  // the CPU mirror (_stormDeckRadiance) so the light the scene receives is the
  // average of the sky it is actually shown, not the peak of it.
  var STORM_MEAN_AZ = 0.52;

  // --------------------------------------------------------------------------
  // GROUND-BOUNCE DOME  -  the terminal's own sodium on the cloud base
  //
  // The single most efficient thing a port sky can have and the one this deck
  // was missing. Everything above models light arriving from SOMEWHERE ELSE;
  // this models the light leaving the apron you are standing on, hitting a
  // cloud base a hundred metres up, and coming back down. It is what makes a
  // real container terminal at 02:00 read as a lit place under a lid rather
  // than as a dark place under a grey ceiling, and it is what gives a 30 m
  // black crane something to be a silhouette against.
  //
  // WHY IT CANNOT BE A FUNCTION OF ELEVATION. STORM_GLOW is, and that is right
  // for a distant source - a town twenty kilometres off subtends nothing but a
  // band on the skyline. A lit patch you are INSIDE subtends the opposite: the
  // brightest cloud is straight up, and it falls away with the horizontal
  // distance from the lit patch to the point of the base you are looking at.
  // That distance is h/tan(elevation), so the term is peaked at the zenith and
  // dies toward the horizon - the exact inverse of STORM_GLOW - and it is
  // anchored in WORLD space, not in view space, so walking out of the terminal
  // walks out from under the glow. That is a depth cue no elevation curve can
  // produce, and it is why the same constant cannot serve both.
  //
  //   STORM_BOUNCE_H   cloud base height, metres. LOW: ART_DIRECTION_HARBOR
  //                    asks for a gantry crane whose legs "disappear into low
  //                    cloud", and the crane apex is 34 m. 115 m is a storm
  //                    scud base - low enough that the terminal's own lamps
  //                    reach it, high enough that the bright patch is a broad
  //                    dome overhead rather than a hard disc.
  //   STORM_BOUNCE_R   radius of the lit patch ON the base. Not the terminal's
  //                    own 45 m: light spreads sideways inside the deck (the
  //                    same lateral multiple scattering STORM_DECK_FLOOR
  //                    models), and the wet apron beyond the fence, the water
  //                    and the freighter's deck lights all contribute. At
  //                    ~1.1 x the base height the dome still holds a fifth of
  //                    its peak at 25 degrees of elevation, which is where a
  //                    ground-level framing's sky band actually lives.
  //   STORM_BOUNCE_CTR the lamp cluster's centroid in world XZ. The nine sodium
  //                    masts of level_harbor average to within a couple of
  //                    metres of the origin; z is pulled slightly seaward
  //                    because the quay pair and the mid-lane mast are the
  //                    three brightest.
  var STORM_BOUNCE_H = 115.0;
  var STORM_BOUNCE_R = 128.0;
  var STORM_BOUNCE_CTR = [0.0, -4.0];
  // Peak radiance of the bounce, directly over the lamp cluster, BEFORE the
  // back-scatter and cell terms (which take about 0.58 of it in the mean). Same
  // broadened sodium hue as STORM_GLOW. Lands the zenith of a ground-level
  // framing around 0.028 - roughly a third of the wet apron under a mast
  // (~0.076), i.e. clearly the second-brightest thing in the frame and never
  // the first.
  var STORM_BOUNCE = [0.0345, 0.0146, 0.0044];
  // The lit patch is not a uniform disc - it is nine lamps, a warehouse, a
  // freighter and a lot of black water - so the dome rides the same azimuthal
  // lobe field the skyline glow does, at reduced depth.
  var STORM_BOUNCE_AZ_LO = 0.55, STORM_BOUNCE_AZ_HI = 0.45;
  // The deck's COLD term, thickest -> thinnest. These two are the shader's own
  // literals: they are interpolated into the GLSL below AND read by the CPU
  // mirror, so the picture and the IBL cannot drift apart the way they did
  // before (the mirror was carrying 0.30 + 1.85 against a shader running
  // 0.24 + 0.72, i.e. it thought the deck was 1.74x brighter than it drew it).
  var STORM_DECK_MIN = 0.18;       // radiance multiplier where the deck is thickest
  var STORM_DECK_RANGE = 0.98;     // extra multiplier where it is thinnest
  // Mid-frequency brightness band. Mean exactly 1.0 by construction
  // (lo + hi/2), so it adds structure without moving the level by a percent.
  //
  // Applied LAST, after the toe floor below, and that ordering is the whole
  // point of it. Folded in before the floor it was worth +-20% of a number the
  // floor then compressed to +-7%, i.e. the deepest cloud printed as a flat
  // dark card - measured on the quay framing at a 95th-percentile of 0.041
  // against a 0.045 visibility floor, with a cell mean of 0.021: not crushed to
  // zero, but with nothing in it either, which the coverage metric scores the
  // same way and the eye reads the same way. After the floor the same term is
  // worth its full +-30% everywhere, so the darkest deck keeps visible cloud
  // shape - and because the multiplier averages to exactly 1, it buys that
  // structure at zero cost to the frame's mean or its vertical balance.
  var STORM_BAND_LO = 0.70, STORM_BAND_HI = 0.60;
  // ---- the deck's toe -------------------------------------------------------
  // Lateral multiple scattering INSIDE the deck. A cloud base is not a stack of
  // independent columns: light entering it over the lit apron spreads sideways
  // through several hundred metres of droplets before it leaves, so the part of
  // the base over the black water is never as dark as its own local column
  // says. That is a real term and it is the one this model was missing.
  //
  // It is also the term that fixes a measured failure. With the deck cut to
  // 0.45x, thick cloud at the zenith landed at 0.0021 radiance and the top
  // corners of the quay framing printed a 95th-percentile luminance of 0.039 -
  // under analyze.py's 0.045 visibility floor, i.e. five SKY cells counted as
  // dead, plus ARCHITECTURE 7.6's "no pure black". Simply raising the level
  // again would have put the sunset back.
  //
  // Applied as a SOFT floor, d' = f + d*d/(d+f), not as an addition and not as
  // a max(). At d = 0 it returns f; at d = f it returns 1.5f; by d = 4f it is
  // within 5% of d and by d = 10f within 1%. So it lifts the darkest cloud
  // about 2.5x, the mean zenith about a third, and the sodium band on the
  // skyline by six per cent - it compresses the deck's toe without touching its
  // level, which is exactly the difference between "dark" and "crushed".
  //
  // 0.0046 rather than the 0.0026 the first pass at this used, and the second
  // number is the measured one: at 0.0026 the quay framing's top corners came
  // back at a 95th-percentile of 0.048 / 0.041 / 0.041 against a 0.045 floor,
  // i.e. still on the wrong side of it. The reason the first estimate fell
  // short is worth recording, because it will catch the next person too - the
  // harbor's auto-exposure is a NEGATIVE FEEDBACK loop around this whole
  // module. Brightening the sky by 30% raised the meter's own reference by
  // nearly as much and the frame printed 4% DARKER overall. Nothing in this
  // file moves the picture by the factor it moves the radiance by; measure the
  // print, never the constant.
  var STORM_DECK_FLOOR = [0.00367, 0.00474, 0.00593];
  // Back-scatter saturation curve, and how much more of it the sagging cells of
  // the base catch than the flat sheet between them.
  var STORM_REFL_A = 1.30, STORM_REFL_B = 0.40;
  var STORM_CELL_LO = 0.44, STORM_CELL_HI = 1.04;
  var STORM_MACRO_LO = 0.42, STORM_MACRO_HI = 0.90;
  // Mean thin/thick fractions of the noise field, used ONLY by the CPU-side
  // ambient integral so the light the scene receives agrees with the picture
  // without having to sample the cloud texture on the CPU.
  var STORM_MEAN_THICK = 0.56;
  var STORM_MEAN_TRANS = (1.0 - STORM_MEAN_THICK) * (1.0 - STORM_MEAN_THICK);
  var STORM_MEAN_BULGE = 0.50;
  // In-cloud sheet lightning. HISTORY FIRST, then the constant that replaced
  // it - read PASS 5 below before changing anything here.
  //
  // There used to be a STORM_FLASH_K: a fixed radiance handed to the deck at
  // flash = 1, which the shader multiplied by up to 2.75
  // in the core, i.e. ~2.3 peak - about 45x the underglow and 400x the deck
  // beside it, which is what a strike inside a cloud looks like and what feeds
  // postfx's bloom. It decays over 60-180 ms, far faster than the 2.6/s
  // exposure adaptation, so it prints as a flash rather than as a new exposure.
  // Measured at 0.85 / 2.4 on the probe: the ENTIRE dome clipped to white,
  // including the half of the sky facing away from the strike, because a lobe
  // exponent of 2.4 still returns 0.19 at ninety degrees off axis. That is the
  // full-screen white fade on ART_DIRECTION_HARBOR's instant-fail list wearing
  // a cloud texture. Tighter lobe, a third of the gain: the core still clips
  // (it should - it is what feeds postfx's bloom and it is what freezes the
  // rain) but the far side of the sky only lifts about a stop, so the flash
  // has a DIRECTION, which is the entire point of putting it in the cloud
  // rather than in the composite.
  //
  // 0.25, not 0.42, and the reason is a consequence rather than a taste. This
  // is an ABSOLUTE radiance while everything it is judged against - the deck
  // under it, and the auto-exposure that meters both - just moved. Cutting the
  // deck to 0.45x left the flash where it was, so its ratio to the sky it is
  // supposed to be a flash IN more than doubled, AND the meter opened up to
  // compensate for the darker sky, which multiplied the two effects instead of
  // cancelling them. Measured on the lightning framing: mean luminance went UP
  // from 0.188 to 0.221 and the top-half / bottom-half split from 3.69 to 4.76,
  // i.e. the strike went from lighting the deck to being the frame - the
  // full-screen white fade, again, arrived by the back door. Scaled with the
  // deck it lifts the same number of stops over it that it did before.
  //
  // ==========================================================================
  // PASS 5, and it invalidates the whole argument above, because that argument
  // was between this file and itself.
  //
  // MEASURED, same pose, pre-strike against strike: the sky gap at the top of
  // frame fell 0.189 -> 0.074 (x0.39) while the ground rose x6.4 and the frame
  // mean went 0.105 -> 0.281. THE STORM DECK GOES DARK WHEN LIGHTNING FIRES.
  // The physical source of the light dims a stop and a half at the instant it
  // emits, and the brightest thing in a lightning frame is wet concrete.
  //
  // The mechanism is not subtle once you look for it. This module sized the
  // in-cloud radiance from a FIXED constant scaled by w.flash. lighting.js
  // independently sized the key it spends on the scene from ITS constants
  // (HB.key, HB.keyShare, HB.keyMin) plus whatever weather.js's own flash light
  // is already spending. Nothing tied the two together. Then postfx's meter -
  // which is a negative feedback loop around the frame mean - closed down on
  // the newly-lit ground and took the sky with it. Two modules sizing the same
  // physical event from unrelated constants, arbitrated by a third that can
  // only see the sum.
  //
  // A tuning pass cannot fix that. The next change to HB.key desynchronises it
  // again. So the deck's emission is now DERIVED from the key the scene is
  // actually receiving, which is the physically correct direction of causation
  // anyway: in a real storm the cloud is the emitter and the ground is lit BY
  // it, not the other way round.
  //
  //   A surface under a hemisphere of uniform radiance L collects E = pi * L.
  //   lighting.js hands the scene an irradiance of `keyIntensity`. So the deck
  //   that could have produced it has radiance keyIntensity / pi, and that is
  //   the anchor - no free constant, no unit mismatch, and it tracks lighting.js
  //   automatically for ever.
  //
  // STORM_FLASH_Q is the only dimensionless thing left: what fraction of that
  // ideal uniform emitter the visible lobe actually is. A real strike is not a
  // uniform hemisphere - it is a bright cell with a lit half-dome around it -
  // so the average over the lit side comes out under 1 while the core runs
  // several times over it. That is exactly the shape the lobe/core split below
  // already had; all that changes is what it is a fraction OF.
  //
  // Sanity check on the direction: wet concrete's albedo in this level is
  // deliberately near-black, so a cloud that lights it to radiance G has its
  // own radiance around G/albedo - i.e. the sky in a lightning frame is
  // SEVERAL TIMES the ground it is lighting, not a quarter of it. The critic's
  // acceptance target (sky >= 2x the lit apron) is the conservative end of the
  // physics, not a stylistic ask.
  //
  // 0.54, and the number was BISECTED against the print rather than argued.
  // Measured on the `lightning` framing at 1280x720, t = 1.5, sampling the sky
  // slot above the canyon against the lit apron in the lower third:
  //
  //     the old fixed constant   sky 0.091 / apron 0.287   ratio 0.32
  //     Q = 0.34 (tight split)   sky 0.606 / apron 0.487   ratio 1.25
  //     Q = 0.46                 sky 0.624 / apron 0.327   ratio 1.91
  //     Q = 0.54                 sky 0.649 / apron 0.321   ratio 2.02  <-
  //
  // Note what happens to the DENOMINATOR across those rows: it falls, because
  // postfx's meter closes on the brightening sky. That is the negative feedback
  // this file's DAY_GAIN comment warns about, working FOR us for once - each
  // extra stop in the deck buys more than a stop of separation. It is also why
  // the first attempt overshot so badly.
  //
  // The overshoot is worth recording. At 0.62 with the ORIGINAL wide lobe the
  // ratio target was met and the frame was ruined: 60% of the 8x8 cells sat on
  // postfx's black floor, the containers were silhouettes with nothing in them
  // and the rain had gone. The deck is 30-50% of the pixels in every harbor
  // framing, so a broad two-stop lift moves the frame mean two stops and the
  // meter answers by closing down until the only thing left is the thing that
  // moved - the strike stopped lighting the terminal and started replacing it.
  //
  // The physics was not wrong; the uniform-hemisphere reading of it was. A
  // strike is a bright CELL inside the deck, not an evenly glowing dome, so
  // most of the emitted power belongs in a small solid angle. Spending it there
  // instead (see STORM_FLASH_TIGHT and the lobe/core split, both moved with
  // this) buys 20x the peak radiance of the old constant for about 6x the total
  // energy in the sky, so the cloud around the strike clips while the frame
  // mean lands at 0.256, dynamic range 0.811, crushed black 0.00%, blown 0.01%
  // and no red flag anywhere.
  var STORM_FLASH_Q = 0.54;
  // Fallback key-per-unit-flash, used only until ctx.lighting has been observed
  // through one frame of a real strike (and for ever if lighting.js is missing
  // or has no keyIntensity). Sized to lighting.js's own harbor budget so the
  // untied path is still in the right decade rather than back at pass 4.
  var STORM_FLASH_KEY_DEF = 18.0;
  // Clamp on the observed key-per-flash. Wide enough to follow any plausible
  // retune of lighting.js's budget, tight enough that one bad frame from
  // another agent's module cannot white the sky out.
  var STORM_FLASH_KEY_MIN = 2.0, STORM_FLASH_KEY_MAX = 90.0;
  // Luminance-normalised #dceaff, so the emission constants above are true
  // luminances rather than "whatever this triple happens to integrate to".
  var STORM_FLASH_HUE = [0.878, 1.012, 1.228];
  // 5.6, not 3.6. The peak went up 8.5x, and at 3.6 the far side of the sky
  // would have gone up with it: a bearing ninety degrees off the strike still
  // returned 8% of the lobe, which at the new level is a visible lift over the
  // whole dome - the full-screen white fade arriving by the back door for the
  // third time - and, worse, it is spent where it does nothing but drive the
  // meter. At 5.6 the same bearing returns 2%, so the strike keeps a DIRECTION
  // while its own cell clips.
  var STORM_FLASH_TIGHT = 5.6;
  // How the emission splits between the broad lit half-dome and the cell the
  // strike is actually inside. The energy is now concentrated hard into the
  // core: the core is what the eye reads as lightning and what feeds postfx's
  // bloom, and it is worth eight times as much per unit of frame mean as the
  // lobe is. The core exponent is 3.6x the lobe's (it was 5x) so the bright
  // cell subtends ~25 degrees and reads as a lit cloud mass rather than as a
  // dot with a halo.
  var STORM_FLASH_LOBE = 0.38, STORM_FLASH_CORE = 3.00;
  var STORM_FLASH_CORE_P = 3.6;
  // How much of the moon key survives the deck. Not zero: a storm deck still
  // has a bright side, and lighting.js needs a key DIRECTION at all times or
  // its cascade has nothing to hang on. But it must not read as moonlight -
  // the harbor is lit by its practicals.
  var STORM_MOON_K = 0.55;
  // How far the storm haze may sit above the key reference. Same argument as
  // NIGHT_HAZE_K, one step further: the brightest surface in this level is wet
  // concrete under a sodium mast, roughly twenty times a moonlit grey card, and
  // rain scatter is what makes a lamp cone visible at all.
  var STORM_HAZE_GAIN = 5.2;
  var STORM_HAZE_ALBEDO = 0.93;    // water droplets, vs 0.76 for mineral dust
  // Coverage THRESHOLD on the deck's fbm. Low = near-total overcast; the
  // structure lives in the deck's brightness, not in holes in it.
  // Deliberately LOW. Nimbostratus is not broken cloud: you do not see sky
  // through it, and at 0.16 with a 0.34 span roughly half the dome was still
  // showing the atmosphere behind it, which reads as a nice afternoon
  // cloudscape and not as the lid the art direction asks for. The deck's DEPTH
  // comes from its brightness running on 1/thickness (see stTrans in the
  // shader), not from holes in it - a couple of per cent of genuinely torn scud
  // is all the leak that should exist.
  var STORM_COVER = 0.06;
  var STORM_COVER_SPAN = 0.26;
  var STORM_DETAIL = 1.0;          // cellular-bulge gain
  // Wind drift -> deck uv, per metre of world travel. Sized so a 14 m/s gale
  // moves the near deck about one texture width in 45 s: clearly alive when you
  // stand and watch, effectively frozen inside a 1.5 s deterministic capture.
  var STORM_DRIFT_K = 0.0016;
  var STORM_TEX_SIZE = 256;
  // Fog for driving rain. heightScale is enormous compared with the market's
  // 5.5 because rain is not a ground layer - it fills the whole column, and a
  // 5.5 m e-folding height would leave the crane boom and the deck above it
  // perfectly crisp over the top of a hazed apron. mieG is LOW: water droplets
  // at night with no key to forward-scatter from want a nearly isotropic veil,
  // not a directional glow.
  var STORM_FOG = {
    density: 0.0265,
    heightScale: 22.0,
    startDistance: 1.0,
    maxOpacity: 0.94,
    mieG: 0.38,
    glowGain: 0.75,
    desaturate: 0.34
  };
  // Haze hues, linear, max-channel-normalised. Slate is ART_DIRECTION_HARBOR's
  // #39434d "steam / rain haze"; sodium is #ff9a3c after the same scattering
  // broadening as the underglow.
  var STORM_HAZE_HUE = [0.551, 0.756, 1.000];
  var STORM_SODIUM_HUE = [1.000, 0.420, 0.130];
  // Target luminances for the three inscatter directions. Well under the
  // lamp-lit ground (~0.076) so the haze never out-brightens the surfaces it
  // sits in front of, and well over zero so the freighter fades into a veil
  // instead of silhouetting against literal black.
  //
  // Brought down with the deck (see STORM_ZENITH pass 3) rather than left where
  // they were, and that is not tidiness: the haze is the DECK's light scattered
  // by the rain under it, so a veil that stays put while the sky it is lit by
  // halves is a veil that is now brighter than its own source. That is exactly
  // what a "flat grey-orange fog with no geometry legible through it" is - the
  // near field stops being lit air in front of a scene and becomes an opaque
  // card in front of it. SKY and SUN come down with the deck; GND is held much
  // closer to where it was, because that one is the warm bounce off the lit
  // apron (whose brightness has not changed) and it is the only thing keeping
  // the bottom of the frame off literal black.
  var STORM_FOG_SKY_LUM = 0.0066;
  var STORM_FOG_SUN_LUM = 0.0104;
  var STORM_FOG_GND_LUM = 0.0090;
  // Hue-normalised light colours published to lighting.js under storm.
  var STORM_SKY_HUE = [0.551, 0.756, 1.000];
  var STORM_ZENITH_HUE = [0.480, 0.700, 1.000];
  var STORM_GND_HUE = [1.000, 0.660, 0.400];

  // --------------------------------------------------------------------------
  // HAZE SCHEDULE (see _scheduleHaze)
  //
  // The fog used to run at ONE density for the whole day, which is wrong in
  // both directions and wrong for the same reason: dust is a DAYTIME
  // phenomenon (convection lifts it, thermals hold it up) while humidity,
  // cooking smoke, inversion and skyglow scattering are NIGHT ones, and the
  // near-field haze is what a lamp halo or a light shaft is actually made of.
  // A constant density means the one time of day that most needs air to glow in
  // has exactly as much of it as noon.
  //
  //  NIGHT_FOG_K      density multiplier at full night (cool, damp, settled)
  //  AFTERGLOW_FOG_K  extra at civil twilight. Deliberately well under the
  //                   night figure: dusk already prints at mean 0.158 with a
  //                   +0.116 grade split and a bright horizon band, and the
  //                   fastest way to lose that is to veil it.
  //  NIGHT_HAZE_K     how far the after-dark haze may exceed the key reference
  //                   (see _deriveAmbient). keyRef is the radiance of a mid-grey
  //                   card in the KEY, and after dark the key is a 0.34 moon -
  //                   but the brightest thing on a night street is a sodium head
  //                   putting ~1.3 of irradiance on the pavement three metres
  //                   under it, i.e. a surface radiance around 0.076, which is
  //                   twenty times that reference. Capping the haze against the
  //                   moon alone is what made the far end of the street fall to
  //                   near-black; this is the term that fixes it, and it is
  //                   gated on DEEP night so dusk keeps its authored levels.
  var NIGHT_FOG_K = 1.70;
  var AFTERGLOW_FOG_K = 0.35;
  var NIGHT_HAZE_K = 1.40;
  // Single-scattering albedo of the near-field haze. Mineral dust and water
  // droplets are both bright scatterers; this is published (see
  // this.scatterRadiance) so lighting.js can size a practical's halo card and
  // postfx can add a per-practical inscatter term against the same atmosphere
  // this module is fogging the scene with, instead of guessing.
  var HAZE_ALBEDO = 0.76;

  // --------------------------------------------------------------------------
  // Chapman function (Schueler's approximation): the relative air mass along a
  // ray leaving altitude h at zenith-cosine c, for an exponential atmosphere.
  // optical depth = beta0 * H * chapman(R/H, h/H, c).
  //
  // The c < 0 branch legitimately overflows to Infinity for rays that plunge
  // into the planet; exp(-Infinity) is 0, which is the right answer, so we only
  // need to keep it from becoming NaN.
  // --------------------------------------------------------------------------
  function chapman(X, h, c) {
    var cc = Math.sqrt(X + h);
    if (c >= 0.0) return cc / (cc * c + 1.0) * Math.exp(-h);
    var s = Math.sqrt(Math.max(0.0, 1.0 - c * c)) * (X + h);
    var e = X - s;
    if (e > 60.0) return 1e30;                     // fully occluded
    return 2.0 * Math.sqrt(s) * Math.exp(e) - cc / (1.0 - cc * c) * Math.exp(-h);
  }

  // Ozone lives in a shell near 25 km, so it does not follow the exponential
  // Chapman profile. A softened secant is close enough and cannot blow up.
  function ozoneAirmass(c) {
    if (c < -0.06) return 26.0;
    return Math.min(20.0, 1.0 / Math.sqrt(c * c + 0.0025));
  }

  function transmittanceRaw(h, c, out) {
    var tR = chapman(Rg / Hr, h / Hr, c) * Hr;
    var tM = chapman(Rg / Hm, h / Hm, c) * Hm;
    var tD = chapman(Rg / Hd, h / Hd, c) * Hd;
    var oz = OZ_COLUMN * ozoneAirmass(c);
    for (var i = 0; i < 3; i++) {
      var tau = betaR[i] * tR + betaMe[i] * tM + betaDe[i] * tD + betaO[i] * oz;
      out[i] = tau > 50.0 ? 0.0 : Math.exp(-tau);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Transmittance table. transmittanceRaw() costs ~7 exp() calls; the sky LUT
  // needs it at every march step, so it gets tabulated over
  // (altitude, sun zenith cosine) with mappings that concentrate resolution
  // where the function actually moves - near the ground and near the horizon.
  // --------------------------------------------------------------------------
  var TT_W = 40, TT_H = 96, TT_HMAX = 60.0;
  var _ttData = new Float32Array(TT_W * TT_H * 3);
  var _ttTmp = [0, 0, 0];

  function buildTransmittanceTable() {
    for (var j = 0; j < TT_H; j++) {
      var yy = (j + 0.5) / TT_H;
      var tt = 2.0 * yy - 1.0;
      var c = tt < 0 ? -tt * tt : tt * tt;          // sign(t)*t^2, dense near 0
      for (var i = 0; i < TT_W; i++) {
        var xx = (i + 0.5) / TT_W;
        var h = xx * xx * TT_HMAX;
        transmittanceRaw(h, c, _ttTmp);
        var o = (j * TT_W + i) * 3;
        _ttData[o] = _ttTmp[0]; _ttData[o + 1] = _ttTmp[1]; _ttData[o + 2] = _ttTmp[2];
      }
    }
  }

  function transmittance(h, c, out) {
    var x = Math.sqrt(M.saturate(h / TT_HMAX)) * TT_W - 0.5;
    var t = c < 0 ? -Math.sqrt(-c) : Math.sqrt(c);
    var y = (0.5 + 0.5 * t) * TT_H - 0.5;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 > TT_W - 2) { x0 = TT_W - 2; fx = 1; }
    if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 > TT_H - 2) { y0 = TT_H - 2; fy = 1; }
    var a = (y0 * TT_W + x0) * 3, b = a + 3;
    var c0 = ((y0 + 1) * TT_W + x0) * 3, d0 = c0 + 3;
    for (var i = 0; i < 3; i++) {
      var top = _ttData[a + i] + (_ttData[b + i] - _ttData[a + i]) * fx;
      var bot = _ttData[c0 + i] + (_ttData[d0 + i] - _ttData[c0 + i]) * fx;
      out[i] = top + (bot - top) * fy;
    }
    return out;
  }

  buildTransmittanceTable();

  function phaseRayleigh(c) { return 0.0596831 * (1.0 + c * c); }
  function phaseMie(c, g) {
    var gg = g * g;
    var d = Math.max(1e-4, 1.0 + gg - 2.0 * g * c);
    return (1.0 - gg) / (12.5663706 * d * Math.sqrt(d));
  }

  // ==========================================================================
  // GLSL
  // ==========================================================================

  // ---- shared noise/hash helpers used by the night sky ---------------------
  var GLSL_NOISE = [
    'float gbHash13( vec3 p ) {',
    '  p = fract( p * 0.1031 );',
    '  p += dot( p, p.zyx + 31.32 );',
    '  return fract( ( p.x + p.y ) * p.z );',
    '}',
    'vec3 gbHash33( vec3 p ) {',
    '  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );',
    '  p += dot( p, p.yxz + 33.33 );',
    '  return fract( ( p.xxy + p.yxx ) * p.zyx );',
    '}',
    'float gbValue3( vec3 p ) {',
    '  vec3 i = floor( p ); vec3 f = fract( p );',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  float a = mix( gbHash13( i + vec3( 0.0, 0.0, 0.0 ) ), gbHash13( i + vec3( 1.0, 0.0, 0.0 ) ), f.x );',
    '  float b = mix( gbHash13( i + vec3( 0.0, 1.0, 0.0 ) ), gbHash13( i + vec3( 1.0, 1.0, 0.0 ) ), f.x );',
    '  float c = mix( gbHash13( i + vec3( 0.0, 0.0, 1.0 ) ), gbHash13( i + vec3( 1.0, 0.0, 1.0 ) ), f.x );',
    '  float d = mix( gbHash13( i + vec3( 0.0, 1.0, 1.0 ) ), gbHash13( i + vec3( 1.0, 1.0, 1.0 ) ), f.x );',
    '  return mix( mix( a, b, f.y ), mix( c, d, f.y ), f.z );',
    '}'
  ].join('\n');

  var SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    // The dome is a unit sphere centred on the eye, so the interpolated
    // position IS the view ray (perspective-correct), and normalising it in the
    // fragment shader gives the exact direction regardless of tessellation.
    '  vDir = position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
    '}'
  ].join('\n');

  var SKY_FRAG = [
    'precision highp float;',
    '#define GB_PI 3.141592653589793',
    'uniform sampler2D uLutA;',      // rgb = Rayleigh integral (no phase)
    'uniform sampler2D uLutB;',      // rgb = Mie integral (no phase)
    'uniform sampler2D uLutC;',      // rgb = isotropic radiance, final units
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunDisc;',
    'uniform vec3 uMoonDir;',
    'uniform vec3 uMoonColor;',
    'uniform vec3 uHazeSun;',        // horizon haze looking toward the sun
    'uniform vec3 uHazeSky;',        // horizon haze looking away from it
    'uniform vec3 uHazeGnd;',        // below-horizon: warm ground bounce
    'uniform vec4 uP;',              // x mieG, y moonAngRad, z sunAngRad, w skyScale
    'uniform vec4 uN;',              // x nightFactor, y starGain, z moonGain, w time
    'uniform vec4 uMode;',           // x disc gain, y haze strength, z fog mieG, w milky way
    'uniform vec4 uCloud;',          // x coverage threshold, y amount, z beer, w drift
    'uniform vec3 uCloudSun;',       // sunlit cloud radiance
    'uniform vec3 uCloudAmb;',       // shadowed cloud radiance
    'uniform vec4 uDay;',            // x gain, y knee, z asymptote, w cloud scale
    // ---- storm deck (level 2). All zero / unused when uStorm.x == 0. -------
    'uniform sampler2D uStormTex;',  // r base fbm, g mid fbm, b cells, a wisps
    'uniform vec4 uStorm;',          // x strength, y cover threshold, z detail, w wind bearing
    'uniform vec4 uStormDrift;',     // xy near-deck uv drift, zw far-deck uv drift
    'uniform vec3 uStormLow;',       // deck radiance at the horizon
    'uniform vec3 uStormHigh;',      // deck radiance at the zenith
    'uniform vec3 uStormGlow;',      // peak sodium underglow radiance
    'uniform vec3 uStormBounce;',    // peak ground-bounce radiance over the lamps
    'uniform vec4 uStormBase;',      // x base height, y 1/patchRadius^2, zw centre XZ
    'uniform vec4 uFlash;',          // xyz in-cloud flash radiance, w lobe tightness
    'uniform vec3 uFlashDir;',       // unit, points TOWARD the strike
    'varying vec3 vDir;',
    GLSL_NOISE,

    // Sparse star field. One hash per cell keeps it cheap; the magnitude^4
    // falloff means most cells hold a faint star and only a few hold a bright
    // one, which is what a real sky's magnitude distribution looks like.
    'vec3 gbStars( vec3 d, float t ) {',
    '  vec3 p = d * 190.0;',
    '  vec3 i = floor( p ); vec3 f = fract( p );',
    '  float h = gbHash13( i );',
    '  if ( h < 0.988 ) return vec3( 0.0 );',
    '  vec3 o = gbHash33( i + 1.7 );',
    '  float dd = length( f - o );',
    '  float mag = ( h - 0.988 ) / 0.012;',
    '  float tw = 0.74 + 0.26 * sin( t * ( 1.6 + 5.0 * o.x ) + o.y * 37.0 );',
    // smoothstep() is only defined for edge0 < edge1, so every falloff in this
    // file is written as 1.0 - smoothstep( lo, hi, x ) rather than reversed.
    '  float s = ( 1.0 - smoothstep( 0.0, 0.22, dd ) ) * pow( mag, 4.0 ) * tw;',
    // hot blue-white through cool orange, biased to white
    '  vec3 tint = mix( vec3( 1.0, 0.86, 0.68 ), vec3( 0.74, 0.83, 1.0 ), o.z );',
    '  return tint * s;',
    '}',

    'void main() {',
    '  vec3 d = normalize( vDir );',

    // ---- sun-relative LUT lookup -----------------------------------------
    '  vec2 sh = uSunDir.xz; vec2 dh = d.xz;',
    '  float shl = length( sh ); float dhl = length( dh );',
    '  float cosAz = ( shl > 1e-5 && dhl > 1e-5 ) ? clamp( dot( sh, dh ) / ( shl * dhl ), -1.0, 1.0 ) : 1.0;',
    '  float u = acos( cosAz ) / GB_PI;',
    // sign(y)*sqrt(|y|) packs extra rows near the horizon where the gradient is
    '  float tv = d.y < 0.0 ? -sqrt( -d.y ) : sqrt( d.y );',
    '  vec2 uv = vec2( clamp( u, 0.003, 0.997 ), clamp( 0.5 + 0.5 * tv, 0.006, 0.994 ) );',
    '  vec3 intR = texture2D( uLutA, uv ).rgb;',
    '  vec3 intM = texture2D( uLutB, uv ).rgb;',
    '  vec3 iso = texture2D( uLutC, uv ).rgb;',

    // ---- phase functions, evaluated per pixel -----------------------------
    '  float cosT = clamp( dot( d, uSunDir ), -1.0, 1.0 );',
    '  float pr = 0.0596831 * ( 1.0 + cosT * cosT );',
    '  float g = uP.x; float gg = g * g;',
    '  float den = max( 1e-4, 1.0 + gg - 2.0 * g * cosT );',
    '  float pm = ( 1.0 - gg ) / ( 12.5663706 * den * sqrt( den ) );',
    '  vec3 col = ( intR * pr + intM * pm ) * uP.w + iso;',

    // ---- display shoulder --------------------------------------------------
    // Gain + soft knee on the VISIBLE dome only; _regenerateEnvironment sets
    // uDay.x = 1 and pushes the knee out of range while it captures the probe,
    // so the light the scene receives is the unmodified physical field. See
    // DAY_GAIN for the measurements this exists to fix. Hue is preserved
    // exactly - the roll is applied to luminance and scaled back onto the
    // triple, the same contract _capRadiance honours on the CPU side.
    '  if ( uDay.x < 0.999 ) {',
    '    col *= uDay.x;',
    '    float dl = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '    float dspan = uDay.z - uDay.y;',
    '    if ( dl > uDay.y && dspan > 1e-6 ) {',
    '      float rolled = uDay.y + dspan * ( 1.0 - exp( - ( dl - uDay.y ) / dspan ) );',
    '      col *= rolled / max( dl, 1e-6 );',
    '    }',
    '  }',

    // ---- haze band -------------------------------------------------------
    // A LIGHT touch above the horizon only. The haze colour is the same one the
    // fog chunk paints on geometry, so distant buildings and the sky share a
    // family - but they must NOT share a value. The sky at the horizon is an
    // infinite scattering path and is legitimately several times brighter than
    // a building 200 m away; blending the sky all the way to the fog colour is
    // what turns a hazy street into a white veil and erases every silhouette.
    // uMode.y therefore stays small: it ties the hue, not the exposure.
    '  float fg = uMode.z; float fg2 = fg * fg;',
    '  float fdn = max( 1e-3, 1.0 + fg2 - 2.0 * fg * cosT );',
    '  float fhg = ( 1.0 - fg2 ) / ( fdn * sqrt( fdn ) );',
    '  vec3 haze = mix( uHazeSky, uHazeSun, clamp( ( fhg - 0.42 ) * 0.34, 0.0, 1.0 ) );',
    '  float hz = uMode.y * exp( -abs( d.y ) * 9.0 );',
    '  float hazeMix = clamp( hz, 0.0, 0.96 );',
    '  col = mix( col, haze, hazeMix );',

    // ---- the ground half of the dome --------------------------------------
    // This used to be a smoothstep over ( -0.035, 0.045 ) - 4.6 degrees, about
    // 44 px at a 75 deg FOV - grading from the atmospheric horizon radiance
    // straight onto uHazeGnd. Those two values differ by nearly a factor of ten
    // near the sun, so it drew a hard line across the frame with a flat cream
    // plateau under it: an ocean behind a desert city. Measured 0.084 of
    // luminance across five pixels.
    //
    // The fix is structural, not a wider smoothstep. The transition now starts
    // FROM col itself and decays toward the bounce term, so the two sides agree
    // exactly at d.y = 0 by construction and there is no value step to find at
    // any width. exp() rather than smoothstep because it has no far edge either
    // - the eye cannot locate the end of the ramp any more than the start.
    //
    // uHazeGnd remains the warm sand-bounce term: it is what fills the lower
    // hemisphere of the IBL and therefore what puts warm light under every
    // ledge, and the atmosphere's own ground-bounce integral is ~6x too dark
    // to do that job.
    //
    // A two-octave azimuthal ridge displaces the midpoint by ~1 degree, which
    // reads as a distant haze-buried ridgeline and breaks the one remaining cue
    // that this is a mathematical horizon: its perfect straightness.
    '  vec2 hn = d.xz / max( length( d.xz ), 1e-4 );',
    '  float rg = gbValue3( vec3( hn * 2.6, 0.0 ) ) * 0.62',
    '           + gbValue3( vec3( hn * 6.1 + 4.0, 1.0 ) ) * 0.38;',
    '  float hOfs = ( rg - 0.5 ) * 0.022;',
    '  float deep = 1.0 - exp( min( d.y + hOfs, 0.0 ) * 5.0 );',
    '  col = mix( col, uHazeGnd, deep * 0.93 );',
    // Anything analytic that is added AFTER the dome colour (sun disc, moon,
    // stars) has to be occluded by the ground, or a set sun paints its disc
    // onto the dirt. That occluder is a GEOMETRIC horizon and stays narrow -
    // it is deliberately decoupled from the wide visual transition above.
    '  float gndOcc = 1.0 - smoothstep( -0.055, 0.008, d.y );',
    '  float clearAmt = ( 1.0 - hazeMix * 0.72 ) * ( 1.0 - gndOcc * 0.97 );',

    // ---- cloud band -------------------------------------------------------
    // Two-octave analytic cloud, no texture. The planar projection d.xz / d.y
    // converges toward the horizon for free, so the deck compresses at the
    // skyline exactly as a real one does, and the band is faded in above ~7 deg
    // so it never fights the haze or aliases where that projection blows up.
    // Lit and shadow colours are both derived from keyRef on the CPU, so the
    // cloud can never drift away from the atmosphere it sits in.
    '  float cloudA = 0.0;',
    '  if ( uCloud.y > 0.002 && d.y > 0.02 ) {',
    '    vec2 cp = d.xz / max( d.y, 0.09 ) * uDay.w;',
    '    vec2 cw = vec2( uCloud.w * 0.9, uCloud.w * 0.35 );',
    '    vec3 cq = vec3( cp * 0.62 + cw, 0.0 );',
    '    float cf = gbValue3( cq ) * 0.56 + gbValue3( cq * 2.17 + 7.3 ) * 0.29',
    '             + gbValue3( cq * 4.90 + 19.1 ) * 0.15;',
    '    float band = smoothstep( 0.12, 0.33, d.y );',
    // Keep a clearing around the sun so the disc is never swallowed - a cloud
    // in front of a 300x disc would cost the one element the frame needs most,
    // and at these angles the aureole hides the hole completely.
    '    float hole = 1.0 - 0.88 * pow( clamp( cosT, 0.0, 1.0 ), 22.0 );',
    '    cloudA = smoothstep( uCloud.x, uCloud.x + 0.20, cf ) * band * uCloud.y * hole;',
    '    if ( cloudA > 0.003 ) {',
    '      vec2 sp = uSunDir.xz / max( length( uSunDir.xz ), 1e-4 ) * 0.55 * uDay.w;',
    '      vec3 cq2 = vec3( ( cp + sp ) * 0.62 + cw, 0.0 );',
    '      float cf2 = gbValue3( cq2 ) * 0.56 + gbValue3( cq2 * 2.17 + 7.3 ) * 0.29',
    '                + gbValue3( cq2 * 4.90 + 19.1 ) * 0.15;',
    '      float lit = exp( -max( 0.0, cf2 - uCloud.x ) * uCloud.z );',
    // Silver lining: forward scattering through a thin edge, strongest looking
    // toward the sun and on the thinnest part of the cloud.
    '      float silver = pow( clamp( cosT, 0.0, 1.0 ), 5.0 )',
    '                   * ( 1.0 - smoothstep( uCloud.x, uCloud.x + 0.34, cf ) ) * 1.6;',
    '      vec3 cc = uCloudAmb + uCloudSun * ( lit + silver );',
    '      col = mix( col, cc, clamp( cloudA, 0.0, 0.94 ) );',
    '    }',
    '  }',

    // ---- STORM DECK (level 2) ---------------------------------------------
    // Skipped entirely when uStorm.x is 0, which is every frame of level 1.
    //
    // The projection d.xz / (elev + h) is a plane at height ~1/h seen from
    // under it. Written that way rather than as d.xz / d.y because the naive
    // form runs to infinity at the skyline: the noise frequency explodes, the
    // deck aliases into a shimmering band and no amount of mip biasing saves
    // it. Adding h SATURATES the projection at 1/h, which both bounds the
    // frequency and reproduces the real thing - a deck really does compress
    // into an unresolvable smear at the horizon.
    //
    // TWO of them, at different h, drifting at different rates: that is the
    // parallax that makes this a volume with a base rather than wallpaper.
    '  if ( uStorm.x > 0.002 ) {',
    '    float stEl = max( d.y, -0.03 );',
    // Rotate into the WIND frame and squash along it. A storm deck is sheared:
    // the cells are drawn out into rolls lying along the wind, and an isotropic
    // fbm reads as fair-weather cumulus however dark you make it. uStorm.w
    // carries the wind bearing so the shear turns with the weather instead of
    // pointing wherever the author happened to leave it.
    '    float stCa = cos( uStorm.w ), stSa = sin( uStorm.w );',
    '    vec2 stAx = vec2( d.x * stCa + d.z * stSa, -d.x * stSa + d.z * stCa );',
    '    vec2 stNear = stAx / ( stEl + 0.15 ) * vec2( 0.48, 1.12 );',
    '    vec2 stFar  = stAx / ( stEl + 0.42 ) * vec2( 0.55, 1.05 );',
    // SCALE IS THE WHOLE BALLGAME HERE, and it was got wrong first time in
    // exactly the way the clear-sky deck above was got wrong a round earlier:
    // at 0.115 the entire upper dome sampled about a fifth of one tile, so the
    // "storm" was a single soft blob draped over half the sky and a clear
    // gradient over the other half. The projection magnitude runs from 0 at the
    // zenith to 1/0.15 = 6.7 at the skyline, so a multiplier of 0.80 puts about
    // 1.2 tiles across the sky at 30 degrees of elevation and 5.3 at the
    // horizon - real masses overhead compressing into an unresolvable band at
    // the skyline, which is what a deck does.
    //
    // The three layers are deliberately split across the two projections: the
    // broad masses and the low ragged scud ride the NEAR deck, the mid
    // structure rides the FAR one. They therefore slide over each other at
    // different rates under the same wind, which is the parallax.
    // stMacro is the weather SYSTEM: which half of the sky is bruised and
    // which is thinning out. Sampled off the far deck at a very low frequency
    // so it barely moves - a front crosses the terminal in minutes, the scud
    // under it in seconds.
    '    float stMacro = texture2D( uStormTex, stFar * 0.28 + uStormDrift.zw ).r;',
    '    vec4 stA = texture2D( uStormTex, stNear * 0.80 + uStormDrift.xy );',
    '    vec4 stB = texture2D( uStormTex, stFar * 2.10 - uStormDrift.zw * 1.55 + vec2( 0.37, 0.11 ) );',
    '    vec4 stC = texture2D( uStormTex, stNear * 3.60 + uStormDrift.xy * 2.20 + vec2( 0.63, 0.29 ) );',
    '    float stDen = stA.r * 0.52 + stB.g * 0.30 + stC.a * 0.18;',
    '    stDen *= 0.42 + 1.16 * stMacro;',
    // The sagging cells of the cloud base. This is the term the underglow
    // lands on; without it the orange is a flat wash and the whole effect
    // reads as a gradient rather than as lit geometry.
    //
    // The wisp channel is folded into the cell term on purpose. Worley on its
    // own is a field of CIRCLES, and at the horizon compression it printed as
    // discrete dark dots across the deck rather than as torn cloud. A fifth of
    // ridged noise breaks the roundness without costing a texture fetch - stC
    // is already sampled for the density.
    '    float stCell = stA.b * 0.50 + stB.b * 0.30 + stC.a * 0.20;',
    '    stDen += ( stCell - 0.5 ) * 0.20 * uStorm.z;',
    '    float stCov = smoothstep( uStorm.y, uStorm.y + ' + STORM_COVER_SPAN.toFixed(3) + ', stDen );',
    // Below the skyline the plane projection folds back on itself - |d.xz|
    // shrinks toward the nadir while the divisor is pinned - and the deck
    // smears into radial streaks under the horizon. Gate it out on the same
    // narrow window the sun/moon occluder uses, and let the ground bounce own
    // that half of the dome exactly as it does with a clear sky.
    '    stCov *= smoothstep( -0.025, 0.015, d.y );',
    '    float stThick = smoothstep( 0.16, 0.90, stDen );',
    '    float stTrans = ( 1.0 - stThick ) * ( 1.0 - stThick );',
    // ---- what the deck is actually made of ---------------------------------
    // Two independent terms, and getting their SIGNS the right way round is
    // the difference between a storm and a summer afternoon.
    //
    //   TRANSMISSION (cold, from above). Only thin cloud passes it. This is
    //   the "light leaking through the thinner patches" that keeps the lid
    //   from being a flat card - but it is faint, because there is very little
    //   above the deck at 02:00 to leak.
    //
    //   BACK-SCATTER (warm, from below). This is the whole show. Ground light
    //   entering the cloud base is scattered back down again, and THICK cloud
    //   returns MORE of it - a thin wisp lets the sodium straight through and
    //   out the top. So thick = bright and orange, thin = dark and cold, and
    //   the gaps between the masses are the deepest black in the frame.
    //
    // The first version of this had it exactly backwards - deck brightness ran
    // on 1/thickness for BOTH terms, so the thin patches were the bright ones
    // and the warm glow was strongest where the cloud was darkest. Measured on
    // the probe: white cumulus puffs on an amber field, which is a fair-weather
    // sky at golden hour, i.e. level 1's palette on the level that exists to be
    // its opposite.
    '    float stHor = exp( - max( stEl, 0.0 ) * 3.2 );',
    '    vec3 stAmb = mix( uStormHigh, uStormLow, stHor );',
    // HUE structure, not luminance structure. The two ends of this mix are
    // luminance-matched to within 2%, so it costs the deck nothing in level -
    // but a thin patch at 02:00 is showing the residual blue of the column
    // above it while a thick base is the part actually holding the town's
    // light, and that difference is most of why a real overcast reads as
    // WEATHER rather than as a grey ramp. A deck that varies only in brightness
    // is a gradient; one that varies in colour is cloud.
    '    vec3 stTint = mix( vec3( 0.88, 0.99, 1.17 ), vec3( 1.08, 1.00, 0.90 ), stThick );',
    // STORM_DECK_MIN is a FLOOR, not a taste call: the darkest place in this
    // sky is thick cloud high up, where there is neither transmission from
    // above nor underglow from below, and ARCHITECTURE 7.6 and the harbor art
    // direction both forbid crushing it to nothing.
    //
    // The RANGE around it is deliberately wider than the mean is high (0.18 to
    // 1.16 about a mean of 0.37): the deck's depth is the spread, not the
    // level.
    '    vec3 stDeck = stAmb * stTint',
    '               * ( ' + STORM_DECK_MIN.toFixed(3) + ' + ' + STORM_DECK_RANGE.toFixed(3) + ' * stTrans );',
    // Back-scatter saturates: past a few hundred metres of cloud the base
    // stops getting any better at returning light.
    '    float stRefl = stThick * ( ' + STORM_REFL_A.toFixed(3) + ' - ' + STORM_REFL_B.toFixed(3) + ' * stThick );',
    // ---- WHERE the sodium is, and this is the structural half of the fix ----
    //
    // The underglow used to depend on ELEVATION ALONE, which means it was
    // identical in every compass direction: a continuous amber ring painted
    // right round the sky at a fixed height. Nothing outdoors does that. A
    // terminal is a FINITE lit patch a few hundred metres across under a cloud
    // base a few hundred metres up, so the cloud directly over the lit apron
    // is bright, the cloud over the black water beyond the quay is not, and
    // what you actually see from inside a port at night is warm PATCHES on the
    // base with cold bruised gaps between them. Measured: the old uniform ring
    // put the deck at RGB(148,79,35) across the whole upper half of the quay
    // framing - a single flat colour field, i.e. a backdrop card, and the
    // brightest thing in a two-in-the-morning photograph.
    //
    // hn is already the normalised horizontal view direction (the clear-sky
    // horizon ridge computes it a few lines up), so tracing a CIRCLE through
    // the deck texture with it gives a smooth, exactly periodic function of
    // compass bearing for free - no seam is possible, because the sample path
    // closes on itself. Two radii: 0.155 puts about three broad lobes around
    // the horizon (the terminal, the town behind it, the far basin), 0.430 puts
    // finer structure inside them. Both drift with the far deck, so the lit
    // patches breathe as the cloud moves over the lamps rather than being
    // painted on.
    '    float stAzA = texture2D( uStormTex, hn * 0.155 + uStormDrift.zw * 0.30 + vec2( 0.31, 0.67 ) ).r;',
    '    float stAzB = texture2D( uStormTex, hn * 0.430 - uStormDrift.zw * 0.50 + vec2( 0.72, 0.18 ) ).r;',
    // A NARROW window on a field whose spread is about 0.12: that is what turns
    // a gentle modulation into genuine lobes with genuine gaps between them.
    '    float stAz = ' + STORM_GLOW_FLOOR.toFixed(3) + ' + ' + (1.0 - STORM_GLOW_FLOOR).toFixed(3),
    '               * smoothstep( 0.38, 0.66, stAzA * 0.72 + stAzB * 0.28 );',
    '    float stGlow = exp( - max( stEl, 0.0 ) / ' + STORM_GLOW_FALL.toFixed(3) + ' ) * stAz',
    '                 * ( ' + STORM_MACRO_LO.toFixed(3) + ' + ' + STORM_MACRO_HI.toFixed(3) + ' * stMacro );',
    // The cells hang below the deck, so they are nearer the lamps and catch
    // more. This is the term that turns a warm gradient into lit geometry.
    '    float stBulge = ' + STORM_CELL_LO.toFixed(3) + ' + ' + STORM_CELL_HI.toFixed(3) + ' * stCell;',
    '    stDeck += uStormGlow * stGlow * stRefl * stBulge;',
    // ---- GROUND BOUNCE: the terminal's own lamps on the base overhead -------
    //
    // Where the previous term asks "how low am I looking", this one asks "what
    // is UNDER the piece of cloud I am looking at". The view ray is intersected
    // with the cloud base plane in WORLD space and the answer is the horizontal
    // distance from that intersection to the terminal's lamp cluster, so the
    // glow stays nailed over the apron while the camera moves and turns - which
    // is the depth cue, and the reason this cannot be baked into an elevation
    // curve. A Lorentzian rather than a Gaussian falloff on purpose: a lit
    // patch under a scattering slab has long tails (that is the same lateral
    // multiple scattering STORM_DECK_FLOOR models), so the dome has to reach
    // several patch-radii out at a few per cent instead of stopping dead.
    //
    // d.y is floored well above zero: at the skyline the intersection runs to
    // infinity, which is both numerically unpleasant and, once the ray is
    // pointing past the far side of the lit patch, physically over.
    '    float stRise = max( uStormBase.x - cameraPosition.y, 6.0 );',
    '    vec2 stHit = cameraPosition.xz + d.xz * ( stRise / max( d.y, 0.05 ) ) - uStormBase.zw;',
    '    float stDome = 1.0 / ( 1.0 + dot( stHit, stHit ) * uStormBase.y );',
    '    stDome *= ' + STORM_BOUNCE_AZ_LO.toFixed(3) + ' + ' +
      STORM_BOUNCE_AZ_HI.toFixed(3) + ' * stAz;',
    '    stDeck += uStormBounce * stDome * stRefl * stBulge;',
    // Lateral multiple scattering inside the deck: a soft floor that lifts the
    // darkest cloud without moving the lit band. See STORM_DECK_FLOOR. Applied
    // BEFORE the strike, which must keep its full contrast against it.
    '    vec3 stFlr = vec3( ' + STORM_DECK_FLOOR[0].toFixed(5) + ', ' +
      STORM_DECK_FLOOR[1].toFixed(5) + ', ' + STORM_DECK_FLOOR[2].toFixed(5) + ' );',
    '    stDeck = stFlr + stDeck * stDeck / max( stDeck + stFlr, vec3( 1e-6 ) );',
    // Mid-frequency structure, applied AFTER the toe so the floored regions
    // keep their cloud shape instead of printing as a flat card. Mean 1.0.
    '    stDeck *= ' + STORM_BAND_LO.toFixed(3) + ' + ' + STORM_BAND_HI.toFixed(3) + ' * stB.g;',
    // ...and the RELIEF of the base itself, on the same schedule and for the
    // same measured reason. Until now the sagging cells only ever modulated the
    // warm terms, so wherever the sodium did not reach - which after the glow
    // moved overhead is most of the lower dome - the deck had exactly one
    // spatial field in it (the mid-frequency band) and read as a soft gradient
    // with smudges: measured on harbor_overview at a sky-band local RMS of
    // 0.070 on a mean of 0.155, most of which was the band alone. This is a
    // second, independent, higher-frequency field, and because its mean is
    // exactly 1.0 against a cell channel whose mean is 0.5 it buys that
    // structure at zero cost to the level, the vertical balance or the meter.
    '    stDeck *= 0.74 + 0.52 * stCell;',
    // ---- sheet lightning INSIDE the deck ----------------------------------
    // The strike is inside the cloud, so the cloud is the emitter: thick cloud
    // near uFlashDir glows, thin cloud barely lifts, and the far side of the
    // sky picks up only the broad lobe. That difference is what separates a
    // storm from a white screen fade.
    '    float stFl = uFlash.x + uFlash.y + uFlash.z;',
    '    float stEsc = 0.0;',
    '    if ( stFl > 1e-5 ) {',
    '      float stFd = dot( d, uFlashDir );',
    '      float stLobe = pow( max( stFd * 0.5 + 0.5, 0.0 ), max( uFlash.w, 1.0 ) );',
    '      float stCore = pow( max( stFd, 0.0 ), max( uFlash.w, 1.0 ) * ' +
      STORM_FLASH_CORE_P.toFixed(2) + ' );',
    '      stDeck += uFlash.xyz * ( stLobe * ' + STORM_FLASH_LOBE.toFixed(3) +
      ' + stCore * ' + STORM_FLASH_CORE.toFixed(3) + ' ) * ( 0.18 + 0.95 * stThick );',
    '      stEsc = stLobe;',
    '    }',
    '    col = mix( col, stDeck, clamp( stCov * uStorm.x, 0.0, 1.0 ) );',
    // The deck must not wrap under the skyline. Re-apply the SAME ground blend
    // the clear path used a few lines up, with the same `deep` term, so the two
    // agree exactly at d.y = 0 and no new seam can appear at any width.
    // A little of the strike escapes the deck entirely and lights the clear
    // air below it, so the whole sky lifts a touch even where there is no
    // cloud. Faded out by `deep` so it does not glow up out of the sea.
    //
    // Weighted by the LOBE now, and the coefficient cut to a quarter. It used
    // to be an omnidirectional 0.020 of the flash radiance, which was harmless
    // while that radiance was a fixed 0.25 and is a flat lift over every pixel
    // of the dome now that it is derived from the key (an order of magnitude
    // more). An undirected additive term applied to the whole sky IS the
    // full-screen white fade ART_DIRECTION_HARBOR forbids, however it is
    // spelled - so the escaping light gets the same direction the emission has.
    '    if ( stFl > 1e-5 ) col += uFlash.xyz * 0.0050 * stEsc * uStorm.x * ( 1.0 - deep );',
    '    col = mix( col, uHazeGnd, deep * 0.93 * uStorm.x );',
    // Nothing celestial survives two kilometres of nimbostratus: no sun disc,
    // no moon disc, no moon halo, no stars, no milky way.
    '    clearAmt *= 1.0 - uStorm.x;',
    '  }',

    // ---- sun disc with per-channel limb darkening -------------------------
    // I(mu)/I(0) = 1 - u*(1-mu); u is larger at short wavelengths, which is why
    // the solar limb reads warmer than the centre.
    '  float ang = acos( cosT );',
    '  float rr = ang / uP.z;',
    '  float rc = min( rr, 1.0 );',
    '  float mu = sqrt( max( 0.0, 1.0 - rc * rc ) );',
    '  vec3 limb = clamp( vec3( 1.0 ) - vec3( 0.40, 0.55, 0.72 ) * ( 1.0 - mu ), 0.0, 1.0 );',
    '  float disc = 1.0 - smoothstep( 0.90, 1.006, rr );',
    '  col += uSunDisc * limb * disc * uMode.x * clearAmt;',

    // ---- night: moon, stars, milky way ------------------------------------
    '  if ( uN.x > 0.002 ) {',
    '    vec3 night = vec3( 0.0 );',
    '    float cosM = clamp( dot( d, uMoonDir ), -1.0, 1.0 );',
    '    float angM = acos( cosM );',
    '    night += uMoonColor * ( exp( -angM * 8.0 ) * 0.16 + exp( -angM * 40.0 ) * 0.55 ) * clearAmt;',
    '    if ( angM < uP.y * 1.02 ) {',
    '      vec3 up0 = abs( uMoonDir.y ) > 0.98 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );',
    '      vec3 tX = normalize( cross( up0, uMoonDir ) );',
    '      vec3 tY = cross( uMoonDir, tX );',
    '      vec2 mc = vec2( dot( d, tX ), dot( d, tY ) ) / uP.y;',
    '      float m2 = dot( mc, mc );',
    '      if ( m2 < 1.0 ) {',
    '        float mz = sqrt( max( 0.0, 1.0 - m2 ) );',
    // surface normal of the visible point, in world space
    '        vec3 nw = mc.x * tX + mc.y * tY - mz * uMoonDir;',
    '        float lit = pow( clamp( dot( nw, uSunDir ), 0.0, 1.0 ), 0.55 );',
    '        float maria = 0.78 + 0.30 * gbValue3( vec3( mc * 3.1, 0.0 ) )',
    '                    - 0.22 * smoothstep( 0.42, 0.92, gbValue3( vec3( mc * 1.4 + 4.0, 1.0 ) ) );',
    '        float aa = 1.0 - smoothstep( 0.982, 1.0, sqrt( m2 ) );',
    '        night += uMoonColor * lit * maria * aa * 8.5 * clearAmt;',
    '      }',
    '    }',
    '    float starMask = clearAmt * ( 1.0 - smoothstep( 0.02, 0.24, hazeMix ) )',
    '                   * ( 1.0 - clamp( cloudA, 0.0, 1.0 ) );',
    '    night += gbStars( d, uN.w ) * uN.y * starMask;',
    // A faint, tilted galactic band so the zenith is not an empty flat field.
    // Kept narrow and high-frequency: at low frequency it reads as cloud, which
    // is worse than having no milky way at all.
    '    vec3 galN = normalize( vec3( 0.42, 0.80, -0.43 ) );',
    '    float band = exp( -pow( dot( d, galN ) * 4.2, 2.0 ) );',
    '    float mw = gbValue3( d * 80.0 ) * 0.55 + gbValue3( d * 190.0 ) * 0.45;',
    // MILKYWAY_LUM x SKY_SCALE, so the band shares the exposure budget of every
    // other authored night layer instead of drifting when SKY_SCALE is retuned.
    '    night += vec3( 0.64, 0.70, 0.92 ) * band * mw * mw * uMode.w * starMask;',
    '    col += night * uN.x;',
    '  }',

    // Fine dither to break 16-bit contour rings in the gradient. It has to be
    // RELATIVE, not a fixed offset: the night sky sits around 0.005, where any
    // absolute dither large enough to help daylight is pure visible noise.
    '  float dth = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
    '  col *= 1.0 + ( dth - 0.5 ) * 0.0035;',

    '  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  // ---- floating dust motes -------------------------------------------------
  //
  // A mote field with no occlusion is not atmosphere, it is sensor dust. The
  // first version mixed sky and sun colour purely by view angle, so a mote in
  // the shop interior, a mote in the alley's deep shade and a mote in full sun
  // all rendered at the same brightness - and, worst of all, motes drew as
  // white specks against the OPEN SKY in the rooftop and street captures, where
  // by definition there is no shaft and nothing should be visible at all
  // (measured: 14,857 pixels in rooftop's sky band more than 0.10 over the band
  // median). A uniform field is also actively harmful: it is a flat additive
  // lift everywhere, i.e. the same milky veil the volumetric pass is carefully
  // written to avoid.
  //
  // Three fixes, all here:
  //   1. the field is shadow-tested against cascade 0 of lighting.js's CSM, so
  //      a mote in shade collapses to sky colour and the field becomes a shaft
  //      INDICATOR instead of noise;
  //   2. the cell and the distance fade are pulled in so nothing draws at a
  //      range where it could sit on the skyline;
  //   3. motes well above the eye fade out, because those are the ones that
  //      silhouette against sky rather than against geometry.
  var DUST_VERT = [
    'attribute vec4 aSeed;',        // x phase, y drift speed, z size, w brightness
    'uniform vec3 uCamPos;',
    'uniform vec3 uCell;',
    'uniform vec3 uSunDir;',
    'uniform vec2 uT;',             // x time, y pixels-per-world-unit-at-1m
    'uniform mat4 uShadowMat;',
    'varying float vAlpha;',
    'varying float vScatter;',
    'varying vec4 vShadow;',
    'void main() {',
    '  vec3 p = position;',
    '  float ph = aSeed.x * 6.2831853;',
    '  p.x += sin( uT.x * aSeed.y + ph ) * 0.45;',
    '  p.y += sin( uT.x * aSeed.y * 0.61 + ph * 1.7 ) * 0.30 + uT.x * aSeed.y * 0.06;',
    '  p.z += cos( uT.x * aSeed.y * 0.83 + ph * 2.3 ) * 0.45;',
    // Wrap the mote cloud around the eye so the player is always inside it
    // without ever simulating more than a few hundred motes.
    '  vec3 rel = mod( p - uCamPos + uCell * 0.5, uCell ) - uCell * 0.5;',
    '  vec3 world = uCamPos + rel;',
    '  vec4 mv = viewMatrix * vec4( world, 1.0 );',
    '  float dist = max( -mv.z, 0.02 );',
    '  gl_Position = projectionMatrix * mv;',
    '  gl_PointSize = clamp( aSeed.z * uT.y / dist, 1.0, 11.0 );',
    '  vShadow = uShadowMat * vec4( world, 1.0 );',
    '  vec3 a = abs( rel ) / ( uCell * 0.5 );',
    '  float edge = 1.0 - smoothstep( 0.70, 0.99, max( a.x, max( a.y, a.z ) ) );',
    // Gone by 11 m: past that a mote is small enough to alias into a hot pixel
    // and far enough to clear a parapet and land on open sky.
    '  float rng = smoothstep( 0.30, 1.4, dist ) * ( 1.0 - smoothstep( 7.0, 11.0, dist ) );',
    // Motes more than a couple of metres over the eye are the ones that project
    // above the skyline. Dust settles anyway - a real shaft is thickest low.
    '  float lift = 1.0 - smoothstep( 1.3, 3.3, rel.y );',
    // ...and the ones that actually LAND on open sky are the ones whose line of
    // sight rises. A mote is only ever visible against something darker than
    // itself, so a rising ray is the cheap, exact, depth-free test for "this
    // speck is about to sit on the sky". Without it the field printed as sensor
    // dust across the rooftop and overview skylines however tightly the cell
    // and the distance fade were pulled in. Dust in a street is a LOW
    // phenomenon anyway - you see the shaft, not the ceiling of it.
    // The max() is not decoration: rel can land exactly on zero (it is a mod),
    // and normalize(0) is NaN, which would poison vAlpha and vScatter for that
    // vertex - and NaN * 0.0 is still NaN, so the distance fade below would not
    // rescue it.
    '  vec3 vray = ( world - uCamPos ) / max( length( world - uCamPos ), 1e-4 );',
    '  float upFade = 1.0 - smoothstep( 0.05, 0.22, vray.y );',
    '  vAlpha = aSeed.w * edge * rng * lift * upFade;',
    // Forward scattering: a mote seen against the sun is far brighter than one
    // seen with the sun behind you. This is what makes the air read as thick.
    '  float c = dot( vray, uSunDir );',
    '  vScatter = pow( clamp( c * 0.5 + 0.5, 0.0, 1.0 ), 6.0 );',
    '}'
  ].join('\n');

  var DUST_FRAG = [
    'precision highp float;',
    'uniform vec3 uSunCol;',
    'uniform vec3 uSkyCol;',
    'uniform float uGain;',
    'uniform sampler2D uShadowMap;',
    'uniform vec2 uShadowP;',        // x enabled, y depth bias
    'varying float vAlpha;',
    'varying float vScatter;',
    'varying vec4 vShadow;',
    // UnpackFactors4 from three/src/renderers/shaders/ShaderChunk/packing.glsl.
    // Getting these wrong silently returns garbage rather than failing.
    'const vec4 GB_UNPACK = vec4( 0.99609375, 0.0038909912109375,',
    '                             0.0000151991844177, 0.0000000596046448 );',
    'void main() {',
    '  vec2 q = gl_PointCoord * 2.0 - 1.0;',
    '  float r2 = dot( q, q );',
    '  if ( r2 > 1.0 ) discard;',
    '  float soft = pow( 1.0 - r2, 1.7 );',
    '  float vis = 1.0;',
    '  if ( uShadowP.x > 0.5 ) {',
    '    vec3 sc = vShadow.xyz / max( abs( vShadow.w ) < 1e-6 ? 1e-6 : vShadow.w, 1e-6 );',
    // Outside the cascade there is no data; lit is the only sane guess, and the
    // fade above means anything out there is nearly transparent anyway.
    '    if ( sc.x > 0.004 && sc.x < 0.996 && sc.y > 0.004 && sc.y < 0.996 &&',
    '         sc.z > 0.0 && sc.z < 1.0 ) {',
    '      float dep = dot( texture2D( uShadowMap, sc.xy ), GB_UNPACK );',
    '      vis = step( sc.z - uShadowP.y, dep );',
    '    }',
    '  }',
    // A mote in shadow collapses EXACTLY to sky colour; the sun term is a pure
    // addition on top of it, gated by visibility.
    '  vec3 c = uSkyCol + uSunCol * ( vScatter * vis );',
    '  gl_FragColor = vec4( c * ( uGain * vAlpha * soft ), 1.0 );',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}'
  ].join('\n');

  // ==========================================================================
  // FOG
  //
  // Approach: patch THREE.ShaderChunk.fog_pars_vertex / fog_vertex /
  // fog_pars_fragment / fog_fragment ONCE, globally. Every built-in material in
  // the engine funnels through those four chunks, so every surface - level,
  // props, weapons, enemies, decals - is fogged with zero cooperation required
  // from the other thirteen modules. That is the only approach that actually
  // guarantees coverage; per-material onBeforeCompile would silently miss any
  // material created by an agent who did not read this file.
  //
  // The extra uniforms are injected into THREE.ShaderLib[*].uniforms at
  // construction time, before anything compiles. THREE.UniformsUtils.clone()
  // copies plain objects and typed arrays BY REFERENCE (only Color/Vector/
  // Matrix/Texture are deep-cloned), so every material ends up pointing at the
  // same Float32Array and a single write here updates the whole scene.
  //
  // Materials that are NOT built-ins (raw THREE.ShaderMaterial with its own
  // uniform block) will have those uniforms defaulted to zero by GL, which the
  // chunk detects and falls back to three's stock FogExp2 - never black fog.
  // Call sky.applyFogTo(material) to opt such a material fully in.
  //
  // Placement note: three inserts <fog_fragment> after <colorspace_fragment>.
  // With renderer.toneMapping = NoToneMapping (see ARCHITECTURE 7.2) and postfx
  // rendering into a linear HalfFloat target, linearToOutputTexel() is the
  // identity, so the fog blend still happens in linear HDR as it must.
  // ==========================================================================
  var FOG_PARS_VERTEX = [
    '#ifdef USE_FOG',
    '  varying float vFogDepth;',
    '  varying vec3 vFogViewPos;',
    '#endif'
  ].join('\n');

  var FOG_VERTEX = [
    '#ifdef USE_FOG',
    '  vFogDepth = - mvPosition.z;',
    // mvPosition is in scope everywhere three includes <fog_vertex> (including
    // the sprite and points shaders, which never define `transformed`), so
    // carrying view-space position is the only universally safe way to get the
    // world position back in the fragment shader.
    '  vFogViewPos = mvPosition.xyz;',
    '#endif'
  ].join('\n');

  var FOG_PARS_FRAGMENT = [
    '#ifdef USE_FOG',
    '  uniform vec3 fogColor;',
    '  varying float vFogDepth;',
    '  varying vec3 vFogViewPos;',
    '  #ifdef FOG_EXP2',
    '    uniform float fogDensity;',
    '  #else',
    '    uniform float fogNear;',
    '    uniform float fogFar;',
    '  #endif',
    '  uniform vec4 gbFogA;',        // x density, y 1/heightScale, z baseY, w startDist
    '  uniform vec4 gbFogB;',        // x maxOpacity, y mieG, z glowGain, w desaturate
    '  uniform vec3 gbFogSun;',
    '  uniform vec3 gbFogSky;',
    '  uniform vec3 gbFogGnd;',
    '  uniform vec3 gbFogSunDir;',
    '  vec3 gbApplyFog( vec3 col ) {',
    // view-space -> world-space offset. The view rotation is orthonormal, so
    // its inverse is its transpose and (M^T v).i == dot( M[i], v ).
    '    vec3 wOfs = vec3( dot( viewMatrix[ 0 ].xyz, vFogViewPos ),',
    '                      dot( viewMatrix[ 1 ].xyz, vFogViewPos ),',
    '                      dot( viewMatrix[ 2 ].xyz, vFogViewPos ) );',
    '    float dist = max( length( wOfs ), 1e-4 );',
    '    vec3 rd = wOfs / dist;',
    // Analytic integral of D * exp( -( y - baseY ) * k ) along the segment.
    '    float k = gbFogA.y;',
    '    float t0 = min( gbFogA.w, dist );',
    '    float seg = dist - t0;',
    '    float dStart = gbFogA.x * exp( - ( cameraPosition.y + rd.y * t0 - gbFogA.z ) * k );',
    '    float kd = k * rd.y;',
    '    float od = ( abs( kd ) > 1e-4 ) ? dStart * ( 1.0 - exp( - kd * seg ) ) / kd : dStart * seg;',
    '    float f = min( 1.0 - exp( - max( od, 0.0 ) ), gbFogB.x );',
    // Sun-direction dependent inscattering: a Henyey-Greenstein lobe remapped
    // to 0..1 so looking into the sun gives warm glowing haze and looking away
    // gives cool haze. This single term is what sells depth in a hazy street.
    '    float cs = dot( rd, gbFogSunDir );',
    '    float g2 = gbFogB.y * gbFogB.y;',
    '    float dn = max( 1e-3, 1.0 + g2 - 2.0 * gbFogB.y * cs );',
    '    float hg = ( 1.0 - g2 ) / ( dn * sqrt( dn ) );',
    '    float w = clamp( ( hg - 0.42 ) * 0.34 * gbFogB.z, 0.0, 1.6 );',
    '    vec3 fc = mix( gbFogSky, gbFogSun, min( w, 1.0 ) );',
    '    fc += gbFogSun * max( 0.0, w - 1.0 ) * 0.75;',
    '    fc = mix( fc, gbFogGnd, ( 1.0 - smoothstep( -0.42, -0.04, rd.y ) ) * 0.65 );',
    // Aerial perspective: distance eats local chroma before it eats luminance.
    '    float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '    col = mix( col, vec3( lum ), f * gbFogB.w );',
    '    return mix( col, fc, f );',
    '  }',
    '#endif'
  ].join('\n');

  var FOG_FRAGMENT = [
    '#ifdef USE_FOG',
    '  if ( gbFogA.x > 0.0 ) {',
    '    #ifdef GB_FOG_ADDITIVE',
    // Additive transients (tracers, flashes, sparks) must be *attenuated* by
    // haze, never tinted toward it, or they turn into glowing blobs.
    '      vec3 wOfsA = vec3( dot( viewMatrix[ 0 ].xyz, vFogViewPos ),',
    '                         dot( viewMatrix[ 1 ].xyz, vFogViewPos ),',
    '                         dot( viewMatrix[ 2 ].xyz, vFogViewPos ) );',
    '      float dA = max( length( wOfsA ), 1e-4 );',
    '      vec3 rdA = wOfsA / dA;',
    '      float t0A = min( gbFogA.w, dA );',
    '      float dSA = gbFogA.x * exp( - ( cameraPosition.y + rdA.y * t0A - gbFogA.z ) * gbFogA.y );',
    '      float kdA = gbFogA.y * rdA.y;',
    '      float odA = ( abs( kdA ) > 1e-4 ) ? dSA * ( 1.0 - exp( - kdA * ( dA - t0A ) ) ) / kdA : dSA * ( dA - t0A );',
    '      gl_FragColor.rgb *= exp( - max( odA, 0.0 ) );',
    '    #else',
    '      gl_FragColor.rgb = gbApplyFog( gl_FragColor.rgb );',
    '    #endif',
    '  } else {',
    // Fallback for shader materials that never received our uniforms.
    '    #ifdef FOG_EXP2',
    '      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
    '    #else',
    '      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
    '    #endif',
    '    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    '  }',
    '#endif'
  ].join('\n');

  // ==========================================================================
  // Sky
  // ==========================================================================
  function Sky(ctx) {
    this.ctx = ctx;
    this.name = 'sky';

    // ---- public contract ---------------------------------------------------
    this.envMap = null;
    this.sunDirection = new THREE.Vector3(-0.556, 0.242, -0.795).normalize();
    this.sunColor = new THREE.Color(1.0, 0.72, 0.45);
    this.sunIntensity = 5.2;
    this.timeOfDay = 0.3169;          // ~14 degrees of elevation, see _solar()

    // ---- extra published state other systems can lean on -------------------
    // sunDirection is the KEY LIGHT and swaps to the moon after dark so that
    // lighting.js always has a direction to hang a shadow caster on.
    // sunWorldDirection is always the real sun - the atmosphere, the sun disc
    // and every LUT lookup are expressed relative to it.
    this.sunWorldDirection = new THREE.Vector3(-0.556, 0.242, -0.795).normalize();
    this.moonDirection = new THREE.Vector3(0, 1, 0);
    this.moonColor = new THREE.Color(0.62, 0.70, 0.95);
    this.moonIntensity = 0.0;
    this.keyIsMoon = false;
    this.sunElevation = 0;            // radians
    this.sunAzimuth = 0;              // radians, 0 == pointing down -Z
    // Per-instance so a level with a differently-oriented street can retarget
    // the key without touching the module constant. See AZ_BASE.
    this.azimuthBase = AZ_BASE;
    this.skyColor = new THREE.Color(0.60, 0.72, 1.0);      // hemisphere "up"
    this.groundColor = new THREE.Color(0.42, 0.30, 0.19);  // hemisphere "down"
    // lighting.js reads sky.zenithColor for its HemisphereLight. It is a LIGHT
    // colour, so it is hue-normalised (max channel 1) rather than HDR radiance
    // - handing a hemisphere light a radiance would multiply the fill by the
    // sky's absolute brightness a second time.
    this.zenithColor = new THREE.Color(0.42, 0.60, 1.0);
    this.ambientColor = new THREE.Color(0.6, 0.7, 0.95);
    this.ambientIntensity = 0.55;
    this.horizonColor = new THREE.Color(1, 0.7, 0.4);
    // Mean radiance (not irradiance) of the sky strip a shadowed street surface
    // actually sees. Published so anything additive - dust, volumetrics - can
    // sit at the right level without re-deriving it.
    //
    // The seed value matters: _keyRef() reads it, and _keyRef() sets the dome
    // shoulder used by the very first _buildLut - one generation before
    // _deriveAmbient has had a chance to measure the real number. 0.10 is what
    // the model actually integrates to at the golden-hour default, so the
    // bootstrap pass and every pass after it agree.
    this.fillRadiance = 0.10;
    this.dustParticles = null;
    this.mesh = null;
    this.cubeTexture = null;

    // ---- fog parameters (world units are metres) ---------------------------
    //
    // These are tuned for a 14 m wide street between 12-16 m facades.
    //
    //  heightScale 5.5  the road hazes and the parapets stay crisp. At 13.0 the
    //                   layer was near-uniform from kerb to roofline, so there
    //                   was no vertical gradient left to separate a near
    //                   building from a far one.
    //  maxOpacity 0.86  a distant building must still read as a SILHOUETTE. At
    //                   0.965 the far end of the street dissolved into
    //                   featureless cream and every plane cue went with it.
    //                   0.95 was tried against the horizon seam on overview.png
    //                   (the hard straight edge where the level's distant
    //                   ground plane ends against the sky) and measured
    //                   IDENTICAL - that plane never reaches the opacity cap,
    //                   so the seam is its own dark albedo, not a fog residue,
    //                   and the fix belongs in level.js. Reverted rather than
    //                   left in: a change that cannot be shown to help is a
    //                   change that can only hurt.
    //  desaturate 0.18  aerial perspective should shift hue TOWARD the haze
    //                   (which the inscatter blend below already does), not
    //                   bleach the surface to grey on the way.
    this.fog = {
      density: 0.0150,     // extinction per metre at baseY
      heightScale: 5.5,    // e-folding height of the fog layer
      baseY: 0.0,
      startDistance: 2.5,
      maxOpacity: 0.86,
      mieG: 0.62,
      glowGain: 1.0,
      desaturate: 0.18,
      enabled: true
    };

    // ---- published atmosphere state (see _scheduleHaze) --------------------
    // The fog block above is the AUTHORED BASE and stays exactly where a caller
    // put it; these are the SCHEDULED values, and they are what every consumer
    // (including this module) should actually read.
    //
    //   fogDensityEffective  extinction per metre at baseY for the CURRENT time
    //                        of day. What the fog uniforms and scene.fog carry.
    //   fogStartEffective    near-field cutout, pulled in after dark.
    //   nightHazeGain        1.0 by day, ~2.4 at full night. How far the haze is
    //                        allowed to sit above the key reference after dark,
    //                        i.e. how bright a practical's halo is entitled to
    //                        be. lighting.js can size a halo card with it and
    //                        get the same answer this module fogs the scene to.
    //   scatterRadiance      single-scatter coefficient of the local air,
    //                        albedo * density / 4pi, in 1/(m.sr). The peak
    //                        radiance of the halo around a point light of
    //                        intensity I at radius r is ~ scatterRadiance * I/r
    //                        (times the phase function). Published so postfx can
    //                        add a per-practical inscatter term instead of being
    //                        key-only, and so nobody has to guess.
    this.fogDensityEffective = this.fog.density;
    this.fogStartEffective = this.fog.startDistance;
    this.nightHazeGain = 1.0;
    this.scatterRadiance = HAZE_ALBEDO * this.fog.density / (4.0 * PI);
    this._afterglowF = 0;
    this._nightF = 0;
    this._deepNightF = 0;

    // ---- weather (level 2) -------------------------------------------------
    // weatherPreset is published so anyone can ask what the sky thinks it is
    // doing; _stormF is the single gate every added branch tests. Both are the
    // clear-sky values here and only setWeather() (or a levelDef that names a
    // preset) ever moves them, which is what keeps level 1 untouched.
    this.weatherPreset = 'clear';
    this._stormF = 0;
    this._stormTex = null;
    this._pendingWeather = null;
    // Wind-integrated deck drift. Integrated rather than time * speed so the
    // deck does not jump when weather.js ramps its wind.
    this._driftNear = new THREE.Vector2(0, 0);
    this._driftFar = new THREE.Vector2(0, 0);
    // Wind bearing, radians. The deck's shear axis, so the rolls lie along the
    // wind rather than along whatever axis the noise happened to prefer.
    this._windAngle = Math.atan2(-0.16, 0.28);
    // Last values read off ctx.weather, so update() only does work on change.
    this._wxFog = 0;
    this._wxFogApplied = -1;
    this._wxFlash = 0;
    this._flashDir = new THREE.Vector3(0.42, 0.62, -0.66).normalize();
    this._flashRGB = new THREE.Vector3(0, 0, 0);
    // ---- ground-bounce dome geometry ---------------------------------------
    // Authored defaults; _syncBounceCentre replaces them with the terminal's
    // OWN lamp survey the first frame ctx.level publishes one, so the glow sits
    // over the lamps that actually exist rather than over a number typed here.
    this._bounceH = STORM_BOUNCE_H;
    this._bounceR = STORM_BOUNCE_R;
    this._bounceCtr = new THREE.Vector2(STORM_BOUNCE_CTR[0], STORM_BOUNCE_CTR[1]);
    this._bounceSolved = false;
    // Key irradiance the scene receives per unit of weather.flash. Observed off
    // ctx.lighting rather than assumed, so the deck and the key can never again
    // size the same strike from unrelated constants. See STORM_FLASH_Q.
    this._keyPerFlash = STORM_FLASH_KEY_DEF;
    this._flashPrevRead = 0;
    // Autonomous fallback lightning, used ONLY when ctx.weather is absent
    // entirely (a build where fx/weather.js failed to load). It exists so a
    // storm sky is never a dead grey lid, and it switches itself off the moment
    // a real weather module publishes a flash. Seeded, never Math.random.
    this._fallbackStrikes = null;

    // Shared uniform payloads. Typed arrays because UniformsUtils.clone()
    // copies them by reference - one write updates every material.
    this._fogA = new Float32Array(4);
    this._fogB = new Float32Array(4);
    this._fogSun = new Float32Array(3);
    this._fogSky = new Float32Array(3);
    this._fogGnd = new Float32Array(3);
    this._fogDir = new Float32Array([-0.556, 0.242, -0.795]);
    this.fogUniforms = {
      gbFogA: { value: this._fogA },
      gbFogB: { value: this._fogB },
      gbFogSun: { value: this._fogSun },
      gbFogSky: { value: this._fogSky },
      gbFogGnd: { value: this._fogGnd },
      gbFogSunDir: { value: this._fogDir }
    };

    // ---- internals ---------------------------------------------------------
    this.lutW = 128;
    this.lutH = 64;
    this._lutSteps = 22;
    this._lutA = null;               // Rayleigh integral
    this._lutB = null;               // Mie integral
    this._lutC = null;               // isotropic radiance
    var np = this.lutW * this.lutH * 4;
    this._lutAData = new Float32Array(np);
    this._lutBData = new Float32Array(np);
    this._lutCData = new Float32Array(np);
    this._lutSunY = 999;             // sin(elevation) the LUT was built for
    this._lutReady = false;
    this._built = false;
    this._envDirty = true;
    this._envSunY = 999;
    this._envSunAz = 999;
    this._useFromScene = false;
    this._patched = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
    this._tmpRGB = [0, 0, 0];
    this._tmpRGB2 = [0, 0, 0];
    this._tmpV = new THREE.Vector3();
    this._sunPrev = new THREE.Vector3();

    this._installShaderPatches();
    this._solar(this.timeOfDay);
    this._computeLightingTerms();
  }

  // --------------------------------------------------------------------------
  // Global shader patching. Idempotent: a second Sky (or a hot reload) must not
  // stack the chunk overrides or re-add the uniforms.
  // --------------------------------------------------------------------------
  Sky.prototype._installShaderPatches = function () {
    var SC = THREE.ShaderChunk;
    if (!SC) return;
    if (!GAME._skyChunksPatched) {
      SC.fog_pars_vertex = FOG_PARS_VERTEX;
      SC.fog_vertex = FOG_VERTEX;
      SC.fog_pars_fragment = FOG_PARS_FRAGMENT;
      SC.fog_fragment = FOG_FRAGMENT;
      GAME._skyChunksPatched = true;
    }
    // Inject into every stock uniform block. getUniforms() clones
    // ShaderLib[id].uniforms per material, and our typed arrays survive that
    // clone by reference, so this is a one-time cost with global reach.
    var lib = THREE.ShaderLib, k;
    if (lib) for (k in lib) {
      if (lib[k] && lib[k].uniforms) this._mergeFogUniforms(lib[k].uniforms);
    }
    if (THREE.UniformsLib && THREE.UniformsLib.fog) {
      this._mergeFogUniforms(THREE.UniformsLib.fog);
    }
  };

  Sky.prototype._mergeFogUniforms = function (target) {
    for (var k in this.fogUniforms) {
      if (!target[k]) target[k] = this.fogUniforms[k];
      else target[k].value = this.fogUniforms[k].value;
    }
  };

  /**
   * Opt a material into the global height fog.
   *
   * Built-in materials (MeshStandardMaterial and friends) are already covered
   * automatically - you only need this for a hand-written THREE.ShaderMaterial,
   * or to change the fog *mode* of a material.
   *
   *   sky.applyFogTo( mat )                      // normal surface fog
   *   sky.applyFogTo( mat, { additive: true } )  // attenuate only, never tint
   *   sky.applyFogTo( mat, { exclude: true } )   // no fog at all
   *
   * A hand-written ShaderMaterial additionally has to `#include <fog_pars_vertex>`,
   * `<fog_vertex>`, `<fog_pars_fragment>` and `<fog_fragment>` in its own source
   * for the chunks to have anywhere to land, and each of those `#include`s must
   * sit ON ITS OWN LINE - three's resolveIncludes() is line-anchored, so an
   * include tucked onto the end of another statement is silently left as-is and
   * the shader fails to compile. Always go through this method for such a
   * material rather than setting `material.fog = true` yourself; see the note
   * below about the stock fog uniforms.
   */
  Sky.prototype.applyFogTo = function (material, opts) {
    if (!material) return material;
    if (Array.isArray(material)) {
      for (var i = 0; i < material.length; i++) this.applyFogTo(material[i], opts);
      return material;
    }
    opts = opts || {};
    try {
      if (opts.exclude) {
        material.fog = false;
        material.needsUpdate = true;
        return material;
      }
      if (material.uniforms) {
        // A hand-written uniform block has none of three's stock fog uniforms.
        // The moment material.fog is true and scene.fog exists, the renderer
        // calls refreshFogUniforms() and dereferences uniforms.fogColor.value
        // unconditionally - so leaving them out throws on the first frame and
        // takes the whole render down, not just this material. Seed them first.
        var mu = material.uniforms;
        if (!mu.fogColor) mu.fogColor = { value: new THREE.Color(0xffffff) };
        if (!mu.fogDensity) mu.fogDensity = { value: 0.00025 };
        if (!mu.fogNear) mu.fogNear = { value: 1 };
        if (!mu.fogFar) mu.fogFar = { value: 2000 };
        this._mergeFogUniforms(mu);
      }
      material.fog = true;

      var wantAdd = !!opts.additive;
      var defs = material.defines;
      var hasAdd = !!(defs && defs.GB_FOG_ADDITIVE);
      if (wantAdd !== hasAdd) {
        if (wantAdd) {
          material.defines = defs || (material.defines = {});
          material.defines.GB_FOG_ADDITIVE = 1;
        } else if (defs) {
          delete defs.GB_FOG_ADDITIVE;
        }
        material.needsUpdate = true;
      }
      // Materials that already compiled need one recompile to pick the chunk up.
      if (this._patched && !this._patched.has(material)) {
        this._patched.add(material);
        material.needsUpdate = true;
      }
    } catch (e) { GAME.logError('sky.applyFogTo', e); }
    return material;
  };

  // ==========================================================================
  // Solar / lunar geometry
  //
  // The elevation arc is a deliberate art choice, not an ephemeris: peak
  // elevation is capped at 30 degrees so that the entire daylight range keeps
  // the long raking shadows ART_DIRECTION is built around, and the night arc is
  // compressed near the horizon so the "dusk" preset (t = 0.86) lands in civil
  // twilight with a burning horizon rather than in the middle of the night.
  //
  //   t = 0.25 sunrise, 0.5 noon (30 deg), 0.75 sunset, 0/1 solar midnight.
  //   default t = 0.3169 -> 14.0 deg, the ART_DIRECTION golden hour.
  // ==========================================================================
  var MAX_ELEV = 30.0 * M.DEG;
  var NIGHT_DEPTH = 55.0 * M.DEG;
  // --------------------------------------------------------------------------
  // AZ_BASE: radians east of -Z (negative = west), i.e. how far off the street's
  // long axis the sun sits. This single number decides what the image IS.
  //
  // The previous value (+0.28, landing at 0.10 rad = 5.5 deg at capture time)
  // was chosen to keep the ROAD sunlit, on the arithmetic that a ray clearing a
  // 12 m parapet at 14 deg of elevation needs 48 m of run and therefore under
  // ~8 deg of azimuth to stay inside a 14 m street. That arithmetic is correct
  // and it was still the wrong trade, because of what it costs:
  //
  //   * dot(N,L) on a facade is sin(azimuth) * cos(elevation). At 5.5 deg that
  //     is 0.093 - BOTH facades are grazed at 84 deg incidence and NEITHER is
  //     actually sunlit. Measured: left 0.381, right 0.228. Everything on them
  //     is skylight. No building shadows the opposite facade, no parapet draws
  //     a line down a wall.
  //   * the alley (3 m wide, 12 m deep, walls facing +-Z) sits 85 deg off the
  //     key, so ART_DIRECTION's "one shaft of light" is geometrically
  //     unreachable rather than merely untuned.
  //   * it parks a clipping sun disc in the dead centre of six of the fourteen
  //     captures, which is what was driving auto-exposure and printing the
  //     street dark underneath.
  //
  // At 14 deg elevation NO azimuth lights both the road and the facades - the
  // canyon geometry forbids it - so the choice is which one to spend. Facades
  // are 70% of the pixels in every ground-level framing and the road is 20%,
  // and a shaded canyon floor under lit upper storeys is what a real
  // Mediterranean street looks like at golden hour. Facades win.
  //
  // -0.72 (WEST of the street axis) rather than east, for four reasons that are
  // all about where the disc lands:
  //   * the rooftop pose looks 34 deg EAST of north; an eastward sun would sit
  //     ~2 deg off its axis and hand a 300x disc the middle of that frame.
  //     West puts it 68 deg away, comfortably outside a 51 deg half-FOV.
  //   * street/muzzleflash/firefight/explosion look ~4 deg east of north, so a
  //     west sun sits 39 deg off-axis AND behind the west buildings: raking
  //     light, no disc in frame, real cast shadows across the canyon.
  //   * the enemy_closeup camera stands north-EAST of its subject, so a west
  //     key gives a 62 deg three-quarter portrait instead of a flat frontal one.
  //   * the material chart's working faces point down -Z, and cos(41 deg) still
  //     lands 0.76 of the key on them.
  //
  // AZ_DRIFT now SUBTRACTS with time so the sun tracks further west as the day
  // runs (it used to swing back toward the axis at dusk, which would have put
  // the setting disc straight down the street).
  // --------------------------------------------------------------------------
  var AZ_BASE = -0.72;       // radians east of -Z; negative = west of the axis
  var AZ_DRIFT = 0.30;       // total swing across the day
  // Moon placement. MIRRORED about the street axis from azimuthBase, so a level
  // with a differently oriented street retargets both keys with one number, and
  // pulled 0.24 rad closer to that axis than the sun is. See _solar.
  var MOON_AZ_OFS = 0.24;
  var MOON_EL_MAX = 0.34;    // 19.5 deg. Was 0.56 (32 deg) - see _solar.

  Sky.prototype._solar = function (t) {
    var elev;
    if (t >= 0.25 && t <= 0.75) {
      var d = (t - 0.25) / 0.5;
      elev = MAX_ELEV * Math.pow(Math.sin(PI * d), 0.85);
    } else {
      var n = t > 0.75 ? (t - 0.75) / 0.25 : (0.25 - t) / 0.25;
      elev = -NIGHT_DEPTH * Math.pow(M.saturate(n), 3.19);
    }
    // Azimuth drifts only slightly: the shot is defined by the sun raking down
    // the street, and letting it swing a full 180 degrees would destroy that.
    var base = isFinite(this.azimuthBase) ? this.azimuthBase : AZ_BASE;
    var az = base - (t - 0.5) * AZ_DRIFT * 2.0;
    this.sunElevation = elev;
    this.sunAzimuth = az;

    var ce = Math.cos(elev), se = Math.sin(elev);
    this.sunWorldDirection.set(Math.sin(az) * ce, se, -Math.cos(az) * ce).normalize();
    this.sunDirection.copy(this.sunWorldDirection);

    // ---- the moon ---------------------------------------------------------
    // The moon USED to ride roughly opposite the sun (maz = az + 2.60) with its
    // elevation capped at 0.56 rad. Both halves of that were wrong, and they
    // were wrong in the one way that gives a night street nothing.
    //
    // Measured at the night preset (t = 0.02, camera at (1.85, 1.66, 13.6)
    // looking down -Z): the key came out at (0.701, 0.531, 0.476) - 32 degrees
    // up, 122 degrees off the camera axis, i.e. high and behind the player's
    // right shoulder. A high back-key is a FRONTAL FILL: it lands on exactly
    // the surfaces the camera can already see, at an angle that makes none of
    // them cast a shadow the camera can see either. There was no rim on a
    // single parapet, cable, sandbag or silhouette in the frame, and the one
    // moonlit facade read as a broad flat wash. It was also pinned at the 0.56
    // ceiling for the entire preset, so no amount of moving t changed it.
    //
    //   MOON_EL_MAX  0.34 rad (19.5 deg). Low enough for real raking shadows
    //                and a specular sheet off the road, high enough that a
    //                70 m canyon still lets the light reach the upper storeys.
    //   MOON_AZ_OFS  the moon sits at -azimuthBase - MOON_AZ_OFS: mirrored
    //                across the street's long axis from the sun and pulled 14
    //                degrees closer to it. Three reasons, in order of weight.
    //                (1) A canyon only admits a low light along its own axis.
    //                At 27 degrees off the street the moon still clears the
    //                east parapets 30 m up-street and rakes the WEST facades
    //                from about 3 m up; at the old 124 degrees a low moon would
    //                have lit nothing below the rooflines at all - which is why
    //                dropping the elevation without also fixing the azimuth
    //                would have made the frame worse, not better.
    //                (2) Mirrored rather than matched because lighting.js's
    //                eight sodium heads and the brazier all sit along the east
    //                pavement and carry the right-hand side of the night frame
    //                on their own. A cool moon raking the west facades puts
    //                amber on one side of the street and moonlight on the
    //                other, which is the two-source split every night street in
    //                the reference material is built on - and it is the only
    //                placement that leaves no quadrant unlit. With the moon on
    //                the WEST side instead, the left third of the frame had
    //                nothing at all in it and the capture measured 8.8% crushed
    //                black.
    //                (3) It stays inside the forward hemisphere, so parapets,
    //                cables, laundry lines and figure edges all rim.
    // Verification: for the street/night pose the key's z must be NEGATIVE.
    // It is -0.836 - the moon is ahead of the player, not behind.
    var mel = M.clamp(-elev * 0.55 + 0.16, 0.10, MOON_EL_MAX);
    var maz = -base - MOON_AZ_OFS;
    var mce = Math.cos(mel);
    this.moonDirection.set(Math.sin(maz) * mce, Math.sin(mel), -Math.cos(maz) * mce).normalize();
  };

  // --------------------------------------------------------------------------
  // Sun/moon colour and intensity from real atmospheric transmittance, so the
  // key light reddens on its own as the sun drops instead of being keyframed.
  // --------------------------------------------------------------------------
  var _kelvinRef = new THREE.Color();
  Sky.prototype._computeLightingTerms = function () {
    this.sunDirection.copy(this.sunWorldDirection);
    var T = transmittanceRaw(0.0, this.sunWorldDirection.y, this._tmpRGB);
    var mx = Math.max(T[0], Math.max(T[1], T[2]));
    var lum = 0.2126 * T[0] + 0.7152 * T[1] + 0.0722 * T[2];

    if (mx > 1e-5) {
      this.sunColor.setRGB(T[0] / mx, T[1] / mx, T[2] / mx);
    } else {
      this.sunColor.setRGB(1, 0.45, 0.18);
    }
    // Nudge toward the art-directed 4200K so the default hour lands exactly on
    // the palette instead of merely near it.
    GAME.Color.kelvin(4200, _kelvinRef);
    this.sunColor.lerp(_kelvinRef, 0.22);

    // lum^0.65 keeps a low sun usable as a key light instead of collapsing to
    // nothing; the clamp keeps a high sun inside the 4.5-6.6 band the art
    // direction asks for.
    var inten = 9.57 * Math.pow(Math.max(lum, 0.0), 0.65);
    this.sunIntensity = Math.min(6.6, inten);
    if (this.sunWorldDirection.y <= 0.0) {
      // Fade the key out through the first few degrees below the horizon.
      this.sunIntensity *= M.saturate(1.0 + this.sunWorldDirection.y / 0.05);
    }

    // ---- civil twilight -----------------------------------------------------
    // Once the disc is down there is no direct sunlight, but the burning band
    // sitting in the sun's azimuth is still by far the strongest DIRECTIONAL
    // source in the sky - it is what gives a dusk street its long warm rake and
    // its blue shadow. Without it the key snapped from sunlight straight to
    // moonlight the instant the sun crossed the horizon, and the "dusk" preset
    // (t = 0.86, -4 degrees) rendered as a black frame under a magenta sky.
    //
    // The window closes above +3 degrees, where the real disc is already
    // brighter than this, and below -7 degrees, where the band is gone and the
    // moon legitimately takes over.
    var sy = this.sunWorldDirection.y;
    var glow = M.smoothstep(-0.122, -0.020, sy) * M.smoothstep(0.055, 0.010, sy);
    if (glow > 0.002) {
      var gi = 1.05 * glow;
      if (gi > this.sunIntensity) {
        this.sunIntensity = gi;
        _kelvinRef.setRGB(1.0, 0.44, 0.17);
        this.sunColor.lerp(_kelvinRef, M.saturate(glow * 1.2));
        // The published KEY direction is lifted above the horizon while
        // sunWorldDirection (and therefore the disc, the LUT and every sky
        // lookup) stays on the real sun. The lit band really is a few degrees
        // up from where the disc went down, and lighting.js gates its day term
        // on key.y, so a sub-horizon direction would be discarded outright.
        var lift = 0.17 * glow;
        this._tmpV.set(this.sunWorldDirection.x, 0, this.sunWorldDirection.z);
        if (this._tmpV.lengthSq() < 1e-8) this._tmpV.set(0, 0, -1);
        this._tmpV.normalize();
        this.sunDirection.set(this._tmpV.x, lift, this._tmpV.z).normalize();
      }
    }

    // Moonlight: cool, dim, and only when the moon is actually up.
    var moonUp = M.saturate(this.moonDirection.y / 0.12);
    var nightF = M.smoothstep(-0.02, -0.14, this.sunWorldDirection.y);
    this.moonIntensity = 0.34 * moonUp * nightF;
    this.moonColor.setRGB(0.56, 0.66, 0.98);

    // A storm deck eats the moon. Not to zero - lighting.js needs a key
    // DIRECTION every frame to hang its cascade on, and an overcast really does
    // have a brighter side - but far enough that the harbor is unambiguously
    // lit by its own sodium masts and not by a moon that is behind two
    // kilometres of water. Multiplicative and gated on _stormF, so with no
    // storm this line is an exact x1. Applied BEFORE the keyIsMoon handover
    // below so sunIntensity inherits the reduction.
    if (this._stormF > 0) {
      this.moonIntensity *= M.lerp(1.0, STORM_MOON_K, M.saturate(this._stormF));
    }

    // Guarantee the whole build always has a key light with a direction, even
    // at midnight, whatever lighting.js chooses to do with it.
    this.keyIsMoon = false;
    if (this.sunIntensity < 0.14 && this.moonIntensity > 0.02) {
      this.keyIsMoon = true;
      this.sunDirection.copy(this.moonDirection);
      this.sunColor.copy(this.moonColor);
      this.sunIntensity = Math.max(this.sunIntensity, this.moonIntensity);
    }

    this._scheduleHaze();
  };

  // --------------------------------------------------------------------------
  // HAZE SCHEDULE
  //
  // Pure function of sun elevation, cheap (four smoothsteps), idempotent, and
  // called from the top of _buildLut and _pushUniforms as well as at the end of
  // _computeLightingTerms - so no caller can reach a fog write before the
  // schedule that governs it, and calling it twice in a frame is free.
  //
  // The gates are the SAME expressions the LUT uses for its authored twilight
  // and night layers (see _buildLut), which is the point: the air gets thicker
  // in step with the sky getting its night colours, rather than on a second,
  // independent timeline that then disagrees with it at the edges.
  //
  // deepNight is a later gate than nightF on purpose. Everything that changes
  // the LEVEL of the haze after dark hangs off it, so the dusk preset - which
  // currently prints at mean 0.158 with a +0.116 grade split and no red flags -
  // keeps the authored levels it was tuned to, and only picks up the modest
  // twilight density bump.
  // --------------------------------------------------------------------------
  Sky.prototype._scheduleHaze = function () {
    var degEl = this.sunElevation / M.DEG;
    var afterglow = M.smoothstep(9, 1, degEl) * M.smoothstep(-13, -3, degEl);
    var nightF = M.smoothstep(-1, -9, degEl);
    var deepF = M.smoothstep(-4, -12, degEl);
    this._afterglowF = afterglow;
    this._nightF = nightF;
    this._deepNightF = deepF;

    this.nightHazeGain = 1.0 + NIGHT_HAZE_K * deepF;

    var base = this.fog.density;
    if (!isFinite(base) || base < 0) base = 0;
    var d = base * M.lerp(1.0, NIGHT_FOG_K, nightF) * (1.0 + AFTERGLOW_FOG_K * afterglow);
    var albedo = HAZE_ALBEDO;

    // ---- driving rain -------------------------------------------------------
    // Under storm the density is not a schedule off the sun any more, it is
    // WEATHER, and weather.js owns it: ctx.weather.fogDensity is read straight
    // through when it publishes one (clamped, because a module in another
    // agent's hands may express it in its own units and a runaway value would
    // fill the frame with grey). The night/afterglow multipliers above are
    // deliberately NOT stacked on top - they model dew and inversion under a
    // clear sky, and a downpour is neither.
    var sf = M.saturate(this._stormF);
    if (sf > 0) {
      d = M.lerp(d, this._stormFogDensity(), sf);
      this.nightHazeGain = M.lerp(this.nightHazeGain, STORM_HAZE_GAIN, sf);
      albedo = M.lerp(HAZE_ALBEDO, STORM_HAZE_ALBEDO, sf);
    }

    this.fogDensityEffective = d;
    this.scatterRadiance = albedo * d / (4.0 * PI);

    // The near-field cutout is a DAYLIGHT guard: it keeps the first couple of
    // metres crisp under a key bright enough that anything closer would only
    // read as lens flare. After dark the near field is the opposite - it is
    // where a lamp halo lives, and it is where the frame was crushing to
    // literal black (8.8% of the night capture measured under 2/255, which is
    // ARCHITECTURE 7.6's number one amateur tell). Pulling it in to ~1.1 m at
    // night puts a few thousandths of warm inscatter on everything past arm's
    // reach: invisible as haze, decisive as a black floor. The viewmodel sits
    // at 0.3-0.8 m and is still entirely outside it.
    this.fogStartEffective = Math.max(0.0, this.fog.startDistance) *
      M.lerp(1.0, 0.45, deepF);
    if (sf > 0) {
      this.fogStartEffective = M.lerp(this.fogStartEffective,
        STORM_FOG.startDistance, sf);
    }
  };

  // --------------------------------------------------------------------------
  // The storm's fog density target: whatever weather.js publishes, or the
  // authored default until it does. Clamped hard - this number multiplies a
  // distance, so a wrong one by an order of magnitude is either no fog at all
  // or a white screen, and neither should be reachable from another module's
  // units mismatch.
  // --------------------------------------------------------------------------
  Sky.prototype._stormFogDensity = function () {
    var d = this._wxFog;
    if (isFinite(d) && d > 0) return M.clamp(d, 0.008, 0.045);
    return STORM_FOG.density;
  };

  // Blend one authored fog parameter toward its storm counterpart. Returns the
  // authored value EXACTLY (not a lerp by zero) when there is no storm, so the
  // market's uniforms are untouched down to the last bit.
  Sky.prototype._fogParam = function (key) {
    var base = this.fog[key];
    var sf = M.saturate(this._stormF);
    if (!(sf > 0)) return base;
    var storm = STORM_FOG[key];
    if (!isFinite(storm)) return base;
    return M.lerp(base, storm, sf);
  };

  // --------------------------------------------------------------------------
  // The single reference radiance everything in this file is measured against:
  // an 18% GREY CARD lying flat in full sun. Both the dome shoulder and every
  // fog cap are expressed as multiples of it, so retuning the key cannot
  // silently desynchronise the sky from the scene.
  //
  // KEY_ALBEDO used to be 0.5, and that one number was quietly responsible for
  // the "sky is a clipped white wall" and "the haze is brighter than the
  // brightest surface" findings. 0.5 describes fresh white plaster in a
  // laboratory; nothing in this level is remotely that bright. Measured off
  // street.png by inverting the whole postfx chain (AgX + grade + the metered
  // exposure, which runs at ~8.5x here) back to scene radiance:
  //
  //     sunlit plaster facade  0.13   (95th percentile of the lit wall)
  //     road / kerb            0.035
  //     shadowed facade        0.010
  //     sky at 35 deg          0.128
  //     far end of the street  0.30   <- blown, and that IS the haze cap
  //
  // A 0.5-albedo reference put keyRef at 0.232, so the fog was allowed to reach
  // 0.209 - six times the road it was supposed to be sitting behind - and the
  // dome shoulder sat at 1.17, five times any surface in frame. Distance made
  // things LIGHTER, the vanishing point printed as a hole, and there was no
  // dark left anywhere in the top half of the image.
  //
  // 0.18 is the photographic mid-grey every meter in the world is calibrated
  // against, it needs no cross-module read (lighting.js is built AFTER this
  // module, so its actual light intensity is not available at first LUT), and
  // it lands keyRef on 0.0835 - between the road and the sunlit wall, which is
  // exactly what a scene reference is supposed to be.
  //
  // The floors matter as much as the formula. After sunset the sun term goes to
  // zero, so the sky's own fill and a small absolute floor take over - otherwise
  // the caps would snap the night haze to a fixed grey that reads as
  // fog-in-the-headlights. fillRadiance is one LUT generation stale when this is
  // called from _buildLut, which is exactly what we want: a bootstrap, not a
  // feedback loop.
  // --------------------------------------------------------------------------
  var KEY_ALBEDO = 0.18;
  Sky.prototype._keyRef = function () {
    var k = KEY_ALBEDO * this.sunIntensity * Math.max(this.sunWorldDirection.y, 0.12) / PI;
    if (!isFinite(k)) k = 0.0;
    // 0.55, not 1.6: a shadowed 18% surface under a sky of mean radiance F only
    // reaches 0.18 * F, so a floor anywhere near F is not a "key" reference at
    // all - it is the fill wearing the key's clothes, and by day it was winning
    // outright and holding every cap 1.5x over where the sun term put them.
    // It still has to exist: after sunset the sun term is zero and something has
    // to keep the haze off the floor.
    return Math.max(k, (this.fillRadiance || 0) * 0.55, 0.0016);
  };

  // ==========================================================================
  // Sky-view LUT
  // ==========================================================================
  Sky.prototype._buildLut = function () {
    this._scheduleHaze();
    var W = this.lutW, H = this.lutH, N = this._lutSteps;
    var A = this._lutAData, B = this._lutBData, C = this._lutCData;
    // The LUT is expressed in a frame whose azimuth is measured from the sun,
    // so only the sun's ELEVATION parameterises it. Azimuth changes are free.
    var sunEl = this.sunElevation;
    var sunY = Math.sin(sunEl);
    var sy = sunY, sz = -Math.cos(sunEl);
    var degEl = sunEl / M.DEG;

    // Twilight and night are additive, artist-authored layers: single
    // scattering alone collapses to black the moment the sun sets, because the
    // only lit air left is 40 km up and behind a very long slant path.
    var afterglow = M.smoothstep(9, 1, degEl) * M.smoothstep(-13, -3, degEl);
    var nightF = M.smoothstep(-1, -9, degEl);

    // ---- what a cloud deck does to the authored night layers ----------------
    // Exactly 1.0 with no storm, so every existing capture is bit-identical.
    //
    // Under one, both authored layers have to come DOWN, and the second reason
    // is the one that was measured rather than reasoned about. The airglow is
    // obvious: it is emitted 90 km up and a nimbostratus deck is opaque to it.
    // The city skyglow is subtler and it is a DOUBLE COUNT: NIGHT_SODIUM models
    // lamplight scattered back off aerosol, and the storm deck's underglow
    // models exactly the same lamplight scattered back off cloud. Leaving both
    // on put the LUT horizon at 0.042 radiance against a deck of 0.012, so
    // wherever the deck thinned it revealed something four times BRIGHTER
    // behind it - a hot white band along the skyline, under a dark lid, which
    // is the one place in the frame the eye goes first.
    var stormK = 1.0 - 0.90 * M.saturate(this._stormF);

    // Shoulder target for the physical daylight terms, in the same HDR units as
    // everything else. keyRef is the radiance of a mid-grey horizontal surface
    // in full sun, so SKY_CAP_K = 1.6 says "the sky may reach 1.6 x pi x that
    // and no further" - a real clear sky near the sun is a couple of stops over
    // a sunlit mid-grey, and this lands there instead of five stops over.
    var capL = SKY_CAP_K * this._keyRef() * PI;
    var capKnee = 0.45 * capL;

    var Ts = this._tmpRGB, Tv = this._tmpRGB2;
    var Rr = this._accR || (this._accR = new Float64Array(3));
    var Mm = this._accM || (this._accM = new Float64Array(3));
    var i, j, s;

    for (j = 0; j < H; j++) {
      var vv = (j + 0.5) / H;
      var tv = 2.0 * vv - 1.0;
      var l = tv < 0 ? -tv * tv : tv * tv;          // sin(view elevation)
      var cl = Math.sqrt(Math.max(0.0, 1.0 - l * l));
      var viewEl = Math.asin(M.clamp(l, -1, 1));

      for (i = 0; i < W; i++) {
        var az = (i + 0.5) / W * PI;                 // 0 = toward the sun
        var dx = cl * Math.sin(az), dy = l, dz = -cl * Math.cos(az);
        var cosT = dx * 0 + dy * sy + dz * sz;

        // --- ray extent -----------------------------------------------------
        var r0 = Rg + CAM_H;
        var mu = dy;
        var b = r0 * mu;
        var tmax = -b + Math.sqrt(Math.max(0.0, b * b - r0 * r0 + Rt * Rt));
        var hitGround = false;
        if (mu < 0.0) {
          var dg = b * b - r0 * r0 + Rg * Rg;
          if (dg >= 0.0) {
            var tg = -b - Math.sqrt(dg);
            if (tg > 0.0) { tmax = tg; hitGround = true; }
          }
        }

        // --- single scattering march ----------------------------------------
        // The dust layer rides in the Mie accumulator: it is a forward-scattering
        // aerosol like the background haze, so it shares the phase function and
        // costs no extra LUT texture. The quadratic step distribution is what
        // makes a 260 m layer tractable here - for a horizontal ray the first
        // eight steps all land inside it (h = t^2/2R rises to 0.26 km only at
        // t = 58 km), which integrates the near-ground column to within 1%.
        Rr[0] = Rr[1] = Rr[2] = 0.0;
        Mm[0] = Mm[1] = Mm[2] = 0.0;
        var odR = 0.0, odM = 0.0, odD = 0.0, odO = 0.0, prev = 0.0;
        for (s = 0; s < N; s++) {
          var f1 = (s + 1) / N;
          var t1 = tmax * f1 * f1;                   // quadratic: dense near eye
          var tm = 0.5 * (prev + t1);
          var seg = t1 - prev;
          prev = t1;
          var px = dx * tm, py = r0 + dy * tm, pz = dz * tm;
          var rl = Math.sqrt(px * px + py * py + pz * pz);
          var h = rl - Rg;
          if (h < 0) h = 0;
          var dR = Math.exp(-h / Hr);
          var dM = Math.exp(-h / Hm);
          var dD = Math.exp(-h / Hd);
          var dO = Math.max(0.0, 1.0 - Math.abs(h - 25.0) / 15.0);
          odR += dR * seg; odM += dM * seg; odD += dD * seg; odO += dO * seg;
          var muS = (py * sy + pz * sz) / rl;
          transmittance(h, muS, Ts);
          for (var c = 0; c < 3; c++) {
            var tau = betaR[c] * odR + betaMe[c] * odM + betaDe[c] * odD + betaO[c] * odO;
            Tv[c] = tau > 50.0 ? 0.0 : Math.exp(-tau);
            var TT = Tv[c] * Ts[c] * seg;
            Rr[c] += TT * betaR[c] * dR;
            Mm[c] += TT * (betaMs[c] * dM + betaDs[c] * dD);
          }
        }

        // --- Rayleigh chroma expansion ---------------------------------------
        // Luminance-preserving, Rayleigh only. See RAY_CHROMA. Done before the
        // isotropic top-up so the multiple-scattering term inherits the same
        // hue rather than diluting it back toward grey.
        if (RAY_CHROMA !== 1.0) {
          var rl0 = 0.2126 * Rr[0] + 0.7152 * Rr[1] + 0.0722 * Rr[2];
          Rr[0] = Math.max(0, rl0 + (Rr[0] - rl0) * RAY_CHROMA);
          Rr[1] = Math.max(0, rl0 + (Rr[1] - rl0) * RAY_CHROMA);
          Rr[2] = Math.max(0, rl0 + (Rr[2] - rl0) * RAY_CHROMA);
        }

        // --- isotropic terms -------------------------------------------------
        var iso0 = (Rr[0] + Mm[0]) * MS_FACTOR;
        var iso1 = (Rr[1] + Mm[1]) * MS_FACTOR;
        var iso2 = (Rr[2] + Mm[2]) * MS_FACTOR;

        if (hitGround) {
          // Warm sand bounce. This is what fills the lower hemisphere of the
          // IBL, and therefore what puts warm light under every ledge.
          var nx = dx * tmax, ny = r0 + dy * tmax, nz = dz * tmax;
          var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
          var ndl = Math.max(0.0, (ny * sy + nz * sz) / nl);
          transmittance(0.0, Math.max(0.0, sy), Ts);
          var kg = ndl / PI;
          var e0 = betaR[0] * odR + betaMe[0] * odM + betaDe[0] * odD + betaO[0] * odO;
          var e1 = betaR[1] * odR + betaMe[1] * odM + betaDe[1] * odD + betaO[1] * odO;
          var e2 = betaR[2] * odR + betaMe[2] * odM + betaDe[2] * odD + betaO[2] * odO;
          iso0 += Math.exp(-Math.min(e0, 50)) * GROUND_ALBEDO[0] * Ts[0] * kg;
          iso1 += Math.exp(-Math.min(e1, 50)) * GROUND_ALBEDO[1] * Ts[1] * kg;
          iso2 += Math.exp(-Math.min(e2, 50)) * GROUND_ALBEDO[2] * Ts[2] * kg;
        }

        iso0 *= SKY_SCALE; iso1 *= SKY_SCALE; iso2 *= SKY_SCALE;

        // --- dome shoulder ---------------------------------------------------
        // The fog was already capped against the key (see _deriveAmbient); the
        // DOME never was, so the aureole and the horizon band were free to run
        // to several times the brightest surface in the frame. Because postfx
        // tone maps with AgX - which desaturates hard as it approaches the top
        // of its range, by design - an uncapped sky does not merely read bright,
        // it reads WHITE, and it drags auto-exposure down with it so the street
        // prints dark underneath. That is the "near-achromatic, near-clipped
        // white wall" the critics measured.
        //
        // So: a shoulder, not a clamp. Below 0.45 x capL nothing is touched at
        // all (which is the whole upper dome, and therefore the entire IBL and
        // every derived fill colour - this must not cost a stop of ambient).
        // Above it the luminance rolls asymptotically onto capL while hue is
        // preserved exactly, the same contract _capRadiance already honours.
        //
        // Applied to the PHYSICAL terms only. The twilight and airglow layers
        // below are hand-authored and already sit at a chosen level; rolling
        // them would gut dusk, where the sky is legitimately the brightest
        // thing in the frame.
        if (capL > 0.0) {
          var pr0 = phaseRayleigh(cosT), pm0 = phaseMie(cosT, MIE_G);
          var q0 = (Rr[0] * pr0 + Mm[0] * pm0) * SKY_SCALE + iso0;
          var q1 = (Rr[1] * pr0 + Mm[1] * pm0) * SKY_SCALE + iso1;
          var q2 = (Rr[2] * pr0 + Mm[2] * pm0) * SKY_SCALE + iso2;
          var qL = 0.2126 * q0 + 0.7152 * q1 + 0.0722 * q2;
          if (qL > capKnee) {
            var span = capL - capKnee;
            var rolled = capKnee + span * (1.0 - Math.exp(-(qL - capKnee) / span));
            var kk = rolled / qL;
            Rr[0] *= kk; Rr[1] *= kk; Rr[2] *= kk;
            Mm[0] *= kk; Mm[1] *= kk; Mm[2] *= kk;
            iso0 *= kk; iso1 *= kk; iso2 *= kk;
          }
        }

        // --- twilight afterglow ---------------------------------------------
        if (afterglow > 0.001) {
          var azFall = Math.pow(Math.max(0.0, Math.cos(az)), 2.2);
          var upFall = Math.exp(-Math.max(0.0, viewEl) / 0.13);
          var dnFall = Math.exp(Math.min(0.0, viewEl) / 0.055);
          var wLow = afterglow * upFall * dnFall * (0.16 + 0.84 * azFall) * SKY_SCALE * stormK;
          var wHigh = afterglow * Math.exp(-Math.max(0.0, viewEl - 0.10) / 0.38) *
                      dnFall * (0.30 + 0.70 * azFall) * 0.55 * SKY_SCALE * stormK;
          iso0 += AFTERGLOW_LOW[0] * wLow + AFTERGLOW_HIGH[0] * wHigh;
          iso1 += AFTERGLOW_LOW[1] * wLow + AFTERGLOW_HIGH[1] * wHigh;
          iso2 += AFTERGLOW_LOW[2] * wLow + AFTERGLOW_HIGH[2] * wHigh;
        }

        // --- night airglow floor (never let the sky go to pure black) --------
        if (nightF > 0.001) {
          var hzf = Math.exp(-Math.max(0.0, viewEl) / 0.32) * Math.exp(Math.min(0.0, viewEl) / 0.10);
          var nf = nightF * SKY_SCALE * stormK;
          iso0 += nf * (NIGHT_ZENITH[0] + hzf * NIGHT_HORIZON[0]);
          iso1 += nf * (NIGHT_ZENITH[1] + hzf * NIGHT_HORIZON[1]);
          iso2 += nf * (NIGHT_ZENITH[2] + hzf * NIGHT_HORIZON[2]);

          // ---- city skyglow (warm) ------------------------------------------
          // Same nightF gate as the airglow above, so the two after-dark layers
          // can never disagree about what time it is. It lives in the LUT and
          // not in the dome shader deliberately: the LUT is what _deriveAmbient
          // integrates and what every fog colour is sampled from, so putting it
          // here is what finally gives the night haze something warm to BE.
          // A copy in the shader would light the picture and leave the fog,
          // the IBL and the hemisphere fill exactly as cold as they were.
          //
          // The bias is toward az = 0, which in this LUT means "the sun's
          // azimuth" - after dark that is the down-street direction (they agree
          // to within 25 degrees at the night preset), so the glow banks over
          // the far rooftops the way a city does rather than ringing the dome.
          var sod = Math.pow(Math.max(0.0, 1.0 - Math.max(l, 0.0)), NIGHT_SODIUM_POW);
          if (sod > 1e-4) {
            var sodAz = NIGHT_SODIUM_FLOOR + (1.0 - NIGHT_SODIUM_FLOOR) *
              Math.pow(Math.max(0.0, Math.cos(az)), 1.4);
            var sw = nf * sod * sodAz;
            iso0 += sw * NIGHT_SODIUM[0];
            iso1 += sw * NIGHT_SODIUM[1];
            iso2 += sw * NIGHT_SODIUM[2];
          }
        }

        var o = (j * W + i) * 4;
        A[o] = Rr[0]; A[o + 1] = Rr[1]; A[o + 2] = Rr[2]; A[o + 3] = 1.0;
        B[o] = Mm[0]; B[o + 1] = Mm[1]; B[o + 2] = Mm[2]; B[o + 3] = 1.0;
        C[o] = iso0; C[o + 1] = iso1; C[o + 2] = iso2; C[o + 3] = cosT;
      }
    }

    this._uploadLut();
    this._lutSunY = sunY;
    this._lutReady = true;
    this._deriveAmbient();
  };

  Sky.prototype._uploadLut = function () {
    var n = this.lutW * this.lutH * 4;
    var a = this._lutA, b = this._lutB, c = this._lutC;
    if (!a || !b || !c) return;
    var ha = a.image.data, hb = b.image.data, hc = c.image.data;
    for (var i = 0; i < n; i++) {
      ha[i] = toHalf(this._lutAData[i]);
      hb[i] = toHalf(this._lutBData[i]);
      hc[i] = toHalf(this._lutCData[i]);
    }
    a.needsUpdate = true;
    b.needsUpdate = true;
    c.needsUpdate = true;
  };

  // --------------------------------------------------------------------------
  // Sample the CPU LUT. Cheap, exact, and identical to what the shader shows,
  // which is why fog colours and ambient terms are derived from here rather
  // than hand-picked.
  //   out = linear HDR radiance for a world-space direction.
  // --------------------------------------------------------------------------
  Sky.prototype.getSkyColor = function (dir, out) {
    out = out || new THREE.Color();
    if (!this._lutReady) return out.setRGB(0.4, 0.5, 0.7);
    var s = this.sunWorldDirection;
    var shl = Math.sqrt(s.x * s.x + s.z * s.z);
    var dhl = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    var cosAz = (shl > 1e-5 && dhl > 1e-5)
      ? M.clamp((s.x * dir.x + s.z * dir.z) / (shl * dhl), -1, 1) : 1;
    var y = M.clamp(dir.y, -1, 1);
    var v = 0.5 + 0.5 * (y < 0 ? -Math.sqrt(-y) : Math.sqrt(y));
    var cosT = M.clamp(dir.x * s.x + y * s.y + dir.z * s.z, -1, 1);
    return this._lutFetch(Math.acos(cosAz) / PI, v, cosT, out);
  };

  // Bilinear fetch of the CPU-side LUT arrays, mirroring exactly what the sky
  // shader does on the GPU so fog and ambient colours can never drift from the
  // sky the player is actually looking at.
  var _fetch = [0, 0, 0];
  Sky.prototype._lutFetch = function (u, v, cosT, out) {
    var W = this.lutW, H = this.lutH;
    var x = M.clamp(u, 0, 1) * W - 0.5;
    var y = M.clamp(v, 0, 1) * H - 0.5;
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 > W - 2) { x0 = W - 2; fx = 1; }
    if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 > H - 2) { y0 = H - 2; fy = 1; }
    var A = this._lutAData, B = this._lutBData, C = this._lutCData;
    var i00 = (y0 * W + x0) * 4, i10 = i00 + 4;
    var i01 = ((y0 + 1) * W + x0) * 4, i11 = i01 + 4;
    var pr = phaseRayleigh(cosT), pm = phaseMie(cosT, MIE_G);
    for (var c = 0; c < 3; c++) {
      var a0 = A[i00 + c] + (A[i10 + c] - A[i00 + c]) * fx;
      var a1 = A[i01 + c] + (A[i11 + c] - A[i01 + c]) * fx;
      var b0 = B[i00 + c] + (B[i10 + c] - B[i00 + c]) * fx;
      var b1 = B[i01 + c] + (B[i11 + c] - B[i01 + c]) * fx;
      var c0 = C[i00 + c] + (C[i10 + c] - C[i00 + c]) * fx;
      var c1 = C[i01 + c] + (C[i11 + c] - C[i01 + c]) * fx;
      _fetch[c] = (c0 + (c1 - c0) * fy) +
        ((a0 + (a1 - a0) * fy) * pr + (b0 + (b1 - b0) * fy) * pm) * SKY_SCALE;
    }
    return out.setRGB(_fetch[0], _fetch[1], _fetch[2]);
  };

  // Sample by (azimuth relative to the sun, elevation), both in radians.
  Sky.prototype._sampleAE = function (azRel, elev, out) {
    var l = Math.sin(elev);
    var v = 0.5 + 0.5 * (l < 0 ? -Math.sqrt(-l) : Math.sqrt(l));
    var sunEl = this.sunElevation;
    // spherical law of cosines for the angle between view and sun
    var cosT = Math.cos(elev) * Math.cos(sunEl) * Math.cos(azRel) + l * Math.sin(sunEl);
    return this._lutFetch(azRel / PI, v, M.clamp(cosT, -1, 1), out);
  };

  // --------------------------------------------------------------------------
  // Derive ambient / hemisphere / fog colours by integrating the LUT.
  // --------------------------------------------------------------------------
  var _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();
  Sky.prototype._deriveAmbient = function () {
    var AZ = 24, EL = 20;
    var upR = 0, upG = 0, upB = 0, upW = 0;
    var dnR = 0, dnG = 0, dnB = 0, dnW = 0;
    var fillR = 0, fillG = 0, fillB = 0, fillW = 0;
    var i, j;
    for (j = 0; j < EL; j++) {
      var el = -PI * 0.5 + PI * (j + 0.5) / EL;
      var w = Math.cos(el);
      for (i = 0; i < AZ; i++) {
        var az = PI * (i + 0.5) / AZ;
        this._sampleAE(az, el, _c1);
        if (el > 0) {
          var cw = w * Math.sin(el);                 // cosine-weighted irradiance
          upR += _c1.r * cw; upG += _c1.g * cw; upB += _c1.b * cw; upW += cw;
          // The "fill" term is what a shadowed street surface actually sees:
          // the strip of sky through the gap between buildings. That excludes
          // both the warm band sitting on the horizon and the sun's aureole,
          // which is why the fill comes out cool blue while the cosine-weighted
          // ambientColor above comes out near neutral.
          var caz = Math.cos(az);
          var fw = w * Math.pow(Math.sin(el), 3.0) *
                   (1.0 - 0.55 * Math.pow(Math.max(0, caz), 3.0));
          fillR += _c1.r * fw; fillG += _c1.g * fw; fillB += _c1.b * fw; fillW += fw;
        } else {
          dnR += _c1.r * w; dnG += _c1.g * w; dnB += _c1.b * w; dnW += w;
        }
      }
    }
    if (upW > 0) { upR /= upW; upG /= upW; upB /= upW; }
    if (dnW > 0) { dnR /= dnW; dnG /= dnW; dnB /= dnW; }
    if (fillW > 0) { fillR /= fillW; fillG /= fillW; fillB /= fillW; }

    this.ambientColor.setRGB(upR, upG, upB);
    var lum = 0.2126 * fillR + 0.7152 * fillG + 0.0722 * fillB;
    var mx = Math.max(fillR, Math.max(fillG, fillB)) || 1;
    // Normalise the hue and carry the magnitude in ambientIntensity so
    // lighting.js can feed a HemisphereLight directly.
    this.skyColor.setRGB(fillR / mx, fillG / mx, fillB / mx);
    var gmx = Math.max(dnR, Math.max(dnG, dnB)) || 1;
    this.groundColor.setRGB(dnR / gmx, dnG / gmx, dnB / gmx);
    this.fillRadiance = lum;

    // The zenith is sampled on its own: at 85 degrees the azimuth is
    // irrelevant, so this is the one direction that is pure sky colour with no
    // horizon band and no aureole in it. lighting.js hangs its HemisphereLight
    // on this, which is what finally makes the analytic fill track time of day
    // instead of sitting on a hard-coded palette.
    this._sampleAE(1.2, 85.0 * M.DEG, _c1);
    var zmx = Math.max(_c1.r, Math.max(_c1.g, _c1.b)) || 1;
    this.zenithColor.setRGB(_c1.r / zmx, _c1.g / zmx, _c1.b / zmx);

    // A HemisphereLight intensity is an IRRADIANCE, and the fill above is a
    // RADIANCE, so the conversion is the pi that the old *1.25 was missing.
    // (0.4 of the full hemispherical integral because scene.environment already
    // carries the real skylight and this is only the supplementary fill.)
    // Lands ~0.45 at the golden-hour default, inside the 0.35-0.8 band
    // ART_DIRECTION asks for, and never reaches zero so night shadows keep a
    // floor instead of going pure black.
    // 1.36, not 1.27: the dome shoulder and the thinner background aerosol both
    // take a little off the sky, and the supplementary fill has to hold station
    // or the shadows get deeper as a side effect of a change that was only ever
    // about the visible sky. Still inside ART_DIRECTION's 0.35-0.8 band.
    this.ambientIntensity = M.clamp(lum * PI * 1.36, 0.035, 0.95);

    // ---- fog colours, taken straight off the same model -------------------
    //
    // These used to float freely with the LUT, which is how the haze ended up
    // several times brighter than the brightest surface in the scene: the
    // golden-hour horizon lands around 7 in raw HDR, while a sunlit 0.55-albedo
    // plaster wall under a 5.2 key is only about 0.8. Distance then made things
    // LIGHTER instead of merely lower in contrast, and every plane cue died.
    //
    // So the inscatter is derived for HUE from the atmosphere and then capped
    // in MAGNITUDE against the key. keyRef is the radiance of a mid-grey
    // horizontal surface in full sun - the brightest thing on the ground plane.
    this._sampleAE(0.0, 2.5 * M.DEG, _c1);
    this.horizonColor.copy(_c1);
    var fs = 0.22;
    this._fogSun[0] = _c1.r * fs; this._fogSun[1] = _c1.g * fs; this._fogSun[2] = _c1.b * fs;

    this._sampleAE(2.20, 9.0 * M.DEG, _c2);
    // A small cool bias: the shadow side of the haze should read blue against
    // the warm side, which is the whole point of directional inscattering.
    this._fogSky[0] = _c2.r * 0.45 * 0.94;
    this._fogSky[1] = _c2.g * 0.45 * 1.00;
    this._fogSky[2] = _c2.b * 0.45 * 1.16;

    // Downward is the one direction where the LUT cannot be used for magnitude.
    // Its ground term is the sky model's own distant sand plane, expressed per
    // unit top-of-atmosphere solar irradiance, so it lands about 6x under the
    // game's key - measured 0.021 against a sunlit-asphalt radiance of 0.144.
    // The bounce that fills the underside of every ledge and awning has to be
    // referenced to the key instead, tinted by the sand albedo ART_DIRECTION
    // specifies. 0.45 of the full bounce because the street is asphalt in
    // shadow, not an open sand plane in full sun.
    this._sampleAE(0.35, -13.0 * M.DEG, _c3);
    var eGnd = this.sunIntensity * Math.max(this.sunWorldDirection.y, 0.0) + lum * PI;
    var bk = 0.45 * eGnd / PI;
    this._fogGnd[0] = _c3.r * 0.55 + GROUND_ALBEDO[0] * bk;
    this._fogGnd[1] = _c3.g * 0.55 + GROUND_ALBEDO[1] * bk;
    this._fogGnd[2] = _c3.b * 0.55 + GROUND_ALBEDO[2] * bk;

    // The cap is against the key by DAY and against the key times
    // nightHazeGain after dark. keyRef is the radiance of a mid-grey card in
    // the key light, and the cap exists so the haze can never out-brighten the
    // brightest surface in the frame. That reasoning holds perfectly while the
    // key is the sun and fails completely once it is a 0.34 moon: the brightest
    // surface on a night street is not a moonlit grey card, it is the pavement
    // under a sodium head, which measures roughly twenty times higher. Capping
    // the night haze against the moon is what drove the far end of the street
    // to near-black and left the frame with no depth cue at all after dark.
    // See NIGHT_HAZE_K. The gain is 1.0 by day, so daylight is bit-identical.
    var keyRef = this._keyRef() * this.nightHazeGain;
    this._capRadiance(this._fogSun, 0.90 * keyRef);
    this._capRadiance(this._fogSky, 0.35 * keyRef);
    this._capRadiance(this._fogGnd, 0.55 * keyRef);

    // Never let the haze reach zero, or night geometry silhouettes against
    // literal black - the #1 amateur tell in ARCHITECTURE 7.6. Relative to the
    // key, because an absolute floor that reads as "faint" at noon reads as
    // "milk" at midnight.
    var floor = Math.max(0.0007, 0.035 * keyRef);
    for (var c = 0; c < 3; c++) {
      if (this._fogSky[c] < floor) this._fogSky[c] = floor;
      if (this._fogSun[c] < floor) this._fogSun[c] = floor;
      if (this._fogGnd[c] < floor * 0.7) this._fogGnd[c] = floor * 0.7;
    }

    // Last, so it can override everything above with values that came from the
    // deck instead of from a clear column. No-op without a storm.
    this._applyStormAmbient();
  };

  // --------------------------------------------------------------------------
  // The storm deck's own radiance at one elevation, in its MEAN noise state.
  //
  // This mirrors the shader's deck exactly, minus the texture lookups. It has
  // to: _deriveAmbient integrates the LUT to decide what the scene is LIT by,
  // and the LUT knows nothing about the deck, so without this the harbor would
  // be lit by the clear night sky it cannot see while being shown a storm.
  // That split is precisely the bug this file's DAY_GAIN comment warns about,
  // in reverse - and it is the reason wet metal is the first thing that gives
  // an overcast away: nearly all of its value is reflected sky.
  //
  // "Exactly" is now enforced rather than asserted. Every coefficient below is
  // the same named constant the GLSL string is built from, and every noise
  // channel is replaced by its MEAN (thickness, cell bulge, macro and - new -
  // the azimuthal glow lobe, whose average over a full turn of the compass is
  // what the scene is lit by even though only the lobes are what you see). The
  // previous version carried its own hand-copied numbers and had drifted 1.74x
  // away from the shader, so the IBL was lighting the terminal with a deck
  // nearly a stop brighter than the one on screen.
  // --------------------------------------------------------------------------
  Sky.prototype._stormDeckRadiance = function (elevSin, out) {
    var up = Math.max(elevSin, 0.0);
    var horiz = Math.exp(-up * 3.2);
    var thick = STORM_MEAN_THICK;
    // Cold term. STORM_BAND_* has mean 1.0 by construction, so it drops out.
    var k = STORM_DECK_MIN + STORM_DECK_RANGE * STORM_MEAN_TRANS;
    // Hue tint (luminance-neutral, so it only shifts the balance).
    var tR = 0.88 + (1.08 - 0.88) * thick;
    var tG = 0.99 + (1.00 - 0.99) * thick;
    var tB = 1.17 + (0.90 - 1.17) * thick;
    // Warm term: elevation falloff x mean azimuthal lobe x macro x back-scatter
    // saturation x mean cell bulge.
    var refl = thick * (STORM_REFL_A - STORM_REFL_B * thick);
    var bulge = STORM_CELL_LO + STORM_CELL_HI * STORM_MEAN_BULGE;
    var glow = Math.exp(-up / STORM_GLOW_FALL) * STORM_MEAN_AZ *
      (STORM_MACRO_LO + STORM_MACRO_HI * 0.5) * refl * bulge;
    // Ground-bounce dome, evaluated for an eye standing ON the terminal (the
    // only place the IBL is ever sampled from). The shader intersects the view
    // ray with the cloud base in world space; the mirror does the same thing in
    // closed form, because from the centre of the lit patch the horizontal
    // distance to the intersection is just h/tan(elevation).
    var dome = 0;
    var sEl = Math.max(up, 0.05);
    var cEl = Math.sqrt(Math.max(0.0, 1.0 - sEl * sEl));
    var rr = (this._bounceH - 1.7) * cEl / sEl / Math.max(this._bounceR, 1e-3);
    dome = 1.0 / (1.0 + rr * rr);
    dome *= (STORM_BOUNCE_AZ_LO + STORM_BOUNCE_AZ_HI * STORM_MEAN_AZ) * refl * bulge;
    for (var c = 0; c < 3; c++) {
      var amb = STORM_ZENITH[c] + (STORM_HORIZON[c] - STORM_ZENITH[c]) * horiz;
      var d = amb * k * (c === 0 ? tR : (c === 1 ? tG : tB)) +
        STORM_GLOW[c] * glow + STORM_BOUNCE[c] * dome;
      // Same soft toe the shader applies, so the IBL sees the deck that is
      // actually drawn rather than an idealised one two stops down in the dark.
      var f = STORM_DECK_FLOOR[c];
      out[c] = f + d * d / Math.max(d + f, 1e-6);
    }
    return out;
  };

  // --------------------------------------------------------------------------
  // Replace every LIGHT term the clear-sky path derived with one taken off the
  // storm deck. Runs at the very end of _deriveAmbient and returns immediately
  // when _stormF is 0.
  //
  // The magnitudes are authored absolutes rather than multiples of keyRef - see
  // the STORM WEATHER header for why a key reference is meaningless at 02:00
  // under nimbostratus - but the SHAPE is integrated, not guessed: the
  // hemisphere fill is a genuine cosine-weighted integral of the same deck the
  // player is looking at, so the sodium underglow (which lives low, where the
  // cosine weight is small) contributes to the fill exactly as much as it
  // physically should and no more.
  // --------------------------------------------------------------------------
  var _stormRad = [0, 0, 0];
  Sky.prototype._applyStormAmbient = function () {
    var sf = M.saturate(this._stormF);
    if (!(sf > 0.001)) return;
    var EL = 24, j, c;

    // Cosine-weighted upper-hemisphere mean (the irradiance the sky delivers)
    // and a full-hemisphere mean (what a rough surface reflects).
    var ambR = 0, ambG = 0, ambB = 0, ambW = 0;
    var fillR = 0, fillG = 0, fillB = 0, fillW = 0;
    for (j = 0; j < EL; j++) {
      var el = (PI * 0.5) * (j + 0.5) / EL;
      var s = Math.sin(el), cw = Math.cos(el) * s;
      this._stormDeckRadiance(s, _stormRad);
      ambR += _stormRad[0] * cw; ambG += _stormRad[1] * cw; ambB += _stormRad[2] * cw;
      ambW += cw;
      // The "fill" a surface down in a container canyon sees is the strip of
      // sky above it, so it is weighted toward the zenith the same way the
      // clear-sky path weights it.
      var fw = Math.cos(el) * Math.pow(s, 3.0);
      fillR += _stormRad[0] * fw; fillG += _stormRad[1] * fw; fillB += _stormRad[2] * fw;
      fillW += fw;
    }
    if (ambW > 0) { ambR /= ambW; ambG /= ambW; ambB /= ambW; }
    if (fillW > 0) { fillR /= fillW; fillG /= fillW; fillB /= fillW; }

    var lum = 0.2126 * fillR + 0.7152 * fillG + 0.0722 * fillB;

    this.ambientColor.setRGB(
      M.lerp(this.ambientColor.r, ambR, sf),
      M.lerp(this.ambientColor.g, ambG, sf),
      M.lerp(this.ambientColor.b, ambB, sf));
    this.skyColor.setRGB(
      M.lerp(this.skyColor.r, STORM_SKY_HUE[0], sf),
      M.lerp(this.skyColor.g, STORM_SKY_HUE[1], sf),
      M.lerp(this.skyColor.b, STORM_SKY_HUE[2], sf));
    this.zenithColor.setRGB(
      M.lerp(this.zenithColor.r, STORM_ZENITH_HUE[0], sf),
      M.lerp(this.zenithColor.g, STORM_ZENITH_HUE[1], sf),
      M.lerp(this.zenithColor.b, STORM_ZENITH_HUE[2], sf));
    // The lower hemisphere of a lit terminal is not a sand bounce - it is a
    // black wet apron with sodium pools on it, so the bounce is warm, and it is
    // the ONLY warm term left in the rig now that the moon has gone.
    this.groundColor.setRGB(
      M.lerp(this.groundColor.r, STORM_GND_HUE[0], sf),
      M.lerp(this.groundColor.g, STORM_GND_HUE[1], sf),
      M.lerp(this.groundColor.b, STORM_GND_HUE[2], sf));

    this.fillRadiance = M.lerp(this.fillRadiance, lum, sf);
    this.ambientIntensity = M.clamp(this.fillRadiance * PI * 1.36, 0.035, 0.95);

    // horizonColor is what lighting.js uses as the WARM half of the night key
    // (see its _readSky). Handing it the deck's underglow rather than a
    // twilight band is what keeps that key from reading as a sunset.
    this._stormDeckRadiance(0.02, _stormRad);
    this.horizonColor.setRGB(
      M.lerp(this.horizonColor.r, _stormRad[0], sf),
      M.lerp(this.horizonColor.g, _stormRad[1], sf),
      M.lerp(this.horizonColor.b, _stormRad[2], sf));

    // ---- inscatter --------------------------------------------------------
    // Authored hue, authored magnitude, no cap against keyRef. The cap upstream
    // measures the haze against a mid-grey card in the key; under this sky that
    // card is lit by nothing at all, so the cap would drive the far end of the
    // terminal to black - the exact failure NIGHT_HAZE_K was added to fix, one
    // step worse. The reference that governs these three numbers is the
    // lamp-lit ground, and they are all comfortably under it.
    this._stormFogColor(this._fogSky, STORM_HAZE_HUE, STORM_FOG_SKY_LUM, sf, 0.0);
    this._stormFogColor(this._fogSun, STORM_HAZE_HUE, STORM_FOG_SUN_LUM, sf, 0.45);
    // Only half-way to sodium. The bounce off a lamp-lit wet apron is warm, but
    // pure #ff9a3c below the horizon put a saturated amber floor under the
    // whole dome on the probe, and this triple is also what tints every
    // downward-looking fog ray in the level.
    this._stormFogColor(this._fogGnd, STORM_HAZE_HUE, STORM_FOG_GND_LUM, sf, 0.55);
  };

  // Blend one inscatter triple toward `hue` (max-normalised) at the given
  // luminance, optionally warmed toward sodium by `warm`.
  var _stormHue = [0, 0, 0];
  Sky.prototype._stormFogColor = function (dst, hue, targetLum, sf, warm) {
    var c, l = 0;
    for (c = 0; c < 3; c++) {
      _stormHue[c] = hue[c] + (STORM_SODIUM_HUE[c] - hue[c]) * warm;
    }
    l = 0.2126 * _stormHue[0] + 0.7152 * _stormHue[1] + 0.0722 * _stormHue[2];
    var k = targetLum / Math.max(l, 1e-6);
    for (c = 0; c < 3; c++) {
      dst[c] = dst[c] + (_stormHue[c] * k - dst[c]) * sf;
    }
  };

  // Scale an RGB triple in place so its luminance does not exceed `maxLum`,
  // preserving hue exactly. Used to keep the inscatter under the key.
  Sky.prototype._capRadiance = function (rgb, maxLum) {
    var l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    if (!(l > maxLum) || !(maxLum > 0)) return;
    var k = maxLum / l;
    rgb[0] *= k; rgb[1] *= k; rgb[2] *= k;
  };

  // ==========================================================================
  // Build
  // ==========================================================================
  Sky.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      this._makeLutTextures();
      this._makeDome();
      // Resolve the weather BEFORE the first LUT build, so the derived ambient,
      // every fog colour and the IBL are all generated once, in the right
      // condition, instead of being generated clear and then thrown away.
      this._resolveWeather(ctx);
      if (GAME.yieldFrame) await GAME.yieldFrame();

      this._buildLut();
      this._pushUniforms();
      if (GAME.yieldFrame) await GAME.yieldFrame();

      this._makeDust(ctx);
      this._installScene(ctx);
      this._built = true;

      this._regenerateEnvironment();
    } catch (e) {
      GAME.logError('sky.build', e);
    }
  };

  Sky.prototype._makeLutTextures = function () {
    var W = this.lutW, H = this.lutH;
    var mk = function () {
      var t = new THREE.DataTexture(new Uint16Array(W * H * 4), W, H,
        THREE.RGBAFormat, THREE.HalfFloatType);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      // Radiance data, NOT albedo - must stay out of sRGB.
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this._lutA = mk();
    this._lutB = mk();
    this._lutC = mk();
  };

  Sky.prototype._makeDome = function () {
    var u = this._skyUniforms = {
      uLutA: { value: this._lutA },
      uLutB: { value: this._lutB },
      uLutC: { value: this._lutC },
      uSunDir: { value: new THREE.Vector3().copy(this.sunWorldDirection) },
      uSunDisc: { value: new THREE.Vector3(320, 232, 142) },
      uMoonDir: { value: new THREE.Vector3().copy(this.moonDirection) },
      uMoonColor: { value: new THREE.Vector3(0.56, 0.66, 0.98) },
      uHazeSun: { value: new THREE.Vector3(1.6, 1.0, 0.5) },
      uHazeSky: { value: new THREE.Vector3(0.7, 0.7, 0.7) },
      uHazeGnd: { value: new THREE.Vector3(0.12, 0.09, 0.06) },
      uP: { value: new THREE.Vector4(MIE_G, 0.0088, 0.0075, SKY_SCALE) },
      uN: { value: new THREE.Vector4(0, 1, 1, 0) },
      // y = how hard the dome is pulled toward the fog colour at the horizon.
      // Small on purpose: it ties the hue so a distant building and the sky
      // above it agree, without dragging the sky's exposure down to the fog's.
      uMode: { value: new THREE.Vector4(1, 0.12, this.fog.mieG, MILKYWAY_LUM * SKY_SCALE) },
      uCloud: { value: new THREE.Vector4(CLOUD_COVER, CLOUD_AMOUNT, CLOUD_BEER, 0) },
      uCloudSun: { value: new THREE.Vector3(0.42, 0.36, 0.28) },
      uCloudAmb: { value: new THREE.Vector3(0.09, 0.10, 0.13) },
      uDay: { value: new THREE.Vector4(1.0, 1e9, 2e9, CLOUD_SCALE) },
      // ---- storm deck. uStorm.x = 0 makes the whole block dead code. -------
      // The texture stays null until setWeather() asks for one: generating a
      // 256^2 four-channel noise field costs about half a second and the market
      // level must not pay it. three binds its own empty texture for a null
      // sampler (the dust field's uShadowMap has relied on that for two
      // rounds), so an unused sampler here is safe.
      uStormTex: { value: null },
      uStorm: { value: new THREE.Vector4(0, STORM_COVER, STORM_DETAIL, 0) },
      uStormDrift: { value: new THREE.Vector4(0, 0, 0, 0) },
      uStormLow: { value: new THREE.Vector3(STORM_HORIZON[0], STORM_HORIZON[1], STORM_HORIZON[2]) },
      uStormHigh: { value: new THREE.Vector3(STORM_ZENITH[0], STORM_ZENITH[1], STORM_ZENITH[2]) },
      uStormGlow: { value: new THREE.Vector3(STORM_GLOW[0], STORM_GLOW[1], STORM_GLOW[2]) },
      uStormBounce: { value: new THREE.Vector3(STORM_BOUNCE[0], STORM_BOUNCE[1], STORM_BOUNCE[2]) },
      uStormBase: {
        value: new THREE.Vector4(STORM_BOUNCE_H,
          1.0 / (STORM_BOUNCE_R * STORM_BOUNCE_R),
          STORM_BOUNCE_CTR[0], STORM_BOUNCE_CTR[1])
      },
      uFlash: { value: new THREE.Vector4(0, 0, 0, STORM_FLASH_TIGHT) },
      uFlashDir: { value: new THREE.Vector3(0.42, 0.62, -0.66).normalize() }
    };

    var mat = this._skyMaterial = new THREE.ShaderMaterial({
      uniforms: u,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      // depthTest off + a very negative renderOrder means the dome is painted
      // first and never fights geometry for the depth buffer; sky pixels keep
      // the cleared far depth, which is exactly what postfx wants to see.
      depthTest: false,
      fog: false,
      toneMapped: false
    });

    // Tessellation is irrelevant to quality here - every fragment normalises
    // its own interpolated position, which is the exact view ray for any convex
    // hull centred on the eye - so this stays deliberately coarse (768 tris).
    var geo = new THREE.SphereGeometry(1, 24, 16);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'sky_dome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = true;

    // A second instance, sharing geometry and material, lives in a private
    // scene used only for the IBL capture. Reparenting the visible dome every
    // regeneration would be a needless source of one-frame glitches.
    this._envScene = new THREE.Scene();
    this._envMesh = new THREE.Mesh(geo, mat);
    this._envMesh.frustumCulled = false;
    this._envScene.add(this._envMesh);
  };

  Sky.prototype._makeDust = function (ctx) {
    var q = (ctx && ctx.quality && ctx.quality.particles) || 1.0;
    var count = Math.round(M.clamp(880 * q, 160, 1800));
    var rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x51D5) : new GAME.RNG(0x51D5);

    // 14 m, not 26: at 26 the wrap put motes far enough out to clear a parapet
    // and land on open sky. Combined with the 11 m fade in DUST_VERT nothing
    // draws at a distance where it could read as a speck on the horizon.
    var cell = new THREE.Vector3(14, 7, 14);
    var pos = new Float32Array(count * 3);
    var seed = new Float32Array(count * 4);
    for (var i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-cell.x * 0.5, cell.x * 0.5);
      pos[i * 3 + 1] = rng.range(-cell.y * 0.5, cell.y * 0.5);
      pos[i * 3 + 2] = rng.range(-cell.z * 0.5, cell.z * 0.5);
      seed[i * 4] = rng.next();
      seed[i * 4 + 1] = rng.range(0.06, 0.30);
      // Heavy tail on size: a handful of big lazy motes plus a haze of small
      // ones reads as real dust; a uniform size reads as a particle system.
      seed[i * 4 + 2] = 0.008 + Math.pow(rng.next(), 3.0) * 0.055;
      seed[i * 4 + 3] = 0.22 + Math.pow(rng.next(), 1.7) * 0.95;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this._dustUniforms = {
      uCamPos: { value: new THREE.Vector3() },
      uCell: { value: cell },
      uSunDir: { value: new THREE.Vector3().copy(this.sunDirection) },
      uT: { value: new THREE.Vector2(0, 500) },
      uSunCol: { value: new THREE.Vector3(3.2, 2.3, 1.4) },
      uSkyCol: { value: new THREE.Vector3(0.34, 0.42, 0.62) },
      uGain: { value: 1.0 },
      uShadowMap: { value: null },
      uShadowMat: { value: new THREE.Matrix4() },
      uShadowP: { value: new THREE.Vector2(0.0, 0.0016) }
    };

    var mat = this._dustMaterial = new THREE.ShaderMaterial({
      uniforms: this._dustUniforms,
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false
    });

    this.dustParticles = new THREE.Points(geo, mat);
    this.dustParticles.name = 'sky_dust';
    this.dustParticles.frustumCulled = false;
    this.dustParticles.renderOrder = 20;
    this.dustParticles.castShadow = false;
    this.dustParticles.receiveShadow = false;
  };

  // ==========================================================================
  // STORM CLOUD FIELD
  //
  // One 256x256 RGBA data texture, built on the CPU out of GAME.Noise, sampled
  // three times at different scales and drifts by the dome shader.
  //
  // WHY A TEXTURE AND NOT PURE GLSL. The obvious implementation is fbm in the
  // fragment shader, and it is the wrong one here. A convincing storm base
  // needs four octaves of fbm plus a worley layer per sample and three samples
  // per pixel; on the software rasteriser the capture harness runs that is
  // roughly eighty hash evaluations for every sky pixel in a 1280x720 frame,
  // and the sky is 40% of this level's pixels. Baking it costs half a second
  // once, at load, and turns the per-pixel cost into three texture fetches -
  // which are also MIPMAPPED, and that matters more than the speed: the deck
  // projection compresses toward the horizon without limit, and a procedural
  // fbm has no way to filter itself there. It aliases into a crawling band
  // along the skyline. The mip chain solves that for free.
  //
  // CHANNELS
  //   r  base masses      fbm, 3 octaves, low frequency - the deck itself
  //   g  mid structure    fbm, 4 octaves - the rolls and rifts inside it
  //   b  cells            inverted worley - the sagging cells of the base,
  //                       which is what the sodium underglow lands on
  //   a  wisps            ridged fbm - torn scud, the highest frequency layer
  //
  // SEAMLESSNESS. GAME.Noise's lattice has a period of 256 units, so the
  // obvious "sample one whole period" trick would need 256 cells across the
  // texture, i.e. white noise. Instead each channel is evaluated four times,
  // at (x, y), (x-F, y), (x, y-F) and (x-F, y-F), and bilinearly blended by
  // (u, v). At u = 1 the first term's argument is x = F and the second's is 0,
  // so opposite edges are the same sample by construction and the tile is exact
  // for ANY frequency. It costs 4x the noise evaluations and slightly flattens
  // the contrast mid-tile, which the curve below puts back.
  //
  // A visible seam in a sky is a straight line across the whole frame. There is
  // no such thing as an acceptable one.
  // ==========================================================================
  Sky.prototype._makeStormTexture = function () {
    if (this._stormTex) return this._stormTex;
    try {
      var S = STORM_TEX_SIZE;
      var noise = new GAME.Noise(0x57C10D);
      var data = new Uint8Array(S * S * 4);

      // Hoisted so the inner loop allocates nothing.
      var fBase = function (x, y) { return noise.fbm2(x, y, 3, 2.0, 0.52); };
      var fMid = function (x, y) { return noise.fbm2(x, y, 4, 2.0, 0.50); };
      // worley2 returns { f1, f2, edge }, not a scalar. f1 is the distance to
      // the nearest feature point, so 1 - f1 is bright at cell CENTRES - which
      // is what a sagging cloud cell is: a bulge, brightest where it hangs
      // lowest and closest to the lamps.
      var fCell = function (x, y) {
        var w = noise.worley2(x, y, 1.0);
        return 1.0 - Math.min(1.0, w.f1);
      };
      var fWisp = function (x, y) { return noise.ridged2(x, y, 3); };

      var FB = 3, FM = 7, FC = 5, FW = 11;   // cells across the tile per channel

      var i, j, o, u, v;
      var a0, a1, a2, a3, w0, w1, w2, w3;
      for (j = 0; j < S; j++) {
        v = j / S;
        for (i = 0; i < S; i++) {
          u = i / S;
          o = (j * S + i) * 4;
          w0 = (1 - u) * (1 - v); w1 = u * (1 - v);
          w2 = (1 - u) * v;       w3 = u * v;

          // r ---------------------------------------------------------------
          a0 = fBase(u * FB, v * FB);
          a1 = fBase(u * FB - FB, v * FB);
          a2 = fBase(u * FB, v * FB - FB);
          a3 = fBase(u * FB - FB, v * FB - FB);
          data[o] = _stormByte((a0 * w0 + a1 * w1 + a2 * w2 + a3 * w3) * 1.55 + 0.5, 1.25);

          // g ---------------------------------------------------------------
          a0 = fMid(u * FM, v * FM);
          a1 = fMid(u * FM - FM, v * FM);
          a2 = fMid(u * FM, v * FM - FM);
          a3 = fMid(u * FM - FM, v * FM - FM);
          data[o + 1] = _stormByte((a0 * w0 + a1 * w1 + a2 * w2 + a3 * w3) * 1.75 + 0.5, 1.10);

          // b ---------------------------------------------------------------
          a0 = fCell(u * FC, v * FC);
          a1 = fCell(u * FC - FC, v * FC);
          a2 = fCell(u * FC, v * FC - FC);
          a3 = fCell(u * FC - FC, v * FC - FC);
          data[o + 2] = _stormByte(a0 * w0 + a1 * w1 + a2 * w2 + a3 * w3, 0.85);

          // a ---------------------------------------------------------------
          a0 = fWisp(u * FW, v * FW);
          a1 = fWisp(u * FW - FW, v * FW);
          a2 = fWisp(u * FW, v * FW - FW);
          a3 = fWisp(u * FW - FW, v * FW - FW);
          data[o + 3] = _stormByte(a0 * w0 + a1 * w1 + a2 * w2 + a3 * w3, 1.35);
        }
      }

      var tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat,
        THREE.UnsignedByteType);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      // Density/structure data, not albedo. sRGB here would gamma-crush the
      // thin patches - the exact detail the deck's depth is carried by.
      tex.colorSpace = THREE.NoColorSpace;
      tex.needsUpdate = true;
      this._stormTex = tex;
      if (this._skyUniforms && this._skyUniforms.uStormTex) {
        this._skyUniforms.uStormTex.value = tex;
      }
      return tex;
    } catch (e) {
      GAME.logError('sky.stormTexture', e);
      return null;
    }
  };

  // Remap a blended noise value into a byte with a contrast curve that puts
  // back what the four-corner tiling blend takes out.
  function _stormByte(v, contrast) {
    var t = M.saturate(v);
    if (contrast !== 1.0) {
      t = M.saturate(0.5 + (t - 0.5) * contrast);
    }
    return Math.round(t * 255);
  }

  Sky.prototype._installScene = function (ctx) {
    if (!ctx || !ctx.scene) return;
    if (this.mesh) ctx.scene.add(this.mesh);
    if (this.dustParticles) ctx.scene.add(this.dustParticles);

    // scene.fog only has to EXIST for three to define USE_FOG and compile our
    // chunks; every parameter that matters lives in the gbFog* uniforms. The
    // colour is kept roughly in sync anyway so any module that reads
    // scene.fog.color gets something sensible.
    if (!ctx.scene.fog) {
      ctx.scene.fog = new THREE.FogExp2(0x9fa6ad, 0.0075);
    }
    this._syncSceneFog(ctx.scene);
    if (this.envMap) ctx.scene.environment = this.envMap;
  };

  Sky.prototype._syncSceneFog = function (scene) {
    if (!scene || !scene.fog) return;
    // Rough Reinhard so an HDR haze colour becomes a plausible LDR fog colour.
    var r = this._fogSky[0], g = this._fogSky[1], b = this._fogSky[2];
    scene.fog.color.setRGB(r / (1 + r), g / (1 + g), b / (1 + b));
    // The SCHEDULED density, not the authored base: postfx reads this to size
    // its volumetric march (it is the only channel it has for "how thick is the
    // air right now"), so publishing a constant meant its raymarch ran at the
    // same density at midnight as at noon and there was no atmosphere after
    // dark for a practical to glow in. See _scheduleHaze.
    //
    // The 0.6 is an equivalence factor between our exponential HEIGHT fog and
    // three's FogExp2 (a distance-squared law with no height term).
    //
    // It is deliberately NOT boosted further after dark, and that was measured,
    // not assumed. postfx's volumetric raymarch runs to its full 105 m on any
    // pixel with no geometry in it - i.e. on the sky - and its scatter colour is
    // KEY-ONLY, so once the key was moved into the forward hemisphere (see
    // _solar) its phase term went up twelve-fold and the march started painting
    // moon-coloured inscatter over the whole night dome. Pushing this channel
    // up as well took the night sky wedge to 0.344 luminance at saturation
    // 0.154 - a milky grey lid, which is the one thing the sky must never be.
    // The night haze that matters is the one THIS module applies to geometry
    // (fogDensityEffective, up 70% after dark) and the levels the caps allow it
    // to reach (nightHazeGain); a practical's halo wants sky.scatterRadiance,
    // not a bigger number in a key-only raymarch.
    if (scene.fog.isFogExp2) scene.fog.density = this.fogDensityEffective * 0.6;
  };

  // ==========================================================================
  // Uniform sync
  // ==========================================================================
  Sky.prototype._pushUniforms = function () {
    this._scheduleHaze();
    var f = this.fog;
    // fog.density is the authored base; fogDensityEffective is that base with
    // the time-of-day schedule applied. Never write the schedule back into
    // f.density - setFog() would be overwritten and repeated calls would
    // compound the multiplier.
    var d = f.enabled ? this.fogDensityEffective : 0.0;
    // _fogParam() returns the authored value unchanged with no storm, and
    // blends toward STORM_FOG with one. A downpour is not a thicker version of
    // dust haze: it fills the whole column rather than hugging the ground
    // (heightScale), it scatters almost isotropically because there is no key
    // to forward-scatter from (mieG), and it eats chroma at distance far
    // harder than dry air does (desaturate).
    this._fogA[0] = d;
    this._fogA[1] = 1.0 / Math.max(0.5, this._fogParam('heightScale'));
    this._fogA[2] = f.baseY;
    this._fogA[3] = isFinite(this.fogStartEffective)
      ? this.fogStartEffective : Math.max(0.0, f.startDistance);
    this._fogB[0] = M.saturate(this._fogParam('maxOpacity'));
    this._fogB[1] = M.clamp(this._fogParam('mieG'), 0.0, 0.92);
    this._fogB[2] = Math.max(0.0, this._fogParam('glowGain'));
    this._fogB[3] = M.saturate(this._fogParam('desaturate'));
    this._fogDir[0] = this.sunDirection.x;
    this._fogDir[1] = this.sunDirection.y;
    this._fogDir[2] = this.sunDirection.z;

    var u = this._skyUniforms;
    if (u) {
      // The dome always draws the true sun, even when the published key light
      // has been swapped to the moon for night.
      var el = this.sunElevation;
      u.uSunDir.value.copy(this.sunWorldDirection);
      u.uMoonDir.value.copy(this.moonDirection);

      var T = transmittanceRaw(0.0, Math.sin(el), this._tmpRGB);
      var kr0 = this._keyRef();
      var discGain = SUN_DISC_K * kr0;
      u.uSunDisc.value.set(T[0] * discGain, T[1] * discGain, T[2] * discGain);

      // ---- display shoulder ------------------------------------------------
      // Full strength once the sun is properly up; entirely off through civil
      // twilight and night, where the authored afterglow and airglow layers
      // already sit at a chosen level and where the sky is legitimately the
      // brightest thing in the frame. _regenerateEnvironment overrides this to
      // the identity for the duration of the probe capture.
      var dayF = M.smoothstep(2.0, 9.0, el / M.DEG);
      this._dayGain = 1.0 + (DAY_GAIN - 1.0) * dayF;
      this._dayAsym = DAY_SHOULDER_K * kr0;
      if (dayF < 0.999) {
        // Push the knee out of reach as the gain relaxes, so twilight sees a
        // pure (and eventually unity) multiply rather than a moving shoulder.
        this._dayAsym = this._dayAsym / Math.max(dayF, 1e-3);
      }
      u.uDay.value.set(this._dayGain, this._dayAsym * DAY_KNEE_F,
        this._dayAsym, CLOUD_SCALE);

      var degEl = el / M.DEG;
      var nightF = M.smoothstep(0.5, -7.0, degEl);
      u.uN.value.set(nightF, STAR_LUM * SKY_SCALE,
        M.saturate(this.moonDirection.y / 0.06), u.uN.value.w);
      u.uP.value.set(MIE_G, 0.0088, 0.0075, SKY_SCALE);
      u.uMode.value.z = M.clamp(f.mieG, 0.0, 0.92);
      u.uMode.value.w = MILKYWAY_LUM * SKY_SCALE;
      u.uHazeSun.value.set(this._fogSun[0], this._fogSun[1], this._fogSun[2]);
      u.uHazeSky.value.set(this._fogSky[0], this._fogSky[1], this._fogSky[2]);
      if (u.uHazeGnd) {
        u.uHazeGnd.value.set(this._fogGnd[0], this._fogGnd[1], this._fogGnd[2]);
      }
      var ml = MOON_LUM * SKY_SCALE;
      u.uMoonColor.value.set(this.moonColor.r * ml, this.moonColor.g * ml, this.moonColor.b * ml);

      // ---- cloud deck ------------------------------------------------------
      // Both cloud colours are derived from keyRef, the same reference the dome
      // shoulder and every fog cap use, so the deck tracks time of day for free
      // and can never drift out of the atmosphere it sits in. A sunlit cloud
      // top is a ~0.75-albedo Lambertian in full sun; the shadow side is
      // skylight plus a little multiple scattering through the deck.
      var kr = kr0;
      var st = Math.max(T[0], Math.max(T[1], T[2])) || 1.0;
      var lit = 0.80 * kr;
      u.uCloudSun.value.set(T[0] / st * lit, T[1] / st * lit, T[2] / st * lit);
      var amb = 0.34 * kr;
      u.uCloudAmb.value.set(this.skyColor.r * amb, this.skyColor.g * amb,
        this.skyColor.b * amb);
      if (u.uCloud) {
        u.uCloud.value.x = CLOUD_COVER;
        // The clear sky's broken cirrus band has no business under a storm
        // deck, and leaving it on would put a second, differently-lit cloud
        // layer inside the first. Exactly CLOUD_AMOUNT when _stormF is 0.
        u.uCloud.value.y = CLOUD_AMOUNT * (1.0 - M.saturate(this._stormF));
        u.uCloud.value.z = CLOUD_BEER;
      }

      // ---- storm deck ------------------------------------------------------
      if (u.uStorm) {
        var sf = M.saturate(this._stormF);
        u.uStorm.value.set(sf, STORM_COVER, STORM_DETAIL, this._windAngle);
        if (sf > 0 && this._stormTex && u.uStormTex) {
          u.uStormTex.value = this._stormTex;
        }
        u.uStormLow.value.set(STORM_HORIZON[0], STORM_HORIZON[1], STORM_HORIZON[2]);
        u.uStormHigh.value.set(STORM_ZENITH[0], STORM_ZENITH[1], STORM_ZENITH[2]);
        u.uStormGlow.value.set(STORM_GLOW[0], STORM_GLOW[1], STORM_GLOW[2]);
        if (u.uStormBounce) {
          u.uStormBounce.value.set(STORM_BOUNCE[0], STORM_BOUNCE[1], STORM_BOUNCE[2]);
        }
        if (u.uStormBase) {
          u.uStormBase.value.set(this._bounceH,
            1.0 / (this._bounceR * this._bounceR),
            this._bounceCtr.x, this._bounceCtr.y);
        }
        u.uStormDrift.value.set(this._driftNear.x, this._driftNear.y,
          this._driftFar.x, this._driftFar.y);
        u.uFlash.value.set(this._flashRGB.x, this._flashRGB.y, this._flashRGB.z,
          STORM_FLASH_TIGHT);
        u.uFlashDir.value.copy(this._flashDir);
      }
    }

    var du = this._dustUniforms;
    if (du) {
      du.uSunDir.value.copy(this.sunDirection);
      // Referenced to keyRef, not to the raw sun IRRADIANCE. The old
      // sunIntensity * 0.55 put a lit mote at 3.4 radiance - 26x the brightest
      // surface in the frame - so every mote printed as a blown white speck
      // whatever it was in front of. 6 x keyRef is a bright but resolvable
      // mote: about twice a sunlit plaster wall, which is what a scatterer
      // caught in a shaft actually looks like.
      var k = 6.0 * this._keyRef();
      du.uSunCol.value.set(this.sunColor.r * k, this.sunColor.g * k, this.sunColor.b * k);
      // A mote is a surface being lit, so its shadow side carries the sky's
      // RADIANCE, not the hemisphere light's irradiance. Driving it off
      // ambientIntensity (which is pi times larger) made the motes glow.
      // Capped against keyRef for the same reason as the sunlit half.
      var sc = Math.min(this.fillRadiance * 1.05, 0.55 * this._keyRef());
      du.uSkyCol.value.set(
        this.skyColor.r * sc, this.skyColor.g * sc, this.skyColor.b * sc);
    }

    if (this.ctx && this.ctx.scene) this._syncSceneFog(this.ctx.scene);
  };

  // ==========================================================================
  // IBL: sky -> cube render target -> PMREM
  // ==========================================================================
  Sky.prototype._regenerateEnvironment = function () {
    var ctx = this.ctx;
    if (!ctx || !ctx.renderer || !this._envScene) return;
    var renderer = ctx.renderer;

    var oldAutoClear = renderer.autoClear;
    var oldTarget = renderer.getRenderTarget();
    // The sun disc is deliberately kept OUT of the probe. A 340-unit point
    // source inside a PMREM turns into a firefly at low roughness and it would
    // double-count against lighting.js's directional light; the Mie aureole
    // around it survives, which is the part that actually matters for IBL.
    var oldMode = this._skyUniforms ? this._skyUniforms.uMode.value.x : 1;
    // The display shoulder is a PICTURE operation. The probe is a LIGHT
    // measurement, so it must see the unmodified physical radiance field or the
    // scene loses a stop and a half of skylight fill as a side effect of a
    // change that was only ever about what the sky prints as. See DAY_GAIN.
    var oldDay = this._skyUniforms ? this._skyUniforms.uDay.value.clone() : null;

    try {
      if (this._skyUniforms) {
        this._skyUniforms.uMode.value.x = 0.0;
        this._skyUniforms.uDay.value.set(1.0, 1e9, 2e9, this._skyUniforms.uDay.value.w);
      }
      renderer.autoClear = true;

      if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);

      var rt = null;
      if (!this._useFromScene) {
        try {
          if (!this._cubeRT) {
            this._cubeRT = new THREE.WebGLCubeRenderTarget(128, {
              type: THREE.HalfFloatType,
              format: THREE.RGBAFormat,
              generateMipmaps: false,
              minFilter: THREE.LinearFilter,
              magFilter: THREE.LinearFilter,
              depthBuffer: false
            });
            this._cubeRT.texture.colorSpace = THREE.NoColorSpace;
            this._cubeCam = new THREE.CubeCamera(0.05, 20, this._cubeRT);
          }
          this._cubeCam.position.set(0, 0, 0);
          this._cubeCam.updateMatrixWorld(true);
          this._cubeCam.update(renderer, this._envScene);
          this.cubeTexture = this._cubeRT.texture;
          rt = this._pmrem.fromCubemap(this.cubeTexture, this._pmremRT || null);
        } catch (e) {
          // r180's PMREMGenerator reads texture.image[0].width, which a cube
          // render target does not have on every build. Fall back to the scene
          // path permanently instead of retrying and re-throwing every time.
          GAME.logError('sky.pmrem.fromCubemap', e);
          this._useFromScene = true;
          rt = null;
        }
      }

      if (!rt) {
        rt = this._pmrem.fromScene(this._envScene, 0.0, 0.05, 20, { size: 256 });
        if (this._pmremRT && this._pmremRT !== rt) {
          try { this._pmremRT.dispose(); } catch (e2) { /* ignore */ }
        }
      }

      this._pmremRT = rt;
      this.envMap = rt.texture;
      if (ctx.scene) ctx.scene.environment = this.envMap;
      this._envDirty = false;
      this._envSunY = this.sunWorldDirection.y;
      this._envSunAz = this.sunAzimuth;
    } catch (e) {
      GAME.logError('sky.env', e);
    } finally {
      if (this._skyUniforms) {
        this._skyUniforms.uMode.value.x = oldMode;
        if (oldDay) this._skyUniforms.uDay.value.copy(oldDay);
      }
      renderer.autoClear = oldAutoClear;
      try { renderer.setRenderTarget(oldTarget); } catch (e3) { /* ignore */ }
    }
  };

  // ==========================================================================
  // Public API
  // ==========================================================================
  /**
   * @param {number} t 0..1. 0 = solar midnight, 0.25 = sunrise, 0.5 = noon,
   *                  0.75 = sunset. Default 0.3169 (14 deg, golden hour).
   */
  Sky.prototype.setTimeOfDay = function (t) {
    try {
      if (!isFinite(t)) return;
      t = t - Math.floor(t);
      this.timeOfDay = t;
      this._solar(t);
      this._computeLightingTerms();

      if (!this._built) return;      // build() will do the heavy lifting

      // The LUT lives in a sun-relative frame, so a pure azimuth change costs
      // nothing; only elevation invalidates it. The ONLY valid throttle is the
      // one below: "has the sun actually moved since the LUT was built".
      //
      // This used to additionally carry `&& this._lutFrame !== ctx.frame`, and
      // that one clause silently broke every time-of-day preset in the game.
      // ctx.frame does not exist until main.js's first step(), and the capture
      // harness applies a scenario BEFORE that first step - so `frame` was 0
      // for every call made during scenario setup. scenarios.js's dusk and
      // night both call street() (t = 0.32) and then set their own t; the first
      // call latched _lutFrame = 0 and the second was skipped, leaving the LUT,
      // the derived ambient, every fog colour and the PMREM'd environment
      // holding noon values at midnight. Never throttle on a frame counter that
      // a caller can legitimately see twice.
      var sunY = Math.sin(this.sunElevation);
      if (!this._lutReady || Math.abs(sunY - this._lutSunY) > 0.0022) {
        this._buildLut();
      }
      this._pushUniforms();

      // Same re-entrancy requirement: this must be callable twice in one frame.
      if (this._envDirty ||
          Math.abs(this.sunWorldDirection.y - this._envSunY) > 0.004 ||
          Math.abs(this.sunAzimuth - this._envSunAz) > 0.01) {
        this._regenerateEnvironment();
      }
    } catch (e) {
      GAME.logError('sky.setTimeOfDay', e);
    }
  };

  // ==========================================================================
  // WEATHER
  // ==========================================================================
  /**
   * Select the atmospheric condition.
   *
   *   sky.setWeather('clear')    the default, and every previous behaviour of
   *                              this module, unchanged.
   *   sky.setWeather('storm')    a full nimbostratus deck: no stars, no moon
   *                              disc, no sun disc, a very low cold ambient, a
   *                              sodium underglow on the cloud base, dense
   *                              cold rain haze, and an IBL regenerated from
   *                              that dome so wet surfaces and metal reflect an
   *                              overcast instead of a night sky.
   *   sky.setWeather('drizzle')  the same deck at 55% - thinner, some sky
   *                              still showing through, lighter haze.
   *   sky.setWeather('overcast') the deck without the rain fog levels.
   *
   * Safe to call before build() (the state is applied and build() picks it up)
   * and safe to call repeatedly with the same value (it returns immediately
   * rather than regenerating the environment). Never throws.
   *
   * This is the ONLY door into the storm path. Nothing in this module changes
   * behaviour without it, which is why level 1 is guaranteed unchanged.
   */
  Sky.prototype.setWeather = function (preset) {
    try {
      var name = (typeof preset === 'string') ? preset.toLowerCase() : 'clear';
      var f = 0;
      if (name === 'storm') f = 1.0;
      else if (name === 'overcast') f = 0.85;
      else if (name === 'drizzle') f = 0.55;
      else name = 'clear';

      if (this.weatherPreset === name && this._built) return;
      this.weatherPreset = name;
      this._stormF = f;
      if (f > 0) this._makeStormTexture();

      // Cheap: sun/moon geometry has not moved, only what the deck does to it.
      this._computeLightingTerms();
      if (!this._built) {
        // Remember it so _resolveWeather does not overrule an explicit
        // pre-build call with the level registry's declaration.
        this._pendingWeather = name;
        return;
      }

      // The LUT itself is unchanged by weather (the deck is a separate layer),
      // but _deriveAmbient hangs off it and now has to run the storm override,
      // so go through _buildLut rather than calling _deriveAmbient directly -
      // _buildLut is also what re-runs the haze schedule the caps depend on.
      this._buildLut();
      this._pushUniforms();
      // The whole point of the exercise: metals and wet concrete get nearly all
      // their visible value from what they reflect, so a storm sky that is not
      // in the probe is a storm sky that does not exist as far as every wet
      // surface in the terminal is concerned.
      this._regenerateEnvironment();
    } catch (e) { GAME.logError('sky.setWeather', e); }
  };

  /**
   * Decide the condition at build time.
   *
   * Precedence: an explicit setWeather() call before build() wins; then the
   * level registry's own declaration (main.js publishes ctx.levelDef.weather,
   * which is null for the market and 'storm' for the harbor); then ctx.levelId
   * as a last resort in case a level ships without declaring one.
   *
   * The market's levelDef declares weather: null, so this resolves to 'clear'
   * and every line of the storm path stays dead for level 1.
   */
  Sky.prototype._resolveWeather = function (ctx) {
    try {
      var want = this._pendingWeather;
      // ?weather=storm on the capture URL. A QA hook, not a default: it exists
      // so the dome, the IBL and the haze can be photographed and graded on
      // their own, without waiting on a level module, and so a critic can put
      // the same sky over two different sets of geometry. Nothing sets it
      // unless someone types it.
      if (!want && GAME.params && typeof GAME.params.weather === 'string') {
        want = GAME.params.weather;
      }
      if (!want && ctx && ctx.levelDef && typeof ctx.levelDef.weather === 'string') {
        want = ctx.levelDef.weather;
      }
      if (!want && ctx && ctx.levelId === 'harbor') want = 'storm';
      if (!want) return;
      this._pendingWeather = null;
      // Not setWeather(): _built is still false, so this only lands the state
      // and lets build()'s own _buildLut / _pushUniforms / environment pass
      // pick it up. Calling the public method here would work but would
      // regenerate the PMREM twice.
      var name = String(want).toLowerCase();
      var f = name === 'storm' ? 1.0
            : name === 'overcast' ? 0.85
            : name === 'drizzle' ? 0.55 : 0.0;
      if (f <= 0) return;
      this.weatherPreset = name;
      this._stormF = f;
      this._makeStormTexture();
      this._computeLightingTerms();
    } catch (e) { GAME.logError('sky.resolveWeather', e); }
  };

  // --------------------------------------------------------------------------
  // Per-frame read of the weather contract (src/fx/weather.js).
  //
  // weather.js is built AFTER this module and updated after it too, so what we
  // read here is one frame old. That is correct and deliberate: a flash lasts
  // 60-180 ms, i.e. 4-11 frames, so a one-frame lag is invisible, and trying to
  // read it earlier in the frame would mean depending on a system that may not
  // exist yet.
  //
  // Everything is guarded field by field. weather.js is another agent's module;
  // a missing field must degrade, never throw out of the frame loop.
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // The key irradiance the scene is receiving from THIS frame's strike.
  //
  // lighting.js already computes it (Lighting.keyIntensity, from its own harbor
  // budget minus whatever weather.js's flash light is spending), so the honest
  // thing is to read it rather than to re-derive it from constants that live in
  // a different file and are retuned by a different agent. That is the whole
  // point of the fix: ONE number sizes the strike, and it is the one the scene
  // actually gets lit by.
  //
  // The one wrinkle is ORDER. sky.js updates before lighting.js, so
  // lighting.keyIntensity on entry belongs to the flash value this module read
  // LAST frame, not to the one it is about to publish. Using it directly would
  // put the deck one frame behind the ground on a 4-11 frame event, i.e.
  // visibly wrong on exactly the two frames that matter (the rise and the
  // peak). So what is observed is the RATIO - irradiance per unit of flash,
  // which is a property of lighting.js's budget and changes only when someone
  // retunes it - and this frame's own flash is applied to that. Linear, exact
  // while lighting.js's own expression is linear (it is: a max of three terms
  // proportional to `raw`), and self-correcting the moment it is not.
  //
  // Everything degrades: no ctx.lighting, no keyIntensity, a NaN, a zero, or a
  // build where fx/weather.js never fires - any of them leaves the authored
  // fallback coefficient in place and the deck still flashes.
  Sky.prototype._strikeKey = function (ctx, flash) {
    var lg = ctx && ctx.lighting;
    var ki = (lg && isFinite(lg.keyIntensity)) ? lg.keyIntensity : NaN;
    var prev = this._flashPrevRead;
    if (isFinite(ki) && ki > 0.05 && prev > 0.12) {
      this._keyPerFlash = M.clamp(ki / prev,
        STORM_FLASH_KEY_MIN, STORM_FLASH_KEY_MAX);
    }
    var k = this._keyPerFlash * M.saturate(flash);
    return isFinite(k) ? k : 0;
  };

  // --------------------------------------------------------------------------
  // Put the ground-bounce dome over the lamps that actually exist.
  //
  // sky.js is built BEFORE the level, so this cannot happen at build time; it
  // runs from the frame loop, latches the first time the level publishes a lamp
  // survey, and costs one boolean test after that. Reads `anchors.masts` first
  // (level_harbor's own survey, documented as available immediately) and falls
  // back to `practicalLights`, which every level publishes.
  //
  // The centroid is intensity-weighted because the dome is a light, not a
  // bounding box: two quay masts at 720 and 760 candela-units pull the glow
  // seaward, which is where it belongs and which no unweighted average would
  // find. The radius is the weighted RMS spread with a floor - light spreads
  // sideways inside the deck, so the patch on the base is always broader than
  // the patch on the ground, and a lit area that measured tighter than the
  // cloud is high would produce a hard disc overhead instead of a dome.
  // --------------------------------------------------------------------------
  Sky.prototype._syncBounceCentre = function (ctx) {
    if (this._bounceSolved) return;
    try {
      var lv = ctx && ctx.level;
      if (!lv) return;
      var list = (lv.anchors && lv.anchors.masts) || lv.practicalLights;
      if (!list || !list.length) return;
      var sx = 0, sz = 0, sw = 0, i, e, p, w;
      for (i = 0; i < list.length; i++) {
        e = list[i];
        if (!e) continue;
        p = e.head || e.position || e.base || e.centre;
        if (!p || !isFinite(p.x) || !isFinite(p.z)) continue;
        w = isFinite(e.I) ? e.I : (isFinite(e.intensity) ? e.intensity : 1);
        if (!(w > 0)) w = 1;
        sx += p.x * w; sz += p.z * w; sw += w;
      }
      if (!(sw > 0)) { this._bounceSolved = true; return; }
      var cx = sx / sw, cz = sz / sw;
      var vr = 0;
      for (i = 0; i < list.length; i++) {
        e = list[i];
        if (!e) continue;
        p = e.head || e.position || e.base || e.centre;
        if (!p || !isFinite(p.x) || !isFinite(p.z)) continue;
        w = isFinite(e.I) ? e.I : (isFinite(e.intensity) ? e.intensity : 1);
        if (!(w > 0)) w = 1;
        var dx = p.x - cx, dz = p.z - cz;
        vr += (dx * dx + dz * dz) * w;
      }
      var spread = Math.sqrt(Math.max(0, vr / sw));
      var oldR = this._bounceR;
      this._bounceCtr.set(cx, cz);
      // Never tighter than the base is high, never wider than four times it.
      this._bounceR = M.clamp(spread * 2.6 + STORM_BOUNCE_H * 0.55,
        STORM_BOUNCE_H, STORM_BOUNCE_H * 4.0);
      this._bounceSolved = true;
      var u = this._skyUniforms;
      if (u && u.uStormBase) {
        u.uStormBase.value.set(this._bounceH,
          1.0 / (this._bounceR * this._bounceR),
          this._bounceCtr.x, this._bounceCtr.y);
      }
      // The IBL and every derived fill are integrated off the CPU mirror of the
      // deck, and the mirror depends on the RADIUS (the centre only moves the
      // picture, since the probe is captured from the middle of the terminal
      // either way). So the expensive half only runs when the survey actually
      // disagrees with the authored default, which on the shipped harbor it
      // barely does - and never runs more than once per level load.
      if (this._built && Math.abs(this._bounceR - oldR) > oldR * 0.05) {
        this._deriveAmbient();
        this._regenerateEnvironment();
      }
    } catch (e2) { this._bounceSolved = true; }
  };

  Sky.prototype._syncWeather = function (dt, ctx) {
    if (!(this._stormF > 0)) return;
    var w = ctx && ctx.weather;
    var t = (ctx && ctx.time) || 0;

    // ---- wind-driven deck drift --------------------------------------------
    // Integrated, not t * speed, so a wind that ramps does not teleport the
    // deck. The far layer moves at 0.38 of the near one: same wind, a longer
    // lever arm, which is exactly what makes the two read as different
    // distances rather than as one texture sampled twice.
    var wx = 0.28, wy = -0.16, ws = 9.0;
    if (w) {
      if (w.windDir && isFinite(w.windDir.x) && isFinite(w.windDir.y)) {
        wx = w.windDir.x; wy = w.windDir.y;
      }
      if (isFinite(w.windSpeed)) ws = M.clamp(w.windSpeed, 0, 45);
    }
    this._windAngle = Math.atan2(wy, wx);
    var step = M.clamp(dt, 0, 0.2) * ws * STORM_DRIFT_K;
    this._driftNear.x += wx * step;
    this._driftNear.y += wy * step;
    this._driftFar.x += wx * step * 0.38;
    this._driftFar.y += wy * step * 0.38;

    // ---- lightning ----------------------------------------------------------
    var flash = 0;
    if (w && isFinite(w.flash)) {
      flash = M.saturate(w.flash);
      if (w.flashDir && isFinite(w.flashDir.x)) {
        this._flashDir.set(w.flashDir.x, w.flashDir.y, w.flashDir.z);
        if (this._flashDir.lengthSq() < 1e-8) this._flashDir.set(0.4, 0.6, -0.7);
        this._flashDir.normalize();
        // The strike is IN the deck, so whatever convention weather.js uses for
        // its direction, the part of the sky that lights up is above the
        // horizon. Lift a downward vector rather than discarding it.
        if (this._flashDir.y < 0.10) {
          this._flashDir.y = 0.10;
          this._flashDir.normalize();
        }
      }
    } else if (!w) {
      flash = this._fallbackFlash(t);
    }
    // ---- how bright the cloud is, DERIVED from the key the scene receives ---
    // See STORM_FLASH_Q. The cloud is the emitter and the ground is lit by it,
    // so the deck's radiance is fixed by the irradiance lighting.js is actually
    // spending (E = pi * L for a uniform emitter) rather than by a constant in
    // this file that nothing keeps in step with it.
    var keyI = this._strikeKey(ctx, flash);
    var em = STORM_FLASH_Q * keyI / PI;
    if (!isFinite(em) || em < 0) em = 0;
    this._flashPrevRead = flash;
    this._wxFlash = flash;
    this._flashRGB.set(STORM_FLASH_HUE[0] * em, STORM_FLASH_HUE[1] * em,
      STORM_FLASH_HUE[2] * em);
    this._syncBounceCentre(ctx);

    // ---- fog density --------------------------------------------------------
    // Only re-derive when weather.js actually moves it; _scheduleHaze feeds the
    // caps and the published scatterRadiance, so it must not be run per frame
    // for a value that changes once a minute.
    if (w && isFinite(w.fogDensity) && w.fogDensity > 0) {
      this._wxFog = w.fogDensity;
      if (Math.abs(this._wxFog - this._wxFogApplied) > this._wxFog * 0.02) {
        this._wxFogApplied = this._wxFog;
        this._scheduleHaze();
        this._pushUniforms();
        return;                       // _pushUniforms already published the rest
      }
    }

    var u = this._skyUniforms;
    if (u && u.uStorm) {
      u.uStorm.value.w = this._windAngle;
      u.uStormDrift.value.set(this._driftNear.x, this._driftNear.y,
        this._driftFar.x, this._driftFar.y);
      u.uFlash.value.set(this._flashRGB.x, this._flashRGB.y, this._flashRGB.z,
        STORM_FLASH_TIGHT);
      u.uFlashDir.value.copy(this._flashDir);
    }
  };

  // --------------------------------------------------------------------------
  // Fallback sheet lightning, used ONLY when ctx.weather does not exist at all.
  //
  // A storm sky with no lightning in it is a grey lid, and this module has to
  // be able to stand on its own if fx/weather.js is missing or failed to build.
  // The instant a weather module publishes a `flash` field this is never
  // consulted again, so there is no risk of two systems flashing at once.
  //
  // The schedule is precomputed from a seeded RNG and then evaluated as a pure
  // function of ctx.time, so it is identical on every run of a given seed -
  // which is the whole point of the no-Math.random rule.
  // --------------------------------------------------------------------------
  Sky.prototype._fallbackFlash = function (t) {
    var s = this._fallbackStrikes;
    if (!s) {
      s = this._fallbackStrikes = [];
      var rng = (this.ctx && this.ctx.rng && this.ctx.rng.fork)
        ? this.ctx.rng.fork(0x5709) : new GAME.RNG(0x5709);
      var at = 0.35;
      for (var i = 0; i < 24; i++) {
        s.push({ t: at, dur: rng.range(0.06, 0.18), az: rng.range(0, M.TAU),
                 el: rng.range(0.18, 0.62), amp: rng.range(0.55, 1.0) });
        at += rng.range(3.0, 8.0);
      }
    }
    var out = 0;
    for (var j = 0; j < s.length; j++) {
      var e = s[j];
      var dtl = t - e.t;
      if (dtl < 0 || dtl > e.dur) continue;
      // Two sub-strokes with a gap, then a decay: a real flash flickers.
      var u = dtl / e.dur;
      var env = Math.exp(-u * 3.4) * (u < 0.34 ? 1.0 : (u < 0.46 ? 0.25 : 0.8));
      out = Math.max(out, env * e.amp);
      var ce = Math.cos(e.el);
      this._flashDir.set(Math.sin(e.az) * ce, Math.sin(e.el), -Math.cos(e.az) * ce)
        .normalize();
    }
    return M.saturate(out);
  };

  /**
   * Change aerosol load. This is the BACKGROUND Mie optical depth; the
   * near-ground dust layer scales with it (see DUST_RATIO), because a hazy
   * zenith over clean ground is not a weather condition. 0.008 = clear alpine,
   * 0.020 = the default dusty city, 0.05 = a sandstorm.
   */
  Sky.prototype.setTurbidity = function (aod) {
    try {
      setTurbidity(M.clamp(aod, 0.004, 0.25));
      buildTransmittanceTable();
      if (this._built) {
        this._buildLut();
        this._pushUniforms();
        this._regenerateEnvironment();
      }
    } catch (e) { GAME.logError('sky.setTurbidity', e); }
  };

  /** Bulk-set fog parameters, e.g. sky.setFog({ density: 0.02 }). */
  Sky.prototype.setFog = function (opts) {
    if (!opts) return;
    for (var k in opts) if (k in this.fog) this.fog[k] = opts[k];
    this._pushUniforms();
  };

  /**
   * Point the dust field's occlusion test at lighting.js's key cascade.
   *
   * Cascade 0 covers the near field, which is exactly and only where motes are
   * drawn (they fade out entirely by 11 m), so one map is enough - there is no
   * point walking the cascade list the way postfx's volumetric pass has to.
   *
   * Called every frame from update(); it costs a reference copy and a Matrix4
   * copy. Entirely defensive: lighting.js owns those maps, they do not exist
   * until it has rendered at least once, and anything missing simply leaves the
   * field unoccluded rather than throwing out of the frame loop.
   *
   * @param {Object} lighting GAME.Lighting, or anything exposing .cascades
   */
  Sky.prototype.bindKeyShadow = function (lighting) {
    var du = this._dustUniforms;
    if (!du) return false;
    var p = du.uShadowP.value;
    try {
      var cs = lighting && lighting.cascades;
      var lt = (cs && cs.length) ? cs[0] && cs[0].light : null;
      var sh = lt && lt.shadow;
      if (lt && lt.castShadow !== false && lt.visible !== false &&
          sh && sh.map && sh.map.texture && sh.matrix) {
        du.uShadowMap.value = sh.map.texture;
        du.uShadowMat.value.copy(sh.matrix);
        p.x = 1.0;
        return true;
      }
    } catch (e) { /* fall through to disabled */ }
    du.uShadowMap.value = null;
    p.x = 0.0;
    return false;
  };

  Sky.prototype.update = function (dt, ctx) {
    ctx = ctx || this.ctx;
    try {
      var cam = ctx && ctx.camera;
      var t = (ctx && ctx.time) || 0;
      // The dome is a unit sphere around the eye; keeping it locked to the
      // camera is what lets it be tiny and still act as an infinite backdrop.
      if (this.mesh && cam) this.mesh.position.copy(cam.position);
      if (this._skyUniforms) {
        this._skyUniforms.uN.value.w = t;
        // Cloud drift. Slow enough that a 3 s capture is effectively frozen
        // (and therefore reproducible) but a minute of play visibly moves it.
        if (this._skyUniforms.uCloud) this._skyUniforms.uCloud.value.w = t * 0.0035;
      }

      // Storm deck: wind drift, in-cloud lightning, weather-driven fog. Returns
      // immediately when _stormF is 0, so level 1 pays one comparison a frame.
      this._syncWeather(dt, ctx);

      var du = this._dustUniforms;
      if (du && cam) {
        du.uCamPos.value.copy(cam.position);
        du.uT.value.x = t;
        // gl_PointSize is in pixels: worldSize * (h/2) / (tan(fov/2) * dist).
        // projectionMatrix[5] is exactly 1/tan(fov/2), so this tracks ADS zoom
        // and any resize for free.
        var h = 1080;
        if (ctx.renderer && ctx.renderer.getDrawingBufferSize) {
          h = ctx.renderer.getDrawingBufferSize(this._dbSize || (this._dbSize = new THREE.Vector2())).y || h;
        } else if (ctx.height) { h = ctx.height; }
        var p5 = cam.projectionMatrix && cam.projectionMatrix.elements[5];
        du.uT.value.y = 0.5 * h * (p5 || 1.4);
      }
      if (this.dustParticles) {
        // Dust is a luxury: the first thing to drop when quality is low.
        // It is also a DRY-AIR phenomenon lit by a shaft of sun. In a downpour
        // there is no shaft, the motes would be scattering a key that is not
        // there, and weather.js owns everything visible in that air anyway - so
        // the field switches off entirely rather than laying an unmotivated
        // additive haze over a level built on pools of light and darkness.
        this.dustParticles.visible =
          !(ctx && ctx.quality && ctx.quality.particles === 0) &&
          !(this._stormF > 0.35);
        // Nobody else knows this hook exists, so drive it here rather than
        // waiting for a caller that will never come.
        if (this.dustParticles.visible) this.bindKeyShadow(ctx && ctx.lighting);
      }
    } catch (e) {
      GAME.logError('sky.update', e);
    }
  };

  Sky.prototype.resize = function (w, h, ctx) {
    // Point size is recomputed every frame in update(); nothing to do here,
    // but the hook exists so main.js's resize sweep never sees an odd shape.
    this._resizeW = w; this._resizeH = h;
  };

  Sky.prototype.dispose = function () {
    try {
      if (this._lutA) this._lutA.dispose();
      if (this._lutB) this._lutB.dispose();
      if (this._lutC) this._lutC.dispose();
      if (this._skyMaterial) this._skyMaterial.dispose();
      if (this._dustMaterial) this._dustMaterial.dispose();
      if (this.mesh && this.mesh.geometry) this.mesh.geometry.dispose();
      if (this.dustParticles && this.dustParticles.geometry) this.dustParticles.geometry.dispose();
      if (this._stormTex) this._stormTex.dispose();
      if (this._cubeRT) this._cubeRT.dispose();
      if (this._pmremRT) this._pmremRT.dispose();
      if (this._pmrem) this._pmrem.dispose();
    } catch (e) { GAME.logError('sky.dispose', e); }
  };

  GAME.Sky = Sky;

})(window.GAME, window.THREE);
