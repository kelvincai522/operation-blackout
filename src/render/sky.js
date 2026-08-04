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
//   * sky.setWeather(preset) - the atmospheric condition. FOUR distinct skies:
//                       'clear'    the default and every prior behaviour of
//                                  this module, unchanged. market, highrise,
//                                  boneyard, refinery and ruins, at five
//                                  different times of day.
//                       'storm'    LEVEL 2's night nimbostratus deck, lit from
//                                  below by sodium. See the STORM WEATHER
//                                  section. Unchanged.
//                       'overcast' a full DAYLIGHT deck, lit from above, whose
//                                  level, hue and picture compression all track
//                                  the ground albedo - so one preset gives
//                                  snowbound a whiteout and jungle a humid
//                                  haze. 'drizzle' is the same deck, thinner.
//                                  See the DAYLIGHT OVERCAST section.
//                       'none'     NO SKY. metro and bunker are sealed; the
//                                  dome leaves the scene, the sun and moon are
//                                  switched off, and all that remains is a very
//                                  dim neutral IBL so their metals and standing
//                                  water have something to reflect.
//                     Level 1 resolves to 'clear' and never reaches a line of
//                     any of the others.
//   * sky.setGroundAlbedo(v) - what the level is standing on. Feeds the LUT's
//                     ground-bounce integral, the fog's downward inscatter and
//                     the overcast deck's whole energy budget. Defaults to the
//                     market's sand, so the default path cannot move.
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

  // ==========================================================================
  // TWILIGHT ZENITH  (opt-in; see setTwilight)
  //
  // EVERYTHING IN THIS BLOCK IS INERT UNTIL _twiF IS NON-ZERO, which only
  // setTwilight() or a level whose declarative profile asks for it can do.
  // market and harbor carry no env profile and never call it, so their dusk and
  // night skies execute the identical arithmetic they always have - the
  // afterglow branch keeps its original literal expression in an else.
  //
  // WHY THE MODEL CANNOT PRODUCE A BLUE ZENITH AT A HORIZON SUN, and why this
  // is a missing layer rather than a tuning error.
  //
  //   The dome is SINGLE scattering: radiance = integral of T_view * T_sun *
  //   beta * density. With the disc on the horizon, T_sun along the SOLAR path
  //   is a horizon slant column - measured on this model at t = 0.22, the
  //   Rayleigh optical depth to the sun is 2.6 in the red and 14.9 in the blue
  //   at sea level. Blue is therefore extinguished exactly where the density
  //   that would scatter it lives, and the only air still receiving blue light
  //   is 20-35 km up, where the density is 2-5% of sea level. Integrated end to
  //   end the zenith comes out at (0.0153, 0.0154, 0.0106) - R = G, B DOWN 30%.
  //   That is not a bug in the integral, it is what one bounce gives you.
  //
  //   A real twilight zenith is blue because of the terms this model does not
  //   have: second- and third-order scattering (the sky above the terminator is
  //   lit almost entirely by light that has already bounced, and each bounce
  //   re-weights toward Rayleigh's 1/lambda^4) and Chappuis ozone absorption,
  //   which removes 550-650 nm from a long twilight path and is the textbook
  //   reason the twilight zenith is blue rather than grey. MS_FACTOR is a flat
  //   0.32 of the single-scattering result, so it inherits the reddening
  //   instead of correcting it, and RAY_CHROMA makes it WORSE here: it is a
  //   luminance-preserving expansion about the Rayleigh integral's own mean, so
  //   on a spectrum where B is BELOW that mean it pushes B further down. It is
  //   right by day (B is the largest channel then) and inverted at twilight.
  //
  // So the blue is AUTHORED - but as a luminance-preserving CHROMATICITY
  // ROTATION of the finished column rather than as an added layer, and that
  // distinction is the whole design. THE DOME IS ALSO A LIGHT: 64% of the
  // cosine-weighted sky irradiance arrives from above 37 degrees. The first
  // version of this crossfaded the upper dome out and faded an authored blue in,
  // which is the obvious implementation and measured a third of the level's
  // skylight gone and the whole frame printing 16% down - a dawn mist lit by a
  // sky that had been deleted. A rotation moves hue at exactly constant
  // luminance, so keyRef, the IBL, the hemisphere fill and every fog cap are
  // untouched, and ONE separate factor owns the gradient.
  //
  // Two weights, and the AZIMUTHAL one is what confines the warm band:
  //
  //   TWI_LO/HI    elevation. Full rotation above ~37 degrees, so the blue
  //                "holds above roughly 40 degrees" as the finding asks.
  //   TWI_AZ_P     azimuth. cos^14 is spent about 25 degrees off the sun, so the
  //                burning band keeps its FULL authored level in the sun's own
  //                quadrant and every other bearing rotates to the twilight blue
  //                at the same luminance it already had. Cutting the afterglow's
  //                azimuthal floor instead (the other obvious implementation)
  //                cost the anti-sun horizon 60% of its value, which on the
  //                quietest level in the roster is its entire atmosphere.
  //
  // TWI_ZENITH is therefore a CHROMATICITY, normalised to luminance 1 before use;
  // only its ratios matter. It is CALIBRATED against the print rather than
  // authored, because the whole point of the finding is a measured printed
  // chromaticity. Two captures of Bayon's lv_overview fix the scene-to-print
  // response of the zenith column at
  //     print R/G = 1.480 * (scene R/G)^1.123
  //     print B/G = 1.362 * (scene B/G)^0.275
  // - i.e. the transfer applies a fixed rotation toward red AND compresses the
  // blue axis by a factor of nearly four in the exponent, which is why the
  // shipped dome could sit at scene R = G and still print R 50% over G. Solving
  // those for print G/R = 1.39 and B/G = 1.45 gives scene (0.53, 1.00, 1.26),
  // i.e. the triple below. Authoring the physically measured twilight zenith
  // instead - (0.055, 0.085, 0.145), which the finding quotes - would print at
  // G/R 1.13 and miss.
  // ==========================================================================
  var TWI_ZENITH = [0.235, 0.600, 1.040];
  // Elevation window, in sin(view elevation): ~3.5 degrees to ~37 degrees.
  var TWI_LO = 0.06, TWI_HI = 0.60;
  // How much of the full rotation the LOW sky gets on bearings away from the
  // sun, and this one is capped by an OBJECTIVE metric rather than by taste.
  //
  // At 0.85 the frame-wide B-R went from -0.102 to +0.008: the level stopped
  // being a dawn at all, and the roster pins Bayon to "grey-gold / moss". Worse,
  // at 0.62 the brightest sky band - the low anti-sun sky, which is what
  // analyze.py's highlight tint actually samples on a wide framing - rotated from
  // (0.233, 0.110, 0.075) to near-neutral and the overview's grade_split INVERTED
  // (+0.1775 to -0.0213), i.e. the "no meaningful colour grade" red flag, on a
  // level whose whole palette claim is warm stone against cool air.
  //
  // 0.40 is the measured ceiling: the upper dome (twEl = 1, where this factor
  // does not apply at all) still rotates fully to the twilight blue, so the
  // zenith inversion the finding is about is fixed either way - what this
  // protects is the warm band that has to stay the frame's highlight.
  var TWI_AWAY = 0.40;
  // Azimuthal tightness of the warm band. See above.
  var TWI_AZ_P = 14.0;
  // Zenith luminance CUT at full weight - the gradient the finding asks for
  // (the shipped dawn dome ran a total swing of 13% across the whole visible
  // sky, which is a flat card with a hue on it).
  //
  // ENERGY-NORMALISED, which is what makes a number this large affordable: the
  // cosine-weighted mean of the dim factor is divided back out, so the dome
  // REDISTRIBUTES its irradiance downward instead of losing it. That is also the
  // physically honest shape - a twilight sky really is brightest near the horizon
  // and the darkest part of it really is overhead - and it means the zenith can
  // be cut by more than half without the level's skylight, keyRef, the fog caps
  // or the exposure moving at all.
  //
  // TWI_NORM is how much of that redistribution is actually paid back. At 1.0 the
  // low sky came out 1.72x its authored level and PRINTED at saturation 0.029,
  // i.e. the golden band was pushed so far up the AgX shoulder that it went
  // neutral - the cure eating the patient. 0.65 keeps most of the energy and
  // leaves the band its colour.
  //
  // Measured, the print exponent on the sky column is only 0.32 (it sits high on
  // the shoulder), so a printed 1.8:1 would need a 4x radiance spread; 0.62 lands
  // about 1.65:1 in display-linear against the shipped 1.22:1. See the report.
  var TWI_DIM = 0.62;
  var TWI_NORM = 0.65;
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

  // ==========================================================================
  // DAYLIGHT OVERCAST  ('overcast', 'drizzle')  and  ENCLOSED  ('none')
  //
  // EVERYTHING IN THIS SECTION IS INERT UNTIL _overcastF IS NON-ZERO, which
  // only setWeather('overcast'|'drizzle'|'none') or a levelDef declaring one
  // can do. market and harbor never reach a line of it: market resolves to
  // 'clear' and harbor to 'storm', and every added branch tests _overcastF
  // first and falls through to the untouched path when it is zero.
  //
  // WHY THIS IS NOT "THE STORM DECK, BRIGHTER"
  //
  //   The storm deck above is a NIGHT sky. Every one of its radiances is an
  //   absolute in the 0.006-0.05 band, it is lit almost entirely FROM BELOW by
  //   the terminal's sodium, and its brightness runs on THICKNESS because the
  //   only light entering it comes off the ground. Scaling that up does not
  //   produce an overcast day; it produces a night sky with the gain turned up,
  //   which is a flat grey card - the exact instant-fail this file exists to
  //   avoid.
  //
  //   A daylight overcast is the opposite object in three separate ways:
  //
  //   1. IT IS LIT FROM ABOVE. Thin cloud is BRIGHT (sunlight leaks through
  //      it), thick cloud is the darker blue-grey mass beside it. That is the
  //      same stTrans field the storm uses, read with the opposite sign, which
  //      is why the two decks can share one noise texture and one projection
  //      and still look nothing like each other.
  //   2. ITS LEVEL IS SET BY THE GROUND, NOT BY A CONSTANT. The deck, the snow
  //      under it and the haze between them are all the same photons; author
  //      any one of them independently of the other two and you get either a
  //      blown white lid over a grey field or a grey lid over a blown field.
  //      So the whole thing is derived from ONE number - the irradiance the
  //      deck delivers - and everything else is a ratio to it. See
  //      _overcastEnergy.
  //   3. GROUND ALBEDO IS A FIRST-ORDER TERM. Snow at 0.87 under a cloud base
  //      of reflectance 0.58 is a resonator: 1/(1 - 0.87*0.58) = 1.99, i.e. a
  //      snowfield very nearly DOUBLES the light under the same cloud, and the
  //      extra arrives from below and from the base overhead rather than from
  //      the sun. That single term is the difference between "a grey day with
  //      white paint on the floor" and a whiteout. Desert hardstanding (0.32)
  //      buys 1.23 of the same effect and it arrives warm.
  //
  // THE SUN IS A REGION, NOT A DISC. clearAmt is zeroed by the deck exactly as
  // it is under storm, so no disc, no moon, no stars survive. What replaces it
  // is a broad forward-scattering lobe about the solar direction that is
  // brightest where the deck is THINNEST - so it drifts with the cloud instead
  // of being a painted gradient, and it disappears entirely in a whiteout where
  // the deck never thins.
  //
  // THE PICTURE / LIGHT SPLIT is the same one DAY_GAIN describes, and for the
  // same reason - except that here the compression has to be referenced to the
  // GROUND ALBEDO rather than to a fixed gain. Measured on the model: under a
  // deck delivering irradiance E, a surface of albedo a has radiance a*E/pi and
  // the sky has E/pi, so the sky-to-ground ratio is 1/a. Over snow that is 1.15
  // and the sky needs no compression at all; over wet jungle floor it is 10 and
  // an uncompressed sky clips to white between every leaf. One shoulder, whose
  // asymptote is a multiple of a*E/pi, gets both right - and _regenerateEnvironment
  // switches it off while it captures the probe, so the LIGHT is never touched.
  // ==========================================================================

  // Fraction of the clear-sky reference irradiance a full deck still delivers.
  //
  // NOT the physical 0.15-0.25 of clear global, and the reason is worth stating
  // because it is the same trap DAY_GAIN documents. AN OVERCAST DAY IS A DAY.
  // In real illuminance an overcast noon (15-25 klux) is comparable to, and
  // often brighter than, the clear GOLDEN HOUR (10-20 klux) this engine is
  // calibrated on - the two-stop figure everyone remembers is overcast against
  // clear NOON, which is not a condition anything in this roster is in. Author
  // it at the physical fraction of a low-sun reference and snowbound - which
  // ART_DIRECTION calls the brightest scene in the roster - prints a stop and a
  // half under the market. 0.62 lands it slightly OVER the market's own global
  // horizontal, which is where a snowfield under a bright deck belongs.
  var OVER_TRANSMIT = 0.62;
  // How much more a THIN deck ('drizzle') passes, per unit of thinness.
  var OVER_THIN_GAIN = 0.55;
  // Effective solar elevation floor for the deck's budget, as sin(elevation).
  // A deck is a DIFFUSER: what leaves its underside is scattered out of the
  // whole slab, so the downwelling is far less sensitive to where the sun is
  // than a direct beam's cosine law makes it. Without this floor the model
  // inherits the beam's cosine twice - once in the clear reference and once in
  // the fact that a low sun is also a long, dim slant path - and snowbound (11
  // degrees, turbidity 0.09) comes out darker than harbor at 02:00.
  var OVER_SUN_Y_FLOOR = 0.38;
  // Reflectance of the cloud base, for the ground <-> base multiple bounce.
  // Capped so a hypothetical albedo-1 ground cannot make the series diverge.
  var OVER_CLOUD_R = 0.58;
  var OVER_BOUNCE_MAX = 0.72;
  // Floor on the clear-sky reference. A deck under a sun three degrees up is
  // still a sky; without this the whole model would collapse to black at dawn.
  var OVER_MIN_E = 0.34;

  // ---- deck shape (all RELATIVE; the level is set by _overcastEnergy) -------
  // Radiance multiplier where the cloud is thickest, and the extra where it is
  // thinnest. Deliberately a much NARROWER spread than the storm's 0.18/0.98:
  // an overcast is an even ceiling whose interest is in hue and relief, and a
  // 6x luminance spread reads as broken cumulus however grey you make it.
  // 0.66..1.28 is a factor of 1.94 - enough that the masses read, little enough
  // that it stays a ceiling.
  var OVER_DECK_MIN = 0.66;
  var OVER_DECK_RANGE = 0.62;
  // Horizon radiance as a fraction of the zenith. A real overcast is brightest
  // overhead (shortest path up through the deck) and falls toward the skyline.
  //
  // 0.56 over an e-folding of 1.9, not 0.66 over the storm deck's 3.2, and the
  // EXPONENT is the half that was actually wrong. exp(-sin(elev)*3.2) is spent
  // by twenty degrees: measured on the model, the whole band a ground-level
  // camera sees (0-30 deg) ran 0.93x the zenith down to 0.66x, and after the
  // picture shoulder and AgX that 1.41x radiance range printed as a 1.5% spread
  // - the featureless plate the snowbound critic measured (std 0.0118 on a mean
  // of 0.78). At 1.9 the same band runs 0.83x down to 0.56x, i.e. the ramp is
  // spread through the part of the dome that is actually in frame instead of
  // being crushed into the last few degrees over the rooftops.
  //
  // The void ('none') profile keeps the storm deck's 3.2 and VOID_HORIZON_K -
  // metro and bunker never see the sky at all and asked for none of this.
  var OVER_HORIZON_K = 0.56;
  var OVER_HORIZON_P = 1.9;
  // ---- large-scale cloud-base breakup (the squall field) -------------------
  //
  // A real snow squall deck is not uniform: it has ragged darker cells the size
  // of a whole quadrant of sky, and they drift. The three noise layers the deck
  // already carries (stA/stB/stC) are all sampled at frequencies that MIP OUT
  // to their mean exactly where the projection compresses - which is the entire
  // lower half of a ground-level framing - so none of them can supply it.
  //
  // This one rides the same low-frequency pair the storm's weather-system term
  // uses (the FAR projection at 0.28, plus a second NEAR sample at 0.17 on a
  // slower drift so the two slide over each other and the field EVOLVES rather
  // than translating rigidly). About two thirds of a tile crosses the whole
  // visible sky, so it survives the horizon compression intact.
  //
  // Written as (1-k) + k*2*field, exactly as OVER_BAND and OVER_CELL are, so
  // its mean is 1.0 by construction against a noise channel whose mean is 0.5.
  // That is what lets it buy structure at ZERO cost to the deck's level, the
  // frame mean, the vertical balance or the numeric solve in
  // _applyOvercastAmbient - the CPU mirror does not need to know it exists.
  //
  // SCALE FIRST, AMPLITUDE SECOND, and both were measured rather than chosen.
  //
  //   Scale. The two samples land 1.8-3.5 and 1.6-3.8 noise cells across the
  //   sky a hero framing sees. The first attempt reused the storm's own
  //   weather-system projection (stFar * 0.28) on the reasoning that "lower
  //   frequency survives the horizon compression" - and it does, but at 0.28
  //   the ENTIRE visible sky samples 0.6 of one cell, i.e. a constant. That is
  //   the same mistake CLOUD_SCALE and the storm deck's 0.80 each cost a round
  //   already: at these projections the interesting band is narrow, and either
  //   side of it is a flat card.
  //
  //   Amplitude. 0.42 gives 0.58x..1.42x, a 2.4x spread at the largest spatial
  //   scale in the deck. That looks enormous written down and is not, because
  //   of what the print does to it: measured end to end on snowbound, an 11%
  //   change in deck radiance moved the printed sky by 1.2%. AgX plus an
  //   auto-exposure metering a whiteout is a ~9:1 compressor up here, which is
  //   exactly why every previous attempt to give this preset structure
  //   disappeared. A real snow squall does vary 2:1 across the sky; this is the
  //   authored amount that survives to the frame.
  //
  // ...and this is why the field is ALSO carried in HUE, which is the half that
  // actually does the work. Probed by painting the deck magenta and
  // re-capturing: the dome unambiguously owns the sky pixels (they went fully
  // magenta) and the squall's shape was plainly legible IN THE CHROMA at the
  // same amplitude whose luminance printed as 1%. Up at the level a whiteout
  // meters to, AgX has almost no contrast left but plenty of colour, so a
  // squall cell that is a colder blue-grey than the deck around it reads where
  // a 2.4x luminance spread does not. That is the same conclusion the storm
  // deck's stTint reached from the opposite end - "a deck that varies only in
  // brightness is a gradient, one that varies in colour is cloud" - arrived at
  // here by measurement rather than by analogy.
  //
  // The two endpoints are each normalised to luminance 1.0, so the tint is a
  // pure chromaticity rotation about the field's mean and costs the deck's
  // level, the meter and the numeric solve exactly nothing.
  var OVER_SQUALL = 0.42;
  var OVER_SQUALL_TINT = 0.55;
  var OVER_SQ_COOL = [0.9364, 1.0042, 1.1449];
  var OVER_SQ_WARM = [1.0600, 0.9957, 0.8622];
  // ---- turbidity-driven horizon band ---------------------------------------
  //
  // The deck REPLACES the dome above about a degree of elevation (stCov is 1
  // everywhere the coverage threshold is below the noise floor, which under a
  // total overcast it always is), so the clear-sky haze band never reaches it.
  // A dense whiteout needs the last twenty degrees over the skyline to converge
  // on the same air the far field is dissolving into, or the deck prints as a
  // card sitting on top of the fog with a value step where they meet.
  //
  // Driven by TURBIDITY, so one expression gives snowbound (0.09) a band
  // reaching about 25 degrees at 0.58 strength and jungle (0.07) a shallower,
  // weaker one - which is the difference between a blizzard and humid air.
  //
  // Deliberately NOT mirrored in _overcastShape. It is confined to the bottom
  // ~15 degrees, which carry sin^2(15 deg) = 6.7% of the cosine-weighted
  // irradiance, and it moves them by at most 15% - under 1% on E, i.e. below
  // the resolution of the numeric solve that sets the deck's level. Adding it
  // to the mirror would make the mirror depend on fog colours that are computed
  // AFTER the level is solved, which is a loop, not an improvement.
  var OVER_TURB_LO = 0.020, OVER_TURB_SPAN = 0.080;
  var OVER_BAND_K_LO = 0.30, OVER_BAND_K_HI = 0.62;
  var OVER_BAND_FALL_LO = 9.0, OVER_BAND_FALL_HI = 5.0;
  // Two independent mean-1 structure fields. Both average to exactly 1.0 by
  // construction (the noise channels average 0.5), so they buy internal
  // structure at zero cost to the deck's level, the frame mean or the meter -
  // which is the only way to add depth to something that must stay even.
  var OVER_BAND = 0.22;            // mid-frequency rolls and rifts
  var OVER_CELL = 0.18;            // sagging cells of the base
  // Ground bounce onto the cloud base, as a fraction of the zenith radiance PER
  // UNIT of ground albedo. This is the term that makes snow a whiteout: at
  // albedo 0.87 it contributes 0.37 of the zenith back onto the base, arriving
  // from BELOW and therefore flattening the whole dome; at 0.10 (wet jungle
  // floor) it contributes 0.04 and the deck stays top-lit, which is what leaves
  // room for canopy shafts.
  var OVER_BOUNCE_K = 0.42;
  // The sun as a diffuse region. Lobe exponent (higher = tighter) and peak
  // radiance as a fraction of the zenith. A thin deck gives a tighter, brighter
  // region; a thick one a broad barely-there brightening.
  var OVER_SUN_P = 6.0, OVER_SUN_P_THIN = 11.0;
  var OVER_SUN_REL = 0.55, OVER_SUN_REL_THIN = 0.94;
  // Coverage THRESHOLD on the deck fbm. Far lower than the storm's 0.06: this
  // is a TOTAL deck. Any hole at all would show the clear atmosphere behind it,
  // and at snowbound's turbidity 0.09 that atmosphere is an ochre horizon band -
  // i.e. a hole in a blizzard would print as a patch of desert.
  var OVER_COVER = -0.40;
  var OVER_DETAIL = 0.55;
  // ---- the picture shoulder (see the header) -------------------------------
  //
  // The asymptote is a multiple of the DECK'S OWN MEAN, modulated by the ground
  // albedo - not a multiple of the ground radiance, which is the version that
  // was tried first and measured: over the market's 0.24-albedo sand it put the
  // asymptote at 0.37x the deck's mean, so the whole deck sat four times over a
  // knee whose remaining span was 0.06, and a 1.9x luminance spread printed as
  // a 3.7% one. A flat card - the exact failure this preset exists to avoid,
  // arrived at by the term that was supposed to prevent the opposite one.
  //
  // A shoulder can only preserve structure if it sits ABOVE what it is
  // compressing. So the mean is the reference, and the albedo decides how much
  // headroom there is over it: over snow (which is nearly as bright as the sky)
  // almost none is needed and the deck passes through untouched, over a dark
  // jungle floor the deck is compressed AND pre-scaled down, because there the
  // sky really is ten times the ground and something has to give.
  var OVER_PIC_SHOULDER_LO = 1.25; // asymptote, x deck mean, at a black ground
  var OVER_PIC_SHOULDER_HI = 2.40; // ...and at a white one
  var OVER_PIC_GAIN_LO = 0.72;     // pre-gain at a black ground (1.0 at a white one)
  var OVER_PIC_KNEE = 0.42;        // knee as a fraction of the asymptote
  // Ground albedo remapped to 0..1 across the useful range, and a floor for the
  // fog levels - without which a 0.10-albedo jungle floor would ask for a haze
  // half as bright as the foliage it is supposed to be veiling.
  var OVER_ALBEDO_LO = 0.10, OVER_ALBEDO_SPAN = 0.70;
  var OVER_ALBEDO_FLOOR = 0.22;
  // ---- what the key light does ---------------------------------------------
  // How much of the clear-sky key survives the deck.
  //
  // 0.55 rather than the 0.20 the physics of a thick nimbostratus would ask
  // for, and this is a measured cross-module constraint rather than a taste
  // call. postfx sets its ABSOLUTE print level from sky.sunIntensity
  // (todBias = floor + (1-floor) * saturate(sunI / 3)) precisely so that dusk
  // is low-key and night is dark. An overcast noon is neither, but a key cut to
  // a fifth is indistinguishable from twilight through that expression, and the
  // whole level prints half a stop down - measured on the market under
  // weather=overcast: todBias fell from 1.00 to 0.57.
  //
  // The overcast READ does not come from a dim key anyway, it comes from the
  // RATIO: at 0.55 the direct term is about 17% of the global under a deck
  // delivering OVER_TRANSMIT, i.e. the shadows are one soft stop deep instead
  // of four hard ones. That is what an overcast looks like, and it leaves
  // lighting.js a key with enough energy to still give form to a face.
  var OVER_KEY_K = 0.55, OVER_KEY_K_THIN = 0.72;
  var OVER_MOON_K = 0.30;
  // Horizon haze blend on the visible dome. Raised hard from the clear-sky
  // 0.12 because this is the one preset where the sky and the far field SHOULD
  // converge: it ties the last degree or two above the skyline to the haze
  // colour so the narrow window where the deck fades out (see stCov) cannot
  // reveal a strip of clear atmosphere under a total overcast.
  var OVER_HAZE_MIX = 0.55;
  var OVER_HAZE_GAIN = 2.2;
  var OVER_HAZE_ALBEDO = 0.90;     // water droplets / ice crystals
  // Inscatter luminance, as a multiple of (effective albedo x deck mean). Over
  // snow this lands the haze within a few per cent of the snow itself, so
  // distance dissolves geometry into white with no value step at all - the
  // whiteout the brief asks for. Over dark jungle floor the same expressions
  // land it at ~2.3x the foliage: mist between trunks, not a white wall.
  var OVER_FOG_K = 1.05;
  var OVER_FOG_SUN_K = 1.20;
  var OVER_FOG_GND_K = 1.00;       // x TRUE ground albedo, not the floored one
  // How far the haze blends toward the ground's own hue. Snow tints it cool,
  // a jungle floor tints it green - which is most of what stops two levels
  // sharing a preset from sharing a look.
  var OVER_FOG_GND_MIX = 0.34;
  var OVER_FOG_DENS_K = 2.2;       // x the AUTHORED base density, so setFog works
  // The deck's own chromaticity, before the sixth-of-the-way blend toward the
  // ground below. Pushed a little further COOL than the 0.965/0.985/1.000 it
  // shipped at: every level that runs this preset is a white or a green one,
  // and the snowbound brief asks for white/pale-blue. It measured slightly WARM
  // of neutral (R 0.784 against G/B 0.779) because the diffuse solar region -
  // not the deck - was carrying a low sun's transmittance almost undiluted; see
  // _applyOvercastAmbient for the other half of that fix.
  var OVER_HUE = [0.950, 0.978, 1.000];

  // ---- THE WHITEOUT GATE ---------------------------------------------------
  //
  // Three separate corrections below all want the same question answered - "is
  // the ground under this deck bright enough that the level IS the air?" - so
  // they share one weight rather than three thresholds that could drift apart.
  // Snow (luminous albedo 0.887) lands 1.0; a wet jungle floor (0.107) lands
  // EXACTLY 0.0, so every expression gated on it is skipped outright and the
  // second level sharing this preset is bit-identical.
  //
  // 0.35 is not arbitrary: below it the ground <-> cloud-base resonator
  // (1/(1 - a*0.58)) is under 1.25, i.e. the deck is still top-lit and the far
  // field still has a value step to dissolve across. Above it the ground is
  // returning half the light again and the sky, the ground and the air between
  // them converge on one value, which is the definition of a whiteout.
  var OVER_WHITE_LO = 0.35, OVER_WHITE_SPAN = 0.45;
  // Chroma expansion on the deck's chromaticity, at full whiteout. The same
  // argument RAY_CHROMA documents, measured on this preset: the deck was
  // authored at B/R = 1.06 and PRINTED at B-R = +0.005 with a dome saturation of
  // 0.006-0.012, because AgX over an auto-exposure metering a whiteout is a ~9:1
  // chroma compressor up at that level. The brief asks for "white / pale blue"
  // and the level's own snow is blue by authored vertex colour, so a dead
  // neutral sky reads as blue paint on the floor under a grey lid. Applied
  // LUMINANCE-PRESERVING about the deck's own luminance, so it cannot move the
  // deck's level, the numeric solve in _applyOvercastAmbient, the frame mean or
  // the meter - it is a pure chromaticity rotation, exactly as OVER_SQ_COOL is.
  var OVER_CHROMA = 3.4;
  // Aerial-perspective convergence. At full whiteout the inscatter stops being
  // "a fraction of the ground albedo" and becomes "the value the sky dome
  // actually resolves to", so geometry at infinite distance converges ON the sky
  // instead of settling below it.
  //
  // MEASURED, and the factor is the honest part. The CPU mirror
  // (_overcastShape) evaluates the deck with every noise channel at its MEAN and
  // the solar lobe at its spherical mean 1/(p+1); the shader evaluates the real
  // lobe, which over the sun's half of the sky runs 3-6x that. So the deck the
  // player sees is brighter than the deck the mirror integrates, and the
  // difference is the whole 0.066 luminance ledge the finding measured (far
  // pines 0.676 against a sky at 0.742). 1.34 x the mirror's displayed mean is
  // the value that closes it; it is a correction for a known approximation, not
  // a fudge, and it is only ever reached at full whiteout.
  var OVER_CONV_K = 1.34;
  // ...and the other half of "fully veiled". A 0.93 opacity cap leaves 7% of a
  // near-black conifer showing however thick the air gets, which is a 7% step
  // that no distance closes. A silhouette cap is right for a street (see
  // this.fog.maxOpacity) and wrong for a blizzard, where the brief explicitly
  // asks for distant geometry to dissolve into white.
  var OVER_FOG_MAX_OPACITY_HI = 0.985;
  // How far the SUNWARD inscatter lobe is pulled toward the solar region's own
  // (warm) chromaticity, at full whiteout. gbFogSun and gbFogSky exist so the air
  // has a warm side and a cool side; under this preset they were being handed the
  // same triple, so the medium was one hue and the frame had no warm/cool axis at
  // all - measured on snowbound's hero framing as a shadow tint and a highlight
  // tint identical to three decimals, i.e. grade_split sitting on zero.
  // A FRACTION of the way from the deck's chromaticity to the solar region's, not
  // a replacement: measured, replacing it took the sunward lobe from B/R 1.61 to
  // 1.03 and cost the frame a third of its saturation, a tenth of its dynamic
  // range and a fifth of its edge energy, because a neutral haze prints brighter
  // and flatter through AgX than a blue one of the same radiance. At 0.45 that
  // lobe lands at B/R 1.42 - still unmistakably the same cold air, warm enough
  // relative to the anti-sun side to give the grade an axis.
  var OVER_FOG_SUN_MIX = 0.45;

  // Rain/snow fills the whole column rather than hugging the ground, scatters
  // near-isotropically (there is no disc to forward-scatter from) and eats
  // chroma at distance far harder than dry air.
  var OVER_FOG = {
    heightScale: 34.0,
    maxOpacity: 0.93,
    mieG: 0.30,
    startDistance: 1.4,
    desaturate: 0.30
  };

  // ---- 'none': fully enclosed levels (metro, bunker) -----------------------
  //
  // There is no sky. The dome is removed from the scene and the sun and moon
  // are switched off outright - every photon in those levels comes from
  // lighting.js's practicals.
  //
  // But the environment must NOT be null, and this is the whole reason the
  // preset exists rather than just skipping the module: scene.environment is
  // what every metal, every wet tile and every pool of standing water gets
  // nearly all of its visible value from. An enclosed level with no probe
  // renders its steel as black holes and its water as flat matte paint, which
  // reads as a rendering bug rather than as darkness. So the deck machinery
  // still runs, at a very dim, very flat, strictly neutral level: enough for a
  // rail head to catch something and for a wet platform to have a gradient in
  // it, far too little to light anything.
  //
  // 0.020 of irradiance is about 1.3% of the market's global horizontal, i.e.
  // 6.3 stops down - present in a reflection, invisible as illumination.
  var VOID_E = 0.020;
  var VOID_HORIZON_K = 0.55;
  var VOID_HUE = [0.940, 0.970, 1.000];
  var VOID_FOG_K = 0.55;
  var VOID_FOG_DENS_K = 1.15;
  var VOID_HAZE_GAIN = 2.6;
  var VOID_HAZE_ALBEDO = 0.82;
  // Interiors are not height-stratified: a corridor's air is the same all the
  // way to the ceiling, so the height term is pushed effectively flat.
  var VOID_FOG = {
    heightScale: 48.0,
    maxOpacity: 0.82,
    mieG: 0.24,
    startDistance: 1.2,
    desaturate: 0.34
  };

  // ---- ground albedo, per level --------------------------------------------
  //
  // The IBL's lower hemisphere, the LUT's own ground-bounce integral, the fog's
  // downward inscatter and (under overcast) the deck's level are all functions
  // of what the level is standing on. GROUND_ALBEDO above is the market's
  // sun-baked sand and stays the default for every caller that does not say
  // otherwise, so market and harbor cannot move.
  //
  // Applied ONLY to levels that carry a declarative env profile, which market
  // and harbor deliberately do not. A level can override at any time with
  // sky.setGroundAlbedo(), and a profile can carry env.groundAlbedo.
  var GROUND_ALBEDO_BY_LEVEL = {
    snowbound: [0.860, 0.890, 0.940],   // fresh snow, blue-shifted
    jungle:    [0.085, 0.120, 0.062],   // wet leaf litter and mud
    boneyard:  [0.350, 0.310, 0.240],   // bleached desert hardstanding - warm
    highrise:  [0.200, 0.200, 0.210],   // city concrete, neutral
    refinery:  [0.160, 0.150, 0.135],   // oil-stained hardstanding
    ruins:     [0.230, 0.215, 0.165],   // grey-gold stone with moss
    metro:     [0.060, 0.062, 0.058],
    bunker:    [0.070, 0.068, 0.062]
  };

  // ---- per-level defaults for the two OPT-IN blocks above -------------------
  //
  // Same contract as GROUND_ALBEDO_BY_LEVEL and for the same reason: these are
  // DEFAULTS keyed on a level id, resolved once in _resolveEnvProfile and only
  // for a level that carries a declarative env profile. market and harbor carry
  // env:null, so not one line of this executes for them and neither table can
  // reach the frozen path.
  //
  // A level's own profile always wins - `env.twilight` and `env.dust` /
  // `env.dustGain` are read first - so when these move into the LEVELS table in
  // main.js the entries here simply stop being consulted. They live here rather
  // than being left unset because the alternative is a shipped correctness fix
  // that no level is switched on to receive: the descending-ray dust guard was
  // added for Meridian Tower a round ago, documented as level-facing, and never
  // enabled by anything.
  //
  // twilight: the authored Rayleigh zenith. Only a level whose sun sits within a
  // few degrees of the horizon has any use for it, and only one asks: at
  // t = 0.22 Bayon's disc is 0.06 degrees DOWN, i.e. full civil twilight, and
  // the single-scattering dome is magenta there (see the TWILIGHT ZENITH
  // header). highrise (t = 0.80, -0.32 deg) and refinery (t = 0.88, -6.8 deg)
  // are in the same window and are deliberately NOT listed: both currently pass
  // their critics on a warm sunset dome and neither asked for a cool zenith.
  var TWILIGHT_BY_LEVEL = {
    ruins: { amount: 1.0 }
  };
  // dust: the mote field. See setDustGain for what each field does and why the
  // two guards are opt-in rather than default.
  // Where the near-shell ramp completes, in metres, for a level with an env
  // profile. A little under half the 14 m wrap cell.
  var DUST_ENV_NEAR = 5.5;
  var DUST_BY_LEVEL = {
    // Meridian Tower: the whole frame is 25 degrees BELOW the eye against bright
    // depth haze 176 m down, so every ray descends, the shipped rising-ray guard
    // is 1.0 for all of them, and the field printed 765-1441 hard specks against
    // the brightest thing in the picture. downFade is the mirror-image guard;
    // gain 0.60 is the ~40% peak-alpha cut the finding asks for.
    highrise: { gain: 0.60, downFade: 0.85 }
  };

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
    // ---- daylight overcast / enclosed. All zero / unused when uOver.x == 0. -
    // Shares the storm deck's noise field, projection and parallax and nothing
    // else: see the DAYLIGHT OVERCAST header for why the two cannot be the same
    // object with different constants.
    'uniform vec4 uOver;',           // x strength, y deckMin, z deckRange, w band amount
    'uniform vec4 uOverB;',          // x cell amount, y solar lobe exponent, z bounce gain, w unused
    'uniform vec4 uOverPic;',        // x picture gain, y knee, z asymptote, w tint amount
    'uniform vec3 uOverSun;',        // peak radiance of the diffuse solar region
    'uniform vec3 uOverGnd;',        // ground bounce landing on the cloud base
    // x squall amount, y deck horizon e-fold, z HAZE BAND e-fold (0 = use the
    // clear-sky literal 9.0), w horizon band strength. All zero for clear,
    // storm and the enclosed profile, so every line that reads it is either
    // inside the overcast branch or falls back to the exact constant it
    // replaced. See OVER_SQUALL / OVER_BAND_K_LO.
    'uniform vec4 uOverC;',
    // Two-lobe haze tint: rgb = the colour the ANTI-SUN lobe of the horizon
    // haze is pulled toward, w = how far. Applied luminance-preserving, so it
    // shifts hue and never level. w = 0 for every existing caller, which makes
    // the whole block dead code. See setFog({tint, tintAmount}).
    'uniform vec4 uHazeTint;',
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
    '  float hazeW = clamp( ( fhg - 0.42 ) * 0.34, 0.0, 1.0 );',
    '  vec3 haze = mix( uHazeSky, uHazeSun, hazeW );',
    // ---- two-lobe tint ----------------------------------------------------
    // A pre-sunrise sky does not scatter GREY away from the sun, it scatters
    // blue-violet, and `desaturate` is the only lever a level had for "less sun
    // colour in the haze". This pulls the ANTI-SUN lobe (hazeW near 0) toward
    // an authored chromaticity while the sunward lobe keeps the solar colour
    // the atmosphere solved. Luminance-preserving on purpose: the level of the
    // haze is a measured quantity capped against keyRef three functions away,
    // and a tint has no business moving it. uHazeTint.w is 0 unless a level
    // calls setFog({tint,...}), so this is dead code for market and harbor.
    '  if ( uHazeTint.w > 0.0 ) {',
    '    float htw = uHazeTint.w * ( 1.0 - hazeW );',
    '    float hl = dot( haze, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '    float tl = dot( uHazeTint.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '    haze = mix( haze, uHazeTint.rgb * ( hl / max( tl, 1e-4 ) ), clamp( htw, 0.0, 1.0 ) );',
    '  }',
    // The e-fold is a uniform ONLY so a dense overcast can reach further up the
    // dome (see OVER_BAND_FALL_LO). It is 0 for every clear-sky and storm
    // caller, which takes the literal 9.0 branch - the identical expression
    // this line has always evaluated.
    '  float hzFall = uOverC.z > 0.5 ? uOverC.z : 9.0;',
    '  float hz = uMode.y * exp( -abs( d.y ) * hzFall );',
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
    // ======================================================================
    // Which deck is this? The storm composition below is left EXACTLY as it
    // shipped, inside the else branch, so level 2 executes the identical
    // sequence of operations on the identical values. The overcast branch is a
    // separate object that happens to share the density field.
    // ======================================================================
    '    vec3 stDeck = vec3( 0.0 );',
    '    if ( uOver.x > 0.0 ) {',
    // ZENITH-TO-HORIZON RAMP, on the deck's OWN e-folding rather than the
    // storm's. The storm's exp(-elev*3.2) is spent by twenty degrees, which
    // puts the entire ramp behind the rooftops and leaves the sky a ground-level
    // camera actually sees inside a 1.13x spread. uOverC.y is 1.9 for a daylight
    // deck and the storm's own 3.2 for the enclosed profile, which asked for
    // none of this. See OVER_HORIZON_P.
    '      float oHor = exp( - max( stEl, 0.0 ) * max( uOverC.y, 0.05 ) );',
    '      vec3 oAmb = mix( uStormHigh, uStormLow, oHor );',
    // A DAYLIGHT deck is lit from ABOVE, so the sign of the thickness term is
    // the opposite of the storm's: THIN cloud is bright (sunlight leaks
    // through it), thick cloud is the darker mass beside it. Same stTrans
    // field, read the other way round.
    '      vec3 oD = oAmb * ( uOver.y + uOver.z * stTrans );',
    // Hue structure rather than luminance structure, exactly as the storm deck
    // does it and for the same reason: a deck that varies only in brightness is
    // a gradient, one that varies in colour is cloud. Thin patches are showing
    // warm transmitted sunlight, thick ones cold multiply-scattered light, and
    // the two ends are luminance-matched to within 2% so this costs the deck
    // nothing in level. uOverPic.w is 0 for the enclosed profile, which has to
    // stay strictly neutral.
    '      vec3 oT = mix( vec3( 1.05, 1.01, 0.96 ), vec3( 0.92, 0.96, 1.08 ), stThick );',
    '      oD *= mix( vec3( 1.0 ), oT, uOverPic.w );',
    // Two independent mean-1 relief fields - the sagging cells of the base and
    // the mid-frequency rolls inside the deck. Because both noise channels
    // average 0.5 these average to exactly 1.0, so they buy internal structure
    // at zero cost to the level, the vertical balance or the meter. Without
    // them an even deck is a flat card, which is the whole failure mode.
    '      oD *= ( 1.0 - uOverB.x ) + uOverB.x * 2.0 * stCell;',
    '      oD *= ( 1.0 - uOver.w ) + uOver.w * 2.0 * stB.g;',
    // ---- THE SQUALL FIELD --------------------------------------------------
    // The three layers above all ride projections whose frequency explodes at
    // the skyline, so they mip out to their own mean across the entire lower
    // half of a ground-level framing - which is most of the sky in frame, and
    // is why the deck measured as a plate however much relief was authored into
    // it. This is one octave of genuinely LARGE-scale breakup: stMacro off the
    // far projection at 0.28 (about two thirds of a tile across the whole
    // visible sky) against a second near-projection sample at 0.17 on a slower
    // drift, so the two slide over each other and the field evolves instead of
    // sliding rigidly past. Mean exactly 1.0 by construction - see OVER_SQUALL.
    '      if ( uOverC.x > 0.0 ) {',
    '        float oMacA = texture2D( uStormTex,',
    '                        stFar * 0.90 + uStormDrift.zw * 0.60 + vec2( 0.41, 0.07 ) ).r;',
    '        float oMacB = texture2D( uStormTex,',
    '                        stNear * 0.26 + uStormDrift.xy * 0.30 + vec2( 0.19, 0.83 ) ).g;',
    '        float oMac = oMacA * 0.58 + oMacB * 0.42;',
    '        oD *= ( 1.0 - uOverC.x ) + uOverC.x * 2.0 * oMac;',
    // The same field in HUE - the half that survives the print. Dark cell =
    // cold blue-grey, thin patch = a shade warmer. Both endpoints are
    // luminance-1 by construction, so this is a pure chromaticity rotation.
    '        vec3 oSqT = mix( vec3( ' + OVER_SQ_COOL[0].toFixed(4) + ', ' +
      OVER_SQ_COOL[1].toFixed(4) + ', ' + OVER_SQ_COOL[2].toFixed(4) + ' ),',
    '                         vec3( ' + OVER_SQ_WARM[0].toFixed(4) + ', ' +
      OVER_SQ_WARM[1].toFixed(4) + ', ' + OVER_SQ_WARM[2].toFixed(4) + ' ), oMac );',
    '        oD *= mix( vec3( 1.0 ), oSqT, uOverB.w );',
    '      }',
    // GROUND BOUNCE onto the cloud base. Under snow this is not a detail, it is
    // the effect: an 0.87-albedo field under an 0.58-reflectance base very
    // nearly doubles the light, and it arrives from BELOW, which is what
    // flattens the dome into a whiteout. Thick cloud returns more of it (the
    // same saturating back-scatter the storm deck uses), and the sagging cells
    // hang lower and catch more still.
    '      float oRf = stThick * ( 1.30 - 0.40 * stThick );',
    '      oD += uOverGnd * oRf * ( 0.60 + 0.40 * stCell ) * uOverB.z;',
    // THE SUN AS A REGION, NOT A DISC. The disc itself is killed by clearAmt
    // below, exactly as under storm. What replaces it is a broad
    // forward-scattering lobe about the solar direction that is brightest where
    // the deck is THINNEST - so it moves with the cloud instead of being a
    // painted gradient, and it vanishes entirely in a whiteout where the deck
    // never thins.
    '      float oS = pow( max( cosT * 0.5 + 0.5, 0.0 ), max( uOverB.y, 1.0 ) );',
    '      oD += uOverSun * oS * ( 0.30 + 0.70 * stTrans );',
    // PICTURE-ONLY SHOULDER. Same split as DAY_GAIN, referenced to the ground
    // albedo rather than to a fixed gain (see the header).
    // _regenerateEnvironment pushes the asymptote out of range for the duration
    // of the probe capture, so the LIGHT the scene receives never sees this.
    // Hue is preserved exactly: the roll is applied to luminance and scaled
    // back onto the triple.
    '      if ( uOverPic.z < 1.0e8 ) {',
    '        oD *= uOverPic.x;',
    '        float oL = dot( oD, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '        float oSpan = uOverPic.z - uOverPic.y;',
    '        if ( oL > uOverPic.y && oSpan > 1e-6 ) {',
    '          float oRl = uOverPic.y + oSpan * ( 1.0 - exp( - ( oL - uOverPic.y ) / oSpan ) );',
    '          oD *= oRl / max( oL, 1e-6 );',
    '        }',
    '      }',
    // ---- TURBIDITY HORIZON BAND ---------------------------------------------
    // AFTER the shoulder, deliberately: the target is the same inscatter colour
    // the fog chunk paints on the geometry two hundred metres away, and that
    // colour is never shoulder-compressed. Blending to it here is what makes the
    // deck and the far field land on the SAME value at the skyline instead of
    // meeting at a step - which under a whiteout is the whole illusion. Reaches
    // about 25 degrees at snowbound's turbidity and about 15 at jungle's. Zero
    // for storm, clear and the enclosed profile. See OVER_BAND_K_LO.
    '      if ( uOverC.w > 0.0 ) {',
    '        float oBand = uOverC.w * exp( - max( stEl, 0.0 ) * hzFall );',
    '        oD = mix( oD, haze, clamp( oBand, 0.0, 0.92 ) );',
    '      }',
    '      stDeck = oD;',
    '    } else {',
    // STORM_DECK_MIN is a FLOOR, not a taste call: the darkest place in this
    // sky is thick cloud high up, where there is neither transmission from
    // above nor underglow from below, and ARCHITECTURE 7.6 and the harbor art
    // direction both forbid crushing it to nothing.
    //
    // The RANGE around it is deliberately wider than the mean is high (0.18 to
    // 1.16 about a mean of 0.37): the deck's depth is the spread, not the
    // level.
    '    stDeck = stAmb * stTint',
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
    '    }',
    // ---- sheet lightning INSIDE the deck ----------------------------------
    // Common to both decks, and a no-op for the overcast one: nothing writes
    // uFlash unless _stormF is non-zero, so uFlash.xyz is exactly (0,0,0) and
    // the branch below is never entered.
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
    // How hard a mote on a steeply DESCENDING ray is suppressed. 0 for the
    // market, the harbor and every level that does not ask, which makes the
    // expression below an exact multiply by 1.0. See setDustGain().
    'uniform float uDownFade;',
    // ---- the two opt-in shell guards, both 0 for market and harbor ----------
    // uNearFade  distance (m) by which the near ramp completes. 0 = the shipped
    //            0.30..1.4 ramp alone, i.e. a mote 2 m from the lens draws at
    //            FULL alpha - which is what made the field pop in at the same
    //            value at every depth inside the 14 m wrap shell.
    // uSubPx     energy conservation for a mote whose true footprint is under
    //            one pixel. gl_PointSize is clamped UP to 1.0 (it has to be -
    //            zero-size points do not rasterise), so a mote that should cover
    //            0.3 px is drawn over 1 px at full alpha, i.e. eleven times its
    //            own energy, as a hard-edged single-pixel square. That is
    //            literally the definition of sensor noise and it is why the far
    //            field measured the same peak value as the near field.
    'uniform float uNearFade;',
    'uniform float uSubPx;',
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
    // ...and the OTHER half of the same test, which the original missed because
    // it was written for a camera standing in a street.
    //
    // "A mote is only ever visible against something darker than itself" is the
    // right rule; a rising ray is only half of it. On a level whose entire
    // subject is 25 degrees BELOW the horizon and whose background is bright
    // depth haze 176 m down - an unfinished floor plate over a city - every ray
    // in frame descends, upFade is 1.0 for all of them, and the field prints at
    // full alpha against the brightest thing in the picture: measured 765-1441
    // hard white specks per frame, 11% of them chromatic. So a steeply
    // DESCENDING ray gets the mirror-image suppression.
    //
    // Opt-in, because it is exactly wrong for a street: there the ground two
    // metres ahead is the darkest thing in frame and a descending ray is where
    // the shaft reads best. uDownFade is 0 unless a level sets it, and
    // 1.0 - 0.0 * x is exactly 1.0, so market and harbor are bit-identical.
    '  float downFade = 1.0 - uDownFade * ( 1.0 - smoothstep( -0.30, -0.055, vray.y ) );',
    // ---- the two opt-in shell guards ---------------------------------------
    // Both are written as a factor that ends the product chain and both resolve
    // to EXACTLY 1.0 when their uniform is 0, so the market and harbor
    // expression is the identical sequence of multiplies it always was.
    //
    // NEAR RAMP. The shipped 0.30..1.4 ramp is a lens-flare guard, not a depth
    // cue: it is spent by a metre and a half, so inside a 14 m wrap shell a mote
    // 2 m out and a mote 12 m out draw at the same value against wildly
    // different backdrops. Pushing the completion of the ramp out to uNearFade
    // fades the field IN with depth as well as out, which is what a scattering
    // medium does - the near shell is where the eye cannot focus anyway.
    //
    // SUB-PIXEL ENERGY. See the uniform declaration. The correction is the
    // square of the true footprint because a point's energy scales with its
    // AREA; below one pixel it is the only thing keeping the field from being a
    // constant-value speckle mask laid over the whole frame.
    '  float shell = 1.0;',
    '  if ( uNearFade > 0.0 ) shell = smoothstep( 0.8, uNearFade, dist );',
    '  if ( uSubPx > 0.0 ) {',
    '    float want = min( aSeed.z * uT.y / dist, 1.0 );',
    '    shell *= mix( 1.0, want * want, uSubPx );',
    '  }',
    '  vAlpha = aSeed.w * edge * rng * lift * upFade * downFade * shell;',
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
    // TWO-LOBE INSCATTER TINT. rgb = the chromaticity the ANTI-SUN lobe is
    // pulled toward, w = how far. w is 0 for every existing caller, which makes
    // the block below dead code and leaves market and harbor bit-identical.
    //
    // The problem it exists for: a misty dawn wants LESS of the sun's colour in
    // the air away from the sun, and the only lever a level had was
    // `desaturate`, which pulls toward GREY. A pre-sunrise sky does not scatter
    // grey away from the sun, it scatters blue-violet, so the choice was a pink
    // veil over everything or a dead one. Every level in the roster that pairs a
    // low sun with heavy air hits this.
    '  uniform vec4 gbFogTint;',
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
    // Phase-weighted, so the sunward lobe keeps the solar colour the atmosphere
    // solved and only the anti-sun half takes the tint. Luminance-preserving:
    // the LEVEL of the inscatter is a measured quantity capped against keyRef in
    // _deriveAmbient and a tint has no business moving it - it shifts hue only.
    // Applied before the ground blend so a warm bounce under a ledge still reads
    // warm, which is what stops this becoming a global colour cast.
    '    if ( gbFogTint.w > 0.0 ) {',
    '      float tw = gbFogTint.w * ( 1.0 - min( w, 1.0 ) );',
    '      float fl = dot( fc, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '      float tl = dot( gbFogTint.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '      fc = mix( fc, gbFogTint.rgb * ( fl / max( tl, 1e-4 ) ), clamp( tw, 0.0, 1.0 ) );',
    '    }',
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

  // --------------------------------------------------------------------------
  // Read a colour out of whatever a caller happened to hand us: an [r,g,b]
  // array, a THREE.Color (or anything with .r/.g/.b), or a 0xRRGGBB integer.
  // Values are LINEAR - everything in this module is - and an integer is
  // interpreted the way THREE.Color does, i.e. as sRGB-ish bytes converted with
  // a 2.2 power, which is what an author typing a hex code expects.
  //
  // Returns false and leaves `out` alone on anything it cannot read, so a bad
  // profile value degrades to "no tint" rather than to NaN in the fog.
  // --------------------------------------------------------------------------
  var _tintTmp = [1, 1, 1];
  function readRGB(v, out) {
    if (v == null) return false;
    var r, g, b;
    if (typeof v === 'number') {
      if (!isFinite(v)) return false;
      r = Math.pow(((v >> 16) & 255) / 255, 2.2);
      g = Math.pow(((v >> 8) & 255) / 255, 2.2);
      b = Math.pow((v & 255) / 255, 2.2);
    } else if (typeof v.length === 'number' && v.length >= 3) {
      r = +v[0]; g = +v[1]; b = +v[2];
    } else if (isFinite(v.r) && isFinite(v.g) && isFinite(v.b)) {
      r = v.r; g = v.g; b = v.b;
    } else { return false; }
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return false;
    if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
    out[0] = r; out[1] = g; out[2] = b;
    return true;
  }

  // ==========================================================================
  // OPTION-BAG VALIDATION
  //
  // Every setter in this file used to drop what it did not recognise in
  // silence, and one instance of that cost two rounds of work on a level whose
  // author had done everything right except spell the key inside the object:
  //
  //   for (var k in opts) if (k in this.fog) this.fog[k] = opts[k];
  //
  // level_highrise.js documented `density: 0.0019` in three separate comment
  // blocks and quoted three solved path opacities to the per cent, and the key
  // was never in the literal, so the level ran on the DEFAULT 0.0150 - the
  // market street's fog, eight times thicker - for two rounds. At that level's
  // baseY (-174) and heightScale (380) that put 32% haze across 40 m of floor
  // plate and pinned everything past 250 m at the opacity cap. It was found by
  // elimination, not by reading.
  //
  // So: an unrecognised key, an unusable value and a value the active weather
  // preset is about to overrule are all LOUD now. console.warn, deliberately
  // behind no flag at all, and deliberately NOT GAME.logError - shoot.py and
  // playtest.py both read that channel as a real fault, so a diagnostic there
  // fails a capture on a healthy build.
  //
  // De-duplicated per (method, message) so a setter called every frame cannot
  // flood the console, and so the warning survives being read.
  // ==========================================================================
  var _skyWarned = Object.create(null);
  function skyWarn(where, msg) {
    var key = where + '|' + msg;
    if (_skyWarned[key]) return;
    _skyWarned[key] = 1;
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[sky.' + where + '] ' + msg);
      }
    } catch (e) { /* a console that throws is not our problem */ }
  }

  // Cheap "did you mean" - one pass of a bounded Levenshtein against the known
  // keys, case-insensitive. The dropped-key bug was a MISSING key rather than a
  // misspelt one, but the same warning has to catch `heightscale`, `maxOpactiy`
  // and `tintamount`, which are the three shapes this class of typo takes.
  function _editDist(a, b) {
    var la = a.length, lb = b.length, i, j, prev, cur, tmp;
    if (Math.abs(la - lb) > 3) return 99;
    prev = new Array(lb + 1);
    cur = new Array(lb + 1);
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var c = (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      }
      tmp = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }
  function _suggest(key, known) {
    var lk = String(key).toLowerCase(), best = null, bd = 99, i;
    for (i = 0; i < known.length; i++) {
      var d = _editDist(lk, known[i].toLowerCase());
      if (d < bd) { bd = d; best = known[i]; }
    }
    return (bd <= 3) ? best : null;
  }

  // Warn about any own key of `opts` that is not in `known`. Returns nothing:
  // the caller has already decided what to do with the keys it does recognise,
  // and an unknown key can only ever be ignored.
  function checkOpts(where, opts, known) {
    if (!opts || typeof opts !== 'object') return;
    for (var k in opts) {
      if (!Object.prototype.hasOwnProperty.call(opts, k)) continue;
      if (known.indexOf(k) >= 0) continue;
      var s = _suggest(k, known);
      skyWarn(where, 'unknown option "' + k + '" was IGNORED' +
        (s ? ' - did you mean "' + s + '"?' : '.') +
        ' Recognised: ' + known.join(', '));
    }
  }

  // ---- the fog bag's schema -------------------------------------------------
  // Ranges are the ones the uniform path already enforces downstream, so an
  // in-range value behaves exactly as it did before this existed and an
  // out-of-range one is clamped WITH a warning instead of silently landing on a
  // different number several hundred lines away. Every value any shipped level
  // passes today is inside these bounds, so no current capture moves.
  var FOG_KEYS = {
    density: [0.0, 0.5],
    heightScale: [0.5, 40000.0],
    baseY: [-100000.0, 100000.0],
    startDistance: [0.0, 500.0],
    maxOpacity: [0.0, 1.0],
    mieG: [0.0, 0.92],
    glowGain: [0.0, 8.0],
    desaturate: [0.0, 1.0],
    tintAmount: [0.0, 1.0],
    tint: 'rgb',
    enabled: 'bool'
  };
  var FOG_KEY_LIST = Object.keys(FOG_KEYS);

  // Which fog keys the non-clear presets REPLACE, and with what. This is the
  // second silent drop in the same method and it is the one that had already
  // been discovered the hard way by a second level: level_jungle.js records
  // "glowGain is the one aerial-perspective control the overcast deck does NOT
  // override", which is an accurate observation arrived at by experiment. Under
  // 'overcast', 'drizzle' or 'none', _fogParam() blended the authored value all
  // the way to the preset's at weight 1.0 - i.e. threw it away completely - so
  // five of the nine numeric keys did nothing at all on four of the eight new
  // levels. See _fogParam for the fix (an explicitly authored key now wins) and
  // the warning below for the ones that are still overridden.
  // Keys the preset REPLACED outright (fixed by the authored-wins rule, so this
  // list is now only used to explain what the default would have been).
  var FOG_PRESET_KEYS = {
    storm: ['heightScale', 'maxOpacity', 'mieG', 'startDistance', 'desaturate'],
    overcast: ['heightScale', 'maxOpacity', 'mieG', 'startDistance', 'desaturate'],
    drizzle: ['heightScale', 'maxOpacity', 'mieG', 'startDistance', 'desaturate'],
    none: ['heightScale', 'maxOpacity', 'mieG', 'startDistance', 'desaturate']
  };
  // `density` is different in kind and is NOT fixed by the authored-wins rule,
  // deliberately: under a deck the authored number is a BASE that the preset
  // SCALES (x2.2 overcast, x1.36 drizzle, x1.15 enclosed) rather than replaces,
  // because snowbound and jungle share one preset and need to scale their own
  // weather. That is documented in _scheduleHaze and jungle depends on it, so
  // the only thing to fix is that nobody was told. A caller that sets density
  // under a deck now gets the multiplier reported once.
  var FOG_DENSITY_K = { storm: 0, overcast: 2.2, drizzle: 1.36, none: 1.15 };

  // Every key a level's declarative env profile may carry. The first group is
  // consumed by THIS module; the second is routed by main.js's applyEnv to
  // weather.js, postfx and lighting.js and is listed here only so validating
  // the bag does not produce a false warning for a key that is somebody
  // else's. A key in neither group is read by nothing at all.
  var ENV_KEYS = [
    // sky.js
    'timeOfDay', 'sky', 'turbidity', 'groundAlbedo', 'twilight', 'zenithTint',
    'depthHaze', 'sunElevation', 'solarArc', 'dust', 'dustGain', 'fog',
    'fogTint', 'fogTintAmount',
    // other systems (see main.js applyEnv)
    'weather', 'grade', 'exposure', 'lightRig', 'interior'
  ];

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
    // ---- dust field controls (see setDustGain) -----------------------------
    // Both are the values the field has always run at, so an untouched build is
    // bit-identical. They live on the instance rather than only in the uniform
    // block because setDustGain() is legal before build(), and _makeDust runs
    // several steps into build().
    this._dustGain = 1.0;
    this._dustDown = 0.0;
    // The two shell guards. 0 = the shipped field exactly (see DUST_VERT).
    this._dustNear = 0.0;
    this._dustSubPx = 0.0;
    // ---- solar arc (see setSolarArc) ---------------------------------------
    // Peak elevation of the day arc, in radians. MAX_ELEV (30 deg) is the
    // art-directed default every shipped capture was framed against; a level
    // whose whole premise is a different sun height overrides it through its env
    // profile. Per-instance, so nothing a level does can move the module
    // constant out from under market or harbor.
    this._maxElev = MAX_ELEV;
    // ---- twilight zenith (see setTwilight and the TWILIGHT ZENITH header) ---
    // _twiF is the single gate every added branch tests, and it is 0 here, so
    // market, harbor and every level that does not opt in run the identical
    // afterglow arithmetic. The tunables are per-instance for the same reason
    // _maxElev is: nothing a level does can move the module constants.
    this._twiF = 0;
    this._twiZenith = [TWI_ZENITH[0], TWI_ZENITH[1], TWI_ZENITH[2]];
    this._twiDim = TWI_DIM;
    this._twiAway = TWI_AWAY;
    this._twiAzP = TWI_AZ_P;
    // ---- cool upper dome, at ANY sun elevation (see setZenithTint) ----------
    // _ztF is this block's single gate and it is 0 here, so market, harbor and
    // every level that does not opt in run the identical LUT arithmetic.
    //
    // WHY IT IS NOT setTwilight. The twilight rotation above is multiplied by
    // `afterglow`, a window that is only open between +9 and -13 degrees of sun
    // elevation - so it is INERT on any level whose sun is properly up, and
    // measured on Meridian Tower (which the roster calls a sunset and which
    // actually runs at +8.8 degrees after its own level module re-pins the hour
    // to t = 0.712) afterglow is 0.0017. setTwilight cannot reach that level at
    // all. This is the same luminance-preserving rotation with the solar-window
    // gate removed and the elevation window authored in degrees.
    this._ztF = 0;
    this._ztChroma = [TWI_ZENITH[0], TWI_ZENITH[1], TWI_ZENITH[2]];
    this._ztLo = TWI_LO;             // sin(elevation) where the rotation starts
    this._ztHi = TWI_HI;             // ...and where it is complete
    this._ztAway = TWI_AWAY;
    this._ztAzP = TWI_AZ_P;
    this._ztDim = 0.0;               // gradient is opt-in on top of the hue
    // ---- interior aerial perspective (see setDepthHaze) --------------------
    // _dhF is this block's single gate. 0 for every existing caller, and the
    // whole block is skipped rather than multiplied by zero.
    this._dhF = 0;
    this._dhRad = 0;                 // absolute linear radiance of the lit air
    this._dhHue = null;              // null = keep the hue the model solved
    this._dhSun = 1.25;              // sunward lobe, x radiance
    this._dhGnd = 0.80;              // downward lobe, x radiance

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
      // ---- two-lobe inscatter tint (see FOG_PARS_FRAGMENT / setFog) --------
      // tint       null, or a colour the ANTI-SUN lobe of the haze is pulled
      //            toward: [r,g,b], a THREE.Color, or a 0xRRGGBB number. LINEAR,
      //            like everything else in this file.
      // tintAmount 0..1, how far. 0 by default, which makes the shader block
      //            dead code and keeps market and harbor bit-identical.
      tint: null,
      tintAmount: 0,
      enabled: true
    };
    // Which fog keys a caller has EXPLICITLY authored through setFog() or an
    // env profile. Empty for market and harbor, which never call it, and that
    // is what makes the authored-wins rule in _fogParam a strict no-op for
    // them. See _fogParam and FOG_PRESET_KEYS.
    this._fogSet = Object.create(null);

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
    // ---- daylight overcast / enclosed (levels 3-10) ------------------------
    // _overcastF is to the overcast deck exactly what _stormF is to the storm
    // one: the single gate every added branch tests, zero for market, harbor
    // and every clear-sky level. _voidF additionally marks the 'none' profile,
    // where there is no sky at all and the deck exists only to give the IBL
    // something dim and neutral to be.
    this._overcastF = 0;
    this._voidF = 0;
    this._overThick = 1.0;           // 1 = full deck, <1 = a thinner 'drizzle' one
    this.enclosed = false;           // published: "this level has no sky"
    // Ground albedo. Starts as an exact copy of the market's sun-baked sand, so
    // the default path is bit-identical; setGroundAlbedo() or a level profile
    // moves it. Feeds the LUT's ground-bounce integral, the fog's downward
    // inscatter and (under overcast) the deck's own level.
    this.groundAlbedo = [GROUND_ALBEDO[0], GROUND_ALBEDO[1], GROUND_ALBEDO[2]];
    // Solved once per LUT generation by _applyOvercastAmbient; read back by
    // _pushUniforms. Defaults are inert.
    this._overScale = 0;
    this._overE = 0;
    this._overGLum = 0;
    this._overSunUp = 0;
    this._overBounceRel = 0;
    this._overSunRel = 0;
    this._overSunP = OVER_SUN_P;
    this._overHue = [1, 1, 1];
    this._overGndHue = [1, 1, 1];
    this._overSunHue = [1, 1, 1];
    this._clearFill = 0.10;
    this._sunIntensityClear = 5.2;
    this._voidBg = null;
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
    // rgb = anti-sun lobe chromaticity, w = amount. Amount 0 = inert.
    this._fogTint = new Float32Array([1, 1, 1, 0]);
    this.fogUniforms = {
      gbFogA: { value: this._fogA },
      gbFogB: { value: this._fogB },
      gbFogSun: { value: this._fogSun },
      gbFogSky: { value: this._fogSky },
      gbFogGnd: { value: this._fogGnd },
      gbFogSunDir: { value: this._fogDir },
      gbFogTint: { value: this._fogTint }
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
    // Latched by _reLut the first time the integral throws, so a persistent
    // fault costs one log line rather than one per setter call for ever.
    this._lutFailed = false;
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
      checkOpts('applyFogTo', opts, ['additive', 'exclude']);
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
    // Per-instance peak elevation. Defaults to MAX_ELEV, so market, harbor and
    // every level that does not call setSolarArc() get the identical arc.
    var peak = isFinite(this._maxElev) ? this._maxElev : MAX_ELEV;
    if (t >= 0.25 && t <= 0.75) {
      var d = (t - 0.25) / 0.5;
      elev = peak * Math.pow(Math.sin(PI * d), 0.85);
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
    //
    // Faded out above 30 degrees of elevation, which is unreachable unless a
    // level has called setSolarArc() - so the market's golden hour, the harbor
    // and every clear-sky level keep the exact 0.22 they shipped with. It has to
    // go for a genuine high sun: 4200 K is a golden-hour reference and a level
    // that asks for high noon asking for it anyway would just be the market's
    // lighting recipe re-dressed, which the roster lists as an instant fail. The
    // extinction path already neutralises the disc's own colour toward ~5500 K
    // as the slant path shortens; this stops the nudge fighting it.
    GAME.Color.kelvin(4200, _kelvinRef);
    this.sunColor.lerp(_kelvinRef,
      0.22 * (1.0 - M.smoothstep(30.0, 55.0, this.sunElevation / M.DEG)));

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

    // ---- daylight overcast / enclosed --------------------------------------
    // The CLEAR-sky key is stashed before anything below touches it. The
    // overcast energy budget is expressed as a fraction of the clear-sky global
    // horizontal irradiance (see _overcastEnergy), so it needs the
    // un-attenuated number - reading the attenuated one would make the deck
    // chase its own tail every time this ran and converge on black.
    this._sunIntensityClear = this.sunIntensity;
    var ovf = M.saturate(this._overcastF);
    if (ovf > 0) {
      if (this._voidF > 0) {
        // Buried. No sun, no moon; lighting.js's practical rig owns every
        // photon in the level. The DIRECTION is lifted to a plausible overhead
        // rather than left pointing up through the floor from a -55 degree
        // solar midnight, because several modules copy sky.sunDirection without
        // first checking that the intensity is zero (weapons' viewmodel key,
        // vfx's impact lighting, ai's wrap term) and a key arriving from under
        // the ground reads as a bug in all three.
        this.sunIntensity = 0.0;
        this.moonIntensity = 0.0;
        this.sunColor.setRGB(0.86, 0.90, 1.00);
        this.sunDirection.set(0.18, 0.96, -0.22).normalize();
      } else {
        // Not zero. lighting.js needs a key direction every frame, an overcast
        // really does have a bright side, and a level with NO directional
        // component loses every contact and form cue - the flat, dead lighting
        // on the instant-fail list. At 0.20 of a low winter sun the shadows are
        // barely readable, which is what a blizzard looks like.
        var okk = M.lerp(OVER_KEY_K_THIN, OVER_KEY_K, M.saturate(this._overThick));
        this.sunIntensity *= M.lerp(1.0, okk, ovf);
        this.moonIntensity *= M.lerp(1.0, OVER_MOON_K, ovf);
        // A deck diffuses the sun's own colour out of the key: what reaches the
        // ground under stratus is the deck's near-white, not a 4200 K disc.
        _kelvinRef.setRGB(1.0, 0.985, 0.965);
        this.sunColor.lerp(_kelvinRef, 0.62 * ovf);
      }
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

    // ---- overcast / enclosed ------------------------------------------------
    // Mutually exclusive with the storm above (one preset sets one gate), but
    // written as a second, separate branch anyway so neither can ever modify
    // the other's numbers. The night/afterglow multipliers computed above are
    // deliberately replaced rather than stacked on: they model dew and
    // inversion under a CLEAR sky, and a blizzard is neither.
    //
    // The density is a MULTIPLE of the authored base rather than an absolute,
    // so a level that calls setFog({density}) still scales its own weather -
    // which the storm path, tuned against one specific terminal, does not need
    // to do and this one does (snowbound and jungle share the preset).
    var of = M.saturate(this._overcastF);
    if (of > 0 && !(sf > 0)) {
      var vo = this._voidF > 0;
      var od = vo ? base * VOID_FOG_DENS_K
                  : base * OVER_FOG_DENS_K * M.lerp(0.60, 1.0, M.saturate(this._overThick));
      // weather.js owns the blizzard/drizzle contract and knows far more about
      // what is falling than this module does, so its density wins when it is
      // publishing a real one. Taken as a MAX rather than read straight
      // through: an inert 'clear' weather module publishes a near-zero density
      // and would otherwise thin a whiteout down to nothing.
      var wd = this._wxFog;
      if (isFinite(wd) && wd > 0) od = Math.max(od, M.clamp(wd, 0.004, 0.075));
      d = M.lerp(d, od, of);
      this.nightHazeGain = M.lerp(this.nightHazeGain,
        vo ? VOID_HAZE_GAIN : OVER_HAZE_GAIN, of);
      albedo = M.lerp(albedo, vo ? VOID_HAZE_ALBEDO : OVER_HAZE_ALBEDO, of);
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
    } else if (of > 0) {
      this.fogStartEffective = M.lerp(this.fogStartEffective,
        (this._voidF > 0 ? VOID_FOG : OVER_FOG).startDistance, of);
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
  //
  // ---- AN EXPLICITLY AUTHORED VALUE NOW WINS OVER THE PRESET ---------------
  // This was the second half of the dropped-key finding and it is the more
  // expensive half, because it does not need a typo to bite.
  //
  // _stormF / _overcastF are 1.0, not a fraction, so `M.lerp(base, preset, of)`
  // returned the PRESET EXACTLY and discarded `base` entirely. Five of the nine
  // numeric fog keys - heightScale, maxOpacity, mieG, startDistance, desaturate
  // - therefore did nothing whatsoever on any level running 'overcast',
  // 'drizzle' or 'none', which is snowbound, jungle, metro and bunker: four of
  // the eight new levels. level_jungle.js had already discovered the shape of
  // this empirically and written it down ("glowGain is the one aerial-
  // perspective control the overcast deck does NOT override"), which is exactly
  // right and exactly the wrong thing for a level author to have to find out by
  // experiment.
  //
  // The preset value is a DEFAULT for a level that has not said otherwise, so
  // that is what it is now: consulted only when the key is absent from
  // this._fogSet. Nothing in the frozen path can reach it - market and harbor
  // never call setFog, so _fogSet is empty for both and every lookup takes the
  // identical branch it always did - and no current caller changes either,
  // because every level that calls setFog today is on the clear path where the
  // authored value was already being returned unchanged.
  Sky.prototype._fogParam = function (key) {
    var base = this.fog[key];
    if (this._fogSet && this._fogSet[key]) return base;
    var sf = M.saturate(this._stormF);
    if (sf > 0) {
      var storm = STORM_FOG[key];
      if (!isFinite(storm)) return base;
      return M.lerp(base, storm, sf);
    }
    // Same contract for the daylight decks: the authored value EXACTLY when
    // neither gate is up, so market and every clear-sky level are untouched.
    var of = M.saturate(this._overcastF);
    if (of > 0) {
      var alt = (this._voidF > 0 ? VOID_FOG : OVER_FOG)[key];
      if (!isFinite(alt)) return base;
      return M.lerp(base, alt, of);
    }
    return base;
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

  // Rotate an RGB triple's CHROMATICITY toward `chroma` (whose own luminance is
  // 1) by w, then scale the whole thing by `dim`. Luminance-preserving at
  // dim = 1 by construction, which is the contract the twilight layer depends on:
  // the dome is a light source as well as a picture, and a hue change must not
  // move the irradiance it delivers. Hoisted to module scope and allocation-free
  // because it runs 16,384 times per LUT generation.
  // ENERGY NORMALISER for a zenith-dimming gradient over an elevation window.
  //
  // The cosine-weighted mean of (1 - dim * smoothstep(lo, hi, s)) over the upper
  // hemisphere, inverted, so a dome that is dimmed overhead REDISTRIBUTES its
  // irradiance toward the horizon instead of losing it. Without this the
  // gradient is a light cut, and 64% of the sky's irradiance lives above the
  // window - the first version of the twilight layer measured a third of the
  // level's skylight gone and the whole frame printing 16% down.
  //
  // 32 steps of the actual expression rather than a closed form, because a
  // closed form stops being true the moment the window moves and both callers
  // now author their own window. The weight for cos(el) sin(el) del is s ds.
  //
  // `pay` is how much of the redistribution is actually paid back (TWI_NORM for
  // the twilight layer): at 1.0 the low sky came out 1.72x its authored level
  // and printed at saturation 0.029, i.e. the golden band was pushed so far up
  // the AgX shoulder it went neutral - the cure eating the patient.
  function dimNorm(dim, lo, hi, pay) {
    if (!(dim > 1e-6)) return 1.0;
    var acc = 0, w8 = 0, q;
    for (q = 0; q < 32; q++) {
      var s = (q + 0.5) / 32;
      acc += (1.0 - dim * M.smoothstep(lo, hi, s)) * s;
      w8 += s;
    }
    if (!(acc > 1e-6)) return 1.0;
    return 1.0 + (w8 / acc - 1.0) * M.saturate(pay);
  }

  var _twiChroma = [1, 1, 1];
  var _ztChromaN = [1, 1, 1];
  function twiRotate(x, chroma, w, dim) {
    var xl = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    if (!(xl > 0.0)) { x[0] *= dim; x[1] *= dim; x[2] *= dim; return; }
    x[0] = (x[0] + (xl * chroma[0] - x[0]) * w) * dim;
    x[1] = (x[1] + (xl * chroma[1] - x[1]) * w) * dim;
    x[2] = (x[2] + (xl * chroma[2] - x[2]) * w) * dim;
  }

  // ==========================================================================
  // Re-solve the LUT from a public setter, ONCE, and never again if it throws.
  //
  // Two things this protects, and the second one only exists because of the
  // first. build() now sets _built even when a stage failed (see build) - which
  // is right, because every public setter checks _built to decide whether to
  // APPLY a change or merely record it, and leaving it false silently discarded
  // a level's whole declarative profile. But it means a persistently broken
  // integral is now re-entered from setTimeOfDay, setTurbidity, setGroundAlbedo
  // and friends, and GAME.logError is UNCAPPED (util.js pushes to an array for
  // ever), so a level that re-times its sun every frame against a broken LUT
  // would grow that array without bound.
  //
  // So the failure is latched: one report, then every later caller quietly keeps
  // the last good LUT and still gets its _pushUniforms and its probe. That is
  // strictly better than both previous behaviours - the frame keeps its fog and
  // its grade, and a repeated fault costs one log line rather than ninety a
  // second.
  //
  // Returns true if the LUT is current.
  // ==========================================================================
  Sky.prototype._reLut = function () {
    if (this._lutFailed) return false;
    try {
      this._buildLut();
      return true;
    } catch (e) {
      this._lutFailed = true;
      GAME.logError('sky.lut', e);
      return false;
    }
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
    //
    // The daylight overcast deck is just as opaque to them, and for 'none'
    // (buried, t = 0, i.e. deep night by the solar arc) suppressing the warm
    // city skyglow matters more than anywhere else: a sodium glow leaking into
    // the fog colours of a sealed bunker is the one thing that would give the
    // whole illusion away. Exactly _stormF for level 2, exactly 0 for level 1.
    var stormK = 1.0 - 0.90 * M.saturate(Math.max(this._stormF, this._overcastF));

    // ---- twilight zenith gate, hoisted out of the 8192-texel loop -----------
    // Zero for market, harbor and every level that has not opted in, and a deck
    // is opaque to a Rayleigh belt exactly as it is to the airglow above, so a
    // storm or an overcast switches it off too. See the TWILIGHT ZENITH header.
    var twiF = M.saturate(this._twiF) * (1.0 - M.saturate(Math.max(this._stormF, this._overcastF)));
    var twC = _twiChroma;
    var twiDim = M.saturate(this._twiDim) * twiF * afterglow;
    var twiAway = M.saturate(this._twiAway);
    var twiAzP = M.clamp(this._twiAzP, 1.0, 40.0);
    var twiNorm = 1.0;
    if (twiF > 0.001) {
      // The authored triple is a CHROMATICITY: normalised to luminance 1 so the
      // rotation below cannot move the dome's level by construction, whatever a
      // caller hands setTwilight().
      var tzl = 0.2126 * this._twiZenith[0] + 0.7152 * this._twiZenith[1] +
                0.0722 * this._twiZenith[2];
      if (!(tzl > 1e-6)) tzl = 1;
      twC[0] = this._twiZenith[0] / tzl;
      twC[1] = this._twiZenith[1] / tzl;
      twC[2] = this._twiZenith[2] / tzl;
      // ENERGY NORMALISER for the gradient factor. See dimNorm.
      twiNorm = dimNorm(twiDim, TWI_LO, TWI_HI, TWI_NORM);
    }

    // ---- cool upper dome, sun-elevation independent (opt-in) ----------------
    // Zero for market, harbor and every level that has not called
    // setZenithTint(). Identical machinery to the twilight rotation above -
    // luminance-preserving chromaticity rotation, azimuthally confined warm
    // band, energy-normalised gradient - with the `afterglow` gate removed and
    // the elevation window authored per instance. A deck is opaque to a
    // Rayleigh belt exactly as it is to the airglow, so storm and overcast
    // switch it off the same way. See setZenithTint.
    var ztF = M.saturate(this._ztF) *
      (1.0 - M.saturate(Math.max(this._stormF, this._overcastF)));
    var ztC = _ztChromaN;
    var ztLo = this._ztLo, ztHi = this._ztHi;
    var ztAway = M.saturate(this._ztAway);
    var ztAzP = M.clamp(this._ztAzP, 1.0, 40.0);
    var ztDim = M.saturate(this._ztDim) * ztF;
    var ztNorm = 1.0;
    if (ztF > 0.001) {
      if (!(ztHi > ztLo + 1e-3)) { ztLo = TWI_LO; ztHi = TWI_HI; }
      var zl = 0.2126 * this._ztChroma[0] + 0.7152 * this._ztChroma[1] +
               0.0722 * this._ztChroma[2];
      if (!(zl > 1e-6)) zl = 1;
      ztC[0] = this._ztChroma[0] / zl;
      ztC[1] = this._ztChroma[1] / zl;
      ztC[2] = this._ztChroma[2] / zl;
      ztNorm = dimNorm(ztDim, ztLo, ztHi, TWI_NORM);
    }

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
          // this.groundAlbedo, not the module constant: it IS the module
          // constant for market and harbor and for every caller that has not
          // called setGroundAlbedo(), so the default path is bit-identical -
          // but a boneyard hardstanding and a snowfield bounce very different
          // amounts of very differently coloured light back into the dome.
          var gA = this.groundAlbedo;
          iso0 += Math.exp(-Math.min(e0, 50)) * gA[0] * Ts[0] * kg;
          iso1 += Math.exp(-Math.min(e1, 50)) * gA[1] * Ts[1] * kg;
          iso2 += Math.exp(-Math.min(e2, 50)) * gA[2] * Ts[2] * kg;
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

        // --- TWILIGHT ZENITH (opt-in) -----------------------------------------
        // LAST, and applied to the finished column - the single-scattering
        // integral, its multiple-scattering top-up AND the authored afterglow -
        // because all three carry the same defect: at a horizon sun every one of
        // them is a warm spectrum, so any of them left un-rotated puts warm back
        // over the blue and the sum is grey. See the TWILIGHT ZENITH header.
        //
        // A luminance-preserving CHROMATICITY ROTATION, not an added layer, and
        // that is the whole design. The dome is also a LIGHT: 64% of the
        // cosine-weighted sky irradiance arrives from above 37 degrees, so
        // crossfading the upper dome out (which is what the first version of this
        // did) took a third of the level's skylight with it and printed the frame
        // 16% down. A rotation moves hue at exactly constant luminance, so the
        // IBL, the hemisphere fill, keyRef and every fog cap are untouched, and
        // ONE separate factor (twiDim) owns the zenith-to-horizon gradient the
        // finding also asks for.
        //
        // The weight has an AZIMUTHAL half, and it is what confines the warm band
        // rather than dimming it: cos^twiAzP is spent ~25 degrees off the sun, so
        // the burning band keeps its full authored level in the sun's own quadrant
        // and the rest of the horizon - which is where the fog's anti-sun lobe is
        // sampled from - rotates to the twilight blue at the SAME luminance it had.
        // That is a hue change with no energy cost, where cutting the afterglow's
        // azimuthal floor cost the anti-sun horizon 60% of its value.
        if (twiF > 0.001 && afterglow > 0.001) {
          var twUp = M.smoothstep(-0.02, 0.03, l);
          if (twUp > 0.0) {
            var twEl = M.smoothstep(TWI_LO, TWI_HI, l > 0.0 ? l : 0.0);
            var twAz = 1.0 - Math.pow(Math.max(0.0, Math.cos(az)), twiAzP);
            var twS = twiF * afterglow * twUp *
                      (twEl + (1.0 - twEl) * twAz * twiAway);
            // Energy-normalised gradient. Lerped from 1.0 by twUp so the
            // below-horizon texels - where the warm ground bounce lives, and
            // which are not part of the normalised integral - are untouched.
            var twD = 1.0 + twUp *
                      (twiNorm * (1.0 - twiDim * twEl) - 1.0);
            twiRotate(Rr, twC, twS, twD);
            twiRotate(Mm, twC, twS, twD);
            var twL = 0.2126 * iso0 + 0.7152 * iso1 + 0.0722 * iso2;
            if (twL > 0.0) {
              iso0 = (iso0 + (twL * twC[0] - iso0) * twS) * twD;
              iso1 = (iso1 + (twL * twC[1] - iso1) * twS) * twD;
              iso2 = (iso2 + (twL * twC[2] - iso2) * twS) * twD;
            } else {
              iso0 *= twD; iso1 *= twD; iso2 *= twD;
            }
          }
        }

        // --- COOL UPPER DOME (opt-in, any sun elevation) -----------------------
        // The sibling of the block above with the solar window removed, and the
        // reason it has to be a separate term rather than a wider `afterglow` is
        // measured: on Meridian Tower - which the roster calls a sunset and whose
        // own level module re-pins the hour to t = 0.712 because at the profile's
        // 0.80 the direct key collapses - the sun sits at +8.81 degrees and
        // afterglow evaluates to 0.0017. setTwilight() multiplies its entire
        // rotation by that number, so the shipped twilight lever is inert on the
        // one level that asked for a cool zenith. Widening the afterglow window
        // instead would have dragged the authored dusk/night layers (which are
        // multiplied by the same factor) into full daylight.
        //
        // Same contract as the twilight rotation: luminance-preserving at
        // ztDim = 0, so the IBL, the hemisphere fill, keyRef and every fog cap
        // are untouched by a pure hue change, and ONE separate factor owns the
        // zenith-to-horizon gradient.
        if (ztF > 0.001) {
          var ztUp = M.smoothstep(-0.02, 0.03, l);
          if (ztUp > 0.0) {
            var ztEl = M.smoothstep(ztLo, ztHi, l > 0.0 ? l : 0.0);
            var ztAz = 1.0 - Math.pow(Math.max(0.0, Math.cos(az)), ztAzP);
            var ztS = ztF * ztUp * (ztEl + (1.0 - ztEl) * ztAz * ztAway);
            var ztD = 1.0 + ztUp * (ztNorm * (1.0 - ztDim * ztEl) - 1.0);
            twiRotate(Rr, ztC, ztS, ztD);
            twiRotate(Mm, ztC, ztS, ztD);
            var ztL = 0.2126 * iso0 + 0.7152 * iso1 + 0.0722 * iso2;
            if (ztL > 0.0) {
              iso0 = (iso0 + (ztL * ztC[0] - iso0) * ztS) * ztD;
              iso1 = (iso1 + (ztL * ztC[1] - iso1) * ztS) * ztD;
              iso2 = (iso2 + (ztL * ztC[2] - iso2) * ztS) * ztD;
            } else {
              iso0 *= ztD; iso1 *= ztD; iso2 *= ztD;
            }
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
    // The CLEAR-sky fill, kept separately because _applyOvercastAmbient
    // overwrites fillRadiance with the deck's own and _overcastEnergy is a
    // fraction of the CLEAR-sky budget. Reading the overwritten value back
    // would close a positive feedback loop through the deck's own light.
    this._clearFill = lum;

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
    var gAlb = this.groundAlbedo;
    this._fogGnd[0] = _c3.r * 0.55 + gAlb[0] * bk;
    this._fogGnd[1] = _c3.g * 0.55 + gAlb[1] * bk;
    this._fogGnd[2] = _c3.b * 0.55 + gAlb[2] * bk;

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
    // ...and its daylight counterpart. Mutually exclusive with the above, and
    // an immediate return when _overcastF is 0.
    this._applyOvercastAmbient();
    // ...and after BOTH, because it is the only term in the file that is allowed
    // to sit above the keyRef cap on purpose. Immediate return when _dhF is 0,
    // which is every level that has not called setDepthHaze().
    this._applyDepthHaze();
  };

  // --------------------------------------------------------------------------
  // INTERIOR AERIAL PERSPECTIVE  (opt-in; see setDepthHaze)
  //
  // WHY EVERY CAP IN THIS FILE IS WRONG FOR AN ENCLOSED LEVEL, and the number
  // that proves it.
  //
  // Every inscatter colour above is derived off the atmosphere and then capped
  // against keyRef, "so the haze can never out-brighten the brightest surface
  // in the frame". keyRef is KEY_ALBEDO * sunIntensity * max(sunY, 0.12) / pi
  // with a floor of fillRadiance * 0.55. Under the 'none' preset sunIntensity is
  // exactly 0 and fillRadiance is the void IBL, so on metro the whole chain
  // collapses to keyRef = 0.00362, the cap on the anti-sun lobe is
  // 0.35 * 2.6 * 0.00362 = 0.0033, and the haze lands there - PINNED AT THE CAP,
  // measured in-engine at fogSky = (0.00341, 0.00352, 0.00363).
  //
  // The brightest surface in metro is not a grey card under a dead sun, it is a
  // tiled wall under a fluorescent, which measures around linear 0.18 in the
  // print. So the air is capped two and a half DECADES under the thing it is
  // supposed to sit behind, and the consequence is exactly what the level
  // reported: at 38 m its east arch prints L = 0.386 against a near floor at
  // 0.349 and a near wall at 0.463 - i.e. the far end of a 38 m hall is
  // BRIGHTER than the floor in front of the lens and there is no value ramp
  // with depth anywhere in the frame. The fog is attenuating (47% at 38 m) but
  // it is not VEILING, and a multiply with no additive term preserves every
  // contrast ratio it touches: that is precisely "it arrives at full contrast".
  //
  // This is the same defect NIGHT_HAZE_K was added to fix for the market's night
  // street ("the brightest thing on a night street is not a moonlit grey card,
  // it is the pavement under a sodium head, which measures roughly twenty times
  // higher") and it was never fixed for the enclosed profile, where the error is
  // fifty times larger because there is no key at all.
  //
  // It cannot be fixed by raising the cap, because the cap is derived from a sun
  // that does not exist. The level is the only thing that knows what its
  // practicals put on a wall, so the level supplies the number - as an ABSOLUTE
  // linear radiance, the way the storm deck's constants are, and for the same
  // stated reason: "referencing the deck to a key that is itself a floor value
  // would make the sky's level an accident of the floor".
  //
  // Applied AFTER every cap and every floor, deliberately, and it is the only
  // place in this file that does that.
  // --------------------------------------------------------------------------
  var _dhHueTmp = [1, 1, 1];
  Sky.prototype._applyDepthHaze = function () {
    var f = M.saturate(this._dhF);
    if (!(f > 0)) return;
    var rad = this._dhRad;
    if (!isFinite(rad) || rad <= 0) return;
    var hue = _dhHueTmp, c;
    if (this._dhHue) {
      hue[0] = this._dhHue[0]; hue[1] = this._dhHue[1]; hue[2] = this._dhHue[2];
    } else {
      // No authored hue: keep the chromaticity the model already solved for the
      // anti-sun lobe, so a level that only wants the LEVEL raised does not also
      // get a colour it did not ask for.
      hue[0] = this._fogSky[0]; hue[1] = this._fogSky[1]; hue[2] = this._fogSky[2];
    }
    var hl = 0.2126 * hue[0] + 0.7152 * hue[1] + 0.0722 * hue[2];
    if (!(hl > 1e-9)) { hue[0] = hue[1] = hue[2] = 1; hl = 1; }
    // Luminance-targeted, so `radiance` means exactly what it says: the linear
    // luminance a fully-veiled surface converges to.
    var kSky = rad / hl;
    var kSun = rad * Math.max(0, this._dhSun) / hl;
    var kGnd = rad * Math.max(0, this._dhGnd) / hl;
    for (c = 0; c < 3; c++) {
      this._fogSky[c] += (hue[c] * kSky - this._fogSky[c]) * f;
      this._fogSun[c] += (hue[c] * kSun - this._fogSun[c]) * f;
      this._fogGnd[c] += (hue[c] * kGnd - this._fogGnd[c]) * f;
    }
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
  // DAYLIGHT OVERCAST / ENCLOSED  -  the CPU side
  //
  // Three pieces, in the order they run:
  //
  //   _overcastEnergy()   how much light the deck delivers to the ground. ONE
  //                       number; everything else in the preset is a ratio to
  //                       it, which is what stops the sky, the ground and the
  //                       haze between them from being authored independently
  //                       and disagreeing.
  //   _overcastShape()    the deck's RELATIVE radiance at one elevation, in its
  //                       mean noise state. Mirrors the shader exactly, the same
  //                       contract _stormDeckRadiance honours and for the same
  //                       reason: _deriveAmbient integrates a CLEAR LUT that
  //                       knows nothing about the deck, so without this the
  //                       level would be LIT by a sky it is not being SHOWN.
  //   _applyOvercastAmbient()  normalises that shape to the energy, replaces
  //                       every derived light term, and hands _pushUniforms the
  //                       scale it needs.
  // ==========================================================================

  // Total downwelling irradiance under the deck, in the same units as
  // sunIntensity (an irradiance) rather than as a radiance. See the header for
  // the ground <-> cloud-base multiple bounce, which is the term that makes
  // snow a whiteout and desert hardstanding warm.
  Sky.prototype._overcastEnergy = function () {
    if (this._voidF > 0) return VOID_E;
    var sy = Math.max(this.sunWorldDirection.y, 0.0);
    var si = isFinite(this._sunIntensityClear) ? this._sunIntensityClear : this.sunIntensity;
    var cf = isFinite(this._clearFill) ? this._clearFill : this.fillRadiance;
    // Clear-sky reference: direct on a flat surface plus the sky's own
    // hemispherical contribution (E = pi * L for a Lambertian receiver), with
    // the solar cosine floored - see OVER_SUN_Y_FLOOR.
    var ec = Math.max(si * Math.max(sy, OVER_SUN_Y_FLOOR) + Math.max(cf, 0) * PI,
      OVER_MIN_E);
    var tr = OVER_TRANSMIT * (1.0 + OVER_THIN_GAIN * (1.0 - M.saturate(this._overThick)));
    var ga = this.groundAlbedo;
    var gl = 0.2126 * ga[0] + 0.7152 * ga[1] + 0.0722 * ga[2];
    var boost = 1.0 / (1.0 - M.clamp(gl * OVER_CLOUD_R, 0.0, OVER_BOUNCE_MAX));
    var e = ec * tr * boost;
    return (isFinite(e) && e > 0) ? e : OVER_MIN_E * 0.4;
  };

  // --------------------------------------------------------------------------
  // "Is the ground under this deck bright enough that the level IS the air?"
  //
  // ONE weight shared by the three whiteout corrections (the deck's chroma
  // expansion, the aerial-perspective convergence and the opacity cap), so they
  // cannot drift apart into three different thresholds. Exactly 0 for the
  // enclosed profile and for a jungle floor, exactly 1 for snow. See
  // OVER_WHITE_LO.
  // --------------------------------------------------------------------------
  Sky.prototype._whiteoutF = function () {
    if (this._voidF > 0 || !(this._overcastF > 0)) return 0;
    var ga = this.groundAlbedo;
    var gl = 0.2126 * ga[0] + 0.7152 * ga[1] + 0.0722 * ga[2];
    return M.saturate((gl - OVER_WHITE_LO) / OVER_WHITE_SPAN);
  };

  // --------------------------------------------------------------------------
  // The deck's DISPLAYED luminance at one elevation: the mirror's absolute
  // radiance with the picture shoulder _pushOvercast publishes applied to it.
  //
  // This is what "converge on the sky" has to be measured against, and it is a
  // different number from the deck's physical radiance: _regenerateEnvironment
  // switches the shoulder off for the probe, so the LIGHT never sees it, but the
  // player does - and so does the value step the far field has to close.
  // Mirrors uOverPic exactly, from the same constants, for the same reason
  // _overcastShape mirrors the deck.
  // --------------------------------------------------------------------------
  Sky.prototype._overcastPictureLum = function (elevSin) {
    this._overcastShape(elevSin, _ovRad);
    var sc = this._overScale;
    if (!isFinite(sc) || sc < 0) sc = 0;
    var L = (0.2126 * _ovRad[0] + 0.7152 * _ovRad[1] + 0.0722 * _ovRad[2]) * sc;
    if (!(L > 0)) return 0;
    if (this._voidF > 0) return L;                 // void gets the identity
    var l0 = Math.max(this._overE, 0) / PI;
    var at = M.saturate((this._overGLum - OVER_ALBEDO_LO) / OVER_ALBEDO_SPAN);
    var gn = M.lerp(OVER_PIC_GAIN_LO, 1.0, at);
    var asym = M.lerp(OVER_PIC_SHOULDER_LO, OVER_PIC_SHOULDER_HI, at) * l0 * gn;
    L *= gn;
    if (!(asym > 1e-6)) return L;
    var knee = OVER_PIC_KNEE * asym;
    var span = asym - knee;
    if (L > knee && span > 1e-6) {
      L = knee + span * (1.0 - Math.exp(-(L - knee) / span));
    }
    return L;
  };

  // Relative per-channel radiance of the overcast deck at sin(elevation), with
  // every noise channel replaced by its mean. Multiply by this._overScale for
  // absolute HDR radiance.
  Sky.prototype._overcastShape = function (elevSin, out) {
    var vo = this._voidF > 0;
    var up = Math.max(elevSin, 0.0);
    // The same ramp the shader's oHor / stHor uses, so the two agree. A daylight
    // deck runs OVER_HORIZON_P; the enclosed profile keeps the storm deck's 3.2,
    // which is what it was solved against.
    var horiz = Math.exp(-up * (vo ? 3.2 : OVER_HORIZON_P));
    var hk = vo ? VOID_HORIZON_K : OVER_HORIZON_K;
    var ramp = 1.0 + (hk - 1.0) * horiz;
    var dMin = vo ? 1.0 : OVER_DECK_MIN;
    var dRng = vo ? 0.0 : OVER_DECK_RANGE;
    var k = dMin + dRng * STORM_MEAN_TRANS;
    // Mean of the shader's thin/thick hue mix at the mean thickness. Its
    // luminance is 0.984, i.e. essentially 1, but carrying it keeps the mirror
    // honest rather than approximately honest.
    var tw = vo ? 0.0 : 1.0;
    var refl = STORM_MEAN_THICK * (STORM_REFL_A - STORM_REFL_B * STORM_MEAN_THICK);
    var bounce = vo ? 0.0 : this._overBounceRel * refl * (0.60 + 0.40 * 0.5);
    // Mean of pow((cosT + 1)/2, p) over the sphere is exactly 1/(p+1).
    var sunLobe = vo ? 0.0 : this._overSunRel / (this._overSunP + 1.0) *
      (0.30 + 0.70 * STORM_MEAN_TRANS) * this._overSunUp;
    var hue = this._overHue, gh = this._overGndHue, sh = this._overSunHue;
    for (var c = 0; c < 3; c++) {
      var tint = 1.0 + tw * (OVER_TINT_MEAN[c] - 1.0);
      out[c] = hue[c] * ramp * k * tint + gh[c] * bounce + sh[c] * sunLobe;
    }
    return out;
  };
  // Mean of mix( (1.05,1.01,0.96), (0.92,0.96,1.08), STORM_MEAN_THICK ), i.e.
  // the shader literal evaluated at the mean thickness. Kept here rather than
  // recomputed so the two cannot drift.
  var OVER_TINT_MEAN = [
    1.05 + (0.92 - 1.05) * STORM_MEAN_THICK,
    1.01 + (0.96 - 1.01) * STORM_MEAN_THICK,
    0.96 + (1.08 - 0.96) * STORM_MEAN_THICK
  ];

  var _ovRad = [0, 0, 0];
  var _ovTmp = [0, 0, 0];
  // The deck chromaticity BEFORE the whiteout chroma expansion. The solar region
  // is derived from this rather than from the expanded hue - see
  // _applyOvercastAmbient.
  var _ovHue0 = [1, 1, 1];
  Sky.prototype._applyOvercastAmbient = function () {
    var of = M.saturate(this._overcastF);
    if (!(of > 0.001)) return;
    var vo = this._voidF > 0;
    var c, j;

    // ---- hues ---------------------------------------------------------------
    var ga = this.groundAlbedo;
    var gLum = 0.2126 * ga[0] + 0.7152 * ga[1] + 0.0722 * ga[2];
    var gMax = Math.max(ga[0], Math.max(ga[1], ga[2])) || 1;
    for (c = 0; c < 3; c++) this._overGndHue[c] = ga[c] / gMax;
    if (vo) {
      for (c = 0; c < 3; c++) {
        this._overHue[c] = VOID_HUE[c];
        this._overSunHue[c] = VOID_HUE[c];
        // The enclosed profile has no whiteout and no chroma expansion, so the
        // "unexpanded" hue is simply the hue. Written here as well as in the
        // branch below so nothing downstream can ever read a stale one.
        _ovHue0[c] = VOID_HUE[c];
      }
    } else {
      // The deck is a very slightly cool neutral pulled a sixth of the way
      // toward the hue of whatever it is sitting over. That single blend is
      // most of what stops snowbound and jungle - which share this preset -
      // from sharing a look: the same white ceiling reads faintly blue over a
      // snowfield and faintly green over wet canopy, exactly as it does in the
      // reference material, without either level needing its own constant.
      var hmx = 0;
      for (c = 0; c < 3; c++) {
        _ovTmp[c] = OVER_HUE[c] + (this._overGndHue[c] - OVER_HUE[c]) * 0.16;
        if (_ovTmp[c] > hmx) hmx = _ovTmp[c];
      }
      if (!(hmx > 1e-5)) hmx = 1;
      for (c = 0; c < 3; c++) this._overHue[c] = _ovTmp[c] / hmx;
      // ---- WHITEOUT CHROMA ---------------------------------------------------
      // Two corrections, both skipped outright (not lerped by zero - skipped)
      // when the ground is dark, so jungle is bit-identical.
      //
      // 1. THE RESONATOR IS CHROMATIC. _overcastEnergy already models the
      //    ground <-> cloud-base multiple bounce, 1/(1 - a*R), but it does it on
      //    LUMINANCE, as one scalar. Per channel over snow it is 1.995 / 2.067 /
      //    2.176 - the bounce compounds the ground's own spectral tilt every time
      //    round the loop, which is why a real snowfield under a real deck is
      //    blue rather than merely bright. Taken as a pure chromaticity (divided
      //    by its own max, and the luminance restored afterwards), so it cannot
      //    double-count the energy the scalar boost already carries.
      //
      // 2. CHROMA EXPANSION, same argument as RAY_CHROMA and measured on this
      //    preset: the deck was authored at B/R = 1.06 and PRINTED at B-R =
      //    +0.005 with a dome saturation of 0.006-0.012, because AgX over an
      //    auto-exposure metering a whiteout is a ~9:1 chroma compressor up
      //    there. Luminance-preserving about the hue's own luminance, so the
      //    deck's level, the numeric solve below, the frame mean and the meter
      //    are all untouched - it is a chromaticity rotation and nothing else.
      // Kept for the solar region, which is deliberately NOT expanded - see
      // below. Copied before the block so the two cannot get out of step.
      _ovHue0[0] = this._overHue[0];
      _ovHue0[1] = this._overHue[1];
      _ovHue0[2] = this._overHue[2];
      var wof = this._whiteoutF();
      if (wof > 0) {
        var hL0 = 0.2126 * this._overHue[0] + 0.7152 * this._overHue[1] +
                  0.0722 * this._overHue[2];
        var rmx = 0;
        for (c = 0; c < 3; c++) {
          _ovTmp[c] = 1.0 / (1.0 - M.clamp(ga[c] * OVER_CLOUD_R, 0.0, OVER_BOUNCE_MAX));
          if (_ovTmp[c] > rmx) rmx = _ovTmp[c];
        }
        if (!(rmx > 1e-5)) rmx = 1;
        for (c = 0; c < 3; c++) {
          this._overHue[c] *= 1.0 + (_ovTmp[c] / rmx - 1.0) * wof;
        }
        // Restore the luminance the max-normalised hue had, so the balance
        // between the deck term and the bounce / solar terms in _overcastShape
        // is exactly what it was.
        var hL1 = 0.2126 * this._overHue[0] + 0.7152 * this._overHue[1] +
                  0.0722 * this._overHue[2];
        if (hL1 > 1e-5) {
          var hK = hL0 / hL1;
          for (c = 0; c < 3; c++) this._overHue[c] *= hK;
        }
        var cx = 1.0 + (OVER_CHROMA - 1.0) * wof;
        for (c = 0; c < 3; c++) {
          this._overHue[c] = Math.max(0.0, hL0 + (this._overHue[c] - hL0) * cx);
        }
      }
      // The solar region keeps some of the sun's own colour but a deck is a
      // very effective diffuser, so it arrives most of the way to the DECK'S
      // OWN hue - not to white, and not 55% of the way but 72%.
      //
      // This is the measured half of the "overcast prints warm" finding. At
      // snowbound's 11 degree sun through turbidity 0.09 the normalised
      // transmittance is about (1.00, 0.74, 0.34); blending that only 55% toward
      // white left the solar region at (1.00, 0.88, 0.70) - a broad, warm,
      // p=6 lobe carrying 0.55 of the zenith radiance and covering most of the
      // sky a hero framing sees. The deck underneath it is authored cool, the
      // brief asks for white/pale-blue, and the frame still measured warm of
      // neutral (R 0.784 against G/B 0.779) because this term, not the deck, was
      // setting the white balance. Converging on the deck's chromaticity instead
      // of on white is also the physically honest version: what leaves the
      // underside of a stratus deck near the sun is deck light, faintly warmed.
      //
      // It converges on the UNEXPANDED deck hue (_ovHue0), i.e. on exactly the
      // triple the last round measured and tuned, and that exemption is doing
      // real work rather than being conservatism. A whiteout that is uniformly
      // blue has no warm end at all, and analyze.py measures precisely that:
      // grade_split (warm highlights over cool shadows) fell to +0.0070 on the
      // overview with the solar region cooled along with the deck, i.e. one
      // hundredth of the way from passing to the "no meaningful colour grade" red
      // flag. Leaving the one genuinely warm region in the sky warm - the part of
      // the deck the sun is actually behind, which is also the part that lands on
      // the snow's lit faces - is what gives the grade something to split
      // against, and it is the physically right answer too: transmitted sunlight
      // is warmer than multiply-scattered deck light whatever the deck's own
      // chromaticity is.
      var T = transmittanceRaw(0.0, Math.max(this.sunWorldDirection.y, 0.02), _ovTmp);
      var tmx = Math.max(T[0], Math.max(T[1], T[2])) || 1;
      for (c = 0; c < 3; c++) {
        this._overSunHue[c] = M.lerp(T[c] / tmx, _ovHue0[c], 0.72);
      }
    }
    // Shape coefficients the mirror and the shader both consume.
    this._overSunUp = vo ? 0 : M.saturate(this.sunWorldDirection.y / 0.10);
    this._overBounceRel = vo ? 0 : OVER_BOUNCE_K * gLum;
    this._overSunP = M.lerp(OVER_SUN_P_THIN, OVER_SUN_P, M.saturate(this._overThick));
    this._overSunRel = vo ? 0
      : M.lerp(OVER_SUN_REL_THIN, OVER_SUN_REL, M.saturate(this._overThick));

    // ---- level --------------------------------------------------------------
    // Normalise the SHAPE so its cosine-weighted hemispherical mean lands
    // exactly on E/pi, whatever the shape constants happen to be. Solved
    // numerically rather than algebraically on purpose: the shape now has four
    // terms, two of them functions of the ground albedo, and a closed form
    // would silently stop being true the first time one of them was retuned.
    var E = this._overcastEnergy();
    var EL = 28, mean = 0, w = 0, s, el, cw;
    for (j = 0; j < EL; j++) {
      el = (PI * 0.5) * (j + 0.5) / EL;
      s = Math.sin(el); cw = Math.cos(el) * s;
      this._overcastShape(s, _ovRad);
      mean += (0.2126 * _ovRad[0] + 0.7152 * _ovRad[1] + 0.0722 * _ovRad[2]) * cw;
      w += cw;
    }
    if (w > 0) mean /= w;
    var scale = (mean > 1e-6) ? (E / PI) / mean : 0;
    if (!isFinite(scale) || scale < 0) scale = 0;
    this._overScale = scale;
    this._overE = E;
    this._overGLum = gLum;

    // ---- what the scene is lit BY -------------------------------------------
    // Two integrals of the same deck: the cosine-weighted hemispherical mean
    // (the irradiance it delivers) and a zenith-weighted one (the strip of sky
    // a surface down between trunks or dachas actually sees). Identical
    // weighting to the clear-sky and storm paths, so the three cannot disagree
    // about what "fill" means.
    var ambR = 0, ambG = 0, ambB = 0, ambW = 0;
    var fillR = 0, fillG = 0, fillB = 0, fillW = 0;
    for (j = 0; j < EL; j++) {
      el = (PI * 0.5) * (j + 0.5) / EL;
      s = Math.sin(el); cw = Math.cos(el) * s;
      this._overcastShape(s, _ovRad);
      ambR += _ovRad[0] * cw; ambG += _ovRad[1] * cw; ambB += _ovRad[2] * cw;
      ambW += cw;
      var fw = Math.cos(el) * Math.pow(s, 3.0);
      fillR += _ovRad[0] * fw; fillG += _ovRad[1] * fw; fillB += _ovRad[2] * fw;
      fillW += fw;
    }
    if (ambW > 0) { ambR /= ambW; ambG /= ambW; ambB /= ambW; }
    if (fillW > 0) { fillR /= fillW; fillG /= fillW; fillB /= fillW; }
    ambR *= scale; ambG *= scale; ambB *= scale;
    fillR *= scale; fillG *= scale; fillB *= scale;
    var lum = 0.2126 * fillR + 0.7152 * fillG + 0.0722 * fillB;

    this.ambientColor.setRGB(
      M.lerp(this.ambientColor.r, ambR, of),
      M.lerp(this.ambientColor.g, ambG, of),
      M.lerp(this.ambientColor.b, ambB, of));

    var fmx = Math.max(fillR, Math.max(fillG, fillB)) || 1;
    this.skyColor.setRGB(
      M.lerp(this.skyColor.r, fillR / fmx, of),
      M.lerp(this.skyColor.g, fillG / fmx, of),
      M.lerp(this.skyColor.b, fillB / fmx, of));

    this._overcastShape(1.0, _ovRad);
    var zmx = Math.max(_ovRad[0], Math.max(_ovRad[1], _ovRad[2])) || 1;
    this.zenithColor.setRGB(
      M.lerp(this.zenithColor.r, _ovRad[0] / zmx, of),
      M.lerp(this.zenithColor.g, _ovRad[1] / zmx, of),
      M.lerp(this.zenithColor.b, _ovRad[2] / zmx, of));

    // The lower hemisphere of the hemisphere light is the GROUND, and under an
    // overcast that is the only place a hue can come from at all - the deck
    // itself is neutral by construction. Snow bounces near-white, a jungle
    // floor bounces green, desert hardstanding bounces warm.
    this.groundColor.setRGB(
      M.lerp(this.groundColor.r, this._overGndHue[0], of),
      M.lerp(this.groundColor.g, this._overGndHue[1], of),
      M.lerp(this.groundColor.b, this._overGndHue[2], of));

    this.fillRadiance = M.lerp(this.fillRadiance, lum, of);
    this.ambientIntensity = M.clamp(this.fillRadiance * PI * 1.36, 0.035, 0.95);

    this._overcastShape(0.02, _ovRad);
    this.horizonColor.setRGB(
      M.lerp(this.horizonColor.r, _ovRad[0] * scale, of),
      M.lerp(this.horizonColor.g, _ovRad[1] * scale, of),
      M.lerp(this.horizonColor.b, _ovRad[2] * scale, of));

    // ---- inscatter ----------------------------------------------------------
    // Authored against the GROUND, not against keyRef, and the caps upstream
    // are deliberately overridden rather than respected. keyRef measures a
    // mid-grey card in the KEY, and under a full deck the key is 20% of a low
    // sun - so capping the haze against it would drive the far field to black
    // in the one preset whose whole point is that the far field dissolves.
    //
    // Over snow (albedo 0.87) these land the haze within a few per cent of the
    // snow itself, so distance dissolves geometry into white with no value step
    // at all. Over a 0.10-albedo jungle floor the identical expressions land it
    // at ~2.3x the foliage: mist between trunks rather than a white wall. The
    // floored albedo is what makes one set of numbers do both.
    var l0 = E / PI;
    var aEff = M.clamp(gLum, OVER_ALBEDO_FLOOR, 1.0);
    var mistLum = vo ? VOID_FOG_K * l0 : OVER_FOG_K * aEff * l0;
    var sunLum = vo ? VOID_FOG_K * l0 : OVER_FOG_SUN_K * aEff * l0;
    var gndLum = vo ? VOID_FOG_K * 0.80 * l0 : OVER_FOG_GND_K * gLum * l0;
    var mix = vo ? 0.0 : OVER_FOG_GND_MIX;

    // ---- AERIAL-PERSPECTIVE CONVERGENCE (whiteout only) ---------------------
    // "A fraction of the ground albedo" is the right reference for mist between
    // trunks and the wrong one for a blizzard, and the finding measured exactly
    // how wrong: fully-veiled geometry (far pines at 100-140 m, over 96% fog)
    // landed at L 0.676 against a sky at 0.742 - a 0.066 luminance ledge that no
    // distance closes, so the treeline read as a flat grey cut-out pasted onto a
    // brighter sky instead of dissolving into it.
    //
    // At full whiteout the inscatter is therefore driven from the value the DOME
    // RESOLVES TO instead: _overcastPictureLum is the deck's own displayed
    // luminance, shoulder included, so the sky, the horizon band (which blends
    // toward this very colour) and geometry at infinite distance all land on one
    // number by construction rather than by three expressions agreeing.
    //
    // Sampled at the zenith because that is the deck's own reference level - the
    // horizon ramp and the turbidity band are both expressed as fractions of it,
    // and picking a low elevation would chase the band that is itself chasing
    // this. OVER_CONV_K then absorbs the one known approximation in the mirror
    // (the solar lobe at its spherical mean rather than its real angular shape);
    // see the constant.
    //
    // Skipped outright when the ground is dark, so jungle's "2.3x the foliage"
    // is bit-identical.
    if (!vo) {
      var wof2 = this._whiteoutF();
      if (wof2 > 0) {
        var skyL = this._overcastPictureLum(1.0) * OVER_CONV_K;
        if (skyL > 0) {
          mistLum = M.lerp(mistLum, skyL, wof2);
          sunLum = M.lerp(sunLum, skyL * (OVER_FOG_SUN_K / OVER_FOG_K), wof2);
        }
      }
    }
    for (c = 0; c < 3; c++) {
      _ovTmp[c] = this._overHue[c] + (this._overGndHue[c] - this._overHue[c]) * mix;
    }
    this._overFogColor(this._fogSky, _ovTmp, mistLum, of);
    // ---- the SUNWARD lobe is not the same colour as the anti-sun one ---------
    // gbFogSun and gbFogSky exist precisely so the air has a warm side and a cool
    // side, and under this preset they were being handed the same triple - so the
    // whole medium was one hue and there was nothing for the grade to split.
    // Measured on snowbound's hero framing: the shadow tint and the highlight
    // tint came back identical to three decimal places ([-0.017,-0.003,0.019]
    // against [-0.018,-0.002,0.020]) and grade_split sat on zero.
    //
    // The sunward lobe is inscatter from light that came through the deck NEAR
    // THE SUN, so its chromaticity is the solar region's, not the deck's: warmer,
    // by exactly the amount the transmittance says. The anti-sun lobe keeps the
    // expanded blue. That is one authored fix producing both halves of the axis
    // the brief asks for - "white / pale blue" air with a warm sun side - across
    // the 60% of pixels the medium covers.
    //
    // _ovHue0 and _overSunHue are identical to _overHue when there is no
    // whiteout, so jungle and the enclosed profile take the same triple they
    // always did.
    // The blend starts from the deck's own (expanded) chromaticity and moves a
    // fraction of the way toward the solar region's, so the sunward lobe stays
    // recognisably the same air as the anti-sun one - just warmer. Basing it on
    // the UNEXPANDED hue instead, which was the first attempt, throws the whole
    // expansion away on that lobe the moment the fraction leaves zero, and
    // measured a third of the frame's saturation for it.
    var sunMix = OVER_FOG_SUN_MIX * this._whiteoutF();
    for (c = 0; c < 3; c++) {
      _ovTmp[c] = this._overHue[c] + (this._overSunHue[c] - this._overHue[c]) * sunMix;
      _ovTmp[c] += (this._overGndHue[c] - _ovTmp[c]) * mix;
    }
    this._overFogColor(this._fogSun, _ovTmp, sunLum, of);
    this._overFogColor(this._fogGnd, this._overGndHue, gndLum, of);
  };

  // Blend one inscatter triple toward `hue` at the given luminance. Same job as
  // _stormFogColor without the sodium warming, which has no meaning by day.
  Sky.prototype._overFogColor = function (dst, hue, targetLum, f) {
    var l = 0.2126 * hue[0] + 0.7152 * hue[1] + 0.0722 * hue[2];
    var k = Math.max(targetLum, 0) / Math.max(l, 1e-6);
    if (!isFinite(k)) return;
    for (var c = 0; c < 3; c++) dst[c] = dst[c] + (hue[c] * k - dst[c]) * f;
  };

  // --------------------------------------------------------------------------
  // Ground albedo. Feeds the LUT's own ground-bounce integral, the fog's
  // downward inscatter and, under overcast, the deck's level, its hue and how
  // hard the picture is compressed.
  //
  // Accepts a scalar (grey), an [r,g,b] array, or anything with .r/.g/.b
  // (THREE.Color included). Values are LINEAR reflectances, not sRGB: fresh
  // snow is ~0.87, dry concrete ~0.30, wet asphalt ~0.06.
  // --------------------------------------------------------------------------
  Sky.prototype.setGroundAlbedo = function (v) {
    try {
      if (v == null) return;
      var a = this.groundAlbedo, n0, n1, n2;
      if (typeof v === 'number') {
        if (!isFinite(v)) return;
        n0 = n1 = n2 = v;
      } else if (typeof v.length === 'number' && v.length >= 3) {
        n0 = +v[0]; n1 = +v[1]; n2 = +v[2];
      } else if (isFinite(v.r) && isFinite(v.g) && isFinite(v.b)) {
        n0 = v.r; n1 = v.g; n2 = v.b;
      } else { return; }
      if (!isFinite(n0) || !isFinite(n1) || !isFinite(n2)) return;
      // 0.98 rather than 1.0: an albedo of exactly 1 makes the ground <-> cloud
      // bounce series in _overcastEnergy diverge, and nothing real is white.
      n0 = M.clamp(n0, 0.005, 0.98);
      n1 = M.clamp(n1, 0.005, 0.98);
      n2 = M.clamp(n2, 0.005, 0.98);
      if (a[0] === n0 && a[1] === n1 && a[2] === n2) return;
      a[0] = n0; a[1] = n1; a[2] = n2;
      if (this._built) {
        this._reLut();
        this._pushUniforms();
        this._regenerateEnvironment();
      }
    } catch (e) { GAME.logError('sky.setGroundAlbedo', e); }
  };

  // ==========================================================================
  // Build
  //
  // EVERY STAGE IS INDEPENDENTLY GUARDED, and that is a fix rather than a
  // stylistic preference. During round 3 a level agent's captures twice failed
  // with a ReferenceError raised inside _buildLut, and BOTH TIMES the whole
  // frame lost its exposure, its grade and its fog - far more than the sky.
  //
  // The mechanism was the single try/catch this used to be. _buildLut is the
  // second of six steps, so one throw there skipped _pushUniforms (the gbFog*
  // uniforms keep their constructed zeros, so gbFogA.x = 0 and every material
  // in the game silently falls back to three's stock FogExp2 branch),
  // _installScene (no scene.fog at all, so USE_FOG is never even defined, and
  // the dome and the dust field are never added to the scene), _built = false
  // (so every later setFog / setTimeOfDay / setWeather call lands its state and
  // returns without applying it - main.js's applyEnv pass runs AFTER build, so
  // the level's entire declarative profile evaporates) and _regenerateEnvironment
  // (scene.environment stays null, so every metal and every wet surface in the
  // level has nothing to reflect). postfx then meters a black frame and opens
  // its exposure all the way, which is what "exposure and grade were wrong" is.
  //
  // Nothing about that cascade is inherent. The LUT and the scene installation
  // are independent, the uniform push does not need the LUT to have succeeded
  // (the constructor already ran _solar and _computeLightingTerms, so a sane
  // sun, a sane fog schedule and a sane published ambient exist before build is
  // even called), and _built means "this instance has finished building", not
  // "every stage succeeded". So each stage stands on its own and a failure
  // costs exactly that stage.
  //
  // Confirmed by inspection for the specific report: `twiF` is declared with
  // `var` at the top of _buildLut and read only at two points inside the same
  // function body, so `var` hoisting puts it in scope for the whole function
  // and no path through this file can reference it out of scope. The observed
  // "twiF is not defined" was a concurrent agent's mid-edit read of the file,
  // and it is the CONSEQUENCE that is fixed here, not the cause.
  // ==========================================================================
  Sky.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    var self = this;
    // A named stage, so a failure says which one and the rest still run.
    function stage(name, fn) {
      try { fn(); return true; }
      catch (e) { GAME.logError('sky.build.' + name, e); return false; }
    }

    stage('lutTextures', function () { self._makeLutTextures(); });
    stage('dome', function () { self._makeDome(); });
    // Resolve the weather BEFORE the first LUT build, so the derived ambient,
    // every fog colour and the IBL are all generated once, in the right
    // condition, instead of being generated clear and then thrown away.
    stage('weather', function () { self._resolveWeather(ctx); });
    if (GAME.yieldFrame) await GAME.yieldFrame();

    // Latched on failure, so a broken integral is reported ONCE with its stage
    // name and every later setter quietly keeps the last good LUT instead of
    // re-entering it and pushing another entry onto GAME.errors (which util.js
    // never caps). See _reLut.
    if (!stage('lut', function () { self._buildLut(); })) this._lutFailed = true;
    // Runs even if the LUT threw: _scheduleHaze and the published sun/ambient
    // are already valid from the constructor, so this is what keeps the frame's
    // fog and haze correct when the atmosphere integral is the thing that broke.
    stage('uniforms', function () { self._pushUniforms(); });
    if (GAME.yieldFrame) await GAME.yieldFrame();

    stage('dust', function () { self._makeDust(ctx); });
    // The most important one to reach: without scene.fog three never defines
    // USE_FOG, so the patched chunks have nowhere to land and NO material in
    // the game is fogged - a whole-frame failure caused by a sky that could not
    // integrate its own dome.
    stage('scene', function () { self._installScene(ctx); });
    // 'none' only: pulls the dome out of the scene and puts the same dim
    // neutral behind it as a background, so an opening onto nothing prints a
    // void rather than the renderer's black clear colour. A no-op for every
    // other preset.
    stage('voidVis', function () { self._applyVoidVisibility(); });
    // Set unconditionally. It means "build() has run", and the public setters
    // check it to decide whether to APPLY a change or merely record it - so
    // leaving it false after a partial failure is what silently discarded a
    // level's whole env profile.
    this._built = true;

    stage('env', function () { self._regenerateEnvironment(); });
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
      uFlashDir: { value: new THREE.Vector3(0.42, 0.62, -0.66).normalize() },
      // ---- overcast / enclosed. uOver.x = 0 makes the whole block dead code.
      // The picture shoulder defaults to the identity (asymptote out of range),
      // which is also what _regenerateEnvironment forces while it captures the
      // probe - see uDay for the same split and the measurements behind it.
      uOver: { value: new THREE.Vector4(0, 1, 0, 0) },
      uOverB: { value: new THREE.Vector4(0, OVER_SUN_P, 1, 0) },
      uOverPic: { value: new THREE.Vector4(1.0, 1e9, 2e9, 1.0) },
      uOverSun: { value: new THREE.Vector3(0, 0, 0) },
      uOverGnd: { value: new THREE.Vector3(0, 0, 0) },
      // x squall amount, y deck horizon e-fold, z haze-band e-fold (0 = take
      // the clear-sky literal), w horizon band strength. All zero here, so a
      // clear or storm sky evaluates exactly the expressions it always has.
      uOverC: { value: new THREE.Vector4(0, 0, 0, 0) },
      // Two-lobe haze tint, the dome's half of setFog({tint, tintAmount}).
      // w = 0 makes the block dead code.
      uHazeTint: { value: new THREE.Vector4(1, 1, 1, 0) }
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
      // Seeded from the instance, not from a literal, because setDustGain() is
      // legal before build() and _makeDust runs several steps into it. Both
      // default to the values the field has always had (1.0 / 0.0).
      uGain: { value: this._dustGain },
      uDownFade: { value: this._dustDown },
      uNearFade: { value: this._dustNear },
      uSubPx: { value: this._dustSubPx },
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
    // ---- the opacity cap, under a whiteout ----------------------------------
    // A cap exists so a distant building still reads as a SILHOUETTE (see
    // this.fog.maxOpacity), which is right for a street and wrong for a
    // blizzard: at 0.93 seven per cent of a near-black conifer survives however
    // thick the air gets, i.e. a permanent value step that no distance closes,
    // in the one preset whose brief explicitly asks distant geometry to dissolve
    // into white. Gated on the shared whiteout weight, so it is exactly the
    // authored cap for market, harbor, the enclosed profile and jungle.
    var woF = this._whiteoutF();
    if (woF > 0) {
      this._fogB[0] = M.saturate(M.lerp(this._fogB[0], OVER_FOG_MAX_OPACITY_HI,
        woF * M.saturate(this._overcastF)));
    }
    this._fogB[1] = M.clamp(this._fogParam('mieG'), 0.0, 0.92);
    this._fogB[2] = Math.max(0.0, this._fogParam('glowGain'));
    this._fogB[3] = M.saturate(this._fogParam('desaturate'));
    this._fogDir[0] = this.sunDirection.x;
    this._fogDir[1] = this.sunDirection.y;
    this._fogDir[2] = this.sunDirection.z;
    // Two-lobe inscatter tint. Resolved every push so setFog() needs no special
    // case, and inert (amount 0, hue white) unless a level authored one.
    var tintOn = false;
    var ta = M.saturate(isFinite(this.fog.tintAmount) ? this.fog.tintAmount : 0);
    if (ta > 0 && readRGB(this.fog.tint, _tintTmp)) {
      var tmax = Math.max(_tintTmp[0], Math.max(_tintTmp[1], _tintTmp[2]));
      if (tmax > 1e-4) {
        // Stored as a pure chromaticity (max channel 1). The shader rescales it
        // to whatever luminance the atmosphere solved for that direction, so a
        // level authoring a tint can never accidentally move the haze's level.
        this._fogTint[0] = _tintTmp[0] / tmax;
        this._fogTint[1] = _tintTmp[1] / tmax;
        this._fogTint[2] = _tintTmp[2] / tmax;
        this._fogTint[3] = ta;
        tintOn = true;
      }
    }
    if (!tintOn) {
      this._fogTint[0] = 1; this._fogTint[1] = 1; this._fogTint[2] = 1;
      this._fogTint[3] = 0;
    }

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
      // Horizon haze blend. 0.12 is the constructed value and what every
      // clear-sky and storm caller has always run, so this line is an exact
      // no-op for market and harbor. It is raised only under a daylight
      // overcast, where the narrow window in which the deck fades out at the
      // skyline (see stCov) would otherwise reveal a strip of clear atmosphere
      // under a total cloud cover - and at turbidity 0.09 that strip is an
      // ochre band, i.e. a patch of desert in a blizzard.
      u.uMode.value.y = (this._overcastF > 0 && !(this._voidF > 0)) ? OVER_HAZE_MIX : 0.12;
      u.uMode.value.w = MILKYWAY_LUM * SKY_SCALE;
      u.uHazeSun.value.set(this._fogSun[0], this._fogSun[1], this._fogSun[2]);
      u.uHazeSky.value.set(this._fogSky[0], this._fogSky[1], this._fogSky[2]);
      // The dome's horizon haze is the same colour the fog chunk paints on
      // geometry, so it takes the same two-lobe tint or the sky and the far
      // field would disagree about their own hue at the skyline. Amount 0 for
      // every existing caller.
      if (u.uHazeTint) {
        u.uHazeTint.value.set(this._fogTint[0], this._fogTint[1],
          this._fogTint[2], this._fogTint[3]);
      }
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
        u.uCloud.value.y = CLOUD_AMOUNT *
          (1.0 - M.saturate(Math.max(this._stormF, this._overcastF)));
        u.uCloud.value.z = CLOUD_BEER;
      }

      // ---- storm deck ------------------------------------------------------
      if (u.uStorm) {
        var sf = M.saturate(this._stormF);
        var ovf = M.saturate(this._overcastF);
        if (ovf > 0) {
          // Same deck geometry, a totally different coverage regime: an
          // overcast is TOTAL. Any hole at all would show the clear atmosphere
          // behind it, so the threshold goes well below the noise field's floor
          // rather than merely low. Written as its own branch so the harbor
          // line below is untouched.
          u.uStorm.value.set(ovf,
            this._voidF > 0 ? OVER_COVER : OVER_COVER,
            this._voidF > 0 ? 0.0 : OVER_DETAIL,
            this._windAngle);
        } else {
          u.uStorm.value.set(sf, STORM_COVER, STORM_DETAIL, this._windAngle);
        }
        // Cleared here and re-filled by _pushOvercast, which returns
        // immediately with no overcast - so a clear or storm sky always sees
        // (0,0,0,0) and every expression that reads it takes the branch or the
        // literal fallback it had before this uniform existed.
        if (u.uOverC) u.uOverC.value.set(0, 0, 0, 0);
        if ((sf > 0 || ovf > 0) && this._stormTex && u.uStormTex) {
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
        // Last, so it can overwrite the two deck-ramp uniforms the storm block
        // above always writes. Returns immediately with no overcast, which is
        // every frame of levels 1 and 2.
        this._pushOvercast(u);
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

  // --------------------------------------------------------------------------
  // Publish the solved overcast deck. Everything here was computed once, in
  // _applyOvercastAmbient, off the same shape the CPU mirror integrates - so
  // the deck the player is shown and the deck the scene is lit by are the same
  // object by construction rather than by two agreeing sets of constants. That
  // is the failure the storm deck's CPU mirror was rewritten to fix (it had
  // drifted 1.74x), and this path is built not to be able to have it.
  // --------------------------------------------------------------------------
  Sky.prototype._pushOvercast = function (u) {
    var of = M.saturate(this._overcastF);
    if (!(of > 0)) return;
    var vo = this._voidF > 0;
    var sc = this._overScale;
    if (!isFinite(sc) || sc < 0) sc = 0;
    var h = this._overHue;
    var hk = vo ? VOID_HORIZON_K : OVER_HORIZON_K;
    u.uStormHigh.value.set(h[0] * sc, h[1] * sc, h[2] * sc);
    u.uStormLow.value.set(h[0] * sc * hk, h[1] * sc * hk, h[2] * sc * hk);
    if (u.uOver) {
      u.uOver.value.set(of,
        vo ? 1.0 : OVER_DECK_MIN,
        vo ? 0.0 : OVER_DECK_RANGE,
        vo ? 0.0 : OVER_BAND);
    }
    if (u.uOverB) {
      u.uOverB.value.set(vo ? 0.0 : OVER_CELL, this._overSunP || OVER_SUN_P, 1.0,
        vo ? 0.0 : OVER_SQUALL_TINT);
    }
    if (u.uOverC) {
      // Turbidity, remapped across the useful range. snowbound's 0.09 lands
      // 0.875 (a dense band reaching ~25 degrees), jungle's 0.07 lands 0.625,
      // a clean alpine 0.02 lands 0. One expression, two very different skies.
      var tf = M.saturate((MIE_AOD - OVER_TURB_LO) / OVER_TURB_SPAN);
      u.uOverC.value.set(
        vo ? 0.0 : OVER_SQUALL,
        vo ? 3.2 : OVER_HORIZON_P,
        vo ? 0.0 : M.lerp(OVER_BAND_FALL_LO, OVER_BAND_FALL_HI, tf),
        vo ? 0.0 : M.lerp(OVER_BAND_K_LO, OVER_BAND_K_HI, tf));
    }
    if (u.uOverGnd) {
      var gb = vo ? 0 : this._overBounceRel * sc;
      var gh = this._overGndHue;
      u.uOverGnd.value.set(gh[0] * gb, gh[1] * gb, gh[2] * gb);
    }
    if (u.uOverSun) {
      var sb = vo ? 0 : (this._overSunRel || 0) * sc * (this._overSunUp || 0);
      var sh = this._overSunHue;
      u.uOverSun.value.set(sh[0] * sb, sh[1] * sb, sh[2] * sb);
    }
    if (u.uOverPic) {
      // Asymptote as a multiple of the radiance a mid-albedo ground reaches
      // under the SAME deck, which is the only reference that gets both a
      // snowfield and a jungle floor right with one number - see the header.
      // The floor on the albedo is what stops a very dark ground asking for a
      // shoulder six times under the deck's own mean and crushing the sky to
      // mud. Void gets the identity: at 0.006 radiance there is nothing to
      // compress and a shoulder would only flatten the one gradient a metal in
      // a dark tunnel has to work with.
      if (vo) {
        u.uOverPic.value.set(1.0, 1e9, 2e9, 0.0);
      } else {
        var l0 = Math.max(this._overE, 0) / PI;
        var at = M.saturate((this._overGLum - OVER_ALBEDO_LO) / OVER_ALBEDO_SPAN);
        var gn = M.lerp(OVER_PIC_GAIN_LO, 1.0, at);
        var asym = M.lerp(OVER_PIC_SHOULDER_LO, OVER_PIC_SHOULDER_HI, at) * l0 * gn;
        if (!(asym > 1e-6)) { u.uOverPic.value.set(1.0, 1e9, 2e9, 1.0); }
        else { u.uOverPic.value.set(gn, OVER_PIC_KNEE * asym, asym, 1.0); }
      }
    }
  };

  // --------------------------------------------------------------------------
  // 'none': there is no sky, so the dome comes out of the scene entirely.
  //
  // The scene background takes its place at the SAME dim neutral the probe is
  // built from, which matters more than it looks: with the dome gone, any pixel
  // with no geometry behind it would otherwise print the renderer's clear
  // colour, which is pure black - both an ARCHITECTURE 7.6 violation and, in a
  // level where a ventilation shaft or a collapsed ceiling can legitimately see
  // "nothing", indistinguishable from a hole in the render.
  //
  // Fully reversible, and it only ever touches a background this module set
  // itself, so a level that installs its own is left alone.
  // --------------------------------------------------------------------------
  Sky.prototype._applyVoidVisibility = function () {
    try {
      var vo = this._voidF > 0;
      if (this.mesh) this.mesh.visible = !vo;
      var scn = this.ctx && this.ctx.scene;
      if (!scn) return;
      if (vo) {
        if (!this._voidBg) this._voidBg = new THREE.Color();
        this._voidBg.setRGB(
          Math.max(this._fogSky[0], 0), Math.max(this._fogSky[1], 0),
          Math.max(this._fogSky[2], 0));
        scn.background = this._voidBg;
      } else if (this._voidBg && scn.background === this._voidBg) {
        scn.background = null;
      }
    } catch (e) { GAME.logError('sky.voidVisibility', e); }
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
    // Same argument, same fix, for the overcast deck's own shoulder. The deck
    // is applied AFTER uDay in the shader (it replaces the dome rather than
    // being blended under it), so it never sees uDay at all and needs its own
    // switch - without which an overcast level would lose a stop and a half of
    // skylight fill as a side effect of a change that was only ever about what
    // the sky prints as.
    var oldPic = (this._skyUniforms && this._skyUniforms.uOverPic)
      ? this._skyUniforms.uOverPic.value.clone() : null;

    try {
      if (this._skyUniforms) {
        this._skyUniforms.uMode.value.x = 0.0;
        this._skyUniforms.uDay.value.set(1.0, 1e9, 2e9, this._skyUniforms.uDay.value.w);
        if (oldPic) {
          this._skyUniforms.uOverPic.value.set(1.0, 1e9, 2e9, oldPic.w);
        }
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
        if (oldPic) this._skyUniforms.uOverPic.value.copy(oldPic);
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
      if (!isFinite(t)) {
        skyWarn('setTimeOfDay', String(t) + ' is not a finite number and was ' +
          'IGNORED (still at ' + this.timeOfDay + '). 0 = solar midnight, ' +
          '0.25 = sunrise, 0.5 = noon, 0.75 = sunset.');
        return;
      }
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
        this._reLut();
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
   *   sky.setWeather('overcast') a FULL DAYLIGHT CLOUD DECK - even, bright but
   *                              not blown, soft and directionless, with real
   *                              internal structure. The sun becomes a diffuse
   *                              region rather than a disc. Its level, its hue
   *                              and how hard it is compressed for the picture
   *                              all track the ground albedo, so the same
   *                              preset gives snowbound a whiteout and jungle a
   *                              humid haze. See the DAYLIGHT OVERCAST header.
   *   sky.setWeather('drizzle')  the same deck, thinner: more light through it,
   *                              a tighter and brighter solar region, less haze.
   *   sky.setWeather('none')     NO SKY AT ALL, for fully enclosed levels. The
   *                              dome is removed from the scene and the sun and
   *                              moon are switched off outright, but the IBL is
   *                              NOT null - it is a very dim, flat, neutral
   *                              probe, because an enclosed level with no
   *                              environment renders every metal as a black
   *                              hole and every wet floor as matte paint.
   *
   * An unrecognised preset degrades to 'clear' rather than throwing.
   *
   * Safe to call before build() (the state is applied and build() picks it up)
   * and safe to call repeatedly with the same value (it returns immediately
   * rather than regenerating the environment). Never throws.
   *
   * This is the ONLY door into any of the deck paths. Nothing in this module
   * changes behaviour without it, which is why level 1 is guaranteed unchanged
   * and why level 2 - which asks for 'storm', a name no other preset touches -
   * cannot be moved by anything added here.
   */
  Sky.prototype.setWeather = function (preset) {
    try {
      var name = (typeof preset === 'string') ? preset.toLowerCase() : 'clear';
      var f = 0, ov = 0, vd = 0, thick = 1.0;
      if (name === 'storm') f = 1.0;
      else if (name === 'overcast') { ov = 1.0; thick = 1.0; }
      else if (name === 'drizzle') { ov = 1.0; thick = 0.62; }
      else if (name === 'none' || name === 'void' || name === 'enclosed' ||
               name === 'interior' || name === 'underground') {
        name = 'none'; ov = 1.0; vd = 1.0; thick = 1.0;
      } else {
        // Same silent-drop class as an unknown setFog key, and worse in effect:
        // a misspelt preset does not fail, it quietly returns the market's
        // clear golden-hour sky, which is a plausible-looking frame and
        // therefore very hard to notice.
        if (name !== 'clear') {
          skyWarn('setWeather', 'unknown preset "' + preset + '" - fell back to ' +
            '"clear" (the market\'s golden-hour sky). Recognised: clear, storm, ' +
            'overcast, drizzle, none (aliases: void, enclosed, interior, ' +
            'underground).');
        }
        name = 'clear';
      }

      if (this.weatherPreset === name && this._built) return;
      this.weatherPreset = name;
      this._stormF = f;
      this._overcastF = ov;
      this._voidF = vd;
      this._overThick = thick;
      this.enclosed = vd > 0;
      // The void deck is flat, textureless and structure-free by construction
      // (deckRange, band, cell and detail are all zero, and the coverage
      // threshold sits below the field's floor), so it never reads the noise
      // texture in a way that could change its output - which is worth half a
      // second of load time to metro and bunker.
      if (f > 0 || (ov > 0 && vd <= 0)) this._makeStormTexture();

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
      this._reLut();
      this._pushUniforms();
      // Depends on _fogSky, which _buildLut -> _deriveAmbient has just written.
      this._applyVoidVisibility();
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
   *
   * Levels 3-10 additionally carry a DECLARATIVE env profile
   * (levelDef.env = {timeOfDay, sky, turbidity, ...}) which main.js applies
   * through the public API after every system has built. Reading it here as
   * well is not a duplicate: main.js's pass necessarily happens after
   * lighting.js has already built against whatever sun this module happened to
   * be holding, and after build() has already generated a LUT, an ambient set
   * and a PMREM probe for the wrong condition. Resolving it BEFORE the first
   * LUT means the level's very first frame is correct and nothing downstream
   * has to be regenerated - and because setWeather()/setTurbidity()/
   * setTimeOfDay() all no-op when handed a value they already hold, main.js's
   * later pass costs nothing. market and harbor carry env:null, so not one line
   * of this executes for them.
   */
  Sky.prototype._resolveWeather = function (ctx) {
    try {
      this._resolveEnvProfile(ctx);
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
      if (!want && ctx && ctx.levelDef && ctx.levelDef.env &&
          typeof ctx.levelDef.env.sky === 'string') {
        want = ctx.levelDef.env.sky;
      }
      if (!want && ctx && ctx.levelId === 'harbor') want = 'storm';
      if (!want) return;
      this._pendingWeather = null;
      // Not setWeather(): _built is still false, so this only lands the state
      // and lets build()'s own _buildLut / _pushUniforms / environment pass
      // pick it up. Calling the public method here would work but would
      // regenerate the PMREM twice.
      var name = String(want).toLowerCase();
      var f = 0, ov = 0, vd = 0, thick = 1.0;
      if (name === 'storm') f = 1.0;
      else if (name === 'overcast') ov = 1.0;
      else if (name === 'drizzle') { ov = 1.0; thick = 0.62; }
      else if (name === 'none' || name === 'void' || name === 'enclosed' ||
               name === 'interior' || name === 'underground') {
        name = 'none'; ov = 1.0; vd = 1.0;
      }
      if (f <= 0 && ov <= 0) {
        if (name !== 'clear') {
          skyWarn('resolveWeather', 'level/profile asked for sky "' + want +
            '", which is not a preset - the level is rendering the market\'s ' +
            'CLEAR golden-hour sky. Recognised: clear, storm, overcast, ' +
            'drizzle, none.');
        }
        return;
      }
      this.weatherPreset = name;
      this._stormF = f;
      this._overcastF = ov;
      this._voidF = vd;
      this._overThick = thick;
      this.enclosed = vd > 0;
      if (f > 0 || (ov > 0 && vd <= 0)) this._makeStormTexture();
      this._computeLightingTerms();
    } catch (e) { GAME.logError('sky.resolveWeather', e); }
  };

  // --------------------------------------------------------------------------
  // Land the non-weather half of a level's declarative env profile before the
  // first LUT is built: turbidity, time of day and ground albedo.
  //
  // All three are also applied by main.js after the build pass, and all three
  // are idempotent - so this is purely about getting the FIRST generation
  // right rather than generating a market sky and throwing it away. It is also
  // what lets lighting.js build against the sun the level actually has.
  //
  // Guarded field by field and gated on the presence of an env profile, which
  // market and harbor deliberately do not have.
  // --------------------------------------------------------------------------
  Sky.prototype._resolveEnvProfile = function (ctx) {
    try {
      var def = ctx && ctx.levelDef;
      var env = def && def.env;
      if (!env) return;

      // The env profile is an options bag like any other, and it drops
      // unrecognised keys exactly as setFog used to. The known set is the union
      // of what THIS module consumes and what main.js's applyEnv routes to
      // other systems - a key in neither list is a key nothing will ever read,
      // which is the same failure as `density` missing from a setFog literal.
      checkOpts('env', env, ENV_KEYS);

      if (isFinite(env.turbidity) && env.turbidity > 0) {
        // _built is false here, so this only re-tabulates transmittance; the
        // LUT that consumes it has not been generated yet.
        this.setTurbidity(env.turbidity);
      }

      // Ground albedo: an explicit profile value wins, otherwise the roster
      // table. Everything downstream of this - the LUT's ground-bounce
      // integral, the fog's downward inscatter, the overcast deck's level, its
      // hue and its picture compression - depends on it, so it has to land
      // before the first _buildLut.
      if (env.groundAlbedo != null) this.setGroundAlbedo(env.groundAlbedo);
      else if (ctx.levelId && GROUND_ALBEDO_BY_LEVEL[ctx.levelId]) {
        this.setGroundAlbedo(GROUND_ALBEDO_BY_LEVEL[ctx.levelId]);
      }

      // Twilight zenith: an explicit profile value wins, otherwise the per-level
      // default table. Lands before the first _buildLut for the same reason the
      // albedo does - it is a LUT layer, so everything derived from the LUT
      // (ambient, hemisphere hues, fog colours, the probe) is solved against it
      // once instead of being generated and thrown away. Absent for every level
      // whose sun is not on the horizon, and unreachable for market and harbor.
      if (env.twilight != null) this.setTwilight(env.twilight);
      else if (ctx.levelId && TWILIGHT_BY_LEVEL[ctx.levelId]) {
        this.setTwilight(TWILIGHT_BY_LEVEL[ctx.levelId]);
      }
      // ?twilight=1 on the capture URL, same QA-hook contract as ?weather=.
      if (GAME.params && GAME.params.twilight != null) {
        this.setTwilight(parseFloat(GAME.params.twilight));
      }

      // Cool upper dome. Same contract: a profile value, then the URL hook.
      // Absent for every level, so this is inert until one asks. It is a LUT
      // layer like the twilight rotation, so it has to land before the first
      // _buildLut or the ambient, the fog colours and the probe are generated
      // once against the wrong dome and thrown away.
      if (env.zenithTint != null) this.setZenithTint(env.zenithTint);
      if (GAME.params) {
        if (GAME.params.zenithTint != null) {
          this.setZenithTint(parseFloat(GAME.params.zenithTint));
        }
        // ?ztFrom=14&ztTo=46&ztDim=0.3&ztAway=0.4 - so the window can be
        // photographed and graded before it is committed to a profile.
        var zt = null;
        if (GAME.params.ztFrom != null) {
          zt = zt || {}; zt.fromDeg = parseFloat(GAME.params.ztFrom);
        }
        if (GAME.params.ztTo != null) {
          zt = zt || {}; zt.toDeg = parseFloat(GAME.params.ztTo);
        }
        if (GAME.params.ztDim != null) {
          zt = zt || {}; zt.dim = parseFloat(GAME.params.ztDim);
        }
        if (GAME.params.ztAway != null) {
          zt = zt || {}; zt.away = parseFloat(GAME.params.ztAway);
        }
        if (zt) this.setZenithTint(zt);
      }

      // Interior aerial perspective. Not a LUT layer - it overrides the solved
      // fog colours - so it only has to land before the first _pushUniforms,
      // but resolving it here keeps every env key in one place.
      if (env.depthHaze != null) this.setDepthHaze(env.depthHaze);
      if (GAME.params && GAME.params.depthHaze != null) {
        this.setDepthHaze(parseFloat(GAME.params.depthHaze));
      }

      // Peak solar elevation, in DEGREES. Must land BEFORE the time of day: the
      // arc is what turns t into an elevation, so setting it afterwards would
      // leave one generation of everything downstream built against the default
      // 30-degree cap. Absent for every level that wants the art-directed arc,
      // which is all of them but the noon one. See setSolarArc.
      if (isFinite(env.sunElevation)) this.setSolarArc(env.sunElevation);
      else if (env.solarArc) this.setSolarArc(env.solarArc);
      // ?sunElev=66 on the capture URL, same contract as ?weather= above: a QA
      // hook so a sun height can be photographed and graded before a level's
      // profile is written, never a default. Wins over the profile deliberately
      // - the point is to be able to override it from the command line.
      if (GAME.params && GAME.params.sunElev != null) {
        this.setSolarArc(parseFloat(GAME.params.sunElev));
      }

      if (isFinite(env.timeOfDay)) {
        // setTimeOfDay short-circuits to _solar + _computeLightingTerms while
        // _built is false, which is exactly the pre-build behaviour wanted.
        this.setTimeOfDay(env.timeOfDay);
      }

      // Dust field. Landed before _makeDust runs (build() resolves the profile
      // first), so the uniforms are seeded rather than written and rewritten.
      //
      // The two SHELL guards default ON for every level that carries an env
      // profile - i.e. for levels 3-10 and, by construction, never for the two
      // frozen ones. They are not taste: gl_PointSize is clamped UP to 1 px, so
      // a mote whose true footprint is a third of a pixel is drawn over eleven
      // times its own area at full alpha, which is why the field measured the
      // same peak value at 2 m and at 14 m and printed as hard-edged white
      // squares at every depth including over a city 400 m away. Correcting the
      // energy and fading the near shell in are what make it a depth cue.
      // DUST_ENV_NEAR is a little under half the 14 m wrap cell, so the ramp is
      // spread across the shell instead of being spent in its first metre.
      this.setDustGain({ nearFade: DUST_ENV_NEAR, subPixel: 1.0 });
      if (ctx.levelId && DUST_BY_LEVEL[ctx.levelId]) {
        this.setDustGain(DUST_BY_LEVEL[ctx.levelId]);
      }
      if (isFinite(env.dustGain)) this.setDustGain(env.dustGain);
      else if (env.dust) this.setDustGain(env.dust);
      // ?dustGain=0.2&dustDown=0.85 - the same QA hook, same contract.
      if (GAME.params) {
        if (GAME.params.dustGain != null) {
          this.setDustGain(parseFloat(GAME.params.dustGain));
        }
        if (GAME.params.dustDown != null) {
          this.setDustGain({ downFade: parseFloat(GAME.params.dustDown) });
        }
        if (GAME.params.dustNear != null) {
          this.setDustGain({ nearFade: parseFloat(GAME.params.dustNear) });
        }
        if (GAME.params.dustSubPx != null) {
          this.setDustGain({ subPixel: parseFloat(GAME.params.dustSubPx) });
        }
      }

      // Fog: the two-lobe inscatter tint, and any authored base parameter a
      // level would otherwise have to reach for setFog() for. All optional and
      // all inert when absent.
      if (env.fog) this.setFog(env.fog);
      if (env.fogTint != null) {
        this.setFog({
          tint: env.fogTint,
          tintAmount: isFinite(env.fogTintAmount) ? env.fogTintAmount : 0.30
        });
      } else if (isFinite(env.fogTintAmount)) {
        this.setFog({ tintAmount: env.fogTintAmount });
      }
      // ?fogTint=6b7ac0&fogTintAmount=0.35 - the same QA hook again, so a haze
      // chromaticity can be photographed and graded before it is committed to a
      // profile. Hex without the 0x, the way a colour is normally typed.
      if (GAME.params && GAME.params.fogTint != null) {
        var qh = parseInt(String(GAME.params.fogTint).replace(/^0x|^#/, ''), 16);
        if (isFinite(qh)) {
          this.setFog({
            tint: qh,
            tintAmount: (GAME.params.fogTintAmount != null)
              ? parseFloat(GAME.params.fogTintAmount) : 0.30
          });
        }
      }
    } catch (e) { GAME.logError('sky.resolveEnvProfile', e); }
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
    // The daylight overcast deck rides the same wind-driven drift and reads the
    // same published fog density, so it wants this loop too. The enclosed
    // profile does not: its deck is flat and textureless, there is no wind
    // inside a bunker, and weather.js is inert there. Exactly the original gate
    // for levels 1 and 2.
    var deck = (this._stormF > 0) ||
      (this._overcastF > 0 && !(this._voidF > 0));
    if (!deck) return;
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
    // Storm only. A blizzard and a humid drizzle have no sheet lightning in
    // them, and the fallback strike schedule below exists purely so a level 2
    // build with no fx/weather.js is not a dead grey lid - firing it under an
    // overcast would put strobes in a snowstorm. Under overcast _flashRGB is
    // never written and stays exactly (0,0,0), which is what makes the shader's
    // flash branch unreachable there.
    var flash = 0;
    if (!(this._stormF > 0)) {
      // fall through with no strike
    } else if (w && isFinite(w.flash)) {
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
    if (this._stormF > 0) {
      var keyI = this._strikeKey(ctx, flash);
      var em = STORM_FLASH_Q * keyI / PI;
      if (!isFinite(em) || em < 0) em = 0;
      this._flashPrevRead = flash;
      this._wxFlash = flash;
      this._flashRGB.set(STORM_FLASH_HUE[0] * em, STORM_FLASH_HUE[1] * em,
        STORM_FLASH_HUE[2] * em);
      // The ground-bounce dome is a survey of the TERMINAL's sodium masts.
      // There is no equivalent under a daylight deck (its bounce is the whole
      // ground plane, and it is solved from the albedo, not from a lamp list).
      this._syncBounceCentre(ctx);
    }

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
      if (!isFinite(aod)) return;
      var v = M.clamp(aod, 0.004, 0.25);
      // Idempotent. main.js's declarative env pass re-applies the profile after
      // every system has built, and _resolveEnvProfile has usually already
      // landed the same number before the first LUT - without this the second
      // call would rebuild the LUT and re-run the PMREM for nothing, which on
      // the capture harness is most of a second per level.
      if (v === MIE_AOD && this._built) return;
      setTurbidity(v);
      buildTransmittanceTable();
      if (this._built) {
        this._reLut();
        this._pushUniforms();
        this._regenerateEnvironment();
      }
    } catch (e) { GAME.logError('sky.setTurbidity', e); }
  };

  /**
   * Bulk-set fog parameters, e.g. sky.setFog({ density: 0.02 }).
   *
   * Recognised keys: density, heightScale, baseY, startDistance, maxOpacity,
   * mieG, glowGain, desaturate, enabled - plus the two-lobe tint:
   *
   *   sky.setFog({ tint: [0.42, 0.46, 0.72], tintAmount: 0.35 })
   *
   * `tint` is the chromaticity the ANTI-SUN lobe of the inscatter is pulled
   * toward; the sunward lobe keeps the solar colour the atmosphere solved.
   * Accepts [r,g,b] (linear), a THREE.Color, or a 0xRRGGBB integer. `tintAmount`
   * is 0..1 and defaults to 0, which makes the whole thing inert - so market,
   * harbor and every level that does not ask are bit-identical.
   *
   * The blend is LUMINANCE-PRESERVING. The level of the haze is a measured
   * quantity (derived off the atmosphere, then capped against keyRef in
   * _deriveAmbient so it can never out-brighten the brightest surface in frame)
   * and a tint has no business moving it. `desaturate` remains the lever for
   * pulling toward grey; this one pulls toward a colour, which is what a
   * pre-sunrise sky actually scatters away from the sun.
   *
   * Never throws; an unreadable tint degrades to no tint.
   *
   * ---- WHAT IS LOUD NOW, AND WHY -------------------------------------------
   * Three things this method used to do in silence, all three of which have
   * cost a level agent a round:
   *
   *   1. AN UNRECOGNISED KEY IS IGNORED. It still is - there is nothing else
   *      it could be - but it warns through console.warn, with a "did you
   *      mean" against the recognised set. `density` documented in three
   *      comment blocks and absent from the literal is what this exists for.
   *   2. AN UNUSABLE VALUE IS REJECTED rather than stored. `density: undefined`
   *      used to be written straight into the bag and then read back by
   *      _scheduleHaze as `!isFinite -> 0`, i.e. it switched the fog off two
   *      hundred lines away from the call. Out-of-range values are clamped to
   *      the bounds the uniform path enforces anyway, with a warning, instead
   *      of arriving at a different number somewhere downstream.
   *   3. A VALUE THE ACTIVE PRESET WOULD OVERRULE now says so. See _fogParam:
   *      an explicitly authored key now WINS over the preset default, which is
   *      the actual fix; the warning is for `density`, which is deliberately
   *      still scaled by the preset because two levels share one deck.
   *
   * console.warn, behind no flag, and never GAME.logError - shoot.py and
   * playtest.py read that channel as a real fault.
   */
  Sky.prototype.setFog = function (opts) {
    try {
      if (!opts) return;
      if (typeof opts !== 'object') {
        skyWarn('setFog', 'expects an options object, got ' + (typeof opts) +
          '. Recognised keys: ' + FOG_KEY_LIST.join(', '));
        return;
      }
      checkOpts('setFog', opts, FOG_KEY_LIST);
      var preset = this.weatherPreset;
      var overridden = FOG_PRESET_KEYS[preset] || null;
      var densK = FOG_DENSITY_K[preset] || 0;
      for (var k in opts) {
        if (!Object.prototype.hasOwnProperty.call(opts, k)) continue;
        var spec = FOG_KEYS[k];
        if (!spec) continue;                       // already warned by checkOpts
        var v = opts[k];
        if (spec === 'rgb') {
          // tint: null clears it; anything readRGB can parse is kept verbatim
          // (it is re-read and normalised every _pushUniforms), and anything
          // else is refused rather than left to become NaN in the shader.
          if (v == null) { this.fog[k] = null; this._fogSet[k] = true; continue; }
          if (!readRGB(v, _tintTmp)) {
            skyWarn('setFog', '"tint" could not be read as a colour and was ' +
              'IGNORED. Give [r,g,b] linear, a THREE.Color, or 0xRRGGBB.');
            continue;
          }
          this.fog[k] = v;
          this._fogSet[k] = true;
          continue;
        }
        if (spec === 'bool') {
          this.fog[k] = !!v;
          this._fogSet[k] = true;
          continue;
        }
        var n = +v;
        if (!isFinite(n)) {
          skyWarn('setFog', '"' + k + '" = ' + String(v) + ' is not a finite ' +
            'number and was IGNORED (kept ' + this.fog[k] + '). This used to be ' +
            'stored and then silently read back as 0 by the haze schedule.');
          continue;
        }
        if (n < spec[0] || n > spec[1]) {
          var c = M.clamp(n, spec[0], spec[1]);
          skyWarn('setFog', '"' + k + '" = ' + n + ' is outside ' + spec[0] +
            '..' + spec[1] + ' and was CLAMPED to ' + c + '.');
          n = c;
        }
        this.fog[k] = n;
        this._fogSet[k] = true;
        if (k === 'density' && densK > 0) {
          skyWarn('setFog', 'weather preset "' + preset + '" SCALES density by ' +
            densK + 'x, so the effective extinction is ' + (n * densK).toFixed(5) +
            '/m, not ' + n + '/m. That is deliberate (see _scheduleHaze) - the ' +
            'authored number is a base the deck scales.');
        } else if (k === 'density' && preset === 'storm') {
          skyWarn('setFog', 'weather preset "storm" takes its density from ' +
            'weather.js, so the authored value is not used.');
        } else if (overridden && overridden.indexOf(k) >= 0) {
          skyWarn('setFog', '"' + k + '" would have been overruled by weather ' +
            'preset "' + preset + '" before this round; an explicitly authored ' +
            'value now WINS. Your ' + n + ' is what the frame uses.');
        }
      }
      this._pushUniforms();
    } catch (e) { GAME.logError('sky.setFog', e); }
  };

  /**
   * Override the peak elevation of the day arc.
   *
   *   sky.setSolarArc({ maxElevDeg: 66 })   // high noon
   *   sky.setSolarArc(66)                   // same thing
   *
   * The arc is an ART CHOICE, not an ephemeris (see the Solar/lunar geometry
   * header): it is capped at 30 degrees so the whole daylight range keeps the
   * long raking shadows ART_DIRECTION is built around. That is right for eight
   * of the ten levels and fatal for the one whose entire premise is a brutal
   * overhead sun - at 30 degrees the boneyard's shadows run 1.7x object height
   * under a 4300 K raking key, i.e. the market's golden-hour lighting recipe
   * re-dressed in a desert, which the roster lists as an instant fail.
   *
   * Per-instance and clamped, defaulting to exactly MAX_ELEV, so nothing a level
   * does here can move market or harbor. At ~65 degrees shadows shorten to
   * 0.4-0.5x height, the key neutralises through the existing extinction path
   * (and the 4200 K nudge in _computeLightingTerms fades out above 30 degrees
   * for the same reason), and the zenith lifts and desaturates on its own
   * without anyone touching turbidity.
   *
   * A level's env profile can carry `sunElevation: 66` instead of calling this.
   *
   * Idempotent, safe before build(), and never throws.
   *
   * @param {Object|number} opts {maxElevDeg} or the number itself, in DEGREES.
   */
  Sky.prototype.setSolarArc = function (opts) {
    try {
      if (opts && typeof opts === 'object') {
        checkOpts('setSolarArc', opts, ['maxElevDeg', 'maxElevation']);
      }
      var deg = (typeof opts === 'number') ? opts
        : (opts && isFinite(opts.maxElevDeg) ? opts.maxElevDeg
          : (opts && isFinite(opts.maxElevation) ? opts.maxElevation : NaN));
      if (!isFinite(deg)) {
        skyWarn('setSolarArc', 'no usable peak elevation in ' +
          JSON.stringify(opts) + ' - IGNORED. Pass a number of DEGREES, or ' +
          '{maxElevDeg: 66}. Clamped to 3..88.');
        return;
      }
      // 88 rather than 90: the LUT parameterises elevation as sign(y)*sqrt(|y|)
      // and the azimuth-from-sun frame degenerates at the exact zenith, where
      // every view ray has the same sun-relative azimuth and the horizon band
      // would lose the one axis it is defined along.
      var e = M.clamp(deg, 3.0, 88.0) * M.DEG;
      if (Math.abs(e - this._maxElev) < 1e-6) return;
      this._maxElev = e;
      // Re-derive the geometry the arc feeds. setTimeOfDay does exactly the
      // right thing at every stage of the lifecycle: before build() it lands
      // the sun and returns, after it rebuilds the LUT, the ambient, the fog
      // colours and the probe - and only when the sun has actually moved.
      this.setTimeOfDay(this.timeOfDay);
    } catch (e) { GAME.logError('sky.setSolarArc', e); }
  };

  /**
   * Switch on the authored TWILIGHT ZENITH for a level whose sun sits within a
   * few degrees of the horizon.
   *
   *   sky.setTwilight(1.0)
   *   sky.setTwilight({ amount: 1.0 })
   *   sky.setTwilight({ amount: 1.0, zenith: [0.20, 0.50, 1.00], dim: 0.28 })
   *   sky.setTwilight(0)                       // back to the shipped dome
   *
   * WHAT IT FIXES, and why it cannot be reached from a level's env profile with
   * the knobs that already exist. The dome is single scattering; with the disc on
   * the horizon the solar path extinguishes blue (Rayleigh optical depth 2.6 in
   * the red against 14.9 in the blue) exactly where the density that would
   * scatter it lives, so the integral comes out R = G with B DOWN 30% - measured
   * at t = 0.22 on Bayon: zenith (0.398, 0.330, 0.380) in the final image, i.e.
   * MAGENTA, with a total luminance swing across the whole visible sky of 13%.
   * Turbidity cannot help (it is already at the clear end and adds haze, not
   * blue), a later timeOfDay only raises the disc, and RAY_CHROMA is actively
   * inverted here because B sits BELOW the Rayleigh mean it expands about.
   *
   * The real sky is blue up there because of second-order scattering and
   * Chappuis ozone absorption, neither of which this model has - so this is a
   * missing authored term, and it lives in the LUT so the IBL, the hemisphere
   * fill and every fog colour inherit it rather than only the picture.
   *
   * It is a luminance-preserving CHROMATICITY ROTATION, not an added layer: the
   * dome is a light source as well as an image and 64% of the sky's irradiance
   * arrives from above 37 degrees, so anything that removes radiance up there
   * removes the level's skylight with it.
   *
   *   amount     0..1 master gate. 0 (default) makes every added branch fall
   *              through to the exact arithmetic the file shipped with.
   *   zenith     [r,g,b] target CHROMATICITY (only the ratios matter - it is
   *              normalised to luminance 1). Default TWI_ZENITH, B > G > R.
   *   dim        0..1, zenith luminance CUT at full weight, i.e. how much
   *              zenith-to-horizon gradient the sky carries. Default TWI_DIM.
   *   away       0..1, how much of the rotation the LOW sky gets on bearings
   *              away from the sun.
   *   azTight    azimuthal exponent confining the WARM band to the sun's own
   *              quadrant. Higher = tighter.
   *
   * A level's env profile can carry `twilight: 1.0` or
   * `twilight: {amount: 1.0, ...}` instead of calling this.
   *
   * Idempotent, legal before build(), and never throws.
   *
   * @param {Object|number} opts {amount, zenith, dim, away, azTight}
   */
  Sky.prototype.setTwilight = function (opts) {
    try {
      var a = NaN, dirty = false;
      if (typeof opts === 'number') a = opts;
      else if (typeof opts === 'boolean') a = opts ? 1 : 0;
      else if (opts) {
        checkOpts('setTwilight', opts,
          ['amount', 'value', 'zenith', 'dim', 'away', 'azTight']);
        if (isFinite(opts.amount)) a = opts.amount;
        else if (isFinite(opts.value)) a = opts.value;
        if (readRGB(opts.zenith, _tintTmp)) {
          this._twiZenith[0] = _tintTmp[0];
          this._twiZenith[1] = _tintTmp[1];
          this._twiZenith[2] = _tintTmp[2];
          dirty = true;
        }
        if (isFinite(opts.dim)) { this._twiDim = M.saturate(opts.dim); dirty = true; }
        if (isFinite(opts.away)) { this._twiAway = M.saturate(opts.away); dirty = true; }
        if (isFinite(opts.azTight)) { this._twiAzP = M.clamp(opts.azTight, 1.0, 40.0); dirty = true; }
      } else return;
      if (isFinite(a)) {
        var v = M.saturate(a);
        if (v !== this._twiF) { this._twiF = v; dirty = true; }
      }
      if (!dirty || !this._built) return;
      // The layer lives in the LUT, so everything derived from it - the ambient
      // set, the hemisphere hues, every fog colour and the PMREM probe - has to
      // be re-solved. Same sequence setTurbidity uses, and for the same reason.
      this._reLut();
      this._pushUniforms();
      this._regenerateEnvironment();
    } catch (e) { GAME.logError('sky.setTwilight', e); }
  };

  /**
   * Rotate the UPPER DOME toward a cool chromaticity at ANY sun elevation.
   *
   *   sky.setZenithTint(0.8)
   *   sky.setZenithTint({ amount: 0.8, fromDeg: 14, toDeg: 46 })
   *   sky.setZenithTint({ amount: 1.0, chroma: [0.24, 0.60, 1.04], dim: 0.3 })
   *   sky.setZenithTint(0)                      // back to the shipped dome
   *
   * WHY THIS IS NOT setTwilight, and this is a measured distinction rather than
   * a design preference. setTwilight()'s rotation is multiplied by `afterglow`,
   * a window open only between +9 and -13 degrees of sun elevation. Meridian
   * Tower is the level that asked for a cool zenith; the roster calls it a
   * sunset and its env profile says timeOfDay 0.80, but level_highrise.js
   * deliberately re-pins the hour to t = 0.712 (because at 0.80 the disc is
   * 0.32 degrees UNDER the horizon and the direct key collapses), which puts
   * the sun at +8.81 degrees. afterglow evaluates to 0.0017 there. So the
   * shipped twilight lever multiplies its entire effect by 1/600 on the one
   * level that needs it, and widening the afterglow window instead would drag
   * the authored dusk and night layers - which are multiplied by the same
   * factor - into full daylight.
   *
   * SO READ THIS BEFORE REACHING FOR IT: measured on Meridian Tower, no framing
   * that level publishes shows sky above 17 degrees of elevation. lv_overview
   * has pitch -15.1 at fov 64, so its top row is +16.9 and its horizon lands on
   * row 205 of 720; the critic's "dome zenith, R/B 1.08" is a sample of the sky
   * at 15-17 degrees, not of the zenith. At a +9 degree sun that band is where
   * the mineral-dust layer legitimately lives and the model puts it at scene
   * R/B 1.5-2.9. Rotating THAT to cool is not fixing a zenith, it is deleting a
   * golden-hour horizon - which is the failure TWI_AWAY is capped at 0.40 to
   * avoid (at 0.62 the brightest sky band rotated to near-neutral and
   * grade_split INVERTED, +0.1775 to -0.0213). The honest use of this control is
   * a level that can actually SEE its upper dome; if what you need is cool at
   * 10-20 degrees on a framing that looks at the horizon, spend it on the fog's
   * anti-sun lobe instead (setFog tint/tintAmount), which is where the air in
   * those pixels comes from.
   *
   *   amount    0..1 master gate. 0 (default) makes every added branch fall
   *             through to the exact arithmetic the file shipped with.
   *   chroma    [r,g,b] target CHROMATICITY (only the ratios matter - it is
   *             normalised to luminance 1). Default TWI_ZENITH [0.235, 0.600,
   *             1.040], B > G > R. Also accepts a THREE.Color or 0xRRGGBB.
   *   fromDeg   elevation where the rotation starts, DEGREES. Default 3.5.
   *   toDeg     elevation where it is complete, DEGREES. Default 36.9. Must be
   *             greater than fromDeg or both fall back to the defaults.
   *   away      0..1, how much of the rotation the LOW sky gets on bearings
   *             AWAY from the sun. Default 0.40 - the measured ceiling, above
   *             which the warm band stops being the frame's highlight.
   *   azTight   1..40, azimuthal exponent confining the warm band to the sun's
   *             own quadrant. Default 14 (spent ~25 degrees off the sun).
   *   dim       0..1, zenith luminance CUT at full weight, i.e. how much
   *             zenith-to-horizon gradient the dome carries. Default 0, so the
   *             rotation is purely chromatic and provably cannot move the
   *             level's skylight, keyRef, the fog caps or the exposure. The cut
   *             is energy-normalised (see dimNorm) so even a large value
   *             redistributes irradiance downward rather than losing it.
   *
   * The rotation is luminance-preserving by construction and lives in the LUT,
   * so the IBL, the hemisphere fill and every derived fog colour inherit it -
   * a copy in the dome shader would light the picture and leave the light.
   *
   * A storm or overcast deck switches it off, exactly as it does the airglow.
   *
   * A level's env profile can carry `zenithTint: 0.8` or
   * `zenithTint: {amount: 0.8, toDeg: 46}` instead of calling this.
   *
   * Idempotent, legal before build(), and never throws.
   *
   * @param {Object|number} opts {amount, chroma, fromDeg, toDeg, away, azTight, dim}
   */
  Sky.prototype.setZenithTint = function (opts) {
    try {
      var a = NaN, dirty = false;
      if (typeof opts === 'number') a = opts;
      else if (typeof opts === 'boolean') a = opts ? 1 : 0;
      else if (opts) {
        checkOpts('setZenithTint', opts,
          ['amount', 'value', 'chroma', 'zenith', 'fromDeg', 'toDeg',
           'away', 'azTight', 'dim']);
        if (isFinite(opts.amount)) a = opts.amount;
        else if (isFinite(opts.value)) a = opts.value;
        // `zenith` accepted as an alias so a caller who has just read
        // setTwilight's signature is not silently ignored.
        var chroma = (opts.chroma != null) ? opts.chroma : opts.zenith;
        if (chroma != null) {
          if (readRGB(chroma, _tintTmp)) {
            this._ztChroma[0] = _tintTmp[0];
            this._ztChroma[1] = _tintTmp[1];
            this._ztChroma[2] = _tintTmp[2];
            dirty = true;
          } else {
            skyWarn('setZenithTint', '"chroma" could not be read as a colour ' +
              'and was IGNORED. Give [r,g,b] linear, a THREE.Color, or 0xRRGGBB.');
          }
        }
        var lo = this._ztLo, hi = this._ztHi, moved = false;
        if (isFinite(opts.fromDeg)) {
          lo = Math.sin(M.clamp(opts.fromDeg, -5.0, 85.0) * M.DEG); moved = true;
        }
        if (isFinite(opts.toDeg)) {
          hi = Math.sin(M.clamp(opts.toDeg, -4.0, 90.0) * M.DEG); moved = true;
        }
        if (moved) {
          if (!(hi > lo + 1e-3)) {
            skyWarn('setZenithTint', 'toDeg must be greater than fromDeg; got ' +
              opts.fromDeg + '..' + opts.toDeg + ' - kept the previous window.');
          } else {
            this._ztLo = lo; this._ztHi = hi; dirty = true;
          }
        }
        if (isFinite(opts.away)) { this._ztAway = M.saturate(opts.away); dirty = true; }
        if (isFinite(opts.azTight)) {
          this._ztAzP = M.clamp(opts.azTight, 1.0, 40.0); dirty = true;
        }
        if (isFinite(opts.dim)) { this._ztDim = M.saturate(opts.dim); dirty = true; }
      } else return;
      if (isFinite(a)) {
        var v = M.saturate(a);
        if (v !== this._ztF) { this._ztF = v; dirty = true; }
      } else if (typeof opts === 'number' || (opts && 'amount' in opts)) {
        skyWarn('setZenithTint', 'amount ' + String(typeof opts === 'number' ? opts
          : opts.amount) + ' is not a finite number and was IGNORED (still at ' +
          this._ztF + '). 0..1.');
      }
      if (!dirty || !this._built) return;
      // The layer lives in the LUT, so the ambient set, the hemisphere hues,
      // every fog colour and the PMREM probe all have to be re-solved. Same
      // sequence setTurbidity and setTwilight use, and for the same reason.
      this._reLut();
      this._pushUniforms();
      this._regenerateEnvironment();
    } catch (e) { GAME.logError('sky.setZenithTint', e); }
  };

  /**
   * Give an ENCLOSED level real aerial perspective: air with a radiance of its
   * own, so a lit destination 40 m away reads as distant instead of arriving at
   * full contrast.
   *
   *   sky.setDepthHaze({ radiance: 0.030 })
   *   sky.setDepthHaze({ radiance: 0.030, tint: [0.55, 0.72, 0.62] })
   *   sky.setDepthHaze(0)                       // off (the default)
   *
   * WHAT IT FIXES, measured. Every inscatter colour in this file is derived off
   * the atmosphere and then capped against keyRef so "the haze can never
   * out-brighten the brightest surface in the frame". Under the 'none' preset
   * sunIntensity is 0, so keyRef collapses to the void IBL - 0.00362 on metro -
   * the anti-sun cap lands at 0.0033, and the haze is PINNED there
   * (fogSky = 0.00341, 0.00352, 0.00363, probed in-engine). The brightest
   * surface in that level is a tiled wall under a fluorescent at roughly linear
   * 0.18 in the print, so the air is capped two and a half decades under the
   * thing it exists to sit behind. Consequence, measured on lv_hero1: the east
   * arch 38 m away prints L 0.386 against a near floor at 0.349 - the far end of
   * the hall is BRIGHTER than the floor at the lens. The fog is attenuating
   * (47% at 38 m) but not veiling, and a pure multiply preserves every contrast
   * ratio it touches.
   *
   * Raising the cap cannot fix it, because the cap is derived from a sun that
   * does not exist. The level is the only thing that knows what its practicals
   * put on a wall, so the level supplies the number.
   *
   *   radiance  ABSOLUTE linear HDR luminance of the lit air: the value a
   *             fully-veiled surface converges to. There is no default and the
   *             call is inert without it. Useful range for an interior lit by
   *             practicals is 0.004-0.06; sensible starting point is 10-20% of
   *             the radiance of a wall directly under a fixture. Above ~0.10 the
   *             air becomes the brightest thing in the frame, which is the
   *             failure this file's whole cap system exists to prevent - the
   *             cap is bypassed here on purpose, so this number is the only
   *             thing standing between you and fog-in-the-headlights.
   *   tint      chromaticity of the air, [r,g,b] / THREE.Color / 0xRRGGBB.
   *             Default null = keep the chromaticity the model already solved,
   *             so a level that only wants the LEVEL raised does not also get a
   *             colour it did not ask for.
   *   sunward   multiplier on the sunward lobe, x radiance. Default 1.25. With
   *             no sun this only decides how much brighter the air is along the
   *             notional key bearing; leave it alone in a sealed level.
   *   ground    multiplier on the downward lobe, x radiance. Default 0.80.
   *   amount    0..1 blend toward the above. Default 1 when a radiance is
   *             given, 0 (inert) otherwise.
   *
   * TWO THINGS THIS DOES NOT DO, because setFog already does them and now
   * actually works under a deck (see _fogParam):
   *   * the DENSITY of the air - setFog({density}) - remembering that the
   *     enclosed preset scales an authored density by 1.15x;
   *   * the opacity CAP - setFog({maxOpacity}) - which is what decides whether
   *     a fully-veiled surface can converge all the way. The enclosed default
   *     is 0.82, so 18% of a bright destination survives at any distance.
   * A veil radiance with a cap of 0.82 and 47% opacity at 38 m moves that arch
   * by about a third of the way; if you want it to READ as distant, raise the
   * density and the cap as well and measure the print.
   *
   * Not gated on the preset: a level with a sky can use it too (a jungle
   * understory is the same problem). It is applied AFTER every cap and floor in
   * the file, which is unique to this term and deliberate.
   *
   * A level's env profile can carry `depthHaze: {radiance: 0.03}`.
   *
   * Idempotent, legal before build(), and never throws.
   *
   * @param {Object|number} opts {radiance, tint, sunward, ground, amount}
   */
  Sky.prototype.setDepthHaze = function (opts) {
    try {
      if (opts === 0 || opts === false || opts == null) {
        if (this._dhF === 0) return;
        this._dhF = 0;
      } else if (typeof opts === 'number') {
        // A bare number is the radiance - the only field with no default.
        if (!isFinite(opts) || opts < 0) {
          skyWarn('setDepthHaze', String(opts) + ' is not a usable radiance ' +
            'and was IGNORED. Pass 0 to switch the term off.');
          return;
        }
        this._dhRad = M.clamp(opts, 0.0, 0.5);
        this._dhF = 1.0;
      } else if (typeof opts === 'object') {
        checkOpts('setDepthHaze', opts,
          ['radiance', 'tint', 'sunward', 'ground', 'amount']);
        var got = false;
        if (opts.radiance != null) {
          var r = +opts.radiance;
          if (!isFinite(r) || r < 0) {
            skyWarn('setDepthHaze', '"radiance" = ' + String(opts.radiance) +
              ' is not a usable linear radiance and was IGNORED.');
          } else {
            if (r > 0.10) {
              skyWarn('setDepthHaze', '"radiance" = ' + r + ' is very high for ' +
                'air - it bypasses every keyRef cap in this module, so above ' +
                'about 0.10 the haze becomes the brightest thing in the frame. ' +
                'Measure the print.');
            }
            this._dhRad = M.clamp(r, 0.0, 0.5);
            got = true;
          }
        }
        if (opts.tint != null) {
          if (readRGB(opts.tint, _tintTmp)) {
            this._dhHue = [_tintTmp[0], _tintTmp[1], _tintTmp[2]];
          } else {
            skyWarn('setDepthHaze', '"tint" could not be read as a colour and ' +
              'was IGNORED. Give [r,g,b] linear, a THREE.Color, or 0xRRGGBB.');
          }
        }
        if (isFinite(opts.sunward)) this._dhSun = M.clamp(opts.sunward, 0.0, 4.0);
        if (isFinite(opts.ground)) this._dhGnd = M.clamp(opts.ground, 0.0, 4.0);
        if (isFinite(opts.amount)) this._dhF = M.saturate(opts.amount);
        else if (got) this._dhF = 1.0;
        if (this._dhF > 0 && !(this._dhRad > 0)) {
          skyWarn('setDepthHaze', 'no "radiance" has been given, so the term is ' +
            'INERT. It is the one field with no default - it is an absolute ' +
            'linear radiance and only the level knows what its practicals put ' +
            'on a wall.');
        }
      } else {
        skyWarn('setDepthHaze', 'expects {radiance, tint, sunward, ground, ' +
          'amount} or a bare radiance, got ' + (typeof opts) + '.');
        return;
      }
      if (!this._built) return;
      // The fog colours are solved in _deriveAmbient, which hangs off the LUT -
      // but this term does not change the LUT, so re-deriving the ambient is
      // enough and there is no need to rebuild 8192 texels or the PMREM probe.
      this._deriveAmbient();
      this._pushUniforms();
    } catch (e) { GAME.logError('sky.setDepthHaze', e); }
  };

  /**
   * Turn the floating dust-mote field down, off, or make it background-aware.
   *
   *   sky.setDustGain(0.20)
   *   sky.setDustGain({ gain: 0.20, downFade: 0.85 })
   *   sky.setDustGain(0)                       // off entirely
   *
   * WHY THIS IS A LEVEL-FACING CONTROL. The field is a SHAFT INDICATOR: it is
   * shadow-tested against cascade 0 and faded out on rising rays, because "a
   * mote is only ever visible against something darker than itself" and a rising
   * ray is the cheap depth-free proxy for "this speck is about to sit on the
   * sky". That proxy is written for a camera standing in a street. A level whose
   * entire subject is 25 degrees BELOW the eye and whose background is bright
   * depth haze 176 m down gets the full field at full alpha against the
   * brightest thing in the frame - measured at 765-1441 hard white specks per
   * frame on Meridian Tower, 11% of them chromatic enough to read as red/cyan
   * confetti, and unambiguously as STARS where they crossed the twilight sky.
   *
   *   gain      multiplies the mote radiance. 1.0 default. 0.15-0.25 is the
   *             right order for a level looking down at bright haze; 0 removes
   *             the field from the frame without paying for it.
   *   downFade  0..1, how hard a mote on a steeply DESCENDING ray is suppressed
   *             (full by ~17 degrees below horizontal). 0 default. This is the
   *             mirror image of the existing rising-ray guard and it is opt-in
   *             because it is exactly wrong for a street, where the ground two
   *             metres ahead is the darkest thing in frame.
   *   nearFade  metres by which the NEAR ramp completes, 0 = off (default). The
   *             shipped 0.30..1.4 m ramp is a lens-flare guard; it is spent
   *             before the wrap shell has begun, so a mote 2 m from the lens and
   *             a mote 12 m away draw at the same value against completely
   *             different backdrops. 5-6 m fades the field in with depth as well
   *             as out, which is what stops it reading as a speckle mask.
   *   subPixel  0..1, energy conservation for motes whose true footprint is
   *             under one pixel, 0 = off (default). gl_PointSize is clamped up
   *             to 1.0, so such a mote is drawn over ~11x its own area at full
   *             alpha - a hard-edged single-pixel square with no distance
   *             falloff, which is exactly what "reads as sensor noise, not as
   *             dust" means. 1.0 is the physically correct amount.
   *
   * The last two are what make the field a DEPTH cue instead of an overlay, and
   * they are opt-in for the same reason everything else here is: market and
   * harbor are byte-exact regression canaries, and 0 makes both an exact
   * multiply by 1.0 in the vertex shader.
   *
   * A level's env profile can carry `dustGain: 0.20` or
   * `dust: {gain: 0.20, downFade: 0.85, nearFade: 5.5, subPixel: 1}` instead of
   * calling this.
   *
   * Legal before build(), idempotent, and never throws.
   *
   * @param {Object|number} opts {gain, downFade, nearFade, subPixel} or the gain.
   */
  Sky.prototype.setDustGain = function (opts) {
    try {
      var g = NaN, dn = NaN, nf = NaN, sp = NaN;
      if (typeof opts === 'number') g = opts;
      else if (opts) {
        checkOpts('setDustGain', opts,
          ['gain', 'value', 'downFade', 'nearFade', 'subPixel', 'subPx']);
        if (isFinite(opts.gain)) g = opts.gain;
        else if (isFinite(opts.value)) g = opts.value;
        if (isFinite(opts.downFade)) dn = opts.downFade;
        if (isFinite(opts.nearFade)) nf = opts.nearFade;
        if (isFinite(opts.subPixel)) sp = opts.subPixel;
        else if (isFinite(opts.subPx)) sp = opts.subPx;
      }
      if (isFinite(g)) this._dustGain = M.clamp(g, 0.0, 4.0);
      if (isFinite(dn)) this._dustDown = M.saturate(dn);
      // Clamped above the near ramp's own start so the smoothstep can never be
      // handed edge0 >= edge1, which is undefined in GLSL.
      if (isFinite(nf)) this._dustNear = (nf > 0) ? M.clamp(nf, 1.2, 13.0) : 0.0;
      if (isFinite(sp)) this._dustSubPx = M.saturate(sp);
      var du = this._dustUniforms;
      if (du) {
        if (du.uGain) du.uGain.value = this._dustGain;
        if (du.uDownFade) du.uDownFade.value = this._dustDown;
        if (du.uNearFade) du.uNearFade.value = this._dustNear;
        if (du.uSubPx) du.uSubPx.value = this._dustSubPx;
      }
    } catch (e) { GAME.logError('sky.setDustGain', e); }
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
        // ...and for the same reason under a daylight overcast: the field is a
        // SHAFT indicator, shadow-tested against the key cascade, so with the
        // key cut to a fifth (or, enclosed, to nothing) there is no shaft for
        // it to indicate and all it can contribute is an unmotivated additive
        // veil over a level that is already carrying a deliberate one.
        this.dustParticles.visible =
          !(ctx && ctx.quality && ctx.quality.particles === 0) &&
          !(this._stormF > 0.35) && !(this._overcastF > 0.35);
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
