// ============================================================================
// OPERATION BLACKOUT - src/world/level_highrise.js  ->  GAME.LevelHighrise
//
// "MERIDIAN TOWER": floor 47 of an unfinished 52-storey tower, at sunset, in
// wind. Deliberately unlike every other level in the roster on every axis -
// the market is a horizontal street at golden hour, the harbor a wet night
// canyon; this is a DRY, WINDY, EXTREMELY VERTICAL interior with 176 m of air
// under the open edges and a city to the horizon below it.
//
// ---------------------------------------------------------------------------
// THE PLAN, in world coordinates. +X east, -Z north, y = 0 is the poured slab
// of the working floor.
//
//        x = -27 .. 27 , z = -21 .. 21     the floor plate (54 x 42 m)
//        y = 0                              plate, poured and power-floated
//        y = 3.96                           soffit (underside of floor 48)
//        y = -4.30                          floor 46, seen through the void
//        x =  8 .. 22 , z = -10 .. 10       the CORE: lobby, two open lift
//                                           shafts, escape stair
//        x = -27 (z < 3) and z = -21        OPEN EDGES. Real drop.
//        x = -27 (z > 3) + z = 21 (x < -6)  installed curtain wall, glazed
//        x = 27                             scaffold + material hoist
//        soffit void at x -25..-15,z -18..-8  floor 48 not yet poured: steel
//                                           decking, props, and open sky
//
// ---------------------------------------------------------------------------
// WHY THE LIGHT WORKS THE WAY IT DOES  (read before moving a wall)
//
// main.js's env profile pins this level at timeOfDay 0.80. sky.js's _solar puts
// that 0.3 degrees BELOW the horizon, which lands inside its civil-twilight
// window: the key becomes the burning band, lifted to ~9.7 degrees of
// elevation, at azimuth -0.90 rad - i.e. arriving from the WEST-NORTH-WEST and
// travelling toward +X +Z.
//
// That single fact designs the building. A 9.7-degree ray entering at the head
// of a 3.96 m opening reaches the slab 23.2 m inboard, so:
//
//   * the floor is SUNLIT wherever x < -8.8 or z < -6.6 - a huge L of raking
//     light down the west and north sides, roughly 45% of the plate
//   * everything inboard of that is in the soffit's shadow, and is carried by
//     the site's own festoon strings and halogen floods (rig 'mixed',
//     lampFloor 0.85) - pools of 2400 K tungsten in cold blue shade
//   * a 3.96 m column standing in the lit zone throws a 23 m shadow. They are
//     the longest shadows in the whole build and they are the subject of hero1
//   * the sun DISC is never visible from a standing eye inboard of ~13 m,
//     because the soffit cuts the sightline at 9.7 degrees before it clears the
//     opening. No blowout, and the openings read as blades of light rather than
//     as holes with a star in them
//
// Move the soffit, and every one of those numbers moves with it.
//
// ---------------------------------------------------------------------------
// THE PLACEMENT CONTRACT  -  `level.anchors`
//
// Everything another module might want to stand something against is published
// BY NAME in `level.anchors`, available immediately after `new LevelHighrise()`
// - you do not have to wait for build().
//
//   anchors.plate        { x0,x1,z0,z1, y, soffitY, lowerY, floorH, groundY() }
//   anchors.core         { x0,x1,z0,z1, lobby, liftA, liftB, stair, doorN,
//                          doorS, lobbyMouth, yaw }
//   anchors.columns      [ {x,z,y,w,kind} ... ]  every column on the plate
//   anchors.openEdge     { west:{x,z0,z1}, north:{z,x0,x1}, corner:Vector3 }
//   anchors.curtainWall  { west:{x,z0,z1}, south:{z,x0,x1}, sill, head, pitch }
//   anchors.slabVoid     { x0,x1,z0,z1, centre, railY }
//   anchors.deckVoid     { x0,x1,z0,z1, centre, y }      hole in the SOFFIT
//   anchors.scaffold     { x, z0, z1, lifts, deckY[] }
//   anchors.hoist        { base, cage, mastX, mastZ }
//   anchors.crane        { mast:Vector3, jibY, jibDir, hook:Vector3, radius }
//   anchors.stacks       [ {name, centre, yaw, w, d, h} ]  material laydown
//   anchors.lamps        [ {name, kind, pos, aim} ]  mirrors practicalLights
//   anchors.spawn        { centre, yaw }
//
//   DO NOT derive a world position from `level.cameraPoses`. A pose is a
//   COMPOSITION; it moves whenever the composition improves. The harbor build
//   lost a round to exactly that.
//
// Also published, both consumed generically by lighting.js:
//   level.practicalLights  full override of the built-in lamp table
//   level.lightShafts      the soffit void, the lift shafts, the lobby mouth
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var X0 = -27.0, X1 = 27.0;          // slab edges
  var Z0 = -21.0, Z1 = 21.0;
  var FLOOR_H = 4.30;                 // floor to floor
  var SLAB_T = 0.34;                  // structural slab thickness
  var PLATE_Y = 0.0;                  // top of the working slab
  var SOFFIT_Y = FLOOR_H - SLAB_T;    // 3.96 - underside of the floor above
  var LOWER_Y = -FLOOR_H;             // top of floor 46

  // Column grid. 9 m east-west, 8 m north-south, 4.5/5 m perimeter cantilever.
  var COLX = [-22.5, -13.5, -4.5, 4.5, 13.5, 22.5];
  var COLZ = [-16.0, -8.0, 0.0, 8.0, 16.0];
  var COL_W = 0.86;                   // square column, chamfered

  // The core. A side core: it leaves a 35 m clear run from the west edge, which
  // is the run the low sun rakes down and the run hero1 looks along.
  var CORE_X0 = 8.0, CORE_X1 = 22.0;
  var CORE_Z0 = -10.0, CORE_Z1 = 10.0;
  var CORE_T = 0.32;                  // shear wall thickness
  var LOB_X0 = CORE_X0 + CORE_T;      // 8.32
  var LOB_X1 = 13.0;                  // lobby / lift-bank wall
  var LIFT_X0 = LOB_X1 + CORE_T;      // 13.32
  var LIFT_X1 = 17.30;
  var STR_X0 = LIFT_X1 + CORE_T;      // 17.62
  var STR_X1 = CORE_X1 - CORE_T;      // 21.68
  var CORE_ZI0 = CORE_Z0 + CORE_T;    // -9.68
  var CORE_ZI1 = CORE_Z1 - CORE_T;    // 9.68

  // Slab void: a double-height opening down into floor 46, with a temporary
  // stair and a scaffold-tube edge barrier. This is the level's walkable
  // verticality.
  var VOID_X0 = -5.6, VOID_X1 = 1.8;
  var VOID_Z0 = -4.6, VOID_Z1 = 3.4;

  // The floor ABOVE is not poured over this rectangle: permanent steel decking
  // sits on props with the sky visible past it. The last big aperture.
  var DECK_X0 = -25.0, DECK_X1 = -15.0;
  var DECK_Z0 = -18.0, DECK_Z1 = -8.0;

  // Installed curtain wall. It wraps the SOUTH-WEST corner, which is the corner
  // the sun goes down behind, so it is glazing seen against the light.
  var CW_WEST_Z0 = 3.0, CW_WEST_Z1 = Z1;
  var CW_SOUTH_X0 = X0, CW_SOUTH_X1 = -6.0;
  var CW_SILL = 0.10, CW_HEAD = SOFFIT_Y - 0.12;
  var CW_PITCH = 1.5;                 // mullion centres

  // External scaffold + material hoist, east face.
  var SCAF_X = X1;                    // inner face of the standards
  var SCAF_Z0 = -6.0, SCAF_Z1 = 12.0;
  var HOIST_X = X1 + 1.10, HOIST_Z = -13.4;

  // The tower crane, standing clear of the north-west corner.
  var CRANE_X = -35.0, CRANE_Z = -29.0;
  var CRANE_JIB_Y = 26.5;
  var CRANE_TOP = 33.0;

  // The city, 176 m down.
  var CITY_Y = -176.0;
  // ===========================================================================
  // THE 600-METRE WALL, AND EVERY NUMBER BELOW THAT IT INVALIDATED
  //
  // main.js builds the world camera as PerspectiveCamera(fov, aspect, 0.05,
  // 600). SIX HUNDRED METRES. Nothing this file put past that has ever been
  // drawn in any capture, and the numbers it put there were substantial:
  //
  //   * the ground plate ran to 2600 m, so it was clipped by the far plane -
  //     and a far plane cutting a horizontal plane produces a mathematically
  //     STRAIGHT LINE across the frame, which is precisely the "razor-straight
  //     ruled line" and the second "dead straight seam across the full frame
  //     width" the critic measured. The 2600 m radius was chosen to push the rim
  //     out until the fog reached its cap. It never got there.
  //   * the three rings of silhouette blocks at 700 / 1120 / 1750 m: never
  //     rendered, not once. All of them beyond the wall.
  //   * the distant-hill ramp at smoothstep(1250, 2350): entirely beyond it.
  //   * the street-lamp field ran to 2100 m and was deliberately THINNED past
  //     610 m to keep the far field sparse - i.e. it was thinned exactly where
  //     it was about to be clipped anyway, and dense only where it was not.
  //
  // So the whole distance strategy is rebuilt inside 600 m. The modelled grid
  // stops at 520 (no camera stands more than ~60 m off the origin, so nothing
  // is cut mid-building), the rim rings move to 400-545 and become TALL - a
  // real downtown seen from 176 m up crosses your eye line at half a kilometre,
  // and that is the only thing that can close the band between the ground and
  // the horizon when the ground itself is clipped at 16 degrees below it.
  // 495, and the number has a derivation: the establishing camera stands 66 m
  // off the origin, so anything at radius R can be R + 66 from a lens with a
  // 600 m far plane. 495 + 66 = 561 leaves margin for the per-block jitter and
  // guarantees nothing is ever cut through the middle by the clip plane - which
  // would be one more perfectly straight edge, this time a vertical one.
  var CITY_R = 495.0;                 // radius of the modelled block grid
  // 720, not 2600. Any camera in this level is within 60 m of the origin, so 720
  // covers the full 600 m far plane in every direction with margin - and the
  // same vertex budget now buys 18 m cells instead of 42 m ones, i.e. the street
  // plane you actually look down at from the open edge gets four times the
  // relief it had.
  var GROUND_R = 720.0;
  // The rim rings, inside the wall and tall enough to be a skyline rather than a
  // shelf. hMax reaches 190 m, which puts the tallest of them just above the
  // horizon from a plate-level eye - which is what a skyline IS.
  var FAR_R0 = 380.0, FAR_R1 = 490.0;
  // City block module. The street texture, the block layout and the street
  // lighting all derive from this ONE number, which is the only way the roads in
  // the map can end up under the gaps between the buildings.
  var BLK_M = 56.0;
  var ROAD_W = 15.0;                  // carriageway + footways

  // ---------------------------------------------------------------------------
  // THE HOUR.  main.js's env profile asks for timeOfDay 0.80. sky.js's _solar
  // puts that 0.32 DEGREES BELOW the horizon - t = 0.75 is the exact moment of
  // sunset and everything past it is the night arc - so transmittanceRaw()
  // returns ~0, the direct key collapses, and what is left is the civil
  // twilight band at a fixed intensity of 1.05. Multiplied by rig 'mixed's key
  // trim of 0.62 that is 0.65, against an ambient the same sky is still pushing
  // hard. MEASURED CONSEQUENCE on the first capture: no sunlit floor, no column
  // shadows, no rake - the brief's central image, absent, in a frame that
  // otherwise read correctly.
  //
  // So this level pins its own hour at 0.712, which is 9.2 degrees of elevation
  // - the last hour of real sun rather than the first minutes of dusk. That is
  // not a shared-system change (setTimeOfDay is public API and only this level
  // calls it) but it IS an override of a declarative profile, so it is applied
  // once, guarded, and only when the sky agrees the disc is under the horizon.
  // The correct long-term fix is `timeOfDay: 0.712` in the LEVELS table; this
  // block should be deleted the day that lands.
  var TIME_OF_DAY = 0.712;
  // Aerosol optical depth. See the note in update(): the profile's 0.03 is the
  // thinnest air in the roster and it is why the shadows had no blue in them.
  var TURBIDITY = 0.062;
  var SUN_AZ = -0.72 - (TIME_OF_DAY - 0.5) * 0.30 * 2.0;   // -0.847 rad
  var SUN_EL = 9.2 * Math.PI / 180;
  var SUN_X = Math.sin(SUN_AZ) * Math.cos(SUN_EL);
  var SUN_Y = Math.sin(SUN_EL);
  var SUN_Z = -Math.cos(SUN_AZ) * Math.cos(SUN_EL);
  // Unit horizontal direction the light TRAVELS (i.e. where shadows go).
  var SHD_L = Math.sqrt(SUN_X * SUN_X + SUN_Z * SUN_Z) || 1;
  var SHD_X = -SUN_X / SHD_L, SHD_Z = -SUN_Z / SHD_L;

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------------------
  // SURFACES.
  //
  // `uv` is world metres -> uv for the planar projection Geo.worldUV applies to
  // the merged bucket. `base` is a name materials.js certainly knows: none of
  // the keys below are library entries, so every request resolves to the base
  // and the overrides below always apply. `wear:true` asks for the VERTEX WEAR
  // shader (R grime, G wetness, B edge wear); everything else takes
  // wearMode 'multiply', where the colour attribute is a plain albedo
  // multiplier.
  // ---------------------------------------------------------------------------
  var SURF = {
    // ---- the concrete frame -------------------------------------------------
    // The plate is the single largest surface in five of the six framings and
    // the thing the 23 m column shadows are drawn on, so it gets the wear
    // shader: trowel polish in B reads as the pale burnished lanes a power
    // float leaves, and that is what gives a 54 m sheet of grey any tonal
    // structure for a raking key to find.
    // ---- THE ONE THAT MATTERED: `uv` DOES NOTHING ON THESE ------------------
    // concrete and concrete_wall are both `tri: true` in materials.js, i.e.
    // TRIPLANAR, and its own comment says so: "world projection takes the scale
    // away from the consumer's uv attribute entirely, so a mis-UV'd wall
    // physically cannot happen". The consequence is that the documented fix for
    // the black-pitted crust on the soffit and core walls - lower the level's uv
    // - could not possibly have worked, because the surface has never read the
    // level's uv. concrete_wall tiles at 0.49 per metre, i.e. ONE TILE ACROSS
    // 2.04 m, which is exactly the implied 5-10 cm blowholes that photographed
    // as burnt toast on the largest surfaces in the level.
    //
    // The lever that does exist is `opts.triScale` (documented in materials.js
    // as "tiles per metre for triplanar"), plus aoMapIntensity and normalScale
    // on the returned material - and because every request below carries a
    // `variant` key the cache entry is this level's alone, so mutating it cannot
    // reach another consumer. `uv` is kept honest for the non-triplanar path and
    // for Geo.worldUV's uv1 (the AO channel).
    //
    // All four concretes now sit in one family at ~0.9 m per tile, so a column
    // and the wall behind it read as the same building.
    slab:        { uv: 0.58, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.86,
                   triScale: 0.90, ao: 0.72, ns: 0.85, variant: 'hr_slab' },
    // ---- AND WHY THESE TWO ARE `concrete`, NOT `concrete_wall` --------------
    // concrete_wall's map carries its blowholes at roughly 8% of a tile, so they
    // are 16 cm at the def's own 0.49 tiles/m and still 7 cm at 1.18 - and no
    // triScale a consumer can reach makes them millimetres without turning the
    // surface into sandpaper. Measured on lv_interior: densely packed dark pits
    // at an implied 5-10 cm covering the ceiling and both core walls, far too
    // large for blowholes, too regular for honeycombing, and with the AO dark
    // enough that 40% of the frame read as burnt toast.
    //
    // `concrete` is the same triplanar machinery with a mineral map that has no
    // macro voids in it, which is exactly why the columns (which already used
    // it) photographed clean. Putting all four surfaces on it settles the
    // critic's other half of this finding as well - a smooth column next to a
    // pitted wall is worse than two surfaces in one family - and the macro story
    // that concrete_wall was accidentally supplying is now authored where it
    // belongs, in the wear channels: pour lift lines every 1.2 m, form-tie holes
    // on a 600 mm grid, the 1.22 m ply joint grid on the soffit, and a
    // differential stain gradient below every opening.
    // A soffit is the one surface in the level that is ALWAYS seen at a grazing
    // angle, because it is directly above the eye - and parallax occlusion at
    // grazing incidence smears its own depth into long high-contrast streaks.
    // That, plus a 5 cm detail normal at full scale, is what turned a coffered
    // concrete ceiling into volcanic scoria across the top third of every
    // framing. POM off, normal scale a third, and the relief comes back as
    // authored geometry (downstand beams, ply joints) instead.
    soffit:      { uv: 0.98, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.94, albedoTarget: 0xa9a49a, env: 1.5,
                   triScale: 1.05, ao: 0.44, ns: 0.34, noPom: true, noDetail: true,
                   variant: 'hr_soffit' },
    core_wall:   { uv: 1.02, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.88, albedoTarget: 0x968f85,
                   triScale: 0.92, ao: 0.62, ns: 0.90, variant: 'hr_core' },
    column:      { uv: 0.92, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.84,
                   triScale: 1.15, ao: 0.70, ns: 0.90, variant: 'hr_col' },
    blockwork:   { uv: 0.46, cast: true,  recv: true,  wear: true,
                   base: 'brick' },
    // ---- steel --------------------------------------------------------------
    // struct_steel is primary structure and the crane; scaff is galvanised tube
    // (much brighter, much colder) and it is deliberately a SEPARATE bucket so
    // the scaffold does not inherit the crane's paint.
    struct:      { uv: 0.55, cast: true,  recv: true,  wear: false,
                   base: 'structural_steel' },
    scaff:       { uv: 1.05, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', rough: 0.44, metal: 0.86, env: 1.15 },
    rebar:       { uv: 1.90, cast: true,  recv: true,  wear: false,
                   base: 'rusted_metal', rough: 0.78, metal: 0.72 },
    deckpan:     { uv: 0.80, cast: true,  recv: true,  wear: false,
                   base: 'corrugated_metal', rough: 0.52, metal: 0.84, env: 1.2 },
    grate:       { uv: 1.20, cast: false, recv: true,  wear: false,
                   base: 'steel_grate' },
    // Site plant painted in contractor's yellow. albedoTarget rather than
    // color: a raw multiplier squares a mapped material and a pale tint over a
    // pale map lands nowhere near either.
    plant:       { uv: 0.70, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', albedoTarget: 0xb08428,
                   rough: 0.52, metal: 0.42 },
    // The crane. Painted LIGHT on purpose - a dark lattice against a burning
    // sky is a black hole in the frame, and the whole point of the machine is
    // that it silhouettes AND catches the last sun on its west chords.
    crane:       { uv: 0.36, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', albedoTarget: 0xc0631e,
                   rough: 0.56, metal: 0.38 },
    // ---- timber and sheet ---------------------------------------------------
    timber:      { uv: 0.72, cast: true,  recv: true,  wear: false,
                   base: 'wood_plank' },
    ply:         { uv: 0.44, cast: true,  recv: true,  wear: false,
                   base: 'wood_plank', rough: 0.88 },
    // ---- the envelope -------------------------------------------------------
    // Anodised dark-bronze mullions. Metal, tight roughness: the only thing
    // that makes an extrusion read as an extrusion is a hard specular line
    // running its full length.
    mullion:     { uv: 1.30, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', albedoTarget: 0x2c2926,
                   rough: 0.22, metal: 0.92, env: 1.6 },
    // The one asset the roster brief singles out. It gets its OWN material (see
    // _glazingMaterial): a site facade that has been open for months carries a
    // dirt/streak/protective-film story, and without one a pane at a grazing
    // angle is a blank sheet of inscatter no matter what the fog is doing.
    // uv 0.62 is a WORLD projection on purpose: a per-pane 0..1 box UV would
    // stamp the identical dirt pattern on all twenty-six lights, which is the
    // uniformity problem this is meant to solve. At 0.62 a 1.5 m pane covers
    // most of a tile at a phase set by where it stands, so no two match.
    glazing:     { uv: 0.62, cast: false, recv: false, wear: false,
                   own: true, env: 2.0 },
    // Opaque spandrel panel at every floor band - real curtain wall is about a
    // third spandrel, and without it a glazed facade is a single sheet.
    // Lifted out of black: at 0x2a2f33 / metalness 0.70 the band under every
    // pane measured 0.014 median linear, i.e. it was the darkest thing in the
    // level. A shadow-box spandrel is anodised sheet over insulation, not a
    // mirror, so most of the metalness was wrong as well as too dark.
    spandrel:    { uv: 0.60, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', albedoTarget: 0x4a5158,
                   rough: 0.42, metal: 0.34, env: 1.2 },
    // ---- soft goods ---------------------------------------------------------
    // Polythene sheeting: translucent, double sided, and it is what the wind is
    // FOR. Its whole job is to be backlit by a sun 0.3 degrees under the
    // horizon, so it is emissive-adjacent rather than merely pale.
    // Site polythene is not new polythene: it has been up for a month, it is
    // grey with dust and it is 60% opaque. At albedoTarget 0xb9bec0 with env
    // 0.9 these panels clipped to white against the sky in three of five
    // framings and read as luminous boards hung in the openings.
    // Polythene is TRANSLUCENT and MeshStandardMaterial is not, so the face you
    // are looking at is whichever one the sun is not on - and a sheet hung in a
    // north opening with the sun in the west therefore renders as a black
    // curtain, which is the opposite of the brief. A low emissive is the honest
    // stand-in for the light coming THROUGH it: it is the only surface in the
    // level that is genuinely lit from behind, and 0.30 puts it a stop under the
    // festoon bulbs so it glows rather than sources.
    // ---- AND WHY IT IS NOW GENUINELY TRANSLUCENT --------------------------
    // The roster brief names "plastic sheeting snapping in the wind" as one of
    // five defining elements of this level, and what shipped was a set of flat
    // opaque white ribbons: no folds, no creases, no light through them, no
    // billow, in the exact condition (a 9-degree sun on the far side) under
    // which polythene is the most beautiful thing in a construction frame. An
    // opaque MeshStandardMaterial cannot be backlit at all, so the emissive
    // stand-in was doing all the work and reading as a luminous board.
    //
    // opacity 0.62 with depthWrite off is the honest version: what you see is
    // the sunset THROUGH the sheet, modulated by the creases baked into its
    // vertex normals (see buildSheeting) and by the two-scale value in its
    // vertex colour. `variant` makes the cache entry this level's alone, which
    // is what makes it safe for material() to mutate it afterwards.
    sheeting:    { uv: 0.55, cast: false, recv: true,  wear: false, keepUV: true,
                   base: 'plastic', albedoTarget: 0x9fa3a2, variant: 'hr_sheet',
                   rough: 0.58, metal: 0.0, side: 2, env: 1.60,
                   emissive: 0xffc79a, emissiveIntensity: 0.20 },
    debris_net:  { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                   own: true },
    // ---- distance -----------------------------------------------------------
    // The city. Its own atlas, its own material: it needs an emissiveMap (the
    // lit windows) that no library entry carries, and at 200-500 m it wants
    // none of the detail-normal / parallax machinery the near surfaces do.
    city:        { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                   own: true },
    // The street plane. It used to be a bare asphalt plate at uv 0.030 - a 33 m
    // texture repeat, invisible at 400 m - so the one place the eye goes when it
    // looks over the edge was a flat grey sheet. It now carries its OWN baked
    // road network (see buildStreetMaps): carriageways, blocks, and an emissive
    // sodium lane along every primary axis, at a tile size of four city blocks
    // so it survives 400 m of aerial perspective.
    city_ground: { uv: 1 / (BLK_M * 4), cast: false, recv: false, wear: false,
                   own: true, env: 0.30 },
    // Rooftop plant used to share city_ground's material. Now that city_ground
    // is a road network it needs its own bucket, or every plant room on every
    // roof in the city has a dual carriageway printed on it.
    city_plant:  { uv: 0.11, cast: false, recv: false, wear: false,
                   base: 'asphalt', rough: 0.92, env: 0.35 },
    // Our own tower, below the working floor. Same atlas as the city - it is
    // literally the same kind of building - but it is 176 m of it directly
    // under the player's feet, so it is its own bucket and its own paint.
    shell:       { uv: 1.0, cast: false, recv: true,  wear: false, keepUV: true,
                   own: true },
    // ---- markings and light -------------------------------------------------
    decal:       { uv: 1.0, cast: false, recv: true,  wear: false, own: true,
                   keepUV: true },
    // Festoon bulbs, task lamps, the lit windows of the near neighbours. Dark
    // albedo, hot emissive: postfx's bloom is what turns these into sources.
    lamp_glass:  { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                   base: 'plastic', rough: 0.24, metal: 0.0,
                   emissive: 0xffb460, emissiveIntensity: 5.6 },
    // Aviation obstruction lights on the crane. Separate from lamp_glass
    // because a red mark at 33 m is the only thing putting a note in the TOP of
    // the frame and it must not be averaged into the sodium/tungsten palette.
    lamp_red:    { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                   base: 'plastic', rough: 0.26, metal: 0.0,
                   emissive: 0xff2a18, emissiveIntensity: 6.0 },
    // The city's street lighting and vehicle trails, 176 m down. Flat cards,
    // pure emissive - at that range each one is one to three pixels and its
    // only job is to survive the haze as a POINT.
    city_light:  { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                   base: 'plastic', rough: 0.4, metal: 0.0,
                   emissive: 0xffc487, emissiveIntensity: 5.2 }
  };

  // If materials.js is missing entirely the tower must still read as raw
  // concrete at sunset rather than as magenta error boxes.
  var FALLBACK = {
    slab:        [0x8f8b84, 0.86, 0.0],
    soffit:      [0x8a8681, 0.92, 0.0],
    core_wall:   [0x8d8981, 0.90, 0.0],
    column:      [0x94908a, 0.84, 0.0],
    blockwork:   [0x9a938a, 0.94, 0.0],
    struct:      [0x6a6a66, 0.62, 0.68],
    scaff:       [0x9aa1a6, 0.44, 0.86],
    rebar:       [0x8a6a4a, 0.78, 0.72],
    deckpan:     [0x8f979c, 0.52, 0.84],
    grate:       [0x5f5a54, 0.72, 0.80],
    plant:       [0xb08428, 0.52, 0.42],
    crane:       [0xc0631e, 0.56, 0.38],
    timber:      [0xa3886a, 0.88, 0.0],
    ply:         [0xa8916a, 0.88, 0.0],
    mullion:     [0x2c2926, 0.22, 0.92],
    glazing:     [0x556168, 0.14, 0.0],
    spandrel:    [0x4a5158, 0.42, 0.34],
    sheeting:    [0xb9bec0, 0.62, 0.0],
    debris_net:  [0xd06a20, 0.80, 0.0],
    city:        [0x6d6a66, 0.94, 0.0],
    city_ground: [0x27251f, 0.92, 0.0],
    city_plant:  [0x3a3833, 0.92, 0.0],
    shell:       [0x77736d, 0.90, 0.0],
    decal:       [0xffffff, 0.80, 0.0],
    lamp_glass:  [0xffcf92, 0.24, 0.0],
    lamp_red:    [0xff5a44, 0.26, 0.0],
    city_light:  [0xffc487, 0.40, 0.0]
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

  // A deterministic 0..1 hash. Never Math.random: this is used inside texture
  // builders that have no rng handed to them, and a capture has to be
  // byte-reproducible.
  function rngLike(x) {
    var s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // Cached primitives. Everything is returned NON-INDEXED so Geo.mergeAll never
  // has to convert (and therefore never disposes a cache entry out from under
  // the next caller).
  var _boxCache = new Map();
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.003); h = Math.max(h, 0.003); d = Math.max(d, 0.003);
    if (bevel === undefined) bevel = Math.min(0.010, Math.min(w, h, d) * 0.28);
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
  function cyl(rTop, rBot, len, seg) {
    seg = seg || 8;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg;
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  // ---------------------------------------------------------------------------
  // A CHAMFERED PRISM, WHICH IS WHAT A FORMED CONCRETE COLUMN ACTUALLY IS.
  //
  // Geo.bevelBox "pushes the CORNER VERTEX in rather than adding a facet" - this
  // file's own comment says so - so a bevelled box has no chamfer SURFACE on it,
  // only a pinched corner, and the two adjoining faces still meet at what reads
  // as a 90-degree arris. On the largest repeated object in the level, seen at
  // 3-8 m in four of five framings, that is the single loudest "this is a box"
  // tell there is, and raising the bevel from 35 mm to 55 mm could not fix it
  // because there was never a facet to widen.
  //
  // A real column is cast against a chamfer fillet nailed into the corner of the
  // form, so it has an eighth face 25-35 mm wide at 45 degrees down its whole
  // height. That facet is the point: it faces a different direction from both of
  // its neighbours, so it catches its own specular line and its own AO, and a
  // raking 9-degree key draws a hard bright edge down one side of every column
  // and a dark one down the other. Which is what makes concrete read as cast
  // concrete instead of as a grey extrusion.
  //
  // 32 tris against bevelBox's 44, so it is also cheaper.
  var _prismCache = new Map();
  function chamfPrism(w, h, c, d) {
    w = Math.max(w, 0.02); h = Math.max(h, 0.02);
    d = Math.max(d === undefined ? w : d, 0.02);
    c = M.clamp(c === undefined ? 0.030 : c, 0.004, Math.min(w, d) * 0.45);
    var k = w.toFixed(4) + ',' + h.toFixed(4) + ',' + c.toFixed(4) + ',' + d.toFixed(4);
    var g = _prismCache.get(k);
    if (g) return g;
    var ax = w * 0.5, az = d * 0.5;
    var bx = ax - c, bz = az - c;
    // Clockwise seen from above, so outward normal of edge (ex,ez) is (ez,-ex).
    var ring = [[-bx, -az], [bx, -az], [ax, -bz], [ax, bz],
                [bx, az], [-bx, az], [-ax, bz], [-ax, -bz]];
    var pos = [], nor = [], uvs = [];
    var hy = h * 0.5, i;
    function push(px, py, pz, nx, ny, nz, u, v) {
      pos.push(px, py, pz); nor.push(nx, ny, nz); uvs.push(u, v);
    }
    for (i = 0; i < 8; i++) {
      var p0 = ring[i], p1 = ring[(i + 1) % 8];
      var ex = p1[0] - p0[0], ez = p1[1] - p0[1];
      var el = Math.sqrt(ex * ex + ez * ez) || 1;
      var nx = ez / el, nz = -ex / el;
      var u0 = i / 8, u1 = (i + 1) / 8;
      push(p0[0], -hy, p0[1], nx, 0, nz, u0, 0);
      push(p1[0], hy, p1[1], nx, 0, nz, u1, 1);
      push(p1[0], -hy, p1[1], nx, 0, nz, u1, 0);
      push(p0[0], -hy, p0[1], nx, 0, nz, u0, 0);
      push(p0[0], hy, p0[1], nx, 0, nz, u0, 1);
      push(p1[0], hy, p1[1], nx, 0, nz, u1, 1);
    }
    for (i = 0; i < 8; i++) {
      var q0 = ring[i], q1 = ring[(i + 1) % 8];
      push(0, hy, 0, 0, 1, 0, 0.5, 0.5);
      push(q1[0], hy, q1[1], 0, 1, 0, 0.5 + q1[0], 0.5 + q1[1]);
      push(q0[0], hy, q0[1], 0, 1, 0, 0.5 + q0[0], 0.5 + q0[1]);
      push(0, -hy, 0, 0, -1, 0, 0.5, 0.5);
      push(q0[0], -hy, q0[1], 0, -1, 0, 0.5 + q0[0], 0.5 + q0[1]);
      push(q1[0], -hy, q1[1], 0, -1, 0, 0.5 + q1[0], 0.5 + q1[1]);
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    _prismCache.set(k, g);
    return g;
  }

  // A flat quad in the XY plane facing +Z. Decal cards, glazing lights, the
  // city's emissive points.
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

  // An arbitrary quad in world space with explicit UVs. The city's facades and
  // our own tower shell are built from these: they need a uv whose scale is a
  // function of the BUILDING, not of a world projection, or the window grid
  // stretches with the block.
  function quadGeo(a, b, c, d, u0, v0, u1, v1) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    var pos = new Float32Array([
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) { nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz; }
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // ---------------------------------------------------------------------------
  // THE WHOLE CITY AND OUR OWN TOWER WERE BEING RENDERED INSIDE OUT.
  //
  // MEASURED, not deduced. quadGeo's normal is (b-a) x (d-a), and every one of
  // the eleven call sites in this file - every city facade, every rim block,
  // every roof, every setback and all four faces of our own 176 m shell - passes
  // its corners in an order that makes that cross product point at the block's
  // OWN CENTRE. An inward normal is a back-facing triangle, so the renderer
  // culled the near wall of every building in the level and drew the FAR wall's
  // interior instead.
  //
  // The proof: re-rendered the establishing frame with nothing changed except
  // `side: DoubleSide` on the city material. 42.7% of the pixels moved, mean
  // delta 23.5/255, peak 219. If the near faces had been drawn, adding the back
  // faces could only have added surfaces hidden behind them and the frame would
  // have been byte-identical. And the decisive detail in the crop: our own
  // tower's window bays are visibly LARGER with DoubleSide on, because the wall
  // being drawn is now the near one, 42 m closer to the lens.
  //
  // Four separate defects came out of that one winding, and they are most of the
  // round-3 findings against this level:
  //   * WRONG SCALE. Every facade was drawn one building-depth further away, so
  //     its window grid was 10-25% too small on screen. That is why the lit
  //     windows read as "soft round bokeh dots rather than lit rectangular
  //     rooms" - they were sub-pixel, and bloom rounds a sub-pixel rectangle.
  //   * WRONG DEPTH. Aerial perspective was solved at the far wall, so every
  //     building carried more haze than it should and adjacent blocks stopped
  //     separating in value.
  //   * WRONG SHADE. `lam` in _paint is the horizontal lambert against the sun,
  //     computed off that normal - so the baked sunset was on the wrong faces of
  //     every building, and so was the runtime CSM and IBL term. Verified on the
  //     establishing frame: our tower's EAST elevation was the bright one and
  //     its NORTH elevation dark, with the sun bearing north-west.
  //   * WRONG SILHOUETTE ON TOP. The roof quads' normals came out -Y, so a roof
  //     was lit from the hemisphere's ground colour and never got the "never let
  //     a roof go to nothing" lift, which is most of why they photographed as
  //     "featureless flat planes".
  //
  // Fixed here rather than by turning the material double-sided: a two-sided
  // city doubles its fragment cost and still shades the interior faces with an
  // inverted normal. faceQuad reverses the winding of the two triangles - moving
  // each vertex's OWN uv with it, so the window grid does not transpose - and
  // negates the normal, which fixes the facing, the depth, the scale and the
  // shading with one operation and costs nothing.
  function faceQuad(a, b, c, d, u0, v0, u1, v1, ox, oy, oz) {
    var g = quadGeo(a, b, c, d, u0, v0, u1, v1);
    var n = g.attributes.normal.array;
    if (n[0] * ox + n[1] * oy + n[2] * oz >= 0) return g;
    var p = g.attributes.position.array, t = g.attributes.uv.array;
    var i, tmp;
    // swap vertices 1<->2 and 4<->5: reverses each triangle's winding
    var pairs = [1, 2, 4, 5];
    for (var q = 0; q < 4; q += 2) {
      var A = pairs[q], Bv = pairs[q + 1];
      for (i = 0; i < 3; i++) {
        tmp = p[A * 3 + i]; p[A * 3 + i] = p[Bv * 3 + i]; p[Bv * 3 + i] = tmp;
      }
      for (i = 0; i < 2; i++) {
        tmp = t[A * 2 + i]; t[A * 2 + i] = t[Bv * 2 + i]; t[Bv * 2 + i] = tmp;
      }
    }
    for (i = 0; i < n.length; i++) n[i] = -n[i];
    return g;
  }
  // A vertical face: outward is the horizontal direction from the block's own
  // centre to the face's centroid, which for a rectangular face IS its normal.
  function wallQuad(a, b, c, d, u0, v0, u1, v1, cx, cz) {
    var mx = (a[0] + c[0]) * 0.5 - cx, mz = (a[2] + c[2]) * 0.5 - cz;
    var l = Math.sqrt(mx * mx + mz * mz);
    if (l < 1e-4) return quadGeo(a, b, c, d, u0, v0, u1, v1);
    return faceQuad(a, b, c, d, u0, v0, u1, v1, mx / l, 0, mz / l);
  }
  // A horizontal face seen from above: a roof, a setback deck, a crown cap.
  function topQuad(a, b, c, d, u0, v0, u1, v1) {
    return faceQuad(a, b, c, d, u0, v0, u1, v1, 0, 1, 0);
  }

  // A height-field patch, for the slab and the city ground.
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

  // The same, but with a rectangular HOLE cut out of it. The plate has three
  // (the slab void and the two lift shafts) and cutting them as geometry rather
  // than hiding them under a lid is the difference between a hole you can look
  // down and a black rectangle painted on the floor.
  function gridSurfaceHoles(x0, x1, z0, z1, step, fn, holes) {
    var nx = Math.max(1, Math.round((x1 - x0) / step));
    var nz = Math.max(1, Math.round((z1 - z0) / step));
    var dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    var pos = [], nor = [];
    function inHole(cx, cz) {
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

  // ================================================================ Builder ==
  // Transform stack + per-material geometry buckets. Same shape as the market
  // and harbor builders, deliberately: this file follows those files' patterns
  // rather than inventing new ones.
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
  Builder.prototype.cyl = function (key, r0, r1, len, x, y, z, rx, ry, rz, seg) {
    return this.add(key, cyl(r0, r1, len, seg), makeM(x, y, z, rx, ry, rz));
  };
  // A member between two arbitrary points. The crane, the scaffold and every
  // brace in the building is one of these.
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
  // A round member between two points - scaffold tube, conduit, a hoist rope.
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
    return this.add(key, cyl(r, r, len, seg || 7), m);
  };

  // ============================================================== THE SLAB ===
  // A power-floated slab is FLAT, and that is exactly why it needs a function:
  // at 9.7 degrees of incidence a 20 mm ripple across a 2 m bay is a 12 cm band
  // of shade, so the millimetres are what make a 54 m grey sheet photograph as
  // concrete instead of as a plane. Every consumer - sampleGround, the navgrid,
  // the wear pass and the puddle placer - reads THIS function, so none of them
  // can disagree about where the low spots are.
  var JOINT_PITCH = 6.0;              // saw-cut control joints, on the bay grid
  function jointDip(x, z) {
    var a = ((x + 3.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    var b = ((z + 2.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    var d = 0;
    a = Math.abs(a); b = Math.abs(b);
    if (a < 0.075) d = (1 - a / 0.075) * 0.022;
    if (b < 0.075) d = Math.max(d, (1 - b / 0.075) * 0.022);
    return d;
  }

  // How far below its surroundings this patch of slab sits. Rain blows in
  // through the open edges and stands in exactly these hollows.
  function plateDip(x, z, N) {
    var b = M.saturate(N.fbm2(x * 0.115 - 2.4, z * 0.115 + 5.1, 2) * 0.5 + 0.5);
    var d = Math.pow(b, 3.3) * 0.052;
    d += jointDip(x, z);
    return d;
  }

  function plateY(x, z, N) {
    // The pour: a long, shallow undulation between the screed rails plus the
    // 1:200 fall the drainage was set out to.
    var y = -(N.fbm2(x * 0.048 + 7.7, z * 0.048 - 3.3, 3) * 0.5 + 0.5) * 0.026;
    y -= plateDip(x, z, N);
    y += N.fbm2(x * 1.35, z * 1.35, 2) * 0.0055;   // float tooth
    return y;
  }

  var PUDDLE_FILM = 0.016;
  function waterDepth(x, z, N) { return plateDip(x, z, N) - PUDDLE_FILM; }

  // Is this point sheltered from the wind-driven rain that comes in the west
  // and north openings? Water only stands where the weather can reach.
  function rainReach(x, z) {
    var w = M.smoothstep(9.0, -1.0, x - X0);        // 1 at the west edge
    var n = M.smoothstep(9.0, -1.0, z - Z0);        // 1 at the north edge
    return M.saturate(Math.max(w, n));
  }

  // Is (x, z) in the open, i.e. does the low sun reach the slab there? The
  // whole light design of the level is this one expression - see the header.
  var LIT_X = X0 + SOFFIT_Y / Math.tan(SUN_EL) * Math.abs(SHD_X);   // ~ -8.8
  var LIT_Z = Z0 + SOFFIT_Y / Math.tan(SUN_EL) * Math.abs(SHD_Z);   // ~ -6.6
  function sunlitSlab(x, z) {
    // Plus the soffit void, which lets a second blade down 10 m further in.
    var lit = M.saturate(M.smoothstep(LIT_X + 1.6, LIT_X - 1.6, x)) +
              M.saturate(M.smoothstep(LIT_Z + 1.6, LIT_Z - 1.6, z));
    var vx = x - (DECK_X0 + DECK_X1) * 0.5, vz = z - (DECK_Z0 + DECK_Z1) * 0.5;
    lit += M.smoothstep(15.0, 4.0, Math.sqrt(vx * vx + vz * vz)) * 0.55;
    return M.saturate(lit);
  }

  // ========================================================= SITE MARKINGS ===
  // A 4 x 4 alpha atlas of everything a contractor sprays, tapes or screws to a
  // concrete frame. Alpha-tested cards laid coplanar on the slab, the columns
  // and the core walls: this is what stops 3000 m2 of grey being 3000 m2 of
  // grey, and it is the cheapest legibility there is.
  // 8 x 8 at 2048, so the cell resolution is unchanged at 256 px and there is
  // room for the EIGHT column marks the level needs. One gridref cell stamped on
  // thirty columns is "perfectly uniform anything" delivered by the level's own
  // storytelling element, and a stencil is high contrast, so it is the first
  // thing a player notices.
  var ATLAS_N = 8, ATLAS_PX = 2048, ATLAS_CELL = ATLAS_PX / ATLAS_N;
  var CELL = {
    hazard: 0,     // yellow/black chevron tape, tiles horizontally
    gridref: 1,    // stencilled column grid reference, e.g. "E4 / L47"
    arrow: 2,      // sprayed setting-out arrow + offset dimension
    danger: 3,     // DANGER placard, invented script
    streak: 4,     // rust / rainwater weep, vertical
    cross: 5,      // sprayed survey cross + station number
    level: 6,      // big sprayed floor number
    tape: 7,       // torn barrier tape, red/white
    splat: 8,      // concrete slurry splatter
    pourdate: 9,   // pour record stencil
    noentry: 10,   // circular prohibition sign
    scuff: 11,     // black rubber scuff / tyre mark
    drip: 12,      // drip lines from a soffit penetration
    label: 13,     // adhesive service label plate
    chalk: 14,     // snapped chalk line and a dimension
    logo: 15,      // contractor's mark, invented script
    // ---- the column marks --------------------------------------------------
    // A real column mark is a grid reference and a level, sprayed through a
    // stencil by whoever was setting out that bay - so they vary in wording, in
    // size, in how much they have run and in how badly the stencil skipped.
    gr0: 16, gr1: 17, gr2: 18, gr3: 19,
    gr4: 20, gr5: 21, gr6: 22, gr7: 23
  };
  // Indexed by column, never picked at random: adjacent columns must not match,
  // and a stride coprime with the count is the cheapest way to guarantee it.
  var GRIDREFS = [CELL.gr0, CELL.gr1, CELL.gr2, CELL.gr3,
                  CELL.gr4, CELL.gr5, CELL.gr6, CELL.gr7];
  // Invented script: consistent letterforms that read as writing at a glance
  // and as nothing in particular up close. No font files exist in this build.
  var GLYPHS = 'AEHIKLMNORSTUVX0123456789';

  function atlasRect(cell) {
    var cx = (cell % ATLAS_N) * ATLAS_CELL;
    var cy = Math.floor(cell / ATLAS_N) * ATLAS_CELL;
    return [cx, cy, ATLAS_CELL, ATLAS_CELL];
  }
  // Canvas row 0 is v = 1 after three's flipY, so the v range is inverted here.
  // The 0.6% inset is not decoration: 64 cells on one mip chain will bleed a
  // neighbour's ink into the border texel by mip 3, and a ghost of a DANGER
  // placard down the side of a column is worse than no placard.
  var ATLAS_INSET = 0.006 / ATLAS_N;
  function atlasUV(cell) {
    var cx = (cell % ATLAS_N) / ATLAS_N;
    var cy = Math.floor(cell / ATLAS_N) / ATLAS_N;
    var s = 1 / ATLAS_N;
    return [cx + ATLAS_INSET, 1 - cy - s + ATLAS_INSET,
            cx + s - ATLAS_INSET, 1 - cy - ATLAS_INSET];
  }

  function buildAtlas(rng) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var cv = document.createElement('canvas');
    cv.width = ATLAS_PX; cv.height = ATLAS_PX;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    var i, j, r, c;

    function cellCtx(cell) {
      r = atlasRect(cell);
      g.save();
      g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
      g.translate(r[0], r[1]);
      return ATLAS_CELL;
    }
    function endCell() { g.restore(); }
    function rgba(cr, cg, cb, a) {
      return 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',' + a.toFixed(3) + ')';
    }
    // A stencilled glyph. Blocky, with the bridges a real stencil leaves.
    function glyph(ch, x, y, s, w) {
      var t = w || Math.max(1.5, s * 0.17);
      g.lineWidth = t;
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
          g.lineTo(x + hw, y + h * 0.26); g.lineTo(x - hw, y + h * 0.52); g.moveTo(x, y + h * 0.52); g.lineTo(x + hw, y + h); break;
        case 'S': case '5': g.moveTo(x + hw, y); g.lineTo(x - hw, y); g.lineTo(x - hw, y + h * 0.5);
          g.lineTo(x + hw, y + h * 0.5); g.lineTo(x + hw, y + h); g.lineTo(x - hw, y + h); break;
        case 'T': g.moveTo(x - hw, y); g.lineTo(x + hw, y); g.moveTo(x, y); g.lineTo(x, y + h); break;
        case 'U': g.moveTo(x - hw, y); g.lineTo(x - hw, y + h); g.lineTo(x + hw, y + h); g.lineTo(x + hw, y); break;
        case 'V': g.moveTo(x - hw, y); g.lineTo(x, y + h); g.lineTo(x + hw, y); break;
        case 'X': g.moveTo(x - hw, y); g.lineTo(x + hw, y + h); g.moveTo(x + hw, y); g.lineTo(x - hw, y + h); break;
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
      for (var q = 0; q < n; q++) {
        glyph(rng.pick(GLYPHS.split('')), x - tot * 0.5 + q * w, y, s);
      }
    }
    // The same, but from a literal string, so a column mark can actually SAY a
    // grid reference instead of five random letterforms.
    function text(str, x, y, s, gap) {
      var w = s * 0.68 + (gap === undefined ? s * 0.26 : gap);
      var tot = (str.length - 1) * w;
      for (var q = 0; q < str.length; q++) {
        glyph(str.charAt(q), x - tot * 0.5 + q * w, y, s);
      }
    }
    // Spray edge: a real stencil bleeds and skips.
    function spray(alpha, dens, cw, colour) {
      g.globalAlpha = alpha;
      g.fillStyle = colour;
      for (var q = 0; q < dens; q++) {
        var px = rng.range(0, cw), py = rng.range(0, cw);
        g.fillRect(px, py, rng.range(1, 3.4), rng.range(1, 3.4));
      }
      g.globalAlpha = 1;
    }

    var S;
    // ---- 0 hazard chevron tape ----------------------------------------------
    S = cellCtx(CELL.hazard);
    g.fillStyle = '#e0b524'; g.fillRect(0, S * 0.30, S, S * 0.40);
    g.fillStyle = '#181510';
    for (i = -2; i < 10; i++) {
      g.beginPath();
      var bx = i * S * 0.16;
      g.moveTo(bx, S * 0.70); g.lineTo(bx + S * 0.08, S * 0.30);
      g.lineTo(bx + S * 0.16, S * 0.30); g.lineTo(bx + S * 0.08, S * 0.70);
      g.closePath(); g.fill();
    }
    // wear: the tape is scuffed and torn along both edges
    g.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.25, 1.0);
      g.beginPath();
      g.arc(rng.range(0, S), S * (rng.bool() ? 0.30 : 0.70) + rng.range(-9, 9),
        rng.range(2, 11), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    endCell();

    // ---- 1 grid reference stencil -------------------------------------------
    S = cellCtx(CELL.gridref);
    g.strokeStyle = '#1d1c1a';
    word(2, S * 0.5, S * 0.16, S * 0.30);
    g.strokeStyle = 'rgba(30,28,26,0.80)';
    word(3, S * 0.5, S * 0.60, S * 0.20);
    spray(0.16, 260, S, '#26241f');
    endCell();

    // ---- 2 setting-out arrow ------------------------------------------------
    S = cellCtx(CELL.arrow);
    g.strokeStyle = '#c3352a'; g.lineWidth = S * 0.045;
    g.beginPath(); g.moveTo(S * 0.12, S * 0.5); g.lineTo(S * 0.80, S * 0.5); g.stroke();
    g.beginPath(); g.moveTo(S * 0.88, S * 0.5); g.lineTo(S * 0.62, S * 0.33);
    g.lineTo(S * 0.62, S * 0.67); g.closePath(); g.fillStyle = '#c3352a'; g.fill();
    g.strokeStyle = 'rgba(190,55,42,0.9)';
    word(3, S * 0.44, S * 0.60, S * 0.17);
    spray(0.22, 300, S, '#b0342a');
    endCell();

    // ---- 3 DANGER placard ---------------------------------------------------
    S = cellCtx(CELL.danger);
    g.fillStyle = '#d8d2c4'; g.fillRect(S * 0.06, S * 0.10, S * 0.88, S * 0.80);
    g.fillStyle = '#b8231d'; g.fillRect(S * 0.06, S * 0.10, S * 0.88, S * 0.26);
    g.strokeStyle = '#f2ece0';
    word(6, S * 0.5, S * 0.15, S * 0.16);
    g.strokeStyle = 'rgba(34,32,30,0.92)';
    word(7, S * 0.5, S * 0.46, S * 0.11);
    word(5, S * 0.5, S * 0.66, S * 0.11);
    g.strokeStyle = 'rgba(40,38,34,0.55)'; g.lineWidth = 2;
    g.strokeRect(S * 0.06, S * 0.10, S * 0.88, S * 0.80);
    // four fixing screws and the grime that collects under the head
    for (i = 0; i < 4; i++) {
      var sx = S * (i % 2 ? 0.87 : 0.13), sy = S * (i < 2 ? 0.17 : 0.83);
      g.fillStyle = '#5e5952'; g.beginPath(); g.arc(sx, sy, S * 0.022, 0, 6.28318); g.fill();
    }
    endCell();

    // ---- 4 rust / rainwater weep --------------------------------------------
    S = cellCtx(CELL.streak);
    for (i = 0; i < 22; i++) {
      var wx = rng.range(0, S), ww = rng.range(3, 26);
      var grd = g.createLinearGradient(0, 0, 0, S);
      var rr = rng.range(96, 148), gg = rng.range(70, 104), bb = rng.range(48, 72);
      grd.addColorStop(0, rgba(rr, gg, bb, rng.range(0.30, 0.62)));
      grd.addColorStop(0.55, rgba(rr * 0.9, gg * 0.9, bb * 0.9, rng.range(0.10, 0.30)));
      grd.addColorStop(1, rgba(rr * 0.8, gg * 0.8, bb * 0.8, 0));
      g.fillStyle = grd;
      g.fillRect(wx, rng.range(-S * 0.1, S * 0.2), ww, S);
    }
    endCell();

    // ---- 5 survey cross -----------------------------------------------------
    S = cellCtx(CELL.cross);
    g.strokeStyle = 'rgba(196,64,48,0.92)'; g.lineWidth = S * 0.035;
    g.beginPath();
    g.moveTo(S * 0.5, S * 0.14); g.lineTo(S * 0.5, S * 0.86);
    g.moveTo(S * 0.14, S * 0.5); g.lineTo(S * 0.86, S * 0.5);
    g.stroke();
    g.strokeStyle = 'rgba(196,64,48,0.85)';
    word(3, S * 0.72, S * 0.58, S * 0.14);
    spray(0.20, 220, S, '#b8402f');
    endCell();

    // ---- 6 floor number -----------------------------------------------------
    S = cellCtx(CELL.level);
    g.strokeStyle = 'rgba(28,26,24,0.86)';
    glyph('4', S * 0.32, S * 0.14, S * 0.68, S * 0.10);
    glyph('7', S * 0.70, S * 0.14, S * 0.68, S * 0.10);
    spray(0.18, 420, S, '#26241f');
    endCell();

    // ---- 7 barrier tape -----------------------------------------------------
    S = cellCtx(CELL.tape);
    g.fillStyle = '#e8e2d6'; g.fillRect(0, S * 0.36, S, S * 0.28);
    g.fillStyle = '#c02a20';
    for (i = -1; i < 8; i++) {
      g.beginPath();
      var tx = i * S * 0.22;
      g.moveTo(tx, S * 0.64); g.lineTo(tx + S * 0.11, S * 0.36);
      g.lineTo(tx + S * 0.22, S * 0.36); g.lineTo(tx + S * 0.11, S * 0.64);
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 30; i++) {
      g.beginPath();
      g.arc(rng.range(0, S), S * (rng.bool() ? 0.36 : 0.64), rng.range(2, 8), 0, 6.28318);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    endCell();

    // ---- 8 slurry splatter --------------------------------------------------
    S = cellCtx(CELL.splat);
    for (i = 0; i < 150; i++) {
      var sr = Math.pow(rng.next(), 2.2) * S * 0.12 + 1.5;
      var v = rng.range(-14, 20);
      g.fillStyle = rgba(176 + v, 172 + v, 163 + v, rng.range(0.20, 0.72));
      g.beginPath();
      g.ellipse(rng.gaussian(S * 0.5, S * 0.22), rng.gaussian(S * 0.5, S * 0.22),
        sr, sr * rng.range(0.6, 1.3), rng.range(0, 3.14), 0, 6.28318);
      g.fill();
    }
    endCell();

    // ---- 9 pour record ------------------------------------------------------
    S = cellCtx(CELL.pourdate);
    g.fillStyle = 'rgba(226,220,206,0.86)'; g.fillRect(S * 0.08, S * 0.24, S * 0.84, S * 0.50);
    g.strokeStyle = 'rgba(36,34,30,0.85)';
    word(4, S * 0.5, S * 0.30, S * 0.14);
    word(6, S * 0.5, S * 0.52, S * 0.11);
    g.strokeStyle = 'rgba(36,34,30,0.4)'; g.lineWidth = 1.6;
    g.strokeRect(S * 0.08, S * 0.24, S * 0.84, S * 0.50);
    endCell();

    // ---- 10 prohibition sign ------------------------------------------------
    S = cellCtx(CELL.noentry);
    g.fillStyle = '#e6e0d2'; g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.40, 0, 6.28318); g.fill();
    g.fillStyle = '#bb2a1e'; g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.40, 0, 6.28318); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.31, 0, 6.28318); g.fill();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#e6e0d2'; g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.31, 0, 6.28318); g.fill();
    g.fillStyle = '#bb2a1e';
    g.save(); g.translate(S * 0.5, S * 0.5); g.rotate(-0.62);
    g.fillRect(-S * 0.40, -S * 0.055, S * 0.80, S * 0.11); g.restore();
    endCell();

    // ---- 11 rubber scuff ----------------------------------------------------
    S = cellCtx(CELL.scuff);
    for (i = 0; i < 26; i++) {
      g.strokeStyle = rgba(26, 25, 24, rng.range(0.10, 0.44));
      g.lineWidth = rng.range(3, 22);
      g.beginPath();
      var ay = rng.range(S * 0.2, S * 0.8);
      g.moveTo(rng.range(-20, S * 0.3), ay);
      g.bezierCurveTo(S * 0.35, ay + rng.range(-40, 40), S * 0.65, ay + rng.range(-40, 40),
        rng.range(S * 0.7, S + 20), ay + rng.range(-24, 24));
      g.stroke();
    }
    endCell();

    // ---- 12 soffit drip -----------------------------------------------------
    S = cellCtx(CELL.drip);
    for (i = 0; i < 16; i++) {
      var dx = rng.range(0, S);
      var gr = g.createLinearGradient(0, 0, 0, S);
      gr.addColorStop(0, rgba(58, 60, 62, rng.range(0.34, 0.62)));
      gr.addColorStop(1, rgba(58, 60, 62, 0));
      g.fillStyle = gr;
      g.fillRect(dx, 0, rng.range(4, 18), S * rng.range(0.5, 1.0));
    }
    // the lime bloom the water leaves at the bottom of the run
    for (i = 0; i < 40; i++) {
      g.fillStyle = rgba(226, 224, 216, rng.range(0.06, 0.24));
      g.beginPath(); g.arc(rng.range(0, S), rng.range(S * 0.55, S), rng.range(4, 24), 0, 6.28318); g.fill();
    }
    endCell();

    // ---- 13 service label ---------------------------------------------------
    S = cellCtx(CELL.label);
    g.fillStyle = '#3f6d8c'; g.fillRect(S * 0.10, S * 0.34, S * 0.80, S * 0.32);
    g.strokeStyle = 'rgba(238,242,246,0.92)';
    word(6, S * 0.5, S * 0.42, S * 0.14);
    g.strokeStyle = 'rgba(10,20,28,0.35)'; g.lineWidth = 2;
    g.strokeRect(S * 0.10, S * 0.34, S * 0.80, S * 0.32);
    endCell();

    // ---- 14 chalk line ------------------------------------------------------
    S = cellCtx(CELL.chalk);
    g.strokeStyle = 'rgba(206,68,86,0.66)'; g.lineWidth = S * 0.016;
    g.beginPath(); g.moveTo(0, S * 0.42); g.lineTo(S, S * 0.46); g.stroke();
    g.strokeStyle = 'rgba(206,68,86,0.42)'; g.lineWidth = S * 0.010;
    g.beginPath(); g.moveTo(0, S * 0.58); g.lineTo(S, S * 0.62); g.stroke();
    g.strokeStyle = 'rgba(40,38,34,0.68)';
    word(4, S * 0.5, S * 0.68, S * 0.13);
    endCell();

    // ---- 15 contractor's mark -----------------------------------------------
    S = cellCtx(CELL.logo);
    g.fillStyle = 'rgba(24,54,86,0.88)';
    g.beginPath();
    g.moveTo(S * 0.18, S * 0.70); g.lineTo(S * 0.34, S * 0.28); g.lineTo(S * 0.50, S * 0.70);
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(24,54,86,0.88)';
    word(5, S * 0.66, S * 0.40, S * 0.18);
    endCell();

    // ---- 16..23  THE COLUMN MARKS -------------------------------------------
    // Eight of them, and every one is PAINT rather than a printed decal: a soft,
    // eroded edge, a couple of runs where the can was held too long, overspray
    // haze around the stencil, and a different wording each time. The wording is
    // a grid reference and a level, which is what a setting-out engineer sprays
    // and, not incidentally, is the invented-script system this file already
    // uses everywhere else.
    var MARKS = [
      { a: 'EK', b: 'H05', s: 0.30, c: '#26241f', drips: 3, tilt: -0.05 },
      { a: 'FL', b: '47',  s: 0.34, c: '#2b2823', drips: 2, tilt: 0.04 },
      { a: 'C4', b: 'L47', s: 0.28, c: '#1f2a33', drips: 4, tilt: 0.0 },
      { a: 'D7', b: 'L46', s: 0.31, c: '#2e2620', drips: 1, tilt: 0.07 },
      { a: 'HN', b: '05',  s: 0.36, c: '#242220', drips: 3, tilt: -0.03 },
      { a: 'T3', b: 'X47', s: 0.27, c: '#38271e', drips: 2, tilt: 0.02 },
      { a: 'AR', b: '148', s: 0.32, c: '#22262a', drips: 5, tilt: -0.06 },
      { a: 'MV', b: 'L48', s: 0.29, c: '#2a231d', drips: 2, tilt: 0.05 }
    ];
    for (i = 0; i < MARKS.length; i++) {
      var mk = MARKS[i];
      S = cellCtx(GRIDREFS[i]);
      g.save();
      g.translate(S * 0.5, S * 0.5); g.rotate(mk.tilt); g.translate(-S * 0.5, -S * 0.5);
      // overspray haze first, so the stencil sits IN it rather than on top
      spray(0.10, 520, S, mk.c);
      g.strokeStyle = mk.c;
      text(mk.a, S * 0.5, S * 0.14, S * mk.s);
      g.strokeStyle = 'rgba(34,32,28,0.80)';
      text(mk.b, S * 0.5, S * 0.52, S * mk.s * 0.72);
      // runs: a stencil sprayed on a vertical face always drips somewhere
      for (j = 0; j < mk.drips; j++) {
        var dx0 = rng.range(S * 0.22, S * 0.78);
        var dy0 = rng.range(S * 0.30, S * 0.80);
        var dl = rng.range(S * 0.08, S * 0.30);
        var dg = g.createLinearGradient(0, dy0, 0, dy0 + dl);
        dg.addColorStop(0, 'rgba(38,36,31,0.62)');
        dg.addColorStop(1, 'rgba(38,36,31,0)');
        g.fillStyle = dg;
        g.fillRect(dx0, dy0, rng.range(2.5, 6.0), dl);
        // the bead at the bottom of the run
        g.fillStyle = 'rgba(34,32,28,0.34)';
        g.beginPath();
        g.arc(dx0 + 2, dy0 + dl, rng.range(2.0, 4.5), 0, 6.28318); g.fill();
      }
      // erode the whole mark: a stencil skips over a formed concrete surface
      g.globalCompositeOperation = 'destination-out';
      for (j = 0; j < 260; j++) {
        g.globalAlpha = rng.range(0.10, 0.72);
        g.beginPath();
        g.arc(rng.range(0, S), rng.range(0, S), rng.range(1.5, 9.0), 0, 6.28318);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.restore();
      endCell();
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // A decal card, laid on a face. `axis` picks the plane; `s` the size in
  // metres; `roll` a little rotation so nothing is applied dead square.
  function decalCard(B, cell, x, y, z, w, h, axis, tintC, roll, alpha) {
    var uvr = atlasUV(cell);
    var g = quad(w, h, uvr[0], uvr[1], uvr[2], uvr[3]);
    var m;
    if (axis === 'y') m = makeM(x, y, z, -Math.PI * 0.5, 0, roll || 0);
    else if (axis === 'x+') m = makeM(x, y, z, 0, Math.PI * 0.5, roll || 0);
    else if (axis === 'x-') m = makeM(x, y, z, 0, -Math.PI * 0.5, roll || 0);
    else if (axis === 'z-') m = makeM(x, y, z, 0, Math.PI, roll || 0);
    else if (axis === 'yu') m = makeM(x, y, z, Math.PI * 0.5, 0, roll || 0);  // facing down
    else m = makeM(x, y, z, 0, 0, roll || 0);
    var old = B.tint;
    if (tintC) B.tint = tintC;
    var e = B.add('decal', g, m);
    // Per-card opacity, carried in the alpha of the decal bucket's vertex
    // colour (see _paint). It is what lets a stencil FADE where the concrete
    // has been polished rather than sitting on the surface at full strength
    // everywhere - the difference between paint and a sticker.
    if (alpha !== undefined) e.alpha = alpha;
    B.tint = old;
    return e;
  }

  // ----------------------------------------------------------------------------
  // A SIGN IS AN OBJECT SCREWED TO A WALL, NOT A DECAL PAINTED ON ONE.
  //
  // Every placard in the first cut was a razor-edged rectangle laid flat on the
  // concrete with no fixings, no thickness, no shadow gap and no weathering, on
  // a construction site months into a fit-out. That reads as a UI element
  // dropped into a 3D scene, and the instant-fail list names it directly.
  //
  // This gives one: a backing plate with real thickness stood proud of the wall,
  // four fixing screws with one missing (so the plate hangs off-square about the
  // remaining three), a rust weep under the bottom fixings, and a dust gradient
  // heaviest at the bottom edge.
  //
  //   axis  'x-' 'x+' 'z' 'z-'    which face it is screwed to
  // ----------------------------------------------------------------------------
  function signPlate(B, rng, cell, x, y, z, s, axis, dropped) {
    var t = 0.014;                       // plate thickness
    var roll = dropped ? rng.range(0.11, 0.21) * (rng.bool() ? 1 : -1)
                       : rng.range(-0.05, 0.05);
    var nx = 0, nz = 0;
    if (axis === 'x-') nx = -1; else if (axis === 'x+') nx = 1;
    else if (axis === 'z-') nz = -1; else nz = 1;
    var px = x + nx * t * 0.5, pz = z + nz * t * 0.5;
    // the backing plate
    B.paint = 'paint';
    B.boxR('plant', nx ? t : s * 1.09, s * 1.09, nx ? s * 1.09 : t,
      px, y, pz, 0, 0, roll * (nx ? -1 : 1), 0.003);
    // fixings: three of four, and the fourth hole empty
    B.paint = 'steel';
    var miss = dropped ? (rng.bool() ? 0 : 1) : rng.int(0, 5);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    for (var q = 0; q < 4; q++) {
      if (q === miss) continue;
      var ox = ((q % 2) ? 1 : -1) * s * 0.44, oy = (q < 2 ? 1 : -1) * s * 0.44;
      var lx = ox * cr - oy * sr, ly = ox * sr + oy * cr;
      B.cyl('scaff', 0.008, 0.008, 0.020,
        px + nx * 0.014 + (nz ? lx : 0), y + ly, pz + nz * 0.014 + (nx ? lx : 0),
        nx ? 0 : Math.PI * 0.5, 0, nx ? Math.PI * 0.5 : 0, 6);
    }
    // the graphic itself, faded by the grime it has collected
    B.paint = 'flat';
    var e = decalCard(B, cell, x + nx * (t + 0.004), y, z + nz * (t + 0.004),
      s, s, axis, tint(0xffffff, 0), roll, 0.88);
    // dust film, heaviest at the bottom edge, and a rust weep off the fixings
    decalCard(B, CELL.streak, x + nx * (t + 0.008), y - s * 0.18, z + nz * (t + 0.008),
      s * 0.94, s * 0.62, axis, tint(0xffffff, 0), roll, 0.40);
    decalCard(B, CELL.drip, x + nx * (t + 0.006), y - s * 0.74, z + nz * (t + 0.006),
      s * 0.9, s * 0.55, axis, tint(0xffffff, 0), roll, 0.32);
    B.paint = 'steel';
    return e;
  }

  // ============================================================== THE CITY ===
  // ONE tileable facade map, GRID x GRID window bays, plus a matching EMISSIVE
  // map carrying only the lit ones. Every block maps
  //     u = uOfs + width / BAY_W ,  v = vOfs + height / BAY_H
  // with uOfs/vOfs random INTEGER multiples of 1/GRID, so a single 1024 texture
  // gives every building in the city its own lit-window pattern at the correct
  // physical window size, and the wrap handles the overflow. An atlas cannot do
  // this: a face that needs 14 bays would bleed into its neighbour's cell.
  //
  // This is the market's distantFacadeTexture idea carried up 176 m and given
  // the one thing a city at sunset must have and a desert town must not: rows
  // of lights coming on.
  // 16, not 8. At 8 the whole metropolis had 64 window bays: every facade wider
  // than eight bays repeated the same lit windows at the same floors, and the
  // per-block uOfs only shifted the phase, so the skyline beat into a visible
  // vertical moire. 16 x 16 at 2048 keeps the same 128 px per bay and gives a
  // 256-bay tile, which at a random integer offset per face is past the point
  // where the eye can find the period.
  var CITY_GRID = 16;
  var BAY_W = 3.30, BAY_H = 3.55;      // metres per window bay / storey

  // ---------------------------------------------------------------------------
  // A NORMAL MAP FROM AN ALBEDO, BY SOBEL.
  //
  // ARCHITECTURE 7.7: "surfaces need normal-map detail at two scales or they
  // read as plastic". Six of this level's materials are built on canvases in
  // this file and every one of them shipped map-only - the whole city, the city
  // ground, our own tower's shell, the debris netting and the curtain wall, i.e.
  // essentially everything in frame that is not the plate the player stands on.
  //
  // The albedo already encodes the relief of all of them (a window reveal is
  // dark because it is recessed; a mullion is bright because it is proud; a net
  // thread is opaque because it is a thread), so a 3x3 Sobel over its luminance
  // is a genuinely correct height field rather than a fake. Cheap, deterministic,
  // no assets, and NoColorSpace - a normal map read as sRGB is the silent bug
  // DEVELOPMENT.md warns about.
  // ---------------------------------------------------------------------------
  function sobelNormal(srcCanvas, strength, invert) {
    try {
      if (typeof document === 'undefined' || !document.createElement) return null;
      var S = srcCanvas.width;
      var sc = srcCanvas.getContext('2d');
      if (!sc) return null;
      var src = sc.getImageData(0, 0, S, srcCanvas.height).data;
      var H = srcCanvas.height;
      var out = document.createElement('canvas');
      out.width = S; out.height = H;
      var oc = out.getContext('2d');
      if (!oc) return null;
      var img = oc.createImageData(S, H);
      var d = img.data;
      var sgn = invert ? -1 : 1;
      var k = strength === undefined ? 2.2 : strength;
      // luminance, once
      var lum = new Float32Array(S * H);
      for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
        lum[i] = (src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114) / 255;
      }
      for (var y = 0; y < H; y++) {
        var ym = ((y - 1) + H) % H, yp = (y + 1) % H;
        for (var x = 0; x < S; x++) {
          var xm = ((x - 1) + S) % S, xp = (x + 1) % S;
          var tl = lum[ym * S + xm], tc = lum[ym * S + x], tr = lum[ym * S + xp];
          var ml = lum[y * S + xm], mr = lum[y * S + xp];
          var bl = lum[yp * S + xm], bc = lum[yp * S + x], br = lum[yp * S + xp];
          var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
          var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
          var nx = -gx * k * sgn, ny = -gy * k * sgn, nz = 1.0;
          var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          var o = (y * S + x) * 4;
          d[o] = (nx / l * 0.5 + 0.5) * 255;
          d[o + 1] = (ny / l * 0.5 + 0.5) * 255;
          d[o + 2] = (nz / l * 0.5 + 0.5) * 255;
          d[o + 3] = 255;
        }
      }
      oc.putImageData(img, 0, 0);
      var tex = new THREE.CanvasTexture(out);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.NoColorSpace;      // DATA. never sRGB.
      tex.needsUpdate = true;
      return tex;
    } catch (e) { return null; }        // a normal map is never worth a frame
  }

  var _cityTex = null, _cityEmis = null, _cityNorm = null, _cityRough = null;
  var _cityTried = false;
  function buildCityMaps(rng) {
    if (_cityTried) return _cityTex;
    _cityTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 2048, C = S / CITY_GRID;             // 128 px per bay
    var cvA = document.createElement('canvas'), cvE = document.createElement('canvas');
    var cvR = document.createElement('canvas');
    cvA.width = cvA.height = S; cvE.width = cvE.height = S;
    cvR.width = cvR.height = S;
    var a = cvA.getContext('2d'), e = cvE.getContext('2d');
    var rgh = cvR.getContext('2d');
    if (!a || !e || !rgh) return null;
    // ---- roughness ----------------------------------------------------------
    // A single uniform 0.86 across an entire metropolis is why no building in
    // any frame had a specular event on it at sunset. Spandrel, precast and
    // parapet are rough; the vision glass is a mirror, and a mirror is the only
    // thing that can put the sun back on a facade that the key barely reaches.
    rgh.fillStyle = '#dedede'; rgh.fillRect(0, 0, S, S);
    var i, r, c, q, q2;
    function rgba(cr, cg, cb, al) {
      return 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',' + al.toFixed(3) + ')';
    }
    // Drawn nine times on the torus so the map wraps with no seam - a seam on a
    // tiling facade is a vertical scar every N metres across the whole city.
    function blob(ctx, x, y, rad, R, G, Bc, al) {
      ctx.fillStyle = rgba(R, G, Bc, al);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          ctx.beginPath(); ctx.arc(x + dx * S, y + dy * S, rad, 0, 6.28318); ctx.fill();
        }
      }
    }

    // ---- albedo: precast spandrel + dark glass ------------------------------
    // Deliberately DARKER than anything on the tower. A city that out-values
    // the floor plate in front of it inverts the depth read of every framing.
    a.fillStyle = '#6a675f'; a.fillRect(0, 0, S, S);
    for (i = 0; i < 150; i++) {
      var v = rng.range(-22, 18);
      blob(a, rng.range(0, S), rng.range(0, S), rng.range(10, 60),
        106 + v, 103 + v * 0.96, 95 + v * 0.9, rng.range(0.08, 0.22));
    }
    // storey band + the shadow it throws
    for (r = 0; r < CITY_GRID; r++) {
      a.fillStyle = rgba(46, 44, 40, 0.42); a.fillRect(0, r * C + C - C * 0.10, S, C * 0.05);
      a.fillStyle = rgba(132, 128, 118, 0.40); a.fillRect(0, r * C + C - C * 0.06, S, C * 0.045);
    }
    // piers
    for (c = 0; c < CITY_GRID; c++) {
      a.fillStyle = rgba(120, 116, 107, 0.20); a.fillRect(c * C + 2, 0, C * 0.09, S);
      a.fillStyle = rgba(48, 46, 42, 0.20); a.fillRect(c * C + 2 + C * 0.09, 0, C * 0.035, S);
    }

    // ---- the windows --------------------------------------------------------
    // THE LIT SET IS DECIDED FIRST, AS RUNS, and only then drawn.
    //
    // The previous pass rolled a die per (r, c) cell while the comment claimed
    // the lights were "lit in vertical runs (one tenant, one riser)". They were
    // not: an independent roll per cell is by definition scattered, and at 3x
    // zoom the city read as sprayed confetti with no coherent building faces.
    // A real office tower at dusk lights up by RISER - one tenant leaves a
    // block of three to eight consecutive floors on, on one or two columns of
    // the facade - which is why a night skyline reads as a set of vertical bars
    // and not as static.
    e.fillStyle = '#000000'; e.fillRect(0, 0, S, S);
    var lit = [];
    for (r = 0; r < CITY_GRID; r++) {
      lit.push([]);
      for (c = 0; c < CITY_GRID; c++) lit[r].push(false);
    }
    // Roughly one bay column in three carries a tenant, and each tenant
    // occupies a contiguous run of floors. Wrapped, so the tile is seamless in v
    // as well as u.
    var risers = Math.max(3, Math.round(CITY_GRID * 0.38));
    for (i = 0; i < risers; i++) {
      var rc = rng.int(0, CITY_GRID - 1);
      var runs = rng.int(1, 2);
      for (q = 0; q < runs; q++) {
        var r0 = rng.int(0, CITY_GRID - 1);
        var rl = rng.int(3, 8);
        for (q2 = 0; q2 < rl; q2++) {
          lit[(r0 + q2) % CITY_GRID][rc] = true;
          // a tenant on a corner usually spills one bay sideways
          if (rng.bool(0.34)) lit[(r0 + q2) % CITY_GRID][(rc + 1) % CITY_GRID] = true;
        }
      }
    }
    // plus a thin scatter of single lit rooms - a cleaner, a late meeting
    for (i = 0; i < CITY_GRID * 2; i++) {
      lit[rng.int(0, CITY_GRID - 1)][rng.int(0, CITY_GRID - 1)] = true;
    }

    // ---- THE BAY IS NOW A RIBBON, NOT A PUNCHED SQUARE ----------------------
    // The critic's wording was "window lights render as soft round bokeh dots
    // rather than lit rectangular rooms", and half of that was the winding bug
    // (see faceQuad - every facade was drawn one building-depth too far away, so
    // its bays were 10-25% too small and bloom rounds a near-pixel rectangle).
    // The other half is the bay itself: at 0.62 x 0.56 of the cell it was
    // essentially SQUARE, and a small bright square has no aspect for the eye to
    // read - it blooms to a disc whatever the resolution.
    //
    // A commercial office bay is ribbon glazing: roughly 2:1 landscape, divided
    // by two intermediate mullions into three lights, over a spandrel. So the
    // bay goes to 0.82 x 0.46 and the lit set is drawn as THREE separate
    // emissive rectangles with the mullions left dark between them. Bloom
    // spreads three separated bars into a horizontal streak with structure in
    // it, which is what a lit floor of offices looks like from a kilometre away
    // and what a single disc never can be.
    var MUL = 3;                                   // lights per bay
    for (r = 0; r < CITY_GRID; r++) {
      for (c = 0; c < CITY_GRID; c++) {
        var ww = C * 0.82, wh = C * 0.46;
        var wx = c * C + (C - ww) * 0.5, wy = r * C + C * 0.20;
        var mw = Math.max(2, C * 0.022);           // mullion width in px
        var lwid = (ww - mw * (MUL - 1)) / MUL;    // one light
        var q3;
        // reveal, so the opening has a depth edge and is not a pasted rect
        a.fillStyle = rgba(34, 33, 31, 0.90);
        a.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        // dark glass with a sky gradient in the head
        var gl = a.createLinearGradient(0, wy, 0, wy + wh);
        gl.addColorStop(0, rgba(66, 74, 84, 1));
        gl.addColorStop(0.4, rgba(38, 42, 48, 1));
        gl.addColorStop(1, rgba(26, 28, 32, 1));
        a.fillStyle = gl; a.fillRect(wx, wy, ww, wh);
        // the vision glass is the only smooth thing on the facade
        rgh.fillStyle = '#26262b'; rgh.fillRect(wx, wy, ww, wh);
        // two intermediate mullions - a window with no division reads as a hole
        for (q3 = 1; q3 < MUL; q3++) {
          var mxp = wx + q3 * lwid + (q3 - 1) * mw;
          a.fillStyle = rgba(52, 50, 46, 0.88); a.fillRect(mxp, wy, mw, wh);
          rgh.fillStyle = '#c8c8c8'; rgh.fillRect(mxp, wy, mw, wh);
        }
        // sill: the brightest surviving feature on a hazed facade
        a.fillStyle = rgba(150, 146, 134, 0.80);
        a.fillRect(wx - 4, wy + wh, ww + 8, 4);
        rgh.fillStyle = '#f0f0f0'; rgh.fillRect(wx - 4, wy + wh, ww + 8, 4);

        // ---- how hard the lit ones burn --------------------------------------
        // The sun is still up: this is the hour when the FIRST lights come on,
        // not full night. The first pass ran 30-58% lit at emissive 2.6 and the
        // city photographed as a white speckled carpet that took the whole
        // frame's metering with it - the sky went navy behind a Christmas
        // display.
        if (!lit[r][c]) continue;
        var k = rng.range(0.62, 1.0);
        // One tenant, one lamp spec: warm/cool is decided by the RISER, not by
        // the room, so a run of floors is one colour the way a real fit-out is.
        var warm = ((c * 7 + 3) % 10) < 7;
        var lr = warm ? 255 * k : 214 * k;
        var lg = warm ? 206 * k : 226 * k;
        var lb = warm ? 138 * k : 244 * k;
        a.fillStyle = rgba(lr * 0.26, lg * 0.26, lb * 0.26, 1);
        a.fillRect(wx, wy, ww, wh);
        for (q3 = 0; q3 < MUL; q3++) {
          var lx0 = wx + q3 * (lwid + mw);
          // A lit room is not a flat panel of light: the ceiling is the brightest
          // thing in it and the sill is in shadow, so the emissive runs as a
          // vertical gradient. That gradient is what survives a bloom kernel as a
          // BAR rather than as a blob.
          var eg = e.createLinearGradient(0, wy, 0, wy + wh);
          eg.addColorStop(0, rgba(lr, lg, lb, 1.0));
          eg.addColorStop(0.30, rgba(lr * 0.88, lg * 0.88, lb * 0.90, 1.0));
          eg.addColorStop(1, rgba(lr * 0.46, lg * 0.46, lb * 0.52, 1.0));
          e.fillStyle = eg;
          e.fillRect(lx0 + 1, wy + 1.5, lwid - 2, wh - 3);
          // the fitting itself, a hot band right under the slab
          e.fillStyle = rgba(255, 242, 214, 0.42);
          e.fillRect(lx0 + 1, wy + 1.5, lwid - 2, wh * 0.16);
          // occupancy: a partition or a stack of boxes breaking one light
          if (rng.bool(0.26)) {
            e.fillStyle = 'rgba(0,0,0,0.62)';
            e.fillRect(lx0 + rng.range(1, lwid * 0.4), wy + wh * rng.range(0.34, 0.58),
              rng.range(3, lwid * 0.55), wh * 0.7);
          }
        }
      }
    }
    // grain on the albedo
    try {
      var id = a.getImageData(0, 0, S, S), dt = id.data;
      for (i = 0; i < dt.length; i += 4) {
        var nn = rng.range(-9, 9);
        dt[i] = M.clamp(dt[i] + nn, 0, 255);
        dt[i + 1] = M.clamp(dt[i + 1] + nn * 0.95, 0, 255);
        dt[i + 2] = M.clamp(dt[i + 2] + nn * 0.88, 0, 255);
      }
      a.putImageData(id, 0, 0);
    } catch (eg) { /* never throw out of a build */ }

    _cityTex = new THREE.CanvasTexture(cvA);
    _cityTex.wrapS = _cityTex.wrapT = THREE.RepeatWrapping;
    _cityTex.colorSpace = THREE.SRGBColorSpace;
    _cityTex.needsUpdate = true;
    _cityEmis = new THREE.CanvasTexture(cvE);
    _cityEmis.wrapS = _cityEmis.wrapT = THREE.RepeatWrapping;
    _cityEmis.colorSpace = THREE.SRGBColorSpace;
    _cityEmis.needsUpdate = true;
    // The reveal, the pier, the storey band and the sill are all real relief and
    // the albedo already draws every one of them, so a sobel over it is the
    // facade's actual height field. Sampled BEFORE the grain pass would give a
    // clean derivative; after it gives the micro-tooth precast really has, and
    // the level wants both, so it is taken here.
    _cityNorm = sobelNormal(cvA, 1.5);
    _cityRough = new THREE.CanvasTexture(cvR);
    _cityRough.wrapS = _cityRough.wrapT = THREE.RepeatWrapping;
    _cityRough.colorSpace = THREE.NoColorSpace;
    _cityRough.needsUpdate = true;
    return _cityTex;
  }

  // ========================================================== THE STREET GRID ==
  // The one thing a viewer looks at when they look over a 176 m edge is the
  // GROUND, and until now it was a bare asphalt plate at a 33 m texture repeat,
  // i.e. invisible at 400 m. The city therefore had no floor: from the overview
  // the space between the blocks was a flat pale plane, and from hero3 it read
  // as fog with dots in it.
  //
  // This bakes the actual road network - carriageways, footways, lane markings,
  // block infill and a sodium lighting lane - at ONE TILE PER FOUR CITY BLOCKS
  // (224 m across 2048 px, ~9 px/m), so a 15 m street is 137 px and survives
  // four hundred metres of aerial perspective. The tile aligns with BLK_M, which
  // is the same number the block layout and the lamp lines use, so the roads
  // genuinely run between the buildings rather than under them.
  var _roadTex = null, _roadEmis = null, _roadNorm = null, _roadTried = false;
  function buildStreetMaps(rng, N) {
    if (_roadTried) return _roadTex;
    _roadTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 2048;
    var TILE = BLK_M * 4;                        // world metres across the tile
    var PPM = S / TILE;                          // pixels per metre
    var cvA = document.createElement('canvas'), cvE = document.createElement('canvas');
    cvA.width = cvA.height = S; cvE.width = cvE.height = S;
    var a = cvA.getContext('2d'), e = cvE.getContext('2d');
    if (!a || !e) return null;
    var i, k;
    function rgba(cr, cg, cb, al) {
      return 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',' + al.toFixed(3) + ')';
    }

    // ---- block infill --------------------------------------------------------
    // The blocks are what the plan view is mostly made of, and they are lighter
    // than the carriageway: roofs, yards, car parks, the odd park.
    a.fillStyle = '#43413a'; a.fillRect(0, 0, S, S);
    for (i = 0; i < 900; i++) {
      var bx = rng.range(0, S), bz = rng.range(0, S);
      var bw = rng.range(6, 34) * PPM, bd = rng.range(6, 34) * PPM;
      var v = rng.range(-16, 26);
      a.fillStyle = rgba(74 + v, 71 + v, 64 + v * 0.9, rng.range(0.25, 0.70));
      a.fillRect(bx, bz, bw, bd);
    }
    // a few green squares - a city with no parks is a circuit board
    for (i = 0; i < 7; i++) {
      a.fillStyle = rgba(46, 58, 40, 0.75);
      a.fillRect(rng.range(0, S), rng.range(0, S), rng.range(18, 42) * PPM, rng.range(18, 42) * PPM);
    }

    // ---- the carriageways ----------------------------------------------------
    // Dark, because tarmac at dusk is the darkest thing in a city, and that is
    // exactly the value separation the plan view needs.
    var rw = ROAD_W * PPM;
    function road(px, horiz, width, hot) {
      a.fillStyle = '#211f1c';
      if (horiz) a.fillRect(0, px - width * 0.5, S, width);
      else a.fillRect(px - width * 0.5, 0, width, S);
      // footways
      a.fillStyle = rgba(96, 92, 84, 0.55);
      if (horiz) {
        a.fillRect(0, px - width * 0.5, S, width * 0.16);
        a.fillRect(0, px + width * 0.5 - width * 0.16, S, width * 0.16);
      } else {
        a.fillRect(px - width * 0.5, 0, width * 0.16, S);
        a.fillRect(px + width * 0.5 - width * 0.16, 0, width * 0.16, S);
      }
      // centre line, dashed
      a.fillStyle = rgba(198, 190, 160, 0.50);
      for (k = 0; k < S; k += 9 * PPM) {
        if (horiz) a.fillRect(k, px - width * 0.022, 5 * PPM, width * 0.044);
        else a.fillRect(px - width * 0.022, k, width * 0.044, 5 * PPM);
      }
      // ---- the lighting -----------------------------------------------------
      // Sodium, in the footway, at 32 m centres. This is the emissive half: at
      // 176 m up and 400 m out each lamp is a pixel, and a LINE of pixels
      // running away is the single strongest depth cue the drop has.
      var step = 32 * PPM;
      for (k = step * 0.5; k < S; k += step) {
        for (var s = -1; s <= 1; s += 2) {
          var lx = horiz ? k : px + s * width * 0.40;
          var ly = horiz ? px + s * width * 0.40 : k;
          var gr = e.createRadialGradient(lx, ly, 0, lx, ly, 4.2 * PPM);
          gr.addColorStop(0, hot ? 'rgba(255,226,178,1)' : 'rgba(255,196,132,0.95)');
          gr.addColorStop(0.35, hot ? 'rgba(255,190,120,0.42)' : 'rgba(238,168,96,0.34)');
          gr.addColorStop(1, 'rgba(255,170,90,0)');
          e.fillStyle = gr;
          e.beginPath(); e.arc(lx, ly, 4.2 * PPM, 0, 6.28318); e.fill();
        }
      }
      // and the pool each one throws on the tarmac, in the albedo
      for (k = step * 0.5; k < S; k += step) {
        var gx = horiz ? k : px, gy = horiz ? px : k;
        var g2 = a.createRadialGradient(gx, gy, 0, gx, gy, width * 0.62);
        g2.addColorStop(0, 'rgba(150,112,64,0.30)');
        g2.addColorStop(1, 'rgba(150,112,64,0)');
        a.fillStyle = g2;
        a.beginPath(); a.arc(gx, gy, width * 0.62, 0, 6.28318); a.fill();
      }
    }
    e.fillStyle = '#000000'; e.fillRect(0, 0, S, S);
    for (i = 0; i < 4; i++) {
      var arterial = (i === 1);
      road((i + 0.5) * (S / 4), true, arterial ? rw * 1.7 : rw, arterial);
      road((i + 0.5) * (S / 4), false, arterial ? rw * 1.5 : rw, arterial);
    }
    // one diagonal avenue, because a perfect orthogonal grid photographs as
    // graph paper and every real city has at least one road that ignores it
    a.save();
    a.translate(S * 0.5, S * 0.5); a.rotate(0.62); a.translate(-S * 0.5, -S * 0.5);
    a.fillStyle = '#211f1c'; a.fillRect(-S, S * 0.5 - rw * 0.6, S * 3, rw * 1.2);
    a.fillStyle = rgba(198, 190, 160, 0.42);
    for (k = -S; k < S * 2; k += 9 * PPM) a.fillRect(k, S * 0.5 - rw * 0.03, 5 * PPM, rw * 0.06);
    a.restore();
    e.save();
    e.translate(S * 0.5, S * 0.5); e.rotate(0.62); e.translate(-S * 0.5, -S * 0.5);
    for (k = -S; k < S * 2; k += 30 * PPM) {
      var dg = e.createRadialGradient(k, S * 0.5, 0, k, S * 0.5, 4.0 * PPM);
      dg.addColorStop(0, 'rgba(255,214,160,0.95)');
      dg.addColorStop(1, 'rgba(255,170,90,0)');
      e.fillStyle = dg;
      e.beginPath(); e.arc(k, S * 0.5, 4.0 * PPM, 0, 6.28318); e.fill();
    }
    e.restore();

    // ---- grain ---------------------------------------------------------------
    try {
      var id = a.getImageData(0, 0, S, S), dt = id.data;
      for (i = 0; i < dt.length; i += 4) {
        var nn = rng.range(-11, 11);
        dt[i] = M.clamp(dt[i] + nn, 0, 255);
        dt[i + 1] = M.clamp(dt[i + 1] + nn * 0.96, 0, 255);
        dt[i + 2] = M.clamp(dt[i + 2] + nn * 0.90, 0, 255);
      }
      a.putImageData(id, 0, 0);
    } catch (eg) { /* never throw out of a build */ }

    _roadTex = new THREE.CanvasTexture(cvA);
    _roadTex.wrapS = _roadTex.wrapT = THREE.RepeatWrapping;
    _roadTex.colorSpace = THREE.SRGBColorSpace;
    _roadTex.needsUpdate = true;
    _roadEmis = new THREE.CanvasTexture(cvE);
    _roadEmis.wrapS = _roadEmis.wrapT = THREE.RepeatWrapping;
    _roadEmis.colorSpace = THREE.SRGBColorSpace;
    _roadEmis.needsUpdate = true;
    // Kerbs, footway edges, block edges and roof steps are all 100-300 mm of
    // real relief in a plan view; the albedo draws every one of them as a value
    // step, so the sobel turns the street plane from a printed map into a
    // surface a raking sun can actually catch.
    _roadNorm = sobelNormal(cvA, 1.1);
    return _roadTex;
  }

  // ============================================================== THE GLAZING ==
  // The roster brief singles out "a glass curtain-wall section that reflects the
  // sunset", and the first cut photographed four blank white rectangles: mean
  // [0.800, 0.731, 0.645], min 0.114, max 0.957, with NO internal structure at
  // all. A pane seen at a grazing angle against a bright sky is a mirror, and a
  // mirror with nothing on it is a hole in the image.
  //
  // Real site glazing is six months into an install: it has never been cleaned,
  // it still has protective film on some lights, it carries the installer's
  // suction-cup rings, a manufacturer's sticker, rain streaks off every transom
  // and a squeegee arc where somebody wiped one pane to look through it. That is
  // VALUE STRUCTURE, and value structure is what a pane needs to survive being
  // photographed against a sunset.
  var _glazeTex = null, _glazeAlpha = null, _glazeRough = null, _glazeNorm = null;
  var _glazeTried = false;
  function buildGlazingMaps(rng) {
    if (_glazeTried) return _glazeTex;
    _glazeTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 512;
    var cvA = document.createElement('canvas'), cvM = document.createElement('canvas');
    cvA.width = cvA.height = S; cvM.width = cvM.height = S;
    var a = cvA.getContext('2d'), m = cvM.getContext('2d');
    if (!a || !m) return null;
    var i, k;

    // ---- ALBEDO IS NOT WHITE, AND THAT WAS HALF THE BLANK-RECTANGLE BUG -----
    // A near-white albedo at 86% opacity is a sheet of paper standing between
    // the camera and the sunset, which is exactly what the curtain wall
    // photographed as in hero1 (three pale rectangles filling the west
    // openings) and hero2 (a whole wall of them). Vision glass is a DARK body
    // with a bright reflection on it - the pale part of a dirty pane is the
    // dirt, not the glass - so the field goes to a cool mid-grey and only the
    // slurry, the film and the sticker stay pale.
    // ---- AND IT IS NOW BLUE-GREEN, WHICH IS WHAT VISION GLASS ACTUALLY IS ----
    // The field was a NEUTRAL cool grey at 0x8e969a, i.e. sRGB 0.557 / 0.27
    // linear, and the level's own vertex pass then multiplied it by a WARM ramp
    // (r x 1.26, b x 0.82) that peaked at the head. Two mistakes compounding: a
    // pale neutral body, warmed. The measured result on hero2 is a wall of flat
    // cream rectangles - the critic's "blank rectangles" - and it is arithmetic,
    // not art: 0.27 x 1.50 = an effective diffuse albedo of 0.405 on a surface
    // whose whole job is to be dark and reflect something.
    //
    // Real architectural vision glass is a BODY-TINTED low-e unit: it is
    // blue-green, it is dark, and the pale things on it are the dirt. Taking the
    // field to 0x78868b (0.44 sRGB, 0.16 linear, B > G > R) does two jobs at
    // once - it stops the pane out-valuing the sky it stands in front of, and it
    // is the only large COOL surface in a level the roster pins "orange / glass
    // blue". Against the now-blue upper dome (see setZenithTint) the reflection
    // is cool as well, so the pane finally has warm and cool inside one asset.
    a.fillStyle = '#78868b'; a.fillRect(0, 0, S, S);
    // coverage (used as alphaMap): black = clear glass, white = filthy.
    // 0.239, not 0.172. It is a FLOOR on how much of the pane you see at all,
    // and with opacity down at 0.58 (see _glazingMaterial) the clean glass now
    // lands at 0.14 - i.e. 86% of the sunset behind it comes through, and the
    // 14% that does not is carrying the reflection.
    m.fillStyle = '#3d3d3d'; m.fillRect(0, 0, S, S);

    // dust film, heaviest at the bottom of every light
    var gr = m.createLinearGradient(0, 0, 0, S);
    gr.addColorStop(0, 'rgba(255,255,255,0.10)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.24)');
    gr.addColorStop(1, 'rgba(255,255,255,0.66)');
    m.fillStyle = gr; m.fillRect(0, 0, S, S);

    // rain streaks running down off the transom
    for (i = 0; i < 90; i++) {
      var sx = rng.range(0, S), sw = rng.range(1.5, 9);
      var sg = m.createLinearGradient(0, 0, 0, S);
      var al = rng.range(0.14, 0.52);
      sg.addColorStop(0, 'rgba(255,255,255,' + al.toFixed(3) + ')');
      sg.addColorStop(rng.range(0.5, 0.95), 'rgba(255,255,255,' + (al * 0.35).toFixed(3) + ')');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      m.fillStyle = sg;
      m.fillRect(sx, rng.range(-S * 0.1, S * 0.25), sw, S);
      a.fillStyle = 'rgba(150,146,134,' + (al * 0.5).toFixed(3) + ')';
      a.fillRect(sx, rng.range(-S * 0.1, S * 0.25), sw, S);
    }
    // cement splashes: a facade installed off a scaffold gets slurry on it
    for (i = 0; i < 120; i++) {
      var px = rng.gaussian(S * 0.5, S * 0.30), py = rng.gaussian(S * 0.62, S * 0.30);
      var pr = Math.pow(rng.next(), 2.4) * 13 + 1.2;
      m.fillStyle = 'rgba(255,255,255,' + rng.range(0.35, 0.9).toFixed(3) + ')';
      m.beginPath(); m.ellipse(px, py, pr, pr * rng.range(0.6, 1.4), rng.range(0, 3.14), 0, 6.28318); m.fill();
      a.fillStyle = 'rgba(208,204,194,0.85)';
      a.beginPath(); a.ellipse(px, py, pr, pr * rng.range(0.6, 1.4), rng.range(0, 3.14), 0, 6.28318); a.fill();
    }
    // suction-cup rings from the glazing robot - four per light, dead giveaway
    for (i = 0; i < 4; i++) {
      var cx = S * (i % 2 ? 0.68 : 0.32), cy = S * (i < 2 ? 0.34 : 0.66);
      m.strokeStyle = 'rgba(255,255,255,0.55)'; m.lineWidth = 5;
      m.beginPath(); m.arc(cx, cy, S * 0.075, 0, 6.28318); m.stroke();
      m.strokeStyle = 'rgba(255,255,255,0.22)'; m.lineWidth = 12;
      m.beginPath(); m.arc(cx, cy, S * 0.075, 0, 6.28318); m.stroke();
    }
    // the squeegee arc where somebody wiped a hole to look through
    m.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 5; i++) {
      m.strokeStyle = 'rgba(0,0,0,' + rng.range(0.4, 0.85).toFixed(3) + ')';
      m.lineWidth = rng.range(14, 40);
      m.lineCap = 'round';
      m.beginPath();
      var ay = rng.range(S * 0.35, S * 0.8);
      m.moveTo(rng.range(-20, S * 0.2), ay);
      m.quadraticCurveTo(S * 0.5, ay - rng.range(20, 90), rng.range(S * 0.8, S + 20), ay + rng.range(-30, 30));
      m.stroke();
    }
    m.globalCompositeOperation = 'source-over';
    // manufacturer's sticker, still on, bottom corner
    m.fillStyle = 'rgba(255,255,255,0.97)';
    m.fillRect(S * 0.06, S * 0.80, S * 0.20, S * 0.11);
    a.fillStyle = '#dfe4e6'; a.fillRect(S * 0.06, S * 0.80, S * 0.20, S * 0.11);
    a.fillStyle = '#2d5f86';
    for (k = 0; k < 4; k++) a.fillRect(S * 0.075, S * 0.822 + k * S * 0.020, S * (0.12 + (k % 2) * 0.05), 3);
    // protective-film tape along the head
    m.fillStyle = 'rgba(255,255,255,0.72)';
    m.fillRect(0, S * 0.02, S, S * 0.045);
    a.fillStyle = 'rgba(206,208,198,0.9)'; a.fillRect(0, S * 0.02, S, S * 0.045);

    _glazeTex = new THREE.CanvasTexture(cvA);
    _glazeTex.wrapS = _glazeTex.wrapT = THREE.RepeatWrapping;
    _glazeTex.colorSpace = THREE.SRGBColorSpace;
    _glazeTex.needsUpdate = true;
    // alphaMap and roughnessMap are DATA. NoColorSpace, always.
    _glazeAlpha = new THREE.CanvasTexture(cvM);
    _glazeAlpha.wrapS = _glazeAlpha.wrapT = THREE.RepeatWrapping;
    _glazeAlpha.colorSpace = THREE.NoColorSpace;
    _glazeAlpha.needsUpdate = true;
    _glazeRough = new THREE.CanvasTexture(cvM);
    _glazeRough.wrapS = _glazeRough.wrapT = THREE.RepeatWrapping;
    _glazeRough.colorSpace = THREE.NoColorSpace;
    _glazeRough.needsUpdate = true;
    // Dried slurry, a sticker and a strip of protective film all stand PROUD of
    // the glass; the coverage map is exactly where they are, so it is the right
    // height field. Gentle - the pane is flat and the point is only that a
    // reflected sunset breaks up over the dirt instead of sliding across a
    // mathematical plane.
    _glazeNorm = sobelNormal(cvM, 0.75);
    return _glazeTex;
  }

  // ---- debris netting --------------------------------------------------------
  // Orange scaffold sheeting/netting: alpha-tested, so it writes depth, needs no
  // sorting and still appears in the shadow map - which is the only reason a net
  // reads as a net when the sun is behind it.
  var _netTex = null, _netNorm = null, _netTried = false;
  function netTexture() {
    if (_netTried) return _netTex;
    _netTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 512;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    // A knitted diamond mesh. The tile is 1.4 world metres (see the quad UVs at
    // every call site), so n is the mesh pitch: at n = 10 the diamonds were
    // 140 mm across and the net read as a lattice PAINTED ON GLASS at 4x zoom.
    // Real debris netting is 10-20 mm; 24 puts it at 58 mm, which is as fine as
    // an alpha-tested card can go before mip-mapping starts eating the threads
    // and the whole panel fades out at 30 m.
    var n = 24, p = S / n;
    g.lineCap = 'round';
    // Thin threads, not ribbons: a knitted debris net is roughly 60% open, and
    // at p*0.40 the "net" was an opaque orange sheet with a pattern on it.
    for (var pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? 'rgba(208,96,26,0.95)' : 'rgba(160,66,16,0.95)';
      g.lineWidth = pass ? p * 0.16 : p * 0.26;
      for (var i = -n; i <= n * 2; i++) {
        g.beginPath(); g.moveTo(i * p, -S); g.lineTo(i * p + 2 * S, S); g.stroke();
        g.beginPath(); g.moveTo(i * p, S * 2); g.lineTo(i * p + 2 * S, 0); g.stroke();
      }
    }
    // The knots. A knitted net is not two sets of straight threads: it is a
    // mesh with a bar at every crossing, and the knots are what give it a
    // texture rather than a moire.
    g.fillStyle = 'rgba(224,112,34,0.95)';
    for (i = -1; i <= n + 1; i++) {
      for (var j = -1; j <= n + 1; j++) {
        g.beginPath();
        g.arc((i + (j % 2 ? 0.5 : 0)) * p, j * p * 0.5, p * 0.17, 0, 6.28318);
        g.fill();
      }
    }
    // and a bit of wear: a net that has been up all winter has holes in it
    g.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 26; i++) {
      g.globalAlpha = 0.9;
      g.beginPath();
      g.arc(rngLike(i * 7.13) * S, rngLike(i * 3.71 + 2.2) * S,
        2 + rngLike(i * 11.9) * 9, 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    _netTex = tex;
    // A knitted net is round thread and a raised knot at every crossing, i.e.
    // it is nearly all normal and almost no albedo. Strong, because the whole
    // read of a net against a low sun is the thread catching light on one side.
    _netNorm = sobelNormal(cv, 3.0);
    return tex;
  }

  // ============================================================ THE PLATE ====
  // The poured slab, its edge, its holes and everything sprayed on it.
  function buildPlate(L, B, rng, N) {
    var holes = [
      [VOID_X0, VOID_X1, VOID_Z0, VOID_Z1],
      [LIFT_X0, LIFT_X1, CORE_ZI0, -0.40],
      [LIFT_X0, LIFT_X1, 0.40, CORE_ZI1]
    ];
    B.paint = 'slab';
    var top = gridSurfaceHoles(X0, X1, Z0, Z1, 0.85,
      function (x, z) { return plateY(x, z, N); }, holes);
    B.add('slab', top, null);

    // ---- the slab EDGE ------------------------------------------------------
    // 340 mm of structural depth, seen from every open side and from below when
    // you look over. Without it the floor is a sheet of paper.
    function edgeRun(x0, x1, z0, z1) {
      var w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
      B.box('slab', Math.max(w, 0.02), SLAB_T, Math.max(d, 0.02),
        (x0 + x1) * 0.5, -SLAB_T * 0.5 - 0.005, (z0 + z1) * 0.5, 0.03);
    }
    edgeRun(X0, X1, Z0, Z0 + 0.34);
    edgeRun(X0, X1, Z1 - 0.34, Z1);
    edgeRun(X0, X0 + 0.34, Z0, Z1);
    edgeRun(X1 - 0.34, X1, Z0, Z1);
    // ---- the perimeter edge beam --------------------------------------------
    // 700 mm deep, all the way round. Structurally it is what the slab
    // cantilevers off; compositionally it is the reason the floor plate reads
    // as a FLOOR rather than as a sheet of card. At 340 mm the first capture
    // photographed four flying carpets stacked in the air.
    B.box('slab', X1 - X0, 0.70, 0.46, 0, -0.35 - 0.02, Z0 + 0.23, 0.04);
    B.box('slab', X1 - X0, 0.70, 0.46, 0, -0.35 - 0.02, Z1 - 0.23, 0.04);
    B.box('slab', 0.46, 0.70, Z1 - Z0, X0 + 0.23, -0.35 - 0.02, 0, 0.04);
    B.box('slab', 0.46, 0.70, Z1 - Z0, X1 - 0.23, -0.35 - 0.02, 0, 0.04);
    // And the underside itself, so looking over the edge sees a soffit. In the
    // SOFFIT bucket, not the slab one: a merged slab-key entry is forced onto
    // the slab wear mode (trowel polish BRIGHTENS), so 2200 m2 of underside was
    // being painted as a power-floated floor and photographed in the
    // establishing shot as a sheet of white card under every plate. That is
    // most of why the tower read as stacked flying carpets.
    B.paint = 'soffit';
    B.box('soffit', X1 - X0, 0.06, Z1 - Z0, 0, -SLAB_T - 0.03, 0, 0.02);
    B.paint = 'slab';

    // ---- THE ARRIS IS NOT A LINE -------------------------------------------
    // A freshly struck slab edge is spalled: the formwork pulls lumps out of the
    // top arris when it is stripped, plant knocks corners off, and there is
    // always a run of grout that leaked under the shutter and set as a lip. Four
    // perfectly straight 192 m arrises are "perfectly straight anything" on the
    // leading line of two published framings, so the edge gets broken - 3 to 5
    // events per 10 m, alternating chips (taken out) and grout lips (left on).
    (function () {
      var side, q, n2, t2, ax2, az2, sw2, sd2;
      for (side = 0; side < 4; side++) {
        var horiz2 = side < 2;
        var a0c = horiz2 ? X0 + 0.5 : Z0 + 0.5;
        var a1c = horiz2 ? X1 - 0.5 : Z1 - 0.5;
        n2 = Math.round((a1c - a0c) / 2.6);
        for (q = 0; q < n2; q++) {
          if (rng.bool(0.24)) continue;                 // not every bay
          t2 = (q + rng.range(0.12, 0.88)) / n2;
          var a2 = M.lerp(a0c, a1c, t2);
          ax2 = horiz2 ? a2 : (side === 2 ? X0 + 0.06 : X1 - 0.06);
          az2 = horiz2 ? (side === 0 ? Z0 + 0.06 : Z1 - 0.06) : a2;
          var chip = rng.bool(0.55);
          var len2 = rng.range(0.10, 0.46);
          var hgt2 = rng.range(0.035, 0.13);
          sw2 = horiz2 ? len2 : rng.range(0.06, 0.14);
          sd2 = horiz2 ? rng.range(0.06, 0.14) : len2;
          if (chip) {
            // a lump out of the top arris: a wedge sunk into the edge, so the
            // silhouette against the sky gets a notch rather than a step
            B.boxR('slab', sw2, hgt2 * 2.2, sd2, ax2, -hgt2 * 0.92, az2,
              rng.range(-0.24, 0.24), rng.range(0, 3.14), rng.range(-0.24, 0.24), 0.006);
          } else {
            // grout that ran under the shutter and set: a lip hanging below
            B.boxR('slab', sw2 * 1.3, hgt2, sd2 * 1.3, ax2, -SLAB_T - hgt2 * 0.3, az2,
              rng.range(-0.12, 0.12), rng.range(0, 3.14), rng.range(-0.12, 0.12), 0.004);
          }
        }
      }
    })();

    // ---- edge upstand + starter bars ---------------------------------------
    // The next floor's columns are cast off this one, so every perimeter and
    // every column head carries a cage of L-bars waiting for the pour. They are
    // the level's signature small silhouette, they sit against 176 m of sky, and
    // they are the thing that says UNFINISHED at a hundred metres.
    var i, k, t;
    B.paint = 'steel';
    for (i = 0; i < 4; i++) {
      var horiz = i < 2;
      var n = horiz ? 62 : 48;
      for (k = 0; k < n; k++) {
        t = (k + 0.5) / n;
        var px = horiz ? M.lerp(X0 + 0.4, X1 - 0.4, t) : (i === 2 ? X0 + 0.16 : X1 - 0.16);
        var pz = horiz ? (i === 0 ? Z0 + 0.16 : Z1 - 0.16) : M.lerp(Z0 + 0.4, Z1 - 0.4, t);
        if (px > CORE_X0 - 1 && px < CORE_X1 + 1 && pz > CORE_Z0 - 1 && pz < CORE_Z1 + 1) continue;
        var h = rng.range(0.30, 0.62);
        var lean = rng.range(-0.14, 0.14);
        B.cyl('rebar', 0.010, 0.010, h, px, plateY(px, pz, N) + h * 0.5, pz,
          lean, 0, rng.range(-0.10, 0.10), 5);
        if (rng.bool(0.30)) {
          // the return leg of the L, bent over
          B.cyl('rebar', 0.010, 0.010, 0.16, px + rng.range(-0.08, 0.08),
            plateY(px, pz, N) + h - 0.02, pz + rng.range(-0.08, 0.08),
            Math.PI * 0.5, rng.range(0, 6.28), 0, 5);
        }
      }
    }
    // a continuous horizontal link bar tying the starters together
    for (i = 0; i < 4; i++) {
      var hy = 0.40;
      if (i === 0) B.tube('rebar', X0 + 0.5, hy, Z0 + 0.16, CORE_X0 - 1, hy, Z0 + 0.16, 0.009, 5);
      if (i === 1) B.tube('rebar', X0 + 0.5, hy, Z1 - 0.16, -6.2, hy, Z1 - 0.16, 0.009, 5);
      if (i === 2) B.tube('rebar', X0 + 0.16, hy, Z0 + 0.6, X0 + 0.16, hy, 2.4, 0.009, 5);
      if (i === 3) B.tube('rebar', X1 - 0.16, hy, -5.0, X1 - 0.16, hy, 11.0, 0.009, 5);
    }

    // ---- continuity bars projecting OUT of the slab edge --------------------
    // The next bay is cast off this one, so the reinforcement runs straight out
    // of the edge and waits there. At 300 mm centres over the two barrier gaps
    // and along the open west edge this is the silhouette that says UNFINISHED,
    // it is what hero3's foreground is missing, and it is the one detail on the
    // level that reads at a hundred metres in the establishing shot.
    B.paint = 'steel';
    // ---- CONTINUITY BARS, AND THE UNIFORMITY THEY USED TO SHIP WITH ---------
    // Every stub used to be the same 10 mm diameter at a mathematically exact
    // 300 mm pitch with every second one hooked - which is a comb, and it ran
    // along the leading line of two published framings. LEVELS_ROSTER lists
    // "props that scatter uniformly" and "perfectly clean, straight, or uniform
    // anything" on the instant-fail list, and this was both in one 4 m stretch.
    //
    // Now: the pitch wanders +/- 90 mm about nominal, the diameter varies over
    // the two bar sizes a frame actually uses (10 and 12 mm), the lean is on
    // both axes, the hooks are chosen by rng rather than by parity, and one stub
    // in nine is simply missing - somebody knocked it out with a pallet.
    function outBars(along, a0, a1, fixed, dir) {
      var n2 = Math.max(2, Math.round((a1 - a0) / 0.30));
      for (var q = 0; q <= n2; q++) {
        if (rng.bool(0.11)) continue;
        var t2 = (q + rng.range(-0.30, 0.30)) / n2;
        var px2 = along === 'x' ? M.lerp(a0, a1, t2) : fixed + rng.range(-0.03, 0.03);
        var pz2 = along === 'x' ? fixed + rng.range(-0.03, 0.03) : M.lerp(a0, a1, t2);
        var ex = along === 'x' ? 0 : dir, ez = along === 'x' ? dir : 0;
        var len = rng.range(0.26, 0.70);
        var rad = rng.bool(0.34) ? 0.012 : 0.010;
        var by = -0.10 - rng.range(0, 0.07);
        // a bar bent sideways as well as up - they get walked on
        var skew = rng.range(-0.12, 0.12);
        var lx2 = px2 + ex * len - ez * skew;
        var lz2 = pz2 + ez * len + ex * skew;
        B.tube('rebar', px2, by, pz2, lx2, by + rng.range(-0.05, 0.09), lz2, rad, 5);
        if (rng.bool(0.46)) {
          var hk = rng.range(0.11, 0.22);
          B.tube('rebar', lx2, by, lz2,
            lx2 - ex * 0.03 + rng.range(-0.03, 0.03), by + hk,
            lz2 - ez * 0.03 + rng.range(-0.03, 0.03), rad, 5);
        }
      }
    }
    // the two deliberate gaps in the north edge protection, where the drop is
    // legible and therefore where the eye goes
    outBars('x', -12.5, -3.5, Z0 - 0.04, -1);
    outBars('x', 6.0, 9.0, Z0 - 0.04, -1);
    // and the open west edge, seen end-on from hero2 and edge-on from overview
    outBars('z', Z0 + 1.0, -4.0, X0 - 0.04, -1);
    B.paint = 'slab';

    // ---- the slab void ------------------------------------------------------
    // A double-height opening into floor 46: the level's walkable verticality,
    // and the only place the player can see a floor other than the one they are
    // standing on without going near an edge.
    B.paint = 'slab';
    (function () {
      var cx = (VOID_X0 + VOID_X1) * 0.5, cz = (VOID_Z0 + VOID_Z1) * 0.5;
      var hw = (VOID_X1 - VOID_X0) * 0.5, hd = (VOID_Z1 - VOID_Z0) * 0.5;
      B.box('slab', hw * 2, SLAB_T, 0.05, cx, -SLAB_T * 0.5, VOID_Z0 - 0.02, 0.01);
      B.box('slab', hw * 2, SLAB_T, 0.05, cx, -SLAB_T * 0.5, VOID_Z1 + 0.02, 0.01);
      B.box('slab', 0.05, SLAB_T, hd * 2, VOID_X0 - 0.02, -SLAB_T * 0.5, cz, 0.01);
      B.box('slab', 0.05, SLAB_T, hd * 2, VOID_X1 + 0.02, -SLAB_T * 0.5, cz, 0.01);
      // the FLOOR BELOW, seen through the hole. Big enough that no framing can
      // see past its edge, and its own soffit lights are what lift the hole out
      // of being a black rectangle.
      B.paint = 'slab';
      B.box('slab', 26, 0.25, 24, cx - 2, LOWER_Y - 0.125, cz + 1, 0.02);
      L.addCollider(cx - 2, LOWER_Y - 0.125, cz + 1, 13, 0.125, 12, 'concrete', true);
      // columns continuing down through floor 46, so the hole has depth cues
      B.paint = 'wall';
      for (var a = 0; a < COLX.length; a++) {
        for (var b = 0; b < COLZ.length; b++) {
          var x = COLX[a], z = COLZ[b];
          if (Math.abs(x - cx) > 12 || Math.abs(z - cz) > 11) continue;
          if (x > CORE_X0 - 1) continue;
          B.box('column', COL_W, FLOOR_H - 0.3, COL_W, x, LOWER_Y + (FLOOR_H - 0.3) * 0.5, z, 0.045);
        }
      }
    })();

    // ---- saw-cut joints, as real geometry ----------------------------------
    // 8 mm wide and 25 mm deep. On a 54 m sheet of concrete under a 9.7-degree
    // key these are the strongest lines in the frame and the only thing giving
    // the slab scale and direction.
    B.paint = 'joint';
    for (i = -4; i <= 4; i++) {
      var jx = i * JOINT_PITCH - 3.0;
      if (jx < X0 + 0.6 || jx > X1 - 0.6) continue;
      B.box('slab', 0.030, 0.05, Z1 - Z0 - 1.2, jx, plateY(jx, 0, N) - 0.018, 0, 0.004);
    }
    for (i = -4; i <= 4; i++) {
      var jz = i * JOINT_PITCH - 2.0;
      if (jz < Z0 + 0.6 || jz > Z1 - 0.6) continue;
      B.box('slab', X1 - X0 - 1.2, 0.05, 0.030, 0, plateY(0, jz, N) - 0.018, jz, 0.004);
    }
    B.paint = 'slab';

    // ---- standing water ----------------------------------------------------
    // Rain blows in the open sides. Discs are placed at genuine local minima
    // found by sampling the slab function, never painted onto flat ground.
    var wet = [];
    for (i = 0; i < 420 && wet.length < 22; i++) {
      var wx = rng.range(X0 + 1.5, X1 - 1.5), wz = rng.range(Z0 + 1.5, Z1 - 1.5);
      if (wx > CORE_X0 - 0.5 && wz > CORE_Z0 - 0.5 && wz < CORE_Z1 + 0.5) continue;
      if (wx > VOID_X0 - 1 && wx < VOID_X1 + 1 && wz > VOID_Z0 - 1 && wz < VOID_Z1 + 1) continue;
      if (rainReach(wx, wz) < 0.35) continue;
      if (waterDepth(wx, wz, N) < 0.004) continue;
      var ok = true;
      for (k = 0; k < wet.length; k++) {
        if (Math.abs(wet[k][0] - wx) < 2.6 && Math.abs(wet[k][1] - wz) < 2.6) { ok = false; break; }
      }
      if (!ok) continue;
      wet.push([wx, wz]);
    }
    L.wetPatches = wet;

    // ---- markings ----------------------------------------------------------
    B.paint = 'flat';
    var big = tint(0xffffff, 0);
    for (i = 0; i < COLX.length; i++) {
      for (k = 0; k < COLZ.length; k++) {
        var mx = COLX[i], mz = COLZ[k];
        if (mx > CORE_X0 - 1.2 && mx < CORE_X1 + 1.2 &&
            mz > CORE_Z0 - 1.2 && mz < CORE_Z1 + 1.2) continue;
        // survey cross on the grid intersection, offset a metre as they are
        decalCard(B, CELL.cross, mx + 1.0, plateY(mx + 1, mz, N) + 0.004, mz + 1.0,
          0.85, 0.85, 'y', big, rng.range(-0.2, 0.2));
      }
    }
    // the floor number, huge, sprayed where the hoist lands
    decalCard(B, CELL.level, X1 - 6.5, plateY(X1 - 6.5, -13.0, N) + 0.004, -13.0,
      3.4, 3.4, 'y', big, 0.06);
    // slurry, scuffs and chalk in the traffic lanes
    for (i = 0; i < 34; i++) {
      var sx = rng.range(X0 + 2, X1 - 2), sz = rng.range(Z0 + 2, Z1 - 2);
      if (sx > CORE_X0 && sx < CORE_X1 && sz > CORE_Z0 && sz < CORE_Z1) continue;
      var kind = rng.next();
      var cell = kind < 0.36 ? CELL.splat : (kind < 0.68 ? CELL.scuff : CELL.chalk);
      var sz2 = cell === CELL.scuff ? rng.range(1.8, 4.2) : rng.range(1.0, 2.6);
      decalCard(B, cell, sx, plateY(sx, sz, N) + 0.004, sz, sz2, sz2 * rng.range(0.6, 1.0),
        'y', big, rng.range(0, 6.28));
    }
    // setting-out arrows down the main run
    for (i = 0; i < 6; i++) {
      var ax = M.lerp(X0 + 4, CORE_X0 - 3, (i + 0.5) / 6);
      decalCard(B, CELL.arrow, ax, plateY(ax, 6.4, N) + 0.004, 6.4,
        1.9, 1.9, 'y', big, 1.57 + rng.range(-0.06, 0.06));
    }
    B.paint = 'slab';

    // ---- colliders ----------------------------------------------------------
    // Split around the void and the two shafts, so the holes are real holes the
    // player can fall down rather than glass floors.
    function floorRect(x0, x1, z0, z1) {
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
      L.addCollider((x0 + x1) * 0.5, -SLAB_T * 0.5, (z0 + z1) * 0.5,
        (x1 - x0) * 0.5, SLAB_T * 0.5, (z1 - z0) * 0.5, 'concrete', true);
    }
    floorRect(X0, VOID_X0, Z0, Z1);
    floorRect(VOID_X1, LIFT_X0, Z0, Z1);
    floorRect(VOID_X0, VOID_X1, Z0, VOID_Z0);
    floorRect(VOID_X0, VOID_X1, VOID_Z1, Z1);
    floorRect(LIFT_X0, X1, Z0, CORE_ZI0);
    floorRect(LIFT_X0, X1, CORE_ZI1, Z1);
    floorRect(LIFT_X1, X1, CORE_ZI0, CORE_ZI1);
    floorRect(LIFT_X0, LIFT_X1, -0.40, 0.40);
  }

  // ============================================================ THE SOFFIT ===
  // The underside of floor 48. It is what turns an open deck into an INTERIOR:
  // it caps the frame, it cuts the sun into a horizontal blade, and it is the
  // surface every framing's top third is made of.
  function buildSoffit(L, B, rng, N) {
    B.paint = 'soffit';
    var y = SOFFIT_Y;
    // The slab, in four pieces around the un-poured bay.
    function pan(x0, x1, z0, z1) {
      if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
      B.box('soffit', x1 - x0, SLAB_T, z1 - z0, (x0 + x1) * 0.5, y + SLAB_T * 0.5, (z0 + z1) * 0.5, 0.02);
      L.addCollider((x0 + x1) * 0.5, y + SLAB_T * 0.5, (z0 + z1) * 0.5,
        (x1 - x0) * 0.5, SLAB_T * 0.5, (z1 - z0) * 0.5, 'concrete');
    }
    pan(X0, X1, Z0, DECK_Z0);
    pan(X0, X1, DECK_Z1, Z1);
    pan(X0, DECK_X0, DECK_Z0, DECK_Z1);
    pan(DECK_X1, X1, DECK_Z0, DECK_Z1);
    // the same perimeter edge beam as the plate below - see buildPlate
    B.box('soffit', X1 - X0, 0.70, 0.46, 0, y - 0.35 + 0.02, Z0 + 0.23, 0.04);
    B.box('soffit', X1 - X0, 0.70, 0.46, 0, y - 0.35 + 0.02, Z1 - 0.23, 0.04);
    B.box('soffit', 0.46, 0.70, Z1 - Z0, X0 + 0.23, y - 0.35 + 0.02, 0, 0.04);
    B.box('soffit', 0.46, 0.70, Z1 - Z0, X1 - 0.23, y - 0.35 + 0.02, 0, 0.04);

    // ---- downstand beams ----------------------------------------------------
    // 600 mm deep on the column lines. They are what a soffit IS, they coffer
    // the ceiling into bays, and each one throws its own hard shadow line when
    // the sun blades in under it.
    var i, k;
    for (i = 0; i < COLX.length; i++) {
      var bx = COLX[i];
      if (bx > CORE_X0 - 0.5 && bx < CORE_X1 + 0.5) continue;
      B.box('soffit', 0.42, 0.60, Z1 - Z0 - 0.2, bx, y - 0.30, 0, 0.03);
    }
    for (k = 0; k < COLZ.length; k++) {
      var bz = COLZ[k];
      B.box('soffit', CORE_X0 - X0 - 0.2, 0.52, 0.40, (X0 + CORE_X0) * 0.5, y - 0.26, bz, 0.03);
    }
    // formwork board impressions: 1.2 m ply sheets leave a grid of joint lines
    for (i = -22; i <= 22; i++) {
      var lx = i * 1.22;
      if (lx < X0 + 0.5 || lx > X1 - 0.5) continue;
      B.box('soffit', 0.018, 0.014, Z1 - Z0 - 1.0, lx, y - 0.006, 0, 0.002);
    }
    for (i = -17; i <= 17; i++) {
      var lz = i * 1.22 + 0.4;
      if (lz < Z0 + 0.5 || lz > Z1 - 0.5) continue;
      B.box('soffit', CORE_X0 - X0 - 1.0, 0.014, 0.018, (X0 + CORE_X0) * 0.5 - 0.4, y - 0.006, lz, 0.002);
    }

    // ---- the un-poured bay: permanent steel decking on props ---------------
    B.paint = 'deck';
    var pitch = 0.30;
    for (i = 0; (DECK_X0 + i * pitch) < DECK_X1; i++) {
      var dx = DECK_X0 + i * pitch;
      // trapezoidal profile, modelled: a normal map on a silhouette edge does
      // nothing, and this edge is always seen against the sky
      B.box('deckpan', pitch * 0.62, 0.055, DECK_Z1 - DECK_Z0, dx + pitch * 0.19, y + 0.10, (DECK_Z0 + DECK_Z1) * 0.5, 0.006);
      B.box('deckpan', pitch * 0.30, 0.055, DECK_Z1 - DECK_Z0, dx + pitch * 0.80, y + 0.032, (DECK_Z0 + DECK_Z1) * 0.5, 0.006);
      B.strut('deckpan', dx + pitch * 0.50, y + 0.032, DECK_Z0, dx + pitch * 0.50, y + 0.032, DECK_Z1, 0.010, 0.010);
    }
    // edge trim so the decking terminates on something
    B.box('deckpan', DECK_X1 - DECK_X0, 0.24, 0.05, (DECK_X0 + DECK_X1) * 0.5, y + 0.12, DECK_Z0 - 0.03, 0.01);
    B.box('deckpan', DECK_X1 - DECK_X0, 0.24, 0.05, (DECK_X0 + DECK_X1) * 0.5, y + 0.12, DECK_Z1 + 0.03, 0.01);
    B.box('deckpan', 0.05, 0.24, DECK_Z1 - DECK_Z0, DECK_X0 - 0.03, y + 0.12, (DECK_Z0 + DECK_Z1) * 0.5, 0.01);
    B.box('deckpan', 0.05, 0.24, DECK_Z1 - DECK_Z0, DECK_X1 + 0.03, y + 0.12, (DECK_Z0 + DECK_Z1) * 0.5, 0.01);

    // ---- shoring: adjustable steel props + timber soldiers -----------------
    // A forest of thin verticals in the one part of the plate the sun blades
    // through. Every one of them is a shadow across the floor.
    B.paint = 'steel';
    var nX = 6, nZ = 6;
    for (i = 0; i < nX; i++) {
      for (k = 0; k < nZ; k++) {
        var px = M.lerp(DECK_X0 + 0.9, DECK_X1 - 0.9, (i + 0.5) / nX) + rng.range(-0.16, 0.16);
        var pz = M.lerp(DECK_Z0 + 0.9, DECK_Z1 - 0.9, (k + 0.5) / nZ) + rng.range(-0.16, 0.16);
        var py0 = plateY(px, pz, N);
        B.cyl('scaff', 0.030, 0.030, y - py0 - 0.14, px, (py0 + y - 0.07) * 0.5, pz, 0, 0, 0, 8);
        B.cyl('scaff', 0.042, 0.042, 0.9, px, py0 + 0.45, pz, 0, 0, 0, 8);       // outer tube
        B.box('plant', 0.18, 0.022, 0.18, px, py0 + 0.012, pz, 0.004);           // base plate
        B.box('plant', 0.16, 0.020, 0.16, px, y - 0.09, pz, 0.004);              // head plate
        B.cyl('plant', 0.058, 0.058, 0.045, px, py0 + 0.92, pz, 0, 0, 0, 10);    // adjusting collar
        L.addCollider(px, py0 + 1.2, pz, 0.06, 1.2, 0.06, 'metal');
      }
    }
    // timber soldiers spanning the prop heads
    B.paint = 'ply';
    for (k = 0; k < nZ; k++) {
      var sz = M.lerp(DECK_Z0 + 0.9, DECK_Z1 - 0.9, (k + 0.5) / nZ);
      B.box('timber', DECK_X1 - DECK_X0 - 1.0, 0.14, 0.09,
        (DECK_X0 + DECK_X1) * 0.5, y - 0.15, sz, 0.008);
    }

    // ---- services: cable tray, conduit and containment ---------------------
    B.paint = 'steel';
    for (i = 0; i < 3; i++) {
      var tz = [-12.5, 1.0, 14.5][i];
      var tx0 = X0 + 1.2, tx1 = CORE_X0 - 0.4;
      B.box('grate', tx1 - tx0, 0.02, 0.34, (tx0 + tx1) * 0.5, y - 0.44, tz, 0.004);
      B.box('grate', tx1 - tx0, 0.10, 0.02, (tx0 + tx1) * 0.5, y - 0.40, tz - 0.17, 0.004);
      B.box('grate', tx1 - tx0, 0.10, 0.02, (tx0 + tx1) * 0.5, y - 0.40, tz + 0.17, 0.004);
      for (k = 0; k * 2.4 + tx0 < tx1; k++) {
        var hx = tx0 + k * 2.4;
        B.box('scaff', 0.04, 0.42, 0.04, hx, y - 0.23, tz, 0.006);
      }
      // conduit runs beside it
      B.tube('scaff', tx0, y - 0.30, tz + 0.30, tx1, y - 0.30, tz + 0.30, 0.022, 6);
      B.tube('scaff', tx0, y - 0.30, tz + 0.38, tx1, y - 0.30, tz + 0.38, 0.016, 6);
    }
    // penetrations through the slab above, boxed out in ply
    B.paint = 'ply';
    for (i = 0; i < 9; i++) {
      var kx = rng.range(X0 + 3, CORE_X0 - 2), kz = rng.range(Z0 + 3, Z1 - 3);
      var kw = rng.range(0.4, 1.1);
      B.box('timber', kw, 0.16, kw * rng.range(0.5, 1.0), kx, y - 0.08, kz, 0.01);
    }
    // and the drip stains under them
    B.paint = 'flat';
    for (i = 0; i < 12; i++) {
      var dx2 = rng.range(X0 + 2, CORE_X0 - 1), dz2 = rng.range(Z0 + 2, Z1 - 2);
      decalCard(B, CELL.drip, dx2, y - 0.012, dz2, rng.range(1.4, 3.0), rng.range(1.4, 3.0),
        'yu', tint(0xffffff, 0), rng.range(0, 6.28));
    }
    B.paint = 'soffit';
  }

  // =========================================================== THE COLUMNS ===
  // 860 mm square, chamfered, with the construction joint at each lift, the
  // formwork tie grid, the head cage of starter bars and a plywood corner
  // protector on the ones the buggy runs past. They are the SUBJECT of hero1:
  // every one of them draws a 23 m shadow.
  // Which corner a spalled column shows its bars on, indexed rather than rolled.
  // 0 = -X/-Z, which is the bearing the 9-degree key arrives from, so four of the
  // six carry their steel on a rim-lit arris.
  var SPALL_Q = [0, 0, 3, 0, 1, 0];
  function buildColumns(L, B, rng, N) {
    var out = [];
    var ci = 0;
    for (var i = 0; i < COLX.length; i++) {
      for (var k = 0; k < COLZ.length; k++) {
        var x = COLX[i], z = COLZ[k];
        if (x > CORE_X0 - 0.8 && x < CORE_X1 + 0.8 &&
            z > CORE_Z0 - 0.8 && z < CORE_Z1 + 0.8) continue;
        if (x > VOID_X0 - 0.8 && x < VOID_X1 + 0.8 &&
            z > VOID_Z0 - 0.8 && z < VOID_Z1 + 0.8) continue;
        var y0 = plateY(x, z, N);
        var h = SOFFIT_Y - y0;
        var w = COL_W + rng.range(-0.012, 0.012);
        B.paint = 'wall';
        // Two lifts with a construction joint between them: a column is not one
        // extrusion, and the joint line is where all the staining starts.
        //
        // ---- AND THE ARRIS IS NOW A FACET, NOT A BEVEL ------------------------
        // The bevel went 35 mm -> 55 mm last round and changed nothing, because
        // Geo.bevelBox has no facet to widen (see chamfPrism). These are
        // eight-sided chamfered prisms with a 34 mm cast fillet down the full
        // height, which is what the form's corner chamfer leaves and the only
        // thing that puts a specular line on a column at a 9-degree key.
        // ---- 55 mm, NOT 34, AND THE ARRIS IS NOW PAINTED AS WELL AS MODELLED --
        // The critic still read these as "sharp-cornered boxes". The facet was
        // there - chamfPrism builds a real eighth face - but 34 mm at 6 m is 8 px
        // and it carried the SAME wear value as the two faces beside it, so there
        // was nothing to see: a facet only reads if its value differs. 55 mm is
        // what a 50 mm chamfer fillet nailed into a column form actually leaves,
        // and _paint's `wall` branch now detects the diagonal normal and takes the
        // laitance off it and the edge wear up, because an arris on a site column
        // is the one place the cover has been knocked back to pale aggregate.
        var CH = 0.055;
        B.add('column', chamfPrism(w, h * 0.42, CH), makeM(x, y0 + h * 0.21, z));
        B.add('column', chamfPrism(w - 0.012, h * 0.58, CH),
          makeM(x, y0 + h * 0.42 + h * 0.29, z));
        B.box('column', w + 0.030, 0.028, w + 0.030, x, y0 + h * 0.42, z, 0.008);
        // ---- THE DROP HEAD, WHICH IS WHAT A FLAT SLAB ACTUALLY SITS ON --------
        // A 4 m column meeting a 340 mm slab with nothing between them is a stick
        // pushed into a ceiling, and it is the reason the top of every column in
        // this level had no silhouette at all. A flat-slab frame carries the punching
        // shear on a flared drop head, so the member widens from 860 mm to about
        // 1.3 m over its last 340 mm. It breaks the vertical, it puts a 45-degree
        // facet where the raking key can find it, and it throws a distinctive
        // shadow onto the soffit - which four of five framings look at.
        var dhW = 1.30 * rng.range(0.94, 1.08);
        B.cyl('column', dhW * 0.7071, w * 0.7071, 0.34,
          x, SOFFIT_Y - 0.17, z, 0, Math.PI * 0.25, 0, 4);
        // kicker at the base - the 75 mm upstand the column was cast off, with
        // the grout run that always squeezes out under it
        B.box('column', w + 0.09, 0.075, w + 0.09, x, y0 + 0.037, z, 0.012);
        B.box('column', w + 0.13, 0.022, w + 0.13, x, y0 + 0.011, z, 0.006);
        // formwork tie holes, plugged
        for (var t = 0; t < 6; t++) {
          var ty = y0 + 0.55 + t * 0.58;
          if (ty > SOFFIT_Y - 0.3) break;
          for (var s = -1; s <= 1; s += 2) {
            B.cyl('column', 0.020, 0.020, 0.02, x + s * (w * 0.5 + 0.004), ty, z + (t % 2 ? 0.20 : -0.20),
              0, 0, Math.PI * 0.5, 6);
            B.cyl('column', 0.020, 0.020, 0.02, x + (t % 2 ? -0.20 : 0.20), ty, z + s * (w * 0.5 + 0.004),
              Math.PI * 0.5, 0, 0, 6);
          }
        }
        // head: starter cage for the column above, poking through the soffit.
        // Eight bars on the perimeter, not four on the diagonal - a real column
        // cage has a bar at every corner AND at every face centre, and the
        // difference between four and eight is the difference between a stub
        // and a silhouette.
        B.paint = 'steel';
        var cageR = 0.30;
        for (var a = 0; a < 8; a++) {
          var ca = a / 8 * 6.28318 + 0.3927;
          var bx0 = x + Math.cos(ca) * cageR * 1.41, bz0 = z + Math.sin(ca) * cageR * 1.41;
          bx0 = x + M.clamp(bx0 - x, -cageR, cageR);
          bz0 = z + M.clamp(bz0 - z, -cageR, cageR);
          var bh = rng.range(0.48, 0.72);
          B.cyl('rebar', 0.012, 0.012, bh, bx0, SOFFIT_Y + 0.10 + bh * 0.5 - 0.275,
            bz0, rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05), 5);
        }
        // the links binding the cage, at two levels
        for (a = 0; a < 2; a++) {
          var ly2 = SOFFIT_Y + 0.22 + a * 0.26;
          B.tube('rebar', x - cageR, ly2, z - cageR, x + cageR, ly2, z - cageR, 0.008, 4);
          B.tube('rebar', x + cageR, ly2, z - cageR, x + cageR, ly2, z + cageR, 0.008, 4);
          B.tube('rebar', x + cageR, ly2, z + cageR, x - cageR, ly2, z + cageR, 0.008, 4);
          B.tube('rebar', x - cageR, ly2, z + cageR, x - cageR, ly2, z - cageR, 0.008, 4);
        }
        // plywood corner protector, on about half of them
        if (rng.bool(0.45)) {
          B.paint = 'ply';
          var cy = y0 + 0.62;
          var qa = rng.int(0, 3);
          var ox = (qa === 0 || qa === 3) ? -1 : 1;
          var oz = (qa < 2) ? -1 : 1;
          B.box('timber', 0.018, 1.24, w * 0.9, x + ox * (w * 0.5 + 0.012), cy, z, 0.003);
          B.box('timber', w * 0.9, 1.24, 0.018, x, cy, z + oz * (w * 0.5 + 0.012), 0.003);
        }
        // ---- EXPOSED REBAR, WHICH THE BRIEF ASKS FOR BY NAME ------------------
        // LEVELS_ROSTER's one-line description of this level is "open floor
        // plates, EXPOSED COLUMNS AND REBAR, plastic sheeting..." and until now
        // the only reinforcement on a column was the starter cage above the
        // soffit - i.e. above the ceiling, outside every interior framing. There
        // was no exposed steel anywhere a player stands.
        //
        // Every fifth column carries a spalled corner: the cover has come off in
        // a patch where a load swung into it, and what is behind concrete cover is
        // a vertical bar at every corner inside a spiral of links. Modelled as a
        // recessed dark patch (the void), the bars standing in front of it, two
        // link hoops crossing them, and four broken lumps still hanging on at the
        // perimeter - so the SILHOUETTE of the column breaks, which is the thing a
        // decal can never do.
        // ---- ONE IN THREE, NOT ONE IN FIVE, AND MOSTLY ON THE SUNWARD ARRIS ----
        // At one in five there were five spalls on a 26-column grid and each one
        // sat on a random quadrant, so the chance that any given framing contained
        // a visible one was small - which is why "no rebar" survived a round in
        // which exposed rebar was built. Raised to one in three, and the quadrant
        // is now indexed rather than rolled, with four of six landing on the
        // corner the 9-degree key actually reaches (sq 0 is -X/-Z, the sun bears
        // -0.739/-0.653). A rusted bar with a rim light on it reads; the same bar
        // on a shaded corner does not.
        if (ci % 3 === 1) {
          var spY = y0 + rng.range(1.05, 1.95);
          var spH = rng.range(0.52, 0.86);
          var sq = SPALL_Q[ci % SPALL_Q.length];
          var sx2 = (sq === 0 || sq === 3) ? -1 : 1;
          var sz2 = (sq < 2) ? -1 : 1;
          // the void: inset, and dark because it is a hole with shadow in it
          B.paint = 'wall';
          var vEnt = B.boxR('column', w * 0.46, spH, w * 0.46,
            x + sx2 * (w * 0.30), spY, z + sz2 * (w * 0.30),
            0, 0.785, 0, 0.006);
          if (vEnt) vEnt.dark = 0.62;
          // the corner bar and its two neighbours, 16 mm, rusted
          B.paint = 'steel';
          for (var sb = 0; sb < 3; sb++) {
            var so = (sb - 1) * 0.145;
            B.cyl('rebar', 0.008, 0.008, spH + rng.range(0.10, 0.26),
              x + sx2 * (w * 0.5 - 0.035) - sz2 * so * (sb === 1 ? 0 : 1),
              spY + rng.range(-0.04, 0.04),
              z + sz2 * (w * 0.5 - 0.035) + sx2 * so * (sb === 1 ? 1 : 0),
              rng.range(-0.03, 0.03), 0, rng.range(-0.03, 0.03), 5);
          }
          // link hoops, the pair that used to be inside the cover
          for (var lk = 0; lk < 2; lk++) {
            var lky = spY - spH * 0.28 + lk * spH * 0.56;
            B.tube('rebar', x + sx2 * (w * 0.5 - 0.02), lky, z + sz2 * (w * 0.5 - 0.20),
              x + sx2 * (w * 0.5 - 0.20), lky, z + sz2 * (w * 0.5 - 0.02), 0.006, 4);
          }
          // the lumps that did not come away, and the rubble under it
          B.paint = 'wall';
          for (var lp = 0; lp < 5; lp++) {
            var lpt = rng.range(-0.5, 0.5);
            B.boxR('column', rng.range(0.05, 0.13), rng.range(0.04, 0.10),
              rng.range(0.05, 0.12),
              x + sx2 * (w * 0.5 - 0.01) - sz2 * lpt * 0.22,
              spY + lpt * spH * 0.95,
              z + sz2 * (w * 0.5 - 0.01) + sx2 * lpt * 0.22,
              rng.range(-0.5, 0.5), rng.range(0, 3.14), rng.range(-0.5, 0.5), 0.004);
          }
          for (var rb = 0; rb < 4; rb++) {
            B.boxR('column', rng.range(0.05, 0.14), rng.range(0.03, 0.07),
              rng.range(0.05, 0.14),
              x + sx2 * rng.range(0.5, 1.0), y0 + 0.03,
              z + sz2 * rng.range(0.5, 1.0),
              rng.range(-0.3, 0.3), rng.range(0, 3.14), rng.range(-0.3, 0.3), 0.004);
          }
        }
        // ---- the formwork clamp somebody never took off ----------------------
        // Two forged half-bands round the column with a tie rod through the ears.
        // A hard horizontal band of bright steel at 2.4 m breaks the vertical
        // extrusion, and on a raking key it is the only specular event on the
        // whole member.
        if (ci % 3 === 2) {
          B.paint = 'steel';
          var clY = y0 + rng.range(2.15, 2.85);
          for (var cb = 0; cb < 2; cb++) {
            var cs = cb ? 1 : -1;
            B.box('scaff', w + 0.05, 0.075, 0.030, x, clY, z + cs * (w * 0.5 + 0.02), 0.005);
            B.box('scaff', 0.030, 0.075, w + 0.05, x + cs * (w * 0.5 + 0.02), clY, z, 0.005);
            B.cyl('scaff', 0.011, 0.011, 0.13, x + cs * (w * 0.5 + 0.075), clY,
              z + (w * 0.5 + 0.075), 0, 0, Math.PI * 0.5, 6);
          }
        }
        // ---- first-fix electrical, on about a quarter -------------------------
        // A galvanised adaptable box cast into the column with two 25 mm conduit
        // drops out of the bottom, capped and taped. It is the detail that says a
        // services trade has been through, and it puts a small hard object on a
        // 4 m face that otherwise has nothing on it at eye height.
        if (ci % 4 === 0) {
          B.paint = 'steel';
          var ff = (ci % 8 < 4) ? -1 : 1;
          var fy = y0 + 1.28;
          B.box('grate', 0.020, 0.16, 0.11, x + ff * (w * 0.5 + 0.012), fy, z, 0.004);
          B.tube('scaff', x + ff * (w * 0.5 + 0.008), fy - 0.08, z - 0.028,
            x + ff * (w * 0.5 + 0.008), y0 + 0.10, z - 0.028, 0.013, 6);
          B.tube('scaff', x + ff * (w * 0.5 + 0.008), fy - 0.08, z + 0.028,
            x + ff * (w * 0.5 + 0.008), y0 + 0.42, z + 0.028, 0.013, 6);
          B.cyl('plant', 0.017, 0.017, 0.03, x + ff * (w * 0.5 + 0.008), y0 + 0.44, z + 0.028,
            0, 0, 0, 6);
        }
        B.paint = 'wall';
        // ---- markings -------------------------------------------------------
        // Indexed by column, never rolled: with one cell, one height and one
        // face the whole grid carried the identical mark, which is the
        // instant-fail "perfectly uniform anything" delivered by the level's own
        // storytelling element - and a stencil is high contrast, so it is the
        // first thing a player notices. Three independent strides (mark, height,
        // face) coprime with their own counts guarantee no two adjacent columns
        // agree on all three, and 30% carry no mark at all because in reality
        // the setting-out engineer never got to them.
        B.paint = 'flat';
        if ((ci * 7 + 3) % 10 >= 3) {
          var mkCell = GRIDREFS[(ci * 3 + 1) % GRIDREFS.length];
          var mkY = y0 + 1.62 + ((ci % 5) - 2) * 0.125;
          var mkS = 0.50 + ((ci * 5) % 4) * 0.075;
          var face = (ci * 5 + 2) % 4;         // 0 x-, 1 z-, 2 x+, 3 z+
          var off = w * 0.5 + 0.008;
          // The B channel of the wear mask is trowel polish / edge wear. Paint
          // does not stick to a burnished surface, so the mark FADES where the
          // concrete is polished and stays where it is rough - which is what
          // stops it reading as a sticker laid on top of the noise.
          var polish = M.saturate(N.fbm2(x * 0.30, mkY * 0.30, 2) * 0.5 + 0.5);
          var mkA = M.clamp(0.62 + polish * 0.38, 0.45, 1.0);
          if (face === 0) decalCard(B, mkCell, x - off, mkY, z, mkS, mkS, 'x-',
            tint(0xffffff, 0), rng.range(-0.05, 0.05), mkA);
          else if (face === 1) decalCard(B, mkCell, x, mkY, z - off, mkS, mkS, 'z-',
            tint(0xffffff, 0), rng.range(-0.05, 0.05), mkA);
          else if (face === 2) decalCard(B, mkCell, x + off, mkY, z, mkS, mkS, 'x+',
            tint(0xffffff, 0), rng.range(-0.05, 0.05), mkA);
          else decalCard(B, mkCell, x, mkY, z + off, mkS, mkS, 'z',
            tint(0xffffff, 0), rng.range(-0.05, 0.05), mkA);
        }
        if (rng.bool(0.4)) {
          decalCard(B, CELL.streak, x, y0 + h * 0.5, z + w * 0.5 + 0.008,
            w * 0.9, h * 0.85, 'z', tint(0xffffff, 0), 0, 0.72);
        }
        if (rng.bool(0.22)) {
          decalCard(B, CELL.hazard, x, y0 + 1.05, z - w * 0.5 - 0.008,
            w * 1.0, 0.26, 'z-', tint(0xffffff, 0), 0);
        }
        // pour record, low down, on about a fifth of them
        if (ci % 5 === 2) {
          decalCard(B, CELL.pourdate, x + w * 0.5 + 0.008, y0 + 0.62, z, 0.44, 0.30, 'x+',
            tint(0xffffff, 0), 0.03, 0.80);
        }
        B.paint = 'wall';
        ci++;
        L.addCollider(x, y0 + h * 0.5, z, w * 0.5 + 0.02, h * 0.5, w * 0.5 + 0.02, 'concrete');
        out.push({ x: x, z: z, y: y0, w: w, kind: 'column' });
      }
    }
    return out;
  }

  // =============================================================== THE CORE ===
  // Shear walls, a lift lobby, two OPEN shafts and the escape stair. This is
  // the level's enclosed space and the whole reason it can publish an
  // `interior` framing at all: from the lobby you look 20 m north up a concrete
  // corridor, out onto the plate and straight through the open north edge into
  // the sunset. Dark tube, bright end.
  function buildCore(L, B, rng, N) {
    var y0 = 0, yT = SOFFIT_Y;
    var i, k;
    B.paint = 'wall';

    // wall(x0,x1,z0,z1) with optional openings along its length
    function wall(x0, x1, z0, z1, gaps, headY) {
      var vertical = (x1 - x0) < (z1 - z0);
      var a0 = vertical ? z0 : x0, a1 = vertical ? z1 : x1;
      var segs = [[a0, a1]];
      var g2, s2, out;
      if (gaps) {
        for (g2 = 0; g2 < gaps.length; g2++) {
          out = [];
          for (s2 = 0; s2 < segs.length; s2++) {
            var s = segs[s2];
            if (gaps[g2][1] <= s[0] || gaps[g2][0] >= s[1]) { out.push(s); continue; }
            if (gaps[g2][0] > s[0]) out.push([s[0], gaps[g2][0]]);
            if (gaps[g2][1] < s[1]) out.push([gaps[g2][1], s[1]]);
          }
          segs = out;
        }
      }
      for (s2 = 0; s2 < segs.length; s2++) {
        var p0 = segs[s2][0], p1 = segs[s2][1];
        if (p1 - p0 < 0.02) continue;
        var cx = vertical ? (x0 + x1) * 0.5 : (p0 + p1) * 0.5;
        var cz = vertical ? (p0 + p1) * 0.5 : (z0 + z1) * 0.5;
        var hw = vertical ? (x1 - x0) * 0.5 : (p1 - p0) * 0.5;
        var hd = vertical ? (p1 - p0) * 0.5 : (z1 - z0) * 0.5;
        B.box('core_wall', hw * 2, yT - y0, hd * 2, cx, (y0 + yT) * 0.5, cz, 0.02);
        L.addCollider(cx, (y0 + yT) * 0.5, cz, hw, (yT - y0) * 0.5, hd, 'concrete');
      }
      // the head over each opening
      if (gaps && headY) {
        for (g2 = 0; g2 < gaps.length; g2++) {
          var q0 = gaps[g2][0], q1 = gaps[g2][1];
          var hx = vertical ? (x0 + x1) * 0.5 : (q0 + q1) * 0.5;
          var hz = vertical ? (q0 + q1) * 0.5 : (z0 + z1) * 0.5;
          var hhw = vertical ? (x1 - x0) * 0.5 : (q1 - q0) * 0.5;
          var hhd = vertical ? (q1 - q0) * 0.5 : (z1 - z0) * 0.5;
          B.box('core_wall', hhw * 2, yT - headY, hhd * 2, hx, (headY + yT) * 0.5, hz, 0.02);
          L.addCollider(hx, (headY + yT) * 0.5, hz, hhw, (yT - headY) * 0.5, hhd, 'concrete');
        }
      }
    }

    // west wall: two lobby doorways
    wall(CORE_X0, LOB_X0, CORE_Z0, CORE_Z1, [[-6.4, -3.2], [3.2, 6.4]], 2.45);
    // north wall: solid east of the lobby; the lobby's north end is fully open
    wall(CORE_X0, CORE_X1, CORE_Z0, CORE_ZI0, [[LOB_X0 - 0.02, LOB_X1 + 0.02]], 0);
    // south wall: a door into the stair
    wall(CORE_X0, CORE_X1, CORE_ZI1, CORE_Z1, [[STR_X0 + 0.4, STR_X0 + 3.2]], 2.45);
    // east wall: solid
    wall(STR_X1, CORE_X1, CORE_Z0, CORE_Z1, null, 0);
    // lift bank wall: two shaft openings, no doors fitted
    wall(LOB_X1, LIFT_X0, CORE_ZI0, CORE_ZI1, [[-6.1, -3.9], [3.9, 6.1]], 2.60);
    // between the two shafts
    wall(LIFT_X0, LIFT_X1, -0.40, 0.40, null, 0);
    // stair wall
    wall(LIFT_X1, STR_X0, CORE_ZI0, CORE_ZI1, null, 0);

    // ---- the shafts ---------------------------------------------------------
    // Open, and genuinely deep. A shaft that bottoms out 2 m down is a pit; one
    // you cannot see the bottom of is a drop.
    B.paint = 'wall';
    for (i = 0; i < 2; i++) {
      var sz0 = i ? 0.40 : CORE_ZI0, sz1 = i ? CORE_ZI1 : -0.40;
      // the shaft walls continuing down
      B.box('core_wall', 0.30, 26, sz1 - sz0, LIFT_X1 + 0.15, -13 + 0.2, (sz0 + sz1) * 0.5, 0.02);
      B.box('core_wall', LIFT_X1 - LIFT_X0, 26, 0.24, (LIFT_X0 + LIFT_X1) * 0.5, -13 + 0.2,
        i ? CORE_ZI1 + 0.12 : CORE_ZI0 - 0.12, 0.02);
      // guide rails and the divider steel, receding into the dark
      B.paint = 'steel';
      for (k = 0; k < 2; k++) {
        var gx = LIFT_X0 + 0.35 + k * (LIFT_X1 - LIFT_X0 - 0.7);
        B.box('struct', 0.10, 26, 0.16, gx, -13 + 0.2, (sz0 + sz1) * 0.5, 0.012);
      }
      for (k = 0; k < 7; k++) {
        var by = -k * 4.30 - 0.6;
        B.box('struct', LIFT_X1 - LIFT_X0 - 0.2, 0.16, 0.10,
          (LIFT_X0 + LIFT_X1) * 0.5, by, (sz0 + sz1) * 0.5, 0.012);
      }
      // the barrier across the opening: two scaffold tubes and a mesh panel
      var dz = i ? 5.0 : -5.0;
      B.paint = 'steel';
      B.tube('scaff', LOB_X1 + 0.02, 1.10, dz - 1.05, LOB_X1 + 0.02, 1.10, dz + 1.05, 0.024, 7);
      B.tube('scaff', LOB_X1 + 0.02, 0.52, dz - 1.05, LOB_X1 + 0.02, 0.52, dz + 1.05, 0.024, 7);
      signPlate(B, rng, CELL.danger, LOB_X1 - 0.02, 1.74, dz, 0.56, 'x-', i === 0);
      // The hazard tape below it follows the surface and is torn at both ends:
      // four short segments at slightly different heights and rolls read as a
      // strip somebody stuck on, where one 2.1 m ribbon at a single angle reads
      // as a flat vinyl decal glued to an undulating wall.
      B.paint = 'flat';
      for (var q4 = 0; q4 < 4; q4++) {
        var tz4 = dz - 0.90 + q4 * 0.56;
        decalCard(B, CELL.tape, LOB_X1 - 0.032, 1.42 + Math.sin(q4 * 1.9) * 0.035, tz4,
          0.58, 0.24, 'x-', tint(0xffffff, 0), rng.range(-0.09, 0.09),
          rng.range(0.72, 0.95));
      }
      B.paint = 'wall';
      L.addCollider(LOB_X1 + 0.10, 0.55, dz, 0.10, 0.55, 1.10, 'metal');
    }

    // ---- the escape stair ---------------------------------------------------
    // Two flights and a half landing, going down. Rise kept under the
    // controller's step height so the player simply walks it.
    B.paint = 'wall';
    var stx = (STR_X0 + STR_X1) * 0.5;
    (function () {
      var rise = 0.185, going = 0.27, steps = 11;
      var y = 0;
      // flight 1: south to north, down
      for (var s = 0; s < steps; s++) {
        var sy = y - (s + 1) * rise;
        var sz = 2.0 - (s + 0.5) * going;
        B.box('core_wall', 1.30, 0.05, going + 0.02, STR_X0 + 0.75, sy, sz, 0.006);
        B.box('core_wall', 1.30, rise * 0.8, 0.03, STR_X0 + 0.75, sy - rise * 0.4, sz - going * 0.48, 0.004);
        L.addCollider(STR_X0 + 0.75, sy - 0.13, sz, 0.65, 0.14, going * 0.5 + 0.02, 'concrete', true);
      }
      var landY = y - steps * rise;
      B.box('core_wall', 3.6, 0.22, 1.6, stx, landY - 0.11, -1.9, 0.02);
      L.addCollider(stx, landY - 0.11, -1.9, 1.8, 0.11, 0.8, 'concrete', true);
      // flight 2: north to south, down to floor 46
      for (var s2 = 0; s2 < steps; s2++) {
        var sy2 = landY - (s2 + 1) * rise;
        var sz2 = -2.7 + (s2 + 0.5) * going;
        B.box('core_wall', 1.30, 0.05, going + 0.02, STR_X1 - 0.75, sy2, sz2, 0.006);
        L.addCollider(STR_X1 - 0.75, sy2 - 0.13, sz2, 0.65, 0.14, going * 0.5 + 0.02, 'concrete', true);
      }
      // handrail down the well
      B.paint = 'steel';
      B.tube('scaff', STR_X0 + 1.45, 0.95, 2.1, STR_X0 + 1.45, landY + 0.95, -1.2, 0.024, 7);
      B.tube('scaff', STR_X1 - 1.45, landY + 0.95, -2.6, STR_X1 - 1.45, landY - steps * rise + 0.95, 0.5, 0.024, 7);
      for (var q = 0; q < 5; q++) {
        var qt = q / 4;
        B.cyl('scaff', 0.020, 0.020, 0.95, STR_X0 + 1.45,
          M.lerp(0, landY, qt) + 0.47, M.lerp(2.1, -1.2, qt), 0, 0, 0, 6);
      }
    })();

    // ---- lobby dressing ----------------------------------------------------
    // A concrete corridor with nothing in it is a corridor with nothing in it.
    B.paint = 'wall';
    // the blockwork riser under construction, half built, with the mortar still
    // wet on the top course
    var bx0 = LOB_X0 + 0.05, bz0 = -9.2;
    B.paint = 'block';
    for (i = 0; i < 9; i++) {
      var rows = 9 - Math.floor(i / 3);
      for (k = 0; k < rows; k++) {
        var off = (k % 2) * 0.11;
        B.box('blockwork', 0.44, 0.215, 0.10, bx0 + 0.05 + i * 0.44 * 0 + off + 0.22,
          0.11 + k * 0.225, bz0 + i * 0.10, 0.008);
      }
    }
    B.paint = 'wall';
    // service penetrations and their sleeves through the core walls
    B.paint = 'steel';
    for (i = 0; i < 6; i++) {
      var py = 3.1 + (i % 2) * 0.34;
      var pz = -8.0 + i * 3.1;
      B.cyl('scaff', 0.075, 0.075, 0.46, LOB_X0 - 0.07, py, pz, 0, 0, Math.PI * 0.5, 9);
      B.tube('scaff', LOB_X0 - 0.30, py, pz, LOB_X1 + 0.30, py, pz, 0.038, 7);
    }
    // cable tray down the lobby
    B.box('grate', 0.02, 0.16, CORE_ZI1 - CORE_Z0, LOB_X1 - 0.14, 3.42, (CORE_Z0 + CORE_ZI1) * 0.5, 0.004);
    B.box('grate', 0.30, 0.02, CORE_ZI1 - CORE_Z0, LOB_X1 - 0.30, 3.34, (CORE_Z0 + CORE_ZI1) * 0.5, 0.004);
    for (i = 0; i < 8; i++) {
      var cz2 = CORE_Z0 + 1.4 + i * 2.5;
      B.box('scaff', 0.34, 0.03, 0.03, LOB_X1 - 0.30, 3.44, cz2, 0.004);
    }
    // markings
    signPlate(B, rng, CELL.noentry, LOB_X0 + 0.012, 1.80, -7.6, 0.52, 'x+', false);
    signPlate(B, rng, CELL.label, LOB_X0 + 0.012, 2.32, 1.4, 0.42, 'x+', true);
    B.paint = 'flat';
    decalCard(B, CELL.logo, LOB_X0 + 0.012, 2.05, 7.8, 0.80, 0.80, 'x+',
      tint(0xffffff, 0), -0.02, 0.70);
    for (i = 0; i < 10; i++) {
      var wz = rng.range(CORE_Z0 + 1, CORE_ZI1 - 1);
      decalCard(B, CELL.streak, LOB_X1 - 0.012, rng.range(1.2, 3.2), wz,
        rng.range(0.7, 1.8), rng.range(1.2, 2.6), 'x-', tint(0xffffff, 0), 0);
    }
    B.paint = 'wall';
  }

  // ======================================================= THE CURTAIN WALL ===
  // The one completed piece of envelope, wrapping the south-west corner - the
  // corner the sun goes down behind. From inside it is glazing seen AGAINST the
  // light: mullions as a hard black grid, the disc diffused behind it, and a
  // floor-length pattern of mullion shadows across the slab.
  function buildCurtainWall(L, B, rng, N) {
    var i, k;
    function run(fixedIsX, fixed, a0, a1, outward) {
      var n = Math.max(1, Math.round((a1 - a0) / CW_PITCH));
      var pitch = (a1 - a0) / n;
      for (i = 0; i <= n; i++) {
        var a = a0 + i * pitch;
        var mx = fixedIsX ? fixed : a, mz = fixedIsX ? a : fixed;
        // mullion: a real box section with a pressure plate and a snap cap, so
        // it catches three separate specular lines instead of one
        B.paint = 'paint';
        B.box('mullion', fixedIsX ? 0.16 : 0.075, CW_HEAD - CW_SILL + 0.3,
          fixedIsX ? 0.075 : 0.16, mx, (CW_SILL + CW_HEAD) * 0.5, mz, 0.006);
        B.box('mullion', fixedIsX ? 0.06 : 0.055, CW_HEAD - CW_SILL + 0.3,
          fixedIsX ? 0.055 : 0.06,
          mx + (fixedIsX ? outward * 0.10 : 0), (CW_SILL + CW_HEAD) * 0.5,
          mz + (fixedIsX ? 0 : outward * 0.10), 0.004);
      }
      // transoms: head, floor line and a mid rail
      var ys = [CW_SILL, CW_SILL + 1.05, CW_HEAD - 0.95, CW_HEAD];
      for (k = 0; k < ys.length; k++) {
        B.box('mullion', fixedIsX ? 0.14 : (a1 - a0), 0.085, fixedIsX ? (a1 - a0) : 0.14,
          fixedIsX ? fixed : (a0 + a1) * 0.5, ys[k], fixedIsX ? (a0 + a1) * 0.5 : fixed, 0.006);
      }
      // spandrel: the opaque panel over the floor zone. Real curtain wall is a
      // third spandrel and without it the facade is one sheet of glass.
      B.box('spandrel', fixedIsX ? 0.05 : (a1 - a0), 1.02, fixedIsX ? (a1 - a0) : 0.05,
        fixedIsX ? fixed + outward * 0.02 : (a0 + a1) * 0.5, CW_SILL + 0.55,
        fixedIsX ? (a0 + a1) * 0.5 : fixed + outward * 0.02, 0.01);
      B.box('spandrel', fixedIsX ? 0.05 : (a1 - a0), 0.86, fixedIsX ? (a1 - a0) : 0.05,
        fixedIsX ? fixed + outward * 0.02 : (a0 + a1) * 0.5, CW_HEAD - 0.50,
        fixedIsX ? (a0 + a1) * 0.5 : fixed + outward * 0.02, 0.01);
      // The vision glass, one light per bay - except where the unit has not
      // been hung yet. Three empty frames in a run of twenty-six is what stops
      // an installed facade photographing as one continuous cream light box:
      // an open bay shows the raw sky through a black frame and gives the run
      // the only value contrast it has.
      B.paint = 'glass';
      for (i = 0; i < n; i++) {
        var c = a0 + (i + 0.5) * pitch;
        var hsh = Math.abs(Math.sin((i * 3 + Math.round(a0)) * 7.13) * 1000) % 1;
        if (hsh < 0.13) continue;
        var gx = fixedIsX ? fixed + outward * 0.02 : c;
        var gz = fixedIsX ? c : fixed + outward * 0.02;
        B.box('glazing', fixedIsX ? 0.024 : pitch - 0.12, CW_HEAD - CW_SILL - 2.4,
          fixedIsX ? pitch - 0.12 : 0.024, gx, (CW_SILL + 1.05 + CW_HEAD - 0.95) * 0.5, gz, 0.004);
      }
      B.paint = 'paint';
      // structural silicone joint lines
      for (i = 0; i <= n; i++) {
        var j = a0 + i * pitch;
        B.box('mullion', fixedIsX ? 0.03 : 0.022, CW_HEAD - CW_SILL - 2.3, fixedIsX ? 0.022 : 0.03,
          fixedIsX ? fixed + outward * 0.035 : j, (CW_SILL + CW_HEAD) * 0.5,
          fixedIsX ? j : fixed + outward * 0.035, 0.003);
      }
      // ---- THE THING THAT MAKES A PANE READ AS GLASS -------------------------
      // A transparent surface is invisible by definition: you see what is behind
      // it, and the viewer has no way to know a pane is there at all unless
      // something is ON it. On a facade three weeks out of the crate that
      // something is the protective tape - a big white cross taped corner to
      // corner on every unit that has not been signed off yet, so nobody walks
      // into it. It is high-contrast, unmistakable, universally read as GLAZING,
      // and it costs two alpha cards per pane.
      //
      // Every third bay carries one, chosen by the same deterministic hash the
      // missing units use, so the crosses land on a broken rhythm rather than on
      // every light.
      B.paint = 'flat';
      var gv = (CW_SILL + 1.05 + CW_HEAD - 0.95) * 0.5;
      var gvh = CW_HEAD - CW_SILL - 2.4;
      for (i = 0; i < n; i++) {
        var tc = a0 + (i + 0.5) * pitch;
        var th2 = Math.abs(Math.sin((i * 5 + Math.round(a0)) * 3.71) * 1000) % 1;
        if (th2 < 0.13) continue;                    // the bay has no unit in it
        if (th2 > 0.52) continue;                    // and most are already signed off
        var diag = Math.atan2(gvh, pitch - 0.12);
        var dl = Math.sqrt(gvh * gvh + (pitch - 0.12) * (pitch - 0.12));
        var tx2 = fixedIsX ? fixed + outward * 0.055 : tc;
        var tz2 = fixedIsX ? tc : fixed + outward * 0.055;
        var ax2 = fixedIsX ? (outward < 0 ? 'x-' : 'x+') : (outward < 0 ? 'z-' : 'z');
        decalCard(B, CELL.tape, tx2, gv, tz2, dl * 0.98, 0.13, ax2,
          tint(0xffffff, 0), diag * (fixedIsX ? -outward : outward), 0.95);
        decalCard(B, CELL.tape, tx2, gv, tz2, dl * 0.98, 0.13, ax2,
          tint(0xffffff, 0), -diag * (fixedIsX ? -outward : outward), 0.95);
      }
      B.paint = 'paint';
      // ---- one bay with an opening vent swung out ----------------------------
      // A top-hung vent standing 25 degrees off the plane is the only piece of a
      // curtain wall that has a silhouette, and it is what makes the run read as
      // a built assembly rather than a printed grid. The wind is what it is for.
      (function () {
        var vi2 = Math.max(1, Math.round(n * 0.42));
        var vc = a0 + (vi2 + 0.5) * pitch;      // along the run
        var vw = pitch - 0.16, vh = 1.02;       // sash width along the run, height
        var lean = 0.44;                        // 25 degrees off the plane
        var cs2 = Math.cos(lean), sn2 = Math.sin(lean);
        var hingeY = CW_HEAD - 0.95 - 0.07;     // hung off the upper transom
        var cy2 = hingeY - vh * 0.5 * cs2;      // sash centre height
        var proj = outward * (0.045 + vh * 0.5 * sn2);   // and how far out it is
        // Rotating the sash about the axis that RUNS ALONG the wall is what
        // swings its bottom edge outward. For the west run (normal +/-X, sash
        // spanning Z) that axis is Z, so the roll is rz; for the south run
        // (normal +/-Z, sash spanning X) it is rx, and the sign flips with which
        // way "out" is.
        var rx2 = fixedIsX ? 0 : (outward * lean);
        var rz2 = fixedIsX ? (-outward * lean) : 0;
        var cX = fixedIsX ? fixed + proj : vc;
        var cZ = fixedIsX ? vc : fixed + proj;
        // Offsets from the sash centre to its own head and sill, in world terms:
        // straight up the tilted sash, i.e. up and back in.
        var upY = vh * 0.5 * cs2, upO = -vh * 0.5 * sn2 * outward;
        B.paint = 'paint';
        var fr = 0.052;
        // head and sill rails
        for (var q5 = -1; q5 <= 1; q5 += 2) {
          B.boxR('mullion', fixedIsX ? fr : vw, fr, fixedIsX ? vw : fr,
            cX + (fixedIsX ? q5 * upO : 0), cy2 + q5 * upY,
            cZ + (fixedIsX ? 0 : q5 * upO), rx2, 0, rz2, 0.004);
        }
        // the two jambs
        for (q5 = -1; q5 <= 1; q5 += 2) {
          B.boxR('mullion', fixedIsX ? fr : fr, vh, fr,
            cX + (fixedIsX ? 0 : q5 * vw * 0.5), cy2,
            cZ + (fixedIsX ? q5 * vw * 0.5 : 0), rx2, 0, rz2, 0.004);
        }
        // its glass
        B.paint = 'glass';
        B.boxR('glazing', fixedIsX ? 0.022 : vw - 0.03, vh - 0.03,
          fixedIsX ? vw - 0.03 : 0.022, cX, cy2, cZ, rx2, 0, rz2, 0.004);
        // and the restrictor stay holding it open against the wind
        B.paint = 'steel';
        var sa2 = fixedIsX ? fixed + outward * 0.045 : vc - vw * 0.40;
        var sb2 = fixedIsX ? vc - vw * 0.40 : fixed + outward * 0.045;
        B.tube('scaff', sa2, hingeY - 0.10, sb2,
          fixedIsX ? cX : vc - vw * 0.30, cy2 - vh * 0.16,
          fixedIsX ? vc - vw * 0.30 : cZ, 0.010, 4);
        B.paint = 'paint';
      })();
      // collider: the wall is solid to the player
      L.addCollider(fixedIsX ? fixed : (a0 + a1) * 0.5, (CW_SILL + CW_HEAD) * 0.5,
        fixedIsX ? (a0 + a1) * 0.5 : fixed,
        fixedIsX ? 0.14 : (a1 - a0) * 0.5, (CW_HEAD - CW_SILL) * 0.5,
        fixedIsX ? (a1 - a0) * 0.5 : 0.14, 'glass');
    }

    run(true, X0 + 0.18, CW_WEST_Z0, CW_WEST_Z1, -1);
    run(false, Z1 - 0.18, CW_SOUTH_X0, CW_SOUTH_X1, 1);

    // The last two bays are unglazed - the units are still on the deck, which
    // is what tells you this is a facade being INSTALLED rather than one that
    // was always there.
    B.paint = 'paint';
    for (i = 0; i < 3; i++) {
      var uz = CW_WEST_Z0 - 1.5 - i * CW_PITCH;
      B.box('mullion', 0.16, CW_HEAD - CW_SILL + 0.3, 0.075, X0 + 0.18,
        (CW_SILL + CW_HEAD) * 0.5, uz, 0.006);
    }
    // safety line across the unglazed bays
    B.paint = 'steel';
    B.tube('scaff', X0 + 0.20, 1.10, CW_WEST_Z0 - 4.8, X0 + 0.20, 1.10, CW_WEST_Z0, 0.020, 7);
  }

  // ========================================================== THE OPEN EDGE ===
  // Edge protection: posts, a double guard rail, a toe board and orange debris
  // netting - in RUNS, with gaps. The gaps are the point. A continuous barrier
  // makes the drop safe and therefore invisible; a missing bay at the north-west
  // corner is what makes the level's premise legible from a standing eye.
  // A sagging debris-net panel. Real netting is tied at the standards and
  // bellies between them; a flat card with a UV that restarts at 0 every bay is
  // how eight metres of net ends up looking like one diamond pattern stamped
  // eight times. uOfs shifts the diamond phase per panel.
  function netPanel(w, h, uOfs) {
    var nx = Math.max(3, Math.round(w / 1.0)), ny = 3;
    var pos = [], nor = [], uvs = [], idx = [];
    var i, j;
    for (j = 0; j <= ny; j++) {
      for (i = 0; i <= nx; i++) {
        var fx = i / nx, fy = j / ny;
        // catenary between the ties (every second column is a tie), plus a
        // slow belly over the whole run
        var bay = fx * (nx * 0.5);
        var local = Math.abs((bay % 1) - 0.5) * 2;
        var sag = (1 - local * local) * 0.028 + Math.sin(fx * Math.PI) * 0.045;
        pos.push((fx - 0.5) * w, (fy - 0.5) * h, sag * (0.35 + fy * 0.65));
        nor.push(0, 0, 1);
        uvs.push(uOfs + fx * (w / 1.4), fy * (h / 1.4));
      }
    }
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setIndex(idx);
    var out = g.toNonIndexed();
    g.dispose();
    return out;
  }

  function buildEdgeProtection(L, B, rng, N) {
    var i;
    // [along, a0, a1, netted]  - 'along' is 'x' (north edge) or 'z' (west edge)
    // The GAPS are x -12.5..-3.5 on the north edge (nine metres of nothing, and
    // the mark hero3 is solved on) and x 6..9. A continuous barrier makes the
    // drop safe and therefore invisible.
    // The west run is also split at z -15.2..-11.8, which is where the
    // cantilevered loading platform goes (see buildOutboard): a loading bay
    // replaces a bay of guard rail, and a second break in the barrier is a second
    // place the drop is legible from.
    var RUNS = [
      ['x', X0 + 0.4, -12.5, true],
      ['x', -3.5, 6.0, true],
      ['x', 9.0, X1 - 0.4, true],
      ['z', Z0 + 0.4, -15.2, true],
      ['z', -11.8, -9.0, true],
      // -2.4, not -4.0: the debris chute's receiving hopper (buildOutboard) sits
      // at z -4.0..-2.7 on this arris, and a guard post standing inside it is two
      // objects in the same air 5 m from the hero3 lens.
      ['z', -2.4, CW_WEST_Z0 - 0.6, false]
    ];
    for (var r = 0; r < RUNS.length; r++) {
      var run = RUNS[r];
      var horiz = run[0] === 'x';
      var a0 = run[1], a1 = run[2];
      var n = Math.max(1, Math.round((a1 - a0) / 2.1));
      var fixed = horiz ? Z0 + 0.30 : X0 + 0.30;
      B.paint = 'steel';
      // ---- THE POSTS ARE NOT ON A DRAWING BOARD -----------------------------
      // Identically spaced and identically vertical is one of the instant-fail
      // items, and this run is the leading line of the signature frame. Each
      // post wanders +/- 0.30 m along the run, leans up to 0.08 rad on both
      // axes, and stands 30-60 mm off the nominal line - which is what a socket
      // cast into a slab edge by a man with a tape actually delivers.
      var posts = [];
      for (i = 0; i <= n; i++) {
        var jt = (i + (i === 0 || i === n ? 0 : rng.range(-0.30, 0.30))) / n;
        var a = M.lerp(a0, a1, jt);
        var offN = (i === 0 || i === n) ? 0 : rng.range(-0.055, 0.055);
        var px = horiz ? a : fixed + offN, pz = horiz ? fixed + offN : a;
        var py = plateY(px, pz, N);
        var lean = rng.range(-0.075, 0.075), lean2 = rng.range(-0.075, 0.075);
        var ph2 = rng.range(1.08, 1.19);
        B.box('scaff', 0.055, ph2, 0.055, px, py + ph2 * 0.5, pz, lean, 0, lean2, 0.008);
        B.box('plant', 0.16, 0.030, 0.16, px, py + 0.015, pz, 0.004);
        L.addCollider(px, py + 0.55, pz, 0.08, 0.55, 0.08, 'metal');
        posts.push([px, py, pz, ph2]);
      }
      // ---- RAILS THAT FOLLOW THE POSTS --------------------------------------
      // Two dead-straight tubes drawn from end to end ignored every post they
      // were supposedly clipped to. Drawn post to post, they kink at each one
      // and sag between - which is what a scaffold tube in a clip does.
      for (i = 0; i < 2; i++) {
        var rh = i ? 1.10 : 0.58;
        for (var pq = 0; pq + 1 < posts.length; pq++) {
          var pA = posts[pq], pB = posts[pq + 1];
          var sagR = rng.range(0.004, 0.020);
          var mxr = (pA[0] + pB[0]) * 0.5, mzr = (pA[2] + pB[2]) * 0.5;
          var myr = (pA[1] + pB[1]) * 0.5 + rh - sagR;
          B.tube('scaff', pA[0], pA[1] + rh, pA[2], mxr, myr, mzr, 0.024, 7);
          B.tube('scaff', mxr, myr, mzr, pB[0], pB[1] + rh, pB[2], 0.024, 7);
        }
      }
      // toe board
      B.paint = 'ply';
      if (horiz) B.box('timber', a1 - a0, 0.16, 0.026, (a0 + a1) * 0.5, 0.10, fixed - 0.03, 0.004);
      else B.box('timber', 0.026, 0.16, a1 - a0, fixed - 0.03, 0.10, (a0 + a1) * 0.5, 0.004);
      // debris netting, on the runs that carry it
      if (run[3]) {
        B.paint = 'mesh';
        var len = a1 - a0;
        var mx = horiz ? (a0 + a1) * 0.5 : fixed - 0.045;
        var mz = horiz ? fixed - 0.045 : (a0 + a1) * 0.5;
        // A netted panel sags between its ties and its diamond phase does not
        // restart at every bay. A flat card with a UV starting at 0 every time
        // is why it read as a lattice printed on glass.
        B.add('debris_net', netPanel(len, 1.05, r * 0.37),
          makeM(mx, 0.60, mz, 0, horiz ? 0 : Math.PI * 0.5, 0));
      }
      B.paint = 'steel';
    }

    // ---- the missing bay ----------------------------------------------------
    // A snapped post lying on the slab and a length of barrier tape strung
    // across the gap. Somebody took the guard rail out to land a load and never
    // put it back, which is exactly how it happens.
    B.paint = 'steel';
    B.box('scaff', 0.055, 1.15, 0.055, -11.4, plateY(-11.4, Z0 + 1.7, N) + 0.03, Z0 + 1.7,
      Math.PI * 0.48, 0.6, 0, 0.008);
    // The tape is strung between two tubes 8.8 m apart, so it SAGS - about
    // 90 mm at midspan - and each segment tilts to follow the curve. A tape
    // drawn as a dead-straight ribbon across an 8 m gap is one of the loudest
    // "this is a UI decal in a 3D scene" tells there is, and this one runs
    // across the lower left of the signature frame.
    // ---- THE TAPE ----------------------------------------------------------
    // It was a mathematically clean catenary in six equal spans with a perfectly
    // regular stripe repeat and no twist, no tear and no loose end - i.e. a
    // ribbon drawn with a compass across the foreground of the signature frame.
    // Now: 0.8 m spans, each intermediate node dropped an extra 20-110 mm and
    // rolled up to 0.15 rad about the run, so the tape twists and shows its edge
    // where it has kinked; the stripe phase is broken at every node by jittering
    // the card width, which shifts where the atlas cell starts; and the last
    // 1.6 m has come adrift of the post and hangs down the face of the slab.
    B.paint = 'flat';
    (function () {
      var ta = -12.4, tb = -3.6, top = 0.68, sagMax = 0.095;
      var run = tb - ta;
      var nSeg = Math.max(4, Math.round(run / 0.8));
      var prevX = ta, prevY = top, q;
      for (q = 1; q <= nSeg; q++) {
        var t1 = q / nSeg;
        var x1b = M.lerp(ta, tb, t1);
        var y1t = top - Math.sin(t1 * Math.PI) * sagMax;
        if (q < nSeg) y1t -= rng.range(0.02, 0.11);
        var segW = Math.sqrt((x1b - prevX) * (x1b - prevX) + (y1t - prevY) * (y1t - prevY));
        // the roll is what makes a tape a tape: a flat ribbon seen edge-on for
        // half a metre and face-on for the next
        var roll = Math.atan2(y1t - prevY, x1b - prevX);
        var twist = rng.range(-0.15, 0.15);
        decalCard(B, CELL.tape, (prevX + x1b) * 0.5, (prevY + y1t) * 0.5,
          Z0 + 0.34 + twist * 0.10,
          segW * rng.range(0.94, 1.12), 0.115 * Math.cos(twist) + 0.012,
          'z', tint(0xffffff, 0), roll, rng.range(0.80, 0.96));
        prevX = x1b; prevY = y1t;
      }
      // the snapped end, hanging off the near post down the slab face
      var hx = ta + 0.15, hy = top;
      for (q = 0; q < 4; q++) {
        var hl = rng.range(0.24, 0.42);
        var ang2 = -1.32 + rng.range(-0.30, 0.30) + q * 0.12;
        var nx2 = hx + Math.cos(ang2) * hl, ny2 = hy + Math.sin(ang2) * hl;
        decalCard(B, CELL.tape, (hx + nx2) * 0.5, (hy + ny2) * 0.5,
          Z0 + 0.30 + rng.range(-0.05, 0.05), hl * 1.05, 0.108, 'z',
          tint(0xffffff, 0), ang2, rng.range(0.78, 0.95));
        hx = nx2; hy = ny2;
      }
    })();
    // The placard needs something to be screwed TO. Hung on nothing it is a
    // white rectangle floating over 176 m of air, which is what the first
    // capture printed on the left of hero3.
    B.paint = 'ply';
    B.box('timber', 0.50, 0.50, 0.016, -12.5, 1.10, Z0 + 0.335, 0.004);
    signPlate(B, rng, CELL.danger, -12.5, 1.10, Z0 + 0.328, 0.44, 'z', true);
    B.paint = 'flat';
    decalCard(B, CELL.noentry, -12.5, 1.10, Z0 + 0.348, 0.40, 0.40, 'z-',
      tint(0xffffff, 0), -0.03, 0.86);
    B.paint = 'steel';
    // the tape's tubes
    B.cyl('scaff', 0.024, 0.024, 1.3, -12.4, 0.65, Z0 + 0.34, 0, 0, 0, 7);
    B.cyl('scaff', 0.024, 0.024, 1.3, -3.6, 0.65, Z0 + 0.34, 0, 0, 0, 7);
  }

  // ========================================================= OUTBOARD WORKS ===
  // WHAT AN INBOARD EYE CAN AND CANNOT SEE, AND WHY THIS FUNCTION EXISTS.
  //
  // From an eye E metres above a flat slab, every downward sightline meets that
  // slab at E/tan(p). So from anywhere on this plate the ONLY things visible
  // below plate level are things standing OUTSIDE the 54 x 42 m footprint - our
  // own elevation, three floors of frame and 26 storeys of glazing, is occluded
  // by the floor the camera is standing on, at every pose, always. That is the
  // whole reason round 1 "could not see down", and no camera move fixes it:
  // hero3 stands 450 mm inboard and still sees only a 450 mm sliver of its own
  // building.
  //
  // The answer is geometry that hangs off the edge and continues down out of
  // frame. A site has plenty of it and every piece doubles as a scale reference,
  // because the eye knows how big a rubbish chute and a man-cage are:
  //
  //   * a debris chute, west edge - 22 m of bolted hoppers running down past the
  //     slab, hazard yellow, dead in hero3's near foreground
  //   * a suspended access cradle on the north elevation, on two wire ropes that
  //     run from the floor above to well below the frame - the establishing
  //     shot's scale figure
  //   * hanging temporary services over the west arris, tied off at the edge beam
  //   * a cantilevered loading platform in the north barrier gap, the one piece
  //     that is ABOVE plate level and therefore visible from a standing eye
  // ---------------------------------------------------------------------------
  function buildOutboard(L, B, rng, N) {
    var i, k;

    // ---- 1. THE DEBRIS CHUTE ------------------------------------------------
    // Hung off the west edge beam in the 5 m break in the guard rail, i.e. the
    // one place a player can walk to the arris. Fourteen 1.6 m hoppers on bolted
    // flanges, each one a little out of line with the last, because a chute is
    // shackled together in mid-air by a man leaning over a handrail.
    (function () {
      var cx = X0 - 0.66, cz = -3.35;
      var topY = 0.42;
      // the receiving hopper, on the slab, and the frame that carries it
      B.paint = 'plant';
      B.box('plant', 1.30, 0.62, 1.30, cx + 0.42, topY + 0.62, cz, 0.02);
      B.box('plant', 1.05, 0.40, 1.05, cx + 0.30, topY + 0.14, cz, 0.02);
      B.paint = 'steel';
      for (i = 0; i < 4; i++) {
        var fx2 = cx + 0.42 + ((i % 2) ? 0.62 : -0.62);
        var fz2 = cz + ((i < 2) ? 0.62 : -0.62);
        B.tube('scaff', fx2, topY - 0.35, fz2, fx2, topY + 1.28, fz2, 0.024, 6);
      }
      // the tie back into the slab edge: two chains and a shackle plate
      B.paint = 'steel';
      B.box('struct', 0.26, 0.24, 0.030, X0 + 0.10, 0.16, cz, 0.005);
      for (i = -1; i <= 1; i += 2) {
        B.tube('struct', X0 + 0.10, 0.22, cz + i * 0.10,
          cx + 0.30, topY + 1.02, cz + i * 0.42, 0.014, 4);
      }
      // the stack itself. r tapers very slightly and the axis wanders, so the
      // silhouette against 176 m of air is not a ruled line.
      B.paint = 'plant';
      var px = cx, pz = cz, py = topY;
      for (i = 0; i < 14; i++) {
        var len = 1.60;
        var nx2 = px + rng.range(-0.075, 0.055) - i * 0.012;
        var nz2 = pz + rng.range(-0.075, 0.075);
        var ny2 = py - len;
        var r0 = 0.30 - i * 0.004;
        B.tube('plant', px, py, pz, nx2, ny2, nz2, r0, 8);
        // the bolted flange at every joint - the detail that makes a stack of
        // cones read as a chute rather than as a pipe
        B.cyl('plant', r0 + 0.055, r0 + 0.055, 0.075, nx2, ny2 + 0.03, nz2,
          rng.range(-0.03, 0.03), 0, rng.range(-0.03, 0.03), 10);
        // and a restraint chain back to the elevation every fourth section
        if (i > 0 && i % 4 === 0) {
          B.paint = 'steel';
          B.tube('struct', nx2, ny2 + 0.10, nz2, X0 - 0.02, ny2 + 0.95, nz2 + 0.30, 0.011, 4);
          B.paint = 'plant';
        }
        px = nx2; pz = nz2; py = ny2;
      }
      // hazard marking and a placard on the hopper
      B.paint = 'flat';
      for (i = 0; i < 3; i++) {
        decalCard(B, CELL.hazard, cx + 0.42, topY + 0.30 + i * 0.42, cz - 0.66,
          1.24, 0.24, 'z-', tint(0xffffff, 0), rng.range(-0.03, 0.03), 0.85);
      }
      signPlate(B, rng, CELL.danger, cx + 0.42, topY + 1.02, cz - 0.68, 0.42, 'z-', true);
      B.paint = 'steel';
    })();

    // ---- 2. THE SUSPENDED ACCESS CRADLE ------------------------------------
    // North elevation, hanging 3.1 m below the plate on two ropes that run from
    // the floor above to 14 m below it. In the establishing shot this is the only
    // object in the whole frame whose size the viewer already knows, which is what
    // makes it a scale reference rather than another box.
    (function () {
      var gx = -16.4, gz = Z0 - 0.62, gy = -3.10;
      var gw = 2.70, gd = 0.78, gh = 1.12;
      B.paint = 'steel';
      // the platform: a galvanised tray with a mesh floor and a kick plate
      B.box('scaff', gw, 0.055, gd, gx, gy, gz, 0.008);
      B.box('grate', gw - 0.06, 0.016, gd - 0.06, gx, gy + 0.038, gz, 0.004);
      B.box('scaff', gw, 0.17, 0.030, gx, gy + 0.115, gz - gd * 0.5, 0.005);
      B.box('scaff', gw, 0.17, 0.030, gx, gy + 0.115, gz + gd * 0.5, 0.005);
      // the four corner standards and two rails all round
      for (i = -1; i <= 1; i += 2) {
        for (k = -1; k <= 1; k += 2) {
          B.tube('scaff', gx + i * gw * 0.5, gy, gz + k * gd * 0.5,
            gx + i * gw * 0.5, gy + gh, gz + k * gd * 0.5, 0.022, 6);
        }
        B.tube('scaff', gx - gw * 0.5, gy + gh, gz + i * gd * 0.5,
          gx + gw * 0.5, gy + gh, gz + i * gd * 0.5, 0.020, 5);
        B.tube('scaff', gx - gw * 0.5, gy + gh * 0.55, gz + i * gd * 0.5,
          gx + gw * 0.5, gy + gh * 0.55, gz + i * gd * 0.5, 0.020, 5);
        B.tube('scaff', gx + i * gw * 0.5, gy + gh, gz - gd * 0.5,
          gx + i * gw * 0.5, gy + gh, gz + gd * 0.5, 0.020, 5);
      }
      // the two traction hoists, and the ropes THROUGH them: up to the floor
      // above and down 14 m as tail rope, so the cradle hangs on a line that
      // leaves the frame in both directions
      B.paint = 'plant';
      for (i = -1; i <= 1; i += 2) {
        var hx = gx + i * (gw * 0.5 - 0.22);
        B.box('plant', 0.34, 0.46, 0.30, hx, gy + 0.30, gz, 0.02);
        B.paint = 'steel';
        B.tube('struct', hx, gy + 0.52, gz, hx, SOFFIT_Y + FLOOR_H * 1.4, gz, 0.011, 4);
        B.tube('struct', hx, gy + 0.10, gz, hx + rng.range(-0.25, 0.25),
          gy - 14.0, gz + rng.range(-0.20, 0.20), 0.009, 4);
        B.paint = 'plant';
      }
      // the outrigger beams it hangs from, up on the floor above, and their
      // counterweights - a rope with nothing at the top of it is a rope
      B.paint = 'steel';
      for (i = -1; i <= 1; i += 2) {
        var ox = gx + i * (gw * 0.5 - 0.22);
        B.box('struct', 0.13, 0.16, 3.6, ox, SOFFIT_Y + FLOOR_H * 1.4 + 0.10,
          Z0 + 1.20, 0.012);
        B.paint = 'wall';
        B.box('core_wall', 0.60, 0.42, 0.60, ox, SOFFIT_Y + FLOOR_H * 1.4 + 0.38,
          Z0 + 2.70, 0.02);
        B.paint = 'steel';
      }
      // a bucket and a coil of trailing cable on the deck
      B.paint = 'plant';
      B.cyl('plant', 0.16, 0.13, 0.30, gx + 0.85, gy + 0.19, gz, 0, 0, 0, 9);
      B.paint = 'steel';
      for (i = 0; i < 3; i++) {
        B.tube('struct', gx - 0.9 + i * 0.06, gy + 0.08 + i * 0.03, gz - 0.2,
          gx - 0.5 + i * 0.06, gy + 0.08 + i * 0.03, gz + 0.2, 0.014, 4);
      }
    })();

    // ---- 3. HANGING SERVICES OVER THE WEST ARRIS ---------------------------
    // A bundle of 32 A festoon and welder feeds and a 100 mm layflat, tied off at
    // the edge beam and dropped to the floors below. Four thin verticals that
    // start at the arris and end outside the frame: the cheapest depth cue on the
    // whole level and it costs sixteen cylinders.
    (function () {
      var tz = -11.6;
      B.paint = 'steel';
      B.box('struct', 0.16, 0.13, 0.42, X0 + 0.06, -0.14, tz, 0.008);
      var drops = [
        [-0.30, 0.00, 22.0, 0.020],
        [-0.42, 0.14, 19.5, 0.016],
        [-0.36, -0.16, 25.0, 0.013],
        [-0.55, 0.30, 16.0, 0.028]
      ];
      for (i = 0; i < drops.length; i++) {
        var d2 = drops[i];
        // over the arris first, then a near-vertical hang with a slow drift
        B.tube('struct', X0 + 0.10, -0.10, tz + d2[1] * 0.4,
          X0 + d2[0], -0.55, tz + d2[1], 0.012 + d2[3] * 0.3, 5);
        var sy2 = -0.55, sxx = X0 + d2[0], szz = tz + d2[1];
        for (k = 0; k < 5; k++) {
          var seg2 = d2[2] / 5;
          var ex2 = sxx + rng.range(-0.16, 0.06) - 0.05;
          var ez2 = szz + rng.range(-0.12, 0.12);
          B.tube('struct', sxx, sy2, szz, ex2, sy2 - seg2, ez2, d2[3], 4);
          sxx = ex2; szz = ez2; sy2 -= seg2;
        }
      }
      // and the tape wrap where the bundle passes the arris
      B.paint = 'flat';
      decalCard(B, CELL.tape, X0 - 0.20, -0.30, tz, 0.60, 0.20, 'z-',
        tint(0xffffff, 0), 0.35, 0.9);
      B.paint = 'steel';
    })();

    // ---- 4. THE CANTILEVERED LOADING PLATFORM ------------------------------
    // THE ONE PIECE OF OUTBOARD GEOMETRY THAT STANDS ABOVE PLATE LEVEL, and
    // therefore the only one that a standing eye anywhere on this floor can see
    // at all. Everything else in this function hangs below the slab, where the
    // floor the camera is standing on occludes it from every inboard pose.
    //
    // It goes in the 3.4 m break in the WEST edge protection at z -15.2..-11.8,
    // which buildEdgeProtection leaves for it, and it projects 2.55 m into the
    // void. The bearing is solved, not chosen: from the hero1 eye at (-7.9, 10.2)
    // the platform sits at N38.9W, i.e. 9.6 degrees right of that framing's axis,
    // 30 m out. Its rail top subtends -1.15 degrees against a graze line over the
    // arris at -3.24 degrees, so the deck AND the rails are ABOVE the horizon of
    // the slab the camera stands on - a platform with nothing under it, seen from
    // inside, which is the cue hero1 has never had.
    (function () {
      var lz = -13.5;                       // centre along the run
      var lx0 = X0, lx1 = X0 - 2.55;        // slab arris -> outboard end
      var ly = -0.06;
      var hw2 = 1.43;                       // half the run-wise width
      B.paint = 'steel';
      // two cantilever beams bearing on the slab and the edge beam
      for (i = -1; i <= 1; i += 2) {
        var bz2 = lz + i * 1.35;
        B.box('struct', 5.4, 0.20, 0.14, X0 + 1.30, ly - 0.10, bz2, 0.012);
        // the raking strut back under the slab
        B.strut('struct', lx1 + 0.20, ly - 0.20, bz2, X0 + 0.30, -1.05, bz2, 0.09, 0.09);
      }
      // the deck: scaffold boards spanning the beams, one of them lifted
      B.paint = 'ply';
      for (i = 0; i < 5; i++) {
        var dx3 = lx1 + 0.28 + i * 0.55;
        B.boxR('timber', 0.50, 0.038, 2.86, dx3, ly + (i === 3 ? 0.07 : 0.0), lz,
          rng.range(-0.012, 0.012), 0, i === 3 ? 0.10 : 0.0, 0.006);
      }
      // the handrail: three sides, and the fourth is where the load comes in
      B.paint = 'steel';
      var cn = [[lx1, -hw2], [lx1, hw2], [X0 - 0.20, hw2], [X0 - 0.20, -hw2]];
      for (i = 0; i < 4; i++) {
        B.tube('scaff', cn[i][0], ly, lz + cn[i][1], cn[i][0], ly + 1.12, lz + cn[i][1], 0.024, 7);
      }
      for (k = 0; k < 2; k++) {
        var rh2 = k ? 1.10 : 0.58;
        B.tube('scaff', cn[0][0], ly + rh2, lz + cn[0][1], cn[1][0], ly + rh2 - 0.02, lz + cn[1][1], 0.022, 6);
        B.tube('scaff', cn[1][0], ly + rh2, lz + cn[1][1], cn[2][0], ly + rh2, lz + cn[2][1], 0.022, 6);
        B.tube('scaff', cn[3][0], ly + rh2, lz + cn[3][1], cn[0][0], ly + rh2, lz + cn[0][1], 0.022, 6);
      }
      // netting round the outboard end and one side, and the toe board
      B.paint = 'mesh';
      B.add('debris_net', netPanel(2.86, 0.96, 0.19),
        makeM(lx1 - 0.04, ly + 0.55, lz, 0, Math.PI * 0.5, 0));
      B.add('debris_net', netPanel(2.35, 0.96, 0.61),
        makeM((lx1 + X0) * 0.5, ly + 0.55, lz - hw2 - 0.04, 0, 0, 0));
      B.paint = 'ply';
      B.box('timber', 0.026, 0.16, 2.86, lx1 - 0.02, ly + 0.10, lz, 0.004);
      // a stillage of glazing gaskets and a strop coil landed on it
      B.paint = 'plant';
      B.boxR('plant', 0.72, 0.52, 0.86, lx1 + 1.30, ly + 0.30, lz - 0.55, 0, 0.22, 0, 0.02);
      B.paint = 'steel';
      for (i = 0; i < 4; i++) {
        B.tube('struct', lx1 + 0.75, ly + 0.06 + i * 0.035, lz + 0.75 + i * 0.03,
          lx1 + 1.20, ly + 0.06 + i * 0.035, lz + 1.10 + i * 0.03, 0.018, 4);
      }
      B.paint = 'flat';
      decalCard(B, CELL.hazard, lx1 - 0.05, ly + 0.10, lz, 2.80, 0.22, 'x-',
        tint(0xffffff, 0), 0.01, 0.9);
      signPlate(B, rng, CELL.label, (lx1 + X0) * 0.5, ly + 0.85, lz + hw2 + 0.02, 0.34, 'z', false);
      B.paint = 'steel';
      // walkable, and the rails stop the player walking off it
      L.addCollider((lx1 + X0 - 0.20) * 0.5, ly - 0.06, lz, 1.20, 0.06, hw2, 'metal', true);
      L.addCollider((lx1 + X0) * 0.5, ly + 0.55, lz - hw2 - 0.04, 1.20, 0.55, 0.07, 'metal');
      L.addCollider((lx1 + X0) * 0.5, ly + 0.55, lz + hw2 + 0.04, 1.20, 0.55, 0.07, 'metal');
      L.addCollider(lx1 - 0.04, ly + 0.55, lz, 0.07, 0.55, hw2, 'metal');
    })();
  }

  // ====================================================== PLASTIC SHEETING ===
  // Polythene hung off the soffit on a tube, snapping in the wind. It is the
  // level's only soft, moving, TRANSLUCENT thing, it is hung where the sun is
  // behind it, and update() drives it - a sheet that does not move in a level
  // whose weather is "windy" is a wall.
  //
  // Built as its own indexed grid per sheet so update() can rewrite positions
  // without touching anything else in the merge.
  function sheetGrid(w, h, nx, ny) {
    var pos = [], nor = [], uvs = [], idx = [];
    for (var j = 0; j <= ny; j++) {
      for (var i = 0; i <= nx; i++) {
        pos.push((i / nx - 0.5) * w, -(j / ny) * h, 0);
        nor.push(0, 0, 1);
        uvs.push(i / nx * (w / 2.2), j / ny * (h / 2.2));
      }
    }
    for (var b = 0; b < ny; b++) {
      for (var a = 0; a < nx; a++) {
        var p = b * (nx + 1) + a;
        idx.push(p, p + nx + 1, p + 1, p + 1, p + nx + 1, p + nx + 2);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setIndex(idx);
    return g;
  }

  // The animated sheets are deliberately NOT merged into a bucket: update()
  // rewrites their vertices every frame in LOCAL space, and a merged geometry
  // has already had the world transform baked into it (and, because sheetGrid is
  // indexed, has already been re-expanded to a different vertex count). Six
  // extra draw calls is the correct price. The static polythene elsewhere - the
  // shrink wrap on the block packs, the sheeting on the glazing crates - still
  // goes through the merge like everything else.
  function buildSheeting(L, B, rng, N) {
    // [x, z, yaw, width, height, phase, anchorY]
    // anchorY defaults to the soffit. The last two hang off the NORTH SLAB EDGE
    // and fall past it, which does three jobs at once: they are the vertical
    // that runs out of the bottom of the hero1 frame (the cheapest altitude cue
    // there is), they put a soft moving silhouette on the tower's edge in the
    // establishing shot, and they are the only thing in the level that is
    // genuinely backlit by a sun on the horizon.
    // The yaws were also wrong, and had been from the start: with Euler YXZ a
    // yaw of PI/2 maps the sheet's local +X onto world -Z, so every panel
    // labelled "north edge" actually hung PERPENDICULAR to that edge with half
    // its width cantilevered over 176 m of air, and vice versa on the west. A
    // sheet spans ALONG the opening it covers.
    // ---- AND WHY THEY ARE NOW HALF-HEIGHT ------------------------------------
    // The six soffit-hung panels were 2.60-3.30 m tall on a 3.96 m opening, so
    // each one closed its bay from 0.5 m off the slab to the ceiling. Six of them
    // hung across the north and west apertures is a wall, and it is the wall the
    // level's own premise is on the far side of - hero1 photographed zero sky,
    // zero city and zero air. Polythene is hung at the HEAD as a wind break and
    // it is shredded and tied back below chest height within a week; 1.80-2.20 m
    // leaves the whole standing-eye band clear, which is the band you look
    // through when you look down at a city 176 m below.
    var SHEETS = [
      [X0 + 0.55, -13.2, Math.PI * 0.5, 4.6, 2.15, 0.0],
      // Moved from z -4.2 to +0.5. hero1 now looks WEST-NORTH-WEST straight
      // down the open run and its sightline leaves the plate at (-27, -4.6);
      // a 3.8 m sheet centred on -4.2 sat exactly over that vanishing point and
      // blanked the one place in the frame where the sunset sky and the city
      // below it could be seen. At +0.5 it is 13 degrees off the axis, so the
      // opening reads AND the sheet is still backlit by a sun on the same
      // bearing - which is the condition the brief is actually asking for.
      [X0 + 0.55, 0.5, Math.PI * 0.5, 3.8, 2.05, 1.7],
      [-19.0, Z0 + 0.55, 0, 5.2, 2.20, 3.1],
      [-3.2, Z0 + 0.55, 0, 4.0, 1.80, 4.6],
      [12.5, Z0 + 0.55, 0, 4.6, 2.10, 5.9],
      [X1 - 0.55, 5.0, -Math.PI * 0.5, 4.4, 2.15, 2.4],
      // hung OFF the edge beam and falling past it, outboard of the slab so the
      // floor cannot occlude them
      [-8.4, Z0 - 0.34, 0, 3.4, 5.60, 0.9, -0.22],
      [-15.6, Z0 - 0.34, 0, 3.0, 4.80, 3.8, -0.22],
      [X0 - 0.34, -8.6, Math.PI * 0.5, 3.2, 5.10, 5.2, -0.22]
    ];
    var out = [];
    for (var i = 0; i < SHEETS.length; i++) {
      var s = SHEETS[i];
      var g = sheetGrid(s[3], s[4], 8, 7);
      var p = g.attributes.position;
      // ---- torn corners ------------------------------------------------------
      // A polythene curtain that has been up for a month in a gale is not a
      // rectangle. The bottom corners are shredded and the free edge is ragged,
      // and both are done by pulling the mesh in rather than by an alpha map,
      // because a silhouette against the sky is where a card gets found out.
      (function () {
        var pa2 = p.array, nxs = 8, nys = 7;
        for (var jj = 0; jj <= nys; jj++) {
          for (var ii = 0; ii <= nxs; ii++) {
            var vi2 = (jj * (nxs + 1) + ii) * 3;
            var fy = jj / nys, fx = ii / nxs;
            var edgeT = Math.max(0, fy - 0.55) / 0.45;
            if (edgeT <= 0) continue;
            var corner = Math.max(0, Math.abs(fx - 0.5) * 2 - 0.45) / 0.55;
            var rag = (rngLike(i * 31.7 + ii * 7.3 + jj * 2.9) - 0.35);
            pa2[vi2 + 1] += edgeT * (corner * corner * s[4] * 0.30 + rag * 0.16 * edgeT);
            pa2[vi2] += rag * 0.06 * edgeT;
          }
        }
        p.needsUpdate = true;
      })();
      // ---- CREASES, BAKED INTO THE VERTEX NORMALS ---------------------------
      // A sheet of polythene is never flat: it is a set of long soft ridges
      // running down the hang direction, and the reason it reads as polythene
      // rather than as a board is that a moving highlight travels along the
      // belly of those ridges. update() rewrites positions every frame but
      // never touches normals, so baking them here is both cheaper and more
      // stable than recomputing per frame - the crease pattern is a property of
      // the sheet, not of the gust.
      //
      // h is a two-scale height field; the normal is its gradient in the
      // sheet's own local frame, where +Z is the face normal.
      (function () {
        var nA = g.attributes.normal, pA = p;
        var eps = 0.06;
        var hOf = function (u, v) {
          return N.fbm2(u * 1.45 + s[5] * 2.0, v * 0.55 - s[5], 3) * 0.075 +
                 N.fbm2(u * 5.2 - s[5], v * 3.1 + s[5], 2) * 0.022;
        };
        for (var vv2 = 0; vv2 < pA.count; vv2++) {
          var ux = pA.getX(vv2), uy = pA.getY(vv2);
          var dhx = (hOf(ux + eps, uy) - hOf(ux - eps, uy)) / (2 * eps);
          var dhy = (hOf(ux, uy + eps) - hOf(ux, uy - eps)) / (2 * eps);
          var mx = -dhx * 2.6, my = -dhy * 2.6, mz = 1.0;
          var ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
          nA.setXYZ(vv2, mx / ml, my / ml, mz / ml);
        }
        nA.needsUpdate = true;
      })();
      // Creases baked as value, plus a warm lift where the sun is behind the
      // sheet. Polythene backlit by a sun on the horizon is the brightest soft
      // thing in the level and it must not read as grey plastic.
      var col = new Float32Array(p.count * 3);
      var glow = sunlitSlab(s[0], s[1]);
      for (var v = 0; v < p.count; v++) {
        var lx = p.getX(v), ly = p.getY(v);
        // Creases at TWO scales and a hard contrast between them. At one scale
        // and a 0.4 range these panels printed as blank white boards hung in the
        // openings, which is the worst thing a translucent surface can do -
        // polythene reads as polythene only because the light through it varies
        // by a factor of two across a fold.
        var cr = N.fbm2(lx * 2.4 + s[5] * 3.0, ly * 2.1 - s[5], 3) * 0.5 + 0.5;
        var cf = N.fbm2(lx * 9.5 - s[5], ly * 8.0 + s[5] * 2.0, 2) * 0.5 + 0.5;
        var lift = 0.30 + M.smoothstep(0.28, 0.86, cr) * 0.46 + cf * 0.14;
        // it sags and dirties toward the free bottom edge
        lift *= 1 - M.saturate(-ly / Math.max(0.3, s[4])) * 0.30;
        col[v * 3] = lift * (1.00 + glow * 0.24);
        col[v * 3 + 1] = lift * (0.96 + glow * 0.13);
        col[v * 3 + 2] = lift * (0.92 + glow * 0.01);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      Geo.copyUV1(g);
      var anchorY = s[6] === undefined ? SOFFIT_Y - 0.16 : s[6];
      out.push({
        geo: g, base: new Float32Array(p.array), phase: s[5],
        w: s[3], h: s[4],
        matrix: makeM(s[0], anchorY, s[1], 0, s[2], 0)
      });
      // the tube it is hung from
      B.paint = 'steel';
      var hx = s[0], hz = s[1];
      var tubeY = anchorY + 0.02;
      var ax = hx - Math.cos(s[2]) * s[3] * 0.5, az = hz + Math.sin(s[2]) * s[3] * 0.5;
      var bx = hx + Math.cos(s[2]) * s[3] * 0.5, bz = hz - Math.sin(s[2]) * s[3] * 0.5;
      B.tube('scaff', ax, tubeY, az, bx, tubeY, bz, 0.022, 7);
      // ---- grommets and cable ties -------------------------------------------
      // The head of a polythene curtain is not glued on. It is eyeletted at
      // ~400 mm centres and cable-tied to the tube, and at 2 m those ties are
      // the only thing that says "this was hung by a person".
      var nEye = Math.max(3, Math.round(s[3] / 0.42));
      for (var q3 = 0; q3 <= nEye; q3++) {
        var et = q3 / nEye;
        var ex2 = M.lerp(ax, bx, et), ez2 = M.lerp(az, bz, et);
        B.cyl('scaff', 0.014, 0.014, 0.006, ex2, anchorY - 0.05, ez2,
          Math.PI * 0.5, 0, 0, 8);                                  // the eyelet
        B.tube('scaff', ex2, anchorY - 0.05, ez2, ex2, tubeY + 0.03, ez2, 0.004, 4);
      }
      // and the batten screwed through it at the head, which is what a sheet is
      // actually fixed with
      B.paint = 'ply';
      B.boxR('timber', s[3] * 0.98, 0.05, 0.028, hx, anchorY - 0.055, hz, 0, s[2], 0, 0.004);
      B.paint = 'steel';
    }
    return out;
  }

  // ============================================================ SCAFFOLDING ===
  // A tube-and-fitting facade scaffold on the east elevation, four lifts, with
  // boards, ledgers, transoms, diagonal bracing, ties into the frame and a
  // ladder. It reads through the open east bays and it is the level's densest
  // silhouette - see it against a bright sky and it is a lattice, which is
  // exactly what verticality is made of.
  function buildScaffold(L, B, rng, N) {
    var lifts = [-2.0, 0.10, 2.10, 4.10, 6.10];
    var bays = Math.max(2, Math.round((SCAF_Z1 - SCAF_Z0) / 2.1));
    var pitch = (SCAF_Z1 - SCAF_Z0) / bays;
    var rows = [SCAF_X + 0.42, SCAF_X + 1.55];      // inner and outer standards
    var i, k, r;
    B.paint = 'steel';
    for (r = 0; r < rows.length; r++) {
      for (i = 0; i <= bays; i++) {
        var z = SCAF_Z0 + i * pitch;
        B.tube('scaff', rows[r], lifts[0] - 0.4, z, rows[r], lifts[lifts.length - 1] + 1.1, z, 0.024, 8);
        B.box('plant', 0.16, 0.024, 0.16, rows[r], lifts[0] - 0.40, z, 0.004);
      }
    }
    // A COUPLER IS A CLAMP, NOT A RING. Two 45 mm forged halves round the tube
    // with a bolt through the ear - a dozen triangles each, and the difference
    // between "scaffold" and "pipes crossing in mid air" at 3x zoom.
    function coupler(cx, cy, cz, axis) {
      B.paint = 'steel';
      if (axis === 'z') {
        B.cyl('scaff', 0.046, 0.046, 0.030, cx, cy, cz - 0.020, 0, 0, Math.PI * 0.5, 8);
        B.cyl('scaff', 0.046, 0.046, 0.030, cx, cy, cz + 0.020, 0, 0, Math.PI * 0.5, 8);
        B.box('scaff', 0.020, 0.024, 0.086, cx + 0.046, cy, cz, 0.004);
        B.cyl('plant', 0.011, 0.011, 0.052, cx + 0.052, cy, cz, Math.PI * 0.5, 0, 0, 6);
      } else {
        B.cyl('scaff', 0.046, 0.046, 0.030, cx, cy - 0.020, cz, 0, 0, 0, 8);
        B.cyl('scaff', 0.046, 0.046, 0.030, cx, cy + 0.020, cz, 0, 0, 0, 8);
        B.box('scaff', 0.086, 0.024, 0.020, cx, cy, cz + 0.046, 0.004);
        B.cyl('plant', 0.011, 0.011, 0.052, cx, cy, cz + 0.052, Math.PI * 0.5, 0, 0, 6);
      }
      B.paint = 'steel';
    }

    for (k = 0; k < lifts.length; k++) {
      var ly = lifts[k];
      // ledgers
      for (r = 0; r < rows.length; r++) {
        B.tube('scaff', rows[r], ly, SCAF_Z0, rows[r], ly, SCAF_Z1, 0.024, 7);
      }
      // transoms + boards
      for (i = 0; i <= bays; i++) {
        var tz = SCAF_Z0 + i * pitch;
        B.tube('scaff', rows[0] - 0.30, ly, tz, rows[1] + 0.20, ly, tz, 0.022, 7);
        // every standard/ledger/transom node carries a right-angle coupler
        for (r = 0; r < rows.length; r++) coupler(rows[r], ly, tz, 'y');
      }
      if (k > 0) {
        B.paint = 'ply';
        for (i = 0; i < 4; i++) {
          B.box('timber', 0.225, 0.036, SCAF_Z1 - SCAF_Z0 - 0.1,
            rows[0] - 0.16 + i * 0.235, ly + 0.05, (SCAF_Z0 + SCAF_Z1) * 0.5, 0.005);
        }
        B.paint = 'steel';
        // guard rails on the working lift
        B.tube('scaff', rows[1], ly + 0.95, SCAF_Z0, rows[1], ly + 0.95, SCAF_Z1, 0.022, 7);
        B.tube('scaff', rows[1], ly + 0.50, SCAF_Z0, rows[1], ly + 0.50, SCAF_Z1, 0.022, 7);
      }
      // facade brace across two bays, alternating direction per lift
      if (k < lifts.length - 1) {
        var d = (k % 2) ? 1 : -1;
        var z0 = d > 0 ? SCAF_Z0 + 0.4 : SCAF_Z1 - 0.4;
        var z1 = d > 0 ? SCAF_Z0 + 0.4 + pitch * 2 : SCAF_Z1 - 0.4 - pitch * 2;
        B.tube('scaff', rows[1], ly, z0, rows[1], lifts[k + 1], z1, 0.022, 6);
      }
      // ties back into the slab edge
      for (i = 0; i <= bays; i += 3) {
        var yz = SCAF_Z0 + i * pitch;
        B.tube('scaff', rows[0], ly, yz, X1 - 0.15, ly, yz, 0.020, 6);
      }
    }
    // ladder access between lifts
    for (k = 0; k < lifts.length - 1; k++) {
      var lz = SCAF_Z1 - 1.2;
      B.tube('scaff', rows[0] + 0.18, lifts[k], lz - 0.22, rows[0] + 0.18, lifts[k + 1] + 0.7, lz - 0.22, 0.018, 6);
      B.tube('scaff', rows[0] + 0.18, lifts[k], lz + 0.22, rows[0] + 0.18, lifts[k + 1] + 0.7, lz + 0.22, 0.018, 6);
      for (i = 0; i < 7; i++) {
        var ry2 = M.lerp(lifts[k], lifts[k + 1] + 0.6, (i + 0.5) / 7);
        B.tube('scaff', rows[0] + 0.18, ry2, lz - 0.22, rows[0] + 0.18, ry2, lz + 0.22, 0.013, 5);
      }
    }
    // debris netting over the outer face, in two panels with a gap
    B.paint = 'mesh';
    for (i = 0; i < 2; i++) {
      var na = SCAF_Z0 + 0.3 + i * (pitch * 4 + 1.2);
      var nb = Math.min(SCAF_Z1 - 0.3, na + pitch * 3.6);
      if (nb - na < 1) continue;
      B.add('debris_net', netPanel(nb - na, 8.0, i * 0.61),
        makeM(rows[1] + 0.06, 2.1, (na + nb) * 0.5, 0, Math.PI * 0.5, 0));
    }
    B.paint = 'steel';
    // the scaffold blocks the east bays
    L.addCollider(rows[0], 2.0, (SCAF_Z0 + SCAF_Z1) * 0.5, 0.12, 4.2, (SCAF_Z1 - SCAF_Z0) * 0.5, 'metal');
    return { x: SCAF_X, z0: SCAF_Z0, z1: SCAF_Z1, lifts: lifts, rows: rows };
  }

  // ======================================================= THE MATERIAL HOIST ===
  // A rack-and-pinion hoist on a tied mast up the east face, with its landing
  // gate on our floor. It is the reason there is anything on this floor at all
  // and it gives the east elevation a second vertical.
  function buildHoist(L, B, rng, N) {
    var mx = HOIST_X + 1.35, mz = HOIST_Z;
    var i;
    B.paint = 'paint';
    // mast: a bolted lattice with the rack down one face
    for (i = -14; i < 8; i++) {
      var y = i * 1.508;
      for (var a = -1; a <= 1; a += 2) {
        for (var b = -1; b <= 1; b += 2) {
          B.tube('crane', mx + a * 0.32, y, mz + b * 0.32, mx + a * 0.32, y + 1.508, mz + b * 0.32, 0.030, 6);
        }
      }
      B.tube('crane', mx - 0.32, y, mz - 0.32, mx + 0.32, y + 1.508, mz + 0.32, 0.020, 5);
      B.tube('crane', mx - 0.32, y, mz + 0.32, mx + 0.32, y + 1.508, mz - 0.32, 0.020, 5);
      B.tube('crane', mx - 0.32, y + 1.508, mz - 0.32, mx + 0.32, y + 1.508, mz - 0.32, 0.020, 5);
      B.tube('crane', mx - 0.32, y + 1.508, mz + 0.32, mx + 0.32, y + 1.508, mz + 0.32, 0.020, 5);
      B.tube('crane', mx - 0.32, y + 1.508, mz - 0.32, mx - 0.32, y + 1.508, mz + 0.32, 0.020, 5);
      B.tube('crane', mx + 0.32, y + 1.508, mz - 0.32, mx + 0.32, y + 1.508, mz + 0.32, 0.020, 5);
      // the rack
      B.box('crane', 0.05, 1.508, 0.10, mx - 0.36, y + 0.754, mz, 0.006);
    }
    // ties back to the frame
    B.paint = 'steel';
    for (i = -3; i < 2; i++) {
      B.tube('scaff', mx - 0.36, i * 4.30 + 1.2, mz, X1 - 0.2, i * 4.30 + 1.2, mz, 0.028, 6);
    }
    // the cage, parked at our landing
    B.paint = 'paint';
    var cy = 0.10;
    B.box('crane', 1.55, 0.10, 2.35, HOIST_X + 0.35, cy, mz, 0.012);            // floor
    B.box('crane', 0.06, 2.30, 2.35, HOIST_X - 0.40, cy + 1.20, mz, 0.010);     // back
    B.box('crane', 1.55, 0.10, 0.06, HOIST_X + 0.35, cy + 2.30, mz, 0.010);     // roof
    B.paint = 'steel';
    for (i = 0; i < 2; i++) {
      var sgn = i ? 1 : -1;
      for (var k = 0; k < 8; k++) {
        B.tube('scaff', HOIST_X - 0.36, cy + 0.1 + k * 0.28, mz + sgn * 1.16,
          HOIST_X + 1.10, cy + 0.1 + k * 0.28, mz + sgn * 1.16, 0.012, 5);
      }
      B.tube('scaff', HOIST_X - 0.36, cy + 2.28, mz + sgn * 1.16, HOIST_X + 1.10, cy + 2.28, mz + sgn * 1.16, 0.022, 6);
    }
    // landing gate on the slab edge
    B.paint = 'paint';
    B.box('plant', 0.07, 1.20, 2.50, X1 - 0.10, 0.60, mz, 0.010);
    B.paint = 'flat';
    decalCard(B, CELL.hazard, X1 - 0.16, 1.10, mz, 2.40, 0.26, 'x-', tint(0xffffff, 0), 0);
    decalCard(B, CELL.danger, X1 - 0.16, 0.70, mz + 0.9, 0.52, 0.52, 'x-', tint(0xffffff, 0), 0);
    B.paint = 'steel';
    L.addCollider(X1 - 0.10, 0.60, mz, 0.10, 0.60, 1.25, 'metal');
    L.addCollider(mx, 0, mz, 0.42, 22, 0.42, 'metal');
    return { mastX: mx, mastZ: mz, cageX: HOIST_X + 0.35 };
  }

  // ========================================================== THE TOWER CRANE ===
  // A saddle-jib crane standing clear of the north-west corner, mast running
  // from below the frame to 33 m above this floor, jib at 26.5 m. Painted
  // light-orange: a dark lattice against a burning sky is a hole in the frame,
  // and this machine's job is to be the level's LANDMARK - the thing that says
  // "tower under construction" from any framing that can see out.
  function buildCrane(L, B, rng, N) {
    var mx = CRANE_X, mz = CRANE_Z;
    var mh = 0.90;                            // half the mast section
    var i, a, b;
    B.paint = 'paint';
    // ---- mast ---------------------------------------------------------------
    var y0 = -46, y1 = CRANE_JIB_Y - 1.2;
    var secs = Math.round((y1 - y0) / 3.0);
    for (i = 0; i < secs; i++) {
      var ya = y0 + i * 3.0, yb = ya + 3.0;
      for (a = -1; a <= 1; a += 2) {
        for (b = -1; b <= 1; b += 2) {
          B.tube('crane', mx + a * mh, ya, mz + b * mh, mx + a * mh, yb, mz + b * mh, 0.070, 6);
        }
      }
      // K bracing on all four faces plus the horizontal frame
      for (a = -1; a <= 1; a += 2) {
        B.tube('crane', mx + a * mh, ya, mz - mh, mx + a * mh, ya + 1.5, mz, 0.040, 5);
        B.tube('crane', mx + a * mh, ya + 1.5, mz, mx + a * mh, yb, mz + mh, 0.040, 5);
        B.tube('crane', mx - mh, ya, mz + a * mh, mx, ya + 1.5, mz + a * mh, 0.040, 5);
        B.tube('crane', mx, ya + 1.5, mz + a * mh, mx + mh, yb, mz + a * mh, 0.040, 5);
        B.tube('crane', mx + a * mh, yb, mz - mh, mx + a * mh, yb, mz + mh, 0.040, 5);
        B.tube('crane', mx - mh, yb, mz + a * mh, mx + mh, yb, mz + a * mh, 0.040, 5);
      }
    }
    // ---- slewing ring, cab and A-frame --------------------------------------
    var sy = CRANE_JIB_Y - 1.2;
    B.box('crane', 2.4, 0.55, 2.4, mx, sy + 0.28, mz, 0.05);
    B.cyl('crane', 1.05, 1.05, 0.42, mx, sy + 0.75, mz, 0, 0, 0, 12);
    B.box('crane', 2.2, 1.30, 2.2, mx, sy + 1.60, mz, 0.05);
    // operator's cab, hung off the -X face - lit, and the highest lit window in
    // the level
    B.box('crane', 1.55, 1.85, 1.75, mx - 2.05, sy + 2.30, mz + 0.10, 0.05);
    B.paint = 'glass';
    B.box('lamp_glass', 0.04, 1.10, 1.45, mx - 2.84, sy + 2.55, mz + 0.10, 0.006);
    B.box('lamp_glass', 1.35, 1.10, 0.04, mx - 2.05, sy + 2.55, mz - 0.79, 0.006);
    B.paint = 'paint';
    // A-frame
    var apex = CRANE_TOP;
    for (a = -1; a <= 1; a += 2) {
      B.tube('crane', mx + a * 0.80, sy + 2.2, mz - 0.80, mx, apex, mz, 0.055, 5);
      B.tube('crane', mx + a * 0.80, sy + 2.2, mz + 0.80, mx, apex, mz, 0.055, 5);
    }
    B.tube('crane', mx, apex, mz, mx, apex + 1.2, mz, 0.05, 6);

    // ---- jib and counter-jib ------------------------------------------------
    // The jib runs out over the tower: from the open corner it crosses the top
    // of the frame, which is the cheapest way there is to put a diagonal in a
    // composition made of verticals.
    var jd = 1.0 / Math.sqrt(2);                 // toward +X +Z, over the tower
    var jl = 54, cl = 19;
    var jy = CRANE_JIB_Y;
    function jibRun(dir, len, depth, width, panel) {
      var n = Math.round(len / panel);
      for (var q = 0; q < n; q++) {
        var t0 = q * panel, t1 = t0 + panel;
        var ax0 = mx + dir * jd * t0, az0 = mz + dir * jd * t0;
        var ax1 = mx + dir * jd * t1, az1 = mz + dir * jd * t1;
        // two top chords, one bottom chord (a real saddle jib is a triangle)
        for (var s = -1; s <= 1; s += 2) {
          var ox = -jd * s * width * 0.5, oz = jd * s * width * 0.5;
          B.tube('crane', ax0 + ox, jy, az0 + oz, ax1 + ox, jy, az1 + oz, 0.048, 5);
          B.tube('crane', ax0 + ox, jy, az0 + oz, ax1, jy - depth, az1, 0.026, 4);
          B.tube('crane', ax1 + ox, jy, az1 + oz, ax1, jy - depth, az1, 0.026, 4);
        }
        B.tube('crane', ax0, jy - depth, az0, ax1, jy - depth, az1, 0.044, 5);
        B.tube('crane', ax0 - jd * width * 0.5, jy, az0 + jd * width * 0.5,
          ax0 + jd * width * 0.5, jy, az0 - jd * width * 0.5, 0.026, 4);
      }
    }
    jibRun(1, jl, 1.5, 1.6, 3.0);
    jibRun(-1, cl, 1.4, 1.6, 3.0);
    // pendant bars from the apex
    for (i = 1; i <= 3; i++) {
      var t = jl * i / 3.2;
      B.tube('crane', mx, apex, mz, mx + jd * t, jy + 0.05, mz + jd * t, 0.022, 4);
    }
    for (i = 1; i <= 2; i++) {
      var t2 = cl * i / 2.2;
      B.tube('crane', mx, apex, mz, mx - jd * t2, jy + 0.05, mz - jd * t2, 0.022, 4);
    }
    // counterweight slabs and the machinery deck
    B.paint = 'wall';
    for (i = 0; i < 4; i++) {
      B.box('core_wall', 2.6, 1.9, 0.42, mx - jd * (cl - 1.5) + i * 0.02, jy - 0.75,
        mz - jd * (cl - 1.5) + i * 0.46, 0.03);
    }
    B.paint = 'paint';
    B.box('crane', 3.0, 1.5, 2.6, mx - jd * 6.5, jy - 0.55, mz - jd * 6.5, 0.05);

    // ---- trolley, hook block and rope --------------------------------------
    var tr = 30.0;
    var tx = mx + jd * tr, tz = mz + jd * tr;
    B.box('crane', 1.1, 0.55, 1.1, tx, jy - 0.42, tz, 0.03);
    var hookY = 5.6;
    B.paint = 'steel';
    B.tube('struct', tx, jy - 0.60, tz, tx, hookY + 1.5, tz, 0.020, 5);
    B.tube('struct', tx + 0.16, jy - 0.60, tz + 0.16, tx + 0.16, hookY + 1.5, tz + 0.16, 0.020, 5);
    B.paint = 'paint';
    B.box('crane', 0.55, 1.05, 0.42, tx + 0.08, hookY + 1.0, tz + 0.08, 0.03);
    B.paint = 'steel';
    B.cyl('struct', 0.09, 0.09, 0.5, tx + 0.08, hookY + 0.30, tz + 0.08, 0, 0, 0, 8);
    B.cyl('struct', 0.34, 0.34, 0.16, tx + 0.08, hookY - 0.02, tz + 0.08, 0, 0, 0, 12);
    // a lifting beam and two slings hanging under it
    B.paint = 'paint';
    B.box('plant', 2.6, 0.20, 0.20, tx + 0.08, hookY - 0.30, tz + 0.08, 0.02);
    B.paint = 'steel';
    for (a = -1; a <= 1; a += 2) {
      B.tube('struct', tx + 0.08 + a * 1.15, hookY - 0.38, tz + 0.08,
        tx + 0.08 + a * 0.25, hookY - 1.9, tz + 0.08, 0.014, 4);
    }

    // ---- obstruction lights -------------------------------------------------
    B.paint = 'flat';
    B.cyl('lamp_red', 0.11, 0.11, 0.16, mx, apex + 1.35, mz, 0, 0, 0, 8);
    B.cyl('lamp_red', 0.10, 0.10, 0.14, mx + jd * jl, jy + 0.30, mz + jd * jl, 0, 0, 0, 8);
    B.cyl('lamp_red', 0.10, 0.10, 0.14, mx - jd * cl, jy + 0.30, mz - jd * cl, 0, 0, 0, 8);
    B.paint = 'steel';

    L.addCollider(mx, 0, mz, 1.0, 40, 1.0, 'metal');
    return {
      mast: new THREE.Vector3(mx, 0, mz), jibY: jy, apex: apex,
      jibDir: new THREE.Vector3(jd, 0, jd), radius: jl,
      hook: new THREE.Vector3(tx + 0.08, hookY, tz + 0.08),
      cab: new THREE.Vector3(mx - 2.05, sy + 2.30, mz + 0.10)
    };
  }

  // ============================================================ THE LAYDOWN ===
  // Large set pieces on the plate: banded packs of blockwork, bundled rebar,
  // stillages, a stack of unglazed curtain-wall units, a site cabin and the
  // concrete placing boom. Small clutter belongs to props_highrise.js - these
  // are the masses that shape the space and block sightlines.
  function buildLaydown(L, B, rng, N) {
    var out = [];
    var i, k;

    // NOTE: every loop counter in here is LOCAL, and that is not a style
    // preference. The first version reused buildLaydown's `i` and `k`, so
    // pallet() reset its own caller's index on every call and the pack loop
    // never terminated - a hang with no stack trace, no error and no frame.
    function pallet(x, z, yaw, rows) {
      var y = plateY(x, z, N);
      var p1, p2;
      B.paint = 'ply';
      B.pushXYZ(x, y, z, 0, yaw, 0);
      for (p1 = 0; p1 < 3; p1++) {
        B.box('timber', 1.16, 0.022, 0.10, 0, 0.106, -0.45 + p1 * 0.45, 0.004);
        B.box('timber', 0.10, 0.09, 1.00, -0.48 + p1 * 0.48, 0.045, 0, 0.006);
      }
      B.paint = 'block';
      for (p2 = 0; p2 < rows; p2++) {
        for (var a = 0; a < 3; a++) {
          for (var b = 0; b < 2; b++) {
            B.box('blockwork', 0.435, 0.212, 0.21, -0.44 + a * 0.44, 0.12 + 0.108 + p2 * 0.222,
              -0.22 + b * 0.44, 0.01);
          }
        }
      }
      // the shrink wrap that has come loose off the top course
      B.paint = 'sheet';
      B.box('sheeting', 1.30, 0.02, 1.10, 0, 0.12 + rows * 0.222 + 0.01, 0, 0.004);
      B.pop();
      B.paint = 'steel';
      L.addCollider(x, y + (0.12 + rows * 0.222) * 0.5, z, 0.72, (0.12 + rows * 0.222) * 0.5, 0.62,
        'concrete', false, new THREE.Euler(0, yaw, 0));
      return 0.12 + rows * 0.222;
    }

    // a block laydown of five packs, staggered - never a uniform grid
    var packs = [[-19.4, 8.6, 0.08, 6], [-17.6, 10.4, -0.05, 5], [-19.0, 12.3, 0.14, 6],
                 [-16.8, 13.9, 0.02, 4], [-20.6, 15.2, -0.10, 5]];
    for (i = 0; i < packs.length; i++) {
      var h = pallet(packs[i][0], packs[i][1], packs[i][2], packs[i][3]);
      out.push({ name: 'blockpack' + i, centre: new THREE.Vector3(packs[i][0], plateY(packs[i][0], packs[i][1], N), packs[i][1]),
        yaw: packs[i][2], w: 1.45, d: 1.25, h: h });
    }

    // ---- bundled rebar ------------------------------------------------------
    // Long, thin, and lying in the sun: the strongest small-scale specular in
    // the level and the only thing that returns a hard highlight off a 9.7
    // degree key.
    (function () {
      var bx = -23.5, bz = -2.0;
      B.paint = 'steel';
      for (var s = 0; s < 3; s++) {
        var sx = bx + s * 0.72, sy = plateY(bx, bz, N) + 0.10;
        for (var q = 0; q < 14; q++) {
          var ang = (q / 14) * 6.28318;
          var rr = 0.16 * Math.sqrt(rng.next());
          B.cyl('rebar', 0.011, 0.011, rng.range(7.2, 8.4),
            sx + Math.cos(ang) * rr, sy + Math.sin(ang) * rr + 0.05, bz + rng.range(-0.2, 0.2),
            Math.PI * 0.5, rng.range(-0.02, 0.02), 0, 5);
        }
        // the banding
        for (var c = 0; c < 3; c++) {
          B.cyl('scaff', 0.20, 0.20, 0.016, sx, sy + 0.05, bz - 2.6 + c * 2.6,
            Math.PI * 0.5, 0, 0, 12);
        }
        // timber bearers under it
        B.paint = 'ply';
        B.box('timber', 0.10, 0.10, 2.4, sx, plateY(bx, bz, N) + 0.05, bz - 2.4, 0.008);
        B.box('timber', 0.10, 0.10, 2.4, sx, plateY(bx, bz, N) + 0.05, bz + 2.4, 0.008);
        B.paint = 'steel';
      }
      L.addCollider(bx + 0.72, plateY(bx, bz, N) + 0.16, bz, 1.30, 0.22, 4.2, 'metal');
      out.push({ name: 'rebarBundle', centre: new THREE.Vector3(bx + 0.72, plateY(bx, bz, N), bz),
        yaw: 0, w: 2.6, d: 8.4, h: 0.34 });
    })();

    // ---- a stack of curtain-wall units, crated and standing on edge ---------
    (function () {
      var cx = -8.6, cz = 17.4, yaw = -0.22;
      var y = plateY(cx, cz, N);
      B.pushXYZ(cx, y, cz, 0, yaw, 0);
      B.paint = 'ply';
      B.box('timber', 4.30, 0.16, 1.15, 0, 0.08, 0, 0.012);           // the A-frame base
      for (var u = 0; u < 5; u++) {
        var t = (u - 2) * 0.17;
        B.paint = 'paint';
        B.box('mullion', 4.10, 2.55, 0.055, t * 0.25, 1.44, t, 0.01);
        B.paint = 'glass';
        B.box('glazing', 3.90, 2.35, 0.026, t * 0.25, 1.44, t, 0.004);
        B.paint = 'ply';
      }
      B.paint = 'steel';
      B.box('struct', 0.09, 2.90, 0.09, -2.05, 1.45, 0, 0.008);
      B.box('struct', 0.09, 2.90, 0.09, 2.05, 1.45, 0, 0.008);
      B.tube('scaff', -2.05, 2.85, 0, 2.05, 2.85, 0, 0.028, 6);
      B.paint = 'flat';
      decalCard(B, CELL.label, 0, 1.80, 0.46, 0.80, 0.38, 'z', tint(0xffffff, 0), 0.02);
      decalCard(B, CELL.hazard, 0, 0.22, 0.46, 4.0, 0.24, 'z', tint(0xffffff, 0), 0);
      B.pop();
      B.paint = 'steel';
      L.addCollider(cx, y + 1.45, cz, 2.2, 1.45, 0.7, 'glass', false, new THREE.Euler(0, yaw, 0));
      out.push({ name: 'glazingStack', centre: new THREE.Vector3(cx, y, cz), yaw: yaw, w: 4.4, d: 1.4, h: 2.9 });
    })();

    // ---- the site cabin ------------------------------------------------------
    // A stacking welfare unit in the shade behind the core: a lit window in a
    // dark corner, which is the only thing carrying the south-east quarter of
    // the plate.
    (function () {
      var cx = 24.0, cz = 15.6, yaw = -0.06;
      var y = plateY(cx, cz, N);
      B.pushXYZ(cx, y, cz, 0, yaw, 0);
      B.paint = 'paint';
      B.box('plant', 6.05, 0.24, 2.45, 0, 0.12, 0, 0.02);
      B.box('plant', 6.05, 2.35, 0.06, 0, 1.30, -1.22, 0.012);
      B.box('plant', 6.05, 2.35, 0.06, 0, 1.30, 1.22, 0.012);
      B.box('plant', 0.06, 2.35, 2.45, -3.02, 1.30, 0, 0.012);
      B.box('plant', 0.06, 2.35, 2.45, 3.02, 1.30, 0, 0.012);
      B.box('plant', 6.20, 0.10, 2.60, 0, 2.52, 0, 0.02);
      // the corner castings that let it be craned
      B.paint = 'steel';
      for (i = 0; i < 8; i++) {
        B.box('struct', 0.24, 0.20, 0.24, (i % 2 ? 2.9 : -2.9), i < 4 ? 0.14 : 2.42,
          (i % 4 < 2 ? -1.1 : 1.1), 0.02);
      }
      // lit window and a door
      B.paint = 'flat';
      B.box('lamp_glass', 1.45, 0.90, 0.05, -1.1, 1.55, -1.26, 0.006);
      B.paint = 'paint';
      B.box('mullion', 1.60, 1.02, 0.05, -1.1, 1.55, -1.29, 0.006);
      B.box('plant', 0.90, 2.00, 0.06, 1.7, 1.12, -1.27, 0.008);
      B.paint = 'flat';
      decalCard(B, CELL.logo, 1.0, 2.05, -1.30, 0.90, 0.90, 'z-', tint(0xffffff, 0), 0);
      decalCard(B, CELL.danger, 2.6, 1.60, -1.30, 0.50, 0.50, 'z-', tint(0xffffff, 0), 0.03);
      B.pop();
      B.paint = 'steel';
      L.addCollider(cx, y + 1.3, cz, 3.1, 1.3, 1.28, 'metal', false, new THREE.Euler(0, yaw, 0));
      out.push({ name: 'siteCabin', centre: new THREE.Vector3(cx, y, cz), yaw: yaw, w: 6.1, d: 2.5, h: 2.6 });
    })();

    // ---- the concrete placing boom ------------------------------------------
    // Mast-mounted, folded, with its delivery line running back to the riser.
    // A big articulated diagonal in the middle distance.
    (function () {
      var px = 3.2, pz = -14.5;
      var y = plateY(px, pz, N);
      B.paint = 'paint';
      B.box('plant', 1.9, 0.30, 1.9, px, y + 0.15, pz, 0.03);
      B.cyl('plant', 0.34, 0.40, 3.2, px, y + 1.9, pz, 0, 0, 0, 10);
      B.cyl('plant', 0.46, 0.46, 0.5, px, y + 3.55, pz, 0, 0, 0, 12);
      // two folded boom sections
      B.paint = 'plant';
      B.box('plant', 0.34, 4.6, 0.42, px - 0.9, y + 3.0, pz + 0.2, -0.55, 0.5, 0, 0.02);
      B.box('plant', 0.28, 3.6, 0.34, px - 2.6, y + 2.2, pz + 2.6, 0.95, 0.9, 0, 0.02);
      B.paint = 'steel';
      // the delivery line, snaking back across the slab to the riser
      var lx = px - 3.6, lz = pz + 4.2;
      for (i = 0; i < 9; i++) {
        var t = i / 9, t2 = (i + 1) / 9;
        var ax = M.lerp(lx, CORE_X0 - 1.2, t), az = M.lerp(lz, -6.0, t) + Math.sin(t * 5.2) * 0.9;
        var bx2 = M.lerp(lx, CORE_X0 - 1.2, t2), bz2 = M.lerp(lz, -6.0, t2) + Math.sin(t2 * 5.2) * 0.9;
        B.tube('scaff', ax, y + 0.09, az, bx2, y + 0.09, bz2, 0.075, 7);
      }
      L.addCollider(px, y + 2.0, pz, 0.55, 2.0, 0.55, 'metal');
      out.push({ name: 'placingBoom', centre: new THREE.Vector3(px, y, pz), yaw: 0.5, w: 2.0, d: 2.0, h: 4.1 });
    })();

    // ---- stillages of small plant, two of them ------------------------------
    for (i = 0; i < 2; i++) {
      var sx2 = [-2.4, 18.5][i], sz2 = [8.4, -16.2][i], yw = [0.34, -0.18][i];
      var sy2 = plateY(sx2, sz2, N);
      B.pushXYZ(sx2, sy2, sz2, 0, yw, 0);
      B.paint = 'steel';
      for (k = 0; k < 4; k++) {
        B.box('struct', 0.07, 0.95, 0.07, (k % 2 ? 0.62 : -0.62), 0.48, (k < 2 ? -0.52 : 0.52), 0.008);
      }
      B.box('struct', 1.34, 0.05, 1.14, 0, 0.10, 0, 0.008);
      B.tube('scaff', -0.62, 0.92, -0.52, 0.62, 0.92, -0.52, 0.020, 6);
      B.tube('scaff', -0.62, 0.92, 0.52, 0.62, 0.92, 0.52, 0.020, 6);
      B.paint = 'ply';
      B.box('timber', 1.20, 0.55, 1.00, 0, 0.40, 0, 0.02);
      B.pop();
      B.paint = 'steel';
      L.addCollider(sx2, sy2 + 0.5, sz2, 0.72, 0.5, 0.62, 'metal', false, new THREE.Euler(0, yw, 0));
      out.push({ name: 'stillage' + i, centre: new THREE.Vector3(sx2, sy2, sz2), yaw: yw, w: 1.4, d: 1.2, h: 1.0 });
    }
    return out;
  }

  // ========================================================== THE TOWER SHELL ===
  // Our own building, above and below the working floor. Without it the plate is
  // a slab floating in the sky: you look over the edge and there is nothing
  // between your boots and the city. THIS is what makes 176 m of drop legible,
  // and it is the whole subject of hero3.
  //
  // The lower 38 floors are complete and glazed - same facade map as the city,
  // because it is literally the same kind of building - and the transition
  // between "finished tower" and "raw frame" happens two floors below the
  // player, which is the most honest thing about the level.
  // ---------------------------------------------------------------------------
  // PERIMETER EDGE PROTECTION FOR A FLOOR THAT IS NOT THE WORKING FLOOR.
  //
  // Deliberately much cheaper than buildEdgeProtection: these runs are seen only
  // from outside, at 60-110 m, where a coupler is a subpixel and the thing that
  // matters is the LATTICE - a continuous line of verticals with two horizontals
  // through them and an orange net over the bottom half. That is the silhouette
  // an unfinished tower has, and its absence is why the establishing shot read as
  // stacked plates rather than as a building.
  //
  // Runs are broken: two gaps per elevation, at a different place on each floor,
  // so the stack does not read as a repeated decal. Sides alternate netted.
  // ---------------------------------------------------------------------------
  function perimeterGuard(B, rng, fy, floorIdx, x0, x1, z0, z1) {
    var sides = [
      ['x', x0 + 0.6, x1 - 0.6, z0 + 0.30],
      ['x', x0 + 0.6, x1 - 0.6, z1 - 0.30],
      ['z', z0 + 0.6, z1 - 0.6, x0 + 0.30],
      ['z', z0 + 0.6, z1 - 0.6, x1 - 0.30]
    ];
    for (var s = 0; s < sides.length; s++) {
      var sd = sides[s];
      var horiz = sd[0] === 'x';
      var a0 = sd[1], a1 = sd[2], fx = sd[3];
      // two gaps, phased off the floor index so no two elevations match
      var gA = M.lerp(a0, a1, ((floorIdx * 3 + s) % 7) / 7 + 0.04);
      var gB = M.lerp(a0, a1, ((floorIdx * 5 + s * 2) % 7) / 7 + 0.52);
      var n = Math.max(3, Math.round((a1 - a0) / 2.4));
      var pitch = (a1 - a0) / n;
      var prev = null;
      B.paint = 'steel';
      for (var i = 0; i <= n; i++) {
        var a = a0 + i * pitch + (i === 0 || i === n ? 0 : rng.range(-0.22, 0.22));
        var inGap = (Math.abs(a - gA) < 2.6) || (Math.abs(a - gB) < 2.1);
        if (inGap) { prev = null; continue; }
        var px = horiz ? a : fx, pz = horiz ? fx : a;
        var ph = rng.range(1.06, 1.18);
        B.box('scaff', 0.055, ph, 0.055, px, fy + ph * 0.5, pz,
          rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05), 0.008);
        if (prev) {
          for (var r = 0; r < 2; r++) {
            var rh = r ? 1.06 : 0.56;
            B.tube('scaff', prev[0], fy + rh, prev[1], px, fy + rh - rng.range(0, 0.03), pz,
              0.023, 5);
          }
        }
        prev = [px, pz];
      }
      // toe board along the whole side - it is what stops the plate edge being a
      // mathematically clean line at 70 m
      B.paint = 'ply';
      if (horiz) B.box('timber', a1 - a0, 0.17, 0.026, (a0 + a1) * 0.5, fy + 0.10, fx - 0.03, 0.004);
      else B.box('timber', 0.026, 0.17, a1 - a0, fx - 0.03, fy + 0.10, (a0 + a1) * 0.5, 0.004);
      // ---- NETTING AT 60-110 m IS A BAND, NOT A NET -------------------------
      // The first pass hung real alpha-tested netPanels here and the establishing
      // frame printed a row of ORANGE TRIANGLES down every elevation, like
      // bunting. That is a mip artefact and it was predictable: an alphaTest of
      // 0.45 against a coverage that mips toward the net's own ~40% openness
      // drops out in blotches exactly at the distance where the threshold and the
      // average cross. A debris screen 80 m away has no threads in it at all - it
      // is a continuous translucent orange band, and painting it as one is both
      // correct and cheaper. The working floor's own nets stay alpha-tested,
      // because there the threads are 4 m from the lens and they ARE the read.
      //
      // Two sides per floor, alternating down the stack, so the elevation has a
      // light face and a dark face at every level.
      if (((s + floorIdx) % 2) === 0) {
        B.paint = 'paint';
        var netPrev = B.tint;
        // 0.62, not 0.90. A debris screen is orange but it is also a month of dust
        // and UV; at full chroma four continuous bands down the elevation were the
        // loudest thing in the establishing frame, which is not what they are for.
        B.tint = tint(0xc26a2c, 0.62);
        var seg = 3;
        for (var q = 0; q < seg; q++) {
          var qa = M.lerp(a0, a1, q / seg), qb = M.lerp(a0, a1, (q + 1) / seg);
          var mid = (qa + qb) * 0.5;
          if (Math.abs(mid - gA) < 3.0 || Math.abs(mid - gB) < 2.6) continue;
          B.box('plant', horiz ? qb - qa : 0.022, 0.98, horiz ? 0.022 : qb - qa,
            horiz ? mid : fx - 0.05, fy + 0.56, horiz ? fx - 0.05 : mid, 0.004);
        }
        // ---- AND THE FULL-HEIGHT PERIMETER SCREEN ---------------------------
        // The last of the three reasons the tower read as stacked plates: even
        // with a guard rail at every level, 2.5 m of the 3.6 m band between two
        // floors was still open air. A tower under construction is WRAPPED - the
        // screen runs floor to soffit on whichever elevations the wind and the
        // neighbours demand - and a wrapped band is the single strongest signal
        // that a stack of slabs is one building. Two elevations per floor, in
        // three panels with the gaps left open so it is a screen being erected
        // rather than a skin.
        for (q = 0; q < seg; q++) {
          var ra = M.lerp(a0, a1, q / seg), rb = M.lerp(a0, a1, (q + 1) / seg);
          var rmid = (ra + rb) * 0.5;
          if (((q + floorIdx) % 3) === 1) continue;      // a bay still open
          if (Math.abs(rmid - gA) < 3.0) continue;
          B.box('plant', horiz ? (rb - ra) * 0.94 : 0.020, FLOOR_H - SLAB_T - 1.25,
            horiz ? 0.020 : (rb - ra) * 0.94,
            horiz ? rmid : fx - 0.07, fy + 1.15 + (FLOOR_H - SLAB_T - 1.25) * 0.5,
            horiz ? fx - 0.07 : rmid, 0.004);
        }
        B.tint = netPrev;
      }
      B.paint = 'steel';
    }
  }

  function buildShell(L, B, rng, N) {
    var i, k;
    var uO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;

    // ---- the finished tower below -------------------------------------------
    // THREE raw frame floors under the working slab, not two. hero3 now looks
    // straight down this elevation and the critic's ask was explicit - "expose
    // 3-4 slabs of our own building below the open edge so the eye can count
    // floors down". Two put the transition from raw frame to finished glazing
    // 8.6 m below the player, which is one floor of countable structure before
    // the building turns into a texture. Three plus the 26 spandrel bands below
    // is a legible count from the plate to the street.
    var RAW_FLOORS = 3;
    var topY = LOWER_Y - FLOOR_H * RAW_FLOORS;        // glazing starts here
    var faces = [
      [[X0, topY, Z0], [X1, topY, Z0], -1, 0],        // north face, normal -Z
      [[X1, topY, Z0], [X1, topY, Z1], 0, 1],         // east, +X
      [[X1, topY, Z1], [X0, topY, Z1], 1, 0],         // south, +Z
      [[X0, topY, Z1], [X0, topY, Z0], 0, -1]         // west, -X
    ];
    B.paint = 'shell';
    for (i = 0; i < faces.length; i++) {
      var f = faces[i];
      var ax = f[0][0], az = f[0][2], bx = f[1][0], bz = f[1][2];
      var w = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      var h = topY - CITY_Y;
      var cols = Math.max(2, Math.round(w / BAY_W));
      var rows = Math.max(2, Math.round(h / BAY_H));
      var u0 = uO + i * 0.25, v0 = (i * 3 % CITY_GRID) / CITY_GRID;
      // f[3], f[2] have carried this face's outward normal (nx, nz) since the
      // table was written and were never used. They are what faceQuad needs.
      B.add('shell', faceQuad(
        [ax, CITY_Y, az], [bx, CITY_Y, bz], [bx, topY, bz], [ax, topY, az],
        u0, v0, u0 + cols / CITY_GRID, v0 + rows / CITY_GRID,
        f[3], 0, f[2]), null);
    }
    // the floor bands, as real 200 mm projections so the tower is not a prism
    B.paint = 'paint';
    for (i = 1; i * FLOOR_H < topY - CITY_Y - 4; i++) {
      var by = topY - i * FLOOR_H;
      if (by < CITY_Y + 8) break;
      if (i > 26) break;                               // haze eats the rest
      B.box('spandrel', X1 - X0 + 0.30, 0.34, 0.14, 0, by, Z0 - 0.09, 0.02);
      B.box('spandrel', X1 - X0 + 0.30, 0.34, 0.14, 0, by, Z1 + 0.09, 0.02);
      B.box('spandrel', 0.14, 0.34, Z1 - Z0 + 0.30, X0 - 0.09, by, 0, 0.02);
      B.box('spandrel', 0.14, 0.34, Z1 - Z0 + 0.30, X1 + 0.09, by, 0, 0.02);
    }
    // ---- the raw frame floors between --------------------------------------
    // ---- WHY THE ESTABLISHING SHOT PHOTOGRAPHED AS STACKED FLYING CARPETS ---
    // MEASURED on lv_overview: five pale grey plates floating in the air with a
    // 3.6 m band of nothing between each pair. Three things caused it and all
    // three are geometry, not paint:
    //
    //   1. The plates went into the `slab` bucket, whose wear mode is the
    //      power-floated FLOOR story - trowel polish BRIGHTENS - so 2200 m2 of
    //      UNDERSIDE per floor was painted as a burnished top surface and lit
    //      like a sheet of card. buildPlate solved exactly this for the working
    //      floor by skinning its underside into the `soffit` bucket; the floors
    //      below never got the same treatment.
    //   2. Nothing occupied the band between two plates except four 860 mm
    //      columns 9 m apart, which at 70 m are three pixels wide. A real
    //      unfinished floor's perimeter is a continuous line of edge protection
    //      with orange debris netting on it - a horizontal lattice at every
    //      level, which is precisely what turns a stack of plates into a
    //      BUILDING.
    //   3. The columns were bevelled boxes, so nothing in the whole elevation
    //      had a chamfer facet to catch the low sun.
    B.paint = 'wall';
    for (k = 1; k <= RAW_FLOORS; k++) {
      var fy = -k * FLOOR_H;
      B.box('slab', X1 - X0, SLAB_T, Z1 - Z0, 0, fy - SLAB_T * 0.5, 0, 0.03);
      B.box('slab', X1 - X0, 0.70, 0.46, 0, fy - 0.37, Z0 + 0.23, 0.04);
      B.box('slab', X1 - X0, 0.70, 0.46, 0, fy - 0.37, Z1 - 0.23, 0.04);
      B.box('slab', 0.46, 0.70, Z1 - Z0, X0 + 0.23, fy - 0.37, 0, 0.04);
      B.box('slab', 0.46, 0.70, Z1 - Z0, X1 - 0.23, fy - 0.37, 0, 0.04);
      // (1) the underside, as a SOFFIT - see the note above
      B.paint = 'soffit';
      B.box('soffit', X1 - X0 - 0.04, 0.06, Z1 - Z0 - 0.04, 0, fy - SLAB_T - 0.03, 0, 0.02);
      // and its downstand beams on the column lines, so the underside has relief
      for (i = 0; i < COLX.length; i++) {
        if (COLX[i] > CORE_X0 - 0.5 && COLX[i] < CORE_X1 + 0.5) continue;
        B.box('soffit', 0.42, 0.52, Z1 - Z0 - 0.2, COLX[i], fy - SLAB_T - 0.26, 0, 0.03);
      }
      B.paint = 'wall';
      for (i = 0; i < COLX.length; i++) {
        for (var j = 0; j < COLZ.length; j++) {
          if (COLX[i] > CORE_X0 - 1 && COLX[i] < CORE_X1 + 1 &&
              COLZ[j] > CORE_Z0 - 1 && COLZ[j] < CORE_Z1 + 1) continue;
          B.add('column', chamfPrism(COL_W, FLOOR_H - SLAB_T, 0.034),
            makeM(COLX[i], fy - SLAB_T - (FLOOR_H - SLAB_T) * 0.5, COLZ[j]));
        }
      }
      // (2) the perimeter edge protection, on every raw floor. Posts at 2.4 m,
      // two rails and a netted panel over the lower half: a horizontal lattice
      // at every level, which is what a tower under construction looks like from
      // outside and the one thing that fills the band between two plates.
      perimeterGuard(B, rng, fy, k, X0, X1, Z0, Z1);
    }
    // the core continuing down as a solid shaft
    B.box('core_wall', CORE_X1 - CORE_X0, (RAW_FLOORS + 1) * FLOOR_H, CORE_Z1 - CORE_Z0,
      (CORE_X0 + CORE_X1) * 0.5, -(RAW_FLOORS + 1) * 0.5 * FLOOR_H,
      (CORE_Z0 + CORE_Z1) * 0.5, 0.04);

    // ---- the floors above ---------------------------------------------------
    // Two more raw frames, then the crane's climbing collar. Seen from outside
    // in the overview, and from inside through the un-poured bay.
    for (k = 1; k <= 2; k++) {
      var uy = FLOOR_H * k;
      B.paint = 'wall';
      // floor 48's slab is our soffit; 49 and 50 are edge beams and columns only
      if (k > 1) {
        B.box('slab', X1 - X0, SLAB_T, 1.2, 0, uy + SLAB_T * 0.5, Z0 + 0.6, 0.03);
        B.box('slab', X1 - X0, SLAB_T, 1.2, 0, uy + SLAB_T * 0.5, Z1 - 0.6, 0.03);
        B.box('slab', 1.2, SLAB_T, Z1 - Z0, X0 + 0.6, uy + SLAB_T * 0.5, 0, 0.03);
        B.box('slab', 1.2, SLAB_T, Z1 - Z0, X1 - 0.6, uy + SLAB_T * 0.5, 0, 0.03);
      }
      for (i = 0; i < COLX.length; i++) {
        for (var j2 = 0; j2 < COLZ.length; j2++) {
          if (COLX[i] > CORE_X0 - 1 && COLX[i] < CORE_X1 + 1 &&
              COLZ[j2] > CORE_Z0 - 1 && COLZ[j2] < CORE_Z1 + 1) continue;
          if (k > 1 && rng.bool(0.35)) continue;       // the pour is still going
          B.add('column', chamfPrism(COL_W, FLOOR_H - SLAB_T, 0.034),
            makeM(COLX[i], uy + SLAB_T + (FLOOR_H - SLAB_T) * 0.5, COLZ[j2]));
        }
      }
      // formwork tables and edge protection on the floor above
      B.paint = 'steel';
      for (i = 0; i < 10; i++) {
        var tx = rng.range(X0 + 3, X1 - 3), tz = rng.range(Z0 + 3, Z1 - 3);
        if (tx > CORE_X0 && tx < CORE_X1 && tz > CORE_Z0 && tz < CORE_Z1) continue;
        B.cyl('scaff', 0.030, 0.030, 2.6, tx, uy + SLAB_T + 1.3, tz, 0, 0, 0, 6);
      }
      // the same perimeter lattice as the floors below: it is the top edge of the
      // establishing shot's silhouette, and a bare arris there is a ruled line
      perimeterGuard(B, rng, uy + SLAB_T, 6 + k, X0, X1, Z0, Z1);
    }

    // ---- MATERIAL ON THE FLOORS BELOW ---------------------------------------
    // The last reason the stack read as empty plates: from outside you look
    // straight through a 3.6 m gap and see nothing but four columns and the far
    // elevation. A real floor two below the pour is the laydown - block packs,
    // shrink-wrapped pallets, stillages, a shored bay of props - and every one of
    // those is a mass that occludes, catches the low sun on its top face and
    // throws a shadow across the plate behind it. Placed on a coarse lattice with
    // per-item jitter rather than at random, so no two floors read alike and
    // nothing lands on a column.
    for (k = 1; k <= RAW_FLOORS; k++) {
      var ly = -k * FLOOR_H;
      for (i = 0; i < 22; i++) {
        var gx2 = M.lerp(X0 + 4, X1 - 4, ((i * 7 + k * 3) % 11) / 10) + rng.range(-1.6, 1.6);
        var gz2 = M.lerp(Z0 + 4, Z1 - 4, ((i * 5 + k * 4) % 9) / 8) + rng.range(-1.6, 1.6);
        if (gx2 > CORE_X0 - 1.5 && gx2 < CORE_X1 + 1.5 &&
            gz2 > CORE_Z0 - 1.5 && gz2 < CORE_Z1 + 1.5) continue;
        var kind2 = (i + k) % 4;
        var yaw2 = rng.range(0, 1.57);
        if (kind2 === 0) {
          // banded block pack on a pallet
          B.paint = 'block';
          var bw = rng.range(1.0, 1.35), bh = rng.range(0.9, 1.6);
          B.boxR('blockwork', bw, bh, bw * rng.range(0.7, 1.0), gx2, ly + bh * 0.5, gz2,
            0, yaw2, 0, 0.02);
          B.paint = 'ply';
          B.boxR('timber', bw + 0.1, 0.13, bw + 0.1, gx2, ly + 0.065, gz2, 0, yaw2, 0, 0.01);
        } else if (kind2 === 1) {
          // stillage / stacked pallets
          B.paint = 'ply';
          var ph3 = rng.range(0.5, 1.2);
          B.boxR('timber', rng.range(1.1, 1.4), ph3, rng.range(0.9, 1.2),
            gx2, ly + ph3 * 0.5, gz2, 0, yaw2, 0, 0.015);
        } else if (kind2 === 2) {
          // a shored bay: three props, which is the thinnest tall thing up there
          B.paint = 'steel';
          for (var pp = 0; pp < 3; pp++) {
            B.cyl('scaff', 0.030, 0.030, FLOOR_H - SLAB_T - 0.1,
              gx2 + (pp - 1) * 0.7, ly + (FLOOR_H - SLAB_T) * 0.5, gz2 + rng.range(-0.5, 0.5),
              0, 0, 0, 6);
          }
        } else {
          // a bundle of loose bar on timber bearers: four metres of thin
          // horizontal silhouette, which is the shape nothing else up there has
          B.paint = 'steel';
          var bl = rng.range(3.2, 5.0);
          for (var qb2 = 0; qb2 < 5; qb2++) {
            B.tube('rebar',
              gx2 - Math.cos(yaw2) * bl * 0.5, ly + 0.14 + (qb2 % 2) * 0.05,
              gz2 + Math.sin(yaw2) * bl * 0.5,
              gx2 + Math.cos(yaw2) * bl * 0.5, ly + 0.14 + (qb2 % 2) * 0.05,
              gz2 - Math.sin(yaw2) * bl * 0.5, 0.015, 4);
          }
          B.paint = 'ply';
          B.boxR('timber', 0.10, 0.10, 0.55, gx2 - Math.cos(yaw2) * bl * 0.36,
            ly + 0.05, gz2 + Math.sin(yaw2) * bl * 0.36, 0, yaw2, 0, 0.008);
          B.boxR('timber', 0.10, 0.10, 0.55, gx2 + Math.cos(yaw2) * bl * 0.36,
            ly + 0.05, gz2 - Math.sin(yaw2) * bl * 0.36, 0, yaw2, 0, 0.008);
        }
      }
    }
    B.paint = 'wall';
    // ---- the core, continuing up ---------------------------------------------
    // It is the tallest solid mass in the level and it stands dead centre of the
    // establishing shot, where the first cut printed it as a blank white cuboid
    // - which is item one on the instant-fail list on the most prominent object
    // in the frame after the crane. A core is climbed with jumpform: the shaft
    // runs ahead of the floors, it carries the lift line of every pour, and it
    // wears the climbing screen and the strongbacks of the formwork that made it.
    // ---- THE BUG THIS BOX WAS, FOR THE WHOLE OF THE FIRST BUILD --------------
    // coreYb was SLAB_T, i.e. 0.34 - so this solid 14 x 20 x 10.3 m block
    // started 340 mm above the WORKING FLOOR and swallowed the lift lobby whole.
    // The `interior` framing stands inside it. Everything buildCore models in
    // there - the shear walls, the lift-bank wall, the blockwork riser, the
    // lobby's own soffit - was buried, and what photographed as "the lobby
    // ceiling and its black-pitted crust" was the INSIDE of this block. Which is
    // why lowering the soffit's uv, then its triScale, then its AO, then its
    // normal scale, then its detail normal, then its parallax, changed
    // absolutely nothing: none of those surfaces were ever on screen.
    //
    // The core continues up from the floor ABOVE, which is where it always
    // should have started.
    B.paint = 'wall';
    var coreYb = SOFFIT_Y + SLAB_T;
    var coreH = FLOOR_H * 2.4 - (coreYb - SLAB_T);
    var coreYt = coreYb + coreH;
    var ccx = (CORE_X0 + CORE_X1) * 0.5, ccz = (CORE_Z0 + CORE_Z1) * 0.5;
    var cwx = CORE_X1 - CORE_X0, cwz = CORE_Z1 - CORE_Z0;
    B.box('core_wall', cwx, coreH, cwz, ccx, coreYb + coreH * 0.5, ccz, 0.04);
    // pour lifts: a 40 mm proud band at every 1.35 m climb, which is what a
    // jumpform leaves and the only thing that gives a 10 m shaft any scale
    for (k = 0; k * 1.35 < coreH - 0.4; k++) {
      var ly3 = coreYb + 0.35 + k * 1.35;
      B.box('core_wall', cwx + 0.05, 0.055, cwz + 0.05, ccx, ly3, ccz, 0.012);
    }
    // the climbing screen on the two faces that see the camera: a steel frame
    // with mesh infill, hung off the last completed lift
    B.paint = 'steel';
    for (k = 0; k < 2; k++) {
      var scx = k ? ccx : CORE_X0 - 0.16;
      var scz = k ? CORE_Z0 - 0.16 : ccz;
      var sw2 = k ? cwx : 0.10, sd2 = k ? 0.10 : cwz;
      for (i = 0; i < 5; i++) {
        var fy2 = coreYb + 0.6 + i * (coreH - 1.2) / 4;
        B.box('scaff', sw2 + (k ? 0.3 : 0), 0.055, sd2 + (k ? 0 : 0.3),
          scx, fy2, scz, 0.008);
      }
      var nPost = k ? 7 : 6;
      for (i = 0; i <= nPost; i++) {
        var pt = i / nPost;
        var qx = k ? M.lerp(CORE_X0, CORE_X1, pt) : scx;
        var qz = k ? scz : M.lerp(CORE_Z0, CORE_Z1, pt);
        B.tube('scaff', qx, coreYb + 0.5, qz, qx, coreYt - 0.5, qz, 0.028, 6);
      }
      // and the mesh infill over the lower half
      B.paint = 'mesh';
      B.add('debris_net',
        netPanel(k ? cwx - 0.4 : cwz - 0.4, coreH * 0.52, k * 0.43),
        makeM(scx - (k ? 0 : 0.05), coreYb + coreH * 0.30, scz - (k ? 0.05 : 0),
          0, k ? 0 : Math.PI * 0.5, 0));
      B.paint = 'steel';
    }
    // two openings punched in the shaft - a door and a services penetration -
    // as recessed dark boxes, because a wall with no holes in it is a wall
    // nobody has ever had to get through
    B.paint = 'wall';
    B.box('core_wall', 0.30, 2.10, 1.05, CORE_X0 + 0.06, coreYb + 1.15, ccz - 3.2, 0.02);
    B.box('core_wall', 0.30, 0.85, 0.85, CORE_X0 + 0.06, coreYb + 5.20, ccz + 2.4, 0.02);
    // the last pour's kicker, still with the starter bars out of it
    B.paint = 'steel';
    for (i = 0; i < 26; i++) {
      var bt = i / 25;
      var rx2 = M.lerp(CORE_X0 + 0.2, CORE_X1 - 0.2, bt);
      var bh2 = rng.range(0.28, 0.55);
      B.cyl('rebar', 0.011, 0.011, bh2, rx2, coreYt + bh2 * 0.5, CORE_Z0 + 0.16,
        rng.range(-0.10, 0.10), 0, rng.range(-0.10, 0.10), 5);
      B.cyl('rebar', 0.011, 0.011, bh2 * 0.9, rx2, coreYt + bh2 * 0.45, CORE_Z1 - 0.16,
        rng.range(-0.10, 0.10), 0, rng.range(-0.10, 0.10), 5);
    }
    B.paint = 'steel';
  }

  // ============================================================== THE CITY ====
  // 176 m down and out to 470 m, under real aerial perspective. The brief asks
  // for "believable depth haze and points of light as the sun drops"; the haze
  // is sky.js's height fog re-based to the STREET (see LevelHighrise.build's
  // setFog call - a fog layer whose e-folding height is 5.5 m above y = 0 puts
  // 86% opacity on everything below a camera that is 176 m up), and the points
  // of light are the emissive half of the facade map plus a street-lighting
  // layer.
  function buildCity(L, B, rng, N) {
    var i, k;

    // ---- the ground ---------------------------------------------------------
    // See the note on GROUND_R at the top of the file. The plate is 720 m and
    // lives entirely inside the 600 m far plane, so the "push the rim out until
    // the fog caps" strategy is gone - it could never work against a hard clip
    // plane, and what it actually produced was the ruled line it was written to
    // remove. Land now rises INSIDE the visible range, which is the only place a
    // ridge can do any work.
    B.paint = 'city';
    // GROUND_R/40 = 18 m cells. The plate is now entirely INSIDE the far plane,
    // so every one of these triangles is on screen and the resolution is worth
    // paying for: from the open edge this surface is the thing 176 m below the
    // player's boots and it was being sampled at 56 m.
    var gnd = gridSurface(-GROUND_R, GROUND_R, -GROUND_R, GROUND_R, GROUND_R / 40,
      function (x, z) {
        var r = Math.sqrt(x * x + z * z);
        var y = CITY_Y - 1.0;
        // the ripple of a real urban floor: rail cuttings, a river valley
        y += (N.fbm2(x * 0.019 - 1.4, z * 0.019 + 3.9, 3) * 0.5 + 0.5) * 9 *
          M.smoothstep(90, 300, r);
        // low ground rising past the built-up area, INSIDE the far plane
        y += (N.fbm2(x * 0.0065 + 4.1, z * 0.0065 - 2.6, 3) * 0.5 + 0.5) * 46 *
          M.smoothstep(230, 520, r);
        // ---- the ridge behind the city ---------------------------------------
        // It closes part of the band between the ground and the horizon, and
        // because it carries 44 m of four-octave fbm on an 18 m grid it closes
        // it as a WAVY silhouette rather than as a second ruled edge - which is
        // what the old 1250-2350 m ramp was written to do and never could,
        // because every metre of it was past the clip plane. Deliberately kept
        // well below the working plate: a ridge that crossed the horizon would
        // cut the sunset glow band, which is the best thing in the frame. The
        // job of actually reaching the horizon belongs to the rim towers.
        y += (58 + (N.fbm2(x * 0.0042 - 9.2, z * 0.0042 + 6.4, 4) * 0.5 + 0.5) * 44) *
          M.smoothstep(370, 690, r);
        return y;
      });
    B.add('city_ground', gnd, null);

    // ---- the street grid ----------------------------------------------------
    // GRID_A is axis-aligned, and that is a decision rather than laziness: the
    // road network is now BAKED into the ground texture (buildStreetMaps) at a
    // tile of exactly four block modules, and a texture cannot be rotated per
    // level without a uv transform this file has no business adding. Aligning
    // the primary grid to world XZ is what makes the roads actually run between
    // the buildings. GRID_B is rotated 70 degrees so the second district reads
    // as a different age of city and the whole thing never photographs as graph
    // paper - and no published camera bearing is axis-aligned either.
    var GRID_A = 0.0, GRID_B = 1.22;
    var BLK = BLK_M;
    // Footprints already claimed. Seeded with every hand-placed neighbour BEFORE
    // the grid runs - see the note on NEAR below for why the order matters.
    var placed = [[-186, -138]];        // the unfinished sibling with its crane

    function blockAt(gx, gz, ang, seed) {
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var wx = gx * ca - gz * sa, wz = gx * sa + gz * ca;
      var r = Math.sqrt(wx * wx + wz * wz);
      if (r > CITY_R || r < 44) return;
      var rg = rng;
      // Height falls off from a downtown core, with a couple of outliers - a
      // city with one height is a bar chart.
      // Heights fall off from a downtown core, with outliers - a city with one
      // height is a bar chart. The FLOOR matters as much as the peak: at 14 m
      // the outer ring was flat enough to photograph as a dark band between the
      // last towers and the sky, which is the seam the market level's outer
      // ground had and solved the same way.
      var core = M.smoothstep(CITY_R * 0.92, 40, r);
      // 34-84, not 26-78. The rim rings now start at 400 m and stand 62-190 m
      // tall, so a modelled city that bottomed out at 26 m would put a trough
      // between the two - a low band, then a wall. Real cities do have a second
      // cluster on the horizon; they do not have a moat in front of it.
      var h = M.lerp(34, 84, Math.pow(core, 1.25) * rg.range(0.42, 1.0));
      if (rg.bool(0.07)) h *= rg.range(1.6, 2.6);
      var w = rg.range(20, 40), d = rg.range(20, 40);
      var yaw = ang + rg.range(-0.05, 0.05);
      // Do not stand a tower inside our own footprint or on top of a neighbour.
      // Local counter, deliberately - see the note in buildLaydown.
      for (var q = 0; q < placed.length; q++) {
        var px = placed[q][0] - wx, pz = placed[q][1] - wz;
        if (px * px + pz * pz < 33 * 33) return;
      }
      placed.push([wx, wz]);
      cityBlock(B, rg, wx, wz, yaw, w, d, h, N);
    }

    // ---- THE HAND-PLACED NEIGHBOURS, AND WHY THEY ARE DECLARED HERE ---------
    // Four towers close enough to have parallax and to be genuinely LIT rather
    // than hazed, plus four more that exist for one reason: to make the 176 m
    // drop legible from INSIDE the plate.
    //
    // THE MEASUREMENT THAT DESIGNED THE SECOND FOUR. From an eye 1.72 m above a
    // flat slab standing 24 m inboard of the west arris, the shallowest sightline
    // that can leave the building grazes that arris at a slope of 1/14 - so
    // through a west opening NOTHING below y = -(d - 24)/14 is visible at all. At
    // 260 m that floor is -17 m; at the 600 m far plane it is -41 m. The city's
    // roofs sit between -176 and -24 m and the rim rings top out at -24, so every
    // one of them is BELOW the line and the openings could only ever have
    // contained sky. Which is exactly what hero1 photographed: blank apertures
    // and no drop, in the frame the whole level is built to deliver.
    //
    // Geometry says the fix is not "see further down", it is "see something at
    // your own height with a gulf in front of it". A neighbour whose top stands
    // 14-46 m ABOVE this plate, 250-270 m out, fills an opening from the graze
    // line to well above the horizon: its upper floors read at our eye level, its
    // base dissolves into haze below us, and the void between is the drop. That is
    // how a real 47th-floor photograph says 176 m, and it costs four blocks.
    //
    // All four new ones sit off the sun's azimuth (N48.5W) by more than their own
    // half-width, so this file's existing rule - nothing eclipses the key inside
    // 200 m - still holds, and all four are past 240 m.
    //
    // Declared BEFORE the grid loops on purpose. Pushed to `placed` only after the
    // grid had been laid out, a hand-placed tower could stand inside a grid block,
    // because blockAt's 33 m rejection test can only see what is already in the
    // list. Nine hand-placed towers is nine chances of two buildings occupying the
    // same air - an instant-fail item - and it applied to the original five as
    // much as to the four added here.
    var NEAR = [
      { x: 95, z: -175, w: 42, d: 36, h: 244, glass: true, name: 'glassTowerNE' },
      { x: 34, z: -124, w: 34, d: 30, h: 152, glass: true, name: 'glassTowerN' },
      { x: 148, z: -62, w: 38, d: 34, h: 196, glass: false, name: 'towerE' },
      { x: -212, z: -152, w: 46, d: 42, h: 206, glass: false, name: 'darkTowerNW' },
      { x: -62, z: 132, w: 38, d: 34, h: 178, glass: false, name: 'towerSW' },
      // in the west openings, seen from hero1 and THROUGH the curtain wall from
      // hero2 - bearing N83W from the plate, 35 degrees off the sun
      { x: -268, z: 40, w: 44, d: 38, h: 214, glass: true, name: 'towerW' },
      // north-west, 21 degrees right of the hero1 axis: the tallest of the four,
      // and the one whose top crosses the horizon line inside a west opening
      { x: -125, z: -215, w: 46, d: 40, h: 222, glass: false, name: 'towerNW2' },
      // due north, filling the right-hand third of hero1 through the north bays
      { x: -40, z: -262, w: 36, d: 32, h: 190, glass: true, name: 'towerN2' },
      // south-west, for hero2 and hero3, which both look that way
      { x: -215, z: 150, w: 42, d: 36, h: 198, glass: false, name: 'towerSW2' },
      // ---- AND THE THREE AT OUR OWN HEIGHT, 150-180 m OUT -------------------
      // MEASURED after the first pass: with the glazing and the sheeting made
      // transparent, hero1's west openings finally showed something - and what
      // they showed was pale haze with a scatter of window lights 250-270 m away
      // at 20% of the frame's value range. Nothing in the aperture had mass, so
      // the frame said "there is fog outside", not "there is a quarter of a
      // kilometre of air under you".
      //
      // What says it is a building whose ROOF is at your eye level and whose base
      // is cut off by your own floor line: the eye reads "that is a 170 m tower
      // and I am looking at the top of it" instantly. At 150-180 m the haze is
      // only 17-20% (density 0.0019, e-fold 380, computed at this altitude), so
      // these three keep their facades, their window scale, their parapets and
      // their roof plant - i.e. they are the only city in the level that arrives
      // as ARCHITECTURE rather than as a value ramp.
      //
      // Heights are set so each roof deck lands within a couple of metres of this
      // plate: 174, 178 and 172 against our 176. All three sit more than 15
      // degrees off the sun's bearing so the glow band under the soffit edge - the
      // best thing in hero1 - survives between them.
      { x: -60, z: -140, w: 40, d: 34, h: 174, glass: false, name: 'roofNW' },
      { x: -160, z: -22, w: 38, d: 42, h: 178, glass: true, name: 'roofW' },
      { x: 0, z: -170, w: 36, d: 38, h: 172, glass: false, name: 'roofN' }
    ];
    for (i = 0; i < NEAR.length; i++) placed.push([NEAR[i].x, NEAR[i].z]);

    // Jitter is +/-5 m, not +/-8: the roads in the ground texture are 15 m wide
    // on a 56 m module, so a footprint of up to 40 m plus 8 m of wander used to
    // stand a tower in the middle of a carriageway.
    for (i = -11; i <= 11; i++) {
      for (k = -11; k <= 11; k++) {
        blockAt(i * BLK + rng.range(-5, 5), k * BLK + rng.range(-5, 5), GRID_A);
      }
    }
    for (i = -8; i <= 8; i++) {
      for (k = -8; k <= 8; k++) {
        blockAt(i * BLK * 1.30 + rng.range(-9, 9), k * BLK * 1.30 + rng.range(-9, 9), GRID_B);
      }
    }

    // ---- the near neighbours, declared above --------------------------------
    // NOTHING TALL SITS ON THE SUN'S AZIMUTH INSIDE 200 m, and that is a rule
    // rather than an accident: the sun arrives from bearing (-0.78, -0.62), and
    // the first layout put a 208 m tower 125 m away on exactly that line. Its
    // top subtended 14.4 degrees against a 9.2-degree sun, so it stood between
    // the level and its own key in every framing that looks out. The dark tower
    // is now 258 m out, where it is a silhouette IN the glow instead of a lid
    // over it.
    for (i = 0; i < NEAR.length; i++) {
      var t = NEAR[i];
      cityBlock(B, rng, t.x, t.z, rng.range(-0.08, 0.08), t.w, t.d, t.h, N, t.glass ? 1 : 0);
    }

    // ---- an unfinished sibling with its own crane ---------------------------
    (function () {
      var sx = -186, sz = -138, h = 152;
      cityBlock(B, rng, sx, sz, 0.10, 36, 32, h, N, 2);
      B.paint = 'paint';
      var my = CITY_Y + h + 6;
      for (var q = 0; q < 22; q++) {
        var ya = CITY_Y + h - 40 + q * 3.2;
        for (var a = -1; a <= 1; a += 2) {
          for (var b = -1; b <= 1; b += 2) {
            B.tube('crane', sx + 14 + a * 0.8, ya, sz - 12 + b * 0.8,
              sx + 14 + a * 0.8, ya + 3.2, sz - 12 + b * 0.8, 0.10, 4);
          }
        }
      }
      // jib, running toward the sun so it silhouettes
      B.tube('crane', sx + 14, my, sz - 12, sx + 14 - 46, my + 3, sz - 12 - 34, 0.16, 4);
      B.tube('crane', sx + 14, my, sz - 12, sx + 14 + 17, my + 1, sz - 12 + 13, 0.16, 4);
      B.tube('crane', sx + 14, my, sz - 12, sx + 14, my + 12, sz - 12, 0.12, 4);
      B.paint = 'flat';
      B.cyl('lamp_red', 0.9, 0.9, 1.4, sx + 14, my + 13, sz - 12, 0, 0, 0, 6);
      B.paint = 'steel';
    })();

    // ---- THE HORIZON, WHICH IS MADE OF BUILDINGS ----------------------------
    // The ground is 176 m below the plate and the far plane is at 600 m, so the
    // furthest ground a camera can see sits ~17 degrees BELOW the horizon. That
    // band - 17 degrees of it, across the full frame width - is not something
    // fog can fill and not something the ground can reach: it is either closed
    // by a skyline or it is a black shelf, and for two rounds it has been a
    // black shelf (measured on the establishing frame at sRGB 9-29 from y 225 to
    // y 360, both before and after this round's fog change).
    //
    // A real downtown seen from 176 m up closes it, because half a kilometre out
    // the towers are as tall as you are. So the rim rings move inside the wall
    // and get tall: 400-545 m, 70-190 m high, with the tallest crossing the
    // horizon line and the rest making a ragged silhouette under it. They are
    // still cheap - four quads and a setback each, no windows, no furniture -
    // because under 45-55% haze at that range that is all that survives.
    B.paint = 'farcity';
    (function () {
      // Heights are solved against the horizon, not chosen. From a plate-level
      // eye a rim block's top sits at atan((h - 176)/r): ring 2 at 152 m and
      // 545 m reads -2.5 degrees, i.e. the skyline crowds the horizon line
      // WITHOUT crossing it. An earlier pass ran to 190 m with a 2.3x outlier
      // multiplier and put 400 m towers all round the plate at eye level, which
      // deletes the one thing the level is selling - that the city is far below.
      // The counts are solved for FRONTAGE, not for taste. Ring 2 sits on a
      // 3424 m circumference; 100 blocks averaging 43 m wide is 4300 m of
      // frontage, i.e. deliberately overlapping, because the band it has to
      // close is continuous. Measured before this: the horizon strip on the
      // establishing frame ran a MEDIAN of 0.00375 linear with a p95 of 0.209 -
      // a few towers standing in a black void. A skyline is opaque; what makes
      // it read as buildings rather than as a wall is that its TOP is ragged,
      // which 90 m of height range and a setback on one in three deliver.
      var rings = [
        { r: FAR_R0, n: 64, hMin: 40, hMax: 112 },
        { r: 435, n: 78, hMin: 50, hMax: 132 },
        { r: FAR_R1, n: 100, hMin: 62, hMax: 152 }
      ];
      for (var q = 0; q < rings.length; q++) {
        var rr = rings[q];
        for (var s = 0; s < rr.n; s++) {
          var ang = (s + rng.range(-0.34, 0.34)) / rr.n * 6.28318;
          var rad = rr.r * rng.range(0.93, 1.06);
          var bx2 = Math.cos(ang) * rad, bz2 = Math.sin(ang) * rad;
          var bh = rng.range(rr.hMin, rr.hMax);
          // The outermost ring gets the outliers, and they are allowed to CREST
          // the horizon. Measured with everything capped below it, a 4.4 degree
          // strip of sky-dome lower hemisphere survived above the skyline at a
          // median of 0.0037 linear - near black. A downtown that pokes through
          // its own horizon line in three or four places is both what a real one
          // does and the only thing that breaks that strip up.
          if (rng.bool(q === 2 ? 0.18 : 0.06)) bh *= rng.range(1.15, 1.40);
          farBlock(B, rng, bx2, bz2, rng.range(0, 1.57),
            rng.range(24, 62), rng.range(24, 62), bh);
        }
      }
    })();

    // ---- points of light ----------------------------------------------------
    // Street lighting, laid ON THE ROAD CENTRELINES the ground texture draws,
    // at 34 m spacing. The previous pass sprayed 1430 cards on two rotated grids
    // at BLK spacing with nothing under them, so the drop read as random dots
    // over cream soup instead of as streets running away. A line of points that
    // agrees with a line of tarmac is the whole depth cue.
    //
    // From 176 m up each card is one to three pixels: their only job is to
    // survive the haze as a POINT, which is why they are pure emissive quads
    // lying flat rather than anything with a normal.
    B.paint = 'flat';
    var lampGeo = quad(5.2, 5.2, 0, 0, 1, 1);
    var bigGeo = quad(8.0, 8.0, 0, 0, 1, 1);
    // ---- AND THE FIELD IS NOW DENSE WHERE IT IS VISIBLE ---------------------
    // It used to run to 2.1 km and be deliberately THINNED past 610 m so the far
    // field read as a scatter rather than a carpet. Both halves of that were
    // wrong against a 600 m far plane: everything past 600 m was clipped, so the
    // thinning applied only to lamps that were never drawn, and the effort went
    // into a band that does not exist. The field now stops at 640 m and is
    // undiluted throughout, because a LINE OF POINTS RUNNING AWAY is the single
    // strongest depth cue the drop has and every one of them is on screen.
    function lampAt(wx, wz, tintC, big) {
      var r = Math.sqrt(wx * wx + wz * wz);
      if (r > 640 || r < 40) return;
      var old = B.tint;
      B.tint = tintC;
      // lifted onto the ground field, exactly matching the ramps above - a lamp
      // buried in a hillside is a lamp that is not there
      var gy2 = CITY_Y + 6.0;
      gy2 += 68 * M.smoothstep(370, 690, r);
      gy2 += 46 * 0.5 * M.smoothstep(230, 520, r);
      B.add('city_light', big ? bigGeo : lampGeo,
        makeM(wx, gy2, wz, -Math.PI * 0.5, 0, 0));
      B.tint = old;
    }
    var warmL = tint(0xffc487, 0.85), coolL = tint(0xbfd8ff, 0.85);
    var hotL = tint(0xffe9c4, 0.92);
    var SPAN = 13, STEP = 30.0;
    for (i = -SPAN; i <= SPAN; i++) {
      // the carriageway centres the texture draws: (i + 0.5) * BLK on both axes
      var cl = (i + 0.5) * BLK;
      var arterial = (((i % 4) + 4) % 4) === 1;
      for (k = -26; k <= 26; k++) {
        var along = k * (arterial ? STEP * 0.5 : STEP);
        lampAt(along, cl, arterial ? hotL : (i % 3 === 0 ? coolL : warmL), arterial);
        lampAt(cl, along, arterial ? hotL : warmL, arterial);
      }
    }
    // the diagonal avenue, matching the one baked into the ground texture
    (function () {
      var ca = Math.cos(-0.62), sa = Math.sin(-0.62);
      for (var q = -26; q <= 26; q++) {
        var t2 = q * 26.0;
        lampAt(t2 * ca, t2 * sa, hotL, false);
      }
    })();
    B.paint = 'steel';
  }

  // A rim block: four flat quads and a setback, no roof furniture. At 400-545 m
  // under 40-52% haze that is what survives - but the FACES still carry the sun
  // (see the farcity branch in _paint), because a horizon made of silhouettes
  // with no light on them is a cut-out, not a skyline.
  function farBlock(B, rng, x, z, yaw, w, d, h) {
    var y0 = CITY_Y, y1 = CITY_Y + h;
    var ca = Math.cos(yaw), sa = Math.sin(yaw);
    var hw = w * 0.5, hd = d * 0.5;
    function P(lx, ly, lz) {
      return [x + lx * ca - lz * sa, ly, z + lx * sa + lz * ca];
    }
    // a setback on one in three, so the rim silhouette is not a row of bars
    var sb = rng.bool(0.34) ? y0 + h * rng.range(0.6, 0.8) : y1;
    var q;
    // Its own window phase. Every rim block sampling the same corner of the tile
    // is the same repetition problem the near city had, and out here it is a
    // whole band of the frame.
    var uO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    var vO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    // The rim rings get families too, damped toward neutral: at 700-1750 m the
    // haze has taken most of the chroma but NOT the value, and a rim made of one
    // tone is the "empty dark shelf" the band between the city and the horizon
    // used to photograph as.
    var rimPrev = B.tint;
    B.tint = familyTint(rng.int(0, CITY_FAMILY.length - 1), rng.range(0.92, 1.10));
    var corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    for (q = 0; q < 4; q++) {
      var a = corners[q], b = corners[(q + 1) % 4];
      var u2 = uO + q * 0.19;
      B.add('city', wallQuad(P(a[0], y0, a[1]), P(b[0], y0, b[1]),
        P(b[0], sb, b[1]), P(a[0], sb, a[1]), u2, vO,
        u2 + w / BAY_W / CITY_GRID,
        vO + (sb - y0) / BAY_H / CITY_GRID, x, z), null);
    }
    B.add('city', topQuad(P(-hw, sb, -hd), P(hw, sb, -hd), P(hw, sb, hd), P(-hw, sb, hd),
      0, 0, 1, 1), null);
    if (sb < y1) {
      var sw = hw * 0.62, sd = hd * 0.62;
      var sc = [[-sw, -sd], [sw, -sd], [sw, sd], [-sw, sd]];
      for (q = 0; q < 4; q++) {
        var a2 = sc[q], b2 = sc[(q + 1) % 4];
        B.add('city', wallQuad(P(a2[0], sb, a2[1]), P(b2[0], sb, b2[1]),
          P(b2[0], y1, b2[1]), P(a2[0], y1, a2[1]), 0, 0,
          sw * 2 / BAY_W / CITY_GRID, (y1 - sb) / BAY_H / CITY_GRID, x, z), null);
      }
      B.add('city', topQuad(P(-sw, y1, -sd), P(sw, y1, -sd), P(sw, y1, sd), P(-sw, y1, sd),
        0, 0, 1, 1), null);
    }
    // ---- A RAGGED TOP, FOR SIX TRIANGLES ------------------------------------
    // A rim block is 380-490 m out under 45-55% haze, so it gets no windows and
    // no plant - but the one thing that still reads at that range is the
    // SILHOUETTE, and 242 blocks all ending in a flat horizontal line is a
    // sawtooth of identical teeth. A lift overrun and a mast on the tall ones
    // break the line for almost nothing: the overrun is one box and the mast one
    // five-sided cylinder, both in buckets that are already being drawn.
    var rt = sb < y1 ? y1 : sb;
    var rhw = sb < y1 ? hw * 0.62 : hw, rhd = sb < y1 ? hd * 0.62 : hd;
    if (h > 74) {
      var ow = Math.min(rhw, rhd) * rng.range(0.38, 0.62);
      var oh = rng.range(5.0, 11.0);
      var oxL = rng.range(-rhw * 0.45, rhw * 0.45), ozL = rng.range(-rhd * 0.45, rhd * 0.45);
      B.boxR('city_plant', ow * 2, oh, ow * 1.5,
        x + oxL * ca - ozL * sa, rt + oh * 0.5, z + oxL * sa + ozL * ca, 0, yaw, 0, 0.3);
      if (rng.bool(0.42)) {
        var mh3 = rng.range(10, 26);
        B.cyl('city_plant', 0.5, 0.8, mh3,
          x + oxL * ca - ozL * sa, rt + oh + mh3 * 0.5,
          z + oxL * sa + ozL * ca, 0, 0, 0, 5);
      }
    }
    B.tint = rimPrev;
  }

  // ---- THE ALBEDO FAMILIES --------------------------------------------------
  // A real skyline is five or six materials, not one. SURF.city gave every
  // building in the metropolis the same 0x6d6a66 at roughness 0.86, and the
  // measured consequence was that the highest-frequency detail on any facade in
  // the signature frame was hf/mean 0.0757 - the flattest surface in the image -
  // and that no building separated from any other at any depth.
  //
  // These are MULTIPLIERS on the shared facade map (which is a neutral precast
  // grey), not replacement colours, so the window grid, the sills and the piers
  // survive. Value spreads 0.66-1.30, i.e. a 2:1 range between adjacent blocks,
  // which is the thing that actually makes a skyline read: one building darker
  // than the one behind it.
  //   pale limestone / glass blue-green / dark brick / concrete / sodium tan
  var CITY_FAMILY = [
    [1.10, 1.04, 0.93, 1.30],
    [0.82, 0.98, 1.14, 0.80],
    [1.24, 0.90, 0.73, 0.66],
    [1.00, 1.00, 0.98, 1.06],
    [1.17, 1.00, 0.79, 1.12]
  ];
  function familyTint(fi, mul) {
    var f = CITY_FAMILY[((fi % CITY_FAMILY.length) + CITY_FAMILY.length) % CITY_FAMILY.length];
    var v = f[3] * (mul === undefined ? 1 : mul);
    return new THREE.Color(f[0] * v, f[1] * v, f[2] * v);
  }

  // ===========================================================================
  // ONE BLOCK, AND IT IS NOW A BUILDING RATHER THAN AN EXTRUDED BOX.
  //
  // The round-3 finding was explicit: "the city is now the dominant subject and
  // the weakest asset... every tower is a plain flat-topped extruded box with no
  // setbacks, crowns or mechanical penthouses, and the roofs are featureless flat
  // planes with no plant, tanks or aerials. That last part matters because YOU
  // ARE LOOKING DOWN AT THEM."
  //
  // Two things were wrong and only one of them was missing geometry.
  //
  //   1. THE WINDING (see faceQuad). Every facade was drawn one building-depth
  //      too far away with an inward normal, so the setbacks and crowns that DID
  //      exist were being drawn as the far wall's interior and the roofs were
  //      lit off the hemisphere's ground colour. Fixing that is what makes the
  //      rest of this worth building.
  //   2. THE ROOF WAS A FACADE. The roof quad sampled the WINDOW map at 12 m per
  //      tile, so a hundred roofs seen from 176 m up were smeared window grids at
  //      an albedo brighter than a shaded facade. A commercial roof is bitumen,
  //      ballast and grey gravel: it is the DARKEST large surface in any city,
  //      which is why every aerial photograph of a downtown is dark roofs
  //      separated by bright streets. It now goes in the city_plant bucket, which
  //      is asphalt and was already being drawn, so it costs no draw call.
  //
  // WHAT IS SPENT, AND WHY IT IS FREE. Everything below lands in buckets that are
  // already merged and already drawn - `city` and `city_plant` - so the whole
  // feature adds ZERO draw calls. A bevelled box is 12 triangles and an 8-sided
  // cylinder 32, so a fully detailed block costs ~1.1k triangles. Graded by
  // range (a 1 m pipe is 4 px at 300 m and a 5 m tank is 20 px, so the near
  // third of the city is worth full detail and the rim is not), the whole city
  // comes to a few hundred thousand triangles against 3.1M of headroom.
  //
  //   flavour 0 = ordinary, 1 = full glass curtain wall, 2 = under construction
  function cityBlock(B, rng, x, z, yaw, w, d, h, N, flavour) {
    flavour = flavour || 0;
    var y0 = CITY_Y, y1 = CITY_Y + h;
    var ca = Math.cos(yaw), sa = Math.sin(yaw);
    function P(lx, ly, lz) {
      return [x + lx * ca - lz * sa, ly, z + lx * sa + lz * ca];
    }
    // local XZ -> world XZ, for anything placed with boxR/cyl (which take world)
    function WX(lx, lz) { return x + lx * ca - lz * sa; }
    function WZ(lx, lz) { return z + lx * sa + lz * ca; }
    var hw = w * 0.5, hd = d * 0.5;
    var uO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    var vO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    // ---- THE DETAIL TIER, SOLVED FROM RANGE ---------------------------------
    // 1 px at 300 m is 0.245 m at this fov and resolution, so a 5 m tank is 20 px
    // and a 1 m pipe is 4. Full detail is worth paying for out to ~230 m, roof
    // massing only to ~360, and past that only the silhouette survives 50% haze.
    var rad = Math.sqrt(x * x + z * z);
    var tier = rad < 230 ? 2 : (rad < 360 ? 1 : 0);
    // Setbacks used to need h > 110, which meant one block in fifty had one and
    // the skyline was a row of extruded boxes with identical roof furniture.
    // 42% now step, and a third of those step TWICE: one setback makes a
    // silhouette read as a building, two make it read as a tall one.
    var setback = h > 44 && rng.bool(0.42);
    var twoStep = setback && h > 90 && rng.bool(0.38);
    // and one in four of the tall unstepped ones tapers to a crown
    var crown = !setback && h > 66 && rng.bool(0.26);

    B.paint = flavour === 1 ? 'glasscity' : (flavour === 2 ? 'rawcity' : 'city');
    // One family for the WHOLE building - chosen once, here, off the level's own
    // rng. A hash sampled per vertex (which is what the previous pass did, on an
    // 84 m cell) cuts a single tower into two materials down a seam.
    var famPrev = B.tint;
    var famIdx = rng.int(0, CITY_FAMILY.length - 1);
    var famCol = familyTint(famIdx, rng.range(0.86, 1.14));
    B.tint = famCol;
    // Plant, parapets and ductwork are galvanised sheet and grey render, not the
    // building's own cladding, so they take a near-neutral tint with only a trace
    // of the family in it. A whole roof in the facade's colour is one more way a
    // skyline ends up looking extruded.
    var plantCol = new THREE.Color(
      0.86 + famCol.r * 0.16, 0.88 + famCol.g * 0.14, 0.92 + famCol.b * 0.12);
    function facade(x0, z0, x1, z1, ya, yb, uOfs) {
      var fw = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
      var cols = Math.max(2, Math.round(fw / BAY_W));
      var rows = Math.max(2, Math.round((yb - ya) / BAY_H));
      var a = P(x0, ya, z0), b = P(x1, ya, z1), c = P(x1, yb, z1), e = P(x0, yb, z0);
      B.add('city', wallQuad(a, b, c, e, uOfs, vO,
        uOfs + cols / CITY_GRID, vO + rows / CITY_GRID, x, z), null);
    }
    // Four facades of one storey band, so a shaft can be interrupted by a
    // projecting cornice without the window grid restarting mid-floor.
    function shaft(phw, phd, ya, yb, uBase) {
      facade(-phw, -phd, phw, -phd, ya, yb, uBase);
      facade(phw, -phd, phw, phd, ya, yb, uBase + 0.375);
      facade(phw, phd, -phw, phd, ya, yb, uBase + 0.625);
      facade(-phw, phd, -phw, -phd, ya, yb, uBase + 0.125);
    }
    // ---- A ROOF, WITH A PARAPET ALL ROUND -----------------------------------
    // What shipped was ONE parapet band on ONE side, so from above every roof was
    // a bare plane with a lip on its north edge. A parapet is a continuous
    // 1.1-1.6 m upstand with a coping on it, and from 176 m up it is the strongest
    // line on the whole roof: it is what separates the dark deck from the lit
    // facade and it is what casts the only shadow a flat roof has.
    function deck(phw, phd, py, wantParapet) {
      var prev = B.tint, prevP = B.paint;
      B.tint = plantCol;
      B.add('city_plant', topQuad(P(-phw, py, -phd), P(phw, py, -phd),
        P(phw, py, phd), P(-phw, py, phd), 0, 0, 1, 1), null);
      if (wantParapet) {
        var pt = 0.34, ph2 = rng.range(1.05, 1.60);
        B.boxR('city_plant', phw * 2 + pt * 2, ph2, pt,
          WX(0, -phd - pt * 0.5), py + ph2 * 0.5, WZ(0, -phd - pt * 0.5), 0, yaw, 0, 0.05);
        B.boxR('city_plant', phw * 2 + pt * 2, ph2, pt,
          WX(0, phd + pt * 0.5), py + ph2 * 0.5, WZ(0, phd + pt * 0.5), 0, yaw, 0, 0.05);
        B.boxR('city_plant', pt, ph2, phd * 2,
          WX(-phw - pt * 0.5, 0), py + ph2 * 0.5, WZ(-phw - pt * 0.5, 0), 0, yaw, 0, 0.05);
        B.boxR('city_plant', pt, ph2, phd * 2,
          WX(phw + pt * 0.5, 0), py + ph2 * 0.5, WZ(phw + pt * 0.5, 0), 0, yaw, 0, 0.05);
      }
      B.tint = prev; B.paint = prevP;
    }
    // ---- PROJECTING CORNICE BANDS -------------------------------------------
    // The single cheapest thing that stops a 150 m facade reading as a flat card:
    // a band standing 400 mm proud every six to nine storeys, which throws a hard
    // horizontal shadow line the whole width of the building. Four boxes each.
    function cornice(phw, phd, py, proj, ht) {
      var prev = B.tint;
      B.tint = plantCol;
      B.boxR('city_plant', phw * 2 + proj * 2, ht, proj,
        WX(0, -phd - proj * 0.5), py, WZ(0, -phd - proj * 0.5), 0, yaw, 0, 0.06);
      B.boxR('city_plant', phw * 2 + proj * 2, ht, proj,
        WX(0, phd + proj * 0.5), py, WZ(0, phd + proj * 0.5), 0, yaw, 0, 0.06);
      B.boxR('city_plant', proj, ht, phd * 2,
        WX(-phw - proj * 0.5, 0), py, WZ(-phw - proj * 0.5, 0), 0, yaw, 0, 0.06);
      B.boxR('city_plant', proj, ht, phd * 2,
        WX(phw + proj * 0.5, 0), py, WZ(phw + proj * 0.5, 0), 0, yaw, 0, 0.06);
      B.tint = prev;
    }

    // ---- the shaft ----------------------------------------------------------
    var top = setback ? y0 + h * rng.range(0.46, 0.70) : y1;
    shaft(hw, hd, y0, top, uO);
    // ---- vertical pier expression -------------------------------------------
    // Two towers in five carry expressed piers: 500-900 mm mullion piers running
    // the full height of the shaft, standing 0.5-0.9 m proud of the glass line.
    // They are what makes a facade read as structure rather than as wallpaper,
    // and on a raking 9-degree key each one draws its own vertical shadow.
    if (tier >= 1 && rng.bool(0.40)) {
      var pw2 = rng.range(0.55, 0.95), pj = rng.range(0.45, 0.85);
      var np = 2 + Math.round(w / 16);
      var prevT = B.tint; B.tint = plantCol;
      for (var qp = 0; qp <= np; qp++) {
        var fx2 = -hw + (qp / np) * hw * 2;
        B.boxR('city_plant', pw2, top - y0, pj,
          WX(fx2, -hd - pj * 0.5), (y0 + top) * 0.5, WZ(fx2, -hd - pj * 0.5), 0, yaw, 0, 0.05);
        B.boxR('city_plant', pw2, top - y0, pj,
          WX(fx2, hd + pj * 0.5), (y0 + top) * 0.5, WZ(fx2, hd + pj * 0.5), 0, yaw, 0, 0.05);
      }
      var nq = 2 + Math.round(d / 16);
      for (qp = 0; qp <= nq; qp++) {
        var fz2 = -hd + (qp / nq) * hd * 2;
        B.boxR('city_plant', pj, top - y0, pw2,
          WX(-hw - pj * 0.5, fz2), (y0 + top) * 0.5, WZ(-hw - pj * 0.5, fz2), 0, yaw, 0, 0.05);
        B.boxR('city_plant', pj, top - y0, pw2,
          WX(hw + pj * 0.5, fz2), (y0 + top) * 0.5, WZ(hw + pj * 0.5, fz2), 0, yaw, 0, 0.05);
      }
      B.tint = prevT;
    }
    // ---- REAL FLOOR LINES, WHICH IS WHERE THE HEADROOM GOES -----------------
    // A texture cannot make a 170 m facade three-dimensional. What does is the
    // thing every one of these buildings actually has: a spandrel shadow box at
    // every slab edge, standing 200-300 mm proud of the glass line. Fifty of them
    // up a tower is fifty hard horizontal shadow lines, and it is the difference
    // between a photograph of a building and a photograph of a picture of one.
    //
    // THE ARITHMETIC, because this is where the level's spare budget is spent. A
    // bevelled box is 12 triangles, so one band is 48 and a 50-storey tower is
    // 2,400. The 80-odd blocks inside 230 m therefore cost ~190k triangles, and
    // the level is running 1.34M against a 4.5M budget. At 230 m a storey is 14 px
    // apart and the band itself 1.4 px, which is exactly a floor line; past 360 m
    // it is sub-pixel and would only alias, so it stops. buildShell already does
    // precisely this on our own tower ("as real 200 mm projections so the tower is
    // not a prism") - the city just never got it.
    if (tier === 2) {
      var fp = BAY_H, fyv;
      for (fyv = y0 + fp; fyv < top - 1.2; fyv += fp) {
        cornice(hw, hd, fyv, 0.24, 0.34);
      }
    } else if (tier === 1) {
      var fp1 = BAY_H * 2;
      for (fyv = y0 + fp1; fyv < top - 1.2; fyv += fp1) {
        cornice(hw, hd, fyv, 0.32, 0.46);
      }
    }
    // and a heavier band at the mechanical floors, six to nine storeys apart,
    // on the ones with no expressed piers
    if (tier >= 1) {
      var cs3 = rng.range(6, 9) * BAY_H;
      for (var cy3 = y0 + cs3; cy3 < top - 3; cy3 += cs3) {
        cornice(hw, hd, cy3, rng.range(0.42, 0.68), rng.range(0.9, 1.5));
      }
    }
    B.paint = flavour === 1 ? 'glasscity' : (flavour === 2 ? 'rawcity' : 'city');
    B.tint = famCol;

    // ---- the setback steps --------------------------------------------------
    if (setback) {
      var sw = hw * rng.range(0.58, 0.80), sd = hd * rng.range(0.58, 0.80);
      var mid = twoStep ? top + (y1 - top) * rng.range(0.42, 0.62) : y1;
      shaft(sw, sd, top, mid, uO + 0.5);
      deck(hw, hd, top, true);
      hw = sw; hd = sd;
      if (twoStep) {
        var sw2 = hw * rng.range(0.56, 0.80), sd2 = hd * rng.range(0.56, 0.80);
        shaft(sw2, sd2, mid, y1, uO + 0.25);
        deck(hw, hd, mid, true);
        hw = sw2; hd = sd2;
      }
    }
    // ---- a tapered crown ----------------------------------------------------
    if (crown) {
      var ch = h * rng.range(0.10, 0.22);
      var cw = hw * rng.range(0.30, 0.58), cd = hd * rng.range(0.30, 0.58);
      var cc = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      var cs2 = [[-cw, -cd], [cw, -cd], [cw, cd], [-cw, cd]];
      for (var qc = 0; qc < 4; qc++) {
        var a3 = cc[qc], b3 = cc[(qc + 1) % 4];
        var a4 = cs2[qc], b4 = cs2[(qc + 1) % 4];
        B.add('city', wallQuad(P(a3[0], y1, a3[1]), P(b3[0], y1, b3[1]),
          P(b4[0], y1 + ch, b4[1]), P(a4[0], y1 + ch, a4[1]),
          0, 0, 1, 0.35, x, z), null);
      }
      y1 += ch; hw = cw; hd = cd;
    }
    // the roof deck itself, with its parapet
    deck(hw, hd, y1, true);

    // ---- ROOF FURNITURE, WHICH IS WHAT YOU ARE ACTUALLY LOOKING AT ----------
    // hero3 looks DOWN at a hundred of these from 176 m up, so the roof is not
    // set dressing on this level - it is the surface that fills most of the
    // frame. A real commercial roof carries, in this order of visual weight: a
    // mechanical penthouse with a louvre band, the lift overrun standing above
    // it, two or three cooling towers or tanks, a duct run between them, an
    // aerial cluster, and a window-cleaning davit track round the parapet.
    // Every one of these is either a box (12 tris) or an 8-sided cylinder (32).
    B.paint = 'city';
    var pPrev = B.tint;
    B.tint = plantCol;
    var rhw = hw, rhd = hd;                     // the deck we are furnishing
    var minR = Math.min(rhw, rhd);
    // ---- 1. the mechanical penthouse ---------------------------------------
    // 25-45% of the roof and 4-8 m tall. It is the biggest thing up there and it
    // is what makes a flat top read as a plant floor rather than as a cut face.
    var mpw = rhw * rng.range(0.44, 0.70), mpd = rhd * rng.range(0.40, 0.66);
    var mph = rng.range(4.2, 8.0);
    var mpx = rng.range(-rhw * 0.30, rhw * 0.30), mpz = rng.range(-rhd * 0.30, rhd * 0.30);
    B.boxR('city_plant', mpw * 2, mph, mpd * 2,
      WX(mpx, mpz), y1 + mph * 0.5, WZ(mpx, mpz), 0, yaw, 0, 0.18);
    // the louvre band round its head - a darker ring, so the box has a top
    B.boxR('city_plant', mpw * 2 + 0.5, mph * 0.30, mpd * 2 + 0.5,
      WX(mpx, mpz), y1 + mph * 0.80, WZ(mpx, mpz), 0, yaw, 0, 0.10);
    // ---- 2. the lift overrun, always the tallest box on the roof ------------
    var lw = minR * rng.range(0.22, 0.34), lh = mph * rng.range(1.15, 1.75);
    var lox = mpx + rng.range(-rhw * 0.5, rhw * 0.5);
    var loz = mpz + rng.range(-rhd * 0.5, rhd * 0.5);
    lox = M.clamp(lox, -rhw * 0.72, rhw * 0.72);
    loz = M.clamp(loz, -rhd * 0.72, rhd * 0.72);
    B.boxR('city_plant', lw * 2, lh, lw * 1.5,
      WX(lox, loz), y1 + lh * 0.5, WZ(lox, loz), 0, yaw + rng.range(-0.2, 0.2), 0, 0.12);
    if (tier >= 1) {
      // ---- 3. cooling towers / tanks ---------------------------------------
      var nt = tier === 2 ? rng.int(2, 4) : rng.int(1, 2);
      for (var qt = 0; qt < nt; qt++) {
        var tx3 = rng.range(-rhw * 0.80, rhw * 0.80), tz3 = rng.range(-rhd * 0.80, rhd * 0.80);
        var tr3 = rng.range(1.5, 3.4), th3 = rng.range(3.2, 7.5);
        var tw = WX(tx3, tz3), tzw = WZ(tx3, tz3);
        if (rng.bool(0.55)) {
          // a cooling tower: a box with the fan cowl standing on it
          B.boxR('city_plant', tr3 * 2.4, th3, tr3 * 2.4, tw, y1 + th3 * 0.5, tzw,
            0, yaw + rng.range(-0.4, 0.4), 0, 0.10);
          B.cyl('city_plant', tr3 * 0.85, tr3 * 0.95, th3 * 0.34,
            tw, y1 + th3 + th3 * 0.17, tzw, 0, 0, 0, 8);
        } else {
          // a water tank on a steel stool
          B.cyl('city_plant', tr3, tr3, th3, tw, y1 + 1.4 + th3 * 0.5, tzw, 0, 0, 0, 8);
          for (var ql = 0; ql < 4; ql++) {
            var la3 = ql / 4 * 6.28318 + 0.78;
            B.cyl('city_plant', 0.14, 0.14, 1.4,
              tw + Math.cos(la3) * tr3 * 0.72, y1 + 0.7,
              tzw + Math.sin(la3) * tr3 * 0.72, 0, 0, 0, 5);
          }
        }
      }
      // ---- 4. a duct run between the penthouse and the nearest tower -------
      if (tier === 2) {
        var dl = rng.range(6, 14), dh4 = rng.range(0.9, 1.6);
        var dax = mpx + (mpw + 1.0) * (rng.bool(0.5) ? 1 : -1);
        var daz = mpz + rng.range(-mpd * 0.6, mpd * 0.6);
        var horizD = rng.bool(0.5);
        B.boxR('city_plant', horizD ? dl : dh4, dh4, horizD ? dh4 : dl,
          WX(dax, daz), y1 + rng.range(1.2, 2.4), WZ(dax, daz), 0, yaw, 0, 0.08);
        // and the stools under it
        for (var qd = 0; qd < 3; qd++) {
          var dt = (qd / 2 - 0.5) * dl * 0.8;
          B.cyl('city_plant', 0.10, 0.10, 1.2,
            WX(dax + (horizD ? dt : 0), daz + (horizD ? 0 : dt)), y1 + 0.6,
            WZ(dax + (horizD ? dt : 0), daz + (horizD ? 0 : dt)), 0, 0, 0, 5);
        }
      }
    }
    // ---- 5. the aerial cluster and its obstruction light -------------------
    var mh2 = rng.range(9, 32) * (h > 100 ? 1.0 : 0.65);
    var max2 = rng.range(-rhw * 0.7, rhw * 0.7), maz2 = rng.range(-rhd * 0.7, rhd * 0.7);
    var mwx = WX(max2, maz2), mwz = WZ(max2, maz2);
    var cluster = rng.bool(0.45) ? 3 : 1;
    for (var qm = 0; qm < cluster; qm++) {
      var ox2 = qm === 0 ? 0 : rng.range(-3.5, 3.5);
      var oz2 = qm === 0 ? 0 : rng.range(-3.5, 3.5);
      var mhq = mh2 * (qm ? rng.range(0.5, 0.85) : 1);
      B.cyl('city_plant', 0.35, 0.55, mhq,
        mwx + ox2, y1 + mhq * 0.5, mwz + oz2, 0, 0, 0, 5);
    }
    // a drum antenna on some of the tall ones - it is the one non-vertical
    // silhouette a roof has
    if (tier >= 1 && h > 90 && rng.bool(0.40)) {
      B.cyl('city_plant', 1.5, 1.5, 0.5,
        mwx + rng.range(-2, 2), y1 + mh2 * rng.range(0.4, 0.8), mwz + rng.range(-2, 2),
        1.35, rng.range(0, 3.14), 0, 8);
    }
    // ---- 6. the window-cleaning davit track -------------------------------
    // A 300 mm rail inboard of the parapet on two sides. It is thin, but it is
    // the one line on a roof that is not parallel to the parapet.
    if (tier === 2 && rng.bool(0.55)) {
      B.boxR('city_plant', rhw * 1.7, 0.28, 0.30,
        WX(0, -rhd + 1.6), y1 + 0.45, WZ(0, -rhd + 1.6), 0, yaw, 0, 0.05);
      B.boxR('city_plant', 0.30, 0.28, rhd * 1.7,
        WX(rhw - 1.6, 0), y1 + 0.45, WZ(rhw - 1.6, 0), 0, yaw, 0, 0.05);
    }
    B.tint = pPrev;
    // An obstruction light on every mast makes a red starfield. Only the
    // buildings tall enough to actually need one carry one.
    if (h > 66 && rng.bool(0.45)) {
      B.paint = 'flat';
      B.cyl('lamp_red', 0.75, 0.75, 1.2, mwx, y1 + mh2 + 0.8, mwz, 0, 0, 0, 6);
    }
    B.paint = 'city';
    B.tint = famPrev;
  }

  // ================================================================ THE LEVEL ==
  function LevelHighrise(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_highrise';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    // Volumetric cone hints. {origin, dir, width, length, strength, kind}.
    this.lightShafts = [];
    // Full override of lighting.js's own lamp table: this level knows where its
    // festoon strings and task lamps are, and rig 'mixed' has a lampFloor of
    // 0.85, so these are on and they carry the whole shaded half of the plate.
    this.practicalLights = [];
    this.wetPatches = [];
    this.columns = [];
    this.stacks = [];
    this.sheets = [];
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(4.0);
    this._stamp = 0;
    this._t = 0;
    this._atlasOk = false;
    this._netOk = false;
    this._cityOk = false;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x48494852) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x48495348);
    // The level is dry: the roster pins it at "clear, windy". Published anyway
    // so any consumer reading a wetness finds a number rather than undefined.
    this.wetness = 0.10;
    this.windDir = new THREE.Vector2(SHD_X, SHD_Z);
    this.windSpeed = 11.0;
    // Bounds is the PLAYABLE TOWER, deliberately not the city: lighting.js
    // rasterises this box into its sky-visibility volume, and handing it a
    // 940 m square would coarsen the one interior that matters to nothing.
    this.bounds = new THREE.Box3(
      new THREE.Vector3(X0 - 4, -5.5, Z0 - 4),
      new THREE.Vector3(X1 + 4, 14.0, Z1 + 4));
    this.anchors = buildAnchors(this.noise);
    this.sunDir = new THREE.Vector3(SUN_X, SUN_Y, SUN_Z).normalize();
    // ---- THE KEY, RAISED, DECLARATIVELY --------------------------------------
    // RIGS.mixed trims the key to 0.62 because a 'mixed' level is one where the
    // practicals carry the shaded half. That is the right idea and the wrong
    // number FOR A SUNSET AT 9 DEGREES, and the arithmetic says why: a
    // horizontal slab receives sin(9.2) = 0.16 of the key, so at 0.62 x 2.61 =
    // 1.62 the sunlit floor got 0.26 of irradiance against a hemisphere already
    // delivering ~0.34. Measured on the real frame: toggling the whole CSM off
    // moved the open-edge deck from 0.04639 to 0.03784 - the sun supplied 18% of
    // it - and the entire visible floor spanned 1.45x from its brightest patch
    // to its darkest. A shipped sunset interior runs 10x.
    //
    // 1.15 puts the floor's sun term at 0.48 against the same ambient, i.e. a
    // ~2.4:1 sun/shade split on the slab and a genuinely blazing 3.0 on the
    // vertical faces the sun actually reaches - which is where a 9-degree sun
    // has to be read, and which is what puts the level's own premise ("the low
    // sun rakes straight through the open plates casting enormous column
    // shadows") in a frame for the first time.
    //
    // Published on the LEVEL rather than edited into lighting.js: `level.lightRig`
    // is the documented declarative hook (_adoptLevelRig), it merges over the
    // preset into a private copy, and RIGS is never mutated - so no other level
    // can see this and market/harbor are not declarative at all.
    // ---- AND THE GROUND BOUNCE, WHICH THIS LEVEL IS THE TEXTBOOK CASE FOR ----
    // 2200 m2 of power-floated concrete with a 9-degree sun raking across half of
    // it, and a soffit 3.96 m above it. The soffit is the top third of every
    // framing and it never sees the sky, so until now the only thing on it was
    // the hemisphere fill and the festoon bulbs 400 mm below it - it measured
    // 0.104 linear away from a bulb, which is why the frame reads as having a
    // brown lid. The physically correct answer is not to raise its albedo again
    // (that has been done twice) but to give the shader the term that was
    // missing: light that has bounced off the slab.
    //
    // `amount` IS the ground albedo, per lighting.js's own documentation. A
    // dusty power-floated slab is bleached hardstanding, so 0.31.
    // `ao` 0.30 - the outer 20 m of this soffit is genuinely a wing underside
    //   over bright tarmac (the physical answer there is 0), the inboard third is
    //   an interior wanting corner-darkened fill; 0.30 splits it toward the open
    //   case, which is what the framings look at.
    // `lamps` 0.42 - raised from 0.25 because the shaded half of this plate IS a
    //   continuous lit surface: six festoon runs and four floods on one
    //   uninterrupted floor, which is the condition the doc says to raise it for.
    // `color` left to derive, so the bounce inherits whatever chromaticity the
    //   live rig actually has rather than a number remembered from a
    //   different sky.
    this.groundBounce = { amount: 0.31, ao: 0.30, max: 1.6, lamps: 0.42 };
    this.lightRig = { preset: 'mixed', key: 1.15 };
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose and nothing in here is a remembered number.
  // ---------------------------------------------------------------------------
  function buildAnchors(N) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    function gy(x, z) { return plateY(x, z, N); }
    var A = {};

    A.plate = {
      x0: X0, x1: X1, z0: Z0, z1: Z1,
      y: PLATE_Y, soffitY: SOFFIT_Y, lowerY: LOWER_Y, floorH: FLOOR_H, slabT: SLAB_T,
      colGridX: COLX.slice(), colGridZ: COLZ.slice(),
      litX: LIT_X, litZ: LIT_Z,
      groundY: function (x, z) { return plateY(x, z, N); },
      sunlit: function (x, z) { return sunlitSlab(x, z); }
    };

    A.core = {
      x0: CORE_X0, x1: CORE_X1, z0: CORE_Z0, z1: CORE_Z1, t: CORE_T,
      centre: V((CORE_X0 + CORE_X1) * 0.5, 0, (CORE_Z0 + CORE_Z1) * 0.5),
      yaw: -Math.PI * 0.5,                       // the lobby looks north
      lobby: { x0: LOB_X0, x1: LOB_X1, z0: CORE_Z0, z1: CORE_ZI1,
               centre: V((LOB_X0 + LOB_X1) * 0.5, 0, 0) },
      lobbyMouth: V((LOB_X0 + LOB_X1) * 0.5, 0, CORE_Z0),
      doorN: V(CORE_X0, 0, -4.8),
      doorS: V(CORE_X0, 0, 4.8),
      liftA: { mouth: V(LOB_X1, 0, -5.0), x0: LIFT_X0, x1: LIFT_X1, z0: CORE_ZI0, z1: -0.40 },
      liftB: { mouth: V(LOB_X1, 0, 5.0), x0: LIFT_X0, x1: LIFT_X1, z0: 0.40, z1: CORE_ZI1 },
      stair: { x0: STR_X0, x1: STR_X1, z0: CORE_ZI0, z1: CORE_ZI1,
               head: V((STR_X0 + STR_X1) * 0.5, 0, 2.0) }
    };

    A.columns = [];
    for (var i = 0; i < COLX.length; i++) {
      for (var k = 0; k < COLZ.length; k++) {
        var x = COLX[i], z = COLZ[k];
        if (x > CORE_X0 - 0.8 && x < CORE_X1 + 0.8 && z > CORE_Z0 - 0.8 && z < CORE_Z1 + 0.8) continue;
        if (x > VOID_X0 - 0.8 && x < VOID_X1 + 0.8 && z > VOID_Z0 - 0.8 && z < VOID_Z1 + 0.8) continue;
        A.columns.push({ x: x, z: z, y: gy(x, z), w: COL_W, kind: 'column',
          position: V(x, gy(x, z), z) });
      }
    }

    A.openEdge = {
      west: { x: X0, z0: Z0, z1: CW_WEST_Z0 },
      north: { z: Z0, x0: X0, x1: X1 },
      // the missing guard-rail bay: the only place a standing eye sees straight
      // down, and therefore the mark hero3 is solved on
      gap: { x0: -12.5, x1: -3.5, z: Z0 },
      corner: V(X0 + 2.4, gy(X0 + 2.4, Z0 + 2.4), Z0 + 2.4),
      dropTo: CITY_Y
    };

    A.curtainWall = {
      west: { x: X0 + 0.18, z0: CW_WEST_Z0, z1: CW_WEST_Z1, outward: -1 },
      south: { z: Z1 - 0.18, x0: CW_SOUTH_X0, x1: CW_SOUTH_X1, outward: 1 },
      sill: CW_SILL, head: CW_HEAD, pitch: CW_PITCH,
      corner: V(X0 + 0.18, 0, Z1 - 0.18)
    };

    A.slabVoid = {
      x0: VOID_X0, x1: VOID_X1, z0: VOID_Z0, z1: VOID_Z1,
      centre: V((VOID_X0 + VOID_X1) * 0.5, 0, (VOID_Z0 + VOID_Z1) * 0.5),
      lowerY: LOWER_Y, railY: 1.10
    };
    A.deckVoid = {
      x0: DECK_X0, x1: DECK_X1, z0: DECK_Z0, z1: DECK_Z1, y: SOFFIT_Y,
      centre: V((DECK_X0 + DECK_X1) * 0.5, SOFFIT_Y, (DECK_Z0 + DECK_Z1) * 0.5)
    };

    A.scaffold = { x: SCAF_X, z0: SCAF_Z0, z1: SCAF_Z1,
      lifts: [-2.0, 0.10, 2.10, 4.10, 6.10],
      rows: [SCAF_X + 0.42, SCAF_X + 1.55] };
    A.hoist = { mastX: HOIST_X + 1.35, mastZ: HOIST_Z,
      base: V(HOIST_X + 1.35, 0, HOIST_Z),
      cage: V(HOIST_X + 0.35, 0.10, HOIST_Z),
      landing: V(X1 - 0.6, 0, HOIST_Z) };
    A.crane = { mast: V(CRANE_X, 0, CRANE_Z), jibY: CRANE_JIB_Y, apex: CRANE_TOP,
      jibDir: V(0.7071, 0, 0.7071), radius: 54,
      hook: V(CRANE_X + 21.3, 5.6, CRANE_Z + 21.3) };

    A.city = { y: CITY_Y, radius: CITY_R, drop: -CITY_Y };
    A.sun = { dir: V(SUN_X, SUN_Y, SUN_Z), azimuth: SUN_AZ, elevation: SUN_EL,
      shadowDir: V(SHD_X, 0, SHD_Z) };

    A.spawn = { centre: V(4.0, gy(4.0, 13.4), 13.4), yaw: -0.62 };

    // ---- A GUARANTEED FOUR-MAN LINE -----------------------------------------
    // scenarios.js's combatMark() walks a WORLD-AXIS squad footprint outward
    // from the camera - four men at x = base.x + (i - 1.5) * 3.0 and z = base.z
    // - i * 3.4, i.e. a 9 x 10.2 m diagonal that does not rotate with the
    // bearing - and accepts a standoff only if all four cells are walkable. On a
    // 54 x 42 m plate with a slab void, two lift shafts, a side core and a
    // laydown that is a real constraint, and the old hero1 bearing failed it at
    // every d in [9, 26].
    //
    // This anchor is a mark the LEVEL guarantees: centred at (-17, 3.5), the
    // four men land at (-21.5, 3.5), (-18.5, 0.1), (-15.5, -3.3) and (-12.5,
    // -6.7). Every one is on the slab, every one clears the nearest column
    // footprint by more than the 0.73 m the nav grid pads them to, none is in
    // the void, the core, a lift shaft or a laydown collider - and every one of
    // them stands inside the sun wedge (x < -11.84), so a squad standing here is
    // rim-lit with its own shadows running back toward the hero1 lens.
    A.combatFocus = {
      centre: V(-17.0, gy(-17.0, 3.5), 3.5),
      spreadX: 3.0, spreadZ: 3.4, men: 4,
      yaw: 0.911,                      // the hero1 bearing, for a facing squad
      sunlit: true
    };
    A.stacks = [];
    A.lamps = [];
    return A;
  }

  // ---- material access, defensively -------------------------------------------
  // Every surface is requested BY THE NAME IN THE SURF TABLE. None of those are
  // library entries, so each one resolves to its `base` - a name materials.js
  // certainly knows - and the palette entry is forced onto it. An unknown name
  // would come back as an emissive magenta checker, which is exactly what should
  // happen and exactly what must never ship.
  LevelHighrise.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.slab;
    var m = null;
    var lib = this.ctx && this.ctx.materials;

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (key === 'debris_net') {
      m = this._netMaterial();
    } else if (key === 'city' || key === 'shell') {
      m = this._cityMaterial(key);
    } else if (key === 'glazing') {
      m = this._glazingMaterial();
    } else if (key === 'city_ground') {
      m = this._streetMaterial();
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
      // Triplanar scale + a private cache key. See the note on SURF.slab: this
      // is the ONLY control a consumer has over the world tile size of a
      // triplanar surface, and without it the concrete family is locked at
      // 2.04 m per tile no matter what the level's uv says.
      if (surf.triScale !== undefined) opts.triScale = surf.triScale;
      if (surf.variant !== undefined) opts.variant = surf.variant;
      if (surf.noPom) opts.parallax = false;
      // A 5 cm detail normal is right on a wall at normal incidence and
      // catastrophic on a ceiling: the eye is 2.3 m under a 54 x 42 m soffit, so
      // most of it is seen at 85-89 degrees, and at that incidence a fine normal
      // layer resolves into long streaky flakes - the "burnt toast" the critic
      // measured over the top third of every framing. Off on the soffit only.
      if (surf.noDetail) { opts.detail = false; opts.detail2 = false; }
      try { m = lib.get(surf.base || 'concrete', opts); }
      catch (e) { GAME.logError('highrise.material:' + key, e); m = null; }
      // Safe to mutate: `variant` makes the cache key unique to this surface on
      // this level, so nothing else can be holding this instance.
      if (m && surf.variant !== undefined) {
        try {
          // A 2 m blowhole is a texture bug; a 2 m blowhole with full ambient
          // occlusion in it is a hole punched through the wall. Halving the AO
          // and the normal scale on the two concrete_wall surfaces is what takes
          // the pitting from "volcanic scoria" to "formed concrete".
          if (surf.ao !== undefined && m.aoMap) m.aoMapIntensity = surf.ao;
          if (surf.ns !== undefined && m.normalScale && m.normalScale.set) {
            m.normalScale.set(surf.ns, surf.ns);
          }
          // ---- polythene ---------------------------------------------------
          // Alpha-blended and double-sided, with depth writes off so the front
          // and back of one hanging sheet do not fight each other. Every sheet
          // is its own mesh (see buildSheeting), so three's own back-to-front
          // transparent sort handles them and no manual ordering is needed.
          if (key === 'sheeting') {
            m.transparent = true;
            // ---- 0.34, NOT 0.62 ------------------------------------------
            // Same measurement as the glazing. At 0.62 over a 0.62-value albedo
            // a hung sheet is a 60%-opaque pale board, and six of them were
            // hung across the north and west openings - i.e. across the only
            // apertures through which this level's 176 m drop can be seen at
            // all. Site polythene is 250 micron and you can read a hand through
            // it; at 0.34 the sunset, the near towers and the city below arrive
            // through the sheet with the creases modulating them, which is both
            // what polythene does and what the openings are for.
            m.opacity = 0.34;
            m.depthWrite = false;
            m.side = THREE.DoubleSide;
          }
        } catch (e2) { /* a nicety, never a frame */ }
      }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelHighrise.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.slab;
    var surf = SURF[key] || SURF.slab;
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
    m.name = 'highrise_fallback_' + key;
    return m;
  };

  LevelHighrise.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0xDECA1) : this.rng); }
    catch (e) { GAME.logError('highrise.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.82, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.05,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    this._anisotropy(tex, 8);
    m.name = 'highrise_markings';
    return m;
  };

  LevelHighrise.prototype._netMaterial = function () {
    var tex = null;
    try { tex = netTexture(); } catch (e) { tex = null; }
    this._netOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.78, metalness: 0.0,
      normalMap: _netNorm || null,
      alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true,
      envMapIntensity: 0.8
    });
    if (_netNorm && m.normalScale) m.normalScale.set(0.9, 0.9);
    if (!tex) { m.opacity = 0.30; m.transparent = true; m.alphaTest = 0; }
    this._anisotropy(tex, 4);
    this._anisotropy(_netNorm, 4);
    m.name = 'highrise_net';
    return m;
  };

  // The city and our own tower shell share one facade map. The emissive half is
  // the whole "points of light as the sun drops" requirement: without an
  // emissiveMap a city at sunset is a grey model of a city at sunset.
  LevelHighrise.prototype._cityMaterial = function (key) {
    var tex = null;
    try { tex = buildCityMaps(this.rng.fork ? this.rng.fork(0xC17) : this.rng); }
    catch (e) { GAME.logError('highrise.city', e); tex = null; }
    this._cityOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff,
      // The roughness MAP is what separates a glass bay (0.15) from a spandrel
      // or precast bay (0.87). `roughness` multiplies it, so it is 1.0 here and
      // the map owns the whole range - one flat 0.86 across a metropolis is why
      // no building anywhere had a specular event on it at sunset.
      roughness: _cityRough ? 1.0 : (key === 'shell' ? 0.68 : 0.86),
      roughnessMap: _cityRough || null,
      metalness: key === 'shell' ? 0.25 : 0.14,
      normalMap: _cityNorm || null,
      vertexColors: true,
      envMapIntensity: key === 'shell' ? 1.5 : 0.85
    });
    // Our own shell is 20 m away and the city is 300; the same map wants twice
    // the relief up close and half of it at range, or the far city shimmers.
    if (_cityNorm && m.normalScale) {
      var ns = key === 'shell' ? 1.25 : 0.85;
      m.normalScale.set(ns, ns);
    }
    this._anisotropy(_cityNorm, 8);
    this._anisotropy(_cityRough, 8);
    if (_cityEmis) {
      m.emissiveMap = _cityEmis;
      m.emissive = new THREE.Color(1, 1, 1);
      // Far enough down that the haze eats most of it; high enough that what
      // survives is unmistakably a lit window. NOT higher: the emissive is what
      // the frame's auto-exposure ends up metering on, and a city that meters
      // brighter than the sky it sits under inverts the whole image.
      // 0.88, not 1.05. The facades now carry a real sun/shade split rather than
      // a flat 1.0, so their shaded faces are darker than they were - and an
      // emissive that was already at the edge of metering the frame started
      // outvaluing the buildings it is supposed to be a window in. A lit room is
      // brighter than the wall around it; it is not brighter than the sunset.
      m.emissiveIntensity = key === 'shell' ? 0.78 : 0.88;
    }
    this._anisotropy(tex, 8);
    m.name = 'highrise_' + key;
    return m;
  };

  // ---- the curtain wall's glass -------------------------------------------
  // Not materials.js's glass(): that one authors its own grime story at its own
  // repeat and cannot be handed a map, and what this pane needs is a SITE
  // glazing story - never cleaned, protective film still on, suction-cup rings,
  // slurry off the scaffold. The coverage map is bound to BOTH alphaMap and
  // roughnessMap, so the dirty parts are simultaneously more opaque and rougher,
  // which is exactly how a filthy pane behaves: it stops being a mirror where
  // the dirt is, and that is where the value structure comes from.
  LevelHighrise.prototype._glazingMaterial = function () {
    var tex = null;
    try { tex = buildGlazingMaps(this.rng.fork ? this.rng.fork(0x61A55) : this.rng); }
    catch (e) { GAME.logError('highrise.glazing', e); tex = null; }
    this._glazeOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff,
      // 0.90 x the coverage map, so clean vision glass lands near 0.21 instead
      // of 0.17 - still a mirror, but with a measurable roughness gradient
      // across the dirt so the reflected sunset breaks up instead of sliding.
      roughness: tex ? 0.90 : 0.12,
      // ---- 0.16, NOT 0.0 ---------------------------------------------------
      // A dielectric at metalness 0 has F0 = 0.04, so at 2.0 env intensity the
      // pane returned 8% of the sky and NOTHING of the sunset: the one asset the
      // roster brief singles out ("a glass curtain-wall section that reflects
      // the sunset") had no reflection in it at all. Real vision glass carries a
      // low-e coating and returns 15-30% at normal incidence and far more at
      // grazing, which is a tinted-metal response, not a bare dielectric one.
      metalness: 0.16,
      roughnessMap: _glazeRough || null,
      normalMap: _glazeNorm || null,
      alphaMap: _glazeAlpha || null,
      // ---- 0.58, NOT 0.86.  THE BLANK-RECTANGLE BUG ------------------------
      // MEASURED: on hero1 the three west openings, the vanishing point and the
      // whole left third of hero2 were pale cream rectangles, and the reason was
      // arithmetic rather than art. 0.86 x a coverage floor of 0.17 is an
      // effective 0.15 for the clean glass - except the ALBEDO was 0.79 white
      // and the pane is lit by the same sky it is standing in front of, so the
      // 15% it did contribute read at the same value as the sky behind it and
      // the extra 85% of the sky was blocked. A curtain wall you cannot see the
      // city through cannot express a 176 m drop, and hero1's entire premise is
      // on the far side of it.
      //
      // 0.58 x a 0.239 floor = 0.139 for clean glass and ~0.52 for the filthy
      // parts, against a much darker albedo. What arrives now is the sunset, the
      // near towers and the city THROUGH the pane, modulated by the streaks,
      // suction rings and slurry ON it - which is what a site facade is.
      transparent: true, opacity: 0.58, depthWrite: false,
      side: THREE.DoubleSide, vertexColors: true,
      envMapIntensity: 2.6
    });
    if (_glazeNorm && m.normalScale) m.normalScale.set(0.55, 0.55);
    if (!tex) { m.opacity = 0.26; }
    this._anisotropy(tex, 8);
    this._anisotropy(_glazeAlpha, 8);
    this._anisotropy(_glazeNorm, 8);
    m.name = 'highrise_glazing';
    return m;
  };

  // ---- the street plane -----------------------------------------------------
  LevelHighrise.prototype._streetMaterial = function () {
    var tex = null;
    try { tex = buildStreetMaps(this.rng.fork ? this.rng.fork(0x5713E7) : this.rng, this.noise); }
    catch (e) { GAME.logError('highrise.street', e); tex = null; }
    this._streetOk = !!tex;
    if (!tex) return this._fallbackMaterial('city_ground');
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff,
      roughness: 0.90, metalness: 0.04,
      normalMap: _roadNorm || null,
      vertexColors: true, envMapIntensity: 0.30
    });
    if (_roadNorm && m.normalScale) m.normalScale.set(0.7, 0.7);
    this._anisotropy(_roadNorm, 8);
    if (_roadEmis) {
      m.emissiveMap = _roadEmis;
      m.emissive = new THREE.Color(1, 1, 1);
      // The street lighting has to survive 250-450 m of haze as a POINT without
      // metering the frame. 0.62 puts it a stop under the lit windows, which is
      // the right relationship: a window is a room, a street lamp is a bulb.
      m.emissiveIntensity = 0.62;
    }
    this._anisotropy(tex, 8);
    m.name = 'highrise_street';
    return m;
  };

  LevelHighrise.prototype._anisotropy = function (tex, max) {
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (tex && caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(max, caps.getMaxAnisotropy() || 1));
      }
    } catch (e) { /* anisotropy is a nicety */ }
  };

  // ---- colliders ---------------------------------------------------------------
  LevelHighrise.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
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
  LevelHighrise.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();

    // Each stage is isolated and timed. The timing is not decoration: this
    // level's first build hung with no error and no stack, and a per-stage
    // record on GAME is what located it (see the loop-counter note in
    // buildLaydown). Whole build is ~240 ms; if a stage ever reads in seconds,
    // that is where to look.
    function stage(name, fn) {
      var now = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); } : function () { return 0; };
      var t0 = now();
      try { fn(); } catch (e) { GAME.logError('highrise.' + name, e); }
      var prof = GAME.__hrProfile || (GAME.__hrProfile = []);
      prof.push(name + ':' + Math.round(now() - t0));
    }

    // ---- the atmosphere the level actually needs ---------------------------
    // sky.js's authored fog is a GROUND fog: density D at baseY = 0 with an
    // e-folding height of 5.5 m. From an eye 176 m above the street that puts
    // the fog's maximum opacity on the entire city and nothing at all on the
    // floor plate, i.e. exactly backwards. Re-basing the layer on the STREET
    // and stretching its scale height to a real atmospheric one gives the thing
    // the brief asks for: crisp concrete at 10 m, believable aerial perspective
    // at 400 m, and a horizon that dissolves instead of ending.
    //
    // setFog is materials-free public API on sky.js and this is the only level
    // that calls it, so the market and the harbor cannot move.
    stage('fog', function () {
      if (ctx && ctx.sky && typeof ctx.sky.setFog === 'function') {
        // The numbers are solved, not tuned by eye. Three paths have to work at
        // once and a height fog cannot make all of them dense:
        //   * 40 m across the plate at y = 0     -> ~6%   (concrete stays crisp)
        //   * 255 m down to the street at -35 deg -> ~42%  (real aerial depth)
        //   * 600 m out at the far plane         -> ~57%  (the rim recedes)
        // The first version ran the layer at density 0.023 with an 88 m scale
        // height, which put 93% haze on the city 176 m below - the level's
        // entire lower two thirds dissolved into featureless cream and hero3
        // photographed a white void with a handrail in front of it.
        ctx.sky.setFog({
          // ===================================================================
          // THE DROPPED KEY.  THIS ONE LINE IS THE MEASUREMENT OF THIS ROUND.
          //
          // Every comment in this block discusses `density` at length - "0.0019,
          // not 0.0026", "the ramp (density 0.0019, scale height 380) was already
          // right and is untouched", and three solved path opacities quoted to the
          // per cent - and the key was never in the object. So for two rounds the
          // level has been running on sky.js's DEFAULT density of 0.0150, which is
          // the market's street fog: EIGHT TIMES thicker than every number in
          // these comments assumes.
          //
          // What that actually did, computed at this level's own baseY (-174) and
          // e-folding height (380 m), where the density at plate level is
          // 0.0150 * exp(-174/380) = 0.00949 per metre:
          //
          //     40 m across the plate      od 0.380 -> 32% haze   (believed 5%)
          //     24 m out through an opening od 0.228 -> 20%
          //     260 m to a near tower      od 2.47  -> capped at 52%
          //
          // A THIRD OF A HAZE LAYER ACROSS THE ROOM. That is why the slab
          // photographed as a flat brown expanse with no detail at 10 m, why
          // hero3's city was one sepia value, and why the thing that sent me
          // looking: after the glazing and the sheeting were finally made
          // transparent, hero1's west openings STILL came back as blank cream at
          // sRGB 210 with a 206 m tower standing dead centre 260 m away. Sampled
          // a vertical profile through the aperture and there was no roofline in
          // it at all - because 52% of every pixel out there was inscatter, and
          // the inscatter at this hour is 2.1 linear against a shaded facade at
          // 0.05. Twenty-seven per cent of that is survivable; fifty-two is not.
          //
          // At the authored 0.0019 the three solved paths land where the comments
          // below say they do (4.7% / 26.8% / 37%), the near field goes crisp, and
          // a tower across a gulf becomes a dark mass in a burning aperture
          // instead of part of the aperture.
          density: 0.0019,
          baseY: CITY_Y + 2.0,
          // 380, not 260. A wider e-folding height is how you make the FAR rim
          // reach the cap without also erasing the near city - raising the cap
          // does both at once, which is what went wrong.
          heightScale: 380.0,
          // 0.0019, not 0.0026. Measured consequence of the old pair: the
          // background median across four depth bands on hero3 was 0.465 /
          // 0.486 / 0.475 / 0.425 - near buildings and far buildings at the SAME
          // value, i.e. no aerial perspective at all, only a contrast collapse.
          // The value ramp IS the depth cue, and it only exists if the near city
          // keeps a real fraction of its own albedo. At 0.0019 / 380 the numbers
          // are:
          //   40 m across the plate at y = 0        -> ~5%   (concrete crisp)
          //   300 m down to the street at -30 deg   -> ~38%  (near city dark)
          //   635 m to the city rim                 -> ~64%
          //   1500 m to the silhouette band         -> capped
          // ---- 0.52, NOT 0.80 -------------------------------------------
          // THE measurement of this round. At an 0.80 cap the city 100-250 m
          // below the open edge kept 20% of its own radiance and the other 80%
          // was one flat inscatter colour, so the two orthogonal faces of the
          // SAME tower measured 1.10-1.32x apart where the geometry says 6:1 -
          // i.e. the sunset was not on the city at all, and the nearest band of
          // it cropped at 3.5x was a uniform brown card with window lights
          // floating on it. Haze that erases value structure is not aerial
          // perspective, it is a grey wash with a distance ramp.
          //
          // The ramp (density 0.0019, scale height 380) was already right and
          // is untouched; only the CAP moves. At 0.52 the near city keeps ~70%
          // of its albedo-lit radiance, so a 6:1 face split survives as ~3:1,
          // which is what makes a skyline read as buildings. The far rim was
          // the reason the cap was high - it has to dissolve rather than end -
          // and that is now paid for by the distant-hill ramp instead (see
          // buildCity), which closes the gap under the horizon with a wavy
          // silhouette rather than with opaque fog.
          maxOpacity: 0.52,
          // 0.55, not 0.70. Two of the five framings look within 20 degrees of
          // the sun's azimuth, and at 0.70 the Henyey-Greenstein lobe put so
          // much forward scatter into those frames that the city 176 m below
          // came back as featureless warm cream. Forward scatter is the depth
          // cue here, not the subject.
          // ---- 0.46 / 0.50, NOT 0.55 / 0.85 --------------------------------
          // THE MEASUREMENT THAT FOUND THIS. After the glazing and the sheeting
          // were made transparent, hero1's three west openings finally had a line
          // of sight through them - and they still photographed as blank cream.
          // Sampled: opening mean sRGB 203 with p95 224 against a near floor at
          // 67 and a soffit at 68, with a 222 m tower 253 m away, three towers at
          // 150-180 m and a lit skyline all inside that aperture and NONE of them
          // resolving. The buildings were not missing; they were being erased.
          //
          // The cause is the sunward lobe, and the arithmetic is in sky.js: the
          // inscatter weight is w = clamp((hg - 0.42) * 0.34 * glowGain, 0, 1.6),
          // and when w exceeds 1 the shader ADDS 0.75 x (w - 1) more of the SOLAR
          // colour on top. hero1's axis is within 4 degrees of the sun's own
          // bearing, so hg is at its maximum, and at mieG 0.55 / glowGain 0.85 the
          // 26% of haze between the lens and a tower 253 m out was carrying
          // roughly 1.4 of added solar radiance - more than the tower's whole
          // shaded facade. Twenty-six per cent of a bright enough inscatter erases
          // a hundred per cent of anything.
          //
          // A narrower lobe at half the gain keeps the glow band under the soffit
          // edge (which is the best thing in the frame and is a NARROW band, so it
          // wants a narrow lobe anyway) and hands the rest of the aperture back to
          // the geometry that is standing in it.
          // Both of these were tuned against a haze layer eight times too thick,
          // so they were compensating for the wrong thing. Probed at the old
          // density they moved the aperture by 1.5 sRGB out of 210 - which is what
          // sent me to the density in the first place. Kept a little under the
          // originals: with a correct layer the sunward lobe is doing real work
          // again and does not need to shout.
          mieG: 0.52,
          glowGain: 0.70,
          // 0.24, not 0.34. `desaturate` pulls toward GREY on the way to the
          // haze, and the measured result on hero3 - which looks 100 degrees
          // AWAY from the sun, at a city filling 60% of the frame - was a single
          // sepia value across the whole image: slab, near towers, far towers
          // and street all one orange-brown, no cool anywhere. The roster pins
          // this level "orange / GLASS BLUE" and the blue half was absent.
          // Chroma is now shifted by the two-lobe tint below instead of being
          // bleached out first.
          desaturate: 0.24,
          // ---- THE TWO-LOBE TINT, WHICH IS WHAT THIS LEVEL IS FOR -----------
          // sky.js documents this as the lever for "a low sun paired with heavy
          // air", says every roster level in that condition hits it, and notes
          // that no existing caller sets tintAmount - so it is inert everywhere
          // else and market/harbor cannot move.
          //
          // The physics it buys: at a 9-degree sun the SUNWARD haze is 2400 K
          // scattered sunlight and the ANTI-SUN haze is 12000 K skylight. That
          // one fact is the entire "orange / glass blue" palette. hero1 and
          // hero2 look within 30 degrees of the sun and keep the burning colour;
          // hero3 and the establishing shot look away from it and now get cool
          // blue air, which is what makes 176 m of it read as DEPTH rather than
          // as a brown wash. It is luminance-preserving by contract, so no
          // coverage or exposure metric can move.
          tint: [0.30, 0.41, 0.66],
          tintAmount: 0.46
        });
      }
      // ---- THE COOL HALF OF THE PALETTE, WHICH WAS NEVER IN THE DOME ---------
      // MEASURED on the round-3 establishing frame: the printed top strip ran
      // sRGB (78.8, 73.0, 69.2), i.e. R/B 1.139 - a NEUTRAL grey-brown overhead
      // against an ochre band at R/B 2.155 twenty degrees lower. A sunset does
      // not work like that. The warm horizon is only warm because there is a
      // genuinely blue dome above it for it to sit against, and with the dome
      // neutral there was no cool reference anywhere in the level: not in the
      // sky, not in the shade (shadow chroma measured [0.008,-0.002,-0.005] on
      // hero1, i.e. achromatic), not in the glass. The roster pins this level
      // "orange / GLASS BLUE" and the blue half was absent from the light
      // itself, so no amount of level-side paint could have supplied it.
      //
      // sky.js now publishes setZenithTint for exactly this: a
      // luminance-preserving chromaticity rotation of the UPPER dome, living in
      // the LUT, so the IBL, the hemisphere fill and every derived fog colour
      // inherit it rather than only the picture. That last part is the whole
      // point - what this level needs is COOL LIGHT, not a cool backdrop.
      //
      // The window is authored, and it was SOLVED against this level's own
      // framings rather than defaulted. The establishing camera pitches 15.1
      // degrees down, so at 0.065 degrees per pixel its horizon sits at y 205 and
      // the whole visible sky is 0-13.4 degrees of elevation: the ochre band the
      // level is selling occupies y 113-159, i.e. 3-6 degrees, and the strip the
      // critic sampled as "the zenith" is 11-13.4.
      //
      // Those two bands are only 8 degrees apart, so the first attempt
      // (fromDeg 1.5, toDeg 26, away 0.42) hit both: the top strip came in at
      // R/B 0.577, inside the 0.55-0.70 target, but the ochre band went 2.155 ->
      // 0.949 and the sunset stopped being a sunset. That is the exact failure
      // mode sky.js documents at away 1.0, reached from the other direction.
      //
      // `away` is the knob that separates them, because it gates how much of the
      // rotation the LOW sky gets on bearings away from the sun - which is what
      // the ochre band IS from every framing except hero1. At 0.20 with the
      // window lifted to 4-28 degrees the top strip still rotates and the 3-6
      // degree band keeps its chromaticity. `dim` stays 0, which makes the
      // rotation provably unable to move the skylight, keyRef, fog caps or
      // exposure.
      //
      // Only this level calls it and it is inert by default (amount 0), so the
      // market and the harbor cannot move.
      if (ctx && ctx.sky && typeof ctx.sky.setZenithTint === 'function') {
        ctx.sky.setZenithTint({
          amount: 1.0,
          chroma: [0.225, 0.585, 1.075],
          fromDeg: 4.0, toDeg: 28.0,
          away: 0.20, azTight: 13, dim: 0.0
        });
      }
      // 78 m of cascade over a 68 m plate is the whole building for an
      // eye-level pose; update() widens it when the camera stands outside the
      // bounds box, because the establishing shot is 69 m from its own subject
      // and the far elevation is 110 m out, i.e. entirely past this limit - and
      // a subject beyond the last cascade receives no shadows at all, which is
      // why the top plate photographed with no column shadows on it.
      if (ctx && ctx.lighting && typeof ctx.lighting.setShadowDistance === 'function') {
        ctx.lighting.setShadowDistance(78);
        self._shadowDist = 78;
      }
    });

    stage('city', function () { buildCity(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('shell', function () { buildShell(self, B, rng, N); });
    stage('plate', function () { buildPlate(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('soffit', function () { buildSoffit(self, B, rng, N); });
    stage('columns', function () { self.columns = buildColumns(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('core', function () { buildCore(self, B, rng, N); });
    stage('curtainwall', function () { buildCurtainWall(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('edge', function () { buildEdgeProtection(self, B, rng, N); });
    stage('outboard', function () { buildOutboard(self, B, rng, N); });
    stage('sheeting', function () { self.sheets = buildSheeting(self, B, rng, N); });
    stage('scaffold', function () { self.anchors.scaffold = buildScaffold(self, B, rng, N); });
    stage('hoist', function () {
      var h = buildHoist(self, B, rng, N);
      self.anchors.hoist.mastX = h.mastX; self.anchors.hoist.mastZ = h.mastZ;
    });
    await GAME.yieldFrame();

    stage('crane', function () {
      var c = buildCrane(self, B, rng, N);
      self.anchors.crane.mast.copy(c.mast);
      self.anchors.crane.hook.copy(c.hook);
      self.anchors.crane.cab = c.cab;
      self.anchors.crane.apex = c.apex;
    });
    stage('laydown', function () {
      self.stacks = buildLaydown(self, B, rng, N);
      self.anchors.stacks = self.stacks;
    });
    stage('lamps', function () { self._buildLamps(B, N); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    await GAME.yieldFrame();

    stage('nav', function () { self._buildNav(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);

    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    _prismCache.forEach(function (g) { g.dispose(); }); _prismCache.clear();
    return this;
  };

  // ============================================================== THE LAMP RIG ==
  // rig 'mixed' trims the key to 0.62 and holds the practicals at a lampFloor of
  // 0.85, which is the correct reading of the brief: the sun is the thing that
  // rakes the columns, and the site's own lighting is the only thing in the
  // shaded two thirds of the plate with any output at all.
  //
  // Two things are designed against, both learned on the harbor:
  //
  // 1. COVERAGE. Eight narrow cones in a 54 x 42 m room is eight torches in a
  //    field, and the floor is the largest surface in five framings. The
  //    festoon runs are therefore MANY, WIDE and LOW-POWER, hung at 3.6 m with
  //    cone 1.15 so their pools overlap at the rim. That is still pools and
  //    darkness; it is not a flat wash.
  // 2. THE CAMERA INSIDE THE CONE. A lamp 2 m from the eye fills the frame with
  //    flat orange, because lighting.js correctly builds the volumetric from the
  //    spot's own angle. Every entry below is checked against the five published
  //    eyes; the festoon bulbs closest to a framing carry the narrowest cones
  //    and the lowest beam.
  //
  // lighting.js gives every entry an emissive bulb and an additive halo for
  // free, so this file builds only the FIXTURES - the catenary, the guards, the
  // tripods, the batten bodies.
  //
  // ---------------------------------------------------------------------------
  // 3. AND THE ONE THAT ACTUALLY MATTERED: THE NUMBERS WERE A STOP AND A HALF
  //    OUT, TWICE OVER.
  //
  // Measured on the first capture of lv_interior: floor directly beneath a
  // hanging festoon bulb = 0.0460 linear luminance. Floor six metres away in the
  // same band = 0.0460 linear. Identical to four decimal places. The soffit
  // above a bulb was 0.1211 against 0.1043 away - a 16% lift from a light that
  // is 400 mm from it.
  //
  // The cause is a units error, not a design one. These are POINT AND SPOT
  // lights with decay 2, so irradiance at the floor is intensity / d^2. A
  // festoon bulb hanging at 3.58 m over a floor at 0 was pushing 5.4 / 12.8 =
  // 0.42 - against a sky ambient that was already delivering more than that. The
  // market's own cone practical runs intensity 78 at distance 14 and the
  // harbour's masts run 104-128; this level was running FIFTEEN BRIGHT EMISSIVE
  // BULBS WITH BLOOM HALOES THAT LIT NOTHING, which is precisely the
  // emissiveLamps:0 failure DEVELOPMENT.md names as the highest-value finding of
  // the whole build, and it is the direct cause of the crushed shaded half of
  // every framing.
  //
  // Every number below is now solved for a target irradiance at the surface the
  // fixture is meant to light, and the target is stated next to it.
  // ---------------------------------------------------------------------------
  // THE HARD CAP NOBODY DOCUMENTED, AND THE SILENT FAILURE IT CAUSED
  //
  // lighting.js's _buildPracticals runs `for (i = 0; i < defs.length && i < cap;
  // i++)` with MAX_PRACTICALS_RIG = 24 for a declarative rig. A level that
  // publishes more than twenty-four practicals does not get them dimmed or
  // merged - the tail is simply never built, in ORDER, with no warning.
  //
  // This level published thirty-seven. The first twenty-four were all festoon
  // bulbs, so the lobby battens, the floods, the shaft worklights, the lamp on
  // floor 46, the cabin and the stair were all silently absent - which is why
  // the `interior` framing came back as an unlit tube after the intensities were
  // fixed. The fix is not fewer bulbs (the FIXTURES are geometry and cost
  // nothing) but fewer LIGHTS per string: one practical per two or three bulbs,
  // at a proportionally longer throw, so a string still reads as a string of
  // overlapping pools.
  //
  // The budget below is exact, and _buildLamps asserts it.
  //   festoon 12  lobby 4  floods 4  shafts 2  below 1  cabin 1  = 24
  //
  // ---- WHAT CHANGED THIS ROUND, AND WHY --------------------------------------
  // Measured on the real hero1 frame by toggling and re-rendering, the OPEN-EDGE
  // APPROACH - the part of the deck nearest the 176 m drop, i.e. the part that
  // carries the level's whole premise - came back at 0.04639 linear with
  // everything on and 0.04687 with all 25 hr_* practicals set to zero. The site
  // rig contributed NOTHING there, and the sun 18%. For contrast the festoon-lit
  // interior measured 0.25538 with practicals and 0.03828 without, so the rig
  // works; it just did not exist where the eye goes.
  //
  // The festoon heads spanned x -23.4..+23.9 and the four flood heads x
  // -23.2..+19.6 - nothing lit the outer 3 m of the open edge or the approach to
  // it. There is now a run at x -25.3 down the west open edge, and two of the
  // four floods are turned OUTBOARD to rake the edge protection and the slab
  // arris. A working floodlight aimed at the edge you are about to fall off is
  // also the most legible piece of storytelling available on this level.
  //
  // Paid for inside the 24 cap by dropping hr_stair (a fluorescent behind the
  // lift bank, in no published framing - its emissive fitting stays) and one
  // light off the 36 m x -6 run, which still overlaps at 18 m throw.
  var MAX_LAMPS = 24;
  var FESTOON = [
    // [x0, z0, x1, z1, bulbs, sag, lights]
    [X0 + 3.0, 6.0, CORE_X0 - 1.5, 6.0, 5, 0.42, 2],
    [X0 + 3.0, -12.0, CORE_X0 - 1.5, -12.0, 5, 0.42, 2],
    [-6.0, Z1 - 3.0, -6.0, Z0 + 3.0, 5, 0.46, 2],
    // a fourth run down the shaded east half, which had no source at all
    [16.0, -14.5, 25.0, -14.5, 4, 0.38, 2],
    // and a fifth down the glazed south-west aisle. That corner is enclosed by
    // the curtain wall on two sides, so no sun reaches it and no other fitting
    // was within fifteen metres: the near floor in the hero2 framing measured
    // 16.8% of the frame under sRGB 0.06 with nothing lighting it at all.
    [-23.4, 5.0, -23.4, 19.0, 5, 0.44, 2],
    // ---- and a sixth ALONG THE OPEN EDGE ITSELF ---------------------------
    // 1.7 m inboard of the west arris, over the 5 m break in the edge
    // protection that hero3 stands in. Five heads at 3.4 m centres from z -16.3
    // to -2.7, two of them carrying a light at a longer throw so the run reads
    // as overlapping pools rather than as two torches.
    [-25.3, -18.0, -25.3, -1.0, 5, 0.40, 2]
  ];

  LevelHighrise.prototype._buildLamps = function (B, N) {
    var self = this;
    var lamps = [];
    var i, k;
    var hangY = 3.58;

    function push(name, kind, x, y, z, kelvin, intensity, dist, cone, aim, extra) {
      var d = {
        name: name, kind: kind, pos: [x, y, z],
        kelvin: kelvin, intensity: intensity, distance: dist,
        dayBase: 0.88, fixed: true,
        haloScale: 0.30, haloMax: 2.2
      };
      if (cone) { d.cone = cone; d.penumbra = 0.42; }
      if (aim) d.aimPos = aim;
      if (extra) { for (var q in extra) d[q] = extra[q]; }
      lamps.push(d);
      self.anchors.lamps.push({
        name: name, kind: kind,
        pos: new THREE.Vector3(x, y, z),
        aim: aim ? new THREE.Vector3(aim[0], aim[1], aim[2]) : new THREE.Vector3(x, y - 3, z)
      });
      return d;
    }

    // ---- festoon strings ----------------------------------------------------
    B.paint = 'steel';
    for (i = 0; i < FESTOON.length; i++) {
      var f = FESTOON[i];
      var n = f[4];
      var nLights = f[6] || 1;
      // the cable, as a real catenary of short segments
      var prevX = f[0], prevY = hangY, prevZ = f[1];
      for (k = 1; k <= n * 3; k++) {
        var t = k / (n * 3);
        var cx = M.lerp(f[0], f[2], t), cz = M.lerp(f[1], f[3], t);
        var cy = hangY - Math.sin(t * Math.PI) * f[5];
        B.tube('scaff', prevX, prevY, prevZ, cx, cy, cz, 0.008, 4);
        prevX = cx; prevY = cy; prevZ = cz;
      }
      // eye bolts into the soffit
      B.cyl('scaff', 0.014, 0.014, 0.24, f[0], SOFFIT_Y - 0.12, f[1], 0, 0, 0, 5);
      B.cyl('scaff', 0.014, 0.014, 0.24, f[2], SOFFIT_Y - 0.12, f[3], 0, 0, 0, 5);
      B.tube('scaff', f[0], SOFFIT_Y - 0.20, f[1], f[0], hangY, f[1], 0.007, 4);
      B.tube('scaff', f[2], SOFFIT_Y - 0.20, f[3], f[2], hangY, f[3], 0.007, 4);

      for (k = 0; k < n; k++) {
        var tb = (k + 0.5) / n;
        var bx = M.lerp(f[0], f[2], tb), bz = M.lerp(f[1], f[3], tb);
        var by = hangY - Math.sin(tb * Math.PI) * f[5] - 0.16;
        // lampholder + wire guard: a bulb with no cage is not a site light
        B.paint = 'paint';
        B.cyl('plant', 0.032, 0.040, 0.11, bx, by + 0.09, bz, 0, 0, 0, 8);
        B.paint = 'steel';
        for (var q2 = 0; q2 < 5; q2++) {
          var a2 = q2 / 5 * 6.28318;
          B.tube('scaff', bx + Math.cos(a2) * 0.012, by + 0.05, bz + Math.sin(a2) * 0.012,
            bx + Math.cos(a2) * 0.085, by - 0.10, bz + Math.sin(a2) * 0.085, 0.005, 4);
        }
        B.cyl('scaff', 0.085, 0.085, 0.008, bx, by - 0.11, bz, 0, 0, 0, 10);
        // the bulb itself, emissive, so the source is VISIBLE as well as lighting
        B.paint = 'flat';
        B.cyl('lamp_glass', 0.030, 0.030, 0.075, bx, by - 0.02, bz, 0, 0, 0, 8);
        B.paint = 'steel';
        // ---- and the LIGHT, on one bulb in two or three -------------------
        // 54, not 5.4. Hung at 3.42 m over a floor at 0, decay 2:
        // 54 / 3.42^2 = 4.6 irradiance directly under the bulb and 1.5 at 5 m,
        // so two lights on a 20 m string still overlap at the rim. That is a
        // run of POOLS, which is what a festoon looks like and what the shaded
        // two thirds of this plate needs to stop crushing. The bulbs that do
        // not carry a light are still emissive geometry, so the string reads
        // unbroken - see the MAX_LAMPS note.
        var lightHere = false;
        for (var lq = 0; lq < nLights; lq++) {
          if (Math.round((lq + 0.5) * n / nLights - 0.5) === k) lightHere = true;
        }
        if (lightHere) {
          // The open-edge run works harder than the others: it is the only
          // source within 12 m of the arris, it is the subject of two framings,
          // and it has to reach 3 m OUTBOARD of the slab to put a value on the
          // edge protection. 68 at a 22 m throw and a wider cone.
          var edgeRunL = (i === 5);
          push('hr_festoon_' + i + '_' + k, 'tungsten', bx, by - 0.04, bz,
            edgeRunL ? 2350 : 2450, edgeRunL ? 68.0 : 54.0, edgeRunL ? 22.0 : 18.0,
            edgeRunL ? 1.28 : 1.15,
            [bx - 1.4, plateY(bx, bz, N), bz], { haloGain: 0.85 });
        }
      }
    }

    // ---- the lobby battens --------------------------------------------------
    // Fluorescent, cold against the tungsten outside, and the only reason the
    // `interior` framing is not a black tube with a bright hole at the end.
    for (i = 0; i < 4; i++) {
      var lz = -7.4 + i * 5.0;
      var lx = (LOB_X0 + LOB_X1) * 0.5;
      B.paint = 'paint';
      B.box('plant', 0.10, 0.09, 1.35, lx, 3.46, lz, 0.01);
      B.paint = 'flat';
      B.box('lamp_glass', 0.075, 0.05, 1.22, lx, 3.40, lz, 0.006);
      B.paint = 'steel';
      B.tube('scaff', lx, SOFFIT_Y - 0.02, lz - 0.5, lx, 3.50, lz - 0.5, 0.006, 4);
      B.tube('scaff', lx, SOFFIT_Y - 0.02, lz + 0.5, lx, 3.50, lz + 0.5, 0.006, 4);
      // 27, not 4.2. At 3.36 m that is 2.4 under the batten and about 0.4 at
      // the wall five metres away, which is the tube-of-light-with-dark-ends
      // the `interior` framing is built on. At 4.2 it was 0.37 under the
      // fitting, i.e. below the ambient it was supposed to beat.
      push('hr_lobby_' + i, 'fluoro', lx, 3.36, lz, 4300, 34.0, 11.0, 1.42,
        [lx, 0, lz], { haloGain: 0.55, haloMax: 1.5 });
    }

    // ---- halogen site floods on tripods -------------------------------------
    // The one warm-white source with any throw. Aimed ACROSS the shaded half of
    // the plate rather than down, so they model the columns instead of pooling
    // at their own feet.
    // The fourth stands at the vanishing point of hero2's mullion run, which
    // that framing needed anyway: a leading line has to arrive somewhere.
    // ---- TWO OF THE FOUR NOW POINT OUTBOARD ---------------------------------
    // [0] stands 12 m off the west arris and rakes it end-on; [1] stands 9 m off
    // the north arris and does the same. Both heads face AWAY from every
    // published eye, so what the camera sees is the back of a working flood and
    // the wedge of light it is throwing at the edge - not the lamp. [2] still
    // models the core's west face and [3] is the vanishing point of hero2's
    // mullion run, which that framing needs.
    var FLOODS = [
      [-14.5, 6.2, 1.90, [-25.5, 0.9, -8.0], 3350],
      [-2.0, -12.0, 1.85, [-13.0, 0.9, -20.3], 3350],
      [19.6, 5.2, 1.80, [11.0, 1.6, -8.0], 3200],
      [-23.2, 2.6, 1.95, [-21.0, 1.0, 14.0], 3300]
    ];
    for (i = 0; i < FLOODS.length; i++) {
      var fl = FLOODS[i];
      var fx = fl[0], fz = fl[1], fy = fl[2];
      var gy0 = plateY(fx, fz, N);
      B.paint = 'steel';
      for (k = 0; k < 3; k++) {
        var la = k / 3 * 6.28318 + 0.4;
        B.tube('scaff', fx, gy0 + fy - 0.22, fz,
          fx + Math.cos(la) * 0.46, gy0, fz + Math.sin(la) * 0.46, 0.014, 5);
      }
      B.cyl('scaff', 0.022, 0.022, fy - 0.2, fx, gy0 + (fy - 0.2) * 0.5, fz, 0, 0, 0, 7);
      B.cyl('scaff', 0.05, 0.05, 0.10, fx, gy0 + fy - 0.18, fz, 0, 0, 0, 8);
      // the head, pointed at its own aim point
      var ax = fl[3][0] - fx, az = fl[3][2] - fz;
      var ayaw = Math.atan2(ax, az);
      B.paint = 'paint';
      B.boxR('plant', 0.46, 0.30, 0.20, fx, gy0 + fy, fz, 0.22, ayaw, 0, 0.02);
      B.paint = 'flat';
      B.boxR('lamp_glass', 0.40, 0.24, 0.03, fx + Math.sin(ayaw) * 0.11, gy0 + fy - 0.02,
        fz + Math.cos(ayaw) * 0.11, 0.22, ayaw, 0, 0.004);
      B.paint = 'steel';
      // and the cable snaking away to the distribution board
      B.tube('scaff', fx, gy0 + 0.02, fz, fx + Math.cos(i * 2.1) * 3.0, gy0 + 0.02,
        fz + Math.sin(i * 2.1) * 3.0, 0.012, 5);
      this.addCollider(fx, gy0 + fy * 0.5, fz, 0.28, fy * 0.5, 0.28, 'metal');
      // 98, not 15. A 1 kW site halogen throws: at 15 it delivered 0.15
      // irradiance at 10 m against the market cone practical's 0.78, i.e. it
      // was a torch. 98 at distance 34 lands 0.98 at 10 m and 0.24 at 20 m,
      // which is a flood ACROSS the shaded half rather than a puddle at its
      // own feet - and it is what models the columns in there.
      push('hr_flood_' + i, 'halogen', fx, gy0 + fy, fz, fl[4], 74.0, 34.0, 0.62,
        fl[3], { haloGain: 0.75, haloMax: 2.6, shadow: false });
    }

    // ---- lift shaft worklights ----------------------------------------------
    // Hung a metre down the shaft. They uplight the shaft mouth, which is what
    // makes the drop read as a drop rather than as a black rectangle.
    for (i = 0; i < 2; i++) {
      var sz3 = i ? 5.0 : -5.0;
      var sx3 = (LIFT_X0 + LIFT_X1) * 0.5;
      B.paint = 'steel';
      B.tube('scaff', sx3, 2.9, sz3, sx3, 1.05, sz3, 0.007, 4);
      B.paint = 'flat';
      B.cyl('lamp_glass', 0.055, 0.055, 0.13, sx3, 0.95, sz3, 0, 0, 0, 8);
      B.paint = 'steel';
      // 42, not 6.5: it is 0.95 m off the shaft mouth and its whole job is to
      // uplight the reveal so the drop reads as a drop.
      push('hr_shaft_' + i, 'tungsten', sx3, 0.95, sz3, 2700, 42.0, 13.0, 0, null,
        { haloGain: 0.8, haloMax: 2.0 });
    }

    // ---- floor 46, under the slab void --------------------------------------
    // A single lamp on the floor below. It is the only light source in the level
    // BELOW the player, so it is the only thing that gives the void depth.
    (function () {
      var vx = (VOID_X0 + VOID_X1) * 0.5 - 1.0, vz = (VOID_Z0 + VOID_Z1) * 0.5 + 1.2;
      B.paint = 'flat';
      B.cyl('lamp_glass', 0.09, 0.09, 0.20, vx, LOWER_Y + 1.30, vz, 0, 0, 0, 8);
      B.paint = 'steel';
      B.cyl('scaff', 0.020, 0.020, 1.2, vx, LOWER_Y + 0.60, vz, 0, 0, 0, 6);
      B.box('plant', 0.30, 0.03, 0.30, vx, LOWER_Y + 0.02, vz, 0.004);
      // 56, not 9: it is the ONLY source below the player and it has 4.3 m of
      // floor 46 to carry on its own. 56 / 1.3^2 = 33 at the lamp, 1.4 at 6 m.
      push('hr_below', 'tungsten', vx, LOWER_Y + 1.30, vz, 2600, 56.0, 17.0, 0, null,
        { haloGain: 0.9, haloMax: 2.4 });
    })();

    // ---- the crane cab and the site cabin -----------------------------------
    push('hr_cabin', 'tungsten', 23.0, 1.60, 14.3, 2900, 30.0, 11.0, 0, null,
      { haloGain: 0.7, haloMax: 1.8 });
    // hr_stair's LIGHT is gone - its budget bought the open-edge run, and a
    // fluorescent behind the lift bank appears in no published framing. The
    // fitting below is still built, so the escape stair is not a black hole to
    // anyone who walks into it.
    B.paint = 'flat';
    B.cyl('lamp_glass', 0.06, 0.06, 0.16, (STR_X0 + STR_X1) * 0.5, 3.20, -6.0, 0, 0, 0, 8);
    B.paint = 'steel';

    // ---- THE BUDGET, ASSERTED ----------------------------------------------
    // lighting.js takes the first MAX_PRACTICALS_RIG (24) and silently discards
    // the rest. Overflowing that is invisible in code review, invisible in
    // check.py, and costs a whole framing - so it is checked here, and if it
    // ever does overflow the tail that gets cut is the least important lamp
    // rather than whatever happened to be last in the file.
    if (lamps.length > MAX_LAMPS) {
      GAME.logError('highrise.lamps',
        new Error('published ' + lamps.length + ' practicals, cap is ' + MAX_LAMPS));
      lamps.length = MAX_LAMPS;
    }
    this.practicalLights = lamps;
    this.lampCount = lamps.length;

    // ---- volumetric shafts ---------------------------------------------------
    // lighting.js solves a shaft's axis mostly-downward, so the entries below are
    // the APERTURES light falls through, not the horizontal blades (those are
    // the key's own job and postfx's raymarch already has them).
    this.lightShafts = [
      { origin: new THREE.Vector3((DECK_X0 + DECK_X1) * 0.5 + 2.0, SOFFIT_Y + 0.4,
          (DECK_Z0 + DECK_Z1) * 0.5 + 1.5),
        dir: new THREE.Vector3(SHD_X, -1.0, SHD_Z).normalize(),
        width: 5.0, length: 5.6, strength: 1.0, kind: 'deckvoid' },
      { origin: new THREE.Vector3((LOB_X0 + LOB_X1) * 0.5, SOFFIT_Y - 0.2, CORE_Z0 - 0.4),
        dir: new THREE.Vector3(SHD_X * 0.4, -1.0, SHD_Z * 0.4).normalize(),
        width: 3.6, length: 4.4, strength: 0.7, kind: 'lobbyMouth' },
      { origin: new THREE.Vector3((LIFT_X0 + LIFT_X1) * 0.5, 1.0, -5.0),
        dir: new THREE.Vector3(0, -1, 0),
        width: 1.9, length: 6.0, strength: 0.8, kind: 'liftshaft',
        always: true, kelvin: 2700, lux: 6.0 }
    ];
  };

  // ---- merge + vertex-colour pass -----------------------------------------------
  LevelHighrise.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.slab;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      if (key === 'debris_net') {
        this.material('debris_net');
        if (!this._netOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('highrise.merge:' + key, e); continue; }
      // keepUV means the source geometry authored its own UVs (the city's
      // facades, the sheeting, the atlas cards). mergeAll drops the whole uv
      // attribute if ANY entry in the bucket lacks one, so the second clause is
      // not belt-and-braces: a single un-UV'd solid landing in a keepUV bucket
      // would otherwise hand a mapped material a geometry with no uv.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('highrise.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'highrise_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'glazing') mesh.renderOrder = 3;
      // The city and the ground are 176 m below and 470 m out. Frustum culling
      // on a single merged mesh that large is a coin flip against the bounding
      // sphere, and losing it for one frame is a hole in the world.
      if (key === 'city' || key === 'city_ground' || key === 'city_light' ||
          key === 'city_plant') {
        mesh.frustumCulled = false;
      }
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
    // The animated sheets, one mesh each - see buildSheeting.
    var mat = this.material('sheeting');
    for (var s = 0; s < this.sheets.length; s++) {
      var sh = this.sheets[s];
      if (!sh || !sh.geo) continue;
      var sm = new THREE.Mesh(sh.geo, mat);
      sm.name = 'highrise_sheet_' + s;
      sm.castShadow = false;
      sm.receiveShadow = true;
      sm.matrixAutoUpdate = false;
      sm.matrix.copy(sh.matrix);
      sm.matrixWorldNeedsUpdate = true;
      // it bellies well outside its rest bounds
      sh.geo.computeBoundingSphere();
      if (sh.geo.boundingSphere) sh.geo.boundingSphere.radius *= 1.6;
      this.root.add(sm);
      this.meshes.push(sm);
      sh.mesh = sm;
    }
  };

  // Vertex colours. On `wear` surfaces this is materials.js's WEAR MASK -
  // white = pristine, R grime, G wetness, B edge wear. On everything else it is
  // a plain albedo multiplier.
  //
  // The harbor's lesson is enforced here too: the wet channel carries ONLY what
  // the level knows and a global driver cannot, and it stays near white
  // wherever there is nothing extra to say. Double-counting a soak took the
  // harbor's apron to an effective albedo of 0.017.
  var WEAR_KEYS = { slab: 1, soffit: 1, core_wall: 1, column: 1, blockwork: 1 };

  LevelHighrise.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var Nv = pos.count;
    // The decal bucket carries a FOUR component colour. three.js turns that into
    // USE_COLOR_ALPHA, so vColor.a multiplies diffuseColor.a - which is the only
    // way a per-card opacity can exist inside one merged mesh, and therefore the
    // only way a sprayed mark can fade where the concrete is polished instead of
    // sitting on top of the noise at full strength everywhere.
    var alphaCol = (key === 'decal');
    var CS = alphaCol ? 4 : 3;
    var col = new Float32Array(Nv * CS);
    var noise = this.noise;
    var surf = SURF[key] || SURF.slab;
    var isWear = !!surf.wear;
    var vi = 0, e, i, j;

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var ta = ent.alpha === undefined ? 1 : ent.alpha;
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode = ent.paint || 'steel';
      // Force the mode to agree with the surface's shader: a multiplier written
      // into a wear mask (or the reverse) is a silent, catastrophic bug.
      if (isWear) {
        if (key === 'slab') mode = (mode === 'joint') ? 'joint' : 'slab';
        else if (key === 'soffit') mode = 'soffit';
        else if (key === 'blockwork') mode = 'block';
        else mode = 'wall';
      } else if (WEAR_KEYS[mode] || mode === 'joint') {
        mode = 'steel';
      }
      if (key === 'decal' || key === 'lamp_glass' || key === 'lamp_red' ||
          key === 'city_light') {
        mode = 'flat';
        if (key !== 'decal' && key !== 'city_light') { tr = 1; tg = 1; tb = 1; }
      } else if (key === 'city') {
        if (mode !== 'glasscity' && mode !== 'rawcity' && mode !== 'farcity') mode = 'city';
      } else if (key === 'shell') { mode = 'shell'; }
      else if (key === 'city_ground') { mode = 'cityground'; }
      else if (key === 'city_plant') { mode = 'cityplant'; }
      else if (key === 'debris_net') { mode = 'net'; }
      else if (key === 'sheeting') { mode = 'sheet'; }
      else if (key === 'glazing') { mode = 'glass'; }
      else if (key === 'mullion') { mode = 'anod'; }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var jc = (vi + i) * CS;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r, g, b;

        if (mode === 'slab' || mode === 'joint') {
          // ---- GRIME ----------------------------------------------------------
          // Slurry, saw dust and the grey film a concrete frame lives under.
          // Heaviest on the traffic lanes off the hoist and around the core.
          var lane = M.smoothstep(3.2, 0.6, Math.abs(z + 13.0)) * M.smoothstep(-27, 0, x);
          lane = Math.max(lane, M.smoothstep(3.0, 0.5, Math.abs(z - 6.0)));
          var gm = M.saturate(0.10 + 0.26 * (noise.fbm2(x * 0.13 + 2, z * 0.13 - 5, 3) * 0.5 + 0.5) +
            lane * 0.16);
          // ---- WETNESS --------------------------------------------------------
          // Rain blows in the open sides and stands in the hollows. Nowhere
          // else: this level is DRY, and a soaked slab would be the harbor.
          var dep = waterDepth(x, z, noise);
          var pud = M.saturate(dep / 0.012) * rainReach(x, z);
          var damp = M.smoothstep(-0.016, 0.001, dep) * (1 - pud) * rainReach(x, z);
          var wet = M.saturate(pud * 0.80 + damp * 0.18);
          // ---- EDGE WEAR / TROWEL POLISH --------------------------------------
          // A power float leaves burnished lanes that are the PALEST thing on a
          // slab, and they are the only reason 2200 m2 of grey has any tonal
          // structure for a 9.7-degree key to find. B brightens.
          var swirl = noise.fbm2(x * 0.30 + Math.sin(z * 0.10) * 2.0,
            z * 0.30 - Math.cos(x * 0.09) * 2.0, 3) * 0.5 + 0.5;
          var pol = M.saturate(M.smoothstep(0.46, 0.86, swirl) * 0.62 +
            M.smoothstep(2.4, 0.2, Math.abs(z + 13.0)) * 0.22 + lane * 0.24);
          pol *= 1 - pud * 0.8;
          // ---- POUR BAYS, AND WHY THEY ARE THE POINT --------------------------
          // Measured on lv_overview: the slab top's high-frequency detail came
          // back at hf/mean 0.0599 against 0.29 for the same material at close
          // range, and analyze reported flat_area 24.7% on the establishing
          // frame against 11.0% on hero1. At 69 m the slab's world-UV repeat
          // resolves below the mip and 2200 m2 of power float mips to a plane at
          // sRGB 86 with an rms of 5.2 - i.e. the largest object in the level's
          // establishing photograph is a flat card.
          //
          // A normal map cannot fix that; nothing at texel scale can. What
          // survives mipping is MACRO variation, and a real slab has exactly the
          // right one: it is placed bay by bay on different days out of
          // different batches, and adjacent bays differ by 10-15% in tone with a
          // hard edge along the day joint. Keyed to JOINT_PITCH and to the same
          // phase as jointDip, so the tone step lands ON the saw cut rather than
          // across the middle of a bay.
          var pbx = Math.floor((x + 3.0) / JOINT_PITCH);
          var pbz = Math.floor((z + 2.0) / JOINT_PITCH);
          var pbh = Math.sin(pbx * 12.9898 + pbz * 78.233) * 43758.5453;
          pbh -= Math.floor(pbh);
          var upF = M.saturate(ny);
          // +/-20% per bay, plus a slow 17 m drift across the whole pour so the
          // bays themselves are not a uniform checkerboard. Both are MACRO and
          // both survive the mip; the map underneath does not, which is the
          // whole reason they exist.
          gm = M.saturate(gm + ((pbh - 0.5) * 0.40 +
            (noise.fbm2(x * 0.059 + 11, z * 0.059 - 4, 2) * 0.5 + 0.5 - 0.5) * 0.30) * upF);
          // ---- and the saw-cut grid as a STAIN as well as a dip ---------------
          // The 22 mm geometric dip is sub-pixel past about 40 m. A 1.1 m band of
          // trapped grime either side of every cut is not, and it is what keeps
          // the bay grid legible when the dip has mipped away.
          var jga = Math.abs(((x + 3.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5);
          var jgb = Math.abs(((z + 2.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5);
          gm = M.saturate(gm + M.smoothstep(0.55, 0.02, Math.min(jga, jgb)) * 0.20 * upF);
          if (mode === 'joint') { gm = M.saturate(gm + 0.36); wet = M.saturate(wet * 0.4 + 0.30); pol *= 0.3; }
          r = 1 - gm * 0.66; g = 1 - wet; b = 1 - pol;
          // ---- THE SLAB EDGE, WHICH IS NOT A FLOOR ---------------------------
          // Everything above describes a power-floated top surface. The same
          // bucket also carries 176 m of fascia - the 340 mm slab edge and the
          // 700 mm perimeter edge beam - which is a FORMED face, seen against
          // the sky from every framing that looks over, and it shipped with no
          // board marks, no tie-hole plugs and no drips. It gets its own story.
          if (upF < 0.40 && y < -0.04) {
            var fau = (Math.abs(nx) > Math.abs(nz)) ? z : x;
            // 200 mm formwork boards, and the grout line under every one
            var fbrd = Math.abs(((y + 0.10) % 0.20 + 0.20) % 0.20 - 0.10);
            var fbd = M.smoothstep(0.018, 0.0, fbrd);
            // form-tie plugs on a 600 mm grid, always a different colour
            var ftu = Math.abs(((fau + 0.3) % 0.60 + 0.60) % 0.60 - 0.30);
            var ftv = Math.abs(((y + 0.32) % 0.60 + 0.60) % 0.60 - 0.30);
            var ftie = M.smoothstep(0.052, 0.014, Math.sqrt(ftu * ftu + ftv * ftv));
            // and the run-off staining in the 400 mm under the pour joint
            var fdrip = M.smoothstep(0.40, 0.02, Math.abs(y + 0.40)) *
              M.smoothstep(0.34, 0.86, noise.fbm2(fau * 2.7 + 4.0, y * 0.6, 2) * 0.5 + 0.5);
            var ffg = M.saturate(gm * 0.72 + fbd * 0.16 + ftie * 0.22 + fdrip * 0.34);
            r = 1 - ffg * 0.62;
            g = 1;
            b = 1 - M.saturate(fbd * 0.20 + ftie * 0.28);
          }
        } else if (mode === 'soffit') {
          // A soffit is DARKER than its floor: it never sees the sky, it holds
          // the form release agent, and it stains from every penetration. It is
          // also the top third of every framing, so its value is what keeps
          // vertical_imbalance under control.
          //
          // The map's uv went from 0.38 to 0.98 to stop the blowholes reading at
          // 5-10 cm; the macro story it used to carry by accident now has to be
          // authored HERE, at a scale that is actually a metre rather than a
          // texture repeat. That is the correct division of labour: the map
          // supplies millimetres, the wear mask supplies metres.
          var down = M.saturate(-ny);
          var gs = M.saturate(0.20 + 0.30 * (noise.fbm3(x * 0.24, y * 0.5, z * 0.24, 3) * 0.5 + 0.5) +
            down * 0.14);
          // form-face blotching: ply that had been used four times
          gs += M.smoothstep(0.58, 0.92, noise.fbm2(x * 0.55 + 9, z * 0.55 - 3, 2) * 0.5 + 0.5) * 0.16;
          // the 1.22 m plywood sheet grid, as a stain rather than as geometry:
          // grout bleeds through every joint in the formwork and leaves a line
          var jx2 = Math.abs(((x + 0.6) % 1.22 + 1.22) % 1.22 - 0.61);
          var jz2 = Math.abs(((z + 0.2) % 1.22 + 1.22) % 1.22 - 0.61);
          gs += M.smoothstep(0.055, 0.0, Math.min(jx2, jz2)) * 0.14 * down;
          var es = M.smoothstep(0.62, 0.94, noise.fbm3(x * 0.9, y * 0.8, z * 0.9, 2) * 0.5 + 0.5) * 0.20;
          // 0.46, not 0.62. The soffit is the top third of every framing and it
          // never sees the sky; darkening its albedo by up to 62% on top of a
          // 0.24 base put it at 0.041 linear, i.e. it was the reason the frame
          // had a black lid on it. A soffit is darker than its floor. It is not
          // four times darker.
          r = 1 - M.saturate(gs) * 0.38; g = 1; b = 1 - es;
          // ---- THE OTHER SIDE OF THE SLAB, WHICH IS NOT A SOFFIT ------------
          // This bucket carries floor 48's whole plate, and from the
          // ESTABLISHING camera - which stands 14 m up and looks DOWN - what is
          // on screen is its TOP: 2200 m2 of raw construction deck painted with
          // a formed-underside story and mipped, at 69 m, to a plane. That is
          // most of why the tower photographs as a floating white layer cake
          // with flat_area 24.7% against hero1's 11.0%.
          //
          // A deck that has been rained on and walked over for a month is not a
          // fair-faced soffit: it takes the same pour-bay macro variation and
          // the same saw-cut grid as the working slab, which is the only detail
          // that survives at that range, plus the general filth of an unfinished
          // floor with no roof.
          var upS = M.saturate(ny);
          if (upS > 0.35) {
            var sbx = Math.floor((x + 3.0) / JOINT_PITCH);
            var sbz = Math.floor((z + 2.0) / JOINT_PITCH);
            var sbh = Math.sin(sbx * 12.9898 + sbz * 78.233) * 43758.5453;
            sbh -= Math.floor(sbh);
            var sja = Math.abs(((x + 3.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5);
            var sjb = Math.abs(((z + 2.0) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5);
            var deck = M.saturate(0.28 + (sbh - 0.5) * 0.44 +
              M.smoothstep(0.55, 0.02, Math.min(sja, sjb)) * 0.24 +
              (noise.fbm2(x * 0.09 - 6, z * 0.09 + 4, 3) * 0.5 + 0.5) * 0.30 +
              (noise.fbm2(x * 0.055 + 3, z * 0.055 - 9, 2) * 0.5) * 0.34);
            r = M.lerp(r, 1 - deck * 0.60, upS);
            b = M.lerp(b, 1 - M.smoothstep(0.50, 0.86,
              noise.fbm2(x * 0.34 + 2, z * 0.34 - 8, 3) * 0.5 + 0.5) * 0.34, upS);
          }
          // ---- and the perimeter edge beam, which is a formed FASCIA ---------
          // Same reasoning as the working slab's own edge: it is seen against
          // the sky from every framing that looks at the building, and it
          // shipped with no board marks and no tie holes.
          var sideS = M.saturate(1 - Math.abs(ny));
          if (sideS > 0.55) {
            var fauS = (Math.abs(nx) > Math.abs(nz)) ? z : x;
            var fbS = M.smoothstep(0.018, 0.0,
              Math.abs(((y + 0.10) % 0.20 + 0.20) % 0.20 - 0.10));
            var ftS = M.smoothstep(0.052, 0.014, Math.sqrt(
              Math.pow(Math.abs(((fauS + 0.3) % 0.60 + 0.60) % 0.60 - 0.30), 2) +
              Math.pow(Math.abs(((y + 0.32) % 0.60 + 0.60) % 0.60 - 0.30), 2)));
            r = M.lerp(r, 1 - M.saturate(gs * 0.7 + fbS * 0.16 + ftS * 0.22) * 0.58, sideS);
            b = M.lerp(b, 1 - M.saturate(fbS * 0.20 + ftS * 0.26), sideS);
          }
        } else if (mode === 'wall') {
          // Shear walls and columns. Lift lines, honeycombing at the base, and
          // the grey film that climbs the first metre off the floor.
          var gw = M.saturate(0.12 + 0.26 * (noise.fbm3(x * 0.34, y * 0.34, z * 0.34, 3) * 0.5 + 0.5));
          gw += M.smoothstep(1.1, 0.02, y) * 0.24;                 // splash zone
          gw += M.smoothstep(0.55, 0.92, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 1.9,
            y * 0.16, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny)) * 0.20;
          // ---- POUR LIFT LINES, every 1.2 m ------------------------------------
          // A wall is poured in lifts and every lift leaves a horizontal seam
          // where the top of one pour met the bottom of the next: a dark line
          // with a pale bleed under it. This is the strongest horizontal on a
          // concrete wall and it is the thing that gives a 4 m surface scale.
          var lift = Math.abs((y % 1.20 + 1.20) % 1.20 - 0.60);
          var side = M.saturate(1 - Math.abs(ny));
          gw += M.smoothstep(0.035, 0.0, lift) * 0.17 * side;
          // ---- FORM-TIE HOLES, on a 600 mm grid --------------------------------
          // Plugged, and the plug is always a different colour from the wall.
          var tu = Math.abs((((Math.abs(nx) > Math.abs(nz) ? z : x) + 0.3) % 0.60 + 0.60) % 0.60 - 0.30);
          var tv = Math.abs(((y + 0.15) % 0.60 + 0.60) % 0.60 - 0.30);
          var tie = M.smoothstep(0.045, 0.012, Math.sqrt(tu * tu + tv * tv));
          gw += tie * 0.22 * side;
          var ew = M.smoothstep(0.66, 0.95, noise.fbm3(x * 1.1, y * 0.9, z * 1.1, 2) * 0.5 + 0.5) * 0.26;
          ew += M.saturate(ny) * 0.10;                             // arrises catch the light
          ew += tie * 0.18 * side;                                 // the plug is proud
          // ---- THE CHAMFER FACET, PAINTED --------------------------------------
          // chamfPrism builds a real eighth face down every column and bevelBox
          // leaves a narrow diagonal band on every wall corner, and until now both
          // carried exactly the same wear value as the two faces they sit between -
          // so geometrically there was a facet and photographically there was not.
          // A vertical chamfer's normal has |nx| ~ |nz| ~ 0.707 while a flat face
          // has one of them at zero, so min(|nx|,|nz|) isolates it exactly.
          //
          // What is on a real arris: no laitance (the fines run off it), the
          // aggregate showing pale through, and the knocks of everything that has
          // been carried past. So the grime comes OFF and the edge wear goes UP,
          // which is what puts a hard bright line down one side of every column
          // and a dark one down the other at a 9-degree key.
          var diagF = M.smoothstep(0.42, 0.66, Math.min(Math.abs(nx), Math.abs(nz))) *
            M.saturate(1 - Math.abs(ny) * 1.6);
          gw *= 1 - diagF * 0.55;
          ew += diagF * 0.52;
          // 0.50, not 0.62 - see the soffit note. The core walls are the whole
          // right-hand half of the `interior` framing and they measured 0.096
          // linear with the pits in them at 0.02.
          r = 1 - M.saturate(gw) * 0.50; g = 1; b = 1 - M.saturate(ew);
        } else if (mode === 'block') {
          var gb = M.saturate(0.14 + 0.30 * (noise.fbm3(x * 0.8, y * 0.8, z * 0.8, 3) * 0.5 + 0.5));
          r = 1 - gb * 0.55; g = 1; b = 1 - M.saturate(ny) * 0.22;
        } else if (mode === 'ply') {
          // Site timber: sun-bleached on the up faces, mud-grey at the bottom,
          // with the odd sheet still fresh.
          var f5 = 0.86 + (noise.fbm3(x * 0.6, y * 0.5, z * 0.6, 3) * 0.5 + 0.5) * 0.38;
          f5 *= 1 - M.smoothstep(0.9, 0.02, y) * 0.24;
          if (ny > 0.5) f5 *= 1.10;
          r = f5 * 1.03; g = f5 * 0.99; b = f5 * 0.90;
        } else if (mode === 'glass') {
          // ---- THE CURTAIN WALL ------------------------------------------------
          // Glazing seen against a sun 0.3 degrees under the horizon. The
          // material carries the Fresnel and the environment reflection; what
          // THIS file knows, and the material cannot, is that the sky it is
          // reflecting is a sunset and that the gradient runs vertically. The
          // multiplier therefore ramps warm toward the head and cool toward the
          // sill, which is what a real glass wall does at this hour.
          var hgt = M.saturate((y - CW_SILL) / Math.max(0.3, CW_HEAD - CW_SILL));
          // ---- THE REFLECTED HORIZON IS A BAND, NOT A RAMP ---------------------
          // THE BLANK-RECTANGLE BUG, SOLVED FROM THE MIRROR GEOMETRY. The old
          // pass ramped the pane's value monotonically warm toward the head, so
          // the top two thirds of every light was one continuous pale wash with
          // nothing above it and nothing below it to read against - measured on
          // hero2 as a run of flat cream rectangles with lines ruled on them.
          //
          // A vertical mirror preserves the vertical slope of the ray, so the sky
          // elevation a viewer sees at pane height hp is atan((hp - he)/d). At a
          // 10 m standoff from an eye at 1.70 the glow band at 3-9 degrees of
          // elevation lands between 2.22 and 3.28 m of pane, and the vision glass
          // runs 1.15-2.89: the burning band therefore occupies the UPPER THIRD of
          // the light and nothing else. Above it the pane reflects the (now cool)
          // upper dome; below it, the dark city and its own soffit. One narrow
          // warm band with cool above and dark below is not only what the geometry
          // says, it is the only version that has internal structure - which is
          // exactly what a rectangle needs in order to stop being blank.
          var glow = M.smoothstep(0.42, 0.64, hgt) * (1 - M.smoothstep(0.71, 0.90, hgt));
          // The film / dust value, heaviest at the sill where it collects.
          var dirt = 0.44 + 0.18 * (1 - hgt);
          // ---- panel-to-panel variation -----------------------------------
          // Sampled at the BAY pitch rather than smoothly, because the thing
          // that makes a curtain wall read as a curtain wall is that adjacent
          // lights differ - different coating batch, different amount of
          // installation film still on, different room behind. At a smooth 0.30
          // the run photographed as one continuous cream light box with lines
          // ruled on it.
          var bay = Math.floor((Math.abs(nx) > Math.abs(nz) ? z : x) / CW_PITCH);
          var pn = (Math.sin(bay * 12.9898) * 43758.5453) % 1;
          if (pn < 0) pn += 1;
          dirt *= 0.74 + pn * 0.48;
          // A LATERAL gradient as well as a vertical one. The sunset is a
          // BAND on one bearing, not a dome: the reflection in a west-facing
          // pane is brightest where the pane faces the glow and falls away
          // along the run, and that lateral ramp is what turns a row of panes
          // into a wall that is reflecting something. Without it the vertical
          // ramp alone repeats identically on every light in the run.
          var along = (Math.abs(nx) > Math.abs(nz)) ? z : x;
          var lat = M.saturate((along - CW_SOUTH_X0) / 48.0);
          dirt *= 0.88 + 0.24 * (1 - lat);
          // The body is COOL (B > G > R, the low-e tint); only the reflected
          // horizon band is warm, and it lifts the value by 1.8x rather than
          // washing the whole light.
          var lift = dirt * (1.0 + glow * 0.80);
          r = lift * (0.82 + glow * 0.34);
          g = lift * 0.97;
          b = lift * (1.18 - glow * 0.36);
        } else if (mode === 'anod') {
          // Anodised dark-bronze mullion. Deliberately NEUTRAL and dark: the
          // generic 'paint' path pushed rust into the red channel and the run
          // photographed as mid-brown timber rather than as a metal extrusion.
          // The only thing that makes an extrusion read as an extrusion is a
          // hard specular line down its full length, and a rust bloom kills it.
          var fa = 0.90 + (noise.fbm3(x * 0.6, y * 0.55, z * 0.6, 2) * 0.5 + 0.5) * 0.20;
          // the proud pressure-plate catches the sky and is a shade lighter
          fa *= 1 + M.saturate(ny) * 0.10;
          r = fa * 0.99; g = fa * 1.00; b = fa * 1.03;
        } else if (mode === 'sheet') {
          // Polythene. Backlit, so the multiplier is high and warm where the sun
          // is behind it, and the creases are baked in as value.
          var cr = noise.fbm2(x * 2.6, y * 2.2, 3) * 0.5 + 0.5;
          var lift = 1.25 + M.smoothstep(0.35, 0.9, cr) * 0.55;
          var glow = sunlitSlab(x, z);
          r = lift * (1.0 + glow * 0.42);
          g = lift * (0.97 + glow * 0.26);
          b = lift * (0.94 + glow * 0.05);
        } else if (mode === 'net') {
          // Orange debris netting. Saturated - it is the only chromatic thing
          // on the floor - but NOT bright: at 1.18 the panels photographed as
          // luminous white rectangles hung on the facade, which is the single
          // loudest wrong note in an establishing frame made of concrete.
          var nv = 0.54 + (noise.fbm2(x * 1.2, y * 1.2, 2) * 0.5 + 0.5) * 0.24;
          r = nv * 1.10; g = nv * 0.62; b = nv * 0.40;
        } else if (mode === 'city' || mode === 'glasscity' || mode === 'rawcity' ||
                   mode === 'farcity') {
          // ---- AERIAL PERSPECTIVE, in the albedo --------------------------------
          // The fog does the atmosphere. What it cannot do is make a distant
          // block DIFFERENT from a near one in value and chroma before the fog
          // even runs, and without that the city is one material seen through
          // varying amounts of grey. So: value falls with distance, chroma falls
          // with distance, and every block gets its own concrete/glass tint.
          var rr = Math.sqrt(x * x + z * z);
          var far = M.saturate(rr / CITY_R);
          var vv = 0.64 + (noise.fbm2(x * 0.012 + 3.0, z * 0.012 - 7.0, 2) * 0.5 + 0.5) * 0.40;
          // ---- THE SUNSET, IN THE ALBEDO ---------------------------------
          // Geometry says a face on the sun's bearing takes cos(8.8) = 0.99 of
          // the key and the adjacent face takes 0, i.e. a 6:1 split. Measured on
          // the real frames it was 1.10-1.32:1, because the runtime key delivers
          // only 6-9% of the city's radiance from 176 m up through haze. A
          // directional term the fog can halve is not a sunset on a city.
          //
          // So it is baked. `lam` is the horizontal lambert against the sun's
          // own bearing, computed off the face normal, and it drives a 4.3:1
          // multiplier that the haze can only compress, never erase. The
          // distance attenuation the previous pass applied to it (1 - far*0.55)
          // is gone: aerial perspective is the fog's job, and killing the face
          // split at range is precisely what made the far city one flat card.
          var hlen = Math.sqrt(nx * nx + nz * nz);
          var lam = hlen > 0.15 ? M.saturate((nx * SUN_X + nz * SUN_Z) / hlen) : 0;
          var shade = hlen > 0.15 ? M.saturate(-(nx * SUN_X + nz * SUN_Z) / hlen) : 0;
          // 0.55 shaded -> 1.60 sunward, i.e. a 2.9:1 albedo split which the
          // runtime key and the reflected sky then widen toward the 3:1 a
          // skyline needs. Measured at a first attempt of 0.36 -> 1.55 the
          // SHADED faces (which is what two of the four published framings are
          // looking at) went to 0.29 of albedo after the depth ramp and the city
          // read as black towers with white confetti on them - the emissive
          // windows outvalued their own facades. A face split is a RATIO; making
          // the dark end darker buys the ratio at the cost of the picture.
          // ---- A ROOF IS THE DARKEST SURFACE IN A CITY -----------------------
          // It was 0.78, i.e. brighter than a shaded facade, on the theory that
          // roof membrane is pale. Two things were wrong with that. Geometrically
          // a horizontal plane takes sin(9.2) = 0.16 of a 9-degree key, which is a
          // THIRD of what a vertical face on the sun's bearing takes, not one and
          // a half times a shaded one. And materially a commercial roof is
          // bitumen, ballast and grey gravel at an albedo of 0.10-0.15 - it is the
          // darkest large surface in any city, which is why every aerial
          // photograph of a downtown is dark roofs separated by bright streets.
          //
          // It only became visible when the fog density was fixed (see the
          // setFog note): before that, everything past 200 m was half inscatter
          // and no roof resolved at all. hero3 looks DOWN at a hundred of them,
          // and at 0.78 they photographed as pale flat cards floating between the
          // towers - the one thing that could make a city seen from 176 m up read
          // as a model. At 0.38 the roofs go dark, the lit facades and the street
          // lighting become the bright notes, and the plan of the city reads.
          var keyMul = M.lerp(0.55, 1.60, lam);
          keyMul = M.lerp(keyMul, 0.38, M.saturate(Math.abs(ny)));
          vv *= keyMul;
          if (mode === 'glasscity') {
            // A fully glazed tower is a MIRROR of the sunset: its lit faces are
            // the brightest thing below the horizon line. "Brightest below the
            // horizon" is not "brighter than the sky" though - at x1.35 it
            // printed as a white slab with a grid on it and out-valued the
            // horizon band it was supposed to be reflecting.
            vv *= 1.0 + lam * 0.85;
            r = vv * (1.14 + lam * 0.34); g = vv * (0.95 + lam * 0.06); b = vv * (0.90 - lam * 0.20);
          } else if (mode === 'rawcity') {
            vv *= 0.80;
            r = vv * 1.02; g = vv * 1.00; b = vv * 0.98;
          } else if (mode === 'farcity') {
            // The rim rings sit under 64-80% haze, so only a fifth to a third of
            // their albedo ever reaches the lens. At 0.58 they contributed
            // nothing at all and the band between the modelled city and the
            // horizon photographed as an empty dark shelf. PALE and cool is what
            // a hazed skyline actually is, and it is the value step that makes
            // the near city read as near.
            vv *= 1.30;
            r = vv * 0.98; g = vv * 1.00; b = vv * 1.08;
          } else {
            // ---- WHERE THE DISTRICT USED TO BE -------------------------------
            // The albedo family is no longer decided here. It is chosen ONCE PER
            // BUILDING in cityBlock() off the level's rng and carried in the
            // entry tint, which is the only way a whole tower can belong to one
            // material: the spatial hash this replaced was sampled per vertex on
            // an 84 m cell, so a 40 m block straddling a cell boundary was cut
            // into two materials down an invisible seam, and every neighbour
            // within 84 m shared its family anyway.
            //
            // What is left here is the sun, which the tint must not carry
            // because it is per-FACE and the tint is per-entry.
            r = vv * (1.06 + lam * 0.20 - shade * 0.06);
            g = vv * (1.00 - shade * 0.01);
            b = vv * (0.92 - lam * 0.12 + shade * 0.20);
          }
          // and a slow desaturation toward the rim so the far city is one value.
          // 0.34, not 0.55: the fog's own `desaturate` went up to 0.34 this
          // round and doing it twice is what left the near city grey.
          var mix = far * 0.34;
          var lum = (r + g + b) / 3;
          r = M.lerp(r, lum, mix); g = M.lerp(g, lum, mix); b = M.lerp(b, lum, mix);
          // ---- THE VALUE RAMP THAT IS AERIAL PERSPECTIVE ---------------------
          // Measured on the first cut: near, mid and far bands all sat at 0.47
          // background median - there was no value separation between depth
          // layers at all, and value separation between layers IS what aerial
          // perspective is. The fog cannot supply it on its own because it
          // multiplies toward one colour; the albedo has to start lower at the
          // near end so the fog has something to lift.
          // 0.80 -> 1.06 rather than 0.64 -> 1.04. That ramp existed to give the
          // 0.80 fog cap something to lift; at a 0.52 cap it was simply throwing
          // 36% of the NEAR city's radiance away - and the near city, the band
          // 100-250 m below the open edge, is the part of this level a critic
          // crops at 3.5x and finds a flat brown card.
          var depth = M.saturate((rr - 90) / (CITY_R - 90));
          var dep2 = 0.80 + depth * 0.26;
          r *= dep2; g *= dep2; b *= dep2;
          // never let a roof go to nothing - a black city under a bright sky is
          // a silhouette, not a city
          var up = M.saturate(ny);
          r += up * 0.08; g += up * 0.08; b += up * 0.10;
        } else if (mode === 'shell') {
          // Our own tower. Same map, but it is 20 m away rather than 300, so it
          // keeps its value and gets the strong directional read the sun gives a
          // glass box at this hour.
          // Normalised against the sun's HORIZONTAL bearing, and driven to the
          // same 4:1 face split the city now carries. hero3 looks straight down
          // this surface for 176 m; if its west elevation and its north
          // elevation sit within 1.1x of each other there is no sunset on the
          // one building the level is named after.
          var hlS = Math.sqrt(nx * nx + nz * nz);
          var lamS = hlS > 0.15 ? M.saturate((nx * SUN_X + nz * SUN_Z) / hlS) : 0;
          var vs = 0.78 + (noise.fbm2(x * 0.05, y * 0.02, 2) * 0.5 + 0.5) * 0.30;
          vs *= M.lerp(0.52, 1.62, lamS);
          // the streaking every tall building has under its floor bands
          vs *= 1 - M.smoothstep(0.62, 0.95,
            noise.fbm2(x * 0.9 + z * 0.9, y * 0.055, 3) * 0.5 + 0.5) * 0.22;
          r = vs * (1.10 + lamS * 0.30); g = vs * 0.99; b = vs * (0.90 - lamS * 0.14);
        } else if (mode === 'cityground') {
          // ---- THE STREET PLANE ------------------------------------------------
          // It has to sit BELOW the building faces in value. In the first cut the
          // plate was brighter than the blocks standing on it, which inverts the
          // depth read the city albedo was deliberately darkened to preserve and
          // is why the tower photographed as standing in a snowfield. The map
          // now carries the roads, so this is only value and a little chroma.
          var rg2 = Math.sqrt(x * x + z * z);
          var vg = 0.60 + (noise.fbm2(x * 0.0022 + 5, z * 0.0022 - 2, 3) * 0.5 + 0.5) * 0.34;
          vg += (noise.fbm2(x * 0.011 - 3, z * 0.011 + 8, 2) * 0.5 + 0.5) * 0.14;
          // ---- THE OUTSKIRTS -----------------------------------------------
          // Past the modelled blocks the plate is bare road texture on dark
          // tarmac albedo, and with the fog cap down from 0.80 to 0.52 it no
          // longer gets rescued by inscatter: the band between the last tower
          // and the ridge went from "hazed" to a dead shelf across the full
          // frame width. Low-rise suburbia under a sunset is PALE - roofs,
          // yards, car parks, dust - so the albedo climbs from the moment the
          // modelled city stops.
          var subs = M.smoothstep(300, 620, rg2);
          // 0.72, not 1.15 - and the hills below the same. Both numbers were
          // compensation for a haze layer that has since been fixed (see the
          // density note in setFog): at the old effective density everything past
          // 250 m sat AT the 0.52 opacity cap, so less than half of any albedo out
          // there survived and the outskirts had to be painted six times too
          // bright to register at all. With a correct layer the same ground keeps
          // 62-74% of itself, and 6.2x albedo photographed as a pale checkered
          // plateau behind the towers - measured on hero3, where it was the only
          // flat untextured surface left in the frame.
          vg *= 1 + subs * 0.72;
          // ---- the far hills ---------------------------------------------------
          // Ground, not city, and MUCH paler. The fog colour looking below the
          // horizon away from the sun measured 0.0066 linear - effectively
          // black - so at an 80% cap only a fifth of the surface survives, and a
          // dark asphalt albedo out there renders as a void whatever the fog
          // does. Distant land under haze is pale and cool; taking the albedo up
          // by a factor of three is what makes the band between the city and the
          // rim read as terrain instead of as nothing.
          var hill = M.smoothstep(380, 700, rg2);
          vg *= 1 + hill * 0.95;
          // and pushed further toward blue as it goes: land 500 m away and 100 m
          // below you, on the far side of the sky from a 9-degree sun, is lit by
          // nothing but the blue half of the dome. That chroma shift is what makes
          // it read as distance now that opacity is no longer doing the work.
          r = vg * (1.00 - hill * 0.22); g = vg * (0.99 - hill * 0.04);
          b = vg * (0.94 + hill * 0.42);
        } else if (mode === 'cityplant') {
          // ---- ROOF DECKS, PARAPETS, PLANT AND DUCTWORK ----------------------
          // This bucket now carries the roof DECK of every building in the city
          // (see cityBlock's deck()), not just the boxes standing on it, and a
          // deck is a completely different surface from a plant room's flank.
          //
          // A commercial roof is bitumen, ballast and grey gravel at an albedo of
          // 0.10-0.15: it is the darkest large surface in any city, and it takes
          // sin(9.2) = 0.16 of a 9-degree key against the 0.99 a vertical face on
          // the sun's bearing takes. That is a factor of six, and it is the whole
          // reason an aerial photograph of a downtown reads as dark roofs
          // separated by bright streets. The old branch gave a horizontal surface
          // 0.62-0.98 - brighter than a shaded facade - which is exactly what made
          // a hundred roofs photograph as pale flat cards floating between the
          // towers, i.e. as a model.
          var vp = 0.62 + (noise.fbm2(x * 0.03 + 5, z * 0.03 - 2, 3) * 0.5 + 0.5) * 0.36;
          var lamG = M.saturate(nx * SUN_X + nz * SUN_Z);
          vp *= 1 + lamG * 0.45;
          var upP = M.saturate(ny);
          vp *= M.lerp(1.0, 0.42, upP);
          // and the same aerial value ramp the facades carry, so a roof 400 m out
          // is not the same value as one 120 m out
          vp *= 0.84 + 0.24 * M.saturate((Math.sqrt(x * x + z * z) - 90) / (CITY_R - 90));
          r = vp * (1.06 + lamG * 0.30); g = vp * 0.98; b = vp * (0.94 - lamG * 0.14);
          // never let a deck go to nothing - a black roof under a bright sky is a
          // hole, and 176 m up they are a third of the frame
          r += upP * 0.05; g += upP * 0.05; b += upP * 0.065;
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else {
          // 'steel' / 'paint' / 'deck': structural and site metalwork. Value
          // variation, rust blooming out of every joint, road film up the first
          // metre. Wet steel is darker in albedo; this level is dry, so the
          // value comes off the grime instead.
          var f4 = 0.82 + (noise.fbm3(x * 0.32, y * 0.30, z * 0.32, 3) * 0.5 + 0.5) * 0.36;
          var rs = M.smoothstep(0.56, 0.94, noise.fbm3(x * 0.9 + 3, y * 0.75, z * 0.9 - 4, 3) * 0.5 + 0.5);
          if (mode === 'paint' || mode === 'deck') rs *= 0.30;
          f4 *= 1 - M.smoothstep(1.0, 0.02, y) * 0.22;
          r = f4 * (1 + rs * 0.42);
          g = f4 * (1 - rs * 0.05);
          b = f4 * (1 - rs * 0.40);
          if (mode === 'deck') { r *= 0.96; b *= 1.08; }
        }

        if (isWear) {
          col[jc] = M.saturate(r); col[jc + 1] = M.saturate(g); col[jc + 2] = M.saturate(b);
        } else {
          col[jc] = r * tr * dk; col[jc + 1] = g * tg * dk; col[jc + 2] = b * tb * dk;
        }
        if (alphaCol) col[jc + 3] = ta;
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, CS));
  };

  // ---- walkable surfaces ---------------------------------------------------------
  LevelHighrise.prototype.sampleGround = function (x, z) {
    // outside the frame there is 176 m of air and then a street
    if (x < X0 || x > X1 || z < Z0 || z > Z1) return CITY_Y;
    // the slab void and the two lift shafts drop to floor 46 / to nothing
    if (x > VOID_X0 && x < VOID_X1 && z > VOID_Z0 && z < VOID_Z1) return LOWER_Y;
    if (x > LIFT_X0 && x < LIFT_X1 &&
        ((z > CORE_ZI0 && z < -0.40) || (z > 0.40 && z < CORE_ZI1))) return LOWER_Y - 22;
    return plateY(x, z, this.noise);
  };

  LevelHighrise.prototype._walkRects = function () {
    var R = [{ x0: X0 + 0.5, x1: X1 - 0.5, z0: Z0 + 0.5, z1: Z1 - 0.5, plate: true }];
    // Floor 46, under the void, reachable by the temporary stair. Clamped to the
    // slab that is ACTUALLY down there (26 x 24 centred on the void, see
    // buildPlate) rather than to a guessed rectangle - the old numbers ran a
    // metre and a half past the east and north edges of it, which is walkable
    // ground published over thin air.
    var lcx = (VOID_X0 + VOID_X1) * 0.5 - 2, lcz = (VOID_Z0 + VOID_Z1) * 0.5 + 1;
    R.push({ x0: lcx - 12.4, x1: lcx + 12.4, z0: lcz - 11.4, z1: lcz + 11.4, y: LOWER_Y });
    return R;
  };

  LevelHighrise.prototype._buildNav = function () {
    var cell = 0.65;
    var ox = X0 - 1, oz = Z0 - 1;
    var w = Math.ceil((X1 + 2 - ox) / cell);
    var h = Math.ceil((Z1 + 2 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var R = this._walkRects();
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      if (ce.y - he.y > SOFFIT_Y || ce.y + he.y < LOWER_Y - 1) continue;
      obst.push([ce.x - he.x - 0.30, ce.x + he.x + 0.30, ce.z - he.z - 0.30, ce.z + he.z + 0.30,
        ce.y - he.y, ce.y + he.y]);
    }
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var y = -1e9;
        for (var r = 0; r < R.length; r++) {
          var q = R[r];
          if (x < q.x0 || x > q.x1 || z < q.z0 || z > q.z1) continue;
          var ry = q.plate ? this.sampleGround(x, z) : q.y;
          if (ry < LOWER_Y - 1) continue;              // an open shaft is not floor
          if (ry > y) y = ry;
        }
        if (y < -1e8) continue;
        // ---- THE PLATE POLYGON, ENFORCED --------------------------------------
        // A cell whose CENTRE is off the plate, in the slab void or in a lift
        // shaft is not walkable, full stop. lv_firefight photographed a complete
        // soldier silhouette floating in mid air beyond the north slab edge with
        // no floor under him, and the chain that produced him starts here: the
        // scenario asks navGrid.at() whether a squad position stands up, and
        // anything this grid says yes to had better be concrete. Rechecked
        // explicitly rather than relying on the rect list, because the rects are
        // a convenience and this is the contract.
        var onPlate = (x > X0 + 0.45 && x < X1 - 0.45 && z > Z0 + 0.45 && z < Z1 - 0.45);
        var inVoid = (x > VOID_X0 - 0.2 && x < VOID_X1 + 0.2 &&
                      z > VOID_Z0 - 0.2 && z < VOID_Z1 + 0.2);
        var inShaft = (x > LIFT_X0 - 0.2 && x < LIFT_X1 + 0.2 &&
                       ((z > CORE_ZI0 - 0.2 && z < -0.30) || (z > 0.30 && z < CORE_ZI1 + 0.2)));
        var lowerOk = (y < LOWER_Y + 0.5 && y > LOWER_Y - 0.5);
        var ok = 1;
        if (lowerOk) {
          // floor 46: the slab under the void, and nothing outside it
          if (Math.abs(x - ((VOID_X0 + VOID_X1) * 0.5 - 2)) > 12.4 ||
              Math.abs(z - ((VOID_Z0 + VOID_Z1) * 0.5 + 1)) > 11.4) ok = 0;
        } else if (!onPlate || inVoid || inShaft) {
          ok = 0;
        } else if (Math.abs(y - PLATE_Y) > 0.35) {
          // the slab dips by at most 80 mm; anything further off is not the slab
          ok = 0;
        }
        for (i = 0; ok && i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          if (o[5] > y + 0.35 && o[4] < y + 1.75) { ok = 0; break; }
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

  LevelHighrise.prototype._buildSpawns = function () {
    var self = this;
    var MIN_SEP = 1.45;              // a character is ~0.62 m across the shoulders
    var rejected = 0;
    function sp(x, z, yaw) {
      // ---- REJECT ANYTHING NOT ON THE SLAB ----------------------------------
      // Two failures were photographed off this list: a figure standing over the
      // void with no floor under him, and two enemies interpenetrating at the
      // same yaw. Both are cheap to make impossible.
      var y = self.sampleGround(x, z);
      if (!isFinite(y) || Math.abs(y - PLATE_Y) > 0.35) { rejected++; return; }
      if (x < X0 + 0.9 || x > X1 - 0.9 || z < Z0 + 0.9 || z > Z1 - 0.9) { rejected++; return; }
      for (var q = 0; q < self.spawnPoints.length; q++) {
        var p = self.spawnPoints[q].position;
        var dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < MIN_SEP * MIN_SEP) { rejected++; return; }
      }
      self.spawnPoints.push({
        position: new THREE.Vector3(x, y + 0.02, z), yaw: yaw
      });
    }
    // [0] is the player: in the shade at the mouth of the core lobby, looking
    // west-north-west up the open run into the light. Every level should open on
    // its own best idea, and this level's idea is "look at that".
    //
    // The yaws are all different on purpose. Four men at the same yaw in the
    // same idle pose is a mannequin display, and it is what the firefight
    // capture printed.
    sp(4.0, 13.4, -0.62);
    sp(-6.0, 8.5, -0.30);    sp(-16.0, 2.0, 0.90);
    sp(-22.0, -10.0, 1.80);  sp(-10.5, -17.5, 2.60);
    sp(2.0, -17.0, -2.60);   sp(14.0, -16.0, -1.40);
    sp(24.0, -6.0, -1.90);   sp(24.5, 8.0, 2.40);
    sp(10.5, 6.0, 0.20);     sp(10.5, -7.0, 3.10);
    sp(-2.0, 18.0, -1.10);   sp(-20.0, 17.5, -1.60);
    sp(-24.0, 10.0, 1.30);
    sp(6.5, -10.5, 1.05);    sp(-14.0, -11.0, -2.10);
    this._spawnsRejected = rejected;

    // ---------------------------------------------------------------- framings --
    // Every pose is solved, not guessed: a position plus a look-at target that
    // is an actual thing in the level, so the composition survives the geometry
    // moving. Strong foreground, a leading line, a subject, and light doing
    // something visible.
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
    var gy;

    // ---- HERO1 : the signature image ---------------------------------------
    // RE-SOLVED, AND THIS TIME THE SUN IS THE SUBJECT.
    //
    // The previous mark stood at (-11, -19.7) looking east-south-east. Its
    // forward vector dotted -0.963 with the sun direction - the key was almost
    // exactly BEHIND the lens - so the frame contained no sky, no sunlit face,
    // no shaft, no backlit edge and not one directional cast shadow, on a level
    // whose one-line brief is "the low sun rakes straight through the open
    // plates casting enormous column shadows". It photographed as a parking
    // deck lit by orange bulbs.
    //
    // The eye now stands at (-7.9, 10.2) and looks WEST-NORTH-WEST down the
    // 24 m open run, within 4 degrees of the sun's own bearing. Everything
    // follows from that one decision:
    //
    //   * THE WEDGE. A ray clearing the west opening's head (the edge beam
    //     soffit at y 3.28) descends 0.162 per horizontal metre, so sunlight
    //     reaches 20.2 m inboard - the floor is lit wherever x < -11.84 or
    //     z < -7.58. From this eye that boundary is 5.5 m ahead, so almost the
    //     whole visible floor is in the sun and the near strip is not.
    //   * THE SHADOW BARS. Shadows travel toward (+0.749, +0.663), i.e. back
    //     along the view axis TOWARD THE LENS. The x -22.5 column row is lit to
    //     2.3 m of its height and throws 14 m bars straight at the camera; the
    //     x -13.5 row stands on the wedge boundary and is lit at its base only,
    //     which is exactly the read a 9-degree sun gives.
    //   * THE VERTICALS TAKE THE KEY, NOT THE FLOOR. At 9.2 degrees a slab
    //     receives sin(9.2) = 0.16 of the key and a west-facing surface 0.99, so
    //     the sunset has to land on vertical faces and be read as SHADOW PATTERN
    //     on the floor. The west column row, the blockwork stacks, the curtain
    //     wall reveal and the polythene hung in the west edge bays are all in
    //     this frame and all take the full cosine.
    //   * NO SUN DISC. The soffit cuts a 9.2-degree sightline 13.9 m out, long
    //     before the west opening, so the brightest thing in frame is lit
    //     concrete and the burning sky is a thin blade under the soffit edge.
    //   * THE SQUAD. lv_firefight, lv_ads, lv_muzzleflash and lv_explosion all
    //     borrow this pose, and combatMark() walks a WORLD-AXIS four-man line
    //     (9 m in +X, 10.2 m in -Z) outward from 9 m. From this standpoint the
    //     d = 9 m mark puts all four at (-19.5, 4.7), (-16.5, 1.3), (-13.5,
    //     -2.1), (-10.5, -5.5): every one on the slab, clear of the void, the
    //     core, the column footprints and the laydown - and every one of them
    //     standing in the sun wedge, rim-lit, with their own shadows running to
    //     the lens. The old pose failed that test at every d in [9, 26], which
    //     is why the published firefight had nobody in it.
    gy = this.sampleGround(-7.9, 10.2);
    var hero1 = pose(-7.9, gy + 1.72, 10.2, -23.70, gy + 1.72 - 1.91, -2.06);

    // ---- HERO2 : the curtain wall against the sunset -----------------------
    // RE-SOLVED. The previous mark stood at (-24.9, 17.8) in the 4.3 m aisle
    // between the glazing and the x -22.5 column row, and it photographed as an
    // underground car park: no sky, no city, no drop, no exterior, a large unlit
    // column across 15% of the frame at centre-right, and the only openings that
    // could have said where you were blown to flat paper white at the vanishing
    // point. On a level whose stated character is "extreme vertical" that is the
    // worst of the five framings.
    //
    // The eye now stands out on the plate at (-12, 3.2) and looks WEST-SOUTH-
    // WEST at the installed curtain wall, which is the one asset the roster
    // brief singles out ("a glass curtain-wall section that reflects the
    // sunset"). Four things are solved rather than chosen:
    //
    //   * The west glazing's outward normal is -X and the sun's horizontal
    //     bearing is (-0.749, -0.663), so the glass takes 0.749 of the cosine -
    //     it is the most strongly sunlit surface in the level, seen from inside
    //     with the burning sky behind it.
    //   * THE DISC IS OCCLUDED BY THE HEAD SPANDREL, not by luck. The vision
    //     glass tops out at y 2.91 and the eye is 1.70; at the 20 m standoff the
    //     top of the glass subtends 3.5 degrees and the sun sits at 9.2, so the
    //     disc is behind the spandrel band while the glow band immediately under
    //     it is not. That is what stops the openings clipping to paper white.
    //   * The bearing is 29 degrees south of west, which throws the mullion run
    //     into oblique perspective as a leading line and puts the nearest column
    //     (x -22.5, z 0) 46 degrees off axis at 5 m - a foreground frame on one
    //     side instead of a black slab through the middle.
    //   * THE CAMERA IS OUTSIDE EVERY PRACTICAL'S CONE, checked rather than
    //     hoped: the closest festoon light is FESTOON[0] k=1 at (-14.85, 6),
    //     which sits 5.2 m out and 1.86 m up, i.e. 70 degrees off its own
    //     down-axis against a cone of 1.15 rad (66 degrees). The file's own
    //     warning about a lamp 2 m from the eye filling the frame with flat
    //     orange is what this clearance is for.
    gy = this.sampleGround(-17.5, 1.5);
    var hero2 = pose(-17.5, gy + 1.70, 1.5, -27.10, gy + 0.68, 8.70);

    // ---- HERO3 : the drop ---------------------------------------------------
    // RE-SOLVED FROM THE GEOMETRY UP, because the old mark could not have
    // worked. It stood at (-11.5, -18.9) and pitched 22 degrees down over the
    // NORTH edge, and what it photographed was: slab edge, a razor-straight
    // ruled line, 400 m of haze, then a city. Nothing connected the near field
    // to the far field, so there was no fall - and our own tower's facade, the
    // only object in the level that can express 176 m, never appeared, because
    // no published pose looked along it.
    //
    // ---- WHY YOU CANNOT SEE DOWN FROM WHERE IT WAS STANDING -----------------
    // From an eye 1.6 m over your own floor, a sightline at pitch p meets that
    // floor at 1.6/tan(p) metres. To see anything below you, the slab edge has
    // to be NEARER than that - and to see your own facade dropping away, the
    // sightline has to leave the building envelope before it meets the floor.
    // The old mark was 2.1 m inboard of the north edge and aimed 30 degrees off
    // it: the ray met concrete at 4.0 m and the edge at 4.2 m. It was looking at
    // its own floor by 200 mm, which is exactly why the frame had a ruled line
    // in it instead of a drop.
    //
    // ---- WHERE IT STANDS NOW ------------------------------------------------
    // In the 5 m break in the WEST edge protection (buildEdgeProtection leaves
    // z -9..-4 unguarded), 1.3 m inboard of the slab arris, looking 32 degrees
    // south of west and 34 degrees down:
    //
    //   * the ray crosses x = -27 at 1.77 m and would not meet the floor until
    //     2.36 m, so it leaves the envelope with 0.6 m of margin and everything
    //     past that point is air
    //   * the near left is the slab arris and the continuity bars projecting
    //     straight out of it (outBars runs z -20..-4 on this edge), plus the
    //     polythene hung OFF the edge beam at (-27.34, -8.6) falling 5.1 m past
    //     the slab - a vertical that continues out of frame is the cheapest
    //     altitude cue there is, and the sun is directly behind it
    //   * the whole left half is then OUR OWN WEST ELEVATION dropping away in
    //     perspective: two raw frame floors with their edge beams and columns,
    //     the third floor's spandrel, and then the finished glazing with a
    //     200 mm floor band every 4.3 m all the way down - floors you can count
    //   * that elevation faces -X and the sun bears (-0.749, -0.663), so it is
    //     the most strongly sunlit surface in the level; the north elevation
    //     beyond the corner is in shade. One lit face, one shaded face, and the
    //     vertical arris between them running 176 m to the street
    //   * the vanishing point is the city 280 m out to the south-west at street
    //     level, under the haze the fog cap was lowered to preserve
    gy = this.sampleGround(-26.55, -8.2);
    var hero3 = pose(-26.55, gy + 1.62, -8.2, -45.15, gy + 1.62 - 20.5, 15.35);

    // ---- INTERIOR : the lift lobby -----------------------------------------
    // A 20 m concrete tube looking north, out of the core, across the plate and
    // through the open north edge. Dark tube, bright end - and the two open lift
    // shafts on the right, each with a worklight a metre down it, are the only
    // things in the level that are lit from BELOW.
    // ---- AND WHY IT NOW LOOKS DOWN INSTEAD OF UP ---------------------------
    // The aim point was 2.30 m at z -19, i.e. 0.64 m ABOVE the eye: the framing
    // pitched UP by 1.5 degrees and put the lobby soffit across the top third
    // while the one bright thing in the composition - the sunlit strip of plate
    // between the lobby mouth at z -10 and the north arris at z -21 - sat at the
    // very bottom of the aperture. Solved rather than nudged: a point (11, -15)
    // out on the plate receives the key, because tracing back toward the sun from
    // there clears the north edge beam at 9.05 m with 1.47 m to spare. Aiming at
    // 0.55 m puts that lit strip on the frame's own centre line, which is what
    // "dark tube, bright end" means.
    var interior = pose((LOB_X0 + LOB_X1) * 0.5 - 0.20, 1.66, 6.8,
      (LOB_X0 + LOB_X1) * 0.5 - 0.60, 0.55, -17.0);

    // ---- OVERVIEW : from outside -------------------------------------------
    // There is no high vantage INSIDE a 3.96 m floor plate, so the establishing
    // shot is taken from off the north-west corner - level with the plate, on
    // the crane's side of the gap - looking back south-east into the open
    // corner. That is the only standpoint from which the whole idea of the level
    // is in one frame: an open floor with the sun blazing through it, the raw
    // frame above, the finished glass tower below it, the crane, and 176 m of
    // air underneath.
    //
    // The sun is behind the camera's left shoulder, so the tower's north and
    // west elevations are both lit rather than silhouetted - which is what an
    // establishing frame needs and what a shot into the sun cannot give.
    //
    // RE-SOLVED TWICE.
    //
    // The first mark stood 7.8 m off the crane's mast, which put a 2 m lattice
    // column dead down the centre of the frame. The second stood NORTH-WEST at
    // (-22, 16, -74) - and the sun arrives from west-north-west, so the north
    // elevation AND the west elevation were both frontally lit. An establishing
    // shot needs one lit face and one shaded face; two lit faces is a card
    // model, which is exactly what it photographed as.
    //
    // The standpoint is now NORTH-EAST. The sun sits 93 degrees off the view
    // axis, so the north elevation takes the rake and the east elevation - the
    // one carrying the scaffold and the hoist mast, i.e. the level's densest
    // silhouette - goes into shade. The hoist mast runs down the near right as a
    // foreground vertical, the crane stands clear beyond the far corner with its
    // jib crossing the top of the frame, and the sightline to the crane passes
    // NORTH of the tower rather than through it.
    var overview = pose(46.0, 14.0, -50.0, 2.0, -4.0, 0.0);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior
    };
  };

  // ---- broadphase + raycast --------------------------------------------------------
  LevelHighrise.prototype._buildBroadphase = function () {
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

  LevelHighrise.prototype.raycast = function (origin, dir, maxDist) {
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

  // ---- per frame --------------------------------------------------------------------
  // The frame itself is static. The sheeting is not, and it must not be: the
  // roster pins this level at "clear, WINDY", and a polythene sheet that hangs
  // dead still is a painted wall. Six sheets at 72 vertices each is 432 points
  // of trigonometry a frame - the cost of the only motion in the level.
  LevelHighrise.prototype.update = function (dt, ctx) {
    // ---- the hour, once ------------------------------------------------------
    // main.js applies the env profile AFTER every build() has run, so this is
    // the first moment a level can see what it was actually given. See the
    // TIME_OF_DAY note at the top of this file: 0.80 lands the disc under the
    // horizon and leaves the level with no key at all. Guarded three ways - the
    // API must exist, the sky must agree the sun is down, and it runs exactly
    // once - so it cannot fight the profile on any level but this one.
    if (!this._hourPinned) {
      this._hourPinned = true;
      try {
        var sk = ctx && ctx.sky;
        // ---- THE AEROSOL, ONCE --------------------------------------------
        // The env profile asks for turbidity 0.03, the lowest number in the
        // whole LEVELS table (snowbound 0.09, jungle 0.07, ruins 0.06, refinery
        // 0.05). An atmosphere that thin produces almost no chromatic
        // separation between sun and sky, and the measured consequence was a
        // level that is greyer than the golden-hour level it is supposed to look
        // nothing like: whole-frame saturation 0.219 / 0.236 / 0.274 against the
        // shipped market street's 0.277, an achromatic upper sky at
        // [0.297,0.303,0.317], and a shadow chroma of [-0.000,-0.001,+0.001] -
        // perfectly neutral. grade_split was positive only because the
        // highlights are warm; the shadow half of it was doing nothing at all.
        //
        // A clear sunset works because 2500 K direct sits against 12000 K
        // skylight. That needs real blue photons in the shade, and no postfx
        // lift curve can invent them - it has to come from Rayleigh dominating
        // an aerosol thick enough to redden the low disc. 0.062 thickens the
        // haze, reddens the sun and pushes actual blue into the sky ambient.
        //
        // Guarded and one-shot, exactly like the hour below: setTurbidity is
        // public API, it rebuilds the LUT and re-runs the PMREM, and only this
        // level calls it - the market and the harbor cannot move.
        if (sk && typeof sk.setTurbidity === 'function') sk.setTurbidity(TURBIDITY);
        if (sk && typeof sk.setTimeOfDay === 'function' && sk.sunWorldDirection &&
            sk.sunWorldDirection.y <= 0.005) {
          sk.setTimeOfDay(TIME_OF_DAY);
        }
      } catch (e) { GAME.logError('highrise.hour', e); }
    }

    // ---- the shadow cascade, against the ACTIVE camera -----------------------
    // 78 m of cascade is right for the four eye-level poses, and completely
    // wrong for the establishing shot: that eye stands 69 m from its target with
    // the far side of the tower at 110 m+, so the entire subject sat at or
    // beyond the cascade limit and the top plate photographed with no column
    // shadows on it at all, no shadow of the upper plate on the lower one, and
    // every face a flat sky-ambient wash. Solved from the camera rather than
    // pinned to a number, and only written when it actually changes so the
    // cascades are not marked dirty every frame.
    try {
      var cam = ctx && ctx.camera;
      var lg = ctx && ctx.lighting;
      if (cam && lg && typeof lg.setShadowDistance === 'function') {
        var cp = cam.position;
        var outside = (cp.x < X0 - 6 || cp.x > X1 + 6 ||
                       cp.z < Z0 - 6 || cp.z > Z1 + 6 || cp.y > 10);
        var want = outside ? 150 : 78;
        if (want !== this._shadowDist) {
          lg.setShadowDistance(want);
          this._shadowDist = want;
        }
      }
    } catch (e2) { /* a cascade limit is not worth a frame */ }

    var sheets = this.sheets;
    if (!sheets || !sheets.length) return;
    this._t += (dt || 0);
    var t = this._t;
    // The wind is the level's own unless weather.js is publishing one.
    var wind = this.windSpeed;
    try {
      if (ctx && ctx.weather && isFinite(ctx.weather.windSpeed) && ctx.weather.windSpeed > 0) {
        wind = ctx.weather.windSpeed;
      }
    } catch (e) { /* the level's own gale is fine */ }
    var gust = 0.55 + 0.45 * Math.sin(t * 0.47) * Math.sin(t * 0.21 + 1.3);
    var amp = M.clamp(wind / 11, 0.35, 2.0) * (0.55 + gust * 0.75);

    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      if (!sh || !sh.geo) continue;
      var p = sh.geo.attributes.position;
      var arr = p.array, base = sh.base;
      var n = p.count, ph = sh.phase;
      for (var i = 0; i < n; i++) {
        var bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        // hang factor: pinned along the top edge, free at the bottom
        var hang = M.saturate(-by / Math.max(0.2, sh.h));
        var u = (bx / Math.max(0.2, sh.w)) + 0.5;
        // two travelling waves plus a slow billow, all scaled by how free the
        // point is - the top edge is nailed to a tube and cannot move
        var w1 = Math.sin(t * 3.30 + ph + u * 5.1 - hang * 2.6);
        var w2 = Math.sin(t * 1.85 + ph * 1.7 + u * 2.3 + hang * 3.4);
        var billow = Math.sin(t * 0.72 + ph) * 0.5 + 0.5;
        var out = (w1 * 0.16 + w2 * 0.11 + billow * 0.22) * hang * hang * amp;
        arr[i * 3] = bx + w2 * 0.035 * hang * amp;
        arr[i * 3 + 1] = by + Math.abs(out) * -0.10;   // it shortens as it bellies
        arr[i * 3 + 2] = bz + out;
      }
      p.needsUpdate = true;
      sh.geo.computeVertexNormals();
    }
  };

  GAME.LevelHighrise = LevelHighrise;
})(window.GAME, window.THREE);
