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
    this.fogDensityEffective = d;
    this.scatterRadiance = HAZE_ALBEDO * d / (4.0 * PI);

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
          var wLow = afterglow * upFall * dnFall * (0.16 + 0.84 * azFall) * SKY_SCALE;
          var wHigh = afterglow * Math.exp(-Math.max(0.0, viewEl - 0.10) / 0.38) *
                      dnFall * (0.30 + 0.70 * azFall) * 0.55 * SKY_SCALE;
          iso0 += AFTERGLOW_LOW[0] * wLow + AFTERGLOW_HIGH[0] * wHigh;
          iso1 += AFTERGLOW_LOW[1] * wLow + AFTERGLOW_HIGH[1] * wHigh;
          iso2 += AFTERGLOW_LOW[2] * wLow + AFTERGLOW_HIGH[2] * wHigh;
        }

        // --- night airglow floor (never let the sky go to pure black) --------
        if (nightF > 0.001) {
          var hzf = Math.exp(-Math.max(0.0, viewEl) / 0.32) * Math.exp(Math.min(0.0, viewEl) / 0.10);
          var nf = nightF * SKY_SCALE;
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
      uDay: { value: new THREE.Vector4(1.0, 1e9, 2e9, CLOUD_SCALE) }
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
    this._fogA[0] = d;
    this._fogA[1] = 1.0 / Math.max(0.5, f.heightScale);
    this._fogA[2] = f.baseY;
    this._fogA[3] = isFinite(this.fogStartEffective)
      ? this.fogStartEffective : Math.max(0.0, f.startDistance);
    this._fogB[0] = M.saturate(f.maxOpacity);
    this._fogB[1] = M.clamp(f.mieG, 0.0, 0.92);
    this._fogB[2] = Math.max(0.0, f.glowGain);
    this._fogB[3] = M.saturate(f.desaturate);
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
        u.uCloud.value.y = CLOUD_AMOUNT;
        u.uCloud.value.z = CLOUD_BEER;
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
        this.dustParticles.visible = !(ctx && ctx.quality && ctx.quality.particles === 0);
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
      if (this._cubeRT) this._cubeRT.dispose();
      if (this._pmremRT) this._pmremRT.dispose();
      if (this._pmrem) this._pmrem.dispose();
    } catch (e) { GAME.logError('sky.dispose', e); }
  };

  GAME.Sky = Sky;

})(window.GAME, window.THREE);
