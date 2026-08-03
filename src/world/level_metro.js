// ============================================================================
// OPERATION BLACKOUT - src/world/level_metro.js  ->  GAME.LevelMetro
//
// "LINE 4 - ZARECHNAYA": an abandoned, flooded deep-level pylon station and its
// running tunnels. There is NO SKY. Every photon in this level comes from a
// failing fluorescent, a red emergency strip, a rigged worklight or the dim
// neutral probe sky.js leaves behind for the 'none' preset - which is why the
// level publishes a full `practicalLights` rig and four `lightShafts` rather
// than expecting a light rig it cannot see to find it.
//
// THE PLAN, in world coordinates (the station runs EAST-WEST along X):
//
//   x = -72 .. -40    west running tunnels, flooded, emergency strips
//   x = -40 .. +30    THE STATION HALL, 70 m long
//        |z| < 5.15       island platform, deck at y = 1.10
//        |z| = 4.25-5.15  the PYLON ARCADE - ten piers a side at 6 m pitch,
//                         3.4 m openings looking out over the tracks
//        |z| = 5.15-9.80  the two track halls, trackbed at y = 0, 26 cm of
//                         standing water at y = 0.26
//        z = -6.60        north track: the DERAILED TRAIN. The lead car has
//                         ridden up through the arcade and its nose is resting
//                         on the platform, two piers demolished behind it
//   x = +30 .. +58    escalator hall: lower landing, a three-lane incline
//                     climbing 7.5 m at 30 degrees, upper landing at y = 8.60
//   x = +30 .. +54    east running tunnels, the rest of the train inside them
//
// Vertical: trackbed 0, platform 1.10, arcade springing 4.20, platform vault
// crown 6.60, track hall crown ~4.65, escalator upper landing 8.60.
//
// ============================================================================
// WHY THIS FILE LOOKS THE WAY IT DOES
// ============================================================================
// * Everything static is authored into per-material buckets and merged ONCE
//   with GAME.Geo.mergeAll, so the whole station is ~20 draw calls. The two
//   emissive families (fluorescent diffusers, red strips) are InstancedMesh
//   with per-instance colour instead, because each tube has to fail on its own
//   schedule - one shared emissive material would flicker all forty in unison,
//   which reads as a screen effect rather than as a dying fitting.
//
// * The floor is painted with materials.js's VERTEX WEAR convention (white =
//   pristine, R = grime, G = wetness, B = edge wear). G is the whole point
//   here: it takes roughness to 0.09 and albedo to x0.48, which is what turns
//   the platform granite into the black mirror the brief asks for WITHOUT
//   needing the harbour's wet-surface shader (materials.wetEnabled is false on
//   this level - it is gated on levelDef.weather, and the metro has none).
//   Wetness is derived from an analytic dip field so sampleGround, the navgrid,
//   the puddle placer and the paint pass can never disagree about where the low
//   spots are.
//
// * There is no screen-space reflection outside the harbour, so "standing water
//   reflecting the emergency strips" is bought three ways at once: the strips
//   are real SpotLights whose specular lands on roughness-0.09 water; the water
//   material's own animated wave normals smear that specular into a streak
//   instead of a dot; and each strip lays an additive GLINT CARD on the water
//   below it, stretched along the tunnel axis - which is the axis every camera
//   in this level looks down, so the smear is correct from where it is seen.
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// props_metro.js and anyone else placing against this station reads ANCHORS,
// never camera poses. A pose is a composition and moves whenever the
// composition improves; an anchor is the station's own survey and is derived
// from the same constants the geometry is. Available immediately after
// `new LevelMetro(ctx)` - you do not have to wait for build().
//
//   anchors.hall          { x0,x1, platY, trackY, waterY, edgeZ, hallHz,
//                           crown, spring, groundY(x,z) }
//   anchors.platform      { x0,x1, hz, y, centre, westEnd, eastEnd,
//                           edgeN, edgeS, tactileZ }
//   anchors.arcadeN/S     { faceZ, backZ, topY, piersX[], openingsX[],
//                           brokenX[], sign }
//   anchors.trackN/S      { cz, railY, waterY, x0, x1, sign }
//   anchors.tunnelW/E     { cz[], portalX, endX, r, axisY, invertY,
//                           mouthN, mouthS, dir }
//   anchors.train         { cars:[{name,centre,yaw,roll,pitch,len,halfW,
//                           floorY,roofY,walkable}], nose, impact, spill }
//   anchors.escalator     { x0,x1,hz, footY, headY, incX0,incX1, lanes[],
//                           foot, head, yaw, axis }
//   anchors.balcony       { centre, y, x0,x1, hz, yaw, stairFoot }
//   anchors.ventShaft     { centre, r, ceilY, pool }
//   anchors.collapse      { centre, x0,x1, z0,z1, rubble }
//   anchors.crossPassage  { centre, x, hz }
//   anchors.lamps         [ { name, kind, pos:Vector3, aim:Vector3, cone } ]
//   anchors.spawn         { centre, yaw }
//
// Also published, both consumed generically by lighting.js:
//   level.practicalLights  the full lamp rig, most-important-first (the module
//                          caps a declarative level at 24 and truncates the
//                          TAIL, so ordering is load bearing).
//   level.lightShafts      four real apertures: the vent shaft over the
//                          platform, the escalator tube, the west tunnel
//                          worklight and the spill through the east arch.
//   level.litWindows       additive glow cards on every fitting, so a lamp
//                          always has a visible source even edge-on.
//   level.waterPlane       { y, x0, x1, z0, z1 } for anyone placing impacts.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ------------------------------------------------------------------ layout --
  var HALL_X0 = -40.0, HALL_X1 = 30.0;    // station hall end walls
  var PLAT_Y = 1.10;                      // platform deck
  var TRACK_Y = 0.0;                      // trackbed datum (top of ballast)
  var RAIL_Y = 0.16;                      // railhead
  var WATER_Y = 0.26;                     // standing water surface, everywhere
  var PLAT_EDGE = 5.15;                   // platform edge / arcade outer face
  var ARC_BACK = 4.25;                    // arcade inner face (pier is 0.9 deep)
  var TRK_CZ = 6.60;                      // track centre line, both sides
  var HALL_HZ = 9.80;                     // outer wall of each track hall
  var ARC_TOP = 4.20;                     // arcade cornice / vault springing
  var ARC_HEAD = 3.30;                    // springing of the arcade opening head
  var CROWN = 6.60;                       // platform vault crown
  var TRK_CROWN_R = 1.05;                 // rise of the track hall vault
  var TRK_SPRING = 3.00;                  // track hall vault at the outer wall

  // The arcade. Ten piers a side; the two the train demolished are listed
  // separately so the wreck, the rubble and the navgrid all agree about which.
  var PIERS_X = [-33, -27, -21, -15, -9, -3, 3, 9, 15, 21];
  var BROKEN_X = [-3, 3];
  var PIER_HW = 1.30;                     // half width along x
  var ARC_X0 = -34.30, ARC_X1 = 22.30;    // solid end bays outside this

  // Running tunnels
  var TUN_R = 2.75;
  var TUN_AXIS_Y = 1.95;
  var TUN_INV = -0.12;                    // invert fill: 38 cm of water
  var TUN_W_END = -72.0;
  var TUN_E_END = 54.0;

  // Escalator hall
  var ESC_X0 = 30.0, ESC_X1 = 58.0;
  var ESC_HZ = 6.20;
  var ESC_HEAD_Y = 8.60;
  var ESC_INC_X0 = 39.0, ESC_INC_X1 = 52.0;
  var ESC_LANES = [-2.40, 0.0, 2.40];
  var ESC_BORE_R = 3.60;

  // The overlook balcony at the head of the platform hall - the `overview`
  // stand, and a real structure rather than a floating camera.
  var BAL_X0 = 27.40, BAL_X1 = 30.0, BAL_HZ = 3.40, BAL_Y = 3.90;

  // The vent shaft over the platform, and the collapse over the crash.
  var VENT_X = -9.00, VENT_Z = 3.20, VENT_R = 1.35;
  var COL_X0 = -8.5, COL_X1 = 1.5, COL_Z0 = -5.15, COL_Z1 = -1.20;

  // Cross passage: a short connection under the platform is out of scope, but
  // the mid-platform recess where it would surface is a real widening and it is
  // what stops 70 m of arcade being one unbroken rhythm.
  var CROSS_X = -21.0;

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------- surfaces --
  // `uv` is world-metres -> uv for the post-merge Geo.worldUV pass. `wear: true`
  // asks materials.js for the VERTEX WEAR shader; everything else takes
  // wearMode 'multiply', where the colour attribute is a plain albedo
  // multiplier. `base` is a name materials.js certainly HAS - every request is
  // made through lib.has() first, so a name this library has never heard of can
  // never silently resolve to a plausible piece of concrete.
  var SURF = {
    // The platform deck: granite slabs, polished by forty years of feet and
    // now under a film of water. The single largest surface in four of the five
    // framings, so its wear mask sets those frames' exposure on its own.
    plat_floor:   { uv: 0.42, cast: false, recv: true,  wear: true,
                    base: 'stone', col: 0x6f6d68, rough: 0.72 },
    // Glazed wall tile. polish 0.78 in the library is what puts the glaze back
    // on the faces while the grout stays matte - the one interior surface that
    // legitimately has a hot highlight.
    wall_tile:    { uv: 2.40, cast: true,  recv: true,  wear: true,
                    base: 'tile', col: 0xb4b2a4, rough: 0.58 },
    // The dado band. Deliberately NOT a tint on wall_tile: a wear mask and an
    // albedo multiplier cannot share one colour attribute, and the sickly green
    // band at knee-to-shoulder height is half of this level's palette.
    dado_paint:   { uv: 0.80, cast: true,  recv: true,  wear: false,
                    base: 'paint_green', col: 0x516349, rough: 0.62, metal: 0.10 },
    // Vault soffit and coffers, painted plaster, peeling.
    vault_plaster:{ uv: 0.44, cast: true,  recv: true,  wear: true,
                    base: 'plaster', col: 0xa9a698 },
    // Cast tunnel lining segments and the track hall walls.
    tunnel_seg:   { uv: 0.42, cast: true,  recv: true,  wear: true,
                    base: 'concrete_wall', col: 0x8d8b83 },
    // Structure, trackbed, plinths, stairs, rubble.
    raw_concrete: { uv: 0.36, cast: true,  recv: true,  wear: true,
                    base: 'concrete', col: 0x8f8b82 },
    ballast:      { uv: 0.75, cast: false, recv: true,  wear: true,
                    base: 'gravel', col: 0x5d5a54 },
    // Rail, fixings, brackets, cable tray, the wreck's torn steel.
    rust_metal:   { uv: 0.95, cast: true,  recv: true,  wear: false,
                    base: 'rusted_metal', col: 0x7a4a33, rough: 0.74, metal: 0.62 },
    // Painted steel: train body, door frames, handrails.
    car_paint:    { uv: 0.72, cast: true,  recv: true,  wear: false,
                    base: 'painted_metal', col: 0x8d9298, rough: 0.46, metal: 0.72 },
    // Fluted aluminium flanks. The rib pitch is the library's, not mine.
    car_alu:      { uv: 1.05, cast: true,  recv: true,  wear: false,
                    base: 'corrugated_metal', col: 0x9a9d9f, rough: 0.40, metal: 0.86 },
    // Escalator decking, balustrade skirts, the gantry.
    deck_steel:   { uv: 0.34, cast: true,  recv: true,  wear: false,
                    base: 'structural_steel', col: 0x6d7278, rough: 0.48, metal: 0.80 },
    grate:        { uv: 1.25, cast: false, recv: true,  wear: true,
                    base: 'steel_grate', col: 0x55524c, rough: 0.70, metal: 0.72 },
    glass_dirty:  { uv: 1.60, cast: false, recv: false, wear: false,
                    base: 'glass', col: 0x7d8890, rough: 0.24, metal: 0.0 },
    panel_plastic:{ uv: 1.15, cast: true,  recv: true,  wear: false,
                    base: 'plastic', col: 0x7d7566, rough: 0.58, metal: 0.0 },
    cable_rubber: { uv: 1.55, cast: true,  recv: true,  wear: false,
                    base: 'rubber', col: 0x2c2e30, rough: 0.88, metal: 0.0 },
    paint_line:   { uv: 0.70, cast: false, recv: true,  wear: true,
                    base: 'painted_line', col: 0xcfc39c, rough: 0.80, metal: 0.0 },
    // ------------------------------------------------------------------------
    // THE FLOOD, and it is NOT materials.water().
    //
    // It was, for two rounds. water() is a WATER BODY: absorption down the view
    // path, a Fresnel that hands everything to the specular at grazing angles,
    // and no diffuse worth the name. That is exactly right for the harbour,
    // which has a sky to reflect and (harbour-only) screen-space reflection to
    // reflect it with. Down here there is neither. Measured: along a tunnel the
    // view path is grazing everywhere, the body resolved to the in-scatter tint
    // at about 0.008 linear, the specular had nothing but a 0.02-irradiance
    // probe to return, and the invert of a lit bore photographed as a black
    // hole - proven by swapping the same geometry to plaster, which lit fine.
    //
    // So the flood is authored as what it physically is at 20-40 cm: a WET
    // FLOOR. materials.js's vertex wear contract does this exactly - G drives
    // albedo x0.48 and roughness to 0.09 - so it stays a dark, glossy, DIFFUSE-
    // LIT surface that returns the strips as streaks instead of a void. It is
    // also what the brief asks for in as many words.
    // ------------------------------------------------------------------------
    flood_water:  { uv: 0.30, cast: false, recv: true, wear: true,
                    base: 'wet_concrete', col: 0x2c3230, rough: 0.10 },
    // This file's own alpha-tested signage / grime / graffiti atlas.
    decal:        { uv: 1.0, cast: false, recv: true,  wear: false,
                    own: true, keepUV: true },
    // Additive glint cards laid on the water under every strip. Own material.
    glint:        { uv: 1.0, cast: false, recv: false, wear: false,
                    own: true, keepUV: true }
  };

  // If materials.js is missing entirely the station must still read as a
  // flooded concrete tunnel rather than as magenta error boxes.
  var FALLBACK = {
    plat_floor:   [0x55534e, 0.62, 0.0],
    wall_tile:    [0x9d9b8e, 0.44, 0.0],
    dado_paint:   [0x4a5b43, 0.62, 0.10],
    vault_plaster:[0x8b887c, 0.88, 0.0],
    tunnel_seg:   [0x6e6c65, 0.90, 0.0],
    raw_concrete: [0x6a6760, 0.92, 0.0],
    ballast:      [0x46443f, 0.96, 0.0],
    rust_metal:   [0x6b4130, 0.78, 0.55],
    car_paint:    [0x7d838a, 0.46, 0.62],
    car_alu:      [0x8b8e90, 0.40, 0.80],
    deck_steel:   [0x60656b, 0.50, 0.72],
    grate:        [0x4c4944, 0.72, 0.66],
    glass_dirty:  [0x5b666e, 0.20, 0.0],
    panel_plastic:[0x6d6659, 0.58, 0.0],
    cable_rubber: [0x24262a, 0.90, 0.0],
    paint_line:   [0xbfb597, 0.80, 0.0],
    flood_water:  [0x0a1210, 0.09, 0.0],
    decal:        [0xffffff, 0.80, 0.0],
    glint:        [0xffffff, 1.00, 0.0]
  };

  // ----------------------------------------------------------- small helpers --
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

  // Slightly bevelled boxes, cached by dimension. A perfectly sharp 90 degree
  // edge never catches a highlight, and in a level lit entirely by small
  // fixtures the edge highlight is most of what describes a shape at all.
  var _boxCache = new Map();
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.011, Math.min(w, h, d) * 0.26);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) {
      var src = Geo.bevelBox(w, h, d, bevel);
      g = src.toNonIndexed(); src.dispose();
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

  // A flat quad in the XY plane facing +Z. Decal cards, glint cards, water.
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

  // Keep a tint bright (it multiplies albedo) but shift its hue.
  function tint(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  // ---------------------------------------------------------------------------
  // SWEEPS.  Every vaulted surface in this station - the platform vault, the
  // two track hall vaults, the running tunnel bores, the escalator tube - is one
  // 2D profile in the ZY plane pushed along X. Two things make this worth having
  // rather than reaching for CylinderGeometry:
  //
  //  1. NORMALS ARE ANALYTIC, not averaged off triangles. A tunnel bore built
  //     from face normals has a visible facet band under every strip light,
  //     because a strip light is a raking source and the eye reads the second
  //     derivative of the shading. The per-vertex normal here comes from the
  //     profile's own tangent, so a 20-segment bore shades like a smooth one.
  //  2. A QUAD CAN BE SKIPPED. `hole(x, z, y)` returning true drops that quad,
  //     which is how the vault gets its collapse and its vent shaft opening
  //     without any CSG.
  //
  // Winding is (i,j) (i+1,j) (i+1,j+1) with x INCREASING and the profile ordered
  // by INCREASING angle (bores) or INCREASING z (vaults); that combination is
  // what makes the resulting normal point into the room rather than out of it.
  // Get either backwards and the surface is invisible from inside, which is a
  // silent failure - the frame simply has no ceiling in it.
  // ---------------------------------------------------------------------------
  function sweepX(prof, x0, x1, nx, hole, jitter) {
    var np = prof.length;
    if (np < 2 || nx < 1) return null;
    // per-profile-point normals from central differences
    var pn = [];
    var j, i;
    for (j = 0; j < np; j++) {
      var a = prof[Math.max(0, j - 1)], b = prof[Math.min(np - 1, j + 1)];
      var dz = b[0] - a[0], dy = b[1] - a[1];
      var l = Math.sqrt(dz * dz + dy * dy) || 1;
      pn.push([-dz / l, dy / l]);          // (ny, nz) = (-dz, dy)
    }
    var pos = [], nor = [];
    var dx = (x1 - x0) / nx;
    for (i = 0; i < nx; i++) {
      var xa = x0 + i * dx, xb = xa + dx;
      for (j = 0; j < np - 1; j++) {
        var p0 = prof[j], p1 = prof[j + 1];
        var n0 = pn[j], n1 = pn[j + 1];
        // a small settlement wobble so a 70 m vault is not a ruled extrusion
        var wa = jitter ? jitter(xa, p0[0]) : 0;
        var wb = jitter ? jitter(xb, p0[0]) : 0;
        var wc = jitter ? jitter(xb, p1[0]) : 0;
        var wd = jitter ? jitter(xa, p1[0]) : 0;
        if (hole && hole((xa + xb) * 0.5, (p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)) continue;
        // v00 v10 v11 / v00 v11 v01
        pos.push(xa, p0[1] + wa, p0[0], xb, p0[1] + wb, p0[0], xb, p1[1] + wc, p1[0]);
        nor.push(0, n0[0], n0[1], 0, n0[0], n0[1], 0, n1[0], n1[1]);
        pos.push(xa, p0[1] + wa, p0[0], xb, p1[1] + wc, p1[0], xa, p1[1] + wd, p1[0]);
        nor.push(0, n0[0], n0[1], 0, n1[0], n1[1], 0, n1[0], n1[1]);
      }
    }
    if (!pos.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // A segmental vault: from (z0,y0) to (z1,y1) with `rise` at the crown. The
  // 0.80 exponent is not decoration - a pure sine springs at 36 degrees, which
  // reads as a shallow dome; 0.80 stands the springing up near vertical where it
  // meets the arcade cornice, which is what a real pylon station's vault does.
  function vaultProfile(z0, z1, y0, y1, rise, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var s = Math.pow(Math.sin(Math.PI * t), 0.80);
      out.push([z0 + (z1 - z0) * t, y0 + (y1 - y0) * t + rise * s]);
    }
    return out;
  }

  // A circular bore profile about (cz, cy), swept from -a to +a radians about
  // the crown. Ordered by increasing angle, which is what gives inward normals.
  function boreProfile(cz, cy, r, a, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var th = -a + (2 * a) * (i / n);
      out.push([cz + r * Math.sin(th), cy + r * Math.cos(th)]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // A WALL WITH ARCHED OPENINGS, built as coalesced vertical columns.
  //
  // Every end wall and every arcade bay in the station is this. The columns are
  // 0.25 m wide and runs of equal height are merged, so a 19.6 m end wall with
  // two tunnel portals in it costs about a dozen boxes rather than eighty; and
  // because the opening head is sampled per column, the arch is a real curve
  // rather than a lintel. The residual 2-3 cm stepping along the head is
  // covered by the voussoir ring archRing() lays over it.
  // ---------------------------------------------------------------------------
  function archedWall(B, key, x, thick, z0, z1, yBase, yTop, holes, step) {
    step = step || 0.25;
    var n = Math.max(1, Math.round((z1 - z0) / step));
    step = (z1 - z0) / n;
    var runY = -1, runZ0 = z0, i;
    for (i = 0; i <= n; i++) {
      var zc = z0 + (i + 0.5) * step;
      var base = yBase;
      if (i < n) {
        for (var h = 0; h < holes.length; h++) {
          var o = holes[h];
          var d = Math.abs(zc - o.cz);
          if (d < o.hw) {
            var head = o.ySpring + Math.sqrt(Math.max(0, o.r * o.r - d * d));
            if (head > base) base = head;
          }
        }
      } else {
        base = -999;                        // force the final flush
      }
      if (Math.abs(base - runY) > 1e-4 || i === n) {
        if (runY >= 0 && i > 0) {
          var za = runZ0, zb = z0 + i * step;
          if (yTop - runY > 0.02 && zb - za > 0.01) {
            B.box(key, thick, yTop - runY, zb - za, x, (yTop + runY) * 0.5, (za + zb) * 0.5);
          }
        }
        runY = base; runZ0 = z0 + i * step;
      }
    }
  }

  // The voussoir ring over an opening: real masonry, proud of the wall face, and
  // the thing that makes an arch read as an arch at eight metres.
  function archRing(B, key, x, thick, cz, cy, r, span, segs, depth, proud) {
    segs = segs || 16;
    depth = depth || 0.34;
    for (var i = 0; i < segs; i++) {
      var t0 = -span + (2 * span) * (i / segs);
      var t1 = -span + (2 * span) * ((i + 1) / segs);
      var tm = (t0 + t1) * 0.5;
      var rm = r + depth * 0.5;
      var zz = cz + rm * Math.sin(tm), yy = cy + rm * Math.cos(tm);
      var seg = 2 * rm * Math.abs(Math.sin((t1 - t0) * 0.5)) + 0.03;
      B.add(key, box(thick + (proud || 0.10) * 2, depth, seg),
        makeM(x, yy, zz, tm, 0, 0));
    }
  }

  // ---------------------------------------------------------------------------
  // THE GROUND, analytically.  One function per region so sampleGround, the
  // navgrid, the wetness paint and the puddle placer cannot disagree.
  //
  // The platform is a settled granite slab, not a plane: forty years of
  // subsidence, a fall toward both edges so it drains into the track, and the
  // slab joints between the 1.2 m courses. Water lies in the DIP - how far a
  // point sits below its own surroundings - never against an absolute plane,
  // because an absolute plane and a settling slab get out of step and then the
  // whole floor measures as submerged.
  // ---------------------------------------------------------------------------
  var SLAB_PITCH = 1.22;
  function slabJoint(x, z) {
    var a = ((x + 0.61) % SLAB_PITCH + SLAB_PITCH) % SLAB_PITCH - SLAB_PITCH * 0.5;
    var b = ((z + 0.31) % SLAB_PITCH + SLAB_PITCH) % SLAB_PITCH - SLAB_PITCH * 0.5;
    var d = 0;
    a = Math.abs(a); b = Math.abs(b);
    if (a < 0.030) d = (1 - a / 0.030) * 0.014;
    if (b < 0.030) d = Math.max(d, (1 - b / 0.030) * 0.014);
    return d;
  }

  function platDip(x, z, N) {
    // basins where the sub-base has failed
    var d = (N.fbm2(x * 0.075 + 3.1, z * 0.075 - 7.4, 3) * 0.5 + 0.5);
    var dip = M.smoothstep(0.42, 0.96, d) * 0.052;
    // the drainage fall toward both platform edges
    dip += M.smoothstep(2.6, 4.6, Math.abs(z)) * 0.030;
    // the trench of ponding along the wreck, where the slab was hammered
    dip += M.smoothstep(9.0, 2.0, Math.abs(x + 3.0)) *
           M.smoothstep(5.2, 2.2, Math.abs(z + 3.4)) * 0.055;
    return dip + slabJoint(x, z);
  }

  function platY(x, z, N) {
    var y = PLAT_Y;
    y -= (N.fbm2(x * 0.030 - 5.2, z * 0.030 + 2.8, 3) * 0.5 + 0.5) * 0.055;
    return y - platDip(x, z, N);
  }

  // The trackbed: ballast between the rails, a drainage channel on the cess
  // side, and the whole thing under water.
  function trackY(x, z, N) {
    var cz = z < 0 ? -TRK_CZ : TRK_CZ;
    var d = Math.abs(z - cz);
    var y = TRACK_Y - 0.02 - (N.fbm2(x * 0.06 + 1.7, z * 0.06 - 3.3, 2) * 0.5 + 0.5) * 0.055;
    if (d < 0.95) y += 0.055 * (1 - d / 0.95);        // ballast crown
    var cess = Math.abs(Math.abs(z) - (TRK_CZ + 2.35));
    if (cess < 0.45) y -= (1 - cess / 0.45) * 0.11;   // the drain channel
    return y;
  }

  function tunnelY(x, z, N) {
    var cz = z < 0 ? -TRK_CZ : TRK_CZ;
    var d = Math.abs(z - cz);
    var y = TUN_INV - (N.fbm2(x * 0.05 - 8.1, z * 0.05 + 4.6, 2) * 0.5 + 0.5) * 0.06;
    if (d < 0.95) y += 0.055 * (1 - d / 0.95);
    return y;
  }

  // Escalator hall: flat lower landing, the incline, flat upper landing.
  function escTreadY(x) {
    if (x <= ESC_INC_X0) return PLAT_Y;
    if (x >= ESC_INC_X1) return ESC_HEAD_Y;
    return PLAT_Y + (ESC_HEAD_Y - PLAT_Y) * (x - ESC_INC_X0) / (ESC_INC_X1 - ESC_INC_X0);
  }
  var ESC_AXIS_Y = 1.62;                  // bore axis above the tread line

  // ================================================================ Builder ==
  // A transform stack plus per-material geometry buckets. Deliberately the same
  // shape as the market's and the harbour's builders: this file follows those
  // files' patterns rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    this.paint = 'metal';
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
    if (!geo) return null;
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
  // A member between two arbitrary world points - every rib, rail and cable run.
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

  // ---------------------------------------------------------------------------
  // THE SIGNAGE ATLAS
  //
  // Soviet-era enamel signage in an INVENTED SCRIPT. The glyphs are constructed
  // from strokes rather than typed, for two reasons: it is what the brief asks
  // for, and a headless capture machine cannot be relied on to have a Cyrillic
  // face in whatever generic sans the CSS stack lands on - a sign that renders
  // as a row of tofu boxes on one machine and as text on another is not a sign,
  // it is a lottery. Twelve constructed letterforms, laid out as words, eroded
  // at the end so the paint reads as forty years old.
  //
  // Everything else on this sheet is grime: water staining, peeling paint,
  // rust weeps, two graffiti tags. Those matter more than the lettering. A tile
  // wall with no staining on it is the flat-untextured-surface failure wearing
  // a texture, and the atlas is how this level buys per-place variation that a
  // tiling material physically cannot.
  // ---------------------------------------------------------------------------
  var ATLAS_PX = 1024, ATLAS_N = 4, ATLAS_CELL = 256;
  var CELL = {
    NAME: 0,        // the station name plate
    EXIT: 1,        // exit legend + arrow
    STRIP: 2,       // line strip-map
    HAZARD: 3,      // 825 V traction warning
    DOOR: 4,        // staff door plate
    CHAIN: 5,       // tunnel chainage marker
    STAIN: 6,       // water staining / efflorescence
    PEEL: 7,        // peeling paint + tile loss
    TAG_A: 8,
    TAG_B: 9,
    GAP: 10,        // platform edge stencil
    EMBLEM: 11,     // mosaic roundel
    WEEP: 12,       // rust weep
    POSTER: 13,     // torn poster remnant
    ARROW: 14,      // directional chevrons
    NUM: 15         // the line number
  };

  function atlasRect(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    return [cx * ATLAS_CELL, cy * ATLAS_CELL];
  }
  function atlasUV(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    var s = 1 / ATLAS_N;
    return [cx * s, 1 - (cy + 1) * s, (cx + 1) * s, 1 - cy * s];
  }

  // One constructed letterform. Heavy grotesque strokes on a common baseline so
  // a row of them reads as a word rather than as a row of symbols.
  function glyph(g, x, y, w, h, id) {
    var l = x, r = x + w, t = y, b = y + h;
    var mx = x + w * 0.5, my = y + h * 0.52, q = y + h * 0.30;
    g.beginPath();
    switch (((id % 12) + 12) % 12) {
      case 0: g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, t); g.lineTo(r, my); g.lineTo(l, my); break;
      case 1: g.moveTo(l, t); g.lineTo(l, b); g.moveTo(l, my); g.lineTo(r, my); g.moveTo(r, t); g.lineTo(r, b); break;
      case 2: g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, t); g.lineTo(r, b); g.moveTo(l, my); g.lineTo(r, my); break;
      case 3: g.moveTo(l, t); g.lineTo(mx, b); g.lineTo(r, t); g.moveTo(l, my); g.lineTo(r, my); break;
      case 4: g.moveTo(l, t); g.lineTo(r, t); g.moveTo(mx, t); g.lineTo(mx, b); break;
      case 5: g.moveTo(r, t); g.lineTo(l, t); g.lineTo(l, my); g.lineTo(r, my); g.lineTo(r, b); g.lineTo(l, b); break;
      case 6: g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, t); g.lineTo(r, b); g.moveTo(l, q); g.lineTo(r, q); break;
      case 7: g.moveTo(l, t); g.lineTo(l, b); g.lineTo(r, b); g.lineTo(r, t); break;
      case 8: g.moveTo(l, t); g.lineTo(r, b); g.moveTo(r, t); g.lineTo(l, b); break;
      case 9: g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, t); g.lineTo(r, b); g.moveTo(mx, my); g.lineTo(mx, b); break;
      case 10: g.moveTo(l, t); g.lineTo(l, b); g.moveTo(l, t); g.lineTo(r, q); g.lineTo(l, my); break;
      default: g.moveTo(l, t); g.lineTo(l, b); g.moveTo(r, t); g.lineTo(r, b); g.moveTo(l, t); g.lineTo(r, b); break;
    }
    g.stroke();
  }

  // A word of `n` invented glyphs, centred on (cx, cy), cap height `h`.
  function word(g, cx, cy, h, n, rng, weight) {
    var w = h * 0.62, gap = h * 0.26;
    var total = n * w + (n - 1) * gap;
    var x = cx - total * 0.5;
    g.lineWidth = Math.max(2, h * (weight || 0.19));
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    for (var i = 0; i < n; i++) {
      glyph(g, x, cy - h * 0.5, w, h, rng.int(0, 11));
      x += w + gap;
    }
    return total;
  }

  function buildAtlas(rng) {
    var cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = ATLAS_PX; cv.height = ATLAS_PX;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    var S = ATLAS_CELL;
    var i, j, k;

    // Break a stencil up so it reads as enamel that has been underground for
    // forty years rather than as a vector logo.
    function erode(x0, y0, w, h, amount) {
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (var e = 0; e < amount; e++) {
        var rx = x0 + rng.range(0, w), ry = y0 + rng.range(0, h);
        g.globalAlpha = rng.range(0.18, 0.80);
        g.beginPath();
        g.arc(rx, ry, rng.range(1.4, 8.0), 0, 6.2832);
        g.fill();
      }
      g.restore();
    }
    function cellStart(cell) {
      var r = atlasRect(cell);
      g.save();
      g.translate(r[0], r[1]);
      return r;
    }

    // ---- the station name plate ---------------------------------------------
    // Drawn as a band across the middle of the cell so the card can be a wide
    // rectangle without stretching the glyphs; the transparent margin above and
    // below simply is not there once the card is alpha tested.
    (function () {
      var r = cellStart(CELL.NAME);
      g.fillStyle = 'rgba(26,42,34,0.92)';
      g.fillRect(0, S * 0.33, S, S * 0.34);
      g.strokeStyle = 'rgba(198,206,192,0.55)'; g.lineWidth = 3;
      g.strokeRect(5, S * 0.34, S - 10, S * 0.32);
      g.strokeStyle = 'rgba(226,232,216,0.95)';
      word(g, S * 0.5, S * 0.50, S * 0.155, 9, rng, 0.185);
      g.restore();
      erode(r[0], r[1], S, S, 220);
    })();

    // ---- exit legend + arrow ------------------------------------------------
    (function () {
      var r = cellStart(CELL.EXIT);
      g.fillStyle = 'rgba(20,34,28,0.90)';
      g.fillRect(0, S * 0.26, S, S * 0.48);
      g.strokeStyle = 'rgba(214,224,206,0.94)';
      word(g, S * 0.42, S * 0.42, S * 0.135, 5, rng, 0.19);
      word(g, S * 0.42, S * 0.62, S * 0.105, 7, rng, 0.20);
      // the arrow
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(S * 0.72, S * 0.50); g.lineTo(S * 0.93, S * 0.50);
      g.moveTo(S * 0.84, S * 0.40); g.lineTo(S * 0.93, S * 0.50); g.lineTo(S * 0.84, S * 0.60);
      g.stroke();
      g.restore();
      erode(r[0], r[1], S, S, 190);
    })();

    // ---- strip map ----------------------------------------------------------
    (function () {
      var r = cellStart(CELL.STRIP);
      g.fillStyle = 'rgba(228,230,220,0.90)';
      g.fillRect(0, S * 0.22, S, S * 0.56);
      g.strokeStyle = 'rgba(150,44,36,0.95)'; g.lineWidth = 12;
      g.beginPath(); g.moveTo(S * 0.08, S * 0.50); g.lineTo(S * 0.92, S * 0.50); g.stroke();
      for (i = 0; i < 7; i++) {
        var sx = S * (0.10 + i * 0.135);
        g.fillStyle = '#e8e6dc';
        g.beginPath(); g.arc(sx, S * 0.50, 11, 0, 6.2832); g.fill();
        g.strokeStyle = 'rgba(40,44,40,0.9)'; g.lineWidth = 4;
        g.beginPath(); g.arc(sx, S * 0.50, 11, 0, 6.2832); g.stroke();
        g.strokeStyle = 'rgba(38,42,38,0.88)';
        g.save(); g.translate(sx, S * (i & 1 ? 0.66 : 0.34)); g.rotate(-Math.PI * 0.5);
        word(g, 0, 0, S * 0.048, 4, rng, 0.22);
        g.restore();
      }
      g.restore();
      erode(r[0], r[1], S, S, 260);
    })();

    // ---- traction hazard ----------------------------------------------------
    (function () {
      var r = cellStart(CELL.HAZARD);
      g.fillStyle = '#d8c020';
      g.beginPath();
      g.moveTo(S * 0.5, S * 0.14); g.lineTo(S * 0.90, S * 0.80); g.lineTo(S * 0.10, S * 0.80);
      g.closePath(); g.fill();
      g.strokeStyle = '#14150f'; g.lineWidth = 11;
      g.beginPath();
      g.moveTo(S * 0.5, S * 0.14); g.lineTo(S * 0.90, S * 0.80); g.lineTo(S * 0.10, S * 0.80);
      g.closePath(); g.stroke();
      g.fillStyle = '#14150f';
      g.beginPath();
      g.moveTo(S * 0.55, S * 0.30); g.lineTo(S * 0.40, S * 0.55); g.lineTo(S * 0.50, S * 0.55);
      g.lineTo(S * 0.44, S * 0.74); g.lineTo(S * 0.62, S * 0.47); g.lineTo(S * 0.51, S * 0.47);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(20,21,15,0.92)';
      word(g, S * 0.5, S * 0.90, S * 0.075, 6, rng, 0.22);
      g.restore();
      erode(r[0], r[1], S, S, 130);
    })();

    // ---- staff door plate ---------------------------------------------------
    (function () {
      var r = cellStart(CELL.DOOR);
      g.fillStyle = 'rgba(198,196,178,0.90)';
      g.fillRect(S * 0.12, S * 0.28, S * 0.76, S * 0.44);
      g.strokeStyle = 'rgba(46,50,44,0.92)'; g.lineWidth = 4;
      g.strokeRect(S * 0.14, S * 0.30, S * 0.72, S * 0.40);
      g.strokeStyle = 'rgba(42,46,40,0.94)';
      word(g, S * 0.5, S * 0.42, S * 0.085, 6, rng, 0.21);
      word(g, S * 0.5, S * 0.58, S * 0.070, 8, rng, 0.22);
      g.restore();
      erode(r[0], r[1], S, S, 170);
    })();

    // ---- tunnel chainage ----------------------------------------------------
    (function () {
      var r = cellStart(CELL.CHAIN);
      g.fillStyle = 'rgba(206,206,196,0.86)';
      g.fillRect(S * 0.18, S * 0.24, S * 0.64, S * 0.52);
      g.strokeStyle = 'rgba(30,34,30,0.90)'; g.lineWidth = 5;
      g.strokeRect(S * 0.20, S * 0.26, S * 0.60, S * 0.48);
      g.strokeStyle = 'rgba(30,34,30,0.92)';
      word(g, S * 0.5, S * 0.40, S * 0.11, 3, rng, 0.22);
      word(g, S * 0.5, S * 0.60, S * 0.11, 4, rng, 0.22);
      g.restore();
      erode(r[0], r[1], S, S, 200);
    })();

    // ---- water staining -----------------------------------------------------
    // Calcite bloom and iron staining running down from a leaking joint. This is
    // the single most-used card in the level: it is what makes 70 m of tile look
    // like a tunnel that has been wet for a decade instead of a tiled corridor.
    (function () {
      var r = cellStart(CELL.STAIN);
      for (i = 0; i < 26; i++) {
        var wx = rng.range(0.02, 0.98) * S;
        var top = rng.range(0.0, 0.22) * S;
        var len = rng.range(0.30, 1.0) * S;
        var ww = rng.range(6, 34);
        for (k = 0; k < 30; k++) {
          var t = k / 30;
          var a = (1 - t * 0.85) * rng.range(0.10, 0.34);
          var hue = 44 + rng.range(-16, 14);
          var lig = 62 + rng.range(-16, 18) - t * 14;
          g.fillStyle = 'hsla(' + hue.toFixed(0) + ',' +
            (16 + rng.range(0, 22)).toFixed(0) + '%,' + lig.toFixed(0) + '%,' + a.toFixed(3) + ')';
          var jx = wx + Math.sin(t * 5.3 + i) * 4.0 + rng.range(-1.6, 1.6);
          g.fillRect(jx, top + t * len, ww * (1 - t * 0.45), len / 30 + 1.6);
        }
      }
      // the efflorescence crust where it dries
      for (i = 0; i < 60; i++) {
        g.fillStyle = 'rgba(226,228,216,' + rng.range(0.05, 0.22).toFixed(3) + ')';
        g.beginPath();
        g.ellipse(rng.range(0, S), rng.range(0.45, 1.0) * S,
          rng.range(6, 30), rng.range(3, 12), rng.range(0, 3), 0, 6.2832);
        g.fill();
      }
      g.restore();
    })();

    // ---- peeling paint / lost tile ------------------------------------------
    (function () {
      var r = cellStart(CELL.PEEL);
      for (i = 0; i < 22; i++) {
        var px = rng.range(0, S), py = rng.range(0, S);
        var pr = rng.range(10, 46);
        g.fillStyle = 'rgba(84,78,68,' + rng.range(0.42, 0.86).toFixed(3) + ')';
        g.beginPath();
        for (j = 0; j <= 10; j++) {
          var a2 = j / 10 * 6.2832;
          var rr = pr * (0.62 + rng.range(0, 0.6));
          var vx = px + Math.cos(a2) * rr, vy = py + Math.sin(a2) * rr;
          if (j === 0) g.moveTo(vx, vy); else g.lineTo(vx, vy);
        }
        g.closePath(); g.fill();
        // the lifted lip catches light
        g.strokeStyle = 'rgba(214,210,196,' + rng.range(0.20, 0.5).toFixed(3) + ')';
        g.lineWidth = rng.range(1.5, 4);
        g.stroke();
      }
      g.restore();
    })();

    // ---- graffiti -----------------------------------------------------------
    for (i = 0; i < 2; i++) {
      var rt = cellStart(CELL.TAG_A + i);
      g.lineCap = 'round'; g.lineJoin = 'round';
      var cols = i === 0 ? ['#e2ddc8', '#2f6ea8'] : ['#c6d84a', '#a8384e'];
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = cols[pass];
        g.lineWidth = pass === 0 ? 24 : 10;
        g.globalAlpha = pass === 0 ? 0.90 : 0.82;
        g.beginPath();
        var gx = S * 0.08, gy = S * 0.62;
        g.moveTo(gx, gy);
        for (j = 0; j < 8; j++) {
          var nx2 = gx + S * rng.range(0.07, 0.16);
          var ny2 = S * rng.range(0.22, 0.80);
          g.quadraticCurveTo(gx + (nx2 - gx) * 0.4, S * rng.range(0.14, 0.88), nx2, ny2);
          gx = nx2; gy = ny2;
        }
        g.stroke();
      }
      g.globalAlpha = 1;
      g.restore();
      erode(rt[0], rt[1], S, S, 70);
    }

    // ---- platform edge stencil ---------------------------------------------
    (function () {
      var r = cellStart(CELL.GAP);
      g.strokeStyle = 'rgba(232,226,190,0.92)';
      word(g, S * 0.5, S * 0.34, S * 0.13, 5, rng, 0.20);
      word(g, S * 0.5, S * 0.58, S * 0.13, 6, rng, 0.20);
      g.lineWidth = 8;
      g.beginPath();
      g.moveTo(S * 0.14, S * 0.76); g.lineTo(S * 0.86, S * 0.76);
      g.stroke();
      g.restore();
      erode(r[0], r[1], S, S, 240);
    })();

    // ---- mosaic emblem ------------------------------------------------------
    (function () {
      var r = cellStart(CELL.EMBLEM);
      g.save();
      g.translate(S * 0.5, S * 0.5);
      // tesserae ring
      for (i = 0; i < 3; i++) {
        var rad = S * (0.18 + i * 0.09);
        var nseg = 22 + i * 8;
        for (j = 0; j < nseg; j++) {
          var aa = j / nseg * 6.2832;
          var lum = 40 + rng.range(-16, 26) + i * 6;
          var hu = i === 1 ? 38 : 172;
          g.fillStyle = 'hsla(' + hu + ',' + (18 + rng.range(0, 30)).toFixed(0) + '%,' + lum.toFixed(0) + '%,0.95)';
          g.save();
          g.rotate(aa); g.translate(rad, 0);
          g.fillRect(-6, -6, 11, 11);
          g.restore();
        }
      }
      // an invented geometric device in the middle
      g.strokeStyle = 'rgba(226,206,142,0.95)'; g.lineWidth = 10;
      g.beginPath();
      for (j = 0; j < 5; j++) {
        var a3 = -Math.PI * 0.5 + j / 5 * 6.2832;
        var a4 = -Math.PI * 0.5 + ((j + 2) % 5) / 5 * 6.2832;
        g.moveTo(Math.cos(a3) * S * 0.13, Math.sin(a3) * S * 0.13);
        g.lineTo(Math.cos(a4) * S * 0.13, Math.sin(a4) * S * 0.13);
      }
      g.stroke();
      g.restore();
      g.restore();
      erode(r[0], r[1], S, S, 150);
    })();

    // ---- rust weep ----------------------------------------------------------
    (function () {
      var r = cellStart(CELL.WEEP);
      for (i = 0; i < 14; i++) {
        var wx2 = rng.range(0.06, 0.94) * S;
        var wt = rng.range(0.0, 0.18) * S;
        var wl = rng.range(0.35, 0.98) * S;
        var ww2 = rng.range(3, 16);
        for (k = 0; k < 26; k++) {
          var t2 = k / 26;
          var a5 = (1 - t2) * (1 - t2) * rng.range(0.5, 1.0);
          g.fillStyle = 'hsla(' + (20 + rng.range(-8, 12)).toFixed(0) + ',' +
            (50 + rng.range(-14, 14)).toFixed(0) + '%,' + (26 + t2 * 12).toFixed(0) + '%,' + a5.toFixed(3) + ')';
          g.fillRect(wx2 + Math.sin(t2 * 7.1 + i) * 3.0, wt + t2 * wl, ww2 * (1 - t2 * 0.5), wl / 26 + 1.5);
        }
        g.fillStyle = 'rgba(118,60,26,0.55)';
        g.beginPath(); g.arc(wx2 + ww2 * 0.5, wt + 4, ww2 * rng.range(0.9, 1.9), 0, 6.2832); g.fill();
      }
      g.restore();
    })();

    // ---- torn poster --------------------------------------------------------
    (function () {
      var r = cellStart(CELL.POSTER);
      g.save();
      g.beginPath();
      g.moveTo(S * 0.08, S * 0.10);
      for (j = 0; j <= 12; j++) {
        g.lineTo(S * (0.08 + 0.84 * j / 12), S * (0.10 + rng.range(-0.03, 0.03)));
      }
      g.lineTo(S * 0.92, S * 0.74);
      for (j = 12; j >= 0; j--) {
        g.lineTo(S * (0.08 + 0.84 * j / 12), S * (0.74 + rng.range(-0.12, 0.10)));
      }
      g.closePath();
      g.clip();
      g.fillStyle = 'rgba(186,172,140,0.88)';
      g.fillRect(0, 0, S, S);
      g.fillStyle = 'rgba(152,52,42,0.72)';
      g.fillRect(S * 0.08, S * 0.10, S * 0.84, S * 0.16);
      g.strokeStyle = 'rgba(48,44,36,0.7)';
      word(g, S * 0.5, S * 0.42, S * 0.085, 7, rng, 0.20);
      word(g, S * 0.5, S * 0.60, S * 0.065, 9, rng, 0.22);
      g.restore();
      erode(r[0], r[1], S, S, 320);
    })();

    // ---- chevrons -----------------------------------------------------------
    (function () {
      var r = cellStart(CELL.ARROW);
      g.strokeStyle = 'rgba(228,222,186,0.90)'; g.lineWidth = 16;
      g.lineCap = 'butt';
      for (i = 0; i < 3; i++) {
        var ax = S * (0.24 + i * 0.24);
        g.beginPath();
        g.moveTo(ax - S * 0.10, S * 0.30); g.lineTo(ax + S * 0.06, S * 0.50);
        g.lineTo(ax - S * 0.10, S * 0.70);
        g.stroke();
      }
      g.restore();
      erode(r[0], r[1], S, S, 170);
    })();

    // ---- line number --------------------------------------------------------
    (function () {
      var r = cellStart(CELL.NUM);
      g.fillStyle = 'rgba(158,46,38,0.94)';
      g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.32, 0, 6.2832); g.fill();
      g.strokeStyle = 'rgba(226,226,214,0.95)'; g.lineWidth = 22;
      // an invented numeral four: a stem and a diagonal
      g.beginPath();
      g.moveTo(S * 0.60, S * 0.30); g.lineTo(S * 0.60, S * 0.72);
      g.moveTo(S * 0.60, S * 0.30); g.lineTo(S * 0.36, S * 0.58); g.lineTo(S * 0.72, S * 0.58);
      g.stroke();
      g.restore();
      erode(r[0], r[1], S, S, 120);
    })();

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // Place one atlas card. `axis` is the outward normal axis, `s` its sign.
  function card(B, cell, x, y, z, w, h, axis, s, tintC, roll) {
    var uv = atlasUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var rx = 0, ry = 0;
    if (axis === 'x') ry = s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    else if (axis === 'y') { rx = s > 0 ? -Math.PI * 0.5 : Math.PI * 0.5; }
    else ry = s > 0 ? 0 : Math.PI;
    var old = B.tint;
    if (tintC) B.tint = tintC;
    B.add('decal', g, makeM(x, y, z, rx, ry, roll || 0));
    B.tint = old;
  }

  // ---------------------------------------------------------------------------
  // The glint card texture: a long soft streak, brightest on its own axis and
  // dying at both ends. Laid on the water under every strip - see the header.
  // ---------------------------------------------------------------------------
  function glintTexture() {
    var W = 256, H = 64, cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    var img = g.createImageData(W, H);
    var d = img.data;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var u = x / (W - 1), v = y / (H - 1);
        // along the streak: a long plateau with soft shoulders
        var a = M.smoothstep(0.0, 0.16, u) * (1 - M.smoothstep(0.84, 1.0, u));
        // across it: a narrow core with a wide skirt, which is what a specular
        // smear on rippled water actually is
        var c = Math.abs(v - 0.5) * 2;
        var across = Math.exp(-c * c * 7.0) * 0.72 + Math.exp(-c * c * 1.6) * 0.28;
        // broken up along its length so it is never a clean bar
        var br = 0.62 + 0.38 * Math.sin(u * 41.0) * Math.sin(u * 13.7 + 1.3);
        var val = M.saturate(a * across * br);
        var i = (y * W + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = Math.round(val * 255);
      }
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // A glint card lying flat on the water, running along X.
  function glint(B, x, z, len, wide, col, y) {
    var g = quad(len, wide, 0, 0, 1, 1);
    var old = B.tint;
    B.tint = col;
    B.add('glint', g, makeM(x, y, z, -Math.PI * 0.5, 0, 0));
    B.tint = old;
  }

  // An up-facing grid surface following `fn(x,z)`. Used for every horizontal
  // slab in the station, because a settled floor with real relief is what gives
  // the wetness pass somewhere to put water - a flat plane has no low spots and
  // a puddle painted onto one is a stain, not a puddle.
  function deck(x0, x1, z0, z1, step, fn) {
    var nx = Math.max(1, Math.round((x1 - x0) / step));
    var nz = Math.max(1, Math.round((z1 - z0) / step));
    var dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    var pos = [], nor = [];
    var i, j;
    var ys = [];
    for (i = 0; i <= nx; i++) {
      ys.push([]);
      for (j = 0; j <= nz; j++) ys[i].push(fn(x0 + i * dx, z0 + j * dz));
    }
    // A sample of DEAD (-999) means "no surface here": the quad is dropped and
    // its neighbours are clamped out of the gradient. That is how the platform
    // ponds get a ragged rim instead of being clipped rectangles, without a
    // second geometry path for them.
    function samp(i2, j2, fb) {
      var v = ys[M.clamp(i2, 0, nx)][M.clamp(j2, 0, nz)];
      return v < -900 ? fb : v;
    }
    function nAt(i2, j2) {
      var c0 = ys[i2][j2];
      if (c0 < -900) return [0, 1, 0];
      var a = samp(i2 - 1, j2, c0), b = samp(i2 + 1, j2, c0);
      var c = samp(i2, j2 - 1, c0), d = samp(i2, j2 + 1, c0);
      var gx = (b - a) / (2 * dx), gz = (d - c) / (2 * dz);
      var l = Math.sqrt(gx * gx + 1 + gz * gz) || 1;
      return [-gx / l, 1 / l, -gz / l];
    }
    for (i = 0; i < nx; i++) {
      for (j = 0; j < nz; j++) {
        var xa = x0 + i * dx, xb = xa + dx;
        var za = z0 + j * dz, zb = za + dz;
        var y00 = ys[i][j], y01 = ys[i][j + 1], y11 = ys[i + 1][j + 1], y10 = ys[i + 1][j];
        if (y00 < -900 || y01 < -900 || y11 < -900 || y10 < -900) continue;
        var n00 = nAt(i, j), n01 = nAt(i, j + 1), n11 = nAt(i + 1, j + 1), n10 = nAt(i + 1, j);
        pos.push(xa, y00, za, xa, y01, zb, xb, y11, zb);
        nor.push(n00[0], n00[1], n00[2], n01[0], n01[1], n01[2], n11[0], n11[1], n11[2]);
        pos.push(xa, y00, za, xb, y11, zb, xb, y10, za);
        nor.push(n00[0], n00[1], n00[2], n11[0], n11[1], n11[2], n10[0], n10[1], n10[2]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // The arcade's arch ring, in the XY plane (the arcade runs along X).
  function archRingX(B, key, z, thick, cx, cy, r, span, segs, depth, proud) {
    segs = segs || 14;
    depth = depth || 0.30;
    for (var i = 0; i < segs; i++) {
      var t0 = -span + (2 * span) * (i / segs);
      var t1 = -span + (2 * span) * ((i + 1) / segs);
      var tm = (t0 + t1) * 0.5;
      var rm = r + depth * 0.5;
      var xx = cx + rm * Math.sin(tm), yy = cy + rm * Math.cos(tm);
      var seg = 2 * rm * Math.abs(Math.sin((t1 - t0) * 0.5)) + 0.03;
      B.add(key, box(seg, depth, thick + (proud || 0.09) * 2),
        makeM(xx, yy, z, 0, 0, -tm));
    }
  }

  // ============================================================ THE STATION ==
  // Arcade geometry, solved once so the piers, the arch rings, the spandrels,
  // the colliders and the navgrid all read the same numbers.
  var ARC_SPRING = 2.95;                 // springing of the opening head
  var ARC_RISE = 0.70;                   // segmental rise
  var OPEN_HW = 1.70;                    // half of the 3.4 m opening
  var ARC_R = (OPEN_HW * OPEN_HW + ARC_RISE * ARC_RISE) / (2 * ARC_RISE);
  var ARC_CY = ARC_SPRING + ARC_RISE - ARC_R;
  var ARC_SPAN = Math.asin(M.clamp(OPEN_HW / ARC_R, -1, 1));

  function openingsX() {
    var out = [];
    for (var i = 0; i + 1 < PIERS_X.length; i++) out.push((PIERS_X[i] + PIERS_X[i + 1]) * 0.5);
    return out;
  }

  function isBroken(cx) {
    for (var i = 0; i < BROKEN_X.length; i++) if (Math.abs(BROKEN_X[i] - cx) < 0.01) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // THE PLATFORM: granite deck, edge upstand, tactile strip, benches of plinth.
  // ---------------------------------------------------------------------------
  function buildPlatform(L, B, rng, N) {
    var f = function (x, z) { return platY(x, z, N); };
    // The deck itself. 0.55 m cells: fine enough that the ponding basins in
    // platDip survive into the vertex wear mask, coarse enough that a 70 x 10 m
    // floor is ~9k triangles rather than 90k.
    B.paint = 'floor';
    B.add('plat_floor', deck(HALL_X0, HALL_X1, -PLAT_EDGE, PLAT_EDGE, 0.55, f));
    B.paint = 'metal';

    // Edge upstand: the face between the deck and the trackbed, and the coping
    // course on top of it. This is the leading line in three of five framings.
    var s, i;
    for (s = -1; s <= 1; s += 2) {
      var ez = s * (PLAT_EDGE - 0.11);
      B.paint = 'quay';
      B.box('raw_concrete', HALL_X1 - HALL_X0, 1.55, 0.22,
        (HALL_X0 + HALL_X1) * 0.5, PLAT_Y - 0.77, s * (PLAT_EDGE - 0.11));
      // coping nosing, slightly proud, in granite
      B.box('plat_floor', HALL_X1 - HALL_X0, 0.10, 0.30,
        (HALL_X0 + HALL_X1) * 0.5, PLAT_Y - 0.05, s * (PLAT_EDGE - 0.15));
      B.paint = 'metal';
      // the painted safety line, 0.55 m in from the edge
      B.paint = 'line';
      B.box('paint_line', HALL_X1 - HALL_X0, 0.012, 0.20,
        (HALL_X0 + HALL_X1) * 0.5, PLAT_Y + 0.004, s * (PLAT_EDGE - 0.62));
      B.paint = 'metal';
      // tactile studs, in runs so the merge stays cheap
      for (i = 0; i < 150; i++) {
        var tx = HALL_X0 + 1.0 + i * ((HALL_X1 - HALL_X0 - 2.0) / 150);
        B.box('plat_floor', 0.30, 0.022, 0.24, tx, PLAT_Y + 0.010, s * (PLAT_EDGE - 0.40));
      }
      // platform edge stencils
      for (i = 0; i < 6; i++) {
        card(B, CELL.GAP, HALL_X0 + 7 + i * 11.4, PLAT_Y + 0.016, s * (PLAT_EDGE - 0.90),
          1.5, 1.5, 'y', 1, tint(0xfff3d0, 0.5), s > 0 ? 0 : Math.PI);
      }
    }
    L.addCollider((HALL_X0 + HALL_X1) * 0.5, PLAT_Y - 0.25, 0,
      (HALL_X1 - HALL_X0) * 0.5, 0.25, PLAT_EDGE, 'concrete', true);
  }

  // ---------------------------------------------------------------------------
  // THE PYLON ARCADE. Ten piers a side at 6 m pitch, faced in glazed tile over a
  // granite plinth, with a green dado band at shoulder height and a segmental
  // arch over every 3.4 m opening. Two piers are gone - the lead car took them
  // out on its way up onto the platform - and what is left of them is the
  // strongest silhouette on the platform after the wreck itself.
  // ---------------------------------------------------------------------------
  function buildArcade(L, B, rng, N) {
    var s, i, k;
    var opens = openingsX();
    var midZ = (ARC_BACK + PLAT_EDGE) * 0.5, thk = PLAT_EDGE - ARC_BACK;

    for (s = -1; s <= 1; s += 2) {
      var z = s * midZ;

      // ---- the solid end bays ---------------------------------------------
      B.paint = 'clad';
      B.box('wall_tile', ARC_X0 - HALL_X0, ARC_TOP - PLAT_Y, thk,
        (HALL_X0 + ARC_X0) * 0.5, (PLAT_Y + ARC_TOP) * 0.5, z);
      B.box('wall_tile', HALL_X1 - ARC_X1, ARC_TOP - PLAT_Y, thk,
        (ARC_X1 + HALL_X1) * 0.5, (PLAT_Y + ARC_TOP) * 0.5, z);
      B.paint = 'metal';
      L.addCollider((HALL_X0 + ARC_X0) * 0.5, (PLAT_Y + ARC_TOP) * 0.5, z,
        (ARC_X0 - HALL_X0) * 0.5, (ARC_TOP - PLAT_Y) * 0.5, thk * 0.5, 'tile');
      L.addCollider((ARC_X1 + HALL_X1) * 0.5, (PLAT_Y + ARC_TOP) * 0.5, z,
        (HALL_X1 - ARC_X1) * 0.5, (ARC_TOP - PLAT_Y) * 0.5, thk * 0.5, 'tile');

      // ---- the piers -------------------------------------------------------
      for (i = 0; i < PIERS_X.length; i++) {
        var px = PIERS_X[i];
        var broke = (s < 0) && isBroken(px);
        var top = broke ? (px < 0 ? 1.95 : 3.05) : ARC_TOP;

        // granite plinth
        B.paint = 'quay';
        B.box('plat_floor', PIER_HW * 2 + 0.10, 0.34, thk + 0.09, px, PLAT_Y + 0.17, z);
        B.paint = 'clad';
        // tiled shaft, in two courses so the dado band can sit between them
        var dadoTop = 1.44 + 1.05;
        B.box('dado_paint', PIER_HW * 2, dadoTop - (PLAT_Y + 0.34), thk + 0.015,
          px, (PLAT_Y + 0.34 + dadoTop) * 0.5, z);
        if (top > dadoTop + 0.05) {
          B.box('wall_tile', PIER_HW * 2, top - dadoTop, thk,
            px, (dadoTop + top) * 0.5, z);
        }
        B.paint = 'metal';

        if (!broke) {
          // capital / cornice return
          B.paint = 'clad';
          B.box('vault_plaster', PIER_HW * 2 + 0.22, 0.20, thk + 0.16, px, ARC_TOP - 0.10, z);
          B.paint = 'metal';
        } else {
          // sheared concrete, exposed rebar, and the crack that runs down the
          // face of what is left
          B.paint = 'rubble';
          for (k = 0; k < 9; k++) {
            var fx = px + rng.range(-PIER_HW, PIER_HW);
            var fy = top + rng.range(-0.30, 0.34);
            B.boxR('raw_concrete', rng.range(0.22, 0.72), rng.range(0.14, 0.42),
              rng.range(0.20, thk), fx, fy, z + rng.range(-0.25, 0.25),
              rng.range(-0.5, 0.5), rng.range(-0.7, 0.7), rng.range(-0.6, 0.6));
          }
          B.paint = 'metal';
          for (k = 0; k < 7; k++) {
            var bx0 = px + rng.range(-PIER_HW * 0.8, PIER_HW * 0.8);
            var bz0 = z + rng.range(-thk * 0.35, thk * 0.35);
            B.strut('rust_metal', bx0, top - 0.15, bz0,
              bx0 + rng.range(-0.35, 0.35), top + rng.range(0.45, 1.15),
              bz0 + rng.range(-0.3, 0.3), 0.024, 0.024);
          }
        }
        L.addCollider(px, (PLAT_Y + top) * 0.5, z, PIER_HW, (top - PLAT_Y) * 0.5,
          thk * 0.5 + 0.05, 'concrete');
      }

      // ---- the arch heads and spandrels ------------------------------------
      for (i = 0; i < opens.length; i++) {
        var cx = opens[i];
        var gone = (s < 0) && cx > -4 && cx < 4;      // the demolished bay
        if (gone) continue;
        archRingX(B, 'wall_tile', z, thk, cx, ARC_CY, ARC_R, ARC_SPAN, 14, 0.28, 0.07);
        // spandrel: columns whose feet follow the extrados
        var nCol = 14;
        for (k = 0; k < nCol; k++) {
          var ca = cx - OPEN_HW + (2 * OPEN_HW) * (k / nCol);
          var cb = cx - OPEN_HW + (2 * OPEN_HW) * ((k + 1) / nCol);
          var cm = (ca + cb) * 0.5;
          var yh = ARC_CY + Math.sqrt(Math.max(0, ARC_R * ARC_R - (cm - cx) * (cm - cx))) + 0.26;
          if (ARC_TOP - yh < 0.02) continue;
          B.paint = 'clad';
          B.box('wall_tile', cb - ca + 0.01, ARC_TOP - yh, thk, cm, (yh + ARC_TOP) * 0.5, z);
          B.paint = 'metal';
        }
        // the cornice return over the opening
        B.paint = 'clad';
        B.box('vault_plaster', OPEN_HW * 2 + 0.1, 0.20, thk + 0.16, cx, ARC_TOP - 0.10, z);
        B.paint = 'metal';
        L.addCollider(cx, ARC_TOP - 0.32, z, OPEN_HW, 0.30, thk * 0.5, 'concrete');
      }

      // ---- the cornice band, running the whole arcade -----------------------
      B.paint = 'clad';
      B.box('vault_plaster', HALL_X1 - HALL_X0, 0.22, thk + 0.20,
        (HALL_X0 + HALL_X1) * 0.5, ARC_TOP + 0.11, z);
      B.paint = 'metal';
    }

    // ---- what came off the two demolished piers ---------------------------
    // A rubble field on the platform under the wreck's nose. It is the hero
    // framing's mid-ground and the reason the crash reads as violent rather
    // than as a train that has been carefully parked at an angle.
    B.paint = 'rubble';
    for (i = 0; i < 46; i++) {
      var a = rng.range(0, 6.2832), rr = Math.abs(rng.gaussian(0, 2.6)) + 0.4;
      var rxp = -0.5 + Math.cos(a) * rr * 1.5;
      var rzp = -3.6 + Math.sin(a) * rr * 0.75;
      if (Math.abs(rzp) > PLAT_EDGE - 0.2) continue;
      var sz = rng.range(0.14, 0.70) * (1 - M.saturate(rr / 6) * 0.5);
      B.boxR('raw_concrete', sz * rng.range(0.7, 1.6), sz * rng.range(0.35, 0.9),
        sz * rng.range(0.7, 1.5), rxp, platY(rxp, rzp, N) + sz * 0.24, rzp,
        rng.range(-0.6, 0.6), rng.range(0, 3.14), rng.range(-0.6, 0.6));
    }
    B.paint = 'metal';
  }

  // ---------------------------------------------------------------------------
  // THE VAULTS. One over the platform, one over each track hall, plus the
  // transverse ribs that give a 70 m tube any rhythm at all. The platform vault
  // carries two holes: the vent shaft at x = -11 and the collapse the train's
  // roof tore out of it on the way past.
  // ---------------------------------------------------------------------------
  function buildVaults(L, B, rng, N) {
    var jit = function (x, z) {
      return (N.fbm2(x * 0.055 + 12.7, z * 0.055 - 3.1, 2) * 0.5 + 0.5) * 0.085 - 0.042;
    };
    var holePlat = function (x, z, y) {
      var dx = x - VENT_X, dz = z - VENT_Z;
      if (dx * dx + dz * dz < VENT_R * VENT_R) return true;
      if (x > COL_X0 && x < COL_X1 && z > COL_Z0 && z < COL_Z1) {
        // a torn edge rather than a rectangle
        var e = M.smoothstep(0, 1.4, Math.min(
          Math.min(x - COL_X0, COL_X1 - x), Math.min(z - COL_Z0, COL_Z1 - z)));
        return e > 0.22 + (N.fbm2(x * 0.7, z * 0.7, 2) * 0.5 + 0.5) * 0.30;
      }
      return false;
    };

    // platform vault
    var pp = vaultProfile(-PLAT_EDGE, PLAT_EDGE, ARC_TOP, ARC_TOP, CROWN - ARC_TOP, 20);
    B.paint = 'vault';
    B.add('vault_plaster', sweepX(pp, HALL_X0, HALL_X1, 100, holePlat, jit));

    // track hall vaults, both ordered by increasing z so the normals come out
    // pointing into the hall (see the sweepX header).
    var tn = vaultProfile(-HALL_HZ, -PLAT_EDGE, TRK_SPRING, ARC_TOP, TRK_CROWN_R, 12);
    var ts = vaultProfile(PLAT_EDGE, HALL_HZ, ARC_TOP, TRK_SPRING, TRK_CROWN_R, 12);
    B.paint = 'seg';
    B.add('tunnel_seg', sweepX(tn, HALL_X0, HALL_X1, 84, null, jit));
    B.add('tunnel_seg', sweepX(ts, HALL_X0, HALL_X1, 84, null, jit));
    B.paint = 'metal';

    // ---- transverse ribs ---------------------------------------------------
    // Every 3 m over the platform, offset 0.16 into the room, and the single
    // cheapest thing in this file: a barrel vault with no ribs has no scale and
    // no rhythm, and a 70 m one photographs as a tube.
    var i, k;
    for (i = 0; i < 24; i++) {
      var rx = HALL_X0 + 2.0 + i * 3.0;
      if (rx > HALL_X1 - 1.0) break;
      var skip = (rx > COL_X0 - 0.6 && rx < COL_X1 + 0.6);
      var prof = vaultProfile(-PLAT_EDGE + 0.05, PLAT_EDGE - 0.05, ARC_TOP, ARC_TOP,
        CROWN - ARC_TOP - 0.06, 16);
      for (k = 0; k + 1 < prof.length; k++) {
        var a0 = prof[k], a1 = prof[k + 1];
        if (skip && a0[0] < COL_Z1 + 0.4) continue;
        B.strut('vault_plaster', rx, a0[1] - 0.13, a0[0], rx, a1[1] - 0.13, a1[0], 0.34, 0.17);
      }
    }
    // longitudinal ribs where the vault meets the arcade cornice
    for (var s = -1; s <= 1; s += 2) {
      B.box('vault_plaster', HALL_X1 - HALL_X0, 0.16, 0.30,
        (HALL_X0 + HALL_X1) * 0.5, ARC_TOP + 0.30, s * (PLAT_EDGE - 0.30));
    }

    // ---- the vent shaft ----------------------------------------------------
    var vp = boreProfile(VENT_Z, 0, VENT_R, Math.PI, 18);
    // a vertical bore: build it as a ring of panels rather than reusing sweepX,
    // which only sweeps along X.
    for (k = 0; k < 18; k++) {
      var t0 = k / 18 * 6.2832, t1 = (k + 1) / 18 * 6.2832;
      var mxp = VENT_X + VENT_R * Math.cos((t0 + t1) * 0.5);
      var mzp = VENT_Z + VENT_R * Math.sin((t0 + t1) * 0.5);
      var seg = 2 * VENT_R * Math.sin(3.1416 / 18) + 0.02;
      B.paint = 'seg';
      B.add('tunnel_seg', box(0.16, 6.4, seg),
        makeM(mxp, CROWN + 2.6, mzp, 0, -(t0 + t1) * 0.5, 0));
      B.paint = 'metal';
    }
    // the grille across its head, and the rung ladder up its side
    B.paint = 'metal';
    for (k = -3; k <= 3; k++) {
      B.box('grate', VENT_R * 2, 0.05, 0.09, VENT_X, CROWN + 5.6, VENT_Z + k * 0.30);
    }
    for (k = 0; k < 9; k++) {
      B.box('rust_metal', 0.36, 0.035, 0.035, VENT_X - VENT_R + 0.16,
        CROWN + 0.4 + k * 0.55, VENT_Z);
    }
    // FOUR WALLS, not one box. The first version filled the shaft with a solid
    // collider, and lighting.js rasterises colliders into the occupancy grid its
    // shaft solver traces through - so the published vent shaft was reported as
    // buried in concrete, _solveShaft discarded it, and the beam that the whole
    // hero framing is composed around silently did not exist.
    L.addCollider(VENT_X - VENT_R - 0.15, CROWN + 3.0, VENT_Z, 0.15, 3.2, VENT_R + 0.3, 'concrete');
    L.addCollider(VENT_X + VENT_R + 0.15, CROWN + 3.0, VENT_Z, 0.15, 3.2, VENT_R + 0.3, 'concrete');
    L.addCollider(VENT_X, CROWN + 3.0, VENT_Z - VENT_R - 0.15, VENT_R + 0.3, 3.2, 0.15, 'concrete');
    L.addCollider(VENT_X, CROWN + 3.0, VENT_Z + VENT_R + 0.15, VENT_R + 0.3, 3.2, 0.15, 'concrete');

    // ---- the collapse ------------------------------------------------------
    // Torn ribs, hanging cable, earth behind. The hole is the darkest thing in
    // the hero framing and it needs an edge, or it reads as a rendering error.
    B.paint = 'rubble';
    for (i = 0; i < 30; i++) {
      var cx2 = rng.range(COL_X0 - 0.2, COL_X1 + 0.2);
      var cz2 = rng.range(COL_Z0, COL_Z1);
      var yv = ARC_TOP + (CROWN - ARC_TOP) *
        Math.pow(Math.sin(Math.PI * (cz2 + PLAT_EDGE) / (2 * PLAT_EDGE)), 0.8);
      B.boxR('raw_concrete', rng.range(0.35, 1.3), rng.range(0.10, 0.24), rng.range(0.35, 1.2),
        cx2, yv + rng.range(-0.15, 0.10), cz2,
        rng.range(-0.5, 0.5), rng.range(0, 3.14), rng.range(-0.5, 0.5));
    }
    B.paint = 'metal';
    for (i = 0; i < 16; i++) {
      var hx = rng.range(COL_X0, COL_X1), hz = rng.range(COL_Z0 + 0.4, COL_Z1);
      var hy = ARC_TOP + (CROWN - ARC_TOP) *
        Math.pow(Math.sin(Math.PI * (hz + PLAT_EDGE) / (2 * PLAT_EDGE)), 0.8);
      B.strut('rust_metal', hx, hy, hz, hx + rng.range(-0.5, 0.5),
        hy - rng.range(0.4, 1.5), hz + rng.range(-0.5, 0.5), 0.028, 0.028);
    }
    // a hanging cable loop, the one thing in the frame that is not straight
    for (i = 0; i < 3; i++) {
      var ax = COL_X0 + 1.2 + i * 3.0, az = COL_Z1 - 0.6;
      var bx2 = ax + rng.range(1.6, 2.8);
      var ay = ARC_TOP + 1.5, sag = rng.range(0.9, 1.9);
      var prev = null;
      for (k = 0; k <= 8; k++) {
        var t3 = k / 8;
        var cxp = ax + (bx2 - ax) * t3;
        var cyp = ay - Math.sin(Math.PI * t3) * sag;
        var czp = az + Math.sin(t3 * 2.1) * 0.25;
        if (prev) B.strut('cable_rubber', prev[0], prev[1], prev[2], cxp, cyp, czp, 0.055, 0.055);
        prev = [cxp, cyp, czp];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // THE END WALLS. Two horseshoe tunnel portals a side plus, at the east end,
  // the segmental arch into the escalator hall. The portals are what close the
  // hall: without them the track halls run off into nothing and the level has
  // no far end.
  // ---------------------------------------------------------------------------
  var PORTAL_SPRING = 1.55, PORTAL_R = 2.60;
  var EARCH_HW = 3.80, EARCH_RISE = 1.60;
  var EARCH_R = (EARCH_HW * EARCH_HW + EARCH_RISE * EARCH_RISE) / (2 * EARCH_RISE);
  var EARCH_CY = 3.40 + EARCH_RISE - EARCH_R;
  var EARCH_SPAN = Math.asin(M.clamp(EARCH_HW / EARCH_R, -1, 1));

  // Colliders for a wall with holes in it, as bands rather than one slab.
  // This is not tidiness: lighting.js rasterises level.colliders into the
  // occupancy grid its sky-visibility bake and its shaft solver both read, so a
  // solid box across the east arch would report the arch as filled and the
  // shaft that is supposed to spill through it would be discarded silently.
  function wallColliders(L, x, thick, z0, z1, yBase, yTop, holes) {
    var cuts = [];
    var i;
    for (i = 0; i < holes.length; i++) {
      cuts.push({ a: holes[i].cz - holes[i].hw, b: holes[i].cz + holes[i].hw,
        top: holes[i].ySpring + holes[i].r });
    }
    cuts.sort(function (p, q) { return p.a - q.a; });
    var cur = z0;
    for (i = 0; i < cuts.length; i++) {
      if (cuts[i].a > cur + 0.05) {
        L.addCollider(x, (yBase + yTop) * 0.5, (cur + cuts[i].a) * 0.5, thick * 0.5,
          (yTop - yBase) * 0.5, (cuts[i].a - cur) * 0.5, 'concrete');
      }
      if (yTop - cuts[i].top > 0.05) {
        L.addCollider(x, (cuts[i].top + yTop) * 0.5, (cuts[i].a + cuts[i].b) * 0.5,
          thick * 0.5, (yTop - cuts[i].top) * 0.5, (cuts[i].b - cuts[i].a) * 0.5, 'concrete');
      }
      cur = cuts[i].b;
    }
    if (z1 > cur + 0.05) {
      L.addCollider(x, (yBase + yTop) * 0.5, (cur + z1) * 0.5, thick * 0.5,
        (yTop - yBase) * 0.5, (z1 - cur) * 0.5, 'concrete');
    }
  }

  function buildEndWalls(L, B, rng, N) {
    var wallTop = CROWN + 0.60;
    var s, i;

    function portalTrim(x, thick, cz) {
      archRing(B, 'raw_concrete', x, thick, cz, PORTAL_SPRING, PORTAL_R,
        Math.PI * 0.5, 16, 0.36, 0.13);
      // the jamb piers either side of the horseshoe
      B.box('raw_concrete', thick + 0.26, PORTAL_SPRING + 0.7, 0.36,
        x, (PORTAL_SPRING + 0.7) * 0.5 - 0.4, cz - PORTAL_R - 0.12);
      B.box('raw_concrete', thick + 0.26, PORTAL_SPRING + 0.7, 0.36,
        x, (PORTAL_SPRING + 0.7) * 0.5 - 0.4, cz + PORTAL_R + 0.12);
    }

    // ---- WEST WALL --------------------------------------------------------
    var wx = HALL_X0 - 0.60;
    B.paint = 'seg';
    archedWall(B, 'tunnel_seg', wx, 1.20, -HALL_HZ, HALL_HZ, -0.90, wallTop, [
      { cz: -TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: 0, hw: 0.62, ySpring: 2.10, r: 0.62 }
    ], 0.22);
    // the substructure under the service door, so the platform void is closed
    B.box('raw_concrete', 1.20, PLAT_Y + 0.90, 1.30, wx, (PLAT_Y - 0.90) * 0.5, 0);
    B.paint = 'metal';
    portalTrim(wx, 1.20, -TRK_CZ);
    portalTrim(wx, 1.20, TRK_CZ);
    // the service door itself, hanging open off one hinge
    B.paint = 'clad';
    B.boxR('car_paint', 0.06, 2.60, 1.16, wx + 0.62, PLAT_Y + 1.30, 0.52, 0, -0.38, 0.03);
    B.paint = 'metal';
    card(B, CELL.DOOR, wx + 0.66, PLAT_Y + 1.55, 0.30, 0.62, 0.62, 'x', 1, tint(0xdfe4d8, 0.4));
    card(B, CELL.NAME, wx + 0.63, PLAT_Y + 2.35, -2.60, 4.4, 4.4, 'x', 1, tint(0xe8f0e0, 0.35));
    wallColliders(L, wx, 1.20, -HALL_HZ, HALL_HZ, -0.90, wallTop, [
      { cz: -TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: 0, hw: 0.62, ySpring: 2.10, r: 0.62 },
      { cz: TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R }
    ]);

    // ---- EAST WALL --------------------------------------------------------
    var ex = HALL_X1 + 0.60;
    B.paint = 'seg';
    archedWall(B, 'tunnel_seg', ex, 1.20, -HALL_HZ, HALL_HZ, -0.90, wallTop, [
      { cz: -TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: 0, hw: EARCH_HW, ySpring: EARCH_CY, r: EARCH_R }
    ], 0.22);
    // the arch springs from platform level, so the void below it is filled
    B.box('raw_concrete', 1.20, PLAT_Y + 0.90, EARCH_HW * 2, ex, (PLAT_Y - 0.90) * 0.5, 0);
    B.paint = 'metal';
    portalTrim(ex, 1.20, -TRK_CZ);
    portalTrim(ex, 1.20, TRK_CZ);
    archRing(B, 'wall_tile', ex, 1.20, 0, EARCH_CY, EARCH_R, EARCH_SPAN, 18, 0.40, 0.14);
    // tiled reveal round the big arch, and the dado carried through it
    B.paint = 'clad';
    for (s = -1; s <= 1; s += 2) {
      B.box('wall_tile', 1.24, 3.40 - PLAT_Y, 0.34, ex, (PLAT_Y + 3.40) * 0.5, s * (EARCH_HW + 0.17));
      B.box('dado_paint', 1.26, 1.05, 0.36, ex, 1.96, s * (EARCH_HW + 0.17));
    }
    B.paint = 'metal';
    card(B, CELL.EXIT, ex - 0.63, 4.30, 0.0, 3.2, 3.2, 'x', -1, tint(0xdff0e0, 0.35));
    card(B, CELL.NUM, ex - 0.63, 4.30, -3.4, 1.5, 1.5, 'x', -1, null);
    wallColliders(L, ex, 1.20, -HALL_HZ, HALL_HZ, -0.90, wallTop, [
      { cz: -TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R },
      { cz: 0, hw: EARCH_HW, ySpring: EARCH_CY, r: EARCH_R },
      { cz: TRK_CZ, hw: PORTAL_R, ySpring: PORTAL_SPRING, r: PORTAL_R }
    ]);
  }

  // ---------------------------------------------------------------------------
  // THE TRACK HALLS. Outer wall, ballasted trackbed, running rails, a live-look
  // conductor rail on the cess side, cable brackets and the emergency strip.
  // Everything below the water line still gets built - the flood is 26 cm and
  // rail heads, sleeper ends and the conductor rail all stand out of it, which
  // is most of what tells the eye that dark band IS water.
  // ---------------------------------------------------------------------------
  function buildTrackHalls(L, B, rng, N) {
    var s, i, k;
    for (s = -1; s <= 1; s += 2) {
      var cz = s * TRK_CZ;
      var wallZ = s * (HALL_HZ + 0.30);

      // outer wall, tiled to dado height and bare concrete above
      B.paint = 'seg';
      B.box('tunnel_seg', HALL_X1 - HALL_X0, TRK_SPRING + 1.10, 0.60,
        (HALL_X0 + HALL_X1) * 0.5, (TRK_SPRING - 1.10) * 0.5, wallZ);
      B.paint = 'clad';
      B.box('dado_paint', HALL_X1 - HALL_X0, 1.15, 0.62,
        (HALL_X0 + HALL_X1) * 0.5, 1.35, s * (HALL_HZ - 0.02));
      B.paint = 'metal';
      L.addCollider((HALL_X0 + HALL_X1) * 0.5, 1.6, wallZ,
        (HALL_X1 - HALL_X0) * 0.5, 2.6, 0.30, 'concrete');

      // trackbed
      B.paint = 'ballast';
      B.add('ballast', deck(HALL_X0, HALL_X1, s < 0 ? -HALL_HZ : PLAT_EDGE,
        s < 0 ? -PLAT_EDGE : HALL_HZ, 0.70, function (x, z) { return trackY(x, z, N); }));
      B.paint = 'metal';
      L.addCollider((HALL_X0 + HALL_X1) * 0.5, TRACK_Y - 0.30, cz,
        (HALL_X1 - HALL_X0) * 0.5, 0.30, (HALL_HZ - PLAT_EDGE) * 0.5, 'gravel', true);

      // sleepers and rails
      var nSleep = Math.floor((HALL_X1 - HALL_X0) / 0.62);
      for (i = 0; i < nSleep; i++) {
        var sx = HALL_X0 + 0.4 + i * 0.62;
        B.paint = 'rubble';
        B.boxR('raw_concrete', 0.24, 0.19, 2.50, sx, TRACK_Y + 0.10, cz,
          0, rng.range(-0.012, 0.012), rng.range(-0.02, 0.02));
        B.paint = 'metal';
      }
      for (k = -1; k <= 1; k += 2) {
        B.box('rust_metal', HALL_X1 - HALL_X0, 0.15, 0.075,
          (HALL_X0 + HALL_X1) * 0.5, 0.275, cz + k * 0.7175);
        B.box('rust_metal', HALL_X1 - HALL_X0, 0.035, 0.13,
          (HALL_X0 + HALL_X1) * 0.5, 0.345, cz + k * 0.7175);
      }
      // conductor rail on the cess side, on porcelain pots
      var crZ = cz + s * 1.62;
      B.box('rust_metal', HALL_X1 - HALL_X0, 0.10, 0.16,
        (HALL_X0 + HALL_X1) * 0.5, 0.66, crZ);
      B.paint = 'clad';
      for (i = 0; i < 18; i++) {
        var px2 = HALL_X0 + 2 + i * ((HALL_X1 - HALL_X0 - 4) / 18);
        B.cyl('panel_plastic', 0.10, 0.13, 0.32, px2, 0.45, crZ, 0, 0, 0, 8);
      }
      B.paint = 'metal';
      // hazard placards on the wall above it
      for (i = 0; i < 5; i++) {
        card(B, CELL.HAZARD, HALL_X0 + 8 + i * 13.5, 2.15, s * (HALL_HZ - 0.05),
          0.85, 0.85, 'z', -s, null);
      }

      // cable brackets and the cable runs they carry - the tunnel's leading line
      B.paint = 'metal';
      for (i = 0; i < 46; i++) {
        var bx = HALL_X0 + 1.0 + i * ((HALL_X1 - HALL_X0 - 2.0) / 46);
        B.box('rust_metal', 0.07, 0.055, 0.46, bx, 2.32, s * (HALL_HZ - 0.24));
      }
      B.paint = 'clad';
      for (k = 0; k < 4; k++) {
        B.box('cable_rubber', HALL_X1 - HALL_X0, 0.075, 0.075,
          (HALL_X0 + HALL_X1) * 0.5, 2.27 - (k & 1) * 0.10, s * (HALL_HZ - 0.10 - k * 0.115));
      }
      B.paint = 'metal';
    }
  }

  // ---------------------------------------------------------------------------
  // THE RUNNING TUNNELS. Bolted segment rings, cable runs, a walking board on
  // the cess, and forty centimetres of standing water. The `hero2` framing is
  // built out of exactly three things: the ring rhythm converging, the strip
  // lights receding, and the water returning both.
  // ---------------------------------------------------------------------------
  function buildTunnel(L, B, rng, N, cz, x0, x1) {
    var prof = boreProfile(cz, TUN_AXIS_Y, TUN_R, 2.62, 22);
    var jit = function (x, z) {
      return (N.fbm2(x * 0.09 + 4.3, z * 0.09 + 1.9, 2) * 0.5 + 0.5) * 0.055 - 0.028;
    };
    B.paint = 'seg';
    B.add('tunnel_seg', sweepX(prof, x0, x1, Math.max(4, Math.round((x1 - x0) / 0.9)), null, jit));
    B.add('ballast', deck(x0, x1, cz - 2.30, cz + 2.30, 0.80,
      function (x, z) { return tunnelY(x, z, N); }));
    B.paint = 'metal';

    // segment rings, every 1.5 m
    var rings = Math.max(1, Math.floor((x1 - x0) / 1.5));
    var i, k;
    for (i = 0; i <= rings; i++) {
      var rx = x0 + (i + 0.5) * ((x1 - x0) / (rings + 1));
      var rp = boreProfile(cz, TUN_AXIS_Y, TUN_R - 0.055, 2.50, 14);
      for (k = 0; k + 1 < rp.length; k++) {
        B.strut('tunnel_seg', rx, rp[k][1], rp[k][0], rx, rp[k + 1][1], rp[k + 1][0], 0.20, 0.12);
      }
    }
    // rails, submerged but standing proud of the water by 8 cm
    for (k = -1; k <= 1; k += 2) {
      B.box('rust_metal', x1 - x0, 0.15, 0.075, (x0 + x1) * 0.5, TUN_INV + 0.155, cz + k * 0.7175);
      B.box('rust_metal', x1 - x0, 0.035, 0.13, (x0 + x1) * 0.5, TUN_INV + 0.225, cz + k * 0.7175);
    }
    var nSleep = Math.floor((x1 - x0) / 0.62);
    B.paint = 'rubble';
    for (i = 0; i < nSleep; i++) {
      B.boxR('raw_concrete', 0.24, 0.19, 2.50, x0 + 0.4 + i * 0.62, TUN_INV - 0.02, cz,
        0, rng.range(-0.012, 0.012), rng.range(-0.02, 0.02));
    }
    B.paint = 'metal';

    // the cess walkway: a raised board on brackets, above the flood, which is
    // both where the player walks and the one dry line in the frame
    var side = cz < 0 ? -1 : 1;
    var wz = cz + side * 2.05;
    B.box('grate', x1 - x0, 0.09, 0.86, (x0 + x1) * 0.5, 0.62, wz);
    for (i = 0; i < Math.floor((x1 - x0) / 1.8); i++) {
      var sx2 = x0 + 0.9 + i * 1.8;
      B.strut('rust_metal', sx2, 0.58, wz - side * 0.40, sx2, TUN_INV, wz - side * 0.40, 0.06, 0.06);
      B.strut('rust_metal', sx2, 0.60, wz + side * 0.38, sx2, 1.34, wz + side * 0.55, 0.05, 0.05);
    }
    // handrail along the walkway
    B.box('rust_metal', x1 - x0, 0.05, 0.05, (x0 + x1) * 0.5, 1.34, wz + side * 0.55);
    L.addCollider((x0 + x1) * 0.5, 0.55, wz, (x1 - x0) * 0.5, 0.06, 0.43, 'metal', true);
    L.addCollider((x0 + x1) * 0.5, TUN_INV - 0.30, cz, (x1 - x0) * 0.5, 0.30, 1.6, 'gravel', true);
    // the bore itself, as two flanking blockers so the AI cannot walk through it
    L.addCollider((x0 + x1) * 0.5, 2.0, cz - side * 2.9, (x1 - x0) * 0.5, 2.6, 0.5, 'concrete');
    L.addCollider((x0 + x1) * 0.5, TUN_AXIS_Y + TUN_R + 0.3, cz, (x1 - x0) * 0.5, 0.4, TUN_R, 'concrete');

    // cable brackets and runs, on the wall opposite the walkway
    var kz = cz - side * 2.05;
    B.paint = 'clad';
    for (k = 0; k < 5; k++) {
      B.box('cable_rubber', x1 - x0, 0.07, 0.07, (x0 + x1) * 0.5,
        2.30 - (k & 1) * 0.11, kz - side * (k * 0.115));
    }
    B.paint = 'metal';
    for (i = 0; i < Math.floor((x1 - x0) / 1.5); i++) {
      B.box('rust_metal', 0.06, 0.05, 0.62, x0 + 0.75 + i * 1.5, 2.36, kz - side * 0.24);
    }
    // chainage markers
    for (i = 0; i < Math.floor((x1 - x0) / 9); i++) {
      card(B, CELL.CHAIN, x0 + 4.5 + i * 9, 2.05, kz - side * 0.50, 0.62, 0.62,
        'z', -side, tint(0xe4e6d8, 0.35));
    }
  }

  function buildTunnels(L, B, rng, N) {
    var s;
    for (s = -1; s <= 1; s += 2) {
      buildTunnel(L, B, rng, N, s * TRK_CZ, TUN_W_END, HALL_X0 - 1.20);
      buildTunnel(L, B, rng, N, s * TRK_CZ, HALL_X1 + 1.20, TUN_E_END);
    }
    // the far ends are plugged with a collapse rather than left as black holes:
    // a tunnel that simply stops is the one thing that gives the trick away.
    for (s = -1; s <= 1; s += 2) {
      var cz = s * TRK_CZ;
      B.paint = 'rubble';
      for (var i = 0; i < 26; i++) {
        var t = rng.next();
        var rx = TUN_W_END + 0.4 + t * 3.4;
        var yy = TUN_INV + rng.range(0, 2.5) * (1 - t * 0.7);
        B.boxR('raw_concrete', rng.range(0.3, 1.2), rng.range(0.25, 0.9), rng.range(0.3, 1.2),
          rx, yy, cz + rng.range(-2.0, 2.0),
          rng.range(-0.7, 0.7), rng.range(0, 3.14), rng.range(-0.7, 0.7));
        var ex = TUN_E_END - 0.4 - t * 3.4;
        B.boxR('raw_concrete', rng.range(0.3, 1.2), rng.range(0.25, 0.9), rng.range(0.3, 1.2),
          ex, yy, cz + rng.range(-2.0, 2.0),
          rng.range(-0.7, 0.7), rng.range(0, 3.14), rng.range(-0.7, 0.7));
      }
      B.paint = 'metal';
      L.addCollider(TUN_W_END + 1.6, 1.4, cz, 1.8, 2.4, 2.6, 'concrete');
      L.addCollider(TUN_E_END - 1.6, 1.4, cz, 1.8, 2.4, 2.6, 'concrete');
    }
  }

  // Adding a constant vertical offset f(x) to a swept surface is a SHEAR, not a
  // rotation, so the normals have to be transformed by the inverse transpose or
  // the escalator tube shades as though it were horizontal - which under a line
  // of tube lights running up its crown is immediately, obviously wrong.
  function shearNormals(geo, slope) {
    if (!geo) return geo;
    var n = geo.attributes.normal.array;
    for (var i = 0; i < n.length; i += 3) {
      var nx = n[i] - slope * n[i + 1];
      var l = Math.sqrt(nx * nx + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]) || 1;
      n[i] = nx / l; n[i + 1] = n[i + 1] / l; n[i + 2] = n[i + 2] / l;
    }
    return geo;
  }

  // ============================================================== THE TRAIN ==
  // Local frame: x along the car, origin on the trackbed datum at the car's
  // centre. Floor at y = 0.90, so a car standing on a level track with its
  // origin at y = 0.20 has its floor exactly at platform level, which is the
  // one dimension a metro car cannot get wrong.
  var CAR_HL = 9.20, CAR_HW = 1.35;
  var CAR_FLOOR = 0.90, CAR_ROOF = 3.40, CAR_SKIRT = 0.10;
  var DOOR_X = [-6.15, -2.05, 2.05, 6.15], DOOR_HW = 0.66;

  function buildCar(L, B, rng, opt) {
    var i, k, s;
    var cab = !!opt.cab, gut = !!opt.gutted, lit = !!opt.lit;
    var body = tint(opt.body || 0xc8ccc6, 0.55);
    var band = tint(opt.band || 0x9a3a32, 0.85);

    // ---- underframe and bogies ---------------------------------------------
    B.paint = 'metal';
    B.box('car_paint', CAR_HL * 2, 0.34, 2.42, 0, CAR_SKIRT + 0.30, 0);
    for (k = -1; k <= 1; k += 2) {
      var bx = k * 6.20;
      B.box('rust_metal', 2.60, 0.52, 2.10, bx, 0.36, 0);
      for (i = -1; i <= 1; i += 2) {
        for (s = -1; s <= 1; s += 2) {
          B.cyl('rust_metal', 0.43, 0.43, 0.11, bx + i * 0.98, 0.34, s * 0.7175,
            0, 0, Math.PI * 0.5, 14);
        }
      }
      // motor casings and brake gear - silhouette under the skirt
      B.box('rust_metal', 1.30, 0.42, 0.62, bx, 0.52, 0.0);
      B.box('rust_metal', 0.50, 0.34, 0.34, bx + 1.5, 0.60, 0.85);
    }
    // equipment slung between the bogies
    B.box('rust_metal', 3.20, 0.62, 1.10, -1.4, 0.48, 0.55);
    B.box('rust_metal', 2.10, 0.54, 0.95, 2.6, 0.46, -0.62);

    // ---- flanks -------------------------------------------------------------
    // Three courses: fluted skirt, window band, upper panel. The flutes are the
    // library's corrugated profile at its own pitch, which is why the lower
    // flank is a separate material rather than a tint.
    // ------------------------------------------------------------------------
    // EVERY COURSE IS TWO SIDE PANELS, NOT ONE FULL-WIDTH BOX.
    //
    // The first version built each course as a single box spanning the whole
    // 2.70 m section, which is fine from outside and catastrophic from within:
    // it fills the car SOLID. The upper flank alone occupied local y 2.58-3.30,
    // so the saloon's usable interior was a 1.06 m slot between the top of the
    // skirt box and the underside of the flank box - the `interior` framing
    // stood inside it with its ceiling 6 cm above the lens, the ceiling lines
    // were buried in solid geometry and never rendered at all, and the brief's
    // "a derailed train you can walk through" was not true of any car.
    // ------------------------------------------------------------------------
    var oldT = B.tint;
    var SK = CAR_HW - 0.09;                        // panel centre-line
    B.tint = body;
    B.paint = 'clad';
    for (s = -1; s <= 1; s += 2) {
      B.box('car_alu', CAR_HL * 2, 0.62, 0.19, 0, 1.21, s * SK);
      B.box('car_paint', CAR_HL * 2, 0.30, 0.21, 0, 1.67, s * SK);
      B.box('car_paint', CAR_HL * 2, 0.72, 0.19, 0, 2.94, s * SK);
      B.tint = band;
      B.box('car_paint', CAR_HL * 2, 0.16, 0.24, 0, 1.60, s * (SK + 0.02));
      B.tint = body;
      // the dark recess the glazing sits in
      B.dark = 0.55;
      B.box('car_paint', CAR_HL * 2, 0.92, 0.10, 0, 2.28, s * (SK + 0.03));
      B.dark = 0;
    }
    // roof, cambered, with equipment. This one IS full width - it is the top.
    B.box('car_paint', CAR_HL * 2, 0.16, CAR_HW * 2 - 0.10, 0, CAR_ROOF - 0.02, 0);
    B.box('car_paint', CAR_HL * 2 - 0.6, 0.12, CAR_HW * 2 - 0.55, 0, CAR_ROOF + 0.08, 0);
    B.paint = 'metal';
    B.tint = oldT;
    for (i = 0; i < 5; i++) {
      var rx = -6.6 + i * 3.3;
      B.box('rust_metal', 1.35, 0.26, 1.05, rx, CAR_ROOF + 0.20, rng.range(-0.4, 0.4));
      B.box('rust_metal', 0.30, 0.16, 0.30, rx + 0.9, CAR_ROOF + 0.16, 0.75);
    }
    B.box('rust_metal', 2.6, 0.10, 0.16, 1.2, CAR_ROOF + 0.34, -0.55);

    // ---- windows and doors --------------------------------------------------
    for (s = -1; s <= 1; s += 2) {
      var fz = s * (CAR_HW + 0.005);
      // saloon glazing between the doorways
      for (i = 0; i < 5; i++) {
        var wxs = -8.2 + i * 4.1;
        var broken = rng.bool(gut ? 0.75 : 0.42);
        if (!broken) {
          B.paint = 'flat';
          B.dark = 0.35;
          B.add('glass_dirty', quad(2.10, 0.86, 0, 0, 1, 1),
            makeM(wxs, 2.30, fz, 0, s > 0 ? 0 : Math.PI, 0));
          B.dark = 0;
          B.paint = 'metal';
        } else {
          // a shattered pane is a rim of glass in the rubber, not an empty hole
          for (k = 0; k < 7; k++) {
            B.boxR('glass_dirty', rng.range(0.10, 0.34), rng.range(0.06, 0.22), 0.012,
              wxs + rng.range(-1.0, 1.0), 2.30 + rng.range(-0.40, 0.40) * (rng.bool() ? 1 : -1),
              fz, 0, s > 0 ? 0 : Math.PI, rng.range(-0.6, 0.6));
          }
        }
        B.box('car_paint', 2.22, 0.05, 0.05, wxs, 2.75, fz);
        B.box('car_paint', 2.22, 0.05, 0.05, wxs, 1.85, fz);
      }
      // doorways: recessed leaves, one pair jammed open on every car
      for (i = 0; i < DOOR_X.length; i++) {
        var dx = DOOR_X[i];
        var open = (i === (gut ? 1 : 2)) ? 0.62 : (rng.bool(0.4) ? rng.range(0.10, 0.40) : 0);
        B.paint = 'clad';
        B.dark = 0.30;
        B.box('car_paint', DOOR_HW * 2 + 0.14, 1.95, 0.06, dx, 1.88, s * (CAR_HW - 0.06));
        B.dark = 0;
        for (k = -1; k <= 1; k += 2) {
          B.box('car_paint', DOOR_HW - open, 1.92, 0.055,
            dx + k * (DOOR_HW * 0.5 + open * 0.5), 1.88, fz - s * 0.012);
          B.paint = 'flat';
          B.dark = 0.35;
          B.add('glass_dirty', quad(Math.max(0.06, DOOR_HW - open - 0.20), 0.72, 0, 0, 1, 1),
            makeM(dx + k * (DOOR_HW * 0.5 + open * 0.5), 2.30, fz + s * 0.004,
              0, s > 0 ? 0 : Math.PI, 0));
          B.dark = 0;
          B.paint = 'clad';
        }
        B.paint = 'metal';
        // rubber seals down the leading edges
        B.paint = 'clad';
        B.box('cable_rubber', 0.05, 1.92, 0.07, dx - open * 0.5 - 0.02, 1.88, fz);
        B.box('cable_rubber', 0.05, 1.92, 0.07, dx + open * 0.5 + 0.02, 1.88, fz);
        B.paint = 'metal';
      }
      // grab handle and a stencilled number
      B.box('car_paint', 0.06, 0.06, 0.10, -CAR_HL + 0.5, 1.95, fz);
      card(B, CELL.NUM, -CAR_HL + 1.35, 2.90, fz + s * 0.01, 0.44, 0.44, 'z', s, null);
      card(B, CELL.DOOR, 4.6, 1.35, fz + s * 0.01, 0.55, 0.55, 'z', s,
        tint(0xe0e4d8, 0.35));
      if (rng.bool(0.8)) {
        card(B, CELL.TAG_A + (rng.bool() ? 0 : 1), rng.range(-6, 6), 1.35, fz + s * 0.012,
          2.1, 2.1, 'z', s, tint(0xffffff, 0.2));
      }
      card(B, CELL.WEEP, rng.range(-7, 7), 1.55, fz + s * 0.008, 1.5, 1.5, 'z', s, null);
    }

    // ---- ends ---------------------------------------------------------------
    if (cab) {
      // ---- THE CAB END ------------------------------------------------------
      // The single most-looked-at object in the level, and the first version got
      // it wrong in the most instructive way: it was ONE box with a rake on it,
      // and face-on that is a rectangle. A capture of the hero framing came back
      // with a rusty plank standing on the platform. A nose reads as a nose
      // because of the bands ACROSS it - skirt, valance, waist beading, the
      // recessed screen band, the roof dome - and every one of those is a
      // silhouette break at a different depth. So it is built as five courses,
      // each stepped in Z, rather than as one slab with detail painted on.
      var FX = -CAR_HL - 0.10;
      B.paint = 'clad';
      B.tint = body;
      // lower skirt, set back
      B.box('car_paint', 0.34, 0.72, CAR_HW * 2 - 0.20, FX - 0.10, 1.00, 0);
      // main panel, proud
      B.boxR('car_paint', 0.40, 0.95, CAR_HW * 2 - 0.04, FX - 0.20, 1.86, 0, 0, 0, -0.05);
      // the screen band: recessed and dark, which is what reads at range
      B.dark = 0.62;
      B.boxR('car_paint', 0.26, 0.94, CAR_HW * 2 - 0.16, FX - 0.06, 2.72, 0, 0, 0, -0.16);
      B.dark = 0;
      // roof dome / destination box over the screen
      B.boxR('car_paint', 0.42, 0.34, CAR_HW * 2 - 0.30, FX - 0.16, 3.24, 0, 0, 0, -0.30);
      B.tint = oldT;
      B.paint = 'metal';
      // waist beading and a hand rail down each corner - the horizontals that
      // give the front a scale
      B.box('car_paint', 0.10, 0.07, CAR_HW * 2 - 0.02, FX - 0.40, 2.32, 0);
      B.box('car_paint', 0.10, 0.06, CAR_HW * 2 - 0.02, FX - 0.30, 1.42, 0);
      for (k = -1; k <= 1; k += 2) {
        B.box('car_paint', 0.07, 1.30, 0.07, FX - 0.34, 2.10, k * (CAR_HW - 0.12));
      }
      // windscreen, two panes, one gone
      B.paint = 'flat';
      B.dark = 0.34;
      for (k = -1; k <= 1; k += 2) {
        if (k > 0) continue;                              // the other one is out
        B.add('glass_dirty', quad(1.06, 0.82, 0, 0, 1, 1),
          makeM(FX - 0.22, 2.74, k * 0.60, 0, -Math.PI * 0.5, 0.16));
      }
      B.dark = 0;
      B.paint = 'metal';
      B.box('car_paint', 0.10, 0.94, 0.09, FX - 0.20, 2.72, 0);
      // shards left in the empty aperture
      for (k = 0; k < 6; k++) {
        B.boxR('glass_dirty', 0.011, rng.range(0.10, 0.30), rng.range(0.08, 0.26),
          FX - 0.20, 2.72 + rng.range(-0.36, 0.36), 0.60 + rng.range(-0.44, 0.44),
          rng.range(-0.5, 0.5), 0, 0.16);
      }
      // headlight cluster: two big smashed reflectors and a marker light
      for (k = -1; k <= 1; k += 2) {
        B.cyl('rust_metal', 0.26, 0.30, 0.20, FX - 0.16, 1.34, k * 0.92,
          0, 0, Math.PI * 0.5, 14);
        B.cyl('car_paint', 0.20, 0.20, 0.09, FX - 0.30, 1.34, k * 0.92,
          0, 0, Math.PI * 0.5, 12);
      }
      // NOTE: no emitter here. emitBox writes WORLD matrices and buildCar runs
      // inside the car's transform stack, so a lamp added here would land at the
      // car's local coordinates in world space - i.e. somewhere out on the
      // platform. The wreck's surviving marker light is added in buildTrain,
      // after the stack has been popped and the nose is a real world point.
      // buffer beam, coupler and the anticlimber, all bent
      B.box('rust_metal', 0.30, 0.30, CAR_HW * 2 - 0.30, FX - 0.34, 0.60, 0);
      B.boxR('rust_metal', 0.85, 0.26, 0.32, FX - 0.72, 0.66, 0.06, 0, 0.10, -0.06);
      B.boxR('rust_metal', 0.26, 0.44, 0.46, FX - 1.12, 0.62, 0.12, 0, 0.10, -0.10);
      for (k = -1; k <= 1; k += 2) {
        B.box('rust_metal', 0.24, 0.10, 0.12, FX - 0.44, 0.86, k * 0.72);
      }
      card(B, CELL.NUM, FX - 0.42, 3.24, 0, 0.5, 0.5, 'x', -1, null);
      card(B, CELL.STRIP, FX - 0.29, 2.35, 0.4, 0.9, 0.9, 'x', -1, tint(0xf0f0e0, 0.3));
    } else {
      B.paint = 'clad';
      B.tint = body;
      B.box('car_paint', 0.20, 3.28, CAR_HW * 2 - 0.04, -CAR_HL - 0.06, 1.90, 0);
      B.tint = oldT;
      B.paint = 'metal';
      // gangway doorway, open
      B.box('car_paint', 0.24, 2.00, 0.10, -CAR_HL - 0.06, 1.90, -0.52);
      B.box('car_paint', 0.24, 2.00, 0.10, -CAR_HL - 0.06, 1.90, 0.52);
      B.box('rust_metal', 0.55, 0.20, 0.55, -CAR_HL - 0.32, 0.86, 0);
    }
    B.paint = 'clad';
    B.tint = body;
    B.box('car_paint', 0.20, 3.28, CAR_HW * 2 - 0.04, CAR_HL + 0.06, 1.90, 0);
    B.tint = oldT;
    B.paint = 'metal';
    B.box('car_paint', 0.24, 2.00, 0.10, CAR_HL + 0.06, 1.90, -0.52);
    B.box('car_paint', 0.24, 2.00, 0.10, CAR_HL + 0.06, 1.90, 0.52);
    B.box('rust_metal', 0.55, 0.20, 0.55, CAR_HL + 0.32, 0.86, 0);

    // ---- interior -----------------------------------------------------------
    // Built for every car, because every car has open doors and shattered
    // windows and a black interior behind them is the cheapest tell there is.
    B.paint = 'floor';
    B.box('panel_plastic', CAR_HL * 2 - 0.3, 0.06, CAR_HW * 2 - 0.16, 0, CAR_FLOOR, 0);
    B.paint = 'clad';
    B.dark = 0.08;
    for (s = -1; s <= 1; s += 2) {
      // inner wall lining
      B.box('panel_plastic', CAR_HL * 2 - 0.3, 1.05, 0.07, 0, 1.46, s * (CAR_HW - 0.10));
      B.box('panel_plastic', CAR_HL * 2 - 0.3, 0.62, 0.07, 0, 3.02, s * (CAR_HW - 0.10));
      // longitudinal bench seats, in runs between the doorways
      for (i = 0; i < 3; i++) {
        var sx = -4.1 + i * 4.1;
        if (rng.bool(gut ? 0.45 : 0.12)) continue;      // torn out
        B.box('panel_plastic', 3.20, 0.09, 0.46, sx, 1.34, s * (CAR_HW - 0.36));
        B.box('panel_plastic', 3.20, 0.40, 0.08, sx, 1.56, s * (CAR_HW - 0.13));
        B.paint = 'metal';
        for (k = -1; k <= 1; k += 2) {
          B.box('rust_metal', 0.05, 0.44, 0.05, sx + k * 1.5, 1.12, s * (CAR_HW - 0.50));
        }
        B.paint = 'clad';
      }
    }
    B.dark = 0;
    B.paint = 'metal';
    // ceiling, and the grab poles that give the interior its verticals
    B.paint = 'clad';
    B.dark = 0.12;
    B.box('panel_plastic', CAR_HL * 2 - 0.3, 0.08, CAR_HW * 2 - 0.20, 0, 3.26, 0);
    B.dark = 0;
    B.paint = 'metal';
    for (i = 0; i < 8; i++) {
      var gx = -7.5 + i * 2.15;
      for (s = -1; s <= 1; s += 2) {
        if (rng.bool(0.18)) continue;
        B.cyl('car_paint', 0.028, 0.028, 2.30, gx, 2.07, s * 0.86, 0, 0, 0, 8);
      }
    }
    B.box('car_paint', CAR_HL * 2 - 1.0, 0.05, 0.05, 0, 3.14, -0.86);
    B.box('car_paint', CAR_HL * 2 - 1.0, 0.05, 0.05, 0, 3.14, 0.86);
    // fallen ceiling panels and hanging cable inside a gutted car
    if (gut) {
      B.paint = 'rubble';
      for (i = 0; i < 7; i++) {
        B.boxR('panel_plastic', rng.range(0.5, 1.3), 0.04, rng.range(0.4, 1.0),
          rng.range(-8, 8), CAR_FLOOR + 0.06, rng.range(-1.0, 1.0),
          rng.range(-0.3, 0.3), rng.range(0, 3.1), rng.range(-0.3, 0.3));
      }
      B.paint = 'metal';
    }
    return lit;
  }

  // ---------------------------------------------------------------------------
  // The wreck itself: three cars, one derailed onto the platform, one straddling
  // the east portal, one deep in the tunnel behind it. Positions and rotations
  // are solved so both ends of the lead car REST on something - the nose corner
  // lands within a centimetre of platform level and the tail corner within a
  // centimetre of the trackbed - because a derailed car floating a hand's width
  // above the ground is the single most common way a set piece like this fails.
  // ---------------------------------------------------------------------------
  var CARS = [
    { name: 'lead', x: 4.60, y: 0.786, z: -6.55, rx: 0.150, ry: 0.260, rz: -0.045,
      cab: true, gutted: true, lit: false, body: 0xb9bdb6, band: 0x8e3630 },
    { name: 'second', x: 24.50, y: 0.200, z: -6.60, rx: 0.0, ry: 0.0, rz: 0.0,
      cab: false, gutted: false, lit: true, body: 0xc2c6c0, band: 0x8e3630 },
    { name: 'third', x: 43.20, y: 0.200, z: -6.60, rx: 0.0, ry: 0.012, rz: 0.0,
      cab: false, gutted: true, lit: false, body: 0xbcc0ba, band: 0x8e3630 }
  ];

  function buildTrain(L, B, rng, N) {
    var q = new THREE.Quaternion(), e = new THREE.Euler();
    for (var i = 0; i < CARS.length; i++) {
      var c = CARS[i];
      B.pushXYZ(c.x, c.y, c.z, c.rx, c.ry, c.rz);
      buildCar(L, B, rng.fork ? rng.fork(0x7241 + i * 37) : rng, c);
      B.pop();
      e.set(c.rx, c.ry, c.rz, 'YXZ');
      q.setFromEuler(e);
      L.colliders.push({
        type: 'box',
        center: new THREE.Vector3(c.x, c.y + (CAR_SKIRT + CAR_ROOF) * 0.5,
          c.z).add(new THREE.Vector3(0, 0, 0)),
        halfExtents: new THREE.Vector3(CAR_HL + 0.6, (CAR_ROOF - CAR_SKIRT) * 0.5, CAR_HW),
        quaternion: q.clone(), material: 'metal', floor: false
      });
    }
    // The one marker lamp still burning on the wreck. World coordinates,
    // solved off the same rotation the car was built with.
    var c0 = CARS[0];
    var _m = makeM(c0.x, c0.y, c0.z, c0.rx, c0.ry, c0.rz);
    var mp = new THREE.Vector3(-CAR_HL - 0.44, 1.34, -0.92).applyMatrix4(_m);
    emitBox(L, mp.x, mp.y, mp.z, 0.10, 0.15, 0.15, c0.ry, 0xff5a30, 1.15, 'dying');

    // the bogie the lead car shed, lying on the platform under its tail
    B.paint = 'metal';
    B.boxR('rust_metal', 2.60, 0.52, 2.10, 13.9, 0.42, -8.30, 0.22, 0.4, 0.12);
    for (var k = -1; k <= 1; k += 2) {
      B.cyl('rust_metal', 0.43, 0.43, 0.11, 13.9 + k * 0.9, 0.42, -8.30 + k * 0.3,
        0.22, 0.4, Math.PI * 0.5, 14);
    }
    // torn skin peeled off the flank where it took the pier
    B.paint = 'clad';
    for (var j = 0; j < 9; j++) {
      B.boxR('car_alu', rng.range(0.5, 1.6), 0.02, rng.range(0.4, 1.1),
        rng.range(-4.5, 2.5), platY(0, -3.5, N) + rng.range(0.02, 0.5),
        rng.range(-4.6, -2.0), rng.range(-0.8, 0.8), rng.range(0, 3.1), rng.range(-0.8, 0.8));
    }
    B.paint = 'metal';
  }

  // ==================================================== THE ESCALATOR HALL ==
  // The level's one genuinely vertical space, and the only place a camera can
  // stand and see 7.5 m of rise. Lower landing, an inclined bore with three
  // escalator lanes in it, an upper landing that stays dark on purpose - a
  // lit exit at the top would say the way out is open, and it is not.
  var ESC_SLOPE = (ESC_HEAD_Y - PLAT_Y) / (ESC_INC_X1 - ESC_INC_X0);

  function buildEscalatorHall(L, B, rng, N) {
    var i, k, s;
    var floorFn = function (x, z) {
      return PLAT_Y - 0.03 - (N.fbm2(x * 0.11 + 9.4, z * 0.11 - 2.2, 3) * 0.5 + 0.5) * 0.055
        - M.smoothstep(3.4, 6.0, Math.abs(z)) * 0.02;
    };

    // ---- lower landing ------------------------------------------------------
    B.paint = 'floor';
    B.add('plat_floor', deck(HALL_X1, ESC_INC_X0 + 0.6, -ESC_HZ, ESC_HZ, 0.55, floorFn));
    B.paint = 'metal';
    L.addCollider((HALL_X1 + ESC_INC_X0) * 0.5, PLAT_Y - 0.3, 0,
      (ESC_INC_X0 - HALL_X1) * 0.5 + 0.4, 0.3, ESC_HZ, 'concrete', true);

    // side walls, tiled with the dado carried round from the platform
    for (s = -1; s <= 1; s += 2) {
      B.paint = 'seg';
      B.box('tunnel_seg', ESC_INC_X0 + 0.6 - HALL_X1, 6.0, 0.50,
        (HALL_X1 + ESC_INC_X0 + 0.6) * 0.5, PLAT_Y + 2.35, s * (ESC_HZ + 0.25));
      B.paint = 'clad';
      B.box('wall_tile', ESC_INC_X0 + 0.6 - HALL_X1, 2.55, 0.52,
        (HALL_X1 + ESC_INC_X0 + 0.6) * 0.5, PLAT_Y + 1.60, s * ESC_HZ);
      B.box('dado_paint', ESC_INC_X0 + 0.6 - HALL_X1, 1.05, 0.54,
        (HALL_X1 + ESC_INC_X0 + 0.6) * 0.5, PLAT_Y + 0.60, s * ESC_HZ);
      B.paint = 'metal';
      L.addCollider((HALL_X1 + ESC_INC_X0 + 0.6) * 0.5, PLAT_Y + 2.35, s * (ESC_HZ + 0.25),
        (ESC_INC_X0 + 0.6 - HALL_X1) * 0.5, 3.0, 0.25, 'tile');
      card(B, CELL.STRIP, 33.5, PLAT_Y + 1.85, s * (ESC_HZ - 0.03), 2.6, 2.6, 'z', -s,
        tint(0xe8ecd8, 0.3));
      card(B, CELL.POSTER, 36.6, PLAT_Y + 1.70, s * (ESC_HZ - 0.03), 1.8, 1.8, 'z', -s, null);
    }
    // vault over the lower landing
    var lp = vaultProfile(-ESC_HZ, ESC_HZ, PLAT_Y + 3.30, PLAT_Y + 3.30, 1.85, 16);
    B.paint = 'vault';
    B.add('vault_plaster', sweepX(lp, HALL_X1, ESC_INC_X0 + 0.6, 14, null, null));
    B.paint = 'metal';
    L.addCollider((HALL_X1 + ESC_INC_X0) * 0.5, PLAT_Y + 5.6, 0,
      (ESC_INC_X0 - HALL_X1) * 0.5 + 0.4, 0.4, ESC_HZ, 'concrete');

    // ---- the inclined bore --------------------------------------------------
    var incProf = boreProfile(0, ESC_AXIS_Y, ESC_BORE_R, 2.50, 22);
    var ramp = function (x) { return escTreadY(x); };
    var g = sweepX(incProf, ESC_INC_X0, ESC_INC_X1, 30, null,
      function (x) { return ramp(x); });
    B.paint = 'seg';
    B.add('tunnel_seg', shearNormals(g, ESC_SLOPE));
    B.paint = 'metal';
    // segment rings up the tube
    for (i = 0; i <= 16; i++) {
      var rx = ESC_INC_X0 + 0.4 + i * ((ESC_INC_X1 - ESC_INC_X0 - 0.8) / 16);
      var ry0 = ramp(rx);
      var rp = boreProfile(0, ESC_AXIS_Y, ESC_BORE_R - 0.06, 2.42, 12);
      for (k = 0; k + 1 < rp.length; k++) {
        B.strut('tunnel_seg', rx, ry0 + rp[k][1], rp[k][0],
          rx + 0.0, ry0 + rp[k + 1][1], rp[k + 1][0], 0.24, 0.13);
      }
    }
    // and the colliders that make it a solid tube
    for (i = 0; i < 13; i++) {
      var cx0 = ESC_INC_X0 + (i + 0.5) * ((ESC_INC_X1 - ESC_INC_X0) / 13);
      var cy0 = ramp(cx0);
      L.addCollider(cx0, cy0 - 0.45, 0, 0.6, 0.45, ESC_BORE_R * 0.62, 'concrete', true);
      for (s = -1; s <= 1; s += 2) {
        L.addCollider(cx0, cy0 + 1.6, s * (ESC_BORE_R * 0.72), 0.6, 1.8, 0.5, 'concrete');
      }
      L.addCollider(cx0, cy0 + ESC_AXIS_Y + ESC_BORE_R - 0.3, 0, 0.6, 0.4, ESC_BORE_R * 0.6, 'concrete');
    }

    // ---- three escalator lanes ---------------------------------------------
    var lx0 = ESC_INC_X0 - 1.6, lx1 = ESC_INC_X1 + 1.4;
    for (k = 0; k < ESC_LANES.length; k++) {
      var lz = ESC_LANES[k];
      var y0 = escTreadY(lx0) - 0.02, y1 = escTreadY(lx1) - 0.02;
      // truss and skirt
      B.paint = 'clad';
      B.strut('deck_steel', lx0, y0 - 0.55, lz, lx1, y1 - 0.55, lz, 1.06, 0.62);
      B.paint = 'metal';
      // treads
      var nT = Math.round((lx1 - lx0) / 0.40);
      for (i = 0; i < nT; i++) {
        var tx = lx0 + (i + 0.5) * ((lx1 - lx0) / nT);
        var ty = escTreadY(tx);
        B.box('deck_steel', 0.38, 0.05, 0.98, tx, ty - 0.02, lz);
        if (tx > ESC_INC_X0 && tx < ESC_INC_X1) {
          B.box('deck_steel', 0.05, 0.22, 0.98, tx + 0.19, ty - 0.13, lz);
        }
      }
      // balustrades and the rubber handrail, which is the strongest line in
      // the framing and the thing that makes the rise legible
      for (s = -1; s <= 1; s += 2) {
        var bz = lz + s * 0.56;
        B.paint = 'clad';
        B.strut('deck_steel', lx0, y0 + 0.46, bz, lx1, y1 + 0.46, bz, 0.075, 0.90);
        B.paint = 'metal';
        B.strut('cable_rubber', lx0 - 0.2, y0 + 0.96, bz, lx1 + 0.2, y1 + 0.96, bz, 0.10, 0.14);
        // balustrade lamps at the newel, every few metres
        for (i = 0; i < 5; i++) {
          var nx3 = lx0 + 1.5 + i * ((lx1 - lx0 - 3.0) / 4);
          B.box('rust_metal', 0.16, 0.13, 0.10, nx3, escTreadY(nx3) + 0.40, bz + s * 0.06);
        }
      }
      // comb plates top and bottom
      B.box('deck_steel', 0.80, 0.08, 1.10, lx0 + 0.3, escTreadY(lx0 + 0.3) + 0.02, lz);
      B.box('deck_steel', 0.80, 0.08, 1.10, lx1 - 0.3, escTreadY(lx1 - 0.3) + 0.02, lz);
      L.addCollider((lx0 + lx1) * 0.5, (y0 + y1) * 0.5 - 0.3, lz,
        (lx1 - lx0) * 0.5, 0.35, 0.55, 'metal', true);
    }
    // decking between the lanes
    for (k = 0; k + 1 < ESC_LANES.length; k++) {
      var mz = (ESC_LANES[k] + ESC_LANES[k + 1]) * 0.5;
      B.paint = 'clad';
      B.strut('deck_steel', lx0, escTreadY(lx0) - 0.20, mz, lx1, escTreadY(lx1) - 0.20, mz,
        ESC_LANES[k + 1] - ESC_LANES[k] - 1.12, 0.36);
      B.paint = 'metal';
    }

    // ---- upper landing ------------------------------------------------------
    B.paint = 'floor';
    B.add('plat_floor', deck(ESC_INC_X1 + 1.0, ESC_X1, -ESC_HZ, ESC_HZ, 0.7,
      function (x, z) { return ESC_HEAD_Y - 0.02; }));
    B.paint = 'metal';
    L.addCollider((ESC_INC_X1 + ESC_X1) * 0.5, ESC_HEAD_Y - 0.3, 0,
      (ESC_X1 - ESC_INC_X1) * 0.5, 0.3, ESC_HZ, 'concrete', true);
    for (s = -1; s <= 1; s += 2) {
      B.paint = 'seg';
      B.box('tunnel_seg', ESC_X1 - ESC_INC_X1 - 1.0, 5.0,
        0.50, (ESC_INC_X1 + 1.0 + ESC_X1) * 0.5, ESC_HEAD_Y + 2.3, s * (ESC_HZ + 0.25));
      B.paint = 'metal';
      L.addCollider((ESC_INC_X1 + 1.0 + ESC_X1) * 0.5, ESC_HEAD_Y + 2.3, s * (ESC_HZ + 0.25),
        (ESC_X1 - ESC_INC_X1 - 1.0) * 0.5, 2.5, 0.25, 'concrete');
    }
    B.paint = 'seg';
    B.box('tunnel_seg', 0.6, 5.6, ESC_HZ * 2 + 1.0, ESC_X1 + 0.3, ESC_HEAD_Y + 2.5, 0);
    B.box('tunnel_seg', ESC_X1 - ESC_INC_X1 - 1.0, 0.4, ESC_HZ * 2,
      (ESC_INC_X1 + 1.0 + ESC_X1) * 0.5, ESC_HEAD_Y + 4.9, 0);
    B.paint = 'metal';
    L.addCollider(ESC_X1 + 0.3, ESC_HEAD_Y + 2.5, 0, 0.3, 2.8, ESC_HZ + 0.5, 'concrete');
    L.addCollider((ESC_INC_X1 + ESC_X1) * 0.5, ESC_HEAD_Y + 4.9, 0,
      (ESC_X1 - ESC_INC_X1) * 0.5, 0.2, ESC_HZ, 'concrete');
    card(B, CELL.EXIT, ESC_X1 - 0.02, ESC_HEAD_Y + 2.6, 0, 3.0, 3.0, 'x', -1,
      tint(0xdfe8d8, 0.3));

    // ---- the overlook gallery and its stair --------------------------------
    // The `overview` stand. A camera 5.5 m up in a metro has to have got there
    // somehow, and this is how: a gallery across the head of the platform hall
    // inside the east arch, with a stair down to the landing behind it.
    B.paint = 'quay';
    B.box('raw_concrete', BAL_X1 + 1.6 - BAL_X0, 0.28, BAL_HZ * 2,
      (BAL_X0 + BAL_X1 + 1.6) * 0.5, BAL_Y - 0.14, 0);
    B.paint = 'metal';
    L.addCollider((BAL_X0 + BAL_X1 + 1.6) * 0.5, BAL_Y - 0.14, 0,
      (BAL_X1 + 1.6 - BAL_X0) * 0.5, 0.14, BAL_HZ, 'concrete', true);
    // railing: two rails and posts, on the west and both flank edges
    function rail(ax, az, bx, bz) {
      var n = Math.max(2, Math.round(Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) / 1.2));
      for (var q = 0; q <= n; q++) {
        var t = q / n;
        B.box('rust_metal', 0.06, 1.02, 0.06, ax + (bx - ax) * t, BAL_Y + 0.51, az + (bz - az) * t);
      }
      B.strut('rust_metal', ax, BAL_Y + 1.00, az, bx, BAL_Y + 1.00, bz, 0.055, 0.055);
      B.strut('rust_metal', ax, BAL_Y + 0.55, az, bx, BAL_Y + 0.55, bz, 0.040, 0.040);
    }
    rail(BAL_X0, -BAL_HZ + 0.1, BAL_X0, BAL_HZ - 0.1);
    rail(BAL_X0, -BAL_HZ + 0.1, BAL_X1 + 1.5, -BAL_HZ + 0.1);
    rail(BAL_X0, BAL_HZ - 0.1, BAL_X1 + 1.5, BAL_HZ - 0.1);
    // the stair, straight, down the +z side of the landing
    var sx0 = BAL_X1 + 1.4, sy0 = BAL_Y, sz0 = 2.40;
    for (i = 0; i < 16; i++) {
      var stx = sx0 + 0.15 + i * 0.2875;
      var sty = sy0 - (i + 1) * 0.175;
      B.box('deck_steel', 0.2875, 0.06, 1.60, stx, sty + 0.03, sz0);
      B.box('deck_steel', 0.05, 0.175, 1.60, stx - 0.13, sty + 0.09, sz0);
    }
    B.strut('deck_steel', sx0, sy0 - 0.30, sz0 - 0.82, sx0 + 4.6, PLAT_Y - 0.30, sz0 - 0.82, 0.30, 0.10);
    B.strut('deck_steel', sx0, sy0 - 0.30, sz0 + 0.82, sx0 + 4.6, PLAT_Y - 0.30, sz0 + 0.82, 0.30, 0.10);
    B.strut('rust_metal', sx0, sy0 + 1.00, sz0 + 0.86, sx0 + 4.6, PLAT_Y + 1.00, sz0 + 0.86, 0.05, 0.05);
    for (i = 0; i < 6; i++) {
      var pxs = sx0 + i * 0.92;
      B.box('rust_metal', 0.05, 1.05, 0.05, pxs,
        (sy0 - i * 0.92 * (2.80 / 4.6)) + 0.52, sz0 + 0.86);
    }
    L.addCollider(sx0 + 2.3, (sy0 + PLAT_Y) * 0.5 - 0.2, sz0, 2.3, 1.5, 0.85, 'metal', true);
  }

  // ================================================================ THE WATER ==
  // Four sheets: the two station trenches, the four tunnel runs, the escalator
  // landing and a handful of platform ponds placed at genuine minima of the
  // deck's own dip field. Nothing here is a decal on flat ground.
  function buildWater(L, B, rng, N) {
    var wf = function (x, z) {
      return WATER_Y + (N.fbm2(x * 0.5 + 2.2, z * 0.5 - 1.4, 2)) * 0.006;
    };
    var s, i;
    B.paint = 'water';
    for (s = -1; s <= 1; s += 2) {
      B.add('flood_water', deck(HALL_X0, HALL_X1,
        s < 0 ? -HALL_HZ + 0.35 : PLAT_EDGE + 0.02,
        s < 0 ? -PLAT_EDGE - 0.02 : HALL_HZ - 0.35, 1.6, wf));
      B.add('flood_water', deck(TUN_W_END + 1.0, HALL_X0,
        s * TRK_CZ - 2.15, s * TRK_CZ + 2.15, 1.6, wf));
      B.add('flood_water', deck(HALL_X1, TUN_E_END - 1.0,
        s * TRK_CZ - 2.15, s * TRK_CZ + 2.15, 1.6, wf));
    }
    // the escalator landing: a shallow sheet fed by whatever is running down
    // the incline, held 8 mm above the slab so it has an edge
    B.add('flood_water', deck(HALL_X1 + 0.6, ESC_INC_X0 - 0.4, -4.3, 4.3, 1.2,
      function (x, z) { return PLAT_Y - 0.052 + (N.fbm2(x * 0.6, z * 0.6, 2)) * 0.004; }));

    // ---- platform ponds ----------------------------------------------------
    // Searched, not placed: sample the deck, keep the local minima that are
    // deeper than the film thickness, and fill each to its own rim. A puddle
    // painted at a remembered coordinate stops being a puddle the moment the
    // slab settles differently.
    var ponds = [];
    for (i = 0; i < 900; i++) {
      var px = rng.range(HALL_X0 + 2, HALL_X1 - 2);
      var pz = rng.range(-PLAT_EDGE + 0.5, PLAT_EDGE - 0.5);
      var d0 = platDip(px, pz, N);
      if (d0 < 0.030) continue;
      var ok = true;
      for (var k = 0; k < 8; k++) {
        var a = k / 8 * 6.2832;
        if (platDip(px + Math.cos(a) * 0.7, pz + Math.sin(a) * 0.7, N) > d0) { ok = false; break; }
      }
      if (!ok) continue;
      var tooClose = false;
      for (k = 0; k < ponds.length; k++) {
        if (Math.abs(ponds[k][0] - px) < 2.4 && Math.abs(ponds[k][1] - pz) < 1.6) { tooClose = true; break; }
      }
      if (tooClose) continue;
      ponds.push([px, pz, d0]);
      if (ponds.length >= 16) break;
    }
    for (i = 0; i < ponds.length; i++) {
      var p = ponds[i];
      var rr = 0.9 + (p[2] - 0.030) * 22;
      var lvl = platY(p[0], p[1], N) + Math.min(0.024, p[2] * 0.45);
      B.add('flood_water', deck(p[0] - rr * 1.5, p[0] + rr * 1.5, p[1] - rr, p[1] + rr, 0.55,
        (function (cx, cz, r, y) {
          return function (x, z) {
            var dx = (x - cx) / (r * 1.5), dz = (z - cz) / r;
            var d = Math.sqrt(dx * dx + dz * dz);
            // ragged rim: the quad is dropped outside it (see deck())
            var wob = 0.80 + 0.30 * Math.sin(Math.atan2(dz, dx) * 3.1 + cx);
            return d > wob ? -999 : y;
          };
        })(p[0], p[1], rr, lvl)));
      L.wetPatches.push({ x: p[0], z: p[1], r: rr });
    }
    B.paint = 'metal';
    L.waterPlane = { y: WATER_Y, x0: TUN_W_END, x1: TUN_E_END, z0: -HALL_HZ, z1: HALL_HZ };
  }

  // ============================================================== THE LIGHTS ==
  // Every fitting in the station is built twice over: as HOUSING, which is
  // ordinary merged geometry and takes shadow like anything else, and as an
  // EMITTER, which is one instance in a single InstancedMesh carrying its own
  // per-instance colour. The split is what buys independent failure: forty
  // diffusers sharing one emissive material flicker in unison, and a whole
  // station guttering on the same beat reads as a screen effect rather than as
  // a dying fitting.
  function emitBox(L, x, y, z, sx, sy, sz, ry, colHex, gain, kind, rz) {
    var m = new THREE.Matrix4();
    _e1.set(0, ry || 0, rz || 0, 'YXZ');
    m.compose(new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(_e1),
      new THREE.Vector3(sx, sy, sz));
    L.emitters.push({
      m: m, col: new THREE.Color().setHex(colHex, THREE.SRGBColorSpace),
      gain: gain, kind: kind || 'steady', phase: L.rng.range(0, 100)
    });
    return L.emitters.length - 1;
  }

  // A twin-tube fluorescent batten. `state` is 'lit' | 'dying' | 'dead'.
  function batten(L, B, x, y, z, len, ry, state, hang) {
    B.paint = 'clad';
    B.boxR('car_paint', len, 0.13, 0.21, x, y, z, 0, ry, 0);
    B.boxR('car_paint', 0.07, 0.16, 0.24, x - Math.cos(ry) * len * 0.5, y, z + Math.sin(ry) * len * 0.5, 0, ry, 0);
    B.boxR('car_paint', 0.07, 0.16, 0.24, x + Math.cos(ry) * len * 0.5, y, z - Math.sin(ry) * len * 0.5, 0, ry, 0);
    B.paint = 'metal';
    if (hang) {
      B.strut('rust_metal', x - len * 0.3, y + 0.06, z, x - len * 0.3, y + hang, z, 0.03, 0.03);
      B.strut('rust_metal', x + len * 0.3, y + 0.06, z, x + len * 0.3, y + hang, z, 0.03, 0.03);
    }
    if (state === 'dead') {
      // a dead tube still has to be a tube: a dark diffuser, not a hole
      B.paint = 'clad';
      B.dark = 0.45;
      B.boxR('panel_plastic', len - 0.14, 0.06, 0.15, x, y - 0.075, z, 0, ry, 0);
      B.dark = 0;
      B.paint = 'metal';
      return -1;
    }
    return emitBox(L, x, y - 0.075, z, len - 0.14, 0.062, 0.155, ry,
      state === 'dying' ? 0xb6e0a6 : 0xc4ecb4,
      state === 'dying' ? 1.7 : 2.4, state === 'dying' ? 'dying' : 'fluoro');
  }

  // A red emergency strip in an aluminium channel. These run continuously along
  // both arcades and both tunnels: they are the only light source in the level
  // that is EVERYWHERE, which is what keeps a 70 m hall lit by five fittings
  // from having dead thirds in it.
  function redStrip(L, B, x, y, z, len, ry) {
    B.paint = 'metal';
    B.boxR('rust_metal', len, 0.075, 0.062, x, y, z, 0, ry, 0);
    return emitBox(L, x, y - 0.030, z, len - 0.06, 0.030, 0.034, ry, 0xff2416, 1.25, 'emerg');
  }

  // A rigged worklight on a tripod - somebody was down here working, recently.
  // It takes a LOOK-AT rather than a yaw: the first version took a hand-tuned
  // angle and the lens ended up pointing away from the wreck, so the frame's
  // subject was lit from behind by its own key while the fitting showed the
  // camera its bright side. Solving the head from the target cannot do that.
  function workLight(L, B, x, y, z, tx, ty, tz, col, gain, drop) {
    var dx = tx - x, dz = tz - z;
    var yaw = Math.atan2(dx, dz);
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    B.paint = 'metal';
    for (var k = 0; k < 3; k++) {
      var a = k / 3 * 6.2832 + 0.4;
      B.strut('rust_metal', x, y - 0.24, z, x + Math.cos(a) * 0.46,
        y - (drop === undefined ? 1.35 : drop), z + Math.sin(a) * 0.46, 0.035, 0.035);
    }
    B.box('rust_metal', 0.10, 0.34, 0.10, x, y - 0.20, z);
    B.paint = 'clad';
    B.boxR('car_paint', 0.34, 0.32, 0.40, x, y, z, 0, yaw, 0);
    // the back plate and the hood, so the fitting has a dark side. Painted,
    // and dark: on the 'metal' paint mode this came back as an orange rusted
    // slab that read as a brick standing on a tripod in front of the wreck.
    B.dark = 0.55;
    B.boxR('car_paint', 0.36, 0.34, 0.05, x - fx * 0.19, y, z - fz * 0.19, 0, yaw, 0);
    B.boxR('car_paint', 0.38, 0.05, 0.18, x + fx * 0.09, y + 0.19, z + fz * 0.09, 0, yaw, 0);
    B.dark = 0;
    B.paint = 'metal';
    return emitBox(L, x + fx * 0.17, y, z + fz * 0.17,
      0.26, 0.22, 0.05, yaw, col || 0xffd9a0, gain || 3.2, 'work');
  }

  // ---------------------------------------------------------------------------
  // THE RIG.
  //
  // Ordered by importance, and that ordering is load bearing: lighting.js caps a
  // declarative level at 24 practicals and truncates the TAIL, so anything that
  // has to be in the hero framings goes first. Twenty-four entries exactly.
  // ---------------------------------------------------------------------------
  function buildLighting(L, B, rng, N) {
    var i, s, k;
    var P = L.practicalLights;
    var W = L.litWindows;

    function lamp(d) { P.push(d); return d; }
    function glowCard(x, y, z, w, h, kelvin, gain, yaw, tintC) {
      if (W.length >= 20) return;
      W.push({ x: x, y: y, z: z, w: w, h: h, kelvin: kelvin, gain: gain,
        yaw: yaw || 0, scale: 1.6, tint: tintC || null, tintAmt: 0.55,
        haloSize: w * 1.7 });
    }

    // ---- platform battens ---------------------------------------------------
    // Eleven fittings at 6 m centres over the crown; five still strike. The dead
    // ones matter as much as the lit ones - the darkness between sources is the
    // level, and a fitting you can see is not working is what makes it read as
    // failure rather than as art direction.
    var LIT = { '-33': 'lit', '-27': 'dying', '-21': 'lit', '-15': 'lit',
      '-9': 'dying', '3': 'lit', '9': 'dying', '15': 'lit', '21': 'lit' };
    var battenY = CROWN - 0.42;
    for (i = 0; i < 12; i++) {
      var bx = -35 + i * 6;
      if (bx > HALL_X1 - 3) break;
      // the fitting under the collapse came down with it
      if (bx > COL_X0 - 1 && bx < COL_X1 + 1) continue;
      var st = LIT[String(bx)] || 'dead';
      var e = batten(L, B, bx, battenY, 0, 2.40, 0, st, 0.30);
      if (st !== 'dead') {
        glowCard(bx, battenY - 0.10, 0, 2.3, 0.20, 4300, st === 'dying' ? 0.7 : 1.0,
          0, new THREE.Color(0.80, 1.0, 0.86));
      }
    }

    // ---- the cove ----------------------------------------------------------
    // A continuous strip along both cornices, throwing UP into the vault. Two
    // things earned this after the first capture round, and both are worth
    // recording:
    //
    //  1. COVERAGE. With only down-lights the frame measured 56% dead cells -
    //     the entire vault, which is the top half of every framing in a level
    //     whose ceiling is 5.5 m above the floor, returned nothing at all. A
    //     station hall is not lit like a street; the whole point of a vaulted
    //     one is that the vault is the reflector.
    //  2. PALETTE. The level's own light has to be the sickly green, and the
    //     largest lit surface decides that. With the vault dark, the only thing
    //     in frame with any value was the floor under the red emergency gear,
    //     and a level briefed as green photographed orange.
    //
    // Emissive geometry rather than more lamps: it costs no light slot, it is
    // visible from any angle, and it is the source the vault uplights below are
    // pretending to be.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 13; i++) {
        var cx0 = HALL_X0 + 2.6 + i * 5.6;
        if (cx0 > HALL_X1 - 2) break;
        if (s < 0 && cx0 > COL_X0 - 1.5 && cx0 < COL_X1 + 1.5) continue;
        B.paint = 'metal';
        B.box('rust_metal', 5.0, 0.09, 0.13, cx0, ARC_TOP + 0.30, s * (ARC_BACK + 0.16));
        emitBox(L, cx0, ARC_TOP + 0.355, s * (ARC_BACK + 0.14), 3.9, 0.035, 0.095, 0,
          0xb4e8a4, 1.02, (i % 4 === 2) ? 'dying' : 'fluoro');
      }
    }
    // and along the outer wall of each track hall, so the openings are not
    // black rectangles from the platform
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 9; i++) {
        var cx1 = HALL_X0 + 4.0 + i * 8.0;
        if (cx1 > HALL_X1 - 3) break;
        B.paint = 'metal';
        B.box('rust_metal', 3.4, 0.08, 0.12, cx1, 2.98, s * (HALL_HZ - 0.16));
        emitBox(L, cx1, 2.94, s * (HALL_HZ - 0.20), 2.8, 0.032, 0.085, 0,
          0xb0e49c, 0.95, (i % 3 === 1) ? 'dying' : 'fluoro');
      }
    }
    // The one that came down: hanging off its conduit over the wreck, still
    // alight, swinging. It is the key light on the hero framing's subject.
    B.paint = 'metal';
    B.strut('rust_metal', -4.2, CROWN - 0.2, -3.0, -3.6, 4.30, -3.4, 0.035, 0.035);
    batten(L, B, -3.55, 4.18, -3.42, 1.85, 0.42, 'dying', 0);
    glowCard(-3.55, 4.08, -3.42, 1.8, 0.20, 4200, 0.9, 0.42,
      new THREE.Color(0.82, 1.0, 0.88));

    // ---- the emergency strips ----------------------------------------------
    // Continuous, both arcades, at cornice height, in 6 m lengths so they can
    // break at the demolished bay.
    // They sit LOW - 1.75 m, on the pier faces - for three reasons: that is
    // where emergency gear really is, it is what puts red on the floor and
    // therefore in the standing water, and up at cornice height they competed
    // with the cove and turned the whole hall orange.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 8; i++) {
        var sx = HALL_X0 + 5.0 + i * 8.4;
        if (sx > HALL_X1 - 2) break;
        if (s < 0 && sx > -6 && sx < 6) continue;
        redStrip(L, B, sx, 1.76, s * (ARC_BACK + 0.10), 2.6, 0);
      }
    }
    // and along both tunnels, at the cable-run line
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 8; i++) {
        var tx = TUN_W_END + 4 + i * 4.2;
        if (tx > HALL_X0 - 2) break;
        redStrip(L, B, tx, 2.62, s * TRK_CZ + (s < 0 ? -1 : 1) * 2.30, 3.5, 0);
      }
      for (i = 0; i < 5; i++) {
        var tx2 = HALL_X1 + 3 + i * 4.4;
        if (tx2 > TUN_E_END - 2) break;
        redStrip(L, B, tx2, 2.62, s * TRK_CZ + (s < 0 ? -1 : 1) * 2.30, 2.4, 0);
      }
      // a cool strip opposite them, so a running tunnel is not monochrome red
      for (i = 0; i < 6; i++) {
        var tx3 = TUN_W_END + 6.4 + i * 5.4;
        if (tx3 > HALL_X0 - 2) break;
        B.paint = 'metal';
        B.box('rust_metal', 3.2, 0.08, 0.11, tx3, 2.34,
          s * TRK_CZ - (s < 0 ? -1 : 1) * 2.36);
        emitBox(L, tx3, 2.29, s * TRK_CZ - (s < 0 ? -1 : 1) * 2.36, 3.0, 0.030, 0.085, 0,
          0xb0e49c, (i % 3 === 1) ? 0.0 : 1.05, (i % 3 === 1) ? 'dying' : 'fluoro');
      }
    }

    // ---- the platform edge line --------------------------------------------
    // A continuous lit strip recessed into the coping nosing, both sides, the
    // whole 70 m. It is the single most valuable emitter in the level and it
    // was added for a measured reason: from the gallery the hall came back with
    // half its 8x8 coverage grid below the visibility floor, because five
    // pools of ceiling light 6 m apart leave four fifths of a 70 m floor dark.
    // A line does what a row of points cannot - it is continuous, it is the
    // leading line every framing already wants, and it is a real fitting: every
    // metro on earth has one.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 25; i++) {
        var px3 = HALL_X0 + 1.6 + i * 2.85;
        if (px3 > HALL_X1 - 1.4) break;
        var dead = (i % 7 === 3);
        B.paint = 'metal';
        B.box('rust_metal', 2.70, 0.05, 0.10, px3, PLAT_Y - 0.045, s * (PLAT_EDGE - 0.26));
        emitBox(L, px3, PLAT_Y - 0.020, s * (PLAT_EDGE - 0.26), 2.55, 0.020, 0.055, 0,
          0xc8ecb8, dead ? 0.0 : 0.80, dead ? 'dying' : 'fluoro');
      }
    }

    // ---- worklights ---------------------------------------------------------
    workLight(L, B, -8.20, 2.46, -2.40, -4.6, 1.9, -4.6, 0xffd2a0, 3.0, 1.36);
    workLight(L, B, -47.0, 1.95, -TRK_CZ + 1.9, -41.5, 0.3, -TRK_CZ, 0xffe0b0, 2.6, 2.05);
    workLight(L, B, -63.5, 2.10, -TRK_CZ - 1.95, -57.0, 0.4, -TRK_CZ + 0.4, 0xe8ffe0, 2.4, 2.20);
    workLight(L, B, 34.5, 2.55, -3.2, 40.5, PLAT_Y, 0.5, 0xffd8aa, 2.4, 1.42);

    // ---- escalator tube tubes ----------------------------------------------
    for (i = 0; i < 7; i++) {
      var ex2 = ESC_INC_X0 + 0.9 + i * 1.75;
      var ey = escTreadY(ex2) + ESC_AXIS_Y + ESC_BORE_R - 0.55;
      var st2 = (i === 1 || i === 3 || i === 6) ? 'lit' : (i === 4 ? 'dying' : 'dead');
      batten(L, B, ex2, ey, 0, 1.50, 0, st2, 0);
      if (st2 !== 'dead') {
        glowCard(ex2, ey - 0.10, 0, 1.4, 0.18, 4400, 0.9, 0,
          new THREE.Color(0.82, 1.0, 0.88));
      }
    }
    // A ring of lamps around the mouth of the inclined tube: the corners above
    // it were the last dead cells in this framing, and an illuminated arch is
    // what an escalator hall actually has over its entrance.
    for (i = 0; i < 9; i++) {
      var ma = -1.15 + i * (2.30 / 8);
      var mz = Math.sin(ma) * (ESC_BORE_R + 0.30);
      var my = PLAT_Y + ESC_AXIS_Y + Math.cos(ma) * (ESC_BORE_R + 0.30);
      B.paint = 'metal';
      B.boxR('rust_metal', 0.20, 0.16, 0.52, ESC_INC_X0 - 0.34, my, mz, ma, 0, 0);
      emitBox(L, ESC_INC_X0 - 0.46, my, mz, 0.06, 0.11, 0.42, 0,
        0xbde8ae, (i === 4 || i === 7) ? 0.0 : 1.15,
        (i === 4 || i === 7) ? 'dying' : 'fluoro', ma);
    }

    // Illuminated balustrade skirting up every lane - the standard fitting, and
    // what turns an inclined tube into a legible 7.5 m climb.
    var incAng = Math.atan(ESC_SLOPE);
    for (k = 0; k < ESC_LANES.length; k++) {
      for (i = 0; i < 7; i++) {
        var bxs = ESC_INC_X0 - 1.2 + i * 2.25;
        if (bxs > ESC_INC_X1 + 1.0) break;
        var bys = escTreadY(bxs) + 0.62;
        for (s = -1; s <= 1; s += 2) {
          emitBox(L, bxs, bys, ESC_LANES[k] + s * 0.575, 2.05, 0.032, 0.05, 0,
            0xc0e8b0, (i === 3 && k === 1) ? 0.0 : 0.72,
            (i === 3 && k === 1) ? 'dying' : 'fluoro', incAng);
        }
      }
    }
    batten(L, B, 55.0, ESC_HEAD_Y + 4.3, 0, 2.0, 0, 'dying', 0.35);
    batten(L, B, 36.2, PLAT_Y + 4.55, 0, 2.4, 0, 'dying', 0.30);
    glowCard(36.2, PLAT_Y + 4.45, 0, 2.3, 0.20, 4300, 0.8, 0,
      new THREE.Color(0.80, 1.0, 0.86));
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 4; i++) {
        var ecx = HALL_X1 + 2.2 + i * 2.7;
        B.paint = 'metal';
        B.box('rust_metal', 2.4, 0.08, 0.12, ecx, PLAT_Y + 2.72, s * (ESC_HZ - 0.14));
        emitBox(L, ecx, PLAT_Y + 2.775, s * (ESC_HZ - 0.18), 2.25, 0.032, 0.09, 0,
          0xb4e8a4, (i === 2) ? 0.0 : 1.05, (i === 2) ? 'dying' : 'fluoro');
      }
      redStrip(L, B, HALL_X1 + 5.5, PLAT_Y + 0.66, s * (ESC_HZ - 0.10), 3.0, 0);
    }

    // ---- track hall and car interiors --------------------------------------
    batten(L, B, -24.0, TRK_CROWN_R + TRK_SPRING + 0.55, -TRK_CZ, 1.6, 0, 'lit', 0.25);
    batten(L, B, 8.0, TRK_CROWN_R + TRK_SPRING + 0.55, TRK_CZ, 1.6, 0, 'dying', 0.25);
    // ---- the saloon ceiling lines ------------------------------------------
    // Short battens were the wrong fitting and the `interior` capture proved
    // it: a metro car's ceiling IS the luminaire, and with every lamp in the
    // car pointing DOWN from below it, the panel between them has N.L < 0 and
    // returns nothing at all - the frame came back with its top 45% pure black
    // and 59% of its coverage grid dead. Two continuous runs converging down
    // the car fix the coverage and are the strongest line in the composition.
    // Only the level cars get them: car A is rotated in three axes and these
    // are authored in world space, so a run built here would float beside it.
    function saloonLines(car, states) {
      for (var q = 0; q < states.length; q++) {
        var lx = car.x - 6.9 + q * 4.6;
        for (var sg = -1; sg <= 1; sg += 2) {
          B.paint = 'clad';
          B.dark = 0.15;
          B.box('panel_plastic', 4.35, 0.10, 0.21, lx, car.y + 3.10, car.z + sg * 0.62);
          B.dark = 0;
          B.paint = 'metal';
          if (states[q] === 'dead') continue;
          emitBox(L, lx, car.y + 3.020, car.z + sg * 0.62, 4.25, 0.046, 0.155, 0,
            0xcdeec0, states[q] === 'dying' ? 0.26 : 0.40,
            states[q] === 'dying' ? 'dying' : 'fluoro');
          // A cove at the wall/ceiling junction as well. The two centre runs
          // leave the top CORNERS of the frame black - a 78 degree lens inside
          // a 2.5 m saloon sees more of the car than the runs cross - and those
          // corners were the last dead cells in the framing.
          emitBox(L, lx, car.y + 2.86, car.z + sg * (CAR_HW - 0.16), 4.25, 0.030, 0.075, 0,
            0xbfe4b2, states[q] === 'dead' ? 0.0 : 0.24,
            states[q] === 'dead' ? 'dying' : 'fluoro');
        }
      }
    }
    // Kick-plate strips under the bench line. Emissive geometry, so they cost
    // no light slot, and they are what breaks the dead cells along the bottom
    // of the saloon without adding to the two ceiling runs that were already
    // the only thing clipping in the frame.
    function saloonKick(car) {
      for (var q = 0; q < 6; q++) {
        var kx = car.x - 7.5 + q * 3.0;
        for (var sg = -1; sg <= 1; sg += 2) {
          B.paint = 'metal';
          B.box('rust_metal', 2.80, 0.06, 0.07, kx, car.y + 1.08, car.z + sg * (CAR_HW - 0.44));
          emitBox(L, kx, car.y + 1.045, car.z + sg * (CAR_HW - 0.46), 2.70, 0.022, 0.045, 0,
            0xbfe4b2, (q === 2) ? 0.0 : 0.36, (q === 2) ? 'dying' : 'fluoro');
        }
      }
    }
    saloonKick(CARS[1]);
    saloonLines(CARS[1], ['dying', 'lit', 'lit', 'dying']);
    saloonLines(CARS[2], ['dead', 'dying', 'dead', 'dead']);

    // =========================== the SpotLights ==============================
    // The level's own colour. lighting.js's 'fluoro' kind lerps an unresolved
    // lamp toward its art-directed MERCURY blue-white, which is right for a
    // harbour flood and wrong here - the brief's word is SICKLY, and a cold
    // blue tube against a red strip is a police light, not a dying station.
    // Resolving the colour in the level skips that lerp entirely.
    var FL = new THREE.Color(0.80, 1.00, 0.83);
    var RD = new THREE.Color(1.0, 0.19, 0.11);
    var WK = new THREE.Color(1.0, 0.86, 0.66);

    // 1-6: the platform. These carry the hall.
    lamp({ name: 'metro_plat_c', kind: 'fluoro', pos: [-9, battenY - 0.12, 0],
      color: FL.clone(), kelvin: 4300, intensity: 175, distance: 21, cone: 1.02, penumbra: 0.42,
      dayBase: 1, aimPos: [-9, PLAT_Y, 0], fixed: true, halo: 1.5, haloGain: 0.24,
      bulbR: 0.09, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });
    // The key on the level's subject, and the one lamp whose intensity had to
    // be MEASURED rather than chosen: at 240 it put 12 lux on a flank 4.5 m
    // away, which is three times the market's noon sun, and the lead car
    // photographed as a featureless white slab with none of its flutes, window
    // band or door recesses in it. 62 lands it just under the platform's own
    // value, so the wreck reads as the brightest thing in frame without
    // clipping - which is what makes a subject, rather than a hole.
    lamp({ name: 'metro_wreck_work', kind: 'led', pos: [-8.20, 2.46, -2.40],
      color: WK, kelvin: 3200, intensity: 105, distance: 20, cone: 0.62, penumbra: 0.44,
      dayBase: 1, aimPos: [-4.6, 1.9, -4.6], fixed: true, halo: 0.75, haloGain: 0.24,
      bulbR: 0.08, bulbFlat: 0.3, bulbGain: 0.14, beam: 0.45 });
    lamp({ name: 'metro_plat_b', kind: 'fluoro', pos: [-21, battenY - 0.12, 0],
      color: FL.clone(), kelvin: 4300, intensity: 175, distance: 21, cone: 1.02, penumbra: 0.42,
      dayBase: 1, aimPos: [-21, PLAT_Y, 0], fixed: true, halo: 1.5, haloGain: 0.24,
      bulbR: 0.09, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });
    lamp({ name: 'metro_plat_d', kind: 'fluoro', pos: [3, battenY - 0.12, 0],
      color: FL.clone(), kelvin: 4300, intensity: 175, distance: 21, cone: 1.02, penumbra: 0.42,
      dayBase: 1, aimPos: [3, PLAT_Y, 0], fixed: true, halo: 1.5, haloGain: 0.24,
      bulbR: 0.09, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });
    lamp({ name: 'metro_hang', kind: 'fluoro', pos: [-3.55, 4.10, -3.42],
      color: FL.clone(), kelvin: 4200, intensity: 96, distance: 14, cone: 1.10, penumbra: 0.45,
      dayBase: 1, aimPos: [2.5, 1.70, -6.10], fixed: true, halo: 1.1, haloGain: 0.24,
      bulbR: 0.08, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.50 });
    lamp({ name: 'metro_plat_a', kind: 'fluoro', pos: [-33, battenY - 0.12, 0],
      color: FL.clone(), kelvin: 4300, intensity: 165, distance: 20, cone: 1.02, penumbra: 0.42,
      dayBase: 1, aimPos: [-33, PLAT_Y, 0], fixed: true, halo: 1.4, haloGain: 0.24,
      bulbR: 0.09, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });
    lamp({ name: 'metro_plat_e', kind: 'fluoro', pos: [17, battenY - 0.12, 0],
      color: FL.clone(), kelvin: 4300, intensity: 165, distance: 20, cone: 1.02, penumbra: 0.42,
      dayBase: 1, aimPos: [17, PLAT_Y, 0], fixed: true, halo: 1.4, haloGain: 0.24,
      bulbR: 0.09, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });

    // 8-11: THE VAULT UPLIGHTS. The cove above is emissive geometry and emits
    // no actual light, so these are what put value on the ceiling - and the
    // ceiling is the top half of every framing in the level. Aimed at the vault
    // surface itself rather than straight up, so the ribs get a raking key and
    // read as ribs instead of as a smooth tube.
    var UPL = [[-30, -1], [-15, 1], [8, -1], [21, 1]];
    for (i = 0; i < UPL.length; i++) {
      lamp({ name: 'metro_vault_' + i, kind: 'fluoro',
        pos: [UPL[i][0], ARC_TOP + 0.38, UPL[i][1] * (ARC_BACK + 0.16)],
        color: FL.clone(), kelvin: 4600, intensity: 66, distance: 13, cone: 0.95, penumbra: 0.50,
        dayBase: 1, aimPos: [UPL[i][0] + 1.0, CROWN - 0.15, UPL[i][1] * -1.4],
        fixed: true, halo: 0.9, haloGain: 0.20, bulbR: 0.06, bulbFlat: 0.4,
        bulbGain: 0.10, beam: 0.35 });
    }

    // 12-14: the emergency wash. Weak, red, and aimed at the FLOOR, which is
    // where it matters: the standing water is the only thing in the level that
    // can return a strip as a highlight, and it can only do that if a source is
    // actually pointed at it.
    var EM = [['metro_emg_n1', -15, -1]];
    for (i = 0; i < EM.length; i++) {
      lamp({ name: EM[i][0], kind: 'led', pos: [EM[i][1], 1.74, EM[i][2] * (ARC_BACK + 0.06)],
        color: RD.clone(), kelvin: 1900, intensity: 22, distance: 10, cone: 1.25,
        penumbra: 0.58, dayBase: 1, aimPos: [EM[i][1] + 1.2, PLAT_Y, EM[i][2] * 1.4],
        fixed: true, halo: 0.42, haloGain: 0.26, bulbR: 0.045, bulbFlat: 0.5,
        bulbGain: 0.18, beam: 0.22 });
    }

    // 14-16: the escalator hall.
    lamp({ name: 'metro_esc_foot', kind: 'led', pos: [34.5, 2.55, -3.2],
      color: WK.clone(), kelvin: 3300, intensity: 150, distance: 20, cone: 0.80,
      penumbra: 0.44, dayBase: 1, aimPos: [39.5, PLAT_Y, 0.5], fixed: true,
      halo: 1.0, haloGain: 0.28, bulbR: 0.10, bulbFlat: 0.35, bulbGain: 0.18, beam: 0.50 });
    lamp({ name: 'metro_esc_mid', kind: 'fluoro', pos: [44.3, escTreadY(44.3) + ESC_AXIS_Y + ESC_BORE_R - 0.68, 0],
      color: FL.clone(), kelvin: 4400, intensity: 150, distance: 17, cone: 0.95, penumbra: 0.42,
      dayBase: 1, aimPos: [40.6, escTreadY(40.6), 0], fixed: true, halo: 1.2,
      haloGain: 0.24, bulbR: 0.08, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.60 });
    lamp({ name: 'metro_tun_w0', kind: 'led', pos: [-63.5, 2.10, -TRK_CZ - 1.95],
      color: FL.clone(), kelvin: 4200, intensity: 235, distance: 26, cone: 0.98,
      penumbra: 0.48, dayBase: 1, aimPos: [-57.0, 0.4, -TRK_CZ + 0.4], fixed: true,
      halo: 0.85, haloGain: 0.24, bulbR: 0.08, bulbFlat: 0.3, bulbGain: 0.16, beam: 0.38 });

    // 17-20: the west tunnel - the whole of the `hero2` framing.
    lamp({ name: 'metro_tun_w1', kind: 'led', pos: [-47.0, 1.95, -TRK_CZ + 1.9],
      color: WK.clone(), kelvin: 3600, intensity: 300, distance: 28, cone: 0.88,
      penumbra: 0.46, dayBase: 1, aimPos: [-41.5, 0.3, -TRK_CZ], fixed: true,
      halo: 0.9, haloGain: 0.26, bulbR: 0.09, bulbFlat: 0.3, bulbGain: 0.16, beam: 0.40 });
    // Both red tunnel lamps stand WELL clear of the `hero2` eye. The first
    // version put one 2 m in front of it, and a lamp inside its own halo fills
    // a quarter of the frame with a white ball - the same defect the harbour
    // paid for with its quay masts, in a 5.5 m bore instead of a 90 m yard.
    lamp({ name: 'metro_tun_w2', kind: 'led', pos: [-45.5, 2.58, -TRK_CZ - 2.20],
      color: RD.clone(), kelvin: 1900, intensity: 62, distance: 16, cone: 1.18,
      penumbra: 0.54, dayBase: 1, aimPos: [-43.5, WATER_Y, -TRK_CZ + 0.3], fixed: true,
      halo: 0.45, haloGain: 0.26, bulbR: 0.05, bulbFlat: 0.5, bulbGain: 0.18, beam: 0.24 });

    // 21-24: the track halls, the second car's interior and the east portal.
    lamp({ name: 'metro_trk_n', kind: 'fluoro', pos: [-24.0, 4.05, -TRK_CZ],
      color: FL.clone(), kelvin: 4200, intensity: 105, distance: 15, cone: 1.05, penumbra: 0.46,
      dayBase: 1, aimPos: [-24.0, WATER_Y, -TRK_CZ], fixed: true, halo: 1.0,
      haloGain: 0.24, bulbR: 0.07, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.45 });
    lamp({ name: 'metro_car_int', kind: 'fluoro', pos: [CARS[1].x - 3.4, CARS[1].y + 2.95, CARS[1].z],
      color: FL.clone(), kelvin: 4300, intensity: 58, distance: 16, cone: 1.36, penumbra: 0.66,
      dayBase: 1, aimPos: [CARS[1].x - 0.6, CARS[1].y + 1.15, CARS[1].z], fixed: true, halo: 0.55,
      haloGain: 0.20, bulbR: 0.05, bulbFlat: 0.4, bulbGain: 0.12, beam: 0.30 });
    lamp({ name: 'metro_esc_head', kind: 'fluoro', pos: [51.0, escTreadY(51.0) + ESC_AXIS_Y + ESC_BORE_R - 0.75, 0],
      color: FL.clone(), kelvin: 4400, intensity: 165, distance: 19, cone: 1.05, penumbra: 0.46,
      dayBase: 1, aimPos: [49.0, escTreadY(49.0), 0], fixed: true, halo: 1.2,
      haloGain: 0.24, bulbR: 0.08, bulbFlat: 0.4, bulbGain: 0.16, beam: 0.55 });
    lamp({ name: 'metro_car_int2', kind: 'fluoro', pos: [CARS[1].x + 3.2, CARS[1].y + 2.95, CARS[1].z],
      color: FL.clone(), kelvin: 4300, intensity: 54, distance: 15, cone: 1.35, penumbra: 0.64,
      dayBase: 1, aimPos: [CARS[1].x + 7.0, CARS[1].y + 1.15, CARS[1].z], fixed: true, halo: 0.55,
      haloGain: 0.20, bulbR: 0.05, bulbFlat: 0.4, bulbGain: 0.12, beam: 0.30 });

    // ---- the glint cards ----------------------------------------------------
    // Additive smears on the water under every strip, running along the tunnel
    // axis - the axis every framing in this level looks down. See the header.
    // Deliberately faint. The first pass ran them at full chroma and they
    // printed as solid glowing bars laid on the floor - a reflection that is
    // brighter than its own source is not a reflection, it is a light strip
    // painted on the water. A specular smear on rippled water is a low-contrast
    // wash that the eye reads as depth, so these sit at roughly a quarter of the
    // strip's own value and do nothing but break the black.
    var RC = new THREE.Color(0.46, 0.085, 0.050);
    var GC = new THREE.Color(0.20, 0.34, 0.24);
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 5; i++) {
        var gx2 = TUN_W_END + 7 + i * 6.6;
        if (gx2 > HALL_X0 - 4) break;
        glint(B, gx2, s * TRK_CZ + s * 0.9, 7.5, 0.80, RC, WATER_Y + 0.008);
      }
      for (i = 0; i < 4; i++) {
        var gx3 = HALL_X1 + 5 + i * 4.4;
        if (gx3 > TUN_E_END - 4) break;
        glint(B, gx3, s * TRK_CZ + s * 0.9, 7.5, 0.80, RC, WATER_Y + 0.008);
      }
      // in the station trenches, under the arcade strips
      for (i = 0; i < 5; i++) {
        var gx4 = HALL_X0 + 8 + i * 13.0;
        if (gx4 > HALL_X1 - 4) break;
        glint(B, gx4, s * (PLAT_EDGE + 1.35), 9.0, 0.95, GC, WATER_Y + 0.008);
      }
    }
    glint(B, -21, -TRK_CZ + 1.2, 11.0, 1.10, GC, WATER_Y + 0.010);
    glint(B, 6, TRK_CZ - 1.2, 11.0, 1.10, GC, WATER_Y + 0.010);
    glint(B, -45, -TRK_CZ + 0.35, 10.0, 1.30, new THREE.Color(0.52, 0.40, 0.26), WATER_Y + 0.012);
    glint(B, -60, -TRK_CZ + 0.35, 10.0, 1.30, new THREE.Color(0.30, 0.42, 0.30), WATER_Y + 0.012);

    // ---- the shafts ---------------------------------------------------------
    // Four real apertures. lighting.js builds a spot plus an additive haze cone
    // for each; `lux` marks them as FIXTURES so they stop tracking a sun this
    // level does not have. The first is the one the hero framing is composed
    // around: a worklight rigged at the head of the vent shaft, dropping a
    // column of dusty light onto the platform six metres in front of the eye.
    L.lightShafts.push({
      origin: new THREE.Vector3(VENT_X, CROWN + 0.30, VENT_Z),
      dir: new THREE.Vector3(0, -1, 0), width: 1.75, length: 6.0,
      strength: 0.80, lux: 9, kelvin: 3500, always: true, kind: 'vent'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(44.0, escTreadY(44.0) + 4.30, 0),
      dir: new THREE.Vector3(0.28, -1, 0), width: 2.60, length: 4.4,
      strength: 0.9, lux: 8, kelvin: 4400, always: true, kind: 'escalator'
    });
    L.lightShafts.push({
      origin: new THREE.Vector3(-47.0, 3.55, -TRK_CZ + 0.6),
      dir: new THREE.Vector3(0.30, -1, -0.10), width: 2.10, length: 3.4,
      strength: 0.9, lux: 9, kelvin: 3800, always: true, kind: 'tunnel'
    });

    // ---- publish the rig as anchors ----------------------------------------
    for (i = 0; i < P.length; i++) {
      var d = P[i];
      L.anchors.lamps.push({
        name: d.name, kind: d.kind, cone: d.cone || 0,
        pos: new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]),
        aim: d.aimPos ? new THREE.Vector3(d.aimPos[0], d.aimPos[1], d.aimPos[2]) : null
      });
    }
  }

  // ============================================================= LevelMetro ==
  function LevelMetro(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_metro';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.emitters = [];
    this.lightShafts = [];
    this.practicalLights = [];
    this.litWindows = [];
    this.wetPatches = [];
    this.waterPlane = null;
    this.dripEdges = [];
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(4.0);
    this._stamp = 0;
    this._atlasOk = false;
    this._emitMesh = null;
    this._t = 0;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x4D45524F) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x4D45);
    // Underground and flooded. There is no weather system to ask - ctx.weather
    // is inert on this level by contract - so the level states its own condition
    // and the wetness paint reads it from here.
    this.wetness = 0.86;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(TUN_W_END - 4, -3.0, -HALL_HZ - 3),
      new THREE.Vector3(ESC_X1 + 4, ESC_HEAD_Y + 7.0, HALL_HZ + 3));
    // THE PLACEMENT CONTRACT. Available before build().
    this.anchors = buildAnchors(this.noise);
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose, and nothing in here is a remembered number.
  // ---------------------------------------------------------------------------
  function buildAnchors(N) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    var A = {};
    var opens = openingsX();

    A.hall = {
      x0: HALL_X0, x1: HALL_X1, platY: PLAT_Y, trackY: TRACK_Y, waterY: WATER_Y,
      edgeZ: PLAT_EDGE, hallHz: HALL_HZ, crown: CROWN, spring: ARC_TOP,
      groundY: function (x, z) {
        if (Math.abs(z) <= PLAT_EDGE) return platY(x, z, N);
        return trackY(x, z, N);
      }
    };

    A.platform = {
      x0: HALL_X0, x1: HALL_X1, hz: PLAT_EDGE, y: PLAT_Y,
      centre: V(-5, PLAT_Y, 0),
      westEnd: V(HALL_X0 + 2.0, PLAT_Y, 0),
      eastEnd: V(HALL_X1 - 2.0, PLAT_Y, 0),
      edgeN: V(0, PLAT_Y, -PLAT_EDGE), edgeS: V(0, PLAT_Y, PLAT_EDGE),
      tactileZ: PLAT_EDGE - 0.40, lineZ: PLAT_EDGE - 0.62,
      // the clear walking band between the two pier faces
      walkHz: ARC_BACK - 0.15
    };

    A.arcadeN = { sign: -1, faceZ: -PLAT_EDGE, backZ: -ARC_BACK, topY: ARC_TOP,
      piersX: PIERS_X.slice(), openingsX: opens.slice(), brokenX: BROKEN_X.slice(),
      pierHw: PIER_HW, openHw: OPEN_HW, headY: ARC_SPRING };
    A.arcadeS = { sign: 1, faceZ: PLAT_EDGE, backZ: ARC_BACK, topY: ARC_TOP,
      piersX: PIERS_X.slice(), openingsX: opens.slice(), brokenX: [],
      pierHw: PIER_HW, openHw: OPEN_HW, headY: ARC_SPRING };

    A.trackN = { sign: -1, cz: -TRK_CZ, railY: 0.34, waterY: WATER_Y,
      x0: HALL_X0, x1: HALL_X1, wallZ: -HALL_HZ, cessZ: -TRK_CZ - 1.62 };
    A.trackS = { sign: 1, cz: TRK_CZ, railY: 0.34, waterY: WATER_Y,
      x0: HALL_X0, x1: HALL_X1, wallZ: HALL_HZ, cessZ: TRK_CZ + 1.62 };

    A.tunnelW = {
      cz: [-TRK_CZ, TRK_CZ], portalX: HALL_X0 - 1.20, endX: TUN_W_END,
      r: TUN_R, axisY: TUN_AXIS_Y, invertY: TUN_INV, waterY: WATER_Y, dir: -1,
      walkwayY: 0.62,
      mouthN: V(HALL_X0 - 1.6, TUN_INV, -TRK_CZ), mouthS: V(HALL_X0 - 1.6, TUN_INV, TRK_CZ)
    };
    A.tunnelE = {
      cz: [-TRK_CZ, TRK_CZ], portalX: HALL_X1 + 1.20, endX: TUN_E_END,
      r: TUN_R, axisY: TUN_AXIS_Y, invertY: TUN_INV, waterY: WATER_Y, dir: 1,
      walkwayY: 0.62,
      mouthN: V(HALL_X1 + 1.6, TUN_INV, -TRK_CZ), mouthS: V(HALL_X1 + 1.6, TUN_INV, TRK_CZ)
    };

    A.train = { cars: [], nose: null, impact: null, spill: null,
      len: CAR_HL * 2, halfW: CAR_HW, floorLocal: CAR_FLOOR, roofLocal: CAR_ROOF };
    for (var i = 0; i < CARS.length; i++) {
      var c = CARS[i];
      A.train.cars.push({
        name: c.name, centre: V(c.x, c.y, c.z), yaw: c.ry, roll: c.rx, pitch: c.rz,
        len: CAR_HL * 2, halfW: CAR_HW,
        floorY: c.y + CAR_FLOOR, roofY: c.y + CAR_ROOF,
        walkable: !!c.lit || c.name === 'second', cab: !!c.cab
      });
    }
    A.train.nose = V(CARS[0].x - CAR_HL * Math.cos(CARS[0].ry),
      CARS[0].y + 1.55, CARS[0].z + CAR_HL * Math.sin(CARS[0].ry));
    A.train.impact = V(-3.6, PLAT_Y, -3.6);
    A.train.spill = V(-0.5, PLAT_Y, -3.6);

    A.escalator = {
      x0: ESC_X0, x1: ESC_X1, hz: ESC_HZ, footY: PLAT_Y, headY: ESC_HEAD_Y,
      incX0: ESC_INC_X0, incX1: ESC_INC_X1, lanes: ESC_LANES.slice(),
      slope: ESC_SLOPE, boreR: ESC_BORE_R, axisY: ESC_AXIS_Y,
      foot: V(ESC_INC_X0 - 1.2, PLAT_Y, 0), head: V(ESC_INC_X1 + 1.2, ESC_HEAD_Y, 0),
      landing: V(34.0, PLAT_Y, 0), yaw: -Math.PI * 0.5,
      axis: V(Math.cos(Math.atan(ESC_SLOPE)), Math.sin(Math.atan(ESC_SLOPE)), 0)
    };

    A.balcony = {
      centre: V((BAL_X0 + BAL_X1) * 0.5, BAL_Y, 0), y: BAL_Y,
      x0: BAL_X0, x1: BAL_X1 + 1.6, hz: BAL_HZ, yaw: Math.PI * 0.5,
      stairFoot: V(BAL_X1 + 6.0, PLAT_Y, 2.40), stairHead: V(BAL_X1 + 1.4, BAL_Y, 2.40)
    };

    A.ventShaft = { centre: V(VENT_X, CROWN, VENT_Z), r: VENT_R, ceilY: CROWN + 5.6,
      pool: V(VENT_X, PLAT_Y, VENT_Z) };
    A.collapse = { centre: V((COL_X0 + COL_X1) * 0.5, CROWN - 0.4, (COL_Z0 + COL_Z1) * 0.5),
      x0: COL_X0, x1: COL_X1, z0: COL_Z0, z1: COL_Z1,
      rubble: V(-0.5, PLAT_Y, -3.4) };
    A.crossPassage = { centre: V(CROSS_X, PLAT_Y, 0), x: CROSS_X, hz: ARC_BACK };
    A.eastArch = { centre: V(HALL_X1 + 0.6, 3.4, 0), halfWidth: EARCH_HW, crown: 5.0 };
    A.westDoor = { centre: V(HALL_X0 - 0.6, PLAT_Y, 0), halfWidth: 0.62 };

    A.lamps = [];
    A.spawn = { centre: V(-31.0, PLAT_Y, 0.4), yaw: -Math.PI * 0.5 };
    return A;
  }

  // ---- material access, defensively -----------------------------------------
  // Every metro surface is requested BY THE NAME IN ITS OWN TABLE, and that name
  // is checked against materials.js first. The library does not know
  // 'plat_floor' - it is not supposed to - so the request resolves to the
  // calibrated library entry named in `base`, WITHOUT this file second-guessing
  // its roughness, metalness or albedo. The col/rough fields in SURF exist only
  // for the no-materials.js path below, where nothing has calibrated anything.
  LevelMetro.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.raw_concrete;
    var m = null;
    var lib = this.ctx && this.ctx.materials;
    var libHas = false;
    try { libHas = !!(lib && typeof lib.has === 'function' && lib.has(key)); }
    catch (e) { libHas = false; }

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (key === 'glint') {
      m = this._glintMaterial();
    } else if (lib && typeof lib.get === 'function') {
      var name = libHas ? key : (surf.base || 'concrete');
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      if (!libHas) {
        if (surf.alphaTest !== undefined) { opts.alphaTest = surf.alphaTest; opts.side = 2; }
      }
      try { m = lib.get(name, opts); }
      catch (e2) { GAME.logError('metro.material:' + key, e2); m = null; }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelMetro.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.raw_concrete;
    var surf = SURF[key] || SURF.raw_concrete;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2],
      // A stock material has no wear shader, so a WEAR MASK written into the
      // colour attribute would be multiplied straight onto albedo - which
      // renders a soaked platform (R 0.5 / G 0.1 / B 0.9) as bright purple.
      vertexColors: !surf.wear,
      envMapIntensity: 1.0
    });
    m.name = 'metro_fallback_' + key;
    return m;
  };

  LevelMetro.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0x5349474E) : this.rng); }
    catch (e) { GAME.logError('metro.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.82, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.05,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (tex && caps && caps.getMaxAnisotropy) {
        tex.anisotropy = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
      }
    } catch (e2) { /* anisotropy is a nicety */ }
    m.name = 'metro_signage';
    return m;
  };

  LevelMetro.prototype._glintMaterial = function () {
    var tex = null;
    try { tex = glintTexture(); } catch (e) { tex = null; }
    var m = new THREE.MeshBasicMaterial({
      map: tex, color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, vertexColors: true,
      side: THREE.DoubleSide, toneMapped: false, fog: true
    });
    if (!tex) m.opacity = 0.0;
    m.name = 'metro_glint';
    return m;
  };

  // ---- colliders -------------------------------------------------------------
  LevelMetro.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
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

  // ---- build -----------------------------------------------------------------
  LevelMetro.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('metro.' + name, e); }
    }

    stage('platform', function () { buildPlatform(self, B, rng, N); });
    stage('arcade', function () { buildArcade(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('vaults', function () { buildVaults(self, B, rng, N); });
    stage('endwalls', function () { buildEndWalls(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('trackhalls', function () { buildTrackHalls(self, B, rng, N); });
    stage('tunnels', function () { buildTunnels(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('train', function () { buildTrain(self, B, rng, N); });
    stage('escalator', function () { buildEscalatorHall(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('lighting', function () { buildLighting(self, B, rng, N); });
    stage('water', function () { buildWater(self, B, rng, N); });
    stage('ceilings', function () { self._ceilingColliders(); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    stage('emitters', function () { self._buildEmitters(); });
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

  // The vaults are swept surfaces and would rasterise into the sky-visibility
  // volume as a scatter of thin shells; these slabs are what actually tell
  // lighting.js the station has a roof on it. The gaps are deliberate and are
  // the vent shaft and the collapse - the two places light genuinely does come
  // from above.
  LevelMetro.prototype._ceilingColliders = function () {
    var y = CROWN - 0.35;
    this.addCollider((HALL_X0 + -12.6) * 0.5, y, 0, (-12.6 - HALL_X0) * 0.5, 0.35, PLAT_EDGE, 'concrete');
    this.addCollider((1.8 + HALL_X1) * 0.5, y, 0, (HALL_X1 - 1.8) * 0.5, 0.35, PLAT_EDGE, 'concrete');
    this.addCollider((COL_X0 + COL_X1) * 0.5, y, (0.2 + PLAT_EDGE) * 0.5,
      (COL_X1 - COL_X0) * 0.5, 0.35, (PLAT_EDGE - 0.2) * 0.5, 'concrete');
    // the two slabs flanking the vent shaft, derived from the shaft's own
    // constants so the hole in the occupancy grid can never drift off the hole
    // in the geometry - which is what silently deleted the beam once already
    var va = -PLAT_EDGE, vb = VENT_Z - VENT_R - 0.20;
    var vc = VENT_Z + VENT_R + 0.20, vd = PLAT_EDGE;
    if (vb > va + 0.1) this.addCollider(VENT_X, y, (va + vb) * 0.5, 1.75, 0.35, (vb - va) * 0.5, 'concrete');
    if (vd > vc + 0.1) this.addCollider(VENT_X, y, (vc + vd) * 0.5, 1.75, 0.35, (vd - vc) * 0.5, 'concrete');
    var ty = TRK_SPRING + TRK_CROWN_R + 0.30;
    for (var s = -1; s <= 1; s += 2) {
      this.addCollider((HALL_X0 + HALL_X1) * 0.5, ty, s * (PLAT_EDGE + HALL_HZ) * 0.5,
        (HALL_X1 - HALL_X0) * 0.5, 0.30, (HALL_HZ - PLAT_EDGE) * 0.5, 'concrete');
    }
  };

  // ---- merge + vertex-colour pass ---------------------------------------------
  LevelMetro.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.raw_concrete;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('metro.merge:' + key, e); continue; }
      // keepUV means the source authored its own UVs (the atlas cards, the
      // glint streaks). mergeAll drops the whole uv attribute if ANY entry in
      // the bucket lacks one, so the second clause is not belt and braces:
      // without it a single un-UV'd solid landing in a keepUV bucket hands a
      // mapped material a geometry with no uv at all.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('metro.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'metro_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'glint') mesh.renderOrder = 3;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours. On a `wear` surface this is materials.js's WEAR MASK -
  // white = pristine, R grime, G wetness, B edge wear - and G is what buys the
  // flooded look: roughness collapses to 0.09 and albedo to x0.48, which is a
  // black mirror with a lamp smear in it. On everything else it is a plain
  // albedo multiplier.
  LevelMetro.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var Nv = pos.count;
    var col = new Float32Array(Nv * 3);
    var noise = this.noise;
    var W = this.wetness;
    var surf = SURF[key] || SURF.raw_concrete;
    var isWear = !!surf.wear;
    var vi = 0, e, i, j;

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode;
      // Force the mode to agree with the surface's shader: a multiplier written
      // into a wear mask (or the reverse) is a silent, catastrophic bug.
      if (isWear) {
        if (key === 'plat_floor') mode = 'floor';
        else if (key === 'flood_water') mode = 'water';
        else if (key === 'paint_line') mode = 'line';
        else if (key === 'ballast') mode = 'ballast';
        else if (key === 'grate') mode = 'grate';
        else if (key === 'wall_tile') mode = 'tile';
        else if (key === 'vault_plaster') mode = 'vault';
        else mode = 'seg';
      } else if (key === 'decal' || key === 'glint') {
        mode = 'flat';
      } else {
        mode = (ent.paint === 'clad') ? 'clad' : 'metal';
      }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r, g, b;

        if (mode === 'floor') {
          // ---- WETNESS -----------------------------------------------------
          // The whole floor carries a film - this station has been under water
          // for years - and the ponds sit on top of that. The floor is the
          // largest surface in four framings, so the floor of this channel sets
          // those frames' exposure: 0.22 of general damp is about a third of a
          // stop off, which is a wet floor. It is not allowed anywhere near 1.
          var dip = platDip(x, z, noise);
          var pud = M.saturate((dip - 0.028) / 0.032);
          var damp = M.smoothstep(0.004, 0.030, dip) * (1 - pud);
          var wet = M.saturate(0.22 + pud * 0.66 + damp * 0.34);
          // ---- GRIME -------------------------------------------------------
          var gm = M.saturate(0.14 + 0.26 * (noise.fbm2(x * 0.16 + 5, z * 0.16 - 3, 3) * 0.5 + 0.5) +
            M.smoothstep(2.6, 4.9, Math.abs(z)) * 0.20 + pud * 0.14);
          // rat-run grime: heavier in the last half metre against every wall
          gm = M.saturate(gm + M.smoothstep(0.9, 0.05, PLAT_EDGE - Math.abs(z)) * 0.22);
          // ---- POLISH ------------------------------------------------------
          // Forty years of feet down the middle of a platform wear granite to a
          // shine, and that band is the only tonal structure a 70 m floor has
          // for a lamp to find. B BRIGHTENS - the wear layer mixes toward a pale
          // substrate - so this is what stops the deck being one flat value.
          var wob = noise.fbm2(x * 0.10 + 2.2, z * 0.10 - 0.9, 2) * 0.7;
          var trk = M.smoothstep(2.9, 0.5, Math.abs(z + wob * 0.6));
          trk = Math.max(trk, M.smoothstep(1.0, 0.15, Math.abs(Math.abs(z) - (PLAT_EDGE - 0.75))) * 0.7);
          trk *= 0.55 + 0.45 * (noise.fbm2(x * 0.45 - 4, z * 0.45 + 1, 2) * 0.5 + 0.5);
          var ew = M.saturate(trk * 0.68 +
            M.smoothstep(0.64, 0.94, noise.fbm2(x * 0.9 - 2, z * 0.9 + 5, 2) * 0.5 + 0.5) * 0.20);
          ew *= 1 - pud * 0.80;
          r = 1 - gm * 0.74; g = 1 - wet; b = 1 - ew;
        } else if (mode === 'water') {
          // Standing water, as a wear mask. G 0.05-0.11 is 89-95% wet, which
          // resolves to roughness 0.09-0.13 with the albedo taken to x0.48 -
          // a dark mirror with a coherent lamp smear in it. NOT 0.0: at a full
          // 1.0 the surface is a perfect mirror of a 0.02-irradiance probe,
          // i.e. black, which is the same defect the water body had.
          var rip = noise.fbm2(x * 1.35 + 6, z * 1.35 - 2, 3) * 0.5 + 0.5;
          var rip2 = noise.fbm2(x * 5.5, z * 5.5, 2) * 0.5 + 0.5;
          // G is 0.30-0.44, i.e. 56-70% wet, and NOT 0.95. The contract takes
          // roughness to 0.09 at full wetness, and 0.09 is a mirror - which in
          // a level with no reflection to give it returns nothing at all and
          // photographs as a hole in the floor. Two thirds of the way there
          // lands roughness around 0.30-0.42, where a strip light 8 m away
          // becomes a metre-long sheen instead of a single hot texel, and the
          // albedo only comes down by a third rather than by half.
          r = 0.92 - rip * 0.10;
          g = 0.46 + rip2 * 0.16;
          b = 0.90;
        } else if (mode === 'tile') {
          // Glazed tile: kept comparatively clean at eye height and filthy at
          // both ends - splash off the floor below, water staining from above.
          var hgt = y - PLAT_Y;
          var gt = M.saturate(0.12 + 0.24 * (noise.fbm3(x * 0.55, y * 0.55, z * 0.55, 3) * 0.5 + 0.5));
          gt += M.smoothstep(0.9, 0.02, hgt) * 0.34;
          gt += M.smoothstep(1.5, 2.9, hgt) * 0.22;
          // vertical staining runs, which is what a leaking joint really does
          var st = M.smoothstep(0.52, 0.92,
            noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.6, y * 0.12, 3) * 0.5 + 0.5);
          gt = M.saturate(gt + st * 0.30);
          var wt = M.saturate(M.smoothstep(1.3, 0.0, hgt) * 0.52 + st * 0.30 * W + 0.06);
          var et = M.smoothstep(0.66, 0.95, noise.fbm3(x * 1.6, y * 1.2, z * 1.6, 2) * 0.5 + 0.5) * 0.26;
          r = 1 - gt * 0.72; g = 1 - wt; b = 1 - M.saturate(et);
        } else if (mode === 'vault') {
          // Painted plaster soffit: sooty, blotched, and weeping down every rib.
          var gv = M.saturate(0.20 + 0.32 * (noise.fbm3(x * 0.24, y * 0.5, z * 0.24, 4) * 0.5 + 0.5));
          gv += M.smoothstep(5.2, 6.6, y) * 0.16;
          var wv = M.saturate(0.10 + M.smoothstep(0.55, 0.92,
            noise.fbm2(x * 0.9 + 7, z * 0.9 - 4, 3) * 0.5 + 0.5) * 0.44 * W);
          var ev = M.smoothstep(0.70, 0.96, noise.fbm3(x * 1.1, y * 0.9, z * 1.1, 2) * 0.5 + 0.5) * 0.34;
          r = 1 - M.saturate(gv) * 0.70; g = 1 - wv; b = 1 - ev;
        } else if (mode === 'seg') {
          // Cast concrete: darker, wetter, and streaked with lime where the
          // ground water comes through the joints.
          var gs = M.saturate(0.22 + 0.30 * (noise.fbm3(x * 0.30, y * 0.42, z * 0.30, 3) * 0.5 + 0.5));
          gs += M.smoothstep(1.1, 0.02, y) * 0.26;
          var ws = M.saturate(0.16 + M.smoothstep(1.6, 0.05, y) * 0.52 * W +
            M.smoothstep(0.58, 0.94, noise.fbm2(x * 1.5 - 3, y * 0.16, 3) * 0.5 + 0.5) * 0.34 * W);
          var es = M.smoothstep(0.62, 0.94, noise.fbm3(x * 1.3, y * 1.1, z * 1.3, 2) * 0.5 + 0.5) * 0.30;
          r = 1 - M.saturate(gs) * 0.72; g = 1 - ws; b = 1 - es;
        } else if (mode === 'ballast') {
          var gb = M.saturate(0.34 + 0.30 * (noise.fbm2(x * 0.5, z * 0.5, 3) * 0.5 + 0.5));
          r = 1 - gb * 0.76;
          g = 1 - M.saturate(0.62 + M.saturate(ny) * 0.22);
          b = 1 - M.smoothstep(0.55, 0.95, noise.fbm2(x * 2.4, z * 2.4, 2) * 0.5 + 0.5) * 0.30;
        } else if (mode === 'grate') {
          var gg = M.saturate(0.24 + 0.26 * (noise.fbm3(x * 0.9, y * 0.9, z * 0.9, 2) * 0.5 + 0.5));
          r = 1 - gg * 0.66;
          g = 1 - M.saturate(W * 0.50);
          b = 1 - M.smoothstep(0.45, 0.92, noise.fbm2(x * 2.2, z * 2.2, 2) * 0.5 + 0.5) * 0.44;
        } else if (mode === 'line') {
          // Worn paint. It sits 9 mm proud of the slab, so it is the one part of
          // the deck standing water never covers and the brightest thing the
          // lamps have to find down there.
          var wn = noise.fbm2(x * 1.5 + 3, z * 1.5 - 6, 3) * 0.5 + 0.5;
          var worn = M.saturate(M.smoothstep(0.32, 0.90, wn) * 1.10);
          r = 1 - worn * 0.78;
          g = 1 - M.saturate(0.20 + platDip(x, z, noise) * 6.0) * 0.55;
          b = 1 - worn * 0.20;
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else if (mode === 'clad') {
          // Painted panel: value variation, streaks below every fixing, dirt
          // thrown up off the floor, and the water film taking value off the
          // albedo where the specular will give it back.
          var f3 = 0.82 + (noise.fbm3(x * 0.55, y * 0.42, z * 0.55, 3) * 0.5 + 0.5) * 0.34;
          var s3 = M.smoothstep(0.58, 0.94, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.4,
            y * 0.11, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny));
          f3 *= 1 - s3 * 0.32;
          f3 *= 1 - M.smoothstep(1.6, 0.05, y) * 0.30;
          if (ny > 0.4) f3 *= 1.06;
          var wetC = M.saturate(W * 0.42);
          r = f3 * (1 + s3 * 0.26) * (1 - wetC * 0.26);
          g = f3 * (1 - s3 * 0.04) * (1 - wetC * 0.28);
          b = f3 * (1 - s3 * 0.24) * (1 - wetC * 0.28);
        } else {
          // 'metal': rail, bracket, cable tray, the wreck's torn steel. Rust
          // blooms out of every joint and the first metre off the floor is
          // filthy - this is a tunnel, and everything in it has been standing in
          // water for a decade.
          var f4 = 0.76 + (noise.fbm3(x * 0.30, y * 0.28, z * 0.30, 3) * 0.5 + 0.5) * 0.38;
          var rs = M.smoothstep(0.46, 0.90, noise.fbm3(x * 0.85 + 3, y * 0.70, z * 0.85 - 4, 3) * 0.5 + 0.5);
          f4 *= 1 - M.smoothstep(1.0, 0.02, y) * 0.30;
          var wetM = M.saturate(W * (0.36 + 0.26 * M.saturate(ny)));
          r = f4 * (1 + rs * 0.46) * (1 - wetM * 0.32);
          g = f4 * (1 - rs * 0.10) * (1 - wetM * 0.34);
          b = f4 * (1 - rs * 0.44) * (1 - wetM * 0.34);
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

  // ---- the emissive fittings ---------------------------------------------------
  LevelMetro.prototype._buildEmitters = function () {
    var n = this.emitters.length;
    if (!n || !THREE.InstancedMesh) return;
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false, fog: true
    });
    var mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'metro_emitters';
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    var c = new THREE.Color();
    for (var i = 0; i < n; i++) {
      var e = this.emitters[i];
      mesh.setMatrixAt(i, e.m);
      c.copy(e.col).multiplyScalar(e.gain);
      mesh.setColorAt(i, c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.root.add(mesh);
    this._emitMesh = mesh;
  };

  // ---- walkable surfaces --------------------------------------------------------
  LevelMetro.prototype.sampleGround = function (x, z) {
    var N = this.noise;
    if (x >= HALL_X1) {
      // escalator hall (and the two east portals either side of it)
      if (Math.abs(z) <= ESC_HZ) return escTreadY(x);
      if (x > HALL_X1 + 1.2) return tunnelY(x, z, N);
      return PLAT_Y;
    }
    if (x <= HALL_X0) return tunnelY(x, z, N);
    if (Math.abs(z) <= PLAT_EDGE) return platY(x, z, N);
    if (Math.abs(z) <= HALL_HZ) return trackY(x, z, N);
    return trackY(x, M.clamp(z, -HALL_HZ, HALL_HZ), N);
  };

  LevelMetro.prototype._walkRects = function () {
    var R = [];
    // the platform, sampled off the deck itself
    R.push({ x0: HALL_X0 + 0.6, x1: HALL_X1 - 0.6, z0: -ARC_BACK + 0.25, z1: ARC_BACK - 0.25,
      ground: true });
    // the arcade recesses between the piers
    R.push({ x0: HALL_X0 + 0.6, x1: HALL_X1 - 0.6, z0: -PLAT_EDGE + 0.2, z1: PLAT_EDGE - 0.2,
      ground: true });
    // the two trackbeds
    R.push({ x0: HALL_X0 + 0.4, x1: HALL_X1 - 0.4, z0: -HALL_HZ + 0.6, z1: -PLAT_EDGE - 0.2,
      ground: true });
    R.push({ x0: HALL_X0 + 0.4, x1: HALL_X1 - 0.4, z0: PLAT_EDGE + 0.2, z1: HALL_HZ - 0.6,
      ground: true });
    // tunnel cess walkways - AI has to be able to use the flanking route or it
    // is scenery
    var s;
    for (s = -1; s <= 1; s += 2) {
      var wz = s * TRK_CZ + s * 2.05;
      R.push({ x0: TUN_W_END + 1.2, x1: HALL_X0 - 0.6, z0: wz - 0.42, z1: wz + 0.42, y: 0.67 });
      R.push({ x0: HALL_X1 + 0.6, x1: TUN_E_END - 1.2, z0: wz - 0.42, z1: wz + 0.42, y: 0.67 });
      R.push({ x0: TUN_W_END + 1.2, x1: HALL_X0 - 0.6, z0: s * TRK_CZ - 1.2, z1: s * TRK_CZ + 1.2,
        ground: true });
    }
    // escalator hall
    R.push({ x0: HALL_X1 + 0.4, x1: ESC_INC_X0, z0: -ESC_HZ + 0.5, z1: ESC_HZ - 0.5, y: PLAT_Y });
    R.push({ x0: ESC_INC_X1 + 1.2, x1: ESC_X1 - 0.4, z0: -ESC_HZ + 0.5, z1: ESC_HZ - 0.5,
      y: ESC_HEAD_Y });
    // the gallery
    R.push({ x0: BAL_X0 + 0.3, x1: BAL_X1 + 1.4, z0: -BAL_HZ + 0.3, z1: BAL_HZ - 0.3, y: BAL_Y });
    // the second car's saloon: it is the one you can walk through
    R.push({ x0: CARS[1].x - CAR_HL + 0.5, x1: CARS[1].x + CAR_HL - 0.5,
      z0: CARS[1].z - 1.0, z1: CARS[1].z + 1.0, y: CARS[1].y + CAR_FLOOR + 0.05 });
    return R;
  };

  LevelMetro.prototype._buildNav = function () {
    var cell = 0.60;
    var ox = TUN_W_END - 2, oz = -HALL_HZ - 2;
    var w = Math.ceil((ESC_X1 + 4 - ox) / cell);
    var h = Math.ceil((HALL_HZ + 4 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var R = this._walkRects();
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      obst.push([ce.x - he.x - 0.28, ce.x + he.x + 0.28, ce.z - he.z - 0.28, ce.z + he.z + 0.28,
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
          var ry = q.ground ? this.sampleGround(x, z) : q.y;
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

  // ---- spawns and framings ------------------------------------------------------
  LevelMetro.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + (yOff || 0.02), z), yaw: yaw
      });
    }
    // [0] is the player: the west end of the platform, looking east down the
    // colonnade at the wreck. Everything the level is about is in that view.
    sp(-31.0, 0.4, -Math.PI * 0.5);
    sp(-24.0, -2.6, -1.50);  sp(-15.0, 2.8, -1.62);
    sp(9.0, 1.4, 1.55);      sp(18.0, -2.2, 1.62);
    sp(-34.0, -TRK_CZ, -1.50); sp(-18.0, TRK_CZ, -1.55);
    sp(12.0, TRK_CZ, 1.58);  sp(24.0, 2.8, -1.52);
    sp(-46.0, -TRK_CZ, -1.55); sp(-56.0, TRK_CZ, 1.57);
    sp(34.0, 0.0, Math.PI);  sp(-3.0, 3.4, -1.50);

    // ---------------------------------------------------------------- framings --
    // Every pose is a position plus a look-at target that is an actual object in
    // the station, so the composition survives the geometry moving.
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
    var nose = this.anchors.train.nose;

    // ---- OVERVIEW ----------------------------------------------------------
    // From the gallery at the head of the hall, 5.6 m up, looking the full 70 m
    // west. There is no "wide open" in a metro and pretending otherwise gets a
    // shot of a wall, so the establishing frame is the LONG AXIS: the two pylon
    // arcades converging, the ribbed vault overhead, the wreck a third of the
    // way down on the left, and the west tunnel portals closing it. Pitched
    // 5.8 degrees down deliberately - the floor is where the standing water is,
    // and a level shot down a corridor puts a dead ceiling in the top half.
    var overview = pose(28.30, BAL_Y + 1.66, 0.15, -14.0, 1.30, -0.85);

    // ---- HERO1 - the signature ---------------------------------------------
    // Standing on the platform 13 m short of the wreck. Reading outward:
    //   * the tactile strip and the painted safety line run out of the bottom of
    //     frame to the vanishing point - the leading line
    //   * the vent shaft's beam lands 6.5 m ahead, across the middle third,
    //     with the rubble field inside it
    //   * the lead car's nose fills the left third, canted, up on the platform,
    //     with the two demolished piers behind it and the hanging batten still
    //     alight over the wreck
    //   * the south arcade recedes right, its red emergency strips picking out
    //     every pier
    // Eye height is measured off the deck, not assumed: the slab settles up to
    // 11 cm and a hard-coded 2.76 would float.
    var h1x = -13.20, h1z = 2.30;
    var hero1 = pose(h1x, this.sampleGround(h1x, h1z) + 1.66, h1z,
      nose.x + 0.10, 1.95, nose.z + 0.55);

    // ---- HERO2 - the west running tunnel -----------------------------------
    // Wading, 17 m out from the portal. The bore rings converge, the cable runs
    // and the walkway handrail draw the eye down the left, three emergency
    // strips recede on the right, and every one of them is doubled in the
    // water. The lit station beyond the portal is the only warm thing in frame.
    var h2x = -56.0, h2z = -7.05;
    var hero2 = pose(h2x, this.sampleGround(h2x, h2z) + 1.62, h2z,
      HALL_X0 - 0.4, 1.62, -TRK_CZ - 0.05);

    // ---- HERO3 - the escalator hall ----------------------------------------
    // The one place the level goes vertical. Standing at the foot of the bank
    // looking 21 degrees up the incline: three flights climbing out of frame,
    // the segment rings of the inclined bore ringing away above them, the tube
    // lights running up the crown with two of seven still alight, and the
    // handrails converging on the landing 7.5 m up.
    var h3x = 31.80, h3z = 0.40;
    var hero3 = pose(h3x, this.sampleGround(h3x, h3z) + 1.68, h3z,
      48.5, 7.20, -0.25);

    // ---- INTERIOR - inside the second car ----------------------------------
    // The enclosed space, and the only one in the station with a ceiling you can
    // touch. Down the saloon through the open gangway, seats and grab poles
    // flanking, one ceiling tube still going, the far end opening into the black
    // of the east tunnel with the third car in it.
    var ic = CARS[1];
    var interior = pose(ic.x - 4.9, ic.y + CAR_FLOOR + 1.62, ic.z - 0.02,
      ic.x + CAR_HL + 8.0, ic.y + 1.86, ic.z + 0.10);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior,
      // aliases so the shared market/harbor scenario names still resolve to
      // something sensible if anyone points one at this level
      street: hero1, containers: hero1, quay: hero2, crane: hero3,
      warehouse: interior, gangway: hero2
    };
  };

  // ---- broadphase + raycast -----------------------------------------------------
  LevelMetro.prototype._buildBroadphase = function () {
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

  LevelMetro.prototype.raycast = function (origin, dir, maxDist) {
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
  // The station is static. Its LIGHT is not, and that is the whole difference
  // between an abandoned station and a dressed set: a fluorescent at the end of
  // its life strikes, runs, goes unstable and drops out, and it does it on its
  // own schedule. Every driver here is noise, never a sine - a sine reads as an
  // animation curve within about two cycles, which is exactly how a flickering
  // light in a game gives itself away.
  LevelMetro.prototype.update = function (dt, ctx) {
    var mesh = this._emitMesh;
    if (!mesh || !mesh.instanceColor) return;
    this._t += (dt || 0);
    var t = this._t;
    var N = this.noise;
    var c = _tmpCol;
    var n = this.emitters.length;
    for (var i = 0; i < n; i++) {
      var e = this.emitters[i];
      var mul = 1;
      if (e.kind === 'fluoro') {
        // a working tube on a bad supply: a fast shallow ripple over a slow sag
        mul = 1 + N.perlin2(t * 6.1 + e.phase, 7.7) * 0.055 +
          N.perlin2(t * 0.21 + e.phase, 29.5) * 0.085;
      } else if (e.kind === 'dying') {
        // strike, run, go unstable, drop out. Two decorrelated fields: the slow
        // one is the duty cycle, the fast one is the arc fighting for it.
        var s1 = N.perlin2(t * 0.47 + e.phase, 13.1);
        var s2 = N.fbm2(t * 4.6 + e.phase, 41.0, 3, 2, 0.55);
        var duty = M.smoothstep(-0.16, 0.18, s1);
        mul = M.clamp(duty * 0.62 + M.smoothstep(0.22, 0.85, duty) * (0.45 + 0.45 * s2) + s2 * 0.08,
          0.015, 1.28);
      } else if (e.kind === 'emerg') {
        // battery-backed emergency gear is rock steady, with a mains ripple on
        // the few still on the ring main
        mul = 1 + N.perlin2(t * 1.7 + e.phase, 23.0) * 0.03;
      } else if (e.kind === 'work') {
        mul = 1 + N.perlin2(t * 0.55 + e.phase, 61.0) * 0.05;
      }
      c.copy(e.col).multiplyScalar(e.gain * mul);
      mesh.setColorAt(i, c);
    }
    mesh.instanceColor.needsUpdate = true;
  };
  var _tmpCol = new THREE.Color();

  GAME.LevelMetro = LevelMetro;
})(window.GAME, window.THREE);
