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
  var CITY_R = 610.0;                 // radius of the modelled block grid
  var GROUND_R = 900.0;               // the ground plate under it

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
    slab:        { uv: 0.42, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.86 },
    soffit:      { uv: 0.38, cast: true,  recv: true,  wear: true,
                   base: 'concrete_wall', rough: 0.92 },
    core_wall:   { uv: 0.36, cast: true,  recv: true,  wear: true,
                   base: 'concrete_wall' },
    column:      { uv: 0.52, cast: true,  recv: true,  wear: true,
                   base: 'concrete', rough: 0.84 },
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
                   base: 'painted_metal', albedoTarget: 0x35302b,
                   rough: 0.26, metal: 0.90, env: 1.5 },
    glazing:     { uv: 0.40, cast: false, recv: false, wear: false,
                   base: 'glass', env: 2.4 },
    // Opaque spandrel panel at every floor band - real curtain wall is about a
    // third spandrel, and without it a glazed facade is a single sheet.
    spandrel:    { uv: 0.60, cast: true,  recv: true,  wear: false,
                   base: 'painted_metal', albedoTarget: 0x2a2f33,
                   rough: 0.34, metal: 0.70, env: 1.3 },
    // ---- soft goods ---------------------------------------------------------
    // Polythene sheeting: translucent, double sided, and it is what the wind is
    // FOR. Its whole job is to be backlit by a sun 0.3 degrees under the
    // horizon, so it is emissive-adjacent rather than merely pale.
    // Site polythene is not new polythene: it has been up for a month, it is
    // grey with dust and it is 60% opaque. At albedoTarget 0xb9bec0 with env
    // 0.9 these panels clipped to white against the sky in three of five
    // framings and read as luminous boards hung in the openings.
    sheeting:    { uv: 0.55, cast: false, recv: true,  wear: false, keepUV: true,
                   base: 'plastic', albedoTarget: 0x7f8486,
                   rough: 0.70, metal: 0.0, side: 2, env: 0.35 },
    debris_net:  { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                   own: true },
    // ---- distance -----------------------------------------------------------
    // The city. Its own atlas, its own material: it needs an emissiveMap (the
    // lit windows) that no library entry carries, and at 200-500 m it wants
    // none of the detail-normal / parallax machinery the near surfaces do.
    city:        { uv: 1.0, cast: false, recv: false, wear: false, keepUV: true,
                   own: true },
    city_ground: { uv: 0.030, cast: false, recv: false, wear: false,
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
    mullion:     [0x35302b, 0.26, 0.90],
    glazing:     [0x2a3238, 0.10, 0.0],
    spandrel:    [0x2a2f33, 0.34, 0.70],
    sheeting:    [0xb9bec0, 0.62, 0.0],
    debris_net:  [0xd06a20, 0.80, 0.0],
    city:        [0x6d6a66, 0.94, 0.0],
    city_ground: [0x3a3833, 0.92, 0.0],
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
  var ATLAS_N = 4, ATLAS_PX = 1024, ATLAS_CELL = ATLAS_PX / ATLAS_N;
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
    logo: 15       // contractor's mark, invented script
  };
  // Invented script: consistent letterforms that read as writing at a glance
  // and as nothing in particular up close. No font files exist in this build.
  var GLYPHS = 'AEHIKLMNORSTUVX0123456789';

  function atlasRect(cell) {
    var cx = (cell % ATLAS_N) * ATLAS_CELL;
    var cy = Math.floor(cell / ATLAS_N) * ATLAS_CELL;
    return [cx, cy, ATLAS_CELL, ATLAS_CELL];
  }
  // Canvas row 0 is v = 1 after three's flipY, so the v range is inverted here.
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

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // A decal card, laid on a face. `axis` picks the plane; `s` the size in
  // metres; `roll` a little rotation so nothing is applied dead square.
  function decalCard(B, cell, x, y, z, w, h, axis, tintC, roll) {
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
    B.tint = old;
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
  var CITY_GRID = 8;
  var BAY_W = 3.30, BAY_H = 3.55;      // metres per window bay / storey

  var _cityTex = null, _cityEmis = null, _cityTried = false;
  function buildCityMaps(rng) {
    if (_cityTried) return _cityTex;
    _cityTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 1024, C = S / CITY_GRID;             // 128 px per bay
    var cvA = document.createElement('canvas'), cvE = document.createElement('canvas');
    cvA.width = cvA.height = S; cvE.width = cvE.height = S;
    var a = cvA.getContext('2d'), e = cvE.getContext('2d');
    if (!a || !e) return null;
    var i, r, c;
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
    e.fillStyle = '#000000'; e.fillRect(0, 0, S, S);
    var lit = [];
    for (r = 0; r < CITY_GRID; r++) {
      lit.push([]);
      for (c = 0; c < CITY_GRID; c++) {
        var ww = C * 0.62, wh = C * 0.56;
        var wx = c * C + (C - ww) * 0.5, wy = r * C + C * 0.16;
        // reveal, so the opening has a depth edge and is not a pasted rect
        a.fillStyle = rgba(34, 33, 31, 0.90);
        a.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
        // dark glass with a sky gradient in the head
        var gl = a.createLinearGradient(0, wy, 0, wy + wh);
        gl.addColorStop(0, rgba(66, 74, 84, 1));
        gl.addColorStop(0.4, rgba(38, 42, 48, 1));
        gl.addColorStop(1, rgba(26, 28, 32, 1));
        a.fillStyle = gl; a.fillRect(wx, wy, ww, wh);
        // mullion split - a window with no division reads as a hole
        a.fillStyle = rgba(52, 50, 46, 0.85);
        a.fillRect(wx + ww * 0.5 - 1.5, wy, 3, wh);
        // sill: the brightest surviving feature on a hazed facade
        a.fillStyle = rgba(150, 146, 134, 0.80);
        a.fillRect(wx - 4, wy + wh, ww + 8, 4);

        // ---- how many windows are lit, and how hard --------------------------
        // The sun is still up: this is the hour when the FIRST lights come on,
        // not full night. The first pass ran 30-58% lit at emissive 2.6 and the
        // city photographed as a white speckled carpet that took the whole
        // frame's metering with it - the sky went navy behind a Christmas
        // display. One in six, at a third of the output, is a city at dusk.
        // Lit in vertical runs (one tenant, one riser) rather than scattered:
        // scattered reads as noise, runs read as a building.
        var on = rng.next() < (c % 3 === 0 ? 0.30 : 0.11);
        lit[r].push(on);
        if (!on) continue;
        var k = rng.range(0.66, 1.0);
        var warm = rng.bool(0.72);
        var lr = warm ? 255 * k : 214 * k;
        var lg = warm ? 206 * k : 226 * k;
        var lb = warm ? 138 * k : 244 * k;
        a.fillStyle = rgba(lr * 0.26, lg * 0.26, lb * 0.26, 1);
        a.fillRect(wx, wy, ww, wh);
        e.fillStyle = rgba(lr, lg, lb, 1);
        e.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);
        // a ceiling-bright band at the head - the light fitting is up there
        e.fillStyle = rgba(255, 240, 210, 0.45);
        e.fillRect(wx + 2, wy + 2, ww - 4, wh * 0.20);
        // occupancy: a silhouette or a partition breaking the glow
        if (rng.bool(0.34)) {
          e.fillStyle = 'rgba(0,0,0,0.55)';
          e.fillRect(wx + rng.range(4, ww * 0.5), wy + wh * rng.range(0.35, 0.6),
            rng.range(6, ww * 0.4), wh * 0.6);
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
    return _cityTex;
  }

  // ---- debris netting --------------------------------------------------------
  // Orange scaffold sheeting/netting: alpha-tested, so it writes depth, needs no
  // sorting and still appears in the shadow map - which is the only reason a net
  // reads as a net when the sun is behind it.
  var _netTex = null, _netTried = false;
  function netTexture() {
    if (_netTried) return _netTex;
    _netTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 256;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    // a knitted diamond mesh: two crossing sets of thick threads
    var n = 10, p = S / n;
    g.lineCap = 'round';
    // Thin threads, not ribbons: a knitted debris net is roughly 60% open, and
    // at p*0.40 the "net" was an opaque orange sheet with a pattern on it.
    for (var pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? 'rgba(208,96,26,0.95)' : 'rgba(160,66,16,0.95)';
      g.lineWidth = pass ? p * 0.13 : p * 0.20;
      for (var i = -n; i <= n * 2; i++) {
        g.beginPath(); g.moveTo(i * p, -S); g.lineTo(i * p + 2 * S, S); g.stroke();
        g.beginPath(); g.moveTo(i * p, S * 2); g.lineTo(i * p + 2 * S, 0); g.stroke();
      }
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    _netTex = tex;
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
    // and the underside itself, so looking over the edge sees a soffit
    B.paint = 'soffit';
    B.box('slab', X1 - X0, 0.06, Z1 - Z0, 0, -SLAB_T - 0.03, 0, 0.02);
    B.paint = 'slab';

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
  function buildColumns(L, B, rng, N) {
    var out = [];
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
        B.box('column', w, h * 0.42, w, x, y0 + h * 0.21, z, 0.035);
        B.box('column', w - 0.012, h * 0.58, w - 0.012, x, y0 + h * 0.42 + h * 0.29, z, 0.035);
        B.box('column', w + 0.030, 0.028, w + 0.030, x, y0 + h * 0.42, z, 0.008);
        // kicker at the base - the 75 mm upstand the column was cast off
        B.box('column', w + 0.09, 0.075, w + 0.09, x, y0 + 0.037, z, 0.012);
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
        // head: starter cage for the column above, poking through the soffit
        B.paint = 'steel';
        for (var a = -1; a <= 1; a += 2) {
          for (var b = -1; b <= 1; b += 2) {
            B.cyl('rebar', 0.012, 0.012, 0.55, x + a * 0.30, SOFFIT_Y + 0.10, z + b * 0.30, 0, 0, 0, 5);
          }
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
        // markings: grid reference at eye height on the face that gets seen
        B.paint = 'flat';
        decalCard(B, CELL.gridref, x - w * 0.5 - 0.008, y0 + 1.62, z, 0.60, 0.60, 'x-',
          tint(0xffffff, 0), rng.range(-0.03, 0.03));
        if (rng.bool(0.4)) {
          decalCard(B, CELL.streak, x, y0 + h * 0.5, z + w * 0.5 + 0.008,
            w * 0.9, h * 0.85, 'z', tint(0xffffff, 0), 0);
        }
        if (rng.bool(0.22)) {
          decalCard(B, CELL.hazard, x, y0 + 1.05, z - w * 0.5 - 0.008,
            w * 1.0, 0.26, 'z-', tint(0xffffff, 0), 0);
        }
        B.paint = 'wall';
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
      B.paint = 'flat';
      decalCard(B, CELL.danger, LOB_X1 - 0.02, 1.72, dz, 0.56, 0.56, 'x-', tint(0xffffff, 0), 0.03);
      decalCard(B, CELL.tape, LOB_X1 - 0.03, 1.42, dz, 2.10, 0.28, 'x-', tint(0xffffff, 0), -0.04);
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
    B.paint = 'flat';
    decalCard(B, CELL.noentry, LOB_X0 + 0.012, 1.80, -7.6, 0.52, 0.52, 'x+', tint(0xffffff, 0), 0);
    decalCard(B, CELL.label, LOB_X0 + 0.012, 2.32, 1.4, 0.72, 0.34, 'x+', tint(0xffffff, 0), 0.02);
    decalCard(B, CELL.logo, LOB_X0 + 0.012, 2.05, 7.8, 0.80, 0.80, 'x+', tint(0xffffff, 0), -0.02);
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
  function buildEdgeProtection(L, B, rng, N) {
    var i;
    // [along, a0, a1, netted]  - 'along' is 'x' (north edge) or 'z' (west edge)
    // The GAPS are x -12.5..-3.5 on the north edge (nine metres of nothing, and
    // the mark hero3 is solved on) and x 6..9. A continuous barrier makes the
    // drop safe and therefore invisible.
    var RUNS = [
      ['x', X0 + 0.4, -12.5, true],
      ['x', -3.5, 6.0, true],
      ['x', 9.0, X1 - 0.4, true],
      ['z', Z0 + 0.4, -9.0, true],
      ['z', -4.0, CW_WEST_Z0 - 0.6, false]
    ];
    for (var r = 0; r < RUNS.length; r++) {
      var run = RUNS[r];
      var horiz = run[0] === 'x';
      var a0 = run[1], a1 = run[2];
      var n = Math.max(1, Math.round((a1 - a0) / 2.1));
      var fixed = horiz ? Z0 + 0.30 : X0 + 0.30;
      B.paint = 'steel';
      for (i = 0; i <= n; i++) {
        var a = M.lerp(a0, a1, i / n);
        var px = horiz ? a : fixed, pz = horiz ? fixed : a;
        var py = plateY(px, pz, N);
        // post: a hollow section in a cast-in socket, leaning a little
        var lean = rng.range(-0.035, 0.035);
        B.box('scaff', 0.055, 1.15, 0.055, px, py + 0.575, pz, lean, 0, lean * 0.6, 0.008);
        B.box('plant', 0.16, 0.030, 0.16, px, py + 0.015, pz, 0.004);
        L.addCollider(px, py + 0.55, pz, 0.06, 0.55, 0.06, 'metal');
      }
      // rails
      for (i = 0; i < 2; i++) {
        var ry = plateY(horiz ? (a0 + a1) * 0.5 : fixed, horiz ? fixed : (a0 + a1) * 0.5, N) +
          (i ? 1.10 : 0.58);
        if (horiz) B.tube('scaff', a0, ry, fixed, a1, ry, fixed, 0.024, 7);
        else B.tube('scaff', fixed, ry, a0, fixed, ry, a1, 0.024, 7);
      }
      // toe board
      B.paint = 'ply';
      if (horiz) B.box('timber', a1 - a0, 0.16, 0.026, (a0 + a1) * 0.5, 0.10, fixed - 0.03, 0.004);
      else B.box('timber', 0.026, 0.16, a1 - a0, fixed - 0.03, 0.10, (a0 + a1) * 0.5, 0.004);
      // debris netting, on the runs that carry it
      if (run[3]) {
        B.paint = 'mesh';
        var len = a1 - a0;
        var uu = len / 1.4, vv = 1.05 / 1.4;
        var g = quad(len, 1.05, 0, 0, uu, vv);
        var mx = horiz ? (a0 + a1) * 0.5 : fixed - 0.045;
        var mz = horiz ? fixed - 0.045 : (a0 + a1) * 0.5;
        B.add('debris_net', g, makeM(mx, 0.60, mz, 0, horiz ? 0 : Math.PI * 0.5, 0));
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
    B.paint = 'flat';
    for (i = 0; i < 3; i++) {
      decalCard(B, CELL.tape, M.lerp(-11.4, -4.6, (i + 0.5) / 3), 0.64 + Math.sin(i * 2.1) * 0.04,
        Z0 + 0.34, 2.3, 0.115, 'z', tint(0xffffff, 0), rng.range(-0.05, 0.05));
    }
    // The placard needs something to be screwed TO. Hung on nothing it is a
    // white rectangle floating over 176 m of air, which is what the first
    // capture printed on the left of hero3.
    B.paint = 'ply';
    B.box('timber', 0.50, 0.50, 0.016, -12.5, 1.10, Z0 + 0.335, 0.004);
    B.paint = 'flat';
    decalCard(B, CELL.danger, -12.5, 1.10, Z0 + 0.327, 0.44, 0.44, 'z', tint(0xffffff, 0), 0.04);
    decalCard(B, CELL.noentry, -12.5, 1.10, Z0 + 0.344, 0.40, 0.40, 'z-', tint(0xffffff, 0), -0.03);
    B.paint = 'steel';
    // the tape's tubes
    B.cyl('scaff', 0.024, 0.024, 1.3, -12.4, 0.65, Z0 + 0.34, 0, 0, 0, 7);
    B.cyl('scaff', 0.024, 0.024, 1.3, -3.6, 0.65, Z0 + 0.34, 0, 0, 0, 7);
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
    // [x, z, yaw, width, height, phase]
    var SHEETS = [
      [X0 + 0.55, -13.2, 0, 4.6, 3.30, 0.0],
      [X0 + 0.55, -4.2, 0, 3.8, 3.30, 1.7],
      [-19.0, Z0 + 0.55, Math.PI * 0.5, 5.2, 3.30, 3.1],
      [-3.2, Z0 + 0.55, Math.PI * 0.5, 4.0, 2.60, 4.6],
      [12.5, Z0 + 0.55, Math.PI * 0.5, 4.6, 3.30, 5.9],
      [X1 - 0.55, 5.0, Math.PI, 4.4, 3.30, 2.4]
    ];
    var out = [];
    for (var i = 0; i < SHEETS.length; i++) {
      var s = SHEETS[i];
      var g = sheetGrid(s[3], s[4], 8, 7);
      var p = g.attributes.position;
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
      out.push({
        geo: g, base: new Float32Array(p.array), phase: s[5],
        w: s[3], h: s[4],
        matrix: makeM(s[0], SOFFIT_Y - 0.16, s[1], 0, s[2], 0)
      });
      // the tube it is hung from
      B.paint = 'steel';
      var hx = s[0], hz = s[1];
      var ax = hx - Math.cos(s[2]) * s[3] * 0.5, az = hz + Math.sin(s[2]) * s[3] * 0.5;
      var bx = hx + Math.cos(s[2]) * s[3] * 0.5, bz = hz - Math.sin(s[2]) * s[3] * 0.5;
      B.tube('scaff', ax, SOFFIT_Y - 0.14, az, bx, SOFFIT_Y - 0.14, bz, 0.022, 7);
      // and the batten screwed through it at the head, which is what a sheet is
      // actually fixed with
      B.paint = 'ply';
      B.boxR('timber', s[3] * 0.98, 0.05, 0.028, hx, SOFFIT_Y - 0.20, hz, 0, s[2], 0, 0.004);
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
      var g2 = quad(nb - na, 8.0, 0, 0, (nb - na) / 1.4, 8.0 / 1.4);
      B.add('debris_net', g2, makeM(rows[1] + 0.06, 2.1, (na + nb) * 0.5, 0, Math.PI * 0.5, 0));
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
  function buildShell(L, B, rng, N) {
    var i, k;
    var uO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;

    // ---- the finished tower below -------------------------------------------
    var topY = LOWER_Y - FLOOR_H * 2;                 // glazing starts here
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
      B.add('shell', quadGeo(
        [ax, CITY_Y, az], [bx, CITY_Y, bz], [bx, topY, bz], [ax, topY, az],
        u0, v0, u0 + cols / CITY_GRID, v0 + rows / CITY_GRID), null);
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
    // ---- the two raw frame floors between ----------------------------------
    B.paint = 'wall';
    for (k = 1; k <= 2; k++) {
      var fy = -k * FLOOR_H;
      B.box('slab', X1 - X0, SLAB_T, Z1 - Z0, 0, fy - SLAB_T * 0.5, 0, 0.03);
      B.box('slab', X1 - X0, 0.70, 0.46, 0, fy - 0.37, Z0 + 0.23, 0.04);
      B.box('slab', X1 - X0, 0.70, 0.46, 0, fy - 0.37, Z1 - 0.23, 0.04);
      B.box('slab', 0.46, 0.70, Z1 - Z0, X0 + 0.23, fy - 0.37, 0, 0.04);
      B.box('slab', 0.46, 0.70, Z1 - Z0, X1 - 0.23, fy - 0.37, 0, 0.04);
      for (i = 0; i < COLX.length; i++) {
        for (var j = 0; j < COLZ.length; j++) {
          if (COLX[i] > CORE_X0 - 1 && COLX[i] < CORE_X1 + 1 &&
              COLZ[j] > CORE_Z0 - 1 && COLZ[j] < CORE_Z1 + 1) continue;
          B.box('column', COL_W, FLOOR_H - SLAB_T, COL_W, COLX[i],
            fy - SLAB_T - (FLOOR_H - SLAB_T) * 0.5, COLZ[j], 0.04);
        }
      }
    }
    // the core continuing down as a solid shaft
    B.box('core_wall', CORE_X1 - CORE_X0, 3 * FLOOR_H, CORE_Z1 - CORE_Z0,
      (CORE_X0 + CORE_X1) * 0.5, -1.5 * FLOOR_H, (CORE_Z0 + CORE_Z1) * 0.5, 0.04);

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
          B.box('column', COL_W, FLOOR_H - SLAB_T, COL_W, COLX[i],
            uy + SLAB_T + (FLOOR_H - SLAB_T) * 0.5, COLZ[j2], 0.04);
        }
      }
      // formwork tables and edge protection on the floor above
      B.paint = 'steel';
      for (i = 0; i < 10; i++) {
        var tx = rng.range(X0 + 3, X1 - 3), tz = rng.range(Z0 + 3, Z1 - 3);
        if (tx > CORE_X0 && tx < CORE_X1 && tz > CORE_Z0 && tz < CORE_Z1) continue;
        B.cyl('scaff', 0.030, 0.030, 2.6, tx, uy + SLAB_T + 1.3, tz, 0, 0, 0, 6);
      }
    }
    B.paint = 'wall';
    B.box('core_wall', CORE_X1 - CORE_X0, FLOOR_H * 2.4, CORE_Z1 - CORE_Z0,
      (CORE_X0 + CORE_X1) * 0.5, FLOOR_H * 1.2 + SLAB_T, (CORE_Z0 + CORE_Z1) * 0.5, 0.04);
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
    // Wide enough that its rim is past the far plane, and with a low ridge on
    // it so it never terminates against the sky as a ruled straight line.
    B.paint = 'city';
    var gnd = gridSurface(-GROUND_R, GROUND_R, -GROUND_R, GROUND_R, GROUND_R / 26,
      function (x, z) {
        var r = Math.sqrt(x * x + z * z);
        var y = CITY_Y - 1.0;
        // The city sits in a shallow basin with low ground rising past it. This
        // is the same trick the market's outer plain uses and for the same
        // reason: a plain that terminates in a ruled straight line reads as a
        // failure, and a wavy ridge reads as distance.
        y += (N.fbm2(x * 0.0022 + 4.1, z * 0.0022 - 2.6, 3) * 0.5 + 0.5) * 62 *
          M.smoothstep(280, 820, r);
        y += (N.fbm2(x * 0.0075 - 1.4, z * 0.0075 + 3.9, 2) * 0.5 + 0.5) * 9 *
          M.smoothstep(120, 420, r);
        return y;
      });
    B.add('city_ground', gnd, null);

    // ---- the street grid ----------------------------------------------------
    // Two rotated grids, because a single orthogonal one photographs as graph
    // paper. Everything below is laid out on these lines.
    var GRID_A = 0.18, GRID_B = GRID_A + 1.22;
    var BLK = 55.0;
    var placed = [];

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
      var h = M.lerp(26, 78, Math.pow(core, 1.25) * rg.range(0.42, 1.0));
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

    for (i = -11; i <= 11; i++) {
      for (k = -11; k <= 11; k++) {
        blockAt(i * BLK + rng.range(-8, 8), k * BLK + rng.range(-8, 8), GRID_A);
      }
    }
    for (i = -8; i <= 8; i++) {
      for (k = -8; k <= 8; k++) {
        blockAt(i * BLK * 1.30 + rng.range(-11, 11), k * BLK * 1.30 + rng.range(-11, 11), GRID_B);
      }
    }

    // ---- the near neighbours ------------------------------------------------
    // Four towers close enough to have parallax and to be genuinely LIT rather
    // than hazed. The first is the level's "curtain wall that reflects the
    // sunset": it stands north-east of us, so the face we see is its WEST one,
    // which is the face the sun is on.
    //
    // NOTHING TALL SITS ON THE SUN'S AZIMUTH INSIDE 200 m, and that is a rule
    // rather than an accident: the sun arrives from bearing (-0.78, -0.62), and
    // the first layout put a 208 m tower 125 m away on exactly that line. Its
    // top subtended 14.4 degrees against a 9.2-degree sun, so it stood between
    // the level and its own key in every framing that looks out. The dark tower
    // is now 258 m out, where it is a silhouette IN the glow instead of a lid
    // over it.
    var NEAR = [
      { x: 95, z: -175, w: 42, d: 36, h: 244, glass: true, name: 'glassTowerNE' },
      { x: 34, z: -124, w: 34, d: 30, h: 152, glass: true, name: 'glassTowerN' },
      { x: 148, z: -62, w: 38, d: 34, h: 196, glass: false, name: 'towerE' },
      { x: -212, z: -152, w: 46, d: 42, h: 206, glass: false, name: 'darkTowerNW' },
      { x: -62, z: 132, w: 38, d: 34, h: 178, glass: false, name: 'towerSW' }
    ];
    for (i = 0; i < NEAR.length; i++) {
      var t = NEAR[i];
      cityBlock(B, rng, t.x, t.z, rng.range(-0.08, 0.08), t.w, t.d, t.h, N, t.glass ? 1 : 0);
      placed.push([t.x, t.z]);
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

    // ---- points of light ----------------------------------------------------
    // Street lighting, laid on the grid lines, plus the two arterials. From
    // 176 m up each of these is one to three pixels: their only job is to
    // survive the haze as a POINT, which is why they are pure emissive cards
    // lying flat rather than anything with a normal.
    B.paint = 'flat';
    var lampGeo = quad(4.6, 4.6, 0, 0, 1, 1);
    function lampLine(ang, off, n, spacing, tintC) {
      var ca = Math.cos(ang), sa = Math.sin(ang);
      for (var q = 0; q < n; q++) {
        var g0 = (q - n * 0.5) * spacing;
        var wx = g0 * ca - off * sa, wz = g0 * sa + off * ca;
        var r = Math.sqrt(wx * wx + wz * wz);
        if (r > CITY_R * 1.05 || r < 40) continue;
        var old = B.tint;
        B.tint = tintC;
        B.add('city_light', lampGeo, makeM(wx, CITY_Y + 8.0, wz, -Math.PI * 0.5, 0, 0));
        B.tint = old;
      }
    }
    var warmL = tint(0xffc487, 0.85), coolL = tint(0xbfd8ff, 0.85);
    for (i = -8; i <= 8; i++) {
      lampLine(GRID_A, i * BLK, 46, 22, i % 3 === 0 ? coolL : warmL);
      lampLine(GRID_A + Math.PI * 0.5, i * BLK, 46, 22, warmL);
    }
    for (i = -5; i <= 5; i++) {
      lampLine(GRID_B, i * BLK * 1.35, 34, 26, warmL);
    }
    // two arterials with a denser, brighter run - vehicle light trails
    var hotL = tint(0xffe9c4, 0.9);
    lampLine(GRID_A, -1.5 * BLK, 150, 7.0, hotL);
    lampLine(GRID_A + Math.PI * 0.5, 2.5 * BLK, 150, 7.0, hotL);
    B.paint = 'steel';
  }

  // One block. Four mapped facades, a parapet, and roof furniture - a plant
  // room, a couple of tanks and a mast. Roof furniture is the difference
  // between a city and a bar chart: it breaks every roofline silhouette.
  //   flavour 0 = ordinary, 1 = full glass curtain wall, 2 = under construction
  function cityBlock(B, rng, x, z, yaw, w, d, h, N, flavour) {
    flavour = flavour || 0;
    var y0 = CITY_Y, y1 = CITY_Y + h;
    var ca = Math.cos(yaw), sa = Math.sin(yaw);
    function P(lx, ly, lz) {
      return [x + lx * ca - lz * sa, ly, z + lx * sa + lz * ca];
    }
    var hw = w * 0.5, hd = d * 0.5;
    var uO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    var vO = Math.floor(rng.range(0, CITY_GRID)) / CITY_GRID;
    var rowsN = Math.max(2, Math.round(h / BAY_H));
    var setback = h > 110 && rng.bool(0.55);
    var sbY = setback ? y0 + h * rng.range(0.55, 0.72) : y1;

    B.paint = flavour === 1 ? 'glasscity' : (flavour === 2 ? 'rawcity' : 'city');
    function facade(x0, z0, x1, z1, ya, yb, uOfs) {
      var fw = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
      var cols = Math.max(2, Math.round(fw / BAY_W));
      var rows = Math.max(2, Math.round((yb - ya) / BAY_H));
      var a = P(x0, ya, z0), b = P(x1, ya, z1), c = P(x1, yb, z1), e = P(x0, yb, z0);
      B.add('city', quadGeo(a, b, c, e, uOfs, vO, uOfs + cols / CITY_GRID, vO + rows / CITY_GRID), null);
    }
    var top = setback ? sbY : y1;
    facade(-hw, -hd, hw, -hd, y0, top, uO);
    facade(hw, -hd, hw, hd, y0, top, uO + 0.375);
    facade(hw, hd, -hw, hd, y0, top, uO + 0.625);
    facade(-hw, hd, -hw, -hd, y0, top, uO + 0.125);
    if (setback) {
      var sw = hw * rng.range(0.55, 0.78), sd = hd * rng.range(0.55, 0.78);
      facade(-sw, -sd, sw, -sd, sbY, y1, uO + 0.5);
      facade(sw, -sd, sw, sd, sbY, y1, uO + 0.75);
      facade(sw, sd, -sw, sd, sbY, y1, uO + 0.25);
      facade(-sw, sd, -sw, -sd, sbY, y1, uO + 0.875);
      B.add('city', quadGeo(P(-hw, sbY, -hd), P(hw, sbY, -hd), P(hw, sbY, hd), P(-hw, sbY, hd),
        0, 0, 1, 1), null);
      hw = sw; hd = sd;
    }
    // roof + parapet
    B.add('city', quadGeo(P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd),
      0, 0, w / 12, d / 12), null);
    B.paint = 'paint';
    B.boxR('spandrel', w + 0.8, 1.5, 0.7, x, y1 + 0.6, z + 0, 0, yaw, 0, 0.06);
    B.add('city', quadGeo(P(-hw - 0.4, y1, -hd - 0.35), P(hw + 0.4, y1, -hd - 0.35),
      P(hw + 0.4, y1 + 1.5, -hd - 0.35), P(-hw - 0.4, y1 + 1.5, -hd - 0.35), 0, 0, 1, 0.12), null);
    // roof furniture: thin and TALL, because a 1 m cube at 300 m is nothing
    B.paint = 'city';
    var n = rng.int(2, 5);
    for (var q = 0; q < n; q++) {
      var jx = rng.range(-hw * 0.7, hw * 0.7), jz = rng.range(-hd * 0.7, hd * 0.7);
      var kind = rng.next();
      if (kind < 0.34) {
        var ph = rng.range(4, 9), pw = rng.range(5, 12);
        B.boxR('city_ground', pw, ph, pw * rng.range(0.6, 1.1), x + jx * ca - jz * sa, y1 + ph * 0.5,
          z + jx * sa + jz * ca, 0, yaw, 0, 0.2);
      } else if (kind < 0.62) {
        var th = rng.range(5, 11);
        B.cyl('city_ground', rng.range(1.6, 3.4), rng.range(1.6, 3.4), th,
          x + jx * ca - jz * sa, y1 + th * 0.5, z + jx * sa + jz * ca, 0, 0, 0, 8);
      } else {
        var mh2 = rng.range(9, 26);
        B.cyl('city_ground', 0.35, 0.55, mh2, x + jx * ca - jz * sa, y1 + mh2 * 0.5,
          z + jx * sa + jz * ca, 0, 0, 0, 5);
        // An obstruction light on every mast makes a red starfield. Only the
        // buildings tall enough to actually need one carry one.
        if (h > 66 && rng.bool(0.45)) {
          B.paint = 'flat';
          B.cyl('lamp_red', 0.75, 0.75, 1.2, x + jx * ca - jz * sa, y1 + mh2 + 0.8,
            z + jx * sa + jz * ca, 0, 0, 0, 6);
        }
        B.paint = 'city';
      }
    }
    B.paint = 'city';
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
      catch (e) { GAME.logError('highrise.material:' + key, e); m = null; }
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
      alphaTest: 0.45, side: THREE.DoubleSide, vertexColors: true,
      envMapIntensity: 0.8
    });
    if (!tex) { m.opacity = 0.30; m.transparent = true; m.alphaTest = 0; }
    this._anisotropy(tex, 4);
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
      roughness: key === 'shell' ? 0.68 : 0.86,
      metalness: key === 'shell' ? 0.25 : 0.10,
      vertexColors: true,
      envMapIntensity: key === 'shell' ? 1.25 : 0.55
    });
    if (_cityEmis) {
      m.emissiveMap = _cityEmis;
      m.emissive = new THREE.Color(1, 1, 1);
      // Far enough down that the haze eats most of it; high enough that what
      // survives is unmistakably a lit window. NOT higher: the emissive is what
      // the frame's auto-exposure ends up metering on, and a city that meters
      // brighter than the sky it sits under inverts the whole image.
      m.emissiveIntensity = key === 'shell' ? 0.85 : 1.05;
    }
    this._anisotropy(tex, 8);
    m.name = 'highrise_' + key;
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
          baseY: CITY_Y + 2.0,
          heightScale: 260.0,
          density: 0.0026,
          startDistance: 3.0,
          // 0.93, not 0.86. Nothing inside 450 m ever reaches the cap, so this
          // is purely about the far rim: at 0.86 the outermost 150 m of city
          // kept 14% of its own dark albedo and drew a straight horizontal seam
          // against the sky, which is the "perfectly straight anything" the
          // instant-fail list means. At 0.93 the rim dissolves.
          maxOpacity: 0.93,
          // 0.55, not 0.70. Two of the five framings look within 20 degrees of
          // the sun's azimuth, and at 0.70 the Henyey-Greenstein lobe put so
          // much forward scatter into those frames that the city 176 m below
          // came back as featureless warm cream. Forward scatter is the depth
          // cue here, not the subject.
          mieG: 0.55,
          glowGain: 0.85,
          desaturate: 0.24     // distance eats chroma before it eats luminance
        });
      }
      // 78 m of cascade over a 68 m plate is the whole building; without this
      // the CSM would try to cover a 600 m frustum and the column shadows -
      // the level's subject - would arrive soft and low-resolution.
      if (ctx && ctx.lighting && typeof ctx.lighting.setShadowDistance === 'function') {
        ctx.lighting.setShadowDistance(78);
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
  var FESTOON = [
    // [x0, z0, x1, z1, bulbs, sag]
    [X0 + 3.0, 6.0, CORE_X0 - 1.5, 6.0, 5, 0.42],
    [X0 + 3.0, -12.0, CORE_X0 - 1.5, -12.0, 5, 0.42],
    [-6.0, Z1 - 3.0, -6.0, Z0 + 3.0, 5, 0.46]
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
        push('hr_festoon_' + i + '_' + k, 'tungsten', bx, by - 0.04, bz,
          2450, 5.4, 13.0, 1.15, [bx, plateY(bx, bz, N), bz], { haloGain: 0.85 });
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
      push('hr_lobby_' + i, 'fluoro', lx, 3.36, lz, 4300, 4.2, 9.0, 1.30,
        [lx, 0, lz], { haloGain: 0.55, haloMax: 1.5 });
    }

    // ---- halogen site floods on tripods -------------------------------------
    // The one warm-white source with any throw. Aimed ACROSS the shaded half of
    // the plate rather than down, so they model the columns instead of pooling
    // at their own feet.
    var FLOODS = [
      [-1.6, 10.8, 1.90, [-16.0, 1.2, 2.0], 3350],
      [6.2, -6.4, 1.85, [-6.0, 1.4, -17.0], 3350],
      [19.6, 5.2, 1.80, [11.0, 1.6, -8.0], 3200]
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
      push('hr_flood_' + i, 'halogen', fx, gy0 + fy, fz, fl[4], 15.0, 30.0, 0.62,
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
      push('hr_shaft_' + i, 'tungsten', sx3, 0.95, sz3, 2700, 6.5, 11.0, 0, null,
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
      push('hr_below', 'tungsten', vx, LOWER_Y + 1.30, vz, 2600, 9.0, 14.0, 0, null,
        { haloGain: 0.9, haloMax: 2.4 });
    })();

    // ---- the crane cab and the site cabin -----------------------------------
    push('hr_cabin', 'tungsten', 23.0, 1.60, 14.3, 2900, 5.0, 9.0, 0, null,
      { haloGain: 0.7, haloMax: 1.8 });
    push('hr_stair', 'fluoro', (STR_X0 + STR_X1) * 0.5, 3.20, -6.0, 4200, 3.4, 7.5, 0, null,
      { haloGain: 0.5, haloMax: 1.4 });
    B.paint = 'flat';
    B.cyl('lamp_glass', 0.06, 0.06, 0.16, (STR_X0 + STR_X1) * 0.5, 3.20, -6.0, 0, 0, 0, 8);
    B.paint = 'steel';

    this.practicalLights = lamps;

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
      if (key === 'city' || key === 'city_ground' || key === 'city_light') {
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
    var col = new Float32Array(Nv * 3);
    var noise = this.noise;
    var surf = SURF[key] || SURF.slab;
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
        if (mode !== 'glasscity' && mode !== 'rawcity') mode = 'city';
      } else if (key === 'shell') { mode = 'shell'; }
      else if (key === 'city_ground') { mode = 'cityground'; }
      else if (key === 'debris_net') { mode = 'net'; }
      else if (key === 'sheeting') { mode = 'sheet'; }
      else if (key === 'glazing') { mode = 'glass'; }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
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
          if (mode === 'joint') { gm = M.saturate(gm + 0.36); wet = M.saturate(wet * 0.4 + 0.30); pol *= 0.3; }
          r = 1 - gm * 0.66; g = 1 - wet; b = 1 - pol;
        } else if (mode === 'soffit') {
          // A soffit is DARKER than its floor: it never sees the sky, it holds
          // the form release agent, and it stains from every penetration. It is
          // also the top third of every framing, so its value is what keeps
          // vertical_imbalance under control.
          var down = M.saturate(-ny);
          var gs = M.saturate(0.20 + 0.30 * (noise.fbm3(x * 0.24, y * 0.5, z * 0.24, 3) * 0.5 + 0.5) +
            down * 0.14);
          // form-face blotching: ply that had been used four times
          gs += M.smoothstep(0.58, 0.92, noise.fbm2(x * 0.55 + 9, z * 0.55 - 3, 2) * 0.5 + 0.5) * 0.16;
          var es = M.smoothstep(0.62, 0.94, noise.fbm3(x * 0.9, y * 0.8, z * 0.9, 2) * 0.5 + 0.5) * 0.20;
          r = 1 - M.saturate(gs) * 0.62; g = 1; b = 1 - es;
        } else if (mode === 'wall') {
          // Shear walls and columns. Lift lines, honeycombing at the base, and
          // the grey film that climbs the first metre off the floor.
          var gw = M.saturate(0.12 + 0.26 * (noise.fbm3(x * 0.34, y * 0.34, z * 0.34, 3) * 0.5 + 0.5));
          gw += M.smoothstep(1.1, 0.02, y) * 0.24;                 // splash zone
          gw += M.smoothstep(0.55, 0.92, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 1.9,
            y * 0.16, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny)) * 0.20;
          var ew = M.smoothstep(0.66, 0.95, noise.fbm3(x * 1.1, y * 0.9, z * 1.1, 2) * 0.5 + 0.5) * 0.26;
          ew += M.saturate(ny) * 0.10;                             // arrises catch the light
          r = 1 - M.saturate(gw) * 0.62; g = 1; b = 1 - M.saturate(ew);
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
          var warm = M.smoothstep(0.15, 0.85, hgt);
          var band = 0.52 + 0.42 * warm;
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
          band *= 0.74 + pn * 0.52;
          r = band * 1.24; g = band * 0.99; b = band * 0.86;
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
        } else if (mode === 'city' || mode === 'glasscity' || mode === 'rawcity') {
          // ---- AERIAL PERSPECTIVE, in the albedo --------------------------------
          // The fog does the atmosphere. What it cannot do is make a distant
          // block DIFFERENT from a near one in value and chroma before the fog
          // even runs, and without that the city is one material seen through
          // varying amounts of grey. So: value falls with distance, chroma falls
          // with distance, and every block gets its own concrete/glass tint.
          var rr = Math.sqrt(x * x + z * z);
          var far = M.saturate(rr / CITY_R);
          var vv = 0.64 + (noise.fbm2(x * 0.012 + 3.0, z * 0.012 - 7.0, 2) * 0.5 + 0.5) * 0.40;
          // the last sun is still on the west and north faces
          var lam = M.saturate(nx * SUN_X + nz * SUN_Z) * (1 - far * 0.55);
          vv *= 1 + lam * 0.62;
          // and the shaded faces go blue, which is what makes a hazy city read
          // as DEEP rather than as flat
          var shade = M.saturate(-(nx * SUN_X + nz * SUN_Z));
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
          } else {
            r = vv * (1.05 + lam * 0.22 - shade * 0.10);
            g = vv * (0.99 - shade * 0.02);
            b = vv * (0.92 - lam * 0.12 + shade * 0.20);
          }
          // and a slow desaturation toward the rim so the far city is one value
          var mix = far * 0.55;
          var lum = (r + g + b) / 3;
          r = M.lerp(r, lum, mix); g = M.lerp(g, lum, mix); b = M.lerp(b, lum, mix);
          // never let a roof go to nothing - a black city under a bright sky is
          // a silhouette, not a city
          var up = M.saturate(ny);
          r += up * 0.10; g += up * 0.10; b += up * 0.12;
        } else if (mode === 'shell') {
          // Our own tower. Same map, but it is 20 m away rather than 300, so it
          // keeps its value and gets the strong directional read the sun gives a
          // glass box at this hour.
          var lamS = M.saturate(nx * SUN_X + nz * SUN_Z);
          var vs = 0.78 + (noise.fbm2(x * 0.05, y * 0.02, 2) * 0.5 + 0.5) * 0.30;
          vs *= 1 + lamS * 0.95;
          // the streaking every tall building has under its floor bands
          vs *= 1 - M.smoothstep(0.62, 0.95,
            noise.fbm2(x * 0.9 + z * 0.9, y * 0.055, 3) * 0.5 + 0.5) * 0.22;
          r = vs * (1.10 + lamS * 0.30); g = vs * 0.99; b = vs * (0.90 - lamS * 0.14);
        } else if (mode === 'cityground') {
          // The street plane AND the rooftop plant that shares its material.
          // Dark, but never black - a city floor at sunset is full of sodium and
          // headlights, and the lower third of three framings is made of it.
          var rg2 = Math.sqrt(x * x + z * z);
          var vg = 0.56 + (noise.fbm2(x * 0.022 + 5, z * 0.022 - 2, 3) * 0.5 + 0.5) * 0.38;
          vg += (noise.fbm2(x * 0.11 - 3, z * 0.11 + 8, 2) * 0.5 + 0.5) * 0.18;
          // rooftop plant sits hundreds of metres up and is lit, not shadowed
          var roofF = M.smoothstep(CITY_Y + 12, CITY_Y + 40, y);
          vg *= 1 + roofF * 0.55;
          vg *= 1 - M.smoothstep(320, 900, rg2) * 0.16;
          var lamG = M.saturate(nx * SUN_X + nz * SUN_Z) * roofF;
          r = vg * (1.06 + lamG * 0.30); g = vg * 0.98; b = vg * (0.94 - lamG * 0.14);
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
          col[j] = M.saturate(r); col[j + 1] = M.saturate(g); col[j + 2] = M.saturate(b);
        } else {
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
        }
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
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
    // floor 46, under the void, reachable by the temporary stair
    R.push({ x0: VOID_X0 - 9, x1: VOID_X1 + 9, z0: VOID_Z0 - 8, z1: VOID_Z1 + 8, y: LOWER_Y });
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
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
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
    function sp(x, z, yaw) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + 0.02, z), yaw: yaw
      });
    }
    // [0] is the player: in the shade at the mouth of the core lobby, looking
    // west-north-west up the open run into the light. Every level should open on
    // its own best idea, and this level's idea is "look at that".
    sp(4.0, 13.4, -0.62);
    sp(-6.0, 8.5, -0.30);    sp(-16.0, 2.0, 0.90);
    sp(-22.0, -10.0, 1.80);  sp(-10.5, -17.5, 2.60);
    sp(2.0, -17.0, -2.60);   sp(14.0, -16.0, -1.40);
    sp(24.0, -6.0, -1.90);   sp(24.5, 8.0, 2.40);
    sp(10.5, 6.0, 0.20);     sp(10.5, -7.0, 3.10);
    sp(-2.0, 18.0, -1.10);   sp(-20.0, 17.5, -1.60);
    sp(-24.0, 10.0, 1.30);

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
    // RE-SOLVED, and the reason the first mark failed is the whole lighting
    // lesson of this level. It stood 30 m INBOARD, in the shade, looking out at
    // the openings. From there the openings are small, distant and four stops
    // over the floor, so the frame metered on a dark plate with three white
    // rectangles in it: no rake, no shadows, no city - the sunlight was 25 m
    // away and edge-on to the lens.
    //
    // The eye now stands IN THE LIGHT, 3.6 m off the north edge, and looks EAST
    // along the sunlit strip:
    //
    //   * the sun is 135 degrees behind the left shoulder at 8.8 degrees of
    //     elevation, so the whole floor from here to the scaffold is lit and
    //     every column between is modelled - lit left face, black right face
    //   * six columns on the z = -16 and z = -8 grid lines throw 25 m shadows
    //     that run forward and slightly right, converging toward the vanishing
    //     point: the leading line IS the shadows
    //   * the open north edge runs away down the left of frame with its posts,
    //     guard rails and orange netting in silhouette, and the hazed city
    //     beyond it - the drop, without having to pitch down for it
    //   * the scaffold and hoist close the far end at 45 m as a lattice against
    //     the sky, and the soffit's downstand beams cap the top third
    //   * no sun disc, no white rectangle: the brightest thing in the frame is
    //     concrete at grazing incidence, which is what the level is made of
    gy = this.sampleGround(-18.5, -17.4);
    var hero1 = pose(-18.5, gy + 1.72, -17.4, 16.0, -2.05, -19.5);

    // ---- HERO2 : the curtain wall ------------------------------------------
    // Inside the glazed south-west corner, looking north along the installed
    // facade. The sun is 44 degrees to the LEFT and therefore BEHIND the glass,
    // so the wall is a grid of black mullions on a burning sheet, its shadow
    // pattern is laid across the slab toward the camera, and the run of
    // mullions is the leading line straight out to where the glazing stops and
    // the open edge begins. Different space, different depth, different subject.
    // RE-SOLVED: the first mark put the column at (-22.5, 16) 2.8 m dead ahead,
    // so an 0.86 m concrete post filled the middle of the frame and the run it
    // was supposed to be looking down was on either side of it. From 2.4 m off
    // the glass the same column row becomes the RIGHT wall of a corridor and
    // the glazing becomes the left one.
    gy = this.sampleGround(-24.6, 18.4);
    var hero2 = pose(-24.6, gy + 1.68, 18.4, -25.6, 2.05, -8.0);

    // ---- HERO3 : the drop ---------------------------------------------------
    // At the missing guard-rail bay on the north edge, pitched 34 degrees down
    // over 176 m of air.
    //
    //   * foreground: the slab edge with its starter bars and the snapped post,
    //     inside 2 m and hard against the light
    //   * the crane's mast is a vertical on the left third and its jib crosses
    //     the top of the frame - the diagonal that stops this being two
    //     horizontal bands
    //   * the whole lower two thirds is city, at 300-450 m, under real aerial
    //     perspective, with the street grid and its lights running away
    //   * the sun is 16 degrees off the azimuth, so the forward-scatter lobe
    //     lifts the haze without the disc ever entering the frame
    //
    // The pitch is 25 degrees, not 35, and that is geometry rather than taste.
    // Standing 3.8 m back from a 340 mm slab edge, ANY sightline steeper than
    // about 35 degrees hits your own floor - so a steeper pitch does not show
    // you more of the drop, it shows you more concrete. 25 degrees puts the
    // street 380 m out, which is where the haze is doing its best work.
    //
    // The BEARING is solved against the light rather than against the view: an
    // earlier mark looked 16 degrees off the sun's azimuth, and looking into a
    // low sun means every shadow on the floor points at the lens, so the whole
    // near half of the frame was the shaded side of everything. At 79 degrees
    // the plate is cross-lit, the guard-rail posts and their shadows alternate
    // down the edge, and the sun is still nowhere near the frame.
    gy = this.sampleGround(-11.5, -18.9);
    var hero3 = pose(-11.5, gy + 1.62, -18.9, 8.0, -13.0, -48.0);

    // ---- INTERIOR : the lift lobby -----------------------------------------
    // A 20 m concrete tube looking north, out of the core, across the plate and
    // through the open north edge. Dark tube, bright end - and the two open lift
    // shafts on the right, each with a worklight a metre down it, are the only
    // things in the level that are lit from BELOW.
    var interior = pose((LOB_X0 + LOB_X1) * 0.5 - 0.20, 1.66, 6.8,
      (LOB_X0 + LOB_X1) * 0.5 - 0.75, 2.30, -19.0);

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
    // RE-SOLVED. The first mark stood 7.8 m off the crane's mast, which put a
    // 2 m lattice column dead down the centre of the frame with the entire
    // building behind it. From 55 m out and 22 m north the same mast sits 34
    // degrees left - a vertical on the left third, framing rather than
    // blocking - and 22 m of eye height finally gets over the plate's own
    // parapet to see INTO the floor.
    var overview = pose(-22.0, 16.0, -74.0, 2.0, -6.0, -2.0);

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
        if (sk && typeof sk.setTimeOfDay === 'function' && sk.sunWorldDirection &&
            sk.sunWorldDirection.y <= 0.005) {
          sk.setTimeOfDay(TIME_OF_DAY);
        }
      } catch (e) { GAME.logError('highrise.hour', e); }
    }

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
