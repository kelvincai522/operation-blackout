// ============================================================================
// OPERATION BLACKOUT - post-process stack  (GAME.PostFX)
//
// A hand-written HDR composer. There is no EffectComposer / ShaderPass / *Pass
// in this build, so everything below - render-target management, ping-pong,
// fullscreen dispatch, and every shader - is implemented here from scratch on
// top of nothing but THREE.WebGLRenderTarget + THREE.ShaderMaterial.
//
// Chain (see PostFX.prototype._render for the authoritative order):
//
//   scene -> HDR + depth        jittered projection for TAA
//   velocity                    camera reprojection of the depth buffer
//   GTAO + bilateral blur       at quality.ssaoScale; wide + contact terms
//   volumetrics                 world-space raymarch, per-step CSM occlusion,
//                               plus equi-angular local practicals (harbor)
//   resolve                     AO into indirect + bilateral inscatter upsample
//   SSR                         HARBOR ONLY. half-res march + binary refine,
//                               normal-confidence / reflection-plane /
//                               thickness / backface / near-plane / edge
//                               rejection, analytic IBL fallback, anisotropic
//                               roughness resolve
//   TAA (or FXAA)               Halton jitter, YCoCg clip, PROGRESSIVE feedback
//   motion blur                 tile-max / neighbour-max, McGuire weighting
//   viewmodel overlay           separate 1.5x supersampled pass, own depth,
//                               exposure-locked against the world
//   sharpen                     RCAS, display-referred, on the FULL composite
//   depth of field              dioptre CoC over merged world+viewmodel depth
//   auto exposure               GPU-only log-luminance reduction, PARTIAL
//                               adaptation (see FRAG_EXPOSURE) so time of day
//                               survives instead of being normalised away
//   bloom                       soft-knee bright pass + 6-mip shaped pyramid
//   composite                   CA -> bloom -> exposure -> vignette -> AgX ->
//                               grade -> grain
//
// The ordering above is not arbitrary and three of the moves are load-bearing:
//
// * motion blur runs BEFORE the overlay and everything else runs AFTER it. The
//   gun is bolted to the camera, so it has no screen velocity under a turn -
//   but the velocity buffer at those pixels holds the street's. DoF, sharpen
//   and bloom, by contrast, all belong on the weapon.
// * the sharpen sits below every low-pass in the chain. Above them, three
//   subsequent filters simply undid it.
// * the vignette is applied to the light, not to the print - see FRAG_COMPOSITE.
//
// Design notes that are non-obvious:
//
// * MRT is deliberately NOT used. r180's WebGLRenderTarget supports {count:N},
//   but writing a normal/velocity attachment would require every material in
//   the scene to be a GLSL3 shader with matching outputs - and this module does
//   not own materials.js. Instead normals are reconstructed from depth (which
//   is what AO actually wants: geometric, not shading, normals) and velocity is
//   derived from depth + the previous view-projection. That is exact for static
//   geometry, which is >95% of the frame, and the TAA neighbourhood clamp
//   absorbs the error on movers.
//
// * Tone mapping is done here, never on the renderer, so bloom/DoF/volumetrics
//   all operate on real HDR radiance.
//
// * Every pass is individually skippable from setQuality() and the whole thing
//   degrades to "scene + tonemap" if the depth texture is unavailable.
//
// ----------------------------------------------------------------------------
// LEVEL 2 ("COLD HARBOR") ADDITIONS - and how level 1 is protected from them
// ----------------------------------------------------------------------------
// Seven things were added for the storm level: screen-space reflections for the
// wet apron, LOCAL PRACTICALS IN THE VOLUMETRIC MEDIUM, a WEATHER-DRIVEN medium
// density, a lightning eye-adaptation model, rain on the front element, a
// night/storm grade preset with its own toe, and percentile metering. Every one
// of them is gated, and the gates are structural rather than numeric:
//
//   * ctx.levelId / ctx.levelDef.weather are read ONCE, in the constructor
//     (main.js sets both before the build loop, so this is safe), into
//     `_harbor`. The SSR target is not even allocated on the market, and the
//     two SSR passes never dispatch, so their programs are never compiled.
//   * the storm grade is a PRESET that overwrites `settings` in place
//     (setGradePreset). _render still reads the same sixty s.<field>s it
//     always did; on the market they still hold the values they always held.
//   * every new SHADER uniform is authored so its default is an exact no-op:
//     uFlashComp multiplies by 1.0, uRainLens, uTrim and uPracCount gate whole
//     blocks out, uHoldScale and uToeBlack/uToeFloor scale by 1.0, uMaxInscatter
//     is unreachable, uLumFloor is literally the constant the old metering
//     shader had inlined. A market frame is bit-identical - and that is a
//     MEASURED claim, not an argued one: street.png captured after this round
//     differences to zero against the shipped reference on every one of its
//     2.76 million bytes.
//   * ctx.weather is OWNED by src/fx/weather.js and only ever read here, always
//     guarded, always with a fallback - it is built five systems after this one
//     and may not exist at all. Same for ctx.lighting.practicals, which the
//     volumetric now samples: a missing, half-built or malformed rig degrades
//     to "no local inscatter" inside a try/catch, never to a throw.
//
// WHAT THE HARBOR ROUND ACTUALLY CHANGED, AND WHY IT IS NOT WHAT WAS EXPECTED
// ----------------------------------------------------------------------------
// The brief for this pass was "the volumetric is burying the frame at ultra".
// It was not. Captured with the volumetric pass disabled outright, the container
// framing differenced to zero - the pass was contributing NOTHING, because it
// marched the key light only and this level's key is a 0.19 moon. The frame was
// being buried by the storm fog density (weather.js has since halved it) and by
// this module then re-deriving its own march density from scene.fog.density
// with a market-authored floor under it, so the raymarch ran 55% thicker than
// the medium every surface in the frame was using.
//
// Both halves of that are fixed structurally rather than by tuning:
//   * the harbor reads ctx.weather.fogDensity DIRECTLY. weather.js publishes it
//     in extinction-per-metre, which is the unit this march integrates.
//   * the march gained the practicals, importance-sampled, so the medium is lit
//     by the thing that actually lights this level. That is also what makes the
//     lamp cones a volumetric effect rather than a set of beam meshes.
//
// ----------------------------------------------------------------------------
// THE STORM ROUND AFTER THAT: what "vertical striping" actually was
// ----------------------------------------------------------------------------
// The level was graded as covered in broad vertical lines that read as a
// rendering artefact. Two separate mechanisms, both here, neither of them
// aliasing (a 2x supersampled capture keeps the fringing, so it is not):
//
//   * CHROMATIC ABERRATION was a 2-tap RGB split. On a 2-4 px corrugation comb
//     the R and B taps land on DIFFERENT RIBS, so the pass synthesises
//     saturated colours the source never contained. It is now a normalised
//     5-tap SPECTRAL SWEEP, which is a convex combination of source samples and
//     therefore cannot invent a hue, gated off high-frequency content and off
//     the frame centre (lateral CA is zero on the optical axis by definition).
//   * RCAS's min/max limiter is STRUCTURALLY INERT on a periodic comb - the
//     5-tap neighbourhood already spans the comb's full range, so the clamp
//     never binds - and its silhouette guard was measured on ABSOLUTE encoded
//     contrast, which a 02:00 frame never reaches. Both fixed: the guard is
//     key-normalised and a local extremum along both axes is skipped outright.
//
// Everything else that changed this round is gated exactly the way the block
// above describes: uCASpectral, uPivotTrack, uHighWarmGate, uFlareAspect,
// uKeyFlash, uKnD, uExtGate and uPracCount are all authored so their market
// defaults are the character-for-character expressions they replaced, and
// street.png differences to zero against the frozen reference on all 2.76 M
// bytes after the round, md5 included.
//
// ----------------------------------------------------------------------------
// LEVELS 3-10: THE GRADE BECOMES DATA
// ----------------------------------------------------------------------------
// Ten levels graded by one look are one level with different props, so the
// per-level look moved out of code and into a table:
//
//   setGradePreset(name)   'warm' (the market) | 'sunset' | 'night' (the harbor
//                          storm) | 'cold' | 'green' | 'bleach' | 'alarm' |
//                          'verdant' | 'sodium' | 'dawn'. Level ids and the
//                          legacy 'market'/'storm' spellings are aliases. An
//                          unknown name is logged and ignored, never fatal.
//   setExposureBias(n)     a trim in STOPS on the PRINT gain, applied downstream
//                          of the adaptation loop so the meter cannot be
//                          destabilised by it.
//
// Two structural rules make this safe for the frozen levels:
//
//   * a preset is "restore the authored default, then overlay this table",
//     never a diff. 'warm' is therefore the EMPTY overlay - reproducing the
//     market is a property of the mechanism, not a set of numbers that has to
//     be kept in sync with the settings block. 'night' is STORM_GRADE, the same
//     object level 2 has always applied, applied by the same loop, from the
//     same starting state (the constructor calls it before anything has moved),
//     so the restore is the identity there.
//   * the three genuinely new knobs needed by the new presets - midSat,
//     sunLensGate, volumePracticals - all default to an exact no-op, and midSat
//     is a uniform-controlled BRANCH rather than a mix, because mix(x, x, t) is
//     not bit-exact and this module's regression gate is a byte comparison.
//
// The other thing levels 3-10 needed from this file is that NOTHING here may
// assume a sky. Two paths did. The sun streak and the flare ghosts fire on the
// projected key-light direction alone, and with no sky that direction is a
// fallback constant pointing at an imaginary sun inside a buried corridor; the
// volumetric march is key-only, and a key-only march on a level whose key is
// dark contributes literally nothing (measured on the harbor, by A/B). Both are
// now openable by a preset, both still default to exactly the shipped path.
// Metering is the third: see GREEN_GRADE for the three separate mechanisms that
// drive an enclosed frame to a grey wash, and how each is bounded.
//
// ----------------------------------------------------------------------------
// LEVELS 3-10, BATCH 2: THE THREE THINGS A LEVEL FILE COULD NOT SAY
// ----------------------------------------------------------------------------
// Four findings from the metro / boneyard / refinery / ruins critics needed a
// capability that did not exist here. Two of them are new public API and both
// are OFF unless something asks for them:
//
//   postfx.setHeatShimmer({y, strength, cells:[{x,z,r}]})
//       A gated screen-space refraction through the layer of hot air on a
//       sun-baked slab - see pfHeatShimmer in FRAG_COMPOSITE. There was no
//       shimmer capability in the build at all; the boneyard has published
//       `level.heatShimmer` since it was built and nothing read it. update()
//       now reads it directly, so a level opts in by publishing the record and
//       needs no call and no knowledge of this file. Masked in world space by
//       height band, by the level's own cells and by line-of-sight length, and
//       the viewmodel is excluded outright. Pass null to force it off.
//
//   pose.focus  (on level.cameraPoses[key], honoured during capture only)
//   postfx.setFocus(metres | 'hyperfocal')
//       The autofocus raycasts the crosshair and falls back to a 12 m GAMEPLAY
//       focus when the ray misses - which on an establishing shot standing 30 m
//       over a 330 m site prints a tilt-shift model railway, and the only lever
//       a level had was to move its aim point until the ray happened to hit
//       something (see the comment at level_refinery.js:5321, written when
//       exactly that happened). A pose may now state its own focus and it is
//       LOCKED, not damped, so a 1.5 s capture lands on it.
//
// The other two are preset data: DAWN_GRADE and GREEN_GRADE re-state their
// grain (it was the dominant high-frequency signal on the stone and on the
// tunnel lining respectively) and SODIUM_GRADE moves to the spectral CA with a
// low-luminance roll-off (its lattice of aliased steel was being turned into
// cyan confetti by the two-tap split, 69x concentrated at the frame edge).
//
// All four are gated the same way as everything above them, and the claim is
// measured rather than argued: after the round, quay.png differences to ZERO
// against its pre-round capture on all 2.76 M bytes, and street.png differs by
// one least-significant bit on ONE of its 921,600 pixels - shader-recompilation
// rounding in the sky gradient, reproduced with the new code multiplied by zero,
// and the only cost of adding any instruction at all to FRAG_COMPOSITE.
//
// ----------------------------------------------------------------------------
// LEVELS 3-10, BATCH 3: THE LENS, THE HEAT LAYER AND THE SHOULDER
// ----------------------------------------------------------------------------
// Four findings from the highrise / boneyard / ruins critics. Three of them are
// PRESET DATA and touch one level each; the fourth needed a gate the preset name
// could not carry, and the interesting part of this round is why.
//
//   * DAWN_GRADE's medium is now a GROUND MIST rather than a height-uniform
//     haze (volumeHeightFalloff 0.075 -> 0.60, base -1.5 -> 0.0, and
//     volumeDensityAbs carrying the optical thickness at eye height back to
//     where it was). Both of the ruins' named features - the mist and the god
//     rays - were measurably absent, and this was why: a shaft has no brightness
//     of its own, its entire contrast is the density gradient it passes through.
//     See DAWN_GRADE and the volumeDensityAbs branch in _render.
//   * BLEACH_GRADE's highlight shoulder started two stops over mid and
//     asymptoted at eleven, so it was a plateau, not a roll-off: six published
//     frames, blown_white 0.00% on every one, in a high-noon desert built out of
//     34 aluminium airframes. 3.20 / 7.00 still protects the sky gradient the
//     preset was written to protect and still lets a sunlit crest clip.
//   * the HEAT SHIMMER gained the half of the effect that the eye actually reads
//     as heat. The displacement was 3.1 px and confined to four discs on a
//     204 x 168 m slab; it is now 7.6 px over the whole slab, and it carries an
//     INFERIOR MIRAGE - uHeatPale / uHeatLift / uHeatSky, which lift the far
//     ground to sky radiance and take the chroma out of it. Three new settings,
//     all 0 or inert by default, all read only from inside the uHeat branch that
//     no level without a published heatShimmer record ever opens.
//   * the CHROMATIC ABERRATION on Meridian Tower. The two-tap RGB split fringes
//     hard silhouettes and shatters isolated speculars into single-channel dots;
//     the spectral sweep already in this file fixes both and four presets already
//     use it. But highrise's env profile asks for grade:'warm' - the MARKET's own
//     preset - so the preset name cannot separate "fix the tower" from "move
//     level 1". The gate is therefore stated on the axis main.js already draws:
//     env:null (legacy, self-configuring, frozen) versus a declarative env
//     profile. GRADE_MODERN_LENS redirects a legacy grade to its current-lens
//     twin for declarative levels only, and market never executes the line at
//     all because applyEnv returns early on env:null. See SUNSET_GRADE.
//
// ----------------------------------------------------------------------------
// LEVELS 3-10, BATCH 4: WHAT THE HEAT LAYER BANDS ON, AND TWO MISSING PATHS
// ----------------------------------------------------------------------------
// Four findings from eight level owners. Two are defects in code this file
// already owned; two are capabilities that did not exist here at all.
//
//   1. THE TWO HALVES OF THE HEAT EFFECT ARE NOW SEPARATELY SCALED. uHeat (the
//      boil) and uHeatPale (the inferior mirage) were both written as
//      (setting x heat.strength), so a level asking for a readable displacement
//      was forced to accept a proportional paint-over of its own far field. The
//      record's new `mirage` field defaults to `strength`, so nothing published
//      before this moves. See normaliseHeat.
//
//   2. THE MIRAGE BANDED ON THE WRONG QUANTITY, and this was the expensive one.
//      Its mask was the LIT SURFACE's height above the layer times the
//      straight-line distance to it - two properties of the far end of the ray -
//      when an inferior mirage is an integral ALONG the ray. The boneyard's
//      establishing pose stands on a catwalk 19.6 m up and was therefore taking
//      the mirage at full strength over ground it was looking at through ~24 m of
//      a 3.2 m layer, while a framing at eye height looks through 100 m of it and
//      got exactly the same amount. pfHeatPath now clips the segment to the layer
//      analytically and integrates the layer's own density over it, and
//      uHeatD0/D1 are metres of hot air rather than metres to the surface.
//      MEASURED, boneyard, same code otherwise, byte-deterministic captures:
//        lv_overview  dynamic_range 0.6666 -> 0.7463, edge_energy 0.10834 ->
//                     0.13094 (+20.9%), flat_area 40.24% -> 37.18%. The level's
//                     own A/B for "mirage off entirely" reported edge_energy
//                     0.1311, so this recovers essentially all of it.
//        lv_hero1     mean 0.3729 -> 0.3733, range 0.8094 -> 0.8092, edges
//                     0.13038 -> 0.13015. A ground-level eye looking at ground
//                     has path == distance, so the near-field framings do not
//                     move: 6.7% of that frame's pixels changed and all of them
//                     are in the one horizon band where the ray really does cross
//                     70 m of hot air.
//
//   3. A DEPTH-AWARE SOFT-PARTICLE PATH (sceneDepthUniforms, softParticleFade,
//      FRAG_SOFTDEPTH). postfx owns the depth buffer and could not hand it over -
//      the attachment is bound to the framebuffer the scene pass is drawing into,
//      so sampling it there is a feedback loop. It now publishes a linearised
//      half-res COLOUR copy plus the GLSL to fade against it, allocated and
//      dispatched only if a level asks. ruins had given up on this and was
//      maintaining a hand-written keep-out list of every wall and tower instead.
//      MEASURED, metro, two identical cards cutting through an opaque box at 45
//      degrees: the unpatched card's intersection is an 11-13 px cut, the patched
//      one fades over 52-61 px, monotone.
//
//   4. BLOOM CANNOT ROUND OFF A CLIPPED EMISSIVE QUAD, and no post pass can -
//      there is no gradient inside a constant, and every candidate fix is
//      arithmetically dead (see makeGlowProfile for the three of them and why).
//      What was missing was the card, so glowTexture/glowCardMaterial provide the
//      radial profile calibrated against this file's own threshold, clamp and
//      white point. MEASURED, metro, two 1.8 m quads at identical peak radiance:
//      the flat one prints a 10-90% edge of 4 px and fills 0.924 of its bounding
//      box (a rectangle with intact corners); the profiled one prints a 19-31 px
//      edge and fills 0.656 (a disc).
//
// Gated exactly as every block above: street.png and quay.png are md5-identical
// to their pre-round captures at 422/4,201,372 and 270/2,047,292 draws/tris.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

  // The most world-space "hot cells" the heat shimmer will carry (see
  // PostFX.prototype.setHeatShimmer). Shared between the shader's array
  // declaration and the JS that fills it so the two cannot drift apart.
  var HEAT_CELL_MAX = 6;

  // vec3[PF_HEAT_CELLS] as (x, z, radius). Allocated once; _render writes into
  // it in place, so a shimmering level costs no allocation per frame.
  function makeHeatCellArray() {
    var a = [];
    for (var i = 0; i < HEAT_CELL_MAX; i++) a.push(new THREE.Vector3(0, 0, 1));
    return a;
  }

  // A number if it is one and it is finite, clamped; otherwise the fallback,
  // UNCLAMPED. Used for optional record fields where "absent" and "0" must stay
  // distinguishable, so the fallback may legitimately be null.
  function heatNum(v, lo, hi, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return M.clamp(v, lo, hi);
  }

  /**
   * Validate a heat-shimmer record into the shape _render writes to the GPU, or
   * null if it does not describe anything. Defensive by construction: this is
   * fed straight from level data written by another agent, so every field is
   * optional, every number is clamped, and anything malformed degrades to "no
   * shimmer" rather than to a NaN in the composite's UV.
   *
   * THE TWO HALVES OF THE EFFECT ARE SEPARATELY SCALED. `strength` used to scale
   * BOTH uHeat (the displacement) and uHeatPale (the inferior mirage), which is
   * not a coupling anything physical justifies - the boil is the variance of the
   * refractive-index field and the mirage is its mean gradient, and a level can
   * legitimately want a lot of one and none of the other. It cost the boneyard
   * its establishing frame for a round (see level_boneyard.js:4684, which
   * measured flat_area 55.63 against a 45.0 limit and traced it here): asking
   * for a readable boil at strength 1.70 forced BLEACH_GRADE's heatPale 0.55 to
   * run at 0.935, i.e. a 94% paint-over of the far field. `mirage` is now its own
   * scalar and DEFAULTS TO `strength`, so a record written before this existed
   * behaves exactly as it did.
   *
   * @param {{y:Number, strength:Number, mirage:Number, cells:Array,
   *          pathNear:Number, pathFar:Number}} cfg
   * @returns {{y:Number, strength:Number, mirage:Number, pathNear:Number|null,
   *           pathFar:Number|null, cells:Array<Array<Number>>}|null}
   */
  function normaliseHeat(cfg) {
    if (!cfg) return null;
    var strength = (typeof cfg.strength === 'number' && isFinite(cfg.strength))
      ? M.clamp(cfg.strength, 0, 2) : 1;
    // The mirage scalar. Independent of `strength`, but defaulting to it, so the
    // published records that predate the split are bit-identical.
    var mirage = heatNum(cfg.mirage, 0, 2, strength);
    // strength 0 with a mirage still asked for is a legitimate request (mirage
    // only, no boil), so the early-out has to consider both.
    if (strength <= 1e-4 && mirage <= 1e-4) return null;
    var y = (typeof cfg.y === 'number' && isFinite(cfg.y)) ? cfg.y : 0;
    // Optional per-level overrides of the two path-length thresholds, in metres
    // of hot air traversed. null = take the grade preset's (settings.heatNear /
    // settings.heatFar), which is what every existing record does.
    var pathNear = heatNum(cfg.pathNear, 0.5, 2000, null);
    var pathFar = heatNum(cfg.pathFar, 1.5, 4000, null);
    var out = [];
    var src = cfg.cells;
    if (src && src.length) {
      for (var i = 0; i < src.length && out.length < HEAT_CELL_MAX; i++) {
        var c = src[i];
        if (!c) continue;
        var cx = +c.x, cz = +c.z, cr = +c.r;
        if (!isFinite(cx) || !isFinite(cz) || !isFinite(cr) || cr <= 0) continue;
        out.push([cx, cz, M.clamp(cr, 0.5, 4000)]);
      }
      // Cells were supplied but none of them parsed: that is a malformed record,
      // not a request for a level-wide shimmer, so it is off rather than global.
      if (!out.length) return null;
    }
    return {
      y: y, strength: strength, mirage: mirage,
      pathNear: pathNear, pathFar: pathFar, cells: out
    };
  }

  // ==========================================================================
  // Shared GLSL
  // ==========================================================================

  var VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = vec4( position.xy, 0.0, 1.0 );',
    '}'
  ].join('\n');

  // Common helpers. NOTE: three injects a `luminance()` function into every
  // ShaderMaterial fragment prefix, so everything here is prefixed `pf` to
  // avoid a redefinition error.
  var COMMON = [
    '#define PF_PI 3.141592653589793',
    'varying vec2 vUv;',
    '',
    'float pfLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }',
    'float pfMax3( vec3 c ) { return max( c.x, max( c.y, c.z ) ); }',
    '',
    '// A single NaN or Inf poisons every downstream blur, so every HDR fetch is',
    '// funnelled through this. min/max against a finite bound also flushes NaN',
    '// on every driver we care about.',
    'vec3 pfSafe( vec3 c ) { return min( max( c, vec3( 0.0 ) ), vec3( 60000.0 ) ); }',
    '',
    '// Interleaved gradient noise (Jimenez). Blue-noise-ish, free, and it',
    '// decorrelates cleanly once TAA averages it across frames.',
    'float pfIGN( vec2 p ) {',
    '  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );',
    '}',
    '// R2 low-discrepancy sequence - used to advance dither patterns per frame',
    '// without them resonating with the TAA history.',
    'float pfR2( float n ) { return fract( n * 0.7548776662466927 ); }',
    'float pfR2b( float n ) { return fract( n * 0.5698402909980532 ); }',
    '',
    'vec3 pfRGBToYCoCg( vec3 c ) {',
    '  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,',
    '               0.5 * c.r - 0.5 * c.b,',
    '              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );',
    '}',
    'vec3 pfYCoCgToRGB( vec3 c ) {',
    '  return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z );',
    '}'
  ].join('\n');

  // Depth helpers. Requires uNear/uFar (and uInvProj for the view-space form).
  var DEPTH = [
    'uniform float uNear;',
    'uniform float uFar;',
    '// Window-space hyperbolic depth -> positive distance along the view axis.',
    'float pfLinearDepth( float d ) {',
    '  float z = d * 2.0 - 1.0;',
    '  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );',
    '}'
  ].join('\n');

  var VIEWPOS = [
    'uniform mat4 uInvProj;',
    'vec3 pfViewPos( vec2 uv, float d ) {',
    '  vec4 c = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );',
    '  vec4 v = uInvProj * c;',
    '  return v.xyz / v.w;',
    '}'
  ].join('\n');

  var WORLDPOS = [
    'uniform mat4 uInvViewProj;',
    'vec3 pfWorldPos( vec2 uv, float d ) {',
    '  vec4 c = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );',
    '  vec4 w = uInvViewProj * c;',
    '  return w.xyz / w.w;',
    '}'
  ].join('\n');

  function glsl() {
    return Array.prototype.slice.call(arguments).join('\n');
  }

  // ==========================================================================
  // Fragment shaders
  // ==========================================================================

  // ---- velocity ------------------------------------------------------------
  // Camera-only motion vectors, in UV units, pointing from this frame's pixel
  // back to where that world point sat last frame. Both matrices carry their
  // frame's TAA jitter so the reprojection lands on the exact raster sample the
  // history actually contains.
  var FRAG_VELOCITY = glsl(
    COMMON, WORLDPOS,
    'uniform sampler2D tDepth;',
    'uniform mat4 uPrevViewProj;',
    'void main() {',
    '  float d = texture2D( tDepth, vUv ).x;',
    '  vec3 wp = pfWorldPos( vUv, d );',
    '  vec4 p = uPrevViewProj * vec4( wp, 1.0 );',
    '  vec2 prevUv = ( p.xy / max( p.w, 1e-6 ) ) * 0.5 + 0.5;',
    '  vec2 v = vUv - prevUv;',
    '  // Guard against the degenerate first frame / bad matrices.',
    '  if ( abs( v.x ) > 0.9 || abs( v.y ) > 0.9 ) v = vec2( 0.0 );',
    '  gl_FragColor = vec4( v, d, 1.0 );',
    '}'
  );

  // ---- GTAO ----------------------------------------------------------------
  // Ground-truth ambient occlusion: horizon search per slice, then the closed
  // form arc integral. Output is (visibility, viewZ, contact) so the bilateral
  // blur and the upsample get their depth reference for free.
  //
  // TWO terms come out of the same horizon search for almost no extra cost:
  //   .x  full-radius AO      - an occlusion term on INDIRECT light, so the
  //                             resolve masks it off sunlit surfaces.
  //   .z  contact AO          - the horizons after only the first three steps,
  //                             which (because the step distribution is t*t)
  //                             covers ~17% of the radius, i.e. ~14 cm. That is
  //                             micro-geometry occlusion and it is physically
  //                             valid on DIRECT light too, so the resolve
  //                             applies it unconditionally. Without it the
  //                             direct mask deleted every contact notch in the
  //                             frame and wall/floor junctions read as a single
  //                             continuous surface.
  var FRAG_GTAO = glsl(
    COMMON, DEPTH, VIEWPOS,
    'uniform sampler2D tDepth;',
    'uniform sampler2D tBlue;',
    'uniform mat4 uProj;',
    'uniform vec2 uTexel;',
    'uniform vec2 uRes;',
    'uniform vec2 uBlueScale;',
    'uniform float uRadius;',
    'uniform float uIntensity;',
    'uniform float uFalloff;',
    'uniform float uFadeStart;',
    'uniform float uFadeEnd;',
    'uniform float uFrame;',
    'uniform int uDirs;',
    'uniform int uSteps;',
    '',
    'const int PF_MAX_DIRS = 4;',
    'const int PF_MAX_STEPS = 8;',
    '',
    '// Best-fit normal from depth: pick whichever neighbour lies on the same',
    '// surface (smallest depth delta) so silhouettes do not smear a bogus',
    '// normal across the edge.',
    'vec3 pfNormalFromDepth( vec2 uv, vec3 P ) {',
    '  vec2 t = uTexel;',
    '  vec3 Pr = pfViewPos( uv + vec2( t.x, 0.0 ), texture2D( tDepth, uv + vec2( t.x, 0.0 ) ).x );',
    '  vec3 Pl = pfViewPos( uv - vec2( t.x, 0.0 ), texture2D( tDepth, uv - vec2( t.x, 0.0 ) ).x );',
    '  vec3 Pu = pfViewPos( uv + vec2( 0.0, t.y ), texture2D( tDepth, uv + vec2( 0.0, t.y ) ).x );',
    '  vec3 Pd = pfViewPos( uv - vec2( 0.0, t.y ), texture2D( tDepth, uv - vec2( 0.0, t.y ) ).x );',
    '  vec3 dx = abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ? ( Pr - P ) : ( P - Pl );',
    '  vec3 dy = abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ? ( Pu - P ) : ( P - Pd );',
    '  vec3 n = cross( dx, dy );',
    '  float l = length( n );',
    '  if ( l < 1e-9 ) return vec3( 0.0, 0.0, 1.0 );',
    '  n /= l;',
    '  if ( dot( n, P ) > 0.0 ) n = -n;',
    '  return n;',
    '}',
    '',
    '// Closed-form visibility arc for one slice given its two horizon cosines.',
    'float pfArc( float c1, float c2, float nAngle ) {',
    '  float h1 = -acos( clamp( c1, -1.0, 1.0 ) );',
    '  float h2 =  acos( clamp( c2, -1.0, 1.0 ) );',
    '  // Clamp the horizons into the hemisphere around the normal.',
    '  h1 = nAngle + max( h1 - nAngle, -PF_PI * 0.5 );',
    '  h2 = nAngle + min( h2 - nAngle,  PF_PI * 0.5 );',
    '  float sinN = sin( nAngle );',
    '  float cosN = cos( nAngle );',
    '  return 0.25 * ( -cos( 2.0 * h1 - nAngle ) + cosN + 2.0 * h1 * sinN )',
    '       + 0.25 * ( -cos( 2.0 * h2 - nAngle ) + cosN + 2.0 * h2 * sinN );',
    '}',
    '',
    'void main() {',
    '  float d = texture2D( tDepth, vUv ).x;',
    '  if ( d >= 0.9999995 ) { gl_FragColor = vec4( 1.0, uFar, 1.0, 1.0 ); return; }',
    '',
    '  vec3 P = pfViewPos( vUv, d );',
    '  float viewZ = -P.z;',
    '  // Depth precision collapses in the distance; a noisy AO term out there',
    '  // reads as dirt on the lens, so fade the effect out instead.',
    '  float distFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, viewZ );',
    '  if ( distFade <= 0.001 ) { gl_FragColor = vec4( 1.0, viewZ, 1.0, 1.0 ); return; }',
    '',
    '  vec3 V = normalize( -P );',
    '  vec3 N = pfNormalFromDepth( vUv, P );',
    '',
    '  vec4 bn = texture2D( tBlue, gl_FragCoord.xy * uBlueScale );',
    '  float rotJ  = fract( bn.x + pfR2( uFrame ) );',
    '  float stepJ = fract( bn.y + pfR2b( uFrame ) );',
    '',
    '  // Pixels per world unit at unit view distance.',
    '  float projScale = uProj[1][1] * 0.5 * uRes.y;',
    '  float radiusPx = clamp( uRadius * projScale / max( viewZ, 0.05 ), 3.0, 110.0 );',
    '  float falloffStart = uRadius * uFalloff;',
    '',
    '  float visibility = 0.0;',
    '  float visNear = 0.0;',
    '  float weight = 0.0;',
    '  float dirCount = float( uDirs );',
    '',
    '  for ( int i = 0; i < PF_MAX_DIRS; i++ ) {',
    '    if ( i >= uDirs ) break;',
    '    float phi = ( float( i ) + rotJ ) * PF_PI / dirCount;',
    '    vec2 dir = vec2( cos( phi ), sin( phi ) );',
    '    vec3 sliceDir = vec3( dir, 0.0 );',
    '',
    '    vec3 axis = cross( sliceDir, V );',
    '    float axisLen = length( axis );',
    '    if ( axisLen < 1e-5 ) continue;',
    '    axis /= axisLen;',
    '    vec3 T = normalize( cross( axis, V ) );',
    '',
    '    vec3 projN = N - axis * dot( N, axis );',
    '    float projNLen = length( projN );',
    '    if ( projNLen < 1e-4 ) continue;',
    '    vec3 projNn = projN / projNLen;',
    '    float nAngle = atan( dot( projNn, T ), dot( projNn, V ) );',
    '',
    '    float cosH1 = -1.0;',   // -dir side
    '    float cosH2 = -1.0;',   // +dir side
    '    float cosH1n = -1.0;',  // -dir, contact radius only
    '    float cosH2n = -1.0;',  // +dir, contact radius only
    '',
    '    for ( int s = 0; s < PF_MAX_STEPS; s++ ) {',
    '      if ( s >= uSteps ) break;',
    '      float t = ( float( s ) + stepJ + 0.5 ) / float( uSteps );',
    '      t *= t;',                 // bias samples toward contact
    '      vec2 off = dir * ( t * radiusPx ) * uTexel;',
    '',
    '      vec2 uvA = vUv + off;',
    '      vec2 uvB = vUv - off;',
    '',
    '      float dA = texture2D( tDepth, uvA ).x;',
    '      float dB = texture2D( tDepth, uvB ).x;',
    '      vec3 SA = pfViewPos( uvA, dA );',
    '      vec3 SB = pfViewPos( uvB, dB );',
    '      vec3 DA = SA - P;',
    '      vec3 DB = SB - P;',
    '      float lA = length( DA );',
    '      float lB = length( DB );',
    '',
    '      float cA = lA > 1e-5 ? dot( DA, V ) / lA : -1.0;',
    '      float cB = lB > 1e-5 ? dot( DB, V ) / lB : -1.0;',
    '',
    '      // Fade a sample back to the running horizon as it leaves the radius,',
    '      // otherwise distant geometry pops in as a hard occlusion ring.',
    '      float fA = clamp( ( lA - falloffStart ) / max( uRadius - falloffStart, 1e-4 ), 0.0, 1.0 );',
    '      float fB = clamp( ( lB - falloffStart ) / max( uRadius - falloffStart, 1e-4 ), 0.0, 1.0 );',
    '      cA = mix( cA, cosH2, fA );',
    '      cB = mix( cB, cosH1, fB );',
    '',
    '      if ( uvA.x >= 0.0 && uvA.x <= 1.0 && uvA.y >= 0.0 && uvA.y <= 1.0 ) cosH2 = max( cosH2, cA );',
    '      if ( uvB.x >= 0.0 && uvB.x <= 1.0 && uvB.y >= 0.0 && uvB.y <= 1.0 ) cosH1 = max( cosH1, cB );',
    '      // Snapshot the running horizons while the search is still inside the',
    '      // contact radius. Free - no extra taps, no extra sampler.',
    '      if ( s < 3 ) { cosH1n = cosH1; cosH2n = cosH2; }',
    '    }',
    '',
    '    visibility += projNLen * pfArc( cosH1, cosH2, nAngle );',
    '    visNear    += projNLen * pfArc( cosH1n, cosH2n, nAngle );',
    '    weight     += projNLen;',
    '  }',
    '',
    '  // NORMALISE BY THE SUMMED PROJECTED-NORMAL WEIGHT, not by the slice count.',
    '  //',
    '  // This is the single most important line in the pass. projNLen is the',
    '  // length of N projected into the slice plane and it is < 1 for every slice',
    '  // that does not contain N - typically ~0.8 averaged over four slices on a',
    '  // flat wall facing the camera. Dividing the weighted arc sum by uDirs',
    '  // therefore returns ~0.8 visibility on a surface with NOTHING occluding it,',
    '  // and pow(0.8, 1.35) then prints that as a 17% darkening. The result is an',
    '  // occlusion term that behaves as a flat global multiply: measured against',
    '  // an A/B capture it darkened 39-59% of the frame with a median of 14-20%',
    '  // and left the actual wall/floor notch depth unchanged to within 0.6%. That',
    '  // is a micro-contrast tax, not ambient occlusion.',
    '  //',
    '  // Dividing by the same weights that were applied makes an unoccluded',
    '  // surface read exactly 1.0, so every bit of darkening that survives is',
    '  // real geometric occlusion and lands where the geometry is concave.',
    '  float wnorm = max( weight, 1e-4 );',
    '  float valid = step( 1e-4, weight );',
    '  float ao = clamp( visibility / wnorm, 0.0, 1.0 );',
    '  ao = mix( 1.0, pow( ao, uIntensity ), valid );',
    '  ao = mix( 1.0, ao, distFade );',
    '  float aoNear = clamp( visNear / wnorm, 0.0, 1.0 );',
    '  aoNear = mix( 1.0, pow( aoNear, uIntensity ), valid );',
    '  aoNear = mix( 1.0, aoNear, distFade );',
    '  gl_FragColor = vec4( ao, viewZ, aoNear, 1.0 );',
    '}'
  );

  // ---- separable depth-aware blur for AO -----------------------------------
  var FRAG_AO_BLUR = glsl(
    COMMON,
    'uniform sampler2D tAO;',
    'uniform vec2 uStep;',
    'uniform float uDepthSigma;',
    'void main() {',
    '  vec4 c = texture2D( tAO, vUv );',
    '  float z0 = c.y;',
    '  // Both AO terms ride the same bilateral weights: the contact term has to',
    '  // respect silhouettes exactly as the wide term does.',
    '  vec2 sum = vec2( c.x, c.z );',
    '  float wsum = 1.0;',
    '  for ( int i = 1; i <= 4; i++ ) {',
    '    float fi = float( i );',
    '    float g = exp( -fi * fi * 0.17 );',
    '    vec2 o = uStep * fi;',
    '    vec4 a = texture2D( tAO, vUv + o );',
    '    vec4 b = texture2D( tAO, vUv - o );',
    '    float wa = g * exp( -abs( a.y - z0 ) * uDepthSigma );',
    '    float wb = g * exp( -abs( b.y - z0 ) * uDepthSigma );',
    '    sum += vec2( a.x, a.z ) * wa + vec2( b.x, b.z ) * wb;',
    '    wsum += wa + wb;',
    '  }',
    '  sum /= max( wsum, 1e-5 );',
    '  gl_FragColor = vec4( sum.x, z0, sum.y, 1.0 );',
    '}'
  );

  // ---- volumetric light ----------------------------------------------------
  // World-space raymarch through a height-fog medium. Occlusion is sampled
  // straight out of the cascaded shadow maps lighting.js already rendered, so
  // the geometry that carves a shaft does not have to be on screen - which is
  // the whole reason screen-space probes never produced one. Blue-noise offsets
  // keep the low step count from banding; TAA removes what is left.
  var FRAG_VOLUME = glsl(
    COMMON, DEPTH, WORLDPOS,
    'uniform sampler2D tDepth;',
    'uniform sampler2D tBlue;',
    'uniform sampler2D uShadowMap[ 4 ];',
    'uniform mat4 uShadowMatrix[ 4 ];',
    'uniform mat4 uViewProj;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunColor;',
    'uniform vec2 uBlueScale;',
    'uniform float uDensity;',
    'uniform float uHeightFalloff;',
    'uniform float uBaseHeight;',
    'uniform float uAnisotropy;',
    'uniform float uMaxDist;',
    'uniform float uShadowBias;',
    'uniform float uFrame;',
    'uniform float uTime;',
    'uniform int uSteps;',
    'uniform int uShadowTaps;',
    'uniform int uShadowCount;',
    // ---- LOCAL PRACTICALS (harbor only; uPracCount is 0 everywhere else, so
    // the loop below never executes and a market frame is bit-identical).
    'uniform vec4 uPracPos[ 6 ];',    // xyz world position, w cutoff distance
    'uniform vec4 uPracCol[ 6 ];',    // rgb radiance x gain, w cos(outer) or -2 for a point
    'uniform vec4 uPracAxis[ 6 ];',   // xyz spot axis (light -> target), w cos(inner)
    'uniform float uMaxInscatter;',
    'uniform int uPracCount;',
    '',
    'const int PF_VOL_MAX = 32;',
    'const int PF_SHADOW_MAX = 3;',
    'const int PF_PRAC_MAX = 6;',
    'const int PF_PRAC_SAMPLES = 3;',
    '',
    '// three packs directional shadow depth into RGBA8 via packDepthToRGBA().',
    '// These are exactly UnpackFactors4 from three/src/renderers/shaders/',
    '// ShaderChunk/packing.glsl - getting them wrong silently returns garbage.',
    'const vec4 PF_UNPACK = vec4( 0.99609375, 0.0038909912109375,',
    '                             0.0000151991844177, 0.0000000596046448 );',
    'float pfUnpackDepth( vec4 v ) { return dot( v, PF_UNPACK ); }',
    '',
    '// Sun visibility from the CSM: walk the cascades outward and take the first',
    '// one that actually contains the sample. Binary per step - that hard edge is',
    '// what makes a shaft read as a shaft instead of a gradient.',
    'float pfCsmVisibility( vec3 P ) {',
    '  for ( int i = 0; i < 4; i++ ) {',
    '    if ( i >= uShadowCount ) break;',
    '    vec4 sc = uShadowMatrix[ i ] * vec4( P, 1.0 );',
    '    vec3 c = sc.xyz / max( abs( sc.w ) < 1e-6 ? 1e-6 : sc.w, 1e-6 );',
    '    if ( c.x < 0.004 || c.x > 0.996 || c.y < 0.004 || c.y > 0.996 ) continue;',
    '    if ( c.z < 0.0 || c.z > 1.0 ) continue;',
    '    float d;',
    '    if ( i == 0 )      d = pfUnpackDepth( texture2D( uShadowMap[ 0 ], c.xy ) );',
    '    else if ( i == 1 ) d = pfUnpackDepth( texture2D( uShadowMap[ 1 ], c.xy ) );',
    '    else if ( i == 2 ) d = pfUnpackDepth( texture2D( uShadowMap[ 2 ], c.xy ) );',
    '    else               d = pfUnpackDepth( texture2D( uShadowMap[ 3 ], c.xy ) );',
    '    return step( c.z - uShadowBias, d );',
    '  }',
    '  // Past the last cascade there is no shadow data; lit is the only sane guess.',
    '  return 1.0;',
    '}',
    '',
    '// Henyey-Greenstein: forward scattering is what makes dust glow toward the sun.',
    'float pfHG( float c, float g ) {',
    '  float g2 = g * g;',
    '  float denom = 1.0 + g2 - 2.0 * g * c;',
    '  return ( 1.0 - g2 ) / ( 4.0 * PF_PI * max( denom * sqrt( max( denom, 1e-4 ) ), 1e-4 ) );',
    '}',
    '',
    '// Cheap 3D value noise for dust density variation. Enough structure that',
    '// the shafts get texture instead of reading as flat cones.',
    'float pfHash3( vec3 p ) {',
    '  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );',
    '  p *= 17.0;',
    '  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );',
    '}',
    'float pfNoise3( vec3 p ) {',
    '  vec3 i = floor( p );',
    '  vec3 f = fract( p );',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  return mix( mix( mix( pfHash3( i + vec3( 0.0, 0.0, 0.0 ) ), pfHash3( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),',
    '                   mix( pfHash3( i + vec3( 0.0, 1.0, 0.0 ) ), pfHash3( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),',
    '              mix( mix( pfHash3( i + vec3( 0.0, 0.0, 1.0 ) ), pfHash3( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),',
    '                   mix( pfHash3( i + vec3( 0.0, 1.0, 1.0 ) ), pfHash3( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );',
    '}',
    '',
    '// Screen-space shadow probe: step toward the sun and ask the depth buffer',
    '// whether anything already occupies that spot. Off-screen probes count as',
    '// lit - conservative, and the alternative (hard black) looks far worse.',
    'float pfSunVisibility( vec3 P, float rnd ) {',
    '  float vis = 1.0;',
    '  float taps = float( max( uShadowTaps, 1 ) );',
    '  float w = 1.0 / taps;',
    '  for ( int k = 0; k < PF_SHADOW_MAX; k++ ) {',
    '    if ( k >= uShadowTaps ) break;',
    '    float f = ( float( k ) + rnd ) / taps;',
    '    float sd = mix( 1.6, 34.0, f * f );',
    '    vec3 S = P + uSunDir * sd;',
    '    vec4 cp = uViewProj * vec4( S, 1.0 );',
    '    if ( cp.w <= 0.02 ) continue;',
    '    vec2 suv = cp.xy / cp.w * 0.5 + 0.5;',
    '    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;',
    '    float sceneZ = pfLinearDepth( texture2D( tDepth, suv ).x );',
    '    float sampleZ = cp.w;',
    '    // Thickness window: without an upper bound every distant wall shadows',
    '    // everything in front of it.',
    '    float dz = sampleZ - sceneZ;',
    '    if ( dz > 0.25 && dz < 22.0 ) vis -= w;',
    '  }',
    '  return max( vis, 0.0 );',
    '}',
    '',
    'void main() {',
    '  float d = texture2D( tDepth, vUv ).x;',
    '  vec3 wp = pfWorldPos( vUv, d );',
    '  vec3 ray = wp - uCamPos;',
    '  float sceneDist = length( ray );',
    '  if ( sceneDist < 1e-4 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }',
    '  vec3 rd = ray / sceneDist;',
    '  float maxD = min( sceneDist, uMaxDist );',
    '',
    '  vec4 bn = texture2D( tBlue, gl_FragCoord.xy * uBlueScale );',
    '  float jitter = fract( bn.z + pfR2( uFrame ) );',
    '  float shadowRnd = fract( bn.w + pfR2b( uFrame ) );',
    '',
    '  float stepLen = maxD / float( uSteps );',
    '  float phase = pfHG( dot( rd, uSunDir ), uAnisotropy );',
    '',
    '  vec3 acc = vec3( 0.0 );',
    '  float trans = 1.0;',
    '  vec3 wind = vec3( uTime * 0.16, uTime * 0.03, uTime * 0.09 );',
    '',
    '  for ( int i = 0; i < PF_VOL_MAX; i++ ) {',
    '    if ( i >= uSteps ) break;',
    '    float t = ( float( i ) + jitter ) * stepLen;',
    '    vec3 Pw = uCamPos + rd * t;',
    '',
    '    float h = max( Pw.y - uBaseHeight, 0.0 );',
    '    float dens = uDensity * exp( -h * uHeightFalloff );',
    '    dens *= 0.55 + 0.9 * pfNoise3( Pw * 0.075 + wind );',
    '    if ( dens < 1e-5 ) continue;',
    '',
    '    float vis = uShadowCount > 0',
    '      ? pfCsmVisibility( Pw )',
    '      : pfSunVisibility( Pw, fract( shadowRnd + float( i ) * 0.618034 ) );',
    '    float sigma = dens * stepLen;',
    '',
    '    // uSunColor already carries the sun irradiance, and pfHG is 1/4pi',
    '    // normalised, so this is the scattering integrand as written. There is',
    '    // deliberately NO ambient term: scene.fog already supplies the isotropic',
    '    // inscatter, and adding it again here is what produced the milky veil.',
    '    vec3 inscatter = uSunColor * phase * vis;',
    '    acc += inscatter * sigma * trans;',
    '    trans *= exp( -sigma * 0.9 );',
    '    if ( trans < 0.01 ) break;',
    '  }',
    '',
    // ---------------------------------------------------------------- locals
    // LOCAL PRACTICALS, EQUI-ANGULAR IMPORTANCE SAMPLED (Kulla & Conty).
    //
    // The march above is KEY-ONLY, and on a level whose key is a 0.19 moon that
    // makes the whole pass inert - measured, by capturing with it disabled and
    // differencing: not one pixel moved. A container terminal at 02:00 in a
    // downpour is lit by its sodium masts and by nothing else, so the medium
    // has to be lit by them too or there is no "cone through rain" at all.
    //
    // Marching the lamps at every step is the obvious implementation and the
    // wrong one: 32 steps x 6 lights is 192 evaluations for an integrand that
    // is a 1/d^2 spike, so almost every sample lands where the light is
    // negligible and the few that matter are undersampled - which prints as
    // crawling blotches exactly under the lamps. Equi-angular sampling draws t
    // from the distribution PROPORTIONAL TO 1/(D^2 + (t-h)^2), i.e. exactly the
    // falloff, so the 1/d^2 term cancels out of the estimator analytically and
    // three samples per light beat thirty-two uniform ones. It also makes the
    // cost O(lights), not O(lights x steps).
    //
    // Everything else about the term is deliberately three's OWN spot model -
    // the pow4 range window and the smoothstep(cosOuter, cosInner) cone - so
    // the air in the beam and the ground under it agree about where the beam
    // is. A volumetric that disagrees with the surface lighting reads as a
    // painted-on cone, which is the instant-fail this exists to avoid.
    '  if ( uPracCount > 0 ) {',
    '    float sigmaT = uDensity * 0.9;',
    '    for ( int li = 0; li < PF_PRAC_MAX; li++ ) {',
    '      if ( li >= uPracCount ) break;',
    '      vec3 Lp = uPracPos[ li ].xyz;',
    '      float range = uPracPos[ li ].w;',
    '      vec3 toL = Lp - uCamPos;',
    '      float hh = dot( toL, rd );',
    '      float perp2 = max( dot( toL, toL ) - hh * hh, 0.0 );',
    '      float r2 = range * range;',
    '      // The ray never enters this light\'s sphere of influence.',
    '      if ( perp2 >= r2 ) continue;',
    '      float halfC = sqrt( r2 - perp2 );',
    '      float t0 = max( hh - halfC, 0.0 );',
    '      float t1 = min( hh + halfC, maxD );',
    '      if ( t1 <= t0 + 1e-4 ) continue;',
    '',
    '      // Perpendicular distance, floored: standing INSIDE the beam sends D',
    '      // to zero and the estimator to infinity, which prints as a white',
    '      // disc that follows the player.',
    '      float D = max( sqrt( perp2 ), 0.40 );',
    '      float a0 = atan( ( t0 - hh ) / D );',
    '      float a1 = atan( ( t1 - hh ) / D );',
    '      float dA = a1 - a0;',
    '      if ( dA <= 1e-5 ) continue;',
    '',
    '      float cosOuter = uPracCol[ li ].w;',
    '      vec3 axis = uPracAxis[ li ].xyz;',
    '      float cosInner = uPracAxis[ li ].w;',
    '      float sum = 0.0;',
    '',
    '      for ( int k = 0; k < PF_PRAC_SAMPLES; k++ ) {',
    '        float u = ( float( k ) + jitter ) / float( PF_PRAC_SAMPLES );',
    '        float t = hh + D * tan( a0 + dA * u );',
    '        vec3 X = uCamPos + rd * t;',
    '        vec3 dv = Lp - X;',
    '        float dist = max( length( dv ), 0.05 );',
    '        vec3 Ld = dv / dist;',
    '        float wr = clamp( 1.0 - pow( dist / range, 4.0 ), 0.0, 1.0 );',
    '        wr *= wr;',
    '        if ( wr <= 0.0 ) continue;',
    '        if ( cosOuter > -1.5 ) {',
    '          wr *= smoothstep( cosOuter, cosInner, dot( -Ld, axis ) );',
    '          if ( wr <= 0.0 ) continue;',
    '        }',
    '        // STRONGLY forward scattering, and that is what keeps this term a',
    '        // beam instead of a veil. Rain and spray are large-particle Mie',
    '        // scatterers (g ~ 0.7-0.9): almost all of the light carries on in',
    '        // the direction it was already going, so you SEE a cone when you',
    '        // look into it and very little of it when you do not. Softening the',
    '        // phase toward isotropic - measured at g = 0.30 - spread the same',
    '        // energy over every viewing angle instead, which lifted the whole',
    '        // gangway framing 23% and cost it 14% of its edge energy: a veil,',
    '        // exactly the failure this pass exists to avoid.',
    '        float hg = pfHG( dot( rd, Ld ), uAnisotropy * 0.85 );',
    '        float dl = uDensity * exp( -max( X.y - uBaseHeight, 0.0 ) * uHeightFalloff );',
    '        sum += wr * hg * dl * exp( -sigmaT * t );',
    '      }',
    '',
    '      acc += uPracCol[ li ].rgb * ( sum * ( dA / ( D * float( PF_PRAC_SAMPLES ) ) ) );',
    '    }',
    '  }',
    '',
    // A HARD, HUE-PRESERVING CEILING ON THE WHOLE PASS. Every term above is a
    // product of numbers this module does not own (sun intensity, fog density,
    // and now lamp intensities from a rig in another agent's hands), so the one
    // guarantee worth having is that the volumetric can never be the thing that
    // saturates a frame. Scaling by the max channel keeps the emitter's hue.
    '  float amx = pfMax3( acc );',
    '  if ( amx > uMaxInscatter ) acc *= uMaxInscatter / max( amx, 1e-5 );',
    '',
    '  gl_FragColor = vec4( pfSafe( acc ), 1.0 );',
    '}'
  );

  // ---- volumetric bilateral upsample/blur ----------------------------------
  var FRAG_VOL_BLUR = glsl(
    COMMON, DEPTH,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tDepth;',
    'uniform vec2 uStep;',
    'void main() {',
    '  float z0 = pfLinearDepth( texture2D( tDepth, vUv ).x );',
    '  vec3 sum = texture2D( tSrc, vUv ).rgb;',
    '  float wsum = 1.0;',
    '  for ( int i = 1; i <= 4; i++ ) {',
    '    float fi = float( i );',
    '    float g = exp( -fi * fi * 0.18 );',
    '    vec2 o = uStep * fi;',
    '    float za = pfLinearDepth( texture2D( tDepth, vUv + o ).x );',
    '    float zb = pfLinearDepth( texture2D( tDepth, vUv - o ).x );',
    '    float wa = g * exp( -abs( za - z0 ) * 0.35 );',
    '    float wb = g * exp( -abs( zb - z0 ) * 0.35 );',
    '    sum += texture2D( tSrc, vUv + o ).rgb * wa + texture2D( tSrc, vUv - o ).rgb * wb;',
    '    wsum += wa + wb;',
    '  }',
    '  gl_FragColor = vec4( sum / wsum, 1.0 );',
    '}'
  );

  // ---- resolve: AO + inscattering into the HDR scene -----------------------
  var FRAG_RESOLVE = glsl(
    COMMON, DEPTH,
    'uniform sampler2D tScene;',
    'uniform sampler2D tAO;',
    'uniform sampler2D tVolume;',
    'uniform sampler2D tDepth;',
    'uniform sampler2D tExposure;',
    'uniform vec2 uAOTexel;',
    'uniform vec2 uVolTexel;',
    'uniform vec3 uAOTint;',
    'uniform float uAOStrength;',
    'uniform float uAODirectLo;',
    'uniform float uAODirectHi;',
    'uniform float uAOKeep;',
    'uniform float uAOContact;',
    'uniform float uVolumeIntensity;',
    'uniform float uExposureBias;',
    'uniform float uUseAO;',
    'uniform float uUseVolume;',
    'void main() {',
    '  vec3 color = pfSafe( texture2D( tScene, vUv ).rgb );',
    '  float z0 = pfLinearDepth( texture2D( tDepth, vUv ).x );',
    '',
    '  if ( uUseAO > 0.5 ) {',
    '    // Joint bilateral upsample: a plain bilinear fetch of a half-res AO',
    '    // buffer leaks occlusion across silhouettes and produces the classic',
    '    // dark outline around every object.',
    '    float ao = 0.0, aoNear = 0.0, wsum = 0.0;',
    '    for ( int y = -1; y <= 1; y++ ) {',
    '      for ( int x = -1; x <= 1; x++ ) {',
    '        vec2 o = vec2( float( x ), float( y ) ) * uAOTexel;',
    '        vec4 s = texture2D( tAO, vUv + o );',
    '        float w = exp( -abs( s.y - z0 ) * 1.6 ) * ( 1.0 - 0.18 * ( abs( float( x ) ) + abs( float( y ) ) ) );',
    '        ao += s.x * w; aoNear += s.z * w; wsum += w;',
    '      }',
    '    }',
    '    ao = wsum > 1e-5 ? ao / wsum : 1.0;',
    '    aoNear = wsum > 1e-5 ? aoNear / wsum : 1.0;',
    '',
    '    // AO is an occlusion term on *indirect* light only. Without a separate',
    '    // indirect buffer the honest approximation is: bright pixels are',
    '    // sun-lit (direct), dark pixels are sky/bounce-lit (indirect). Sunlit',
    '    // plaster therefore keeps its value and only the fill gets occluded.',
    '    //',
    '    // The threshold is EXPOSURE-RELATIVE. As absolute HDR luminance it fired',
    '    // on every sunlit exterior surface (sun intensity alone puts them past',
    '    // any fixed cutoff) and deleted the whole effect outdoors while still',
    '    // applying it to direct light indoors - wrong at both ends.',
    '    // The normaliser has to be the FULL print gain, not the metering term',
    '    // alone: the composite prints through exposure * uExposureBias, so a',
    '    // mask thresholded on the metering gain by itself drifts by the whole',
    '    // time-of-day bias (~35% between noon and night) against the image the',
    '    // player actually sees.',
    '    float ex = texture2D( tExposure, vec2( 0.5 ) ).r;',
    '    ex = ex > 1e-4 ? ex : 1.0;',
    '    ex *= max( uExposureBias, 1e-3 );',
    '    float directMask = smoothstep( uAODirectLo, uAODirectHi, pfLum( color ) * ex );',
    '    // Never remove the occlusion completely: crevices need their contact',
    '    // darkening even in full sun or the surface reads as plastic.',
    '    float a = mix( ao, mix( ao, 1.0, uAOKeep ), directMask );',
    '    a = mix( 1.0, a, uAOStrength );',
    '',
    '    // CONTACT term, deliberately NOT masked. Micro-geometry occlusion at a',
    '    // ~14 cm radius shadows direct light as legitimately as it shadows fill,',
    '    // and it is the only thing that puts a visible notch in a wall/floor',
    '    // junction. Gating this behind directMask (as the wide term must be)',
    '    // is what made AO measure as absent everywhere outdoors.',
    '    float an = mix( 1.0, aoNear, clamp( uAOContact * uAOStrength, 0.0, 1.0 ) );',
    '',
    '    // ONE tint application, on the COMBINED occlusion. Tinting each term',
    '    // separately squares uAOTint wherever both fire, and (0.085,0.115,0.150)',
    '    // squared is (0.0072,0.0132,0.0225) - 99.3% of the energy gone with a',
    '    // 3.1:1 blue/red skew, i.e. exactly the flat blue-black contact shadow',
    '    // ARCHITECTURE 7.6 calls the number one amateur tell. Combining first',
    '    // bottoms the multiplier out at uAOTint itself.',
    '    float occ = clamp( a * an, 0.0, 1.0 );',
    '    // Occlusion tints cool rather than going to black.',
    '    color *= mix( uAOTint, vec3( 1.0 ), occ );',
    '  }',
    '',
    '  if ( uUseVolume > 0.5 ) {',
    '    // Joint bilateral upsample of the half-res volume, same as the AO above.',
    '    // A plain bilinear tap left visible 2x2 blotching in the dark areas.',
    '    vec3 vol = vec3( 0.0 );',
    '    float vw = 0.0;',
    '    for ( int y = -1; y <= 1; y++ ) {',
    '      for ( int x = -1; x <= 1; x++ ) {',
    '        vec2 o = vec2( float( x ), float( y ) ) * uVolTexel;',
    '        float zs = pfLinearDepth( texture2D( tDepth, vUv + o ).x );',
    '        float w = exp( -abs( zs - z0 ) * 0.8 ) * ( 1.0 - 0.18 * ( abs( float( x ) ) + abs( float( y ) ) ) );',
    '        vol += pfSafe( texture2D( tVolume, vUv + o ).rgb ) * w;',
    '        vw += w;',
    '      }',
    '    }',
    '    color += ( vw > 1e-5 ? vol / vw : pfSafe( texture2D( tVolume, vUv ).rgb ) ) * uVolumeIntensity;',
    '  }',
    '',
    '  gl_FragColor = vec4( color, 1.0 );',
    '}'
  );

  // ==========================================================================
  // SCREEN-SPACE REFLECTIONS  (LEVEL 2 "COLD HARBOR" ONLY)
  // ==========================================================================
  //
  // The harbor's whole look is water: "the concrete apron is a black mirror
  // holding stretched reflections of every lamp". Nothing else in the chain can
  // produce that - the env probe is a uniform storm dome and three's PBR
  // specular off a near-black wet albedo is a point highlight, not a smear.
  //
  // Everything below is gated on ctx.levelId === 'harbor' (see _ssrEnabled).
  // The market never allocates the target, never runs the passes and never
  // touches a uniform of theirs, so level 1 is bit-identical.
  //
  // Design constraints this file has to live inside:
  //
  // * THERE IS NO G-BUFFER. MRT is deliberately unused (see the header), so
  //   there is no normal and no roughness attachment. Normals are reconstructed
  //   from depth exactly as GTAO does, and ROUGHNESS IS MODELLED rather than
  //   read: water pools on horizontal surfaces, so the reflectance mask is
  //   driven by the world-space up component of the reconstructed normal and
  //   the roughness by ctx.weather.wetness modulated with a world-space noise
  //   that stands in for "puddle here, damp concrete there". That is a model,
  //   not a measurement - but it is the correct model for THIS level, where
  //   what is wet is exactly what is horizontal.
  //
  // * A MISSED RAY MUST NEVER PRINT BLACK. Every path falls through to an
  //   analytic environment term (storm dome above, dark quay below, lit by the
  //   lightning when it fires) rather than to zero. A screen-space technique
  //   that returns black where it has no data is the single most recognisable
  //   SSR failure, and on a level whose ground is *mostly* reflection it would
  //   punch holes in the apron.
  //
  // * HALF RES + BILATERAL UPSAMPLE. The march is the expensive part and its
  //   output is low-frequency (it is a blurred reflection by construction), so
  //   it runs at half resolution and is resolved back with a depth-aware
  //   gather. The march is blue-noise jittered per frame and the pass sits
  //   UPSTREAM of TAA, so the temporal filter is what actually removes the
  //   remaining sampling noise - which is why the step count can stay sane.
  //
  // * WHERE THE WATER IS, IS NOT THIS FILE'S TO DECIDE. materials.js owns it and
  //   publishes it as source (GAME.MaterialLibrary.WET_GLSL) precisely so a pass
  //   with no G-buffer can evaluate the identical field instead of inventing a
  //   parallel one. _wetSource() below pastes it in; see pfSsrRough for what
  //   went wrong when the two disagreed.

  // --------------------------------------------------------------------------
  // The wet contract's GLSL, resolved at material-build time.
  //
  // Returns the block that must be prepended to both SSR programs so that
  // gbWetSolve() is in scope. materials.js is constructed two systems before
  // this one and its class-level export exists as soon as its script has run,
  // so on any real boot this takes the shared path - but the whole point of
  // this module is that a missing dependency degrades rather than throws, and a
  // shader that fails to compile takes the frame with it. The fallback is
  // therefore a self-contained gbWetSolve with the SAME SHAPE (a two-octave
  // basin field, a rain-driven film, the same 0.115 transition width) built on
  // this file's own value noise. It is NOT the same field - it cannot be, that
  // is the entire point - so it is a degraded path, not an alternative.
  //
  // Spliced at PF_WET_SLOT in SSR_SHARED (i.e. after this file's own noise
  // helpers, which the fallback uses, and before pfSsrRough, which calls it).
  // --------------------------------------------------------------------------
  var PF_WET_SLOT = '  // __PF_WET_CONTRACT__';

  function _wetSource() {
    try {
      var W = GAME.MaterialLibrary && GAME.MaterialLibrary.WET_GLSL;
      if (W && typeof W.noise === 'string' && typeof W.puddle === 'string' &&
          typeof W.solve === 'string' && W.solve.indexOf('gbWetSolve') >= 0) {
        return W.noise + '\n' + W.puddle + '\n' + W.solve + '\n';
      }
    } catch (e) { /* fall through to the degraded path */ }
    GAME.logError('postfx.ssr', 'MaterialLibrary.WET_GLSL unavailable; ' +
      'SSR is running its own wetness field and will not agree with the surfaces');
    return [
      'float gbWetSolve( vec3 wp, float up, float cav, vec4 cfg,',
      '                  out float pud, out float damp, out float film ) {',
      '  float raw = clamp( pfSsrNoise( wp.xz * 0.41 + 91.0 ) * 0.62',
      '            + pfSsrNoise( wp.xz * 1.54 + 23.0 ) * 0.38',
      '            + ( 0.5 - cav ) * 0.18 + ( cfg.y - 0.5 ) * 0.22, 0.0, 1.0 );',
      '  pud = 0.0; damp = 0.0;',
      '  float lvl = cfg.x * cfg.z;',
      '  if ( lvl > 0.004 ) {',
      '    float flatN = smoothstep( 0.70, 0.93, up );',
      '    float thr = mix( 0.94, 0.56, lvl );',
      '    float fld = pfSsrNoise( wp.xz * 0.21 + 17.0 ) * 0.63',
      '              + pfSsrNoise( wp.xz * 0.86 + 41.0 ) * 0.37 + ( 0.5 - cav ) * 0.20;',
      '    pud = smoothstep( thr, thr + 0.115, fld ) * flatN;',
      '    damp = smoothstep( thr - 0.17, thr + 0.015, fld ) * ( 1.0 - pud ) * flatN;',
      '  }',
      '  float sheet = smoothstep( 0.78, 0.94, cfg.x ) * smoothstep( 0.55, 0.85, up )',
      '              * step( 0.004, cfg.z ) * 0.50;',
      '  film = max( smoothstep( 0.26, 0.78, raw ), sheet );',
      '  return cfg.w * mix( 3.9, 0.92, film );',
      '}',
      ''
    ].join('\n');
  }

  var SSR_SHARED = [
    'uniform sampler2D tDepth;',
    'uniform mat3 uViewToWorld;',
    'uniform vec2 uTexelFull;',
    'uniform float uWetness;',
    'uniform float uRainAmt;',
    'uniform float uSsrTime;',
    'uniform float uUpLo;',
    'uniform float uUpHi;',
    'uniform float uSideAmount;',
    'uniform float uRoughDry;',
    'uniform float uRoughWet;',
    'uniform float uPuddleScale;',
    'uniform float uRipple;',
    // THE WET CONTRACT (materials.js). x = global wetness, y = rain intensity,
    // z = the apron material's puddle susceptibility, w = its base wet
    // roughness - i.e. exactly the vec4 gbWetSolve() wants, handed over by
    // MaterialLibrary.wetContract(). See pfSsrRough.
    'uniform vec4 uWetCfg;',
    '',
    'float pfSsrHash( vec2 p ) {',
    '  vec3 q = fract( vec3( p.x, p.y, p.x ) * 0.1031 );',
    '  q += dot( q, q.yzx + 33.33 );',
    '  return fract( ( q.x + q.y ) * q.z );',
    '}',
    'float pfSsrNoise( vec2 p ) {',
    '  vec2 i = floor( p );',
    '  vec2 f = p - i;',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  return mix( mix( pfSsrHash( i ),                    pfSsrHash( i + vec2( 1.0, 0.0 ) ), f.x ),',
    '              mix( pfSsrHash( i + vec2( 0.0, 1.0 ) ), pfSsrHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );',
    '}',
    '',
    // materials.js's published wet contract is spliced in here at build time -
    // see _wetSource(). It defines gbWetSolve(), which pfSsrRough calls below.
    '  // __PF_WET_CONTRACT__',
    '',
    '// Same best-fit-neighbour reconstruction GTAO uses: pick whichever side',
    '// lies on the same surface so a silhouette does not smear a bogus normal',
    '// across it. Taps are at FULL-res texel spacing even though this shader',
    '// runs at half res - the depth buffer is full res and stepping by half-res',
    '// texels doubles the reconstruction error on every thin feature.',
    '//',
    '// IT ALSO RETURNS A CONFIDENCE, and that is not a refinement - it is the',
    '// fix for the doubled/mirrored frame this pass was printing. There is no',
    '// G-buffer here, so "is this surface horizontal" is answered entirely by a',
    '// four-tap depth derivative; along every SILHOUETTE the two taps straddle',
    '// different surfaces, best-fit or not, and the cross product of a step',
    '// ACROSS a depth cliff is a normal that has nothing to do with either',
    '// surface. Wherever one of those came out pointing up, a full-strength',
    '// mirror was written into a pixel belonging to a wall or to the sky edge -',
    '// which, along a horizon-length silhouette, is a mirrored copy of the frame',
    '// laid across the top of it.',
    '//',
    '// The test is the SECOND difference. On any plane, however steep, the two',
    '// opposite taps are symmetric about the centre so their deltas cancel; at a',
    '// discontinuity one of them jumps by the whole depth step. The tolerance',
    '// scales with view distance because one texel of depth slope is worth',
    '// proportionally more the further away the surface is.',
    'vec3 pfSsrNormal( vec2 uv, vec3 P, out float nconf ) {',
    '  vec2 t = uTexelFull;',
    '  vec3 Pr = pfViewPos( uv + vec2( t.x, 0.0 ), texture2D( tDepth, uv + vec2( t.x, 0.0 ) ).x );',
    '  vec3 Pl = pfViewPos( uv - vec2( t.x, 0.0 ), texture2D( tDepth, uv - vec2( t.x, 0.0 ) ).x );',
    '  vec3 Pu = pfViewPos( uv + vec2( 0.0, t.y ), texture2D( tDepth, uv + vec2( 0.0, t.y ) ).x );',
    '  vec3 Pd = pfViewPos( uv - vec2( 0.0, t.y ), texture2D( tDepth, uv - vec2( 0.0, t.y ) ).x );',
    '  float ddx = abs( ( Pr.z - P.z ) + ( Pl.z - P.z ) );',
    '  float ddy = abs( ( Pu.z - P.z ) + ( Pd.z - P.z ) );',
    '  float tol = 0.012 + abs( P.z ) * 0.020;',
    '  nconf = 1.0 - smoothstep( tol, tol * 5.0, max( ddx, ddy ) );',
    '  vec3 dx = abs( Pr.z - P.z ) < abs( P.z - Pl.z ) ? ( Pr - P ) : ( P - Pl );',
    '  vec3 dy = abs( Pu.z - P.z ) < abs( P.z - Pd.z ) ? ( Pu - P ) : ( P - Pd );',
    '  vec3 n = cross( dx, dy );',
    '  float l = length( n );',
    '  if ( l < 1e-9 ) { nconf = 0.0; return vec3( 0.0, 0.0, 1.0 ); }',
    '  n /= l;',
    '  if ( dot( n, P ) > 0.0 ) n = -n;',
    '  return n;',
    '}',
    '',
    '// ---- ROUGHNESS, OFF MATERIALS.JS\'S OWN WET FIELD ------------------------',
    '//',
    '// This used to be a stand-in: ONE octave of the local value noise above at',
    '// a ~7 m period, with no cavity term and no film model. materials.js solves',
    '// where the water is from TWO octaves (~4.8 m and ~1.2 m) plus a cavity',
    '// bias plus a rain-driven film, and the two fields were uncorrelated - so',
    '// this pass laid a near-mirror over concrete the material had left matte,',
    '// and a blurred one over the sheeted hollows the material had driven to',
    '// roughness 0.03. That is the real reason the reflections read as short and',
    '// misplaced rather than long and coherent, and it is completely immune to',
    '// tuning the reflection: two passes disagreeing about a noise field cannot',
    '// be reconciled by changing either one\'s strength.',
    '//',
    '// materials.js now PUBLISHES the field as source (GAME.MaterialLibrary.',
    '// WET_GLSL) plus its live uniform values (wetContract()), and the block',
    '// below is pasted verbatim ahead of this shader by _wetSource(), so',
    '// gbWetSolve() here evaluates byte-for-byte what the apron material',
    '// evaluates. cav is 0.5 - the neutral value the contract documents for a',
    '// consumer with no G-buffer - which is a +-0.03 bias on a field whose',
    '// transition is 0.115 wide, i.e. a quarter of the puddle\'s edge feather and',
    '// well inside the resolve\'s own blur.',
    '//',
    '// The composition on top of it is materials.js\'s too, transcribed from its',
    '// roughness block: a sky-exposure term (a slab takes the whole downpour, a',
    '// flank only what the wind drives onto it), then the same mix toward the',
    '// solved wet target at 0.88, then the same collapse to 0.030 inside standing',
    '// water. The one term it cannot see is the level\'s per-vertex wetness',
    '// channel, which lives in an attribute and not in the depth buffer; that',
    '// only ever ADDS water, so the SSR is conservative where it differs.',
    'float pfSsrRough( vec3 Wp, float ny, out float pud, out float film ) {',
    '  float upRaw = clamp( ny, 0.0, 1.0 );',
    '  float damp = 0.0;',
    '  float wetR = gbWetSolve( Wp, upRaw, 0.5, uWetCfg, pud, damp, film );',
    '  float expo = mix( 0.42, 1.0, upRaw ) + clamp( - ny, 0.0, 1.0 ) * -0.22;',
    '  float wetT = clamp( uWetCfg.x * uWetCfg.z * expo, 0.0, 1.0 );',
    '  wetT = max( wetT, pud );',
    '  float r = mix( uRoughDry, wetR, wetT * 0.88 );',
    '  r = mix( r, 0.030, pud );',
    '  return clamp( r, 0.022, 0.90 );',
    '}',
    '',
    '// Rain disturbance on standing water. The reconstruction above sees only',
    '// GEOMETRY - it cannot see the ripple normal map weather.js puts on the',
    '// ground - so without this the reflection is a perfect mirror underneath a',
    '// rippling surface, which reads as a bug. Deliberately small: it wobbles',
    '// the reflection, it does not shatter it.',
    '//',
    '// FADED OUT WITH DISTANCE, and that is not an optimisation. A ~0.4 m ripple',
    '// wavelength projects to under a pixel by 30 m, so past that the term is',
    '// sampling a world-space field far below the Nyquist limit of the screen -',
    '// and because a grazing reflection multiplies any normal error by a large',
    '// factor, the aliasing does not print as noise, it prints as hard horizontal',
    '// BANDS marching to the horizon. Measured on a flat apron they were the most',
    '// visible artifact in the whole pass.',
    'vec3 pfSsrRipple( vec3 Nw, vec3 Wp, float up, float viewZ ) {',
    '  float a = uRipple * uRainAmt * up * ( 1.0 - smoothstep( 7.0, 26.0, viewZ ) );',
    '  if ( a < 1e-5 ) return Nw;',
    '  vec2 q = Wp.xz * 2.7 + vec2( uSsrTime * 0.9, -uSsrTime * 0.63 );',
    '  float e = 0.18;',
    '  float n0 = pfSsrNoise( q );',
    '  float nx = pfSsrNoise( q + vec2( e, 0.0 ) );',
    '  float nz = pfSsrNoise( q + vec2( 0.0, e ) );',
    '  vec2 g = vec2( nx - n0, nz - n0 ) / e;',
    '  return normalize( Nw + vec3( -g.x, 0.0, -g.y ) * a );',
    '}'
  ].join('\n');

  // ---- SSR: the march (half res) ------------------------------------------
  var FRAG_SSR = glsl(
    COMMON, DEPTH, VIEWPOS, WORLDPOS, SSR_SHARED,
    'uniform sampler2D tScene;',
    'uniform sampler2D tBlue;',
    'uniform mat4 uProj;',
    'uniform vec2 uBlueScale;',
    'uniform vec3 uEnvSky;',
    'uniform vec3 uEnvGround;',
    'uniform vec3 uFlashColor;',
    'uniform float uFrame;',
    'uniform float uMaxDist;',
    'uniform float uMaxViewDist;',
    'uniform float uThickness;',
    'uniform float uEdgeFade;',
    'uniform float uF0;',
    'uniform float uClampRefl;',
    'uniform float uEnvWeight;',
    'uniform float uFlashAmt;',
    'uniform int uSteps;',
    'uniform int uRefine;',
    '',
    'const int PF_SSR_MAX = 40;',
    'const int PF_SSR_REFINE = 8;',
    '',
    'void main() {',
    '  float d = texture2D( tDepth, vUv ).x;',
    '  if ( d >= 0.9999995 ) { gl_FragColor = vec4( 0.0 ); return; }',
    '',
    '  vec3 P = pfViewPos( vUv, d );',
    '  float viewZ = -P.z;',
    '  // Beyond this the apron is a handful of pixels deep and the march costs',
    '  // more than the reflection is worth; fog has taken it anyway.',
    '  if ( viewZ > uMaxViewDist ) { gl_FragColor = vec4( 0.0 ); return; }',
    '',
    '  float nconf = 0.0;',
    '  vec3 Ng = pfSsrNormal( vUv, P, nconf );',
    '  // A reconstructed normal that straddles a silhouette is not a surface,',
    '  // and marching a mirror off it is what put a doubled frame across the top',
    '  // of the image. Below a quarter confidence there is nothing to reflect.',
    '  if ( nconf < 0.25 ) { gl_FragColor = vec4( 0.0 ); return; }',
    '  vec3 N = Ng;',
    '  vec3 Ngw = uViewToWorld * Ng;',
    '  vec3 Nw = Ngw;',
    '  // WATER LIES FLAT. The reflectance mask is the world-space up component,',
    '  // with a small floor so a soaked container flank still holds a hint of',
    '  // one - Fresnel kills that at anything but a grazing angle anyway.',
    '  float up = smoothstep( uUpLo, uUpHi, Nw.y );',
    '  float wet = uWetness * ( uSideAmount + ( 1.0 - uSideAmount ) * up );',
    '  if ( wet < 0.012 ) { gl_FragColor = vec4( 0.0 ); return; }',
    '',
    '  vec3 Wp = pfWorldPos( vUv, d );',
    '  float pud = 0.0, film = 0.0;',
    '  float rough = pfSsrRough( Wp, Nw.y, pud, film );',
    '  // ...and the reflectance follows the same field. A horizontal surface',
    '  // whose film materials.js has left THIN is damp concrete - the water is',
    '  // inside the pores and what you see is still aggregate - while a sheeted',
    '  // hollow or a basin is water standing on top of it. Reflecting both by the',
    '  // same amount is the other half of the disagreement above: it prints a',
    '  // uniform mirror over a surface the material has given a deliberate',
    '  // specular STRUCTURE. Vertical faces are untouched (the term is gated on',
    '  // `up`), because a flank has no film model - it has rivulets.',
    '  // ...and it only ever REDUCES. A structural term that can also boost is',
    '  // not a correlation any more, it is a brightness change with a noise field',
    '  // attached, and on a grazing apron where Fresnel is already ~1 there is no',
    '  // headroom above the authored level to spend.',
    '  wet *= mix( 1.0, mix( 0.55, 1.0, clamp( max( film, pud ), 0.0, 1.0 ) ), up );',
    '  Nw = pfSsrRipple( Nw, Wp, up, viewZ );',
    '  // Back to view space. uViewToWorld is a pure rotation, so the row-vector',
    '  // product is its inverse - no second uniform needed.',
    '  N = normalize( Nw * uViewToWorld );',
    '',
    '  vec3 V = normalize( -P );',
    '  float ndv = clamp( dot( N, V ), 1e-4, 1.0 );',
    '  // Schlick. On water F0 is ~0.02 and the term is ~1 at grazing, which is',
    '  // exactly the geometry of standing on an apron looking down it: the far',
    '  // ground is nearly pure reflection and the ground at your feet is nearly',
    '  // pure albedo. That gradient is most of what sells "wet".',
    '  float F = uF0 + ( 1.0 - uF0 ) * pow( 1.0 - ndv, 5.0 );',
    '',
    '  vec3 R = reflect( -V, N );',
    '  // A ray heading back toward the eye leaves the frustum immediately and',
    '  // there is no screen data along it. Fade rather than cut - a hard cut',
    '  // draws a visible arc across the ground.',
    '  float dirFade = 1.0 - smoothstep( 0.05, 0.50, R.z );',
    '  // REJECT RAYS THAT POINT INTO THE SURFACE. reflect() guarantees the ray',
    '  // leaves the plane of the normal it was given - but the normal it was',
    '  // given is the RIPPLED one, and at grazing incidence a ripple of a few',
    '  // degrees is enough to tip the reflection below the real geometry. Such a',
    '  // ray immediately intersects the surface it started on, and the "hit" it',
    '  // returns is a neighbouring texel of that same surface: across an apron',
    '  // that is a smeared copy of the ground laid over itself.',
    '  dirFade *= smoothstep( 0.0, 0.10, dot( R, Ng ) );',
    '  dirFade *= nconf;',
    '  if ( dirFade < 0.004 ) { gl_FragColor = vec4( 0.0 ); return; }',
    '',
    '  vec4 bn = texture2D( tBlue, gl_FragCoord.xy * uBlueScale );',
    '  float jit = fract( bn.x + pfR2( uFrame ) );',
    '',
    '  // Normal bias scaled with distance: one depth texel is a lot of world',
    '  // space at 60 m and a self-intersection there prints as a black notch.',
    '  float bias = 0.035 + viewZ * 0.011;',
    '  vec3 O = P + N * bias;',
    '  float rayLen = uMaxDist;',
    '  vec3 E = O + R * rayLen;',
    '  // Clip to the near plane, or the projection below flips sign and the',
    '  // screen-space segment runs off in the wrong direction.',
    '  if ( E.z > -uNear ) {',
    '    float tn = ( -uNear - O.z ) / ( R.z + 1e-6 );',
    '    rayLen = clamp( tn, 0.05, uMaxDist );',
    '    E = O + R * rayLen;',
    '  }',
    '',
    '  vec4 h0 = uProj * vec4( O, 1.0 );',
    '  vec4 h1 = uProj * vec4( E, 1.0 );',
    '',
    '  float conf = 0.0;',
    '  vec3 refl = vec3( 0.0 );',
    '',
    '  if ( h0.w > 1e-4 && h1.w > 1e-4 ) {',
    '    vec2 uv0 = ( h0.xy / h0.w ) * 0.5 + 0.5;',
    '    vec2 uv1 = ( h1.xy / h1.w ) * 0.5 + 0.5;',
    '    // 1/w is the one quantity that interpolates LINEARLY in screen space,',
    '    // so stepping it is what makes the depth comparison perspective-correct.',
    '    // Interpolating view z directly (the obvious version) puts the ray',
    '    // metres in front of where it actually is at mid-march and produces',
    '    // reflections that float above the surface they belong to.',
    '    float k0 = 1.0 / h0.w;',
    '    float k1 = 1.0 / h1.w;',
    '',
    '    float steps = float( uSteps );',
    '    float prevT = 0.0;',
    '    float hitT = -1.0;',
    '',
    '    for ( int i = 1; i <= PF_SSR_MAX; i++ ) {',
    '      if ( i > uSteps ) break;',
    '      float u = ( float( i ) - 1.0 + jit ) / steps;',
    '      // Mild quadratic bias toward the origin: contact reflections are what',
    '      // the eye reads, and the far end of the ray is being blurred anyway.',
    '      float t = u * mix( 1.0, u, 0.55 );',
    '      vec2 suv = mix( uv0, uv1, t );',
    '      if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;',
    '      float rayD = 1.0 / max( mix( k0, k1, t ), 1e-6 );',
    '      float sceneD = pfLinearDepth( texture2D( tDepth, suv ).x );',
    '      if ( rayD - sceneD > 0.0 ) { hitT = t; break; }',
    '      prevT = t;',
    '    }',
    '',
    '    if ( hitT > 0.0 ) {',
    '      // Binary refinement between the last miss and the first hit. Without',
    '      // it the hit lands on a step boundary and a lamp reflection quantises',
    '      // into visible rungs as the camera moves.',
    '      float lo = prevT;',
    '      float hi = hitT;',
    '      for ( int j = 0; j < PF_SSR_REFINE; j++ ) {',
    '        if ( j >= uRefine ) break;',
    '        float mid = 0.5 * ( lo + hi );',
    '        vec2 muv = mix( uv0, uv1, mid );',
    '        float mD = 1.0 / max( mix( k0, k1, mid ), 1e-6 );',
    '        float sD = pfLinearDepth( texture2D( tDepth, muv ).x );',
    '        if ( mD - sD > 0.0 ) hi = mid; else lo = mid;',
    '      }',
    '      hitT = hi;',
    '      vec2 hUv = mix( uv0, uv1, hitT );',
    '      float rayD = 1.0 / max( mix( k0, k1, hitT ), 1e-6 );',
    '      float hd = texture2D( tDepth, hUv ).x;',
    '      float sceneD = pfLinearDepth( hd );',
    '',
    '      // THICKNESS TEST. The depth buffer records a surface, not a solid, so',
    '      // without an upper bound on how far BEHIND that surface the ray landed',
    '      // every ray eventually "hits" the first thing it passes and the ground',
    '      // fills with reflections of objects the ray actually went behind.',
    '      float over = rayD - sceneD;',
    '      float thick = uThickness * ( 1.0 + sceneD * 0.055 );',
    '      conf = 1.0 - smoothstep( thick * 0.45, thick, over );',
    '      // The sky is not geometry; let it fall through to the env term, which',
    '      // is the same radiance without the depth-buffer lottery.',
    '      if ( hd >= 0.9999995 ) conf = 0.0;',
    '      // A "hit" in front of the near plane is not a hit; it is the ray',
    '      // having been projected through the origin. 1/w interpolation is only',
    '      // meaningful while the segment stays in front of the eye.',
    '      if ( rayD <= uNear * 1.5 ) conf = 0.0;',
    '',
    '      // SELF-INTERSECTION REJECTION, IN WORLD SPACE, AGAINST THE REFLECTING',
    '      // PLANE ITSELF. This is the one test that structurally cannot be',
    '      // passed by a mirrored copy of the surface the ray started on: a real',
    '      // reflection is of something STANDING ON the plane, so its hit point',
    '      // has to be a real distance ABOVE that plane along the geometric',
    '      // normal. A grazing ray that skims its own apron, a normal-bias',
    '      // failure, and a ripple that tipped the ray under the geometry all',
    '      // land within a few centimetres of the plane, and all three used to',
    '      // return a full-confidence hit. Signed, so a hit BELOW the plane -',
    '      // which is geometrically impossible - is rejected outright rather',
    '      // than being accepted with the sign thrown away.',
    '      vec3 hW = pfWorldPos( hUv, hd );',
    '      conf *= smoothstep( 0.04, 0.20, dot( hW - Wp, Ngw ) );',
    '',
    '      // Backface rejection: a valid mirror hit faces back along the ray.',
    '      vec3 hP = pfViewPos( hUv, hd );',
    '      float hconf = 0.0;',
    '      vec3 hN = pfSsrNormal( hUv, hP, hconf );',
    '      // A hit whose own normal could not be reconstructed cannot be backface',
    '      // tested, so it is not trustworthy enough to print as a mirror.',
    '      conf *= mix( 0.35, 1.0, hconf );',
    '      conf *= 1.0 - smoothstep( -0.02, 0.30, dot( hN, R ) );',
    '',
    '      // Screen-edge fade. Data simply stops existing at the frame border and',
    '      // a reflection that ends on a straight line is the SSR tell.',
    '      vec2 eg = abs( hUv - 0.5 ) * 2.0;',
    '      conf *= 1.0 - smoothstep( 1.0 - uEdgeFade, 1.0, max( eg.x, eg.y ) );',
    '',
    '      vec3 hit = pfSafe( texture2D( tScene, hUv ).rgb );',
    '      // Hue-preserving firefly cap, same argument as the bright pass: a lamp',
    '      // core arrives here at 100x mid-grey and one reflected texel would',
    '      // otherwise seed the whole bloom pyramid off the ground.',
    '      float mx = pfMax3( hit );',
    '      if ( mx > uClampRefl ) hit *= uClampRefl / max( mx, 1e-4 );',
    '      refl = hit;',
    '    }',
    '  }',
    '',
    '  // ---- IBL fallback ------------------------------------------------------',
    '  // Analytic, because there is no way to sample a PMREM from a raw',
    '  // ShaderMaterial here without hand-injecting three\'s CUBEUV defines and',
    '  // rebuilding the program whenever sky.js swaps the probe. For an overcast',
    '  // storm dome - which is what this level HAS - a two-zone gradient in the',
    '  // reflected direction is within a few percent of the probe anyway, and it',
    '  // cannot fail to compile.',
    '  vec3 Rw = uViewToWorld * R;',
    '  // THE CROSSOVER IS AT THE HORIZON, NOT BELOW IT. smoothstep(-0.30, 0.40)',
    '  // hands a ray pointing 17 degrees BELOW horizontal a third of the sky, and',
    '  // an apron seen from eye height reflects at exactly that kind of angle -',
    '  // so the entire foreground was falling back on ~78% of the dome. Measured',
    '  // by bisection on `gangway`: with the fallback disabled the apron came back',
    '  // as a real reflection of the crane, the masts and the rails at 67/255;',
    '  // with it, one flat pale plate at 97/255 with the reflection\'s structure',
    '  // filled in and erased. A grazing reflection looks at the HORIZON, and the',
    '  // horizon in a night terminal is dark harbour, not a lit dome.',
    '  vec3 env = mix( uEnvGround, uEnvSky, smoothstep( -0.05, 0.45, Rw.y ) );',
    '  // Lightning lights the cloud deck, and the apron reflects the deck. This is',
    '  // therefore a MULTIPLIER on the dome, tinted toward the strike colour - not',
    '  // an additive term. An additive one is a constant regardless of how dark',
    '  // the sky actually is, which measured as post FLOODLIGHTING the quay: the',
    '  // apron turned into a flat mid-grey mirror and the frame gained most of its',
    '  // light from a place the lighting rig knows nothing about. The brief is',
    '  // explicit that the flash must arrive as relit geometry.',
    '  float fl = clamp( uFlashAmt, 0.0, 2.0 ) * smoothstep( -0.15, 0.55, Rw.y );',
    '  if ( fl > 1e-4 ) {',
    '    vec3 lit = uFlashColor * ( pfLum( env ) * ( 1.0 + 5.0 * fl ) );',
    '    env = mix( env, lit, clamp( fl, 0.0, 0.80 ) );',
    '  }',
    '',
    '  refl = mix( env, refl, conf );',
    '  // Misses lean on the environment, so they blend in less hard than a real',
    '  // hit does - a fully-weighted dome reflection at grazing would flatten the',
    '  // apron into one dark value and lose every bit of surface detail under it.',
    '  //',
    '  // THE MISS FALLBACK IS SCALED BY `up`, i.e. it exists on WATER and nowhere',
    '  // else. Without that factor the term rode on ssrSideAmount (the reflectance',
    '  // floor that lets a soaked container flank hold a hint of sheen), and since',
    '  // Fresnel is ~1 at grazing on every vertical surface in a container yard,',
    '  // a >=3% LERP toward a constant analytic dome was being applied to the',
    '  // freighter hull, the container flanks, the crane legs - measured at 52% of',
    '  // the gangway frame. That is not a reflection, it is a flat view-independent',
    '  // veil over half the image, and it double-counts the PMREM env specular the',
    '  // PBR pass already applied there. A vertical surface now gets the dome only',
    '  // where the march found a REAL hit; the continuity term this factor is',
    '  // defending survives intact on the apron, which is where it belongs.',
    '  float weight = F * wet * dirFade * mix( uEnvWeight * up, 1.0, conf );',
    '  gl_FragColor = vec4( pfSafe( refl ), clamp( weight, 0.0, 1.0 ) );',
    '}'
  );

  // ---- SSR: bilateral resolve + roughness blur (full res) ------------------
  // One pass does the upsample, the roughness-driven blur and the composite.
  // The blur is ANISOTROPIC, oriented along the screen-space projection of the
  // reflection vector: on a ground plane that direction runs away from the
  // viewer, which is precisely the axis a real rough reflection smears along.
  // An isotropic blur of the same radius turns a lamp into a blob; this turns it
  // into the long vertical streak the brief asks for.
  var FRAG_SSR_APPLY = glsl(
    COMMON, DEPTH, VIEWPOS, WORLDPOS, SSR_SHARED,
    'uniform sampler2D tScene;',
    'uniform sampler2D tSSR;',
    'uniform mat4 uProj;',
    'uniform vec2 uSSRTexel;',
    'uniform float uBlurScale;',
    'uniform float uIntensity;',
    'uniform float uF0;',
    // ---- analytic wet-ground practicals ------------------------------------
    // uPracCount is 0 anywhere but the harbor (and this whole pass never even
    // dispatches on the market), so the block below is gated out by construction.
    'uniform vec4 uPracPos[6];',    // xyz world position, w = range
    'uniform vec4 uPracCol[6];',    // rgb radiant intensity, w unused
    'uniform float uPracGain;',
    'uniform float uPracRough;',
    'uniform float uPracClamp;',
    'uniform float uPracFloor;',
    'uniform int uPracCount;',
    '',
    '// GGX/Trowbridge-Reitz specular for one point practical on the water plane.',
    '//',
    '// WHY THIS EXISTS AT ALL. A screen-space march can only mirror what is IN',
    '// the frame, and looking down an apron the mast lamp that owns the smear is',
    '// almost always off-screen, behind the camera, or occluded - so the one',
    '// effect ART_DIRECTION_HARBOR names as the hero ("a black mirror holding',
    '// stretched reflections of every lamp") is exactly the case SSR structurally',
    '// cannot deliver. This is the analytic half: no ray, no screen dependence,',
    '// just the specular lobe the surface would return anyway.',
    '//',
    '// The long VERTICAL smear is not authored, it falls out of the geometry: at',
    '// grazing incidence the half-vector between the eye and a fixed lamp changes',
    '// slowly along the view direction on the plane and fast across it, so a',
    '// round lobe projects to a streak many times the lamp height. That is why it',
    '// is evaluated as a real BRDF rather than as a stretched sprite - a sprite',
    '// would have to be told how long to be, and it would be wrong the moment the',
    '// camera moved.',
    '// THE LOBE IS DELIBERATELY BROADER THAN THE SURFACE ROUGHNESS AND CAPPED.',
    '// Evaluated at the SSR resolve\'s own roughness (~0.22 with the rain floor)',
    '// the GGX peak is 1/(pi*a^2) ~ 136, and against a 6 m mast on a container',
    '// roof that prints a hard-edged flat white plate - a genuine specular value,',
    '// and exactly the "blown white disc" this file spends a page of comments',
    '// arguing against elsewhere. Widening by uPracRough drops the peak ~9x',
    '// while conserving the lobe\'s energy, so what was a plate becomes the long',
    '// sheen it is supposed to be; the cap is hue-preserving (a scalar multiply',
    '// of the fetched triple) so a sodium lamp\'s chroma survives it.',
    'vec3 pfPracLobe( vec3 Wp, vec3 Nw, vec3 Vw, float rough ) {',
    '  vec3 sum = vec3( 0.0 );',
    '  float a = max( ( rough + uPracRough ) * ( rough + uPracRough ), 0.0016 );',
    '  float a2 = a * a;',
    '  float ndv = max( dot( Nw, Vw ), 1e-3 );',
    '  for ( int i = 0; i < 6; i++ ) {',
    '    if ( i >= uPracCount ) break;',
    '    vec4 lp = uPracPos[ i ];',
    '    vec3 dl = lp.xyz - Wp;',
    '    float dist = length( dl );',
    '    if ( dist < 1e-3 ) continue;',
    '    vec3 L = dl / dist;',
    '    float ndl = dot( Nw, L );',
    '    if ( ndl <= 0.0 ) continue;',
    '    // three\'s physically-correct point falloff, windowed by the light\'s own',
    '    // range so a lamp can never contribute outside the volume it lights.',
    '    float rr = max( lp.w, 0.5 );',
    '    float t = clamp( 1.0 - pow( dist / rr, 4.0 ), 0.0, 1.0 );',
    '    float atten = t * t / max( dist * dist, 0.25 );',
    '    if ( atten < 1e-6 ) continue;',
    '    vec3 H = normalize( L + Vw );',
    '    float ndh = max( dot( Nw, H ), 0.0 );',
    '    float den = ndh * ndh * ( a2 - 1.0 ) + 1.0;',
    '    float D = a2 / ( PF_PI * max( den * den, 1e-7 ) );',
    '    // Smith height-correlated visibility, Hammon\'s approximation.',
    '    float vis = 0.5 / max( mix( 2.0 * ndl * ndv, ndl + ndv, a ), 1e-4 );',
    '    sum += uPracCol[ i ].rgb * ( D * vis * ndl * atten );',
    '  }',
    '  sum *= uPracGain;',
    '  float mxL = pfMax3( sum );',
    '  if ( mxL > uPracClamp ) sum *= uPracClamp / max( mxL, 1e-4 );',
    '  return sum;',
    '}',
    'void main() {',
    '  vec3 base = pfSafe( texture2D( tScene, vUv ).rgb );',
    '  vec4 c0 = texture2D( tSSR, vUv );',
    '  // Early out returns the source BIT-EXACT, so every pixel the march',
    '  // rejected costs one bilinear tap and nothing else.',
    '  if ( c0.a < 0.004 ) { gl_FragColor = vec4( base, 1.0 ); return; }',
    '  float d = texture2D( tDepth, vUv ).x;',
    '  if ( d >= 0.9999995 ) { gl_FragColor = vec4( base, 1.0 ); return; }',
    '',
    '  vec3 P = pfViewPos( vUv, d );',
    '  float nconf = 0.0;',
    '  vec3 N = pfSsrNormal( vUv, P, nconf );',
    '  vec3 Wp = pfWorldPos( vUv, d );',
    '  vec3 Nw0 = uViewToWorld * N;',
    '  float pud = 0.0, film = 0.0;',
    '  float rough = pfSsrRough( Wp, Nw0.y, pud, film );',
    '  vec3 V = normalize( -P );',
    '  vec3 R = reflect( -V, N );',
    '',
    '  vec4 hA = uProj * vec4( P, 1.0 );',
    '  vec4 hB = uProj * vec4( P + R * max( 0.35, -P.z * 0.10 ), 1.0 );',
    '  vec2 dir = vec2( 0.0, 1.0 );',
    '  if ( hA.w > 1e-4 && hB.w > 1e-4 ) {',
    '    vec2 dv = ( hB.xy / hB.w - hA.xy / hA.w );',
    '    if ( length( dv ) > 1e-6 ) dir = normalize( dv );',
    '  }',
    '',
    '  // GRAZING-ANGLE FOOTPRINT. A rough reflection\'s projected lobe stretches',
    '  // by ~1/cos(theta) along the view direction, which on an apron seen from',
    '  // eye height is a 5-15x elongation - and the previous radius had no such',
    '  // term at all, so a reflection seen at five degrees got the same kernel as',
    '  // one seen face-on. That, not an early march termination, is why the lamp',
    '  // smears were 30-45 px on a 6 m mast: they were being resolved with a',
    '  // face-on lobe.',
    '  //',
    '  // The roughness floor is the second half of it: rain agitation is what',
    '  // makes a real wet apron smear LONG rather than short, so a floor under',
    '  // the surface roughness is the right idea. The value was not. At 0.14 +',
    '  // 0.10 x rain it sits at 0.22 in a downpour, and the shared wet field',
    '  // (pfSsrRough) spans 0.03 in a basin to 0.21 on the driest horizontal',
    '  // texel it can produce - so the floor was ABOVE the entire wet half of the',
    '  // field and the kernel came out at one constant radius everywhere. A',
    '  // constant-radius anisotropic blur is exactly the "reflections that are',
    '  // just a blur" the instant-fail list names, and it is also why sharing the',
    '  // field with materials.js would have changed nothing on its own: the term',
    '  // that consumes it was ignoring it.',
    '  //',
    '  // 0.065 + 0.085 x rain is 0.133 at the storm\'s rain intensity, which keeps',
    '  // the agitation (a puddle still smears ~7 full-res pixels at a moderate',
    '  // grazing angle) while leaving the field a 2.5x spread to actually',
    '  // modulate: sheeted hollows resolve long and coherent, damp high spots',
    '  // resolve broad and dim, and the two are now in the places the material',
    '  // painted them.',
    '  //',
    '  // The 9x the geometry justifies was measured back to 6x: past that the',
    '  // gather stops being a lobe footprint and starts being an area light, and',
    '  // the apron framings gained a fifth of a stop of general level with it.',
    '  float ndvB = clamp( dot( N, V ), 0.06, 1.0 );',
    '  float graze = clamp( 1.0 / ndvB, 1.0, 6.0 );',
    '  float rr = max( rough, 0.065 + 0.085 * uRainAmt );',
    '  float radius = clamp( 0.6 + rr * uBlurScale * graze, 0.6, 24.0 );',
    '  float z0 = pfLinearDepth( d );',
    '',
    '  // PREMULTIPLIED gather. Neighbours the march rejected carry alpha 0, and',
    '  // averaging their (0,0,0) colour in would drag a valid reflection toward',
    '  // black along every silhouette. Accumulating rgb*a and dividing by the',
    '  // summed a makes a rejected tap contribute nothing instead of contributing',
    '  // darkness.',
    '  //',
    '  // EIGHT taps a side rather than five, and placed at fi/8 of the radius',
    '  // rather than at fi TIMES it: once the kernel is allowed to reach 34',
    '  // half-res texels, five taps at that spacing is not a blur, it is five',
    '  // copies of the reflection in a row.',
    '  vec4 acc = vec4( c0.rgb * c0.a, c0.a );',
    '  float wsum = 1.0;',
    '  for ( int i = 1; i <= 8; i++ ) {',
    '    float fi = float( i ) * 0.125;',
    '    float g = exp( -fi * fi * 2.3 );',
    '    vec2 o = dir * uSSRTexel * fi * radius;',
    '    vec2 uva = vUv + o;',
    '    vec2 uvb = vUv - o;',
    '    vec4 sa = texture2D( tSSR, uva );',
    '    vec4 sb = texture2D( tSSR, uvb );',
    '    float za = pfLinearDepth( texture2D( tDepth, uva ).x );',
    '    float zb = pfLinearDepth( texture2D( tDepth, uvb ).x );',
    '    float wa = g * exp( -abs( za - z0 ) * 0.55 );',
    '    float wb = g * exp( -abs( zb - z0 ) * 0.55 );',
    '    acc += vec4( sa.rgb * sa.a, sa.a ) * wa + vec4( sb.rgb * sb.a, sb.a ) * wb;',
    '    wsum += wa + wb;',
    '  }',
    '',
    '  vec3 refl = pfSafe( acc.rgb / max( acc.a, 1e-4 ) );',
    '  float wgt = clamp( ( acc.a / max( wsum, 1e-4 ) ) * uIntensity, 0.0, 1.0 );',
    '  // The gather is anisotropic and reaches up to 34 half-res texels, so a',
    '  // full-strength reflection on one side of a silhouette can be dragged',
    '  // across it. Gating the RESOLVED weight on this pixel\'s own normal',
    '  // confidence stops the smear ending up on geometry that has no mirror.',
    '  wgt *= nconf;',
    '  // A LERP, not an add. At grazing incidence a wet surface reflects nearly',
    '  // all of the light that reaches the eye, so the albedo has to give way -',
    '  // adding on top would print a wet apron BRIGHTER than a dry one, which is',
    '  // backwards.',
    '  vec3 outC = mix( base, refl, wgt );',
    '',
    '  // ---- analytic practicals on the water plane ---------------------------',
    '  // ADDED, not lerped, and that is the correct operator for this one term:',
    '  // it is the specular lobe of a light source, i.e. radiance the surface',
    '  // returns IN ADDITION to its diffuse - unlike the screen-space term above,',
    '  // which stands in for the environment the albedo is competing with.',
    '  // Masked to genuinely horizontal wet surface (up) and to Fresnel, so a',
    '  // container flank and a dry patch get nothing.',
    '  if ( uPracCount > 0 ) {',
    '    vec3 Nw2 = Nw0;',
    '    float up2 = smoothstep( uUpLo, uUpHi, Nw2.y );',
    '    // Same wet field the reflection and the roughness now use. A lamp smear',
    '    // that lands where materials.js drew standing water is the effect; one',
    '    // that lands on a damp high spot next to it is a second, uncorrelated',
    '    // puddle field printed on top of the first. The modulation only ever',
    '    // REDUCES - a field that can also boost turns a correlation into a',
    '    // brightness change, and this term is already close to its ceiling.',
    '    float wet2 = uWetness * up2 * mix( 0.55, 1.0, clamp( max( film, pud ), 0.0, 1.0 ) );',
    '    if ( wet2 > 0.02 ) {',
    '      vec3 Wp2 = Wp;',
    '      vec3 Nrip = pfSsrRipple( Nw2, Wp2, up2, -P.z );',
    '      vec3 Vw = uViewToWorld * V;',
    '      float F2 = uF0 + ( 1.0 - uF0 ) * pow( 1.0 - clamp( dot( Nrip, Vw ), 0.0, 1.0 ), 5.0 );',
    '      // ...at the LOBE\'s own agitation floor, not the blur kernel\'s. See',
    '      // settings.ssrPracticalFloor: sharing one floor with the gather is',
    '      // what turned this term into a flat plate on the apron.',
    '      vec3 lobe = pfPracLobe( Wp2, Nrip, Vw, max( rough, uPracFloor ) );',
    '      outC += pfSafe( lobe ) * ( F2 * wet2 );',
    '    }',
    '  }',
    '',
    '  gl_FragColor = vec4( pfSafe( outC ), 1.0 );',
    '}'
  );

  // ---- TAA -----------------------------------------------------------------
  // The single biggest image-quality win available here. Halton(2,3) jitter on
  // the projection turns 8 frames into an 8x supersample; the neighbourhood
  // clip in YCoCg is what stops that turning into a smear.
  var FRAG_TAA = glsl(
    COMMON,
    'uniform sampler2D tCurrent;',
    'uniform sampler2D tHistory;',
    'uniform sampler2D tVelocity;',
    'uniform sampler2D tDepth;',
    'uniform vec2 uTexel;',
    'uniform float uFeedbackMin;',
    'uniform float uFeedbackMax;',
    'uniform float uVarianceGamma;',
    'uniform float uHistoryValid;',
    '',
    '// Line-vs-box clip. Clamping (rather than clipping) to the neighbourhood',
    '// AABB keeps too much stale colour and reads as ghosting; clipping walks',
    '// the history toward the current colour until it enters the box.',
    'vec3 pfClipAABB( vec3 mn, vec3 mx, vec3 q ) {',
    '  vec3 c = 0.5 * ( mx + mn );',
    '  vec3 e = 0.5 * ( mx - mn ) + 1e-5;',
    '  vec3 v = q - c;',
    '  vec3 a = abs( v / e );',
    '  float ma = max( a.x, max( a.y, a.z ) );',
    '  return ma > 1.0 ? c + v / ma : q;',
    '}',
    '',
    '// Catmull-Rom history fetch (5 bilinear taps). Plain bilinear resampling',
    '// of the history is what makes most naive TAA implementations look soft.',
    'vec3 pfSampleHistory( vec2 uv, vec2 texel ) {',
    '  vec2 res = 1.0 / texel;',
    '  vec2 samplePos = uv * res;',
    '  vec2 texPos1 = floor( samplePos - 0.5 ) + 0.5;',
    '  vec2 f = samplePos - texPos1;',
    '  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );',
    '  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );',
    '  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );',
    '  vec2 w3 = f * f * ( -0.5 + 0.5 * f );',
    '  vec2 w12 = w1 + w2;',
    '  vec2 offset12 = w2 / max( w12, vec2( 1e-5 ) );',
    '  vec2 texPos0 = ( texPos1 - 1.0 ) * texel;',
    '  vec2 texPos3 = ( texPos1 + 2.0 ) * texel;',
    '  vec2 texPos12 = ( texPos1 + offset12 ) * texel;',
    '  vec3 r = vec3( 0.0 );',
    '  r += texture2D( tHistory, vec2( texPos12.x, texPos0.y ) ).rgb * w12.x * w0.y;',
    '  r += texture2D( tHistory, vec2( texPos0.x,  texPos12.y ) ).rgb * w0.x * w12.y;',
    '  r += texture2D( tHistory, vec2( texPos12.x, texPos12.y ) ).rgb * w12.x * w12.y;',
    '  r += texture2D( tHistory, vec2( texPos3.x,  texPos12.y ) ).rgb * w3.x * w12.y;',
    '  r += texture2D( tHistory, vec2( texPos12.x, texPos3.y ) ).rgb * w12.x * w3.y;',
    '  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;',
    '  return pfSafe( r / max( wsum, 1e-5 ) );',
    '}',
    '',
    'void main() {',
    '  vec3 cur = pfSafe( texture2D( tCurrent, vUv ).rgb );',
    '',
    '  if ( uHistoryValid < 0.5 ) { gl_FragColor = vec4( cur, 1.0 ); return; }',
    '',
    '  // Velocity dilation: take the motion vector of the closest fragment in a',
    '  // 3x3 so thin silhouettes drag their own history instead of the',
    '  // background sliding through them.',
    '  vec2 bestUv = vUv;',
    '  float bestDepth = 1.0;',
    '  for ( int y = -1; y <= 1; y++ ) {',
    '    for ( int x = -1; x <= 1; x++ ) {',
    '      vec2 o = vec2( float( x ), float( y ) ) * uTexel;',
    '      float dz = texture2D( tDepth, vUv + o ).x;',
    '      if ( dz < bestDepth ) { bestDepth = dz; bestUv = vUv + o; }',
    '    }',
    '  }',
    '  vec2 vel = texture2D( tVelocity, bestUv ).xy;',
    '  vec2 histUv = vUv - vel;',
    '',
    '  if ( histUv.x < 0.0 || histUv.x > 1.0 || histUv.y < 0.0 || histUv.y > 1.0 ) {',
    '    gl_FragColor = vec4( cur, 1.0 );',
    '    return;',
    '  }',
    '',
    '  // 3x3 neighbourhood statistics in YCoCg - chroma-decorrelated, so the',
    '  // clip box hugs the actual colour distribution far more tightly.',
    '  vec3 m1 = vec3( 0.0 );',
    '  vec3 m2 = vec3( 0.0 );',
    '  vec3 nmin = vec3( 1e9 );',
    '  vec3 nmax = vec3( -1e9 );',
    '  for ( int y = -1; y <= 1; y++ ) {',
    '    for ( int x = -1; x <= 1; x++ ) {',
    '      vec2 o = vec2( float( x ), float( y ) ) * uTexel;',
    '      vec3 s = pfRGBToYCoCg( pfSafe( texture2D( tCurrent, vUv + o ).rgb ) );',
    '      m1 += s; m2 += s * s;',
    '      nmin = min( nmin, s );',
    '      nmax = max( nmax, s );',
    '    }',
    '  }',
    '  vec3 mean = m1 / 9.0;',
    '  vec3 sigma = sqrt( max( m2 / 9.0 - mean * mean, vec3( 0.0 ) ) );',
    '  // Intersect the variance box with the hard min/max: variance alone lets',
    '  // fireflies through, min/max alone is too permissive on noisy pixels.',
    '  vec3 vmin = max( mean - uVarianceGamma * sigma, nmin );',
    '  vec3 vmax = min( mean + uVarianceGamma * sigma, nmax );',
    '',
    '  vec3 histRaw = pfSampleHistory( histUv, uTexel );',
    '  vec3 rawY = pfRGBToYCoCg( histRaw );',
    '  vec3 histY = pfClipAABB( vmin, vmax, rawY );',
    '  // How far the clip had to drag the history to get it back inside the',
    '  // neighbourhood box, in units of the box itself. The velocity buffer is',
    '  // camera-reprojection only, so an enemy, a tracer or a shell carries zero',
    '  // velocity and reprojects to the BACKGROUND - the only evidence that this',
    '  // pixel is a mover (or a disocclusion) is exactly this distance. It was',
    '  // already being computed and thrown away.',
    '  float clipDist = length( rawY - histY ) / max( length( vmax - vmin ), 1e-4 );',
    '  vec3 hist = pfSafe( pfYCoCgToRGB( histY ) );',
    '',
    '  // NOTE: there used to be an unsharp on `cur` here. It was structurally',
    '  // dead - an edge pixel already sits at its own neighbourhood min/max, so',
    '  // the sharpen pushed it out of the box and the very next clamp snapped it',
    '  // back - and what survived was then multiplied by (1 - feedback). The',
    '  // sharpen now runs as its own RCAS pass on the RESOLVED image (see',
    '  // FRAG_SHARPEN), which is both effective and cannot compound into the',
    '  // history the way sharpening the blend input would.',
    '',
    '  // Drop feedback with speed: fast motion has no usable history anyway and',
    '  // holding on to it is exactly what produces trails.',
    '  float speed = length( vel / uTexel );',
    '  float feedback = mix( uFeedbackMax, uFeedbackMin, clamp( speed / 34.0, 0.0, 1.0 ) );',
    '  // Drop the feedback wherever the history had to be dragged: without this a',
    '  // laterally-moving enemy holds ~10 frames of clipped history and smears.',
    '  feedback *= 1.0 / ( 1.0 + clipDist * 2.5 );',
    '',
    '  // Karis luminance weighting - stops a single bright sample from',
    '  // dominating the average and flickering.',
    '  float wc = ( 1.0 - feedback ) / ( 1.0 + pfLum( cur ) );',
    '  float wh = feedback / ( 1.0 + pfLum( hist ) );',
    '  vec3 result = ( cur * wc + hist * wh ) / max( wc + wh, 1e-5 );',
    '',
    '  gl_FragColor = vec4( pfSafe( result ), 1.0 );',
    '}'
  );

  // ---- post-resolve sharpen (RCAS-style) -----------------------------------
  // Runs on the TAA *output*, into a separate target, so (a) the neighbourhood
  // clip cannot undo it, (b) the feedback factor cannot attenuate it, and
  // (c) the history never re-sharpens itself frame after frame. The limiter is
  // a soft box around the 5-tap min/max, which is what stops the ringing that
  // makes naive unsharp look like a filter rather than resolution.
  //
  // The whole kernel runs on DISPLAY-REFERRED values (a 1/2.2 encode in, 2.2
  // out). In HDR linear, `c - avg` across a mid-tone edge is tiny relative to
  // the contrast the eye actually perceives there, because the OETF expands the
  // darks - which is why every shipping RCAS runs display-referred. The same
  // numeric amount buys roughly three times the visible acutance here, so the
  // amount can come DOWN and still gain, with less ringing.
  //
  // THE LIMITER IS THE LOCAL MIN/MAX, EXACTLY. It used to be widened to
  // (mn*0.92, mx*1.08), which throws away the one structural guarantee RCAS
  // offers: if the output cannot leave the 5-tap neighbourhood, a halo is
  // impossible by construction. The 8% slack re-admitted them, and they were
  // measurable - 1-pixel undershoot spikes covered 1.665% of street.png at 720p
  // and 0.945% of the same frame at 1440p, i.e. the density halved with
  // resolution, which is the signature of a screen-space filter artifact rather
  // than geometry. With a true clamp the same numeric amount reads sharper,
  // because none of it is being spent carving dark rims.
  var FRAG_SHARPEN = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    'uniform float uAmount;',
    // ---- storm additions, both exact no-ops at their market defaults --------
    // uKnD is the frame's key level (1.0 = the noon reference), so the
    // silhouette guard below MEANS the same thing at 0.10 mean luminance as it
    // does at 0.29. uExtGate 0 removes the periodic-extremum test entirely.
    'uniform float uKnD;',
    'uniform float uExtGate;',
    'vec3 pfEnc( vec3 c ) { return pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) ); }',
    'vec3 pfDec( vec3 c ) { return pow( max( c, vec3( 0.0 ) ), vec3( 2.2 ) ); }',
    'void main() {',
    '  vec3 c0 = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  if ( uAmount < 1e-4 ) { gl_FragColor = vec4( c0, 1.0 ); return; }',
    '  vec3 c = pfEnc( c0 );',
    '  vec3 n = pfEnc( pfSafe( texture2D( tSrc, vUv + vec2( 0.0, uTexel.y ) ).rgb ) );',
    '  vec3 s = pfEnc( pfSafe( texture2D( tSrc, vUv - vec2( 0.0, uTexel.y ) ).rgb ) );',
    '  vec3 e = pfEnc( pfSafe( texture2D( tSrc, vUv + vec2( uTexel.x, 0.0 ) ).rgb ) );',
    '  vec3 w = pfEnc( pfSafe( texture2D( tSrc, vUv - vec2( uTexel.x, 0.0 ) ).rgb ) );',
    '  vec3 avg = ( n + s + e + w ) * 0.25;',
    '  // Karis weight: without it a single hot pixel carves a black ring.',
    '  float k = uAmount / ( 1.0 + pfLum( c ) * 0.35 );',
    '  vec3 mn = min( c, min( min( n, s ), min( e, w ) ) );',
    '  vec3 mx = max( c, max( max( n, s ), max( e, w ) ) );',
    '  // Leave already-hard silhouettes alone. Above ~0.35 of encoded local',
    '  // contrast the edge is a hard occlusion boundary (wire against sky, a',
    '  // sandbag rim, the enemy against a wall); it needs no acutance help and',
    '  // it is where a sharpener is most visible when it misbehaves.',
    '  //',
    '  // NORMALISED BY THE KEY. The threshold pair is an ABSOLUTE encoded',
    '  // contrast, and a 02:00 frame whose whole histogram sits two stops down',
    '  // never reaches 0.34 - so on a night level the guard fired nowhere and',
    '  // the entire sharpen budget went into the one place it must not go.',
    '  k *= 1.0 - smoothstep( 0.34 * uKnD, 0.62 * uKnD, pfLum( mx - mn ) );',
    '  // NO-RECOVERABLE-DETAIL GATE. RCAS\'s min/max limiter is structurally',
    '  // inert on a periodic comb: a 2 px rib pattern already spans the full',
    '  // 5-tap range, so the clamp never binds and the sharpen drives every rib',
    '  // to its own local extreme - which is how container corrugation stops',
    '  // reading as a surface and starts reading as a barcode. A pixel that is',
    '  // a local extremum along BOTH axes is not an edge; there is no acutance',
    '  // to buy there, only amplitude.',
    '  float lc = pfLum( c );',
    '  float ex = step( 0.0, ( pfLum( e ) - lc ) * ( pfLum( w ) - lc ) );',
    '  float ey = step( 0.0, ( pfLum( n ) - lc ) * ( pfLum( s ) - lc ) );',
    '  k *= mix( 1.0, 1.0 - ex * ey, uExtGate );',
    '  vec3 sharp = c + ( c - avg ) * k;',
    '  gl_FragColor = vec4( pfDec( clamp( sharp, mn, mx ) ), 1.0 );',
    '}'
  );

  // ---- FXAA fallback (quality.taa === false) -------------------------------
  var FRAG_FXAA = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    '// Reversible Reinhard: FXAA is a luma-edge detector and HDR values wreck',
    '// its thresholds, so the whole thing runs in a compressed range.',
    'vec3 pfTm( vec3 c ) { return c / ( 1.0 + pfLum( c ) ); }',
    'vec3 pfUnTm( vec3 c ) { return c / max( 1.0 - pfLum( c ), 1e-4 ); }',
    'void main() {',
    '  vec3 rgbM  = pfTm( pfSafe( texture2D( tSrc, vUv ).rgb ) );',
    '  vec3 rgbNW = pfTm( pfSafe( texture2D( tSrc, vUv + vec2( -uTexel.x, -uTexel.y ) ).rgb ) );',
    '  vec3 rgbNE = pfTm( pfSafe( texture2D( tSrc, vUv + vec2(  uTexel.x, -uTexel.y ) ).rgb ) );',
    '  vec3 rgbSW = pfTm( pfSafe( texture2D( tSrc, vUv + vec2( -uTexel.x,  uTexel.y ) ).rgb ) );',
    '  vec3 rgbSE = pfTm( pfSafe( texture2D( tSrc, vUv + vec2(  uTexel.x,  uTexel.y ) ).rgb ) );',
    '  float lM = pfLum( rgbM ), lNW = pfLum( rgbNW ), lNE = pfLum( rgbNE );',
    '  float lSW = pfLum( rgbSW ), lSE = pfLum( rgbSE );',
    '  float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );',
    '  float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );',
    '  if ( lMax - lMin < max( 0.0312, lMax * 0.125 ) ) {',
    '    gl_FragColor = vec4( pfUnTm( rgbM ), 1.0 );',
    '    return;',
    '  }',
    '  vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( lNW + lSW ) - ( lNE + lSE ) );',
    '  float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.03125, 0.0078125 );',
    '  float rcpMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );',
    '  dir = clamp( dir * rcpMin, vec2( -8.0 ), vec2( 8.0 ) ) * uTexel;',
    '  vec3 rgbA = 0.5 * ( pfTm( pfSafe( texture2D( tSrc, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb ) )',
    '                    + pfTm( pfSafe( texture2D( tSrc, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb ) ) );',
    '  vec3 rgbB = rgbA * 0.5 + 0.25 * ( pfTm( pfSafe( texture2D( tSrc, vUv - dir * 0.5 ).rgb ) )',
    '                                  + pfTm( pfSafe( texture2D( tSrc, vUv + dir * 0.5 ).rgb ) ) );',
    '  float lB = pfLum( rgbB );',
    '  gl_FragColor = vec4( pfUnTm( ( lB < lMin || lB > lMax ) ? rgbA : rgbB ), 1.0 );',
    '}'
  );

  // ---- depth of field ------------------------------------------------------
  // Signed circle of confusion: negative = near field, positive = far field.
  //
  // THE CoC IS A DIOPTRE DIFFERENCE, 1/z - 1/focus. That is the thin-lens
  // result, and it is the only form that behaves: focused 50 m down the street
  // it leaves a crate at 8 m sharp (real hyperfocal behaviour), while a gun
  // 0.3 m from the eye is unrecoverably soft no matter where you focus. The
  // previous RELATIVE form, (z - focus)/z, saturated the near field for
  // everything closer than ~focus/4, so with the focus raycast landing 50 m
  // downrange the entire foreground sat at nearC = 1 and the "strength" blend
  // then smeared a flat low-amplitude veil over the whole frame - a global
  // micro-contrast tax that bought no depth cue at all.
  //
  // Both dead bands and both ranges below are therefore in DIOPTRES (1/m).
  //
  // uStrength is gone from the combine: strength is a RADIUS now, so an
  // in-focus pixel comes through bit-exact and the blend is driven purely by
  // CoC. A 100% mix of a small blur is the correct shape; a 14% mix of a large
  // one is a low-pass with a long tail.
  //
  // pfSceneZ folds in the VIEWMODEL's own depth buffer. The weapon is rendered
  // by a second camera from the same eye point, so its linear depth is already
  // a real distance in metres - the two cameras differ only in FOV and clip
  // planes, so no rescale is needed (rescaling by far/far, as one might assume,
  // would be wrong). Without this the viewmodel is structurally incapable of
  // near-field defocus, and the single most recognisable lens signature of a
  // modern shooter - soft stock and gloves, crisp optic - cannot occur.
  var COC = [
    'uniform sampler2D tViewDepth;',
    'uniform float uVNear;',
    'uniform float uVFar;',
    'uniform float uHasView;',
    'uniform float uFocus;',
    'uniform float uNearDead;',
    'uniform float uFarDead;',
    'uniform float uNearRange;',
    'uniform float uFarRange;',
    'float pfViewZ( float d ) {',
    '  float z = d * 2.0 - 1.0;',
    '  return ( 2.0 * uVNear * uVFar ) / ( uVFar + uVNear - z * ( uVFar - uVNear ) );',
    '}',
    '// Distance to whatever the eye actually sees here: the world, or the',
    '// viewmodel where the weapon covers it.',
    'float pfSceneZ( vec2 uv, float worldZ ) {',
    '  if ( uHasView > 0.5 ) {',
    '    float dv = texture2D( tViewDepth, uv ).x;',
    '    if ( dv < 0.999999 ) return min( worldZ, pfViewZ( dv ) );',
    '  }',
    '  return worldZ;',
    '}',
    'float pfCoC( float z ) {',
    '  float dio = 1.0 / max( z, 0.02 ) - 1.0 / max( uFocus, 0.05 );',
    '  float farC  = clamp( ( -dio - uFarDead ) / max( uFarRange, 1e-3 ), 0.0, 1.0 );',
    '  float nearC = clamp( (  dio - uNearDead ) / max( uNearRange, 1e-3 ), 0.0, 1.0 );',
    '  return farC - nearC;',
    '}'
  ].join('\n');

  // Downsample colour + CoC to half res. The near-field CoC is taken as a max
  // over the footprint so out-of-focus foreground can expand outward instead of
  // ending at a hard silhouette.
  var FRAG_DOF_PREP = glsl(
    COMMON, DEPTH, COC,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tDepth;',
    'uniform vec2 uSrcTexel;',
    'void main() {',
    '  vec3 col = vec3( 0.0 );',
    '  float farMax = 0.0;',
    '  float nearMax = 0.0;',
    '  for ( int y = 0; y < 2; y++ ) {',
    '    for ( int x = 0; x < 2; x++ ) {',
    '      vec2 o = ( vec2( float( x ), float( y ) ) - 0.5 ) * uSrcTexel;',
    '      col += pfSafe( texture2D( tSrc, vUv + o ).rgb );',
    '      float c = pfCoC( pfSceneZ( vUv + o, pfLinearDepth( texture2D( tDepth, vUv + o ).x ) ) );',
    '      farMax = max( farMax, c );',
    '      nearMax = max( nearMax, -c );',
    '    }',
    '  }',
    '  col *= 0.25;',
    '  float coc = nearMax > farMax ? -nearMax : farMax;',
    '  gl_FragColor = vec4( col, coc );',
    '}'
  );

  // Golden-angle spiral bokeh gather, scatter-as-gather weighted.
  var FRAG_DOF_BLUR = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    'uniform float uMaxRadius;',
    'uniform float uFrame;',
    'uniform int uTaps;',
    'const int PF_DOF_MAX = 32;',
    'void main() {',
    '  vec4 c0 = texture2D( tSrc, vUv );',
    '  float r0 = abs( c0.a ) * uMaxRadius;',
    '  if ( r0 < 0.6 ) { gl_FragColor = c0; return; }',
    '',
    '  // Per-pixel rotation of the spiral; TAA has already resolved by this',
    '  // point so the rotation is purely spatial, which is what keeps the',
    '  // bokeh from showing its sample pattern.',
    '  float rot = pfIGN( gl_FragCoord.xy ) * 6.2831853 + pfR2( uFrame ) * 6.2831853;',
    '  float cr = cos( rot ), sr = sin( rot );',
    '  mat2 rm = mat2( cr, -sr, sr, cr );',
    '',
    '  vec3 sum = c0.rgb;',
    '  float wsum = 1.0;',
    '  float nearCov = max( -c0.a, 0.0 );',
    '  float ft = float( uTaps );',
    '',
    '  for ( int i = 0; i < PF_DOF_MAX; i++ ) {',
    '    if ( i >= uTaps ) break;',
    '    float fi = float( i ) + 0.5;',
    '    float a = fi * 2.39996323;',
    '    float rad = sqrt( fi / ft );',
    '    vec2 off = rm * ( vec2( cos( a ), sin( a ) ) * rad );',
    '    vec2 suv = vUv + off * r0 * uTexel;',
    '    vec4 s = texture2D( tSrc, suv );',
    '    float sr2 = abs( s.a ) * uMaxRadius;',
    '    // A sample only contributes if its own CoC is wide enough to have',
    '    // scattered this far - this is what prevents in-focus foreground',
    '    // bleeding into a blurred background.',
    '    float dist = rad * r0;',
    '    float w = clamp( ( sr2 - dist ) * 0.5 + 1.0, 0.0, 1.0 );',
    '    // Slight highlight weighting gives bokeh its bright-disc character.',
    '    w *= 1.0 + 0.35 * clamp( pfLum( s.rgb ) - 1.0, 0.0, 3.0 );',
    '    sum += pfSafe( s.rgb ) * w;',
    '    wsum += w;',
    '    nearCov = max( nearCov, max( -s.a, 0.0 ) * clamp( ( sr2 - dist ) * 0.5 + 1.0, 0.0, 1.0 ) );',
    '  }',
    '',
    '  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), nearCov );',
    '}'
  );

  var FRAG_DOF_COMBINE = glsl(
    COMMON, DEPTH, COC,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tBlur;',
    'uniform sampler2D tDepth;',
    'uniform float uBlendLo;',
    'uniform float uBlendHi;',
    'void main() {',
    '  vec3 sharp = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  float coc = pfCoC( pfSceneZ( vUv, pfLinearDepth( texture2D( tDepth, vUv ).x ) ) );',
    '  vec4 blur = texture2D( tBlur, vUv );',
    '  // Near coverage comes from the half-res gather so foreground blur can',
    '  // spill over sharp background, which is how a real lens behaves.',
    '  // Below uBlendLo the sharp image is returned untouched - literally the',
    '  // same bits - so DoF can never cost micro-contrast where it buys nothing.',
    '  //',
    '  // THE CROSSOVER IS IN CoC UNITS AND HAS TO BE SCALED TO THE RADIUS THOSE',
    '  // UNITS BUY. The gather runs at HALF RESOLUTION, so taking blur.rgb at',
    '  // full weight discards a resolution halving whatever the radius is - and',
    '  // the shipped 0.03/0.22 pair saturates at CoC 0.22, which against',
    '  // dofMaxRadius 3.0 is 0.66 of ONE half-res texel, i.e. about 1.3 full-res',
    '  // pixels of intended blur being paid for with a full half-res round trip.',
    '  // On an establishing shot of an 80 m yard focused at 12 m that is the',
    '  // whole subject: everything past ~35 m came through at 100% half res and',
    '  // everything past ~20 m at more than half, which is exactly the "soft,',
    '  // low-contrast, hard to parse" read - not fog, not bloom, and not a DoF',
    '  // amount anyone authored. 0.22 was never a blur decision, it was a blend',
    '  // constant that happens to sit five times below where the blur it is',
    '  // blending in becomes worth having.',
    '  //',
    '  // The two are uniforms so the crossover can be stated where it belongs -',
    '  // in half-res texels of actual gather radius - and divided back into CoC',
    '  // by the caller. The market passes the shipped constants unchanged.',
    '  float t = smoothstep( uBlendLo, uBlendHi, max( coc, blur.a ) );',
    '  if ( t <= 0.0 ) { gl_FragColor = vec4( sharp, 1.0 ); return; }',
    '  gl_FragColor = vec4( mix( sharp, pfSafe( blur.rgb ), t ), 1.0 );',
    '}'
  );

  // ---- motion blur ---------------------------------------------------------
  // Separable tile max over a 16x16 tile: one horizontal sweep, one vertical.
  // uScale expands this fragment into its source tile origin, uAxis picks the
  // sweep direction; the other axis stays on this fragment's own texel centre.
  var FRAG_TILE_MAX = glsl(
    COMMON,
    'uniform sampler2D tVel;',
    'uniform vec2 uSrcTexel;',
    'uniform vec2 uScale;',
    'uniform vec2 uAxis;',
    'void main() {',
    '  vec2 origin = floor( gl_FragCoord.xy ) * uScale + 0.5 * ( vec2( 1.0 ) - uAxis );',
    '  vec2 best = vec2( 0.0 );',
    '  float bestLen = -1.0;',
    '  for ( int i = 0; i < 16; i++ ) {',
    '    vec2 uv = ( origin + ( float( i ) + 0.5 ) * uAxis ) * uSrcTexel;',
    '    vec2 v = texture2D( tVel, uv ).xy;',
    '    float l = dot( v, v );',
    '    if ( l > bestLen ) { bestLen = l; best = v; }',
    '  }',
    '  gl_FragColor = vec4( best, 0.0, 1.0 );',
    '}'
  );

  var FRAG_NEIGHBOR_MAX = glsl(
    COMMON,
    'uniform sampler2D tTile;',
    'uniform vec2 uTexel;',
    'void main() {',
    '  vec2 best = vec2( 0.0 );',
    '  float bestLen = -1.0;',
    '  for ( int y = -1; y <= 1; y++ ) {',
    '    for ( int x = -1; x <= 1; x++ ) {',
    '      vec2 v = texture2D( tTile, vUv + vec2( float( x ), float( y ) ) * uTexel ).xy;',
    '      float l = dot( v, v );',
    '      if ( l > bestLen ) { bestLen = l; best = v; }',
    '    }',
    '  }',
    '  gl_FragColor = vec4( best, 0.0, 1.0 );',
    '}'
  );

  // Reconstruction filter after McGuire et al. - foreground and background
  // samples are weighted separately so a fast object smears over what is behind
  // it rather than the background smearing over the object.
  var FRAG_MOTION_BLUR = glsl(
    COMMON, DEPTH,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tVel;',
    'uniform sampler2D tNeighbor;',
    'uniform sampler2D tDepth;',
    'uniform vec2 uTexel;',
    'uniform vec2 uRes;',
    'uniform float uStrength;',
    'uniform float uMaxPixels;',
    'uniform float uFrame;',
    'uniform int uTaps;',
    'const int PF_MB_MAX = 16;',
    'float pfSoftDepth( float za, float zb ) { return clamp( 1.0 - ( za - zb ) / 0.9, 0.0, 1.0 ); }',
    'float pfCone( float d, float speed ) { return clamp( 1.0 - d / max( speed, 1e-4 ), 0.0, 1.0 ); }',
    'float pfCylinder( float d, float speed ) { return 1.0 - smoothstep( 0.95 * speed, 1.05 * speed, d ); }',
    'void main() {',
    '  vec3 center = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  vec2 vn = texture2D( tNeighbor, vUv ).xy * uStrength;',
    '  float vnPix = length( vn * uRes );',
    '  if ( vnPix < 1.2 ) { gl_FragColor = vec4( center, 1.0 ); return; }',
    '  // Hard clamp so a big camera slew never turns the frame into a streak.',
    '  if ( vnPix > uMaxPixels ) { vn *= uMaxPixels / vnPix; vnPix = uMaxPixels; }',
    '',
    '  vec2 vc = texture2D( tVel, vUv ).xy * uStrength;',
    '  float vcPix = max( length( vc * uRes ), 0.5 );',
    '  float zc = pfLinearDepth( texture2D( tDepth, vUv ).x );',
    '',
    '  float rnd = pfIGN( gl_FragCoord.xy ) + pfR2( uFrame );',
    '  vec3 sum = center * ( 1.0 / max( vcPix, 1.0 ) );',
    '  float wsum = 1.0 / max( vcPix, 1.0 );',
    '  float ft = float( uTaps );',
    '',
    '  for ( int i = 0; i < PF_MB_MAX; i++ ) {',
    '    if ( i >= uTaps ) break;',
    '    float t = ( ( float( i ) + rnd ) / ft ) - 0.5;',
    '    vec2 suv = vUv + vn * t;',
    '    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;',
    '    float zs = pfLinearDepth( texture2D( tDepth, suv ).x );',
    '    vec2 vs = texture2D( tVel, suv ).xy * uStrength;',
    '    float vsPix = max( length( vs * uRes ), 0.5 );',
    '    float dPix = abs( t ) * vnPix;',
    '    float fg = pfSoftDepth( zc, zs );',
    '    float bg = pfSoftDepth( zs, zc );',
    '    float w = fg * pfCone( dPix, vsPix ) + bg * pfCone( dPix, vcPix )',
    '            + pfCylinder( dPix, vsPix ) * pfCylinder( dPix, vcPix ) * 2.0;',
    '    sum += pfSafe( texture2D( tSrc, suv ).rgb ) * w;',
    '    wsum += w;',
    '  }',
    '  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), 1.0 );',
    '}'
  );

  // ---- viewmodel overlay ---------------------------------------------------
  // The weapon is rendered into its own supersampled target with its own depth
  // buffer, then composited here - after world motion blur (which must never
  // eat into it: the gun is bolted to the camera and has zero screen velocity
  // under a turn, while the velocity buffer at those pixels carries the STREET's
  // motion) and before DoF, sharpen and bloom, all three of which the weapon
  // should receive exactly as the world does.
  //
  // The overlay also carries the VIEWMODEL EXPOSURE LOCK. `meterSrc` keeps the
  // gun out of metering, but the composite then multiplies the already-overlaid
  // weapon by the world's full auto-exposure x todBias - so the hero asset
  // floated over three stops between scenarios (near-black in weapon_closeup,
  // pale grey plastic in interior, and at night the brightest large object in
  // the frame, contrast polarity inverted against the world). Dividing back out
  // a fraction of the metered gain here re-anchors it: it still darkens at
  // night, it just stops becoming a different object.
  var FRAG_OVERLAY = glsl(
    COMMON,
    'uniform sampler2D tWorld;',
    'uniform sampler2D tView;',
    'uniform sampler2D tExposure;',
    'uniform vec2 uViewTexel;',
    'uniform float uRefExposure;',
    'uniform float uViewLock;',
    'uniform float uTodBias;',
    'void main() {',
    '  vec3 world = pfSafe( texture2D( tWorld, vUv ).rgb );',
    '',
    '  // 3x3 tent resolve of the supersampled viewmodel target. The viewmodel',
    '  // is not TAA-resolved (it has no meaningful velocity, so reprojection',
    '  // would ghost it), so it gets its antialiasing from supersampling here.',
    '  // The tent is exactly one source texel wide - there is no longer a fixed',
    '  // uViewBlur widening it, because a constant uniform blur is the wrong',
    '  // answer to a depth problem and the DoF pass now gives the weapon a real',
    '  // circle of confusion instead.',
    '  vec4 v = vec4( 0.0 );',
    '  float wsum = 0.0;',
    '  for ( int y = -1; y <= 1; y++ ) {',
    '    for ( int x = -1; x <= 1; x++ ) {',
    '      float w = ( x == 0 ? 2.0 : 1.0 ) * ( y == 0 ? 2.0 : 1.0 );',
    '      vec2 o = vec2( float( x ), float( y ) ) * uViewTexel;',
    '      vec4 s = texture2D( tView, vUv + o );',
    '      v += vec4( pfSafe( s.rgb ), s.a ) * w;',
    '      wsum += w;',
    '    }',
    '  }',
    '  v /= wsum;',
    '',
    '  float ex = texture2D( tExposure, vec2( 0.5 ) ).r * max( uTodBias, 1e-4 );',
    '  v.rgb *= pow( clamp( uRefExposure / max( ex, 1e-4 ), 0.06, 4.0 ), uViewLock );',
    '',
    '  gl_FragColor = vec4( mix( world, v.rgb, clamp( v.a, 0.0, 1.0 ) ), 1.0 );',
    '}'
  );

  // ---- bloom ---------------------------------------------------------------
  // Soft-knee bright pass with a Karis-averaged 13-tap downsample. The Karis
  // average (weighting by 1/(1+luma) inside each quad) is what stops a single
  // blown pixel from producing a crawling firefly halo.
  //
  // EVERY operation in this pass is a SCALAR multiply of the fetched triple, and
  // that is deliberate: a scalar cannot change a hue. The threshold uses the MAX
  // CHANNEL rather than luminance for the same reason - thresholding on
  // luminance fires at different levels for a warm and a cool emitter of equal
  // peak radiance, so a sodium lamp and a mercury lamp would bloom in different
  // colours from the ones they emit. What comes out of here is the emitter's own
  // colour, attenuated; the pyramid below only ever blurs and scales, so the
  // whole chain is hue-exact from source to composite.
  var FRAG_BRIGHT = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tExposure;',
    'uniform vec2 uTexel;',
    'uniform float uThreshold;',
    'uniform float uKnee;',
    'uniform float uClamp;',
    'float pfKarisW( vec3 c ) { return 1.0 / ( 1.0 + pfLum( c ) ); }',
    'void main() {',
    '  vec2 t = uTexel;',
    '  vec3 a = pfSafe( texture2D( tSrc, vUv + t * vec2( -1.0,  1.0 ) ).rgb );',
    '  vec3 b = pfSafe( texture2D( tSrc, vUv + t * vec2(  1.0,  1.0 ) ).rgb );',
    '  vec3 c = pfSafe( texture2D( tSrc, vUv + t * vec2( -1.0, -1.0 ) ).rgb );',
    '  vec3 d = pfSafe( texture2D( tSrc, vUv + t * vec2(  1.0, -1.0 ) ).rgb );',
    '  vec3 e = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  float wa = pfKarisW( a ), wb = pfKarisW( b ), wc = pfKarisW( c ), wd = pfKarisW( d ), we = pfKarisW( e );',
    '  vec3 col = ( a * wa + b * wb + c * wc + d * wd + e * we * 4.0 ) / ( wa + wb + wc + wd + we * 4.0 );',
    '',
    '  // Threshold in exposed space so bloom does not vanish when the scene is',
    '  // dark and does not swallow the frame when it is bright.',
    '  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r;',
    '  vec3 ex = col * exposure;',
    '',
    '  // HUE-PRESERVING ENERGY CAP, ahead of the threshold.',
    '  //',
    '  // A practical lamp, a glowing window card or a muzzle flash arrives here',
    '  // at 30-200x the metered mid-grey. Uncapped, ONE such texel seeds every',
    '  // mip of the pyramid with an amplitude two orders of magnitude above the',
    '  // frame, so the halo is still past the tone curve\'s ceiling several',
    '  // hundred pixels out - which is exactly how an emitter prints as a large',
    '  // flat white disc with a hard edge instead of as a source with a falloff.',
    '  // The cap says: a source may bloom WIDER than its neighbours (it covers',
    '  // more of the pyramid) but not indefinitely BRIGHTER. Scaling the whole',
    '  // triple by its max channel is the only clamp that leaves R:G:B intact, so',
    '  // a sodium lamp still seeds the pyramid warm-orange rather than being',
    '  // squared off channel-by-channel into white.',
    '  float mx = pfMax3( ex );',
    '  if ( mx > uClamp ) ex *= uClamp / max( mx, 1e-4 );',
    '',
    '  float br = min( mx, uClamp );',
    '  float soft = clamp( br - uThreshold + uKnee, 0.0, 2.0 * uKnee );',
    '  soft = soft * soft / ( 4.0 * uKnee + 1e-4 );',
    '  float contrib = max( soft, br - uThreshold ) / max( br, 1e-4 );',
    '  gl_FragColor = vec4( ex * contrib, 1.0 );',
    '}'
  );

  // 13-tap downsample (Jimenez / "Next Generation Post Processing in Call of
  // Duty: Advanced Warfare"). Stable under motion in a way a box filter is not.
  var FRAG_DOWNSAMPLE = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    'void main() {',
    '  vec2 t = uTexel;',
    '  vec3 a = pfSafe( texture2D( tSrc, vUv + t * vec2( -2.0,  2.0 ) ).rgb );',
    '  vec3 b = pfSafe( texture2D( tSrc, vUv + t * vec2(  0.0,  2.0 ) ).rgb );',
    '  vec3 c = pfSafe( texture2D( tSrc, vUv + t * vec2(  2.0,  2.0 ) ).rgb );',
    '  vec3 d = pfSafe( texture2D( tSrc, vUv + t * vec2( -2.0,  0.0 ) ).rgb );',
    '  vec3 e = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  vec3 f = pfSafe( texture2D( tSrc, vUv + t * vec2(  2.0,  0.0 ) ).rgb );',
    '  vec3 g = pfSafe( texture2D( tSrc, vUv + t * vec2( -2.0, -2.0 ) ).rgb );',
    '  vec3 h = pfSafe( texture2D( tSrc, vUv + t * vec2(  0.0, -2.0 ) ).rgb );',
    '  vec3 i = pfSafe( texture2D( tSrc, vUv + t * vec2(  2.0, -2.0 ) ).rgb );',
    '  vec3 j = pfSafe( texture2D( tSrc, vUv + t * vec2( -1.0,  1.0 ) ).rgb );',
    '  vec3 k = pfSafe( texture2D( tSrc, vUv + t * vec2(  1.0,  1.0 ) ).rgb );',
    '  vec3 l = pfSafe( texture2D( tSrc, vUv + t * vec2( -1.0, -1.0 ) ).rgb );',
    '  vec3 m = pfSafe( texture2D( tSrc, vUv + t * vec2(  1.0, -1.0 ) ).rgb );',
    '  vec3 col = e * 0.125;',
    '  col += ( a + c + g + i ) * 0.03125;',
    '  col += ( b + d + f + h ) * 0.0625;',
    '  col += ( j + k + l + m ) * 0.125;',
    '  gl_FragColor = vec4( col, 1.0 );',
    '}'
  );

  // 9-tap tent upsample, additively blended into the finer mip. Progressive
  // upsampling like this gives a wide, smooth falloff that a single gaussian
  // simply cannot reach at a sane cost.
  //
  // uMipWeight shapes the pyramid. Summing the mips at equal weight (the naive
  // form) makes bloom all skirt and no core: a broad low-amplitude wash that
  // reads as fog, never as a hot source. Attenuating each level as it is folded
  // down means mip 0 dominates and genuinely bright pixels get a tight bright
  // halo instead of a general lift.
  var FRAG_UPSAMPLE = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    'uniform float uRadius;',
    'uniform float uMipWeight;',
    'void main() {',
    '  vec2 t = uTexel * uRadius;',
    '  vec3 col = vec3( 0.0 );',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2( -t.x,  t.y ) ).rgb ) * 1.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2(  0.0,  t.y ) ).rgb ) * 2.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2(  t.x,  t.y ) ).rgb ) * 1.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2( -t.x,  0.0 ) ).rgb ) * 2.0;',
    '  col += pfSafe( texture2D( tSrc, vUv ).rgb ) * 4.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2(  t.x,  0.0 ) ).rgb ) * 2.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb ) * 1.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2(  0.0, -t.y ) ).rgb ) * 2.0;',
    '  col += pfSafe( texture2D( tSrc, vUv + vec2(  t.x, -t.y ) ).rgb ) * 1.0;',
    '  gl_FragColor = vec4( col * ( uMipWeight / 16.0 ), 1.0 );',
    '}'
  );

  // Anamorphic-ish horizontal streak, for the sun flare. Two exponentially
  // widening passes give a long tail for very few taps.
  var FRAG_STREAK = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',
    'uniform vec2 uDir;',
    'uniform float uSpread;',
    'uniform vec3 uTint;',
    'void main() {',
    '  vec3 sum = vec3( 0.0 );',
    '  float wsum = 0.0;',
    '  for ( int i = -6; i <= 6; i++ ) {',
    '    float fi = float( i );',
    '    float w = exp( -fi * fi * 0.08 );',
    '    vec3 tint = mix( vec3( 1.0 ), uTint, clamp( abs( fi ) / 6.0, 0.0, 1.0 ) );',
    '    sum += pfSafe( texture2D( tSrc, vUv + uDir * uTexel * fi * uSpread ).rgb ) * w * tint;',
    '    wsum += w;',
    '  }',
    '  gl_FragColor = vec4( sum / wsum, 1.0 );',
    '}'
  );

  // ---- auto exposure -------------------------------------------------------
  // Everything stays on the GPU. A readPixels round trip would stall the
  // pipeline every frame, and the whole chain is only three tiny reductions.
  var FRAG_LUM_DOWN = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tPrevExp;',
    'uniform vec2 uSrcTexel;',
    'uniform float uTrim;',
    'uniform float uTrimLo;',
    'uniform float uTrimHi;',
    'uniform float uLumFloor;',
    'void main() {',
    '  float sum = 0.0;',
    '  float lw = 0.0;',
    '  // PERCENTILE TRIM (uTrim > 0.5, harbor only; see settings.meterTrim).',
    '  //',
    '  // The Karis weight below rolls highlights off gently, which is the right',
    '  // shape for a daylit frame where the bright part IS most of the frame. It',
    '  // is the wrong shape for a night terminal made of small hot pools in a',
    '  // large dark field: a lamp swinging in and out of view moves a few percent',
    '  // of the pixels by two orders of magnitude, and a gentle roll-off passes',
    '  // enough of that through to visibly pump the stop as the player turns.',
    '  //',
    '  // Excluding everything printing above uTrimLo x mid-grey is a trimmed mean',
    '  // - a percentile estimator without the histogram. It is thresholded on the',
    '  // PREVIOUS frame\'s adapted exposure, which is a slow-moving 1x1 value, so',
    '  // the cut itself cannot oscillate with content the way a per-frame',
    '  // threshold derived from this frame\'s own maximum would.',
    '  float prevEx = uTrim > 0.5 ? max( texture2D( tPrevExp, vec2( 0.5 ) ).r, 1e-4 ) : 1.0;',
    '  for ( int y = 0; y < 2; y++ ) {',
    '    for ( int x = 0; x < 2; x++ ) {',
    '      vec2 o = ( vec2( float( x ), float( y ) ) - 0.5 ) * uSrcTexel * 2.0;',
    '      vec3 c = pfSafe( texture2D( tSrc, vUv + o ).rgb );',
    '      float l = max( pfLum( c ), uLumFloor );',
    '      // Karis-style highlight rejection. A plain log average lets the blown',
    '      // hazy vanishing point at the end of the street set the exposure for',
    '      // the whole frame, which drops the stop and craters the asphalt - the',
    '      // "sky white / ground black" inversion in one line.',
    '      float w = 1.0 / ( 1.0 + l * 0.35 );',
    '      if ( uTrim > 0.5 ) {',
    '        // Never all the way to zero: an all-highlight frame (a flash, a wall',
    '        // of muzzle smoke) must still meter on something.',
    '        w *= max( 1.0 - smoothstep( uTrimLo, uTrimHi, l * prevEx ), 0.035 );',
    '      }',
    '      sum += log( l ) * w;',
    '      lw += w;',
    '    }',
    '  }',
    '  // Centre-weighted metering: the middle of the frame is what the player',
    '  // is looking at. The old mix(0.55, 1.0, ...) over a 0.10-0.55 radius was',
    '  // so shallow that the perimeter carried 79% of the weight of the centre -',
    '  // so a player looking INTO a dark alley metered mostly on the bright slot',
    '  // of sky above it and the alley printed nearly a stop under the street.',
    '  // 0.32 over a tighter radius is still far short of true spot metering (a',
    '  // bright hole in the centre must not be able to swing the whole frame) but',
    '  // it makes the subject the subject.',
    '  vec2 d = vUv - 0.5;',
    '  float weight = mix( 0.32, 1.0, 1.0 - smoothstep( 0.08, 0.46, length( d ) ) );',
    '  gl_FragColor = vec4( sum / max( lw, 1e-5 ), weight, 0.0, 1.0 );',
    '}'
  );

  var FRAG_LUM_REDUCE = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'uniform vec2 uSrcTexel;',
    'uniform float uTaps;',
    'void main() {',
    '  float sum = 0.0;',
    '  float wsum = 0.0;',
    '  for ( int y = 0; y < 8; y++ ) {',
    '    for ( int x = 0; x < 8; x++ ) {',
    '      if ( float( x ) >= uTaps || float( y ) >= uTaps ) continue;',
    '      vec2 o = ( vec2( float( x ), float( y ) ) + 0.5 - uTaps * 0.5 ) * uSrcTexel;',
    '      vec2 s = texture2D( tSrc, vUv + o ).xy;',
    '      sum += s.x * s.y;',
    '      wsum += s.y;',
    '    }',
    '  }',
    '  gl_FragColor = vec4( sum / max( wsum, 1e-5 ), 1.0, 0.0, 1.0 );',
    '}'
  );

  var FRAG_EXPOSURE = glsl(
    COMMON,
    'uniform sampler2D tLum;',
    'uniform sampler2D tPrev;',
    'uniform float uKey;',
    'uniform float uAnchor;',
    'uniform float uSlope;',
    'uniform float uMin;',
    'uniform float uMax;',
    'uniform float uSpeedUp;',
    'uniform float uSpeedDown;',
    'uniform float uHoldScale;',
    'uniform float uDt;',
    'uniform float uReset;',
    'void main() {',
    '  float avg = exp( texture2D( tLum, vec2( 0.5 ) ).x );',
    '  // PARTIAL adaptation. target = uKey / avg is a full auto-normaliser: it',
    '  // drags every scene back to the same printed mean, which is precisely why',
    '  // noon, dusk and midnight measured identically. A slope below 1 leaves the',
    '  // absolute radiance difference in the image and lets the auto term only',
    '  // trim for local content. uAnchor is the scene average the key was',
    '  // authored against; being wrong about it by 2x costs ~27% of a stop, so it',
    '  // is a soft constant rather than a calibration.',
    '  float ratio = clamp( uAnchor / max( avg, 1e-4 ), 0.02, 60.0 );',
    '  float target = clamp( ( uKey / uAnchor ) * pow( ratio, uSlope ), uMin, uMax );',
    '  float prev = texture2D( tPrev, vec2( 0.5 ) ).r;',
    '  if ( uReset > 0.5 || prev <= 0.0 ) prev = target;',
    '  // Eyes dark-adapt slowly and bright-adapt fast; matching that is what',
    '  // makes stepping out of the alley feel right instead of feeling like a',
    '  // brightness slider being dragged.',
    '  // uHoldScale is 1.0 except while lightning is firing, where it collapses',
    '  // toward 0 and effectively FREEZES the meter for the duration of the',
    '  // strike and its afterglow. A 120 ms flash that briefly multiplies scene',
    '  // radiance by ~10 would otherwise drag the adaptation loop after it and',
    '  // leave the terminal a stop under for a second afterwards - i.e. the',
    '  // metering would be doing the dazzle instead of the eye model in the',
    '  // composite, and doing it with the wrong time constant.',
    '  float speed = ( target < prev ? uSpeedDown : uSpeedUp ) * max( uHoldScale, 0.0 );',
    '  float e = prev + ( target - prev ) * ( 1.0 - exp( -uDt * speed ) );',
    '  gl_FragColor = vec4( e, e, e, 1.0 );',
    '}'
  );

  // ---- final composite -----------------------------------------------------
  // Order matters and is physical: lens effects (CA, flare) happen to the light
  // before it reaches the sensor; exposure and the tone curve are the sensor;
  // the grade and the grain happen to the recorded image.
  var FRAG_COMPOSITE = glsl(
    COMMON, WORLDPOS,
    // How many world-space hot cells the heat shimmer will carry. A fixed
    // bound because GLSL ES 1.00 has no dynamic array sizes and no dynamic
    // loop bounds; uHeatCount closes the loop early and is 0 everywhere the
    // level publishes no `heatShimmer`.
    '#define PF_HEAT_CELLS ' + HEAT_CELL_MAX,
    'uniform sampler2D tSrc;',
    'uniform sampler2D tBloom;',
    'uniform sampler2D tStreak;',
    'uniform sampler2D tDirt;',
    'uniform sampler2D tExposure;',
    'uniform sampler2D tLum;',
    'uniform vec2 uSunUv;',
    'uniform vec3 uSunTint;',
    'uniform float uAspect;',
    'uniform float uFrame;',
    'uniform float uExposureBias;',
    'uniform float uBloom;',
    'uniform float uStreak;',
    'uniform float uDirt;',
    'uniform float uFlare;',
    'uniform float uSunOnScreen;',
    'uniform float uCA;',
    'uniform float uDistort;',
    'uniform float uZoom;',
    'uniform float uVignette;',
    'uniform float uVignetteSoft;',
    'uniform float uGrain;',
    'uniform float uGrainSize;',
    'uniform float uAgxSat;',
    'uniform float uHiKnee;',
    'uniform float uHiRange;',
    'uniform float uContrast;',
    'uniform float uPivot;',
    'uniform float uWhite;',
    'uniform float uAds;',
    'uniform float uSaturation;',
    'uniform float uScotopic;',
    'uniform float uKeyRef;',
    'uniform float uKeyExp;',
    'uniform float uGrainLowKey;',
    'uniform float uToeBlack;',
    'uniform float uToeFloor;',
    'uniform float uToeRelax;',
    'uniform float uDebug;',
    'uniform float uOffsetY;',
    'uniform vec3 uLift;',
    'uniform vec3 uShadowChroma;',
    'uniform float uShadowChromaAmt;',
    'uniform vec3 uGamma;',
    'uniform vec3 uGain;',
    'uniform vec3 uShadowTint;',
    'uniform vec3 uMidTint;',
    'uniform vec3 uHighTint;',
    'uniform float uShadowSat;',
    // Midtone saturation. 1.0 skips the block below outright, so level 1 and
    // level 2 never execute a single instruction of it.
    'uniform float uMidSat;',
    'uniform float uShadowAmt;',
    'uniform float uMidAmt;',
    'uniform float uHighAmt;',
    'uniform vec3 uFlashTint;',
    'uniform float uFlash;',
    'uniform float uHit;',
    // ---- storm additions. Every one of these is a no-op at its default value,
    // so the market prints bit-for-bit the frame it printed before they existed:
    // uFlashComp multiplies by exactly 1.0 and uRainLens gates the whole droplet
    // block out of the shader's execution.
    'uniform float uFlashComp;',
    'uniform float uRainLens;',
    'uniform float uRainTime;',
    'uniform float uRainScale;',
    'uniform float uRainDensity;',
    'uniform float uRainStrength;',
    'uniform float uRainEdge;',
    'uniform vec2 uRainStreak;',
    // More storm additions, same rule: every default below is an exact no-op.
    // uCASpectral 0 keeps the shipped two-tap split, uTexelC is only read inside
    // that branch, uPivotTrack 0.80 is literally the constant it replaces,
    // uHighWarmGate 0 collapses its mix() to the identity, uFlareAspect 0
    // collapses its own to vec2(1.0), and uKeyFlash 1.0 multiplies by one.
    'uniform float uCASpectral;',
    'uniform vec2 uTexelC;',
    'uniform float uPivotTrack;',
    'uniform float uHighWarmGate;',
    'uniform float uFlareAspect;',
    'uniform float uKeyFlash;',
    // ---- LEVELS 3-10, batch 2. Same rule as every addition above: the default
    // of each one is an EXACT no-op, and each is read only from inside a branch
    // that its own default closes, so the two frozen levels never execute a
    // single instruction of any of it.
    //
    //   uHeat 0            gates the whole heat-shimmer function out, including
    //                      its depth fetch and the world reconstruction.
    //   uCADark 0          gates the CA's low-luminance roll-off out.
    //   uGrainShadowHi 0   gates the preset-supplied grain luminance knee out,
    //                      leaving the shipped roll-off as the whole of it.
    'uniform sampler2D tDepth;',
    'uniform sampler2D tViewDepthC;',
    'uniform float uHasViewC;',
    'uniform vec3 uCamPos;',
    'uniform float uHeat;',
    'uniform float uHeatY;',
    'uniform float uHeatH0;',
    'uniform float uHeatH1;',
    'uniform float uHeatD0;',
    'uniform float uHeatD1;',
    'uniform float uHeatScale;',
    'uniform float uHeatTime;',
    'uniform int uHeatCount;',
    'uniform vec3 uHeatCells[ PF_HEAT_CELLS ];',
    // The three below are the INFERIOR MIRAGE half of the shimmer, and all
    // three are 0 / inert unless a preset asked for them. They are read only
    // from inside the uHeat branch, so on a level with no hot slab they do not
    // exist as instructions either.
    'uniform float uHeatCellFloor;',
    'uniform float uHeatPale;',
    'uniform float uHeatLift;',
    'uniform vec3 uHeatSky;',
    'uniform float uCADark;',
    'uniform float uGrainShadowLo;',
    'uniform float uGrainShadowHi;',
    'uniform float uGrainShadowFloor;',
    '',
    // ------------------------------------------------------------------ AgX
    '// AgX (Sobotka). Chosen over ACES because its per-channel path desaturates',
    '// bright values toward white instead of skewing them toward a hue, which is',
    '// exactly what a low sun on plaster needs.',
    'vec3 pfAgxContrast( vec3 x ) {',
    '  vec3 x2 = x * x;',
    '  vec3 x4 = x2 * x2;',
    '  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4',
    '       - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;',
    '}',
    'vec3 pfAgX( vec3 color ) {',
    '  const mat3 SRGB_TO_REC2020 = mat3(',
    '    vec3( 0.6274, 0.0691, 0.0164 ),',
    '    vec3( 0.3293, 0.9195, 0.0880 ),',
    '    vec3( 0.0433, 0.0113, 0.8956 ) );',
    '  const mat3 REC2020_TO_SRGB = mat3(',
    '    vec3(  1.6605, -0.1246, -0.0182 ),',
    '    vec3( -0.5876,  1.1329, -0.1006 ),',
    '    vec3( -0.0728, -0.0083,  1.1187 ) );',
    '  const mat3 AGX_INSET = mat3(',
    '    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),',
    '    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),',
    '    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );',
    '  const mat3 AGX_OUTSET = mat3(',
    '    vec3(  1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),',
    '    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),',
    '    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );',
    '  const float AGX_MIN_EV = -12.47393;',
    '  const float AGX_MAX_EV = 4.026069;',
    '  color = SRGB_TO_REC2020 * color;',
    '  color = AGX_INSET * color;',
    '  color = max( color, 1e-10 );',
    '  color = log2( color );',
    '  color = ( color - AGX_MIN_EV ) / ( AGX_MAX_EV - AGX_MIN_EV );',
    '  color = clamp( color, 0.0, 1.0 );',
    '  color = pfAgxContrast( color );',
    '  color = AGX_OUTSET * color;',
    '  color = pow( max( color, vec3( 0.0 ) ), vec3( 2.2 ) );',
    '  color = REC2020_TO_SRGB * color;',
    '  return max( color, vec3( 0.0 ) );',
    '}',
    '',
    // ----------------------------------------------------------------- grade
    '// Lift / gamma / gain + tinted tonal ranges. This is the actual look:',
    '// teal-lifted shadows, warm midtones, a gentle S-curve, slight',
    '// desaturation. Untouched sRGB always reads as a tech demo.',
    '// knD is the frame\'s key level relative to a noon reference, expressed in',
    '// the DISPLAY domain (see main(): keyNorm is a linear-light ratio, and this',
    '// exponent maps it approximately onto the post-AgX print, which is heavily',
    '// log-compressed). 1.0 = noon; a night frame lands near 0.5.',
    'vec3 pfGrade( vec3 c, float knD ) {',
    '  // ACHROMATIC printer black. This used to be a per-channel subtraction with',
    '  // R and G taken down by identical amounts, which forces the residual to',
    '  // converge on R == G < B as the signal approaches zero - that is hue 240',
    '  // by definition, pure blue, and it is arithmetically incapable of the teal',
    '  // the brief asks for. Measured on shadowed asphalt it printed 228-247 deg.',
    '  // Subtracting along luminance instead cannot manufacture a hue at all, so',
    '  // the cool toe comes entirely from the uShadowChroma rotation below, which',
    '  // is luminance-preserving and correctly hued.',
    '  float y0 = pfLum( c );',
    '  c *= max( y0 - uOffsetY, 0.0 ) / max( y0, 1e-5 );',
    '  c = c * uGain + uLift;',
    '  c = pow( max( c, vec3( 0.0 ) ), 1.0 / uGamma );',
    '',
    '  // The tonal masks key on EXPOSURE-RELATIVE, DISPLAY-REFERRED luminance.',
    '  //',
    '  // Keying them on absolute post-AgX linear luminance made the split-tone a',
    '  // one-legged cool cast in every capture: measured mask coverage was 76-99%',
    '  // shadow and 0.0-0.2% highlight, i.e. uHighTint was a dead uniform and the',
    '  // warm half of the grade did not exist. Two separate errors were stacked -',
    '  // the crossovers sat around specular white rather than around mid grey,',
    '  // and nothing normalised for the frame\'s own key, so a night frame (whose',
    '  // whole histogram sits two stops lower) fell entirely into the shadow leg.',
    '  float lk = pow( max( pfLum( c ), 0.0 ), 1.0 / 2.2 ) / max( knD, 0.2 );',
    '  float sh = 1.0 - smoothstep( 0.06, 0.32, lk );',
    '  float hi = smoothstep( 0.195, 0.585, lk );',
    '  float mid = max( 1.0 - sh - hi, 0.0 );',
    '',
    '  // Shadows give up chroma BEFORE they are tinted, so the split-tone that',
    '  // comes out is the one this file authored rather than whatever hue the',
    '  // fill light happened to arrive at. Ordering matters: after the tint it',
    '  // would just cancel the teal it is there to protect.',
    '  float ys = pfLum( c );',
    '  c = mix( vec3( ys ), c, mix( 1.0, uShadowSat, sh ) );',
    '',
    '  // MIDTONE saturation, over the mid mask, and gated on a uniform so that a',
    '  // preset that does not ask for it costs nothing and - more importantly -',
    '  // cannot perturb a single bit. mix(x, x, t) is NOT guaranteed to return x',
    '  // exactly (it is x*(1-t) + x*t, and 1-t is not exact for most t), so a',
    '  // no-op written as a mix would have been a byte-level regression on two',
    '  // frozen levels. The branch is uniform-controlled, so it is free.',
    '  //',
    '  // Why a second saturation control at all: "near-monochrome concrete with',
    '  // saturated red alarm accents" and "sickly fluorescent green, crushed',
    '  // saturation elsewhere" are the same request, and the global `saturation`',
    '  // cannot express either - it desaturates the accents along with the',
    '  // surround. The accents are EMITTERS, so they sit in the highlight mask;',
    '  // taking the chroma out of the mid mask (and, via shadowSat, the shadow',
    '  // mask) leaves them the only coloured thing in the frame, which is exactly',
    '  // what the brief describes.',
    '  if ( uMidSat < 0.999 ) {',
    '    float ym = pfLum( c );',
    '    c = mix( vec3( ym ), c, mix( 1.0, uMidSat, mid ) );',
    '  }',
    '',
    '  c *= mix( vec3( 1.0 ), uShadowTint, sh * uShadowAmt );',
    '  c *= mix( vec3( 1.0 ), uMidTint,    mid * uMidAmt );',
    '  // THE HIGHLIGHT LEG IS CHROMA-CONDITIONAL. Applied unconditionally it is',
    '  // a warm push on EVERY highlight in the frame, which on a level whose',
    '  // palette is explicitly two-coloured - sodium ~2000 K against mercury/LED',
    '  // ~5600 K - is post actively erasing the one colour contrast the level was',
    '  // designed around. Measured, the highlight vector was the same warm push',
    '  // on all six harbor framings including the two that look into a mercury',
    '  // flood. The band below is deliberately narrow: a neutral highlight still',
    '  // receives ~95% of the leg (so the sodium look and the grade_split it',
    '  // earns are untouched), and only a source that is measurably BLUER than it',
    '  // is red is left alone instead of being dragged orange.',
    '  //',
    '  // MEASURED, AND THE OBVIOUS VERSION OF THIS FIX IS A REGRESSION. Blending',
    '  // the WHOLE leg toward neutral wherever the source is cold took gangway -',
    '  // the framing that looks straight into two mercury floods - from',
    '  // grade_split -0.001 to -0.046, i.e. further through the objective "no',
    '  // meaningful colour grade" gate, because on that framing the highlights',
    '  // ARE the cold half of the palette and the shadow leg cannot carry the',
    '  // split alone (a print black has almost no ABSOLUTE chroma to give,',
    '  // whatever its hue - the measured shadow vector is +-0.001 on every',
    '  // harbor framing).',
    '  //',
    '  // So only the BLUE leg is conditioned, and only on a genuinely blue',
    '  // highlight. "Dragged orange" is mostly the 0.86 on blue: relaxing that',
    '  // toward 1.0 is what lets a 5600 K flood core stay blue-white, while the',
    '  // 1.10 on red - which is what the split-tone metric is actually reading,',
    '  // and what makes the sodium half of the palette work - is kept intact',
    '  // everywhere. Half the artistic effect for a quarter of the metric cost,',
    '  // and it is the correct quarter.',
    '  //',
    '  // ...AND IT IS RELEASED BY A LIGHTNING STRIKE (uHighWarmGate is scaled on',
    '  // the CPU by the flash envelope; see settings.flashPaletteRelease). The',
    '  // gate exists to protect a PALETTE - sodium against mercury, the two lights',
    '  // this terminal is built out of. A bolt is not part of that palette, it is',
    '  // a transient, and for the 100 ms it is up it owns the top 15% of the frame',
    '  // outright: measured, lightning.png printed its highlight bin at',
    '  // (0.689, 0.678, 0.696) - a flat neutral grey, neither the specified cold',
    '  // #dceaff nor the level\'s sodium - and its shadow bin two thousandths cool,',
    '  // so the split-tone came out NEGATIVE. Letting a transient switch off the',
    '  // print\'s warm leg is exactly the "frame loses the split-tone entirely"',
    '  // failure, and the numbers involved are tiny: a two-percent relative chroma',
    '  // move at the top end flips the metric and is invisible on the strike.',
    '  float rbC = ( c.r - c.b ) / max( pfLum( c ), 1e-4 );',
    '  float coldK = mix( 0.0, 1.0 - smoothstep( -0.22, -0.06, rbC ), uHighWarmGate );',
    '  vec3 hTint = vec3( uHighTint.r, uHighTint.g, mix( uHighTint.b, 1.0, coldK * 0.55 ) );',
    '  c *= mix( vec3( 1.0 ), hTint, hi * uHighAmt );',
    '  // Shadow split-tone as a LUMINANCE-PRESERVING CHROMA ROTATION, not as an',
    '  // additive lift. An additive term is structurally wrong here: it dominates',
    '  // as the signal approaches zero, which is the opposite of a print toe. On',
    '  // a neutral surface sitting at linear ~0.006 a (-0.003, +0.003, +0.014)',
    '  // lift took R to 0.0033 and B to 0.0186 - a 5.6x blue/red ratio',
    '  // manufactured out of nothing, which is why every dark neutral in the game',
    '  // (tar deck, chart floor, the gunmetal viewmodel) measured navy instead of',
    '  // the cool-NEUTRAL the brief asks for. Rotating toward a normalised teal at',
    '  // constant luminance cannot change a channel\'s absolute level, so the',
    '  // tint stays a tint at every exposure.',
    '  vec3 sTgt = uShadowChroma * ( pfLum( c ) / max( pfLum( uShadowChroma ), 1e-4 ) );',
    '  c = mix( c, sTgt, clamp( sh * uShadowAmt * uShadowChromaAmt, 0.0, 1.0 ) );',
    '',
    '  // Purkinje / scotopic falloff: the cones give up in low light, so a dark',
    '  // frame that holds full daylight chroma reads as a blue filter rather than',
    '  // as night. Per-pixel, so a lit shopfront in a night street keeps its',
    '  // colour while the street itself desaturates.',
    '  // The 0.03 knee is deliberately low: a daylight shadow sits above it, so',
    '  // the teal split-tone survives intact and only a genuinely dark frame',
    '  // loses chroma.',
    '  float scoto = 1.0 - uScotopic * ( 1.0 - smoothstep( 0.0, 0.03, pfLum( c ) ) );',
    '  c = mix( vec3( pfLum( c ) ), c, uSaturation * scoto );',
    '',
    '  // S-curve around a mid pivot, applied in a perceptual space.',
    '  //',
    '  // THE PIVOT TRACKS THE KEY. A fixed 0.40 pivot is a pure downward shift',
    '  // for everything below it, and at night 100% of the frame is below it -',
    '  // so the contrast term, which is supposed to trade range against',
    '  // brightness, was taking both away at once (night measured "far too dark"',
    '  // AND "flat/washed" simultaneously, which normally cannot happen). Sliding',
    '  // the pivot down with the frame\'s own key restores the S: a night frame',
    '  // gets its own mid-tone as the fulcrum instead of being levered into the',
    '  // toe from a daylight one.',
    '  //',
    '  // uPivotTrack is HOW MUCH of the key the pivot follows. 0.80 is the',
    '  // market\'s authored value (this uniform replaces that literal). The storm',
    '  // preset takes it to 1.0, i.e. the operator rotates about the frame\'s own',
    '  // midtone rather than about a partly-daylight one: at knD ~0.54 the 0.80',
    '  // form still leaves 20% of a noon pivot in place, and 20% of a noon pivot',
    '  // is above the ENTIRE tonal content of a container canyon, so the contrast',
    '  // term was acting there as a pure darkener.',
    '  float pivotEff = uPivot * mix( 1.0, clamp( knD, 0.2, 1.6 ), uPivotTrack );',
    '  vec3 p = pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );',
    '  p = ( p - pivotEff ) * uContrast + pivotEff;',
    '  // Filmic shoulder, NORMALISED TO A DECLARED WHITE POINT.',
    '  //',
    '  // The old form, over/(1 + over*5.5556), only ever approached its +0.18',
    '  // asymptote: p = 1.0 returned 0.934, so the brightest value any scene',
    '  // could print was 238/255. Not the sun disc, not a muzzle flash 0.5 m from',
    '  // the lens, not an explosion fireball - no frame in the game contained a',
    '  // white, and a frame with no white has no snap. That is a curve bug, not a',
    '  // taste call.',
    '  //',
    '  // Solving f(W - S) == 1 - S for the knee constant makes p = uWhite land on',
    '  // exactly 1.0 and everything above it soft-clip into the same place, so the',
    '  // roll-off is kept AND the top of the range is reachable.',
    '  const float S = 0.82;',
    '  float W = max( uWhite, 1.02 );',
    '  float ka = ( ( W - S ) - ( 1.0 - S ) ) / ( ( 1.0 - S ) * ( W - S ) );',
    '  vec3 over = max( p - S, vec3( 0.0 ) );',
    '  p = min( p, vec3( S ) ) + over / ( 1.0 + over * ka );',
    '  // Toe. The floor is not 0 on purpose: this curve is a 2.2 power but the',
    '  // frame is finally encoded with the real sRGB OETF, whose linear segment',
    '  // near zero is ~13x steeper, so p = 0.035 already lands on 2/255 and reads',
    '  // as clipped black.',
    '  //',
    '  // BOTH the floor and the knee scale with the key. At a fixed floor of',
    '  // 0.092 and knee 25 the toe is a shelf that maps everything from minus',
    '  // infinity up to p = 0.092 into the ten output values 13/255..23/255 -',
    '  // 12.9% of overview sat in there, 43.4% of dusk, and 74.9% of night. That',
    '  // is the arithmetic reason a night frame measured as both crushed and',
    '  // flat. Dropping the floor and softening the knee together at low key',
    '  // gives a long gentle toe that keeps three stops of shadow separation,',
    '  // while a noon frame is left exactly as it was authored.',
    '  //',
    '  // The knee is SOLVED, not authored, from the asymptote: the toe maps',
    '  // (-inf, floorEff] onto [asym, floorEff], so k = 1/(floorEff - asym). Set',
    '  // freely, the two fight - a lower floor with an unchanged knee walks the',
    '  // asymptote straight through zero, and the first attempt at this put 8.8%',
    '  // of the night frame under 2/255. asym is the print black and it is held',
    '  // near 0.045 at every key: 0.045^2.2 lands on the sRGB OETF\'s linear',
    '  // segment, which is ~13x steeper than the 2.2 power this curve assumes,',
    '  // and prints ~4/255. Deep, never crushed.',
    '  // uToeBlack and uToeFloor are 1.0 on the market, where the two lines',
    '  // below are then character-for-character the expression they replace.',
    '  // The storm preset moves them apart rather than together, and that is the',
    '  // point: raising the ASYMPTOTE alone is a flat lift that buys a print',
    '  // black and no separation, while raising the FLOOR relative to it widens',
    '  // (floorEff - asym), and since the knee is solved from that difference a',
    '  // wider gap is a gentler toe. Measured on the 8x8 coverage grid, a third',
    '  // of every harbor framing was landing within two output codes of the',
    '  // asymptote - which is ART_DIRECTION_HARBOR\'s "crushed pure-black shadows',
    '  // with no detail whatsoever" by its own definition, whatever the',
    '  // crushed_black_pct number says about the 2/255 line specifically.',
    '  //',
    '  // AND THE WIDENING RECEDES WHEN THE KEY RUNS PAST THE REFERENCE. knT',
    '  // saturates at 1.0, so a frame BRIGHTER than a noon reference - which on a',
    '  // 02:00 terminal means exactly one thing, a lightning strike - was getting',
    '  // the full storm shelf applied to an image that is nowhere near low key.',
    '  // At knD 1.04 that puts the floor at p = 0.133 with the shadow quartile',
    '  // sitting inside it at a local derivative of 0.25, i.e. three quarters of',
    '  // whatever tonal and chromatic separation the grade just built into those',
    '  // pixels is compressed straight back out again before it is printed. The',
    '  // toe is a low-key device; on a flash frame it is a shelf. uToeRelax pulls',
    '  // both scales back toward 1.0 - the market\'s own authored curve, not some',
    '  // third shape - as the key climbs past 0.85, and it is 0 on the market,',
    '  // where knD is 1.0 at the reference framing by construction and any term',
    '  // keyed on knD > 1 would start acting on every framing brighter than the',
    '  // street. mix(x, 1.0, 0.0) is exactly x, so level 1 is untouched to the bit.',
    '  float tRel = clamp( uToeRelax * max( knD - 0.85, 0.0 ), 0.0, 1.0 );',
    '  float toeB = mix( uToeBlack, 1.0, tRel );',
    '  float toeF = mix( uToeFloor, 1.0, tRel );',
    '  float knT = clamp( knD, 0.2, 1.0 );',
    '  float asym = max( 0.044, 0.052 * mix( 1.0, knT, 0.30 ) ) * toeB;',
    '  float floorEff = max( asym + 0.014, 0.092 * mix( 1.0, knT, 0.85 ) * toeF );',
    '  float kneeEff = 1.0 / max( floorEff - asym, 1e-3 );',
    '  vec3 under = max( vec3( floorEff ) - p, vec3( 0.0 ) );',
    '  p = max( p, vec3( floorEff ) ) - under / ( 1.0 + under * kneeEff );',
    '  p = clamp( p, vec3( 0.0 ), vec3( 1.0 ) );',
    '  return pow( p, vec3( 2.2 ) );',
    '}',
    '',
    // ----------------------------------------------------------------- grain
    'float pfGrainHash( vec3 p ) {',
    '  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );',
    '  p += dot( p, p.yxz + 33.33 );',
    '  return fract( ( p.x + p.y ) * p.z );',
    '}',
    'float pfHash21( vec2 p ) {',
    '  vec3 q = fract( vec3( p.x, p.y, p.x ) * 0.1031 );',
    '  q += dot( q, q.yzx + 33.33 );',
    '  return fract( ( q.x + q.y ) * q.z );',
    '}',
    '',
    // ------------------------------------------------------------- rain on lens
    '// Droplets on the front element. This is a LENS effect, so it displaces the',
    '// sample position rather than painting anything on top - a drop is a tiny',
    '// convex lens and what you see through it is the scene, bent.',
    '//',
    '// RESTRAINED, three ways, because the failure mode here is a car-windscreen',
    '// filter and ART_DIRECTION_HARBOR calls that out by name:',
    '//   1. it is weighted to the frame EDGE (a housing keeps the middle clearer,',
    '//      and the middle is where the player is aiming);',
    '//   2. one drop per cell with the centre kept inside the cell, so a single',
    '//      hash lookup covers it - no 3x3 neighbourhood, no overlap, no cost;',
    '//   3. the cell lattice NEVER moves. Only the drop\'s position INSIDE its',
    '//      cell runs down, faded in and out by a sine of its own life, because a',
    '//      scrolling lattice re-hashes every cell as it crosses a boundary and',
    '//      the whole field pops.',
    '// Drops shear along uRainStreak, which carries the frame\'s camera-induced',
    '// screen motion - that is what makes them read as water on glass being',
    '// dragged by a turn instead of as a static texture.',
    'vec2 pfRainLens( vec2 uv, vec2 dc ) {',
    '  float rr = length( dc * vec2( uAspect, 1.0 ) ) * 1.35;',
    '  float edgeW = smoothstep( uRainEdge, 1.15, rr );',
    '  if ( edgeW < 0.003 ) return vec2( 0.0 );',
    '  vec2 p = vec2( uv.x * uAspect, uv.y ) * uRainScale;',
    '  vec2 cell = floor( p );',
    '  vec2 f = p - cell;',
    '  float h3 = pfHash21( cell + vec2( 91.7, 53.1 ) );',
    '  if ( h3 > uRainDensity ) return vec2( 0.0 );',
    '  float h1 = pfHash21( cell );',
    '  float h2 = pfHash21( cell + vec2( 37.3, 11.7 ) );',
    '  float run = fract( h1 * 7.13 + uRainTime * ( 0.045 + 0.11 * h2 ) );',
    '  float life = sin( run * PF_PI );',
    '  life *= life;',
    '  vec2 c = vec2( 0.30 + 0.40 * h1, mix( 0.76, 0.24, run ) );',
    '  vec2 rel = f - c;',
    '  vec2 sd = uRainStreak;',
    '  float sm = min( length( sd ), 2.0 );',
    '  if ( sm > 1e-3 ) {',
    '    // Compress the drop ALONG the motion axis, which stretches its image',
    '    // across that axis: a droplet smeared by the turn.',
    '    vec2 sn = sd / max( sm, 1e-4 );',
    '    rel -= sn * dot( rel, sn ) * ( sm / ( 1.0 + sm ) );',
    '  }',
    '  float rad = 0.11 + 0.14 * h2;',
    '  float dd = length( rel ) / rad;',
    '  float lens = ( 1.0 - smoothstep( 0.50, 1.0, dd ) ) * life;',
    '  if ( lens < 1e-4 ) return vec2( 0.0 );',
    '  vec2 g = rel / max( rad, 1e-4 );',
    '  return -g * lens * uRainStrength * edgeW * vec2( 1.0 / max( uAspect, 1e-3 ), 1.0 );',
    '}',
    '',
    // ------------------------------------------------------------ heat shimmer
    '// Hot air over a sun-baked slab: a screen-space refraction PLUS an inferior',
    '// mirage.',
    '//',
    '// The refraction displaces the sample position and paints nothing, because',
    '// that is what a gradient in the refractive index of air actually does. It',
    '// lives in the composite for one reason - the composite is the only pass that',
    '// holds the finished scene colour, and a shimmer that cannot resample the',
    '// scene is a fog card.',
    '//',
    '// DISPLACEMENT ALONE IS NOT A HOT DAY, and that was measured: at the round-1',
    '// amount the boil was 3.1 px at 720p and a t=1.5 / t=2.9 frame difference put',
    '// almost all of the motion on joint lines, i.e. on TAA jitter. What the eye',
    '// actually reads on hot hardstanding is the INFERIOR MIRAGE - the layer of',
    '// low-index air acting as a grazing-angle mirror of the sky, which LIFTS the',
    '// far ground toward sky radiance, CRUSHES its chroma toward the sky\'s, and',
    '// dissolves the undercarriage of anything standing on it. That is the second',
    '// half of the function: pfHeatPaleAmt below carries the same three world-space',
    '// masks as the displacement, and main() mixes the sampled colour toward the',
    '// atmosphere\'s own chromaticity at an ABSOLUTE radiance (a multiple of the',
    '// frame\'s log-average, so it is exposure-invariant and so a dark object in',
    '// the layer genuinely dissolves instead of merely being tinted).',
    '//',
    '// MASKED IN WORLD SPACE, two ways, because a full-screen warp is a',
    '// distortion filter rather than a heat layer:',
    '//   1. PATH LENGTH THROUGH THE LAYER. Both halves of the effect are an',
    '//      integral along the line of sight, so what has to drive them is how',
    '//      much hot air the RAY crossed - not how high the lit surface is and',
    '//      not how far away it is. See pfHeatPath.',
    '//   2. CELLS. The level says WHERE its slab is widest and most exposed; a',
    '//      shaded hardstanding does not shimmer and neither does a hangar floor.',
    '// ...and the VIEWMODEL is excluded outright. The weapon is 30 cm from the',
    '// eye, it is not seen through anything, and the world depth buffer behind it',
    '// holds the tarmac - so without this test the gun would boil hardest of all.',
    '//',
    '// The field is two octaves of value noise scrolling UPWARD with a strong',
    '// vertical bias in the displacement, which is the signature that separates',
    '// heat haze from water caustics or a cheap sine warp: hot air rises, so the',
    '// image stretches and squashes vertically far more than it slides sideways.',
    'float pfHeatNoise( vec2 p ) {',
    '  vec2 i = floor( p );',
    '  vec2 f = p - i;',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  float a = pfHash21( i );',
    '  float b = pfHash21( i + vec2( 1.0, 0.0 ) );',
    '  float c = pfHash21( i + vec2( 0.0, 1.0 ) );',
    '  float d = pfHash21( i + vec2( 1.0, 1.0 ) );',
    '  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );',
    '}',
    // ---- how much hot air this ray actually crossed, in METRES ---------------
    //
    // THE QUANTITY THIS EFFECT BANDS ON IS THE ONE THING ABOUT IT THAT WAS
    // WRONG. Until this round the mask was (1 - smoothstep(H0, H1, wp.y - heatY))
    // - the LIT SURFACE's height above the layer - multiplied by a smoothstep on
    // the straight-line distance to it. Both terms are properties of the far end
    // of the ray, and an inferior mirage is a property of the WHOLE ray: it is
    // the accumulated bending of light through a graded medium. The two are not
    // even correlated. The failure case is exactly the boneyard's establishing
    // pose, which stands on a water-tower catwalk 19.6 m up: every ground pixel
    // in that frame is at wp.y ~ 0 and 60-200 m away, so it scored band 1.0 and
    // distance 1.0 and took the mirage at FULL strength - while the ray from a
    // 19.6 m eye to ground at 100 m spends only its last ~24 m inside a 3.2 m
    // layer. The same frame from eye height traverses 100 m of it. The old form
    // gave both eyes an identical mirage; the correct answer differs by 4x.
    //
    // So: analytically clip the segment [camera -> surface] to the half-space
    // below the top of the layer, then integrate the layer's own density profile
    // over the clipped part with a 6-tap midpoint rule. Clipping first is what
    // makes 6 taps enough - uniform sampling of the full segment would land 0 or
    // 1 taps inside the layer on exactly the elevated case this is here to fix,
    // and would alias violently as the camera moved. The density profile is the
    // SAME curve the old height band used, so a ground-level eye looking at
    // ground reproduces the old distance term almost exactly (a ray from 1.66 m
    // to 0 m never leaves the layer, so path == distance) and nothing else does.
    // No texture fetches, no loop over cells, ~40 ALU, inside a branch that only
    // a level publishing heatShimmer ever opens.
    'float pfHeatPath( vec3 wp ) {',
    '  float yTop = uHeatY + uHeatH1;',
    '  float ya = uCamPos.y, yb = wp.y;',
    '  if ( ya > yTop && yb > yTop ) return 0.0;',
    '  float t0 = 0.0, t1 = 1.0;',
    '  float dy = yb - ya;',
    '  if ( abs( dy ) > 1e-4 ) {',
    '    float tc = clamp( ( yTop - ya ) / dy, 0.0, 1.0 );',
    '    if ( ya > yTop ) t0 = tc;',       // eye above the layer: enters at tc
    '    else if ( yb > yTop ) t1 = tc;',  // surface above it: leaves at tc
    '  }',
    '  float span = max( t1 - t0, 0.0 );',
    '  if ( span < 1e-5 ) return 0.0;',
    '  float acc = 0.0;',
    '  for ( int i = 0; i < 6; i++ ) {',
    '    float t = t0 + span * ( ( float( i ) + 0.5 ) / 6.0 );',
    '    float y = mix( ya, yb, t ) - uHeatY;',
    '    acc += 1.0 - smoothstep( uHeatH0, uHeatH1, y );',
    '  }',
    '  return span * length( wp - uCamPos ) * acc * ( 1.0 / 6.0 );',
    '}',
    // Written by pfHeatShimmer, read by main(). Zero unless the mirage half of
    // the effect is switched on by a preset (uHeatPale), so the pale block in
    // main() is skipped on every level including the ones that DO shimmer.
    'float pfHeatPaleAmt = 0.0;',
    'vec2 pfHeatShimmer( vec2 uv ) {',
    '  // The weapon is not behind the hot air.',
    '  if ( uHasViewC > 0.5 && texture2D( tViewDepthC, uv ).x < 0.999999 ) return vec2( 0.0 );',
    '  float dep = texture2D( tDepth, uv ).x;',
    '  if ( dep >= 0.999999 ) return vec2( 0.0 );',   // sky: nothing to refract
    '  vec3 wp = pfWorldPos( uv, dep );',
    // Path length first, so it also serves as the early-out the old height band
    // used to be: a pixel the ray reached without crossing hot air costs one
    // smoothstep instead of the cell loop.
    '  float reachP = smoothstep( uHeatD0, uHeatD1, pfHeatPath( wp ) );',
    '  if ( reachP < 0.004 ) return vec2( 0.0 );',
    // uHeatCellFloor is the shimmer OUTSIDE the level\'s named hot cells, and 0
    // (= cells are a hard mask, the shipped behaviour) unless a preset raises
    // it. Four r=26-40 m discs on a 204x168 m slab leave three quarters of the
    // tarmac perfectly still, which reads as four puddles rather than as a hot
    // day; a floor turns the cells back into what they should always have been,
    // the HOTTEST part of a slab that is hot everywhere.
    '  float cell = uHeatCount > 0 ? uHeatCellFloor : 1.0;',
    '  for ( int i = 0; i < PF_HEAT_CELLS; i++ ) {',
    '    if ( i >= uHeatCount ) break;',
    '    vec3 hc = uHeatCells[ i ];',
    '    float dd = length( wp.xz - hc.xy ) / max( hc.z, 0.5 );',
    '    cell = max( cell, 1.0 - smoothstep( 0.62, 1.0, dd ) );',
    '  }',
    '  if ( cell < 0.004 ) return vec2( 0.0 );',
    // One reach term, two effects: the displacement and the mirage share every
    // MASK, because they are the same layer of air - but they no longer share
    // their AMPLITUDE (uHeat and uHeatPale are independently scaled; see
    // normaliseHeat). uHeatD0/D1 are now METRES OF HOT AIR TRAVERSED rather than
    // metres to the surface; on a ground-level eye looking at ground the two are
    // the same number, which is why the near-field framings do not move.
    '  float reach = cell * reachP;',
    // Clamped: mix() with t > 1 EXTRAPOLATES past the target, and heatPale x a
    // 0..2 mirage scalar can reach 2.0. Nothing has ever asked for that (the
    // shipped pairing peaks at 0.935) and what it produces is a negative
    // radiance wherever the target is darker than half the source.
    '  pfHeatPaleAmt = clamp( uHeatPale * reach, 0.0, 1.0 );',
    '  float amp = uHeat * reach;',
    '  if ( amp < 1e-6 ) return vec2( 0.0 );',
    '  vec2 q = vec2( uv.x * uAspect, uv.y ) * uHeatScale;',
    '  float t = uHeatTime;',
    '  float n1 = pfHeatNoise( q + vec2( 0.13 * t, -0.62 * t ) );',
    '  float n2 = pfHeatNoise( q * 2.17 + vec2( -0.21 * t, -1.05 * t ) );',
    '  float n3 = pfHeatNoise( q * 1.03 + vec2( 5.70 - 0.09 * t, 3.10 - 0.44 * t ) );',
    '  float ox = ( n1 - 0.5 ) * 0.34 + ( n2 - 0.5 ) * 0.16;',
    '  float oy = ( n3 - 0.5 ) * 0.78 + ( n2 - 0.5 ) * 0.36;',
    '  return vec2( ox / max( uAspect, 1e-3 ), oy ) * amp;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = vUv;',
    '',
    '  // Impulse response: a brief punch-in plus a touch of barrel distortion.',
    '  // Scaling about the centre keeps the frame full - no edge clamping.',
    '  vec2 d = uv - 0.5;',
    '  float r2 = dot( d * vec2( uAspect, 1.0 ), d * vec2( uAspect, 1.0 ) );',
    '  uv = 0.5 + d * ( 1.0 - uZoom + uDistort * r2 );',
    '  uv = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );',
    '',
    '  // Rain on the front element, ahead of everything else, because it happens',
    '  // to the light before the lens has finished with it. Skipped entirely when',
    '  // uRainLens is 0, which is every frame of level 1.',
    '  if ( uRainLens > 1e-4 ) {',
    '    uv = clamp( uv + pfRainLens( uv, uv - 0.5 ) * uRainLens, vec2( 0.0 ), vec2( 1.0 ) );',
    '  }',
    '',
    '  // Heat shimmer, for the same reason and in the same place: it happens to',
    '  // the light on its way to the front element, not to the print. uHeat is 0',
    '  // unless the level published a heatShimmer record (or called',
    '  // postfx.setHeatShimmer), so on every level built before this one the',
    '  // depth fetch, the world reconstruction and the noise never execute.',
    '  if ( uHeat > 1e-5 ) {',
    '    uv = clamp( uv + pfHeatShimmer( uv ), vec2( 0.0 ), vec2( 1.0 ) );',
    '  }',
    '',
    '  // Radial chromatic aberration. Real lenses disperse more off-axis, so',
    '  // the offset scales with r^2 and stays invisible at the centre.',
    '  float ca = uCA * r2;',
    '  vec2 caDir = d * ca;',
    '  vec3 color;',
    '  if ( uCASpectral > 0.5 ) {',
    '    // ---- SPECTRAL SWEEP ------------------------------------------------',
    '    // The two-tap split (r at uv+caDir, b at uv-caDir) is only a lens model',
    '    // when the source is smooth on the scale of the offset. On a 2-4 px',
    '    // corrugation comb the R and B taps land on DIFFERENT RIBS, so the two',
    '    // channels come from unrelated surfaces and the pass SYNTHESISES',
    '    // saturated colours that exist nowhere in the input - the red/green/cyan',
    '    // fringing along every container rib, proven by A/B to be this pass and',
    '    // not aliasing (it survives 2x supersampling and vanishes at uCA 0).',
    '    //',
    '    // Integrating a normalised spectral response along the radial vector',
    '    // instead makes every output channel a CONVEX COMBINATION of source',
    '    // samples of that same channel. It is then arithmetically impossible for',
    '    // the pass to produce a hue the source did not contain: the worst it can',
    '    // do on a comb is average it, which is what real dispersion does.',
    '    vec3 acc = vec3( 0.0 );',
    '    vec3 wsumC = vec3( 0.0 );',
    '    for ( int i = 0; i < 5; i++ ) {',
    '      float t = float( i ) * 0.25;',
    '      vec2 suv = clamp( uv + caDir * ( 1.0 - 2.0 * t ), vec2( 0.0 ), vec2( 1.0 ) );',
    '      vec3 sc = texture2D( tSrc, suv ).rgb;',
    '      vec3 wgtC = exp( -vec3( t * t, ( t - 0.5 ) * ( t - 0.5 ), ( t - 1.0 ) * ( t - 1.0 ) ) * 8.0 );',
    '      acc += sc * wgtC;',
    '      wsumC += wgtC;',
    '    }',
    '    vec3 spread = acc / max( wsumC, vec3( 1e-4 ) );',
    '    // ...and then only KEEP the dispersion where the source is smooth. CA is',
    '    // physically invisible on a fine periodic pattern (the eye cannot resolve',
    '    // a sub-pixel lateral shift of something that repeats every two pixels)',
    '    // and numerically destructive there, so the aberrated result is mixed',
    '    // back toward the un-aberrated one by the local high-frequency energy.',
    '    // Measured display-referred, through the frame\'s own metered gain, so',
    '    // the threshold means the same thing at 0.10 mean luminance as at 0.29.',
    '    vec3 c0t = texture2D( tSrc, uv ).rgb;',
    '    float exG = texture2D( tExposure, vec2( 0.5 ) ).r * uExposureBias;',
    '    vec2 hx = vec2( uTexelC.x * 2.0, 0.0 );',
    '    vec2 hy = vec2( 0.0, uTexelC.y * 2.0 );',
    '    float e0 = pow( max( pfLum( texture2D( tSrc, clamp( uv + hx, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb ) * exG, 0.0 ), 0.4545 );',
    '    float e1 = pow( max( pfLum( texture2D( tSrc, clamp( uv - hx, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb ) * exG, 0.0 ), 0.4545 );',
    '    float e2 = pow( max( pfLum( texture2D( tSrc, clamp( uv + hy, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb ) * exG, 0.0 ), 0.4545 );',
    '    float e3 = pow( max( pfLum( texture2D( tSrc, clamp( uv - hy, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb ) * exG, 0.0 ), 0.4545 );',
    '    float hf = max( abs( e0 - e1 ), abs( e2 - e3 ) );',
    '    // Lateral CA is a RADIAL lens property: it is zero on the optical axis by',
    '    // definition. r^2 alone still leaves a third of its peak at a third of',
    '    // the way out, which is where these fringes were sitting.',
    '    float rn = length( d * vec2( uAspect, 1.0 ) ) / max( 0.5 * length( vec2( uAspect, 1.0 ) ), 1e-4 );',
    '    float caKeep = smoothstep( 0.35, 1.0, rn ) * ( 1.0 - smoothstep( 0.06, 0.20, hf ) );',
    '    // ...and OPTIONALLY roll it off in the dark (uCADark 0 = off, which is',
    '    // every level that has shipped). A real lens fringe is a fraction of the',
    '    // light already there, so at 0.04 luminance it is invisible - but the',
    '    // pass is fed by sub-pixel speculars, which at 0.04 luminance are the',
    '    // BRIGHTEST thing in their corner of the frame, and a dispersion of a',
    '    // bright isolated sample against a black surround prints as a coloured',
    '    // spark rather than as an edge tint. Measured on the refinery ADS frame:',
    '    // the left 70 px strip carried 8x the strongly-blue-cyan pixel count of',
    '    // an equivalent mid-frame strip, at 0.045 corner luminance. Gating on the',
    '    // LOCAL display-referred level (the four taps hf was already built from,',
    '    // so this costs no extra fetch) removes exactly that case and leaves the',
    '    // fringe wherever there is enough light for a real one to be visible.',
    '    if ( uCADark > 1e-5 ) {',
    '      float lLoc = 0.25 * ( e0 + e1 + e2 + e3 );',
    '      caKeep *= smoothstep( uCADark * 0.45, uCADark * 1.55, lLoc );',
    '    }',
    '    color = mix( c0t, spread, caKeep );',
    '  } else if ( ca > 1e-5 ) {',
    '    color.r = texture2D( tSrc, clamp( uv + caDir * 1.0, vec2( 0.0 ), vec2( 1.0 ) ) ).r;',
    '    color.g = texture2D( tSrc, uv ).g;',
    '    color.b = texture2D( tSrc, clamp( uv - caDir * 1.0, vec2( 0.0 ), vec2( 1.0 ) ) ).b;',
    '  } else {',
    '    color = texture2D( tSrc, uv ).rgb;',
    '  }',
    '  color = pfSafe( color );',
    '',
    // ---- the inferior mirage ------------------------------------------------
    // The other half of the heat layer, and the half the eye actually reads as
    // heat (see pfHeatShimmer). pfHeatPaleAmt is 0 on every level that publishes
    // no heatShimmer AND on any that does without a preset asking for the
    // mirage, so this block costs one compare on all of them.
    //
    // The target is the ATMOSPHERE's chromaticity (uHeatSky, normalised to unit
    // luminance in _render from scene.fog, which is the colour every distant
    // surface in the frame is already converging to) at an ABSOLUTE radiance of
    // uHeatLift x the frame's own log-average. Absolute is the whole point: a
    // relative lift preserves contrast ratios, so it tints a shaded undercarriage
    // and leaves it exactly as readable as it was. max() against the pixel's own
    // luminance keeps this strictly additive in effect - a mirage is inscattered
    // light, so it may pale a sunlit slab but must never darken one.
    '  if ( pfHeatPaleAmt > 1e-5 ) {',
    '    float hLum = pfLum( color );',
    '    float hKey = exp( clamp( texture2D( tLum, vec2( 0.5 ) ).x, -20.0, 6.0 ) );',
    '    color = mix( color, uHeatSky * max( hKey * uHeatLift, hLum ), pfHeatPaleAmt );',
    '  }',
    '',
    '  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r;',
    '',
    '  // ---- the frame\'s KEY LEVEL, as a ratio against a noon reference -------',
    '  //',
    '  // exposure * uExposureBias is the print gain; the metering chain\'s log',
    '  // average is the scene it is being applied to; their product is therefore',
    '  // the PRINTED average, in linear light, before the tone curve. That is the',
    '  // only honest measure of "how low-key is this frame", and it is what the',
    '  // grade has to be normalised against.',
    '  //',
    '  // (Normalising against the gain alone - the obvious move - is exactly',
    '  // backwards: metering RAISES the gain on a dark scene, so a night frame',
    '  // would report the highest key in the game.)',
    '  //',
    '  // Everything downstream that touches it is relative shape only: the print',
    '  // stays dark at night because the exposure carries the key, precisely as a',
    '  // print LUT behaves.',
    '  float avgLum = exp( clamp( texture2D( tLum, vec2( 0.5 ) ).x, -20.0, 6.0 ) );',
    '  // uKeyFlash RE-KEYS the grade for a LIGHTNING STRIKE. The tonal masks, the',
    '  // S-curve pivot, the toe, the vignette and the grain are all normalised',
    '  // against this number, so it decides WHERE in the frame\'s own histogram',
    '  // the shadow leg and the highlight leg meet. Get it wrong in either',
    '  // direction and one leg eats the frame:',
    '  //',
    '  //   too HIGH - the whole strike frame falls into the shadow leg of a grade',
    '  //     authored around a resting night, is desaturated by shadowSat and',
    '  //     rotated cyan, and prints as neutral grey instead of the specified',
    '  //     cold #dceaff.',
    '  //   too LOW - the shadow leg does not exist at all. MEASURED with the',
    '  //     composite\'s own probe: the strike frame ran at knD 0.463 against a',
    '  //     resting 0.549 while its printed mean was 2.18x the resting one, i.e.',
    '  //     the crossovers sat a factor of 2.6 below the frame they were',
    '  //     splitting. Nothing in the image was below the shadow crossover, so',
    '  //     the cyan-green half of the split-tone was applied to zero pixels and',
    '  //     lightning.png measured grade_split NEGATIVE (-0.0155) - the only red',
    '  //     flag in the harbor set - while every other framing sat at +0.04 to',
    '  //     +0.31. The frame kept the flash and lost the grade.',
    '  //',
    '  // So this is not a discount, it is a calibration: keyFlashComp bounds how',
    '  // fast the key may run away with a big strike, keyFlashLift restores the',
    '  // part of it that is real. The two together land the strike frame at',
    '  // knD ~ 1.15 - the resting 0.549 scaled by the printed level it actually',
    '  // has - so the flash frame splits about ITS OWN midtone: the bolt-lit',
    '  // surfaces take the highlight leg (and, through uHighWarmGate, keep their',
    '  // 7000 K blue rather than being dragged sodium), and the quarter of the',
    '  // frame the bolt did not reach takes the cool leg it is supposed to.',
    '  // Exactly 1.0 on every frame that is not a strike, and on all of level 1.',
    '  float keyNorm = clamp( exposure * uExposureBias * avgLum * uKeyFlash / max( uKeyRef, 1e-4 ), 0.12, 3.0 );',
    '  // ...expressed in the display domain. AgX is log-compressed, so a factor k',
    '  // of scene light is worth far less than k on the print; uKeyExp is that',
    '  // compression, measured rather than assumed.',
    '  float knD = clamp( pow( keyNorm, uKeyExp ), 0.28, 1.6 );',
    '',
    '  // uAds lifts the stop a touch when the sights come up - the "world gets a',
    '  // little brighter and tighter" cue. Paired with the optic falloff below.',
    '  // LIGHTNING RESPONSE (uFlashComp; 1.0 = no lightning, so level 1 is',
    '  // untouched to the bit).',
    '  //',
    '  // The flash itself is NOT drawn here. lighting.js fires a real directional',
    '  // light, so the frame goes bright because the geometry is genuinely relit,',
    '  // with hard shadows thrown in a completely different direction from the',
    '  // sodium masts. What post owns is the SENSOR, and a sensor pointed at a',
    '  // 10x radiance step stops down hard and comes back slowly. uFlashComp is',
    '  // that stop, driven from a fast-attack / ~0.4 s-release envelope on',
    '  // ctx.weather.flash (see _flashAdapt): the frame compresses during the',
    '  // strike instead of clipping to a white card, and for the fraction of a',
    '  // second afterwards the terminal is DARKER than its resting level while',
    '  // the gain climbs back. That afterimage is the whole effect - adding white',
    '  // to the frame produces the flash but never the dazzle.',
    '  float postGain = uExposureBias * ( 1.0 + uFlash * 2.4 ) * ( 1.0 + uAds * 0.11 ) * uFlashComp;',
    '  color *= exposure * postGain;',
    '',
    '  if ( uDebug > 0.5 && gl_FragCoord.y < 2.0 && gl_FragCoord.x < 8.0 ) {',
    '    // Tuning probe (settings.debugProbe, off by default). The tone chain is',
    '    // entirely GPU-side and a readPixels round trip every frame is not an',
    '    // option, so the eight pixels in the bottom-left corner can be asked to',
    '    // carry the metering state out to a capture instead. Returns BEFORE the',
    '    // colorspace encode so the bytes are read back exactly.',
    '    // Slots 6/7 are the two lightning uniforms, because the key normalisation',
    '    // on a strike frame cannot be calibrated without knowing how hard the',
    '    // strike was discounted out of it.',
    '    float idx = floor( gl_FragCoord.x );',
    '    float v = 0.0;',
    '    if ( idx < 1.0 ) v = exposure / 8.0;',
    '    else if ( idx < 2.0 ) v = ( log2( max( avgLum, 1e-9 ) ) + 20.0 ) / 24.0;',
    '    else if ( idx < 3.0 ) v = uExposureBias * 0.5;',
    '    else if ( idx < 4.0 ) v = keyNorm / 3.0;',
    '    else if ( idx < 5.0 ) v = knD / 2.0;',
    '    else if ( idx < 6.0 ) v = pfLum( color );',
    '    else if ( idx < 7.0 ) v = uKeyFlash;',
    '    else v = uFlashComp;',
    '    gl_FragColor = vec4( clamp( v, 0.0, 1.0 ) );',
    '    return;',
    '  }',
    '',
    '  // ---- lens: bloom, dirt, streak, flare --------------------------------',
    '  // EVERY additive lens term is multiplied by the same postGain the base',
    '  // image just received. The bright pass only knows the metering gain, so',
    '  // without this the bloom\'s weight RELATIVE to the image it is added to',
    '  // swung 6.7x across game states - 1.35x at night, 0.65x on every gunshot',
    '  // frame and 0.20x at an explosion peak, i.e. the bloom collapsed to a',
    '  // fifth of its authored strength at the exact instant the frame had the',
    '  // most to bloom.',
    '  vec3 bloom = pfSafe( texture2D( tBloom, uv ).rgb );',
    '  vec4 dirt = texture2D( tDirt, uv );',
    '  float dirtMask = 1.0 + dirt.r * uDirt;',
    '  color += bloom * uBloom * dirtMask * postGain;',
    '',
    '  vec3 streak = pfSafe( texture2D( tStreak, uv ).rgb );',
    '  color += streak * uStreak * uSunOnScreen * postGain;',
    '',
    '  if ( uFlare > 1e-4 && uSunOnScreen > 0.01 ) {',
    '    // Ghosts sampled back out of the bloom pyramid along the sun-centre',
    '    // axis. Using the bloom as the source means an occluded sun produces',
    '    // no flare, for free. The clamp matters: the sun disc is ~180 linear,',
    '    // and an unclamped tap paints an opaque blob, not an optical artifact.',
    '    vec2 toCentre = vec2( 0.5 ) - uSunUv;',
    '    vec3 ghosts = vec3( 0.0 );',
    '    // The ghost falloff metric was computed in RAW UV, with no aspect',
    '    // correction, so every "aperture image" was a 1.78:1 VERTICAL ELLIPSE',
    '    // rather than a round one. uFlareAspect is 0 on the market (the shipped',
    '    // frame keeps its shipped ghosts, to the bit) and 1 on the storm.',
    '    vec2 fAsp = mix( vec2( 1.0 ), vec2( uAspect, 1.0 ), uFlareAspect );',
    '    for ( int i = 1; i <= 3; i++ ) {',
    '      float s = float( i ) * 0.62;',
    '      vec2 guv = clamp( uSunUv + toCentre * ( 1.0 + s ), vec2( 0.0 ), vec2( 1.0 ) );',
    '      float fall = 1.0 - clamp( length( ( uv - guv ) * fAsp ) * ( 6.0 + float( i ) * 4.0 ), 0.0, 1.0 );',
    '      vec3 gs = min( pfSafe( texture2D( tBloom, guv ).rgb ), vec3( 2.5 ) );',
    '      ghosts += gs * fall * fall * ( 0.5 / float( i ) );',
    '    }',
    '',
    '    // Lens halo. This was a fixed-radius band ~19% of frame height thick,',
    '    // filled with one unclamped bloom tap - the opaque orange donut across',
    '    // rooftop.png. A real halo is thin, faint, only exists when the source is',
    '    // near the optical axis, and disperses because each wavelength refracts',
    '    // differently, so all four of those properties are modelled here.',
    '    vec2 sunC = ( clamp( uSunUv, vec2( 0.0 ), vec2( 1.0 ) ) - 0.5 ) * vec2( uAspect, 1.0 );',
    '    float ecc = length( sunC );',
    '    float axisGate = smoothstep( 0.45, 0.05, ecc );',
    '    if ( axisGate > 0.002 ) {',
    '      float ringR = 0.18 + 0.55 * ecc;',
    '      float rr = length( ( uv - 0.5 ) * vec2( uAspect, 1.0 ) );',
    '      vec3 haloSrc = min( pfSafe( texture2D( tBloom, clamp( uSunUv, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb ), vec3( 3.0 ) );',
    '      float dR = rr - ringR * 0.985;',
    '      float dG = rr - ringR;',
    '      float dB = rr - ringR * 1.015;',
    '      vec3 ring = vec3( exp( -dR * dR * 3600.0 ),',
    '                        exp( -dG * dG * 3600.0 ),',
    '                        exp( -dB * dB * 3600.0 ) );',
    '      ghosts += haloSrc * ring * 0.05 * axisGate;',
    '    }',
    '    color += ghosts * uSunTint * uFlare * uSunOnScreen * ( 0.6 + 0.4 * dirt.g ) * postGain;',
    '  }',
    '',
    '  // ---- lens: vignette + cos^4 ------------------------------------------',
    '  // BEFORE the tone curve, and this file\'s own header says why: "lens effects',
    '  // happen to the light before it reaches the sensor; exposure and the tone',
    '  // curve are the sensor". Mechanical vignetting and cos^4 light-loss are',
    '  // unambiguously lens effects. Applied AFTER the curve (where this used to',
    '  // sit) a 0.681 corner factor scales the PRINT, so the corners lose their',
    '  // tonal shaping and block up instead of rolling into the toe - 21.8% of',
    '  // rooftop.png sat below 16/255. Here the toe absorbs the falloff and the',
    '  // corner reads as exposure rather than as a painted-on gradient, at the',
    '  // same 0.22 strength.',
    '  float vr = length( d * vec2( uAspect, 1.0 ) ) * 1.35;',
    '  // The artistic term recedes as the key drops. A 0.68 corner factor is a',
    '  // correct lens model at noon, but on a low-key frame it stacks onto an',
    '  // already-collapsed toe and drives the entire perimeter to the asymptote,',
    '  // which is how a night frame ends up as a vignette-shaped smear. The',
    '  // physical cos^4 term below is NOT scaled - that one really is the lens.',
    '  float vig = 1.0 - uVignette * mix( 0.45, 1.0, clamp( knD, 0.0, 1.0 ) )',
    '                  * smoothstep( uVignetteSoft, 1.15, vr );',
    '  // Natural cos^4 falloff on top of the artistic term. Both terms are gentle:',
    '  // stacked at full strength they put the entire perimeter a stop down,',
    '  // which against a warm haze reads as brown sludge rather than as a lens.',
    '  float cos4 = 1.0 / ( 1.0 + vr * vr * 0.30 );',
    '  // Aiming down sights, the eye box of the optic crops the field. A soft',
    '  // secondary falloff outside ~0.3 of frame height is the optical signature',
    '  // ADS had none of: in ads.png the world outside the housing was identical',
    '  // in every respect to the hip-fire frame.',
    '  vig *= 1.0 - uAds * 0.30 * smoothstep( 0.34, 1.10, vr );',
    '  color *= vig * mix( 1.0, cos4, 0.35 );',
    '',
    '  // ---- sensor ----------------------------------------------------------',
    '  // HIGHLIGHT ROLL-OFF, HUE-PRESERVING, IMMEDIATELY AHEAD OF THE TONE CURVE.',
    '  //',
    '  // pfAgX() log-encodes and then clamp()s to [AGX_MIN_EV, AGX_MAX_EV]. That',
    '  // upper clamp is a HARD CLIP at ~+4.03 EV (~16.3 linear) applied to each',
    '  // channel independently, and it is the actual mechanism behind every',
    '  // "blown white disc" in the frame: a lamp core at (84, 50, 20) has all',
    '  // three channels above the ceiling, so all three arrive at the contrast',
    '  // curve as exactly 1.0. Its colour is gone before the curve is evaluated,',
    '  // AND every pixel above the ceiling maps to the same output - a genuinely',
    '  // FLAT plateau with a hard edge where it crosses back under. No amount of',
    '  // bloom tuning can fix that, because it happens to the core itself.',
    '  //',
    '  // Compressing along the max channel is the one operation that cannot',
    '  // change a hue, and asymptoting below the ceiling means nothing in the',
    '  // frame is ever clipped by AgX again: the core keeps a monotone gradient',
    '  // out into its halo, and it keeps the emitter\'s chroma. Below uHiKnee -',
    '  // which sits above sunlit plaster and above the sky - this is the',
    '  // identity, so the exposure of the actual image is untouched.',
    '  float hmx = pfMax3( color );',
    '  if ( hmx > uHiKnee ) {',
    '    float over = hmx - uHiKnee;',
    '    float rolled = uHiKnee + over / ( 1.0 + over / max( uHiRange, 1e-3 ) );',
    '    color *= rolled / max( hmx, 1e-5 );',
    '  }',
    '  color = pfAgX( color );',
    '  // AgX is deliberately flat; a small saturation restore is the standard',
    '  // "punchy" look and keeps the ochre canopies from going to mud.',
    '  color = mix( vec3( pfLum( color ) ), color, uAgxSat );',
    '',
    '  // ---- grade -----------------------------------------------------------',
    '  color = pfGrade( color, knD );',
    '',
    '  // Damage response: a red-shifted, tightened frame.',
    '  if ( uHit > 1e-4 ) {',
    '    float edge = smoothstep( 0.15, 0.75, length( d * vec2( uAspect, 1.0 ) ) );',
    '    color = mix( color, color * uFlashTint, clamp( uHit * ( 0.35 + edge ), 0.0, 0.9 ) );',
    '  }',
    '',
    '  // ---- film grain ------------------------------------------------------',
    '  // Applied in a perceptual space: grain is a property of the recorded',
    '  // image, and doing it here means it doubles as the dither that hides',
    '  // 8-bit banding in the sky and in deep shadow.',
    '  vec3 enc = pow( max( color, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );',
    '  vec2 gp = floor( gl_FragCoord.xy / max( uGrainSize, 1.0 ) );',
    '  float tSeed = floor( uFrame );',
    '  float g0 = pfGrainHash( vec3( gp, tSeed ) );',
    '  float g1 = pfGrainHash( vec3( gp + 17.0, tSeed + 41.0 ) );',
    '  float g2 = pfGrainHash( vec3( gp + 71.0, tSeed + 13.0 ) );',
    '  // Real film grain lives in the shadows and mid-tones; the highlights are',
    '  // saturated silver and hold almost none.',
    '  //',
    '  // The deep-shadow term is a FLOOR, not a cut. It used to fall to 45% below',
    '  // l = 0.12, which is backwards from both the comment above it and from what',
    '  // a low-key frame needs: at night the entire frame is below that knee, so',
    '  // grain ran at half strength in exactly the band where the toe has the',
    '  // least separation left and dither is the only thing that can break the',
    '  // resulting flat. It is also scaled up as the key drops, for the same',
    '  // reason - a night frame gets roughly twice the dither a noon frame does.',
    '  float l = pfLum( enc );',
    '  float amt = uGrain * mix( 1.0, 0.18, smoothstep( 0.25, 0.92, l ) )',
    '            * mix( 0.80, 1.0, smoothstep( 0.0, 0.12, l ) )',
    '            * ( 1.0 + uGrainLowKey * ( 1.0 - clamp( knD, 0.0, 1.0 ) ) );',
    '  // OPT-IN luminance knee (uGrainShadowHi 0 = off, i.e. both frozen levels',
    '  // never take this branch and the expression above is the whole of the',
    '  // grain). The shipped roll-off starts at l = 0.25, which is ABOVE the mean',
    '  // of several of the new levels - so on a dawn frame whose lit stone sits at',
    '  // l ~ 0.35 the grain is still running at 95% of full strength and competes',
    '  // with the material\'s own micro-detail instead of sitting under it. A',
    '  // preset that wants its grain in the shadows, where a real emulsion puts',
    '  // it, states its own knee and its own highlight floor here.',
    '  if ( uGrainShadowHi > 1e-4 ) {',
    '    amt = uGrain * mix( 1.0, uGrainShadowFloor, smoothstep( uGrainShadowLo, uGrainShadowHi, l ) )',
    '        * mix( 0.80, 1.0, smoothstep( 0.0, 0.12, l ) )',
    '        * ( 1.0 + uGrainLowKey * ( 1.0 - clamp( knD, 0.0, 1.0 ) ) );',
    '  }',
    '  vec3 grain = ( vec3( g0, g1, g2 ) - 0.5 );',
    '  // Mostly monochrome with a little chroma, like a real emulsion.',
    '  grain = mix( vec3( grain.r ), grain, 0.35 );',
    '  enc += grain * amt;',
    '  // The grade\'s toe guarantees a print black around 4/255, but grain is',
    '  // added downstream of it and a negative excursion at the asymptote walks',
    '  // straight through zero - which is how a dither meant to BREAK the crush',
    '  // ends up creating it. 0.040 encoded is ~2.6/255 on the real sRGB OETF.',
    '  enc = max( enc, vec3( 0.040 ) );',
    '  color = pow( enc, vec3( 2.2 ) );',
    '',
    '  gl_FragColor = vec4( color, 1.0 );',
    '  #include <colorspace_fragment>',
    '}'
  );

  // Trivial copy, used for the degraded path and for keeping the TAA history
  // valid when a pass is disabled mid-chain.
  var FRAG_COPY = glsl(
    COMMON,
    'uniform sampler2D tSrc;',
    'void main() { gl_FragColor = vec4( pfSafe( texture2D( tSrc, vUv ).rgb ), 1.0 ); }'
  );

  // ---- scene depth, linearised, for SOFT PARTICLES -------------------------
  // The depth ATTACHMENT cannot be handed to a level: it is bound to the
  // framebuffer the scene pass is drawing into, so a material that samples it
  // while that pass is running forms a feedback loop, which ANGLE resolves by
  // silently dropping the draw call. (vfx.js hit this and documents it at
  // DepthLinearizer; this is the same conclusion reached independently.)
  //
  // So postfx publishes a COLOUR copy instead: R = positive distance along the
  // view axis, in world metres, at half resolution. Written once per frame right
  // after the scene pass, which means a material sampling it during the scene
  // pass reads the PREVIOUS frame - see PostFX.prototype.softParticleFade for
  // why that is the correct trade and what it costs.
  var FRAG_SOFTDEPTH = glsl(
    COMMON, DEPTH,
    'uniform sampler2D tDepth;',
    'void main() {',
    '  float d = texture2D( tDepth, vUv ).x;',
    // The far plane linearises to uFar, which is the honest answer for the sky:
    // "nothing in front of you for 600 m", so a card against the sky is not
    // faded. A cleared (never-written) target reads 0 and the consumer treats
    // that as "no data", which is the first frame after an allocation.
    '  gl_FragColor = vec4( pfLinearDepth( d ), 0.0, 0.0, 1.0 );',
    '}'
  );

  // The GLSL a level's own material runs to fade against that copy. Kept here,
  // as a string, for two reasons: it is the only place the encoding of
  // tPfDepth is known, and a level writing its own copy of the linearisation
  // would silently diverge the day this module changed the format.
  //
  // Everything is prefixed pf/uPf so it cannot collide with three's own chunk
  // library, and the whole block is inside a uniform-controlled branch so a
  // patched material can be switched back to hard-edged at runtime.
  var SOFT_DECL = [
    'uniform sampler2D tPfDepth;',
    'uniform vec2 uPfInvRes;',
    'uniform vec2 uPfNF;',
    // x = 1 / fade metres, y = near-fade metres (0 = off), z = enable
    'uniform vec3 uPfSoft;',
    'float pfsLinear( float d ) {',
    '  float z = d * 2.0 - 1.0;',
    '  return ( 2.0 * uPfNF.x * uPfNF.y ) /',
    '         ( uPfNF.y + uPfNF.x - z * ( uPfNF.y - uPfNF.x ) );',
    '}',
    'float pfsSoftFade() {',
    '  if ( uPfSoft.z < 0.5 ) return 1.0;',
    '  float sceneZ = texture2D( tPfDepth, gl_FragCoord.xy * uPfInvRes ).x;',
    '  float myZ = pfsLinear( gl_FragCoord.z );',
    // No data yet (a freshly allocated copy) must not blank the effect: an
    // unwritten texel reads 0, which is in front of the near plane and cannot
    // occur for real geometry.
    '  float f = ( sceneZ <= 0.0 ) ? 1.0 : clamp( ( sceneZ - myZ ) * uPfSoft.x, 0.0, 1.0 );',
    // ...and optionally fade the first few metres in front of the eye, which is
    // what stops a card the player walks into from filling the frame.
    '  if ( uPfSoft.y > 0.0 ) f *= clamp( myZ / uPfSoft.y, 0.0, 1.0 );',
    '  return f;',
    '}'
  ].join('\n');

  // ==========================================================================
  // Procedural textures (no external assets exist in this build)
  // ==========================================================================

  // Blue noise via energy minimisation (Georgiev & Fajardo's formulation of
  // Ulichney's void-and-cluster). White noise banded the volumetric raymarch
  // badly at 20 steps; blue noise plus TAA makes the same step count clean.
  function makeBlueNoise(size, rng) {
    var n = size * size;
    var chan = [new Float32Array(n), new Float32Array(n)];
    var R = 2, i, c;

    for (c = 0; c < 2; c++) {
      var v = chan[c];
      for (i = 0; i < n; i++) v[i] = rng.next();

      // Local energy of one pixel against its toroidal neighbourhood.
      var energyAt = function (arr, idx) {
        var x = idx % size, y = (idx / size) | 0, e = 0;
        for (var dy = -R; dy <= R; dy++) {
          for (var dx = -R; dx <= R; dx++) {
            if (dx === 0 && dy === 0) continue;
            var j = ((y + dy + size) % size) * size + ((x + dx + size) % size);
            var d2 = dx * dx + dy * dy;
            e += Math.exp(-d2 / 4.41 - Math.sqrt(Math.abs(arr[idx] - arr[j])));
          }
        }
        return e;
      };

      var iterations = n * 3;
      for (i = 0; i < iterations; i++) {
        var a = (rng.next() * n) | 0;
        var b = (rng.next() * n) | 0;
        if (a === b) continue;
        var before = energyAt(v, a) + energyAt(v, b);
        var t = v[a]; v[a] = v[b]; v[b] = t;
        var after = energyAt(v, a) + energyAt(v, b);
        if (after > before) { t = v[a]; v[a] = v[b]; v[b] = t; }
      }
    }

    // Channels 2/3 are toroidal shifts of 0/1 - still blue noise, and two
    // genuinely independent fields is enough decorrelation for our use.
    var data = new Uint8Array(n * 4);
    var sx = 23, sy = 37;
    for (var y2 = 0; y2 < size; y2++) {
      for (var x2 = 0; x2 < size; x2++) {
        var idx = y2 * size + x2;
        var shifted = ((y2 + sy) % size) * size + ((x2 + sx) % size);
        data[idx * 4 + 0] = Math.min(255, (chan[0][idx] * 256) | 0);
        data[idx * 4 + 1] = Math.min(255, (chan[1][idx] * 256) | 0);
        data[idx * 4 + 2] = Math.min(255, (chan[0][shifted] * 256) | 0);
        data[idx * 4 + 3] = Math.min(255, (chan[1][shifted] * 256) | 0);
      }
    }

    var tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.NoColorSpace;   // data, never colour
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  // Lens dirt: smudges, specks and wipe streaks, weighted toward the frame
  // edge where a real front element actually collects grime. R = bloom
  // modulation, G = flare modulation.
  function makeLensDirt(w, h, rng, noise) {
    var buf = new Float32Array(w * h * 2);
    var x, y, i;

    // Base grime from fbm so the plate is never uniform.
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 2;
        var n = noise.fbm2(x * 0.028, y * 0.028, 4, 2.1, 0.55) * 0.5 + 0.5;
        buf[i] = Math.max(0, n - 0.55) * 0.5;
        buf[i + 1] = Math.max(0, n - 0.62) * 0.35;
      }
    }

    function blob(cx, cy, r, amp, chan) {
      var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      var inv = 1 / (r * r);
      for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) {
          var dx = xx - cx, dy = yy - cy;
          var d2 = (dx * dx + dy * dy) * inv;
          if (d2 > 1) continue;
          var f = 1 - d2;
          buf[(yy * w + xx) * 2 + chan] += amp * f * f;
        }
      }
    }

    // Edge-biased smudges.
    for (i = 0; i < 170; i++) {
      var ang = rng.range(0, M.TAU);
      var rad = Math.pow(rng.next(), 0.55) * 0.72;
      var cx = (0.5 + Math.cos(ang) * rad) * w;
      var cy = (0.5 + Math.sin(ang) * rad) * h;
      blob(cx, cy, rng.range(4, 26), rng.range(0.10, 0.45), 0);
      if (rng.bool(0.4)) blob(cx, cy, rng.range(2, 10), rng.range(0.15, 0.5), 1);
    }
    // Fine specks - dust, not smudge.
    for (i = 0; i < 900; i++) {
      blob(rng.range(0, w), rng.range(0, h), rng.range(0.8, 2.6), rng.range(0.25, 0.9), 0);
    }
    // Wipe streaks: a cloth leaves arcs, not random noise.
    for (i = 0; i < 14; i++) {
      var sx = rng.range(0, w), sy = rng.range(0, h);
      var a = rng.range(0, M.TAU), len = rng.range(w * 0.15, w * 0.65);
      var curve = rng.range(-0.5, 0.5);
      var steps = Math.floor(len);
      for (var s = 0; s < steps; s++) {
        var t = s / steps;
        var aa = a + curve * t;
        blob(sx + Math.cos(aa) * s, sy + Math.sin(aa) * s, rng.range(1.2, 3.4), 0.07, 0);
      }
    }

    var data = new Uint8Array(w * h * 4);
    for (i = 0; i < w * h; i++) {
      var r0 = M.saturate(buf[i * 2]);
      var g0 = M.saturate(buf[i * 2 + 1]);
      data[i * 4 + 0] = (r0 * 255) | 0;
      data[i * 4 + 1] = (g0 * 255) | 0;
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    var tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;   // a mask, not colour
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  // Filler for the shadow sampler array. Packed depth 1.0 is RGBA(255,255,255,
  // 255), i.e. "nothing occluding" - so an unbound cascade slot reads as lit
  // rather than as a black wall.
  function makeWhite1x1() {
    var t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  // ---- the glow-card profile ------------------------------------------------
  // WHY THIS LIVES IN postfx AND NOT IN materials.js.
  //
  // The finding it answers is "bloom does not round off a clipped emissive
  // quad": a card whose radiance is a CONSTANT above the print's white point
  // keeps its rectangular silhouette however much bloom is applied. That is not
  // a bug in the bloom, it is arithmetic, and it is worth stating precisely
  // because the obvious fixes all fail:
  //
  //   * the composite adds bloom (color += bloom x uBloom x postGain). With the
  //     shipped pyramid uBloom lands near 0.068, and the bright pass caps a
  //     single emitter at bloomClamp (7.0 exposed), so the most bloom can add
  //     anywhere is ~0.48 exposed - on top of a card that is already 6-30. Every
  //     pixel inside it was over white before the bloom and is over white after
  //     it, so the ADDED energy cannot shape the silhouette.
  //   * making the composite energy-conserving (color = mix(color, bloom, k))
  //     would round it, but only at a k large enough to pull the core BELOW
  //     white: for a 30x card that is k > 0.96, i.e. replacing the image with
  //     its own blur. That is not a bloom.
  //   * the highlight roll-off and AgX cannot help either. They are monotone
  //     scalar curves, and a monotone curve of a constant is a constant.
  //
  // The information the blur needs simply is not in the source: there is no
  // gradient inside a constant. So the fix is to give the card one, and the
  // profile has to be calibrated against the tone chain (threshold, clamp, white
  // point, mip falloff) - all of which live in THIS file. refinery reached the
  // same answer locally with radial alpha plus additive blending; this is that,
  // shared, with the exponent chosen so the profile crosses the print's white
  // point well inside the quad at the intensities levels actually use.
  //
  // Authored in the ENCODED domain and tagged SRGBColorSpace, per the project's
  // colour rule, so the texture is a colour map and three's decode returns the
  // intended linear profile.
  function makeGlowProfile(size, falloff, core) {
    var n = size * size;
    var data = new Uint8Array(n * 4);
    var inv = 1 / Math.max(size - 1, 1);
    var denom = Math.max(1 - core, 1e-3);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        // Unit radius at the quad's edge, so the profile reaches exactly zero
        // there: a gaussian would not, and its truncation IS a hard edge, which
        // is the failure this texture exists to remove.
        var dx = (x * inv) * 2 - 1;
        var dy = (y * inv) * 2 - 1;
        var r = Math.sqrt(dx * dx + dy * dy);
        var a = (1 - r) / denom;
        a = a < 0 ? 0 : (a > 1 ? 1 : a);
        a = Math.pow(a, falloff);
        var v = Math.round(255 * Math.pow(a, 1 / 2.2));
        var o = (y * size + x) * 4;
        // The profile rides in RGB *and* alpha: additive blending reads RGB and
        // ignores alpha, normal blending reads alpha. One texture, both modes.
        data[o] = data[o + 1] = data[o + 2] = data[o + 3] = v;
      }
    }
    var t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat,
      THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  function makeFallbackNoise() {
    // 2x2 mid-grey stand-in so every pass still has a bindable sampler if the
    // async build never ran.
    var d = new Uint8Array([128, 64, 192, 32, 32, 200, 96, 160, 200, 16, 48, 224, 64, 144, 240, 80]);
    var t = new THREE.DataTexture(d, 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  // Halton(2,3) - the standard TAA jitter sequence. Low discrepancy in 2D, so
  // 8 frames of it tile the pixel far more evenly than random offsets.
  function halton(index, base) {
    var f = 1, r = 0, i = index;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  }

  // R2 / "plastic constant" low-discrepancy sequence (Roberts). Its short
  // prefixes are better conditioned in 2D than Halton's, which is what the
  // three-render capture path is actually judged on. Same generator as the
  // pfR2/pfR2b dither helpers in COMMON, so nothing new is being introduced.
  function pfR2(index, alpha) {
    return index * alpha - Math.floor(index * alpha);
  }

  // ==========================================================================
  // PostFX
  // ==========================================================================

  var _v2a = new THREE.Vector2();
  var _v3a = new THREE.Vector3();
  var _v3b = new THREE.Vector3();
  var _c1 = new THREE.Color();
  var _m4a = new THREE.Matrix4();

  var DEFAULT_SUN = new THREE.Vector3(0.72, 0.30, 0.62).normalize();

  function PostFX(ctx) {
    this.ctx = ctx || null;
    this.enabled = false;
    this.name = 'PostFX';

    // ---- tuning ------------------------------------------------------------
    // Everything an art pass would want to touch lives here rather than being
    // buried in the shaders.
    this.settings = {
      // ---- exposure ---------------------------------------------------------
      // The metering law is  gain = refGain * (refAvg / sceneAvg)^slope,
      // i.e. the hero framing receives refGain by definition and slope decides
      // how much of the DIFFERENCE from that framing survives into the print.
      // 1.0 is a full auto-normaliser and makes every time of day print
      // identically; 0 disables metering entirely.
      //
      // It used to be parametrised as (key/anchor) * (anchor/avg)^slope with
      // anchor = 0.30 - but the street's measured scene log-average is 0.021,
      // a factor of FOURTEEN out. With the pivot in the wrong place the slope
      // stopped being "how much local adaptation" and became a brightness
      // slider: raising it from 0.70 to 0.86 about that anchor multiplied the
      // street's own gain by 1.54x. Pivoting on the measured reference instead
      // makes slope do only its job, and at slope 0.70 the two forms are
      // algebraically identical, so this re-parametrisation prints bit-for-bit
      // the same frame it replaced.
      //
      // slope 0.86 (was 0.70): todBias below is ALSO solving time of day,
      // absolutely and explicitly, off sun intensity. The two were fighting for
      // the same job, and the leftover 0.30 of suppressed adaptation was paid by
      // enclosed spaces at the SAME time of day - a daylight alley printed
      // nearly a stop under the street it opens off. Metering now does genuine
      // local adaptation and todBiasFloor holds night down absolutely.
      exposureRefAvg: 0.021,   // measured log-average of the street hero framing
      exposureRefGain: 3.75,   // the print gain that framing is authored to get
      exposureSlope: 0.86,
      exposureBias: 1.0,
      exposureMin: 0.16,
      // 6.0 was binding. The street already metered 3.75 of it, so every
      // enclosed or low-light framing sat ON the clamp - which is why alley and
      // interior printed a stop dark no matter what the slope was set to, and
      // why raising the slope alone could not have fixed them.
      exposureMax: 18.0,
      // Absolute print level per time of day, driven off sky.sunIntensity. This
      // is the artistic half of the same problem: dusk is meant to be low-key
      // and night is meant to be dark even after the eye has adapted.
      todBiasFloor: 0.34,
      todBiasSun: 3.0,
      adaptUp: 2.6,          // scene got brighter -> pupil closes fast
      adaptDown: 1.1,

      // ambient occlusion
      aoRadius: 0.85,
      aoIntensity: 1.35,
      aoStrength: 0.92,
      aoFalloff: 0.55,
      aoFadeStart: 26.0,
      aoFadeEnd: 55.0,
      // Exposure-RELATIVE thresholds (see FRAG_RESOLVE). As absolute HDR values
      // these fired on every sunlit surface and deleted AO outdoors entirely.
      aoDirectLo: 0.35,
      aoDirectHi: 1.40,
      aoKeep: 0.75,          // 25% of the wide occlusion survives on direct light
      // Contact AO, applied UNMASKED (see FRAG_RESOLVE). The wide term has to be
      // masked off direct light, but that gate was firing on most lit pixels and
      // then throwing away 75% of the occlusion - so wall/floor junctions had no
      // contact notch anywhere in the game. Micro-geometry occlusion is valid on
      // direct light and this is the term that carries it.
      aoContact: 0.55,
      // Applied ONCE, to the combined occlusion (see FRAG_RESOLVE). Hue 207 deg
      // and only a 1.45:1 blue/red ratio: the old (0.085,0.115,0.150) was 1.76:1
      // and, being applied twice, squared to 3.1:1 in deep occlusion, which made
      // every geometry/ground junction a violet-black notch.
      aoTint: new THREE.Color(0.100, 0.125, 0.145),

      // volumetrics
      // Additive INSCATTERING only, occluded per step by the CSM. scene.fog
      // supplies the isotropic haze and the extinction; there is deliberately no
      // ambient term here, because adding one is a flat view-independent lift -
      // exactly the milky veil the shafts are supposed to cut through.
      volumeIntensity: 0.22,
      volumeDensity: 0.030,
      volumeHeightFalloff: 0.11,
      volumeBaseHeight: -1.0,
      volumeAnisotropy: 0.62,
      volumeMaxDist: 105.0,
      volumeShadowBias: 0.0012,
      volumeScatterAlbedo: 0.55,
      // ---- local practicals in the medium (harbor only) ---------------------
      // volumePracticalCount 0 disables the whole term. The two clamps below
      // are the reason it is safe to drive this straight off another module's
      // light intensities: no single lamp may contribute more than
      // volumePracticalClamp, and the pass total may not exceed
      // volumeMaxInscatter, both hue-preserving. See FRAG_VOLUME.
      volumePracticalCount: 0,
      volumePracticalGain: 1.0,
      // Unreachable by construction on the market (its inscatter peaks around
      // 0.3), so the clamp is inert there and is a real ceiling on the harbor.
      volumeMaxInscatter: 1e6,
      // ---- the medium stated ABSOLUTELY, in extinction-per-metre ------------
      // 0 = off, which is the shipped path and every preset written before this
      // one: the march density is reconstructed from scene.fog.density with
      // volumeDensity as a floor under it (see _render), because "how far can
      // you see" and "how thick is the near-field dust" are usually the same
      // number and the fog is the one every surface in the frame already agrees
      // with.
      //
      // They are NOT the same number for a GROUND MIST. A mist that is five
      // times denser at the ankle than at the chest has to be authored as a
      // steep volumeHeightFalloff over a large volumeDensity, and the moment
      // the density exceeds the fog-derived path's 0.075 ceiling that authored
      // number stops being what the march integrates. Above 0 this states the
      // medium outright and skips the reconstruction, so a preset that has a
      // height profile to express can express it. Harbor is unaffected: its
      // branch is tested first and weather.js still owns its medium.
      volumeDensityAbs: 0.0,

      // TAA
      taaFeedbackMin: 0.72,
      taaFeedbackMax: 0.90,
      taaVarianceGamma: 1.25,
      // Applied display-referred, on the FULL composite (weapon included) and
      // after every low-pass in the chain - see FRAG_SHARPEN. Lower than the old
      // 0.55 and worth considerably more, because the same numeric amount buys
      // ~3x the acutance in the mid-tones once it is out of HDR linear. Lower
      // again now the limiter is a true neighbourhood clamp: none of the amount
      // is being spent on halo any more, so the same acutance costs less.
      taaSharpen: 0.28,

      // bloom. bloomMipFalloff shapes the pyramid: 1.0 is a flat sum (all skirt,
      // no core, reads as fog); below 1 the fine mips dominate and hot pixels
      // get a tight bright halo.
      //
      // The old 0.095 x _bloomNorm (0.325) was a 3% net weight on energy above
      // 5x the metered mid-grey: a muzzle flash 0.5 m from the lens produced no
      // halo, no light-wrap onto the receiver and no rim on the glove, and the
      // brightest pixel in muzzleflash.png was the SKY. The pyramid was fine, it
      // was an order of magnitude under-driven. This only works together with
      // the white-point fix in pfGrade - without a reachable white the extra
      // energy has nowhere to go but a general lift.
      //
      // RE-RESTRAINED once lighting.js gained real emissive lamps, glowing
      // windows and halo cards. The threshold/knee pair below reads as a taste
      // call and is not: at threshold 0.65 / knee 0.62 the soft shoulder starts
      // at br = 0.03, so a mid-tone at 0.5x the metered grey donated 17.8% of
      // itself to the pyramid and one at 1.0x donated 37.9%. That is not a
      // bright pass, it is a low-pass of the whole frame added back on top of
      // it - the reason every practical light sat in a wide flat wash. At
      // 1.05 / 0.85 the same two pixels donate 5.3% and 18.8%, while a genuine
      // emitter at 6x still donates 82%: the mid-tone wash drops 3.4x and the
      // sources keep their halo. bloomClamp then bounds what a single emitter
      // may seed the pyramid with (see FRAG_BRIGHT) - hue-preserving, so the
      // colour survives the cap.
      bloomThreshold: 1.05,
      bloomKnee: 0.85,
      bloomIntensity: 0.25,
      bloomClamp: 7.0,
      // Shifted toward the skirt (0.72 -> 0.80) now that the threshold has taken
      // the mid-tone wash out. With the total renormalised by _bloomNorm this is
      // a redistribution, not an increase: the same energy is spread over a
      // wider, gentler falloff, which is what a source needs to read as a source
      // rather than as a disc with an edge. Still well below 1.0, where the sum
      // goes flat and the whole thing reads as fog instead of as light.
      bloomMipFalloff: 0.80,
      bloomRadius: 1.12,
      // The anamorphic streak is the one element here with no defensible
      // physical basis on a spherical lens, and at 0.070 x an UNCAPPED sun disc
      // it was laying a hard-edged horizontal band clean across street.png and
      // muzzleflash.png, in front of the palm trunk and the awnings. It now
      // draws from the CAPPED pyramid (so it scales with the frame instead of
      // with the sun's raw radiance), it is a third of the length, and it is
      // weak enough to read as veiling glare rather than as an overlay.
      streakIntensity: 0.022,
      streakSpread: 2.0,
      streakTint: new THREE.Color(1.0, 0.72, 0.42),
      dirtIntensity: 1.5,
      flareIntensity: 0.030,
      // Highlight roll-off ahead of AgX - see FRAG_COMPOSITE. uHiKnee sits above
      // sunlit plaster (~1.5-2.2 exposed) and above the sky, so the image proper
      // is untouched; the asymptote (knee + range = 9.0) sits below AgX's own
      // +4.03 EV ceiling (16.3 linear), which is what stops an emitter core
      // being hard-clipped into a flat, colourless, hard-edged plateau.
      highlightKnee: 2.5,
      highlightRange: 6.5,

      // Depth of field. Every number below is in DIOPTRES (1/m) - see COC for
      // why a dioptre difference is the only CoC model that behaves in a game
      // where the focus can be anywhere from 1.2 m to 140 m.
      //
      // The dead bands are deliberately wide on the near side: with focus at
      // 12 m nothing closer than ~1.1 m defocuses at all, so the near field
      // contains exactly one thing - the viewmodel, whose gloves and stock sit
      // at ~0.25 m and whose optic sits at ~0.4 m. That is the shot: soft stock
      // and grip, crisp optic, and a world that is sharp from the muzzle to the
      // vanishing point. The far side is nearly off at street focus distances
      // and opens up naturally indoors, where 1/focus is large.
      //
      // The far side was functionally disabled: at 12 m focus an object at
      // infinity is only 0.0833 dioptres out, so a 0.05 dead band and a 0.30
      // range gave it 11% of dofMaxRadius - 0.58 of a full-resolution pixel,
      // i.e. nothing. weapon_closeup therefore had a fully sharp, fully
      // cluttered background competing with the hero asset. The band below puts
      // ~1.9 full-res pixels on a 60 m+ background while still leaving a 40 m
      // mid-ground (which is gameplay-relevant) under the gather's own cutoff.
      dofFocus: 12.0,
      dofNearDead: 0.90,       // dioptres of sharp band on the near side
      dofNearRange: 4.00,      // dioptres from dead band to full radius
      dofFarDead: 0.025,
      dofFarRange: 0.16,
      dofMaxRadius: 2.6,       // half-res pixels (~5px at full resolution)
      dofAdsNearDead: 1.10,
      dofAdsNearRange: 4.50,
      dofAdsFarDead: 0.025,
      dofAdsFarRange: 0.24,
      dofAdsMaxRadius: 2.2,
      // Where the combine hands over from the sharp image to the half-res
      // gather, in HALF-RES TEXELS of gather radius (see FRAG_DOF_COMBINE).
      // 0 = the shipped fixed-CoC crossover, which is level 1's.
      dofBlendLoPix: 0.0,
      dofBlendHiPix: 0.0,

      // motion blur
      motionStrength: 0.55,
      motionMaxPixels: 26.0,

      // lens
      chromaticAberration: 0.0022,
      vignette: 0.22,
      vignetteSoft: 0.45,
      grain: 0.030,
      // Grain size in OUTPUT pixels at 720p, scaled with the drawing buffer at
      // dispatch (see _render) so the emulsion holds a constant ANGULAR size.
      // Locked to one output pixel it reads as digital sensor noise at 720p and
      // disappears entirely at 4K, which is exactly backwards.
      grainSize: 1.15,
      distortion: 0.0,

      // ---- viewmodel ---------------------------------------------------------
      // How much of the world's metered gain the weapon is allowed to inherit.
      // 0 = fully locked (the gun prints the same everywhere, which reads as a
      // sticker), 1 = it floats with the environment over 3+ stops (which is
      // what it was doing). 0.65 leaves it tracking by ~1.1 stops: it still
      // darkens at night, it just stays the same object.
      viewExposureLock: 0.65,
      // The metered gain the viewmodel materials were authored against. This is
      // a calibration constant, NOT a derived one - it used to be computed as
      // exposureKey/exposureAnchor, and since that anchor was 14x off it landed
      // at 0.583 against a real metered gain of ~3.75, i.e. permanently on the
      // 0.25 floor of the clamp below, in every scenario. The lock was therefore
      // a constant 0.404 multiply on the weapon rather than a lock - which is
      // why the gun was near-black in weapon_closeup and the brightest thing in
      // the frame at night, exactly the symptom the lock exists to prevent.
      // 1.046 is solved so the multiplier at the STREET reference framing is
      // 0.4037, i.e. bit-identical to the value the viewmodel materials are
      // currently authored against - the absolute brightness of the hero asset
      // does not move - while the ratio now sits clear of the clamp, so the lock
      // actually engages everywhere else. Measured, the gun goes from 1.84x
      // brighter at night than in the street to 1.24x.
      viewRefGain: 1.046,

      // grade — see ART_DIRECTION.md: teal-lifted shadows, warm midtones,
      // slightly desaturated, gentle S-curve. `printerBlack` is subtracted along
      // LUMINANCE and the lift is neutral, so neither can manufacture a hue; the
      // whole of the cool toe is the chroma ROTATION toward `shadowChroma` (see
      // pfGrade), which is luminance-preserving and therefore stays a tint at
      // every exposure instead of taking over as the signal approaches zero.
      agxSaturation: 1.12,
      contrast: 1.20,
      pivot: 0.40,
      // How much of the frame's own key the S-curve pivot follows. 0.80 is the
      // market's authored behaviour - the uniform replaces a literal that was
      // already there - and 1.0 pivots on the frame's own midtone exactly.
      pivotTrack: 0.80,
      // 0 = the shipped unconditional warm highlight leg. 1 = the leg is faded
      // out on highlights whose own chroma is already cold (see pfGrade).
      highWarmGate: 0.0,
      // The grade's tonal masks, its S-curve pivot, its toe, its vignette and
      // its grain are all normalised against the frame's KEY: the printed
      // average (metering gain x scene log-average x time-of-day bias) divided
      // by gradeKeyRef. gradeKeyRef is the value of that product for the hero
      // framing, which by construction is exposureRefGain * exposureRefAvg.
      // gradeKeyExp maps the linear-light ratio onto the log-compressed AgX
      // print - a 2.5x drop in scene light moves the printed mid-tone by ~1.6x,
      // not 2.5x.
      // A pure trim on that reference, so the two never drift apart.
      gradeKeyRefScale: 1.0,
      gradeKeyExp: 0.55,
      // Extra dither as the key drops. At night the toe has the least
      // separation left and grain is the only thing that can break the flat.
      grainLowKey: 1.60,
      // Toe shape, as scales on the solved asymptote and floor in pfGrade. Both
      // 1.0 is the market's authored curve, exactly; a preset that needs a
      // higher print black raises the first and a preset that needs a longer,
      // gentler toe raises the second by more (the knee is solved from their
      // difference, so widening the gap softens the roll).
      toeBlackScale: 1.0,
      toeFloorScale: 1.0,
      // How fast the two above relax back toward 1.0 once the frame's key runs
      // past 0.85 (see pfGrade). 0 disables the term entirely, which is the
      // market: knD is 1.0 at its reference framing by construction, so any
      // knD-keyed relaxation would act on every framing brighter than the
      // street. Only the storm has a key excursion this is meant for - a strike.
      toeRelax: 0.0,
      // Writes the metering state into the bottom-left six pixels of the frame
      // instead of the image. Tuning aid only - see FRAG_COMPOSITE.
      debugProbe: false,
      // Where the shoulder lands exactly on 1.0. Lower = white is easier to
      // reach and the highlights get more snap; higher = a longer roll-off.
      whitePoint: 1.13,
      saturation: 0.93,
      scotopic: 0.50,
      // Printer black, ACHROMATIC and subtracted along luminance. It was a
      // per-channel vec3 with R and G taken down by identical amounts, which
      // forces the residual to R == G < B - hue 240, pure blue, and structurally
      // incapable of producing teal. Same for the lift, whose old blue-heavy
      // (0.0026,0.0032,0.0050) was itself a 1.92:1 blue/red floor under every
      // dark neutral in the game. Both are neutral now; ALL of the cool toe
      // comes from the shadowChroma rotation, which is hue-correct and
      // luminance-preserving.
      printerBlack: 0.0125,
      lift: new THREE.Vector3(0.0032, 0.0032, 0.0032),
      // Both are MONOTONE now (R >= G >= B). The old pair - gain (1.03,1,0.975)
      // with a 1.02 gamma on blue alone - put GREEN at the minimum of the three,
      // which is magenta, not warm. It was invisible while the cool shadow tint
      // covered 85% of the frame and forced blue up everywhere; the moment the
      // tonal masks stopped being one-legged it printed shadows at hue 320-350.
      // All of the colour now comes from the tints, none from the transfer.
      gamma: new THREE.Vector3(1.00, 1.00, 1.00),
      gain: new THREE.Vector3(1.02, 1.005, 0.985),
      // A +-11% skew. The old (0.80, 0.95, 1.20) was a +-25% colour filter, and
      // stacked on top of an additive lift it took ART_DIRECTION's own
      // shadowed-plaster ratio of B/R 1.41 all the way to 2.88 on a neutral
      // floor. Backing all the way off to +-8% overshot the other way: measured
      // neutrals came back at B/R 0.71-1.12, i.e. the shadows were no longer
      // teal at all, they were neutral-to-warm. This sits between the two and
      // measures 0.78-1.20 on the same surfaces - visibly cool, nowhere near
      // the 1.45 ceiling.
      // Both cool tints are re-hued from ~220 deg (blue-violet) to ~206-211 deg
      // (blue-teal): teal requires G to sit BETWEEN R and B, and it did not.
      shadowTint: new THREE.Color(0.90, 1.005, 1.115),
      midTint: new THREE.Color(1.045, 1.005, 0.955),
      highTint: new THREE.Color(1.055, 1.006, 0.918),
      // Normalised teal the shadows rotate toward, at constant luminance.
      shadowChroma: new THREE.Color(0.87, 1.03, 1.15),
      shadowChromaAmount: 0.34,
      // How much of its own chroma a fully-shadowed pixel keeps before the teal
      // is applied. The skylight fill in this level is strongly blue, so the
      // road arrived at HSL saturation ~0.27 on its own; a print holds far less
      // colour down there.
      shadowSat: 0.70,
      shadowAmount: 0.90,
      midAmount: 0.30,
      highAmount: 0.58,
      hitTint: new THREE.Color(1.0, 0.34, 0.28),

      // ======================================================================
      // LEVELS 3-10 - the three knobs the new grade presets needed that did not
      // already exist. Same rule as every other addition in this file: the
      // DEFAULT of each one is an exact no-op, verified structurally rather than
      // by taste, so the two frozen levels cannot move.
      // ======================================================================

      // A saturation applied over the MIDTONE mask, exactly as shadowSat is
      // applied over the shadow mask. 1.0 skips the block entirely (the shader
      // branches on it, so the market does not even evaluate the expression -
      // see pfGrade), which is why this is a branch and not a mix: mix(x,x,t) is
      // not bit-exact on every driver and this file's regression gate is a byte
      // comparison.
      //
      // It exists because two of the new levels need "desaturated everywhere
      // EXCEPT the light sources", and the global `saturation` cannot express
      // that - it takes the sources down with everything else. The bunker's red
      // alarm beacons and the metro's fluorescent tubes both land in the
      // HIGHLIGHT mask, so crushing the mids and the shadows leaves them alone.
      midSat: 1.0,

      // 0 = the shipped behaviour: the sun streak and the flare ghosts fire on
      // the projected key-light DIRECTION alone. That is correct outdoors and
      // wrong in a buried facility, where sunDir falls back to DEFAULT_SUN, the
      // key is a dead 0 W light nobody can see, and the ghosts would sample a
      // bloom pyramid full of emergency strips - the exact defect the harbor
      // round measured and gated (see the uSunOnScreen block in _render). The
      // harbor keeps its own hard-coded gate, untouched; this is the same gate
      // made available to any preset that asks for it. Interior presets also
      // zero streakIntensity/flareIntensity, so this is belt AND braces.
      sunLensGate: 0,

      // 0 = the volumetric march is KEY-ONLY off the harbor, exactly as shipped.
      // 1 lets a preset opt into the same equi-angular local-practical term the
      // storm uses (see FRAG_VOLUME). Without it, a level with no sky gets a
      // raymarch whose only light source has zero intensity - which the harbor
      // round already proved contributes literally nothing, measured by A/B.
      // volumePracticalCount still gates the loop, so this alone does nothing.
      volumePracticals: 0,

      // ======================================================================
      // LEVEL 2 "COLD HARBOR" - storm additions.
      //
      // Every value below is authored so that its DEFAULT is the market's
      // existing behaviour: meterTrim 0 skips the trim branch, meterLumFloor is
      // literally the constant the old shader had inlined, rainLens 0 gates the
      // droplet block out, and the lightning envelope can only be non-zero when
      // ctx.weather exists and has fired. setGradePreset('storm') overwrites
      // these and a chunk of the grade above; nothing here is read on a market
      // frame in a way that can change a pixel.
      // ======================================================================

      // ---- screen-space reflections (harbor only) --------------------------
      ssrEnabled: true,
      ssrIntensity: 1.0,
      ssrMaxDist: 44.0,        // metres of ray
      ssrMaxViewDist: 95.0,    // stop marching for surfaces further than this
      ssrSteps: 26,
      ssrRefine: 6,
      ssrThickness: 0.55,      // metres of assumed solidity behind a depth sample
      ssrEdgeFade: 0.22,
      ssrUpLo: 0.42,           // world normal.y where a surface starts holding water
      ssrUpHi: 0.86,
      ssrSideAmount: 0.10,     // reflectance floor on non-horizontal wet surfaces
      ssrF0: 0.030,            // water
      ssrRoughDry: 0.34,
      ssrRoughWet: 0.055,
      ssrPuddleScale: 0.14,    // world units^-1 of the puddle/damp variation
      ssrRipple: 0.024,
      ssrBlur: 8.0,            // half-res texels of blur at roughness 1
      ssrClamp: 12.0,          // hue-preserving firefly cap on a reflected texel
      // How hard a MISSED ray blends in. LOW on purpose, and for a reason that
      // is easy to get wrong: three's PBR has ALREADY applied the PMREM env
      // specular to this pixel, so a full-weight environment fallback here is
      // double-counting the same light - and because the lerp replaces the base
      // rather than adding to it, at grazing incidence it would take a lamp pool
      // on the apron and pull it down toward the dome. What the term is actually
      // for is CONTINUITY: without it, every reflection would end on the hard
      // line where the march stopped finding hits. 0.30 is enough to hide that
      // seam and add a little sky sheen, and not enough to flatten the pools.
      ssrEnvWeight: 0.30,
      ssrEnvIntensity: 1.0,
      // ---- analytic wet-ground practicals (see pfPracLobe in FRAG_SSR_APPLY) --
      // 0 disables the term completely. A screen-space march cannot draw the
      // reflection of a lamp that is off-screen, behind the camera or occluded,
      // which looking down an apron is the majority case - so the effect the
      // brief names as this level's hero is exactly the one SSR structurally
      // cannot deliver. This is the analytic half of it.
      ssrPracticalGain: 0.0,
      // How much broader than the surface roughness the analytic lobe is
      // evaluated at, and the hue-preserving ceiling on what one lamp may
      // deposit. See pfPracLobe. ssrPracticalFloor is the lobe's own rain
      // agitation floor, deliberately NOT the reflection blur's - see the storm
      // preset for what happened when the two shared a number.
      ssrPracticalRough: 0.16,
      ssrPracticalClamp: 2.4,
      ssrPracticalFloor: 0.22,

      // ---- lightning (harbor only; all inert without ctx.weather) ----------
      // How hard the stop closes at flash = 1. MEASURED against the real rig:
      // at 2.00 the strike printed the terminal a full stop DARKER than its
      // resting frame (0.075 mean against 0.116), because weather.js's strike
      // is a multi-pulse envelope whose `flash` stays high through the gaps
      // between pulses while the light itself drops out. The eye model was
      // therefore stopping down against light that was no longer there. 0.95
      // is ~1 EV at the peak - enough that the strike compresses instead of
      // clipping, not so much that it inverts the frame it is meant to reveal.
      lightningCompress: 0.95,
      lightningRecover: 6.50,   // s^-1; ~93% re-adapted at 0.4 s
      lightningMeterHold: 6.0,  // how hard the meter freezes during a strike
      lightningHighlight: 0.45, // extra highlight roll-off during the strike
      lightningColor: new THREE.Color(0.86, 0.92, 1.00),

      // ---- rain on the lens (harbor only) ----------------------------------
      rainLens: 0.0,
      rainLensScale: 11.0,
      rainLensDensity: 0.30,
      rainLensStrength: 0.0075,
      rainLensEdge: 0.34,
      rainLensStreak: 26.0,

      // ---- lens / sharpen shape (harbor only; all exact no-ops at 0) --------
      // caSpectral 0 = the shipped two-tap RGB split. 1 = the 5-tap normalised
      // spectral sweep with the local-contrast and radial gates, which cannot
      // manufacture a hue absent from the source (see FRAG_COMPOSITE).
      caSpectral: 0,
      // 0 = RCAS as shipped. 1 = also skip pixels that are a local extremum
      // along BOTH axes, i.e. a periodic comb rather than an edge.
      sharpenExtGate: 0.0,
      // 0 = the shipped (aspect-ignoring) flare ghost falloff.
      flareAspect: 0.0,
      // ---- what a lightning strike is allowed to do to the PRINT -------------
      // flashPaletteRelease is the flash envelope level at which a strike fully
      // releases the highlight leg's cold-source gate (see pfGrade); 0 disables
      // the whole mechanism, which is the market - it has no lightning, so both
      // this and flashHighBoost can only ever multiply by zero there.
      flashPaletteRelease: 0.0,
      flashHighBoost: 0.0,
      // How the grade's key is re-derived during a lightning strike; see the
      // uKeyFlash block in FRAG_COMPOSITE for the measurement behind the storm
      // values. uKeyFlash is (1 + lift*flash) / (1 + comp*flash), so with BOTH
      // at 0 - the market, which has no lightning at all - it is exactly 1.0 and
      // nothing downstream of it can move.
      keyFlashComp: 0.0,
      keyFlashLift: 0.0,

      // ---- metering ---------------------------------------------------------
      // meterTrim 0 = the market's plain Karis-weighted log average.
      meterTrim: 0,
      meterTrimLo: 2.2,
      meterTrimHi: 9.0,
      meterLumFloor: 0.0005,

      // ======================================================================
      // LEVELS 3-10, BATCH 2. Four capabilities the levels could not express
      // from their own files. Same rule as everything above: every default is
      // an exact no-op and every one of them is read only from inside a branch
      // its own default closes.
      // ======================================================================

      // ---- heat shimmer -----------------------------------------------------
      // SHAPE ONLY. Whether the effect runs at all, where, and how hard is the
      // LEVEL's statement, not the grade's: it comes from level.heatShimmer
      // {y, strength, cells:[{x,z,r}]} or from postfx.setHeatShimmer(). A level
      // that publishes nothing gets uHeat 0 and the pass is not merely invisible
      // but unexecuted. The numbers here are the physics of the layer, which is
      // the same physics on any level that has one:
      //   heatAmount     peak screen displacement in UV at strength 1. The
      //                  shader's peak vertical noise weight is 0.57, so the
      //                  boil at 720p is heatAmount x strength x 0.57 x 720 px:
      //                  0.0090 is 3.1 px, which MEASURED as photographically
      //                  invisible (a t=1.5 / t=2.9 difference put nearly all of
      //                  the motion on TAA jitter along joint lines). A preset
      //                  that means it states its own - see BLEACH_GRADE, which
      //                  runs 0.022 for 7.6 px. Kept conservative here because
      //                  this default is what an unstated level inherits.
      //   heatHeight/Soft  metres of convection layer above the ground plane,
      //                  and how far it fades out over. A tail fin 12 m up is
      //                  still; the tarmac under it boils.
      //   heatNear/Far   METRES OF HOT AIR the view ray crossed - the onset and
      //                  the saturation of the path integral in pfHeatPath, not a
      //                  distance to the surface. Zero in the foreground however
      //                  hot the slab is, zero from above the layer looking down,
      //                  and saturating along a grazing sightline. A level whose
      //                  slab is a different size may override the pair from its
      //                  own heatShimmer record (pathNear / pathFar).
      //   heatScale      convection cells across the frame width.
      //   heatSpeed      how fast the field rises, in cells/second.
      //   heatCellFloor  0 = the level's cells are a HARD mask (shipped). Above
      //                  0, they are a boost over a slab that shimmers
      //                  everywhere, which is what a hot day is.
      //   heatPale       0 = displacement only (shipped). Above 0 it is the peak
      //                  weight of the INFERIOR MIRAGE - the lift-and-desaturate
      //                  term - at full reach. This is the half of the effect the
      //                  eye reads as heat.
      //   heatLift       the mirage's radiance, as a multiple of the frame's own
      //                  metered log-average. Only read where heatPale > 0.
      //   heatSkyWarm    0 = the mirage takes the atmosphere's chromaticity
      //                  literally (shipped). Above 0 it is warmed toward the key
      //                  light's, which is what a dust-laden grazing column over
      //                  hot hardstanding actually looks like - see the block in
      //                  _render, where the number came from a measurement.
      heatAmount: 0.0090,
      heatHeight: 3.2,
      heatHeightSoft: 3.0,
      heatNear: 12.0,
      heatFar: 70.0,
      heatScale: 6.5,
      heatSpeed: 0.62,
      heatCellFloor: 0.0,
      heatPale: 0.0,
      heatLift: 2.20,
      heatSkyWarm: 0.0,

      // ---- chromatic aberration: the dark roll-off --------------------------
      // 0 = shipped. Above 0 it is the display-referred local luminance at which
      // the (spectral) CA reaches full strength; below ~0.45x of it the pass is
      // off. Only read inside the spectral branch, so a preset must also set
      // caSpectral for it to mean anything - which is the correct pairing
      // anyway, since the two-tap split is the thing that manufactures the
      // saturated speckle in the first place.
      caLumFloor: 0.0,

      // ---- grain: the preset-supplied luminance knee ------------------------
      // grainShadowHi 0 = shipped (the 0.25 -> 0.92 roll-off to 0.18). A preset
      // that sets these three states its own knee, so grain can be pushed into
      // the shadows on a level whose midtone sits below the shipped knee.
      grainShadowLo: 0.0,
      grainShadowHi: 0.0,
      grainShadowFloor: 0.18
    };

    // ---- impulse state -----------------------------------------------------
    this.trauma = 0;
    this.shakeTime = 0;
    this.lensKick = 0;
    this.flash = 0;        // explosions: a real, slow-decaying overexposure
    this._flashShot = 0;   // per-shot: a two-frame punch, decays ~4x faster
    this.hitPulse = 0;
    this.shakeScale = 1.0;
    this._shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._shakeQuat = new THREE.Quaternion();
    this._shakePos = new THREE.Vector3();
    this._shakeMat = new THREE.Matrix4();
    this._camWorld = new THREE.Matrix4();
    this._viewWorld = new THREE.Matrix4();
    this._projBase = new THREE.Matrix4();
    this._projInvBase = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._curViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._historyValid = false;

    this._frame = 0;
    this._errorCount = 0;
    this._focusTarget = this.settings.dofFocus;
    this._focus = this.settings.dofFocus;
    this._focusRayBroken = false;
    // ---- heat shimmer state -------------------------------------------------
    // _heat null = off, which is every level that publishes no heatShimmer and
    // never calls setHeatShimmer. _heatExplicit records that a caller has taken
    // ownership, so setHeatShimmer(null) is "off" rather than "not set yet" and
    // the level scan can never resurrect it.
    this._heat = null;
    this._heatExplicit = false;
    this._heatScanned = false;
    // ---- soft particles / glow cards ---------------------------------------
    // _softWanted is set by the first caller of sceneDepthUniforms() or
    // softParticleFade(), and it is the ONLY thing that allocates the depth copy
    // or dispatches its pass. A level that asks for neither pays nothing: no
    // target, no draw call, no program.
    this._softWanted = false;
    this._softU = null;
    this._glowTex = null;
    // Set once per pose by _poseFocus during a capture; see update().
    this._poseFocusVal = 0;
    this._ads = false;
    this._adsBlend = 0;    // smoothed, drives the optic falloff + the ADS stop
    this._histFrames = 0;  // depth of the TAA history, for progressive feedback
    this._exposureResetFrames = 3;
    this._sunUv = new THREE.Vector2(0.5, 0.5);
    this._sunOnScreen = 0;
    this._size = new THREE.Vector2(1, 1);
    this._noise = new GAME.Noise(0x5eed01);

    // ---- weather / storm state ---------------------------------------------
    // ctx.weather is built AFTER postfx (see SYSTEMS in main.js), so nothing
    // here may touch it; it is read lazily, per frame, and always guarded.
    // ctx.levelId and ctx.levelDef, by contrast, are set before the build loop
    // runs, so the level branch can be decided here - which is what lets the
    // market skip allocating the SSR target entirely.
    this.gradePreset = 'market';
    // THE AUTHORED DEFAULT, FROZEN. Every preset is applied as "restore this,
    // then overlay the preset's own table", which is what makes a preset a
    // complete statement of a look rather than a diff against whatever happened
    // to be applied before it. Snapshotted here, before setGradePreset can run,
    // so it is always the values the file was authored with.
    //
    // This does not move the harbor: setGradePreset('storm') is called exactly
    // once, from the line below, at which point settings ALREADY equals the
    // snapshot - so the restore is the identity and the overlay is the same
    // overlay it always was.
    this._gradeBase = snapshotGrade(this.settings);
    this._exposureStops = 0;
    this._exposureBiasBase = this.settings.exposureBias;
    this._harbor = !!(ctx && (ctx.levelId === 'harbor' ||
      (ctx.levelDef && ctx.levelDef.weather === 'storm')));
    // Is this level configured from main.js's DECLARATIVE env table, or is it one
    // of the two frozen levels that configure themselves? Read once, here, from
    // the same ctx.levelDef the harbor gate above reads and at the same point in
    // boot (main.js sets it before the build loop). The only thing it gates is
    // GRADE_MODERN_LENS - see the comment there for why the preset name could
    // not carry that distinction on its own.
    this._declarative = !!(ctx && ctx.levelDef && ctx.levelDef.env);
    this._flashAdapt = 0;     // peak-hold envelope on ctx.weather.flash
    this._flashFall = 0;      // how far the flash has fallen below that peak
    this._flashComp = 0;      // RELEASE-ONLY follower: the afterimage, not the flash
    this._wetness = 0;
    this._rainAmt = 0;
    this._rainLens = 0;
    this._lensStreak = new THREE.Vector2(0, 0);
    this._envSky = new THREE.Vector3(0.02, 0.025, 0.035);
    this._envGround = new THREE.Vector3(0.006, 0.008, 0.011);
    this._viewToWorld = new THREE.Matrix3();
    this._camWorldShaken = new THREE.Matrix4();
    this._prevFwdUv = new THREE.Vector2(0.5, 0.5);

    if (!ctx || !ctx.renderer || !THREE) {
      GAME.logError('postfx', 'missing renderer; post-processing disabled');
      return;
    }

    this.renderer = ctx.renderer;
    // A private RNG: consuming from ctx.rng would shift every downstream
    // system's random stream and break capture determinism.
    this.rng = new GAME.RNG(((ctx.seed || 20260801) ^ 0x9e3779b1) >>> 0);

    this.setQuality(ctx.quality);

    // Before _allocate: the preset moves bloomMipFalloff, and _bloomNorm is
    // derived from it at allocation time.
    if (this._harbor) this.setGradePreset('storm');

    // ---- fullscreen dispatch ----------------------------------------------
    this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fsScene = new THREE.Scene();
    this.fsScene.matrixAutoUpdate = false;
    this.quad = new THREE.Mesh(GAME.fullscreenGeometry(), null);
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.fsScene.add(this.quad);

    // Placeholder data textures so no sampler is ever unbound before build().
    this.blueNoise = makeFallbackNoise();
    this.lensDirt = makeFallbackNoise();
    this.whiteTex = makeWhite1x1();
    this._shadowCount = 0;

    try {
      this._buildMaterials();
      this.renderer.getDrawingBufferSize(this._size);
      this._allocate(Math.max(2, this._size.x | 0), Math.max(2, this._size.y | 0));
      this.enabled = true;
    } catch (e) {
      GAME.logError('postfx.init', e);
      this.enabled = false;
    }
  }

  // --------------------------------------------------------------------------
  // Quality
  // --------------------------------------------------------------------------
  PostFX.prototype.setQuality = function (q) {
    var preset = {};
    if (typeof q === 'string') preset = { level: q };
    else if (q) preset = q;

    var level = preset.level || (this.q && this.q.level) || 'high';
    var prev = this.q || {};

    // Normalise into our own struct so a missing field never reads undefined
    // into a uniform.
    var out = {
      level: level,
      ssao: preset.ssao !== undefined ? !!preset.ssao : (prev.ssao !== undefined ? prev.ssao : true),
      ssaoScale: preset.ssaoScale !== undefined ? preset.ssaoScale : (prev.ssaoScale !== undefined ? prev.ssaoScale : 0.5),
      taa: preset.taa !== undefined ? !!preset.taa : (prev.taa !== undefined ? prev.taa : true),
      bloom: preset.bloom !== undefined ? !!preset.bloom : (prev.bloom !== undefined ? prev.bloom : true),
      motionBlur: preset.motionBlur !== undefined ? !!preset.motionBlur : (prev.motionBlur !== undefined ? prev.motionBlur : true),
      dof: preset.dof !== undefined ? !!preset.dof : (prev.dof !== undefined ? prev.dof : true),
      volumetrics: preset.volumetrics !== undefined ? !!preset.volumetrics : (prev.volumetrics !== undefined ? prev.volumetrics : true)
    };

    // SSR. main.js only sets quality.ssr on 'ultra', but the harbor's whole
    // look is the reflection - running the level's hero effect in captures and
    // not in the game the captures are meant to represent would be the wrong
    // way round. It is therefore ON from 'high' up and an explicit true can
    // still force it on below that. This flag does nothing at all unless the
    // harbor is loaded (see _ssrActive).
    out.ssr = preset.ssr === true || level === 'high' || level === 'ultra';
    out.ssrSteps = level === 'low' ? 12 : level === 'medium' ? 18 : level === 'ultra' ? 32 : 26;
    out.ssrRefine = level === 'low' ? 3 : level === 'medium' ? 4 : level === 'ultra' ? 7 : 6;

    out.ssaoScale = M.clamp(out.ssaoScale, 0.25, 1.0);

    // Per-level sample budgets. These are the knobs that actually move frame
    // time; the pass list barely matters by comparison.
    if (level === 'low') {
      out.aoDirs = 2; out.aoSteps = 4;
      out.volSteps = 12; out.volShadowTaps = 1;
      out.dofTaps = 10; out.mbTaps = 6;
      out.bloomMips = 4; out.viewScale = 1.0; out.streak = false;
    } else if (level === 'medium') {
      out.aoDirs = 2; out.aoSteps = 5;
      out.volSteps = 18; out.volShadowTaps = 2;
      out.dofTaps = 14; out.mbTaps = 8;
      out.bloomMips = 5; out.viewScale = 1.25; out.streak = true;
    } else if (level === 'ultra') {
      out.aoDirs = 4; out.aoSteps = 7;
      out.volSteps = 32; out.volShadowTaps = 3;
      out.dofTaps = 28; out.mbTaps = 12;
      out.bloomMips = 6; out.viewScale = 1.5; out.streak = true;
    } else { // high
      // 24 steps: with per-step CSM occlusion the step count is what sets how
      // clean the edge of a shaft is, and a jittered 20 was visibly stepping.
      out.aoDirs = 3; out.aoSteps = 6;
      out.volSteps = 24; out.volShadowTaps = 2;
      out.dofTaps = 20; out.mbTaps = 10;
      out.bloomMips = 6; out.viewScale = 1.5; out.streak = true;
    }

    var needRealloc = this.enabled && (
      prev.ssaoScale !== out.ssaoScale ||
      prev.viewScale !== out.viewScale ||
      prev.bloomMips !== out.bloomMips);

    this.q = out;

    if (needRealloc) {
      try { this._allocate(this._size.x | 0, this._size.y | 0); }
      catch (e) { GAME.logError('postfx.setQuality', e); }
    }
    return this;
  };

  // --------------------------------------------------------------------------
  // Grade presets
  //
  // 'market' is the authored default and lives in `settings` itself; calling
  // this with 'storm' overwrites the tone/grade/bloom/metering block in place.
  // Doing it as a mutation of `settings` rather than as a second table read at
  // dispatch time is deliberate: _render reads s.<field> in about sixty places
  // and threading an "effective settings" object through all of them would be
  // sixty chances to change level 1 by accident. This way the market code path
  // is not touched at all - the values simply are what they always were.
  //
  // ART_DIRECTION_HARBOR: cyan-green shadows, sodium-orange highlights, HIGH
  // contrast, deep near-blacks that never crush, mean luminance 0.10-0.18.
  // --------------------------------------------------------------------------
  var STORM_GRADE = {
    // ---- exposure ---------------------------------------------------------
    // A terminal at 02:00 is a few small pools of sodium in a large black
    // field. Metering it the way the street is metered inverts the intent: the
    // log average collapses, the ratio pins at the top of its clamp and the
    // whole level prints as an evenly-lit grey yard. Three things hold it:
    //   * the reference pair is re-pivoted onto a NIGHT scene average, so the
    //     slope term is again "how much local adaptation" rather than a
    //     brightness offset (identical reasoning to the market's own comment);
    //   * the slope itself is halved - walking from a lamp pool into a
    //     container canyon should get DARKER, that is the level;
    //   * exposureMin/Max are a two-stop window instead of a seven-stop one.
    //     Level 1 already proved that a wide range erases the intended look.
    // RE-MEASURED against the FINISHED level, not against the half-built one
    // the first pass was calibrated on. settings.debugProbe writes the metering
    // state into the bottom-left six pixels of the frame; read back off a real
    // capture the container framing meters a scene log-average of 0.0110 and
    // takes a gain of 3.23, i.e. the (refAvg, refGain) pivot was already in the
    // right place - the slope really is doing local adaptation here and not
    // standing in for a brightness offset. So this is a calibration, not a
    // re-derivation:
    //   * refAvg 0.010 -> 0.0110, the measured value.
    //   * refGain 3.20 -> 3.60. The three hero framings printed 0.143 / 0.144 /
    //     0.104 mean against ART_DIRECTION_HARBOR's 0.10-0.18, so the low end
    //     of the band was carrying the level and the overview was sitting ON
    //     the floor of it. This puts them mid-band with the darks lifted off
    //     the toe rather than the highlights pushed into the shoulder. It is
    //     deliberately a trim rather than the +19% the hero framings alone
    //     would justify: the framings that look straight into a mercury flood
    //     (`gangway`, `rain_closeup`) print a good half stop hotter than the
    //     sodium ones, which is partial adaptation behaving exactly as it is
    //     supposed to, and the level should not be dragged under to hide it.
    //   * the slope comes DOWN and the window comes IN, both for the same
    //     reason: the brief is explicit that the meter must not pump between a
    //     lamp pool and a dark canyon, and now that the resting gain is a
    //     measured number the window can be centred on it instead of being a
    //     guess wide enough to contain one. At slope 0.34 a 4x change in scene
    //     content moves the stop by 0.7 EV and the clamps bound the whole level
    //     to +-0.5 EV of its reference.
    exposureRefAvg: 0.0110,
    exposureRefGain: 3.60,
    exposureSlope: 0.34,
    // The FLOOR of the window comes down. Measured across the finished set the
    // apron framings (`quay`, `gangway`) print 0.19-0.20 mean against a brief
    // that asks for 0.10-0.18, while the canyon framings print 0.13 - and at
    // slope 0.34 the meter's answer to a framing three times brighter than its
    // reference is a 0.68x gain, i.e. 2.45, which is all but sitting on a 2.30
    // floor. The floor was therefore the binding constraint on exactly the
    // framings that needed to stop down, and the slope could not have fixed it.
    // 2.00 gives the meter the extra quarter-stop it was asking for and does
    // nothing at all to a framing that is not pinned.
    exposureMin: 2.00,
    exposureMax: 5.40,
    adaptUp: 1.60,
    adaptDown: 0.80,
    // Night is dark on purpose, but not by the market's -1.5 stops: there is no
    // sun to derive it from here, so the absolute term is mostly handed back to
    // the scene's own (genuinely low) radiance and to the grade.
    todBiasFloor: 0.62,

    // Percentile metering. See FRAG_LUM_DOWN: a trimmed mean that discards
    // everything printing above ~2.2x mid-grey, which is exactly the lamp
    // cores, the wet-metal speculars and the reflections of both.
    meterTrim: 1,
    meterTrimLo: 2.2,
    meterTrimHi: 9.0,
    // A floor under the log average. Standing in a dead-end between two
    // container stacks the visible scene really is near zero, and without this
    // the meter answers "open up seven stops", which is how a night level turns
    // into a grey one.
    meterLumFloor: 0.0025,

    // ---- grade ------------------------------------------------------------
    // The market's grade is warm-highlight over teal-shadow at contrast 1.20.
    // This is the same machinery aimed somewhere else entirely: the shadow
    // rotation target is a cyan-GREEN (G above R, B above G is wrong here -
    // #16191c wet concrete under a mercury sky reads green-cyan, not navy), and
    // the highlight tint is sodium #ff9a3c pulled back to a printer-plausible
    // strength. Contrast is up because the level is built out of pools of light
    // and genuine darkness.
    contrast: 1.34,
    // THE PIVOT AND ITS TRACKING, TOGETHER. The composite already slid the pivot
    // with the frame's key, but only by 80% of the way, and the residual 20% of
    // a noon pivot still sat above the entire tonal content of a container
    // canyon - so contrast 1.34 was acting there as a pure darkener and three
    // framings (crane, ads, enemy_closeup) printed under the 0.10 floor of
    // ART_DIRECTION_HARBOR's own band while the hero framings sat at 0.143.
    // Opening the stop cannot fix that and was bracketed to prove it: forcing
    // the gain to 4.7 (near exposureMax) moved crane 0.098 -> 0.104, because the
    // meter is already open two stops and the frame has no signal ABOVE the
    // pivot left to lift. Rotating about the frame's own midtone does fix it,
    // and it fixes it as CONTRAST rather than as brightness - the darks come off
    // the toe instead of the whole histogram sliding up.
    // MEASURED IN BOTH DIRECTIONS. The contrast operator is out = C*p + piv*(1-C),
    // so a pivot change is a uniform SHIFT of the whole print: -0.34 * dPivot at
    // contrast 1.34. It therefore lifts the framings that were failing the floor
    // and the ones that were already over the ceiling by exactly the same
    // amount, and at pivot 0.30 the apron framings (which a control build with
    // every change here reverted already prints at 0.19-0.20 against a
    // 0.10-0.18 brief) went to 0.24-0.25 and visibly desaturated as AgX rolled
    // the extra level into its shoulder. 0.33 is where the dark framings clear
    // the floor with margin - crane 0.098 -> 0.128, enemy_closeup 0.092 -> 0.15 -
    // and the bright ones are left within a couple of hundredths of where they
    // already were, which is the most a pure shift can do for a 0.9 EV spread
    // between framings.
    pivot: 0.33,
    pivotTrack: 1.0,
    saturation: 0.90,
    agxSaturation: 1.15,
    // Deep near-blacks are correct here - but the toe below is what keeps them
    // OFF zero, and printerBlack is pulled in rather than pushed out because
    // the frame has far less signal above it to spend.
    printerBlack: 0.0100,
    // The print black, and how long the roll into it is. At the market's curve
    // the harbor's deepest print landed on 9.6/255 with a toe that squeezed
    // everything below p = 0.061 into two output codes - so a third of every
    // framing was a single flat value plus grain. 1.18 / 1.45 takes the black
    // to ~14/255 (a plausible film black rather than a clipped one) and halves
    // the toe knee, which is where the extra separation comes from. Deliberately
    // NOT larger: the level lives on genuine darkness between the pools, and
    // this is a print black, not a fill light.
    toeBlackScale: 1.18,
    toeFloorScale: 1.45,
    // ...but only while the level is low key. A strike takes knD past 1.0 and
    // the shelf then costs the shadow quartile three quarters of its separation
    // (see pfGrade). At 2.5 the relaxation is inert on every resting framing in
    // the level (the brightest, `quay`, measures knD 0.690) and about half-way
    // in on a strike.
    toeRelax: 2.5,
    whitePoint: 1.06,
    scotopic: 0.42,
    // CYAN-GREEN, so G sits at the top and R at the bottom. Measured on the
    // real stack the first pass at this landed the apron's deep shadows at
    // G/R 0.915, B/R 0.918 - i.e. NEUTRAL, drifting warm, because every photon
    // in this level starts at a 2000 K sodium lamp and a 0.44 rotation cannot
    // pull that far. The pair below (more rotation, less surviving source
    // chroma) is what actually gets the between-the-pools darkness to read cold.
    shadowChroma: new THREE.Color(0.70, 1.08, 1.03),
    shadowChromaAmount: 0.66,
    shadowTint: new THREE.Color(0.845, 1.025, 1.010),
    midTint: new THREE.Color(0.985, 1.000, 1.010),
    highTint: new THREE.Color(1.100, 0.985, 0.860),
    shadowSat: 0.52,
    shadowAmount: 0.95,
    midAmount: 0.26,
    // Sodium highlights, but restrained: the storm deck over a sodium-lit
    // terminal is genuinely orange, and on the quay framing it fills half the
    // frame. Pushing the highlight leg as hard as the shadow leg turns that
    // into a sunset. The lamps stay warm because they ARE warm.
    highAmount: 0.58,
    gain: new THREE.Vector3(1.005, 1.000, 1.005),
    // A night frame has the least tonal separation left in the toe, and dither
    // is the only thing that can keep it from banding into a flat.
    grain: 0.034,
    grainLowKey: 1.90,
    // Measured on the 8x8 coverage grid: the perimeter cells of every harbor
    // framing were the ones printing at the toe asymptote, and the artistic
    // vignette is what put them there. The composite already scales this term
    // down with the key (see FRAG_COMPOSITE) but at knD ~ 0.5 that is only a
    // 27% reduction, and 0.26 x that still costs the corners half a stop on a
    // frame whose corners have nothing to spare. The physical cos^4 term is
    // untouched - that one really is the lens.
    vignette: 0.19,

    // ---- bloom ------------------------------------------------------------
    // Big soft warm halos in humid air are correct; flat white discs are not,
    // and the difference is almost entirely bloomClamp. The bright pass is
    // hue-exact by construction (every operation in it is a scalar multiply of
    // the fetched triple), so a sodium lamp seeds the pyramid sodium-orange and
    // stays that colour all the way to the composite - there is deliberately no
    // tint uniform to "warm up" the bloom, because warming it would be a lie
    // about a mercury flood standing next to it.
    bloomThreshold: 0.95,
    bloomKnee: 0.75,
    bloomIntensity: 0.30,
    bloomClamp: 4.50,
    bloomMipFalloff: 0.86,   // more skirt: wide haloes through the downpour
    bloomRadius: 1.28,
    // Compress earlier and further than the market so a lamp core keeps a
    // monotone gradient (and its chroma) instead of plateauing.
    highlightKnee: 1.80,
    highlightRange: 7.50,
    // No sun, so no sun streak - AND NO SUN FLARE EITHER. `onScreen` is derived
    // purely from the projected key-light direction with no gate on the key's
    // energy, so a 0.19-intensity moon flared like a noon sun and the ghosts
    // sampled a bloom pyramid full of sodium lamps: measured, the ghost pass was
    // changing 1.48% of harbor_overview by up to 69/255 in a frame whose p95 is
    // 82/255, in a band (x 356-1091, y 352-689) that is exactly the muddy
    // container yard the establishing shot is supposed to be about. Belt and
    // braces: _render also gates onScreen on real key energy on the harbor.
    streakIntensity: 0.0,
    flareIntensity: 0.0,
    // ...and if a future night preset ever turns the ghosts back on, they are at
    // least round now rather than 1.78:1 vertical ellipses.
    flareAspect: 1.0,

    // ---- the medium -------------------------------------------------------
    // The raymarch was KEY-ONLY, and this level's key is a 0.19 moon: captured
    // with the whole pass disabled, not one pixel of the container framing
    // moved. So the pass was not "burying the frame" (that was the fog density
    // weather.js has since halved) - it was contributing nothing at all, in a
    // level whose art direction names the visible lamp cone as its single most
    // important effect. The practical term below is what makes it a harbor
    // effect instead of a sun effect; see FRAG_VOLUME.
    //
    // volumeDensity is a placeholder: the real value is written per frame from
    // ctx.weather.fogDensity, which is published in extinction-per-metre - the
    // exact unit this march wants, and the same number sky.js gives the surface
    // fog. Deriving it from scene.fog.density instead (sigma x 0.6, re-inflated
    // by 1.35, with a market-authored floor under it) ran the march at 0.0225
    // against a medium of 0.0145.
    volumeDensity: 0.0145,
    // A downpour fills the whole air column; it does not hug the ground the way
    // the market's dust haze does, and a steep falloff put the cones' brightest
    // part below the lamps rather than through them.
    volumeHeightFalloff: 0.030,
    volumeBaseHeight: -2.0,
    volumeAnisotropy: 0.72,
    volumeMaxDist: 90.0,
    volumePracticalCount: 6,
    // MEASURED against the framing that stresses it hardest. `gangway` looks
    // straight into two close mercury floods, so it is where a forward-scattering
    // medium deposits the most: at gain 0.85 it took that frame from 0.181 to
    // 0.245 mean and cost it 18% of its edge energy, which is the pass veiling
    // the geometry rather than lighting the air in front of it. At 0.45 the
    // cones still gain the surround glow and the ground halo that the beam
    // meshes on their own cannot produce, and the framing lands back inside the
    // band. The hero framings barely move either way - they are not looking
    // down a beam - which is exactly the behaviour a phase function should give.
    volumePracticalGain: 0.45,
    // ~1.5x the frame's own mean radiance at the very core of a lamp, and a
    // hard ceiling everywhere else. This pass multiplies numbers owned by three
    // other modules (fog density, lamp intensity, lamp range); the one property
    // worth guaranteeing is that it can never be what saturates a frame.
    volumeMaxInscatter: 0.45,

    // ---- lens -------------------------------------------------------------
    rainLens: 1.0,
    // DOWN from 0.0026, and through a different operator. 0.0026 * r^2 is ~3.3
    // display pixels at the corner at 720p; on a 2-4 px corrugation comb the two
    // taps of the old split landed on different ribs and synthesised colours the
    // source never contained. The sweep in FRAG_COMPOSITE cannot do that, and
    // the local-contrast gate takes the term off the comb entirely - so what is
    // left is dispersion on the smooth off-axis falloff, which is what it was
    // written for. The market keeps its shipped 0.0022 two-tap path: its edges
    // are macro, not comb, and level 1 is frozen.
    chromaticAberration: 0.0016,
    caSpectral: 1,
    // The RCAS limiter is inert on a periodic comb (the 5-tap neighbourhood
    // already spans the comb's full range, so the clamp never binds) and its
    // silhouette guard is measured on ABSOLUTE encoded contrast, which a 02:00
    // frame never reaches. Both are fixed in FRAG_SHARPEN; this turns the second
    // half on. The amount comes down a touch as well - once the sharpen stops
    // spending its budget deepening the barcode, less of it goes further.
    sharpenExtGate: 1.0,
    taaSharpen: 0.24,
    // Cyan-green shadows over sodium highlights is a TWO-colour palette, and the
    // mercury/LED floods are the cold half of it. See pfGrade.
    highWarmGate: 1.0,
    // A BOLT IS NOT PART OF THAT PALETTE. For the ~100 ms a strike owns the top
    // of the frame the gate above is what erases the print's warm leg, and the
    // measured result was a highlight bin at (0.689, 0.678, 0.696) - flat grey,
    // neither the specified cold #dceaff nor the level's sodium - with the split
    // -0.0049. 0.30 is a THRESHOLD on the flash envelope rather than a scale,
    // deliberately: weather.js's published flash amplitude has moved by 3x
    // between two builds of this level, and a calibration that inverts on
    // another module's absolute number is not a calibration. Anything that
    // registers as a strike releases the gate fully; nothing else touches it.
    flashPaletteRelease: 0.30,
    // ...plus a small extra authority for the warm leg while the transient is
    // up. 0.35 takes highAmount 0.58 -> 0.78 at the peak, which is a ~2% chroma
    // move at the top end of the print - enough to hold the split-tone, far too
    // small to tint the strike.
    flashHighBoost: 0.35,
    // THE STRIKE FRAME'S KEY. Both halves are solved against the composite's
    // own probe rather than guessed: at the captured strike the peak-hold
    // envelope reads 0.925, the metered scene log-average is 3.93x its resting
    // value, the meter has stopped down from 3.83 to 2.45, and the printed mean
    // is 2.18x the resting frame's. The grade therefore wants knD ~ 0.549 x 2.18
    // = 1.20 - the resting key scaled by the level the frame actually printed at
    // - and the raw ratio pow(keyNorm, 0.55) lands on 0.965, because gradeKeyExp
    // is calibrated for the resting range and AgX compresses far harder at the
    // top than 0.55 predicts.
    //
    // 0.45 / 1.03 puts uKeyFlash at 1.379 there, i.e. knD 1.155, deliberately a
    // touch under the arithmetic target: knD also drives the S-curve pivot, and
    // since the contrast operator is a uniform SHIFT of -0.34 x dPivot, every
    // hundredth of key spent here is print level taken off the strike. It is a
    // RATIO of two linear terms rather than a single multiply so that it cannot
    // run away on a big strike - it asymptotes to 2.29x however hard the bolt
    // fires, which is what keeps the "everything falls into the shadow leg"
    // failure the old pure-discount form was written against out of reach.
    keyFlashComp: 0.45,
    keyFlashLift: 1.03,

    // ---- lens: depth ------------------------------------------------------
    // The far leg was functionally inert across the whole level: at dofFocus 12,
    // dofFarDead 0.025 / dofFarRange 0.16 gives a 90 m surface 29% of a 2.6
    // half-res-pixel radius - about 1.5 full-res pixels, i.e. nothing. So a
    // level whose entire subject is depth (an 80 m quay, container canyons, a
    // crane going up into cloud) had no lens depth cue anywhere, in a night
    // frame where atmospheric perspective is the only other depth channel.
    // MEASURED, AND THE OBVIOUS VERSION OF THIS FIX IS WRONG. Putting a 90 m
    // surface at full radius (farDead 0.012 / farRange 0.055 / maxRadius 4.5,
    // which is what the arithmetic above argues for) was captured and read: with
    // focus at 12 m and an establishing shot whose entire subject sits between
    // 25 and 90 m, EVERY pixel of harbor_overview lands in the far field and the
    // frame comes back a tilt-shift miniature - the crane gone, the freighter
    // gone, and the rain, which is a full-depth effect and the single thing that
    // must survive in a storm level, low-passed out of existence. The shipped
    // far leg is also not inert on this framing: the critic's own A/B moved its
    // local-contrast p90 by 14%.
    //
    // So this is ~1.5x the shipped leg and no more: ~2.2 full-res px at 90 m,
    // 1.6 px at 40 m, under a pixel inside 25 m. Enough to separate the boom and
    // the hull from the container tops and to take the edge off the corrugation
    // ribs where they alias hardest, and nowhere near enough to eat the frame.
    // ...AND WHERE THE FAR LEG STARTS, WHICH IS WHAT harbor_overview WAS
    // ACTUALLY LOSING. MEASURED, by capturing the establishing shot with the far
    // leg disabled outright and differencing: the leg was acting on 17% of the
    // frame and costing the MIDGROUND 15% of its local acutance (0.0694 -> 0.0605
    // mean gradient over the crane/quay band), and the mask is unambiguous - it
    // covers the gantry crane, the far quay, the freighter and every container
    // past the near row, i.e. the entire subject of the shot. The cause is the
    // dead band being stated for a gameplay focus: at 0.024 dioptres and a
    // 12-16 m auto-focus the sharp zone ends at ~17 m, so a wide of an 80 m yard
    // has nothing sharp in it but the walkway the camera is standing on.
    //
    // 0.045 dioptres is ~22 m of hyperfocal reach instead of ~12. At a 12 m
    // focus the crane at 35 m is sharp, the far quay at 50 m is barely touched,
    // the 90 m background blends 40% and the cloud deck 68% - which is the shape
    // the depth cue was written for, a distant background going soft, rather
    // than a tilt-shift plane 20 m in front of the camera. Framings that DO
    // focus on something near (weapon_closeup, the container canyons) are
    // unaffected: at a 8-10 m focus a 40 m background still lands at full
    // handover, because the dead band is in dioptres and scales with the focus.
    dofFarDead: 0.045,
    dofFarRange: 0.130,
    dofMaxRadius: 3.0,
    dofAdsFarDead: 0.025,
    dofAdsFarRange: 0.200,
    dofAdsMaxRadius: 2.4,
    // ...and the far leg is only worth what the combine lets through, which is
    // the actual defect behind the establishing shot. See FRAG_DOF_COMBINE:
    // against the shipped fixed-CoC crossover, harbor_overview was replacing
    // everything past ~35 m with a half-resolution buffer to buy about a pixel
    // and a third of authored blur. Stating the crossover in half-res texels of
    // real gather radius instead - nothing below a fifth of a texel, full
    // handover only past 1.2 of them, which is genuinely more blur than the
    // resolution halving costs - keeps the depth cue the leg was written for and
    // gives the 20-45 m band, i.e. the whole container yard, its detail back.
    dofBlendLoPix: 0.20,
    dofBlendHiPix: 1.20,

    // ---- SSR: the analytic half of the hero effect -------------------------
    // See pfPracLobe. Deliberately modest: this is ADDED to a frame that already
    // has a screen-space reflection term, and the failure mode is an apron that
    // glows rather than one that mirrors. Measured: at gain 0.55 with the lobe
    // at surface roughness it printed hard-edged white plates on every wet
    // horizontal surface within ~8 m of a mast. Broadening and capping is what
    // turns that back into a smear; the gain then only sets how far down the
    // apron the smear stays readable.
    ssrPracticalGain: 0.20,
    ssrPracticalRough: 0.18,
    ssrPracticalClamp: 2.2,
    // The rain-agitation floor the ANALYTIC lobe is evaluated at, kept separate
    // from the reflection blur's own floor. MEASURED, and it is the trap that
    // comes with letting the shared wet field drive the blur: the two used to
    // be one number, so dropping the blur floor from 0.22 to 0.133 also made
    // this lobe 2.7x peakier, and since it is capped hue-preserving at
    // ssrPracticalClamp a peakier lobe does not print as a brighter highlight -
    // it prints as a LARGER AREA SITTING EXACTLY ON THE CAP. Captured, the
    // gangway apron came back as one flat pale plate averaging 121/255 against
    // 32/255 with the pass disabled: not a reflection, a flood, and the single
    // most damaging thing a wet-ground pass can do. They are different physical
    // statements anyway - the blur kernel is the reflection's screen footprint,
    // this is how broad a downpour beats a water surface into - so 0.22 keeps
    // the lobe exactly the shape it was tuned as while the field is free to
    // drive the kernel.
    ssrPracticalFloor: 0.22,
    // ---- how hard a MISSED ray leans on the analytic dome ------------------
    // The base setting's 0.30 is documented as a CONTINUITY term: enough to hide
    // the hard line where the march stops finding hits, not enough to flatten
    // the pools. On this level it had stopped being that. Bisected on `gangway`,
    // whose foreground is a large wet plate seen at a grazing angle: the march
    // alone returns a real, structured reflection of the crane, the masts and
    // the rails at 67/255, and the fallback took it to 97/255 by filling every
    // gap in that reflection with one uniform value - so the pass printed a flat
    // pale plate where the brief asks for a black mirror. Roughly half the
    // weight, against a dome whose horizon crossover is now in the right place
    // (see FRAG_SSR), keeps the seam covered and gives the structure back.
    ssrEnvWeight: 0.16,

    // ---- lightning --------------------------------------------------------
    // The highlight roll-off during a strike comes down hard. At 0.45 the sensor
    // was closing the stop ON THE FRAME THE FLASH ARRIVED, which is the one
    // thing a real sensor cannot do, and lightning.png landed at 0.007% clipped
    // pixels - a 1/20 s freeze of a 7000 K wall of light reading as flat
    // overcast daylight. ART_DIRECTION_HARBOR explicitly permits the clip
    // ("Highlights on wet metal may clip briefly"). The AgX shoulder plus the
    // white point already roll the peak off; 0.15 is a trim on top of that.
    // The eye-adaptation afterimage - which is the effect actually being
    // modelled and is well worth keeping - now runs off a RELEASE-ONLY follower
    // (see _updateWeather), so it lands in the ~0.4 s AFTER the strike instead
    // of during it.
    lightningHighlight: 0.15
  };

  // ==========================================================================
  // LEVELS 3-10: the rest of the grade table
  //
  // Nine presets, and the ONLY reason they exist is that ten levels graded by
  // one look are one level with different props. Each table below is a complete
  // statement of a colour identity, applied the same way STORM_GRADE is: the
  // authored default is restored first and the table is overlaid onto it, so a
  // preset is a look rather than a diff against whatever ran before it.
  //
  // WHAT IS AND IS NOT CALIBRATED HERE, STATED PLAINLY. The market's and the
  // harbor's exposure numbers are MEASURED - refAvg is a real log-average read
  // back off a real capture through settings.debugProbe. The eight levels below
  // do not exist yet, so nothing about them can be measured, and inventing an
  // exposureRefAvg for a level nobody has built is how a level ends up two stops
  // off with a number that looks authoritative. So:
  //
  //   * OUTDOOR presets keep the market's measured (refAvg, refGain) pivot and
  //     move only the SHAPE terms - slope, the clamp window, todBiasFloor, the
  //     trim. Those are statements about how the meter should behave, not about
  //     what the level measures, and they are safe without a capture.
  //   * INTERIOR presets ('green', 'alarm') MUST move more, because the market's
  //     law is structurally wrong with no sky in the frame - see the block on
  //     each of them. They are still written so the worst case is bounded rather
  //     than calibrated: the window cannot open past ~+0.8 EV of the market's
  //     own reference gain whatever the scene average turns out to be.
  //   * every level carries an `exposure` trim in its env profile (main.js),
  //     which is exactly the right place for the last quarter stop once someone
  //     has an actual frame to look at. See setExposureBias.
  //
  // The COLOUR half needs no capture to be right and is where the work went.
  // One invariant runs through all nine: the highlight leg must end up redder
  // relative to blue than the shadow leg, or analyze.py's grade_split - which
  // is literally (hiR - hiB) - (shR - shB) - reports "no meaningful colour
  // grade". That is compatible with every palette in the roster including the
  // green one, as long as the green is taken toward YELLOW-green in the
  // highlights and the cool leg carries the blue. It is not compatible with a
  // cyan highlight over a cyan shadow, which is the trap.
  // ==========================================================================

  // ---- 'cold' - Kirovsk Pass, blizzard whiteout ----------------------------
  // The hardest of the nine to keep out of "grey and dead", and the reason is
  // arithmetic rather than taste: an overcast whiteout has almost no chroma of
  // its own and almost no tonal range, so a grade that leans on either has
  // nothing to work with. Both problems are solved from the SHADOW side. Snow
  // is a volumetric scatterer - light goes into it, bounces around and comes
  // back out - so its shadows are genuinely bright and genuinely blue (skylight
  // is the only thing lighting them), and that is a real physical statement,
  // not a stylisation. Hence: the highest print black in the roster, a long
  // gentle toe, and the strongest blue rotation of any daylight preset. The
  // highlights are left near-neutral on purpose - warm snow is wrong - so the
  // split comes almost entirely from the cool leg, which is also what keeps
  // grade_split comfortably positive without a warm push that would look like
  // sunlight in a storm.
  var COLD_GRADE = {
    // Whiteout is the BRIGHTEST scene in the roster and the meter's instinct is
    // to normalise it back to mid-grey, which is precisely the "flat, grey,
    // dead" failure. A low slope leaves the absolute radiance in the print;
    // the trim keeps the blown sky out of the average so the ground still sets
    // the stop.
    exposureSlope: 0.55,
    exposureMin: 1.60,
    exposureMax: 7.50,
    todBiasFloor: 0.55,
    adaptUp: 2.20,
    adaptDown: 1.10,
    meterTrim: 1,
    meterTrimLo: 2.60,
    meterTrimHi: 9.00,
    meterLumFloor: 0.0015,

    contrast: 1.08,          // gentle: a blizzard has no hard edges
    pivot: 0.46,             // ...about a HIGH pivot, because the frame is high
    pivotTrack: 0.90,
    saturation: 0.76,        // low, but nowhere near monochrome
    agxSaturation: 1.04,
    scotopic: 0.30,
    // White is deliberately hard to reach. A whiteout that clips is a white
    // card; the whole subject of the level lives in the top two stops and it
    // has to keep a gradient there, so the shoulder is long and the roll-off
    // ahead of AgX starts high and asymptotes wide.
    whitePoint: 1.26,
    highlightKnee: 3.20,
    highlightRange: 9.00,
    // LIFTED BLACKS, stated three ways because they are the identity of this
    // preset: almost no printer black (there is no black in a blizzard), a real
    // additive lift, and a toe whose asymptote is ~2.5x the market's with a
    // floor pushed further still - and since the knee is SOLVED from the gap
    // between the two, widening the gap is what buys the long soft roll rather
    // than a shelf.
    printerBlack: 0.0060,
    lift: new THREE.Vector3(0.0090, 0.0098, 0.0115),
    toeBlackScale: 1.55,
    toeFloorScale: 1.85,
    shadowChroma: new THREE.Color(0.80, 0.97, 1.22),
    shadowChromaAmount: 0.42,
    shadowTint: new THREE.Color(0.900, 0.985, 1.100),
    midTint: new THREE.Color(0.975, 1.000, 1.030),
    highTint: new THREE.Color(1.030, 1.006, 0.972),   // near-neutral, barely warm
    shadowSat: 0.58,
    shadowAmount: 0.92,
    midAmount: 0.30,
    highAmount: 0.40,
    gain: new THREE.Vector3(1.005, 1.000, 1.005),
    grain: 0.026,
    grainLowKey: 0.60,       // a high-key frame needs almost no dither
    vignette: 0.13,          // a whiteout has no corners to lose
    // Wide, soft veiling glare is what driving snow actually does to a lens.
    bloomThreshold: 1.20,
    bloomKnee: 0.90,
    bloomIntensity: 0.30,
    bloomClamp: 6.00,
    bloomMipFalloff: 0.88,
    bloomRadius: 1.30,
    // There is no sun disc in a blizzard, so there is no streak and no ghost.
    streakIntensity: 0.0,
    flareIntensity: 0.0,
    flareAspect: 1.0,
    // A thick, near-isotropic medium filling the whole air column: distance
    // dissolves into white, which is the brief's own description of the level.
    volumeIntensity: 0.16,
    volumeDensity: 0.040,
    volumeHeightFalloff: 0.035,
    volumeBaseHeight: -3.0,
    volumeAnisotropy: 0.45,
    volumeMaxDist: 70.0
  };

  // ---- 'green' - Line 4, flooded metro. INTERIOR ---------------------------
  // NO SKY AT ALL, and that breaks the market's metering law structurally
  // rather than by a stop or two. Three separate mechanisms have to be
  // disarmed, and all three are visible in the numbers below:
  //
  //   1. todBias is derived from sky.sunIntensity, i.e. it is an ABSOLUTE "how
  //      bright is the sun" term. Underground it reads 0 and pins on
  //      todBiasFloor, which on the market is 0.34 - a 1.55 stop darkening
  //      applied to a level that has no sun to be darkened by. todBiasFloor 1.0
  //      hands the absolute level back to the scene's own radiance and to the
  //      grade, which is where it belongs when every photon is a practical.
  //   2. the log average of a tunnel collapses toward zero, so ratio pins at
  //      its 60x clamp, pow(60, 0.86) is ~35, and the meter answers "open seven
  //      stops" - a black level printed as an evenly-lit grey one. The floor
  //      under the average, the low slope and the narrow window each cut a
  //      different part of that path.
  //   3. a handful of fluorescents in a large dark field is the harbor's
  //      problem exactly, so it gets the harbor's answer: a trimmed mean that
  //      discards the tube cores before they set the stop for the tunnel.
  //
  // The window is BOUNDED rather than calibrated, which matters because nobody
  // has captured this level yet: whatever the scene average turns out to be,
  // the stop cannot land more than ~+0.8 EV above the market's own reference
  // gain nor below ~-0.9 EV. It cannot meter itself into black and it cannot
  // meter itself into a wash. A level agent trims the last quarter stop with
  // the `exposure` field in its env profile.
  var GREEN_GRADE = {
    exposureRefAvg: 0.021,
    exposureRefGain: 3.40,
    exposureSlope: 0.40,
    exposureMin: 1.90,
    exposureMax: 6.20,
    todBiasFloor: 1.0,
    adaptUp: 1.80,
    adaptDown: 0.85,
    meterTrim: 1,
    meterTrimLo: 2.00,
    meterTrimHi: 8.00,
    meterLumFloor: 0.0030,

    // High contrast about a LOW pivot that tracks the frame's own midtone
    // completely - the harbor's lesson, and it applies harder here: a service
    // corridor lit by one failing strip has no tonal content above a daylight
    // pivot at all, so a fixed one turns the contrast term into a darkener.
    contrast: 1.36,
    pivot: 0.34,
    pivotTrack: 1.0,
    saturation: 0.88,
    // ...and the chroma is taken OUT of everything the fluorescents are not.
    // The tubes and the red emergency strips are emitters and land in the
    // highlight mask, so they keep their colour while the tile, the grime and
    // the standing water go nearly grey. That contrast - a sick green light on
    // a colourless world - is the level's whole identity, and a global
    // saturation cut cannot produce it.
    midSat: 0.55,
    shadowSat: 0.50,
    agxSaturation: 1.18,
    scotopic: 0.58,
    whitePoint: 1.05,        // white is EASY to reach: the strips snap
    highlightKnee: 1.60,
    highlightRange: 7.00,
    printerBlack: 0.0140,
    lift: new THREE.Vector3(0.0026, 0.0030, 0.0028),
    toeBlackScale: 1.00,     // deep, but the 0.040 encoded floor still holds
    toeFloorScale: 1.18,
    // The cool leg is BLUE-cyan and the warm leg is YELLOW-green. That split is
    // what makes the level read as sickly-green rather than as a green wash,
    // and it is also what keeps grade_split positive with a green palette -
    // see the note at the top of this section.
    shadowChroma: new THREE.Color(0.72, 1.02, 1.10),
    shadowChromaAmount: 0.58,
    shadowTint: new THREE.Color(0.860, 1.010, 1.045),
    midTint: new THREE.Color(0.930, 1.055, 0.985),
    highTint: new THREE.Color(1.020, 1.075, 0.905),
    shadowAmount: 0.95,
    midAmount: 0.55,
    highAmount: 0.62,
    gain: new THREE.Vector3(0.995, 1.010, 0.995),
    // ---- grain: WHY THIS IS THE SMALLEST PAIR IN THE TABLE AND NOT THE LARGEST
    // The first draft ran 0.036 / 1.80, the most aggressive pair here, on the
    // argument that a low-key frame has the least tonal separation left and
    // dither is the only thing that can break the resulting flat. That argument
    // is right about a frame that is dark AND flat. This one is dark and NOT
    // flat - it is a tunnel bore lit by hard local strips, so it has plenty of
    // separation - and the two terms compound: the frame's median encoded luma
    // is 0.09-0.19, which is entirely inside the band where the luminance term
    // runs at full strength, so the low-key multiplier lands on TOP of it rather
    // than replacing it and amt reaches ~0.10 peak to peak.
    //
    // MEASURED, and it is the dominant texture on the two largest surfaces in
    // the level: two captures of the identical hero2 pose 1.5 s apart differ
    // over the tunnel lining with per-pixel high-frequency content at ~1.0x the
    // difference's own standard deviation, i.e. white noise that resamples every
    // frame. The market's equivalent test sits at 0.48 - real motion. In motion
    // this boils; in a still it reads as sandpaper on the concrete.
    //
    // 0.020 / 0.60 keeps a real dither on the vault (the tile gradients and the
    // fog do still need one at this key) and takes it under the material.
    grain: 0.020,
    grainLowKey: 0.60,
    vignette: 0.24,
    bloomThreshold: 0.90,
    bloomKnee: 0.72,
    bloomIntensity: 0.32,
    bloomClamp: 4.00,
    bloomMipFalloff: 0.82,
    bloomRadius: 1.22,
    // No sun exists, so nothing may pretend one does - see settings.sunLensGate.
    streakIntensity: 0.0,
    flareIntensity: 0.0,
    flareAspect: 1.0,
    sunLensGate: 1,
    // The medium is lit by the practicals or it is not lit at all.
    volumePracticals: 1,
    volumePracticalCount: 6,
    volumePracticalGain: 0.40,
    volumeMaxInscatter: 0.40,
    volumeIntensity: 0.22,
    volumeDensity: 0.020,
    volumeHeightFalloff: 0.020,   // a tunnel has no height gradient
    volumeBaseHeight: -4.0,
    volumeAnisotropy: 0.60,
    volumeMaxDist: 60.0,
    // Tiled walls are a periodic comb at distance and the two-tap CA split
    // synthesises fringes on exactly that - the defect the harbor round
    // diagnosed. The spectral sweep cannot.
    chromaticAberration: 0.0018,
    caSpectral: 1,
    sharpenExtGate: 1.0
  };

  // ---- 'bleach' - AMARG boneyard, high noon --------------------------------
  // The brief names the trap: "a flat, white, contrastless frame". Overhead sun
  // on bare tarmac genuinely has that histogram, so the grade cannot fix it by
  // pulling the exposure down - that just makes a dark flat frame. What it can
  // do is make sure the two things the level DOES have survive: the sky, which
  // must roll rather than clip, and the deep shade under the airframes, which
  // is the only real black in the frame and the only place colour separation
  // can live. Hence an early, long highlight roll-off, a high white point, and
  // a sky-blue shadow rotation against a yellow midtone.
  var BLEACH_GRADE = {
    exposureSlope: 0.62,
    exposureMin: 1.40,
    exposureMax: 7.00,
    todBiasFloor: 0.40,
    meterTrim: 1,
    meterTrimLo: 3.00,     // the tarmac sets the stop, not the sky
    meterTrimHi: 11.00,
    meterLumFloor: 0.0012,

    contrast: 1.30,
    pivot: 0.43,
    pivotTrack: 0.85,
    saturation: 0.80,      // bleached: the colour is baked out of everything
    agxSaturation: 1.06,
    scotopic: 0.34,
    // ---- THE SHOULDER: THIS PRESET HAD NO WHITE, AND WHY -------------------
    // The complaint was right and the diagnosis it arrived with was wrong, which
    // is worth writing down because the wrong one is the plausible one.
    //
    // OBSERVED: no clipped pixel anywhere, on any of six published frames, in a
    // high-noon desert built out of 34 polished aluminium airframes. Every
    // specular event flat. blown_white 0.00%, every frame.
    //
    // DIAGNOSED as the pre-AgX roll-off (highlightKnee 2.00 / highlightRange
    // 11.00 - "compresses two stops over mid, asymptotes at eleven"). MEASURED:
    // that roll-off is a 0.07-stop lever at the levels this frame actually
    // contains. Moving it to the prescribed 3.20 / 7.00 changed the signature
    // frame's p99 by 0.3 of one code value and its blown_white by nothing at all
    // (0.0034% both sides, and that 0.0034% is the HUD, not the render). Worse,
    // shortening the range LOWERS the asymptote from 13.0 to 10.2, so on the
    // hottest events in the level - which is precisely the alclad crest the
    // finding wants - the prescription compresses HARDER than what it replaces.
    //
    // The actual limiter is this preset's WHITE POINT, and the histogram says so
    // without ambiguity: the render's luminance falls off smoothly to 241/255
    // and then stops dead - 0.004% of the frame in 240-243 and exactly zero
    // above 244, on every frame. That is not a roll-off and not a plateau, it is
    // a wall, and 241 is where the print shoulder puts a fully exposed pixel
    // when it has been told white lives at 1.30. pfGrade solves its knee so that
    // p == uWhite lands on exactly 1.0; declaring a white 30% above anything the
    // frame can produce therefore reserves the top 14 code values for a value
    // that does not exist. The comment on that curve in FRAG_COMPOSITE already
    // names this exact failure - "no frame in the game contained a white, and a
    // frame with no white has no snap" - which is the bug it was written to fix,
    // reintroduced here as a number.
    //
    // So: 1.08 declares a white the frame can nearly reach, which puts the peak
    // alclad crest at ~250 instead of 241 and hands the whole top zone above
    // p = 0.82 more separation rather than less. There is still a real shoulder
    // under it (the solved knee is 1.71, not 0), so the sky gradient this preset
    // exists to protect is still rolled and still cannot clip - MEASURED below.
    //
    // The knee moves to 3.20 as asked, but with a range of 9.80 rather than
    // 7.00, which holds the asymptote at the shipped 13.0. That pair dominates
    // the shipped curve at every input - compression starts a stop later and
    // ends no lower - so it is strictly more highlight everywhere and still
    // asymptotes far below AgX's own +4.03 EV (16.3 linear) per-channel clamp,
    // which is the thing the roll-off is actually there to prevent.
    //
    // NOT FIXED HERE, and reported as such: the finding also asks for 0.3-0.8%
    // of the frame at clip. That is not deliverable from a grade. The brightest
    // render pixel in the signature frame arrives at the print shoulder at
    // p = 1.041, and even the shader's hard floor of whitePoint 1.02 would clip
    // only ~0.03% of it. The remaining gap is highlight ENERGY - specular
    // response on the alclad, or a stop of exposure - and neither is in this
    // file.
    whitePoint: 1.08,
    highlightKnee: 3.20,
    highlightRange: 9.80,
    printerBlack: 0.0135,
    toeBlackScale: 1.06,
    toeFloorScale: 1.15,
    shadowChroma: new THREE.Color(0.86, 0.96, 1.14),
    shadowChromaAmount: 0.36,
    shadowTint: new THREE.Color(0.895, 0.985, 1.085),
    midTint: new THREE.Color(1.055, 1.020, 0.905),   // the yellow in the midtones
    highTint: new THREE.Color(1.045, 1.020, 0.955),  // bleached: warm-NEUTRAL
    shadowSat: 0.66,
    shadowAmount: 0.88,
    midAmount: 0.46,
    highAmount: 0.55,
    gain: new THREE.Vector3(1.015, 1.005, 0.985),
    grain: 0.026,
    grainLowKey: 0.40,
    vignette: 0.20,
    // A tight, restrained pyramid. Wide bloom at noon is haze, and haze is the
    // flat frame this preset exists to avoid.
    bloomThreshold: 1.35,
    bloomKnee: 0.95,
    bloomIntensity: 0.22,
    bloomClamp: 8.00,
    bloomMipFalloff: 0.74,
    bloomRadius: 1.05,
    streakIntensity: 0.018,
    streakSpread: 1.8,
    streakTint: new THREE.Color(1.0, 0.90, 0.72),
    flareIntensity: 0.026,
    flareAspect: 1.0,
    // Thin, high, strongly forward-scattering: heat shimmer and dust over a
    // very long sightline, not ground fog.
    volumeIntensity: 0.20,
    volumeDensity: 0.014,
    volumeHeightFalloff: 0.14,
    volumeBaseHeight: -1.0,
    volumeAnisotropy: 0.70,
    volumeMaxDist: 130.0,

    // ---- the heat layer: the only preset in the table that has one ----------
    // The shimmer itself is the LEVEL's statement - it runs at all only because
    // boneyard publishes level.heatShimmer - but the PHYSICS of a noon layer
    // over hardstanding belongs to the look, and this is the only look in the
    // roster that has one. Three numbers, all measured:
    //
    //   heatAmount 0.022   7.6 px of vertical boil at 720p against the shipped
    //     3.1, which a frame difference could barely separate from TAA jitter.
    //   heatCellFloor 0.55   the level names four hot discs of r 26-40 m on a
    //     204 x 168 m slab, so three quarters of the tarmac was perfectly still
    //     - four puddles, not a hot day. The discs now read as the hottest part
    //     of a slab that is hot everywhere, which is what they describe.
    //   heatPale 0.55 / heatLift 2.20   the INFERIOR MIRAGE. Displacement alone
    //     is not what the eye reads as heat: a real mirage over hot alclad and
    //     tarmac lifts the far ground toward sky radiance, takes the chroma out
    //     of it, and dissolves the undercarriage of everything standing on it.
    //     See the pale block in FRAG_COMPOSITE's main().
    //   heatSkyWarm 0.55   the mirage warmed off the atmosphere's literal blue
    //     and toward the key. Measured, twice: see the block in _render.
    heatAmount: 0.022,
    heatCellFloor: 0.55,
    heatPale: 0.55,
    heatLift: 2.20,
    heatSkyWarm: 0.55
  };

  // ---- 'alarm' - Facility K-17. INTERIOR -----------------------------------
  // Same no-sky metering problem as the metro and the same three answers; see
  // GREEN_GRADE for the reasoning, which is not repeated.
  //
  // The colour problem is different and specific: "near-monochrome concrete
  // with saturated red alarm accents surviving the grade. Red must stay red,
  // not go orange." Three things would each break that on their own:
  //
  //   * a global `saturation` low enough to make concrete read as concrete
  //     takes the beacons down with it. So the desaturation is applied over the
  //     MID and SHADOW masks only (midSat/shadowSat) and the global term stays
  //     high. The beacons are emitters, so they sit in the highlight mask and
  //     are not touched by either.
  //   * AgX desaturates bright values toward white per channel, so a hot red
  //     core arrives at the curve as three clipped channels and prints pink-
  //     white. The highlight roll-off ahead of it is set LOW (1.30) so the core
  //     is compressed to a gradient below AgX's clamp instead, and agxSaturation
  //     is raised to give back what the curve still takes.
  //   * a warm highlight leg drags red toward ORANGE if it lifts green. This
  //     one lifts RED and cuts green (1.075, 0.975, 0.945), i.e. it pushes a
  //     red further into red, and it still leaves grade_split strongly positive
  //     because R - B is +0.13 at the top against a cool leg at the bottom.
  //
  // scotopic is deliberately LOW rather than high: the Purkinje term takes
  // chroma out of dark pixels, and a red beacon seen down a long dark corridor
  // is exactly a dark red pixel.
  var ALARM_GRADE = {
    exposureRefAvg: 0.021,
    exposureRefGain: 3.30,
    exposureSlope: 0.36,
    exposureMin: 1.85,
    exposureMax: 5.80,
    todBiasFloor: 1.0,
    adaptUp: 1.70,
    adaptDown: 0.80,
    meterTrim: 1,
    meterTrimLo: 1.90,
    meterTrimHi: 8.00,
    meterLumFloor: 0.0030,

    contrast: 1.30,
    pivot: 0.35,
    pivotTrack: 1.0,
    saturation: 0.92,       // NOT low - see above
    midSat: 0.40,           // the concrete goes near-monochrome
    shadowSat: 0.34,        // ...and so does the dark between the lights
    agxSaturation: 1.24,    // ...and what survives to the top comes back hard
    scotopic: 0.30,
    whitePoint: 1.04,
    highlightKnee: 1.30,
    highlightRange: 8.50,
    printerBlack: 0.0120,
    toeBlackScale: 1.02,
    toeFloorScale: 1.22,
    // Barely cool. Concrete under emergency light is grey with a hint of blue,
    // not navy, and a strong rotation here would fight the red accents for the
    // frame's only chroma budget.
    shadowChroma: new THREE.Color(0.94, 0.99, 1.06),
    shadowChromaAmount: 0.30,
    shadowTint: new THREE.Color(0.955, 0.995, 1.045),
    midTint: new THREE.Color(1.000, 0.995, 1.000),
    highTint: new THREE.Color(1.075, 0.975, 0.945),
    shadowAmount: 0.90,
    midAmount: 0.18,
    highAmount: 0.52,
    gain: new THREE.Vector3(1.010, 0.998, 0.998),
    grain: 0.038,
    grainLowKey: 1.70,
    vignette: 0.28,         // claustrophobic, and the corners have signal to spare
    bloomThreshold: 0.85,
    bloomKnee: 0.70,
    bloomIntensity: 0.34,
    bloomClamp: 3.60,       // a beacon halo, never a white disc
    bloomMipFalloff: 0.84,
    bloomRadius: 1.26,
    streakIntensity: 0.0,
    flareIntensity: 0.0,
    flareAspect: 1.0,
    sunLensGate: 1,
    volumePracticals: 1,
    volumePracticalCount: 6,
    volumePracticalGain: 0.55,   // dust in the beams is named in the brief
    volumeMaxInscatter: 0.42,
    volumeIntensity: 0.24,
    volumeDensity: 0.026,
    volumeHeightFalloff: 0.018,
    volumeBaseHeight: -4.0,
    volumeAnisotropy: 0.66,
    volumeMaxDist: 55.0,
    chromaticAberration: 0.0018,
    caSpectral: 1,
    sharpenExtGate: 1.0
  };

  // ---- 'verdant' - Mekong Delta --------------------------------------------
  // "Saturated green must not become a flat green wash - it needs value range
  // and warm/cool separation." Both halves of that are grade work and both are
  // done here explicitly:
  //
  //   VALUE RANGE comes from contrast about a tracking pivot plus a shadow leg
  //   that gives up a third of its chroma. A canopy is a green thing lit by
  //   green-filtered light in front of green shade; if the shade holds the same
  //   saturation as the canopy there is no separation to see, whatever the
  //   luminance does.
  //   WARM/COOL comes from the strongest highlight leg of any daylight preset
  //   (the shafts) against a cool blue-green rotation (the shade). The mid leg
  //   carries the canopy's own green so the frame still reads green overall.
  //
  // Saturation is the highest in the roster but deliberately stops short of
  // analyze.py's oversaturation flag: 0.96 global x 1.20 post-AgX, against the
  // market's 0.93 x 1.12.
  var VERDANT_GRADE = {
    exposureSlope: 0.72,     // dappled light: real local adaptation is wanted
    exposureMin: 1.20,
    exposureMax: 9.00,
    todBiasFloor: 0.46,
    meterTrim: 1,
    meterTrimLo: 2.80,       // sun through a canopy gap must not set the stop
    meterTrimHi: 10.00,
    meterLumFloor: 0.0012,

    contrast: 1.32,
    pivot: 0.39,
    pivotTrack: 0.92,
    saturation: 0.96,
    agxSaturation: 1.20,
    scotopic: 0.30,
    whitePoint: 1.10,
    highlightKnee: 2.20,
    highlightRange: 7.00,
    printerBlack: 0.0130,
    toeBlackScale: 1.10,
    toeFloorScale: 1.30,     // wet shade under a canopy still holds detail
    shadowChroma: new THREE.Color(0.74, 1.00, 1.12),
    shadowChromaAmount: 0.44,
    shadowTint: new THREE.Color(0.885, 1.000, 1.080),
    midTint: new THREE.Color(0.960, 1.045, 0.960),
    highTint: new THREE.Color(1.095, 1.010, 0.865),
    shadowSat: 0.66,
    shadowAmount: 0.92,
    midAmount: 0.42,
    highAmount: 0.66,
    gain: new THREE.Vector3(1.000, 1.008, 0.996),
    grain: 0.030,
    grainLowKey: 1.00,
    vignette: 0.24,
    bloomThreshold: 1.10,
    bloomKnee: 0.82,
    bloomIntensity: 0.28,
    bloomClamp: 6.00,
    bloomMipFalloff: 0.82,
    bloomRadius: 1.20,
    streakIntensity: 0.014,
    streakTint: new THREE.Color(1.0, 0.94, 0.68),
    flareIntensity: 0.022,
    flareAspect: 1.0,
    // The thickest, most forward-scattering medium of the daylight presets:
    // humid air between trunks is what makes a canopy shaft visible at all.
    volumeIntensity: 0.30,
    volumeDensity: 0.048,
    volumeHeightFalloff: 0.055,
    volumeBaseHeight: -2.0,
    volumeAnisotropy: 0.76,
    volumeMaxDist: 75.0
  };

  // ---- 'sodium' - Zubair refinery, dusk ------------------------------------
  // The strongest warm/cool split in the roster, as briefed, and the numbers
  // say so: the highlight leg runs R/B at 1.150/0.800 (+0.35 on the split
  // metric before the shadow leg is counted) against a blue-VIOLET rotation at
  // 0.80/1.28. That is roughly three times the market's separation.
  //
  // Blue-violet rather than the harbor's cyan-green, and the difference is one
  // channel: violet needs R to sit ABOVE G, cyan-green needs it below. Getting
  // that backwards is how two night levels end up looking like the same night
  // level, which is the failure this whole table exists to prevent.
  var SODIUM_GRADE = {
    exposureSlope: 0.58,
    exposureMin: 1.60,
    exposureMax: 7.00,
    todBiasFloor: 0.58,     // dusk is low-key on purpose, but not night-dark
    meterTrim: 1,
    meterTrimLo: 2.20,      // the flare stacks are not the subject
    meterTrimHi: 9.00,
    meterLumFloor: 0.0020,

    contrast: 1.32,
    pivot: 0.37,
    pivotTrack: 0.96,
    saturation: 0.98,
    agxSaturation: 1.20,
    scotopic: 0.38,
    whitePoint: 1.08,
    // A flare stack is a genuine emitter and must keep a monotone gradient
    // across its core, so the roll-off starts early and asymptotes wide.
    highlightKnee: 1.70,
    highlightRange: 8.00,
    printerBlack: 0.0125,
    toeBlackScale: 1.10,
    toeFloorScale: 1.28,
    shadowChroma: new THREE.Color(0.80, 0.84, 1.28),
    shadowChromaAmount: 0.62,
    shadowTint: new THREE.Color(0.860, 0.930, 1.135),
    midTint: new THREE.Color(1.020, 0.990, 1.000),
    highTint: new THREE.Color(1.150, 0.995, 0.800),
    shadowSat: 0.60,
    shadowAmount: 0.95,
    midAmount: 0.24,
    highAmount: 0.74,
    gain: new THREE.Vector3(1.015, 1.000, 0.995),
    grain: 0.032,
    grainLowKey: 1.30,
    vignette: 0.22,
    bloomThreshold: 0.95,
    bloomKnee: 0.78,
    bloomIntensity: 0.34,
    bloomClamp: 5.50,
    bloomMipFalloff: 0.86,
    bloomRadius: 1.30,
    // The one preset that keeps a real streak: a low dusk sun on a lattice of
    // steel, plus fire above it, is what an anamorphic flare is FOR.
    streakIntensity: 0.030,
    streakSpread: 2.2,
    streakTint: new THREE.Color(1.0, 0.60, 0.26),
    flareIntensity: 0.020,
    flareAspect: 1.0,
    // Flare stacks and floods light the air as well as the steel.
    volumePracticals: 1,
    volumePracticalCount: 6,
    volumePracticalGain: 0.35,
    volumeMaxInscatter: 0.50,
    volumeIntensity: 0.28,
    volumeDensity: 0.030,
    volumeHeightFalloff: 0.045,
    volumeBaseHeight: -2.0,
    volumeAnisotropy: 0.74,
    volumeMaxDist: 110.0,

    // ---- chromatic aberration ----------------------------------------------
    // A refinery is a LATTICE: handrails, gratings, ladder stringers and pipe
    // runs, all of them periodic combs at range and all of them aliased steel
    // against a dark sky. That is precisely the input the two-tap RGB split
    // cannot survive - the R and B taps land on different rails, so the pass
    // synthesises saturated colours the source never contained. MEASURED on the
    // ADS framing: the left 70 px strip carried 1.07% strongly blue-cyan pixels
    // (peak blue 0.773) against 0.13% in an equivalent mid-frame strip - an 8x
    // radial concentration - in a corner sitting at 0.045 luminance, where the
    // sparkle was the most visible thing in it.
    //
    // Three changes, in order of how much each is worth. caSpectral makes every
    // output channel a convex combination of source samples of that channel, so
    // it is arithmetically incapable of inventing a hue. caLumFloor turns the
    // pass off where there is not enough light for a real fringe to be visible,
    // which is where the sparkle was. And the radial scale comes down a stop
    // from the market's, because this level has far more aliasing edge per pixel
    // than a street of plaster does.
    chromaticAberration: 0.0016,
    caSpectral: 1,
    caLumFloor: 0.09,
    // ...and the same content argues for the sharpen's own comb gate. RCAS's
    // min/max limiter is STRUCTURALLY INERT on a periodic pattern - the 5-tap
    // neighbourhood already spans the comb's full range, so the clamp never
    // binds - which is how a sharpen ends up amplifying the aliasing on a
    // handrail instead of the detail on the pipe behind it. This is the gate the
    // harbor round added for its container ribs, on a level made of ribs.
    sharpenExtGate: 1.0
  };

  // ---- 'dawn' - Bayon ruins ------------------------------------------------
  // "The quietest level in the roster - its power is atmosphere and scale, not
  // intensity." A quiet grade is not a weak one; it is a specific shape, and
  // every term below is chosen so that nothing in the frame SNAPS:
  //
  //   * the lowest contrast of the nine (1.05 against the market's 1.20),
  //   * the highest print black after the blizzard, from a big toe asymptote
  //     plus a real lift - ground mist sits in every shadow and mist has no
  //     black in it,
  //   * a high white point, so the print's shoulder is long and the top of the
  //     range is never quite reached,
  //   * the widest, softest bloom pyramid in the table.
  //
  // The colour is a narrow rose-gold over blue-grey - the smallest separation
  // of the nine, which is the point, but still unambiguously positive.
  var DAWN_GRADE = {
    exposureSlope: 0.66,
    exposureMin: 1.30,
    exposureMax: 7.50,
    todBiasFloor: 0.50,
    meterTrim: 1,
    meterTrimLo: 2.60,
    meterTrimHi: 9.50,
    meterLumFloor: 0.0015,

    contrast: 1.05,
    pivot: 0.44,
    pivotTrack: 0.90,
    saturation: 0.86,
    agxSaturation: 1.04,
    scotopic: 0.34,
    whitePoint: 1.24,
    highlightKnee: 2.80,
    highlightRange: 8.50,
    printerBlack: 0.0055,
    lift: new THREE.Vector3(0.0085, 0.0088, 0.0100),
    toeBlackScale: 1.48,
    toeFloorScale: 1.75,
    // Blue-GREY, not blue: shadowSat is left high so the mist keeps its own
    // faint colour rather than being replaced by the rotation target.
    shadowChroma: new THREE.Color(0.88, 0.97, 1.14),
    shadowChromaAmount: 0.30,
    shadowTint: new THREE.Color(0.925, 0.990, 1.070),
    midTint: new THREE.Color(1.020, 0.998, 0.985),
    // Rose-gold needs G to sit BETWEEN R and B - the same requirement teal has,
    // mirrored. R > G > B with G near neutral is gold; G below B would be pink.
    highTint: new THREE.Color(1.080, 1.002, 0.925),
    shadowSat: 0.74,
    shadowAmount: 0.86,
    midAmount: 0.26,
    highAmount: 0.54,
    gain: new THREE.Vector3(1.010, 1.000, 0.998),
    // ---- grain: under the stone, not on it ---------------------------------
    // MEASURED: at 0.030 / 1.10 over a frame whose mean is 0.248-0.289 the grain
    // was running at the same amplitude as the material's own micro-detail - the
    // 1-px relative gradient of the near stone (0.089) was indistinguishable
    // from the SKY's (0.089), and both of them were grain. That is the exact
    // inversion this level cannot afford: its subject is weathered masonry and
    // its whole claim is surface.
    //
    // Two changes, because the amplitude was only half of it. The shipped
    // luminance roll-off starts at l = 0.25, which on a dawn frame is BELOW the
    // lit stone faces - so the term that is supposed to keep grain out of the
    // light was doing nothing here. grainShadowLo/Hi restate that knee for this
    // preset (see the uGrainShadowHi block in FRAG_COMPOSITE): full strength in
    // the mist and the shadowed galleries below 0.10, a fifth of it on a sunlit
    // face by 0.40. A real emulsion behaves exactly this way and it is the
    // difference between grain that sits under a material and grain that
    // competes with it.
    grain: 0.018,
    grainLowKey: 1.00,
    grainShadowLo: 0.10,
    grainShadowHi: 0.40,
    grainShadowFloor: 0.20,
    vignette: 0.15,
    bloomThreshold: 0.95,
    bloomKnee: 0.80,
    bloomIntensity: 0.32,
    bloomClamp: 5.00,
    bloomMipFalloff: 0.90,   // the widest pyramid in the table: mist
    bloomRadius: 1.34,
    streakIntensity: 0.016,
    streakTint: new THREE.Color(1.0, 0.82, 0.66),
    flareIntensity: 0.024,
    flareAspect: 1.0,
    // ---- the medium: a GROUND MIST, not a haze ------------------------------
    // MEASURED, and the reason both of this level's named features were absent
    // from the frame. At falloff 0.075 over base -1.5 the density at 3 m was
    // 0.85 of ground level and at the tower cornices (20 m) still 0.20: that is
    // a height-uniform haze. Two things follow, and both were visible:
    //
    //   * there is no ground mist. A mist LIFTS value and CRUSHES chroma at
    //     ankle height; a vertical scan down hero3's far wall did the exact
    //     opposite (luminance 0.355 -> 0.223, saturation 0.285 -> 0.397). The
    //     gradient was inverted because the only thing varying with height was
    //     the light, and the medium was flat.
    //   * there are no god rays. A shaft has no brightness of its own - its
    //     entire contrast is the DENSITY GRADIENT it passes through, so a
    //     medium with no gradient prints no beam however many lightShafts the
    //     level publishes. hero1's two inter-tower gaps measured 0.761x and
    //     1.034x the open sky beside them; one of them was DARKER than plain
    //     sky.
    //
    // 0.60 over base 0.0 puts ~4.5x more medium at 0.5 m than at 3 m and takes
    // it to e^-12 by the cornices, which is what makes a prasat rise OUT of the
    // mist instead of standing in a fog box. volumeDensityAbs then carries the
    // optical thickness at eye height back to where it was (the fog-derived
    // path would have clipped 0.13 to its 0.075 ceiling and left the mist
    // THINNER than before the fix - see _render).
    volumeIntensity: 0.34,
    volumeDensity: 0.13,
    volumeDensityAbs: 0.13,
    volumeHeightFalloff: 0.60,
    volumeBaseHeight: 0.0,
    volumeAnisotropy: 0.78,
    volumeMaxDist: 95.0
  };

  // ---- 'sunset' - the golden-hour grade with the CURRENT lens model ---------
  // NOT a look. Every tonal and chromatic field is absent, so this is the warm
  // grade, character for character, restored from the authored default by the
  // same mechanism 'warm' uses. The only difference is the LENS.
  //
  // The two-tap RGB split (r sampled at uv+caDir, b at uv-caDir) is a lens model
  // only where the source is smooth on the scale of the offset. It is kept as the
  // default for one reason and it is stated as such at the top of STORM_GRADE:
  // level 1 is frozen. It is not kept because it is right. On content that is
  // not a street of plaster it does two measurable things:
  //
  //   * on a HARD SILHOUETTE it displaces R and B off opposite sides of an edge
  //     that has no intermediate values, so it prints 2-3 px of red/cyan fringe
  //     rather than dispersion. Meridian Tower's signature frame is a black
  //     lattice of edge-protection posts against a bright city - the most
  //     repeated edge in the image - and hero3's left crop measured a mean
  //     R-B high-pass of 4.9 on its luminance edges, 8.7 mid-frame.
  //   * on an ISOLATED SUB-PIXEL SPECULAR in a dark surround it separates one
  //     sparkle into three single-channel dots. lv_firefight's shaded deck is
  //     covered in red/green/cyan confetti at 41/255 mean luminance and measured
  //     16.3 - the same defect, on the same evidence, that caLumFloor was written
  //     for on the refinery.
  //
  // The spectral sweep answers both: every output channel becomes a convex
  // combination of source samples of that channel (so a hue the source did not
  // contain is arithmetically impossible), the local-contrast gate takes the
  // displacement off hard edges and leaves it on soft gradients - which IS the
  // "roll off with luminance contrast rather than radius alone" this was asked
  // for, already built and already proven on two levels - and caLumFloor turns
  // the pass off where there is not enough light for a real fringe to be seen.
  var SUNSET_GRADE = {
    chromaticAberration: 0.0016,
    caSpectral: 1,
    caLumFloor: 0.10
  };

  // The table itself. 'warm' is the empty overlay, i.e. the authored default
  // restored and nothing put on top of it - which is what makes "reproduce the
  // market exactly" a structural guarantee rather than a set of numbers that
  // have to be kept in sync with the settings block above.
  var GRADE_PRESETS = {
    warm: {},
    sunset: SUNSET_GRADE,
    night: STORM_GRADE,
    cold: COLD_GRADE,
    green: GREEN_GRADE,
    bleach: BLEACH_GRADE,
    alarm: ALARM_GRADE,
    verdant: VERDANT_GRADE,
    sodium: SODIUM_GRADE,
    dawn: DAWN_GRADE
  };

  // Names the two shipped levels and the level ids already use, mapped onto the
  // canonical ten. 'market'/'storm' are the strings this module has always
  // taken and must keep taking; the level ids are here so that a level author
  // who writes grade:'metro' gets the metro grade instead of a silent fallback.
  var GRADE_ALIAS = {
    market: 'warm', 'default': 'warm', golden: 'warm',
    goldenhour: 'sunset', highrise: 'sunset',
    storm: 'night', harbor: 'night',
    snow: 'cold', blizzard: 'cold', snowbound: 'cold',
    metro: 'green', flooded: 'green',
    bleached: 'bleach', desert: 'bleach', boneyard: 'bleach',
    bunker: 'alarm',
    jungle: 'verdant',
    refinery: 'sodium',
    ruins: 'dawn', mist: 'dawn'
  };

  // A LEGACY GRADE REACHED THROUGH THE DECLARATIVE TABLE GETS THE CURRENT LENS.
  //
  // This exists because the preset name cannot discriminate on its own. Meridian
  // Tower's env profile asks for grade:'warm' - the market's own preset, the
  // authored default, the empty overlay - so "gate the CA fix on the preset" and
  // "leave level 1 bit-identical" are the same sentence pulling in opposite
  // directions. The distinction that DOES separate them is the one main.js
  // already draws: market and harbor carry env:null and configure themselves,
  // every level from 3 on is configured from the declarative table. So the rule
  // is stated on that axis instead of on a level id, and it is structural rather
  // than numeric in exactly the way the rest of this file's gates are:
  //
  //   * market never reaches this line at all. applyEnv returns early on
  //     env:null, so setGradePreset is never called on level 1 and its settings
  //     are the authored default it has always been.
  //   * harbor reaches setGradePreset exactly once, from the constructor, with
  //     'storm' - which resolves to 'night', is not in this table, and in any
  //     case arrives with _declarative false because its env is null too.
  //
  // The redirect target is not a different look. 'sunset' has no tonal or
  // chromatic field in it; it is the warm grade with the lens model that four
  // other presets in this table already use. See SUNSET_GRADE.
  var GRADE_MODERN_LENS = {
    warm: 'sunset'
  };

  // Colours and vectors are cloned rather than shared, so a preset table can
  // never be mutated by a later frame writing through settings.
  function cloneGradeValue(v) {
    if (v && v.isColor) return v.clone();
    if (v && v.isVector3) return v.clone();
    return v;
  }

  function snapshotGrade(src) {
    var out = {};
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      out[k] = cloneGradeValue(src[k]);
    }
    return out;
  }

  // Overlay `src` onto `dst`. Character-for-character the loop setGradePreset
  // used to run inline, so the storm applies exactly as it always did.
  function overlayGrade(dst, src) {
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      dst[k] = cloneGradeValue(src[k]);
    }
  }

  /**
   * Select a colour grade by name. Data, not code: a level declares its look in
   * the LEVELS table in main.js and never touches this file.
   *
   * @param {string} name  'warm' (the market, the authored default) | 'sunset'
   *   (the same look, current lens model) | 'night' (the harbor storm) | 'cold' |
   *   'green' | 'bleach' | 'alarm' | 'verdant' | 'sodium' | 'dawn'. Level ids and
   *   the legacy 'market'/'storm' spellings are
   *   accepted as aliases. An unknown name is logged and IGNORED - the grade
   *   already in force stays in force, which for a fresh level is the authored
   *   default, so an unimplemented preset degrades to a look rather than to a
   *   black screen.
   */
  PostFX.prototype.setGradePreset = function (name) {
    try {
      var key = (typeof name === 'string' ? name : '').trim().toLowerCase();
      if (GRADE_ALIAS[key]) key = GRADE_ALIAS[key];
      // ...and a legacy grade asked for by a DECLARATIVE level gets the current
      // lens model. Unreachable on both frozen levels by construction - see
      // GRADE_MODERN_LENS, which is where the argument is.
      if (this._declarative && GRADE_MODERN_LENS[key]) key = GRADE_MODERN_LENS[key];
      var table = Object.prototype.hasOwnProperty.call(GRADE_PRESETS, key)
        ? GRADE_PRESETS[key] : null;
      if (!table) {
        GAME.logError('postfx.setGradePreset',
          'unknown grade preset "' + name + '" - keeping "' + this.gradePreset + '"');
        return this;
      }

      var s = this.settings;
      // Back to the authored default first. A preset is a complete look, so
      // applying one must not depend on which one ran before it. On the harbor
      // this is the identity: setGradePreset('storm') is called once, from the
      // constructor, at the exact moment settings still equals the snapshot.
      if (this._gradeBase) overlayGrade(s, this._gradeBase);

      // The grade's key normalisation is an ABSOLUTE reference - "how low-key is
      // this frame against a noon one" - while the metering reference is a
      // per-level calibration. They are multiplied into the same uKeyRef, so
      // re-pivoting the meter onto a night average would otherwise tell pfGrade
      // that a storm night is a noon frame and hand it the noon toe, which is a
      // shelf that would crush three quarters of that level. Solving the scale
      // back out holds uKeyRef at exactly the value it has in the market, for
      // every preset, whatever it does to the meter.
      var keyRef = s.exposureRefGain * s.exposureRefAvg * s.gradeKeyRefScale;
      overlayGrade(s, table);
      s.gradeKeyRefScale = keyRef / Math.max(s.exposureRefGain * s.exposureRefAvg, 1e-6);

      // The preset owns the resting bias; setExposureBias trims it in stops on
      // top. Re-applied here so the two can be called in either order.
      this._exposureBiasBase = s.exposureBias;
      this._applyExposureStops();
      this.gradePreset = key;

      // streakTint is the one grade value pushed into its material at BUILD
      // time rather than per frame, so a preset applied afterwards would
      // silently drop it - and every preset except the harbor's is applied
      // afterwards, because main.js runs env profiles after the build pass.
      // this.mat does not exist yet when the constructor applies the storm, so
      // this block is skipped there and level 2 cannot move.
      if (this.mat && this.mat.streak && s.streakTint) {
        this.mat.streak.uniforms.uTint.value.set(
          s.streakTint.r, s.streakTint.g, s.streakTint.b);
      }

      // _bloomNorm is derived from bloomMipFalloff at allocation time.
      if (this._targets) this._allocate(this._size.x | 0, this._size.y | 0);
    } catch (e) {
      GAME.logError('postfx.setGradePreset', e);
    }
    return this;
  };

  // The names setGradePreset will accept. Exposed so a level or a tool can
  // check a profile without guessing.
  PostFX.prototype.gradePresetNames = function () {
    var out = [];
    for (var k in GRADE_PRESETS) {
      if (Object.prototype.hasOwnProperty.call(GRADE_PRESETS, k)) out.push(k);
    }
    return out;
  };

  // --------------------------------------------------------------------------
  // Exposure trim, in STOPS.
  //
  // settings.exposureBias is a linear multiplier on the PRINT gain - it is
  // applied to the metered result, downstream of the adaptation loop in
  // FRAG_EXPOSURE, in all four places that consume the gain (the AO resolve's
  // exposure-relative thresholds, the viewmodel lock, the grade's key
  // normalisation and the composite itself). That placement is what makes this
  // safe to drive from a level profile: the meter's own state, its target, its
  // clamps and its time constants are untouched, so the adaptation cannot be
  // destabilised, cannot oscillate, and cannot be walked outside its window by
  // a trim. It shifts the print, exactly as a camera's exposure compensation
  // dial does, and the metering keeps doing its own job underneath.
  //
  // It DOES move the grade's key (uKeyRef normalisation reads the same bias),
  // and that is correct rather than incidental: a print carried up a stop IS a
  // higher-key print, and the tonal masks, the S-curve pivot, the toe and the
  // grain all have to follow it or a +1 stop trim would land the frame in a
  // grade authored for a darker one.
  //
  // @param {number} stops  -1..+1 in normal use; clamped to +-2, because a trim
  //   larger than that is a metering calibration and belongs in a preset.
  //   A non-finite value is treated as 0 rather than poisoning every gain in
  //   the chain with a NaN.
  // --------------------------------------------------------------------------
  PostFX.prototype.setExposureBias = function (stops) {
    var n = (typeof stops === 'number' && isFinite(stops)) ? stops : 0;
    this._exposureStops = M.clamp(n, -2, 2);
    try { this._applyExposureStops(); }
    catch (e) { GAME.logError('postfx.setExposureBias', e); }
    return this;
  };

  PostFX.prototype._applyExposureStops = function () {
    var base = this._exposureBiasBase;
    if (typeof base !== 'number' || !isFinite(base) || base <= 0) base = 1.0;
    var st = this._exposureStops || 0;
    // pow(2, 0) is exactly 1 and base * 1 is exactly base, so a level that
    // never calls setExposureBias - which is both frozen levels - keeps the
    // authored bias bit-for-bit.
    var v = base * Math.pow(2, st);
    this.settings.exposureBias = (isFinite(v) && v > 0) ? M.clamp(v, 0.05, 20) : base;
  };

  // --------------------------------------------------------------------------
  // Async build: the procedural noise/dirt plates.
  // --------------------------------------------------------------------------
  PostFX.prototype.build = async function () {
    if (!this.enabled) return;
    try {
      var old;
      old = this.blueNoise;
      this.blueNoise = makeBlueNoise(64, this.rng);
      if (old) old.dispose();
      await GAME.yieldFrame();

      old = this.lensDirt;
      this.lensDirt = makeLensDirt(256, 256, this.rng, this._noise);
      if (old) old.dispose();

      // Rebind: the materials were created holding the placeholders.
      this.mat.gtao.uniforms.tBlue.value = this.blueNoise;
      this.mat.volume.uniforms.tBlue.value = this.blueNoise;
      this.mat.composite.uniforms.tDirt.value = this.lensDirt;
      this.mat.gtao.uniforms.uBlueScale.value.set(1 / 64, 1 / 64);
      this.mat.volume.uniforms.uBlueScale.value.set(1 / 64, 1 / 64);
    } catch (e) {
      GAME.logError('postfx.build', e);
    }
  };

  // --------------------------------------------------------------------------
  // Materials
  // --------------------------------------------------------------------------
  function U(v) { return { value: v }; }

  function makeMat(frag, uniforms, blending) {
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      blending: blending === undefined ? THREE.NoBlending : blending
    });
    // The renderer is set to NoToneMapping (we tonemap in the composite), but
    // be explicit: nothing in this chain may be touched by the renderer's own
    // tone curve.
    m.toneMapped = false;
    m.fog = false;
    m.lights = false;
    return m;
  }

  PostFX.prototype._buildMaterials = function () {
    var s = this.settings;
    var m = this.mat = {};

    m.copy = makeMat(FRAG_COPY, { tSrc: U(null) });

    // Only ever dispatched when a level has asked for the depth copy, so on
    // every level that has shipped this program is created but never compiled -
    // three compiles on first use, not on construction.
    m.softDepth = makeMat(FRAG_SOFTDEPTH, {
      tDepth: U(null), uNear: U(0.05), uFar: U(600)
    });

    m.velocity = makeMat(FRAG_VELOCITY, {
      tDepth: U(null),
      uInvViewProj: U(new THREE.Matrix4()),
      uPrevViewProj: U(new THREE.Matrix4())
    });

    m.gtao = makeMat(FRAG_GTAO, {
      tDepth: U(null), tBlue: U(this.blueNoise),
      uNear: U(0.05), uFar: U(600),
      uInvProj: U(new THREE.Matrix4()), uProj: U(new THREE.Matrix4()),
      uTexel: U(new THREE.Vector2()), uRes: U(new THREE.Vector2()),
      uBlueScale: U(new THREE.Vector2(0.5, 0.5)),
      uRadius: U(s.aoRadius), uIntensity: U(s.aoIntensity),
      uFalloff: U(s.aoFalloff),
      uFadeStart: U(s.aoFadeStart), uFadeEnd: U(s.aoFadeEnd),
      uFrame: U(0), uDirs: U(3), uSteps: U(6)
    });

    m.aoBlur = makeMat(FRAG_AO_BLUR, {
      tAO: U(null), uStep: U(new THREE.Vector2()), uDepthSigma: U(6.0)
    });

    m.volume = makeMat(FRAG_VOLUME, {
      tDepth: U(null), tBlue: U(this.blueNoise),
      uShadowMap: U([this.whiteTex, this.whiteTex, this.whiteTex, this.whiteTex]),
      uShadowMatrix: U([new THREE.Matrix4(), new THREE.Matrix4(),
                        new THREE.Matrix4(), new THREE.Matrix4()]),
      uShadowCount: U(0),
      uShadowBias: U(s.volumeShadowBias),
      uNear: U(0.05), uFar: U(600),
      uInvViewProj: U(new THREE.Matrix4()), uViewProj: U(new THREE.Matrix4()),
      uCamPos: U(new THREE.Vector3()),
      uSunDir: U(DEFAULT_SUN.clone()),
      uSunColor: U(new THREE.Vector3(1.0, 0.78, 0.55)),
      uBlueScale: U(new THREE.Vector2(0.5, 0.5)),
      uDensity: U(s.volumeDensity),
      uHeightFalloff: U(s.volumeHeightFalloff),
      uBaseHeight: U(s.volumeBaseHeight),
      uAnisotropy: U(s.volumeAnisotropy),
      uMaxDist: U(s.volumeMaxDist),
      uFrame: U(0), uTime: U(0),
      uSteps: U(20), uShadowTaps: U(2),
      // Local practicals. uPracCount 0 = the loop never runs; uMaxInscatter is
      // deliberately unreachable off the harbor, so both are exact no-ops.
      uPracPos: U([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
                   new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()]),
      uPracCol: U([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
                   new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()]),
      uPracAxis: U([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
                    new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()]),
      uMaxInscatter: U(1e6),
      uPracCount: U(0)
    });

    m.volBlur = makeMat(FRAG_VOL_BLUR, {
      tSrc: U(null), tDepth: U(null),
      uNear: U(0.05), uFar: U(600),
      uStep: U(new THREE.Vector2())
    });

    m.resolve = makeMat(FRAG_RESOLVE, {
      tScene: U(null), tAO: U(null), tVolume: U(null), tDepth: U(null),
      tExposure: U(null),
      uNear: U(0.05), uFar: U(600),
      uAOTexel: U(new THREE.Vector2()),
      uVolTexel: U(new THREE.Vector2()),
      uAOTint: U(new THREE.Vector3(0.085, 0.115, 0.150)),
      uAOStrength: U(s.aoStrength),
      uAODirectLo: U(s.aoDirectLo), uAODirectHi: U(s.aoDirectHi),
      uAOKeep: U(s.aoKeep), uAOContact: U(s.aoContact),
      uVolumeIntensity: U(s.volumeIntensity),
      uExposureBias: U(s.exposureBias),
      uUseAO: U(1), uUseVolume: U(1)
    });

    // ---- screen-space reflections (harbor only; see FRAG_SSR) --------------
    // Built unconditionally so the material table has a stable shape, but the
    // programs are only ever COMPILED when a pass actually dispatches them -
    // three defers compilation to first use - so the market pays nothing.
    var ssrShared = function () {
      return {
        tDepth: U(null),
        uNear: U(0.05), uFar: U(600),
        uInvProj: U(new THREE.Matrix4()),
        uInvViewProj: U(new THREE.Matrix4()),
        uProj: U(new THREE.Matrix4()),
        uViewToWorld: U(new THREE.Matrix3()),
        uTexelFull: U(new THREE.Vector2()),
        uWetness: U(0), uRainAmt: U(0), uSsrTime: U(0),
        uUpLo: U(s.ssrUpLo), uUpHi: U(s.ssrUpHi),
        uSideAmount: U(s.ssrSideAmount),
        uRoughDry: U(s.ssrRoughDry), uRoughWet: U(s.ssrRoughWet),
        uPuddleScale: U(s.ssrPuddleScale), uRipple: U(s.ssrRipple),
        // Overwritten every frame from ctx.materials.wetContract(); the default
        // is the storm's own resting state so a first frame before materials has
        // published anything still evaluates a sane field rather than a dry one.
        uWetCfg: U(new THREE.Vector4(0.88, 0.80, 1.0, s.ssrRoughWet))
      };
    };

    // materials.js's field, verbatim, in both SSR programs. Resolved once here
    // rather than at module scope so a materials.js that failed to load is
    // reported at build time instead of producing a shader that will not link.
    // Spliced on every level, not just the harbor: the market never dispatches
    // either pass so no program is ever compiled there and no pixel can move,
    // but leaving gbWetSolve undeclared in a string that another code path might
    // one day compile is a link failure waiting to happen.
    var wetSrc = _wetSource();
    var ssrFrag = FRAG_SSR.replace(PF_WET_SLOT, wetSrc);
    var ssrApplyFrag = FRAG_SSR_APPLY.replace(PF_WET_SLOT, wetSrc);

    var sm = ssrShared();
    sm.tScene = U(null);
    sm.tBlue = U(this.blueNoise);
    sm.uBlueScale = U(new THREE.Vector2(0.5, 0.5));
    sm.uEnvSky = U(new THREE.Vector3(0.02, 0.025, 0.035));
    sm.uEnvGround = U(new THREE.Vector3(0.006, 0.008, 0.011));
    sm.uFlashColor = U(new THREE.Vector3(0.86, 0.92, 1.0));
    sm.uFrame = U(0);
    sm.uMaxDist = U(s.ssrMaxDist);
    sm.uMaxViewDist = U(s.ssrMaxViewDist);
    sm.uThickness = U(s.ssrThickness);
    sm.uEdgeFade = U(s.ssrEdgeFade);
    sm.uF0 = U(s.ssrF0);
    sm.uClampRefl = U(s.ssrClamp);
    sm.uEnvWeight = U(s.ssrEnvWeight);
    sm.uFlashAmt = U(0);
    sm.uSteps = U(26);
    sm.uRefine = U(6);
    m.ssr = makeMat(ssrFrag, sm);

    var sa = ssrShared();
    sa.tScene = U(null);
    sa.tSSR = U(null);
    sa.uSSRTexel = U(new THREE.Vector2());
    sa.uBlurScale = U(s.ssrBlur);
    sa.uIntensity = U(s.ssrIntensity);
    sa.uF0 = U(s.ssrF0);
    // Analytic practicals on the water plane. uPracCount 0 = the loop never
    // runs; _collectPracticals fills these in the same sweep it already makes
    // for the volumetric, and returns 0 anywhere but the harbor.
    sa.uPracPos = U([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
                     new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()]);
    sa.uPracCol = U([new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(),
                     new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()]);
    sa.uPracGain = U(0);
    sa.uPracRough = U(s.ssrPracticalRough);
    sa.uPracClamp = U(s.ssrPracticalClamp);
    sa.uPracFloor = U(s.ssrPracticalFloor);
    sa.uPracCount = U(0);
    m.ssrApply = makeMat(ssrApplyFrag, sa);

    m.taa = makeMat(FRAG_TAA, {
      tCurrent: U(null), tHistory: U(null), tVelocity: U(null), tDepth: U(null),
      uTexel: U(new THREE.Vector2()),
      uFeedbackMin: U(s.taaFeedbackMin), uFeedbackMax: U(s.taaFeedbackMax),
      uVarianceGamma: U(s.taaVarianceGamma),
      uHistoryValid: U(0)
    });

    m.sharpen = makeMat(FRAG_SHARPEN, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()), uAmount: U(s.taaSharpen),
      // Both exact no-ops at these values - see FRAG_SHARPEN.
      uKnD: U(1), uExtGate: U(0)
    });

    m.fxaa = makeMat(FRAG_FXAA, { tSrc: U(null), uTexel: U(new THREE.Vector2()) });

    var cocUniforms = function () {
      return {
        tViewDepth: U(null),
        uVNear: U(0.002), uVFar: U(12), uHasView: U(0),
        uFocus: U(12),
        uNearDead: U(s.dofNearDead), uFarDead: U(s.dofFarDead),
        uNearRange: U(s.dofNearRange), uFarRange: U(s.dofFarRange)
      };
    };

    var dp = cocUniforms();
    dp.tSrc = U(null); dp.tDepth = U(null);
    dp.uNear = U(0.05); dp.uFar = U(600);
    dp.uSrcTexel = U(new THREE.Vector2());
    m.dofPrep = makeMat(FRAG_DOF_PREP, dp);

    m.dofBlur = makeMat(FRAG_DOF_BLUR, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()),
      uMaxRadius: U(s.dofMaxRadius), uFrame: U(0), uTaps: U(20)
    });

    var dc = cocUniforms();
    dc.tSrc = U(null); dc.tBlur = U(null); dc.tDepth = U(null);
    dc.uNear = U(0.05); dc.uFar = U(600);
    dc.uBlendLo = U(0.03); dc.uBlendHi = U(0.22);
    m.dofCombine = makeMat(FRAG_DOF_COMBINE, dc);

    m.tileMax = makeMat(FRAG_TILE_MAX, {
      tVel: U(null), uSrcTexel: U(new THREE.Vector2()),
      uScale: U(new THREE.Vector2(16, 1)), uAxis: U(new THREE.Vector2(1, 0))
    });

    m.neighborMax = makeMat(FRAG_NEIGHBOR_MAX, {
      tTile: U(null), uTexel: U(new THREE.Vector2())
    });

    m.motionBlur = makeMat(FRAG_MOTION_BLUR, {
      tSrc: U(null), tVel: U(null), tNeighbor: U(null), tDepth: U(null),
      uNear: U(0.05), uFar: U(600),
      uTexel: U(new THREE.Vector2()), uRes: U(new THREE.Vector2()),
      uStrength: U(s.motionStrength), uMaxPixels: U(s.motionMaxPixels),
      uFrame: U(0), uTaps: U(10)
    });

    m.overlay = makeMat(FRAG_OVERLAY, {
      tWorld: U(null), tView: U(null), tExposure: U(null),
      uViewTexel: U(new THREE.Vector2()),
      uRefExposure: U(s.viewRefGain),
      uViewLock: U(s.viewExposureLock),
      uTodBias: U(1)
    });

    m.bright = makeMat(FRAG_BRIGHT, {
      tSrc: U(null), tExposure: U(null), uTexel: U(new THREE.Vector2()),
      uThreshold: U(s.bloomThreshold), uKnee: U(s.bloomKnee),
      uClamp: U(s.bloomClamp)
    });

    m.downsample = makeMat(FRAG_DOWNSAMPLE, {
      tSrc: U(null), uTexel: U(new THREE.Vector2())
    });

    m.upsample = makeMat(FRAG_UPSAMPLE, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()), uRadius: U(s.bloomRadius),
      uMipWeight: U(s.bloomMipFalloff)
    }, THREE.AdditiveBlending);

    m.streak = makeMat(FRAG_STREAK, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()),
      uDir: U(new THREE.Vector2(1, 0)), uSpread: U(s.streakSpread),
      uTint: U(new THREE.Vector3(1.0, 0.72, 0.42))
    });

    m.lumDown = makeMat(FRAG_LUM_DOWN, {
      tSrc: U(null), tPrevExp: U(null), uSrcTexel: U(new THREE.Vector2()),
      uTrim: U(0), uTrimLo: U(s.meterTrimLo), uTrimHi: U(s.meterTrimHi),
      uLumFloor: U(s.meterLumFloor)
    });

    m.lumReduce = makeMat(FRAG_LUM_REDUCE, {
      tSrc: U(null), uSrcTexel: U(new THREE.Vector2()), uTaps: U(8)
    });

    m.exposure = makeMat(FRAG_EXPOSURE, {
      tLum: U(null), tPrev: U(null),
      uKey: U(s.exposureRefGain * s.exposureRefAvg),
      uAnchor: U(s.exposureRefAvg), uSlope: U(s.exposureSlope),
      uMin: U(s.exposureMin), uMax: U(s.exposureMax),
      uSpeedUp: U(s.adaptUp), uSpeedDown: U(s.adaptDown),
      uHoldScale: U(1),
      uDt: U(1 / 60), uReset: U(1)
    });

    m.composite = makeMat(FRAG_COMPOSITE, {
      tSrc: U(null), tBloom: U(null), tStreak: U(null),
      tDirt: U(this.lensDirt), tExposure: U(null), tLum: U(null),
      uSunUv: U(new THREE.Vector2(0.5, 0.5)),
      uSunTint: U(new THREE.Vector3(1.0, 0.78, 0.55)),
      uAspect: U(1.777),
      uFrame: U(0),
      uExposureBias: U(s.exposureBias),
      uBloom: U(s.bloomIntensity), uStreak: U(s.streakIntensity),
      uDirt: U(s.dirtIntensity), uFlare: U(s.flareIntensity),
      uSunOnScreen: U(0),
      uCA: U(s.chromaticAberration), uDistort: U(s.distortion), uZoom: U(0),
      uVignette: U(s.vignette), uVignetteSoft: U(s.vignetteSoft),
      uGrain: U(s.grain), uGrainSize: U(s.grainSize),
      uAgxSat: U(s.agxSaturation),
      uHiKnee: U(s.highlightKnee), uHiRange: U(s.highlightRange),
      uContrast: U(s.contrast), uPivot: U(s.pivot), uSaturation: U(s.saturation),
      uWhite: U(s.whitePoint), uAds: U(0),
      uScotopic: U(s.scotopic),
      uKeyRef: U(s.exposureRefGain * s.exposureRefAvg), uKeyExp: U(s.gradeKeyExp),
      uGrainLowKey: U(s.grainLowKey),
      uToeBlack: U(s.toeBlackScale), uToeFloor: U(s.toeFloorScale),
      uToeRelax: U(s.toeRelax),
      uDebug: U(0),
      uOffsetY: U(s.printerBlack), uLift: U(s.lift.clone()),
      uShadowChroma: U(new THREE.Vector3(0.86, 0.98, 1.16)),
      uShadowChromaAmt: U(s.shadowChromaAmount),
      uGamma: U(s.gamma.clone()), uGain: U(s.gain.clone()),
      uShadowTint: U(new THREE.Vector3()), uMidTint: U(new THREE.Vector3()),
      uHighTint: U(new THREE.Vector3()),
      uShadowSat: U(s.shadowSat), uMidSat: U(s.midSat),
      uShadowAmt: U(s.shadowAmount), uMidAmt: U(s.midAmount), uHighAmt: U(s.highAmount),
      uFlashTint: U(new THREE.Vector3()), uFlash: U(0), uHit: U(0),
      // Storm additions - all no-ops at these values (see FRAG_COMPOSITE).
      uFlashComp: U(1), uRainLens: U(0), uRainTime: U(0),
      uRainScale: U(s.rainLensScale), uRainDensity: U(s.rainLensDensity),
      uRainStrength: U(s.rainLensStrength), uRainEdge: U(s.rainLensEdge),
      uRainStreak: U(new THREE.Vector2(0, 0)),
      // ...and these five, same rule.
      uCASpectral: U(0), uTexelC: U(new THREE.Vector2(1 / 1280, 1 / 720)),
      uPivotTrack: U(s.pivotTrack), uHighWarmGate: U(s.highWarmGate),
      uFlareAspect: U(s.flareAspect), uKeyFlash: U(1),
      // ...and batch 2. uHeat 0, uCADark 0 and uGrainShadowHi 0 each close their
      // own branch, so none of the samplers or matrices below is ever read on a
      // level that did not ask for them.
      tDepth: U(null), tViewDepthC: U(null), uHasViewC: U(0),
      uInvViewProj: U(new THREE.Matrix4()),
      uCamPos: U(new THREE.Vector3()),
      uHeat: U(0), uHeatY: U(0),
      uHeatH0: U(s.heatHeight), uHeatH1: U(s.heatHeight + s.heatHeightSoft),
      uHeatD0: U(s.heatNear), uHeatD1: U(s.heatFar),
      uHeatScale: U(s.heatScale), uHeatTime: U(0),
      uHeatCount: U(0), uHeatCells: U(makeHeatCellArray()),
      // The mirage half. uHeatPale 0 closes its own block in main(), and
      // uHeatCellFloor 0 is the cells-are-a-hard-mask behaviour the shimmer
      // shipped with.
      uHeatCellFloor: U(0), uHeatPale: U(0), uHeatLift: U(s.heatLift),
      uHeatSky: U(new THREE.Vector3(1, 1, 1)),
      uCADark: U(0),
      uGrainShadowLo: U(s.grainShadowLo), uGrainShadowHi: U(s.grainShadowHi),
      uGrainShadowFloor: U(s.grainShadowFloor)
    });

    var cu = m.composite.uniforms;
    cu.uShadowTint.value.set(s.shadowTint.r, s.shadowTint.g, s.shadowTint.b);
    cu.uMidTint.value.set(s.midTint.r, s.midTint.g, s.midTint.b);
    cu.uHighTint.value.set(s.highTint.r, s.highTint.g, s.highTint.b);
    cu.uShadowChroma.value.set(s.shadowChroma.r, s.shadowChroma.g, s.shadowChroma.b);
    cu.uFlashTint.value.set(s.hitTint.r, s.hitTint.g, s.hitTint.b);
    m.resolve.uniforms.uAOTint.value.set(s.aoTint.r, s.aoTint.g, s.aoTint.b);
    m.streak.uniforms.uTint.value.set(s.streakTint.r, s.streakTint.g, s.streakTint.b);
  };

  // --------------------------------------------------------------------------
  // Render targets
  // --------------------------------------------------------------------------
  function makeRT(w, h, opts) {
    opts = opts || {};
    var rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: opts.nearest ? THREE.NearestFilter : THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RGBAFormat,
      // HDR everywhere: an 8-bit intermediate would band the sky and clip the
      // sun long before the tone curve ever sees it.
      type: THREE.HalfFloatType,
      depthBuffer: !!opts.depth,
      stencilBuffer: false,
      generateMipmaps: false
    });
    // Render targets carry linear data, never sRGB - three would otherwise
    // encode on write and we would tone-map an already-encoded image.
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.generateMipmaps = false;
    return rt;
  }

  function disposeRT(rt) {
    if (!rt) return;
    if (rt.depthTexture) { rt.depthTexture.dispose(); rt.depthTexture = null; }
    rt.dispose();
  }

  PostFX.prototype._allocate = function (w, h) {
    w = Math.max(2, w | 0);
    h = Math.max(2, h | 0);
    this._size.set(w, h);
    this._freeTargets();

    var q = this.q;
    var half = function (v) { return Math.max(1, Math.floor(v / 2)); };

    // ---- main HDR target + depth ------------------------------------------
    this.rtScene = makeRT(w, h, { depth: true });
    var depthTex = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depthTex.format = THREE.DepthFormat;
    depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter;
    depthTex.generateMipmaps = false;
    this.rtScene.depthTexture = depthTex;
    this.hasDepth = true;

    // ---- viewmodel: supersampled, own depth --------------------------------
    var vs = q.viewScale || 1.0;
    var maxTex = 4096;
    try {
      var caps = this.renderer.capabilities;
      if (caps && caps.maxTextureSize) maxTex = caps.maxTextureSize;
    } catch (e) { /* keep the conservative default */ }
    var vw = Math.min(Math.round(w * vs), maxTex);
    var vh = Math.min(Math.round(h * vs), maxTex);
    this.rtView = makeRT(vw, vh, { depth: true });
    // The viewmodel needs a readable depth attachment, not just a renderbuffer:
    // it is the only way the DoF pass can know the weapon sits 0.2-0.9 m from
    // the eye and give it a real circle of confusion. Cleared depth is 1.0, so
    // "no weapon here" is unambiguous.
    var viewDepthTex = new THREE.DepthTexture(vw, vh, THREE.UnsignedIntType);
    viewDepthTex.format = THREE.DepthFormat;
    viewDepthTex.minFilter = viewDepthTex.magFilter = THREE.NearestFilter;
    viewDepthTex.generateMipmaps = false;
    this.rtView.depthTexture = viewDepthTex;
    this._viewSize = new THREE.Vector2(vw, vh);

    // ---- full-res working set ----------------------------------------------
    this.rtVel = makeRT(w, h, { nearest: true });
    this.rtHist = [makeRT(w, h), makeRT(w, h)];
    this.rtFull = [makeRT(w, h), makeRT(w, h)];
    this._histIndex = 0;
    this._ppIndex = 0;
    this._historyValid = false;
    // How many frames of jittered samples the history actually contains. The
    // TAA feedback is clamped to the equal-weight average of that many samples
    // until the history is deep enough to justify the authored maximum.
    this._histFrames = 0;

    // ---- ambient occlusion --------------------------------------------------
    var aw = Math.max(2, Math.round(w * q.ssaoScale));
    var ah = Math.max(2, Math.round(h * q.ssaoScale));
    this.rtAO = makeRT(aw, ah);
    this.rtAOTmp = makeRT(aw, ah);
    this._aoSize = new THREE.Vector2(aw, ah);

    // ---- volumetrics (half res, bilateral-upsampled) ------------------------
    var vwh = half(w), vhh = half(h);
    this.rtVol = makeRT(vwh, vhh);
    this.rtVolTmp = makeRT(vwh, vhh);
    this._volSize = new THREE.Vector2(vwh, vhh);

    // ---- depth of field (half res) ------------------------------------------
    this.rtDofA = makeRT(vwh, vhh);
    this.rtDofB = makeRT(vwh, vhh);

    // ---- soft-particle depth copy (half res, opt-in only) -------------------
    // Not allocated unless a level has asked for it, exactly like the SSR target
    // above: one more surface plus one more fullscreen draw per frame is a real
    // tax, and seven of the ten levels will never want it.
    this.rtSoftDepth = this._softWanted ? makeRT(vwh, vhh, { nearest: true }) : null;

    // ---- screen-space reflections (half res, harbor only) -------------------
    // Not allocated at all on the market: one more full-size HalfFloat surface
    // for a pass that would never run is a straight VRAM tax on level 1.
    this.rtSSR = this._harbor ? makeRT(vwh, vhh) : null;
    this._ssrSize = new THREE.Vector2(vwh, vhh);

    // ---- motion blur tiles ---------------------------------------------------
    var tw = Math.max(1, Math.ceil(w / 16));
    var th = Math.max(1, Math.ceil(h / 16));
    this.rtTileA = makeRT(tw, h, { nearest: true });
    this.rtTileB = makeRT(tw, th, { nearest: true });
    this.rtTileC = makeRT(tw, th);
    this._tileSize = new THREE.Vector2(tw, th);

    // ---- bloom pyramid --------------------------------------------------------
    this.rtBloom = [];
    this._bloomSizes = [];
    var bw = w, bh = h;
    for (var i = 0; i < q.bloomMips; i++) {
      bw = half(bw); bh = half(bh);
      if (bw < 2 || bh < 2) break;
      this.rtBloom.push(makeRT(bw, bh));
      this._bloomSizes.push(new THREE.Vector2(bw, bh));
    }
    if (this.rtBloom.length === 0) {
      this.rtBloom.push(makeRT(2, 2));
      this._bloomSizes.push(new THREE.Vector2(2, 2));
    }

    // ---- sun streak (quarter res) ---------------------------------------------
    var sw = Math.max(2, Math.floor(w / 4)), sh = Math.max(2, Math.floor(h / 4));
    this.rtStreakA = makeRT(sw, sh);
    this.rtStreakB = makeRT(sw, sh);
    this._streakSize = new THREE.Vector2(sw, sh);

    // ---- exposure reduction chain -----------------------------------------------
    this.rtLum0 = makeRT(64, 64);
    this.rtLum1 = makeRT(8, 8);
    this.rtLum2 = makeRT(1, 1);
    this.rtExp = [makeRT(1, 1), makeRT(1, 1)];
    this._expIndex = 0;
    this._exposureResetFrames = 3;

    // With the shaped upsample, mip n reaches mip 0 attenuated by k^n, so the
    // total energy in the pyramid is the geometric series - not (mips + 1).
    // Normalising by the series keeps bloomIntensity independent of both the
    // mip count and the falloff.
    var k = M.clamp(this.settings.bloomMipFalloff, 0.05, 1.0);
    var series = (k >= 0.999)
      ? this.rtBloom.length
      : (1 - Math.pow(k, this.rtBloom.length)) / (1 - k);
    this._bloomNorm = 1 / Math.max(series, 1e-3);

    this._targets = [
      this.rtScene, this.rtView, this.rtVel, this.rtHist[0], this.rtHist[1],
      this.rtFull[0], this.rtFull[1], this.rtAO, this.rtAOTmp,
      this.rtVol, this.rtVolTmp, this.rtDofA, this.rtDofB,
      this.rtTileA, this.rtTileB, this.rtTileC,
      this.rtStreakA, this.rtStreakB,
      this.rtLum0, this.rtLum1, this.rtLum2, this.rtExp[0], this.rtExp[1]
    ].concat(this.rtBloom);
    if (this.rtSSR) this._targets.push(this.rtSSR);
    if (this.rtSoftDepth) this._targets.push(this.rtSoftDepth);

    this._clearAll();
  };

  // A freshly allocated HalfFloat target holds undefined memory, and a single
  // NaN there survives every multiply in the chain. One clear pass at
  // allocation removes an entire class of first-frame artefacts (black TAA
  // history, garbage exposure, stale bloom when the pass is disabled).
  PostFX.prototype._clearAll = function () {
    var r = this.renderer;
    r.getClearColor(_savedClear);
    var a = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (var i = 0; i < this._targets.length; i++) {
      r.setRenderTarget(this._targets[i]);
      r.clear(true, true, false);
    }
    r.setRenderTarget(null);
    r.setClearColor(_savedClear, a);
  };

  PostFX.prototype._freeTargets = function () {
    if (!this._targets) return;
    for (var i = 0; i < this._targets.length; i++) disposeRT(this._targets[i]);
    this._targets = null;
  };

  PostFX.prototype.resize = function (w, h) {
    if (!this.enabled) return;
    try {
      // Trust the drawing buffer, not the CSS size: pixelRatio, capture
      // overrides and DPI changes all land here.
      this.renderer.getDrawingBufferSize(_v2a);
      var tw = _v2a.x | 0, th = _v2a.y | 0;
      if (!tw || !th) { tw = Math.max(2, w | 0); th = Math.max(2, h | 0); }
      if (tw === (this._size.x | 0) && th === (this._size.y | 0)) return;
      this._allocate(tw, th);
    } catch (e) {
      GAME.logError('postfx.resize', e);
    }
  };

  PostFX.prototype.dispose = function () {
    this._freeTargets();
    if (this.mat) {
      for (var k in this.mat) if (this.mat[k]) this.mat[k].dispose();
    }
    if (this.blueNoise) this.blueNoise.dispose();
    if (this.lensDirt) this.lensDirt.dispose();
    if (this.whiteTex) this.whiteTex.dispose();
    if (this._softNoData) { this._softNoData.dispose(); this._softNoData = null; }
    if (this._glowTex) {
      for (var gk in this._glowTex) {
        if (this._glowTex[gk]) this._glowTex[gk].dispose();
      }
      this._glowTex = null;
    }
    this.enabled = false;
  };

  // --------------------------------------------------------------------------
  // Impulses: camera shake + a matching lens response
  // --------------------------------------------------------------------------
  var ONE = new THREE.Vector3(1, 1, 1);

  /**
   * @param {string} kind  'shake' | 'hit' | 'explosion'
   * @param {number} strength  nominally 0..1, clamped to 0..4
   */
  PostFX.prototype.addImpulse = function (kind, strength) {
    if (!this.enabled) return this;
    var s = M.clamp(strength === undefined ? 1 : strength, 0, 4);
    switch (kind) {
      case 'hit':
        this.trauma = Math.min(1, this.trauma + 0.30 * s);
        this.hitPulse = Math.min(1.4, this.hitPulse + 0.62 * s);
        this.lensKick = Math.min(1.6, this.lensKick + 0.34 * s);
        break;
      case 'explosion':
        this.trauma = Math.min(1, this.trauma + 0.80 * s);
        this.flash = Math.min(1.5, this.flash + 0.85 * s);
        this.lensKick = Math.min(2.0, this.lensKick + 1.05 * s);
        break;
      case 'shake':
      default:
        // The per-shot case. Small, and the lens barely moves - a gunshot that
        // wobbles the whole frame reads as cheap.
        this.trauma = Math.min(1, this.trauma + 0.155 * s);
        this.lensKick = Math.min(1.0, this.lensKick + 0.085 * s);
        // ...but a muzzle flash 0.5 m from the lens absolutely does move the
        // sensor. This path never touched `flash`, so the exposure punch in the
        // composite was dead code for gunfire and only ever fired on
        // explosions. Its own accumulator with a much faster decay keeps it a
        // punch rather than a fade.
        this._flashShot = Math.min(0.22, this._flashShot + 0.085 * s);
        break;
    }
    return this;
  };

  /**
   * Lock the lens to a distance, or hand it back to the autofocus.
   *
   * @param {Number|String|null} dist  metres, or 'hyperfocal' for the distance
   *   past which the far leg cannot reach full CoC (1 / dofFarDead - see COC),
   *   or null/0 to release the lock.
   */
  PostFX.prototype.setFocus = function (dist) {
    var d = this._resolveFocus(dist);
    this._focusOverride = d > 0 ? d : null;
    return this;
  };

  // 'hyperfocal' is not a magic number, it is the solution of the far leg: an
  // object at infinity is 1/focus dioptres out, so focusing at 1/dofFarDead puts
  // even infinity exactly on the near edge of the far dead band and nothing in
  // the world defocuses. Clamped to the same window the autofocus uses.
  PostFX.prototype._resolveFocus = function (dist) {
    if (typeof dist === 'number' && isFinite(dist) && dist > 0) {
      return M.clamp(dist, 1.2, 400);
    }
    if (typeof dist === 'string') {
      var k = dist.toLowerCase();
      if (k === 'hyperfocal' || k === 'infinity' || k === 'inf' || k === 'far') {
        return M.clamp(1 / Math.max(this.settings.dofFarDead, 1e-3), 1.2, 400);
      }
    }
    return 0;
  };

  /**
   * Heat shimmer: a gated screen-space refraction through the layer of hot air
   * sitting on a sun-baked slab. See pfHeatShimmer in FRAG_COMPOSITE.
   *
   * DEFAULTS TO OFF, and off means unexecuted - every level built before this
   * existed renders bit-for-bit the frame it rendered before. A level opts in
   * either by publishing `level.heatShimmer` (which update() picks up on its
   * own, so no level file has to know this API exists) or by calling this.
   *
   * @param {{y:Number, strength:Number, mirage:Number, pathNear:Number,
   *          pathFar:Number, cells:Array<{x:Number,z:Number,r:Number}>}|null} cfg
   *   y        the ground plane the convection layer sits on, in world metres.
   *   strength 0..2, scaling settings.heatAmount. THE DISPLACEMENT ONLY - the
   *            boil. Peak vertical displacement is
   *            settings.heatAmount x strength x 0.57 x frameHeight px.
   *   mirage   0..2, scaling settings.heatPale (the inferior mirage - the
   *            lift-and-desaturate half). Defaults to `strength`, which is what
   *            the single coupled scalar used to do; state it to break the
   *            coupling. The peak fraction of a pixel the mirage may replace is
   *            settings.heatPale x mirage, clamped to 1.
   *   pathNear/pathFar  optional, metres of hot air traversed at which the effect
   *            starts and saturates. Defaults to the grade preset's
   *            heatNear/heatFar (12 / 70 unless a preset moves them).
   *   cells    where the slab is hot, as world-space discs (x, z, radius). Up to
   *            HEAT_CELL_MAX of them; omit the field entirely for "everywhere".
   *   null     turns it off and keeps it off - the level scan will not undo it.
   */
  PostFX.prototype.setHeatShimmer = function (cfg) {
    try {
      this._heat = normaliseHeat(cfg);
    } catch (e) {
      GAME.logError('postfx.setHeatShimmer', e);
      this._heat = null;
    }
    this._heatExplicit = true;
    return this;
  };

  // The level's own record, read once, guarded on everything. ctx.level is built
  // four systems after this one and may be missing, half-built or from a level
  // that has never heard of heat - all three degrade to "no shimmer".
  PostFX.prototype._scanHeat = function (ctx) {
    if (this._heatExplicit || this._heatScanned) return;
    if (!ctx || !ctx.level) return;
    this._heatScanned = true;
    try {
      this._heat = normaliseHeat(ctx.level.heatShimmer);
    } catch (e) {
      GAME.logError('postfx.heatShimmer', e);
      this._heat = null;
    }
  };

  // ==========================================================================
  // SOFT PARTICLES AND GLOW CARDS
  //
  // Two capabilities a level file could not express, both OFF until something
  // asks. Neither allocates anything, compiles anything or dispatches anything
  // on a level that does not call in, which is why the two frozen levels are
  // byte-identical with all of this present.
  // ==========================================================================

  function softNum(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  // 1x1 R=0. "No depth data here", which is what the consumer must see before
  // the first copy has been written (and if the copy is unavailable entirely).
  // R=0 is unreachable for real geometry, so it is an unambiguous sentinel.
  function makeSoftNoData() {
    var t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1,
      THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  PostFX.prototype._initSoft = function () {
    if (this._softU) return this._softU;
    this._softNoData = makeSoftNoData();
    // ONE set of uniform objects, shared by reference with every patched
    // material and with anything a level builds by hand. That is what makes this
    // survive a resize: _allocate throws the render target away and makes a new
    // one, and the consumers never see it happen because they are holding the
    // uniform, not the texture.
    this._softU = {
      tPfDepth: U(this._softNoData),
      uPfInvRes: U(new THREE.Vector2(1 / 1280, 1 / 720)),
      uPfNF: U(new THREE.Vector2(0.05, 600))
    };
    this._softWanted = true;
    return this._softU;
  };

  /**
   * The scene's depth, linearised, as something a level's own material can
   * sample - which the raw depth attachment is not (see FRAG_SOFTDEPTH).
   *
   * Returns the three uniform objects postfx keeps current, to be spliced
   * straight into a hand-written ShaderMaterial's `uniforms`:
   *
   *     var d = ctx.postfx.sceneDepthUniforms();
   *     var mat = new THREE.ShaderMaterial({ uniforms: {
   *       tPfDepth: d.tPfDepth, uPfInvRes: d.uPfInvRes, uPfNF: d.uPfNF,
   *       ...my own uniforms
   *     }, ... });
   *
   * tPfDepth   sampler2D, HALF RESOLUTION. R = positive distance along the view
   *            axis in world metres. 0 means "not written yet" - treat it as
   *            "no occluder", never as "occluder at the eye".
   * uPfInvRes  vec2, 1 / (full-res drawing buffer), so the correct fetch is
   *            texture2D(tPfDepth, gl_FragCoord.xy * uPfInvRes).
   * uPfNF      vec2(near, far) of the world camera, for linearising the
   *            fragment's own gl_FragCoord.z.
   *
   * ONE FRAME OF LATENCY, AND WHY IT IS THE RIGHT TRADE. The copy is written
   * immediately after the scene pass, so a material rendering IN that pass reads
   * the previous frame's copy. The alternative - splitting the scene into two
   * renderer.render() calls with the copy between them - costs a second scene
   * traversal, a second shadow-map decision, forces scene.background off for the
   * second pass, and reorders your cards against every other transparent in the
   * level. The error the latency actually produces is a fade edge lagging the
   * camera by one frame, i.e. sub-pixel at any sane turn rate and EXACTLY ZERO
   * on the capture path, where main.js renders a static pose several times.
   * vfx.js reached the same conclusion independently for its particles.
   *
   * Returns null if postfx is disabled, in which case fade against nothing.
   */
  PostFX.prototype.sceneDepthUniforms = function () {
    if (!this.enabled) return null;
    try {
      return this._initSoft();
    } catch (e) {
      GAME.logError('postfx.sceneDepthUniforms', e);
      return null;
    }
  };

  /**
   * The GLSL that goes with the uniforms above, so a hand-written material does
   * not have to re-derive the encoding. Declares tPfDepth / uPfInvRes / uPfNF /
   * uPfSoft and defines `float pfsSoftFade()`; paste it above your main() and
   * multiply by pfsSoftFade() at the end of it. If you use softParticleFade()
   * instead you never need this.
   */
  PostFX.prototype.softParticleGLSL = function () { return SOFT_DECL; };

  /**
   * Make an existing material fade its own contribution out as it approaches
   * whatever the scene has already drawn behind it - the soft-particle path.
   *
   * WHY IT IS HERE. ruins' own source records giving up on exactly this ("There
   * is no depth-fade available here (postfx owns the depth buffer), so the answer
   * is geometric") and maintaining a hand-written keep-out list of every wall,
   * tower and rubble heap instead, which is why its mist kept getting sliced. A
   * keep-out list cannot work: the intersection is a screen-space event and it
   * moves with the camera.
   *
   * The material keeps everything else about itself - its own map, its own
   * blending, its own fog, three's own lighting if it has any. This only
   * multiplies the finished fragment.
   *
   *     ctx.postfx.softParticleFade(mistMat, { fade: 2.5, nearFade: 1.5 });
   *
   * @param {THREE.Material} material  patched in place and returned.
   * @param {Object} opts
   *   fade      metres over which the card fades to nothing as the scene surface
   *             behind it approaches. 0.05..60, default 1.5. Set it to roughly
   *             the card's own thickness in the world; a 6 m mist slab wants
   *             2-3 m, a 0.4 m dust puff wants 0.3.
   *   nearFade  metres in front of the EYE over which the card also fades in.
   *             0..40, default 0 (off). This is what stops a card the player
   *             walks into from filling the frame; 1-2 m is usual.
   *   mode      'auto' (default) | 'rgb' | 'alpha' | 'both'. 'auto' picks 'rgb'
   *             for an additive/custom-blended material and 'alpha' otherwise,
   *             which is the right answer in every case seen so far. 'rgb' on a
   *             normally-blended material darkens instead of fading; 'alpha' on
   *             an additive one does nothing at all, because additive ignores it.
   *   enabled   false to patch but start switched off (default true).
   *
   * RULES. The card must not write depth (`depthWrite: false`) or it occludes
   * itself; it must not cast shadows (`mesh.castShadow = false`) or the shadow
   * pass draws a solid rectangle; and it must live in ctx.scene, not in
   * ctx.viewScene - the viewmodel is rendered into a supersampled target with a
   * different gl_FragCoord scale, so the fetch would be wrong there.
   *
   * `transparent` is forced true, because a fade that the sorter has put in the
   * opaque bucket is not a fade.
   *
   * Runtime retune: material.userData.pfSoftParams is the vec3
   * (1/fade, nearFade, enabled); write to it whenever you like.
   */
  PostFX.prototype.softParticleFade = function (material, opts) {
    if (!material || !material.isMaterial) return material;
    try {
      var u = this._initSoft();
      if (!u) return material;
      var o = opts || {};
      var fade = M.clamp(softNum(o.fade, 1.5), 0.05, 60);
      var near = M.clamp(softNum(o.nearFade, 0), 0, 40);
      var mode = o.mode || 'auto';
      if (mode === 'auto') {
        mode = (material.blending === THREE.AdditiveBlending ||
                material.blending === THREE.CustomBlending) ? 'rgb' : 'alpha';
      }
      var apply = (mode === 'rgb') ? 'gl_FragColor.rgb *= pfsF;'
        : (mode === 'both') ? 'gl_FragColor *= pfsF;'
        : 'gl_FragColor.a *= pfsF;';

      var params = new THREE.Vector3(1 / fade, near, o.enabled === false ? 0 : 1);
      material.userData = material.userData || {};
      material.userData.pfSoftParams = params;
      material.transparent = true;

      var pu = U(params);
      material.onBeforeCompile = function (shader) {
        // The shared objects go in BY REFERENCE - three copies the uniforms
        // object it is handed into the program's own map by reference for
        // non-array uniforms, so postfx updating .value here is seen there.
        shader.uniforms.tPfDepth = u.tPfDepth;
        shader.uniforms.uPfInvRes = u.uPfInvRes;
        shader.uniforms.uPfNF = u.uPfNF;
        shader.uniforms.uPfSoft = pu;
        var f = shader.fragmentShader;
        // Anchors, in the order three's own chunk list puts them, so the first
        // one found is always the LAST statement of main(). Checked against the
        // r180 chunk table in vendor/three.global.js: mesh materials carry
        // dithering, points carries premultiplied_alpha, sprite carries neither
        // but does carry fog - so all three families patch. The fourth case is a
        // structural fallback: main() is the final function in every three
        // fragment shader, so its closing brace is the last one in the string.
        //
        // All four sites are DOWNSTREAM of <colorspace_fragment>, which is exact
        // here because every target in this chain is NoColorSpace - the encode is
        // the identity, so a scalar multiply after it is the same scalar multiply
        // before it. A material used to draw straight to the default framebuffer
        // would fade in the encoded domain instead, which is a slightly different
        // curve and never a wrong one.
        var anchors = ['#include <dithering_fragment>',
                       '#include <premultiplied_alpha_fragment>',
                       '#include <fog_fragment>'];
        var tail = '\n  { float pfsF = pfsSoftFade();\n    ' + apply + ' }\n';
        var done = false, i, at;
        for (i = 0; i < anchors.length; i++) {
          at = f.indexOf(anchors[i]);
          if (at < 0) continue;
          f = f.slice(0, at + anchors[i].length) + tail +
              f.slice(at + anchors[i].length);
          done = true;
          break;
        }
        if (!done) {
          at = f.lastIndexOf('}');
          if (at < 0) return;                 // not a shader we can patch
          f = f.slice(0, at) + tail + f.slice(at);
        }
        shader.fragmentShader = SOFT_DECL + '\n' + f;
      };
      // Without this two materials that differ ONLY in their onBeforeCompile
      // share a compiled program, and whichever compiled first wins.
      material.customProgramCacheKey = function () { return 'pfSoft:' + mode; };
      material.needsUpdate = true;
    } catch (e) {
      GAME.logError('postfx.softParticleFade', e);
    }
    return material;
  };

  /**
   * The radial glow profile a card needs in order to bloom into a round source
   * instead of printing as a rectangle. See makeGlowProfile for the measurement
   * and for why no amount of bloom can do this from the post side.
   *
   * Cached by shape, so a hundred lamp cards cost one texture.
   *
   * @param {Object} opts
   *   size     texture edge in px. 32..512, default 128.
   *   falloff  profile exponent. The linear profile is
   *            ((1 - r) / (1 - core)) ^ falloff with r = 1 at the quad's edge, so
   *            it reaches exactly zero there and the quad boundary can never be
   *            seen. 0.5..8, default 2.6.
   *   core     radius of the flat hot centre, as a fraction of the half-width.
   *            0..0.6, default 0.06. Raise it for a source with a visible disc
   *            (a floodlight lens); leave it low for an unresolved point.
   * @returns {THREE.DataTexture}
   */
  PostFX.prototype.glowTexture = function (opts) {
    var o = opts || {};
    var size = Math.round(M.clamp(softNum(o.size, 128), 32, 512));
    var falloff = M.clamp(softNum(o.falloff, 2.6), 0.5, 8);
    var core = M.clamp(softNum(o.core, 0.06), 0, 0.6);
    var key = size + '|' + falloff.toFixed(3) + '|' + core.toFixed(3);
    if (!this._glowTex) this._glowTex = {};
    if (this._glowTex[key]) return this._glowTex[key];
    var t = null;
    try {
      t = makeGlowProfile(size, falloff, core);
      this._glowTex[key] = t;
    } catch (e) {
      GAME.logError('postfx.glowTexture', e);
    }
    return t;
  };

  /**
   * A ready-made emissive light card: the glow profile above, on additive
   * blending, at an HDR radiance that clears the bloom threshold.
   *
   * Put it on a plane facing the camera (a quad, or a THREE.Sprite's material)
   * for a distant lamp, a flare-stack glow, a window at night, a beacon.
   *
   *     var m = ctx.postfx.glowCardMaterial({ color: 0xffb060, intensity: 9 });
   *     var card = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), m);
   *     card.castShadow = false;
   *
   * @param {Object} opts
   *   color      hex or THREE.Color, interpreted as sRGB. Default 0xffffff.
   *   intensity  LINEAR multiplier on that colour, i.e. the card's peak radiance
   *              in the same units the rest of the scene is lit in. 0..400,
   *              default 6.0. The bloom's own threshold is 0.85-1.35 exposed
   *              depending on the grade preset, so 3 is a source that just
   *              blooms, 6-12 is a lamp, 30+ is a flare. Above ~2 the CORE
   *              clips and the printed disc's radius is set by where the profile
   *              crosses the white point - which is the entire point: that
   *              radius is a smooth function of intensity, so the same card
   *              reads as a brighter light rather than as a bigger rectangle.
   *   blending   'additive' (default) or 'alpha'. Additive is CustomBlending
   *              (One, One) rather than THREE.AdditiveBlending deliberately:
   *              AdditiveBlending multiplies by source alpha, which would square
   *              the profile and silently double the exponent you asked for.
   *   size / falloff / core   forwarded to glowTexture().
   *   fog        default true - a distant light card that ignores aerial
   *              perspective sits in front of the haze instead of in it.
   *   depthTest  default true.
   *   side       default THREE.DoubleSide (ignored when sprite is true).
   *   sprite     true returns a THREE.SpriteMaterial instead, for
   *              `new THREE.Sprite(mat)`: always faces the camera and attenuates
   *              with distance, which is what an unresolved distant lamp is. Use
   *              it for a point source; use the mesh form when the glow has an
   *              orientation (a window, a strip, a flare plume).
   *   softFade   metres; if > 0 the card is also depth-faded via
   *              softParticleFade(), which is what a glow inside a volume wants.
   *   nearFade   metres, passed to softParticleFade.
   * @returns {THREE.MeshBasicMaterial|THREE.SpriteMaterial}
   */
  PostFX.prototype.glowCardMaterial = function (opts) {
    var o = opts || {};
    var mat = null;
    try {
      var tex = this.glowTexture(o);
      var col = (o.color && o.color.isColor) ? o.color.clone()
        : new THREE.Color(o.color === undefined ? 0xffffff : o.color);
      col.multiplyScalar(M.clamp(softNum(o.intensity, 6), 0, 400));
      var additive = o.blending !== 'alpha';
      mat = o.sprite ? new THREE.SpriteMaterial({
        map: tex || null,
        color: col,
        transparent: true,
        depthWrite: false,
        depthTest: o.depthTest === false ? false : true,
        sizeAttenuation: true,
        fog: o.fog === false ? false : true
      }) : new THREE.MeshBasicMaterial({
        map: tex || null,
        color: col,
        transparent: true,
        depthWrite: false,
        depthTest: o.depthTest === false ? false : true,
        side: o.side === undefined ? THREE.DoubleSide : o.side,
        fog: o.fog === false ? false : true
      });
      // postfx owns the tone curve; nothing may be mapped on the way in.
      mat.toneMapped = false;
      if (additive) {
        mat.blending = THREE.CustomBlending;
        mat.blendSrc = THREE.OneFactor;
        mat.blendDst = THREE.OneFactor;
        mat.blendEquation = THREE.AddEquation;
      }
      var sf = softNum(o.softFade, 0);
      if (sf > 0) {
        this.softParticleFade(mat, {
          fade: sf, nearFade: o.nearFade,
          mode: additive ? 'rgb' : 'alpha'
        });
      }
    } catch (e) {
      GAME.logError('postfx.glowCardMaterial', e);
    }
    return mat;
  };


  /**
   * The focus distance the framing being captured asks for, or 0.
   *
   * WHY THIS EXISTS. The autofocus raycasts the crosshair and falls back to a
   * 12 m gameplay focus when the ray misses - which on an establishing shot
   * standing 30 m up over a 330 m site is the difference between a photograph
   * and a tilt-shift model railway, and a level had no way to say otherwise: the
   * only lever was to move the aim point until the ray happened to hit
   * something. A pose may now state its own focus:
   *
   *     cameraPoses.overview = { position, yaw, pitch, focus: 'hyperfocal' }
   *     cameraPoses.hero2    = { position, yaw, pitch, focus: 6.5 }
   *
   * Matched by POSITION rather than by name because the pose key is not
   * published anywhere this module can read (scenarios.js and main.js are both
   * integration-owned), and during a capture the camera is placed exactly on the
   * pose and frozen there - so the position IS the identifier. Capture only:
   * during play the player is not standing on an authored mark and the
   * autofocus is the correct behaviour.
   */
  PostFX.prototype._poseFocus = function (ctx) {
    if (!ctx || !ctx.capture) return 0;
    var lv = ctx.level, cam = ctx.camera;
    if (!lv || !cam || !lv.cameraPoses) return 0;
    var best = 0, bestD2 = 0.25 * 0.25;   // 25 cm of slop; poses are metres apart
    try {
      var poses = lv.cameraPoses;
      for (var k in poses) {
        if (!Object.prototype.hasOwnProperty.call(poses, k)) continue;
        var p = poses[k];
        if (!p || !p.position || p.focus === undefined || p.focus === null) continue;
        var dx = p.position.x - cam.position.x;
        var dy = p.position.y - cam.position.y;
        var dz = p.position.z - cam.position.z;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > bestD2) continue;
        var f = this._resolveFocus(p.focus);
        if (f > 0) { bestD2 = d2; best = f; }
      }
    } catch (e) {
      GAME.logError('postfx.poseFocus', e);
      return 0;
    }
    return best;
  };

  // --------------------------------------------------------------------------
  // Per-frame simulation (called by main.js at a fixed timestep during capture)
  // --------------------------------------------------------------------------
  PostFX.prototype.update = function (dt, ctx) {
    if (!this.enabled) return;
    ctx = ctx || this.ctx;
    dt = M.clamp(dt || 0, 0, 0.1);
    this._updateCount = (this._updateCount || 0) + 1;

    // Linear trauma decay with a squared response (Eiserloh): sharp attack,
    // and the tail dies instead of ringing forever.
    this.trauma = Math.max(0, this.trauma - dt * 1.7);
    this.lensKick = M.damp(this.lensKick, 0, 7.0, dt);
    this.flash = M.damp(this.flash, 0, 5.5, dt);
    this._flashShot = M.damp(this._flashShot, 0, 14.0, dt);
    this.hitPulse = M.damp(this.hitPulse, 0, 3.2, dt);
    this.shakeTime += dt * (7.0 + 17.0 * this.trauma);

    this._updateWeather(dt, ctx);
    this._scanHeat(ctx);

    var s = this.trauma * this.trauma * this.shakeScale;
    this._shakeActive = s > 1e-5;

    if (this._shakeActive) {
      // Smooth seeded noise rather than random(): shake must be continuous
      // (random per frame reads as a jitter bug) and deterministic for capture.
      var n = this._noise, t = this.shakeTime;
      var yaw = s * 0.030 * n.perlin2(t, 11.3);
      var pitch = s * 0.026 * n.perlin2(t, 47.1);
      var roll = s * 0.048 * n.perlin2(t * 0.83, 91.7);
      var px = s * 0.034 * n.perlin2(t * 1.27, 5.5);
      var py = s * 0.030 * n.perlin2(t * 1.27, 71.9);
      var pz = s * 0.018 * n.perlin2(t * 0.91, 33.3);

      this._shakeEuler.set(pitch, yaw, roll, 'YXZ');
      this._shakeQuat.setFromEuler(this._shakeEuler);
      this._shakePos.set(px, py, pz);
      this._shakeMat.compose(this._shakePos, this._shakeQuat, ONE);

      // The viewmodel carries mass: it follows the camera at a fraction of the
      // amplitude, so the gun visibly lags the frame.
      if (!this._shakeMatView) {
        this._shakeMatView = new THREE.Matrix4();
        this._shakeEulerView = new THREE.Euler(0, 0, 0, 'YXZ');
        this._shakeQuatView = new THREE.Quaternion();
        this._shakePosView = new THREE.Vector3();
      }
      this._shakeEulerView.set(pitch * 0.34, yaw * 0.34, roll * 0.55, 'YXZ');
      this._shakeQuatView.setFromEuler(this._shakeEulerView);
      this._shakePosView.set(px * 0.45, py * 0.45, pz * 0.3);
      this._shakeMatView.compose(this._shakePosView, this._shakeQuatView, ONE);
    } else {
      this._shakeMat.identity();
      if (this._shakeMatView) this._shakeMatView.identity();
    }

    // ---- depth-of-field focus ---------------------------------------------
    var ads = !!(ctx && (
      (ctx.player && ctx.player.isADS) ||
      (ctx.weapons && (ctx.weapons.isADS || ctx.weapons.forceADS))));
    this._ads = ads;
    // Smoothed so the optic falloff and the exposure lift ease in with the
    // sights rather than snapping on the frame the button goes down.
    this._adsBlend = M.damp(this._adsBlend || 0, ads ? 1 : 0, 11.0, dt);
    if (this._adsBlend < 1e-4) this._adsBlend = 0;

    var target = ads ? 26.0 : 12.0;
    // A capture pose may state its own focus (see _poseFocus). It outranks the
    // autofocus and it is LOCKED rather than damped: the author asked for a
    // distance, not for a rack towards one that a 1.5 s capture may not finish.
    // 0 on every level that publishes no `focus` on a pose, which is all of them
    // today, so the branch below is the one that runs everywhere it ran before.
    var poseFocus = this._poseFocus(ctx);
    if (this._focusOverride) {
      target = this._focusOverride;
    } else if (poseFocus > 0) {
      target = poseFocus;
    } else if (ctx && ctx.level && ctx.level.raycast && !this._focusRayBroken &&
               (this._updateCount % 5) === 0) {
      // Focus on whatever is under the crosshair, like a real operator would.
      // Throttled, and permanently disabled if level.raycast misbehaves.
      try {
        var cam = ctx.camera;
        _v3a.setFromMatrixPosition(cam.matrixWorld);
        _v3b.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
        var hit = ctx.level.raycast(_v3a, _v3b, 140);
        if (hit && hit.hit && isFinite(hit.distance) && hit.distance > 0.4) {
          target = M.clamp(hit.distance, 1.2, 140);
        }
      } catch (e) {
        this._focusRayBroken = true;
        GAME.logError('postfx.focusRay', e);
      }
    }
    this._focusTarget = target;
    if (poseFocus > 0 && !this._focusOverride) {
      // An authored capture focus is a LOCK, not a target: a 1.5 s capture is
      // 90 damped steps from 12 m and would land short of a 90 m mark.
      this._focus = target;
    } else {
      // Focus pull has weight; snapping between distances looks like a bug.
      this._focus = M.damp(this._focus, this._focusTarget, ads ? 7.0 : 3.5, dt);
    }
  };

  // --------------------------------------------------------------------------
  // Weather sampling + the lightning eye model.
  //
  // src/fx/weather.js OWNS all of this state; this reads it and never writes.
  // Every field is optional and every read is guarded, because weather.js is
  // built five systems after postfx and may not exist at all (level 1) or may
  // have failed to build (main.js records the failure and carries on).
  // --------------------------------------------------------------------------
  PostFX.prototype._updateWeather = function (dt, ctx) {
    var s = this.settings;
    var wx = (ctx && ctx.weather) || null;

    function num(v, fallback) {
      return (typeof v === 'number' && isFinite(v)) ? v : fallback;
    }

    // A harbor with no weather system still has to look wet - the level is
    // authored soaked - so the fallback is the storm, not a dry day.
    var defWet = this._harbor ? 0.85 : 0;
    var defRain = this._harbor ? 0.80 : 0;

    this._wetness = M.saturate(wx ? num(wx.wetness, defWet) : defWet);
    this._rainAmt = M.saturate(wx ? num(wx.rainIntensity, defRain) : defRain);
    this._rainLens = M.saturate(s.rainLens) * this._rainAmt;

    // ---- the eye ----------------------------------------------------------
    // Instant attack, exponential release. weather.flash is a per-FRAME value
    // that is zero on most frames, so anything that merely samples it prints
    // the flash and not the after-effect; holding a decaying envelope is what
    // gives the composite something to re-adapt FROM. lightningRecover is
    // ~5 s^-1, i.e. 87% back at 0.4 s.
    var flashNow = wx ? M.clamp(num(wx.flash, 0), 0, 4) : 0;
    var decay = Math.exp(-dt * Math.max(s.lightningRecover, 0.1));
    this._flashAdapt = Math.max(flashNow, this._flashAdapt * decay);
    if (this._flashAdapt < 1e-4) this._flashAdapt = 0;

    // ---- and the SENSOR, which is a different follower entirely ------------
    // The stop cannot close on the same frame the light arrives; no real sensor
    // does that, and driving the compression straight off the peak envelope
    // above is what made a lightning strike print 0.007% clipped pixels and read
    // as flat overcast daylight instead of as a 1/20 s freeze.
    //
    // _flashFall is "how far below its own held peak the flash currently is",
    // low-passed so it cannot spike in the sub-frame gaps of weather.js's
    // multi-pulse envelope (that is the trap the old lightningCompress value was
    // tuned around: the strike inverting to DARKER than its resting frame). The
    // product with the decaying peak is zero during the strike, rises to ~0.3 of
    // the strike amplitude about 100 ms after it ends, and is gone by ~0.5 s -
    // which is exactly the dazzle-recovery afterimage the model is for, landing
    // where a real one lands.
    var peak = this._flashAdapt;
    var falling = peak > 1e-4 ? M.saturate(1 - flashNow / peak) : 0;
    this._flashFall = M.damp(this._flashFall || 0, falling, 9.0, dt);
    this._flashComp = peak * this._flashFall;
    if (this._flashComp < 1e-4) this._flashComp = 0;

    // weather.js publishes the strike's own colour (it varies per strike); the
    // reflection of a flash in the apron has to match the light that caused it.
    if (wx && wx.flashColor && typeof wx.flashColor.r === 'number' && flashNow > 0) {
      s.lightningColor.setRGB(wx.flashColor.r, wx.flashColor.g, wx.flashColor.b);
    }
  };

  // --------------------------------------------------------------------------
  // Dispatch helper
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // A CPU-side estimate of the frame's key level, i.e. of the composite's knD.
  //
  // The real one is (metered gain x scene log-average x time-of-day bias) over
  // the noon reference, and both of its first two terms live in 1x1 render
  // targets that never leave the GPU. Substituting the meter's RESTING gain for
  // its instantaneous one gives a value that is exactly 1.0 at the market's
  // reference framing by construction (refGain * refAvg IS uKeyRef there), and
  // within a few percent of the true knD everywhere else, since the storm
  // preset's metering window is only +-0.5 EV wide. That is ample for a filter
  // THRESHOLD; it is not used for anything that prints.
  // --------------------------------------------------------------------------
  PostFX.prototype._keyEstimate = function (todBias) {
    var s = this.settings;
    var ref = Math.max(1e-5, s.exposureRefGain * s.exposureRefAvg * s.gradeKeyRefScale);
    var kn = s.exposureRefGain * s.exposureBias * (todBias || 1) * s.exposureRefAvg / ref;
    kn = M.clamp(isFinite(kn) ? kn : 1, 0.12, 3.0);
    return M.clamp(Math.pow(kn, M.clamp(s.gradeKeyExp, 0.1, 1.0)), 0.28, 1.6);
  };

  // --------------------------------------------------------------------------
  // The live half of the wet contract.
  //
  // materials.js OWNS where the water is; MaterialLibrary.wetContract() hands
  // over exactly the vec4 its own gbWetSolve() is being fed this frame, so the
  // SSR pass evaluates the identical field on the identical inputs rather than
  // a similar field on similar ones. 'wet_concrete' is the apron - the level's
  // dominant ponding surface, and the one a depth-buffer reconstruction of a
  // ground plane is actually looking at.
  //
  // Guarded end to end: materials may be missing, may have failed to build, or
  // may predate the contract, and the fallback is this module's own weather
  // read (which is itself defaulted to the storm). A wrong-but-finite cfg
  // degrades the correlation; a NaN in it would poison the whole reflection.
  // --------------------------------------------------------------------------
  PostFX.prototype._readWetContract = function (ctx, out) {
    var wetness = this._wetness, rain = this._rainAmt;
    var puddle = 1.0, wetRough = this.settings.ssrRoughWet;
    if (!this._wetContractBroken && ctx && ctx.materials &&
        typeof ctx.materials.wetContract === 'function') {
      try {
        var c = ctx.materials.wetContract('wet_concrete');
        if (c && c.cfg && c.cfg.length === 4) {
          var ok = true;
          for (var i = 0; i < 4; i++) {
            if (typeof c.cfg[i] !== 'number' || !isFinite(c.cfg[i])) { ok = false; break; }
          }
          if (ok) {
            wetness = c.cfg[0]; rain = c.cfg[1];
            puddle = c.cfg[2]; wetRough = c.cfg[3];
          }
        }
      } catch (e) {
        this._wetContractBroken = true;
        GAME.logError('postfx.wetContract', e);
      }
    }
    out.set(M.saturate(wetness), M.saturate(rain),
            M.clamp(puddle, 0, 1), M.clamp(wetRough, 0.005, 0.6));
    return out;
  };

  PostFX.prototype._pass = function (mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this.fsScene, this.fsCamera);
  };

  PostFX.prototype._next = function (src) {
    return src === this.rtFull[0] ? this.rtFull[1] : this.rtFull[0];
  };

  // --------------------------------------------------------------------------
  // Degraded path - used before init completes, or after repeated failures.
  // A plain image beats a black screen every time.
  // --------------------------------------------------------------------------
  PostFX.prototype._fallbackRender = function (ctx) {
    try {
      var r = ctx.renderer;
      r.setRenderTarget(null);
      r.clear(true, true, false);
      if (ctx.scene && ctx.camera) r.render(ctx.scene, ctx.camera);
      if (ctx.viewScene && ctx.viewCamera && ctx.viewScene.visible !== false) {
        r.clearDepth();
        r.render(ctx.viewScene, ctx.viewCamera);
      }
    } catch (e) {
      GAME.logError('postfx.fallback', e);
    }
  };

  PostFX.prototype.render = function (ctx) {
    ctx = ctx || this.ctx;
    if (!ctx || !ctx.renderer) return;
    if (!this.enabled || this._errorCount > 3) { this._fallbackRender(ctx); return; }
    try {
      this._render(ctx);
    } catch (e) {
      this._errorCount++;
      GAME.logError('postfx.render', e);
      // Leave the GPU in a sane state before falling back.
      try { this.renderer.setRenderTarget(null); } catch (e2) { /* ignore */ }
      this._fallbackRender(ctx);
    }
  };

  // --------------------------------------------------------------------------
  // The chain
  // --------------------------------------------------------------------------
  var _v4a = new THREE.Vector4();
  var _savedClear = new THREE.Color();

  PostFX.prototype._render = function (ctx) {
    var r = this.renderer;
    var q = this.q, s = this.settings, m = this.mat;


    // Any change to the drawing buffer (resize, pixelRatio, capture size)
    // reallocates. Sizing from the drawing buffer rather than CSS pixels is the
    // only way this survives every path main.js can take.
    r.getDrawingBufferSize(_v2a);
    var w = Math.max(2, _v2a.x | 0), h = Math.max(2, _v2a.y | 0);
    if (w !== (this._size.x | 0) || h !== (this._size.y | 0)) this._allocate(w, h);
    // A level asked for the soft-particle depth copy after the targets were
    // built (levels are built four systems after this one, so this is the normal
    // case). Reallocating here rather than in the accessor keeps every target
    // allocation on one path, and it happens once.
    else if (this._softWanted && !this.rtSoftDepth) this._allocate(w, h);

    var cam = ctx.camera;
    if (!cam || !ctx.scene) { this._fallbackRender(ctx); return; }

    this._frame++;
    var frame = this._frame;
    var near = cam.near || 0.05;
    var far = cam.far || 600;
    var dt = M.clamp(ctx.dt || (1 / 60), 1 / 240, 0.1);
    var time = ctx.time || 0;

    // ======================================================== 1. main pass ==
    // TAA jitter. Halton(2,3) over an 8-frame cycle: low discrepancy, so the
    // samples tile the pixel evenly instead of clumping the way random offsets
    // do. Applied straight to the projection matrix and undone immediately.
    var jx = 0, jy = 0;
    if (q.taa) {
      if (this._harbor) {
        // R2 (the 2D "plastic" / Roberts sequence) over 16 frames instead of
        // Halton(2,3) over 8, and the reason is the CAPTURE path specifically.
        // main.js renders only three times for a t=1.5 capture, so the TAA
        // history is graded at a 3-sample prefix - and Halton's 3-sample prefix
        // is badly conditioned in x (the offsets used land at -0.5, +0.5, -0.75,
        // three samples on essentially one axis), which is the worst possible
        // arrangement for resolving the VERTICAL structure this level is made
        // of. R2's prefix is (+0.51,+0.14), (+0.02,-0.72), (-0.47,+0.42): three
        // points that actually tile the pixel.
        //
        // NOTE ON THE OTHER FIX: running the scene+velocity+TAA loop internally
        // until the history holds 8 frames was measured and rejected. This level
        // takes 93 s to capture at 720p under SwiftShader for its three renders;
        // eight would put every framing past shoot.py's 300 s default timeout,
        // i.e. the critics could not capture the level at all. Better
        // conditioning of the samples we can afford beats more samples we
        // cannot. (It could not be applied to the market in any case - level 1
        // is frozen and it would change every capture.)
        var rIdx = (frame % 16) + 1;
        jx = (pfR2(rIdx, 0.7548776662466927) - 0.5) * 2.0 / w;
        jy = (pfR2(rIdx, 0.5698402909980532) - 0.5) * 2.0 / h;
      } else {
        var hIdx = (frame % 8) + 1;
        jx = (halton(hIdx, 2) - 0.5) * 2.0 / w;
        jy = (halton(hIdx, 3) - 0.5) * 2.0 / h;
      }
    }
    this._projBase.copy(cam.projectionMatrix);
    this._projInvBase.copy(cam.projectionMatrixInverse);
    if (q.taa) {
      cam.projectionMatrix.elements[8] += jx;
      cam.projectionMatrix.elements[9] += jy;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    // Camera shake goes onto matrixWorld only, and only for the duration of the
    // scene pass. Doing it here (rather than moving the camera in update())
    // means it can never affect aim, raycasts, or whoever owns the transform.
    var camAuto = cam.matrixWorldAutoUpdate;
    if (camAuto) cam.updateMatrixWorld();
    this._camWorld.copy(cam.matrixWorld);
    if (this._shakeActive) cam.matrixWorld.multiply(this._shakeMat);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    cam.matrixWorldAutoUpdate = false;
    // The matrix the depth buffer was actually rasterised with, shake included.
    // SSR needs view -> world to ask "is this surface horizontal", and using
    // the pre-shake matrix would tilt that test against the buffer it is
    // testing whenever the camera is being shaken.
    this._camWorldShaken.copy(cam.matrixWorld);

    this._curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._curViewProj).invert();
    if (!this._camPos) this._camPos = new THREE.Vector3();
    var camPos = this._camPos.setFromMatrixPosition(cam.matrixWorld);

    r.setRenderTarget(this.rtScene);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);

    // ==================================================== 1b. viewmodel pass ==
    // Its own scene, camera, depth buffer and supersampled target: the gun can
    // never clip into a wall and never inherits the world's DoF/motion blur.
    var viewOk = !!(ctx.viewScene && ctx.viewCamera &&
      ctx.viewScene.visible !== false && ctx.viewScene.children.length > 0);
    if (viewOk) {
      var vcam = ctx.viewCamera;
      var vAuto = vcam.matrixWorldAutoUpdate;
      if (vAuto) vcam.updateMatrixWorld();
      this._viewWorld.copy(vcam.matrixWorld);
      if (this._shakeActive && this._shakeMatView) vcam.matrixWorld.multiply(this._shakeMatView);
      vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert();
      vcam.matrixWorldAutoUpdate = false;

      r.getClearColor(_savedClear);
      var savedAlpha = r.getClearAlpha();
      r.setClearColor(0x000000, 0);      // alpha 0 = "no weapon here"
      r.setRenderTarget(this.rtView);
      r.clear(true, true, false);
      r.render(ctx.viewScene, vcam);
      r.setClearColor(_savedClear, savedAlpha);

      vcam.matrixWorld.copy(this._viewWorld);
      vcam.matrixWorldInverse.copy(this._viewWorld).invert();
      vcam.matrixWorldAutoUpdate = vAuto;
    }

    // Restore the camera before anything else can observe it.
    cam.matrixWorld.copy(this._camWorld);
    cam.matrixWorldInverse.copy(this._camWorld).invert();
    cam.matrixWorldAutoUpdate = camAuto;
    cam.projectionMatrix.copy(this._projBase);
    cam.projectionMatrixInverse.copy(this._projInvBase);

    var depthTex = this.rtScene.depthTexture;
    this.hasDepth = !!depthTex;

    // ============================================== 1c. soft-particle depth ==
    // The scene's depth, linearised into a colour texture a level's own material
    // can legally sample. Written here, immediately after the pass that produced
    // it, so it is at most one frame old when the next scene pass reads it - and
    // exactly current on the capture path, where the pose does not move between
    // renders. See sceneDepthUniforms(). Skipped entirely (target not even
    // allocated) unless a level asked.
    if (this.rtSoftDepth && this._softU) {
      if (this.hasDepth) {
        var sdu = m.softDepth.uniforms;
        sdu.tDepth.value = depthTex;
        sdu.uNear.value = near;
        sdu.uFar.value = far;
        this._pass(m.softDepth, this.rtSoftDepth);
        this._softU.tPfDepth.value = this.rtSoftDepth.texture;
      } else {
        this._softU.tPfDepth.value = this._softNoData;
      }
      // Full-res, because the consumer indexes with gl_FragCoord of the SCENE
      // target; the copy being half-res is invisible to it (normalised UVs).
      this._softU.uPfInvRes.value.set(1 / w, 1 / h);
      this._softU.uPfNF.value.set(near, far);
    }

    // ---- environment -------------------------------------------------------
    var sunDir = _v3b;
    if (ctx.sky && ctx.sky.sunDirection) sunDir.copy(ctx.sky.sunDirection);
    else if (ctx.lighting && ctx.lighting.sun) sunDir.copy(ctx.lighting.sun.position);
    else sunDir.copy(DEFAULT_SUN);
    if (!isFinite(sunDir.lengthSq()) || sunDir.lengthSq() < 1e-8) sunDir.copy(DEFAULT_SUN);
    sunDir.normalize();

    _c1.setRGB(1.0, 0.78, 0.55);
    if (ctx.sky && ctx.sky.sunColor) _c1.copy(ctx.sky.sunColor);
    else if (ctx.lighting && ctx.lighting.sun && ctx.lighting.sun.color) _c1.copy(ctx.lighting.sun.color);
    var sunI = 1.0;
    if (ctx.sky && typeof ctx.sky.sunIntensity === 'number') sunI = ctx.sky.sunIntensity;
    else if (ctx.lighting && ctx.lighting.sun) sunI = ctx.lighting.sun.intensity;
    sunI = M.clamp(isFinite(sunI) ? sunI : 1, 0, 14);

    // Absolute print level from the actual key-light energy. Auto exposure only
    // trims; this is what makes dusk low-key and night dark on purpose rather
    // than leaving it to a metering loop that cannot tell a dark scene from a
    // dark subject. Computed here because three separate passes need it: the AO
    // resolve's direct mask, the viewmodel exposure lock, and the composite.
    var todBias = s.todBiasFloor +
      (1 - s.todBiasFloor) * M.saturate(sunI / Math.max(s.todBiasSun, 1e-3));

    // ---- environment for the SSR fallback + the lens streak vector ---------
    if (this._harbor) this._updateStormFrame(ctx, camPos, cam);

    // Local practicals: harbor only, and an exact no-op (count 0, and an early
    // return) anywhere else. Hoisted out of the volumetric block because the SSR
    // resolve now needs the same list for its analytic water lobe, and that must
    // not become conditional on the volumetric pass being enabled.
    this._collectPracticals(ctx, camPos);

    // Sun position on screen, for the streak and the flare ghosts.
    _v4a.set(camPos.x + sunDir.x * 4000, camPos.y + sunDir.y * 4000,
             camPos.z + sunDir.z * 4000, 1).applyMatrix4(this._curViewProj);
    var onScreen = 0;
    if (_v4a.w > 1e-4) {
      var sxu = _v4a.x / _v4a.w * 0.5 + 0.5;
      var syu = _v4a.y / _v4a.w * 0.5 + 0.5;
      this._sunUv.set(sxu, syu);
      var outX = Math.max(0, Math.max(-sxu, sxu - 1));
      var outY = Math.max(0, Math.max(-syu, syu - 1));
      onScreen = M.saturate(1 - Math.max(outX, outY) / 0.3);
    }
    // GATE THE LENS SUN TERMS ON REAL KEY ENERGY. onScreen is derived purely
    // from the projected key-light DIRECTION, so on a level whose key is a 0.19
    // moon the streak and the flare ghosts fired at full strength at 02:00 -
    // and the ghosts sample the bloom pyramid, which here is full of sodium mast
    // lamps. Harbor-gated: level 1's own low-sun framings are frozen.
    if (this._harbor) onScreen *= M.saturate((sunI - 0.4) / 1.6);
    // ...and the same gate, opt-in, for any preset that asks for it. It is the
    // INTERIOR case that needs it: a level with no sky has no sunDirection, so
    // sunDir falls back to DEFAULT_SUN and this term would otherwise report a
    // sun sitting in the middle of a buried corridor. s.sunLensGate is 0 on the
    // market (and the harbor takes the branch above), so this line is
    // unreachable on both frozen levels.
    else if (s.sunLensGate > 0) onScreen *= M.saturate((sunI - 0.4) / 1.6);
    this._sunOnScreen = onScreen;

    // ==================================================== 2. motion vectors ==
    var mv = m.velocity.uniforms;
    mv.tDepth.value = depthTex;
    mv.uInvViewProj.value.copy(this._invViewProj);
    // Frame 0 has no history; reprojecting against itself yields zero velocity,
    // which is exactly right.
    mv.uPrevViewProj.value.copy(this._historyValid ? this._prevViewProj : this._curViewProj);
    if (this.hasDepth) this._pass(m.velocity, this.rtVel);

    // ============================================================= 3. GTAO ==
    var useAO = !!(q.ssao && this.hasDepth);
    if (useAO) {
      var ga = m.gtao.uniforms;
      ga.tDepth.value = depthTex;
      ga.tBlue.value = this.blueNoise;
      ga.uNear.value = near; ga.uFar.value = far;
      ga.uProj.value.copy(this._projBase);
      // The depth buffer was rasterised with the jittered projection, so the
      // inverse used to unproject it must be the jittered one too.
      ga.uInvProj.value.copy(cam.projectionMatrix).invert();
      if (q.taa) {
        _m4a.copy(this._projBase);
        _m4a.elements[8] += jx; _m4a.elements[9] += jy;
        ga.uProj.value.copy(_m4a);
        ga.uInvProj.value.copy(_m4a).invert();
      }
      ga.uTexel.value.set(1 / this._aoSize.x, 1 / this._aoSize.y);
      ga.uRes.value.copy(this._aoSize);
      ga.uBlueScale.value.set(1 / this.blueNoise.image.width, 1 / this.blueNoise.image.height);
      ga.uRadius.value = s.aoRadius;
      ga.uIntensity.value = s.aoIntensity;
      ga.uFalloff.value = s.aoFalloff;
      ga.uFadeStart.value = s.aoFadeStart;
      ga.uFadeEnd.value = s.aoFadeEnd;
      ga.uFrame.value = frame;
      ga.uDirs.value = q.aoDirs;
      ga.uSteps.value = q.aoSteps;
      this._pass(m.gtao, this.rtAO);

      // Separable cross-bilateral: blurs the noise out without letting
      // occlusion cross a depth discontinuity.
      var ab = m.aoBlur.uniforms;
      ab.uDepthSigma.value = 5.0;
      ab.tAO.value = this.rtAO.texture;
      ab.uStep.value.set(1 / this._aoSize.x, 0);
      this._pass(m.aoBlur, this.rtAOTmp);
      ab.tAO.value = this.rtAOTmp.texture;
      ab.uStep.value.set(0, 1 / this._aoSize.y);
      this._pass(m.aoBlur, this.rtAO);
    }

    // ====================================================== 4. volumetrics ==
    var useVol = !!(q.volumetrics && this.hasDepth);
    if (useVol) {
      var vu = m.volume.uniforms;
      vu.tDepth.value = depthTex;
      vu.tBlue.value = this.blueNoise;
      vu.uNear.value = near; vu.uFar.value = far;
      vu.uInvViewProj.value.copy(this._invViewProj);
      vu.uViewProj.value.copy(this._curViewProj);
      vu.uCamPos.value.copy(camPos);
      vu.uSunDir.value.copy(sunDir);
      vu.uSunColor.value.set(
        _c1.r * sunI * s.volumeScatterAlbedo,
        _c1.g * sunI * s.volumeScatterAlbedo,
        _c1.b * sunI * s.volumeScatterAlbedo);

      // Real occlusion straight off the CSM. Falls back to the screen-space
      // probes if lighting.js has not produced maps yet.
      this._bindShadows(ctx);
      vu.uShadowBias.value = s.volumeShadowBias;

      // Match whatever atmosphere sky.js established so the two do not fight.
      // Follow sky.js's atmosphere, but with a floor. Distance fog answers "how
      // far can you see"; the dust that makes a shaft visible is a near-field
      // quantity, and a thin distance haze must not mean no god rays.
      var fog = ctx.scene.fog;
      var dens = s.volumeDensity;
      if (this._harbor) {
        // (see below for the volumeDensityAbs branch - the harbor is tested
        // first and unconditionally, so weather.js keeps ownership of its
        // medium whatever a preset says.)
        // WEATHER OWNS THE MEDIUM HERE. ctx.weather.fogDensity is published in
        // extinction-per-metre (weather.js states the unit as part of the
        // contract) which is exactly what this march integrates, so it is read
        // straight through. The market path below cannot do that - it has no
        // weather - so it reconstructs sigma from scene.fog.density, which
        // sky.js writes as sigma * 0.6 for three's FogExp2. Running the harbor
        // through the market path put the raymarch at 0.0225 against a real
        // medium of 0.0145: a pass whose entire job is to agree with the fog
        // everything else in the frame is using, disagreeing with it by 55%.
        var wxd = (ctx.weather && typeof ctx.weather.fogDensity === 'number' &&
                   isFinite(ctx.weather.fogDensity)) ? ctx.weather.fogDensity : 0;
        if (wxd > 1e-5) dens = wxd;
        else if (fog && typeof fog.density === 'number' && fog.density > 0) {
          dens = fog.density / 0.6;
        }
        dens = M.clamp(dens, 0.003, 0.045);
      } else if (s.volumeDensityAbs > 0) {
        // The preset states the medium itself. Nothing is derived and nothing
        // is floored against the distance fog, because the two are describing
        // different things: a dawn ground mist is thick at the ankle and gone
        // by the cornice, and averaging it against a thin distance haze is what
        // turns it back into a height-uniform veil. Clamped only against the
        // absurd, so a typo cannot march an opaque medium.
        dens = M.clamp(s.volumeDensityAbs, 0.001, 0.30);
      } else if (fog && typeof fog.density === 'number' && fog.density > 0) {
        dens = M.clamp(Math.max(fog.density * 1.35, s.volumeDensity * 0.75), 0.008, 0.075);
      }
      vu.uDensity.value = dens;
      vu.uMaxInscatter.value = Math.max(1e-4, s.volumeMaxInscatter);
      vu.uHeightFalloff.value = s.volumeHeightFalloff;
      vu.uBaseHeight.value = s.volumeBaseHeight;
      vu.uAnisotropy.value = s.volumeAnisotropy;
      vu.uMaxDist.value = Math.min(s.volumeMaxDist, far * 0.85);
      vu.uBlueScale.value.set(1 / this.blueNoise.image.width, 1 / this.blueNoise.image.height);
      vu.uFrame.value = frame;
      vu.uTime.value = time;
      vu.uSteps.value = q.volSteps;
      vu.uShadowTaps.value = q.volShadowTaps;
      this._pass(m.volume, this.rtVol);

      var vb = m.volBlur.uniforms;
      vb.tDepth.value = depthTex;
      vb.uNear.value = near; vb.uFar.value = far;
      vb.tSrc.value = this.rtVol.texture;
      vb.uStep.value.set(1 / this._volSize.x, 0);
      this._pass(m.volBlur, this.rtVolTmp);
      vb.tSrc.value = this.rtVolTmp.texture;
      vb.uStep.value.set(0, 1 / this._volSize.y);
      this._pass(m.volBlur, this.rtVol);
    }

    // ========================================================== 5. resolve ==
    var ru = m.resolve.uniforms;
    ru.tScene.value = this.rtScene.texture;
    ru.tAO.value = this.rtAO.texture;
    ru.tVolume.value = this.rtVol.texture;
    ru.tDepth.value = depthTex;
    // Last frame's exposure. The resolve necessarily runs before metering, and
    // one frame of lag on an AO threshold is invisible.
    ru.tExposure.value = this.rtExp[this._expIndex].texture;
    ru.uNear.value = near; ru.uFar.value = far;
    ru.uAOTexel.value.set(1 / this._aoSize.x, 1 / this._aoSize.y);
    ru.uVolTexel.value.set(1 / this._volSize.x, 1 / this._volSize.y);
    ru.uAOStrength.value = s.aoStrength;
    ru.uAODirectLo.value = s.aoDirectLo;
    ru.uAODirectHi.value = s.aoDirectHi;
    ru.uAOKeep.value = M.clamp(s.aoKeep, 0, 1);
    ru.uAOContact.value = M.clamp(s.aoContact, 0, 1);
    ru.uAOTint.value.set(s.aoTint.r, s.aoTint.g, s.aoTint.b);
    ru.uVolumeIntensity.value = s.volumeIntensity;
    ru.uExposureBias.value = s.exposureBias * todBias;
    ru.uUseAO.value = useAO ? 1 : 0;
    ru.uUseVolume.value = useVol ? 1 : 0;
    this._pass(m.resolve, this.rtFull[0]);
    var src = this.rtFull[0];

    // ====================================================== 5b. reflections ==
    // Harbor only, and UPSTREAM OF TAA on purpose: the march is blue-noise
    // jittered per frame, so the temporal filter is what turns 26 steps into a
    // clean reflection. Downstream of TAA the same pass would need three times
    // the samples and would still crawl.
    var useSSR = !!(this._harbor && q.ssr && s.ssrEnabled && this.hasDepth &&
                    this.rtSSR && this._wetness > 0.02);
    if (useSSR) {
      // The projection the depth buffer was rasterised with - jittered, exactly
      // as GTAO does it. Marching with the unjittered matrix walks the ray half
      // a pixel off the buffer it is testing and shows up as a shimmering rim
      // along every reflected silhouette.
      _m4a.copy(this._projBase);
      if (q.taa) { _m4a.elements[8] += jx; _m4a.elements[9] += jy; }
      this._viewToWorld.setFromMatrix4(this._camWorldShaken);

      var su = m.ssr.uniforms;
      su.tDepth.value = depthTex;
      su.tScene.value = src.texture;
      su.tBlue.value = this.blueNoise;
      su.uNear.value = near; su.uFar.value = far;
      su.uProj.value.copy(_m4a);
      su.uInvProj.value.copy(_m4a).invert();
      su.uInvViewProj.value.copy(this._invViewProj);
      su.uViewToWorld.value.copy(this._viewToWorld);
      su.uTexelFull.value.set(1 / w, 1 / h);
      su.uBlueScale.value.set(1 / this.blueNoise.image.width, 1 / this.blueNoise.image.height);
      su.uWetness.value = this._wetness;
      su.uRainAmt.value = this._rainAmt;
      su.uSsrTime.value = time;
      su.uUpLo.value = s.ssrUpLo;
      su.uUpHi.value = Math.max(s.ssrUpHi, s.ssrUpLo + 0.02);
      su.uSideAmount.value = M.saturate(s.ssrSideAmount);
      su.uRoughDry.value = s.ssrRoughDry;
      su.uRoughWet.value = s.ssrRoughWet;
      su.uPuddleScale.value = s.ssrPuddleScale;
      su.uRipple.value = s.ssrRipple;
      this._readWetContract(ctx, su.uWetCfg.value);
      su.uEnvSky.value.copy(this._envSky);
      su.uEnvGround.value.copy(this._envGround);
      su.uFlashColor.value.set(s.lightningColor.r, s.lightningColor.g, s.lightningColor.b);
      su.uFlashAmt.value = M.clamp(this._flashAdapt * 0.9, 0, 3);
      su.uFrame.value = frame;
      su.uMaxDist.value = s.ssrMaxDist;
      su.uMaxViewDist.value = Math.min(s.ssrMaxViewDist, far * 0.6);
      su.uThickness.value = Math.max(0.05, s.ssrThickness);
      su.uEdgeFade.value = M.clamp(s.ssrEdgeFade, 0.01, 0.6);
      su.uF0.value = M.clamp(s.ssrF0, 0.005, 0.2);
      su.uClampRefl.value = Math.max(0.5, s.ssrClamp);
      su.uEnvWeight.value = M.saturate(s.ssrEnvWeight);
      su.uSteps.value = Math.max(4, Math.min(40, q.ssrSteps || s.ssrSteps));
      su.uRefine.value = Math.max(0, Math.min(8, q.ssrRefine || s.ssrRefine));
      this._pass(m.ssr, this.rtSSR);

      var au = m.ssrApply.uniforms;
      au.tDepth.value = depthTex;
      au.tScene.value = src.texture;
      au.tSSR.value = this.rtSSR.texture;
      au.uNear.value = near; au.uFar.value = far;
      au.uProj.value.copy(_m4a);
      au.uInvProj.value.copy(_m4a).invert();
      au.uInvViewProj.value.copy(this._invViewProj);
      au.uViewToWorld.value.copy(this._viewToWorld);
      au.uTexelFull.value.set(1 / w, 1 / h);
      au.uSSRTexel.value.set(1 / this._ssrSize.x, 1 / this._ssrSize.y);
      au.uWetness.value = this._wetness;
      au.uRainAmt.value = this._rainAmt;
      au.uSsrTime.value = time;
      au.uUpLo.value = s.ssrUpLo;
      au.uUpHi.value = Math.max(s.ssrUpHi, s.ssrUpLo + 0.02);
      au.uSideAmount.value = M.saturate(s.ssrSideAmount);
      au.uRoughDry.value = s.ssrRoughDry;
      au.uRoughWet.value = s.ssrRoughWet;
      au.uPuddleScale.value = s.ssrPuddleScale;
      au.uRipple.value = s.ssrRipple;
      au.uWetCfg.value.copy(su.uWetCfg.value);
      au.uBlurScale.value = Math.max(0, s.ssrBlur);
      au.uIntensity.value = M.clamp(s.ssrIntensity, 0, 2);
      au.uF0.value = M.clamp(s.ssrF0, 0.005, 0.2);
      // uPracPos/uPracCol/uPracGain/uPracCount were filled by _collectPracticals
      // above; nothing to do here beyond letting them through.
      var dstSSR = this._next(src);
      this._pass(m.ssrApply, dstSSR);
      src = dstSSR;
    }

    // ============================================================== 6. AA ==
    if (q.taa && this.hasDepth) {
      var histRead = this.rtHist[this._histIndex];
      var histWrite = this.rtHist[1 - this._histIndex];
      var tu = m.taa.uniforms;
      tu.tCurrent.value = src.texture;
      tu.tHistory.value = histRead.texture;
      tu.tVelocity.value = this.rtVel.texture;
      tu.tDepth.value = depthTex;
      tu.uTexel.value.set(1 / w, 1 / h);
      // PROGRESSIVE ACCUMULATION. Applying the authored feedback from the very
      // first valid frame is what made this chain pay the full blur cost of TAA
      // and collect almost none of the supersample: a 2-frame history blended
      // 10/90 is one half-pixel-jittered sample fetched through a Catmull-Rom
      // filter, which measured 25-40% below an SSAA reference of the identical
      // frame. Clamping the feedback to the equal-weight average of the frames
      // the history actually holds (0.50 at n=1, 0.75 at n=3, converging to the
      // authored max by n~9) makes an N-frame history worth N samples. It costs
      // nothing, and it fixes the same defect in the live game for the ~10
      // frames after every camera cut.
      var accum = this._histFrames / (this._histFrames + 1);
      tu.uFeedbackMin.value = Math.min(s.taaFeedbackMin, accum);
      tu.uFeedbackMax.value = Math.min(s.taaFeedbackMax, accum);
      tu.uVarianceGamma.value = s.taaVarianceGamma;
      tu.uHistoryValid.value = this._historyValid ? 1 : 0;
      this._pass(m.taa, histWrite);
      this._histIndex = 1 - this._histIndex;
      this._historyValid = true;
      this._histFrames = Math.min(this._histFrames + 1, 64);
      src = histWrite;
    } else {
      var fu = m.fxaa.uniforms;
      fu.tSrc.value = src.texture;
      fu.uTexel.value.set(1 / w, 1 / h);
      var dstAA = this._next(src);
      this._pass(m.fxaa, dstAA);
      src = dstAA;
      this._historyValid = false;
      this._histFrames = 0;
    }

    // ===================================================== 7. motion blur ==
    // Still BEFORE the viewmodel overlay, and it has to be: the gun is bolted
    // to the camera and has zero screen velocity under a turn, while the
    // velocity buffer at those pixels carries the motion of the street behind
    // it. Everything else the weapon should receive - DoF, sharpen, bloom -
    // now runs after the overlay.
    if (q.motionBlur && this.hasDepth) {
      var tm = m.tileMax.uniforms;
      tm.tVel.value = this.rtVel.texture;
      tm.uSrcTexel.value.set(1 / w, 1 / h);
      tm.uScale.value.set(16, 1);
      tm.uAxis.value.set(1, 0);
      this._pass(m.tileMax, this.rtTileA);

      tm.tVel.value = this.rtTileA.texture;
      tm.uSrcTexel.value.set(1 / this._tileSize.x, 1 / h);
      tm.uScale.value.set(1, 16);
      tm.uAxis.value.set(0, 1);
      this._pass(m.tileMax, this.rtTileB);

      var nm = m.neighborMax.uniforms;
      nm.tTile.value = this.rtTileB.texture;
      nm.uTexel.value.set(1 / this._tileSize.x, 1 / this._tileSize.y);
      this._pass(m.neighborMax, this.rtTileC);

      var mb = m.motionBlur.uniforms;
      mb.tSrc.value = src.texture;
      mb.tVel.value = this.rtVel.texture;
      mb.tNeighbor.value = this.rtTileC.texture;
      mb.tDepth.value = depthTex;
      mb.uNear.value = near; mb.uFar.value = far;
      mb.uTexel.value.set(1 / w, 1 / h);
      mb.uRes.value.set(w, h);
      mb.uStrength.value = s.motionStrength;
      mb.uMaxPixels.value = s.motionMaxPixels * (h / 1080);
      mb.uFrame.value = frame;
      mb.uTaps.value = q.mbTaps;
      var dstMb = this._next(src);
      this._pass(m.motionBlur, dstMb);
      src = dstMb;
    }

    // ========================================================= 8. viewmodel ==
    // Keep a handle on the pre-overlay image: the weapon must never meter the
    // world. It fills a quarter of the lower frame at a constant brightness, so
    // including it makes exposure depend on whether the gun is on screen (and,
    // while the viewmodel albedo is hot, actively darkens the whole street).
    var meterSrc = src;
    if (viewOk) {
      var ou = m.overlay.uniforms;
      ou.tWorld.value = src.texture;
      ou.tView.value = this.rtView.texture;
      ou.tExposure.value = this.rtExp[this._expIndex].texture;
      ou.uViewTexel.value.set(1 / this._viewSize.x, 1 / this._viewSize.y);
      // The metered gain the viewmodel materials were authored against - see
      // settings.viewRefGain, which documents why it is a constant.
      ou.uRefExposure.value = s.viewRefGain;
      ou.uViewLock.value = M.clamp(s.viewExposureLock, 0, 1);
      ou.uTodBias.value = s.exposureBias * todBias;
      var dstOv = this._next(src);
      this._pass(m.overlay, dstOv);
      src = dstOv;
    }

    // =========================================================== 9. sharpen ==
    // On the FULL composite, after every low-pass the chain applies except the
    // DoF gather (which must stay downstream - sharpening bokeh is exactly what
    // an RCAS limiter exists to avoid). Previously this ran at step 6, so DoF
    // combine, motion blur AND the viewmodel's own tent resolve all undid it,
    // which meant the hero asset was the one thing in the frame never sharpened.
    // The TAA history keeps the unsharpened resolve, so nothing compounds.
    if (s.taaSharpen > 1e-4) {
      var shu = m.sharpen.uniforms;
      shu.tSrc.value = src.texture;
      shu.uTexel.value.set(1 / w, 1 / h);
      shu.uAmount.value = s.taaSharpen;
      // The key the sharpen's silhouette guard is normalised against. Computed
      // here rather than read back from the GPU: the composite's knD comes off a
      // 1x1 exposure target that only exists on the device, and a readPixels a
      // frame to feed a THRESHOLD would be a pipeline stall for nothing. This is
      // the same expression with the meter's resting gain substituted for its
      // instantaneous one, which is exactly 1.0 at the market reference framing.
      shu.uKnD.value = this._keyEstimate(todBias);
      shu.uExtGate.value = M.saturate(s.sharpenExtGate);
      var dstSharp = this._next(src);
      this._pass(m.sharpen, dstSharp);
      src = dstSharp;
    }

    // ============================================================ 10. DoF ==
    // AFTER the overlay, so the weapon gets a real circle of confusion out of
    // its own depth buffer instead of a fixed uniform tent blur.
    if (q.dof && this.hasDepth) {
      var ads = this._ads;
      var focus = this._focus;
      var nearDead = ads ? s.dofAdsNearDead : s.dofNearDead;
      var farDead = ads ? s.dofAdsFarDead : s.dofFarDead;
      var nearRange = ads ? s.dofAdsNearRange : s.dofNearRange;
      var farRange = ads ? s.dofAdsFarRange : s.dofFarRange;
      var maxRadius = ads ? s.dofAdsMaxRadius : s.dofMaxRadius;
      var vcam2 = ctx.viewCamera;
      var vNear = (vcam2 && vcam2.near) ? vcam2.near : 0.002;
      var vFar = (vcam2 && vcam2.far) ? vcam2.far : 12;
      var viewDepthTex = (viewOk && this.rtView.depthTexture)
        ? this.rtView.depthTexture : null;
      var hasView = viewDepthTex ? 1 : 0;

      var dp = m.dofPrep.uniforms;
      dp.tSrc.value = src.texture;
      dp.tDepth.value = depthTex;
      dp.tViewDepth.value = viewDepthTex || this.whiteTex;
      dp.uHasView.value = hasView;
      dp.uVNear.value = vNear; dp.uVFar.value = vFar;
      dp.uNear.value = near; dp.uFar.value = far;
      dp.uFocus.value = focus;
      dp.uNearDead.value = nearDead; dp.uFarDead.value = farDead;
      dp.uNearRange.value = nearRange; dp.uFarRange.value = farRange;
      dp.uSrcTexel.value.set(1 / w, 1 / h);
      this._pass(m.dofPrep, this.rtDofA);

      var db = m.dofBlur.uniforms;
      db.tSrc.value = this.rtDofA.texture;
      db.uTexel.value.set(1 / this._volSize.x, 1 / this._volSize.y);
      // Strength is a RADIUS, never a blend. In-focus pixels are then bit-exact
      // and the whole effect is driven by CoC alone.
      db.uMaxRadius.value = maxRadius;
      db.uFrame.value = frame;
      db.uTaps.value = q.dofTaps;
      this._pass(m.dofBlur, this.rtDofB);

      var dc = m.dofCombine.uniforms;
      dc.tSrc.value = src.texture;
      dc.tBlur.value = this.rtDofB.texture;
      dc.tDepth.value = depthTex;
      dc.tViewDepth.value = viewDepthTex || this.whiteTex;
      dc.uHasView.value = hasView;
      dc.uVNear.value = vNear; dc.uVFar.value = vFar;
      dc.uNear.value = near; dc.uFar.value = far;
      dc.uFocus.value = focus;
      dc.uNearDead.value = nearDead; dc.uFarDead.value = farDead;
      dc.uNearRange.value = nearRange; dc.uFarRange.value = farRange;
      // The sharp/blurred crossover, stated in half-res texels of ACTUAL gather
      // radius and divided back into CoC units here - see FRAG_DOF_COMBINE for
      // why a fixed CoC crossover is the wrong unit. dofBlendHiPix 0 keeps the
      // shipped 0.03/0.22 constants, which is the market.
      if (s.dofBlendHiPix > 1e-4 && maxRadius > 1e-3) {
        dc.uBlendLo.value = s.dofBlendLoPix / maxRadius;
        dc.uBlendHi.value = s.dofBlendHiPix / maxRadius;
      } else {
        dc.uBlendLo.value = 0.03;
        dc.uBlendHi.value = 0.22;
      }
      var dstDof = this._next(src);
      this._pass(m.dofCombine, dstDof);
      src = dstDof;
    }

    // ====================================================== 11. auto exposure ==
    this._passExposure(meterSrc, dt);

    // ============================================================ 12. bloom ==
    var bloomTex = this.rtBloom[0].texture;
    var streakTex = this.rtStreakB.texture;
    if (q.bloom) {
      this._passBloom(src, w, h, onScreen);
    }

    // ======================================================== 13. composite ==
    var cu = m.composite.uniforms;
    cu.tSrc.value = src.texture;
    cu.tBloom.value = bloomTex;
    cu.tStreak.value = streakTex;
    cu.tDirt.value = this.lensDirt;
    cu.tExposure.value = this.rtExp[this._expIndex].texture;
    // The metering chain's 1x1 log-average, for the key normalisation in the
    // composite. Written at step 11, two passes upstream of here.
    cu.tLum.value = this.rtLum2.texture;
    cu.uSunUv.value.copy(this._sunUv);
    cu.uSunTint.value.set(_c1.r, _c1.g, _c1.b);
    cu.uAspect.value = w / Math.max(1, h);
    cu.uFrame.value = frame;
    cu.uExposureBias.value = s.exposureBias * todBias;
    cu.uBloom.value = q.bloom ? s.bloomIntensity * (this._bloomNorm || 1) : 0;
    cu.uStreak.value = (q.bloom && q.streak) ? s.streakIntensity : 0;
    cu.uDirt.value = s.dirtIntensity;
    cu.uFlare.value = q.bloom ? s.flareIntensity : 0;
    cu.uSunOnScreen.value = onScreen;

    // Lens response to impulses: a brief dispersion, punch-in and tightening.
    var kick = this.lensKick;
    cu.uCA.value = s.chromaticAberration * (1 + kick * 5.5);
    cu.uDistort.value = s.distortion - kick * 0.012;
    cu.uZoom.value = kick * 0.014;
    cu.uVignette.value = M.clamp(s.vignette + kick * 0.13 + this.hitPulse * 0.16, 0, 0.92);
    cu.uVignetteSoft.value = M.clamp(s.vignetteSoft - this.hitPulse * 0.10, 0.05, 1.0);
    cu.uGrain.value = s.grain;
    // Grain holds a constant ANGULAR size: one grain is s.grainSize output
    // pixels at 720p and scales with the drawing buffer from there. Locked to
    // one output pixel it is sensor noise at 720p and invisible at 4K.
    cu.uGrainSize.value = Math.max(1, (h / 720) * s.grainSize);
    cu.uAgxSat.value = s.agxSaturation;
    // Kept strictly below AgX's own +4.03 EV log clamp so the tone curve never
    // sees a hard-clipped channel; see the roll-off block in FRAG_COMPOSITE.
    cu.uHiKnee.value = Math.max(0.5, s.highlightKnee);
    cu.uHiRange.value = Math.max(0.25, s.highlightRange);
    cu.uContrast.value = s.contrast;
    cu.uPivot.value = s.pivot;
    cu.uPivotTrack.value = M.clamp(s.pivotTrack, 0, 1);
    // A strike releases the cold-source gate on the highlight leg and lends that
    // leg a little extra authority - see settings.flashPaletteRelease. `flashRel`
    // is 0 on every frame of level 1 (no ctx.weather, so _flashAdapt can never
    // leave zero) AND with the market's own flashPaletteRelease of 0, so both
    // lines below reduce to the expressions they replace, exactly.
    var flashRel = (s.flashPaletteRelease > 1e-6)
      ? M.saturate((this._flashAdapt || 0) / s.flashPaletteRelease) : 0;
    cu.uHighWarmGate.value = M.saturate(s.highWarmGate) * (1 - flashRel);
    cu.uFlareAspect.value = M.saturate(s.flareAspect);
    cu.uCASpectral.value = s.caSpectral ? 1 : 0;
    // The CA's dark roll-off. Only meaningful inside the spectral branch, and 0
    // (= off, the shipped path) unless the preset asked for it.
    cu.uCADark.value = s.caSpectral ? Math.max(0, s.caLumFloor || 0) : 0;
    cu.uTexelC.value.set(1 / w, 1 / h);
    // ---- heat shimmer ------------------------------------------------------
    // uHeat 0 unless the level published one, at which point the entire block
    // below - depth fetch, world reconstruction, cell test, noise - is skipped
    // by the shader. See PostFX.prototype.setHeatShimmer.
    var heat = this._heat;
    if (heat && this.hasDepth) {
      cu.uHeat.value = Math.max(0, s.heatAmount) * heat.strength;
      cu.uHeatY.value = heat.y;
      cu.uHeatH0.value = Math.max(0.1, s.heatHeight);
      cu.uHeatH1.value = Math.max(0.2, s.heatHeight + Math.max(0.1, s.heatHeightSoft));
      // METRES OF HOT AIR the ray crossed, not metres to the surface - see
      // pfHeatPath. The level may state its own pair, because the right numbers
      // are a property of the slab's size rather than of the look: a 200 m apron
      // and a 40 m courtyard saturate at very different path lengths, and only
      // the level knows which it is. Absent (every record written so far), the
      // grade preset's heatNear/heatFar carry it exactly as before.
      var hpN = (heat.pathNear === null) ? s.heatNear : heat.pathNear;
      var hpF = (heat.pathFar === null) ? s.heatFar : heat.pathFar;
      cu.uHeatD0.value = Math.max(0.5, hpN);
      cu.uHeatD1.value = Math.max(hpN + 1, hpF);
      cu.uHeatScale.value = Math.max(0.5, s.heatScale);
      cu.uHeatTime.value = time * Math.max(0, s.heatSpeed);
      cu.uHeatCount.value = heat.cells.length;
      for (var hi = 0; hi < heat.cells.length && hi < HEAT_CELL_MAX; hi++) {
        cu.uHeatCells.value[hi].set(heat.cells[hi][0], heat.cells[hi][1], heat.cells[hi][2]);
      }
      // ---- the mirage's colour ---------------------------------------------
      // scene.fog is the atmosphere sky.js established, and every distant
      // surface in the frame is already converging to it - so it is the honest
      // target for light that has been turned over by a hot layer. Normalised to
      // UNIT LUMINANCE, because the composite runs on HDR radiance: an absolute
      // fog colour here would darken a noon frame instead of paling it, and the
      // level term belongs to uHeatLift, which is metered. Degrades to neutral
      // if the level has no fog, which is still a desaturation and a lift.
      //
      // ...WARMED TOWARD THE KEY by heatSkyWarm, and that term was measured into
      // existence rather than chosen. A mirage is grazing-angle sky, so the raw
      // atmosphere colour is the physically literal answer and it printed the far
      // apron at R-B -0.019 against the +0.072 it replaced: a COOL far ground.
      // That is defensible as physics and wrong as photography here, twice over.
      // The near-grazing column over 200 m of noon hardstanding is dust-laden and
      // sun-lit, so what a desert mirage actually reads as is pale warm white,
      // not zenith blue - and this level's grade is built on a sky-blue shadow
      // rotation UNDER a yellow midtone, so putting the sky's own blue into the
      // brightest large area of the frame inverts the split-tone it is made of.
      // The instrument agreed: grade_split fell from +0.0232 to +0.0024 on the
      // signature frame, under analyze.py's 0.0040 floor, on that alone.
      var heatFog = (ctx.scene && ctx.scene.fog && ctx.scene.fog.color) || null;
      var heatSkyW = M.clamp(s.heatSkyWarm, 0, 1);
      var heatR = heatFog ? heatFog.r : 1, heatG = heatFog ? heatFog.g : 1,
          heatB = heatFog ? heatFog.b : 1;
      if (heatSkyW > 1e-4) {
        // _c1 holds the key-light tint for this frame; it was written into
        // uSunTint a few lines above, so it is current and costs nothing here.
        var keyY = 0.2126 * _c1.r + 0.7152 * _c1.g + 0.0722 * _c1.b;
        if (keyY > 1e-4) {
          heatR += (_c1.r / keyY - heatR) * heatSkyW;
          heatG += (_c1.g / keyY - heatG) * heatSkyW;
          heatB += (_c1.b / keyY - heatB) * heatSkyW;
        }
      }
      var heatFogY = 0.2126 * heatR + 0.7152 * heatG + 0.0722 * heatB;
      if (heatFogY > 1e-4) {
        cu.uHeatSky.value.set(heatR / heatFogY, heatG / heatFogY, heatB / heatFogY);
      } else {
        cu.uHeatSky.value.set(1, 1, 1);
      }
      cu.uHeatCellFloor.value = M.clamp(s.heatCellFloor, 0, 1);
      // THE MIRAGE HAS ITS OWN SCALAR. It used to be `heat.strength`, the same
      // number that scales the displacement, which is what forced a level asking
      // for a readable boil to accept a proportional paint-over of its far field
      // (see normaliseHeat). `mirage` defaults to `strength`, so a record that
      // does not mention it is unchanged to the bit.
      cu.uHeatPale.value = M.clamp(s.heatPale, 0, 1) * heat.mirage;
      cu.uHeatLift.value = Math.max(0.25, s.heatLift);
      cu.tDepth.value = depthTex;
      cu.tViewDepthC.value = (viewOk && this.rtView.depthTexture)
        ? this.rtView.depthTexture : this.whiteTex;
      cu.uHasViewC.value = (viewOk && this.rtView.depthTexture) ? 1 : 0;
      cu.uInvViewProj.value.copy(this._invViewProj);
      cu.uCamPos.value.copy(camPos);
    } else {
      cu.uHeat.value = 0;
      cu.uHeatCount.value = 0;
      cu.uHeatPale.value = 0;
      cu.uHasViewC.value = 0;
      cu.tDepth.value = depthTex || this.whiteTex;
      cu.tViewDepthC.value = this.whiteTex;
    }
    cu.uGrainShadowLo.value = Math.max(0, s.grainShadowLo);
    cu.uGrainShadowHi.value = Math.max(0, s.grainShadowHi);
    cu.uGrainShadowFloor.value = M.clamp(s.grainShadowFloor, 0, 1);
    cu.uWhite.value = Math.max(1.02, s.whitePoint);
    cu.uAds.value = M.saturate(this._adsBlend || 0);
    cu.uSaturation.value = s.saturation;
    cu.uScotopic.value = M.clamp(s.scotopic, 0, 1);
    cu.uKeyRef.value = Math.max(1e-5, s.exposureRefGain * s.exposureRefAvg * s.gradeKeyRefScale);
    cu.uKeyExp.value = M.clamp(s.gradeKeyExp, 0.1, 1.0);
    cu.uGrainLowKey.value = Math.max(0, s.grainLowKey);
    cu.uToeBlack.value = M.clamp(s.toeBlackScale, 0.5, 2.0);
    cu.uToeFloor.value = M.clamp(s.toeFloorScale, 0.5, 3.0);
    cu.uToeRelax.value = Math.max(0, s.toeRelax || 0);
    cu.uDebug.value = s.debugProbe ? 1 : 0;
    cu.uOffsetY.value = Math.max(0, s.printerBlack);
    cu.uLift.value.copy(s.lift);
    cu.uShadowChroma.value.set(s.shadowChroma.r, s.shadowChroma.g, s.shadowChroma.b);
    cu.uShadowChromaAmt.value = M.clamp(s.shadowChromaAmount, 0, 1);
    cu.uGamma.value.copy(s.gamma);
    cu.uGain.value.copy(s.gain);
    cu.uShadowTint.value.set(s.shadowTint.r, s.shadowTint.g, s.shadowTint.b);
    cu.uMidTint.value.set(s.midTint.r, s.midTint.g, s.midTint.b);
    cu.uHighTint.value.set(s.highTint.r, s.highTint.g, s.highTint.b);
    cu.uShadowSat.value = M.clamp(s.shadowSat, 0, 1);
    // 1.0 (the authored default, and both frozen levels) branches the block out
    // of the shader entirely - see pfGrade.
    cu.uMidSat.value = M.clamp(s.midSat === undefined ? 1 : s.midSat, 0, 1.5);
    cu.uShadowAmt.value = s.shadowAmount;
    cu.uMidAmt.value = s.midAmount;
    cu.uHighAmt.value = s.highAmount * (1 + Math.max(0, s.flashHighBoost || 0) * flashRel);
    cu.uFlash.value = M.clamp(this.flash + this._flashShot, 0, 2);
    cu.uHit.value = M.saturate(this.hitPulse);

    // ---- storm ------------------------------------------------------------
    // fa is 0 on every frame of level 1 (no ctx.weather => _updateWeather can
    // never raise it), so uFlashComp is exactly 1.0 and uRainLens is exactly 0.
    // fc is the RELEASE-ONLY follower (see _updateWeather): zero while the
    // strike is actually arriving, so the frame prints uncompressed and clips as
    // ART_DIRECTION_HARBOR says it may, and non-zero for the ~0.4 s afterwards,
    // which is where the dazzle actually is.
    var fa = this._flashAdapt;
    var fc = this._flashComp || 0;
    cu.uFlashComp.value = 1 / (1 + Math.max(0, s.lightningCompress) * fc);
    // (1 + lift*fa) / (1 + comp*fa). Both terms 0 on the market, where fa is 0
    // in any case, so this is exactly 1.0 / 1.0 - the same bits it was.
    cu.uKeyFlash.value = (1 + Math.max(0, s.keyFlashLift || 0) * fa) /
                         (1 + Math.max(0, s.keyFlashComp) * fa);
    cu.uRainLens.value = this._rainLens;
    cu.uRainTime.value = time;
    cu.uRainScale.value = Math.max(2, s.rainLensScale);
    cu.uRainDensity.value = M.saturate(s.rainLensDensity);
    cu.uRainStrength.value = Math.max(0, s.rainLensStrength);
    cu.uRainEdge.value = M.clamp(s.rainLensEdge, 0, 1.1);
    cu.uRainStreak.value.copy(this._lensStreak);
    // The strike also compresses the highlights, not just the stop: a 7000 K
    // wall of light on wet steel has to keep a gradient across its core or the
    // frame reads as a white card, which is the failure the brief names.
    // ...and it rolls off on the RELEASE too. Closing the shoulder on the frame
    // the flash arrives is the same error as closing the stop there: it is what
    // turned a 1/20 s freeze of a 7000 K wall of light into flat overcast day.
    cu.uHiKnee.value = Math.max(0.5, cu.uHiKnee.value * (1 - M.saturate(s.lightningHighlight * fc)));

    this._pass(m.composite, null);

    // ---- bookkeeping -------------------------------------------------------
    this._prevViewProj.copy(this._curViewProj);
    r.setRenderTarget(null);
  };

  // --------------------------------------------------------------------------
  // Per-frame storm derivations: the SSR environment fallback and the lens
  // streak vector. Harbor only; nothing here is called on a market frame.
  // --------------------------------------------------------------------------
  var _envTmp = new THREE.Vector3();
  var _fwdTmp = new THREE.Vector3();
  var _v4b = new THREE.Vector4();
  var _v4c = new THREE.Vector4();

  PostFX.prototype._updateStormFrame = function (ctx, camPos, cam) {
    var s = this.settings;

    // ---- the "IBL" a missed ray falls back to ------------------------------
    // scene.fog.color is the aerial-perspective radiance sky.js solved for this
    // sky, i.e. what a ray that escapes the frustum eventually integrates to. It
    // is used 1:1. An earlier version scaled it by 0.13 on the assumption that
    // sky.js's r/(1+r) normalisation made it a hue rather than a level; probed
    // on the real stack it comes out at (0.0086, 0.0118, 0.0155) for the storm
    // deck, which IS the level - the scale factor was quietly deleting the
    // reflected sky and, worse, leaving the downward term (which had an absolute
    // floor) BRIGHTER than the upward one, so the apron reflected a sky darker
    // than the ground beneath it.
    _envTmp.set(0.010, 0.013, 0.017);
    try {
      var fog = ctx.scene && ctx.scene.fog;
      if (fog && fog.color) _envTmp.set(fog.color.r, fog.color.g, fog.color.b);
      else if (ctx.sky && ctx.sky.skyColor) {
        _envTmp.set(ctx.sky.skyColor.r, ctx.sky.skyColor.g, ctx.sky.skyColor.b);
      }
    } catch (e) { /* keep the authored default */ }
    if (!isFinite(_envTmp.lengthSq())) _envTmp.set(0.010, 0.013, 0.017);

    var envK = Math.max(0, s.ssrEnvIntensity);
    this._envSky.set(_envTmp.x * envK, _envTmp.y * envK, _envTmp.z * envK);
    // Downward reflections see the quay, the water and the underside of the
    // stacks. A fraction of the dome, and never more than it - plus a floor of
    // a few ten-thousandths so a reflection can never reach zero. ART_DIRECTION
    // is explicit that deep is correct and detail-free is not.
    this._envGround.set(this._envSky.x * 0.28 + 0.00040,
                        this._envSky.y * 0.28 + 0.00046,
                        this._envSky.z * 0.28 + 0.00058);

    // ---- camera-induced screen motion, for the droplet streaks -------------
    // The screen displacement of a static point 10 m ahead, between last frame
    // and this one. That is exactly what drags water across a real front
    // element, and it comes free out of the matrices the velocity pass already
    // needs. Smoothed, because a single-frame value is jittery at 60 Hz and a
    // droplet has mass.
    var sx = 0, sy = 0;
    try {
      _fwdTmp.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      _v4b.set(camPos.x + _fwdTmp.x * 10, camPos.y + _fwdTmp.y * 10,
               camPos.z + _fwdTmp.z * 10, 1);
      var cur = _v4c.copy(_v4b).applyMatrix4(this._curViewProj);
      var prv = _v4b.applyMatrix4(this._historyValid ? this._prevViewProj : this._curViewProj);
      if (cur.w > 1e-4 && prv.w > 1e-4) {
        sx = (cur.x / cur.w - prv.x / prv.w) * 0.5;
        sy = (cur.y / cur.w - prv.y / prv.w) * 0.5;
      }
    } catch (e) { sx = 0; sy = 0; }
    if (!isFinite(sx) || !isFinite(sy)) { sx = 0; sy = 0; }
    var k = Math.max(0, s.rainLensStreak);
    this._lensStreak.x = M.damp(this._lensStreak.x, M.clamp(sx * k, -2, 2), 9.0, ctx.dt || 1 / 60);
    this._lensStreak.y = M.damp(this._lensStreak.y, M.clamp(sy * k, -2, 2), 9.0, ctx.dt || 1 / 60);
  };

  // --------------------------------------------------------------------------
  // Pick the practicals that actually light the medium in front of the camera
  // and hand them to the volumetric march.
  //
  // The shader integrates six at most, so the choice matters more than the
  // count: a terminal has twenty-odd masts and floods, and the ones worth the
  // slots are the ones whose sphere of influence the VIEW RAY passes through -
  // which is not the same as the ones nearest the camera, and definitely not
  // the same as the ones on screen (a mast just outside the frame still fills
  // the air in front of you). The score below is "how much of this lamp's
  // medium can this frame see": its intensity, penalised once it is further
  // away than its own range and again, gently, with distance.
  //
  // Everything is read defensively. lighting.js owns these lights, it rebuilds
  // them when the level publishes its own placements, and it is entirely
  // possible for the list to be empty, half-built, or full of lights with no
  // target - none of which may throw out of render().
  // --------------------------------------------------------------------------
  var _pwPos = new THREE.Vector3();
  var _pwTgt = new THREE.Vector3();

  PostFX.prototype._collectPracticals = function (ctx, camPos) {
    var vu = this.mat.volume.uniforms;
    // The SSR resolve wants the same six lamps for its analytic water lobe, but
    // it wants their RAW radiant intensity - the volumetric's copy is premultipled
    // by the scattering albedo and the march's own gain, which are its business
    // and not a surface BRDF's.
    var au = this.mat.ssrApply.uniforms;
    var s = this.settings;
    var maxN = Math.max(0, Math.min(6, s.volumePracticalCount | 0));
    var n = 0;

    // The market never reaches the body (volumePracticalCount is 0, so maxN is
    // 0 and the && short-circuits before either flag is read) and the harbor
    // takes the first term, so both frozen levels are bit-identical. The second
    // term is what lets an INTERIOR preset light the medium: with no sky there
    // is no key, and the harbor round already measured what a key-only march
    // contributes to a level whose key is dark - nothing, not one pixel.
    if (maxN > 0 && (this._harbor || s.volumePracticals > 0)) {
      // Slots are allocated once and refilled in place - this runs every frame
      // and six object literals a frame is six object literals a frame.
      var picks = this._pracPicks;
      if (!picks) {
        picks = this._pracPicks = [];
        for (var p0 = 0; p0 < 6; p0++) picks.push({ L: null, s: -1 });
      }
      var used = 0;
      try {
        var list = (ctx.lighting && ctx.lighting.practicals) || null;
        var reach = Math.max(20, s.volumeMaxDist);
        var i, j;
        for (i = 0; list && i < list.length; i++) {
          var rec = list[i];
          var L = rec && rec.light;
          if (!L || L.visible === false) continue;
          var inten = L.intensity;
          if (!(inten > 1e-3) || !isFinite(inten)) continue;
          var range = (typeof L.distance === 'number' && L.distance > 0.5) ? L.distance : 24;
          L.getWorldPosition(_pwPos);
          var dx = _pwPos.x - camPos.x, dy = _pwPos.y - camPos.y, dz = _pwPos.z - camPos.z;
          var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (!isFinite(d) || d > range + reach) continue;
          var score = inten / ((1 + Math.max(0, d - range) * 3) * (1 + d * 0.06));
          // Insertion into a fixed-size top-N; no sort, no allocation.
          if (used < maxN) {
            picks[used].L = L; picks[used].s = score; used++;
          } else {
            var worst = 0;
            for (j = 1; j < used; j++) if (picks[j].s < picks[worst].s) worst = j;
            if (score > picks[worst].s) { picks[worst].L = L; picks[worst].s = score; }
          }
        }

        var gain = Math.max(0, s.volumePracticalGain) * Math.max(0, s.volumeScatterAlbedo);
        for (i = 0; i < used; i++) {
          var lp = picks[i].L;
          lp.getWorldPosition(_pwPos);
          var rr = (typeof lp.distance === 'number' && lp.distance > 0.5) ? lp.distance : 24;
          vu.uPracPos.value[n].set(_pwPos.x, _pwPos.y, _pwPos.z, rr);

          var k = lp.intensity * gain;
          // -2 in .w is the "no cone" marker the shader tests for.
          var cosOuter = -2.0, cosInner = -2.0;
          var ax = 0, ay = -1, az = 0;
          if (lp.isSpotLight) {
            var ang = M.clamp(lp.angle || 0.6, 0.02, Math.PI * 0.5 - 0.01);
            var pen = M.clamp(lp.penumbra || 0, 0, 1);
            cosOuter = Math.cos(ang);
            cosInner = Math.cos(ang * (1 - pen));
            // A degenerate penumbra collapses the smoothstep to a step and the
            // cone edge aliases; keep a sliver of falloff whatever is authored.
            if (cosInner <= cosOuter + 1e-4) cosInner = Math.min(1, cosOuter + 1e-3);
            if (lp.target) {
              lp.target.getWorldPosition(_pwTgt);
              _pwTgt.sub(_pwPos);
              var tl = _pwTgt.length();
              if (tl > 1e-4) { ax = _pwTgt.x / tl; ay = _pwTgt.y / tl; az = _pwTgt.z / tl; }
            }
          }
          vu.uPracCol.value[n].set(lp.color.r * k, lp.color.g * k, lp.color.b * k, cosOuter);
          vu.uPracAxis.value[n].set(ax, ay, az, cosInner);
          au.uPracPos.value[n].set(_pwPos.x, _pwPos.y, _pwPos.z, rr);
          au.uPracCol.value[n].set(lp.color.r * lp.intensity,
                                   lp.color.g * lp.intensity,
                                   lp.color.b * lp.intensity, 0);
          n++;
        }
      } catch (e) {
        // A malformed rig degrades to "no local inscatter", never to a throw.
        n = 0;
      }
    }

    vu.uPracCount.value = n;
    au.uPracCount.value = (s.ssrPracticalGain > 1e-4) ? n : 0;
    au.uPracGain.value = Math.max(0, s.ssrPracticalGain);
    au.uPracRough.value = M.clamp(s.ssrPracticalRough, 0, 0.6);
    au.uPracClamp.value = Math.max(0.05, s.ssrPracticalClamp);
    au.uPracFloor.value = M.clamp(s.ssrPracticalFloor, 0.0, 0.9);
    this._pracCount = n;
    return n;
  };

  // --------------------------------------------------------------------------
  // Bind lighting.js's cascaded shadow maps into the volumetric material.
  //
  // The alternative - screen-space depth probes toward the sun - cannot see the
  // building that is casting the shaft unless it happens to be on screen, and
  // with three probes it quantises visibility to four values. That produced a
  // smooth near-uniform additive term, i.e. more haze, never a shaft. Sampling
  // the cascade the point actually lands in gives binary per-step occlusion
  // against real geometry, which is what carves a beam.
  //
  // Entirely defensive: lighting.js owns those maps, they do not exist until it
  // has rendered once, and if anything is missing we fall straight back.
  // --------------------------------------------------------------------------
  PostFX.prototype._bindShadows = function (ctx) {
    var vu = this.mat.volume.uniforms;
    var maps = vu.uShadowMap.value;
    var mats = vu.uShadowMatrix.value;
    var n = 0;
    try {
      var cs = ctx && ctx.lighting && ctx.lighting.cascades;
      if (cs && cs.length) {
        for (var i = 0; i < cs.length && n < 4; i++) {
          var lt = cs[i] && cs[i].light;
          if (!lt || lt.castShadow === false || lt.visible === false) continue;
          var sh = lt.shadow;
          if (!sh || !sh.map || !sh.map.texture || !sh.matrix) continue;
          maps[n] = sh.map.texture;
          mats[n].copy(sh.matrix);
          n++;
        }
      }
    } catch (e) {
      // A malformed cascade list must degrade, never throw out of render().
      n = 0;
    }
    for (var j = n; j < 4; j++) maps[j] = this.whiteTex;
    vu.uShadowCount.value = n;
    this._shadowCount = n;
    return n;
  };

  // --------------------------------------------------------------------------
  // Auto exposure: three tiny reductions plus a 1x1 ping-pong adaptation.
  // Kept entirely on the GPU - a readPixels round trip would stall the pipeline
  // every single frame for one float.
  // --------------------------------------------------------------------------
  PostFX.prototype._passExposure = function (src, dt) {
    var m = this.mat, s = this.settings;

    var ld = m.lumDown.uniforms;
    ld.tSrc.value = src.texture;
    // Last frame's adapted gain, as the threshold for the percentile trim. A
    // 1x1 that moves at the adaptation rate, so the cut cannot chase content.
    ld.tPrevExp.value = this.rtExp[this._expIndex].texture;
    ld.uTrim.value = s.meterTrim ? 1 : 0;
    ld.uTrimLo.value = Math.max(0.05, s.meterTrimLo);
    ld.uTrimHi.value = Math.max(s.meterTrimLo + 0.05, s.meterTrimHi);
    ld.uLumFloor.value = Math.max(1e-6, s.meterLumFloor);
    ld.uSrcTexel.value.set(0.5 / 64, 0.5 / 64);
    this._pass(m.lumDown, this.rtLum0);

    var lr = m.lumReduce.uniforms;
    lr.tSrc.value = this.rtLum0.texture;
    lr.uSrcTexel.value.set(1 / 64, 1 / 64);
    lr.uTaps.value = 8;
    this._pass(m.lumReduce, this.rtLum1);

    lr.tSrc.value = this.rtLum1.texture;
    lr.uSrcTexel.value.set(1 / 8, 1 / 8);
    lr.uTaps.value = 8;
    this._pass(m.lumReduce, this.rtLum2);

    var read = this.rtExp[this._expIndex];
    var write = this.rtExp[1 - this._expIndex];
    var eu = m.exposure.uniforms;
    eu.tLum.value = this.rtLum2.texture;
    eu.tPrev.value = read.texture;
    // uKey/uAnchor carry the (refGain, refAvg) pivot: uKey/uAnchor is the gain
    // the reference framing receives and uAnchor is the scene average it was
    // measured at. See settings.exposureRefAvg.
    eu.uAnchor.value = Math.max(1e-4, s.exposureRefAvg);
    eu.uKey.value = s.exposureRefGain * eu.uAnchor.value;
    eu.uSlope.value = M.clamp(s.exposureSlope, 0, 1);
    eu.uMin.value = s.exposureMin;
    eu.uMax.value = s.exposureMax;
    eu.uSpeedUp.value = s.adaptUp;
    eu.uSpeedDown.value = s.adaptDown;
    // Freeze the meter while lightning is firing. 1.0 (no freeze) on every
    // frame that has no ctx.weather, i.e. all of level 1.
    eu.uHoldScale.value = 1 / (1 + Math.max(0, s.lightningMeterHold) * this._flashAdapt);
    eu.uDt.value = dt;
    // Snap for the first few frames: a freshly allocated 1x1 target holds
    // garbage, and captures only ever render a handful of frames.
    eu.uReset.value = this._exposureResetFrames > 0 ? 1 : 0;
    if (this._exposureResetFrames > 0) this._exposureResetFrames--;
    this._pass(m.exposure, write);
    this._expIndex = 1 - this._expIndex;
  };

  // --------------------------------------------------------------------------
  // Bloom: soft-knee bright pass, then progressive down/up sampling. The
  // upsample is additive into the finer mip, which is what produces the wide,
  // smooth energy falloff a single gaussian cannot afford.
  // --------------------------------------------------------------------------
  PostFX.prototype._passBloom = function (src, w, h, onScreen) {
    var m = this.mat, s = this.settings;
    var mips = this.rtBloom, sizes = this._bloomSizes;

    var bu = m.bright.uniforms;
    bu.tSrc.value = src.texture;
    bu.tExposure.value = this.rtExp[this._expIndex].texture;
    bu.uTexel.value.set(1 / w, 1 / h);
    bu.uThreshold.value = s.bloomThreshold;
    bu.uKnee.value = Math.max(1e-3, s.bloomKnee);
    // Never below the threshold, or the bright pass would cap the very energy
    // it is selecting for and the pass would output a constant.
    bu.uClamp.value = Math.max(s.bloomThreshold + 0.05, s.bloomClamp);
    this._pass(m.bright, mips[0]);

    var i;
    var du = m.downsample.uniforms;
    for (i = 0; i < mips.length - 1; i++) {
      du.tSrc.value = mips[i].texture;
      du.uTexel.value.set(1 / sizes[i].x, 1 / sizes[i].y);
      this._pass(m.downsample, mips[i + 1]);
    }

    var uu = m.upsample.uniforms;
    uu.uRadius.value = s.bloomRadius;
    // One constant attenuation per level, so mip n arrives at mip 0 scaled by
    // k^n: a bright tight core with a decaying skirt, instead of six equal
    // copies of the bright pass smeared over each other.
    uu.uMipWeight.value = M.clamp(s.bloomMipFalloff, 0.05, 1.0);
    for (i = mips.length - 2; i >= 0; i--) {
      uu.tSrc.value = mips[i + 1].texture;
      uu.uTexel.value.set(1 / sizes[i + 1].x, 1 / sizes[i + 1].y);
      this._pass(m.upsample, mips[i]);   // additive
    }
    if (this.q.streak && onScreen > 0.001) {
      var st = m.streak.uniforms;
      st.uDir.value.set(1, 0);
      st.uTexel.value.set(1 / this._streakSize.x, 1 / this._streakSize.y);
      st.uSpread.value = 1.0;
      st.tSrc.value = mips[0].texture;
      this._pass(m.streak, this.rtStreakA);

      st.tSrc.value = this.rtStreakA.texture;
      st.uSpread.value = s.streakSpread;
      this._pass(m.streak, this.rtStreakB);
    }
  };

  GAME.PostFX = PostFX;
})(window.GAME, window.THREE);
