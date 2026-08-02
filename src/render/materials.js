// ============================================================================
// OPERATION BLACKOUT - material library
// Owner: agent 2 (src/render/materials.js) -> GAME.MaterialLibrary
//
// This is the layer that turns ctx.textures' raw PBR map sets into shaded
// surfaces. Stock MeshStandardMaterial with a 1k albedo/normal/roughness set
// looks like a 2009 game the moment the camera gets within two metres of a
// wall, so every material here is patched through onBeforeCompile with five
// features that specifically attack the ways real-time surfaces read as fake:
//
//   1. DETAIL SURFACE     - a high-frequency tile carrying normal + cavity +
//                           micro-roughness, composited with reoriented normal
//                           mapping (RNM), projected in WORLD space at a 3-6 cm
//                           period and distance-faded. Normal-only detail still
//                           reads as wet plastic because the sheen stays
//                           perfectly uniform, so this perturbs all three.
//   2. STOCHASTIC TILING  - two hash-transformed taps per map, blended with a
//                           variance-preserving mix on the cell boundary.
//                           Offsets quantise to the pattern lattice so brick
//                           courses and floor grout stay aligned. This is the
//                           only thing that actually defeats visible repeat.
//   3. MACRO VARIATION    - three octaves of world-space value noise (12 m /
//                           3 m / 1 m) driving brightness, saturation AND
//                           roughness. Brightness-only macro is invisible
//                           under a hazy sky.
//   4. TRIPLANAR          - world-space projection for ground/terrain-ish
//                           surfaces so nothing stretches over camber, ramps,
//                           rubble piles or arbitrary merged geometry.
//   5. PARALLAX OCCLUSION - stepped POM where stochastic tiling is not in play.
//   6. GROUNDING + WEAR   - dust drifted at the base of walls, settled on
//                           up-facing ledges and grime weeping under
//                           overhangs, derived from world position/normal so
//                           it needs no extra vertex attributes; plus the
//                           per-vertex grime/wet/edge-wear channel that
//                           level.js and props.js can paint.
//
// Plus per-material roughness/metalness *ranges* (remapping whatever the
// texture library hands us into a physically sensible window), MEASURED ALBEDO
// ANCHORING (the map is sampled at build time and a neutral gain solved so the
// surface lands on a physical reflectance instead of the texture colour times
// the material colour, which squares both value and chroma), an IBL safety net
// so metals are never unlit, and procedurally generated decal materials.
//
// Everything degrades: if ctx.textures is missing or throws, we synthesise a
// modest fallback map set locally so the screen still shows textured surfaces.
// Nothing in here may throw - a throw here blanks the frame for 13 other
// agents.
//
// ----------------------------------------------------------------------------
// PUBLIC API (ARCHITECTURE.md section 5 documents the first three; the rest are
// additive and nothing breaks if a consumer ignores them)
//
//   get(name, opts)          -> THREE.Material, cached and shared
//   makeTriplanar(name,opts) -> get() with world-space projection forced on
//   decalMaterial(kind)      -> bullet_hole | scorch | blood | crack
//
//   has(name)                -> bool. Is this a name the library defines?
//   maps(name, opts)         -> the RAW calibrated {map, normalMap,
//                               roughnessMap, metalnessMap, aoMap, heightMap,
//                               detailNormal} set plus userData
//                               {rough, roughFlat, ns, metal, env, ao, alb,
//                               repeat, detailKind, measured}.
//                               FOR CONSUMERS WITH THEIR OWN SHADER. get()
//                               hands back a finished material carrying this
//                               file's onBeforeCompile, so weapons.js and
//                               ai.js - both of which inject their own passes -
//                               could not use it and built bare
//                               MeshStandardMaterials with map:null instead.
//                               Several MB of gun_metal / gun_polymer /
//                               cloth_olive / cloth_tan / skin maps were being
//                               generated every boot and never sampled by
//                               anything. Take the maps, keep your shader.
//   cloth(variant, opts)     -> a hung-sheet material with a per-variant dye
//                               lot (hashed, so captures stay deterministic).
//                               Caller injects its own wind vertex shader.
//   distant(name, fogColor, metres, opts)
//                            -> a proxy material pre-faded into the aerial
//                               perspective at `metres`, in the base colour AND
//                               the env weight, so a 60 m block physically
//                               cannot out-value a 10 m sunlit wall.
//   blended(nameA, nameB, opts)
//                            -> a two-layer triplanar material lerping between
//                               two whole map sets on vertex alpha (world noise
//                               where no alpha is painted), so a road/sand
//                               transition can be painted instead of butted.
//   glass(opts), foliage(opts), emissive(hex, i, opts), wearable(name, opts)
//   uvScaleFor(name, texelsPerM), setEnvIntensity(scale), setQuality(level)
// ----------------------------------------------------------------------------
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;

  // Deterministic noise sources owned by this module. We deliberately do NOT
  // pull from ctx.rng: material construction order depends on which other
  // systems exist, and consuming the shared stream would desync every capture.
  var NOISE = new GAME.Noise(0x4D41541);          // 'MAT'
  var DECAL_SEED = 0x0DECA1;

  // ==========================================================================
  // Material definition table
  //
  // color  : the ART_DIRECTION palette entry for this surface. It is NEVER
  //          multiplied onto a map - the texture library already authors the
  //          material's colour, and multiplying squares both value and chroma
  //          (measured at 17-29x too dark on asphalt). It is used three ways:
  //          as the colour itself on the no-map fallback path, as the target
  //          CHROMATICITY for `hue` below, and as the documented opts.color
  //          override.
  // alb    : target MEAN LINEAR DIFFUSE ALBEDO. The albedo map is measured at
  //          build time and a neutral gain is solved so the surface lands on a
  //          physical reflectance (asphalt 0.07-0.12, concrete 0.20-0.30,
  //          plaster ~0.45). null = leave the map alone, which is correct for
  //          metals (where `color` is the specular F0 tint, not a diffuse
  //          albedo) and for alpha-cut maps whose mean is meaningless.
  // hue    : 0..1, how far the solved gain is allowed to become CHROMATIC, so
  //          the surface's mean lands on the palette hue in `color` instead of
  //          on whatever hue the texture happened to be authored in. 0 (the
  //          default) keeps the old strictly-neutral gain.
  //
  //          This is not the squaring bug coming back. That bug multiplied a
  //          tint onto a map that already carried it. This SOLVES a per-channel
  //          gain from the measured mean and then renormalises so the mean
  //          LUMINANCE still lands exactly on `alb` - the map's own hue
  //          variation survives around the new mean rather than being stacked
  //          on top of it, and each channel is clamped to 0.45-2.2x the neutral
  //          gain so a tint can never run away.
  //
  //          Why it matters: measured across the whole library, every ground
  //          and wall surface came out of textures.js in one narrow sun-baked
  //          tan. Concrete sat at chromaticity deviation 0.018 from its palette
  //          entry, tile 0.078 and asphalt 0.070 - and asphalt was WARMER than
  //          concrete when #3e3f42 is a cool grey. That is why the chart read
  //          as "many spheres are near-identical" and why every facade in
  //          overview.png read as the same oatmeal. Opt in wherever the palette
  //          is the point; leave it at 0 for anything whose mean is meaningless
  //          (the striped awning) or already correct (sand, dirt, wood).
  // tex    : name to ask ctx.textures for, when it differs from the key. The
  //          texture library only implements a subset of these names; without
  //          this every unlisted name silently fell back to `concrete`.
  // rough  : [min, max] window the sampled roughness map is remapped into.
  // roughFlat : roughness used when no roughness map exists at all.
  // metal  : metalness scalar (metalness maps are not part of the contract).
  // ns     : normalScale.
  // ao     : aoMapIntensity (kept < 1 - crushed AO is the #1 amateur tell).
  // env    : envMapIntensity.
  // repeat : tiling. For triplanar surfaces this is literally tiles per world
  //          metre. For UV-mapped surfaces it multiplies whatever the consumer
  //          put in the uv attribute - level.js runs Geo.worldUV(geo, surf.uv)
  //          first, so the effective density is tier * repeat * surf.uv. Every
  //          value here is solved for ~500 texels per world metre (see the
  //          per-entry comment), which is what stops brick reading finer than
  //          the plaster it is set into.
  // detail : detail strength. detailCm = world-space period of the detail
  //          layer in centimetres (micro detail is 3-8 cm, not 20).
  // wdet   : sample the detail layer in WORLD space instead of UV space, so
  //          its scale is independent of whatever UVs the consumer supplies.
  //          Only for static geometry - world-space detail on a moving object
  //          swims across the surface.
  // macro  : macro colour/roughness-variation amount.
  // tri    : default to triplanar projection.
  // pom    : parallax depth in UV units (0 disables).
  // stoch  : stochastic (repetition-breaking) tiling. rot = allowed rotation
  //          steps (0 offset-only, 2 = +180deg, 4 = +90deg steps); q = offset
  //          quantisation in tile fractions, so patterns with a lattice (brick
  //          courses, floor grout, corrugation ribs) stay aligned across cells.
  //          DEFAULTS TO 0. Rotation is opt-IN because almost every authored
  //          map in this game is gravity-directional: drips run down, rust
  //          weeps down, plaster spalls downward, sand bleeds down out of a
  //          sandbag. A 90-degree cell rotation runs that weathering sideways
  //          and upside-down, which measured as gy/gx = 1.35 on the alley wall
  //          (horizontal streaks) against 0.56 in the source map (vertical).
  // dir    : the source map is gravity-directional -> force rot 0 and use the
  //          horizontal MIRROR for variety instead, which preserves the
  //          vertical axis exactly. (A mirror about the tile origin also
  //          preserves any offset lattice, so stochQ still holds.)
  // flat   : strength of the TILE LOW-PASS DIVISION applied before the
  //          stochastic blend (0..1, default 0.85). Randomly offsetting a tile
  //          whose own large-scale mean is not uniform lands a different big
  //          blotch in every cell, which is what read as "a repeating
  //          patchwork of dark rectangles". Dividing each tap by a 16x16
  //          low-pass of its own tile makes the per-cell mean uniform, and the
  //          large-scale variation comes back from gbMacroNoise, which is
  //          world-space and does not tile.
  // ground : world-space grounding wear - dust drifted at the base of walls,
  //          settled on up-facing surfaces, grime weeping under ledges.
  // meso   : MESO (0.1-0.6 m) surface band amount. Nothing else in the
  //          pipeline authors it: the detail layer is a 5 cm period that fades
  //          out by 26 m, gbMacroNoise's octaves are 11.6/3.1/1.0 m, and the
  //          base maps minify to their mean past ~5 m. Everything between
  //          5 cm and 1 m was a hole, which is why the mid-ground read as
  //          mush. Projected in world space off the shared detail tile, so it
  //          costs one extra fetch and carries normal + cavity + roughness.
  // detailKind : which FAMILY of micro-surface this material is made of -
  //          'mineral' (worley pore + angular chip + sand grain), 'woven'
  //          (thread-crossing lattice with hashed slubs), 'metal'
  //          (unidirectional broach striation + bead-blast peen) or 'organic'
  //          (pore + fine crease). Until this existed the whole library shared
  //          ONE detail tile, which is a large part of why concrete, plaster,
  //          sand and sandbag read as the same substance. Defaults to
  //          'mineral'. Also selects the near tier (see _makeDetail2).
  // polish : 0..1 weight of the GLOSS mask - the symmetric counterpart to the
  //          grime/settle/weep pulls. Proud crests inside a low-frequency zone
  //          field (traffic path on floors, burnish where hands go, glaze on
  //          tile faces, rain-slick on horizontal ground) are pulled TOWARD
  //          gloss. Without it every roughness modifier in the shader pushed
  //          one way and every surface in the library drifted to chalk, which
  //          is why not one of the sixteen chart samples produced a specular
  //          highlight.
  // dust   : the colour the grounding/macro dust layer tints toward. Defaults
  //          to a neutral tan; the road wants the sand palette so drifted dust
  //          actually reads as the sand it blew off.
  // triWarp: [x,y,z] world-space domain-warp amplitude, in TILES, applied to
  //          the triplanar projection. Triplanar has no stochastic tiling (six
  //          taps per map is not affordable), so without this the ground and
  //          the walls repeat on a perfectly regular lattice. A smooth warp at
  //          a ~6 m period costs two value-noise evaluations, no extra fetches
  //          and has no cell boundary to blend across. Set the component along
  //          a pattern's structural axis to 0 (brick courses must stay level).
  // ==========================================================================
  var DEFS = {
    // 512 tier, triplanar -> 1.0 tiles/m = 512 texels/m
    concrete: {
      color: 0x9a958c, alb: 0.20, hue: 0.90, rough: [0.46, 0.97], roughFlat: 0.92, metal: 0.0,
      ns: 1.15, ao: 0.9, env: 1.0, repeat: 1.0,
      detail: 0.85, detailCm: 5, wdet: true, macro: 0.20, tri: true, pom: 0.014,
      detailKind: 'mineral', polish: 0.50, triWarp: [0.40, 0.40, 0.40], chroma: 0.78,
      ground: true, groundAmt: 0.42
    },
    // 1024 tier, TRIPLANAR at 0.49 tiles/m = 501 texels/m.
    // Was tri:false with repeat 1.44 and a documented level uv of 0.34. The
    // level did not hit it: measured screen-space detail period in
    // interior.png was 30 px on a 1.2 m wall against 180 px on a 5 m pier,
    // i.e. the NEAR surface carried six times finer detail than the far one,
    // which is impossible under consistent world scaling. World projection
    // takes the scale away from the consumer's uv attribute entirely, so a
    // mis-UV'd wall physically cannot happen. repeat is now tiles per metre.
    concrete_wall: {
      color: 0xa39c90, alb: 0.24, hue: 0.60, rough: [0.36, 0.96], roughFlat: 0.9, metal: 0.0,
      ns: 1.3, ao: 0.9, env: 1.0, repeat: 0.49,
      detail: 0.95, detailCm: 5, wdet: true, macro: 0.24, tri: true, triSharp: 9.0, pom: 0,
      detailKind: 'mineral', polish: 0.38, triWarp: [0.46, 0.46, 0.46], chroma: 0.62,
      stoch: true, dir: true, stochQ: [0, 7], flat: 0.85,
      meso: 0.85, ground: true
    },
    // 1024 tier, TRIPLANAR at 0.49 tiles/m = 501 texels/m (see concrete_wall).
    plaster: {
      color: 0xd9c3a0, alb: 0.42, hue: 0.40, rough: [0.36, 0.94], roughFlat: 0.86, metal: 0.0,
      ns: 1.05, ao: 0.85, env: 1.0, repeat: 0.49,
      detail: 0.85, detailCm: 5, wdet: true, macro: 0.26, tri: true, triSharp: 9.0, pom: 0,
      // The single worst tiling offender in the build: genPlaster's spectral
      // energy peaks in the 512-128 texel band, i.e. blotches the size of the
      // tile itself, and it is the most-visible material in the frame. On the
      // triplanar path the domain warp plus the tile low-pass do that job.
      detailKind: 'mineral', polish: 0.42, triWarp: [0.50, 0.50, 0.50], chroma: 0.82,
      stoch: true, dir: true, flat: 0.92, meso: 1.0, ground: true
    },
    // 1024 tier, TRIPLANAR at 0.69 tiles/m. genBrick lays 12 courses per tile,
    // so that is a 12 cm course - and 711 texels/m.
    brick: {
      // Only a partial chromatic anchor: the map's brick-to-brick colour
      // lottery is the character of the material, and pulling the mean all the
      // way onto one terracotta would flatten it.
      color: 0x8e5b45, alb: 0.15, hue: 0.42, rough: [0.36, 0.95], roughFlat: 0.88, metal: 0.0,
      ns: 1.35, ao: 0.95, env: 1.0, repeat: 0.69,
      detail: 0.85, detailCm: 5, wdet: true, macro: 0.21, tri: true, triSharp: 9.0, pom: 0,
      // Y warp is deliberately ZERO: displacing the vertical axis of a brick
      // map bends the courses. Warping only the two horizontal axes slides the
      // pattern ALONG its courses, which breaks the lattice without ever
      // making a course wander.
      detailKind: 'mineral', polish: 0.34, triWarp: [0.55, 0.0, 0.55],
      stoch: true, dir: true, stochQ: [4, 12], flat: 0.45, meso: 0.7, ground: true
    },
    // 512 tier, level uv 0.90 -> 1.09 * 0.90 = 0.98 tiles/m = 502 texels/m
    rusted_metal: {
      color: 0x7a4630, alb: null, hue: 0.35, rough: [0.42, 0.92], roughFlat: 0.72, metal: 0.70,
      ns: 1.2, ao: 0.9, env: 0.95, repeat: 1.09,
      detail: 0.7, detailCm: 4, wdet: true, macro: 0.16, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.35,
      // Rust weeps DOWN from bolts and seams; rot 4 was running it sideways.
      stoch: true, dir: true, flat: 0.7, meso: 0.6
    },
    // Painted steel is NOT a bare metal: the enamel is a dielectric and only
    // the chipped areas are conductive, which the texture's own metalness
    // channel already encodes - so unlike the other metals this one does get a
    // diffuse anchor. It needed one: genPaintedMetal authors sun-faded ochre
    // enamel whose mean measured 0.324 linear, making PAINT MTL the brightest
    // sample in the chart's second row (0.855 screen luminance) and putting
    // every AC unit, shutter and sign panel in the level ABOVE the plaster
    // behind it. props.js multiplies its per-instance tints onto the library's
    // calibrated gain by contract, so anchoring here carries through cleanly.
    painted_metal: {
      color: 0x4a5058, alb: 0.25, hue: 0.35, rough: [0.20, 0.72], roughFlat: 0.45, metal: 0.9,
      ns: 0.7, ao: 0.85, env: 1.05, repeat: 1.09,
      detail: 0.5, detailCm: 4, wdet: true, macro: 0.12, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.62,
      stoch: true, dir: true, flat: 0.7, meso: 0.45
    },
    // genCorrugated lays 6 ribs per tile; 1.9 * 0.75 = 1.43 tiles/m -> 12 cm
    // rib pitch, which is a real sheet profile. Offsets quantise to the rib.
    corrugated_metal: {
      color: 0x6a6b66, alb: null, hue: 0.55, rough: [0.26, 0.82], roughFlat: 0.58, metal: 0.88,
      ns: 1.0, ao: 0.9, env: 1.05, repeat: 1.9,
      detail: 0.6, detailCm: 4, wdet: true, macro: 0.14, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.60,
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.4
    },
    // hero close-range asset: 1024 * 3.0 = 3072 texels/m, deliberately dense
    gun_metal: {
      color: 0x2a2c30, alb: null, hue: 0.50, rough: [0.18, 0.58], roughFlat: 0.35, metal: 1.0,
      ns: 0.9, ao: 0.85, env: 1.1, repeat: 3.0,
      detail: 0.55, detailTile: 26, macro: 0.06, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.70
    },
    // 512 tier, level uv 0.85 -> 1.15 * 0.85 = 0.98 tiles/m = 501 texels/m
    wood_plank: {
      color: 0x6b5540, alb: 0.13, hue: 0.30, rough: [0.44, 0.90], roughFlat: 0.78, metal: 0.0,
      ns: 1.0, ao: 0.9, env: 0.95, repeat: 1.15,
      detail: 0.7, detailCm: 4, wdet: true, macro: 0.17, tri: false, pom: 0.010,
      detailKind: 'mineral', polish: 0.45,
      meso: 0.5
    },
    sand: {
      color: 0xc9b08a, alb: 0.30, hue: 0.45, rough: [0.82, 1.0], roughFlat: 0.98, metal: 0.0,
      ns: 0.95, ao: 0.8, env: 0.9, repeat: 1.0,
      detail: 1.0, detailCm: 4, wdet: true, macro: 0.24, tri: true, pom: 0.010,
      // Sand is the one surface that genuinely has no gloss story - it stays
      // the chart's diffuse reference.
      detailKind: 'mineral', polish: 0.0, triWarp: [0.42, 0.42, 0.42],
      meso: 1.0, ground: true, groundAmt: 0.22
    },
    // The roof deck (level.js 'rooffelt') and every gravel path run on this,
    // and the roof is the emptiest hero framing in the build - meso is what
    // puts joints, patches and blisters into a 20 m expanse at 8 m range.
    gravel: {
      color: 0x8d857a, alb: 0.16, hue: 0.55, rough: [0.45, 1.0], roughFlat: 0.96, metal: 0.0,
      ns: 1.45, ao: 1.0, env: 0.9, repeat: 1.0,
      detail: 1.0, detailCm: 5, wdet: true, macro: 0.24, tri: true, pom: 0.040,
      detailKind: 'mineral', polish: 0.24, triWarp: [0.44, 0.44, 0.44],
      meso: 1.15
    },
    // 1024 tier, triplanar -> 0.5 tiles/m = 512 texels/m, 2 m tile
    // Road tar. The old anchor - alb 0.075 with hue 0.85 onto #3e3f42 - was
    // the lowest reflectance in the library and it is the LARGEST surface in
    // every frame: measured 0.0040 linear mean in enemy_closeup.png (sd
    // 0.0059) and 0.0025 at night, i.e. a flat black plane with no readable
    // material, and it killed the warm bounce ART_DIRECTION asks for on lower
    // surfaces. Weathered urban asphalt with desert sand blown over it
    // measures 0.12-0.18. The hue pull is also way down: at 0.85 nothing of
    // the sand drift survived, which is why the road read as cold blue-black
    // beside a warm kerb. groundAmt is nearly doubled and its dust colour is
    // keyed to the sand palette so gutters, camber and kerb line pick up warm
    // drift - "sand drifted into corners", straight out of the art direction.
    asphalt: {
      color: 0x3e3f42, alb: 0.125, hue: 0.45, rough: [0.24, 0.98], roughFlat: 0.93, metal: 0.0,
      ns: 1.15, ao: 0.9, env: 0.95, repeat: 0.5,
      detail: 0.9, detailCm: 5, wdet: true, macro: 0.20, tri: true, pom: 0.014,
      detailKind: 'mineral', polish: 0.62, triWarp: [0.40, 0.40, 0.40],
      dust: 0xc9b08a,
      meso: 1.0, ground: true, groundAmt: 0.60
    },
    dirt: {
      color: 0x6d5a44, alb: 0.09, hue: 0.45, tex: 'dirt_ground',
      rough: [0.68, 1.0], roughFlat: 0.97, metal: 0.0,
      ns: 1.2, ao: 0.95, env: 0.9, repeat: 1.0,
      detail: 1.0, detailCm: 5, wdet: true, macro: 0.24, tri: true, pom: 0.016,
      detailKind: 'mineral', polish: 0.18, triWarp: [0.44, 0.44, 0.44],
      meso: 1.0
    },
    // genRubble (textures.js) is angular slab fragments with exposed aggregate
    // and rebar. This used to point at 'gravel' - uniform round pebbles - and
    // threw the whole recipe away while still paying to generate it.
    rubble: {
      color: 0x8a8378, alb: 0.17, hue: 0.55, tex: 'rubble',
      rough: [0.62, 1.0], roughFlat: 0.96, metal: 0.0,
      ns: 1.4, ao: 1.0, env: 0.9, repeat: 1.0,
      detail: 1.0, detailCm: 5, wdet: true, macro: 0.22, tri: true, pom: 0.030,
      detailKind: 'mineral', polish: 0.24, triWarp: [0.44, 0.44, 0.44],
      meso: 1.1
    },
    // genTile lays 4 tiles per texture tile; 1.15 * 0.85 = 0.98 tiles/m gives
    // 25 cm floor tiles. Offsets quantise to a tile so the grout stays a grid.
    // roughRange used to be [0.14,0.62] which made the shop floor a mirror.
    // Glazed floor tile is a pale near-neutral. It was measuring as the second
    // most yellow surface in the library (chromaticity deviation 0.078 from
    // the palette), which is why the shop floor read as sand rather than as a
    // tiled interior.
    tile: {
      color: 0xb9b3a6, alb: 0.19, hue: 0.85, rough: [0.12, 0.92], roughFlat: 0.62, metal: 0.0,
      ns: 0.55, ao: 0.85, env: 0.8, repeat: 1.15,
      detail: 0.5, detailCm: 4, wdet: true, macro: 0.20, tri: false, pom: 0.008,
      // Glazed tile is the one interior surface that SHOULD have a hot
      // highlight; the polish mask is what puts the glaze back on the faces
      // while the grout between them stays matte.
      detailKind: 'mineral', polish: 0.78,
      // Floor tile has a lattice AND directional wear (traffic polish and
      // grout staining follow the room, not the cell), so mirror-only.
      stoch: true, dir: true, stochQ: [4, 4], flat: 0.55, meso: 0.6,
      ground: true, groundAmt: 0.38, groundH: 0.5, groundWeep: 0.2
    },
    stone: {
      color: 0x8f8a80, alb: 0.22, hue: 0.60, tex: 'stone',
      rough: [0.42, 0.94], roughFlat: 0.85, metal: 0.0,
      ns: 1.25, ao: 0.95, env: 1.0, repeat: 1.0,
      detail: 0.9, detailCm: 5, wdet: true, macro: 0.20, tri: true, pom: 0.024,
      detailKind: 'mineral', polish: 0.42, triWarp: [0.44, 0.44, 0.44],
      meso: 0.9, ground: true
    },
    fabric: {
      // hue was absent, so solveChroma never ran and FABRIC's chromaticity
      // matched SAND's to within 2% - seven "distinct" material families all
      // inside a few percent of one warm tan. It is deliberately WEAK though:
      // genFabric is the striped market awning and ART_DIRECTION asks for
      // "faded red/ochre/teal stripes", so pulling its mean hard onto one
      // terracotta throws away the only teal in the street. 0.15 moves it off
      // sand's chromaticity without eating the stripes.
      color: 0x9a5a48, alb: 0.16, hue: 0.15, rough: [0.55, 1.0], roughFlat: 0.95, metal: 0.0,
      ns: 1.0, ao: 0.85, env: 0.85, repeat: 0.93,
      detail: 0.6, detailTile: 34, macro: 0.15, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.18,
      sheen: 0.32
    },
    canvas_awning: {
      color: 0xa8503c, alb: 0.15, hue: 0.28, tex: 'cloth_canvas',
      rough: [0.62, 1.0], roughFlat: 0.96, metal: 0.0,
      ns: 1.0, ao: 0.85, env: 0.85, repeat: 1.0, side: 2,
      detail: 0.6, detailTile: 30, macro: 0.17, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.18,
      sheen: 0.4
    },
    rubber: {
      color: 0x26282b, alb: 0.030, hue: 0.60, rough: [0.45, 0.95], roughFlat: 0.85, metal: 0.0,
      ns: 0.9, ao: 0.9, env: 0.85, repeat: 1.6,
      detail: 0.7, detailTile: 22, macro: 0.08, tri: false, pom: 0,
      detailKind: 'mineral', polish: 0.30
    },
    plastic: {
      color: 0x5b6068, alb: 0.10, hue: 0.35, tex: 'gun_polymer',
      rough: [0.24, 0.72], roughFlat: 0.48, metal: 0.0,
      ns: 0.7, ao: 0.85, env: 0.95, repeat: 1.4,
      detail: 0.4, detailTile: 22, macro: 0.09, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.50
    },
    // Glazing. The albedo map carries the grime story in RGB *and* alpha, so
    // this is transparent by default - an opaque pane is a grey cardboard
    // rectangle, which is exactly how every shopfront was reading.
    glass: {
      color: 0xcfd8dc, alb: null, hue: 0.40, rough: [0.05, 0.62], roughFlat: 0.10, metal: 0.0,
      ns: 0.45, ao: 0.4, env: 1.6, repeat: 2.5,
      detail: 0.2, detailCm: 3, wdet: true, macro: 0.10, tri: false, pom: 0,
      detailKind: 'mineral', polish: 0.55,
      ground: true, groundAmt: 0.65, groundH: 1.9, groundWeep: 0.85,
      transparent: true, opacity: 0.26, side: 2, premul: true
    },
    foliage: {
      color: 0x6b7248, alb: null, hue: 0.55, rough: [0.45, 0.95], roughFlat: 0.85, metal: 0.0,
      ns: 0.85, ao: 0.8, env: 0.95, repeat: 1.0, side: 2,
      detail: 0.45, detailTile: 20, macro: 0.18, tri: false, pom: 0,
      detailKind: 'organic', polish: 0.30
    },
    // textures.js genRipstop authors these as two SEPARATE dye lots with
    // different thread pitches, exactly so a chest rig over a shirt never
    // reads as one continuous surface. Both used to redirect to
    // 'cloth_canvas', and because a mapped material only solves a NEUTRAL
    // gain, that made the militia's olive rig and tan gear literally the same
    // cloth at two brightnesses - the direct cause of the "untextured clay"
    // read on the enemy.
    cloth_olive: {
      color: 0x555b3c, alb: 0.075, hue: 0.45, tex: 'cloth_olive',
      rough: [0.66, 1.0], roughFlat: 0.94, metal: 0.0,
      ns: 1.15, ao: 0.85, env: 0.85, repeat: 2.2,
      detail: 0.65, detailTile: 24, macro: 0.12, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.20,
      sheen: 0.3
    },
    cloth_tan: {
      color: 0x8d7a58, alb: 0.17, hue: 0.40, tex: 'cloth_tan',
      rough: [0.66, 1.0], roughFlat: 0.94, metal: 0.0,
      ns: 1.15, ao: 0.85, env: 0.85, repeat: 2.2,
      detail: 0.65, detailTile: 24, macro: 0.12, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.20,
      sheen: 0.3
    },
    skin: {
      color: 0x9c7050, alb: 0.22, hue: 0.45, rough: [0.30, 0.66], roughFlat: 0.5, metal: 0.0,
      ns: 0.7, ao: 0.7, env: 1.0, repeat: 2.0,
      detail: 0.5, detailTile: 26, macro: 0.07, tri: false, pom: 0,
      detailKind: 'organic', polish: 0.45
    },
    // textures.js genSandbag (line ~2116) is a proper hessian: thick uneven
    // jute slub, weave gaps, UV rot, and fill sand bleeding out through the
    // weave and streaking down the face. This def used to point at 'fabric',
    // which is genFabric - a MULTICOLOUR STRIPED MARKET AWNING (salmon /
    // cream / teal / ochre vertical bands). That is why the revetment
    // photographed as a running-bond grid of flat olive and mustard blocks.
    //
    // alb is deliberately 0.30 (pale sun-bleached hessian) rather than the old
    // 0.22: it is physically right, AND it pushes the solved neutral gain past
    // 1.48, which is the point at which level.js's SACK_TARGET correction
    // (_albedoCorrection, clamped 0.3..5 per channel) saturates to a NEUTRAL
    // 0.3 on all three channels instead of applying a 2.31x blue gain that
    // only ever existed to fight the awning stripes. See the report: that hack
    // should now be deleted outright, and SURF.sandbag.base moved to
    // 'sandbag'.
    sandbag: {
      color: 0xa08f6c, alb: 0.30, hue: 0.40, tex: 'sandbag',
      rough: [0.70, 1.0], roughFlat: 0.96, metal: 0.0,
      ns: 1.25, ao: 0.95, env: 0.9, repeat: 1.1,
      detail: 0.8, detailTile: 28, macro: 0.20, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.14,
      // Sand bleeds DOWNWARD out of a split seam, so mirror-only.
      stoch: true, dir: true, flat: 0.6, ground: true
    },

    // ------------------------------------------------------------------------
    // Hung laundry. props.js used to hand-roll this from a local canvas
    // (#cfc6b6 base, roughness 0.9, envMapIntensity 1.15, no roughness map, no
    // sheen, no albedo anchor) and it was the flattest asset in the build: in
    // alley.png the sheets measured rgb [0.080 0.093 0.134] with zero
    // structure at any frequency, and at night they were the brightest object
    // in the upper frame. env is 0.75, NOT 1.15 - a sheet lit almost entirely
    // by sky at env 1.15 with a 0.62 albedo is exactly why the washing
    // photographed as paper. Use MaterialLibrary.cloth(variant).
    // tex prefers a dedicated 'cloth_sheet' recipe if textures.js has one and
    // degrades to the canvas weave if it does not (see _texName).
    // ------------------------------------------------------------------------
    laundry: {
      color: 0x8a8478, alb: 0.30, hue: 0.35, tex: 'cloth_sheet', texAlt: 'cloth_canvas',
      rough: [0.62, 1.0], roughFlat: 0.92, metal: 0.0,
      ns: 1.4, ao: 0.9, env: 0.75, repeat: 1.0, side: 2,
      detail: 0.7, detailTile: 40, macro: 0.22, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.16,
      sheen: 0.5, sheenColor: 0xc8bca6,
      stoch: true, dir: true, flat: 0.5
    },

    // ------------------------------------------------------------------------
    // Distant-proxy tier. The far city blocks in rooftop.png measure 0.324 and
    // 0.295 linear against 0.117 on the fully-textured sunlit hero facade in
    // the same frame and 0.228 on the sky beside them - the least-finished
    // asset in the shot is 2.8x brighter than the most-finished one and has no
    // aerial perspective at all. Consumers should take this through
    // MaterialLibrary.distant('far_facade', fogColor, metres), which pre-lerps
    // the solved base colour into the fog so a 60 m proxy physically cannot
    // out-value a 10 m sunlit wall.
    // ------------------------------------------------------------------------
    far_facade: {
      color: 0x9a9184, alb: 0.16, hue: 0.55, tex: 'far_facade', texAlt: 'plaster',
      rough: [0.80, 0.98], roughFlat: 0.94, metal: 0.0,
      ns: 0.35, ao: 0.6, env: 0.5, repeat: 0.25,
      detail: 0, macro: 0.30, tri: true, triSharp: 6.0, pom: 0,
      detailKind: 'mineral', polish: 0.0, triWarp: [0.35, 0.0, 0.35]
    },

    // ------------------------------------------------------------------------
    // Genuinely COOL surfaces. Measured on the seven pale chart plates, seven
    // material families sat inside a few percent of one warm tan (R/G 1.15 to
    // 1.21, G/B 1.07 to 1.21), so the street had no hue axis at all and the
    // sky was the only non-tan thing in frame. These reuse painted_metal's and
    // plaster's existing map sets through the albedoTarget path, which solves
    // a per-channel gain from a measurement and preserves the map's own
    // variation - so they cost no extra VRAM and no extra generation time.
    // level.js / props.js: paint shopfronts, shutters and a facade or two.
    // ------------------------------------------------------------------------
    paint_blue: {
      color: 0x4d6b78, alb: 0.16, hue: 0.85, tex: 'painted_metal',
      rough: [0.20, 0.72], roughFlat: 0.45, metal: 0.55,
      ns: 0.7, ao: 0.85, env: 1.05, repeat: 1.09,
      detail: 0.5, detailCm: 4, wdet: true, macro: 0.14, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.58,
      stoch: true, dir: true, flat: 0.7, meso: 0.45
    },
    paint_green: {
      color: 0x566b4e, alb: 0.15, hue: 0.85, tex: 'painted_metal',
      rough: [0.20, 0.72], roughFlat: 0.45, metal: 0.55,
      ns: 0.7, ao: 0.85, env: 1.05, repeat: 1.09,
      detail: 0.5, detailCm: 4, wdet: true, macro: 0.14, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.58,
      stoch: true, dir: true, flat: 0.7, meso: 0.45
    },
    lime_wash: {
      color: 0xc4cbcb, alb: 0.34, hue: 0.80, tex: 'plaster',
      rough: [0.40, 0.95], roughFlat: 0.88, metal: 0.0,
      ns: 1.05, ao: 0.85, env: 1.0, repeat: 0.49,
      detail: 0.85, detailCm: 5, wdet: true, macro: 0.26, tri: true, triSharp: 9.0, pom: 0,
      detailKind: 'mineral', polish: 0.36, triWarp: [0.50, 0.50, 0.50],
      stoch: true, dir: true, flat: 0.92, meso: 1.0, ground: true
    }
  };

  // Names other agents are likely to guess. Never let get() miss.
  var ALIASES = {
    metal: 'painted_metal',
    steel: 'painted_metal',
    iron: 'rusted_metal',
    rust: 'rusted_metal',
    wood: 'wood_plank',
    plank: 'wood_plank',
    wall: 'concrete_wall',
    ground: 'asphalt',
    road: 'asphalt',
    street: 'asphalt',
    floor: 'concrete',
    stucco: 'plaster',
    cloth: 'fabric',
    canvas: 'canvas_awning',
    tarp: 'canvas_awning',
    leaf: 'foliage',
    leaves: 'foliage',
    plant: 'foliage',
    window: 'glass',
    tyre: 'rubber',
    tire: 'rubber',
    weapon: 'gun_metal',
    gun: 'gun_metal',
    debris: 'rubble',
    washing: 'laundry',
    sheet: 'laundry',
    linen: 'laundry',
    skyline: 'far_facade',
    distant: 'far_facade',
    far: 'far_facade',
    default: 'concrete'
  };

  // Fallback palette used when ctx.textures cannot supply a map set. Values
  // are (base sRGB hex, speck hex, grain scale, blotch scale, pore weight).
  var FALLBACK_STYLE = {
    concrete: [0x9a958c, 0x6e6a63, 34, 5, 0.55],
    concrete_wall: [0xa39c90, 0x6b665e, 30, 4, 0.5],
    plaster: [0xd9c3a0, 0x9d8a70, 26, 4, 0.35],
    brick: [0x8e5b45, 0x5b3a2c, 18, 3, 0.4],
    rusted_metal: [0x7a4630, 0x3a2a22, 22, 3, 0.45],
    painted_metal: [0x4a5058, 0x2b3138, 16, 3, 0.18],
    corrugated_metal: [0x6a6b66, 0x3d3e3b, 18, 3, 0.22],
    gun_metal: [0x2a2c30, 0x14161a, 40, 6, 0.25],
    wood_plank: [0x6b5540, 0x453427, 44, 2, 0.3],
    sand: [0xc9b08a, 0x9a8362, 56, 6, 0.7],
    gravel: [0x8d857a, 0x4e483f, 26, 5, 0.85],
    asphalt: [0x3e3f42, 0x232427, 44, 6, 0.75],
    dirt: [0x6d5a44, 0x3f3428, 40, 5, 0.7],
    rubble: [0x8a8378, 0x4b463f, 24, 5, 0.8],
    tile: [0xb9b3a6, 0x8d887c, 12, 3, 0.2],
    stone: [0x8f8a80, 0x55514a, 20, 4, 0.6],
    fabric: [0x9a5a48, 0x6a3c30, 70, 4, 0.25],
    canvas_awning: [0xa8503c, 0x74362a, 64, 3, 0.25],
    rubber: [0x26282b, 0x141517, 52, 5, 0.35],
    plastic: [0x5b6068, 0x3a3e44, 20, 4, 0.12],
    glass: [0xcfd8dc, 0xaab6bb, 8, 2, 0.05],
    foliage: [0x6b7248, 0x414627, 30, 4, 0.4],
    cloth_olive: [0x555b3c, 0x363a26, 74, 4, 0.25],
    cloth_tan: [0x8d7a58, 0x5f5139, 74, 4, 0.25],
    skin: [0x9c7050, 0x6f4c34, 60, 5, 0.2],
    sandbag: [0xa08f6c, 0x6c6048, 46, 4, 0.5],
    laundry: [0xa9a294, 0x7d766a, 78, 3, 0.2],
    far_facade: [0x9a9184, 0x6d665c, 14, 3, 0.15],
    paint_blue: [0x4d6b78, 0x2c3f47, 16, 3, 0.18],
    paint_green: [0x566b4e, 0x323f2e, 16, 3, 0.18],
    lime_wash: [0xc4cbcb, 0x8e9797, 26, 4, 0.3]
  };

  // ==========================================================================
  // GLSL fragments. Assembled per-material in JS so a material only ever pays
  // for the features it actually uses (fewer uniforms, shorter shaders,
  // fewer program permutations).
  // ==========================================================================

  // Value noise, with no dependency on the world varyings, so features that
  // need a spatial field but not world space (the gloss mask on a character or
  // a viewmodel part) can pull it in on its own. Declaring an unmatched
  // `varying` in a fragment shader is a link hazard in GLSL ES 3.0, so the two
  // are deliberately separable.
  var G_NOISE = [
    '// iq-style float hash: no sin(), stable on software rasterisers.',
    'float gbHash13( vec3 p ) {',
    '  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );',
    '  p *= 17.0;',
    '  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );',
    '}',
    'float gbValue3( vec3 p ) {',
    '  vec3 i = floor( p ), f = fract( p );',
    '  f = f * f * ( 3.0 - 2.0 * f );',
    '  float n000 = gbHash13( i );',
    '  float n100 = gbHash13( i + vec3( 1.0, 0.0, 0.0 ) );',
    '  float n010 = gbHash13( i + vec3( 0.0, 1.0, 0.0 ) );',
    '  float n110 = gbHash13( i + vec3( 1.0, 1.0, 0.0 ) );',
    '  float n001 = gbHash13( i + vec3( 0.0, 0.0, 1.0 ) );',
    '  float n101 = gbHash13( i + vec3( 1.0, 0.0, 1.0 ) );',
    '  float n011 = gbHash13( i + vec3( 0.0, 1.0, 1.0 ) );',
    '  float n111 = gbHash13( i + vec3( 1.0, 1.0, 1.0 ) );',
    '  return mix( mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),',
    '              mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );',
    '}'
  ].join('\n');

  var G_COMMON = [
    'varying vec3 vGbWorld;',
    'varying vec3 vGbWorldN;',
    G_NOISE
  ].join('\n');

  // Reoriented normal mapping (Barre-Brisebois & Hill). Naive addition or
  // whiteout blending flattens the base normal; RNM rotates the detail normal
  // into the base normal's frame, so bricks keep their mortar shading while
  // gaining grain.
  var G_RNM = [
    'vec3 gbBlendRNM( vec3 base, vec3 det ) {',
    '  vec3 t = base + vec3( 0.0, 0.0, 1.0 );',
    '  vec3 u = det * vec3( -1.0, -1.0, 1.0 );',
    '  return normalize( t * dot( t, u ) - u * t.z );',
    '}'
  ].join('\n');

  // --------------------------------------------------------------------------
  // Triplanar DOMAIN WARP.
  //
  // The triplanar path deliberately has no stochastic tiling (six taps per map
  // is not affordable on the ground, which is the largest surface in frame), so
  // until now every world-projected surface repeated on a perfectly regular
  // lattice - and "visible texture tiling" is on the instant-fail list. A
  // smooth low-frequency displacement of the projection coordinate breaks that
  // lattice without introducing any cell boundary to blend across: it is C1
  // everywhere, costs two value-noise evaluations and ZERO extra texture
  // fetches, and it applies identically to the albedo, the ORM and the normal
  // so the three never disagree.
  //
  // Amplitude is per-axis (gbTriWarp) because a pattern with structure - brick
  // courses, corrugation ribs - must not be displaced along its structural
  // axis or the courses wander. Zero that component and the warp slides the
  // pattern ALONG the courses instead, which breaks the repeat and leaves
  // every course dead level.
  // --------------------------------------------------------------------------
  var G_TRIWARP = [
    'vec3 gbTriWarpPos( vec3 wp, float s ) {',
    '  vec3 q = wp * 0.17;',                       // ~6 m period
    '  float a = gbValue3( q + 3.1 );',
    '  float b = gbValue3( q.yzx * 1.43 + 11.7 );',
    '  vec3 d = vec3( a - 0.5, ( a + b ) * 0.5 - 0.5, b - 0.5 ) * 2.0;',
    '  return wp * s + d * gbTriWarp;',
    '}'
  ].join('\n');

  var G_TRI = [
    'vec3 gbTriWeights( vec3 n, float sharp ) {',
    '  vec3 w = pow( abs( n ), vec3( sharp ) );',
    '  return w / max( w.x + w.y + w.z, 1e-4 );',
    '}',
    'vec4 gbTriSample( sampler2D t, vec3 wp, vec3 w, float s ) {',
    '  return texture2D( t, wp.zy * s ) * w.x',
    '       + texture2D( t, wp.xz * s ) * w.y',
    '       + texture2D( t, wp.xy * s ) * w.z;',
    '}',
    '// Albedo variant that also divides out each projection\'s own tile',
    '// low-pass, so the source map\'s large-scale blotching cannot become a',
    '// field of blotches on a 2 m grid. The low-pass is 16x16, i.e. it lives',
    '// entirely in cache, and the large-scale variation comes back from',
    '// gbMacroNoise which is world-space and does not tile.',
    '#if GB_TRI_LP',
    'float gbTriLP( vec2 uv ) {',
    '  float r = GB_LP_MIN + texture2D( gbTileLP, uv ).r * GB_LP_SPAN;',
    '  return max( mix( 1.0, r, gbTileFlat ), 0.42 );',
    '}',
    'vec4 gbTriSampleLP( sampler2D t, vec3 wp, vec3 w, float s ) {',
    '  vec2 uX = wp.zy * s, uY = wp.xz * s, uZ = wp.xy * s;',
    '  vec4 a = texture2D( t, uX ); a.rgb /= gbTriLP( uX );',
    '  vec4 b = texture2D( t, uY ); b.rgb /= gbTriLP( uY );',
    '  vec4 c = texture2D( t, uZ ); c.rgb /= gbTriLP( uZ );',
    '  return max( a * w.x + b * w.y + c * w.z, vec4( 0.0 ) );',
    '}',
    '#endif',
    '// Whiteout triplanar normal blend (bgolus). Swizzles each projection\'s',
    '// tangent normal into world space before the weighted sum, which is the',
    '// only variant that does not wash out detail on 45-degree surfaces.',
    'vec3 gbTriNormal( sampler2D nm, vec3 wp, vec3 wn, vec3 w, float s, vec2 nsc ) {',
    '  vec3 sgn = sign( wn );',
    '  vec2 uvX = wp.zy * s; uvX.x *= sgn.x;',
    '  vec2 uvY = wp.xz * s; uvY.x *= sgn.y;',
    '  vec2 uvZ = wp.xy * s; uvZ.x *= -sgn.z;',
    '  vec3 nx = texture2D( nm, uvX ).xyz * 2.0 - 1.0;',
    '  vec3 ny = texture2D( nm, uvY ).xyz * 2.0 - 1.0;',
    '  vec3 nz = texture2D( nm, uvZ ).xyz * 2.0 - 1.0;',
    '  nx.xy *= nsc; ny.xy *= nsc; nz.xy *= nsc;',
    'GB_TRI_DETAIL',
    '  nx = vec3( nx.xy + wn.zy, abs( nx.z ) * wn.x );',
    '  ny = vec3( ny.xy + wn.xz, abs( ny.z ) * wn.y );',
    '  nz = vec3( nz.xy + wn.xy, abs( nz.z ) * wn.z );',
    '  return normalize( nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z );',
    '}'
  ].join('\n');

  var G_TRI_DETAIL = [
    '  float dsc = gbDetailStrength * gbDetailFade;',
    '  vec3 dx = gbDetN( uvX * gbDetailTile, dsc );',
    '  vec3 dy = gbDetN( uvY * gbDetailTile, dsc );',
    '  vec3 dz = gbDetN( uvZ * gbDetailTile, dsc );',
    '  nx = gbBlendRNM( nx, dx ); ny = gbBlendRNM( ny, dy ); nz = gbBlendRNM( nz, dz );'
  ].join('\n');

  // The detail tile packs R,G = normal.xy, B = cavity, A = micro roughness.
  // Reconstructing z rather than storing it frees two channels, which is what
  // pays for the roughness and cavity terms that stop close-range surfaces
  // from keeping a perfectly uniform sheen.
  var G_DETN = [
    'vec3 gbDetVec( vec4 d, float sc ) {',
    '  vec2 e = d.rg * 2.0 - 1.0;',
    '  vec3 n = vec3( e, sqrt( max( 1.0 - dot( e, e ), 0.0 ) ) );',
    '  n.xy *= sc;',
    '  return n;',
    '}',
    'vec3 gbDetN( vec2 uv, float sc ) {',
    '  return gbDetVec( texture2D( gbDetailNormal, uv ), sc );',
    '}'
  ].join('\n');

  // Tangent frame from screen-space derivatives, mirroring three's
  // getTangentFrame(). We need our own copy because the built-in one is only
  // declared inside normal_fragment_begin, which runs *after* map_fragment -
  // and parallax has to displace the UV before anything is sampled.
  var G_TANGENT = [
    'mat3 gbTangentFrame( vec3 eye, vec3 n, vec2 uv ) {',
    '  vec3 q0 = dFdx( eye ), q1 = dFdy( eye );',
    '  vec2 st0 = dFdx( uv ), st1 = dFdy( uv );',
    '  vec3 q1p = cross( q1, n ), q0p = cross( n, q0 );',
    '  vec3 T = q1p * st0.x + q0p * st1.x;',
    '  vec3 B = q1p * st0.y + q0p * st1.y;',
    '  float det = max( dot( T, T ), dot( B, B ) );',
    '  float sc = ( det == 0.0 ) ? 0.0 : inversesqrt( det );',
    '  return mat3( T * sc, B * sc, n );',
    '}'
  ].join('\n');

  // Steep-parallax + occlusion refinement. textureGrad keeps the derivatives
  // uniform across the quad even though the loop is not, which is what stops
  // POM from shimmering along mip boundaries.
  var G_POM = [
    'vec2 gbParallax( vec2 uv, vec3 vts, float depth, vec2 ddx, vec2 ddy ) {',
    '  float nz = max( abs( vts.z ), 0.30 );',
    '  vec2 delta = ( vts.xy / nz ) * depth / float( GB_POM_STEPS );',
    '  float layer = 1.0 / float( GB_POM_STEPS );',
    '  float cur = 0.0;',
    '  vec2 p = uv, prev = uv;',
    '  float h = 1.0 - textureGrad( gbHeightMap, p, ddx, ddy ).r;',
    '  float prevH = h;',
    '  for ( int i = 0; i < GB_POM_STEPS; i ++ ) {',
    '    if ( cur >= h ) break;',
    '    prev = p; prevH = h;',
    '    p -= delta;',
    '    cur += layer;',
    '    h = 1.0 - textureGrad( gbHeightMap, p, ddx, ddy ).r;',
    '  }',
    '  float after = h - cur;',
    '  float before = prevH - cur + layer;',
    '  float w = after / ( after - before + 1e-5 );',
    '  return mix( p, prev, clamp( w, 0.0, 1.0 ) );',
    '}'
  ].join('\n');

  var G_MACRO = [
    '// FOUR octaves of low frequency world noise at roughly 12 m / 3 m / 1 m /',
    '// 0.25 m. The old single ~12 m octave could not touch a 2 m tile repeat;',
    '// this one straddles it, and it drives roughness as well as colour because',
    '// under a hazy sky a brightness-only variation is essentially invisible.',
    '// The 0.25 m octave is the bottom end of the band nothing else authored -',
    '// it fades out past ~35 m, where it would only alias, and the meso layer',
    '// picks up below it.',
    'float gbMacroNoise( vec3 wp ) {',
    '  float a = gbValue3( wp * gbMacroScale * 0.27 );',
    '  float b = gbValue3( wp * gbMacroScale + 13.7 );',
    '  float c = gbValue3( wp * gbMacroScale * 3.13 + 4.21 );',
    '  float d = gbValue3( wp * gbMacroScale * 12.5 + 27.3 );',
    '  float wd = 0.155 * gbMacroHF;',
    '  return clamp( ( a * 0.40 + b * 0.36 + c * 0.17 + d * wd ) / ( 0.93 + wd ), 0.0, 1.0 );',
    '}',
    'vec3 gbApplyMacro( vec3 albedo, float m ) {',
    '  float k = gbMacroAmount;',
    '  float lum = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '  float sat = mix( 1.0 - k * 0.6, 1.0 + k * 0.22, m );',
    '  albedo = max( mix( vec3( lum ), albedo, sat ), vec3( 0.0 ) );',
    '  albedo *= mix( 1.0 - k, 1.0 + k * 0.8, m );',
    '  // Dust settles in the low patches: tint, do not just darken.',
    '  albedo = mix( albedo, albedo * gbDustColor, clamp( ( 0.46 - m ) * 2.2, 0.0, 1.0 ) * k );',
    '  return albedo;',
    '}'
  ].join('\n');

  // --------------------------------------------------------------------------
  // Stochastic tiling.
  //
  // Two overlapping unit grids (one offset by half a cell). Each cell hashes to
  // its own rotation + translation of the source tile, and the two taps are
  // blended by distance from their cell centres, so the transition is C1 and
  // there is no seam. A plain mix() of two taps would halve the local variance
  // in the blend band and read as a soft blur; blending the *deviation from the
  // tile mean* and renormalising by 1/sqrt(wa^2+wb^2) preserves it. The tile
  // mean is measured on the CPU (the same measurement that anchors albedo).
  //
  // gbStochQ quantises the offset to a fraction of the tile, which is what lets
  // this run on brick and floor tile: the courses and the grout stay on one
  // global lattice while the *content* between them stops repeating.
  // --------------------------------------------------------------------------
  var G_STOCH = [
    'vec2 gbHash22( vec2 p ) {',
    '  vec3 p3 = fract( vec3( p.x, p.y, p.x ) * vec3( 0.1031, 0.1030, 0.0973 ) );',
    '  p3 += dot( p3, p3.yzx + 19.19 );',
    '  return fract( ( p3.xx + p3.yz ) * p3.zy );',
    '}',
    'void gbStochXf( vec2 cell, out mat2 R, out vec2 off ) {',
    '  vec2 h = gbHash22( cell + 0.37 );',
    '  #if GB_STOCH_ROT > 0',
    '    float a = floor( h.x * float( GB_STOCH_ROT ) ) * ( 6.2831853 / float( GB_STOCH_ROT ) );',
    '    float s = sin( a ), c = cos( a );',
    '    R = mat2( c, s, -s, c );',
    '  #else',
    '    R = mat2( 1.0, 0.0, 0.0, 1.0 );',
    '  #endif',
    '  #if GB_STOCH_FLIP',
    '    // Horizontal mirror about the tile origin. Doubles the cell alphabet',
    '    // WITHOUT touching the vertical axis, so drips, rust weeps, spalling',
    '    // and sand bleed all still run downhill - and because the mirror is',
    '    // about u = 0 it maps any 1/N lattice onto itself, so the stochQ',
    '    // quantisation (brick courses, corrugation ribs, grout) still holds.',
    '    if ( h.y > 0.5 ) R = R * mat2( -1.0, 0.0, 0.0, 1.0 );',
    '  #endif',
    '  off = gbHash22( cell + 7.13 );',
    '  if ( gbStochQ.x > 0.5 ) off.x = floor( off.x * gbStochQ.x ) / gbStochQ.x;',
    '  if ( gbStochQ.y > 0.5 ) off.y = floor( off.y * gbStochQ.y ) / gbStochQ.y;',
    '}',
    '// Weights + per-cell transforms, computed once and reused by every map.',
    'void gbStochSetup( vec2 uv, vec2 ddx, vec2 ddy ) {',
    '  vec2 cA = floor( uv );',
    '  vec2 cB = floor( uv + 0.5 );',
    '  vec2 pA = uv - cA - 0.5;',
    '  vec2 pB = uv - cB;',
    '  float wA = 1.0 - smoothstep( 0.0, 0.7072, length( pA ) );',
    '  float wB = 1.0 - smoothstep( 0.0, 0.7072, length( pB ) );',
    '  float sw = max( wA + wB, 1e-4 );',
    '  gbSW = vec2( wA, wB ) / sw;',
    '  vec2 oA, oB;',
    '  gbStochXf( cA, gbSRA, oA );',
    '  gbStochXf( cB, gbSRB, oB );',
    '  gbSUvA = gbSRA * pA + oA;',
    '  gbSUvB = gbSRB * pB + oB;',
    '  gbSXA = gbSRA * ddx; gbSYA = gbSRA * ddy;',
    '  gbSXB = gbSRB * ddx; gbSYB = gbSRB * ddy;',
    '}',
    '// Per-tap divisor that flattens the source tile\'s own low-frequency mean.',
    '// Sampled with the SAME gradients as the base map, so the low-pass tracks',
    '// the same world footprint at every mip and the correction neither',
    '// over- nor under-shoots with distance.',
    '#if GB_STOCH_LP',
    'float gbTileLPAt( vec2 uv, vec2 dx, vec2 dy ) {',
    '  float r = GB_LP_MIN + textureGrad( gbTileLP, uv, dx, dy ).r * GB_LP_SPAN;',
    '  return max( mix( 1.0, r, gbTileFlat ), 0.42 );',
    '}',
    '#endif',
    '// Variance-preserving blend (albedo), on the flattened taps.',
    'vec4 gbStochV( sampler2D t, vec4 mean ) {',
    '  vec4 a = textureGrad( t, gbSUvA, gbSXA, gbSYA );',
    '  vec4 b = textureGrad( t, gbSUvB, gbSXB, gbSYB );',
    '  #if GB_STOCH_LP',
    '    a.rgb /= gbTileLPAt( gbSUvA, gbSXA, gbSYA );',
    '    b.rgb /= gbTileLPAt( gbSUvB, gbSXB, gbSYB );',
    '  #endif',
    '  float n = inversesqrt( max( dot( gbSW, gbSW ), 1e-5 ) );',
    '  return max( mean + ( ( a - mean ) * gbSW.x + ( b - mean ) * gbSW.y ) * n, vec4( 0.0 ) );',
    '}',
    '// Plain blend (ORM - overshoot there costs more than it buys).',
    'vec4 gbStochL( sampler2D t ) {',
    '  vec4 a = textureGrad( t, gbSUvA, gbSXA, gbSYA );',
    '  vec4 b = textureGrad( t, gbSUvB, gbSXB, gbSYB );',
    '  return a * gbSW.x + b * gbSW.y;',
    '}',
    '// Normal blend. A tangent-space normal sampled through a transformed UV',
    '// has to be counter-transformed or the lighting disagrees with the shape:',
    '// sampling T(R*p) makes the surface gradient R^T * grad(T), so the tangent',
    '// xy needs R^T. (v * M is M^T * v in GLSL, which is exactly that, and it',
    '// costs two multiplies.) The old code rotated the UV by up to 90 degrees',
    '// and left the normal alone, so every rotated cell was lit as if its bumps',
    '// faced a different way from its shading.',
    'vec3 gbStochN( sampler2D t ) {',
    '  vec3 a = textureGrad( t, gbSUvA, gbSXA, gbSYA ).xyz * 2.0 - 1.0;',
    '  vec3 b = textureGrad( t, gbSUvB, gbSXB, gbSYB ).xyz * 2.0 - 1.0;',
    '  a.xy = a.xy * gbSRA;',
    '  b.xy = b.xy * gbSRB;',
    '  return a * gbSW.x + b * gbSW.y;',
    '}'
  ].join('\n');

  // Meso surface band, ~0.1-0.6 m. Reuses the shared detail tile at a much
  // longer world period, so it costs one fetch and arrives with a normal, a
  // cavity and a micro-roughness already packed. Amplitude is modulated by the
  // macro field so its own 0.55 m repeat never becomes a pattern in its own
  // right, and it fades out past 40 m where it would only alias.
  var G_MESO = [
    'vec3 gbMesoPerturb( vec3 n, vec3 m ) {',
    '  vec3 up = abs( n.y ) > 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );',
    '  vec3 t = normalize( cross( up, n ) );',
    '  vec3 b = cross( n, t );',
    '  return normalize( n + t * m.x + b * m.y );',
    '}'
  ].join('\n');

  // Dominant-axis world projection for the detail layer. Detail is isotropic
  // high-frequency noise, so a hard axis switch is invisible - and unlike a UV
  // scale it does not depend on what the consumer put in the uv attribute.
  var G_DETUV = [
    'vec2 gbDetProj( vec3 wp, vec3 wn ) {',
    '  vec3 a = abs( wn );',
    '  if ( a.y >= a.x && a.y >= a.z ) return wp.xz;',
    '  if ( a.x >= a.z ) return wp.zy;',
    '  return wp.xy;',
    '}'
  ].join('\n');

  // Grounding. ARCHITECTURE.md 7.8: wear where hands and feet go. Everything
  // here is derived from world position and world normal, so it works on merged
  // level geometry that never had a wear channel painted on it.
  var G_GROUND = [
    'void gbGroundCalc( vec3 wp, vec3 wn, float m ) {',
    '  float up = clamp( wn.y, 0.0, 1.0 );',
    '  float down = clamp( - wn.y, 0.0, 1.0 );',
    '  float vert = 1.0 - abs( wn.y );',
    '  // Splash + drifted dust rising off the ground. Modulated by the macro',
    '  // field and a finer break-up octave so the line is never a clean ramp.',
    '  float nz = gbValue3( wp * vec3( 1.9, 0.55, 1.9 ) + 31.0 );',
    '  float band = gbGround.y * ( 0.55 + 0.9 * m + 0.5 * nz );',
    '  float dust = 1.0 - smoothstep( 0.0, max( band, 0.05 ), wp.y - gbGround.x );',
    '  dust = dust * dust * vert;',
    '  // Horizontal surfaces collect it everywhere, not just low down.',
    '  gbSettle = clamp( ( up * ( 0.26 + 0.44 * m ) + dust * 0.85 ) * gbGround.z, 0.0, 0.92 );',
    '  // Runoff: water sheds off the underside of ledges and leaves a grime',
    '  // shadow. Streaked vertically, keyed off a squashed noise field.',
    '  float streak = gbValue3( wp * vec3( 5.5, 0.35, 5.5 ) + 71.0 );',
    '  gbWeep = down * smoothstep( 0.35, 0.85, streak ) * gbGround.w;',
    '}',
    'vec3 gbGroundAlbedo( vec3 albedo ) {',
    '  float lum = dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) );',
    '  albedo = mix( albedo, gbDustColor * ( 0.42 + 0.85 * lum ), gbSettle );',
    '  return albedo * mix( 1.0, 0.62, gbWeep );',
    '}'
  ].join('\n');

  // --------------------------------------------------------------------------
  // GLOSS (polish) mask - the missing symmetric half of the wear model.
  //
  // Every roughness modifier in this shader used to push ONE WAY: gbSettle
  // mixed to 0.97 at weight 0.85, gbWeep to 0.94 at 0.60 and gbGrime to 0.96
  // at 0.62, while the only counter-pull was gbWear to 0.34 at 0.55 off a mask
  // that measures mean 0.029 in-scene. Every road, wall, floor and cloth was
  // dragged to chalk regardless of what the texture said, and not one of the
  // sixteen samples in materials.png produced a specular highlight (best
  // p99/median was 7.14, on SAND, and that was a diffuse gradient).
  //
  // The physical story is the mirror image of grime: wherever a surface is
  // TOUCHED - a traffic path across a floor, the handled edge of a shutter,
  // the glaze left on a tile face, rain sheeting off a horizontal slab - the
  // proud crests are burnished smooth while the pits between them stay matte.
  // So: crest (from the detail/meso height field) x zone (a low-frequency
  // world field) -> pull TOWARD gloss. Because it multiplies a high-frequency
  // crest by a low-frequency zone, the result is a small area of genuinely
  // glossy texels rather than a uniformly shinier surface - which is exactly
  // what a specular highlight is made of.
  // --------------------------------------------------------------------------
  var G_POLISH = [
    'float gbPolishCalc( vec3 p, float crest, float up ) {',
    '  // Three octaves - 3 m, 1 m and 0.3 m. The coarse one is the traffic',
    '  // path / weather zone; the fine one exists so that an object SMALLER',
    '  // than the coarse period (a shutter, a crate, a chart sphere) is not',
    '  // simply all-in or all-out of the zone.',
    '  float z = gbValue3( p * 0.31 + 61.0 ) * 0.46',
    '          + gbValue3( p * 1.05 + 17.0 ) * 0.32',
    '          + gbValue3( p * 3.30 + 47.0 ) * 0.22;',
    '  float zone = smoothstep( 0.28, 0.58, z );',
    '  // Horizontal surfaces sheet water and take foot/tyre traffic, so they',
    '  // polish harder than a vertical face does.',
    '  zone *= mix( 0.62, 1.0, up );',
    '  // The mask is pure COVERAGE - what fraction of the surface has been',
    '  // burnished - and it saturates on only a few per cent of the texels.',
    '  // gbPolishAmt is not folded in here: it sets how glossy those texels',
    '  // GET (see the roughness target below). Folding it in as well made the',
    '  // whole term an order of magnitude too weak to matter, and roughness',
    '  // enters the GGX lobe as the FOURTH power - a mask that only takes 0.8',
    '  // down to 0.45 changes the peak highlight by 30x less than one that',
    '  // takes it to 0.18, i.e. it is invisible.',
    '  return clamp( crest * zone, 0.0, 1.0 );',
    '}'
  ].join('\n');

  // ==========================================================================
  // Small helpers
  // ==========================================================================

  function isTexture(t) { return !!(t && t.isTexture); }

  function hashOpts(name, opts) {
    if (!opts) return name;
    var keys = [], k;
    for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) keys.push(k);
    keys.sort();
    var out = name;
    for (var i = 0; i < keys.length; i++) {
      var v = opts[keys[i]];
      if (v === undefined) continue;
      if (Array.isArray(v)) v = v.join(',');
      else if (v && v.isColor) v = v.getHexString();
      else if (v && typeof v === 'object') v = '[obj]';
      out += '|' + keys[i] + '=' + v;
    }
    return out;
  }

  function srgb(hex, out) {
    out = out || new THREE.Color();
    out.setHex(hex, THREE.SRGBColorSpace);
    return out;
  }

  // sRGB byte -> linear, precomputed. The albedo measurement touches a few
  // thousand texels per material and pow() there is pure waste.
  var S2L = (function () {
    var t = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i / 255;
      t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return t;
  })();

  // --------------------------------------------------------------------------
  // solveChroma - tilt an albedo gain toward a palette chromaticity.
  //
  // `out` arrives holding the NEUTRAL gain (g0,g0,g0) that puts the surface's
  // mean luminance on `alb`. This rotates it toward the hue of `paletteHex`
  // by `h` and leaves the mean luminance untouched:
  //
  //   desired  = palette scaled to luminance `alb`
  //   chromatic gain c = desired / measured mean, per channel
  //   gain     = mix( g0, c, h ), each channel clamped to [0.45, 2.2] * g0
  //   gain    *= alb / luminance( gain * mean )        <- exact renormalise
  //
  // The clamp is what makes this safe to leave on: however far the texture's
  // hue is from the palette, no channel can move more than ~2.2x relative to
  // its neighbours, so the worst case is a partial correction rather than a
  // cartoon tint. Returns the luminance-weighted gain for gbAlbedoGain.
  // --------------------------------------------------------------------------
  var _chromaTmp = new THREE.Color();
  function solveChroma(out, mean, paletteHex, alb, h, g0) {
    try {
      if (!(mean.r > 1e-5) || !(mean.g > 1e-5) || !(mean.b > 1e-5)) return g0;
      var p = srgb(paletteHex, _chromaTmp);
      var pl = 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
      if (!(pl > 1e-4)) return g0;
      var k = alb / pl;
      var lo = g0 * 0.45, hi = g0 * 2.2;
      var gr = M.clamp(g0 + (p.r * k / mean.r - g0) * h, lo, hi);
      var gg = M.clamp(g0 + (p.g * k / mean.g - g0) * h, lo, hi);
      var gb = M.clamp(g0 + (p.b * k / mean.b - g0) * h, lo, hi);
      var lum = 0.2126 * gr * mean.r + 0.7152 * gg * mean.g + 0.0722 * gb * mean.b;
      if (!(lum > 1e-6)) return g0;
      var s = alb / lum;
      gr = M.clamp(gr * s, 0.05, 8.0);
      gg = M.clamp(gg * s, 0.05, 8.0);
      gb = M.clamp(gb * s, 0.05, 8.0);
      out.setRGB(gr, gg, gb);
      return 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
    } catch (e) { return g0; }
  }

  // ==========================================================================
  // MaterialLibrary
  // ==========================================================================
  function MaterialLibrary(ctx) {
    this.ctx = ctx || null;
    this.cache = Object.create(null);
    this.decals = Object.create(null);
    this._fallbacks = Object.create(null);
    this._detailNormal = null;
    this._detailKinds = Object.create(null);   // family detail tiles, by kind
    this._envFallback = null;
    this._envChecked = false;
    this._texFails = 0;
    this._texBroken = false;
    this._time = { value: 0 };
    this._anisotropy = 4;
    this._means = [];              // [{img, mean}] - albedo statistics cache
    this._lps = [];                // [{img, tex}]  - tile low-pass cache
    this.defs = DEFS;
    this.names = Object.keys(DEFS);
    this.densityWarnings = [];     // see _checkDensity
    // World Y that "the ground" sits at, for the grounding wear term. level.js
    // puts the road crown at 0; anything that moves this should set it before
    // materials are created.
    this.groundY = 0.0;

    // Global feature switches - postfx/quality can turn the expensive ones off.
    var q = (ctx && ctx.quality) || {};
    this.enableParallax = q.level !== 'low';
    this.enableDetail = true;
    this.enableDetail2 = q.level !== 'low';
    this.enableMacro = true;
    this.pomSteps = q.level === 'ultra' ? 12 : (q.level === 'medium' ? 8 : 10);
    // Detail/parallax only matter within a few metres; fading them out saves
    // fill rate and, more importantly, stops high-frequency normals from
    // aliasing into sparkle at distance. Pushed well past the old 17 m - a
    // 25 m street where every wall past the near corner is bald reads as two
    // different games stitched together.
    this.detailFadeNear = 9.0;
    this.detailFadeFar = 26.0;
    // The near tier only exists inside hero range; past 5 m it is sub-pixel
    // and would only alias, so the whole fetch is branched over.
    this.detail2Near = 3.0;
    this.detail2Far = 7.0;

    try {
      if (ctx && ctx.renderer && ctx.renderer.capabilities) {
        this._anisotropy = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy() || 1);
      }
    } catch (e) { this._anisotropy = 1; }
  }

  // --------------------------------------------------------------------------
  // build() - front-load the expensive bits (detail normal, common materials)
  // so nothing hitches on the first frame the player sees.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype.build = async function () {
    // One detail tile per SURFACE FAMILY. Until this existed the whole library
    // shared a single 256px field - the same worley pores and the same
    // directional scuff on concrete, plaster, brick, cloth, gunmetal, sandbag
    // and skin alike - which is a large part of why concrete, plaster, sand
    // and sandbag all read as one substance.
    var kinds = ['mineral', 'woven', 'metal', 'organic'];
    for (var ki = 0; ki < kinds.length; ki++) {
      try {
        this._detailKinds[kinds[ki]] = this._makeDetailNormal(256, kinds[ki]);
      } catch (e) { GAME.logError('materials.detailNormal:' + kinds[ki], e); }
      await GAME.yieldFrame();
    }
    this._detailNormal = this._detailKinds.mineral || null;
    if (!this._detailNormal) {
      try { this._detailNormal = this._makeDetailNormal(256, 'mineral'); }
      catch (e2) { GAME.logError('materials.detailNormal', e2); }
    }

    await GAME.yieldFrame();

    // Warm the material set most of the level will ask for. Doing this here
    // means textures.get() cache misses happen during the loading bar.
    var warm = ['concrete', 'concrete_wall', 'plaster', 'brick', 'asphalt',
      'sand', 'gravel', 'rusted_metal', 'painted_metal', 'corrugated_metal',
      'wood_plank', 'tile', 'fabric', 'rubber', 'gun_metal'];
    for (var i = 0; i < warm.length; i++) {
      try { this.get(warm[i]); } catch (e) { GAME.logError('materials.warm:' + warm[i], e); }
      if ((i & 3) === 3) await GAME.yieldFrame();
    }
    return this;
  };

  // --------------------------------------------------------------------------
  // update() - drives the shared time uniform and installs an IBL safety net.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype.update = function (dt, ctx) {
    this._time.value += (dt || 0);
    if (!this._envChecked) {
      this._envChecked = true;
      try { this._ensureEnvironment(ctx || this.ctx); }
      catch (e) { GAME.logError('materials.env', e); }
    }
  };

  // A metal with no environment map renders as a black hole. sky.js normally
  // supplies scene.environment; if it failed to build we drop in a cheap
  // procedural sky probe rather than let every metal surface read as void.
  MaterialLibrary.prototype._ensureEnvironment = function (ctx) {
    if (!ctx || !ctx.scene || !ctx.renderer) return;
    if (ctx.scene.environment) return;

    var W = 64, H = 32;
    var data = new Float32Array(W * H * 4);
    // Linear HDR radiance, not sRGB colours. A dim probe here is exactly how
    // metals end up looking like black plastic, so these are deliberately
    // bright - a real late-afternoon sky is well above 1.0 in linear.
    var zen = [0.42, 0.72, 1.35];       // cool zenith, matches ART_DIRECTION
    var hor = [2.10, 1.72, 1.28];       // warm dusty horizon
    var gnd = [0.36, 0.29, 0.21];       // sand bounce, never black
    for (var y = 0; y < H; y++) {
      var v = y / (H - 1);
      var el = Math.cos(v * Math.PI);   // +1 up .. -1 down
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        var t = M.saturate(el);
        var r, g, b;
        if (el >= 0) {
          r = M.lerp(hor[0], zen[0], Math.pow(t, 0.55));
          g = M.lerp(hor[1], zen[1], Math.pow(t, 0.55));
          b = M.lerp(hor[2], zen[2], Math.pow(t, 0.55));
        } else {
          var d = M.saturate(-el * 2.2);
          r = M.lerp(hor[0], gnd[0], d);
          g = M.lerp(hor[1], gnd[1], d);
          b = M.lerp(hor[2], gnd[2], d);
        }
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
      }
    }
    var tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.NoColorSpace;   // already linear HDR values
    tex.needsUpdate = true;

    var pmrem = new THREE.PMREMGenerator(ctx.renderer);
    var rt = pmrem.fromEquirectangular(tex);
    this._envFallback = rt.texture;
    ctx.scene.environment = rt.texture;
    pmrem.dispose();
    tex.dispose();
  };

  // --------------------------------------------------------------------------
  // Measure an albedo map's mean LINEAR colour.
  //
  // This is what makes the material library independent of whatever absolute
  // brightness the texture library happens to author. Previously `color` (the
  // material's nominal sRGB tint) was multiplied onto a map that already
  // carried that same colour, so both value and chroma were squared: asphalt
  // landed at 0.004 linear diffuse against a real-world 0.07-0.12, and brick
  // went from HSV saturation 0.38 in the map to 0.78 on screen. Measuring lets
  // us solve a neutral gain that puts each surface on a physical reflectance
  // while leaving the texture's authored hue completely untouched.
  //
  // Returns null (-> gain 1.0, i.e. use the map as authored) for anything we
  // cannot read, so a texture from a source with no CPU-side data degrades to
  // the old behaviour minus the squaring.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._mapMean = function (tex) {
    if (!isTexture(tex)) return null;
    var img = tex.image;
    if (!img || !img.data || !img.data.length || !img.data.BYTES_PER_ELEMENT) return null;
    var i;
    for (i = 0; i < this._means.length; i++) {
      if (this._means[i].img === img) return this._means[i].mean;
    }
    var out = null;
    try {
      var d = img.data;
      var n = (d.length / 4) | 0;
      if (n > 0) {
        // A prime stride so the sample set is not aligned to the tile's own
        // periodic structure (bricks, planks, corrugation).
        var step = Math.max(1, Math.round(n / 6000));
        if ((step % 2) === 0) step++;
        var r = 0, g = 0, b = 0, a = 0, c = 0;
        for (i = 0; i < n; i += step) {
          var o = i * 4;
          var w = d[o + 3] / 255;
          r += S2L[d[o]] * w; g += S2L[d[o + 1]] * w; b += S2L[d[o + 2]] * w;
          a += w; c++;
        }
        // Alpha-weighted: for an alpha-cut map (foliage) the transparent
        // background is not part of the surface's reflectance.
        var wsum = a > 0.02 * c ? a : c;
        out = { r: r / wsum, g: g / wsum, b: b / wsum, alpha: a / c };
        out.lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
      }
    } catch (e) { out = null; }
    this._means.push({ img: img, mean: out });
    return out;
  };

  // --------------------------------------------------------------------------
  // Tile low-pass, the structural half of the stochastic-tiling fix.
  //
  // Stochastic tiling hides the *lattice* (you can no longer see where one
  // copy of the tile ends and the next begins) but it CANNOT hide a tile whose
  // own low-frequency mean is not uniform: each cell drops a randomly chosen
  // region of the source somewhere, so if the source has a big dark blotch in
  // one corner you get a field of big dark blotches on a random grid. That is
  // literally what "a repeating patchwork of dark rectangles" is, and it is
  // why a full round of tuning did not move it - the tuning was applied to the
  // mechanism, not to the input.
  //
  // So: measure the source's own low-frequency luminance (16x16 bins, blurred
  // to a support of ~3/16 of a tile) and hand the shader the ratio to that
  // tile's global mean. gbStochV divides it out per tap, which makes every
  // cell's mean identical by construction. The large-scale variation the
  // surface still needs then comes back from gbMacroNoise, which is projected
  // in world space and therefore does not tile at all.
  //
  // Returns null for anything unreadable -> gbTileFlat is forced to 0 and the
  // material behaves exactly as before.
  // --------------------------------------------------------------------------
  var LP_SIZE = 16;
  var LP_MIN = 0.25, LP_SPAN = 2.0;    // decoded ratio = LP_MIN + byte * LP_SPAN

  MaterialLibrary.prototype._tileLowpass = function (tex) {
    if (!isTexture(tex)) return null;
    var img = tex.image;
    if (!img || !img.data || !img.data.length || !img.data.BYTES_PER_ELEMENT) return null;
    var i;
    for (i = 0; i < this._lps.length; i++) {
      if (this._lps[i].img === img) return this._lps[i].tex;
    }
    var out = null;
    try { out = buildTileLowpass(img); }
    catch (e) { out = null; GAME.logError('materials.tileLowpass', e); }
    this._lps.push({ img: img, tex: out });
    return out;
  };

  function lpBlurWrap(a, L, tmp) {
    var x, y, k;
    for (y = 0; y < L; y++) {
      for (x = 0; x < L; x++) {
        tmp[y * L + x] = 0.25 * a[y * L + ((x - 1 + L) % L)] +
          0.5 * a[y * L + x] + 0.25 * a[y * L + ((x + 1) % L)];
      }
    }
    for (y = 0; y < L; y++) {
      for (x = 0; x < L; x++) {
        k = y * L + x;
        a[k] = 0.25 * tmp[((y - 1 + L) % L) * L + x] +
          0.5 * tmp[k] + 0.25 * tmp[((y + 1) % L) * L + x];
      }
    }
  }

  function buildTileLowpass(img) {
    var W = img.width | 0, H = img.height | 0;
    var d = img.data;
    if (W < 8 || H < 8 || d.length < W * H * 4) return null;
    var L = LP_SIZE, n = L * L;
    var acc = new Float32Array(n), cnt = new Float32Array(n);
    // Cap the work at ~256x256 samples per map: at 20 materials a full 1024^2
    // scan each would be 20M iterations on the loading thread for a field that
    // only carries 16x16 of information.
    var sx = Math.max(1, Math.floor(W / 256));
    var sy = Math.max(1, Math.floor(H / 256));
    var x, y, by, bx, o, k;
    for (y = 0; y < H; y += sy) {
      by = (y * L / H) | 0; if (by >= L) by = L - 1;
      for (x = 0; x < W; x += sx) {
        bx = (x * L / W) | 0; if (bx >= L) bx = L - 1;
        o = (y * W + x) * 4;
        k = by * L + bx;
        acc[k] += 0.2126 * S2L[d[o]] + 0.7152 * S2L[d[o + 1]] + 0.0722 * S2L[d[o + 2]];
        cnt[k] += 1;
      }
    }
    var i, mean = 0, filled = 0;
    for (i = 0; i < n; i++) {
      if (cnt[i] > 0) { acc[i] /= cnt[i]; mean += acc[i]; filled++; }
    }
    if (!filled) return null;
    mean /= filled;
    for (i = 0; i < n; i++) if (cnt[i] <= 0) acc[i] = mean;
    if (mean < 1e-5) return null;

    var tmp = new Float32Array(n);
    lpBlurWrap(acc, L, tmp);
    lpBlurWrap(acc, L, tmp);
    // The blur is not exactly mean-preserving at the clamp, so renormalise.
    var m2 = 0;
    for (i = 0; i < n; i++) m2 += acc[i];
    m2 = m2 / n;
    if (m2 < 1e-5) return null;

    var bytes = new Uint8Array(n * 4);
    for (i = 0; i < n; i++) {
      var ratio = M.clamp(acc[i] / m2, LP_MIN, LP_MIN + LP_SPAN);
      var b = M.clamp((ratio - LP_MIN) / LP_SPAN, 0, 1) * 255;
      o = i * 4;
      bytes[o] = bytes[o + 1] = bytes[o + 2] = b | 0;
      bytes[o + 3] = 255;
    }
    var t = new THREE.DataTexture(bytes, L, L, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 1;
    t.userData = { __gbOwned: true, __gbRepeat: '1,1' };
    t.needsUpdate = true;
    return t;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * get(name, opts) -> THREE.Material  (cached & shared)
   *
   * opts (all optional):
   *   repeat      [u,v] or number   texture repeat override
   *   scale, seed                   forwarded to ctx.textures.get
   *   color       hex               albedo tint override (RAW MULTIPLIER -
   *                                 squares a mapped material; prefer
   *                                 albedoTarget)
   *   albedoTarget hex              solve a per-channel gain so the surface's
   *                                 MEAN linear albedo lands on this colour
   *   hue         0..1              override DEFS.hue: how far the solved gain
   *                                 may go chromatic to put the mean on the
   *                                 palette entry. Luminance is preserved
   *   uvScale     number            the world-metres-to-uv scale the consumer
   *                                 baked into the geometry. Purely
   *                                 declarative: it lets get() check the final
   *                                 texel density (see uvScaleFor)
   *   roughness / metalness         scalar overrides
   *   triplanar   bool              world-space projection
   *   triScale    number            tiles per metre for triplanar
   *   parallax    bool | number     POM on/off, or explicit depth
   *   detail      bool | number     detail-normal strength
   *   macro       bool | number     macro-variation amount
   *   vertexColors bool             enable per-vertex wear (see wearMode)
   *   wearMode    'wear' | 'multiply'
   *   side        THREE.FrontSide | BackSide | DoubleSide
   *   transparent, opacity, alphaTest, flatShading, depthWrite
   *   physical    bool              use MeshPhysicalMaterial
   *   emissive    hex, emissiveIntensity
   *
   * VERTEX WEAR CONVENTION (wearMode 'wear', the default when vertexColors is
   * on). Paint a `color` attribute where WHITE = pristine, and each channel
   * darkens toward a different kind of damage:
   *
   *     R -> grime / dust     darkens + desaturates + roughens + kills Fresnel
   *     G -> wetness          darkens, drops roughness, raises specular
   *     B -> edge wear        exposes pale substrate (bare metal on metals)
   *
   * So an all-white colour attribute is a no-op, `setRGB(0.2,1,1)` is heavy
   * dirt, `setRGB(1,0.3,1)` is a wet patch, `setRGB(1,1,0.3)` is a scuffed
   * edge. Pass wearMode:'multiply' to get stock three.js tinting instead.
   */
  MaterialLibrary.prototype.get = function (name, opts) {
    name = (name || 'default');
    if (ALIASES[name]) name = ALIASES[name];
    var key = hashOpts(name, opts);
    var cached = this.cache[key];
    if (cached) return cached;

    var mat;
    try {
      mat = this._create(name, opts || null);
    } catch (e) {
      GAME.logError('materials.get:' + name, e);
      mat = new THREE.MeshStandardMaterial({
        color: srgb((DEFS[name] && DEFS[name].color) || 0x8f8a80),
        roughness: 0.9, metalness: 0.0, envMapIntensity: 1.0
      });
    }
    mat.name = key;
    this.cache[key] = mat;
    return mat;
  };

  /**
   * uvScaleFor(name, texelsPerM) -> the world-metres-to-uv scale a consumer
   * should bake into its geometry (GAME.Geo.worldUV) so this material lands on
   * a given texel density. Returns 1 for triplanar materials, which are
   * world-projected and ignore uv entirely.
   *
   * Density authority is documented in this file (every DEFS entry carries a
   * "solved for ~500 texels/m" comment) but for UV-mapped materials the final
   * density is `tier * DEFS.repeat * consumer.uv` - so up to now the consumer
   * held two of the three factors and materials.js had no way to see, let
   * alone check, the product. Measured spread across the captures was ~4.5x at
   * comparable range, which is what makes a 0.3 m parapet coping and a 12 m
   * wall carry the same grain and leaves the buildings with no sense of size.
   *
   * NOTE: taking the scale away from consumers entirely (deriving base-map UV
   * from world position in the vertex shader, as `wdet` already does for the
   * detail layer) is NOT the right fix and was deliberately not implemented:
   * one world density cannot serve a 12 m facade, a 0.5 m crate and a 1.36 m
   * material-chart plate at once, and forcing it would have made the chart -
   * which is the critics' honest read of this library - a field of blurred
   * half-tiles. Declaring the density is the fix; hiding it is not.
   */
  MaterialLibrary.prototype.uvScaleFor = function (name, texelsPerM) {
    try {
      name = name || 'default';
      if (ALIASES[name]) name = ALIASES[name];
      var def = DEFS[name] || DEFS.concrete;
      if (def.tri) return 1;
      var rep = def.repeat || 1;
      var tier = 512;
      var m = this.get(name);
      if (m && m.map && m.map.image && m.map.image.width) tier = m.map.image.width;
      return M.clamp((texelsPerM || 500) / Math.max(tier * rep, 1e-3), 0.02, 50);
    } catch (e) { return 1; }
  };

  // Density audit. Only runs when a consumer declares opts.uvScale, so it
  // costs nothing for everyone else and never fires spuriously.
  //
  // The review asked for this to be promoted from advisory to GAME.logError so
  // a mis-UV'd wall is caught at build rather than in a capture. It is not,
  // deliberately, for two reasons. (1) GAME.logError feeds the on-screen error
  // badge AND makes tools/shoot.py mark the capture as failed - so a density
  // advisory would break every other agent's capture loop over something that
  // is not a JS error. (2) More importantly it would not fire: the check can
  // only run when a consumer volunteers opts.uvScale, and no consumer does.
  //
  // The real fix for the three surfaces that were measurably wrong -
  // concrete_wall, plaster and brick, where interior.png measured a 30 px
  // detail period on a 1.2 m wall against 180 px on a 5 m pier - is structural
  // and is applied in DEFS: they are world-projected now, so their scale is
  // immune to whatever UVs the level authored and the failure mode cannot
  // recur. A checker for a class of bug that has been designed out is worth
  // less than the design change. Violations are recorded on
  // `this.densityWarnings` for anyone who wants to assert on them.
  MaterialLibrary.prototype._checkDensity = function (name, def, opts, maps) {
    if (opts.uvScale === undefined || def.tri) return;
    if (!maps.map || !maps.map.image || !maps.map.image.width) return;
    var d = maps.map.image.width * (def.repeat || 1) * opts.uvScale;
    var want = this.uvScaleFor(name, 500);
    if (d < 350 || d > 750) {
      this.densityWarnings.push({ name: name, texelsPerM: Math.round(d), wantUvScale: want });
      try {
        console.warn('materials: ' + name + ' lands at ' + Math.round(d) +
          ' texels/m (budget 350-750); uvScaleFor("' + name + '") wants ' +
          want.toFixed(3));
      } catch (e) { /* no console: the audit is advisory only */ }
    }
  };

  /** makeTriplanar(name, opts) -> material using world-space projection. */
  MaterialLibrary.prototype.makeTriplanar = function (name, opts) {
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.triplanar = true;
    return this.get(name, o);
  };

  /** has(name) -> is this a name the library actually has a definition for? */
  MaterialLibrary.prototype.has = function (name) {
    if (!name) return false;
    if (ALIASES[name]) name = ALIASES[name];
    return !!DEFS[name];
  };

  /**
   * maps(name, opts) -> { map, normalMap, roughnessMap, metalnessMap, aoMap,
   *                       heightMap, userData:{ rough, roughFlat, ns, metal,
   *                       env, ao, alb, detailKind } }
   *
   * The RAW calibrated map set, with none of this library's shader work
   * attached. Same acquisition path get() uses - correct recipe name, correct
   * colour space, correct wrapping, correct anisotropy, correct repeat, and the
   * fallback synthesis if ctx.textures is unavailable.
   *
   * WHY THIS EXISTS. get() returns a FINISHED material with its own
   * onBeforeCompile, so a consumer that needs to inject its own shader (the
   * weapon's wear/anodise pass, the character's vertex-colour tinting) cannot
   * use it - and both of them therefore hand-rolled bare MeshStandardMaterials
   * with `map: null`. The result was several MB of VRAM and boot time spent
   * generating gun_metal, gun_polymer, cloth_olive, cloth_tan and skin map sets
   * that nothing in the build ever sampled, while the receiver photographed as
   * uniform matte charcoal with none of the anodise mottle, broach striation,
   * carbon fouling or bare-aluminium rub-through that genGunMetal authors, and
   * flipped colour between scenarios because no albedo map anchored it.
   *
   * The gap was API SHAPE, not content. Take the maps, keep your own shader:
   *
   *     var m = ctx.materials.maps('gun_metal', { repeat: 3.0 });
   *     std({ map: m.map, nMap: m.normalMap, rMap: m.roughnessMap,
   *           rough: 1.0, metal: m.userData.metal });
   *
   * Note roughness must be 1.0 when a roughnessMap is bound - three multiplies
   * the two - and userData.rough carries the [min,max] window this library
   * would have remapped the texture into.
   */
  MaterialLibrary.prototype.maps = function (name, opts) {
    var n = (name || 'default');
    if (ALIASES[n]) n = ALIASES[n];
    var def = DEFS[n] || DEFS.concrete;
    var out;
    try {
      out = this._maps(n, def, opts || {});
    } catch (e) {
      GAME.logError('materials.maps:' + n, e);
      out = { map: null, normalMap: null, roughnessMap: null, aoMap: null, metalnessMap: null, heightMap: null };
    }
    var mean = null;
    try { mean = out.map ? this._mapMean(out.map) : null; } catch (e2) { mean = null; }
    out.userData = {
      name: n,
      rough: def.rough || [0.2, 0.95],
      roughFlat: def.roughFlat,
      ns: def.ns,
      metal: def.metal,
      env: def.env,
      ao: def.ao,
      alb: def.alb,
      repeat: def.repeat,
      detailKind: def.detailKind || 'mineral',
      // The measured mean linear colour of the albedo map, so a consumer that
      // wants this library's calibration without its shader can solve its own
      // gain: gain = targetAlbedo / measuredMean.lum.
      measured: mean
    };
    // The detail tile, so a consumer's own shader can composite the same
    // micro-surface family the rest of the build uses.
    out.detailNormal = this._detailTex(out.userData.detailKind);
    return out;
  };

  /**
   * cloth(variant, opts) -> THREE.Material for a hung sheet of laundry.
   *
   * props.js used to build this from a local canvas: base #cfc6b6 (0.62
   * linear), per-instance jitter up to 1.12x, envMapIntensity 1.15, no
   * roughness map, no sheen and no albedo anchor. It was the flattest asset in
   * the build - flat blue-grey slabs with soft blurry stains and no structure
   * at any frequency, and the brightest object in the upper frame at night.
   *
   * `variant` (any string/number) hashes to a deterministic dye lot, so a line
   * of six sheets is six different washes rather than six copies - and because
   * it is a hash rather than rng, captures stay reproducible.
   *
   * The wind sway stays with the caller: take this material, inject the wind
   * vertex shader, push to windMats. clone() on it preserves this library's
   * shader (see _patch), so the caller's own onBeforeCompile is the only thing
   * it has to add.
   */
  var CLOTH_LOTS = [0x8f8878, 0x9c9484, 0x7e8489, 0x93826c, 0x86907f,
    0xa09684, 0x77808a, 0x8b7f74];
  MaterialLibrary.prototype.cloth = function (variant, opts) {
    opts = opts || {};
    var vk = (variant === undefined || variant === null) ? '' : String(variant);
    var h = hashString('cloth|' + vk);
    var o = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    if (o.albedoTarget === undefined && o.color === undefined) {
      o.albedoTarget = CLOTH_LOTS[h % CLOTH_LOTS.length];
    }
    // A little per-lot roughness/sheen spread so the line does not read as one
    // bolt of fabric cut up.
    if (o.sheen === undefined) o.sheen = 0.42 + ((h >>> 7) % 100) / 100 * 0.22;
    return this.get('laundry', o);
  };

  /**
   * distant(name, fogColor, metres, opts) -> a material pre-faded into the
   * aerial perspective for geometry that sits `metres` away.
   *
   * The far city blocks in rooftop.png measure 0.324 and 0.295 linear against
   * 0.117 on the fully-textured sunlit hero facade in the same frame - the
   * least-finished asset in the shot is 2.8x brighter than the most-finished
   * one, sits ON the horizon line with no aerial perspective at all, and reads
   * as white cardboard boxes. Fog applied in the shader cannot fix that on its
   * own because a proxy that starts too bright stays too bright.
   *
   * So: solve the fade on the CPU, into the base colour and the env weight, at
   * build time. A 60 m proxy then physically cannot out-value a 10 m sunlit
   * wall whatever the lighting does afterwards.
   *
   *     lib.distant('far_facade', ctx.sky && ctx.sky.fogColor, 60)
   *
   * fogColor may be a THREE.Color, a hex, or missing - the palette dust tone
   * (#c9b08a, ART_DIRECTION) is the fallback.
   */
  MaterialLibrary.prototype.distant = function (name, fogColor, metres, opts) {
    var n = name || 'far_facade';
    if (ALIASES[n]) n = ALIASES[n];
    if (!DEFS[n]) n = 'far_facade';
    var d = metres === undefined ? 60 : Math.max(0, metres);
    var fc = new THREE.Color(0.62, 0.52, 0.40);          // #c9b08a in linear-ish
    try {
      if (fogColor && fogColor.isColor) fc.copy(fogColor);
      else if (typeof fogColor === 'number') srgb(fogColor, fc);
    } catch (e) { /* palette fallback */ }

    // Beer-Lambert against a density that puts ~63% haze at 55 m, which is the
    // "dense enough that 60 m reads hazy" ART_DIRECTION asks for.
    var density = (opts && opts.density !== undefined) ? opts.density : 0.018;
    var haze = 1.0 - Math.exp(-d * density);
    haze = M.clamp(haze, 0, 0.92);

    var def = DEFS[n];
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    delete o.density;
    // Pull the anchored reflectance toward the fog colour, and drop the IBL by
    // the same factor so the proxy cannot pick a specular highlight out of a
    // sky it is supposed to be dissolving into.
    if (o.albedoTarget === undefined && o.color === undefined) {
      var base = srgb(def.color, new THREE.Color());
      var lum = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
      var s = (def.alb || 0.16) / Math.max(lum, 1e-4);
      base.setRGB(
        M.clamp(M.lerp(base.r * s, fc.r * 0.55, haze), 0, 1),
        M.clamp(M.lerp(base.g * s, fc.g * 0.55, haze), 0, 1),
        M.clamp(M.lerp(base.b * s, fc.b * 0.55, haze), 0, 1));
      // albedoTarget is read through srgb() -> Color.setHex(), which takes a
      // NUMBER; a '#rrggbb' string silently becomes NaN.
      o.albedoTarget = base.getHex(THREE.SRGBColorSpace);
    }
    if (o.envMapIntensity === undefined) o.envMapIntensity = (def.env || 0.5) * (1 - haze * 0.8);
    o.__d = Math.round(d);
    var m = this.get(n, o);
    try { m.userData.gbHaze = haze; } catch (e2) { /* frozen userData */ }
    return m;
  };

  /**
   * blended(nameA, nameB, opts) -> a triplanar material that lerps between two
   * whole map sets on VERTEX ALPHA, with a world-space noise fallback where no
   * alpha is supplied.
   *
   * Butting two materials edge to edge is how the road came to step 9.4x in
   * value into the adjacent sand across a hard, unfeathered straight line at
   * x~1000 in enemy_closeup.png. A transition needs to be painted, not cut.
   *
   *     var m = ctx.materials.blended('asphalt', 'sand');
   *     // geometry needs a `color` attribute with itemSize 4; alpha 0 = A,
   *     // alpha 1 = B. Leave it out and the blend follows world noise.
   *
   * The B set is bound to the spare texture slots three.js is not using on a
   * standard material (emissiveMap / lightMap / alphaMap / bumpMap slots would
   * all fight other features), so it is passed as private uniforms instead.
   */
  MaterialLibrary.prototype.blended = function (nameA, nameB, opts) {
    opts = opts || {};
    var a = ALIASES[nameA] || nameA || 'asphalt';
    var b = ALIASES[nameB] || nameB || 'sand';
    var key = 'blend|' + a + '|' + b + '|' + hashOpts('', opts);
    if (this.cache[key]) return this.cache[key];

    var mat;
    try {
      var defB = DEFS[b] || DEFS.sand;
      var mapsB = this._maps(b, defB, {});
      var meanB = mapsB.map ? this._mapMean(mapsB.map) : null;
      var gB = 1.0;
      if (defB.alb && meanB && meanB.lum > 1e-4) {
        gB = M.clamp(defB.alb / meanB.lum, 0.12, 6.0);
      }
      var o = {};
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
      o.triplanar = true;
      o.vertexColors = true;
      o.wearMode = 'none';                    // alpha is the blend, not wear
      o.blendWith = {
        key: b, maps: mapsB, gain: gB,
        scale: defB.repeat || 1.0,
        rough: defB.rough || [0.3, 0.95]
      };
      o.__blend = key;
      mat = this.get(a, o);
      mat.userData.gbBlendPair = a + '+' + b;
      mat.name = key;
    } catch (e) {
      GAME.logError('materials.blended:' + a + '+' + b, e);
      mat = this.get(a);
    }
    this.cache[key] = mat;
    return mat;
  };

  /** Convenience: a material with vertex wear painting enabled. */
  MaterialLibrary.prototype.wearable = function (name, opts) {
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.vertexColors = true;
    return this.get(name, o);
  };

  // ==========================================================================
  // Material construction
  // ==========================================================================
  MaterialLibrary.prototype._create = function (name, opts) {
    opts = opts || {};
    var def = DEFS[name] || DEFS.concrete;
    var maps = this._maps(name, def, opts);
    try { this._checkDensity(name, def, opts, maps); } catch (e) { /* advisory */ }

    var usePhysical = !!(opts.physical || def.sheen || opts.clearcoat || opts.sheen);
    var Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;

    // ---- albedo anchoring ---------------------------------------------------
    // The map ALREADY carries this material's colour. Multiplying def.color on
    // top of it squares the albedo - the single biggest reason the ground was
    // crushing to black while the sky clipped white in the same frame. So:
    //   * explicit opts.color  -> honour it, it is a deliberate tint
    //   * no map               -> def.color is the only colour we have
    //   * map + def.alb        -> neutral gain solved from a measurement
    //   * map, no target       -> white, use the map exactly as authored
    var mean = maps.map ? this._mapMean(maps.map) : null;
    var gain = 1.0;
    var baseColor;
    if (opts.albedoTarget !== undefined && maps.map && mean && mean.lum > 1e-4) {
      // MEASURED WHITE BALANCE. opts.color is a raw multiplier and therefore
      // SQUARES a map that already carries the material's colour (a pale tint
      // over a pale map lands nowhere near either). albedoTarget instead says
      // "make the MEAN of this surface be exactly this colour" and solves a
      // per-channel gain from the measurement, so the texture's own hue
      // variation survives around the requested mean instead of being
      // multiplied on top of it. This is the correct way for a consumer to
      // re-purpose a shared map (a tan sack out of the awning weave, a
      // repainted drum) and it is what props.js should be using instead of
      // opts.color.
      var tgt = srgb(opts.albedoTarget);
      var lo = 0.10, hi = 8.0;
      baseColor = new THREE.Color(
        M.clamp(tgt.r / Math.max(mean.r, 1e-4), lo, hi),
        M.clamp(tgt.g / Math.max(mean.g, 1e-4), lo, hi),
        M.clamp(tgt.b / Math.max(mean.b, 1e-4), lo, hi));
      gain = 0.2126 * baseColor.r + 0.7152 * baseColor.g + 0.0722 * baseColor.b;
    } else if (opts.color !== undefined) {
      baseColor = srgb(opts.color);
    } else if (!maps.map) {
      baseColor = srgb(def.color);
    } else {
      if (def.alb && mean && mean.lum > 1e-4) {
        gain = M.clamp(def.alb / mean.lum, 0.12, 6.0);
      }
      baseColor = new THREE.Color(gain, gain, gain);   // linear multiplier
      // PALETTE ANCHOR. The neutral gain above fixes VALUE but is blind to
      // HUE, and textures.js authors nearly the whole library inside one
      // sun-baked tan - so concrete, tile, gravel and asphalt all arrived at
      // the same chromaticity and the ART_DIRECTION palette never landed.
      // solveChroma tilts the gain toward def.color and then renormalises, so
      // the mean luminance is still exactly def.alb.
      // alb === null (metals, alpha-cut maps) used to skip solveChroma
      // entirely, so gun_metal, corrugated_metal, rusted_metal, glass and
      // foliage carried whatever chromaticity textures.js happened to author -
      // which is why seven "distinct" families measured inside a few percent
      // of one warm tan on the chart. Anchoring the CHROMATICITY does not need
      // a reflectance target: use the map's own measured luminance and the
      // solve becomes a pure hue rotation with zero change in value, which is
      // exactly right for a metal (where `color` is the F0 tint) and safe for
      // anything whose mean brightness is meaningful but whose hue is not.
      var hueAmt = opts.hue !== undefined ? opts.hue : (def.hue || 0);
      var hueTarget = def.alb || (mean ? mean.lum : 0);
      if (hueAmt > 0 && hueTarget > 1e-4 && mean && mean.lum > 1e-4) {
        gain = solveChroma(baseColor, mean, def.color, hueTarget, hueAmt, gain);
      }
    }

    var params = {
      color: baseColor,
      roughness: opts.roughness !== undefined ? opts.roughness
        : (maps.roughnessMap ? 1.0 : def.roughFlat),
      metalness: opts.metalness !== undefined ? opts.metalness : def.metal,
      envMapIntensity: opts.envMapIntensity !== undefined ? opts.envMapIntensity : def.env
    };

    if (maps.map) params.map = maps.map;
    if (maps.normalMap) params.normalMap = maps.normalMap;
    if (maps.roughnessMap) params.roughnessMap = maps.roughnessMap;
    if (maps.metalnessMap) params.metalnessMap = maps.metalnessMap;
    if (maps.aoMap) params.aoMap = maps.aoMap;

    var mat = new Ctor(params);

    if (maps.normalMap) {
      var ns = opts.normalScale !== undefined ? opts.normalScale : def.ns;
      mat.normalScale = new THREE.Vector2(ns, ns);
    }
    if (maps.aoMap) {
      mat.aoMapIntensity = opts.aoMapIntensity !== undefined ? opts.aoMapIntensity : def.ao;
    }

    if (usePhysical) {
      // Cloth needs a sheen lobe or it reads as painted cardboard.
      var sh = opts.sheen !== undefined ? opts.sheen : (def.sheen || 0);
      if (sh > 0) {
        mat.sheen = sh;
        mat.sheenRoughness = 0.75;
        mat.sheenColor = srgb(opts.sheenColor !== undefined ? opts.sheenColor : 0xbfae94);
      }
      if (opts.clearcoat) {
        mat.clearcoat = opts.clearcoat;
        mat.clearcoatRoughness = opts.clearcoatRoughness !== undefined ? opts.clearcoatRoughness : 0.25;
      }
    }

    // ---- plain material flags ----------------------------------------------
    var side = opts.side !== undefined ? opts.side : def.side;
    if (side !== undefined) mat.side = side === 2 ? THREE.DoubleSide : side;
    // Some materials (glazing) are transparent by nature, not by request.
    if (def.transparent && opts.transparent === undefined && opts.opacity === undefined) {
      mat.transparent = true;
      mat.opacity = def.opacity !== undefined ? def.opacity : 1.0;
      mat.depthWrite = opts.depthWrite !== undefined ? opts.depthWrite : false;
    }
    if (opts.transparent) { mat.transparent = true; mat.depthWrite = opts.depthWrite !== false; }
    if (opts.opacity !== undefined) { mat.opacity = opts.opacity; mat.transparent = opts.opacity < 1; }
    if (opts.alphaTest !== undefined) mat.alphaTest = opts.alphaTest;
    if (opts.depthWrite !== undefined) mat.depthWrite = opts.depthWrite;
    if (opts.flatShading) mat.flatShading = true;
    if (opts.emissive !== undefined) {
      mat.emissive = srgb(opts.emissive);
      mat.emissiveIntensity = opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1.0;
    }
    if (opts.vertexColors) mat.vertexColors = true;
    mat.shadowSide = mat.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide;
    mat.userData.gbAlbedoGain = gain;
    if (mean) mat.userData.gbAlbedoLinear = def.alb ? def.alb : mean.lum;

    // PREMULTIPLIED SPECULAR. Alpha blending scales the whole shaded result,
    // so on any coverage-blended surface the specular lobe - the one cue that
    // makes glazing read as glazing - was being multiplied down by the same
    // factor that makes it see-through. Composite premultiplied instead: the
    // shader scales only the transmitted half and the blend adds the
    // reflection on top. See the premulSpec block in _fragmentShader.
    var premul = opts.premul !== undefined ? !!opts.premul
      : (!!def.premul && mat.transparent && !mat.transmission);
    if (premul) {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      mat.premultipliedAlpha = false;
    }

    // ---- shader features ----------------------------------------------------
    var F = this._features(name, def, opts, maps, mat);
    F.premulSpec = premul;
    F.mapMean = mean;
    this._patch(mat, F);

    return mat;
  };

  // Decide which shader features this material gets.
  MaterialLibrary.prototype._features = function (name, def, opts, maps, mat) {
    var detailOn = this.enableDetail && opts.detail !== false && !!this._detailNormal &&
      !!maps.normalMap && (opts.detail !== undefined ? !!opts.detail : def.detail > 0);
    var detailAmt = typeof opts.detail === 'number' ? opts.detail : def.detail;

    var macroOn = this.enableMacro && opts.macro !== false &&
      (opts.macro !== undefined ? !!opts.macro : def.macro > 0) && !!maps.map;
    var macroAmt = typeof opts.macro === 'number' ? opts.macro : def.macro;

    var triOn = opts.triplanar !== undefined ? !!opts.triplanar : !!def.tri;
    if (triOn && !maps.map) triOn = false;

    // Stochastic tiling is a planar-path feature: doing it on top of the three
    // triplanar projections would be six taps per map for a surface that is
    // already world-projected and therefore free of the UV-seam artefacts this
    // exists to hide.
    var stochOn = (opts.stochastic !== undefined ? !!opts.stochastic : !!def.stoch) &&
      !triOn && !!maps.map;

    // Rotation defaults to OFF and is forced off for any map flagged as
    // gravity-directional; those get the horizontal mirror instead.
    var stochRot = 0;
    if (stochOn) {
      stochRot = opts.stochRot !== undefined ? (opts.stochRot | 0)
        : (def.stochRot === undefined ? 0 : (def.stochRot | 0));
      if (def.dir || opts.directional) stochRot = 0;
      if (stochRot !== 0 && stochRot !== 2 && stochRot !== 4) stochRot = 0;
    }
    // Tile low-pass. Only meaningful for the stochastic path; if the map is
    // not CPU-readable the feature disables itself and nothing changes.
    var tileLP = null, stochFlat = 0;
    if (stochOn) {
      stochFlat = opts.stochFlat !== undefined ? opts.stochFlat
        : (def.flat !== undefined ? def.flat : 0.85);
      if (stochFlat > 0.001) {
        tileLP = this._tileLowpass(maps.map);
        if (!tileLP) stochFlat = 0;
      } else { stochFlat = 0; }
    }

    var pomDepth = typeof opts.parallax === 'number' ? opts.parallax
      : (opts.parallax === false ? 0 : (opts.parallax === true ? (def.pom || 0.02) : def.pom || 0));
    // POM and stochastic tiling are mutually exclusive: the parallax offset is
    // computed in the untransformed UV, and applying it after a per-cell
    // rotation would tear along every cell boundary. Repetition is on the
    // instant-fail list and parallax is not, so tiling wins.
    var pomOn = this.enableParallax && pomDepth > 0 && !!maps.heightMap &&
      !triOn && !stochOn && !!maps.map;

    var wearOn = !!(opts.vertexColors && (opts.wearMode || 'wear') === 'wear');
    var groundOn = opts.grounding !== undefined ? !!opts.grounding : !!def.ground;

    // Every world-space feature needs the world position/normal varyings.
    var wdet = detailOn && (opts.worldDetail !== undefined ? !!opts.worldDetail : !!def.wdet);

    // ---- meso band (0.1-0.6 m) ---------------------------------------------
    // Only for surfaces whose detail layer is world-projected: on a character
    // or anything else that moves, a world-locked meso layer would swim across
    // the surface exactly as the world detail layer would. Triplanar surfaces
    // are world-projected by definition and get it too - they are the ground
    // and the roof deck, which are the emptiest mid-ground in the build.
    var mesoAllowed = detailOn && (wdet || triOn);
    var mesoAmt = opts.meso !== undefined
      ? (typeof opts.meso === 'number' ? opts.meso : (opts.meso ? 0.8 : 0))
      : (def.meso || 0);
    var mesoOn = mesoAllowed && mesoAmt > 0;

    // ---- gloss mask ---------------------------------------------------------
    // Needs a low-frequency spatial field; world position where we have it,
    // otherwise the base UV (characters, viewmodel parts and anything else
    // whose detail layer is UV-space would swim if we locked it to the world).
    var polishAmt = opts.polish !== undefined
      ? (typeof opts.polish === 'number' ? opts.polish : (opts.polish ? 0.5 : 0))
      : (def.polish || 0);
    var polishOn = polishAmt > 0.001 && detailOn;

    var worldOn = triOn || macroOn || groundOn || wdet || mesoOn;

    // ---- near detail tier ---------------------------------------------------
    // ARCHITECTURE 7.7 asks for micro detail at two scales. The far and mid
    // field had them (the 5 cm detail tile and the 0.55 m meso band); the near
    // field did not, so the alley wall at 1.5 m was a blurry craquelure with no
    // sub-centimetre structure and the sandbags at 1 m showed no jute strand.
    //
    // NOTE ON SCALE. The review asked for a ~0.8 cm tier. That is below what
    // the frame can carry: at 1 m a 720p pixel covers ~1.5 mm of surface, so a
    // 256-texel tile with an 0.8 cm period is minified 20x and every fetch
    // returns the tile's own mean - the layer would cost a texture read and
    // draw literally nothing outside about 30 cm, which in this build is only
    // the weapon (and weapons.js does not use this path). So the near tier is
    // a ~3.2 cm period instead: a SECOND, DECORRELATED sample of the family
    // field (rotated 90 degrees and phase-shifted) that lands squarely in the
    // resolvable band at 0.5-3 m, breaks the base layer's own 5 cm lattice at
    // the range it is actually visible, and raises micro-normal amplitude
    // exactly where the surface is read closest. Ramped to zero by 7 m, so it
    // costs one fetch only on surfaces that are near the camera.
    var det2On = detailOn && this.enableDetail2 &&
      (opts.detail2 !== undefined ? !!opts.detail2 : true);

    var triScale = opts.triScale !== undefined ? opts.triScale : (def.repeat || 0.5);
    // Detail is authored as a world-space period in centimetres, so the layer
    // lands at the same physical scale no matter what UV scale the consumer
    // supplies. detailTile is the fallback for UV-space detail (characters and
    // anything that moves, where a world-locked detail layer would swim).
    var detailCm = opts.detailCm !== undefined ? opts.detailCm : def.detailCm;
    var detailScale = detailCm > 0 ? 100 / detailCm : 20;
    var detailTile;
    if (opts.detailTile !== undefined) detailTile = opts.detailTile;
    else if (triOn && detailCm > 0) detailTile = detailScale / Math.max(triScale, 1e-3);
    else detailTile = def.detailTile || (detailCm > 0 ? detailScale : 12);

    // Per-axis triplanar domain-warp amplitude, in tiles.
    var tw = opts.triWarp !== undefined ? opts.triWarp : def.triWarp;
    if (typeof tw === 'number') tw = [tw, tw, tw];
    if (!tw || !tw.length) tw = [0.42, 0.42, 0.42];
    var triWarpOn = triOn && (tw[0] > 0.001 || tw[1] > 0.001 || tw[2] > 0.001);
    // Tile low-pass on the triplanar albedo. Same measurement the stochastic
    // path uses; 16x16, so three extra fetches are effectively free.
    var triLP = null;
    var triFlat = opts.stochFlat !== undefined ? opts.stochFlat
      : (def.flat !== undefined ? def.flat : 0.75);
    if (triOn && triFlat > 0.001 && maps.map) {
      triLP = this._tileLowpass(maps.map);
      if (!triLP) triFlat = 0;
    } else { triFlat = 0; }

    var detailKind = opts.detailKind || def.detailKind || 'mineral';

    // ---- second layer (see MaterialLibrary.blended) --------------------------
    var bw = (triOn && opts.blendWith && opts.blendWith.maps && opts.blendWith.maps.map)
      ? opts.blendWith : null;

    return {
      blend: !!bw,
      blendWith: bw,
      blendNormal: !!(bw && bw.maps.normalMap),
      blendOrm: !!(bw && bw.maps.roughnessMap),
      name: name,
      world: worldOn,
      triplanar: triOn,
      triScale: triScale,
      triSharp: opts.triSharp !== undefined ? opts.triSharp
        : (def.triSharp !== undefined ? def.triSharp : 5.0),
      triWarp: triWarpOn ? tw : null,
      triLP: triLP,
      triFlat: triFlat,
      // Per-texel chroma variance multiplier (1 = leave the map alone).
      chroma: opts.chroma !== undefined ? M.clamp(opts.chroma, 0, 1)
        : (def.chroma !== undefined ? def.chroma : 1.0),
      detail: detailOn,
      detailKind: detailKind,
      detail2: det2On,
      polish: polishOn,
      polishAmount: polishAmt,
      detailStrength: detailAmt,
      detailTile: detailTile,
      detailScale: detailScale,
      worldDetail: wdet,
      detailRough: opts.detailRough !== undefined ? opts.detailRough : 0.22,
      detailCavity: opts.detailCavity !== undefined ? opts.detailCavity : 0.85,
      stochastic: stochOn,
      // Rotation is opt-IN and forced off for gravity-directional maps. The
      // default used to be 4 (90-degree steps) whenever a def merely set
      // stoch:true, so the failure mode was opt-OUT: any new material with
      // directional weathering silently got its drips run sideways.
      stochRot: stochRot,
      stochFlip: stochOn && (opts.stochFlip !== undefined ? !!opts.stochFlip
        : (def.stochFlip !== undefined ? !!def.stochFlip : true)),
      stochFlat: stochFlat,
      tileLP: tileLP,
      stochQ: def.stochQ || [0, 0],
      meso: mesoOn,
      mesoAmount: mesoAmt,
      // 0.55 m world period. Long enough to sit above the 5 cm detail layer
      // and below gbMacroNoise's 1 m octave, which is exactly the hole.
      mesoScale: opts.mesoScale !== undefined ? opts.mesoScale : 1.82,
      grounding: groundOn,
      groundY: opts.groundY !== undefined ? opts.groundY : this.groundY,
      groundHeight: opts.groundHeight !== undefined ? opts.groundHeight
        : (def.groundH !== undefined ? def.groundH : 1.35),
      groundAmount: opts.groundAmount !== undefined ? opts.groundAmount
        : (def.groundAmt !== undefined ? def.groundAmt : 0.5),
      groundWeep: opts.groundWeep !== undefined ? opts.groundWeep
        : (def.groundWeep !== undefined ? def.groundWeep : 0.55),
      macro: macroOn,
      macroAmount: macroAmt,
      macroScale: opts.macroScale !== undefined ? opts.macroScale : 0.32,
      parallax: pomOn,
      parallaxDepth: pomDepth,
      pomSteps: this.pomSteps,
      wear: wearOn,
      vertexColors: !!opts.vertexColors,
      roughRange: opts.roughRange || def.rough || [0.2, 0.95],
      hasRoughMap: !!maps.roughnessMap,
      hasAoMap: !!maps.aoMap,
      // textures.js packs AO/roughness/metalness into ONE glTF-style ORM
      // texture and hands the same object back for all three slots. On the
      // planar path three.js's own uv transforms make that free, but the
      // triplanar path samples by world position, so it was paying three
      // separate 3-tap fetches of the identical image - nine reads for three
      // channels. Sampling it once and splitting the channels takes every wall
      // and road fragment from ~18 texture reads to ~12.
      sharedOrm: !!(triOn && maps.roughnessMap &&
        maps.roughnessMap.image &&
        (!maps.aoMap || maps.aoMap.image === maps.roughnessMap.image) &&
        (!maps.metalnessMap || maps.metalnessMap.image === maps.roughnessMap.image)),
      hasNormalMap: !!maps.normalMap,
      // Specular AA only means anything where a normal map (or the detail /
      // meso layers) can put sub-pixel variation into the shading normal.
      specAA: (!!maps.normalMap || detailOn)
        ? (opts.specAA !== undefined ? opts.specAA
          : (def.specAA !== undefined ? def.specAA : 0.42))
        : 0,
      hasMetalMap: !!maps.metalnessMap,
      translucent: !!opts.translucent,
      heightMap: maps.heightMap,
      wearMetal: opts.wearMetalness !== undefined ? opts.wearMetalness : (def.metal > 0.5 ? 1.0 : 0.0),
      wearColor: opts.wearColor !== undefined ? opts.wearColor : (def.metal > 0.5 ? 0x9aa0a6 : 0xb9ae9a),
      grimeColor: opts.grimeColor !== undefined ? opts.grimeColor : 0x4c4338,
      dustColor: opts.dustColor !== undefined ? opts.dustColor
        : (def.dust !== undefined ? def.dust : 0xa8977a),
      // Indirect-specular occlusion. This is how an over-bright environment is
      // meant to be controlled - by occluding the reflection where the surface
      // physically cannot see the sky - rather than by flattening roughness
      // until nothing in the library can produce a highlight at all.
      specOcc: opts.specOcc !== undefined ? !!opts.specOcc : true,
      // Glazing only (see the injection in _fragmentShader).
      premulSpec: !!opts.premulSpec,
      sssColor: opts.sssColor !== undefined ? opts.sssColor : 0x8fa054,
      sssScale: opts.sssScale !== undefined ? opts.sssScale : 0.85,
      sssPower: opts.sssPower !== undefined ? opts.sssPower : 3.0,
      sssWrap: opts.sssWrap !== undefined ? opts.sssWrap : 0.6,
      sssAmbient: opts.sssAmbient !== undefined ? opts.sssAmbient : 0.28,
      wind: opts.wind ? (typeof opts.wind === 'number' ? opts.wind : 0.06) : 0,
      isPhysical: !!mat.isMeshPhysicalMaterial
    };
  };

  // ==========================================================================
  // The onBeforeCompile patch
  // ==========================================================================
  MaterialLibrary.prototype._patch = function (mat, F) {
    var self = this;
    var anyShader = F.world || F.triplanar || F.detail || F.macro || F.parallax ||
      F.wear || F.translucent || F.hasRoughMap || F.wind || F.stochastic ||
      F.grounding || F.specAA || F.polish || F.premulSpec ||
      (F.specOcc && (F.detail || F.grounding || F.hasNormalMap));
    if (!anyShader) return mat;

    // Uniform objects live on the material so update() and other systems can
    // poke them; assigning the *same* objects into shader.uniforms means a
    // recompile does not orphan them.
    var U = {
      gbTime: self._time,
      gbFadeRange: { value: new THREE.Vector2(self.detailFadeNear, self.detailFadeFar) }
    };
    if (F.detail) {
      U.gbDetailNormal = { value: self._detailTex(F.detailKind) };
      U.gbDetailStrength = { value: F.detailStrength };
      U.gbDetailTile = { value: F.detailTile };
      U.gbDetailScale = { value: F.detailScale };
      U.gbDetailRough = { value: F.detailRough };
      U.gbDetailCav = { value: F.detailCavity };
    }
    if (F.detail2) {
      U.gbDet2Range = { value: new THREE.Vector2(self.detail2Near, self.detail2Far) };
    }
    if (F.polish) U.gbPolishAmt = { value: F.polishAmount };
    // The grounding term reuses the macro noise field, so both uniforms have to
    // exist whenever either feature is on.
    if (F.macro || F.grounding) {
      U.gbMacroScale = { value: F.macroScale };
      U.gbMacroAmount = { value: F.macroAmount };
      U.gbDustColor = { value: srgb(F.dustColor) };
    }
    if (F.grounding) {
      // x = ground plane Y, y = band height, z = amount, w = under-ledge weep
      U.gbGround = {
        value: new THREE.Vector4(F.groundY, F.groundHeight, F.groundAmount, F.groundWeep)
      };
    }
    if (F.stochastic) {
      U.gbStochQ = { value: new THREE.Vector2(F.stochQ[0] || 0, F.stochQ[1] || 0) };
      var mm = F.mapMean;
      U.gbStochMean = {
        value: new THREE.Vector4(
          mm ? mm.r : 0.25, mm ? mm.g : 0.25, mm ? mm.b : 0.25,
          mm ? Math.min(mm.alpha, 1) : 1.0)
      };
      if (F.tileLP) {
        U.gbTileLP = { value: F.tileLP };
        U.gbTileFlat = { value: F.stochFlat };
      }
    }
    if (F.meso) {
      U.gbMesoScale = { value: F.mesoScale };
      U.gbMesoAmount = { value: F.mesoAmount };
    }
    if (F.blend) {
      var bm = F.blendWith;
      U.gbBlendMap = { value: bm.maps.map };
      U.gbBlendGain = { value: bm.gain };
      U.gbBlendScale = { value: bm.scale };
      U.gbBlendRough = { value: new THREE.Vector2(bm.rough[0], bm.rough[1]) };
      if (bm.maps.normalMap) U.gbBlendNrm = { value: bm.maps.normalMap };
      if (bm.maps.roughnessMap) U.gbBlendOrm = { value: bm.maps.roughnessMap };
    }
    if (F.triplanar) {
      U.gbTriScale = { value: F.triScale };
      U.gbTriSharp = { value: F.triSharp };
      U.gbTriWarp = {
        value: F.triWarp ? new THREE.Vector3(F.triWarp[0], F.triWarp[1], F.triWarp[2])
          : new THREE.Vector3(0, 0, 0)
      };
      if (F.triLP) {
        U.gbTileLP = { value: F.triLP };
        U.gbTileFlat = { value: F.triFlat };
      }
    }
    if (F.parallax) {
      U.gbHeightMap = { value: F.heightMap };
      U.gbParallaxDepth = { value: F.parallaxDepth };
    }
    if (F.hasRoughMap) U.gbRoughRange = { value: new THREE.Vector2(F.roughRange[0], F.roughRange[1]) };
    if (F.specAA) U.gbSpecAA = { value: F.specAA };
    if (F.wear) {
      U.gbGrimeColor = { value: srgb(F.grimeColor) };
      U.gbWearColor = { value: srgb(F.wearColor) };
      U.gbWearMetal = { value: F.wearMetal };
    }
    if (F.translucent) {
      U.gbSSSColor = { value: srgb(F.sssColor) };
      U.gbSSSScale = { value: F.sssScale };
      U.gbSSSPower = { value: F.sssPower };
      U.gbSSSWrap = { value: F.sssWrap };
      U.gbSSSAmbient = { value: F.sssAmbient };
    }
    if (F.wind) U.gbWind = { value: F.wind };

    // Non-enumerable so THREE.Material.copy()'s JSON round-trip of userData
    // skips them. level.js and props.js both clone every material they take
    // from here, and a JSON.stringify that walks into a Texture serialises the
    // whole image through a canvas - once per clone. The shader still gets the
    // uniforms (the onBeforeCompile closure holds them), and callers can still
    // read mat.userData.gbUniforms exactly as before.
    try {
      Object.defineProperty(mat.userData, 'gbUniforms',
        { value: U, enumerable: false, writable: true, configurable: true });
      Object.defineProperty(mat.userData, 'gbFeatures',
        { value: F, enumerable: false, writable: true, configurable: true });
    } catch (e) {
      mat.userData.gbUniforms = U;
      mat.userData.gbFeatures = F;
    }

    // three's default program cache key is onBeforeCompile.toString(); every
    // material here shares one closure body, so without an explicit key two
    // materials with different injected source would wrongly share a program.
    var ck = ['gb', F.name, F.world ? 'W' : '', F.triplanar ? 'T' + F.triSharp : '',
      F.detail ? (F.worldDetail ? 'Dw' : 'D') + (F.detail2 ? '2' : '') : '', F.macro ? 'M' : '',
      F.parallax ? 'P' + F.pomSteps : '',
      F.stochastic ? 'Y' + F.stochRot + (F.stochFlip ? 'f' : '') + (F.tileLP ? 'l' : '') : '',
      F.triplanar ? (F.triWarp ? 'q' : '') + (F.triLP ? 'l' : '') : '',
      F.meso ? 'E' : '', F.grounding ? 'G' : '', F.polish ? 'H' : '',
      F.specOcc ? 'O' : '', F.premulSpec ? 'U' : '',
      F.wear ? 'R' : '', F.vertexColors ? 'V' : '', F.translucent ? 'S' : '',
      F.hasRoughMap ? 'g' : '', F.hasAoMap ? 'a' : '', F.hasNormalMap ? 'n' : '',
      F.sharedOrm ? 'o' : '', F.blend ? 'B' : '',
      F.hasMetalMap ? 'm' : '', F.wind ? 'w' : '', F.specAA ? 'A' : '',
      F.isPhysical ? 'X' : ''].join('_');

    var obc = function (shader) {
      try {
        for (var k in U) shader.uniforms[k] = U[k];
        shader.vertexShader = self._vertexShader(shader.vertexShader, F);
        shader.fragmentShader = self._fragmentShader(shader.fragmentShader, F);
      } catch (e) {
        GAME.logError('materials.onBeforeCompile:' + F.name, e);
      }
    };
    var cpck = function () { return ck; };
    mat.onBeforeCompile = obc;
    mat.customProgramCacheKey = cpck;

    // THREE.Material.copy() does NOT carry onBeforeCompile or
    // customProgramCacheKey - they are not in its property list. level.js and
    // props.js both take a library material and clone() it (level to enable
    // vertexColors on merged geometry, props to avoid mutating a shared
    // material), which meant every wall, every road surface and every prop in
    // the build was silently rendering with a STOCK MeshStandardMaterial:
    // no triplanar, no detail, no macro variation, no parallax, no wear.
    // Cloning has to preserve the material, so override clone() here rather
    // than ask thirteen other files to remember a three.js quirk.
    var gbClone = function () {
      var c = new this.constructor();
      c.copy(this);
      c.onBeforeCompile = obc;
      c.customProgramCacheKey = cpck;
      c.clone = gbClone;                      // survives a clone of a clone
      try {
        Object.defineProperty(c.userData, 'gbUniforms',
          { value: U, enumerable: false, writable: true, configurable: true });
        Object.defineProperty(c.userData, 'gbFeatures',
          { value: F, enumerable: false, writable: true, configurable: true });
      } catch (e2) { /* userData is still a plain object, just enumerable */ }
      return c;
    };
    mat.clone = gbClone;
    return mat;
  };

  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._vertexShader = function (src, F) {
    if (!F.world && !F.wind) return src;

    var pars = [];
    if (F.world) pars.push('varying vec3 vGbWorld;', 'varying vec3 vGbWorldN;');
    if (F.wind) pars.push('uniform float gbTime;', 'uniform float gbWind;');
    src = pars.join('\n') + '\n' + src;

    if (F.wind) {
      // Cheap two-band sway keyed off object space so each leaf card moves
      // slightly differently. Applied before project_vertex.
      // Note: the shadow pass uses MeshDepthMaterial, which does not run
      // onBeforeCompile, so shadows do not sway. At these amplitudes (a few
      // centimetres) the mismatch is invisible; do not raise gbWind much.
      src = src.replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'float gbSwayPh = transformed.x * 1.7 + transformed.z * 2.3;',
        'float gbSway = sin( gbTime * 1.6 + gbSwayPh ) * 0.65 + sin( gbTime * 3.7 + gbSwayPh * 2.1 ) * 0.35;',
        'transformed.x += gbSway * gbWind * max( transformed.y, 0.0 );',
        'transformed.z += gbSway * gbWind * 0.6 * max( transformed.y, 0.0 );'
      ].join('\n'));
    }

    if (F.world) {
      // Recomputed rather than reusing three's `worldPosition`, which only
      // exists when USE_ENVMAP / shadows / transmission happen to be defined.
      src = src.replace('#include <project_vertex>', [
        '#include <project_vertex>',
        'vec4 gbWp = vec4( transformed, 1.0 );',
        '#ifdef USE_BATCHING',
        '  gbWp = batchingMatrix * gbWp;',
        '#endif',
        '#ifdef USE_INSTANCING',
        '  gbWp = instanceMatrix * gbWp;',
        '#endif',
        'vGbWorld = ( modelMatrix * gbWp ).xyz;'
      ].join('\n'));

      src = src.replace('#include <defaultnormal_vertex>', [
        '#include <defaultnormal_vertex>',
        'vec3 gbON = objectNormal;',
        '#ifdef USE_BATCHING',
        '  gbON = mat3( batchingMatrix ) * gbON;',
        '#endif',
        '#ifdef USE_INSTANCING',
        '  gbON = mat3( instanceMatrix ) * gbON;',
        '#endif',
        'vGbWorldN = normalize( mat3( modelMatrix ) * gbON );'
      ].join('\n'));
    }
    return src;
  };

  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._fragmentShader = function (src, F) {
    var pars = [];
    var head = [];   // runs at the top of main(), before any map sampling

    var needMacroFn = F.macro || F.grounding;

    pars.push('uniform float gbTime;');
    pars.push('uniform vec2 gbFadeRange;');
    pars.push('float gbDetailFade = 1.0;');
    pars.push('float gbMacroV = 0.5;');
    pars.push('float gbMacroHF = 1.0;');
    pars.push('vec2 gbUvShift = vec2( 0.0 );');
    if (F.wear) {
      pars.push('float gbGrime = 0.0;', 'float gbWet = 0.0;', 'float gbWear = 0.0;');
      pars.push('uniform vec3 gbGrimeColor;', 'uniform vec3 gbWearColor;', 'uniform float gbWearMetal;');
    }
    if (F.world) pars.push(G_COMMON);
    else if (F.polish) pars.push(G_NOISE);
    if (needMacroFn) {
      pars.push('uniform float gbMacroScale;', 'uniform float gbMacroAmount;', 'uniform vec3 gbDustColor;');
      pars.push(G_MACRO);
    }
    if (F.grounding) {
      pars.push('uniform vec4 gbGround;');
      pars.push('float gbSettle = 0.0;', 'float gbWeep = 0.0;');
      pars.push(G_GROUND);
    }
    if (F.detail) {
      pars.push('uniform sampler2D gbDetailNormal;', 'uniform float gbDetailStrength;',
        'uniform float gbDetailTile;', 'uniform float gbDetailScale;',
        'uniform float gbDetailRough;', 'uniform float gbDetailCav;');
      pars.push('vec4 gbDet = vec4( 0.5, 0.5, 0.5, 0.5 );');
      pars.push(G_RNM, G_DETN);
      if (F.worldDetail || F.meso) pars.push(G_DETUV);
    }
    if (F.detail2) {
      pars.push('uniform vec2 gbDet2Range;');
      pars.push('vec4 gbDet2 = vec4( 0.5, 0.5, 0.5, 0.5 );', 'float gbDet2W = 0.0;');
    }
    if (F.polish) {
      pars.push('uniform float gbPolishAmt;', 'float gbPolish = 0.0;');
      pars.push(G_POLISH);
    }
    if (F.meso) {
      pars.push('uniform float gbMesoScale;', 'uniform float gbMesoAmount;');
      pars.push('vec4 gbMes = vec4( 0.5, 0.5, 0.5, 0.5 );', 'float gbMesoW = 0.0;');
      pars.push(G_MESO);
    } else if (F.triplanar && F.detail2) {
      // The triplanar normal path perturbs a world-space normal, so the near
      // tier needs the same arbitrary-but-continuous tangent frame the meso
      // band uses.
      pars.push(G_MESO);
    }
    if (F.stochastic) {
      pars.push('#define GB_STOCH_ROT ' + (F.stochRot | 0));
      pars.push('#define GB_STOCH_FLIP ' + (F.stochFlip ? 1 : 0));
      pars.push('#define GB_STOCH_LP ' + (F.tileLP ? 1 : 0));
      pars.push('#define GB_LP_MIN ' + LP_MIN.toFixed(4));
      pars.push('#define GB_LP_SPAN ' + LP_SPAN.toFixed(4));
      pars.push('uniform vec2 gbStochQ;', 'uniform vec4 gbStochMean;');
      if (F.tileLP) pars.push('uniform sampler2D gbTileLP;', 'uniform float gbTileFlat;');
      pars.push('vec2 gbSW = vec2( 1.0, 0.0 );',
        'vec2 gbSUvA = vec2( 0.0 );', 'vec2 gbSUvB = vec2( 0.0 );',
        'vec2 gbSXA = vec2( 0.0 );', 'vec2 gbSYA = vec2( 0.0 );',
        'vec2 gbSXB = vec2( 0.0 );', 'vec2 gbSYB = vec2( 0.0 );',
        'mat2 gbSRA = mat2( 1.0, 0.0, 0.0, 1.0 );',
        'mat2 gbSRB = mat2( 1.0, 0.0, 0.0, 1.0 );');
      pars.push(G_STOCH);
    }
    if (F.triplanar) {
      pars.push('uniform float gbTriScale;', 'uniform float gbTriSharp;');
      pars.push('uniform vec3 gbTriWarp;');
      pars.push('#define GB_TRI_LP ' + (F.triLP ? 1 : 0));
      if (F.triLP) {
        pars.push('#define GB_LP_MIN ' + LP_MIN.toFixed(4));
        pars.push('#define GB_LP_SPAN ' + LP_SPAN.toFixed(4));
        if (!F.stochastic) pars.push('uniform sampler2D gbTileLP;', 'uniform float gbTileFlat;');
      }
      pars.push(G_TRIWARP);
      pars.push(G_TRI.replace('GB_TRI_DETAIL', F.detail ? G_TRI_DETAIL : ''));
    }
    if (F.parallax) {
      pars.push('#define GB_POM_STEPS ' + (F.pomSteps | 0));
      pars.push('uniform sampler2D gbHeightMap;', 'uniform float gbParallaxDepth;');
      pars.push(G_TANGENT, G_POM);
    }
    if (F.blend) {
      pars.push('uniform sampler2D gbBlendMap;', 'uniform float gbBlendGain;',
        'uniform float gbBlendScale;', 'uniform vec2 gbBlendRough;');
      if (F.blendNormal) pars.push('uniform sampler2D gbBlendNrm;');
      if (F.blendOrm) pars.push('uniform sampler2D gbBlendOrm;');
      pars.push('float gbBlendW = 0.0;', 'vec3 gbBTP = vec3( 0.0 );');
    }
    if (F.hasRoughMap) pars.push('uniform vec2 gbRoughRange;');
    if (F.sharedOrm) pars.push('vec4 gbOrm = vec4( 1.0, 1.0, 0.0, 1.0 );');
    if (F.specAA) pars.push('uniform float gbSpecAA;');
    if (F.translucent) {
      pars.push('uniform vec3 gbSSSColor;', 'uniform float gbSSSScale;', 'uniform float gbSSSPower;',
        'uniform float gbSSSWrap;', 'uniform float gbSSSAmbient;');
    }

    // ---- head: fade, world basis, triplanar weights, parallax offset --------
    head.push('float gbViewDist = length( vViewPosition );');
    head.push('gbDetailFade = 1.0 - smoothstep( gbFadeRange.x, gbFadeRange.y, gbViewDist );');
    if (F.world) {
      head.push('vec3 gbWP = vGbWorld;');
      head.push('vec3 gbWN = normalize( vGbWorldN );');
    }
    if (needMacroFn) {
      // The 0.25 m macro octave is analytic noise with no mip chain, so it has
      // to be faded out before it turns into sparkle on distant geometry.
      head.push('gbMacroHF = 1.0 - smoothstep( 22.0, 55.0, gbViewDist );');
      head.push('gbMacroV = gbMacroNoise( gbWP );');
    }
    if (F.grounding) head.push('gbGroundCalc( gbWP, gbWN, gbMacroV );');
    if (F.triplanar) {
      head.push('vec3 gbTW = gbTriWeights( gbWN, gbTriSharp );');
      head.push(F.triWarp
        ? 'vec3 gbTP = gbTriWarpPos( gbWP, gbTriScale );'
        : 'vec3 gbTP = gbWP * gbTriScale;');
    }
    if (F.sharedOrm) {
      head.push('#ifdef USE_ROUGHNESSMAP');
      head.push('  gbOrm = gbTriSample( roughnessMap, gbTP, gbTW, 1.0 );');
      head.push('#endif');
    }
    if (F.blend) {
      head.push('gbBTP = gbWP * gbBlendScale;');
      // Vertex alpha is the painted transition; without one, follow a
      // world-space noise so a consumer that has not painted anything still
      // gets a feathered, irregular edge instead of a straight cut.
      head.push('#if defined( USE_COLOR_ALPHA )');
      head.push('  gbBlendW = clamp( vColor.a, 0.0, 1.0 );');
      head.push('#else');
      head.push('  gbBlendW = smoothstep( 0.44, 0.62, gbValue3( gbWP * 0.55 + 5.0 ) );');
      head.push('#endif');
      // Height-aware feather: bias the transition toward the low patches so
      // the drift settles into the surface rather than lying over it.
      head.push('gbBlendW = clamp( gbBlendW * 1.25 - 0.12, 0.0, 1.0 );');
    }
    if (F.parallax) {
      head.push('#ifdef FLAT_SHADED');
      head.push('  vec3 gbGeoN = normalize( cross( dFdx( - vViewPosition ), dFdy( - vViewPosition ) ) );');
      head.push('#else');
      head.push('  vec3 gbGeoN = normalize( vNormal );');
      head.push('#endif');
      // POM gets a much tighter fade than the detail normal. It is the most
      // expensive thing in this shader and its payoff - depth at grazing
      // angles - only exists within a few metres. Beyond the fade the whole
      // loop is branched over, which is what keeps a street of parallaxed
      // walls affordable.
      head.push('float gbPomFade = 1.0 - smoothstep( 4.0, 11.0, gbViewDist );');
      head.push('if ( gbPomFade > 0.004 ) {');
      head.push('  mat3 gbTBN = gbTangentFrame( - vViewPosition, gbGeoN, vMapUv );');
      head.push('  vec3 gbVv = normalize( vViewPosition );');
      head.push('  vec3 gbVts = vec3( dot( gbVv, gbTBN[0] ), dot( gbVv, gbTBN[1] ), dot( gbVv, gbTBN[2] ) );');
      head.push('  vec2 gbDdx = dFdx( vMapUv ), gbDdy = dFdy( vMapUv );');
      head.push('  vec2 gbPu = gbParallax( vMapUv, gbVts, gbParallaxDepth * gbPomFade, gbDdx, gbDdy );');
      head.push('  gbUvShift = gbPu - vMapUv;');
      head.push('}');
    }
    if (F.stochastic) {
      // One setup for the whole material: albedo, normal and ORM all reuse the
      // same pair of cell transforms, so the hashing is paid for once.
      head.push('gbStochSetup( vMapUv, dFdx( vMapUv ), dFdy( vMapUv ) );');
    }
    if (F.detail) {
      // Sampled once here so albedo, roughness and the normal all see the same
      // texel. World projection where the surface is static: the detail layer
      // then sits at a fixed 3-6 cm no matter what UV scale the consumer used.
      head.push(F.worldDetail
        ? 'gbDet = texture2D( gbDetailNormal, gbDetProj( gbWP, gbWN ) * gbDetailScale );'
        : 'gbDet = texture2D( gbDetailNormal, ( vNormalMapUv + gbUvShift ) * gbDetailTile );');
    }
    if (F.meso) {
      // Same tile, ~11x the period, offset so it does not correlate with the
      // micro layer. Amplitude rides the macro field so the meso layer's own
      // 0.55 m repeat never becomes a pattern in its own right, and it holds
      // up as the micro layer fades - which is the whole point: this is the
      // band that carries the surface from 5 m out to 40 m.
      head.push('gbMes = texture2D( gbDetailNormal, gbDetProj( gbWP, gbWN ) * gbMesoScale + vec2( 0.317, 0.713 ) );');
      head.push('gbMesoW = gbMesoAmount * ( 0.62 + 0.76 * gbMacroV ) * ( 1.0 - smoothstep( 42.0, 92.0, gbViewDist ) );');
    }
    if (F.detail2) {
      // NEAR TIER. Same family tile at 1.55x the frequency, rotated 90 degrees
      // and phase-shifted so it cannot self-correlate with the base detail
      // layer, and ramped out by 7 m. The gradients are taken OUTSIDE the
      // branch so the fetch keeps a defined LOD inside it - which is what makes
      // the branch legal as well as cheap: past 7 m the whole thing is skipped.
      var d2uv = F.worldDetail
        ? 'gbDetProj( gbWP, gbWN ) * ( gbDetailScale * 1.55 )'
        : '( vNormalMapUv + gbUvShift ) * ( gbDetailTile * 1.55 )';
      head.push('gbDet2W = ( 1.0 - smoothstep( gbDet2Range.x, gbDet2Range.y, gbViewDist ) ) * gbDetailStrength;');
      head.push('{');
      head.push('  vec2 gbU2r = ' + d2uv + ';');
      head.push('  vec2 gbU2 = vec2( gbU2r.y, - gbU2r.x ) + vec2( 0.531, 0.147 );');
      head.push('  vec2 gbG2x = dFdx( gbU2 ), gbG2y = dFdy( gbU2 );');
      head.push('  if ( gbDet2W > 0.004 ) gbDet2 = textureGrad( gbDetailNormal, gbU2, gbG2x, gbG2y );');
      head.push('}');
    }
    if (F.polish) {
      // Crest x zone. The crest comes from the detail height field (and the
      // meso band where there is one) so it is high-frequency; the zone is a
      // metre-scale world field. The product is a small area of genuinely
      // glossy texels rather than a uniformly shinier surface.
      var crest = 'smoothstep( 0.40, 0.70, gbDet.b ) * gbDetailFade';
      if (F.detail2) crest = 'max( ' + crest + ', smoothstep( 0.40, 0.70, gbDet2.b ) * gbDet2W )';
      if (F.meso) crest = 'max( ' + crest + ', smoothstep( 0.44, 0.76, gbMes.b ) * clamp( gbMesoW, 0.0, 1.0 ) )';
      var pPos = F.world ? 'gbWP' : 'vec3( vMapUv * 2.4, 0.0 )';
      var pUp = F.world ? 'clamp( gbWN.y, 0.0, 1.0 )' : '0.5';
      head.push('gbPolish = gbPolishCalc( ' + pPos + ', ' + crest + ', ' + pUp + ' );');
    }
    src = src.replace('#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n' + head.join('\n'));

    // ---- albedo -------------------------------------------------------------
    var mapCode = [];
    mapCode.push('#ifdef USE_MAP');
    if (F.triplanar) {
      mapCode.push(F.triLP
        ? '  vec4 gbAlbedo = gbTriSampleLP( map, gbTP, gbTW, 1.0 );'
        : '  vec4 gbAlbedo = gbTriSample( map, gbTP, gbTW, 1.0 );');
    } else if (F.stochastic) {
      mapCode.push('  vec4 gbAlbedo = gbStochV( map, gbStochMean );');
    } else {
      mapCode.push('  vec4 gbAlbedo = texture2D( map, vMapUv + gbUvShift );');
    }
    if (F.blend) {
      mapCode.push('  vec4 gbAlbB = gbTriSample( gbBlendMap, gbBTP, gbTW, 1.0 );');
      mapCode.push('  diffuseColor.rgb = mix( diffuseColor.rgb * gbAlbedo.rgb,');
      mapCode.push('    gbAlbB.rgb * gbBlendGain, gbBlendW );');
      mapCode.push('  diffuseColor.a *= mix( gbAlbedo.a, gbAlbB.a, gbBlendW );');
    } else {
      mapCode.push('  diffuseColor *= gbAlbedo;');
    }
    mapCode.push('#endif');
    if (F.detail) {
      // Micro cavity darkening. Without this the detail layer only ever
      // perturbs the normal, which is why close surfaces kept a perfectly
      // even tone no matter how much bump they had.
      mapCode.push('diffuseColor.rgb *= mix( 1.0, 0.80 + 0.40 * gbDet.b, gbDetailFade * gbDetailCav );');
    }
    if (F.detail2) {
      mapCode.push('diffuseColor.rgb *= mix( 1.0, 0.86 + 0.28 * gbDet2.b, gbDet2W * gbDetailCav );');
    }
    if (F.meso) {
      // Meso cavity: patches, blisters, ponding stains and worn hollows at the
      // scale a surface is actually read at from 5-30 m. Stronger than the
      // micro cavity because this is the band the eye uses to judge material.
      mapCode.push('diffuseColor.rgb *= mix( 1.0, 0.74 + 0.50 * gbMes.b, clamp( gbMesoW, 0.0, 1.0 ) );');
    }
    if (F.chroma < 0.999) {
      // PER-TEXEL CHROMA TIGHTENING. Distinct from the palette anchor, which
      // moves a material's MEAN hue: this pulls in the hue VARIANCE inside one
      // material. genConcreteWall's aggregate is authored with independent
      // per-speck chroma, and at 2 mm per texel on a 20 m facade that lands as
      // blue-and-ochre confetti - the walls in overview.png read as polished
      // terrazzo rather than as rendered concrete. Value variation is what
      // sells aggregate; hue variation at that frequency is just noise, and it
      // is also the thing that fights the between-material hue separation the
      // palette anchor exists to create.
      mapCode.push('{ float gbCl = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );');
      mapCode.push('  diffuseColor.rgb = max( mix( vec3( gbCl ), diffuseColor.rgb, ' +
        F.chroma.toFixed(3) + ' ), vec3( 0.0 ) ); }');
    }
    if (F.macro) {
      mapCode.push('diffuseColor.rgb = gbApplyMacro( diffuseColor.rgb, gbMacroV );');
    }
    if (F.grounding) {
      mapCode.push('diffuseColor.rgb = gbGroundAlbedo( diffuseColor.rgb );');
    }
    src = src.replace('#include <map_fragment>', mapCode.join('\n'));

    // ---- vertex wear --------------------------------------------------------
    if (F.wear) {
      src = src.replace('#include <color_fragment>', [
        '#if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )',
        '  // Vertex colour is a WEAR MASK, white = pristine:',
        '  //   R -> grime/dust    G -> wetness    B -> edge wear / exposed substrate',
        '  gbGrime = 1.0 - vColor.r;',
        '  gbWet   = 1.0 - vColor.g;',
        '  gbWear  = 1.0 - vColor.b;',
        '  #if defined( USE_COLOR_ALPHA )',
        '    diffuseColor.a *= vColor.a;',
        '  #endif',
        '  float gbLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  // Grime both replaces hue AND darkens: a dust layer is a new, dark,',
        '  // low-chroma surface sitting on top, not a tint of the old one.',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, gbGrimeColor * ( 0.55 + 0.70 * gbLum ), gbGrime * 0.88 );',
        '  diffuseColor.rgb *= mix( 1.0, 0.70, gbGrime );',
        '  diffuseColor.rgb = mix( diffuseColor.rgb, gbWearColor * ( 0.55 + 0.75 * gbLum ), gbWear * 0.7 );',
        '  // Wet surfaces darken because the water film traps light in the pores.',
        '  diffuseColor.rgb *= mix( 1.0, 0.48, gbWet );',
        '#endif'
      ].join('\n'));
    }

    // ---- roughness / metalness ---------------------------------------------
    var roughCode = ['float roughnessFactor = roughness;'];
    if (F.hasRoughMap) {
      roughCode.push('#ifdef USE_ROUGHNESSMAP');
      roughCode.push(F.sharedOrm
        ? '  float gbRt = gbOrm.g;'
        : (F.triplanar
          ? '  float gbRt = gbTriSample( roughnessMap, gbTP, gbTW, 1.0 ).g;'
          : (F.stochastic
            ? '  float gbRt = gbStochL( roughnessMap ).g;'
            : '  float gbRt = texture2D( roughnessMap, vRoughnessMapUv + gbUvShift ).g;')));
      // Remap into this material's physical window instead of trusting the
      // texture's absolute range - concrete stays chalky, gunmetal stays satin.
      roughCode.push('  roughnessFactor = mix( gbRoughRange.x, gbRoughRange.y, gbRt ) * roughness;');
      if (F.blend && F.blendOrm) {
        roughCode.push('  float gbRtB = gbTriSample( gbBlendOrm, gbBTP, gbTW, 1.0 ).g;');
        roughCode.push('  roughnessFactor = mix( roughnessFactor,');
        roughCode.push('    mix( gbBlendRough.x, gbBlendRough.y, gbRtB ) * roughness, gbBlendW );');
      }
      roughCode.push('#endif');
    }
    if (F.detail) {
      // Micro-roughness. A surface whose bumps all share one gloss value is
      // the "wet plastic" tell the detail pass exists to kill.
      roughCode.push('roughnessFactor += ( gbDet.a - 0.5 ) * gbDetailRough * gbDetailFade;');
    }
    if (F.detail2) {
      roughCode.push('roughnessFactor += ( gbDet2.a - 0.5 ) * gbDetailRough * 0.7 * gbDet2W;');
    }
    if (F.meso) {
      roughCode.push('roughnessFactor += ( gbMes.a - 0.5 ) * 0.30 * clamp( gbMesoW, 0.0, 1.0 );');
    }
    if (F.macro) {
      // Weathering is patchy, and patchy GLOSS survives a hazy sky far better
      // than patchy brightness does.
      roughCode.push('roughnessFactor += ( gbMacroV - 0.5 ) * gbMacroAmount * 1.5;');
    }
    // The dust/grime/weep pulls may never exceed the material's own authored
    // ceiling. They used to be hard-coded at 0.97 / 0.94 / 0.96, which is above
    // the top of most of the library's roughness windows - so any surface with
    // grounding or vertex grime was pushed PAST chalk no matter what the def
    // said, and the asymmetry (three pulls up, one weak pull down) is why not a
    // single sample in the chart produced a highlight.
    var rCap = Math.min(0.97, ((F.roughRange && F.roughRange[1]) || 0.95) + 0.04);
    var rCapS = rCap.toFixed(3);
    if (F.grounding) {
      roughCode.push('roughnessFactor = mix( roughnessFactor, ' + rCapS + ', gbSettle * 0.85 );');
      roughCode.push('roughnessFactor = mix( roughnessFactor, ' +
        Math.min(rCap, 0.94).toFixed(3) + ', gbWeep * 0.6 );');
    }
    if (F.wear) {
      roughCode.push('roughnessFactor = mix( roughnessFactor, ' + rCapS + ', gbGrime * 0.62 );');
      roughCode.push('roughnessFactor = mix( roughnessFactor, 0.34, gbWear * 0.55 );');
      roughCode.push('roughnessFactor = mix( roughnessFactor, 0.09, gbWet );');
    }
    if (F.polish) {
      // The counter-pull. Deliberately the LAST roughness term: burnish is the
      // most recent event on a surface's history, and it sits on top of the
      // dust rather than under it.
      roughCode.push('roughnessFactor = min( roughnessFactor, mix( roughnessFactor, ' +
        M.lerp(0.40, 0.10, M.saturate(F.polishAmount)).toFixed(3) + ', gbPolish ) );');
    }
    roughCode.push('roughnessFactor = clamp( roughnessFactor, 0.035, 1.0 );');
    src = src.replace('#include <roughnessmap_fragment>', roughCode.join('\n'));

    var metalCode = ['float metalnessFactor = metalness;'];
    if (F.hasMetalMap) {
      metalCode.push('#ifdef USE_METALNESSMAP');
      metalCode.push(F.sharedOrm
        ? '  metalnessFactor *= gbOrm.b;'
        : (F.triplanar
          ? '  metalnessFactor *= gbTriSample( metalnessMap, gbTP, gbTW, 1.0 ).b;'
          : (F.stochastic
            ? '  metalnessFactor *= gbStochL( metalnessMap ).b;'
            : '  metalnessFactor *= texture2D( metalnessMap, vMetalnessMapUv + gbUvShift ).b;')));
      metalCode.push('#endif');
    }
    if (F.wear) {
      metalCode.push('metalnessFactor = mix( metalnessFactor, gbWearMetal, gbWear * 0.8 );');
    }
    metalCode.push('metalnessFactor = clamp( metalnessFactor, 0.0, 1.0 );');
    src = src.replace('#include <metalnessmap_fragment>', metalCode.join('\n'));

    // ---- BRDF-input fixups --------------------------------------------------
    // Everything here has to run AFTER lights_physical_fragment, because that
    // is where `material` is populated - and after normal_fragment_maps, so
    // the final shading normal is available.
    var brdf = [];

    // GEOMETRIC SPECULAR ANTIALIASING (Kaplanyan/Tokuyoshi). A normal map that
    // varies faster than one texel per pixel produces a different highlight in
    // every pixel, which is the "salt and pepper" sparkle crawling over the
    // distant facades in overview.png, over razor wire and over every thin
    // metal edge. It is not a mip problem - anisotropic filtering deliberately
    // keeps that detail sharp along the unstretched axis - so no amount of
    // filtering fixes it. The fix is to widen the specular lobe by however much
    // the shading normal moves across the pixel footprint: variance in the
    // normal is mathematically equivalent to extra roughness, so folding it in
    // converts sparkle into a correctly dimmer, broader highlight.
    //
    // Cheap (two derivatives), it costs nothing where normals are smooth, and
    // unlike simply fading the normal map out at distance it keeps the surface
    // detail visible in the albedo and AO.
    //
    // ...but the widening has to be DISTANCE-WEIGHTED, and it was not. Sparkle
    // is a far-field problem: it happens when the normal map varies faster than
    // one texel per pixel, which is what minification does. At hero range the
    // normal is fully resolved, there is no aliasing to fix, and a flat
    // gbSpecAA * gbNv capped at 0.36 was adding up to 0.6 of roughness to every
    // near surface - i.e. no material in the library could hold a lobe tighter
    // than 0.6 anywhere the camera actually stands. That, together with the
    // one-way roughness pulls, is the second half of why nothing in the chart
    // produced a highlight. Below ~6 m the term is scaled right down and its
    // ceiling drops to 0.06; past ~20 m it is exactly what it was.
    if (F.specAA) {
      brdf.push('{');
      brdf.push('  float gbAAd = smoothstep( 6.0, 20.0, gbViewDist );');
      brdf.push('  vec3 gbNdx = dFdx( normal ), gbNdy = dFdy( normal );');
      brdf.push('  float gbNv = max( dot( gbNdx, gbNdx ), dot( gbNdy, gbNdy ) );');
      brdf.push('  material.roughness = min( 1.0, sqrt( material.roughness * material.roughness +');
      brdf.push('    min( gbSpecAA * mix( 0.28, 1.0, gbAAd ) * gbNv, mix( 0.06, 0.36, gbAAd ) ) ) );');
      brdf.push('}');
    }

    // Roughness alone does not sell dust. A grimy surface also loses its
    // Fresnel rim; a wet one gains one. Both are one line on the BRDF inputs.
    if (F.wear) {
      brdf.push('material.specularF90 *= mix( 1.0, 0.40, gbGrime );');
      brdf.push('material.specularColor *= mix( 1.0, 0.45, gbGrime );');
      brdf.push('material.specularF90 = mix( material.specularF90, 1.0, gbWet );');
      brdf.push('material.specularColor = mix( material.specularColor, vec3( 0.055 ), gbWet * ( 1.0 - metalnessFactor ) );');
    }
    if (brdf.length) {
      src = src.replace('#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n' + brdf.join('\n'));
    }

    // ---- normals ------------------------------------------------------------
    if (F.hasNormalMap && (F.triplanar || F.detail || F.parallax || F.wear || F.stochastic)) {
      var nrmCode = [];
      // Silt fills the crevices, so heavily grimed surfaces read flatter.
      var nsExpr = F.wear ? 'normalScale * mix( 1.0, 0.6, gbGrime )' : 'normalScale';
      if (F.grounding) nsExpr = '( ' + nsExpr + ' * mix( 1.0, 0.72, gbSettle ) )';
      if (F.triplanar) {
        nrmCode.push('#ifdef USE_NORMALMAP_TANGENTSPACE');
        nrmCode.push('  vec3 gbNw = gbTriNormal( normalMap, gbTP, gbWN, gbTW, 1.0, ' + nsExpr + ' );');
        if (F.blend && F.blendNormal) {
          nrmCode.push('  gbNw = normalize( mix( gbNw,');
          nrmCode.push('    gbTriNormal( gbBlendNrm, gbBTP, gbWN, gbTW, 1.0, ' + nsExpr + ' ), gbBlendW ) );');
        }
        if (F.detail2) {
          nrmCode.push('  gbNw = gbMesoPerturb( gbNw, gbDetVec( gbDet2, gbDet2W * 0.55 ) );');
        }
        if (F.meso) {
          // One world-space perturbation rather than three more triplanar
          // taps. The meso layer is isotropic low-amplitude noise, so an
          // arbitrary-but-continuous tangent frame is indistinguishable from
          // the projected one and costs a quarter as much.
          nrmCode.push('  gbNw = gbMesoPerturb( gbNw, gbDetVec( gbMes, 0.85 * clamp( gbMesoW, 0.0, 1.5 ) ) );');
        }
        // Triplanar produces a world-space normal directly; convert to view
        // space (viewMatrix is orthonormal, so the rotation part suffices).
        nrmCode.push('  normal = normalize( ( viewMatrix * vec4( gbNw, 0.0 ) ).xyz );');
        nrmCode.push('#endif');
      } else {
        nrmCode.push('#ifdef USE_NORMALMAP_TANGENTSPACE');
        nrmCode.push(F.stochastic
          ? '  vec3 mapN = gbStochN( normalMap );'
          : '  vec3 mapN = texture2D( normalMap, vNormalMapUv + gbUvShift ).xyz * 2.0 - 1.0;');
        nrmCode.push('  mapN.xy *= ' + nsExpr + ';');
        if (F.detail) {
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbDet, gbDetailStrength * gbDetailFade ) );');
        }
        if (F.detail2) {
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbDet2, gbDet2W * 0.55 ) );');
        }
        if (F.meso) {
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbMes, 0.85 * clamp( gbMesoW, 0.0, 1.5 ) ) );');
        }
        nrmCode.push('  normal = normalize( tbn * mapN );');
        nrmCode.push('#endif');
      }
      src = src.replace('#include <normal_fragment_maps>', nrmCode.join('\n'));
    }

    // ---- ambient occlusion --------------------------------------------------
    if (F.hasAoMap && (F.triplanar || F.parallax || F.stochastic || F.detail)) {
      var aoSample = F.sharedOrm
        ? 'gbOrm.r'
        : (F.triplanar
          ? 'gbTriSample( aoMap, gbTP, gbTW, 1.0 ).r'
          : (F.stochastic
            ? 'gbStochL( aoMap ).r'
            : 'texture2D( aoMap, vAoMapUv + gbUvShift ).r'));
      // Fold the detail cavity into the AO term as well, so micro pits shade
      // the indirect light instead of only bending the normal.
      if (F.detail) {
        aoSample = '( ' + aoSample + ' * mix( 1.0, 0.70 + 0.60 * gbDet.b, gbDetailFade * gbDetailCav ) )';
      }
      if (F.detail2) {
        aoSample = '( ' + aoSample + ' * mix( 1.0, 0.80 + 0.40 * gbDet2.b, gbDet2W * gbDetailCav ) )';
      }
      if (F.meso) {
        aoSample = '( ' + aoSample + ' * mix( 1.0, 0.72 + 0.56 * gbMes.b, clamp( gbMesoW, 0.0, 1.0 ) ) )';
      }
      src = src.replace('#include <aomap_fragment>', [
        '#ifdef USE_AOMAP',
        '  float ambientOcclusion = ( ' + aoSample + ' - 1.0 ) * aoMapIntensity + 1.0;',
        '  reflectedLight.indirectDiffuse *= ambientOcclusion;',
        '  #if defined( USE_CLEARCOAT )',
        '    clearcoatSpecularIndirect *= ambientOcclusion;',
        '  #endif',
        '  #if defined( USE_SHEEN )',
        '    sheenSpecularIndirect *= ambientOcclusion;',
        '  #endif',
        '  #if defined( USE_ENVMAP ) && defined( STANDARD )',
        '    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );',
        '    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );',
        '  #endif',
        '#endif'
      ].join('\n'));
    }

    // ---- indirect specular occlusion ---------------------------------------
    // The right lever for "the environment map is too strong on this surface".
    // Flattening roughness to fight a mirror-bright IBL is what left the whole
    // library incapable of a highlight; occluding the reflection where the
    // surface physically cannot SEE the sky costs nothing, keeps the crests
    // reflective and only kills the parts that should never have been
    // reflecting in the first place. Two terms:
    //
    //   * cavity / dust occlusion - a pit, and a surface with dust settled on
    //     it, sees a fraction of the hemisphere;
    //   * HORIZON occlusion (Frostbite / Lagarde) - a normal-mapped bump whose
    //     mirror direction points below the GEOMETRIC surface is reflecting
    //     something the geometry occludes. This is what stops a strongly
    //     normal-mapped wall from lighting up uniformly under a bright sky,
    //     and it is why it raises local contrast rather than lowering it.
    if (F.specOcc && (F.detail || F.grounding || F.hasNormalMap)) {
      var so = ['{', '  float gbSO = 1.0;'];
      if (F.detail) {
        so.push('  gbSO *= mix( 1.0, 0.58 + 0.48 * gbDet.b, gbDetailFade * gbDetailCav );');
      }
      if (F.meso) {
        so.push('  gbSO *= mix( 1.0, 0.66 + 0.40 * gbMes.b, clamp( gbMesoW, 0.0, 1.0 ) );');
      }
      if (F.grounding) {
        so.push('  gbSO *= mix( 1.0, 0.42, gbSettle );');
      }
      so.push('  #ifndef FLAT_SHADED');
      so.push('    vec3 gbRefl = reflect( - geometryViewDir, geometryNormal );');
      so.push('    float gbHz = clamp( 1.0 + 1.30 * dot( gbRefl, normalize( vNormal ) ), 0.0, 1.0 );');
      so.push('    gbSO *= gbHz * gbHz;');
      so.push('  #endif');
      so.push('  reflectedLight.indirectSpecular *= gbSO;');
      so.push('  #if defined( USE_SHEEN )');
      so.push('    sheenSpecularIndirect *= gbSO;');
      so.push('  #endif');
      so.push('  #if defined( USE_CLEARCOAT )');
      so.push('    clearcoatSpecularIndirect *= gbSO;');
      so.push('  #endif');
      so.push('}');
      src = src.replace('#include <lights_fragment_end>',
        '#include <lights_fragment_end>\n' + so.join('\n'));
    }

    // ---- premultiplied specular (glazing) ----------------------------------
    // Alpha blending scales the ENTIRE shaded result, specular included, so a
    // pane at opacity 0.19-0.44 had its Fresnel rim and its sky reflection
    // multiplied down to a fifth of their strength - measured p99/median 1.57
    // on the GLASS sphere and edge energy 3.55 on the plate, the lowest of all
    // sixteen samples, i.e. indistinguishable from the empty backdrop.
    //
    // The critic's fix was to switch to MeshPhysicalMaterial.transmission.
    // That is the physically complete answer but it is not the right one HERE:
    // r180's transmission path re-renders every opaque object into a second
    // target each frame (renderTransmissionPass), which roughly doubles the
    // draw calls in a build already running 321-460 against a <400 budget, and
    // it does so in EVERY frame where a shopfront is visible - which is most
    // of them. The defect is specifically that COVERAGE is being applied to
    // the reflection, so the correct minimal fix is to stop doing that:
    // premultiply only the diffuse (transmitted) term by coverage and ADD the
    // specular on top, which is exactly what a premultiplied-alpha blend is
    // for. Same Fresnel rim, same sky reflection, one pass. `opts.transmission`
    // still switches on the full path for anything that genuinely needs
    // refraction (an optic lens, a bottle).
    if (F.premulSpec) {
      src = src.replace('#include <opaque_fragment>', [
        '#ifdef OPAQUE',
        '  diffuseColor.a = 1.0;',
        '#endif',
        '#ifdef USE_TRANSMISSION',
        '  diffuseColor.a *= material.transmissionAlpha;',
        '#endif',
        'float gbCov = clamp( diffuseColor.a, 0.0, 1.0 );',
        '// outgoingLight already carries sheen/clearcoat; peel off the diffuse',
        '// half, attenuate only that by coverage, and add the rest untouched.',
        'vec3 gbRefl2 = outgoingLight - totalDiffuse;',
        '// A strong reflection also OCCLUDES what is behind the pane, so it',
        '// contributes coverage as well as radiance - otherwise a bright',
        '// highlight reads as a floating additive smear.',
        'float gbReflA = clamp( dot( gbRefl2, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.9, 0.0, 1.0 );',
        'gl_FragColor = vec4( totalDiffuse * gbCov + gbRefl2,',
        '  clamp( gbCov + ( 1.0 - gbCov ) * gbReflA, 0.0, 1.0 ) );'
      ].join('\n'));
    }

    // ---- foliage translucency ----------------------------------------------
    if (F.translucent) {
      src = src.replace('#include <lights_fragment_end>', [
        '#include <lights_fragment_end>',
        '#if ( NUM_DIR_LIGHTS > 0 )',
        '{',
        '  // Dice-style back-translucency plus a wrap term. Deliberately',
        '  // unshadowed: leaves in shadow that go black are an instant tell.',
        '  vec3 gbL = directionalLights[ 0 ].direction;',
        '  vec3 gbHn = normalize( gbL + geometryNormal * 0.55 );',
        '  float gbBack = pow( clamp( dot( geometryViewDir, - gbHn ), 0.0, 1.0 ), gbSSSPower ) * gbSSSScale;',
        '  float gbWrapT = clamp( ( dot( geometryNormal, gbL ) + gbSSSWrap ) / ( 1.0 + gbSSSWrap ), 0.0, 1.0 );',
        '  reflectedLight.directDiffuse += directionalLights[ 0 ].color * material.diffuseColor',
        '    * gbSSSColor * ( gbBack + gbWrapT * gbSSSAmbient );',
        '}',
        '#endif'
      ].join('\n'));
    }

    return pars.join('\n') + '\n' + src;
  };

  // ==========================================================================
  // Texture acquisition
  // ==========================================================================
  // Resolve the texture-library recipe name for a def, preferring `tex` but
  // falling back to `texAlt` when the texture library has no such recipe.
  // textures.js answers an unknown name with a LOUD logError plus a concrete
  // set, so a def that reaches ahead of the texture library (a dedicated
  // laundry-sheet or far-facade recipe that may or may not exist yet) has to
  // ask first. Purely additive: a def with no texAlt behaves exactly as before.
  MaterialLibrary.prototype._texName = function (def, name) {
    var want = def.tex || name;
    if (!def.texAlt) return want;
    try {
      var tx = this.ctx && this.ctx.textures;
      var known = tx && tx.names && tx.names.indexOf ? tx.names.indexOf(want) >= 0 : false;
      if (!known && tx && typeof tx.has === 'function') known = !!tx.has(want);
      return known ? want : def.texAlt;
    } catch (e) { return def.texAlt; }
  };

  MaterialLibrary.prototype._maps = function (name, def, opts) {
    var out = { map: null, normalMap: null, roughnessMap: null, aoMap: null, metalnessMap: null, heightMap: null };
    var rep = opts.repeat;
    if (typeof rep === 'number') rep = [rep, rep];
    if (!rep) rep = [def.repeat || 1, def.repeat || 1];

    var set = null;
    var tx = this.ctx && this.ctx.textures;
    // The texture library implements a subset of these names. Without the
    // explicit mapping, `dirt`, `rubble`, `stone`, `canvas_awning`, `plastic`,
    // `cloth_*` and `sandbag` all silently resolved to the generic concrete
    // recipe - which is why the market awnings were canvas-coloured concrete.
    var texName = this._texName(def, name);
    if (tx && typeof tx.get === 'function' && !this._texBroken) {
      try {
        set = tx.get(texName, { repeat: rep, scale: opts.scale, seed: opts.seed });
      } catch (e) {
        set = null;
        // Report the first couple of failures then stop asking. A texture
        // library that throws once throws every time, and 30 identical stack
        // traces in the error badge bury everyone else's real problems.
        this._texFails = (this._texFails || 0) + 1;
        if (this._texFails <= 2) GAME.logError('materials.textures.get:' + name, e);
        if (this._texFails >= 3) this._texBroken = true;
      }
    }
    if (!set || !isTexture(set.map)) set = this._fallbackSet(name);
    if (!set) return out;

    out.map = this._prep(set.map, rep, true);
    out.normalMap = this._prep(set.normalMap, rep, false);
    out.roughnessMap = this._prep(set.roughnessMap, rep, false);
    out.aoMap = this._prep(set.aoMap, rep, false);
    out.metalnessMap = this._prep(set.metalnessMap, rep, false);
    // three only reads displacementMap in the vertex stage; we want it as a
    // fragment height source for POM, so it is bound as a custom uniform.
    out.heightMap = this._prep(set.displacementMap || set.heightMap, rep, false);

    if (out.aoMap) {
      // Default to UV0. Level/prop geometry that ran GAME.Geo.copyUV1 is
      // unaffected (uv1 is a copy of uv), but geometry that forgot would
      // otherwise sample a nonexistent attribute and produce garbage AO.
      out.aoMap.channel = opts.aoChannel !== undefined ? opts.aoChannel : 0;
    }
    return out;
  };

  // Make sure a texture from any source has the wrapping/filtering/colour
  // space we need, cloning only when we would otherwise stomp on a shared
  // texture's repeat.
  MaterialLibrary.prototype._prep = function (tex, rep, isColor) {
    if (!isTexture(tex)) return null;
    var t = tex;
    var needsRepeat = Math.abs(t.repeat.x - rep[0]) > 1e-5 || Math.abs(t.repeat.y - rep[1]) > 1e-5;
    if (needsRepeat) {
      // Repeat lives on the texture, not the material, so two materials that
      // want different tiling of the same map need different texture objects.
      // Cloning shares the image but gets its own transform - except the first
      // time we touch a texture we generated ourselves, where mutating is free.
      var claimable = t.userData && t.userData.__gbOwned && t.userData.__gbRepeat === undefined;
      if (!claimable) {
        t = tex.clone();
        t.userData = { __gbOwned: true };
        t.needsUpdate = true;
      }
      t.repeat.set(rep[0], rep[1]);
      t.userData.__gbRepeat = rep[0] + ',' + rep[1];
    }
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // Enforce the colour-space contract here rather than trusting the texture
    // library: an albedo left in NoColorSpace is the classic washed-out look,
    // and a normal map decoded as sRGB bends every surface the wrong way.
    var cs = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (t.colorSpace !== cs) { t.colorSpace = cs; t.needsUpdate = true; }
    if (t.anisotropy < this._anisotropy) t.anisotropy = this._anisotropy;
    if (t.minFilter === THREE.NearestFilter || t.minFilter === THREE.LinearFilter) {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
    }
    return t;
  };

  // ==========================================================================
  // Local procedural fallback maps
  //
  // Only used when ctx.textures is absent or throws. Not a substitute for the
  // real library - just enough grain, blotching and normal detail that a
  // partial build still photographs as a textured surface, never flat colour.
  // ==========================================================================
  MaterialLibrary.prototype._fallbackSet = function (name) {
    if (this._fallbacks[name]) return this._fallbacks[name];
    var set = null;
    try { set = this._genFallback(name); }
    catch (e) { GAME.logError('materials.fallback:' + name, e); }
    this._fallbacks[name] = set;
    return set;
  };

  MaterialLibrary.prototype._genFallback = function (name) {
    var style = FALLBACK_STYLE[name] || FALLBACK_STYLE.concrete;
    var S = 256;
    var base = new THREE.Color().setHex(style[0], THREE.SRGBColorSpace);
    var spec = new THREE.Color().setHex(style[1], THREE.SRGBColorSpace);
    // Convert back to 0..255 sRGB bytes for the canvas-style byte buffers.
    var bR = Math.round(Math.pow(base.r, 1 / 2.2) * 255);
    var bG = Math.round(Math.pow(base.g, 1 / 2.2) * 255);
    var bB = Math.round(Math.pow(base.b, 1 / 2.2) * 255);
    var sR = Math.round(Math.pow(spec.r, 1 / 2.2) * 255);
    var sG = Math.round(Math.pow(spec.g, 1 / 2.2) * 255);
    var sB = Math.round(Math.pow(spec.b, 1 / 2.2) * 255);

    var grainF = style[2] / S;      // cycles across the tile
    var blotchF = style[3];
    var pore = style[4];

    var alb = new Uint8Array(S * S * 4);
    var rgh = new Uint8Array(S * S * 4);
    var hgt = new Float32Array(S * S);

    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var u = x / S, v = y / S;
        // Every frequency is a power of two so the perlin lattice (period 256)
        // wraps exactly and the tile is seamless.
        var blotch = NOISE.fbm2(u * blotchF * 4, v * blotchF * 4, 4, 2, 0.55) * 0.5 + 0.5;
        var grain = NOISE.fbm2(u * 64, v * 64, 3, 2, 0.5) * 0.5 + 0.5;
        var cell = NOISE.worley2(u * 32, v * 32, 1.0);
        var agg = 1.0 - M.saturate(cell.f1);
        var mixv = M.saturate(blotch * 0.62 + grain * 0.28 + agg * pore * 0.35);

        var h = blotch * 0.55 + grain * 0.25 + agg * pore * 0.4;
        hgt[i] = h;

        alb[i * 4] = bR + (sR - bR) * (1 - mixv);
        alb[i * 4 + 1] = bG + (sG - bG) * (1 - mixv);
        alb[i * 4 + 2] = bB + (sB - bB) * (1 - mixv);
        alb[i * 4 + 3] = 255;

        var r = M.saturate(0.5 + (0.5 - mixv) * 0.8);
        rgh[i * 4] = 255;                        // R unused
        rgh[i * 4 + 1] = Math.round(r * 255);    // G = roughness
        rgh[i * 4 + 2] = 0;                      // B = metalness
        rgh[i * 4 + 3] = 255;
      }
    }

    // Gentle: this height field is only 256px of noise, and a strong normal
    // turns every fallback surface into hammered metal.
    var nrm = heightToNormal(hgt, S, 1.4);
    var ao = heightToAO(hgt, S);
    var hTex = new Uint8Array(S * S * 4);
    for (var j = 0; j < S * S; j++) {
      var hv = Math.round(M.saturate(hgt[j]) * 255);
      hTex[j * 4] = hv; hTex[j * 4 + 1] = hv; hTex[j * 4 + 2] = hv; hTex[j * 4 + 3] = 255;
    }

    return {
      map: dataTex(alb, S, true),
      normalMap: dataTex(nrm, S, false),
      roughnessMap: dataTex(rgh, S, false),
      aoMap: dataTex(ao, S, false),
      displacementMap: dataTex(hTex, S, false)
    };
  };

  // ==========================================================================
  // Detail surface tile
  //
  // One shared 256px tile projected in world space at a 3-6 cm period. It is
  // NOT just a normal map: a detail pass that only perturbs normals leaves the
  // specular response perfectly uniform, which is exactly what makes a
  // close-range surface read as painted plastic no matter how much bump it has.
  //
  //   R,G = tangent normal xy (z reconstructed in the shader)
  //   B   = cavity      0.5 = flat, low = pit -> albedo + AO darkening
  //   A   = micro roughness  0.5 = neutral, low = polished, high = chalky
  //
  // Both B and A are authored around 0.5 so the layer is mean-preserving: it
  // cannot drag a material off the albedo anchor solved in _create.
  // ==========================================================================
  MaterialLibrary.prototype._detailTex = function (kind) {
    return this._detailKinds[kind || 'mineral'] || this._detailNormal;
  };

  MaterialLibrary.prototype._makeDetailNormal = function (S, kind) {
    kind = kind || 'mineral';
    var n = S * S;
    var h = new Float32Array(n);
    var grain = new Float32Array(n);
    var x, y, i, u, v, f, c, fine, scratch;
    // Per-family INTEGER lattice phase, so the four tiles never share a feature
    // layout while every frequency stays a power of two (the perlin/worley
    // permutation table has period 256, so only integer offsets preserve
    // whatever wrap the frequency gives).
    var ph = hashString(kind) % 64;
    // Cheap deterministic per-index hash for the woven thread jitter. It is a
    // function of the thread INDEX, which is already periodic in the tile, so
    // the weave wraps exactly however many threads we lay.
    function th(k) {
      var s = Math.sin(k * 12.9898 + ph * 0.317) * 43758.5453;
      return s - Math.floor(s);
    }
    var TH = 32;                       // threads per tile (power of two -> wraps)
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        u = x / S; v = y / S;
        i = y * S + x;
        if (kind === 'woven') {
          // Thread-crossing lattice: warp over weft, each thread carrying its
          // own hashed diameter, plus slubs (thick spots in the yarn). This is
          // what a jute sack, a chest rig and a hung sheet are actually made
          // of, and none of them were getting it - they all shared the mineral
          // pore field, which is why cloth read as painted cardboard.
          var tu = u * TH, tv = v * TH;
          var iu = Math.floor(tu), iv = Math.floor(tv);
          var ju = th(iu), jv = th(iv + 91);
          // Round cross-section per thread; the fractional part is the bulge.
          var wu = Math.pow(M.saturate(Math.sin((tu - iu) * Math.PI)), 0.5 + ju * 0.9);
          var wv = Math.pow(M.saturate(Math.sin((tv - iv) * Math.PI)), 0.5 + jv * 0.9);
          // Over/under: the warp is proud on alternating crossings.
          var strand = (((iu + iv) & 1) === 0)
            ? (wu * 0.74 + wv * 0.28) : (wv * 0.74 + wu * 0.28);
          // Slubs: a coarse field thickening random runs of thread.
          var slub = NOISE.fbm2(u * 8 + ph, v * 8 + ph, 3, 2, 0.5) * 0.5 + 0.5;
          fine = NOISE.perlin2(u * 128 + ph, v * 128 + ph);
          h[i] = strand * (0.62 + slub * 0.42) + fine * 0.06;
          // The crown of a thread is rubbed smooth; the gap between the picks
          // is full of loose fibre and stays matte.
          grain[i] = M.saturate(0.74 - strand * 0.44 + fine * 0.14 + (slub - 0.5) * 0.20);

        } else if (kind === 'metal') {
          // Unidirectional broach striation (the machining direction) plus a
          // bead-blast peen. Reads as milled aluminium under anodising rather
          // than as generic stone pores.
          var stri = NOISE.ridged2(u * 4 + ph, v * 128 + ph, 3);
          var stri2 = NOISE.ridged2(u * 16 + ph, v * 64 + ph, 2);
          var peen = NOISE.worley2(u * 32 + ph, v * 32 + ph, 1.0);
          var peenH = 1.0 - M.saturate(peen.f1 * 1.6);
          fine = NOISE.perlin2(u * 128 + ph, v * 128 + ph);
          h[i] = stri * 0.34 + stri2 * 0.20 + peenH * 0.28 + fine * 0.10;
          // Machining leaves the striae satin and the blast pits matte.
          grain[i] = M.saturate(0.44 + peenH * 0.46 - stri * 0.26 + fine * 0.12);

        } else if (kind === 'organic') {
          // Skin: a fine pore field on a wandering crease network.
          var pore = NOISE.worley2(u * 64 + ph, v * 64 + ph, 0.95);
          var poreH = 1.0 - M.saturate(pore.f1 * 2.0);
          var crease = NOISE.worley2(u * 16 + ph, v * 16 + ph, 1.0);
          var creaseH = M.saturate(1.0 - crease.edge * 3.2);
          fine = NOISE.perlin2(u * 128 + ph, v * 128 + ph);
          h[i] = 0.34 - creaseH * 0.34 - poreH * 0.22 + fine * 0.09 +
            (NOISE.fbm2(u * 8 + ph, v * 8 + ph, 3, 2, 0.5) * 0.5 + 0.5) * 0.18;
          // Sebum sits on the ridges: crease bottoms are the matte part.
          grain[i] = M.saturate(0.46 + creaseH * 0.32 + poreH * 0.20 - fine * 0.10);

        } else {
          // mineral (default): worley pore + angular chip + fine sand grain.
          f = NOISE.fbm2(u * 16 + ph, v * 16 + ph, 5, 2, 0.56);
          c = NOISE.worley2(u * 32 + ph, v * 32 + ph, 1.0);
          var chip = NOISE.worley2(u * 8 + ph, v * 8 + ph, 0.85);
          var chipH = M.saturate(chip.edge * 1.7);
          fine = NOISE.perlin2(u * 128 + ph, v * 128 + ph);
          scratch = NOISE.ridged2(u * 8 + ph, v * 64 + ph, 2);
          h[i] =
            f * 0.38 +                                  // soft undulation
            (1.0 - M.saturate(c.f1 * 1.15)) * 0.28 +    // pores / aggregate
            chipH * 0.16 +                              // angular chipping
            fine * 0.14 +                               // micro grain
            scratch * 0.10;                             // faint directional scuff
          // Roughness story: the pores and the directional scuffing are chalky,
          // the raised, rubbed-smooth ground between them is not.
          grain[i] = M.saturate(0.5 +
            (1.0 - M.saturate(c.f1 * 1.35) - 0.35) * 0.55 +
            scratch * 0.30 + fine * 0.18 - f * 0.20);
        }
      }
    }

    var data = heightToNormal(h, S, kind === 'organic' ? 2.2 : 3.1);

    // Cavity: how far below its local mean a texel sits. Same idea as the
    // fallback AO but normalised against the field's own statistics so the
    // channel is centred on 0.5 whatever amplitude the height field has.
    var R = 2, sum, cnt, ox, oy;
    var cav = new Float32Array(n);
    var acc = 0;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        sum = 0; cnt = 0;
        for (oy = -R; oy <= R; oy++) {
          var ro = (((y + oy) % S) + S) % S;
          for (ox = -R; ox <= R; ox++) {
            sum += h[ro * S + ((((x + ox) % S) + S) % S)];
            cnt++;
          }
        }
        var d = h[y * S + x] - sum / cnt;
        cav[y * S + x] = d;
        acc += d * d;
      }
    }
    var sd = Math.sqrt(acc / n) || 1e-4;
    for (i = 0; i < n; i++) {
      var o = i * 4;
      data[o + 2] = M.clamp(0.5 + (cav[i] / sd) * 0.30, 0, 1) * 255;
      data[o + 3] = M.clamp(grain[i], 0, 1) * 255;
    }

    var tex = dataTex(data, S, false);
    tex.userData.__gbOwned = true;
    return tex;
  };

  // ==========================================================================
  // Decals
  // ==========================================================================

  /**
   * decalMaterial(kind) -> THREE.Material
   * kind: 'bullet_hole' | 'scorch' | 'blood' | 'crack'
   *
   * Decals must not fight the surface underneath: polygon offset pulls them
   * toward the camera, depthWrite stays off so overlapping decals blend, and
   * they are lit by the same PBR path as the wall so they never look like
   * stickers floating in a different lighting environment.
   */
  MaterialLibrary.prototype.decalMaterial = function (kind) {
    kind = kind || 'bullet_hole';
    if (this.decals[kind]) return this.decals[kind];

    var mat;
    try { mat = this._makeDecal(kind); }
    catch (e) {
      GAME.logError('materials.decal:' + kind, e);
      mat = new THREE.MeshBasicMaterial({
        color: 0x1a1512, transparent: true, opacity: 0.7, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8
      });
    }
    mat.name = 'decal_' + kind;
    this.decals[kind] = mat;
    return mat;
  };

  MaterialLibrary.prototype._makeDecal = function (kind) {
    // Deliberately generated here rather than pulled from ctx.textures:
    // decals are not in the texture library's contracted name list, and a
    // library that answers unknown names with a generic opaque tile would
    // silently turn every bullet hole into an opaque square. The alpha shape
    // *is* the decal, so we own it.
    var set = this._genDecalTextures(kind);

    var common = {
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.FrontSide,
      alphaTest: 0.008,
      envMapIntensity: 0.9
    };

    var mat;
    if (kind === 'blood') {
      mat = new THREE.MeshStandardMaterial(Object.assign({}, common, {
        color: srgb(0xffffff),
        map: set.map,
        normalMap: set.normalMap || null,
        roughnessMap: set.roughnessMap || null,
        roughness: 1.0,
        metalness: 0.0,
        envMapIntensity: 1.15    // wet blood catches a specular highlight
      }));
    } else if (kind === 'scorch') {
      // Soot absorbs: keep it dark and very rough, and let it sit slightly
      // *under* the surface response by killing its specular.
      mat = new THREE.MeshStandardMaterial(Object.assign({}, common, {
        color: srgb(0x2a2622),
        map: set.map,
        roughness: 0.98,
        metalness: 0.0,
        envMapIntensity: 0.35
      }));
    } else if (kind === 'crack') {
      mat = new THREE.MeshStandardMaterial(Object.assign({}, common, {
        color: srgb(0xd8d2c6),
        map: set.map,
        normalMap: set.normalMap || null,
        roughness: 0.95,
        metalness: 0.0,
        envMapIntensity: 0.8
      }));
    } else {
      // bullet_hole
      mat = new THREE.MeshStandardMaterial(Object.assign({}, common, {
        color: srgb(0xffffff),
        map: set.map,
        normalMap: set.normalMap || null,
        roughness: 0.92,
        metalness: 0.0,
        envMapIntensity: 0.85
      }));
    }
    // Blood is a liquid film: a strong normal turns it into crumpled foil.
    var nsD = kind === 'blood' ? 0.5 : 1.4;
    if (mat.normalMap) mat.normalScale = new THREE.Vector2(nsD, nsD);
    return mat;
  };

  MaterialLibrary.prototype._genDecalTextures = function (kind) {
    var S = 256;
    var rng = new GAME.RNG(DECAL_SEED ^ hashString(kind));
    var col = new Uint8Array(S * S * 4);
    var hgt = new Float32Array(S * S);
    var rgh = null;
    var half = S * 0.5;
    // Phase offsets keep the four decals from sharing a silhouette.
    var ox = rng.range(0, 40), oy = rng.range(0, 40);

    // Angular wobble sampled on a circle in 2D noise. Doing it this way is
    // periodic *by construction*; indexing a table by atan2 leaves a hard
    // seam along -X (and JS's % on negatives makes it worse).
    function wobble(ang, amp, freq) {
      // GAME.Noise.perlin2 is the classic unnormalised gradient noise and can
      // overshoot +-1; clamping keeps `amp` an honest fractional radius swing
      // instead of occasionally halving the shape into petals.
      var n = M.clamp(NOISE.perlin2(Math.cos(ang) * freq + ox, Math.sin(ang) * freq + oy), -1, 1);
      return 1.0 + n * amp;
    }

    // Satellite droplets / spall chips, precomputed.
    var specks = [];
    var nSpecks = kind === 'blood' ? 30 : (kind === 'bullet_hole' ? 26 : 0);
    for (var s = 0; s < nSpecks; s++) {
      var sa = rng.range(0, M.TAU);
      var sr = Math.pow(rng.next(), 0.6) * 0.40 + (kind === 'blood' ? 0.20 : 0.16);
      specks.push({
        x: half + Math.cos(sa) * sr * S, y: half + Math.sin(sa) * sr * S,
        r: rng.range(1.0, kind === 'blood' ? 5.5 : 2.6),
        a: rng.range(0.4, 1.0),
        e: rng.range(1.0, kind === 'blood' ? 2.6 : 1.3),      // elongation
        d: sa + rng.range(-0.3, 0.3)                          // throw direction
      });
    }

    // Blood gets a few cast-off "fingers" thrown from the main pool. They
    // share a dominant direction (spatter has momentum) and start slightly
    // off-centre, otherwise the result reads as a symmetrical flower.
    var fingers = [];
    if (kind === 'blood') {
      var throwDir = rng.range(0, M.TAU);
      for (var f = 0; f < 3; f++) {
        var fa = throwDir + rng.gaussian(0, 0.55);
        var fl = rng.range(0.20, 0.42);
        var sx = rng.range(-0.09, 0.09), sy = rng.range(-0.09, 0.09);
        fingers.push({
          sx: sx, sy: sy,
          dx: Math.cos(fa) * fl, dy: Math.sin(fa) * fl,
          w: rng.range(0.011, 0.024)
        });
      }
    }

    if (kind === 'blood') rgh = new Uint8Array(S * S * 4);

    // Distance from p to the segment (ax,ay)->(ax+bx,ay+by), normalised units.
    var _seg = { d: 0, t: 0 };
    function segDist(px, py, ax, ay, bx, by) {
      var rx = px - ax, ry = py - ay;
      var ll = bx * bx + by * by;
      var t = ll > 1e-8 ? M.saturate((rx * bx + ry * by) / ll) : 0;
      var qx = rx - bx * t, qy = ry - by * t;
      _seg.d = Math.sqrt(qx * qx + qy * qy);
      _seg.t = t;
      return _seg;
    }

    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var nx = (x - half) / half, ny = (y - half) / half;   // -1..1
        var r = Math.sqrt(nx * nx + ny * ny);
        var ang = Math.atan2(ny, nx);
        // Cartesian noise - continuous everywhere, no angular seam.
        var n = NOISE.fbm2(x / S * 7 + ox, y / S * 7 + oy, 4, 2, 0.5) * 0.5 + 0.5;
        var nf = NOISE.fbm2(x / S * 22 + oy, y / S * 22 + ox, 3, 2, 0.5) * 0.5 + 0.5;

        var a = 0, h = 0;
        var cr = 0, cg = 0, cb = 0, rough = 0.85;

        if (kind === 'bullet_hole') {
          var rHole = 0.11 * wobble(ang, 0.36, 2.3);
          var rCrush = 0.20 * wobble(ang, 0.32, 1.9);
          var rSpall = 0.44 * wobble(ang, 0.34, 1.4) * (0.88 + n * 0.24);
          // Radial hairline cracks. Integer angular multiplier -> periodic.
          var spoke = Math.pow(Math.abs(Math.sin(ang * 6.0 + n * 5.0)), 22.0);
          var crackR = spoke * M.smoothstep(0.86, 0.22, r) * M.smoothstep(rHole * 0.7, rHole + 0.06, r);

          if (r < rHole) {
            // The hole itself: near-black, opaque, deep.
            a = 1.0; h = -1.0;
            cr = 10 + nf * 8; cg = 9 + nf * 7; cb = 8 + nf * 6;
          } else if (r < rSpall) {
            var t = (r - rHole) / Math.max(1e-4, rSpall - rHole);
            var fall = Math.pow(1 - t, 1.25);
            h = -fall * 0.7;
            a = M.saturate(fall * (0.85 + nf * 0.35));
            // Crushed dark ring right at the lip, then pale dust further out.
            var crush = M.smoothstep(rCrush + 0.06, rHole, r);
            var pale = M.lerp(150, 205, t) * (0.78 + nf * 0.34);
            cr = M.lerp(pale, 30, crush);
            cg = M.lerp(pale * 0.95, 27, crush);
            cb = M.lerp(pale * 0.86, 24, crush);
          }
          // A wide, faint lead/dust wash grounds the decal on the surface.
          var wash = Math.pow(M.saturate(1 - r / (rSpall * 2.1)), 2.4) * 0.30 * (0.6 + n * 0.7);
          if (wash > a) {
            var wm = M.saturate((wash - a) / Math.max(1e-4, wash));
            cr = M.lerp(cr, 86, wm); cg = M.lerp(cg, 80, wm); cb = M.lerp(cb, 72, wm);
            a = wash;
          }
          if (crackR > 0.01) {
            var cw = M.saturate(crackR * 1.2);
            a = Math.max(a, cw * 0.55);
            cr = M.lerp(cr, 26, cw); cg = M.lerp(cg, 23, cw); cb = M.lerp(cb, 20, cw);
            h = Math.min(h, -cw * 0.4);
          }

        } else if (kind === 'scorch') {
          // Squash along one axis so the burn is not a perfect circle.
          var er = Math.sqrt(nx * nx * 1.32 + ny * ny * 0.78);
          var rS = 0.66 * wobble(ang, 0.34, 1.6) * (0.82 + n * 0.36);
          var tS = M.saturate(1 - er / Math.max(1e-4, rS));
          // Soft core, ragged noisy edge - soot has no clean boundary.
          a = Math.pow(tS, 1.6) * (0.62 + n * 0.55);
          a *= M.smoothstep(0.0, 0.30, tS + (n - 0.5) * 0.45);
          a = M.saturate(a * 0.95);
          var tone = 14 + nf * 26 + (1 - tS) * 30;
          cr = tone * 1.06; cg = tone * 0.96; cb = tone * 0.88;
          h = -tS * 0.10;

        } else if (kind === 'blood') {
          // Two wobble octaves so the pool outline is lumpy, not a lobed star.
          var rB = 0.40 * wobble(ang, 0.19, 1.7) * (0.90 + n * 0.20);
          var body = M.saturate(1 - r / Math.max(1e-4, rB));
          // Cast-off thrown outward from the pool, tapering to a point.
          for (var fi = 0; fi < fingers.length; fi++) {
            var fg = fingers[fi];
            var sg = segDist(nx, ny, fg.sx, fg.sy, fg.dx, fg.dy);
            var wsel = fg.w * Math.pow(1.0 - sg.t, 1.6) * (0.65 + nf * 0.7);
            body = Math.max(body,
              M.saturate(1 - sg.d / Math.max(1e-4, wsel)) * (1 - sg.t * 0.25));
          }
          a = M.smoothstep(0.01, 0.20, body) * (0.86 + nf * 0.2);
          // Dried, oxidised rim; wet centre stays glossy and darker red.
          // Palette anchored on ART_DIRECTION's #6e1410 - venous, not cherry.
          var edge = M.saturate(1.0 - body * 3.4);
          cr = M.lerp(86, 44, edge * 0.85) * (0.72 + nf * 0.4);
          cg = M.lerp(15, 13, edge) * (0.6 + nf * 0.6);
          cb = M.lerp(12, 11, edge) * (0.6 + nf * 0.6);
          rough = M.lerp(0.26, 0.80, edge);
          // Deliberately a smooth dome, not a copy of `body`: the pool surface
          // is liquid. Reusing the mask here put razor-sharp radial ridges in
          // the normal map, which the glossy centre turned into a fan of
          // specular streaks.
          h = M.smoothstep(0.0, 0.55, body) * 0.30;

        } else {
          // crack: wandering radial fractures, warped by cartesian noise so
          // they meander instead of reading as a clean starburst.
          var warp = (n - 0.5) * 5.5;
          var main = Math.pow(1 - Math.abs(Math.sin(ang * 3.0 + warp)), 20.0);
          var branch = Math.pow(1 - Math.abs(Math.sin(ang * 11.0 + warp * 1.8)), 30.0) * 0.75;
          var fadeC = M.smoothstep(0.96, 0.04, r);
          var line = M.saturate((main + branch) * fadeC * (0.8 + nf * 0.5));
          // Mild chatter so the fractures are not continuous vector strokes,
          // but never enough to erase them - a faint crack reads as dirt.
          line *= 0.55 + 0.45 * M.smoothstep(0.28, 0.62, nf + 0.2);
          a = M.saturate(line * 2.0);
          cr = 26 + nf * 22; cg = 24 + nf * 20; cb = 21 + nf * 18;
          h = -line * 0.9;
        }

        // Specks / droplets punched on top.
        for (var k = 0; k < specks.length; k++) {
          var sp = specks[k];
          var sdx = x - sp.x, sdy = y - sp.y;
          // Elongate along the throw direction for a directional splatter.
          var ca = Math.cos(sp.d), sa2 = Math.sin(sp.d);
          var lx = (sdx * ca + sdy * sa2) / sp.e;
          var ly = -sdx * sa2 + sdy * ca;
          var sd = Math.sqrt(lx * lx + ly * ly);
          if (sd < sp.r) {
            var sv = (1 - sd / sp.r) * sp.a;
            if (sv > 0.05) {
              var mixk = M.saturate(sv * 1.7);
              a = Math.max(a, M.saturate(sv * 1.4));
              if (kind === 'blood') {
                cr = M.lerp(cr, 92, mixk); cg = M.lerp(cg, 14, mixk); cb = M.lerp(cb, 11, mixk);
                rough = M.lerp(rough, 0.2, mixk);
              } else {
                cr = M.lerp(cr, 54, mixk); cg = M.lerp(cg, 49, mixk); cb = M.lerp(cb, 43, mixk);
              }
              h = Math.min(h, -sv * 0.3);
            }
          }
        }

        // Hard fade to zero alpha at the quad border. Without this a decal
        // projected onto a surface shows a visible rectangular cut.
        a *= M.smoothstep(1.02, 0.86, Math.max(Math.abs(nx), Math.abs(ny)));

        col[i * 4] = M.clamp(cr, 0, 255) | 0;
        col[i * 4 + 1] = M.clamp(cg, 0, 255) | 0;
        col[i * 4 + 2] = M.clamp(cb, 0, 255) | 0;
        col[i * 4 + 3] = M.clamp(a * 255, 0, 255) | 0;
        hgt[i] = h;
        if (rgh) {
          rgh[i * 4] = 255;
          rgh[i * 4 + 1] = M.clamp(rough * 255, 0, 255) | 0;
          rgh[i * 4 + 2] = 0;
          rgh[i * 4 + 3] = 255;
        }
      }
    }

    var out = { map: dataTex(col, S, true, true) };
    if (kind !== 'scorch') out.normalMap = dataTex(heightToNormal(hgt, S, 2.6, true), S, false, true);
    if (rgh) out.roughnessMap = dataTex(rgh, S, false, true);
    return out;
  };

  // ==========================================================================
  // Helper materials used by other systems
  // ==========================================================================

  /**
   * emissive(colorHex, intensity) - HDR emitter for lamps, screens, tracers,
   * muzzle flash cards. Intensity > 1 is intentional: postfx bloom keys off
   * the values that survive tone mapping.
   */
  MaterialLibrary.prototype.emissive = function (colorHex, intensity, opts) {
    opts = opts || {};
    colorHex = colorHex === undefined ? 0xffd9a0 : colorHex;
    intensity = intensity === undefined ? 2.0 : intensity;
    var key = 'emissive|' + colorHex + '|' + intensity + '|' + hashOpts('', opts);
    if (this.cache[key]) return this.cache[key];

    var mat = new THREE.MeshStandardMaterial({
      // A dark base colour keeps the surface from washing out when it is *not*
      // the brightest thing in frame, while the emissive term carries the glow.
      color: srgb(opts.baseColor !== undefined ? opts.baseColor : 0x1a1a1a),
      emissive: srgb(colorHex),
      emissiveIntensity: intensity,
      roughness: opts.roughness !== undefined ? opts.roughness : 0.55,
      metalness: 0.0,
      envMapIntensity: 0.6,
      transparent: !!opts.transparent,
      opacity: opts.opacity !== undefined ? opts.opacity : 1.0,
      depthWrite: opts.depthWrite !== undefined ? opts.depthWrite : !opts.transparent,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: opts.side !== undefined ? opts.side : THREE.FrontSide,
      toneMapped: true
    });
    mat.name = key;
    this.cache[key] = mat;
    return mat;
  };

  /**
   * glass(opts) - window/optic glass.
   *
   * opts.variant (any number/string) picks a deterministic pane character -
   * dirtier or cleaner, more or less opaque - so a shopfront of six windows is
   * not six copies of one pane.
   *
   * The albedo map is bound here on purpose: genGlass authors the whole grime
   * story into it (dust film, smears, spatter, cracks) with the grime level in
   * ALPHA. Dropping the map, which is what this used to do, left every pane a
   * uniform milky rectangle - the single reason the market frontage read as
   * grey cardboard rather than glazing.
   *
   * SPECULAR IS NO LONGER ATTENUATED BY COVERAGE. See the premulSpec block in
   * _fragmentShader: the pane composites as premultiplied alpha, so the
   * transmitted (diffuse) half is scaled by opacity and the reflected half is
   * added on top at full strength. That is the whole reason glass measured
   * p99/median 1.57 on the chart - the Fresnel rim and the sky reflection were
   * being multiplied down by the same 0.19-0.44 that makes the pane see-through.
   *
   * opts.transmission still switches on r180's real refraction path for
   * anything that needs it (an optic lens, a bottle). It is off by default
   * because that path re-renders every opaque object into a second target
   * every frame, which is not affordable on twenty shopfronts.
   */
  MaterialLibrary.prototype.glass = function (opts) {
    opts = opts || {};
    var key = 'glass|' + hashOpts('', opts);
    if (this.cache[key]) return this.cache[key];

    var def = DEFS.glass;
    var maps = this._maps('glass', def, { repeat: opts.repeat || def.repeat });
    var cracked = !!opts.cracked;

    // Deterministic per-pane variation (never Math.random - captures must be
    // reproducible). 0..1 from a hash of whatever the caller labelled it with.
    var vseed = hashString('pane|' + (opts.variant === undefined ? '' : opts.variant));
    var v = (vseed % 1024) / 1024;
    var dirt = 0.35 + v * 0.55;                 // how filthy this pane is
    var useTransmission = !!opts.transmission;

    var mat = new THREE.MeshPhysicalMaterial({
      color: srgb(opts.color !== undefined ? opts.color : 0xb4c1c6),
      metalness: 0.0,
      roughness: cracked ? 0.34 : (opts.roughness !== undefined ? opts.roughness : 0.10),
      map: maps.map || null,
      transparent: true,
      // Coverage now only governs the TRANSMITTED half, so it can come down:
      // the reflection carries the pane's presence.
      opacity: opts.opacity !== undefined ? opts.opacity
        : (cracked ? 0.42 : 0.10 + dirt * 0.24),
      side: THREE.DoubleSide,
      // Glazing reflects a lot. It used to be held at 1.0 to stop every window
      // mirroring a blown-out sky; the horizon/cavity specular-occlusion term
      // is the correct control for that, so this can go back up to a real
      // value and the pane can finally read as glass.
      envMapIntensity: opts.envMapIntensity !== undefined ? opts.envMapIntensity : 1.6,
      ior: 1.52,
      specularIntensity: 1.0,
      depthWrite: false,
      premultipliedAlpha: false
    });

    if (useTransmission) {
      mat.transmission = typeof opts.transmission === 'number' ? opts.transmission
        : (0.86 - dirt * 0.35);
      mat.thickness = opts.thickness !== undefined ? opts.thickness : 0.006;
      mat.attenuationColor = srgb(0xc8ddd6);
      mat.attenuationDistance = 0.4;
      mat.opacity = 1.0;
      mat.transparent = false;
    } else {
      // Premultiplied-alpha compositing: src is already multiplied through by
      // its own coverage in the shader, so the blend must NOT multiply again.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.OneFactor;
      mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    // Grime is what sells glass. A perfectly clean pane reads as a hole.
    if (maps.roughnessMap) { mat.roughnessMap = maps.roughnessMap; mat.roughness = 1.0; }
    if (maps.normalMap) {
      mat.normalMap = maps.normalMap;
      var gns = cracked ? 1.1 : 0.30;
      mat.normalScale = new THREE.Vector2(gns, gns);
    }

    var F = this._features('glass', def, {
      detail: cracked ? 0.45 : 0.2,
      macro: 0.12,
      roughRange: cracked ? [0.20, 0.85] : [0.03 + dirt * 0.04, 0.34 + dirt * 0.30],
      groundAmount: 0.45 + dirt * 0.5,
      premulSpec: !useTransmission
    }, maps, mat);
    F.triplanar = false;
    F.parallax = false;
    this._patch(mat, F);

    mat.name = key;
    this.cache[key] = mat;
    return mat;
  };

  /**
   * foliage(opts) - alpha-tested, two-sided leaf cards with wrap + back
   * translucency. Alpha *test* rather than blend so foliage still writes
   * depth and does not need sorting (and shows up in the shadow map).
   */
  MaterialLibrary.prototype.foliage = function (opts) {
    opts = opts || {};
    var key = 'foliage|' + hashOpts('', opts);
    if (this.cache[key]) return this.cache[key];

    var def = DEFS.foliage;
    var maps = this._maps('foliage', def, { repeat: opts.repeat || def.repeat });

    var mat = new THREE.MeshStandardMaterial({
      color: srgb(opts.color !== undefined ? opts.color : def.color),
      map: maps.map || null,
      normalMap: maps.normalMap || null,
      roughnessMap: maps.roughnessMap || null,
      aoMap: maps.aoMap || null,
      alphaMap: opts.alphaMap || null,
      roughness: maps.roughnessMap ? 1.0 : def.roughFlat,
      metalness: 0.0,
      envMapIntensity: def.env,
      side: THREE.DoubleSide,
      transparent: false,
      alphaTest: opts.alphaTest !== undefined ? opts.alphaTest : 0.45
    });
    if (maps.normalMap) mat.normalScale = new THREE.Vector2(def.ns, def.ns);
    if (maps.aoMap) mat.aoMapIntensity = def.ao;
    // Two-sided alpha-tested cards need both faces in the shadow map or the
    // shadows come out as solid quads.
    mat.shadowSide = THREE.DoubleSide;

    var F = this._features('foliage', def, {
      detail: opts.detail !== undefined ? opts.detail : 0.45,
      macro: opts.macro !== undefined ? opts.macro : def.macro,
      translucent: true,
      wind: opts.wind !== undefined ? opts.wind : 0.05,
      sssColor: opts.sssColor,
      sssScale: opts.sssScale,
      vertexColors: opts.vertexColors
    }, maps, mat);
    F.triplanar = false;
    F.parallax = false;
    F.translucent = true;
    F.wind = opts.wind === false ? 0 : (opts.wind !== undefined ? opts.wind : 0.05);
    F.world = F.macro;
    if (opts.vertexColors) mat.vertexColors = true;
    this._patch(mat, F);

    mat.name = key;
    this.cache[key] = mat;
    return mat;
  };

  /**
   * Scale every cached material's IBL contribution. sky.js can call this when
   * the time of day changes so surfaces track the sky without each system
   * having to know about the others' materials. Scales the value the material
   * was authored with, so relative differences (metals hotter, decals cooler)
   * survive.
   */
  MaterialLibrary.prototype.setEnvIntensity = function (scale) {
    scale = scale === undefined ? 1 : scale;
    var self = this;
    function apply(m) {
      if (!m || m.envMapIntensity === undefined) return;
      if (m.userData.gbBaseEnv === undefined) m.userData.gbBaseEnv = m.envMapIntensity;
      m.envMapIntensity = m.userData.gbBaseEnv * scale;
    }
    for (var k in self.cache) apply(self.cache[k]);
    for (var d in self.decals) apply(self.decals[d]);
  };

  /**
   * Perf fallback. Step counts are baked into the shader, so this only affects
   * materials created *after* the call - switch quality before the level
   * builds, not mid-frame.
   */
  MaterialLibrary.prototype.setQuality = function (level) {
    this.enableParallax = level !== 'low';
    this.pomSteps = level === 'ultra' ? 12 : (level === 'medium' ? 8 : 10);
  };

  // ==========================================================================
  // Free functions
  // ==========================================================================

  function dataTex(bytes, size, isColor, clamp) {
    var t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.userData = { __gbOwned: true };
    t.needsUpdate = true;
    return t;
  }

  // Sobel a scalar height field into a tangent-space normal map (OpenGL
  // convention, +Y up). `clamp` avoids wrapping at the border for decals.
  function heightToNormal(h, S, strength, clampEdge) {
    var out = new Uint8Array(S * S * 4);
    function at(x, y) {
      if (clampEdge) {
        x = x < 0 ? 0 : (x >= S ? S - 1 : x);
        y = y < 0 ? 0 : (y >= S ? S - 1 : y);
      } else {
        x = (x + S) % S; y = (y + S) % S;
      }
      return h[y * S + x];
    }
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        var l = at(x - 1, y), r = at(x + 1, y);
        var bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        var gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        var gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        var nx = -gx * strength, ny = -gy * strength, nz = 1.0;
        var inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        var i = (y * S + x) * 4;
        out[i] = M.clamp((nx * inv * 0.5 + 0.5) * 255, 0, 255) | 0;
        out[i + 1] = M.clamp((ny * inv * 0.5 + 0.5) * 255, 0, 255) | 0;
        out[i + 2] = M.clamp((nz * inv * 0.5 + 0.5) * 255, 0, 255) | 0;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  // Crude cavity/AO from the height field: how far below its local mean a
  // texel sits. Cheap, and it puts grime in the crevices where it belongs.
  function heightToAO(h, S) {
    var out = new Uint8Array(S * S * 4);
    var R = 3;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var sum = 0, n = 0;
        for (var oy = -R; oy <= R; oy += 2) {
          for (var ox = -R; ox <= R; ox += 2) {
            sum += h[(((y + oy + S) % S) * S) + ((x + ox + S) % S)];
            n++;
          }
        }
        var mean = sum / n;
        var occ = M.saturate(0.5 + (h[y * S + x] - mean) * 2.2);
        // Never let AO reach zero - flat black crevices are an amateur tell.
        var v = M.clamp(0.35 + occ * 0.65, 0, 1);
        var i = (y * S + x) * 4;
        out[i] = out[i + 1] = out[i + 2] = Math.round(v * 255);
        out[i + 3] = 255;
      }
    }
    return out;
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  GAME.MaterialLibrary = MaterialLibrary;

})(window.GAME, window.THREE);
