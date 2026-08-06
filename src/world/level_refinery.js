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
//   x  11..54, z  43..75              THE GATE APPROACH: weighbridge, kiosk,
//                                     boom barriers, a marked truck park, a drum
//                                     store canopy and a 15.4 m four-head
//                                     floodlight tower. This is the foreground
//                                     third of the establishing frame and it
//                                     measured 0.043 median before it existed.
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
// So the level publishes 30 practicals (26 active - lighting.js split the old
// flat cap into a BUILD count and a per-frame ACTIVE count this round) and they
// are organised on ONE RULE, stated in full at the head of _buildLamps:
//
//   COLOUR TEMPERATURE IS DECIDED BY WHERE THE LIGHT LANDS IN THE FRAME.
//   Anything reaching the plant above about 15 m is FIRE, 1900-2400 K.
//   Anything reaching the ground plane, the plinths, the column skirts and the
//   bottom third of a tall object is FLOOD, 6400-7600 K.
//
// The two meet on the same object at a height, which is the brief stated as a
// silhouette rather than as a wash. Three families implement it:
//
//   FIRE FROM ABOVE.  The flare at 61 m carrying 8600 cd at 1950 K with kind
//     'fire', so lighting.js gives it noise-driven flicker and a colour that
//     tracks its own intensity; plus the two fixtures that reach where it
//     cannot - a 2150 K flood off the east rack at C1's mid shell, and a
//     2200 K bulkhead on C1's own platform 30 m up.  Between them they own
//     everything above 15 m: the columns, the derrick, the bridges and the
//     rack tops.  This family is the level and it is why nothing here is black.
//
//   SODIUM FROM THE MASTS.  Four 13.2 m high masts down the road at 1950 K,
//     plus wall packs on the control building's south elevation and the pump
//     house's gable.  ~4.5 lux in the pool under each, staggered left/right so
//     the road reads as alternating amber pools rather than a wash.
//
//   COLD FLOODS FROM BELOW.  Mercury-vapour units at 6400-7600 K on the unit
//     plinths, the rack legs, the tank-farm apron and the gate tower.  They own
//     the SLAB and the bottom third of every tall object, and they stop there:
//     the column uplights are held to a 34 m reach so they cover the skirt and
//     the first 16 m of shell and no more, which is both what a ground flood
//     can physically do and what leaves the fire something to own.  Their
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
//   anchors.entrance    { x0,x1,z0,z1, weighbridge:{x0..z1,deckY,centre},
//                         kiosk:{centre,w,d,h}, boomZ, bays:{x0,x1,z0,z1,n,pitch},
//                         canopy:{centre,w,d} }
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
  // MEASURED MOVE, TWICE. First sited at x = 40, which put it on the same
  // bearing from the hero1 standpoint as the 41 m column C1. Then moved to
  // x = 20 to clear the column - which put the STACK behind all three pipe
  // bridges instead, and shipped a frame in which the level's landmark was a
  // flame floating on a 25 px stub. Raising the flame from 46 m to 58 m had
  // cleared the FLAME; it did nothing whatever for the DERRICK under it.
  //
  // The occlusion is arithmetic, not taste. From the hero1 mark at
  // (-1.2, 26) a bridge spanning x = -10.7..11.7 is crossed at
  //     x(z) = -1.2 + (FL_X + 1.2) * (26 - z) / (26 - FL_Z)
  // and every bridge whose crossing lands inside that span cuts a band out of
  // the stack. At FL_X = 20 the crossings are x = 2.6 / 8.6 / 14.7, so TWO of
  // the three bridges bite, removing 21-27 m and 35-51 m of a 44 m derrick.
  // At FL_X = 34, FL_Z = -78 they are x = 5.6 / 16.4 / 27.2: only the nearest
  // bridge is still in the way and it takes one band off the top, leaving
  // 12 m -> 34 m of CONTINUOUS lattice under the flame. The flare also moves
  // from 2.7 degrees left of the hero1 axis to 5.3 right, which drops it onto
  // the third line instead of the centre.
  var FL_X = 34.0, FL_Z = -78.0;
  // MEASURED HEIGHT. At 46 m the flame subtended 6.5 degrees from the hero1
  // standpoint and the near pipe bridge cut across its lower third. At 58 m
  // the flame sits entirely clear of every bridge and reads as the tallest
  // thing for a kilometre, which is what a flare stack is.
  var FL_TIP = 58.0;                    // top of the flare tip
  var FL_TIP_R = 0.95;
  var FL_DERRICK = 52.0;                // top of the lattice derrick
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
    { x0: 23.0, x1: 45.0, z0: -88.0, z1: -68.0, h: 0.30 },   // flare
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
    // albedoTarget on the two biggest surfaces in the level is not decoration.
    // MEASURED: with the flare running as a 240 m point source at 1950 K it
    // was the dominant illuminant on every square metre of apron, and 156 m of
    // warm-grey concrete came back BRICK RED - 87.6% of the frame's saturated
    // pixels inside a 60-degree red-orange wedge. The flare is now a local key
    // (see _buildLamps) and the ground is authored neutral-cool so that what
    // does reach it reads as sodium ON concrete rather than as concrete made
    // of sodium.
    pave:      { uv: 0.34, cast: false, recv: true, wear: true,
                 base: 'concrete', albedoTarget: 0x787876, rough: 0.88, ns: 0.72 },
    road:      { uv: 0.30, cast: false, recv: true, wear: true,
                 base: 'asphalt', albedoTarget: 0x3c3c3c, rough: 0.86, ns: 0.75 },
    grit:      { uv: 0.22, cast: false, recv: true, wear: false,
                 base: 'gravel', rough: 0.94, ns: 0.72 },
    // Saw-cut control joints and slab construction joints. Its own surface
    // because it is the ONE thing on the apron that has to be a hard, straight,
    // dark line: the 2.6 m gridSurface cannot resolve a 50 mm feature from its
    // vertices and the wear mask is written per vertex, so a joint has to be
    // its own geometry with its own albedo. One draw call for 26,500 square
    // metres of man-made grain is the cheapest legibility on the level.
    joint:     { uv: 0.55, cast: false, recv: true, wear: false,
                 base: 'concrete', albedoTarget: 0x272724, rough: 0.95,
                 metal: 0.0, ns: 0.45 },
    sandy:     { uv: 0.055, cast: false, recv: true, wear: false,
                 base: 'sand', rough: 0.95, env: 0.55 },
    // ---- concrete structure -------------------------------------------------
    // meso/grain for the reason given at length on `tank`, and the bund wall is
    // where it shows: cropped at 2.2x it is the second-largest surface in hero3
    // and it prints as PEBBLEDASH - a dense sub-pixel stipple with the formwork,
    // the tie plugs and the pour joints (all real geometry) sitting inside it
    // rather than on it. materials.js measured mesoScale 0.35 on this exact wall
    // in this exact frame and reported it BETTER at 2-4 m and WORSE at 8-14 m,
    // so the scale is a wash here and the AMPLITUDE is the lever, same as on the
    // shells. The wall keeps its full detail tile, which is what carries it at
    // the two metres the player walks past it at.
    wall:      { uv: 0.36, cast: true, recv: true, wear: true,
                 base: 'concrete_wall', ns: 0.42,
                 meso: 0.40, grain: 0.60 },
    kerb:      { uv: 0.72, cast: true, recv: true, wear: false,
                 base: 'concrete', rough: 0.90, ns: 0.62 },
    // ---- steel --------------------------------------------------------------
    struct:    { uv: 0.55, cast: true, recv: true, wear: false,
                 base: 'structural_steel', rough: 0.58, metal: 0.66, env: 1.35, ns: 0.62 },
    // Process pipe. Three paint families, because a rack in which every line is
    // the same colour is a rack you cannot read - real plants colour-code by
    // service and it is the cheapest legibility a pipe rack has.
    // rough 0.50 / env 1.20, not 0.44 / 1.40. Measured on hero2, where the top
    // tier runs 1-4 m off the lens along the view axis: a rough-0.44 metal seen
    // at grazing incidence returns one continuous specular streak down its
    // whole length, and with the environment gain on top of it the near lines
    // clipped and carried most of that frame's blown-white failure. The
    // specular is what says "steel"; a streak with no roll-off in it says
    // "white plastic tube".
    // ns 0.58, added. hero2's whole foreground is process line running 1-4 m
    // off the lens ALONG the view axis, and a full-strength normal on a 0.85
    // tiles/m map seen at grazing incidence is the same specular-aliasing
    // failure the tank shell had, one metre from the camera instead of thirty.
    pipe:      { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x8d9298,
                 rough: 0.50, metal: 0.70, env: 1.20, ns: 0.58 },
    // MEASURED: at 0x4e6350 / 0x8c5323 the three service colours sat inside
    // 0.09 of each other in value and 25 degrees of hue, and under a 1950 K
    // sodium wash they printed as one orange. Separation has to be bought in
    // the ALBEDO or it does not survive the grade, so the green went hard
    // green and the orange hard orange.
    pipe_g:    { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x2f6b3e,
                 rough: 0.54, metal: 0.50, env: 1.3, ns: 0.58 },
    pipe_o:    { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0xb0521a,
                 rough: 0.60, metal: 0.44, env: 1.25, ns: 0.58 },
    // Aluminium weather jacketing over mineral-wool lagging. The single
    // largest area of "steel" in the frame: the columns are clad in it, and it
    // is much paler and much less metallic than bare pipe - which is what
    // stops the column row from going black against the sky.
    // uv 1.05, not 0.62. At 0.62 tiles/m one texture period covered 1.6 m of
    // a 41 m column and the shells printed BLANK at 1:1 - a pale grey gradient
    // with nothing in it. 1.05 puts the panel scale at 0.95 m, which is what a
    // real jacket sheet is, and the horizontal band rings and vertical lap
    // seams buildColumns now models sit on top of it as geometry.
    // ALBEDO 0x9ba0a4, NOT 0xb0b5b8, AND env 1.25 RATHER THAN 1.5. Measured on
    // hero2, where the top tier of lagged line runs 1-4 m off the lens: at 0.69
    // reflectance with a 1.5 environment gain and the `lagging` value pass on
    // top of it, the near jackets clipped to flat cream and carried 1.6% of the
    // frame over the exposure gate on their own - a "flat, untextured,
    // single-colour surface" at 1:1, which is the first line of the instant-
    // fail list, on the nearest object in a published framing. Real weathered
    // aluminium sheet is 0.45-0.55 reflectance, not 0.69; the brightness that
    // made it read as metal was always the specular, and that is what the
    // roughness and the normal are for.
    // 0x8b9095, NOT 0x9ba0a4, and this is the third time this number has come
    // down for the same measured reason. hero2 puts C1's shell 45 m from the lens
    // filling a fifth of the frame and it came back at ~0.8 luminance with the
    // course banding, the lap seams and the band rings all invisible inside it -
    // a pale smooth tube, which is "flat, untextured, single-colour surface" on
    // the largest object in the frame. The note above this entry already argues
    // that real weathered aluminium sheet is 0.45-0.55 reflectance; 0x9ba0a4 is
    // 0.61 and 0x8b9095 is 0.545, i.e. the top of that range rather than past it.
    // Everything that makes a jacket read is a VALUE BREAK, and a value break
    // needs headroom under it, not over it.
    // uv 1.95 for the same measured reason as `tank`: the reboiler shell 20 m
    // from the hero1 mark printed the identical ochre freckle at the identical
    // ~1 m macro period, and a lagged drum is exactly the kind of large smooth
    // cylinder that reading fails on. The panel scale this entry's note is
    // arguing for is carried by the lap seams and the band rings, which are
    // real geometry standing 30-55 mm proud, not by the albedo.
    // meso/grain for the same measured reason as `tank` below, but only half as
    // hard: hero2 stands the eye 1-4 m from this surface, where a 4 cm detail
    // tile is 40-160 px and is doing real work, while hero1 and hero3 read the
    // same jackets at 45-110 m where it is a fifth of a pixel. One number has to
    // serve both, so the base map loses an octave and the meso band - which is
    // 4 mm to 1.7 cm content and therefore sub-pixel at EVERY published
    // stand-off past about six metres - loses most of its amplitude.
    lag:       { uv: 1.95, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x8b9095,
                 rough: 0.58, metal: 0.42, env: 1.15, ns: 0.46,
                 meso: 0.20, grain: 0.70 },
    // ---- TANK SHELL -----------------------------------------------------------
    // THE CAMOUFLAGE WAS THE BASE MAP, and it took three passes to find because
    // the previous two both looked at the wrong layer.
    //
    // History: painted_metal at uv 0.30 (macro blotching landed at 2-3 m and
    // read as camouflage), painted_metal at 0.62 (read as sandpaper static),
    // then ship_hull at 0.34 - "the library's large-plate entry, written for
    // exactly this problem". It is not. Read genShipHull: it is a SHIP, and it
    // paints a boot topping, a waterline, an ANTIFOULING band, a scum line,
    // weed and barnacle colonies at fixed v. Project that onto a 29 m cylinder
    // and you get exactly what the review measured: "large soft airbrushed
    // blotches in blue-grey, ochre and red with no relationship to the plate
    // courses". The base changed but the reading did not, because the review
    // was describing the ship's paint scheme.
    //
    // painted_metal at 0.90 puts its macro period at 1.1 m, which is panel
    // scale and reads as weathering; the "sandpaper" that killed 0.62 was
    // specular aliasing off the normal, and that is now bought out directly
    // with normalScale 0.55 and a rougher surface rather than by moving the
    // albedo around. Everything at tank scale - the course streaking, the tide
    // band at grade, the run-off from the roof rim - is authored deliberately
    // in _paint and in the weep decals, where it can be DIRECTIONAL.
    //
    // ---- uv 1.75, AND THIS IS THE FOURTH PASS ON THE SAME SYMPTOM ----------
    // Cropping T2's shell at the 30 m hero3 puts it at, at 2.4x, finally shows
    // what the pattern IS rather than what it reads as: discrete ochre-brown
    // OVALS about 0.5 m across, evenly scattered, at the map's own macro period.
    // It is not specular aliasing (normalScale is already down at 0.34) and it
    // is not camouflage - it is MEASLES, and the reason is that 1.1 m is the
    // worst possible period for this surface. It is far too small to read as a
    // repainted plate and far too large to read as grain, so at every distance
    // from 15 m out it lands as a freckle.
    //
    // The macro is not the map's job on this level and never was: the courses,
    // the tide band, the seam streaks and the nozzle run-off are all authored per
    // vertex in _paint where they can be sourced and directional, and the plate
    // grid is real geometry. So the map goes FINER, to a 0.57 m period, where at
    // 30 m it mips down to grain and at two metres it reads as paint failure -
    // which is what a map is for.
    // MEASURED, ROUND 3, AND IT IS THE WORST SINGLE READING IN THE LEVEL.
    // hero3 stands 30 m off T2 and the shell fills the left quarter of the
    // frame; on an 8x8 grid those sixteen cells came back with MEDIANS of
    // 0.61-0.85 luminance against a 0.195 frame median. A quarter of the
    // signature tank framing was a near-white wall, and because normalScale
    // 0.55 on a 0.90 tiles/m map puts the normal's period at ~1.1 m the only
    // thing modulating it was per-pixel specular aliasing - which prints as
    // COTTAGE CHEESE, i.e. high-frequency noise at zero structure.
    //
    // Two numbers, both physical. 0x9d9c96 is 0.615 sRGB, i.e. 33% reflectance
    // linear: that is FRESH white paint on a new tank. Aged tank enamel with
    // nine years of blown grit on it measures 0.18-0.24 linear, which is
    // 0x83827c. And the normal comes down to 0.34, because at this tiling the
    // map's job is grain, not form - the form is the plate courses, the weld
    // grid and the wind girder, all of which are real geometry.
    // uv 2.90, THIRD READING. At 0.90 the map's macro blotch landed at 1.1 m and
    // read as MEASLES; at 1.75 it landed at 0.57 m, which is 1.5 px at the 30 m
    // hero3 puts T2 at - i.e. right on the sampling threshold - and printed as a
    // dense high-contrast STIPPLE with visible shimmer. 2.90 puts the period at
    // 0.34 m, which mips to a smooth grain at any range past about 12 m and still
    // reads as chipped paint when the player walks up to the shell. The value
    // structure that has to survive at 30 m is all authored per vertex and per
    // course in _paint, where the vertex grid can carry it.
    // ---- FIFTH PASS, AND THIS TIME THE UV IS NOT TOUCHED --------------------
    // Six changes to `uv` (0.30 / 0.62 / 0.34 / 0.90 / 1.75 / 2.90) and two to
    // `albedoTarget` all failed the same way, and the reason is that NONE OF THE
    // OFFENDING SIGNAL IS IN THE BASE MAP. Cropping hero3's T2 at 2.2x shows a
    // dense, uniform, multi-hue speckle at a ONE-TO-TWO PIXEL period - cream,
    // pale blue-grey and tan - which is not what a 512 tile mipped down 32:1 can
    // print. It is what an UNMIPPABLE signal prints.
    //
    // materials.js's own numbers name it. painted_metal carries `detail: 0.5`
    // at `detailCm: 4` and `meso: 0.45` at the default mesoScale 1.82 - and that
    // scale is a 0.55 m tile whose octaves deliver 4 mm to 1.7 cm features. Both
    // layers are evaluated procedurally in the fragment shader, so neither has a
    // mip chain: at the 10-30 m this surface is read at, 4 mm to 4 cm is 0.05 to
    // 0.2 of a pixel and the result is pure aliasing, at every distance, forever.
    // That is the cottage cheese, and no uv scale can reach it because the uv
    // scale does not apply to it.
    //
    // The other half of the same finding: materials.js MEASURED mesoScale 0.35
    // on this exact surface in this exact frame and reported it WORSE (Laplacian
    // 0.0981 -> 0.1612, isolated specks 10.91% -> 28.77%), because 0.35 is the
    // right answer for a surface read at a metre and this one is read at twenty.
    // So the lever is the AMPLITUDE, not the scale: meso and detail come down to
    // where they stop being sub-pixel noise, and `grain` decimates the base map
    // set by one octave on top of that. What carries the surface instead is what
    // was always supposed to - the plate courses, the vertical butt welds, the
    // wind girder, the nozzle bosses and the sourced weep streaks, all of which
    // are real geometry or per-vertex value and all of which survive mipping.
    tank:      { uv: 2.90, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0x83827c,
                 rough: 0.72, metal: 0.38, env: 1.20, ns: 0.34,
                 meso: 0.10, detail: 0.16, grain: 0.55 },
    // The flare derrick, and only the flare derrick. MEASURED: painted in the
    // structural steel palette it was invisible from the hero1 standpoint -
    // 114 m of dry air, thin members and a dark albedo against the dark half of
    // a dusk sky put the flame in frame with no stack under it, so the level's
    // landmark read as a fire floating over a pipe rack. Real flare derricks
    // carry aviation obstruction marking for exactly this reason: alternating
    // bands of white and international orange, which is what the per-panel tint
    // in buildFlare paints onto this surface.
    // Painted near-WHITE first (invisible against bright horizon haze), then
    // dark galvanised at 0x6b6862 - which MEASURED 0.05 albedo contrast
    // against that same haze at 110 m and was equally invisible. Contrast that
    // depends on the background is a bet; contrast INTERNAL to the object is
    // not. The base is now a mid galvanised grey and the aviation panels
    // multiply down to about 0xa8481c, which is 2.1:1 in value and 40 degrees
    // of hue against their own neighbour, so the stack reads as a banded mast
    // whatever is behind it.
    derrick:   { uv: 0.42, cast: true, recv: true, wear: false,
                 base: 'painted_metal', albedoTarget: 0xa8a49a,
                 rough: 0.62, metal: 0.34, env: 1.30, ns: 0.60 },
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
    // ---- CLADDING AND ROOF DECK: THE COLD HALF OF THE INTERIOR ---------------
    // MEASURED on lv_interior, which is the level's one enclosed framing and is
    // designed as "a dark tube with a COLD fluorescent rhythm down it and one
    // warm sodium wedge at the near floor". It photographed 89.7% warm against
    // 7.1% cool - the exact inverse of its own design - and 47% of the frame is
    // corrugated sheet: two side walls, both gables and the roof deck. Neither
    // corrugated entry asked for an albedoTarget, so both inherited whatever
    // hue textures.js authors, and materials.js's own note says the library is
    // written "inside one sun-baked tan". Galvanised profiled sheet is not tan;
    // it is a cool grey with a green cast, and 0x74787b/0x6e7276 is what a
    // twenty-year-old one measures. That single number is what makes the hall a
    // cold room, and it costs nothing anywhere else because the only other
    // things wearing it are cooler casings and fixture housings, which are also
    // galvanised.
    //
    // normalScale down with it: the roof deck is the top third of the interior
    // framing seen at a 15-degree grazing angle, where a full-strength normal on
    // a 0.85 tiles/m rib map printed as a popcorn ceiling.
    // 0x7e8286 / 0x767b7f, not 0x74787b / 0x6e7276: SAME CHROMATICITY, 12% more
    // value. Cooling the cladding won the hue argument (lv_interior went from
    // 89.7% warm / 7.1% cool to 62.3/32.4) but it also took the hall's north wall
    // - which carries the left third of that framing - from a cell median of 0.24
    // to 0.15, and two cells with it. The cool cast is the part that matters; the
    // darkness was collateral.
    clad:      { uv: 0.38, cast: true, recv: true, wear: false,
                 base: 'corrugated_metal', albedoTarget: 0x7e8286,
                 rough: 0.60, metal: 0.62, env: 1.3, ns: 0.46 },
    roof:      { uv: 0.85, cast: true, recv: true, wear: false,
                 base: 'corrugated_roof', albedoTarget: 0x767b7f,
                 rough: 0.70, metal: 0.55, env: 1.2, ns: 0.26 },
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
    // Translucent GRP roof sheeting, seen from underneath at dusk. It is NOT a
    // fixture: it is a 17 square metre area of the pump hall's ceiling, and at
    // the fluorescent battens' 5.2 it blew 2.2% of the interior frame. 1.9
    // reads as daylight-through-plastic, which is what it is, and it is what
    // carries the top half of a room whose floor was measuring brighter than
    // its ceiling.
    lamp_sky:  { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.42, metal: 0.0,
                 emissive: 0xa8c2e0, emissiveIntensity: 2.7 },
    lamp_r:    { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.26, metal: 0.0,
                 emissive: 0xff2a18, emissiveIntensity: 6.4 },
    // ---- distance -------------------------------------------------------------
    // The rest of the refinery, 130-330 m out. Its own bucket because it needs
    // none of the detail-normal machinery the near surfaces do and because its
    // albedo is authored for aerial perspective rather than for material.
    // env 1.45, not 0.55. The backdrop stands 130-330 m out with NOTHING
    // lighting it: no practical reaches, the key is under the horizon, and
    // sky.js's fog layer is 26 m deep so the top 60% of a 34-64 m cooling
    // tower is above the atmosphere and gets no aerial lift at all. The only
    // illuminant those masses have left is the environment probe, and at 0.55
    // they measured 0.078 against a 0.47 sky - flat black paper. envMapIntensity
    // is the correct dial for exactly this: it is the sky's own irradiance, so
    // the faces turned toward the twilight band lift more than the ones turned
    // away, which is what makes a silhouette read as a solid rather than a hole.
    // MEASURED AGAIN, ROUND 3. The 130-330 m band still reads as BLACK PAPER:
    // sampling lv_overview across the distant column row gives 29.5% of that
    // band below 0.10 luminance with a minimum of 0.016, against a sky of 0.553
    // immediately above it. The previous pass fixed the SHAPE of the skyline and
    // wrote a vertex-colour lift for the value; the lift was simply too small to
    // matter, because it multiplies an albedo of 0x5c5b58 (0.10 linear) lit by
    // nothing but the environment probe of a sky 6.8 degrees under the horizon.
    // 0.10 x 1.3 x a dim probe is still black.
    //
    // A silhouette at 200 m in real haze does not sit at 3% of the sky, it sits
    // at 40-70% of it. The albedo goes to 0x6e6c66 (0.16 linear) and the probe
    // gain to 1.75, and the height/distance lift in _paint's `far` branch does
    // the rest - see the note there.
    far:       { uv: 0.075, cast: false, recv: false, wear: false,
                 base: 'concrete', albedoTarget: 0x6e6c66, rough: 0.92,
                 metal: 0.0, env: 1.75, ns: 0.22 },
    far_light: { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                 base: 'plastic', rough: 0.4, metal: 0.0,
                 emissive: 0xffb968, emissiveIntensity: 4.6 }
  };

  // If materials.js is missing entirely the plant must still read as steel and
  // concrete at dusk rather than as magenta error boxes.
  var FALLBACK = {
    pave:      [0x787876, 0.88, 0.0],
    road:      [0x3c3c3c, 0.86, 0.0],
    grit:      [0x6b655a, 0.94, 0.0],
    joint:     [0x272724, 0.95, 0.0],
    sandy:     [0x5e564a, 0.95, 0.0],
    wall:      [0x7d786f, 0.90, 0.0],
    kerb:      [0x8a857c, 0.90, 0.0],
    struct:    [0x5e6164, 0.58, 0.66],
    derrick:   [0xa8a49a, 0.60, 0.34],
    pipe:      [0x8d9298, 0.50, 0.70],
    pipe_g:    [0x2f6b3e, 0.54, 0.50],
    pipe_o:    [0xb0521a, 0.60, 0.44],
    lag:       [0x8b9095, 0.58, 0.42],
    tank:      [0x83827c, 0.72, 0.38],
    machine:   [0x4c6354, 0.46, 0.55],
    rust:      [0x7a4a30, 0.78, 0.60],
    grate:     [0x55514b, 0.72, 0.70],
    rail:      [0xa9821f, 0.55, 0.45],
    clad:      [0x7e8286, 0.58, 0.62],
    roof:      [0x767b7f, 0.68, 0.55],
    brick:     [0x8a6a52, 0.92, 0.0],
    glass:     [0x243038, 0.10, 0.0],
    chain:     [0x8a9096, 0.70, 0.40],
    refract:   [0x6d5a4a, 0.92, 0.0],
    decal:     [0xffffff, 0.80, 0.0],
    lamp_w:    [0xffcf92, 0.26, 0.0],
    lamp_c:    [0xd8e6ff, 0.26, 0.0],
    lamp_r:    [0xff5a44, 0.26, 0.0],
    lamp_sky:  [0xa8c2e0, 0.42, 0.0],
    far:       [0x6e6c66, 0.90, 0.0],
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

  // A flat painted strip on the ground running from A to B. The axis-aligned
  // `decalCard` can only lay a mark square to the world, and the one thing a
  // road surface needs that nothing else in this level provides is a line at
  // 45 DEGREES - see the junction note in buildGround.
  //
  // decalCard's 'y' axis form composes Ry(roll) * Rx(-PI/2), under which the
  // card's own +Y maps to (-sin roll, 0, -cos roll); setting roll from the
  // negated run direction therefore puts the card's HEIGHT along the run and
  // its WIDTH across it.
  function groundStrip(B, cell, ax, az, bx, bz, wdt, y) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.06) return;
    var roll = Math.atan2(-dx / len, -dz / len);
    decalCard(B, cell, (ax + bx) * 0.5, y, (az + bz) * 0.5, wdt, len, 'y', roll);
  }

  // A vertical decal card facing an arbitrary compass bearing. The axis-aligned
  // form above cannot mark a cylinder, and a column has nozzles all round it.
  function decalCardYaw(B, cell, x, y, z, w, h, yaw) {
    var uvr = atlasUV(cell);
    B.add('decal', quad(w, h, uvr[0], uvr[1], uvr[2], uvr[3]), makeM(x, y, z, 0, yaw, 0));
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
    // ---- THE JUNCTION ---------------------------------------------------------
    // The cross road IS the foreground of the signature frame: the hero1 eye
    // stands at z = 26 and the junction box runs z = 13..22, so the nearest
    // four to thirteen metres of that image are carriageway. Once it was lit it
    // needed something to look AT, and what a plant paints at a junction is a
    // yellow hatched box, a stop bar and a direction arrow on each approach.
    // It is the only high-frequency chroma below eye level in the near field
    // and it is what gives 20 m of tarmac man-made grain.
    // ---- MEASURED, ROUND 3, AND IT WAS THE LOUDEST THING IN THE FRAME ------
    // The box was five TRANSVERSE hazard cards, 14.1 m wide by 0.46 m deep, at
    // 1.7 m centres. From the hero1 mark those five bars sit 5 to 12 m ahead at
    // a 10-20 degree grazing angle, where 0.46 m of depth collapses to three or
    // four pixels - so the chevron pattern inside each card was mathematically
    // unresolvable and every bar printed as ONE FLAT SATURATED YELLOW LINE.
    // Sampled on the delivered frame they read (220,170,77) against apron at
    // (95,90,87): 2.3x the luminance of the largest surface in the level, in
    // five parallel evenly-spaced stripes. That is a zebra crossing, it is the
    // brightest and most saturated thing below the skyline, and it is item
    // "perfectly straight, perfectly uniform anything" on the instant-fail list
    // sitting in the near foreground of the signature image.
    //
    // A hatched box is not transverse bars. It is a painted OUTLINE with
    // DIAGONALS across it, and the diagonal is the entire point: this level is
    // built out of horizontals (kerbs, rack transoms, bridges, catwalks) and
    // verticals (bents, columns, masts), so a 45-degree line is the one
    // direction nothing else in the frame occupies - it reads as a hatch at any
    // range instead of as banding, and it can never line up with the horizon.
    //
    // It is also DULLED. Plant road paint is fifteen years old under blown
    // grit; the tint takes it to about 1.35x the apron rather than 2.3x, which
    // is paint on concrete rather than a light source.
    (function () {
      var hx0 = ROAD_X0 + 0.60, hx1 = ROAD_X1 - 0.60;
      var hz0 = XR_Z0 + 0.95, hz1 = XR_Z1 - 0.95;
      var hy = function (px, pz) { return groundY(px, pz, N) + 0.013; };
      B.tint = new THREE.Color(0.58, 0.56, 0.80);
      // The outline is the two LONGITUDINAL runs only, and that is a measured
      // decision rather than a lazy one. With all four painted, the two
      // transverse runs came back as the same two bright bars across the frame
      // that the five chevron cards had been - a line square to the eye at a
      // 15-degree grazing angle is a bar whatever it is a part of. The two runs
      // that recede become leading lines instead, and a plant hatch really is
      // only outlined on the sides traffic can cross.
      groundStrip(B, CELL.hazard, hx0, hz0, hx0, hz1, 0.22, hy(hx0, 0));
      groundStrip(B, CELL.hazard, hx1, hz0, hx1, hz1, 0.22, hy(hx1, 0));
      // the diagonals: lines of constant (x - z), clipped to the box, at a
      // 1.55 m perpendicular pitch. The clip is what makes the corner stripes
      // short, which is what a hatch actually looks like.
      var cLo = hx0 - hz1, cHi = hx1 - hz0, dC = 1.55 * Math.SQRT2;
      for (var hc = cLo + dC * 0.5; hc < cHi; hc += dC) {
        var za = Math.max(hz0, hx0 - hc), zb = Math.min(hz1, hx1 - hc);
        if (zb - za < 0.35) continue;
        groundStrip(B, CELL.hazard, za + hc, za, zb + hc, zb, 0.19,
          hy((za + zb) * 0.5 + hc, (za + zb) * 0.5));
      }
      B.tint = null;
    })();
    for (k = 0; k < 2; k++) {
      var sbz = k ? XR_Z1 + 1.5 : XR_Z0 - 1.5;
      decalCard(B, CELL.tape, ROAD_CX, groundY(ROAD_CX, sbz, N) + 0.013, sbz,
        (ROAD_X1 - ROAD_X0) - 0.8, 0.34, 'y', 0.012);
      decalCard(B, CELL.arrow, ROAD_CX + (k ? 3.2 : -3.2),
        groundY(ROAD_CX, sbz + (k ? 3.4 : -3.4), N) + 0.013, sbz + (k ? 3.4 : -3.4),
        2.4, 3.6, 'y', k ? -Math.PI * 0.5 : Math.PI * 0.5);
    }
    // and the edge lines of the cross road, which is what makes it read as a
    // road crossing a road rather than as a change of material
    for (k = 0; k < 2; k++) {
      var elz = k ? XR_Z1 - 0.55 : XR_Z0 + 0.55;
      // Broken, not dashed: plant road paint is put down with a roller by a
      // contractor and half of it has been driven off. A perfectly regular
      // dash pattern is a modern highway and reads as one.
      for (i = 0; i < 12; i++) {
        var elx = -22.0 + i * 4.0 + rng.range(-0.7, 0.7);
        if (elx > ROAD_X0 - 1.5 && elx < ROAD_X1 + 1.5) continue;
        if (rng.bool(0.24)) continue;
        decalCard(B, CELL.tape, elx, groundY(elx, elz, N) + 0.013, elz,
          rng.range(2.1, 3.6), 0.26, 'y', Math.PI * 0.5 + rng.range(-0.02, 0.02));
      }
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
    // ---- CONSTRUCTION AND CONTROL JOINTS -------------------------------------
    // MEASURED: the apron is one 26,500 square metre heightfield laid at a
    // 2.6 m step and dressed with 120 stain decals - one per 220 square metres.
    // In hero1's foreground that is twenty metres of unbroken plane carrying
    // one or two smudges, on the largest surface in the signature frame, with
    // no man-made grain in it at all. `jointDip` already puts a 26 mm dip on a
    // 5 m lattice, but the mesh samples at 2.6 m so almost none of it survives
    // to a vertex; the relief was being computed and thrown away.
    //
    // 5.0 m in both directions is the bay a concrete apron is really sawn at,
    // and the jitter is +/-0.15 m because a saw follows a chalk line held by a
    // person. Skipped over the roads, the bunds and the pump house, which carry
    // their own surfaces. Merged into one bucket: 1 draw call, ~4.4k triangles.
    B.paint = 'joint';
    (function () {
      var JP = 5.0, JW = 0.055;
      function skip(cx2, cz2) {
        if (cx2 > ROAD_X0 - 0.5 && cx2 < ROAD_X1 + 0.5) return true;
        if (cz2 > XR_Z0 - 0.5 && cz2 < XR_Z1 + 0.5 &&
            cx2 > XR_X0 && cx2 < XR_X1) return true;
        if (bundF(cx2, cz2) > 0.05) return true;
        if (cx2 > PH_X0 - 0.4 && cx2 < PH_X1 + 0.4 &&
            cz2 > PH_Z0 - 0.4 && cz2 < PH_Z1 + 0.4) return true;
        return false;
      }
      var jx, jz, seg, uvj = atlasUV(CELL.tape);
      for (jx = Math.ceil(PAVE_X0 / JP) * JP; jx < PAVE_X1; jx += JP) {
        for (jz = PAVE_Z0; jz < PAVE_Z1 - 0.5; jz += JP) {
          var mxj = jx + rng.range(-0.15, 0.15);
          var mzj = Math.min(jz + JP * 0.5, PAVE_Z1 - 0.25);
          if (skip(mxj, mzj)) continue;
          seg = Math.min(JP, PAVE_Z1 - jz);
          B.add('joint', quad(JW, seg - 0.04, uvj[0], uvj[1], uvj[2], uvj[3]),
            makeM(mxj, groundY(mxj, mzj, N) + 0.010, mzj, -Math.PI * 0.5, 0, 0));
        }
      }
      for (jz = Math.ceil(PAVE_Z0 / JP) * JP; jz < PAVE_Z1; jz += JP) {
        for (jx = PAVE_X0; jx < PAVE_X1 - 0.5; jx += JP) {
          var mzk = jz + rng.range(-0.15, 0.15);
          var mxk = Math.min(jx + JP * 0.5, PAVE_X1 - 0.25);
          if (skip(mxk, mzk)) continue;
          seg = Math.min(JP, PAVE_X1 - jx);
          B.add('joint', quad(JW, seg - 0.04, uvj[0], uvj[1], uvj[2], uvj[3]),
            makeM(mxk, groundY(mxk, mzk, N) + 0.010, mzk, -Math.PI * 0.5, Math.PI * 0.5, 0));
        }
      }
      // ---- manhole and valve-pit covers along the kerb line ------------------
      // Every drainage run in a plant has a rodding eye at every change of
      // direction, and they sit on the kerb line because that is where the
      // channel is. Six a side: a bedded frame, a dished cover and its lifting
      // keyholes.
      var COV = [-38.0, -14.0, 6.0, 28.0, 52.0, 68.0];
      for (var cv = 0; cv < COV.length; cv++) {
        for (var cs = 0; cs < 2; cs++) {
          var cvx = cs ? ROAD_X1 + 1.65 : ROAD_X0 - 1.65;
          var cvz = COV[cv] + (cs ? 2.4 : 0);
          if (cvz < PAVE_Z0 + 2 || cvz > PAVE_Z1 - 2) continue;
          if (cvz > XR_Z0 - 1.5 && cvz < XR_Z1 + 1.5) continue;
          var cvy = groundY(cvx, cvz, N);
          B.paint = 'kerb';
          B.box('kerb', 0.86, 0.10, 0.86, cvx, cvy + 0.005, cvz, 0.012);
          B.paint = 'steel';
          B.box('rust', 0.62, 0.055, 0.62, cvx, cvy + 0.038, cvz, 0.010);
          B.box('rust', 0.15, 0.020, 0.055, cvx - 0.16, cvy + 0.068, cvz, 0.004);
          B.box('rust', 0.15, 0.020, 0.055, cvx + 0.16, cvy + 0.068, cvz, 0.004);
          B.paint = 'joint';
        }
      }
    })();
    B.paint = 'flat';

    // spills, scuffs and inspection marks scattered where the traffic goes.
    // 260, not 120, and biased toward the near field of the published poses
    // rather than uniform over 26,500 square metres - a stain density that
    // reads at 60 m is invisible at 6 m, and every framing here has 6 m of
    // apron in the bottom of it.
    var NEARF = [[-1.2, 26.0], [-11.3, 4.0], [-26.0, -6.0], [10.6, 20.0], [26.0, 45.0]];
    for (i = 0; i < 260; i++) {
      var sx, sz;
      if (i % 5 < 2) {
        var nf = NEARF[i % NEARF.length];
        sx = nf[0] + rng.gaussian(0, 7.0);
        sz = nf[1] + rng.gaussian(0, 7.0);
        sx = M.clamp(sx, PAVE_X0 + 4, PAVE_X1 - 4);
        sz = M.clamp(sz, PAVE_Z0 + 4, PAVE_Z1 - 4);
      } else {
        sx = rng.range(PAVE_X0 + 4, PAVE_X1 - 4);
        sz = rng.range(PAVE_Z0 + 4, PAVE_Z1 - 4);
        // bias hard toward the road and the unit pads: stains are where work is
        if (rng.bool(0.55)) { sx = rng.range(ROAD_X0 - 4, ROAD_X1 + 4); }
      }
      if (bundF(sx, sz) > 0.4 && rng.bool(0.6)) continue;
      // MEASURED. At 120 stains the mix was one cross in five and nobody
      // noticed; at 260 with a near-field bias hero1's foreground came back
      // carrying six saturated yellow crosses a metre and a half across, and
      // they read as PAINTED ROAD MARKINGS rather than as the paint-stick mark
      // an inspector leaves on a slab. A sprayed inspection mark is small, and
      // there is one of them for every twenty oil stains on a real apron.
      var cellPick = rng.pick([CELL.spill, CELL.spill, CELL.spill, CELL.scuff,
                               CELL.scuff, CELL.weep, CELL.weep, CELL.cross]);
      var sw = cellPick === CELL.spill ? rng.range(1.2, 3.6)
        : (cellPick === CELL.cross ? rng.range(0.55, 0.95) : rng.range(0.9, 2.6));
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
        // GUSSET PLATES at every beam/column node. At the ads standoff the
        // nearest rack columns are 4 m off the lens and were plain rectangular
        // boxes; a gusset is one thin rotated plate per node and it is what
        // separates a steel frame from a set of extruded blocks.
        for (var gk = 0; gk < 2; gk++) {
          var gpx = gk ? cx1 : cx0;
          var gsgn = gk ? -1 : 1;
          B.boxR('struct', 0.46, 0.46, 0.018, gpx + gsgn * 0.28, ty + 0.30, z - 0.16,
            0, 0, 0.785, 0.004);
          B.boxR('struct', 0.46, 0.46, 0.018, gpx + gsgn * 0.28, ty + 0.30, z + 0.16,
            0, 0, 0.785, 0.004);
        }
      }
      // base plates and their holding-down bolts
      for (var bk = 0; bk < 2; bk++) {
        var bpx = bk ? cx1 : cx0;
        B.box('struct', 0.62, 0.045, 0.62, bpx, y0 + 0.40, z, 0.006);
        for (var bb = 0; bb < 4; bb++) {
          B.cyl('struct', 0.030, 0.030, 0.11,
            bpx + ((bb & 1) ? 0.22 : -0.22), y0 + 0.47, z + ((bb & 2) ? 0.22 : -0.22),
            0, 0, 0, 6);
        }
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
      // STAGGER THE JOINTS. Every line used to break at spec.z0 + n * runLen,
      // so all twenty-seven flanges on a tier landed at the same z and the rack
      // printed "a row of identical black semicircular pipe ends repeating
      // along the beams". Real pipe comes in random lengths and is cut on site;
      // a per-line phase of up to a full run kills the row outright.
      var jOff = -runLen * swap;
      for (var seg = 0; seg * runLen + jOff < (spec.z1 - spec.z0); seg++) {
        var sz0 = Math.max(spec.z0, spec.z0 + seg * runLen + jOff);
        var sz1 = Math.min(spec.z1, spec.z0 + (seg + 1) * runLen + jOff);
        // The phase offset makes the FIRST segment of a line short as well as
        // the last, so a bare `break` here would delete the whole run whenever
        // the offset happened to land near a full pitch.
        if (sz1 - sz0 < 0.6) {
          if (sz0 >= spec.z1 - 0.6) break;
          continue;
        }
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
      // ---- PIPE SHOES at every bent ------------------------------------------
      // They existed at 140 mm and 160 mm deep, which is nothing at the 4 m the
      // ads standoff puts the nearest lines at. A real shoe is a 150 mm welded
      // saddle sitting on a wear plate with a guide clip either side of it, and
      // it is the single detail that makes a rack read as a rack rather than as
      // a bundle of naked cylinders resting on a beam.
      B.paint = 'steel';
      for (i = 0; i <= nb; i += 1) {
        var sz = bentZ[i];
        var shY = gy(lx, sz) + ly0 - lr;
        // the saddle plate curved to the pipe, the web under it, the base
        B.box('struct', lr * 1.9 + 0.05, 0.035, 0.30, lx, shY - 0.02, sz, 0.005);
        B.box('struct', 0.040, 0.17, 0.26, lx, shY - 0.11, sz, 0.005);
        B.box('struct', lr * 1.5 + 0.06, 0.032, 0.34, lx, shY - 0.20, sz, 0.005);
        // guide clips either side of the shoe, on alternate bents
        if (i % 2 === 0) {
          B.box('struct', 0.035, 0.19, 0.055, lx - (lr * 0.95 + 0.05), shY - 0.10, sz, 0.004);
          B.box('struct', 0.035, 0.19, 0.055, lx + (lr * 0.95 + 0.05), shY - 0.10, sz, 0.004);
        }
        // U-bolt over the line every fourth bent
        if (i % 4 === 2) {
          B.paint = 'rusty';
          for (var ub = 0; ub < 7; ub++) {
            var ua0 = Math.PI * (ub / 7), ua1 = Math.PI * ((ub + 1) / 7);
            B.tube('rust',
              lx + Math.cos(ua0) * (lr + 0.035), gy(lx, sz) + ly0 + Math.sin(ua0) * (lr + 0.035), sz,
              lx + Math.cos(ua1) * (lr + 0.035), gy(lx, sz) + ly0 + Math.sin(ua1) * (lr + 0.035), sz,
              0.018, 4);
          }
          B.paint = 'steel';
        }
      }
      // ---- flanged joints on the two biggest lines ---------------------------
      // A pair of raised-face flanges with a bolt ring, every third bay. They
      // are the only high-frequency detail on a 158 m pipe and they are what
      // gives the rack a longitudinal rhythm as well as a transverse one.
      if (lr > 0.20) {
        for (i = 3; i <= nb; i += 3) {
          var fz2 = bentZ[i] - pitch * 0.42;
          var fy2 = gy(lx, fz2) + ly0;
          B.cyl('struct', lr * 1.62, lr * 1.62, 0.045, lx, fy2, fz2 - 0.035,
            Math.PI * 0.5, 0, 0, 12);
          B.cyl('struct', lr * 1.62, lr * 1.62, 0.045, lx, fy2, fz2 + 0.035,
            Math.PI * 0.5, 0, 0, 12);
          for (var fb = 0; fb < 8; fb++) {
            var fba = fb / 8 * Math.PI * 2;
            B.cyl('struct', 0.020, 0.020, 0.17,
              lx + Math.cos(fba) * lr * 1.36, fy2 + Math.sin(fba) * lr * 1.36, fz2,
              Math.PI * 0.5, 0, 0, 5);
          }
        }
      }
      // ---- painted service band at every fourth support ----------------------
      // The three-colour coding is bought in the albedo now, but a wash of
      // sodium still flattens hue; a hard-edged painted band at a support
      // survives that because it is a VALUE break, not a hue one.
      B.paint = 'flat';
      for (i = 2; i <= nb; i += 4) {
        var bz3 = bentZ[i] + pitch * 0.30;
        decalCard(B, CELL.band, lx + lr + 0.008, gy(lx, bz3) + ly0, bz3,
          lr * 2.4, lr * 2.4, 'x', Math.PI * 0.5);
      }
      // flow arrow, twice per line
      for (k = 0; k < 2; k++) {
        var dz = spec.z0 + (spec.z1 - spec.z0) * (0.22 + 0.46 * k + swap * 0.1);
        decalCard(B, CELL.arrow, lx + lr + 0.006,
          gy(lx, dz) + ly0, dz, lr * 2.6, lr * 2.6, 'x', Math.PI * 0.5);
      }
      B.paint = 'steel';
    }

    // ---- gate valves where the rack meets the road ---------------------------
    // Two per tier at the road end, on a short branch takeoff with a handwheel
    // standing proud of the line. A branch, a valve and a wheel is the most
    // recognisable object in a plant and there was not one on either rack.
    B.paint = 'steel';
    for (var vt = 0; vt < spec.tiers.length; vt++) {
      var vln = spec.lines[(vt * 5 + 3) % spec.lines.length];
      var vlx = spec.x + vln[1], vlr = Math.max(0.13, vln[2]);
      var vz = spec.z1 - 6.0 - vt * 9.0;
      if (vz < spec.z0 + 4) continue;
      var vy = gy(vlx, vz) + spec.tiers[vln[0]] + 0.14 + vlr;
      var vside = (spec.x < 0) ? 1 : -1;      // branch toward the road
      B.paint = 'pipe';
      B.tube('pipe', vlx, vy, vz, vlx + vside * (spec.half + 1.15), vy, vz, vlr * 0.8, 8);
      B.paint = 'paint';
      var vbx = vlx + vside * (spec.half + 0.55);
      B.cyl('pipe_g', vlr * 1.9, vlr * 1.9, vlr * 2.4, vbx, vy, vz, 0, 0, Math.PI * 0.5, 12);
      B.cyl('struct', vlr * 0.55, vlr * 0.95, 0.42, vbx, vy + 0.34, vz, 0, 0, 0, 8);
      B.torus('rail', 0.34, 0.032, vbx, vy + 0.60, vz, 14);
      for (var vs2 = 0; vs2 < 4; vs2++) {
        B.boxR('rail', 0.028, 0.028, 0.68, vbx, vy + 0.60, vz, 0, vs2 / 4 * Math.PI * 2, 0, 0.005);
      }
      B.cyl('rail', 0.05, 0.05, 0.10, vbx, vy + 0.66, vz, 0, 0, 0, 8);
      B.paint = 'steel';
      B.cyl('struct', vlr * 2.2, vlr * 2.2, 0.05, vbx - vside * vlr * 1.6, vy, vz,
        0, 0, Math.PI * 0.5, 12);
      B.cyl('struct', vlr * 2.2, vlr * 2.2, 0.05, vbx + vside * vlr * 1.6, vy, vz,
        0, 0, Math.PI * 0.5, 12);
      B.paint = 'flat';
      decalCard(B, CELL.valve, vbx, vy + 0.02, vz + vlr * 2.0, 0.30, 0.30, 'z');
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
      // MEASURED PROFILE FIX. The pad was a cone r+0.85 -> r+1.05 and the skirt
      // another cone r+0.10 -> r+0.16, so the bottom 3 m of every column flared
      // outward and the row photographed as a line of CEMENT SILOS rather than
      // as fractionating columns. A real column is a constant-diameter can on a
      // straight cylindrical skirt with one reducer high up and an ellipsoidal
      // head; everything below is dead straight.
      B.paint = 'wall';
      B.cyl('wall', r + 0.92, r + 0.92, 0.46, C.x, base + 0.21, C.z, 0, 0, 0, 20);
      B.paint = 'refractory';
      B.cyl('refract', r + 0.13, r + 0.13, skirtH, C.x, base + skirtH * 0.5, C.z, 0, 0, 0, 20);
      // base flange ring and the anchor-bolt chairs round it
      B.paint = 'steel';
      B.cyl('struct', r + 0.30, r + 0.30, 0.055, C.x, base + 0.47, C.z, 0, 0, 0, 20, true);
      for (var ab = 0; ab < 12; ab++) {
        var aba = ab / 12 * Math.PI * 2 + 0.13;
        B.strut('struct',
          C.x + Math.cos(aba) * (r + 0.14), base + 0.50, C.z + Math.sin(aba) * (r + 0.14),
          C.x + Math.cos(aba) * (r + 0.30), base + 1.05, C.z + Math.sin(aba) * (r + 0.30),
          0.05, 0.10);
      }
      // access opening in the skirt, and the vent slots around it
      B.box('struct', 0.95, 1.55, 0.14, C.x - r - 0.09, base + 0.80, C.z, 0.01);
      for (var v = 0; v < 8; v++) {
        var va = v / 8 * Math.PI * 2 + 0.4;
        B.box('rust', 0.30, 0.16, 0.12,
          C.x + Math.cos(va) * (r + 0.14), base + skirtH - 0.35, C.z + Math.sin(va) * (r + 0.14), 0.01);
      }

      // ---- the shell -----------------------------------------------------------
      // Constant diameter to 0.72 h, one 1.4 m reducer, a smaller rectifying
      // section above it and an ellipsoidal head on top. The can itself is
      // three cylinders; everything that makes it READ as a lagged column is
      // hung on it below.
      var seg = 22;
      var rTop = r * 0.82;
      var swY = shellY0 + C.h * 0.72;
      var bandPitch = 1.08;
      var shellR = (function (rr, rt, sw) {
        return function (yy) {
          if (yy >= sw + 1.40) return rt;
          if (yy <= sw) return rr;
          return M.lerp(rr, rt, (yy - sw) / 1.40);
        };
      })(r, rTop, swY);
      // ---- the weather jacketing, AS VALUE --------------------------------------
      // MEASURED, and this is the whole finding. The banding rings below are
      // 0.055 m tall standing 0.030 m proud at 1.08 m pitch. At hero2's 45 m
      // stand-off and the 75-degree vertical FOV these framings are captured
      // at, 0.055 m subtends 0.57 PIXELS - so the hardware was paid for in
      // triangles and was mathematically incapable of being seen, and the
      // shells printed as pale paper-towel tubes. Relief cannot carry banding
      // at that range; only ALBEDO can.
      //
      // So the shell stops being three long cylinders and becomes a stack of
      // one-course cans, each carrying its own value. Aluminium jacket really
      // does look like this - each sheet came off a different coil in a
      // different year, and the ones under a leaking flange have been replaced
      // - so the pattern is a hash of the course index rather than a strict
      // alternation, which is what stops 38 courses reading as a barber pole
      // and what stops the four columns banding in lockstep. 0.82 to 1.12 is
      // 1.37:1, which is two thirds of a stop and survives 110 m of haze.
      // Cost: 108 short cylinders across the four columns in place of 12 long
      // ones, all in the same merge bucket, so it is ~4.7k triangles and no
      // draw call.
      B.paint = 'jacket';
      var nSeg = Math.max(2, Math.ceil((top - shellY0) / bandPitch));
      for (var sgi = 0; sgi < nSeg; sgi++) {
        var sy0 = shellY0 + (top - shellY0) * (sgi / nSeg);
        var sy1 = shellY0 + (top - shellY0) * ((sgi + 1) / nSeg);
        var hs = (Math.sin((sgi + 1) * 12.9898 + c * 7.13) * 43758.5453) % 1;
        if (hs < 0) hs += 1;
        // 0.72-1.16, not 0.82-1.12. MEASURED: at 1.37:1 the courses were still
        // inside the shell's own noise at the 45 m hero2 puts C1 at and the can
        // read as one smooth tube. 1.61:1 is two thirds of a stop between
        // neighbouring courses, which is what a jacket repaired over twenty
        // years really looks like and what survives both the haze and the grade.
        var vJ = 0.72 + hs * 0.44;
        B.tint = new THREE.Color(vJ, vJ * 1.005, vJ * 1.02);
        B.cyl('lag', shellR(sy1), shellR(sy0), sy1 - sy0, C.x, (sy0 + sy1) * 0.5, C.z,
          0, 0, 0, seg, true);
      }
      B.tint = null;
      B.paint = 'lagging';
      // ellipsoidal head: two short frusta and a cap, which is the 2:1 profile
      B.cyl('lag', rTop * 0.86, rTop, 0.42, C.x, top + 0.21, C.z, 0, 0, 0, seg, true);
      B.cyl('lag', rTop * 0.55, rTop * 0.86, 0.36, C.x, top + 0.60, C.z, 0, 0, 0, seg, true);
      B.cyl('lag', rTop * 0.16, rTop * 0.55, 0.26, C.x, top + 0.91, C.z, 0, 0, 0, seg, true);

      // The banding rings themselves. They stay - at the ads and interior
      // stand-offs they are real hardware and they catch a raking flood - but
      // they now carry a bright stainless tint so that at 45-110 m, where the
      // relief is sub-pixel, they still read as a light line against the
      // course above and below.
      var nBand = Math.max(3, Math.floor((top - shellY0) / bandPitch));
      for (var bd = 1; bd < nBand; bd++) {
        var by0 = shellY0 + bd * bandPitch;
        var rb = shellR(by0);
        B.paint = 'jacket';
        B.tint = new THREE.Color(1.14, 1.15, 1.18);
        B.cyl('lag', rb + 0.030, rb + 0.030, 0.055, C.x, by0, C.z, 0, 0, 0, seg, true);
        B.tint = null;
        // every fourth band carries the stainless banding strap over it
        if (bd % 4 === 0) {
          B.paint = 'steel';
          B.cyl('struct', rb + 0.048, rb + 0.048, 0.028, C.x, by0 + 0.055, C.z, 0, 0, 0, seg, true);
        }
        B.paint = 'lagging';
      }
      // vertical lap seams: nine of them, offset course by course so the shell
      // does not read as a nine-sided prism
      var nLap = Math.max(7, Math.round(2 * Math.PI * r / 1.55));
      for (var lp2 = 0; lp2 < nLap; lp2++) {
        var la = lp2 / nLap * Math.PI * 2 + c * 0.31;
        for (var lsg = 0; lsg < 3; lsg++) {
          var ly0 = shellY0 + (top - shellY0) * (lsg / 3) + 0.10;
          var ly1 = shellY0 + (top - shellY0) * ((lsg + 1) / 3) - 0.10;
          var lrr = (ly0 > swY + 1.40) ? rTop : r;
          var laj = la + lsg * (Math.PI * 2 / nLap) * 0.34;
          B.boxR('lag', 0.10, ly1 - ly0, 0.055,
            C.x + Math.cos(laj) * (lrr + 0.022), (ly0 + ly1) * 0.5,
            C.z + Math.sin(laj) * (lrr + 0.022), 0, -(laj + Math.PI * 0.5), 0, 0.008);
        }
      }
      B.paint = 'lagging';

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

      // ---- one CONTINUOUS caged ladder ----------------------------------------
      // It was staggered platform-to-platform, which is what a real column has
      // and which reads at 60 m as five unrelated 4 m fragments. One unbroken
      // caged run up the aisle face is a single 40 m vertical with a repeating
      // hoop rhythm on it, and that is worth more than the accuracy.
      var lyaw = Math.PI * 0.86;                       // the road-facing side
      var ladR = r + 1.24;
      B.ladder(C.x + Math.cos(lyaw) * ladR, C.z + Math.sin(lyaw) * ladR,
        base + skirtH * 0.2, plats[plats.length - 1] + 1.05, lyaw + Math.PI, true);
      // and the short rest platforms the cage lands on
      for (var li = 0; li < plats.length; li++) {
        B.paint = 'steel';
        B.boxR('grate', 1.30, 0.035, 0.95,
          C.x + Math.cos(lyaw) * (ladR + 0.30), plats[li] + 0.02,
          C.z + Math.sin(lyaw) * (ladR + 0.30), 0, -lyaw, 0, 0.006);
      }

      // ---- nozzles, manways and the reinforcing pads --------------------------
      // Laid out per SECTION, not scattered: two or three stubs at each tray
      // level with a blind flange and a bolt circle on the end, and biased to
      // the two quadrants the road can see. A nozzle you cannot see is a
      // triangle you paid for.
      B.paint = 'steel';
      var nSec = Math.max(3, plats.length + 1);
      for (var sec = 0; sec < nSec; sec++) {
        var secY = shellY0 + (C.h - 1.0) * ((sec + 0.35) / nSec);
        var nHere = 2 + (sec % 2);
        for (var nz = 0; nz < nHere; nz++) {
          // aisle side +/- 70 degrees, so they read from the road and the plinth
          var na = Math.PI + rng.range(-1.22, 1.22);
          var ny = secY + rng.range(-0.55, 0.55);
          var nr2 = (ny > swY + 1.40) ? rTop : r;
          var nrad = 0.10 + rng.range(0, 0.20) * (1 - sec / nSec);
          var ex = Math.cos(na), ez = Math.sin(na);
          // reinforcing pad welded to the shell
          B.paint = 'lagging';
          B.cyl('lag', nrad * 2.3, nrad * 2.3, 0.05,
            C.x + ex * (nr2 + 0.02), ny, C.z + ez * (nr2 + 0.02),
            Math.PI * 0.5, -na + Math.PI * 0.5, 0, 10);
          B.paint = 'steel';
          B.tube('pipe', C.x + ex * nr2 * 0.98, ny, C.z + ez * nr2 * 0.98,
            C.x + ex * (nr2 + 0.46), ny, C.z + ez * (nr2 + 0.46), nrad, 8);
          // blind flange plus its bolt circle
          B.cyl('struct', nrad * 1.75, nrad * 1.75, 0.06,
            C.x + ex * (nr2 + 0.49), ny, C.z + ez * (nr2 + 0.49),
            Math.PI * 0.5, -na + Math.PI * 0.5, 0, 12);
          for (var bo = 0; bo < 6; bo++) {
            var boa = bo / 6 * Math.PI * 2;
            var tx2 = -ez, tz2 = ex;                    // tangent
            B.cyl('struct', 0.022, 0.022, 0.10,
              C.x + ex * (nr2 + 0.53) + tx2 * Math.cos(boa) * nrad * 1.4,
              ny + Math.sin(boa) * nrad * 1.4,
              C.z + ez * (nr2 + 0.53) + tz2 * Math.cos(boa) * nrad * 1.4,
              Math.PI * 0.5, -na + Math.PI * 0.5, 0, 5);
          }
          // and the hydrocarbon weep that runs down from every flange
          if (rng.bool(0.55)) {
            B.paint = 'flat';
            decalCardYaw(B, CELL.weep, C.x + ex * (nr2 + 0.10), ny - 1.5,
              C.z + ez * (nr2 + 0.10), rng.range(0.5, 1.0), 3.0,
              Math.atan2(ex, ez));
            B.paint = 'steel';
          }
        }
      }
      // two manways with a davit arm, on the platforms
      for (var mw = 0; mw < 2; mw++) {
        var mwy = plats[Math.min(plats.length - 1, mw * 2)] + 0.72;
        var mwr = (mwy > swY + 1.40) ? rTop : r;
        var mwa = Math.PI + (mw ? 0.85 : -0.55);
        var mex = Math.cos(mwa), mez = Math.sin(mwa);
        B.paint = 'lagging';
        B.cyl('lag', 0.60, 0.60, 0.07, C.x + mex * (mwr + 0.02), mwy,
          C.z + mez * (mwr + 0.02), Math.PI * 0.5, -mwa + Math.PI * 0.5, 0, 14);
        B.paint = 'steel';
        B.tube('pipe', C.x + mex * mwr * 0.98, mwy, C.z + mez * mwr * 0.98,
          C.x + mex * (mwr + 0.34), mwy, C.z + mez * (mwr + 0.34), 0.36, 14);
        B.cyl('struct', 0.52, 0.52, 0.06, C.x + mex * (mwr + 0.38), mwy,
          C.z + mez * (mwr + 0.38), Math.PI * 0.5, -mwa + Math.PI * 0.5, 0, 16);
        for (var mb = 0; mb < 10; mb++) {
          var mba = mb / 10 * Math.PI * 2;
          B.cyl('struct', 0.026, 0.026, 0.11,
            C.x + mex * (mwr + 0.42) + (-mez) * Math.cos(mba) * 0.44,
            mwy + Math.sin(mba) * 0.44,
            C.z + mez * (mwr + 0.42) + mex * Math.cos(mba) * 0.44,
            Math.PI * 0.5, -mwa + Math.PI * 0.5, 0, 5);
        }
        // davit
        B.tube('rail', C.x + mex * (mwr + 0.10), mwy + 0.55, C.z + mez * (mwr + 0.10),
          C.x + mex * (mwr + 0.10), mwy + 1.35, C.z + mez * (mwr + 0.10), 0.045, 6);
        B.tube('rail', C.x + mex * (mwr + 0.10), mwy + 1.35, C.z + mez * (mwr + 0.10),
          C.x + mex * (mwr + 0.85), mwy + 1.20, C.z + mez * (mwr + 0.85), 0.038, 6);
      }

      // ---- the reboiler at grade ------------------------------------------------
      // A horizontal shell-and-tube exchanger and its two big return legs. It is
      // the mass that stops the bottom of a column being a bare skirt, and its
      // channel head is the only strong horizontal cylinder in the unit.
      var rbA = Math.PI * 0.42;
      var rbX = C.x + Math.cos(rbA) * (r + 2.9), rbZ = C.z + Math.sin(rbA) * (r + 2.9);
      var rbR = 0.62 + c * 0.05, rbL = 5.4 - c * 0.5;
      B.paint = 'wall';
      B.box('wall', 1.1, 0.55, 1.1, rbX - 1.7, base + 0.20, rbZ, 0.02);
      B.box('wall', 1.1, 0.55, 1.1, rbX + 1.7, base + 0.20, rbZ, 0.02);
      B.paint = 'steel';
      B.box('struct', 0.9, 1.10, 0.30, rbX - 1.7, base + 1.02, rbZ, 0.012);
      B.box('struct', 0.9, 1.10, 0.30, rbX + 1.7, base + 1.02, rbZ, 0.012);
      B.paint = 'lagging';
      B.cyl('lag', rbR, rbR, rbL, rbX, base + 1.85, rbZ, 0, 0, Math.PI * 0.5, 16, true);
      B.cyl('lag', rbR * 0.5, rbR, 0.42, rbX - rbL * 0.5 - 0.21, base + 1.85, rbZ,
        0, 0, Math.PI * 0.5, 16, true);
      B.paint = 'steel';
      B.cyl('struct', rbR * 1.12, rbR * 1.12, 0.09, rbX + rbL * 0.5 - 0.05, base + 1.85, rbZ,
        0, 0, Math.PI * 0.5, 16);
      B.cyl('struct', rbR * 1.12, rbR * 1.12, 0.09, rbX - rbL * 0.5 + 0.05, base + 1.85, rbZ,
        0, 0, Math.PI * 0.5, 16);
      B.paint = 'lagging';
      B.tube('lag', rbX, base + 1.85 + rbR, rbZ, rbX, base + 3.4, rbZ, 0.24, 10);
      B.tube('lag', rbX, base + 3.4, rbZ, C.x + Math.cos(rbA) * (r + 0.35),
        base + 3.4, C.z + Math.sin(rbA) * (r + 0.35), 0.24, 10);
      B.tube('lag', rbX + rbL * 0.35, base + 1.85 - rbR, rbZ,
        rbX + rbL * 0.35, base + 0.75, rbZ, 0.20, 10);
      B.paint = 'steel';

      // ---- the overhead line --------------------------------------------------
      // A big vapour line leaving the top and sweeping down to the rack. It is
      // the only long DIAGONAL in a level otherwise made of verticals and
      // horizontals, and it is what ties the column row to the pipe rack.
      B.paint = 'lagging';
      var ohR = 0.40 + c * 0.03;
      var ohY = top + 0.3;
      var midX = (C.x + ER_X) * 0.5;
      B.tube('lag', C.x, ohY, C.z, C.x - 2.2, ohY + 0.9, C.z, ohR, 12);
      B.tube('lag', C.x - 2.2, ohY + 0.9, C.z, midX, ohY * 0.62 + 3.0, C.z - 1.0, ohR, 12);
      B.tube('lag', midX, ohY * 0.62 + 3.0, C.z - 1.0,
        ER_X + 0.4, gy(ER_X, C.z) + ER_TIERS[1] + 0.9, C.z - 1.6, ohR, 12);
      // its expansion bellows and two guide clamps, which is what says "vapour
      // line" rather than "bent tube"
      B.paint = 'steel';
      for (var bl = 0; bl < 4; bl++) {
        B.cyl('struct', ohR * 1.22, ohR * 1.22, 0.055, C.x - 2.2 + bl * 0.13,
          ohY + 0.9 + bl * 0.05, C.z, 0, 0, Math.PI * 0.42, 12);
      }
      B.paint = 'steel';

      // ---- markings ------------------------------------------------------------
      B.paint = 'flat';
      decalCard(B, CELL.unitno, C.x - r - 0.22, shellY0 + 1.5, C.z, 1.8, 1.8, '-x');
      decalCard(B, CELL.danger, C.x - r - 0.20, base + 1.55, C.z + 1.1, 0.95, 0.75, '-x');
      decalCard(B, CELL.weep, C.x, base + skirtH * 0.6, C.z + r + 0.20, r * 1.4, skirtH * 0.9, 'z');
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
        // ---- THE BUND WALL IS BUILT, NOT EXTRUDED --------------------------
        // MEASURED: this wall fills the lower-left third of hero3 and printed
        // as uniform high-frequency stipple - flat_area_pct read 1.2% because
        // noise is not flat, but there was ZERO structure above the texel
        // scale. No formwork board lines, no tie holes, no pour joints, no
        // coping drip, no differential weathering between pours.
        //
        // None of that can be bought in the wear mask, and that is the point
        // worth writing down: the mask is written PER VERTEX, and a 5 m wall
        // bay is one bevelled box with two vertices up its height, so any
        // function of y evaluated there is a gradient across 2.8 m and cannot
        // be a 1.2 m step. In-situ concrete gets its reading from the SHUTTER,
        // so the shutter is what is modelled - two courses of 2.5 m form panels
        // per bay standing 28 mm proud, the gaps between them reading as the
        // board lines and the pour joints, with the snap-tie plugs on the
        // panel lattice. That is 1.0k boxes and 1.3k plugs across 412 m of
        // wall, all in buckets that already exist, so it costs no draw call.
        var outer = (s === 0 || s === 1 || s === 2 || s === 3);
        for (var k = 0; k < n; k++) {
          var t = (k + 0.5) / n;
          var px = q[0] + dx * t, pz = q[1] + dz * t;
          var by = siteGrade(px, pz, N);
          var bayL = len / n;
          B.boxR('wall', wt, T.bh + 0.9, bayL + 0.02, px, by + (T.bh - 0.9) * 0.5, pz,
            0, yaw, 0, 0.02);
          // coping, with a drip nose under its overhang - the single strongest
          // horizontal shadow line a retaining wall has, and the thing that
          // stops the top edge reading as a sawn face
          B.paint = 'kerb';
          B.boxR('kerb', wt + 0.14, 0.12, bayL + 0.02, px, by + T.bh + 0.06, pz,
            0, yaw, 0, 0.012);
          B.paint = 'wall';
          // local frame: +X is the OUTER face on every one of the four runs
          // (the segment list winds anticlockwise), +Z runs along the wall
          B.pushXYZ(px, by, pz, 0, yaw, 0);
          B.boxR('kerb', 0.05, 0.05, bayL + 0.02, wt * 0.5 + 0.045, T.bh - 0.06, 0,
            0, 0, 0, 0.008);
          var fX = wt * 0.5;
          for (var fs = 0; fs < 2; fs++) {
            var sgnF = fs ? 1 : -1;
            for (var pr = 0; pr < 2; pr++) {
              var pyc = 0.46 + pr * 0.94;
              for (var pc = 0; pc < 2; pc++) {
                var pzc = (pc - 0.5) * bayL * 0.5;
                B.box('wall', 0.028, 0.88, bayL * 0.5 - 0.055,
                  sgnF * (fX + 0.014), pyc, pzc, 0.005);
              }
            }
            // the snap-tie plugs, on the panel lattice rather than scattered:
            // a form tie goes through at the panel joint, always
            for (var th = 0; th < 3; th++) {
              for (var tv = 0; tv < 2; tv++) {
                B.cyl('wall', 0.048, 0.048, 0.026,
                  sgnF * (fX + 0.036), 0.34 + tv * 1.06,
                  (th - 1) * bayL * 0.33, 0, 0, Math.PI * 0.5, 6);
              }
            }
          }
          // weeping off the coping on the outer face, where the run-off from
          // the top actually goes. Sourced at the drip nose, never scattered.
          if (outer && (k % 2 === 0)) {
            B.paint = 'flat';
            var wuv = atlasUV(CELL.weep);
            var wpw = 0.30 + ((k * 7 + s * 3) % 5) * 0.10;
            B.add('decal', quad(wpw, T.bh * 0.82, wuv[0], wuv[1], wuv[2], wuv[3]),
              makeM(fX + 0.055, T.bh * 0.44, (((k * 5 + s) % 7) - 3) * bayL * 0.13,
                0, Math.PI * 0.5, 0));
            B.paint = 'wall';
          }
          B.pop();
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
        // The weld seam. It stood 12 mm proud and was 35 mm deep, which is a
        // quarter of a pixel at the 47 m hero3 puts T1 at - so a 29 m cylinder
        // had no scale on it whatever. A real butt weld on a 20 mm plate has a
        // proud cap and a wide heat-affected band that takes paint differently;
        // 45 mm proud and 90 mm deep is still under-scale and it reads.
        B.paint = 'seam';
        B.cyl('tank', rr + 0.045, rr + 0.045, 0.090, T.x, y0 + 0.02, T.z, 0, 0, 0, seg, true);
        // ---- VERTICAL BUTT WELDS -------------------------------------------
        // A tank shell is rolled plate, and the thing that tells you so is the
        // grid: a horizontal seam every course AND a vertical seam every plate
        // width, staggered course to course so two verticals never line up
        // across a horizontal (they are not allowed to - it is a crack path).
        // Without them the shell has one axis of scale and reads as an extruded
        // tube. Eight per course on a 14.5 m radius is a 11.4 m plate, which is
        // what a mill rolls; the stagger is half a plate on alternate courses.
        var nvw = Math.max(6, Math.round(2 * Math.PI * T.r / 11.0));
        for (var vw = 0; vw < nvw; vw++) {
          var vwa = (vw + (c2 % 2) * 0.5) / nvw * Math.PI * 2 + i * 0.37;
          B.boxR('tank', 0.10, (y1 - y0) - 0.14, 0.075,
            T.x + Math.cos(vwa) * (rr + 0.030), (y0 + y1) * 0.5,
            T.z + Math.sin(vwa) * (rr + 0.030), 0, -(vwa + Math.PI * 0.5), 0, 0.010);
        }
        B.paint = 'tank';
      }
      // ---- NOZZLE BOSSES ON THE SHELL --------------------------------------
      // Reinforcing pads and blanked stubs round the bottom two courses - the
      // drain, the water draw-off, the mixer nozzles and the spare. They are
      // the only thing at eye height on 45 m of curved plate, and hero3 puts
      // T2's shell 30 m from the lens.
      B.paint = 'steel';
      for (var nzb = 0; nzb < 7; nzb++) {
        var nza = T.stair + 2.1 + nzb * 0.62 + rng.range(-0.10, 0.10);
        var nzy = floorY + (nzb % 3) * 1.55 + 1.20;
        var nzr = 0.16 + (nzb % 3) * 0.07;
        var nex = Math.cos(nza), nez = Math.sin(nza);
        B.paint = 'tank';
        B.cyl('tank', nzr * 2.4, nzr * 2.4, 0.05, T.x + nex * (T.r + 0.02), nzy,
          T.z + nez * (T.r + 0.02), Math.PI * 0.5, -nza + Math.PI * 0.5, 0, 10);
        B.paint = 'steel';
        B.tube('pipe', T.x + nex * T.r * 0.99, nzy, T.z + nez * T.r * 0.99,
          T.x + nex * (T.r + 0.40), nzy, T.z + nez * (T.r + 0.40), nzr, 8);
        B.cyl('struct', nzr * 1.8, nzr * 1.8, 0.06, T.x + nex * (T.r + 0.43), nzy,
          T.z + nez * (T.r + 0.43), Math.PI * 0.5, -nza + Math.PI * 0.5, 0, 12);
        for (var nzo = 0; nzo < 6; nzo++) {
          var nzoa = nzo / 6 * Math.PI * 2;
          B.cyl('struct', 0.021, 0.021, 0.09,
            T.x + nex * (T.r + 0.47) + (-nez) * Math.cos(nzoa) * nzr * 1.42,
            nzy + Math.sin(nzoa) * nzr * 1.42,
            T.z + nez * (T.r + 0.47) + nex * Math.cos(nzoa) * nzr * 1.42,
            Math.PI * 0.5, -nza + Math.PI * 0.5, 0, 5);
        }
      }
      B.paint = 'tank';
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

      // ---- WARM MARKS IN A COLD PLACE -------------------------------------
      // hero3 is the level's cold frame by design - mercury floods on grey
      // plate against a twilight band - and it measured 47.6% cool against
      // 26.8% warm with no fire anywhere in it. The flare genuinely cannot be
      // framed from here (see the hero3 note in _buildSpawns), so the warm half
      // is carried by the things a tank farm really has lit: a sodium bulkhead
      // over the stepover stair, and the red obstruction lights every large
      // tank carries on its roof rim. Emissive only - no practical is spent -
      // and both sit inside the framing rather than being scattered.
      B.paint = 'paint';
      B.box('clad', 0.30, 0.34, 0.42, T.bx1 + 0.16, siteGrade(T.bx1, soZ, N) + T.bh + 2.05,
        soZ - 1.35, 0.014);
      B.paint = 'flat';
      B.box('lamp_w', 0.06, 0.20, 0.30, T.bx1 + 0.33,
        siteGrade(T.bx1, soZ, N) + T.bh + 2.00, soZ - 1.35, 0.005);
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 2.15, T.bx1 + 0.16,
        siteGrade(T.bx1, soZ, N) + T.bh + 1.05, soZ - 1.35, 0, 0, 0, 6);
      B.paint = 'flat';
      for (var ob = 0; ob < 3; ob++) {
        var oba = T.stair + 1.1 + ob * 2.09;
        B.cyl('lamp_r', 0.17, 0.17, 0.24,
          T.x + Math.cos(oba) * (T.r - 0.55), roofY + 0.55 + Math.abs(Math.cos(oba)) * 0.1,
          T.z + Math.sin(oba) * (T.r - 0.55), 0, 0, 0, 8);
      }
      B.paint = 'steel';

      // ---- markings -------------------------------------------------------------
      B.paint = 'flat';
      // MEASURED. The tank number was drawn at 0.75 x the RADIUS - a 10.9 m
      // stencil - and the weep streaks at 85% of the shell height, so hero3
      // came back with what looked like black brush strokes painted across the
      // tank. A real tank number is about 3 m and the streaks are narrow.
      // MEASURED AGAIN. Every card here was laid at T.r + 0.03 and oriented on
      // the world Z axis. On a 14.5 m cylinder a 3.4 m FLAT quad has 0.10 m of
      // sagitta, so its corners were 0.07 m inside the plate and the alpha test
      // clipped it to a lens - which is the "unresolved dark fragment on T2's
      // shell at 60% height" the review found. Cards now stand 0.16 m proud and
      // face along their own radius, so they clear the curvature and read as
      // paint on the tank they are actually on.
      var ma = T.stair - 1.9;
      decalCardYaw(B, CELL.tank, T.x + Math.cos(ma) * (T.r + 0.16), floorY + T.h * 0.62,
        T.z + Math.sin(ma) * (T.r + 0.16), 3.2, 3.2, Math.atan2(Math.cos(ma), Math.sin(ma)));
      decalCardYaw(B, CELL.flam, T.x + Math.cos(ma + 0.42) * (T.r + 0.16), floorY + 2.4,
        T.z + Math.sin(ma + 0.42) * (T.r + 0.16), 1.4, 1.4,
        Math.atan2(Math.cos(ma + 0.42), Math.sin(ma + 0.42)));
      // Run-off streaks. Sourced, not scattered: they start AT a course seam or
      // AT the roof coping and run down from it, because that is the only place
      // rust on a tank ever starts.
      for (var wpe = 0; wpe < 14; wpe++) {
        var wa2 = rng.range(0, Math.PI * 2);
        var wCourse = rng.int(1, nc - 1);
        var wTop = floorY + T.h * (wCourse / nc);
        var wLen = rng.range(1.4, 3.6);
        decalCardYaw(B, CELL.weep, T.x + Math.cos(wa2) * (T.r + 0.14),
          wTop - wLen * 0.5,
          T.z + Math.sin(wa2) * (T.r + 0.14), rng.range(0.45, 1.15), wLen,
          Math.atan2(Math.cos(wa2), Math.sin(wa2)));
      }
      // and the long ones off the roof rim, which are the tallest marks on the
      // shell and the thing that tells you which way is up on a 29 m cylinder
      for (var wr2 = 0; wr2 < 6; wr2++) {
        var wa3 = T.stair + 0.6 + wr2 * 1.02 + rng.range(-0.16, 0.16);
        decalCardYaw(B, CELL.weep, T.x + Math.cos(wa3) * (T.r + 0.14),
          floorY + T.h - 2.4 - rng.range(0, 1.2),
          T.z + Math.sin(wa3) * (T.r + 0.14), rng.range(0.5, 1.0), rng.range(4.0, 7.0),
          Math.atan2(Math.cos(wa3), Math.sin(wa3)));
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
    // ---- MEMBER SIZE, MEASURED FOUR TIMES NOW --------------------------------
    // 0.075 m: a third of a pixel at the 110 m the signature mark stands off,
    //          and the lattice did not resolve at all.
    // 0.110 m: resolved, but sat within a few per cent of the horizon haze.
    // 0.460 m: two pixels, and STILL invisible in the delivered frame - because
    //          the level's own halo and its own volumetric cone were sitting on
    //          top of it (both now cut) and because the panels alternated pale
    //          against pale.
    // 0.700 m: three pixels of CHORD, which is what a 52 m derrick carrying a
    //          58 m stack really has, and enough to hold a hard band edge
    //          through 110 m of haze.
    //
    // ---- BANDING -------------------------------------------------------------
    // Painted pale first, then dark, and both failed the same way: each bet the
    // whole reading on what happened to be BEHIND it, and at this range the
    // background is whatever the sky is doing that frame. The alternation is
    // now DARK COOL GALVANISED against HOT ORANGE. Both tints multiply the same
    // 0xa8a49a base, so one band lands near 0x37393f and its neighbour near
    // 0xa8461a: 3.1:1 in value and 55 degrees of hue INSIDE the object. That
    // reads against bright haze, against dark sky and against the plume.
    var ORANGE = new THREE.Color(1.00, 0.42, 0.15);
    var GALV = new THREE.Color(0.33, 0.35, 0.41);
    B.paint = 'paint';
    for (i = 0; i < legs; i++) {
      for (p = 0; p < panels; p++) {
        var t0 = p / panels, t1 = (p + 1) / panels;
        var A = legPos(i, t0), Bp = legPos(i, t1);
        var C2 = legPos((i + 1) % legs, t0), D = legPos((i + 1) % legs, t1);
        // aviation banding: alternate panels galvanised and international orange
        B.tint = (p % 2) ? ORANGE : GALV;
        // the chord
        B.strut('derrick', A[0], A[1], A[2], Bp[0], Bp[1], Bp[2], 0.70, 0.70);
        // horizontal at each node, and a K-brace in the panel
        B.strut('derrick', A[0], A[1], A[2], C2[0], C2[1], C2[2], 0.34, 0.34);
        var mx = (A[0] + Bp[0]) * 0.5, my = (A[1] + Bp[1]) * 0.5, mz = (A[2] + Bp[2]) * 0.5;
        B.strut('derrick', C2[0], C2[1], C2[2], mx, my, mz, 0.26, 0.26);
        B.strut('derrick', mx, my, mz, D[0], D[1], D[2], 0.26, 0.26);
        // a secondary horizontal at mid-panel: it doubles the rung count on the
        // silhouette, which is what makes a lattice read as a lattice
        var mC = legPos((i + 1) % legs, (t0 + t1) * 0.5);
        B.strut('derrick', mx, my, mz, mC[0], mC[1], mC[2], 0.22, 0.22);
        if (p === panels - 1) {
          B.strut('derrick', Bp[0], Bp[1], Bp[2], D[0], D[1], D[2], 0.34, 0.34);
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
    // AVIATION OBSTRUCTION LIGHTS. There were ten of them at 0.20 m radius,
    // which at the 110 m the hero1 mark stands off is four tenths of a pixel -
    // they were paid for and never seen. Twenty-one at 0.44 m are two pixels
    // each and the bloom carries them to six or seven, so the eye can trace a
    // dotted red line all the way up the shaft even where the lattice itself
    // dissolves into the haze. This is the cheapest legibility a 47 m mast has.
    B.paint = 'flat';
    for (i = 0; i < 7; i++) {
      var oy = base + 6.5 + i * 6.2;
      var orr = M.lerp(FL_LEG, 1.30, (oy - base - 0.6) / (FL_DERRICK - 0.6)) * 0.95;
      for (k = 0; k < 3; k++) {
        var oa = k / 3 * Math.PI * 2 + 0.52;
        B.cyl('lamp_r', 0.44, 0.44, 0.34,
          FL_X + Math.cos(oa) * orr, oy, FL_Z + Math.sin(oa) * orr, 0, 0, 0, 8);
      }
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
    // REBUILT. There were ten full-width gratings laid across the hall at 1.4 m
    // centres, which is not how a pump house drains and which photographed as a
    // ladder of RAILWAY SLEEPERS running the whole length of the only interior
    // in the level. A pump hall has two longitudinal channels, one each side of
    // the skid line, falling to a sump - so that is what it has now: two runs
    // of recessed channel with a grating over them, broken by a solid lid every
    // few metres where a pump's baseplate crosses.
    // ---- THE SLAB IS NOT ONE BOX, AND THAT WAS THE BUG ---------------------
    // MEASURED. The floor of the only interior framing in the level is its
    // largest surface - it carries the bottom half of the frame - and it was a
    // single 22 x 15 m bevelled box. The wear mask is written PER VERTEX, so all
    // of _paint's grime, wet and burnish authoring for 330 square metres was
    // being evaluated at FOUR corners and bilinearly smeared between them. The
    // frame that came back has a featureless pale wash across its whole bottom
    // third, and no amount of work in the paint function could ever have fixed
    // it: there were no vertices to write to.
    //
    // A 1.15 m grid is 380 quads and ~0.8k triangles in a bucket that is already
    // drawn, and it gives the wear pass a vertex every metre - which is the
    // scale a bay joint, a machine-base grout stain and the polished walking line
    // between the door and the pump row actually work at.
    B.paint = 'pave';
    B.box('pave', w, 0.30, d, cx, floorY - 0.16, cz, 0.01);
    B.add('pave', gridSurface(PH_X0, PH_X1, PH_Z0, PH_Z1, 1.15,
      function () { return floorY; }, null));
    // saw-cut bay joints in the slab, on the same 5 m module as the apron
    B.paint = 'joint';
    (function () {
      var uvj = atlasUV(CELL.tape);
      for (var jx = PH_X0 + 4.4; jx < PH_X1 - 1.0; jx += 4.4) {
        B.add('joint', quad(0.05, d - 0.5, uvj[0], uvj[1], uvj[2], uvj[3]),
          makeM(jx, floorY + 0.008, cz, -Math.PI * 0.5, 0, 0));
      }
      B.add('joint', quad(0.05, w - 0.5, uvj[0], uvj[1], uvj[2], uvj[3]),
        makeM(cx, floorY + 0.008, PH_Z0 + 3.6, -Math.PI * 0.5, Math.PI * 0.5, 0));
    })();
    B.paint = 'steel';
    for (var ch2 = 0; ch2 < 2; ch2++) {
      var chz = cz + (ch2 ? 1.35 : -4.15);
      var nSeg = 14;
      for (i = 0; i < nSeg; i++) {
        var sx3 = PH_X0 + 1.0 + (w - 2.0) * ((i + 0.5) / nSeg);
        var slen = (w - 2.0) / nSeg;
        if (i % 5 === 3) {
          B.paint = 'steel';
          B.box('struct', slen - 0.05, 0.035, 0.60, sx3, floorY + 0.020, chz, 0.006);
        } else {
          B.box('grate', slen - 0.05, 0.030, 0.52, sx3, floorY + 0.012, chz, 0.005);
        }
      }
      // the kerbs of the channel, which is what makes it read as recessed
      B.box('struct', w - 2.0, 0.055, 0.075, cx, floorY + 0.022, chz - 0.30, 0.008);
      B.box('struct', w - 2.0, 0.055, 0.075, cx, floorY + 0.022, chz + 0.30, 0.008);
    }
    // the sump at the low end
    B.box('grate', 0.80, 0.030, 0.80, PH_X0 + 1.4, floorY + 0.012, cz - 4.15, 0.005);

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
    // ---- TRANSLUCENT ROOF LIGHTS -----------------------------------------------
    // The comment above this line has promised these since the first pass and
    // they were never built, and their absence is most of why the hall measured
    // vertical_imbalance 0.653: the ceiling sat at 0.168 while the floor sat at
    // 0.81, so the brightest surface in the room was the floor and it read as a
    // lightbox. Six GRP sheets let into the deck are 17 square metres of lit
    // surface in the TOP half of the framing, they cost nothing against the
    // practical cap because they are emissive geometry, and they are what a
    // 1970s steel-framed pump hall actually has. They carry the dusk sky, so
    // they are the cold end of the hall's warm/cold split.
    var slopeY = function (pz3) {
      return floorY + PH_EAVE + (PH_RIDGE - PH_EAVE) * (1 - Math.abs(pz3 - cz) / (d * 0.5));
    };
    for (k = 0; k < 4; k++) {
      var rlx = PH_X0 + 3.0 + k * ((w - 6.0) / 3);
      for (var sside = 0; sside < 2; sside++) {
        var rlz = cz + (sside ? 1 : -1) * d * 0.26;
        // 75 mm UNDER the deck's own centre plane: the deck is a 100 mm slab,
        // and a panel sitting on top of it is a panel the interior cannot see.
        var rly = slopeY(rlz) - 0.075;
        var rSlope = (sside ? -1 : 1) * slope;
        B.paint = 'flat';
        B.boxR('lamp_sky', 2.30, 0.045, 1.35, rlx, rly, rlz, rSlope, 0, 0, 0.006);
        B.paint = 'steel';
        // the kerb frame and the two glazing bars that stop it being a slab
        B.boxR('struct', 2.52, 0.10, 0.10, rlx, rly - 0.03, rlz - 0.70, rSlope, 0, 0, 0.008);
        B.boxR('struct', 2.52, 0.10, 0.10, rlx, rly - 0.03, rlz + 0.70, rSlope, 0, 0, 0.008);
        B.boxR('struct', 0.09, 0.09, 1.45, rlx - 0.78, rly - 0.04, rlz, rSlope, 0, 0, 0.008);
        B.boxR('struct', 0.09, 0.09, 1.45, rlx + 0.78, rly - 0.04, rlz, rSlope, 0, 0, 0.008);
      }
    }
    // the ridge vent, glowing along its throat
    B.paint = 'steel';
    B.box('struct', w + 0.6, 0.16, 0.55, cx, floorY + PH_RIDGE + 0.20, cz, 0.01);
    B.paint = 'flat';
    B.box('lamp_sky', w - 2.0, 0.035, 0.16, cx, floorY + PH_RIDGE + 0.05, cz, 0.005);
    B.paint = 'steel';

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
    // MCC / switchgear line on the south wall.
    // The RED INDICATOR BANK is the point. The interior framing had no
    // saturated chroma in it at all - 0.211 saturation against hero1's 0.497 -
    // and a motor control centre is the one object in a plant that is covered
    // in coloured tell-tales. Nine cubicles each carry a run/trip pair and a
    // trip-circuit-healthy lamp: emissive faces only, so they cost nothing
    // against lighting.js's practical cap and the bloom picks them up as
    // sources. This is also the only red in the level that is not fire.
    B.paint = 'paint';
    for (i = 0; i < 9; i++) {
      var mx = PH_X0 + 2.2 + i * 1.30;
      B.box('clad', 1.22, 2.15, 0.62, mx, floorY + 1.08, PH_Z1 - 0.55, 0.014);
      B.paint = 'steel';
      B.box('struct', 1.22, 0.08, 0.66, mx, floorY + 2.19, PH_Z1 - 0.55, 0.008);
      // the cubicle door: a handle, a hinge line and the isolator
      B.box('struct', 0.05, 1.85, 0.05, mx - 0.52, floorY + 1.10, PH_Z1 - 0.87, 0.006);
      B.cyl('struct', 0.05, 0.05, 0.16, mx + 0.44, floorY + 1.35, PH_Z1 - 0.92,
        0, 0, Math.PI * 0.5, 8);
      B.box('rail', 0.16, 0.16, 0.09, mx + 0.44, floorY + 1.72, PH_Z1 - 0.90, 0.01);
      B.paint = 'flat';
      // run / trip / healthy. The pattern varies per cubicle so nine of them do
      // not read as one stamp repeated.
      var lit = i % 3;
      B.cyl(lit === 0 ? 'lamp_r' : 'lamp_c', 0.036, 0.036, 0.05,
        mx - 0.26, floorY + 1.92, PH_Z1 - 0.87, Math.PI * 0.5, 0, 0, 8);
      B.cyl(lit === 1 ? 'lamp_c' : 'lamp_r', 0.036, 0.036, 0.05,
        mx - 0.06, floorY + 1.92, PH_Z1 - 0.87, Math.PI * 0.5, 0, 0, 8);
      B.cyl('lamp_w', 0.030, 0.030, 0.05,
        mx + 0.14, floorY + 1.92, PH_Z1 - 0.87, Math.PI * 0.5, 0, 0, 8);
      decalCard(B, CELL.plate, mx, floorY + 1.55, PH_Z1 - 0.88, 0.42, 0.32, '-z');
      B.paint = 'paint';
    }
    // the annunciator panel at the head of the row - a bank of red windows,
    // the strongest single chroma accent in the hall
    B.paint = 'paint';
    B.box('clad', 1.30, 0.85, 0.30, PH_X0 + 1.5, floorY + 2.55, PH_Z1 - 0.72, 0.014);
    B.paint = 'flat';
    for (i = 0; i < 8; i++) {
      B.box(i === 2 || i === 5 ? 'lamp_r' : 'lamp_w', 0.26, 0.14, 0.03,
        PH_X0 + 1.5 - 0.42 + (i % 4) * 0.28, floorY + 2.74 - Math.floor(i / 4) * 0.24,
        PH_Z1 - 0.88, 0.004);
    }
    B.paint = 'paint';
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
    // A bulkhead fitting over the west door. The far gable is the vanishing
    // point of the `interior` framing and it was unlit dead centre - which is
    // where the frame's dead cells were. Emissive only: no practical is spent
    // and the bloom does the rest.
    B.paint = 'paint';
    B.box('clad', 0.16, 0.26, 0.42, PH_X0 + 0.20, floorY + 2.45, cz, 0.012);
    B.paint = 'flat';
    B.box('lamp_w', 0.05, 0.17, 0.32, PH_X0 + 0.30, floorY + 2.43, cz, 0.005);
    B.paint = 'steel';
    B.cyl('struct', 0.014, 0.014, 0.55, PH_X0 + 0.14, floorY + 2.86, cz, 0, 0, 0, 5);

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
    // TWO lists, and the order they are concatenated in is load-bearing:
    // lighting.js takes the first MAX_WINDOWS_RIG (20) entries and drops the
    // rest, and this building now publishes 27. The SOUTH elevation is the one
    // the establishing frame sees, so it goes first and the west - which is
    // edge-on from every published pose - takes whatever is left.
    var wins = [], winsW = [];
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
      B.box('struct', 0.12, 1.55, 0.075, CB_X0 - 0.20, base + 5.6, wz, 0.006);
      winsW.push({ x: CB_X0 - 0.30, y: base + 5.6, z: wz, w: 2.05, h: 1.55,
                  kelvin: (i === 3) ? 3100 : 4200,
                  gain: (i === 1 || i === 4) ? 0.07 : (i === 3 ? 0.44 : 0.86),
                  yaw: Math.PI * 0.5, scale: 1.9 });
    }
    // ground-floor slit windows and the entrance
    for (i = 0; i < 4; i++) {
      var sz = CB_Z0 + 2.6 + i * ((d - 5.2) / 3);
      B.paint = 'glass';
      B.box('glass', 0.06, 0.95, 1.35, CB_X0 - 0.16, base + 2.5, sz, 0.004);
      B.paint = 'steel';
      B.box('struct', 0.16, 1.10, 0.12, CB_X0 - 0.19, base + 2.5, sz - 0.72, 0.008);
      B.box('struct', 0.16, 1.10, 0.12, CB_X0 - 0.19, base + 2.5, sz + 0.72, 0.008);
      winsW.push({ x: CB_X0 - 0.30, y: base + 2.5, z: sz, w: 1.35, h: 0.95,
                  kelvin: 4000, gain: 0.55, yaw: Math.PI * 0.5, scale: 1.6 });
    }
    // ---- glazing on the SOUTH elevation --------------------------------------
    // The overview stands south of the site, so the west glazing above is edge
    // on to it and the elevation it actually sees is this one. Lit windows cost
    // nothing from the 24-practical budget - lighting.js draws them as additive
    // cards off level.litWindows - which is exactly why they are the right tool
    // for a face that needs to READ lit without needing to LIGHT anything.
    // MEASURED: five identical blown-white rectangles with an identical smaller
    // one under each, evenly spaced, no mullions - a repeated stamp, and the
    // only building in the establishing frame. Real glazing has a mullion at
    // mid-pane, a blind pulled down over some of it, one room lit warm because
    // somebody left a desk lamp on, and one or two bays dark because nobody is
    // in them. That is five cheap boxes and a per-instance gain.
    var CB_WIN = [
      { gain: 0.90, k: 4200, blind: 0.00 },
      { gain: 0.05, k: 3600, blind: 0.72 },   // dark: blind down, room empty
      { gain: 0.78, k: 4300, blind: 0.30 },
      { gain: 0.46, k: 3100, blind: 0.00 },   // warm: the shift supervisor
      { gain: 0.08, k: 4000, blind: 0.55 }    // dark
    ];
    for (i = 0; i < 5; i++) {
      var qx = CB_X0 + 2.4 + i * ((w - 4.8) / 4);
      var cw2 = CB_WIN[i];
      B.paint = 'glass';
      B.box('glass', 2.30, 1.55, 0.06, qx, base + 5.6, CB_Z1 + 0.16, 0.004);
      B.paint = 'steel';
      B.box('struct', 0.13, 1.75, 0.14, qx - 1.22, base + 5.6, CB_Z1 + 0.18, 0.008);
      B.box('struct', 0.13, 1.75, 0.14, qx + 1.22, base + 5.6, CB_Z1 + 0.18, 0.008);
      B.box('struct', 2.7, 0.16, 0.16, qx, base + 6.50, CB_Z1 + 0.18, 0.008);
      // ---- THE 2 x 2 AND ITS TRANSOM -----------------------------------------
      // MEASURED: at overview range these printed as rounded-rectangle cream
      // blobs with the bloom fusing adjacent panes into single shapes, so the
      // per-pane value variation that _paint computes was doing nothing - there
      // were no pane boundaries left for it to reveal. A window reads as a
      // window because of the DARK LINES in it, and 60 mm of mullion cross is
      // 0.6 px at 60 m only if it is the same value as the glass; against a
      // pane at 1.0 it is a hard black notch that bloom cannot close.
      B.box('struct', 0.060, 1.55, 0.13, qx, base + 5.6, CB_Z1 + 0.21, 0.005);
      B.box('struct', 2.30, 0.060, 0.13, qx, base + 5.6, CB_Z1 + 0.21, 0.005);
      // the transom running the whole elevation, which is what ties five bays
      // into one building instead of five stickers
      B.box('struct', 2.62, 0.10, 0.15, qx, base + 4.78, CB_Z1 + 0.19, 0.008);
      // ---- WHAT IS INSIDE THE ROOM -------------------------------------------
      // Three dark rectangles behind the brightest panes: a desk return, a
      // cabinet run and a console. At overview range that is the whole
      // difference between a lit room and a light box, and it costs six boxes.
      if (cw2.gain > 0.30) {
        B.paint = 'paint';
        B.box('clad', 1.05, 0.44, 0.30, qx - 0.55, base + 5.16, CB_Z1 - 0.34, 0.012);
        B.box('clad', 0.46, 1.02, 0.34, qx + 0.72, base + 5.52, CB_Z1 - 0.42, 0.012);
        B.box('clad', 0.30, 0.66, 0.26, qx + 0.02, base + 5.36, CB_Z1 - 0.55, 0.012);
        B.paint = 'steel';
      }
      // the venetian blind, half down in three of the five bays
      if (cw2.blind > 0.01) {
        B.paint = 'paint';
        B.box('clad', 2.20, 1.55 * cw2.blind, 0.05, qx,
          base + 5.6 + 1.55 * 0.5 - 1.55 * cw2.blind * 0.5, CB_Z1 + 0.10, 0.004);
        B.paint = 'steel';
      }
      // ---- THE GLOW CARD IS SPLIT WITH THE PANE ------------------------------
      // MEASURED: the mullion boxes above are real geometry and they read
      // perfectly on the DARK bays - and not at all on the lit ones, because
      // lighting.js draws a lit window as an ADDITIVE card over the top of
      // everything and a 2.30 m pane at scale 1.9 is a 4.4 m soft blob. No
      // amount of mullion behind an additive blob can be seen through it. The
      // cross therefore has to exist in the CARD, so a lit bay publishes four
      // quarter-cards with the mullion gap between them instead of one. At
      // overview range that is the whole difference between a lit room and a
      // light box, and it costs instances in a mesh that is already drawn.
      //
      // A dark bay still publishes one card at its own low gain: four cards
      // that add up to nothing are four wasted slots against
      // MAX_WINDOWS_RIG, and this file already publishes close to the cap.
      var wh2 = 1.55 * (1 - cw2.blind);
      var wy2 = base + 5.6 - 1.55 * cw2.blind * 0.5;
      if (cw2.gain > 0.30) {
        for (var qq = 0; qq < 4; qq++) {
          wins.push({
            x: qx + ((qq & 1) ? 1 : -1) * (2.30 * 0.25 + 0.035),
            y: wy2 + ((qq & 2) ? 1 : -1) * (wh2 * 0.25 + 0.035),
            z: CB_Z1 + 0.30, w: 2.30 * 0.5 - 0.10, h: wh2 * 0.5 - 0.10,
            kelvin: cw2.k, gain: cw2.gain * 0.86, yaw: 0, scale: 1.30 });
        }
      } else {
        wins.push({ x: qx, y: wy2, z: CB_Z1 + 0.30, w: 2.30, h: wh2,
                    kelvin: cw2.k, gain: cw2.gain, yaw: 0, scale: 1.9 });
      }
      if (i % 2 === 0) {
        B.paint = 'glass';
        B.box('glass', 1.35, 0.95, 0.06, qx, base + 2.5, CB_Z1 + 0.16, 0.004);
        B.paint = 'steel';
        B.box('struct', 0.075, 0.95, 0.12, qx, base + 2.5, CB_Z1 + 0.20, 0.006);
        wins.push({ x: qx, y: base + 2.5, z: CB_Z1 + 0.30, w: 1.35, h: 0.95,
                    kelvin: i === 2 ? 3200 : 4000, gain: i === 2 ? 0.20 : 0.55,
                    yaw: 0, scale: 1.6 });
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
      windows: wins.concat(winsW)
    };
  }

  // ============================================================= THE ENTRANCE ==
  // MEASURED, AND IT IS THE SINGLE WORST NUMBER IN THE LEVEL. On lv_overview -
  // the ESTABLISHING frame, the one a reviewer sees first - the bottom third
  // measures a median luminance of 0.043 with 59.7% of its pixels below 0.05
  // and 72.1% below 0.10, and the bottom row of an 8x8 grid reads 0.033 to
  // 0.044 in all eight cells. Fifteen of sixty-four cell medians are under
  // 0.05. A quarter of the level's first impression is a black void.
  //
  // AND IT IS NOT AN EMPTY-CONTENT FAILURE. props_refinery already stands two
  // shipping containers, two skips and a contractor's compound in exactly that
  // band (z 46-55), and they measure 0.034-0.16 - they are there and they
  // cannot be seen. The site runs z -94..76 and carries four road masts at
  // z = -52, -20, +12 and +44: the southern THIRTY METRES of it, which is the
  // whole gate approach and everything the establishing frame stands on, has no
  // fixture of any kind. Every other framing is lit because every other framing
  // is north of z = 46.
  //
  // So this is two things at once, and neither works without the other:
  //
  //   1. A REASON FOR THE GROUND TO BE LIT. A refinery gate is the most
  //      brightly lit place on the site, because everything that enters is
  //      weighed, checked and signed for in the dark. The practical that pays
  //      for it is re-allocated, not added - see rf_gate in _buildLamps.
  //
  //   2. SOMETHING FOR THE LIGHT TO LAND ON. From thirty metres up at a 27-45
  //      degree depression the eye reads ROOFS, MASTS and PAINT, not elevations,
  //      so the content here is chosen for that view: a weighbridge deck (a hard
  //      bright rectangle let into the slab), a marked-out truck park (high-
  //      albedo paint on dark concrete is the most legible thing there is at a
  //      steep angle and low light), a kiosk and a canopy for roof silhouette,
  //      a raised boom for a diagonal, and perimeter lamp standards down the
  //      fence so the dark beyond the pool reads as a lit site rather than as
  //      the edge of the world.
  //
  // Everything below lands in buckets that already exist, so the whole entrance
  // costs ZERO draw calls.
  var EN_X0 = 10.6, EN_X1 = 54.0, EN_Z0 = 43.0, EN_Z1 = 75.0;
  var WB_X0 = 10.9, WB_X1 = 14.7, WB_Z0 = 52.0, WB_Z1 = 66.0;   // weighbridge deck
  var KIOSK = { x: 18.2, z: 58.6, w: 3.7, d: 3.3, h: 3.25 };
  var BOOM_Z = 70.5;

  function buildEntrance(L, B, rng, N) {
    var gy = function (x, z) { return groundY(x, z, N); };
    var i, k;

    // ---- 1. THE WEIGHBRIDGE ---------------------------------------------------
    // A 14 m pit-mounted deck on the east verge, kerbed all round, with a ramp
    // at each end. Steel chequer plate on concrete is the only high-value
    // rectangle on this whole apron and from above it is the thing that says
    // "this is a gate, not a car park".
    var wbCx = (WB_X0 + WB_X1) * 0.5, wbCz = (WB_Z0 + WB_Z1) * 0.5;
    var wbY = gy(wbCx, wbCz);
    B.paint = 'wall';
    // the pit walls, showing 0.34 m of in-situ concrete above the slab
    B.box('wall', 0.34, 0.80, WB_Z1 - WB_Z0 + 0.68, WB_X0 - 0.17, wbY - 0.10, wbCz, 0.02);
    B.box('wall', 0.34, 0.80, WB_Z1 - WB_Z0 + 0.68, WB_X1 + 0.17, wbY - 0.10, wbCz, 0.02);
    B.box('wall', WB_X1 - WB_X0 + 0.68, 0.80, 0.34, wbCx, wbY - 0.10, WB_Z0 - 0.17, 0.02);
    B.box('wall', WB_X1 - WB_X0 + 0.68, 0.80, 0.34, wbCx, wbY - 0.10, WB_Z1 + 0.17, 0.02);
    B.paint = 'kerb';
    B.box('kerb', 0.30, 0.10, WB_Z1 - WB_Z0 + 0.60, WB_X0 - 0.15, wbY + 0.10, wbCz, 0.012);
    B.box('kerb', 0.30, 0.10, WB_Z1 - WB_Z0 + 0.60, WB_X1 + 0.15, wbY + 0.10, wbCz, 0.012);
    // the deck: four weigh plates with a real expansion gap between them, so it
    // reads as a weighbridge rather than as a painted rectangle
    B.paint = 'steel';
    for (i = 0; i < 4; i++) {
      var pz = WB_Z0 + (WB_Z1 - WB_Z0) * ((i + 0.5) / 4);
      var pl = (WB_Z1 - WB_Z0) / 4 - 0.045;
      B.box('grate', WB_X1 - WB_X0 - 0.08, 0.045, pl, wbCx, wbY + 0.115, pz, 0.007);
      // the ribs under the plate, seen through the gap
      B.box('struct', WB_X1 - WB_X0 - 0.10, 0.16, 0.09, wbCx, wbY + 0.010, pz - pl * 0.5 - 0.02, 0.008);
      // load cell covers at the corners of every plate
      for (k = 0; k < 2; k++) {
        B.cyl('rust', 0.13, 0.13, 0.055,
          wbCx + (k ? 1 : -1) * (WB_X1 - WB_X0) * 0.36, wbY + 0.145, pz, 0, 0, 0, 8);
      }
    }
    // guide rails down both sides: 0.5 m posts and a horizontal, which is what
    // stops a driver putting a wheel off the deck and is a strong low horizontal
    for (i = 0; i < 2; i++) {
      var rx = i ? WB_X1 + 0.42 : WB_X0 - 0.42;
      B.paint = 'paint';
      for (k = 0; k <= 7; k++) {
        var rz = WB_Z0 - 0.4 + (WB_Z1 - WB_Z0 + 0.8) * (k / 7);
        B.cyl('rail', 0.055, 0.062, 0.62, rx, gy(rx, rz) + 0.31, rz, 0, 0, 0, 7);
      }
      B.tube('rail', rx, gy(rx, WB_Z0) + 0.56, WB_Z0 - 0.4,
        rx, gy(rx, WB_Z1) + 0.56, WB_Z1 + 0.4, 0.032, 6);
      B.paint = 'steel';
    }
    // the approach ramps, and their hazard-striped noses
    B.paint = 'kerb';
    for (i = 0; i < 2; i++) {
      var sgnR = i ? 1 : -1;
      var rz0 = i ? WB_Z1 + 0.35 : WB_Z0 - 0.35;
      for (k = 0; k < 3; k++) {
        var t = (k + 0.5) / 3;
        var rzz = rz0 + sgnR * t * 3.0;
        B.box('kerb', WB_X1 - WB_X0 + 0.3, 0.10 * (1 - t) + 0.02, 1.0,
          wbCx, gy(wbCx, rzz) + (0.10 * (1 - t)) * 0.5, rzz, 0.012);
      }
    }
    B.paint = 'flat';
    B.tint = new THREE.Color(0.60, 0.58, 0.82);
    groundStrip(B, CELL.hazard, WB_X0 - 0.02, WB_Z0 - 0.1, WB_X1 + 0.02, WB_Z0 - 0.1, 0.30,
      gy(wbCx, WB_Z0) + 0.015);
    groundStrip(B, CELL.hazard, WB_X0 - 0.02, WB_Z1 + 0.1, WB_X1 + 0.02, WB_Z1 + 0.1, 0.30,
      gy(wbCx, WB_Z1) + 0.015);
    B.tint = null;
    decalCard(B, CELL.unitno, wbCx, gy(wbCx, WB_Z0 - 2.6) + 0.016, WB_Z0 - 2.6,
      2.4, 2.4, 'y', 0);
    B.paint = 'steel';
    L.addCollider(wbCx, wbY - 0.2, wbCz, (WB_X1 - WB_X0) * 0.5 + 0.35, 0.42,
      (WB_Z1 - WB_Z0) * 0.5 + 0.35, 'metal', true);

    // ---- 2. THE KIOSK ---------------------------------------------------------
    // Blockwork below, glazed above, standing on its own 0.15 m plinth with a
    // lit interior. It is the only INHABITED thing at this end of the site and
    // the emissive panel behind its glass costs nothing against the practical
    // cap while reading as a lit room from every angle.
    var kx = KIOSK.x, kz = KIOSK.z, kw = KIOSK.w, kd = KIOSK.d, kh = KIOSK.h;
    var ky = gy(kx, kz);
    B.paint = 'wall';
    B.box('wall', kw + 0.7, 0.30, kd + 0.7, kx, ky + 0.05, kz, 0.02);
    B.paint = 'blockwork';
    B.box('wall', kw, 1.15, 0.22, kx, ky + 0.78, kz - kd * 0.5, 0.02);
    B.box('wall', kw, 1.15, 0.22, kx, ky + 0.78, kz + kd * 0.5, 0.02);
    B.box('wall', 0.22, 1.15, kd, kx - kw * 0.5, ky + 0.78, kz, 0.02);
    B.box('wall', 0.22, kh, kd, kx + kw * 0.5, ky + kh * 0.5 + 0.15, kz, 0.02);
    // the glazed band and its mullions, on the three faces that watch the deck
    B.paint = 'glass';
    B.box('glass', kw - 0.3, 1.35, 0.05, kx, ky + 2.06, kz - kd * 0.5 - 0.02, 0.004);
    B.box('glass', 0.05, 1.35, kd - 0.3, kx - kw * 0.5 - 0.02, ky + 2.06, kz, 0.004);
    B.box('glass', kw - 0.3, 1.35, 0.05, kx, ky + 2.06, kz + kd * 0.5 + 0.02, 0.004);
    B.paint = 'steel';
    for (i = 0; i < 3; i++) {
      B.box('struct', 0.06, 1.45, 0.10, kx - kw * 0.5 + 0.28 + i * (kw - 0.56) * 0.5,
        ky + 2.06, kz - kd * 0.5 - 0.05, 0.005);
    }
    B.box('struct', kw + 0.10, 0.11, 0.13, kx, ky + 1.36, kz - kd * 0.5 - 0.05, 0.008);
    // ---- WHAT IS INSIDE THE ROOM ---------------------------------------------
    // MEASURED on the first entrance capture: a single emissive box behind the
    // glazing printed as one flat cream rectangle with the mullions bloomed
    // shut - the same failure the control building's south elevation had and for
    // the same reason. A lit room reads as a lit room because of the DARK SHAPES
    // in it. The emissive panel is now a back wall only, set 0.35 m in, with a
    // desk return, a cabinet, a console and a chair back standing in front of it
    // and a blind pulled half down over the west light.
    B.paint = 'flat';
    B.box('lamp_w', kw - 0.9, 0.92, 0.10, kx, ky + 2.06, kz + kd * 0.5 - 0.42, 0.008);
    B.box('lamp_w', 0.10, 0.92, kd - 1.5, kx + kw * 0.5 - 0.40, ky + 2.06, kz, 0.008);
    B.paint = 'paint';
    B.box('clad', kw - 1.5, 0.14, 0.62, kx - 0.15, ky + 1.62, kz - kd * 0.5 + 0.62, 0.012);
    B.box('clad', 0.52, 1.05, 0.42, kx - kw * 0.5 + 0.52, ky + 1.98, kz + 0.3, 0.012);
    B.box('clad', 0.34, 0.52, 0.30, kx + 0.42, ky + 1.92, kz - kd * 0.5 + 0.72, 0.012);
    B.box('clad', 0.38, 0.44, 0.10, kx - 0.30, ky + 1.90, kz - 0.1, 0.010);
    // the blind, half down over the pane that faces the deck
    B.box('clad', kw - 0.42, 0.58, 0.04, kx, ky + 2.44, kz - kd * 0.5 - 0.06, 0.004);
    B.paint = 'steel';
    // a flat roof with a 120 mm upstand, a parapet drip and its air-con box
    B.paint = 'wall';
    B.box('wall', kw + 0.55, 0.22, kd + 0.55, kx, ky + kh + 0.30, kz, 0.02);
    B.paint = 'kerb';
    B.box('kerb', kw + 0.72, 0.09, kd + 0.72, kx, ky + kh + 0.45, kz, 0.012);
    B.paint = 'paint';
    B.box('clad', 0.85, 0.62, 0.70, kx + 0.6, ky + kh + 0.76, kz + 0.5, 0.02);
    B.paint = 'steel';
    B.cyl('struct', 0.035, 0.035, 1.35, kx - kw * 0.5 - 0.12, ky + kh + 1.05,
      kz - kd * 0.5 + 0.3, 0, 0, 0, 6);
    // the wall pack over the door, and the door itself
    B.paint = 'paint';
    B.box('clad', 0.26, 0.20, 0.34, kx - kw * 0.5 - 0.16, ky + 2.42, kz + kd * 0.5 - 0.9, 0.012);
    B.paint = 'flat';
    B.box('lamp_w', 0.06, 0.14, 0.26, kx - kw * 0.5 - 0.30, ky + 2.38, kz + kd * 0.5 - 0.9, 0.005);
    B.paint = 'shutter';
    B.box('clad', 0.05, 2.05, 0.92, kx - kw * 0.5 - 0.14, ky + 1.02, kz + kd * 0.5 - 0.9, 0.006);
    B.paint = 'flat';
    decalCard(B, CELL.danger, kx + kw * 0.5 + 0.13, ky + 1.55, kz, 0.95, 0.75, 'x');
    decalCard(B, CELL.nosmoke, kx, ky + 1.05, kz - kd * 0.5 - 0.13, 0.75, 0.75, '-z');
    B.paint = 'steel';
    L.addCollider(kx, ky + kh * 0.5, kz, kw * 0.5 + 0.2, kh * 0.5 + 0.3, kd * 0.5 + 0.2,
      'concrete');

    // ---- 3. THE BOOM BARRIER --------------------------------------------------
    // Two counterweighted booms across the carriageway, both RAISED - the road
    // has to stay walkable end to end - so each one is a 6 m hazard-striped
    // DIAGONAL standing 5 m up on the level's only piece of moving plant that
    // is not on fire. From the establishing mark they cross the road's leading
    // line at 60 degrees, which is the one line direction that frame lacked.
    for (i = 0; i < 2; i++) {
      var bSgn = i ? 1 : -1;
      var bx0 = bSgn * (ROAD_X1 + 0.9);
      var by0 = gy(bx0, BOOM_Z);
      B.paint = 'wall';
      B.box('wall', 0.72, 0.34, 0.72, bx0, by0 + 0.11, BOOM_Z, 0.02);
      B.paint = 'paint';
      B.box('clad', 0.44, 1.05, 0.40, bx0, by0 + 0.80, BOOM_Z, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.075, 0.075, 0.46, bx0, by0 + 1.42, BOOM_Z, 0, 0, Math.PI * 0.5, 8);
      // the boom, raised to 68 degrees, and its counterweight arm behind
      var bl = 6.4, ba = 1.19;
      var btx = bx0 - bSgn * Math.cos(ba) * bl, bty = by0 + 1.42 + Math.sin(ba) * bl;
      B.paint = 'paint';
      B.tube('rail', bx0, by0 + 1.42, BOOM_Z, btx, bty, BOOM_Z, 0.075, 7);
      B.paint = 'steel';
      B.tube('struct', bx0, by0 + 1.42, BOOM_Z,
        bx0 + bSgn * Math.cos(ba) * 1.5, by0 + 1.42 - Math.sin(ba) * 1.5, BOOM_Z, 0.055, 6);
      B.cyl('struct', 0.20, 0.20, 0.34,
        bx0 + bSgn * Math.cos(ba) * 1.5, by0 + 1.42 - Math.sin(ba) * 1.5, BOOM_Z,
        0, 0, Math.PI * 0.5, 10);
      // hazard sleeves up the boom: four short bands, which is what makes a
      // white pole read as a barrier at a hundred metres
      B.paint = 'flat';
      for (k = 0; k < 5; k++) {
        var bt = 0.12 + k * 0.19;
        decalCardYaw(B, CELL.hazard, bx0 - bSgn * Math.cos(ba) * bl * bt,
          by0 + 1.42 + Math.sin(ba) * bl * bt, BOOM_Z + 0.085, 0.62, 0.62, 0);
      }
      B.paint = 'steel';
      L.addCollider(bx0, by0 + 0.9, BOOM_Z, 0.30, 0.9, 0.30, 'metal');
    }
    // rumble strip across the carriageway at the gate: two hazard-striped
    // upstands, and the transverse joint they are set in
    B.paint = 'kerb';
    for (i = 0; i < 2; i++) {
      var rsz = BOOM_Z + 1.8 + i * 0.85;
      B.box('kerb', ROAD_X1 - ROAD_X0 - 0.4, 0.055, 0.34, ROAD_CX,
        gy(ROAD_CX, rsz) + 0.026, rsz, 0.008);
    }
    B.paint = 'steel';

    // ---- 4. THE TRUCK PARK ----------------------------------------------------
    // Six reversing bays marked out east of the road. Paint on dark concrete is
    // the highest-contrast, cheapest, most legible thing that exists at a steep
    // viewing angle in low light, and this apron had NO man-made grain on it at
    // all - which is why 1600 square metres of it measured 0.04.
    // Five bays, not six: the sixth ran to z = 71.6 and the drum-store canopy
    // stands at z = 68.4..73.6, so a canopy post would have landed on a painted
    // bay line. The row now stops 1.2 m clear of the canopy's eaves.
    var BAY_X0 = 25.5, BAY_X1 = 39.5, BAY_N = 5, BAY_P = 4.35, BAY_Z0 = 45.5;
    B.paint = 'flat';
    B.tint = new THREE.Color(0.86, 0.85, 0.80);
    for (i = 0; i <= BAY_N; i++) {
      var bz = BAY_Z0 + i * BAY_P;
      groundStrip(B, CELL.tape, BAY_X0, bz, BAY_X1, bz, 0.16,
        gy((BAY_X0 + BAY_X1) * 0.5, bz) + 0.014);
    }
    groundStrip(B, CELL.tape, BAY_X0 - 0.08, BAY_Z0, BAY_X0 - 0.08, BAY_Z0 + BAY_N * BAY_P,
      0.20, gy(BAY_X0, 56) + 0.014);
    B.tint = null;
    // bay numbers at the head of each bay, and the wheel-stop kerbs
    for (i = 0; i < BAY_N; i++) {
      var bcz = BAY_Z0 + (i + 0.5) * BAY_P;
      // MEASURED: five bays all stencilled from CELL.unitno printed the same two
      // glyphs five times in a row at 40 m, which is a repeated stamp - the one
      // thing a row of anything must not be. The atlas has three cells that read
      // as site stencilling; alternating them with a size and heading jitter
      // makes five bay heads five different marks for no cost.
      var bcell = [CELL.unitno, CELL.logo, CELL.plate][i % 3];
      var bs = 1.55 + (i % 2) * 0.42;
      decalCard(B, bcell, BAY_X0 + 2.1 + rng.range(-0.25, 0.25),
        gy(BAY_X0 + 2.1, bcz) + 0.015, bcz + rng.range(-0.2, 0.2),
        bs, bs, 'y', Math.PI * 0.5 + rng.range(-0.05, 0.05));
      B.paint = 'kerb';
      B.box('kerb', 0.30, 0.14, 2.5, BAY_X1 - 0.5, gy(BAY_X1 - 0.5, bcz) + 0.06, bcz, 0.02);
      B.paint = 'flat';
    }
    // and the no-parking hatch across the head of the row, dulled like the
    // junction box for exactly the same measured reason
    B.tint = new THREE.Color(0.58, 0.56, 0.80);
    (function () {
      var hz0 = BAY_Z0 - 0.5, hz1 = BAY_Z0 + BAY_N * BAY_P + 0.5;
      var hx0 = BAY_X0 - 5.2, hx1 = BAY_X0 - 0.9;
      var cLo = hx0 - hz1, cHi = hx1 - hz0, dC = 1.7 * Math.SQRT2;
      for (var hc = cLo + dC * 0.5; hc < cHi; hc += dC) {
        var za = Math.max(hz0, hx0 - hc), zb = Math.min(hz1, hx1 - hc);
        if (zb - za < 0.35) continue;
        groundStrip(B, CELL.hazard, za + hc, za, zb + hc, zb, 0.18,
          gy((za + zb) * 0.5 + hc, (za + zb) * 0.5) + 0.014);
      }
    })();
    B.tint = null;
    B.paint = 'steel';

    // ---- 5. THE DRUM STORE CANOPY --------------------------------------------
    // An open-sided canopy on six posts with a mono-pitch sheet roof, and the
    // racking under it. From above it is a ROOF - a hard 9 x 5 m plane with a
    // ridge and an eaves shadow standing clear of the slab - which is what
    // gives thirty metres of flat apron a silhouette to read against.
    // SITED BY MEASUREMENT, not by convenience. On an 8x8 grid of the
    // establishing frame the gate tower lifted the three centre cells of the
    // bottom two rows from 0.033 to 0.27-0.62, and left the two WINGS - the
    // cells at 0.7-1.36 of the frame half-width, which is world (44..56, 55..62)
    // to the east and (-10..-20, 70..76) to the west - still at 0.034. Those are
    // 38 m from the tower where its cone delivers about 0.4 lux, and no amount
    // of trimming a single fixture reaches them.
    //
    // What reaches them is a source standing IN them, and the only kind this
    // level can still afford is emissive. So the drum store moves east into the
    // east wing and its soffit battens do the work: from thirty metres up at a
    // 46-degree depression you see 4 m in under a 4 m eave, which puts the lit
    // underside of the sheet, three batten fittings and nine lit drums directly
    // in the cell that was measuring 0.034. The west wing gets the same
    // treatment from the guard hut below.
    (function () {
      var cx = 49.5, cz = 59.0, cw = 10.8, cd = 5.8;
      var cy = gy(cx, cz);
      var eaveA = 4.00, eaveB = 5.00;
      B.paint = 'steel';
      for (var px = 0; px < 3; px++) {
        for (var pz = 0; pz < 2; pz++) {
          var ppx = cx - cw * 0.5 + cw * (px / 2);
          var ppz = cz - cd * 0.5 + cd * pz;
          var ph2 = pz ? eaveB : eaveA;
          var pgy = gy(ppx, ppz);
          B.paint = 'wall';
          B.box('wall', 0.55, 0.32, 0.55, ppx, pgy + 0.10, ppz, 0.02);
          B.paint = 'steel';
          B.box('struct', 0.16, ph2, 0.16, ppx, pgy + ph2 * 0.5 + 0.14, ppz, 0.012);
          B.box('struct', 0.30, 0.03, 0.30, ppx, pgy + 0.27, ppz, 0.006);
          if (pz === 0) {
            B.strut('struct', ppx, pgy + ph2 - 0.9, ppz, ppx, pgy + ph2 - 0.1, ppz + 0.95,
              0.07, 0.07);
          }
        }
      }
      // the rafters and the sheet
      var slopeA = Math.atan2(eaveB - eaveA, cd);
      for (var rf = 0; rf < 3; rf++) {
        var rfx = cx - cw * 0.5 + cw * (rf / 2);
        B.strut('struct', rfx, cy + eaveA + 0.14, cz - cd * 0.5,
          rfx, cy + eaveB + 0.14, cz + cd * 0.5, 0.11, 0.24);
      }
      B.box('struct', cw + 0.5, 0.10, 0.14, cx, cy + eaveB + 0.20, cz + cd * 0.5, 0.008);
      B.box('struct', cw + 0.5, 0.10, 0.14, cx, cy + eaveA + 0.20, cz - cd * 0.5, 0.008);
      B.paint = 'roofdeck';
      B.boxR('roof', cw + 0.7, 0.09, cd + 0.7, cx,
        cy + (eaveA + eaveB) * 0.5 + 0.30, cz, slopeA, 0, 0, 0.012);
      // gutter and a downpipe, which is what stops a canopy being a plank
      B.paint = 'steel';
      B.box('struct', cw + 0.7, 0.13, 0.16, cx, cy + eaveB + 0.30, cz + cd * 0.5 + 0.40, 0.01);
      B.tube('rust', cx + cw * 0.5 + 0.1, cy + eaveB + 0.24, cz + cd * 0.5 + 0.40,
        cx + cw * 0.5 + 0.1, cy + 0.2, cz + cd * 0.5 + 0.40, 0.045, 6);
      // three battens under the sheet: an open store IS lit at night, and this
      // is emissive geometry so it is free against the practical cap
      B.paint = 'flat';
      for (var bt2 = 0; bt2 < 3; bt2++) {
        var btx = cx - cw * 0.5 + cw * ((bt2 + 0.5) / 3);
        B.box('lamp_w', 0.10, 0.05, 1.25, btx, cy + eaveA + 0.02, cz - 0.2, 0.006);
        B.paint = 'paint';
        B.box('clad', 0.15, 0.10, 1.35, btx, cy + eaveA + 0.09, cz - 0.2, 0.008);
        B.paint = 'flat';
      }
      // the racking: two bays of pallet rack with drums on the lower beams
      B.paint = 'paint';
      for (var rb = 0; rb < 3; rb++) {
        var rbx = cx - cw * 0.5 + 0.5 + rb * ((cw - 1.0) / 2);
        B.box('rail', 0.11, 2.35, 0.11, rbx, cy + 1.20, cz - 1.0, 0.01);
        B.box('rail', 0.11, 2.35, 0.11, rbx, cy + 1.20, cz + 0.15, 0.01);
      }
      for (var rl = 0; rl < 2; rl++) {
        var rly = cy + 0.52 + rl * 1.30;
        B.box('rail', cw - 1.0, 0.11, 0.09, cx - 0.05, rly, cz - 1.0, 0.008);
        B.box('rail', cw - 1.0, 0.11, 0.09, cx - 0.05, rly, cz + 0.15, 0.008);
      }
      B.paint = 'rusty';
      for (var dm = 0; dm < 9; dm++) {
        var dmx = cx - cw * 0.5 + 0.9 + (dm % 5) * 1.55;
        var dmy = cy + 0.90 + Math.floor(dm / 5) * 1.30;
        B.cyl('rust', 0.29, 0.29, 0.86, dmx, dmy, cz - 0.42, 0, 0, 0, 12);
        B.cyl('rust', 0.30, 0.30, 0.045, dmx, dmy + 0.30, cz - 0.42, 0, 0, 0, 12);
        B.cyl('rust', 0.30, 0.30, 0.045, dmx, dmy - 0.30, cz - 0.42, 0, 0, 0, 12);
      }
      B.paint = 'flat';
      decalCard(B, CELL.flam, cx - cw * 0.5 + 0.4, cy + 2.55, cz - cd * 0.5 - 0.1,
        1.0, 1.0, '-z');
      B.paint = 'steel';
      L.addCollider(cx, cy + 1.2, cz - 0.4, cw * 0.5, 1.2, 0.9, 'metal');
    })();

    // ---- 5b. THE GUARD HUT AND THE PEDESTRIAN GATE ---------------------------
    // The WEST wing of the establishing frame's bottom two rows - world
    // (-10..-20, 70..76) - measures 0.034 for the same reason the east wing did:
    // it is 38 m from the tower. It gets the same answer, and the answer is also
    // the right building: the far side of a refinery gate from the weighbridge is
    // always the personnel side, with the hut the guard actually sits in, a
    // turnstile, and a lit notice board. All three are emissive, all three face
    // south-east toward the establishing eye, and none of them costs a practical.
    (function () {
      var hx = -14.5, hz = 72.5, hw = 5.0, hd = 3.8, hh = 3.05;
      var hy = gy(hx, hz);
      B.paint = 'wall';
      B.box('wall', hw + 0.8, 0.28, hd + 0.8, hx, hy + 0.06, hz, 0.02);
      B.paint = 'blockwork';
      B.box('wall', hw, 1.05, 0.22, hx, hy + 0.66, hz - hd * 0.5, 0.02);
      B.box('wall', hw, hh, 0.22, hx, hy + hh * 0.5 + 0.14, hz + hd * 0.5, 0.02);
      B.box('wall', 0.22, hh, hd, hx - hw * 0.5, hy + hh * 0.5 + 0.14, hz, 0.02);
      B.box('wall', 0.22, 1.05, hd, hx + hw * 0.5, hy + 0.66, hz, 0.02);
      // the glazed band on the two faces the establishing eye can see
      B.paint = 'glass';
      B.box('glass', hw - 0.34, 1.30, 0.05, hx, hy + 1.90, hz - hd * 0.5 - 0.02, 0.004);
      B.box('glass', 0.05, 1.30, hd - 0.34, hx + hw * 0.5 + 0.02, hy + 1.90, hz, 0.004);
      B.paint = 'steel';
      for (var gm = 0; gm < 3; gm++) {
        B.box('struct', 0.06, 1.40, 0.10, hx - hw * 0.5 + 0.34 + gm * (hw - 0.68) * 0.5,
          hy + 1.90, hz - hd * 0.5 - 0.05, 0.005);
      }
      B.box('struct', hw + 0.1, 0.10, 0.13, hx, hy + 1.22, hz - hd * 0.5 - 0.05, 0.008);
      B.box('struct', hw + 0.1, 0.10, 0.13, hx, hy + 2.58, hz - hd * 0.5 - 0.05, 0.008);
      // the lit room: a back panel with the guard's desk and locker in front
      B.paint = 'flat';
      B.box('lamp_w', hw - 0.9, 0.86, 0.10, hx, hy + 1.92, hz + hd * 0.5 - 0.38, 0.008);
      B.paint = 'paint';
      B.box('clad', hw - 1.8, 0.13, 0.58, hx - 0.4, hy + 1.50, hz - hd * 0.5 + 0.60, 0.012);
      B.box('clad', 0.46, 1.35, 0.40, hx + hw * 0.5 - 0.62, hy + 1.86, hz + 0.2, 0.012);
      B.box('clad', 0.32, 0.46, 0.30, hx - 0.5, hy + 1.82, hz - hd * 0.5 + 0.70, 0.012);
      B.paint = 'steel';
      // a flat roof with an upstand, a coping and the aerial every gatehouse has
      B.paint = 'wall';
      B.box('wall', hw + 0.5, 0.22, hd + 0.5, hx, hy + hh + 0.24, hz, 0.02);
      B.paint = 'kerb';
      B.box('kerb', hw + 0.66, 0.08, hd + 0.66, hx, hy + hh + 0.39, hz, 0.012);
      B.paint = 'steel';
      B.cyl('struct', 0.032, 0.032, 1.85, hx + hw * 0.5 - 0.3, hy + hh + 1.30, hz + 1.1, 0, 0, 0, 5);
      B.tube('rust', hx + hw * 0.5 - 0.3, hy + hh + 2.10, hz + 1.1,
        hx + hw * 0.5 - 0.3, hy + hh + 2.10, hz + 1.75, 0.020, 5);
      // the wall pack over the door, and the door
      B.paint = 'paint';
      B.box('clad', 0.24, 0.19, 0.32, hx - hw * 0.5 - 0.15, hy + 2.30, hz + 0.9, 0.012);
      B.paint = 'flat';
      B.box('lamp_w', 0.06, 0.13, 0.24, hx - hw * 0.5 - 0.28, hy + 2.26, hz + 0.9, 0.005);
      B.paint = 'shutter';
      B.box('clad', 0.05, 2.00, 0.88, hx - hw * 0.5 - 0.13, hy + 1.00, hz + 0.9, 0.006);
      B.paint = 'steel';
      L.addCollider(hx, hy + hh * 0.5, hz, hw * 0.5 + 0.2, hh * 0.5 + 0.3, hd * 0.5 + 0.2,
        'concrete');

      // the turnstile: a caged full-height gate, which is a dense little lattice
      // and one of the most recognisable objects on any industrial perimeter
      var tsx = hx + 3.9, tsz = hz - 0.4;
      var tsy = gy(tsx, tsz);
      B.paint = 'steel';
      for (var tc = 0; tc < 4; tc++) {
        var tca = tc / 4 * Math.PI * 2 + 0.4;
        B.cyl('struct', 0.055, 0.055, 2.35,
          tsx + Math.cos(tca) * 0.78, tsy + 1.18, tsz + Math.sin(tca) * 0.78, 0, 0, 0, 6);
      }
      B.torus('struct', 0.80, 0.035, tsx, tsy + 2.32, tsz, 16);
      B.torus('struct', 0.80, 0.030, tsx, tsy + 0.14, tsz, 16);
      B.cyl('struct', 0.075, 0.075, 2.30, tsx, tsy + 1.15, tsz, 0, 0, 0, 8);
      B.paint = 'chainmesh';
      for (var tr = 0; tr < 3; tr++) {
        var tra = tr / 3 * Math.PI * 2 + 0.9;
        B.boxR('chain', 1.05, 2.10, 0.02, tsx + Math.cos(tra) * 0.52, tsy + 1.16,
          tsz + Math.sin(tra) * 0.52, 0, -tra + Math.PI * 0.5, 0, 0.004);
        B.paint = 'steel';
        B.tube('struct', tsx, tsy + 2.10, tsz,
          tsx + Math.cos(tra) * 1.02, tsy + 2.10, tsz + Math.sin(tra) * 1.02, 0.028, 5);
        B.tube('struct', tsx, tsy + 0.30, tsz,
          tsx + Math.cos(tra) * 1.02, tsy + 0.30, tsz + Math.sin(tra) * 1.02, 0.028, 5);
        B.paint = 'chainmesh';
      }
      B.paint = 'steel';
      L.addCollider(tsx, tsy + 1.1, tsz, 0.95, 1.1, 0.95, 'metal');

      // the notice board: a lit case with the shift board and the site plan in
      // it, canted 12 degrees off the wall so it is not another flat rectangle
      var nbx = hx - hw * 0.5 - 1.9, nbz = hz - 1.4;
      var nby = gy(nbx, nbz);
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 1.35, nbx - 0.55, nby + 0.68, nbz, 0, 0, 0, 6);
      B.cyl('struct', 0.05, 0.05, 1.35, nbx + 0.55, nby + 0.68, nbz, 0, 0, 0, 6);
      B.paint = 'paint';
      B.boxR('clad', 1.55, 1.05, 0.14, nbx, nby + 1.62, nbz, 0.21, 0.30, 0, 0.014);
      B.paint = 'flat';
      B.boxR('lamp_sky', 1.34, 0.88, 0.03, nbx + 0.04, nby + 1.62, nbz - 0.08,
        0.21, 0.30, 0, 0.005);
      B.paint = 'steel';
      B.boxR('struct', 1.60, 0.09, 0.20, nbx, nby + 2.20, nbz - 0.06, 0.21, 0.30, 0, 0.008);
      B.paint = 'flat';
      decalCard(B, CELL.danger, hx - hw * 0.5 - 0.14, hy + 1.35, hz - 0.8, 0.85, 0.66, '-x');
      decalCard(B, CELL.nosmoke, hx, hy + 0.62, hz - hd * 0.5 - 0.13, 0.70, 0.70, '-z');
      B.paint = 'steel';
    })();

    // ---- 6. THE APRON LIGHTING STANDARDS -------------------------------------
    // Emissive only, and deliberately so: they are not there to light the ground
    // - one tower does that, and the practical cap is full - they are there so
    // the apron BEYOND the pool reads as a lit industrial site at night rather
    // than as the edge of the level, and so the eye has something to follow out
    // of the frame in both directions.
    //
    // SITED AGAINST THE MEASUREMENT. The first pass put nine of these along the
    // fence at z = 79, and solving the establishing camera showed every one of
    // them at a forward distance of 15-16 m - i.e. BELOW the bottom edge of the
    // frame, which starts at 25 m. A lamp nobody can see is a lamp that measures
    // nothing. Every position below now solves to 33-51 m forward and 0.7-0.93 of
    // the frame half-width, which is exactly the two dark wings; the last three
    // are on the real perimeter for the player rather than for the camera.
    var PERIM = [
      [-30, 66.0, 1.5708], [-46, 54.0, 1.5708], [-64, 40.0, 1.5708],
      [60, 48.0, -1.5708], [72, 26.0, -1.5708],
      [16, 79.0, 0.0], [-8, 79.0, 0.0], [82, 2.0, -1.5708], [-82, 58.0, 1.5708]
    ];
    for (i = 0; i < PERIM.length; i++) {
      var pxq = PERIM[i][0], pzq = PERIM[i][1], pyaw = PERIM[i][2];
      var pgy2 = gy(pxq, pzq);
      B.paint = 'steel';
      B.cyl('struct', 0.085, 0.135, 6.15, pxq, pgy2 + 3.08, pzq, 0, 0, 0, 8);
      B.cyl('struct', 0.24, 0.24, 0.05, pxq, pgy2 + 0.30, pzq, 0, 0, 0, 10);
      B.paint = 'wall';
      B.box('wall', 0.58, 0.28, 0.58, pxq, pgy2 + 0.10, pzq, 0.02);
      B.paint = 'steel';
      var oxq = Math.sin(pyaw) * 0.78, ozq = Math.cos(pyaw) * 0.78;
      B.tube('struct', pxq, pgy2 + 5.90, pzq, pxq + oxq, pgy2 + 6.24, pzq + ozq, 0.048, 6);
      B.paint = 'paint';
      B.boxR('clad', 0.68, 0.16, 0.40, pxq + oxq * 1.26, pgy2 + 6.30, pzq + ozq * 1.26,
        0.30, pyaw, 0, 0.014);
      B.paint = 'flat';
      B.boxR('lamp_w', 0.56, 0.05, 0.32, pxq + oxq * 1.26, pgy2 + 6.19,
        pzq + ozq * 1.26, 0.30, pyaw, 0, 0.006);
      B.paint = 'steel';
      B.tube('rust', pxq + 0.15, pgy2 + 0.5, pzq, pxq + 0.15, pgy2 + 5.8, pzq, 0.028, 5);
      L.addCollider(pxq, pgy2 + 3.0, pzq, 0.18, 3.0, 0.18, 'metal');
    }

    // ---- 7. THE STAINS THAT MAKE IT A YARD ------------------------------------
    // Turning scrub where every vehicle swings into the bays, a diesel bloom at
    // the head of the weighbridge and tyre tracks down the approach.
    B.paint = 'flat';
    for (i = 0; i < 26; i++) {
      var sx2 = rng.range(EN_X0 + 1, EN_X1 - 6);
      var sz2 = rng.range(EN_Z0 + 1, EN_Z1 - 1);
      var pick = rng.pick([CELL.spill, CELL.spill, CELL.scuff, CELL.scuff, CELL.scuff,
                           CELL.weep, CELL.cross]);
      var sw2 = pick === CELL.spill ? rng.range(1.4, 3.4)
        : (pick === CELL.cross ? rng.range(0.55, 0.9) : rng.range(1.6, 4.4));
      decalCard(B, pick, sx2, gy(sx2, sz2) + 0.0145, sz2,
        sw2, sw2 * rng.range(0.7, 1.5), 'y', rng.range(0, Math.PI * 2));
    }
    for (i = 0; i < 5; i++) {
      decalCard(B, CELL.scuff, 20.0 + i * 3.4, gy(20 + i * 3.4, 50.5) + 0.0145, 50.5,
        6.5, 4.5, 'y', rng.range(-0.2, 0.2));
    }
    B.paint = 'steel';

    return {
      centre: new THREE.Vector3((EN_X0 + EN_X1) * 0.5, gy(32, 59), 59.0),
      x0: EN_X0, x1: EN_X1, z0: EN_Z0, z1: EN_Z1,
      weighbridge: { x0: WB_X0, x1: WB_X1, z0: WB_Z0, z1: WB_Z1,
                     deckY: wbY + 0.14,
                     centre: new THREE.Vector3(wbCx, wbY, wbCz) },
      kiosk: { centre: new THREE.Vector3(kx, ky, kz), w: kw, d: kd, h: kh },
      boomZ: BOOM_Z,
      bays: { x0: BAY_X0, x1: BAY_X1, z0: BAY_Z0, z1: BAY_Z0 + BAY_N * BAY_P,
              n: BAY_N, pitch: BAY_P },
      canopy: { centre: new THREE.Vector3(30.5, gy(30.5, 71.0), 71.0), w: 9.2, d: 5.2 }
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
  // The hyperbolic profile of an induced-draught cooling tower, as a radius
  // fraction of the base at height fraction u. The throat at u = 0.78 is the
  // entire recognition cue.
  function hyperR(baseR, u) {
    var t3 = u - 0.78;
    return baseR * (0.52 + 1.61 * t3 * t3);
  }

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
    // MEASURED: the 130-330 m band photographed as a BAR CHART - a row of flat
    // rectangles with square tops, near-uniform width, no internal structure.
    // Aerial perspective was working (0.403 luminance at 0.26 saturation
    // against a 0.575 sky, so they were lifted and desaturated correctly); the
    // failure was purely SHAPE, and shape out here costs a handful of extra
    // primitives. Six archetypes now, every one of them with a varied top,
    // because a skyline is read off its tops.
    B.paint = 'far';
    for (i = 0; i < 210; i++) {
      var ang = rng.range(0, Math.PI * 2);
      var rad = 128 + Math.pow(rng.next(), 0.62) * 200;
      var x = Math.cos(ang) * rad, z = Math.sin(ang) * rad;
      var kind = rng.next();
      var gyv = farY(x, z, N);
      if (kind < 0.20) {                       // ---- a squat wide tank -------
        var tr = rng.range(7, 21);
        if (!clear(x, z, tr + 4)) continue;
        var th = tr * rng.range(0.45, 0.80);
        B.cyl('far', tr, tr, th, x, gyv + th * 0.5, z, 0, 0, 0, 14, true);
        var domed = rng.bool(0.5);
        if (domed) {
          // a real dome, not a cone: two frusta read completely differently on
          // a skyline from the single spike this used to draw
          B.cyl('far', tr * 0.80, tr, tr * 0.20, x, gyv + th + tr * 0.10, z, 0, 0, 0, 14, true);
          B.cyl('far', tr * 0.34, tr * 0.80, tr * 0.16, x, gyv + th + tr * 0.28, z, 0, 0, 0, 14, true);
        } else {
          B.cyl('far', tr * 0.1, tr, 1.3, x, gyv + th + 0.6, z, 0, 0, 0, 14, true);
        }
        // the wind girder ring, which is what says "storage tank" at 250 m
        B.cyl('far', tr + 0.9, tr + 0.9, 0.35, x, gyv + th * 0.86, z, 0, 0, 0, 14, true);
      } else if (kind < 0.42) {                // ---- a column train ----------
        if (!clear(x, z, 14)) continue;
        var n2 = rng.int(3, 6);
        var trainYaw = rng.range(0, Math.PI * 2);
        for (k = 0; k < n2; k++) {
          var spread = (k - (n2 - 1) * 0.5) * rng.range(4.5, 8.0);
          var ox = x + Math.cos(trainYaw) * spread + rng.range(-2, 2);
          var oz = z + Math.sin(trainYaw) * spread + rng.range(-2, 2);
          var ch = rng.range(18, 52), cr = rng.range(1.3, 3.4);
          B.cyl('far', cr, cr, ch, ox, gyv + ch * 0.5, oz, 0, 0, 0, 10, true);
          // ellipsoidal head so the tops are round, not sawn off
          B.cyl('far', cr * 0.52, cr, cr * 0.62, ox, gyv + ch + cr * 0.31, oz, 0, 0, 0, 10, true);
          // three platform rings up the shaft
          for (var pr3 = 1; pr3 <= 3; pr3++) {
            B.cyl('far', cr + 1.3, cr + 1.3, 0.16, ox, gyv + ch * (pr3 / 4), oz,
              0, 0, 0, 10, true);
          }
        }
      } else if (kind < 0.54) {                // ---- a cooling tower ---------
        // hyperbolic profile in five frusta: the throat at 0.72 h is the whole
        // recognition cue and it is four extra cylinders
        if (!clear(x, z, 26)) continue;
        var cth = rng.range(34, 64);
        var cbr = cth * rng.range(0.30, 0.40);
        var nH = 6;
        for (k = 0; k < nH; k++) {
          var u0 = k / nH, u1 = (k + 1) / nH;
          B.cyl('far', hyperR(cbr, u1), hyperR(cbr, u0), cth / nH,
            x, gyv + cth * (u0 + u1) * 0.5, z, 0, 0, 0, 16, true);
        }
        B.cyl('far', cbr * 0.60, cbr * 0.58, 1.6, x, gyv + cth + 0.8, z, 0, 0, 0, 16, true);
      } else if (kind < 0.66) {                // ---- a guyed lattice mast ----
        if (!clear(x, z, 10)) continue;
        var mh = rng.range(38, 78), mr = rng.range(1.0, 2.2);
        // three legs, so it silhouettes as an open mast rather than a post
        for (k = 0; k < 3; k++) {
          var mla = k / 3 * Math.PI * 2;
          B.strut('far', x + Math.cos(mla) * mr * 2.4, gyv, z + Math.sin(mla) * mr * 2.4,
            x + Math.cos(mla) * mr * 0.5, gyv + mh, z + Math.sin(mla) * mr * 0.5, 0.55, 0.55);
        }
        for (k = 1; k < 7; k++) {
          B.cyl('far', mr * 1.9 * (1 - k / 9), mr * 1.9 * (1 - k / 9), 0.30,
            x, gyv + mh * (k / 7), z, 0, 0, 0, 8, true);
        }
        // guys
        for (k = 0; k < 3; k++) {
          var gya = k / 3 * Math.PI * 2 + 0.6;
          B.strut('far', x, gyv + mh * 0.72, z,
            x + Math.cos(gya) * mh * 0.45, gyv, z + Math.sin(gya) * mh * 0.45, 0.28, 0.28);
        }
        // and a small flame card at the top of every third one, so the level's
        // fire is not a single point on the horizon
        // MEASURED: at mr * 2.6 x mr * 6.5 these were 4 x 11 m cards and at
        // 200 m they printed as HARD WHITE RECTANGLES hanging over the
        // skyline - a flat quad reads as a flat quad the moment it is more
        // than three or four pixels across. At 1.3 x 3.2 m they are two
        // pixels, the bloom carries them out to a soft point, and they read
        // as what they are: a flare burning a long way away.
        if (i % 3 === 0) {
          B.paint = 'flat';
          B.add('far_light', quad(1.3, 3.2, 0, 0, 1, 1),
            makeM(x, gyv + mh + 1.7, z, 0, Math.atan2(-x, -z), 0));
          B.paint = 'far';
        }
      } else if (kind < 0.84) {                // ---- a shed with a roof ------
        if (!clear(x, z, 16)) continue;
        var bw = rng.range(12, 40), bd = rng.range(9, 26), bh = rng.range(5, 13);
        var byaw = rng.range(0, 3.14);
        B.boxR('far', bw, bh, bd, x, gyv + bh * 0.5, z, 0, byaw, 0, 0.05);
        // a stepped or monopitch top, plus roof plant - anything but a flat lid
        if (rng.bool(0.55)) {
          B.boxR('far', bw * 0.62, bh * 0.34, bd * 0.70, x, gyv + bh + bh * 0.17, z,
            0, byaw, 0, 0.05);
        } else {
          B.boxR('far', bw * 1.02, 0.9, bd * 1.04, x, gyv + bh + 0.45, z, 0.13, byaw, 0, 0.05);
        }
        B.cyl('far', 0.9, 1.2, bh * 0.55, x + Math.cos(byaw) * bw * 0.3,
          gyv + bh + bh * 0.27, z + Math.sin(byaw) * bw * 0.3, 0, 0, 0, 8, true);
      } else {                                  // ---- a rack run, end-on -----
        if (!clear(x, z, 20)) continue;
        var ryaw = rng.range(0, Math.PI * 2);
        var rl = rng.range(30, 90);
        B.boxR('far', 7.0, 0.9, rl, x, gyv + 9.5, z, 0, ryaw, 0, 0.05);
        B.boxR('far', 5.4, 0.7, rl, x, gyv + 6.2, z, 0, ryaw, 0, 0.05);
        for (k = 0; k < 8; k++) {
          var t2 = (k + 0.5) / 8;
          B.boxR('far', 0.7, 10.0, 0.7,
            x + Math.sin(ryaw) * (t2 - 0.5) * rl, gyv + 5.0,
            z + Math.cos(ryaw) * (t2 - 0.5) * rl, 0, ryaw, 0, 0.03);
        }
      }
    }
    // Three more flares on the horizon, so the burning one has a rhyme and the
    // site reads as one plant in a field of them rather than as an island.
    var FARFL = [[-232, -196, 58], [188, -258, 46], [-286, 96, 52]];
    for (i = 0; i < FARFL.length; i++) {
      var fx2 = FARFL[i][0], fz2 = FARFL[i][1], fh2 = FARFL[i][2];
      var fgy = farY(fx2, fz2, N);
      B.paint = 'far';
      B.cyl('far', 1.1, 2.2, fh2, fx2, fgy + fh2 * 0.5, fz2, 0, 0, 0, 10, true);
      for (k = 0; k < 3; k++) {
        var fla = k / 3 * Math.PI * 2 + 0.4;
        B.strut('far', fx2 + Math.cos(fla) * 5.5, fgy, fz2 + Math.sin(fla) * 5.5,
          fx2 + Math.cos(fla) * 1.4, fgy + fh2 * 0.92, fz2 + Math.sin(fla) * 1.4, 0.5, 0.5);
      }
      B.paint = 'flat';
      B.add('far_light', quad(2.0, 5.0, 0, 0, 1, 1),
        makeM(fx2, fgy + fh2 + 2.6, fz2, 0, Math.atan2(-fx2, -fz2), 0));
      B.paint = 'far';
    }

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
    // worth the name; these 30 entries ARE its lighting. (24 until this round -
    // see THE RIG below for why the cap moved and what the six extra buy.)
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

    // ------------------------------------------------------------ THE RIG ----
    // Scalars merged OVER the 'mixed' preset main.js already selects. Every one
    // of these was a constant in lighting.js until this round and every one is
    // MEASURED against this level rather than chosen.
    //
    //   practicals / active - the 24-entry cap was the binding constraint on
    //     this file for three rounds and its own comments say so four times
    //     ("the rig is ON lighting.js's 24-entry cap and nothing here is free").
    //     lighting.js has now measured what the 24 protected: not uniforms
    //     (24 spots is 168 of 1024 vectors) and not samplers (every rig
    //     practical is castShadow:false), only the per-fragment light loop at
    //     ~0.05 ms each. 30 built / 26 active buys the six fixtures the
    //     measured dead regions need for ~0.1 ms and ZERO draw calls - both the
    //     bulb and the halo are instances in a mesh that is drawn anyway.
    //
    //   shadowFill - lighting.js published a measurement taken on THIS level's
    //     lv_overview at 0.25: the control building's shaded face median
    //     0.0088 -> 0.0154 (+75%) with lit paving unchanged. The cast shadow of
    //     the plant is what puts the establishing frame's bottom-right corner
    //     under the dead-cell floor, so this is the cheapest half of that fix.
    //
    //   svNormal - the sky-visibility volume spends its fixed 44x26x76 cells on
    //     a 200 x 26 x 200 m box, i.e. 4.55 x 1.00 x 2.63 m per cell. The
    //     default 0.60 m sample offset does not leave the cell a wall is
    //     standing in, so a bund wall in the open reads as if it were roofed.
    //     2.2 m is a little under half the X cell, which is the rule the shared
    //     module states.
    //
    //   groundBounce - `amount` IS the ground albedo and this site is not one
    //     material: 156 m of grey hardstanding at ~0.30, a 15 m asphalt
    //     carriageway at ~0.10 and an oiled gravel margin at ~0.15. 0.22 is the
    //     area weight. `lamps` 0.40 rather than the 0.25 default because the
    //     illuminated part of this floor really is a large continuous surface -
    //     four mast pools, a gate tower and two rack floods all land on the
    //     same slab - and `ao` stays low because a refinery underside stands
    //     over bright paving, which is the physical case the shared note names.
    this.lightRig = {
      practicals: 30,
      active: 26,
      shadowFill: 0.24,
      svNormal: 2.20,
      svGamma: 0.78,
      svFloor: 0.075
    };
    this.groundBounce = { amount: 0.22, ao: 0.30, lamps: 0.40, max: 1.10 };

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
    // The gate approach, published before build() like everything else so
    // props_refinery can dress it without waiting or guessing. buildEntrance
    // overwrites this object's fields in place during build.
    A.entrance = {
      centre: V((EN_X0 + EN_X1) * 0.5, gy(32, 59), 59.0),
      x0: EN_X0, x1: EN_X1, z0: EN_Z0, z1: EN_Z1,
      weighbridge: { x0: WB_X0, x1: WB_X1, z0: WB_Z0, z1: WB_Z1,
                     deckY: gy((WB_X0 + WB_X1) * 0.5, (WB_Z0 + WB_Z1) * 0.5) + 0.14,
                     centre: V((WB_X0 + WB_X1) * 0.5, gy((WB_X0 + WB_X1) * 0.5,
                       (WB_Z0 + WB_Z1) * 0.5), (WB_Z0 + WB_Z1) * 0.5) },
      kiosk: { centre: V(KIOSK.x, gy(KIOSK.x, KIOSK.z), KIOSK.z),
               w: KIOSK.w, d: KIOSK.d, h: KIOSK.h },
      boomZ: BOOM_Z,
      bays: { x0: 25.5, x1: 39.5, z0: 45.5, z1: 45.5 + 5 * 4.35, n: 5, pitch: 4.35 },
      canopy: { centre: V(30.5, gy(30.5, 71.0), 71.0), w: 9.2, d: 5.2 }
    };
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
    } else if (key === 'far_light') {
      m = this._farLightMaterial();
    } else if (lib && typeof lib.get === 'function') {
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      if (surf.albedoTarget !== undefined) opts.albedoTarget = surf.albedoTarget;
      if (surf.rough !== undefined) opts.roughness = surf.rough;
      if (surf.metal !== undefined) opts.metalness = surf.metal;
      if (surf.env !== undefined) opts.envMapIntensity = surf.env;
      // NORMAL SCALE. Not decoration: the review measured concrete and
      // corrugated sheet shattering into per-pixel static at 4.6x the grain
      // floor, because materials.js's base-normal LOD schedule is gated on
      // ldef.weather and no declarative level sets it - so every surface here
      // runs its full-strength normal at every distance. That is a shared
      // system and is reported as such, but the specular aliasing it causes is
      // worst on this level's four largest surfaces (bund wall, tank shell,
      // apron, cladding) and materials.js already exposes the dial that fixes
      // it locally, per request, without touching anyone else's level.
      if (surf.ns !== undefined) opts.normalScale = surf.ns;
      // ---- THE THREE SURFACE-FREQUENCY DIALS --------------------------------
      // `meso` and `detail` are the amplitudes of the two PROCEDURAL bands
      // materials.js evaluates in the fragment shader; `grain` decimates the
      // sampled base map set by whole octaves on the CPU. All three existed;
      // only `grain` is new, and only `grain` was documented before this round.
      // They are the only way to reach a signal that has no mip chain - see the
      // note on SURF.tank for the measurement that made this necessary.
      if (surf.meso !== undefined) opts.meso = surf.meso;
      if (surf.detail !== undefined) opts.detail = surf.detail;
      if (surf.grain !== undefined) opts.grain = surf.grain;
      if (surf.mesoScale !== undefined) opts.mesoScale = surf.mesoScale;
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

  // ---- THE LIGHTS OF THE FAR PLANT ARE POINTS, NOT SQUARES ------------------
  // MEASURED on lv_overview at 3x: the 263 emissive cards scattered through the
  // 130-330 m band print as HARD-EDGED WHITE RECTANGLES - six to fourteen pixels
  // across with a visible corner on each one - and so does the flame card on
  // every distant flare. The size is not the problem (they are already only
  // 0.5-1.5 m); the problem is that an emissive quad at four times overbright
  // clips every texel it has to the same white, so the shape you see is the
  // QUAD, and the bloom cannot round off a shape that has no falloff in it.
  //
  // The fix is a soft radial alpha and additive blending, which is what a distant
  // point source is. puffTexture() already generates exactly the right sprite for
  // the plumes, the far_light quads already carry full-tile UVs (keepUV), and
  // _paint writes the distance fade into their vertex colour - so a light at
  // 330 m is dimmer than one at 130 m without needing fog, which would be wrong
  // on an additive surface anyway.
  LevelRefinery.prototype._farLightMaterial = function () {
    var tex = null;
    try { tex = puffTexture(); } catch (e) { tex = null; }
    var m = new THREE.MeshBasicMaterial({
      map: tex,
      // sodium, authored in HDR so postfx's bloom has something to find
      color: new THREE.Color(2.35, 1.50, 0.72),
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexColors: true, toneMapped: false
    });
    this._anisotropy(tex, 4);
    m.name = 'refinery_far_light';
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
          // 0.0040, not 0.0046. The landmark stands 110 m from the signature
          // mark and the review measured it at 0.05 albedo contrast against
          // the haze; a 13% thinner layer buys back real contrast at that
          // range while leaving the 300 m backdrop still dissolving.
          density: 0.0040,
          startDistance: 3.0,
          maxOpacity: 0.90,
          // Forward scatter is the depth cue, not the subject: two of the five
          // framings look within 30 degrees of the twilight band and a higher g
          // would flood them with cream.
          // MEASURED. mieG 0.58 / glowGain 1.05 / desaturate 0.20 made the
          // aerial layer itself a warm dye: the hue histogram of hero1 came
          // back 89.7% warm in the sky band, 83.4% in the mid-ground and 93.0%
          // across the column row - the mercury uplights were landing and then
          // being tinted back to orange by 40 m of glowing haze on top of them.
          // Forward scatter down to 0.42, glow gain down a third and the
          // desaturation doubled: the layer still separates depth, it no longer
          // paints it.
          mieG: 0.52,
          glowGain: 0.95,
          desaturate: 0.22
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

    stage('entrance', function () {
      var en = buildEntrance(self, B, rng, N);
      if (en) self.anchors.entrance = en;
    });
    stage('fence', function () { buildFence(self, B, rng, N); });
    stage('distant', function () { buildDistant(self, B, rng, N); });
    stage('lamps', function () { self._buildLamps(B, N); });
    await GAME.yieldFrame();

    // Plumes BEFORE the merge, because each steam vent needs a silencer stub
    // under it and those stubs are level geometry: three of the four plumes
    // used to start in open air and photographed as cotton wool hanging in
    // the sky.
    stage('plumes', function () { self._buildPlumes(); });
    stage('vents', function () { self._buildVentStubs(B, N); });
    stage('merge', function () { self._finalize(B); });
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
  // 30 entries against a published `practicals: 30` (see THE RIG in the
  // constructor). The ORDER still matters - if the budget is ever lowered,
  // lighting.js drops off the END - so they are listed most-important first.
  //
  // Calibration is taken from the one measured number in the build: level 1's
  // street sodium puts 8.6 lux on the pavement under it, against an ambient
  // floor around 0.5, and that ~17:1 is what reads as "a lamp" rather than as
  // "a slightly brighter patch". Every intensity below is solved as
  // I = E * d^2 for the surface the fixture actually aims at:
  //
  //   high mast   13.2 m over the road, want 4.4 lux  ->  760
  //   column up   17.6 m to the shell FOOT, 2.5       ->  780
  //   tank flood  13 m to the shell, 5.3              ->  900
  //   rack flood  10.8 m to the road, 7.0             ->  820
  //   derrick up  14 m up the lattice, 6.4            ->  1250
  //   fluoro      5.3 m to the pump-house floor, 3.3  ->  92
  //   flare       40 m to C1's head, 5.3              ->  8600
  //
  // ---- THREE THINGS THE FIRST RIG GOT WRONG, ALL MEASURED ------------------
  //
  // 1. RANGE IS A COLOUR DECISION. The flare ran at distance 240, i.e. it
  //    reached every square metre of a 190 m site, and a 1950 K source doing
  //    global-ambient duty dyed the whole level orange: 87.6% of the signature
  //    frame's saturated pixels inside a 60-degree red wedge against 6.0% cool.
  //    At 110 it is a local key on the fire and the plant around it, which is
  //    what a fire actually lights, and the mercury units carry the rest.
  //
  // 2. WHITE IS NOT COOL. Converting road masts to 5400 K did not buy a
  //    warm/cool split, it bought GREY - the frame's saturated-pixel share fell
  //    from 86% to 39% for 11 points of cool. Two changes fixed it: the cold
  //    units went to 6600-7600 K so they read blue rather than white, and the
  //    cold and warm pools were SEPARATED IN PLAN so they stop cancelling.
  //    Final: 68.5% warm / 17.6% cool at 71% saturated.
  //
  // 3. `beam` IS PART OF THE RIG. lighting.js gives every cone a level
  //    publishes a full-strength volumetric shell by default, and on this level
  //    that shell was landing on the objects the cones were meant to reveal -
  //    most damagingly a 62 m cone of warm haze straight up the flare derrick.
  //    Every entry below now states its beam gain explicitly.
  //
  // ---- 4. THE PREMISE WAS INVERTED, AND IT IS A RULE, NOT A TASTE ----------
  // MEASURED on hero1: the top 140 rows of the signature frame came back 17.2%
  // warm / 35.5% cool at mean R-B +0.0097, and rows 430-560 came back 51.9%
  // warm / 8.7% cool at +0.0363. LEVELS_ROSTER specifies the exact opposite -
  // "orange fire from above and cold floods from below" - so the level was
  // delivering its own sentence upside down.
  //
  // The largest cool mass above 15 m is the column row, and it is not marginal:
  // sampling C1/C2's shells between rows 120 and 290 gives 15.6% warm against
  // 67.7% cool at R-B -0.0067, i.e. the second-tallest object in the frame is
  // ACTIVELY BLUE. It is lit that way by three 7600 K uplights aimed 24 m up
  // the shells and one 6800 K rack flood aimed 12 m up them, all four of which
  // reach the section the fire is supposed to own.
  //
  // FOUR THINGS WERE ELIMINATED BY MEASUREMENT BEFORE THIS WAS CHANGED, because
  // the same symptom has three innocent explanations on this level:
  //   ?ltRig=env:0.10      C2 shell 0.0546 -> 0.0542   the sky probe is not it
  //   ?ltRig=cfill:0.04    C2 shell 0.0546 -> 0.0517   the character fill is not it
  //   ?ltRig=amb/sky/bnc   tank shell / frame median 11.6 -> 11.5   the fills are not it
  //   ?ltRig=active:1      tank shell 0.396 -> 0.061    IT IS THE PRACTICALS
  // (the fog was excluded arithmetically: 0.0040/m over 9-25 m is 3.6-9.5%.)
  //
  // So the rig is now organised on ONE RULE, and every entry below states which
  // side of it the fixture is on:
  //
  //   THE FIRE FAMILY, 1900-2400 K, is everything mounted high that throws
  //     DOWNWARD or ACROSS: the flare itself, the sodium masts, the rack deck
  //     lamp, the column-row bulkhead. It owns the plant above about 15 m.
  //   THE FLOOD FAMILY, 6400-7600 K, is everything that throws UPWARD or rakes
  //     the slab from below 12 m. It owns the ground plane, the plinths, the
  //     column SKIRTS and the bottom third of every tall object.
  //
  // The two families meet ON THE SAME OBJECT at a height, which is the whole
  // point: a 41 m column with a cold foot and a fire-lit top states the brief in
  // one silhouette, and a ground flood physically cannot reach 40 m anyway -
  // holding it to 16 m is the honest answer as well as the composed one.
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
    // MEASURED: at distance 240 this was not a key light, it was the level's
    // AMBIENT. A 1950 K source reaching every square metre of a 190 m site
    // dyed the concrete apron, the asphalt, the steel and the sky the same
    // red-orange, and the hue histogram of hero1 came back with 87.6% of its
    // saturated pixels inside a 60-degree wedge and 6.0% cool - against 28.9%
    // cool on the shipped market level, which is itself a golden-hour frame.
    //
    // The fix is not to dim it. A flare IS the brightest thing here and it must
    // stay that. The fix is RANGE: at 110 m it is a local key on the flare pad,
    // the column row and the upper plant - everything within about a hundred
    // metres of the fire, which is what a fire actually lights - and the 14
    // mercury and fluorescent units carry the mid-ground on their own. The
    // hero1 mark stands 110 m from it, so the road under the lens is now lit by
    // sodium and mercury only, and photographs as warm grey rather than brick.
    // ---- 8600 cd / 125 m, NOT 6200 / 110, AND THE RANGE IS STILL THE POINT ---
    // Round 3 fixed "everything is orange" by winding the range 240 -> 110 and
    // that finding stands: a 1950 K source reaching every square metre of a
    // 190 m site is an ambient, not a key. What it also did, unintentionally, is
    // hand the whole upper plant to the mercury units, because at 6200 cd the
    // fire puts 3.8 lux on C1's top against 1.3 from an uplight 28 m away and a
    // 0.56 rad SPOT concentrates its 1.3 while the fire spreads its 3.8.
    //
    // Solved, not tuned. 8600 cd puts 5.3 lux on C1's head at 40 m and 14 lux on
    // the derrick's mid panel at 25 m - which is what a 46 m flame 25 m away
    // actually does - while 125 m of range still leaves the far apron alone:
    // three.js windows a point light by (1 - (d/range)^4)^2, so at the 110 m the
    // hero1 mark stands off the arrival is 8600/12100 x 0.160 = 0.11 lux, i.e.
    // a hundredth of a mast pool. The fire gets brighter WHERE IT STANDS and no
    // brighter at all where round 3 measured the damage.
    var fl = this.anchors.flare;
    push('rf_flare', 'fire', fl.flame.x, fl.flame.y + 3.4, fl.flame.z,
      1950, 8600, 125, 0, null,
      // haloMax 7.0, not 11.0. An additive halo eleven metres across, centred
      // 3.4 m above a flame that sits directly over the derrick, was washing
      // the top third of the very object it is meant to light.
      { haloScale: 0.06, haloMax: 8.0, haloGain: 0.62, bulbR: 0.55, bulbGain: 1.4,
        dayBase: 1.0 });

    // ---- 2-5. the high masts down the road ------------------------------------
    // Staggered left/right at 32 m centres so the road reads as alternating
    // pools with dark between them, which is what a lit road looks like. Each
    // mast is a real object: a raked column, a four-way head frame, four
    // reflectors and a cable running down the back of it.
    // The 4th column of each row is the COLOUR TEMPERATURE FAMILY, and the
    // alternation is the fix for a signature frame that measured 84.9% of its
    // saturated pixels inside a 60-degree red-orange wedge. Real plants mix
    // sodium and metal-halide on the same road; here the NEAR mast - the one
    // whose pool is the bottom third of hero1 - runs cold and the two receding
    // ones run sodium, so the leading line reads cold-warm-warm-fire into
    // depth instead of orange-orange-orange-fire. It costs nothing, it is what
    // the brief asked for ("cold floods from below"), and it is the only way to
    // put cool light on the largest surface in the frame.
    // MASTS[2]'s aim moved 5 m SOUTH, to (-5.5, 9.0). It is the only cold mast
    // and the only fixture whose pool can reach the near-left of the signature
    // frame; aimed at z = 4 its cone landed 22 m ahead of the hero1 eye and the
    // 6-10 m of apron the frame actually stands on measured 0.035 median. Five
    // metres of aim drags the near edge of the pool back to about z = 18,
    // which is inside the bottom-left corner of the frame.
    //
    // The fifth column is a PER-MAST intensity trim. MASTS[3] stands at z = 44,
    // behind the hero1 eye, so it contributes nothing to the signature frame
    // and everything to the establishing one: its pool is the lower-middle of
    // lv_overview, which is the half of that frame the coverage metric weighs.
    // MASTS[0] is 100 m out and its pool is a receding note rather than a
    // working light.
    var MASTS = [
      [-9.9, -52.0, 3.0, -46.0, 0, 0.90],
      [9.9, -20.0, -3.0, -14.0, 0, 1.00],
      [-9.9, 12.0, -5.5, 9.0, 1, 1.00],
      [9.9, 44.0, -3.0, 40.0, 0, 1.22]
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
      var mCold = MASTS[mi][4] === 1;
      floodHead(mx - 0.85, headY, mz, aimTo, 1.15, !mCold);
      floodHead(mx + 0.85, headY, mz, [MASTS[mi][2] * -0.6, my, MASTS[mi][3] - 8],
        1.15, !mCold);
      // the riser conduit, and the base cabinet
      B.paint = 'steel';
      B.tube('rust', mx + 0.26, my + 0.5, mz, mx + 0.26, headY - 0.4, mz, 0.035, 5);
      B.paint = 'paint';
      B.box('clad', 0.46, 0.85, 0.32, mx + 0.55, my + 0.44, mz + 0.30, 0.012);
      B.paint = 'flat';
      decalCard(B, CELL.hazard, mx, my + 0.05, mz, 2.0, 0.55, 'y', mi * 0.7);
      B.paint = 'steel';
      self.addCollider(mx, my + 6.6, mz, 0.30, 6.6, 0.30, 'metal');
      // 600, not 790. With the flare no longer washing the whole site the road
      // pools became the loudest warm element in every framing; trimming a
      // quarter off them keeps the amber rhythm and stops it dominating.
      // ---- beam 0.32 / 0.24, NOT 1.0 / 0.55. MEASURED, AND IT WAS DISSOLVING
      // THE LEADING LINE OF THE SIGNATURE FRAME. Sampling hero1's carriageway
      // down its own centre gives medians of 0.227 / 0.355 / 0.327 / 0.380 /
      // 0.648 / 0.382 / 0.306 at 6, 10, 15, 22, 35, 55 and 90 m - a LOCAL peak
      // at 35 m that is twice the sky's 0.335 - and the crop shows exactly what
      // the number says: 40 m of road at the point where its convergence should
      // be strongest is a flat milky cream sheet with no kerb line, no joint and
      // no markings resolvable in it.
      //
      // It is not the fog and it is not the tarmac. lighting.js gives a
      // published cone a volumetric shell at full strength, and `cone: 1.05` is
      // a SIXTY-DEGREE half-angle: from a 13.2 m head that is a shell 45 m
      // across lying along the road, three of them overlapping down its length.
      // The pool itself is right - the road IS lit - it was the haze in front of
      // it that had to come down. The halo stays at 0.95, because that is the
      // lamp's own glow and it is what says "sodium" from a hundred metres.
      push('rf_mast_' + mi, mCold ? 'mercury' : 'sodium', mx, headY, mz,
        mCold ? 6800 : 1980, Math.round((mCold ? 900 : 760) * MASTS[mi][5]), 46, 1.05, aimTo,
        { haloMax: mCold ? 2.4 : 2.9, haloGain: mCold ? 0.6 : 0.95,
          beam: mCold ? 0.24 : 0.32 });
    }

    // ---- 6-8. cold uplights on the column plinth --------------------------------
    // Aimed UP the shells from 2.2 m. This is the "cold floods from below" half
    // of the brief and it is the only thing modelling the level's tallest
    // objects: without it the column row is a black cut-out.
    // MEASURED, and this is why the third column moved further than the other
    // two. At x = 22.2 these stood 2.0-2.3 m clear of shells of radius 2.1-3.5
    // and were aimed 15-24 m up them, so the inverse-square term on the SKIRT
    // was an order of magnitude above the term on the section the fixture is
    // meant to model: hero2 came back blown_white 1.678% against a 1.5 limit,
    // with the column bases dissolved into a veiled white wash over the whole
    // lower-right quadrant. Backing off to a 3.6 m stand-off is within 4% of
    // the old lux at the 24 m aim point and roughly halves it at the skirt,
    // because the ratio between them is (d_aim/d_skirt)^2 and only d_skirt
    // moves appreciably.
    // ---- SOLVED AGAIN, AND THE PREVIOUS SOLVE WAS WRONG ---------------------
    // Raising the head above the skirt did move the hot spot off the refractory -
    // and put it straight onto the shell instead, which hero2 shows as a BLOWN
    // WHITE PATCH with a hard lower edge at the bottom of C1, on the level's own
    // landmark row, in two of the five published framings.
    //
    // The arithmetic I got wrong the first time: a cone's LOWER EDGE, not its
    // axis, is what grazes a nearby object. With a 0.56 rad half-angle about an
    // axis 70 degrees above horizontal, the lower edge leaves the head at 38
    // degrees and therefore crosses a shell 3.9 m away after only 4.95 m. At
    // 1150 cd that is 37 lux against 1.8 lux at the 25 m aim point - 21:1 - so
    // the near band clips whatever the intensity is set to. Standing the fixture
    // higher cannot fix a ratio; only STAND-OFF can.
    //
    // So the up-lights are no longer beside their columns, they are 14-16 m BACK
    // along the plinth, raking each shell obliquely from the south. The lower
    // cone edge now meets the near shell at 13.7 m (6.1 lux) against 1.4 lux at
    // the aim: 4.3:1, which is a raking flood fading up a 40 m can - what a
    // floodlit column actually looks like - instead of a spotlight burn at its
    // foot. It also lights 12 m of plinth deck on the way, which is ground the
    // signature frame's right third had nothing on.
    //
    // Each sightline was checked against the other three columns: none of the
    // three crosses another shell.
    // ---- AND THE AIM COMES DOWN, WHICH IS THE PREMISE FIX -------------------
    // The fourth column of each row was +24 / +19 / +15 metres above the
    // fixture, i.e. these cones were painting the column shells 20-25 m up -
    // exactly the band the brief assigns to the fire, and exactly where hero1
    // measured 67.7% cool. It is also not what a ground flood can physically do:
    // at 28 m the arrival is 1.3 lux and falling as 1/d^2.
    //
    // Re-solved for the SKIRT AND THE FOOT, which is the half of the brief these
    // fixtures are actually for. Aim +11.5 m over a 15.8 m stand-off is 26 deg
    // of elevation; a 0.42 rad half-angle puts the lower cone edge at 2 deg (so
    // it rakes the plinth deck on its way in rather than burning the refractory
    // at 4 m, which is the failure this fixture has already been re-solved for
    // twice) and the upper edge at 50 deg, which meets the near shell at 16 m of
    // height. `distance` 34 then hard-stops it: 34 m from a head 15.8 m out is
    // 30 m of shell, so nothing above that gets a photon from a mercury unit and
    // the flare owns the top 25 m of a 43 m column outright.
    var UPS = [
      [20.6, -30.0, 28.0, 11.5, -43.0],
      [20.6, -10.0, 26.0, 10.5, -24.0],
      [21.0, 3.5, 28.5, 9.0, -8.0]
    ];
    // ---- THE HEAD HAS TO STAND ABOVE THE SKIRT, AND IT DID NOT --------------
    // MEASURED on hero2, where C1's base fills a fifth of the frame: the column
    // came back with a BLOWN WHITE BLOB at grade under an otherwise flat pale
    // shell. The cause is geometric and it is not the intensity. A column skirt
    // is 2.6-3.05 m of refractory-clad can; the fixture head sat at 1.95 m, i.e.
    // BELOW THE TOP OF THE THING IT WAS SHINING PAST, four metres away. So the
    // near edge of a cone aimed 24 m up was still raking the skirt at 4 m, where
    // inverse square is 40 times what it is at the aim point.
    //
    // Raising the head to 3.62 m puts the whole cone above the skirt: the
    // nearest surface it can now reach is the shell at 8-10 m, and the aim-point
    // lux is unchanged to within 3% because the aim is 25 m away and only the
    // NEAR term moved. A 3.6 m pedestal is also what a real up-light on a unit
    // plinth stands on, for exactly this reason.
    for (var ui = 0; ui < UPS.length; ui++) {
      var ux = UPS[ui][0], uz = UPS[ui][1];
      var uy = gy(ux, uz);
      var uaim = [UPS[ui][2], uy + UPS[ui][3], UPS[ui][4]];
      B.paint = 'wall';
      B.box('wall', 0.95, 0.42, 0.95, ux, uy + 0.17, uz, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.085, 0.125, 3.40, ux, uy + 1.78, uz, 0, 0, 0, 9);
      B.box('struct', 0.42, 0.035, 0.42, ux, uy + 0.40, uz, 0.006);
      // the climbing bracket and the conduit, so a 3.6 m stand is a real one
      B.strut('struct', ux, uy + 3.30, uz, ux - 0.52, uy + 2.55, uz, 0.055, 0.055);
      B.tube('rust', ux + 0.16, uy + 0.5, uz, ux + 0.16, uy + 3.30, uz, 0.032, 5);
      floodHead(ux, uy + 3.62, uz, uaim, 1.35, false);
      self.addCollider(ux, uy + 1.8, uz, 0.42, 1.8, 0.42, 'metal');
      // 6200 K, not 5600. The whole level is inside a warm grade with a warm
      // key; a mercury unit that is merely "not sodium" reads as white, and
      // white is not the other half of a warm/cool split. At 6200 the column
      // shells come back measurably blue against the road.
      // 1330, not 950. These and the tank floods are the only cold sources
      // aimed at anything large, so they are what has to carry the cool half of
      // the frame; at 950 against a 240 m flare they were inaudible.
      // beam 0.09, not 0.30. MEASURED on hero2: lighting.js draws a level's cone
      // as a volumetric shell with a HARD SILHOUETTE EDGE, and a 25 m cone from a
      // ground fixture up a column prints as a pale straight-edged translucent
      // WEDGE crossing in front of the column, the derrick and the sky. Three of
      // them plus rf_rack_e put four of these across the upper half of that
      // frame; they read as glass shards, not as light. The lumens are unchanged
      // - only the haze the shell adds in front of the subject comes down.
      // 1050 rather than 1150: with the stand-off tripled the aim-point lux is
      // already up on where it was, and this trims the plinth pool the oblique
      // throw now lays down on its way to the shell.
      // 780 / 34 m / 0.42 rad, not 1050 / 60 / 0.56. The aim-point lux goes UP
      // (780 over a 17.6 m throw is 2.5 against 1050 over 25.3 m giving 1.6)
      // because the target moved down the shell toward the fixture; what comes
      // off is the REACH, which is the whole change.
      push('rf_colup_' + ui, 'mercury', ux, uy + 3.62, uz, 7600, 780, 34, 0.42, uaim,
        { haloMax: 2.2, haloGain: 0.50, beam: 0.09 });
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
    // Aim points re-solved lower and nearer than the shell centres they used
    // to point at. hero3 stands on the apron east of the bunds, and with the
    // beams running level across the tank tops the ground the camera is on got
    // nothing at all: 41.3% of that frame measured below 0.05 luminance and
    // 74.9% of its lower third did. Dropping each aim by 3-4 m and widening the
    // cone rakes the shell AND drags the bottom edge of the pool back across
    // the bund wall and the apron in front of it.
    var TF = [
      [-26.0, -62.0, -46.0, 3.4, -46.0],
      [-26.0, -22.0, -44.0, 3.2, -10.0],
      [-38.0, 20.0, -54.0, 3.6, 36.0]
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
      push('rf_tank_' + ti, 'mercury', tx, ty, tz, 6600, 900, 68, 0.95, taim,
        { haloMax: 2.4, haloGain: 0.50, beam: 0.26 });
    }

    // ---- 12-13. floods off the west rack, down onto the road ---------------------
    // RF[1] now aims WEST off the rack instead of east onto the road. The
    // cross-road junction it used to double up on is already carried by
    // rf_xroad 14 m away, and the apron between the rack and the tank bunds -
    // which is where hero3 stands and which measured 74.9% of its lower third
    // below 0.05 luminance - had no source of any kind on it.
    // ---- WHICH LEG A FLOOD IS BOLTED TO IS NOT COSMETIC --------------------
    // RF[1] used to hang off the rack's EAST leg at x = -10.8 and aim WEST at
    // the tank-farm apron, which means its whole throw crossed nine metres of
    // its own pipe rack at point-blank range. Mapped on hero2 - whose eye
    // stands on that walkway two metres behind it - the blown-white pixels
    // were 90% concentrated on a single tier-0 lagged line 3 m off the lens,
    // and neither dimming the deck lamp by 46% nor cutting the jacketing's
    // environment gain by a fifth moved the number, because the light was
    // never specular and was never the deck lamp. Moving the fixture to the
    // WEST leg line puts the rack behind it instead of in front of it: same
    // aim point, same 820 cd, and the near lines drop out of the frame's
    // exposure entirely.
    //
    // The fifth column is the side of the bent the head brackets off.
    var RF = [[-10.8, -34.0, -3.0, -40.0, 1], [WR_X - WR_HALF - 0.2, 2.0, -30.0, -8.0, -1]];
    for (var ri = 0; ri < RF.length; ri++) {
      var rx = RF[ri][0], rz = RF[ri][1], rsd = RF[ri][4];
      var ry = gy(rx, rz) + WR_TIERS[2] + 0.35;
      var raim = [RF[ri][2], gy(RF[ri][2], RF[ri][3]), RF[ri][3]];
      B.paint = 'steel';
      B.strut('struct', rx, ry, rz, rx + rsd * 0.85, ry + 0.30, rz, 0.07, 0.07);
      floodHead(rx + rsd * 0.95, ry + 0.30, rz, raim, 1.30, false);
      // 6800 K. These are the only cold light landing on the ROAD, which is the
      // bottom third of the signature frame; at 5200 the carriageway was pure
      // sodium and the frame had no cool anywhere below the skyline.
      push('rf_rack_' + ri, 'mercury', rx + rsd * 0.95, ry + 0.30, rz, 6800, 820, 42, 0.78, raim,
        { haloMax: 2.0, haloGain: 0.48, beam: 0.45 });
    }

    // ---- 14. flood off the east rack, across at the columns -----------------------
    // ---- SODIUM, NOT MERCURY, AND IT IS THE FOURTH COLD SOURCE ON THE COLUMNS ----
    // This was the last of the four fixtures putting 6800 K light on the section
    // of shell between 14 and 20 m - the transition band where the cold foot has
    // to hand over to the fire. A cold unit there does not just fail to state
    // the brief, it CANCELS it: the flare's 1950 K arriving on the same plate
    // averages to white, which is precisely what round 3 measured as a "dead-even
    // grey wash" and tried to fix by moving the ratio instead of the geometry.
    //
    // At 2150 K on a 7.4 m rack bent throwing ACROSS and slightly UP, it is in
    // the fire family by the rule at the head of this function, and it is the
    // one fixture that can put warm light on the column row from a height the
    // ground cannot reach. Its glass flips warm with it - a cold-lensed fitting
    // throwing sodium is the tell that a lamp was retuned without its geometry.
    (function () {
      var x = ER_X + ER_HALF - 0.2, z = -46.0;
      var y = gy(x, z) + ER_TIERS[1] + 0.35;
      var aim = [26.0, y + 10.0, -44.0];
      B.paint = 'steel';
      B.strut('struct', x, y, z, x + 0.8, y + 0.25, z, 0.07, 0.07);
      floodHead(x + 0.9, y + 0.25, z, aim, 1.30, true);
      // beam 0.07: same finding as the column uplights. This cone runs 14 m
      // diagonally up across hero2's sky and was one of the four pale wedges.
      push('rf_rack_e', 'sodium', x + 0.9, y + 0.25, z, 2150, 780, 44, 0.78, aim,
        { haloMax: 2.2, haloGain: 0.70, beam: 0.07 });
    })();

    // ---- 15-17. the pump house interior ------------------------------------------
    // MEASURED FAILURE AND WHY. Three battens at 235 cd with a 19 m range over a
    // 22 m hall means every point of the floor is inside every fixture's throw,
    // so the three of them summed to a flat sheet: the floor measured 0.777,
    // 0.810, 0.820, 0.816, 0.795, 0.752 at successive depth bands - 0.07 of
    // variation over 20 m - and the ceiling sat at 0.168, so the brightest
    // surface in the room was the floor and the whole hall read as a lightbox.
    //
    // A batten at 5.3 m does not need 19 m of range; it needs about twice its
    // own mounting height, which is what makes the bay BETWEEN two battens go
    // dark. 118 cd at 9.5 m gives 4.2 lux directly under a fixture and about
    // 1.4 lux at the mid-bay 3.2 m away, which is a 3:1 scallop - a rhythm you
    // can see down a hall instead of a wash.
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
      // NO CONE. lighting.js turns a cone into a SpotLight, and a spot aimed at
      // the floor is a reflector - which a bare open-channel fluorescent batten
      // is not. Modelling them as spots is why the hall measured
      // vertical_imbalance 0.65: every lumen went to the slab and the roof deck
      // 1.1 m above the tubes got nothing at all, so the ceiling sat at 0.168
      // and the floor was the brightest surface in the room. As point sources
      // at 92 cd they light the deck, the purlins and the top of both side
      // walls as well as the floor, which is what a batten does and what the
      // top half of the frame needed.
      // 6600 K, not 5800. MEASURED: the hall is designed as "a dark tube with a
      // cold fluorescent rhythm down it and one warm sodium wedge at the near
      // floor" and it photographed 89.7% warm against 7.1% cool - the exact
      // inverse. Cooling the cladding and the roof deck took it to 83/13, and the
      // rest is the key itself. This level has already measured the same lesson
      // twice on its mercury units (see note 2 at the head of the rig): under a
      // warm grade with a warm global key, a source that is merely "not sodium"
      // reads WHITE, and white is not the other half of a warm/cool split. Every
      // other cold fixture here runs 6400-7600 K and the battens have to sit in
      // the same family or the one interior in the level is not a cold room.
      push('rf_ph_' + pi, 'fluoro_cold', px2, pyy - 0.06, pz2, 6600, 92, 10.0, 0,
        null, { haloMax: 1.5, haloGain: 0.42 });
    }

    // ---- 18. THE LOADING-BAY LIGHT INSIDE THE ROLL SHUTTER -------------------------
    // It was a 2050 K wall pack OUTSIDE the shutter aimed 6.5 m out onto the
    // apron - which is what a wall pack does, and which put not one photon into
    // the one interior the level publishes. The `interior` framing stands 1.9 m
    // inside that shutter and photographed as a beige barn with no sodium, no
    // fire and no colour in common with the other four poses: saturation 0.211
    // against hero1's 0.497.
    //
    // The fixture is now the bay light on the INSIDE face of the door head,
    // which is what a loading bay really has, and it is aimed down and west
    // into the hall. It stands 1.5 m behind the published eye, so its pool
    // lands on the near floor at the bottom of the frame: one warm wedge in a
    // cold room, the same 2050 K sodium the masts outside are running, and it
    // still spills out through the open shutter to carry the light shaft.
    (function () {
      var x = PH_X1 - 0.55, y = phc.floorY + 4.35, z = PH_DOOR_Z;
      var aim = [PH_X1 - 6.2, phc.floorY, PH_DOOR_Z];
      B.paint = 'steel';
      B.strut('struct', PH_X1 - 0.08, y + 0.28, z, x, y, z, 0.06, 0.06);
      floodHead(x, y, z, aim, 1.05, true);
      // 145, not 330. At 330 with a 16 m throw this put 17 lux on floor 4 m
      // away against the battens' 4.2, blew 1.17% of the frame at the bottom
      // edge and held vertical_imbalance inverted at 0.70. 145 over 12 m gives
      // about 7 lux on the near floor: still clearly the warmest thing in the
      // room and still the only sodium in it, without being the brightest
      // surface in the frame.
      push('rf_ph_door', 'sodium', x, y, z, 2050, 64, 10, 1.05, aim,
        { haloMax: 2.0, haloGain: 0.75, beam: 0.55 });
    })();

    // ---- 19. THE GATE TOWER --------------------------------------------------
    // RE-ALLOCATED FROM THE HEATER PLATFORM, and this is the finding of the
    // round. lv_overview - the establishing frame - measures a bottom-third
    // median of 0.043 with 59.7% of its pixels under 0.05, and the bottom row of
    // an 8x8 grid reads 0.033-0.044 in ALL EIGHT cells. props_refinery already
    // stands two containers, two skips and a compound in that band; they measure
    // 0.034-0.16. The content is there and it cannot be seen, because the site
    // runs z -94..76 and the last road mast is at z = +44: the southern thirty
    // metres, which is the entire gate approach and the whole foreground of the
    // establishing shot, had no fixture of any kind.
    //
    // What it spends is the old `rf_heater` - 430 cd aimed at the north face of
    // a box 75-135 m from the two framings that can see it at all, and the
    // dimmest cone in the rig. Its FIXTURE, its bracket and its emissive lens
    // are still built below, and the heater keeps its burner-deck light shaft,
    // its glowing sight ports and a new emissive platform batten, so it still
    // reads as a fired heater - what it stops doing is spending a practical on a
    // wash nobody photographs.
    //
    // Solved, not chosen: I = E * d^2 for 1.6 lux at 30 m over the bay row gives
    // 1440. A truck park is the brightest ground on a refinery at night and a
    // four-head tower is what puts it there. It is MERCURY at 6600 K for the
    // second reason this fixture exists - the establishing frame measured 83.3%
    // of its saturated pixels warm against 12.6% cool, and this is the only
    // source that can put a large cold pool anywhere in it.
    (function () {
      var x = 21.0, z = 60.0;
      var g0 = gy(x, z);
      var headY = g0 + 15.40;
      var aim = [10.0, gy(10.0, 62.0), 62.0];
      B.paint = 'wall';
      B.box('wall', 1.30, 0.70, 1.30, x, g0 + 0.16, z, 0.03);
      B.paint = 'steel';
      B.cyl('struct', 0.16, 0.30, 15.0, x, g0 + 7.6, z, 0, 0, 0, 12);
      B.cyl('struct', 0.44, 0.44, 0.07, x, g0 + 0.54, z, 0, 0, 0, 14);
      // the head frame: a 3.4 m channel cross with four reflectors on it, plus
      // the maintenance basket rail that every raise-and-lower tower carries
      B.box('struct', 3.40, 0.13, 0.14, x, headY + 0.34, z, 0.012);
      B.box('struct', 0.14, 0.13, 1.90, x, headY + 0.34, z, 0.012);
      B.strut('struct', x, headY - 0.95, z, x - 1.55, headY + 0.28, z, 0.075, 0.075);
      B.strut('struct', x, headY - 0.95, z, x + 1.55, headY + 0.28, z, 0.075, 0.075);
      B.railRing(x, z, 0.95, headY - 1.55, 1.05, 12);
      B.ring('grate', 0.34, 0.98, x, headY - 1.55, z, 12);
      B.ladder(x - 0.42, z, g0 + 0.9, headY - 1.7, Math.PI, true);
      floodHead(x - 1.30, headY, z, aim, 1.35, false);
      floodHead(x - 0.44, headY, z, [aim[0] + 5.0, aim[1], aim[2] - 9.0], 1.35, false);
      floodHead(x + 0.44, headY, z, [30.0, aim[1], 66.0], 1.35, false);
      floodHead(x + 1.30, headY, z, [38.0, aim[1], 52.0], 1.35, false);
      // riser conduit, the isolator cabinet at the base and its kerb
      B.paint = 'steel';
      B.tube('rust', x + 0.32, g0 + 0.6, z, x + 0.32, headY - 0.5, z, 0.040, 6);
      B.paint = 'paint';
      B.box('clad', 0.62, 1.05, 0.40, x + 0.85, g0 + 0.54, z + 0.42, 0.014);
      B.paint = 'flat';
      decalCard(B, CELL.hazard, x, g0 + 0.05, z, 2.6, 0.60, 'y', 0.4);
      decalCard(B, CELL.danger, x + 0.85, g0 + 0.85, z + 0.63, 0.55, 0.42, 'z');
      B.paint = 'steel';
      self.addCollider(x, g0 + 7.6, z, 0.36, 7.6, 0.36, 'metal');
      push('rf_gate', 'mercury', x, headY, z, 6600, 1440, 70, 1.30, aim,
        { haloMax: 2.6, haloGain: 0.52, beam: 0.30 });
    })();

    // ---- the heater platform, now a FIXTURE rather than a practical ----------
    // Emissive only. A twin-tube batten along the access platform's handrail and
    // a second over the burner deck: both read as sources under the bloom, both
    // cost nothing against the cap, and between them the heater keeps a lit
    // walkway line and a lit underside without owning a light.
    (function () {
      var ht = self.anchors.heater;
      var x = HT_X0 - 1.5, y = (ht.platformY || (gy(HT_X0, HT_Z0) + 9.5)) + 2.4, z = HT_Z0 - 1.1;
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 2.4, x, y - 1.2, z, 0, 0, 0, 6);
      floodHead(x, y, z, [HT_X0 + 6.0, y - 6.0, HT_Z0 - 0.4], 1.2, false);
      // the platform batten run: four fittings down the walkway edge
      for (var hb = 0; hb < 4; hb++) {
        var hbx = HT_X0 - 0.4 + hb * ((HT_X1 - HT_X0 + 0.8) / 3);
        var hby = (ht.platformY || (gy(HT_X0, HT_Z0) + 9.5)) + 1.32;
        B.paint = 'paint';
        B.box('clad', 0.16, 0.13, 1.05, hbx, hby + 0.09, HT_Z0 - 1.22, 0.01);
        B.paint = 'flat';
        B.box('lamp_w', 0.10, 0.05, 0.92, hbx, hby, HT_Z0 - 1.22, 0.006);
        B.paint = 'steel';
        B.cyl('struct', 0.028, 0.028, 0.40, hbx, hby + 0.30, HT_Z0 - 1.22, 0, 0, 0, 5);
      }
      // and the burner-deck fitting under the box, which is what makes the
      // heater's underside read as a fired one
      B.paint = 'flat';
      B.box('lamp_w', 3.6, 0.05, 0.16, (HT_X0 + HT_X1) * 0.5,
        gy(HT_X0, HT_Z0) + 1.62, HT_Z0 + 1.2, 0.006);
      B.paint = 'steel';
    })();

    // ---- 20. the control building's porch ------------------------------------------
    (function () {
      var cb = self.anchors.control;
      // 420 cd over 40 m aimed 13 m out, not 210 over 24 aimed at its own step.
      // MEASURED on lv_overview: the apron between the control building and the
      // road is the bottom-right quarter of the establishing frame, it is in
      // the cast shadow of the plant (see the note on lightShafts) and its
      // in-shadow fill is 0.033, and this is the only fixture within 30 m of
      // it. A porch light that lights nothing but its own doorstep is a lamp
      // spent on nobody's framing.
      var x = CB_X0 - 0.55, y = cb.centre.y + 3.55, z = CB_Z0 + 3.2;
      var aim = [CB_X0 - 13.0, cb.centre.y, CB_Z0 + 9.0];
      B.paint = 'steel';
      B.strut('struct', CB_X0 - 0.15, y - 0.05, z, x, y, z, 0.05, 0.05);
      floodHead(x, y, z, aim, 0.95, true);
      push('rf_control', 'sodium', x, y, z, 2050, 420, 40, 0.95, aim,
        { haloMax: 2.2, haloGain: 0.75, beam: 0.35 });
    })();

    // ---- 21. THE DERRICK UPLIGHT ------------------------------------------------
    // This was a 480 cd flood aimed DOWN at the knock-out drum, and it bought a
    // pool nobody photographs. The level's actual problem was that its landmark
    // was invisible: a 47 m lattice at 0.05 albedo contrast against 110 m of
    // horizon haze, which is why the delivered signature frame showed a flame
    // sitting on a 25 px stub. Two things fix that and both are needed - the
    // orange aviation banding in SURF.derrick, and a source that MODELS the
    // steel instead of leaving it flat.
    //
    // It is a 5400 K mercury unit standing 13 m out on the pad and raking up
    // the shaft. Solved rather than tuned: I = E * d^2 for 1.6 lux on the
    // lattice at 28 m gives 1250. Every one of those lumens lands on the one
    // object in the level the whole composition depends on, and because it is
    // cold it also does the second job - it is the largest cool mass in hero1,
    // which is the frame that measured 6.0% cool.
    // ---- AND ITS AIM COMES DOWN FOR THE SAME REASON THE COLUMNS' DID --------
    // MEASURED, and it is the most legible instance of the inversion in the
    // whole level: lv_overview shows a 52 m lattice standing directly under a
    // burning flare tip and reading as a PALE BLUE-WHITE mast. The fire is 10 m
    // above the derrick head and at 8600 cd puts 86 lux on it; nothing a ground
    // fixture can do belongs up there, and a 6400 K one is fighting the level's
    // own subject.
    //
    // So the rake stops at 12 m instead of 26. Same fixture, same family, same
    // job as the column uplights - cold foot under a fire-lit top - and the
    // shorter throw at the same candela roughly triples the lux on the bottom
    // three panels and on the flare pad, which is ground the signature frame's
    // right third had nothing on.
    (function () {
      var x = FL_X + 12.5, z = FL_Z + 7.5;
      var y = gy(x, z) + 5.4;
      var aim = [FL_X - 1.5, gy(FL_X, FL_Z) + 12.0, FL_Z - 1.0];
      B.paint = 'steel';
      B.cyl('struct', 0.09, 0.13, 5.2, x, gy(x, z) + 2.6, z, 0, 0, 0, 8);
      floodHead(x, y, z, aim, 1.4, false);
      self.addCollider(x, gy(x, z) + 2.6, z, 0.25, 2.6, 0.25, 'metal');
      // beam: 0.04. MEASURED, and the single most useful number in this pass.
      // lighting.js gives every cone published by a level a full-strength
      // volumetric shell by default, and a 62 m cone of warm haze aimed
      // straight up the derrick did precisely what the halo was doing: it
      // blanketed the object it was supposed to reveal. Turning the beam off
      // keeps every one of those lumens on the STEEL.
      push('rf_flarepad', 'mercury', x, y, z, 6400, 1250, 30, 0.46, aim,
        { haloMax: 2.2, haloGain: 0.48, beam: 0.04 });
    })();

    // ---- 22. the cross-road junction ------------------------------------------------
    (function () {
      var x = 10.4, z = 17.5;
      var y = gy(x, z) + 10.8;
      var aim = [4.5, gy(4.5, 20.5), 20.5];
      B.paint = 'steel';
      B.cyl('struct', 0.12, 0.20, 10.5, x, gy(x, z) + 5.3, z, 0, 0, 0, 9);
      B.strut('struct', x, y - 0.4, z, x - 1.1, y + 0.2, z, 0.06, 0.06);
      floodHead(x - 1.2, y + 0.2, z, aim, 1.1, false);
      B.paint = 'wall';
      B.box('wall', 0.9, 0.5, 0.9, x, gy(x, z) + 0.12, z, 0.02);
      B.paint = 'steel';
      self.addCollider(x, gy(x, z) + 5.3, z, 0.26, 5.3, 0.26, 'metal');
      // COLD, not sodium. This fixture is 9 m from the hero1 standpoint and it
      // is the dominant illuminant on the bottom third of the signature frame.
      // At 1980 K it was the single biggest reason that third measured 87%
      // warm; cold, it states the brief's own sentence in one image - COLD
      // FLOODS FROM BELOW in the near field, sodium pools receding, and orange
      // fire at the end of the road.
      //
      // 6200 K, not the 5200 the note used to specify. This level has measured
      // the difference twice already (see note 2 at the head of the rig): a
      // mercury unit that is merely "not sodium" reads WHITE under a warm grade
      // with a warm key, and white is not the other half of a warm/cool split.
      // Every other cold unit here runs 6400-7600 K for exactly that reason and
      // this one has to sit in the same family or the near field reads grey.
      // The lens glass and the emissive head above are flipped cold with it -
      // a warm-glass fixture throwing blue-white light is the tell that a lamp
      // was retuned without its geometry.
      // 470, not 620. MEASURED at 640: the cold fixture stands 9 m from the eye
      // and 11 m up, so at parity with the old sodium it did not state the
      // brief, it OVERSTATED it - hero1's mean saturation fell from 0.317 to
      // 0.180 and the near field went from too orange to grey. The target is a
      // SPLIT, not a swap: at 470 the lower third measures around 60% warm to
      // 25% cool, i.e. sodium still owns the road and the cold owns the apron
      // and the kerb line, which is what "orange fire from above and cold
      // floods from below" looks like in one frame.
      // ---- 560, AND THE 470-THEN-400 TRIM IS NOW MEASURABLY THE WRONG WAY ----
      // The note above is right about what it saw and wrong about what to do
      // with it now, and the difference is the whole premise fix. It came down
      // twice because at parity with the old sodium the near field went "from
      // too orange to grey" - but that was measured when EVERYTHING ABOVE 15 m
      // WAS ALSO COLD, so a cold near field could only average with a cold far
      // field. With the column row, the derrick and the rack tops handed back to
      // the fire, the same cold on the same slab is now the other half of a
      // split rather than the second half of a wash: hero1's lower third
      // measured 56.5% warm against 8.7% cool after the premise change, i.e. the
      // near field is where the cool has gone missing.
      push('rf_xroad', 'mercury', x - 1.2, y + 0.2, z, 6800, 560, 42, 0.95, aim,
        { haloMax: 1.8, haloGain: 0.42, beam: 0.25 });
    })();

    // ---- 23. the rack walkway ---------------------------------------------------------
    // hero2 stands on this deck. Without a source ON it the whole foreground of
    // that framing is unlit grating with a bright plant behind it.
    // MEASURED, AND IT WAS THE BLOWN FRAME'S REAL SOURCE. hero2 failed the
    // exposure gate at blown_white 1.678% and the round-2 review attributed it
    // to the column uplights; the blown pixels are not there. Mapped on an 8x8
    // grid they sit 60-90% in the BOTTOM-LEFT cells, which is the top tier of
    // process line 2-4 m off the lens - lit by this fixture, which stood only
    // 2.55 m above the grating and therefore put ~28 lux on the nearest pipe
    // against 2.0 lux at the point it was aimed at. Raising it to 4.1 m and
    // trimming to 120 cd holds the aim-point lux within 15% and cuts the near
    // pipe to a third, because the near term falls as 1/d^2 and only the near
    // term moved. (The uplight change stands on its own merits: the skirts were
    // genuinely over-lit relative to the section being modelled.)
    (function () {
      var x = WR_X + WR_HALF - 1.35, z = -4.0;
      var y = gy(x, z) + WR_DECK + 4.10;
      // Aimed ACROSS the tiers, not down the walkway. With rf_rack_1 moved to
      // the outboard leg (see above) nothing lights the three tiers of line
      // that fill hero2's foreground, and a walkway lamp that only lights the
      // walkway leaves the subject of the frame in the dark: 58% of that
      // frame's lower third fell below 0.06. Raked from 4.1 m above the
      // grating at 7 m of throw it puts about 3.4 lux on the tier-2 bundle -
      // a quarter of what the misplaced rack flood was doing to it, which is
      // the difference between modelling a pipe and clipping it.
      var aim = [x - 6.5, gy(x, z) + WR_DECK + 0.35, z - 7.0];
      B.paint = 'steel';
      B.cyl('struct', 0.05, 0.05, 4.0, x, y - 2.0, z, 0, 0, 0, 6);
      floodHead(x, y, z, aim, 0.95, true);
      push('rf_deck', 'sodium', x, y, z, 2100, 390, 26, 1.05, aim,
        { haloMax: 2.0, haloGain: 0.72, beam: 0.30 });
    })();

    // ---- 24. THE WEST APRON WALL PACK ---------------------------------------------------
    // RE-ALLOCATED, not added: the rig is ON lighting.js's 24-entry cap for a
    // declarative level, so this fixture is the old `rf_catwalk` spent
    // somewhere it can be measured. That one was 150 cd sitting 25 m up over a
    // catwalk nobody stands on; its emissive head and its bracket are still
    // built below, so the note it put in the top of the hero framings survives
    // as GEOMETRY - what it stops doing is spending a practical on a pool the
    // camera never sees.
    //
    // MEASURED, and this is the finding of the round. The apron west of the
    // road (x -8..-26, z 4..24) carries the whole bottom-left of the signature
    // frame and had NO practical on it at all: the nearest fixtures are the
    // cold mast at (-9.9, 12) which is aimed AWAY from it at the road, and the
    // rack floods 9.5 m up aimed at tank shells 25 m out. hero1 came back with
    // 49.6% of its lower third below 0.06 luminance - and coverage.dead_cell
    // read 0.0 the whole time, because it thresholds the 95th percentile of an
    // 8x8 cell and one hazard stripe or traffic cone carries the p95 while the
    // cell MEDIAN is black. Measure the median.
    //
    // A wall pack on the rack's east leg line at 7.2 m raking WEST across that
    // apron is the fixture a real plant puts there (it lights the aisle a truck
    // reverses down), it is unobstructed because it stands on the near face of
    // the rack rather than inside it, and its throw crosses hero1's bottom-left
    // at 12-26 m AND hero3's aisle 30 m further north. 700 cd over 38 m gives
    // about 1.9 lux at 19 m, which is a fifth of a mast pool - a fill, not a
    // second key.
    (function () {
      var cat = (self.anchors.catwalks && self.anchors.catwalks.length)
        ? self.anchors.catwalks[self.anchors.catwalks.length - 1] : null;
      var cxq = cat ? (cat.from.x + cat.to.x) * 0.5 : 27.0;
      var czq = cat ? (cat.from.z + cat.to.z) * 0.5 : -17.0;
      var cyq = (cat ? cat.y : gy(27, -17) + CAT_Y[1]) + 2.35;
      B.paint = 'steel';
      B.cyl('struct', 0.045, 0.045, 2.3, cxq, cyq - 1.15, czq, 0, 0, 0, 6);
      floodHead(cxq, cyq, czq, [cxq, cyq - 2.4, czq], 0.9, true);

      // 5.6 m, not 7.2. SOLVED against the rack it is bolted to, not chosen:
      // the west rack's lowest tier of line sits at 4.95-5.15 m and its knee
      // braces occupy 3.9-4.65 at every bent, so a head at 7.2 m raking down to
      // the apron crosses the tier-0 bundle at x = -15 and spends its throw
      // lighting the underside of a pipe. At 5.6 m the axis passes OVER the
      // knee braces at the near leg and UNDER the bundle by the far one, so
      // every lumen reaches the paving, and the 10-degree grazing incidence at
      // 19 m is what models a flat slab.
      var x = WR_X + WR_HALF + 0.40, z = 14.0;
      var y = gy(x, z) + 5.60;
      var aim = [-26.0, gy(-26.0, 16.0) + 0.2, 16.0];
      B.paint = 'steel';
      // the bracket off the bent's east flange, and the conduit dropping to it
      B.strut('struct', x - 0.90, y, z, x - 0.10, y + 0.10, z, 0.07, 0.07);
      B.tube('rust', x - 0.95, y - 4.9, z + 0.12, x - 0.95, y - 0.1, z + 0.12, 0.030, 5);
      floodHead(x, y + 0.10, z, aim, 1.30, false);
      // 800, not 600, for the same reason rf_xroad went up: this is the other
      // cold source on the ground the signature frame stands on, and the cool
      // half of the split now has to live down here.
      push('rf_wapron', 'mercury', x, y + 0.10, z, 6800, 800, 38, 0.86, aim,
        { haloMax: 2.0, haloGain: 0.48, beam: 0.50 });
    })();

    // ==========================================================================
    // 25-30. THE SIX FIXTURES THE RAISED BUDGET BUYS
    //
    // Every previous round of this file ends the same way - "re-allocated, not
    // added: the rig is ON lighting.js's 24-entry cap and nothing here is free" -
    // and three fixtures in a row were spent by taking one away from somewhere
    // else. lighting.js has now split that cap into a BUILD count and a per-frame
    // ACTIVE count and measured what it was protecting (the per-fragment light
    // loop at ~0.05 ms each, not uniforms and not samplers), so this level
    // publishes practicals 30 / active 26 and the six below are ADDITIONS.
    //
    // None of them is decoration. Each one is placed at a region located by
    // measurement, not by eye - the 8x8 cell medians of the two framings that
    // fail the corrected dead-region gate, back-projected through the published
    // pose to world coordinates:
    //
    //   lv_overview  14.06%   cells (5,0) (5,1) (6,0) (7,0) at 0.035-0.041
    //                         -> x -25..-4, z 66..80, the site's south-west
    //                            corner, 34-54 m from a camera 30 m up
    //                and cells (6,5) (6,6) (7,5) (7,6) (7,7) at 0.034-0.037
    //                         -> x 34..52, z 50..72, the ground south and east
    //                            of the control building
    //   lv_hero3     12.50%   cells (1,7) (2,6) (2,7) (3,6) (3,7) (5,6) (5,7)
    //                         (6,7) at 0.003-0.041
    //                         -> the WEST RACK'S OUTBOARD FACE at 13-25 m and
    //                            4-12 m of height, which is the entire right
    //                            third of that framing and had no fixture on
    //                            either side of it
    // ==========================================================================

    // ---- 25. THE RACK'S WEST FACE ---------------------------------------------
    // hero3's right third is 22 bents of unlit lattice: eight of its sixteen
    // right-hand cells measure 0.003-0.041 against a 0.045 floor, and three of
    // them are at 0.003, i.e. black. The rack is lit from the road side (rf_deck,
    // rf_rack_0) and from ON it (rf_rack_1, rf_wapron, both aimed away), so its
    // outboard flank has never had a source.
    //
    // A mast on the tank-farm apron raking EAST into it is what a plant puts
    // there - it lights the aisle between the bunds and the rack - and it is the
    // fixture that makes hero3 a composition instead of two halves: COLD steel
    // lattice on the right against the warm shells and the twilight band on the
    // left, which is the same warm/cool split the level's grade is built to
    // print. 820 cd over a 14 m throw is 4.2 lux on the tier faces.
    (function () {
      var x = -25.0, z = -30.0;
      var g0 = gy(x, z);
      var y = g0 + 9.10;
      var aim = [WR_X - WR_HALF - 0.4, g0 + 6.2, -19.0];
      B.paint = 'wall';
      B.box('wall', 0.90, 0.52, 0.90, x, g0 + 0.13, z, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.11, 0.19, 8.90, x, g0 + 4.50, z, 0, 0, 0, 9);
      B.cyl('struct', 0.30, 0.30, 0.06, x, g0 + 0.42, z, 0, 0, 0, 12);
      B.box('struct', 1.40, 0.09, 0.11, x, y + 0.26, z, 0.01);
      B.strut('struct', x, y - 0.5, z, x - 0.58, y + 0.22, z, 0.055, 0.055);
      B.strut('struct', x, y - 0.5, z, x + 0.58, y + 0.22, z, 0.055, 0.055);
      floodHead(x - 0.52, y, z, aim, 1.30, false);
      floodHead(x + 0.52, y, z, [aim[0], aim[1] - 2.0, aim[2] - 13.0], 1.30, false);
      B.tube('rust', x + 0.22, g0 + 0.5, z, x + 0.22, y - 0.4, z, 0.032, 5);
      self.addCollider(x, g0 + 4.5, z, 0.28, 4.5, 0.28, 'metal');
      push('rf_rackw', 'mercury', x, y, z, 6800, 820, 40, 0.92, aim,
        { haloMax: 2.4, haloGain: 0.50, beam: 0.28 });
    })();

    // ---- 26. THE CONTROL BUILDING'S SOUTH ELEVATION ---------------------------
    // rf_control is a porch light on the WEST face aimed further west, so the
    // 22 m south elevation - which is the face the establishing camera actually
    // sees, at 60 m - and the apron in front of it have nothing. Two of the
    // overview's dead cells are that apron and a third is the wall itself.
    // A pair of wall packs under the eaves is the fixture, and they are SODIUM
    // because they are 6 m up throwing down: the rule at the head of this
    // function, applied to a building.
    (function () {
      var cb = self.anchors.control;
      var x = CB_X0 + 6.5, z = CB_Z1 + 0.45;
      var y = cb.centre.y + 5.90;
      var aim = [CB_X0 + 2.0, cb.centre.y, CB_Z1 + 13.0];
      B.paint = 'steel';
      B.strut('struct', x, y + 0.10, CB_Z1 + 0.06, x, y, z, 0.05, 0.05);
      floodHead(x, y, z, aim, 1.05, true);
      floodHead(x + 9.0, y, z, [CB_X0 + 15.0, cb.centre.y, CB_Z1 + 11.0], 1.05, true);
      push('rf_ctrl_s', 'sodium', x + 4.5, y, z, 2100, 1150, 46, 1.10,
        [CB_X0 + 8.0, cb.centre.y, CB_Z1 + 12.0],
        { haloMax: 2.4, haloGain: 0.72, beam: 0.34 });
    })();

    // ---- 27. THE GATE TOWER'S EAST PAIR ---------------------------------------
    // The tower at (21, 60) already carries four heads and only one light: the
    // two heads aimed east at (30, 66) and (38, 52) are geometry with nothing
    // behind them, and the truck park's east half is two more of the
    // establishing frame's dead cells. A four-head tower really is four
    // luminaires, so this costs no new geometry at all - only the practical the
    // old cap would not allow. Cold, because it is a ground pool.
    (function () {
      var x = 21.0, z = 60.0;
      var headY = gy(x, z) + 15.40;
      var aim = [37.0, gy(37.0, 62.0), 62.0];
      push('rf_gate_e', 'mercury', x + 0.9, headY, z, 6600, 1280, 62, 1.22, aim,
        { haloMax: 2.4, haloGain: 0.50, beam: 0.26 });
    })();

    // ---- 28. THE SOUTH-WEST CORNER --------------------------------------------
    // Four of the overview's nine dead cells are one region: x -25..-4, z 66..80,
    // the gravel margin and the paving west of the road at the south fence.
    // props_refinery dresses it (a laydown compound, drum stacks, a skip) and
    // the last fixture of any kind north of it is the pump-house door at z 37.
    // A high mast throwing north-west across it is the answer.
    //
    // MERCURY, and this is the one place the height rule at the head of this
    // function is deliberately not applied - so it is worth saying exactly why,
    // because the rule is otherwise the whole organising idea. The rule is about
    // where light LANDS IN THE FRAME, not where the fixture hangs: a 15 m mast
    // whose pool is on the slab is "cold floods from below" as the camera reads
    // it, which is why rf_gate and the near road mast are already 6600-6800 K.
    // Measured: with this fixture published as sodium the establishing frame's
    // bottom fifth came back 75.4% warm against 1.4% cool - one orange wash
    // across the whole foreground of a level whose palette is "orange fire /
    // steel". Cold here puts a large cool pool between the two sodium road pools
    // and gives that band a rhythm instead of a dye.
    (function () {
      var x = -12.0, z = 66.0;
      var g0 = gy(x, z);
      var headY = g0 + 12.40;
      var aim = [-26.0, gy(-26.0, 74.0), 74.0];
      B.paint = 'wall';
      B.box('wall', 1.00, 0.58, 1.00, x, g0 + 0.14, z, 0.02);
      B.paint = 'steel';
      B.cyl('struct', 0.13, 0.22, 12.1, x, g0 + 6.20, z, 0, 0, 0, 10);
      B.cyl('struct', 0.34, 0.34, 0.06, x, g0 + 0.44, z, 0, 0, 0, 12);
      B.box('struct', 2.10, 0.10, 0.12, x, headY + 0.28, z, 0.01);
      B.strut('struct', x, headY - 0.6, z, x - 0.92, headY + 0.24, z, 0.06, 0.06);
      B.strut('struct', x, headY - 0.6, z, x + 0.92, headY + 0.24, z, 0.06, 0.06);
      floodHead(x - 0.80, headY, z, aim, 1.15, false);
      floodHead(x + 0.80, headY, z, [-4.0, g0, 76.0], 1.15, false);
      B.tube('rust', x + 0.26, g0 + 0.5, z, x + 0.26, headY - 0.4, z, 0.035, 5);
      B.paint = 'paint';
      B.box('clad', 0.46, 0.85, 0.32, x + 0.55, g0 + 0.44, z + 0.30, 0.012);
      B.paint = 'flat';
      decalCard(B, CELL.hazard, x, g0 + 0.05, z, 2.0, 0.55, 'y', 0.9);
      B.paint = 'steel';
      self.addCollider(x, g0 + 6.2, z, 0.30, 6.2, 0.30, 'metal');
      push('rf_swcorner', 'mercury', x, headY, z, 6600, 1120, 48, 1.05, aim,
        { haloMax: 2.6, haloGain: 0.52, beam: 0.30 });
    })();

    // ---- 29. THE PUMP HOUSE'S SOUTH GABLE -------------------------------------
    // The building reads as a dark box from the establishing mark and its own
    // apron - the ground between it and the south-west corner - is the fourth
    // dead cell of that group. A bulkhead over the personnel door is what a
    // pump hall has, it is 5.5 m up throwing down, and its spill joins rf_swcorner
    // into one continuous lit aisle instead of two isolated pools.
    (function () {
      var phc2 = self.anchors.pumpHouse;
      var x = (PH_X0 + PH_X1) * 0.5 + 3.0, z = PH_Z1 + 0.35;
      var y = phc2.floorY + 5.40;
      var aim = [x - 3.0, phc2.floorY, PH_Z1 + 9.5];
      B.paint = 'steel';
      B.strut('struct', x, y + 0.14, PH_Z1 - 0.02, x, y, z, 0.05, 0.05);
      floodHead(x, y, z, aim, 1.05, true);
      push('rf_ph_south', 'sodium', x, y, z, 2100, 720, 34, 1.05, aim,
        { haloMax: 2.2, haloGain: 0.75, beam: 0.34 });
    })();

    // ---- 30. THE COLUMN-ROW BULKHEAD, 30 m UP ---------------------------------
    // The last piece of the premise fix, and the one that could not be bought by
    // re-pointing anything: with the four cold uplights held to the bottom 16 m,
    // the only source above that on the column row is the flare 40 m away. One
    // fixture is not a lighting scheme for a 41 m can, and a real column carries
    // a bulkhead on every third platform ring for exactly this reason.
    //
    // It stands on C1's upper platform at 30 m and throws DOWN and across at
    // C2 - fire family by height, by aim and by colour - so the band between
    // 14 and 30 m, which is where the mercury units used to end and where hero1
    // measured 67.7% cool, is now warm from a source that is physically above
    // it. 640 cd over an 18 m throw is 2.0 lux, a fifth of a mast pool: it
    // MODELS the shells, it does not re-light the level.
    (function () {
      var c1 = COLS[0];
      var x = c1.x - c1.r - 1.05, z = c1.z + 0.6;
      var y = gy(c1.x, c1.z) + 30.0;
      var aim = [COLS[1].x, gy(COLS[1].x, COLS[1].z) + 17.0, COLS[1].z];
      B.paint = 'steel';
      B.strut('struct', c1.x - c1.r - 0.10, y + 0.30, z, x, y + 0.18, z, 0.06, 0.06);
      floodHead(x, y, z, aim, 1.05, true);
      push('rf_colhi', 'sodium', x, y, z, 2200, 640, 40, 1.00, aim,
        { haloMax: 2.2, haloGain: 0.72, beam: 0.14 });
    })();

    this.practicalLights = lamps;

    // ---- volumetric shafts --------------------------------------------------------
    // lighting.js solves a shaft mostly-downward from an aperture, so these are
    // the three places in the level where a real cone of light exists in air:
    // under the flare, out of the pump-house shutter, and off the heater's
    // burner deck.
    var phy = this.anchors.pumpHouse.floorY;
    this.lightShafts = [
      // Narrowed and shortened. A 6 x 26 m cone of warm haze hanging directly
      // under the flame sat exactly on the derrick and blanketed the one
      // silhouette the level cannot afford to lose.
      // MEASURED, AND THE DIAGNOSIS MOVED. The round-2 review read the pale
      // hard-edged wedge lying across the overview's apron (0.138 mean against
      // 0.034 on the paving beside it) as this cone, and it is not: rendering
      // the level with `lightShafts = []`, with every `beam` zeroed, and with
      // setShadowDistance(25) leaves that wedge unchanged to three decimal
      // places, while rendering it with castShadow cleared on every level mesh
      // lifts the paving AROUND it from 0.034 to 0.109 and leaves the wedge at
      // 0.130. The wedge is therefore not additive light at all - it is the
      // unshadowed GAP between the east rack's cast shadow and the control
      // building's, on ground whose in-shadow fill is 0.033. See the report:
      // that is a shared-system finding about shadow fill, not a cone.
      //
      // The cone still comes down, because the principle the review states is
      // right whatever drew the wedge: a shaft is only convincing as a modest
      // addition over already-lit ground. At 8 m it also stops overhanging the
      // derrick, which is the one silhouette this level cannot afford to lose.
      { origin: new THREE.Vector3(FL_X, fl.tipY - 2.0, FL_Z),
        dir: new THREE.Vector3(0.10, -1.0, 0.05).normalize(),
        width: 3.2, length: 8.0, strength: 0.28, kind: 'hero3',
        always: true, kelvin: 1950, lux: 2.2 },
      // ---- `land` AND `pool`, NEW THIS ROUND AND BOTH EARNED -----------------
      // lighting.js fades a shell's last 22% to nothing, so every cone in this
      // level stopped in mid-air a metre or two above the surface it is aimed
      // at - which is the one thing that makes a volumetric read as a decal
      // rather than as light. `land` extends the geometry past the traced floor
      // so that fade is buried and depth-clipped, and `pool` puts the soft
      // scattered ellipse where the axis actually meets the slab.
      //
      // Only the two that really do end on a surface ask for it. The flare cone
      // above hangs 8 m under a tip 58 m up and ends in open air, so it stays at
      // land 0 / pool 0 - a floor ellipse under it would be a lie and would sit
      // on the derrick. Both pools together are ONE merged additive mesh, so the
      // whole feature is a single draw call and about 64 triangles.
      { origin: new THREE.Vector3(PH_X1 + 0.05, phy + PH_DOOR_H - 1.1, PH_DOOR_Z),
        dir: new THREE.Vector3(0.62, -1.0, 0.0).normalize(),
        width: 3.6, length: 6.2, strength: 0.78, kind: 'interior',
        always: true, kelvin: 2200, lux: 4.4,
        land: 0.65, pool: 0.85, poolR: 3.4 },
      { origin: new THREE.Vector3((HT_X0 + HT_X1) * 0.5, groundY(HT_X0, HT_Z0, N) + 2.5,
          HT_Z0 - 0.4),
        dir: new THREE.Vector3(-0.20, -1.0, -0.35).normalize(),
        width: 4.6, length: 3.2, strength: 0.30, kind: 'heater',
        always: true, kelvin: 2200, lux: 2.0,
        land: 0.55, pool: 0.55, poolR: 3.0 }
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

    // ---- THE FLAME ------------------------------------------------------------
    // The level is named after it, it is the key light, it is the subject, and
    // for two rounds it was the weakest asset in the build: a smooth airbrushed
    // teardrop whose core clipped to flat cream with no internal value at all.
    //
    // THE CLIPPING WAS THE CAUSE, NOT A SYMPTOM. col0 ran 8.4 in red. postfx's
    // 'sodium' grade rolls its highlights off over a range of 8, so every
    // vertex in the bottom half of the tube landed at or above the top of that
    // roll-off and came out the same flat cream - which means the per-vertex
    // colour variation, the flicker, the core/envelope mix and the alpha notch
    // were all being computed, written, and then thrown away by the tonemap.
    // No amount of extra noise can survive a clamp. Dropping the core to 4.8
    // puts the whole body INSIDE the roll-off, where a 2:1 internal value range
    // prints as a 2:1 internal value range; the apparent brightness comes back
    // through bloom, which is what a real emitter's brightness comes from.
    //
    // 26 rings x 14 radial, not 18 x 10. A ragged silhouette is sampled off the
    // ring boundary, so at ten radial steps the outline was a 10-gon no matter
    // what the noise did to it. 364 vertices against 180 is 184 more points of
    // noise a frame on the one object the whole level is looked at through.
    //
    // The origin drops 1.2 m so the first ring is inside the tip's flared
    // muzzle: it used to terminate in a soft rounded bottom in clear air above
    // the stack, i.e. a flame that was not attached to anything.
    make('flame', fl.flame.x, fl.flame.y - 1.2, fl.flame.z, {
      rings: 26, rad: 14, h: 21.0, r0: 1.05, r1: 3.30, r2: 0.72,
      lean: 0.40, wob: 1.1, speed: 1.0, phase: 0.0,
      col0: [3.75, 1.62, 0.36], col1: [2.20, 0.66, 0.085], col2: [0.86, 0.18, 0.026],
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
    // SOOT, not steam. It came out of the tip pale grey-white, which is what a
    // cooling tower does; a flare burning heavy ends makes SOOT, and a plume
    // that is paler than the sky behind it reads as vapour. It is now dark and
    // warm at the root (lit from below by the fire it just left) and falls to a
    // near-black brown as it cools, so it draws a dark tail off a bright flame
    // instead of a white one.
    make('smoke', fl.flame.x, fl.flame.y + 17.0, fl.flame.z, {
      puffs: 26, h: 34.0, r0: 2.6, r1: 4.4, r2: 7.6,
      lean: 1.85, wob: 1.9, speed: 0.40, phase: 3.1,
      col0: [0.34, 0.155, 0.058], col1: [0.105, 0.070, 0.052], col2: [0.040, 0.034, 0.032],
      a0: 0.40, a1: 0.0
    });

    // Steam. Three vents, all at places the player can stand near, all lit by
    // the practicals they sit under - which is the only way a white plume at
    // dusk reads as vapour rather than as a hole in the frame.
    // EVERY VENT NEEDS A VENT. Three of the four steam plumes started in open
    // air with no source geometry under them, and in lv_overview and hero1 they
    // photographed as detached cotton-wool blobs hanging in the sky. Each one
    // now sits on top of a real silencer stub built by _buildVentStubs below,
    // and the first ring of each plume is INSIDE that stub.
    var ht = this.anchors.heater;
    make('steam', HT_X0 - 0.9, (ht.centre ? ht.centre.y : 0) + 12.8, HT_Z0 - 0.7, {
      puffs: 18, h: 17.0, r0: 0.40, r1: 1.55, r2: 3.4,
      lean: 1.35, wob: 1.2, speed: 0.62, phase: 1.7,
      col0: [0.60, 0.62, 0.68], col1: [0.34, 0.36, 0.42], col2: [0.15, 0.16, 0.20],
      a0: 0.40, a1: 0.0
    });
    var c2 = this.columns.length > 1 ? this.columns[1] : null;
    if (c2) {
      make('steam', c2.x + c2.r * 0.55, c2.top + 1.6, c2.z + c2.r * 0.30, {
        puffs: 16, h: 12.0, r0: 0.22, r1: 0.90, r2: 2.1,
        lean: 1.05, wob: 1.5, speed: 0.80, phase: 5.2,
        col0: [0.64, 0.67, 0.73], col1: [0.36, 0.38, 0.44], col2: [0.14, 0.15, 0.19],
        a0: 0.38, a1: 0.0
      });
    }
    make('steam', ROAD_X1 + 2.6, groundY(ROAD_X1 + 2.6, -34.0, this.noise) + 3.0, -34.0, {
      puffs: 14, h: 8.0, r0: 0.20, r1: 0.78, r2: 1.7,
      lean: 0.85, wob: 1.7, speed: 1.15, phase: 2.3,
      col0: [0.56, 0.59, 0.64], col1: [0.30, 0.32, 0.37], col2: [0.12, 0.13, 0.16],
      a0: 0.34, a1: 0.0
    });
    this._updatePlumes(0, null);
  };

  // A silencer stub for a steam vent: an elbow off the plant, a riser, a
  // perforated can and a drain. Built AFTER the plumes so each one can be
  // planted under a plume origin that already exists, and its can swallows the
  // plume's first ring - which is what stops the vapour starting in mid-air.
  LevelRefinery.prototype._buildVentStubs = function (B, N) {
    var i;
    for (i = 0; i < this.plumes.length; i++) {
      var P = this.plumes[i];
      if (P.kind !== 'steam') continue;
      var ox = P.origin.x, oy = P.origin.y, oz = P.origin.z;
      B.paint = 'lagging';
      // the riser up to the vent, coming out of whatever is below it
      B.tube('lag', ox, oy - 2.6, oz, ox, oy - 0.45, oz, 0.16, 10);
      B.paint = 'steel';
      // the silencer can, whose mouth is at the plume's first ring
      B.cyl('struct', 0.34, 0.26, 0.95, ox, oy - 0.42, oz, 0, 0, 0, 12, false);
      B.cyl('struct', 0.40, 0.40, 0.07, ox, oy + 0.04, oz, 0, 0, 0, 12, true);
      // the mounting bracket and the drain leg, so it is attached to something
      B.strut('struct', ox, oy - 1.6, oz, ox + 0.55, oy - 2.1, oz, 0.06, 0.06);
      B.tube('pipe', ox, oy - 2.4, oz, ox + 0.30, oy - 2.9, oz, 0.055, 6);
      // and the bit of lagging that has been cut back round the elbow
      B.paint = 'rusty';
      B.cyl('rust', 0.11, 0.11, 0.42, ox, oy - 2.35, oz, 0, 0, 0, 8);
      B.paint = 'steel';
      // pull the plume's root INSIDE the can
      P.origin.y = oy + 0.10;
    }
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
      // ---- THE FLAME -----------------------------------------------------------
      // A flare flame is a TURBULENT LUMINOUS BODY, not a shape with noise on
      // its edge, and the difference between the two is where the variation is
      // allowed to live. Everything below writes into three places at once -
      // the ring's own axis and radius, the vertex radius, and the vertex ALPHA
      // - from one shared displacement field, so a roll-up that pushes the
      // silhouette out also thins the tube there and opens a dark fissure
      // through it. Displace only the outline and you get a wobbly teardrop;
      // displace the density with it and you get combustion.
      //
      //   1. TWO OCTAVES on the radial field. Octave 2 runs 3.1x the spatial
      //      frequency at 0.35 of the amplitude and a third of the correlation
      //      time, so the silhouette boils between the slow rolls instead of
      //      swimming as one shape.
      //   2. PER-RING RADIUS. The same field, sampled once per ring, scales
      //      r0/r1 by +/-30%, so the body necks and bulges along its length -
      //      this is what a lofted tube cannot do by itself and it is most of
      //      why the old one read as an airbrush.
      //   3. PER-RING ALPHA NOTCH. Additive blending accumulates to a solid
      //      unless something takes density away; multiplying ring alpha by
      //      0.55 + 0.45*noise is what puts visible fissures through the body.
      //   4. The turbulence amplitude RAMPS with height, so the root is a clean
      //      jet inside the muzzle and the tip tears into fingers and embers.
      var isFlame = (P.kind === 'flame');
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
        // ---- the shared per-RING field: one number that both swells the body
        // and opens a hole in it, so the two agree instead of fighting
        var ringN = 0, notch = 1;
        if (isFlame) {
          ringN = N.perlin2(tt * 2.6 - u * 4.2, P.phase + 53.0) * 0.62 +
                  N.perlin2(tt * 7.4 - u * 12.6, P.phase + 97.0) * 0.38;
          // the root is held to shape by the muzzle; everything above is free
          rad *= 1.0 + ringN * 0.42 * M.smoothstep(0.02, 0.30, u);
          notch = 0.52 + 0.48 * M.saturate(0.5 + ringN * 0.85);
        }
        // colour and opacity fall along the axis
        var cA, cB, ct;
        if (u < 0.45) { cA = P.col0; cB = P.col1; ct = u / 0.45; }
        else { cA = P.col1; cB = P.col2; ct = (u - 0.45) / 0.55; }
        var alpha = M.lerp(P.a0, P.a1, Math.pow(u, isFlame ? 1.35 : 0.85)) * notch;
        // per-RING flicker phase: the whole flame no longer breathes as one
        var flick = isFlame
          ? 1.0 + N.fbm2(tt * 3.1 + u * 2.6, 7.3 + u * 5.1, 3, 2, 0.5) * 0.55
          : 1.0 + N.perlin2(tt * 0.7 + u * 1.2, 19.0) * 0.22;
        // turbulence ramps from a clean root to a ragged tip
        var turb = isFlame ? (0.10 + u * u * 1.15) : 0.34;
        for (var a = 0; a < P.nRad; a++) {
          var ang = a / P.nRad * Math.PI * 2;
          // octave 1: the slow roll-up vortices
          var rip = N.perlin2(tt * 2.0 + ang * 1.6 + u * 3.0, P.phase + 31.0);
          var rip2 = 0;
          // octave 2: shorter correlation time and 3.1x the frequency, so the
          // silhouette boils rather than swimming
          if (isFlame) {
            rip2 = N.perlin2(tt * 6.4 + ang * 5.0 + u * 9.3, P.phase + 71.0);
            rip = rip * 0.65 + rip2 * 0.35;
          }
          var rr = rad * (1.0 + rip * turb) * (isFlame ? (0.72 + flick * 0.34) : 1.0);
          // detached wisps at the very tip: one radial spike in six pinches to
          // nothing and one blows out, which is what breaks a smooth outline
          if (isFlame && u > 0.62) {
            var tipN = N.perlin2(tt * 4.2 + ang * 3.3, P.phase + 113.0);
            rr *= 1.0 + tipN * (u - 0.62) * 3.6;
            if (rr < 0.02) rr = 0.02;
          }
          var i3 = (r * P.nRad + a) * 3, i4 = (r * P.nRad + a) * 4;
          pos[i3] = cxr + Math.cos(ang) * rr;
          pos[i3 + 1] = cyr;
          pos[i3 + 2] = czr + Math.sin(ang) * rr;
          // the core/envelope boundary was a hard step; softening it per vertex
          // against the same noise is what removes the airbrushed edge
          var mixJ = isFlame ? M.saturate(ct + rip * 0.34 * (0.3 + u)) : ct;
          // the fissure: where the high-frequency octave says the sheet is thin
          // the additive tube must ADD LESS, or the body accumulates to a solid
          // whatever the silhouette is doing
          // The fissure. Two fields, and they are decorrelated on purpose: one
          // rolls UP the body with the convection (it is the same octave the
          // silhouette boils on, so a bulge and a thinning happen together,
          // which is what a vortex is), the other wraps AROUND it so the
          // fissures run diagonally rather than as vertical stripes.
          var vort = isFlame
            ? N.perlin2(ang * 2.3 - tt * 1.7, u * 6.1 - tt * 3.4 + P.phase) : 0;
          var thin = isFlame
            ? (0.34 + 0.66 * M.saturate(0.5 + (rip2 * 0.62 + vort * 0.80)))
            : 1.0;
          col[i4] = M.lerp(cA[0], cB[0], mixJ) * flick;
          col[i4 + 1] = M.lerp(cA[1], cB[1], mixJ) * flick;
          col[i4 + 2] = M.lerp(cA[2], cB[2], mixJ) * flick;
          col[i4 + 3] = alpha * thin;
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
      // PER-ENTRY hash, taken off the merged transform's translation. Concrete
      // is placed in POURS and no two pours cure the same colour, but a
      // function of vertex position cannot express that: adjacent bays share
      // their corner vertices, so any world-space hash interpolates into a
      // gradient across the joint instead of stepping at it. Hashing the
      // entry's own origin gives a hard break exactly where the shutter was.
      var em = ent.matrix.elements;
      var bayH = (Math.sin(em[12] * 0.7311 + em[13] * 1.2917 + em[14] * 0.4271) *
        43758.5453) % 1;
      if (bayH < 0) bayH += 1;
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
      if (key === 'far_light') { mode = 'farlight'; }
      else if (key === 'decal' || key === 'lamp_w' || key === 'lamp_c' ||
          key === 'lamp_r' || key === 'lamp_sky') {
        mode = 'flat';
      } else if (key === 'far') { mode = 'far'; }
      else if (key === 'sandy') { mode = 'sand'; }
      else if (key === 'grit') { mode = 'grit'; }
      else if (key === 'joint') { mode = 'joint'; }
      else if (key === 'kerb') { mode = 'kerb'; }
      else if (key === 'tank') { mode = (mode === 'seam') ? 'seam' : 'tankshell'; }
      else if (key === 'lag') { mode = (mode === 'jacket') ? 'jacket' : 'lagging'; }
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
          var hW = y - siteGrade(x, z, noise);
          var gw = M.saturate(0.14 + 0.26 * (noise.fbm3(x * 0.30, y * 0.30, z * 0.30, 3) * 0.5 + 0.5));
          gw += M.smoothstep(1.4, 0.02, hW) * 0.26;
          gw += M.smoothstep(0.56, 0.92,
            noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 1.7, y * 0.14, 3) * 0.5 + 0.5) *
            M.saturate(1 - Math.abs(ny)) * 0.24;
          // ---- DIFFERENTIAL WEATHERING BETWEEN POURS ------------------------
          // +/-0.09 of grime on the bay hash. It is small on purpose: what makes
          // an in-situ wall read is not that one bay is dark, it is that the
          // BOUNDARY between two bays is a step rather than a blur.
          gw += (bayH - 0.5) * 0.26;
          // ---- WEEP FROM THE COPING ------------------------------------------
          // Run-off leaves the drip nose and runs DOWN, fading over about two
          // metres, gated by a 0.35 m period noise along the run so only some
          // of the wall streaks. This is the one piece of macro storytelling a
          // retaining wall always has and it was completely absent.
          var runL = (Math.abs(nx) > Math.abs(nz)) ? z : x;
          var wgate = M.smoothstep(0.42, 0.86,
            noise.fbm2(runL * 2.9, 17.3, 2) * 0.5 + 0.5);
          gw += M.smoothstep(0.0, 2.2, 1.95 - hW) * wgate *
            M.saturate(1 - Math.abs(ny)) * 0.30;
          var ew = M.smoothstep(0.64, 0.95, noise.fbm3(x * 1.0, y * 0.9, z * 1.0, 2) * 0.5 + 0.5) * 0.26;
          ew += M.saturate(ny) * 0.12;
          r = 1 - M.saturate(gw) * 0.62; g = 1; b = 1 - M.saturate(ew);
        } else if (mode === 'block') {
          var gb = M.saturate(0.16 + 0.28 * (noise.fbm3(x * 0.7, y * 0.7, z * 0.7, 3) * 0.5 + 0.5));
          r = 1 - gb * 0.55; g = 1; b = 1 - M.saturate(ny) * 0.22;
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else if (mode === 'farlight') {
          // The aerial fade for the far plant's own lights. An additive sprite
          // must not take three.js fog - fog LERPS toward the fog colour, which
          // on an additive surface brightens the far ones instead of dimming
          // them - so the falloff is written here, where it can also carry a
          // little per-lamp variation (no two sodium fittings on a plant are the
          // same age) and a warm shift with distance through the haze.
          var dL = Math.sqrt(x * x + z * z);
          var fadeL = 1.20 - M.saturate((dL - 110) / 240) * 0.72;
          var jitL = (Math.sin(x * 0.7311 + z * 1.2917 + y * 0.4271) * 43758.5453) % 1;
          if (jitL < 0) jitL += 1;
          fadeL *= 0.62 + jitL * 0.62;
          r = fadeL * 1.02; g = fadeL * 0.94; b = fadeL * 0.80;
        } else if (mode === 'joint') {
          // A saw cut fills with dirt, and it fills unevenly: it is deepest and
          // dirtiest where the traffic crosses it and half weathered out where
          // nothing drives. A joint of exactly one value reads as a drawn line.
          var vJ2 = 0.72 + (noise.fbm2(x * 0.9 + 12, z * 0.9 - 5, 3) * 0.5 + 0.5) * 0.62;
          vJ2 *= 1 - M.smoothstep(9.0, 1.0, Math.abs(x - ROAD_CX)) * 0.22;
          r = vJ2 * 1.02; g = vJ2 * 0.99; b = vJ2 * 0.96;
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
          // REWRITTEN. The previous pass modulated VALUE only and left the hue
          // to the ship_hull map, whose multi-hue macro blotching printed as
          // CAMOUFLAGE: soft airbrushed patches of blue-grey, ochre and red
          // sitting mid-shell with no relationship to the plate courses, the
          // seams, the penetrations or gravity.
          //
          // Corrosion on a storage tank is DIRECTIONAL and SOURCED. It starts
          // at a horizontal - the roof coping, a course seam, a nozzle pad -
          // and runs DOWN from it, fading over a metre or two. It pools at the
          // shell-to-annular-plate joint at grade as a continuous tide band. It
          // never appears as an isolated cool blotch halfway up a plate, so the
          // cool component is removed outright: oxide runs ochre -> red-brown
          // and nothing else. This pass therefore drives the multiplier from
          // (a) height above the nearest seam below, (b) height above grade,
          // and only then (c) a little noise for variety.
          // The datum is the BUND FLOOR, not the site grade: a tank stands
          // inside a dished bund 0.55 m below grade, so measuring from
          // siteGrade put every value course half a metre out of register with
          // the weld ring it is supposed to be bounded by. 2.08 m is the course
          // the geometry above actually rolls (12.5 m in six).
          var hAbove = y - (siteGrade(x, z, noise) + BUND_FLOOR * bundF(x, z));
          var COURSE = 2.08;
          // ---- THE COURSE IS A PROPERTY OF THE ENTRY, NOT OF THE VERTEX ------
          // MEASURED, and it is why the plate courses never read. Each course is
          // its own B.cyl, so its bottom ring evaluates floor(h/2.08) = k and its
          // TOP ring evaluates k+1 - which means the per-course value hash was
          // being interpolated from one course's number to the next one's across
          // the height of every single can. Thirty-six courses of authored value
          // break came out as one continuous vertical gradient.
          //
          // The entry's own translation is at the middle of its course, so it
          // yields exactly one number per can and the break lands on the weld
          // ring where the geometry already puts a seam. This is the same reason
          // buildColumns pushes its jacket value through B.tint rather than
          // computing it from y, and the same reason `bayH` above exists.
          var course = Math.floor((em[13] - (siteGrade(em[12], em[14], noise) +
            BUND_FLOOR * bundF(em[12], em[14]))) / COURSE);
          var cn = (Math.sin(course * 12.9898 + 4.7) * 43758.5453) % 1;
          if (cn < 0) cn += 1;
          // ---- base plate value: each course was painted in a different year.
          // 0.84-1.14 rather than 0.90-1.05: at 1.17:1 the courses were inside
          // the noise on the shell itself and a 29 m cylinder read as one
          // smooth grey tube from 47 m. 1.36:1 is a third of a stop between
          // neighbours, which is what a repainted course really looks like and
          // what survives the grade.
          var v3 = 0.84 + cn * 0.30;

          // ---- STREAK MASK. Distance below the seam that starts the streak,
          // falling off over ~1.6 m, gated by an angular noise so only some
          // arcs of each course actually weep.
          // ---- THE STREAK RUNS DOWN FROM THE SEAM, NOT UP FROM IT -----------
          // `hAbove - course * COURSE` is the height above the seam at the
          // BOTTOM of the course, so with smoothstep(1.7, 0) the stain was
          // strongest just above each weld ring and faded upward - water running
          // uphill. The comment beside it has always claimed "distance below the
          // seam". Measuring down from the ring ABOVE is one term and it is what
          // sources the stain on the horizontal that actually sheds the water.
          //
          // 0.85 m of run, not 1.7. At 1.7 the streak covered 82% of every 2.08 m
          // course, so `oxide` was on almost the whole shell and a plate that
          // should read as cool grey steel came back peach-cream. A weep is a
          // local mark under a specific ring; it is not a coat.
          var below = M.saturate((course + 1) * COURSE - hAbove);
          var seamRun = M.smoothstep(0.85, 0.0, below);
          // the angular gate: low frequency around the shell, decorrelated per
          // course so two courses never streak in the same place.
          // 0.5 and TWO octaves, not 1.3 and three: a 40-segment shell steps
          // 0.157 rad between vertices, and at 1.3 x 3 octaves the top octave's
          // period was shorter than that step - so the gate itself was aliasing
          // and scattering the oxide as per-vertex freckles. Same Nyquist
          // argument as the noise term below; see the note there.
          var ang = Math.atan2(nz, nx);
          var gate = noise.fbm2(Math.cos(ang) * 0.5 + course * 7.3,
                                Math.sin(ang) * 0.5 - course * 4.1, 2) * 0.5 + 0.5;
          gate = M.smoothstep(0.50, 0.86, gate);
          var streak = seamRun * gate;
          // the wind girder at the top is a horizontal that catches everything
          // blown up the shell, so the course under it weeps hardest
          streak *= 0.70 + M.smoothstep(6.0, 10.6, hAbove) * 0.80;

          // ---- TIDE BAND. Standing washdown and blown grit sit against the
          // annular plate; the bottom 1.2 m of every tank in the world is dark.
          var tide = M.smoothstep(1.35, 0.10, hAbove);

          // ---- OXIDE. Ochre through red-brown, never cool.
          // ---- NYQUIST. THIS IS WHERE THE "MEASLES" CAME FROM ----------------
          // MEASURED at 2.4x on a 30 m crop of T2: the shell is covered in
          // discrete soft ochre OVALS about half a metre across, evenly scattered
          // - and for three passes they were blamed on the albedo map. They are
          // not in the map. This line was sampling a noise field with a ~1.1 m
          // period on a shell whose vertices are 2.3 m apart around the
          // circumference (40 segments on a 14.5 m radius) and 2.08 m apart up
          // it. That is a factor of four ABOVE the geometry's sampling rate, so
          // every vertex got an uncorrelated value and the rasteriser
          // interpolated it across a 2.3 m quad: the "freckle" is one lerped
          // aliasing cell.
          //
          // A per-vertex term cannot carry anything finer than the vertex grid,
          // full stop. Everything below 5 m on this surface is the MAP's job
          // (now at a 0.57 m period, see SURF.tank) and everything above it is
          // this function's. 0.15 is a 6.7 m period, which the grid resolves.
          var oxide = M.saturate(streak * 1.15 + tide * 0.80);
          oxide *= 0.66 + (noise.fbm3(x * 0.15, y * 0.12, z * 0.15, 2) * 0.5 + 0.5) * 0.72;
          oxide = M.saturate(oxide);
          v3 *= 1 - tide * 0.34 - oxide * 0.16;
          if (mode === 'seam') v3 *= 0.80;
          var glowFace = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          v3 *= 1 + glowFace * 0.34;
          // multiply toward 0xa05a28-ish: red held, green cut, blue cut hard
          r = v3 * (1.00 + oxide * 0.40);
          g = v3 * (1.00 - oxide * 0.34);
          b = v3 * (1.02 - glowFace * 0.14 - oxide * 0.74);
        } else if (mode === 'jacket') {
          // The column shells and their banding rings. The COURSE value comes
          // from the per-entry tint (see buildColumns) so it can be a hash of
          // the course index rather than a function of world height - a sine in
          // y would put the same bright band on the horizontal lagged pipework
          // that shares this bucket, and would phase-lock all four columns.
          // What is left here is the small stuff: sheet dents, the dirt that
          // collects on a lap, and the glow-facing lift.
          // Frequencies solved against the geometry, not chosen: a column shell
          // is 22 segments on a 2.1-3.5 m radius, so its vertices are 0.6-1.0 m
          // apart and its courses are 1.08 m high. Anything above about 0.25
          // cycles per metre aliases into the same freckle the tank shell had -
          // see the Nyquist note in `tankshell`. The fine grain is the map's.
          var vJk = 0.90 + (noise.fbm3(x * 0.20, y * 0.15, z * 0.20, 3) * 0.5 + 0.5) * 0.20;
          vJk *= 1 - M.smoothstep(0.70, 0.96,
            noise.fbm3(x * 0.42, y * 0.30, z * 0.42, 2) * 0.5 + 0.5) * 0.32;
          // vertical run-off under every lap, keyed on the seam noise
          vJk *= 1 - M.smoothstep(0.62, 0.94,
            noise.fbm2(Math.atan2(nz, nx) * 1.1, y * 0.12, 3) * 0.5 + 0.5) * 0.20;
          var gfJ = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          vJk *= 1 + gfJ * 0.16;
          r = vJk * 0.970; g = vJk * 0.995; b = vJk * 1.055;
        } else if (mode === 'lagging') {
          // Aluminium jacketing. Bright, banded, and dented - the bands are
          // baked as value here because the geometry is only 22-sided.
          // Same Nyquist argument as `jacket` and `tankshell`, and the sine was
          // the worst offender in the file: a 1.5 m period band on the reboiler,
          // which is a 16-segment cylinder with ONE height division over 5.4 m -
          // two vertex rings, five metres apart, sampling a one-and-a-half-metre
          // wave. The reboiler 20 m from the hero1 mark came back covered in the
          // identical ochre freckle the tank shells had.
          var band = 0.90 + Math.abs(Math.sin(y * 0.85 + x * 0.12)) * 0.11;
          var v4 = band * (0.90 + (noise.fbm3(x * 0.20, y * 0.14, z * 0.20, 3) * 0.5 + 0.5) * 0.28);
          v4 *= 1 - M.smoothstep(0.70, 0.96,
            noise.fbm3(x * 0.40, y * 0.28, z * 0.40, 2) * 0.5 + 0.5) * 0.30;   // dents and dirt
          var gf2 = M.saturate(nx * GLOW_X + nz * GLOW_Z);
          v4 *= 1 + gf2 * 0.13;
          r = v4 * 0.970; g = v4 * 0.995; b = v4 * 1.060;
        } else if (mode === 'refractory') {
          // A column skirt is a 20-segment cylinder of radius 2.2-3.6 with one
          // height division over 2.6 m, and the heater's radiant box is a single
          // 18 x 13 m bevelled box. Both are painted from four to eighty
          // vertices; frequencies above ~0.2/m alias. See `tankshell`.
          var v5 = 0.86 + (noise.fbm3(x * 0.18, y * 0.18, z * 0.18, 3) * 0.5 + 0.5) * 0.30;
          v5 *= 1 - M.smoothstep(0.60, 0.94, noise.fbm3(x * 0.40, y * 0.20, z * 0.40, 2) * 0.5 + 0.5) * 0.26;
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
          // The cladding sheets are single boxes up to 22 m long with two
          // vertices along them, so the same Nyquist limit applies here as on the
          // tank shell: the corrugated MAP carries everything finer than a few
          // metres and this term carries only the broad wash.
          var v8 = 0.86 + (noise.fbm3(x * 0.16, y * 0.14, z * 0.16, 3) * 0.5 + 0.5) * 0.32;
          // streaking below every fixing line, and a rust bloom at the base
          v8 *= 1 - M.smoothstep(0.62, 0.95, noise.fbm2((x + z) * 0.30, y * 0.14, 3) * 0.5 + 0.5) * 0.24;
          // ---- RUST BELONGS AT THE BASE, NOT EVERYWHERE --------------------
          // MEASURED on lv_interior after the cladding went cool: the roof deck
          // is the top third of that framing and it came back a heavy orange-
          // brown speckled plane, i.e. the warmest and busiest surface in a room
          // the level's own brief calls cold. The base term is right - sheet does
          // corrode from the ground up - but the SCATTERED term was a free 0.45
          // of rust anywhere the noise happened to be high, including 7 m up on
          // the underside of a roof where water has never stood. It comes down to
          // 0.24, and the warm skew with it, so rust is a feature of the bottom
          // metre and a hint above it rather than a coat over the whole hall.
          var rustF = M.smoothstep(1.2, 0.05, y - siteGrade(x, z, noise)) * 0.55;
          rustF = Math.max(rustF, M.smoothstep(0.70, 0.96,
            noise.fbm3(x * 0.28, y * 0.22, z * 0.28, 3) * 0.5 + 0.5) * 0.24);
          if (mode === 'shutter') v8 *= 0.90;
          r = v8 * (1 + rustF * 0.34); g = v8 * (1 - rustF * 0.05); b = v8 * (1 - rustF * 0.30);
        } else if (mode === 'mesh') {
          var v9 = 0.80 + (noise.fbm2(x * 0.5, y * 0.5, 2) * 0.5 + 0.5) * 0.26;
          r = v9 * 1.02; g = v9; b = v9 * 0.96;
        } else if (mode === 'glass') {
          // A lit control room seen from outside at dusk: the glass is the
          // brightest thing on the building and it is warm-cool split by pane.
          // keyed on x + z, not z alone: the SOUTH elevation's panes vary in x
          // and the old form gave every one of them the same number, which is
          // half of why five identical blown rectangles shipped.
          var pane = Math.floor(x / 2.4) * 7 + Math.floor(z / 2.2);
          var pn = (Math.sin(pane * 12.9898) * 43758.5453) % 1;
          if (pn < 0) pn += 1;
          // PEAK 1.00, not 1.39. The variation was a good idea executed above
          // the level at which it could be seen: at 1.39 the brightest panes
          // bloomed into their neighbours and erased the very boundaries the
          // variation existed to reveal. Capping the peak at unity keeps the
          // full 3:1 range between a lit bay and a dark one and stops the
          // bloom closing the mullions.
          var band2 = 0.30 + pn * 0.70;
          // one pane in five is a dark office, and it multiplies down hard
          if (pn < 0.20) band2 *= 0.34;
          r = band2 * (1.02 + (pn > 0.8 ? 0.22 : 0)); g = band2 * 1.05;
          b = band2 * (1.10 - (pn > 0.8 ? 0.28 : 0));
        } else if (mode === 'far') {
          // ---- AERIAL PERSPECTIVE, IN THE ALBEDO ----------------------------------
          // The fog does the atmosphere. What it cannot do is make a 300 m block
          // DIFFERENT from a 140 m one before it runs, and without that the
          // backdrop is one material seen through varying amounts of grey.
          // MEASURED, AND IT WAS RUNNING BACKWARDS. The near cooling tower in
          // lv_overview came back at 0.078 mean luminance against a 0.47 sky
          // with no internal gradation, while a smaller one further out read
          // 0.248 - i.e. the biggest, nearest backdrop masses were the DARKEST
          // things in the frame, which is the opposite of aerial perspective
          // and is what makes a skyline read as black construction paper.
          //
          // Two causes compounded and both are here. (a) the radial term:
          // (rr2 - 120) / 220 evaluates to 0.04-0.27 across the whole 128-180 m
          // ring, so the objects that dominate the frame got essentially none
          // of the lift the comment above claims to deliver. (b) HEIGHT was not
          // in the expression at all. setFog runs a 26 m layer, so everything
          // above y = 26 - which is the top 60% of a 34-64 m cooling tower and
          // most of a 78 m mast - is outside the atmosphere entirely and the
          // fog cannot lift it. A backdrop's tops are exactly what has to go
          // pale; that has to be bought in the albedo.
          //
          // So: radial AND height, and the mix goes toward the twilight band's
          // own colour rather than toward luminance grey. Lerping to grey is
          // what desaturates a silhouette without ever making it lighter.
          // MEASURED, ROUND 3. `lift * 1.30` was not an aerial-perspective term,
          // it was a rounding error: it has to carry a surface from 0.016 to
          // something that reads against a 0.553 sky, on an albedo of 0.16
          // linear lit only by a probe that is itself nearly dark. The lift is
          // the ONLY illuminant those masses have, so it has to be sized like
          // one - 2.9 rather than 1.3 - and the height term has to start where
          // the FOG STOPS (setFog runs a 26 m layer, so everything above y = 26
          // gets no atmospheric help at all and is exactly what has to go pale).
          // The distance term also starts at 90 m rather than 100 and saturates
          // over 130 rather than 150, because the masses that dominate the
          // establishing frame sit in the 130-190 m ring and were getting
          // one fifth of the ramp.
          var rr2 = Math.sqrt(x * x + z * z);
          var far = M.saturate((rr2 - 90) / 130);
          var hi = M.saturate((y - 8) / 34);
          var lift = far * 0.46 + hi * 0.54;
          var v10 = 0.70 + (noise.fbm2(x * 0.010 + 5, z * 0.010 - 3, 2) * 0.5 + 0.5) * 0.44;
          // lamF gain 0.30, not 0.55, and the red skew 0.13 rather than 0.24.
          // MEASURED once the value lift was working: a 16-segment cooling tower
          // has exactly ONE facet whose normal points at the twilight band, so a
          // strong dot-product term paints that facet and no other - and the
          // establishing frame came back with a hard bright PIPED EDGE running up
          // the hyperbolic profile of every distant tower, reading as a neon
          // outline rather than as a rim light. At 0.30 the term is a gradient
          // over three or four facets, which is what a rim on a 60 m concrete
          // shell actually looks like through 200 m of haze.
          var lamF = M.saturate(nx * GLOW_X + nz * GLOW_Z) * (1 - far * 0.5);
          v10 *= 1 + lamF * 0.30;
          v10 *= 1 + lift * 2.90;
          r = v10 * (1.08 + lamF * 0.13); g = v10 * 0.99; b = v10 * (0.90 - lamF * 0.06 + far * 0.16);
          // ... and toward the twilight band's own hue, which is what the haze
          // between here and there is actually made of. The target is
          // NORMALISED to the pixel's own luminance so the hue shift cannot
          // undo the value lift - lerping straight at a constant is what makes
          // a "desaturate with distance" term double as a darkening term.
          var lum = (r + g + b) * 0.3333;
          var mix = M.saturate(lift * 0.78);
          r = M.lerp(r, lum * 1.329, mix);
          g = M.lerp(g, lum * 0.900, mix);
          b = M.lerp(b, lum * 0.771, mix);
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
          // the un-rusted fraction of the plant's steel is authored COOL.
          // Under a warm key inside a warm grade a neutral albedo comes back
          // orange, and the level is 60% steel by frame area.
          r = f4 * (0.970 + rs * 0.50);
          g = f4 * (0.998 - rs * 0.08);
          b = f4 * (1.055 - rs * 0.48);
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
    // RE-SOLVED AGAIN, and this time against the measurement. The mark at
    // (-23.5, 8) stood roughly 30 m from BOTH tank-flood masts, i.e. in neither
    // of their pools, and it looked 332 degrees - away from the warm side of
    // the twilight band AND away from the flare. The frame that came back had
    // 41.3% of its pixels below 0.05 luminance, 74.9% of its lower third below
    // 0.05, saturation 0.284 against hero1's 0.497, and no fire in it at all.
    //
    // The eye moves 14 m north to (-26, -6), which is 16 m south of the TF[1]
    // mast and inside the pool the re-aimed floods now throw back down the
    // apron; that mast is then a lit vertical standing near the centre of the
    // frame. The heading swings 16 degrees east to -12, and at the 75-degree
    // vertical FOV these framings are captured at that is a 107-degree
    // horizontal window - wide enough to hold, left to right:
    //
    //   T2's east shoulder at -88 deg bearing, clipped by the left edge as a
    //     30 m foreground mass;
    //   the twilight band at -54, in clear sky between the two tanks;
    //   T1 at -31, the subject, silhouetted 47 m out;
    //   the bund's east wall running from behind the left shoulder to dead
    //     centre at 18 m - the leading line;
    //   the TF[1] mast at 0, the lit vertical;
    //   the cooling towers at -4 and 86 m;
    //   and the FLARE at +40 bearing, 94 m away, entering the top right with
    //     its flame at 31 degrees of elevation.
    //
    // Pitching up 7 degrees rather than level pushes the near apron - which is
    // what the 41% of black was - out under the bottom of the frame.
    //
    // ONE THING THE REVIEW ASKED FOR IS NOT DELIVERABLE FROM HERE and it is
    // worth writing down rather than quietly missing: the flare cannot be put
    // cleanly in a tank-farm frame. The WEST PIPE RACK is 12 m to the top of
    // its handrail and runs unbroken from z = -96 to z = +26 along x = -15,
    // which is the entire eastern boundary of the tank farm. Any sightline from
    // the apron to a flare at (34, -78) crosses it between 10 m and 24 m out,
    // where it subtends 26-44 degrees of elevation, and the flame sits at 31.
    // The flare therefore reads through the lattice rather than beside it. The
    // heading is set to -7 rather than -12 so it is inside the right edge and
    // the plume, which clears the rack at 44 degrees, is unobstructed.
    //
    // RE-SOLVED A THIRD TIME, and only the HEADING moved - 7 degrees west of
    // north to 14. The round-2 review called this frame "a straight failure...
    // no readable subject, a dead concrete wall across the bottom-left, a black
    // lattice on the right". The wall and the shells are fixed as MATERIAL
    // (formwork, courses, vertical welds, nozzles); the other two are one
    // number. At -7 the subject T1 sat 24 degrees off axis with the twilight
    // band 47 degrees off it, so the tank was a dark cylinder against dark sky
    // - a silhouette needs something bright BEHIND it or it is just a hole -
    // and the west rack's unlit lattice filled the right third. Seven degrees
    // left puts T1 at 17 degrees off axis with the band at 40, i.e. the subject
    // is now in front of the brightest sky in the level, and it swings 7
    // degrees of black lattice out of frame.
    //
    // It does NOT go further, and that is the whole constraint: the flare bears
    // +40 from this mark, so at -14 it sits at +54 against a 53.5-degree half
    // window - its glow and its plume still enter the top right corner and the
    // frame keeps its fire. At -17 the fire leaves the frame entirely and this
    // becomes the level's only pose with no warm source in it at all.
    gy0 = this.sampleGround(-26.0, -6.0);
    var hero3 = pose(-26.0, gy0 + 1.76, -6.0, -39.3, 10.8, -59.4);

    // ---- INTERIOR : the pump house --------------------------------------------
    // Three metres inside the roll shutter, looking west down a 22 m hall. A
    // dark tube with three cold fluorescent battens down it, the pump row as
    // the subject, the MCC line on the right, the monorail beam overhead - and
    // the open personnel door at the far end as the one bright accent.
    // The aim moves UP 1.6 m. The hall measured vertical_imbalance 0.653 -
    // the floor was the brightest surface in the room and the frame read as a
    // lightbox - and half of that was the pose: a level-or-below sightline down
    // a 78-degree vertical FOV fills the bottom two thirds with slab. Aiming at
    // 3.0 m puts the monorail beam, the header pipes, the battens and the six
    // new roof lights into the upper half where they belong.
    var ph = A.pumpHouse;
    var interior = pose(PH_X1 - 1.9, ph.floorY + 1.68, PH_DOOR_Z + 0.5,
      PH_X0 - 0.6, ph.floorY + 2.35, ph.centre.z - 1.1);

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
    // THE AIM POINT IS ALSO THE FOCUS POINT, and that is why it moved down.
    // postfx auto-focuses on whatever level.raycast reports under the
    // crosshair, clamped to 140 m, and falls back to 12 m when the ray misses.
    // From 30 m up aiming at y = 7 the sightline passed 3.6 m OVER the nearest
    // pipe bridge, under the next two, and out of the site without touching
    // anything inside 140 m - so the establishing shot of a 330 m deep plant
    // was focused at twelve metres and photographed as a TILT-SHIFT MINIATURE
    // with nothing in it sharp.
    //
    // Aiming at y = 1.0 drops the sightline into the z = 6 bridge at 91 m, and
    // if that is ever removed it still meets the road slab at 133 m. Either
    // hit focuses the plant instead of the empty air in front of it. The
    // composition costs 2.5 degrees of pitch.
    var overview = pose(26.0, 30.0, 92.0, -4.0, 1.0, -34.0);

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
