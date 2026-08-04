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
//   7. WET SURFACES       - LEVEL 2 ONLY. Soak, standing water, rain ripples
//                           and rivulets running down vertical faces, driven
//                           by ctx.weather. See the COLD HARBOR block below.
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
//
// ----------------------------------------------------------------------------
// COLD HARBOR (level 2) - additions. Everything here is inert on the market:
// `wetEnabled` is false there, so F.wet is never set, so not one line of the
// wet layer is compiled and every level-1 program cache key is unchanged. That
// is asserted, not assumed - the emitted vertex source, fragment source, cache
// key and every material property were compared against the shipped file
// across 140 material/alias/helper/opts variants and are byte-identical.
//
//   MATERIALS (17, exactly the contracted names)
//     container_steel, container_red, container_blue, container_green,
//     ship_hull, wet_concrete, dock_concrete, chainlink, tarpaulin, rope,
//     rubber_fender, steel_grate, corrugated_roof, deck_plate, sea_water,
//     painted_line, reefer_panel
//     get('sea_water') is answered by water() - see below.
//
//   setWetness(v)            0..1 global soak, on TOP of the per-vertex
//                            wetness channel. Driven from ctx.weather.wetness
//                            every frame; call it directly only to override.
//   setRainIntensity(v)      0..1. Ripple amplitude and streak density.
//   setWind(dirX, dirZ, mps) shears the rivulets, drives the sea.
//   water(opts)              the harbour surface: two-scale animated wave
//                            normals, Beer-Lambert absorption down the view
//                            path, water Fresnel, quay-edge foam. `opts.reflect`
//                            adds a real planar reflection - see below.
//   setWaterFoamEdges(segs)  [[x0,z0,x1,z1], ...] world lines the sea foams
//                            against (the quay face, the hull waterline).
//   setWaterReflection(o)    reconfigure the planar-reflection pass after the
//                            material exists (scale, far, interval, exclude,
//                            maxY, strength, gain, distort, graze, grazePow,
//                            blur, roughFade, y). false switches it off.
//                            Returns the live config so a caller can read what
//                            it got.
//   rippleTexture()          the packed rain-ripple field, so weather.js can
//                            drive its splash decals off the same impacts the
//                            puddles ripple with.
//   auditTextures(names)     which recipe each name actually got served, and
//                            whether any two names silently share one map.
//                            Level 1 shipped with five that did.
//   missingNames             every name that FAILED to resolve, deduplicated.
//                            Non-empty is a bug: on this level get() also logs
//                            it through GAME.logError and returns an emissive
//                            magenta checker rather than a plausible grey, so a
//                            missing material can no longer ship unnoticed
//                            behind clean coverage metrics. See get().
//   wetContract(name)        the live values GAME.MaterialLibrary.WET_GLSL
//                            needs, PLUS `flat` (the up-facing window this file
//                            uses), `ground` (the yard slab and the height band
//                            above which standing water may not form) and
//                            `cfgFor(name)`. A screen-space consumer that
//                            applies the apron's cfg to every up-facing pixel
//                            paints the apron's water onto tarpaulins, deck
//                            plate and crate lids - measured, and it is what
//                            the pale flat-shaded mound in the enemy_closeup
//                            foreground actually is.
//
//   Per-material knobs, all optional in DEFS and in opts:
//     wetDark, wetRough, wetAmt, wetFlat, puddle, streak, wet (force on/off)
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
    },

    // ========================================================================
    // LEVEL 2 - COLD HARBOR.  Container terminal, 02:00, driving rain.
    //
    // EVERYTHING BELOW IS ADDITIVE. No market def, alias, fallback style or
    // tuning value above is touched, and none of the wet-surface shader code
    // these entries enable is compiled into a market material - see
    // `this.wetEnabled` in the constructor and the F.wet gate in _features.
    //
    // Extra fields the harbor surfaces use. Every one of them is optional and
    // absent on every market def, so the market path is byte-identical:
    //
    //   texels  : target texels per world METRE. Only meaningful on triplanar
    //             defs, where `repeat` IS tiles-per-metre. The tile size the
    //             texture library hands back depends on its quality tier
    //             (1024 / 512 / 256), so hard-coding `repeat` bakes in an
    //             assumption about someone else's preset - the apron would
    //             carry half the grain at 'medium' that it does at 'high'.
    //             Solved against the real tile size in _maps().
    //   texAlt  : recipe to use while textures.js does not implement `tex`
    //             yet. Chosen so the surface still reads as the right FAMILY
    //             (containers fall back to corrugated sheet, not flat paint -
    //             "flat-coloured boxes with no corrugation" is on the harbor
    //             instant-fail list), and the palette anchor does the colour.
    //   local   : no market recipe is a sane stand-in, so synthesise locally
    //             rather than let textures.js answer with concrete plus a
    //             loud missingRecipe error in everyone else's capture report.
    //             Only the two alpha-cut meshes and the sea use this.
    //   alphaTest / poly : flags a consumer would otherwise have to re-state
    //             at every call site (and forget at one of them).
    //
    //   wetDark : diffuse multiplier at FULL wetness. This is the physical
    //             heart of the look: a water film fills the surface's pores
    //             and traps light by total internal reflection, so a POROUS
    //             surface goes dramatically darker (concrete 0.42, rope 0.55)
    //             while a SEALED one barely darkens and simply turns glossy
    //             (rubber 0.80, reefer panel 0.86).
    //   wetRough: roughness target at full wetness.
    //   wetAmt  : susceptibility 0..1. Bare rope and jute soak through;
    //             enamel and stainless shed.
    //   wetFlat : how far the micro-normal flattens as water fills the
    //             relief. THIS is what separates convincing wet from a
    //             glossy overlay - a soaked surface is smoother in shape as
    //             well as in gloss.
    //   puddle  : 0..1, can standing water form here at all. Non-zero only
    //             for up-facing horizontal surfaces water can actually lie on.
    //   streak  : 0..1, rain running down a vertical face.
    // ========================================================================

    // Bare / galvanised container steel: corrugated flank, weathered zinc,
    // rust weeping from every weld. metal is high but roughness is wide - a
    // container is not a mirror, it is 30 years of salt spray.
    container_steel: {
      color: 0x6e7276, alb: null, hue: 0.50, tex: 'container_steel', texAlt: 'corrugated_metal',
      rough: [0.26, 0.86], roughFlat: 0.58, metal: 0.86,
      ns: 1.15, ao: 0.9, env: 1.10, repeat: 1.5,
      detail: 0.65, detailCm: 4, wdet: true, macro: 0.18, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.58,
      // Corrugation ribs are a lattice and rust weeps DOWNWARD: quantise the
      // offset to the rib and mirror rather than rotate, exactly as the
      // market's corrugated_metal does.
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.55,
      wetDark: 0.70, wetRough: 0.085, wetAmt: 0.95, wetFlat: 0.42, streak: 1.0
    },
    // The three painted container lots. Enamel over steel is a DIELECTRIC and
    // only the chipped areas conduct, which is why metal sits at 0.5 rather
    // than 0.86 and why - unlike the bare-steel entry - these get a diffuse
    // anchor. alb is solved from each palette entry's own luminance, so the
    // three lots differ in hue without one of them being brighter than the
    // others for no reason.
    container_red: {
      color: 0x7a2f28, alb: 0.075, hue: 0.90, tex: 'container_red', texAlt: 'corrugated_metal',
      rough: [0.24, 0.82], roughFlat: 0.52, metal: 0.50,
      ns: 1.05, ao: 0.9, env: 1.05, repeat: 1.5,
      detail: 0.55, detailCm: 4, wdet: true, macro: 0.20, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.56,
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.5,
      wetDark: 0.66, wetRough: 0.075, wetAmt: 0.9, wetFlat: 0.45, streak: 1.0
    },
    container_blue: {
      color: 0x1f4a6b, alb: 0.070, hue: 0.90, tex: 'container_blue', texAlt: 'corrugated_metal',
      rough: [0.24, 0.82], roughFlat: 0.52, metal: 0.50,
      ns: 1.05, ao: 0.9, env: 1.05, repeat: 1.5,
      detail: 0.55, detailCm: 4, wdet: true, macro: 0.20, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.56,
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.5,
      wetDark: 0.66, wetRough: 0.075, wetAmt: 0.9, wetFlat: 0.45, streak: 1.0
    },
    container_green: {
      color: 0x2c5040, alb: 0.072, hue: 0.90, tex: 'container_green', texAlt: 'corrugated_metal',
      rough: [0.24, 0.82], roughFlat: 0.52, metal: 0.50,
      ns: 1.05, ao: 0.9, env: 1.05, repeat: 1.5,
      detail: 0.55, detailCm: 4, wdet: true, macro: 0.20, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.56,
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.5,
      wetDark: 0.66, wetRough: 0.075, wetAmt: 0.9, wetFlat: 0.45, streak: 1.0
    },
    // The moored freighter. A hull is a WALL in this level - tens of metres of
    // it - so the map density is deliberately coarse (a 1024 tile over 3 m)
    // and the meso band carries the plate seams and the streaking instead.
    // Very dark: a boot-topping black hull under sodium light is almost pure
    // specular.
    // NORMAL AMPLITUDE, not tiling density. The obvious read of "96 texels per
    // metre against a 500 standard" is to raise `repeat`, and that is measurably
    // the WRONG lever here: genShipHull's finest octave is 150 cycles per TILE,
    // so at repeat 0.36 x uv 0.52 (a 5.3 m tile) it is already a 3.6 cm feature
    // - about one screen pixel at the 8-10 m the player stands from the hull in
    // quay / gangway / rain_closeup. Raising the density makes that octave
    // FINER, i.e. more sub-pixel, which is exactly the "crushed foil" read; and
    // because the recipe maps its boot topping, waterline and antifouling bands
    // to the tile's own V, every extra repeat lands another set of paint bands
    // up the hull. Re-authoring genShipHull for a ~1.9 m footprint (weld beads
    // as proud ridges, rivet lines, drips off the scuppers, the paint bands
    // moved to a second tap) is the real fix and it lives in textures.js.
    //
    // What this file can do is stop the existing octave shattering the lobe:
    // ns drops from 1.20 to 0.80, the meso band that authors PLATE-scale relief
    // comes up, and the texel-density normal schedule (gbNrmW) takes the base
    // map down as the footprint shrinks below a pixel instead of leaving it at
    // full strength at 60 m.
    ship_hull: {
      color: 0x2b3239, alb: 0.048, hue: 0.60, tex: 'ship_hull', texAlt: 'rusted_metal',
      rough: [0.26, 0.88], roughFlat: 0.58, metal: 0.55,
      ns: 0.80, ao: 0.9, env: 1.05, repeat: 0.36,
      detail: 0.72, detailCm: 4, wdet: true, macro: 0.22, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.52,
      stoch: true, dir: true, flat: 0.65, meso: 1.15,
      wetDark: 0.62, wetRough: 0.08, wetAmt: 1.0, wetFlat: 0.62, streak: 1.0
    },
    // ---- the apron ---------------------------------------------------------
    // The single largest surface in the level and the one the whole look hangs
    // on: "the concrete apron is a black mirror holding stretched reflections
    // of every lamp". `color` is the DRY chromaticity (a cool grey, never the
    // market's warm tan) and alb the DRY reflectance - the near-black
    // #16191c the art direction quotes is the WET result, and it is the
    // wetness path that gets it there (x0.42, roughness -> 0.055) rather than
    // a black albedo, so the same material still reads as concrete indoors
    // under the warehouse roof where the rain does not reach.
    //
    // MICRO RELIEF IS DELIBERATELY LOW HERE. A 5 cm detail period at strength
    // 0.85 on a surface driven to roughness 0.055 is a field of ~5 cm blobs each
    // catching its own full specular - "a bed of wet pebbles", measured at 1.2%
    // isolated over-bright pixels on the warehouse floor. The reflecting
    // interface on a sheeted slab is the WATER, not the concrete: the substrate
    // relief survives in the albedo cavity and the AO (which are not gated by
    // gbWetND) but must not survive into the shading normal. Hence detail 0.45
    // at a 10 cm period, ns 0.95, and wetFlat right up at 0.94.
    wet_concrete: {
      color: 0x8d949a, alb: 0.17, hue: 0.88, tex: 'wet_concrete', texAlt: 'concrete',
      rough: [0.40, 0.96], roughFlat: 0.91, metal: 0.0,
      ns: 0.95, ao: 0.9, env: 1.05, texels: 500, repeat: 0.5,
      detail: 0.45, detailCm: 10, wdet: true, macro: 0.22, tri: true, pom: 0.012,
      detailKind: 'mineral', polish: 0.62, triWarp: [0.40, 0.40, 0.40], chroma: 0.76,
      meso: 1.0, ground: true, groundAmt: 0.34, dust: 0x6d7278,
      wetDark: 0.42, wetRough: 0.055, wetAmt: 1.0, wetFlat: 0.88, puddle: 1.0, streak: 0.5
    },
    // Precast kerbs, bollard plinths, the crane rails and the warehouse slab -
    // the same family, drier and coarser, and it does not pond nearly as much
    // because it is either sloped, sheltered or above the standing water.
    // Same argument as wet_concrete: a 5 cm detail period at 0.9 read as a
    // uniform field of pebbles at the SAME apparent size at 3 m and at 20 m,
    // which is the signature of a layer whose world period is too coarse to
    // minify and too strong to ignore. 12 cm at 0.35 puts it back in the band
    // where it reads as a float-finished slab.
    dock_concrete: {
      color: 0x8a9096, alb: 0.19, hue: 0.82, tex: 'dock_concrete', texAlt: 'concrete_wall',
      rough: [0.44, 0.97], roughFlat: 0.93, metal: 0.0,
      ns: 1.05, ao: 0.9, env: 1.0, texels: 500, repeat: 0.5,
      detail: 0.35, detailCm: 12, wdet: true, macro: 0.24, tri: true, triSharp: 9.0, pom: 0,
      detailKind: 'mineral', polish: 0.46, triWarp: [0.46, 0.46, 0.46], chroma: 0.72,
      meso: 0.7, ground: true, dust: 0x6d7278,
      wetDark: 0.48, wetRough: 0.085, wetAmt: 1.0, wetFlat: 0.86, puddle: 0.45, streak: 0.7
    },
    // ---- alpha-cut meshes --------------------------------------------------
    // Both are two-sided and alpha TESTED, never blended: a blended fence does
    // not write depth, needs sorting, and drops out of the shadow map - and a
    // perimeter fence that casts no shadow through a sodium lamp cone is the
    // single most obvious way to lose the "pools of light" read.
    //
    // Neither gets stochastic tiling or POM. Blending two offset taps of an
    // ALPHA map lands the blend band on half coverage, which alphaTest then
    // cuts into a ragged fringe along every cell boundary.
    //
    // NEITHER IS A RAW CONDUCTOR. Thirty years of salt on galvanising is a zinc
    // OXIDE film - a dielectric with a real diffuse albedo - and that is exactly
    // why you can see a fence against a night sky at all. At metal 0.90 the mesh
    // had zero diffuse response and could only return direct specular plus an
    // environment probe that is near-black by design at 02:00, so the whole
    // perimeter was carried by a handful of glinting wires.
    //
    // Both also get `alphaCov`: their alpha mip chain is rebuilt on the CPU so
    // each level's coverage above alphaTest matches level 0's (Castano). The
    // driver's box filter converges every level on the MEAN alpha, which for a
    // mesh either fills the apertures in solid or dissolves the wire entirely,
    // depending on which side of alphaTest the mean falls - and a fence that
    // goes opaque blocks the sightline it exists to shoot through and casts a
    // solid slab of shadow through the sodium cone.
    chainlink: {
      color: 0x8a9096, alb: 0.14, hue: 0.45, tex: 'chainlink', local: true,
      rough: [0.34, 0.84], roughFlat: 0.56, metal: 0.25,
      ns: 0.85, ao: 0.85, env: 1.10, repeat: 2.4, side: 2, alphaTest: 0.42,
      alphaCov: true,
      detail: 0.35, detailTile: 24, macro: 0.10, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.50,
      wetDark: 0.82, wetRough: 0.10, wetAmt: 0.85, wetFlat: 0.35, streak: 0.35
    },
    steel_grate: {
      color: 0x5c6165, alb: 0.095, hue: 0.45, tex: 'steel_grate', local: true,
      rough: [0.34, 0.88], roughFlat: 0.60, metal: 0.35,
      ns: 1.0, ao: 0.9, env: 1.05, repeat: 1.6, side: 2, alphaTest: 0.5,
      alphaCov: true,
      detail: 0.5, detailTile: 20, macro: 0.12, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.56,
      wetDark: 0.74, wetRough: 0.09, wetAmt: 0.95, wetFlat: 0.40, puddle: 0.0, streak: 0.6
    },
    // ---- soft goods --------------------------------------------------------
    // PVC tarpaulin over stacked pallets. A dielectric with a real sheen lobe;
    // it SHEDS water rather than absorbing it, so wetDark is high - but it is
    // still a sheet of coated fabric under tension, not a pond.
    //
    // puddle WAS 0.65 AND wetRough 0.070, AND BOTH WERE WRONG. A lashed sheet
    // is DOMED: it is pitched in every direction, water leaves it, and the one
    // thing that cannot happen on it is 65% standing-water coverage at
    // roughness 0.070 - which is a horizontal mirror, and a horizontal mirror
    // under a sodium head returns the lamp at full strength. props_harbor.js
    // diagnosed exactly that and passed puddle 0.16 / wetRough 0.170 by hand at
    // its two tarpaulin call sites, with a nine-line comment explaining why -
    // and then the SAME def served two more call sites (the shrink-wrapped
    // bales and the warehouse unit loads) that did NOT override it, so half the
    // tarpaulins in the level kept the mirror. A number a consumer has to
    // correct at every call site is a wrong number, not a default; this is the
    // library agreeing with the surface it authored.
    //
    // It also matters to a pass this file does not own: postfx's SSR
    // reconstructs "is there standing water here" from DEPTH plus the wet
    // contract, so a def that claims a domed sheet ponds is an invitation to
    // paint an environment reflection over the whole crown. See wetContract().
    tarpaulin: {
      color: 0x46504e, alb: 0.10, hue: 0.40, tex: 'tarpaulin', texAlt: 'cloth_canvas',
      rough: [0.40, 0.92], roughFlat: 0.80, metal: 0.0,
      ns: 1.10, ao: 0.85, env: 0.95, repeat: 1.0, side: 2,
      detail: 0.6, detailTile: 30, macro: 0.18, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.30, sheen: 0.30, sheenColor: 0x9aa8a4,
      stoch: true, dir: true, flat: 0.6,
      wetDark: 0.72, wetRough: 0.150, wetAmt: 1.0, wetFlat: 0.55, puddle: 0.14, streak: 1.0
    },
    // Mooring line under tension. Jute/polyprop lay, and the one surface here
    // that SOAKS: a wet rope goes dark and stays matte, it does not gloss up.
    // Getting that wrong is what makes wet weather read as a varnish pass.
    rope: {
      color: 0x6d6250, alb: 0.11, hue: 0.35, tex: 'rope', texAlt: 'sandbag',
      rough: [0.62, 1.0], roughFlat: 0.94, metal: 0.0,
      ns: 1.30, ao: 0.95, env: 0.85, repeat: 3.0,
      detail: 0.75, detailTile: 26, macro: 0.16, tri: false, pom: 0,
      detailKind: 'woven', polish: 0.12,
      stoch: true, dir: true, flat: 0.6,
      wetDark: 0.55, wetRough: 0.44, wetAmt: 0.9, wetFlat: 0.15, streak: 0.25
    },
    // Cylindrical dock fender. Near-black rubber: the lowest albedo in the
    // library after asphalt, and it gets essentially all of its read from the
    // wet specular.
    rubber_fender: {
      color: 0x1d1f21, alb: 0.028, hue: 0.55, tex: 'rubber_fender', texAlt: 'rubber',
      rough: [0.42, 0.92], roughFlat: 0.85, metal: 0.0,
      ns: 1.0, ao: 0.9, env: 0.90, repeat: 1.2,
      detail: 0.7, detailTile: 22, macro: 0.10, tri: false, pom: 0,
      detailKind: 'mineral', polish: 0.34,
      wetDark: 0.80, wetRough: 0.095, wetAmt: 0.9, wetFlat: 0.40, streak: 0.9
    },
    // ---- structures --------------------------------------------------------
    // Warehouse roof sheeting. Same profile logic as the market's corrugated
    // sheet (6 ribs per tile, quantised offsets) but a longer pitch and a much
    // wider roughness window, because a rusted roof under rain is patchy.
    corrugated_roof: {
      color: 0x5f6461, alb: null, hue: 0.50, tex: 'corrugated_roof', texAlt: 'corrugated_metal',
      rough: [0.28, 0.88], roughFlat: 0.62, metal: 0.85,
      ns: 1.05, ao: 0.9, env: 1.05, repeat: 1.5,
      detail: 0.6, detailCm: 4, wdet: true, macro: 0.18, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.55,
      stoch: true, dir: true, stochQ: [6, 0], flat: 0.6, meso: 0.5,
      wetDark: 0.72, wetRough: 0.085, wetAmt: 0.95, wetFlat: 0.42, puddle: 0.35, streak: 1.0
    },
    // Ship deck / crane walkway / gantry platform, AND - because level_harbor.js
    // builds the whole gantry, the warehouse portal frame, the purlins, the
    // handrails, the bollard tops and the catenary cables out of it - the
    // level's structural steel. See `structural_steel` below for the properly
    // named entry; this one had to stop being a raw conductor either way.
    //
    // PAINTED, NOT BARE. metal was 0.90 with alb null (and genDeckPlate authors
    // a metalness map around 0.85, so the effective value was ~0.77). A
    // conductor has no diffuse response at all: it can return direct specular
    // and the environment probe, and at 02:00 under storm cloud that probe is
    // near-black BY DESIGN - so the crane, which is most of crane.png, was made
    // of a material physically incapable of receiving ambient light and the
    // frame measured 0.098 mean luminance against a 0.10 floor. Real ship-to-
    // shore cranes and warehouse steel are primed and painted, i.e. a dielectric
    // with a genuine albedo, which is exactly why you can see one against a
    // night sky. This lifts the frame by making the crane a LIT OBJECT rather
    // than by pushing exposure, which is the only fix that does not blow out the
    // sodium pools in the same frame.
    deck_plate: {
      // The palette entry is a WARM primer grey, not the cool 0x4e5358 the raw
      // conductor carried. It matters more than it looks: at metal 0.90 the
      // diffuse response was zero, so `color` only ever tinted an F0 nobody
      // could see. As a dielectric it is now the dominant term on every crane
      // member, mast and portal frame in the level - and a cool grey there
      // measurably inverted the grade in the two ship-side framings (gangway
      // -0.038, rain_closeup +0.001 against +0.028 / +0.152 with the surface
      // neutralised), because the crane fills those frames and it was returning
      // the cold mercury floods with no warmth of its own. Yard enamel over
      // red-oxide primer with thirty years of rust weeping through it is warm.
      color: 0x5e574d, alb: 0.090, hue: 0.62, tex: 'deck_plate', texAlt: 'rusted_metal',
      rough: [0.32, 0.90], roughFlat: 0.64, metal: 0.22,
      ns: 1.00, ao: 0.9, env: 1.0, repeat: 1.3,
      detail: 0.6, detailCm: 4, wdet: true, macro: 0.18, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.50,
      stoch: true, dir: true, flat: 0.65, meso: 0.5,
      wetDark: 0.68, wetRough: 0.075, wetAmt: 1.0, wetFlat: 0.62, puddle: 0.55, streak: 0.8
    },
    // Primer-over-plate structural steel: the box girders, the lattice, the
    // portal frame, the stiffener seams and the bolt flanges. A dielectric with
    // a real diffuse albedo and a wide, spatially spread roughness, so it reads
    // against a black sky the way painted steel actually does. The wear channel
    // (see get()'s vertex convention) still breaks edges and impact points
    // through to bare metal, which is where the conductor belongs.
    //
    // It exists as its own name so a consumer does not have to spell structural
    // steel `deck_plate` and get diamond tread on a box girder; `deck_plate` is
    // reserved for the walkways and gratings it was authored for. Alias it
    // through `crane`, `gantry`, `girder`, `structure`, `beam` or `handrail`.
    structural_steel: {
      color: 0x605950, alb: 0.095, hue: 0.62, tex: 'structural_steel', texAlt: 'deck_plate',
      rough: [0.32, 0.90], roughFlat: 0.66, metal: 0.06,
      ns: 0.95, ao: 0.9, env: 1.0, repeat: 1.1,
      detail: 0.6, detailCm: 4, wdet: true, macro: 0.24, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.42,
      stoch: true, dir: true, flat: 0.65, meso: 0.6,
      wetDark: 0.66, wetRough: 0.080, wetAmt: 1.0, wetFlat: 0.60, puddle: 0.35, streak: 0.9
    },
    // Worn lane markings on the apron. Thermoplastic paint is BRIGHT - it is
    // the only high-reflectance surface in a level built out of near-blacks,
    // and it is what gives the apron its leading lines. polyOffset because it
    // is laid coplanar on the slab.
    painted_line: {
      color: 0xd8c65a, alb: 0.30, hue: 0.55, tex: 'painted_line', texAlt: 'concrete',
      rough: [0.30, 0.90], roughFlat: 0.70, metal: 0.0,
      ns: 0.80, ao: 0.8, env: 1.0, repeat: 1.0,
      detail: 0.5, detailCm: 4, wdet: true, macro: 0.16, tri: false, pom: 0,
      detailKind: 'mineral', polish: 0.55, poly: [-3, -6],
      wetDark: 0.46, wetRough: 0.055, wetAmt: 1.0, wetFlat: 0.80, puddle: 0.9, streak: 0.3
    },
    // Reefer end panel: louvred stainless over an insulated box, with the
    // condensation the humming plant leaves on it. The tightest roughness
    // window in the library - this is the surface that throws a hard, small
    // highlight back at a mercury flood.
    reefer_panel: {
      color: 0x9aa3a8, alb: null, hue: 0.45, tex: 'reefer_panel', texAlt: 'painted_metal',
      rough: [0.14, 0.64], roughFlat: 0.34, metal: 0.92,
      ns: 0.85, ao: 0.85, env: 1.20, repeat: 1.4,
      detail: 0.5, detailCm: 3, wdet: true, macro: 0.10, tri: false, pom: 0,
      detailKind: 'metal', polish: 0.72,
      stoch: true, dir: true, flat: 0.7, meso: 0.35,
      wetDark: 0.86, wetRough: 0.065, wetAmt: 0.8, wetFlat: 0.35, streak: 1.0
    },
    // The harbour water. get('sea_water') does NOT come through _create - it
    // is intercepted and answered by MaterialLibrary.water(), which has its
    // own wave/absorption/foam shader. This entry exists so has('sea_water')
    // is true, so maps('sea_water') works for anyone who wants the raw set,
    // and so the name audit has something to check.
    sea_water: {
      color: 0x0d1a20, alb: 0.020, hue: 0.85, tex: 'sea_water', local: true,
      rough: [0.02, 0.30], roughFlat: 0.045, metal: 0.0,
      ns: 0.7, ao: 0.5, env: 1.6, repeat: 0.25,
      detail: 0, macro: 0.14, tri: false, pom: 0,
      detailKind: 'mineral', polish: 0.0,
      wetDark: 1.0, wetRough: 0.03, wetAmt: 0.0, wetFlat: 0.0
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
    default: 'concrete',

    // ---- COLD HARBOR ------------------------------------------------------
    // Purely additive: not one existing key is redefined, so `ground`, `road`,
    // `street`, `metal`, `tarp` and friends still resolve exactly where the
    // market level expects them to. These only add NEW spellings the harbor
    // modules are likely to guess.
    container: 'container_steel',
    corten: 'container_steel',
    hull: 'ship_hull',
    freighter: 'ship_hull',
    apron: 'wet_concrete',
    quay: 'dock_concrete',
    dock: 'dock_concrete',
    wharf: 'dock_concrete',
    fence: 'chainlink',
    wire_fence: 'chainlink',
    mesh: 'chainlink',
    grate: 'steel_grate',
    grating: 'steel_grate',
    walkway: 'steel_grate',
    tarpaulin_sheet: 'tarpaulin',
    mooring: 'rope',
    hawser: 'rope',
    fender: 'rubber_fender',
    bumper: 'rubber_fender',
    roof_sheet: 'corrugated_roof',
    roofing: 'corrugated_roof',
    deck: 'deck_plate',
    checker_plate: 'deck_plate',
    crane: 'structural_steel',
    gantry: 'structural_steel',
    girder: 'structural_steel',
    beam: 'structural_steel',
    structure: 'structural_steel',
    handrail: 'structural_steel',
    portal_frame: 'structural_steel',
    lane: 'painted_line',
    marking: 'painted_line',
    markings: 'painted_line',
    reefer: 'reefer_panel',
    water: 'sea_water',
    sea: 'sea_water',
    ocean: 'sea_water',
    harbour: 'sea_water'
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
    lime_wash: [0xc4cbcb, 0x8e9797, 26, 4, 0.3],
    // ---- COLD HARBOR ------------------------------------------------------
    container_steel: [0x6e7276, 0x3c4043, 20, 3, 0.30],
    container_red: [0x7a2f28, 0x431a16, 20, 3, 0.30],
    container_blue: [0x1f4a6b, 0x122a3d, 20, 3, 0.30],
    container_green: [0x2c5040, 0x192e25, 20, 3, 0.30],
    ship_hull: [0x2b3239, 0x171b1f, 24, 4, 0.28],
    wet_concrete: [0x8d949a, 0x5a5f64, 34, 5, 0.55],
    dock_concrete: [0x8a9096, 0x585d61, 30, 4, 0.50],
    chainlink: [0x8a9096, 0x4d5256, 18, 2, 0.15],
    steel_grate: [0x5c6165, 0x33373a, 18, 2, 0.15],
    tarpaulin: [0x46504e, 0x28302e, 64, 3, 0.25],
    rope: [0x6d6250, 0x433c30, 70, 4, 0.30],
    rubber_fender: [0x1d1f21, 0x0f1011, 52, 5, 0.35],
    corrugated_roof: [0x5f6461, 0x353937, 18, 3, 0.25],
    deck_plate: [0x5e574d, 0x2f2c26, 20, 3, 0.25],
    structural_steel: [0x605950, 0x35312a, 22, 3, 0.28],
    painted_line: [0xd8c65a, 0x8e8137, 26, 4, 0.30],
    reefer_panel: [0x9aa3a8, 0x5f6669, 14, 3, 0.14],
    sea_water: [0x0d1a20, 0x050a0d, 10, 2, 0.05]
  };

  // The two surfaces with no plausible market stand-in. `local:true` in DEFS
  // routes them here instead of asking textures.js for a recipe it may not
  // implement (which answers with concrete AND a loud missingRecipe error in
  // every other agent's capture report). The alpha channel IS the material,
  // so a solid-albedo fallback would turn the perimeter fence into a wall and
  // the crane walkway into a plate - and a wall where a fence should be
  // changes the level's sightlines, not just its look.
  //
  //   wire   : bar half-width, in tile fractions
  //   pitchU/pitchV : cells across the tile
  //   kind   : 'diamond' (chainlink) | 'bar' (bearing bars + cross rods)
  //
  // WIRE THICKNESS IS A COVERAGE BUDGET, not a look. `wire` is a half-width in
  // TILE fractions and the cell is 1/pitch wide, so 0.055 against a 6-cell pitch
  // put the wire across two thirds of the aperture - real 50 mm mesh in 3 mm
  // wire is about 6%. That is a fence you cannot see through even before the mip
  // chain gets involved, and it is what made the perimeter photograph as a
  // slatted screen. 0.012 is a ~14% aperture-to-wire ratio, which reads as mesh
  // and still survives alphaTest at close range because the chain is rebuilt
  // coverage-preserving (see _alphaCoverageMips).
  var FALLBACK_CUT = {
    chainlink: { kind: 'diamond', pitchU: 6, pitchV: 6, wire: 0.012, base: 0x8a9096, tip: 0xb6bfc4 },
    steel_grate: { kind: 'bar', pitchU: 7, pitchV: 2, wire: 0.040, base: 0x5c6165, tip: 0x878e92 }
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
    '  float dsc = gbDetailStrength * gbDetailFadeGB_WND;',
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
  // COLD HARBOR - the wet-surface layer.
  //
  // None of this is compiled into a market material: the whole block is gated
  // on F.wet, which is false unless ctx.levelId is 'harbor' (or a caller opts
  // in explicitly), and the program cache key only grows when it is on - so
  // level 1's shaders are byte-identical to what shipped.
  //
  // The model is deliberately four separable layers rather than one "wetness"
  // multiplier, because they behave differently and a single dial gets each
  // of them wrong:
  //
  //   1. SOAK       - a water film fills the surface's pores and traps light
  //                   by total internal reflection. Porous things go a LOT
  //                   darker (concrete x0.42); sealed things barely darken and
  //                   simply turn glossy (rubber x0.80). It also FLATTENS the
  //                   micro-normal, because the film literally fills the
  //                   relief - that flattening is what separates convincing
  //                   wet from a gloss pass, and it is the part everybody
  //                   leaves out.
  //   2. PUDDLE     - standing water on up-facing surfaces: a flat mirror with
  //                   roughness near zero, the normal collapsed to the
  //                   geometric surface, and a Fresnel-weighted reflective
  //                   layer over the substrate. Edges are feathered, with a
  //                   DAMP RING one shade darker outside the water line, which
  //                   is what stops a puddle reading as a decal.
  //   3. RIPPLE     - impact rings from the downpour, perturbing the puddle
  //                   normal. "Puddles that do not ripple in the rain" is on
  //                   the harbor instant-fail list.
  //   4. STREAK     - water running DOWN vertical faces: container flanks,
  //                   hull plate, glass. A scrolling rivulet mask modulating
  //                   roughness and normal. Subtle, but it is the only thing
  //                   that makes a vertical surface read as wet rather than
  //                   merely dark.
  // ==========================================================================

  // Impact ripples. The source tile is a jittered-grid Voronoi that stores,
  // per texel: R = normalised distance to its emitter, G = that emitter's
  // hashed birth phase, BA = the unit radial direction. The travelling ring is
  // then evaluated analytically, so ONE fetch animates forever with no flipbook
  // and no per-frame CPU work - and because the envelope goes to zero exactly
  // at the cell boundary, the bilinear blend across the Voronoi seam (where
  // direction and phase are discontinuous) is multiplied by nothing.
  var G_RIPPLE = [
    '// ONE WAVEFRONT PER CELL PER PERIOD, at a radius set only by the cell size,',
    '// with a (1-d)^2 (1-ph) envelope, is a field of identical annuli with a thin',
    '// hard rim on a lattice: washers lying on the ground, not rain. Three things',
    '// fix it and all three are free, because the cell already carries a unique',
    '// hash in G and the envelope already goes to zero at the boundary:',
    '//',
    '//   * each drop gets its OWN radius scale, rate and amplitude, taken from',
    '//     two more values folded out of that same hash (r.g is bilinear across',
    '//     the Voronoi seam, but the envelope there is zero, so the derived',
    '//     values may be discontinuous without showing);',
    '//   * a rising CENTRE - the first thing a raindrop makes is a hole, not a',
    '//     ring - which collapses in the first 16% of the life;',
    '//   * the outer fifth of the envelope is FEATHERED, so the ring has no hard',
    '//     terminus and no visible cell boundary.',
    '//',
    '// `gen` decorrelates the phase between the overlapping generations below, so',
    '// several radii are live at once instead of the whole apron pulsing together.',
    'vec2 gbRippleTap( vec2 p, float rate, float scale, vec2 ofs, float gen ) {',
    '  vec4 r = texture2D( gbRippleMap, p * scale + ofs );',
    '  float d = r.r;',
    '  vec2 dir = r.ba * 2.0 - 1.0;',
    '  float hB = fract( r.g * 37.13 + gen );',
    '  float hC = fract( r.g * 91.71 + gen * 2.31 );',
    '  float rs = 0.58 + hB * 0.82;',            // this drop's radius, in cell radii
    '  float ph = fract( gbTime * rate * ( 0.70 + hC * 0.70 ) + r.g + gen * 0.37 );',
    '  float dr = d / rs;',
    '  float w = dr - ph;',                      // signed distance to the wavefront
    '  float ring = sin( w * 26.0 ) * exp( - w * w * 58.0 );',
    '  // The crown: a dimple at the impact point that fills back in. Negative,',
    '  // because dir points radially OUTWARD from the emitter.',
    '  float crown = - 1.5 * exp( - dr * dr * 24.0 ) * ( 1.0 - smoothstep( 0.0, 0.16, ph ) );',
    '  float env = ( 1.0 - smoothstep( 0.62, 1.0, d ) ) * ( 1.0 - ph ) * ( 1.0 - ph );',
    '  return dir * ( ring + crown ) * env * ( 0.55 + hB * 0.80 );',
    '}',
    '// gbRipCfg: x = tiles per metre, y = strength, z = SOURCE MODE.',
    '//',
    '// Mode 1 is weather.js\'s field, and it is the one we want whenever it',
    '// exists: weather.js owns the rain, and it re-renders that map every frame',
    '// from the SAME pool of impact points that spawns the splash particles -',
    '// so a drop that visibly lands makes the ring the puddle shows. It arrives',
    '// as a plain tangent-space normal map, which decodes completely',
    '// differently from our own packing, so the two share one sampler and',
    '// branch on the mode rather than costing a second texture unit and a',
    '// second shader permutation.',
    '//',
    '// Mode 0 is ours: two decorrelated densities of an analytic travelling',
    '// ring, so the puddles still move if weather.js is missing, still building,',
    '// or has failed. Static puddles in driving rain are an instant fail, and',
    '// "another module will provide it" is not a plan.',
    'vec2 gbRipples( vec2 p, float amt ) {',
    '  if ( amt < 0.004 ) return vec2( 0.0 );',
    '  if ( gbRipCfg.z > 0.5 ) {',
    '    vec3 n = texture2D( gbRippleMap, p * gbRipCfg.x ).xyz * 2.0 - 1.0;',
    '    return n.xy * ( amt * gbRipCfg.y );',
    '  }',
    '  // 1.13 / 2.67 / 1.79, NOT 1.15 / 2.30. Densities an octave apart share a',
    '  // lattice, and the sum of two aligned Voronoi grids is a third, very',
    '  // visible grid - the ripples photographed as a regular field of dents.',
    '  // THREE overlapping generations at decorrelated phases, so at any instant',
    '  // several radii are live and the apron is never all at one visual phase.',
    '  vec2 a = gbRippleTap( p, 1.55, 1.13, vec2( 0.0 ), 0.0 );',
    '  vec2 b = gbRippleTap( p, 1.13, 2.67, vec2( 0.41, 0.73 ), 0.53 );',
    '  vec2 c = gbRippleTap( p, 0.86, 1.79, vec2( 0.77, 0.19 ), 0.19 );',
    '  return ( a + b * 0.72 + c * 0.58 ) * amt;',
    '}'
  ].join('\n');

  // Rivulets running down a vertical face. Fully analytic - a texture would
  // have to scroll, and a scrolling texture on a world-projected surface slides
  // relative to the geometry the moment the face is not axis-aligned.
  //
  // Columns are hashed along the face's own horizontal axis, so each rivulet
  // has its own width, speed and break-up; only about half of them are live,
  // because a wall where every column is running reads as a car wash.
  // Returns x = coverage mask, y = the cross-section gradient for the normal.
  var G_STREAK = [
    '// gbStrkW is the view-distance schedule (1 near, ~0.2 far). A rivulet is a',
    '// centimetre-scale analytic feature with no mip chain, so without it the',
    '// layer runs at full amplitude at 60 m where its column pitch is a third of',
    '// a pixel - which is precisely the heavy vertical striping that covered the',
    '// container flanks and the freighter hull. Every other high-frequency layer',
    '// in this file already fades (gbDetailFade 9-26 m, gbDet2W 3-7 m, gbMesoW',
    '// 42-92 m, gbPomFade 4-11 m); this one did not, and it is the only one that',
    '// also snaps roughness to 0.048 on the texels it touches.',
    'vec2 gbStreaks( vec3 wp, vec3 wn ) {',
    '  // The face\'s own HORIZONTAL tangent, so the column spacing is correct at',
    '  // any yaw. The old code picked wp.zy or wp.xy off the dominant normal',
    '  // axis, which is only right for an axis-aligned face - a hull plate or a',
    '  // skewed container end got its rivulets spaced along the wrong axis and',
    '  // sheared with it.',
    '  vec2 hx = vec2( wn.z, - wn.x );',
    '  float hl = length( hx );',
    '  hx = hl > 1e-4 ? hx / hl : vec2( 1.0, 0.0 );',
    '  vec2 pl = vec2( dot( wp.xz, hx ), wp.y );',
    '  // COVERAGE IS A BUDGET, and this layer blew it. The pitch went 9.0 -> 4.2',
    '  // (a 24 cm column) to stop the cross-section going sub-pixel, which was',
    '  // right, but the WIDTH went with it: a half-width of 0.16-0.42 of the cell',
    '  // is a run 7.7-20 cm wide, and at step(0.52) half the columns were live.',
    '  // Multiply it out and 23-27% of every vertical face in the level was',
    '  // running with water - measured as 23% of the columns on the red container',
    '  // flank sitting below 45% of the flank median, i.e. the "heavy dark',
    '  // red/black vertical smearing". Rain on a container does not do that: it',
    '  // sheets off the top rail and comes down as a HANDFUL of runs a few',
    '  // centimetres wide, in the corrugation valleys, with dry ribs between them.',
    '  //',
    '  // 3.1 (a ~32 cm column) with a 2.2-5.8 cm half-width and step(0.62) puts',
    '  // the budget at ~5% before the break-up noise and ~3% after, which is what',
    '  // a flank in a downpour actually looks like - and the run is still 4-11 px',
    '  // across at 10 m, so nothing has gone back below Nyquist.',
    '  float U = pl.x * 3.1;',
    '  float ci = floor( U );',
    '  float fu = fract( U ) - 0.5;',
    '  float h1 = gbHash13( vec3( ci, 7.3, 2.1 ) );',
    '  float h2 = gbHash13( vec3( ci, 1.9, 5.7 ) );',
    '  float live = step( 0.62, h1 );',
    '  float w = 0.070 + h2 * 0.110;',
    '  float prof = 1.0 - smoothstep( w * 0.25, w, abs( fu ) );',
    '  // Scroll downward. Wind shear tilts the run slightly off vertical.',
    '  //',
    '  // The vertical frequency is deliberately LOW (a ~1 m break-up period',
    '  // against the column pitch). Water running down a container flank makes',
    '  // long thin rivulets that occasionally break and re-form; at a frequency',
    '  // anywhere near the column pitch the same code makes isotropic blobs, and',
    '  // the flank photographs as mottled frost rather than as anything running',
    '  // anywhere.',
    '  float yy = pl.y * ( 0.85 + h2 * 1.05 ) + gbTime * ( 0.40 + h1 * 0.95 )',
    '           + pl.x * gbWindW.z * 0.06;',
    '  float bead = smoothstep( 0.34, 0.74, gbValue3( vec3( ci * 3.1, yy, 0.7 ) ) );',
    '  float mask = live * prof * bead * gbStrkW;',
    '  // A rivulet is a lens: the normal bends outward from its centre line.',
    '  float g = - sign( fu ) * prof * ( 1.0 - prof ) * 4.0 * live * bead * gbStrkW;',
    '  return vec2( mask, g );',
    '}'
  ].join('\n');

  // Where standing water can lie. Two world-space octaves make the basins,
  // biased by the surface's own cavity so the water settles INTO the relief
  // rather than floating on top of it, and the threshold falls as the level
  // soaks - so a puddle grows outward from its deepest point as the storm
  // builds instead of fading up as a flat stencil.
  var G_PUDDLE = [
    'float gbPuddleField( vec3 wp, float cav ) {',
    '  float b = gbValue3( wp * vec3( 0.21, 0.05, 0.21 ) + 17.0 ) * 0.63',
    '          + gbValue3( wp * vec3( 0.86, 0.09, 0.86 ) + 41.0 ) * 0.37;',
    '  return b + ( 0.5 - cav ) * 0.20;',
    '}'
  ].join('\n');

  // --------------------------------------------------------------------------
  // gbWetSolve - THE WET CONTRACT, in one function, published.
  //
  // Everything about "how wet is this square metre" - standing-water coverage,
  // the damp collar outside it, film thickness and the resulting roughness -
  // lives here so there is exactly ONE definition of it. It used to live inline
  // in the material shader, and postfx.js's screen-space reflection pass (which
  // has no G-buffer and must reconstruct the surface from depth) hand-rolled a
  // completely different field: one octave of value noise at a ~7 m period with
  // no cavity term, against this file's two octaves at ~4.8 m and ~1.2 m. The
  // two were uncorrelated, so the apron came out mirror-flat where the SSR noise
  // said "puddle" and matte where it said "dry", and neither had anything to do
  // with where this file had darkened the albedo and collapsed the roughness.
  // The reflections were not short - they were in the WRONG PLACES, and the ones
  // that landed on a patch the material believed was dry got blurred and faded
  // by the roughness ramp.
  //
  // So the string is exported as GAME.MaterialLibrary.WET_GLSL and postfx can
  // paste it verbatim: same noise, same field, same thresholds, byte-identical
  // evaluation in both passes. MaterialLibrary.wetContract() hands over the live
  // uniform values to feed it.
  //
  //   wp   world position
  //   up   clamp( worldNormal.y, 0.0, 1.0 )
  //   cav  the surface's own 0.1-0.6 m cavity; 0.5 is neutral. A consumer with
  //        no G-buffer passes 0.5. The term is a +-0.03 bias on a field whose
  //        transition is 0.115 wide, so the two agree to within a quarter of the
  //        puddle's edge feather - which is inside the SSR blur anyway.
  //   cfg  x = global wetness, y = rain intensity, z = this surface's puddle
  //        susceptibility, w = its base wet roughness (DEFS.wetRough)
  //
  // out pud   standing-water coverage
  // out damp  the darker wicked collar just outside the water line
  // out film  the SHAPED film thickness (0 = a damp bloom the substrate shows
  //           through, 1 = a continuous sheet standing on it)
  // returns   the wet roughness target for this fragment
  // --------------------------------------------------------------------------
  var G_WETSOLVE = [
    'float gbWetSolve( vec3 wp, float up, float cav, vec4 cfg,',
    '                  out float pud, out float damp, out float film ) {',
    '  // Two world octaves, ~2.4 m and ~0.65 m, biased by the cavity so the film',
    '  // pools INTO the relief exactly as the puddle basins do. Rain drives it:',
    '  // in a downpour more of the surface is sheeted, so heavy rain reads',
    '  // glossier than drizzle without the wetness dial doubling as a gloss dial.',
    '  float raw = clamp( gbValue3( wp * vec3( 0.41, 0.11, 0.41 ) + 91.0 ) * 0.62',
    '            + gbValue3( wp * vec3( 1.54, 0.22, 1.54 ) + 23.0 ) * 0.38',
    '            + ( 0.5 - cav ) * 0.18',
    '            + ( cfg.y - 0.5 ) * 0.22, 0.0, 1.0 );',
    '  pud = 0.0; damp = 0.0;',
    '  float lvl = cfg.x * cfg.z;',
    '  if ( lvl > 0.004 ) {',
    '    float flatN = smoothstep( 0.70, 0.93, up );',
    '    // The water line falls as the yard soaks, so a puddle GROWS out of its',
    '    // deepest point instead of fading up as a flat stencil. 0.56 puts it at',
    '    // roughly a fifth of a level surface at full storm, which is what a yard',
    '    // with drainage falls actually looks like in a downpour.',
    '    float thr = mix( 0.94, 0.56, lvl );',
    '    float fld = gbPuddleField( wp, cav );',
    '    pud = smoothstep( thr, thr + 0.115, fld ) * flatN;',
    '    // A feathered damp ring OUTSIDE the water line. A puddle whose edge is a',
    '    // hard line reads as a decal; real standing water wicks into the',
    '    // surrounding surface and leaves a darker collar.',
    '    damp = smoothstep( thr - 0.17, thr + 0.015, fld ) * ( 1.0 - pud ) * flatN;',
    '  }',
    '  // A SUSTAINED DOWNPOUR SHEETS A SLAB. Off the noise field alone the film',
    '  // only went continuous in the basins, so across most of the apron the',
    '  // shaped film sat near 0.34 and two thirds of the micro relief survived -',
    '  // on the surface the art direction calls a black mirror. Above ~0.8 global',
    '  // wetness a horizontal surface that can pond at all is simply running with',
    '  // water. Gated on wetness AND on cfg.z, so a sheltered slab and every',
    '  // vertical face are untouched.',
    '  // Deliberately a FLOOR of about half, not a clamp to sheeted: measured at',
    '  // 0.74 the whole ground plane went to one film thickness, which is the',
    '  // uniform-mirror failure this file already fought once. The spread between',
    '  // damp high spots and sheeted hollows is what gives the level a specular',
    '  // STRUCTURE rather than one flat gloss.',
    '  float sheet = smoothstep( 0.78, 0.94, cfg.x ) * smoothstep( 0.55, 0.85, up )',
    '              * step( 0.004, cfg.z ) * 0.50;',
    '  film = max( smoothstep( 0.26, 0.78, raw ), sheet );',
    '  // A thin damp bloom on porous concrete is NOT a mirror: the water is',
    '  // inside the pores and the surface it presents is still the aggregate, so',
    '  // it lands around 0.20-0.25. Only where the film goes continuous does it',
    '  // approach the substrate-independent water value in cfg.w. Spanning that',
    '  // range is what gives the level a specular STRUCTURE instead of one flat',
    '  // gloss, and it is what a roughness-aware reflection blur needs in order',
    '  // to do anything at all.',
    '  return cfg.w * mix( 3.9, 0.92, film );',
    '}'
  ].join('\n');

  // ==========================================================================
  // COLD HARBOR - the sea.
  //
  // Wave normals are accumulated as SLOPES rather than as normals: three
  // scrolled taps of one gradient tile at 9 m / 2.2 m / 0.6 m, summed and then
  // turned into a normal once. Summing normals and renormalising loses
  // amplitude on every layer after the first; summing gradients is what the
  // surface actually is.
  // ==========================================================================
  var G_WAVE = [
    'vec2 gbWaveG( vec2 p, vec2 flow, float scale, float amp ) {',
    '  vec4 t = texture2D( gbWaveMap, p * scale + flow );',
    '  return ( t.rg * 2.0 - 1.0 ) * amp;',
    '}'
  ].join('\n');

  // Distance from a point to the nearest quay/hull edge segment, in metres.
  // Foam collects where the water meets something solid; without this the sea
  // is a clean plane butted against the wharf, which is the giveaway that it
  // is a plane. Segments are supplied by the level through
  // MaterialLibrary.setWaterFoamEdges() and default to none, in which case only
  // the drifting scum and the wind-driven crest foam survive.
  var G_FOAMEDGE = [
    'float gbEdgeDist( vec2 p ) {',
    '  float best = 1e4;',
    '  for ( int i = 0; i < GB_FOAM_MAX; i ++ ) {',
    '    vec4 s = gbFoamSeg[ i ];',
    '    vec2 a = s.xy, b = s.zw - s.xy;',
    '    float ll = max( dot( b, b ), 1e-6 );',
    '    float t = clamp( dot( p - a, b ) / ll, 0.0, 1.0 );',
    '    float d = length( p - a - b * t );',
    '    // Unused slots are masked out rather than broken out of: a `break`',
    '    // on a non-constant condition is outside GLSL ES 1.0\'s mandatory',
    '    // loop grammar, and this loop is six iterations of eight ALU.',
    '    d = mix( 1e4, d, step( float( i ), float( gbFoamCount ) - 0.5 ) );',
    '    best = min( best, d );',
    '  }',
    '  return best;',
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

    // ------------------------------------------------------------------------
    // COLD HARBOR - wet-surface state.
    //
    // THE LEVEL-1 GATE. Everything wet hangs off this one flag. It is false
    // for the market, which means _features never sets F.wet, which means the
    // program cache key never grows, which means every market material
    // compiles the same source it shipped with. There is no "wetness 0" code
    // path running on level 1 - there is no code.
    //
    // The trigger is deliberately BROAD (level id, or the level declaring a
    // weather preset, or a caller passing opts.wet) so that a level added
    // later gets it without editing this file, and NARROW in effect (any level
    // that does not ask for weather is untouched).
    // ------------------------------------------------------------------------
    var lid = null, ldef = null;
    try { lid = ctx && ctx.levelId; ldef = ctx && ctx.levelDef; } catch (e) { /* no ctx */ }

    // ------------------------------------------------------------------------
    // THE LEVELS 3-10 GATE.
    //
    // market and harbor carry `env: null` in main.js's LEVELS table - that is
    // the documented marker for "legacy level, configures itself" and it is
    // the ONLY thing the two frozen levels have in common that a level added
    // later cannot accidentally acquire. Every filtering correction added
    // below hangs off this flag, so both shipped levels emit byte-identical
    // shader source and land on byte-identical program cache keys. The level
    // id test is belt-and-braces: if anyone ever gives market or harbor an env
    // profile, they still do not get the new code.
    //
    // This is a FILTERING gate, not a look gate. Nothing behind it changes art
    // direction; it changes how the shading normal is band-limited against the
    // pixel footprint, which is a correctness property every level wants and
    // which levels 1-2 already got by other means (the market never runs a
    // point light near-tangent to a normal-mapped wall; the harbor gets the
    // same schedule through F.wet).
    // ------------------------------------------------------------------------
    this.declarative = !!(ldef && ldef.env) && lid !== 'market' && lid !== 'harbor';

    // The weather half of the gate. `ldef.weather` is where the LEGACY levels
    // declare a preset; levels 3-10 declare theirs inside `env` because
    // main.js's applyEnv() reads it from there. The original expression only
    // looked at the top-level field, so every declarative level came out with
    // wetEnabled false no matter what preset it had asked weather.js for -
    // which is not a subtle mis-tuning, it silently removes the whole wet
    // contract from a level that is standing in a downpour. `clear` is
    // excluded because weather.js treats `clear` as ABSENT (no geometry, no
    // wetness, nothing added to the scene) and a level that asked for nothing
    // must not pay for a wet program.
    var envWeather = (ldef && ldef.env && ldef.env.weather) || null;
    this.wetEnabled = !!(lid === 'harbor' || (ldef && ldef.weather) ||
      (this.declarative && envWeather && envWeather !== 'clear'));

    // Shared uniform OBJECTS - one per concept for the whole library, exactly
    // like _time. Assigning the same object into every material's uniform set
    // means setWetness() is a single scalar write that reaches every surface
    // in the level, with no per-material iteration and no recompile.
    //   gbWetP : x = global wetness, y = rain intensity,
    //            z = this material's puddle amount, w = its streak amount
    //            (z/w are per-material, so gbWetP is NOT shared - only x/y are
    //            pushed into it by _syncWeather; see _pushWet)
    this._wetGlobal = { value: new THREE.Vector2(0, 0) };   // wetness, rain
    this._windW = { value: new THREE.Vector3(0.70, 0.71, 0) }; // dir.xy, speed
    this._rippleTex = { value: null };
    // x = ripple tiles per metre, y = strength, z = source mode
    // (0 = this file's analytic field, 1 = weather.js's normal map)
    this._ripCfg = { value: new THREE.Vector4(1.0, 1.0, 0, 0) };
    this._ownRipple = null;      // ours, kept so we can fall back to it again
    this._frames = 0;
    this._waveTex = { value: null };
    this._wetMats = [];          // materials carrying a per-material gbWetP
    this.wetness = this.wetEnabled ? 0.88 : 0.0;
    this.rainIntensity = this.wetEnabled ? 0.85 : 0.0;
    // Set true the first time _syncWeather sees a real ctx.weather, so the
    // defaults above stop fighting it.
    this._weatherSeen = false;
    // Quay/hull edges the sea foams against. See setWaterFoamEdges().
    this._foamSeg = { value: [] };
    this._foamCount = { value: 0 };
    for (var fi = 0; fi < FOAM_MAX; fi++) this._foamSeg.value.push(new THREE.Vector4(0, 0, 0, 0));
    // Populated by auditTextures(); see the comment there.
    this.textureAudit = null;
    // Every material name that failed to resolve, deduplicated. See
    // _debugMaterial(). Empty is the only acceptable value in a shipping build.
    this.missingNames = [];
  }

  // How many quay-edge segments the sea shader can foam against. Baked as a
  // #define, so it is a constant rather than a setting: the loop is unrolled
  // and the count uniform breaks out of it early.
  var FOAM_MAX = 6;

  // Edge length of every family detail tile (see build() / _makeDetailNormal).
  // Baked into the shader as a literal rather than passed as a uniform: it is
  // the same number for all four families and it has to be, because the detail
  // texel-density schedule reads it as a compile-time constant.
  var DETAIL_TEXELS = 256;

  // The harbor's own material set, in the order the level asks for it. Public
  // so a consumer (or a test) can iterate the level-2 library without knowing
  // which entries of DEFS are maritime.
  var HARBOR_NAMES = ['container_steel', 'container_red', 'container_blue',
    'container_green', 'ship_hull', 'wet_concrete', 'dock_concrete', 'chainlink',
    'tarpaulin', 'rope', 'rubber_fender', 'steel_grate', 'corrugated_roof',
    'deck_plate', 'structural_steel', 'sea_water', 'painted_line', 'reefer_panel'];
  MaterialLibrary.harborNames = HARBOR_NAMES.slice();

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

    // COLD HARBOR. The two procedural tiles the wet path needs, built before
    // anything asks for a material so no sampler is ever bound to null. Both
    // are cheap (256px, ~10 ms together) and both are skipped entirely on the
    // market, where nothing samples them.
    if (this.wetEnabled) {
      try { this._ensureRipple(); } catch (e) { GAME.logError('materials.ripple', e); }
      try { this._ensureWave(); } catch (e) { GAME.logError('materials.wave', e); }
      await GAME.yieldFrame();
    }

    // Warm the material set most of the level will ask for. Doing this here
    // means textures.get() cache misses happen during the loading bar.
    var warm = ['concrete', 'concrete_wall', 'plaster', 'brick', 'asphalt',
      'sand', 'gravel', 'rusted_metal', 'painted_metal', 'corrugated_metal',
      'wood_plank', 'tile', 'fabric', 'rubber', 'gun_metal'];
    if (this.wetEnabled) warm = HARBOR_NAMES.concat(['rusted_metal', 'painted_metal', 'gun_metal']);
    for (var i = 0; i < warm.length; i++) {
      try { this.get(warm[i]); } catch (e) { GAME.logError('materials.warm:' + warm[i], e); }
      if ((i & 3) === 3) await GAME.yieldFrame();
    }

    // NAME AUDIT. Level 1 shipped with five names silently redirecting to
    // another material's map - sandbags wearing a market awning, the alley
    // wall wearing plaster - and it survived a full round of review because
    // nobody checked; the maps were generated every boot and thrown away. So
    // this level asserts instead of assuming: every harbor name is resolved,
    // the texture library is asked which recipe it actually served, and the
    // resulting albedo images are compared by identity.
    //
    // It reports through console.warn and `this.textureAudit`, NOT through
    // GAME.logError, for the same reason _checkDensity does not: logError
    // marks the capture failed in tools/shoot.py, and while textures.js is
    // still being written a fallback is the EXPECTED state, not a fault. It
    // would break thirteen other agents' capture loops over a known-good
    // degradation.
    if (this.wetEnabled) {
      try { this.auditTextures(); } catch (e) { GAME.logError('materials.audit', e); }
    }
    return this;
  };

  /**
   * auditTextures(names) -> [{ name, want, served, shared, ok }]
   *
   * For each material name: which texture recipe it asked for, which one the
   * library actually served, and whether its albedo image is shared with a
   * DIFFERENT material's. `ok` is false only for a genuine silent redirect -
   * two distinct names ending up on one image without either of them having
   * declared it - which is the exact class of bug that put a market awning on
   * the sandbags.
   *
   * A declared fallback (DEFS.texAlt, used while textures.js has not shipped
   * the recipe yet) is reported as `served` !== `want` with ok:true: it is a
   * degradation the library chose, not one it failed to notice.
   */
  MaterialLibrary.prototype.auditTextures = function (names) {
    var list = names || HARBOR_NAMES;
    var out = [], byImage = Object.create(null), i;
    for (i = 0; i < list.length; i++) {
      var n = list[i];
      if (ALIASES[n]) n = ALIASES[n];
      var def = DEFS[n];
      var rec = { name: n, want: (def && (def.tex || n)) || n, served: null, shared: null, ok: true };
      try {
        if (!def) { rec.ok = false; rec.served = '(no def)'; out.push(rec); continue; }
        var texName = this._texName(def, n);
        rec.served = texName === null ? '(local)' : texName;
        var m = this.get(n);
        var img = m && m.map && m.map.image;
        if (img) {
          var key = (img.width | 0) + 'x' + (img.height | 0) + '#';
          // Identity, not dimensions: two 512s are only the SAME texture if
          // they are literally the same image object.
          var found = null;
          for (var k in byImage) { if (byImage[k].img === img) { found = byImage[k]; break; } }
          if (found) {
            rec.shared = found.name;
            // Sharing is legitimate when both sides declared the same recipe
            // (the three container lots deliberately re-colour one corrugated
            // sheet, exactly as paint_blue/paint_green re-colour one enamel).
            rec.ok = (found.served === rec.served);
          } else {
            byImage[key + n] = { img: img, name: n, served: rec.served };
          }
        }
      } catch (e) { rec.ok = false; rec.served = 'error: ' + e; }
      out.push(rec);
    }
    this.textureAudit = out;
    var bad = out.filter(function (r) { return !r.ok; });
    if (bad.length) {
      try {
        console.warn('materials: ' + bad.length + ' harbor name(s) share a map with ' +
          'an unrelated material: ' + bad.map(function (r) {
            return r.name + '->' + r.shared;
          }).join(', '));
      } catch (e2) { /* no console */ }
    }
    // Anything that fell through to the debug material is a HARD failure, not a
    // declared degradation, so it is reported through logError - see get().
    // Reported here as well as at the point of failure so a consumer that only
    // looks at the audit still sees it.
    if (this.missingNames && this.missingNames.length) {
      try {
        console.error('materials: ' + this.missingNames.length +
          ' UNRESOLVED material(s): ' + this.missingNames.join(' | '));
      } catch (e3) { /* no console */ }
    }
    return out;
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
    if (this.wetEnabled) {
      this._frames++;
      try { this._syncWeather(ctx || this.ctx); }
      catch (e) { GAME.logError('materials.weather', e); }
    }
    // THE PLANAR WATER REFLECTION. Only exists if a water() call turned it on,
    // which the two frozen levels never do - see _reflectWanted(). Runs HERE, in
    // update(), rather than from an onBeforeRender hook on the water mesh: a
    // nested renderer.render() inside postfx's own pass would have to survive
    // whatever render target and MRT attachment that pass had bound, and this
    // build's composer is not three's. update() is called from step(), outside
    // any render, so the only state to restore is the renderer's.
    if (this._refl && this._refl.on) {
      try { this._reflectRender(ctx || this.ctx); }
      catch (e) {
        // Once. Then the feature switches itself off and the water falls back
        // to the environment-only look it shipped with - a degradation, not a
        // black frame, and not forty identical errors in the capture report.
        this._refl.on = false;
        if (this._reflCfg) this._reflCfg.value.x = 0;
        GAME.logError('materials.reflect', e);
      }
    }
  };

  // --------------------------------------------------------------------------
  // THE WEATHER CONTRACT, consumer side. src/fx/weather.js owns this state;
  // this file only reads it, and every single field is optional - a build with
  // no weather system, or one whose weather system failed, keeps the harbor's
  // storm defaults rather than drying the level out to a clear day.
  //
  // NOTE ON ORDERING: main.js builds and updates `materials` at index 1 and
  // `weather` at index 11, so this reads LAST frame's weather state. That is
  // deliberate and correct - a one-frame lag on a value that ramps over
  // seconds is invisible, and reaching forward to a system that has not
  // updated yet would be worse.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._syncWeather = function (ctx) {
    var w = ctx && ctx.weather;
    if (!w) return;
    this._weatherSeen = true;
    if (typeof w.wetness === 'number' && isFinite(w.wetness)) {
      this.wetness = M.saturate(w.wetness);
    }
    if (typeof w.rainIntensity === 'number' && isFinite(w.rainIntensity)) {
      this.rainIntensity = M.saturate(w.rainIntensity);
    }
    var g = this._wetGlobal.value;
    g.x = this.wetness;
    g.y = this.rainIntensity;

    var d = w.windDir;
    var wv = this._windW.value;
    if (d && isFinite(d.x) && isFinite(d.y) && (d.x * d.x + d.y * d.y) > 1e-6) {
      var il = 1 / Math.sqrt(d.x * d.x + d.y * d.y);
      wv.x = d.x * il; wv.y = d.y * il;
    }
    if (typeof w.windSpeed === 'number' && isFinite(w.windSpeed)) {
      wv.z = M.clamp(w.windSpeed, 0, 40);
    }

    // ---- the ripple normal SOURCE ------------------------------------------
    // weather.js owns the rain, so when it publishes a ripple field we take
    // ITS, and the rings the puddles show then belong to the same impacts that
    // spawn the visible splashes. It is probed under several spellings, and
    // through its uniform, because the contract names the VALUE and not the
    // field name - a map that arrives as `uniforms.uRippleMap` instead of
    // `rippleNormal` should not silently do nothing.
    //
    // Ours stays as the fallback and the shader branches on the mode, so
    // puddles ripple whether or not weather.js ever publishes one. "The other
    // module will provide it" is not a plan for something on the instant-fail
    // list.
    var src = w.rippleNormal || w.rippleMap || w.rippleTexture || w.rippleNormalMap || null;
    if (!src && typeof w.getRippleTexture === 'function') {
      try { src = w.getRippleTexture(); } catch (e) { src = null; }
    }
    if (!src && w.uniforms && w.uniforms.uRippleMap) src = w.uniforms.uRippleMap.value;

    // Not before frame two. weather.js builds its render target during boot but
    // does not draw into it until its first update() - which is AFTER ours in
    // the system order - so binding it on frame one would sample a cleared
    // target and decode (0,0,0) as a hard constant tilt across every puddle.
    if (isTexture(src) && this._frames > 1) {
      if (src !== this._rippleTex.value) {
        src.wrapS = src.wrapT = THREE.RepeatWrapping;
        if (src.colorSpace !== THREE.NoColorSpace) {
          src.colorSpace = THREE.NoColorSpace;   // a normal map is DATA
          src.needsUpdate = true;
        }
        this._rippleTex.value = src;
      }
      var tiling = (typeof w.rippleTiling === 'number' && w.rippleTiling > 0.05)
        ? w.rippleTiling : 2.6;                  // world metres per tile
      var cfg = this._ripCfg.value;
      cfg.x = 1 / tiling;
      // weather.js already folds rain intensity into the map it renders, so
      // this is a pure amplitude match between the two sources, not a second
      // intensity term. Its map is a full-strength tangent normal (its own
      // uStrength runs to 1.6), and a rain ring is a few degrees of slope, not
      // forty - at 1.0 every puddle in a lamp pool scintillates.
      cfg.y = 0.30;
      cfg.z = 1;
    } else if (this._ripCfg.value.z > 0.5 && !isTexture(src)) {
      // Weather went away (disposed, or its build failed after a preset
      // change). Go back to ours rather than sampling a dead texture.
      this._rippleTex.value = this._ownRipple;
      this._ripCfg.value.z = 0;
    }
  };

  /**
   * wetContract() -> the live values GAME.MaterialLibrary.WET_GLSL needs.
   *
   * materials.js OWNS where the water is. Any other pass that has to know -
   * postfx's screen-space reflection, weather.js's splash spawning, footstep
   * audio picking a wet variant - should evaluate this file's field rather than
   * reconstruct one, because two uncorrelated puddle fields on one surface is
   * not a small error: the reflection lands mirror-flat where the material
   * believes the concrete is dry and matte where it believes there is standing
   * water, which reads as "the reflections are short and blurry" and is
   * completely immune to tuning the reflection.
   *
   *     var W = GAME.MaterialLibrary.WET_GLSL;
   *     frag = W.noise + '\n' + W.puddle + '\n' + W.solve + '\n' + frag;
   *     // then, per fragment, with cav = 0.5 where there is no G-buffer:
   *     //   float rough = gbWetSolve( Wp, up, 0.5, uWetCfg, pud, damp, film );
   *
   * `apron` is the cfg vector for the level's dominant ponding surface
   * (wet_concrete), which is what an SSR pass reconstructing a ground plane
   * from depth actually wants; `cfg(name)` builds it for any other material.
   */
  MaterialLibrary.prototype.wetContract = function (name) {
    var n = name || 'wet_concrete';
    if (ALIASES[n]) n = ALIASES[n];
    var d = DEFS[n] || DEFS.wet_concrete;
    return {
      wetness: this.wetness,
      rain: this.rainIntensity,
      puddle: d.puddle !== undefined ? d.puddle : 0,
      wetRough: d.wetRough !== undefined ? d.wetRough : 0.11,
      wetDark: d.wetDark !== undefined ? d.wetDark : 0.55,
      // vec4 to feed gbWetSolve's `cfg` directly.
      cfg: [this.wetness, this.rainIntensity,
        d.puddle !== undefined ? d.puddle : 0,
        d.wetRough !== undefined ? d.wetRough : 0.11],
      // The ripple field, its packing mode and its world tiling, so a consumer
      // can perturb the reflection with the SAME impacts the puddles show.
      rippleMap: this._rippleTex.value,
      rippleCfg: [this._ripCfg.value.x, this._ripCfg.value.y, this._ripCfg.value.z],
      // The distance schedules this file applies, published so a screen-space
      // pass can match them instead of inventing its own.
      rippleFade: [12.0, 30.0, 58.0, 95.0],
      dryRough: (d.rough && d.rough[1]) || 0.95,

      // ---- WHAT `cfg` IS NOT ------------------------------------------------
      // MEASURED, AND IT IS THE SINGLE MOST DAMAGING THING IN THE LEVEL RIGHT
      // NOW. `cfg` above describes ONE material - by default wet_concrete, the
      // apron, whose puddle susceptibility is 1.0. A screen-space pass has no
      // G-buffer, so it applies that one vector to EVERY pixel whose
      // depth-derived normal points up. In enemy_closeup that includes a
      // tarpaulin crown 1.2 m above the slab, and the result is the large pale
      // flat-shaded mound that fills the bottom-left of the frame: an
      // environment reflection painted over a domed sheet at standing-water
      // roughness, faceted because the normal came from a depth derivative on a
      // low-poly mesh. It is not a missing material - the surface underneath it
      // is a correct, dark, smooth tarpaulin - it is the apron's water lying on
      // something that is not the apron. It also drags the auto-exposure down
      // hard enough to crush the enemy to a silhouette.
      //
      // So the contract now publishes the two things a G-buffer-less consumer
      // needs in order to be right, both purely additive:
      //
      //   flat    the up-facing window gbWetSolve itself uses
      //           (smoothstep(0.70, 0.93, n.y)). SSR's own 0.42/0.86 window is
      //           wider at BOTH ends, so it wets surfaces this file considers
      //           vertical.
      //   ground  { y, band }. Standing water lies on the YARD. `y` is the
      //           world height of the slab and `band` the height over which a
      //           consumer should fade its puddle term out - a crate lid, a
      //           tarpaulin, a container roof or a walkway grating above that
      //           band is a shedding surface, not a pond, whatever its normal
      //           says. Multiply your `pud`/`wetT` by gbWetHeight() (published
      //           as WET_GLSL.height) and the disagreement is gone in one line.
      //   cfgFor  the same vec4 for ANY material name, for a consumer that does
      //           know which surface it is looking at.
      flat: [0.70, 0.93],
      ground: { y: this.groundY, band: 0.85 },
      cfgFor: (function (self) {
        return function (nm) {
          var k = nm || 'wet_concrete';
          if (ALIASES[k]) k = ALIASES[k];
          var dd = DEFS[k] || DEFS.wet_concrete;
          return [self.wetness, self.rainIntensity,
            dd.puddle !== undefined ? dd.puddle : 0,
            dd.wetRough !== undefined ? dd.wetRough : 0.11];
        };
      })(this)
    };
  };

  /**
   * setWetness(v) - global surface wetness, 0..1.
   *
   * The single dial that soaks or dries the whole level. It multiplies on TOP
   * of the per-vertex wetness channel (the G channel of the wear colour
   * attribute, see get()'s wear convention) rather than replacing it, so a
   * patch level.js painted as permanently wet stays the wettest thing in
   * frame at every global level.
   *
   * ctx.weather drives this automatically every frame; call it directly only
   * to override (a cutscene, a test, an interior that never gets rained on).
   */
  MaterialLibrary.prototype.setWetness = function (v) {
    this.wetness = M.saturate(typeof v === 'number' && isFinite(v) ? v : 0);
    this._wetGlobal.value.x = this.wetness;
    return this.wetness;
  };

  /** setRainIntensity(v) - 0..1. Drives ripple amplitude and streak density. */
  MaterialLibrary.prototype.setRainIntensity = function (v) {
    this.rainIntensity = M.saturate(typeof v === 'number' && isFinite(v) ? v : 0);
    this._wetGlobal.value.y = this.rainIntensity;
    return this.rainIntensity;
  };

  /** setWind(dirX, dirZ, speed) - shears the rain streaks and drives the sea. */
  MaterialLibrary.prototype.setWind = function (dirX, dirZ, speed) {
    var v = this._windW.value;
    var l = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (l > 1e-6) { v.x = dirX / l; v.y = dirZ / l; }
    if (typeof speed === 'number' && isFinite(speed)) v.z = M.clamp(speed, 0, 40);
  };

  /**
   * setWaterFoamEdges(segments) - where the sea meets something solid.
   *
   * `segments` is an array of [x0, z0, x1, z1] world-space line segments (the
   * quay face, the freighter's waterline, a slipway) - up to FOAM_MAX of them.
   * The water material builds a distance field from them and lays scum and
   * foam along it. Without this the sea is a clean plane butted against the
   * wharf, which is the single clearest tell that it IS a plane.
   *
   * Safe to call at any time, including after the water material exists: the
   * segments are a uniform, not a #define.
   */
  MaterialLibrary.prototype.setWaterFoamEdges = function (segments) {
    var n = 0;
    try {
      if (segments && segments.length) {
        for (var i = 0; i < segments.length && n < FOAM_MAX; i++) {
          var s = segments[i];
          if (!s) continue;
          var a = s.length >= 4 ? s : [s.x0, s.z0, s.x1, s.z1];
          if (!isFinite(a[0]) || !isFinite(a[1]) || !isFinite(a[2]) || !isFinite(a[3])) continue;
          this._foamSeg.value[n].set(a[0], a[1], a[2], a[3]);
          n++;
        }
      }
    } catch (e) { GAME.logError('materials.setWaterFoamEdges', e); }
    this._foamCount.value = n;
    return n;
  };

  /**
   * rippleTexture() - the packed rain-ripple field this library animates
   * puddles with (R = normalised distance to the impact centre, G = that
   * impact's phase, BA = radial direction). Exposed so weather.js can drive
   * its ground splash decals off the SAME field the puddles ripple with,
   * rather than two uncorrelated rain patterns on one surface.
   */
  MaterialLibrary.prototype.rippleTexture = function () {
    try { return this._ensureRipple(); } catch (e) { return null; }
  };

  // A metal with no environment map renders as a black hole. sky.js normally
  // supplies scene.environment; if it failed to build we drop in a cheap
  // procedural sky probe rather than let every metal surface read as void.
  MaterialLibrary.prototype._ensureEnvironment = function (ctx) {
    if (!ctx || !ctx.scene || !ctx.renderer) return;
    if (ctx.scene.environment) return;

    // Linear HDR radiance, not sRGB colours. A dim probe here is exactly how
    // metals end up looking like black plastic, so these are deliberately
    // bright - a real late-afternoon sky is well above 1.0 in linear.
    var zen = [0.42, 0.72, 1.35];       // cool zenith, matches ART_DIRECTION
    var hor = [2.10, 1.72, 1.28];       // warm dusty horizon
    var gnd = [0.36, 0.29, 0.21];       // sand bounce, never black
    // COLD HARBOR. The same net, three stops down and cold. A late-afternoon
    // desert sky is 20x too bright for 02:00 under storm cloud, and this
    // material library is exactly the wrong place to be the brightest light in
    // a level built on "pools of light with genuine darkness between them" -
    // wet surfaces have a near-black albedo and take almost all their value
    // from the environment, so a daylight fallback here does not read as a
    // slightly-too-bright ambient, it reads as a blown-out level. Still never
    // zero: crushed pure-black shadows are the other instant fail.
    if (this.wetEnabled) {
      zen = [0.016, 0.024, 0.040];      // overcast storm cloud, no moon disc
      hor = [0.052, 0.058, 0.070];      // sodium-lit cloud base off the terminal
      gnd = [0.010, 0.013, 0.017];      // black water and wet concrete bounce
    }
    // ---- PMREM, via fromScene and NOT via fromEquirectangular ---------------
    // MEASURED: on the SwiftShader build tools/shoot.py runs headless Chrome
    // with, PMREMGenerator.fromEquirectangular() returns an ALL-BLACK probe.
    // It fails silently - the render target is the right size, its mapping is
    // CubeUVReflectionMapping, scene.environment is non-null, and every metal
    // in the scene renders as void. It was caught by scaling the source
    // radiance 20x and getting a byte-identical frame, then by drawing the
    // probe as scene.background at intensity 30 and getting black.
    //
    // So the safety net that exists to stop metals reading as black holes was
    // itself producing a black hole, on the exact renderer every capture and
    // every critic round uses. sky.js goes through fromCubemap/fromScene, which
    // is why the market never showed it.
    //
    // fromScene works on the same renderer, and a 24x16 vertex-coloured
    // backside sphere carries this gradient exactly - it is two triangles per
    // band of a function that is smooth in elevation and constant in azimuth,
    // so nothing is lost by expressing it as geometry instead of as texels.
    var geo = new THREE.SphereGeometry(50, 24, 20);
    var pos = geo.attributes.position;
    var col = new Float32Array(pos.count * 3);
    for (var vi = 0; vi < pos.count; vi++) {
      var el2 = M.clamp(pos.getY(vi) / 50, -1, 1);
      var t2 = M.saturate(el2);
      var cr, cg, cb;
      if (el2 >= 0) {
        var k = Math.pow(t2, 0.55);
        cr = M.lerp(hor[0], zen[0], k);
        cg = M.lerp(hor[1], zen[1], k);
        cb = M.lerp(hor[2], zen[2], k);
      } else {
        var d2 = M.saturate(-el2 * 2.2);
        cr = M.lerp(hor[0], gnd[0], d2);
        cg = M.lerp(hor[1], gnd[1], d2);
        cb = M.lerp(hor[2], gnd[2], d2);
      }
      col[vi * 3] = cr; col[vi * 3 + 1] = cg; col[vi * 3 + 2] = cb;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    var probeMat = new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, toneMapped: false, fog: false
    });
    var probeScene = new THREE.Scene();
    probeScene.add(new THREE.Mesh(geo, probeMat));

    var pmrem = new THREE.PMREMGenerator(ctx.renderer);
    var rt = pmrem.fromScene(probeScene, 0.0, 0.05, 120, { size: 128 });
    this._envFallback = rt.texture;
    ctx.scene.environment = rt.texture;
    pmrem.dispose();
    geo.dispose();
    probeMat.dispose();
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
    var asked = name;
    name = (name || 'default');
    if (ALIASES[name]) name = ALIASES[name];
    // The sea is not a surface with a wave normal map bolted on - it has its
    // own absorption, Fresnel and foam model - so get('sea_water') is answered
    // by water(). Routed here rather than making the level call a special
    // method, because the contract names it in the same list as the other
    // sixteen and a consumer should not have to know which one is different.
    if (name === 'sea_water') {
      try { return this.water(opts); }
      catch (e) { GAME.logError('materials.water', e); }
    }
    var key = hashOpts(name, opts);
    var cached = this.cache[key];
    if (cached) return cached;

    // ---- A MISSING MATERIAL MUST BE LOUD -----------------------------------
    // An unknown name used to fall through _create's `DEFS[name] || DEFS.concrete`
    // and come back as a perfectly plausible piece of concrete. That is the
    // worst possible failure mode: the frame contains a wrong-but-believable
    // surface, every coverage and exposure metric passes (they measure missing
    // LIGHT, not missing MATERIAL), and the bug ships. Name it, log it, and
    // paint it in a colour that cannot be mistaken for art direction.
    //
    // WHY THE PAINT IS GATED ON wetEnabled AND THE REPORT IS NOT. Level 1 is
    // shipped and frozen, and I cannot prove by inspection that no market call
    // site anywhere in eight scenarios asks for a name this table does not
    // have - so turning a market surface magenta, or failing tools/shoot.py on
    // a level-1 capture (GAME.logError does both), is a risk with no upside on
    // a level nobody is changing. The DETECTION runs everywhere and is recorded
    // on this.missingNames + console for anyone who looks; the LOUD failure
    // runs on the level being built, which is the one where a silent fallback
    // has already cost a review round.
    var mat = null;
    var loud = !!this.wetEnabled;
    if (!DEFS[name]) {
      mat = this._debugMaterial('unknown material name "' + asked + '"' +
        (asked !== name ? ' (aliased to "' + name + '")' : ''), loud);
    }
    if (!mat) {
      try {
        mat = this._create(name, opts || null);
      } catch (e) {
        GAME.logError('materials.get:' + name, e);
        mat = this._debugMaterial('get("' + name + '") threw: ' +
          (e && e.message || e), loud) ||
          new THREE.MeshStandardMaterial({
            color: srgb((DEFS[name] && DEFS[name].color) || 0x8f8a80),
            roughness: 0.9, metalness: 0.0, envMapIntensity: 1.0
          });
      }
    }
    // A def that declares a texture recipe but comes back with no albedo map at
    // all is the same class of silent failure wearing different clothes: it
    // renders as a flat single-colour surface, which is item one on the quality
    // bar's instant-reject list, and nothing anywhere reports it.
    if (mat && !mat.map && !mat.userData.gbDebug) {
      var d = DEFS[name];
      if (d && (d.tex || d.texAlt || d.local || d.repeat)) {
        var alt = this._debugMaterial('material "' + name + '" resolved with NO albedo map' +
          ' (texture set failed; the surface would have rendered flat)', loud);
        if (alt) mat = alt;
      }
    }
    mat.name = key;
    this.cache[key] = mat;
    return mat;
  };

  /**
   * _debugMaterial(reason, loud) -> an unmistakable flat-magenta checker, or
   * null when `loud` is false (detection only - see get()).
   *
   * Emissive, deliberately. A magenta ALBEDO at two in the morning under a
   * sodium lamp is a dark plum smear that reads as "some prop I do not
   * recognise" - i.e. exactly as invisible as the grey it replaces. The whole
   * point of a debug material is that a human glancing at a contact sheet
   * cannot fail to see it, so it emits its own light and carries a checker so
   * it also cannot be mistaken for an emissive prop somebody meant to place.
   *
   * The reason goes to GAME.logError (which surfaces in the on-screen error
   * badge AND fails the capture in tools/shoot.py) and to this.missingNames, so
   * it is visible whether you are looking at the frame, the report or the
   * console. Every recorded reason is deduplicated - one bad name asked for a
   * hundred times is one error, not a hundred.
   */
  MaterialLibrary.prototype._debugMaterial = function (reason, loud) {
    try {
      if (!this.missingNames) this.missingNames = [];
      if (this.missingNames.indexOf(reason) < 0) {
        this.missingNames.push(reason);
        if (loud) GAME.logError('materials.MISSING', reason);
        try { console.error('materials: MISSING - ' + reason); } catch (e2) { /* no console */ }
      }
    } catch (e) { /* never throw out of get() */ }
    if (!loud) return null;
    if (this._debugMat) return this._debugMat.clone();
    var S = 32, px = new Uint8Array(S * S * 4), x, y, i;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        i = (y * S + x) * 4;
        var on = (((x >> 2) + (y >> 2)) & 1) === 0;
        px[i] = on ? 255 : 30; px[i + 1] = on ? 0 : 0; px[i + 2] = on ? 255 : 40;
        px[i + 3] = 255;
      }
    }
    var tex = new THREE.DataTexture(px, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    var m = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: tex, roughness: 0.85, metalness: 0.0,
      emissive: new THREE.Color(1, 0, 1), emissiveMap: tex, emissiveIntensity: 1.6,
      envMapIntensity: 0.0
    });
    m.userData.gbDebug = true;
    this._debugMat = m;
    return m.clone();
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
        // A SECOND DANGLING VALUE, found by the same audit as the missing-name
        // check. `sheenColor` is documented in DEFS and set on two entries, and
        // this line read opts only - so DEFS.tarpaulin's 0x9aa8a4 (a cold PVC
        // grey-green) had never once reached a material and every sheened
        // surface in the library wore the same warm 0xbfae94 canvas tint.
        // Honoured on the harbor path only: the market's laundry def also
        // carries a sheenColor, and level 1 is frozen byte-identical, so
        // reading it there would change a shipped frame.
        var shc = opts.sheenColor !== undefined ? opts.sheenColor
          : ((this.wetEnabled && def.sheenColor !== undefined) ? def.sheenColor : 0xbfae94);
        mat.sheenColor = srgb(shc);
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
    // COLD HARBOR: alpha-cut and coplanar flags carried on the DEF (and on the
    // texture set, see _maps) rather than restated at every call site. A fence
    // that is alpha TESTED writes depth, needs no sorting and still appears in
    // the shadow map - which is the whole reason a chain-link fence reads
    // through a lamp cone at all - and forgetting alphaTest at one of six call
    // sites is how it stops.
    else if (maps.alphaTest !== undefined) mat.alphaTest = maps.alphaTest;
    else if (def.alphaTest !== undefined) mat.alphaTest = def.alphaTest;
    if (def.poly && opts.polygonOffset === undefined) {
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = def.poly[0];
      mat.polygonOffsetUnits = def.poly[1];
    }
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

    // A flag anything downstream can select on without knowing this file's
    // internals - screen-space reflections in postfx, splash spawning in
    // weather.js, footstep audio picking a wet variant.
    if (F.wet) {
      try {
        mat.userData.gbWetSurface = true;
        mat.userData.gbPuddles = F.puddle > 0.01;
      } catch (e) { /* frozen userData */ }
    }

    return mat;
  };

  // Decide which shader features this material gets.
  MaterialLibrary.prototype._features = function (name, def, opts, maps, mat) {
    // ---- COLD HARBOR, resolved FIRST because it takes a sampler -------------
    var wetOn = (opts.wet !== undefined ? !!opts.wet : !!this.wetEnabled);
    // A surface only ponds if it is up-facing AND the def says water can lie on
    // it, and only a ponding surface pays for the ripple sampler. Defaults to
    // 0: a container flank must never grow a puddle because a noise field
    // happened to peak there.
    var puddleAmt = opts.puddle !== undefined ? opts.puddle
      : (def.puddle !== undefined ? def.puddle : 0);
    var ripOn = wetOn && puddleAmt > 0.01;

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
    //
    // ---- COLD HARBOR: SAMPLER BUDGET ---------------------------------------
    // `!ripOn` makes the ripple field a TRADE rather than an addition, so the
    // net fragment-sampler count across the level does not move.
    //
    // Why it is worth the trouble: MAX_TEXTURE_IMAGE_UNITS is 16 on the
    // software rasteriser tools/shoot.py runs on, a fully-featured material
    // here already binds eight (albedo, normal, the shared ORM through three
    // slots, the detail tile, this low-pass) before the environment map, and
    // every shadow-casting light in range costs one more. Blowing that limit
    // does not degrade gracefully - the program fails to LINK and the surface
    // vanishes. A stress scene with eight shadow-casting lamps produced eleven
    // link failures; disabling the lamps' shadows cleared all eleven, so the
    // measured failures were the SHADOW samplers, not this one - but they show
    // how little headroom there is, and a level built on mast lamps is going
    // to spend it.
    //
    // The low-pass is also the right thing to give up. It flattens large-scale
    // blotching in the ALBEDO, and these are precisely the surfaces whose
    // albedo is multiplied to 0.42 and then buried under a reflection, while
    // the triplanar domain warp is still breaking the lattice.
    var tileLP = null, stochFlat = 0;
    if (stochOn && !ripOn) {
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

    // ---- COLD HARBOR: wet surfaces -----------------------------------------
    // THE LEVEL-1 GATE, second half. `this.wetEnabled` is false for the market,
    // so wetOn is false, so not one line of the wet layer is emitted and the
    // program cache key below does not grow. opts.wet forces it either way for
    // anything that needs to opt out (a warehouse interior the rain never
    // reaches) or in (a hosed-down prop on a dry level).
    // Everything wet is derived from world position and world normal - which
    // way is up decides whether a surface ponds, streaks or merely darkens -
    // so it needs the world varyings.
    var worldOn = triOn || macroOn || groundOn || wdet || mesoOn || wetOn;

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

    // `maps.repeat` is only ever set when a def declared `texels` (harbor
    // triplanar surfaces), where the tiling was solved against the texture
    // library's ACTUAL tile size rather than assumed. It is undefined for every
    // market def, so this expression is exactly the old one there.
    var defRepeat = (maps && maps.repeat !== undefined) ? maps.repeat : (def.repeat || 0.5);
    var triScale = opts.triScale !== undefined ? opts.triScale : defRepeat;
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
    // COLD HARBOR: same one-for-one sampler trade as the stochastic path above.
    // The apron is triplanar, so this is the branch that actually fires for it.
    if (triOn && triFlat > 0.001 && maps.map && !ripOn) {
      triLP = this._tileLowpass(maps.map);
      if (!triLP) triFlat = 0;
    } else { triFlat = 0; }

    var detailKind = opts.detailKind || def.detailKind || 'mineral';

    // ---- LEVELS 3-10: base-normal texel-density LOD schedule ----------------
    // The schedule itself (gbNrmTexels -> gbNLod -> gbNrmW + gbLodVar) was
    // written for the harbor and gated on F.wet, which made a FILTERING
    // correction look like a weather feature. It is not one: it band-limits the
    // base normal map against the pixel footprint and hands the variance it
    // removes back as roughness (the Toksvig identity). Every hard surface in
    // the build wants it; only market and harbor are excluded, market because
    // it is frozen and harbor because F.wet already gives it the same block.
    //
    // Gated on the same set of features `_patch` gates nsExpr on, so the
    // uniform, the derivative pair and the log2 are only paid for by materials
    // that will actually consume gbNrmW.
    var lodNrmOn = !!(this.declarative && maps.normalMap && !wetOn &&
      (triOn || detailOn || pomOn || wearOn || stochOn));

    // ---- LEVELS 3-10: detail-tile texel-density schedule --------------------
    // The detail layer had a DISTANCE fade (9-26 m) and no density term at all,
    // which is the same mistake the base normal map made and it costs more,
    // because the detail tile is the highest-frequency thing in the file: a
    // 256-texel tile on a 5 cm period is 5120 texels per metre, so it is
    // already minified 15x at three metres while `gbDetailFade` still says 1.0.
    //
    // What that produces is NOT primarily a normal artefact - measured on the
    // bunker's beacon-lit dado, scaling gbDetailStrength from 1.0 to 0.35 moved
    // Laplacian energy 0.2032 -> 0.2009 (nothing), while disabling the layer
    // outright moved it to 0.1306 and cut isolated over-bright pixels from
    // 4.34% to 1.91%. The difference between those two experiments is the
    // CAVITY: gbDet.b multiplies albedo (x0.80-1.20), the AO term (x0.70-1.30)
    // and the specular occlusion, so at full weight the layer is a 2:1
    // multiplicative modulation of everything, at a spatial frequency the pixel
    // grid cannot carry. On a surface the alarm beacon is already only just
    // lifting off black, a 2:1 multiplier IS the burnt-cork crumble.
    //
    // So the schedule multiplies gbDetailFade, which every consumer of the
    // layer already reads - normal, albedo cavity, AO, spec-occ, micro
    // roughness and the polish crest all come down together, which is the only
    // way this can stay physically coherent - and the variance it removes comes
    // back as roughness on the same Toksvig identity the base map uses.
    var lodDetOn = !!(this.declarative && detailOn);

    // ---- LEVELS 3-10: grazing-footprint specular AA -------------------------
    // Widens the specAA near-field throttle by how stretched the pixel
    // footprint is on THIS surface rather than by view distance alone. See the
    // gbAAd block in _fragmentShader for why distance alone is the wrong
    // measure underground.
    var microAAOn = !!this.declarative;

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
      // The normal map's edge length in texels. Both sampling paths address it
      // in TILE units - the planar one through vNormalMapUv (three folds the
      // repeat into the uv transform) and the triplanar one through gbTP (world
      // position x tiles-per-metre, sampled with texture2D, which never sees
      // texture.repeat at all) - so one number serves both.
      nrmTexels: (maps.normalMap && maps.normalMap.image && maps.normalMap.image.width) || 512,
      // LEVELS 3-10. The base-normal LOD schedule, decoupled from the weather.
      // False on market and harbor, so neither emits a character it did not
      // already emit (harbor reaches the identical block through F.wet).
      lodNrm: lodNrmOn,
      // LEVELS 3-10. The detail tile's own texel-density schedule.
      lodDet: lodDetOn,
      // LEVELS 3-10. Grazing-angle term on the specAA distance ramp.
      microAA: microAAOn,
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
      isPhysical: !!mat.isMeshPhysicalMaterial,

      // ---- COLD HARBOR ----------------------------------------------------
      // All six default to a market-neutral value and are only READ when
      // F.wet is true, which it never is on level 1.
      wet: wetOn,
      wetDark: opts.wetDark !== undefined ? opts.wetDark
        : (def.wetDark !== undefined ? def.wetDark : 0.55),
      wetRough: opts.wetRough !== undefined ? opts.wetRough
        : (def.wetRough !== undefined ? def.wetRough : 0.11),
      wetAmt: opts.wetAmt !== undefined ? opts.wetAmt
        : (def.wetAmt !== undefined ? def.wetAmt : 1.0),
      wetFlat: opts.wetFlat !== undefined ? opts.wetFlat
        : (def.wetFlat !== undefined ? def.wetFlat : 0.34),
      puddle: puddleAmt,
      streak: opts.streak !== undefined ? opts.streak
        : (def.streak !== undefined ? def.streak : 0.8),
      // Ripples need somewhere to ripple: no puddle, no ripple. That keeps the
      // fetch - and the sampler - off every vertical surface in the yard.
      ripple: ripOn,
      water: !!opts.water
    };
  };

  // ==========================================================================
  // The onBeforeCompile patch
  // ==========================================================================
  MaterialLibrary.prototype._patch = function (mat, F) {
    var self = this;
    // Every wet term is derived from world position and world normal, so if a
    // caller has switched the world varyings back off after _features ran
    // (glass() and foliage() both rewrite F by hand) the wet layer would emit
    // references to varyings that do not exist and the material would fail to
    // link - taking the frame with it. Disable rather than break.
    if (F.wet && !F.world) { F.wet = false; F.ripple = false; }
    // Same defence for the two LEVELS 3-10 schedules. Both are pure filtering
    // corrections, so switching one off degrades the image slightly; emitting a
    // reference to a varying the caller has just disabled would fail to LINK
    // and take the whole surface with it.
    if (F.lodDet && (!F.detail || (F.worldDetail && !F.world))) F.lodDet = false;
    if (F.lodNrm && !F.hasNormalMap) F.lodNrm = false;
    var anyShader = F.world || F.triplanar || F.detail || F.macro || F.parallax ||
      F.wear || F.translucent || F.hasRoughMap || F.wind || F.stochastic ||
      F.grounding || F.specAA || F.polish || F.premulSpec || F.wet || F.water ||
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

    // ---- COLD HARBOR -------------------------------------------------------
    // gbWetG, gbWindW, gbRippleMap and gbWaveMap are the SHARED objects off the
    // library (exactly like gbTime), so setWetness() is one scalar write that
    // reaches every surface in the level with no iteration and no recompile.
    // gbWetM is per-material: it carries this surface's own physics.
    if (F.wet || F.water) {
      U.gbWetG = self._wetGlobal;                  // x = wetness, y = rain
      U.gbWindW = self._windW;                     // xy = dir, z = m/s
      if (F.ripple || F.water) {
        var rt = null;
        try { rt = self._ensureRipple(); } catch (e) { rt = null; }
        // Shared: _syncWeather can swap the bound texture and flip the decode
        // mode for the whole level in one write.
        U.gbRippleMap = self._rippleTex;
        if (!self._rippleTex.value) self._rippleTex.value = rt;
        U.gbRipCfg = self._ripCfg;
      }
    }
    if (F.wet) {
      // x = darken-to, y = roughness target, z = susceptibility, w = flatten
      U.gbWetM = {
        value: new THREE.Vector4(F.wetDark, F.wetRough, F.wetAmt, F.wetFlat)
      };
      // x = puddle amount, y = streak amount
      U.gbWetS = { value: new THREE.Vector2(F.puddle, F.streak) };
      // The material's authored envMapIntensity, which r180 throws away for any
      // material lit by scene.environment - see the gbEnvW block in
      // _fragmentShader. Registered so setEnvIntensity() can still drive it.
      U.gbEnvW = { value: mat.envMapIntensity };
      try {
        Object.defineProperty(mat.userData, 'gbEnvWU',
          { value: U.gbEnvW, enumerable: false, writable: true, configurable: true });
      } catch (e) { /* enumerable is still workable */ }
      // The normal map's own edge length in texels, so the shader can measure
      // the real texel:pixel ratio instead of standing in a distance smoothstep
      // for it. A distance ramp is wrong on every material whose repeat differs
      // from the one it was tuned against, which is all of them.
      if (F.hasNormalMap) U.gbNrmTexels = { value: F.nrmTexels };
    }
    // LEVELS 3-10: the same uniform, reached without the wet layer. F.lodNrm is
    // false whenever F.wet is true, so this never double-declares.
    if (F.lodNrm && F.hasNormalMap) U.gbNrmTexels = { value: F.nrmTexels };
    if (F.water) {
      var wt = null;
      try { wt = self._ensureWave(); } catch (e) { wt = null; }
      U.gbWaveMap = { value: wt };
      U.gbFoamSeg = self._foamSeg;
      U.gbFoamCount = self._foamCount;
      U.gbWaterDepth = { value: F.waterDepth };
      U.gbWaterBed = { value: srgb(F.waterBed) };
      U.gbWaterTint = { value: srgb(F.waterTint) };
      U.gbWaterAbsorb = { value: new THREE.Vector3(F.waterAbsorb[0], F.waterAbsorb[1], F.waterAbsorb[2]) };
      U.gbFoamColor = { value: srgb(F.foamColor) };
      U.gbFoamWidth = { value: F.foamWidth };
      U.gbWaveAmp = { value: F.waveAmp };
      // Planar reflection. All three are the SHARED library objects, so the
      // per-frame pass is three writes that reach every water surface at once.
      // The sampler is legitimately null until the first pass lands - three
      // binds its own empty texture for that, and gbReflCfg.x is 0 until then,
      // so the branch multiplies out to the environment-only look regardless.
      if (F.reflect) {
        try { self._reflectState(); } catch (eS) { /* objects already exist */ }
        U.gbReflMap = self._reflTex;
        U.gbReflMtx = self._reflMtx;
        U.gbReflCfg = self._reflCfg;
        U.gbReflCfg2 = self._reflCfg2;
      }
    }

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
    // COLD HARBOR. APPENDED, not joined in: adding two empty slots to the join
    // above would put two extra separators on the end of every market key.
    // Nothing would render differently, but every level-1 material would land
    // on a fresh program - which is exactly the kind of silent, invisible
    // change to a shipped level this level is not allowed to make.
    if (F.wet) {
      ck += '_Q' + (F.puddle > 0.01 ? 'p' : '') + (F.streak > 0.01 ? 's' : '') +
        (F.ripple ? 'r' : '');
    }
    // LEVELS 3-10, appended for exactly the reason above: adding slots to the
    // join would re-key every market material.
    if (F.lodNrm) ck += '_L';
    if (F.lodDet) ck += '_K';
    if (F.microAA && F.specAA) ck += '_N';
    if (F.water) ck += '_Z';
    // Appended to the water key, so the harbor's sea - which can never set
    // F.reflect - keeps the exact '_Z' it shipped with.
    if (F.reflect) ck += 'r';

    var obc = function (shader) {
      try {
        for (var k in U) shader.uniforms[k] = U[k];
        shader.vertexShader = self._vertexShader(shader.vertexShader, F);
        shader.fragmentShader = F.water
          ? self._waterShader(shader.fragmentShader, F)
          : self._fragmentShader(shader.fragmentShader, F);
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
      // LEVELS 3-10 only. gbDetW is the texel-density weight the detail layer
      // never had; gbDetVar is the variance it gives up, returned as roughness.
      if (F.lodDet) pars.push('float gbDetW = 1.0;', 'float gbDetVar = 0.0;');
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
    // ---- COLD HARBOR: wet surfaces ------------------------------------------
    // Nothing here is emitted on the market (F.wet is false), so level 1's
    // shader source is unchanged down to the character.
    if (F.wet) {
      pars.push('uniform vec2 gbWetG;',     // x = global wetness, y = rain
        'uniform vec4 gbWetM;',             // darkTo, roughTo, susceptibility, flatten
        'uniform vec2 gbWetS;',             // puddle amount, streak amount
        'uniform vec3 gbWindW;');           // wind dir.xy, speed
      pars.push('uniform float gbEnvW;');   // per-material env weight, see below
      pars.push('float gbWetT = 0.0;',      // final wetness at this fragment
        'float gbPud = 0.0;',               // standing-water coverage
        'float gbDamp = 0.0;',              // the darker ring OUTSIDE the water line
        'vec2 gbStrk = vec2( 0.0 );',       // x = rivulet mask, y = its gradient
        // FILM THICKNESS, 0 = a thin damp bloom the substrate still shows
        // through, 1 = a continuous sheet of water standing on it.
        //
        // Without this the whole wet layer had exactly ONE roughness - every
        // soaked fragment in the level was pulled to gbWetM.y (0.055 on the
        // apron) and the yard became a single uniform mirror. Two consequences,
        // both measured:
        //
        //   * there is no specular STRUCTURE. A punctual SpotLight can only
        //     light fragments inside its cone, so the mirror image of a lamp
        //     lands outside the pool and returns nothing (computed for the
        //     harbor rig: the mirror point sits at cone dot 0.66 against a
        //     coneCos of 0.87). At one uniform roughness the surface therefore
        //     shows no highlight anywhere - swapping the wet roughness target
        //     from 0.055 to 0.30 changed the rendered frame by 3/255 peak.
        //   * postfx's roughness-aware reflection blur has nothing to grade
        //     against: every wet texel asked for the same mip.
        //
        // A real yard is not uniformly sheeted. Water runs to the low ground,
        // so there is a continuum from barely-damp high spots through sheeted
        // hollows to standing water, and that continuum is what makes wet
        // ground read as wet rather than as painted black.
        // (This holds the SHAPED film gbWetSolve returns - 0 = damp bloom,
        // 1 = a continuous sheet - not the raw noise field behind it.)
        'float gbFilm = 0.5;',
        // this fragment's wet roughness target, solved from gbFilm
        'float gbWetR = 0.11;',
        // MICRO-TIER SURVIVAL, 1 = dry surface, 0 = fully drowned.
        //
        // This is the single most important number in the wet layer, and it is
        // not obvious why. A water film does two things at once: it makes the
        // surface glossy AND it fills the sub-millimetre relief. Do only the
        // first and you get a surface with a mirror's ROUGHNESS and a dry
        // surface's NORMALS - and under a point lamp that combination is not
        // "slightly wrong", it is a dense field of glitter, because every
        // micro-facet that happens to point at the lamp now returns a razor
        // specular lobe instead of a broad dull one. It looks exactly like
        // specular aliasing, so it invites exactly the wrong fix (more specAA,
        // which cannot touch it: the normals genuinely are that different).
        //
        // So gloss and relief come down TOGETHER, and only the micro tier goes
        // - the base map and the meso band stay, because a puddle of water is
        // not deep enough to level a 40 cm dish in a concrete slab.
        'float gbWetND = 1.0;',
        // Rivulet view-distance schedule. See G_STREAK.
        'float gbStrkW = 1.0;');
      pars.push(G_PUDDLE, G_WETSOLVE);
      if (F.streak > 0.01) pars.push(G_STREAK);
      if (F.ripple) {
        pars.push('uniform sampler2D gbRippleMap;', 'uniform vec4 gbRipCfg;');
        pars.push(G_RIPPLE);
      }
    }
    // ---- COLD HARBOR: the base normal map's LOD schedule --------------------
    // Every other layer in this file fades with distance. The BASE normal map
    // did not: `nsExpr` had no view-distance or texel-density term at all, so a
    // container flank at 60 m ran its corrugation at full strength with a
    // quarter of a texel per pixel. That is the rainbow-fringed vertical
    // barcode across the container stacks and the freighter hull - measured at a
    // 1.89 vertical/horizontal gradient ratio on the flanks against 1.0 for an
    // unstriped surface - and it is not a filtering problem: anisotropic
    // filtering deliberately keeps that detail sharp along the unstretched axis.
    //
    // The schedule is driven by the REAL texel:pixel ratio rather than by
    // gbViewDist, because that is scale-correct on every material regardless of
    // its repeat, which a distance smoothstep never is. Two halves, and both are
    // needed: the amplitude comes down (gbNrmW) AND the variance that was
    // removed goes back in as roughness (gbLodVar), which is the Toksvig
    // identity - normal variance is mathematically extra roughness. Take only
    // the first half and the surface goes flat and plastic; take only the second
    // and the barcode is still there, just duller.
    //
    // LEVELS 3-10. The block below is emitted for F.lodNrm as well, because the
    // schedule is a filtering correction and not a weather feature - a dry
    // refinery bund wall minified to a quarter of a texel per pixel shatters
    // into exactly the same per-pixel speckle a dry container flank did, and
    // for exactly the same reason. Measured on lv_hero3 before this was
    // decoupled: Laplacian energy 0.172 on the bund wall against 0.037 on the
    // level's own sky-grain floor, i.e. 4.6x, which reads as vermiculate
    // popcorn rather than as concrete. F.lodNrm is false whenever F.wet is
    // true, so the two never both fire and the emitted string is identical
    // either way - the harbor is untouched and the market never reaches here.
    if ((F.wet || F.lodNrm) && F.hasNormalMap) {
      pars.push('uniform float gbNrmTexels;',
        'float gbNLod = 0.0;',      // log2 texels per pixel, >= 0
        'float gbNrmW = 1.0;',      // base-normal amplitude schedule
        'float gbLodVar = 0.0;');   // the variance it gave up, as roughness^2
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
      // GB_WND is the micro-tier survival factor - empty on the market, so the
      // emitted line is `gbDetailStrength * gbDetailFade;` exactly as before.
      pars.push(G_TRI.replace('GB_TRI_DETAIL',
        F.detail ? G_TRI_DETAIL.replace('GB_WND', F.wet ? ' * gbWetND' : '') : ''));
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
    // ---- COLD HARBOR: texel:pixel ratio for the normal LOD schedule ---------
    // Measured in the units the map is actually sampled in, so it is correct on
    // the triplanar path (where the projection coordinate IS the uv) and on the
    // planar path (where three has already folded the repeat into vNormalMapUv)
    // without either having to know the other's scale.
    if ((F.wet || F.lodNrm) && F.hasNormalMap) {
      head.push('{');
      if (F.triplanar) {
        head.push('  vec3 gbNdX = dFdx( gbTP ) * gbNrmTexels;');
        head.push('  vec3 gbNdY = dFdy( gbTP ) * gbNrmTexels;');
        head.push('  float gbNm2 = max( dot( gbNdX, gbNdX ), dot( gbNdY, gbNdY ) );');
      } else {
        head.push('  float gbNm2 = 1.0;');
        head.push('  #ifdef USE_NORMALMAP');
        head.push('    vec2 gbNdX = dFdx( vNormalMapUv ) * gbNrmTexels;');
        head.push('    vec2 gbNdY = dFdy( vNormalMapUv ) * gbNrmTexels;');
        head.push('    gbNm2 = max( dot( gbNdX, gbNdX ), dot( gbNdY, gbNdY ) );');
        head.push('  #endif');
      }
      head.push('  gbNLod = max( 0.0, 0.5 * log2( max( gbNm2, 1e-8 ) ) );');
      // One free level: anisotropic filtering genuinely resolves ~2 texels per
      // pixel, so the ramp starts where the hardware stops helping.
      head.push('  float gbNo = max( gbNLod - 1.0, 0.0 );');
      head.push('  gbNrmW = 1.0 / ( 1.0 + gbNo * 0.62 );');
      head.push('  gbLodVar = ( 1.0 - gbNrmW ) * 0.085;');
      head.push('}');
    }
    // Rivulets: the only analytic high-frequency layer in the file that had no
    // schedule at all. Faded to a fifth rather than to zero, so a container
    // flank at 50 m still reads as running with water instead of stopping being
    // wet at a line the eye can find.
    if (F.wet && F.streak > 0.01) {
      head.push('gbStrkW = mix( 0.20, 1.0, 1.0 - smoothstep( 11.0, 32.0, gbViewDist ) );');
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
      var gbDUvExpr = F.worldDetail
        ? 'gbDetProj( gbWP, gbWN ) * gbDetailScale'
        : '( vNormalMapUv + gbUvShift ) * gbDetailTile';
      if (F.lodDet) {
        // LEVELS 3-10. Same measurement as the base map's schedule, in the
        // units this layer is actually addressed in. DETAIL_TEXELS is the tile
        // edge and is a build-time constant, not a uniform, because every
        // family tile is generated at the same size by _makeDetailNormal.
        head.push('{');
        head.push('  gbDet = texture2D( gbDetailNormal, ' + gbDUvExpr + ' );');
        // NOT dFdx of the detail UV. gbDetProj is a HARD axis select on the
        // world normal, so its screen-space derivative is meaningless wherever
        // the dominant axis flips and near-degenerate on any 45-degree face -
        // measured, that turned the schedule into a noise source in its own
        // right (refinery hero3 bund: Laplacian 0.158 -> 0.211 and isolated
        // over-bright pixels 0.028% -> 0.965%, i.e. the correction was worse
        // than the artefact). The world-space pixel footprint is the same
        // quantity, is continuous everywhere, and does not care which plane the
        // projection happens to have picked.
        head.push(F.worldDetail
          ? '  float gbDpx = max( length( dFdx( gbWP ) ), length( dFdy( gbWP ) ) ) * gbDetailScale;'
          : '  float gbDpx = max( length( dFdx( vNormalMapUv ) ), length( dFdy( vNormalMapUv ) ) ) * gbDetailTile;');
        head.push('  float gbDLod = max( 0.0, log2( max( gbDpx * ' +
          DETAIL_TEXELS.toFixed(1) + ', 1e-6 ) ) );');
        // One free level for anisotropic filtering, exactly as the base map's
        // schedule allows itself.
        head.push('  gbDetW = 1.0 / ( 1.0 + max( gbDLod - 1.0, 0.0 ) * 0.62 );');
        head.push('  gbDetVar = ( 1.0 - gbDetW ) * 0.085;');
        head.push('  gbDetailFade *= gbDetW;');
        head.push('}');
      } else {
        head.push('gbDet = texture2D( gbDetailNormal, ' + gbDUvExpr + ' );');
      }
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
      // LEVELS 3-10: the near tier runs the SAME tile at 1.55x the frequency,
      // so it is minified harder than the base tier at every distance and it
      // needs the same weight. gbDetW is already the base tier's, which is the
      // conservative choice - it under-corrects the near tier rather than over.
      head.push('gbDet2W = ( 1.0 - smoothstep( gbDet2Range.x, gbDet2Range.y, gbViewDist ) ) * gbDetailStrength' +
        (F.lodDet ? ' * gbDetW' : '') + ';');
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
    // Composed as one replacement so the wet layer can run immediately after
    // the wear layer and read its result. With F.wet off the emitted string is
    // character-for-character the one that shipped.
    var colorCode = [];
    if (F.wear) {
      colorCode.push(
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
        '#endif');
    }

    // ---- COLD HARBOR: soak, puddle, damp ring -------------------------------
    // Runs here, after color_fragment, because it is the first point where BOTH
    // the finished albedo and the per-vertex wetness channel exist - and
    // roughness, the normal and the BRDF inputs are all still downstream, so
    // one block can drive all four.
    if (F.wet) {
      // WHICH cavity biases the puddle field matters enormously, and getting it
      // wrong does not look like a puddle bug - it looks like a lighting bug.
      //
      // The obvious choice is the detail layer's cavity (gbDet.b). It is
      // wrong: that is a FIVE CENTIMETRE field, so it punches high-frequency
      // holes straight through the puddle MASK, and the mask drives both the
      // roughness collapse and the normal flattening. The result was a puddle
      // whose every other texel was and was not water - which under a sodium
      // lamp photographed as a dense field of orange glitter, indistinguishable
      // from specular aliasing and completely immune to the specAA term,
      // because the normals really were that different.
      //
      // The meso band is the right signal and it is already there: 0.1-0.6 m
      // is puddle scale by definition. With no meso layer, no bias - a smooth
      // basin field beats a sharp wrong one.
      var cavExpr = F.meso ? 'gbMes.b' : '0.5';
      var vwExpr = F.wear ? 'gbWet' : '0.0';
      colorCode.push(
        '{',
        '  float gbVW = ' + vwExpr + ';',
        '  float gbUp = clamp( gbWN.y, 0.0, 1.0 );',
        '  // Sky exposure proxy: a horizontal slab takes the whole downpour,',
        '  // a vertical flank only what the wind drives onto it, an overhang',
        '  // stays comparatively dry. Without this every face of a container',
        '  // soaks identically and the stack reads as dipped rather than',
        '  // rained on.',
        '  float gbExpo = mix( 0.42, 1.0, gbUp ) + clamp( - gbWN.y, 0.0, 1.0 ) * -0.22;',
        '  gbWetT = clamp( gbWetG.x * gbWetM.z * gbExpo + gbVW * 0.9, 0.0, 1.0 );',
        // ---- THE WET CONTRACT, evaluated once -------------------------------
        // Film thickness, the puddle mask, the damp collar and the wet roughness
        // target all come out of gbWetSolve - the one function this file
        // publishes as GAME.MaterialLibrary.WET_GLSL so postfx's SSR pass can
        // evaluate the identical field instead of guessing at one.
        //
        // `cav` is the surface's own 0.1-0.6 m cavity, and WHICH cavity matters
        // enormously: the 5 cm detail cavity punches high-frequency holes
        // straight through a mask that drives roughness AND normal flattening,
        // which under a sodium lamp photographs as a dense field of orange
        // glitter that no amount of specAA can touch.
        '  gbWetR = gbWetSolve( gbWP, gbUp, ' + cavExpr + ',',
        '      vec4( gbWetG.x, gbWetG.y, gbWetS.x, gbWetM.y ), gbPud, gbDamp, gbFilm );',
        '  // Anything the level painted as soaking is a puddle whatever the',
        '  // noise field says - the level knows where the drainage channels are.',
        '  gbPud = max( gbPud, smoothstep( 0.58, 0.96, gbVW ) * smoothstep( 0.62, 0.90, gbUp ) * step( 0.004, gbWetS.x ) );',
        '  gbWetT = max( gbWetT, gbPud );',
        // A RIVULET IS NOT A FRACTION OF WET, IT IS WATER.
        //
        // This used to scale linearly by gbWetT, and gbWetT on a vertical face
        // is only ~0.38 (gbExpo caps a flank at 0.42 of the downpour, which is
        // right for the average soak). So the one cue that makes a container
        // flank read as rained on rather than merely dark was running at a
        // third strength and did not survive into the frame at all. A rivulet
        // running down a flank is a continuous film of water whatever the wall
        // either side of it is doing; how wet the WALL is decides whether
        // rivulets exist, not how watery they are once they do. So gbWetT
        // becomes a PRESENCE gate rather than a linear scale.
        (F.streak > 0.01
          ? '  if ( gbWetT * gbWetS.y > 0.02 ) gbStrk = gbStreaks( gbWP, gbWN ) * ( 1.0 - gbUp )\n' +
            '      * smoothstep( 0.05, 0.40, gbWetT ) * gbWetS.y;'
          : '  gbStrk = vec2( 0.0 );'),
        // 0.24, not 0.42. A rivulet IS water, so it may push the fragment
        // toward soaked - but gbWetT drives the albedo multiplier gbWetM.x
        // (container enamel 0.66) as well as the normal flattening, so a 0.42
        // step on a flank whose base is ~0.38 took the run to gbWetT ~0.80 and
        // dropped its diffuse to 0.73 of the dry value BEFORE the roughness
        // collapse below did the rest. Darker, yes; a black bar, no.
        '  gbWetT = clamp( gbWetT + gbStrk.x * 0.24, 0.0, 1.0 );',
        // Non-linear on purpose. A damp surface keeps most of its micro-relief;
        // a soaked one has essentially none, because the film is thicker than
        // the relief. The exponent is what makes drizzle and downpour look
        // like different weather rather than two settings of one slider - and
        // it is what finally killed the glitter: measured on a 1280x720 frame
        // of the apron under two sodium lamps, isolated over-bright pixels went
        // from 5095 to under 300 with no loss of readable surface, because the
        // base map, the meso CAVITY and the parallax all survive untouched.
        // Only the sub-millimetre bump goes, and a sheet of water really does
        // take that away.
        // The film thickness gates it: a barely-damp high spot keeps most of
        // its relief, a sheeted hollow keeps none. Same physical argument as
        // the roughness spread, applied to the other half of the same event, so
        // gloss and relief still come down together per fragment rather than
        // together across the whole surface.
        '  float gbFilmS = gbFilm;',
        '  gbWetND = pow( 1.0 - clamp( gbWetT * gbWetM.w * mix( 0.52, 1.0, gbFilmS )',
        '        + gbPud * 0.85, 0.0, 1.0 ), 2.2 );',
        // ---- albedo ---------------------------------------------------------
        '  float gbDk = mix( 1.0, gbWetM.x, gbWetT );',
        '  gbDk *= mix( 1.0, 0.74, gbDamp );',
        '  gbDk = mix( gbDk, gbWetM.x * 0.66, gbPud );',
        // ...and the soak follows the film too. A surface whose water is a
        // bloom rather than a sheet has not filled its pores, so it has not
        // done the total-internal-reflection trick that darkens it - which is
        // the difference between wet ground with tonal range in it and wet
        // ground painted one flat black.
        '  gbDk = mix( mix( 1.0, gbDk, 0.55 ), gbDk, gbFilmS );',
        '  diffuseColor.rgb *= gbDk;',
        '  // A water film also SATURATES: light that would have scattered',
        '  // straight back out is bounced around inside the surface instead,',
        '  // so it comes back having been filtered by the pigment twice.',
        '  float gbWL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  diffuseColor.rgb = max( mix( vec3( gbWL ), diffuseColor.rgb, mix( 1.0, 1.18, gbWetT ) ), vec3( 0.0 ) );',
        '}');
    }
    if (colorCode.length) {
      src = src.replace('#include <color_fragment>',
        (F.wear ? '' : '#include <color_fragment>\n') + colorCode.join('\n'));
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
      // COLD HARBOR: and a surface UNDER WATER genuinely does share one gloss
      // value, because the gloss is the water's, not the substrate's - so the
      // micro-roughness scatter drowns with the micro-normal (see gbWetND).
      roughCode.push('roughnessFactor += ( gbDet.a - 0.5 ) * gbDetailRough * gbDetailFade' +
        (F.wet ? ' * gbWetND' : '') + ';');
    }
    if (F.detail2) {
      roughCode.push('roughnessFactor += ( gbDet2.a - 0.5 ) * gbDetailRough * 0.7 * gbDet2W' +
        (F.wet ? ' * gbWetND' : '') + ';');
    }
    if (F.meso) {
      roughCode.push('roughnessFactor += ( gbMes.a - 0.5 ) * 0.30 * clamp( gbMesoW, 0.0, 1.0 )' +
        (F.wet ? ' * mix( 0.45, 1.0, gbWetND )' : '') + ';');
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
      // COLD HARBOR: the burnish mask drowns too, and it is the worst offender
      // of the three. It is a HIGH-FREQUENCY crest mask that snaps its texels
      // to a hard gloss target, which is exactly right under a broad sun and
      // exactly wrong under a point lamp on a surface already at 0.05 - the
      // isolated burnished texels each return the lamp at full intensity and
      // the apron photographs as orange glitter. Water does not polish crests;
      // it covers them.
      roughCode.push('roughnessFactor = min( roughnessFactor, mix( roughnessFactor, ' +
        M.lerp(0.40, 0.10, M.saturate(F.polishAmount)).toFixed(3) + ', gbPolish' +
        (F.wet ? ' * gbWetND' : '') + ' ) );');
    }
    // COLD HARBOR. Last, and deliberately so: water is the most recent thing
    // to happen to this surface and it sits ON TOP of the dust, the burnish
    // and the grime. Three separate targets because they are three different
    // interfaces - a soaked surface, a rivulet, and standing water are not the
    // same optical event.
    if (F.wet) {
      // gbWetR, not gbWetM.y: the target varies per fragment with the film
      // thickness (see the gbFilm block above). The pull is also no longer
      // total - 0.88 rather than 0.96 - so the substrate's own roughness map
      // still modulates the result instead of being erased, which is what
      // keeps slab joints, rust patches and paint chips legible through the
      // water.
      roughCode.push('roughnessFactor = mix( roughnessFactor, gbWetR, gbWetT * 0.88 );');
      if (F.streak > 0.01) {
        // A RIVULET IS RUNNING WATER, NOT STANDING WATER, AND THE DIFFERENCE IS
        // THE WHOLE ARTEFACT. This was mix(..., 0.048, gbStrk.x * 0.85): a
        // near-total snap to a value BELOW the puddle target, on a VERTICAL
        // face, at 02:00. A mirror only shows you what is in the mirror
        // direction, and off the side of a container stack that is the black
        // sky - so every texel the rivulet touched went to near-zero and the
        // flank photographed as wide black bars over red enamel. (The bars were
        // the coverage bug in gbStreaks; the BLACK was this line.)
        //
        // Physically a run of water down a corrugated flank is agitated,
        // millimetres thick, and still shows the rib profile through it: it
        // lands around 0.10-0.16, not 0.048, and it modulates the substrate
        // rather than replacing it. So: the material's own solved wet target
        // with a floor, mixed at 0.55 rather than 0.85. The rivulet now reads
        // as a glossy run that CATCHES the sodium lamps - which is what makes a
        // flank look rained on - instead of as a hole in the container.
        roughCode.push('roughnessFactor = mix( roughnessFactor,' +
          ' max( gbWetR, 0.105 ), gbStrk.x * 0.55 );');
      }
      roughCode.push('roughnessFactor = mix( roughnessFactor, 0.030, gbPud );');
      // TOKSVIG. The other half of the normal LOD schedule: the sub-texel
      // variance gbNrmW just removed from the shading normal comes back as
      // roughness, because normal variance IS extra roughness. Without this the
      // schedule would only make the far field flat and plastic; with it, the
      // barcode on a 40 m container flank becomes the correctly dimmer, broader
      // sheen it should have been. Standing water is exempt: a puddle really is
      // a flat mirror at any distance, and this is what keeps the long lamp
      // smears from being blurred away by their own footprint.
      if (F.hasNormalMap) {
        roughCode.push('roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor +' +
          ' gbLodVar * ( 1.0 - gbPud ) ) );');
      }
    } else if (F.lodNrm && F.hasNormalMap) {
      // LEVELS 3-10, DRY. The other half of the schedule. Without it the far
      // field only goes flat and plastic; with it, the amplitude gbNrmW took
      // out of the shading normal comes back as the broader, dimmer specular
      // lobe it should have been in the first place. No puddle exemption on
      // this path because there is no standing water on it.
      roughCode.push('roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor +' +
        ' gbLodVar ) );');
    }
    // LEVELS 3-10. The detail tile's half of the same identity. Separate from
    // the block above because a material can have a detail layer and no normal
    // map (and vice versa), and because on a wet declarative level the branch
    // above is the wet one.
    if (F.lodDet && F.detail) {
      roughCode.push('roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor +' +
        ' gbDetVar ) );');
    }
    // 0.035 is the market's floor and stays the market's floor. Standing water
    // is genuinely smoother than that - clamping a puddle to 0.035 broadens
    // the lamp reflection into a smear, and "reflections that are just a blur"
    // is on the harbor instant-fail list - so the wet path gets a lower one.
    // Not much lower, though: below about 0.02 a point lamp's reflection is
    // narrower than a pixel and the puddle stops reflecting and starts
    // scintillating.
    roughCode.push('roughnessFactor = clamp( roughnessFactor, ' +
      (F.wet ? '0.022' : '0.035') + ', 1.0 );');
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
      // ---- LEVELS 3-10: the near-field throttle is not a distance problem ---
      // The throttle above assumes "near = fully resolved", which is true for
      // a wall the camera faces and false for every floor, dado and catwalk
      // grating it looks ALONG. At 75 degrees of incidence one pixel covers
      // four times the surface it covers head-on, so the map is minified in
      // one axis while gbViewDist still says "hero range" and the ceiling stays
      // pinned at 0.06 - which is how a 2 m concrete pit wall raked by a point
      // light ends up as isolated maxima of 0.771 sitting on a p50 of 0.042
      // with 62.9% of the lit region below L=0.05. That is not a surface, it is
      // glitter on tarmac, and underground there is no indirect term to fill
      // the gaps between the hits.
      //
      // So the ramp takes the WORSE of distance and footprint stretch. Squared,
      // because 1-|NoV| is already 0.29 at a perfectly ordinary 45 degrees and
      // only real raking should lift the ceiling. It is still multiplied by the
      // measured variance gbNv, so this cannot touch a surface whose normals
      // are smooth - a wet floor's long specular smear comes from the low-
      // variance texels and survives; the high-variance texels that were
      // sequins get the broader lobe they should always have had.
      if (F.microAA) {
        brdf.push('  float gbAAg = 1.0 - abs( dot( normal, normalize( vViewPosition ) ) );');
        brdf.push('  gbAAd = max( gbAAd, gbAAg * gbAAg );');
      }
      brdf.push('  vec3 gbNdx = dFdx( normal ), gbNdy = dFdy( normal );');
      brdf.push('  float gbNv = max( dot( gbNdx, gbNdx ), dot( gbNdy, gbNdy ) );');
      // COLD HARBOR. The near-field throttle above (0.28x strength, 0.06
      // ceiling below ~6 m) was tuned against a library whose materials sit at
      // roughness 0.3-0.95, where 0.06 of extra variance is nothing. A soaked
      // surface sits at 0.055, where it is everything: roughness enters the
      // GGX lobe as the fourth power, so the same normal noise that was
      // invisible on dry concrete becomes a strobe on wet concrete. Measured
      // on the apron under two sodium lamps, isolated over-bright pixels ran
      // 5095 against 44 on the identical DRY frame - and the cause is not one
      // layer, it is every layer at once, including the base map, which is why
      // damping the detail tiers alone only ever got it halfway.
      //
      // So the throttle is lifted in proportion to how mirror-like the
      // fragment actually is. This is the right lever precisely because it
      // does not care which layer the sub-pixel normal variance came from: it
      // measures the variance and widens the lobe by exactly that much, which
      // is the physically correct answer and also the only one that scales.
      //
      // Emitted as one swapped expression rather than an extra line, because
      // the market's source has to stay byte-identical, not merely equivalent.
      brdf.push('  material.roughness = min( 1.0, sqrt( material.roughness * material.roughness +');
      brdf.push(F.wet
        ? '    min( gbSpecAA * mix( mix( 0.28, 0.95, gbWetT ), 1.0, gbAAd ) * gbNv, mix( mix( 0.06, 0.30, gbWetT ), 0.36, gbAAd ) ) ) );'
        : '    min( gbSpecAA * mix( 0.28, 1.0, gbAAd ) * gbNv, mix( 0.06, 0.36, gbAAd ) ) ) );');
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
    // COLD HARBOR. The Fresnel half of wet. Roughness alone gets you a shinier
    // surface; what actually reads as water is that the grazing response goes
    // to unity, so a lamp forty metres up the quay lays a long specular streak
    // across the apron instead of a small local hotspot.
    //
    // Inside a puddle the reflecting interface is no longer the substrate at
    // all - it is a water surface, F0 = 0.02 - so specularColor is replaced
    // rather than nudged. Metals are excluded from that: a puddle ON steel
    // still reflects as water, but the steel's own tinted F0 has to survive
    // wherever the water is thin.
    if (F.wet) {
      brdf.push('material.specularF90 = mix( material.specularF90, 1.0, gbWetT );');
      brdf.push('material.specularColor = mix( material.specularColor, vec3( 0.021 ),' +
        ' max( gbPud, gbStrk.x * 0.6 ) * ( 1.0 - metalnessFactor ) );');
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
      // COLD HARBOR: the micro tier is what a water film levels. Applied to the
      // detail layers' STRENGTH rather than to the composed normal, so the base
      // map's plate seams and the meso band's 40 cm dishing survive being
      // rained on - which is what keeps a wet apron reading as a wet APRON
      // rather than as a sheet of black glass.
      var wnd = F.wet ? ' * gbWetND' : '';
      // ...but NOT the meso band. A water film a few tenths of a millimetre
      // thick cannot level a 40 cm dish in a slab, and this file's own comment
      // said so while the code drowned it anyway. It matters most exactly where
      // it showed worst: at a grazing view the metre-scale undulation is what
      // breaks a wet surface's reflection into the long wandering streaks that
      // sell it. Drown it and the near ground becomes one optically flat sheet
      // returning a smooth environment probe - measured at 0.57 mean on the
      // gangway apron against 0.13 before, a featureless white plane where the
      // art direction asks for a black mirror.
      var wndMeso = F.wet ? ' * mix( 0.45, 1.0, gbWetND )' : '';
      // ...and the BASE map gets the same treatment at a gentler exponent.
      //
      // This one was measured, not guessed, and it was the whole ball game.
      // Isolating the sources of the apron's glitter one at a time: with the
      // base normal scale forced to zero, over-bright isolated pixels dropped
      // from 4292 to 79 at unchanged mean luminance - i.e. the base map alone
      // was essentially all of it, and every amount of detail-tier damping and
      // specular antialiasing put together had been chipping at the margins.
      //
      // The reason is worth writing down, because the instinct is to reach for
      // specAA and specAA cannot fix it: the map IS mip-filtered, so adjacent
      // pixels sample nearly the same texel and the screen-space derivative
      // specAA measures UNDER-reports the true sub-pixel variance by a wide
      // margin. Mip filtering averages normal VECTORS, which is not the same
      // as averaging their specular response, and correcting that properly
      // needs the filtered normal's length (Toksvig) - which a normalised RGB
      // map does not carry, and which gbNrmW/gbLodVar reconstruct from the
      // texel:pixel ratio instead.
      //
      // mix( 0.26, 1.0, gbWetND ), not sqrt( gbWetND ) and not gbWetND.
      //
      // sqrt() left the base map at ~46% on a surface driven to roughness 0.055.
      // Roughness enters GGX to the FOURTH power, so that residual variance
      // shattered the lobe and the apron came out as a field of 1-2 px sequins
      // (measured: 1.20% isolated over-bright pixels on the warehouse floor
      // against an AAA bar of 0.1%). It is not only a sparkle problem - a
      // shattered lobe is a BROAD lobe away from its peak, which is exactly why
      // the sodium reflections died after a metre or two instead of running as
      // long coherent smears.
      //
      // Driving it all the way to gbWetND (~0.09 soaked) is the opposite error
      // and it was measured too: the warehouse floor went to a featureless
      // orange sheet at 0.40 mean, i.e. an optically flat mirror. It is not one,
      // because the film is only a few tenths of a millimetre thick. It levels
      // the sub-millimetre micro tier completely - that is what the detail
      // layers' own gbWetND gate does - but it cannot level the 2 mm to 10 cm
      // relief the BASE map carries: the slab joints, the float marks, the
      // corrugation ribs and the plate seams are all still there under the
      // water, refracted rather than reflected, at roughly a quarter amplitude.
      // So the base map keeps a floor of ~26% however hard it rains, which is
      // both the physical answer and the one that keeps a wet apron reading as
      // an apron instead of as a sheet of black glass.
      if (F.wet) nsExpr = '( ' + nsExpr + ' * mix( 0.26, 1.0, gbWetND ) * gbNrmW )';
      // LEVELS 3-10, DRY. Same schedule, without the water film's own levelling
      // factor - there is no film. `* gbNrmW` alone is the mip taper the base
      // map never had: at one texel per pixel it is exactly 1.0, so a hero-range
      // wall keeps every bit of the relief it has now, and it only starts to
      // bite past two texels per pixel where the map is genuinely under-sampled
      // and the amplitude is aliasing rather than describing anything. The
      // variance comes straight back as roughness below.
      else if (F.lodNrm) nsExpr = '( ' + nsExpr + ' * gbNrmW )';
      if (F.triplanar) {
        nrmCode.push('#ifdef USE_NORMALMAP_TANGENTSPACE');
        nrmCode.push('  vec3 gbNw = gbTriNormal( normalMap, gbTP, gbWN, gbTW, 1.0, ' + nsExpr + ' );');
        if (F.blend && F.blendNormal) {
          nrmCode.push('  gbNw = normalize( mix( gbNw,');
          nrmCode.push('    gbTriNormal( gbBlendNrm, gbBTP, gbWN, gbTW, 1.0, ' + nsExpr + ' ), gbBlendW ) );');
        }
        if (F.detail2) {
          nrmCode.push('  gbNw = gbMesoPerturb( gbNw, gbDetVec( gbDet2, gbDet2W * 0.55' + wnd + ' ) );');
        }
        if (F.meso) {
          // One world-space perturbation rather than three more triplanar
          // taps. The meso layer is isotropic low-amplitude noise, so an
          // arbitrary-but-continuous tangent frame is indistinguishable from
          // the projected one and costs a quarter as much.
          nrmCode.push('  gbNw = gbMesoPerturb( gbNw, gbDetVec( gbMes, 0.85 * clamp( gbMesoW, 0.0, 1.5 )' + wndMeso + ' ) );');
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
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbDet, gbDetailStrength * gbDetailFade' + wnd + ' ) );');
        }
        if (F.detail2) {
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbDet2, gbDet2W * 0.55' + wnd + ' ) );');
        }
        if (F.meso) {
          nrmCode.push('  mapN = gbBlendRNM( mapN, gbDetVec( gbMes, 0.85 * clamp( gbMesoW, 0.0, 1.5 )' + wndMeso + ' ) );');
        }
        nrmCode.push('  normal = normalize( tbn * mapN );');
        nrmCode.push('#endif');
      }
      src = src.replace('#include <normal_fragment_maps>', nrmCode.join('\n'));
    }

    // ---- COLD HARBOR: the wet shading normal --------------------------------
    // Runs on the FINISHED shading normal, whatever produced it - map, detail,
    // near tier, meso, triplanar or nothing at all - because water does not
    // care which layer authored the relief it is filling. That also means this
    // works on a material with no normal map, where the block above does not
    // run at all.
    //
    // The order is the physical order: the film fills the micro-relief, then
    // standing water replaces the surface outright, then the rain dimples that
    // water, then rivulets bend it on the way down.
    if (F.wet) {
      var wetNrm = ['{'];
      // viewMatrix is orthonormal, so v * M is M^T * v is the inverse rotation.
      wetNrm.push('  vec3 gbNwW = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );');
      // THE detail that separates wet from glossy. A water film is not a
      // varnish over the existing bumps: it PONDS in them, and the surface it
      // presents to the light is smoother in SHAPE as well as in gloss. Skip
      // this and a wet wall keeps every one of its dry micro-facets and reads
      // as a shiny dry wall, which is the single most common way this effect
      // is got wrong.
      // The pull on the COMPOSED normal, on top of gbWetND having already
      // drowned the detail tiers. The ceiling was 0.35, which is a 35% pull on
      // a surface the def declares 0.94 flattened - so nearly two thirds of the
      // dry micro-facet field survived onto a mirror. It is now gated by the
      // material's own wetFlat (gbWetM.w), which is what that field is FOR: the
      // apron and the quay slab go to ~0.9 and level out properly, while rope
      // (wetFlat 0.15) and chainlink (0.35) barely move, because a soaked rope
      // is not a mirror and getting that wrong is what makes wet weather read
      // as a varnish pass.
      wetNrm.push('  gbNwW = normalize( mix( gbNwW, gbWN, clamp( gbWetT * gbWetM.w * 0.62, 0.0, 1.0 ) ) );');
      wetNrm.push('  gbNwW = normalize( mix( gbNwW, gbWN, gbPud ) );');
      if (F.ripple) {
        // "Puddles that do not ripple in the rain" is an instant fail. Gated
        // on there being standing water AND rain, so the two-tap fetch is
        // skipped on every dry or vertical surface in the yard - and skipped
        // entirely once the storm passes.
        //
        // AMPLITUDE AND FADE, both learned the hard way. A rain ring is a
        // capillary wave a millimetre or so high across a ten-centimetre
        // radius: a few degrees of slope, not thirty. At the amplitude this
        // started on, every puddle inside a lamp pool became a field of
        // orange glitter - each pixel caught the lamp in a different mirror
        // direction, which is precisely the specular aliasing the specAA term
        // exists to kill and which no amount of specAA can kill once the
        // normal is swinging that far.
        //
        // And it FADES with distance, like every other high-frequency normal in
        // this file - but to a THIRD, not to nothing, and not by 24 m. "Puddles
        // that do not ripple in the rain" is an instant fail, and the old 9-24 m
        // ramp meant nothing in harbor_overview rippled at all: the establishing
        // shot of a terminal in a downpour had a dead-still ground plane. The
        // tile is mipmapped and the amplitude is a third out there, so what the
        // far field gets is a correct low-amplitude shimmer rather than either
        // aliasing or glass.
        wetNrm.push('  float gbRipA = gbPud * gbWetG.y' +
          ' * mix( 0.34, 1.0, 1.0 - smoothstep( 12.0, 30.0, gbViewDist ) )' +
          ' * ( 1.0 - smoothstep( 58.0, 95.0, gbViewDist ) );');
        wetNrm.push('  if ( gbRipA > 0.004 ) {');
        wetNrm.push('    vec2 gbR = gbRipples( gbWP.xz, gbRipA * 0.115 );');
        wetNrm.push('    gbNwW = normalize( gbNwW + vec3( gbR.x, 0.0, gbR.y ) );');
        wetNrm.push('  }');
      }
      if (F.streak > 0.01) {
        wetNrm.push('  if ( abs( gbStrk.y ) > 0.002 ) {');
        wetNrm.push('    vec3 gbTz = cross( vec3( 0.0, 1.0, 0.0 ), gbWN );');
        wetNrm.push('    float gbTl = length( gbTz );');
        wetNrm.push('    vec3 gbTt = gbTl > 1e-4 ? gbTz / gbTl : vec3( 1.0, 0.0, 0.0 );');
        // 0.26, not 0.16. The rivulet's cross-section is a lens a millimetre or
        // two proud on a surface that has otherwise been levelled to near-glass
        // by the film - at 0.16 its normal deviation was smaller than the
        // levelling it sits on top of, so it modulated nothing and the flank
        // photographed as flat dark metal. Still an order of magnitude below
        // the base map's own relief, so it bends the reflection rather than
        // replacing the surface.
        wetNrm.push('    gbNwW = normalize( gbNwW + gbTt * gbStrk.y * 0.26 );');
        wetNrm.push('  }');
      }
      wetNrm.push('  normal = normalize( ( viewMatrix * vec4( gbNwW, 0.0 ) ).xyz );');
      wetNrm.push('}');
      var wetNrmSrc = wetNrm.join('\n');
      if (src.indexOf('#include <normal_fragment_maps>') >= 0) {
        src = src.replace('#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n' + wetNrmSrc);
      } else {
        // The block above already consumed the include; append to its output.
        src = src.replace('#include <clearcoat_normal_fragment_begin>',
          wetNrmSrc + '\n#include <clearcoat_normal_fragment_begin>');
      }
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
    if (F.specOcc && (F.detail || F.grounding || F.hasNormalMap || F.wet)) {
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
      if (F.wet) {
        // COLD HARBOR. Every term above occludes the environment because the
        // SUBSTRATE cannot see the sky - dust settled in it, cavities, bumps
        // facing the wrong way. None of that is true of the water lying on
        // top: its surface is above all of it and sees the whole hemisphere.
        // Without this release the puddles inherit the concrete's occlusion
        // and the "black mirror" the level is built around never appears.
        so.push('  gbSO = mix( gbSO, 1.0, gbPud );');
        // And a modest lift across all wet surfaces: a smooth water interface
        // reflects the hemisphere the rough substrate underneath it was
        // scattering away. Deliberately small - this is a reflectivity
        // argument, not an exposure one.
        so.push('  gbSO *= mix( 1.0, 1.14, gbWetT );');
        // ---- envMapIntensity, put back ---------------------------------------
        // r180's WebGLRenderer.setProgram ends with:
        //
        //   if ( material.isMeshStandardMaterial && material.envMap === null &&
        //        scene.environment !== null )
        //     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
        //
        // i.e. as soon as a material takes its IBL from scene.environment - and
        // every material in this build does, sky.js owns the probe - the value
        // three actually uses is scene.environmentIntensity (1.0), and the
        // material's own envMapIntensity is discarded before the draw. Measured:
        // building the same material at envMapIntensity 0.0 and at 5.0 produced
        // byte-identical frames. So the whole `env` column of DEFS, and
        // setEnvIntensity(), have been inert.
        //
        // Restored HERE, on the harbor path only, because it is a real change
        // in output and level 1 is frozen: this block is already gated on
        // F.wet, so not one market program grows a character. It reaches only
        // the indirect specular, which is what `env` means for these surfaces -
        // the reefer's cold stainless (1.20) against soaked rope (0.85) - and
        // it leaves the indirect diffuse to scene.environmentIntensity, where
        // sky.js can still own the overall level of ambient fill.
        so.push('  gbSO *= gbEnvW;');
      }
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
  //
  // COLD HARBOR addition: `def.local` means "there is no market recipe that
  // stands in for this" (the two alpha-cut meshes and the sea). Those return
  // NULL, which routes _maps to this file's own generator instead of asking
  // textures.js for a name it may not implement - which would answer with
  // concrete AND push a missingRecipe entry into GAME.errors, i.e. into every
  // other agent's capture report, for a degradation we already planned for.
  //
  // The early-out on the first line is what keeps every market def byte-for-
  // byte unchanged: only `laundry` and `far_facade` carry texAlt, and no
  // market def carries `local`.
  MaterialLibrary.prototype._texName = function (def, name) {
    var want = def.tex || name;
    if (!def.texAlt && !def.local) return want;
    try {
      var tx = this.ctx && this.ctx.textures;
      var known = tx && tx.names && tx.names.indexOf ? tx.names.indexOf(want) >= 0 : false;
      if (!known && tx && typeof tx.has === 'function') known = !!tx.has(want);
      // A recipe generated before `names` was published still counts.
      if (!known && tx && tx.cache && tx.cache[want]) known = true;
      if (known) return want;
      return def.local ? null : def.texAlt;
    } catch (e) { return def.local ? null : def.texAlt; }
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

    // ---- COLD HARBOR: solve the tiling against the REAL tile size ----------
    // `def.texels` (harbor triplanar surfaces only) declares a target texel
    // density per world metre instead of a fixed tiles-per-metre. The texture
    // library's tile size tracks ITS quality preset - 1024 / 512 / 256 - so a
    // hard-coded repeat silently halves the apron's grain at 'medium' and
    // doubles it at 'ultra'. Probing the base set costs one cached call.
    //
    // On the triplanar path the texture's own repeat is never sampled through
    // (gbTriSample computes its uv from world position), so the tiling is
    // reported out to _features as the triScale and the texture is left at
    // 1,1 - which also saves the clone _prep would otherwise make.
    if (def.texels && opts.repeat === undefined && texName && tx &&
        typeof tx.get === 'function' && !this._texBroken) {
      try {
        var probe = tx.get(texName);
        var size = (probe && probe.size) ||
          (probe && probe.map && probe.map.image && probe.map.image.width) || 512;
        var tiles = M.clamp(def.texels / Math.max(size, 1), 0.02, 50);
        out.repeat = tiles;
        rep = def.tri ? [1, 1] : [tiles, tiles];
      } catch (e) { /* keep the def's static repeat */ }
    }

    if (texName === null) {
      // A surface with no market stand-in. Synthesise locally and never ask.
      set = this._fallbackSet(name);
    } else if (tx && typeof tx.get === 'function' && !this._texBroken) {
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

    // COLD HARBOR handshake. textures.js publishes `alphaTest` on any set whose
    // ALPHA is the material (the chain-link mesh, the walkway grating) - its
    // own comment is "these render as solid black squares without it". The
    // library that authored the coverage knows where its boundary sits far
    // better than a number typed into DEFS here does, so its hint outranks the
    // def; an explicit opts.alphaTest still outranks both.
    if (typeof set.alphaTest === 'number' && isFinite(set.alphaTest)) {
      out.alphaTest = set.alphaTest;
    }

    // COLD HARBOR: coverage-preserving alpha mips. Applied to the SOURCE
    // texture, before _prep possibly clones it, so every consumer of that image
    // gets the corrected chain (Texture.copy carries `mipmaps` by reference).
    if (def.alphaCov && set.map) {
      var at = out.alphaTest !== undefined ? out.alphaTest
        : (def.alphaTest !== undefined ? def.alphaTest : 0.5);
      try { this._alphaCoverageMips(set.map, at); }
      catch (e3) { GAME.logError('materials.alphaCoverage:' + name, e3); }
    }

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

  // --------------------------------------------------------------------------
  // Coverage-preserving alpha mipmaps (Castano, "Computing Alpha Mipmaps").
  //
  // An alpha-TESTED surface's mip chain is not a filtering detail, it is the
  // material. The driver builds each level with a box filter, so as the screen
  // footprint grows every level's alpha converges on the tile's MEAN - and then
  // alphaTest cuts that mean. Whichever side of the threshold the mean happens
  // to fall on, the result is wrong in one of two catastrophic ways: above it,
  // the mesh fills in and the perimeter fence becomes an opaque mat that blocks
  // the sightline it exists to let you shoot through AND casts a solid slab of
  // shadow through the sodium cone (which is exactly the "pools of light" read
  // the fence is there to protect); below it, the wire dissolves and the fence
  // disappears at 20 m.
  //
  // The fix is to rescale each level's alpha so the FRACTION OF TEXELS THAT
  // SURVIVE alphaTest matches level 0's. That is a monotone function of the
  // scale, so a 12-step binary search nails it to better than 0.1% coverage.
  // The chain is uploaded through texture.mipmaps with generateMipmaps off.
  //
  // Deliberately applied to the texture the library was handed rather than to a
  // clone: the correction belongs to the IMAGE, every material that samples that
  // image wants it, and Texture.copy() carries `mipmaps` across so the clones
  // _prep makes inherit it. Degrades to a no-op (and the driver's own chain) for
  // anything with no CPU-side data.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._alphaCoverageMips = function (tex, alphaTest) {
    if (!isTexture(tex)) return false;
    var img = tex.image;
    if (!img || !img.data || !img.data.BYTES_PER_ELEMENT) return false;
    var W = img.width | 0, H = img.height | 0;
    if (W < 4 || H < 4 || (W & (W - 1)) !== 0 || W !== H) return false;
    if (img.data.length < W * H * 4) return false;
    // Once per image, however many materials ask.
    if (tex.userData && tex.userData.__gbAlphaCov) return true;
    var thr = M.clamp(alphaTest !== undefined ? alphaTest : 0.5, 0.02, 0.98) * 255;

    function coverage(d, n, scale) {
      var c = 0;
      for (var i = 0; i < n; i++) if (d[i * 4 + 3] * scale >= thr) c++;
      return c / n;
    }

    var src = img.data;
    var n0 = W * H;
    var want = coverage(src, n0, 1.0);
    // A map whose level 0 is already nearly all-or-nothing has no coverage to
    // preserve, and rescaling it would only quantise.
    if (want < 0.002 || want > 0.998) return false;

    var levels = [{ data: src, width: W, height: H }];
    var cur = src, cw = W, ch = H;
    while (cw > 1 || ch > 1) {
      var nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
      var dst = new Uint8Array(nw * nh * 4);
      var x, y, c2, s, o0, o1, o2, o3, od;
      for (y = 0; y < nh; y++) {
        var y0 = Math.min(cw > 1 ? y * 2 : y, ch - 1);
        var y1 = Math.min(y0 + (ch > 1 ? 1 : 0), ch - 1);
        for (x = 0; x < nw; x++) {
          var x0 = Math.min(cw > 1 ? x * 2 : x, cw - 1);
          var x1 = Math.min(x0 + (cw > 1 ? 1 : 0), cw - 1);
          o0 = (y0 * cw + x0) * 4; o1 = (y0 * cw + x1) * 4;
          o2 = (y1 * cw + x0) * 4; o3 = (y1 * cw + x1) * 4;
          od = (y * nw + x) * 4;
          // COLOUR is averaged weighted by ALPHA. A plain box average pulls the
          // wire's colour toward whatever is painted in the transparent gaps,
          // which on a cut-out map is meaningless data - that is how an
          // alpha-tested mesh picks up a dark halo as it minifies.
          var a0 = cur[o0 + 3], a1 = cur[o1 + 3], a2 = cur[o2 + 3], a3 = cur[o3 + 3];
          var aw = a0 + a1 + a2 + a3;
          for (c2 = 0; c2 < 3; c2++) {
            dst[od + c2] = aw > 0
              ? ((cur[o0 + c2] * a0 + cur[o1 + c2] * a1 +
                  cur[o2 + c2] * a2 + cur[o3 + c2] * a3) / aw) | 0
              : ((cur[o0 + c2] + cur[o1 + c2] + cur[o2 + c2] + cur[o3 + c2]) * 0.25) | 0;
          }
          dst[od + 3] = ((a0 + a1 + a2 + a3) * 0.25) | 0;
        }
      }
      // Binary search the alpha scale that reproduces level 0's coverage.
      var lo = 0.0, hi = 12.0, mid = 1.0, nn = nw * nh, k;
      for (k = 0; k < 12; k++) {
        mid = (lo + hi) * 0.5;
        if (coverage(dst, nn, mid) < want) lo = mid; else hi = mid;
      }
      s = (lo + hi) * 0.5;
      if (s !== 1.0) {
        for (k = 0; k < nn; k++) {
          var v = dst[k * 4 + 3] * s;
          dst[k * 4 + 3] = v > 255 ? 255 : (v | 0);
        }
      }
      levels.push({ data: dst, width: nw, height: nh });
      cur = dst; cw = nw; ch = nh;
    }

    tex.mipmaps = levels;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (!tex.userData) tex.userData = {};
    tex.userData.__gbAlphaCov = true;
    tex.needsUpdate = true;
    return true;
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
    if (FALLBACK_CUT[name]) return this._genCutSet(name, FALLBACK_CUT[name]);
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
  // COLD HARBOR - locally generated surfaces
  //
  // Three things this level needs that no market recipe stands in for. All of
  // them are generated here rather than requested from textures.js: the alpha
  // channel IS the material for the two cut meshes, and the two animation
  // fields are consumed by this file's own shaders in a packing only this file
  // knows. Everything is deterministic (GAME.Noise + hashes, never
  // Math.random) so captures stay reproducible.
  // ==========================================================================

  // ---- alpha-cut meshes (chain-link, walkway grating) ----------------------
  // A solid fallback would turn the perimeter fence into a WALL and the crane
  // walkway into a plate, which changes the level's sightlines and its
  // silhouettes, not just its look. Both are authored as a height field of
  // round wire/bar sections so the normal map gives each strand a real
  // cylindrical shade, plus a coverage alpha that alphaTest cuts.
  MaterialLibrary.prototype._genCutSet = function (name, cut) {
    // 512, not 256. This is the one alpha-tested surface in the level that has
    // to survive both an extreme close-up (the player walks into the fence) and
    // 40 m, and a wire that is now a hundredth of a tile wide needs the texels
    // to exist before the coverage-preserving chain can preserve anything.
    var S = 512, n = S * S;
    var alb = new Uint8Array(n * 4);
    var rgh = new Uint8Array(n * 4);
    var hgt = new Float32Array(n);
    var base = new THREE.Color().setHex(cut.base, THREE.SRGBColorSpace);
    var tip = new THREE.Color().setHex(cut.tip, THREE.SRGBColorSpace);
    var bR = Math.round(Math.pow(base.r, 1 / 2.2) * 255);
    var bG = Math.round(Math.pow(base.g, 1 / 2.2) * 255);
    var bB = Math.round(Math.pow(base.b, 1 / 2.2) * 255);
    var tR = Math.round(Math.pow(tip.r, 1 / 2.2) * 255);
    var tG = Math.round(Math.pow(tip.g, 1 / 2.2) * 255);
    var tB = Math.round(Math.pow(tip.b, 1 / 2.2) * 255);
    var ph = hashString(name) % 64;

    // Round-section coverage: 1 at the bar centre, falling to 0 at its edge,
    // with the height of a half-cylinder so the Sobel gives a real barrel.
    function bar(d, w) {
      if (d >= w) return 0;
      var t = 1 - d / w;
      return Math.sqrt(Math.max(t * (2 - t), 0));   // half-circle profile
    }

    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var u = x / S, v = y / S;
        var cov = 0, hh = 0, wear = 0;

        if (cut.kind === 'diamond') {
          // Chain-link is two families of helically-woven wires running at
          // +-45 degrees. Doing it in rotated coordinates is what gives the
          // diamond aperture rather than a square grid.
          var a = (u + v) * cut.pitchU;
          var b = (u - v) * cut.pitchU;
          var da = Math.abs(a - Math.round(a)) / cut.pitchU;
          var db = Math.abs(b - Math.round(b)) / cut.pitchU;
          var ca = bar(da, cut.wire), cb = bar(db, cut.wire);
          // Over/under weave: whichever strand is proud here also occludes.
          var over = (Math.floor(a) + Math.floor(b)) & 1;
          hh = over ? ca * 0.9 + cb * 0.5 : cb * 0.9 + ca * 0.5;
          cov = Math.max(ca, cb);
          wear = Math.max(ca, cb);
        } else {
          // Bar grating: deep bearing bars one way, thin cross rods the other.
          var ub = u * cut.pitchU, vb = v * cut.pitchV;
          var du = Math.abs(ub - Math.round(ub)) / cut.pitchU;
          var dv = Math.abs(vb - Math.round(vb)) / cut.pitchV;
          var cu = bar(du, cut.wire);
          var cv = bar(dv, cut.wire * 0.62);
          hh = cu * 1.0 + cv * 0.45;
          cov = Math.max(cu, cv * 0.92);
          wear = cu;
        }

        // Galvanising is never even: pitting, zinc spangle and rust bloom.
        var mott = NOISE.fbm2(u * 12 + ph, v * 12 + ph, 4, 2, 0.55) * 0.5 + 0.5;
        var pit = NOISE.worley2(u * 40 + ph, v * 40 + ph, 1.0);
        var pitH = 1 - M.saturate(pit.f1 * 1.5);
        hh += (mott - 0.5) * 0.10 - pitH * 0.08;
        hgt[i] = M.saturate(hh);

        // Alpha is a hard-ish coverage so alphaTest cuts a clean wire edge,
        // with a couple of texels of feather to survive minification.
        var a8 = M.saturate((cov - 0.14) * 2.3) * 255;
        // The crest of a wire is rubbed bright; the shaded flank is dark.
        var k = M.saturate(wear * 0.85 + (mott - 0.5) * 0.5 - pitH * 0.35);
        alb[i * 4] = bR + (tR - bR) * k;
        alb[i * 4 + 1] = bG + (tG - bG) * k;
        alb[i * 4 + 2] = bB + (tB - bB) * k;
        alb[i * 4 + 3] = a8 | 0;

        // Zinc is satin on the crest and matte where it has weathered off.
        var r = M.saturate(0.34 + (1 - k) * 0.42 + pitH * 0.30);
        rgh[i * 4] = 255;
        rgh[i * 4 + 1] = Math.round(r * 255);
        rgh[i * 4 + 2] = Math.round(M.saturate(0.72 + k * 0.28) * 255);  // metalness
        rgh[i * 4 + 3] = 255;
      }
    }

    var nrm = heightToNormal(hgt, S, 3.2);
    var ao = heightToAO(hgt, S);
    var hTex = new Uint8Array(n * 4);
    for (var j = 0; j < n; j++) {
      var hv = Math.round(M.saturate(hgt[j]) * 255);
      hTex[j * 4] = hv; hTex[j * 4 + 1] = hv; hTex[j * 4 + 2] = hv; hTex[j * 4 + 3] = 255;
    }
    return {
      map: dataTex(alb, S, true),
      normalMap: dataTex(nrm, S, false),
      roughnessMap: dataTex(rgh, S, false),
      metalnessMap: dataTex(rgh, S, false),
      aoMap: dataTex(ao, S, false),
      displacementMap: dataTex(hTex, S, false),
      size: S, name: name
    };
  };

  // ---- rain-ripple field ---------------------------------------------------
  // A jittered-grid Voronoi of impact points, stored as
  //   R = normalised distance to this texel's impact centre (0 at it, 1 at the
  //       cell boundary)
  //   G = that impact's hashed birth phase
  //   BA = the unit radial direction, so the shader knows which way to tilt
  // The travelling ring is then evaluated ANALYTICALLY from (R, G) and the
  // clock, so one 256px tile animates forever: no flipbook, no per-frame CPU
  // work, and no upper bound on how long a capture can run.
  //
  // Distances are toroidal so the tile wraps seamlessly at any world scale.
  MaterialLibrary.prototype._ensureRipple = function () {
    if (this._ownRipple) {
      if (!this._rippleTex.value) this._rippleTex.value = this._ownRipple;
      return this._rippleTex.value;
    }
    var S = 256, CELLS = 6, n = S * S;
    var data = new Uint8Array(n * 4);
    var rng = new GAME.RNG(0x2A11B1E);            // 'RIPPLE'
    // One jittered impact per cell. Jitter is bounded to 0.34 of a cell so no
    // two impacts can land on top of each other and leave a bald patch.
    var px = new Float32Array(CELLS * CELLS), py = new Float32Array(CELLS * CELLS);
    var ba = new Float32Array(CELLS * CELLS);
    var ci, cj;
    for (cj = 0; cj < CELLS; cj++) {
      for (ci = 0; ci < CELLS; ci++) {
        var k = cj * CELLS + ci;
        px[k] = (ci + 0.5 + rng.range(-0.34, 0.34)) / CELLS;
        py[k] = (cj + 0.5 + rng.range(-0.34, 0.34)) / CELLS;
        ba[k] = rng.next();
      }
    }
    var half = 0.5;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x;
        var u = (x + 0.5) / S, v = (y + 0.5) / S;
        var best = 1e9, bdx = 1, bdy = 0, bk = 0;
        // Only the 3x3 neighbourhood can hold the nearest point.
        var gi = Math.floor(u * CELLS), gj = Math.floor(v * CELLS);
        for (var oj = -1; oj <= 1; oj++) {
          for (var oi = -1; oi <= 1; oi++) {
            var mi = ((gi + oi) % CELLS + CELLS) % CELLS;
            var mj = ((gj + oj) % CELLS + CELLS) % CELLS;
            var kk = mj * CELLS + mi;
            var dx = px[kk] - u, dy = py[kk] - v;
            if (dx > half) dx -= 1; else if (dx < -half) dx += 1;
            if (dy > half) dy -= 1; else if (dy < -half) dy += 1;
            var d2 = dx * dx + dy * dy;
            if (d2 < best) { best = d2; bdx = -dx; bdy = -dy; bk = kk; }
          }
        }
        var d = Math.sqrt(best);
        var il = d > 1e-6 ? 1 / d : 0;
        // Normalise against the cell radius so R spans 0..1 within a cell.
        var dn = M.saturate(d * CELLS * 1.05);
        var o = i * 4;
        data[o] = Math.round(dn * 255);
        data[o + 1] = Math.round(M.saturate(ba[bk]) * 255);
        data[o + 2] = Math.round(M.saturate(bdx * il * 0.5 + 0.5) * 255);
        data[o + 3] = Math.round(M.saturate(bdy * il * 0.5 + 0.5) * 255);
      }
    }
    // MIPMAPPED, and this is not a detail. The first version of this tile
    // disabled mips on the reasoning that averaging two neighbouring impacts'
    // DIRECTIONS gives mush - which is true, and completely beside the point.
    // The field is read on a surface whose roughness has just collapsed to
    // 0.05, so any un-mipped minification lands as per-pixel normal noise on a
    // mirror, and that is not mush, it is a field of glitter shaped exactly
    // like the puddles. Mush at distance is the correct answer: the ripple
    // amplitude is ramped to zero by 24 m anyway, and a smeared ring that
    // fades out beats a sharp ring that scintillates.
    var t = dataTex(data, S, false);
    t.userData = { __gbOwned: true, gbRipplePacked: true };
    this._ownRipple = t;
    if (!this._rippleTex.value) this._rippleTex.value = t;
    return this._rippleTex.value;
  };

  // ---- wave gradient field -------------------------------------------------
  // RG = surface SLOPE (dh/dx, dh/dy), B = height, A = a fine chop mask.
  //
  // Slopes rather than normals, because the sea shader sums three scrolled
  // taps of this one tile and summing normals loses amplitude on every layer
  // after the first - the slope of a sum IS the sum of the slopes, which is
  // both correct and one normalise cheaper.
  MaterialLibrary.prototype._ensureWave = function () {
    if (this._waveTex.value) return this._waveTex.value;
    var S = 256, n = S * S;
    var h = new Float32Array(n);
    var fine = new Float32Array(n);
    var x, y, i, u, v;
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        i = y * S + x;
        u = x / S; v = y / S;
        // Wind waves are ANISOTROPIC - long crests across the wind, short
        // period along it - so the lattice is stretched 1:3. An isotropic
        // field reads as a lake, not as a harbour in a storm.
        var swell = NOISE.fbm2(u * 3, v * 9, 4, 2.1, 0.55);
        var chop = NOISE.fbm2(u * 11 + 7, v * 26 + 3, 3, 2.0, 0.5);
        // Ridged noise makes the crests sharper than the troughs, which is
        // what a wind sea actually looks like and what catches a lamp.
        var crest = NOISE.ridged2(u * 6 + 13, v * 17 + 5, 2);
        h[i] = swell * 0.52 + chop * 0.26 + (crest - 0.5) * 0.30;
        fine[i] = M.saturate(0.5 + chop * 0.6);
      }
    }
    var data = new Uint8Array(n * 4);
    // Central differences on the wrapped field give the slope directly.
    for (y = 0; y < S; y++) {
      for (x = 0; x < S; x++) {
        i = y * S + x;
        var xm = (x - 1 + S) % S, xp = (x + 1) % S;
        var ym = (y - 1 + S) % S, yp = (y + 1) % S;
        var gx = (h[y * S + xp] - h[y * S + xm]) * 0.5 * S / 24;
        var gy = (h[yp * S + x] - h[ym * S + x]) * 0.5 * S / 24;
        var o = i * 4;
        data[o] = M.clamp((M.clamp(gx, -1, 1) * 0.5 + 0.5) * 255, 0, 255) | 0;
        data[o + 1] = M.clamp((M.clamp(gy, -1, 1) * 0.5 + 0.5) * 255, 0, 255) | 0;
        data[o + 2] = M.clamp((M.saturate(h[i] * 0.5 + 0.5)) * 255, 0, 255) | 0;
        data[o + 3] = M.clamp(fine[i] * 255, 0, 255) | 0;
      }
    }
    var t = dataTex(data, S, false);
    t.userData = { __gbOwned: true, gbWavePacked: true };
    this._waveTex.value = t;
    return t;
  };

  // ==========================================================================
  // COLD HARBOR - the sea
  // ==========================================================================

  /**
   * water(opts) -> THREE.Material for the harbour surface.
   *
   * Also what get('sea_water') returns, so the level can ask for it by the
   * same contracted name as the other sixteen surfaces.
   *
   * Four things have to be true at once or black water at night reads as a
   * black hole in the geometry:
   *
   *   WAVES        three scrolled taps of one gradient tile at ~9 m, ~2.2 m
   *                and ~0.6 m, running along the wind at different speeds
   *                (short waves are slower than long ones, so a single
   *                scrolled layer reads as a moving texture rather than as
   *                water). Summed as SLOPES, resolved to a normal once.
   *   ABSORPTION   Beer-Lambert down the actual view path through the column,
   *                not a flat depth tint: the path length is the depth over
   *                the view's zenith cosine, so looking straight down shows
   *                the harbour bed and looking along the water shows only
   *                what the surface reflects. Red is absorbed ~3x faster than
   *                blue-green, which is what puts the cyan-green of the
   *                palette into the water for free.
   *   FRESNEL      F0 = 0.02, F90 = 1.0. At 02:00 essentially the entire read
   *                is the grazing reflection of the mast lamps and the
   *                freighter's deck lights.
   *   FOAM         along the quay face and the hull waterline (see
   *                setWaterFoamEdges), plus drifting scum and wind-driven
   *                crest foam. Water butted cleanly against a wharf is the
   *                clearest possible tell that it is a plane.
   *
   * opts: depth, absorb [r,g,b] per metre, bed, tint, foam, foamWidth,
   *       waveAmp, roughness, envMapIntensity, side, edges.
   */
  MaterialLibrary.prototype.water = function (opts) {
    opts = opts || {};
    var key = 'water|' + hashOpts('', opts);
    if (this.cache[key]) return this.cache[key];

    var def = DEFS.sea_water;
    var maps;
    try { maps = this._maps('sea_water', def, {}); }
    catch (e) { maps = { map: null, normalMap: null, roughnessMap: null }; }

    var mat = new THREE.MeshStandardMaterial({
      // Near-black. Every bit of the visible value comes from the reflection
      // and from the in-scattered tint solved in the shader.
      color: srgb(opts.color !== undefined ? opts.color : 0x0a1015),
      // A flat sea is a mirror; the wave normals do the breaking up, so the
      // base roughness stays very low and the shader raises it with distance
      // (to stop the far water aliasing) and with foam.
      roughness: opts.roughness !== undefined ? opts.roughness : 0.035,
      metalness: 0.0,
      envMapIntensity: opts.envMapIntensity !== undefined ? opts.envMapIntensity : 1.5,
      side: opts.side !== undefined ? opts.side : THREE.FrontSide,
      // The sea is opaque in this build: there is nothing under it to see at
      // 02:00, and an opaque plane needs no sorting and no second pass.
      transparent: false,
      depthWrite: true
    });
    // A very low-weight albedo mottle off whatever sea_water map exists, so
    // the surface is not perfectly uniform where the reflection is weak. The
    // wave normals, not this, carry the movement.
    if (maps.map) { mat.map = maps.map; }

    if (opts.edges) this.setWaterFoamEdges(opts.edges);

    var F = this._features('sea_water', def, {
      water: true, wet: false, detail: false, macro: false,
      triplanar: false, parallax: false, meso: false, polish: false,
      grounding: false, specAA: false
    }, maps, mat);
    F.water = true;
    F.wet = false;
    F.world = true;
    F.triplanar = false;
    F.parallax = false;
    F.detail = false;
    F.detail2 = false;
    F.meso = false;
    F.macro = false;
    F.grounding = false;
    F.polish = false;
    F.stochastic = false;
    F.specAA = 0;
    F.specOcc = false;
    F.hasNormalMap = false;
    F.hasRoughMap = false;
    F.hasAoMap = false;
    F.hasMetalMap = false;
    F.hasMap = !!maps.map;
    F.waterDepth = opts.depth !== undefined ? opts.depth : 7.0;
    F.waterAbsorb = opts.absorb || [0.58, 0.19, 0.13];
    F.waterBed = opts.bed !== undefined ? opts.bed : 0x0b1214;
    F.waterTint = opts.tint !== undefined ? opts.tint : 0x14313a;
    F.foamColor = opts.foam !== undefined ? opts.foam : 0x9fb0b4;
    F.foamWidth = opts.foamWidth !== undefined ? opts.foamWidth : 1.5;
    F.waveAmp = opts.waveAmp !== undefined ? opts.waveAmp : 1.0;
    // THE PLANAR REFLECTION. Off for market and harbor by construction - see
    // _reflectWanted() - and off in the shader until the first reflection pass
    // has actually landed a frame in the target, so a failure anywhere in the
    // chain degrades to exactly the surface this function shipped with.
    F.reflect = false;
    if (this._reflectWanted(opts)) {
      try {
        this._reflectEnable(opts.reflect === true ? null : opts.reflect, opts);
        F.reflect = true;
      } catch (eR) { F.reflect = false; GAME.logError('materials.reflectInit', eR); }
    }
    this._patch(mat, F);

    mat.name = key;
    try {
      mat.userData.gbWetSurface = true;
      mat.userData.gbWater = true;
    } catch (e2) { /* frozen userData */ }
    this.cache[key] = mat;
    return mat;
  };

  // ==========================================================================
  // PLANAR WATER REFLECTION - opt-in, levels 3-10
  // ==========================================================================
  //
  // WHY THIS EXISTS. water() had exactly one reflection term: the PMREM
  // environment. An environment probe is a point sample of the sky taken at the
  // origin, so it carries no PARALLAX and no LOCAL geometry - a far bank, a
  // stand of mangrove roots, a helicopter wreck standing three metres out of
  // the river - and a river with no local reflection is a flat plate holding
  // one specular sun smear. Measured on the jungle's hero2 framing: 17.2% flat
  // area, the highest in the set, on the surface the level brief calls "water
  // that reflects".
  //
  // WHAT IT IS. One extra scene render per (interval) frames from a camera
  // mirrored about the water plane into a half-resolution HalfFloat target,
  // with Lengyel's oblique near plane pinned to the water surface so nothing
  // below the waterline leaks in. The result is mixed into `radiance` - the
  // environment's SPECULAR term - BEFORE the environment BRDF runs, so it picks
  // up water's own F0 = 0.02 / F90 = 1.0 Fresnel from the same code path the
  // envMap does and needs no Fresnel of its own.
  //
  // HOW IT IS COMBINED, which is the part that took three measurements to get
  // right and is NOT the obvious crossfade. The probe and the planar sample are
  // not interchangeable signals: the probe is uniformly bright, has no local
  // occlusion, and is sampled along the true mirror vector so the waves modulate
  // it hard. Swapping the planar sample in for it darkened the jungle river by
  // 2.5x AND flattened it, losing on the exact metric the pass was built to fix.
  // So by default the sample is applied as a STRUCTURE TRANSFER - its ratio to
  // its own local level modulates the radiance the level authored - with a
  // handover to its absolute value toward grazing incidence, where the interface
  // really is a mirror. See `graze` and the block in _waterShader.
  //
  // WHAT IT COSTS. One scene draw pass at `scale` of the backbuffer, every
  // `interval` frames, and only on frames where a water mesh is actually inside
  // the player camera's frustum. It is NOT free and it is not hidden: the pass
  // runs in update(), and main.js resets renderer.info at the top of render(), so
  // the capture report's draw/triangle figures do NOT include it. Budget it by
  // hand. The knobs that actually move the number are `interval` (2 halves it),
  // `far` (a shorter far plane culls the fogged-out background) and `exclude`.
  // `maxY` is there for completeness but think twice before culling a canopy
  // with it: on the jungle the reflected canopy IS the structure that fixed the
  // frame, and dropping it puts the flat bright plate straight back.
  //
  // THE GATE. Nothing here runs unless a water() caller asked for it:
  //   opts.reflect === false            hard off
  //   opts.reflect === true | {...}     hard on, with config
  //   env.waterReflect on the level def on/off without touching the level file
  //   otherwise                         on for DECLARATIVE levels only
  // market and harbor carry env: null, so this.declarative is false for both,
  // so neither can reach this code however water() is called. That is the same
  // marker every other levels-3-10 addition in this file hangs off.
  // --------------------------------------------------------------------------

  var REFLECT_DEFAULTS = {
    // Half res. The reflection is band-limited by the wave normal anyway and
    // the mix weight falls off with roughness, so the sharpness that a full-res
    // pass buys is not visible on water.
    scale: 0.5,
    // Frames between passes. 2 costs half as much and is invisible at 60 fps:
    // the texture matrix is stored WITH the target, so a stale reflection is
    // still projected from the camera that rendered it and stays geometrically
    // consistent - it lags in parallax, not in registration.
    interval: 2,
    // 0 = inherit the player camera's far plane.
    far: 0,
    // Objects whose world bounding box sits entirely above this Y are dropped
    // from the pass. Infinity = keep everything.
    maxY: Infinity,
    // Substrings matched against object.name, case-insensitive.
    exclude: null,
    // Master weight on the planar term, 0..1.
    strength: 1.0,
    // Linear gain on the sampled radiance. 1.0 = the reflection carries the
    // same energy the geometry did, which is the physical answer.
    gain: 1.0,
    // WAVE DISTORTION, as a multiplier on the physically-derived scale - 1.0
    // means "deflect the sample by exactly the angle the wave normal deflects
    // the reflected ray". It is not a UV constant any more, and it must not be:
    // a tilt of s radians turns the mirror ray by 2s, which covers
    // 2s/(2*tan(fov/2)) of the frame, so the correct UV offset depends on the
    // FOV and the aspect and is otherwise distance-INDEPENDENT. The first
    // version used a flat 0.045 UV per unit slope, which at this river's wave
    // amplitude worked out to about five pixels - so the planar sample carried
    // no wave modulation at all while the environment probe, sampled along the
    // true mirror vector, carried plenty. Crossfading to it therefore REMOVED
    // the ripple texture from the water: measured, the river's row standard
    // deviation fell at every depth and frame flat_area rose.
    distort: 1.0,
    // HOW THE PLANAR TERM IS WEIGHTED AGAINST THE PROBE. Measured, and the
    // measurement is the reason these four exist at all - see the note above
    // _waterShader's reflection block. A straight replace of the environment by
    // the planar sample costs more than it buys, because the two signals are
    // not interchangeable: the probe is a sky-only point sample, uniformly
    // bright, and every water body in this build has its colour tuned with that
    // brightness leaking in through the low-angle Fresnel. Swap it for the
    // canopy the mirror actually sees and the near river loses an order of
    // magnitude and crushes.
    //
    // So the reflection is applied as a STRUCTURE TRANSFER by default: the
    // sample's ratio to its own local level modulates the radiance the level
    // authored, which keeps the value and the ripple and adds the far bank, the
    // roots, the wreck and the canopy gaps.
    //
    // graze    0..1. How far to hand over to the sample's ABSOLUTE value toward
    //          grazing incidence, where the interface really is a mirror and the
    //          true brightness of the reflected world is the point. 0 keeps the
    //          authored level everywhere; 1 becomes a straight physical replace
    //          at glancing angles. Measured on the jungle river: 0.5 buys the
    //          far field real value range for a 14% drop in its mean.
    graze: 0.5,
    // The ramp exponent. This is an AUTHORED crossfade, not Schlick's 5 - the
    // Fresnel magnitude is already applied downstream by EnvironmentBRDF and
    // must not be applied twice. 2 was measured against 4 and 5 on the jungle's
    // river: the reflection of an object standing h above the water, seen from
    // eye height e at horizontal distance d, lands at d*e/(e+h) - so the wreck
    // 3 m up and 15 m out reflects only 5 m in front of the camera, at an
    // incidence where an exponent of 4 had already faded the term to a quarter.
    // The subjects a planar pass exists to show live much closer to the eye
    // than the geometry casting them.
    grazePow: 2.0,
    // Prefilter radius, in UV, at full roughness. A planar pass has one sharp
    // mip; without this the term has to be thrown away wherever the lobe has
    // widened, which is precisely the far field where the water is MOST
    // mirror-like. 0 disables the taps and restores the single sharp fetch.
    // 0.008 UV is about five texels of a half-res target - enough to stop the
    // sharp fetch crawling, not enough to dissolve the far bank it is there to
    // show. It was 0.020 for one measurement and that dissolved it.
    blur: 0.008,
    // Roughness at which the planar term is fully handed back to the (correctly
    // prefiltered) environment. The taps only stand in for a mip up to a point.
    roughFade: 0.85,
    // Explicit water plane height. null = measured off the meshes that carry a
    // gbWater material, which is what a level that never published one wants.
    y: null,
    // Below this height above the plane the eye is effectively in the water and
    // the mirror camera degenerates; the term fades out instead of exploding.
    minHeight: 0.25,
    // Lengyel's clip bias. Pulls the oblique near plane a hair back so the
    // waterline itself does not z-fight out of the reflection.
    clipBias: 0.0035
  };

  // Is a planar reflection wanted for this water() call? See the gate note
  // above. Kept as its own function so the answer is testable and so there is
  // exactly one place that decides.
  MaterialLibrary.prototype._reflectWanted = function (opts) {
    if (opts && opts.reflect !== undefined && opts.reflect !== null) return !!opts.reflect;
    var ldef = null;
    try { ldef = this.ctx && this.ctx.levelDef; } catch (e) { ldef = null; }
    var env = ldef && ldef.env;
    if (env && env.waterReflect !== undefined) return !!env.waterReflect;
    // Declarative levels (3-10) get it; market and harbor carry env: null and
    // can never reach this branch.
    return !!this.declarative;
  };

  // The shared uniform OBJECTS, exactly like _time and _wetGlobal: one set for
  // the whole library, so the per-frame pass is three writes that reach every
  // water surface with no iteration and no recompile.
  MaterialLibrary.prototype._reflectState = function () {
    if (!this._refl) {
      this._reflTex = { value: null };
      this._reflMtx = { value: new THREE.Matrix4() };
      // x = mix weight (0 until the first pass lands), y = distortion,
      // z = gain, w = grazing bias
      this._reflCfg = { value: new THREE.Vector4(0, 0.045, 1.0, REFLECT_DEFAULTS.graze) };
      // x = grazing exponent, y = prefilter radius in UV at full roughness,
      // z = roughness at which the term is handed back to the environment,
      // w = the target's height:width, so the prefilter disc is round in
      //     PIXELS rather than an ellipse stretched by the 16:9 aspect.
      this._reflCfg2 = {
        value: new THREE.Vector4(REFLECT_DEFAULTS.grazePow, REFLECT_DEFAULTS.blur,
          REFLECT_DEFAULTS.roughFade, 0.5625)
      };
      var cfg = {};
      for (var k in REFLECT_DEFAULTS) cfg[k] = REFLECT_DEFAULTS[k];
      this._refl = {
        on: false, cfg: cfg, rt: null, cam: null, w: 0, h: 0,
        planeY: null, frame: 0, hide: null, hideAge: 1e9, ready: false,
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        clip: new THREE.Vector4(), q: new THREE.Vector4(),
        mtx: new THREE.Matrix4(), v0: new THREE.Vector3(),
        v1: new THREE.Vector3(), box: new THREE.Box3(),
        size: new THREE.Vector2(), clear: new THREE.Color(0, 0, 0),
        prevClear: new THREE.Color(0, 0, 0)
      };
    }
    return this._refl;
  };

  MaterialLibrary.prototype._reflectEnable = function (conf) {
    var R = this._reflectState();
    R.on = true;
    this.setWaterReflection(conf);
    // NOTE: no waveAmp compensation. An earlier version divided the distortion
    // by waveAmp so a calm river and a wind sea got "the same visual wobble" -
    // which is only a sensible thing to want while the distortion is an
    // arbitrary UV constant. Now that it is the real ray deflection, waveAmp
    // already scales the slopes and compensating for it would be undoing the
    // level's own choice about how rough its water is.
    this._reflCfg.value.z = R.cfg.gain;
    return R;
  };

  /**
   * setWaterReflection(conf) -> the live config object.
   *
   * Re-tune the planar pass after the material exists. Every field is
   * optional; see REFLECT_DEFAULTS. Passing `false` switches the pass off and
   * drops the term out of the shader (the program is unchanged - it just
   * multiplies by zero), which is the safe way to A/B it or to shed the cost
   * on a low-quality tier.
   */
  MaterialLibrary.prototype.setWaterReflection = function (conf) {
    var R = this._reflectState();
    if (conf === false) {
      R.on = false;
      this._reflCfg.value.x = 0;
      return R.cfg;
    }
    if (conf === true) conf = null;
    if (conf) {
      for (var k in R.cfg) {
        if (conf[k] !== undefined && conf[k] !== null) R.cfg[k] = conf[k];
      }
      if (conf.y !== undefined) R.planeY = (conf.y === null ? null : conf.y);
    }
    R.cfg.scale = M.clamp(R.cfg.scale, 0.25, 1.0);
    R.cfg.interval = Math.max(1, Math.round(R.cfg.interval) || 1);
    R.cfg.strength = M.saturate(R.cfg.strength);
    R.cfg.gain = M.clamp(R.cfg.gain, 0.0, 4.0);
    R.cfg.distort = M.clamp(R.cfg.distort, 0.0, 3.0);
    R.cfg.graze = M.saturate(R.cfg.graze);
    R.cfg.grazePow = M.clamp(R.cfg.grazePow, 1.0, 12.0);
    R.cfg.blur = M.clamp(R.cfg.blur, 0.0, 0.08);
    R.cfg.roughFade = M.clamp(R.cfg.roughFade, 0.10, 1.0);
    if (R.cfg.y !== null && R.cfg.y !== undefined && isFinite(R.cfg.y)) R.planeY = R.cfg.y;
    // NOT .y - the distortion uniform carries distort/tan(fov/2) and only the
    // pass, which can see the camera, is in a position to write it.
    this._reflCfg.value.z = R.cfg.gain;
    this._reflCfg.value.w = R.cfg.graze;
    this._reflCfg2.value.x = R.cfg.grazePow;
    this._reflCfg2.value.y = R.cfg.blur;
    this._reflCfg2.value.z = R.cfg.roughFade;
    R.hideAge = 1e9;                 // re-scan: exclude/maxY may have changed
    return R.cfg;
  };

  // Where the water plane is. A level that publishes nothing still gets a
  // correct answer, because the material itself is the marker: every surface
  // water() built carries userData.gbWater, so the meshes wearing one ARE the
  // plane. The widest one wins - a level with a river and a puddle plate should
  // mirror about the river.
  MaterialLibrary.prototype._reflectFindPlaneY = function (scene) {
    var R = this._refl, best = null, bestArea = -1;
    if (!scene || !scene.traverse) return null;
    var box = R.box;
    scene.traverse(function (o) {
      if (!o || !o.isMesh || !o.visible || !o.geometry) return;
      var m = o.material;
      if (Array.isArray(m)) m = m[0];
      if (!m || !m.userData || !m.userData.gbWater) return;
      try {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      } catch (e) { return; }
      var a = (box.max.x - box.min.x) * (box.max.z - box.min.z);
      if (a > bestArea) { bestArea = a; best = box.max.y; }
    });
    return (best !== null && isFinite(best)) ? best : null;
  };

  // Everything the mirror camera must not draw. Rebuilt occasionally rather
  // than every frame: props and AI come and go, but a full scene traverse per
  // frame to find half a dozen objects is the kind of cost that hides in a
  // profile.
  MaterialLibrary.prototype._reflectHideList = function (scene) {
    var R = this._refl, cfg = R.cfg, out = [];
    // Collected in the same traverse: the water meshes themselves, so the pass
    // can ask whether any of them is on screen before paying for a scene render.
    var wm = R.wmesh = [];
    var ex = cfg.exclude;
    if (typeof ex === 'string') ex = [ex];
    var nEx = (ex && ex.length) || 0;
    var maxY = cfg.maxY;
    var useY = isFinite(maxY);
    var box = R.box;
    scene.traverse(function (o) {
      if (!o || !o.visible) return;
      // The water must not appear in its own reflection. The oblique clip
      // already cuts it, but a surface lying EXACTLY on the clip plane is the
      // one case that plane cannot decide.
      var m = o.material;
      if (Array.isArray(m)) m = m[0];
      if (m && m.userData && m.userData.gbWater) {
        out.push(o);
        if (o.isMesh && o.geometry) wm.push(o);
        return;
      }
      // The published opt-out, so any other module can keep something out of
      // the pass without this file knowing what levels contain.
      if (o.userData && o.userData.gbNoReflect) { out.push(o); return; }
      if (nEx && o.name) {
        var n = o.name.toLowerCase();
        for (var i = 0; i < nEx; i++) {
          if (n.indexOf(String(ex[i]).toLowerCase()) >= 0) { out.push(o); return; }
        }
      }
      if (useY && o.isMesh && o.geometry) {
        try {
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
          if (box.min.y > maxY) out.push(o);
        } catch (e) { /* unbounded geometry stays in */ }
      }
    });
    return out;
  };

  // Is any water mesh inside the player camera's frustum? Conservative by
  // construction - a world-space AABB always contains the geometry - so a false
  // NEGATIVE (a visible river skipped) is not reachable through a bad bound,
  // only through a bad matrix, and the matrix is the camera's own.
  MaterialLibrary.prototype._reflectWaterOnScreen = function (camera) {
    var R = this._refl, list = R.wmesh, i, o;
    if (!list || !list.length) return true;
    if (!R.frustum) { R.frustum = new THREE.Frustum(); R.fmtx = new THREE.Matrix4(); }
    R.fmtx.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    R.frustum.setFromProjectionMatrix(R.fmtx);
    for (i = 0; i < list.length; i++) {
      o = list[i];
      if (!o || !o.visible || !o.geometry) continue;
      try {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        R.box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
        if (R.frustum.intersectsBox(R.box)) return true;
      } catch (e) {
        return true;                 // unbounded geometry: assume it is in shot
      }
    }
    return false;
  };

  MaterialLibrary.prototype._reflectTarget = function (renderer) {
    var R = this._refl;
    renderer.getSize(R.size);
    var w = Math.max(64, Math.round(R.size.x * R.cfg.scale));
    var h = Math.max(64, Math.round(R.size.y * R.cfg.scale));
    if (R.rt && R.w === w && R.h === h) return R.rt;
    if (R.rt) { try { R.rt.dispose(); } catch (e) { /* already gone */ } }
    R.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      // HDR, per the render contract. The scene is rendered with tone mapping
      // OFF (postfx owns it), so an 8-bit target would clip every highlight in
      // the reflection to white and then hand that back as "radiance".
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false
    });
    // The target holds LINEAR radiance, not display-referred colour. Tagging it
    // sRGB would make three encode on write and this shader decode nothing.
    R.rt.texture.colorSpace = THREE.NoColorSpace;
    R.rt.texture.wrapS = R.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    R.rt.texture.name = 'gb_water_reflection';
    R.w = w; R.h = h;
    R.ready = false;
    this._reflTex.value = R.rt.texture;
    // The prefilter disc is authored as a radius in UV; without this it would be
    // 16:9 wider than it is tall and a rough reflection would smear sideways.
    this._reflCfg2.value.w = h / w;
    return R.rt;
  };

  MaterialLibrary.prototype._reflectRender = function (ctx) {
    var R = this._refl;
    if (!R || !R.on || !ctx) return;
    var renderer = ctx.renderer, scene = ctx.scene, camera = ctx.camera;
    if (!renderer || !scene || !camera || !camera.isPerspectiveCamera) return;

    R.frame++;
    camera.updateMatrixWorld();

    // The distortion is authored as a multiple of the true ray deflection, so
    // the projection scale that turns a normal tilt into a UV offset has to come
    // from the live camera, not from a constant. Written before the throttle
    // returns so a stale pass still projects with the current lens.
    var tanH = Math.tan(camera.fov * 0.5 * Math.PI / 180.0);
    this._reflCfg.value.y = R.cfg.distort / Math.max(0.05, tanH);

    // ---- where is the water? -----------------------------------------------
    if (R.planeY === null || !isFinite(R.planeY)) {
      R.planeY = this._reflectFindPlaneY(scene);
      // No water in the scene yet (the level may still be building). Leave the
      // term at zero and try again next frame - never guess a height.
      if (R.planeY === null) { this._reflCfg.value.x = 0; return; }
    }
    var h = R.planeY;
    var above = camera.position.y - h;
    // Eye at or under the surface: the mirror camera coincides with it and the
    // oblique projection degenerates. Fade out rather than divide by nothing.
    var hFade = M.saturate((above - R.cfg.minHeight * 0.5) / Math.max(1e-3, R.cfg.minHeight));
    if (hFade <= 0.0) { this._reflCfg.value.x = 0; return; }

    // ---- what not to draw, and is there anything to draw it FOR? -----------
    // Rebuilt occasionally rather than every frame: props and AI come and go,
    // but a full scene traverse per frame to find half a dozen objects is the
    // kind of cost that hides in a profile.
    R.hideAge++;
    if (!R.hide || R.hideAge > 30) { R.hide = this._reflectHideList(scene); R.hideAge = 0; }

    // A whole extra scene render is the most expensive possible way to change
    // nothing, and most framings of a level with a river in it do not have the
    // river in shot. The cost of this pass does NOT appear in the capture
    // report - main.js resets renderer.info at the top of render() and this runs
    // in update() - so on a level already at the draw ceiling it is the one part
    // of the feature nobody can see. Box test, not the bounding sphere three
    // uses: the sphere around a river plane is enormous and intersects the
    // frustum from halfway across the level.
    if (R.wmesh && R.wmesh.length && !this._reflectWaterOnScreen(camera)) {
      this._reflCfg.value.x = 0;
      return;
    }

    // ---- throttle ----------------------------------------------------------
    if (R.ready && R.cfg.interval > 1 && (R.frame % R.cfg.interval) !== 0) {
      this._reflCfg.value.x = R.cfg.strength * hFade;
      return;
    }

    var rt = this._reflectTarget(renderer);
    if (!rt) return;

    // ---- the mirror camera -------------------------------------------------
    // Reflect the eye and its look-at point through the plane, then negate the
    // reflected up vector. Position and target alone would give a left-handed
    // basis and a horizontally flipped image; the negate puts the handedness
    // back, which is why this is a plain lookAt camera and not a mirrored
    // matrix. Sampling is projective (see gbReflMtx), so a point above the
    // water lands on exactly the texel the reflected view ray reaches.
    var cam = R.cam;
    if (!cam) {
      cam = R.cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      cam.matrixAutoUpdate = true;
    }
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    cam.far = (R.cfg.far > 0) ? Math.min(R.cfg.far, camera.far) : camera.far;
    cam.zoom = camera.zoom;
    cam.filmOffset = camera.filmOffset;
    cam.updateProjectionMatrix();

    var lookAt = R.v0.set(0, 0, -1).applyQuaternion(camera.quaternion)
      .add(camera.position);
    var up = R.v1.set(0, 1, 0).applyQuaternion(camera.quaternion);
    cam.position.set(camera.position.x, 2 * h - camera.position.y, camera.position.z);
    cam.up.set(-up.x, up.y, -up.z);
    cam.lookAt(lookAt.x, 2 * h - lookAt.y, lookAt.z);
    cam.updateMatrixWorld(true);

    // ---- oblique near plane (Lengyel) --------------------------------------
    // Cheaper and far safer than renderer.clippingPlanes: a global clip plane
    // adds NUM_CLIPPING_PLANES to every material's program key in the scene, so
    // switching it on for one pass and off for the next compiles a second
    // variant of every shader in the level. This is four writes into the
    // projection matrix and nothing recompiles.
    R.plane.normal.set(0, 1, 0);
    R.plane.constant = -h;
    R.plane.applyMatrix4(cam.matrixWorldInverse);
    var cv = R.clip.set(R.plane.normal.x, R.plane.normal.y, R.plane.normal.z, R.plane.constant);
    var pe = cam.projectionMatrix.elements;
    var q = R.q;
    q.x = (sgn(cv.x) + pe[8]) / pe[0];
    q.y = (sgn(cv.y) + pe[9]) / pe[5];
    q.z = -1.0;
    q.w = (1.0 + pe[10]) / pe[14];
    var dq = cv.dot(q);
    if (Math.abs(dq) > 1e-6) {
      cv.multiplyScalar(2.0 / dq);
      pe[2] = cv.x;
      pe[6] = cv.y;
      pe[10] = cv.z + 1.0 - R.cfg.clipBias;
      pe[14] = cv.w;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    // ---- what not to draw --------------------------------------------------
    var hide = R.hide, i;
    for (i = 0; i < hide.length; i++) hide[i].visible = false;

    // ---- the sky dome ------------------------------------------------------
    // sky.js parks a UNIT sphere on the player's eye and reads its object-space
    // position as the view ray. From a camera a metre and a half the other side
    // of the water that sphere is entirely below the clip plane and the whole
    // reflection comes back with no sky in it at all. Moving it onto the mirror
    // camera keeps the view ray exact (the shader normalises object space) and
    // scaling it past the water plane keeps it in frame. Both restored below;
    // sky.update() rewrites the position every frame anyway but never the scale.
    var dome = null, domeS = 1;
    try {
      var sk = ctx.sky;
      if (sk && sk.mesh && sk.mesh.isMesh && sk.mesh.visible) dome = sk.mesh;
    } catch (e) { dome = null; }
    if (dome) {
      R.domePos = R.domePos || new THREE.Vector3();
      R.domeScale = R.domeScale || new THREE.Vector3();
      R.domePos.copy(dome.position);
      R.domeScale.copy(dome.scale);
      domeS = Math.max(4.0, cam.far * 0.45);
      dome.position.copy(cam.position);
      dome.scale.set(domeS, domeS, domeS);
    }

    // ---- render ------------------------------------------------------------
    var prevRT = renderer.getRenderTarget();
    var prevCube = renderer.getActiveCubeFace();
    var prevMip = renderer.getActiveMipmapLevel();
    var prevAutoClear = renderer.autoClear;
    var prevShadowAuto = renderer.shadowMap ? renderer.shadowMap.autoUpdate : true;
    var prevXr = (renderer.xr && renderer.xr.enabled) || false;
    var prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(R.prevClear);
    // The fog colour, not black: the only pixels that can survive the oblique
    // clip with nothing drawn on them are below the water's own horizon line,
    // and a wave distortion that nudges a far sample across that line should
    // pick up haze, not a black scar along the waterline.
    if (scene.fog && scene.fog.color) R.clear.copy(scene.fog.color);
    else R.clear.setRGB(0, 0, 0);

    try {
      if (renderer.xr) renderer.xr.enabled = false;
      // Reuse last frame's shadow maps. Re-rendering every cascade for a
      // half-res reflection doubles the shadow cost for a difference nothing
      // in the frame can resolve.
      if (renderer.shadowMap) renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(R.clear, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, cam);
      R.ready = true;
    } finally {
      renderer.setClearColor(R.prevClear, prevAlpha);
      renderer.setRenderTarget(prevRT, prevCube, prevMip);
      renderer.autoClear = prevAutoClear;
      if (renderer.shadowMap) renderer.shadowMap.autoUpdate = prevShadowAuto;
      if (renderer.xr) renderer.xr.enabled = prevXr;
      if (dome) { dome.position.copy(R.domePos); dome.scale.copy(R.domeScale); }
      for (i = 0; i < hide.length; i++) hide[i].visible = true;
    }

    // ---- publish -----------------------------------------------------------
    // world -> the mirror camera's clip space -> [0,1] texture space, stored
    // WITH the frame it belongs to. A stale target sampled through its own
    // matrix is still registered correctly; sampling it through the current
    // camera's matrix is what makes lagged planar reflections slide.
    R.mtx.set(0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0);
    R.mtx.multiply(cam.projectionMatrix);
    R.mtx.multiply(cam.matrixWorldInverse);
    this._reflMtx.value.copy(R.mtx);
    this._reflTex.value = rt.texture;
    this._reflCfg.value.x = R.cfg.strength * hFade;
    this._reflCfg.value.z = R.cfg.gain;
  };

  function sgn(x) { return x < 0 ? -1 : (x > 0 ? 1 : 0); }

  // --------------------------------------------------------------------------
  // The sea's fragment shader. Kept separate from _fragmentShader rather than
  // bolted into it: the sea shares none of that function's twenty features and
  // folding it in would have added a `water` branch to every one of them.
  // --------------------------------------------------------------------------
  MaterialLibrary.prototype._waterShader = function (src, F) {
    var pars = [];
    pars.push('uniform float gbTime;');
    pars.push('uniform vec2 gbFadeRange;');
    pars.push('uniform vec2 gbWetG;');
    pars.push('uniform vec3 gbWindW;');
    pars.push('uniform sampler2D gbWaveMap;');
    pars.push('uniform sampler2D gbRippleMap;');
    pars.push('uniform vec4 gbRipCfg;');
    pars.push('uniform vec4 gbFoamSeg[ ' + FOAM_MAX + ' ];');
    pars.push('uniform int gbFoamCount;');
    pars.push('uniform float gbWaterDepth;');
    pars.push('uniform vec3 gbWaterBed;');
    pars.push('uniform vec3 gbWaterTint;');
    pars.push('uniform vec3 gbWaterAbsorb;');
    pars.push('uniform vec3 gbFoamColor;');
    pars.push('uniform float gbFoamWidth;');
    pars.push('uniform float gbWaveAmp;');
    pars.push('#define GB_FOAM_MAX ' + FOAM_MAX);
    pars.push('float gbFoam = 0.0;');
    pars.push('float gbWDist = 0.0;');
    if (F.reflect) {
      pars.push('uniform sampler2D gbReflMap;');
      pars.push('uniform mat4 gbReflMtx;');
      // x = mix weight, y = distortion in UV per unit slope, z = gain,
      // w = grazing bias
      pars.push('uniform vec4 gbReflCfg;');
      // x = grazing exponent, y = prefilter radius, z = rough hand-back,
      // w = target height:width
      pars.push('uniform vec4 gbReflCfg2;');
      // Every fetch of the reflection goes through here. A tap that walks off
      // the target reads the edge texel rather than wrapping to the far side of
      // the frame, which would put a mirrored strip of the opposite bank into
      // the river.
      pars.push('vec3 gbReflTap( vec2 uv ) {');
      pars.push('  return texture2D( gbReflMap, clamp( uv, vec2( 0.0015 ), vec2( 0.9985 ) ) ).rgb;');
      pars.push('}');
      // The roughness BEFORE the geometric specular-AA variance term is folded
      // in. The reflection prefilter has to be driven off this and not off the
      // final roughness: the variance term is an ANTIALIASING device that
      // reports how fast the normal is changing per pixel, and it legitimately
      // pushes the sea past 0.5 in the crawling band. Feeding that into a blur
      // radius double-counts it - measured, it drove most of the river to the
      // maximum tap radius and washed the reflection into a flat dark smear,
      // which subtracted value without adding any structure at all.
      pars.push('float gbRough0 = 0.05;');
    }
    pars.push(G_COMMON);
    pars.push(G_WAVE);
    pars.push(G_RIPPLE);
    pars.push(G_FOAMEDGE);

    // ---- head ---------------------------------------------------------------
    var head = [];
    head.push('gbWDist = length( vViewPosition );');
    head.push('vec3 gbWP = vGbWorld;');
    head.push('vec2 gbWXZ = gbWP.xz;');
    head.push('vec2 gbFlowD = normalize( gbWindW.xy + vec2( 1e-4, 1e-4 ) );');
    head.push('float gbWindK = clamp( gbWindW.z / 14.0, 0.20, 1.6 );');
    // Distance to the nearest quay/hull edge, and the foam mask built on it.
    head.push('float gbEd = gbEdgeDist( gbWXZ );');
    head.push('float gbFoamE = smoothstep( gbFoamWidth, 0.0, gbEd );');
    // Broken up so the band is never a clean offset curve, and drifting so it
    // is never static.
    head.push('gbFoamE *= smoothstep( 0.22, 0.78, gbValue3( vec3( gbWXZ * 1.6, gbTime * 0.22 ) ) + 0.32 );');
    // Scum and spilled diesel drifting downwind. This is a working terminal.
    head.push('float gbScum = smoothstep( 0.60, 0.90, gbValue3( vec3( gbWXZ * 0.22 - gbFlowD * ( gbTime * 0.018 ), 0.0 ) ) );');
    head.push('gbFoam = clamp( gbFoamE + gbScum * 0.30, 0.0, 1.0 );');
    src = src.replace('#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n' + head.join('\n'));

    // ---- albedo: depth absorption + foam ------------------------------------
    var mapCode = [];
    mapCode.push('{');
    // BEER-LAMBERT DOWN THE VIEW PATH. Not a depth tint: the light that comes
    // back out has crossed the column twice at whatever angle the eye is
    // looking, so the path is the depth over the zenith cosine. Straight down
    // shows the bed; along the surface shows only what is reflected.
    mapCode.push('  vec3 gbVw = normalize( cameraPosition - gbWP );');
    mapCode.push('  float gbCosT = clamp( abs( gbVw.y ), 0.07, 1.0 );');
    // Shoaling: the water is shallower where it meets the wharf, which is
    // exactly where the eye can tell the difference.
    mapCode.push('  float gbShoal = mix( 0.30, 1.0, smoothstep( 0.0, gbFoamWidth * 5.0, gbEd ) );');
    mapCode.push('  float gbPath = ( gbWaterDepth * gbShoal ) / gbCosT;');
    mapCode.push('  vec3 gbAbs = exp( - gbWaterAbsorb * gbPath );');
    // Bed seen through the column, plus what the column itself scatters back.
    mapCode.push('  vec3 gbBody = gbWaterBed * gbAbs + gbWaterTint * ( 1.0 - gbAbs );');
    if (F.hasMap) {
      // A whisper of the library's own sea map so the body is not perfectly
      // uniform where the reflection falls away.
      mapCode.push('  vec4 gbSm = texture2D( map, gbWXZ * 0.06 );');
      mapCode.push('  gbBody *= 0.80 + 0.40 * dot( gbSm.rgb, vec3( 0.3333 ) );');
    }
    mapCode.push('  diffuseColor.rgb = gbBody;');
    mapCode.push('  diffuseColor.rgb = mix( diffuseColor.rgb, gbFoamColor * 0.55, gbFoam );');
    mapCode.push('}');
    src = src.replace('#include <map_fragment>', mapCode.join('\n'));

    // ---- roughness ----------------------------------------------------------
    var roughCode = ['float roughnessFactor = roughness;'];
    // Foam is a mass of bubbles: the one genuinely rough thing on the surface.
    roughCode.push('roughnessFactor = mix( roughnessFactor, 0.78, gbFoam );');
    // FAR-FIELD ROUGHENING, on top of the variance term above. The two attack
    // the same problem from different ends: the variance term is exact but can
    // only see what the screen-space derivative reports, which under heavy
    // minification under-reports badly. A distance floor covers the rest. It
    // starts at 12 m rather than 35 - measured on a low camera at the quay
    // edge, the crawling starts well inside 20 m because the view is grazing
    // and one pixel covers metres of water long before it covers metres of
    // ground.
    roughCode.push('roughnessFactor = max( roughnessFactor, smoothstep( 12.0, 90.0, gbWDist ) * 0.30 );');
    roughCode.push('roughnessFactor = clamp( roughnessFactor, 0.020, 1.0 );');
    src = src.replace('#include <roughnessmap_fragment>', roughCode.join('\n'));

    // ---- wave normals -------------------------------------------------------
    var nrm = [];
    nrm.push('{');
    // Three scales, three speeds, three directions. Long waves run fastest
    // along the wind, the chop crosses it, the ripple detail crawls - one
    // scrolled layer at one speed reads as a sliding texture, not as water.
    nrm.push('  vec2 gbSlope = vec2( 0.0 );');
    nrm.push('  gbSlope += gbWaveG( gbWXZ, gbFlowD * ( gbTime * 0.016 ), 0.11, 1.00 * gbWaveAmp * gbWindK );');
    nrm.push('  gbSlope += gbWaveG( gbWXZ, vec2( - gbFlowD.y, gbFlowD.x ) * ( gbTime * 0.030 ), 0.46, 0.62 * gbWaveAmp * gbWindK );');
    nrm.push('  gbSlope += gbWaveG( gbWXZ, gbFlowD * ( gbTime * 0.075 ), 1.55, 0.34 * gbWaveAmp * gbWindK );');
    // Rain dimpling the sea. The same field the puddles use, so the two agree.
    nrm.push('  vec2 gbRr = gbRipples( gbWXZ, gbWetG.y * 0.45 );');
    nrm.push('  gbSlope += gbRr * 2.4;');
    // Foam is a bubble raft: it flattens the wave shape under it.
    nrm.push('  gbSlope *= mix( 1.0, 0.40, gbFoam );');
    nrm.push('  vec3 gbNwW = normalize( vec3( - gbSlope.x, 1.0, - gbSlope.y ) );');
    nrm.push('  normal = normalize( ( viewMatrix * vec4( gbNwW, 0.0 ) ).xyz );');
    nrm.push('}');
    src = src.replace('#include <normal_fragment_maps>',
      '#include <normal_fragment_maps>\n' + nrm.join('\n'));

    // ---- Fresnel ------------------------------------------------------------
    var brdf = [];
    // GEOMETRIC SPECULAR ANTIALIASING, and the sea needs it more than anything
    // else in the build. It is the smoothest surface in the level and its
    // normal is the sum of three scrolled gradient taps plus the rain ripples,
    // so past a few metres the slope varies faster than a pixel and every lamp
    // lays down a path of crawling white specks instead of a glitter path.
    // Folding the measured normal variance into roughness converts those
    // specks into the correct broad shimmer - which is what a glitter path
    // actually is.
    if (F.reflect) brdf.push('gbRough0 = material.roughness;');
    brdf.push('{');
    brdf.push('  vec3 gbWdx = dFdx( normal ), gbWdy = dFdy( normal );');
    brdf.push('  float gbWv = max( dot( gbWdx, gbWdx ), dot( gbWdy, gbWdy ) );');
    brdf.push('  material.roughness = min( 1.0, sqrt( material.roughness * material.roughness +');
    brdf.push('    min( gbWv * 1.6, 0.34 ) ) );');
    brdf.push('}');
    // Water: F0 = 0.02, F90 = 1. The entire night read of the harbour is the
    // grazing term - the deck lights and the mast lamps smeared down the
    // surface - so F90 has to reach unity or the water goes flat black.
    brdf.push('material.specularColor = vec3( 0.020 );');
    brdf.push('material.specularF90 = 1.0;');
    // Foam is a dielectric solid, not a smooth interface.
    brdf.push('material.specularColor = mix( material.specularColor, vec3( 0.045 ), gbFoam );');
    src = src.replace('#include <lights_physical_fragment>',
      '#include <lights_physical_fragment>\n' + brdf.join('\n'));

    // ---- planar reflection --------------------------------------------------
    // Injected into `radiance` - the environment's SPECULAR radiance, before
    // RE_IndirectSpecular runs. That placement is the whole trick: the planar
    // term then goes through EnvironmentBRDF with the F0 = 0.02 / F90 = 1.0
    // Fresnel set eight lines above, so its absolute level is Fresnel-weighted
    // by exactly the same code as the envMap and there is no second Fresnel to
    // keep in step with the first.
    //
    // Three things below are not the obvious implementation and all three are
    // there because the obvious one was measured and was a net loss: the sample
    // is DISPLACED by the true ray deflection rather than a token UV constant,
    // it is PREFILTERED with a tap ring rather than faded out where the surface
    // roughens, and it is applied as a STRUCTURE TRANSFER onto the authored
    // radiance rather than replacing it. See the note on each.
    if (F.reflect) {
      var rf = [];
      rf.push('#if defined( RE_IndirectSpecular )');
      rf.push('{');
      // The mirror camera is the eye reflected in the water plane, so the
      // reflected view ray through this point and the mirror camera's ray
      // through it are the SAME ray. The texel under the point's own
      // projection is therefore exactly what the surface reflects - and
      // because the matrix travels with the frame it was rendered from, a
      // throttled pass stays registered instead of sliding.
      rf.push('  vec4 gbRp = gbReflMtx * vec4( gbWP, 1.0 );');
      rf.push('  float gbRw = max( gbRp.w, 1e-4 );');
      rf.push('  vec2 gbRuv = gbRp.xy / gbRw;');
      // WAVE DISTORTION, and it is the whole reason the crossfade is worth
      // doing at all. getIBLRadiance samples the probe along the true mirror
      // vector, so the wave normals modulate it strongly - that modulation IS
      // the ripple texture the surface reads by. A planar sample taken at the
      // fragment's own projection carries none of it, so a crossfade with a
      // token offset trades a rippled surface for a smooth one and loses more
      // than the local reflection gains. Measured, twice.
      //
      // So the offset is the real thing: the mirror ray turns by twice the
      // normal tilt, and the tilt is taken in VIEW space against the flat water
      // plane's own view-space normal, which makes it a screen-aligned quantity
      // that maps onto the reflection target's axes whatever the camera's yaw
      // is. (The mirror camera negates its up vector precisely so its screen
      // axes still agree with the player camera's.) gbReflCfg.y carries
      // distort/tan(fov/2) and gbReflCfg2.w the aspect, which is the projection
      // of that angle onto UV; there is no distance term in it because there is
      // none in the physics - an angular deflection covers the same fraction of
      // the frame at any range.
      rf.push('  vec3 gbNv0 = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );');
      rf.push('  vec2 gbRoff = ( normal - gbNv0 ).xy * vec2( gbReflCfg2.w, 1.0 ) * gbReflCfg.y;');
      // A light distance damp and a hard cap. Not physics: at range one pixel
      // covers many wavelengths, the slope it reports is aliased, and an
      // unbounded offset lets a single freak fragment fetch from the far side of
      // the frame - which reads as a lone bright speck, not as water.
      rf.push('  gbRoff /= ( 1.0 + gbWDist * 0.02 );');
      rf.push('  gbRoff = clamp( gbRoff, vec2( -0.12 ), vec2( 0.12 ) );');
      rf.push('  vec2 gbRs = clamp( gbRuv + gbRoff, vec2( 0.0015 ), vec2( 0.9985 ) );');
      // THE PREFILTER. A planar pass has exactly one sharp mip, and the sea
      // shader roughens with distance (12 m -> 90 m) and with the measured
      // normal variance on top of that, so a sharp fetch is unusable over most
      // of the surface. The first version of this block answered that by fading
      // the term out above roughness 0.34 - which deleted it across the whole
      // mid and far field, i.e. exactly where incidence is grazing, Fresnel is
      // approaching unity and the water is MOST like a mirror. Measured on the
      // jungle's hero2 framing: the term survived only in the near field, where
      // Fresnel is 2-6%, so all it could do there was subtract.
      //
      // Six taps on a hexagonal ring plus the centre, radius following the
      // roughness, stand in for the mip that does not exist. Round in PIXELS,
      // not in UV (gbReflCfg2.w), or a rough reflection smears 16:9 sideways.
      // A hex ring rather than a cross because a cross lays a visible plus over
      // every high-contrast edge in the reflection.
      rf.push('  vec2 gbRax = vec2( gbReflCfg2.w, 1.0 );');
      rf.push('  vec3 gbC0 = gbReflTap( gbRs );');
      rf.push('  vec3 gbRefA = gbC0;');
      rf.push('  float gbBr = min( gbRough0 * 3.0, 1.0 ) * gbReflCfg2.y;');
      rf.push('  if ( gbBr > 5e-4 ) {');
      rf.push('    vec2 gbBa = gbRax * gbBr;');
      rf.push('    vec3 gbAcc = gbC0;');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2(  1.000,  0.000 ) * gbBa );');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2(  0.500,  0.866 ) * gbBa );');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2( -0.500,  0.866 ) * gbBa );');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2( -1.000,  0.000 ) * gbBa );');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2( -0.500, -0.866 ) * gbBa );');
      rf.push('    gbAcc += gbReflTap( gbRs + vec2(  0.500, -0.866 ) * gbBa );');
      rf.push('    gbRefA = gbAcc * ( 1.0 / 7.0 );');
      rf.push('  }');
      rf.push('  gbRefA *= gbReflCfg.z;');
      // THE LOCAL LEVEL of the reflection: the same signal at a deliberately
      // WIDE radius, four taps. It is what the environment probe would have
      // said if the probe knew there was a jungle overhead - the low-frequency
      // brightness of what this patch of water faces.
      rf.push('  vec2 gbWa = gbRax * 0.055;');
      rf.push('  vec3 gbRefM = gbC0;');
      rf.push('  gbRefM += gbReflTap( gbRs + vec2(  1.0,  0.0 ) * gbWa );');
      rf.push('  gbRefM += gbReflTap( gbRs + vec2( -1.0,  0.0 ) * gbWa );');
      rf.push('  gbRefM += gbReflTap( gbRs + vec2(  0.0,  1.0 ) * gbWa );');
      rf.push('  gbRefM += gbReflTap( gbRs + vec2(  0.0, -1.0 ) * gbWa );');
      rf.push('  gbRefM *= ( gbReflCfg.z / 5.0 );');
      rf.push('  float gbRk = gbReflCfg.x * step( 1e-4, gbRp.w );');
      // Nothing outside the pass's own frame, feathered so the boundary is a
      // gradient into the environment rather than a line across the river. The
      // feather is wider than the local-level ring so a fragment whose wide taps
      // are clamping against the border is already fading out.
      rf.push('  vec2 gbRe = smoothstep( vec2( 0.0 ), vec2( 0.060 ), gbRuv ) *');
      rf.push('    smoothstep( vec2( 1.0 ), vec2( 0.940 ), gbRuv );');
      rf.push('  gbRk *= gbRe.x * gbRe.y;');
      // Past the prefilter's reach the environment is the correctly filtered
      // version of the same signal, so hand it back rather than alias.
      rf.push('  gbRk *= 1.0 - smoothstep( gbReflCfg2.z * 0.55, gbReflCfg2.z, gbRough0 );');
      rf.push('  gbRk *= 1.0 - gbFoam;');
      // STRUCTURE TRANSFER, and this is the part that took three measurements to
      // arrive at. The obvious implementation - crossfade `radiance` from the
      // probe to the planar sample - is wrong here, and wrong in a way that a
      // still frame hides and a measurement does not:
      //
      //   * the probe is a sky-only point sample with no local occlusion. It is
      //     uniformly bright and roughly an order of magnitude brighter than the
      //     canopy the mirror actually sees. Every water body in this library
      //     has its colour authored with that brightness leaking in through the
      //     low-angle Fresnel, so a straight swap drops the river by 2.5x and
      //     crushes it: measured on the jungle's hero2 river, row means
      //     65.7 -> 36.7 and 37.5 -> 15.3, and the auto-exposure then opened 5%
      //     and washed the rest of the frame to compensate.
      //   * the probe is sampled along the true mirror vector, so the wave
      //     normals modulate it hard, and that modulation is most of the ripple
      //     texture the surface reads by. A planar sample is a near-flat field
      //     by comparison, so the swap also FLATTENED the water - row standard
      //     deviation 10.6 -> 6.8 at mid depth. Both losses land on the very
      //     complaint the pass was built to answer.
      //
      // What the planar pass genuinely knows, and the probe cannot, is the
      // STRUCTURE: where the far bank is, where the mangrove roots are, where
      // the wreck standing out of the river is, where the canopy opens to sky.
      // So take the ratio of the sharp sample to its own local level and apply
      // that as a modulation of the radiance the level authored. The water keeps
      // its value and its ripple and gains the reflected shapes. The ratio is
      // per-channel, so the green of reflected foliage and the white of a sky
      // gap both survive; it is clamped because a ratio against a near-black
      // local level is a division by nothing.
      rf.push('  vec3 gbRatio = clamp( gbRefA / max( gbRefM, vec3( 2.0e-3 ) ),');
      rf.push('    vec3( 0.25 ), vec3( 4.0 ) );');
      // ...and toward grazing, hand over to the sample's ABSOLUTE value. There
      // the interface really is a mirror, Fresnel is approaching unity, and the
      // true brightness of the far bank against the true brightness of the sky
      // behind it is the whole point. `graze` is how far to go; 0 keeps the
      // authored level everywhere.
      rf.push('  float gbNV = clamp( dot( geometryNormal, geometryViewDir ), 0.0, 1.0 );');
      rf.push('  float gbAbsW = gbReflCfg.w * pow( 1.0 - gbNV, gbReflCfg2.x );');
      rf.push('  vec3 gbReflC = mix( radiance * gbRatio, gbRefA, clamp( gbAbsW, 0.0, 1.0 ) );');
      rf.push('  radiance = mix( radiance, gbReflC, clamp( gbRk, 0.0, 1.0 ) );');
      rf.push('}');
      rf.push('#endif');
      src = src.replace('#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n' + rf.join('\n'));
    }

    return pars.join('\n') + '\n' + src;
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
    // F.wet needs the world varyings; without this a harbor leaf card would
    // lose the soak layer entirely (see the guard in _patch).
    F.world = F.macro || F.wet;
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
      // ...and the shadow copy the harbor path actually reads, because r180
      // overwrites the real uniform with scene.environmentIntensity on every
      // draw of a material lit by scene.environment. Market materials have no
      // gbEnvWU, so this line is a no-op there and level 1 is untouched.
      var u = m.userData.gbEnvWU;
      if (u) u.value = m.userData.gbBaseEnv * scale;
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

  // ==========================================================================
  // THE WET CONTRACT, published as source.
  //
  // The exact GLSL this file's own materials run. Paste it into any other pass
  // that needs to know where the water is and you get byte-identical evaluation
  // in both, which is the only way two passes can agree about a noise field.
  // Pair it with MaterialLibrary.prototype.wetContract() for the live values.
  //
  //   noise   gbHash13 / gbValue3        (no varyings, safe anywhere)
  //   puddle  gbPuddleField( wp, cav )   requires `noise`
  //   solve   gbWetSolve(...)            requires `noise` + `puddle`
  //   ripple  gbRipples( xz, amt )       requires `noise`, and the uniforms
  //                                      gbRippleMap / gbRipCfg / gbTime
  //   height  gbWetHeight( wp, y, band ) no dependencies at all
  //
  // `uniforms` is the declaration block those two need, so a consumer does not
  // have to guess the names or the packing.
  //
  // -------------------------------------------------------------------------
  // `height` IS NEW AND IT FIXES A MEASURED, VISIBLE BUG.
  //
  // gbWetSolve answers "is there standing water at this world position, on a
  // surface with THIS material's susceptibility". A consumer with a G-buffer
  // knows the material. A consumer reconstructing the surface from DEPTH does
  // not, so it has to pick one cfg - in practice the apron's, whose puddle
  // susceptibility is 1.0 - and apply it to every pixel whose normal points up.
  // The apron is a ground plane; most up-facing pixels in this level are not.
  //
  // Measured consequence, enemy_closeup at 1280x720: the tarpaulin over the
  // near pallet stack (a domed sheet whose crown is 1.2 m above the slab) is
  // classified as standing water, gets an environment reflection at
  // standing-water roughness, and photographs as a large pale flat-shaded mound
  // faceted by the depth-derivative normal - which reads as an asset that lost
  // its material. Force the pass's reflection off and the same pixels are a
  // correct, dark, smooth tarpaulin. It is not free either: the mound is bright
  // enough to pull the auto-exposure down about a stop and a half, which is
  // what crushes the militiaman in the same frame to a silhouette.
  //
  // One line at the call site removes it:
  //
  //     float g = wetContract().ground;                       // {y, band}
  //     pud  *= gbWetHeight( Wp, uWetGround.x, uWetGround.y );
  //     wetT *= gbWetHeight( Wp, uWetGround.x, uWetGround.y );
  //
  // It takes its parameters as ARGUMENTS rather than reading a uniform, so a
  // consumer can paste it without declaring anything and can hard-code the two
  // numbers if it prefers. See wetContract().ground for the live values.
  // -------------------------------------------------------------------------
  var G_WETHEIGHT = [
    '// 1 on the yard slab, 0 above it. `band` is the height a surface may stand',
    '// above the slab and still be part of the ground (a kerb, a drain cover, a',
    '// pallet lying flat); the fade above it is deliberately soft and finishes',
    '// about a metre later, because a hard line would print as a horizontal edge',
    '// across anything tall. Below the slab is still ground - the quay steps and',
    '// the drainage channels are down there and they hold the most water in the',
    '// level.',
    'float gbWetHeight( vec3 wp, float groundY, float band ) {',
    '  return 1.0 - smoothstep( groundY + band, groundY + band + 1.05, wp.y );',
    '}'
  ].join('\n');

  MaterialLibrary.WET_GLSL = {
    noise: G_NOISE,
    puddle: G_PUDDLE,
    solve: G_WETSOLVE,
    ripple: G_RIPPLE,
    height: G_WETHEIGHT,
    uniforms: [
      'uniform sampler2D gbRippleMap;',
      'uniform vec4 gbRipCfg;',      // x = tiles/m, y = strength, z = source mode
      'uniform float gbTime;'
    ].join('\n')
  };

  GAME.MaterialLibrary = MaterialLibrary;

})(window.GAME, window.THREE);
