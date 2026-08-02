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
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

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
    COMMON,
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
      meterLumFloor: 0.0005
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
    this._harbor = !!(ctx && (ctx.levelId === 'harbor' ||
      (ctx.levelDef && ctx.levelDef.weather === 'storm')));
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

  /**
   * @param {string} name  'market' (the authored default) | 'storm'
   */
  PostFX.prototype.setGradePreset = function (name) {
    if (name !== 'storm') { this.gradePreset = 'market'; return this; }
    var s = this.settings;
    // The grade's key normalisation is an ABSOLUTE reference - "how low-key is
    // this frame against a noon one" - while the metering reference above is a
    // per-level calibration. They are multiplied into the same uKeyRef, so
    // re-pivoting the meter onto a night average would otherwise tell pfGrade
    // that a storm night is a noon frame and hand it the noon toe, which is a
    // shelf that would crush three quarters of this level. Solving the scale
    // back out holds uKeyRef at exactly the value it has in the market.
    var keyRef = s.exposureRefGain * s.exposureRefAvg * s.gradeKeyRefScale;
    for (var k in STORM_GRADE) {
      if (!Object.prototype.hasOwnProperty.call(STORM_GRADE, k)) continue;
      var v = STORM_GRADE[k];
      if (v && v.isColor) s[k] = v.clone();
      else if (v && v.isVector3) s[k] = v.clone();
      else s[k] = v;
    }
    s.gradeKeyRefScale = keyRef / Math.max(s.exposureRefGain * s.exposureRefAvg, 1e-6);
    this.gradePreset = 'storm';
    // _bloomNorm is derived from bloomMipFalloff at allocation time.
    if (this._targets) {
      try { this._allocate(this._size.x | 0, this._size.y | 0); }
      catch (e) { GAME.logError('postfx.setGradePreset', e); }
    }
    return this;
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
      uShadowSat: U(s.shadowSat),
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
      uFlareAspect: U(s.flareAspect), uKeyFlash: U(1)
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

  PostFX.prototype.setFocus = function (dist) {
    this._focusOverride = (typeof dist === 'number' && dist > 0) ? dist : null;
    return this;
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
    if (this._focusOverride) {
      target = this._focusOverride;
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
    // Focus pull has weight; snapping between distances looks like a bug.
    this._focus = M.damp(this._focus, this._focusTarget, ads ? 7.0 : 3.5, dt);
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
    cu.uTexelC.value.set(1 / w, 1 / h);
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

    if (maxN > 0 && this._harbor) {
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
