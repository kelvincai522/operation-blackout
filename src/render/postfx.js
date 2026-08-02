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
//   volumetrics                 world-space raymarch, per-step CSM occlusion
//   resolve                     AO into indirect + bilateral inscatter upsample
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
    '',
    'const int PF_VOL_MAX = 32;',
    'const int PF_SHADOW_MAX = 3;',
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
    '  k *= 1.0 - smoothstep( 0.34, 0.62, pfLum( mx - mn ) );',
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
    'void main() {',
    '  vec3 sharp = pfSafe( texture2D( tSrc, vUv ).rgb );',
    '  float coc = pfCoC( pfSceneZ( vUv, pfLinearDepth( texture2D( tDepth, vUv ).x ) ) );',
    '  vec4 blur = texture2D( tBlur, vUv );',
    '  // Near coverage comes from the half-res gather so foreground blur can',
    '  // spill over sharp background, which is how a real lens behaves.',
    '  // Below 0.03 CoC the sharp image is returned untouched - literally the',
    '  // same bits - so DoF can never cost micro-contrast where it buys nothing.',
    '  float t = smoothstep( 0.03, 0.22, max( coc, blur.a ) );',
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
    'uniform vec2 uSrcTexel;',
    'void main() {',
    '  float sum = 0.0;',
    '  float lw = 0.0;',
    '  for ( int y = 0; y < 2; y++ ) {',
    '    for ( int x = 0; x < 2; x++ ) {',
    '      vec2 o = ( vec2( float( x ), float( y ) ) - 0.5 ) * uSrcTexel * 2.0;',
    '      vec3 c = pfSafe( texture2D( tSrc, vUv + o ).rgb );',
    '      float l = max( pfLum( c ), 0.0005 );',
    '      // Karis-style highlight rejection. A plain log average lets the blown',
    '      // hazy vanishing point at the end of the street set the exposure for',
    '      // the whole frame, which drops the stop and craters the asphalt - the',
    '      // "sky white / ground black" inversion in one line.',
    '      float w = 1.0 / ( 1.0 + l * 0.35 );',
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
    '  float speed = target < prev ? uSpeedDown : uSpeedUp;',
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
    '  c *= mix( vec3( 1.0 ), uHighTint,   hi * uHighAmt );',
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
    '  float pivotEff = uPivot * mix( 1.0, clamp( knD, 0.2, 1.6 ), 0.8 );',
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
    '  float knT = clamp( knD, 0.2, 1.0 );',
    '  float asym = max( 0.044, 0.052 * mix( 1.0, knT, 0.30 ) );',
    '  float floorEff = max( asym + 0.014, 0.092 * mix( 1.0, knT, 0.85 ) );',
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
    '  // Radial chromatic aberration. Real lenses disperse more off-axis, so',
    '  // the offset scales with r^2 and stays invisible at the centre.',
    '  float ca = uCA * r2;',
    '  vec2 caDir = d * ca;',
    '  vec3 color;',
    '  if ( ca > 1e-5 ) {',
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
    '  float keyNorm = clamp( exposure * uExposureBias * avgLum / max( uKeyRef, 1e-4 ), 0.12, 3.0 );',
    '  // ...expressed in the display domain. AgX is log-compressed, so a factor k',
    '  // of scene light is worth far less than k on the print; uKeyExp is that',
    '  // compression, measured rather than assumed.',
    '  float knD = clamp( pow( keyNorm, uKeyExp ), 0.28, 1.6 );',
    '',
    '  // uAds lifts the stop a touch when the sights come up - the "world gets a',
    '  // little brighter and tighter" cue. Paired with the optic falloff below.',
    '  float postGain = uExposureBias * ( 1.0 + uFlash * 2.4 ) * ( 1.0 + uAds * 0.11 );',
    '  color *= exposure * postGain;',
    '',
    '  if ( uDebug > 0.5 && gl_FragCoord.y < 2.0 && gl_FragCoord.x < 6.0 ) {',
    '    // Tuning probe (settings.debugProbe, off by default). The tone chain is',
    '    // entirely GPU-side and a readPixels round trip every frame is not an',
    '    // option, so the six pixels in the bottom-left corner can be asked to',
    '    // carry the metering state out to a capture instead. Returns BEFORE the',
    '    // colorspace encode so the bytes are read back exactly.',
    '    float idx = floor( gl_FragCoord.x );',
    '    float v = 0.0;',
    '    if ( idx < 1.0 ) v = exposure / 8.0;',
    '    else if ( idx < 2.0 ) v = ( log2( max( avgLum, 1e-9 ) ) + 20.0 ) / 24.0;',
    '    else if ( idx < 3.0 ) v = uExposureBias * 0.5;',
    '    else if ( idx < 4.0 ) v = keyNorm / 3.0;',
    '    else if ( idx < 5.0 ) v = knD / 2.0;',
    '    else v = pfLum( color );',
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
    '    for ( int i = 1; i <= 3; i++ ) {',
    '      float s = float( i ) * 0.62;',
    '      vec2 guv = clamp( uSunUv + toCentre * ( 1.0 + s ), vec2( 0.0 ), vec2( 1.0 ) );',
    '      float fall = 1.0 - clamp( length( uv - guv ) * ( 6.0 + float( i ) * 4.0 ), 0.0, 1.0 );',
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
      hitTint: new THREE.Color(1.0, 0.34, 0.28)
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

    if (!ctx || !ctx.renderer || !THREE) {
      GAME.logError('postfx', 'missing renderer; post-processing disabled');
      return;
    }

    this.renderer = ctx.renderer;
    // A private RNG: consuming from ctx.rng would shift every downstream
    // system's random stream and break capture determinism.
    this.rng = new GAME.RNG(((ctx.seed || 20260801) ^ 0x9e3779b1) >>> 0);

    this.setQuality(ctx.quality);

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
      uSteps: U(20), uShadowTaps: U(2)
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

    m.taa = makeMat(FRAG_TAA, {
      tCurrent: U(null), tHistory: U(null), tVelocity: U(null), tDepth: U(null),
      uTexel: U(new THREE.Vector2()),
      uFeedbackMin: U(s.taaFeedbackMin), uFeedbackMax: U(s.taaFeedbackMax),
      uVarianceGamma: U(s.taaVarianceGamma),
      uHistoryValid: U(0)
    });

    m.sharpen = makeMat(FRAG_SHARPEN, {
      tSrc: U(null), uTexel: U(new THREE.Vector2()), uAmount: U(s.taaSharpen)
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
      tSrc: U(null), uSrcTexel: U(new THREE.Vector2())
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
      uGrainLowKey: U(s.grainLowKey), uDebug: U(0),
      uOffsetY: U(s.printerBlack), uLift: U(s.lift.clone()),
      uShadowChroma: U(new THREE.Vector3(0.86, 0.98, 1.16)),
      uShadowChromaAmt: U(s.shadowChromaAmount),
      uGamma: U(s.gamma.clone()), uGain: U(s.gain.clone()),
      uShadowTint: U(new THREE.Vector3()), uMidTint: U(new THREE.Vector3()),
      uHighTint: U(new THREE.Vector3()),
      uShadowSat: U(s.shadowSat),
      uShadowAmt: U(s.shadowAmount), uMidAmt: U(s.midAmount), uHighAmt: U(s.highAmount),
      uFlashTint: U(new THREE.Vector3()), uFlash: U(0), uHit: U(0)
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
  // Dispatch helper
  // --------------------------------------------------------------------------
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
      var hIdx = (frame % 8) + 1;
      jx = (halton(hIdx, 2) - 0.5) * 2.0 / w;
      jy = (halton(hIdx, 3) - 0.5) * 2.0 / h;
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
      if (fog && typeof fog.density === 'number' && fog.density > 0) {
        dens = M.clamp(Math.max(fog.density * 1.35, s.volumeDensity * 0.75), 0.008, 0.075);
      }
      vu.uDensity.value = dens;
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
    cu.uWhite.value = Math.max(1.02, s.whitePoint);
    cu.uAds.value = M.saturate(this._adsBlend || 0);
    cu.uSaturation.value = s.saturation;
    cu.uScotopic.value = M.clamp(s.scotopic, 0, 1);
    cu.uKeyRef.value = Math.max(1e-5, s.exposureRefGain * s.exposureRefAvg * s.gradeKeyRefScale);
    cu.uKeyExp.value = M.clamp(s.gradeKeyExp, 0.1, 1.0);
    cu.uGrainLowKey.value = Math.max(0, s.grainLowKey);
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
    cu.uHighAmt.value = s.highAmount;
    cu.uFlash.value = M.clamp(this.flash + this._flashShot, 0, 2);
    cu.uHit.value = M.saturate(this.hitPulse);

    this._pass(m.composite, null);

    // ---- bookkeeping -------------------------------------------------------
    this._prevViewProj.copy(this._curViewProj);
    r.setRenderTarget(null);
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
