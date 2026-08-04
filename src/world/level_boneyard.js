// ============================================================================
// OPERATION BLACKOUT - src/world/level_boneyard.js  ->  GAME.LevelBoneyard
//
// "AMARG BONEYARD": a 204 x 168 m aircraft storage yard in the high desert at
// noon. The deliberate opposite of every other level on the roster - the widest
// space, the flattest ground, the highest sun, the palest palette, and the only
// one whose whole subject is a MAN-MADE OBJECT rather than architecture.
//
// The plan, in world coordinates (-Z is north, the player spawns at the south
// gate looking up taxiway Alpha):
//
//        x = -11 .. +11     TAXIWAY ALPHA, the leading line, running the whole
//                           length of the yard
//        x = -78 .. -24     STORAGE ROWS: four rows of tactical airframes on
//                           an 18 m pitch with 7.5 m between wingtips. The
//                           corridors between them are the canyons you fight in
//        z = -8 .. +6       the CROSS LANE cutting east-west through the rows
//        (16, -4)           SIERRA SEVEN: a 44 m four-engine transport whose
//                           port wing reaches across the taxiway. This aircraft
//                           IS the level - it throws the only deep shade in a
//                           frame that is otherwise all sky and bleached slab
//        x = 44 .. 76       MAINTENANCE HANGAR, doors on the west face
//        x = 24 .. 44       PARTS YARD: wing racks, engine cradles, fin racks
//        (-22, 50)          the water tower, 22 m - the only vertical landmark
//        r = 430            the ridge line, hazed
//
// ============================================================================
// THE LIGHT, AND WHY EVERY POSE IS WHERE IT IS
// ============================================================================
// The level ASKS sky.js for its arc rather than assuming one - SUN_EL_DEG, 58
// degrees, requested through sky.setSolarArc() on the first frame, with the
// azimuth held near -0.72 rad. So the key arrives from bearing ~319 (NNW) at 58
// degrees up and every shadow in this level is thrown 0.62 x its caster's
// height toward bearing ~139 (SSE). Two consequences drive the whole layout:
//
//   1. A 6 m wing throws its shade 3.7 m SSE of itself. The shade is therefore
//      NOT under the wing, it is a band offset south-east of it, and that band
//      is where a camera has to stand. Every pose below is solved against
//      shadeOffset(), not eyeballed - and because the level requests the arc it
//      solves against, "the sun the poses assume" and "the sun that renders"
//      are the same number by construction. They were not, for one round, and
//      it cost every composition in the file.
//   2. The sun disc is 58 degrees up, so it is out of frame for any pose
//      pitched below ~30 degrees - which is all five. What still has to be
//      checked is glare: everything inside ~55 degrees of bearing 319 sits in
//      the bright half of the sky. The smallest sun-to-axis angle in the set is
//      63 degrees (overview).
//
// The brief names the trap - "a flat, white, contrastless frame". Two answers,
// and the second one is the one that was missing for two rounds:
//   OCCLUSION   34 airframes, a hangar, a water tower and a wing farm, every
//               one of them throwing a hard-edged shadow across the slab.
//   VALUE       the slab is a MID grey-tan (SURF.hardstand) and the aluminium
//               is most of a stop above it (buildSkinMaps' SKIN_GAIN). When
//               those two sat within 18% of each other no amount of shadow
//               helped, because the subject and the ground were the same
//               colour and the establishing shot had no figure at all.
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// Everything another module might want to place against is published by name in
// `level.anchors`, available immediately after `new LevelBoneyard(ctx)` - you do
// NOT have to wait for build().
//
//   DO NOT derive a world position from `level.cameraPoses`. A camera pose is a
//   COMPOSITION and it moves whenever the composition improves. The harbor build
//   lost a set of fixtures exactly that way.
//
//   anchors.yard         { x0,x1,z0,z1, taxiHalf, groundY(x,z), sunBearing,
//                          shadeOffset(h) }
//   anchors.taxiway      { x, z0, z1, half, centreline:[...], spawnEnd, farEnd }
//   anchors.sierra7      { centre, yaw, len, span, noseY, wingY, wing:{...},
//                          nacelles:[...], gear:[...], tail, shade:{...} }
//   anchors.bigAircraft  [ { name, centre, yaw, type, len, span, tailY } ... ]
//   anchors.rows         [ { x, bays:[z...], type, span } ... ]   west field
//   anchors.crossLane    { z0, z1, x0, x1, centre }
//   anchors.hangar       { x0,x1,z0,z1, doorX, doorZ0, doorZ1, doorH, eave,
//                          ridge, floorY, centre, yaw, sunPatch, jackStand }
//   anchors.partsYard    { x0,x1,z0,z1, wingRacks:[...], engineCradles:[...],
//                          finRack, hulkCradles:[...] }
//   anchors.waterTower   { centre, base, catwalk, tankY, radius }
//   anchors.opsShack     { centre, yaw, w, d, h, doorSide }
//   anchors.hulkRow      [ { centre, yaw, len } ... ]
//   anchors.fence        { x0,x1,z0,z1, gate:{centre, halfWidth, yaw} }
//   anchors.shadeZones   [ {x0,x1,z0,z1, source} ]  - the deep-shade footprints,
//                          for anyone placing something that should be IN shade
//   anchors.dustDevils   [ Vector3 ]  - open fetch where a devil can spin up
//
// ALSO PUBLISHED
//   level.practicalLights  hangar bays, the tower beacon, the ops shack. Almost
//                          all carry dayBase so they survive the noon gate.
//   level.lightShafts      the hangar roof monitors and the door wedge.
//   level.shadeZones       same array as anchors.shadeZones.
//   level.heatShimmer      {y, strength, cells:[...]} - where the tarmac boils.
//                          postfx.js reads this on its own (setHeatShimmer), so
//                          it is a live control, not advisory.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var PAD_X0 = -100, PAD_X1 = 104;      // the concrete hardstanding
  var PAD_Z0 = -96, PAD_Z1 = 72;
  var TAXI_HALF = 11.0;                 // taxiway Alpha, centred on x = 0
  var TAXI_Z0 = -94, TAXI_Z1 = 70;

  var FENCE_X0 = -118, FENCE_X1 = 122;
  var FENCE_Z0 = -114, FENCE_Z1 = 86;

  // West storage field: four rows on an 18 m pitch. A 10.5 m span leaves 7.5 m
  // between wingtips, which is what AMARG actually parks at and what makes the
  // corridors read as canyons rather than as streets.
  var ROWS_X = [-24, -42, -60, -78];
  var ROW_BAYS = [-70, -52, -34, -16, 14, 32];
  var CROSS_Z0 = -8.0, CROSS_Z1 = 6.0;   // the east-west service lane

  // The hero airframe.
  var S7_X = 16.0, S7_Z = -4.0, S7_YAW = Math.PI;
  var S7_LEN = 44.0, S7_SPAN = 45.0;

  var HG_X0 = 44.0, HG_X1 = 76.0, HG_Z0 = 30.0, HG_Z1 = 62.0;
  var HG_EAVE = 11.0, HG_RIDGE = 14.6, HG_FLOOR = 0.16;
  var HG_DOOR_Z0 = 38.0, HG_DOOR_Z1 = 56.0, HG_DOOR_H = 10.0;

  var PY_X0 = 24.0, PY_X1 = 42.0, PY_Z0 = 28.0, PY_Z1 = 66.0;

  // ---------------------------------------------------------------------------
  // The water tower stands in the SOUTH-WEST corner, and that is a FRAMING
  // decision, not a plan one. The overview eye stands on its catwalk, and from
  // the middle of the yard (where it started) a 100-degree frame could hold the
  // storage rows or the hangar and the parts yard but never both - the
  // establishing shot was missing half the level it was establishing. From the
  // corner, looking north-east up the diagonal, all four rows, the taxiway,
  // three big airframes, the hulk row, the parts yard and the hangar fall
  // inside one frame, and the key is 99 degrees off the axis.
  var WT_X = -86.0, WT_Z = 60.0, WT_H = 22.0, WT_R = 4.6;
  var OPS_X = -36.0, OPS_Z = 40.0;

  var RIDGE_R = 430.0;

  // ---------------------------------------------------------------------------
  // THE SUN. One number, and the level ENFORCES it rather than assuming it.
  //
  // Every shadow-aware decision in this file - shadeOffset(), the shade zones,
  // the hangar's light shafts, the bounce aim and all five camera poses - is
  // solved against SUN_EL. sky.js owns the real key, and main.js's env profile
  // drives it through sky.setSolarArc(). When those two disagreed the whole
  // level was authored against a sun that did not exist: SUN_EL sat at 30
  // degrees while the profile put the key at 66, so shadeOffset returned
  // run = 1.732h where the truth was 0.445h - a 3.9x error - and hero1's
  // standpoint was composed around a 9.35 m shade ribbon that photographs as
  // 2.40 m of thin bands in the corner of the frame. Every downstream consumer
  // inherited it: the shafts were tilted 60 degrees from vertical against a sun
  // 24 degrees off it, and anchors.yard.sunElevation broadcast the wrong figure
  // to props before they placed.
  //
  // So the level asks for the arc it is drawn for, on frame 1, through the same
  // documented public API the env profile uses (see sky.setSolarArc - it is
  // per-instance, idempotent and clamped, so nothing this does can move market
  // or harbor). That closes the loop: the constant below and the real key are
  // the same number by construction.
  //
  // 58 DEGREES, NOT 66. run = h / tan(el), so the port wing of Sierra Seven at
  // 5.40 m throws 2.40 m of shade at 66 and 3.37 m at 58. Both are unmistakably
  // "brutal overhead sun" - the market's golden hour runs 1.73x object height -
  // but 2.4 m is a ribbon narrower than the wing is thick, i.e. a shadow with
  // no shape, and the shade this yard throws is the level's ONLY graphic asset.
  // 58 buys back 40% of it and keeps the hard short-shadow character intact.
  var SUN_AZ = -0.72;                    // radians east of -Z
  var SUN_EL_DEG = 58.0;
  var SUN_EL = SUN_EL_DEG * Math.PI / 180;

  var UP = new THREE.Vector3(0, 1, 0);

  // ------------------------------------------------------------- materials --
  // Every entry names a material the library certainly has in `base`, and
  // declares the world-metres-to-uv density that lands it near 500 texels/m
  // (materials.uvScaleFor's budget). Triplanar bases ignore uv entirely.
  //
  // `wear: true` asks for materials.js's VERTEX WEAR shader (R grime, G wetness,
  // B edge wear). This is a DESERT: the G channel stays at 1.0 everywhere
  // except three deliberate oil spills, and the whole channel budget goes into
  // R - blown sand, tyre rubber, exhaust soot and hydraulic staining - which is
  // the only tonal variation a noon slab has.
  //
  // Everything else takes wearMode 'multiply', where the colour attribute is a
  // plain albedo multiplier, because airframes carry per-aircraft body colour
  // in exactly that channel.
  var SURF = {
    // Deliberately DARKER than a first guess at "bleached concrete". The slab is
    // 60-70% of the pixels in four of the five framings, and at 0xa9a294 it
    // metered as the brightest large surface in the level - which pulls the
    // exposure down and takes the sunlit aluminium down with it. Aged airfield
    // concrete with rubber and sand on it is a mid grey-tan, and letting it sit
    // there is what leaves the airframes somewhere to be bright.
    // ---------------------------------------------------------------------
    // 0x7d786c, AND THIS IS THE LEVEL'S VALUE ARCHITECTURE IN ONE NUMBER.
    //
    // At 0xa5a091 (linear 0.381) the slab sat essentially ON TOP of BODY.bare
    // 0xb8bbbd (linear 0.48). Measured on the establishing frame: airframe
    // bodies 187-192 sRGB, the hardstanding they stand on 182-193. Thirty-four
    // aeroplanes and two hundred metres of concrete inside five grey levels,
    // separated by a one-pixel edge - the "flat, white, contrastless frame"
    // the brief names as the trap, arriving by albedo collision rather than by
    // exposure. And the slab wins that collision every time, because it is
    // 60-70% of the pixels and the grade meters to it.
    //
    // 0x958a6f is half a stop under the previous value AND twice as warm
    // (r-b 38 against 20), and BOTH halves are measured, because the naive fix
    // - just take the slab down three quarters of a stop and stop - regresses
    // the colour grade in a way that is invisible in a thumbnail:
    //
    //   analyze.py's grade_split samples the top 15% of the frame by linear
    //   luminance. On this level that bucket was 94% SUNLIT APRON, which is
    //   warm, and the metric read +0.067 to +0.081. Drop the slab to 0x7d786c
    //   and the apron falls BELOW the sky: the bucket goes 49% sky, the sky is
    //   cool, and grade_split lands at -0.002 - a hard fail on a frame that
    //   looks better than the one that passed. Measured on lv_hero2, camera
    //   unmoved, three quarters of the change coming from that one constant.
    //
    // So the separation is bought from BOTH ends instead of one: the slab
    // comes down half a stop and the airframe skin goes UP a third of a stop
    // (see buildSkinMaps' SKIN_GAIN), which is 0.85 stop of figure/ground and
    // leaves the apron above the horizon in every framing. The extra warmth is
    // what a concrete apron under thirty years of blown sand actually is, and
    // it is what keeps the highlight bucket warm even where the sky does get
    // into it.
    hardstand:  { uv: 0.35, cast: false, recv: true, wear: true,
                  base: 'concrete', target: 0x958a6f, rough: 0.90, env: 0.80 },
    // The saw-cut/tar joint lattice and the heat craze, as an alpha overlay on
    // its own world-aligned tile. See buildCrackTexture.
    crack:      { uv: 1 / 15.24, cast: false, recv: true, wear: false, own: true, keepUV: false },
    // Tracks the slab down so a bitumen repair keeps its ~3:1 step against the
    // concrete round it rather than closing to 2:1.
    pad_patch:  { uv: 0.35, cast: false, recv: true, wear: true,
                  base: 'asphalt', target: 0x4b473f, rough: 0.88 },
    // ---------------------------------------------------------------------
    // THE HANGAR FLOOR, AND WHY IT IS WORTH A DRAW CALL.
    //
    // It used to share `hardstand`, and when the apron came down half a stop
    // it came down with it - which is wrong twice. Physically: an interior
    // power-floated slab that has been under a roof for forty years is not the
    // same surface as an apron carrying rubber, soot and blown sand; it is
    // paler, smoother and cleaner, and it is swept. And measurably: the
    // interior framing's vertical_imbalance went 1.78 -> 2.48 against a 2.50
    // limit on that one change, because the whole bottom half of that frame IS
    // this floor while the top half is lit cladding. One material, one draw
    // call out of ~85 spare, and the frame the brief calls the best-composed
    // in the set gets its floor back.
    hg_floor:   { uv: 0.35, cast: false, recv: true, wear: true,
                  base: 'concrete', target: 0xada592, rough: 0.82, env: 0.75 },
    // Desert pavement comes down with the slab, but only half as far. Sand at
    // noon genuinely IS brighter than aged concrete, and the warm outfield is
    // what keeps the palette "bleached tan" rather than grey - but at 0xbda482
    // it inherited the slab's old job of being the brightest large surface in
    // the frame the moment the slab stopped doing it.
    desert:     { uv: 0.35, cast: false, recv: true, wear: true,
                  base: 'sand', target: 0xa8916f },
    verge:      { uv: 0.35, cast: false, recv: true, wear: true,
                  base: 'gravel', target: 0x8a7f6a },
    paint_line: { uv: 1.20, cast: false, recv: true, wear: true,
                  base: 'painted_metal', target: 0xd8bf4a, rough: 0.86, metal: 0.0 },
    // ---------------------------------------------------------------------
    // THE AIRFRAME SKIN, and the single most important material in the level.
    // It gets its OWN map set (buildSkinMaps, below) rather than a library
    // material, and both halves of that decision are measured.
    //
    // 1. THE MAP. painted_metal at uv 2.40 put its base tile at 0.38 m, so
    //    genPaintedMetal's chip/worley features landed at 8-25 mm - sub-pixel
    //    at any playable range - and on a metal surface every one of those
    //    texels sampled a different part of the environment (blue sky above,
    //    tan ground below). A 44 m fuselage printed as blue/tan salt-and-
    //    pepper confetti with no aircraft structure in it at all. What an
    //    aeroplane skin actually is at 10 m is a 1.5-2.5 m PANEL GRID with
    //    lap joints, rivet rows on the frames and stringers, mismatched alloy
    //    and repaint values panel to panel, and a couple of repair patches.
    //    None of that is expressible as a tiling noise, so it is drawn.
    // 2. THE METAL. 0.74 bypasses the diffuse term entirely, and diffuse is
    //    the ONLY fill this renderer can put on a flank that faces away from
    //    the key: sunlit clad measured 106:1 against its own shaded end wall
    //    and a wing panel 8 m from the lens sat at 0.066 sRGB. Twenty-year
    //    oxidised alclad is a satin that behaves like a dielectric, so 0.38 -
    //    which restores 62% of the albedo to the shaded hemisphere and takes
    //    key-to-fill from 106:1 to roughly 10:1.
    airframe:   { uv: 1 / 6.0, cast: true, recv: true, wear: false, own: true,
                  target: 0xa8adb0, rough: 0.44, metal: 0.38, env: 1.05 },
    // Chalked paint, primer, and the inside of everything that has been opened
    // up. Deliberately a SECOND material rather than a tint of the first: the
    // difference between a polished skin panel and a primered patch beside it
    // is a roughness difference, and a tint cannot express one.
    // Chalked paint, primer, and the inside of everything that has been opened
    // up. Deliberately a SECOND material rather than a tint of the first: the
    // difference between a polished skin panel and a primered patch beside it
    // is a roughness difference, and a tint cannot express one. It takes the
    // level's own map for the same reason the airframe does - at painted_metal
    // uv 1.60 every pylon, rib and duct in the yard was speckled terrazzo.
    skin_dull:  { uv: 1 / 6.0, cast: true, recv: true, wear: false, own: true,
                  target: 0x8b8a82, rough: 0.78, metal: 0.18, env: 0.85 },
    // Sprayed vinyl cocoon over canopies, intakes and exhausts. The one pure
    // white in the level, and it is what makes the rows read as STORED rather
    // than as parked.
    wrap:       { uv: 1.70, cast: true, recv: true, wear: false, macro: 0,
                  base: 'canvas_awning', target: 0xc6c2b4, rough: 0.90, metal: 0.0 },
    canopy:     { uv: 0.39, cast: false, recv: true, wear: false,
                  base: 'glass', rough: 0.22, env: 1.6 },
    tyre:       { uv: 0.61, cast: true, recv: true, wear: false,
                  base: 'rubber', target: 0x232426, rough: 0.86, metal: 0.0 },
    // uv 0.30 for the opposite reason to the airframe's 2.40. These are 50-150
    // mm bars and angles; at 0.90 the chip field puts less than one cell across
    // a member, so every bar in a railing picks a different random value out of
    // the same map and a handrail reads as rust-speckled noise. At 0.30 the map
    // scales to the MEMBER and a bar is a smooth gradient with one or two chips
    // in it - which is what painted steel is.
    // metal 0.45, not 0.68: every railing, truss and rack in the level is seen
    // from its shaded side in at least one published framing, and above ~0.5 a
    // shaded painted-steel member has no diffuse left to be lit by.
    // ---------------------------------------------------------------------
    // 0.26 / 0.62, and it is the same argument carried one step further by a
    // frame that made the cost visible. The overview eye stands ON the water
    // tower catwalk, so the nearest object in the establishing shot - one metre
    // from the lens, across the bottom third - is a `steel` handrail and a
    // `steel` deck plank. At metalness 0.45 an up-facing member a metre from
    // the lens has almost no diffuse and mirrors the ZENITH sky, so the frame's
    // whole foreground printed as a dark navy bar with white specular confetti
    // scattered along it: chrome rope, not galvanised handrail. The same defect
    // at lower contrast turns the parts-yard wing racks in hero2 into a
    // blue-white jungle gym. Chalked painted steel in the Sonoran desert is a
    // near-dielectric satin; 0.26 hands most of that surface back to the
    // diffuse term (which is also the only fill a shaded member gets) and the
    // extra roughness stops the rivet field in the shared skin map picking
    // single-pixel speculars out of the sky.
    // ---------------------------------------------------------------------
    // macro 0.04, AND IT IS THE OTHER HALF OF THE SAME FRAME.
    //
    // Dropping the metalness took the sky mirror off the catwalk but the bar was
    // still blotchy blue-grey with white specks along it, and the cause is the
    // uv above rather than the shader: 0.16 is a 6.25 METRE tile, so a 0.85 m
    // deck plank one metre from the establishing eye shows one seventh of one
    // tile - the library's macro colour/roughness field magnified about seven
    // times, which is a smooth 40 cm blotch on a 50 mm bar at 30 m and a pair of
    // 3 m stains on a plank at 1 m. Raising the uv would fix the plank and
    // reintroduce the "every bar picks a different random value" failure the
    // note above exists to prevent, so the density stays and the MACRO LAYER
    // goes: 0.04 instead of painted_metal's 0.17. What is left carrying the
    // surface is the detail layer, which materials.js samples in WORLD space at
    // a 4-5 cm period (wdet) and is therefore the same size on a handrail at
    // 1 m and a truss at 40 m - exactly the property this material needs. ns
    // 0.62 for the same reason: at full strength the magnified normal was
    // throwing the single-pixel speculars that read as the confetti.
    steel:      { uv: 0.16, cast: true, recv: true, wear: false,
                  base: 'painted_metal', target: 0x808690, rough: 0.62, metal: 0.26,
                  macro: 0.04, ns: 0.62 },
    rusted:     { uv: 0.40, cast: true, recv: true, wear: false,
                  base: 'rusted_metal', target: 0x6b4834, rough: 0.86, metal: 0.28 },
    // ---------------------------------------------------------------------
    // CLADDING, AND WHY IT IS NOT `corrugated_metal`.
    //
    // The profile is now GEOMETRY (corrSheet), so the base map only has to be
    // sheet steel. It is painted_metal because corrugated_metal was measured
    // not to respond to fill at all: with the level's slab-bounce directional
    // landing 0.97 of its lambert term on the hangar's shaded south wall, that
    // wall moved from 0.0035 to 0.0044 linear, while `steel` (painted_metal)
    // and the airframe skin on the racks in the same frame, at the same
    // orientation, both moved by the predicted amount. Two independent
    // controls - metalness 0.0 with envMapIntensity 1.8, and a dedicated
    // directional - changed nothing on that def and everything on the others.
    // Reported as a shared-system finding; answered here by not using it.
    //
    // It also takes the level's own sheet map rather than a library tile.
    // painted_metal was tried at uv 0.55 and its stochastic chip/worley field
    // landed at 15-40 cm, which on a 32 x 11 m wall and a 32 m soffit printed
    // as speckled TERRAZZO - the same failure the airframe skin had, one scale
    // up. Industrial cladding is sheets with fixings, which is exactly what
    // buildSkinMaps already draws, so the two share one map set and differ by
    // a colour multiply and a roughness.
    clad:       { uv: 1 / 6.0, cast: true, recv: true, wear: false, own: true,
                  target: 0x9a9c98, rough: 0.60, metal: 0.40, env: 1.0 },
    conc_wall:  { uv: 0.35, cast: true, recv: true, wear: true,
                  base: 'concrete_wall', target: 0xa39a8b },
    // The ridge. Answered by materials.distant() so a 430 m proxy physically
    // cannot out-value a 10 m sunlit wing.
    ridge:      { uv: 0.25, cast: false, recv: false, wear: false, own: true },
    chain:      { uv: 1.0, cast: false, recv: false, wear: false, own: true, keepUV: true },
    // The stencil atlas this file generates for itself: serials, walkway
    // stencils, danger triangles, the ground bay numbers.
    decal:      { uv: 1.0, cast: false, recv: true, wear: false, own: true, keepUV: true },
    glass_lit:  { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                  base: 'plastic', col: 0x3a3323, rough: 0.28, metal: 0.0,
                  emissive: 0xffd9a0, emissiveIntensity: 2.6 }
  };

  // If materials.js is missing entirely the yard must still read as bleached
  // aluminium on hot concrete rather than as magenta error boxes.
  var FALLBACK = {
    hardstand:  [0x958a6f, 0.92, 0.0],
    hg_floor:   [0xada592, 0.86, 0.0],
    pad_patch:  [0x4b473f, 0.90, 0.0],
    desert:     [0xa8916f, 0.98, 0.0],
    verge:      [0x8a7f6a, 0.96, 0.0],
    paint_line: [0xcdb44e, 0.88, 0.0],
    airframe:   [0xb3b6b8, 0.44, 0.38],
    skin_dull:  [0x9b988f, 0.76, 0.20],
    wrap:       [0xd8d4c6, 0.88, 0.0],
    canopy:     [0x3d474c, 0.22, 0.0],
    tyre:       [0x232426, 0.86, 0.0],
    steel:      [0x868b93, 0.60, 0.26],
    rusted:     [0x77503a, 0.84, 0.28],
    clad:       [0x9a9c98, 0.56, 0.40],
    conc_wall:  [0xa39a8b, 0.92, 0.0],
    ridge:      [0x9aa0a6, 0.98, 0.0],
    chain:      [0x9aa3a8, 0.55, 0.45],
    crack:      [0xffffff, 0.94, 0.0],
    decal:      [0xffffff, 0.80, 0.0],
    glass_lit:  [0xffe0b0, 0.20, 0.0]
  };

  // --------------------------------------------------------- small helpers --
  var _e1 = new THREE.Euler();

  function makeM(x, y, z, rx, ry, rz) {
    var m = new THREE.Matrix4();
    if (rx || ry || rz) {
      _e1.set(rx || 0, ry || 0, rz || 0, 'YXZ');
      m.makeRotationFromEuler(_e1);
    }
    m.elements[12] = x || 0; m.elements[13] = y || 0; m.elements[14] = z || 0;
    return m;
  }

  function vertCount(g) {
    return g.index ? g.index.count : g.attributes.position.count;
  }

  var _boxCache = new Map();
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.012, Math.min(w, h, d) * 0.28);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) {
      var src = Geo.bevelBox(w, h, d, bevel);
      g = src.toNonIndexed();
      src.dispose();
      _boxCache.set(k, g);
    }
    return g;
  }

  var _cylCache = new Map();
  function cyl(rTop, rBot, len, seg, open) {
    seg = seg || 10;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg + (open ? 'o' : '');
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, !!open);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  var _quadCache = new Map();
  function quad(w, h, u0, v0, u1, v1) {
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + u0 + ',' + v0 + ',' + u1 + ',' + v1;
    var g = _quadCache.get(k);
    if (g) return g;
    var hw = w * 0.5, hh = h * 0.5;
    var pos = new Float32Array([
      -hw, -hh, 0, hw, -hh, 0, hw, hh, 0,
      -hw, -hh, 0, hw, hh, 0, -hw, hh, 0
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    _quadCache.set(k, g);
    return g;
  }

  // ---------------------------------------------------------------------------
  // THE LOFT. Every curved surface in this level - fuselages, wings, fins,
  // nacelles, the water tank, the radome - is a stack of rings run through
  // this one function.
  //
  // It builds INDEXED and lets three compute the vertex normals, then converts
  // to non-indexed for the merge. That is not laziness, it is the whole reason
  // the airframes read: a fuselage whose triangles each carry their own face
  // normal is a faceted tube, and at the 12-16 segments this level can afford
  // per ring a faceted tube under a hard noon key prints as a barrel of
  // alternating light and dark strips. Averaging at the vertices costs nothing
  // and turns the same 16 facets into a continuous specular sweep.
  //
  // `rings` is an array of equal-length arrays of [x,y,z]. `closed` wraps the
  // ring back on itself (a fuselage); leaving it open builds a sheet (a wing
  // that is capped separately, an open cowl).
  // ---------------------------------------------------------------------------
  function ringLoft(rings, closed) {
    var nr = rings.length, nv = rings[0].length;
    var pos = new Float32Array(nr * nv * 3);
    var i, j, k = 0;
    for (i = 0; i < nr; i++) {
      for (j = 0; j < nv; j++) {
        var p = rings[i][j];
        pos[k] = p[0]; pos[k + 1] = p[1]; pos[k + 2] = p[2];
        k += 3;
      }
    }
    var idx = [];
    var lim = closed ? nv : nv - 1;
    for (i = 0; i + 1 < nr; i++) {
      for (j = 0; j < lim; j++) {
        var j2 = (j + 1) % nv;
        var a = i * nv + j, b = i * nv + j2;
        var c = (i + 1) * nv + j, d = (i + 1) * nv + j2;
        idx.push(a, c, b, b, c, d);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    var out = g.toNonIndexed();
    g.dispose();
    return out;
  }

  // A flat cap over one ring, as a fan from its centroid. Hard-edged on
  // purpose: a severed fuselage, a wing tip rib and a jet pipe all want a rim
  // the light can catch, not a smooth roll-off into the side wall.
  function ringCap(ring, flip) {
    var n = ring.length, i;
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; cz += ring[i][2]; }
    cx /= n; cy /= n; cz /= n;
    var pos = [], nor = [];
    for (i = 0; i < n; i++) {
      var a = ring[i], b = ring[(i + 1) % n];
      var ax = a[0], ay = a[1], az = a[2];
      var bx = b[0], by = b[1], bz = b[2];
      if (flip) { var tx = ax, ty = ay, tz = az; ax = bx; ay = by; az = bz; bx = tx; by = ty; bz = tz; }
      var ux = ax - cx, uy = ay - cy, uz = az - cz;
      var vx = bx - cx, vy = by - cy, vz = bz - cz;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      pos.push(cx, cy, cz, ax, ay, az, bx, by, bz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // ---------------------------------------------------------------------------
  // A TRAPEZOIDAL CLADDING SHEET, AS GEOMETRY.
  //
  // This is the answer to the hangar's shaded end wall measuring 0.0035 linear
  // against 0.373 on its own sunlit face - a 106:1 void that survived taking
  // the material to metalness 0.0 with envMapIntensity 1.8, and survived a
  // dedicated bounce fill. A flat box with a rib NORMAL MAP on it has exactly
  // one shading normal, so when that normal faces away from a 30-degree key the
  // whole 32 x 11 m plane has nothing to be lit by and no amount of material
  // work can change it.
  //
  // Real profiled cladding is not flat. Its webs stand at about 56 degrees, and
  // on a wall facing away from the sun those webs are the ONLY part of the
  // building still pointing at it: the arithmetic is that a face needs to be
  // steeper than 48.7 degrees to keep a positive lambert term against this
  // key, so the pans go black and the webs stay lit. That is what a photograph
  // of a shaded steel shed actually looks like - a dark wall with a comb of
  // bright vertical lines down it - and it is 2k triangles a wall.
  //
  // Authored in local XY facing +Z: x across the ribs, y up, z out.
  // ---------------------------------------------------------------------------
  var CORR_PROFILE = [[0.00, 0], [0.52, 0], [0.66, 1], [0.86, 1], [1.00, 0]];

  function corrSheet(w, h, pitch, depth) {
    var ribs = Math.max(1, Math.round(w / pitch));
    var p = w / ribs;
    var xs = [], zs = [], i, k;
    for (i = 0; i < ribs; i++) {
      for (k = 0; k < CORR_PROFILE.length - 1; k++) {
        xs.push(-w * 0.5 + (i + CORR_PROFILE[k][0]) * p);
        zs.push(CORR_PROFILE[k][1] * depth);
      }
    }
    xs.push(w * 0.5); zs.push(0);
    var n = xs.length - 1;
    var pos = new Float32Array(n * 6 * 3);
    var nor = new Float32Array(n * 6 * 3);
    var uv = new Float32Array(n * 6 * 2);
    var o = 0, uo = 0;
    for (i = 0; i < n; i++) {
      var x0 = xs[i], x1 = xs[i + 1], z0 = zs[i], z1 = zs[i + 1];
      var dx = x1 - x0, dz = z1 - z0;
      var l = Math.sqrt(dx * dx + dz * dz) || 1;
      // outward normal of the segment, in the XZ plane
      var nx = dz / l, nz = -dx / l;
      if (nz < 0) { nx = -nx; nz = -nz; }
      var quad6 = [
        x0, 0, z0, x1, 0, z1, x1, h, z1,
        x0, 0, z0, x1, h, z1, x0, h, z0
      ];
      for (k = 0; k < 18; k++) pos[o + k] = quad6[k];
      for (k = 0; k < 6; k++) {
        nor[o + k * 3] = nx; nor[o + k * 3 + 1] = 0; nor[o + k * 3 + 2] = nz;
      }
      var u0 = (x0 + w * 0.5), u1 = (x1 + w * 0.5);
      var uvq = [u0, 0, u1, 0, u1, h, u0, 0, u1, h, u0, h];
      for (k = 0; k < 12; k++) uv[uo + k] = uvq[k];
      o += 18; uo += 12;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A height-field patch. The hardstanding, the desert ring, the hangar floor.
  function gridSurface(x0, x1, z0, z1, step, fn) {
    var nx = Math.max(1, Math.round((x1 - x0) / step));
    var nz = Math.max(1, Math.round((z1 - z0) / step));
    var dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    var vw = nx + 1, vh = nz + 1;
    var pos = new Float32Array(vw * vh * 3);
    var i, j, k = 0;
    for (j = 0; j < vh; j++) {
      for (i = 0; i < vw; i++) {
        var x = x0 + i * dx, z = z0 + j * dz;
        pos[k] = x; pos[k + 1] = fn(x, z); pos[k + 2] = z;
        k += 3;
      }
    }
    var idx = [];
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var a = j * vw + i, b = a + 1, c = a + vw, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    var out = g.toNonIndexed();
    g.dispose();
    return out;
  }

  // ---------------------------------------------------------------------------
  // A BODY COLOUR, and why it is not tint().
  //
  // tint() normalises its result so the brightest channel is 1 - which is right
  // for a paint tint on a structure and catastrophically wrong for a field of
  // aeroplanes. Every airframe came back the SAME VALUE in the first capture:
  // "faded green", "desert tan" and "bare metal" all normalise to a near-white
  // multiplier, so thirty-four aircraft printed as thirty-four identical white
  // shapes against a pale slab and the yard had no tonal separation at all.
  //
  // An airframe carries a hue pull AND a value, and the value is what does the
  // work: a repainted grey jet is genuinely 30% darker than the alclad one
  // parked next to it, and that difference is the only thing separating them
  // when both are lit by the same overhead sun.
  function bodyTint(hex, strength, value) {
    var c = tint(hex, strength);
    var v = value === undefined ? 1 : value;
    c.r *= v; c.g *= v; c.b *= v;
    return c;
  }

  // Hue-preserving tint, normalised so a tint never darkens by accident.
  function tint(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  // ================================================================ Builder ==
  // A transform stack plus per-material geometry buckets. The same shape as the
  // market and harbor builders, deliberately.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    this.paint = 'metal';
    this.dark = 0;
    this.wear = 0;
    this.count = 0;
  }
  Builder.prototype.top = function () { return this._stack[this._stack.length - 1]; };
  Builder.prototype.push = function (m) {
    this._stack.push(new THREE.Matrix4().multiplyMatrices(this.top(), m));
    return this;
  };
  Builder.prototype.pushXYZ = function (x, y, z, rx, ry, rz) {
    return this.push(makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.pop = function () { this._stack.pop(); return this; };
  Builder.prototype.add = function (key, geo, local) {
    var b = this.buckets[key] || (this.buckets[key] = []);
    var wm = new THREE.Matrix4();
    if (local) wm.multiplyMatrices(this.top(), local); else wm.copy(this.top());
    var e = {
      geometry: geo, matrix: wm, tint: this.tint,
      paint: this.paint, dark: this.dark, wear: this.wear
    };
    b.push(e); this.count++;
    return e;
  };
  Builder.prototype.box = function (key, w, h, d, x, y, z, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z));
  };
  Builder.prototype.boxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.cyl = function (key, r0, r1, len, x, y, z, rx, ry, rz, seg, open) {
    return this.add(key, cyl(r0, r1, len, seg, open), makeM(x, y, z, rx, ry, rz));
  };
  // A member between two arbitrary local points - the water tower, the racks
  // and every hangar truss are these.
  Builder.prototype.strut = function (key, ax, ay, az, bx, by, bz, w, d) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return null;
    var yaw = Math.atan2(dx, dz);
    var pitch = Math.acos(M.clamp(dy / len, -1, 1));
    var m = new THREE.Matrix4();
    _e1.set(pitch, yaw, 0, 'YXZ');
    m.makeRotationFromEuler(_e1);
    m.elements[12] = (ax + bx) * 0.5;
    m.elements[13] = (ay + by) * 0.5;
    m.elements[14] = (az + bz) * 0.5;
    return this.add(key, box(w, len, d || w), m);
  };
  Builder.prototype.worldPoint = function (x, y, z, out) {
    return (out || new THREE.Vector3()).set(x, y, z).applyMatrix4(this.top());
  };

  // =============================================================== THE PAD ===
  // The hardstanding is a settled, heat-cracked concrete slab, not a plane.
  // Slab bays, saw-cut joints, a shallow crown for drainage, forty years of
  // subgrade settlement and a worley crack field all come from one analytic
  // function, so sampleGround, the navgrid, the crack painting and the vertex
  // wear pass can never disagree about where the low spots and the cracks are.

  // Airfield slab bays. 7.62 m (25 ft) is the real pitch, and it is the single
  // strongest thing in a noon frame of bare concrete: it is what gives a 200 m
  // sheet scale, direction and a perspective grid to run the eye along.
  var BAY_PITCH = 7.62;
  function jointDip(x, z) {
    var a = ((x + 3.81) % BAY_PITCH + BAY_PITCH) % BAY_PITCH - BAY_PITCH * 0.5;
    var b = ((z + 1.9) % BAY_PITCH + BAY_PITCH) % BAY_PITCH - BAY_PITCH * 0.5;
    a = Math.abs(a); b = Math.abs(b);
    var d = 0;
    if (a < 0.075) d = (1 - a / 0.075) * 0.030;
    if (b < 0.075) d = Math.max(d, (1 - b / 0.075) * 0.030);
    return d;
  }

  // How close this point is to a heat crack, 0..1. A worley cell BOUNDARY is
  // exactly the shape thermal cracking takes on a big slab - polygonal cells
  // with three-way junctions - which a noise-threshold crack never looks like.
  function crackField(x, z, N) {
    var w = N.worley2(x * 0.085 + 11.4, z * 0.085 - 6.2, 1.0);
    var e = w.edge;
    var c = e < 0.070 ? (1 - e / 0.070) : 0;
    // a second, finer generation of craze inside the cells
    var w2 = N.worley2(x * 0.31 - 4.7, z * 0.31 + 8.3, 1.0);
    var c2 = w2.edge < 0.030 ? (1 - w2.edge / 0.030) * 0.42 : 0;
    return M.saturate(Math.max(c, c2));
  }

  function padGrade(x, z, N) {
    // 1:60 crown falling away from the taxiway centreline, so water (when it
    // ever comes) sheets off, and so the slab has a readable long section
    var y = -Math.abs(x) * 0.0078;
    y -= (N.fbm2(x * 0.017 + 3.1, z * 0.017 - 7.7, 3) * 0.5 + 0.5) * 0.26;
    // a long shallow settlement trough through the middle of the west field
    y -= M.smoothstep(0.0, 1.0, 1 - Math.abs(x + 51) / 34) * 0.10;
    return y;
  }

  function padY(x, z, N) {
    return padGrade(x, z, N)
      - jointDip(x, z)
      - crackField(x, z, N) * 0.022
      + N.fbm2(x * 0.95, z * 0.95, 2) * 0.009;
  }

  // The desert outside the pad. Low dunes, a wind-blown drift piled against the
  // pad edge, and creosote hummocks.
  function sandY(x, z, N) {
    var y = 0.06;
    y += N.fbm2(x * 0.012 - 5.5, z * 0.012 + 2.2, 3) * 0.9;
    y += N.fbm2(x * 0.075 + 1.7, z * 0.075 - 9.1, 2) * 0.16;
    return y;
  }

  // 1 inside the pad, 0 out in the desert, over a 7 m apron of drifted sand.
  function padMask(x, z) {
    var mx = Math.min(x - PAD_X0, PAD_X1 - x);
    var mz = Math.min(z - PAD_Z0, PAD_Z1 - z);
    return M.smoothstep(-1.5, 7.0, Math.min(mx, mz));
  }

  function groundY(x, z, N) {
    var t = padMask(x, z);
    if (t >= 0.999) return padY(x, z, N);
    if (t <= 0.001) return sandY(x, z, N);
    return M.lerp(sandY(x, z, N), padY(x, z, N), t);
  }

  // How much blown sand has settled here, 0..1. Sand drifts against anything
  // that stops the wind and thins out in the middle of open concrete, and it is
  // the warm half of this level's two-colour ground.
  function sandCover(x, z, N) {
    var edge = 1 - padMask(x, z);
    var d = M.saturate(N.fbm2(x * 0.035 + 21.0, z * 0.035 - 13.0, 3) * 0.55 + 0.42);
    return M.saturate(edge * 0.9 + d * 0.55);
  }

  // ============================================================== THE ATLAS ==
  // Alpha-tested stencils. Aircraft serials, walkway and danger stencils,
  // national insignia, and the ground bay numbers. Every level in this build
  // that reads as real has SOMETHING WRITTEN ON IT; a boneyard in particular is
  // covered in stencilling, because the whole point of the place is inventory.
  var ATLAS_N = 4;                         // 4 x 4 cells
  function atlasRect(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    return [cx / ATLAS_N, 1 - (cy + 1) / ATLAS_N, 1 / ATLAS_N, 1 / ATLAS_N];
  }
  function atlasUV(cell) {
    var r = atlasRect(cell);
    return [r[0] + 0.004, r[1] + 0.004, r[0] + r[2] - 0.004, r[1] + r[3] - 0.004];
  }

  function buildAtlas(rng) {
    var S = 1024, C = S / ATLAS_N;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, S, S);

    function cellOrigin(cell) {
      return [(cell % ATLAS_N) * C, ((cell / ATLAS_N) | 0) * C];
    }
    // Stencilled paint is never solid. Erode it so the edges break up and the
    // middle of every stroke has UV-faded holes in it.
    function erode(x0, y0, w, h, amount) {
      var img;
      try { img = g.getImageData(x0, y0, w, h); } catch (e) { return; }
      var d = img.data;
      for (var i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        var px = (i >> 2) % w, py = ((i >> 2) / w) | 0;
        var n = (Math.sin(px * 0.31 + py * 0.17) * 0.5 + Math.sin(px * 0.09 - py * 0.41) * 0.5);
        var f = 1 - amount * M.saturate(n * 0.5 + 0.5);
        d[i + 3] = d[i + 3] * f;
      }
      g.putImageData(img, x0, y0);
    }
    function text(cell, lines, col, size, weight, spacing) {
      var o = cellOrigin(cell);
      g.save();
      g.translate(o[0], o[1]);
      g.fillStyle = col;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      var n = lines.length;
      for (var i = 0; i < n; i++) {
        g.font = (weight || 700) + ' ' + Math.round(size) + 'px "Arial Narrow", "Segoe UI", system-ui, sans-serif';
        var y = C * (0.5 + (i - (n - 1) / 2) * (spacing || 0.30));
        g.fillText(lines[i], C * 0.5, y);
      }
      g.restore();
      erode(o[0], o[1], C, C, 0.42);
    }

    // 0 - the aircraft serial block, the biggest single stencil on any airframe
    text(0, ['AF 63-8047'], '#22262b', 46, 800);
    // 1 - a walkway / no-step warning
    text(1, ['NO STEP'], '#7d1c14', 54, 800);
    // 2 - intake danger
    text(2, ['DANGER', 'INTAKE'], '#7d1c14', 48, 800, 0.34);
    // 3 - the AMARG inventory tag: type code over a bay number
    text(3, ['AMARG', 'CB-114'], '#2b3138', 42, 700, 0.34);
    // 4 - rescue arrow
    (function () {
      var o = cellOrigin(4);
      g.save(); g.translate(o[0], o[1]);
      g.strokeStyle = '#b8a12c'; g.lineWidth = 9;
      g.beginPath();
      g.moveTo(C * 0.20, C * 0.62); g.lineTo(C * 0.62, C * 0.62);
      g.lineTo(C * 0.62, C * 0.44); g.lineTo(C * 0.84, C * 0.70);
      g.lineTo(C * 0.62, C * 0.94); g.lineTo(C * 0.62, C * 0.78);
      g.lineTo(C * 0.20, C * 0.78); g.closePath(); g.stroke();
      g.fillStyle = '#b8a12c';
      g.font = '700 40px "Arial Narrow", system-ui, sans-serif';
      g.textAlign = 'center'; g.fillText('RESCUE', C * 0.5, C * 0.26);
      g.restore();
      erode(o[0], o[1], C, C, 0.4);
    })();
    // 5 - national insignia, faded: star in a disc with bars
    (function () {
      var o = cellOrigin(5);
      g.save(); g.translate(o[0] + C * 0.5, o[1] + C * 0.5);
      g.fillStyle = 'rgba(30,44,86,0.86)';
      g.beginPath(); g.arc(0, 0, C * 0.20, 0, 6.28318); g.fill();
      g.fillRect(-C * 0.42, -C * 0.085, C * 0.42, C * 0.17);
      g.fillRect(0, -C * 0.085, C * 0.42, C * 0.17);
      g.fillStyle = 'rgba(226,224,214,0.92)';
      g.beginPath();
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5;
        var r = (i & 1) ? C * 0.075 : C * 0.185;
        if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill();
      g.fillRect(-C * 0.40, -C * 0.055, C * 0.38, C * 0.11);
      g.fillRect(C * 0.02, -C * 0.055, C * 0.38, C * 0.11);
      g.restore();
      erode(o[0], o[1], C, C, 0.5);
    })();
    // 6 - ejection seat triangle
    (function () {
      var o = cellOrigin(6);
      g.save(); g.translate(o[0] + C * 0.5, o[1] + C * 0.5);
      g.fillStyle = 'rgba(150,32,22,0.90)';
      g.beginPath();
      g.moveTo(0, -C * 0.30); g.lineTo(C * 0.30, C * 0.24); g.lineTo(-C * 0.30, C * 0.24);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(230,226,214,0.94)';
      g.font = '800 44px "Arial Narrow", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('!', 0, C * 0.02);
      g.restore();
      erode(o[0], o[1], C, C, 0.42);
    })();
    // 7 - unit tail code
    text(7, ['DM'], '#2b3138', 92, 800);
    // 8..11 - ground bay numbers, big and worn
    text(8, ['A-14'], '#cbb556', 76, 800);
    text(9, ['B-07'], '#cbb556', 76, 800);
    text(10, ['C-22'], '#cbb556', 76, 800);
    text(11, ['TOW'], '#cbb556', 66, 800);
    // 12 - a fuel / ground point placard
    text(12, ['GND', 'PWR'], '#2b3138', 44, 700, 0.34);
    // 13 - hangar door bay letter
    text(13, ['4'], '#22262b', 140, 800);
    // 14 - a long thin caution stripe run, for door edges
    (function () {
      var o = cellOrigin(14);
      g.save(); g.translate(o[0], o[1]);
      for (var i = -6; i < 14; i++) {
        g.fillStyle = (i & 1) ? 'rgba(190,166,54,0.92)' : 'rgba(38,40,44,0.92)';
        g.beginPath();
        g.moveTo(i * C * 0.16, 0); g.lineTo((i + 1) * C * 0.16, 0);
        g.lineTo((i + 1) * C * 0.16 - C * 0.34, C); g.lineTo(i * C * 0.16 - C * 0.34, C);
        g.closePath(); g.fill();
      }
      g.restore();
      erode(o[0], o[1], C, C, 0.30);
    })();
    // 15 - a scattered rivet/patch field, for hulls that have been opened
    (function () {
      var o = cellOrigin(15);
      g.save(); g.translate(o[0], o[1]);
      g.strokeStyle = 'rgba(58,54,48,0.55)'; g.lineWidth = 3;
      g.strokeRect(C * 0.14, C * 0.18, C * 0.70, C * 0.60);
      g.fillStyle = 'rgba(72,66,58,0.42)';
      for (var i = 0; i < 46; i++) {
        var rx = C * (0.14 + rng.next() * 0.70), ry = C * (0.18 + rng.next() * 0.60);
        g.beginPath(); g.arc(rx, ry, 2.6, 0, 6.28318); g.fill();
      }
      g.restore();
    })();

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;   // this is an ALBEDO atlas
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // A stencil card. `axis` picks the plane: 'y' lies flat on the ground, 'x'
  // faces +/-X, 'z' faces +/-Z.
  function decalCard(B, cell, x, y, z, w, h, axis, s, roll) {
    var uv = atlasUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var m;
    if (axis === 'y') m = makeM(x, y, z, -Math.PI * 0.5, roll || 0, 0);
    else if (axis === 'x') m = makeM(x, y, z, 0, (s < 0 ? -1 : 1) * Math.PI * 0.5, roll || 0);
    else m = makeM(x, y, z, 0, s < 0 ? Math.PI : 0, roll || 0);
    B.add('decal', g, m);
  }

  // Chain-link, as an alpha-tested texture rather than as geometry: a 240 m
  // perimeter of modelled wire is unaffordable and unnecessary.
  var _chainTex = null;
  function chainLinkTexture() {
    if (_chainTex) return _chainTex;
    var S = 128;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    g.strokeStyle = '#b8bcc0';
    g.lineWidth = 4.0;
    g.lineCap = 'round';
    var p = S / 4;
    for (var i = -1; i <= 4; i++) {
      g.beginPath();
      for (var k = -1; k <= 4; k++) {
        g.moveTo(i * p, k * p); g.lineTo((i + 1) * p, (k + 1) * p);
        g.moveTo((i + 1) * p, k * p); g.lineTo(i * p, (k + 1) * p);
      }
      g.stroke();
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    _chainTex = tex;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // A tangent-space normal map from a height canvas, WRAPPED. Every map this
  // file authors tiles across a world-space projection, so a Sobel that clamps
  // at the border puts a visible seam on every joint line in the yard.
  // ---------------------------------------------------------------------------
  function normalFromCanvas(canvas, strength) {
    if (!canvas) return null;
    var g = canvas.getContext('2d');
    if (!g) return null;
    var S = canvas.width, d;
    try { d = g.getImageData(0, 0, S, S).data; } catch (e) { return null; }
    var h = new Float32Array(S * S), i;
    for (i = 0; i < S * S; i++) h[i] = d[i * 4] / 255;
    var out = new Uint8Array(S * S * 4);
    var k = strength === undefined ? 2.4 : strength;
    for (var y = 0; y < S; y++) {
      var ym = (y - 1 + S) % S, yp = (y + 1) % S;
      for (var x = 0; x < S; x++) {
        var xm = (x - 1 + S) % S, xp = (x + 1) % S;
        var dx = (h[ym * S + xp] + 2 * h[y * S + xp] + h[yp * S + xp]) -
                 (h[ym * S + xm] + 2 * h[y * S + xm] + h[yp * S + xm]);
        var dy = (h[yp * S + xm] + 2 * h[yp * S + x] + h[yp * S + xp]) -
                 (h[ym * S + xm] + 2 * h[ym * S + x] + h[ym * S + xp]);
        var nx = -dx * k, ny = -dy * k, nz = 1;
        var il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        var o = (y * S + x) * 4;
        out[o] = (nx * il * 0.5 + 0.5) * 255;
        out[o + 1] = (ny * il * 0.5 + 0.5) * 255;
        out[o + 2] = (nz * il * 0.5 + 0.5) * 255;
        out[o + 3] = 255;
      }
    }
    var t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;          // NOT an albedo map
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  // ============================================================ THE SKIN MAP ==
  // A 6 m tile of aeroplane. 1024 texels over 6 m is 171 texels/m, which puts a
  // 1.5 m panel at 256 texels, a lap joint at 3 and a rivet pitch at 6 - i.e.
  // every feature resolves at the 4-20 m the airframes are actually read from,
  // which is the whole reason this exists rather than a library tile at 0.38 m.
  //
  // Authored so the MEAN lands near 0xa8adb0: the shaded-side albedo target the
  // review asked for. Panel-to-panel value steps are +/-8%, which is what a
  // patchwork of mismatched alloys and thirty-year-old repaints actually is; go
  // wider and it reads as camouflage.
  var SKIN_TILE = 6.0;
  var _skinMaps = null;

  function buildSkinMaps(rng) {
    if (_skinMaps) return _skinMaps;
    if (typeof document === 'undefined') return null;
    var S = 1024;
    function cv() { var c = document.createElement('canvas'); c.width = c.height = S; return c; }
    var ac = cv(), hc = cv(), rc = cv();
    var A = ac.getContext('2d'), H = hc.getContext('2d'), R = rc.getContext('2d');
    if (!A || !H || !R) return null;

    // Panel lattice. Irregular on purpose - a ruled grid is the "perfectly
    // uniform anything" the quality bar rejects, and a real fuselage is bays of
    // different length between frames anyway.
    var colF = [0.265, 0.225, 0.295, 0.215];
    var rowF = [0.240, 0.285, 0.210, 0.265];
    var cols = [0], rows = [0], i, j, acc = 0;
    for (i = 0; i < colF.length; i++) { acc += colF[i]; cols.push(Math.round(acc * S)); }
    acc = 0;
    for (i = 0; i < rowF.length; i++) { acc += rowF[i]; rows.push(Math.round(acc * S)); }
    cols[cols.length - 1] = S; rows[rows.length - 1] = S;

    // #b8b4ab, not #b0b4b5: two changes, both about where this surface sits in
    // the histogram rather than about the surface itself.
    //  * WARM, not cool. The old base had b > r, so sunlit alclad rendered
    //    dead neutral - the warm key and the blue sky it half-mirrors at
    //    metalness 0.38 cancelled - and on hero1 the aluminium IS the top 15%
    //    of the frame, so the frame's highlight tint came out at r-b = +0.004
    //    and the colour grade measured as absent. Twenty-year chalked alclad
    //    in the Sonoran desert is a warm grey, not a cool one.
    //  * BRIGHTER, via SKIN_GAIN at the end of this function.
    A.fillStyle = '#b8b4ab'; A.fillRect(0, 0, S, S);
    H.fillStyle = '#808080'; H.fillRect(0, 0, S, S);
    R.fillStyle = '#6e6e6e'; R.fillRect(0, 0, S, S);     // 0.43 base roughness

    // ---- panel fields ------------------------------------------------------
    // +/-4.5%, not +/-7.5%. At the wider spread the first capture came back
    // with a fuselage that read as disruptive CAMOUFLAGE rather than as
    // mismatched alloy - a value step you can name is already too big.
    var STEPS = [0.958, 0.980, 1.0, 1.022, 1.045];
    var HUES = [[0, 0, 0], [2, 1, -2], [-1, -1, 1], [3, 1, -1], [-2, -1, -1]];
    for (j = 0; j < rowF.length; j++) {
      for (i = 0; i < colF.length; i++) {
        var k = (i * 3 + j * 5 + ((rng.next() * 5) | 0)) % STEPS.length;
        var v = STEPS[k], hu = HUES[(i + j * 2) % HUES.length];
        var cr = M.clamp(0xb8 * v + hu[0], 0, 255) | 0;
        var cg = M.clamp(0xb4 * v + hu[1], 0, 255) | 0;
        var cb = M.clamp(0xab * v + hu[2], 0, 255) | 0;
        A.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
        A.fillRect(cols[i], rows[j], cols[i + 1] - cols[i], rows[j + 1] - rows[j]);
        // roughness follows the repaint: a resprayed panel is duller
        var rv = (0x60 + k * 5) | 0;
        R.fillStyle = 'rgb(' + rv + ',' + rv + ',' + rv + ')';
        R.fillRect(cols[i], rows[j], cols[i + 1] - cols[i], rows[j + 1] - rows[j]);
      }
    }

    // ---- differential fade: slow chalking across the tile ------------------
    for (i = 0; i < 26; i++) {
      var bx = rng.range(-0.1, 1.1) * S, by = rng.range(-0.1, 1.1) * S;
      var br = rng.range(0.10, 0.30) * S;
      var gr = A.createRadialGradient(bx, by, 0, bx, by, br);
      var up = rng.bool ? rng.bool(0.5) : (rng.next() < 0.5);
      gr.addColorStop(0, up ? 'rgba(226,228,226,0.13)' : 'rgba(140,142,141,0.11)');
      gr.addColorStop(1, 'rgba(180,182,181,0)');
      A.fillStyle = gr;
      A.beginPath(); A.arc(bx, by, br, 0, 6.28318); A.fill();
    }

    // ---- lap joints, rivet rows, stringers ---------------------------------
    function lapV(x) {
      // the lap STEP: a dark line with a lit crest on the overlapping side
      A.fillStyle = 'rgba(96,100,102,0.72)'; A.fillRect(x - 1.5, 0, 3, S);
      A.fillStyle = 'rgba(206,208,206,0.30)'; A.fillRect(x + 1.5, 0, 1.5, S);
      H.fillStyle = 'rgba(40,40,40,1)'; H.fillRect(x - 1.5, 0, 3, S);
      H.fillStyle = 'rgba(170,170,170,1)'; H.fillRect(x + 1.5, 0, 2, S);
      R.fillStyle = 'rgba(150,150,150,0.85)'; R.fillRect(x - 2, 0, 5, S);
    }
    function lapH(y) {
      A.fillStyle = 'rgba(96,100,102,0.72)'; A.fillRect(0, y - 1.5, S, 3);
      A.fillStyle = 'rgba(206,208,206,0.30)'; A.fillRect(0, y + 1.5, S, 1.5);
      H.fillStyle = 'rgba(40,40,40,1)'; H.fillRect(0, y - 1.5, S, 3);
      H.fillStyle = 'rgba(170,170,170,1)'; H.fillRect(0, y + 1.5, S, 2);
      R.fillStyle = 'rgba(150,150,150,0.85)'; R.fillRect(0, y - 2, S, 5);
    }
    // rivet run: dots at a 6 texel (3.5 cm) pitch, drawn into all three maps
    function rivetsV(x, y0, y1, pitch) {
      for (var y = y0; y < y1; y += pitch) {
        A.fillStyle = 'rgba(122,126,128,0.55)';
        A.beginPath(); A.arc(x, y, 1.25, 0, 6.28318); A.fill();
        H.fillStyle = 'rgba(196,196,196,0.9)';
        H.beginPath(); H.arc(x, y, 1.35, 0, 6.28318); H.fill();
        R.fillStyle = 'rgba(140,140,140,0.7)';
        R.beginPath(); R.arc(x, y, 1.6, 0, 6.28318); R.fill();
      }
    }
    function rivetsH(y, x0, x1, pitch) {
      for (var x = x0; x < x1; x += pitch) {
        A.fillStyle = 'rgba(122,126,128,0.55)';
        A.beginPath(); A.arc(x, y, 1.25, 0, 6.28318); A.fill();
        H.fillStyle = 'rgba(196,196,196,0.9)';
        H.beginPath(); H.arc(x, y, 1.35, 0, 6.28318); H.fill();
        R.fillStyle = 'rgba(140,140,140,0.7)';
        R.beginPath(); R.arc(x, y, 1.6, 0, 6.28318); R.fill();
      }
    }
    for (i = 0; i < cols.length; i++) {
      var cx2 = cols[i];
      lapV(cx2);
      rivetsV(cx2 - 5, 0, S, 6); rivetsV(cx2 + 6, 0, S, 6);
      if (cx2 === 0) { lapV(S); rivetsV(S - 5, 0, S, 6); }
    }
    for (j = 0; j < rows.length; j++) {
      var ry2 = rows[j];
      lapH(ry2);
      rivetsH(ry2 - 5, 0, S, 6); rivetsH(ry2 + 6, 0, S, 6);
      if (ry2 === 0) { lapH(S); rivetsH(S - 5, 0, S, 6); }
    }
    // intermediate stringers: rivets only, no lap step, every ~0.55 m
    for (j = 0; j < rowF.length; j++) {
      var h0 = rows[j], h1 = rows[j + 1], nS = Math.max(1, Math.round((h1 - h0) / 94));
      for (i = 1; i < nS; i++) rivetsH(h0 + (h1 - h0) * i / nS, 0, S, 7);
    }

    // ---- repair patches ----------------------------------------------------
    // Two doublers, riveted on, in a value that does not match the skin under
    // them. The single most boneyard-specific mark an airframe carries.
    var patches = [[0.10, 0.56, 0.20, 0.15]];
    for (i = 0; i < patches.length; i++) {
      var p = patches[i];
      var px = p[0] * S, py = p[1] * S, pw = p[2] * S, ph = p[3] * S;
      A.fillStyle = i ? 'rgba(166,164,153,0.80)' : 'rgba(182,184,180,0.80)';
      A.fillRect(px, py, pw, ph);
      H.fillStyle = 'rgba(148,148,148,1)'; H.fillRect(px, py, pw, ph);
      H.strokeStyle = 'rgba(58,58,58,1)'; H.lineWidth = 2.5;
      H.strokeRect(px, py, pw, ph);
      A.strokeStyle = 'rgba(92,96,98,0.70)'; A.lineWidth = 2.5;
      A.strokeRect(px, py, pw, ph);
      R.fillStyle = i ? 'rgba(190,190,190,1)' : 'rgba(120,120,120,1)';
      R.fillRect(px, py, pw, ph);
      rivetsH(py + 4, px + 4, px + pw - 3, 7);
      rivetsH(py + ph - 4, px + 4, px + pw - 3, 7);
      rivetsV(px + 4, py + 4, py + ph - 3, 7);
      rivetsV(px + pw - 4, py + 4, py + ph - 3, 7);
    }

    // ---- streaking and grain ------------------------------------------------
    // Hydraulic and exhaust runs travel with gravity, i.e. down v, and they are
    // the only thing on a skin that is not aligned to the panel grid.
    for (i = 0; i < 34; i++) {
      var sx = rng.next() * S, sy = rng.next() * S;
      var sl = rng.range(0.06, 0.30) * S;
      var sg = A.createLinearGradient(sx, sy, sx, sy + sl);
      sg.addColorStop(0, 'rgba(96,90,80,0.30)');
      sg.addColorStop(1, 'rgba(120,116,108,0)');
      A.fillStyle = sg;
      A.fillRect(sx - rng.range(1, 4), sy, rng.range(2, 8), sl);
    }
    // fine tooling grain, per pixel, tiny amplitude: this is the layer that
    // stops a flat panel fill reading as flat, and it is deliberately kept
    // below 3% so it cannot become the confetti it replaces.
    // ---- SKIN_GAIN ---------------------------------------------------------
    // A single MULTIPLICATIVE lift on the finished albedo, folded into the
    // grain pass so it costs nothing. 1.117 in 8-bit sRGB is x1.28 in linear,
    // i.e. a third of a stop, and because it is a multiply every contrast
    // ratio the map was authored with - lap step to pan, rivet to skin, repair
    // patch to parent panel - survives it exactly.
    //
    // Why the airframes needed it: the slab and bare alclad were sitting at
    // linear 0.381 and 0.451, an 18% separation, so 34 aeroplanes and 200 m of
    // concrete printed inside five grey levels and the establishing shot had
    // no figure/ground at all. Half the correction is the slab coming down
    // (SURF.hardstand) and half is this, which also puts sunlit skin near the
    // top of the tone curve where the brief's "bleached highlights" live: the
    // level measured blown_white 0.00% on every frame, which for a noon
    // aluminium boneyard is not a clean bill of health, it is a missing
    // highlight.
    //
    // The two derived materials multiply this map by a colour, so their tints
    // are divided by the same 1.28 in _skinMaterial's callers - if you change
    // this number, change those two with it.
    var SKIN_GAIN = 1.117;
    try {
      var img = A.getImageData(0, 0, S, S), da = img.data;
      var him = H.getImageData(0, 0, S, S), dh = him.data;
      for (i = 0; i < S * S; i++) {
        var gx = i % S, gy = (i / S) | 0;
        var n = Math.sin(gx * 0.9 + gy * 0.31) * 0.5 + Math.sin(gx * 0.21 - gy * 1.07) * 0.5;
        var f = SKIN_GAIN * (1 + n * 0.022);
        da[i * 4] = M.clamp(da[i * 4] * f, 0, 255);
        da[i * 4 + 1] = M.clamp(da[i * 4 + 1] * f, 0, 255);
        da[i * 4 + 2] = M.clamp(da[i * 4 + 2] * f, 0, 255);
        var hv = dh[i * 4] + n * 5;
        dh[i * 4] = dh[i * 4 + 1] = dh[i * 4 + 2] = M.clamp(hv, 0, 255);
      }
      A.putImageData(img, 0, 0);
      H.putImageData(him, 0, 0);
    } catch (e) { /* tainted canvas: the drawn layers still carry the read */ }

    function mk(canvas, srgb) {
      var t = new THREE.CanvasTexture(canvas);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    }
    _skinMaps = {
      map: mk(ac, true),
      roughnessMap: mk(rc, false),
      normalMap: normalFromCanvas(hc, 1.9)
    };
    return _skinMaps;
  }

  // =========================================================== THE PAD LAYER ==
  // The joint lattice and the heat craze, as a world-aligned alpha overlay.
  //
  // These belong in TEXTURE, not geometry, and the reason is arithmetic: a
  // sawn bay joint is 15 cm wide and a craze crack is 1 cm, while the pad is
  // built on a 1.5 m vertex step. Both features are two orders of magnitude
  // below the mesh and were aliased out of it completely - the brief's
  // "hardstanding cracked by heat" photographed as one unbroken sheet of grain
  // with no slab edge, no joint, no crack and no spall anywhere in it.
  //
  // The tile is 15.24 m - exactly TWO bays of the 7.62 m (25 ft) airfield
  // pitch that jointDip() uses - and the joints are drawn at the pixel rows and
  // columns that the world UV puts the real bay lines on, so the painted joint
  // and the modelled dip are the same joint.
  var CRACK_TILE = 15.24;
  var _crackTex = null;

  function buildCrackTexture(rng) {
    if (_crackTex) return _crackTex;
    if (typeof document === 'undefined') return null;
    var S = 1024, i, k;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    var PX = S / CRACK_TILE;                   // 67 texels per metre

    // jointDip puts the x joints at x = -3.81 + k*7.62 and the z joints at
    // z = -1.90 + k*7.62. worldUV maps u = x/15.24, v = z/15.24, and three
    // flips v, so the canvas rows are (1 - v) * S.
    var uJ = [0.25, 0.75];
    var vJ = [0.375, 0.875];

    // ---- a sealed saw-cut joint --------------------------------------------
    // 15 cm of black tar sealant with a spalled, slightly paler lip either
    // side, and it wanders by a couple of centimetres because a saw follows a
    // chalk line held by a person.
    function joint(px, vertical) {
      var w = 0.15 * PX;
      var steps = 64;
      for (var s = 0; s < steps; s++) {
        var t0 = s / steps * S, t1 = (s + 1) / steps * S;
        var wob = Math.sin(s * 0.7 + px * 0.03) * 1.2 + Math.sin(s * 0.23) * 0.9;
        var a = 0.62 + 0.26 * (Math.sin(s * 1.31 + px) * 0.5 + 0.5);
        g.fillStyle = 'rgba(38,35,32,' + a.toFixed(3) + ')';
        if (vertical) g.fillRect(px + wob - w * 0.5, t0, w, t1 - t0 + 1);
        else g.fillRect(t0, px + wob - w * 0.5, t1 - t0 + 1, w);
        // the spall lip: bare aggregate, PALER than the slab
        g.fillStyle = 'rgba(214,206,190,0.30)';
        if (vertical) g.fillRect(px + wob - w * 0.5 - 2.4, t0, 2.4, t1 - t0 + 1);
        else g.fillRect(t0, px + wob - w * 0.5 - 2.4, t1 - t0 + 1, 2.4);
      }
    }
    for (i = 0; i < uJ.length; i++) joint(uJ[i] * S, true);
    for (i = 0; i < vJ.length; i++) joint((1 - vJ[i]) * S, false);

    // ---- heat craze ---------------------------------------------------------
    // Polygonal cells with three-way junctions, which is the shape thermal
    // cracking actually takes on a big slab; a noise threshold never looks like
    // one. Built as a nearest-neighbour network over jittered seeds, drawn nine
    // times on a wrapped offset so the tile is seamless.
    var seeds = [];
    for (i = 0; i < 46; i++) seeds.push([rng.next() * S, rng.next() * S]);
    var edges = [];
    for (i = 0; i < seeds.length; i++) {
      var best = [], bi;
      for (k = 0; k < seeds.length; k++) {
        if (k === i) continue;
        var ddx = seeds[k][0] - seeds[i][0], ddz = seeds[k][1] - seeds[i][1];
        // wrap to the nearest image
        if (ddx > S * 0.5) ddx -= S; if (ddx < -S * 0.5) ddx += S;
        if (ddz > S * 0.5) ddz -= S; if (ddz < -S * 0.5) ddz += S;
        best.push([ddx * ddx + ddz * ddz, ddx, ddz]);
      }
      best.sort(function (p, q) { return p[0] - q[0]; });
      for (bi = 0; bi < 3 && bi < best.length; bi++) {
        edges.push([seeds[i][0], seeds[i][1],
          seeds[i][0] + best[bi][1], seeds[i][1] + best[bi][2]]);
      }
    }
    function craze(ox, oy) {
      for (var e = 0; e < edges.length; e++) {
        var E = edges[e];
        var x0 = E[0] + ox, y0 = E[1] + oy, x1 = E[2] + ox, y1 = E[3] + oy;
        var segs = 6;
        g.lineCap = 'round';
        for (var s = 0; s < segs; s++) {
          var f0 = s / segs, f1 = (s + 1) / segs;
          // a crack is not continuous: a third of every run has healed over
          if (((e * 7 + s * 3) % 11) < 3) continue;
          var jx = Math.sin(e * 2.7 + s * 1.9) * 5.0;
          var jy = Math.cos(e * 3.1 + s * 2.3) * 5.0;
          g.strokeStyle = 'rgba(52,47,42,' + (0.30 + ((e + s) % 5) * 0.09).toFixed(2) + ')';
          g.lineWidth = 1.1 + ((e + s) % 3) * 0.5;
          g.beginPath();
          g.moveTo(M.lerp(x0, x1, f0) + jx, M.lerp(y0, y1, f0) + jy);
          g.lineTo(M.lerp(x0, x1, f1) + jx * 0.4, M.lerp(y0, y1, f1) + jy * 0.4);
          g.stroke();
        }
      }
    }
    for (i = -1; i <= 1; i++) for (k = -1; k <= 1; k++) craze(i * S, k * S);

    // ---- spalling and FOD ---------------------------------------------------
    for (i = 0; i < 120; i++) {
      var sx2 = rng.next() * S, sy2 = rng.next() * S;
      var sr = rng.range(1.4, 5.5);
      g.fillStyle = 'rgba(66,60,52,' + rng.range(0.10, 0.30).toFixed(2) + ')';
      g.beginPath(); g.ellipse(sx2, sy2, sr, sr * rng.range(0.5, 1.0), rng.range(0, 3), 0, 6.28318);
      g.fill();
    }
    // patched pop-outs: pale aggregate where a lump has come out and been made
    // good with a different mix
    for (i = 0; i < 26; i++) {
      var qx = rng.next() * S, qy = rng.next() * S, qr = rng.range(5, 17);
      var qg = g.createRadialGradient(qx, qy, 0, qx, qy, qr);
      qg.addColorStop(0, 'rgba(206,198,182,0.34)');
      qg.addColorStop(1, 'rgba(206,198,182,0)');
      g.fillStyle = qg;
      g.beginPath(); g.arc(qx, qy, qr, 0, 6.28318); g.fill();
    }

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    _crackTex = tex;
    return tex;
  }

  // ============================================================ AIRCRAFT KIT ==
  // Every airframe in the yard is composed from these five primitives. They are
  // all authored in ONE local frame:  nose toward -Z, starboard toward +X, and
  // y = 0 at the ground under the aircraft. A `yaw` of 0 therefore points the
  // nose north, which is the same convention spawnPoints and anchors use.
  //
  // The reason there is a kit at all rather than one hand-built hero and a lot
  // of boxes: a boneyard is a REPETITION of a small number of shapes, and the
  // instant-fail list has "geometry with no silhouette detail - boxes standing
  // in for objects" at the top of it. A parametric fuselage and a parametric
  // wing cost the same to write once and let thirty-four aircraft each have a
  // real ogive nose, a real upswept tail, a real tapered swept wing and real
  // podded engines.
  // ---------------------------------------------------------------------------

  // A fuselage cross-section: not a circle. Real fuselages are ovoid, with a
  // flattened belly where the floor beam runs and a slightly domed crown.
  function fuseRing(z, r, ry, yc, segs, flat) {
    var ring = [], i;
    for (i = 0; i < segs; i++) {
      var a = (i / segs) * Math.PI * 2;
      var s = Math.sin(a), c = Math.cos(a);
      var rr = r, rrv = ry;
      if (c < 0 && flat) rrv = ry * (1 - flat * (-c) * 0.55);
      ring.push([s * rr, yc + c * rrv, z]);
    }
    return ring;
  }

  // Radius profile along a transport/fighter fuselage. t = 0 at the nose.
  function fuseProfile(t, spec) {
    var R = spec.r;
    var noseT = spec.noseT || 0.16;
    var tailT = spec.tailT || 0.60;
    if (t < noseT) {
      // von Karman-ish ogive rather than a cone: the highlight that runs round
      // a real nose is a curve, and a cone gives a straight one
      var u = t / noseT;
      return R * Math.pow(Math.sin(u * Math.PI * 0.5), 0.62);
    }
    if (t <= tailT) return R;
    var v = (t - tailT) / (1 - tailT);
    return R * (1 - Math.pow(v, 1.55) * (spec.tailCut === undefined ? 0.80 : spec.tailCut));
  }

  function fuseYc(t, spec) {
    // tail upsweep, and a slight nose droop on transports
    var up = spec.upsweep === undefined ? 0.55 : spec.upsweep;
    var tailT = spec.tailT || 0.60;
    var y = spec.centreY;
    if (t > tailT) y += up * Math.pow((t - tailT) / (1 - tailT), 1.9) * spec.r;
    if (t < 0.10) y -= (spec.droop || 0) * spec.r * Math.pow(1 - t / 0.10, 2);
    return y;
  }

  // Build a fuselage into the builder. Returns useful measurements so the
  // caller can hang wings, gear and stencils off real numbers.
  function buildFuselage(B, L, spec, key) {
    var segs = spec.segs || 14;
    var nst = spec.stations || 20;
    var len = spec.len, half = len * 0.5;
    var rings = [], i;
    for (i = 0; i <= nst; i++) {
      var t = i / nst;
      var z = -half + t * len;
      var r = Math.max(0.035, fuseProfile(t, spec));
      var ry = r * (spec.ovoid === undefined ? 1.06 : spec.ovoid);
      rings.push(fuseRing(z, r, ry, fuseYc(t, spec), segs, spec.flat === undefined ? 0.35 : spec.flat));
    }
    B.add(key || 'airframe', ringLoft(rings, true), null);
    // The tail is CUT, not closed to a point: an APU exhaust or a severed
    // section. Either way the rim catches the light.
    B.add(key || 'airframe', ringCap(rings[rings.length - 1], false), null);
    B.add(key || 'airframe', ringCap(rings[0], true), null);
    return rings;
  }

  // ---------------------------------------------------------------------------
  // LAP JOINTS, AS GEOMETRY.
  //
  // Measured on the signature frame: mean local gradient over the fuselage
  // flank of a 44 m airliner at 20 m was 2.92, against 5.10 for the concrete
  // beside it - the thing the eye is meant to land on was the FLATTEST large
  // object in the frame. A fuselage is not a smooth tube. It is 1.5-2.5 m
  // barrel sections joined by straps that stand 8-12 mm proud of the skin with
  // a rivet row down each side, and at 20-25 m that step is the single biggest
  // piece of information the surface carries.
  //
  // It cannot come from the map. A normal map on a metal surface gives a
  // shading wobble; what a lap step gives is a LIT CREST with a hairline
  // shadow under it, and under a hard overhead key that is a real, moving
  // highlight that follows the camera. So it is four rings - up the ramp,
  // across the strap, back down - lofted round the same profile the hull uses,
  // which means it hugs the body exactly and the vertex normals give the crest
  // a proper specular edge.
  //
  // ~96 triangles a strap, ~1.3k a transport, and every one of them lands in
  // the existing 'airframe' merge bucket: the cost is triangles, of which this
  // level has 2.7M spare, and exactly zero extra draw calls.
  // ---------------------------------------------------------------------------
  function fuseLapStraps(B, spec, key, pitch, proud) {
    var half = spec.len * 0.5;
    var segs = spec.segs;
    var flat = spec.flat === undefined ? 0.35 : spec.flat;
    var ov = spec.ovoid === undefined ? 1.06 : spec.ovoid;
    var w = M.clamp(spec.len * 0.0032, 0.035, 0.085);
    // Stations are ABSOLUTE multiples of the pitch in the airframe's own frame,
    // not fractions of its length, so they land on exactly the boundaries
    // _paint's station grid bands against - the modelled joint and the painted
    // one are the same joint. Off the nose ogive and the tail cut, where a
    // strap would stand clear of the skin.
    var k0 = Math.ceil((-half + spec.len * 0.145) / pitch);
    var k1 = Math.floor((-half + spec.len * 0.885) / pitch);
    for (var kk = k0; kk <= k1; kk++) {
      var z = kk * pitch;
      var t = (z + half) / spec.len;
      var r = Math.max(0.035, fuseProfile(t, spec)) + 0.0015;
      var yc = fuseYc(t, spec);
      var rp = r + proud;
      B.add(key || 'airframe', ringLoft([
        fuseRing(z - w, r, r * ov, yc, segs, flat),
        fuseRing(z - w * 0.42, rp, rp * ov, yc, segs, flat),
        fuseRing(z + w * 0.42, rp, rp * ov, yc, segs, flat),
        fuseRing(z + w, r, r * ov, yc, segs, flat)
      ], true), null);
    }
  }

  // ---- the wing -------------------------------------------------------------
  // NACA-style thickness distribution. Six points a side is enough at the range
  // these are seen from and the leading edge still rounds properly, which is
  // the only part a raking key actually shows.
  var AF_U = [0.0, 0.025, 0.08, 0.18, 0.34, 0.55, 0.78, 1.0];
  function afThick(u) {
    return 5.0 * (0.2969 * Math.sqrt(u) - 0.1260 * u - 0.3516 * u * u +
      0.2843 * u * u * u - 0.1015 * u * u * u * u);
  }

  // One wing panel, root at x = 0 running out to +x. `spec`:
  //   span (semi-span), rootC, tipC, sweep (rad, LE), dihedral (rad),
  //   thick (t/c at root), tipThick, rootZ (LE z at the root), y (root height),
  //   twist (washout, rad at the tip)
  function wingPanel(spec) {
    var ns = spec.sections || 5;
    var US = spec.us || AF_U;
    var rings = [], i, k;
    for (i = 0; i <= ns; i++) {
      var f = i / ns;
      var x = f * spec.span;
      var c = M.lerp(spec.rootC, spec.tipC, f);
      var zle = spec.rootZ + x * Math.tan(spec.sweep);
      var y = spec.y + x * Math.tan(spec.dihedral);
      var th = M.lerp(spec.thick, spec.tipThick === undefined ? spec.thick * 0.78 : spec.tipThick, f) * c;
      var tw = -(spec.twist || 0) * f;
      var ring = [];
      // upper surface nose -> tail, then lower surface tail -> nose
      for (k = 0; k < US.length; k++) {
        var u = US[k];
        var zz = u * c, yy = afThick(u) * th * 0.5 * 1.06;
        ring.push([x, y + yy * Math.cos(tw) + zz * Math.sin(tw) * 0, zle + zz]);
      }
      for (k = US.length - 1; k >= 0; k--) {
        var u2 = US[k];
        var zz2 = u2 * c, yy2 = -afThick(u2) * th * 0.5 * 0.74;
        ring.push([x, y + yy2, zle + zz2]);
      }
      // shift for washout: rotate the section about its quarter chord
      if (tw) {
        var qz = zle + c * 0.25;
        for (k = 0; k < ring.length; k++) {
          var dz = ring[k][2] - qz, dy = ring[k][1] - y;
          ring[k][2] = qz + dz * Math.cos(tw) - dy * Math.sin(tw);
          ring[k][1] = y + dz * Math.sin(tw) + dy * Math.cos(tw);
        }
      }
      rings.push(ring);
    }
    return rings;
  }

  // ---------------------------------------------------------------------------
  // A WING IS NOT ONE VALUE.
  //
  // The critique that produced this: "the far transport's wing crosses 500 px
  // of frame as a solid bar at 0.051 sRGB median with zero internal value
  // break - no leading-edge highlight, no flap track, no aileron split". That
  // is true of the loft as it stood: one closed surface, one tint, one shading
  // solution across seven metres of chord.
  //
  // A real wing is three surfaces with real gaps between them, and each catches
  // the key differently: the torsion box (leading 68% of chord, the brightest
  // because its upper skin faces up), the flap/aileron behind it (drooped a
  // degree or two, a step darker), and the slot between them, which under a
  // hard sun is a black line the whole span. Splitting the loft chordwise gives
  // all three for the cost of one extra ring set - and it gives the shaded
  // UNDERSIDE a rib line as well, which is what makes a stored panel readable.
  var UMAIN = null, UCTRL = null;
  function splitUs(split) {
    var i;
    if (!UMAIN || UMAIN._s !== split) {
      UMAIN = [];
      for (i = 0; i < AF_U.length; i++) UMAIN.push(AF_U[i] * split);
      UMAIN._s = split;
      UCTRL = [];
      var base = [0, 0.05, 0.15, 0.32, 0.55, 0.78, 1.0];
      for (i = 0; i < base.length; i++) UCTRL.push(split + 0.022 + (1 - split - 0.022) * base[i]);
    }
    return [UMAIN, UCTRL];
  }

  function loftPanel(B, spec, key, mirror, us) {
    var s2 = {}, kk;
    for (kk in spec) if (Object.prototype.hasOwnProperty.call(spec, kk)) s2[kk] = spec[kk];
    s2.us = us;
    var rings = wingPanel(s2);
    var i, k;
    if (mirror) {
      for (i = 0; i < rings.length; i++) {
        for (k = 0; k < rings[i].length; k++) rings[i][k][0] = -rings[i][k][0];
      }
      rings.reverse();
    }
    B.add(key || 'airframe', ringLoft(rings, true), null);
    B.add(key || 'airframe', ringCap(rings[mirror ? 0 : rings.length - 1], !mirror), null);
    return rings;
  }

  var _ctrlTint = new THREE.Color();

  function buildWing(B, spec, key, mirror) {
    // Anything under ~1.5 m of chord is a stabiliser tip or a rack shelf and a
    // 2 cm hinge slot in it is sub-pixel: those stay one piece.
    var split = spec.split;
    if (split === undefined) split = (spec.rootC > 1.6 && spec.span > 1.2) ? 0.68 : 0;
    if (!split) return loftPanel(B, spec, key, mirror, spec.us || AF_U);
    var us = splitUs(split);
    var rings = loftPanel(B, spec, key, mirror, us[0]);
    var old = B.tint;
    // the control surface, a step darker: it is drooped, so its upper skin
    // faces the key at a different angle and it is usually a later repaint
    if (old) _ctrlTint.setRGB(old.r * 0.90, old.g * 0.90, old.b * 0.91);
    else _ctrlTint.setRGB(0.90, 0.90, 0.91);
    B.tint = _ctrlTint;
    loftPanel(B, spec, key, mirror, us[1]);
    B.tint = old;
    return rings;
  }

  // Rib and spar structure on the UNDERSIDE of a panel. A stored wing seen from
  // below is the most information-dense object in a parts yard and it was the
  // least: a flat black sheet at 8 m from the lens. Ribs cost 7 boxes.
  function wingUnderRibs(B, spec, key, mirror, s) {
    var old = B.tint, oldP = B.paint;
    B.tint = null; B.paint = 'metal';
    var n = 6, i;
    var sgn = mirror ? -1 : 1;
    for (i = 1; i <= n; i++) {
      var f = i / (n + 1);
      var x = sgn * f * spec.span;
      var c = M.lerp(spec.rootC, spec.tipC, f);
      var zle = spec.rootZ + Math.abs(x) * Math.tan(spec.sweep);
      var y = spec.y + Math.abs(x) * Math.tan(spec.dihedral);
      var th = M.lerp(spec.thick, spec.thick * 0.78, f) * c;
      // a rib: a thin chordwise plate standing proud of the lower skin
      B.boxR(key || 'skin_dull', 0.045 * s, 0.10 * s, c * 0.80,
        x, y - th * 0.30, zle + c * 0.46, 0, 0, 0, 0.01);
    }
    // the main spar, running the span at 30% chord
    var cm = M.lerp(spec.rootC, spec.tipC, 0.5);
    var zm = spec.rootZ + spec.span * 0.5 * Math.tan(spec.sweep) + cm * 0.32;
    B.strut(key || 'skin_dull', 0, spec.y - spec.thick * spec.rootC * 0.30, spec.rootZ + spec.rootC * 0.32,
      sgn * spec.span, spec.y + spec.span * Math.tan(spec.dihedral) - spec.thick * spec.tipC * 0.30,
      spec.rootZ + spec.span * Math.tan(spec.sweep) + spec.tipC * 0.32, 0.09 * s, 0.13 * s);
    void zm;
    B.tint = old; B.paint = oldP;
  }

  // A vertical surface (fin, ventral strake) is the same panel stood on end.
  function finPiece(B, spec, key, us) {
    var s2 = {}, kk;
    for (kk in spec) if (Object.prototype.hasOwnProperty.call(spec, kk)) s2[kk] = spec[kk];
    s2.us = us;
    var rings = wingPanel(s2), i, k;
    for (i = 0; i < rings.length; i++) {
      for (k = 0; k < rings[i].length; k++) {
        var p = rings[i][k];
        var px = p[0], py = p[1];
        p[0] = py - spec.y;          // the panel's thickness axis becomes lateral
        p[1] = spec.y + px;          // and its span axis becomes vertical
      }
    }
    B.add(key || 'airframe', ringLoft(rings, true), null);
    B.add(key || 'airframe', ringCap(rings[rings.length - 1], false), null);
    return rings;
  }

  // A fin gets the same treatment as a wing, and it earns it: the T-tail is the
  // subject of hero3 at 30 m, and a fin with no rudder split is a blade.
  function buildFin(B, spec, key) {
    var split = spec.split === undefined ? (spec.rootC > 1.8 ? 0.66 : 0) : spec.split;
    if (!split) return finPiece(B, spec, key, spec.us || AF_U);
    var us = splitUs(split);
    var rings = finPiece(B, spec, key, us[0]);
    var old = B.tint;
    if (old) _ctrlTint.setRGB(old.r * 0.91, old.g * 0.91, old.b * 0.92);
    else _ctrlTint.setRGB(0.91, 0.91, 0.92);
    B.tint = _ctrlTint;
    finPiece(B, spec, key, us[1]);
    B.tint = old;
    return rings;
  }

  // ---- an engine pod --------------------------------------------------------
  // Intake lip, cowl, a recessed dark intake face, a tapering jet pipe and a
  // dark exhaust. The two dark discs are worth more than the whole cowl: they
  // are the only true blacks on a bleached airframe and they read at 60 m.
  function buildNacelle(B, x, y, z, len, r, key) {
    var segs = 12, rings = [], i;
    var st = [
      [0.00, 0.86], [0.05, 0.99], [0.14, 1.00], [0.42, 0.97],
      [0.66, 0.86], [0.86, 0.70], [1.00, 0.60]
    ];
    for (i = 0; i < st.length; i++) {
      rings.push(fuseRing(z - len * 0.5 + st[i][0] * len, r * st[i][1], r * st[i][1], y, segs, 0));
    }
    B.add(key || 'airframe', ringLoft(rings, true), null);
    // intake: a short inward-turning duct, so the lip has thickness and the
    // shadow inside it is a real shadow rather than a painted disc
    var inner = [
      fuseRing(z - len * 0.5 + 0.01, r * 0.80, r * 0.80, y, segs, 0),
      fuseRing(z - len * 0.5 + 0.55, r * 0.62, r * 0.62, y, segs, 0)
    ];
    var oldT = B.tint, oldD = B.dark;
    B.tint = null; B.dark = 0.86;
    B.add('skin_dull', ringLoft(inner, true), null);
    B.add('skin_dull', ringCap(inner[1], false), null);
    // exhaust
    var ex = [
      fuseRing(z + len * 0.5 - 0.02, r * 0.56, r * 0.56, y, segs, 0),
      fuseRing(z + len * 0.5 - 0.50, r * 0.42, r * 0.42, y, segs, 0)
    ];
    B.add('skin_dull', ringLoft(ex, true), null);
    B.add('skin_dull', ringCap(ex[1], true), null);
    B.tint = oldT; B.dark = oldD;
  }

  // ---- landing gear ---------------------------------------------------------
  function buildWheel(B, x, y, z, r, w) {
    B.cyl('tyre', r, r, w, x, y, z, 0, 0, Math.PI * 0.5, 12);
    var oldT = B.tint;
    B.tint = null;
    B.cyl('steel', r * 0.42, r * 0.42, w * 1.06, x, y, z, 0, 0, Math.PI * 0.5, 8);
    B.tint = oldT;
  }

  function buildGear(B, x, z, h, wheelR, twin, wide) {
    var oldT = B.tint, oldP = B.paint;
    B.tint = null; B.paint = 'metal';
    B.cyl('steel', 0.085, 0.11, h - wheelR, x, wheelR + (h - wheelR) * 0.5, z, 0, 0, 0, 8);
    B.cyl('steel', 0.055, 0.055, h * 0.55, x, wheelR + h * 0.42, z + 0.20, 0.26, 0, 0, 6);
    var w = wide === undefined ? 0.20 : wide;
    if (twin) {
      buildWheel(B, x - w, wheelR, z, wheelR, 0.19);
      buildWheel(B, x + w, wheelR, z, wheelR, 0.19);
    } else {
      buildWheel(B, x, wheelR, z, wheelR, 0.24);
    }
    B.paint = oldP; B.tint = oldT;
  }

  // A bogie: two axles, four wheels, and the beam between them. Transports.
  function buildBogie(B, x, z, h, wheelR) {
    var oldT = B.tint, oldP = B.paint;
    B.tint = null; B.paint = 'metal';
    B.cyl('steel', 0.13, 0.17, h - wheelR, x, wheelR + (h - wheelR) * 0.5, z, 0, 0, 0, 8);
    B.box('steel', 0.22, 0.20, 2.0, x, wheelR + 0.14, z, 0.02);
    buildWheel(B, x - 0.44, wheelR, z - 0.62, wheelR, 0.30);
    buildWheel(B, x + 0.44, wheelR, z - 0.62, wheelR, 0.30);
    buildWheel(B, x - 0.44, wheelR, z + 0.62, wheelR, 0.30);
    buildWheel(B, x + 0.44, wheelR, z + 0.62, wheelR, 0.30);
    B.paint = oldP; B.tint = oldT;
  }

  // A maintenance jack: what half this yard is standing on instead of tyres.
  function buildJack(B, x, z, h) {
    var oldT = B.tint, oldP = B.paint;
    B.tint = tint(0xc8a41e, 0.72); B.paint = 'metal';
    B.cyl('steel', 0.055, 0.075, h, x, h * 0.5, z, 0, 0, 0, 8);
    B.cyl('steel', 0.20, 0.20, 0.10, x, 0.05, z, 0, 0, 0, 10);
    for (var i = 0; i < 3; i++) {
      var a = i * 2.0944 + 0.4;
      B.strut('steel', x, h * 0.62, z,
        x + Math.sin(a) * 0.62, 0.06, z + Math.cos(a) * 0.62, 0.055, 0.055);
    }
    B.paint = oldP; B.tint = oldT;
  }

  // ===========================================================================
  // THE GLASSHOUSE, THE SPINE, THE NOZZLE AND THE ANTENNAS.
  //
  // Everything below exists because of one measurement: the stripped fighter
  // that `interior` is composed around read as a smooth chrome zeppelin. The
  // old canopy was a shell hugging the fuselage crown at r x 0.66 - it stood
  // six centimetres proud of a body 2.99 m tall, i.e. it WAS the crown, and
  // the pose pointed at an unbroken bulge. There was no windscreen, no cockpit
  // tub, no seat, no spine, no nozzle ring and no antennas, which between them
  // are most of what makes a fighter's outline a fighter's outline.
  //
  // None of it is expensive: it is boxes, struts and two short lofts in the
  // buckets that already exist, so it costs triangles and no draw calls at
  // all. It is driven off TYPES data, so the trainer row gets it too.
  // ===========================================================================

  // Where the top of the fuselage skin is at a given LOCAL z.
  function deckY(spec, z) {
    var t = M.saturate((z + spec.len * 0.5) / spec.len);
    return fuseYc(t, spec) +
      Math.max(0.035, fuseProfile(t, spec)) * (spec.ovoid === undefined ? 1.06 : spec.ovoid);
  }

  function buildCockpit(B, T, spec, s) {
    var C = T.cockpit;
    if (!C) return;
    var i, k;
    var z0 = C.z0 * s, z1 = C.z1 * s, zm = (z0 + z1) * 0.5;
    var deck = deckY(spec, zm);
    var oldT = B.tint, oldP = B.paint, oldD = B.dark;
    var sillY = deck - C.sill * s;

    // ---- the tub: a dark recess cut into the deck --------------------------
    // Without it the canopy is a bubble sitting on a solid back, and a canopy
    // with nothing under it reads as a blister.
    B.tint = null; B.paint = 'flat'; B.dark = 0.90;
    B.boxR('skin_dull', C.w * 1.70 * s, C.h * 1.30 * s, (z1 - z0) * 0.94,
      0, sillY - C.h * s * 0.52, zm, 0, 0, 0, 0.03);
    // ---- the seat(s) -------------------------------------------------------
    var seats = C.seats || 1;
    for (i = 0; i < seats; i++) {
      var sz = seats === 1 ? zm + (z1 - z0) * 0.10
        : M.lerp(z0 + (z1 - z0) * 0.24, z1 - (z1 - z0) * 0.18, i / (seats - 1));
      B.dark = 0.72;
      B.boxR('skin_dull', C.w * 1.02 * s, C.h * 1.05 * s, 0.44 * s,
        0, sillY - C.h * s * 0.10, sz, -0.14, 0, 0, 0.03);
      B.dark = 0.58;
      // the headbox, which is the one part of an ejection seat that shows
      B.boxR('skin_dull', C.w * 0.86 * s, 0.30 * s, 0.20 * s,
        0, sillY + 0.13 * s, sz + 0.24 * s, 0.20, 0, 0, 0.02);
    }
    B.dark = 0;

    // ---- the canopy --------------------------------------------------------
    // A half-arch loft that stands C.rise proud of the sill, peaking behind
    // the seat and tapering into the spine, i.e. a shape with a profile
    // instead of a shell following the body.
    var cr = [], ns = 6;
    for (i = 0; i <= ns; i++) {
      var t = i / ns;
      var prof = Math.sin(Math.pow(t, 0.80) * Math.PI * 0.90 + 0.20);
      var hh = C.rise * s * (0.40 + 0.60 * prof);
      var ww = C.w * s * (0.60 + 0.40 * prof);
      var cz = M.lerp(z0, z1, t);
      var ring = [];
      for (k = 0; k <= 8; k++) {
        var a = -Math.PI * 0.5 + (k / 8) * Math.PI;
        ring.push([Math.sin(a) * ww, sillY + Math.cos(a) * hh, cz]);
      }
      cr.push(ring);
    }
    B.tint = null; B.paint = 'flat';
    B.add('canopy', ringLoft(cr, false), null);

    // ---- the frame: sill rails, a windscreen arch, a canopy bow -------------
    B.paint = 'metal'; B.tint = null;
    for (i = 0; i < 2; i++) {
      var sgn = i ? -1 : 1;
      B.boxR('skin_dull', 0.06 * s, 0.085 * s, (z1 - z0) * 0.98,
        sgn * C.w * s * 0.88, sillY + 0.01 * s, zm, 0, 0, 0, 0.014);
    }
    function arch(at, thick) {
      var pf = Math.sin(Math.pow(at, 0.80) * Math.PI * 0.90 + 0.20);
      var ah = C.rise * s * (0.40 + 0.60 * pf) * 1.03;
      var aw = C.w * s * (0.60 + 0.40 * pf) * 1.04;
      var az = M.lerp(z0, z1, at);
      var prev = null;
      for (var q = 0; q <= 7; q++) {
        var a2 = -Math.PI * 0.5 + (q / 7) * Math.PI;
        var pt = [Math.sin(a2) * aw, sillY + Math.cos(a2) * ah, az];
        if (prev) B.strut('skin_dull', prev[0], prev[1], prev[2], pt[0], pt[1], pt[2], thick, thick);
        prev = pt;
      }
    }
    arch(0.01, 0.055 * s);          // the windscreen bow
    arch(0.30, 0.045 * s);          // the windscreen/canopy break
    arch(0.99, 0.045 * s);          // the aft bow, where it hinges

    B.dark = oldD; B.paint = oldP; B.tint = oldT;
  }

  // The dorsal avionics fairing. Without it the top of a fighter aft of the
  // cockpit is a plain cylinder for eight metres.
  function buildSpine(B, T, spec, s) {
    var S = T.spine;
    if (!S) return;
    var z0 = S.z0 * s, z1 = S.z1 * s, i, k;
    var rings = [], n = 5;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var cz = M.lerp(z0, z1, t);
      var base = deckY(spec, cz) - 0.015 * s;
      var taper = Math.sin((1 - t) * Math.PI * 0.46 + 0.16);
      var ww = S.w * s * taper, hh = S.h * s * taper;
      var ring = [];
      for (k = 0; k <= 6; k++) {
        var a = -Math.PI * 0.5 + (k / 6) * Math.PI;
        ring.push([Math.sin(a) * ww, base + Math.cos(a) * hh, cz]);
      }
      rings.push(ring);
    }
    B.add('airframe', ringLoft(rings, false), null);
  }

  // A petal ring round the jet pipe, and a real hole behind it. The two dark
  // discs on an airframe are worth more than the whole cowl (see buildNacelle)
  // and the fighter had neither.
  function buildNozzle(B, T, spec, s) {
    var Nz = T.nozzle;
    if (!Nz) return;
    var oldT = B.tint, oldP = B.paint, oldD = B.dark;
    var y = spec.centreY * 0.98, z = Nz.z * s, r = Nz.r * s;
    var np = Nz.petals || 10, i;
    B.tint = tint(0x7d7a72, 0.55); B.paint = 'metal'; B.dark = 0.34;
    for (i = 0; i < np; i++) {
      var a = (i / np) * Math.PI * 2;
      B.boxR('skin_dull', r * 0.34, 0.05 * s, 0.66 * s,
        Math.sin(a) * r * 1.00, y + Math.cos(a) * r * 1.00, z + 0.34 * s,
        0, 0, a, 0.012);
    }
    // No inner cone here: T.exhaust already lofts the jet pipe and its dark
    // disc, and a second one at the same station is z-fighting, not detail.
    B.dark = oldD; B.paint = oldP; B.tint = oldT;
  }

  // Blade antennas. Four triangles each and they are the difference between a
  // silhouette that could be a missile and one that is an aeroplane.
  function buildBlades(B, T, s) {
    if (!T.blades) return;
    var oldT = B.tint, oldP = B.paint;
    B.tint = tint(0x8d9296, 0.5); B.paint = 'metal';
    for (var i = 0; i < T.blades.length; i++) {
      var bd = T.blades[i], bh = bd[3] * s;
      B.boxR('skin_dull', 0.032 * s, Math.abs(bh), 0.30 * s,
        bd[0] * s, bd[1] * s + bh * 0.5, bd[2] * s, 0, 0, 0, 0.010);
    }
    B.paint = oldP; B.tint = oldT;
  }

  // ---- the shrink wrap ------------------------------------------------------
  // Sprayed vinyl (spraylat) over the canopy, the intakes and every opening.
  // Modelled as an inflated, WRINKLED cap - the wrinkles are the whole point,
  // because a smooth white blob over a canopy is a bar of soap.
  function buildWrapCap(B, z0, z1, r, yc, segs, bulge, seed) {
    var oldT = B.tint, oldP = B.paint;
    B.tint = null; B.paint = 'wrap';
    var rings = [], i, k, ns = 5;
    for (i = 0; i <= ns; i++) {
      var t = i / ns;
      var z = M.lerp(z0, z1, t);
      var rr = r * (1 + bulge * Math.sin(t * Math.PI) * 0.55);
      var ring = [];
      for (k = 0; k < segs; k++) {
        var a = -Math.PI * 0.62 + (k / (segs - 1)) * Math.PI * 1.24;
        // sagging vinyl: a low-frequency wrinkle round the section and along it
        var wr = 1 + 0.045 * Math.sin(a * 4.0 + seed) * Math.sin(t * 5.3 + seed * 1.7)
          + 0.028 * Math.sin(a * 7.0 - seed * 2.1);
        ring.push([Math.sin(a) * rr * wr, yc + Math.cos(a) * rr * wr * 1.02, z]);
      }
      rings.push(ring);
    }
    B.add('wrap', ringLoft(rings, false), null);
    B.tint = oldT; B.paint = oldP;
    return rings;
  }

  function buildWrapDisc(B, x, y, z, r, depth, seed) {
    var oldT = B.tint, oldP = B.paint;
    B.tint = null; B.paint = 'wrap';
    var segs = 10, rings = [], i, k;
    for (i = 0; i <= 3; i++) {
      var t = i / 3;
      var ring = [];
      var rr = r * Math.cos(t * 1.1) / Math.cos(0);
      for (k = 0; k < segs; k++) {
        var a = (k / segs) * Math.PI * 2;
        var wr = 1 + 0.05 * Math.sin(a * 3 + seed);
        ring.push([x + Math.sin(a) * rr * wr, y + Math.cos(a) * rr * wr, z + t * depth]);
      }
      rings.push(ring);
    }
    B.add('wrap', ringLoft(rings, true), null);
    B.add('wrap', ringCap(rings[rings.length - 1], false), null);
    B.tint = oldT; B.paint = oldP;
  }

  // ========================================================= AIRCRAFT TYPES ==
  // Six airframe families. Each is a plain data recipe consumed by
  // buildAircraft(); nothing below hard-codes a world coordinate, so the same
  // recipe serves a hero at 12 m and a silhouette at 90 m.
  //
  // Every dimension is real-ish, because the ONE thing an audience knows about
  // an aeroplane is how big it is relative to a person. A 10.5 m fighter span
  // with a 2.6 m wing height is what makes the storage rows read as corridors
  // you can walk down; getting that wrong by 30% turns them into a hedge maze.
  var TYPES = {
    // ---- the hero: a four-engine strategic transport ------------------------
    // HIGH wing, and every dimension below is chained off that one decision:
    // the belly sits at 1.91 m (so the bogies at 2.05 m reach it), the wing root
    // at 5.40 m and the tips - after 2.6 degrees of anhedral - at 4.4 m, which
    // is what lets a player walk the whole span underneath. The shade this wing
    // throws is 9.35 m of offset at noon, and anchors.sierra7.shade is derived
    // from THAT number rather than from a remembered rectangle.
    transport4: {
      len: 44.0, span: 45.0, r: 2.55, segs: 16, stations: 22,
      centreY: 4.10, noseT: 0.15, tailT: 0.58, upsweep: 0.62, tailCut: 0.74,
      droop: 0.10, ovoid: 1.10, flat: 0.40,
      wing: { rootC: 7.6, tipC: 2.6, sweep: 0.42, dihedral: -0.045, thick: 0.135,
              rootZ: -1.6, y: 5.40, twist: 0.055, sections: 6 },
      tail: 'T', finH: 9.0, finRootC: 7.2, finTipC: 3.0, finSweep: 0.62,
      stabSpan: 7.8, stabC: 3.4, stabSweep: 0.40,
      // `fwd` is how far the nacelle sticks out AHEAD OF THE LEADING EDGE AT
      // ITS OWN STATION, not a fixed z. On a wing swept 24 degrees the leading
      // edge at the outboard pylon is 5.4 m further aft than at the inboard
      // one, so a fixed z hangs the outboard engine several metres in front of
      // the wing with nothing joining them - which is exactly what the first
      // capture showed.
      engines: [{ x: 8.6, fwd: 2.6, len: 5.6, r: 1.02, drop: 1.30 },
                { x: 15.4, fwd: 2.2, len: 5.0, r: 0.92, drop: 1.16 }],
      gear: 'bogie', gearH: 2.05, wheelR: 0.56,
      noseGearZ: -15.0, mainGearZ: 3.6, mainGearX: 2.35,
      wrapCanopy: [-20.2, -16.4, 0.55], radome: true,
      windows: { z0: -19.4, z1: -15.6, y: 4.55, n: 3 },
      cabinWindows: 0,
      stencilScale: 1.0
    },
    // ---- a twin-engine tactical transport ----------------------------------
    transport2: {
      len: 32.0, span: 33.0, r: 2.15, segs: 14, stations: 20,
      centreY: 3.40, noseT: 0.16, tailT: 0.56, upsweep: 0.80, tailCut: 0.78,
      droop: 0.08, ovoid: 1.08, flat: 0.44,
      wing: { rootC: 5.4, tipC: 2.2, sweep: 0.16, dihedral: 0.02, thick: 0.15,
              rootZ: -1.0, y: 4.90, twist: 0.05, sections: 5 },
      tail: 'T', finH: 7.6, finRootC: 5.6, finTipC: 2.4, finSweep: 0.58,
      stabSpan: 6.2, stabC: 2.8, stabSweep: 0.22,
      engines: [{ x: 5.4, fwd: 2.3, len: 4.2, r: 0.86, drop: 0.10, prop: true }],
      gear: 'twin', gearH: 1.85, wheelR: 0.50,
      noseGearZ: -11.0, mainGearZ: 2.4, mainGearX: 1.75,
      wrapCanopy: [-14.6, -11.6, 0.50], radome: true,
      windows: { z0: -14.0, z1: -11.2, y: 3.95, n: 3 },
      cabinWindows: 6,
      stencilScale: 0.9
    },
    // ---- a swept-wing tactical fighter -------------------------------------
    fighter: {
      len: 15.6, span: 10.4, r: 0.86, segs: 12, stations: 18,
      centreY: 2.10, noseT: 0.22, tailT: 0.62, upsweep: 0.10, tailCut: 0.42,
      droop: 0.05, ovoid: 1.04, flat: 0.22,
      wing: { rootC: 4.4, tipC: 1.5, sweep: 0.66, dihedral: -0.02, thick: 0.075,
              rootZ: 0.4, y: 1.85, twist: 0.03, sections: 4 },
      tail: 'low', finH: 3.1, finRootC: 3.6, finTipC: 1.5, finSweep: 0.72,
      stabSpan: 2.8, stabC: 2.0, stabSweep: 0.60,
      engines: null, intakes: [{ x: 1.05, y: 1.95, z: -2.4, r: 0.50 }],
      gear: 'single', gearH: 1.55, wheelR: 0.36,
      noseGearZ: -4.6, mainGearZ: 1.4, mainGearX: 1.25,
      wrapCanopy: [-4.9, -1.9, 0.42],
      exhaust: { z: 7.4, r: 0.62 },
      // ---------------------------------------------------------------------
      // THE COCKPIT, AND WHY THIS TYPE NEEDED ONE MORE THAN ANY OTHER.
      //
      // The stripped fighter on jacks is the subject of `interior`, which is
      // the best-composed frame in the set - real shafts, a real leading line,
      // a legible subject position - and what it pointed at was a smooth
      // chrome zeppelin. No canopy (the old one sat 6 cm proud of the fuselage
      // crown, i.e. it WAS the crown), no windscreen, no cockpit tub, no
      // ejection seat, no spine, no antennas. Every one of those is silhouette,
      // and silhouette is the roster's instant-fail line.
      //
      // `cockpit` gives the type a real glasshouse: a tub sunk into the deck,
      // a seat in it, a canopy that stands 0.34 m proud on its own sill rails,
      // a windscreen arch and a separate quarter-light frame. `spine` is the
      // dorsal avionics fairing that runs from the canopy to the fin, which is
      // what stops the top of a fighter being a plain cylinder. `nozzle` is a
      // petal ring round the jet pipe. `blades` are the UHF/IFF antennas.
      // ---------------------------------------------------------------------
      cockpit: { z0: -5.0, z1: -1.6, w: 0.62, h: 0.46, rise: 0.34, sill: 0.10 },
      spine: { z0: -1.4, z1: 5.6, w: 0.34, h: 0.30 },
      nozzle: { z: 7.4, r: 0.62, petals: 12 },
      blades: [[0, 2.98, -0.2, 0.34], [0, 1.10, 3.2, -0.26]],
      stencilScale: 0.62
    },
    // ---- a straight-wing trainer -------------------------------------------
    trainer: {
      len: 12.2, span: 11.6, r: 0.78, segs: 12, stations: 16,
      centreY: 1.85, noseT: 0.24, tailT: 0.60, upsweep: 0.22, tailCut: 0.52,
      droop: 0.06, ovoid: 1.05, flat: 0.28,
      wing: { rootC: 2.5, tipC: 1.4, sweep: 0.06, dihedral: 0.09, thick: 0.13,
              rootZ: -0.4, y: 1.35, twist: 0.04, sections: 4 },
      tail: 'T', finH: 2.6, finRootC: 2.4, finTipC: 1.2, finSweep: 0.52,
      stabSpan: 2.3, stabC: 1.5, stabSweep: 0.10,
      engines: null, intakes: [{ x: 0.82, y: 1.72, z: -1.2, r: 0.38 }],
      gear: 'single', gearH: 1.30, wheelR: 0.32,
      noseGearZ: -3.6, mainGearZ: 0.9, mainGearX: 1.05,
      wrapCanopy: [-4.2, -0.8, 0.46],
      exhaust: { z: 5.6, r: 0.46 },
      // A trainer is a two-seat greenhouse and that long canopy is most of its
      // silhouette; six of them stand in one row, so it earns the same kit.
      cockpit: { z0: -4.4, z1: -0.5, w: 0.50, h: 0.40, rise: 0.32, sill: 0.09,
                 seats: 2 },
      spine: { z0: -0.3, z1: 4.4, w: 0.24, h: 0.20 },
      nozzle: { z: 5.6, r: 0.46, petals: 10 },
      blades: [[0, 2.60, 0.6, 0.26]],
      stencilScale: 0.55
    },
    // ---- a stripped hulk: fuselage only, on cradles -------------------------
    // The single most boneyard-specific object there is. No wings, no tail, no
    // gear - the wing box is a rectangular HOLE in the side of the fuselage
    // with structure visible in it, and the whole thing sits on timber cradles.
    hulk: {
      len: 21.0, span: 0, r: 1.75, segs: 14, stations: 16,
      centreY: 2.55, noseT: 0.18, tailT: 0.66, upsweep: 0.30, tailCut: 0.30,
      droop: 0.04, ovoid: 1.06, flat: 0.40,
      wing: null, tail: 'none', engines: null,
      gear: 'cradle', stripped: true,
      stencilScale: 0.8
    },
    // ---- a stripped rotary airframe ----------------------------------------
    heli: {
      len: 13.6, span: 0, r: 1.10, segs: 12, stations: 16,
      centreY: 1.95, noseT: 0.20, tailT: 0.40, upsweep: 0.36, tailCut: 0.86,
      droop: 0.10, ovoid: 1.12, flat: 0.30,
      wing: null, tail: 'heli', engines: null,
      gear: 'skid',
      rotorR: 6.4, rotorY: 3.45, blades: 4,
      stencilScale: 0.5
    }
  };

  // ---------------------------------------------------------------------------
  // buildAircraft - composes one complete airframe into the builder at the
  // CURRENT transform. `o` carries the per-unit variation that stops thirty-four
  // of these reading as thirty-four clones:
  //   body      body tint (bare metal / white top / faded tactical grey)
  //   wrapped   0..1 how much of it is cocooned
  //   scale     small size jitter
  //   onJacks   gear removed, standing on maintenance jacks
  //   noWings   wings removed and stacked elsewhere (a real AMARG sight)
  //   soot      exhaust staining
  // ---------------------------------------------------------------------------
  function buildAircraft(B, L, typeName, o, rng) {
    var T = TYPES[typeName];
    if (!T) return null;
    o = o || {};
    var s = o.scale || 1.0;
    var half = T.len * 0.5 * s;
    var i;

    B.paint = 'skin';
    B.tint = o.body || null;
    B.dark = 0;

    var spec = {
      len: T.len * s, r: T.r * s, segs: T.segs, stations: T.stations,
      centreY: T.centreY * s, noseT: T.noseT, tailT: T.tailT,
      upsweep: T.upsweep, tailCut: T.tailCut, droop: T.droop,
      ovoid: T.ovoid, flat: T.flat
    };
    buildFuselage(B, L, spec, 'airframe');
    // Barrel-section straps. On by default and off only where a caller says
    // so: a lofted tube with nothing on it is the "geometry with no silhouette
    // detail" the roster instant-fails, and this is the cheapest structure a
    // fuselage can carry. Pitch scales with the airframe so a 15 m fighter
    // gets 1.5 m bays and a 44 m transport 2.4 m ones.
    if (o.detail !== false) {
      try {
        // PANEL_PITCH is in the airframe's OWN (already scaled) local units,
        // which is the same space _paint bands in - so no `* s` here.
        fuseLapStraps(B, spec, 'airframe', PANEL_PITCH, 0.011 * s);
      } catch (eL) { GAME.logError('boneyard.laps', eL); }
    }

    // ---- the cheatline / white crown ---------------------------------------
    // A second partial loft a centimetre proud of the skin, in a different
    // tint. This is what gives a bare metal tube a WATERLINE, and a waterline
    // is what makes it read as an aeroplane rather than as a pipe.
    if (o.crown) {
      var crings = [], nst = Math.max(8, (T.stations * 0.6) | 0);
      for (i = 0; i <= nst; i++) {
        var t = i / nst;
        var r = Math.max(0.03, fuseProfile(t, spec)) + 0.012 * s;
        var ring = [];
        for (var k = 0; k <= 8; k++) {
          var a = -1.02 + (k / 8) * 2.04;
          ring.push([Math.sin(a) * r, fuseYc(t, spec) + Math.cos(a) * r * spec.ovoid, -spec.len * 0.5 + t * spec.len]);
        }
        crings.push(ring);
      }
      B.tint = o.crown;
      B.add('airframe', ringLoft(crings, false), null);
      B.tint = o.body || null;
    }

    // ---- wings --------------------------------------------------------------
    var wingY = 0, wingTipY = 0;
    if (T.wing && !o.noWings) {
      var w = T.wing;
      var ws = {
        span: T.span * 0.5 * s - T.r * s * 0.55, rootC: w.rootC * s, tipC: w.tipC * s,
        sweep: w.sweep, dihedral: w.dihedral, thick: w.thick,
        rootZ: w.rootZ * s, y: w.y * s, twist: w.twist, sections: w.sections
      };
      buildWing(B, ws, 'airframe', false);
      buildWing(B, ws, 'airframe', true);
      // A big wing seen from underneath is a large dark shape in the middle of
      // the signature frame, and a flat lower skin at that angle is a black
      // sheet. Ribs and a spar give it something to read - the parts-yard
      // racks have had them since the last pass; the aeroplanes had not.
      if (o.detail !== false && ws.rootC > 3.5) {
        wingUnderRibs(B, ws, 'skin_dull', false, s);
        wingUnderRibs(B, ws, 'skin_dull', true, s);
        B.tint = o.body || null; B.paint = 'skin';
      }
      wingY = ws.y;
      wingTipY = ws.y + ws.span * Math.tan(ws.dihedral);
      // wing fences / vortex generators, and the flap track fairings that give
      // a wing its real underside silhouette
      B.tint = null;
      for (i = 0; i < 3; i++) {
        var fx = (0.34 + i * 0.24) * ws.span;
        var fz = ws.rootZ + fx * Math.tan(ws.sweep) + M.lerp(ws.rootC, ws.tipC, fx / ws.span) * 0.86;
        var fy = ws.y + fx * Math.tan(ws.dihedral);
        B.boxR('skin_dull', 0.22 * s, 0.30 * s, 1.5 * s, fx, fy - 0.16 * s, fz, 0, 0, 0, 0.03);
        B.boxR('skin_dull', 0.22 * s, 0.30 * s, 1.5 * s, -fx, fy - 0.16 * s, fz, 0, 0, 0, 0.03);
      }
      B.tint = o.body || null;
    }

    // ---- empennage ----------------------------------------------------------
    var tailTopY = spec.centreY + spec.r;
    if (T.tail === 'T' || T.tail === 'low') {
      var fz0 = half * 0.56;
      var finSpec = {
        span: T.finH * s, rootC: T.finRootC * s, tipC: T.finTipC * s,
        sweep: T.finSweep, dihedral: 0, thick: 0.10,
        rootZ: fz0, y: fuseYc(0.86, spec) + spec.r * 0.72, sections: 4, twist: 0
      };
      buildFin(B, finSpec, 'airframe');
      tailTopY = finSpec.y + finSpec.span;
      var stabY = T.tail === 'T' ? tailTopY - 0.10 * s : fuseYc(0.84, spec) + spec.r * 0.10;
      var stabZ = T.tail === 'T'
        ? fz0 + T.finH * s * Math.tan(T.finSweep) + T.finRootC * s * 0.16
        : half * 0.70;
      var ss = {
        span: T.stabSpan * 0.5 * s, rootC: T.stabC * s, tipC: T.stabC * 0.5 * s,
        sweep: T.stabSweep, dihedral: 0.03, thick: 0.10,
        rootZ: stabZ, y: stabY, sections: 3, twist: 0
      };
      buildWing(B, ss, 'airframe', false);
      buildWing(B, ss, 'airframe', true);
    } else if (T.tail === 'heli') {
      // tail boom, fin and the tail rotor gearbox
      B.cyl('airframe', 0.20 * s, 0.42 * s, T.len * 0.42 * s,
        0, spec.centreY + 0.30 * s, half * 0.62, Math.PI * 0.5, 0, 0, 10);
      var hf = {
        span: 1.8 * s, rootC: 1.5 * s, tipC: 0.8 * s, sweep: 0.5, dihedral: 0,
        thick: 0.12, rootZ: half * 0.94, y: spec.centreY + 0.40 * s, sections: 3, twist: 0
      };
      buildFin(B, hf, 'airframe');
      tailTopY = hf.y + hf.span;
      B.cyl('skin_dull', 0.22 * s, 0.22 * s, 0.30 * s,
        0.24 * s, spec.centreY + 1.5 * s, half * 1.02, 0, 0, Math.PI * 0.5, 8);
    }

    // ---- engines ------------------------------------------------------------
    if (T.engines && !o.noWings) {
      B.tint = o.body || null;
      for (i = 0; i < T.engines.length; i++) {
        var e = T.engines[i];
        var ex = e.x * s;
        var ez = (e.z !== undefined ? e.z
          : (T.wing.rootZ + e.x * Math.tan(T.wing.sweep) - e.fwd)) * s;
        // ---------------------------------------------------------------------
        // THE ANHEDRAL, AND WHY THE OUTBOARD ENGINE WAS A CARDBOARD BOX.
        //
        // `ey` used to hang the nacelle a fixed drop below T.wing.y, which is
        // the wing height AT THE ROOT. The fairing three lines down already
        // solved the wing height AT THE ENGINE'S OWN STATION (wyS, with the
        // dihedral term) - so the two disagreed by e.x * tan(dihedral), and on
        // the transport4, whose wing carries 2.6 degrees of ANHEDRAL over a
        // 21 m semi-span, that is 0.69 m at the outboard pylon. The nacelle
        // crown sat 0.72 m INSIDE the wing box: what was left outside the skin
        // was the plain cuboid pylon and the tip of the fairing, and at 8.4 m
        // from the lens in hero1 - the level's signature frame - that printed as
        // a grey cardboard crate hanging under the wing with no engine attached
        // to it. Measured off the capture at 7.5 x 4.1 degrees, which is the
        // pylon's 1.8 x 0.9 m at that range to within a pixel.
        //
        // One station height, solved once, used by the nacelle, the pylon and
        // the fairing, so they cannot part company again.
        var wyAt = (T.wing ? T.wing.y * s : spec.centreY) +
          (T.wing ? e.x * s * Math.tan(T.wing.dihedral) : 0);
        var ey = wyAt - e.drop * s;
        if (e.prop) {
          // a turboprop nacelle sits ON the wing, not under it
          ey = wyAt - 0.16 * s;
        }
        buildNacelle(B, ex, ey, ez, e.len * s, e.r * s, 'airframe');
        buildNacelle(B, -ex, ey, ez, e.len * s, e.r * s, 'airframe');
        // pylons
        B.tint = null;
        if (!e.prop) {
          // The pylon, plus the FAIRING where it meets the wing. Without the
          // fairing a nacelle is a dark box hanging off a bar with a hard right
          // angle between them and no surface at the junction for the key to
          // find; the fillet is what makes an engine read as attached.
          var wThk = (T.wing ? T.wing.thick : 0.12) *
            M.lerp(T.wing ? T.wing.rootC : 4, T.wing ? T.wing.tipC : 2,
              M.saturate(e.x / (T.span * 0.5))) * s;
          var fy2 = wyAt - wThk * 0.42;
          // -------------------------------------------------------------------
          // AND THE PYLON IS AN AEROFOIL, NOT A CUBOID.
          //
          // It was `boxR(0.22, drop*0.78, 1.8)` - a bevelled brick. A real
          // engine pylon is a short, thick, vertical wing section, and this file
          // already builds exactly that: finPiece() is wingPanel() stood on end,
          // which is what gives it a rounded leading edge, a taper and a
          // trailing edge the key can rake. Two hundred triangles a side in the
          // `skin_dull` bucket that already exists, no draw call, and it is the
          // difference between "engine hung on a strut" and "crate taped under a
          // plank" at the range hero1 shoots it from.
          //
          // The strut runs from just above the nacelle crown up INTO the wing
          // box (the extra 0.12 m of span is buried, which is how a real one
          // meets the lower skin - there is no gap to see through).
          var pyBase = ey + e.r * s * 0.30;
          var pySpan = Math.max(0.22 * s, fy2 - pyBase + 0.12 * s);
          var pySpec = {
            span: pySpan, rootC: 1.95 * s, tipC: 1.62 * s, sweep: 0.13,
            dihedral: 0, thick: 0.135, rootZ: ez - 0.05 * s, y: pyBase,
            sections: 2, twist: 0, split: 0
          };
          for (var pk = 0; pk < 2; pk++) {
            B.pushXYZ(pk ? -ex : ex, 0, 0);
            buildFin(B, pySpec, 'skin_dull');
            B.pop();
          }
          // The fairing sits UNDER the wing's lower skin, not through it: the
          // first pass put it at 0.90 of the pylon drop, which is inside the
          // wing box, and two 3 m plates printed lying across the top of the
          // wing in the hero framing.
          B.tint = o.body || null;
          B.boxR('airframe', 0.44 * s, 0.26 * s, 2.4 * s,
            ex, fy2, ez + 1.1 * s, 0, 0, 0, 0.11 * s);
          B.boxR('airframe', 0.44 * s, 0.26 * s, 2.4 * s,
            -ex, fy2, ez + 1.1 * s, 0, 0, 0, 0.11 * s);
          B.tint = null;
        }
        // a spinner or a wrapped intake plug
        if (e.prop) {
          B.tint = tint(0x22262a, 0.8);
          B.cyl('skin_dull', 0.10 * s, 0.26 * s, 0.5 * s, ex,
            ey, ez - e.len * s * 0.5 - 0.2 * s, Math.PI * 0.5, 0, 0, 10);
          B.cyl('skin_dull', 0.10 * s, 0.26 * s, 0.5 * s, -ex,
            ey, ez - e.len * s * 0.5 - 0.2 * s, Math.PI * 0.5, 0, 0, 10);
          // three feathered blades a side, stopped at a lazy angle
          B.tint = tint(0x2b2f33, 0.7);
          for (var bl = 0; bl < 3; bl++) {
            var ba = bl * 2.0944 + (o.propPhase || 0.4);
            B.boxR('skin_dull', 0.20 * s, 1.55 * s, 0.09 * s,
              ex + Math.sin(ba) * 0.80 * s, ey + Math.cos(ba) * 0.80 * s,
              ez - e.len * s * 0.5 - 0.30 * s, 0, 0, ba, 0.02);
            B.boxR('skin_dull', 0.20 * s, 1.55 * s, 0.09 * s,
              -ex + Math.sin(-ba) * 0.80 * s, ey + Math.cos(-ba) * 0.80 * s,
              ez - e.len * s * 0.5 - 0.30 * s, 0, 0, -ba, 0.02);
          }
        }
        B.tint = o.body || null;
      }
    }

    // ---- intakes and jet pipe on a fighter ----------------------------------
    if (T.intakes) {
      for (i = 0; i < T.intakes.length; i++) {
        var it = T.intakes[i];
        var ix = it.x * s, iy = it.y * s, iz = it.z * s, ir = it.r * s;
        // a shoulder intake with a real lip and a dark duct behind it
        B.tint = o.body || null;
        B.cyl('airframe', ir * 1.12, ir * 1.05, 2.6 * s, ix, iy, iz + 1.2 * s, Math.PI * 0.5, 0, 0, 10, true);
        B.cyl('airframe', ir * 1.12, ir * 1.05, 2.6 * s, -ix, iy, iz + 1.2 * s, Math.PI * 0.5, 0, 0, 10, true);
        B.tint = null; B.dark = 0.88;
        B.cyl('skin_dull', ir * 0.90, ir * 0.60, 1.1 * s, ix, iy, iz + 0.5 * s, Math.PI * 0.5, 0, 0, 10);
        B.cyl('skin_dull', ir * 0.90, ir * 0.60, 1.1 * s, -ix, iy, iz + 0.5 * s, Math.PI * 0.5, 0, 0, 10);
        B.dark = 0;
      }
    }
    if (T.exhaust) {
      B.tint = null; B.dark = 0.55;
      B.cyl('skin_dull', T.exhaust.r * s, T.exhaust.r * 0.82 * s, 1.1 * s,
        0, spec.centreY * 0.98, T.exhaust.z * s, Math.PI * 0.5, 0, 0, 12);
      B.dark = 0.90;
      B.cyl('skin_dull', T.exhaust.r * 0.74 * s, T.exhaust.r * 0.74 * s, 0.30 * s,
        0, spec.centreY * 0.98, T.exhaust.z * s + 0.5 * s, Math.PI * 0.5, 0, 0, 12);
      B.dark = 0;
    }

    // ---- canopy / flight deck ----------------------------------------------
    B.tint = o.body || null;
    if (T.wrapCanopy) {
      var wc = T.wrapCanopy;
      if (o.wrapped > 0.25) {
        // cocooned: white vinyl over the whole glasshouse
        buildWrapCap(B, wc[0] * s, wc[1] * s, spec.r * (0.72 + wc[2] * 0.30),
          fuseYc(0.20, spec) + spec.r * 0.42, 9, 0.22, (o.seed || 1) * 3.7);
      } else if (T.cockpit) {
        // A REAL glasshouse - tub, seat, canopy, windscreen, sill rails. See
        // buildCockpit for why this replaced the old shell.
        buildCockpit(B, T, spec, s);
        B.tint = o.body || null;
      } else {
        // a real canopy: dark glass over a frame
        var cr = [];
        for (i = 0; i <= 4; i++) {
          var ct = i / 4;
          var cz = M.lerp(wc[0] * s, wc[1] * s, ct);
          var crr = spec.r * (0.52 + wc[2] * 0.34) * (0.72 + 0.34 * Math.sin(ct * Math.PI));
          var cring = [];
          for (var ck = 0; ck < 7; ck++) {
            var ca = -Math.PI * 0.52 + (ck / 6) * Math.PI * 1.04;
            cring.push([Math.sin(ca) * crr,
              fuseYc(0.20, spec) + spec.r * 0.52 + Math.cos(ca) * crr * 0.86, cz]);
          }
          cr.push(cring);
        }
        B.tint = null;
        B.add('canopy', ringLoft(cr, false), null);
        B.tint = o.body || null;
      }
    }
    // The spine, the nozzle ring and the antennas. All three are silhouette
    // and all three survive being wrapped, because spraylat goes over the
    // openings, not over the airframe.
    if (T.spine) { buildSpine(B, T, spec, s); B.tint = o.body || null; }
    if (T.nozzle && !(o.wrapped > 0.25)) buildNozzle(B, T, spec, s);
    buildBlades(B, T, s);
    B.tint = o.body || null; B.paint = 'skin';
    // transport flight-deck windows: recessed dark panels, not painted lines
    if (T.windows && !(o.wrapped > 0.25)) {
      var wnd = T.windows;
      B.tint = null; B.dark = 0.86; B.paint = 'flat';
      for (i = 0; i < wnd.n; i++) {
        var wt = (i + 0.5) / wnd.n;
        var wz = M.lerp(wnd.z0 * s, wnd.z1 * s, wt);
        var wrr = Math.max(0.05, fuseProfile((wz + half) / (T.len * s), spec));
        B.boxR('skin_dull', 0.10 * s, 0.46 * s, 0.72 * s,
          wrr * 0.90, wnd.y * s, wz, 0, 0.14, 0, 0.02);
        B.boxR('skin_dull', 0.10 * s, 0.46 * s, 0.72 * s,
          -wrr * 0.90, wnd.y * s, wz, 0, -0.14, 0, 0.02);
      }
      B.dark = 0; B.paint = 'skin';
      B.tint = o.body || null;
    }
    if (T.cabinWindows) {
      B.tint = null; B.dark = 0.80; B.paint = 'flat';
      for (i = 0; i < T.cabinWindows; i++) {
        var cwz = -half * 0.34 + i * 1.5 * s;
        var cwr = Math.max(0.05, fuseProfile((cwz + half) / (T.len * s), spec));
        B.boxR('skin_dull', 0.08 * s, 0.34 * s, 0.30 * s, cwr * 0.94, spec.centreY + spec.r * 0.34, cwz, 0, 0, 0, 0.01);
        B.boxR('skin_dull', 0.08 * s, 0.34 * s, 0.30 * s, -cwr * 0.94, spec.centreY + spec.r * 0.34, cwz, 0, 0, 0, 0.01);
      }
      B.dark = 0; B.paint = 'skin';
      B.tint = o.body || null;
    }
    if (T.radome) {
      B.tint = tint(0x585c58, 0.55);
      B.cyl('skin_dull', 0.05 * s, spec.r * 0.62, 1.5 * s, 0,
        fuseYc(0.03, spec), -half + 0.75 * s, Math.PI * 0.5, 0, 0, 12);
      B.tint = o.body || null;
    }

    // ---- wrapped openings ---------------------------------------------------
    if (o.wrapped > 0.05) {
      if (T.intakes) {
        for (i = 0; i < T.intakes.length; i++) {
          var wi = T.intakes[i];
          buildWrapDisc(B, wi.x * s, wi.y * s, wi.z * s - 1.15 * s, wi.r * s * 1.18, -0.30 * s, (o.seed || 1) + i);
          buildWrapDisc(B, -wi.x * s, wi.y * s, wi.z * s - 1.15 * s, wi.r * s * 1.18, -0.30 * s, (o.seed || 1) + i + 3);
        }
      }
      if (T.exhaust) {
        // A jet-pipe plug is a taped-on CAP, not a balloon. At r x 1.2 with a
        // 0.26 dome it photographed as a golf ball stuck on the tail.
        buildWrapDisc(B, 0, spec.centreY * 0.98, T.exhaust.z * s + 0.46 * s,
          T.exhaust.r * s * 1.06, 0.10 * s, (o.seed || 1) * 2.1);
      }
      if (T.engines) {
        for (i = 0; i < T.engines.length; i++) {
          var we = T.engines[i];
          var wey = (T.wing ? T.wing.y * s : spec.centreY) - (we.prop ? 0.16 : we.drop) * s;
          if (!we.prop) {
            buildWrapDisc(B, we.x * s, wey, we.z * s - we.len * s * 0.5 - 0.12 * s, we.r * s * 1.02, -0.30 * s, (o.seed || 1) + i);
            buildWrapDisc(B, -we.x * s, wey, we.z * s - we.len * s * 0.5 - 0.12 * s, we.r * s * 1.02, -0.30 * s, (o.seed || 1) + i + 5);
          }
        }
      }
    }

    // ---- the wing box, when the wings have been cut off ---------------------
    if ((o.noWings && T.wing) || T.stripped) {
      B.tint = null; B.dark = 0.62; B.paint = 'metal';
      var wbz = T.stripped ? 0.6 * s : (T.wing ? T.wing.rootZ * s + T.wing.rootC * s * 0.5 : 0);
      var wby = T.stripped ? spec.centreY - spec.r * 0.30 : (T.wing ? T.wing.y * s : spec.centreY);
      var wbr = Math.max(0.05, fuseProfile((wbz + half) / (T.len * s), spec));
      for (i = 0; i < 2; i++) {
        var sgn = i ? -1 : 1;
        // ---- AN OPEN BAY IS NOT A BLACK RECTANGLE ------------------------
        // It used to be: a recessed dark face with three ribs on it, which at
        // the range `interior` stands at reads as a hole cut in the side. What
        // a stripped wing box actually shows is ZINC CHROMATE - the yellow-
        // green primer every unpainted aircraft interior in the world is
        // finished in - with frames, a spar web and a cable loom in front of
        // it. The primer is the point: it is the one saturated colour on the
        // airframe, it is unmistakably "inside", and it means the eye reads
        // depth rather than absence.
        B.tint = tint(0xb2a94e, 0.62); B.dark = 0.34;
        B.boxR('skin_dull', 0.16 * s, 1.05 * s, 3.4 * s, sgn * wbr * 0.88, wby, wbz, 0, 0, 0, 0.03);
        B.tint = null; B.dark = 0.16;
        for (var rb = 0; rb < 3; rb++) {
          B.boxR('skin_dull', 0.30 * s, 0.92 * s, 0.10 * s,
            sgn * wbr * 0.92, wby, wbz - 1.3 * s + rb * 1.3 * s, 0, 0, 0, 0.02);
        }
        // the spar web across the opening, and the loom clipped along it
        B.dark = 0.24;
        B.boxR('skin_dull', 0.26 * s, 0.13 * s, 3.3 * s,
          sgn * wbr * 0.93, wby + 0.34 * s, wbz, 0, 0, 0, 0.02);
        B.tint = tint(0x30343a, 0.70); B.dark = 0.55;
        B.cyl('skin_dull', 0.045 * s, 0.045 * s, 3.1 * s,
          sgn * wbr * 0.95, wby - 0.30 * s, wbz, Math.PI * 0.5, 0, 0, 6);
        B.cyl('skin_dull', 0.032 * s, 0.032 * s, 3.1 * s,
          sgn * wbr * 0.95, wby - 0.42 * s, wbz, Math.PI * 0.5, 0, 0, 6);
        B.tint = null; B.dark = 0.62;
      }
      B.dark = 0; B.paint = 'skin';
      B.tint = o.body || null;
    }

    // ---- what it is standing on --------------------------------------------
    var gy = 0;
    if (T.gear === 'bogie') {
      if (o.onJacks) {
        buildJack(B, T.mainGearX * s, T.mainGearZ * s, T.gearH * s * 1.02);
        buildJack(B, -T.mainGearX * s, T.mainGearZ * s, T.gearH * s * 1.02);
        buildJack(B, 0, T.noseGearZ * s, T.gearH * s * 0.90);
      } else {
        buildBogie(B, T.mainGearX * s, T.mainGearZ * s, T.gearH * s, T.wheelR * s);
        buildBogie(B, -T.mainGearX * s, T.mainGearZ * s, T.gearH * s, T.wheelR * s);
        buildGear(B, 0, T.noseGearZ * s, T.gearH * s * 0.90, T.wheelR * s * 0.78, true, 0.22 * s);
        // main gear fairings: the blisters on the side of a transport
        B.tint = o.body || null;
        B.boxR('airframe', 1.15 * s, 1.30 * s, 5.6 * s, T.mainGearX * s + 0.30 * s,
          T.gearH * s * 0.72, T.mainGearZ * s, 0, 0, 0, 0.30 * s);
        B.boxR('airframe', 1.15 * s, 1.30 * s, 5.6 * s, -T.mainGearX * s - 0.30 * s,
          T.gearH * s * 0.72, T.mainGearZ * s, 0, 0, 0, 0.30 * s);
      }
    } else if (T.gear === 'twin' || T.gear === 'single') {
      var twin = T.gear === 'twin';
      if (o.onJacks) {
        buildJack(B, T.mainGearX * s, T.mainGearZ * s, T.gearH * s);
        buildJack(B, -T.mainGearX * s, T.mainGearZ * s, T.gearH * s);
        buildJack(B, 0, T.noseGearZ * s, T.gearH * s * 0.88);
      } else {
        buildGear(B, T.mainGearX * s, T.mainGearZ * s, T.gearH * s, T.wheelR * s, twin, 0.20 * s);
        buildGear(B, -T.mainGearX * s, T.mainGearZ * s, T.gearH * s, T.wheelR * s, twin, 0.20 * s);
        buildGear(B, 0, T.noseGearZ * s, T.gearH * s * 0.88, T.wheelR * s * 0.76, twin, 0.16 * s);
      }
    } else if (T.gear === 'cradle') {
      B.tint = tint(0x6b563c, 0.70); B.paint = 'rust';
      for (i = 0; i < 3; i++) {
        var cz2 = -half * 0.62 + i * half * 0.62;
        B.box('rusted', 3.1 * s, 0.28 * s, 0.60 * s, 0, spec.centreY - spec.r * 0.86 - 0.14 * s, cz2, 0.03);
        B.box('rusted', 0.34 * s, spec.centreY - spec.r * 0.86 - 0.30 * s, 0.55 * s,
          1.20 * s, (spec.centreY - spec.r * 0.86 - 0.30 * s) * 0.5, cz2, 0.03);
        B.box('rusted', 0.34 * s, spec.centreY - spec.r * 0.86 - 0.30 * s, 0.55 * s,
          -1.20 * s, (spec.centreY - spec.r * 0.86 - 0.30 * s) * 0.5, cz2, 0.03);
      }
      B.paint = 'skin'; B.tint = o.body || null;
    } else if (T.gear === 'skid') {
      B.tint = null; B.paint = 'metal';
      for (i = 0; i < 2; i++) {
        var sg = i ? -1 : 1;
        B.cyl('steel', 0.075 * s, 0.075 * s, 4.2 * s, sg * 1.15 * s, 0.09 * s, 0.2 * s, Math.PI * 0.5, 0, 0, 8);
        B.strut('steel', sg * 1.15 * s, 0.12 * s, -1.3 * s, sg * 0.42 * s, spec.centreY - spec.r * 0.90, -1.0 * s, 0.11 * s, 0.11 * s);
        B.strut('steel', sg * 1.15 * s, 0.12 * s, 1.5 * s, sg * 0.42 * s, spec.centreY - spec.r * 0.90, 1.2 * s, 0.11 * s, 0.11 * s);
      }
      B.paint = 'skin'; B.tint = o.body || null;
    }

    // ---- rotor head ---------------------------------------------------------
    if (typeName === 'heli') {
      B.tint = null; B.paint = 'metal';
      B.cyl('steel', 0.22 * s, 0.30 * s, 0.9 * s, 0, T.rotorY * s - 0.3 * s, -0.4 * s, 0, 0, 0, 10);
      B.cyl('steel', 0.34 * s, 0.34 * s, 0.34 * s, 0, T.rotorY * s + 0.2 * s, -0.4 * s, 0, 0, 0, 10);
      // blades, drooping: the single most recognisable silhouette in the yard
      B.tint = tint(0x33373a, 0.62);
      for (i = 0; i < T.blades; i++) {
        var ra = (o.rotorPhase || 0.3) + i * (Math.PI * 2 / T.blades);
        var rl = T.rotorR * s;
        B.boxR('skin_dull', rl, 0.075 * s, 0.52 * s,
          Math.sin(ra) * rl * 0.5, T.rotorY * s + 0.2 * s - 0.34 * s, -0.4 * s + Math.cos(ra) * rl * 0.5,
          0, ra + Math.PI * 0.5, -0.075, 0.02);
      }
      B.paint = 'skin'; B.tint = o.body || null;
    }

    // ---- stencils -----------------------------------------------------------
    // Not decoration: the serial and the inventory tag are the difference
    // between "a model of an aeroplane" and "a specific aeroplane that has been
    // catalogued and parked".
    var sc = (T.stencilScale || 1) * s;
    var sr = Math.max(0.05, fuseProfile(0.42, spec));
    B.paint = 'flat'; B.tint = null; B.dark = 0;
    decalCard(B, 0, sr * 0.99, spec.centreY + spec.r * 0.30, -half * 0.20, 3.0 * sc, 0.72 * sc, 'x', 1);
    decalCard(B, 0, -sr * 0.99, spec.centreY + spec.r * 0.30, -half * 0.20, 3.0 * sc, 0.72 * sc, 'x', -1);
    decalCard(B, 3, sr * 0.99, spec.centreY - spec.r * 0.28, half * 0.14, 1.5 * sc, 1.5 * sc, 'x', 1);
    if (!o.wrapped || o.wrapped < 0.5) {
      decalCard(B, 5, sr * 0.99, spec.centreY + spec.r * 0.02, half * 0.34, 2.0 * sc, 2.0 * sc, 'x', 1);
      decalCard(B, 5, -sr * 0.99, spec.centreY + spec.r * 0.02, half * 0.34, 2.0 * sc, 2.0 * sc, 'x', -1);
    }
    if (T.intakes) {
      decalCard(B, 2, T.intakes[0].x * s + T.intakes[0].r * s * 1.15,
        T.intakes[0].y * s + 0.3 * s, T.intakes[0].z * s - 0.4 * s, 0.9 * sc, 0.9 * sc, 'x', 1);
    }
    B.paint = 'skin';

    return {
      len: T.len * s, span: T.span * s, half: half,
      wingY: wingY, wingTipY: wingTipY, tailY: tailTopY,
      centreY: spec.centreY, r: spec.r
    };
  }

  // ============================================================== THE GROUND ==
  function buildPad(L, B, rng, N) {
    var i, j;
    B.paint = 'ground'; B.tint = null;

    // 1.5 m cells, not 3. The joint grid and the crack field are painted (see
    // buildCrackTexture) and always were, but at a 3 m step the slab's own
    // CROWN and its settlement trough were being sampled too coarsely to read
    // as anything but a plane, and the same 3 m vertices carry the wear colour,
    // so every wear feature finer than three metres arrived as a soft blob.
    // 32k triangles against a 4.5M budget is not a trade.
    var slab = gridSurface(PAD_X0 - 3, PAD_X1 + 3, PAD_Z0 - 3, PAD_Z1 + 3, 1.5,
      function (x, z) { return groundY(x, z, N); });
    B.add('hardstand', slab, null);

    // A floor collider per 17 m tile: the slab is flat enough that a plate is
    // within 3 cm of the mesh everywhere inside a tile.
    var nx = Math.ceil((PAD_X1 - PAD_X0) / 17), nz = Math.ceil((PAD_Z1 - PAD_Z0) / 17);
    for (i = 0; i < nx; i++) {
      for (j = 0; j < nz; j++) {
        var cx = PAD_X0 + 8.5 + i * 17, cz = PAD_Z0 + 8.5 + j * 17;
        L.addCollider(cx, groundY(cx, cz, N) - 0.6, cz, 8.6, 0.6, 8.6, 'concrete', true);
      }
    }

    // ---- asphalt repairs ----------------------------------------------------
    // Big irregular patches where a slab has been cut out and made good. They
    // are the only large DARK areas on the hardstanding and they do more for the
    // "flat white frame" problem than any amount of grading.
    // ------------------------------------------------------------------------
    // TWENTY-TWO, not eight, and the reason is a scale argument rather than a
    // taste one. From the establishing eye the slab is 60-70 % of the frame at
    // 50-200 m, where the concrete's own texture - a 2.9 m tile on a 1.5 m
    // vertex grid - is at or below one pixel and contributes nothing. The only
    // marks on 204 x 168 m of hardstanding that survive that reduction are the
    // ones measured in TENS of metres: the bay joint grid, the tow lanes, the
    // aircraft shadows and these. Eight of them left the whole west field and
    // the entire east apron without a single one, so three quarters of the slab
    // had no tonal event on it at all. Each patch is a 2.4 m gridSurface, about
    // 60 triangles, in a bucket that already exists - fourteen more of them cost
    // ~900 triangles out of 2.5 M of headroom and no draw call whatsoever, and
    // they are what a forty-year-old apron that has had its drains and its
    // ducting dug up actually looks like.
    //
    // Placed along the row corridors and the tow routes (which is where a slab
    // is cut) rather than scattered, and deliberately NOT on the taxiway
    // centreline, where the painted overlay already carries the story.
    B.paint = 'patch';
    var patches = [
      [-6, 26, 16, 11], [30, -20, 22, 13], [-46, 6, 18, 9],
      [8, -52, 26, 15], [-70, -40, 14, 20], [52, 12, 12, 16],
      [-30, 58, 20, 10], [70, -60, 18, 14],
      // the west storage field: down each row corridor, where the tugs work
      [-33, -24, 15, 9], [-51, -60, 17, 11], [-69, 22, 12, 15],
      [-88, -10, 13, 10], [-58, 36, 11, 9], [-84, -66, 15, 12],
      [-15, -8, 10, 13], [-40, -46, 12, 8],
      // the east apron, which had none at all
      [86, -28, 17, 12], [88, 32, 14, 17], [46, -42, 19, 11],
      [24, -70, 15, 12], [64, 52, 13, 10], [78, 6, 12, 14]
    ];
    for (i = 0; i < patches.length; i++) {
      var p = patches[i];
      var pg = gridSurface(p[0] - p[2] * 0.5, p[0] + p[2] * 0.5,
        p[1] - p[3] * 0.5, p[1] + p[3] * 0.5, 2.4,
        function (x, z) { return groundY(x, z, N) + 0.018; });
      B.add('pad_patch', pg, null);
    }
    B.paint = 'ground';
  }

  // ---------------------------------------------------------------------------
  // The joint / craze overlay mesh. Its own object rather than a bucket in the
  // merge, because it is the one surface in the level that is alpha-blended and
  // world-UV'd to a DIFFERENT tile from everything else, and because its vertex
  // colour carries an ALPHA (itemSize 4) that _paint has no vocabulary for.
  //
  // The alpha is the point: run the craze at full strength over 200 m and it is
  // wallpaper. It fades out under blown sand, off the pad edge, and along the
  // wheel tracks where the surface is polished rather than crazed.
  // ---------------------------------------------------------------------------
  function buildPadOverlay(L, rng, N) {
    var mat = L.material('crack');
    if (!mat || !mat.map) return null;
    var g = gridSurface(PAD_X0 - 1.5, PAD_X1 + 1.5, PAD_Z0 - 1.5, PAD_Z1 + 1.5, 1.5,
      function (x, z) { return groundY(x, z, N) + 0.010; });
    Geo.worldUV(g, 1 / CRACK_TILE);
    var pos = g.attributes.position, n = pos.count;
    var col = new Float32Array(n * 4);
    for (var i = 0; i < n; i++) {
      var x = pos.getX(i), z = pos.getZ(i);
      // sand buries the craze; the pad edge has none of it to bury
      var sand = sandCover(x, z, N);
      var edge = padMask(x, z);
      var v = N.fbm2(x * 0.055 - 9.0, z * 0.055 + 4.0, 3) * 0.5 + 0.5;
      var a = edge * (0.66 + v * 0.50) * (1 - sand * 0.34);
      // polished lanes: the taxiway centre is driven on, not baked
      a *= 1 - 0.22 * M.saturate(1 - Math.abs(x) / (TAXI_HALF * 0.8));
      col[i * 4] = 1; col[i * 4 + 1] = 1; col[i * 4 + 2] = 1;
      col[i * 4 + 3] = M.saturate(a);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.computeBoundingSphere();
    var mesh = new THREE.Mesh(g, mat);
    mesh.name = 'boneyard_padjoints';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    L.root.add(mesh);
    L.meshes.push(mesh);
    return mesh;
  }

  // A deterministic 0..1 hash. stripe() needs per-dash jitter and it must not
  // consume the level rng, because the aircraft plan draws from the same stream
  // and a marking change would reshuffle thirty-four aeroplanes.
  function hash01(a, b, c) {
    var s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
    return s - Math.floor(s);
  }

  // ---------------------------------------------------------------------------
  // A painted line on the slab.
  //
  // "Perfectly clean, straight, or uniform anything" is on the instant-fail
  // list and a taxiway stripe is the easiest place in a level to fail it: at 3x
  // zoom the yellow centreline was a continuous constant-value band from 2 m to
  // 60 m with no repaint overlap, no wheel-track erasure and no chipping. The B
  // channel of the wear mask was doing its job, but a wear mask cannot put a
  // GAP in a stripe, and a gap is what a worn stripe is.
  //
  // So each dash now carries its own length, its own lateral offset and its own
  // width, and a dash the tyre-track field runs over is simply not emitted -
  // that is the same wandering track function the ground wear uses, so the
  // erasure lands exactly where the rubber is.
  // ---------------------------------------------------------------------------
  function stripe(B, x0, z0, x1, z1, w, N, dashLen, gapLen, seed) {
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return;
    var ux = dx / len, uz = dz / len;
    var yaw = Math.atan2(dx, dz);
    // Even a "solid" line is emitted in 3 m segments so it can be jittered and
    // broken; a 160 m unbroken bar is the thing being fixed.
    var solid = !dashLen;
    var step = dashLen ? (dashLen + gapLen) : Math.min(3.2, len);
    var n = Math.max(1, Math.round(len / step));
    step = len / n;
    var sd = seed === undefined ? (x0 * 0.37 + z0 * 0.11) : seed;
    for (var i = 0; i < n; i++) {
      var h1 = hash01(i, sd, 1.7), h2 = hash01(i, sd, 4.3), h3 = hash01(i, sd, 9.1);
      var baseRun = dashLen ? Math.min(dashLen, step * 0.62) : step;
      var run = baseRun * (solid ? (0.90 + h1 * 0.10) : (0.86 + h1 * 0.24));
      var t0 = i * step + (dashLen ? (step - run) * 0.5 : (step - run) * h2);
      var mid = t0 + run * 0.5;
      // a few centimetres of lateral wander: nobody paints to a string line
      var off = (h2 - 0.5) * 0.10;
      var mx = x0 + ux * mid - uz * off, mz = z0 + uz * mid + ux * off;
      // erased where the wheels go, and simply missing here and there
      var wob = Math.sin(mz * 0.045) * 1.4 + Math.sin(mz * 0.017 + 2.1) * 2.2;
      var tt = Math.min(Math.abs(mx - 3.6 - wob), Math.abs(mx + 3.6 - wob));
      if (tt < 0.55 && h3 < 0.72) continue;
      if (h3 > 0.955) continue;
      B.add('paint_line', box(w * (0.86 + h1 * 0.26), 0.014, run, 0.004),
        makeM(mx, groundY(mx, mz, N) + 0.014, mz, 0, yaw + (h2 - 0.5) * 0.010, 0));
    }
  }

  function buildMarkings(L, B, rng, N) {
    var i, j;
    B.paint = 'line'; B.tint = null;

    // Taxiway Alpha: a dashed yellow centreline with a solid line either side.
    // This is the leading line of the spawn view and of the overview, and it is
    // the only thing in 200 m of concrete that has a DIRECTION.
    stripe(B, 0, TAXI_Z1, 0, TAXI_Z0, 0.30, N, 9.0, 5.0);
    stripe(B, -TAXI_HALF, TAXI_Z1 - 2, -TAXI_HALF, TAXI_Z0 + 2, 0.20, N);
    stripe(B, TAXI_HALF, TAXI_Z1 - 2, TAXI_HALF, TAXI_Z0 + 2, 0.20, N);
    // the double-dashed hold-short bars where the rows join the taxiway
    for (i = 0; i < ROW_BAYS.length; i++) {
      var hz = ROW_BAYS[i] + 9.0;
      stripe(B, -TAXI_HALF - 0.9, hz, -TAXI_HALF - 4.2, hz, 0.20, N);
      stripe(B, -TAXI_HALF - 0.9, hz + 0.7, -TAXI_HALF - 4.2, hz + 0.7, 0.20, N);
    }

    // Storage row centrelines and the nose-stop bar for every bay. A parked
    // aircraft in a real yard sits ON a painted line, and the lines carry on
    // past the aircraft into the distance, which is what gives the rows depth.
    for (i = 0; i < ROWS_X.length; i++) {
      var rx = ROWS_X[i];
      stripe(B, rx, ROW_BAYS[0] - 12, rx, ROW_BAYS[ROW_BAYS.length - 1] + 12, 0.18, N, 0, 0, i * 3.1);
      // Two of the four rows have been REPAINTED, and whoever did it did not
      // line the new coat up with the old: a second stripe 8 cm off the first,
      // narrower, running only part of the row. It is the cheapest possible way
      // to say the markings are older than the aeroplanes standing on them.
      if (i === 1 || i === 2) {
        stripe(B, rx + 0.09, ROW_BAYS[0] - 6, rx + 0.09, ROW_BAYS[3] + 4, 0.13, N, 0, 0, 40 + i);
      }
      for (j = 0; j < ROW_BAYS.length; j++) {
        var bz = ROW_BAYS[j];
        stripe(B, rx - 2.6, bz - 7.4, rx + 2.6, bz - 7.4, 0.20, N, 0, 0, i * 7 + j);
      }
    }
    // the cross lane edges
    stripe(B, -92, CROSS_Z0, -14, CROSS_Z0, 0.18, N, 3.0, 2.0);
    stripe(B, -92, CROSS_Z1, -14, CROSS_Z1, 0.18, N, 3.0, 2.0);

    // Sierra Seven's own stand: a box, a nose-stop T and a keep-clear hatch.
    var sx = S7_X, sz = S7_Z;
    stripe(B, sx - 23, sz + 22, sx + 23, sz + 22, 0.22, N);
    stripe(B, sx - 23, sz - 24, sx + 23, sz - 24, 0.22, N);
    stripe(B, sx - 23, sz - 24, sx - 23, sz + 22, 0.22, N);
    stripe(B, sx + 23, sz - 24, sx + 23, sz + 22, 0.22, N);
    stripe(B, sx, sz + 22, sx, sz - 24, 0.24, N, 6.0, 4.0);
    for (i = 0; i < 9; i++) {
      stripe(B, sx - 22 + i * 2.6, sz + 18.0, sx - 20 + i * 2.6, sz + 21.4, 0.16, N);
    }

    // hangar apron chevrons and the tow route into the parts yard
    for (i = 0; i < 8; i++) {
      var cz = HG_DOOR_Z0 - 1.0 + i * 2.6;
      stripe(B, HG_X0 - 1.0, cz, HG_X0 - 5.4, cz + 2.2, 0.18, N);
    }
    var tow = [[9.0, 56.0], [22.0, 52.0], [30.0, 44.0], [40.0, 44.0], [HG_X0 - 1.5, 47.0]];
    for (i = 0; i + 1 < tow.length; i++) {
      stripe(B, tow[i][0], tow[i][1], tow[i + 1][0], tow[i + 1][1], 0.16, N, 3.2, 2.4);
    }

    // ---- ground stencils ----------------------------------------------------
    B.paint = 'flat';
    var bays = [[-24, 8, 8], [-42, 8, 9], [-60, 8, 10], [-78, 8, 11],
                [-24, -70, 9], [-42, -70, 10], [-60, -70, 11], [-78, -70, 8]];
    for (i = 0; i < bays.length; i++) {
      var by = groundY(bays[i][0], bays[i][1], N) + 0.020;
      decalCard(B, bays[i][2], bays[i][0], by, bays[i][1] - 10.4, 3.0, 3.0, 'y', 1, 0);
    }
    decalCard(B, 11, 6.0, groundY(6.0, 46.0, N) + 0.020, 46.0, 3.4, 3.4, 'y', 1, 0.5);
    decalCard(B, 8, S7_X, groundY(S7_X, S7_Z + 25, N) + 0.020, S7_Z + 25, 4.2, 4.2, 'y', 1, 0);
    // A bay number at the head of EVERY row, where it joins the taxiway - the
    // atlas already generates four of these and three of them were never in
    // frame. A boneyard is an inventory yard; the numbering is the inventory.
    for (i = 0; i < ROWS_X.length; i++) {
      var hx = ROWS_X[i], hz = ROW_BAYS[ROW_BAYS.length - 1] + 11.5;
      decalCard(B, 8 + (i % 4), hx, groundY(hx, hz, N) + 0.020, hz, 3.6, 3.6, 'y', 1,
        (i - 1.5) * 0.02);
      var hz2 = ROW_BAYS[0] - 13.0;
      decalCard(B, 8 + ((i + 2) % 4), hx, groundY(hx, hz2, N) + 0.020, hz2, 3.4, 3.4, 'y', 1,
        (i - 1.5) * 0.03 + Math.PI);
    }
    B.paint = 'ground';

    // ---- tie-down rings -----------------------------------------------------
    // Small, and the reason they earn their triangles: they are the only object
    // on 200 m of slab at HUMAN scale, so they are what the eye measures the
    // aircraft against.
    B.paint = 'rust'; B.tint = tint(0x6f5a44, 0.6);
    for (i = 0; i < ROWS_X.length; i++) {
      for (j = 0; j < ROW_BAYS.length; j++) {
        var tx = ROWS_X[i], tz = ROW_BAYS[j];
        for (var k = 0; k < 4; k++) {
          var ox = (k & 1) ? 3.6 : -3.6, oz = (k & 2) ? 4.2 : -3.0;
          var ty = groundY(tx + ox, tz + oz, N);
          B.box('rusted', 0.34, 0.05, 0.34, tx + ox, ty + 0.024, tz + oz, 0.01);
          B.cyl('rusted', 0.11, 0.11, 0.05, tx + ox, ty + 0.062, tz + oz, 0, 0, 0, 8);
        }
      }
    }
    B.tint = null; B.paint = 'ground';
  }

  function buildDesert(L, B, rng, N) {
    B.paint = 'sand'; B.tint = null;
    var D0X = -270, D1X = 276, D0Z = -262, D1Z = 240;
    var step = 7.5;
    function g(x, z) { return groundY(x, z, N); }
    // four patches round the pad, so no triangle spans the pad edge
    B.add('desert', gridSurface(D0X, D1X, D0Z, PAD_Z0 - 2, step, g), null);
    B.add('desert', gridSurface(D0X, D1X, PAD_Z1 + 2, D1Z, step, g), null);
    B.add('desert', gridSurface(D0X, PAD_X0 - 2, PAD_Z0 - 2, PAD_Z1 + 2, step, g), null);
    B.add('desert', gridSurface(PAD_X1 + 2, D1X, PAD_Z0 - 2, PAD_Z1 + 2, step, g), null);
    // the seam strip, at pad resolution so the drift against the slab edge reads
    B.add('desert', gridSurface(PAD_X0 - 3.5, PAD_X1 + 3.5, PAD_Z0 - 3.5, PAD_Z0 + 1, 2.0, g), null);
    B.add('desert', gridSurface(PAD_X0 - 3.5, PAD_X1 + 3.5, PAD_Z1 - 1, PAD_Z1 + 3.5, 2.0, g), null);

    // ---- THE OUTFIELD, and it is not optional ---------------------------------
    // The desert grid above stops at ~270 m and the ridge starts at 430, which
    // in the first capture left 160 m of NOTHING between them: the eye looked
    // straight through the gap at the ridge ribbon's own inner face, and the
    // result was a dark grey band lying across the whole horizon under the
    // mountains. A ring of very coarse ground closes it. 24 m cells - it is only
    // ever seen past 270 m and its entire job is to BE there.
    // Out to 560 m, which is not arbitrary: buildRidge's inner toe is at 330 m
    // and the outfield HAS to pass under it, or the eye looks through the gap
    // between them at the underside of the range.
    var O0X = -556, O1X = 562, O0Z = -548, O1Z = 526;
    var st2 = 32.0;
    B.add('desert', gridSurface(O0X, O1X, O0Z, D0Z + 4, st2, g), null);
    B.add('desert', gridSurface(O0X, O1X, D1Z - 4, O1Z, st2, g), null);
    B.add('desert', gridSurface(O0X, D0X + 4, D0Z, D1Z, st2, g), null);
    B.add('desert', gridSurface(D1X - 4, O1X, D0Z, D1Z, st2, g), null);

    // ---- the perimeter service road -----------------------------------------
    B.paint = 'gravel';
    var rz0 = PAD_Z0 - 9, rz1 = PAD_Z1 + 9;
    B.add('verge', gridSurface(PAD_X1 + 4, PAD_X1 + 11, rz0, rz1, 4.0,
      function (x, z) { return groundY(x, z, N) + 0.03; }), null);
    B.add('verge', gridSurface(PAD_X0 - 11, PAD_X0 - 4, rz0, rz1, 4.0,
      function (x, z) { return groundY(x, z, N) + 0.03; }), null);
    B.add('verge', gridSurface(PAD_X0 - 11, PAD_X1 + 11, rz1 - 4, rz1 + 3, 4.0,
      function (x, z) { return groundY(x, z, N) + 0.03; }), null);
    B.paint = 'ground'; B.tint = null;
  }

  // ---------------------------------------------------------------------------
  // THE RIDGE. A desert with a flat horizon has no scale and no far value
  // anchor, and at noon the sky/ground boundary is the single highest-contrast
  // edge in the frame. Two jagged ribbons at 430 and 560 m, hazed by
  // materials.distant(), turn that edge into three tonal steps.
  // ---------------------------------------------------------------------------
  function buildRidge(L, B, rng, N) {
    B.paint = 'flat'; B.tint = null;
    // ------------------------------------------------------------------------
    // THE RANGE, third attempt, and the two failures are both worth recording
    // because they are the two obvious ways to build a distant horizon and both
    // of them photograph as something other than a mountain.
    //
    //   1. A VERTICAL RIBBON (a cylinder with a rock texture). No form at all -
    //      it printed as a circular wall standing round the level with visibly
    //      tiling wallpaper on it.
    //   2. A THREE-RING FAN WITH FACE NORMALS. Better silhouette, but at 150
    //      segments over a 420 m radius each triangle is 18 x 80 m, and one flat
    //      normal across 80 m of rock under a hard key gives alternating light
    //      and dark facets. It printed as a glacier.
    //
    // What a range at 400 m actually is, optically: a smooth value gradient
    // under a jagged crest line, plus aerial perspective. So this is a RADIAL
    // HEIGHT FIELD - five rings, 208 samples round - run through ringLoft, which
    // builds it indexed and lets three average the vertex normals. Smooth
    // shading over a jagged silhouette is the whole trick, and it costs the same
    // 2000 triangles the faceted version did.
    //
    // The crest height, the crest RADIUS and the shoulder fraction all come off
    // separate noise fields so the range is not a circle, and each band takes its
    // own materials.distant() haze.
    // ------------------------------------------------------------------------
    // ------------------------------------------------------------------------
    // AND THE RANGE IS NO LONGER A CLOSED RING.
    //
    // Both bands used to run the full 360 degrees, so the horizon was a
    // continuous wall: no gap, no distant valley, and nowhere in the level
    // where the desert reaches the sky at ground level. That is what costs a
    // flat yard its sense of scale - the audience has nothing to measure 200 m
    // against - and it is also why the top third of three published framings is
    // one silhouette.
    //
    // `gaps` are angular arcs (in the ring's own parameter a, where the world
    // compass bearing is 90 - a) over which the band's height is scaled down.
    // Band 0 goes fully to zero over a 44-degree arc centred at a = 35, which
    // is the arc the overview, hero2 and hero3 all look through; band 1 only
    // comes down to 0.42 over a wider, offset arc, so what fills the gap is a
    // FURTHER, HAZIER, LOWER range rather than empty sky - a valley, which is
    // both truthful and worth more than a hole. The second gap on each band is
    // behind the camera in every pose and exists so the ring is not a ring.
    // ------------------------------------------------------------------------
    // AND A THIRD BAND, THE NEAR ONE, BECAUSE TWO BANDS AT 322 AND 508 m READ
    // AS ONE.
    //
    // Both existing bands sit past 322 m, so materials.distant() hazes them to
    // within a few per cent of each other and they overlap into a single mass:
    // in the establishing frame the range is one flat grey-brown wall filling a
    // quarter of the picture with no internal value break anywhere in it, and it
    // is a measurable share of the frame's flat_area_pct. Aerial perspective is
    // a RATIO, so the only way to get a second tonal step out of it is to put
    // something much NEARER in front of it - at 200-330 m the same material
    // carries barely half the haze, which lands this band as a distinctly
    // darker, warmer lip under the pale range behind it.
    //
    // Low and rolling (6-28 m against 24-96), because what is actually there in
    // a Sonoran basin at that range is bajada and creosote hummock, not a third
    // sierra: k 5.6 gives it a much shorter horizontal wavelength than the
    // ranges, so it reads as a different landform rather than as a scale copy.
    // It inherits band 0's gap at a = 35 - that arc is the one place the desert
    // is allowed to reach the sky at ground level and it is worth more than a
    // hill - and it costs 1.7 k triangles in the `ridge` bucket that already
    // exists, i.e. no draw call.
    var bands = [
      { r0: 200, r1: 330, h0: 6, h1: 28, k: 5.6, seed: -3.5, rj: 0.10,
        gaps: [[35, 40, 0.0], [128, 44, 0.22], [252, 40, 0.18]] },
      { r0: 322, r1: 486, h0: 24, h1: 96, k: 3.4, seed: 2.0, rj: 0.11,
        gaps: [[35, 44, 0.0], [214, 30, 0.30]] },
      { r0: 508, r1: 596, h0: 74, h1: 172, k: 2.2, seed: 8.5, rj: 0.055,
        gaps: [[48, 62, 0.42], [236, 34, 0.55]] }
    ];
    // Smooth shoulder on each gap so a spur runs DOWN into it instead of being
    // guillotined: 1 outside, `floor` at the centre.
    function gapScale(bd, adeg) {
      var s = 1, gi;
      if (!bd.gaps) return 1;
      for (gi = 0; gi < bd.gaps.length; gi++) {
        var gp = bd.gaps[gi];
        var dd = Math.abs(((adeg - gp[0]) % 360 + 540) % 360 - 180);
        dd = 180 - dd;                       // angular distance to the centre
        var hw = gp[1] * 0.5;
        if (dd >= hw) continue;
        s = Math.min(s, M.lerp(gp[2], 1.0, M.smoothstep(0, 1, dd / hw)));
      }
      return s;
    }
    var RINGS = [0.0, 0.30, 0.56, 0.80, 1.0];
    // How high the range stands at each radial station, as a fraction of its
    // crest: a concave toe, a shoulder, the crest just before the far edge, then
    // the start of the back slope. This profile is what gives a lit face that
    // brightens toward the top instead of one flat plane.
    var PROF = [0.0, 0.24, 0.62, 1.0, 0.74];
    for (var b = 0; b < bands.length; b++) {
      var bd = bands[b];
      var n = 208, i, j;
      var hs = [], rr = [], sk = [];
      for (i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2;
        var ca = Math.cos(a) * bd.k + bd.seed, sa = Math.sin(a) * bd.k - bd.seed;
        var rd = N.ridged2(ca, sa, 5);
        var f2 = N.fbm2(ca * 2.7 + 30, sa * 2.7, 3) * 0.5 + 0.5;
        hs.push(M.lerp(bd.h0, bd.h1, M.saturate(rd * 0.78 + f2 * 0.42)) *
          gapScale(bd, (i / n) * 360));
        rr.push(1 + bd.rj * N.fbm2(ca * 1.3 - 12, sa * 1.3 + 7, 3));
        // a per-angle skew of the whole profile: some spurs run out further
        // than others, which is what stops the shoulder being a contour line
        sk.push(0.82 + 0.34 * (N.fbm2(ca * 2.2 + 41, sa * 2.2 - 6, 2) * 0.5 + 0.5));
      }
      var rings = [];
      for (j = 0; j < RINGS.length; j++) {
        var ring = [];
        for (i = 0; i < n; i++) {
          var a2 = (i / n) * Math.PI * 2;
          var t = RINGS[j];
          var rad = M.lerp(bd.r0, bd.r1 * rr[i], Math.min(1, t * sk[i]));
          // a little radial texture so the face is not a ruled surface
          var wob = 1 + 0.035 * N.fbm2(Math.cos(a2) * bd.k * 5 + t * 9,
                                       Math.sin(a2) * bd.k * 5 - t * 4, 2);
          var y = hs[i] * PROF[j] * wob - 2;
          ring.push([Math.cos(a2) * rad, y, Math.sin(a2) * rad]);
        }
        rings.push(ring);
      }
      B.add('ridge', ringLoft(rings, true), null);
    }
    B.paint = 'ground';
  }

  // ============================================================== THE HANGAR ==
  // A 32 x 32 m maintenance shed with its doors on the WEST face, which is not
  // an arbitrary choice: with the key at bearing 319 the sun travels toward
  // +X/+Z, so a west aperture is the ONLY one in the level that admits a beam.
  // Everything the `interior` framing does - the wedge of light on the far wall,
  // the roof-monitor shafts, the silhouetted airframe inside - depends on it.
  function buildHangar(L, B, rng, N) {
    var i, j;
    var mx = (HG_X0 + HG_X1) * 0.5, mz = (HG_Z0 + HG_Z1) * 0.5;
    var w = HG_X1 - HG_X0, d = HG_Z1 - HG_Z0;

    // ---- floor ---------------------------------------------------------------
    B.paint = 'ground'; B.tint = tint(0xb0aa9c, 0.35);
    B.add('hg_floor', gridSurface(HG_X0, HG_X1, HG_Z0, HG_Z1, 4.0,
      function () { return HG_FLOOR; }), null);
    L.addCollider(mx, HG_FLOOR - 0.4, mz, w * 0.5, 0.4, d * 0.5, 'concrete', true);
    B.tint = null;

    // ---- shell ---------------------------------------------------------------
    B.paint = 'clad'; B.tint = tint(0xa7aaa6, 0.55);
    // side walls (north and south), with a stepped gable
    var gable = [];
    for (i = 0; i <= 8; i++) {
      var t = i / 8;
      gable.push([HG_X0 + t * w, HG_EAVE + (HG_RIDGE - HG_EAVE) * Math.sin(t * Math.PI)]);
    }
    // The profiled skin, inside and out, on every wall the camera can see. The
    // ribs are what stop a shaded wall being a hole (see corrSheet) and what
    // give the interior framing's two long walls a lit crest and a shaded
    // valley instead of a printed pinstripe.
    // ---- RIB PITCH, AND THE MOIRE IT WAS PRINTING --------------------------
    // 0.152 m was a domestic profile on a 32 m industrial shed, and it aliased.
    // From the hero2 standpoint the far elevation is ~60 m away, which puts a
    // 0.152 m period at 2.5 px head-on and well under one pixel at the grazing
    // incidence that pose actually sees - so the wall came back as a field of
    // concentric moire arcs with a blown specular blob in the middle of it, the
    // single ugliest artifact in the capture set. The same thing was happening
    // on both long walls of the interior framing, where they are seen at 8-10
    // degrees of incidence.
    //
    // 0.32 m is also simply more truthful for a shed this size, and it doubles
    // the projected period everywhere. The depth scales WITH the pitch on
    // purpose: what makes a shaded clad wall readable is that its webs stand
    // steeper than the terminator, and that is an ANGLE (atan(CD / 0.14 CP) =
    // 61 degrees), not a depth. Coarsening the pitch without coarsening the
    // depth would have flattened the webs to 33 degrees and put the lee
    // elevations back in the hole geometry was added to get them out of.
    // Halves the rib count too: ~14k triangles back.
    var CP = 0.32, CD = 0.080;
    function skin(cw, ch, cx, cy, cz, ry) {
      B.add('clad', corrSheet(cw, ch, CP, CD), makeM(cx, cy, cz, 0, ry, 0));
    }
    for (var side = 0; side < 2; side++) {
      var sz = side ? HG_Z1 : HG_Z0;
      B.box('clad', w, HG_EAVE, 0.34, mx, HG_FLOOR + HG_EAVE * 0.5, sz, 0.03);
      skin(w, HG_EAVE - 0.05, mx, HG_FLOOR, sz + (side ? 0.18 : -0.18), side ? 0 : Math.PI);
      skin(w, HG_EAVE - 0.05, mx, HG_FLOOR, sz + (side ? -0.18 : 0.18), side ? Math.PI : 0);
      for (i = 0; i + 1 < gable.length; i++) {
        var gx0 = gable[i][0], gx1 = gable[i + 1][0];
        var gh = (gable[i][1] + gable[i + 1][1]) * 0.5;
        B.box('clad', gx1 - gx0, gh - HG_EAVE, 0.34,
          (gx0 + gx1) * 0.5, HG_FLOOR + (HG_EAVE + gh) * 0.5, sz, 0.02);
      }
      L.addCollider(mx, HG_FLOOR + HG_EAVE * 0.5, sz, w * 0.5, HG_EAVE * 0.5, 0.30, 'metal');
    }
    // ---- THE LEE ELEVATIONS ------------------------------------------------
    // The south and east faces of this shed can NEVER see the sun: the key is
    // at bearing 319, so a ray from any point on them runs straight back into
    // the building, and even an object standing nineteen metres out in front of
    // them is still inside the shadow. They are the deep shade the brief asks
    // for - but a single 32 x 11 m plane of it photographs as a hole, which is
    // what it was doing (0.0037 linear against 0.37 on its own sunlit face).
    //
    // The answer is not more light, it is more SURFACE: a lean-to store with a
    // horizontal roof (an up-facing plane reads at 0.09-0.14 here, thirty times
    // the wall), a pale concrete dado that has three times the cladding's
    // reflectance, and a fascia that puts a lit edge across the elevation.
    // Three value steps instead of one void, from geometry rather than from a
    // light rig that has nothing to give here.
    B.paint = 'ground'; B.tint = tint(0xb0a894, 0.45);
    B.box('conc_wall', w + 0.5, 2.6, 0.42, mx, HG_FLOOR + 1.3, HG_Z1 + 0.20, 0.04);
    B.box('conc_wall', 0.42, 2.6, d + 0.5, HG_X1 + 0.20, HG_FLOOR + 1.3, mz, 0.04);
    B.paint = 'clad'; B.tint = tint(0xa7aaa6, 0.55);
    // the lean-to: a 3.4 m mono-pitch over the south elevation's east half
    var loX0 = mx + 1.0, loW = 14.0, loZ = HG_Z1 + 1.75, loH = 4.4;
    B.boxR('clad', loW, 0.16, 3.6, loX0 + loW * 0.5 - 7.0, HG_FLOOR + loH + 0.16, loZ,
      0.10, 0, 0, 0.03);
    B.paint = 'metal'; B.tint = tint(0x8a8f92, 0.55);
    B.box('steel', loW + 0.4, 0.30, 0.22, loX0 + loW * 0.5 - 7.0, HG_FLOOR + loH + 0.36,
      loZ + 1.75, 0.03);
    for (i = 0; i < 5; i++) {
      var lpx = loX0 - 7.0 + i * (loW / 4);
      B.box('steel', 0.16, loH + 0.2, 0.16, lpx, HG_FLOOR + (loH + 0.2) * 0.5, loZ + 1.62, 0.02);
      B.strut('steel', lpx, HG_FLOOR + loH * 0.62, loZ + 1.62,
        lpx, HG_FLOOR + loH + 0.05, HG_Z1 + 0.35, 0.09, 0.09);
      L.addCollider(lpx, HG_FLOOR + 1.2, loZ + 1.62, 0.14, 1.2, 0.14, 'metal');
    }
    B.paint = 'clad'; B.tint = tint(0x9ba09c, 0.55);
    // stacked stock under it, so the lean-to has a reason to exist
    for (i = 0; i < 3; i++) {
      B.boxR('clad', 2.6, 1.5, 2.2, loX0 - 6.0 + i * 4.4, HG_FLOOR + 0.75, loZ + 0.4,
        0, (i - 1) * 0.05, 0, 0.05);
    }
    B.paint = 'flat'; B.tint = null;
    decalCard(B, 14, mx + 6.0, HG_FLOOR + 6.6, HG_Z1 + 0.45, 6.0, 0.9, 'z', 1, 0);
    B.paint = 'clad'; B.tint = tint(0xa7aaa6, 0.55);

    // east (back) wall
    B.box('clad', 0.34, HG_EAVE, d, HG_X1, HG_FLOOR + HG_EAVE * 0.5, mz, 0.03);
    skin(d, HG_EAVE - 0.05, HG_X1 + 0.18, HG_FLOOR, mz, Math.PI * 0.5);
    skin(d, HG_EAVE - 0.05, HG_X1 - 0.18, HG_FLOOR, mz, -Math.PI * 0.5);
    L.addCollider(HG_X1, HG_FLOOR + HG_EAVE * 0.5, mz, 0.30, HG_EAVE * 0.5, d * 0.5, 'metal');
    // west (door) wall: two piers and a header over the opening
    var pierS = (HG_DOOR_Z0 - HG_Z0), pierN = (HG_Z1 - HG_DOOR_Z1);
    B.box('clad', 0.34, HG_EAVE, pierS, HG_X0, HG_FLOOR + HG_EAVE * 0.5, HG_Z0 + pierS * 0.5, 0.03);
    B.box('clad', 0.34, HG_EAVE, pierN, HG_X0, HG_FLOOR + HG_EAVE * 0.5, HG_Z1 - pierN * 0.5, 0.03);
    B.box('clad', 0.34, HG_EAVE - HG_DOOR_H, HG_DOOR_Z1 - HG_DOOR_Z0, HG_X0,
      HG_FLOOR + (HG_EAVE + HG_DOOR_H) * 0.5, (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5, 0.03);
    L.addCollider(HG_X0, HG_FLOOR + HG_EAVE * 0.5, HG_Z0 + pierS * 0.5, 0.30, HG_EAVE * 0.5, pierS * 0.5, 'metal');
    L.addCollider(HG_X0, HG_FLOOR + HG_EAVE * 0.5, HG_Z1 - pierN * 0.5, 0.30, HG_EAVE * 0.5, pierN * 0.5, 'metal');

    // ---- roof ----------------------------------------------------------------
    for (i = 0; i + 1 < gable.length; i++) {
      var rx0 = gable[i][0], rx1 = gable[i + 1][0];
      var ry0 = gable[i][1], ry1 = gable[i + 1][1];
      var rl = Math.sqrt((rx1 - rx0) * (rx1 - rx0) + (ry1 - ry0) * (ry1 - ry0));
      var rr = Math.atan2(ry1 - ry0, rx1 - rx0);
      B.boxR('clad', rl, 0.22, d, (rx0 + rx1) * 0.5, HG_FLOOR + (ry0 + ry1) * 0.5, mz, 0, 0, rr, 0.02);
    }
    // roof monitors: raised glazed strips along the ridge. THESE are the reason
    // the interior is not a black box - three shafts land on the floor.
    B.paint = 'metal'; B.tint = tint(0x8d918f, 0.5);
    var monZ = [];
    for (i = 0; i < 3; i++) {
      var mz2 = HG_Z0 + 7 + i * 9.5;
      monZ.push(mz2);
      B.box('clad', 6.0, 1.5, 4.0, mx, HG_FLOOR + HG_RIDGE + 0.55, mz2, 0.04);
      B.paint = 'flat'; B.tint = null;
      B.box('glass_lit', 5.6, 0.9, 0.10, mx, HG_FLOOR + HG_RIDGE + 0.55, mz2 - 2.02, 0.01);
      B.box('glass_lit', 5.6, 0.9, 0.10, mx, HG_FLOOR + HG_RIDGE + 0.55, mz2 + 2.02, 0.01);
      B.paint = 'metal'; B.tint = tint(0x8d918f, 0.5);
    }
    L.hangarMonitors = monZ;

    // ---- structure: portal frames, purlins, crane rail ----------------------
    B.paint = 'metal'; B.tint = tint(0x8a8f92, 0.55);
    for (i = 0; i <= 6; i++) {
      var fz = HG_Z0 + 0.9 + i * (d - 1.8) / 6;
      // columns
      B.box('steel', 0.42, HG_EAVE - 0.2, 0.34, HG_X0 + 0.55, HG_FLOOR + (HG_EAVE - 0.2) * 0.5, fz, 0.03);
      B.box('steel', 0.42, HG_EAVE - 0.2, 0.34, HG_X1 - 0.55, HG_FLOOR + (HG_EAVE - 0.2) * 0.5, fz, 0.03);
      // ---- REAL TRUSSES, not noodles ------------------------------------
      // These are three metres from the camera in the level's best frame and
      // they were single 30 cm bars: at that range a rafter with no depth is a
      // white pipe with no shadow side, and the whole roof read as a tangle of
      // wire. A truss is a TOP CHORD, a BOTTOM CHORD 0.62 m below it, and a
      // zig-zag of webs between - three members deep, so the light finds a lit
      // face, a shaded face and a gap on every one of them.
      for (var sd2 = 0; sd2 < 2; sd2++) {
        var ax0 = sd2 ? HG_X1 - 0.55 : HG_X0 + 0.55;
        var ay0 = HG_FLOOR + HG_EAVE - 0.2;
        var bx0 = mx, by0 = HG_FLOOR + HG_RIDGE - 0.3;
        var dep = 0.62;
        // chords
        B.strut('steel', ax0, ay0, fz, bx0, by0, fz, 0.20, 0.15);
        B.strut('steel', ax0, ay0 - dep, fz, bx0, by0 - dep, fz, 0.17, 0.13);
        // webs
        var nw = 7;
        for (var wI = 0; wI < nw; wI++) {
          var t0 = wI / nw, t1 = (wI + 1) / nw;
          var wx0 = M.lerp(ax0, bx0, t0), wy0 = M.lerp(ay0, by0, t0);
          var wx1 = M.lerp(ax0, bx0, t1), wy1 = M.lerp(ay0, by0, t1);
          if (wI & 1) B.strut('steel', wx0, wy0, fz, wx1, wy1 - dep, fz, 0.085, 0.075);
          else B.strut('steel', wx0, wy0 - dep, fz, wx1, wy1, fz, 0.085, 0.075);
          B.strut('steel', wx0, wy0, fz, wx0, wy0 - dep, fz, 0.075, 0.070);
        }
      }
      B.box('steel', 0.20, HG_RIDGE - HG_EAVE, 0.20, mx, HG_FLOOR + (HG_EAVE + HG_RIDGE) * 0.5 - 0.25, fz, 0.02);
      B.strut('steel', HG_X0 + 3.4, HG_FLOOR + HG_EAVE + 0.6, fz, mx - 1.2, HG_FLOOR + HG_EAVE - 0.1, fz, 0.16, 0.14);
      B.strut('steel', HG_X1 - 3.4, HG_FLOOR + HG_EAVE + 0.6, fz, mx + 1.2, HG_FLOOR + HG_EAVE - 0.1, fz, 0.16, 0.14);
      if (i < 6) L.addCollider(HG_X0 + 0.55, HG_FLOOR + 1.2, fz, 0.24, 1.2, 0.20, 'metal');
    }
    // the crane runway beams and a travelling gantry
    B.box('steel', 0.28, 0.60, d - 1.6, HG_X0 + 3.2, HG_FLOOR + HG_EAVE - 1.1, mz, 0.03);
    B.box('steel', 0.28, 0.60, d - 1.6, HG_X1 - 3.2, HG_FLOOR + HG_EAVE - 1.1, mz, 0.03);
    B.tint = tint(0xc8a41e, 0.62);
    var gz = HG_Z0 + 12.0;
    B.box('steel', HG_X1 - HG_X0 - 6.0, 0.75, 0.85, mx, HG_FLOOR + HG_EAVE - 0.45, gz, 0.04);
    B.box('steel', 1.6, 0.9, 1.5, mx + 3.2, HG_FLOOR + HG_EAVE - 1.35, gz, 0.05);
    B.tint = tint(0x8a8f92, 0.55);
    B.cyl('steel', 0.035, 0.035, 4.6, mx + 3.2, HG_FLOOR + HG_EAVE - 4.2, gz, 0, 0, 0, 6);
    B.box('steel', 0.5, 0.55, 0.34, mx + 3.2, HG_FLOOR + HG_EAVE - 6.7, gz, 0.03);

    // ---- the doors ------------------------------------------------------------
    // Four leaves on a bottom rail, two of them rolled back into the pockets.
    // The OPEN half is the light source; the STACKED half is what tells you the
    // opening is a door and not a hole.
    B.paint = 'clad'; B.tint = tint(0x9ba09c, 0.55);
    var doorW = (HG_DOOR_Z1 - HG_DOOR_Z0) * 0.25;
    for (i = 0; i < 2; i++) {
      var lz = HG_DOOR_Z0 - doorW * 0.5 - i * (doorW + 0.12);
      B.box('clad', 0.26, HG_DOOR_H, doorW, HG_X0 - 0.24 - i * 0.30, HG_FLOOR + HG_DOOR_H * 0.5, lz, 0.03);
      for (j = 0; j < 5; j++) {
        B.box('clad', 0.12, 0.22, doorW, HG_X0 - 0.36 - i * 0.30, HG_FLOOR + 0.9 + j * 2.1, lz, 0.02);
      }
      L.addCollider(HG_X0 - 0.30 - i * 0.30, HG_FLOOR + HG_DOOR_H * 0.5, lz, 0.30, HG_DOOR_H * 0.5, doorW * 0.5, 'metal');
    }
    // door rail and the hazard striping on the jamb
    B.paint = 'metal'; B.tint = tint(0x7b7f84, 0.5);
    B.box('steel', 0.34, 0.10, HG_DOOR_Z1 - HG_DOOR_Z0 + 9.0, HG_X0 - 0.30, HG_FLOOR + 0.05,
      (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5 - 4.0, 0.02);
    B.paint = 'flat'; B.tint = null;
    decalCard(B, 14, HG_X0 - 0.42, HG_FLOOR + 1.6, HG_DOOR_Z1 - 0.35, 0.7, 3.0, 'x', -1, Math.PI * 0.5);
    decalCard(B, 13, HG_X0 - 0.42, HG_FLOOR + 6.4, HG_DOOR_Z1 + 2.4, 2.2, 2.2, 'x', -1);

    // ---- what is inside -------------------------------------------------------
    // A stripped fighter on jacks, dead on the axis of the door beam, plus a
    // workshop line down the back wall. The airframe is the subject of the
    // `interior` framing and it is deliberately IN the light wedge.
    B.paint = 'skin';
    B.pushXYZ(HG_X0 + 15.5, HG_FLOOR, HG_Z0 + 21.0, 0, -0.42, 0);
    buildAircraft(B, L, 'fighter', {
      body: tint(0x9aa0a4, 0.35), wrapped: 0, onJacks: true, noWings: true,
      seed: 5.5, scale: 1.0
    }, rng);
    B.pop();
    B.tint = null; B.paint = 'metal';
    L.addCollider(HG_X0 + 15.5, HG_FLOOR + 1.4, HG_Z0 + 21.0, 1.1, 1.2, 7.0, 'metal');

    // ---- its wings, off and on trestles --------------------------------------
    // The trestles stand under the SPAN. The first pass spaced them along z
    // while buildWing lays the panel out along +x, so a 4.6 m wing was carried
    // at one end only and the other 4 m of it hung in the air - visible from
    // the interior framing as a metal horn floating beside the wall.
    B.paint = 'skin'; B.tint = bodyTint(0x9aa0a4, 0.45, 0.86);
    for (i = 0; i < 2; i++) {
      var hwspec = { span: 4.6, rootC: 4.2, tipC: 1.5, sweep: 0.66, dihedral: 0,
        thick: 0.075, rootZ: -2.0, y: 0, sections: 4, twist: 0 };
      B.pushXYZ(HG_X0 + 21.5, HG_FLOOR + 0.98 + i * 0.44, HG_Z0 + 9.5 + i * 0.35, 0, 0, 0.035);
      buildWing(B, hwspec, 'airframe', false);
      wingUnderRibs(B, hwspec, 'skin_dull', false, 1.0);
      B.pop();
    }
    B.tint = tint(0xc8a41e, 0.6); B.paint = 'metal';
    for (i = 0; i < 2; i++) {
      var tx2 = HG_X0 + 21.9 + i * 3.6;
      B.box('steel', 0.24, 0.98, 1.9, tx2, HG_FLOOR + 0.49, HG_Z0 + 10.2, 0.02);
      B.box('steel', 0.55, 0.14, 2.2, tx2, HG_FLOOR + 0.98, HG_Z0 + 10.2, 0.02);
      B.strut('steel', tx2 - 0.5, HG_FLOOR + 0.06, HG_Z0 + 10.2,
        tx2, HG_FLOOR + 0.94, HG_Z0 + 10.2, 0.08, 0.08);
      B.strut('steel', tx2 + 0.5, HG_FLOOR + 0.06, HG_Z0 + 10.2,
        tx2, HG_FLOOR + 0.94, HG_Z0 + 10.2, 0.08, 0.08);
    }
    // workbench run and racking down the back wall
    B.tint = tint(0x6f7478, 0.5);
    for (i = 0; i < 5; i++) {
      var bz2 = HG_Z0 + 3.5 + i * 6.0;
      B.box('steel', 1.1, 0.10, 4.4, HG_X1 - 1.6, HG_FLOOR + 0.92, bz2, 0.02);
      B.box('steel', 0.10, 0.92, 0.10, HG_X1 - 1.15, HG_FLOOR + 0.46, bz2 - 2.0, 0.01);
      B.box('steel', 0.10, 0.92, 0.10, HG_X1 - 1.15, HG_FLOOR + 0.46, bz2 + 2.0, 0.01);
      B.box('steel', 1.2, 2.5, 0.14, HG_X1 - 1.5, HG_FLOOR + 2.2, bz2 - 2.2, 0.02);
      L.addCollider(HG_X1 - 1.6, HG_FLOOR + 0.5, bz2, 0.6, 0.5, 2.2, 'metal');
    }
    B.tint = null; B.paint = 'ground';
    return { monitors: monZ };
  }

  // ============================================================ THE PARTS YARD
  // Wings on racks, engines in cradles, fins in a stillage. A boneyard is a
  // PARTS DEPOT with aeroplanes attached, and this is the half of the story the
  // rows cannot tell.
  function buildPartsYard(L, B, rng, N) {
    var i, j, k;
    var out = { wingRacks: [], engineCradles: [], finRack: null, hulkCradles: [] };

    // ---- wing racks -----------------------------------------------------------
    var racks = [[27.0, 34.0, 0.10], [27.0, 46.0, -0.06], [27.0, 58.0, 0.04]];
    for (i = 0; i < racks.length; i++) {
      var rx = racks[i][0], rz = racks[i][1], ry = racks[i][2];
      var gy0 = groundY(rx, rz, N);
      out.wingRacks.push({ position: new THREE.Vector3(rx, gy0, rz), yaw: ry, levels: 4 });
      B.pushXYZ(rx, gy0, rz, 0, ry, 0);
      // -----------------------------------------------------------------------
      // bodyTint, not tint, and the value is the point. tint() normalises, so
      // tint(0x7d8188, 0.55) is a near-WHITE multiplier - the rack ran at the
      // full `steel` albedo, i.e. brand-new galvanising, and in hero2 the three
      // racks were the brightest objects in the frame. A blue-white lattice
      // eight metres from the lens with pale panels behind it reads as a
      // jungle gym, which is what the critique of that frame said. Forty summers
      // of Sonoran sun on rack steel is a fifth of a stop down and slightly
      // warmer, and taking it there is also what lets the WINGS on the rack
      // become the subject instead of the frame holding them.
      B.paint = 'metal'; B.tint = bodyTint(0x7d8188, 0.55, 0.80);
      for (j = 0; j < 2; j++) {
        var fz = j ? 3.2 : -3.2;
        B.box('steel', 0.16, 2.9, 0.16, -4.2, 1.45, fz, 0.02);
        B.box('steel', 0.16, 2.9, 0.16, 4.2, 1.45, fz, 0.02);
        B.box('steel', 8.7, 0.16, 0.16, 0, 2.85, fz, 0.02);
        B.strut('steel', -4.2, 0.1, fz, 4.2, 2.85, fz, 0.10, 0.10);
      }
      // FOUR shelves at 0.62 m, not three at 1.05. A 2.9 m rack holding three
      // panels 0.29 m thick on a metre pitch is two thirds AIR: the capture came
      // back with a lattice you could see the sky through and three thin plates
      // in it, so a rack read as scaffolding rather than as stored inventory.
      // The pitch a real wing rack is loaded at is the panel thickness plus a
      // hand, which is what 0.62 is, and eight panels per rack turns the thing
      // into the solid warm-metal MASS the framing wants in its lower right.
      var WLEV = 4, WPITCH = 0.62;
      for (j = 0; j < WLEV; j++) {
        B.box('steel', 8.7, 0.14, 0.30, 0, 0.55 + j * WPITCH, 0, 0.02);
      }
      // the wings themselves, stacked flat with a little skew
      // Value, not just hue. Stacked flat, a wing shows the camera its
      // UNDERSIDE, which sees no sun at all - at the first pass's tint (a
      // normalised near-white multiplier with no value in it) the whole stack
      // printed as one black slab and the racks read as empty frames, so it was
      // pushed to 1.28, i.e. a quarter of a stop ABOVE the map. That was
      // treating a lighting problem as a paint problem and it cost the panels
      // their form: 1.28 with no light on it is a flat pale card. The upward
      // slab-bounce card (see BOUNCE_UP_I) now lights every one of these
      // undersides for real, so the multiplier comes back to 1.02 and the panels
      // read as aluminium with a lit lower skin and a shaded rib line under it.
      B.paint = 'skin';
      for (j = 0; j < WLEV; j++) {
        B.tint = bodyTint(j % 2 ? 0xa8aca8 : 0xc2c6c8, 0.35, 1.02 - j * 0.045);
        for (k = 0; k < 2; k++) {
          var wz = k ? 1.7 : -1.7;
          var pspec = { span: 4.3, rootC: 3.9, tipC: 1.4, sweep: 0.62, dihedral: 0,
            thick: 0.075, rootZ: -1.9, y: 0, sections: 4, twist: 0 };
          B.pushXYZ(k ? -0.4 : 0.4, 0.62 + j * 1.05, wz, 0, (k ? 1 : -1) * (0.02 + j * 0.015), 0);
          buildWing(B, pspec, 'airframe', k === 1);
          // The underside is what the camera sees from twelve metres away on a
          // 0.6 m shelf, and a flat lower skin at that angle is the black sheet
          // the review measured. Ribs and a spar give it something to read.
          wingUnderRibs(B, pspec, 'skin_dull', k === 1, 1.0);
          B.pop();
        }
      }
      B.pop();
      L.addCollider(rx, gy0 + 1.5, rz, 4.6, 1.5, 3.6, 'metal');
    }

    // ---- engine cradles -------------------------------------------------------
    var pods = [[35.5, 31.0, 0.22], [35.5, 35.4, -0.10], [35.5, 39.8, 0.06],
                [39.6, 33.0, 0.30], [39.6, 37.4, -0.18], [35.5, 44.2, 0.14],
                [39.6, 41.8, 0.08], [39.6, 46.2, -0.05]];
    for (i = 0; i < pods.length; i++) {
      var px = pods[i][0], pz = pods[i][1], pyaw = pods[i][2];
      var pgy = groundY(px, pz, N);
      out.engineCradles.push({ position: new THREE.Vector3(px, pgy, pz), yaw: pyaw });
      B.pushXYZ(px, pgy, pz, 0, pyaw, 0);
      B.paint = 'rust'; B.tint = tint(0x7a5a3c, 0.65);
      B.box('rusted', 1.9, 0.20, 3.4, 0, 0.11, 0, 0.02);
      for (j = 0; j < 4; j++) {
        B.box('rusted', 0.16, 0.62, 0.16, (j & 1 ? 0.8 : -0.8), 0.42, (j & 2 ? 1.4 : -1.4), 0.02);
      }
      B.box('rusted', 1.5, 0.14, 0.36, 0, 0.76, -1.1, 0.02);
      B.box('rusted', 1.5, 0.14, 0.36, 0, 0.76, 1.1, 0.02);
      B.paint = 'skin'; B.tint = tint(0xa9adb0, 0.32);
      buildNacelle(B, 0, 1.30, 0, 3.3, 0.72, 'airframe');
      if (i % 3 === 0) {
        B.paint = 'wrap';
        buildWrapDisc(B, 0, 1.30, -1.72, 0.80, -0.28, i * 1.7);
      }
      B.pop();
      L.addCollider(px, pgy + 0.9, pz, 1.1, 0.9, 1.9, 'metal');
    }

    // ---- fin stillage ---------------------------------------------------------
    var fx = 31.0, fz2 = 62.0;
    var fgy = groundY(fx, fz2, N);
    out.finRack = { position: new THREE.Vector3(fx, fgy, fz2), yaw: 0.08, count: 6 };
    B.pushXYZ(fx, fgy, fz2, 0, 0.08, 0);
    // weathered, for the same reason as the wing racks
    B.paint = 'metal'; B.tint = bodyTint(0x7d8188, 0.55, 0.80);
    B.box('steel', 9.0, 0.22, 2.2, 0, 0.12, 0, 0.02);
    B.box('steel', 9.0, 0.14, 0.14, 0, 1.5, -0.85, 0.02);
    B.box('steel', 9.0, 0.14, 0.14, 0, 1.5, 0.85, 0.02);
    B.box('steel', 0.16, 1.6, 0.16, -4.4, 0.8, 0, 0.02);
    B.box('steel', 0.16, 1.6, 0.16, 4.4, 0.8, 0, 0.02);
    B.paint = 'skin';
    for (i = 0; i < 6; i++) {
      B.tint = bodyTint(i % 2 ? 0xaeb2b3 : 0x9ea29f, 0.35, 0.78 + (i % 3) * 0.14);
      B.pushXYZ(-3.6 + i * 1.44, 0.24, (i % 2 ? 0.10 : -0.10), 0, Math.PI * 0.5 + (i - 2.5) * 0.03, 0);
      buildFin(B, { span: 2.9, rootC: 3.2, tipC: 1.4, sweep: 0.70, dihedral: 0,
        thick: 0.10, rootZ: -1.6, y: 0, sections: 4, twist: 0 }, 'airframe');
      B.pop();
    }
    B.pop();
    L.addCollider(fx, fgy + 1.6, fz2, 4.6, 1.6, 1.2, 'metal');

    B.tint = null; B.paint = 'ground';
    return out;
  }

  // ============================================================ WATER TOWER ==
  // The only thing in the level taller than an aircraft fin, and the only
  // vertical the eye can measure 200 m of flat slab against. The overview eye
  // stands on its catwalk.
  function buildWaterTower(L, B, rng, N) {
    var gy = groundY(WT_X, WT_Z, N);
    var legR = 5.2, tankY = WT_H, i, j;
    B.pushXYZ(WT_X, gy, WT_Z, 0, 0.18, 0);
    B.paint = 'metal'; B.tint = tint(0x8d9298, 0.55);
    // four battered lattice legs
    var legs = [];
    for (i = 0; i < 4; i++) {
      var a = i * Math.PI * 0.5 + Math.PI * 0.25;
      legs.push([Math.cos(a) * legR, Math.sin(a) * legR, Math.cos(a) * legR * 0.42, Math.sin(a) * legR * 0.42]);
    }
    for (i = 0; i < 4; i++) {
      var lg = legs[i], lg2 = legs[(i + 1) % 4];
      B.strut('steel', lg[0], 0, lg[1], lg[2], tankY - 2.4, lg[3], 0.30, 0.30);
      // horizontal rings and the X-bracing between them: this is the whole
      // silhouette of a water tower and a smooth cone is not it
      for (j = 1; j <= 4; j++) {
        var t0 = (j - 1) / 4, t1 = j / 4;
        var y0 = t0 * (tankY - 2.4), y1 = t1 * (tankY - 2.4);
        var ax = M.lerp(lg[0], lg[2], t0), az = M.lerp(lg[1], lg[3], t0);
        var bx = M.lerp(lg2[0], lg2[2], t0), bz = M.lerp(lg2[1], lg2[3], t0);
        var cx = M.lerp(lg[0], lg[2], t1), cz = M.lerp(lg[1], lg[3], t1);
        var dx2 = M.lerp(lg2[0], lg2[2], t1), dz2 = M.lerp(lg2[1], lg2[3], t1);
        B.strut('steel', ax, y0, az, bx, y0, bz, 0.14, 0.14);
        B.strut('steel', ax, y0, az, dx2, y1, dz2, 0.10, 0.10);
        B.strut('steel', bx, y0, bz, cx, y1, cz, 0.10, 0.10);
      }
      L.addCollider(lg[0] * 0.75 + WT_X, gy + 6, lg[1] * 0.75 + WT_Z, 0.45, 6, 0.45, 'metal');
    }
    // the tank: a cylinder with a domed top and a conical bottom
    B.tint = tint(0xb8b2a4, 0.42);
    var rings = [], nr = 8;
    for (i = 0; i <= nr; i++) {
      var t = i / nr;
      var y, r;
      if (t < 0.22) { y = tankY - 2.4 + t / 0.22 * 2.4; r = WT_R * (0.30 + 0.70 * (t / 0.22)); }
      else if (t < 0.76) { y = tankY + (t - 0.22) / 0.54 * 5.2; r = WT_R; }
      else { y = tankY + 5.2 + (t - 0.76) / 0.24 * 2.0; r = WT_R * Math.cos((t - 0.76) / 0.24 * 1.15); }
      var ring = [];
      for (j = 0; j < 14; j++) {
        var aa = (j / 14) * Math.PI * 2;
        ring.push([Math.sin(aa) * r, y, Math.cos(aa) * r]);
      }
      rings.push(ring);
    }
    B.add('steel', ringLoft(rings, true), null);
    B.add('steel', ringCap(rings[rings.length - 1], false), null);
    // the catwalk the overview stands on
    B.tint = tint(0x7d8188, 0.5);
    var cwY = tankY - 0.5, cwR = WT_R + 1.05;
    // The overview eye stands ON this catwalk, so its rail is the frame's
    // foreground and its section is a composition decision, not a detail. The
    // first pass used 1.05 x 0.10 deck planks and 60 mm rails; from 1 m away
    // that printed as a black lattice cage across the bottom third of the
    // establishing shot. 40 mm rails and a 0.85 m deck read as a handrail -
    // present, in focus, framing the yard, not caging it.
    for (i = 0; i < 26; i++) {
      var ca = (i / 26) * Math.PI * 2, ca2 = ((i + 1) / 26) * Math.PI * 2;
      B.strut('steel', Math.sin(ca) * cwR, cwY, Math.cos(ca) * cwR,
        Math.sin(ca2) * cwR, cwY, Math.cos(ca2) * cwR, 0.85, 0.055);
      B.strut('steel', Math.sin(ca) * cwR, cwY + 1.02, Math.cos(ca) * cwR,
        Math.sin(ca2) * cwR, cwY + 1.02, Math.cos(ca2) * cwR, 0.040, 0.040);
      B.strut('steel', Math.sin(ca) * cwR, cwY + 0.52, Math.cos(ca) * cwR,
        Math.sin(ca2) * cwR, cwY + 0.52, Math.cos(ca2) * cwR, 0.032, 0.032);
      if ((i % 3) === 0) {
        B.box('steel', 0.055, 1.02, 0.055, Math.sin(ca) * cwR, cwY + 0.51, Math.cos(ca) * cwR, 0.01);
      }
    }
    // the ladder cage up one leg
    for (i = 0; i < 26; i++) {
      B.box('steel', 0.60, 0.05, 0.05, legR * 0.66, 0.6 + i * 0.78, legR * 0.66 + 0.5, 0.01);
    }
    B.box('steel', 0.06, tankY, 0.06, legR * 0.66 - 0.30, tankY * 0.5, legR * 0.66 + 0.5, 0.01);
    B.box('steel', 0.06, tankY, 0.06, legR * 0.66 + 0.30, tankY * 0.5, legR * 0.66 + 0.5, 0.01);
    // the obstruction beacon on the crown - one warm mark at the top of the
    // frame in a level that is otherwise all sky up there
    B.paint = 'flat'; B.tint = null;
    B.cyl('glass_lit', 0.22, 0.26, 0.34, 0, tankY + 7.4, 0, 0, 0, 0, 8);
    B.pop();
    B.paint = 'ground'; B.tint = null;
    return { gy: gy, tankY: tankY, catwalkY: gy + tankY - 0.5, r: WT_R };
  }

  // ---- ops shack + the fuel bowser bund --------------------------------------
  function buildOpsShack(L, B, rng, N) {
    var gy = groundY(OPS_X, OPS_Z, N);
    var w = 9.5, d = 5.4, h = 3.2;
    B.pushXYZ(OPS_X, gy, OPS_Z, 0, -0.06, 0);
    B.paint = 'clad'; B.tint = tint(0xb3ab98, 0.5);
    B.box('clad', w, h, 0.24, 0, h * 0.5, -d * 0.5, 0.03);
    B.box('clad', w, h, 0.24, 0, h * 0.5, d * 0.5, 0.03);
    B.box('clad', 0.24, h, d, -w * 0.5, h * 0.5, 0, 0.03);
    B.box('clad', 0.24, h, d, w * 0.5, h * 0.5, 0, 0.03);
    B.box('clad', w + 0.9, 0.22, d + 0.9, 0, h + 0.1, 0, 0.03);
    // a shallow parapet, an evaporative cooler and a conduit run: the three
    // things that stop a flat-roofed box being a box
    B.paint = 'metal'; B.tint = tint(0x9aa0a2, 0.5);
    B.box('steel', w + 0.9, 0.34, 0.14, 0, h + 0.36, -(d + 0.9) * 0.5, 0.02);
    B.box('steel', w + 0.9, 0.34, 0.14, 0, h + 0.36, (d + 0.9) * 0.5, 0.02);
    B.box('steel', 0.14, 0.34, d + 0.9, -(w + 0.9) * 0.5, h + 0.36, 0, 0.02);
    B.box('steel', 0.14, 0.34, d + 0.9, (w + 0.9) * 0.5, h + 0.36, 0, 0.02);
    B.box('clad', 1.5, 1.35, 1.5, 1.8, h + 0.85, 0.6, 0.04);
    B.cyl('steel', 0.09, 0.09, 1.7, -2.6, h + 1.0, -0.5, 0, 0, 0, 6);
    B.box('steel', 0.10, 2.2, 0.10, -w * 0.5 - 0.2, h * 0.4, 1.4, 0.01);
    // door and two windows, recessed
    B.paint = 'flat'; B.tint = null; B.dark = 0.7;
    B.box('steel', 1.05, 2.15, 0.10, -1.8, 1.08, -d * 0.5 - 0.10, 0.02);
    B.dark = 0.55;
    B.box('canopy', 1.5, 0.95, 0.06, 1.4, 1.85, -d * 0.5 - 0.11, 0.01);
    B.box('canopy', 1.5, 0.95, 0.06, 3.6, 1.85, -d * 0.5 - 0.11, 0.01);
    B.dark = 0;
    // a sun shade over the door: the only cast shade at human scale on this side
    B.paint = 'metal'; B.tint = tint(0x8e9490, 0.5);
    B.boxR('clad', 3.4, 0.10, 2.0, -1.4, 2.72, -d * 0.5 - 1.0, -0.12, 0, 0, 0.02);
    B.strut('steel', -3.0, 2.55, -d * 0.5 - 1.9, -2.9, h - 0.1, -d * 0.5 - 0.1, 0.08, 0.08);
    B.strut('steel', 0.2, 2.55, -d * 0.5 - 1.9, 0.1, h - 0.1, -d * 0.5 - 0.1, 0.08, 0.08);
    B.pop();
    L.addCollider(OPS_X, gy + h * 0.5, OPS_Z, w * 0.5, h * 0.5, d * 0.5, 'concrete');
    B.paint = 'ground'; B.tint = null;
    return { gy: gy, w: w, d: d, h: h };
  }

  // ---- perimeter fence -------------------------------------------------------
  function fenceRun(L, B, x0, z0, x1, z1, N, gateHalf) {
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.5) return;
    var ux = dx / len, uz = dz / len;
    var yaw = Math.atan2(dx, dz);
    var H = 2.9;
    var n = Math.max(1, Math.round(len / 3.0));
    var step = len / n;
    B.paint = 'metal'; B.tint = tint(0x8d9298, 0.5);
    for (var i = 0; i <= n; i++) {
      var t = i * step;
      var px = x0 + ux * t, pz = z0 + uz * t;
      if (gateHalf && Math.abs(px) < gateHalf && Math.abs(uz) < 0.01) continue;
      var gy = groundY(px, pz, N);
      B.cyl('steel', 0.055, 0.062, H, px, gy + H * 0.5, pz, 0, 0, 0, 6);
      B.strut('steel', px, gy + H - 0.05, pz,
        px - uz * 0.34, gy + H + 0.42, pz + ux * 0.34, 0.045, 0.045);
    }
    // ---- rails ---------------------------------------------------------------
    // boxR, not box. A box() is axis-aligned, so the top and bottom rails of the
    // 240 m north and south runs were built as 240 m bars lying along +Z through
    // the middle of the yard - five black wires crossing the sky in the hero
    // framing, visible in every capture and coming from a fence 110 m away.
    // Same for the barbed strands below.
    var my = groundY((x0 + x1) * 0.5, (z0 + z1) * 0.5, N);
    B.boxR('steel', 0.05, 0.05, len, (x0 + x1) * 0.5, my + H - 0.06, (z0 + z1) * 0.5, 0, yaw, 0, 0.01);
    B.boxR('steel', 0.05, 0.05, len, (x0 + x1) * 0.5, my + 0.10, (z0 + z1) * 0.5, 0, yaw, 0, 0.01);
    // the mesh, as one alpha-tested sheet per run
    B.paint = 'clad'; B.tint = null;
    var reps = len / 2.4;
    var g = quad(len, H - 0.14, 0, 0, reps, (H - 0.14) / 2.4);
    B.add('chain', g, makeM((x0 + x1) * 0.5, my + H * 0.5, (z0 + z1) * 0.5, 0, yaw + Math.PI * 0.5, 0));
    // three strands of barbed wire on the outrigger
    B.paint = 'metal'; B.tint = tint(0x8d9298, 0.5);
    for (var b = 0; b < 3; b++) {
      B.boxR('steel', 0.02, 0.02, len, (x0 + x1) * 0.5 - uz * (0.10 + b * 0.12),
        my + H + 0.14 + b * 0.14, (z0 + z1) * 0.5 + ux * (0.10 + b * 0.12), 0, yaw, 0, 0.005);
    }
    L.addCollider((x0 + x1) * 0.5, my + H * 0.5, (z0 + z1) * 0.5,
      Math.abs(ux) * len * 0.5 + 0.10, H * 0.5, Math.abs(uz) * len * 0.5 + 0.10, 'metal');
    B.paint = 'ground'; B.tint = null;
  }

  function buildFence(L, B, rng, N) {
    var gh = 6.0;
    fenceRun(L, B, FENCE_X0, FENCE_Z1, -gh, FENCE_Z1, N, 0);
    fenceRun(L, B, gh, FENCE_Z1, FENCE_X1, FENCE_Z1, N, 0);
    fenceRun(L, B, FENCE_X0, FENCE_Z0, FENCE_X1, FENCE_Z0, N, 0);
    fenceRun(L, B, FENCE_X0, FENCE_Z0, FENCE_X0, FENCE_Z1, N, 0);
    fenceRun(L, B, FENCE_X1, FENCE_Z0, FENCE_X1, FENCE_Z1, N, 0);
    // the gate itself: two leaves swung open, which is how the player got in
    B.paint = 'metal'; B.tint = tint(0x8d9298, 0.5);
    for (var i = 0; i < 2; i++) {
      var sg = i ? 1 : -1;
      var gyy = groundY(sg * gh, FENCE_Z1, N);
      B.pushXYZ(sg * gh, gyy, FENCE_Z1, 0, sg * 0.9, 0);
      B.cyl('steel', 0.075, 0.085, 3.1, 0, 1.55, 0, 0, 0, 0, 6);
      B.box('steel', 0.06, 0.06, 5.6, 0, 2.75, sg * 2.8, 0.01);
      B.box('steel', 0.06, 0.06, 5.6, 0, 0.20, sg * 2.8, 0.01);
      B.box('steel', 0.05, 0.05, 5.4, 0, 1.48, sg * 2.8, 0.01);
      B.box('steel', 0.06, 2.55, 0.06, 0, 1.48, sg * 5.55, 0.01);
      B.paint = 'clad'; B.tint = null;
      B.add('chain', quad(5.6, 2.5, 0, 0, 2.3, 1.04),
        makeM(0, 1.48, sg * 2.8, 0, Math.PI * 0.5, 0));
      B.paint = 'metal'; B.tint = tint(0x8d9298, 0.5);
      B.pop();
    }
    B.paint = 'ground'; B.tint = null;
  }

  // ---- the hulk row: severed fuselage sections on timber ---------------------
  function buildHulkRow(L, B, rng, N) {
    var out = [];
    var spots = [[30, -84, 0.16], [30, -70, -0.09], [30, -56, 0.05], [30, -42, 0.12],
                 [44, -78, -0.20], [44, -60, 0.08]];
    for (var i = 0; i < spots.length; i++) {
      var x = spots[i][0], z = spots[i][1], yaw = spots[i][2] + Math.PI;
      var gy = groundY(x, z, N);
      B.pushXYZ(x, gy, z, 0, yaw, 0);
      buildAircraft(B, L, 'hulk', {
        body: bodyTint(i % 2 ? 0xa8a49a : 0xb2b4b2, 0.40, 0.60 + (i % 3) * 0.11),
        wrapped: 0, seed: 3 + i, scale: 0.86 + (i % 3) * 0.10
      }, rng);
      B.pop();
      B.tint = null;
      var hl = 21.0 * (0.86 + (i % 3) * 0.10) * 0.5;
      L.addCollider(x, gy + 2.3, z, 1.9, 1.9, hl, 'metal');
      out.push({ centre: new THREE.Vector3(x, gy, z), yaw: yaw, len: hl * 2 });
    }
    B.paint = 'ground';
    return out;
  }

  // ---- maintenance stands, the one piece of yellow in a bleached yard --------
  function buildStand(B, x, y, z, yaw, h, w) {
    B.pushXYZ(x, y, z, 0, yaw, 0);
    B.paint = 'metal'; B.tint = tint(0xc9a726, 0.68);
    var i;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? w * 0.5 : -w * 0.5, sz = (i & 2) ? 0.85 : -0.85;
      B.box('steel', 0.09, h, 0.09, sx, h * 0.5, sz, 0.01);
      B.cyl('steel', 0.10, 0.10, 0.08, sx, 0.04, sz, 0, 0, Math.PI * 0.5, 8);
    }
    B.box('steel', w + 0.2, 0.09, 1.9, 0, h, 0, 0.02);
    for (i = 0; i < 3; i++) {
      B.box('steel', w + 0.2, 0.05, 0.05, 0, h + 0.4 + i * 0.45, -0.95, 0.01);
      B.box('steel', w + 0.2, 0.05, 0.05, 0, h + 0.4 + i * 0.45, 0.95, 0.01);
    }
    B.box('steel', 0.05, 1.05, 0.05, w * 0.5, h + 0.5, -0.95, 0.01);
    B.box('steel', 0.05, 1.05, 0.05, -w * 0.5, h + 0.5, 0.95, 0.01);
    // the stair
    for (i = 0; i < 6; i++) {
      B.boxR('steel', w * 0.5, 0.05, 0.28, -w * 0.5 - 0.5, 0.18 + i * (h - 0.2) / 6, 1.35, 0, 0, 0, 0.01);
    }
    B.strut('steel', -w * 0.5 - 0.9, 0.05, 1.35, -w * 0.5 - 0.1, h, 1.35, 0.06, 0.06);
    B.pop();
    B.tint = null; B.paint = 'ground';
  }

  // ============================================================ THE AIRCRAFT ==
  // The parked inventory, as data. Every entry is (type, x, z, yaw, options);
  // the yaws carry a deliberate jitter because a row of aircraft on EXACTLY the
  // same heading is the "perfectly straight, perfectly uniform anything" the
  // quality bar rejects on sight - and because a real tug driver never gets it
  // right twice.
  var BODY = {
    bare:    0xb8bbbd,   // polished alclad, chalked
    grey:    0x8f9498,   // faded tactical grey
    green:   0x6f7565,   // old tactical camouflage, sun-killed
    tan:     0xa79a80,   // desert scheme
    white:   0xcfcec6,   // white crown
    blue:    0x5e7488    // a faded blue cheatline
  };

  function planAircraft(rng) {
    var out = [], i, j;
    var fam = ['fighter', 'fighter', 'fighter', 'trainer', 'fighter', 'heli'];
    var bodies = [BODY.bare, BODY.grey, BODY.tan, BODY.bare, BODY.green, BODY.grey];
    for (i = 0; i < ROWS_X.length; i++) {
      for (j = 0; j < ROW_BAYS.length; j++) {
        var k = (i * 7 + j * 3) % fam.length;
        var type = fam[k];
        // one row of trainers rather than a scatter: a yard is organised by
        // TYPE, and a run of six identical airframes with one odd one in it
        // reads as an inventory instead of as a random assortment
        if (i === 2) type = (j === 4) ? 'heli' : 'trainer';
        if (i === 3 && j > 3) type = 'hulk';
        out.push({
          type: type,
          x: ROWS_X[i] + rng.range(-0.55, 0.55),
          z: ROW_BAYS[j] + rng.range(-0.9, 0.9),
          yaw: Math.PI + rng.range(-0.075, 0.075),
          body: bodies[(k + i) % bodies.length],
          crown: (k % 3 === 0) ? BODY.white : null,
          // 0.50 .. 1.0, widened from 0.62. With the far-field mirage no longer
          // painting the yard flat (see heatShimmer) the value spread these
          // multipliers carry is finally VISIBLE, and 0.62-1.0 is only two
          // thirds of a stop across the whole inventory - enough to separate two
          // neighbours at 20 m and not enough to sort thirty-four airframes into
          // depth layers at 120 m. Half of them are repainted tactical grey and
          // green over forty years of sun, which is genuinely a stop under bare
          // alclad. The range is widened at the DARK end only, so the bare-metal
          // airframes that anchor the highlight (Sierra Seven at val 0.88) do
          // not move at all. Same number of rng draws, so the plan - types,
          // positions, yaws - is bit-identical.
          val: rng.range(0.50, 1.0),
          wrapped: rng.next() < 0.62 ? rng.range(0.4, 1.0) : rng.range(0.05, 0.2),
          onJacks: rng.next() < 0.28,
          noWings: (i === 3 && j > 3) ? true : rng.next() < 0.10,
          scale: rng.range(0.94, 1.07),
          seed: rng.range(0, 12),
          soot: rng.range(0.2, 1.0),
          row: i, bay: j
        });
      }
    }
    return out;
  }

  // The big airframes. Named, because each one is a landmark that a camera pose
  // and an anchor both depend on.
  var BIG = [
    // Sierra Seven is the brightest airframe in the yard on purpose: it is the
    // subject of hero1 and hero3 and its sunlit flank is the frame's highlight
    // anchor. Everything else steps down from it.
    { name: 'sierra7', type: 'transport4', x: S7_X, z: S7_Z, yaw: S7_YAW,
      body: BODY.bare, crown: BODY.white, wrapped: 0.7, onJacks: false, scale: 1.0, val: 0.88 },
    { name: 'kilo4', type: 'transport2', x: 60.0, z: -46.0, yaw: Math.PI + 0.07,
      body: BODY.grey, crown: null, wrapped: 0.5, onJacks: true, scale: 1.0, val: 0.66 },
    { name: 'november2', type: 'transport4', x: 62.0, z: -4.0, yaw: Math.PI - 0.05,
      body: BODY.tan, crown: BODY.white, wrapped: 0.9, onJacks: false, scale: 0.92, val: 0.80 },
    { name: 'delta9', type: 'transport2', x: 58.0, z: 22.0, yaw: Math.PI + 0.11,
      body: BODY.bare, crown: BODY.blue, wrapped: 0.3, onJacks: false, scale: 0.96, val: 0.90 },
    { name: 'echo3', type: 'transport2', x: -66.0, z: 58.0, yaw: Math.PI - 0.34,
      body: BODY.green, crown: null, wrapped: 0.8, onJacks: true, scale: 1.0, val: 0.58 }
  ];

  // =============================================================== THE LEVEL ==
  function LevelBoneyard(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_boneyard';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    // Volumetric hints: the hangar roof monitors and the door wedge. lighting.js
    // solves each against real geometry and builds the cone itself.
    this.lightShafts = [];
    // Every light source this yard implies. At noon almost all of them are shut
    // (dayBase 0), which is correct and is why they each carry one - a level
    // that publishes nothing has no dusk and no interior.
    this.practicalLights = [];
    // Where the deep shade is. Published because it is the single most useful
    // thing to know in this level: props, AI cover selection and any framing
    // that wants contrast all want the same twelve rectangles.
    this.shadeZones = [];
    this.heatShimmer = null;
    this.aircraft = [];
    this.bigAircraft = [];
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(6.0);
    this._stamp = 0;
    this._blockers = [];
    this._atlasOk = false;
    this._t = 0;
    this._movers = [];
    this._sunChecked = false;
    this._arcSet = false;
    this._fogSet = false;
    this._shadowSet = false;
    this._crackOk = false;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x424f4e45) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x424f4e);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(FENCE_X0 - 8, -6, FENCE_Z0 - 8),
      new THREE.Vector3(FENCE_X1 + 8, 40, FENCE_Z1 + 8));
    this.anchors = buildAnchors(this.noise, this.rng.fork ? this.rng.fork(7) : this.rng);
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose and nothing in here is a remembered number.
  // ---------------------------------------------------------------------------
  function shadeOffset(h) {
    // Where the shadow of something `h` metres tall lands, as a world offset.
    var run = h / Math.tan(SUN_EL);
    var hx = Math.sin(SUN_AZ), hz = -Math.cos(SUN_AZ);
    // shadows travel AWAY from the sun
    return { x: -hx * run, z: -hz * run, run: run };
  }

  function buildAnchors(N, rng) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    function gy(x, z) { return groundY(x, z, N); }
    var A = {}, i, j;

    A.yard = {
      x0: PAD_X0, x1: PAD_X1, z0: PAD_Z0, z1: PAD_Z1,
      taxiHalf: TAXI_HALF,
      sunAzimuth: SUN_AZ, sunElevation: SUN_EL,
      sunBearing: (Math.atan2(Math.sin(SUN_AZ), Math.cos(SUN_AZ)) * 180 / Math.PI + 360) % 360,
      groundY: function (x, z) { return groundY(x, z, N); },
      shadeOffset: shadeOffset
    };

    A.taxiway = {
      x: 0, z0: TAXI_Z0, z1: TAXI_Z1, half: TAXI_HALF,
      spawnEnd: V(0, gy(0, TAXI_Z1 - 6), TAXI_Z1 - 6),
      farEnd: V(0, gy(0, TAXI_Z0 + 6), TAXI_Z0 + 6),
      yaw: 0
    };

    var s7wing = TYPES.transport4.wing;
    var s7Off = shadeOffset(s7wing.y);
    A.sierra7 = {
      name: 'sierra7', type: 'transport4',
      centre: V(S7_X, gy(S7_X, S7_Z), S7_Z), yaw: S7_YAW,
      len: S7_LEN, span: S7_SPAN,
      noseZ: S7_Z + S7_LEN * 0.5, tailZ: S7_Z - S7_LEN * 0.5,
      wingY: s7wing.y, wingZ: S7_Z - s7wing.rootZ - s7wing.rootC * 0.4,
      wingTipPort: V(S7_X - S7_SPAN * 0.5, s7wing.y - 1.0, S7_Z - 1.0),
      wingTipStbd: V(S7_X + S7_SPAN * 0.5, s7wing.y - 1.0, S7_Z - 1.0),
      tailY: TYPES.transport4.wing.y + TYPES.transport4.finH,
      // yaw is PI, so a local (xl, zl) lands at world (S7_X - xl, S7_Z - zl),
      // and the nacelle z comes off the same swept-LE formula the geometry uses.
      nacelles: (function () {
        var out = [], eg = TYPES.transport4.engines, k, sgn;
        for (k = 0; k < eg.length; k++) {
          var zl = s7wing.rootZ + eg[k].x * Math.tan(s7wing.sweep) - eg[k].fwd;
          for (sgn = -1; sgn <= 1; sgn += 2) {
            out.push(V(S7_X - sgn * eg[k].x, s7wing.y - eg[k].drop, S7_Z - zl));
          }
        }
        return out;
      })(),
      gear: [
        V(S7_X - 2.35, 0, S7_Z - 3.6), V(S7_X + 2.35, 0, S7_Z - 3.6),
        V(S7_X, 0, S7_Z + 15.0)
      ],
      // =====================================================================
      // THE WING'S OWN SHADE - and the trap that a bounding box IS one.
      //
      // The first version published this as a rectangle: the wing's full span
      // by its full chordwise extent, pushed along shadeOffset. That rectangle
      // is correct as a BOUND and useless as a place to stand, because the wing
      // is swept 24 degrees. Near the tip the chord is 2.6 m and it sits 9.5 m
      // further aft than the root, so the real shadow is a diagonal ribbon
      // running from about (0, -6) to (22, +1) - and the corner of the bounding
      // box that hero1 was placed in is 8 m outside it. The capture came back
      // with the camera standing in full sun, which is the exact failure the
      // whole level is built to avoid.
      //
      // So the shade publishes a FUNCTION. shade.at(worldX) solves the real
      // chordwise extent at that station and pushes it along the offset; the
      // bounding rectangle stays alongside it for anyone who only wants a broad
      // test. Everything is derived from the wing recipe, so changing the sweep
      // moves the ribbon, the camera and any prop placed against it together.
      // =====================================================================
      shade: (function () {
        var semi = S7_SPAN * 0.5 - TYPES.transport4.r * 0.55;
        var zTip = s7wing.rootZ + semi * Math.tan(s7wing.sweep) + s7wing.tipC;
        function at(worldX) {
          // undo the shadow offset to find which part of the wing casts here
          var wx = worldX - s7Off.x;
          // |local spanwise station|, measured out from the fuselage centreline
          var sp = Math.abs(S7_X - wx);
          if (sp > semi) return null;               // past the tip: no shade
          var f = sp / semi;
          var zle = s7wing.rootZ + sp * Math.tan(s7wing.sweep);
          var chord = M.lerp(s7wing.rootC, s7wing.tipC, f);
          // local z -> world z is a reflection (yaw PI), so the leading edge
          // becomes the SOUTHERN limit
          return {
            z0: S7_Z - (zle + chord) + s7Off.z,
            z1: S7_Z - zle + s7Off.z,
            centre: S7_Z - (zle + chord * 0.5) + s7Off.z,
            chord: chord
          };
        }
        return {
          x0: S7_X - S7_SPAN * 0.5 + s7Off.x, x1: S7_X + S7_SPAN * 0.5 + s7Off.x,
          z0: S7_Z - zTip + s7Off.z, z1: S7_Z - s7wing.rootZ + s7Off.z,
          centre: V(S7_X + s7Off.x, 0, S7_Z - zTip * 0.5 + s7Off.z),
          offset: s7Off, semiSpan: semi, at: at
        };
      })()
    };

    A.bigAircraft = [];
    for (i = 0; i < BIG.length; i++) {
      var b = BIG[i], T = TYPES[b.type];
      A.bigAircraft.push({
        name: b.name, type: b.type,
        centre: V(b.x, gy(b.x, b.z), b.z), yaw: b.yaw,
        len: T.len * b.scale, span: T.span * b.scale,
        tailY: T.wing.y * b.scale + T.finH * b.scale,
        wingY: T.wing.y * b.scale
      });
    }

    A.rows = [];
    for (i = 0; i < ROWS_X.length; i++) {
      A.rows.push({
        x: ROWS_X[i], bays: ROW_BAYS.slice(),
        corridorWest: ROWS_X[i] - 9.0, corridorEast: ROWS_X[i] + 9.0,
        span: TYPES.fighter.span, wingY: TYPES.fighter.wing.y
      });
    }
    A.corridors = [];
    for (i = 0; i + 1 < ROWS_X.length; i++) {
      A.corridors.push({ x: (ROWS_X[i] + ROWS_X[i + 1]) * 0.5, z0: ROW_BAYS[0] - 10, z1: ROW_BAYS[ROW_BAYS.length - 1] + 10 });
    }
    A.crossLane = {
      z0: CROSS_Z0, z1: CROSS_Z1, x0: -92, x1: -TAXI_HALF - 2,
      centre: V(-52, gy(-52, (CROSS_Z0 + CROSS_Z1) * 0.5), (CROSS_Z0 + CROSS_Z1) * 0.5),
      yaw: Math.PI * 0.5
    };

    var doorOff = shadeOffset(HG_DOOR_H);
    A.hangar = {
      x0: HG_X0, x1: HG_X1, z0: HG_Z0, z1: HG_Z1,
      doorX: HG_X0, doorZ0: HG_DOOR_Z0, doorZ1: HG_DOOR_Z1, doorH: HG_DOOR_H,
      eave: HG_EAVE, ridge: HG_RIDGE, floorY: HG_FLOOR,
      centre: V((HG_X0 + HG_X1) * 0.5, HG_FLOOR, (HG_Z0 + HG_Z1) * 0.5),
      doorCentre: V(HG_X0, HG_FLOOR, (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5),
      yaw: -Math.PI * 0.5,                       // the door faces -X
      // where the door beam actually lands on the floor
      sunPatch: {
        x0: HG_X0, x1: HG_X0 - doorOff.x, z0: HG_DOOR_Z0 - doorOff.z, z1: HG_DOOR_Z1 - doorOff.z,
        centre: V(HG_X0 - doorOff.x * 0.5, HG_FLOOR, (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5 - doorOff.z * 0.5)
      },
      jackStand: V(HG_X0 + 15.5, HG_FLOOR, HG_Z0 + 21.0),
      benchRun: V(HG_X1 - 1.6, HG_FLOOR, (HG_Z0 + HG_Z1) * 0.5),
      apron: V(HG_X0 - 6.0, gy(HG_X0 - 6.0, (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5), (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5)
    };

    A.partsYard = {
      x0: PY_X0, x1: PY_X1, z0: PY_Z0, z1: PY_Z1,
      centre: V((PY_X0 + PY_X1) * 0.5, gy((PY_X0 + PY_X1) * 0.5, (PY_Z0 + PY_Z1) * 0.5), (PY_Z0 + PY_Z1) * 0.5),
      wingRacks: [V(27, gy(27, 34), 34), V(27, gy(27, 46), 46), V(27, gy(27, 58), 58)],
      engineCradles: [V(35.5, gy(35.5, 31), 31), V(35.5, gy(35.5, 35.4), 35.4),
        V(35.5, gy(35.5, 39.8), 39.8), V(39.6, gy(39.6, 33), 33),
        V(39.6, gy(39.6, 37.4), 37.4), V(35.5, gy(35.5, 44.2), 44.2),
        V(39.6, gy(39.6, 41.8), 41.8), V(39.6, gy(39.6, 46.2), 46.2)],
      finRack: V(31, gy(31, 62), 62)
    };

    A.waterTower = {
      centre: V(WT_X, gy(WT_X, WT_Z), WT_Z),
      base: V(WT_X, gy(WT_X, WT_Z), WT_Z),
      catwalk: V(WT_X, gy(WT_X, WT_Z) + WT_H - 0.5, WT_Z),
      tankY: gy(WT_X, WT_Z) + WT_H, radius: WT_R, height: WT_H,
      beacon: V(WT_X, gy(WT_X, WT_Z) + WT_H + 7.4, WT_Z)
    };

    A.opsShack = {
      centre: V(OPS_X, gy(OPS_X, OPS_Z), OPS_Z), yaw: -0.06,
      w: 9.5, d: 5.4, h: 3.2,
      doorSide: V(OPS_X - 1.8, gy(OPS_X, OPS_Z), OPS_Z - 3.7),
      shadeSide: V(OPS_X + 5.6, gy(OPS_X, OPS_Z), OPS_Z + 4.0)
    };

    A.hulkRow = [];
    var hspots = [[30, -84], [30, -70], [30, -56], [30, -42], [44, -78], [44, -60]];
    for (i = 0; i < hspots.length; i++) {
      A.hulkRow.push({ centre: V(hspots[i][0], gy(hspots[i][0], hspots[i][1]), hspots[i][1]), yaw: Math.PI, len: 19 });
    }

    A.fence = {
      x0: FENCE_X0, x1: FENCE_X1, z0: FENCE_Z0, z1: FENCE_Z1,
      gate: { centre: V(0, gy(0, FENCE_Z1), FENCE_Z1), halfWidth: 6.0, yaw: 0 }
    };

    A.spawn = { centre: V(1.5, gy(1.5, 62), 62), yaw: 0 };

    // ---- SHADE ZONES ---------------------------------------------------------
    // Every rectangle of ground that spends noon in hard shadow. Derived, not
    // remembered: each one is its caster's footprint pushed along shadeOffset.
    A.shadeZones = [];
    function shadeFor(cx, cz, halfX, halfZ, h, src) {
      var o = shadeOffset(h);
      A.shadeZones.push({
        x0: cx - halfX + o.x, x1: cx + halfX + o.x,
        z0: cz - halfZ + o.z, z1: cz + halfZ + o.z,
        centre: V(cx + o.x, 0, cz + o.z), source: src, depth: h
      });
    }
    shadeFor(S7_X, S7_Z - 1.0, S7_SPAN * 0.5, 4.5, s7wing.y, 'sierra7_wing');
    shadeFor(S7_X, S7_Z, 2.8, S7_LEN * 0.5, TYPES.transport4.centreY, 'sierra7_body');
    for (i = 0; i < BIG.length; i++) {
      var bb = BIG[i], BT = TYPES[bb.type];
      shadeFor(bb.x, bb.z - 1.0, BT.span * bb.scale * 0.5, 4.0, BT.wing.y * bb.scale, bb.name + '_wing');
    }
    for (i = 0; i < ROWS_X.length; i++) {
      for (j = 0; j < ROW_BAYS.length; j++) {
        shadeFor(ROWS_X[i], ROW_BAYS[j], TYPES.fighter.span * 0.5, 3.0, TYPES.fighter.wing.y, 'row' + i);
      }
    }
    shadeFor((HG_X0 + HG_X1) * 0.5, (HG_Z0 + HG_Z1) * 0.5, (HG_X1 - HG_X0) * 0.5, (HG_Z1 - HG_Z0) * 0.5, HG_EAVE, 'hangar');
    shadeFor(WT_X, WT_Z, WT_R, WT_R, WT_H, 'waterTower');
    shadeFor(OPS_X, OPS_Z, 4.75, 2.7, 3.2, 'opsShack');

    // ---- dust devils ---------------------------------------------------------
    // Open fetch: a devil needs 30 m of clear hot slab upwind of it, so these
    // are the four places in the yard that actually have it.
    A.dustDevils = [
      V(-8, gy(-8, -60), -60), V(78, gy(78, 40), 40),
      V(-92, gy(-92, 24), 24), V(4, gy(4, -88), -88)
    ];
    return A;
  }

  // ---- material access, defensively -----------------------------------------
  LevelBoneyard.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.hardstand;
    var m = null;
    var lib = this.ctx && this.ctx.materials;

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (key === 'chain') {
      m = this._chainMaterial();
    } else if (key === 'crack') {
      m = this._crackMaterial();
    } else if (key === 'airframe') {
      m = this._skinMaterial();
    } else if (key === 'clad') {
      // 0xcdcfcb, not 0xe6e8e3: the shared skin map went up by SKIN_GAIN
      // (x1.28 linear) so the airframes could crest, and the two materials
      // that MULTIPLY that map come down by the same factor. The hangar is
      // exactly where it was; only the aeroplanes moved.
      m = this._skinMaterial(0xcdcfcb, 0.62, 0.40, 0.34, 'clad');
    } else if (key === 'skin_dull') {
      m = this._skinMaterial(0xb9b6ad, 1.75, 0.18, 0.30, 'skin_dull');
    } else if (key === 'ridge' && lib && typeof lib.distant === 'function') {
      // Aerial perspective is not optional on a 430 m ridge under a noon sky:
      // an un-hazed mountain is the brightest, hardest edge in the frame and
      // instantly collapses the depth the whole level is built on.
      try {
        // ---------------------------------------------------------------
        // A SONORAN RANGE AT NOON IS ONE VALUE WITH A SLOW GRADIENT, AND IT
        // IS NEARLY AS BRIGHT AS THE SKY IT STANDS AGAINST.
        //
        // The previous solve inverted the depth cue it exists to provide. At
        // albedoTarget 0x5c6270 with envMapIntensity 0.20 the 430 m range
        // measured 0.0376 linear against a 0.11 linear sky - three times
        // DARKER than the air it was meant to dissolve into, and with more
        // internal contrast than the mid-ground - and its map at a 90 m
        // triplanar tile printed 10-40 m cream blotches that read as snow
        // patches, a direct palette collision with snowbound.
        //
        // The three corrections, and each is measured against the sky:
        //   albedoTarget 0x646973  a mid grey-violet. 0x9aa0a6 was tried first
        //                          and measured 0.386 linear against a 0.132
        //                          sky - 2.9x OVER, the same inversion from the
        //                          other side, reading as a fog bank. This
        //                          lands it just under the sky.
        //   triScale 0.30          a 3.3 m tile: at 430 m that is 4 px, so
        //                          every map feature falls below notice and
        //                          only the geometry's own crest gradient is
        //                          left. macro 0 for the same reason - it is
        //                          what drew the blotches.
        //   env 0.42               enough sky in the IBL to keep the shaded
        //                          spurs off the floor, not enough to make a
        //                          rough mountain specular.
        // DoubleSide is load-bearing, not defensive: ringLoft winds a radial
        // annulus the opposite way round from the closed tubes it was written
        // for, so the range's whole inner face - the only part the player can
        // see - back-face culls without it.
        m = lib.distant('far_facade', 0x9fb0c4, 300, {
          density: 0.0034, vertexColors: true, wearMode: 'multiply',
          side: THREE.DoubleSide,
          albedoTarget: 0x4d525a, roughness: 0.97, metalness: 0.0,
          // env 0.80, not 0.30: the range's anti-sun flanks were metering
          // 0.022 linear against 0.099 on its sunward ones, a 4.5:1 split
          // across a proxy whose whole job is to be ONE value with a slow
          // gradient. Skylight is nearly all a distant mountain's shaded side
          // gets, and cutting the IBL to stop a rough surface picking a
          // specular highlight out of the sky (which at roughness 0.97 it
          // cannot do anyway) was throwing away the fill with it.
          envMapIntensity: 0.58, detail: 0, macro: 0, triScale: 0.30
        });
      } catch (e) { GAME.logError('boneyard.ridge', e); m = null; }
    } else if (lib && typeof lib.get === 'function') {
      var name = surf.base || 'concrete';
      var libHas = false;
      try { libHas = !!(typeof lib.has === 'function' && lib.has(name)); }
      catch (e2) { libHas = false; }
      if (!libHas) name = 'concrete';
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      // albedoTarget rather than color: `color` is a RAW MULTIPLIER and squares
      // a mapped material, which on a bleached-aluminium target is the
      // difference between satin metal and a grey plastic toy.
      if (surf.target !== undefined) opts.albedoTarget = surf.target;
      if (surf.rough !== undefined) opts.roughness = surf.rough;
      if (surf.metal !== undefined) opts.metalness = surf.metal;
      if (surf.env !== undefined) opts.envMapIntensity = surf.env;
      if (surf.macro !== undefined) opts.macro = surf.macro;
      if (surf.ns !== undefined) opts.normalScale = surf.ns;
      if (surf.col !== undefined && surf.target === undefined) opts.color = surf.col;
      if (surf.emissive !== undefined) {
        opts.emissive = surf.emissive;
        opts.emissiveIntensity = surf.emissiveIntensity || 1.0;
      }
      try { m = lib.get(name, opts); }
      catch (e3) { GAME.logError('boneyard.material:' + key, e3); m = null; }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelBoneyard.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.hardstand;
    var surf = SURF[key] || SURF.hardstand;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2],
      // A stock material has no wear shader, so a WEAR MASK written into the
      // colour attribute would be multiplied straight onto albedo. Wear surfaces
      // therefore drop vertex colours entirely on this path.
      vertexColors: !surf.wear,
      envMapIntensity: surf.env !== undefined ? surf.env : 1.0
    });
    if (surf.emissive !== undefined) {
      m.emissive = new THREE.Color().setHex(surf.emissive, THREE.SRGBColorSpace);
      m.emissiveIntensity = surf.emissiveIntensity || 1.0;
    }
    m.name = 'boneyard_fallback_' + key;
    return m;
  };

  LevelBoneyard.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0xA71A5) : this.rng); }
    catch (e) { GAME.logError('boneyard.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.86, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.06,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (tex && caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
      }
    } catch (e2) { /* anisotropy is a nicety */ }
    m.name = 'boneyard_stencils';
    return m;
  };

  // The airframe skin. Its own MeshStandardMaterial rather than a library one,
  // because what this surface needs is a DRAWN panel/rivet/patch map at a scale
  // no procedural tile can express (see buildSkinMaps) and materials.get() has
  // no way to be handed one. Everything else about it stays inside the house
  // conventions: albedo sRGB, normal/roughness NoColorSpace, vertexColors as a
  // plain albedo multiply (which is exactly what wearMode 'multiply' gave it),
  // and envMapIntensity in the same 1.0-1.1 band the review asked for.
  LevelBoneyard.prototype._skinMaterial = function (tint2, rough2, metal2, ns2, surfKey) {
    var maps = null;
    try { maps = buildSkinMaps(this.rng.fork ? this.rng.fork(0x5C1B) : this.rng); }
    catch (e) { GAME.logError('boneyard.skinmap', e); maps = null; }
    if (!maps || !maps.map) return null;        // caller falls back to the library
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (caps && caps.getMaxAnisotropy) {
        var an = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
        maps.map.anisotropy = an;
        if (maps.roughnessMap) maps.roughnessMap.anisotropy = an;
        if (maps.normalMap) maps.normalMap.anisotropy = an;
      }
    } catch (e2) { /* anisotropy is a nicety */ }
    // Named, not inferred from the tint value. It used to compare tint2
    // against a literal hex, so retuning that hex silently reassigned the
    // material's whole surface record.
    var surf = SURF[surfKey] || (tint2 === undefined ? SURF.airframe : SURF.clad);
    var m = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap || null,
      roughnessMap: maps.roughnessMap || null,
      // A raw colour multiply is right HERE and nowhere else in the file: the
      // map is authored in this module at a known mean, so multiplying it is
      // not squaring an unknown library gain.
      color: tint2 === undefined ? 0xffffff : tint2,
      // roughnessMap MULTIPLIES material.roughness, so the scalar carries the
      // family and the map carries the panel-to-panel variation.
      roughness: maps.roughnessMap ? (rough2 === undefined ? 1.0 : rough2) : surf.rough,
      metalness: metal2 === undefined ? surf.metal : metal2,
      vertexColors: true,
      envMapIntensity: surf.env
    });
    // 0.25-ish, not 1.0. The micro layer's job is to stop the panels reading as
    // flat fills; at full strength the rivet field fights the metal reflection
    // and prints as the same speckle it replaced.
    if (maps.normalMap) {
      var nsv = ns2 === undefined ? 0.28 : ns2;
      m.normalScale = new THREE.Vector2(nsv, nsv);
    }
    m.name = 'boneyard_skin_' + (tint2 === undefined ? 'alu' : tint2.toString(16));
    return m;
  };

  // The joint/craze overlay. Transparent, depth-write off, polygon-offset, and
  // drawn after the slab: the same contract the stencil decals already use.
  LevelBoneyard.prototype._crackMaterial = function () {
    var tex = null;
    try { tex = buildCrackTexture(this.rng.fork ? this.rng.fork(0xC2AC) : this.rng); }
    catch (e) { GAME.logError('boneyard.cracktex', e); tex = null; }
    this._crackOk = !!tex;
    if (!tex) return null;
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
      }
    } catch (e2) { /* fine */ }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.94, metalness: 0.0,
      transparent: true, depthWrite: false, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      envMapIntensity: 0.55
    });
    m.name = 'boneyard_padjoints';
    return m;
  };

  LevelBoneyard.prototype._chainMaterial = function () {
    var tex = null;
    try { tex = chainLinkTexture(); } catch (e) { tex = null; }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0x9aa3a8, roughness: 0.55, metalness: 0.72,
      transparent: false, alphaTest: 0.42, side: THREE.DoubleSide,
      vertexColors: false, envMapIntensity: 1.0
    });
    if (!tex) { m.opacity = 0.20; m.transparent = true; m.alphaTest = 0; }
    m.name = 'boneyard_chainlink';
    return m;
  };

  // ---- colliders -------------------------------------------------------------
  LevelBoneyard.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
    var q = new THREE.Quaternion();
    if (euler) q.setFromEuler(euler);
    var c = {
      type: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'concrete',
      floor: !!isFloor
    };
    this.colliders.push(c);
    return c;
  };

  // ---- build ------------------------------------------------------------------
  LevelBoneyard.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('boneyard.' + name, e); }
    }

    stage('ground', function () { buildPad(self, B, rng, N); });
    stage('padjoints', function () { buildPadOverlay(self, rng, N); });
    stage('desert', function () { buildDesert(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('ridge', function () { buildRidge(self, B, rng, N); });
    stage('markings', function () { buildMarkings(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('rows', function () { self._buildRows(B, rng, N); });
    await GAME.yieldFrame();

    stage('big', function () { self._buildBig(B, rng, N); });
    stage('hulks', function () { self.hulks = buildHulkRow(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('hangar', function () { self.hangarInfo = buildHangar(self, B, rng, N); });
    stage('parts', function () { self.partsInfo = buildPartsYard(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('tower', function () { self.towerInfo = buildWaterTower(self, B, rng, N); });
    stage('ops', function () { buildOpsShack(self, B, rng, N); });
    stage('fence', function () { buildFence(self, B, rng, N); });
    stage('stands', function () { self._buildStands(B, rng, N); });
    await GAME.yieldFrame();

    stage('lights', function () { self._buildLights(); });
    stage('merge', function () { self._finalize(B); });
    stage('movers', function () { self._buildMovers(); });
    await GAME.yieldFrame();

    stage('nav', function () { self._buildNav(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);

    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    return this;
  };

  LevelBoneyard.prototype._buildRows = function (B, rng, N) {
    var plan = planAircraft(rng.fork ? rng.fork(0x524f57) : rng);
    this.aircraft = plan;
    for (var i = 0; i < plan.length; i++) {
      var a = plan[i];
      var gy = groundY(a.x, a.z, N);
      B.pushXYZ(a.x, gy, a.z, 0, a.yaw, 0);
      var info = buildAircraft(B, this, a.type, {
        body: bodyTint(a.body, 0.55, a.val),
        crown: a.crown ? bodyTint(a.crown, 0.30, Math.min(1, a.val + 0.20)) : null,
        wrapped: a.wrapped, onJacks: a.onJacks, noWings: a.noWings,
        scale: a.scale, seed: a.seed, soot: a.soot,
        rotorPhase: rng.range(0, 3.1), propPhase: rng.range(0, 2.0)
      }, rng);
      B.pop();
      B.tint = null; B.paint = 'ground';
      a.info = info;
      a.groundY = gy;
      this._addAircraftColliders(a, info, gy, N);
      this._blockers.push([a.x - info.span * 0.5, a.x + info.span * 0.5,
        a.z - info.half, a.z + info.half]);
    }
  };

  LevelBoneyard.prototype._buildBig = function (B, rng, N) {
    for (var i = 0; i < BIG.length; i++) {
      var b = BIG[i];
      var gy = groundY(b.x, b.z, N);
      B.pushXYZ(b.x, gy, b.z, 0, b.yaw, 0);
      var info = buildAircraft(B, this, b.type, {
        body: bodyTint(b.body, 0.55, b.val === undefined ? 1 : b.val),
        crown: b.crown ? bodyTint(b.crown, 0.30, Math.min(1, (b.val || 1) + 0.15)) : null,
        wrapped: b.wrapped, onJacks: b.onJacks, scale: b.scale,
        seed: 11 + i * 3, soot: 0.8, propPhase: rng.range(0, 2.0)
      }, rng);
      B.pop();
      B.tint = null; B.paint = 'ground';
      var rec = {
        name: b.name, type: b.type, x: b.x, z: b.z, yaw: b.yaw,
        info: info, groundY: gy, body: b.body
      };
      this.bigAircraft.push(rec);
      this._addAircraftColliders({ x: b.x, z: b.z, yaw: b.yaw, type: b.type, scale: b.scale }, info, gy, N);
      this._blockers.push([b.x - info.span * 0.5, b.x + info.span * 0.5,
        b.z - info.half, b.z + info.half]);
    }
  };

  // Colliders for one airframe. A wing is a THIN SLAB AT WING HEIGHT and not a
  // full-height box, deliberately: the brief asks for shade you can fight in,
  // and a solid box under every wing would fence the player out of the only
  // dark ground in the level.
  LevelBoneyard.prototype._addAircraftColliders = function (a, info, gy, N) {
    if (!info) return;
    var T = TYPES[a.type];
    var s = a.scale || 1;
    var e = new THREE.Euler(0, a.yaw, 0, 'YXZ');
    var cosY = Math.cos(a.yaw), sinY = Math.sin(a.yaw);
    // fuselage
    this.addCollider(a.x, gy + info.centreY, a.z, info.r * 0.95, info.r, info.half * 0.94,
      'metal', false, e);
    // wings, if it still has them
    if (T && T.wing && info.span > 1) {
      var wy = gy + info.wingY;
      var wz = T.wing.rootZ * s + T.wing.rootC * s * 0.5;
      var wx = info.span * 0.25;
      // one slab per side, so the tips are separate obstacles for the navgrid
      for (var sg = -1; sg <= 1; sg += 2) {
        var lx = sg * wx, lz = wz;
        this.addCollider(a.x + lx * cosY + lz * sinY, wy, a.z - lx * sinY + lz * cosY,
          info.span * 0.25, 0.22 * s, T.wing.rootC * s * 0.5, 'metal', false, e);
      }
    }
    // fin: the tall part, so AI cannot see through a T-tail
    if (T && (T.tail === 'T' || T.tail === 'low')) {
      var fz = info.half * 0.72;
      this.addCollider(a.x + fz * sinY, gy + info.centreY + T.finH * s * 0.45, a.z + fz * cosY,
        0.30 * s, T.finH * s * 0.5, T.finRootC * s * 0.45, 'metal', false, e);
    }
  };

  LevelBoneyard.prototype._buildStands = function (B, rng, N) {
    // Maintenance stands, parked against the airframes that are being worked.
    // They are the only saturated colour in the yard and they are placed at the
    // three places a camera looks.
    // Stand positions are checked against hero1's eye: the first pass put one
    // 6 m dead ahead of it and its 2.6 m platform floated across the middle of
    // the level's signature frame like a dropped table. They belong AGAINST an
    // airframe - which is where a real one is - so they read as equipment
    // serving the aeroplane rather than as furniture in a field.
    var spots = [
      [S7_X - 5.5, S7_Z - 1.5, 1.45, 3.1, 2.6],
      [S7_X + 9.6, S7_Z - 12.0, -1.30, 2.4, 2.2],
      [ROWS_X[0] + 6.2, ROW_BAYS[3] + 2.0, 1.42, 2.0, 1.9],
      [ROWS_X[1] - 6.4, ROW_BAYS[1] - 1.0, -1.52, 2.0, 1.9],
      [ROWS_X[2] + 6.6, ROW_BAYS[4] + 1.0, 1.60, 1.8, 1.8],
      [HG_X0 - 7.0, HG_DOOR_Z0 + 3.0, 0.10, 2.6, 2.4],
      [PY_X0 + 4.0, PY_Z1 - 6.0, -0.60, 2.2, 2.0]
    ];
    for (var i = 0; i < spots.length; i++) {
      var sp = spots[i];
      var gy = groundY(sp[0], sp[1], N);
      buildStand(B, sp[0], gy, sp[1], sp[2], sp[3], sp[4]);
      this.addCollider(sp[0], gy + sp[3] * 0.5, sp[1], sp[4] * 0.6, sp[3] * 0.5, 1.1, 'metal');
    }
    // A tug and a fuel bowser would be props' business; what belongs here is the
    // pair of concrete blast blocks at the taxiway mouth, which are level
    // structure and which give the spawn view a hard near-foreground.
    B.paint = 'ground'; B.tint = tint(0xa8a294, 0.4);
    for (i = 0; i < 2; i++) {
      var bx = (i ? 1 : -1) * (TAXI_HALF + 1.6);
      var bgy = groundY(bx, 58.0, N);
      B.boxR('conc_wall', 1.1, 1.15, 3.4, bx, bgy + 0.56, 58.0, 0, (i ? -1 : 1) * 0.06, 0, 0.06);
      B.boxR('conc_wall', 1.3, 0.18, 3.6, bx, bgy + 1.20, 58.0, 0, (i ? -1 : 1) * 0.06, 0, 0.04);
      this.addCollider(bx, bgy + 0.6, 58.0, 0.6, 0.6, 1.7, 'concrete');
    }
    B.tint = null;
  };

  // ---- the lighting the yard implies -----------------------------------------
  LevelBoneyard.prototype._buildLights = function () {
    var i;
    var mz = (HG_Z0 + HG_Z1) * 0.5;
    // Hangar high bays. dayBase 0.90: a working hangar with a 32 m span keeps
    // its lights on at noon because the only daylight it gets is one door and
    // three roof monitors, and the `interior` framing depends on the back half
    // of the shed being readable rather than black.
    for (i = 0; i < 3; i++) {
      var lz = HG_Z0 + 7.0 + i * 9.5;
      // 124/104 rather than 96/82, and it is the slab bounce that paid for it.
      // Those two shadowless fills used to sit at +12 degrees, so they landed
      // 0.478 units of unshadowed warm key on every up-facing surface in the
      // level - and being shadowless, that included the floor INSIDE this
      // shed, thirty metres from any daylight. Aiming them below the horizon
      // (BOUNCE_ELEV, and the shadows on the apron are the reason) correctly
      // took that away, and the hangar had been quietly living on it: the
      // interior floor measured 100 sRGB before and 53 after. A working
      // hangar's floor is lit by its own high bays, so they carry it.
      this.practicalLights.push({
        name: 'boneyard_bay_' + i, kind: 'fluoro', fixture: 'none',
        pos: [HG_X0 + 10.5, HG_FLOOR + HG_EAVE - 1.6, lz],
        kelvin: 4300, intensity: 124, distance: 25, dayBase: 0.90,
        bulbR: 0.28, bulbFlat: 0.35, bulbGain: 0.9
      });
      this.practicalLights.push({
        name: 'boneyard_bay_b' + i, kind: 'fluoro', fixture: 'none',
        pos: [HG_X1 - 8.0, HG_FLOOR + HG_EAVE - 1.6, lz],
        kelvin: 4300, intensity: 104, distance: 23, dayBase: 0.90,
        bulbR: 0.28, bulbFlat: 0.35, bulbGain: 0.9
      });
    }
    // A worklight on a stand beside the airframe on jacks - the one warm source
    // in a 4300 K shed, and the thing that separates the subject from the wall.
    this.practicalLights.push({
      name: 'boneyard_worklight', kind: 'tungsten', fixture: 'none',
      pos: [HG_X0 + 12.0, HG_FLOOR + 2.4, HG_Z0 + 17.5],
      kelvin: 3000, intensity: 34, distance: 12, dayBase: 1.0,
      cone: 1.05, penumbra: 0.55, aimPos: [HG_X0 + 16.5, HG_FLOOR + 1.4, HG_Z0 + 21.5],
      bulbR: 0.11, bulbGain: 1.2
    });
    // The obstruction beacon on the water tank. Red, always lit, and the only
    // mark in the TOP of the overview frame.
    this.practicalLights.push({
      name: 'boneyard_beacon', kind: 'beacon', fixture: 'none',
      pos: [WT_X, groundY(WT_X, WT_Z, this.noise) + WT_H + 7.4, WT_Z],
      color: 0xff3020, kelvin: 1900, intensity: 26, distance: 26, dayBase: 1.0,
      bulbR: 0.24, bulbGain: 1.5, halo: 1.4
    });
    // Yard floods on the ops shack and the hangar corners. dayBase 0 - they are
    // shut at noon and they still have to exist, because a level that publishes
    // no fixtures has nothing to switch on at any other hour.
    var floods = [
      ['ops', OPS_X + 4.6, 4.2, OPS_Z - 3.0, [OPS_X + 10, 0, OPS_Z + 6]],
      ['hg_nw', HG_X0 - 0.6, HG_EAVE - 0.4, HG_Z0 - 0.4, [HG_X0 - 14, 0, HG_Z0 - 10]],
      ['hg_sw', HG_X0 - 0.6, HG_EAVE - 0.4, HG_Z1 + 0.4, [HG_X0 - 14, 0, HG_Z1 + 10]],
      ['gate', 4.6, 5.2, FENCE_Z1 - 1.5, [0, 0, FENCE_Z1 - 16]]
    ];
    for (i = 0; i < floods.length; i++) {
      var f = floods[i];
      this.practicalLights.push({
        name: 'boneyard_flood_' + f[0], kind: 'led', fixture: 'none',
        pos: [f[1], groundY(f[1], f[3], this.noise) + f[2], f[3]],
        kelvin: 4000, intensity: 210, distance: 34, dayBase: 0.0,
        cone: 0.62, penumbra: 0.45, aimPos: f[4], beam: 0.5, halo: 1.2
      });
    }

    // ---- shafts ---------------------------------------------------------------
    // Three roof monitors and the door. dir is the direction of TRAVEL of the
    // light, i.e. away from the sun, so it agrees with every shadow in the yard.
    var sd = shadeOffset(1.0);
    var dir = new THREE.Vector3(sd.x, -1, sd.z).normalize();
    for (i = 0; i < 3; i++) {
      var sz = HG_Z0 + 7.0 + i * 9.5;
      this.lightShafts.push({
        origin: new THREE.Vector3((HG_X0 + HG_X1) * 0.5, HG_FLOOR + HG_RIDGE - 0.2, sz),
        dir: dir.clone(),
        width: 3.4, length: HG_RIDGE - 0.6, strength: 0.85, kind: 'monitor'
      });
    }
    this.lightShafts.push({
      origin: new THREE.Vector3(HG_X0 + 0.4, HG_FLOOR + HG_DOOR_H - 0.8,
        (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5),
      dir: dir.clone(),
      width: 5.2, length: 14.0, strength: 1.0, kind: 'door'
    });

    // ---- THE SLAB, AS A LIGHT SOURCE -------------------------------------
    // Measured, and it is the single biggest lighting fact about this level:
    // an anti-sun VERTICAL face here receives about 1% of the key. The hangar's
    // shaded end wall metered 0.0035 linear against 0.373 on its own sunlit
    // face - and setting that material to metalness 0.0 with envMapIntensity
    // 1.8 changed it by 3%, which proves the problem is not the material, it is
    // that no light arrives. (Down-facing surfaces are fine: the same airframe
    // material reads 0.14 on Sierra Seven's belly.) The shared rig's skylight
    // and hemisphere terms are gated by the sky-visibility volume, whose cells
    // here are 6.0 x 1.0 x 2.9 m, and next to a 32 m shed they return near
    // their floor - so a wall standing in the open photographs as if it were
    // inside a cave. That is a shared-system finding and it is reported as one.
    //
    // What this level can legitimately do about it is model the source the rig
    // has no term for. Two hundred metres of white concrete under a vertical
    // sun is not a metaphor - it is a bounce card the size of the level, and
    // in every real photograph of AMARG it is what fills the shaded side of
    // every airframe. So the level publishes it: two wide, warm, SHADOWLESS
    // directionals from the anti-sun quadrant at a shallow angle. They are
    // physically the reflected slab, they cannot touch a sunlit face (its
    // lambert term against them is negative), and they are aimed off the real
    // sun in update() rather than off the authored one.
    this._buildBounceFill();

    // ---- the shade record ------------------------------------------------------
    this.shadeZones = this.anchors.shadeZones;
    // ---- THE BOIL OVER THE TARMAC ------------------------------------------
    // postfx.js reads this record on its own (see setHeatShimmer) and turns it
    // into a screen-space refraction, so it is not advisory any more.
    //
    // ------------------------------------------------------------------------
    // strength 0.55, DOWN from 1.70, and that one number was costing this level
    // its establishing frame. Measured, A/B, camera unmoved, everything else
    // held:
    //
    //             flat_area_pct   edge_energy   dyn.range   yard band < 80
    //   1.70          55.63          0.0757       0.642        2.30 %
    //   ~0            38.70          0.1311       0.733        9.22 %
    //
    // 55.63 is a HARD FAIL against analyze.py's 45.0 limit and it is exactly
    // the "flat, white, contrastless frame" the brief names as this level's
    // trap - arriving from post, not from the geometry, and hiding behind five
    // green metric reports on the other four framings.
    //
    // The mechanism is a coupling across two files. `strength` scales BOTH
    // halves of postfx's heat effect: uHeat (the displacement) and uHeatPale
    // (the inferior mirage, added later). BLEACH_GRADE publishes heatPale 0.55
    // with heatCellFloor 0.55, so at strength 1.70 the mirage ran at
    // 0.55 x 1.70 = 0.935, and with the cell floor that means every ground
    // pixel past heatFar (70 m) and below 6.2 m was 51-94 % REPLACED by one
    // constant at 2.2x the frame's metered key. A 10:1 wing shadow - and
    // hero1's near-field shadows do measure 10:1 - arrives on screen at 1.2:1.
    // The far ground was lifted above the airframes standing on it: at 90 m the
    // slab metered p50 151 against 144 on the aeroplanes, i.e. figure/ground
    // INVERTED, which is why 34 aircraft printed as white ghosts.
    //
    // 0.55 is not a retreat from the brief, it is the amplitude the preset was
    // written for. postfx's own arithmetic is
    // "heatAmount x strength x 0.57 x 720 px", and BLEACH_GRADE's heatAmount
    // 0.022 is documented as giving "7.6 px of vertical boil" - which solves to
    // strength 0.84, the level's value BEFORE this file doubled it. So 1.70 was
    // double-counting an increase the preset had already absorbed. At 0.55 the
    // boil is ~5 px (the same note calls 3.1 px "barely separable from TAA
    // jitter", so this is still comfortably readable) and the mirage runs at
    // 0.166 outside the cells - present as a pale dissolve under everything
    // standing on the far slab, which is what a mirage is, rather than as a
    // coat of paint over the level's only graphic asset.
    //
    // See sharedNeeds: the displacement and the mirage want separate scalars,
    // and the mirage wants to attenuate with the view ray's PATH LENGTH through
    // the hot layer rather than with the lit surface's height - an eye 20 m up
    // on a water tower looks through 3 m of it and currently gets all of it.
    //
    // The cells are re-aimed off the storage field for the same reason: inside
    // a cell `cell` goes to 1.0, i.e. nearly double the floor, and two of the
    // six sat squarely on the four rows of aeroplanes that ARE the establishing
    // shot's subject. They now cover open taxiway and open apron only - the
    // mid-grounds hero1, hero2 and hero3 shoot across, where there is no
    // silhouette to dissolve and where a boil over bare slab is the whole
    // point. HEAT_CELL_MAX is 6 and this uses all six.
    this.heatShimmer = {
      y: 0.0, strength: 0.55,
      cells: [
        { x: 4, z: -30, r: 30 },     // taxiway mid-ground: hero1, hero3
        { x: 4, z: 34, r: 26 },      // taxiway north, the spawn run
        { x: 38, z: 38, r: 20 },     // the parts-yard apron: hero2
        { x: 34, z: -34, r: 26 },    // open apron east of the taxiway
        { x: 80, z: -18, r: 24 },    // the east big-airframe apron
        { x: -12, z: -84, r: 26 }    // the far south run, clear of the rows
      ]
    };
  };

  // ---------------------------------------------------------------------------
  // The slab bounce, as two shadowless directionals on the level's own root.
  // A level owning a light is not a new idea in this build - the harbor runs a
  // hand-built rig and every level publishes practicalLights - but a POINT
  // light cannot do this job: inverse-square over a 32 m wall means either a
  // hotspot at one end or nothing at the other, and what a bounce card gives
  // is a near-parallel wash. Neither light casts a shadow, so the cost is two
  // extra lambert terms and no extra depth pass.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // BOUNCE_ELEV IS NEGATIVE, AND THAT IS THE WHOLE POINT.
  //
  // At +12 degrees these two shadowless lights sat ABOVE the horizon shining
  // down, so lambert on an up-facing normal was sin(12) = 0.208 and the pair
  // deposited 2 x 1.15 x 0.208 = 0.478 units of unshadowed warm key on every
  // square metre of hardstanding - INCLUDING the interior of every aircraft
  // shadow, permanently, because they cannot be shadowed by design. Two lights
  // whose stated job is to fill the shaded VERTICAL flanks of airframes were
  // quietly filling in the one graphic asset the level has.
  //
  // Their job only ever needed the horizontal component. At -3 degrees an
  // up-facing normal gets dot = -0.052, clamped to zero, so the fill
  // contributes exactly nothing to the slab and nothing to any shadow cast on
  // it; a vertical anti-sun flank still gets cos(3) = 0.9986, i.e. the flank
  // fill this exists for is unchanged to within 0.14%. One sign, same purpose,
  // none of the harm.
  //
  // The lights are positioned on the exact ray now, with no vertical fudge:
  // the old `dy * 160 + 6` turned a nominal 12 degrees into 9.9 and would have
  // turned -3 into -0.35, which is 88% of the harm back again.
  // ---------------------------------------------------------------------------
  // AND A THIRD ONE POINTING STRAIGHT UP, WHICH IS THE HALF OF A BOUNCE CARD
  // THE PAIR ABOVE CANNOT DO AT ALL.
  //
  // The two flank fills sit 3 degrees BELOW the horizon so they cannot leak into
  // a shadow on the slab, and that is right - but it also means a DOWN-facing
  // normal gets dot = sin(3) = 0.052 out of them, i.e. essentially nothing. So
  // the whole underside of this level had no fill of any kind: Sierra Seven's
  // port wing crosses the top third of hero1 as one unbroken plank at 0.36 of
  // its own sunlit flank in display, with its ribs, its spar and its three
  // flap-track fairings all inside a single value, and the near tailplane in the
  // establishing frame prints black with a blue rim. That is the "flat black
  // shadows" tell the architecture doc calls the #1 amateur giveaway, on the
  // largest single shape in the signature frame.
  //
  // 200 m of white concrete under a vertical sun is a bounce card that lies
  // BELOW everything in the yard, and what a card below you lights is your
  // underside. So the third light shines straight up (position -Y, target at the
  // origin), and the geometry of that is exactly why it is safe: lambert against
  // an up-facing normal is dot(+Y, +Y_travel) = -1, clamped to zero, so it
  // deposits mathematically nothing on the hardstanding, nothing in any shadow
  // cast on it, and nothing on a vertical flank either (dot = 0). It can only
  // touch surfaces that face the ground, which is the set that had no light.
  //
  // 0.72 rather than the flanks' 1.15: a horizontal slab returns its albedo
  // (~0.35) times the full vertical key, but an underside is also a metre or two
  // above the card and sees it at less than a full hemisphere, and above ~1.0
  // the wing undersides stop reading as shade at all.
  var BOUNCE_ELEV = -3.0 * Math.PI / 180;
  var BOUNCE_SPREAD = 48.0 * Math.PI / 180;
  var BOUNCE_I = 1.15;
  var BOUNCE_UP_I = 0.62;

  LevelBoneyard.prototype._buildBounceFill = function () {
    this._bounce = [];
    var i;
    for (i = 0; i < 2; i++) {
      var L = new THREE.DirectionalLight(0xffffff, 0.0);
      // A slab bounce is the sun's colour reflected off warm concrete, so it
      // is WARMER than the key and slightly desaturated, never the cool sky
      // blue an ambient probe would give.
      L.color.setHex(0xffe8cc, THREE.SRGBColorSpace);
      L.castShadow = false;
      // 1.15, calibrated by sweep: at 0.46 an anti-sun airframe panel measured
      // 0.016 linear (23:1 against its own lit face) and at 3.0 it measured
      // 0.085, which is brighter than the shaded ground it stands on and
      // flattens every shaded form in the yard. 1.15 lands airframe skin at
      // roughly 10:1 and leaves the ground bounce reading as bounce.
      L.intensity = BOUNCE_I;
      var tgt = new THREE.Object3D();
      tgt.position.set(0, 0, 0);
      this.root.add(tgt);
      L.target = tgt;
      this.root.add(L);
      this._bounce.push(L);
    }
    // the card itself, seen from underneath
    var U = new THREE.DirectionalLight(0xffffff, BOUNCE_UP_I);
    U.color.setHex(0xffe4c2, THREE.SRGBColorSpace);
    U.castShadow = false;
    var utgt = new THREE.Object3D();
    utgt.position.set(0, 0, 0);
    this.root.add(utgt);
    U.target = utgt;
    U.position.set(0, -140, 0);
    this.root.add(U);
    this._bounceUp = U;
    this._aimBounce(SUN_AZ, SUN_EL);
  };

  // Aim both fills at +/- BOUNCE_SPREAD either side of the anti-sun bearing.
  // `el` is the REAL solar elevation and it is used: a slab bounce is brighter
  // the more nearly overhead the key is (the concrete receives cos(zenith) of
  // it), so the pair scales with sin(el) normalised against the elevation this
  // level is authored for. It used to be accepted and thrown away with a bare
  // `void el`, which is a trap for the next pass.
  LevelBoneyard.prototype._aimBounce = function (az, el) {
    if (!this._bounce || !this._bounce.length) return;
    var back = az + Math.PI;
    var gain = 1.0;
    if (isFinite(el)) {
      gain = M.clamp(Math.sin(Math.max(0.05, el)) / Math.sin(SUN_EL), 0.25, 1.35);
    }
    for (var i = 0; i < this._bounce.length; i++) {
      var a = back + (i ? BOUNCE_SPREAD : -BOUNCE_SPREAD);
      var ce = Math.cos(BOUNCE_ELEV);
      var dx = Math.sin(a) * ce, dz = -Math.cos(a) * ce, dy = Math.sin(BOUNCE_ELEV);
      this._bounce[i].position.set(dx * 160, dy * 160, dz * 160);
      this._bounce[i].intensity = BOUNCE_I * gain;
      this._bounce[i].updateMatrixWorld();
    }
    // The upward card has no bearing - it is the ground - but it scales with the
    // same gain, because how much light the slab returns upward is exactly how
    // much the sun puts into it.
    if (this._bounceUp) {
      this._bounceUp.intensity = BOUNCE_UP_I * gain;
      this._bounceUp.updateMatrixWorld();
    }
  };

  // ---------------------------------------------------------------------------
  // THE ONLY THINGS IN THE YARD THAT MOVE.
  //
  // Everything else here is merged, static and matrixAutoUpdate = false, which
  // is right for 34 dead aeroplanes and wrong for the whole frame: a still image
  // in which literally nothing can move reads as a photograph of a model, and
  // this level has no rain, no sea and no fire to carry that load. Two objects,
  // four triangles' worth of animation, driven off the same wind vector:
  //   * the windsock on the ops shack mast, which also TELLS you the wind
  //     direction and therefore why the sand has drifted the way it has
  //   * a torn corner of spraylat sheeting on the nearest storage row, flapping
  // Both live outside the merge as their own small meshes.
  // ---------------------------------------------------------------------------
  LevelBoneyard.prototype._buildMovers = function () {
    var N = this.noise;
    var wrapMat = this.material('wrap');
    var steelMat = this.material('steel');

    // Every level material in this file is built with vertexColors ON, because
    // the merged buckets all carry a wear/tint attribute. A mesh handed one of
    // those materials with NO colour attribute does not fall back to white -
    // WebGL supplies (0,0,0) for a missing attribute and the object renders
    // BLACK. These four meshes are the only ones outside the merge, so they are
    // the only ones that can hit it, and they are all whitened here.
    function white(g) {
      var n = g.attributes.position.count;
      var c = new Float32Array(n * 3);
      for (var i = 0; i < n * 3; i++) c[i] = 1;
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    }

    // ---- the windsock --------------------------------------------------------
    var mx = OPS_X + 7.6, mz = OPS_Z - 5.4;
    var gy = groundY(mx, mz, N);
    var mast = new THREE.Object3D();
    mast.position.set(mx, gy, mz);
    var poleG = white(new THREE.CylinderGeometry(0.055, 0.075, 6.4, 7, 1, false));
    var pole = new THREE.Mesh(poleG, steelMat);
    pole.position.y = 3.2;
    pole.castShadow = true;
    mast.add(pole);
    // the sock: an open cone, wider at the throat, with a hoop at the mouth
    var sockG = new THREE.CylinderGeometry(0.30, 0.62, 2.6, 10, 3, true);
    sockG.rotateX(Math.PI * 0.5);
    sockG.translate(0, 0, 1.3);
    var sock = new THREE.Mesh(white(sockG), wrapMat);
    sock.castShadow = true;
    var pivot = new THREE.Object3D();
    pivot.position.set(0, 6.15, 0);
    pivot.add(sock);
    var hoop = new THREE.Mesh(white(new THREE.TorusGeometry(0.62, 0.035, 5, 12)), steelMat);
    pivot.add(hoop);
    mast.add(pivot);
    this.root.add(mast);
    this._movers.push({ kind: 'sock', obj: pivot });
    this.addCollider(mx, gy + 1.4, mz, 0.14, 1.4, 0.14, 'metal');

    // ---- a torn spraylat sheet, weighted at one end --------------------------
    var sx = ROWS_X[0] + 7.2, sz = ROW_BAYS[2] - 3.0;
    var sgy = groundY(sx, sz, N);
    var sheetG = new THREE.PlaneGeometry(2.4, 3.2, 4, 5);
    // pre-crease it: a flat plane is a flag, a creased one is rubbish
    var sp = sheetG.attributes.position;
    for (var i = 0; i < sp.count; i++) {
      var px = sp.getX(i), py = sp.getY(i);
      sp.setZ(i, Math.sin(px * 2.3 + py * 1.1) * 0.07 + Math.sin(py * 3.1) * 0.05);
    }
    sheetG.computeVertexNormals();
    var sheet = new THREE.Mesh(white(sheetG), wrapMat);
    sheet.castShadow = true;
    sheet.position.set(0, -1.5, 0);
    var flap = new THREE.Object3D();
    flap.position.set(sx, sgy + 1.7, sz);
    flap.rotation.order = 'YXZ';
    flap.rotation.y = 0.7;
    flap.add(sheet);
    this.root.add(flap);
    this._movers.push({ kind: 'flap', obj: flap, base: -0.34, phase: 1.7 });
    // the crate it is snagged on
    // A FRESH geometry, not the cached box(): build() disposes the whole box
    // cache when it finishes, and a mesh still pointing at a disposed buffer
    // renders nothing at all.
    var crate = new THREE.Mesh(white(Geo.bevelBox(0.9, 0.6, 1.4, 0.03)), steelMat);
    crate.position.set(sx + 0.2, sgy + 0.3, sz + 0.4);
    crate.castShadow = true; crate.receiveShadow = true;
    this.root.add(crate);
  };

  // ---- merge -----------------------------------------------------------------
  LevelBoneyard.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.hardstand;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('boneyard.merge:' + key, e); continue; }
      // keepUV means the source authored its own UVs (the stencil cards, the
      // chain-link sheets). mergeAll drops the whole uv attribute if ANY entry
      // in the bucket lacks one, so the second clause is not belt and braces.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('boneyard.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'boneyard_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'ridge') { mesh.frustumCulled = false; mesh.renderOrder = -1; }
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // ---------------------------------------------------------------------------
  // VERTEX COLOUR.
  //
  // On `wear` surfaces this is materials.js's WEAR MASK - white = pristine,
  // R grime, G wetness, B edge wear. This is a DESERT, so G stays at 1.0 (dry)
  // everywhere except three oil spills, and the whole budget goes into R and B.
  // On everything else it is a plain albedo multiplier.
  //
  // What it is actually for: a noon frame of bleached concrete and bleached
  // aluminium has almost no value range of its own, and this pass is where all
  // of it comes from - blown sand, rubber deposit, exhaust soot, hydraulic
  // streaks, chalking that varies per panel, and the pale ghost of a serial
  // that has been painted over.
  // ---------------------------------------------------------------------------
  var _pc = new THREE.Color();
  var _pinv = new THREE.Matrix4();
  var _plp = new THREE.Vector3();
  var _pln = new THREE.Vector3();
  // The barrel-section pitch the skin pass bands against. Matches the geometry
  // straps closely enough that the painted lap line and the modelled one land
  // on the same joint at the scales that matter.
  var PANEL_PITCH = 1.90;

  LevelBoneyard.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var Nv = pos.count;
    var col = new Float32Array(Nv * 3);
    var noise = this.noise;
    var surf = SURF[key] || SURF.hardstand;
    var isWear = !!surf.wear;
    var vi = 0, e, i, j;

    // Height above the DATUM. The slab is graded, but it stays inside +/-0.40 m
    // of y = 0 across the whole 204 x 168 m, so anything that only wants "how
    // far up this object am I" - dust bands, streak lengths, chalking - reads
    // world y directly. Calling groundY() per vertex instead would run two
    // worley lookups on every one of ~300k airframe vertices to resolve a
    // difference smaller than the band it is feeding.
    //
    // Oil and hydraulic spills: the only places in a desert that are WET.
    var spills = [[S7_X - 2.2, S7_Z - 3.0, 2.6], [-42.5, -16.5, 1.6],
                  [HG_X0 + 15.5, HG_Z0 + 21.5, 2.0], [27.5, 46.0, 1.4]];

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode = ent.paint || 'metal';
      // Force the mode to agree with the surface's shader: a multiplier written
      // into a wear mask (or the reverse) is a silent, catastrophic bug.
      if (isWear) {
        if (key === 'paint_line') mode = 'line';
        else if (key === 'desert') mode = 'sand';
        else if (key === 'verge') mode = 'gravel';
        else if (key === 'conc_wall') mode = 'wall';
        else if (key === 'hg_floor') mode = 'floor';
        else mode = 'ground';
      } else if (mode === 'ground' || mode === 'line' || mode === 'sand' ||
                 mode === 'gravel' || mode === 'wall') {
        mode = 'metal';
      }
      if (key === 'glass_lit' || key === 'decal' || key === 'canopy') {
        mode = 'flat';
        if (key !== 'decal') { tr = 1; tg = 1; tb = 1; }
      }
      // The range gets its own mode. It is 2000 triangles occupying the top
      // third of three published framings and it had NO material story at all:
      // measured local gradient 1.82-1.90 against 1.54 for empty sky, i.e. a
      // single-hue silhouette. A vertex pass is free here and can give it the
      // three things a range at 400 m actually shows - a sun/anti-sun split
      // across the spurs, a value break between them, and a talus/vegetation
      // band in the lower third.
      if (key === 'ridge') { mode = 'ridge'; tr = 1; tg = 1; tb = 1; }

      // ---- BACK TO THE AIRFRAME'S OWN AXES ---------------------------------
      // mergeAll bakes every entry into world space, so by the time this pass
      // runs a fuselage lying at yaw PI at x = 16 has no local coordinate left
      // to band against - and "which barrel section is this vertex on" is a
      // LOCAL question. The entry still carries the matrix it was merged with,
      // so one inversion per entry (a few thousand in the whole level, against
      // 300k vertices) buys the station grid back.
      var hasLocal = false;
      if (mode === 'skin' && ent.matrix) {
        try { _pinv.copy(ent.matrix).invert(); hasLocal = true; }
        catch (eInv) { hasLocal = false; }
      }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var ny = na[j + 1];
        var r, g, b;

        if (mode === 'ground') {
          // -----------------------------------------------------------------
          // R: everything that has settled on the slab - TWO ACCUMULATORS.
          //
          // There used to be one, and one global cap on it. Six independent
          // terms - blown sand, the taxi lane wash, tyre ribbons, exhaust
          // soot, the crack halo and the joint dip - all stacked into a single
          // `1 - min(saturate(dust), 0.45) * 0.70`, so the DARKEST value
          // anywhere on 204 x 168 m of concrete was 0.685, every term
          // saturated against the same ceiling, and a rubber ribbon, a soot
          // fan and a drift of blown sand printed as the identical grey. That
          // is why the foreground of the signature frame was a uniform stipple
          // with no story on it: real tyre deposit is 3-5x darker than clean
          // slab, not 1.45x.
          //
          // The cap was added for a real reason - the whole near apron had
          // gone to a dead 0.30 multiplier and read as damp asphalt in brutal
          // sun - but a GLOBAL cap was the wrong instrument. So:
          //
          //   BROAD   sand, the lane wash, the crack halo. Capped hard at 0.18
          //           with a 0.72 multiplier, so the wide wash can never take
          //           the foreground below ~0.87 and the apron stays a sunlit
          //           apron.
          //   NARROW  tyre ribbons, soot fans, joints. These are the marks
          //           that carry the yard's history and they are supposed to
          //           be black: capped at 0.55 with a 0.75 multiplier, so a
          //           ribbon reaches ~0.35 and a soot fan ~0.45 of albedo.
          //
          // The two multiply, so a soot fan crossing a sand drift is darker
          // than either - which is also true.
          // -----------------------------------------------------------------
          var broad = sandCover(x, z, noise) * 0.46;
          var lane = 1 - M.saturate(Math.abs(x) / TAXI_HALF);
          broad += lane * lane * 0.06;
          // tyre tracks: two narrow bands either side of the centreline, and
          // they WANDER, because a tug driver does not drive a ruled line
          var narrow = 0;
          var wob = Math.sin(z * 0.045) * 1.4 + Math.sin(z * 0.017 + 2.1) * 2.2;
          var tt = Math.min(Math.abs(x - 3.6 - wob), Math.abs(x + 3.6 - wob));
          if (tt < 0.52) narrow += (1 - tt / 0.52) * 0.90;
          else if (tt < 1.6) narrow += (1 - (tt - 0.52) / 1.08) * 0.16;
          // a second, older pair further out: the towing line into the west
          // field, half-faded, so the slab has two generations of traffic
          var t2 = Math.min(Math.abs(x + 8.3 + wob * 0.6), Math.abs(x - 9.1 + wob * 0.6));
          if (t2 < 0.44) narrow += (1 - t2 / 0.44) * 0.34;
          // soot fans behind every parked jet pipe
          var soot = 0;
          for (var si = 0; si < ROWS_X.length; si++) {
            if (Math.abs(x - ROWS_X[si]) > 3.2) continue;
            for (var sj = 0; sj < ROW_BAYS.length; sj++) {
              var dz2 = z - (ROW_BAYS[sj] - 8.4);
              if (dz2 > -4.5 && dz2 < 1.0) {
                soot = Math.max(soot, (1 - Math.abs(dz2 + 1.8) / 3.0) *
                  (1 - Math.abs(x - ROWS_X[si]) / 3.2));
              }
            }
          }
          narrow += M.saturate(soot) * 0.46;
          // ---- THE WEST FIELD'S CIRCULATION ---------------------------------
          // Every airframe in the storage rows was towed in along its own row,
          // and thirty years of that leaves a broad rubbered lane up each one
          // with a drip stain at each bay. From the tower these four lanes ARE
          // the yard's circulation diagram, and they are most of what stops
          // 200 m of slab reading as one sheet in the establishing frame -
          // which is the frame the critique called the worst in the set.
          //
          // Deliberately 1.6 m half-width, not the 0.4 m a real tyre track is:
          // the pad carries this colour on a 1.5 m vertex grid, so anything
          // narrower than about three metres cannot be resolved and comes back
          // as the field of soft blobs an earlier pass was rejected for. A
          // TOW LANE genuinely is that wide; a tyre track is not, and the
          // narrow ones live on the taxiway where the eye is close enough for
          // the painted overlay to carry them.
          var mark = 0, ri, bj;
          if (z > ROW_BAYS[0] - 14 && z < ROW_BAYS[ROW_BAYS.length - 1] + 14) {
            var rw = Math.sin(z * 0.031 + 1.3) * 1.1 + Math.sin(z * 0.011 - 0.4) * 0.8;
            for (ri = 0; ri < ROWS_X.length; ri++) {
              var trk = Math.abs(x - ROWS_X[ri] - rw);
              if (trk < 1.6) mark = Math.max(mark, (1 - trk / 1.6) * 0.34);
            }
          }
          // and the stain every parked airframe leaves under its wing box
          for (ri = 0; ri < ROWS_X.length; ri++) {
            if (Math.abs(x - ROWS_X[ri]) > 4.2) continue;
            for (bj = 0; bj < ROW_BAYS.length; bj++) {
              var ddz = (z - ROW_BAYS[bj] - 1.2) / 2.6;
              if (ddz < -1 || ddz > 1) continue;
              var ddx = (x - ROWS_X[ri]) / 3.0;
              var dr2 = Math.sqrt(ddx * ddx + ddz * ddz);
              if (dr2 < 1) mark = Math.max(mark, (1 - dr2) * 0.42);
            }
          }
          narrow += mark;
          // hydraulic/fuel halos: a hard dark core round each of the four
          // spills below, which is what a twenty-year-old drip pan leaves
          var halo = 0;
          // The crack field is now PAINTED at its real 1 cm width by the pad
          // overlay, so the vertex pass only carries the broad dirt halo round
          // it - at 0.42 on a 1.5 m grid it was a field of soft blobs standing
          // in for cracks it could never resolve.
          var cr = crackField(x, z, noise);
          broad += cr * 0.16;
          narrow += jointDip(x, z) * 6.0;
          // ---- G: dry, except where something has leaked --------------------
          g = 1.0;
          for (var pi = 0; pi < spills.length; pi++) {
            var sp = spills[pi];
            var sd2 = Math.sqrt((x - sp[0]) * (x - sp[0]) + (z - sp[1]) * (z - sp[1]));
            if (sd2 < sp[2]) {
              g = Math.min(g, M.lerp(0.30, 1.0, sd2 / sp[2]));
              // the stain is DARK as well as wet: a soaked halo with a near
              // black core, which is what the narrow accumulator is for
              halo = Math.max(halo, 1 - sd2 / sp[2]);
            }
          }
          narrow += halo * halo * 0.85;
          // and a slow low-frequency variation so 200 m of slab is not one
          // value. It rides the BROAD term, not the output, so it cannot lift
          // a rubber ribbon back out of the black.
          broad += noise.fbm2(x * 0.028 + 40, z * 0.028 - 17, 3) * -0.10;
          // 1.18, not 0.75: the wear shader's R channel is not a plain albedo
          // multiply - it is `mix(albedo, grimeColour, (1-R)*0.88)` followed by
          // a 0.70 darken - so the number that lands a rubber ribbon at the 3-5x
          // contrast a real one has is the one that takes R to ~0.35, and 0.55 x
          // 0.75 only reaches 0.59. Broad stays gentle, narrow goes properly
          // black.
          r = (1 - Math.min(M.saturate(broad), 0.18) * 0.72) *
              (1 - Math.min(M.saturate(narrow), 0.55) * 1.18);
          // ---- B: chipped arrises and spalled crack edges --------------------
          b = 1 - M.saturate(cr * 0.40 + jointDip(x, z) * 5.0) * 0.55;
          b = M.saturate(b + noise.fbm2(x * 0.028 + 40, z * 0.028 - 17, 3) * 0.05);
        } else if (mode === 'sand') {
          // Desert pavement is NOT one tone. Between the pad and the range there
          // is 200 m of open ground in every wide framing, and at the first pass
          // it carried a 22% fbm ripple and read as a sheet of blank paper.
          // Creosote grows on a worley lattice at roughly 4 m spacing (they
          // poison each other's roots - the spacing is genuinely regular), the
          // washes between the hummocks are darker gravel, and the sun-facing
          // sand between them is the palest thing in the level.
          var dn = noise.fbm2(x * 0.09 + 5, z * 0.09 - 3, 3) * 0.5 + 0.5;
          var bush = noise.worley2(x * 0.24 + 17, z * 0.24 - 5, 0.95);
          var clump = bush.f1 < 0.42 ? (1 - bush.f1 / 0.42) : 0;
          var wash = noise.fbm2(x * 0.031 - 21, z * 0.031 + 13, 4);
          var dark = M.saturate(clump * 0.80 + M.saturate(-wash * 1.6) * 0.35);
          r = 1 - dn * 0.20 - dark * 0.46;
          g = 1.0;
          b = 1 - (1 - dn) * 0.16 - dark * 0.18;
        } else if (mode === 'floor') {
          // ---- inside the shed ----------------------------------------------
          // Deliberately a DIFFERENT recipe from the apron rather than the same
          // one with a paler target: what a swept hangar floor carries is not
          // blown sand and rubber, it is tyre scuff down the door axis, oil
          // under wherever an airframe has stood on jacks, and the saw-cut
          // grid. Total range is a third of the apron's, which is what "under a
          // roof for forty years" looks like.
          var fw = M.saturate(1 - Math.abs(z - (HG_DOOR_Z0 + HG_DOOR_Z1) * 0.5) / 10.0) * 0.16;
          fw += jointDip(x, z) * 4.0;
          fw += (noise.fbm2(x * 0.11 + 13, z * 0.11 - 5, 3) * 0.5 + 0.5) * 0.14;
          g = 1.0;
          var fh = 0;
          for (var fi = 0; fi < spills.length; fi++) {
            var fs = spills[fi];
            var fd = Math.sqrt((x - fs[0]) * (x - fs[0]) + (z - fs[1]) * (z - fs[1]));
            if (fd < fs[2] * 1.6) {
              g = Math.min(g, M.lerp(0.34, 1.0, fd / (fs[2] * 1.6)));
              fh = Math.max(fh, 1 - fd / (fs[2] * 1.6));
            }
          }
          fw += fh * fh * 0.55;
          r = 1 - M.saturate(fw) * 0.52;
          b = 1 - M.saturate(jointDip(x, z) * 5.0) * 0.42;
        } else if (mode === 'ridge') {
          // ---- the range ----------------------------------------------------
          // Deliberately a SMALL total range: a mountain at 400 m under a noon
          // sky is one value with a slow gradient, and the previous solve of
          // this material was argued out at length against exactly that. What
          // it lacked was any INTERNAL structure inside that value, which is a
          // different thing and is what this pass adds.
          // The AMPLITUDES here look large for something the material notes
          // insist must stay "one value with a slow gradient", and they are
          // sized against the haze rather than against the eye:
          // materials.distant() runs this proxy at 0.0034 extinction over
          // 430 m, so 77% of every pixel is fog and only 23% of any albedo
          // modulation survives to the frame. A +/-10% pass measured as +/-2%
          // on screen and moved the range's local gradient by 0.1. These
          // numbers are what +/-6% on screen costs.
          var nrx = na[j], nrz = na[j + 2];
          var shx = Math.sin(SUN_AZ), shz = -Math.cos(SUN_AZ);   // toward the key
          var face = M.saturate(0.5 + 0.5 * (nrx * shx + nrz * shz));
          var lit = 0.78 + 0.36 * face;
          // rock banding: a very low-frequency field so adjacent spurs are
          // different stone rather than the same wall painted once
          var bandv = noise.fbm2(x * 0.0055 + 12.0, z * 0.0055 - 4.0, 3) * 0.12;
          // talus fans and creosote in the lower third of the profile. 0.012 is
          // an 80 m feature: the range is sampled every 13 m round and has four
          // spans of height in it, so anything finer than that does not exist
          // in the mesh and simply aliases.
          var relH = M.saturate(y / 44.0);
          var tw = noise.worley2(x * 0.009 + 3.1, z * 0.009 - 7.4, 0.95);
          var veg = (1 - M.saturate(relH * 1.9)) *
            (tw.f1 < 0.50 ? (1 - tw.f1 / 0.50) : 0);
          var rf2 = lit + bandv - veg * 0.24;
          r = rf2 * (1 - veg * 0.07);
          g = rf2 * (1 + veg * 0.04);
          // the anti-sun flanks go cooler as well as darker, which is what
          // skylight-only illumination on rock actually does
          b = rf2 * (1 + (1 - face) * 0.09 + veg * 0.05);
        } else if (mode === 'gravel') {
          var gv = noise.fbm2(x * 0.22 - 8, z * 0.22 + 4, 3) * 0.5 + 0.5;
          r = 1 - gv * 0.30; g = 1.0; b = 1 - gv * 0.12;
        } else if (mode === 'wall') {
          var wg = M.saturate(1 - y / 1.4);
          r = 1 - wg * 0.35 - sandCover(x, z, noise) * 0.10;
          g = 1.0;
          b = 1 - M.saturate(ny > 0.5 ? 0.28 : 0.06);
        } else if (mode === 'line') {
          // Painted lines wear THROUGH where things drive over them, and the
          // wear exposes pale concrete, which is the B channel exactly.
          var w1 = noise.fbm2(x * 0.55 + 9, z * 0.55 - 4, 3) * 0.5 + 0.5;
          var lane2 = 1 - M.saturate(Math.abs(x) / (TAXI_HALF + 4));
          var worn = M.saturate(w1 * 0.85 + lane2 * 0.35);
          r = 1 - sandCover(x, z, noise) * 0.34;
          g = 1.0;
          b = 1 - worn * 0.62;
        } else if (mode === 'skin') {
          // ---- the aeroplane -------------------------------------------------
          // Panel-to-panel chalking. Aircraft skin is not one colour: adjacent
          // panels are different alloys, different ages and different repaints,
          // and it is precisely that patchwork - not a normal map - that makes a
          // 44 m aluminium tube read as a real one.
          var pan = noise.fbm2(x * 0.55 + z * 0.13 + 60, y * 1.7 - z * 0.42, 3);
          var chalk = 1 + pan * 0.048;
          // sun bleach on up-facing surfaces, grime on down-facing ones
          var upf = M.saturate(ny);
          var dnf = M.saturate(-ny);
          var lift = 1 + upf * 0.10 - dnf * 0.16;
          // hydraulic and exhaust streaking runs DOWN the sides
          var strk = noise.fbm2(x * 2.1 + z * 0.4, y * 0.16 - 3.0, 2) * 0.5 + 0.5;
          var flank = 1 - M.saturate(1 - Math.abs(ny)) * strk * 0.14;
          // and the lower fuselage picks up ground dust
          var lowY = M.saturate(1 - y / 2.4);
          var soil = 1 - lowY * 0.16;
          // ---- THE PANEL GRID ----------------------------------------------
          // The three things a real AMARG skin has that a lofted tube does
          // not, all keyed off the same station index so they line up:
          //   pv     adjacent barrel sections are different alloy, different
          //          age and different repaint - 6-10% apart, which is what
          //          the eye reads as "panels" at twenty metres and what makes
          //          a 44 m tube stop being one continuous value
          //   lapd   the joint line itself, a step darker
          //   strk   the run of dirt that weeps DOWN the flank below every
          //          joint, strongest on the vertical faces and absent on the
          //          crown, because that is where water and hydraulic fluid go
          var pv = 1, lapd = 1, strk2 = 1;
          if (hasLocal) {
            _plp.set(x, y, z).applyMatrix4(_pinv);
            // the LOCAL normal, which is the cheapest honest way to ask "where
            // round the barrel am I" without knowing the fuselage axis
            _pln.set(na[j], ny, na[j + 2]).transformDirection(_pinv);
            var stf = _plp.z / PANEL_PITCH;
            var stn = Math.floor(stf);
            var frac = stf - stn;
            // and the longitudinal strake: seven skin runs round the barrel,
            // so the panels form a GRID rather than a set of hoops
            var cf = (Math.atan2(_pln.x, _pln.y) + Math.PI) * (7 / (Math.PI * 2));
            var cin = Math.floor(cf);
            var cfr = cf - cin;
            pv = 0.938 + hash01(stn, cin, 3) * 0.128;
            var eg = Math.min(frac, 1 - frac);
            if (eg < 0.048) lapd = 1 - (1 - eg / 0.048) * 0.26;
            var cg = Math.min(cfr, 1 - cfr);
            if (cg < 0.030) lapd *= 1 - (1 - cg / 0.030) * 0.17;
            if (frac < 0.34) {
              strk2 = 1 - M.saturate(1 - frac / 0.34) *
                M.saturate(1 - Math.abs(ny)) *
                (0.07 + 0.16 * hash01(stn, cin, 5));
            }
          }
          var f = chalk * lift * flank * soil * pv * lapd * strk2 * dk;
          r = tr * f; g = tg * f * (1 - dnf * 0.02); b = tb * f * (1 + upf * 0.02);
        } else if (mode === 'wrap') {
          // white vinyl: dirty at the bottom, sun-yellowed on top
          var wl = M.saturate(1 - y / 3.0);
          var wn = noise.fbm2(x * 1.4 + 3, y * 1.4 + z * 0.5, 2) * 0.06;
          var wf = (1 - wl * 0.22 + wn) * dk;
          r = tr * wf; g = tg * wf * 0.995; b = tb * wf * (1 - M.saturate(ny) * 0.05);
        } else if (mode === 'clad') {
          // corrugated cladding: vertical streaks below every fixing, and a
          // strong horizontal band of dust along the bottom two metres
          var cl = M.saturate(1 - y / 2.6);
          var cs = noise.fbm2(x * 1.9 + z * 1.9, y * 0.10, 2) * 0.5 + 0.5;
          var cf = (1 - cl * 0.24 - cs * 0.10) * dk;
          r = tr * cf; g = tg * cf; b = tb * cf;
        } else if (mode === 'rust') {
          var rn = noise.fbm2(x * 0.9 + 12, y * 0.9 + z * 0.35, 3) * 0.5 + 0.5;
          var rf = (0.82 + rn * 0.34) * dk;
          r = tr * rf; g = tg * rf * (0.94 + rn * 0.06); b = tb * rf * (0.88 + rn * 0.10);
        } else if (mode === 'flat') {
          r = tr * dk; g = tg * dk; b = tb * dk;
        } else {
          // generic painted metal: a little dirt low down, a little variation
          var mn = noise.fbm2(x * 0.7 + 22, y * 0.7 - z * 0.3, 2) * 0.07;
          var ml = M.saturate(1 - y / 2.0);
          var mf = (1 + mn - ml * 0.18) * dk;
          r = tr * mf; g = tg * mf; b = tb * mf;
        }
        col[j] = M.clamp(r, 0, 2);
        col[j + 1] = M.clamp(g, 0, 2);
        col[j + 2] = M.clamp(b, 0, 2);
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ---- walkable surfaces --------------------------------------------------------
  LevelBoneyard.prototype.sampleGround = function (x, z) {
    if (x > HG_X0 + 0.4 && x < HG_X1 - 0.4 && z > HG_Z0 + 0.4 && z < HG_Z1 - 0.4) {
      return HG_FLOOR;
    }
    return groundY(x, z, this.noise);
  };

  LevelBoneyard.prototype._buildNav = function () {
    var cell = 1.0;
    var ox = PAD_X0 - 6, oz = PAD_Z0 - 6;
    var w = Math.ceil((PAD_X1 + 12 - ox) / cell);
    var h = Math.ceil((PAD_Z1 + 12 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      // conservative AABB: the aircraft colliders are rotated
      var min = new THREE.Vector3(), max = new THREE.Vector3();
      GAME.Collision.boxBounds(c, min, max);
      obst.push([min.x - 0.34, max.x + 0.34, min.z - 0.34, max.z + 0.34, min.y, max.y]);
    }
    var self = this;
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        if (x < PAD_X0 - 5 || x > PAD_X1 + 5 || z < PAD_Z0 - 5 || z > PAD_Z1 + 5) continue;
        var y = self.sampleGround(x, z);
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          // A WING IS NOT A WALL. Anything whose underside clears 1.85 m leaves
          // the cell walkable, which is what makes the shade under the airframes
          // ground the player and the AI can actually use.
          if (o[5] > y + 0.30 && o[4] < y + 1.85) { ok = 0; break; }
        }
        var idx = iz * w + ix;
        walkable[idx] = ok;
        height[idx] = y;
      }
    }
    this.navGrid = {
      origin: new THREE.Vector3(ox, 0, oz),
      cellSize: cell, w: w, h: h,
      walkable: walkable, height: height,
      at: function (px, pz) {
        var gx = Math.floor((px - ox) / cell), gz = Math.floor((pz - oz) / cell);
        if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
        return walkable[gz * w + gx];
      },
      heightAt: function (px, pz) {
        var gx = Math.floor((px - ox) / cell), gz = Math.floor((pz - oz) / cell);
        if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
        return height[gz * w + gx];
      }
    };
  };

  // ---------------------------------------------------------------------------
  // SPAWNS AND FRAMINGS
  //
  // Every pose is a position plus a LOOK-AT TARGET that is a real object in the
  // level, so a composition survives the geometry moving; and every one is
  // checked against the sun. The check is not decorative - at 30 degrees of
  // elevation and a 107-degree-wide frame the disc lands in shot for any heading
  // within ~55 degrees of bearing 319, and a clipping sun disc sets the
  // exposure for the entire yard.
  //
  //   pose            heading   sun off-axis   what the light is doing
  //   overview          22          63          raking, disc just outside frame
  //   hero1             46          87          cross-lit; camera stands in the
  //                                             port wing's cast shade
  //   hero2            243          76          cross-lit across four rows
  //   hero3            224          95          cross-lit, tail against the sky
  //   interior         144         175          the door beam lands on the far
  //                                             wall AHEAD of the camera
  // ---------------------------------------------------------------------------
  LevelBoneyard.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + 0.02, z), yaw: yaw
      });
    }
    // [0] is the player: the south end of taxiway Alpha, looking north up it
    // with Sierra Seven's nose 44 m away closing the view.
    sp(1.5, 62.0, 0);
    sp(-6.0, 44.0, 0.06);      sp(8.5, 30.0, -0.12);
    sp(-33.0, 22.0, 0.10);     sp(-51.0, -2.0, 1.55);
    sp(-69.0, -30.0, 0.05);    sp(-24.0, -44.0, 3.10);
    sp(20.0, -30.0, 2.40);     sp(30.0, 10.0, -1.60);
    sp(HG_X0 - 8.0, 47.0, 1.45);
    sp(HG_X0 + 8.0, 44.0, -1.50);
    sp(34.0, 52.0, 2.90);      sp(-84.0, 30.0, 1.20);
    sp(62.0, -30.0, 0.20);     sp(4.0, -70.0, 3.05);

    var V = THREE.Vector3;
    function pose(px, py, pz, tx, ty, tz) {
      var dx = tx - px, dy = ty - py, dz = tz - pz;
      var horiz = Math.sqrt(dx * dx + dz * dz);
      return {
        position: new V(px, py, pz),
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.max(1e-4, horiz))
      };
    }
    var A = this.anchors;
    var s7 = A.sierra7;
    var gy;

    // ---- OVERVIEW ------------------------------------------------------------
    // From the water tower catwalk, 19.6 m up, looking north-north-east across
    // the whole yard. The eye is ABOVE every airframe in the level, which for a
    // container terminal was a mistake (it photographed unlit roofs) and here is
    // the entire point: an aircraft seen from above is a WING PLAN, the most
    // recognisable shape in the level, and thirty-four of them in ruled rows is
    // what an aircraft boneyard looks like in every photograph ever taken of one.
    //
    // What fills the frame: the tower's own catwalk rail in the near foreground,
    // the four storage rows running away left, taxiway Alpha as the leading line
    // straight up the middle, Sierra Seven and the two other big airframes on the
    // right, the hangar behind them, and two ridge lines closing the top.
    var cw = A.waterTower.catwalk;
    var overview = pose(cw.x + 3.2, cw.y + 1.62, cw.z - 3.4,
      s7.centre.x, 5.0, s7.centre.z - 2.0);

    // ---- HERO 1 --------------------------------------------------------------
    // THE signature frame. The camera stands ON taxiway Alpha, INSIDE the shadow
    // Sierra Seven's port wing throws across it, and looks north-east along the
    // aircraft.
    //
    // Solved, not chosen. The wing sits at y 3.05 with its tip at x -6.5, so at
    // 30 degrees of elevation its shade covers a band from x 0 to x 45 centred
    // on z 2.3 (that is anchors.sierra7.shade, derived from shadeOffset, not
    // typed in). The eye stands in the near-left corner of it. From there:
    //
    //   * the outboard port nacelle is 9.5 m out at the left edge of frame and
    //     the inboard one 12 m out just left of centre - two hard dark masses
    //     inside 12 m, which is the foreground a 200 m flat yard cannot
    //     otherwise have
    //   * the wing itself crosses the top of frame at 25-30 degrees up
    //   * the port fuselage flank faces WEST, i.e. into the key, so it is the
    //     brightest thing in the level, and it sits directly above the shadow
    //     line on the concrete: maximum available contrast, in the middle third
    //   * the main gear bogie is 14 m out, dead centre, in shade
    //   * the T-tail is 36 m out at 21 degrees left, against open sky
    //   * behind and beyond, the east rows and the hangar
    // ------------------------------------------------------------------------
    // The eye stands 13.5 m out along the port wing and 9.2 m SOUTH of where
    // that station's shadow ends. Standing IN the shadow was tried first and is
    // wrong twice over: at 30 degrees the ribbon is only 3-5 m deep, so an eye
    // inside it is 4 m from a nacelle and cannot get both engines in a frame at
    // once; and a camera inside a shadow photographs the shadow as an absence.
    // Nine metres back it becomes an OBJECT - a hard-edged black diagonal
    // running across the middle of the frame with the sunlit slab either side
    // of it, which is the single strongest thing an overhead sun can give you
    // and precisely what the brief's "short hard shadows" means.
    //
    // What is in shot from here (all solved, none guessed):
    //   * the taxiway centreline 2.5 m to the left, running to the vanishing
    //     point - the leading line
    //   * the wing shadow's edge cutting the slab at 9-14 m
    //   * both port nacelles at 8 and 12 m, 24 degrees apart, dark against the
    //     lit ground under them
    //   * the port wing crossing the upper third at 16-22 degrees of elevation
    //   * the sunlit port flank of the fuselage - the frame's highlight anchor -
    //     directly above the shadow line, 17 m out
    //   * the T-tail at 30 m and 24 degrees up, against open sky
    //   * a maintenance stand in the shade beside the fuselage for mid-ground
    // ------------------------------------------------------------------------
    // ------------------------------------------------------------------------
    // RE-SOLVED, because the first solve did not photograph.
    //
    // What it produced: the horizon on the vertical centreline, the left half
    // three stacked grey bands (sky at 0.005 local sd, ridge, apron) with no
    // vertical and no mid-ground mass, the reticle on empty concrete, both
    // nacelles illegible, and the wing shadow reading as an isolated black
    // rectangle with no visible caster. Cell-mean range 3.5x against the
    // shipped market street's 10.6x.
    //
    // The diagnosis was standpoint, not aim. From 13.5 m out along the wing the
    // whole aeroplane subtends about 50 degrees at 22-27 m, so it sits in the
    // middle of the frame and nothing can fill the outer thirds - there is
    // simply no other object within 60 m of that spot.
    //
    // So the eye moves to the PORT WING TIP - one metre outboard of it, on the
    // sunlit slab south of the shade ribbon - and turns to look back along the
    // wing toward the root. That single move fixes all four complaints at once,
    // and every number below is derived from the wing recipe rather than typed:
    //
    //   LEFT THIRD    the port outboard nacelle, 12 m out and 2.6 m above the
    //                 eye: a hard dark mass closing the side, with the T-tail
    //                 at 29 m above it and the hulk row at 69 m directly behind
    //                 it, so the third has three depths in it
    //   CENTRE        the inboard nacelle, the main bogie and the maintenance
    //                 stand at 15-22 m, and the wing's own shadow edge crossing
    //                 the slab at 8-14 m with the wing that casts it visibly
    //                 above it in the same frame
    //   RIGHT THIRD   the sunlit port fuselage flank running away to the nose -
    //                 the frame's highlight anchor, sitting directly over the
    //                 shadow line
    //   HORIZON       pitch +11 degrees puts it 64% down the frame, so the fin
    //                 and the wing get open sky to sit against
    //   FOREGROUND    x = -5.6 is four metres clear of the nearer wandering
    //                 tyre track, so the bottom of the frame is pale slab and
    //                 the shadow can be black against it
    //   SUN           heading 073, key at 319: 114 degrees off axis, the widest
    //                 separation of any pose in the set
    // ------------------------------------------------------------------------
    // The standpoint's z is DERIVED from the shade ribbon, not typed. It used
    // to be `s7.centre.z + 7.0`, a number remembered from a solve made at a
    // sun elevation the level no longer runs at - so every degree the key
    // moved slid the shadow out of the frame it was composed for while the
    // camera stayed put. What the composition actually wants is "eight metres
    // south of where the mid-span station's shade ends", which is exactly what
    // shade.at() returns. At any elevation the shadow edge now crosses the
    // slab at the same place in frame.
    var s7semi = s7.shade.semiSpan;
    var ex = s7.centre.x - (s7semi + 0.5);
    // at() undoes the shadow offset internally, so hand it the world x that
    // maps back to the half-span station.
    var midBand = s7.shade.at(s7.centre.x - s7semi * 0.5 + s7.shade.offset.x);
    var ez = (midBand ? midBand.z0 : s7.centre.z - 5.2) + 8.2;
    gy = this.sampleGround(ex, ez);
    var hero1 = pose(ex, gy + 1.66, ez,
      s7.centre.x - TYPES.transport4.r * 1.06, s7.wingY - 0.15,
      s7.centre.z - TYPES.transport4.wing.rootZ - 1.0);

    // ---- HERO 2 --------------------------------------------------------------
    // A DIFFERENT SPACE AND A DIFFERENT DEPTH, which is what the roster asks
    // for and what the first attempt did not deliver: that one stood in the
    // storage field looking across the rows, which is the same subject as hero1
    // (a parked aeroplane, cross-lit, at 15-60 m) from a different angle, and it
    // came back 45% featureless slab and 30% sky.
    //
    // The parts yard is the other half of what a boneyard IS - it is a salvage
    // depot with aeroplanes attached - and it is the only close-range, high-
    // density, warm-metal space in the level. Standing at its south-west corner:
    //   * a wing rack 8.5 m out on the right, three wings deep, as foreground
    //   * two more racks at 20 and 32 m, so the same object gives three scales
    //   * eight engine pods in cradles filling the middle ground
    //   * the fin stillage on the right edge
    //   * the hangar's open door 29 m out at 21 degrees right - a dark rectangle
    //     with a lit interior, which is the only deep black in a noon frame
    //   * Sierra Seven's tail 90 m away on the left, tying it back to hero1
    // Key 87 degrees off the axis: everything is cross-lit and every rack throws
    // its own shadow into the frame.
    // Twelve metres off the near rack, not six: a wing rack is 8.6 m wide and
    // 2.9 m tall, so at six metres its top shelf passes straight over the eye and
    // the frame becomes the underside of a wing with a forest of angle iron under
    // it. Twelve metres puts the same rack across the lower right as a foreground
    // MASS, with the second and third racks stepping away behind it.
    gy = this.sampleGround(19.5, 67.0);
    var hero2 = pose(19.5, gy + 1.66, 67.0, 36.5, 4.2, 41.0);

    // ---- HERO 3 --------------------------------------------------------------
    // Verticality: 15.7 m of T-tail against an open noon sky, from 14 m away and
    // pitched up 25 degrees.
    //
    // WEST of the fin, not east. The fin is a vertical surface whose faces point
    // along +/-X and the key has a -0.571 x-component, so the WEST face is the
    // lit one and the east face is in its own shadow all day. The first solve
    // stood north-east of the tail and photographed the shaded face: a flat
    // grey cut-out against a bright sky, i.e. the "no readable subject" failure
    // wearing a dramatic angle. Twelve metres west and eight south, the same
    // fin is a lit blade with its own cast shadow running back toward the lens,
    // the rear fuselage sweeps up into it from the lower right, and the frame
    // still holds a third of ground - the tailplane, the gear, the stand and the
    // rows beyond - instead of being all sky.
    gy = this.sampleGround(4.0, -16.0);
    var hero3 = pose(4.0, gy + 1.66, -16.0, 15.4, 6.6, -25.0);

    // ---- INTERIOR ------------------------------------------------------------
    // Inside the hangar, in the north-west corner, looking south-east. The door
    // is BEHIND the camera, which is the whole design: the beam comes over the
    // shoulder, lands as a hard wedge on the floor and the south wall ahead, and
    // the stripped fighter on jacks stands in the middle of it. Sightline runs
    // 27 m diagonally across the shed so the roof trusses and the three monitor
    // shafts are all in shot, and the near-left is the gantry column.
    // Eight metres in from the west wall and seven from the north one, NOT the
    // five-and-five it started at. From a corner both walls are grazed at 5 m and
    // a 32 m corrugated shed wall viewed at 8 degrees of incidence collapses into
    // a dark converging wedge with a specular streak down it - it read as some
    // large unidentifiable horn filling the left edge of the frame. Three metres
    // of standoff turns the same wall back into a wall.
    var interior = pose(HG_X0 + 8.0, HG_FLOOR + 1.66, HG_Z0 + 7.0,
      HG_X0 + 24.0, HG_FLOOR + 3.2, HG_Z1 - 4.0);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior
    };
  };

  // ---- broadphase + raycast -----------------------------------------------------
  LevelBoneyard.prototype._buildBroadphase = function () {
    var min = new THREE.Vector3(), max = new THREE.Vector3();
    this._hash.clear();
    for (var i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      c._id = i;
      c._stamp = -1;
      GAME.Collision.boxBounds(c, min, max);
      this._hash.insert(c, min, max);
    }
  };

  var _rcDir = new THREE.Vector3();
  var _rcHit = { point: new THREE.Vector3(), normal: new THREE.Vector3() };

  LevelBoneyard.prototype.raycast = function (origin, dir, maxDist) {
    var out = {
      hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      material: null, distance: maxDist === undefined ? Infinity : maxDist, collider: null
    };
    if (!origin || !dir) return out;
    maxDist = (maxDist === undefined || maxDist <= 0) ? 400 : maxDist;
    out.distance = maxDist;
    var d = _rcDir.copy(dir);
    var dl = d.length();
    if (dl < 1e-9) return out;
    d.multiplyScalar(1 / dl);

    var cell = this._hash.cell;
    var stamp = ++this._stamp;
    var ix = Math.floor(origin.x / cell), iy = Math.floor(origin.y / cell), iz = Math.floor(origin.z / cell);
    var sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    var ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    var tdx = ax > 1e-9 ? cell / ax : Infinity;
    var tdy = ay > 1e-9 ? cell / ay : Infinity;
    var tdz = az > 1e-9 ? cell / az : Infinity;
    var tmx = ax > 1e-9 ? ((d.x > 0 ? (ix + 1) * cell - origin.x : origin.x - ix * cell) / ax) : Infinity;
    var tmy = ay > 1e-9 ? ((d.y > 0 ? (iy + 1) * cell - origin.y : origin.y - iy * cell) / ay) : Infinity;
    var tmz = az > 1e-9 ? ((d.z > 0 ? (iz + 1) * cell - origin.z : origin.z - iz * cell) / az) : Infinity;

    var best = maxDist, bestC = null;
    var map = this._hash.map, keyOf = this._hash._key;
    var guard = 0;
    var t = 0;
    while (t <= maxDist && guard++ < 1200) {
      var bucket = map.get(keyOf.call(this._hash, ix, iy, iz));
      if (bucket) {
        for (var i = 0; i < bucket.length; i++) {
          var c = bucket[i];
          if (c._stamp === stamp) continue;
          c._stamp = stamp;
          var hitT = GAME.Collision.raycastBox(origin, d, c, _rcHit);
          if (hitT >= 0 && hitT < best) {
            best = hitT; bestC = c;
            out.point.copy(_rcHit.point);
            out.normal.copy(_rcHit.normal);
          }
        }
      }
      var tNext = Math.min(tmx, Math.min(tmy, tmz));
      if (bestC && best <= tNext) break;
      t = tNext;
      if (tmx <= tmy && tmx <= tmz) { ix += sx; tmx += tdx; }
      else if (tmy <= tmz) { iy += sy; tmy += tdy; }
      else { iz += sz; tmz += tdz; }
      if (!isFinite(t)) break;
    }
    if (bestC) {
      out.hit = true;
      out.distance = best;
      out.collider = bestC;
      out.material = bestC.material;
    }
    return out;
  };

  // ---- per frame ------------------------------------------------------------------
  // The yard is static concrete and dead aeroplanes; the only things alive in it
  // are the wind and the sun. Two jobs:
  //
  //   1. RE-SOLVE THE SHADE. Every shade zone was derived at construction time
  //      from the authored sun. main.js applies the level's env profile AFTER
  //      the level builds, so the real key is not known until the first frame -
  //      and a consumer reading anchors.shadeZones deserves the real one.
  //   2. Move the two things that should move. A windsock and the loose corner
  //      of a spraylat sheet, both driven off the same wind vector, because a
  //      frame in which literally nothing moves reads as a photograph of a model.
  LevelBoneyard.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);

    // ---- THE AIR --------------------------------------------------------
    // sky.js's authored base fog is 0.0150/m with a 5.5 m e-folding height,
    // which is written for a dusty street where the far end of the shot is
    // 60 m away. This yard is 200 m across and its whole subject is DEPTH -
    // four rows of aircraft receding, a hangar at 90 m, a range at 430 - and at
    // that density the third row and everything past it came back as a flat
    // white wall. The transports at 90 m in the hero framing had no contrast
    // left at all.
    //
    // What a desert at noon actually has is not less haze but a DIFFERENT haze:
    // a shallow, hot, low-lying shimmer layer over the tarmac and clean air
    // above it. So the density comes down by well over half and the e-folding
    // height comes down with it, which keeps the shimmer clinging to the slab -
    // where the brief wants it - while letting the airframes above 3 m read.
    //
    // setFog is a documented public API and this call is made only from THIS
    // level's update, so no other level's air can move.
    if (!this._fogSet && ctx && ctx.sky && typeof ctx.sky.setFog === 'function') {
      this._fogSet = true;
      try {
        // heightScale 15, not 3.2. A 3.2 m e-folding height keeps the haze
        // clinging to the tarmac, which is what a heat shimmer does - but it
        // also means the ESTABLISHING eye, 22 m up on the water tower, spends
        // its entire sightline above the layer and gets no aerial perspective
        // at all. The same 430 m range measured 0.153 linear from the 1.66 m
        // hero3 eye and 0.0376 from the tower: a nine-fold inconsistency in
        // the one cue that tells the audience the yard is 200 m across.
        // Density comes down to keep the near-field air where it was.
        // heightScale 30, and the last number in this level to be argued out
        // rather than measured. At 15 m the haze column still ended below the
        // range's own crest - exp(-96/15) is 0.0016 - so the tops of the
        // mountains got no aerial perspective at all and their sun-facing
        // spurs printed as hard pale patches against their shaded ones: the
        // "cream blotches that read as snow" and a straight palette collision
        // with snowbound. A desert haze column is tens of metres deep, not
        // three; at 30 m the crests finally sit inside it and the range
        // compresses to one value with a gradient, which is what it is.
        // density 0.0034, down from 0.0046, and it is a FIGURE/GROUND number
        // rather than an atmosphere one. At 0.0046 the mid-field of the
        // establishing frame - the four storage rows at 80-130 m, which is the
        // whole subject of that shot - was mixed 34% into the fog colour, and
        // 34% of anything is enough to close a 1.5:1 albedo separation down to
        // 1.1:1. That is most of why the overview photographed as a white mush
        // of identical shapes even after the slab and the airframes were pulled
        // a stop apart. A desert at noon has 40-80 km of visibility; what it
        // genuinely has near the ground is the shallow hot shimmer this height
        // scale models, not a 200 m veil. The ridge is unaffected either way -
        // materials.distant() carries its own 0.0034 extinction.
        // density 0.0022, down again from 0.0034, and this one is measured as
        // the SECOND of the two additive terms that were flattening the far
        // field. A/B on the establishing frame with the fog effectively off
        // (0.0004) and everything else held moved flat_area_pct 55.63 -> 44.00
        // and edge_energy 0.0757 -> 0.0856 on its own - a third of the mirage's
        // effect, but the same sign and on the same pixels, and the two
        // multiply. 0.0022 is a 35 % cut rather than a rout, because the fog is
        // also what keeps the 322-596 m range sitting inside the air instead of
        // standing on top of it, and materials.distant() carries the range's own
        // 0.0034 extinction independently of this number.
        ctx.sky.setFog({
          density: 0.0022, heightScale: 30.0, startDistance: 8.0,
          desaturate: 0.12, mieG: 0.58
        });
      } catch (e) { GAME.logError('boneyard.fog', e); }
    }

    // ---- THE CASCADE ----------------------------------------------------
    // 82 m of default shadow distance in a yard that is 204 x 168 m with an
    // establishing eye 22 m up. Everything past 82 m cast NOTHING, so the one
    // gift a hard noon sun gives this level - thirty-four aeroplane shadows
    // raking across pale hardstanding - was switched off across most of the
    // frame it matters in, and the yard band of the overview measured
    // 0.507-0.573 mean across all six columns: exactly the flat, white,
    // contrastless frame the brief names as the trap.
    if (!this._shadowSet && ctx && ctx.lighting &&
        typeof ctx.lighting.setShadowDistance === 'function') {
      this._shadowSet = true;
      try { ctx.lighting.setShadowDistance(210); }
      catch (e) { GAME.logError('boneyard.shadowdist', e); }
    }

    // ---- THE KEY --------------------------------------------------------
    // Ask sky.js for the arc this level is drawn against, once, before the
    // shade record below is re-solved off the answer. setSolarArc is the same
    // public, per-instance, idempotent API main.js's env profile calls; making
    // the request here rather than trusting the profile is what stops SUN_EL
    // and the real key drifting apart again (see the SUN_EL header). If the
    // profile already asked for this figure the call returns immediately.
    if (!this._arcSet && ctx && ctx.sky && typeof ctx.sky.setSolarArc === 'function') {
      this._arcSet = true;
      try { ctx.sky.setSolarArc(SUN_EL_DEG); }
      catch (e) { GAME.logError('boneyard.solararc', e); }
    }

    if (!this._sunChecked && ctx && ctx.sky && ctx.sky.sunDirection) {
      var sd = ctx.sky.sunDirection;
      if (isFinite(sd.y) && sd.y > 0.05) {
        this._sunChecked = true;
        var el = Math.asin(M.clamp(sd.y, -1, 1));
        var run = 1 / Math.tan(Math.max(0.12, el));
        var hl = Math.sqrt(sd.x * sd.x + sd.z * sd.z) || 1;
        var ox = -sd.x / hl, oz = -sd.z / hl;
        var Z = this.shadeZones;
        for (var i = 0; i < Z.length; i++) {
          var zz = Z[i];
          var old = shadeOffset(zz.depth);
          var nx = ox * run * zz.depth, nz = oz * run * zz.depth;
          zz.x0 += nx - old.x; zz.x1 += nx - old.x;
          zz.z0 += nz - old.z; zz.z1 += nz - old.z;
          zz.centre.x += nx - old.x; zz.centre.z += nz - old.z;
        }
        this.anchors.yard.sunElevation = el;
        // and re-aim the slab bounce off the REAL key rather than the authored
        // one, so the fill can never end up on the same side as the sun
        try { this._aimBounce(Math.atan2(sd.x, -sd.z), el); }
        catch (e2) { GAME.logError('boneyard.bounce', e2); }
      }
    }

    if (!this._movers.length) return;
    var wind = 5.0, wdx = 0.66, wdz = 0.75;
    try {
      if (ctx && ctx.weather) {
        if (isFinite(ctx.weather.windSpeed)) wind = ctx.weather.windSpeed;
        if (ctx.weather.windDir && isFinite(ctx.weather.windDir.x)) {
          wdx = ctx.weather.windDir.x; wdz = ctx.weather.windDir.y;
        }
      }
    } catch (e) { /* the desert breeze is fine */ }
    var wl = Math.sqrt(wdx * wdx + wdz * wdz) || 1;
    var yaw = Math.atan2(wdx / wl, wdz / wl);
    var gust = Math.sin(this._t * 0.9) * 0.22 + Math.sin(this._t * 2.3 + 1.1) * 0.09;
    for (var k = 0; k < this._movers.length; k++) {
      var m = this._movers[k];
      if (m.kind === 'sock') {
        m.obj.rotation.y = yaw + gust * 0.8;
        m.obj.rotation.x = -0.30 - M.saturate(wind / 12) * 0.45 + gust * 0.10;
      } else if (m.kind === 'flap') {
        m.obj.rotation.x = m.base + Math.sin(this._t * 3.1 + m.phase) * 0.26 * (0.4 + M.saturate(wind / 10));
        m.obj.rotation.z = Math.sin(this._t * 2.2 + m.phase * 1.7) * 0.14;
      }
    }
  };

  GAME.LevelBoneyard = LevelBoneyard;
})(window.GAME, window.THREE);
