// ============================================================================
// OPERATION BLACKOUT - lighting rig + cascaded shadow maps
// Owner: src/render/lighting.js  ->  GAME.Lighting
//
// ---------------------------------------------------------------------------
// HOW THE CSM WORKS HERE (read this before changing anything)
// ---------------------------------------------------------------------------
// three.js core has no cascaded shadow maps and examples/jsm does not exist in
// this build, so the whole thing is implemented in this file in two halves:
//
//   1. JS half - N THREE.DirectionalLight instances share one direction. Light
//      0 is the real sun (it carries the colour + intensity). Lights 1..N-1
//      carry a BLACK colour, so they contribute no light at all; they exist
//      purely so three.js allocates and renders a shadow map + shadow matrix
//      for each cascade and hands them to the fragment shader as
//      `directionalShadowMap[i]` / `vDirectionalShadowCoord[i]`.
//
//   2. GLSL half - we patch two of three's built-in ShaderChunks *once, at
//      script load*, before any material has compiled:
//        - `shadowmap_pars_fragment` gains `csmShadowAt()` + `getCSMShadow()`
//        - `lights_fragment_begin` calls `getCSMShadow()` for directional
//          light 0 and skips three's per-light `getShadow()` for 1..N-1.
//      Crucially this introduces NO new uniforms. Everything the cascade
//      selector needs (shadow map, matrix, bias, radius, map size, intensity)
//      already exists per-light in three's own uniform blocks. That is what
//      makes it safe: any other agent's ShaderMaterial that includes these
//      chunks still compiles, and a scene with a single directional shadow
//      just degrades to one very well filtered cascade.
//
// CASCADE SELECTION is by shadow-map bounds, walking near -> far and taking
// the first cascade that contains the fragment. That avoids needing a
// split-distance uniform array, and it naturally prefers the highest-density
// map available for a given fragment. A fade band over the outer ~14% of each
// cascade cross-fades into the next one (and into "lit" for the last cascade),
// so there is no visible seam and no hard end to the shadow range.
//
// STABILITY: each cascade is fitted to the BOUNDING SPHERE of its camera
// sub-frustum, not to an AABB. A sphere is rotation invariant, so the ortho
// extents never change while the player looks around -> no swimming. The
// sphere centre is then SNAPPED to whole shadow texels in light space, which
// is what stops the shadow edges from crawling as the player walks. Both of
// these are mandatory; drop either and the shadows shimmer.
//
// BIAS: normal-offset bias (per cascade, ~1 texel of world size, applied by
// three in the vertex shader along the world normal) does the heavy lifting
// because it does not cause peter-panning. On top of that a small constant
// depth bias is scaled by the surface slope in the fragment shader, so
// grazing surfaces get more bias and flat-on surfaces stay contact-tight.
//
// FILTERING: rotated Poisson-disk PCF with a PCSS-style blocker search, so
// shadows harden at the contact point and soften with occluder distance. The
// penumbra-scale constant is folded into the per-light `shadowRadius` uniform
// (see _applyCascadeShadowParams) which is why no extra uniform is needed.
//
// ---------------------------------------------------------------------------
// THE SKY-VISIBILITY VOLUME (read this before touching the ambient terms)
// ---------------------------------------------------------------------------
// A hemisphere light, an ambient light, a PMREM environment and a couple of
// bounce directionals are all INFINITE, UNOCCLUDED terms. Left alone they give
// a sealed shop interior exactly the same ambient as an open rooftop, which is
// how a build ends up with a deck that is darker than the parapet above it and
// a room that is brighter at the back than at its own window. Screen-space AO
// cannot fix that - a 1 m kernel cannot express room-scale light separation.
//
// So this module bakes a coarse SKY-VISIBILITY FIELD once, at runtime, and
// multiplies every indirect term by it per fragment:
//
//   1. Rasterise level.colliders into a ~0.5 m binary occupancy grid. Thin
//      slabs are inflated to at least one voxel so a 0.3 m wall cannot leak.
//   2. For every cell of a coarser output grid, fire SV_RAYS cosine-weighted
//      rays into the upper hemisphere and DDA them through the occupancy grid.
//      A ray that escapes counts 1; a ray that hits counts a small
//      distance-graded residue (real rooms are not perfectly black).
//   3. Flood the result into cells that lie inside geometry, blur once, and
//      upload as an R8 THREE.Data3DTexture.
//   4. The GLSL side samples it ONCE per fragment and scales the indirect terms
//      by it. WHICH terms, and by how much, is not uniform - see below.
//
// WHAT THE GATE APPLIES TO. The first version multiplied everything indirect by
// the full visibility, which is wrong for two of the terms and was measurably
// destructive:
//   - `iblIrradiance` and `radiance` ARE skylight. Full gate.
//   - the bounce/fill directionals are NOT: light thrown off a facade three
//     metres away does not care whether there is a roof forty metres up. At the
//     full gate the alley (visibility 0.134 -> shaped 0.228) lost 77% of the
//     only indirect light it has, and printed with no vertical gradient at all.
//     They take SV_DIR_GATE of it.
//   - the AmbientLight is the documented "nothing crushes to pure black" FLOOR.
//     A floor that is weakest exactly where sky visibility is lowest is not a
//     floor, it is a second occlusion pass. It is hoisted out of the multiply
//     entirely (lights_fragment_end subtracts it, gates the remainder, adds it
//     back) and correspondingly no longer carries the compensation below.
//
// UNIFORM PLUMBING - the one subtle part. three clones ShaderLib[id].uniforms
// per material at PROGRAM CREATION time (WebGLPrograms.getUniforms), so a
// value written after the first draw would never reach an already-compiled
// material. Two things make this safe:
//   - every scalar/vector uniform is a Float32Array. cloneUniforms() copies
//     Colors/Vectors/Textures but passes anything else through BY REFERENCE,
//     so one array is genuinely shared by every material in the build and can
//     be mutated at any time (WebGLUniforms compares arrays element-wise, so
//     the change is picked up).
//   - the Data3DTexture is allocated at SCRIPT LOAD at its final dimensions,
//     pre-filled with 255 (= fully visible = no change), and only its contents
//     are rewritten later. Clones share `source`, hence share the GL texture.
// The `enable` component defaults to 0, so a ShaderMaterial written by another
// agent that includes these chunks but never supplies the uniforms simply gets
// the identity transform instead of sampling an unbound sampler.
//
// COMPENSATION. Multiplying every indirect term by a number <= 1 can only make
// the game darker, which is not what "the deck is under-lit relative to the
// parapet" asks for. So the gated rig is scaled by 1/f(ref), where ref is the
// visibility MEASURED at eye height down the middle of the roadway - measured
// at BAKE TIME, by _probeRoadwayVisibility, not transcribed as a constant. The
// previous hand-written 0.68 had stopped matching the level (the roadway probes
// ~0.65 across six stations) and was quietly running the street under its own
// fixed point. Two compensations exist because two different gates do:
// skyComp for the fully-gated skylight, skyCompDir for the SV_DIR_GATE bounce.
// That makes the open street the fixed point: it renders exactly as it did
// before the volume existed, while the rooftop gains sky fill and the sealed
// interior loses it. Occlusion redistributes, it does not dim.
//
// ---------------------------------------------------------------------------
// AFTER DARK (read this before retuning any night constant)
// ---------------------------------------------------------------------------
// The night rig is a KEY-led, day-for-night rig, not a dimmed day rig. The
// budget is expressed as a total illuminance cap (NIGHT_TOTAL_CAP) over
// key + hemisphere + ambient, and the key is handed whatever the fill does not
// spend. Capping the key ALONE - which is what the previous version did - buys
// the day > dusk > night ordering by deleting the only term that can put
// direction in a frame, and it measurably did: 1:1 key:fill, 60% of the frame
// under 0.04 sRGB, and an inverted colour grade because every light in the
// frame was blue. The three things that make night work here are:
//   - a real moon key (~2.1, cool, barely desaturated) doing the sculpting,
//   - warm practicals at ~15x the ambient floor doing the highlights, WITH
//     visible bulbs, halos and lit windows so the sources are in the picture,
//   - a small unconditional ambient floor so the unlit half is dark, not zero.
// Acceptance for the night frame is measured, not judged: mean luma 0.14-0.18,
// dynamic range > 0.62, grade_split > +0.03 (tools/analyze.py).
//
// ---------------------------------------------------------------------------
// PLACING THE PRACTICALS (the other thing the field is good for)
// ---------------------------------------------------------------------------
// The practical coordinates in this file were transcribed from ART_DIRECTION's
// PROSE description of the level ("one enterable interior, west, around x=-6"),
// and level.js built something else. Probed against the baked field, both shop
// lamps sat at visibility 0.63 - out on the open street - while the room they
// exist to light measures 0.04. That is why the interior read as ambient-only
// no matter how the ambient was tuned: its two practicals were not in it.
//
// So the bake is followed by two placement passes that use the occupancy grid
// it already built (_anchorPracticals / _clampPracticals): anchored lights snap
// into the room their scenario frames, and any light buried in - or pressed up
// against - geometry is pushed out to real clearance. Both degrade to "leave
// the authored coordinates alone" if the level publishes no camera poses.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;

  // --------------------------------------------------------------------------
  // Tunables
  // --------------------------------------------------------------------------
  var MAX_CASCADES = 4;          // shader emits code for at most this many
  // 0 = uniform splits, 1 = logarithmic. The sphere fit that keeps the cascades
  // stable costs a ~2.4x area overshoot on the near slice, so the near cascades
  // have to be pulled logarithmically tight to compensate; at 0.6 cascade 0 was
  // 0.3-9.0m with a 14.1m sphere and a 1.4cm texel, which cannot resolve a
  // shadow for anything thinner than ~3cm (cable, rail slots, sills, wire).
  var SPLIT_LAMBDA = 0.85;
  var NEAR_CASCADE_MAX = 5.0;    // metres - hard ceiling on cascade 0's far plane
  var BLEND_BAND = 0.14;         // fraction of a cascade used to cross-fade
  // The blocker search doubles as the outer ring of the filter, so its radius
  // must be >= the largest penumbra (that is what makes the "everything is
  // occluded -> return 0" early-out exact rather than an approximation), and
  // small enough that 8 taps sample it densely - a sparse search randomly
  // misses thin occluders and speckles the penumbra.
  var SEARCH_TEXELS = 5.0;       // PCSS blocker-search radius, in texels
  var MIN_PENUMBRA = 1.15;       // texels - keeps contact shadows from aliasing
  var MAX_PENUMBRA = 5.0;        // texels - must stay <= SEARCH_TEXELS
  var COARSE_MIX = 0.45;         // how much of the free outer ring to fold in
  var POISSON_SCALE = 0.8;       // pulls the tap set inside the unit disk
  var SUN_TAN_ANGLE = 0.00465;   // tan of the sun's angular RADIUS (~0.266 deg)
  var SOFTNESS_BOOST = 4.0;      // artistic exaggeration of the solar penumbra
  var SHADOW_TEXEL_BUDGET = 8 * 2048 * 2048; // ~67MB of packed-depth targets

  // --------------------------------------------------------------------------
  // Sky-visibility volume. Dimensions are COMPILE-TIME CONSTANTS on purpose:
  // the Data3DTexture has to exist (and be the right size) before any material
  // compiles, and level.js has not built yet when this module does. Only the
  // world-space mapping is decided later, and that travels in a Float32Array.
  // --------------------------------------------------------------------------
  var SV_W = 44, SV_H = 26, SV_D = 76;   // ~1.2 m cells over the market district
  var SV_RAYS = 12;              // cosine-weighted rays per cell
  var SV_RANGE = 14.0;           // metres a ray searches before it counts as sky
  var SV_PAD_XZ = 4.0;           // world padding so the edge fade sits off-geometry
  var SV_Y_BELOW = 2.2;          // metres of volume below the level's floor
  var SV_Y_SPAN = 26.0;          // total vertical extent - above it, sky is free
  var SV_OCC_CELL = 0.50;        // occupancy voxel size (metres)
  var SV_OCC_MAX = 2200000;      // hard cap on occupancy voxels
  var SV_HIT_RESIDUE = 0.10;     // a blocked ray still returns this much, graded
  // Shaping. `floor` is the "no room is ever pitch black" guarantee, `gamma`
  // < 1 lifts the mid range so a half-open street does not read as a cave.
  var SV_FLOOR = 0.055;
  var SV_GAMMA = 0.85;
  var SV_SPEC = 0.85;            // how much of the term applies to IBL specular
  var SV_NORMAL_OFFSET = 0.60;   // metres along the world normal before sampling
  // How much of the sky-visibility gate applies to the NON-SKYLIGHT indirect
  // terms - i.e. the bounce/fill directionals. Skylight really is occluded by a
  // roof; light bounced off a facade three metres away is not, and gating it at
  // full strength is what emptied the alley of every indirect term (measured:
  // playerSkyVis 0.134 -> svShape 0.228, so 77% of the bounce was being deleted
  // exactly where bounce is the ONLY light there is). The AmbientLight is not
  // gated at all any more - see patchShaderChunks.
  var SV_DIR_GATE = 0.50;
  // Reference visibility of an "open street" - the whole rig is scaled up by
  // 1/f(SV_REF) so that adding occlusion REDISTRIBUTES light instead of just
  // making the game darker. The open rooftop then genuinely gains ~1.9 stops of
  // sky fill relative to the canyon floor, which is the physical answer.
  //
  // SV_REF is now RE-DERIVED AT BAKE TIME (_probeRoadwayVisibility) instead of
  // being a hand-transcribed constant: the level moved under it and a probe of
  // the mid-roadway returns 0.47, not the 0.68 written here, which was running
  // the whole street ~0.4 stops dark against its own reference point. The
  // constant survives only as the value used before the bake lands.
  var SV_REF = 0.50;

  function svShape(v) {
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    return SV_FLOOR + (1 - SV_FLOOR) * Math.pow(Math.max(v, 1e-4), SV_GAMMA);
  }
  var SV_COMP = 1 / svShape(SV_REF);
  // Same compensation for the weakly-gated (SV_DIR_GATE) bounce directionals.
  function svCompDir(ref) {
    return 1 / M.lerp(1, svShape(ref), SV_DIR_GATE);
  }

  // Shared uniform payload. Float32Array (not Vector3/Vector4) is deliberate:
  // three's cloneUniforms passes plain typed arrays through by REFERENCE, so
  // every material in the build reads these very objects and a write here is
  // visible everywhere, including to materials that compiled hours ago.
  var SV_ORIGIN = new Float32Array([-26, -3, -68]);
  var SV_INVSIZE = new Float32Array([1 / 54, 1 / 26, 1 / 97]);
  // x = floor, y = gamma, z = specular amount, w = master enable (0 = identity)
  var SV_PARAMS = new Float32Array([SV_FLOOR, SV_GAMMA, SV_SPEC, 0]);
  // x = normal offset in metres, y/z/w reserved
  var SV_PARAMS2 = new Float32Array([SV_NORMAL_OFFSET, 0, 0, 0]);

  var SV_DATA = null, SV_TEX = null;
  (function allocSkyVisTexture() {
    try {
      if (!THREE.Data3DTexture || !THREE.RedFormat) return;
      SV_DATA = new Uint8Array(SV_W * SV_H * SV_D);
      // 255 == fully visible == identity, so an unfilled volume changes nothing.
      for (var i = 0; i < SV_DATA.length; i++) SV_DATA[i] = 255;
      var t = new THREE.Data3DTexture(SV_DATA, SV_W, SV_H, SV_D);
      t.name = 'blackoutSkyVisibility';
      t.format = THREE.RedFormat;
      t.type = THREE.UnsignedByteType;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.unpackAlignment = 1;      // R8 rows are not 4-byte aligned
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      SV_TEX = t;
    } catch (e) {
      SV_DATA = null; SV_TEX = null;
    }
  })();

  // Fallback key light: 14 deg elevation, ~25 deg off the street's long axis,
  // raking down -Z toward the player. Matches ART_DIRECTION when sky.js is
  // missing or has not published a sun direction yet.
  var FALLBACK_SUN = new THREE.Vector3(0.410, 0.2419, -0.8794).normalize();

  // Classic 16-point Poisson disk. Two disjoint subsets are used: a wide one
  // for the blocker search and a denser one for the PCF itself.
  var POISSON = [
    [-0.94201624, -0.39906216], [0.94558609, -0.76890725],
    [-0.09418410, -0.92938870], [0.34495938, 0.29387760],
    [-0.91588581, 0.45771432], [-0.81544232, -0.87912464],
    [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
    [0.44323325, -0.97511554], [0.53742981, -0.47373420],
    [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
    [-0.24188840, 0.99706507], [-0.81409955, 0.91437590],
    [0.19984126, 0.78641367], [0.14383161, -0.14100790]
  ];
  var PCF_TAPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  var BLOCKER_TAPS = [15, 0, 1, 4, 7, 2, 9, 12];

  function f5(v) { return (Math.round(v * 1e5) / 1e5).toFixed(5); }

  // --------------------------------------------------------------------------
  // GLSL generation
  //
  // Sampler arrays must be indexed with literal constants for maximum driver
  // compatibility, so the per-cascade blocks are emitted from JS rather than
  // written as a GLSL loop. Each block is wrapped in
  // `#if NUM_DIR_LIGHT_SHADOWS > n` so the shader compiles for any cascade
  // count, including 1.
  // --------------------------------------------------------------------------
  function buildCSMSource() {
    var L = [];
    var i, p;

    L.push('#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0');
    L.push('');
    L.push('// ---- OPERATION BLACKOUT / GAME.Lighting : cascaded shadow maps ----');
    // Blocker test has to flip when the renderer runs a reversed depth buffer,
    // exactly like three's own texture2DCompare does.
    L.push('#ifdef USE_REVERSED_DEPTH_BUFFER');
    L.push('\t#define CSM_BLOCKED( d, z ) ( ( d ) > ( z ) )');
    L.push('#else');
    L.push('\t#define CSM_BLOCKED( d, z ) ( ( d ) < ( z ) )');
    L.push('#endif');
    L.push('');

    // ---- one cascade: PCSS blocker search + rotated Poisson PCF -------------
    // Written single-exit on purpose: the HLSL cross-compiler used by ANGLE
    // cannot always prove a multi-return function initialises its result and
    // emits an X4000 warning, which pollutes the console every compile.
    L.push('float csmShadowAt( sampler2D map, vec2 mapSize, float bias, float pcss, vec3 sc, mat2 rot ) {');
    L.push('\tfloat result = 1.0;');
    L.push('\tvec2 texel = vec2( 1.0 ) / mapSize;');
    L.push('\tfloat z = sc.z + bias;');
    L.push('\tfloat bsum = 0.0;');
    L.push('\tfloat bcount = 0.0;');
    L.push('\tfloat d;');
    L.push('\t// blocker search - also the early-out that makes open sunlit');
    L.push('\t// ground cost only these taps instead of the full kernel.');
    for (i = 0; i < BLOCKER_TAPS.length; i++) {
      p = POISSON[BLOCKER_TAPS[i]];
      L.push('\td = unpackRGBAToDepth( texture2D( map, sc.xy + ( rot * vec2( ' +
        f5(p[0] * POISSON_SCALE * SEARCH_TEXELS) + ', ' +
        f5(p[1] * POISSON_SCALE * SEARCH_TEXELS) + ' ) ) * texel ) );');
      L.push('\tif ( CSM_BLOCKED( d, z ) ) { bsum += d; bcount += 1.0; }');
    }
    L.push('\tif ( bcount >= 0.5 ) {');
    L.push('\t\t// Penumbra width from occluder distance. `pcss` folds the');
    L.push('\t\t// light angular size, the cascade depth range and the texel');
    L.push('\t\t// size into one per-cascade scalar - no extra uniform needed.');
    L.push('\t\tfloat pen = clamp( abs( z - bsum / bcount ) * pcss, ' +
      f5(MIN_PENUMBRA) + ', ' + f5(MAX_PENUMBRA) + ' );');
    L.push('\t\tif ( bcount > ' + f5(BLOCKER_TAPS.length - 0.5) + ' ) {');
    L.push('\t\t\t// Every search tap was occluded and the filter kernel can');
    L.push('\t\t\t// never reach past the search radius, so this is core shadow.');
    L.push('\t\t\tresult = 0.0;');
    L.push('\t\t} else {');
    L.push('\t\t\tfloat s = 0.0;');
    for (i = 0; i < PCF_TAPS.length; i++) {
      p = POISSON[PCF_TAPS[i]];
      L.push('\t\t\ts += texture2DCompare( map, sc.xy + ( rot * vec2( ' +
        f5(p[0] * POISSON_SCALE) + ', ' + f5(p[1] * POISSON_SCALE) +
        ' ) ) * pen * texel, z );');
    }
    L.push('\t\t\ts *= ' + (1 / PCF_TAPS.length).toFixed(8) + ';');
    L.push('\t\t\t// The blocker taps are already a valid PCF estimate at the');
    L.push('\t\t\t// search radius. Folding them in for wide penumbras adds 8');
    L.push('\t\t\t// stratified samples on the outer ring for zero extra');
    L.push('\t\t\t// fetches, which is what kills the sampling grain.');
    L.push('\t\t\tfloat coarse = 1.0 - bcount * ' + (1 / BLOCKER_TAPS.length).toFixed(8) + ';');
    L.push('\t\t\tresult = mix( s, coarse, clamp( ( pen - ' +
      f5(MAX_PENUMBRA * 0.5) + ' ) * ' + f5(1 / (MAX_PENUMBRA * 0.5)) +
      ', 0.0, 1.0 ) * ' + f5(COARSE_MIX) + ' );');
    L.push('\t\t}');
    L.push('\t}');
    L.push('\treturn result;');
    L.push('}');
    L.push('');

    // ---- cascade selection + cross-fade ------------------------------------
    L.push('float getCSMShadow( vec3 nrm, vec3 lightDir ) {');
    L.push('\t// Slope-scaled depth bias: grazing surfaces need far more bias');
    L.push('\t// than surfaces facing the sun, and applying it per-fragment');
    L.push('\t// lets the constant term stay small (no peter-panning).');
    L.push('\tfloat ndl = clamp( dot( nrm, lightDir ), 0.0, 1.0 );');
    L.push('\tfloat slope = 1.0 + clamp( sqrt( max( 0.0, 1.0 - ndl * ndl ) ) / max( ndl, 0.12 ), 0.0, 6.0 );');
    L.push('\t// Interleaved-gradient noise rotates the tap pattern per pixel,');
    L.push('\t// turning kernel banding into a fine dither that TAA resolves.');
    L.push('\tfloat ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );');
    L.push('\tfloat ca = cos( ign * 6.2831853 );');
    L.push('\tfloat sa = sin( ign * 6.2831853 );');
    L.push('\tmat2 rot = mat2( ca, - sa, sa, ca );');
    L.push('\tfloat si = directionalLightShadows[ 0 ].shadowIntensity;');
    L.push('\tfloat result = 1.0;');
    L.push('\tbool done = false;');
    L.push('\tvec3 csmSc;');
    L.push('\tvec3 csmSc2;');
    L.push('\tfloat csmE;');
    L.push('\tfloat csmW;');
    L.push('\tfloat csmS;');
    L.push('\tfloat csmNext;');

    for (i = 0; i < MAX_CASCADES; i++) {
      var n = i + 1;
      L.push('#if NUM_DIR_LIGHT_SHADOWS > ' + i);
      L.push('\t// cascade ' + i + ': take it if the fragment lands inside this map.');
      L.push('\tcsmSc = vDirectionalShadowCoord[ ' + i + ' ].xyz / vDirectionalShadowCoord[ ' + i + ' ].w;');
      L.push('\tcsmE = max( abs( csmSc.x - 0.5 ), abs( csmSc.y - 0.5 ) ) * 2.0;');
      L.push('\tif ( ! done && csmE < 1.0 && csmSc.z >= 0.0 && csmSc.z <= 1.0 ) {');
      L.push('\t\tcsmS = csmShadowAt( directionalShadowMap[ ' + i + ' ], ' +
        'directionalLightShadows[ ' + i + ' ].shadowMapSize, ' +
        'directionalLightShadows[ ' + i + ' ].shadowBias * slope, ' +
        'directionalLightShadows[ ' + i + ' ].shadowRadius, csmSc, rot );');
      L.push('\t\tcsmW = clamp( ( 1.0 - csmE ) * ' + f5(1 / BLEND_BAND) + ', 0.0, 1.0 );');
      L.push('\t\tif ( csmW < 1.0 ) {');
      L.push('\t\t\tcsmNext = 1.0;');
      L.push('#if NUM_DIR_LIGHT_SHADOWS > ' + n);
      L.push('\t\t\tcsmSc2 = vDirectionalShadowCoord[ ' + n + ' ].xyz / vDirectionalShadowCoord[ ' + n + ' ].w;');
      L.push('\t\t\tif ( max( abs( csmSc2.x - 0.5 ), abs( csmSc2.y - 0.5 ) ) < 0.5 && csmSc2.z >= 0.0 && csmSc2.z <= 1.0 ) {');
      L.push('\t\t\t\tcsmNext = csmShadowAt( directionalShadowMap[ ' + n + ' ], ' +
        'directionalLightShadows[ ' + n + ' ].shadowMapSize, ' +
        'directionalLightShadows[ ' + n + ' ].shadowBias * slope, ' +
        'directionalLightShadows[ ' + n + ' ].shadowRadius, csmSc2, rot );');
      L.push('\t\t\t}');
      L.push('#endif');
      L.push('\t\t\t// Beyond the last cascade there is no shadow data at all,');
      L.push('\t\t\t// so we fade to lit - the fog swallows the transition.');
      L.push('\t\t\tcsmS = mix( csmNext, csmS, csmW );');
      L.push('\t\t}');
      L.push('\t\tresult = mix( 1.0, csmS, si );');
      L.push('\t\tdone = true;');
      L.push('\t}');
      L.push('#endif');
    }

    L.push('\treturn result;');
    L.push('}');
    L.push('#endif');
    L.push('');
    return L.join('\n');
  }

  // --------------------------------------------------------------------------
  // GLSL: sky-visibility lookup.
  //
  // Deliberately NOT wrapped in USE_SHADOWMAP - the ambient occlusion this
  // provides has to work on a material with shadows disabled too. It also takes
  // world position and normal as ARGUMENTS rather than reading vViewPosition
  // itself: shadowmap_pars_fragment is included by three's ShadowMaterial,
  // which has no vViewPosition, and a function body referencing it there would
  // fail to compile a material this module does not even own.
  // --------------------------------------------------------------------------
  function buildSkyVisSource() {
    var L = [];
    L.push('// ---- OPERATION BLACKOUT / GAME.Lighting : sky-visibility volume ----');
    L.push('uniform highp sampler3D boSkyVisMap;');
    L.push('uniform vec3 boSkyVisOrigin;');
    L.push('uniform vec3 boSkyVisInvSize;');
    L.push('uniform vec4 boSkyVisParams;');   // floor, gamma, specular amount, enable
    L.push('uniform vec4 boSkyVisParams2;');  // normal offset, -, -, -
    L.push('float boSkyVisibility( const in vec3 wpos, const in vec3 wnrm ) {');
    L.push('\tfloat amt = boSkyVisParams.w;');
    L.push('\tfloat result = 1.0;');
    // Single dynamic branch on a uniform: with the volume disabled (or with a
    // ShaderMaterial that never supplied these uniforms) the sampler is never
    // touched and the whole block costs one comparison.
    L.push('\tif ( amt > 0.0 ) {');
    L.push('\t\t// Push the sample off the surface, or a wall fragment reads the');
    L.push('\t\t// sealed cell it lives inside instead of the air in front of it.');
    L.push('\t\tvec3 uvw = ( wpos + wnrm * boSkyVisParams2.x - boSkyVisOrigin ) * boSkyVisInvSize;');
    L.push('\t\tvec3 edge = abs( uvw - 0.5 );');
    L.push('\t\t// Outside the baked box (distant backdrop) fall back to open sky.');
    L.push('\t\tfloat inside = 1.0 - smoothstep( 0.455, 0.5, max( edge.x, max( edge.y, edge.z ) ) );');
    L.push('\t\tfloat v = texture( boSkyVisMap, clamp( uvw, vec3( 0.002 ), vec3( 0.998 ) ) ).r;');
    L.push('\t\tv = mix( 1.0, v, inside );');
    L.push('\t\tv = boSkyVisParams.x + ( 1.0 - boSkyVisParams.x ) * pow( max( v, 1e-4 ), boSkyVisParams.y );');
    L.push('\t\tresult = mix( 1.0, clamp( v, 0.0, 1.0 ), amt );');
    L.push('\t}');
    L.push('\treturn result;');
    L.push('}');
    L.push('');
    return L.join('\n');
  }

  // --------------------------------------------------------------------------
  // Patch three's shader chunks. Done at script load so it lands before any
  // material has been compiled by the renderer (materials compile lazily on
  // first draw, which is long after every module's build()).
  // --------------------------------------------------------------------------
  var CSM_PATCHED = false;
  var SKYVIS_PATCHED = false;
  (function patchShaderChunks() {
    try {
      var SC = THREE.ShaderChunk;
      if (!SC || !SC.lights_fragment_begin || !SC.shadowmap_pars_fragment) return;
      if (SC.__blackoutCSM) {
        CSM_PATCHED = true;
        SKYVIS_PATCHED = !!SC.__blackoutSkyVis;
        return;
      }

      var lines = SC.lights_fragment_begin.split('\n');
      var i;
      var hit = -1;
      for (i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('getShadow( directionalShadowMap[ i ]') >= 0) { hit = i; break; }
      }
      if (hit < 0) return;  // unexpected three build - leave everything alone

      // Only light 0 evaluates shadows, and it evaluates ALL cascades. Lights
      // 1..N-1 are shadow carriers with a black colour, so skipping their
      // getShadow() call removes N-1 redundant PCF kernels per fragment.
      lines[hit] =
        '\t\t#if ( UNROLLED_LOOP_INDEX == 0 )\n' +
        '\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? ' +
        'getCSMShadow( geometryNormal, directLight.direction ) : 1.0;\n' +
        '\t\t#endif';

      // ---- sky visibility ---------------------------------------------------
      // Hoisted to the top of the chunk so the volume is fetched exactly once
      // per fragment and then reused by the fill directionals AND by every
      // indirect term in lights_fragment_end.
      var anchor = -1, dirEnd = -1;
      for (i = 0; i < lines.length; i++) {
        if (anchor < 0 && lines[i].indexOf('vec3 geometryNormal = normal;') >= 0) anchor = i;
        // first RE_Direct AFTER the directional-light shadow line == the
        // directional loop's shading call.
        if (dirEnd < 0 && i > hit && lines[i].indexOf('RE_Direct( directLight') >= 0) dirEnd = i;
      }
      if (anchor >= 0 && dirEnd > hit) {
        lines[anchor] = lines[anchor] +
          '\nfloat boSkyVis = boSkyVisibility(' +
          ' cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz,' +
          ' normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz ) );';
        // Directional lights at index >= NUM_DIR_LIGHT_SHADOWS cast no shadow:
        // in this rig that is exactly the ground-bounce and wall-bounce fills.
        // An unshadowed infinite fill is a real reason interiors read as bright
        // as the street - but only PARTLY, because these are not skylight. Sky
        // fill genuinely stops at a roof; light bounced off the facade across
        // the street does not, and gating it at full strength deleted 77% of
        // the only indirect light the alley has. So they take a fraction of the
        // gate (SV_DIR_GATE): enough to separate a sealed room from open air,
        // not enough to empty a canyon.
        lines[dirEnd] =
          '\t\t#if ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )\n' +
          '\t\tdirectLight.color *= mix( 1.0, boSkyVis, ' + f5(SV_DIR_GATE) + ' );\n' +
          '\t\t#endif\n' + lines[dirEnd];

        // Indirect terms. Patching lights_fragment_END rather than _begin is
        // deliberate: iblIrradiance and radiance are only filled in by
        // lights_fragment_maps, which runs between the two, so scaling them at
        // _begin would miss the entire PMREM environment contribution.
        //
        // THE AMBIENT LIGHT IS HOISTED OUT OF THE MULTIPLY. `irradiance` already
        // contains getAmbientLightIrradiance() by the time it reaches here, and
        // that term is the build's documented "nothing crushes to pure black"
        // floor. A floor that is weakest exactly where sky visibility is lowest
        // is not a floor, it is a second occlusion pass - which is precisely how
        // the alley ended up with no vertical gradient and no shadow detail. So
        // it is subtracted, the genuinely sky-borne remainder (hemisphere +
        // light probes) is gated, and it is added back untouched.
        SC.lights_fragment_end =
          '#if defined( RE_IndirectDiffuse )\n' +
          '\tvec3 boFloor = getAmbientLightIrradiance( ambientLightColor );\n' +
          '\tirradiance = max( irradiance - boFloor, vec3( 0.0 ) ) * boSkyVis + boFloor;\n' +
          '\tiblIrradiance *= boSkyVis;\n' +
          '#endif\n' +
          '#if defined( RE_IndirectSpecular )\n' +
          '\tradiance *= mix( 1.0, boSkyVis, boSkyVisParams.z );\n' +
          '\tclearcoatRadiance *= mix( 1.0, boSkyVis, boSkyVisParams.z );\n' +
          '#endif\n' + SC.lights_fragment_end;

        SC.shadowmap_pars_fragment = SC.shadowmap_pars_fragment + '\n' + buildSkyVisSource();
        SC.__blackoutSkyVis = true;
        SKYVIS_PATCHED = true;
      }

      SC.lights_fragment_begin = lines.join('\n');
      SC.shadowmap_pars_fragment = SC.shadowmap_pars_fragment + '\n' + buildCSMSource();
      SC.__blackoutCSM = true;
      CSM_PATCHED = true;
    } catch (e) {
      GAME.logError('lighting.patch', e);
      CSM_PATCHED = false;
      SKYVIS_PATCHED = false;
    }
  })();

  // The uniform values have to be registered on every ShaderLib entry that can
  // include the chunks above. three clones ShaderLib[id].uniforms per material
  // when its program is first created, which is why this runs at script load
  // and why the payload is made of shared Float32Arrays (see the header).
  (function registerSkyVisUniforms() {
    if (!SKYVIS_PATCHED || !SV_TEX) return;
    try {
      var libs = ['physical', 'standard', 'phong', 'lambert', 'toon'];
      var add = {
        boSkyVisMap: { value: SV_TEX },
        boSkyVisOrigin: { value: SV_ORIGIN },
        boSkyVisInvSize: { value: SV_INVSIZE },
        boSkyVisParams: { value: SV_PARAMS },
        boSkyVisParams2: { value: SV_PARAMS2 }
      };
      for (var i = 0; i < libs.length; i++) {
        var lib = THREE.ShaderLib[libs[i]];
        if (!lib || !lib.uniforms) continue;
        for (var k in add) {
          if (!lib.uniforms[k]) lib.uniforms[k] = { value: add[k].value };
        }
      }
      // Custom ShaderMaterials written by other agents merge UniformsLib.lights
      // to get the light arrays; hanging the payload there lets them pick this
      // up too, for free, as long as they merge after this script has run.
      if (THREE.UniformsLib && THREE.UniformsLib.lights) {
        for (var k2 in add) {
          if (!THREE.UniformsLib.lights[k2]) {
            THREE.UniformsLib.lights[k2] = { value: add[k2].value };
          }
        }
      }
    } catch (e) {
      GAME.logError('lighting.uniforms', e);
    }
  })();

  // --------------------------------------------------------------------------
  // Scratch objects - lighting.update runs every frame, so it allocates nothing
  // --------------------------------------------------------------------------
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion();
  var _c1 = new THREE.Color(), _c2 = new THREE.Color();
  var _c3 = new THREE.Color(), _c4 = new THREE.Color();
  var _c5 = new THREE.Color();
  var _WHITE = new THREE.Color(1, 1, 1);
  var MOON_BASE = new THREE.Color(0x5f7db8);   // fallback when sky has no moon
  var _upY = new THREE.Vector3(0, 1, 0);
  var _upZ = new THREE.Vector3(0, 0, 1);

  // Palette (ART_DIRECTION). Declared as sRGB hex and converted once, so the
  // numbers here match the document instead of being hand-linearised.
  var PAL = {
    skyDay: new THREE.Color(0x6f9fd8),     // cool zenith blue
    skyNight: new THREE.Color(0x1b2a44),
    skyDusk: new THREE.Color(0x59486f),    // violet band after sundown
    gndDay: new THREE.Color(0xc9b08a),     // sand / dust bounce
    gndNight: new THREE.Color(0x1b1712),
    gndDusk: new THREE.Color(0xa1552a),    // ember-warm ground at sundown
    bounce: new THREE.Color(0xd8b98a),
    ambDay: new THREE.Color(0x2c4a5e),     // teal-lifted shadow floor
    ambNight: new THREE.Color(0x263c50),
    zenith: new THREE.Color(0x4a7fb5)      // ART_DIRECTION "Sky zenith"
  };

  // How much of the atmosphere's own zenith blue is forced into the skylight
  // half of the hemisphere, and how much of that cool light is mixed back into
  // its ground half. The warm sand bounce is already carried by `this.bounce`;
  // letting the hemisphere carry it a second time is what made every shadow in
  // the build read grey-brown instead of the art-directed cool #4a5568.
  var SKY_COOL_PUSH = 0.42;
  var GND_COOL_MIX = 0.46;
  // Moonlight is ~400,000x dimmer than sunlight in reality; cinematically it
  // has to be a readable key or the night scenario is a black rectangle. These
  // are day-for-night gains against sky.js's physical moon/twilight terms, sized
  // against postfx's exposure ceiling (uMax 3.2) so night prints ~2.5 stops
  // under noon rather than falling off the bottom of the tone curve.
  //
  // 2.6 put the moon key at 0.78 against a fill of hemi 0.27 + ambient 0.46 +
  // env 0.84 - a 1:1 key:fill ratio, which is another way of writing "the frame
  // has no light direction in it". No exposure curve can build an image out of
  // omnidirectional light, and the measured consequence was 60% of night.png
  // under 0.04 sRGB with a 0.45 dynamic range. The night budget has been moved
  // wholesale from the fill to the key (see NIGHT_SKY_FILL / NIGHT_ENV_SCALE /
  // the ambient taper in _updateFill); the TOTAL stays well under dusk's, which
  // is what keeps the day > dusk > night ordering intact.
  var MOON_KEY_GAIN = 6.4;
  // The afterglow at civil twilight is a genuine directional source (a huge
  // soft one, sitting where the sun set). It, not the moon, is what should rake
  // the street at dusk.
  var TWILIGHT_KEY = 4.75;
  // sky.js lifts its published twilight key to 0.17 * glow ~ 5 degrees of
  // elevation. A 5-degree ray needs 160 m of clear run to clear a 14 m facade
  // row, so at dusk that key lit nothing the camera could see and the whole
  // frame collapsed into a third of a stop of mauve wash. The real afterglow is
  // a BAND, not a disc, and its centroid sits well above where the disc went
  // down; raising the key to ~13 degrees is what gives the upper storeys of the
  // downwind facade a lit side to be read against.
  var DUSK_KEY_ELEV = 13.5;      // degrees
  // ---- the day/night ordering guarantee ------------------------------------
  // Measured decomposition of the night frame (key off vs key on, same region):
  // the moon key alone was responsible for 88% of the left facade's radiance
  // (0.0805 -> 0.0094 linear), because sky.js puts the moon at 42 deg on the
  // OPPOSITE side of the street from the sun - so it rakes head-on exactly the
  // wall the low sun only grazes. No amount of gain tuning fixes an ordering
  // that depends on which way a light happens to point, so the night key is
  // CAPPED as a fraction of the twilight key that precedes it. Whatever sky.js
  // publishes for the moon, midnight can no longer out-light civil twilight.
  // Capping the KEY alone was the bug: it starved the one term that sculpts
  // while leaving the omnidirectional fill completely untouched, so the ordering
  // was bought by deleting the night image. The cap is now expressed on the
  // TOTAL illuminance the preset is allowed to put in the frame
  // (key + hemisphere + ambient), which is the quantity the ordering guarantee
  // is actually about, and the key gets whatever the fill does not spend.
  //   measured budgets: day ~6.3, dusk ~5.2, night (new) ~3.4
  var NIGHT_KEY_MAX = 0.90;      // fraction of TWILIGHT_KEY - now only a guard
  var NIGHT_TOTAL_CAP = 2.70;    // key + hemi + ambient, after dark
  // Skyglow floors. A real city night is never lit by the moon alone. Same
  // ordering rule: the dusk floor has to sit clearly above the night floor or
  // the two presets converge into one grey-blue evening.
  //
  // These used to STACK: at the dusk preset duskFactor is 0.963 while
  // nightFactor is simultaneously 0.708, so both constants were added at once
  // and dusk ended up with MORE sky fill (0.863) than noon (0.727) - i.e. the
  // dusk key had nothing left to sculpt against. The night term is now gated by
  // (1 - dusk) so only one of them can ever be paying, and the after-dark total
  // is ceilinged below the daylight sky fill (NIGHT_FILL_CEIL).
  var NIGHT_SKY_FILL = 0.055;
  var DUSK_SKY_FILL = 0.26;
  var NIGHT_FILL_CEIL = 0.30;    // hemisphere ceiling once the sun is down
  // The PMREM environment is the last unshadowed infinite term, and sky.js
  // currently publishes a bright dome after dark, which lights the whole street
  // like an overcast afternoon. scene.environmentIntensity is a scene-level
  // knob no other module writes (weapons.js owns viewScene's), so the light rig
  // is the right owner for it.
  var NIGHT_ENV_SCALE = 0.27;

  // ---- practical (placed) light visuals ------------------------------------
  // A PointLight is invisible. Eight of them lighting a night street with no
  // bulb, no fixture and no halo anywhere in the scene graph is why the night
  // frame read as "dark" rather than as "night": the eye has nothing to anchor
  // the exposure on and no warm source to put in the highlights. Every practical
  // now carries a small emissive bulb and an additive camera-facing halo, both
  // driven off the light's own live intensity so they flicker with it.
  var BULB_RADIUS = 0.075;       // metres
  var HALO_SCALE = 0.42;         // halo radius as a fraction of light.distance
  var HALO_GAIN = 0.85;          // additive brightness per unit of light output
  var BULB_GAIN = 2.6;           // emissive brightness per unit of light output
  var MAX_WINDOWS = 6;           // lit window cards on the facades

  // --------------------------------------------------------------------------
  // Practical (placed) light definitions.
  //
  // The coordinates below come from ART_DIRECTION's PROSE ("one enterable
  // interior, west, around x=-6"), not from the level level.js actually built.
  // Probed against the baked visibility field the two shop lamps sat at sky
  // visibility 0.63 - i.e. out on the open street - while the room they exist to
  // light measures 0.04. A lamp that is not in the room cannot sculpt the room,
  // which is why the interior read as pure ambient no matter how the ambient was
  // tuned. So anything carrying an `anchor` is RE-PLACED at bake time against
  // real geometry (see _anchorPracticals); these numbers are only the fallback
  // for a level that publishes no camera poses.
  //
  // level.js may still override the whole set via `level.practicalLights`.
  // --------------------------------------------------------------------------
  var PRACTICALS = [
    {
      // Gutted shop interior, west side. Warm tungsten so the interior reads
      // amber against the cool skylight coming through the window.
      name: 'shop_lamp', kind: 'tungsten',
      pos: [-6.4, 2.55, -4.6], kelvin: 2750,
      // dayBase was 0.5. Once the lamp was actually INSIDE the room (it used to
      // be out on the street, where it lit nothing) half output at noon lit the
      // back of the shop brighter than the window did - the exact inversion this
      // was supposed to cure. By day a derelict shop is lit by its aperture; the
      // practical is a warm accent, not the key.
      intensity: 22, distance: 11, dayBase: 0.085,
      anchor: 'interior', spread: 2.2
    },
    {
      // Deeper into the shop - a dying fluorescent tube, cooler and greener.
      name: 'shop_tube', kind: 'fluoro',
      pos: [-6.1, 2.62, -9.4], kelvin: 4300,
      intensity: 13, distance: 8, dayBase: 0.06,
      anchor: 'interior', spread: 4.2
    },
    {
      // The alley. Low-pressure sodium: nearly monochromatic amber, the single
      // most recognisable "night street" light in the world.
      name: 'alley_sodium', kind: 'sodium',
      pos: [10.7, 3.55, 1.4], kelvin: 1950,
      intensity: 78, distance: 14, dayBase: 0.0, cone: 1.24, penumbra: 0.40,
      anchor: 'alley', spread: 3.0
    },
    {
      // Burning brazier mid-street. Noise-driven flicker, hot core.
      name: 'brazier', kind: 'fire',
      pos: [4.4, 0.72, -13.4], kelvin: 1900,
      intensity: 9, distance: 10, dayBase: 0.85
    },
    // ---- street lamps -------------------------------------------------------
    // Sodium heads over the pavement, staggered down the street's 70m so the
    // night read is alternating pools of amber with dark between them, not a
    // flat blue wash. Purely night: dayBase 0 keeps them off and out of the
    // shader by day.
    //
    // These were 10-17 with decay 2 at a mount height of 3.85 m, which puts
    // 12 / 3.85^2 = 0.81 of irradiance on the pavement directly underneath -
    // against 0.53 of moon + ambient already sitting there. A lamp that is
    // 1.5x the ambient floor is not a lamp, and the measured proof was a dead
    // flat 0.032-0.045 lower-half column profile across the entire frame width:
    // not one pool anywhere. The brazier, at E_under 8.4, is the one practical
    // in the build that ever read, so it sets the scale: ~9 under the head, i.e.
    // ~15x the floor. They have also been pulled a little further off the
    // facades (|x| 4.6 -> 4.15) because at 90 units a bulb 2.4 m from plaster
    // bleaches it; at 3 m it lights it.
    {
      name: 'street_lamp_a', kind: 'sodium',
      pos: [4.15, 3.85, 3.0], kelvin: 1950,
      intensity: 128, distance: 15, dayBase: 0.0, cone: 1.16, penumbra: 0.36
    },
    {
      name: 'street_lamp_b', kind: 'sodium',
      pos: [-4.15, 3.85, -8.0], kelvin: 1950,
      intensity: 128, distance: 15, dayBase: 0.0, cone: 1.16, penumbra: 0.36
    },
    {
      name: 'street_lamp_c', kind: 'sodium',
      pos: [4.15, 3.85, -19.5], kelvin: 1950,
      intensity: 104, distance: 14, dayBase: 0.0, cone: 1.16, penumbra: 0.36
    },
    {
      name: 'street_lamp_d', kind: 'sodium',
      pos: [-4.15, 3.85, -31.0], kelvin: 1950,
      intensity: 104, distance: 14, dayBase: 0.0, cone: 1.16, penumbra: 0.36
    },
    {
      // The near foreground of the street framings. The staggered row starts
      // 17 m up the street, which left the bottom-left quarter of every after-
      // dark capture with no source within reach of it at all - a black corner
      // is not "night", it is missing information.
      name: 'street_lamp_e', kind: 'sodium',
      pos: [-4.15, 3.85, 2.0], kelvin: 1950,
      intensity: 112, distance: 14, dayBase: 0.0, cone: 1.16, penumbra: 0.36
    }
  ];

  // Point lights are unshadowed and cheap, but every extra one costs a little
  // in every forward shader. three only uploads VISIBLE lights, and the whole
  // night set carries dayBase 0, so daylight scenes pay nothing for these.
  var MAX_PRACTICALS = 10;

  // ==========================================================================
  // GAME.Lighting
  // ==========================================================================
  function Lighting(ctx) {
    ctx = ctx || {};
    this.ctx = ctx;

    this.root = new THREE.Group();
    this.root.name = 'lightRig';
    this.root.matrixAutoUpdate = false;   // the rig never moves as a whole

    this.cascades = [];      // [{light, target, near, far, radius, centerDist,...}]
    this.sun = null;         // === cascades[0].light (documented API)
    this.bounce = null;
    this.hemi = null;
    this.ambient = null;
    this.practicals = [];
    this.enabled = true;

    // Live state other systems may read (postfx wants the key direction for
    // god rays; hud/vfx may want the day/night factor).
    this.sunDirection = new THREE.Vector3().copy(FALLBACK_SUN);
    // The TRUE solar vector. sunDirection above is the KEY light and swaps to
    // the moon after dark (sky.js does that swap for us); every day/night term
    // must be derived from this one instead, or midnight computes as noon.
    this.solarDirection = new THREE.Vector3().copy(FALLBACK_SUN);
    this.keyIsMoon = false;
    this.keyColor = new THREE.Color(1, 1, 1);
    this.keyIntensity = 5.0;
    this.dayFactor = 1;
    this.nightFactor = 0;
    this.duskFactor = 0;
    this.csmEnabled = CSM_PATCHED;

    this.shadowDistance = 82;
    this.shadowRes = 2048;
    this.cascadeCount = 0;

    this._t = 0;
    this._frame = 0;
    this._fov = -1;
    this._aspect = -1;
    this._extrusion = 60;
    this._splitsDirty = true;
    this._prevKey = new THREE.Vector3();
    this._keyDir = new THREE.Vector3().copy(FALLBACK_SUN);
    this._sunColor = new THREE.Color(1, 0.92, 0.82);
    this._moonColor = new THREE.Color(0x5f7db8);
    this._viewRig = null;
    this._viewRigChecked = false;
    this._envAdopted = false;
    this._levelLampsChecked = false;
    this._sunMoved = false;
    // Visible sources + the alley shaft. Both are built once, at the end of the
    // sky-visibility bake, because both need the occupancy grid it produces.
    this._lampVisuals = null;
    this._lampMat = null;
    this._lampOn = 0;
    this._shafts = null;

    // ---- sky-visibility volume state ---------------------------------------
    this.skyVis = null;          // {data,w,h,d, ox,oy,oz, sx,sy,sz} once baked
    this.skyVisReady = false;
    // Multiplies the whole indirect rig back up so that adding occlusion
    // REDISTRIBUTES light instead of just dimming the game. 1.0 until the bake
    // lands, so a failed bake degrades to exactly the previous look.
    this.skyComp = 1.0;
    // Same idea for the weakly-gated bounce directionals (SV_DIR_GATE).
    this.skyCompDir = 1.0;
    this.skyRef = SV_REF;        // measured mid-roadway visibility, set at bake
    this.playerSkyVis = 1.0;     // CPU-side probe at the camera, smoothed
    this._svTried = false;
    this._svHooked = false;
    this._svGate = 0;            // shader gate as applied to the world scene
    this._svDiag = null;

    var seed = (ctx.seed || 20260801) ^ 0x5A17C0DE;
    this.noise = new GAME.Noise(seed);
    this.rng = ctx.rng && ctx.rng.fork ? ctx.rng.fork(0x10C17) : new GAME.RNG(seed);
  }

  // --------------------------------------------------------------------------
  // Build
  // --------------------------------------------------------------------------
  Lighting.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      this._configureRenderer(ctx);
      this._buildCascades(ctx);
      this._buildFill(ctx);
      this._buildPracticals(ctx);
      if (ctx.scene && ctx.scene.isScene) ctx.scene.add(this.root);
      this._adoptEnvironment(ctx);
    } catch (e) {
      GAME.logError('lighting.build', e);
    }
    // Yield so the loading bar can paint between the heavy generators.
    try { await GAME.yieldFrame(); } catch (e) { /* non-fatal */ }
    // Prime the fit so the very first rendered frame already has valid maps.
    this.update(0, ctx);
  };

  // Shadow settings live here rather than in main.js because only this module
  // knows how many maps it is about to allocate.
  Lighting.prototype._configureRenderer = function (ctx) {
    var r = ctx.renderer;
    if (!r || !r.shadowMap) return;
    r.shadowMap.enabled = true;
    // Global autoUpdate stays on; each cascade gates its own re-render through
    // shadow.autoUpdate/needsUpdate (see _scheduleShadowUpdates). That also
    // stops postfx from re-rendering every shadow map on a second scene pass.
    r.shadowMap.autoUpdate = true;
    // shadowMap.type is left exactly as main.js set it: directional shadows go
    // through getCSMShadow() and never touch three's getShadow(), so the type
    // only affects spot/point shadows (of which this rig allocates none).
  };

  Lighting.prototype._buildCascades = function (ctx) {
    var q = ctx.quality || {};
    var want = Math.round(q.cascades != null ? q.cascades : 3);
    var n = M.clamp(isFinite(want) ? want : 3, 1, MAX_CASCADES);
    // If the shader patch failed we cannot select between cascades, so fall
    // back to a single map covering the whole shadow distance. Softer, but it
    // still renders correctly instead of shadowing only the first few metres.
    if (!CSM_PATCHED) n = 1;

    var res = M.clamp(Math.round(q.shadowRes || 2048), 256, 4096);
    // Packed-depth shadow maps are RGBA8: 4 bytes per texel, per cascade.
    // Cap the total so a 4-cascade "ultra" run does not ask for 268MB.
    while (n * res * res > SHADOW_TEXEL_BUDGET && res > 512) res = Math.floor(res / 2);

    // Cascade 0 is the one wrapped around the player, and it is the only one
    // where a 1cm feature (rail slot, cable, sill lip, wire) can still cast a
    // readable shadow. The shader takes shadowMapSize per light, so the near
    // cascade can simply be denser than the rest wherever the budget allows.
    var res0 = res;
    if (n > 1) {
      var boost = Math.min(4096, Math.round(res * 1.5 / 256) * 256);
      if (boost > res && boost * boost + (n - 1) * res * res <= SHADOW_TEXEL_BUDGET) {
        res0 = boost;
      }
    }
    this.shadowRes = res;
    this.nearShadowRes = res0;
    this.cascadeCount = n;
    this.shadowDistance = n >= 4 ? 82 : (n === 3 ? 62 : (n === 2 ? 44 : 34));

    var i, light;
    // IMPORTANT: every shadow-casting directional light must appear BEFORE any
    // non-shadow directional light in scene-graph order. three indexes
    // state.directionalShadow[] by the light's directional index, so a
    // non-casting light slotted in the middle would misalign the shadow arrays.
    for (i = 0; i < n; i++) {
      var cres = (i === 0) ? res0 : res;
      light = new THREE.DirectionalLight(0xffffff, i === 0 ? 4.5 : 0);
      light.name = 'csm_cascade_' + i;
      if (i > 0) light.color.setRGB(0, 0, 0);   // shadow carrier only
      light.castShadow = true;
      light.shadow.mapSize.set(cres, cres);
      light.shadow.intensity = 1.0;
      light.shadow.autoUpdate = false;          // we drive needsUpdate ourselves
      light.shadow.needsUpdate = true;
      light.shadow.camera.up.copy(_upY);
      light.shadow.camera.near = 0.05;
      light.shadow.camera.far = 200;
      light.target.name = 'csm_target_' + i;
      this.root.add(light);
      this.cascades.push({
        light: light,
        target: light.target,
        res: cres,
        near: 0.3, far: 10, radius: 10, centerDist: 5,
        texel: 0.01, depthRange: 100,
        dirty: true
      });
    }
    // Targets go in after all the lights so light ordering stays clean.
    for (i = 0; i < n; i++) this.root.add(this.cascades[i].target);

    this.sun = this.cascades[0].light;
    this.root.updateMatrixWorld(true);
  };

  Lighting.prototype._buildFill = function (ctx) {
    // ---- hemisphere: cool sky above, warm sand bounce below -----------------
    // This is the single most important "shadows are never black" ingredient.
    this.hemi = new THREE.HemisphereLight(0x86b0e6, 0xc0a074, 0.5);
    this.hemi.name = 'skyFill';
    this.hemi.position.set(0, 1, 0);   // three reads the hemisphere axis from this
    this.root.add(this.hemi);

    // ---- cheap approximate GI: warm bounce off the ground --------------------
    // A directional light whose rays travel UPWARD. It lights the undersides of
    // awnings, crates, the wrecked car and character chins with sand-coloured
    // light, and it is tilted away from the sun azimuth so the shaded side of
    // every object picks up some fill. One light, enormous grounding payoff.
    this.bounce = new THREE.DirectionalLight(0xd8b98a, 0.38);
    this.bounce.name = 'groundBounce';
    this.bounce.castShadow = false;
    this.bounce.position.set(0, -20, 0);
    this.root.add(this.bounce, this.bounce.target);

    // ---- second GI term: light bounced off the STREET WALLS ----------------
    // A hemisphere light gives every up-facing surface pure sky colour, which
    // is why the canyon floor measured rgb (0.044, 0.045, 0.0635) - navy, in a
    // scene whose art direction says "warm sand-coloured bounce on lower
    // surfaces". The road cannot be reached by `bounce` (that one points UP,
    // for undersides) and the old single anti-sun `fill` sat at 0.17 against a
    // key of 5.3 - 3% of key, and boSkyVis-gated on top.
    //
    // The physically-shaped replacement is a PAIR, one per street wall, aimed
    // inward across the canyon and ~22 degrees down. That is what a 14 m wide
    // street of lit plaster actually does: it throws warm light sideways at the
    // road from both sides, strongest from whichever facade the sun is on. Two
    // lights instead of one is what produces a warm-to-cool gradient ACROSS the
    // roadway rather than a flat wash, which is the thing that makes a road
    // read as a surface instead of as a hole.
    this.fillA = new THREE.DirectionalLight(0xd9c3a0, 0.2);   // arrives from +X
    this.fillA.name = 'facadeBounceA';
    this.fillA.castShadow = false;
    this.fillA.position.set(50, 20, 0);
    this.root.add(this.fillA, this.fillA.target);

    this.fillB = new THREE.DirectionalLight(0xd9c3a0, 0.2);   // arrives from -X
    this.fillB.name = 'facadeBounceB';
    this.fillB.castShadow = false;
    this.fillB.position.set(-50, 20, 0);
    this.root.add(this.fillB, this.fillB.target);
    // Back-compat alias: nothing outside this file reads it, but the rig has
    // documented `fill` in its own comments since round 1.
    this.fill = this.fillA;

    // ---- last-resort floor so nothing can ever crush to pure black ----------
    // Deliberately tiny and teal-shifted, matching the grade's lifted shadows.
    this.ambient = new THREE.AmbientLight(0x24384a, 0.06);
    this.ambient.name = 'shadowFloor';
    this.root.add(this.ambient);
  };

  Lighting.prototype._buildPracticals = function (ctx, defs) {
    defs = defs || PRACTICALS;
    for (var i = 0; i < defs.length && i < MAX_PRACTICALS; i++) {
      var d = defs[i];
      var pos = d.pos || [0, 2, 0];
      var col = GAME.Color.kelvin(d.kelvin || 2800, new THREE.Color());
      if (d.kind === 'sodium') {
        // Low-pressure sodium is far more saturated than a blackbody of the
        // same temperature - push the blue channel down. Not all the way to a
        // pure monochromatic amber though: with eight of these lit at night the
        // frame tips over into a poster and stops reading photographic.
        col.multiply(_c1.setRGB(1.0, 0.755, 0.34));
      } else if (d.kind === 'fluoro') {
        col.multiply(_c1.setRGB(0.90, 1.0, 0.94));  // slight sickly green
      }
      // A street-lamp head is a REFLECTOR pointing at the pavement, not a bare
      // bulb radiating in every direction. Modelling it as a point light is
      // what made "put a usable amount of light under the lamp" and "do not
      // bleach the facade 2.8 m away" mutually exclusive - the same inverse
      // square serves both. A downward cone decouples them: 8.6 of irradiance
      // on the pavement underneath, ~3 on the lower facade the cone still
      // catches, and nothing at all on the wall level with the head.
      var light;
      var dist = d.distance || 10;
      if (d.cone) {
        // Penumbra is a big lever here and it is easy to get wrong: three fades
        // from angle*(1-penumbra) out to angle, so 0.72 on a 66-degree cone put
        // FULL output only inside 19 degrees and had already fallen to ~0 by
        // 60 - i.e. the pavement 3 m to either side of the lamp got nothing and
        // the "pool" was a 2 m disc. 0.36 keeps a real pool with a soft rim.
        light = new THREE.SpotLight(0xffffff, 0, dist, M.clamp(d.cone, 0.15, 1.4),
          d.penumbra != null ? d.penumbra : 0.40, 2);
        light.target.name = (d.name || 'practical') + '_target';
        light.target.position.set(pos[0], pos[1] - 3.0, pos[2]);
        this.root.add(light.target);
      } else {
        light = new THREE.PointLight(0xffffff, 0, dist, 2);
      }
      light.name = d.name || ('practical_' + i);
      light.color.copy(col);
      light.castShadow = false;   // point shadows are 6 renders each - not worth it
      light.position.set(pos[0], pos[1], pos[2]);
      this.root.add(light);
      this.practicals.push({
        light: light,
        kind: d.kind || 'tungsten',
        base: new THREE.Vector3(pos[0], pos[1], pos[2]),
        kelvin: d.kelvin || 2800,
        intensity: d.intensity || 8,
        dayBase: d.dayBase != null ? d.dayBase : 0.4,
        baseColor: col.clone(),
        distance: dist,
        // Optional placement hints, consumed once by _anchorPracticals().
        anchor: d.anchor || null,
        spread: d.spread != null ? d.spread : 2.6,
        boost: 1,
        enclosure: 0,
        // Visuals: a lamp with no visible source cannot read as a lamp. Filled
        // in by _buildLampVisuals once the practicals have been placed.
        visual: -1,
        haloScale: d.haloScale != null ? d.haloScale : HALO_SCALE,
        phase: this.rng.range(0, 100)
      });
    }
    this.pointLights = this.practicals;
  };

  // level.js builds after lighting, so its lamp placements can only be picked
  // up on the first update. If it publishes any, they replace the coordinates
  // taken from ART_DIRECTION - the level actually knows where the walls are.
  Lighting.prototype._adoptLevelPracticals = function (ctx) {
    if (this._levelLampsChecked) return;
    var lvl = ctx.level;
    if (!lvl) return;                       // level failed to build - keep ours
    this._levelLampsChecked = true;
    var defs = lvl.practicalLights;
    if (!Array.isArray(defs) || !defs.length) return;
    for (var i = 0; i < this.practicals.length; i++) {
      var old = this.practicals[i].light;
      if (old.target && old.target.parent === this.root) this.root.remove(old.target);
      this.root.remove(old);
    }
    this.practicals.length = 0;
    this._buildPracticals(ctx, defs);
  };

  // If sky.js built an environment map but nobody assigned it, do it here -
  // without IBL every metal surface in the game reads as flat plastic.
  Lighting.prototype._adoptEnvironment = function (ctx) {
    if (this._envAdopted) return;
    var sky = ctx.sky;
    if (!sky || !sky.envMap || !ctx.scene) return;
    if (!ctx.scene.environment) ctx.scene.environment = sky.envMap;
    this._envAdopted = true;
  };

  // ==========================================================================
  // SKY-VISIBILITY VOLUME
  //
  // level.js builds AFTER this module, so the bake cannot happen in build().
  // It happens on the first update() that sees colliders, and - as a belt-and-
  // braces guarantee that it lands before any material compiles - also from a
  // one-shot scene.onBeforeRender hook, which three calls at the very top of
  // WebGLRenderer.render(), before a single program is created.
  // ==========================================================================

  // Cosine-distributed hemisphere directions (concentric-disk lift). Generated
  // once: the SAME set is used for every cell, only spun by a per-cell hash, so
  // the field has no stochastic noise for TAA to chew on.
  var SV_DIRS = (function () {
    var d = [];
    var golden = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < SV_RAYS; i++) {
      var u = (i + 0.5) / SV_RAYS;      // uniform in [0,1)
      var r = Math.sqrt(u);             // cosine weighting
      var phi = i * golden;
      d.push({ r: r, y: Math.sqrt(Math.max(0, 1 - u)), c: Math.cos(phi), s: Math.sin(phi) });
    }
    return d;
  })();

  // Rasterise the collision set into a binary occupancy grid. Thin slabs are
  // inflated to at least one voxel on their short axis, because a 0.30 m wall
  // sampled on a 0.50 m lattice is otherwise full of holes and the interior
  // reads as if it had no walls at all.
  Lighting.prototype._bakeOccupancy = function (colliders, G) {
    var occ = G.occ, nx = G.nx, ny = G.ny, nz = G.nz;
    var ox = G.ox, oy = G.oy, oz = G.oz, cs = G.cs, inv = 1 / cs;
    var m = new THREE.Matrix4();
    var lp = _v1, e = _v2;
    var half = cs * 0.5;

    for (var ci = 0; ci < colliders.length; ci++) {
      var c = colliders[ci];
      if (!c || !c.center) continue;
      var cx = c.center.x, cy = c.center.y, cz = c.center.z;
      var ax0, ay0, az0, ax1, ay1, az1;   // world AABB to scan
      var ex = 0, ey = 0, ez = 0, rotated = false, me = null;

      if (c.type === 'sphere') {
        var rr = Math.max(c.radius || 0, half);
        ax0 = cx - rr; ax1 = cx + rr;
        ay0 = cy - rr; ay1 = cy + rr;
        az0 = cz - rr; az1 = cz + rr;
        ex = rr;
      } else {
        var he = c.halfExtents;
        if (!he) continue;
        var q = c.quaternion;
        rotated = !!(q && Math.abs(q.w) < 0.999995);
        var pad = rotated ? cs * 0.62 : half;
        ex = Math.max(he.x, pad); ey = Math.max(he.y, pad); ez = Math.max(he.z, pad);
        if (rotated) {
          m.makeRotationFromQuaternion(q);
          me = m.elements;
          var rx = Math.abs(me[0]) * ex + Math.abs(me[4]) * ey + Math.abs(me[8]) * ez;
          var ry = Math.abs(me[1]) * ex + Math.abs(me[5]) * ey + Math.abs(me[9]) * ez;
          var rz = Math.abs(me[2]) * ex + Math.abs(me[6]) * ey + Math.abs(me[10]) * ez;
          ax0 = cx - rx; ax1 = cx + rx; ay0 = cy - ry; ay1 = cy + ry;
          az0 = cz - rz; az1 = cz + rz;
        } else {
          ax0 = cx - ex; ax1 = cx + ex; ay0 = cy - ey; ay1 = cy + ey;
          az0 = cz - ez; az1 = cz + ez;
        }
      }

      var i0 = Math.max(0, Math.floor((ax0 - ox) * inv));
      var i1 = Math.min(nx - 1, Math.floor((ax1 - ox) * inv));
      var j0 = Math.max(0, Math.floor((ay0 - oy) * inv));
      var j1 = Math.min(ny - 1, Math.floor((ay1 - oy) * inv));
      var k0 = Math.max(0, Math.floor((az0 - oz) * inv));
      var k1 = Math.min(nz - 1, Math.floor((az1 - oz) * inv));
      if (i1 < i0 || j1 < j0 || k1 < k0) continue;

      for (var k = k0; k <= k1; k++) {
        var wz = oz + (k + 0.5) * cs;
        for (var j = j0; j <= j1; j++) {
          var wy = oy + (j + 0.5) * cs;
          var row = (k * ny + j) * nx;
          for (var i = i0; i <= i1; i++) {
            var wx = ox + (i + 0.5) * cs;
            var insideCell;
            if (c.type === 'sphere') {
              var dx = wx - cx, dy = wy - cy, dz = wz - cz;
              insideCell = (dx * dx + dy * dy + dz * dz) <= ex * ex;
            } else if (rotated) {
              lp.set(wx - cx, wy - cy, wz - cz);
              // inverse rotation == transpose for an orthonormal basis
              e.set(
                lp.x * me[0] + lp.y * me[1] + lp.z * me[2],
                lp.x * me[4] + lp.y * me[5] + lp.z * me[6],
                lp.x * me[8] + lp.y * me[9] + lp.z * me[10]);
              insideCell = Math.abs(e.x) <= ex && Math.abs(e.y) <= ey && Math.abs(e.z) <= ez;
            } else {
              insideCell = Math.abs(wx - cx) <= ex && Math.abs(wy - cy) <= ey &&
                Math.abs(wz - cz) <= ez;
            }
            if (insideCell) occ[row + i] = 1;
          }
        }
      }
    }
  };

  // 3D-DDA through the occupancy grid. Returns the hit distance, or -1 when the
  // ray escaped (which is the only outcome that counts as "sees sky").
  function svTrace(G, px, py, pz, dx, dy, dz, maxD) {
    var occ = G.occ, nx = G.nx, ny = G.ny, nz = G.nz, cs = G.cs;
    var ox = G.ox, oy = G.oy, oz = G.oz, inv = 1 / cs;
    var ix = Math.floor((px - ox) * inv);
    var iy = Math.floor((py - oy) * inv);
    var iz = Math.floor((pz - oz) * inv);
    if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) return -1;

    var sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
    var adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
    var tdx = adx > 1e-9 ? cs / adx : Infinity;
    var tdy = ady > 1e-9 ? cs / ady : Infinity;
    var tdz = adz > 1e-9 ? cs / adz : Infinity;
    var lx = px - (ox + ix * cs), ly = py - (oy + iy * cs), lz = pz - (oz + iz * cs);
    var tmx = adx > 1e-9 ? ((dx >= 0 ? cs - lx : lx) / adx) : Infinity;
    var tmy = ady > 1e-9 ? ((dy >= 0 ? cs - ly : ly) / ady) : Infinity;
    var tmz = adz > 1e-9 ? ((dz >= 0 ? cs - lz : lz) / adz) : Infinity;

    var t = 0, guard = 0;
    while (guard++ < 256) {
      if (tmx <= tmy && tmx <= tmz) { t = tmx; ix += sx; tmx += tdx; }
      else if (tmy <= tmz) { t = tmy; iy += sy; tmy += tdy; }
      else { t = tmz; iz += sz; tmz += tdz; }
      if (t >= maxD) return -1;
      // Leaving the grid means leaving the level: that direction sees sky.
      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) return -1;
      if (occ[(iz * ny + iy) * nx + ix]) return t;
    }
    return -1;
  }

  Lighting.prototype._buildSkyVisibility = function (ctx) {
    if (this._svTried) return;
    var lvl = ctx && ctx.level;
    var cols = lvl && lvl.colliders;
    if (!SV_TEX || !SKYVIS_PATCHED || !cols || !cols.length) return;
    this._svTried = true;

    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;

    // ---- world mapping -----------------------------------------------------
    var b = lvl.bounds;
    var minX = (b && isFinite(b.min.x)) ? b.min.x : -24;
    var maxX = (b && isFinite(b.max.x)) ? b.max.x : 24;
    var minY = (b && isFinite(b.min.y)) ? b.min.y : -1;
    var minZ = (b && isFinite(b.min.z)) ? b.min.z : -64;
    var maxZ = (b && isFinite(b.max.z)) ? b.max.z : 20;
    var ox = minX - SV_PAD_XZ, oz = minZ - SV_PAD_XZ;
    var sx = (maxX + SV_PAD_XZ) - ox, sz = (maxZ + SV_PAD_XZ) - oz;
    // The vertical extent is deliberately NOT the level's full 27 m: above the
    // roofline the shader's outside-the-box fade already returns "open sky", so
    // spending texels up there just coarsens the storeys that matter.
    var oy = minY - SV_Y_BELOW, sy = SV_Y_SPAN;
    if (!(sx > 1) || !(sz > 1)) { sx = 54; sz = 97; }

    var G = { cs: SV_OCC_CELL, ox: ox - 1.0, oy: oy - 1.0, oz: oz - 1.0 };
    G.nx = Math.ceil((sx + 2) / G.cs);
    G.ny = Math.ceil((sy + 2) / G.cs);
    G.nz = Math.ceil((sz + 2) / G.cs);
    // Coarsen rather than allocate hundreds of MB if the level ever grows.
    while (G.nx * G.ny * G.nz > SV_OCC_MAX) {
      G.cs *= 1.25;
      G.nx = Math.ceil((sx + 2) / G.cs);
      G.ny = Math.ceil((sy + 2) / G.cs);
      G.nz = Math.ceil((sz + 2) / G.cs);
    }
    G.occ = new Uint8Array(G.nx * G.ny * G.nz);
    this._bakeOccupancy(cols, G);

    // ---- per-column roofline, max-filtered over the ray range --------------
    // Anything above this is trivially open, which removes roughly a third of
    // the cells from the ray loop for free.
    var nx = G.nx, ny = G.ny, nz = G.nz;
    var top = new Int16Array(nx * nz);
    var i, j, k;
    for (k = 0; k < nz; k++) {
      for (i = 0; i < nx; i++) {
        var hi = -1;
        for (j = ny - 1; j >= 0; j--) {
          if (G.occ[(k * ny + j) * nx + i]) { hi = j; break; }
        }
        top[k * nx + i] = hi;
      }
    }
    var rad = Math.max(1, Math.ceil(SV_RANGE / G.cs));
    var tmp = new Int16Array(nx * nz);
    for (k = 0; k < nz; k++) {
      for (i = 0; i < nx; i++) {
        var m1 = -1;
        var a = Math.max(0, i - rad), bb = Math.min(nx - 1, i + rad);
        for (var q = a; q <= bb; q++) { var v = top[k * nx + q]; if (v > m1) m1 = v; }
        tmp[k * nx + i] = m1;
      }
    }
    for (i = 0; i < nx; i++) {
      for (k = 0; k < nz; k++) {
        var m2 = -1;
        var c0 = Math.max(0, k - rad), c1 = Math.min(nz - 1, k + rad);
        for (var q2 = c0; q2 <= c1; q2++) { var v2 = tmp[q2 * nx + i]; if (v2 > m2) m2 = v2; }
        top[k * nx + i] = m2;
      }
    }

    // ---- the ray pass ------------------------------------------------------
    var W = SV_W, H = SV_H, D = SV_D;
    var vis = new Float32Array(W * H * D);
    var solid = new Uint8Array(W * H * D);
    var dxs = sx / W, dys = sy / H, dzs = sz / D;
    var invOcc = 1 / G.cs;
    var rayResidue = SV_HIT_RESIDUE / SV_RANGE;
    var traced = 0;

    for (var kz = 0; kz < D; kz++) {
      var wz = oz + (kz + 0.5) * dzs;
      var occK = Math.floor((wz - G.oz) * invOcc);
      for (var ky = 0; ky < H; ky++) {
        var wy = oy + (ky + 0.5) * dys;
        var occJ = Math.floor((wy - G.oy) * invOcc);
        for (var kx = 0; kx < W; kx++) {
          var wx = ox + (kx + 0.5) * dxs;
          var idx = (kz * H + ky) * W + kx;
          var occI = Math.floor((wx - G.ox) * invOcc);
          if (occI >= 0 && occI < nx && occJ >= 0 && occJ < ny && occK >= 0 && occK < nz) {
            if (G.occ[(occK * ny + occJ) * nx + occI]) { solid[idx] = 1; vis[idx] = 0; continue; }
            if (occJ > top[occK * nx + occI]) { vis[idx] = 1; continue; }
          } else {
            vis[idx] = 1; continue;
          }

          // Spin the shared direction set per cell so the azimuthal quantisation
          // does not print as a lattice across a big flat floor.
          var hsh = ((kx * 7 + ky * 13 + kz * 29) & 15) / 16;
          var pc = Math.cos(hsh * 6.2831853), ps = Math.sin(hsh * 6.2831853);
          var sum = 0;
          for (var r = 0; r < SV_RAYS; r++) {
            var Dr = SV_DIRS[r];
            var cc = Dr.c * pc - Dr.s * ps;
            var ss = Dr.s * pc + Dr.c * ps;
            var h = svTrace(G, wx, wy, wz, Dr.r * cc, Dr.y, Dr.r * ss, SV_RANGE);
            // A blocked ray is not black: an interior still sees light bounced
            // off whatever it hit. Grading the residue by distance also turns
            // a 12-sample binary estimator into a smooth field.
            sum += (h < 0) ? 1 : h * rayResidue;
            traced++;
          }
          vis[idx] = sum / SV_RAYS;
        }
      }
    }

    // ---- flood into solid cells -------------------------------------------
    // A fragment sitting on a wall trilinearly blends the air in front of it
    // with the sealed cell behind it. Without this every surface in the game
    // loses roughly half its ambient.
    for (var pass = 0; pass < 3; pass++) {
      var changed = 0;
      for (k = 0; k < D; k++) {
        for (j = 0; j < H; j++) {
          for (i = 0; i < W; i++) {
            var id2 = (k * H + j) * W + i;
            if (!solid[id2]) continue;
            var best = -1;
            if (i > 0 && !solid[id2 - 1]) best = Math.max(best, vis[id2 - 1]);
            if (i < W - 1 && !solid[id2 + 1]) best = Math.max(best, vis[id2 + 1]);
            if (j > 0 && !solid[id2 - W]) best = Math.max(best, vis[id2 - W]);
            if (j < H - 1 && !solid[id2 + W]) best = Math.max(best, vis[id2 + W]);
            if (k > 0 && !solid[id2 - W * H]) best = Math.max(best, vis[id2 - W * H]);
            if (k < D - 1 && !solid[id2 + W * H]) best = Math.max(best, vis[id2 + W * H]);
            if (best >= 0) { vis[id2] = best; solid[id2] = 2; changed++; }
          }
        }
      }
      for (i = 0; i < solid.length; i++) if (solid[i] === 2) solid[i] = 0;
      if (!changed) break;
    }

    // ---- one separable smoothing pass -------------------------------------
    var tmpV = new Float32Array(W * H * D);
    var axis, o1;
    for (axis = 0; axis < 3; axis++) {
      var stride = axis === 0 ? 1 : (axis === 1 ? W : W * H);
      var lim = axis === 0 ? W : (axis === 1 ? H : D);
      for (k = 0; k < D; k++) {
        for (j = 0; j < H; j++) {
          for (i = 0; i < W; i++) {
            var id3 = (k * H + j) * W + i;
            var pos = axis === 0 ? i : (axis === 1 ? j : k);
            var a1 = pos > 0 ? vis[id3 - stride] : vis[id3];
            var b1 = pos < lim - 1 ? vis[id3 + stride] : vis[id3];
            tmpV[id3] = vis[id3] * 0.5 + (a1 + b1) * 0.25;
          }
        }
      }
      for (o1 = 0; o1 < tmpV.length; o1++) vis[o1] = tmpV[o1];
    }

    // ---- upload ------------------------------------------------------------
    var data = SV_DATA;
    var mean = 0;
    for (i = 0; i < vis.length; i++) {
      var vv = vis[i] < 0 ? 0 : (vis[i] > 1 ? 1 : vis[i]);
      mean += vv;
      data[i] = (vv * 255 + 0.5) | 0;
    }
    mean /= vis.length;
    SV_TEX.needsUpdate = true;

    SV_ORIGIN[0] = ox; SV_ORIGIN[1] = oy; SV_ORIGIN[2] = oz;
    SV_INVSIZE[0] = 1 / sx; SV_INVSIZE[1] = 1 / sy; SV_INVSIZE[2] = 1 / sz;
    SV_PARAMS[0] = SV_FLOOR; SV_PARAMS[1] = SV_GAMMA; SV_PARAMS[2] = SV_SPEC;
    SV_PARAMS[3] = 1;
    SV_PARAMS2[0] = SV_NORMAL_OFFSET;
    this._svGate = 1;

    this.skyVis = {
      data: data, w: W, h: H, d: D,
      ox: ox, oy: oy, oz: oz, sx: sx, sy: sy, sz: sz
    };
    this.skyVisReady = true;
    // Re-derive the reference from the field that was just baked instead of
    // trusting a hand-transcribed constant. 0.68 was written down when the level
    // had a different roofline; the roadway now measures ~0.47, and pinning the
    // compensation to a value the street does not have was running the whole
    // street ~0.4 stops under its own fixed point. Clamped because this scales
    // every indirect term in the build - a pathological bake must not be able to
    // double the game's ambient.
    this.skyRef = M.clamp(this._probeRoadwayVisibility(lvl), 0.20, 0.95);
    this.skyComp = M.clamp(1 / svShape(this.skyRef), 1.0, 1.62);
    this.skyCompDir = M.clamp(svCompDir(this.skyRef), 1.0, 1.30);

    // The field is live, so the practicals can finally be placed against real
    // geometry instead of against ART_DIRECTION's prose. Order matters: move
    // them first, then measure the enclosure of where they ended up.
    this._anchorPracticals(ctx, G);
    this._clampPracticals(G);

    // Practicals that live in an occluded pocket ARE the interior lighting;
    // with the ambient floor pulled out from under them they finally have room
    // to sculpt, so give them the headroom back. Street lamps see open sky and
    // are left exactly where they were.
    for (i = 0; i < this.practicals.length; i++) {
      var p = this.practicals[i];
      var pv = this.skyVisibilityAt(p.base);
      p.enclosure = 1 - M.smoothstep(0.06, 0.38, pv);
      // Measured, not guessed: at 1 + 1.15 * enclosure the relocated shop lamp
      // lit the back of the room to 0.28 while the floor in the window pool sat
      // at 0.23, i.e. it recreated the inversion from the other direction. The
      // volume only takes ~0.10 of the nominal ambient away in there, so the
      // headroom the practicals need back is correspondingly modest.
      p.boost = 1 + 0.55 * p.enclosure;
      // A spot practical's target has to follow it, or a lamp that _anchorPracticals
      // relocated goes on pointing at where it used to be.
      if (p.light.isSpotLight && p.light.target) {
        p.light.target.position.set(p.base.x, p.base.y - 3.0, p.base.z);
      }
    }

    // Everything below needs the occupancy grid AND the final lamp positions.
    this._buildLampVisuals(ctx, G);
    this._buildShafts(ctx, G);

    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    this._svDiag = {
      ms: Math.round(t1 - t0), rays: traced, mean: Math.round(mean * 1000) / 1000,
      occ: G.nx + 'x' + G.ny + 'x' + G.nz, cell: Math.round(G.cs * 100) / 100
    };
  };

  // --------------------------------------------------------------------------
  // Practical placement against the real level
  //
  // Two passes, both driven by the occupancy grid the sky bake already built:
  //
  //   _anchorPracticals - a light tagged with an `anchor` is moved to the best
  //     free cell near level.cameraPoses[anchor]. "Best" = most enclosed, at
  //     roughly the authored distance from the pose, as high as the room allows,
  //     spaced away from siblings, and - the important one - REACHABLE from the
  //     pose without crossing a wall, tested with the same DDA the sky rays use.
  //     That last test is what stops the search from finding an equally dark
  //     cell on the far side of the shop's back wall.
  //
  //   _clampPracticals - a light that is buried in geometry, or closer than
  //     ~1.1 m to it, is pushed to the nearest position with real clearance.
  //     A point light at 0.8 m from a wall puts 12/0.64 = 19 units of
  //     irradiance on it, which is what a facade brighter at midnight than at
  //     civil twilight actually looks like from the inside.
  // --------------------------------------------------------------------------
  Lighting.prototype._occupiedAt = function (G, x, y, z, r) {
    if (!G || !G.occ) return true;
    var inv = 1 / G.cs;
    var i0 = Math.floor((x - r - G.ox) * inv), i1 = Math.floor((x + r - G.ox) * inv);
    var j0 = Math.floor((y - r - G.oy) * inv), j1 = Math.floor((y + r - G.oy) * inv);
    var k0 = Math.floor((z - r - G.oz) * inv), k1 = Math.floor((z + r - G.oz) * inv);
    // Outside the baked box we know nothing, so treat it as blocked rather than
    // as free - a lamp must never be relocated into unmapped space.
    if (i0 < 0 || j0 < 0 || k0 < 0 || i1 >= G.nx || j1 >= G.ny || k1 >= G.nz) return true;
    for (var k = k0; k <= k1; k++) {
      for (var j = j0; j <= j1; j++) {
        var row = (k * G.ny + j) * G.nx;
        for (var i = i0; i <= i1; i++) if (G.occ[row + i]) return true;
      }
    }
    return false;
  };

  var CLEARANCE_STEPS = [1.6, 1.1, 0.7, 0.4];

  Lighting.prototype._clearanceAt = function (G, x, y, z) {
    for (var i = 0; i < CLEARANCE_STEPS.length; i++) {
      if (!this._occupiedAt(G, x, y, z, CLEARANCE_STEPS[i])) return CLEARANCE_STEPS[i];
    }
    return 0;
  };

  Lighting.prototype._anchorPracticals = function (ctx, G) {
    var lvl = ctx && ctx.level;
    var poses = lvl && lvl.cameraPoses;
    if (!poses || !G || !G.occ) return;
    var takenX = [], takenZ = [];
    var probe = { x: 0, y: 0, z: 0 };

    for (var i = 0; i < this.practicals.length; i++) {
      var p = this.practicals[i];
      if (!p.anchor) continue;
      var pose = poses[p.anchor];
      var a = pose && pose.position;
      if (!a || !isFinite(a.x) || !isFinite(a.y) || !isFinite(a.z)) continue;

      var y0 = p.base.y;
      var bx = 0, by = 0, bz = 0, bestScore = Infinity, found = false;
      for (var dz = -4.5; dz <= 4.51; dz += 0.5) {
        for (var dx = -4.5; dx <= 4.51; dx += 0.5) {
          var hd = Math.sqrt(dx * dx + dz * dz);
          if (hd > 4.6) continue;
          for (var dy = -0.6; dy <= 0.61; dy += 0.3) {
            var qx = a.x + dx, qy = y0 + dy, qz = a.z + dz;
            if (this._occupiedAt(G, qx, qy, qz, 0.42)) continue;
            // Line of sight from the composition's own camera position: same
            // room, no wall in between.
            var ex = qx - a.x, ey = qy - a.y, ez = qz - a.z;
            var len = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (len > 0.1) {
              var inv = 1 / len;
              if (svTrace(G, a.x, a.y, a.z, ex * inv, ey * inv, ez * inv, len - 0.1) >= 0) continue;
            }
            probe.x = qx; probe.y = qy; probe.z = qz;
            var vis = this.skyVisibilityAt(probe);
            var sep = 0;
            for (var s = 0; s < takenX.length; s++) {
              var sdx = qx - takenX[s], sdz = qz - takenZ[s];
              var sd = Math.sqrt(sdx * sdx + sdz * sdz);
              if (sd < 3.2) sep += (3.2 - sd) * 0.7;
            }
            // Enclosure dominates; then distance from the pose, then height
            // (a practical belongs near the ceiling), then sibling spacing.
            var score = vis * 4.0 + Math.abs(hd - p.spread) * 0.34 +
              (y0 + 0.6 - qy) * 0.4 + sep;
            if (score < bestScore) {
              bestScore = score; bx = qx; by = qy; bz = qz; found = true;
            }
          }
        }
      }
      if (!found) continue;
      p.base.set(bx, by, bz);
      p.light.position.copy(p.base);
      p.relocated = true;
      takenX.push(bx); takenZ.push(bz);
    }
  };

  Lighting.prototype._clampPracticals = function (G) {
    if (!G || !G.occ) return;
    for (var i = 0; i < this.practicals.length; i++) {
      var p = this.practicals[i];
      // Anchored lights were placed against this very grid a moment ago, with a
      // deliberate preference for sitting high and tight under a ceiling.
      // Re-clamping them for "clearance" would just pull them back into the
      // middle of the room and undo that.
      if (p.relocated) continue;
      var x0 = p.base.x, y0 = p.base.y, z0 = p.base.z;
      // Trigger only on genuinely buried or wall-hugging fixtures. A brazier
      // 0.7 m off the ground and a lamp head under an awning are both correct
      // and must not be nudged.
      if (this._clearanceAt(G, x0, y0, z0) >= 0.7) continue;
      var bx = x0, by = y0, bz = z0, bestScore = Infinity, found = false;
      for (var dz = -2.4; dz <= 2.41; dz += 0.3) {
        for (var dx = -2.4; dx <= 2.41; dx += 0.3) {
          for (var dy = -0.6; dy <= 0.31; dy += 0.3) {
            var qx = x0 + dx, qy = y0 + dy, qz = z0 + dz;
            var c = this._clearanceAt(G, qx, qy, qz);
            if (c < 0.7) continue;
            var move = Math.sqrt(dx * dx + dy * dy + dz * dz);
            var score = move * 0.5 + Math.max(0, 1.3 - c) * 3.0;
            if (score < bestScore) {
              bestScore = score; bx = qx; by = qy; bz = qz; found = true;
            }
          }
        }
      }
      if (!found) continue;
      p.base.set(bx, by, bz);
      p.light.position.copy(p.base);
      p.clamped = true;
    }
  };

  // Trilinear CPU probe of the baked field. Used for the viewmodel rig and the
  // practicals; also the honest way to answer "is the player indoors".
  Lighting.prototype.skyVisibilityAt = function (p) {
    var S = this.skyVis;
    if (!S || !p) return 1;
    var fx = (p.x - S.ox) / S.sx * S.w - 0.5;
    var fy = (p.y - S.oy) / S.sy * S.h - 0.5;
    var fz = (p.z - S.oz) / S.sz * S.d - 0.5;
    if (!(isFinite(fx) && isFinite(fy) && isFinite(fz))) return 1;
    var i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
    var tx = fx - i0, ty = fy - j0, tz = fz - k0;
    var acc = 0;
    for (var dk = 0; dk < 2; dk++) {
      var k = M.clamp(k0 + dk, 0, S.d - 1);
      var wk = dk ? tz : 1 - tz;
      for (var dj = 0; dj < 2; dj++) {
        var j = M.clamp(j0 + dj, 0, S.h - 1);
        var wj = dj ? ty : 1 - ty;
        for (var di = 0; di < 2; di++) {
          var i = M.clamp(i0 + di, 0, S.w - 1);
          var wi = di ? tx : 1 - tx;
          acc += S.data[(k * S.h + j) * S.w + i] * wi * wj * wk;
        }
      }
    }
    return acc / 255;
  };

  // The compensation's fixed point. Sampled down the carriageway rather than at
  // one hand-picked coordinate, because a single probe is hostage to whatever
  // prop happens to have been dropped on it since the number was written down.
  Lighting.prototype._probeRoadwayVisibility = function (lvl) {
    if (!this.skyVis) return SV_REF;
    var zs = [8, 2, -6, -14, -22, -30];
    var sum = 0, n = 0;
    var poses = lvl && lvl.cameraPoses;
    var sp = poses && poses.street && poses.street.position;
    for (var i = 0; i < zs.length; i++) {
      _v1.set(0, 1.6, zs[i]);
      var v = this.skyVisibilityAt(_v1);
      // A reading that low means the probe landed inside geometry, not on the
      // roadway; averaging it in would drag the whole build brighter.
      if (!(isFinite(v) && v > 0.08)) continue;
      sum += v; n++;
    }
    if (sp) {
      var v2 = this.skyVisibilityAt(sp);
      if (isFinite(v2) && v2 > 0.08) { sum += v2 * 2; n += 2; }
    }
    return n ? (sum / n) : SV_REF;
  };

  // ==========================================================================
  // VISIBLE LIGHT SOURCES
  //
  // A PointLight is invisible. A probe of the running night scene counted ZERO
  // emissive meshes in the entire scene graph - no bulbs, no lit fixtures, no
  // glowing windows, no halos - which is why the night frame read as "an
  // underexposed day" rather than as night: there was nothing in it that looked
  // like a light. Photographically the sources ARE the picture after dark; they
  // own the highlights, they give the eye something to expose against, and they
  // are what puts warm content above the median so the grade can split.
  //
  // Three instanced meshes, all optional, all skipped entirely by day:
  //   bulbs   - a small emissive sphere at each practical
  //   halos   - an additive camera-facing card, radius from the lamp's own reach
  //   windows - warm cards found on the real facades via the occupancy grid
  // Everything is castShadow false and receiveShadow false so none of it can
  // enter the shadow pass, and every card is small enough that postfx's
  // highlight-rejecting log metering cannot be swung by it.
  // ==========================================================================
  var GLOW_TEX = {};

  function makeGlowTexture(size, kind) {
    if (GLOW_TEX[kind]) return GLOW_TEX[kind];
    var data = new Uint8Array(size * size * 4);
    var k = 14.0, inv = 1 / (1 - 1 / (1 + k));
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = (x + 0.5) / size * 2 - 1;
        var v = (y + 0.5) / size * 2 - 1;
        var a;
        if (kind === 'window') {
          // A soft-edged rectangle with a little more light spilling from the
          // head of the opening, which is what a room lit from a ceiling
          // fitting actually looks like through glass.
          var ex = 1 - M.smoothstep(0.40, 0.98, Math.abs(u));
          var ey = 1 - M.smoothstep(0.46, 0.99, Math.abs(v));
          a = ex * ey * (0.70 + 0.30 * M.saturate(0.5 - v * 0.5));
        } else {
          var r2 = u * u + v * v;
          a = r2 > 1 ? 0 : (1 / (1 + k * r2) - 1 / (1 + k)) * inv;
          a = Math.pow(a > 0 ? a : 0, 1.15);
        }
        var b = M.clamp(Math.round(a * 255), 0, 255);
        var o = (y * size + x) * 4;
        data[o] = b; data[o + 1] = b; data[o + 2] = b; data[o + 3] = b;
      }
    }
    var t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat,
      THREE.UnsignedByteType);
    t.name = 'blackoutGlow_' + kind;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;   // it is a mask, not an albedo
    t.needsUpdate = true;
    GLOW_TEX[kind] = t;
    return t;
  }

  // March outward from the street centreline until the occupancy grid says
  // there is a wall. Returns 0 when nothing was found inside the search span.
  Lighting.prototype._findFacadeX = function (G, sign, y, z) {
    for (var x = 3.5; x < 12.5; x += 0.25) {
      if (this._occupiedAt(G, sign * x, y, z, 0.10)) return sign * x;
    }
    return 0;
  };

  Lighting.prototype._findLitWindows = function (G) {
    var out = [];
    if (!G || !G.occ) return out;
    var rng = this.rng;
    // Alternating sides, receding down the street. A line of warm windows going
    // away from the camera is the cheapest depth cue there is after dark, and
    // it is the one thing that tells the eye the street has a far end.
    var zs = [-8.5, -15.0, -22.0, -29.5, -12.0, -25.5];
    for (var i = 0; i < zs.length && out.length < MAX_WINDOWS; i++) {
      var sign = (i % 2 === 0) ? 1 : -1;
      var y = 3.5 + rng.range(0, 2.9);
      var z = zs[i] + rng.range(-1.1, 1.1);
      var wx = this._findFacadeX(G, sign, y, z);
      if (!wx) continue;
      // The occupancy lattice is 0.5 m, so the reported face can be a quarter
      // of a cell out either way. The card is additive, so standing it proud of
      // the plaster costs nothing visually and guarantees it never ends up
      // buried inside the wall it is supposed to be glowing on.
      var cx = wx - sign * 0.40;
      if (this._occupiedAt(G, cx, y, z, 0.22)) continue;
      out.push({
        x: cx, y: y, z: z, sign: sign,
        w: rng.range(0.72, 1.05), h: rng.range(0.95, 1.5),
        kelvin: rng.range(2350, 3150), gain: rng.range(0.6, 1.25)
      });
    }
    return out;
  };

  Lighting.prototype._buildLampVisuals = function (ctx, G) {
    if (this._lampVisuals) return;
    try {
      if (!THREE.InstancedMesh || !THREE.DataTexture) return;
      var n = this.practicals.length;
      var wins = this._findLitWindows(G);
      if (n <= 0 && !wins.length) return;

      var halo = makeGlowTexture(64, 'halo');
      var winTex = makeGlowTexture(64, 'window');
      var quad = new THREE.PlaneGeometry(1, 1);
      var vis = { wins: wins, bulbs: null, halos: null, windows: null };

      // ---- bulbs -----------------------------------------------------------
      if (n > 0) {
        var bulbGeo = new THREE.SphereGeometry(1, 8, 6);
        var bulbMat = new THREE.MeshBasicMaterial({
          color: 0xffffff, toneMapped: false, fog: false
        });
        var bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, n);
        bulbs.name = 'practicalBulbs';
        bulbs.castShadow = false; bulbs.receiveShadow = false;
        bulbs.frustumCulled = false;
        bulbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.root.add(bulbs);
        vis.bulbs = bulbs;
      }

      // ---- halos (practicals + windows) ------------------------------------
      var nh = n + wins.length;
      var haloMat = new THREE.MeshBasicMaterial({
        map: halo, color: 0xffffff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false,
        toneMapped: false, fog: false, side: THREE.DoubleSide
      });
      var halos = new THREE.InstancedMesh(quad, haloMat, nh);
      halos.name = 'practicalHalos';
      halos.castShadow = false; halos.receiveShadow = false;
      halos.frustumCulled = false;
      halos.renderOrder = 3;
      halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(halos);
      vis.halos = halos;

      // ---- window cards ----------------------------------------------------
      if (wins.length) {
        var winMat = new THREE.MeshBasicMaterial({
          map: winTex, color: 0xffffff, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false,
          toneMapped: false, fog: false, side: THREE.DoubleSide
        });
        var winMesh = new THREE.InstancedMesh(quad, winMat, wins.length);
        winMesh.name = 'litWindows';
        winMesh.castShadow = false; winMesh.receiveShadow = false;
        winMesh.frustumCulled = false;
        winMesh.renderOrder = 2;
        this.root.add(winMesh);
        // The cards never move, so their matrices are written exactly once.
        var m = new THREE.Matrix4();
        for (var w = 0; w < wins.length; w++) {
          var d = wins[w];
          // Facing inward across the street: a quad's normal is +Z, so a yaw of
          // +/- 90 degrees turns it to face -/+ X.
          _q1.setFromAxisAngle(_upY, d.sign > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
          m.compose(_v1.set(d.x, d.y, d.z), _q1, _v2.set(d.w * 2.2, d.h * 2.2, 1));
          winMesh.setMatrixAt(w, m);
          d.color = GAME.Color.kelvin(d.kelvin, new THREE.Color());
          // Each window also gets a halo entry - glass spills into the air.
          _q1.identity();
          m.compose(_v1.set(d.x - d.sign * 0.10, d.y, d.z), _q1,
            _v2.set(d.w * 4.0, d.w * 4.0, 1));
          halos.setMatrixAt(n + w, m);
        }
        winMesh.instanceMatrix.needsUpdate = true;
        vis.windows = winMesh;
      }

      // The instance buffers are sized once. addPractical() can grow
      // this.practicals afterwards, so the update loop indexes against the built
      // count, never against the live array length.
      vis.nP = n;
      this._lampVisuals = vis;
      this._lampMat = new THREE.Matrix4();
    } catch (e) {
      GAME.logError('lighting.lampVisuals', e);
      this._lampVisuals = null;
    }
  };

  Lighting.prototype._updateLampVisuals = function (ctx) {
    var vis = this._lampVisuals;
    if (!vis) return;
    var lampOn = this._lampOn;
    var cam = ctx && ctx.camera;
    var n = Math.min(vis.nP || 0, this.practicals.length);
    var m = this._lampMat;
    var i, p, lit;

    // Nothing to draw in daylight - the whole set costs zero draw calls then.
    var anyOn = lampOn > 0.02;
    if (vis.bulbs) vis.bulbs.visible = anyOn;
    if (vis.halos) vis.halos.visible = anyOn;
    if (vis.windows) vis.windows.visible = anyOn;
    if (!anyOn) return;

    if (cam) _q1.copy(cam.quaternion); else _q1.identity();

    if (vis.bulbs) {
      for (i = 0; i < n && i < vis.bulbs.count; i++) {
        p = this.practicals[i];
        lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2);
        var r = BULB_RADIUS * (0.85 + 0.35 * M.saturate(lit));
        m.makeScale(r, r, r);
        m.setPosition(p.light.position.x, p.light.position.y, p.light.position.z);
        vis.bulbs.setMatrixAt(i, m);
        // Emissive level tracks the light's own live output, so a stuttering
        // sodium head and a gusting brazier flicker in the glass as well as on
        // the ground - the give-away that a "light source" is really a decal is
        // that it stays put while the light it claims to emit moves.
        _c1.copy(p.light.color).multiplyScalar(BULB_GAIN * lit);
        vis.bulbs.setColorAt(i, _c1);
      }
      vis.bulbs.instanceMatrix.needsUpdate = true;
      if (vis.bulbs.instanceColor) vis.bulbs.instanceColor.needsUpdate = true;
    }

    if (vis.halos) {
      for (i = 0; i < n && i < vis.halos.count; i++) {
        p = this.practicals[i];
        lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2);
        var s = M.clamp((p.distance || 10) * (p.haloScale || HALO_SCALE) * 0.34, 0.7, 2.8) *
          (0.8 + 0.3 * M.saturate(lit));
        m.compose(p.light.position, _q1, _v2.set(s, s, 1));
        vis.halos.setMatrixAt(i, m);
        _c1.copy(p.light.color).multiplyScalar(HALO_GAIN * lit);
        vis.halos.setColorAt(i, _c1);
      }
      for (var w = 0; w < vis.wins.length; w++) {
        var d = vis.wins[w];
        _c1.copy(d.color).multiplyScalar(HALO_GAIN * 0.55 * d.gain * lampOn);
        // Window halos live in the slots after the practicals, at the offset the
        // matrices were written with - not at the live practical count.
        vis.halos.setColorAt(vis.nP + w, _c1);
      }
      vis.halos.instanceMatrix.needsUpdate = true;
      if (vis.halos.instanceColor) vis.halos.instanceColor.needsUpdate = true;
    }

    if (vis.windows) {
      for (var v2 = 0; v2 < vis.wins.length; v2++) {
        var d2 = vis.wins[v2];
        // A slow, shallow drift so the row of windows is not a set of identical
        // static rectangles - somebody is moving around behind each of them.
        var fl = 1 + this.noise.perlin2(this._t * 0.23 + v2 * 13.7, 3.3) * 0.11;
        _c1.copy(d2.color).multiplyScalar(1.35 * d2.gain * lampOn * fl);
        vis.windows.setColorAt(v2, _c1);
      }
      if (vis.windows.instanceColor) vis.windows.instanceColor.needsUpdate = true;
    }
  };

  // ==========================================================================
  // THE SHAFT OF LIGHT
  //
  // level.js publishes level.lightShafts and comments the entry as "the art
  // direction's ONE SHAFT OF LIGHT", but nothing in the build consumed it - the
  // contract was dangling, and the alley rendered with zero vertical gradient
  // and a neutral-cool brightest 1%, i.e. its highlights were skylight, not sun.
  //
  // The sun cannot deliver it: at the alley preset the key is 11 degrees up and
  // 34 degrees off the street axis, entering a 3.7 m slot between 11 m walls, so
  // no solar ray reaches below ~11 m. A shaft in a canyon is always a local
  // light, so it is built as one: a spot on the key axis, a target solved
  // against real geometry, and an additive haze cone so the beam exists in air
  // as well as on the floor. That cone is the only thing in the build that will
  // produce the god rays ART_DIRECTION is built around.
  // ==========================================================================
  // Candela budget: keyIntensity * length^2 * this. At 1.0 the irradiance in the
  // pool is exactly the key's - the physically honest answer, since a shaft of
  // sunlight IS sunlight cut down to a 3 m aperture by the roofline. In practice
  // it has to sit under that: the pool is measured against an alley the camera
  // is already exposed for, so full solar irradiance simply clipped everything
  // it touched to white. 0.55 keeps it the brightest thing in the framing by a
  // clear margin while the plaster inside it still has texture.
  var SHAFT_GAIN = 0.68;
  // The haze is an ADDITIVE approximation of a volume, so its brightness has no
  // tone curve above it and it clips very early. At 0.17 the beam printed as a
  // solid white wedge with a visible rim - a cone-shaped object, not a beam.
  var SHAFT_HAZE = 0.055;

  Lighting.prototype._buildShafts = function (ctx, G) {
    if (this._shafts || !G || !G.occ) return;
    this._shafts = [];
    var lvl = ctx && ctx.level;
    var defs = lvl && lvl.lightShafts;
    if (!Array.isArray(defs) || !defs.length) return;
    try {
      var poses = (lvl && lvl.cameraPoses) || null;
      for (var i = 0; i < defs.length && this._shafts.length < 2; i++) {
        var solved = this._solveShaft(G, defs[i], poses);
        if (solved) this._makeShaft(solved, this._shafts.length === 0);
      }
    } catch (e) {
      GAME.logError('lighting.shafts', e);
    }
  };

  // Find a floor patch the shaft can land on that the framing will actually
  // see, then find how much clear air sits above it. Both tests reuse the DDA
  // the sky-visibility bake already runs, so this costs nothing new.
  Lighting.prototype._solveShaft = function (G, def, poses) {
    if (!def || !def.origin) return null;
    var width = isFinite(def.width) ? M.clamp(def.width, 0.8, 6.0) : 2.8;

    // Beam axis. The published `dir` is taken off the sun, which at these hours
    // is 11-14 degrees above the horizon - a ray that shallow cannot descend
    // into a slot between two 11 m blocks at all (it needs 45 m of run to drop
    // one storey). So the axis keeps the sun's AZIMUTH, which is what makes the
    // beam agree with the shadows, and takes a usable elevation from the geometry
    // instead of from the almanac.
    var hx = 0, hz = -1;
    if (def.dir && isFinite(def.dir.x)) {
      var hl = Math.sqrt(def.dir.x * def.dir.x + def.dir.z * def.dir.z);
      if (hl > 1e-4) { hx = def.dir.x / hl; hz = def.dir.z / hl; }
    }
    // 0.18 of horizontal lean, not more: the alley is a 3.7 m slot, so a beam
    // that drifts 3 m sideways over its own length puts its aperture inside the
    // wall it is supposed to be coming past - and a spot embedded in geometry
    // shadow-maps itself to nothing.
    var bx = hx * 0.18, by = -1, bz = hz * 0.18;
    var bl = Math.sqrt(bx * bx + 1 + bz * bz);
    bx /= bl; by /= bl; bz /= bl;

    var pose = poses && def.kind && poses[def.kind];
    var pp = pose && pose.position;
    var ex = def.origin.x, ey = def.origin.y, ez = def.origin.z;
    var best = null;

    if (pp && isFinite(pose.yaw)) {
      // forward for yaw t is ( -sin t, 0, -cos t ) - the same convention the
      // scenario poses are authored in.
      var fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw);
      var rx = -fz, rz = fx;
      for (var d = 3.0; d <= 8.0; d += 0.5) {
        for (var lat = -1.5; lat <= 1.51; lat += 0.5) {
          var px = pp.x + fx * d + rx * lat;
          var pz = pp.z + fz * d + rz * lat;
          var top = pp.y + 0.5;
          var down = svTrace(G, px, top, pz, 0, -1, 0, 5.0);
          if (down < 0) continue;                       // no floor under it
          var fy = top - down + 0.03;
          // Clear air above the landing point, measured back UP the beam axis.
          // 1.2 m of stand-off is kept below whatever it hits so the aperture is
          // in the slot rather than in the parapet.
          var up = svTrace(G, px, fy + 0.45, pz, -bx, -by, -bz, 15.0);
          var run = (up < 0 ? 14.5 : up + 0.45) - 1.2;
          if (run < 4.2) continue;                      // no room for a beam
          // Has to be visible from the framing this shaft belongs to.
          var vx = px - pp.x, vy = fy + 0.7 - pp.y, vz = pz - pp.z;
          var vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (vl > 0.2 &&
            svTrace(G, pp.x, pp.y, pp.z, vx / vl, vy / vl, vz / vl, vl - 0.35) >= 0) continue;
          // A shaft only exists as a CONTRAST, so the landing patch has to be
          // somewhere the sky does not already reach. Weighting the clear run
          // alone put the beam on the alley MOUTH - which is open to the street
          // and already the brightest thing in the framing - and made the one
          // blown region of the frame blown harder. Sky visibility at the patch
          // therefore dominates the score, and the run is capped so a hole in
          // the roofline cannot buy its way past that.
          //
          // The stand-off preference is short and the lateral one is signed, not
          // symmetric. A beam solved at 6.5 m dead ahead landed directly in
          // front of the alley mouth - the one already-blown region of that
          // framing - and simply disappeared into it. Pulled forward it crosses
          // open floor low in the frame with shaded wall behind it, and pushed
          // to the LEFT it stays clear of the weapon, which occupies the right
          // half of every hip-fire framing in the build.
          _v4.set(px, fy + 1.0, pz);
          var pvis = this.skyVisibilityAt(_v4);
          var score = pvis * 7.0 - Math.min(run, 9.0) * 0.5 +
            Math.abs(d - 3.8) * 0.9 + Math.abs(lat + 1.0) * 0.5;
          if (!best || score < best.score) {
            best = { score: score, fx: px, fy: fy, fz: pz, run: Math.min(run, 10.5) };
          }
        }
      }
    }

    if (!best) {
      // No usable pose: fall back to the published aperture and just trace down.
      var hit = svTrace(G, ex, ey, ez, bx, by, bz, 22.0);
      if (hit < 0) return null;
      best = {
        fx: ex + bx * hit, fy: ey + by * hit + 0.03, fz: ez + bz * hit,
        run: Math.min(hit, 10.5)
      };
    }

    var len = M.clamp(best.run, 3.0, 10.5);
    // Final guard: shorten until the aperture genuinely has clearance. The
    // occupancy lattice is 0.5 m, so the analytic stand-off above can still land
    // a spot half inside a parapet, and a shadow-casting spot that starts inside
    // geometry produces no shaft at all - the failure mode is silent.
    for (var g = 0; g < 8; g++) {
      if (!this._occupiedAt(G, best.fx - bx * len, best.fy - by * len,
        best.fz - bz * len, 0.35)) break;
      len -= 0.7;
      if (len < 3.0) return null;
    }
    return {
      kind: def.kind || 'shaft',
      strength: isFinite(def.strength) ? M.clamp(def.strength, 0, 2) : 1,
      width: width,
      len: len,
      floor: new THREE.Vector3(best.fx, best.fy, best.fz),
      pos: new THREE.Vector3(best.fx - bx * len, best.fy - by * len, best.fz - bz * len)
    };
  };

  Lighting.prototype._makeShaft = function (s, withShadow) {
    var spot = new THREE.SpotLight(0xffffff, 0, s.len * 2.4,
      M.clamp(Math.atan((s.width * 0.5) / s.len), 0.10, 0.55), 0.35, 2);
    spot.name = 'lightShaft_' + s.kind;
    spot.position.copy(s.pos);
    spot.target.position.copy(s.floor);
    spot.castShadow = !!withShadow;
    if (withShadow) {
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.0009;
      spot.shadow.normalBias = 0.035;
      spot.shadow.radius = 3;
      spot.shadow.camera.near = 0.4;
      spot.shadow.camera.far = s.len * 2.6;
      spot.shadow.autoUpdate = false;
      spot.shadow.needsUpdate = true;
    }
    this.root.add(spot, spot.target);

    // ---- the haze cone -----------------------------------------------------
    // Built directly in world space with an identity transform: the beam never
    // moves, so there is no reason to carry an orientation. Alpha comes from
    // |N.V| squared, which is the cheap volumetric approximation - a cone is
    // thickest along the view ray at its centreline and vanishes at the
    // silhouette, so the beam has no hard edge anywhere.
    var mesh = null;
    try {
      var SEG = 18, RING = 9;
      var ax = _v1.copy(s.floor).sub(s.pos);
      var len = Math.max(ax.length(), 0.01);
      ax.multiplyScalar(1 / len);
      var up = Math.abs(ax.y) > 0.98 ? _upZ : _upY;
      var u = _v2.crossVectors(up, ax).normalize();
      var vv = _v3.crossVectors(ax, u).normalize();
      var pos = new Float32Array(SEG * RING * 3);
      var nrm = new Float32Array(SEG * RING * 3);
      var glow = new Float32Array(SEG * RING);
      var idx = [];
      var r0 = s.width * 0.12, r1 = s.width * 0.40;
      for (var j = 0; j < RING; j++) {
        var t = j / (RING - 1);
        var rr = M.lerp(r0, r1, t);
        var cxp = s.pos.x + ax.x * len * t;
        var cyp = s.pos.y + ax.y * len * t;
        var czp = s.pos.z + ax.z * len * t;
        // Bright just under the aperture, fading as the dust scatters it out.
        // BOTH ends are taken to zero: a cone that starts or stops at a finite
        // brightness draws its own rim, and a visible rim is what turns a beam
        // back into a cone-shaped object.
        var g = (1 - t * 0.55) *
          M.smoothstep(0.0, 0.16, t) * (1 - M.smoothstep(0.78, 1.0, t));
        for (var i2 = 0; i2 < SEG; i2++) {
          var a = i2 / SEG * Math.PI * 2;
          var ca = Math.cos(a), sa = Math.sin(a);
          var nx = u.x * ca + vv.x * sa;
          var ny = u.y * ca + vv.y * sa;
          var nz = u.z * ca + vv.z * sa;
          var o = (j * SEG + i2) * 3;
          pos[o] = cxp + nx * rr; pos[o + 1] = cyp + ny * rr; pos[o + 2] = czp + nz * rr;
          nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
          glow[j * SEG + i2] = g;
        }
      }
      for (var j2 = 0; j2 < RING - 1; j2++) {
        for (var i3 = 0; i3 < SEG; i3++) {
          var a0 = j2 * SEG + i3, b0 = j2 * SEG + ((i3 + 1) % SEG);
          idx.push(a0, b0, a0 + SEG, b0, b0 + SEG, a0 + SEG);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
      geo.setIndex(idx);
      var mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(1, 1, 1) },
          uAmt: { value: 0 }
        },
        vertexShader: [
          'attribute float aGlow;',
          'varying float vGlow;',
          'varying vec3 vN;',
          'varying vec3 vV;',
          'void main() {',
          '  vec4 mv = modelViewMatrix * vec4( position, 1.0 );',
          '  vN = normalMatrix * normal;',
          '  vV = - mv.xyz;',
          '  vGlow = aGlow;',
          '  gl_Position = projectionMatrix * mv;',
          '}'
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 uColor;',
          'uniform float uAmt;',
          'varying float vGlow;',
          'varying vec3 vN;',
          'varying vec3 vV;',
          'void main() {',
          '  float f = abs( dot( normalize( vN ), normalize( vV ) ) );',
          '  f *= f;',
          '  gl_FragColor = vec4( uColor * ( uAmt * vGlow * f ), 1.0 );',
          '}'
        ].join('\n'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'shaftHaze_' + s.kind;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.root.add(mesh);
    } catch (e) {
      GAME.logError('lighting.shaftHaze', e);
      mesh = null;
    }

    this._shafts.push({ light: spot, haze: mesh, def: s });
  };

  Lighting.prototype._updateShafts = function (ctx) {
    var list = this._shafts;
    if (!list || !list.length) return;
    // Purely a daylight effect: after sundown there is no sun to make a shaft
    // of, and leaving one lit is the single most obvious "the lighting does not
    // know what time it is" tell there is.
    var amt = this.dayFactor * M.saturate(1 - this.duskFactor * 0.75);
    for (var i = 0; i < list.length; i++) {
      var sh = list[i];
      var d = sh.def;
      var on = amt * d.strength;
      // Spot intensity is candela, so the budget has to carry the r-squared the
      // inverse-square falloff is about to take back out.
      sh.light.intensity = this.keyIntensity * d.len * d.len * SHAFT_GAIN * on;
      sh.light.color.copy(this.keyColor);
      sh.light.visible = on > 0.02;
      if (sh.haze) {
        sh.haze.visible = on > 0.02;
        sh.haze.material.uniforms.uColor.value.copy(this.keyColor);
        sh.haze.material.uniforms.uAmt.value =
          M.clamp(this.keyIntensity * SHAFT_HAZE, 0, 1.1) * on;
      }
    }
  };

  // The volume is baked in WORLD space, but the viewmodel scene is authored in
  // CAMERA space - its fragments resolve to a world position near the origin,
  // which would occlude the gun with whatever happens to sit mid-street. So the
  // gate is switched off for the viewmodel pass and the gun is instead dimmed
  // on the CPU by the visibility probed at the player. three calls
  // scene.onBeforeRender at the top of render(), before any program exists,
  // which also makes this the safe place to force the bake.
  Lighting.prototype._hookScenes = function (ctx) {
    if (this._svHooked || !ctx || !ctx.scene) return;
    this._svHooked = true;
    var self = this;
    function chain(scene, gate) {
      if (!scene || !scene.isScene) return;
      var prev = scene.onBeforeRender;
      scene.onBeforeRender = function (renderer, sc, cam, target) {
        try {
          if (gate) self._buildSkyVisibility(self.ctx);
          if (SV_PARAMS) SV_PARAMS[3] = gate ? self._svGate : 0;
        } catch (e) { /* never take a frame down for this */ }
        if (typeof prev === 'function') prev.call(this, renderer, sc, cam, target);
      };
    }
    chain(ctx.scene, true);
    chain(ctx.viewScene, false);
  };

  // --------------------------------------------------------------------------
  // Per-frame
  // --------------------------------------------------------------------------
  Lighting.prototype.update = function (dt, ctx) {
    ctx = ctx || this.ctx;
    if (!this.enabled) return;
    this.ctx = ctx;
    dt = (isFinite(dt) && dt > 0) ? Math.min(dt, 0.1) : 0;
    this._t += dt;
    this._frame++;

    try {
      this._hookScenes(ctx);
      this._adoptLevelPracticals(ctx);
      this._buildSkyVisibility(ctx);
      this._probeSkyVisibility(ctx, dt);
      this._readSky(ctx);
      this._updateFill(ctx);
      this._updatePracticals(ctx);
      this._updateLampVisuals(ctx);
      this._updateShafts(ctx);
      this._fitCascades(ctx);
      this._scheduleShadowUpdates(ctx);
      this._updateViewRig(ctx);
      this._adoptEnvironment(ctx);
    } catch (e) {
      GAME.logError('lighting.update', e);
      // A broken frame must not take the whole render down; disable the parts
      // that can keep failing rather than throwing every single frame.
      if (++this._errors > 12) this.enabled = false;
    }
  };
  Lighting.prototype._errors = 0;

  // The viewmodel renders in camera space, so it cannot sample the world-space
  // volume. Probe it once per frame at the eye instead and use that to dim the
  // gun: this is what stops the weapon and the world from diverging when the
  // player steps into the shop, and it is smoothed so it never pops.
  Lighting.prototype._probeSkyVisibility = function (ctx, dt) {
    if (!this.skyVisReady) { this.playerSkyVis = 1; return; }
    var p = (ctx.player && ctx.player.position) || null;
    if (!p && ctx.camera) {
      ctx.camera.updateMatrixWorld();
      var e = ctx.camera.matrixWorld.elements;
      p = _v1.set(e[12], e[13], e[14]);
    }
    if (!p) return;
    var v = this.skyVisibilityAt(p);
    // ~0.35 s time constant: walking through a doorway should feel like the
    // light changing, not like a switch being thrown.
    var a = dt > 0 ? (1 - Math.exp(-dt / 0.35)) : 1;
    this.playerSkyVis = M.lerp(this.playerSkyVis, v, M.clamp(a, 0, 1));
  };

  // Everything about the key light is derived from ctx.sky every frame, never
  // cached, so setTimeOfDay() on the sky drives the whole rig for free.
  Lighting.prototype._readSky = function (ctx) {
    var sky = ctx.sky;
    var d = _v1;        // KEY vector as sky publishes it (sun by day, moon after dark)
    var sunW = _v2;     // TRUE solar vector - the only valid day/night clock

    if (sky && sky.sunDirection && isFinite(sky.sunDirection.x) &&
        sky.sunDirection.lengthSq() > 1e-8) {
      d.copy(sky.sunDirection).normalize();
    } else {
      d.copy(FALLBACK_SUN);
    }
    // sky.js OVERWRITES sunDirection with the moon vector once the sun is down
    // (Sky._computeLightingTerms). At the night preset the moon sits 42 deg ABOVE
    // the horizon, so deriving dayFactor from it computed midnight as full noon.
    // sunWorldDirection is always the real sun; that is what drives the clock.
    if (sky && sky.sunWorldDirection && isFinite(sky.sunWorldDirection.x) &&
        sky.sunWorldDirection.lengthSq() > 1e-8) {
      sunW.copy(sky.sunWorldDirection).normalize();
    } else {
      sunW.copy(d);
    }
    this.sunDirection.copy(d);          // documented API: the KEY direction
    this.solarDirection.copy(sunW);     // the real sun, for anything time-of-day

    // 0 = deep night, 1 = full day. Everything else keys off this.
    this.dayFactor = M.smoothstep(-0.05, 0.16, sunW.y);
    // Sun within a few degrees of the horizon -> the dusk/dawn look. Peaks
    // through civil twilight (0 .. -8 deg), which is where the dusk preset sits.
    this.duskFactor = M.smoothstep(0.16, 0.01, sunW.y) *
                      M.smoothstep(-0.30, -0.04, sunW.y);
    // Sun genuinely below the horizon.
    var below = M.smoothstep(0.02, -0.12, sunW.y);
    this.nightFactor = below;

    // How much of the key the MOON owns. sky.js has already substituted the
    // moon into sunDirection/sunColor/sunIntensity and tells us via keyIsMoon,
    // so we must not re-derive it (doing it twice re-rotated the key). We only
    // decide how far to trust it: at civil twilight the afterglow still rakes
    // the street from the sun's side and reading it as "moonlight from the
    // east" would throw every shadow the wrong way.
    var keyIsMoon = !!(sky && sky.keyIsMoon);
    this.keyIsMoon = keyIsMoon;
    var moonMix = keyIsMoon ? M.smoothstep(-0.035, -0.16, sunW.y) : 0;

    var key = this._keyDir;
    key.copy(sunW);
    if (moonMix > 0.001) {
      // d IS the moon vector here (sky swapped it), so no re-derivation.
      key.lerp(d, moonMix);
      if (key.lengthSq() < 1e-8) key.copy(d);
      key.normalize();
    } else if (!keyIsMoon && key.y < 0.02 && d.y > key.y) {
      // Defensive: a sky that never publishes keyIsMoon but does raise a key
      // above the horizon. Follow it rather than shadowing from underground.
      key.copy(d);
    }
    // ---- twilight key elevation --------------------------------------------
    // sky.js lifts its published key to 0.17 * glow, which is about 5 degrees.
    // A 5-degree ray needs 160 m of clear run to clear a 14 m facade row, so at
    // the dusk preset the key - all 3.76 units of it - lit precisely nothing the
    // camera could see, and the frame measured wallL 0.193 / wallR 0.183 /
    // roadMid 0.164 / sky 0.184: the whole picture inside a third of a stop.
    // The afterglow is a BAND many degrees tall, not a disc on the horizon, so
    // raising the key to DUSK_KEY_ELEV is the physical reading as well as the
    // one that gives the upper storeys a lit side. Azimuth is untouched, so the
    // shadows still agree with the sky dome.
    var duskLift = M.smoothstep(0.30, 0.80, this.duskFactor);
    if (duskLift > 0.001 && !keyIsMoon) {
      var wantY = Math.sin(DUSK_KEY_ELEV * M.DEG);
      if (key.y < wantY) {
        var khl = Math.sqrt(key.x * key.x + key.z * key.z);
        var ky2 = M.lerp(key.y, wantY, duskLift);
        var kscale = Math.sqrt(Math.max(1e-6, 1 - ky2 * ky2)) / Math.max(khl, 1e-6);
        key.set(key.x * kscale, ky2, key.z * kscale);
      }
    }
    // Never let the key sink under the ground plane - shadows would invert.
    if (key.y < 0.035) {
      key.y = 0.035;
      key.normalize();
    }

    // Colour + intensity.
    var sunI = (sky && isFinite(sky.sunIntensity)) ? sky.sunIntensity : 5.0;
    sunI = M.clamp(sunI, 0, 40);
    if (keyIsMoon) {
      // sky.sunColor has already been swapped to the moon, so the warm side of
      // the key has to come from the twilight band instead.
      if (sky && sky.horizonColor && sky.horizonColor.isColor) {
        this._sunColor.copy(sky.horizonColor);
      } else {
        GAME.Color.kelvin(2050, this._sunColor);
      }
      // Both of these are heavily saturated as published (a twilight band and a
      // cinematic blue moon). As a KEY they have to be pulled back toward
      // neutral or the whole night frame reads as a two-colour poster.
      this._sunColor.lerp(_WHITE, 0.24);
      // Re-seed from the base every frame: _moonColor is a persistent member and
      // lerping it in place without a fresh source would walk it to white.
      if (sky && sky.moonColor && sky.moonColor.isColor) this._moonColor.copy(sky.moonColor);
      else this._moonColor.copy(MOON_BASE);
      // Only lightly pulled toward neutral. Now that the moon is carrying a real
      // key (it used to be 0.78 against a 1:1 fill, i.e. nothing), desaturating
      // it to 0.26 made the whole night frame print as an overcast afternoon:
      // a near-neutral key at that level simply reads as daylight. The cool cast
      // IS the day-for-night convention, and it is also what leaves the warm
      // sodium practicals sole owners of the highlights so the grade can split.
      this._moonColor.lerp(_WHITE, 0.13);
    } else if (sky && sky.sunColor && sky.sunColor.isColor) {
      this._sunColor.copy(sky.sunColor);
    } else {
      GAME.Color.kelvin(M.lerp(2400, 4600, M.saturate(sunW.y * 4.0)), this._sunColor);
    }

    // Three additive key terms, each gated so the handover is continuous as the
    // sun sets: direct sun -> twilight afterglow -> moon.
    var solarI = keyIsMoon ? 0 : sunI * M.smoothstep(-0.03, 0.10, sunW.y);
    // The afterglow is gated on duskFactor alone plus a soft handover as the
    // sun crosses the horizon. The old hard gate at y = 0.02..-0.03 meant the
    // twilight key only existed inside a 3-degree band, so the dusk preset -
    // which sits at -4 degrees - was running on the tail of it.
    var twilightI = TWILIGHT_KEY * this.duskFactor * M.smoothstep(0.06, -0.02, sunW.y);
    // ---- the night key, budgeted against the TOTAL, not against itself -----
    // The old cap was on the key alone, which is why the night rig ended up at a
    // 1:1 key:fill ratio: the guarantee was satisfied by starving the only term
    // that can put direction in a frame, while the omnidirectional fill it was
    // competing with was left completely untouched. The ordering the guarantee
    // is really about is total illuminance, so that is what is capped now, and
    // the key is handed whatever the fill has not already spent. NIGHT_KEY_MAX
    // survives as a second, looser guard on the key on its own.
    var moonI = 0;
    if (keyIsMoon) {
      var fillSpend = this._skyFill(ctx) * ((isFinite(this.skyComp) && this.skyComp > 0) ? this.skyComp : 1) +
        M.lerp(0.55, 0.20, this.dayFactor) * M.lerp(1.0, 0.78, this.nightFactor);
      var headroom = Math.max(0.25, NIGHT_TOTAL_CAP - fillSpend);
      moonI = Math.min(sunI * MOON_KEY_GAIN, headroom, TWILIGHT_KEY * NIGHT_KEY_MAX);
    }
    this.keyIntensity = M.clamp(solarI + twilightI * (1 - moonMix) + moonI * moonMix,
      0, 40);
    this.keyColor.copy(this._sunColor).lerp(this._moonColor, moonMix);

    var sunLight = this.cascades.length ? this.cascades[0].light : null;
    if (sunLight) {
      sunLight.color.copy(this.keyColor);
      sunLight.intensity = this.keyIntensity;
      // Very low sun = long thin shadows over huge distances; a slightly
      // reduced shadow intensity keeps them from reading as black holes.
      sunLight.shadow.intensity = M.lerp(1.0, 0.94,
        M.saturate(this.duskFactor + below * 0.5));
    }

    // A meaningful sun move invalidates the texel snap basis.
    if (this._prevKey.dot(this._keyDir) < 0.99999) {
      this._prevKey.copy(this._keyDir);
      this._sunMoved = true;
    } else {
      this._sunMoved = false;
    }
  };

  // The NOMINAL hemisphere magnitude (before the sky-visibility compensation),
  // pulled out of _updateFill so _readSky can budget the night key against it.
  // Civil twilight is ~100x a moonlit night, and the integrated sky radiance
  // alone under-reads both because the afterglow lives in one narrow band and a
  // city night is never lit by the moon alone - so both get a skyglow term.
  //
  // The two terms used to STACK (at the dusk preset duskFactor is 0.963 while
  // nightFactor is simultaneously 0.708), which is how dusk ended up with a
  // sky fill of 0.863 against noon's 0.727: more fill AND a weaker key, i.e. a
  // key that sculpts nothing. The night term is now gated by (1 - dusk), and
  // the after-dark total is ceilinged well under the daylight value.
  Lighting.prototype._skyFill = function (ctx) {
    var sky = ctx && ctx.sky;
    var day = this.dayFactor, night = this.nightFactor, dusk = this.duskFactor;
    var ambI = (sky && isFinite(sky.ambientIntensity)) ? sky.ambientIntensity : null;
    if (ambI === null) ambI = M.lerp(0.035, 0.46, day);
    var envScale = (ctx && ctx.scene && ctx.scene.environment) ? 1.35 : 1.70;
    var v = ambI * envScale +
      DUSK_SKY_FILL * dusk +
      NIGHT_SKY_FILL * night * (1 - dusk);
    var afterDark = M.saturate(Math.max(dusk, night));
    return M.clamp(v, 0.02, M.lerp(0.80, NIGHT_FILL_CEIL, afterDark));
  };

  Lighting.prototype._updateFill = function (ctx) {
    var day = this.dayFactor, night = this.nightFactor, dusk = this.duskFactor;
    var sky = ctx.sky;
    // Every indirect term below is multiplied per-fragment by the sky-visibility
    // volume, so it has to be scaled back up by 1/f(SV_REF) or the whole game
    // simply gets darker instead of the light being REDISTRIBUTED. comp is 1.0
    // until the bake lands, so a failed bake degrades to the previous look
    // exactly. All the nominal values below therefore read as the EFFECTIVE
    // value out in the open roadway, which is where ART_DIRECTION's 0.35-0.8
    // hemisphere band is defined.
    var comp = (isFinite(this.skyComp) && this.skyComp > 0) ? this.skyComp : 1;
    // The bounce directionals only take a FRACTION of the gate (SV_DIR_GATE), so
    // they must take the matching, much smaller, compensation. Handing them the
    // skylight compensation over-drove them by 1.5x, which is what turned the
    // alley from a shadowed slot into a warm-lit corridor in one step.
    var compD = (isFinite(this.skyCompDir) && this.skyCompDir > 0) ? this.skyCompDir : 1;

    // sky.js publishes the atmosphere's own hemisphere terms (ARCHITECTURE
    // section 5 + Sky._integrateAmbient): skyColor / groundColor are hue
    // normalised and ambientIntensity carries the magnitude. Use them - the old
    // code read `sky.zenithColor`, which does not exist, so the hemisphere was
    // permanently a hard-coded day/night lerp and the whole expensive
    // atmosphere model never reached the lighting rig at all.
    var skyCol = _c1, gndCol = _c2;
    if (sky && sky.skyColor && sky.skyColor.isColor) {
      skyCol.copy(sky.skyColor);
    } else {
      skyCol.copy(PAL.skyNight).lerp(PAL.skyDay, day);
    }
    if (sky && sky.groundColor && sky.groundColor.isColor) {
      gndCol.copy(sky.groundColor);
    } else {
      gndCol.copy(PAL.gndNight).lerp(PAL.gndDay, day);
    }
    // Dusk pushes the sky fill violet and the bounce ember-warm.
    if (dusk > 0.001) {
      skyCol.lerp(PAL.skyDusk, dusk * 0.40);
      gndCol.lerp(PAL.gndDusk, dusk * 0.40);
    }
    // Skylight is the ONLY cool term in the rig, and it has to win: the grade's
    // teal shadows are a lighting result, not a post effect. Push the sky half
    // toward the art-directed zenith blue and mix some of it back into the
    // ground half, because the warm sand bounce is already carried by
    // `this.bounce` and counting it twice is what turned every shadow brown.
    if (day > 0.001) {
      skyCol.lerp(PAL.zenith, SKY_COOL_PUSH * day);
      gndCol.lerp(skyCol, GND_COOL_MIX * day);
    }
    // sky.js hue-normalises these (max channel forced to 1), which makes a deep
    // night sky read as an almost fully saturated blue. That is right for the
    // sky DOME but wrong for the light it casts, and with eight amber sodium
    // heads lit it tips the whole frame into a two-colour poster.
    var desat = 0.13 * night + 0.14 * dusk;
    if (desat > 0.001) {
      skyCol.lerp(_WHITE, desat);
      gndCol.lerp(_WHITE, desat * 0.7);
    }

    if (this.hemi) {
      this.hemi.color.copy(skyCol);
      this.hemi.groundColor.copy(gndCol);
      // Magnitude comes from the atmosphere too. sky.js deliberately publishes
      // a value BELOW the true hemispherical irradiance because scene.environment
      // carries the rest, so a mild scale up is correct; the clamp keeps it in
      // ART_DIRECTION's 0.35-0.8 band by day and lets it collapse at night.
      this.hemi.intensity = this._skyFill(ctx) * comp;
    }

    // The PMREM environment is the last unshadowed infinite term in the build.
    // It is gated per fragment by the volume like everything else, so it takes
    // the same compensation; the night scale is what stops sky.js's bright
    // after-dark dome from lighting the street like an overcast afternoon.
    if (ctx.scene && ctx.scene.isScene) {
      ctx.scene.environmentIntensity = comp * M.lerp(1.0, NIGHT_ENV_SCALE, night);
    }

    if (this.bounce) {
      // Rays travel up off the sunlit ground, tilted away from the sun azimuth
      // so surfaces turned away from the key still catch some fill.
      var h = _v3.set(this._keyDir.x, 0, this._keyDir.z);
      if (h.lengthSq() < 1e-8) h.set(0, 0, 1);
      h.normalize();
      _v4.set(0, -1, 0).addScaledVector(h, -0.55).normalize();
      this.bounce.position.copy(_v4).multiplyScalar(40);
      this.bounce.target.position.set(0, 0, 0);
      // Sand + plaster albedo is high, so the bounce is a real fraction of the
      // key. Scaling it off keyIntensity keeps dusk/night automatically right.
      // Roughly half what it was: these unshadowed warm directionals reach the
      // shade as well as the sun side, so they were quietly cancelling the
      // skylight and pushing shadowed plaster warm.
      this.bounce.intensity = (M.clamp(this.keyIntensity * 0.048, 0.015, 0.34) +
        0.02 * (1 - day)) * compD;
      // Bounce colour = key colour filtered through sand albedo, so a red dusk
      // sun automatically produces a red bounce without any extra bookkeeping.
      // The warm filtering itself fades out at night - moonlight off sand is
      // not amber, and leaving it warm re-warmed every night shadow.
      _c3.copy(this.keyColor).lerp(PAL.bounce, 0.25 + 0.30 * day);
      this.bounce.color.copy(_c3);
    }

    // ---- facade bounce pair -------------------------------------------------
    // The street's long axis is -Z, so the cross-canyon axis is world X and the
    // two walls throw at each other along it. Both arrive ~22 degrees above the
    // horizontal: shallow enough to reach the far kerb, steep enough that the
    // road gets a real cos term instead of a grazing nothing.
    //
    // The split between them is not decorative. Whichever facade the key is ON
    // is the one radiating, so its side is weighted up and the shaded side keeps
    // only a base term (a shaded wall still bounces skylight). That asymmetry
    // IS the warm-to-cool gradient across the roadway.
    if (this.fillA && this.fillB) {
      var kx = this._keyDir.x;
      // dot( inward normal of the +X wall = (-1,0,0), keyDir ) and its mirror.
      var wA = 0.34 + 0.66 * M.saturate(-kx);   // radiated by the +X facade
      var wB = 0.34 + 0.66 * M.saturate(kx);    // radiated by the -X facade
      var fbase = (M.clamp(this.keyIntensity * 0.050, 0.02, 0.32) + 0.012) * compD;
      _c5.copy(this.keyColor).lerp(PAL.bounce, 0.50 + 0.25 * day);
      this.fillA.color.copy(_c5);
      this.fillB.color.copy(_c5);
      // 29 degrees, not the 22 the geometry alone would suggest. The receiver
      // that matters most here is the ROADWAY, and a road only sees a fill
      // through its cosine: at 22 degrees it collects 0.37 of the beam, at 29 it
      // collects 0.49. The facades lose a little of it, which is the correct
      // trade - they already have the key.
      this.fillA.position.set(50, 27.5, 0);
      this.fillA.target.position.set(0, 0, 0);
      this.fillB.position.set(-50, 27.5, 0);
      this.fillB.target.position.set(0, 0, 0);
      this.fillA.intensity = fbase * wA;
      this.fillB.intensity = fbase * wB;
    }

    if (this.ambient) {
      // The absolute shadow floor. Deliberately teal - this is the term that
      // guarantees nothing crushes to pure black, and ART_DIRECTION wants that
      // floor cool (#4a5568), not neutral.
      //
      // It is no longer multiplied by the sky-visibility volume in the shader
      // (see patchShaderChunks), so it also no longer carries the volume's
      // compensation: the nominal number here IS the number every fragment in
      // the build receives, everywhere, which is the only shape a floor can
      // have. The night taper is part of the day > dusk > night ordering - this
      // term was flat 0.55 across BOTH after-dark presets, so it could only ever
      // push them together, and at night it was a third of the total fill.
      // The after-dark taper is deliberately shallow. Cutting this term hard at
      // night looked right on paper - it is fill, and the night rig needed less
      // fill - but it is the ONLY unconditional term in the build, so it is also
      // the only thing standing between the unlit half of a night street and
      // literal zero. At 0.30 the night frame measured 8.8% of its pixels under
      // 2/255, which is the crushed-black instant-fail. The fill that had to go
      // was the hemisphere and the environment (both cut ~4x), not the floor.
      this.ambient.intensity = M.lerp(0.55, 0.20, day) * M.lerp(1.0, 0.78, night);
      _c4.copy(PAL.ambNight).lerp(PAL.ambDay, day);
      this.ambient.color.copy(_c4);
    }
  };

  Lighting.prototype._updatePracticals = function (ctx) {
    var t = this._t;
    // Lamps come on as the sun drops. Interiors keep a base level even at noon
    // because a shop interior is dark relative to a sunlit street.
    // MUST use the true solar vector: this.sunDirection is the KEY, which is
    // the moon after dark, and the moon is HIGH at midnight - reading it here
    // switched every practical in the level OFF for the night capture.
    //
    // The window is deliberately wide and centred BELOW the horizon. The old
    // 0.26 -> 0.02 gate had already saturated to 1.0 by the time the sun set,
    // so the dusk preset (sun at -4 deg) and the night preset (-42 deg) ran
    // every lamp in the level at identical full output and dusk had no headroom
    // left. Ramping across -7 deg means dusk shows lamps just coming on against
    // a still-lit sky, which is the entire point of that hour.
    var lampOn = M.smoothstep(0.12, -0.22, this.solarDirection.y);
    this._lampOn = lampOn;

    for (var i = 0; i < this.practicals.length; i++) {
      var p = this.practicals[i];
      var L = p.light;
      var level = p.dayBase + (1 - p.dayBase) * lampOn;
      var mul = 1;

      if (p.kind === 'fire') {
        // Noise driven, never a sine: fire flicker has to be irregular at two
        // time scales or the eye instantly reads it as an animation curve.
        var fast = this.noise.fbm2(t * 2.9 + p.phase, 3.1, 3, 2, 0.5);
        var slow = this.noise.perlin2(t * 0.85 + p.phase, 17.4);
        var gust = M.smoothstep(0.45, 0.85, this.noise.perlin2(t * 0.37 + p.phase, 51.2));
        mul = 1.0 + fast * 0.36 + slow * 0.18 + gust * 0.22;
        mul = M.clamp(mul, 0.28, 1.9);
        // Hotter when brighter - a real flame's colour tracks its intensity.
        GAME.Color.kelvin(M.lerp(1680, 2350, M.saturate((mul - 0.4) * 0.8)), _c1);
        L.color.copy(_c1);
        // A couple of centimetres of wander sells the moving flame front.
        L.position.set(
          p.base.x + fast * 0.035,
          p.base.y + Math.abs(slow) * 0.05,
          p.base.z + slow * 0.035
        );
      } else if (p.kind === 'sodium') {
        // Old sodium lamps breathe slowly and occasionally stutter.
        var n = this.noise.perlin2(t * 0.31 + p.phase, 91.0);
        var stutter = M.smoothstep(0.62, 0.80, n);
        mul = 1.0 + n * 0.05 - stutter * 0.45;
        L.color.copy(p.baseColor);
      } else if (p.kind === 'fluoro') {
        // Failing tube: mostly steady with a fast, shallow ripple.
        var f1 = this.noise.perlin2(t * 6.3 + p.phase, 7.7);
        var f2 = this.noise.perlin2(t * 0.23 + p.phase, 29.5);
        mul = 1.0 + f1 * 0.055 + f2 * 0.09;
        L.color.copy(p.baseColor);
      } else {
        // Tungsten on a bad generator: a slow, barely-there sag.
        mul = 1.0 + this.noise.perlin2(t * 0.42 + p.phase, 61.0) * 0.06;
        L.color.copy(p.baseColor);
      }

      // p.boost (1 .. ~2.15) is set by the bake from how enclosed the lamp
      // turned out to be. A lamp in a sealed room is that room's key light and
      // has to be able to carry it now that the sky-visibility volume has taken
      // the free ambient floor away from interiors.
      L.intensity = Math.max(0, p.intensity * level * mul * (p.boost || 1));
      L.visible = L.intensity > 0.001;
    }
  };

  // --------------------------------------------------------------------------
  // Cascade fitting
  // --------------------------------------------------------------------------

  // Practical split scheme: a blend of the logarithmic distribution (which is
  // correct for perspective projection) and the uniform one (which stops the
  // near cascades from being uselessly tiny). lambda ~0.6 is the usual sweet
  // spot for a shooter FOV.
  Lighting.prototype._computeSplits = function (cam) {
    var n = this.cascades.length;
    if (!n) return;
    var near = Math.max(cam.near || 0.05, 0.30);
    var far = Math.min(cam.far || 600, this.shadowDistance);
    if (!(far > near)) far = near + 10;
    var ratio = far / near;
    var aspect = (isFinite(cam.aspect) && cam.aspect > 0.01) ? cam.aspect : 1.7778;
    // Fit to the FOV rounded UP to the next 5 degrees. ADS animates the FOV
    // every frame; refitting every frame would change each cascade's radius,
    // which invalidates the texel snap and makes the shadows shimmer for the
    // whole transition. Rounding up is always safe - the cascade then covers
    // slightly more than the real frustum, never less.
    var fitFov = Math.ceil(M.clamp(cam.fov || 75, 10, 130) / 5) * 5;
    var tanH = Math.tan(fitFov * 0.5 * M.DEG);
    // k = |corner offset| / distance along the view axis.
    var k = Math.sqrt(1 + aspect * aspect) * tanH;
    var k2 = k * k;

    // Deriving each near plane from the PREVIOUS cascade's actual far (rather
    // than re-evaluating the split formula) means any clamp below propagates
    // forward and no gap can ever open between two cascades.
    var prevFar = near;
    for (var i = 0; i < n; i++) {
      var c = this.cascades[i];
      var p1 = (i + 1) / n;
      var cn = (i === 0) ? near : prevFar * 0.92;   // slight overlap
      var cf = (i === n - 1) ? far
        : SPLIT_LAMBDA * (near * Math.pow(ratio, p1)) +
          (1 - SPLIT_LAMBDA) * (near + (far - near) * p1);
      // Cascade 0 covers the player's immediate surroundings - the metre or two
      // where contact shadows actually sell the grounding. Cap it explicitly so
      // a low cascade count or a wide FOV cannot stretch it back out. Never on
      // the last cascade: that one has to reach `far` or the range just ends.
      if (i === 0 && n > 1 && cf > NEAR_CASCADE_MAX) cf = NEAR_CASCADE_MAX;
      if (cf <= cn) cf = cn * 1.2 + 0.5;

      // Analytic bounding sphere of the frustum slice. Rotation invariant, so
      // the ortho extents are constant while the player looks around.
      var centerDist, radius;
      if (k2 >= (cf - cn) / (cf + cn)) {
        centerDist = cf;
        radius = cf * k;
      } else {
        centerDist = 0.5 * (cf + cn) * (1 + k2);
        radius = 0.5 * Math.sqrt(
          (cf - cn) * (cf - cn) +
          2 * (cf * cf + cn * cn) * k2 +
          (cf + cn) * (cf + cn) * k2 * k2);
      }
      radius = Math.max(radius, 0.5);

      c.near = cn; c.far = cf;
      c.centerDist = centerDist;
      c.radius = radius;
      c.texel = (2 * radius) / c.res;
      c.dirty = true;
      prevFar = cf;
    }
    this._fov = fitFov;
    this._aspect = cam.aspect;
    this._splitsDirty = false;
  };

  // Bias/penumbra parameters depend only on the cascade's world scale, so they
  // are refreshed alongside the ortho extents rather than every frame.
  Lighting.prototype._applyCascadeShadowParams = function (c) {
    var sh = c.light.shadow;
    var cam = sh.camera;
    cam.left = -c.radius; cam.right = c.radius;
    cam.top = c.radius; cam.bottom = -c.radius;
    cam.near = 0.05;
    // The cascade sphere spans [extrusion, extrusion + 2r] from the light, so
    // a few metres of margin keeps its far tangent off the z == 1 boundary
    // (fragments at exactly 1.0 would be rejected and fall to the next cascade).
    cam.far = 2 * c.radius + this._extrusion + 4;
    cam.updateProjectionMatrix();
    c.depthRange = Math.max(1, cam.far - cam.near);

    // Constant depth bias, expressed in metres along the light axis and then
    // converted into the cascade's normalised depth range. The fragment shader
    // multiplies this by the surface slope.
    var worldBias = c.texel * 0.35 + 0.004;
    sh.bias = -worldBias / c.depthRange;

    // Normal-offset bias, ~1 texel of world size. This is what actually kills
    // acne; it is capped so far cascades do not detach shadows from wall bases.
    sh.normalBias = Math.min(0.10, c.texel * 1.0 + 0.0025);

    // Repurposed as the PCSS penumbra scale: normalised occluder distance ->
    // filter radius in texels. Folding the constants in here is what lets the
    // whole CSM run without introducing a single new uniform.
    sh.radius = M.clamp(
      (c.depthRange * SUN_TAN_ANGLE * SOFTNESS_BOOST) / Math.max(c.texel, 1e-5),
      4, 600);

    c.dirty = false;
  };

  Lighting.prototype._fitCascades = function (ctx) {
    var cam = ctx.camera;
    if (!cam || !cam.isPerspectiveCamera || !this.cascades.length) return;

    // Casters up to `extrusion` metres up-sun of a receiver can still shadow
    // it. With a 14 degree sun and 16m buildings that is ~65m. Quantised so a
    // drifting sun does not re-dirty the projection every frame.
    var wantEx = M.clamp(16 / Math.max(0.12, this._keyDir.y), 24, 70);
    wantEx = Math.round(wantEx / 5) * 5;
    if (wantEx !== this._extrusion) {
      this._extrusion = wantEx;
      for (var d = 0; d < this.cascades.length; d++) this.cascades[d].dirty = true;
    }

    var fitFov = Math.ceil(M.clamp(cam.fov || 75, 10, 130) / 5) * 5;
    if (this._splitsDirty || fitFov !== this._fov || cam.aspect !== this._aspect) {
      this._computeSplits(cam);
    }

    cam.updateMatrixWorld();
    var e = cam.matrixWorld.elements;
    var camPos = _v1.set(e[12], e[13], e[14]);
    var fwd = _v2.set(-e[8], -e[9], -e[10]);
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();

    var L = this._keyDir;
    // Rebuild exactly the basis Object3D.lookAt() will build, otherwise the
    // texel snap is computed in the wrong space and does nothing.
    var up = Math.abs(L.y) > 0.995 ? _upZ : _upY;
    var ax = _v3.crossVectors(up, L);
    if (ax.lengthSq() < 1e-10) ax.crossVectors(_upZ, L);
    if (ax.lengthSq() < 1e-10) ax.set(1, 0, 0);
    ax.normalize();
    var ay = _v4.crossVectors(L, ax).normalize();

    for (var i = 0; i < this.cascades.length; i++) {
      var c = this.cascades[i];
      if (c.dirty) this._applyCascadeShadowParams(c);
      c.light.shadow.camera.up.copy(up);

      var center = _v5.copy(fwd).multiplyScalar(c.centerDist).add(camPos);

      // ---- TEXEL SNAP ----------------------------------------------------
      // Without this the shadow map's texel grid slides continuously under the
      // world and every shadow edge crawls/shimmers as the player moves. We
      // quantise the cascade centre to whole texels of the light-space grid.
      var texel = c.texel;
      if (texel > 1e-6) {
        var cx = center.dot(ax), cy = center.dot(ay);
        var dx = Math.floor(cx / texel) * texel - cx;
        var dy = Math.floor(cy / texel) * texel - cy;
        center.addScaledVector(ax, dx).addScaledVector(ay, dy);
      }

      c.light.position.copy(center).addScaledVector(L, c.radius + this._extrusion);
      c.target.position.copy(center);
      c.light.updateMatrixWorld(true);
      c.target.updateMatrixWorld(true);
    }
  };

  // Near cascades change every frame; far cascades barely change at all, so
  // re-rendering them every frame is pure waste. Captures always refresh
  // everything so a screenshot can never contain a stale map.
  Lighting.prototype._scheduleShadowUpdates = function (ctx) {
    var force = !!ctx.capture || this._frame < 8 || this._sunMoved;
    for (var i = 0; i < this.cascades.length; i++) {
      var period = i <= 1 ? 1 : (i === 2 ? 2 : 3);
      if (force || (this._frame % period) === (i % period)) {
        this.cascades[i].light.shadow.needsUpdate = true;
      }
    }
    // The shaft spot is static geometry lit by a static beam, so its map only
    // has to be re-rendered when something about the rig actually changed.
    if (this._shafts) {
      for (var s = 0; s < this._shafts.length; s++) {
        var sl = this._shafts[s].light;
        if (sl.castShadow && (force || this._frame < 8)) sl.shadow.needsUpdate = true;
      }
    }
  };

  // --------------------------------------------------------------------------
  // Viewmodel rig
  //
  // The weapon renders in its own scene with its own camera, so none of the
  // world lights reach it. If weapons.js supplied lights we leave it alone;
  // otherwise we mirror the world key into view space so the gun catches the
  // sun from the correct side as the player turns. A gun lit from a fixed
  // angle while the world rotates around it is an instant "this is a demo" tell.
  // --------------------------------------------------------------------------
  Lighting.prototype._updateViewRig = function (ctx) {
    var vs = ctx.viewScene;
    if (!vs) return;

    if (!this._viewRigChecked) {
      this._viewRigChecked = true;
      var has = false;
      for (var i = 0; i < vs.children.length; i++) {
        if (vs.children[i].isLight) { has = true; break; }
      }
      if (!has) {
        var g = new THREE.Group();
        g.name = 'viewmodelRig';
        var key = new THREE.DirectionalLight(0xffffff, 2.6);
        var fill = new THREE.DirectionalLight(0x7ea3d8, 0.22);
        var hemi = new THREE.HemisphereLight(0x8fb4e8, 0xa88a5e, 0.4);
        hemi.position.set(0, 1, 0);
        key.castShadow = false; fill.castShadow = false;
        g.add(key, key.target, fill, fill.target, hemi);
        vs.add(g);
        this._viewRig = { group: g, key: key, fill: fill, hemi: hemi };
      }
      if (ctx.sky && ctx.sky.envMap && !vs.environment) vs.environment = ctx.sky.envMap;
    }

    var rig = this._viewRig;
    if (!rig || !ctx.camera) return;

    // The viewmodel scene is authored in CAMERA space, so its fragments resolve
    // to world positions near the origin and it cannot sample the world-space
    // visibility volume (that is why the shader gate is switched off for the
    // viewmodel pass). Probe the volume once at the eye instead: this is what
    // keeps the gun and the world from diverging when the player steps into the
    // shop - the one thing a viewmodel must never do. Floored well above zero,
    // because a silhouetted weapon is a worse defect than a slightly over-lit
    // one, and smoothed upstream so it can never pop in a doorway.
    var vmSky = M.lerp(0.55, 1.0, M.smoothstep(0.02, 0.38, this.playerSkyVis));

    // World key direction -> player camera space (the viewmodel scene's frame).
    _q1.copy(ctx.camera.quaternion).invert();
    _v6.copy(this._keyDir).applyQuaternion(_q1);
    rig.key.position.copy(_v6).multiplyScalar(6);
    rig.key.target.position.set(0, 0, 0);
    rig.key.color.copy(this.keyColor);
    // The gun is close to the eye and in the player's own shade a lot of the
    // time - a slightly reduced key keeps it from blowing out against the street.
    // The night key is a day-for-night AMPLIFICATION - it exists so a 70 m
    // street reads at all, not because there are really 2 units of moonlight
    // falling on anything. A weapon 40 cm from the lens has no such excuse, and
    // handing it the full amplified key blew the top of the receiver to white in
    // the night frame. It keeps a little more than half of it, which is enough
    // to stay attached to the world without becoming the brightest thing in it.
    rig.key.intensity = M.clamp(
      this.keyIntensity * 0.62 * vmSky * M.lerp(1.0, 0.52, this.nightFactor),
      0.10, 4.5);

    // Fill from behind/above the eye, so the shadow side of a backlit weapon
    // still reads instead of collapsing to a silhouette. It is deliberately
    // HALF what it used to be and it now takes the sky's real colour instead of
    // a hard-coded 0x9dc0ff: a fixed near-white blue at 0.95 was what turned
    // worn matte black anodising into light grey plastic and dark tactical
    // gloves into pale blue-white.
    rig.fill.position.copy(_v6).multiplyScalar(-4).add(_v1.set(0, 3, 1.5));
    rig.fill.target.position.set(0, 0, 0);
    rig.fill.intensity = M.lerp(0.12, 0.50, this.dayFactor) * vmSky;
    if (this.hemi) {
      rig.hemi.color.copy(this.hemi.color);
      rig.hemi.groundColor.copy(this.hemi.groundColor);
      // Sky-coloured, but pulled back toward neutral so it tints the metal
      // rather than dyeing it.
      rig.fill.color.copy(_c5.copy(this.hemi.color).lerp(_WHITE, 0.35));
      // this.hemi.intensity now carries the volume's compensation factor, which
      // the viewmodel does not sample - so take a fraction of it and cap it.
      // The cap is the guard against the gun turning into pale grey plastic,
      // the +0.05 is the guard against it turning into a silhouette.
      rig.hemi.intensity = M.clamp(this.hemi.intensity * 0.72 * vmSky + 0.05, 0.05, 0.80);
    }
    rig.group.updateMatrixWorld(true);
  };

  // --------------------------------------------------------------------------
  // Public helpers
  // --------------------------------------------------------------------------
  Lighting.prototype.resize = function (w, h, ctx) {
    // Cascade radii depend on the camera aspect - force a refit.
    this._splitsDirty = true;
  };

  Lighting.prototype.setShadowDistance = function (metres) {
    this.shadowDistance = M.clamp(metres || 82, 12, 400);
    this._splitsDirty = true;
  };

  Lighting.prototype.setShadowsEnabled = function (on) {
    for (var i = 0; i < this.cascades.length; i++) {
      this.cascades[i].light.castShadow = !!on;
    }
  };

  // Lets another system (e.g. props.js placing a lamp mesh) attach a practical
  // to the rig without owning a light of its own.
  Lighting.prototype.addPractical = function (opts) {
    opts = opts || {};
    if (this.practicals.length >= MAX_PRACTICALS) return null;
    var col = GAME.Color.kelvin(opts.kelvin || 2800, new THREE.Color());
    var light = new THREE.PointLight(0xffffff, 0, opts.distance || 10, 2);
    light.color.copy(col);
    light.castShadow = false;
    var p = opts.pos || [0, 2, 0];
    light.position.set(p[0], p[1], p[2]);
    this.root.add(light);
    var rec = {
      light: light,
      kind: opts.kind || 'tungsten',
      base: new THREE.Vector3(p[0], p[1], p[2]),
      kelvin: opts.kelvin || 2800,
      intensity: opts.intensity || 8,
      dayBase: opts.dayBase != null ? opts.dayBase : 0.4,
      baseColor: col.clone(),
      distance: opts.distance || 10,
      haloScale: opts.haloScale != null ? opts.haloScale : HALO_SCALE,
      boost: 1,
      enclosure: 0,
      phase: this.rng.range(0, 100)
    };
    this.practicals.push(rec);
    return rec;
  };

  Lighting.prototype.dispose = function () {
    var i;
    for (i = 0; i < this.cascades.length; i++) {
      var sh = this.cascades[i].light.shadow;
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    if (this._shafts) {
      for (i = 0; i < this._shafts.length; i++) {
        var s = this._shafts[i];
        if (s.light.shadow && s.light.shadow.map) {
          s.light.shadow.map.dispose(); s.light.shadow.map = null;
        }
        if (s.haze) { s.haze.geometry.dispose(); s.haze.material.dispose(); }
      }
      this._shafts = null;
    }
    var lv = this._lampVisuals;
    if (lv) {
      var parts = [lv.bulbs, lv.halos, lv.windows];
      for (i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        parts[i].dispose();
        if (parts[i].material) parts[i].material.dispose();
      }
      this._lampVisuals = null;
    }
    if (this.root.parent) this.root.parent.remove(this.root);
    if (this._viewRig && this._viewRig.group.parent) {
      this._viewRig.group.parent.remove(this._viewRig.group);
    }
    this.cascades.length = 0;
    this.practicals.length = 0;
    this.enabled = false;
  };

  GAME.Lighting = Lighting;

})(window.GAME, window.THREE);
