// ============================================================================
// OPERATION BLACKOUT - src/world/level_refinery.js  ->  GAME.LevelRefinery
//
// "ZUBAIR REFINERY": a working petrochemical plant at dusk. Distillation
// columns, pipe racks, catwalks, storage tanks and a flare stack throwing real
// moving firelight over the whole site.
//
// The one idea the level is built around: COMPLEX INDUSTRIAL SILHOUETTE
// AGAINST A DUSK SKY, LIT BY ORANGE FIRE FROM ABOVE AND COLD FLOODS FROM
// BELOW. Every decision below serves that sentence and nothing else.
//
// ---------------------------------------------------------------------------
// THE PLAN, in world coordinates. +X east, -Z north, y = 0 is the datum of the
// main hardstanding (which falls ~0.45 m to the south over 190 m).
//
//   x -96..96 , z -104..88            the site
//   x -78..78 , z  -94..76            paved hardstanding; gravel beyond
//   x -7.6..7.6                       MAIN PROCESS ROAD, runs the whole site
//                                     north-south. It is the level's spine and
//                                     the leading line of hero1.
//   z 13..22                          cross road, x -66..66. Breaks the spine
//                                     into a near half and a far half.
//   x -15 (+/- 4.3), z -96..26        WEST PIPE RACK. 22 bents, three tiers at
//                                     4.7 / 7.5 / 10.2 m, walkway on top at
//                                     10.9 m. The longest object in the level.
//   x 14.5 (+/- 3.4), z -74..8        EAST PIPE RACK, two tiers, serves the
//                                     column row.
//   z -58 / -26 / 6                   three PIPE BRIDGES crossing the road
//                                     overhead. They are what turns a straight
//                                     road into a receding tunnel.
//   x 20..34, z -52..6                UNIT 200 plinth: four distillation
//                                     columns, 41 / 32 / 25 / 18.5 m, with
//                                     platform rings, cage ladders and two
//                                     interconnecting catwalks at 14 and 23 m.
//   x 42..62, z -36..-14              fired heater + 26 m refractory stack.
//   x 32..48, z -88..-72              THE FLARE. A 46 m stack in a three-leg
//                                     lattice derrick, burning.
//   x -70..-30, z -66..-26 / -24..10  bunded tank farm, two 29 m floating-roof
//   x -70..-44, z  26..48             tanks and one 20 m product tank.
//   x -38..-16, z  30..45             PUMP HOUSE. The enterable interior.
//   x  33..55, z  21..39              control building, lit windows.
//   x -47..-17, z -101..-83           induced-draught cooling tower bank.
//
// ---------------------------------------------------------------------------
// WHY THE LIGHT WORKS THE WAY IT DOES  (read before moving a lamp)
//
// main.js pins this level at timeOfDay 0.88. sky.js's _solar puts that 6.8
// degrees BELOW the horizon: past the civil-twilight window, so the direct key
// collapses and sky.js hands the key over to the moon at ~0.31, which rig
// 'mixed' then trims to 0.19. In other words THE SKY LIGHTS ALMOST NOTHING.
// That is not a problem to be worked around, it is the brief: at this hour a
// refinery is lit by its own plant, and the sky is there to be silhouetted
// against.
//
// So the level publishes 24 practicals - the cap - and they are designed as
// three families that never overlap in colour:
//
//   FIRE FROM ABOVE.  The flare tip sits 50 m up and carries 4400 cd at
//     1900 K with kind 'fire', so lighting.js gives it noise-driven flicker
//     and a colour that tracks its own intensity. At 50 m that is 1.8 lux
//     straight down and still 0.35 lux at the far end of the site - a warm,
//     moving, SITE-WIDE key arriving from overhead. It is the single most
//     important light in the level and it is the reason nothing here is black.
//
//   SODIUM FROM THE MASTS.  Four 13.2 m high masts down the road at 1950 K.
//     ~4.5 lux in the pool under each, staggered left/right so the road reads
//     as alternating amber pools rather than a wash.
//
//   COLD FLOODS FROM BELOW.  Mercury-vapour units at 5600 K on the unit
//     plinths, the rack legs and the bund walls, aimed UP at the columns and
//     ACROSS the tank shells. These are what model the silhouettes, and their
//     blue-white against the flare's orange is exactly the split postfx's
//     'sodium' grade is built to print (highlight leg R/B 1.150/0.800 against
//     a 0.80/1.28 shadow leg).
//
// The 50:1 rule is held by arithmetic, not by hope: peak pool ~4.7 lux, and
// the flare alone puts 0.3-1.8 lux on every square metre of the site, so the
// darkest paved cell is about 15:1 below the brightest. Nothing in the level
// relies on ambient to be visible.
//
// ---------------------------------------------------------------------------
// THE PLACEMENT CONTRACT  -  `level.anchors`
//
// Everything props_refinery.js might want to stand something against is
// published BY NAME, available immediately after `new LevelRefinery()` - you
// do not have to wait for build().
//
//   anchors.site        { x0,x1,z0,z1, paveX0..paveZ1, groundY(x,z), onRoad(x,z) }
//   anchors.road        { x0,x1, z0,z1, centreX, cross:{z0,z1,x0,x1} }
//   anchors.racks       [ {name, x, halfW, z0, z1, pitch, tiers[], deckY, colX[]} ]
//   anchors.bridges     [ {z, y, x0, x1} ]
//   anchors.columns     [ {name, x, z, r, h, plinthY, platforms[], position} ]
//   anchors.catwalks    [ {y, from:Vector3, to:Vector3} ]
//   anchors.tanks       [ {name, centre, r, h, roofY, bund:{x0,x1,z0,z1,h,floorY},
//                          stairYaw, manwayPos} ]
//   anchors.flare       { base:Vector3, tipY, tipR, flame:Vector3, derrickR, padY }
//   anchors.heater      { centre, x0,x1,z0,z1, h, stack:{x,z,topY,r}, platformY }
//   anchors.pumpHouse   { centre, x0,x1,z0,z1, floorY, eaveY, ridgeY,
//                         door:{position,yaw,w,h}, bays[] }
//   anchors.control     { centre, x0,x1,z0,z1, h, door:{position,yaw} }
//   anchors.coolers     [ {centre, w, d, h, fanY} ]
//   anchors.gate        { position, yaw }
//   anchors.lamps       [ {name, kind, pos, aim} ]   mirrors practicalLights
//   anchors.spawn       { centre, yaw }
//   anchors.sun         { dir, azimuth }
//
//   DO NOT derive a world position from `level.cameraPoses`. A pose is a
//   COMPOSITION; it moves whenever the composition improves. The harbor build
//   lost a round to exactly that.
//
// Also published, both consumed generically by lighting.js:
//   level.practicalLights   full override of the built-in lamp table
//   level.lightShafts       the flare cone, the pump-house door, the heater
//   level.litWindows        the control building's glazing
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ------------------------------------------------------------------ site --
  var SITE_X0 = -96.0, SITE_X1 = 96.0;
  var SITE_Z0 = -104.0, SITE_Z1 = 88.0;
  var PAVE_X0 = -78.0, PAVE_X1 = 78.0;
  var PAVE_Z0 = -94.0, PAVE_Z1 = 76.0;
  var FAR_R = 430.0;                    // the desert plate under the backdrop

  // ---- roads ---------------------------------------------------------------
  var ROAD_X0 = -7.6, ROAD_X1 = 7.6;
  var ROAD_CX = (ROAD_X0 + ROAD_X1) * 0.5;
  var ROAD_HW = (ROAD_X1 - ROAD_X0) * 0.5;
  var XR_Z0 = 13.0, XR_Z1 = 22.0;
  var XR_X0 = -66.0, XR_X1 = 66.0;
  var ROAD_DROP = 0.115;                // the carriageway sits below the apron

  // ---- pipe racks ----------------------------------------------------------
  var WR_X = -15.0, WR_HALF = 4.3;
  var WR_Z0 = -96.0, WR_Z1 = 26.0, WR_PITCH = 7.4;
  var WR_TIERS = [4.70, 7.50, 10.20];
  var WR_DECK = 10.92;                  // top-of-grating on the rack walkway

  var ER_X = 14.5, ER_HALF = 3.4;
  var ER_Z0 = -74.0, ER_Z1 = 8.0, ER_PITCH = 7.4;
  var ER_TIERS = [4.40, 7.00];

  // Pipe bridges over the road. A straight 170 m road with nothing crossing it
  // is a corridor with no depth cues at all; these are the rungs of the ladder
  // the eye climbs down toward the flare.
  var BRIDGES = [
    { z: -58.0, y: 9.20 },
    { z: -26.0, y: 11.40 },
    { z: 6.0, y: 8.60 }
  ];

  // ---- unit 200 : the column row -------------------------------------------
  var COLS = [
    { name: 'C1', x: 28.0, z: -44.0, r: 3.50, h: 41.0, plat: 7 },
    { name: 'C2', x: 26.0, z: -25.0, r: 2.70, h: 32.0, plat: 5 },
    { name: 'C3', x: 29.0, z: -9.0, r: 2.10, h: 25.0, plat: 4 },
    { name: 'C4', x: 25.5, z: 2.0, r: 1.60, h: 18.5, plat: 3 }
  ];
  var CAT_Y = [14.20, 23.10];           // interconnecting catwalk levels

  // ---- fired heater --------------------------------------------------------
  var HT_X0 = 43.0, HT_X1 = 61.0, HT_Z0 = -35.0, HT_Z1 = -15.0;
  var HT_H = 13.0;
  var HT_STACK_X = 57.0, HT_STACK_Z = -30.0, HT_STACK_TOP = 26.5, HT_STACK_R = 1.45;

  // ---- the flare -----------------------------------------------------------
  // MEASURED MOVE. It was first sited at x = 40, which put it on the same
  // bearing from the hero1 standpoint as the 41 m column C1 - so the level's
  // key light, its landmark and its only moving object were entirely hidden
  // behind a distillation column in the signature frame. It now stands almost
  // on the road's own axis at x = 20, which puts the flame 2.7 degrees left of
  // the hero1 sightline and 14 above it: the road leads straight to the fire.
  // The bridges at 8.6-11.4 m sit far under a 22-degree sightline, so they
  // layer the depth instead of cutting it.
  var FL_X = 20.0, FL_Z = -86.0;
  // MEASURED HEIGHT. At 46 m the flame subtended 6.5 degrees from the hero1
  // standpoint and the near pipe bridge (11.4 m at 52 m of depth) cut across
  // its lower third - the level's subject, clipped by its own set dressing. At
  // 58 m the flame sits 19-27 degrees above the sightline, entirely clear of
  // every bridge, and reads as the tallest thing for a kilometre, which is what
  // a flare stack is.
  var FL_TIP = 58.0;                    // top of the flare tip
  var FL_TIP_R = 0.95;
  var FL_DERRICK = 44.0;                // top of the lattice derrick
  var FL_LEG = 9.0;                     // derrick leg radius at grade

  // ---- tank farm -----------------------------------------------------------
  var TANKS = [
    { name: 'T1', x: -50.0, z: -46.0, r: 14.5, h: 12.5,
      bx0: -70.0, bx1: -30.0, bz0: -66.0, bz1: -26.0, bh: 1.90, stair: 0.55 },
    { name: 'T2', x: -50.0, z: -7.0, r: 14.5, h: 12.5,
      bx0: -70.0, bx1: -30.0, bz0: -24.0, bz1: 10.0, bh: 1.90, stair: 2.30 },
    { name: 'T3', x: -57.0, z: 37.0, r: 10.0, h: 10.0,
      bx0: -70.0, bx1: -44.0, bz0: 24.0, bz1: 50.0, bh: 1.70, stair: 1.20 }
  ];
  var BUND_FLOOR = -0.55;               // the dished floor inside a bund

  // ---- buildings -----------------------------------------------------------
  var PH_X0 = -38.0, PH_X1 = -16.0, PH_Z0 = 30.0, PH_Z1 = 45.0;
  var PH_EAVE = 6.40, PH_RIDGE = 7.55;
  var PH_DOOR_W = 4.60, PH_DOOR_H = 4.70, PH_DOOR_Z = 37.5;

  var CB_X0 = 33.0, CB_X1 = 55.0, CB_Z0 = 21.0, CB_Z1 = 39.0;
  var CB_H = 8.40;

  var CT_X0 = -47.0, CT_X1 = -17.0, CT_Z0 = -101.0, CT_Z1 = -83.0;
  var CT_H = 9.60;

  // ---- raised plinths ------------------------------------------------------
  // Every unit in a refinery stands on a kerbed, raised, self-draining pad.
  // ONE table, read by the ground mesh, sampleGround, the nav grid, the wear
  // pass and props - so nothing can disagree about where the step is.
  var PADS = [
    { x0: 20.0, x1: 34.0, z0: -52.0, z1: 6.0, h: 0.42 },     // unit 200
    { x0: 42.0, x1: 62.0, z0: -36.0, z1: -14.0, h: 0.38 },   // heater
    { x0: 9.0, x1: 31.0, z0: -96.0, z1: -76.0, h: 0.30 },    // flare
    { x0: -39.0, x1: -15.0, z0: 29.0, z1: 46.0, h: 0.28 },   // pump house
    { x0: 32.0, x1: 56.0, z0: 20.0, z1: 40.0, h: 0.30 },     // control
    { x0: -48.0, x1: -16.0, z0: -102.0, z1: -82.0, h: 0.34 } // coolers
  ];

  // ---- the hour ------------------------------------------------------------
  // Mirrors sky.js's _solar at t = 0.88 so the level's own shading decisions
  // (which faces are toward the burning band, where the sky gradient runs)
  // agree with the sky that is actually rendered. AZ_BASE -0.72, AZ_DRIFT 0.30.
  var TIME_OF_DAY = 0.88;
  var SUN_AZ = -0.72 - (TIME_OF_DAY - 0.5) * 0.30 * 2.0;   // -0.948 rad, WNW
  var SUN_EL = -6.83 * Math.PI / 180;
  var GLOW_X = Math.sin(SUN_AZ);            // horizontal bearing of the band
  var GLOW_Z = -Math.cos(SUN_AZ);
  var SUN_X = GLOW_X * Math.cos(SUN_EL);
  var SUN_Y = Math.sin(SUN_EL);
  var SUN_Z = GLOW_Z * Math.cos(SUN_EL);

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------
  // SURFACES.
  //
  // `uv` is world metres -> uv for the planar projection Geo.worldUV applies to
  // the merged bucket. `base` is a name materials.js certainly knows: none of
  // the keys below are library entries, so every request resolves to the base
  // and the overrides always apply. `wear:true` asks for the VERTEX WEAR shader
  // (R grime, G wetness, B edge wear); everything else takes wearMode
  // 'multiply', where the colour attribute is a plain albedo multiplier.
  //
  // METALNESS is deliberately mid-range across the whole steel family. The sky
  // is 6.8 degrees under the horizon, so the environment probe is dim; a
  // metalness of 0.9 on a plant made almost entirely of steel would render the
  // level as a black lattice with two dozen specular dots in it. 0.4-0.72 with
  // a lifted envMapIntensity keeps a diffuse term for the practicals to find.
  // ---------------------------------------------------------------------------
  var SURF = {
    // ---- the ground ---------------------------------------------------------
    pave:      { uv: 0.34, cast: false, recv: true, wear: true,
                 base: 'concrete', rough: 0.88 },
    road:      { uv: 0.30, cast: false, recv: true, wear: true,
                 base: 'asphalt', rough: 0.86 },
    grit:      { uv: 0.22, cast: false, recv: true, wear: false,
                 base: 'gravel', rough: 0.94 },
    sandy:     { uv: 0.055, cast: false, recv: true, wear: false,
                 base: 'sand', rough: 0.95, env: 0.55 },
    // ---- concrete structure -------------------------------------------------
    wall:      { uv: 0.36, cast: true, recv: true, wear: true,
                 base: 'concrete_wall' },
    kerb:      { uv: 0.72, cast: true, recv: true, wear: false,
                 base: 'concrete', rough: 0.90 },
    // ---- steel --------------------------------------------------------------
    struct:    { uv: 0.55, cast: true, recv: true, wear: false,
                 base: 'structural_steel', rough: 0.58, metal: 0.66, env: 1.35 },
    // Process pipe. Three paint families, because a rack in which every line is
    // the same colour is a rack you cannot read - real plants colour-code by
    // service and it is the cheapest legibility a pipe rack has.
    pipe:      { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x8d9298,
                 rough: 0.44, metal: 0.70, env: 1.4 },
    pipe_g:    { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x4e6350,
                 rough: 0.54, metal: 0.55, env: 1.3 },
    pipe_o:    { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x8c5323,
                 rough: 0.60, metal: 0.48, env: 1.25 },
    // Aluminium weather jacketing over mineral-wool lagging. The single
    // largest area of "steel" in the frame: the columns are clad in it, and it
    // is much paler and much less metallic than bare pipe - which is what
    // stops the column row from going black against the sky.
    lag:       { uv: 0.62, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0xb2b6b8,
                 rough: 0.50, metal: 0.42, env: 1.5 },
    // Tank shell: weathered light-grey enamel over plate, with the horizontal
    // course seams and the wind-girder doing the silhouette work.
    // uv 0.62, not 0.30. At 0.30 tiles/m the painted_metal map's own macro
    // blotching landed at 2-3 m on a 29 m tank and the shells photographed as
    // CAMOUFLAGE - big irregular dark patches with no relationship to the
    // plate courses. At 0.62 the same blotching is sub-metre and reads as
    // weathering on steel.
    // base 'ship_hull', not 'painted_metal'. painted_metal's macro blotching is
    // authored for a 1 m panel; stretched over a 29 m tank it printed as
    // CAMOUFLAGE at uv 0.30 and as SANDPAPER STATIC at 0.62 - there is no scale
    // at which it is a tank. ship_hull is the library's large-plate entry: low
    // detail, real weld structure, and it was written for exactly this problem.
    tank:      { uv: 0.34, cast: true, recv: true, wear: false,
                 base: 'ship_hull', albedoTarget: 0x9aa09e,
                 rough: 0.62, metal: 0.42, env: 1.25 },
    // The flare derrick, and only the flare derrick. MEASURED: painted in the
    // structural steel palette it was invisible from the hero1 standpoint -
    // 114 m of dry air, thin members and a dark albedo against the dark half of
    // a dusk sky put the flame in frame with no stack under it, so the level's
    // landmark read as a fire floating over a pipe rack. Real flare derricks
    // carry aviation obstruction marking for exactly this reason: alternating
    // bands of white and international orange, which is what the per-panel tint
    // in buildFlare paints onto this surface.
    // Painted near-WHITE first, which was the wrong reading of the problem: at
    // the elevation the derrick occupies from hero1 the background is not the
    // dark half of the sky, it is the BRIGHT horizon haze, and a pale lattice
    // in front of pale haze is just as invisible as a dark one in front of dark
    // sky. It is now dark-galvanised with hot orange aviation bands, so it has
    // contrast against both.
    derrick:   { uv: 0.42, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x6b6862,
                 rough: 0.60, metal: 0.34, env: 1.30 },
    machine:   { uv: 2.30, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x4c6354,
                 rough: 0.46, metal: 0.55, env: 1.3 },
    rust:      { uv: 0.90, cast: true, recv: true, wear: false,
                 base: 'rusted_metal', rough: 0.78, metal: 0.60, env: 1.1 },
    grate:     { uv: 1.20, cast: false, recv: true, wear: false,
                 base: 'steel_grate' },
    // Handrail, kick plate, ladder cage: contractor's yellow, and it is the
    // only saturated warm chroma in the level that is not fire.
    rail:      { uv: 1.05, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0xa9821f,
                 rough: 0.55, metal: 0.45, env: 1.2 },
    // 0.55 tiles/m. corrugated_metal lays 1.9 ribs per uv tile, so 1.00 put a
    // 9 cm rib pitch on the pump-house walls; at a grazing interior angle that
    // aliased into a vertical barcode across the whole frame. 0.55 gives a
    // 16 cm profile, which is a real sheet and resolves cleanly.
    clad:      { uv: 0.38, cast: true, recv: true, wear: false,
                 base: 'corrugated_metal', rough: 0.58, metal: 0.62, env: 1.3 },
    roof:      { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'corrugated_roof', rough: 0.68, metal: 0.55, env: 1.2 },
    brick:     { uv: 0.42, cast: true, recv: true, wear: true,
                 base: 'brick' },
    glass:     { uv: 0.40, cast: false, recv: false, wear: false,
                 base: 'glass', env: 2.0 },
    chain:     { uv: 1.0, cast: false, recv: false, wear: false, keepUV: false,
                 base: 'chainlink' },
    refract:   { uv: 0.55, cast: true, recv: true, wear: false,
                 base: 'brick', albedoTarget: 0x6d5a4a, rough: 0.92, metal: 0.0 },
    // ---- markings ------------------------------------------------------------
    decal:     { uv: 1.0, cast: false, recv: true, wear: false, own: true,
                 keepUV: true },
    // ---- light ---------------------------------------------------------------
    lamp_w:    { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.26, metal: 0.0,
                 emissive: 0xffb257, emissiveIntensity: 6.0 },
    lamp_c:    { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.26, metal: 0.0,
                 emissive: 0xc9dcff, emissiveIntensity: 5.2 },
    lamp_r:    { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.26, metal: 0.0,
                 emissive: 0xff2a18, emissiveIntensity: 6.4 },
    // ---- distance -------------------------------------------------------------
    // The rest of the refinery, 130-330 m out. Its own bucket because it needs
    // none of the detail-normal machinery the near surfaces do and because its
    // albedo is authored for aerial perspective rather than for material.
    far:       { uv: 0.075, cast: false, recv: false, wear: false,
                 base: 'concrete', albedoTarget: 0x4a4b4c, rough: 0.90,
                 metal: 0.0, env: 0.55 },
    far_light: { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.4, metal: 0.0,
                 emissive: 0xffb968, emissiveIntensity: 4.6 }
  };

  // If materials.js is missing entirely the plant must still read as steel and
  // concrete at dusk rather than as magenta error boxes.
  var FALLBACK = {
    pave:      [0x6f6b64, 0.88, 0.0],
    road:      [0x3d3c3a, 0.86, 0.0],
    grit:      [0x6b655a, 0.94, 0.0],
    sandy:     [0x5e564a, 0.95, 0.0],
    wall:      [0x7d786f, 0.90, 0.0],
    kerb:      [0x8a857c, 0.90, 0.0],
    struct:    [0x5e6164, 0.58, 0.66],
    derrick:   [0x6b6862, 0.60, 0.34],
    pipe:      [0x8d9298, 0.44, 0.70],
    pipe_g:    [0x4e6350, 0.54, 0.55],
    pipe_o:    [0x8c5323, 0.60, 0.48],
    lag:       [0xb2b6b8, 0.50, 0.42],
    tank:      [0x9aa09e, 0.62, 0.38],
    machine:   [0x4c6354, 0.46, 0.55],
    rust:      [0x7a4a30, 0.78, 0.60],
    grate:     [0x55514b, 0.72, 0.70],
    rail:      [0xa9821f, 0.55, 0.45],
    clad:      [0x71767a, 0.58, 0.62],
    roof:      [0x6a6c68, 0.68, 0.55],
    brick:     [0x8a6a52, 0.92, 0.0],
    glass:     [0x243038, 0.10, 0.0],
    chain:     [0x8a9096, 0.70, 0.40],
    refract:   [0x6d5a4a, 0.92, 0.0],
    decal:     [0xffffff, 0.80, 0.0],
    lamp_w:    [0xffcf92, 0.26, 0.0],
    lamp_c:    [0xd8e6ff, 0.26, 0.0],
    lamp_r:    [0xff5a44, 0.26, 0.0],
    far:       [0x4a4b4c, 0.90, 0.0],
    far_light: [0xffb968, 0.40, 0.0]
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

  // Cached primitives, returned NON-INDEXED so Geo.mergeAll never has to
  // convert (and therefore never disposes a cache entry out from under the
  // next caller).
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
    seg = seg || 8;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' +
      seg + ',' + (open ? 1 : 0);
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, !!open);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  // A flat ring lying in the XZ plane - platform gratings, tank roof plates,
  // flange faces. Much cheaper than a torus and it is what a walkway really is.
  var _annCache = new Map();
  function annulus(rIn, rOut, seg) {
    seg = seg || 24;
    var k = rIn.toFixed(3) + ',' + rOut.toFixed(3) + ',' + seg;
    var g = _annCache.get(k);
    if (g) return g;
    var pos = [], nor = [];
    for (var i = 0; i < seg; i++) {
      var a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      pos.push(c0 * rIn, 0, s0 * rIn, c0 * rOut, 0, s0 * rOut, c1 * rOut, 0, s1 * rOut);
      pos.push(c0 * rIn, 0, s0 * rIn, c1 * rOut, 0, s1 * rOut, c1 * rIn, 0, s1 * rIn);
      for (var q = 0; q < 6; q++) nor.push(0, 1, 0);
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    _annCache.set(k, g);
    return g;
  }

  var _torCache = new Map();
  function torus(r, tube, seg) {
    seg = seg || 24;
    var k = r.toFixed(3) + ',' + tube.toFixed(3) + ',' + seg;
    var g = _torCache.get(k);
    if (!g) {
      var src = new THREE.TorusGeometry(r, tube, 5, seg);
      src.rotateX(-Math.PI / 2);
      g = src.toNonIndexed(); src.dispose();
      _torCache.set(k, g);
    }
    return g;
  }

  // A flat quad in the XY plane facing +Z. Decal cards, distant lights.
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

  // A height-field patch with optional rectangular holes cut out of it. The
  // apron has seven (two roads, three bunds, two buildings) and cutting them as
  // geometry rather than covering them is what lets each region carry its own
  // material without any coplanar z-fighting.
  function gridSurface(x0, x1, z0, z1, step, fn, holes) {
    var nx = Math.max(1, Math.round((x1 - x0) / step));
    var nz = Math.max(1, Math.round((z1 - z0) / step));
    var dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    var pos = [], nor = [];
    function inHole(cx, cz) {
      if (!holes) return false;
      for (var h = 0; h < holes.length; h++) {
        var q = holes[h];
        if (cx > q[0] && cx < q[1] && cz > q[2] && cz < q[3]) return true;
      }
      return false;
    }
    function tri(ax, az, bx, bz, cx, cz) {
      var ay = fn(ax, az), by = fn(bx, bz), cy = fn(cx, cz);
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
      var l = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1;
      if (ny2 < 0) { nx2 = -nx2; ny2 = -ny2; nz2 = -nz2; }
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      for (var q = 0; q < 3; q++) nor.push(nx2 / l, ny2 / l, nz2 / l);
    }
    for (var j = 0; j < nz; j++) {
      for (var i = 0; i < nx; i++) {
        var ax = x0 + i * dx, bx = ax + dx;
        var az = z0 + j * dz, bz = az + dz;
        if (inHole((ax + bx) * 0.5, (az + bz) * 0.5)) continue;
        tri(ax, az, ax, bz, bx, az);
        tri(bx, az, ax, bz, bx, bz);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // Colour helper: keep the tint bright (it multiplies albedo) but shift hue.
  function tint(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  // ============================================================== THE GROUND ==
  // Hardstanding is FLAT, and that is exactly why it needs a function: with no
  // sun at all, every bit of form on the ground comes from a lamp at 5-13 m
  // raking across it, and at that incidence a 2 cm dip across a 3 m bay is a
  // 20 cm band of shade. Every consumer - sampleGround, the nav grid, the wear
  // pass, the collider generator and props - reads THESE functions, so none of
  // them can disagree about where the low spots are.

  var JOINT_PITCH = 5.0;                // saw-cut control joints
  function jointDip(x, z) {
    var a = ((x + 2.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    var b = ((z + 1.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    a = Math.abs(a); b = Math.abs(b);
    var d = 0;
    if (a < 0.085) d = (1 - a / 0.085) * 0.026;
    if (b < 0.085) d = Math.max(d, (1 - b / 0.085) * 0.026);
    return d;
  }

  // How much of the road surface is under (x, z). 1 on the carriageway, 0 on
  // the apron, blended over the 0.9 m the kerb and channel occupy.
  function roadF(x, z) {
    var a = M.smoothstep(ROAD_X0 - 0.45, ROAD_X0 + 0.45, x) *
            M.smoothstep(ROAD_X1 + 0.45, ROAD_X1 - 0.45, x);
    var b = M.smoothstep(XR_Z0 - 0.45, XR_Z0 + 0.45, z) *
            M.smoothstep(XR_Z1 + 0.45, XR_Z1 - 0.45, z) *
            M.smoothstep(XR_X0 - 1.0, XR_X0 + 1.0, x) *
            M.smoothstep(XR_X1 + 1.0, XR_X1 - 1.0, x);
    return M.saturate(Math.max(a, b));
  }

  // Raised unit plinths, chamfered over the 0.6 m the kerb upstand occupies.
  function padAt(x, z) {
    var best = 0;
    for (var i = 0; i < PADS.length; i++) {
      var p = PADS[i];
      var fx = M.smoothstep(p.x0 - 0.60, p.x0 + 0.10, x) *
               M.smoothstep(p.x1 + 0.60, p.x1 - 0.10, x);
      var fz = M.smoothstep(p.z0 - 0.60, p.z0 + 0.10, z) *
               M.smoothstep(p.z1 + 0.60, p.z1 - 0.10, z);
      var h = p.h * fx * fz;
      if (h > best) best = h;
    }
    return best;
  }

  // Inside a bund the ground is dished and much lower - that is the whole
  // point of a bund, and it is 0.55 m of real relief the player walks down
  // into. Returns 0..1.
  function bundF(x, z) {
    var best = 0;
    for (var i = 0; i < TANKS.length; i++) {
      var t = TANKS[i];
      var fx = M.smoothstep(t.bx0 + 0.10, t.bx0 + 1.40, x) *
               M.smoothstep(t.bx1 - 0.10, t.bx1 - 1.40, x);
      var fz = M.smoothstep(t.bz0 + 0.10, t.bz0 + 1.40, z) *
               M.smoothstep(t.bz1 - 0.10, t.bz1 - 1.40, z);
      var f = fx * fz;
      if (f > best) best = f;
    }
    return best;
  }

  // The 0.45 m drainage channels down both sides of the main road.
  function channelDip(x, z) {
    if (z < PAVE_Z0 || z > PAVE_Z1) return 0;
    var w = 0.34;
    var a = Math.abs(x - (ROAD_X0 - 0.62));
    var b = Math.abs(x - (ROAD_X1 + 0.62));
    var d = 0;
    if (a < w) d = (1 - a / w) * 0.095;
    if (b < w) d = Math.max(d, (1 - b / w) * 0.095);
    return d;
  }

  // The site's own settlement and the 1:400 fall the drainage was set out to.
  function siteGrade(x, z, N) {
    var y = -M.saturate((z - SITE_Z0) / (SITE_Z1 - SITE_Z0)) * 0.45;
    y -= (N.fbm2(x * 0.021 + 4.3, z * 0.021 - 2.7, 3) * 0.5 + 0.5) * 0.155;
    y += N.fbm2(x * 0.115 - 1.1, z * 0.115 + 6.4, 2) * 0.019;
    return y;
  }

  function groundY(x, z, N) {
    var y = siteGrade(x, z, N);
    var b = bundF(x, z);
    if (b > 0) y += b * BUND_FLOOR;
    y += padAt(x, z) * (1 - b);
    var rf = roadF(x, z);
    // carriageway: crowned, and 11.5 cm below the apron it is kerbed from
    var t = M.clamp((x - ROAD_CX) / ROAD_HW, -1, 1);
    var crown = (1 - t * t) * 0.085;
    y += rf * (-ROAD_DROP + crown);
    y -= (1 - rf) * (channelDip(x, z) + jointDip(x, z));
    return y;
  }

  // Beyond the paved area: graded fill that falls away to the desert.
  function farY(x, z, N) {
    var r = Math.max(Math.abs(x) / 96, Math.abs(z) / 104);
    var f = M.smoothstep(1.0, 2.2, r);
    var y = siteGrade(M.clamp(x, SITE_X0, SITE_X1), M.clamp(z, SITE_Z0, SITE_Z1), N);
    y -= f * 1.9;
    y += (N.fbm2(x * 0.006 + 11, z * 0.006 - 4, 3) * 0.5 + 0.5) * f * 5.2;
    return y;
  }

  // ========================================================= SITE MARKINGS ===
  // A 4 x 4 alpha atlas of everything a plant sprays, bolts or cable-ties to
  // itself. Alpha-tested cards laid coplanar on the apron, the plinth kerbs,
  // the tank shells and the rack legs. On a site made of grey concrete and
  // grey steel this is most of the legibility there is, and the hazard chevron
  // in cell 0 is the level's only high-frequency chroma below eye level.
  var ATLAS_N = 4, ATLAS_PX = 1024, ATLAS_CELL = ATLAS_PX / ATLAS_N;
  var CELL = {
    hazard: 0,     // yellow/black chevron, tiles horizontally
    unitno: 1,     // stencilled unit / equipment number
    danger: 2,     // DANGER placard, invented script
    flam: 3,       // flammable diamond
    weep: 4,       // rust and hydrocarbon weep, vertical
    arrow: 5,      // flow-direction arrow + line number
    band: 6,       // pipe service colour band + tag
    nosmoke: 7,    // circular prohibition
    spill: 8,      // oil stain / spill
    tank: 9,       // tank number, very large
    tape: 10,      // torn barrier tape
    scuff: 11,     // tyre scuff
    valve: 12,     // valve tag disc + wire
    plate: 13,     // manufacturer's data plate
    cross: 14,     // sprayed inspection mark
    logo: 15       // operator's mark, invented script
  };
  // Invented script: consistent letterforms that read as writing at a glance
  // and as nothing in particular up close. No font files exist in this build.
  var GLYPHS = 'AEHIKLMNORSTUVXZ0123456789';

  function atlasUV(cell) {
    var cx = (cell % ATLAS_N) / ATLAS_N;
    var cy = Math.floor(cell / ATLAS_N) / ATLAS_N;
    var s = 1 / ATLAS_N;
    return [cx, 1 - cy - s, cx + s, 1 - cy];
  }

  function buildAtlas(rng) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var cv = document.createElement('canvas');
    cv.width = ATLAS_PX; cv.height = ATLAS_PX;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    var i, S;

    function cellCtx(cell) {
      var cx = (cell % ATLAS_N) * ATLAS_CELL;
      var cy = Math.floor(cell / ATLAS_N) * ATLAS_CELL;
      g.save();
      g.beginPath(); g.rect(cx, cy, ATLAS_CELL, ATLAS_CELL); g.clip();
      g.translate(cx, cy);
      return ATLAS_CELL;
    }
    function endCell() { g.restore(); }
    function rgba(cr, cg, cb, a) {
      return 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',' + a.toFixed(3) + ')';
    }
    // A stencilled glyph. Blocky, with the bridges a real stencil leaves.
    function glyph(ch, x, y, s, w) {
      g.lineWidth = w || Math.max(1.5, s * 0.17);
      g.lineCap = 'butt';
      var h = s, hw = s * 0.34;
      g.beginPath();
      switch (ch) {
        case 'A': g.moveTo(x - hw, y + h); g.lineTo(x, y); g.lineTo(x + hw, y + h);
          g.moveTo(x - hw * 0.55, y + h * 0.62); g.lineTo(x + hw * 0.55, y + h * 0.62); break;
        case 'E': g.moveTo(x + hw, y); g.lineTo(x - hw, y); g.lineTo(x - hw, y + h);
          g.lineTo(x + hw, y + h); g.moveTo(x - hw, y + h * 0.5); g.lineTo(x + hw * 0.6, y + h * 0.5); break;
        case 'H': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h); g.moveTo(x + hw, y); g.lineTo(x + hw, y + h);
          g.moveTo(x - hw, y + h * 0.52); g.lineTo(x + hw, y + h * 0.52); break;
        case 'I': g.moveTo(x, y); g.lineTo(x, y + h); break;
        case 'K': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h); g.moveTo(x + hw, y); g.lineTo(x - hw, y + h * 0.52);
          g.moveTo(x - hw * 0.2, y + h * 0.42); g.lineTo(x + hw, y + h); break;
        case 'L': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h); break;
        case 'M': g.moveTo(x - hw, y + h); g.lineTo(x - hw, y); g.lineTo(x, y + h * 0.55);
          g.lineTo(x + hw, y); g.lineTo(x + hw, y + h); break;
        case 'N': g.moveTo(x - hw, y + h); g.lineTo(x - hw, y); g.lineTo(x + hw, y + h); g.lineTo(x + hw, y); break;
        case 'O': case '0': g.moveTo(x - hw, y + h * 0.16); g.lineTo(x - hw, y + h * 0.84);
          g.moveTo(x + hw, y + h * 0.16); g.lineTo(x + hw, y + h * 0.84);
          g.moveTo(x - hw * 0.7, y); g.lineTo(x + hw * 0.7, y);
          g.moveTo(x - hw * 0.7, y + h); g.lineTo(x + hw * 0.7, y + h); break;
        case 'R': g.moveTo(x - hw, y + h); g.lineTo(x - hw, y); g.lineTo(x + hw * 0.7, y);
          g.lineTo(x + hw, y + h * 0.26); g.lineTo(x - hw, y + h * 0.52);
          g.moveTo(x, y + h * 0.52); g.lineTo(x + hw, y + h); break;
        case 'S': case '5': g.moveTo(x + hw, y); g.lineTo(x - hw, y); g.lineTo(x - hw, y + h * 0.5);
          g.lineTo(x + hw, y + h * 0.5); g.lineTo(x + hw, y + h); g.lineTo(x - hw, y + h); break;
        case 'T': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.moveTo(x, y); g.lineTo(x, y + h); break;
        case 'U': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h); g.lineTo(x + hw, y); break;
        case 'V': g.moveTo(x - hw, y); g.lineTo(x, y + h); g.lineTo(x + hw, y); break;
        case 'X': g.moveTo(x - hw, y); g.lineTo(x + hw, y + h); g.moveTo(x + hw, y); g.lineTo(x - hw, y + h); break;
        case 'Z': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h); break;
        case '1': g.moveTo(x - hw * 0.5, y + h * 0.2); g.lineTo(x, y); g.lineTo(x, y + h); break;
        case '2': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.lineTo(x + hw, y + h * 0.5);
          g.lineTo(x - hw, y + h * 0.5); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h); break;
        case '3': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.lineTo(x + hw, y + h); g.lineTo(x - hw, y + h);
          g.moveTo(x - hw * 0.3, y + h * 0.5); g.lineTo(x + hw, y + h * 0.5); break;
        case '4': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h * 0.55); g.lineTo(x + hw, y + h * 0.55);
          g.moveTo(x + hw * 0.45, y); g.lineTo(x + hw * 0.45, y + h); break;
        case '6': g.moveTo(x + hw, y); g.lineTo(x - hw, y); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h);
          g.lineTo(x + hw, y + h * 0.5); g.lineTo(x - hw, y + h * 0.5); break;
        case '7': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.lineTo(x - hw * 0.2, y + h); break;
        case '8': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.lineTo(x + hw, y + h); g.lineTo(x - hw, y + h);
          g.closePath(); g.moveTo(x - hw, y + h * 0.5); g.lineTo(x + hw, y + h * 0.5); break;
        case '9': g.moveTo(x - hw, y + h); g.lineTo(x + hw, y + h); g.lineTo(x + hw, y); g.lineTo(x - hw, y);
          g.lineTo(x - hw, y + h * 0.5); g.lineTo(x + hw, y + h * 0.5); break;
        default: g.moveTo(x - hw, y + h); g.lineTo(x + hw, y + h); break;
      }
      g.stroke();
    }
    function word(n, x, y, s, gap) {
      var w = s * 0.68 + (gap === undefined ? s * 0.26 : gap);
      var tot = (n - 1) * w;
      for (var q = 0; q < n; q++) glyph(rng.pick(GLYPHS.split('')), x - tot * 0.5 + q * w, y, s);
    }
    function spray(alpha, dens, cw, colour) {
      g.globalAlpha = alpha;
      g.fillStyle = colour;
      for (var q = 0; q < dens; q++) {
        g.fillRect(rng.range(0, cw), rng.range(0, cw), rng.range(1, 3.4), rng.range(1, 3.4));
      }
      g.globalAlpha = 1;
    }
    function chew(cw, n, yBands) {
      g.globalCompositeOperation = 'destination-out';
      for (var q = 0; q < n; q++) {
        g.globalAlpha = rng.range(0.2, 1.0);
        g.beginPath();
        var yy = yBands ? cw * rng.pick(yBands) + rng.range(-10, 10) : rng.range(0, cw);
        g.arc(rng.range(0, cw), yy, rng.range(2, 12), 0, 6.28318);
        g.fill();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }

    // ---- 0 hazard chevron ----------------------------------------------------
    S = cellCtx(CELL.hazard);
    g.fillStyle = '#d9ac1f'; g.fillRect(0, S * 0.28, S, S * 0.44);
    g.fillStyle = '#16130f';
    for (i = -2; i < 10; i++) {
      var bx = i * S * 0.17;
      g.beginPath();
      g.moveTo(bx, S * 0.72); g.lineTo(bx + S * 0.085, S * 0.28);
      g.lineTo(bx + S * 0.17, S * 0.28); g.lineTo(bx + S * 0.085, S * 0.72);
      g.closePath(); g.fill();
    }
    chew(S, 110, [0.28, 0.72]);
    endCell();

    // ---- 1 equipment number stencil -----------------------------------------
    S = cellCtx(CELL.unitno);
    g.strokeStyle = '#191713';
    word(2, S * 0.5, S * 0.14, S * 0.32);
    g.strokeStyle = 'rgba(28,26,22,0.82)';
    word(4, S * 0.5, S * 0.60, S * 0.19);
    spray(0.17, 280, S, '#242119');
    endCell();

    // ---- 2 DANGER placard ---------------------------------------------------
    S = cellCtx(CELL.danger);
    g.fillStyle = '#ded7c6'; g.fillRect(S * 0.05, S * 0.10, S * 0.90, S * 0.80);
    g.fillStyle = '#b0201a'; g.fillRect(S * 0.05, S * 0.10, S * 0.90, S * 0.27);
    g.strokeStyle = '#f4eee2';
    word(6, S * 0.5, S * 0.155, S * 0.16);
    g.strokeStyle = 'rgba(30,28,26,0.92)';
    word(7, S * 0.5, S * 0.47, S * 0.11);
    word(5, S * 0.5, S * 0.68, S * 0.11);
    g.strokeStyle = 'rgba(40,38,34,0.55)'; g.lineWidth = 2;
    g.strokeRect(S * 0.05, S * 0.10, S * 0.90, S * 0.80);
    for (i = 0; i < 4; i++) {
      g.fillStyle = '#575249';
      g.beginPath();
      g.arc(S * (i % 2 ? 0.88 : 0.12), S * (i < 2 ? 0.17 : 0.83), S * 0.022, 0, 6.28318);
      g.fill();
    }
    endCell();

    // ---- 3 flammable diamond ------------------------------------------------
    S = cellCtx(CELL.flam);
    g.save(); g.translate(S * 0.5, S * 0.5); g.rotate(Math.PI * 0.25);
    g.fillStyle = '#c0141a'; g.fillRect(-S * 0.31, -S * 0.31, S * 0.62, S * 0.62);
    g.strokeStyle = '#f0e6d4'; g.lineWidth = S * 0.02;
    g.strokeRect(-S * 0.27, -S * 0.27, S * 0.54, S * 0.54);
    g.restore();
    g.strokeStyle = '#f2e9d8';
    word(1, S * 0.5, S * 0.40, S * 0.22, S * 0.10);
    word(3, S * 0.5, S * 0.62, S * 0.09);
    chew(S, 26);
    endCell();

    // ---- 4 rust / hydrocarbon weep ------------------------------------------
    S = cellCtx(CELL.weep);
    for (i = 0; i < 26; i++) {
      var wx = rng.range(0, S), ww = rng.range(3, 24);
      var grd = g.createLinearGradient(0, 0, 0, S);
      var rr = rng.range(88, 142), gg = rng.range(62, 96), bb = rng.range(40, 66);
      grd.addColorStop(0, rgba(rr, gg, bb, rng.range(0.32, 0.66)));
      grd.addColorStop(0.5, rgba(rr * 0.88, gg * 0.88, bb * 0.88, rng.range(0.12, 0.30)));
      grd.addColorStop(1, rgba(rr * 0.7, gg * 0.7, bb * 0.7, 0));
      g.fillStyle = grd;
      g.fillRect(wx, rng.range(0, S * 0.18), ww, S);
    }
    endCell();

    // ---- 5 flow arrow + line number -----------------------------------------
    S = cellCtx(CELL.arrow);
    g.fillStyle = '#e7e2d6'; g.fillRect(S * 0.04, S * 0.30, S * 0.92, S * 0.40);
    g.strokeStyle = '#1b1a17'; g.lineWidth = S * 0.035;
    g.beginPath(); g.moveTo(S * 0.10, S * 0.50); g.lineTo(S * 0.66, S * 0.50); g.stroke();
    g.beginPath(); g.moveTo(S * 0.80, S * 0.50); g.lineTo(S * 0.58, S * 0.36);
    g.lineTo(S * 0.58, S * 0.64); g.closePath(); g.fillStyle = '#1b1a17'; g.fill();
    g.strokeStyle = 'rgba(26,25,22,0.85)';
    word(5, S * 0.44, S * 0.545, S * 0.085);
    chew(S, 34, [0.30, 0.70]);
    endCell();

    // ---- 6 pipe service band + tag ------------------------------------------
    S = cellCtx(CELL.band);
    g.fillStyle = '#2c6b4a'; g.fillRect(0, S * 0.16, S, S * 0.30);
    g.fillStyle = '#c7a41c'; g.fillRect(0, S * 0.52, S, S * 0.16);
    g.strokeStyle = 'rgba(240,236,224,0.9)';
    word(4, S * 0.5, S * 0.23, S * 0.15);
    chew(S, 40);
    endCell();

    // ---- 7 prohibition ------------------------------------------------------
    S = cellCtx(CELL.nosmoke);
    g.fillStyle = '#efe9db';
    g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.42, 0, 6.28318); g.fill();
    g.strokeStyle = '#bb1c18'; g.lineWidth = S * 0.085;
    g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.37, 0, 6.28318); g.stroke();
    g.beginPath(); g.moveTo(S * 0.22, S * 0.78); g.lineTo(S * 0.78, S * 0.22); g.stroke();
    g.strokeStyle = 'rgba(30,28,26,0.85)'; g.lineWidth = S * 0.05;
    g.beginPath(); g.moveTo(S * 0.30, S * 0.55); g.lineTo(S * 0.66, S * 0.44); g.stroke();
    chew(S, 22);
    endCell();

    // ---- 8 spill ------------------------------------------------------------
    S = cellCtx(CELL.spill);
    for (i = 0; i < 16; i++) {
      var sx = S * 0.5 + rng.gaussian(0, S * 0.13);
      var sy = S * 0.5 + rng.gaussian(0, S * 0.13);
      var sr = rng.range(S * 0.06, S * 0.26);
      var gr2 = g.createRadialGradient(sx, sy, 0, sx, sy, sr);
      gr2.addColorStop(0, rgba(20, 17, 14, rng.range(0.45, 0.80)));
      gr2.addColorStop(0.7, rgba(26, 22, 18, rng.range(0.18, 0.40)));
      gr2.addColorStop(1, rgba(30, 26, 20, 0));
      g.fillStyle = gr2;
      g.beginPath(); g.arc(sx, sy, sr, 0, 6.28318); g.fill();
    }
    endCell();

    // ---- 9 tank number, large ------------------------------------------------
    S = cellCtx(CELL.tank);
    g.strokeStyle = 'rgba(36,34,30,0.88)';
    word(3, S * 0.5, S * 0.22, S * 0.55, S * 0.10);
    spray(0.14, 220, S, '#2a2722');
    endCell();

    // ---- 10 barrier tape -----------------------------------------------------
    S = cellCtx(CELL.tape);
    g.fillStyle = '#d43a24'; g.fillRect(0, S * 0.42, S, S * 0.16);
    g.fillStyle = '#eee7d8';
    for (i = 0; i < 9; i++) g.fillRect(i * S * 0.115, S * 0.42, S * 0.055, S * 0.16);
    chew(S, 60, [0.42, 0.58]);
    endCell();

    // ---- 11 tyre scuff -------------------------------------------------------
    S = cellCtx(CELL.scuff);
    for (i = 0; i < 9; i++) {
      var ty = S * (0.16 + i * 0.085);
      g.fillStyle = rgba(24, 22, 20, rng.range(0.16, 0.46));
      g.fillRect(rng.range(-S * 0.1, S * 0.2), ty, rng.range(S * 0.5, S * 1.0), rng.range(4, 13));
    }
    endCell();

    // ---- 12 valve tag --------------------------------------------------------
    S = cellCtx(CELL.valve);
    g.fillStyle = '#b6bcbe';
    g.beginPath(); g.arc(S * 0.5, S * 0.56, S * 0.30, 0, 6.28318); g.fill();
    g.strokeStyle = 'rgba(30,28,25,0.9)'; g.lineWidth = S * 0.012;
    g.beginPath(); g.arc(S * 0.5, S * 0.56, S * 0.30, 0, 6.28318); g.stroke();
    g.beginPath(); g.moveTo(S * 0.5, S * 0.26); g.lineTo(S * 0.5, S * 0.10); g.stroke();
    g.strokeStyle = 'rgba(30,28,25,0.85)';
    word(3, S * 0.5, S * 0.46, S * 0.13);
    endCell();

    // ---- 13 data plate -------------------------------------------------------
    S = cellCtx(CELL.plate);
    g.fillStyle = '#9aa0a2'; g.fillRect(S * 0.10, S * 0.24, S * 0.80, S * 0.52);
    g.strokeStyle = 'rgba(36,34,31,0.75)'; g.lineWidth = 2;
    g.strokeRect(S * 0.10, S * 0.24, S * 0.80, S * 0.52);
    g.strokeStyle = 'rgba(34,32,29,0.9)';
    word(5, S * 0.5, S * 0.31, S * 0.10);
    word(6, S * 0.5, S * 0.47, S * 0.075);
    word(4, S * 0.5, S * 0.61, S * 0.075);
    endCell();

    // ---- 14 inspection mark --------------------------------------------------
    S = cellCtx(CELL.cross);
    g.strokeStyle = 'rgba(206,196,60,0.85)'; g.lineWidth = S * 0.045;
    g.beginPath(); g.moveTo(S * 0.24, S * 0.30); g.lineTo(S * 0.72, S * 0.66);
    g.moveTo(S * 0.72, S * 0.30); g.lineTo(S * 0.24, S * 0.66); g.stroke();
    g.strokeStyle = 'rgba(206,196,60,0.7)';
    word(3, S * 0.5, S * 0.70, S * 0.13);
    spray(0.20, 200, S, '#b9ae3c');
    endCell();

    // ---- 15 operator's mark --------------------------------------------------
    S = cellCtx(CELL.logo);
    g.strokeStyle = 'rgba(214,206,190,0.80)';
    word(4, S * 0.5, S * 0.36, S * 0.26);
    g.lineWidth = S * 0.02;
    g.beginPath(); g.moveTo(S * 0.16, S * 0.70); g.lineTo(S * 0.84, S * 0.70); g.stroke();
    endCell();

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // ================================================================ Builder ==
  // Transform stack + per-material geometry buckets. Same shape as the market,
  // harbor and highrise builders, deliberately: this file follows those files'
  // patterns rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    this.paint = 'steel';
    this.dark = 0;
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
    var e = { geometry: geo, matrix: wm, tint: this.tint, paint: this.paint, dark: this.dark };
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
  Builder.prototype.ring = function (key, rIn, rOut, x, y, z, seg) {
    return this.add(key, annulus(rIn, rOut, seg), makeM(x, y, z));
  };
  Builder.prototype.torus = function (key, r, tube, x, y, z, seg) {
    return this.add(key, torus(r, tube, seg), makeM(x, y, z));
  };
  // A rectangular member between two arbitrary points.
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
  // A round member between two points - pipe, tube, conduit, guy wire.
  Builder.prototype.tube = function (key, ax, ay, az, bx, by, bz, r, seg) {
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
    return this.add(key, cyl(r, r, len, seg || 8), m);
  };

  // ---- handrail: a straight run --------------------------------------------
  // Every walkable edge in a plant carries top rail, mid rail, toe plate and
  // stanchions at 1.5 m. It is the single most characteristic silhouette
  // element in industrial architecture and it is what makes a catwalk read as
  // a catwalk rather than as a plank.
  Builder.prototype.railRun = function (ax, az, bx, bz, y, h) {
    h = h || 1.10;
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.3) return;
    var n = Math.max(2, Math.round(len / 1.55));
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      this.cyl('rail', 0.026, 0.026, h, ax + dx * t, y + h * 0.5, az + dz * t, 0, 0, 0, 6);
    }
    this.tube('rail', ax, y + h, az, bx, y + h, bz, 0.026, 6);
    this.tube('rail', ax, y + h * 0.52, az, bx, y + h * 0.52, bz, 0.021, 6);
    var yaw = Math.atan2(dx, dz);
    this.boxR('rail', 0.016, 0.11, len, (ax + bx) * 0.5, y + 0.06, (az + bz) * 0.5,
      0, yaw, 0, 0.004);
  };

  // ---- handrail: a full circle, for a platform ring ------------------------
  Builder.prototype.railRing = function (cx, cz, r, y, h, seg) {
    h = h || 1.10;
    seg = seg || Math.max(10, Math.round(r * 2.6));
    for (var i = 0; i < seg; i++) {
      var a = i / seg * Math.PI * 2;
      this.cyl('rail', 0.026, 0.026, h, cx + Math.cos(a) * r, y + h * 0.5,
        cz + Math.sin(a) * r, 0, 0, 0, 6);
    }
    this.torus('rail', r, 0.026, cx, y + h, cz, seg * 2);
    this.torus('rail', r, 0.020, cx, y + h * 0.52, cz, seg * 2);
    this.cyl('rail', r + 0.012, r + 0.012, 0.11, cx, y + 0.06, cz, 0, 0, 0, seg * 2, true);
  };

  // ---- cage ladder ---------------------------------------------------------
  // Vertical access with a hoop cage. Present on every column, every tank and
  // the flare derrick; the hoops are a fine repeating detail that catches a
  // flood beautifully and reads as "industrial" from 60 m.
  Builder.prototype.ladder = function (x, z, y0, y1, yaw, caged) {
    var sx = Math.cos(yaw) * 0.24, sz = Math.sin(yaw) * 0.24;
    this.tube('rail', x - sx, y0, z - sz, x - sx, y1, z - sz, 0.022, 5);
    this.tube('rail', x + sx, y0, z + sz, x + sx, y1, z + sz, 0.022, 5);
    var n = Math.max(1, Math.floor((y1 - y0) / 0.34));
    for (var i = 1; i < n; i++) {
      var ry = y0 + i * 0.34;
      this.tube('rail', x - sx, ry, z - sz, x + sx, ry, z + sz, 0.014, 4);
    }
    if (caged === false) return;
    var ox = -Math.sin(yaw) * 0.36, oz = Math.cos(yaw) * 0.36;
    var m = Math.max(1, Math.floor((y1 - (y0 + 2.4)) / 0.78));
    for (var k = 0; k <= m; k++) {
      var hy = y0 + 2.4 + k * 0.78;
      if (hy > y1 - 0.2) break;
      // three-quarter hoop, open on the climbing side
      for (var s = 0; s < 9; s++) {
        var a0 = yaw - 2.2 + s * (4.4 / 9), a1 = yaw - 2.2 + (s + 1) * (4.4 / 9);
        this.tube('rail',
          x + ox * 0.2 + Math.cos(a0) * 0.37, hy, z + oz * 0.2 + Math.sin(a0) * 0.37,
          x + ox * 0.2 + Math.cos(a1) * 0.37, hy, z + oz * 0.2 + Math.sin(a1) * 0.37,
          0.012, 4);
      }
    }
  };

  // ---- a flight of stairs between two levels -------------------------------
  Builder.prototype.stair = function (ax, ay, az, bx, by, bz, w) {
    w = w || 0.90;
    var dx = bx - ax, dz = bz - az, dy = by - ay;
    var run = Math.sqrt(dx * dx + dz * dz);
    if (run < 0.2 || dy < 0.2) return;
    var n = Math.max(2, Math.round(dy / 0.20));
    var yaw = Math.atan2(dx, dz);
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n;
      this.boxR('grate', w, 0.035, 0.29,
        ax + dx * t, ay + dy * (i + 1) / n - 0.02, az + dz * t, 0, yaw, 0, 0.006);
    }
    // stringers and a rail either side
    var px = Math.cos(yaw) * w * 0.5, pz = -Math.sin(yaw) * w * 0.5;
    this.strut('struct', ax + px, ay - 0.10, az + pz, bx + px, by - 0.10, bz + pz, 0.05, 0.24);
    this.strut('struct', ax - px, ay - 0.10, az - pz, bx - px, by - 0.10, bz - pz, 0.05, 0.24);
    this.tube('rail', ax + px, ay + 1.02, az + pz, bx + px, by + 1.02, bz + pz, 0.024, 6);
    this.tube('rail', ax - px, ay + 1.02, az - pz, bx - px, by + 1.02, bz - pz, 0.024, 6);
    var ns = Math.max(2, Math.round(run / 1.6));
    for (var s2 = 0; s2 <= ns; s2++) {
      var u = s2 / ns;
      this.cyl('rail', 0.022, 0.022, 1.02, ax + dx * u + px, ay + dy * u + 0.51,
        az + dz * u + pz, 0, 0, 0, 5);
      this.cyl('rail', 0.022, 0.022, 1.02, ax + dx * u - px, ay + dy * u + 0.51,
        az + dz * u - pz, 0, 0, 0, 5);
    }
  };

  // ---- a decal card --------------------------------------------------------
  function decalCard(B, cell, x, y, z, w, h, axis, roll) {
    var uvr = atlasUV(cell);
    var g = quad(w, h, uvr[0], uvr[1], uvr[2], uvr[3]);
    var rx = 0, ry = 0, rz = 0;
    if (axis === 'y') { rx = -Math.PI / 2; ry = roll || 0; }
    else if (axis === 'x') { ry = Math.PI / 2; rz = roll || 0; }
    else if (axis === '-x') { ry = -Math.PI / 2; rz = roll || 0; }
    else if (axis === '-z') { ry = Math.PI; rz = roll || 0; }
    else { rz = roll || 0; }
    B.add('decal', g, makeM(x, y, z, rx, ry, rz));
  }

  // ============================================================ PLUME MESHES ==
  // The flare flame, its smoke tail, and the steam vents. A lofted tube of
  // rings whose vertices are rewritten every frame from two decorrelated noise
  // fields - never a sine, because a sine reads as an animation curve within
  // two cycles. Colour is written per-vertex in LINEAR HDR (the flame core sits
  // around 7.5 in red), so postfx's bloom and the 'sodium' grade's wide
  // highlight roll-off get something real to work with.
  // A soft radial sprite. Smoke and steam are drawn as CAMERA-FACING PUFFS, not
  // as lofted tubes, and that is not a stylistic choice - the tube version was
  // built first and printed as a solid grey lens hanging beside the flare,
  // because a double-sided alpha tube draws its own front and back faces and
  // its silhouette is a hard geometric edge. A vapour plume has no edge. A
  // stack of soft sprites does not either.
  var _puffTex = null, _puffTried = false;
  function puffTexture() {
    if (_puffTried) return _puffTex;
    _puffTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 64;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    var img = g.createImageData(S, S);
    var d = img.data;
    var nz = GAME.noise;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
        var r = Math.sqrt(dx * dx + dy * dy);
        // a smooth core with a ragged, noise-broken rim
        var a = M.saturate(1 - r);
        a = a * a * (3 - 2 * a);
        var n = nz.fbm2(x * 0.09, y * 0.09, 3) * 0.5 + 0.5;
        a *= 0.52 + n * 0.72;
        a *= M.smoothstep(1.0, 0.62, r);
        var i = (y * S + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(M.saturate(a) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    _puffTex = t;
    return t;
  }

  // n camera-facing quads. Positions and colours are rewritten every frame.
  function puffGeometry(n) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4 * 4), 4));
    var uv = new Float32Array(n * 4 * 2);
    var idx = [];
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      uv[o * 2] = 0; uv[o * 2 + 1] = 0;
      uv[o * 2 + 2] = 1; uv[o * 2 + 3] = 0;
      uv[o * 2 + 4] = 1; uv[o * 2 + 5] = 1;
      uv[o * 2 + 6] = 0; uv[o * 2 + 7] = 1;
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return g;
  }

  function plumeGeometry(nRing, nRad) {
    var n = nRing * nRad;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    var idx = [];
    for (var r = 0; r < nRing - 1; r++) {
      for (var a = 0; a < nRad; a++) {
        var a2 = (a + 1) % nRad;
        var i0 = r * nRad + a, i1 = r * nRad + a2;
        var i2 = (r + 1) * nRad + a, i3 = (r + 1) * nRad + a2;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    return g;
  }

  // ================================================================= GROUND ==
  function buildGround(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var i, k;

    // ---- holes in the apron -------------------------------------------------
    // Each region below carries its own material, so the apron is cut around
    // them rather than being over-drawn. Coplanar over-draw is z-fighting, and
    // z-fighting on the largest surface in the level is not survivable.
    var holes = [
      [ROAD_X0, ROAD_X1, PAVE_Z0, PAVE_Z1],
      [XR_X0, XR_X1, XR_Z0, XR_Z1]
    ];
    for (i = 0; i < TANKS.length; i++) {
      var t = TANKS[i];
      holes.push([t.bx0 + 0.55, t.bx1 - 0.55, t.bz0 + 0.55, t.bz1 - 0.55]);
    }
    holes.push([PH_X0, PH_X1, PH_Z0, PH_Z1]);

    // ---- the apron -----------------------------------------------------------
    var apron = gridSurface(PAVE_X0, PAVE_X1, PAVE_Z0, PAVE_Z1, 2.6, gy, holes);
    B.paint = 'pave';
    B.add('pave', apron);

    // ---- the carriageways ----------------------------------------------------
    B.paint = 'road';
    B.add('road', gridSurface(ROAD_X0, ROAD_X1, PAVE_Z0, PAVE_Z1, 2.2, gy, null));
    B.add('road', gridSurface(XR_X0, ROAD_X0, XR_Z0, XR_Z1, 2.2, gy, null));
    B.add('road', gridSurface(ROAD_X1, XR_X1, XR_Z0, XR_Z1, 2.2, gy, null));

    // ---- bund floors ---------------------------------------------------------
    // Compacted sand and oil-stained grit inside the bund - never concrete.
    // It is a different material at a different level, which is what makes the
    // tank farm read as a separate PLACE rather than as more apron.
    B.paint = 'grit';
    for (i = 0; i < TANKS.length; i++) {
      var tb = TANKS[i];
      B.add('grit', gridSurface(tb.bx0 + 0.55, tb.bx1 - 0.55, tb.bz0 + 0.55, tb.bz1 - 0.55,
        2.4, gy, null));
    }

    // ---- gravel margin -------------------------------------------------------
    B.paint = 'grit';
    B.add('grit', gridSurface(SITE_X0, PAVE_X0, SITE_Z0, SITE_Z1, 5.0, gy, null));
    B.add('grit', gridSurface(PAVE_X1, SITE_X1, SITE_Z0, SITE_Z1, 5.0, gy, null));
    B.add('grit', gridSurface(PAVE_X0, PAVE_X1, SITE_Z0, PAVE_Z0, 5.0, gy, null));
    B.add('grit', gridSurface(PAVE_X0, PAVE_X1, PAVE_Z1, SITE_Z1, 5.0, gy, null));

    // ---- the desert the plant stands in --------------------------------------
    // Frustum-culled off, unlit by any practical, and carrying most of the
    // lower half of the overview frame. Without it the site ends in a straight
    // edge with sky under it.
    B.paint = 'sandy';
    B.add('sandy', gridSurface(-FAR_R, FAR_R, -FAR_R, FAR_R, 26.0,
      function (x, z) { return farY(x, z, N); },
      [[SITE_X0 + 1, SITE_X1 - 1, SITE_Z0 + 1, SITE_Z1 - 1]]));

    // ---- kerbs and channels --------------------------------------------------
    // The kerb line is the strongest continuous horizontal in every ground-level
    // framing and the thing that makes 170 m of road converge. Built as short
    // segments so it follows the grade instead of floating over it.
    B.paint = 'kerb';
    for (var side = 0; side < 2; side++) {
      var kx = side ? ROAD_X1 + 0.30 : ROAD_X0 - 0.30;
      for (var z = PAVE_Z0; z < PAVE_Z1 - 1.5; z += 3.0) {
        if (z + 3.0 > XR_Z0 - 0.5 && z < XR_Z1 + 0.5) continue;    // the junction
        var y0 = gy(kx, z + 1.5);
        B.box('kerb', 0.30, 0.36, 3.0, kx, y0 + 0.06, z + 1.5, 0.02);
      }
    }
    // drainage channel: a slot with a grating over it, both sides
    B.paint = 'steel';
    for (var s2 = 0; s2 < 2; s2++) {
      var cx = s2 ? ROAD_X1 + 0.62 : ROAD_X0 - 0.62;
      for (var z2 = PAVE_Z0; z2 < PAVE_Z1 - 2; z2 += 4.0) {
        if (z2 + 2 > XR_Z0 - 0.5 && z2 < XR_Z1 + 0.5) continue;
        var gy2 = gy(cx, z2 + 2.0);
        // every fifth bay the grating is missing and you can see the slot
        if (((z2 / 4) | 0) % 5 !== 3) {
          B.box('grate', 0.42, 0.030, 3.86, cx, gy2 + 0.075, z2 + 2.0, 0.006);
        } else {
          B.box('rust', 0.44, 0.05, 3.86, cx, gy2 - 0.11, z2 + 2.0, 0.008);
        }
      }
    }

    // ---- plinth kerb upstands ------------------------------------------------
    // A unit pad is retained by a 300 mm kerb all the way round. This is what
    // makes the 0.42 m step read as deliberate rather than as a terrain seam.
    B.paint = 'kerb';
    for (i = 0; i < PADS.length; i++) {
      var p = PADS[i];
      var h = p.h;
      for (var e = 0; e < 4; e++) {
        var ax, az, bx, bz;
        if (e === 0) { ax = p.x0; az = p.z0; bx = p.x1; bz = p.z0; }
        else if (e === 1) { ax = p.x1; az = p.z0; bx = p.x1; bz = p.z1; }
        else if (e === 2) { ax = p.x1; az = p.z1; bx = p.x0; bz = p.z1; }
        else { ax = p.x0; az = p.z1; bx = p.x0; bz = p.z0; }
        var dx = bx - ax, dz = bz - az;
        var len = Math.sqrt(dx * dx + dz * dz);
        var nseg = Math.max(1, Math.round(len / 4.0));
        for (k = 0; k < nseg; k++) {
          var tt = (k + 0.5) / nseg;
          var px = ax + dx * tt, pz = az + dz * tt;
          var yaw = Math.atan2(dx, dz);
          var base = siteGrade(px, pz, N);
          B.boxR('kerb', 0.34, h + 0.24, len / nseg + 0.02, px,
            base + (h + 0.24) * 0.5 - 0.10, pz, 0, yaw, 0, 0.015);
        }
      }
    }

    // ---- road markings and hazard striping -----------------------------------
    B.paint = 'flat';
    for (var mz = PAVE_Z0 + 3; mz < PAVE_Z1 - 3; mz += 7.0) {
      if (mz > XR_Z0 - 2 && mz < XR_Z1 + 2) continue;
      decalCard(B, CELL.tape, ROAD_CX + rng.range(-0.2, 0.2), gy(ROAD_CX, mz) + 0.012,
        mz, 0.36, 3.2, 'y', Math.PI * 0.5);
    }
    // chevrons across the head of every plinth kerb facing the road
    for (i = 0; i < PADS.length; i++) {
      var pd = PADS[i];
      var faceZ = (Math.abs(pd.z0) < Math.abs(pd.z1)) ? pd.z0 : pd.z1;
      for (k = 0; k < 5; k++) {
        var hx = pd.x0 + 1.4 + k * ((pd.x1 - pd.x0 - 2.8) / 4);
        decalCard(B, CELL.hazard, hx, groundY(hx, faceZ, N) + pd.h * 0 + 0.02,
          faceZ + (faceZ === pd.z0 ? -0.55 : 0.55), 2.2, 0.62, 'y', 0);
      }
    }
    // spills, scuffs and inspection marks scattered where the traffic goes
    for (i = 0; i < 120; i++) {
      var sx = rng.range(PAVE_X0 + 4, PAVE_X1 - 4);
      var sz = rng.range(PAVE_Z0 + 4, PAVE_Z1 - 4);
      // bias hard toward the road and the unit pads: stains are where work is
      if (rng.bool(0.55)) { sx = rng.range(ROAD_X0 - 4, ROAD_X1 + 4); }
      if (bundF(sx, sz) > 0.4 && rng.bool(0.6)) continue;
      var cellPick = rng.pick([CELL.spill, CELL.spill, CELL.scuff, CELL.cross, CELL.weep]);
      var sw = cellPick === CELL.spill ? rng.range(1.2, 3.6) : rng.range(0.9, 2.6);
      decalCard(B, cellPick, sx, groundY(sx, sz, N) + 0.014, sz,
        sw, sw * rng.range(0.7, 1.3), 'y', rng.range(0, Math.PI * 2));
    }

    // ---- floor colliders ------------------------------------------------------
    // Six coarse slabs rather than one: the sky-visibility bake rasterises the
    // collision set, and a single 190 m box would be one voxel-thick anyway but
    // would also make every raycast against the ground report the same surface
    // whatever the material under the shot.
    var FLOORS = [
      [PAVE_X0, ROAD_X0, PAVE_Z0, -30, 'concrete'],
      [PAVE_X0, ROAD_X0, -30, PAVE_Z1, 'concrete'],
      [ROAD_X0, ROAD_X1, PAVE_Z0, -20, 'asphalt'],
      [ROAD_X0, ROAD_X1, -20, PAVE_Z1, 'asphalt'],
      [ROAD_X1, PAVE_X1, PAVE_Z0, -30, 'concrete'],
      [ROAD_X1, PAVE_X1, -30, PAVE_Z1, 'concrete'],
      [SITE_X0, PAVE_X0, SITE_Z0, SITE_Z1, 'gravel'],
      [PAVE_X1, SITE_X1, SITE_Z0, SITE_Z1, 'gravel']
    ];
    for (i = 0; i < FLOORS.length; i++) {
      var f = FLOORS[i];
      var mx = (f[0] + f[1]) * 0.5, mz = (f[2] + f[3]) * 0.5;
      L.addCollider(mx, gy(mx, mz) - 0.30, mz,
        (f[1] - f[0]) * 0.5, 0.30, (f[3] - f[2]) * 0.5, f[4], true);
    }
  }

  // =========================================================== THE PERIMETER ==
  // A 2.6 m palisade with razor coil, on three sides, plus a gatehouse on the
  // south. It closes the composition without walling the player in, and at
  // dusk a chainlink screen with lamps behind it is one of the best depth cues
  // an industrial frame has.
  function buildFence(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var runs = [
      [SITE_X0 + 6, SITE_Z0 + 6, SITE_X1 - 6, SITE_Z0 + 6],
      [SITE_X0 + 6, SITE_Z0 + 6, SITE_X0 + 6, SITE_Z1 - 6],
      [SITE_X1 - 6, SITE_Z0 + 6, SITE_X1 - 6, SITE_Z1 - 6],
      [SITE_X0 + 6, SITE_Z1 - 6, ROAD_X0 - 4.5, SITE_Z1 - 6],
      [ROAD_X1 + 4.5, SITE_Z1 - 6, SITE_X1 - 6, SITE_Z1 - 6]
    ];
    B.paint = 'steel';
    for (var r = 0; r < runs.length; r++) {
      var q = runs[r];
      var dx = q[2] - q[0], dz = q[3] - q[1];
      var len = Math.sqrt(dx * dx + dz * dz);
      var n = Math.max(2, Math.round(len / 3.0));
      var yaw = Math.atan2(dx, dz);
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        var px = q[0] + dx * t, pz = q[1] + dz * t;
        var y0 = gy(px, pz);
        B.cyl('struct', 0.055, 0.055, 2.75, px, y0 + 1.30, pz, 0, 0, 0, 6);
        // the raked arm carrying the coil
        B.tube('struct', px, y0 + 2.55, pz,
          px - Math.sin(yaw + 1.5708) * 0.42, y0 + 3.05, pz - Math.cos(yaw + 1.5708) * 0.42,
          0.032, 5);
        if (i < n) {
          var t2 = (i + 0.5) / n;
          var mx = q[0] + dx * t2, mz = q[1] + dz * t2;
          var my = gy(mx, mz);
          B.boxR('chain', len / n + 0.05, 2.35, 0.02, mx, my + 1.32, mz, 0, yaw, 0, 0.004);
          B.boxR('struct', len / n + 0.05, 0.05, 0.05, mx, my + 2.52, mz, 0, yaw, 0, 0.008);
          B.boxR('struct', len / n + 0.05, 0.05, 0.05, mx, my + 0.14, mz, 0, yaw, 0, 0.008);
          // razor coil, as a run of overlapping rings
          for (var c = 0; c < 3; c++) {
            var cu = (i + (c + 0.5) / 3) / n;
            var cxx = q[0] + dx * cu, czz = q[1] + dz * cu;
            B.torus('chain', 0.30, 0.010, cxx - Math.sin(yaw + 1.5708) * 0.34,
              gy(cxx, czz) + 3.02, czz - Math.cos(yaw + 1.5708) * 0.34, 9);
          }
        }
      }
    }
    // the gate: two leaves standing open, and a gatehouse cabin
    B.paint = 'paint';
    var gz = SITE_Z1 - 6;
    for (var s = 0; s < 2; s++) {
      var sgn = s ? 1 : -1;
      var hx = sgn * 4.5;
      var by = gy(hx, gz);
      B.cyl('struct', 0.075, 0.075, 3.1, hx, by + 1.55, gz, 0, 0, 0, 7);
      // the leaf, swung 70 degrees back into the site
      B.pushXYZ(hx, by, gz, 0, sgn * 1.22, 0);
      B.boxR('chain', 4.4, 2.2, 0.02, sgn * 2.2, 1.35, 0, 0, 0, 0, 0.004);
      B.boxR('struct', 4.5, 0.07, 0.07, sgn * 2.2, 2.42, 0, 0, 0, 0, 0.01);
      B.boxR('struct', 4.5, 0.07, 0.07, sgn * 2.2, 0.30, 0, 0, 0, 0, 0.01);
      B.boxR('struct', 0.07, 2.2, 0.07, sgn * 4.4, 1.35, 0, 0, 0, 0, 0.01);
      B.pop();
      L.addCollider(sgn * 3.0, by + 1.2, gz - 1.6, 2.3, 1.2, 0.10, 'metal');
    }
    B.paint = 'flat';
    decalCard(B, CELL.danger, -4.5, gy(-4.5, gz) + 1.7, gz + 0.06, 1.1, 0.85, 'z');
    decalCard(B, CELL.nosmoke, 4.5, gy(4.5, gz) + 1.7, gz + 0.06, 0.9, 0.9, 'z');
    B.paint = 'steel';
  }

  // ============================================================== PIPE RACKS ==
  // The spatial spine of the level. A rack is a row of portal frames ("bents")
  // carrying tiers of process line, and what makes it photograph is that it is
  // a LATTICE: from the road you see through it to whatever is behind, and
  // every bent adds another vertical to the rhythm. 22 bents at 7.4 m is 158 m
  // of that rhythm, which is the whole reason the main road converges.
  //
  // Pipe diameters and services are laid out per tier from a fixed table, not
  // randomised: a rack in which the lines wander is a rack that reads as noise.
  // The RANDOM part is the wear, the sag, the odd missing lagging and where the
  // expansion loops fall.
  var WR_LINES = [
    // [tier, offset across the rack, radius, surface]
    [0, -3.55, 0.225, 'pipe'], [0, -2.85, 0.145, 'lag'], [0, -2.25, 0.115, 'pipe'],
    [0, -1.55, 0.290, 'lag'], [0, -0.65, 0.175, 'pipe_g'], [0, 0.20, 0.130, 'pipe'],
    [0, 0.85, 0.235, 'pipe_o'], [0, 1.75, 0.155, 'lag'], [0, 2.45, 0.105, 'pipe'],
    [0, 3.10, 0.195, 'pipe'], [0, 3.70, 0.120, 'pipe_g'],
    [1, -3.40, 0.160, 'lag'], [1, -2.70, 0.245, 'pipe'], [1, -1.90, 0.115, 'pipe_o'],
    [1, -1.25, 0.185, 'lag'], [1, -0.45, 0.135, 'pipe'], [1, 0.35, 0.265, 'pipe'],
    [1, 1.25, 0.150, 'pipe_g'], [1, 2.00, 0.110, 'pipe'], [1, 2.70, 0.205, 'lag'],
    [1, 3.45, 0.130, 'pipe'],
    [2, -3.20, 0.175, 'pipe'], [2, -2.45, 0.135, 'lag'], [2, -1.70, 0.220, 'pipe_o'],
    [2, -0.90, 0.110, 'pipe'], [2, -0.15, 0.155, 'pipe_g'], [2, 0.60, 0.190, 'lag']
  ];
  var ER_LINES = [
    [0, -2.60, 0.200, 'pipe'], [0, -1.90, 0.140, 'lag'], [0, -1.20, 0.255, 'pipe_o'],
    [0, -0.40, 0.115, 'pipe'], [0, 0.35, 0.180, 'lag'], [0, 1.10, 0.135, 'pipe_g'],
    [0, 1.80, 0.225, 'pipe'], [0, 2.55, 0.105, 'pipe'],
    [1, -2.40, 0.150, 'lag'], [1, -1.60, 0.210, 'pipe'], [1, -0.85, 0.120, 'pipe_g'],
    [1, -0.10, 0.175, 'pipe'], [1, 0.70, 0.245, 'lag'], [1, 1.50, 0.130, 'pipe_o'],
    [1, 2.30, 0.165, 'pipe']
  ];

  function buildRack(L, B, rng, N, spec) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var cx0 = spec.x - spec.half, cx1 = spec.x + spec.half;
    var top = spec.tiers[spec.tiers.length - 1] + 0.90;
    var nb = Math.max(2, Math.round((spec.z1 - spec.z0) / spec.pitch));
    var pitch = (spec.z1 - spec.z0) / nb;
    var i, k, t;
    var bentZ = [];

    // ---- the bents ----------------------------------------------------------
    B.paint = 'steel';
    for (i = 0; i <= nb; i++) {
      var z = spec.z0 + i * pitch;
      bentZ.push(z);
      var y0 = Math.min(gy(cx0, z), gy(cx1, z));
      // pad foundations
      B.paint = 'wall';
      B.box('wall', 0.90, 0.55, 0.90, cx0, y0 + 0.10, z, 0.02);
      B.box('wall', 0.90, 0.55, 0.90, cx1, y0 + 0.10, z, 0.02);
      B.paint = 'steel';
      // columns: an H section faked as a web plus two flanges
      for (k = 0; k < 2; k++) {
        var px = k ? cx1 : cx0;
        B.box('struct', 0.10, top, 0.30, px, y0 + top * 0.5 + 0.34, z, 0.012);
        B.box('struct', 0.30, top, 0.055, px, y0 + top * 0.5 + 0.34, z - 0.13, 0.010);
        B.box('struct', 0.30, top, 0.055, px, y0 + top * 0.5 + 0.34, z + 0.13, 0.010);
        // base plate + holding-down bolts
        B.box('struct', 0.44, 0.035, 0.44, px, y0 + 0.36, z, 0.006);
      }
      // transoms
      for (t = 0; t < spec.tiers.length; t++) {
        var ty = y0 + spec.tiers[t];
        B.box('struct', spec.half * 2 + 0.34, 0.055, 0.26, spec.x, ty + 0.135, z, 0.008);
        B.box('struct', spec.half * 2 + 0.34, 0.055, 0.26, spec.x, ty - 0.135, z, 0.008);
        B.box('struct', spec.half * 2 + 0.34, 0.24, 0.075, spec.x, ty, z, 0.008);
        // knee braces into the columns
        B.strut('struct', cx0 + 0.16, ty - 0.05, z, cx0 + 0.90, ty - 0.80, z, 0.055, 0.16);
        B.strut('struct', cx1 - 0.16, ty - 0.05, z, cx1 - 0.90, ty - 0.80, z, 0.055, 0.16);
      }
      L.addCollider(cx0, y0 + top * 0.5, z, 0.22, top * 0.5, 0.22, 'metal');
      L.addCollider(cx1, y0 + top * 0.5, z, 0.22, top * 0.5, 0.22, 'metal');
    }

    // ---- longitudinal bracing, every fourth bay -----------------------------
    for (i = 0; i < nb; i += 4) {
      var za = bentZ[i], zb = bentZ[Math.min(i + 1, nb)];
      var ya = Math.min(gy(cx0, za), gy(cx1, za));
      for (k = 0; k < 2; k++) {
        var bx = k ? cx1 : cx0;
        B.strut('struct', bx, ya + spec.tiers[0] + 0.2, za, bx, ya + top * 0.92, zb, 0.06, 0.14);
        B.strut('struct', bx, ya + top * 0.92, za, bx, ya + spec.tiers[0] + 0.2, zb, 0.06, 0.14);
      }
    }

    // ---- the lines ----------------------------------------------------------
    // Each run is broken into 3-bent lengths with a flanged joint between, so
    // the rack has a longitudinal rhythm as well as a transverse one.
    var runLen = pitch * 3;
    for (var lineI = 0; lineI < spec.lines.length; lineI++) {
      var ln = spec.lines[lineI];
      var lx = spec.x + ln[1], lr = ln[2], lkey = ln[3];
      var ly0 = spec.tiers[ln[0]] + 0.14 + lr;
      var swap = rng.range(0, 1);
      for (var seg = 0; seg * runLen < (spec.z1 - spec.z0); seg++) {
        var sz0 = spec.z0 + seg * runLen;
        var sz1 = Math.min(spec.z1, sz0 + runLen);
        if (sz1 - sz0 < 0.6) break;
        var ay = gy(lx, sz0) + ly0, by = gy(lx, sz1) + ly0;
        B.paint = (lkey === 'lag') ? 'lagging' : 'pipe';
        B.tube(lkey, lx, ay, sz0, lx, by, sz1, lr, lr > 0.19 ? 10 : 7);
        // flanged joint
        B.paint = 'steel';
        B.cyl('struct', lr * 1.55, lr * 1.55, 0.055, lx, by, sz1, Math.PI * 0.5, 0, 0,
          lr > 0.19 ? 12 : 8);
        // a lagged line loses its jacket here and there; the bare pipe under it
        // is the level's best small-scale storytelling and it is free
        if (lkey === 'lag' && rng.bool(0.14)) {
          B.paint = 'rusty';
          B.tube('rust', lx, ay + 0.001, sz0 + (sz1 - sz0) * 0.30,
            lx, by, sz0 + (sz1 - sz0) * 0.62, lr * 0.72, 7);
        }
      }
      // pipe shoes at every bent
      B.paint = 'steel';
      for (i = 0; i <= nb; i += 1) {
        var sz = bentZ[i];
        B.box('struct', lr * 1.4 + 0.06, 0.14, 0.16, lx, gy(lx, sz) + ly0 - lr - 0.07, sz, 0.006);
      }
      // service band + flow arrow, twice per line
      B.paint = 'flat';
      for (k = 0; k < 2; k++) {
        var dz = spec.z0 + (spec.z1 - spec.z0) * (0.22 + 0.46 * k + swap * 0.1);
        decalCard(B, k ? CELL.arrow : CELL.band, lx + lr + 0.006,
          gy(lx, dz) + ly0, dz, lr * 2.6, lr * 2.6, 'x', Math.PI * 0.5);
      }
      B.paint = 'steel';
    }

    // ---- electrical cable tray on the top tier ------------------------------
    B.paint = 'steel';
    var trayX = spec.x + spec.half - 1.15;
    for (i = 0; i < nb; i++) {
      var za2 = bentZ[i], zb2 = bentZ[i + 1];
      var ty2 = gy(trayX, (za2 + zb2) * 0.5) + spec.tiers[spec.tiers.length - 1] + 0.55;
      B.box('grate', 0.62, 0.030, zb2 - za2 + 0.02, trayX, ty2, (za2 + zb2) * 0.5, 0.006);
      B.box('struct', 0.030, 0.13, zb2 - za2 + 0.02, trayX - 0.31, ty2 + 0.06, (za2 + zb2) * 0.5, 0.005);
      B.box('struct', 0.030, 0.13, zb2 - za2 + 0.02, trayX + 0.31, ty2 + 0.06, (za2 + zb2) * 0.5, 0.005);
      // the cable bundle itself, sagging between supports
      B.paint = 'cable';
      B.tube('rust', trayX - 0.18, ty2 + 0.07, za2, trayX - 0.18, ty2 + 0.07, zb2, 0.055, 6);
      B.tube('rust', trayX + 0.06, ty2 + 0.06, za2, trayX + 0.06, ty2 + 0.06, zb2, 0.040, 6);
      B.paint = 'steel';
    }

    // ---- the walkway --------------------------------------------------------
    if (spec.deckY) {
      var wx = spec.x + spec.half - 0.62;
      B.paint = 'steel';
      for (i = 0; i < nb; i++) {
        var wa = bentZ[i], wb = bentZ[i + 1];
        var wy = gy(wx, (wa + wb) * 0.5) + spec.deckY;
        B.box('grate', 1.05, 0.035, wb - wa + 0.02, wx, wy, (wa + wb) * 0.5, 0.006);
        B.box('struct', 0.06, 0.22, wb - wa + 0.02, wx - 0.50, wy - 0.13, (wa + wb) * 0.5, 0.008);
        B.box('struct', 0.06, 0.22, wb - wa + 0.02, wx + 0.50, wy - 0.13, (wa + wb) * 0.5, 0.008);
      }
      var wy0 = gy(wx, spec.z0) + spec.deckY;
      B.railRun(wx - 0.52, spec.z0, wx - 0.52, spec.z1, wy0, 1.10);
      B.railRun(wx + 0.52, spec.z0, wx + 0.52, spec.z1, wy0, 1.10);
      L.addCollider(wx, wy0 - 0.12, (spec.z0 + spec.z1) * 0.5, 0.60, 0.12,
        (spec.z1 - spec.z0) * 0.5, 'metal', true);
    }

    // ---- expansion loops ----------------------------------------------------
    // A hot line has to be able to grow, so every 40-odd metres it makes a
    // rectangular excursion up and over. They are the most recognisable shape
    // in a pipe rack and there are exactly three, which is what a plant of this
    // size would have.
    for (i = 0; i < spec.loops.length; i++) {
      var lp = spec.loops[i];                  // {z, line}
      var el = spec.lines[lp.line % spec.lines.length];
      var elx = spec.x + el[1], elr = el[2], elKey = el[3];
      var ely = gy(elx, lp.z) + spec.tiers[el[0]] + 0.14 + elr;
      var rise = 2.05, half = 1.85, seg2 = elr > 0.19 ? 10 : 7;
      B.paint = (elKey === 'lag') ? 'lagging' : 'pipe';
      B.tube(elKey, elx, ely, lp.z - half - 0.7, elx, ely, lp.z - half, elr, seg2);
      B.tube(elKey, elx, ely, lp.z - half, elx, ely + rise, lp.z - half, elr, seg2);
      B.tube(elKey, elx, ely + rise, lp.z - half, elx, ely + rise, lp.z + half, elr, seg2);
      B.tube(elKey, elx, ely + rise, lp.z + half, elx, ely, lp.z + half, elr, seg2);
      B.tube(elKey, elx, ely, lp.z + half, elx, ely, lp.z + half + 0.7, elr, seg2);
      B.paint = 'steel';
      B.cyl('struct', elr * 1.5, elr * 1.5, 0.05, elx, ely + rise, lp.z,
        Math.PI * 0.5, 0, 0, 10);
    }
    B.paint = 'steel';
    return { bentZ: bentZ, cx0: cx0, cx1: cx1, top: top };
  }

  // ---- pipe bridges over the road -----------------------------------------
  // The rungs of the ladder the eye climbs down the road. Each one is a plate
  // girder spanning 30 m with its own lines on top, and each one is at a
  // different height so the three of them do not stack into a single band.
  function buildBridges(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    for (var i = 0; i < BRIDGES.length; i++) {
      var br = BRIDGES[i];
      var x0 = WR_X + WR_HALF - 0.6, x1 = ER_X - ER_HALF + 0.6;
      if (br.z < ER_Z0 || br.z > ER_Z1) x1 = 21.0;      // lands on the unit pad
      var y = gy(0, br.z) + br.y;
      var span = x1 - x0;
      B.paint = 'steel';
      // trussed girder: top and bottom chords plus a Warren web
      B.box('struct', span, 0.16, 0.30, (x0 + x1) * 0.5, y, br.z - 0.85, 0.012);
      B.box('struct', span, 0.16, 0.30, (x0 + x1) * 0.5, y, br.z + 0.85, 0.012);
      B.box('struct', span, 0.16, 0.30, (x0 + x1) * 0.5, y + 1.65, br.z - 0.85, 0.012);
      B.box('struct', span, 0.16, 0.30, (x0 + x1) * 0.5, y + 1.65, br.z + 0.85, 0.012);
      var np = Math.max(4, Math.round(span / 2.6));
      for (var p = 0; p <= np; p++) {
        var px = x0 + span * (p / np);
        B.strut('struct', px, y, br.z - 0.85, px, y + 1.65, br.z - 0.85, 0.10, 0.10);
        B.strut('struct', px, y, br.z + 0.85, px, y + 1.65, br.z + 0.85, 0.10, 0.10);
        if (p < np) {
          var px2 = x0 + span * ((p + 1) / np);
          B.strut('struct', px, y, br.z - 0.85, px2, y + 1.65, br.z - 0.85, 0.075, 0.075);
          B.strut('struct', px, y, br.z + 0.85, px2, y + 1.65, br.z + 0.85, 0.075, 0.075);
          B.strut('struct', px, y, br.z - 0.85, px, y, br.z + 0.85, 0.08, 0.08);
        }
      }
      // the lines it carries
      var svc = ['pipe', 'lag', 'pipe_o', 'pipe', 'pipe_g', 'lag'];
      for (var s = 0; s < 6; s++) {
        var oz = -0.70 + s * 0.28;
        var rr = 0.085 + (s % 3) * 0.055;
        B.paint = svc[s] === 'lag' ? 'lagging' : 'pipe';
        B.tube(svc[s], x0 - 1.2, y + 1.80 + rr, br.z + oz, x1 + 1.2, y + 1.80 + rr, br.z + oz, rr, 7);
      }
      B.paint = 'steel';
      // access walkway along the downstream face, with rails
      B.box('grate', span, 0.035, 0.95, (x0 + x1) * 0.5, y + 1.72, br.z + 1.45, 0.006);
      B.railRun(x0, br.z + 1.92, x1, br.z + 1.92, y + 1.72, 1.05);
      B.railRun(x0, br.z + 0.98, x1, br.z + 0.98, y + 1.72, 1.05);
      // hazard striping on the underside of the near chord: this is what a
      // driver sees and it is what makes the clearance read from the road
      B.paint = 'flat';
      for (var h = 0; h < 5; h++) {
        var hx = x0 + span * (0.12 + h * 0.19);
        decalCard(B, CELL.hazard, hx, y - 0.09, br.z + 1.02, 2.4, 0.42, 'z');
      }
      B.paint = 'steel';
      L.addCollider((x0 + x1) * 0.5, y + 0.9, br.z, span * 0.5, 1.0, 1.1, 'metal');
    }
  }

  // ========================================================= TIE-IN MANIFOLDS ==
  // Sleeper-mounted pipe runs and valve manifolds on both verges of the main
  // road. They exist for a compositional reason as much as an industrial one:
  // the hero1 standpoint looks down 170 m of road, and without something built
  // at 5-20 m the bottom third of that frame is bare tarmac. A manifold is a
  // dense, waist-height, strongly-lit object with real silhouette, which is
  // exactly what a foreground has to be.
  //
  // They are LEVEL geometry, not props: they are permanent plant, they carry
  // colliders, and props_refinery places its clutter against them by anchor.
  var MANIFOLDS = [
    { x: 10.6, z: 20.0, yaw: 0.0, n: 5, w: 6.4 },
    { x: -10.6, z: -2.0, yaw: Math.PI, n: 4, w: 5.2 },
    { x: 10.6, z: -34.0, yaw: 0.0, n: 5, w: 6.4 },
    { x: -10.6, z: -62.0, yaw: Math.PI, n: 4, w: 5.2 }
  ];

  function buildManifolds(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var out = [];
    for (var m = 0; m < MANIFOLDS.length; m++) {
      var Mf = MANIFOLDS[m];
      var base = gy(Mf.x, Mf.z);
      var side = Math.cos(Mf.yaw) > 0 ? 1 : -1;      // which way the risers face
      var i;
      // ---- the sleeper run --------------------------------------------------
      // Four lines on concrete sleepers running parallel with the road. This is
      // the low horizontal that ties the manifolds together down the verge.
      B.paint = 'wall';
      for (i = 0; i < 7; i++) {
        var sz = Mf.z - Mf.w * 0.5 + Mf.w * (i / 6);
        B.box('wall', 2.1, 0.34, 0.42, Mf.x, gy(Mf.x, sz) + 0.13, sz, 0.02);
      }
      B.paint = 'pipe';
      var svc = ['pipe', 'lag', 'pipe_o', 'pipe_g'];
      for (i = 0; i < 4; i++) {
        var lr = 0.11 + (i % 3) * 0.07;
        var lx = Mf.x - 0.78 + i * 0.52;
        B.paint = (svc[i] === 'lag') ? 'lagging' : 'pipe';
        B.tube(svc[i], lx, base + 0.42 + lr, Mf.z - Mf.w * 0.5 - 3.0,
          lx, base + 0.42 + lr, Mf.z + Mf.w * 0.5 + 3.0, lr, 8);
      }
      // ---- the risers and their valves ---------------------------------------
      B.paint = 'pipe';
      var bays = [];
      for (i = 0; i < Mf.n; i++) {
        var rz = Mf.z - Mf.w * 0.5 + Mf.w * ((i + 0.5) / Mf.n);
        var rr = 0.10 + (i % 3) * 0.045;
        var rx = Mf.x + side * 0.95;
        var ry = base + 1.55 + (i % 2) * 0.35;
        B.tube('pipe', rx, base + 0.55, rz, rx, ry, rz, rr, 8);
        B.tube('pipe', rx, ry, rz, Mf.x - side * 0.55, ry, rz, rr, 8);
        // the valve: body, bonnet, and a handwheel standing proud of it
        B.paint = 'paint';
        B.cyl('pipe_g', rr * 2.1, rr * 2.1, rr * 2.6, rx, ry - 0.55, rz, 0, 0, 0, 10);
        B.cyl('struct', rr * 0.55, rr * 0.9, 0.30, rx, ry - 0.20, rz, 0, 0, 0, 8);
        B.torus('rail', 0.26, 0.028, rx, ry - 0.03, rz, 14);
        for (var sp2 = 0; sp2 < 4; sp2++) {
          var sa = sp2 / 4 * Math.PI * 2;
          B.boxR('rail', 0.026, 0.026, 0.52, rx, ry - 0.03, rz, 0, sa, 0, 0.005);
        }
        B.cyl('rail', 0.045, 0.045, 0.09, rx, ry + 0.02, rz, 0, 0, 0, 8);
        B.paint = 'steel';
        B.cyl('struct', rr * 2.4, rr * 2.4, 0.05, rx, ry - 0.90, rz, 0, 0, 0, 12);
        B.paint = 'flat';
        decalCard(B, CELL.valve, rx + side * (rr * 2.2), ry - 0.55, rz + 0.02,
          0.26, 0.26, side > 0 ? 'x' : '-x');
        B.paint = 'pipe';
        bays.push({ position: new THREE.Vector3(rx, base, rz) });
      }
      // ---- support frame and access -------------------------------------------
      B.paint = 'steel';
      var fx = Mf.x + side * 0.95;
      B.box('struct', 0.12, 2.30, 0.12, fx, base + 1.15, Mf.z - Mf.w * 0.5 - 0.35, 0.01);
      B.box('struct', 0.12, 2.30, 0.12, fx, base + 1.15, Mf.z + Mf.w * 0.5 + 0.35, 0.01);
      B.box('struct', 0.14, 0.14, Mf.w + 0.9, fx, base + 2.28, Mf.z, 0.01);
      B.box('grate', 1.20, 0.035, Mf.w + 0.7, fx + side * 0.85, base + 0.62, Mf.z, 0.006);
      B.railRun(fx + side * 1.42, Mf.z - Mf.w * 0.5 - 0.3, fx + side * 1.42,
        Mf.z + Mf.w * 0.5 + 0.3, base + 0.62, 1.05);
      B.stair(fx + side * 2.6, gy(fx + side * 2.6, Mf.z + Mf.w * 0.5 + 1.4),
        Mf.z + Mf.w * 0.5 + 1.4, fx + side * 1.5, base + 0.62, Mf.z + Mf.w * 0.5 + 0.2, 0.85);
      // hazard bollards facing the road: the near-field chroma of hero1
      B.paint = 'paint';
      for (i = 0; i < 4; i++) {
        var bz = Mf.z - Mf.w * 0.5 + Mf.w * (i / 3);
        var bx2 = Mf.x - side * 1.55;
        B.cyl('rail', 0.075, 0.085, 1.05, bx2, gy(bx2, bz) + 0.52, bz, 0, 0, 0, 8);
        B.paint = 'flat';
        decalCard(B, CELL.hazard, bx2 - side * 0.086, gy(bx2, bz) + 0.78, bz,
          0.55, 0.30, side > 0 ? '-x' : 'x');
        B.paint = 'paint';
      }
      B.paint = 'flat';
      decalCard(B, CELL.unitno, Mf.x - side * 0.35, base + 2.36, Mf.z, 1.5, 1.5, 'y', Mf.yaw);
      decalCard(B, CELL.spill, Mf.x - side * 1.0, base + 0.02, Mf.z, 3.4, 3.4, 'y', Mf.yaw);
      B.paint = 'steel';

      L.addCollider(Mf.x + side * 0.5, base + 0.9, Mf.z, 1.4, 0.9, Mf.w * 0.5 + 0.5, 'metal');
      out.push({ position: new THREE.Vector3(Mf.x, base, Mf.z), yaw: Mf.yaw,
                 w: Mf.w, side: side, bays: bays });
    }
    return out;
  }

  // ======================================================== UNIT 200: COLUMNS ==
  // Four fractionating columns, 41 / 32 / 25 / 18.5 m, standing on a common
  // kerbed plinth east of the road. They are the level's vertical landmark and
  // the thing the cold floods are aimed at.
  //
  // A bare cylinder photographs as a bare cylinder. What makes a column read is
  // the FURNITURE: the skirt and its fire-proofing, the horizontal band lines
  // of the insulation jacketing, a platform ring every 5-6 m with its handrail
  // and toe plate, the caged ladder running the full height in staggered runs,
  // the nozzle bosses and their reinforcing pads, the overhead vapour line
  // arcing off the top, and a relief valve on a stub at the very top. All of
  // that is silhouette, and silhouette is the entire brief.
  function buildColumns(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var out = [];
    for (var c = 0; c < COLS.length; c++) {
      var C = COLS[c];
      var base = gy(C.x, C.z);
      var skirtH = 2.6 + c * 0.15;
      var shellY0 = base + skirtH;
      var top = shellY0 + C.h;
      var r = C.r;

      // ---- foundation and skirt ---------------------------------------------
      B.paint = 'wall';
      B.cyl('wall', r + 0.85, r + 1.05, 0.55, C.x, base + 0.24, C.z, 0, 0, 0, 20);
      B.paint = 'refractory';
      B.cyl('refract', r + 0.10, r + 0.16, skirtH, C.x, base + skirtH * 0.5, C.z, 0, 0, 0, 20);
      // access opening in the skirt, and the vent slots around it
      B.paint = 'steel';
      B.box('struct', 0.95, 1.55, 0.14, C.x - r - 0.06, base + 0.80, C.z, 0.01);
      for (var v = 0; v < 8; v++) {
        var va = v / 8 * Math.PI * 2 + 0.4;
        B.box('rust', 0.30, 0.16, 0.12,
          C.x + Math.cos(va) * (r + 0.11), base + skirtH - 0.35, C.z + Math.sin(va) * (r + 0.11), 0.01);
      }

      // ---- the shell, in lagged courses --------------------------------------
      // Built as stacked segments with a proud band at each joint. Real jacketing
      // is banded every 1.2 m and those bands are what catch a raking flood.
      var seg = 22;
      var nCourse = Math.max(4, Math.round(C.h / 3.1));
      B.paint = 'lagging';
      for (var q = 0; q < nCourse; q++) {
        var cy0 = shellY0 + C.h * (q / nCourse);
        var cy1 = shellY0 + C.h * ((q + 1) / nCourse);
        // the top third of a fractionator is usually a smaller diameter
        var rq0 = r * (q > nCourse * 0.66 ? 0.80 : 1.0);
        var rq1 = r * ((q + 1) > nCourse * 0.66 ? 0.80 : 1.0);
        B.cyl('lag', rq1, rq0, cy1 - cy0, C.x, (cy0 + cy1) * 0.5, C.z, 0, 0, 0, seg, true);
        B.paint = 'steel';
        B.cyl('struct', rq0 * 1.022, rq0 * 1.022, 0.075, C.x, cy0 + 0.04, C.z, 0, 0, 0, seg, true);
        B.paint = 'lagging';
      }
      // swage between the two diameters, and the domed head
      var rTop = r * 0.80;
      var swY = shellY0 + C.h * 0.667;
      B.cyl('lag', rTop, r, 0.85, C.x, swY, C.z, 0, 0, 0, seg, true);
      B.cyl('lag', rTop * 0.55, rTop, 0.75, C.x, top + 0.36, C.z, 0, 0, 0, seg, true);
      B.cyl('lag', 0.10, rTop * 0.55, 0.32, C.x, top + 0.88, C.z, 0, 0, 0, seg, true);

      // ---- platform rings -----------------------------------------------------
      var plats = [];
      for (var p = 0; p < C.plat; p++) {
        var py = shellY0 + 2.4 + (C.h - 3.6) * (p / Math.max(1, C.plat - 1));
        var pr = (py > swY ? rTop : r);
        var out2 = pr + 1.30;
        plats.push(py);
        B.paint = 'steel';
        B.ring('grate', pr + 0.03, out2, C.x, py, C.z, seg);
        // cantilever brackets under it
        for (var bkt = 0; bkt < 8; bkt++) {
          var ba = bkt / 8 * Math.PI * 2 + 0.2;
          B.strut('struct',
            C.x + Math.cos(ba) * (pr + 0.05), py - 0.90, C.z + Math.sin(ba) * (pr + 0.05),
            C.x + Math.cos(ba) * out2, py - 0.04, C.z + Math.sin(ba) * out2, 0.05, 0.16);
        }
        B.railRing(C.x, C.z, out2 - 0.06, py, 1.10, Math.max(12, Math.round(out2 * 2.4)));
      }

      // ---- ladders, staggered between platforms -------------------------------
      var lyaw = 0.55;
      var prev = base + skirtH * 0.2;
      for (var li = 0; li < plats.length; li++) {
        var pr2 = (plats[li] > swY ? rTop : r) + 1.24;
        B.ladder(C.x + Math.cos(lyaw) * pr2, C.z + Math.sin(lyaw) * pr2,
          prev, plats[li] + 1.05, lyaw + Math.PI, li > 0);
        prev = plats[li];
        lyaw += 2.05;
      }

      // ---- nozzles, manways and the reinforcing pads --------------------------
      B.paint = 'steel';
      for (var nz = 0; nz < 12 + c * 2; nz++) {
        var na = rng.range(0, Math.PI * 2);
        var ny = shellY0 + rng.range(0.8, C.h - 1.2);
        var nr2 = (ny > swY ? rTop : r);
        var nrad = rng.range(0.09, 0.30);
        var ex = Math.cos(na), ez = Math.sin(na);
        B.tube('pipe', C.x + ex * nr2 * 0.98, ny, C.z + ez * nr2 * 0.98,
          C.x + ex * (nr2 + 0.42), ny, C.z + ez * (nr2 + 0.42), nrad, 8);
        B.cyl('struct', nrad * 1.6, nrad * 1.6, 0.05,
          C.x + ex * (nr2 + 0.44), ny, C.z + ez * (nr2 + 0.44),
          Math.PI * 0.5, -na + Math.PI * 0.5, 0, 10);
      }
      // manway on the lowest platform
      B.tube('pipe', C.x - r * 0.98, plats[0] + 0.65, C.z, C.x - r - 0.40, plats[0] + 0.65, C.z, 0.34, 12);
      B.cyl('struct', 0.55, 0.55, 0.06, C.x - r - 0.42, plats[0] + 0.65, C.z, Math.PI * 0.5, 0, 0, 14);

      // ---- the overhead line --------------------------------------------------
      // A big vapour line leaving the top and sweeping down to the rack. It is
      // the only long DIAGONAL in a level otherwise made of verticals and
      // horizontals, and it is what ties the column row to the pipe rack.
      B.paint = 'lagging';
      var ohR = 0.34 + c * 0.03;
      var ohY = top + 0.3;
      var midX = (C.x + ER_X) * 0.5;
      B.tube('lag', C.x, ohY, C.z, C.x - 2.2, ohY + 0.9, C.z, ohR, 10);
      B.tube('lag', C.x - 2.2, ohY + 0.9, C.z, midX, ohY * 0.62 + 3.0, C.z - 1.0, ohR, 10);
      B.tube('lag', midX, ohY * 0.62 + 3.0, C.z - 1.0,
        ER_X + 0.4, gy(ER_X, C.z) + ER_TIERS[1] + 0.9, C.z - 1.6, ohR, 10);
      B.paint = 'steel';

      // ---- markings ------------------------------------------------------------
      B.paint = 'flat';
      decalCard(B, CELL.unitno, C.x - r - 0.20, shellY0 + 1.5, C.z, 1.8, 1.8, '-x');
      decalCard(B, CELL.danger, C.x - r - 0.18, base + 1.55, C.z + 1.1, 0.95, 0.75, '-x');
      decalCard(B, CELL.weep, C.x, base + skirtH * 0.6, C.z + r + 0.18, r * 1.4, skirtH * 0.9, 'z');
      B.paint = 'steel';

      L.addCollider(C.x, base + (top - base) * 0.5, C.z, r + 0.2, (top - base) * 0.5, r + 0.2,
        'metal');

      out.push({
        name: C.name, x: C.x, z: C.z, r: r, h: C.h, top: top,
        plinthY: base, shellY: shellY0, platforms: plats,
        position: new THREE.Vector3(C.x, base, C.z)
      });
    }

    // ---- interconnecting catwalks ---------------------------------------------
    // Two runs of grating linking the column platforms at 14.2 and 23.1 m. They
    // are the "catwalks" of the brief, they are the reason the column row reads
    // as one STRUCTURE rather than as four separate objects, and from the road
    // they draw two horizontal lines across the whole silhouette at heights
    // nothing else in the level occupies.
    var cats = [];
    for (var lvl = 0; lvl < CAT_Y.length; lvl++) {
      var y = groundY(COLS[0].x, COLS[0].z, N) + CAT_Y[lvl];
      var reach = [];
      for (var ci = 0; ci < out.length; ci++) {
        if (out[ci].top > y + 1.2) reach.push(out[ci]);
      }
      if (reach.length < 2) continue;
      for (var s = 0; s + 1 < reach.length; s++) {
        var a = reach[s], b2 = reach[s + 1];
        var ax = a.x, az = a.z + (b2.z > a.z ? a.r + 1.3 : -(a.r + 1.3));
        var bx = b2.x, bz = b2.z + (b2.z > a.z ? -(b2.r + 1.3) : b2.r + 1.3);
        var dx = bx - ax, dz = bz - az;
        var len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1.0) continue;
        var yaw = Math.atan2(dx, dz);
        B.paint = 'steel';
        B.boxR('grate', 1.15, 0.035, len, (ax + bx) * 0.5, y, (az + bz) * 0.5, 0, yaw, 0, 0.006);
        B.boxR('struct', 0.07, 0.26, len, (ax + bx) * 0.5 - Math.cos(yaw) * 0.56, y - 0.15,
          (az + bz) * 0.5 + Math.sin(yaw) * 0.56, 0, yaw, 0, 0.008);
        B.boxR('struct', 0.07, 0.26, len, (ax + bx) * 0.5 + Math.cos(yaw) * 0.56, y - 0.15,
          (az + bz) * 0.5 - Math.sin(yaw) * 0.56, 0, yaw, 0, 0.008);
        B.railRun(ax - Math.cos(yaw) * 0.58, az + Math.sin(yaw) * 0.58,
          bx - Math.cos(yaw) * 0.58, bz + Math.sin(yaw) * 0.58, y, 1.10);
        B.railRun(ax + Math.cos(yaw) * 0.58, az - Math.sin(yaw) * 0.58,
          bx + Math.cos(yaw) * 0.58, bz - Math.sin(yaw) * 0.58, y, 1.10);
        L.addCollider((ax + bx) * 0.5, y - 0.12, (az + bz) * 0.5, 0.7, 0.12, len * 0.5,
          'metal', true, _e1.set(0, yaw, 0, 'YXZ'));
        cats.push({ y: y, from: new THREE.Vector3(ax, y, az), to: new THREE.Vector3(bx, y, bz) });
      }
    }
    return { columns: out, catwalks: cats };
  }

  // =============================================================== TANK FARM ==
  // Two 29 m crude tanks and one 20 m product tank, each in its own bund. The
  // tank farm is the level's answer to "a level that photographs well in one
  // pose and is empty everywhere else": it is a completely different KIND of
  // space from the process area - huge smooth curved masses, a dished floor you
  // walk down into, and 40 m of clear sky between the bund walls. hero3 lives
  // here and it looks nothing like hero1.
  function buildTanks(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var out = [];
    for (var i = 0; i < TANKS.length; i++) {
      var T = TANKS[i];
      var floorY = groundY(T.x, T.z, N);
      var roofY = floorY + T.h;
      var seg = 40;

      // ---- the bund wall ------------------------------------------------------
      // Reinforced concrete, 1.9 m, with a stepover stair on the road side and
      // weep-stained faces. It is the horizontal that anchors the bottom of
      // every tank framing.
      B.paint = 'wall';
      var wt = 0.42;
      var wallY = siteGrade((T.bx0 + T.bx1) * 0.5, (T.bz0 + T.bz1) * 0.5, N);
      var segs = [
        [T.bx0, T.bz0, T.bx1, T.bz0], [T.bx1, T.bz0, T.bx1, T.bz1],
        [T.bx1, T.bz1, T.bx0, T.bz1], [T.bx0, T.bz1, T.bx0, T.bz0]
      ];
      for (var s = 0; s < 4; s++) {
        var q = segs[s];
        var dx = q[2] - q[0], dz = q[3] - q[1];
        var len = Math.sqrt(dx * dx + dz * dz);
        var yaw = Math.atan2(dx, dz);
        var n = Math.max(1, Math.round(len / 5.0));
        for (var k = 0; k < n; k++) {
          var t = (k + 0.5) / n;
          var px = q[0] + dx * t, pz = q[1] + dz * t;
          var by = siteGrade(px, pz, N);
          B.boxR('wall', wt, T.bh + 0.9, len / n + 0.02, px, by + (T.bh - 0.9) * 0.5, pz,
            0, yaw, 0, 0.02);
          // coping
          B.boxR('kerb', wt + 0.10, 0.10, len / n + 0.02, px, by + T.bh + 0.05, pz,
            0, yaw, 0, 0.012);
        }
        L.addCollider((q[0] + q[2]) * 0.5, wallY + T.bh * 0.5, (q[1] + q[3]) * 0.5,
          Math.max(wt * 0.5, Math.abs(dx) * 0.5), T.bh * 0.5 + 0.4,
          Math.max(wt * 0.5, Math.abs(dz) * 0.5), 'concrete');
      }
      // stepover stair on the east wall, so the bund is enterable
      B.paint = 'steel';
      var soZ = (T.bz0 + T.bz1) * 0.5 + T.stair * 3.0;
      B.stair(T.bx1 + 2.6, siteGrade(T.bx1 + 2.6, soZ, N), soZ,
        T.bx1 + 0.55, siteGrade(T.bx1, soZ, N) + T.bh + 0.10, soZ, 1.0);
      B.box('grate', 1.6, 0.035, 1.1, T.bx1, siteGrade(T.bx1, soZ, N) + T.bh + 0.10, soZ, 0.006);
      B.stair(T.bx1 - 0.55, siteGrade(T.bx1, soZ, N) + T.bh + 0.10, soZ,
        T.bx1 - 2.6, floorY + 0.05, soZ, 1.0);

      // ---- the shell ----------------------------------------------------------
      // Built in 2.0 m plate courses. Real tanks are thicker at the bottom, so
      // each course steps out very slightly - the resulting shadow lines are the
      // only thing giving a 29 m grey cylinder any scale.
      B.paint = 'tank';
      var nc = Math.max(4, Math.round(T.h / 2.0));
      for (var c2 = 0; c2 < nc; c2++) {
        var y0 = floorY + T.h * (c2 / nc), y1 = floorY + T.h * ((c2 + 1) / nc);
        var rr = T.r + (nc - c2) * 0.006;
        B.cyl('tank', rr - 0.006, rr, y1 - y0, T.x, (y0 + y1) * 0.5, T.z, 0, 0, 0, seg, true);
        // the weld seam
        B.paint = 'seam';
        B.cyl('tank', rr + 0.012, rr + 0.012, 0.035, T.x, y0 + 0.02, T.z, 0, 0, 0, seg, true);
        B.paint = 'tank';
      }
      // wind girder near the top - a projecting ring walkway, and the single
      // most recognisable feature of a large storage tank
      B.paint = 'steel';
      B.ring('grate', T.r + 0.02, T.r + 0.95, T.x, floorY + T.h - 1.30, T.z, seg);
      B.railRing(T.x, T.z, T.r + 0.90, floorY + T.h - 1.30, 1.05, 26);
      for (var wb = 0; wb < 18; wb++) {
        var wa = wb / 18 * Math.PI * 2;
        B.strut('struct',
          T.x + Math.cos(wa) * (T.r + 0.03), floorY + T.h - 2.10, T.z + Math.sin(wa) * (T.r + 0.03),
          T.x + Math.cos(wa) * (T.r + 0.92), floorY + T.h - 1.34, T.z + Math.sin(wa) * (T.r + 0.92),
          0.05, 0.14);
      }
      // ---- roof ---------------------------------------------------------------
      B.paint = 'tank';
      B.cyl('tank', T.r * 0.10, T.r, 1.35, T.x, roofY + 0.62, T.z, 0, 0, 0, seg, true);
      B.ring('tank', 0, T.r * 0.10, T.x, roofY + 1.30, T.z, 12);
      // roof furniture: the gauge hatch, two vents and the foam pourers
      B.paint = 'steel';
      B.cyl('struct', 0.28, 0.28, 0.70, T.x + T.r * 0.35, roofY + 1.05, T.z - T.r * 0.20, 0, 0, 0, 10);
      B.cyl('struct', 0.42, 0.30, 0.55, T.x - T.r * 0.30, roofY + 1.12, T.z + T.r * 0.28, 0, 0, 0, 10);
      B.railRing(T.x, T.z, T.r - 0.35, roofY + 0.30, 1.05, 26);
      for (var fp = 0; fp < 4; fp++) {
        var fa = fp / 4 * Math.PI * 2 + 0.7;
        B.tube('pipe', T.x + Math.cos(fa) * T.r, floorY + T.h - 0.9, T.z + Math.sin(fa) * T.r,
          T.x + Math.cos(fa) * (T.r + 0.5), floorY + T.h - 0.3, T.z + Math.sin(fa) * (T.r + 0.5),
          0.075, 6);
      }

      // ---- the spiral stair ---------------------------------------------------
      // 360 degrees of it, clockwise from the bund floor to the wind girder.
      // Twenty-four flights of grating with a rail on the outside: it is the
      // detail that makes a tank read as a tank at 60 m and it is beautiful in
      // a raking flood.
      var turns = 1.0, steps = 46;
      var sr = T.r + 0.62;
      for (var st = 0; st < steps; st++) {
        var a0 = T.stair + (st / steps) * Math.PI * 2 * turns;
        var a1 = T.stair + ((st + 1) / steps) * Math.PI * 2 * turns;
        var sy0 = floorY + 0.25 + (T.h - 1.75) * (st / steps);
        var sy1 = floorY + 0.25 + (T.h - 1.75) * ((st + 1) / steps);
        var x0 = T.x + Math.cos(a0) * sr, z0 = T.z + Math.sin(a0) * sr;
        var x1 = T.x + Math.cos(a1) * sr, z1 = T.z + Math.sin(a1) * sr;
        var syaw = Math.atan2(x1 - x0, z1 - z0);
        var slen = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
        B.paint = 'steel';
        B.boxR('grate', 1.05, 0.035, slen + 0.05, (x0 + x1) * 0.5, (sy0 + sy1) * 0.5,
          (z0 + z1) * 0.5, 0, syaw, 0, 0.006);
        // stringer and outer rail
        B.strut('struct', x0 + Math.cos(a0) * 0.52, sy0 - 0.12, z0 + Math.sin(a0) * 0.52,
          x1 + Math.cos(a1) * 0.52, sy1 - 0.12, z1 + Math.sin(a1) * 0.52, 0.045, 0.20);
        B.tube('rail', x0 + Math.cos(a0) * 0.52, sy0 + 1.02, z0 + Math.sin(a0) * 0.52,
          x1 + Math.cos(a1) * 0.52, sy1 + 1.02, z1 + Math.sin(a1) * 0.52, 0.024, 5);
        if (st % 3 === 0) {
          B.cyl('rail', 0.022, 0.022, 1.02, x0 + Math.cos(a0) * 0.52, sy0 + 0.51,
            z0 + Math.sin(a0) * 0.52, 0, 0, 0, 5);
          // bracket back to the shell
          B.strut('struct', x0, sy0 - 0.10, z0,
            T.x + Math.cos(a0) * T.r, sy0 - 0.10, T.z + Math.sin(a0) * T.r, 0.05, 0.12);
        }
      }

      // ---- nozzles and the line to the pumps -----------------------------------
      B.paint = 'pipe';
      var oa = T.stair + Math.PI;
      var ox = T.x + Math.cos(oa) * T.r, oz = T.z + Math.sin(oa) * T.r;
      B.tube('pipe', ox, floorY + 0.55, oz,
        ox + Math.cos(oa) * 2.4, floorY + 0.55, oz + Math.sin(oa) * 2.4, 0.26, 10);
      B.tube('pipe', ox + Math.cos(oa) * 2.4, floorY + 0.55, oz + Math.sin(oa) * 2.4,
        ox + Math.cos(oa) * 2.4, floorY + 1.85, oz + Math.sin(oa) * 2.4, 0.26, 10);
      B.paint = 'steel';
      B.cyl('struct', 0.42, 0.42, 0.30, ox + Math.cos(oa) * 2.4, floorY + 1.10,
        oz + Math.sin(oa) * 2.4, 0, 0, 0, 12);
      B.box('rail', 0.55, 0.06, 0.10, ox + Math.cos(oa) * 2.4, floorY + 1.42,
        oz + Math.sin(oa) * 2.4, 0.01);

      // ---- markings -------------------------------------------------------------
      B.paint = 'flat';
      // MEASURED. The tank number was drawn at 0.75 x the RADIUS - a 10.9 m
      // stencil - and the weep streaks at 85% of the shell height, so hero3
      // came back with what looked like black brush strokes painted across the
      // tank. A real tank number is about 3 m and the streaks are narrow.
      var ma = T.stair - 1.9;
      decalCard(B, CELL.tank, T.x + Math.cos(ma) * (T.r + 0.03), floorY + T.h * 0.62,
        T.z + Math.sin(ma) * (T.r + 0.03), 3.4, 3.4, 'z', 0);
      decalCard(B, CELL.flam, T.x + Math.cos(ma + 0.42) * (T.r + 0.03), floorY + 2.4,
        T.z + Math.sin(ma + 0.42) * (T.r + 0.03), 1.4, 1.4, 'z', 0);
      for (var wpe = 0; wpe < 7; wpe++) {
        var wa2 = rng.range(0, Math.PI * 2);
        decalCard(B, CELL.weep, T.x + Math.cos(wa2) * (T.r + 0.03),
          floorY + T.h * 0.72 - 0.4,
          T.z + Math.sin(wa2) * (T.r + 0.03), rng.range(0.8, 1.7), T.h * 0.52, 'z', 0);
      }
      B.paint = 'steel';

      L.addCollider(T.x, floorY + T.h * 0.5, T.z, T.r, T.h * 0.5, T.r, 'metal');

      out.push({
        name: T.name,
        centre: new THREE.Vector3(T.x, floorY, T.z),
        r: T.r, h: T.h, roofY: roofY, floorY: floorY,
        bund: { x0: T.bx0, x1: T.bx1, z0: T.bz0, z1: T.bz1, h: T.bh,
                floorY: floorY, wallY: wallY + T.bh },
        stairYaw: T.stair,
        manwayPos: new THREE.Vector3(ox, floorY + 0.9, oz)
      });
    }
    return out;
  }

  // =============================================================== THE FLARE ==
  // 46 m of stack inside a three-leg lattice derrick, burning. This is the
  // level's landmark, its key light and its only genuinely moving thing.
  //
  // The derrick is the point. A flare stack modelled as a plain pipe is a plain
  // pipe; what makes the real thing photograph is 34 m of open triangulated
  // steel with the sky through it, so the derrick carries nine bracing panels
  // per leg and the legs batter inward from 7.6 m to 1.3 m. Against a dusk sky
  // that is the "complex industrial silhouette" of the brief, in one object.
  function buildFlare(L, B, rng, N) {
    var base = groundY(FL_X, FL_Z, N);
    var legs = 3, panels = 9;
    var i, p, k;

    // ---- foundation ----------------------------------------------------------
    B.paint = 'wall';
    B.cyl('wall', 1.7, 1.9, 0.85, FL_X, base + 0.30, FL_Z, 0, 0, 0, 16);
    for (i = 0; i < legs; i++) {
      var a = i / legs * Math.PI * 2 + 0.52;
      B.box('wall', 1.5, 0.80, 1.5, FL_X + Math.cos(a) * FL_LEG, base + 0.22,
        FL_Z + Math.sin(a) * FL_LEG, 0.03);
    }

    // ---- the derrick ---------------------------------------------------------
    B.paint = 'steel';
    function legPos(i2, t) {
      var a2 = i2 / legs * Math.PI * 2 + 0.52;
      var r = M.lerp(FL_LEG, 1.30, t);
      return [FL_X + Math.cos(a2) * r, base + 0.60 + (FL_DERRICK - 0.60) * t,
              FL_Z + Math.sin(a2) * r];
    }
    // Members are 0.46 / 0.20 / 0.15 rather than the 0.20 / 0.10 / 0.075 this
    // started at. Twice measured: at 75 mm the diagonals were a third of a pixel
    // from the hero1 standpoint and the lattice simply did not resolve; at
    // 110 mm it resolved but sat within a few per cent of the horizon haze
    // behind it and read as nothing. A 58 m derrick carries members this heavy
    // in reality, and at 114 m they are 4 px - enough to hold the orange bands.
    var ORANGE = tint(0xff5a0c, 1.0);
    B.paint = 'paint';
    for (i = 0; i < legs; i++) {
      for (p = 0; p < panels; p++) {
        var t0 = p / panels, t1 = (p + 1) / panels;
        var A = legPos(i, t0), Bp = legPos(i, t1);
        var C2 = legPos((i + 1) % legs, t0), D = legPos((i + 1) % legs, t1);
        // aviation banding: alternate panels white and international orange
        B.tint = (p % 2) ? ORANGE : null;
        // the chord
        B.strut('derrick', A[0], A[1], A[2], Bp[0], Bp[1], Bp[2], 0.46, 0.46);
        // horizontal at each node, and a K-brace in the panel
        B.strut('derrick', A[0], A[1], A[2], C2[0], C2[1], C2[2], 0.20, 0.20);
        var mx = (A[0] + Bp[0]) * 0.5, my = (A[1] + Bp[1]) * 0.5, mz = (A[2] + Bp[2]) * 0.5;
        B.strut('derrick', C2[0], C2[1], C2[2], mx, my, mz, 0.15, 0.15);
        B.strut('derrick', mx, my, mz, D[0], D[1], D[2], 0.15, 0.15);
        if (p === panels - 1) {
          B.strut('derrick', Bp[0], Bp[1], Bp[2], D[0], D[1], D[2], 0.20, 0.20);
        }
      }
      B.tint = null;
      var top3 = legPos(i, 1.0);
      L.addCollider((legPos(i, 0)[0] + top3[0]) * 0.5, (base + FL_DERRICK) * 0.5,
        (legPos(i, 0)[2] + top3[2]) * 0.5, 1.2, (FL_DERRICK - base) * 0.5 + base * 0, 1.2, 'metal');
    }

    // ---- the riser and the tip ------------------------------------------------
    B.tint = null;
    B.paint = 'lagging';
    B.cyl('lag', 0.62, 0.72, FL_DERRICK - 0.6, FL_X, base + 0.6 + (FL_DERRICK - 0.6) * 0.5,
      FL_Z, 0, 0, 0, 14, true);
    B.paint = 'rusty';
    B.cyl('rust', FL_TIP_R * 0.82, 0.62, FL_TIP - FL_DERRICK - 1.2, FL_X,
      base + FL_DERRICK + (FL_TIP - FL_DERRICK - 1.2) * 0.5, FL_Z, 0, 0, 0, 14, true);
    // the flare tip: a flared muzzle with a wind shield and the pilot cluster
    B.cyl('rust', FL_TIP_R * 1.45, FL_TIP_R * 0.82, 1.20, FL_X, base + FL_TIP - 0.55,
      FL_Z, 0, 0, 0, 16, true);
    B.paint = 'steel';
    B.cyl('struct', FL_TIP_R * 1.62, FL_TIP_R * 1.62, 0.09, FL_X, base + FL_TIP - 1.15,
      FL_Z, 0, 0, 0, 16, true);
    for (i = 0; i < 3; i++) {
      var pa = i / 3 * Math.PI * 2 + 0.9;
      B.tube('pipe', FL_X + Math.cos(pa) * FL_TIP_R * 1.2, base + FL_TIP - 3.0,
        FL_Z + Math.sin(pa) * FL_TIP_R * 1.2,
        FL_X + Math.cos(pa) * FL_TIP_R * 1.5, base + FL_TIP + 0.25,
        FL_Z + Math.sin(pa) * FL_TIP_R * 1.5, 0.055, 6);
    }
    // steam-injection ring
    B.torus('pipe', FL_TIP_R * 1.9, 0.055, FL_X, base + FL_TIP - 1.8, FL_Z, 16);

    // ---- the knock-out drum and the seal --------------------------------------
    B.paint = 'lagging';
    B.cyl('lag', 1.5, 1.5, 6.5, FL_X - 5.4, base + 1.9, FL_Z + 3.0, 0, 0, Math.PI * 0.5, 16);
    B.cyl('lag', 0.7, 1.5, 0.9, FL_X - 9.1, base + 1.9, FL_Z + 3.0, 0, 0, Math.PI * 0.5, 16);
    B.cyl('lag', 0.7, 1.5, 0.9, FL_X - 1.7, base + 1.9, FL_Z + 3.0, 0, 0, -Math.PI * 0.5, 16);
    B.paint = 'wall';
    for (i = 0; i < 2; i++) {
      B.box('wall', 1.1, 0.85, 1.6, FL_X - 8.0 + i * 5.2, base + 0.42, FL_Z + 3.0, 0.02);
    }
    B.paint = 'pipe';
    B.tube('pipe', FL_X - 1.7, base + 1.9, FL_Z + 3.0, FL_X, base + 1.9, FL_Z + 1.4, 0.52, 10);
    B.tube('pipe', FL_X, base + 1.9, FL_Z + 1.4, FL_X, base + 3.2, FL_Z, 0.52, 10);
    // the header arriving from the plant: it drops off the east rack's top tier
    // and runs to the drum, which is why the rack ends where it does
    var hx = ER_X - ER_HALF + 0.4;
    B.tube('pipe', FL_X - 9.1, base + 1.9, FL_Z + 3.0, hx, base + 1.9, FL_Z + 3.0, 0.55, 10);
    B.tube('pipe', hx, base + 1.9, FL_Z + 3.0, hx, base + 1.9, FL_Z + 9.0, 0.55, 10);
    B.tube('pipe', hx, base + 1.9, FL_Z + 9.0, hx, groundY(hx, ER_Z0, N) + ER_TIERS[1] + 1.1,
      ER_Z0 + 1.0, 0.55, 10);
    B.paint = 'steel';
    B.box('struct', 0.9, 2.1, 0.9, hx, base + 0.95, FL_Z + 6.0, 0.02);
    B.paint = 'pipe';

    // ---- ladder, obstruction lights, markings ----------------------------------
    B.paint = 'steel';
    B.ladder(FL_X + 1.05, FL_Z, base + 0.7, base + FL_DERRICK - 0.4, 0.0, true);
    B.paint = 'flat';
    for (i = 0; i < 5; i++) {
      var oy = base + 10.0 + i * 8.0;
      var orr = M.lerp(FL_LEG, 1.30, (oy - base - 0.6) / (FL_DERRICK - 0.6)) * 0.92;
      B.cyl('lamp_r', 0.20, 0.20, 0.26, FL_X + orr, oy, FL_Z, 0, 0, 0, 8);
      B.cyl('lamp_r', 0.20, 0.20, 0.26, FL_X - orr * 0.5, oy, FL_Z + orr * 0.87, 0, 0, 0, 8);
    }
    decalCard(B, CELL.danger, FL_X - 1.95, base + 2.2, FL_Z, 1.3, 1.0, '-x');
    decalCard(B, CELL.unitno, FL_X + 1.95, base + 2.4, FL_Z, 1.6, 1.6, 'x');
    B.paint = 'steel';

    return {
      base: new THREE.Vector3(FL_X, base, FL_Z),
      padY: base,
      tipY: base + FL_TIP,
      tipR: FL_TIP_R,
      derrickR: FL_LEG,
      flame: new THREE.Vector3(FL_X, base + FL_TIP + 0.4, FL_Z)
    };
  }

  // ============================================================ FIRED HEATER ==
  // A cabin heater: a refractory-lined box on legs with a burner deck under it,
  // a convection section on top and a 26 m stack. It closes the east side of
  // the frame and its stack is the second-tallest object in the level.
  function buildHeater(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var cx = (HT_X0 + HT_X1) * 0.5, cz = (HT_Z0 + HT_Z1) * 0.5;
    var base = gy(cx, cz);
    var w = HT_X1 - HT_X0, d = HT_Z1 - HT_Z0;
    var legH = 2.4;
    var i, k;

    // legs and burner deck
    B.paint = 'steel';
    for (i = 0; i < 4; i++) {
      for (k = 0; k < 3; k++) {
        var lx = HT_X0 + 0.8 + (w - 1.6) * (i / 3);
        var lz = HT_Z0 + 0.8 + (d - 1.6) * (k / 2);
        B.box('struct', 0.34, legH, 0.34, lx, base + legH * 0.5, lz, 0.014);
        B.paint = 'wall';
        B.box('wall', 0.8, 0.45, 0.8, lx, base + 0.12, lz, 0.02);
        B.paint = 'steel';
      }
    }
    // the radiant box
    B.paint = 'refractory';
    B.box('refract', w, HT_H, d, cx, base + legH + HT_H * 0.5, cz, 0.06);
    B.paint = 'clad';
    B.box('clad', w + 0.12, HT_H * 0.92, 0.10, cx, base + legH + HT_H * 0.5, HT_Z0 - 0.05, 0.02);
    B.box('clad', w + 0.12, HT_H * 0.92, 0.10, cx, base + legH + HT_H * 0.5, HT_Z1 + 0.05, 0.02);
    B.box('clad', 0.10, HT_H * 0.92, d + 0.12, HT_X0 - 0.05, base + legH + HT_H * 0.5, cz, 0.02);
    B.box('clad', 0.10, HT_H * 0.92, d + 0.12, HT_X1 + 0.05, base + legH + HT_H * 0.5, cz, 0.02);
    // convection section, narrower, on top
    B.paint = 'refractory';
    B.box('refract', w * 0.55, 4.6, d * 0.62, cx, base + legH + HT_H + 2.3, cz, 0.05);
    // stiffener ribs - a heater casing is a grid of them and it is what stops
    // a 18 x 15 m box being a box
    B.paint = 'steel';
    for (i = 0; i < 8; i++) {
      var rx = HT_X0 + w * ((i + 0.5) / 8);
      B.box('struct', 0.14, HT_H * 0.94, 0.16, rx, base + legH + HT_H * 0.5, HT_Z0 - 0.14, 0.01);
      B.box('struct', 0.14, HT_H * 0.94, 0.16, rx, base + legH + HT_H * 0.5, HT_Z1 + 0.14, 0.01);
    }
    for (i = 0; i < 3; i++) {
      var ry = base + legH + HT_H * (0.25 + i * 0.25);
      B.box('struct', w + 0.3, 0.16, 0.14, cx, ry, HT_Z0 - 0.14, 0.01);
      B.box('struct', w + 0.3, 0.16, 0.14, cx, ry, HT_Z1 + 0.14, 0.01);
    }
    // burner fronts on the underside, glowing through their sight ports
    B.paint = 'steel';
    for (i = 0; i < 4; i++) {
      for (k = 0; k < 2; k++) {
        var bx = HT_X0 + 2.4 + i * ((w - 4.8) / 3);
        var bz = cz - 3.0 + k * 6.0;
        B.cyl('struct', 0.42, 0.48, 0.55, bx, base + legH - 0.28, bz, 0, 0, 0, 10);
        B.paint = 'flat';
        B.cyl('lamp_w', 0.10, 0.10, 0.06, bx + 0.34, base + legH - 0.28, bz,
          0, 0, Math.PI * 0.5, 8);
        B.paint = 'steel';
        B.tube('pipe', bx, base + 0.35, bz, bx, base + legH - 0.55, bz, 0.09, 6);
      }
    }
    // access platform round the box at mid height, reached by a stair
    var pY = base + legH + HT_H * 0.55;
    B.box('grate', w + 2.4, 0.035, 1.25, cx, pY, HT_Z0 - 0.75, 0.006);
    B.railRun(HT_X0 - 1.2, HT_Z0 - 1.30, HT_X1 + 1.2, HT_Z0 - 1.30, pY, 1.10);
    for (i = 0; i < 7; i++) {
      var sx2 = HT_X0 - 1.0 + (w + 2.0) * (i / 6);
      B.strut('struct', sx2, pY - 0.05, HT_Z0 - 1.30, sx2, pY - 1.55, HT_Z0 - 0.10, 0.06, 0.16);
    }
    B.stair(HT_X0 - 3.6, gy(HT_X0 - 3.6, HT_Z0 - 1.0), HT_Z0 - 1.0,
      HT_X0 - 1.1, pY, HT_Z0 - 0.90, 1.0);

    // ---- the stack ------------------------------------------------------------
    var stBase = base + legH + HT_H + 4.6;
    B.paint = 'refractory';
    B.cyl('refract', HT_STACK_R * 0.82, HT_STACK_R, base + HT_STACK_TOP - stBase,
      HT_STACK_X, (stBase + base + HT_STACK_TOP) * 0.5, HT_STACK_Z, 0, 0, 0, 18, true);
    B.paint = 'steel';
    B.cyl('struct', HT_STACK_R * 0.90, HT_STACK_R * 0.90, 0.14, HT_STACK_X,
      base + HT_STACK_TOP, HT_STACK_Z, 0, 0, 0, 18, true);
    for (i = 0; i < 4; i++) {
      var by2 = stBase + (base + HT_STACK_TOP - stBase) * ((i + 1) / 5);
      B.cyl('struct', HT_STACK_R * 1.05, HT_STACK_R * 1.05, 0.10, HT_STACK_X, by2,
        HT_STACK_Z, 0, 0, 0, 18, true);
    }
    B.railRing(HT_STACK_X, HT_STACK_Z, HT_STACK_R + 0.85, base + HT_STACK_TOP - 3.2, 1.05, 16);
    B.ring('grate', HT_STACK_R, HT_STACK_R + 0.90, HT_STACK_X, base + HT_STACK_TOP - 3.2,
      HT_STACK_Z, 18);
    B.ladder(HT_STACK_X - HT_STACK_R - 0.30, HT_STACK_Z, stBase, base + HT_STACK_TOP - 3.0,
      Math.PI, true);
    B.paint = 'flat';
    B.cyl('lamp_r', 0.15, 0.15, 0.20, HT_STACK_X + HT_STACK_R + 0.2, base + HT_STACK_TOP - 1.0,
      HT_STACK_Z, 0, 0, 0, 8);
    decalCard(B, CELL.unitno, cx, base + legH + HT_H * 0.72, HT_Z0 - 0.22, 3.2, 3.2, '-z');
    decalCard(B, CELL.hazard, cx, base + legH + 0.5, HT_Z0 - 0.22, 6.0, 0.7, '-z');
    B.paint = 'steel';

    L.addCollider(cx, base + legH + HT_H * 0.5, cz, w * 0.5, (legH + HT_H) * 0.5 + 0.2,
      d * 0.5, 'concrete');
    L.addCollider(HT_STACK_X, (stBase + base + HT_STACK_TOP) * 0.5, HT_STACK_Z,
      HT_STACK_R, (base + HT_STACK_TOP - stBase) * 0.5, HT_STACK_R, 'concrete');

    return {
      centre: new THREE.Vector3(cx, base, cz),
      x0: HT_X0, x1: HT_X1, z0: HT_Z0, z1: HT_Z1, h: legH + HT_H,
      platformY: pY,
      stack: { x: HT_STACK_X, z: HT_STACK_Z, topY: base + HT_STACK_TOP, r: HT_STACK_R }
    };
  }

  // ============================================================ COOLING TOWER ==
  // Three induced-draught cells at the far north-west, 100 m out. Louvred
  // sides, a fan stack on each, and a plume. They exist for one reason: the
  // deep background of hero1 and the overview needs a mass with a readable
  // profile in it, or the far end of the site is fog with nothing in it.
  function buildCoolers(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var out = [];
    var cells = 3;
    var cw = (CT_X1 - CT_X0) / cells;
    for (var i = 0; i < cells; i++) {
      var cx = CT_X0 + cw * (i + 0.5), cz = (CT_Z0 + CT_Z1) * 0.5;
      var d = CT_Z1 - CT_Z0;
      var base = gy(cx, cz);
      B.paint = 'wall';
      B.box('wall', cw - 0.4, 2.2, d, cx, base + 1.1, cz, 0.04);
      B.paint = 'timber';
      B.box('clad', cw - 0.5, CT_H - 2.4, d + 0.1, cx, base + 2.2 + (CT_H - 2.4) * 0.5, cz, 0.05);
      // louvre blades on both long faces
      B.paint = 'steel';
      for (var k = 0; k < 9; k++) {
        var ly = base + 2.5 + k * 0.62;
        if (ly > base + CT_H - 1.0) break;
        B.boxR('clad', cw - 0.6, 0.42, 0.10, cx, ly, CT_Z0 - 0.10, 0.42, 0, 0, 0.01);
        B.boxR('clad', cw - 0.6, 0.42, 0.10, cx, ly, CT_Z1 + 0.10, -0.42, 0, 0, 0.01);
      }
      // fan stack and the fan itself
      B.paint = 'clad';
      B.cyl('clad', 3.0, 2.6, 2.4, cx, base + CT_H + 1.0, cz, 0, 0, 0, 18, true);
      B.paint = 'steel';
      B.torus('struct', 3.0, 0.09, cx, base + CT_H + 2.2, cz, 20);
      for (var f = 0; f < 4; f++) {
        var fa = f / 4 * Math.PI * 2 + i * 0.4;
        B.boxR('struct', 2.5, 0.06, 0.55, cx + Math.cos(fa) * 1.3, base + CT_H + 1.6,
          cz + Math.sin(fa) * 1.3, 0.28, -fa, 0, 0.01);
      }
      B.cyl('struct', 0.30, 0.30, 0.9, cx, base + CT_H + 1.7, cz, 0, 0, 0, 10);
      B.railRun(cx - cw * 0.5 + 0.4, CT_Z0 + 0.4, cx + cw * 0.5 - 0.4, CT_Z0 + 0.4,
        base + CT_H, 1.05);
      L.addCollider(cx, base + CT_H * 0.5, cz, cw * 0.5 - 0.2, CT_H * 0.5, d * 0.5, 'concrete');
      out.push({ centre: new THREE.Vector3(cx, base, cz), w: cw, d: d, h: CT_H,
                 fanY: base + CT_H + 2.4 });
    }
    // the basin and the circulating-water lines running back to the plant
    B.paint = 'pipe';
    B.tube('pipe', CT_X1, gy(CT_X1, CT_Z1) + 1.4, CT_Z1 + 1.2,
      -2.0, gy(-2.0, CT_Z1) + 1.4, CT_Z1 + 1.2, 0.42, 10);
    B.tube('pipe', CT_X1, gy(CT_X1, CT_Z1) + 2.3, CT_Z1 + 2.2,
      -2.0, gy(-2.0, CT_Z1) + 2.3, CT_Z1 + 2.2, 0.42, 10);
    B.paint = 'steel';
    return out;
  }

  // ============================================================== PUMP HOUSE ==
  // The level's enterable interior: a 22 x 15 m steel-framed hall with a roll
  // shutter at the east gable, a row of pump skids down the middle, MCC
  // cabinets on the north wall and four fluorescent battens overhead.
  //
  // The `interior` framing stands 3 m inside the shutter and looks WEST down
  // the hall. That gives a dark tube with a cool fluorescent rhythm along it, a
  // readable subject (the pump row) in the middle distance, and a bright doorway
  // at the far end - which is the only place in the level where the flare's
  // orange arrives as a single warm accent in an otherwise cold frame.
  function buildPumpHouse(L, B, rng, N) {
    var cx = (PH_X0 + PH_X1) * 0.5, cz = (PH_Z0 + PH_Z1) * 0.5;
    var floorY = groundY(cx, cz, N);
    var w = PH_X1 - PH_X0, d = PH_Z1 - PH_Z0;
    var i, k;

    // ---- slab and drainage trench --------------------------------------------
    B.paint = 'pave';
    B.box('pave', w, 0.30, d, cx, floorY - 0.15, cz, 0.01);
    B.paint = 'steel';
    for (i = 0; i < 10; i++) {
      var tz = PH_Z0 + 1.2 + i * ((d - 2.4) / 9);
      B.box('grate', w - 3.4, 0.030, 0.55, cx, floorY + 0.015, tz, 0.005);
    }

    // ---- frame ----------------------------------------------------------------
    B.paint = 'steel';
    var bays = 6;
    for (i = 0; i <= bays; i++) {
      var fx = PH_X0 + w * (i / bays);
      B.box('struct', 0.20, PH_EAVE, 0.30, fx, floorY + PH_EAVE * 0.5, PH_Z0 + 0.12, 0.012);
      B.box('struct', 0.20, PH_EAVE, 0.30, fx, floorY + PH_EAVE * 0.5, PH_Z1 - 0.12, 0.012);
      // the portal rafters
      B.strut('struct', fx, floorY + PH_EAVE, PH_Z0 + 0.12, fx, floorY + PH_RIDGE, cz, 0.18, 0.28);
      B.strut('struct', fx, floorY + PH_RIDGE, cz, fx, floorY + PH_EAVE, PH_Z1 - 0.12, 0.18, 0.28);
    }
    B.box('struct', w, 0.16, 0.20, cx, floorY + PH_RIDGE, cz, 0.01);
    // purlins
    for (k = 0; k < 5; k++) {
      var pz = PH_Z0 + 0.6 + (d - 1.2) * (k / 4);
      var py = floorY + PH_EAVE + (PH_RIDGE - PH_EAVE) * (1 - Math.abs(pz - cz) / (d * 0.5));
      B.box('struct', w, 0.10, 0.14, cx, py + 0.10, pz, 0.008);
    }

    // ---- cladding --------------------------------------------------------------
    B.paint = 'clad';
    B.box('clad', w, PH_EAVE - 0.9, 0.06, cx, floorY + 0.9 + (PH_EAVE - 0.9) * 0.5, PH_Z0, 0.012);
    B.box('clad', w, PH_EAVE - 0.9, 0.06, cx, floorY + 0.9 + (PH_EAVE - 0.9) * 0.5, PH_Z1, 0.012);
    B.paint = 'blockwork';
    B.box('wall', w, 0.95, 0.22, cx, floorY + 0.47, PH_Z0, 0.02);
    B.box('wall', w, 0.95, 0.22, cx, floorY + 0.47, PH_Z1, 0.02);
    // gables: east has the shutter, west has a personnel door
    B.paint = 'clad';
    B.box('clad', 0.06, PH_EAVE, d, PH_X0, floorY + PH_EAVE * 0.5, cz, 0.012);
    for (k = 0; k < 2; k++) {
      var sz = k ? PH_DOOR_Z + PH_DOOR_W * 0.5 : PH_Z0;
      var ez = k ? PH_Z1 : PH_DOOR_Z - PH_DOOR_W * 0.5;
      B.box('clad', 0.06, PH_EAVE, ez - sz, PH_X1, floorY + PH_EAVE * 0.5, (sz + ez) * 0.5, 0.012);
    }
    B.box('clad', 0.06, PH_EAVE - PH_DOOR_H, PH_DOOR_W, PH_X1,
      floorY + PH_DOOR_H + (PH_EAVE - PH_DOOR_H) * 0.5, PH_DOOR_Z, 0.012);
    // gable triangles
    for (k = 0; k < 2; k++) {
      var gx = k ? PH_X1 : PH_X0;
      for (i = 0; i < 6; i++) {
        var gz2 = PH_Z0 + d * ((i + 0.5) / 6);
        var gh = (PH_RIDGE - PH_EAVE) * (1 - Math.abs(gz2 - cz) / (d * 0.5));
        B.box('clad', 0.06, gh, d / 6, gx, floorY + PH_EAVE + gh * 0.5, gz2, 0.008);
      }
    }
    // ---- roof --------------------------------------------------------------------
    B.paint = 'roofdeck';
    var slope = Math.atan2(PH_RIDGE - PH_EAVE, d * 0.5);
    var slen = Math.sqrt((d * 0.5) * (d * 0.5) + (PH_RIDGE - PH_EAVE) * (PH_RIDGE - PH_EAVE));
    B.boxR('roof', w + 0.5, 0.10, slen, cx, floorY + (PH_EAVE + PH_RIDGE) * 0.5,
      cz - d * 0.25, slope, 0, 0, 0.01);
    B.boxR('roof', w + 0.5, 0.10, slen, cx, floorY + (PH_EAVE + PH_RIDGE) * 0.5,
      cz + d * 0.25, -slope, 0, 0, 0.01);
    // three translucent roof lights, and a ridge vent
    B.paint = 'steel';
    B.box('struct', w + 0.6, 0.16, 0.55, cx, floorY + PH_RIDGE + 0.20, cz, 0.01);

    // ---- the roll shutter, half open ----------------------------------------------
    B.paint = 'shutter';
    B.box('clad', 0.05, 1.55, PH_DOOR_W, PH_X1 - 0.10,
      floorY + PH_DOOR_H - 0.78, PH_DOOR_Z, 0.006);
    B.paint = 'steel';
    B.cyl('struct', 0.22, 0.22, PH_DOOR_W + 0.4, PH_X1 - 0.10, floorY + PH_DOOR_H + 0.28,
      PH_DOOR_Z, 0, 0, Math.PI * 0.5, 10);
    B.box('struct', 0.16, PH_DOOR_H + 0.5, 0.16, PH_X1 - 0.10, floorY + (PH_DOOR_H + 0.5) * 0.5,
      PH_DOOR_Z - PH_DOOR_W * 0.5 - 0.10, 0.01);
    B.box('struct', 0.16, PH_DOOR_H + 0.5, 0.16, PH_X1 - 0.10, floorY + (PH_DOOR_H + 0.5) * 0.5,
      PH_DOOR_Z + PH_DOOR_W * 0.5 + 0.10, 0.01);

    // ---- the pump row ---------------------------------------------------------------
    // Six centrifugal pump sets on plinths: motor, coupling guard, casing,
    // suction and discharge. The subject of the interior framing.
    var bayList = [];
    // Five sets, and they START 3.4 m in from the west gable rather than
    // running the full length: the `interior` eye stands 2.2 m inside the roll
    // shutter, and with six sets on the old spacing the nearest one was 0.4 m
    // off the lens and filled the right third of the frame with a blurred motor.
    for (i = 0; i < 5; i++) {
      var px = PH_X0 + 3.4 + i * ((w - 9.8) / 4);
      var pz2 = cz - 1.9;
      B.paint = 'wall';
      B.box('wall', 2.5, 0.42, 1.35, px, floorY + 0.21, pz2, 0.02);
      B.paint = 'steel';
      // baseplate and the grouted shims under it
      B.box('struct', 2.20, 0.075, 1.05, px, floorY + 0.46, pz2, 0.008);
      // ---- the motor: a finned TEFC body lying along the skid ---------------
      // The cooling fins run ALONG the shaft, spaced around it. They were first
      // written with the axial term multiplied out, which put all ten fins in
      // one plane and printed a spoked disc standing in the middle of the pump.
      B.paint = 'paint';
      B.cyl('machine', 0.32, 0.32, 1.05, px - 0.55, floorY + 0.86, pz2, 0, 0, Math.PI * 0.5, 16);
      for (k = 0; k < 12; k++) {
        var fa2 = k / 12 * Math.PI * 2;
        B.boxR('machine', 1.02, 0.075, 0.030, px - 0.55,
          floorY + 0.86 + Math.sin(fa2) * 0.345, pz2 + Math.cos(fa2) * 0.345,
          -fa2, 0, 0, 0.004);
      }
      // end bells and the terminal box on top
      B.cyl('machine', 0.30, 0.24, 0.14, px - 1.10, floorY + 0.86, pz2, 0, 0, Math.PI * 0.5, 14);
      B.cyl('machine', 0.30, 0.24, 0.14, px + 0.00, floorY + 0.86, pz2, 0, 0, Math.PI * 0.5, 14);
      B.box('machine', 0.34, 0.20, 0.26, px - 0.62, floorY + 1.28, pz2, 0.012);
      B.paint = 'steel';
      // ---- coupling guard: a perforated cage between motor and pump ---------
      B.box('grate', 0.42, 0.44, 0.44, px + 0.20, floorY + 0.84, pz2, 0.01);
      B.cyl('struct', 0.09, 0.09, 0.36, px + 0.20, floorY + 0.84, pz2, 0, 0, Math.PI * 0.5, 10);
      B.paint = 'pump';
      // ---- the pump end: volute casing, bearing housing, suction and discharge
      B.cyl('machine', 0.40, 0.40, 0.34, px + 0.62, floorY + 0.78, pz2, 0, 0, Math.PI * 0.5, 16);
      B.cyl('machine', 0.24, 0.36, 0.22, px + 0.46, floorY + 0.78, pz2, 0, 0, Math.PI * 0.5, 14);
      B.cyl('machine', 0.30, 0.30, 0.26, px + 0.90, floorY + 0.78, pz2, 0, 0, Math.PI * 0.5, 16);
      B.cyl('machine', 0.34, 0.34, 0.05, px + 1.04, floorY + 0.78, pz2, 0, 0, Math.PI * 0.5, 16);
      B.paint = 'steel';
      for (k = 0; k < 6; k++) {
        var ba2 = k / 6 * Math.PI * 2;
        B.cyl('struct', 0.022, 0.022, 0.06, px + 1.06,
          floorY + 0.78 + Math.sin(ba2) * 0.27, pz2 + Math.cos(ba2) * 0.27,
          0, 0, Math.PI * 0.5, 6);
      }
      B.paint = 'pump';
      B.paint = 'pipe';
      B.tube('pipe', px + 0.52, floorY + 0.72, pz2 - 0.30, px + 0.52, floorY + 0.72, pz2 - 1.30, 0.16, 8);
      B.tube('pipe', px + 0.52, floorY + 0.72, pz2 - 1.30, px + 0.52, floorY + 2.60, pz2 - 1.30, 0.16, 8);
      B.tube('pipe', px + 0.52, floorY + 1.14, pz2, px + 0.52, floorY + 2.60, pz2, 0.13, 8);
      B.paint = 'flat';
      decalCard(B, CELL.valve, px + 0.52, floorY + 1.35, pz2 + 0.20, 0.30, 0.30, 'z');
      decalCard(B, CELL.unitno, px, floorY + 0.05, pz2 + 1.0, 0.9, 0.9, 'y');
      B.paint = 'steel';
      bayList.push({ position: new THREE.Vector3(px, floorY, pz2), w: 2.5, d: 1.35 });
    }
    // the overhead header the pumps discharge into
    B.paint = 'pipe';
    B.tube('pipe', PH_X0 + 0.8, floorY + 2.70, cz - 1.9, PH_X1 - 0.6, floorY + 2.70, cz - 1.9, 0.30, 10);
    B.tube('pipe', PH_X0 + 0.8, floorY + 3.20, cz - 3.0, PH_X1 - 0.6, floorY + 3.20, cz - 3.0, 0.22, 10);
    // MCC / switchgear line on the south wall
    B.paint = 'paint';
    for (i = 0; i < 7; i++) {
      var mx = PH_X0 + 2.2 + i * 1.30;
      B.box('clad', 1.22, 2.15, 0.62, mx, floorY + 1.08, PH_Z1 - 0.55, 0.014);
      B.paint = 'steel';
      B.box('struct', 1.22, 0.08, 0.66, mx, floorY + 2.19, PH_Z1 - 0.55, 0.008);
      B.paint = 'flat';
      decalCard(B, CELL.plate, mx, floorY + 1.65, PH_Z1 - 0.87, 0.42, 0.32, '-z');
      B.paint = 'paint';
    }
    // the monorail beam over the pump row - every pump house has one
    B.paint = 'steel';
    B.box('struct', w - 1.6, 0.26, 0.14, cx, floorY + 4.30, cz - 1.9, 0.012);
    B.box('struct', w - 1.6, 0.06, 0.34, cx, floorY + 4.17, cz - 1.9, 0.008);
    B.box('struct', 0.34, 0.30, 0.30, PH_X0 + 6.0, floorY + 4.05, cz - 1.9, 0.01);
    B.tube('rail', PH_X0 + 6.0, floorY + 3.90, cz - 1.9, PH_X0 + 6.0, floorY + 2.60, cz - 1.9, 0.02, 5);
    B.cyl('struct', 0.10, 0.10, 0.35, PH_X0 + 6.0, floorY + 2.45, cz - 1.9, 0, 0, 0, 8);

    // ---- the personnel door at the west end -----------------------------------------
    // Standing open. It is the bright end of the interior framing's tube.
    B.paint = 'steel';
    B.box('struct', 0.10, 2.15, 0.12, PH_X0 + 0.02, floorY + 1.08, cz - 0.62, 0.008);
    B.box('struct', 0.10, 2.15, 0.12, PH_X0 + 0.02, floorY + 1.08, cz + 0.62, 0.008);
    B.box('struct', 0.10, 0.12, 1.36, PH_X0 + 0.02, floorY + 2.15, cz, 0.008);
    B.paint = 'shutter';
    B.boxR('clad', 0.05, 2.05, 1.10, PH_X0 - 0.44, floorY + 1.03, cz - 1.10, 0, -0.95, 0, 0.006);

    // ---- exterior dressing -----------------------------------------------------------
    B.paint = 'flat';
    decalCard(B, CELL.unitno, PH_X1 + 0.05, floorY + 5.2, PH_DOOR_Z, 2.2, 2.2, 'x');
    decalCard(B, CELL.danger, PH_X1 + 0.05, floorY + 1.9, PH_DOOR_Z - 3.4, 1.0, 0.8, 'x');
    decalCard(B, CELL.hazard, PH_X1 - 0.02, floorY + 0.05, PH_DOOR_Z, 4.6, 0.7, 'y');
    B.paint = 'steel';

    // ---- colliders ------------------------------------------------------------------
    // Walls as four slabs plus a lintel over the shutter, so the hall is a real
    // enclosure for the sky-visibility bake and the player cannot walk out
    // through the cladding.
    L.addCollider(cx, floorY + PH_EAVE * 0.5, PH_Z0 - 0.06, w * 0.5, PH_EAVE * 0.5, 0.16, 'metal');
    L.addCollider(cx, floorY + PH_EAVE * 0.5, PH_Z1 + 0.06, w * 0.5, PH_EAVE * 0.5, 0.16, 'metal');
    L.addCollider(PH_X0 - 0.06, floorY + PH_EAVE * 0.5, cz, 0.16, PH_EAVE * 0.5, d * 0.5, 'metal');
    L.addCollider(PH_X1 + 0.06, floorY + PH_EAVE * 0.5, PH_DOOR_Z - (d * 0.25 + 1.2),
      0.16, PH_EAVE * 0.5, d * 0.25, 'metal');
    L.addCollider(PH_X1 + 0.06, floorY + PH_EAVE * 0.5, PH_DOOR_Z + (d * 0.25 + 1.2),
      0.16, PH_EAVE * 0.5, d * 0.25, 'metal');
    L.addCollider(cx, floorY + PH_RIDGE - 0.2, cz, w * 0.5, 0.30, d * 0.5, 'metal');

    return {
      centre: new THREE.Vector3(cx, floorY, cz),
      x0: PH_X0, x1: PH_X1, z0: PH_Z0, z1: PH_Z1,
      floorY: floorY, eaveY: floorY + PH_EAVE, ridgeY: floorY + PH_RIDGE,
      door: { position: new THREE.Vector3(PH_X1, floorY, PH_DOOR_Z), yaw: -Math.PI * 0.5,
              w: PH_DOOR_W, h: PH_DOOR_H },
      bays: bayList
    };
  }

  // ======================================================= CONTROL BUILDING ==
  // Two storeys of blast-resistant blockwork with a glazed upper floor. Its lit
  // windows are the only INHABITED-looking light in the level and they are what
  // stop the east side of the overview being pure plant.
  function buildControl(L, B, rng, N) {
    var cx = (CB_X0 + CB_X1) * 0.5, cz = (CB_Z0 + CB_Z1) * 0.5;
    var base = groundY(cx, cz, N);
    var w = CB_X1 - CB_X0, d = CB_Z1 - CB_Z0;
    var wins = [];
    var i;

    B.paint = 'blockwork';
    B.box('wall', w, CB_H, 0.34, cx, base + CB_H * 0.5, CB_Z0, 0.03);
    B.box('wall', w, CB_H, 0.34, cx, base + CB_H * 0.5, CB_Z1, 0.03);
    B.box('wall', 0.34, CB_H, d, CB_X0, base + CB_H * 0.5, cz, 0.03);
    B.box('wall', 0.34, CB_H, d, CB_X1, base + CB_H * 0.5, cz, 0.03);
    B.paint = 'wall';
    B.box('wall', w + 0.8, 0.45, d + 0.8, cx, base + CB_H + 0.22, cz, 0.03);
    B.box('wall', w + 1.1, 0.22, d + 1.1, cx, base + CB_H + 0.52, cz, 0.02);
    // ---- glazing on the west elevation, first floor -------------------------
    B.paint = 'steel';
    for (i = 0; i < 6; i++) {
      var wz = CB_Z0 + 1.6 + i * ((d - 3.2) / 5);
      B.paint = 'glass';
      B.box('glass', 0.06, 1.55, 2.05, CB_X0 - 0.16, base + 5.6, wz, 0.004);
      B.paint = 'steel';
      B.box('struct', 0.14, 1.75, 0.13, CB_X0 - 0.18, base + 5.6, wz - 1.10, 0.008);
      B.box('struct', 0.14, 1.75, 0.13, CB_X0 - 0.18, base + 5.6, wz + 1.10, 0.008);
      B.box('struct', 0.16, 0.16, 2.4, CB_X0 - 0.18, base + 6.50, wz, 0.008);
      B.box('struct', 0.16, 0.16, 2.4, CB_X0 - 0.18, base + 4.70, wz, 0.008);
      wins.push({ x: CB_X0 - 0.30, y: base + 5.6, z: wz, w: 2.05, h: 1.55,
                  kelvin: 4200, gain: 0.85, yaw: Math.PI * 0.5, scale: 1.9 });
    }
    // ground-floor slit windows and the entrance
    for (i = 0; i < 4; i++) {
      var sz = CB_Z0 + 2.6 + i * ((d - 5.2) / 3);
      B.paint = 'glass';
      B.box('glass', 0.06, 0.95, 1.35, CB_X0 - 0.16, base + 2.5, sz, 0.004);
      B.paint = 'steel';
      B.box('struct', 0.16, 1.10, 0.12, CB_X0 - 0.19, base + 2.5, sz - 0.72, 0.008);
      B.box('struct', 0.16, 1.10, 0.12, CB_X0 - 0.19, base + 2.5, sz + 0.72, 0.008);
      wins.push({ x: CB_X0 - 0.30, y: base + 2.5, z: sz, w: 1.35, h: 0.95,
                  kelvin: 4000, gain: 0.55, yaw: Math.PI * 0.5, scale: 1.6 });
    }
    // ---- glazing on the SOUTH elevation --------------------------------------
    // The overview stands south of the site, so the west glazing above is edge
    // on to it and the elevation it actually sees is this one. Lit windows cost
    // nothing from the 24-practical budget - lighting.js draws them as additive
    // cards off level.litWindows - which is exactly why they are the right tool
    // for a face that needs to READ lit without needing to LIGHT anything.
    for (i = 0; i < 5; i++) {
      var qx = CB_X0 + 2.4 + i * ((w - 4.8) / 4);
      B.paint = 'glass';
      B.box('glass', 2.30, 1.55, 0.06, qx, base + 5.6, CB_Z1 + 0.16, 0.004);
      B.paint = 'steel';
      B.box('struct', 0.13, 1.75, 0.14, qx - 1.22, base + 5.6, CB_Z1 + 0.18, 0.008);
      B.box('struct', 0.13, 1.75, 0.14, qx + 1.22, base + 5.6, CB_Z1 + 0.18, 0.008);
      B.box('struct', 2.7, 0.16, 0.16, qx, base + 6.50, CB_Z1 + 0.18, 0.008);
      wins.push({ x: qx, y: base + 5.6, z: CB_Z1 + 0.30, w: 2.30, h: 1.55,
                  kelvin: 4200, gain: 0.85, yaw: 0, scale: 1.9 });
      if (i % 2 === 0) {
        B.paint = 'glass';
        B.box('glass', 1.35, 0.95, 0.06, qx, base + 2.5, CB_Z1 + 0.16, 0.004);
        B.paint = 'steel';
        wins.push({ x: qx, y: base + 2.5, z: CB_Z1 + 0.30, w: 1.35, h: 0.95,
                    kelvin: 4000, gain: 0.50, yaw: 0, scale: 1.6 });
      }
    }

    // the entrance porch, facing the cross road
    B.paint = 'wall';
    B.box('wall', 3.4, 0.30, 2.2, CB_X0 - 1.5, base + 3.0, CB_Z0 + 3.2, 0.03);
    B.paint = 'steel';
    B.cyl('struct', 0.12, 0.12, 3.0, CB_X0 - 2.9, base + 1.5, CB_Z0 + 2.4, 0, 0, 0, 8);
    B.cyl('struct', 0.12, 0.12, 3.0, CB_X0 - 2.9, base + 1.5, CB_Z0 + 4.0, 0, 0, 0, 8);
    B.paint = 'shutter';
    B.box('clad', 0.08, 2.15, 1.05, CB_X0 - 0.14, base + 1.08, CB_Z0 + 3.2, 0.006);
    // roof plant: two package air handlers and a satellite dish
    B.paint = 'clad';
    B.box('clad', 3.2, 1.5, 2.2, cx - 4.0, base + CB_H + 1.20, cz - 2.0, 0.03);
    B.box('clad', 2.4, 1.2, 1.8, cx + 3.5, base + CB_H + 1.05, cz + 2.5, 0.03);
    B.paint = 'steel';
    B.cyl('struct', 1.05, 1.05, 0.14, cx + 6.5, base + CB_H + 1.6, cz - 4.0, 0.7, 0.4, 0, 14);
    B.cyl('struct', 0.09, 0.09, 1.4, cx + 6.5, base + CB_H + 1.1, cz - 4.0, 0, 0, 0, 8);
    B.railRun(CB_X0 + 0.6, CB_Z0 + 0.6, CB_X1 - 0.6, CB_Z0 + 0.6, base + CB_H + 0.63, 1.05);
    B.paint = 'flat';
    decalCard(B, CELL.logo, CB_X0 - 0.20, base + 7.6, cz, 5.0, 1.4, '-x');
    decalCard(B, CELL.nosmoke, CB_X0 - 0.20, base + 2.4, CB_Z0 + 1.2, 0.85, 0.85, '-x');
    B.paint = 'steel';

    L.addCollider(cx, base + CB_H * 0.5, cz, w * 0.5, CB_H * 0.5 + 0.4, d * 0.5, 'concrete');
    return {
      centre: new THREE.Vector3(cx, base, cz),
      x0: CB_X0, x1: CB_X1, z0: CB_Z0, z1: CB_Z1, h: CB_H,
      door: { position: new THREE.Vector3(CB_X0 - 0.4, base, CB_Z0 + 3.2), yaw: Math.PI * 0.5 },
      windows: wins
    };
  }

  // ========================================================= THE REST OF IT ==
  // The plant does not stop at the fence. A ring of further units at 130-330 m
  // - tanks, columns, stacks, a second flare, sheds - built from a handful of
  // primitives with their albedo authored for aerial perspective, plus a
  // scatter of emissive specks so the far plant reads at night as LIGHTS rather
  // than as a grey band. Without this the site ends in a straight edge with
  // empty sky under it, which is the "perfectly straight anything" on the
  // instant-fail list.
  function buildDistant(L, B, rng, N) {
    var i, k;
    var placed = [];
    function clear(x, z, r) {
      if (Math.abs(x) < SITE_X1 + 24 && Math.abs(z) < SITE_Z1 + 24) return false;
      for (var q = 0; q < placed.length; q++) {
        var dx = placed[q][0] - x, dz = placed[q][1] - z;
        if (dx * dx + dz * dz < (placed[q][2] + r) * (placed[q][2] + r)) return false;
      }
      placed.push([x, z, r]);
      return true;
    }
    B.paint = 'far';
    for (i = 0; i < 190; i++) {
      var ang = rng.range(0, Math.PI * 2);
      var rad = 128 + Math.pow(rng.next(), 0.62) * 200;
      var x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      var kind = rng.next();
      var gyv = farY(x, z, N);
      if (kind < 0.28) {                       // a tank
        var tr = rng.range(7, 21);
        if (!clear(x, z, tr + 4)) continue;
        var th = tr * rng.range(0.55, 0.95);
        B.cyl('far', tr, tr, th, x, gyv + th * 0.5, z, 0, 0, 0, 14, true);
        B.cyl('far', tr * 0.1, tr, 1.3, x, gyv + th + 0.6, z, 0, 0, 0, 14, true);
      } else if (kind < 0.52) {                // a column cluster
        if (!clear(x, z, 12)) continue;
        var n2 = rng.int(2, 4);
        for (k = 0; k < n2; k++) {
          var ox = x + rng.range(-9, 9), oz = z + rng.range(-9, 9);
          var ch = rng.range(16, 44), cr = rng.range(1.2, 3.2);
          B.cyl('far', cr, cr, ch, ox, gyv + ch * 0.5, oz, 0, 0, 0, 10, true);
          B.cyl('far', cr + 1.1, cr + 1.1, 0.14, ox, gyv + ch * 0.72, oz, 0, 0, 0, 10, true);
          B.cyl('far', cr + 1.1, cr + 1.1, 0.14, ox, gyv + ch * 0.42, oz, 0, 0, 0, 10, true);
        }
      } else if (kind < 0.66) {                // a stack
        if (!clear(x, z, 8)) continue;
        var sh = rng.range(28, 62), sr = rng.range(1.1, 2.4);
        B.cyl('far', sr * 0.75, sr, sh, x, gyv + sh * 0.5, z, 0, 0, 0, 10, true);
      } else if (kind < 0.84) {                // a shed
        if (!clear(x, z, 16)) continue;
        var bw = rng.range(12, 40), bd = rng.range(9, 26), bh = rng.range(5, 13);
        B.boxR('far', bw, bh, bd, x, gyv + bh * 0.5, z, 0, rng.range(0, 3.14), 0, 0.05);
      } else {                                  // a rack run, seen end-on
        if (!clear(x, z, 20)) continue;
        var ryaw = rng.range(0, Math.PI * 2);
        var rl = rng.range(30, 90);
        B.boxR('far', 7.0, 0.9, rl, x, gyv + 9.5, z, 0, ryaw, 0, 0.05);
        for (k = 0; k < 8; k++) {
          var t2 = (k + 0.5) / 8;
          B.boxR('far', 0.7, 10.0, 0.7,
            x + Math.sin(ryaw) * (t2 - 0.5) * rl, gyv + 5.0,
            z + Math.cos(ryaw) * (t2 - 0.5) * rl, 0, ryaw, 0, 0.03);
        }
      }
    }
    // a second flare on the far horizon, so the burning one has a rhyme
    var fx2 = -232, fz2 = -196;
    B.cyl('far', 1.1, 2.2, 58, fx2, farY(fx2, fz2, N) + 29, fz2, 0, 0, 0, 10, true);

    // ---- the lights of the far plant --------------------------------------------
    // Flat emissive cards. At 150-330 m each one is two or three pixels and its
    // only job is to survive the haze as a POINT of sodium.
    B.paint = 'flat';
    for (i = 0; i < 260; i++) {
      var la = rng.range(0, Math.PI * 2);
      var lr = 126 + Math.pow(rng.next(), 0.5) * 205;
      var lx = Math.cos(la) * lr, lz = Math.sin(la) * lr;
      if (Math.abs(lx) < SITE_X1 + 10 && Math.abs(lz) < SITE_Z1 + 10) continue;
      var ly = farY(lx, lz, N) + rng.range(3, 34);
      var ls = rng.range(0.5, 1.5);
      // turned to face the site, or half the ring would be back-facing
      B.add('far_light', quad(ls, ls, 0, 0, 1, 1),
        makeM(lx, ly, lz, 0, Math.atan2(-lx, -lz), 0));
    }
    B.paint = 'steel';
  }

  // ================================================================== LEVEL ==
  function LevelRefinery(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_refinery';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    // Volumetric cone hints, consumed generically by lighting.js.
    this.lightShafts = [];
    // Full override of lighting.js's built-in lamp table. This level has no sun
    // worth the name; these 24 entries ARE its lighting.
    this.practicalLights = [];
    this.litWindows = [];
    this.plumes = [];
    this.columns = [];
    this.tanks = [];
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(6.0);
    this._stamp = 0;
    this._t = 0;
    this._atlasOk = false;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x5245464E) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x52464E59);
    // Dry, dusty, and a warm evening breeze off the desert. Published so any
    // consumer reading a wetness or a wind finds a number rather than undefined.
    this.wetness = 0.05;
    this.windDir = new THREE.Vector2(0.72, 0.69);
    this.windSpeed = 4.2;
    // Bounds is the PLAYABLE SITE, deliberately not the backdrop: lighting.js
    // rasterises this box into its sky-visibility volume and handing it an
    // 860 m square would coarsen the one interior that matters to nothing.
    this.bounds = new THREE.Box3(
      new THREE.Vector3(SITE_X0 - 4, -8.0, SITE_Z0 - 4),
      new THREE.Vector3(SITE_X1 + 4, 52.0, SITE_Z1 + 4));
    this.anchors = buildAnchors(this.noise);
    this.sunDir = new THREE.Vector3(SUN_X, SUN_Y, SUN_Z).normalize();
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose and nothing in here is a remembered number. The entries the
  // build pass refines (measured platform heights, the real flame position) are
  // OVERWRITTEN in place during build, never replaced, so a reference taken at
  // construction time stays valid.
  // ---------------------------------------------------------------------------
  function buildAnchors(N) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    function gy(x, z) { return groundY(x, z, N); }
    var A = {}, i;

    A.site = {
      x0: SITE_X0, x1: SITE_X1, z0: SITE_Z0, z1: SITE_Z1,
      paveX0: PAVE_X0, paveX1: PAVE_X1, paveZ0: PAVE_Z0, paveZ1: PAVE_Z1,
      groundY: function (x, z) { return groundY(x, z, N); },
      onRoad: function (x, z) { return roadF(x, z) > 0.5; },
      padAt: function (x, z) { return padAt(x, z); },
      inBund: function (x, z) { return bundF(x, z) > 0.5; }
    };

    A.road = {
      x0: ROAD_X0, x1: ROAD_X1, centreX: ROAD_CX, z0: PAVE_Z0, z1: PAVE_Z1,
      cross: { z0: XR_Z0, z1: XR_Z1, x0: XR_X0, x1: XR_X1,
               centre: V(ROAD_CX, gy(ROAD_CX, (XR_Z0 + XR_Z1) * 0.5), (XR_Z0 + XR_Z1) * 0.5) }
    };

    A.racks = [
      { name: 'west', x: WR_X, halfW: WR_HALF, z0: WR_Z0, z1: WR_Z1, pitch: WR_PITCH,
        tiers: WR_TIERS.slice(), deckY: WR_DECK,
        colX: [WR_X - WR_HALF, WR_X + WR_HALF],
        walkX: WR_X + WR_HALF - 0.62 },
      { name: 'east', x: ER_X, halfW: ER_HALF, z0: ER_Z0, z1: ER_Z1, pitch: ER_PITCH,
        tiers: ER_TIERS.slice(), deckY: 0,
        colX: [ER_X - ER_HALF, ER_X + ER_HALF], walkX: 0 }
    ];

    A.bridges = [];
    for (i = 0; i < BRIDGES.length; i++) {
      A.bridges.push({ z: BRIDGES[i].z, y: gy(0, BRIDGES[i].z) + BRIDGES[i].y,
        x0: WR_X + WR_HALF, x1: 21.0 });
    }

    A.columns = [];
    for (i = 0; i < COLS.length; i++) {
      var C = COLS[i];
      A.columns.push({ name: C.name, x: C.x, z: C.z, r: C.r, h: C.h,
        plinthY: gy(C.x, C.z), platforms: [],
        position: V(C.x, gy(C.x, C.z), C.z) });
    }
    A.catwalks = [];

    A.tanks = [];
    for (i = 0; i < TANKS.length; i++) {
      var T = TANKS[i];
      A.tanks.push({
        name: T.name, centre: V(T.x, gy(T.x, T.z), T.z), r: T.r, h: T.h,
        roofY: gy(T.x, T.z) + T.h, stairYaw: T.stair,
        bund: { x0: T.bx0, x1: T.bx1, z0: T.bz0, z1: T.bz1, h: T.bh,
                floorY: gy(T.x, T.z), wallY: siteGrade(T.x, T.z, N) + T.bh },
        manwayPos: V(T.x + Math.cos(T.stair + Math.PI) * T.r, gy(T.x, T.z) + 0.9,
          T.z + Math.sin(T.stair + Math.PI) * T.r)
      });
    }

    A.flare = {
      base: V(FL_X, gy(FL_X, FL_Z), FL_Z), padY: gy(FL_X, FL_Z),
      tipY: gy(FL_X, FL_Z) + FL_TIP, tipR: FL_TIP_R, derrickR: FL_LEG,
      flame: V(FL_X, gy(FL_X, FL_Z) + FL_TIP + 0.4, FL_Z)
    };

    A.heater = {
      centre: V((HT_X0 + HT_X1) * 0.5, gy((HT_X0 + HT_X1) * 0.5, (HT_Z0 + HT_Z1) * 0.5),
        (HT_Z0 + HT_Z1) * 0.5),
      x0: HT_X0, x1: HT_X1, z0: HT_Z0, z1: HT_Z1, h: HT_H,
      platformY: 0,
      stack: { x: HT_STACK_X, z: HT_STACK_Z, r: HT_STACK_R,
               topY: gy(HT_STACK_X, HT_STACK_Z) + HT_STACK_TOP }
    };

    A.pumpHouse = {
      centre: V((PH_X0 + PH_X1) * 0.5, gy((PH_X0 + PH_X1) * 0.5, (PH_Z0 + PH_Z1) * 0.5),
        (PH_Z0 + PH_Z1) * 0.5),
      x0: PH_X0, x1: PH_X1, z0: PH_Z0, z1: PH_Z1,
      floorY: gy((PH_X0 + PH_X1) * 0.5, (PH_Z0 + PH_Z1) * 0.5),
      eaveY: gy((PH_X0 + PH_X1) * 0.5, (PH_Z0 + PH_Z1) * 0.5) + PH_EAVE,
      ridgeY: gy((PH_X0 + PH_X1) * 0.5, (PH_Z0 + PH_Z1) * 0.5) + PH_RIDGE,
      door: { position: V(PH_X1, gy(PH_X1, PH_DOOR_Z), PH_DOOR_Z), yaw: -Math.PI * 0.5,
              w: PH_DOOR_W, h: PH_DOOR_H },
      bays: []
    };

    A.control = {
      centre: V((CB_X0 + CB_X1) * 0.5, gy((CB_X0 + CB_X1) * 0.5, (CB_Z0 + CB_Z1) * 0.5),
        (CB_Z0 + CB_Z1) * 0.5),
      x0: CB_X0, x1: CB_X1, z0: CB_Z0, z1: CB_Z1, h: CB_H,
      door: { position: V(CB_X0 - 0.4, gy(CB_X0, CB_Z0 + 3.2), CB_Z0 + 3.2), yaw: Math.PI * 0.5 }
    };

    A.manifolds = [];
    for (i = 0; i < MANIFOLDS.length; i++) {
      var Mf = MANIFOLDS[i];
      A.manifolds.push({ position: V(Mf.x, gy(Mf.x, Mf.z), Mf.z), yaw: Mf.yaw,
        w: Mf.w, side: Math.cos(Mf.yaw) > 0 ? 1 : -1, bays: [] });
    }
    A.coolers = [];
    A.gate = { position: V(0, gy(0, SITE_Z1 - 6), SITE_Z1 - 6), yaw: 0 };
    A.sun = { dir: V(SUN_X, SUN_Y, SUN_Z), azimuth: SUN_AZ, elevation: SUN_EL,
              glow: V(GLOW_X, 0, GLOW_Z) };
    A.spawn = { centre: V(1.2, gy(1.2, 34.0), 34.0), yaw: 0.02 };
    A.lamps = [];
    return A;
  }

  // ---- material access, defensively -----------------------------------------
  // Every surface is requested BY THE NAME IN THE SURF TABLE. None of those are
  // library entries, so each one resolves to its `base` - a name materials.js
  // certainly knows - and the palette entry is forced onto it.
  LevelRefinery.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.pave;
    var m = null;
    var lib = this.ctx && this.ctx.materials;

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (lib && typeof lib.get === 'function') {
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      if (surf.albedoTarget !== undefined) opts.albedoTarget = surf.albedoTarget;
      if (surf.rough !== undefined) opts.roughness = surf.rough;
      if (surf.metal !== undefined) opts.metalness = surf.metal;
      if (surf.env !== undefined) opts.envMapIntensity = surf.env;
      if (surf.side !== undefined) opts.side = surf.side;
      if (surf.alphaTest !== undefined) opts.alphaTest = surf.alphaTest;
      if (surf.emissive !== undefined) {
        opts.emissive = surf.emissive;
        opts.emissiveIntensity = surf.emissiveIntensity || 1.0;
      }
      try { m = lib.get(surf.base || 'concrete', opts); }
      catch (e) { GAME.logError('refinery.material:' + key, e); m = null; }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelRefinery.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.pave;
    var surf = SURF[key] || SURF.pave;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2],
      // A stock material has no wear shader, so a WEAR MASK painted into the
      // colour attribute would be multiplied straight onto albedo. Wear
      // surfaces therefore drop vertex colours entirely on this path.
      vertexColors: !surf.wear,
      envMapIntensity: surf.env !== undefined ? surf.env : 1.0
    });
    if (surf.side !== undefined) m.side = THREE.DoubleSide;
    if (surf.emissive !== undefined) {
      m.emissive = new THREE.Color().setHex(surf.emissive, THREE.SRGBColorSpace);
      m.emissiveIntensity = surf.emissiveIntensity || 1.0;
    }
    m.name = 'refinery_fallback_' + key;
    return m;
  };

  LevelRefinery.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0xDECA2) : this.rng); }
    catch (e) { GAME.logError('refinery.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.84, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.05,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    this._anisotropy(tex, 8);
    m.name = 'refinery_markings';
    return m;
  };

  LevelRefinery.prototype._anisotropy = function (tex, max) {
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (tex && caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(max, caps.getMaxAnisotropy() || 1));
      }
    } catch (e) { /* anisotropy is a nicety */ }
  };

  // ---- colliders --------------------------------------------------------------
  LevelRefinery.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
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

  // ---- build --------------------------------------------------------------------
  LevelRefinery.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();

    function stage(name, fn) {
      var now = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); } : function () { return 0; };
      var t0 = now();
      var r = null;
      try { r = fn(); } catch (e) { GAME.logError('refinery.' + name, e); }
      var prof = GAME.__rfProfile || (GAME.__rfProfile = []);
      prof.push(name + ':' + Math.round(now() - t0));
      return r;
    }

    // ---- the atmosphere the level actually needs -----------------------------
    // sky.js's authored fog is a 5.5 m GROUND mist at 0.015/m. On a site whose
    // subject is a 46 m flare 110 m away that is exactly the wrong shape: it
    // buries the road in haze and leaves the thing the level is about sitting in
    // clear air. A refinery at dusk has a deep, warm, particulate layer - flare
    // radiance, steam, hydrocarbon vapour - so the layer is re-scaled to 26 m
    // and thinned to match. Solved, not eyeballed:
    //     20 m across the road      -> ~11%   (the near plant stays crisp)
    //     110 m to the flare        -> ~45%   (real aerial separation)
    //     300 m to the far backdrop -> ~80%   (the rim dissolves)
    // setFog is public API and only this level calls it, so market and harbor
    // cannot move.
    stage('fog', function () {
      if (ctx && ctx.sky && typeof ctx.sky.setFog === 'function') {
        ctx.sky.setFog({
          baseY: -1.0,
          heightScale: 26.0,
          density: 0.0046,
          startDistance: 3.0,
          maxOpacity: 0.90,
          // Forward scatter is the depth cue, not the subject: two of the five
          // framings look within 30 degrees of the twilight band and a higher g
          // would flood them with cream.
          mieG: 0.58,
          glowGain: 1.05,
          desaturate: 0.20
        });
      }
      // 120 m of cascade over a 190 m site. The shadow casters that matter -
      // the rack bents, the column skirts, the bund walls - are all inside 90 m
      // of any published eye, and stretching the CSM to the backdrop would make
      // every one of them soft.
      if (ctx && ctx.lighting && typeof ctx.lighting.setShadowDistance === 'function') {
        ctx.lighting.setShadowDistance(120);
      }
    });

    stage('ground', function () { buildGround(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('rack_west', function () {
      buildRack(self, B, rng, N, {
        x: WR_X, half: WR_HALF, z0: WR_Z0, z1: WR_Z1, pitch: WR_PITCH,
        tiers: WR_TIERS, lines: WR_LINES, deckY: WR_DECK,
        loops: [{ z: -70.0, line: 22 }, { z: -14.0, line: 24 }, { z: 12.0, line: 25 }]
      });
    });
    await GAME.yieldFrame();

    stage('rack_east', function () {
      buildRack(self, B, rng, N, {
        x: ER_X, half: ER_HALF, z0: ER_Z0, z1: ER_Z1, pitch: ER_PITCH,
        tiers: ER_TIERS, lines: ER_LINES, deckY: 0,
        loops: [{ z: -46.0, line: 12 }]
      });
    });
    stage('bridges', function () { buildBridges(self, B, rng, N); });
    stage('manifolds', function () {
      self.anchors.manifolds = buildManifolds(self, B, rng, N);
    });
    await GAME.yieldFrame();

    stage('columns', function () {
      var r = buildColumns(self, B, rng, N);
      self.columns = r.columns;
      for (var i = 0; i < r.columns.length && i < self.anchors.columns.length; i++) {
        self.anchors.columns[i].platforms = r.columns[i].platforms;
        self.anchors.columns[i].top = r.columns[i].top;
        self.anchors.columns[i].shellY = r.columns[i].shellY;
      }
      self.anchors.catwalks = r.catwalks;
    });
    await GAME.yieldFrame();

    stage('tanks', function () {
      self.tanks = buildTanks(self, B, rng, N);
      self.anchors.tanks = self.tanks;
    });
    await GAME.yieldFrame();

    stage('flare', function () {
      var f = buildFlare(self, B, rng, N);
      self.anchors.flare = f;
    });
    stage('heater', function () {
      var h = buildHeater(self, B, rng, N);
      self.anchors.heater = h;
    });
    await GAME.yieldFrame();

    stage('pumphouse', function () { self.anchors.pumpHouse = buildPumpHouse(self, B, rng, N); });
    stage('control', function () {
      var c = buildControl(self, B, rng, N);
      self.anchors.control = c;
      self.litWindows = c.windows;
    });
    stage('coolers', function () { self.anchors.coolers = buildCoolers(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('fence', function () { buildFence(self, B, rng, N); });
    stage('distant', function () { buildDistant(self, B, rng, N); });
    stage('lamps', function () { self._buildLamps(B, N); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    stage('plumes', function () { self._buildPlumes(); });
    await GAME.yieldFrame();

    stage('nav', function () { self._buildNav(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);

    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    _annCache.forEach(function (g) { g.dispose(); }); _annCache.clear();
    _torCache.forEach(function (g) { g.dispose(); }); _torCache.clear();
    return this;
  };

  // ============================================================= THE LAMP RIG ==
  // 24 entries, which is exactly lighting.js's cap for a declarative level, so
  // the ORDER matters: if anything is ever dropped it must be dropped off the
  // end. They are listed most-important first.
  //
  // Calibration is taken from the one measured number in the build: level 1's
  // street sodium puts 8.6 lux on the pavement under it, against an ambient
  // floor around 0.5, and that ~17:1 is what reads as "a lamp" rather than as
  // "a slightly brighter patch". Every intensity below is solved as
  // I = E * d^2 for the surface the fixture actually aims at:
  //
  //   high mast   13.2 m over the road, want 4.5 lux  ->  790
  //   column up   22 m to the shell mid-point, 1.7    ->  820
  //   tank flood  13 m to the shell, 3.0              ->  510
  //   rack flood  10.8 m to the road, 3.2             ->  375
  //   fluoro      5.3 m to the pump-house floor, 6.5  ->  185
  //   flare       50 m to grade, 1.75                 ->  4400
  //
  // The flare is the outlier and it is the point: it is the only source in the
  // level that reaches everywhere, and it is what stops the far corners going
  // black without any global ambient having to be raised.
  //
  // lighting.js gives every entry an emissive bulb and an additive halo for
  // free, so this file builds only the FIXTURES - the masts, the brackets, the
  // reflector housings, the battens, the lens glass.
  LevelRefinery.prototype._buildLamps = function (B, N) {
    var self = this;
    var lamps = [];
    var gy = function (x, z) { return groundY(x, z, N); };

    function push(name, kind, x, y, z, kelvin, intensity, dist, cone, aim, extra) {
      var d = {
        name: name, kind: kind, pos: [x, y, z],
        kelvin: kelvin, intensity: intensity, distance: dist,
        dayBase: 0.92, fixed: true, haloScale: 0.10, haloMax: 2.4
      };
      if (cone) { d.cone = cone; d.penumbra = 0.34; }
      if (aim) d.aimPos = aim;
      if (extra) { for (var q in extra) d[q] = extra[q]; }
      lamps.push(d);
      self.anchors.lamps.push({
        name: name, kind: kind,
        pos: new THREE.Vector3(x, y, z),
        aim: aim ? new THREE.Vector3(aim[0], aim[1], aim[2]) : new THREE.Vector3(x, y - 4, z)
      });
      return d;
    }

    // A twin-headed flood on a bracket, pointed at its aim point. Used by every
    // mercury unit in the level: a housing, a hood, a lens and a cable.
    function floodHead(x, y, z, aim, scale, warm) {
      var s = scale || 1.0;
      var dx = aim[0] - x, dy = aim[1] - y, dz = aim[2] - z;
      var yaw = Math.atan2(dx, dz);
      var pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
      B.paint = 'paint';
      B.boxR('clad', 0.52 * s, 0.36 * s, 0.26 * s, x, y, z, pitch, yaw, 0, 0.02);
      B.boxR('clad', 0.60 * s, 0.05 * s, 0.22 * s, x - Math.sin(yaw) * 0.02,
        y + 0.20 * s, z - Math.cos(yaw) * 0.02, pitch - 0.35, yaw, 0, 0.01);
      B.paint = 'flat';
      B.boxR(warm ? 'lamp_w' : 'lamp_c', 0.44 * s, 0.28 * s, 0.03,
        x + Math.sin(yaw) * 0.14 * s, y - Math.sin(pitch) * 0.14 * s,
        z + Math.cos(yaw) * 0.14 * s, pitch, yaw, 0, 0.004);
      B.paint = 'steel';
      B.cyl('struct', 0.045 * s, 0.045 * s, 0.30 * s, x - Math.sin(yaw) * 0.20 * s,
        y - 0.12 * s, z - Math.cos(yaw) * 0.20 * s, 0, 0, 0, 6);
    }

    // ---- 1. THE FLARE ---------------------------------------------------------
    var fl = this.anchors.flare;
    push('rf_flare', 'fire', fl.flame.x, fl.flame.y + 3.4, fl.flame.z,
      1950, 6200, 240, 0, null,
      { haloScale: 0.06, haloMax: 11.0, haloGain: 0.62, bulbR: 0.55, bulbGain: 1.4,
        dayBase: 1.0 });

    // ---- 2-5. the high masts down the road ------------------------------------
    // Staggered left/right at 32 m centres so the road reads as alternating
    // pools with dark between them, which is what a lit road looks like. Each
    // mast is a real object: a raked column, a four-way head frame, four
    // reflectors and a cable running down the back of it.
    var MASTS = [
      [-9.9, -52.0, 3.0, -46.0],
      [9.9, -20.0, -3.0, -14.0],
      [-9.9, 12.0, 3.0, 18.0],
      [9.9, 44.0, -3.0, 38.0]
    ];
    for (var mi = 0; mi < MASTS.length; mi++) {
      var mx = MASTS[mi][0], mz = MASTS[mi][1];
      var my = gy(mx, mz);
      var headY = my + 13.2;
      B.paint = 'wall';
      B.box('wall', 1.0, 0.60, 1.0, mx, my + 0.14, mz, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.14, 0.24, 12.9, mx, my + 6.6, mz, 0, 0, 0, 10);
      B.cyl('struct', 0.36, 0.36, 0.06, mx, my + 0.46, mz, 0, 0, 0, 12);
      // the head frame
      B.box('struct', 2.3, 0.10, 0.12, mx, headY + 0.28, mz, 0.01);
      B.box('struct', 0.12, 0.10, 1.5, mx, headY + 0.28, mz, 0.01);
      B.strut('struct', mx, headY - 0.6, mz, mx - 1.0, headY + 0.24, mz, 0.06, 0.06);
      B.strut('struct', mx, headY - 0.6, mz, mx + 1.0, headY + 0.24, mz, 0.06, 0.06);
      var aimTo = [MASTS[mi][2], my, MASTS[mi][3]];
      floodHead(mx - 0.85, headY, mz, aimTo, 1.15, true);
      floodHead(mx + 0.85, headY, mz, [MASTS[mi][2] * -0.6, my, MASTS[mi][3] - 8], 1.15, true);
      // the riser conduit, and the base cabinet
      B.paint = 'steel';
      B.tube('rust', mx + 0.26, my + 0.5, mz, mx + 0.26, headY - 0.4, mz, 0.035, 5);
      B.paint = 'paint';
      B.box('clad', 0.46, 0.85, 0.32, mx + 0.55, my + 0.44, mz + 0.30, 0.012);
      B.paint = 'flat';
      decalCard(B, CELL.hazard, mx, my + 0.05, mz, 2.0, 0.55, 'y', mi * 0.7);
      B.paint = 'steel';
      self.addCollider(mx, my + 6.6, mz, 0.30, 6.6, 0.30, 'metal');
      push('rf_mast_' + mi, 'sodium', mx, headY, mz, 1980, 790, 46, 1.05, aimTo,
        { haloMax: 2.9, haloGain: 0.95 });
    }

    // ---- 6-8. cold uplights on the column plinth --------------------------------
    // Aimed UP the shells from 2.2 m. This is the "cold floods from below" half
    // of the brief and it is the only thing modelling the level's tallest
    // objects: without it the column row is a black cut-out.
    var UPS = [
      [22.2, -40.0, 28.0, 24.0, -44.0],
      [22.2, -22.0, 26.0, 18.0, -25.0],
      [23.0, -4.0, 29.0, 15.0, -9.0]
    ];
    for (var ui = 0; ui < UPS.length; ui++) {
      var ux = UPS[ui][0], uz = UPS[ui][1];
      var uy = gy(ux, uz);
      var uaim = [UPS[ui][2], uy + UPS[ui][3], UPS[ui][4]];
      B.paint = 'wall';
      B.box('wall', 0.85, 0.35, 0.85, ux, uy + 0.14, uz, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.07, 0.09, 1.85, ux, uy + 0.95, uz, 0, 0, 0, 8);
      floodHead(ux, uy + 1.95, uz, uaim, 1.35, false);
      self.addCollider(ux, uy + 1.0, uz, 0.42, 1.0, 0.42, 'metal');
      // 6200 K, not 5600. The whole level is inside a warm grade with a warm
      // key; a mercury unit that is merely "not sodium" reads as white, and
      // white is not the other half of a warm/cool split. At 6200 the column
      // shells come back measurably blue against the road.
      push('rf_colup_' + ui, 'mercury', ux, uy + 1.95, uz, 6200, 950, 54, 0.52, uaim,
        { haloMax: 2.2, haloGain: 0.50 });
    }

    // ---- 9-11. tank-farm floods on the bund wall ---------------------------------
    // ---- WHY THESE ARE NOT ON THE BUND WALL --------------------------------
    // They were, and the result was the single worst frame of the build: a
    // fixture on the bund coping stands 4 m from a 29 m tank shell, so at 430 cd
    // it puts 27 lux on the plate directly in front of it and reads as a blown
    // white hole punched in the tank. Inverse square is not negotiable - the
    // only fix is DISTANCE. They now stand on 9.5 m masts on the apron outside
    // the bund, 20-28 m off the shell they light, and each one is aimed at the
    // FAR shoulder of its tank so the near plate gets the soft edge of the cone
    // and the light rakes round the curve instead of hitting it square. Peak on
    // the shell is ~1.1 lux, the courses and the spiral stair model properly,
    // and the spill carries the bund floor that was previously black.
    var TF = [
      [-26.0, -62.0, -48.0, 6.5, -44.0],
      [-26.0, -22.0, -48.0, 6.5, -6.0],
      [-38.0, 20.0, -56.0, 6.0, 38.0]
    ];
    for (var ti = 0; ti < TF.length; ti++) {
      var tx = TF[ti][0], tz = TF[ti][1];
      var tg0 = gy(tx, tz);
      var ty = tg0 + 9.50;
      var taim = [TF[ti][2], TF[ti][3], TF[ti][4]];
      B.paint = 'wall';
      B.box('wall', 0.95, 0.55, 0.95, tx, tg0 + 0.14, tz, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.11, 0.19, 9.30, tx, tg0 + 4.70, tz, 0, 0, 0, 9);
      B.cyl('struct', 0.32, 0.32, 0.06, tx, tg0 + 0.44, tz, 0, 0, 0, 12);
      B.box('struct', 1.5, 0.09, 0.11, tx, ty + 0.26, tz, 0.01);
      B.strut('struct', tx, ty - 0.5, tz, tx - 0.62, ty + 0.22, tz, 0.055, 0.055);
      B.strut('struct', tx, ty - 0.5, tz, tx + 0.62, ty + 0.22, tz, 0.055, 0.055);
      floodHead(tx - 0.55, ty, tz, taim, 1.35, false);
      floodHead(tx + 0.55, ty, tz,
        [taim[0] + 6.0, taim[1] - 2.0, taim[2] + (ti === 2 ? -9.0 : -14.0)], 1.35, false);
      B.paint = 'steel';
      B.tube('rust', tx + 0.22, tg0 + 0.5, tz, tx + 0.22, ty - 0.4, tz, 0.032, 5);
      self.addCollider(tx, tg0 + 4.7, tz, 0.28, 4.7, 0.28, 'metal');
      push('rf_tank_' + ti, 'mercury', tx, ty, tz, 5900, 620, 62, 0.72, taim,
        { haloMax: 2.4, haloGain: 0.50 });
    }

    // ---- 12-13. floods off the west rack, down onto the road ---------------------
    var RF = [[-10.8, -34.0, -3.0, -40.0], [-10.8, 4.0, -3.0, 10.0]];
    for (var ri = 0; ri < RF.length; ri++) {
      var rx = RF[ri][0], rz = RF[ri][1];
      var ry = gy(rx, rz) + WR_TIERS[2] + 0.35;
      var raim = [RF[ri][2], gy(RF[ri][2], RF[ri][3]), RF[ri][3]];
      B.paint = 'steel';
      B.strut('struct', rx, ry, rz, rx + 0.85, ry + 0.30, rz, 0.07, 0.07);
      floodHead(rx + 0.95, ry + 0.30, rz, raim, 1.30, false);
      push('rf_rack_' + ri, 'mercury', rx + 0.95, ry + 0.30, rz, 5200, 375, 34, 0.66, raim,
        { haloMax: 2.0, haloGain: 0.48 });
    }

    // ---- 14. flood off the east rack, up at the columns --------------------------
    (function () {
      var x = ER_X + ER_HALF - 0.2, z = -46.0;
      var y = gy(x, z) + ER_TIERS[1] + 0.35;
      var aim = [26.0, y + 12.0, -44.0];
      B.paint = 'steel';
      B.strut('struct', x, y, z, x + 0.8, y + 0.25, z, 0.07, 0.07);
      floodHead(x + 0.9, y + 0.25, z, aim, 1.30, false);
      push('rf_rack_e', 'mercury', x + 0.9, y + 0.25, z, 5200, 420, 36, 0.70, aim,
        { haloMax: 2.0, haloGain: 0.48 });
    })();

    // ---- 15-17. the pump house interior ------------------------------------------
    // Three battens over the pump row. Rig 'mixed' holds practicals at a
    // lampFloor of 0.85, so these are on, and they are the entire `interior`
    // framing: a cold rhythm down a dark hall.
    var phc = this.anchors.pumpHouse;
    for (var pi = 0; pi < 3; pi++) {
      var px2 = PH_X0 + 4.6 + pi * 6.4;
      var pz2 = phc.centre.z - 0.3;
      var pyy = phc.floorY + 5.30;
      B.paint = 'paint';
      B.box('clad', 0.16, 0.12, 1.55, px2, pyy + 0.07, pz2, 0.01);
      B.paint = 'flat';
      B.box('lamp_c', 0.11, 0.05, 1.42, px2, pyy, pz2, 0.006);
      B.paint = 'steel';
      B.tube('rail', px2, phc.floorY + 5.95, pz2 - 0.6, px2, pyy + 0.10, pz2 - 0.6, 0.010, 4);
      B.tube('rail', px2, phc.floorY + 5.95, pz2 + 0.6, px2, pyy + 0.10, pz2 + 0.6, 0.010, 4);
      push('rf_ph_' + pi, 'fluoro_cold', px2, pyy - 0.06, pz2, 5800, 235, 19, 1.40,
        [px2, phc.floorY, pz2], { haloMax: 1.5, haloGain: 0.42 });
    }

    // ---- 18. the wall pack over the roll shutter ----------------------------------
    (function () {
      var x = PH_X1 + 0.30, y = phc.floorY + 5.30, z = PH_DOOR_Z;
      var aim = [PH_X1 + 6.5, phc.floorY, PH_DOOR_Z];
      B.paint = 'steel';
      B.strut('struct', PH_X1, y - 0.1, z, x, y, z, 0.06, 0.06);
      floodHead(x, y, z, aim, 1.0, true);
      push('rf_ph_door', 'sodium', x, y, z, 2050, 240, 26, 0.90, aim,
        { haloMax: 2.2, haloGain: 0.85 });
    })();

    // ---- 19. the heater platform --------------------------------------------------
    (function () {
      var ht = self.anchors.heater;
      var x = HT_X0 - 1.5, y = (ht.platformY || (gy(HT_X0, HT_Z0) + 9.5)) + 2.4, z = HT_Z0 - 1.1;
      var aim = [HT_X0 + 6.0, y - 6.0, HT_Z0 - 0.4];
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 2.4, x, y - 1.2, z, 0, 0, 0, 6);
      floodHead(x, y, z, aim, 1.2, false);
      push('rf_heater', 'mercury', x, y, z, 5200, 430, 32, 0.72, aim,
        { haloMax: 2.0, haloGain: 0.48 });
    })();

    // ---- 20. the control building's porch ------------------------------------------
    (function () {
      var cb = self.anchors.control;
      var x = CB_X0 - 0.55, y = cb.centre.y + 3.55, z = CB_Z0 + 3.2;
      var aim = [CB_X0 - 6.0, cb.centre.y, CB_Z0 + 3.2];
      B.paint = 'steel';
      B.strut('struct', CB_X0 - 0.15, y - 0.05, z, x, y, z, 0.05, 0.05);
      floodHead(x, y, z, aim, 0.95, true);
      push('rf_control', 'sodium', x, y, z, 2050, 210, 24, 0.95, aim,
        { haloMax: 2.2, haloGain: 0.85 });
    })();

    // ---- 21. the flare pad ----------------------------------------------------------
    // The knock-out drum area sits directly under the flame, and a light that
    // is 50 m straight up leaves everything beneath it flat. This one rakes it.
    (function () {
      var x = FL_X + 11.5, z = FL_Z + 7.0;
      var y = gy(x, z) + 6.2;
      var aim = [FL_X + 1.0, gy(FL_X, FL_Z) + 2.5, FL_Z + 1.0];
      B.paint = 'steel';
      B.cyl('struct', 0.09, 0.13, 6.0, x, gy(x, z) + 3.0, z, 0, 0, 0, 8);
      floodHead(x, y, z, aim, 1.3, false);
      self.addCollider(x, gy(x, z) + 3.0, z, 0.25, 3.0, 0.25, 'metal');
      push('rf_flarepad', 'mercury', x, y, z, 5400, 480, 40, 0.68, aim,
        { haloMax: 2.0, haloGain: 0.48 });
    })();

    // ---- 22. the cross-road junction ------------------------------------------------
    (function () {
      var x = 10.4, z = 17.5;
      var y = gy(x, z) + 10.8;
      var aim = [-2.0, gy(-2, 17.5), 17.5];
      B.paint = 'steel';
      B.cyl('struct', 0.12, 0.20, 10.5, x, gy(x, z) + 5.3, z, 0, 0, 0, 9);
      B.strut('struct', x, y - 0.4, z, x - 1.1, y + 0.2, z, 0.06, 0.06);
      floodHead(x - 1.2, y + 0.2, z, aim, 1.1, true);
      B.paint = 'wall';
      B.box('wall', 0.9, 0.5, 0.9, x, gy(x, z) + 0.12, z, 0.02);
      B.paint = 'steel';
      self.addCollider(x, gy(x, z) + 5.3, z, 0.26, 5.3, 0.26, 'metal');
      push('rf_xroad', 'sodium', x - 1.2, y + 0.2, z, 1980, 650, 40, 1.10, aim,
        { haloMax: 2.8, haloGain: 0.95 });
    })();

    // ---- 23. the rack walkway ---------------------------------------------------------
    // hero2 stands on this deck. Without a source ON it the whole foreground of
    // that framing is unlit grating with a bright plant behind it.
    (function () {
      var x = WR_X + WR_HALF - 1.35, z = -4.0;
      var y = gy(x, z) + WR_DECK + 2.55;
      var aim = [x, gy(x, z) + WR_DECK, z - 9.0];
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 2.5, x, y - 1.25, z, 0, 0, 0, 6);
      floodHead(x, y, z, aim, 0.95, true);
      push('rf_deck', 'sodium', x, y, z, 2100, 175, 22, 1.05, aim,
        { haloMax: 2.0, haloGain: 0.85 });
    })();

    // ---- 24. the column catwalk -------------------------------------------------------
    // A single warm mark 23 m up. It is the highest light in the level after
    // the flare and it is what puts a note in the TOP of the hero framings so
    // the column row does not end in darkness.
    (function () {
      var cat = (self.anchors.catwalks && self.anchors.catwalks.length)
        ? self.anchors.catwalks[self.anchors.catwalks.length - 1] : null;
      var x = cat ? (cat.from.x + cat.to.x) * 0.5 : 27.0;
      var z = cat ? (cat.from.z + cat.to.z) * 0.5 : -17.0;
      var y = (cat ? cat.y : gy(27, -17) + CAT_Y[1]) + 2.35;
      var aim = [x, y - 2.4, z];
      B.paint = 'steel';
      B.cyl('struct', 0.045, 0.045, 2.3, x, y - 1.15, z, 0, 0, 0, 6);
      floodHead(x, y, z, aim, 0.9, true);
      push('rf_catwalk', 'sodium', x, y - 0.1, z, 2100, 150, 20, 1.15, aim,
        { haloMax: 1.9, haloGain: 0.85 });
    })();

    this.practicalLights = lamps;

    // ---- volumetric shafts --------------------------------------------------------
    // lighting.js solves a shaft mostly-downward from an aperture, so these are
    // the three places in the level where a real cone of light exists in air:
    // under the flare, out of the pump-house shutter, and off the heater's
    // burner deck.
    var phy = this.anchors.pumpHouse.floorY;
    this.lightShafts = [
      { origin: new THREE.Vector3(FL_X, fl.tipY - 3.0, FL_Z),
        dir: new THREE.Vector3(0.10, -1.0, 0.05).normalize(),
        width: 6.0, length: 26.0, strength: 1.0, kind: 'hero3',
        always: true, kelvin: 1950, lux: 5.5 },
      { origin: new THREE.Vector3(PH_X1 + 0.4, phy + PH_DOOR_H - 0.6, PH_DOOR_Z),
        dir: new THREE.Vector3(0.55, -1.0, 0.0).normalize(),
        width: 3.4, length: 5.4, strength: 0.72, kind: 'interior',
        always: true, kelvin: 4600, lux: 4.0 },
      { origin: new THREE.Vector3((HT_X0 + HT_X1) * 0.5, groundY(HT_X0, HT_Z0, N) + 2.5,
          HT_Z0 - 0.4),
        dir: new THREE.Vector3(-0.20, -1.0, -0.35).normalize(),
        width: 4.6, length: 3.2, strength: 0.62, kind: 'heater',
        always: true, kelvin: 2200, lux: 3.2 }
    ];
  };

  // ================================================================== PLUMES ==
  // The flare's flame and smoke tail, and three steam vents. These are the only
  // moving things in the level and the brief asks for both by name ("flare
  // stacks throwing REAL MOVING firelight", "steam venting").
  //
  // Each is a lofted tube of rings whose vertices are rewritten every frame from
  // two decorrelated noise fields. Colour is per-vertex in LINEAR HDR - the
  // flame core sits around 7.5 in red - because postfx tonemaps in the composite
  // and 'sodium' rolls its highlights off over a range of 8. A flame authored at
  // 1.0 would just be an orange shape; authored at 7.5 it is an emitter.
  LevelRefinery.prototype._buildPlumes = function () {
    var self = this;
    var fl = this.anchors.flare;

    function make(kind, x, y, z, opts) {
      var isFlame = (kind === 'flame');
      var nRing = opts.rings || 15, nRad = opts.rad || 9;
      var geo;
      try {
        geo = isFlame ? plumeGeometry(nRing, nRad) : puffGeometry(opts.puffs || 22);
      } catch (e) { GAME.logError('refinery.plume', e); return null; }
      var mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, fog: !isFlame,
        map: isFlame ? null : puffTexture(),
        blending: isFlame ? THREE.AdditiveBlending : THREE.NormalBlending,
        toneMapped: false
      });
      mat.name = 'refinery_' + kind;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'refinery_plume_' + kind;
      mesh.frustumCulled = false;
      mesh.renderOrder = kind === 'flame' ? 5 : 4;
      mesh.castShadow = false; mesh.receiveShadow = false;
      self.root.add(mesh);
      var p = {
        kind: kind, mesh: mesh, geo: geo, nRing: nRing, nRad: nRad,
        puffs: isFlame ? 0 : (opts.puffs || 22),
        origin: new THREE.Vector3(x, y, z),
        h: opts.h, r0: opts.r0, r1: opts.r1, r2: opts.r2,
        lean: opts.lean || 0.30, wob: opts.wob || 1.0,
        speed: opts.speed || 1.0, phase: opts.phase || 0,
        col0: opts.col0, col1: opts.col1, col2: opts.col2,
        a0: opts.a0, a1: opts.a1
      };
      geo.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(x, y + opts.h * 0.5, z), opts.h * 0.9 + 6);
      self.plumes.push(p);
      return p;
    }

    // The flame. Twenty metres of it, leaning downwind, hot core to a cooling
    // tip. It is deliberately the largest emissive object in the build: from
    // the hero1 standpoint 114 m away it subtends 10 degrees, and anything less
    // reads as a lamp on a pole rather than as a burning stack.
    make('flame', fl.flame.x, fl.flame.y, fl.flame.z, {
      rings: 18, rad: 10, h: 20.0, r0: 1.30, r1: 3.30, r2: 0.80,
      lean: 0.40, wob: 1.1, speed: 1.0, phase: 0.0,
      col0: [8.4, 3.30, 0.66], col1: [4.8, 1.40, 0.17], col2: [1.6, 0.32, 0.045],
      a0: 0.95, a1: 0.0
    });
    // The smoke tail. Incompletely burned heavy ends, and the thing that makes
    // the flame read as combustion rather than as a neon sign.
    //
    // RE-AUTHORED. The first version was a wide, cool grey tube at alpha 0.44
    // and it printed as a flat lens-shaped DISC hanging next to the flare -
    // partly because a double-sided alpha tube accumulates its own front and
    // back faces, and partly because grey smoke against a grey-violet dusk sky
    // has no edge except the one its own silhouette draws. It is now warm (a
    // real plume is lit from below by the fire it came out of), narrower, and
    // less than half as opaque, so it dissolves into the sky instead of cutting
    // a shape out of it.
    make('smoke', fl.flame.x, fl.flame.y + 17.0, fl.flame.z, {
      puffs: 26, h: 34.0, r0: 2.6, r1: 4.4, r2: 7.6,
      lean: 1.85, wob: 1.9, speed: 0.40, phase: 3.1,
      col0: [0.46, 0.24, 0.11], col1: [0.20, 0.135, 0.095], col2: [0.10, 0.09, 0.09],
      a0: 0.26, a1: 0.0
    });

    // Steam. Three vents, all at places the player can stand near, all lit by
    // the practicals they sit under - which is the only way a white plume at
    // dusk reads as vapour rather than as a hole in the frame.
    var ht = this.anchors.heater;
    make('steam', ht.stack.x - 4.0, ht.stack.topY - 7.0, ht.stack.z + 3.0, {
      puffs: 18, h: 17.0, r0: 0.40, r1: 1.55, r2: 3.4,
      lean: 1.35, wob: 1.2, speed: 0.62, phase: 1.7,
      col0: [0.60, 0.62, 0.68], col1: [0.34, 0.36, 0.42], col2: [0.15, 0.16, 0.20],
      a0: 0.40, a1: 0.0
    });
    var c2 = this.columns.length > 1 ? this.columns[1] : null;
    if (c2) {
      make('steam', c2.x + c2.r * 1.5, c2.top - 1.0, c2.z + 1.0, {
        puffs: 16, h: 12.0, r0: 0.22, r1: 0.90, r2: 2.1,
        lean: 1.05, wob: 1.5, speed: 0.80, phase: 5.2,
        col0: [0.64, 0.67, 0.73], col1: [0.36, 0.38, 0.44], col2: [0.14, 0.15, 0.19],
        a0: 0.38, a1: 0.0
      });
    }
    make('steam', ROAD_X1 + 2.6, groundY(ROAD_X1 + 2.6, -34.0, this.noise) + 1.2, -34.0, {
      puffs: 14, h: 8.0, r0: 0.20, r1: 0.78, r2: 1.7,
      lean: 0.85, wob: 1.7, speed: 1.15, phase: 2.3,
      col0: [0.56, 0.59, 0.64], col1: [0.30, 0.32, 0.37], col2: [0.12, 0.13, 0.16],
      a0: 0.34, a1: 0.0
    });
    this._updatePlumes(0, null);
  };

  var _pRight = new THREE.Vector3(1, 0, 0);
  var _pUp = new THREE.Vector3(0, 1, 0);

  LevelRefinery.prototype._updatePlumes = function (t, cam) {
    var N = this.noise;
    // Sprite basis. Taken off the camera's world matrix so the puffs face the
    // eye; falls back to world axes when there is no camera yet (build time).
    if (cam && cam.matrixWorld) {
      var e = cam.matrixWorld.elements;
      _pRight.set(e[0], e[1], e[2]).normalize();
      _pUp.set(e[4], e[5], e[6]).normalize();
    }
    for (var p = 0; p < this.plumes.length; p++) {
      var P = this.plumes[p];
      if (P.kind !== 'flame') { this._updatePuffs(P, t, N); continue; }
      var pos = P.geo.attributes.position.array;
      var col = P.geo.attributes.color.array;
      var tt = t * P.speed + P.phase;
      var wx = this.windDir.x, wz = this.windDir.y;
      for (var r = 0; r < P.nRing; r++) {
        var u = r / (P.nRing - 1);
        // the axis: rises, leans downwind with height, and snakes
        var sway = N.perlin2(tt * 0.9 - u * 2.4, P.phase * 3.0) * P.wob;
        var sway2 = N.perlin2(tt * 0.55 - u * 1.5, P.phase * 3.0 + 11.0) * P.wob;
        var lean = P.lean * u * u;
        var cxr = P.origin.x + wx * lean * P.h + sway * (0.30 + u * 1.5);
        var cyr = P.origin.y + P.h * u;
        var czr = P.origin.z + wz * lean * P.h + sway2 * (0.30 + u * 1.5);
        // radius: necks in at the root, swells, then dissipates
        var rad = (u < 0.35)
          ? M.lerp(P.r0, P.r1, M.smoothstep(0, 0.35, u))
          : M.lerp(P.r1, P.r2, M.smoothstep(0.35, 1.0, u));
        // colour and opacity fall along the axis
        var cA, cB, ct;
        if (u < 0.45) { cA = P.col0; cB = P.col1; ct = u / 0.45; }
        else { cA = P.col1; cB = P.col2; ct = (u - 0.45) / 0.55; }
        var alpha = M.lerp(P.a0, P.a1, Math.pow(u, P.kind === 'flame' ? 1.35 : 0.85));
        // the flicker: fast fbm on the flame, a slow breath on steam
        var flick = (P.kind === 'flame')
          ? 1.0 + N.fbm2(tt * 3.1 + u * 4.0, 7.3, 3, 2, 0.5) * 0.55
          : 1.0 + N.perlin2(tt * 0.7 + u * 1.2, 19.0) * 0.22;
        for (var a = 0; a < P.nRad; a++) {
          var ang = a / P.nRad * Math.PI * 2;
          // per-vertex ripple so the tube is not a lathe
          var rip = 1.0 + N.perlin2(tt * 2.0 + ang * 1.6 + u * 3.0, P.phase + 31.0) * 0.34;
          var rr = rad * rip * (P.kind === 'flame' ? (0.72 + flick * 0.34) : 1.0);
          var i3 = (r * P.nRad + a) * 3, i4 = (r * P.nRad + a) * 4;
          pos[i3] = cxr + Math.cos(ang) * rr;
          pos[i3 + 1] = cyr;
          pos[i3 + 2] = czr + Math.sin(ang) * rr;
          col[i4] = M.lerp(cA[0], cB[0], ct) * flick;
          col[i4 + 1] = M.lerp(cA[1], cB[1], ct) * flick;
          col[i4 + 2] = M.lerp(cA[2], cB[2], ct) * flick;
          col[i4 + 3] = alpha;
        }
      }
      P.geo.attributes.position.needsUpdate = true;
      P.geo.attributes.color.needsUpdate = true;
    }
  };

  // Soft sprites along the same axis the tube path uses, so a plume and its
  // flame agree about where the wind is taking them.
  LevelRefinery.prototype._updatePuffs = function (P, t, N) {
    var pos = P.geo.attributes.position.array;
    var col = P.geo.attributes.color.array;
    var tt = t * P.speed + P.phase;
    var wx = this.windDir.x, wz = this.windDir.y;
    var n = P.puffs;
    for (var i = 0; i < n; i++) {
      // u scrolls, so puffs are born at the vent and die at the top instead of
      // sitting at fixed stations - a static sprite stack reads as a sculpture.
      var u = ((i + 0.5) / n + tt * 0.055) % 1;
      var sway = N.perlin2(tt * 0.8 - u * 2.2, P.phase * 3.0) * P.wob;
      var sway2 = N.perlin2(tt * 0.5 - u * 1.4, P.phase * 3.0 + 11.0) * P.wob;
      var lean = P.lean * u * u;
      // a fixed per-puff jitter so the column is not a perfect line of discs
      var jx = N.perlin2(i * 3.31, P.phase * 7.0) * 0.9;
      var jz = N.perlin2(i * 3.31 + 41.0, P.phase * 7.0) * 0.9;
      var cx = P.origin.x + wx * lean * P.h + sway * (0.30 + u * 1.6) + jx * (0.4 + u * 2.2);
      var cy = P.origin.y + P.h * u;
      var cz = P.origin.z + wz * lean * P.h + sway2 * (0.30 + u * 1.6) + jz * (0.4 + u * 2.2);
      var rad = (u < 0.35)
        ? M.lerp(P.r0, P.r1, M.smoothstep(0, 0.35, u))
        : M.lerp(P.r1, P.r2, M.smoothstep(0.35, 1.0, u));
      rad *= 1.35 + N.perlin2(i * 7.7, tt * 0.5) * 0.30;
      var cA, cB, ct;
      if (u < 0.45) { cA = P.col0; cB = P.col1; ct = u / 0.45; }
      else { cA = P.col1; cB = P.col2; ct = (u - 0.45) / 0.55; }
      // fade in over the first 8% so a newly-born puff does not pop
      var alpha = M.lerp(P.a0, P.a1, Math.pow(u, 0.80)) *
        M.smoothstep(0.0, 0.09, u) * (0.72 + N.perlin2(i * 1.9, tt * 0.7) * 0.28);
      var rx = _pRight.x * rad, ry = _pRight.y * rad, rz = _pRight.z * rad;
      var ux = _pUp.x * rad, uy = _pUp.y * rad, uz = _pUp.z * rad;
      var o = i * 4;
      for (var q = 0; q < 4; q++) {
        var sx = (q === 0 || q === 3) ? -1 : 1;
        var sy = (q < 2) ? -1 : 1;
        var j3 = (o + q) * 3, j4 = (o + q) * 4;
        pos[j3] = cx + rx * sx + ux * sy;
        pos[j3 + 1] = cy + ry * sx + uy * sy;
        pos[j3 + 2] = cz + rz * sx + uz * sy;
        col[j4] = M.lerp(cA[0], cB[0], ct);
        col[j4 + 1] = M.lerp(cA[1], cB[1], ct);
        col[j4 + 2] = M.lerp(cA[2], cB[2], ct);
        col[j4 + 3] = alpha;
      }
    }
    P.geo.attributes.position.needsUpdate = true;
    P.geo.attributes.color.needsUpdate = true;
  };

  // ---- merge + vertex-colour pass -------------------------------------------------
  LevelRefinery.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.pave;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('refinery.merge:' + key, e); continue; }
      // keepUV means the source geometry authored its own UVs (the atlas cards,
      // the distant lights). mergeAll drops the whole uv attribute if ANY entry
      // in the bucket lacks one, so the second clause is not belt-and-braces: a
      // single un-UV'd solid landing in a keepUV bucket would otherwise hand a
      // mapped material a geometry with no uv.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('refinery.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'refinery_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'glass') mesh.renderOrder = 3;
      // The backdrop is 130-330 m out on a single merged mesh. Frustum culling
      // that against one bounding sphere is a coin flip, and losing it for a
      // frame is a hole in the world.
      if (key === 'far' || key === 'far_light' || key === 'sandy') mesh.frustumCulled = false;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours. On `wear` surfaces this is materials.js's WEAR MASK -
  // white = pristine, R grime, G wetness, B edge wear. On everything else it is
  // a plain albedo multiplier.
  //
  // The harbor's lesson is enforced here too: the wet channel carries ONLY what
  // the level knows and a global driver cannot. This plant is DRY - the roster
  // says clear and the site is in a desert - so G stays near white everywhere
  // except the bund floors and the drainage channels, where hydrocarbon and
  // washdown water genuinely stand.
  var WEAR_KEYS = { pave: 1, road: 1, wall: 1, brick: 1 };

  LevelRefinery.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var Nv = pos.count;
    var col = new Float32Array(Nv * 3);
    var noise = this.noise;
    var surf = SURF[key] || SURF.pave;
    var isWear = !!surf.wear;
    var vi = 0, e, i, j;

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode = ent.paint || 'steel';
      // Force the mode to agree with the surface's shader: a multiplier written
      // into a wear mask (or the reverse) is a silent, catastrophic bug.
      if (isWear) {
        if (key === 'pave') mode = 'pave';
        else if (key === 'road') mode = 'road';
        else if (key === 'brick') mode = 'block';
        else mode = 'wallwear';
      } else if (WEAR_KEYS[mode]) {
        mode = 'steel';
      }
      if (key === 'decal' || key === 'lamp_w' || key === 'lamp_c' ||
          key === 'lamp_r' || key === 'far_light') {
        mode = 'flat';
      } else if (key === 'far') { mode = 'far'; }
      else if (key === 'sandy') { mode = 'sand'; }
      else if (key === 'grit') { mode = 'grit'; }
      else if (key === 'kerb') { mode = 'kerb'; }
      else if (key === 'tank') { mode = (mode === 'seam') ? 'seam' : 'tankshell'; }
      else if (key === 'lag') { mode = 'lagging'; }
      else if (key === 'grate') { mode = 'grate'; }
      else if (key === 'rail') { mode = 'rail'; }
      else if (key === 'glass') { mode = 'glass'; }
      else if (key === 'chain') { mode = 'mesh'; }
      else if (key === 'refract') { mode = 'refractory'; }
      else if (key === 'clad' || key === 'roof') {
        mode = (mode === 'shutter') ? 'shutter' : 'clad';
      }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r, g, b;

        if (mode === 'pave') {
          // ---- GRIME -----------------------------------------------------------
          // Oil, catalyst dust and the grey film a process plant lives under.
          // Heaviest on the traffic lanes and against every kerb, because that
          // is where the wash-down pushes it.
          var lane = M.smoothstep(6.0, 1.0, Math.abs(x - ROAD_X1 - 3.0)) +
                     M.smoothstep(6.0, 1.0, Math.abs(x - ROAD_X0 + 3.0));
          var gm = M.saturate(0.16 + 0.30 * (noise.fbm2(x * 0.10 + 2, z * 0.10 - 5, 3) * 0.5 + 0.5) +
            M.saturate(lane) * 0.20);
          // a heavy hydrocarbon bloom under the unit pads
          gm += M.smoothstep(0.62, 0.95, noise.fbm2(x * 0.28 - 4, z * 0.28 + 9, 2) * 0.5 + 0.5) *
            padAt(x, z) * 0.9;
          // ---- WETNESS ----------------------------------------------------------
          // Only the channels and the low spots. The site is dry.
          var wet = M.saturate(channelDip(x, z) / 0.06) * 0.75;
          wet = Math.max(wet, M.smoothstep(0.020, 0.026, jointDip(x, z)) * 0.30);
          // ---- EDGE WEAR / POLISH ------------------------------------------------
          // Where the tyres run the concrete is burnished and PALE, and on a
          // 156 m sheet of grey that is the only thing giving a raking mast any
          // tonal structure to find.
          var pol = M.saturate(M.saturate(lane) * 0.42 +
            M.smoothstep(0.52, 0.88, noise.fbm2(x * 0.24 + 3, z * 0.24 - 1, 3) * 0.5 + 0.5) * 0.34);
          r = 1 - M.saturate(gm) * 0.66; g = 1 - wet; b = 1 - pol;
        } else if (mode === 'road') {
          var gr = M.saturate(0.20 + 0.24 * (noise.fbm2(x * 0.16 + 7, z * 0.16 + 2, 3) * 0.5 + 0.5));
          // the two wheel tracks, polished by traffic, and the oil line between
          var wt = Math.min(Math.abs(Math.abs(x - ROAD_CX) - 2.5), 3.0) / 3.0;
          var pol2 = M.saturate((1 - wt) * 0.55);
          gr += M.smoothstep(0.9, 0.15, Math.abs(x - ROAD_CX)) * 0.24;
          var wet2 = M.smoothstep(0.60, 0.92, noise.fbm2(x * 0.5, z * 0.5, 2) * 0.5 + 0.5) * 0.18;
          r = 1 - M.saturate(gr) * 0.60; g = 1 - wet2; b = 1 - pol2;
        } else if (mode === 'wallwear') {
          // Concrete walls, plinth kerbs, bund walls. Splash zone at the base,
          // form-face blotching, weep staining under every horizontal.
          var gw = M.saturate(0.14 + 0.26 * (noise.fbm3(x * 0.30, y * 0.30, z * 0.30, 3) * 0.5 + 0.5));
          gw += M.smoothstep(1.4, 0.02, y - siteGrade(x, z, noise)) * 0.26;
          gw += M.smoothstep(0.56, 0.92,
            noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 1.7, y * 0.14, 3) * 0.5 + 0.5) *
            M.saturate(1 - Math.abs(ny)) * 0.24;
          var ew = M.smoothstep(0.64, 0.95, noise.fbm3(x * 1.0, y * 0.9, z * 1.0, 2) * 0.5 + 0.5) * 0.26;
          ew += M.saturate(ny) * 0.12;
          r = 1 - M.saturate(gw) * 0.62; g = 1; b = 1 - M.saturate(ew);
        } else if (mode === 'block') {
          var gb = M.saturate(0.16 + 0.28 * (noise.fbm3(x * 0.7, y * 0.7, z * 0.7, 3) * 0.5 + 0.5));
          r = 1 - gb * 0.55; g = 1; b = 1 - M.saturate(ny) * 0.22;
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else if (mode === 'grit') {
          // Bund floors and the gravel margin. Darker than the apron and much
          // more chromatic - it is oil-soaked sand, not clean aggregate.
          var v0 = 0.78 + (noise.fbm2(x * 0.22 + 4, z * 0.22 - 7, 3) * 0.5 + 0.5) * 0.40;
          var oil = M.smoothstep(0.55, 0.92, noise.fbm2(x * 0.42 - 2, z * 0.42 + 5, 3) * 0.5 + 0.5);
          v0 *= 1 - oil * 0.42;
          r = v0 * 1.04; g = v0 * 0.98; b = v0 * 0.88;
        } else if (mode === 'sand') {
          // The desert. It has to hold the bottom of the overview frame without
          // ever competing with the plant, so it is low value and warm.
          var rr0 = Math.sqrt(x * x + z * z);
          var v1 = 0.72 + (noise.fbm2(x * 0.010 + 3, z * 0.010 - 6, 4) * 0.5 + 0.5) * 0.44;
          v1 += (noise.fbm2(x * 0.055 - 1, z * 0.055 + 2, 2) * 0.5 + 0.5) * 0.16;
          v1 *= 1 - M.smoothstep(140, 420, rr0) * 0.22;
          r = v1 * 1.10; g = v1 * 0.99; b = v1 * 0.80;
        } else if (mode === 'kerb') {
          var v2 = 0.94 + (noise.fbm3(x * 0.6, y * 0.6, z * 0.6, 2) * 0.5 + 0.5) * 0.22;
          v2 *= 1 - M.smoothstep(0.35, 0.02, y - siteGrade(x, z, noise)) * 0.28;
          r = v2; g = v2 * 0.99; b = v2 * 0.95;
        } else if (mode === 'tankshell' || mode === 'seam') {
          // ---- THE TANK SHELLS ---------------------------------------------------
          // 29 m of pale grey enamel is the largest single-material area in the
          // level and the easiest thing in it to render as a flat card. Three
          // things stop that: a per-COURSE value lottery (each plate ring was
          // painted in a different year), vertical run-off streaking, and a
          // strong brightening on the faces turned toward the twilight band -
          // which is what makes the tanks read as ROUND at 60 m.
          var course = Math.floor((y - siteGrade(x, z, noise)) / 2.0);
          var cn = (Math.sin(course * 12.9898 + 4.7) * 43758.5453) % 1;
          if (cn < 0) cn += 1;
          var v3 = 0.88 + cn * 0.17;
          v3 *= 1 - M.smoothstep(0.58, 0.94,
            noise.fbm2((x + z) * 1.4, y * 0.055, 3) * 0.5 + 0.5) * 0.14;   // run-off
          v3 *= 1 - M.smoothstep(2.6, 0.15, y - siteGrade(x, z, noise)) * 0.16;
          var glowFace = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          v3 *= 1 + glowFace * 0.34;
          if (mode === 'seam') v3 *= 0.82;
          r = v3 * 1.02; g = v3 * 1.00; b = v3 * (1.02 - glowFace * 0.14);
        } else if (mode === 'lagging') {
          // Aluminium jacketing. Bright, banded, and dented - the bands are
          // baked as value here because the geometry is only 22-sided.
          var band = 0.90 + Math.abs(Math.sin(y * 4.2 + x * 0.3)) * 0.14;
          var v4 = band * (0.90 + (noise.fbm3(x * 0.5, y * 0.35, z * 0.5, 3) * 0.5 + 0.5) * 0.28);
          v4 *= 1 - M.smoothstep(0.70, 0.96,
            noise.fbm3(x * 1.3, y * 0.9, z * 1.3, 2) * 0.5 + 0.5) * 0.30;   // dents and dirt
          var gf2 = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          v4 *= 1 + gf2 * 0.20;
          r = v4 * 1.00; g = v4 * 1.00; b = v4 * 1.02;
        } else if (mode === 'refractory') {
          var v5 = 0.86 + (noise.fbm3(x * 0.45, y * 0.45, z * 0.45, 3) * 0.5 + 0.5) * 0.30;
          v5 *= 1 - M.smoothstep(0.60, 0.94, noise.fbm3(x * 1.1, y * 0.5, z * 1.1, 2) * 0.5 + 0.5) * 0.26;
          r = v5 * 1.06; g = v5 * 0.96; b = v5 * 0.86;
        } else if (mode === 'rail') {
          // Contractor's yellow. Chipped to bare steel on every top surface and
          // every hand-height rail, because that is where hands and boots go.
          var chip = M.smoothstep(0.58, 0.92, noise.fbm3(x * 1.6, y * 1.4, z * 1.6, 3) * 0.5 + 0.5);
          chip += M.saturate(ny) * 0.24;
          var v6 = 0.92 + (noise.fbm3(x * 0.7, y * 0.7, z * 0.7, 2) * 0.5 + 0.5) * 0.24;
          v6 *= 1 - M.saturate(chip) * 0.34;
          r = v6 * 1.02; g = v6 * (1.0 - M.saturate(chip) * 0.08); b = v6 * (0.94 + M.saturate(chip) * 0.30);
        } else if (mode === 'grate') {
          var v7 = 0.78 + (noise.fbm3(x * 0.8, y * 0.6, z * 0.8, 2) * 0.5 + 0.5) * 0.30;
          r = v7 * 1.00; g = v7 * 0.99; b = v7 * 1.00;
        } else if (mode === 'clad' || mode === 'shutter') {
          var v8 = 0.86 + (noise.fbm3(x * 0.36, y * 0.30, z * 0.36, 3) * 0.5 + 0.5) * 0.32;
          // streaking below every fixing line, and a rust bloom at the base
          v8 *= 1 - M.smoothstep(0.62, 0.95, noise.fbm2((x + z) * 0.9, y * 0.30, 3) * 0.5 + 0.5) * 0.24;
          var rustF = M.smoothstep(1.2, 0.05, y - siteGrade(x, z, noise)) * 0.55;
          rustF = Math.max(rustF, M.smoothstep(0.66, 0.95,
            noise.fbm3(x * 0.9, y * 0.7, z * 0.9, 3) * 0.5 + 0.5) * 0.45);
          if (mode === 'shutter') v8 *= 0.90;
          r = v8 * (1 + rustF * 0.46); g = v8 * (1 - rustF * 0.06); b = v8 * (1 - rustF * 0.42);
        } else if (mode === 'mesh') {
          var v9 = 0.80 + (noise.fbm2(x * 0.5, y * 0.5, 2) * 0.5 + 0.5) * 0.26;
          r = v9 * 1.02; g = v9; b = v9 * 0.96;
        } else if (mode === 'glass') {
          // A lit control room seen from outside at dusk: the glass is the
          // brightest thing on the building and it is warm-cool split by pane.
          var pane = Math.floor(z / 2.2);
          var pn = (Math.sin(pane * 12.9898) * 43758.5453) % 1;
          if (pn < 0) pn += 1;
          var band2 = 0.80 + pn * 0.55;
          r = band2 * 1.02; g = band2 * 1.05; b = band2 * 1.10;
        } else if (mode === 'far') {
          // ---- AERIAL PERSPECTIVE, IN THE ALBEDO ----------------------------------
          // The fog does the atmosphere. What it cannot do is make a 300 m block
          // DIFFERENT from a 140 m one before it runs, and without that the
          // backdrop is one material seen through varying amounts of grey.
          var rr2 = Math.sqrt(x * x + z * z);
          var far = M.saturate((rr2 - 120) / 220);
          var v10 = 0.70 + (noise.fbm2(x * 0.010 + 5, z * 0.010 - 3, 2) * 0.5 + 0.5) * 0.44;
          var lamF = M.saturate(nx * GLOW_X + nz * GLOW_Z) * (1 - far * 0.5);
          v10 *= 1 + lamF * 0.55;
          v10 *= 1 - far * 0.22;
          r = v10 * (1.08 + lamF * 0.24); g = v10 * 0.99; b = v10 * (0.90 - lamF * 0.10 + far * 0.16);
          var lum = (r + g + b) / 3;
          var mix = far * 0.55;
          r = M.lerp(r, lum, mix); g = M.lerp(g, lum, mix); b = M.lerp(b, lum, mix);
          var up = M.saturate(ny);
          r += up * 0.08; g += up * 0.08; b += up * 0.10;
        } else {
          // 'steel' / 'paint' / 'pipe' / 'pump' / 'cable' / 'rusty' / 'timber':
          // structural and process metalwork. Value variation, rust blooming out
          // of every joint and flange, road film up the first metre.
          var f4 = 0.84 + (noise.fbm3(x * 0.30, y * 0.28, z * 0.30, 3) * 0.5 + 0.5) * 0.34;
          var rs = M.smoothstep(0.56, 0.94, noise.fbm3(x * 0.85 + 3, y * 0.7, z * 0.85 - 4, 3) * 0.5 + 0.5);
          if (mode === 'paint' || mode === 'pump') rs *= 0.32;
          if (mode === 'rusty') rs = M.saturate(rs * 1.4 + 0.34);
          if (mode === 'cable') { f4 *= 0.62; rs *= 0.25; }
          f4 *= 1 - M.smoothstep(1.1, 0.02, y - siteGrade(x, z, noise)) * 0.22;
          // the twilight band is the only sky light left; steel facing it keeps
          // a little more value, which is what separates the lattice from the
          // sky instead of letting it all silhouette to one black
          var gf3 = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          f4 *= 1 + gf3 * 0.14;
          r = f4 * (1 + rs * 0.44);
          g = f4 * (1 - rs * 0.06);
          b = f4 * (1 - rs * 0.42);
          if (mode === 'timber') { r *= 1.06; g *= 0.96; b *= 0.82; }
        }

        if (isWear) {
          col[j] = M.saturate(r); col[j + 1] = M.saturate(g); col[j + 2] = M.saturate(b);
        } else {
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
        }
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ---- walkable surfaces ------------------------------------------------------
  LevelRefinery.prototype.sampleGround = function (x, z) {
    if (x < SITE_X0 || x > SITE_X1 || z < SITE_Z0 || z > SITE_Z1) {
      return farY(x, z, this.noise);
    }
    return groundY(x, z, this.noise);
  };

  LevelRefinery.prototype._buildNav = function () {
    var cell = 1.10;
    var ox = SITE_X0, oz = SITE_Z0;
    var w = Math.ceil((SITE_X1 - ox) / cell);
    var h = Math.ceil((SITE_Z1 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      if (ce.y - he.y > 8.0) continue;              // nothing overhead blocks the floor
      obst.push([ce.x - he.x - 0.28, ce.x + he.x + 0.28,
                 ce.z - he.z - 0.28, ce.z + he.z + 0.28,
                 ce.y - he.y, ce.y + he.y]);
    }
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var y = groundY(x, z, this.noise);
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          if (o[5] > y + 0.40 && o[4] < y + 1.80) { ok = 0; break; }
        }
        // a bund wall is 1.9 m of concrete: the floor inside it is reachable
        // only over the stepover stair, and the nav grid has to agree or the AI
        // will walk into the wall for the whole match
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

  LevelRefinery.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + 0.02, z), yaw: yaw
      });
    }
    // [0] is the player: on the road at the south end, under the last mast,
    // looking straight up the spine at the flare. Every level should open on
    // its own best idea, and this level's idea is at the far end of that road.
    sp(1.2, 34.0, 0.02);
    sp(-3.0, 12.0, 0.20);      sp(4.5, -6.0, -0.10);
    sp(-2.0, -30.0, 0.05);     sp(3.5, -56.0, 0.30);
    sp(-11.0, -20.0, 1.30);    sp(-11.0, 8.0, -1.20);
    sp(19.0, -30.0, -1.40);    sp(19.5, -6.0, 1.50);
    sp(22.0, -60.0, -0.60);    sp(36.0, -18.0, 1.80);
    sp(-26.0, -46.0, 1.55);    sp(-26.0, -8.0, 1.55);
    sp(-27.0, 37.0, 1.40);     sp(-20.0, 37.5, -1.55);
    sp(38.0, -74.0, 2.30);     sp(30.0, 28.0, 2.60);
    sp(-40.0, -70.0, 0.40);    sp(-6.0, 60.0, -0.05);
    sp(48.0, -46.0, 2.10);

    // ---------------------------------------------------------------- framings --
    // Every pose is SOLVED against a published anchor, not typed in: a position
    // plus a look-at target that is an actual object in the level, so a
    // composition survives the geometry moving. Strong foreground, a leading
    // line, a subject, and light doing something visible.
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
    var gy0;

    // ---- HERO1 : the process alley -------------------------------------------
    // The signature image, and everything about the site plan exists to make it
    // work. Standing on the road at z = 26, eye 1.72, looking 13 degrees east of
    // north and 8 degrees up:
    //
    //   * the road runs dead away to the vanishing point with its kerb line,
    //     drainage grating and centre markings - the leading line
    //   * the WEST PIPE RACK fills the left third: 22 bents at 7.4 m, three
    //     tiers of line, the walkway rail on top, all in silhouette against the
    //     twilight band which sits exactly behind it at azimuth -0.95 rad
    //   * the EAST PIPE RACK and the column row fill the right: C1 at 41 m and
    //     67 m out, its shell raked by two cold uplights from the plinth, its
    //     platform rings stacked up the frame
    //   * three PIPE BRIDGES cross overhead at 8.6, 11.4 and 9.2 m and at 32,
    //     52 and 84 m of depth - the rungs that turn a straight road into a
    //     receding tunnel
    //   * the FLARE burns 100 m away, 8 degrees right of the axis and 14 above
    //     it: the subject, the key, and the only moving thing in frame
    //   * two sodium masts stand in the middle distance putting real amber
    //     pools on the tarmac, against the mercury blue on the columns
    //
    // The pitch is +8 degrees, not more. Any steeper and the near 12 m of road
    // - which carries the whole bottom of the frame and is the only thing under
    // a lamp - falls out of shot, and vertical_imbalance goes with it.
    gy0 = this.sampleGround(-1.2, 26.0);
    var hero1 = pose(-1.2, gy0 + 1.72, 26.0, 16.0, 12.0, -46.0);

    // ---- HERO2 : the rack walkway --------------------------------------------
    // Eleven metres up on the west rack's grating, looking north along it.
    // Different space, different depth, different subject: the foreground is a
    // handrail and three tiers of pipe converging to a point, the middle
    // distance is the plant seen from ABOVE (which no other framing gives), and
    // the flare sits 29 degrees right with the column row between.
    //
    // The eye is 1.62 rather than 1.72: a standing eye on a 1.10 m rail wants
    // the rail crossing the lower third, not the middle.
    gy0 = this.sampleGround(WR_X + WR_HALF - 0.62, 4.0);
    var hero2 = pose(WR_X + WR_HALF - 0.62, gy0 + WR_DECK + 1.62, 4.0,
      WR_X + WR_HALF - 2.6, gy0 + WR_DECK - 2.4, -62.0);

    // ---- HERO3 : the tank farm ------------------------------------------------
    // The level's other place. Standing on the apron between the west rack and
    // the bunds, looking west-north-west - which is straight into the twilight
    // band, so the tanks are pure silhouette against the brightest sky in the
    // level, while the flare (behind the right shoulder, 120 m away) rims their
    // eastern shoulders orange. Warm rim on cool silhouette is the entire
    // 'sodium' grade in one frame.
    //
    //   * T2's shell, 30 m out and 38 degrees left, is a huge dark curve down
    //     the left edge - the foreground mass
    //   * T1 is the subject, 57 m out and 5 degrees off the axis, with its
    //     spiral stair reading against the sky and a mercury flood raking the
    //     plate courses
    //   * the bund wall runs across the bottom third as the leading line
    //   * the cooling towers close the gap on the right at 120 m
    // RE-SOLVED once the floods moved. The first mark stood 8 m off the bund
    // coping with a fixture on it, so the frame was one blown white disc on a
    // shell and a black bottom third. From 6.5 m further back the bund wall
    // becomes a diagonal leading line instead of a fence across the lens, one
    // of the new tank masts stands in frame as a lit vertical on the left, and
    // the apron under it is inside the flood's spill.
    gy0 = this.sampleGround(-23.5, 8.0);
    var hero3 = pose(-23.5, gy0 + 1.76, 8.0, -49.0, 7.5, -40.0);

    // ---- INTERIOR : the pump house --------------------------------------------
    // Three metres inside the roll shutter, looking west down a 22 m hall. A
    // dark tube with three cold fluorescent battens down it, the pump row as
    // the subject, the MCC line on the right, the monorail beam overhead - and
    // the open personnel door at the far end as the one bright accent.
    var ph = A.pumpHouse;
    var interior = pose(PH_X1 - 1.9, ph.floorY + 1.68, PH_DOOR_Z + 0.5,
      PH_X0 - 0.6, ph.floorY + 1.34, ph.centre.z - 1.1);

    // ---- OVERVIEW : the whole plant -------------------------------------------
    // Thirty metres up off the south fence, looking north-west ALONG THE ROAD.
    //
    // RE-SOLVED. The first mark stood off the south-EAST corner, and the line
    // from there to the middle of the site runs straight through the control
    // building - so a 22 x 18 m unlit box sat dead centre at 25 m, occupying the
    // near third of the establishing frame and blurring under the depth of
    // field. From 13 degrees west of north the same building falls 30 degrees
    // right at 65 m, the main road recedes almost down the frame's own axis, and
    // the tank farm / rack / column row / flare stack lay themselves out left to
    // right in depth order.
    //
    // 30 m of height and -10 degrees of pitch puts the horizon about two thirds
    // up the frame, so the plant occupies the middle band, the desert holds the
    // bottom and the sky is the top third - which is what stops an establishing
    // shot of a dark site from metering on its own sky.
    var overview = pose(26.0, 30.0, 92.0, -4.0, 7.0, -34.0);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior
    };
  };

  // ---- broadphase + raycast ------------------------------------------------------
  LevelRefinery.prototype._buildBroadphase = function () {
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

  LevelRefinery.prototype.raycast = function (origin, dir, maxDist) {
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
    while (t <= maxDist && guard++ < 900) {
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

  // ---- per frame -------------------------------------------------------------------
  // The plant is static. The fire is not, and it must not be: "flare stacks
  // throwing REAL MOVING firelight" is the brief's own emphasis. Six plumes at
  // 90-170 vertices each is about 800 points of noise a frame, which is the
  // cost of the only motion in the level. lighting.js animates the flare's
  // POINT LIGHT itself (kind 'fire'), so the light and the geometry flicker
  // from two different fields - which is correct: a flame front and its
  // radiance do not move in lockstep.
  LevelRefinery.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);
    // The evening breeze is the level's own unless weather.js is publishing one.
    try {
      if (ctx && ctx.weather && ctx.weather.windDir &&
          isFinite(ctx.weather.windDir.x) && ctx.weather.windSpeed > 0.05) {
        this.windDir.set(ctx.weather.windDir.x, ctx.weather.windDir.y);
        this.windSpeed = ctx.weather.windSpeed;
      }
    } catch (e) { /* the level's own breeze is fine */ }
    try { this._updatePlumes(this._t, ctx && ctx.camera); }
    catch (e2) { GAME.logError('refinery.plumes', e2); }
  };


  GAME.LevelRefinery = LevelRefinery;
})(window.GAME, window.THREE);
