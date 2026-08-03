// ============================================================================
// OPERATION BLACKOUT - lighting rig + cascaded shadow maps
// Owner: src/render/lighting.js  ->  GAME.Lighting
//
// PUBLIC API
//   lighting.sun                THREE.DirectionalLight (the CSM caster)
//   lighting.update(dt, ctx)
//   lighting.resize(w, h, ctx)
//   lighting.setShadowDistance(m) / setShadowsEnabled(on)
//   lighting.addPractical(opts)
//   lighting.setRig(name)       'sun' | 'practicals' | 'mixed' | 'mixedsun'
//                               ALSO accepts an object - see RIG OVERRIDES below
//   lighting.setInterior(flag)  the level is fully enclosed
//   lighting.dispose()
//
// WHAT A LEVEL PUBLISHES AND THIS MODULE CONSUMES, GENERICALLY
//   level.practicalLights  [ {name, kind, pos:[x,y,z], kelvin|color, intensity,
//                             distance, dayBase, cone, penumbra, aimPos,
//                             anchor, spread, haloScale, haloMax, haloGain,
//                             bulbR, bulbFlat, bulbAxis, bulbGain, fixed,
//                             beam} ]
//                          Full override of the built-in lamp table. Every
//                          entry gets an emissive bulb and an additive halo for
//                          free (_buildLampVisuals) - a light with no visible
//                          source is not a light. `beam` (0..1.4) additionally
//                          asks for a VOLUMETRIC CONE along the lamp's own aim
//                          axis - see THE PRACTICAL BEAM CONE below.
//   level.lightShafts      [ {origin, dir, width, length, strength, kind} ]
//                          plus, for a shaft that is a FIXTURE rather than a
//                          hole in a roof: {always, color|kelvin, lux}.
//   level.lightRig         OPTIONAL {preset, key, sky, amb, env, bnc, cfill,
//                             fills, sun, lampFloor, cookie:{...}} - scalars
//                          merged OVER the named preset, so a level can lift
//                          its own anti-crush floor, restore the bounce
//                          directionals, or switch the canopy cookie on without
//                          this file being edited for it. Ignored on market and
//                          harbor (both are non-declarative).
//   level.litWindows       [ {x,y,z,w,h,kelvin,gain, yaw, scale, tint, ...} ]
//                          Additive glow cards on apertures the level knows
//                          about (the market finds its own; nobody else can).
//   level.cameraPoses      used to anchor `anchor`-tagged practicals and to
//                          probe the sky-visibility reference.
//   level.spawnPoints      same.
// Adding a level should require ZERO edits to this file.
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
//      Crucially the cascade selector introduces NO new SAMPLERS and no
//      per-light uniforms. Everything it needs (shadow map, matrix, bias,
//      radius, map size, intensity) already exists per-light in three's own
//      uniform blocks. That is what makes it safe: any other agent's
//      ShaderMaterial that includes these chunks still compiles, and a scene
//      with a single directional shadow just degrades to one very well
//      filtered cascade.
//      The only additions are the two plain vec4s the canopy cookie needs
//      (boCookieParams / boCookieParams2). A vec4 is free where a sampler is
//      not - see THE CANOPY COOKIE below for why that distinction decided the
//      whole implementation - and both default to 0, which is the identity
//      path, so a ShaderMaterial that never supplies them is unaffected.
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
// THE CANOPY COOKIE (opt-in, off everywhere by default)
// ---------------------------------------------------------------------------
// Dappled shadow from a broken occluder is the standard answer to "light
// arrives filtered through a canopy", and it is the one thing the CSM cannot
// give the jungle or the ruins: the cascades shadow-map what the level BUILDS,
// and a canopy at 20 m is thousands of alpha-tested billboards whose shadow
// would be sampling noise rather than dapple.
//
// So `getCSMShadow` multiplies its resolved shadow factor by a procedural
// two-octave value noise on world XZ, scrolled slowly. A level opts in with
//     level.shadowCookie = { amount: 0.55, scale: 7, speed: 0.05, sharp: 0.6 }
// or through the `cookie` field of a rig override; `amount: 0` (the default
// everywhere) takes a uniform branch and costs one comparison.
//
// IT IS NOISE AND NOT A TEXTURE FOR ONE REASON. A cookie texture is the obvious
// implementation and it would add a sampler2D to every lit material in the
// build. This file already documents (see _buildCascades) that Cold Harbor sits
// ON the MAX_TEXTURE_IMAGE_UNITS = 16 cliff, that crossing it makes programs
// fail to validate, and that the failure is SILENT - the draw calls are still
// counted, so the capture report looks healthy while the containers, the crane
// and the warehouse are simply not drawn. A shipped, frozen level is not
// something to spend a texture unit against for a dapple effect on two other
// levels. Two octaves of value noise cost ~40 ALU inside a branch that is not
// taken, and zero texture units.
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

  // --------------------------------------------------------------------------
  // SHADOW COOKIE (canopy / gobo break-up on the CSM term)
  //
  // Dappled shadow from a broken occluder is the standard answer to "light
  // arrives filtered through a canopy", and neither the jungle nor the ruins can
  // express it: the CSM shadow-maps what the level actually builds, and 2,600
  // leaf cards at 20 m are not shadow-mapped geometry, they are alpha-tested
  // billboards whose shadow would be sampling noise.
  //
  // IT IS PROCEDURAL AND NOT A TEXTURE, AND THAT IS THE WHOLE POINT. A cookie
  // texture would add a sampler2D to every lit material in the build, and this
  // file already documents (see the cascade cap in _buildCascades) that Cold
  // Harbor sits ON the MAX_TEXTURE_IMAGE_UNITS = 16 cliff - crossing it makes
  // programs fail to validate and whole objects silently stop drawing while the
  // capture report still looks healthy. Two octaves of value noise cost ~40 ALU
  // inside a branch on a uniform, add ZERO texture units, and are skipped
  // entirely when the amount is 0 - which is what market, harbor and every
  // level that does not opt in run.
  //
  // x = 1/world scale, y = scroll u, z = scroll v, w = amount (0 = identity).
  var CK_PARAMS = new Float32Array([1 / 6, 0, 0, 0]);
  // x = contrast/sharpness of the dapple, y/z/w reserved.
  var CK_PARAMS2 = new Float32Array([0.5, 0, 0, 0]);

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

  // Rough irradiance magnitude of a light's colour. three multiplies colour by
  // intensity, so `intensity` on its own says nothing about how much light a
  // source delivers: this rig's ambient floor is a dark teal whose largest
  // linear channel is 0.115 and its practicals are near-white. Anything that
  // compares or substitutes one term for another has to go through this.
  function colMag(c) {
    if (!c) return 1;
    return Math.max(c.r, Math.max(c.g, c.b));
  }

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

    // ---- canopy cookie -----------------------------------------------------
    // Two octaves of value noise on world XZ, multiplied into the shadow term.
    // Declared unconditionally but branched on a UNIFORM, so with the amount at
    // 0 (market, harbor, and every level that has not opted in) the driver
    // evaluates one compare and nothing else. No sampler, no texture unit.
    L.push('uniform vec4 boCookieParams;');   // 1/scale, scrollU, scrollV, amount
    L.push('uniform vec4 boCookieParams2;');  // sharpness
    L.push('float boCkHash( vec2 p ) {');
    L.push('\tp = fract( p * vec2( 0.1031, 0.1030 ) );');
    L.push('\tp += dot( p, p.yx + 33.33 );');
    L.push('\treturn fract( ( p.x + p.y ) * p.x );');
    L.push('}');
    L.push('float boCkNoise( vec2 p ) {');
    L.push('\tvec2 i = floor( p );');
    L.push('\tvec2 f = fract( p );');
    L.push('\tf = f * f * ( 3.0 - 2.0 * f );');
    L.push('\tfloat a = boCkHash( i );');
    L.push('\tfloat b = boCkHash( i + vec2( 1.0, 0.0 ) );');
    L.push('\tfloat c = boCkHash( i + vec2( 0.0, 1.0 ) );');
    L.push('\tfloat d = boCkHash( i + vec2( 1.0, 1.0 ) );');
    L.push('\treturn mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );');
    L.push('}');
    L.push('float boShadowCookie( const in vec3 wpos ) {');
    L.push('\tfloat amt = boCookieParams.w;');
    L.push('\tfloat res = 1.0;');
    L.push('\tif ( amt > 0.0 ) {');
    L.push('\t\tvec2 uv = wpos.xz * boCookieParams.x + boCookieParams.yz;');
    L.push('\t\t// Second octave at an irrational ratio and an offset, so the');
    L.push('\t\t// two lattices never line up into a visible grid.');
    L.push('\t\tfloat g = boCkNoise( uv ) * 0.62 +');
    L.push('\t\t          boCkNoise( uv * 2.317 + vec2( 5.31, 1.77 ) ) * 0.38;');
    L.push('\t\t// A canopy is mostly gaps with hard-edged leaf clumps, not a');
    L.push('\t\t// smooth wobble: push the contrast and keep the mean near 1 so');
    L.push('\t\t// the term dapples the key instead of dimming it.');
    L.push('\t\tfloat s = mix( 0.30, 0.05, boCookieParams2.x );');
    L.push('\t\tg = smoothstep( 0.5 - s, 0.5 + s, g );');
    L.push('\t\tres = 1.0 - amt * ( 1.0 - g );');
    L.push('\t}');
    L.push('\treturn res;');
    L.push('}');
    L.push('');

    // ---- cascade selection + cross-fade ------------------------------------
    L.push('float getCSMShadow( vec3 nrm, vec3 lightDir, vec3 wpos ) {');
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

    // The cookie multiplies the RESOLVED shadow factor rather than being folded
    // into any one cascade: it is break-up in the light itself, not extra
    // occlusion in a map, so it has to survive the cascade cross-fade and it
    // has to reach fragments beyond the last cascade too (which is exactly the
    // 20 m canopy case). Fragments already in core shadow stay in core shadow -
    // multiplying 0 by anything is still 0.
    L.push('\tresult *= boShadowCookie( wpos );');
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
      // The world position is reconstructed AT THE CALL SITE rather than read
      // from a hoisted variable: the sky-visibility patch below may bail out
      // (it needs two more anchors to be present), and a CSM call referencing a
      // variable that patch never emitted would fail to compile every material
      // in the build. Self-contained is the only safe shape here.
      lines[hit] =
        '\t\t#if ( UNROLLED_LOOP_INDEX == 0 )\n' +
        '\t\tdirectLight.color *= ( directLight.visible && receiveShadow ) ? ' +
        'getCSMShadow( geometryNormal, directLight.direction, ' +
        'cameraPosition + ( vec4( - vViewPosition, 0.0 ) * viewMatrix ).xyz ) : 1.0;\n' +
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
    if (!CSM_PATCHED) return;
    try {
      var libs = ['physical', 'standard', 'phong', 'lambert', 'toon'];
      var add = {};
      // The cookie travels with the CSM patch (it lives inside getCSMShadow),
      // the volume with the sky-visibility patch. Either can land without the
      // other, so they are registered independently - a uniform that is
      // declared but never supplied reads as 0 in GLSL, which for both payloads
      // is the identity transform, but relying on that where we can simply
      // supply the array is not a trade worth making.
      add.boCookieParams = { value: CK_PARAMS };
      add.boCookieParams2 = { value: CK_PARAMS2 };
      if (SKYVIS_PATCHED && SV_TEX) {
        add.boSkyVisMap = { value: SV_TEX };
        add.boSkyVisOrigin = { value: SV_ORIGIN };
        add.boSkyVisInvSize = { value: SV_INVSIZE };
        add.boSkyVisParams = { value: SV_PARAMS };
        add.boSkyVisParams2 = { value: SV_PARAMS2 };
      }
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
  var _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  var _c1 = new THREE.Color(), _c2 = new THREE.Color();
  var _c3 = new THREE.Color(), _c4 = new THREE.Color();
  var _c5 = new THREE.Color();
  var _c6 = new THREE.Color();   // declarative-rig meter only (see _rigMeter)
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

  // ==========================================================================
  // LEVEL 2 - "COLD HARBOR" : a rig with NO SUN
  // --------------------------------------------------------------------------
  // Everything below this line is gated on ctx.levelId === 'harbor'. Level 1 is
  // finished and must render byte-for-byte as it does today, so not one default
  // path changes: the market never sets levelId 'harbor', never has ctx.weather,
  // and every harbor branch is an `if (this.isHarbor)` around an ADDITION.
  //
  // WHY THE RIG INVERTS. The market is a key-led rig: one directional sun, four
  // cascades wrapped around the player, practicals as accents. The harbor has no
  // sun, no moon and a storm overcast, so there is no key at all for ~97% of the
  // frames. The picture is made entirely of:
  //
  //   - sodium mast lamps, ~2000K, HARD inverse-square falloff, each one a real
  //     fixture with emissive glass, an additive halo AND a volumetric cone. The
  //     round-3 lesson from level 1 - "a light without a visible source is not a
  //     light" - is worth more here than there, because after dark the sources
  //     ARE the composition. A mast lamp with no visible cone in a downpour is
  //     on ART_DIRECTION_HARBOR's instant-fail list.
  //   - mercury/LED floods at ~5600K on the warehouse and the crane. The
  //     2000K-against-5600K split is the single biggest colour idea in the level
  //     and it has to be LIT, not graded: two temperatures of real light with
  //     genuine darkness between their pools.
  //   - lightning, which is a real DirectionalLight (below).
  //
  // SHADOW STRATEGY - the deliberate decision the brief asks for.
  //   CSM is built around a directional light. With no sun there is nothing for
  //   it to fit, so instead of deleting it the whole 4-cascade rig is REPURPOSED
  //   AS THE LIGHTNING CASTER: same cascades, same texel snapping, same PCSS
  //   filter, direction taken from ctx.weather.flashDir. That buys full-terminal
  //   shadows from the flash for zero extra shadow maps, and because the cascade
  //   maps are only re-rendered while a flash is actually on (see
  //   _scheduleShadowUpdates) the shadow budget between strikes is literally
  //   ZERO instead of 4 depth passes a frame.
  //   On top of that exactly TWO of the twelve practicals cast shadows - the two
  //   hero masts that appear in the most framings - at 1024^2, refreshed
  //   round-robin every fourth frame. Everything else is unshadowed. Twelve
  //   shadow-casting lights would be twelve depth passes; two amortised ones is
  //   ~0.5 passes a frame, and the eye cannot tell which lamps in a container
  //   yard are the ones with shadows.
  // ==========================================================================
  var HARBOR_SODIUM_K = 2000;    // deep orange mast lamps
  var HARBOR_MERCURY_K = 5600;   // cold mercury / LED floods
  var HARBOR_FLASH_K = 7000;     // lightning

  // ART_DIRECTION_HARBOR palette, declared as sRGB hex exactly as the document
  // writes it so the numbers here can be diffed against the bible.
  var HPAL = {
    sodium: new THREE.Color(0xff9a3c),
    mercury: new THREE.Color(0xcfe6ff),
    lightning: new THREE.Color(0xdceaff),
    stormSky: new THREE.Color(0x39434d),   // "steam / rain haze"
    wetGround: new THREE.Color(0x0e1418),  // wet concrete, near black
    ambient: new THREE.Color(0x16303a),    // cold cyan-green shadow floor
    coldFill: new THREE.Color(0x3d5a68)
  };

  // Magnitudes. Every one of these is an EFFECTIVE value out on the open apron
  // (the sky-visibility compensation is applied on top, exactly as in level 1).
  //
  // The floor is deliberately non-zero: ART_DIRECTION_HARBOR's instant-fail list
  // forbids "crushed pure-black shadows with no detail whatsoever" in the same
  // breath as it asks for "deep near-blacks". The way to have both is a small
  // COLD unconditional term plus a warm sodium bounce off the wet apron, and a
  // very hard practical falloff on top - contrast from the ratio between the
  // pools and the floor, not from taking the floor to zero.
  // ---- THE DYNAMIC-RANGE BUDGET (measured, and the reason these moved) ------
  // A mast head runs 1420 cd at 12 m, so the apron under it collects ~10 lux.
  // The previous fill put roughly 0.02 lux on a surface no lamp reached. That is
  // a 500:1 scene ratio, and NO tone curve holds 500:1 - the unlit half simply
  // falls off the bottom of the toe. Measured on the shipped frames: every cell
  // of an 8x8 grid that no cone touched printed 0.036-0.041 sRGB, i.e. the
  // postfx black level, EXACTLY the same value whether it contained a container
  // flank, the apron or nothing at all. 45% of the containers frame and 27% of
  // the quay frame were that number. It was never a missing light; it was a
  // missing floor.
  //
  // A photographic night exterior runs 30:1 to 60:1 between its pools and its
  // shadow detail, so the fill is sized to land there: pools stay at ~10 lux and
  // the unlit floor comes up to ~0.20-0.30 lux. That still reads as "pools of
  // light with genuine darkness between them" - the pools are two orders of
  // magnitude up - while a container flank turned away from every lamp keeps its
  // corrugation instead of becoming a silhouette.
  //
  // WHICH TERM DOES WHICH SURFACE (they are not interchangeable):
  //   ambient  - unconditional, omnidirectional. The flattest thing in the rig,
  //              so it moves least. Cold cyan, the art-directed shadow hue.
  //   hemi     - sky above / wet apron below. Up-facing surfaces and, at 50/50,
  //              the vertical ones.
  //   bounce   - travels UP. Underside of a container lip, the crane boom, chins.
  //              Contributes NOTHING to a vertical face (dot(n, up) == 0), which
  //              is why raising it alone never moved the canyon walls.
  //   fillA/B  - the cross-canyon pair, arriving ~16 deg above the horizon. This
  //              is the ONLY term with a real cosine on a container flank
  //              (0.68 against 0.20 on the ground), so it is the term that makes
  //              a canyon read, and it was the one sitting at 0.030.
  //
  // ---- WHY THOSE THREE ARE HEMISPHERES HERE AND DIRECTIONALS IN LEVEL 1 -----
  // All three used to be THREE.DirectionalLights in this level as well, and
  // they were the single worst artefact in the build: every container flank and
  // the whole freighter hull printed a hard vertical barcode with red/green/blue
  // fringing, coherent across entire walls at 20-40 m. Proven by experiment -
  // zeroing exactly those three removed all of it, cost 0.006 mean luma and
  // IMPROVED dynamic range.
  //
  // The cause is physical, not a tuning error. A DirectionalLight is a
  // zero-solid-angle source, so on a wet (roughness ~0.10) surface carrying a
  // high-frequency corrugation normal it produces a delta specular lobe whose
  // GGX highlight is sub-pixel and, because the source is INFINITE, lands at
  // the same phase of the corrugation over an entire wall. Two of them with
  // different colours arriving from opposite azimuths put their spikes one
  // pixel apart, which is the rainbow.
  //
  // But the requirement these three terms exist for is a COSINE ON A VERTICAL
  // FACE, i.e. an irradiance requirement - not a specular one. three's
  // hemisphere path writes straight into `irradiance` in lights_fragment_begin
  // and never reaches RE_Direct or RE_IndirectSpecular, so a HemisphereLight
  // with a HORIZONTAL axis (set via .position) delivers exactly the same
  // mix(ground, sky, dot(n,axis)*0.5+0.5) gradient - a real 0.97-vs-0.03
  // wall-to-wall ratio, the warm/cold cross-canyon split carried in the
  // color/groundColor pair - with mathematically zero specular aliasing.
  // Level 1 keeps its directionals untouched: dry chalky plaster at roughness
  // 0.8 has no delta lobe to alias, and that level is frozen.
  //
  // MEASURED, twice. At (ambient 0.32, hemi 0.135, fill 0.030) the containers
  // frame printed dead_cell 23.4% / vertical_imbalance 3.70. At
  // (0.58, 0.46, 0.20) it printed 20.3% / 1.83 - the imbalance was solved but
  // the surviving dead cells sat at 0.040-0.043 sRGB against a 0.045 floor,
  // i.e. a hair short, and they are all container flank. The numbers below are
  // that same shape carried the rest of the way, weighted toward the two terms
  // with a cosine on a vertical face.
  //
  // AND WHERE IT STOPS. A third pass took these to (0.92, 0.95, env 0.52, fill
  // 0.46) and the measurement got WORSE, not better: containers dead 12.5% ->
  // 18.8%, quay 15.6% -> 17.2%, both imbalances up, while the frame mean moved
  // by 0.02 and the upper rows barely changed at all. postfx meters the frame,
  // so a uniform lift of every indirect term is very close to a null operation -
  // the exposure gives it straight back and the only lasting effect is that the
  // toe drops further under the darkest cells. Global fill is not a lever on
  // this image past the point where the unlit half stops being crushed; the
  // levers that remain are all LOCAL (a lamp whose pool reaches the near field)
  // or RATIO (how much of the frame a pool covers). These are the measured
  // optimum and they are deliberately not the largest values tried.
  var HB = {
    // ambientFlash is the only unconditionally-COLD term in the rig, so it is
    // the one that sets the tint of the shadow side during a strike. It was
    // probed at 0.50 / 0.70 / 1.00 against the `lightning` capture chasing that
    // frame's residual grade inversion (shadow +0.009 RED under a +0.004 BLUE
    // highlight) and the metric moved the WRONG way at every step - because the
    // warm content in that frame's shadow band is the sodium pools and sky.js's
    // sodium-tinted fog, neither of which this file owns, and lifting the floor
    // only re-sorts which pixels land in the shadow percentile. Left at the
    // value that measured best rather than tuned to a metric it cannot reach.
    // ---- the *Flash numbers are ONE POOLED BUDGET --------------------------
    // See _harborFill. They are no longer five independent lifts: they are
    // summed into `omniBudget`, weather.js's own flash hemisphere is subtracted
    // from that sum, and the remainder is what any of them actually spends. So
    // the number to reason about is the TOTAL - ~1.3 at comp 1.2 - against
    // weather's flash fill, which runs 1.1-1.5 at a close strike. In practice
    // the other module pays for the whole omnidirectional half of the strike
    // and these are the headroom for a build where it does not exist.
    //
    // They came down 2-4x to get there, and the reason is measured rather than
    // aesthetic: with the previous values the two perpendicular canyon walls
    // lifted x5.66 and x5.42 on a strike while the apron - the only surface
    // facing a bolt 53 degrees up - lifted x4.23. Lightning that lifts the
    // surfaces facing away from it harder than the one facing it is a
    // full-screen fade, which ART_DIRECTION_HARBOR fails instantly.
    ambient: 0.76, ambientFlash: 0.26,   // AmbientLight, cold cyan
    hemi: 0.72, hemiFlash: 0.40,         // storm cloud above / wet apron below
    env: 0.34, envFlash: 0.16,           // PMREM dome
    bounce: 0.145, bounceFlash: 0.10,    // warm sodium bounced UP off the apron
    fill: 0.36, fillFlash: 0.10,         // cross-canyon hemisphere pair (walls)
    fillBRatio: 1.00,                    // the cold -X side against the warm +X
    // How dark the OPPOSITE half of each cross-canyon hemisphere is. Zero would
    // put a hard terminator down the middle of every box; this is the shadow
    // side of a wall that is still in the same weather as the lit side.
    fillBack: 0.08,
    key: 9.5,                            // peak lightning directional
    // ---- THE FLASH IS DIRECTIONAL OR IT IS NOTHING -------------------------
    // Every *Flash number above came down by roughly 3x, and the reason is
    // measured: with the previous values a strike lifted the left wall x6.96,
    // the right wall x4.73, the far wall x4.98 and the ground x6.38 - four
    // mutually-perpendicular orientations inside a factor of 1.5, which is the
    // definition of "no direction". The omnidirectional half of the strike
    // (ambient + hemisphere + environment, plus weather.js's own flash
    // hemisphere) was lifting by 3.4x while the terminator on the apron was
    // only 2.5:1. Lightning that relights a scene without moving its shadows is
    // on ART_DIRECTION_HARBOR's instant-fail list.
    //
    // The energy did not move to this module's key - it was already being spent
    // by weather.js and double-billed (see _findExternalFlash). It simply stops
    // being spent twice.
    //
    // weather.js also runs a lightning light of its own. Only directional light
    // INDEX 0 has shadows in this build - that is what the CSM shader patch
    // buys - but weather's is a shadow-casting SPOT, and the spot path in that
    // chunk is untouched, so BOTH halves of the strike genuinely cast. This is
    // the floor the cascade rig keeps no matter how much the other light is
    // spending, so a strike always moves the cascades as well.
    keyMin: 3.0,
    // Additive cone brightness. There is no tone curve between this number and
    // the HDR buffer, so it clips very early: at 0.105 + 0.165 the first quay
    // capture printed four solid white wedges with visible rims - cone-shaped
    // OBJECTS, not beams. The shell is DoubleSide, so the on-axis pixel pays
    // this twice; the target is a combined ~0.18 against a frame whose mean
    // luminance is ~0.15, i.e. luminous but never clipped.
    coneBase: 0.030,                     // additive cone brightness, dry
    coneRain: 0.050,                     // extra at rainIntensity 1
    // ---- and how far away it is still worth paying for --------------------
    // The shells used to be billed identically at 8 m and at 60 m: no
    // transmittance, no tone curve, no distance term. From the elevated
    // `harbor_overview` standpoint the camera looks down the AXIS of a dozen
    // cones at once - exactly where |N.V| and therefore the shell opacity are
    // maximal - and ~19 additive shells up to 34 m long summed into a flat
    // milky veil over the whole midground: measured +0.52 luma locally, +0.040
    // at p95 and +0.020 mean over the y380-520 band, on the one frame in the
    // level that has to read as a wide establishing shot (textured 9.0%
    // against 32-38% on every first-person framing).
    //
    // Scattered light obeys the same extinction law as everything else in the
    // frame, so the fix is not a fudge: the cone now carries the SAME
    // exponential transmittance the surfaces get from sky.js's fog, plus a
    // geometric 1/(1+d) term for the fact that a distant cone subtends less of
    // the pixel's solid angle. Both are normalised at coneRef metres so the
    // hero beams in `containers` / `gangway` keep the brightness they were
    // tuned to and only the far field pays.
    coneNear: 12.0,              // metres before the distance term starts
    coneFall: 30.0,              // ... and its half-value distance beyond that
    coneRef: 14.0,               // the range the authored brightness refers to
    // Ceiling on the SUM of the shells' estimated screen solid angle x
    // amplitude (see the cap in _updateHarbor). MEASURED off the live rig at
    // every published framing rather than chosen:
    //   warehouse 0.27, crane 1.01, containers 1.85, quay 2.54,
    //   rain_closeup 2.54, gangway 2.61, harbor_overview 2.97
    // The elevated establishing shot is the top of that list, which is the
    // whole point - it is the framing where a dozen shells stack end-on and the
    // one that measured a milky midground. 2.30 leaves the three tightest
    // framings untouched (scale 1.00) and takes the wide shot to 0.77, the
    // gangway to 0.88 and the quay to 0.91: a ceiling, not a dimmer.
    coneCap: 2.30,
    shaftLux: 3.4,                       // irradiance in a harbor roof shaft
    shaftHaze: 0.055,
    // Gain applied to intensities a LEVEL publishes. level_harbor asks for
    // 620 cd on a 10.4 m mast, which is 5.7 lux on the apron underneath -
    // about a third under the pool level level 1's street lamps were tuned to
    // (128 cd at 3.85 m = 8.6 lux) and it measured: the crane framing printed
    // mean luma 0.107 against ART_DIRECTION_HARBOR's 0.10-0.18 band, dynamic
    // range 0.43 against a 0.45 floor, and 0.00% blown - i.e. all the headroom
    // in the frame was unspent. This is the one number that buys it back, and
    // it lands the pools exactly where the proven level-1 ones sit.
    levelLampGain: 1.45,
    // ---- luminaire distribution ------------------------------------------
    // A real area floodlight is not a cookie-cutter cone. It has a bright core
    // and a WIDE low-intensity skirt, and the skirt is most of what actually
    // covers a yard: that is why eight masts light a whole terminal instead of
    // eight discs. Modelling every mast as a hard 0.46-0.52 rad cone aimed
    // straight down gave each one a ~12 m pool and NOTHING between them, and
    // since level_harbor stands its camera poses BETWEEN the masts (measured:
    // the nearest lamp to the `containers` eye is 10.5 m up the corridor, the
    // nearest to the `quay` eye is 11 m behind it) the near field of every hero
    // framing had no source over it at all.
    //
    // So the SpotLight angle is opened to LAMP_SKIRT x the authored cone and the
    // penumbra is solved so full output still stops at LAMP_CORE x the authored
    // cone. The bright core is unchanged - the pool the level asked for is still
    // there, at the same brightness - and outside it the light falls off smoothly
    // instead of ending at a hard edge, which is also what "visible falloff"
    // means. The VISIBLE cone mesh keeps the authored angle (see _coneVis), so
    // the beam you see is still the core you see on the ground; the skirt is a
    // wash far too dim to register as air glow.
    // The widening is a CEILING, not a multiplier, because level_harbor is
    // allowed to author a wide beam itself and did (its masts now publish
    // 0.50-0.90). Multiplying a 0.90 by a fixed factor took three of them past
    // 1.30 rad - 75 degrees - which is not a luminaire any more, it is a point
    // light, and it deletes the "genuine darkness between the pools" the brief
    // is built on. So: open a narrow beam toward lampMax, never past it, and
    // never narrow one the level already opened.
    lampSkirt: 1.45,
    lampMax: 0.92,               // ~53 deg, a real wide-flood distribution
    lampCore: 0.88,
    lampPenMin: 0.28             // there is always a visible falloff gradient
  };

  // A flash whose direction wanders mid-strike drags every shadow in the frame
  // with it, which reads as a bug rather than as lightning. The direction is
  // therefore LATCHED at the leading edge of each strike and held until it ends.
  var FLASH_ON = 0.02;           // below this the strike counts as over
  var HARBOR_FLASH_FALLBACK = new THREE.Vector3(-0.52, 0.62, -0.59).normalize();

  // Placement table. Each lamp is authored RELATIVE TO A PUBLISHED CAMERA POSE
  // (forward / right / height) rather than in absolute coordinates, because the
  // poses are the one thing about level_harbor.js that is guaranteed by
  // ART_DIRECTION_HARBOR ("level.cameraPoses must publish these") and because a
  // lamp placed off a framing is a lamp that is IN that framing. Level 1 round 3
  // proved the alternative: practicals transcribed from prose sat out in the
  // street while the room they existed to light measured 0.04 sky visibility.
  //
  // `fb` is the fallback in NORMALISED level-bounds space (0..1 across x, 0..1
  // across z) for a level that publishes no poses at all.
  //
  // Candela note: decay is 2, so the irradiance under a lamp is intensity / h^2.
  // A mast at 11.5 m running 950 cd puts ~7.2 on the apron directly below it -
  // roughly 24x the 0.30 ambient floor, which is what "pools of light with
  // genuine darkness between them" costs in real units.
  var HARBOR_LAMPS = [
    { name: 'mast_quay', kind: 'sodium', fixture: 'mast', hero: true,
      pose: 'quay', f: 15.0, r: -8.5, y: 11.5, fb: [0.28, 0.30],
      kelvin: HARBOR_SODIUM_K, intensity: 980, distance: 38,
      cone: 0.52, penumbra: 0.36, shadow: true, tilt: 2.6,
      halo: 3.4, beam: 1.0 },
    { name: 'mast_containers', kind: 'sodium', fixture: 'mast', hero: true,
      pose: 'containers', f: 17.0, r: 7.5, y: 11.5, fb: [0.68, 0.52],
      kelvin: HARBOR_SODIUM_K, intensity: 980, distance: 38,
      cone: 0.52, penumbra: 0.36, shadow: true, tilt: 2.6,
      halo: 3.4, beam: 1.0 },
    // The failing lamp. Noise-driven, never a sine - see _updatePracticals.
    { name: 'mast_apron', kind: 'sodium_failing', fixture: 'mast',
      pose: 'overview', f: 22.0, r: -11.0, y: 11.0, fb: [0.38, 0.74],
      kelvin: HARBOR_SODIUM_K, intensity: 860, distance: 34,
      cone: 0.54, penumbra: 0.40, tilt: 2.4, halo: 3.2, beam: 1.0 },
    { name: 'mast_gangway', kind: 'sodium', fixture: 'mast',
      pose: 'gangway', f: 13.0, r: 6.5, y: 11.0, fb: [0.80, 0.20],
      kelvin: HARBOR_SODIUM_K, intensity: 860, distance: 34,
      cone: 0.52, penumbra: 0.38, tilt: 2.4, halo: 3.2, beam: 1.0 },
    // ---- the cold half of the palette --------------------------------------
    { name: 'flood_warehouse', kind: 'mercury', fixture: 'flood',
      pose: 'warehouse', f: 9.0, r: -5.5, y: 7.2, fb: [0.14, 0.62],
      kelvin: HARBOR_MERCURY_K, intensity: 430, distance: 26,
      cone: 0.46, penumbra: 0.42, aim: 'poseForward', aimDist: 7.5,
      halo: 2.6, beam: 0.85 },
    // ---- THE CRANE ----------------------------------------------------------
    // Both of these are `supp`, so they survive a level that publishes its own
    // lamp set (level_harbor does), and both are resolved from level.anchors -
    // NOT from a camera pose. The previous crane flood was authored
    // `pose:'crane', fromPose:true` with a downward aim, and that class of
    // placement cannot work for a framing that looks UP: the crane pose is
    // pitched up 21 degrees at 70 degrees vertical FOV, so its horizon sits at
    // ndc y = -0.55 and NO point on the apron can land above the bottom fifth
    // of that frame. The lamp put the level's brightest cold source under the
    // gun and the crane capture was the only one still under the exposure
    // floor. See the guard in _harborLampDefs.
    //
    // The answer is the answer a crane engineer would give: the floods go on
    // the PORTAL BEAM, at sill height, and they throw down-lane at the working
    // strip - which is both physically correct for a ship-to-shore crane and
    // lands the pool 25-40 m out where the frame can see it, with the beam
    // itself crossing the middle third on its way there.
    { name: 'crane_portal_flood', kind: 'mercury', fixture: 'flood', supp: true,
      prio: 10,
      anchor: 'crane_portal', aimAnchor: 'crane_lane',
      kelvin: HARBOR_MERCURY_K, intensity: 4300, distance: 62,
      cone: 0.30, penumbra: 0.40, halo: 3.0, haloGain: 0.34, beam: 0.42 },
    // The gantry itself. A 30 m lattice at 02:00 against an unlit storm sky is
    // black on black - the crane framing measured its own subject as pure
    // negative space - and no amount of global fill can fix that, because fill
    // lifts the cloud behind it by the same amount. What turns a silhouette
    // into a subject is a GRAZING key: a flood on the A-frame throwing down the
    // LANDWARD LEG picks out every chord and lacing member at a few degrees of
    // incidence. It carries almost no volumetric (the camera looks nearly along
    // its axis, where a shell is at its brightest) and it is cold, so it is also
    // the crane framing's cool half of the palette.
    { name: 'crane_boom_rake', kind: 'mercury', fixture: 'none', supp: true,
      prio: 16,
      anchor: 'crane_rake_mount', aimAnchor: 'crane_rake_aim',
      kelvin: HARBOR_MERCURY_K, intensity: 7600, distance: 66,
      cone: 0.24, penumbra: 0.52, halo: 2.2, haloGain: 0.26, beam: 0.16 },
    // ---- THE NEAR FIELD OF THE FIRST-PERSON STANDPOINT ---------------------
    // Seven of the fourteen harbor captures - ads, weapon_closeup, muzzleflash,
    // firefight, enemy_closeup, explosion and `containers` itself - are shot
    // from the SAME standpoint, and it had no source within reach of it.
    // Measured on the live rig at that eye: irradiance on the apron 3 m ahead
    // 2.0, at 6 m 4.9, at 10 m 32 - but on a VERTICAL face 3 m ahead 0.00 and
    // at 6 m 0.07. Every lamp in the terminal is 5-14 m up and aimed DOWN and
    // AWAY, so the first six metres of every first-person frame contained no
    // light at all, and the militiaman in enemy_closeup - who stands 3.4 m from
    // the lens - measured 0.25 on his chest against 5.7 on the top of his head.
    // He printed as a black silhouette with a lit scalp, which is exactly what
    // the frame shows.
    //
    // It has to be BEHIND the eye, and that is optics rather than taste: the
    // portrait solver stands its subject between the camera and the brightest
    // lamp it can find, so every lamp that is in front of the camera is behind
    // the subject. Only a source on the camera's side of him can put light on
    // the side of him the camera sees. So this is a wall pack on the stack at
    // the mouth of the corridor, a metre behind and four metres above the
    // player's shoulder, throwing down the lane - the off-camera key, motivated
    // by a fixture that genuinely belongs on a container stack. It carries no
    // volumetric cone at all (`beam: 0`): a shell whose apex is behind the near
    // plane fills the whole frame with additive haze.
    //
    // Its output is deliberately capped BELOW the lighting tower's, because
    // scenarios.js ranks portrait keys by intensity / height^2 and picks the
    // winner: at 430 cd on a 5.0 m mount this scores 17 against the tower's 32,
    // so the tower stays the key that sets the framing and this stays the fill
    // that makes the subject readable. Raising it past ~800 would silently
    // relocate the whole portrait.
    // It is also deliberately SMALL. At 430 cd on a 51-degree flood the first
    // pass washed both canyon walls from cap to sill and took the framing to
    // mean luminance 0.232 and saturation 0.455 against ART_DIRECTION_HARBOR's
    // 0.10-0.18 - a foreground lit by an on-camera flash, which is the opposite
    // failure to the one it was fixing. 250 cd through a 25-degree core lands a
    // pool on the near apron and a raking edge on the stacks and leaves the rest
    // of the canyon to the masts. 200, finally, rather than 250: the framing's
    // mean luminance runs 0.167 with no near-field source at all, 0.202 at 250
    // and 0.232 at 430, against ART_DIRECTION_HARBOR's 0.10-0.18 low-key band -
    // so the last step down is what keeps the fix inside the exposure the level
    // is authored to.
    { name: 'lane_wallpack', kind: 'sodium', fixture: 'none', supp: true,
      prio: 8,
      anchor: 'floor_containers', anchorY: 5.0, anchorBack: -7.0, anchorSide: -1.2,
      pose: 'containers', f: -1.0, r: -1.2, y: 5.0, fb: [0.48, 0.82],
      kelvin: HARBOR_SODIUM_K, intensity: 200, distance: 22,
      cone: 0.44, penumbra: 0.42, aim: 'poseForward', aimDist: 8.0,
      halo: 0.9, haloGain: 0.30, beam: 0 },
    // Warehouse interior spilling out of the open roller door.
    { name: 'door_spill', kind: 'fluoro_cold', fixture: 'none',
      pose: 'warehouse', f: 3.5, r: 0.4, y: 3.1, fb: [0.16, 0.60],
      kelvin: 4300, intensity: 130, distance: 20,
      cone: 0.80, penumbra: 0.55, aim: 'poseBack', aimDist: 8.0,
      halo: 1.2, haloGain: 0.30, beam: 0.7 },
    // Forklift / bowser headlight, low and raking - the one light in the level
    // at eye height, which is what gives the container canyon a floor.
    // `anchor` beats `pose`: it is resolved against real geometry (see
    // _harborAnchors), so the vehicle stands ON the apron in the corridor the
    // framing looks down instead of five metres inside the stack, which is
    // where the pose offset had put it after level_harbor moved.
    { name: 'vehicle_head', kind: 'mercury', fixture: 'none', supp: true,
      prio: 14,
      anchor: 'floor_containers', anchorY: 1.05, anchorBack: 3.0, anchorSide: -1.1,
      pose: 'containers', f: 6.0, r: -5.5, y: 1.05, fb: [0.60, 0.66],
      kelvin: 5200, intensity: 190, distance: 26,
      cone: 0.34, penumbra: 0.30, aim: 'poseForward', aimDist: 14.0,
      halo: 0.55, haloGain: 0.22, beam: 0.8 },
    // ---- PORTABLE LIGHTING TOWERS ------------------------------------------
    // Standard yard plant, and the honest answer to the thing the measurement
    // found: level_harbor's eight masts are 11-12 m high and stand at the EDGES
    // of the working areas, so every published framing looks down a corridor
    // from a standpoint no mast reaches - the nearest lamp to the `containers`
    // eye is 10.5 m up the corridor, the nearest to `quay` is 11 m behind the
    // camera. A terminal solves exactly this with wheeled light towers dropped
    // where the night shift is working, and a tower is a REAL fixture this
    // module can build: base, telescopic mast, twin heads, halo and cone.
    // Positions are the derived open-floor anchors, so they move with the level.
    //
    // These are the level's COLD half and they used to be authored as 4600K
    // 'led', which is a warm white pulled only 38% toward #cfe6ff - i.e. it read
    // as a slightly paler sodium. Measured over pixels above 0.40 luma the
    // containers framing came back 59.2% warm against 3.5% cool and the crane
    // framing 59.1% against 2.8%: the two-temperature idea, which the art
    // direction calls the biggest colour idea in the level, existed only as a
    // tint on the ambient. They are now genuine 5600K mercury, and they are
    // anchored to the SAME open-floor points the sodium masts light, so the two
    // pools abut on the apron and you can see the boundary. Two temperatures
    // read only where they touch.
    // Aimed ALONG the framing's own sightline rather than tilted toward the
    // middle of the yard. A tower standing in a 3.8 m corridor and tilted 3.4 m
    // sideways washes the wall it is leaning on from a metre away; throwing it
    // 9 m down the lane instead lands a cold pool ON THE APRON just short of
    // where the sodium mast's pool begins, so the two temperatures meet at a
    // visible boundary in the middle of the frame. Two temperatures read only
    // where their pools touch - a cold lamp on the far side of the yard from
    // every warm one just makes two separate monochrome regions.
    //
    // ---- AND THEY WERE 1.7x TOO BRIGHT ------------------------------------
    // 850 / 800 / 720 cd on a 5.2 m mount is 31 / 30 / 27 lux directly under
    // the head, against 6-7 under a 1000 cd mast at 13 m: five times the pool
    // level of every other lamp in the terminal, from the fixture that stands
    // CLOSEST to the camera in three of the six framings. Two of the three had
    // never actually shipped (they were falling off the end of the practical
    // cap - see MAX_PRACTICALS_HARBOR), so the number had never been measured in
    // a frame; the first capture with all three alive printed the quay's wet
    // steel pole as a hard white stripe from cap to base and took blown_white
    // from 0.05% to 0.56%. At ~500 cd they sit at 18-19 lux - still visibly
    // brighter than a mast pool, which is what a work light IS - and the pole
    // reads as wet steel catching a cold light instead of as a clipped bar.
    { name: 'tower_containers', kind: 'mercury', fixture: 'tower', supp: true,
      prio: 12,
      anchor: 'floor_containers', anchorY: 5.2, anchorBack: 2.2, anchorSide: 1.0,
      pose: 'containers', f: 7.0, r: 0.0, y: 5.2, fb: [0.50, 0.55],
      kelvin: HARBOR_MERCURY_K, intensity: 540, distance: 26,
      cone: 0.62, penumbra: 0.45, aim: 'poseForward', aimDist: 7.0,
      halo: 1.5, haloGain: 0.20, beam: 0.10 },
    { name: 'tower_quay', kind: 'mercury', fixture: 'tower', supp: true,
      prio: 20,
      anchor: 'floor_quay', anchorY: 5.2, anchorBack: 2.2, anchorSide: 1.8,
      pose: 'quay', f: 8.0, r: 2.0, y: 5.2, fb: [0.40, 0.35],
      kelvin: HARBOR_MERCURY_K, intensity: 500, distance: 28,
      cone: 0.66, penumbra: 0.45, aim: 'poseForward', aimDist: 8.0,
      halo: 1.6, haloGain: 0.20, beam: 0.10 },
    { name: 'tower_gangway', kind: 'mercury', fixture: 'tower', supp: true,
      prio: 24,
      anchor: 'floor_gangway', anchorY: 5.0, anchorBack: 2.2, anchorSide: -1.8,
      pose: 'gangway', f: 8.0, r: -2.0, y: 5.0, fb: [0.60, 0.25],
      kelvin: HARBOR_MERCURY_K, intensity: 460, distance: 24,
      cone: 0.64, penumbra: 0.45, aim: 'poseForward', aimDist: 8.0,
      halo: 1.5, haloGain: 0.20, beam: 0.10 },
    // ---- unshadowed point practicals ---------------------------------------
    { name: 'portacabin', kind: 'tungsten', fixture: 'none',
      pose: 'overview', f: 14.0, r: 12.0, y: 2.45, fb: [0.86, 0.78],
      kelvin: 3000, intensity: 28, distance: 11, halo: 1.4 },
    { name: 'deck_freighter', kind: 'mercury', fixture: 'none', supp: true,
      prio: 30,
      anchor: 'hull_b', anchorY: 0.35,
      pose: 'gangway', f: 9.0, r: -4.0, y: 8.5, fb: [0.72, 0.10],
      kelvin: HARBOR_MERCURY_K, intensity: 95, distance: 24, halo: 2.2 }
    // NO navigation-light or reefer-bank PRACTICAL. Both used to be here at 18
    // and 24 cd, both were beyond the practical cap and therefore silently
    // dropped every single run, and neither would have lit anything if it had
    // survived: a masthead nav light and a reefer indicator are SOURCES, not
    // luminaires. They are in the picture as HARBOR_EMITTERS dots, which is what
    // they actually are, and the two slots they were consuming now carry the
    // crane rig - which is 30 m of the level's most photogenic object.
  ];

  // level_harbor publishes 20 of its own (10 masts, 2 high masts, 3 raking
  // floods, 2 crane floods, 2 boom floods, 1 warehouse tube) and the supporting
  // set this module appends has to fit as well or the last ones silently fall
  // off the end of the table - which is exactly what had happened: probed
  // against the live rig, all three lighting towers and the freighter deck lamp
  // were being cut, and the cold half of the palette went with them. The cap is
  // sized so the five ranked supporting lamps (see `prio`) always survive that
  // number, and the ranking makes the cut deterministic if the level grows
  // again. Every one is unshadowed, so the marginal cost is a few instructions
  // per fragment - but it IS a per-fragment cost on every material in the
  // terminal, which is why this is not simply raised until nothing is ever cut.
  //
  // 28, not 25, and the number is derived rather than chosen. level_harbor now
  // publishes 21 lamps; the ranked supporting set is 8. At 25 the last three
  // ranked lamps were silently dropped, and PROBED AGAINST THE LIVE RIG they
  // were `tower_quay`, `tower_gangway` and `deck_freighter` - i.e. the cold
  // half of the palette was missing from two of the six hero framings for
  // exactly the reason the comment above says it must not be. 28 keeps
  // everything down to `tower_gangway` (prio 24) and cuts only the 95 cd
  // freighter deck lamp, which is a glow card in every frame that can see it
  // anyway. If level_harbor publishes more, the `prio` ranking decides what
  // goes, and the diag publishes `dropped` so the next author can see it.
  var MAX_PRACTICALS_HARBOR = 28;

  // The one gate. `levelDef.weather === 'storm'` is a second key on the same
  // lock so a future stormy level inherits the rig; the market publishes
  // `weather: null`, so it can never be true there.
  function isHarborCtx(ctx) {
    if (!ctx) return false;
    if (ctx.levelId === 'harbor') return true;
    return !!(ctx.levelDef && ctx.levelDef.weather === 'storm');
  }

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
  // DECLARATIVE LIGHT RIGS  -  setRig(name) / setInterior(flag)
  //
  // main.js gives every level built after level 2 an `env` profile and applies
  // it, after every system has built, through these two setters. LEVELS 1 AND 2
  // CARRY `env: null`, SO NEITHER SETTER IS EVER CALLED ON THEM: the market and
  // the harbor run with rig === 'sun' and interior === false, which is the
  // legacy path bit for bit. Every branch added for the rigs is gated a SECOND
  // time on `this._declarative`, which is false for both of those ids. The
  // double gate is deliberate - this is the file that can silently regress two
  // frozen levels, and "the setter is never called" is a weaker guarantee than
  // "the code is unreachable".
  //
  // What a profile actually decides:
  //
  //   key       scales the key AFTER _readSky has finished computing it, so
  //             everything downstream - the cascade colour/intensity, the
  //             ground and facade bounce, the solar shafts, the viewmodel -
  //             follows without forming a second opinion about the hour.
  //   sun       false -> every cascade DirectionalLight is made INVISIBLE.
  //             three only uploads visible lights, so that drops them out of
  //             NUM_DIR_LIGHTS *and* NUM_DIR_LIGHT_SHADOWS: no shadow map is
  //             rendered, no PCSS kernel is evaluated, and the per-fragment
  //             directional loop shrinks. Setting intensity to 0 would have
  //             done none of that - the maps still render, every frame, for a
  //             light contributing nothing.
  //   fills     false -> the three BOUNCE DIRECTIONALS go invisible too. They
  //             model sunlight bouncing off ground and facades and there is no
  //             sun to bounce; but the real reason is the defect Cold Harbor
  //             paid for (see the HB block): a DirectionalLight is a
  //             zero-solid-angle specular source, and on the wet or
  //             high-frequency normals a flooded metro and a rained-on refinery
  //             are made of, it prints a coherent sub-pixel vertical barcode
  //             that chromatic aberration then splits into colour fringes. The
  //             HemisphereLight left carrying the fill cannot alias: three's
  //             hemisphere path never reaches RE_Direct or RE_IndirectSpecular.
  //   sky/amb/env  multipliers on the hemisphere, the ambient floor and the
  //             PMREM environment.
  //   bnc       multiplier on the bounce directionals when they DO survive.
  //             When `fills` is false it becomes the weight of the ENERGY
  //             COMPENSATION folded into the hemisphere instead (_updateFill),
  //             so switching the directionals off removes the aliasing without
  //             removing the fill.
  //   lampFloor the minimum value of the day/night lamp gate. A level with no
  //             sun has no day state at all, so its practicals are simply on.
  //   cfill     the CHARACTER / VERTICAL FILL - see _updateCharFill. 0 = off.
  //   cookie    optional {amount, scale, speed} canopy break-up on the CSM
  //             shadow term. 0/absent = the shader takes the identity path.
  //
  // ---- RIG OVERRIDES -------------------------------------------------------
  // Every scalar above can be overridden per level WITHOUT editing this table,
  // because a table of named presets cannot anticipate ten levels: pass an
  // object to setRig ({preset:'mixed', amb:1.6}) or publish `level.lightRig`
  // with the same shape. Both are merged OVER the named preset into a private
  // copy, so RIGS itself is never mutated and two levels can never collide.
  // Unreachable on market and harbor: both are non-declarative.
  //
  // Note what is NOT in the table: any attempt to light a level by raising a
  // global constant. Metering in postfx hands that lift straight back, so `amb`
  // is not a brightness control - it is the guarantee that nothing crushes to
  // detail-free black, and (with _rigMeter below) that the ratio between a lit
  // pool and the dark between pools stays inside roughly 50:1, which is all any
  // tone curve holds. What changes an image is a source near the camera, so
  // every rig here leans on the level's published practicals, and every one of
  // those gets emissive bulb + halo geometry from _buildLampVisuals: a light
  // with no visible source is not a light.
  // ==========================================================================
  var RIGS = {
    // Level 1's rig, named. Selecting it explicitly must be indistinguishable
    // from never calling setRig at all, so every multiplier here is exactly 1.
    sun: {
      key: 1.00, sun: true, fills: true,
      sky: 1.00, amb: 1.00, env: 1.00, bnc: 1.00, lampFloor: 0.00, cfill: 0.00
    },
    // No sun at all: the scene is lit entirely by placed lights. This is the
    // harbor's strategy expressed declaratively (the harbor itself still runs
    // its own hand-built rig), and what metro and bunker need.
    practicals: {
      key: 0.00, sun: false, fills: false,
      sky: 0.85, amb: 1.35, env: 0.55, bnc: 0.00, lampFloor: 1.00, cfill: 0.85
    },
    // A weak, low sun PLUS significant practicals - highrise (sunset through
    // open floor plates over interior lighting) and refinery (dusk sky, flare
    // stacks, sodium floods). The sun is trimmed rather than removed: it is
    // still what rakes the columns, it just stops being the only thing in the
    // frame with any output.
    //
    // ---- AND IT KEPT THE BOUNCE DIRECTIONALS IT WAS NEVER MEANT TO ----------
    // `fills` was true here, which is the exact defect the block above names
    // ("a rained-on refinery") and the stated reason `practicals` sets it
    // false. Measured on the refinery's signature framing: the X-brace on the
    // west rack peaked at 0.988 luminance with p99 0.942 and mean RGB
    // 0.69/0.66/0.58 - clipped and colourless - in a frame whose median is
    // 0.217, and every rack column carried a dashed white bead down its edge
    // that read as a string of LEDs. That is a zero-solid-angle specular source
    // raking a lattice of thin steel, and no amount of `bnc` trimming fixes it,
    // because the defect is in the specular lobe rather than in the magnitude:
    // at dusk these three lights were putting 0.02-0.07 of DIFFUSE irradiance
    // on anything and still owning the brightest pixels in the image.
    //
    // The 0.70 `bnc` weight is not thrown away, it is folded into the
    // hemisphere (see _updateFill), which delivers the same diffuse gradient
    // and cannot alias - three's hemisphere path never reaches RE_Direct or
    // RE_IndirectSpecular. `mixedsun` below is the old behaviour, kept as a
    // named preset so a level that genuinely wants the raking bounce pair (a
    // clear-air sunset, nothing wet or high-frequency in the near field) can
    // ask for it by name instead of by editing this table.
    mixed: {
      key: 0.62, sun: true, fills: false,
      sky: 0.80, amb: 1.25, env: 0.85, bnc: 0.70, lampFloor: 0.85, cfill: 0.85
    },
    // 'mixed' with the bounce directionals left on - i.e. exactly what 'mixed'
    // was before the refinery measurement above. Nothing selects it by default.
    mixedsun: {
      key: 0.62, sun: true, fills: true,
      sky: 0.80, amb: 1.25, env: 0.85, bnc: 0.70, lampFloor: 0.85, cfill: 0.00
    }
  };
  var DEFAULT_RIG = 'sun';
  // Every key a level may override through setRig({...}) or level.lightRig.
  // Whitelisted rather than merged wholesale so a typo in a level file cannot
  // introduce a field the rest of this module will silently read as undefined.
  var RIG_NUM_KEYS = ['key', 'sky', 'amb', 'env', 'bnc', 'lampFloor', 'cfill'];
  var RIG_BOOL_KEYS = ['sun', 'fills'];

  // ---- setInterior(true) ---------------------------------------------------
  // A fully enclosed level. The sun and the sky contribute nothing, so both are
  // switched off outright rather than turned down, and the hemisphere stops
  // taking its colour from an atmosphere that is not visible from anywhere in
  // the level.
  //
  // INT_SV_FLOOR is the interesting one. The sky-visibility volume exists to
  // stop unshadowed skylight leaking through roofs; underground there is no
  // skylight to leak, so at its normal 0.055 floor it would simply delete ~95%
  // of the only indirect term an enclosed level has. Zeroing the volume instead
  // would throw away the one thing it is still good for down here - creases,
  // alcoves and the backs of rooms measurably darker than open floor. So the
  // floor is RAISED, which converts it from a skylight mask into a soft
  // corner-darkening ambient occlusion term, and the compensation is dropped to
  // 1 to match (see _updateFill).
  var INT_SV_FLOOR = 0.45;
  var INT_HEMI = 0.55;           // nominal; the volume takes 0.45-1.0 of it
  var INT_AMB = 0.42;            // ungated - this IS the anti-crush floor
  var INT_ENV = 0.25;            // enough specular for metal to stop reading as plastic
  // Deliberately near-neutral and low chroma. Each interior level's hue comes
  // from its own practicals and its postfx grade preset ('green' for the metro,
  // 'alarm' for the bunker); a strongly tinted global fill would fight both.
  var INT_SKY_COL = new THREE.Color(0x3d4552);   // cool, from above
  var INT_GND_COL = new THREE.Color(0x40382e);   // warm, from underfoot
  var INT_AMB_COL = new THREE.Color(0x39404a);

  // The harbor rendered black because its masts put ~10 lux on the apron while
  // the fill put ~0.02 lux everywhere else. 500:1 is far past what any tone
  // curve holds, and the frame that came back was not "moody", it was empty.
  // _rigMeter re-derives the floor from whatever the level actually published,
  // so a level carrying a 400-candela flare stack gets a matching floor without
  // anyone editing this file.
  var LIT_DARK_RATIO = 50;
  // A declarative level places its own lights, and an industrial or underground
  // one needs many more than a market street. Still well under the harbor's 28.
  var MAX_PRACTICALS_RIG = 24;
  // Same idea for the glow cards: a level that publishes its own apertures is
  // not guessing where they are, and every card is one more instance in a mesh
  // that is drawn anyway - the ceiling is the instance buffer, not a draw call.
  var MAX_WINDOWS_RIG = 20;

  // ==========================================================================
  // THE CHARACTER / VERTICAL FILL  (rig scalar `cfill`)
  //
  // Measured on the refinery: an enemy standing INSIDE a lit pool, casting a
  // shadow - so receiving key - reads torso median 0.033 and face 0.037 against
  // ground 0.258 half a metre away. 7.8:1. In a shooter the enemy has to be the
  // most readable thing in the frame and here he was the least, and the level
  // could not fix it: it already publishes the full MAX_PRACTICALS_RIG, so it
  // had no slot left for a rim source, and the rig table exposed no per-level
  // fill scalar.
  //
  // WHY IT HAPPENS, AND WHY MORE AMBIENT DOES NOT FIX IT. Every fill in this
  // rig reaches UP-FACING surfaces: the hemisphere's sky half is weighted
  // 0.5*n.y+0.5, the practicals are ceiling fittings pointing down, and the
  // AmbientLight is a deliberately dark teal whose largest linear channel is
  // 0.115 - a floor sized to stop a shadow crushing, not to light a person.
  // A torso is VERTICAL. It collects half of the hemisphere and a grazing
  // cosine off every lamp above it. Raising `amb` to compensate would lift the
  // ground by the same amount and postfx's metering would hand most of it back.
  //
  // WHAT THIS IS. One HemisphereLight, anchored to the CAMERA: its axis points
  // back at the eye and 41 degrees BELOW the horizon. Hemisphere weight is
  // 0.5*dot(n,axis)+0.5, so a surface facing the camera collects 0.87 of it and
  // an up-facing floor collects 0.17 - a 5:1 preference for exactly the
  // surfaces a player needs to read (torsos, faces, the vertical face of cover,
  // the underside of a catwalk) over the one surface that is already lit.
  // The far half is BLACK, so anything facing away from the eye gets nothing
  // and the term cannot flatten a silhouette from behind.
  //
  // It is a HemisphereLight and not a DirectionalLight on purpose: this file
  // has already paid twice for zero-solid-angle specular sources on wet and
  // high-frequency normals (Cold Harbor's barcode, the refinery's clipped
  // X-braces), and a camera-anchored delta light would print a flash highlight
  // that moves with the player. three's hemisphere path never reaches
  // RE_Direct or RE_IndirectSpecular, so this one cannot alias at all.
  //
  // Its magnitude is DERIVED from the rig the level actually ended up with -
  // a share of the hemisphere plus a share of the anti-crush floor - so a
  // level gets a proportionate fill without a number being authored for it,
  // and it is scaled back by dayFactor: a fill that exists because there is no
  // key has no business competing with one.
  var CFILL_TILT = 0.66;         // sin of the below-horizon tilt of the axis
  var CFILL_HEMI = 0.55;         // share of the sky hemisphere it matches
  var CFILL_AMB = 0.42;          // share of the anti-crush floor it matches
  var CFILL_MAX = 1.05;          // hard ceiling - it is a fill, not a key
  var CFILL_DAY = 0.25;          // what survives in full daylight
  var CFILL_WHITE = 0.45;        // pulled toward neutral so it tints, not dyes

  // The non-aliasing replacement for the two facade-bounce DIRECTIONALS on a
  // rig that switched them off. Same tilt the harbor solved for the same
  // substitution: at 0.418 below the horizon an up-facing normal collects
  // 0.5*(-0.418)+0.5 = 0.291 of the light, which is what BNC_GW is, and a
  // vertical facing it collects 0.95.
  var BNC_TILT = 0.418;
  var BNC_GW = 0.5 * (1 - BNC_TILT);

  // The resolved viewmodel key below which a rig that HAS practicals stops
  // mirroring the world key and lights the weapon off the lamp pool the player
  // is standing in instead (see _updateViewRig). Measured: the refinery lands
  // at 0.48 and prints a silhouette; highrise, the other level on the same rig,
  // lands at 1.00 and keeps the sun-mirrored path. 0.75 separates them with
  // room on both sides.
  var VM_LOCAL_KEY = 0.75;

  // The second gate. True only for a level that carries an `env` profile, which
  // by construction excludes market and harbor.
  function isDeclarativeCtx(ctx) {
    if (!ctx) return false;
    if (ctx.levelId === 'market' || ctx.levelId === 'harbor') return false;
    return !!(ctx.levelDef && ctx.levelDef.env);
  }

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
    // COLD HARBOR only - the specular-free replacements for bounce/fillA/fillB.
    // Null on every other level; see _buildFill.
    this.hFillA = null;
    this.hFillB = null;
    this.hBounce = null;
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

    // ---- COLD HARBOR state --------------------------------------------------
    // Every one of these is inert for level 1: isHarbor is false, so nothing
    // reads them and no harbor code path is ever entered.
    this.isHarbor = isHarborCtx(ctx);
    this.flash = 0;                        // smoothed lightning intensity
    this.flashDirection = new THREE.Vector3().copy(HARBOR_FLASH_FALLBACK);
    this._flashPrev = 0;
    this._flashFrames = 0;
    this._flashLatch = new THREE.Vector3().copy(HARBOR_FLASH_FALLBACK);
    this._harborBuilt = false;
    this._harborF = null;                  // level frame (bounds + ground)
    this._harborWindows = null;            // glow cards consumed by _findLitWindows
    this._harborEmitters = null;           // indicator / nav / beacon dots
    this._harborEmitDefs = null;
    this._harborCones = null;              // volumetric lamp cones
    this._coneScale = null;                // smoothed accumulated-cone cap
    this._harborFixtures = null;           // merged housings / masts
    this._harborAnchorMap = null;          // decorations, derived from the level
    this._harborHero = [];                 // the shadow-casting practicals
    this._harborShaftSkip = null;
    this._heroCursor = 0;
    // Published for a probing critic: "how many real sources are in this rig".
    this.harborDiag = null;

    // ---- declarative rig state (levels 3-10) --------------------------------
    // Inert for market and harbor: _declarative is false for both ids, the rig
    // stays 'sun', and neither setter is ever called on them.
    this.rig = DEFAULT_RIG;
    this.interior = false;
    this._rigP = RIGS[DEFAULT_RIG];
    this._rigOver = null;                        // live copy when overridden
    this._levelRigChecked = false;
    this.charFill = null;                        // the camera-anchored fill
    this.bounceFill = null;                      // facade-bounce stand-in
    this._cookie = null;                         // {amount, scale, speed}
    this._beams = null;                          // declarative practical cones
    this._declarative = isDeclarativeCtx(ctx);
    this._rigFloor = 0;                          // ambient the 50:1 rule wants
    this._localCol = new THREE.Color(1, 0.92, 0.82);  // colour of the pool the eye is in
    this._localE = 0;                            // its rough irradiance at the eye
    this._rigWarned = false;
    // Published for a probing critic, mutated in place so the frame loop never
    // allocates. Null until a declarative level has run one update.
    this.rigDiag = null;

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
    this.isHarbor = isHarborCtx(ctx);
    this._declarative = isDeclarativeCtx(ctx);
    try {
      this._configureRenderer(ctx);
      this._buildCascades(ctx);
      this._buildFill(ctx);
      // The harbor's practicals are placed against the level's own camera poses
      // and bounds, neither of which exist yet (level.js builds after lighting),
      // so its rig is assembled on the first update instead - see
      // _buildHarborRig. Building the market set here first would put nine
      // street lamps in a container terminal for one frame.
      //
      // A declarative level is in the same position for the same reason: it
      // publishes level.practicalLights and level.js has not built yet, so its
      // rig is adopted on the first update (_adoptLevelPracticals). Building
      // the market table here would stand nine Al-Bakr street lamps in a metro
      // tunnel - and leave them there permanently if the level published none.
      if (!this.isHarbor && !this._declarative) this._buildPracticals(ctx);
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
    // COLD HARBOR: the cascades are the LIGHTNING caster and nothing else, so
    // they only render during a strike - but when they do, they all render in
    // the same frame. Two of them over 44 m is ample for a 60-180 ms event
    // (the third and fourth exist for a sun that follows the player around all
    // day) and it is two whole depth passes off the worst-case frame, which
    // measured 491 draw calls against a ~500 budget.
    //
    // THE CAP IS 2, NOT 3, AND IT IS A CORRECTNESS LIMIT RATHER THAN A BUDGET.
    // Every shadow-casting light costs the FRAGMENT shader one texture image
    // unit. This level lights itself with practicals: five shadow-casting
    // SpotLights, plus the sky-visibility volume, plus the PMREM environment,
    // plus each surface's map/normal/roughness/ao/detail set. At three cascades
    // that total crosses MAX_TEXTURE_IMAGE_UNITS (16 - the WebGL2 floor, and
    // what SwiftShader and a great many real GPUs actually report), every
    // affected program fails to validate, and three then issues
    // `useProgram: program not valid` for it. The draw call is still counted,
    // so the frame LOOKS healthy in the capture report while the containers,
    // the crane and the warehouse are simply not drawn - which is exactly how
    // this shipped unnoticed. Measured: at 4 and at 3 cascades the container
    // canyon renders as empty apron; at 2 it renders in full, at ultra, with
    // every post pass on. Do not raise this without re-measuring the unit count.
    if (this.isHarbor) n = Math.min(n, 2);

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

    // ---- COLD HARBOR: the same three fills, with no specular lobe -----------
    // See the long note above HB. On a wet corrugated flank a DirectionalLight
    // is a delta specular source and prints a coherent vertical barcode across
    // an entire wall; a HemisphereLight with the same axis delivers the same
    // diffuse gradient through `irradiance` and cannot alias, because three's
    // hemisphere path never reaches RE_Direct or RE_IndirectSpecular.
    //
    // three takes the hemisphere axis from the light's POSITION (WebGLLights
    // does setFromMatrixPosition + transformDirection), so a horizontal
    // position is a horizontal axis - a surface whose normal points at the
    // position collects skyColor, the opposite face collects groundColor. Both
    // are tilted ~25 deg BELOW the horizon so the apron, whose normal is +Y,
    // collects w = 0.29 rather than 0.5 and the pair keeps the wall-over-floor
    // ratio the directional pair was tuned for.
    //
    // Built ONLY for the harbor, and the harbor's three directionals are not
    // built at all: level 1 is frozen and must keep the exact light set - and
    // the exact NUM_HEMI_LIGHTS / NUM_DIR_LIGHTS - it shipped with.
    if (this.isHarbor) {
      // The -0.418 elevation is SOLVED, not chosen: it is the tilt at which an
      // up-facing normal collects 0.5 * (-0.418) + 0.5 = 0.291 of the pair,
      // which is exactly the 0.192 (at HB.fill) the two directionals used to put
      // on the apron. A flat horizontal axis would have handed the wet concrete
      // 0.925 of the pair instead of 0.479 and printed the black mirror as flat
      // pale grey - the substitution has to be energy-matched on the ground as
      // well as on the walls or it trades one defect for another.
      this.hFillA = new THREE.HemisphereLight(0xffb070, 0x0a0f14, 0);
      this.hFillA.name = 'canyonFillWarm';
      this.hFillA.position.set(0.900, -0.418, 0.129);
      this.hFillB = new THREE.HemisphereLight(0xa8c8e8, 0x0a0f14, 0);
      this.hFillB.name = 'canyonFillCold';
      this.hFillB.position.set(-0.900, -0.418, -0.129);
      // The ground bounce, same substitution: rays travelling UP off a soaked
      // apron. Axis straight down, so a down-facing surface (a container lip, a
      // boom underside, a chin) collects the whole term and an up-facing one
      // collects none of it - which is exactly what the directional did.
      this.hBounce = new THREE.HemisphereLight(0xff9a3c, 0x000000, 0);
      this.hBounce.name = 'apronBounce';
      this.hBounce.position.set(0, -1, 0);
      this.root.add(this.hFillA, this.hFillB, this.hBounce);
      // No bounce/fillA/fillB directionals here at all. Three fewer entries in
      // NUM_DIR_LIGHTS is also three fewer per-fragment loops in every material
      // in the terminal.
      this.bounce = null;
      this.fillA = null;
      this.fillB = null;
      this.fill = null;
      this.ambient = new THREE.AmbientLight(0x24384a, 0.06);
      this.ambient.name = 'shadowFloor';
      this.root.add(this.ambient);
      return;
    }

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

    // ---- character / vertical fill (declarative levels only) ----------------
    // Built here rather than lazily so the object graph is stable, but created
    // INVISIBLE: three only uploads visible lights, so until a rig asks for it
    // NUM_HEMI_LIGHTS is unchanged and no material sees a different program.
    // Never built at all for market or harbor - the light set those two shipped
    // with is frozen, and "the object does not exist" is a stronger guarantee
    // than "the object is switched off".
    if (this._declarative) {
      this.charFill = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
      this.charFill.name = 'characterFill';
      this.charFill.visible = false;
      this.charFill.position.set(0, -1, 0);
      this.root.add(this.charFill);
      // ...and the non-aliasing stand-in for the facade-bounce pair, for a rig
      // that switches them off. Same lifecycle: invisible until asked for, so
      // NUM_HEMI_LIGHTS is unchanged until it is.
      this.bounceFill = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
      this.bounceFill.name = 'facadeBounceHemi';
      this.bounceFill.visible = false;
      this.bounceFill.position.set(0, -1, 0);
      this.root.add(this.bounceFill);
    }
  };

  // ==========================================================================
  // Declarative rig selection - the two public setters main.js calls
  // ==========================================================================

  // Select a lighting strategy by name. Unknown names are IGNORED rather than
  // fatal (main.js guards the call, but a preset that half-applies is worse
  // than one that does not apply at all), and the previous rig survives.
  // Returns the rig actually in force, so a caller can tell.
  Lighting.prototype.setRig = function (name) {
    try {
      // ---- object form: {preset, ...scalar overrides} ----------------------
      // main.js passes env.lightRig straight through, and an object is truthy,
      // so a level can carry `lightRig: {preset:'mixed', amb:1.6}` in its env
      // profile with no change to main.js at all. A level may equally publish
      // `level.lightRig` (see _adoptLevelRig) - same shape, same merge.
      if (name && typeof name === 'object') {
        var pre = name.preset || name.rig || name.name;
        if (typeof pre === 'string') this.setRig(pre);
        this._applyRigOverride(name);
        return this.rig;
      }
      var n = (typeof name === 'string') ? name.toLowerCase().replace(/\s+/g, '') : '';
      if (n && RIGS[n]) {
        this.rig = n;
        // Any previous override belonged to the previous preset. Selecting a
        // preset by name is a full reset - half an override is worse than none.
        this._rigOver = null;
        this._rigP = RIGS[n];
      } else if (n && !this._rigWarned) {
        this._rigWarned = true;
        GAME.logError('lighting.setRig', 'unknown rig "' + name +
          '" - keeping "' + this.rig + '"');
      }
    } catch (e) {
      GAME.logError('lighting.setRig', e);
    }
    return this.rig;
  };

  // Merge scalar overrides over the CURRENT preset into a private copy. RIGS is
  // never mutated: two levels in the same process (or a level that calls setRig
  // twice) must not be able to poison each other's preset.
  Lighting.prototype._applyRigOverride = function (o) {
    if (!o || typeof o !== 'object') return;
    var base = this._rigOver || RIGS[this.rig] || RIGS[DEFAULT_RIG];
    var out = {}, i, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (i = 0; i < RIG_NUM_KEYS.length; i++) {
      k = RIG_NUM_KEYS[i];
      if (isFinite(o[k])) out[k] = M.clamp(+o[k], 0, 8);
    }
    for (i = 0; i < RIG_BOOL_KEYS.length; i++) {
      k = RIG_BOOL_KEYS[i];
      if (o[k] !== undefined) out[k] = !!o[k];
    }
    this._rigOver = out;
    this._rigP = out;
    if (o.cookie !== undefined) this.setShadowCookie(o.cookie);
  };

  // level.js builds after lighting, so a rig override published on the LEVEL
  // (rather than in the env profile) can only be picked up on the first update.
  // Unreachable on market and harbor - both are non-declarative.
  Lighting.prototype._adoptLevelRig = function (ctx) {
    if (this._levelRigChecked || !this._declarative) return;
    var lvl = ctx && ctx.level;
    if (!lvl) return;                       // level failed to build - keep ours
    this._levelRigChecked = true;
    try {
      // Through setRig, not _applyRigOverride, so a level may name a different
      // preset as well as override its scalars.
      if (lvl.lightRig && typeof lvl.lightRig === 'object') {
        this.setRig(lvl.lightRig);
      }
      if (lvl.shadowCookie !== undefined) this.setShadowCookie(lvl.shadowCookie);
    } catch (e) {
      GAME.logError('lighting.adoptLevelRig', e);
    }
  };

  // ---- the canopy / gobo cookie -------------------------------------------
  // Break-up on the CSM shadow term, for a key that passes through an occluder
  // this build cannot afford to shadow-map: a jungle canopy at 20 m, mist
  // between temple towers, a slatted roof. Off unless a declarative level asks.
  // `false`/0/undefined restores the identity path, which is what market and
  // harbor always run.
  Lighting.prototype.setShadowCookie = function (o) {
    try {
      if (!o || o === true) o = (o === true) ? { amount: 0.5 } : null;
      if (!o || !this._declarative) {
        this._cookie = null;
      } else {
        this._cookie = {
          amount: M.clamp(isFinite(o.amount) ? +o.amount : 0.5, 0, 0.92),
          scale: M.clamp(isFinite(o.scale) ? +o.scale : 6.0, 0.5, 80),
          speed: M.clamp(isFinite(o.speed) ? +o.speed : 0.05, 0, 2),
          sharp: M.clamp(isFinite(o.sharp) ? +o.sharp : 0.5, 0, 1)
        };
      }
      this._applyCookieUniform();
    } catch (e) {
      GAME.logError('lighting.setShadowCookie', e);
    }
    return this._cookie;
  };

  // CK_PARAMS is the shared Float32Array every material in the build reads BY
  // REFERENCE (see the UNIFORM PLUMBING note in the header), so writing it here
  // reaches programs that compiled long ago. Amount 0 is the identity path.
  Lighting.prototype._applyCookieUniform = function () {
    if (!CK_PARAMS) return;
    var c = this._cookie;
    if (!c || !this._declarative) {
      CK_PARAMS[3] = 0;
      return;
    }
    CK_PARAMS[0] = 1 / Math.max(c.scale, 0.5);
    // A canopy moves. Scrolling the pattern rather than the geometry is what
    // makes a still frame read as air rather than as a decal, and it costs two
    // scalar writes per frame.
    CK_PARAMS[1] = this._t * c.speed;
    CK_PARAMS[2] = this._t * c.speed * 0.63;
    CK_PARAMS[3] = c.amount;
    if (CK_PARAMS2) CK_PARAMS2[0] = c.sharp;
  };

  // Declare the level fully enclosed. Sun and sky are switched off entirely,
  // the ambient floor comes up, the sky-visibility volume is re-purposed as a
  // corner-darkening AO term, and the cascades stop rendering shadow maps for a
  // directional light that contributes nothing. Reversible.
  Lighting.prototype.setInterior = function (flag) {
    try {
      this.interior = (flag === undefined) ? true : !!flag;
    } catch (e) {
      GAME.logError('lighting.setInterior', e);
    }
    return this.interior;
  };

  // True only where a declarative profile is in force AND it asks for something
  // other than level 1's behaviour. Market and harbor can never reach it.
  Lighting.prototype._rigActive = function () {
    if (!this._declarative) return false;
    return this.interior || this.rig !== DEFAULT_RIG;
  };

  // Applies the parts of a profile that are about which LIGHT OBJECTS exist,
  // as opposed to how bright they are. Runs at the top of _updateFill, every
  // frame, so setRig/setInterior can be called at any time and take effect on
  // the next frame without any rebuild. Returns the profile, or null when the
  // legacy path is in force.
  Lighting.prototype._applyRigLights = function (ctx) {
    if (!this._declarative) return null;
    var P = this._rigP || RIGS[DEFAULT_RIG];
    var wantSun = !this.interior && P.sun !== false;
    var wantFills = !this.interior && P.fills !== false;
    var i;
    // Invisible, not intensity 0: three skips invisible lights entirely, so
    // this is what actually stops the CSM depth passes from being rendered for
    // a light that puts nothing in the frame. `this.sun` still points at
    // cascades[0].light, so the documented API is unchanged.
    for (i = 0; i < this.cascades.length; i++) this.cascades[i].light.visible = wantSun;
    if (this.bounce) this.bounce.visible = wantFills;
    if (this.fillA) this.fillA.visible = wantFills;
    if (this.fillB) this.fillB.visible = wantFills;
    // Re-purpose (interior) or leave alone (everything else) the volume's floor.
    // SV_PARAMS is the shared uniform payload every material in the build reads
    // by reference, so this one store reaches shaders compiled hours ago.
    if (SV_PARAMS) SV_PARAMS[0] = this.interior ? INT_SV_FLOOR : SV_FLOOR;
    return P;
  };

  Lighting.prototype._maxPracticals = function () {
    if (this.isHarbor) return MAX_PRACTICALS_HARBOR;
    // A declarative level places its own lights against its own geometry, and
    // an underground or industrial one needs far more of them than a market
    // street does. The market keeps its own cap exactly.
    return this._declarative ? MAX_PRACTICALS_RIG : MAX_PRACTICALS;
  };

  Lighting.prototype._buildPracticals = function (ctx, defs) {
    defs = defs || PRACTICALS;
    var cap = this._maxPracticals();
    for (var i = 0; i < defs.length && i < cap; i++) {
      var d = defs[i];
      var pos = d.pos || [0, 2, 0];
      // A def may carry a fully-resolved colour (the harbor rig mixes its
      // blackbody toward the art-directed sodium/mercury hues before it gets
      // here). Anything without one keeps the level-1 kelvin + kind chain
      // untouched, which is what makes this edit invisible to the market.
      var col = (d.color && d.color.isColor)
        ? d.color.clone()
        : GAME.Color.kelvin(d.kelvin || 2800, new THREE.Color());
      if (d.color && d.color.isColor) {
        /* already resolved */
      } else if (d.kind === 'sodium') {
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
        if (d.aimPos && d.aimPos.length === 3) {
          light.target.position.set(d.aimPos[0], d.aimPos[1], d.aimPos[2]);
        } else {
          light.target.position.set(pos[0], pos[1] - 3.0, pos[2]);
        }
        this.root.add(light.target);
      } else {
        light = new THREE.PointLight(0xffffff, 0, dist, 2);
      }
      light.name = d.name || ('practical_' + i);
      light.color.copy(col);
      light.castShadow = false;   // point shadows are 6 renders each - not worth it
      // The two hero masts are the ONLY shadow-casting practicals in the build,
      // and only in the harbor. A spot shadow is one extra depth pass of the
      // whole scene, so two of them amortised over four frames is the entire
      // practical shadow budget - see the header of the COLD HARBOR block.
      if (d.shadow && this.isHarbor && light.isSpotLight) {
        light.castShadow = true;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.bias = -0.0008;
        light.shadow.normalBias = 0.045;
        light.shadow.radius = 3;
        light.shadow.camera.near = 0.6;
        light.shadow.camera.far = dist * 1.05;
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = true;
      }
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
        // ---- harbor-only decoration (all undefined for level 1) -------------
        // haloMax  : humid air makes a much larger halo than dry desert air, so
        //            the market's 2.8 m ceiling has to be liftable per lamp.
        // fixed    : this lamp has FIXTURE GEOMETRY built at its coordinates, so
        //            _clampPracticals must not quietly slide the light out from
        //            under its own housing.
        // aimed    : the spot target was solved by the harbor rig; the enclosure
        //            pass must not reset it to "3 m straight down".
        // bulbR/bulbFlat/bulbAxis : the emissive source is a flattened LENS on
        //            the fixture axis here, not a bare bulb.
        haloMax: d.haloMax != null ? d.haloMax : null,
        // HALO_GAIN was tuned against level 1's sodium, whose linear colour is
        // (1.00, 0.19, 0.01) - only the red channel ever gets near the ceiling.
        // A near-white 4800K LED halo at the same gain is (0.85, 0.85, 0.85)
        // additive, which printed as a white ball filling an eighth of the quay
        // frame. Cool practicals therefore carry their own gain. Null for every
        // level-1 lamp, so its halos are bit-identical.
        haloGain: d.haloGain != null ? d.haloGain : null,
        fixed: !!d.fixed,
        aimed: !!(d.aimPos && d.aimPos.length === 3),
        bulbR: d.bulbR != null ? d.bulbR : null,
        bulbFlat: d.bulbFlat != null ? d.bulbFlat : 1,
        bulbAxis: d.bulbAxis || null,
        bulbGain: d.bulbGain != null ? d.bulbGain : 1,
        // Explicit volumetric-cone request. Null means "decide from the fixture
        // and the air" (_buildRigBeams); 0 means "definitely not". The harbor
        // never reads this - it resolves its own _beamGain on the def.
        beam: isFinite(d.beam) ? M.clamp(d.beam, 0, 1.4) : null,
        coneAngle: d.cone ? M.clamp(d.cone, 0.15, 1.4) : 0,
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
    if (!Array.isArray(defs) || !defs.length) {
      // A declarative level built no practicals of its own AND never got the
      // market's table (build() skips it there), so on a 'practicals' rig it
      // has literally no sources. That is an authoring error in the level, not
      // something this module can invent geometry to fix - but it is exactly
      // the class of defect that is invisible in a thumbnail, so say so once.
      if (this._declarative && this._rigP && this._rigP.lampFloor > 0 &&
          !this.practicals.length && !this._rigWarned) {
        this._rigWarned = true;
        GAME.logError('lighting.rig', 'level "' + (ctx.levelId || '?') +
          '" selected rig "' + this.rig +
          '" but published no level.practicalLights - nothing lights it');
      }
      return;
    }
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
      // relocated goes on pointing at where it used to be. A lamp the harbor rig
      // AIMED is exempt: its target was solved against the level (a wall flood
      // rakes forward, a headlight throws down a lane) and resetting it to "3 m
      // straight down" would point every flood at its own foot.
      if (p.light.isSpotLight && p.light.target && !p.aimed) {
        p.light.target.position.set(p.base.x, p.base.y - 3.0, p.base.z);
      }
    }

    // Everything below needs the occupancy grid AND the final lamp positions.
    this._buildLampVisuals(ctx, G);
    this._buildShafts(ctx, G);
    this._buildRigBeams(ctx);

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
      // middle of the room and undo that. `fixed` lamps have real FIXTURE
      // GEOMETRY standing at their coordinates (harbor mast heads, floods), and
      // a light that slides 2 m out of its own housing is a worse defect than
      // one pressed slightly close to a container flank.
      if (p.relocated || p.fixed) continue;
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
    // The station list below is the MARKET's carriageway (x = 0, z = +8..-30).
    // In a 90 x 70 m container terminal those coordinates are just as likely to
    // land inside a stack as on the apron, so the harbor probes what it actually
    // has: its own spawn point and every framing it publishes. Same idea - "what
    // does open ground measure here" - measured against the right ground.
    if (this.isHarbor) {
      var hsum = 0, hn = 0, hv;
      var hsp = lvl && lvl.spawnPoints && lvl.spawnPoints[0];
      if (hsp && hsp.position) {
        _v1.set(hsp.position.x, hsp.position.y + 1.6, hsp.position.z);
        hv = this.skyVisibilityAt(_v1);
        if (isFinite(hv) && hv > 0.08) { hsum += hv * 2; hn += 2; }
      }
      var hp = lvl && lvl.cameraPoses;
      if (hp) {
        for (var hk in hp) {
          var hq = hp[hk] && hp[hk].position;
          if (!hq || !isFinite(hq.x)) continue;
          hv = this.skyVisibilityAt(hq);
          if (isFinite(hv) && hv > 0.08) { hsum += hv; hn++; }
        }
      }
      return hn ? (hsum / hn) : 0.72;   // an open quay is mostly open sky
    }
    // Every level after the harbor has the same problem the harbor had: the
    // station list below is the MARKET's carriageway and means nothing in a
    // subway tunnel or an aircraft boneyard. So a declarative level is probed
    // the way the harbor is - at its own spawn point and its own published
    // framings, which is by definition where the player and the camera are.
    if (this._declarative) {
      var dsum = 0, dn = 0, dv;
      var dsp = lvl && lvl.spawnPoints && lvl.spawnPoints[0];
      if (dsp && dsp.position) {
        _v1.set(dsp.position.x, dsp.position.y + 1.6, dsp.position.z);
        dv = this.skyVisibilityAt(_v1);
        if (isFinite(dv) && dv > 0.08) { dsum += dv * 2; dn += 2; }
      }
      var dp = lvl && lvl.cameraPoses;
      if (dp) {
        for (var dk in dp) {
          var dq = dp[dk] && dp[dk].position;
          if (!dq || !isFinite(dq.x)) continue;
          dv = this.skyVisibilityAt(dq);
          if (isFinite(dv) && dv > 0.08) { dsum += dv; dn++; }
        }
      }
      // Nothing read above the floor => the level is enclosed, and the whole
      // compensation idea (redistribute light rather than dim the game) has no
      // fixed point to hang off. SV_REF then leaves comp at its neutral value.
      return dn ? (dsum / dn) : SV_REF;
    }
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
    // The harbor authors its own glow cards (portacabin windows, the open
    // roller door, reefer doors, the freighter's deck spill) against real
    // published poses, so the street-facade march below - which assumes a
    // 7-25 m wide canyon centred on x = 0 - must not run there.
    if (this.isHarbor) return this._harborWindows || out;
    // Same reasoning for every declarative level: the march below assumes a
    // 7-25 m canyon centred on x = 0 with plaster facades either side, which is
    // one level's floor plan and nobody else's. A level that wants lit apertures
    // publishes them as `level.litWindows` - entries of
    // {x, y, z, w, h, kelvin, gain} plus the optional {yaw, scale, tint,
    // tintAmt, haloSize, hox/hoy/hoz, flick} that _buildLampVisuals already
    // understands - and gets glow cards plus halos for free.
    if (this._declarative) {
      var lw = this.ctx && this.ctx.level && this.ctx.level.litWindows;
      if (!Array.isArray(lw)) return out;
      // The market's cap of 6 was a search budget for a heuristic that had to
      // guess where the windows were. A level that KNOWS is not guessing, and
      // every card is one more instance in a mesh that is already being drawn,
      // so the ceiling is the instance buffer's, not a draw call's.
      for (var q = 0; q < lw.length && out.length < MAX_WINDOWS_RIG; q++) {
        var e = lw[q];
        if (!e || !isFinite(e.x) || !isFinite(e.y) || !isFinite(e.z)) continue;
        out.push({
          x: e.x, y: e.y, z: e.z,
          sign: isFinite(e.sign) ? e.sign : 0,
          yaw: isFinite(e.yaw) ? e.yaw : 0,
          w: isFinite(e.w) ? e.w : 0.9, h: isFinite(e.h) ? e.h : 1.2,
          scale: isFinite(e.scale) ? e.scale : 2.2,
          kelvin: isFinite(e.kelvin) ? e.kelvin : 2900,
          gain: isFinite(e.gain) ? e.gain : 1.0,
          tint: (e.tint && e.tint.isColor) ? e.tint : null,
          tintAmt: isFinite(e.tintAmt) ? e.tintAmt : 0.5,
          haloSize: isFinite(e.haloSize) ? e.haloSize : null,
          hox: isFinite(e.hox) ? e.hox : 0,
          hoy: isFinite(e.hoy) ? e.hoy : 0,
          hoz: isFinite(e.hoz) ? e.hoz : 0,
          flick: isFinite(e.flick) ? e.flick : 1
        });
      }
      return out;
    }
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
          // +/- 90 degrees turns it to face -/+ X. A card may instead publish
          // its own `yaw` (the harbor's openings face every which way); the
          // market never does, so its matrices are bit-identical to before.
          var wyaw = (d.yaw != null && isFinite(d.yaw))
            ? d.yaw : (d.sign > 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
          var wsc = (d.scale != null && isFinite(d.scale)) ? d.scale : 2.2;
          _q1.setFromAxisAngle(_upY, wyaw);
          m.compose(_v1.set(d.x, d.y, d.z), _q1, _v2.set(d.w * wsc, d.h * wsc, 1));
          winMesh.setMatrixAt(w, m);
          d.color = GAME.Color.kelvin(d.kelvin, new THREE.Color());
          if (d.tint && d.tint.isColor) d.color.lerp(d.tint, d.tintAmt != null ? d.tintAmt : 0.5);
          // Each window also gets a halo entry - glass spills into the air.
          var hox = (d.hox != null && isFinite(d.hox)) ? d.hox : -(d.sign || 0) * 0.10;
          var hoy = (d.hoy != null && isFinite(d.hoy)) ? d.hoy : 0;
          var hoz = (d.hoz != null && isFinite(d.hoz)) ? d.hoz : 0;
          var hs = (d.haloSize != null && isFinite(d.haloSize)) ? d.haloSize : d.w * 4.0;
          _q1.identity();
          m.compose(_v1.set(d.x + hox, d.y + hoy, d.z + hoz), _q1,
            _v2.set(hs, hs, 1));
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
        var r = (p.bulbR != null ? p.bulbR : BULB_RADIUS) *
          (0.85 + 0.35 * M.saturate(lit));
        if (p.bulbAxis) {
          // A mast head's visible source is the LENS in the bottom of a
          // reflector, not a bare bulb: a flattened, axis-aligned disc of glass.
          // Squashing the sphere along the beam axis is what makes it read as a
          // fitting instead of as a floating pearl.
          // _q2, NOT _q1: _q1 already holds the camera orientation the halo
          // loop below is about to billboard every card with.
          _q2.setFromUnitVectors(_upZ, p.bulbAxis);
          _v2.set(r, r, r * (p.bulbFlat || 1));
          m.compose(p.light.position, _q2, _v2);
        } else {
          m.makeScale(r, r, r);
          m.setPosition(p.light.position.x, p.light.position.y, p.light.position.z);
        }
        vis.bulbs.setMatrixAt(i, m);
        // Emissive level tracks the light's own live output, so a stuttering
        // sodium head and a gusting brazier flicker in the glass as well as on
        // the ground - the give-away that a "light source" is really a decal is
        // that it stays put while the light it claims to emit moves.
        _c1.copy(p.light.color).multiplyScalar(BULB_GAIN * lit * (p.bulbGain || 1));
        vis.bulbs.setColorAt(i, _c1);
      }
      vis.bulbs.instanceMatrix.needsUpdate = true;
      if (vis.bulbs.instanceColor) vis.bulbs.instanceColor.needsUpdate = true;
    }

    if (vis.halos) {
      for (i = 0; i < n && i < vis.halos.count; i++) {
        p = this.practicals[i];
        lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2);
        // A halo is the light scattered out of the beam by whatever is in the
        // air between the lamp and the eye. In dry desert air that is a small
        // disc; in a harbor downpour it is several metres across, so the ceiling
        // is per-lamp. `haloMax` is null for every level-1 practical.
        var s = M.clamp((p.distance || 10) * (p.haloScale || HALO_SCALE) * 0.34,
          0.7, p.haloMax != null ? p.haloMax : 2.8) *
          (0.8 + 0.3 * M.saturate(lit));
        m.compose(p.light.position, _q1, _v2.set(s, s, 1));
        vis.halos.setMatrixAt(i, m);
        _c1.copy(p.light.color).multiplyScalar(
          HALO_GAIN * lit * (p.haloGain != null ? p.haloGain : 1));
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
        var fl = 1 + this.noise.perlin2(this._t * 0.23 + v2 * 13.7, 3.3) *
          0.11 * (d2.flick != null ? d2.flick : 1);
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
      var skip = this._harborShaftSkip;
      // Every published entry that is not already a lamp gets built. The old
      // cap of 2 was written when the market published exactly one shaft; a
      // level that publishes three real apertures should not silently lose one.
      // Only the first casts a shadow - that is the whole shaft shadow budget.
      // A declarative level gets the harbor's allowance rather than the
      // market's: a refinery flare stack, a metro platform and a temple gallery
      // all publish several real apertures and losing three of four silently is
      // exactly the sort of thing nobody notices until the level looks empty.
      //
      // 8, not 4, for a declarative level. The jungle publishes exactly four and
      // was therefore already sitting ON the ceiling, which means "light arrives
      // as shafts filtered through canopy" - the level's entire brief - could
      // never be more than four cones no matter what the level did. The cost of
      // a ninth is one unshadowed SpotLight and one 18x9 additive cone, and it
      // is paid only by the level that publishes it; the SHADOW budget is
      // unchanged, because only the first shaft has ever cast one.
      var cap2 = this.isHarbor ? 4 : (this._declarative ? 8 : 2);
      for (var i = 0; i < defs.length && this._shafts.length < cap2; i++) {
        // An entry the harbor rig already turned into a mast lamp must not also
        // become a shaft - it would stand a second cone inside the first.
        if (skip && skip[i]) continue;
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
    // The market's shafts are SOLAR: the aperture in the roofline is incidental
    // and the beam only has to land somewhere the framing can see, so it is
    // re-solved against the pose. A harbor shaft is a FIXTURE - level_harbor
    // publishes the crane's own lighting rig this way - so its published origin
    // is the answer and moving it would take the beam off the machine it is
    // bolted to. A container terminal is also vertical: a 10.5 m ceiling on the
    // run is a market constraint, not a physical one.
    //
    // A declarative level is treated like the harbor, and for the same reason:
    // it publishes an aperture it built geometry around (a hole in a platform
    // ceiling, a gap between two distillation columns, a gallery window in a
    // temple), so its origin is the answer and re-solving it against a camera
    // pose would slide the beam off the hole it comes through. It also gets the
    // taller run - a 10.5 m ceiling is a market constraint, not a physical one.
    var authoredShaft = this.isHarbor || this._declarative;
    var LEN_MAX = authoredShaft ? 22.0 : 10.5;
    if (authoredShaft) { pose = null; pp = null; }

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
            best = { score: score, fx: px, fy: fy, fz: pz, run: Math.min(run, LEN_MAX) };
          }
        }
      }
    }

    if (!best) {
      // No usable pose: fall back to the published aperture and just trace down.
      var hit = svTrace(G, ex, ey, ez, bx, by, bz,
        authoredShaft ? LEN_MAX + 12.0 : 22.0);
      if (hit < 0) return null;
      best = {
        fx: ex + bx * hit, fy: ey + by * hit + 0.03, fz: ez + bz * hit,
        run: Math.min(hit, LEN_MAX)
      };
    }

    var len = M.clamp(best.run, 3.0, LEN_MAX);
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
    // Three OPTIONAL fields a level may add to a shaft. They are independent on
    // purpose - a dawn temple wants a warm SOLAR shaft (colour only, still gated
    // on the sun), a metro tunnel wants a worklight beam that has no opinion
    // about the hour (lux), and both are different from "tint the sun".
    //
    //   color | kelvin   tint. Never implies anything about when it is on.
    //   lux              fixed irradiance in the pool -> this is a FIXTURE, so
    //                    it stops tracking the sun.
    //   always           same, without pinning the level.
    //
    // Levels 1 and 2 publish none of them, so both keep the solar path exactly.
    var scol = null;
    if (def.color && def.color.isColor) scol = def.color.clone();
    else if (typeof def.color === 'number') scol = new THREE.Color(def.color);
    else if (isFinite(def.kelvin)) scol = GAME.Color.kelvin(def.kelvin, new THREE.Color());
    return {
      kind: def.kind || 'shaft',
      strength: isFinite(def.strength) ? M.clamp(def.strength, 0, 2) : 1,
      width: width,
      len: len,
      color: scol,
      lux: isFinite(def.lux) ? M.clamp(def.lux, 0, 60) : null,
      always: !!def.always || isFinite(def.lux),
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

  // ==========================================================================
  // THE PRACTICAL BEAM CONE  (levels 3-10)
  //
  // A shaft solver that only traces DOWN cannot express a headlight. Kirovsk
  // Pass publishes four truck headlights - 230 cd, 3150 K, 42 m reach, a 0.30
  // rad reflector with an explicit aimPos - pointed along the carriageway in a
  // blizzard, and correctly declines to publish them as lightShafts because a
  // shaft is a vertical aperture and a headlight is horizontal. The result was
  // measurable: the road under the lead truck came back R-B = -0.027, i.e.
  // COOLER than neutral, with no pool, no falloff gradient and no scatter halo,
  // and the lamps themselves rendered as flat beige rectangles at L 0.66-0.71.
  // The strongest sources in the level deposited nothing the eye could find.
  //
  // The lamps were never broken - probed against the live rig they are genuine
  // SpotLights at 228 cd with decay 2 and the authored 0.30 cone. The missing
  // thing is that in a whiteout you do not see the pool, you see the BEAM: a
  // horizontal reflector in dense participating media is a solid object made of
  // scattered light, and it is simultaneously the depth cue, the warm/cool
  // split and the composition anchor a whiteout has no other way to get.
  //
  // So the harbor's volumetric shell - already proven on twenty mast beams in a
  // downpour, and already written to terminate on its own pool via the depth
  // test - is generalised to an ARBITRARY AXIS and offered to any declarative
  // level. A practical gets one by declaring `beam: 0..1.4` alongside its cone
  // and aimPos. That is the whole gate:
  //
  //   level.practicalLights.push({ ..., cone: 0.30, aimPos: [x,y,z], beam: 1.0 })
  //
  // Amplitude then scales with the level's own fogDensity, so the same `beam: 1`
  // is a solid shaft in a blizzard and a faint haze in clear air.
  //
  // ---- IT IS EXPLICIT, AND THAT IS A MEASUREMENT, NOT CAUTION ---------------
  // The first version selected automatically: cone + aimPos, a narrow reflector,
  // a substantially horizontal axis, and enough fog to scatter. Probed across
  // the roster that gate picked out exactly the four Kirovsk headlights and
  // nothing else, which looked like precisely the right shape - and it made the
  // level measurably worse. Kirovsk's hero1 standpoint is ON the carriageway the
  // near truck is lighting, so two of its four shells reach THROUGH the eye, and
  // a cone seen from inside is not a beam, it is a veil: grade_split inverted
  // from +0.0216 to -0.0413 (warm light landing in the shadows, which is the
  // grade running backwards), flat area went 32.8% -> 44.1% and textured
  // 14.2% -> 10.1%. The capability was not wrong; deciding FOR the level where
  // its beams should be was. A beam is a composition element, and only the level
  // knows whether a given lamp throws across its framing or down the player's
  // own line of sight.
  //
  // beamEyeFade below is the other half of that lesson and is kept regardless:
  // even an explicitly requested beam has to dissolve when the player walks into
  // it.
  // ==========================================================================
  var BEAM_MIN_FOG = 0.004;    // clear air - the floor of the scatter scale
  var BEAM_REF_FOG = 0.026;    // a blizzard - where the scatter scale saturates
  var BEAM_MAX = 6;            // shells - the same order as the harbor's hero set
  // Additive amplitude at gain 1, at BEAM_REF metres. FIVE TIMES the harbor's
  // equivalent, and the reason is the background it has to be seen against
  // rather than a difference of taste: a mast cone in Cold Harbor is read
  // against a 02:00 apron at ~0.05 linear, and a headlight in Kirovsk Pass is
  // read against a whiteout at ~0.26. At the harbor's amplitude the four
  // Kirovsk shells measured +0.002 mean and +0.027 sRGB at their single
  // brightest pixel over the whole frame - present in the scene graph,
  // invisible in the image, which is the same defect as not building them.
  var BEAM_BASE = 0.20;
  var BEAM_NEAR = 8.0;         // metres before the distance term starts
  var BEAM_FALL = 30.0;        // ... and its half-value distance beyond that
  var BEAM_REF = 14.0;         // the range the authored brightness refers to
  // Ceiling on the summed screen contribution of every shell. Expressed in the
  // same units as the shell amplitude itself (the weight below folds `base` in)
  // so that retuning BEAM_BASE cannot silently retune the cap with it - which is
  // exactly the trap the harbor's version leaves open, where the cap is a pure
  // geometry sum and only means anything at the base it was measured at.
  var BEAM_CAP = 0.62;

  // The density of whatever is in the air, preferring the weather system's own
  // number (it owns the contract) and falling back to the sky's effective fog
  // and then to the scene's. Returns 0 when nothing publishes one.
  Lighting.prototype._airDensity = function (ctx) {
    var w = ctx && ctx.weather;
    if (w && isFinite(w.fogDensity) && w.fogDensity > 0) return w.fogDensity;
    var sky = ctx && ctx.sky;
    if (sky && isFinite(sky.fogDensityEffective) && sky.fogDensityEffective > 0) {
      return sky.fogDensityEffective;
    }
    if (ctx && ctx.scene && ctx.scene.fog && isFinite(ctx.scene.fog.density)) {
      return ctx.scene.fog.density;
    }
    return 0;
  };

  Lighting.prototype._buildRigBeams = function (ctx) {
    if (this._beams || !this._declarative) return;
    this._beams = [];
    try {
      var fog = this._airDensity(ctx);
      var auto = M.clamp((fog - BEAM_MIN_FOG) / (BEAM_REF_FOG - BEAM_MIN_FOG), 0, 1);
      for (var i = 0; i < this.practicals.length && this._beams.length < BEAM_MAX; i++) {
        var p = this.practicals[i];
        var L = p.light;
        if (!L || !L.isSpotLight || !L.target) continue;
        // Read the FINAL position and target: _anchorPracticals and
        // _clampPracticals both run before this, and a shell built off the
        // authored coordinates would hang in the air beside its own lamp.
        var ax = new THREE.Vector3().copy(L.target.position).sub(L.position);
        var aimLen = ax.length();
        if (!(aimLen > 0.6)) continue;
        ax.multiplyScalar(1 / aimLen);

        // The level's explicit request, scaled by how much there is in the air
        // to scatter off. `auto` is 1 in a blizzard, ~0.25 in clear air, so the
        // same authored number means "as visible as this level's weather
        // allows" rather than a fixed brightness.
        if (p.beam == null) continue;
        var gain = p.beam * (0.25 + 0.75 * auto);
        if (!(gain > 0.01)) continue;

        // Overshoot the aim point so the shell's open far end is buried in
        // whatever it is pointed at and the depth test removes it - the beam
        // then terminates ON its pool instead of stopping in mid-air with a
        // rim. Never past the lamp's own reach, or it outruns its own light.
        var len = M.clamp(Math.min(aimLen + 1.6, (p.distance || 10) * 0.92), 1.5, 60);
        var r1 = Math.max(len * Math.tan(M.clamp(L.angle, 0.10, 1.05)) * 0.92, 0.35);
        var r0 = Math.max((p.bulbR != null ? p.bulbR : 0.12) * 1.8, 0.10);
        var apex = new THREE.Vector3().copy(L.position).addScaledVector(ax, 0.10);
        var geo = buildBeamGeometry(apex, ax, len, r0, r1, 18, 12);
        var mesh = new THREE.Mesh(geo, makeBeamMaterial());
        mesh.name = 'rigBeam_' + (L.name || i);
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 4;
        mesh.visible = false;
        this.root.add(mesh);
        this._beams.push({
          mesh: mesh, p: p, gain: gain, axis: ax,
          apex: apex, len: len, r0: r0, r1: r1,
          mid: new THREE.Vector3(
            apex.x + ax.x * len * 0.45,
            apex.y + ax.y * len * 0.45,
            apex.z + ax.z * len * 0.45),
          area: r1 * len
        });
      }
    } catch (e) {
      GAME.logError('lighting.rigBeams', e);
    }
  };

  // How much of a shell survives, given where the eye is. A cone is a SHAPE
  // seen from outside it and a featureless wash seen from inside it, and a
  // horizontal beam is the case where the eye routinely ends up inside: the
  // Kirovsk headlights throw 22 m down the carriageway the player is standing
  // on, so the near truck's shells reach past the camera and its whole
  // right-hand third came back as an unshaped warm veil over the snowbank -
  // measurably (+12/255 mean over a 32x32 block) and with no beam anywhere in
  // it. Fading a shell out as the eye crosses into it is also the honest
  // answer: you cannot see the beam you are standing in.
  //
  // Returns 1 well outside the cone, 0 inside it, smoothly across the shell
  // wall - so walking into a beam dissolves it instead of switching it off.
  function beamEyeFade(c, cam) {
    if (!cam || !c.apex) return 1;
    var dx = cam.x - c.apex.x, dy = cam.y - c.apex.y, dz = cam.z - c.apex.z;
    var t = dx * c.axis.x + dy * c.axis.y + dz * c.axis.z;
    // Behind the lamp or past the far end: the eye is not in the volume at all.
    // A little slack past each end, because the shell has width there too.
    if (t < -1.0 || t > c.len + 1.0) return 1;
    var ct = M.clamp(t, 0, c.len);
    var px = dx - c.axis.x * ct, py = dy - c.axis.y * ct, pz = dz - c.axis.z * ct;
    var perp = Math.sqrt(px * px + py * py + pz * pz);
    var rad = c.r0 + (c.r1 - c.r0) * (c.len > 1e-4 ? ct / c.len : 0);
    return M.smoothstep(rad * 1.20, rad * 3.40, perp);
  }

  Lighting.prototype._updateRigBeams = function (ctx) {
    var list = this._beams;
    if (!list || !list.length) return;
    var i, c, p, lit;
    var fk = M.clamp(this._airDensity(ctx) || 0.006, 0.003, 0.035);
    var w = ctx && ctx.weather;
    var precip = (w && isFinite(w.precipIntensity)) ? M.clamp(w.precipIntensity, 0, 1)
      : ((w && isFinite(w.rainIntensity)) ? M.clamp(w.rainIntensity, 0, 1) : 0);
    // More scatterers in the air, more of the beam visible side-on.
    var base = BEAM_BASE * (1 + M.clamp(fk * 24.0, 0, 0.75));
    // Normalise the shader's own attenuation at BEAM_REF so the amplitude keeps
    // meaning "this bright when the beam is a subject in the near-middle
    // ground", instead of every beam in the level simply getting dimmer as the
    // weather thickens.
    var fr = fk * BEAM_REF;
    var attRef = (BEAM_FALL / (BEAM_FALL + Math.max(BEAM_REF - BEAM_NEAR, 0))) *
      Math.exp(-fr * fr);
    base /= Math.max(attRef, 0.25);

    // The same accumulation cap the harbor needed, and for the same reason:
    // additive blending has no saturation in it, so four shells seen end-on
    // sum until the frame is a milky veil. Each shell's expected screen
    // contribution is estimated on the CPU and, if the total is over budget,
    // every shell is scaled by the SAME factor - the relative brightness the
    // eye actually reads is unchanged, only the total is bounded.
    var camP = ctx && ctx.camera && ctx.camera.position;
    var fwd = (ctx && ctx.camera && ctx.camera.getWorldDirection)
      ? ctx.camera.getWorldDirection(_v6) : null;
    var sum = 0;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      p = c.p;
      lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2);
      c.fade = beamEyeFade(c, camP);
      lit *= c.fade;
      if (!camP || !p.light.visible || !(lit > 0)) continue;
      var dx = c.mid.x - camP.x, dy = c.mid.y - camP.y, dz = c.mid.z - camP.z;
      var md = Math.sqrt(dx * dx + dy * dy + dz * dz);
      var front = fwd ? (dx * fwd.x + dy * fwd.y + dz * fwd.z) : md;
      if (!(md > 1e-3) || front <= 0) continue;
      var fkd = fk * md;
      var wgt = base * c.gain * lit * (c.area || 1) / (md * md) *
        (BEAM_FALL / (BEAM_FALL + Math.max(md - BEAM_NEAR, 0))) *
        Math.exp(-fkd * fkd);
      var aln = Math.abs((dx * c.axis.x + dy * c.axis.y + dz * c.axis.z) / md);
      sum += wgt * (0.35 + 0.85 * aln);
    }
    var scale = sum > BEAM_CAP ? BEAM_CAP / sum : 1;
    if (!isFinite(scale)) scale = 1;

    for (i = 0; i < list.length; i++) {
      c = list[i];
      p = c.p;
      lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2) *
        (c.fade != null ? c.fade : 1);
      var u = c.mesh.material.uniforms;
      // Colour and level track the LIGHT, so a guttering lamp's beam gutters
      // with it. A beam that keeps burning while its lamp drops out is the
      // give-away that the volumetrics are a decal.
      u.uColor.value.copy(p.light.color);
      u.uAmt.value = p.light.visible ? base * c.gain * lit * scale : 0;
      u.uTime.value = this._t;
      u.uRain.value = precip;
      u.uAtten.value.set(BEAM_NEAR, BEAM_FALL, fk);
      c.mesh.visible = u.uAmt.value > 0.002;
    }
  };

  Lighting.prototype._updateShafts = function (ctx) {
    var list = this._shafts;
    if (!list || !list.length) return;
    // Purely a daylight effect: after sundown there is no sun to make a shaft
    // of, and leaving one lit is the single most obvious "the lighting does not
    // know what time it is" tell there is.
    var amt = this.dayFactor * M.saturate(1 - this.duskFactor * 0.75);
    // ---- COLD HARBOR ------------------------------------------------------
    // There is no sun to make a shaft of, so a harbor shaft is not solar: it is
    // the mercury flood outside spilling through the hole in the warehouse roof
    // - which is exactly the framing ART_DIRECTION_HARBOR describes ("pooled
    // water under a hole in the roof with rain coming through and a shaft of
    // light"). It is therefore always on, cold, and driven off a fixed
    // irradiance budget instead of off a key that spends most of its life at 0.
    var harbor = this.isHarbor;
    var hRain = 0.85;
    if (harbor) {
      amt = 1;
      var hw = this.ctx && this.ctx.weather;
      if (hw && isFinite(hw.rainIntensity)) hRain = M.clamp(hw.rainIntensity, 0, 1);
      _c1.copy(HPAL.mercury).lerp(HPAL.lightning, 0.55 * this.flash);
    }
    // ---- declarative levels ------------------------------------------------
    // Two corrections, both gated so neither level 1 nor level 2 can see them.
    //
    // First: on a 'practicals' or interior rig there is no sun, so `amt` is 0
    // and every published shaft would be switched off - which is the whole
    // atmosphere of a metro tunnel or a bunker gallery deleted by a day/night
    // test that has no meaning underground.
    //
    // Second: on a 'mixed' rig the sun is low by design, and gating a shaft on
    // dayFactor would fade out precisely the raking beams the level exists for.
    // A shaft there tracks the key it is actually made of, floored so a dusk
    // preset still throws one.
    var decl = this._declarative;
    var declKey = decl ? ((this._rigP && isFinite(this._rigP.key)) ? this._rigP.key : 1) : 1;
    if (decl && declKey > 0 && declKey < 1) {
      amt = Math.max(amt, 0.55 * M.saturate(this.dayFactor + this.duskFactor));
    }
    for (var i = 0; i < list.length; i++) {
      var sh = list[i];
      var d = sh.def;
      var on = amt * d.strength;
      // A shaft that declared itself a FIXTURE - a worklight down a tunnel, a
      // flare stack, a flood through steam - has no opinion about the hour, and
      // carries its own irradiance budget instead of a share of the sun's.
      // Spot intensity is candela, so the budget still has to carry the
      // r-squared the inverse-square falloff is about to take back out.
      if (decl && d.always) {
        on = d.strength;
        _c2.copy(d.color || this.keyColor);
        // Without an explicit `lux`, fall back to the key at a solar shaft's own
        // gain, floored so a fixture shaft on a sunless level still exists.
        var dlux = (d.lux != null) ? d.lux
          : Math.max(1.6, this.keyIntensity * SHAFT_GAIN);
        sh.light.intensity = dlux * d.len * d.len * on;
        sh.light.color.copy(_c2);
        sh.light.visible = on > 0.02;
        if (sh.haze) {
          sh.haze.visible = on > 0.02;
          sh.haze.material.uniforms.uColor.value.copy(_c2);
          sh.haze.material.uniforms.uAmt.value =
            M.clamp(dlux * SHAFT_HAZE, 0, 1.1) * on;
        }
        continue;
      }
      // A solar shaft may still carry a tint - a dawn temple wants a warm beam
      // that is nevertheless still gated on the sun being up.
      if (decl && d.color) {
        sh.light.intensity = this.keyIntensity * d.len * d.len * SHAFT_GAIN * on;
        sh.light.color.copy(d.color);
        sh.light.visible = on > 0.02;
        if (sh.haze) {
          sh.haze.visible = on > 0.02;
          sh.haze.material.uniforms.uColor.value.copy(d.color);
          sh.haze.material.uniforms.uAmt.value =
            M.clamp(this.keyIntensity * SHAFT_HAZE, 0, 1.1) * on;
        }
        continue;
      }
      if (harbor) {
        sh.light.intensity = HB.shaftLux * d.len * d.len * on;
        sh.light.color.copy(_c1);
      } else {
        sh.light.intensity = this.keyIntensity * d.len * d.len * SHAFT_GAIN * on;
        sh.light.color.copy(this.keyColor);
      }
      sh.light.visible = on > 0.02;
      if (sh.haze) {
        sh.haze.visible = on > 0.02;
        if (harbor) {
          sh.haze.material.uniforms.uColor.value.copy(_c1);
          sh.haze.material.uniforms.uAmt.value =
            HB.shaftHaze * (0.55 + 0.75 * hRain) * on;
        } else {
          sh.haze.material.uniforms.uColor.value.copy(this.keyColor);
          sh.haze.material.uniforms.uAmt.value =
            M.clamp(this.keyIntensity * SHAFT_HAZE, 0, 1.1) * on;
        }
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

  // ==========================================================================
  // COLD HARBOR - the rig
  // ==========================================================================

  // ---- the volumetric lamp cone --------------------------------------------
  // ART_DIRECTION_HARBOR: "The light cone through rain is the single most
  // important effect in this level. A mast lamp with no visible volumetric cone
  // in a downpour is a fail."
  //
  // There is no depth texture available to this module for a soft-particle
  // term: postfx renders the scene INTO the target whose depth attachment
  // would have to be sampled, and reading a bound depth attachment in the same
  // pass is a feedback loop, not an optimisation problem. What replaces it is
  // (a) an ordinary depth TEST - the shell is transparent with depthWrite off,
  // so it draws after the opaque pass and is clipped by whatever geometry is in
  // front of it - and (b) building the shell so that its open far end is buried
  // BELOW the apron, where that same depth test removes it. The result is the
  // thing a soft particle buys, a beam that terminates on the surface it
  // reaches, without the plumbing.
  //
  // The cone itself is an ADDITIVE SHELL whose opacity is
  // |N.V| raised to a power: a cone is optically thickest along the view ray at
  // its own centreline and vanishes exactly at its silhouette, which is the
  // cheap approximation that gives a beam with no hard edge anywhere. Both ends
  // of the shell are taken to zero in the vertex attribute, because a cone that
  // starts or stops at a finite brightness draws its own rim and a visible rim
  // turns a beam back into a cone-shaped object.
  var BEAM_VERT = [
    'attribute float aGlow;',
    'varying float vGlow;',
    'varying vec3 vN;',
    'varying vec3 vV;',
    'varying vec3 vW;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4( position, 1.0 );',
    '  vec4 mv = viewMatrix * wp;',
    '  vN = normalMatrix * normal;',
    '  vV = - mv.xyz;',
    '  vW = wp.xyz;',
    '  vGlow = aGlow;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var BEAM_FRAG = [
    'uniform vec3 uColor;',
    'uniform float uAmt;',
    'uniform float uTime;',
    'uniform float uRain;',
    'uniform vec3 uAtten;',   // x = near distance, y = falloff scale, z = fog k
    'varying float vGlow;',
    'varying vec3 vN;',
    'varying vec3 vV;',
    'varying vec3 vW;',
    'void main() {',
    '  // |N.V| is the optical path through the shell: 1 down the centreline,',
    '  // 0 exactly at the silhouette. The exponent is what decides whether the',
    '  // beam has a bright core with air around it (high) or is a flat wedge',
    '  // with a rim (low). 1.45 printed as cardboard.',
    '  float f = abs( dot( normalize( vN ), normalize( vV ) ) );',
    '  f = f * f; f = f * f * ( 0.35 + 0.65 * f );',
    '  // Rain falling THROUGH the beam. Two incommensurate vertical frequencies',
    '  // sheared by world x/z, so it never settles into a repeating band and it',
    '  // reads as falling water rather than as a scrolling texture.',
    '  float r = sin( vW.y * 4.7 - uTime * 12.0 + vW.x * 2.3 ) * 0.5 +',
    '            sin( vW.y * 9.3 - uTime * 19.0 + vW.z * 3.1 ) * 0.5;',
    '  float shimmer = 1.0 + uRain * 0.16 * r;',
    '  // Gusts crossing the beam. Without this the cone has a mathematically',
    '  // straight silhouette, which is the one thing no real beam in weather',
    '  // has; the modulation runs across the beam, not along it, so it reads',
    '  // as rain density rather than as a scrolling texture.',
    '  float gust = 0.82 + 0.18 * sin( vW.x * 1.9 + vW.z * 2.4 - uTime * 1.3 ) *',
    '               ( 0.5 + 0.5 * sin( vW.x * 4.3 - vW.z * 3.1 + uTime * 0.7 ) );',
    '  // ---- what the eye actually receives from this much air ---------------',
    '  // Scattered light obeys the same extinction law as reflected light, and',
    '  // this shell used to ignore both terms: a cone 60 m away was billed',
    '  // exactly like one 8 m away, with no transmittance and no tone curve',
    '  // between it and the HDR buffer. From an elevated wide shot the camera',
    '  // looks down the AXIS of many cones at once - the |N.V| maximum - and',
    '  // ~19 shells summed into a flat milky veil over the whole midground.',
    '  //   uAtten.z is the SAME fog density the surfaces get from sky.js, in',
    '  //   the same exp( -(d*k)^2 ) law, so a beam and the wall behind it fade',
    '  //   together instead of the beam floating in front of it;',
    '  //   uAtten.x/y are the geometric term - a distant cone subtends less of',
    '  //   the pixel, so it deposits less radiance in it.',
    '  // Both are normalised on the CPU at HB.coneRef metres, so the hero beams',
    '  // keep the brightness they were tuned to and only the far field pays.',
    '  float dCam = length( vW - cameraPosition );',
    '  float fk = uAtten.z * dCam;',
    '  float atten = ( uAtten.y / ( uAtten.y + max( dCam - uAtten.x, 0.0 ) ) ) *',
    '                exp( - fk * fk );',
    '  gl_FragColor = vec4( uColor * ( uAmt * vGlow * f * shimmer * gust * atten ), 1.0 );',
    '}'
  ].join('\n');

  function makeBeamMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 1, 1) },
        uAmt: { value: 0 },
        uTime: { value: 0 },
        uRain: { value: 1 },
        uAtten: { value: new THREE.Vector3(HB.coneNear, HB.coneFall, 0.010) }
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      // `fog: false` stays: three's fog chunk would MIX toward the fog colour,
      // which on an additive pass means adding grey haze on top of the beam.
      // The transmittance above is the correct operator for an emissive volume
      // and it is applied to the beam's own energy, not blended over it.
      fog: false
    });
  }

  // Open truncated cone, built directly in WORLD space with an identity object
  // transform - the lamps never move, so there is no reason to carry one.
  function buildBeamGeometry(apex, dir, len, r0, r1, seg, ring) {
    var ax = dir.clone().normalize();
    var up = Math.abs(ax.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    var u = new THREE.Vector3().crossVectors(up, ax).normalize();
    var v = new THREE.Vector3().crossVectors(ax, u).normalize();
    var pos = new Float32Array(seg * ring * 3);
    var nrm = new Float32Array(seg * ring * 3);
    var glow = new Float32Array(seg * ring);
    var idx = [];
    var j, i;
    for (j = 0; j < ring; j++) {
      var t = j / (ring - 1);
      var rr = r0 + (r1 - r0) * t;
      var cx = apex.x + ax.x * len * t;
      var cy = apex.y + ax.y * len * t;
      var cz = apex.z + ax.z * len * t;
      // Brightest just under the lens and falling away: the beam is spreading
      // over t^2 of area while the scatterers thin out, so a linear taper is
      // far too flat and prints as a solid wedge.
      //
      // ---- BUT IT HAS TO REACH THE GROUND ----------------------------------
      // This used to be `(1 - smoothstep(0.62, 1.0, t)) / (1 + 2.6t)`, which is
      // ZERO over the last 38% of the drop and already down to 38% of the apex
      // value where the fade begins. On an 11.5 m mast that put the end of the
      // visible glow 4-5 m above its own pool: grey haze columns hanging in
      // mid-air with dark ground underneath them and lamp heads that read as
      // bright objects with nothing below them. ART_DIRECTION_HARBOR calls a
      // mast lamp with no visible cone an instant fail and separately forbids
      // "cones of fog"; that managed to be both at once.
      //
      // The taper is now mild all the way down (0.45 of apex at the far end
      // before the 1/(1+1.4t) spread term), and the shell itself is built ~1.3 m
      // PAST the aim point by _buildHarborCones, so its open far end is buried
      // under the apron and clipped by the depth test. The beam therefore
      // terminates exactly on the ellipse where it meets the ground - the same
      // ellipse the pool edge is on, because both are built from _coneVis - and
      // there is no rim anywhere. The last 12% still fades to zero for the
      // lamps whose aim point is NOT the floor (the raking floods), where the
      // far end really is in open air.
      var g = M.smoothstep(0.0, 0.07, t) * (1 - M.smoothstep(0.88, 1.0, t)) *
        M.lerp(1.0, 0.45, t) / (1 + 1.4 * t);
      for (i = 0; i < seg; i++) {
        var a = i / seg * Math.PI * 2;
        var ca = Math.cos(a), sa = Math.sin(a);
        var nx = u.x * ca + v.x * sa;
        var ny = u.y * ca + v.y * sa;
        var nz = u.z * ca + v.z * sa;
        var o = (j * seg + i) * 3;
        pos[o] = cx + nx * rr; pos[o + 1] = cy + ny * rr; pos[o + 2] = cz + nz * rr;
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        glow[j * seg + i] = g;
      }
    }
    for (var j2 = 0; j2 < ring - 1; j2++) {
      for (var i2 = 0; i2 < seg; i2++) {
        var a0 = j2 * seg + i2, b0 = j2 * seg + ((i2 + 1) % seg);
        idx.push(a0, b0, a0 + seg, b0, b0 + seg, a0 + seg);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    return geo;
  }

  // --------------------------------------------------------------------------
  // Where the level actually is. Nothing below assumes a coordinate: the frame
  // is read from level.bounds and the ground from the player spawn, with a
  // 90 x 70 m fallback taken from ART_DIRECTION_HARBOR for a level that failed
  // to build at all (a missing level must dim the rig, not crash it).
  // --------------------------------------------------------------------------
  Lighting.prototype._harborFrame = function (ctx) {
    var lvl = ctx && ctx.level;
    var b = lvl && lvl.bounds;
    var F = { minX: -45, maxX: 45, minZ: -40, maxZ: 30, gy: 0 };
    if (b && b.min && b.max) {
      if (isFinite(b.min.x) && isFinite(b.max.x) && b.max.x - b.min.x > 8) {
        F.minX = b.min.x; F.maxX = b.max.x;
      }
      if (isFinite(b.min.z) && isFinite(b.max.z) && b.max.z - b.min.z > 8) {
        F.minZ = b.min.z; F.maxZ = b.max.z;
      }
    }
    var sp = lvl && lvl.spawnPoints && lvl.spawnPoints[0];
    if (sp && sp.position && isFinite(sp.position.y)) F.gy = sp.position.y;
    else if (b && b.min && isFinite(b.min.y)) F.gy = b.min.y + 1;
    F.w = F.maxX - F.minX;
    F.d = F.maxZ - F.minZ;
    F.cx = (F.minX + F.maxX) * 0.5;
    F.cz = (F.minZ + F.maxZ) * 0.5;
    return F;
  };

  // Resolve a pose-relative placement into world space, and hand back the pose
  // basis so the aim can be solved in the same frame of reference.
  Lighting.prototype._harborResolve = function (ctx, def, forceFallback) {
    var F = this._harborF;
    var poses = ctx && ctx.level && ctx.level.cameraPoses;
    var p = (poses && def.pose && !forceFallback) ? poses[def.pose] : null;
    var out = {
      pos: new THREE.Vector3(), fx: 0, fz: -1, rx: 1, rz: 0,
      pose: false, eye: null
    };
    if (p && p.position && isFinite(p.position.x) && isFinite(p.position.z)) {
      // forward for yaw t is ( -sin t, 0, -cos t ) - the convention every pose
      // in this build is authored in - and right is ( -fz, 0, fx ).
      var yaw = isFinite(p.yaw) ? p.yaw : 0;
      var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      out.fx = fx; out.fz = fz; out.rx = -fz; out.rz = fx;
      out.pose = true;
      out.eye = p.position;
      out.pos.set(
        p.position.x + fx * (def.f || 0) + out.rx * (def.r || 0),
        def.fromPose ? (p.position.y + (def.y || 0)) : (F.gy + (def.y || 0)),
        p.position.z + fz * (def.f || 0) + out.rz * (def.r || 0));
      return out;
    }
    // No such pose: fall back to normalised level-bounds coordinates and face
    // the middle of the terminal.
    var fb = def.fb || [0.5, 0.5];
    out.pos.set(F.minX + fb[0] * F.w,
      F.gy + (def.fbY != null ? def.fbY : (def.y || 0)),
      F.minZ + fb[1] * F.d);
    var dx = F.cx - out.pos.x, dz = F.cz - out.pos.z;
    var dl = Math.sqrt(dx * dx + dz * dz);
    if (dl > 1e-3) { out.fx = dx / dl; out.fz = dz / dl; out.rx = -out.fz; out.rz = out.fx; }
    return out;
  };

  // Where a lamp throws. Extracted from _harborLampDefs so the pose-offset guard
  // can preview exactly the answer the rig is about to use instead of
  // approximating it - a guard that checks a different point from the one that
  // ships is worse than no guard.
  Lighting.prototype._harborAim = function (d, R, anchors, out) {
    var F = this._harborF;
    var pos = R.pos;
    var ad = isFinite(d.aimDist) ? d.aimDist : 8;
    var ax, az, ay = F.gy;
    var aimA = (d.aimAnchor && anchors) ? anchors[d.aimAnchor] : null;
    if (aimA && isFinite(aimA.x)) {
      // Aimed at a GEOMETRY-DERIVED point, the same way it is mounted at one.
      // This is the only aim mode that survives the level moving: a crane flood
      // aimed down its own lane stays aimed down its own lane.
      ax = aimA.x; ay = aimA.y; az = aimA.z;
    } else if (d.aim === 'poseForward') {
      ax = pos.x + R.fx * ad; az = pos.z + R.fz * ad;
    } else if (d.aim === 'poseBack') {
      ax = pos.x - R.fx * ad; az = pos.z - R.fz * ad;
    } else if (d.aimPos && d.aimPos.length === 3) {
      ax = d.aimPos[0]; ay = d.aimPos[1]; az = d.aimPos[2];
    } else {
      // A working mast lamp leans in over the area it is there to light.
      var tx = F.cx - pos.x, tz = F.cz - pos.z;
      var tl = Math.sqrt(tx * tx + tz * tz);
      var tilt = isFinite(d.tilt) ? d.tilt : 0;
      ax = pos.x + (tl > 1e-3 ? tx / tl * tilt : 0);
      az = pos.z + (tl > 1e-3 ? tz / tl * tilt : 0);
    }
    if (!(ay < pos.y - 0.4)) ay = pos.y - 2.0;   // never aim up
    return out.set(ax, ay, az);
  };

  // Is a world point inside the frustum of one of the level's published camera
  // poses? Used by the pose-offset guard. Returns TRUE when it cannot tell (no
  // such pose, no camera) - a guard that fires on missing information would
  // relocate every lamp in the level the first time a pose was renamed.
  //
  // The margins are deliberately tighter than the frustum: a pool 1 px inside
  // the bottom edge is in the frame and still invisible, because the viewmodel
  // occupies the bottom fifth of every first-person framing.
  Lighting.prototype._poseSees = function (ctx, poseName, pt) {
    var poses = ctx && ctx.level && ctx.level.cameraPoses;
    var p = (poses && poseName) ? poses[poseName] : null;
    if (!p || !p.position || !isFinite(p.position.x) || !pt) return true;
    var cam = ctx.camera;
    var fovY = (cam && isFinite(cam.fov) && cam.fov > 5) ? cam.fov : 70;
    var asp = (cam && isFinite(cam.aspect) && cam.aspect > 0.2) ? cam.aspect : 16 / 9;
    var yaw = isFinite(p.yaw) ? p.yaw : 0;
    var pitch = isFinite(p.pitch) ? p.pitch : 0;
    var sy = Math.sin(yaw), cyw = Math.cos(yaw);
    var sp = Math.sin(pitch), cp = Math.cos(pitch);
    // forward for yaw t is ( -sin t, 0, -cos t ), pitched about the right axis.
    var fX = -sy * cp, fY = sp, fZ = -cyw * cp;
    var rX = cyw, rZ = -sy;                       // right = cross( forward, up )
    var uX = sy * sp, uY = cp, uZ = cyw * sp;     // up    = cross( right, forward )
    var dx = pt.x - p.position.x, dy = pt.y - p.position.y, dz = pt.z - p.position.z;
    var zf = dx * fX + dy * fY + dz * fZ;
    if (!(zf > 0.5)) return false;                // behind the camera
    var th = Math.tan(fovY * 0.5 * M.DEG);
    if (!(th > 1e-4)) return true;
    var ny = (dx * uX + dy * uY + dz * uZ) / zf / th;
    var nx = (dx * rX + dz * rZ) / zf / (th * asp);
    return Math.abs(nx) <= 0.92 && Math.abs(ny) <= 0.78;
  };

  // --------------------------------------------------------------------------
  // Build the harbor lamp definition list.
  //
  // PRECEDENCE, and why. level_harbor.js knows where its own containers are and
  // this module does not, so anything it publishes wins:
  //   1. level.practicalLights / level.mastLamps - full override (the documented
  //      cross-module contract, already honoured for level 1).
  //   2. level.lightShafts entries flagged { lamp: true } or kind 'lamp'/'mast'
  //      - explicit mast positions. Unflagged shaft entries keep their existing
  //      meaning (a real shaft of light, e.g. through the warehouse roof hole)
  //      and are still built by _buildShafts; silently re-purposing a documented
  //      field is exactly how cross-module contracts break.
  //   3. the pose-relative table above.
  // --------------------------------------------------------------------------
  Lighting.prototype._harborLampDefs = function (ctx) {
    var F = this._harborF;
    var lvl = ctx && ctx.level;
    var src = null, fromLevel = false, k;
    if (lvl && Array.isArray(lvl.practicalLights) && lvl.practicalLights.length) {
      src = lvl.practicalLights; fromLevel = true;
    } else if (lvl && Array.isArray(lvl.mastLamps) && lvl.mastLamps.length) {
      src = lvl.mastLamps; fromLevel = true;
    }

    // ---- AUDIT level.lightShafts : every published entry must end up as -----
    // ---- something visible --------------------------------------------------
    // level_harbor.js publishes one lightShafts entry PER MAST as the cone spec
    // for that mast, plus the crane/quay and warehouse shafts. Each mast entry
    // normally pairs with a practicalLights entry at the same head, and in that
    // case it must NOT also become a shaft (a second cone inside the first) or a
    // second lamp - the volumetric cone is built from that SpotLight's own angle
    // further down, so the beam you see and the pool you see can never disagree.
    //
    // The pairing is now VERIFIED rather than assumed. A mast entry with no
    // published lamp within PAIR_R of it is an ORPHAN: the level asked for a
    // lamp there and nothing in the build was making one. Orphans are adopted
    // here and get the full treatment - light, mast fixture, emissive lens, halo
    // and cone. The audit is published in harborDiag so a probing critic can see
    // shafts_published == shafts_paired + shafts_adopted + shafts_asShaft.
    var extra = [];
    var PAIR_R2 = 1.6 * 1.6;
    var shaftsTotal = 0, shaftsPaired = 0, shaftsAdopted = 0;
    this._harborShaftSkip = {};
    if (lvl && Array.isArray(lvl.lightShafts)) {
      for (var s = 0; s < lvl.lightShafts.length; s++) {
        var sd = lvl.lightShafts[s];
        if (!sd || !sd.origin || !isFinite(sd.origin.x)) continue;
        shaftsTotal++;
        // Does the level already run a light at this aperture? Tested for EVERY
        // kind, not just the ones tagged 'mast'. level_harbor publishes its low
        // raking beams as BOTH a practicalLight and a lightShaft at the same
        // origin, and taking the kind tag at face value stood a second, dimmer
        // cone inside the first one - two beams, one lamp, slightly different
        // angles, which reads as a rendering fault rather than as a beam.
        var paired = false;
        if (fromLevel && src) {
          for (var pj = 0; pj < src.length && !paired; pj++) {
            var pd2 = src[pj];
            if (!pd2 || !pd2.pos || !isFinite(pd2.pos[0])) continue;
            var ddx = pd2.pos[0] - sd.origin.x;
            var ddy = pd2.pos[1] - sd.origin.y;
            var ddz = pd2.pos[2] - sd.origin.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= PAIR_R2) paired = true;
          }
        }
        if (paired) { this._harborShaftSkip[s] = 1; shaftsPaired++; continue; }
        // Not paired, and not tagged as a lamp head: it is a real aperture and
        // _buildShafts owns it.
        if (!(sd.lamp === true || sd.kind === 'lamp' || sd.kind === 'mast' ||
              sd.kind === 'mast_lamp')) continue;
        // Tagged as a lamp head with no lamp behind it. The level asked for a
        // fixture here and nothing in the build was making one, so adopt it.
        this._harborShaftSkip[s] = 1;
        shaftsAdopted++;
        extra.push({
          name: sd.name || ('mast_lamp_' + s), kind: 'sodium', fixture: 'mast',
          pos: [sd.origin.x, sd.origin.y, sd.origin.z],
          kelvin: HARBOR_SODIUM_K,
          intensity: isFinite(sd.intensity) ? sd.intensity : 980,
          distance: isFinite(sd.distance) ? sd.distance
            : M.clamp((isFinite(sd.length) ? sd.length : 12) * 3.0, 16, 40),
          // The level publishes the cone as a WIDTH at the floor and a LENGTH,
          // which is a better spec than an angle because it survives the mast
          // being moved. Turn it back into a half-angle.
          cone: isFinite(sd.cone) ? sd.cone
            : (isFinite(sd.width) && isFinite(sd.length) && sd.length > 0.5
              ? M.clamp(Math.atan((sd.width * 0.5) / sd.length) * 2.2, 0.25, 0.7)
              : 0.52),
          penumbra: 0.36, shadow: false,
          tilt: 2.6, halo: 3.4, beam: isFinite(sd.strength) ? sd.strength : 1.0
        });
      }
    }
    this._shaftAudit = {
      published: shaftsTotal, paired: shaftsPaired, adopted: shaftsAdopted
    };

    var table = [];
    for (k = 0; k < extra.length; k++) table.push(extra[k]);
    var base = fromLevel ? src : HARBOR_LAMPS;
    for (k = 0; k < base.length; k++) {
      var bd = base[k];
      if (!bd) continue;
      // The level authored its own masts; do not stack ours on top of them.
      if (extra.length && !fromLevel && bd.fixture === 'mast') continue;
      table.push(bd);
    }
    // A level that publishes its own lamp set publishes the KEY lamps - masts,
    // floods, interiors. It does not publish the small stuff the brief calls
    // for (a freighter deck row, a blinking navigation light, a reefer bank, a
    // vehicle headlight), and those are what stop a terminal from reading as
    // four lamp posts in a car park. They are appended, not substituted, and
    // only up to the practical cap.
    // ORDERED BY `prio`, and that ordering is load-bearing rather than tidy.
    // The cap is a hard cut at the end of the table, so whichever supporting
    // lamps happen to sit last in source order are the ones that silently do
    // not exist - and level_harbor grew from 16 published lamps to 20 during
    // this round, which quietly deleted all three lighting towers and the
    // freighter deck lamp without changing a line in this file. That is exactly
    // how the cold half of the palette went missing: measured over pixels above
    // 0.40 luma the containers framing came back 3.5% cool, and the reason was
    // not the tuning, it was that the cold lamp was not being built at all.
    // Ranking them explicitly means the two that get cut are always the two
    // that matter least, whatever the level publishes next.
    if (fromLevel) {
      var supp = [];
      for (k = 0; k < HARBOR_LAMPS.length; k++) {
        if (HARBOR_LAMPS[k].supp) supp.push(HARBOR_LAMPS[k]);
      }
      supp.sort(function (a, b) {
        return (isFinite(a.prio) ? a.prio : 50) - (isFinite(b.prio) ? b.prio : 50);
      });
      for (k = 0; k < supp.length; k++) table.push(supp[k]);
    }
    // Published in harborDiag so "how many lamps did the cap silently eat" is a
    // number a critic can read instead of a thing that has to be re-derived.
    this._harborWanted = table.length;

    var out = [];
    var cap = this._maxPracticals();
    var upY = new THREE.Vector3(0, 1, 0);
    // Resolved once, off the level as it is right now (see _harborAnchors).
    var anchors = this._harborAnchorMap ||
      (this._harborAnchorMap = this._harborAnchors(ctx));
    for (k = 0; k < table.length && out.length < cap; k++) {
      var d = table[k];
      if (!d) continue;
      // A lamp that names an aim anchor the level does not have this run has
      // nothing to point at, and a big flood pointing at the default (straight
      // down, from 15 m up inside a gantry) is worse than an absent one.
      if (d.aimAnchor &&
          !(anchors && anchors[d.aimAnchor] && isFinite(anchors[d.aimAnchor].x))) continue;
      var R;
      var anch = (d.anchor && anchors) ? anchors[d.anchor] : null;
      if (d.pos && d.pos.length === 3 && isFinite(d.pos[0])) {
        R = { pos: new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]),
              fx: 0, fz: -1, rx: 1, rz: 0, pose: false, eye: null };
        var dxc = F.cx - R.pos.x, dzc = F.cz - R.pos.z;
        var dlc = Math.sqrt(dxc * dxc + dzc * dzc);
        if (dlc > 1e-3) {
          R.fx = dxc / dlc; R.fz = dzc / dlc; R.rx = -R.fz; R.rz = R.fx;
        }
      } else if (anch && isFinite(anch.x)) {
        // A GEOMETRY-DERIVED placement. `nx/nz` points back at the framing this
        // anchor was solved for, so `anchorBack` sets the fixture a little
        // further from the eye than the open-floor point it was found at - a
        // light tower belongs beside the working area, not in the lens.
        var back = d.anchorBack || 0;
        // `anchorSide` steps toward a wall, clamped by the clearance the anchor
        // actually measured, so a lighting tower stands at the edge of the lane
        // rather than in the middle of the shot. A cone is a subject at 15-40 m
        // and a whiteout at 6, and the middle of the lane is where the camera is.
        var side = 0;
        if (d.anchorSide && isFinite(anch.wL) && isFinite(anch.wR)) {
          side = d.anchorSide > 0
            ? Math.min(d.anchorSide, Math.max(0, anch.wR - 0.85))
            : -Math.min(-d.anchorSide, Math.max(0, anch.wL - 0.85));
        }
        var arx = (anch.rx != null) ? anch.rx : -anch.nz;
        var arz = (anch.rz != null) ? anch.rz : anch.nx;
        R = {
          pos: new THREE.Vector3(anch.x - anch.nx * back + arx * side,
            anch.y + (d.anchorY != null ? d.anchorY : 0),
            anch.z - anch.nz * back + arz * side),
          fx: -anch.nx, fz: -anch.nz, rx: anch.nz, rz: -anch.nx,
          pose: true, eye: null
        };
      } else if (d.anchor) {
        // The level does not have this feature this run. A supporting lamp
        // floating where the feature used to be is worse than no lamp.
        continue;
      } else {
        R = this._harborResolve(ctx, d);
        // ---- THE POSE-OFFSET GUARD ------------------------------------------
        // A lamp authored as an offset from a CAMERA POSE and aimed downward
        // works for a framing that looks along the ground and fails for every
        // framing that looks up - and it fails SILENTLY, which is why it stood
        // for a whole round. Measured on the crane framing: it is pitched up 21
        // degrees at 70 degrees vertical FOV, so its horizon sits at ndc
        // y = -0.55 and no point on the apron can reach the middle third at all;
        // the old crane flood - the level's brightest cold source, 1100 cd -
        // landed its pool at ndc y = -0.835, row 660 of 720, underneath the gun
        // and the hands, and the crane capture was the only frame in the level
        // still under the exposure floor.
        //
        // If the aim point falls outside the frustum of the very pose the lamp
        // was authored against, the authoring is wrong for that framing, so fall
        // back to the level-bounds placement rather than shipping a lamp that
        // lights nothing anyone will see. Anchored lamps skip this: they are
        // resolved from geometry and are not claiming to be for a framing.
        if (d.fromPose && R.pose) {
          this._harborAim(d, R, anchors, _v5);
          if (!this._poseSees(ctx, d.pose, _v5)) R = this._harborResolve(ctx, d, true);
        }
      }
      var pos = R.pos;
      if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) continue;

      // ---- colour -----------------------------------------------------------
      // Blackbody first (GAME.Color.kelvin), then pulled onto the art-directed
      // hue. 2000K alone is #ff890e, a shade deeper than the bible's #ff9a3c;
      // 5600K alone is a WARM white, and mercury/LED floods have to read cold
      // against the sodium or the whole two-temperature idea evaporates.
      var col = GAME.Color.kelvin(d.kelvin || 2800, new THREE.Color());
      var kind = d.kind || 'sodium';
      if (kind === 'sodium' || kind === 'sodium_failing') {
        col.lerp(HPAL.sodium, 0.35);
      } else if (kind === 'mercury') {
        col.lerp(HPAL.mercury, 0.80);
      } else if (kind === 'fluoro_cold') {
        col.lerp(HPAL.mercury, 0.55);
        col.multiply(_c1.setRGB(0.94, 1.0, 0.96));   // the sickly fluoro green
      } else if (kind === 'led') {
        col.lerp(HPAL.mercury, 0.38);
      } else if (kind === 'reefer') {
        col.lerp(HPAL.mercury, 0.90);
      } else if (kind === 'nav') {
        col.lerp(_c2.setRGB(0.06, 1.0, 0.42), 0.88);  // starboard green
      } else if (kind === 'fluoro') {
        // A level publishing its own set uses level 1's vocabulary, where
        // 'fluoro' is the only cool kind there is - level_harbor maps its
        // mercury quay flood onto it at 5200K. A pure blackbody at 5200K is a
        // WARM white; the whole 2000K-against-cold idea depends on this half
        // actually reading cold, so it is pulled onto the art-directed
        // #cfe6ff by an amount that scales with how cool it claims to be.
        col.lerp(HPAL.mercury, (d.kelvin || 4200) >= 4800 ? 0.78 : 0.46);
      }

      // ---- aim --------------------------------------------------------------
      var aimPos = null, axis = null, beamLen = 0;
      if (d.cone) {
        this._harborAim(d, R, anchors, _v5);
        aimPos = [_v5.x, _v5.y, _v5.z];
        axis = new THREE.Vector3(_v5.x - pos.x, _v5.y - pos.y, _v5.z - pos.z);
        beamLen = Math.max(axis.length(), 0.5);
        axis.multiplyScalar(1 / beamLen);
      }

      // A level that publishes its own lamps has already built the masts,
      // brackets and lit apertures as level geometry, so this module must NOT
      // stand a second housing on top of them. It still contributes the beam
      // and a live emissive lens, because the level's aperture is a static
      // material and cannot gutter with a failing arc.
      var levelOwned = !!(fromLevel && src && k >= extra.length &&
        k < extra.length + src.length);
      var fixture = levelOwned ? 'none' : (d.fixture || 'none');
      var beamGain = isFinite(d.beam) ? d.beam : (levelOwned && d.cone ? 1.0 : 0);

      // ---- core + skirt ------------------------------------------------------
      // `coneVis` is the authored beam: the bright core, and the angle the
      // volumetric shell is built from so the visible beam and the visible pool
      // agree. `coneLit` opens the SpotLight past it and `penLit` is solved so
      // full output still ends exactly at LAMP_CORE of the authored angle - the
      // pool the level asked for, unchanged, now with a real falloff skirt round
      // it instead of a hard edge and a black yard.
      var coneVis = d.cone || 0;
      var coneLit = coneVis, penLit = d.penumbra != null ? d.penumbra : 0.38;
      if (coneVis > 0) {
        coneLit = M.clamp(
          Math.min(coneVis * HB.lampSkirt, Math.max(coneVis, HB.lampMax)),
          0.15, 1.05);
        // three fades from angle*(1-penumbra) out to angle.
        penLit = M.clamp(1 - (coneVis * HB.lampCore) / coneLit,
          HB.lampPenMin, 0.85);
      }

      var e = {
        name: d.name || ('harbor_lamp_' + k),
        kind: kind,
        pos: [pos.x, pos.y, pos.z],
        color: col,
        kelvin: d.kelvin || 2800,
        intensity: (isFinite(d.intensity) ? d.intensity : 200) *
          (levelOwned ? HB.levelLampGain : 1),
        distance: isFinite(d.distance) ? d.distance : 20,
        dayBase: 1,                     // there is no day here
        cone: coneLit,
        penumbra: penLit,
        aimPos: aimPos,
        shadow: !!d.shadow,
        // Only a lamp this module built a housing for is pinned; a supporting
        // light placed off a camera pose is a guess and _clampPracticals is
        // allowed to push it out of whatever container it landed in.
        fixed: !!(levelOwned || fixture !== 'none'),
        haloScale: isFinite(d.haloScale) ? d.haloScale : HALO_SCALE,
        // A halo is scattering in the air BETWEEN the lamp and the eye, so a
        // fitting at head height a few metres away has almost no air to scatter
        // in - it gets a small tight glow. The mast heads, ten metres up in a
        // downpour, get the big one.
        haloMax: Math.min(isFinite(d.halo) ? d.halo : (levelOwned ? 3.2 : 2.4),
          (pos.y - F.gy) < 3.0 ? 0.85 : 4.0),
        haloGain: isFinite(d.haloGain) ? d.haloGain
          : (kind === 'sodium' || kind === 'sodium_failing' ? 0.55 : 0.34),
        // The visible source. A mast head's is the LENS in the bottom of its
        // reflector - a flattened disc on the beam axis, not a floating pearl.
        // A mast head IS a metre-wide reflector ten metres up and can carry a
        // 40 cm lens; a forklift headlight or a tower head is a small fitting
        // that the framings put 6-10 m from the lens, where a 26 cm emissive
        // sphere prints as a 50 px white ball - the "muzzle flash is a white
        // sphere" tell, applied to a lamp. Sized by what the fitting IS.
        bulbR: axis ? (fixture === 'mast' ? 0.40 : (levelOwned ? 0.23 : 0.145)) : 0.10,
        bulbFlat: axis ? 0.30 : 1,
        bulbAxis: axis ? axis.clone() : null,
        // BULB_GAIN is a RADIANCE, and it was tuned against level 1's 7.5 cm
        // bare bulb. A 26 cm lens has twelve times the area, so carrying the
        // same radiance printed the forklift headlight as a white disc 110 px
        // across in the containers capture. A diffusing lens is also physically
        // dimmer per unit area than the bare arc behind it, so it goes down,
        // not just proportionally down.
        bulbGain: axis ? (fixture === 'mast' ? 0.30 : (levelOwned ? 0.22 : 0.16)) : 0.85,
        _fixture: fixture,
        _beamGain: beamGain,
        _beamLen: beamLen,
        _coneVis: coneVis,
        _axis: axis,
        _lean: axis ? new THREE.Vector3(axis.x, 0, axis.z) : null,
        _up: upY
      };
      if (e._lean) {
        if (e._lean.lengthSq() < 1e-6) e._lean.set(-R.fx, 0, -R.fz);
        e._lean.normalize();
      }
      out.push(e);
    }

    // ---- nominate the hero shadow casters ---------------------------------
    // A level publishing its own lamps has no reason to know that this rig can
    // only afford two shadow-casting practicals, so it nominates none. Pick the
    // spot nearest each hero framing: a shadow the camera never sees is a depth
    // pass spent on nothing.
    var anyShadow = false;
    for (k = 0; k < out.length; k++) if (out[k].shadow) anyShadow = true;
    if (!anyShadow && out.length) {
      var heroNames = ['quay', 'containers'];
      var poses2 = lvl && lvl.cameraPoses;
      var used = {};
      for (var hp = 0; hp < heroNames.length; hp++) {
        var hpp = poses2 && poses2[heroNames[hp]] && poses2[heroNames[hp]].position;
        var bestI = -1, bestScore = Infinity;
        for (k = 0; k < out.length; k++) {
          if (used[k] || !out[k].cone) continue;
          var sc;
          if (hpp && isFinite(hpp.x)) {
            var qx = out[k].pos[0] - hpp.x, qz = out[k].pos[2] - hpp.z;
            sc = qx * qx + qz * qz;
          } else {
            sc = -out[k].intensity;         // no poses: take the brightest
          }
          if (sc < bestScore) { bestScore = sc; bestI = k; }
        }
        if (bestI >= 0) { out[bestI].shadow = true; used[bestI] = 1; }
      }
    }
    return out;
  };

  // --------------------------------------------------------------------------
  // Fixture geometry. Two merged meshes, two draw calls for the whole rig:
  // the POLES cast shadows (a mast throwing a hard bar across its own pool is
  // one of the most recognisable things about a container terminal at night),
  // the HEADS do not - a housing sitting on top of its own spot would shadow-map
  // the entire cone to black.
  // --------------------------------------------------------------------------
  Lighting.prototype._harborMetal = function (ctx) {
    if (this._harborMetalMat) return this._harborMetalMat;
    var names = ['deck_plate', 'painted_metal', 'rusted_metal', 'ship_hull'];
    var m = null;
    var lib = ctx && ctx.materials;
    if (lib && typeof lib.get === 'function') {
      for (var i = 0; i < names.length && !m; i++) {
        try {
          var c = lib.get(names[i], { repeat: [1.6, 1.6] });
          if (c && c.isMaterial) m = c;
        } catch (e) { /* try the next documented name */ }
      }
    }
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: 0x2b3033, roughness: 0.55, metalness: 0.72
      });
      m.name = 'harborLampFallback';
      this._harborOwnMat = m;
    }
    this._harborMetalMat = m;
    return m;
  };

  Lighting.prototype._buildHarborFixtures = function (ctx, defs) {
    if (this._harborFixtures) return;
    var poles = [], heads = [];
    var m = new THREE.Matrix4();
    var q = new THREE.Quaternion();
    var one = new THREE.Vector3(1, 1, 1);
    var upY = new THREE.Vector3(0, 1, 0);
    var F = this._harborF;
    var ARM = 1.55;
    var i;

    for (i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (d._fixture !== 'mast' && d._fixture !== 'flood' && d._fixture !== 'tower') continue;
      var P = new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]);
      var A = d._axis || new THREE.Vector3(0, -1, 0);
      var lean = d._lean || new THREE.Vector3(0, 0, -1);
      // +Y of every housing piece points back UP the beam.
      q.setFromUnitVectors(upY, _v1.copy(A).negate());

      // reflector: a truncated cone, narrow end at the housing, wide end open
      // toward the ground. CylinderGeometry runs +Y (top) to -Y (bottom), and
      // the quaternion above maps -Y onto the beam, so radiusBottom is the mouth.
      var rTop = d._fixture === 'mast' ? 0.22 : 0.16;
      var rBot = d._fixture === 'mast' ? 0.62 : 0.40;
      var rH = d._fixture === 'mast' ? 0.38 : 0.26;
      m.compose(_v2.copy(P).addScaledVector(A, -rH * 0.5 + 0.02), q, one);
      heads.push({ geometry: new THREE.CylinderGeometry(rTop, rBot, rH, 14, 1), matrix: m.clone() });

      // housing above it, and a rim ring around the lens so the emissive disc
      // has a dark bezel to read against instead of floating.
      var hw = d._fixture === 'mast' ? 0.92 : 0.66;
      var hh = d._fixture === 'mast' ? 0.30 : 0.26;
      var hd = d._fixture === 'mast' ? 0.62 : 0.46;
      m.compose(_v2.copy(P).addScaledVector(A, -(rH + hh * 0.5) - 0.01), q, one);
      heads.push({ geometry: GAME.Geo.bevelBox(hw, hh, hd, 0.045), matrix: m.clone() });
      m.compose(_v2.copy(P).addScaledVector(A, -0.02), q, one);
      heads.push({
        geometry: new THREE.CylinderGeometry(rBot * 0.98, rBot * 0.98, 0.07, 14, 1),
        matrix: m.clone()
      });

      if (d._fixture === 'mast') {
        // ---- the mast itself ------------------------------------------------
        // The pole stands BEHIND the head, on the far side from the lean, which
        // is what a real mast lamp does: it stands at the edge of the apron and
        // its bracket arm reaches out over the working area.
        var px = P.x - lean.x * ARM, pz = P.z - lean.z * ARM;
        var top = P.y + 0.55;
        var H = Math.max(top - F.gy, 3.0);
        m.makeTranslation(px, F.gy + H * 0.5, pz);
        poles.push({ geometry: new THREE.CylinderGeometry(0.16, 0.27, H, 10, 1), matrix: m.clone() });
        m.makeTranslation(px, F.gy + 0.16, pz);
        poles.push({ geometry: new THREE.CylinderGeometry(0.46, 0.62, 0.32, 10, 1), matrix: m.clone() });
        // supply cable clipped to the pole - pure silhouette, but a perfectly
        // clean cylinder is one of the tells ARCHITECTURE section 9 lists.
        m.makeTranslation(px + 0.24, F.gy + H * 0.46, pz + 0.06);
        poles.push({ geometry: new THREE.CylinderGeometry(0.045, 0.045, H * 0.9, 5, 1), matrix: m.clone() });
        // bracket arm from the pole head out to the housing
        var yaw = Math.atan2(-lean.z, lean.x);
        q.setFromAxisAngle(upY, yaw);
        m.compose(_v2.set((px + P.x) * 0.5, top - 0.14, (pz + P.z) * 0.5), q, one);
        heads.push({ geometry: new THREE.BoxGeometry(ARM + 0.34, 0.16, 0.16), matrix: m.clone() });
        // gusset under the arm
        m.compose(_v2.set(px + lean.x * 0.45, top - 0.52, pz + lean.z * 0.45), q, one);
        heads.push({ geometry: new THREE.BoxGeometry(0.9, 0.5, 0.09), matrix: m.clone() });
      } else if (d._fixture === 'tower') {
        // ---- a wheeled lighting tower ---------------------------------------
        // Skid base with a generator canopy, a telescopic column and a short
        // crossbar carrying the head. It is deliberately squat and industrial:
        // this is plant that got towed into the yard tonight, not architecture.
        var tx2 = P.x, tz2 = P.z;
        var tH = Math.max(P.y - 0.55 - F.gy, 2.0);
        // trailer skid + generator box
        m.makeTranslation(tx2, F.gy + 0.24, tz2);
        poles.push({ geometry: GAME.Geo.bevelBox(1.35, 0.48, 0.95, 0.05), matrix: m.clone() });
        m.makeTranslation(tx2, F.gy + 0.70, tz2 - 0.10);
        poles.push({ geometry: GAME.Geo.bevelBox(1.05, 0.46, 0.72, 0.04), matrix: m.clone() });
        // outriggers - four stubby feet, the thing that makes it read as plant
        for (var ofi = 0; ofi < 4; ofi++) {
          var osx = (ofi & 1) ? 0.78 : -0.78, osz = (ofi & 2) ? 0.58 : -0.58;
          m.makeTranslation(tx2 + osx, F.gy + 0.11, tz2 + osz);
          poles.push({ geometry: new THREE.CylinderGeometry(0.14, 0.17, 0.22, 8, 1), matrix: m.clone() });
        }
        // telescopic column, two stages so it is not one clean cylinder
        m.makeTranslation(tx2, F.gy + 0.95 + tH * 0.30, tz2);
        poles.push({ geometry: new THREE.CylinderGeometry(0.105, 0.135, tH * 0.62, 9, 1), matrix: m.clone() });
        m.makeTranslation(tx2, F.gy + 0.95 + tH * 0.74, tz2);
        poles.push({ geometry: new THREE.CylinderGeometry(0.072, 0.092, tH * 0.52, 9, 1), matrix: m.clone() });
        // crossbar under the head, square to the beam's lean
        var tyaw = Math.atan2(-lean.z, lean.x);
        q.setFromAxisAngle(upY, tyaw);
        m.compose(_v2.set(tx2, P.y + 0.30, tz2), q, one);
        heads.push({ geometry: new THREE.BoxGeometry(1.15, 0.10, 0.12), matrix: m.clone() });
        m.compose(_v2.set(tx2, P.y + 0.16, tz2), q, one);
        heads.push({ geometry: new THREE.BoxGeometry(0.14, 0.30, 0.14), matrix: m.clone() });
      } else {
        // flood: a short wall/leg bracket back up the beam axis
        q.setFromUnitVectors(upY, _v1.copy(A).negate());
        m.compose(_v2.copy(P).addScaledVector(A, -(rH + hh + 0.30)), q, one);
        heads.push({ geometry: new THREE.CylinderGeometry(0.075, 0.075, 0.55, 6, 1), matrix: m.clone() });
      }
    }

    try {
      var mat = this._harborMetal(ctx);
      var made = [];
      if (poles.length) {
        var pg = GAME.Geo.mergeAll(poles);
        GAME.Geo.worldUV(pg, 0.85); GAME.Geo.copyUV1(pg);
        var pm = new THREE.Mesh(pg, mat);
        pm.name = 'harborLampMasts';
        pm.castShadow = true; pm.receiveShadow = true;
        this.root.add(pm);
        made.push(pm);
      }
      if (heads.length) {
        var hg = GAME.Geo.mergeAll(heads);
        GAME.Geo.worldUV(hg, 0.85); GAME.Geo.copyUV1(hg);
        var hm = new THREE.Mesh(hg, mat);
        hm.name = 'harborLampHeads';
        // NOT a caster: the housing sits directly on the spot's own origin.
        hm.castShadow = false; hm.receiveShadow = true;
        this.root.add(hm);
        made.push(hm);
      }
      for (i = 0; i < poles.length; i++) poles[i].geometry.dispose();
      for (i = 0; i < heads.length; i++) heads[i].geometry.dispose();
      this._harborFixtures = made;
    } catch (e) {
      GAME.logError('lighting.harborFixtures', e);
      this._harborFixtures = [];
    }
  };

  Lighting.prototype._buildHarborCones = function (ctx, defs) {
    if (this._harborCones) return;
    var out = [];
    try {
      for (var i = 0; i < defs.length && i < this.practicals.length; i++) {
        var d = defs[i];
        if (!(d._beamGain > 0) || !d._axis || !(d._beamLen > 1)) continue;
        var p = this.practicals[i];
        var apex = new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2])
          .addScaledVector(d._axis, 0.12);
        // PAST the aim point, not short of it. The aim point is on the floor for
        // every mast and flood, so overshooting buries the shell's open far end
        // under the apron where the depth test removes it, and the beam
        // terminates ON its own pool instead of stopping in mid-air with a rim.
        var len = M.clamp(d._beamLen + 1.3, 1.0, d.distance * 0.98);
        // The AUTHORED angle, not the opened-up one. The shell is the bright
        // core of the luminaire - the part with enough scattering in it to be
        // visible as air glow - and it is also the part whose edge lands where
        // the eye sees the pool edge. Building it from the full skirt angle
        // would put a 12 m radius wedge round every mast and swallow the yard.
        var r1 = Math.max(len * Math.tan(M.clamp(d._coneVis || d.cone, 0.15, 1.2)) * 0.96, 0.6);
        // 14 rings, not 10: the taper now runs the full length instead of
        // dying at 62%, so the far half needs enough sections for the gradient
        // to be smooth and for the 0.88-1.0 end fade to land on more than one.
        var geo = buildBeamGeometry(apex, d._axis, len,
          d._fixture === 'mast' ? 0.46 : 0.30, r1, 20, 14);
        var mesh = new THREE.Mesh(geo, makeBeamMaterial());
        mesh.name = 'lampCone_' + d.name;
        mesh.castShadow = false; mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 4;
        this.root.add(mesh);
        // The mid-point and the axis are kept so the per-frame accumulation cap
        // can weigh this shell without walking its geometry (see _updateHarbor).
        out.push({
          mesh: mesh, p: p, gain: d._beamGain,
          mid: new THREE.Vector3(
            apex.x + d._axis.x * len * 0.45,
            apex.y + d._axis.y * len * 0.45,
            apex.z + d._axis.z * len * 0.45),
          axis: d._axis.clone(),
          // Screen footprint scales with the shell's own cross-section.
          area: r1 * len
        });
      }
    } catch (e) {
      GAME.logError('lighting.harborCones', e);
    }
    this._harborCones = out;
  };

  // --------------------------------------------------------------------------
  // Glow cards and indicator emitters - the practical VARIETY the brief asks
  // for that does not need a light of its own. Every one of these is emissive
  // geometry with zero shading cost: the roller door, the portacabin windows,
  // the freighter's deck row, reefer doors, and the little coloured indicators
  // that make a reefer stack read as machinery rather than as boxes.
  // --------------------------------------------------------------------------
  // ---- WHERE THEY GO IS DERIVED, NOT REMEMBERED ----------------------------
  // The previous version of this table placed every card and indicator at a
  // fixed offset from a published CAMERA POSE. level_harbor.js then moved four
  // of those poses and relocated the warehouse, the reefer bank and the
  // portacabin during its own build, and the decorations followed the poses
  // instead of the objects. Probed against the shipped level, the two
  // "portacabin windows" resolved to (-21.1, 2.3, 38.2) while the portacabin's
  // own published lamp sits at (12.9, 1.95, 27.5) - 34 m apart, out in the
  // middle of the apron. The reefer indicator bank landed at x = -35.9, five
  // metres INSIDE the west stack.
  //
  // Nothing below is a coordinate any more. Every entry names an ANCHOR, and
  // _harborAnchors resolves each anchor from something the level publishes on
  // THIS run - its own practicalLights, its own lightShafts, its own poses -
  // then plants it on real geometry with level.raycast. An anchor that cannot
  // be resolved produces no decoration, which is always better than an additive
  // rectangle hanging in mid air, and the whole set re-derives itself the next
  // time the level moves.
  var HARBOR_CARDS = [
    // the open roller door - the biggest single glow in the level
    { anchor: 'warehouse_door', w: 3.3, h: 3.8, kelvin: 4300, tint: 'mercury',
      tintAmt: 0.45, gain: 0.42, halo: 4.2, hoff: 0.30, flick: 0.35 },
    // portacabin office windows, either side of the cabin's own lamp
    { anchor: 'cabin_win_a', w: 1.30, h: 0.86, kelvin: 3000, gain: 0.62,
      halo: 1.5, hoff: 0.14, flick: 1.0 },
    { anchor: 'cabin_win_b', w: 1.05, h: 0.86, kelvin: 2900, gain: 0.52,
      halo: 1.4, hoff: 0.14, flick: 1.0 },
    // the freighter's deck lights, seen as spill on the hull
    { anchor: 'hull_a', w: 2.1, h: 0.55, kelvin: 5600, tint: 'mercury',
      tintAmt: 0.75, gain: 0.38, halo: 2.0, hoff: 0.20, flick: 0.25 },
    { anchor: 'hull_b', w: 2.1, h: 0.55, kelvin: 5600, tint: 'mercury',
      tintAmt: 0.75, gain: 0.33, halo: 1.9, hoff: 0.20, flick: 0.25 },
    // a reefer unit with its door cracked open, on the real canyon wall
    // Cracked-open reefer door. Gain pulled back from 0.26: an additive card
    // that close to the `containers` eye printed as a flat white slab on the
    // stack rather than as a sliver of cold interior.
    { anchor: 'reefer_door', w: 0.62, h: 1.55, kelvin: 6200, tint: 'mercury',
      tintAmt: 0.85, gain: 0.17, halo: 1.1, hoff: 0.12, flick: 0.5 }
  ];

  var HARBOR_EMITTERS = [
    // reefer indicator bank - three units, power + running + alarm
    { anchor: 'reefer_a', dy: 0.80, dt: -0.15, c: 0x50ffd0, rad: 0.055, mode: 'steady', gain: 1.0 },
    { anchor: 'reefer_a', dy: 0.80, dt: 0.15, c: 0x60ff80, rad: 0.048, mode: 'pulse', gain: 0.9 },
    { anchor: 'reefer_b', dy: 0.80, dt: -0.15, c: 0x50ffd0, rad: 0.055, mode: 'steady', gain: 1.0 },
    { anchor: 'reefer_b', dy: 0.80, dt: 0.15, c: 0xff6030, rad: 0.048, mode: 'blink', period: 1.9, duty: 0.34, gain: 1.1 },
    { anchor: 'reefer_c', dy: 0.80, dt: -0.15, c: 0x50ffd0, rad: 0.055, mode: 'steady', gain: 1.0 },
    { anchor: 'reefer_c', dy: 0.80, dt: 0.15, c: 0x60ff80, rad: 0.048, mode: 'pulse', gain: 0.9 },
    // freighter deck bulbs
    { anchor: 'hull_a', dy: 0.28, c: 0xcfe6ff, rad: 0.10, mode: 'steady', gain: 1.2 },
    { anchor: 'hull_b', dy: 0.28, c: 0xcfe6ff, rad: 0.10, mode: 'steady', gain: 1.0 },
    { anchor: 'hull_c', dy: 0.28, c: 0xcfe6ff, rad: 0.10, mode: 'steady', gain: 0.85 },
    // the freighter's masthead navigation light - a slow marine flash
    { anchor: 'nav_mast', c: 0x30ff90, rad: 0.135, mode: 'blink', period: 4.4, duty: 0.20, gain: 1.6 },
    // ---- the crane ----------------------------------------------------------
    // Aviation obstruction beacons at the apex and the boom tip, plus the
    // rotating amber over the walkway. These are what put a 30 m gantry into a
    // night frame: a red pair at 30 m against cloud reads as SCALE the instant
    // you see it, and it costs one instanced sphere each. Radii are sized for a
    // real obstruction light, not for the indicator LEDs above - the crane
    // framing photographs the apex from 45 m and the boom tip from 85 m.
    { anchor: 'crane_apex', c: 0xff2418, rad: 0.30, mode: 'pulse', gain: 1.7 },
    { anchor: 'crane_tip', c: 0xff2418, rad: 0.26, mode: 'pulse', gain: 1.5 },
    { anchor: 'crane_walk', c: 0xffa028, rad: 0.185, mode: 'beacon', period: 1.9, gain: 1.6 },
    // amber beacon, on the vehicle whose headlight this rig already runs
    { anchor: 'vehicle_beacon', c: 0xffa028, rad: 0.115, mode: 'beacon', period: 1.35, gain: 1.5 },
    // warehouse tube ends, at the level's OWN published tube lamps
    { anchor: 'wh_tube_a', c: 0xdff0ff, rad: 0.085, mode: 'steady', gain: 0.8 },
    { anchor: 'wh_tube_b', c: 0xdff0ff, rad: 0.085, mode: 'pulse', gain: 0.7 }
  ];

  // Plant a glow card on real geometry.
  //
  // A card is an OPENING - a door, a window, a shell door in a hull - so it has
  // to be ON the surface it is an opening in. Pose-relative placement can only
  // put it at a plausible distance along a sightline, and a 3.4 x 3.8 m additive
  // rectangle hanging in mid-air over the apron is a far worse defect than a
  // missing one. level.raycast is the authoritative geometry query and every
  // level in the build publishes it, so the card is pushed backwards along its
  // own normal until it finds a wall and is then stood 10 cm proud of it.
  Lighting.prototype._snapToSurface = function (ctx, pos, nx, nz, reach) {
    var lvl = ctx && ctx.level;
    if (!lvl || typeof lvl.raycast !== 'function') return 0;
    try {
      var r = lvl.raycast(pos, _v3.set(-nx, 0, -nz), reach);
      if (r && r.hit && isFinite(r.distance) && r.distance > 0.05) {
        pos.set(r.point.x + nx * 0.10, pos.y, r.point.z + nz * 0.10);
        return 1;
      }
      // Nothing behind it: the card may have been placed INSIDE the structure,
      // so try forward as well and stand it on the near face instead.
      r = lvl.raycast(pos, _v3.set(nx, 0, nz), reach);
      if (r && r.hit && isFinite(r.distance) && r.distance > 0.05) {
        pos.set(r.point.x + nx * 0.10, pos.y, r.point.z + nz * 0.10);
        return 1;
      }
    } catch (e) { /* a level without a working raycast just keeps the guess */ }
    return 0;
  };

  // Cast a ray with the level's own geometry query and hand back the hit, or
  // null. Every anchor below is found this way rather than transcribed, so the
  // decorations follow the level when the level moves.
  Lighting.prototype._harborRay = function (ctx, ox, oy, oz, dx, dy, dz, maxD) {
    var lvl = ctx && ctx.level;
    if (!lvl || typeof lvl.raycast !== 'function') return null;
    try {
      var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!(l > 1e-6)) return null;
      var r = lvl.raycast(_v4.set(ox, oy, oz), _v3.set(dx / l, dy / l, dz / l), maxD);
      if (r && r.hit && isFinite(r.distance) && r.distance > 0.05 && r.point) return r;
    } catch (e) { /* a level with no working raycast simply anchors nothing */ }
    return null;
  };

  // --------------------------------------------------------------------------
  // ANCHOR RESOLUTION - every decoration's home, read off THIS run's level.
  //
  // Sources, in order of authority:
  //   1. level.practicalLights  - the level's own fixtures. A portacabin lamp IS
  //      the portacabin; a warehouse tube IS the warehouse. Matched by name and
  //      by kind, never by coordinate.
  //   2. level.lightShafts      - the mast heads and the crane/warehouse shafts.
  //   3. level.raycast          - the authoritative geometry query, used to find
  //      the actual surface (cabin wall, canyon flank, freighter hull) and to
  //      stand the card proud of it.
  // Anything unresolved is simply absent.
  // --------------------------------------------------------------------------
  Lighting.prototype._harborAnchors = function (ctx) {
    var A = {};
    var lvl = ctx && ctx.level;
    if (!lvl) return A;
    var F = this._harborF;
    var poses = lvl.cameraPoses || {};
    var lamps = Array.isArray(lvl.practicalLights) ? lvl.practicalLights : [];
    var self = this;
    var i;

    function eyeOf(name) {
      var p = poses[name] && poses[name].position;
      return (p && isFinite(p.x)) ? p : null;
    }
    // A decoration faces whoever is going to look at it: the framing it belongs
    // to if the level published one, otherwise the middle of the terminal.
    function facing(pos, poseName) {
      var e = poseName ? eyeOf(poseName) : null;
      var tx = (e ? e.x : F.cx) - pos.x, tz = (e ? e.z : F.cz) - pos.z;
      var tl = Math.sqrt(tx * tx + tz * tz);
      if (!(tl > 1e-3)) return { x: 0, z: 1 };
      return { x: tx / tl, z: tz / tl };
    }
    function find(re, kind, lowest) {
      var best = null;
      for (var j = 0; j < lamps.length; j++) {
        var d = lamps[j];
        if (!d || !d.pos || !isFinite(d.pos[0])) continue;
        var ok = re ? re.test(String(d.name || '')) : false;
        if (!ok && kind && d.kind === kind) ok = true;
        if (!ok) continue;
        if (!best) { best = d; continue; }
        if (lowest && d.pos[1] < best.pos[1]) best = d;
      }
      return best;
    }
    // Put a card on the wall the anchor lamp belongs to: march out from the
    // lamp toward the viewer until the level says there is a surface.
    function onWall(px, py, pz, poseName, reach, key) {
      var f = facing({ x: px, z: pz }, poseName);
      // Outward first (the fitting is inside, the wall is between it and us),
      // then back the other way in case the lamp hangs outside its own shell.
      var r = self._harborRay(ctx, px, py, pz, f.x, 0, f.z, reach);
      if (!r) r = self._harborRay(ctx, px, py, pz, -f.x, 0, -f.z, reach);
      if (!r) return;
      A[key] = {
        x: r.point.x + f.x * 0.10, y: py, z: r.point.z + f.z * 0.10,
        nx: f.x, nz: f.z
      };
    }

    // ---- THE GANTRY CRANE : read off level.anchors, not off a camera -------
    // level_harbor publishes a SURVEY of itself in `level.anchors` and its own
    // header says, in capitals, not to derive a world position from a camera
    // pose. The crane entry carries legX / railA / railB / sill / apex / tipZ /
    // centre / walkway / machineHouse, all derived from the same constants the
    // gantry geometry is, so everything below moves when the crane moves and
    // nothing below is a remembered coordinate.
    //
    // This exists because the crane framing measured its own subject as a black
    // paper cut-out: 30 m of lattice filling the top two thirds of the frame
    // against a 0.13 sky, no rim, no beacons, no cab, and the frame's right
    // column at 0.057-0.085. The terminal's most photogenic object was being
    // rendered as a hole. A structure is not lit by fill - fill raises the cloud
    // behind it by the same amount - it is lit by a grazing key along its own
    // members plus its own beacons and cab.
    var CA = (lvl.anchors && lvl.anchors.crane) ? lvl.anchors.crane : null;
    if (CA && isFinite(CA.sill) && isFinite(CA.legX) &&
        CA.centre && isFinite(CA.centre.x)) {
      var crC = CA.centre;
      var crRailA = isFinite(CA.railA) ? CA.railA : crC.z - 6;
      var crRailB = isFinite(CA.railB) ? CA.railB : crC.z + 6;
      var crApex = isFinite(CA.apex) ? CA.apex : CA.sill + 14;
      var crTip = isFinite(CA.tipZ) ? CA.tipZ : crRailA - 30;
      // Landward face of the portal beam, on the east leg: a real ship-to-shore
      // crane hangs its yard floods exactly here, and it is high enough that the
      // beam crosses the middle third of an upward-pitched framing on its way to
      // the ground instead of living underneath it.
      A.crane_portal = {
        x: crC.x + CA.legX * 0.60, y: CA.sill - 0.80, z: crRailB - 0.70,
        nx: 0, nz: 1
      };
      // ... aimed down-lane at the working strip between the rails, ~25 m out.
      A.crane_lane = {
        x: crC.x - 3.0, y: crC.y || 0, z: (crRailA + crRailB) * 0.5 - 3.0
      };
      // ---- THE FLOOD THAT REVEALS THE GANTRY, AND WHY IT IS NOT ON IT -------
      // This used to be mounted on the A-frame chord, aimed down the landward
      // leg. Probed on the crane framing it delivered 4.7 units to the leg's
      // UP-FACING faces and 0.006 to the faces the camera can see, and the
      // reason is not tuning, it is geometry: the camera stands 31 m LANDWARD
      // of the portal and looks up, so every surface it sees has a normal with
      // a +Z component, and a source mounted on - or seaward of - that face can
      // only ever graze it at zero. Nothing hung on the crane can light the side
      // of the crane the crane framing photographs.
      //
      // So the mount is a YARD MAST, chosen off the level's own published lamps:
      // high, well landward of the portal face, and well off the crane's
      // centreline so the throw crosses the structure diagonally instead of
      // flattening it head-on. That is also what a terminal actually does - the
      // high masts are what light the crane for a night shift - and it puts the
      // beam across the middle third of the frame on its way there.
      //
      // The line is RAYCAST before the anchor is published. A 7600 cd flood
      // whose throw is interrupted by a container stack at 12 m does not light
      // the crane, it prints a white rectangle at 53 lux; if no published mast
      // has a clear line, no anchor is published and the lamp is simply not
      // built (see the aimAnchor guard in _harborLampDefs).
      var rkBest = null, rkScore = -1;
      for (var rk2 = 0; rk2 < lamps.length; rk2++) {
        var rl = lamps[rk2];
        if (!rl || !rl.pos || !isFinite(rl.pos[0])) continue;
        var rlx = rl.pos[0], rly = rl.pos[1], rlz = rl.pos[2];
        if (!(rly > F.gy + 8)) continue;              // must be high
        if (!(rlz > crRailB + 6)) continue;           // must be LANDWARD of it
        if (Math.abs(rlx - crC.x) < 6) continue;      // must have a cross-angle
        // high x landward x lateral: all three are what makes the throw graze.
        var rsc = (rly - F.gy) * (rlz - crRailB) * Math.abs(rlx - crC.x);
        if (rsc > rkScore) { rkScore = rsc; rkBest = rl; }
      }
      if (rkBest) {
        // Aim at the FAR landward leg, at 40% of its height: the beam then runs
        // the full diagonal of the portal and lands on the lattice rather than
        // on the apron behind it.
        var rkSgn = (rkBest.pos[0] >= crC.x) ? -1 : 1;
        var rkT = { x: crC.x + rkSgn * CA.legX,
                    y: F.gy + CA.sill * 0.42, z: crRailB + 0.6 };
        var rkX = rkBest.pos[0], rkY = rkBest.pos[1] - 0.55, rkZ = rkBest.pos[2];
        var rdx = rkT.x - rkX, rdy = rkT.y - rkY, rdz = rkT.z - rkZ;
        var rlen = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
        if (rlen > 12 &&
            !this._harborRay(ctx, rkX, rkY, rkZ, rdx, rdy, rdz, rlen - 2.5)) {
          A.crane_rake_mount = { x: rkX, y: rkY, z: rkZ, nx: 0, nz: 1 };
          A.crane_rake_aim = rkT;
        }
      }
      // Aviation obstruction beacons at the apex and the boom tip, and the
      // rotating amber on the walkway that every working crane carries. The
      // operator cab is deliberately NOT decorated from here: level_harbor
      // already builds its windows as emissive geometry, and they face SEAWARD,
      // which is where an STS cab looks.
      A.crane_apex = { x: crC.x, y: crApex + 0.8, z: crC.z + 1.0, nx: 0, nz: 1 };
      A.crane_tip = { x: crC.x, y: crApex - 1.5, z: crTip + 1.4, nx: 0, nz: 1 };
      if (CA.walkway && isFinite(CA.walkway.x)) {
        A.crane_walk = {
          x: CA.walkway.x + CA.legX * 0.34, y: CA.walkway.y + 1.35,
          z: CA.walkway.z + 0.4, nx: 0, nz: 1
        };
      }
    }

    // ---- the portacabin : its own lamp, and the wall around it -------------
    var cabin = find(/cabin|office|porta/i, null, false) ||
      find(null, 'tungsten', true);
    if (cabin) {
      var cf = facing({ x: cabin.pos[0], z: cabin.pos[2] }, 'overview');
      // window either side of the fitting, along the wall (perpendicular to the
      // facing direction), at eye height for a demountable office.
      var sx = -cf.z, sz = cf.x;
      onWall(cabin.pos[0] + sx * 1.05, cabin.pos[1] + 0.42, cabin.pos[2] + sz * 1.05,
        'overview', 4.5, 'cabin_win_a');
      onWall(cabin.pos[0] - sx * 1.15, cabin.pos[1] + 0.42, cabin.pos[2] - sz * 1.15,
        'overview', 4.5, 'cabin_win_b');
    }

    // ---- the warehouse : its own tubes, and the roller door in its face ----
    var tubeA = find(/wh_tube_a|tube_a/i, null, false);
    var tubeB = find(/wh_tube_b|tube_b/i, null, false);
    if (!tubeA) tubeA = find(null, 'fluoro', false);
    if (tubeA) A.wh_tube_a = { x: tubeA.pos[0], y: tubeA.pos[1] - 0.12, z: tubeA.pos[2], nx: 0, nz: 1 };
    if (tubeB) A.wh_tube_b = { x: tubeB.pos[0], y: tubeB.pos[1] - 0.12, z: tubeB.pos[2], nx: 0, nz: 1 };
    // The door is in the wall between the warehouse framing's eye and the
    // interior lamps, so cast from the eye and take the first face.
    var whEye = eyeOf('warehouse');
    var whRef = tubeA || tubeB;
    if (whEye && whRef) {
      var wdx = whRef.pos[0] - whEye.x, wdz = whRef.pos[2] - whEye.z;
      var wl = Math.sqrt(wdx * wdx + wdz * wdz);
      if (wl > 1e-3) {
        wdx /= wl; wdz /= wl;
        var wr = this._harborRay(ctx, whEye.x, F.gy + 1.95, whEye.z, wdx, 0, wdz, wl + 6);
        if (wr) {
          A.warehouse_door = {
            x: wr.point.x - wdx * 0.10, y: F.gy + 1.95, z: wr.point.z - wdz * 0.10,
            nx: -wdx, nz: -wdz
          };
        }
      }
    }

    // ---- the freighter : found by looking seaward from the gangway ---------
    // The hull is whatever stands up out of the water on the far side of the
    // quay edge. Sweeping the sightline rather than assuming a distance is what
    // makes this survive the ship being moved.
    var gwEye = eyeOf('gangway') || eyeOf('quay');
    var gwYaw = (poses.gangway && isFinite(poses.gangway.yaw)) ? poses.gangway.yaw
      : (poses.quay && isFinite(poses.quay.yaw) ? poses.quay.yaw : 0);
    if (gwEye) {
      var gfx = -Math.sin(gwYaw), gfz = -Math.cos(gwYaw);
      var grx = -gfz, grz = gfx;
      var hullKeys = ['hull_a', 'hull_b', 'hull_c'];
      var lat = [-3.0, 1.0, 5.0];
      // The hull's sheer, its freeboard and the mooring distance are all the
      // level's business and all of them move, so the probe sweeps height as
      // well as bearing and takes the first standing surface it finds out over
      // the water. A single ray at one assumed deck height found nothing at all
      // once the ship was re-moored, and the deck lights vanished with it.
      var hullY = [8.3, 5.5, 11.0, 3.2];
      for (i = 0; i < hullKeys.length; i++) {
        var ax2 = gfx + grx * (lat[i] * 0.16), az2 = gfz + grz * (lat[i] * 0.16);
        var hl = Math.sqrt(ax2 * ax2 + az2 * az2) || 1;
        var hr = null, hy = F.gy + hullY[0];
        for (var hyi = 0; hyi < hullY.length && !hr; hyi++) {
          hy = F.gy + hullY[hyi];
          var cand = this._harborRay(ctx, gwEye.x, hy, gwEye.z, ax2, 0, az2, 60);
          if (cand && cand.distance >= 8) hr = cand;
        }
        if (!hr) continue;
        A[hullKeys[i]] = {
          x: hr.point.x - ax2 / hl * 0.12, y: hy, z: hr.point.z - az2 / hl * 0.12,
          nx: -ax2 / hl, nz: -az2 / hl
        };
      }
      if (A.hull_a) {
        A.nav_mast = { x: A.hull_a.x, y: A.hull_a.y + 7.1, z: A.hull_a.z,
          nx: A.hull_a.nx, nz: A.hull_a.nz };
      }
    }

    // ---- the reefer bank : a real canyon flank near the containers framing --
    // Cast sideways from a point up the corridor the framing looks down, so the
    // indicators end up ON the stack rather than five metres inside it.
    var cEye = eyeOf('containers');
    var cYaw = (poses.containers && isFinite(poses.containers.yaw)) ? poses.containers.yaw : 0;
    if (cEye) {
      var cfx = -Math.sin(cYaw), cfz = -Math.cos(cYaw);
      var crx = -cfz, crz = cfx;
      var rk = ['reefer_a', 'reefer_b', 'reefer_c'];
      for (i = 0; i < rk.length; i++) {
        var along = 7.5 + i * 1.4;
        var ox2 = cEye.x + cfx * along, oz2 = cEye.z + cfz * along;
        // Try the left wall first, then the right - a canyon has two.
        var rr = this._harborRay(ctx, ox2, F.gy + 1.6, oz2, -crx, 0, -crz, 9);
        var sgn = -1;
        if (!rr) { rr = this._harborRay(ctx, ox2, F.gy + 1.6, oz2, crx, 0, crz, 9); sgn = 1; }
        if (!rr || rr.distance < 0.6) continue;
        A[rk[i]] = {
          x: rr.point.x - crx * sgn * 0.10, y: F.gy + 1.6, z: rr.point.z - crz * sgn * 0.10,
          nx: -crx * sgn, nz: -crz * sgn,
          tx: crz * sgn, tz: -crx * sgn
        };
      }
      if (A.reefer_a) {
        A.reefer_door = { x: A.reefer_a.x, y: F.gy + 1.55, z: A.reefer_a.z,
          nx: A.reefer_a.nx, nz: A.reefer_a.nz };
      }
    }

    // ---- open floor in front of each framing -------------------------------
    // Used to stand yard plant (a forklift, a portable lighting tower) where the
    // camera will actually see it. Derived by walking out along the framing's
    // own sightline and asking the level for the floor, then finding the middle
    // of whatever corridor it is in by casting both ways - so a lamp meant for a
    // canyon ends up in the canyon and never inside the stack.
    var names = ['containers', 'quay', 'gangway', 'warehouse', 'crane', 'overview'];
    for (i = 0; i < names.length; i++) {
      var pn = names[i];
      var pe = eyeOf(pn);
      if (!pe) continue;
      var pyaw = (poses[pn] && isFinite(poses[pn].yaw)) ? poses[pn].yaw : 0;
      var pfx = -Math.sin(pyaw), pfz = -Math.cos(pyaw);
      var prx = -pfz, prz = pfx;
      var got = null;
      for (var step = 0; step < 6 && !got; step++) {
        var dd = 6.0 + step * 1.6;
        var qx = pe.x + pfx * dd, qz = pe.z + pfz * dd;
        // Must be reachable: no wall between the eye and the spot.
        if (this._harborRay(ctx, pe.x, pe.y, pe.z, pfx, 0, pfz, dd - 0.4)) continue;
        // Must have a floor, and must not be a container roof six metres up.
        var fr = this._harborRay(ctx, qx, pe.y + 0.6, qz, 0, -1, 0, 6.0);
        var fy = fr ? fr.point.y : F.gy;
        if (Math.abs(fy - F.gy) > 2.0) continue;
        // Centre it in whatever corridor it landed in.
        var hitL = this._harborRay(ctx, qx, fy + 1.4, qz, -prx, 0, -prz, 9);
        var hitR = this._harborRay(ctx, qx, fy + 1.4, qz, prx, 0, prz, 9);
        var off = 0;
        if (hitL && hitR) off = (hitR.distance - hitL.distance) * 0.5;
        else if (hitL && hitL.distance < 1.6) off = 1.6 - hitL.distance;
        else if (hitR && hitR.distance < 1.6) off = -(1.6 - hitR.distance);
        got = {
          x: qx + prx * off, y: fy, z: qz + prz * off, nx: -pfx, nz: -pfz,
          // Lateral axis and the clear width either side of the centreline, so
          // plant can be stood AGAINST a wall instead of in the middle of the
          // lane the player has to walk down.
          rx: prx, rz: prz,
          wL: hitL ? (hitL.distance + off) : 6.0,
          wR: hitR ? (hitR.distance - off) : 6.0
        };
      }
      if (got) A['floor_' + pn] = got;
    }
    return A;
  };

  // The beacon belongs on the vehicle whose headlight this rig is already
  // running, so it can only be resolved once the practicals exist.
  Lighting.prototype._harborAnchorVehicle = function () {
    var A = this._harborAnchorMap;
    if (!A) return;
    for (var i = 0; i < this.practicals.length; i++) {
      var pv = this.practicals[i];
      if (pv && pv.light && /vehicle|forklift|bowser/i.test(pv.light.name || '')) {
        A.vehicle_beacon = { x: pv.base.x, y: pv.base.y + 1.25, z: pv.base.z, nx: 0, nz: 1 };
        return;
      }
    }
  };

  Lighting.prototype._buildHarborCards = function (ctx, authored) {
    var out = [];
    var A = this._harborAnchorMap || (this._harborAnchorMap = this._harborAnchors(ctx));
    for (var i = 0; i < HARBOR_CARDS.length; i++) {
      var c = HARBOR_CARDS[i];
      var a = A[c.anchor];
      // An anchor the level did not turn out to have. There is nothing for this
      // card to be an opening IN, so it is not built - see the header above.
      if (!a || !isFinite(a.x)) continue;
      var tx = a.nx, tz = a.nz;
      out.push({
        x: a.x, y: a.y, z: a.z,
        sign: 0, yaw: Math.atan2(tx, tz),
        w: c.w, h: c.h, scale: 1.0,
        kelvin: c.kelvin, gain: c.gain,
        tint: c.tint === 'mercury' ? HPAL.mercury : (c.tint === 'sodium' ? HPAL.sodium : null),
        tintAmt: c.tintAmt != null ? c.tintAmt : 0.5,
        haloSize: c.halo,
        hox: tx * (c.hoff || 0.15), hoy: 0, hoz: tz * (c.hoff || 0.15),
        flick: c.flick != null ? c.flick : 1
      });
    }
    this._harborWindows = out;
    if (authored) { /* every card above is already geometry-derived */ }
  };

  Lighting.prototype._buildHarborEmitters = function (ctx, authored) {
    if (this._harborEmitters) return;
    try {
      if (!THREE.InstancedMesh) return;
      var A = this._harborAnchorMap || (this._harborAnchorMap = this._harborAnchors(ctx));
      var defs = [];
      var i;
      for (i = 0; i < HARBOR_EMITTERS.length; i++) {
        var e = HARBOR_EMITTERS[i];
        var an = A[e.anchor];
        if (!an || !isFinite(an.x)) continue;
        // `dt` steps along the surface the anchor was found on, so a bank of
        // indicators runs across the machine's face instead of through it.
        var tgx = (an.tx != null) ? an.tx : -an.nz;
        var tgz = (an.tz != null) ? an.tz : an.nx;
        var dt = e.dt || 0;
        defs.push({
          pos: new THREE.Vector3(an.x + tgx * dt + an.nx * 0.04,
            an.y + (e.dy || 0), an.z + tgz * dt + an.nz * 0.04),
          color: new THREE.Color(e.c), rad: e.rad,
          mode: e.mode || 'steady', period: e.period || 2,
          duty: e.duty != null ? e.duty : 0.3,
          gain: e.gain != null ? e.gain : 1,
          phase: this.rng.range(0, 1)
        });
      }
      if (authored) { /* anchors are geometry-derived either way */ }
      if (!defs.length) return;
      var geo = new THREE.SphereGeometry(1, 7, 5);
      var mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, toneMapped: false, fog: false
      });
      var mesh = new THREE.InstancedMesh(geo, mat, defs.length);
      mesh.name = 'harborEmitters';
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      var m = new THREE.Matrix4();
      for (i = 0; i < defs.length; i++) {
        m.makeScale(defs[i].rad, defs[i].rad, defs[i].rad);
        m.setPosition(defs[i].pos.x, defs[i].pos.y, defs[i].pos.z);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, defs[i].color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
      this._harborEmitters = { mesh: mesh };
      this._harborEmitDefs = defs;
    } catch (e2) {
      GAME.logError('lighting.harborEmitters', e2);
      this._harborEmitters = null;
    }
  };

  // --------------------------------------------------------------------------
  // Assemble. level.js builds AFTER lighting, so this cannot happen in build();
  // it runs on the first update that can see a level (or, if the level failed
  // to build entirely, on the third frame against the fallback frame - a dead
  // level must still leave lamps in the scene).
  // --------------------------------------------------------------------------
  Lighting.prototype._buildHarborRig = function (ctx) {
    if (this._harborBuilt || !this.isHarbor) return;
    if (!ctx.level && this._frame < 3) return;
    this._harborBuilt = true;
    // We consume level.practicalLights ourselves (with fixtures, cones and
    // aiming attached), so the level-1 adoption path must not also run.
    this._levelLampsChecked = true;
    try {
      this._harborF = this._harborFrame(ctx);
      var defs = this._harborLampDefs(ctx);

      // Defensive: build() skips the market set for the harbor, but if anything
      // ever put practicals here first, clear them rather than doubling up.
      for (var r = 0; r < this.practicals.length; r++) {
        var old = this.practicals[r].light;
        if (old.target && old.target.parent === this.root) this.root.remove(old.target);
        this.root.remove(old);
      }
      this.practicals.length = 0;
      this._buildPracticals(ctx, defs);

      this._harborHero.length = 0;
      for (var i = 0; i < this.practicals.length && i < defs.length; i++) {
        this.practicals[i].beam = defs[i]._beamGain || 0;
        if (defs[i].shadow && this.practicals[i].light.castShadow) {
          this._harborHero.push(this.practicals[i]);
        }
      }

      // "authored" = the level published its own lamp set, so it has real
      // structures everywhere and a decoration that cannot find one is a
      // decoration floating in mid-air.
      var authored = !!(ctx.level &&
        ((Array.isArray(ctx.level.practicalLights) && ctx.level.practicalLights.length) ||
         (Array.isArray(ctx.level.mastLamps) && ctx.level.mastLamps.length)));
      // The beacon anchor needs the vehicle's own light to exist first.
      this._harborAnchorVehicle();
      this._buildHarborCards(ctx, authored);
      this._buildHarborFixtures(ctx, defs);
      this._buildHarborCones(ctx, defs);
      this._buildHarborEmitters(ctx, authored);
      // Level 1 builds the bulbs/halos at the tail of the sky-visibility bake,
      // because that is where its lit-window search gets its occupancy grid.
      // The harbor's cards are authored, not searched, so the visuals must NOT
      // be hostage to a bake that only runs if level.colliders exists - a level
      // that publishes no colliders would otherwise render twelve lamps with no
      // visible source anywhere. It early-outs if it has already run.
      this._buildLampVisuals(ctx, null);

      this.harborDiag = {
        lamps: this.practicals.length,
        spots: 0, points: 0,
        shadowCasters: this._harborHero.length,
        cones: this._harborCones ? this._harborCones.length : 0,
        cards: this._harborWindows ? this._harborWindows.length : 0,
        emitters: this._harborEmitDefs ? this._harborEmitDefs.length : 0,
        fixtures: this._harborFixtures ? this._harborFixtures.length : 0,
        posed: !!(ctx.level && ctx.level.cameraPoses),
        // Accounting for every entry in level.lightShafts: paired with a lamp
        // the level already published, adopted into a lamp of our own, or built
        // as a real shaft by _buildShafts. published == paired + adopted +
        // shafts, or something the level asked for is not in the picture.
        shaftsPublished: this._shaftAudit ? this._shaftAudit.published : 0,
        shaftsPaired: this._shaftAudit ? this._shaftAudit.paired : 0,
        shaftsAdopted: this._shaftAudit ? this._shaftAudit.adopted : 0,
        anchors: this._harborAnchorMap ? Object.keys(this._harborAnchorMap).join(',') : ''
      };
      for (var s = 0; s < this.practicals.length; s++) {
        if (this.practicals[s].light.isSpotLight) this.harborDiag.spots++;
        else this.harborDiag.points++;
      }
      // A probing critic (or the next round's author) should be able to see the
      // whole rig without reading it back out of the scene graph, and the one
      // thing that has caught a real defect twice now is knowing which
      // supporting lamps SURVIVED the cap. `dropped` is that number.
      this.harborDiag.dropped = isFinite(this._harborWanted)
        ? Math.max(0, this._harborWanted - this.practicals.length) : 0;
      this.harborDiag.names = [];
      for (var q = 0; q < this.practicals.length; q++) {
        this.harborDiag.names.push(this.practicals[q].light.name);
      }
    } catch (e) {
      GAME.logError('lighting.harborRig', e);
    }
  };

  // --------------------------------------------------------------------------
  // LIGHTNING - a real DirectionalLight, not a post effect.
  //
  // The 4-cascade CSM is REPURPOSED as the strike caster. Same cascades, same
  // texel snap, same PCSS filter; only the direction and the colour change. That
  // is what makes the flash relight the terminal AT GEOMETRY LEVEL: every
  // container, the crane and the freighter throw a hard shadow in a direction
  // that has nothing to do with the mast lamps, for 60-180 ms, and then it is
  // dark again. A screen-space white fade cannot do that and is on
  // ART_DIRECTION_HARBOR's instant-fail list.
  //
  // The direction is LATCHED at the leading edge of each strike. A flash whose
  // direction drifts mid-strike drags every shadow in the frame with it, which
  // reads as a bug; a real bolt is over before anything can move.
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // Coordinating with weather.js's own lightning rig.
  //
  // Both modules were told to make lightning a real light, and both did, so the
  // scene ends up with two strike lights and two strike hemispheres. The whole
  // no-double-billing budget below depends on this function FINDING the other
  // rig, and for the entire life of the level it never did:
  //
  //   it gated on `cand.isDirectionalLight`, and weather.js publishes
  //   `flashLight` as a THREE.SpotLight - deliberately, with a comment
  //   explaining why (the CSM patch at the top of this file gives shadows to
  //   DIRECTIONAL light 0 only, so weather's light had to take the spot path or
  //   it would have rendered a 2048 shadow map that nothing samples).
  //
  // So `_extFlashLight` and `_extFlashFill` were never assigned, `extI` was
  // permanently 0, the subtraction below was silently a no-op, and both modules
  // ran a full strike at once - two keys plus a doubled omnidirectional lift,
  // which is precisely how you cancel directionality. Measured: the left wall,
  // the right wall, the far wall and the ground all lifted by 4.7-7.0x on the
  // same strike, and the apron terminator was 2.5:1 where a strike should be
  // 15:1.
  //
  // The fill is now resolved INDEPENDENTLY of the key, because they are
  // separate objects and one being unrecognisable is no reason to ignore the
  // other.
  //
  // Read-only, by handle first and never by mutating another module's objects.
  // --------------------------------------------------------------------------
  Lighting.prototype._findExternalFlash = function (ctx) {
    if (this._extFlashDone) return;
    var w = ctx && ctx.weather;
    if (!w) {
      if (this._frame > 900) this._extFlashDone = true;
      return;
    }
    var cand = w.flashLight || w.lightningLight || w._flashLight || null;
    // A spot 200 m away with a 24-degree cone is a directional in everything
    // but its class name, and it is the only kind of light in this build that
    // can cast a shadow while the cascades are carrying their own key.
    if (cand && (cand.isSpotLight || cand.isDirectionalLight)) {
      this._extFlashLight = cand;
    }
    var fill = w.flashFill || w._flashFill || null;
    if (fill && fill.isHemisphereLight) this._extFlashFill = fill;
    if (this._extFlashLight && this._extFlashFill) {
      this._extFlashDone = true;
      return;
    }
    // weather.js builds eight systems after this one and only allocates its rig
    // when a wet preset is selected, so keep looking for a few seconds and then
    // stop paying for the check.
    if (this._frame > 900) this._extFlashDone = true;
  };

  // The direction weather.js's own strike light is actually pointing, taken
  // from the objects rather than from the published vector, so the two keys
  // cannot end up a few degrees apart and cross-light the same wall from two
  // azimuths. Returns false if there is nothing to read.
  Lighting.prototype._externalFlashDir = function (out) {
    var L = this._extFlashLight;
    if (!L) return false;
    var t = L.target;
    if (t && t.position && isFinite(t.position.x)) {
      out.set(L.position.x - t.position.x,
        L.position.y - t.position.y,
        L.position.z - t.position.z);
    } else if (isFinite(L.position.x)) {
      out.copy(L.position);
    } else {
      return false;
    }
    if (!(out.lengthSq() > 1e-6)) return false;
    out.normalize();
    return true;
  };

  Lighting.prototype._harborKey = function (ctx) {
    // The harbor is 02:00 in a storm whatever the sky module believes. Pinning
    // the clock here rather than trusting sky.js is what stops one missing
    // setTimeOfDay call from printing a container terminal at noon.
    this.dayFactor = 0;
    this.duskFactor = 0;
    this.nightFactor = 1;
    this.keyIsMoon = false;

    var w = ctx && ctx.weather;
    var raw = (w && isFinite(w.flash)) ? M.clamp(w.flash, 0, 1) : 0;
    this._findExternalFlash(ctx);
    var dir = _v3;
    // ---- THE PUBLISHED VECTOR FIRST, AND THE ORDER IS WHY ------------------
    // Both keys have to arrive from exactly the same azimuth or the strike
    // lights one wall from the left and the other from the right and the frame
    // ends up with no direction in it at all.
    //
    // This used to read the other rig's LIGHT OBJECT first, on the reasoning
    // that the transform is what is actually casting. It is - but it is one
    // frame stale, and the one frame that matters is the only frame this
    // function ever reads it on. main.js updates lighting BEFORE weather, and
    // scenarios.js fires the strike from the tick that precedes the step, so on
    // the LEADING EDGE of a strike weather.flash and weather.flashDir have
    // already been set (synchronously, inside _beginStrike) while the light
    // object is still parked where the PREVIOUS strike left it. The direction
    // is latched on exactly that edge and held for the rest of the strike, so
    // the whole flash ran on the stale transform.
    //
    // Measured on the `lightning` capture: weather published
    // (0.073, 0.796, -0.601) and this rig latched (0.349, 0.625, -0.698) - the
    // vector weather.js was initialised with, 26 degrees away and 11 degrees
    // lower. Two keys 26 degrees apart is still two keys.
    //
    // weather.flashDir is the DOCUMENTED contract (ARCHITECTURE section 5) and
    // it is written before `flash` goes non-zero, so it is never stale. The
    // light object stays as the fallback for a weather module that publishes an
    // object but no vector.
    if (w && w.flashDir && isFinite(w.flashDir.x) && w.flashDir.lengthSq() > 1e-6) {
      dir.copy(w.flashDir).normalize();
    } else if (!this._externalFlashDir(dir)) {
      dir.copy(HARBOR_FLASH_FALLBACK);
    }
    // A directional light under the ground plane lights the world from below.
    if (dir.y < 0.16) { dir.y = 0.16; dir.normalize(); }
    if (raw <= FLASH_ON || this._flashPrev <= FLASH_ON) this._flashLatch.copy(dir);
    this._flashPrev = raw;

    this.flash = raw;
    this.flashDirection.copy(this._flashLatch);
    this._keyDir.copy(this._flashLatch);
    this.sunDirection.copy(this._flashLatch);
    // The true solar vector is genuinely below the horizon: it is 02:00. Every
    // day/night term in the file derives from this, including the practical
    // switch-on ramp, so it must not be left pointing at a sky that is not there.
    this.solarDirection.set(0.20, -0.88, -0.43).normalize();

    GAME.Color.kelvin(HARBOR_FLASH_K, this.keyColor);
    this.keyColor.lerp(HPAL.lightning, 0.55);

    var budget = HB.key * raw;
    var extI = (this._extFlashLight && isFinite(this._extFlashLight.intensity))
      ? Math.max(0, this._extFlashLight.intensity) : 0;
    // Whatever weather.js is already spending comes out of the budget, and now
    // that the subtraction is no longer a no-op it actually subtracts: at a
    // close strike weather runs 25-30 units and this rig drops to its floor.
    //
    // That floor still matters. weather's spot casts a real shadow, but it is
    // aimed at the CAMERA with a 0.42 rad cone and its shadow camera runs
    // 100-360 m; the cascades are fitted to the view frustum at a 1-4 cm texel
    // and they are what puts a hard contact shadow under a container at 6 m. A
    // strike therefore always moves the cascades as well, and both keys point
    // the same way (see _externalFlashDir), so they reinforce instead of
    // cancelling.
    //
    // The previous `extI * keyShare` term existed only to compensate for the
    // subtraction being broken. With the subtraction working it would double the
    // strike again, which is the defect it was written to hide.
    this.keyIntensity = M.clamp(
      Math.max(budget - extI, HB.keyMin * raw), 0, 20);
  };

  // --------------------------------------------------------------------------
  // The fill rig, inverted for a level with no sun.
  // --------------------------------------------------------------------------
  Lighting.prototype._harborFill = function (ctx) {
    // Every term below is a HEMISPHERE or the AmbientLight now, so they all take
    // the full sky-visibility gate and therefore the full skylight compensation
    // (skyComp). skyCompDir - the much smaller compensation for the weakly-gated
    // directional bounce path - no longer applies to anything in this level.
    var comp = (isFinite(this.skyComp) && this.skyComp > 0) ? this.skyComp : 1;
    var f = this.flash;
    var w = ctx && ctx.weather;
    var wet = (w && isFinite(w.wetness)) ? M.clamp(w.wetness, 0, 1) : 0.85;

    // ---- THE OMNIDIRECTIONAL HALF OF A STRIKE IS A SINGLE BUDGET -----------
    // A bolt is ONE directional event. Everything omnidirectional a strike adds
    // - the cloud base lighting up, the whole yard bouncing - is the SAME
    // physical term, and it was being billed five times over: this rig raised
    // its ambient, its hemisphere, its cross-canyon pair, its apron bounce AND
    // scene.environmentIntensity, while weather.js separately ran a cold
    // HemisphereLight of its own. Only the hemisphere netted weather's light
    // out; the other four did not, so the omnidirectional total more than
    // doubled on the strike frame.
    //
    // That is exactly how a bolt stops having a direction. MEASURED on the
    // identical-camera A/B (`containers` against `lightning`): the two
    // mutually-perpendicular canyon walls lifted x5.66 and x5.42 while the
    // APRON - the one surface actually facing a bolt 53 degrees up - lifted
    // x4.23. The surfaces facing away from the strike were gaining MORE than
    // the surface facing it, which is the definition of an omnidirectional
    // flash wearing a directional light's clothes.
    //
    // So the *Flash constants below are now a single pooled budget, and
    // whatever weather.js's own flash fill is already spending comes out of it
    // FIRST. `fOmni` is what is left, expressed as a fraction of the flash, and
    // every omnidirectional increment is scaled by it. The COLOURS still track
    // the real `f`: the shadow side has to go cold on the strike frame even
    // when its magnitude barely moves, or the grade inverts (warm shadows under
    // a cold highlight). Magnitude is budgeted; hue is not.
    var extF = (this._extFlashFill && isFinite(this._extFlashFill.intensity))
      ? Math.max(0, this._extFlashFill.intensity) : 0;
    var omniBudget = HB.ambientFlash +
      (HB.hemiFlash + HB.envFlash + HB.bounceFlash +
       HB.fillFlash * (1 + HB.fillBRatio)) * comp;
    var fOmni = f * M.clamp(1 - extF / Math.max(omniBudget, 1e-3), 0, 1);

    if (this.hemi) {
      // Storm cloud above, black wet apron below. The sky half is the term that
      // jumps hardest during a strike, because the whole cloud base is what
      // physically lights up; the ground half carries a little sodium, which is
      // what a soaked apron under four orange lamps actually throws back.
      _c1.copy(HPAL.stormSky).lerp(HPAL.lightning, 0.40 * f);
      this.hemi.color.copy(_c1);
      _c2.copy(HPAL.wetGround).lerp(HPAL.sodium, 0.20 * (1 - 0.5 * f));
      this.hemi.groundColor.copy(_c2);
      this.hemi.intensity = (HB.hemi + HB.hemiFlash * fOmni) * comp;
    }

    if (ctx.scene && ctx.scene.isScene) {
      ctx.scene.environmentIntensity = comp * (HB.env + HB.envFlash * fOmni);
    }

    if (this.hBounce) {
      // "Bounce warm sodium up off the wet apron." Rays travel UP, so this is
      // the term that puts light under a container lip, on the underside of the
      // crane boom and on a man's chin. A wet apron is closer to a mirror than
      // to a diffuser, so the wetter it is the more comes back.
      //
      // Axis (0,-1,0): a down-facing normal collects the whole sky half, an
      // up-facing one collects the (black) ground half, a wall collects the
      // 50/50 blend. That is the directional's own profile with the delta
      // specular lobe - and therefore the corrugation aliasing - removed.
      // During a strike the light bouncing off the apron IS the strike's light,
      // not the sodium: 30 lux of cold key against 6 lux of lamp. Leaving this
      // term warm through the flash is what inverted the grade on the lightning
      // frame - measured shadow tint +0.009 RED against a highlight tint of
      // +0.004 BLUE, i.e. warm shadows under cold highlights, which is the
      // colour grade running backwards.
      _c3.copy(HPAL.sodium).lerp(HPAL.lightning, 0.85 * f);
      this.hBounce.color.copy(_c3);
      this.hBounce.groundColor.setRGB(0, 0, 0);
      this.hBounce.intensity =
        (HB.bounce * (0.55 + 0.65 * wet) + HB.bounceFlash * fOmni) * comp;
    }

    if (this.hFillA && this.hFillB) {
      // ---- the cross-canyon pair : the term that makes a canyon read --------
      // This is the only term in the harbor fill with a real cosine on a
      // VERTICAL surface. Everything else lights up-facing or down-facing
      // geometry: the sky hemisphere gives a wall a 50/50 blend, the bounce
      // points straight down so a wall collects half of it, and the ambient is a
      // flat floor with no shape at all. A container terminal is made of nothing
      // BUT vertical surfaces, which is why the stacks printed as black cut-outs
      // before this pair existed.
      //
      // Both axes cross the yard on X, the axis the canyons run across, tilted
      // 25 deg below the horizon: a flank facing +X collects 0.95 of hFillA and
      // 0.05 of hFillB while the apron collects 0.29 of each, so the pair lifts
      // the walls roughly three times as hard as the ground and cannot flatten
      // the pools.
      //
      // They are also the two-temperature idea made into LIGHT rather than
      // grade: the +X side carries the sodium the eight mast heads are throwing
      // around the yard, the -X side the mercury off the crane and the quay
      // floods. A flank lit warm on one edge and cold on the other has a
      // readable form; a flank lit by one grey wash does not.
      _c5.copy(HPAL.sodium).lerp(HPAL.coldFill, 0.52).lerp(HPAL.lightning, 0.88 * f);
      this.hFillA.color.copy(_c5);
      this.hFillA.groundColor.copy(_c5).multiplyScalar(HB.fillBack);
      _c4.copy(HPAL.mercury).lerp(HPAL.coldFill, 0.62).lerp(HPAL.lightning, 0.90 * f);
      this.hFillB.color.copy(_c4);
      this.hFillB.groundColor.copy(_c4).multiplyScalar(HB.fillBack);
      var fb = (HB.fill + HB.fillFlash * fOmni) * comp;
      this.hFillA.intensity = fb;
      this.hFillB.intensity = fb * HB.fillBRatio;
    }

    if (this.ambient) {
      // Very low and COLD - but never zero. ART_DIRECTION_HARBOR asks for "deep
      // near-blacks" and forbids "crushed pure-black shadows with no detail" in
      // the same list, and the only way to have both is a small unconditional
      // cold floor with an extremely hard practical falloff on top. The contrast
      // comes from the ratio between the pools and this number, not from driving
      // this number to zero.
      this.ambient.color.copy(HPAL.ambient).lerp(HPAL.lightning, 0.80 * f);
      this.ambient.intensity = HB.ambient + HB.ambientFlash * fOmni;
    }
  };

  // --------------------------------------------------------------------------
  // Per-frame harbor decoration: the cones, and the emitters that blink.
  // --------------------------------------------------------------------------
  Lighting.prototype._updateHarbor = function (ctx) {
    if (!this._harborBuilt) return;
    var w = ctx && ctx.weather;
    var rain = (w && isFinite(w.rainIntensity)) ? M.clamp(w.rainIntensity, 0, 1) : 0.85;
    var fog = (w && isFinite(w.fogDensity)) ? w.fogDensity : 0;
    var t = this._t;
    var i;

    var cones = this._harborCones;
    if (cones && cones.length) {
      // More scatterers in the air, more of the beam visible side-on. Rain and
      // fog do the same job, so they add.
      var base = (HB.coneBase + HB.coneRain * rain) *
        (1 + M.clamp(fog * 6.0, 0, 0.65));
      // ---- the transmittance the SURFACES are getting ------------------------
      // sky.js's fog chunk is 1 - exp( -(d * fogDensity)^2 ), so exp( -(d*k)^2 )
      // is the matching transmittance and the beam fades into the storm at
      // exactly the rate the wall behind it does. Read from the scene rather
      // than from a constant, so retuning the weather retunes the beams.
      var fk = 0.010;
      var sky = ctx && ctx.sky;
      if (sky && isFinite(sky.fogDensityEffective) && sky.fogDensityEffective > 0) {
        fk = sky.fogDensityEffective;
      } else if (ctx && ctx.scene && ctx.scene.fog && isFinite(ctx.scene.fog.density)) {
        fk = ctx.scene.fog.density;
      }
      fk = M.clamp(fk, 0.003, 0.030);
      // Normalise both attenuation terms at HB.coneRef so the authored
      // brightness keeps meaning "this bright when the beam is a subject in the
      // near-middle ground". Without this the whole level's beams would simply
      // get dimmer and the establishing shot would be the only thing improved.
      var dRef = HB.coneRef;
      var attRef = (HB.coneFall / (HB.coneFall + Math.max(dRef - HB.coneNear, 0))) *
        Math.exp(-(fk * dRef) * (fk * dRef));
      base /= Math.max(attRef, 0.25);

      // ---- A CAP ON THE ACCUMULATED AIR GLOW --------------------------------
      // The distance term above fixes ONE shell being billed the same at 60 m
      // as at 8 m. It does not fix TWENTY of them landing on the same pixels.
      // From the elevated establishing standpoint the camera looks down the
      // axis of a dozen cones at once - which is exactly where |N.V|, and
      // therefore each shell's own opacity, is maximal - and additive blending
      // has no saturation in it: the sum just keeps climbing until the midground
      // is a flat milky veil. No amount of per-shell tuning can bound a sum.
      //
      // So the sum is bounded directly. Each shell's expected screen
      // contribution is estimated on the CPU - its own amplitude, times the
      // same attenuation the shader is about to apply at its mid-point, times
      // its screen footprint, times an axis-alignment term for the fact that a
      // beam seen end-on deposits far more than one seen side-on - and if the
      // TOTAL is over budget every shell is scaled by the same factor. Scaling
      // them all equally is what keeps it invisible: the relative brightness of
      // the beams, which is what the eye reads, does not change; only the total
      // amount of light the volumetrics may add to one frame does.
      //
      // Smoothed over ~0.25 s so walking round a corner cannot flicker it, and
      // the smoothing is skipped on the first frame so a capture (which renders
      // one frame at a fixed t) sees the converged value rather than the ramp.
      var camP = ctx && ctx.camera && ctx.camera.position;
      var fwdD = (ctx && ctx.camera && ctx.camera.getWorldDirection)
        ? ctx.camera.getWorldDirection(_v6) : null;
      var sum = 0;
      for (i = 0; i < cones.length; i++) {
        var cw = cones[i];
        var pw = cw.p;
        var litW = M.clamp(pw.light.intensity / Math.max(pw.intensity, 1e-3), 0, 2.2);
        var wgt = 0;
        if (camP && cw.mid) {
          var mdx = cw.mid.x - camP.x, mdy = cw.mid.y - camP.y, mdz = cw.mid.z - camP.z;
          var md = Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
          // Only what is IN FRONT of the eye can veil it, and the measure is the
          // shell's SCREEN SOLID ANGLE (cross-section over distance squared),
          // not its world size: that is what "how much of the frame does this
          // shell cover" means, and summing it is what tells overlap from a
          // single hero beam.
          var front = fwdD ? (mdx * fwdD.x + mdy * fwdD.y + mdz * fwdD.z) : md;
          if (md > 1e-3 && front > 0) {
            var fkd = fk * md;
            wgt = cw.gain * litW * (cw.area || 1) / (md * md) *
              (HB.coneFall / (HB.coneFall + Math.max(md - HB.coneNear, 0))) *
              Math.exp(-fkd * fkd);
            // End-on shells stack; side-on ones barely register.
            var aln = Math.abs((mdx * cw.axis.x + mdy * cw.axis.y + mdz * cw.axis.z) / md);
            wgt *= 0.35 + 0.85 * aln;
          }
        }
        sum += wgt;
      }
      var want = sum > HB.coneCap ? HB.coneCap / sum : 1;
      if (!isFinite(want)) want = 1;
      if (this._coneScale == null) this._coneScale = want;
      else this._coneScale += (want - this._coneScale) *
        M.clamp((ctx && isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 1 / 60) * 4.0, 0, 1);
      var capScale = M.clamp(this._coneScale, 0.25, 1);

      for (i = 0; i < cones.length; i++) {
        var c = cones[i];
        var p = c.p;
        var lit = M.clamp(p.light.intensity / Math.max(p.intensity, 1e-3), 0, 2.2);
        var u = c.mesh.material.uniforms;
        // Colour and level track the LIGHT, so the failing mast's cone gutters
        // with it. A beam that keeps burning while its lamp drops out is the
        // give-away that the "volumetrics" are a decal.
        u.uColor.value.copy(p.light.color);
        u.uAmt.value = base * c.gain * lit * capScale;
        u.uTime.value = t;
        u.uRain.value = rain;
        u.uAtten.value.set(HB.coneNear, HB.coneFall, fk);
        c.mesh.visible = u.uAmt.value > 0.002;
      }
      if (this.harborDiag) {
        this.harborDiag.coneSum = Math.round(sum * 1000) / 1000;
        this.harborDiag.coneScale = Math.round(capScale * 1000) / 1000;
      }
    }

    var em = this._harborEmitters;
    var defs = this._harborEmitDefs;
    if (em && em.mesh && defs) {
      for (i = 0; i < defs.length; i++) {
        var e = defs[i];
        var a = 1;
        if (e.mode === 'blink') {
          // A marine flash: sharp rise, short hold, soft decay. Never a sine -
          // a sine reads as an animation curve within about two cycles.
          var ph = ((t / e.period) + e.phase) % 1;
          if (ph < e.duty) {
            var s = ph / e.duty;
            a = 0.05 + 1.25 * M.smoothstep(0, 0.16, s) * (1 - M.smoothstep(0.45, 1.0, s));
          } else {
            a = 0.05;
          }
        } else if (e.mode === 'beacon') {
          // A rotating amber beacon sweeping past the camera.
          var sw = Math.sin((t / e.period + e.phase) * Math.PI * 2);
          a = 0.07 + 1.3 * Math.pow(M.saturate(sw), 5);
        } else if (e.mode === 'pulse') {
          a = 0.78 + 0.28 * this.noise.perlin2(t * 0.62 + e.phase * 11.3, 5.5);
        }
        _c1.copy(e.color).multiplyScalar(e.gain * a * 2.4);
        em.mesh.setColorAt(i, _c1);
      }
      if (em.mesh.instanceColor) em.mesh.instanceColor.needsUpdate = true;
    }
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
      // The harbor rig has to exist BEFORE the sky-visibility bake, because the
      // bake is what builds the bulb/halo instance buffers and those are sized
      // from the practical count.
      this._buildHarborRig(ctx);
      this._adoptLevelPracticals(ctx);
      // A rig override published by the LEVEL (as opposed to by its env
      // profile) can only be read once level.js has built. Before _readSky, so
      // the override is in force for the very first frame that uses it.
      this._adoptLevelRig(ctx);
      this._buildSkyVisibility(ctx);
      this._probeSkyVisibility(ctx, dt);
      this._readSky(ctx);
      this._updateFill(ctx);
      this._updatePracticals(ctx);
      this._updateLampVisuals(ctx);
      this._updateHarbor(ctx);
      this._updateShafts(ctx);
      this._updateRigBeams(ctx);
      this._applyCookieUniform();
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

    // ---- declarative rig: trim (or delete) the key -------------------------
    // Applied here, to the FINISHED key, rather than in each consumer, so the
    // cascades, the ground/facade bounce, the solar shafts and the viewmodel
    // all follow from one number instead of forming three separate opinions
    // about what time it is. Unreachable on market and harbor.
    if (this._declarative) {
      var kmul = this.interior ? 0 : (this._rigP ? this._rigP.key : 1);
      if (kmul !== 1) this.keyIntensity = M.clamp(this.keyIntensity * kmul, 0, 40);
    }

    // COLD HARBOR: there is no sun and no moon. Everything computed above is
    // discarded and the key becomes the lightning strike, driven off
    // ctx.weather. Level 1 never enters this branch.
    if (this.isHarbor) this._harborKey(ctx);

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

    // ---- declarative rig ----------------------------------------------------
    // P is null on market and harbor, and every use of it below is guarded, so
    // the legacy path runs untouched. Inside an interior the compensation is
    // dropped to 1: the volume's floor has been raised to INT_SV_FLOOR, so it
    // is barely attenuating anything and compensating for an occlusion that is
    // not being applied would simply over-brighten the level.
    var P = this._applyRigLights(ctx);
    if (P && this.interior) { comp = 1; compD = 1; }

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
      if (P) {
        if (this.interior) {
          // Nothing above this level is sky, so the hemisphere stops sampling
          // an atmosphere the player can never see and becomes what it really
          // is down here: a low, near-neutral, cool-over-warm ambient with a
          // vertical gradient. A gradient, not a constant - a flat ambient is
          // the "no shape anywhere" failure, and a HemisphereLight is the one
          // fill in three that gives shape without a specular lobe to alias.
          this.hemi.color.copy(INT_SKY_COL);
          this.hemi.groundColor.copy(INT_GND_COL);
          this.hemi.intensity = INT_HEMI;
        } else {
          this.hemi.intensity *= P.sky;
        }
      }
    }

    // The PMREM environment is the last unshadowed infinite term in the build.
    // It is gated per fragment by the volume like everything else, so it takes
    // the same compensation; the night scale is what stops sky.js's bright
    // after-dark dome from lighting the street like an overcast afternoon.
    if (ctx.scene && ctx.scene.isScene) {
      ctx.scene.environmentIntensity = comp * M.lerp(1.0, NIGHT_ENV_SCALE, night);
      // Buried levels see no sky, so the PMREM dome must not light them - but
      // it is not taken to zero either. Without SOMETHING in the environment
      // slot every metal surface in the build reads as flat plastic
      // (ARCHITECTURE section 7.4), and a control room of dead CRTs and cable
      // trays is nearly all metal. This is the "enough for a specular response,
      // far too little to be daylight" setting.
      if (P) {
        ctx.scene.environmentIntensity = this.interior
          ? INT_ENV : ctx.scene.environmentIntensity * P.env;
      }
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
      if (P) {
        var abase = this.interior ? INT_AMB : this.ambient.intensity * P.amb;
        // ...and then the 50:1 guard on top. _rigFloor is measured off the
        // brightest practical the level actually published (see _rigMeter), so
        // this is the one place in the build where the shadow floor is derived
        // from the level's own key rather than from a constant. Capped at 2.2x
        // so a single absurd fixture cannot flood the whole level with ambient.
        this.ambient.intensity = M.clamp(this._rigFloor, abase, abase * 2.2);
        if (this.interior) this.ambient.color.copy(INT_AMB_COL);
      }
    }

    // The bounce pair survives on a 'mixedsun' rig (there IS a sun to bounce)
    // but at a reduced share, because the practicals are now carrying part of
    // the job the bounce used to do alone. On a 'practicals', 'mixed' or
    // interior rig they were already made invisible by _applyRigLights.
    if (P && P.bnc !== 1) {
      if (this.bounce) this.bounce.intensity *= P.bnc;
      if (this.fillA) this.fillA.intensity *= P.bnc;
      if (this.fillB) this.fillB.intensity *= P.bnc;
    }

    // ---- energy compensation for the directionals a rig switched off --------
    // Switching `fills` off removes an ALIASING SOURCE, not a design decision
    // about how much fill the level wants, so the diffuse energy those three
    // lights would have delivered is handed to the hemisphere instead. Without
    // this, moving 'mixed' to fills:false would have silently darkened the one
    // level on that rig that was not complaining (highrise) in order to fix the
    // one that was.
    //
    // It is a SEPARATE HemisphereLight rather than a scale on the main one, and
    // both halves of that matter:
    //
    //   COLOUR. The facade pair is the key filtered through sand albedo - warm,
    //   with a largest linear channel near 1.0. The main hemisphere is the
    //   atmosphere - at the refinery's dusk a violet-blue at roughly half that.
    //   Folding one into the other by INTENSITY hands the ground about half the
    //   energy it lost and changes its hue: measured, the near foreground went
    //   from 0.128 to 0.098 median and its R-B from +0.085 to +0.061, i.e. the
    //   compensation under-paid by 23% and cooled the asphalt at the same time.
    //
    //   DIRECTION. The pair arrives 29 degrees above the horizontal, so a
    //   vertical surface collects 0.88 of it and the road 0.48. The main
    //   hemisphere's axis is straight up, so it is the exact opposite - 1.0 to
    //   the road and 0.5 to a wall. Substituting one for the other would move
    //   fill OFF the vertical surfaces at the moment this file is also trying to
    //   put fill ON them.
    //
    // So this one is aimed the way the pair was: from the key's azimuth, tilted
    // BNC_TILT below the horizon, warm half toward the scene and BLACK behind.
    // A HemisphereLight cannot reach RE_Direct or RE_IndirectSpecular, which is
    // the entire reason for the substitution.
    var bnf = this.bounceFill;
    if (bnf) {
      var bnOn = !!(P && this._declarative && !this.interior &&
        P.fills === false && P.sun !== false && this.fillA && this.fillB);
      if (bnOn) {
        // Matched on the ROAD, which is the surface that must not change: the
        // pair delivered (fA+fB)*cos29 to an up-facing normal and this light
        // delivers BNC_GW of its own intensity to the same normal.
        // ...and re-based from the DIRECTIONAL compensation onto the SKYLIGHT
        // one. The two are not interchangeable: a bounce directional is gated
        // per-fragment at SV_DIR_GATE of the sky-visibility volume and carries
        // skyCompDir to match, while a hemisphere goes through `irradiance` and
        // takes the FULL gate, so it has to carry skyComp instead. Substituting
        // one for the other at the same nominal value under-pays every fragment
        // the volume is attenuating - measured on the refinery's near
        // foreground, the road came back 14% down on the control.
        var eGnd = (this.fillA.intensity + this.fillB.intensity) * 0.482 *
          (compD > 1e-4 ? comp / compD : 1);
        bnf.intensity = M.clamp(eGnd / BNC_GW, 0, 1.4);
        bnf.color.copy(this.fillA.color);
        bnf.groundColor.setRGB(0, 0, 0);
        var bkx = this._keyDir.x, bkz = this._keyDir.z;
        var bhl = Math.sqrt(bkx * bkx + bkz * bkz);
        if (bhl > 1e-4) {
          var bs = Math.sqrt(Math.max(0, 1 - BNC_TILT * BNC_TILT)) / bhl;
          bnf.position.set(bkx * bs, -BNC_TILT, bkz * bs);
        } else {
          bnf.position.set(0, -1, 0);
        }
        bnf.visible = bnf.intensity > 0.004;
      } else if (bnf.visible) {
        bnf.visible = false;
        bnf.intensity = 0;
      }
    }

    if (P && this._declarative) this._updateCharFill(ctx, P);

    // COLD HARBOR overrides every term above. It runs LAST rather than as an
    // early return so that the shared plumbing (skyComp, environmentIntensity
    // ownership, the light objects themselves) is identical for both levels and
    // there is only ever one place that writes each light.
    if (this.isHarbor) this._harborFill(ctx);
  };

  // ==========================================================================
  // The character / vertical fill. See the CFILL block above for why it exists
  // and why it is a HemisphereLight. Never reached on market or harbor.
  // ==========================================================================
  Lighting.prototype._updateCharFill = function (ctx, P) {
    var cf = this.charFill;
    if (!cf) return;
    var amt = (P && isFinite(P.cfill)) ? P.cfill : 0;
    // A fill that exists because there is no key has no business competing with
    // one, so it is scaled back where the sun is genuinely doing the sculpting.
    // That is also what keeps this term from touching a level on the 'sun' rig
    // at noon if one ever opts in.
    amt *= M.lerp(1.0, CFILL_DAY, this.dayFactor);
    if (!(amt > 0.002)) {
      if (cf.visible) { cf.visible = false; cf.intensity = 0; }
      return;
    }

    // Colour first, because the magnitude below is solved against it. The pool
    // the player is standing in, pulled well back toward neutral: a fill as
    // saturated as the lamp it came from dyes every face in the level the
    // colour of the nearest fitting.
    if (this._localE > 1e-4) {
      cf.color.copy(_c5.copy(this._localCol).lerp(_WHITE, CFILL_WHITE));
    } else if (this.hemi) {
      cf.color.copy(_c5.copy(this.hemi.color).lerp(_WHITE, CFILL_WHITE));
    }

    // ---- magnitude: matched in IRRADIANCE, not in intensity -----------------
    // three multiplies intensity by colour, so two lights at the same intensity
    // deliver wildly different amounts of light: this rig's anti-crush floor is
    // a deliberately dark teal whose largest linear channel is 0.115, while this
    // fill is near-white at ~1.0. Summing the raw intensities and calling it a
    // share of the fill over-drove it by nearly an order of magnitude - the
    // first measurement came back with the ENEMY BRIGHTER THAN THE GROUND
    // (torso 0.336 against 0.124), which is the same defect upside down. So
    // both references are converted to irradiance, combined, and converted back
    // through this light's own colour.
    var base = colMag(this.hemi ? this.hemi.color : null) *
      (this.hemi ? this.hemi.intensity : 0) * CFILL_HEMI +
      colMag(this.ambient ? this.ambient.color : null) *
      (this.ambient ? this.ambient.intensity : 0) * CFILL_AMB;
    cf.intensity = M.clamp(base * amt / Math.max(colMag(cf.color), 0.05),
      0, CFILL_MAX);
    cf.visible = cf.intensity > 0.004;
    if (!cf.visible) return;
    // The far half stays black: a fill that wraps all the way round is what
    // flattens a silhouette, and a silhouette read against a lit background is
    // the one thing this term must not damage.
    cf.groundColor.setRGB(0, 0, 0);

    // Axis: back toward the eye and CFILL_TILT below the horizon. three reads a
    // hemisphere's axis from the light's world POSITION, so this is just a
    // position write - no target, no matrix work beyond the one the rig already
    // does. Column 2 of a camera's matrixWorld is its local +Z, i.e. BACKWARD,
    // which is exactly the direction we want to lean the axis toward.
    var cam = ctx && ctx.camera;
    if (cam) {
      cam.updateMatrixWorld();
      var e = cam.matrixWorld.elements;
      var bx = e[8], bz = e[10];
      var bl = Math.sqrt(bx * bx + bz * bz);
      if (bl > 1e-4) {
        var s = Math.sqrt(Math.max(0, 1 - CFILL_TILT * CFILL_TILT)) / bl;
        cf.position.set(bx * s, -CFILL_TILT, bz * s);
      } else {
        cf.position.set(0, -1, 0);
      }
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
    // COLD HARBOR is 02:00 in a storm and has no day state at all: the terminal
    // lighting is on, permanently, and the only thing that modulates it is the
    // per-fixture failure behaviour below.
    var lampOn = this.isHarbor ? 1 : M.smoothstep(0.12, -0.22, this.solarDirection.y);
    // A declarative rig sets a FLOOR under that gate rather than replacing it.
    // An interior and a 'practicals' level have no day state at all, so their
    // floor is 1; a 'mixed' level does have one - a sunset still moves - but
    // its interior lighting is on regardless, which is the entire idea of the
    // rig. Levels on the 'sun' rig have a floor of 0 and behave exactly as the
    // market does.
    if (this._declarative) {
      var lFloor = this.interior ? 1 : (this._rigP ? this._rigP.lampFloor : 0);
      if (lFloor > lampOn) lampOn = lFloor;
    }
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
      } else if (p.kind === 'sodium_failing') {
        // ---- COLD HARBOR: the failing lamp ---------------------------------
        // A sodium head at the end of its life CYCLES: it strikes, runs, the arc
        // goes unstable, it drops out, and seconds later the ignitor fires
        // again. Two decorrelated noise fields, never a sine - a sine reads as
        // an animation curve within about two cycles, which is the whole reason
        // level 1's brazier is noise driven too.
        var s1 = this.noise.perlin2(t * 0.41 + p.phase, 13.1);
        var s2 = this.noise.fbm2(t * 3.9 + p.phase, 41.0, 3, 2, 0.55);
        var duty = M.smoothstep(-0.12, 0.20, s1);          // the slow cycle
        var arc = M.smoothstep(0.25, 0.85, duty) * (0.55 + 0.45 * s2);
        mul = M.clamp(duty * 0.50 + arc * 0.70 + s2 * 0.09, 0.02, 1.25);
        // A dying arc runs cooler and redder on the way out.
        _c1.copy(p.baseColor).lerp(_c2.setRGB(1.0, 0.34, 0.06),
          0.45 * (1 - M.saturate(mul)));
        L.color.copy(_c1);
      } else if (p.kind === 'mercury') {
        // Mercury vapour is rock steady with a faint mains ripple on it.
        mul = 1.0 + this.noise.perlin2(t * 1.9 + p.phase, 23.0) * 0.022;
        L.color.copy(p.baseColor);
      } else if (p.kind === 'fluoro_cold') {
        var g1 = this.noise.perlin2(t * 7.1 + p.phase, 5.3);
        var g2 = this.noise.perlin2(t * 0.19 + p.phase, 31.5);
        mul = 1.0 + g1 * 0.045 + g2 * 0.07;
        L.color.copy(p.baseColor);
      } else if (p.kind === 'led') {
        mul = 1.0;                                    // an LED does not flicker
        L.color.copy(p.baseColor);
      } else if (p.kind === 'nav') {
        // Slow marine navigation flash, ~4.4 s period.
        var np = ((t / 4.4) + p.phase * 0.137) % 1;
        var pulse = 0;
        if (np < 0.22) {
          var ns = np / 0.22;
          pulse = M.smoothstep(0, 0.18, ns) * (1 - M.smoothstep(0.45, 1.0, ns));
        }
        mul = 0.04 + 1.45 * pulse;
        L.color.copy(p.baseColor);
      } else if (p.kind === 'reefer') {
        // The refrigeration compressor cycles: a step change every few seconds
        // over a low electrical hum.
        var cyc = M.smoothstep(0.08, 0.34, this.noise.perlin2(t * 0.11 + p.phase, 77.0));
        mul = 0.82 + 0.26 * cyc +
          this.noise.perlin2(t * 5.5 + p.phase, 3.0) * 0.03;
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

    if (this._declarative) this._rigMeter(ctx);
  };

  // ==========================================================================
  // The declarative rig's meter.
  //
  // Two numbers, both MEASURED off the live rig rather than authored, so a new
  // level gets them right without this file being edited for it:
  //
  //   _rigFloor  the ambient floor the 50:1 lit-to-unlit rule is asking for.
  //              Cold Harbor rendered black because its masts put ~10 lux on
  //              the apron while the fill put ~0.02 lux everywhere else, and
  //              nothing in a tone curve holds 500:1 - what came back was not a
  //              moody frame, it was an empty one. So the brightest practical
  //              in the level sets a minimum for the shadow floor.
  //   _localCol  the colour and rough strength of the lamp pool the eye is
  //              standing in. On a sunless level the world key is zero, so
  //              mirroring it into the viewmodel scene prints a silhouette;
  //              the gun is really lit by whatever lamp is nearest, and this
  //              is that lamp.
  //
  // Costs one pass over at most MAX_PRACTICALS_RIG lights and allocates
  // nothing. Never called on market or harbor.
  // ==========================================================================
  Lighting.prototype._rigMeter = function (ctx) {
    var peak = 0, wsum = 0, i, p, L;
    var cam = ctx && ctx.camera;
    var cx = 0, cy = 0, cz = 0;
    if (cam) {
      cam.updateMatrixWorld();
      var e = cam.matrixWorld.elements;
      cx = e[12]; cy = e[13]; cz = e[14];
    }
    _c6.setRGB(0, 0, 0);
    for (i = 0; i < this.practicals.length; i++) {
      p = this.practicals[i];
      L = p.light;
      if (!L.visible || !(L.intensity > 0)) continue;
      // Characteristic receiver distance. A lamp with a 15 m reach is really
      // lighting ground about 5 m away, not its own filament, so measuring the
      // irradiance at 1 m would report a number no surface in the level ever
      // sees and drag the floor up by two orders of magnitude.
      var rd = Math.max(2.0, (p.distance || 10) * 0.35);
      var eLamp = L.intensity / (rd * rd);
      if (eLamp > peak) peak = eLamp;
      if (cam) {
        var dx = L.position.x - cx, dy = L.position.y - cy, dz = L.position.z - cz;
        var w = L.intensity / Math.max(1.0, dx * dx + dy * dy + dz * dz);
        _c1.copy(L.color).multiplyScalar(w);
        _c6.add(_c1);
        wsum += w;
      }
    }
    if (wsum > 1e-5) {
      this._localCol.copy(_c6).multiplyScalar(1 / wsum);
      // Guard against a fully saturated pool dyeing the weapon: a viewmodel key
      // is allowed to be tinted, not monochromatic.
      this._localCol.lerp(_WHITE, 0.22);
      this._localE = wsum;
    } else {
      this._localE = 0;
    }
    var want = peak / LIT_DARK_RATIO;
    this._rigFloor = isFinite(want) ? M.clamp(want, 0, 3.0) : 0;

    // Published for a probing critic. Mutated in place - the frame loop must
    // not allocate.
    var D = this.rigDiag;
    if (!D) D = this.rigDiag = {};
    D.rig = this.rig;
    D.interior = this.interior;
    D.practicals = this.practicals.length;
    D.shafts = this._shafts ? this._shafts.length : 0;
    D.sunOn = !!(this.cascades.length && this.cascades[0].light.visible);
    D.key = Math.round(this.keyIntensity * 1000) / 1000;
    D.peakLampE = Math.round(peak * 100) / 100;
    D.ambient = this.ambient ? Math.round(this.ambient.intensity * 1000) / 1000 : 0;
    D.hemi = this.hemi ? Math.round(this.hemi.intensity * 1000) / 1000 : 0;
    // The number the 50:1 rule is really about: brightest lamp pool over the
    // unconditional floor. Above ~50 the dark half of the frame is gone.
    D.ratio = D.ambient > 1e-4 ? Math.round(peak / D.ambient) : -1;
    // Everything a critic probing the live rig has had to reverse-engineer from
    // a screenshot so far. All of it is already computed above; publishing it
    // costs four rounds and no allocation.
    D.localE = Math.round(this._localE * 100) / 100;
    D.charFill = this.charFill && this.charFill.visible
      ? Math.round(this.charFill.intensity * 1000) / 1000 : 0;
    D.beams = this._beams ? this._beams.length : 0;
    D.cookie = this._cookie ? this._cookie.amount : 0;
    D.fills = !!(this.bounce && this.bounce.visible);
    D.over = !!this._rigOver;
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
    // ---- COLD HARBOR: the shadow budget ------------------------------------
    // Cascade 0 carries the LIGHTNING and sits at intensity 0 for roughly 97%
    // of frames, which means the cascade maps light nothing at all between
    // strikes. So the whole 4-pass CSM refresh is skipped unless a strike is
    // actually running - that, not a lower resolution, is where the harbor's
    // shadow budget comes from. The first 8 frames still render so the maps are
    // allocated and three never binds an unwritten sampler.
    if (this.isHarbor) {
      var flashing = this.flash > FLASH_ON || this._flashPrev > FLASH_ON;
      // Frames since this strike began. The direction is latched at the leading
      // edge and nothing in the terminal moves far in 60-180 ms, so the cascade
      // maps only need rendering ONCE per strike: on frame 0, right after
      // _fitCascades has re-aimed them. Re-rendering all of them on every frame
      // of the strike is what put the peak frame at 491 draw calls against a
      // ~500 budget and made the capture at t = 1.18 - dead on the peak - time
      // out where the same capture at t = 1.5 succeeded twice.
      // Not updating is SAFE, not just cheap: three only recomputes
      // shadow.matrix when it re-renders the map, so a held map and a held
      // matrix stay consistent in world space. All that ages is the coverage at
      // the very edge of a cascade as the camera walks, over a tenth of a second.
      this._flashFrames = flashing ? (this._flashFrames + 1) : 0;
      var hforce = this._frame < 8 || (flashing && this._flashFrames === 1);
      var c2;
      for (c2 = 0; c2 < this.cascades.length; c2++) {
        if (hforce) this.cascades[c2].light.shadow.needsUpdate = true;
      }
      // The two hero masts, round-robin on a 4-frame period: half a depth pass
      // per frame amortised, and a moving enemy's cast shadow lags at most
      // ~130 ms, which nobody has ever seen.
      var hero = this._harborHero;
      for (c2 = 0; c2 < hero.length; c2++) {
        var hl = hero[c2].light;
        if (!hl.castShadow || !hl.shadow) continue;
        // Never on the same frame the cascades are re-rendering: that frame is
        // already the most expensive one in the level by a wide margin.
        if (this._frame < 8 || (!hforce && (this._frame % 4) === (c2 % 4))) {
          hl.shadow.needsUpdate = true;
        }
      }
      // A harbor roof shaft is static geometry lit by a static beam.
      if (this._shafts) {
        for (c2 = 0; c2 < this._shafts.length; c2++) {
          var hs2 = this._shafts[c2].light;
          if (hs2.castShadow && this._frame < 8) hs2.shadow.needsUpdate = true;
        }
      }
      return;
    }

    var force = !!ctx.capture || this._frame < 8 || this._sunMoved;
    // A rig with no sun has already made the cascades invisible, so three never
    // renders their maps - but raising needsUpdate every frame anyway would fire
    // a full four-pass CSM refresh on whatever frame setInterior(false) is
    // called. Leave the flag where it is instead; _applyRigLights turning the
    // lights back on is what should trigger the refresh, and force covers it.
    var noSun = this._declarative &&
      (this.interior || (this._rigP && this._rigP.sun === false));
    for (var i = 0; !noSun && i < this.cascades.length; i++) {
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

    // ---- COLD HARBOR viewmodel --------------------------------------------
    // The world key here is the LIGHTNING, which is zero for ~97% of frames, so
    // mirroring it into view space would hand the weapon a 0.10 key and print a
    // silhouette. The gun is really lit by whatever lamp pool the player is
    // standing in, so it gets a fixed warm sodium key from up-and-forward, a
    // cold rim from behind, and - critically - the strike ON TOP, because a
    // flash that visibly stops at the edge of the viewmodel is worse than no
    // flash at all.
    if (this.isHarbor) {
      var hf = this.flash;
      rig.key.position.set(0.55, 1.35, 0.85).multiplyScalar(6);
      rig.key.target.position.set(0, 0, 0);
      _c5.copy(HPAL.sodium).lerp(this.keyColor, M.saturate(hf * 1.4));
      rig.key.color.copy(_c5);
      rig.key.intensity = 1.45 + HB.key * 0.36 * hf;
      rig.fill.position.set(-0.7, 0.5, -1.1).multiplyScalar(5);
      rig.fill.target.position.set(0, 0, 0);
      rig.fill.color.copy(_c5.copy(HPAL.mercury).lerp(_WHITE, 0.25));
      rig.fill.intensity = 0.34 + 1.1 * hf;
      if (rig.hemi) {
        rig.hemi.color.copy(HPAL.stormSky);
        rig.hemi.groundColor.copy(HPAL.sodium);
        rig.hemi.intensity = 0.20 + 0.9 * hf;
      }
      rig.group.updateMatrixWorld(true);
      return;
    }

    // ---- declarative rig with no usable sun --------------------------------
    // Same failure as the harbor's, arrived at from a different direction: on a
    // 'practicals' or interior rig the world key is exactly zero, so mirroring
    // it into view space hands the weapon nothing and prints a silhouette. What
    // is really lighting the gun is the lamp pool the player is standing in, so
    // that is what it gets - _rigMeter measures its colour and rough strength
    // every frame, and the key swings with it as the player walks from a red
    // alarm beacon into a green fluorescent bay.
    // ---- AND THE GATE USED TO TEST THE WRONG NUMBER ------------------------
    // It tested `this._rigP.key`, the profile's MULTIPLIER CONSTANT, instead of
    // the key that multiplier actually produced. RIGS.mixed carries key 0.62, so
    // the refinery failed the test and fell through to the world-key mirror path
    // below - but its sun sits 6.8 degrees UNDER the horizon at timeOfDay 0.88,
    // so the resolved key is 1.50 and the mirror path hands the weapon
    // 1.50 * 0.62 * 0.52 = 0.48 from a direction that is nearly horizontal and
    // behind the player. Measured across all four published gameplay poses the
    // viewmodel came back at 15-24% of frame median (hero1 0.034 against 0.217);
    // even lv_explosion, a 60 m fireball, left it at zero. The comment above
    // says a silhouetted weapon is a worse defect than an over-lit one, and the
    // refinery is the case that proves it.
    //
    // So the gate now tests the RESOLVED viewmodel key against the floor it is
    // supposed to guarantee, and only for a rig that has practicals to fall back
    // on (lampFloor > 0.5, i.e. 'practicals' and 'mixed'). A level on the 'sun'
    // rig can never reach the local path however dark it gets - it has nothing
    // local to be lit by - and highrise, the other 'mixed' level, resolves a
    // viewmodel key of 1.00 and keeps the sun-mirrored path it wants.
    var vmWorldKey = this.keyIntensity * 0.62 * vmSky *
      M.lerp(1.0, 0.52, this.nightFactor);
    var vmLocal = this._declarative && (this.interior ||
      (this._rigP && (this._rigP.key < 0.25 ||
        (this._rigP.lampFloor > 0.5 && vmWorldKey < VM_LOCAL_KEY))));
    if (vmLocal) {
      // Up, forward and slightly to the weapon side: a ceiling fitting, which
      // is what nearly every practical in an enclosed level is.
      rig.key.position.set(0.48, 1.40, 0.80).multiplyScalar(6);
      rig.key.target.position.set(0, 0, 0);
      rig.key.color.copy(this._localCol);
      // Floored well above zero for the same reason the market's is: a
      // silhouetted weapon is a worse defect than a slightly over-lit one.
      rig.key.intensity = M.clamp(0.85 + this._localE * 0.30, 0.75, 3.2);
      // A cold rim from behind so the receiver's top edge separates from a dark
      // corridor instead of merging into it.
      rig.fill.position.set(-0.75, 0.55, -1.15).multiplyScalar(5);
      rig.fill.target.position.set(0, 0, 0);
      rig.fill.color.copy(_c5.copy(this._localCol).lerp(_WHITE, 0.55));
      rig.fill.intensity = 0.30;
      if (rig.hemi) {
        rig.hemi.color.copy(this.interior ? INT_SKY_COL : (this.hemi ? this.hemi.color : INT_SKY_COL));
        rig.hemi.groundColor.copy(this.interior ? INT_GND_COL : (this.hemi ? this.hemi.groundColor : INT_GND_COL));
        rig.hemi.intensity = 0.22;
      }
      rig.group.updateMatrixWorld(true);
      return;
    }

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
    if (this.practicals.length >= this._maxPracticals()) return null;
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
    // ---- COLD HARBOR ------------------------------------------------------
    if (this._harborCones) {
      for (i = 0; i < this._harborCones.length; i++) {
        var hc = this._harborCones[i].mesh;
        if (hc.geometry) hc.geometry.dispose();
        if (hc.material) hc.material.dispose();
      }
      this._harborCones = null;
    }
    if (this._harborFixtures) {
      for (i = 0; i < this._harborFixtures.length; i++) {
        var hf = this._harborFixtures[i];
        if (hf.geometry) hf.geometry.dispose();
      }
      this._harborFixtures = null;
    }
    // Only a material this module OWNS may be disposed - the fixtures usually
    // share one out of the level's material library.
    if (this._harborOwnMat) { this._harborOwnMat.dispose(); this._harborOwnMat = null; }
    this._harborMetalMat = null;
    if (this._harborEmitters && this._harborEmitters.mesh) {
      this._harborEmitters.mesh.dispose();
      if (this._harborEmitters.mesh.material) this._harborEmitters.mesh.material.dispose();
      this._harborEmitters = null;
    }
    for (i = 0; i < this.practicals.length; i++) {
      var pl = this.practicals[i].light;
      if (pl.shadow && pl.shadow.map) { pl.shadow.map.dispose(); pl.shadow.map = null; }
    }
    this._harborHero.length = 0;
    // ---- declarative rig ---------------------------------------------------
    if (this._beams) {
      for (i = 0; i < this._beams.length; i++) {
        var bm = this._beams[i].mesh;
        if (bm.geometry) bm.geometry.dispose();
        if (bm.material) bm.material.dispose();
      }
      this._beams = null;
    }
    this.charFill = null;
    this.bounceFill = null;
    // SV_PARAMS is MODULE state shared by every material in the build, and an
    // interior rig raises its floor. Put it back: if the next level is a legacy
    // one, _applyRigLights never runs and would never restore it, and a market
    // rebuilt after a bunker would silently render with a 0.45 occlusion floor.
    // CK_PARAMS is the same kind of state for the same reason - a cookie left
    // switched on would dapple the next level's key.
    if (SV_PARAMS) SV_PARAMS[0] = SV_FLOOR;
    if (CK_PARAMS) CK_PARAMS[3] = 0;
    this._cookie = null;
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
