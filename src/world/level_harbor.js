// ============================================================================
// OPERATION BLACKOUT - src/world/level_harbor.js  ->  GAME.LevelHarbor
//
// "COLD HARBOR": a 92 x 72 m container terminal at 02:00 in a storm. The
// deliberate opposite of the market in every axis - night instead of golden
// hour, wet instead of dusty, vertical instead of horizontal, industrial
// instead of human.
//
// The plan, in world coordinates (-Z is seaward/north, the player spawns
// landward at +Z looking up the apron):
//
//        z = -56 .. -38   moored freighter, hull as a wall, deck house aft
//        z = -38 .. -30   black water, gangway, mooring ropes under tension
//        z = -30          QUAY EDGE: coping, bollards, fenders, chain rail
//        z = -30 .. -24   open apron, crane rails, the seaward crane legs
//        z = -24 .. +13   CONTAINER FIELD: west rows run N-S (the canyons the
//                         `containers` framing looks down), east rows run E-W
//        x = -13 .. +13   the central apron lane the gantry crane straddles
//        z = +14 .. +34   warehouse (west), portacabin + reefer stack (east)
//        z = +37          chain-link perimeter with barbed top, gate on axis
//
// Everything is authored into per-material buckets and merged once with
// GAME.Geo.mergeAll, except the containers, which are InstancedMesh: the
// hero asset is ~2.5k triangles of real corrugation, corner castings, rails,
// fork pockets and door hardware, so it can only be afforded ninety times by
// instancing it. Per-instance colour + a shared baked wear pass + a merged
// alpha-tested decal layer (stencils, serials, rust weeps, graffiti, patched
// repaint) is what stops a stack of thirty reading as thirty clones.
//
// Ground and other lower surfaces are painted with materials.js's VERTEX WEAR
// convention (white = pristine, R = grime, G = wetness, B = edge wear), so
// puddles get diffuse x0.48 / roughness 0.09 / specularF90 1.0 for free and
// the apron reads as a black mirror. Puddles are placed at genuine local
// minima found by sampling sampleGround(), never painted onto flat ground.
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// Everything in this terminal that another module might want to stand
// something next to is published, by name, in `level.anchors`. Read THAT.
//
//   DO NOT derive a world position from `level.cameraPoses`. A camera pose is
//   a COMPOSITION - it is chosen to frame a subject well and it moves whenever
//   the composition improves. Four of the six poses moved during this build and
//   the warehouse, the reefer bank and the portacabin moved with them, which
//   left emissive cards and props in corridors that no longer existed. Anchors
//   are the opposite: they are the terminal's own survey, they move only when
//   the terminal is rebuilt, and every one of them is derived from the same
//   constants the geometry is.
//
// Available immediately after `new LevelHarbor(ctx)` - you do NOT have to wait
// for build(). Every entry is a plain object; positions are THREE.Vector3 and
// `yaw` is a rotation about +Y in the same convention as spawnPoints.
//
//   anchors.yard            { x0,x1,z0,z1, laneHalf, groundY(x,z) }
//   anchors.quayEdge        { z, coping:Vector3, yaw, bollardsX:[...] }
//   anchors.crane           { legX, railA, railB, sill, apex, tipZ, backZ,
//                             centre:Vector3, walkway:Vector3, stairFoot:Vector3 }
//   anchors.warehouse       { x0,x1,z0,z1, faceX, outX, eave, ridge,
//                             centre, doorOpen, doorBuckled, roofHole, pool, yaw }
//   anchors.reeferBank      { centre, x, z0, z1, rows:[z...], machineFace:Vector3,
//                             socketRack:Vector3, yaw }
//   anchors.portacabin      { centre, yaw, doorSide:Vector3, windowFace:Vector3 }
//   anchors.freighter       { z, deckY, bowX, sternX, gangwayFoot, gangwayHead }
//   anchors.containersW     { rowsX:[...], baysZ:[...], corridorsX:[...],
//                             heroCorridorX, mouthZ, endZ }
//   anchors.containersE     { rowsZ:[...], baysX:[...], corridorsZ:[...] }
//   anchors.toppled         { centre, yaw, roll, spillDir }
//   anchors.gate            { centre, halfWidth, yaw }
//   anchors.masts           [ { name, base:Vector3, head:Vector3, aim:Vector3,
//                               kind, cone } ... ]   - the same rig published in
//                             practicalLights, in world coordinates
//
// The lighting contract is unchanged and is still authoritative:
//   level.practicalLights   full override of lighting.js's own lamp table.
//                           Every entry now carries an explicit `aimPos`, so a
//                           lamp's aim no longer depends on where a camera is.
//   level.lightShafts       volumetric cone anchors. Entries of kind 'mast' are
//                           the mast cones and lighting.js builds those from the
//                           SpotLight itself; entries of any other kind are real
//                           shafts (the warehouse roof hole, the crane's quay
//                           flood) and want building as published.
//   level.dripEdges         [{a, b, fall, rate, kind}] - horizontal members
//                           water runs off. The weather contract puts drips in
//                           weather.js's court; this file publishes only where
//                           they belong, so the two cannot disagree about which
//                           girder is shedding.
//   level.waterPlane        {y, x0, x1, z0, z1, quayZ} - the basin, so rain
//                           impacts can be placed on it without guessing.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var QUAY_Z = -30.0;        // quay coping face; water beyond
  var SOUTH_Z = 37.0;        // perimeter fence
  var WEST_X = -46.0;
  var EAST_X = 46.0;
  var WATER_Y = -2.60;
  var LANE_HALF = 13.0;      // the central apron lane the crane straddles

  // gantry crane
  var CR_LEG_X = 13.0;       // portal legs
  var CR_RAIL_A = -27.0;     // waterside rail
  var CR_RAIL_B = -3.0;      // landward rail (24 m gauge)
  var CR_SILL = 15.4;        // portal beam / elevated walkway level
  var CR_APEX = 30.0;
  var CR_TIP_Z = -58.0;
  var CR_BACK_Z = 10.0;

  // Warehouse shell (outer faces). It sits in the LANDWARD EAST corner, and it
  // has to: the west container block's corridors run north-south and the
  // `containers` framing stands 8.7 m back from a corridor mouth to look down
  // it. The first layout put the shed directly south of that block, which put
  // the hero eye INSIDE the building - the capture showed a corrugated shed
  // wall where the canyon should have been. Nothing else in the terminal needs
  // that ground, so the shed moved rather than the shot.
  var WH_X0 = 20.0, WH_X1 = 41.0, WH_Z0 = 14.0, WH_Z1 = 34.0;
  var WH_FACE = WH_X0;        // the yard face, carrying the roller doors
  var WH_OUT = -1;            // its outward normal along X
  var WH_EAVE = 8.0, WH_RIDGE = 10.2;

  // Supporting set pieces, in the landward lane where the player starts.
  var REEFER_X = -9.0, REEFER_Z0 = 23.4;
  var CABIN_X = 14.5, CABIN_Z = 27.5, CABIN_YAW = -Math.PI * 0.5;

  // moored freighter
  var SHIP_Z = -38.0;        // near side of the hull amidships
  var SHIP_DECK = 6.9;       // main deck above quay level
  var SHIP_BOW_X = -58.0, SHIP_STERN_X = 38.0;

  // ISO container, 40 ft and 20 ft
  var C40_L = 12.192, C20_L = 6.058, C_W = 2.438, C_H = 2.591;
  var C_PITCH = 12.54;       // bay pitch, 40 ft plus a working gap

  var UP = new THREE.Vector3(0, 1, 0);

  // Surface UV density (world metres -> uv), shadow flags, the library name to
  // fall back to if materials.js does not know the harbour name yet, and the
  // colour to force onto that fallback so a red container is never grey.
  //
  // `wear: true` asks materials.js for its VERTEX WEAR shader (R grime,
  // G wetness, B edge wear). Everything else takes wearMode 'multiply', where
  // the colour attribute is a plain albedo multiplier - which is what the
  // instanced containers need, because instanceColor multiplies into the same
  // varying and a red body colour would otherwise be read as "wet, filthy and
  // worn through to the substrate".
  var SURF = {
    wet_concrete:    { uv: 0.34, cast: false, recv: true,  wear: true,
                       base: 'concrete', col: 0x2f3236, rough: 0.92, env: 1.35 },
    dock_concrete:   { uv: 0.44, cast: true,  recv: true,  wear: true,
                       base: 'concrete', col: 0x4a4f55 },
    painted_line:    { uv: 0.70, cast: false, recv: true,  wear: true,
                       base: 'painted_metal', col: 0xd8cdb0, rough: 0.86, metal: 0.0 },
    sea_water:       { uv: 0.030, cast: false, recv: false, wear: false,
                       base: 'glass', col: 0x080d12, rough: 0.045, metal: 0.0, env: 2.4 },
    container_steel: { uv: 0.62, cast: true,  recv: true,  wear: false,
                       base: 'corrugated_metal', col: 0x6d6a64, rough: 0.66, metal: 0.72 },
    container_red:   { uv: 0.62, cast: true,  recv: true,  wear: false,
                       base: 'corrugated_metal', col: 0x7a2f28, rough: 0.62, metal: 0.70 },
    container_blue:  { uv: 0.62, cast: true,  recv: true,  wear: false,
                       base: 'corrugated_metal', col: 0x1f4a6b, rough: 0.62, metal: 0.70 },
    container_green: { uv: 0.62, cast: true,  recv: true,  wear: false,
                       base: 'corrugated_metal', col: 0x2c5040, rough: 0.62, metal: 0.70 },
    reefer_panel:    { uv: 0.85, cast: true,  recv: true,  wear: false,
                       base: 'painted_metal', col: 0xb9bcbd, rough: 0.42, metal: 0.80 },
    corrugated_roof: { uv: 0.55, cast: true,  recv: true,  wear: false,
                       base: 'corrugated_metal', col: 0x5b6167, rough: 0.68, metal: 0.68 },
    // A 96 m hull at uv 0.30 puts twelve texture repeats across the whole
    // ship, so every blotch of the macro layer came out four metres across and
    // the wall that closes the `quay` and `gangway` framings photographed as a
    // cliff face rather than as a painted steel side. 0.52 lands the plating
    // and the streaks at roughly two metres, which is plate scale.
    ship_hull:       { uv: 0.52, cast: true,  recv: true,  wear: false,
                       base: 'painted_metal', col: 0x2b3238, rough: 0.55, metal: 0.74 },
    // Structural steel: everything from the crane lattice to the bollards.
    // Deliberately MULTIPLY rather than wear-mode - rust is chromatic and the
    // wear convention's substrate colour is bare metal, not iron oxide, so this
    // surface needs the paint pass to be able to push toward orange.
    deck_plate:      { uv: 0.80, cast: true,  recv: true,  wear: false,
                       base: 'painted_metal', col: 0x4d5257, rough: 0.45, metal: 0.78 },
    // ---------------------------------------------------------------------
    // STRUCTURAL STEEL. Same material as deck_plate - deliberately: `base` is
    // a name materials.js knows, so the request resolves to the identical
    // cached material and the crane keeps the whole wet-surface path (wetDark
    // 0.70, wetRough 0.070, puddle 0.55). What changes is the UV DENSITY, and
    // that is the entire bug: deck_plate's 0.80 uv puts genPaintedMetal's chip
    // worley field at roughly 10 cm cells, which on a 130-260 mm crane strut
    // face is two or three cells across a member and reads as diamond tread
    // plate. A gantry chord is rolled section under one coat of yard enamel,
    // not checker plate. At 0.26 the same map scales to the MEMBER instead of
    // to the world and the lattice reads as painted steel.
    //
    // Note this is NOT a new library entry: adding one would have resolved to
    // the market's own painted_metal, which has no wetDark and would have left
    // the crane the only dry object in a level whose premise is that
    // everything is soaked.
    struct_steel:    { uv: 0.26, cast: true,  recv: true,  wear: false,
                       base: 'deck_plate' },
    steel_grate:     { uv: 1.30, cast: false, recv: true,  wear: true,
                       base: 'rusted_metal', col: 0x55504a, rough: 0.72, metal: 0.80 },
    rubber_fender:   { uv: 1.10, cast: true,  recv: true,  wear: false,
                       base: 'rubber', col: 0x1b1d20, rough: 0.88, metal: 0.0 },
    // ---------------------------------------------------------------------
    // MOORING LINE. keepUV, because a planar world projection on a tube that
    // runs diagonally in three dimensions is the one mapping that cannot work:
    // around the circumference the projected u barely changes, so whatever lay
    // the rope recipe authors gets stretched to infinity across the section and
    // a 150 mm hawser 4 m from the lens renders as a smooth plastic pipe with
    // one specular line down it. ropeTube() below writes u wrapping the
    // circumference and v running along the ARC LENGTH, so materials.js's
    // `woven` detail and its own repeat land in the right units, and the three
    // -strand lay is modelled in the silhouette as well as in the map.
    rope:            { uv: 2.60, cast: true,  recv: true,  wear: false, keepUV: true,
                       base: 'fabric', col: 0x8b8064, rough: 0.96, metal: 0.0 },
    tarpaulin:       { uv: 0.95, cast: true,  recv: true,  wear: false,
                       base: 'fabric', col: 0x3c4a3f, rough: 0.90, metal: 0.0 },
    chainlink:       { uv: 1.00, cast: false, recv: false, wear: false, keepUV: true,
                       base: 'painted_metal', col: 0x9aa3a8, rough: 0.55, metal: 0.85,
                       alphaTest: 0.42 },
    // Not a library name: the alpha-tested stencil/rust/graffiti atlas this
    // file generates for itself. Kept in the SURF table so the merge pass can
    // treat it like any other bucket.
    decal:           { uv: 1.0, cast: false, recv: true,  wear: false, own: true, keepUV: true },
    // Lamp lenses and lit windows. Dark albedo, hot emissive: it has to READ as
    // a source in a night frame, and postfx's bloom is what turns it into one.
    glass_lit:       { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                       base: 'plastic', col: 0x35291d, rough: 0.22, metal: 0.0,
                       emissive: 0xff9a3c, emissiveIntensity: 4.2 },
    // Aviation obstruction beacons. Red, and separate from glass_lit because a
    // red lamp at 30 m on the crane apex and the boom tip is the only thing in
    // the level that puts a mark in the TOP of the frame, and it must not be
    // averaged into the sodium palette.
    glass_red:       { uv: 0.6, cast: false, recv: false, wear: false, keepUV: true,
                       base: 'plastic', col: 0x2a0d0a, rough: 0.24, metal: 0.0,
                       emissive: 0xff2a18, emissiveIntensity: 5.4 }
  };

  // If materials.js is missing entirely the level must still read as a wet
  // industrial terminal rather than as magenta error boxes.
  var FALLBACK = {
    wet_concrete:    [0x16191c, 0.30, 0.0],
    dock_concrete:   [0x3a3f45, 0.86, 0.0],
    painted_line:    [0xbfb69c, 0.80, 0.0],
    sea_water:       [0x070b10, 0.045, 0.0],
    container_steel: [0x6d6a64, 0.66, 0.55],
    container_red:   [0x7a2f28, 0.62, 0.50],
    container_blue:  [0x1f4a6b, 0.62, 0.50],
    container_green: [0x2c5040, 0.62, 0.50],
    reefer_panel:    [0xb9bcbd, 0.42, 0.70],
    corrugated_roof: [0x5b6167, 0.68, 0.55],
    ship_hull:       [0x2b3238, 0.55, 0.60],
    deck_plate:      [0x4d5257, 0.60, 0.65],
    struct_steel:    [0x8d949a, 0.42, 0.62],
    steel_grate:     [0x55504a, 0.72, 0.70],
    rubber_fender:   [0x1b1d20, 0.88, 0.0],
    rope:            [0x8b8064, 0.96, 0.0],
    tarpaulin:       [0x3c4a3f, 0.90, 0.0],
    chainlink:       [0x9aa3a8, 0.55, 0.80],
    decal:           [0xffffff, 0.75, 0.0],
    glass_lit:       [0xffcf92, 0.16, 0.0],
    glass_red:       [0xff5a44, 0.18, 0.0]
  };

  // --------------------------------------------------------- small helpers --
  var _e1 = new THREE.Euler();
  var _tv = new THREE.Vector3();

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

  // A flat quad in the XY plane facing +Z. Decal cards, markings, water discs.
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

  // Extrude a closed 2D loop given in the XZ plane along Y. This is the atom of
  // every corrugated surface in the level: container flanks, container ends,
  // door leaves, warehouse cladding. Corrugation on a shipping container runs
  // VERTICALLY, so the cross-section varies along the wall and is constant in
  // height - which is exactly what this produces, at ~2 triangles per profile
  // point rather than the ~40 a displaced grid would cost.
  //
  // ---------------------------------------------------------------------------
  // SMOOTHING IS NOT A NICETY HERE, IT IS THE WHOLE SURFACE.
  //
  // The first version wrote ONE geometric face normal to all three vertices of
  // every triangle. On a 0.30 m corrugation that makes the shading normal a
  // SQUARE WAVE: it snapped between the wall normal and the web normal every
  // 5 cm with no gradient anywhere, so under any raking lamp the webs blew out
  // and the crests and valleys returned nothing. Measured on a 2x supersampled
  // capture (i.e. provably not an aliasing artefact): rib peaks 0.167-0.211
  // against troughs 0.019-0.029, an 8:1 modulation where real rolled steel under
  // a raking practical runs about 2:1. Every container flank in the level read
  // as a barcode, in five of six hero framings.
  //
  // Rolled corrugated steel has an ~8 mm fold radius and is CONTINUOUS. So the
  // profile now carries a chamfer point at each fold (see CORR_PROFILE) and this
  // function averages the two adjacent face normals at every profile vertex
  // whose turn is under SMOOTH_LIMIT. Sharp turns - the ends of the loop, the
  // wall thickness, a door frame - keep their hard edge, because the test is on
  // the actual turn angle rather than on a flag.
  // ---------------------------------------------------------------------------
  var SMOOTH_COS = Math.cos(75 * Math.PI / 180);   // 75 deg: fold yes, corner no

  function extrudeY(pts, y0, y1, caps, hardEdges) {
    var n = pts.length, i;
    // shoelace: guarantee one winding so the outward normals are consistent
    var area = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    var list = pts;
    if (area < 0) { list = pts.slice().reverse(); }
    var pos = [], nor = [];
    function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    }
    // ---- per-segment face normals, then per-vertex averages -------------------
    // tri() above computes (dz, 0, -dx)/len for the segment p->q; deriving the
    // same expression analytically keeps the two in step.
    var sn = [];
    for (i = 0; i < n; i++) {
      var s0 = list[i], s1 = list[(i + 1) % n];
      var sdx = s1[0] - s0[0], sdz = s1[1] - s0[1];
      var sl = Math.sqrt(sdx * sdx + sdz * sdz) || 1;
      sn.push([sdz / sl, -sdx / sl]);
    }
    function blend(a, b, keep) {
      var d = a[0] * b[0] + a[1] * b[1];
      if (d < SMOOTH_COS) return keep;
      var bx = a[0] + b[0], bz = a[1] + b[1];
      var bl = Math.sqrt(bx * bx + bz * bz);
      if (bl < 1e-6) return keep;
      return [bx / bl, bz / bl];
    }
    var nStart = [], nEnd = [];
    for (i = 0; i < n; i++) {
      if (hardEdges) { nStart.push(sn[i]); nEnd.push(sn[i]); continue; }
      nStart.push(blend(sn[(i - 1 + n) % n], sn[i], sn[i]));
      nEnd.push(blend(sn[i], sn[(i + 1) % n], sn[i]));
    }
    function vtx(x, y, z, nrm) {
      pos.push(x, y, z);
      nor.push(nrm[0], 0, nrm[1]);
    }
    for (i = 0; i < n; i++) {
      var p = list[i], q = list[(i + 1) % n];
      var na = nStart[i], nb = nEnd[i];
      // same two triangles, same winding as the original tri() pair
      vtx(p[0], y0, p[1], na); vtx(p[0], y1, p[1], na); vtx(q[0], y1, q[1], nb);
      vtx(p[0], y0, p[1], na); vtx(q[0], y1, q[1], nb); vtx(q[0], y0, q[1], nb);
    }
    if (caps !== false) {
      var cx0 = 0, cz0 = 0;
      for (i = 0; i < n; i++) { cx0 += list[i][0]; cz0 += list[i][1]; }
      cx0 /= n; cz0 /= n;
      for (i = 0; i < n; i++) {
        var s = list[i], t = list[(i + 1) % n];
        tri(cx0, y0, cz0, s[0], y0, s[1], t[0], y0, t[1]);
        tri(cx0, y1, cz0, t[0], y1, t[1], s[0], y1, s[1]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // Extrude a closed 2D loop given in XY along Z. Coping stones, rails, kerbs.
  function extrudeZ(pts, len) {
    var n = pts.length, hl = len * 0.5, i;
    var area = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    var list = area < 0 ? pts.slice().reverse() : pts;
    var pos = [], nor = [];
    function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      nor.push(nx / l, ny / l, nz / l, nx / l, ny / l, nz / l, nx / l, ny / l, nz / l);
    }
    for (i = 0; i < n; i++) {
      var p = list[i], q = list[(i + 1) % n];
      tri(p[0], p[1], -hl, q[0], q[1], -hl, q[0], q[1], hl);
      tri(p[0], p[1], -hl, q[0], q[1], hl, p[0], p[1], hl);
    }
    var cx0 = 0, cy0 = 0;
    for (i = 0; i < n; i++) { cx0 += list[i][0]; cy0 += list[i][1]; }
    cx0 /= n; cy0 /= n;
    for (i = 0; i < n; i++) {
      var s = list[i], t = list[(i + 1) % n];
      tri(cx0, cy0, hl, s[0], s[1], hl, t[0], t[1], hl);
      tri(cx0, cy0, -hl, t[0], t[1], -hl, s[0], s[1], -hl);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // The corrugation profile of a container flank, as a closed loop in XZ.
  // Outer face toward +Z. `dent` displaces whole cycles so no two geometry
  // variants share a silhouette.
  //
  // One cycle, as [fraction of pitch, fraction of depth]. This is NOT the
  // four-point square wave it started as. Corrugated container panel is COLD
  // ROLLED, so every crest-to-web and web-to-valley turn has a fold radius of
  // roughly 8 mm; the chamfer points at 0.390 and 0.890 model it, and they are
  // what let extrudeY's normal averaging produce a continuous shading gradient
  // instead of two alternating constants. The web run is also widened from
  // 0.16 to 0.22 of pitch, which drops the steepest facet from 39 degrees off
  // the wall to 24 - and the depth comes down with it (see the call sites), so
  // the silhouette amplitude that was aliasing at 60 m falls by a third as
  // well. Six points per cycle rather than four: 1.5x the triangles on the
  // level's dominant surface, which is the cheapest fix available for the
  // single most damaging artefact in the level.
  var CORR_PROFILE = [
    [0.000, 0.00], [0.300, 0.00], [0.390, 0.50],
    [0.500, 1.00], [0.800, 1.00], [0.890, 0.50]
  ];

  function corrugationLoop(len, pitch, depth, thick, dent, seed) {
    var n = Math.max(2, Math.round(len / pitch));
    var p = len / n;
    var half = len * 0.5;
    var outer = [], i, k;
    for (i = 0; i <= n; i++) {
      var x0 = -half + i * p;
      var d = 0;
      if (dent) {
        // a shallow, low-frequency buckle: containers are handled by cranes and
        // are never straight after their first voyage
        d = Math.sin((i * 1.7 + seed) * 0.9) * 0.5 + Math.sin((i * 0.41 - seed) * 1.7) * 0.5;
        d = d * dent;
      }
      if (i < n) {
        for (k = 0; k < CORR_PROFILE.length; k++) {
          outer.push([x0 + p * CORR_PROFILE[k][0], d - depth * CORR_PROFILE[k][1]]);
        }
      } else {
        outer.push([x0, d]);
      }
    }
    var loop = outer.slice();
    for (i = outer.length - 1; i >= 0; i--) {
      loop.push([outer[i][0], outer[i][1] - thick]);
    }
    return loop;
  }

  // ---------------------------------------------------------------------------
  // A PUDDLE. An irregular disc - a rectangle laid flat on the ground is the
  // loudest possible "decal" tell and a circle is the second loudest - but it is
  // also SUBDIVIDED and RIPPLED, and that part is not cosmetic.
  //
  // The first version was a 20-triangle fan: one vertex at the centre, twenty on
  // the rim, dead flat, all normals (0,1,0). At the wetness this level writes
  // into the wear mask that is a roughness of 0.09 with specularF90 at 1.0 -
  // i.e. a MIRROR - so every puddle in the near field returned a single
  // undistorted image of the overcast sky. Measured on the `gangway` capture:
  // two of them covered the bottom-left quadrant at 0.89 luminance, made the
  // ground brighter than the sky above it, and read as sheets of steel plate.
  // The straight rim segments were visible at 3 m as well.
  //
  // 3 mm of relief at a 0.35 m wavelength is a normal deviation of about three
  // degrees. That is nothing at normal incidence and everything at the grazing
  // angles a puddle is actually seen at: the mirror breaks into a rippled smear,
  // which is what "wet ground that is not a blur" is supposed to mean.
  // ---------------------------------------------------------------------------
  function blobDisc(rng, r, aspect, ragged) {
    var n = 34, rings = 4, i, k;
    var rad = [];
    var ph = rng.range(0, 6.283), ph2 = rng.range(0, 6.283), ph3 = rng.range(0, 6.283);
    for (i = 0; i <= n; i++) {
      var a = (i % n) / n * 6.28318;
      rad.push(r * (1 + ragged * (0.40 * Math.sin(a * 2 + ph) + 0.24 * Math.sin(a * 3.3 + ph2) +
        0.13 * Math.sin(a * 5.1 - ph))));
    }
    function P(ri, ai) {
      var t = ri / rings;
      var a = (ai % n) / n * 6.28318;
      var rr = rad[ai % n] * t;
      var x = Math.cos(a) * rr, z = Math.sin(a) * rr * aspect;
      // capillary chop, dying out at the rim where the film is thinnest
      var y = (Math.sin(x * 17.9 + ph3) * Math.sin(z * 15.3 - ph2) * 0.0030 +
               Math.sin(x * 8.1 - z * 9.4 + ph) * 0.0018) * (1 - t * t * 0.65);
      return [x, y, z];
    }
    var pos = [], nor = [];
    function nAt(ri, ai) {
      var c = P(ri, ai);
      var e = 0.06;
      var a = (ai % n) / n * 6.28318;
      var dx = [c[0] + e * Math.cos(a + 1.5708), 0, c[2] + e * Math.sin(a + 1.5708)];
      // finite-difference the same analytic surface the positions come from
      var hx = (Math.sin(dx[0] * 17.9 + ph3) * Math.sin(dx[2] * 15.3 - ph2) * 0.0030 +
                Math.sin(dx[0] * 8.1 - dx[2] * 9.4 + ph) * 0.0018);
      var d2 = P(Math.min(rings, ri + 1), ai);
      var ux = dx[0] - c[0], uy = hx - c[1], uz = dx[2] - c[2];
      var vx = d2[0] - c[0], vy = d2[1] - c[1], vz = d2[2] - c[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      return [nx / l, ny / l, nz / l];
    }
    function push(ri, ai) {
      var p = P(ri, ai), q = nAt(ri, ai);
      pos.push(p[0], p[1], p[2]); nor.push(q[0], q[1], q[2]);
    }
    for (k = 0; k < rings; k++) {
      for (i = 0; i < n; i++) {
        if (k === 0) { push(0, i); push(1, i); push(1, i + 1); continue; }
        push(k, i); push(k + 1, i); push(k + 1, i + 1);
        push(k, i); push(k + 1, i + 1); push(k, i + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // A height-field patch. Used for the apron slab and the sea. `indexed` keeps
  // the index buffer, which the sea needs so its normals stay smooth when
  // update() re-derives them every other frame.
  function gridSurface(x0, x1, z0, z1, step, fn, indexed) {
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
    if (indexed) return g;
    var out = g.toNonIndexed();
    g.dispose();
    return out;
  }

  // A hanging catenary between two points, as a chain of short cylinders.
  // Mooring lines, power cables to the reefer stack, the sagging chain rail.
  function catenary(B, key, ax, ay, az, bx, by, bz, sag, rad, segs, tintC) {
    segs = segs || 8;
    if (key === 'rope') {
      // A rope is not a chain of cylinders. See ropeTube().
      var oldT = B.tint;
      if (tintC) B.tint = tintC;
      B.add(key, ropeTube(ax, ay, az, bx, by, bz, sag, rad,
        Math.max(6, segs * 2), rad > 0.05 ? 10 : 7), null);
      B.tint = oldT;
      return;
    }
    var prevX = ax, prevY = ay, prevZ = az;
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var x = ax + (bx - ax) * t;
      var z = az + (bz - az) * t;
      var y = ay + (by - ay) * t - Math.sin(t * Math.PI) * sag;
      var dx = x - prevX, dy = y - prevY, dz = z - prevZ;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      var yaw = Math.atan2(dx, dz);
      var pitch = Math.acos(M.clamp(dy / len, -1, 1));
      var m = new THREE.Matrix4();
      _e1.set(pitch, yaw, 0, 'YXZ');
      m.makeRotationFromEuler(_e1);
      m.elements[12] = (x + prevX) * 0.5;
      m.elements[13] = (y + prevY) * 0.5;
      m.elements[14] = (z + prevZ) * 0.5;
      var old = B.tint;
      if (tintC) B.tint = tintC;
      B.add(key, cyl(rad, rad, len, 5), m);
      B.tint = old;
      prevX = x; prevY = y; prevZ = z;
    }
  }

  // ---------------------------------------------------------------------------
  // A LAID ROPE, as one swept tube along a catenary.
  //
  // The mooring lines are a hero prop: they sit 4 m from the lens in the level's
  // second-best framing and they are the only soft, organic thing in a terminal
  // made of steel boxes. Built as a chain of plain cylinders under a world-space
  // UV projection they were a garden hose. Built like this they are a rope:
  //
  //   * the section radius is modulated by a three-lobed function whose phase
  //     advances along the line, so the three strands are in the SILHOUETTE and
  //     the lay closes on itself
  //   * the lay pitch is ~3x the rope diameter, which is what a real hawser is
  //   * u wraps the circumference three times (one per strand), v runs along the
  //     arc length, so the map and the geometry agree about which way is "along"
  //   * normals are computed from the actual modulated surface, not from a
  //     cylinder, so each strand catches its own highlight
  // ---------------------------------------------------------------------------
  function ropeTube(ax, ay, az, bx, by, bz, sag, rad, stations, ring) {
    stations = Math.max(4, stations || 14);
    ring = Math.max(6, ring || 9);
    var i, j;
    var P = [], arc = [0];
    for (i = 0; i <= stations; i++) {
      var t = i / stations;
      P.push([ax + (bx - ax) * t, ay + (by - ay) * t - Math.sin(t * Math.PI) * sag,
              az + (bz - az) * t]);
      if (i > 0) {
        var dx0 = P[i][0] - P[i - 1][0], dy0 = P[i][1] - P[i - 1][1], dz0 = P[i][2] - P[i - 1][2];
        arc.push(arc[i - 1] + Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0));
      }
    }
    var lay = Math.max(0.12, rad * 6.0);            // pitch = 3 x diameter
    var tiles = 1 / lay;
    var pos = [], nor = [], uvs = [];
    // rings: position, plus the two frame axes, so normals can be finite-
    // differenced off the same parametric surface the positions come from
    function surf(i, j) {
      var p = P[i];
      var pa = P[Math.max(0, i - 1)], pb = P[Math.min(stations, i + 1)];
      var tx = pb[0] - pa[0], ty = pb[1] - pa[1], tz = pb[2] - pa[2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // a stable frame: cross the tangent with world up unless they are parallel
      var ux = -tz, uy = 0, uz = tx;
      var ul = Math.sqrt(ux * ux + uz * uz);
      if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
      ux /= ul; uz /= ul;
      var vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      var a = j / ring * 6.28318;
      var phase = a * 3 - arc[i] / lay * 6.28318;
      var r = rad * (1 + 0.155 * Math.cos(phase));
      var ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      return [p[0] + ux * ca + vx * sa, p[1] + uy * ca + vy * sa, p[2] + uz * ca + vz * sa];
    }
    var grid = [];
    for (i = 0; i <= stations; i++) {
      grid.push([]);
      for (j = 0; j <= ring; j++) grid[i].push(surf(i, j % ring));
    }
    function nrmAt(i, j) {
      var c = grid[i][j];
      var a = grid[i][(j + 1) % ring], b = grid[Math.min(stations, i + 1)][j];
      if (i === stations) b = grid[i - 1][j];
      var e1x = a[0] - c[0], e1y = a[1] - c[1], e1z = a[2] - c[2];
      var e2x = b[0] - c[0], e2y = b[1] - c[1], e2z = b[2] - c[2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      if (i === stations) { nx = -nx; ny = -ny; nz = -nz; }
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      // point it away from the spine
      var sx = c[0] - P[i][0], sy = c[1] - P[i][1], sz = c[2] - P[i][2];
      if (nx * sx + ny * sy + nz * sz < 0) { l = -l; }
      return [nx / l, ny / l, nz / l];
    }
    function push(i, j) {
      var p = grid[i][j], nn = nrmAt(i, j % ring);
      pos.push(p[0], p[1], p[2]);
      nor.push(nn[0], nn[1], nn[2]);
      uvs.push(j / ring, arc[i] * tiles);
    }
    for (i = 0; i < stations; i++) {
      for (j = 0; j < ring; j++) {
        push(i, j); push(i + 1, j); push(i + 1, j + 1);
        push(i, j); push(i + 1, j + 1); push(i, j + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
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
  // A transform stack plus per-material geometry buckets. Identical in shape to
  // the market level's builder, deliberately: this file follows that file's
  // patterns rather than inventing new ones.
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
  // A strut between two arbitrary world points - the whole crane is these.
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

  // ============================================================== THE GROUND ==
  // The apron is a settled concrete slab, not a plane. Drainage channels, a
  // fall toward the quay, slab settlement and ponding basins all come from one
  // analytic function so sampleGround, the navgrid, the puddle placer and the
  // vertex-colour wetness pass can never disagree about where the low spots are.
  function chan(v, c, w, d) {
    var a = Math.abs(v - c);
    return a < w ? (1 - a / w) * d : 0;
  }

  // ---------------------------------------------------------------------------
  // The apron is authored as GRADE + DIP, and the split is load-bearing.
  //
  // apronGrade() is the surface the slab was laid to: a fall toward the quay
  // plus forty years of settlement. It is smooth, and NO WATER LIES ON IT.
  // apronDip() is how far below its own surroundings a point has sunk - failed
  // sub-base, drainage channels, the saw-cut joints. Water lies in THAT, and
  // only where it is deeper than PUDDLE_FILM.
  //
  // The first version compared apronY against an ABSOLUTE water plane at
  // -0.052 m. The yard's mean settlement is -0.097 m, so every vertex in the
  // terminal measured as submerged: the whole apron - the largest surface in
  // every framing - was painted G=0.03, i.e. 97% standing water, everywhere.
  // Measured consequence, with a mast putting 10 lux on it: an effective
  // albedo of 0.017 and a ground plane that returned 8% of what a plain grey
  // would. Relief-relative ponding cannot fail that way, because it has no
  // absolute height in it to get out of step with the slab.
  // ---------------------------------------------------------------------------

  // Saw-cut construction joints. A slab this size is cast in bays and cut
  // within a day of the pour. The joint grid is the strongest thing on a
  // terminal floor: it is what gives a 90 m sheet of concrete scale, direction
  // and a leading line, and being 8 mm wide and sealed it holds a thread of
  // water, so it reads as a dark line under any lamp.
  var JOINT_PITCH = 6.1;
  function jointDip(x, z) {
    var a = ((x + 3.05) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    var b = ((z + 1.75) % JOINT_PITCH + JOINT_PITCH) % JOINT_PITCH - JOINT_PITCH * 0.5;
    var d = 0;
    a = Math.abs(a); b = Math.abs(b);
    if (a < 0.085) d = (1 - a / 0.085) * 0.032;
    if (b < 0.085) d = Math.max(d, (1 - b / 0.085) * 0.032);
    return d;
  }

  function apronGrade(x, z, N) {
    var y = 0;
    // slab settlement over the whole yard
    y -= (N.fbm2(x * 0.036 + 11.3, z * 0.036 - 4.7, 3) * 0.5 + 0.5) * 0.155;
    // the last few metres fall to the quay so the yard drains over the edge
    y -= M.smoothstep(-24.0, -29.6, z) * 0.105;
    return y;
  }

  // How far this point has sunk BELOW its own surroundings, in metres.
  function apronDip(x, z, N) {
    // ponding basins where the sub-base has failed
    var b = M.saturate(N.fbm2(x * 0.098 - 3.1, z * 0.098 + 6.4, 2) * 0.5 + 0.5);
    var d = Math.pow(b, 3.1) * 0.140;
    // drainage channels: three across the yard, two down the lane edges
    d += chan(z, -22.0, 0.55, 0.085) + chan(z, -1.5, 0.55, 0.085) + chan(z, 19.5, 0.55, 0.085);
    d += chan(x, -14.4, 0.45, 0.070) + chan(x, 14.4, 0.45, 0.070);
    d += jointDip(x, z);
    return d;
  }

  function apronY(x, z, N) {
    // surface tooth - stops the slab reading as a mathematical sheet
    return apronGrade(x, z, N) - apronDip(x, z, N) +
      N.fbm2(x * 1.05, z * 1.05, 2) * 0.011;
  }

  // Only a depression deeper than the film water can hold on a rough slab
  // actually ponds. Returns metres of standing water: <= 0 is merely wet.
  //
  // 50 mm was too strict and measured as such: 3.6% of apron vertices came
  // back as standing water and the disc placer found seven puddles in a 92 x
  // 72 m yard in a downpour, against a brief that asks for a black mirror.
  // 38 mm puts it at ~13% and ~20 discs, which is a wet working apron rather
  // than either a lake or a car park after a shower.
  var PUDDLE_FILM = 0.038;
  function waterDepth(x, z, N) {
    return apronDip(x, z, N) - PUDDLE_FILM;
  }

  // The height of the free water surface where there is any.
  function waterY(x, z, N) {
    return apronY(x, z, N) + Math.max(0, waterDepth(x, z, N));
  }

  // ========================================================== THE CONTAINER ==
  // The hero asset. A shipping container that reads as a coloured box is on the
  // instant-fail list, so this one is built the way the real thing is welded:
  //
  //   * corner castings at all eight corners, with their oval apertures
  //   * top and bottom side rails, end rails, corner posts
  //   * trapezoidal corrugation on both flanks, the blind end and the door
  //     leaves - modelled, not faked, because a normal map on a silhouette
  //     edge does nothing and the flanks are always seen edge-on somewhere
  //   * fork pockets cut into the bottom rail
  //   * a cargo-door end: two leaves, four locking bars with top and bottom
  //     cams, retainers, handles, five hinges a side, a gasket line down the
  //     meeting edge and a placard holder
  //   * a slightly domed, transversely corrugated roof
  //   * per-variant buckling so no two geometry variants share a silhouette
  //
  // ~2.6k triangles. Affordable ninety times only as InstancedMesh, which is
  // why the weathering that varies per unit lives in instanceColor (body
  // colour, chalking, how rusty this one is) and in the separate merged decal
  // layer (stencils, serials, rust weeps, graffiti, patched repaint), while the
  // geometry carries only NEUTRAL value wear that multiplies correctly under
  // any body colour.
  // ---------------------------------------------------------------------------
  function containerGeometry(opts) {
    opts = opts || {};
    var L = opts.len || C40_L;
    var seed = opts.seed || 1;
    var hl = L * 0.5, hw = C_W * 0.5, hh = C_H * 0.5;
    var dent = opts.dent === undefined ? 0.010 : opts.dent;
    var B = new Builder();
    var K = 'body';
    var i;

    // ---- corner castings -----------------------------------------------------
    // 178 x 162 x 118 mm forged blocks. Every load in the container's life goes
    // through these eight lumps, and they are where all the rust starts.
    for (var sx = -1; sx <= 1; sx += 2) {
      for (var sz = -1; sz <= 1; sz += 2) {
        for (var sy = -1; sy <= 1; sy += 2) {
          var cx = sx * (hl - 0.089), cy = sy * (hh - 0.059), cz = sz * (hw - 0.081);
          B.box(K, 0.178, 0.118, 0.162, cx, cy, cz, 0.014);
          // the outboard face is proud of the rails, and carries the aperture
          B.box(K, 0.028, 0.076, 0.104, cx + sx * 0.094, cy, cz, 0.008);
          B.box(K, 0.104, 0.076, 0.026, cx, cy, cz + sz * 0.086, 0.008);
        }
      }
    }

    // ---- corner posts and end rails ------------------------------------------
    for (sx = -1; sx <= 1; sx += 2) {
      for (sz = -1; sz <= 1; sz += 2) {
        B.box(K, 0.098, C_H - 0.24, 0.112, sx * (hl - 0.052), 0, sz * (hw - 0.058), 0.006);
      }
      // top and bottom end rails
      B.box(K, 0.086, 0.108, C_W - 0.20, sx * (hl - 0.046), hh - 0.062, 0, 0.006);
      B.box(K, 0.086, 0.126, C_W - 0.20, sx * (hl - 0.046), -hh + 0.070, 0, 0.006);
    }

    // ---- side rails ----------------------------------------------------------
    for (sz = -1; sz <= 1; sz += 2) {
      B.box(K, L - 0.19, 0.104, 0.088, 0, hh - 0.056, sz * (hw - 0.046), 0.006);
      B.box(K, L - 0.19, 0.132, 0.104, 0, -hh + 0.070, sz * (hw - 0.050), 0.006);
      // the bottom rail is a channel section - a lip along its foot catches a
      // highlight and is what stops it reading as a plain fillet
      B.box(K, L - 0.19, 0.030, 0.034, 0, -hh + 0.018, sz * (hw - 0.028), 0.004);
    }

    // ---- fork pockets --------------------------------------------------------
    // 20 ft boxes have them; 40 ft boxes usually do not, but a terminal is full
    // of both and the recess is a strong shadow line along the bottom rail.
    var fp = L > 9 ? [-2.05, 2.05] : [-0.95, 0.95];
    for (i = 0; i < fp.length; i++) {
      for (sz = -1; sz <= 1; sz += 2) {
        B.box(K, 0.36, 0.112, 0.052, fp[i], -hh + 0.072, sz * (hw - 0.014), 0.004);
        B.box(K, 0.30, 0.086, 0.030, fp[i], -hh + 0.072, sz * (hw - 0.086), 0.003);
      }
    }

    // ---- underframe cross members --------------------------------------------
    var nCross = Math.max(4, Math.round(L / 1.5));
    for (i = 0; i < nCross; i++) {
      var ux = -hl + 0.35 + (i + 0.5) * (L - 0.7) / nCross;
      B.box(K, 0.075, 0.088, C_W - 0.22, ux, -hh + 0.058, 0, 0.004);
    }
    B.box(K, L - 0.24, 0.030, C_W - 0.22, 0, -hh + 0.128, 0, 0.004);   // floor pan

    // ---- corrugated flanks ---------------------------------------------------
    var wallLen = L - 0.20;
    var wy0 = -hh + 0.128, wy1 = hh - 0.104;
    var flank = corrugationLoop(wallLen, 0.298, 0.024, 0.011, dent, seed * 1.7);
    var flankGeo = extrudeY(flank, wy0, wy1, false);
    for (sz = -1; sz <= 1; sz += 2) {
      var m = makeM(0, 0, sz * (hw - 0.012), 0, sz > 0 ? 0 : Math.PI, 0);
      B.add(K, flankGeo, m);
    }

    // ---- blind end -----------------------------------------------------------
    var endLoop = corrugationLoop(C_W - 0.20, 0.268, 0.021, 0.010, dent * 0.6, seed * 2.9);
    var endGeo = extrudeY(endLoop, wy0, wy1, false);
    B.add(K, endGeo, makeM(-(hl - 0.012), 0, 0, 0, -Math.PI * 0.5, 0));

    // ---- roof ----------------------------------------------------------------
    // Transverse corrugation, and a real dome: 20 mm of camber over 2.4 m, which
    // is what stops standing water and what puts a soft highlight band down the
    // centreline of every container in a lamp cone.
    // 12 mm over a 148 mm pitch. The roof's pitch is half the flank's, so the
    // same depth would put its folds at 35 degrees where the flank's are at 24 -
    // and a container roof is the one surface in this level a lamp shines
    // straight down onto, so its rib contrast is the highest in the frame
    // wherever a camera gets above the stacks.
    var roofLoop = corrugationLoop(C_W - 0.16, 0.148, 0.012, 0.009, dent * 0.5, seed * 4.1);
    for (i = 0; i < roofLoop.length; i++) {
      var rz = roofLoop[i][0] / (C_W * 0.5);
      roofLoop[i][1] += (1 - rz * rz) * 0.022;
    }
    var roofGeo = extrudeY(roofLoop, -(L - 0.20) * 0.5, (L - 0.20) * 0.5, false);
    var roofM = new THREE.Matrix4();
    roofM.set(0, 1, 0, 0,
              0, 0, 1, hh - 0.012,
              1, 0, 0, 0,
              0, 0, 0, 1);
    B.add(K, roofGeo, roofM);

    // ---- twistlocks ----------------------------------------------------------
    // Two boxes meeting flush read as ONE extruded object. What actually
    // separates them in a real yard is the twistlock: a forged cone in each top
    // corner casting that holds the box above off by about 15 mm and throws a
    // hard shadow line all the way round the joint. Four small solids per
    // container, and the level's stacks stop being monoliths.
    for (sx = -1; sx <= 1; sx += 2) {
      for (sz = -1; sz <= 1; sz += 2) {
        var tx = sx * (hl - 0.089), tz = sz * (hw - 0.081);
        B.box(K, 0.112, 0.052, 0.100, tx, hh + 0.024, tz, 0.006);
        B.box(K, 0.070, 0.036, 0.062, tx, hh + 0.058, tz, 0.010);
        // the operating handle, folded down against the casting
        B.boxR(K, 0.026, 0.020, 0.145, tx + sx * 0.02, hh + 0.020, tz - sz * 0.075,
          0, 0, 0.30, 0.004);
      }
    }

    if (opts.reefer) buildReeferEnd(B, K, hl, hw, hh);
    else if (opts.openDoor) buildOpenDoorEnd(B, K, hl, hw, hh, seed);
    else buildDoorEnd(B, K, hl, hw, hh, seed);

    // ---- realise -------------------------------------------------------------
    var geo = Geo.mergeAll(B.buckets[K]);
    flankGeo.dispose(); endGeo.dispose(); roofGeo.dispose();
    Geo.worldUV(geo, SURF.container_steel.uv);
    // Shift each variant into a different region of the map so three variants
    // standing side by side never sample the same texels.
    var uvA = geo.attributes.uv;
    var ou = (seed * 0.37) % 1.0, ov = (seed * 0.71) % 1.0;
    for (i = 0; i < uvA.count; i++) uvA.setXY(i, uvA.getX(i) + ou, uvA.getY(i) + ov);
    Geo.copyUV1(geo);
    paintContainer(geo, hl, hw, hh, seed);
    geo.computeBoundingSphere();
    return geo;
  }

  // The cargo-door end. Four locking bars is the detail everybody leaves out,
  // and it is the one that makes the end of a container instantly recognisable.
  function buildDoorEnd(B, K, hl, hw, hh, seed) {
    var x = hl - 0.012;
    var leafW = hw - 0.085;
    var i, s;
    for (s = -1; s <= 1; s += 2) {
      var cz = s * (leafW * 0.5 + 0.022);
      // leaf skin: shallow vertical corrugation, outer face toward +X
      var loop = corrugationLoop(leafW, 0.238, 0.017, 0.009, 0.004, seed * 3.3 + s);
      var leaf = extrudeY(loop, -hh + 0.135, hh - 0.108, false);
      B.add(K, leaf, makeM(x, 0, cz, 0, Math.PI * 0.5, 0));
      // leaf frame: angle iron all the way round
      B.box(K, 0.048, C_H - 0.24, 0.052, x + 0.014, 0, cz - s * (leafW * 0.5 - 0.026), 0.004);
      B.box(K, 0.048, C_H - 0.24, 0.052, x + 0.014, 0, cz + s * (leafW * 0.5 - 0.026), 0.004);
      B.box(K, 0.048, 0.056, leafW - 0.02, x + 0.014, hh - 0.136, cz, 0.004);
      B.box(K, 0.048, 0.056, leafW - 0.02, x + 0.014, -hh + 0.162, cz, 0.004);

      // ---- locking bars: two per leaf -------------------------------------
      for (i = 0; i < 2; i++) {
        var bz = cz + s * (i === 0 ? -0.30 : 0.30);
        B.cyl(K, 0.017, 0.017, C_H - 0.40, x + 0.048, 0.01, bz, 0, 0, 0, 8);
        // cams top and bottom - the hooks that pull into the keepers
        B.box(K, 0.070, 0.052, 0.036, x + 0.052, hh - 0.226, bz, 0.006);
        B.box(K, 0.070, 0.052, 0.036, x + 0.052, -hh + 0.246, bz, 0.006);
        // cam keepers welded to the header and sill
        B.box(K, 0.052, 0.040, 0.070, x + 0.026, hh - 0.150, bz, 0.005);
        B.box(K, 0.052, 0.040, 0.070, x + 0.026, -hh + 0.176, bz, 0.005);
        // bar retainers
        B.box(K, 0.044, 0.026, 0.052, x + 0.038, 0.52, bz, 0.004);
        B.box(K, 0.044, 0.026, 0.052, x + 0.038, -0.52, bz, 0.004);
        // handle: a forged lever with its own retainer, sitting proud
        B.boxR(K, 0.030, 0.028, 0.290, x + 0.070, 0.06, bz + s * 0.10,
          0, 0, 0.16, 0.005);
        B.box(K, 0.036, 0.062, 0.044, x + 0.052, 0.06, bz + s * 0.235, 0.005);
      }
      // ---- hinges ----------------------------------------------------------
      for (i = 0; i < 5; i++) {
        var hy = -hh + 0.30 + i * (C_H - 0.60) / 4;
        var hz = cz + s * (leafW * 0.5 + 0.014);
        B.cyl(K, 0.026, 0.026, 0.105, x + 0.030, hy, hz, 0, 0, 0, 8);
        B.box(K, 0.056, 0.062, 0.048, x + 0.012, hy, hz - s * 0.030, 0.004);
      }
      // ---- gasket line ------------------------------------------------------
      B.box(K, 0.014, C_H - 0.26, 0.020, x + 0.038, 0, cz - s * (leafW * 0.5 + 0.008), 0.003);
    }
    // meeting-edge weather strip and the door retainer bar
    B.box(K, 0.026, C_H - 0.26, 0.044, hl + 0.030, 0, 0, 0.004);
    // placard holder on the right-hand leaf
    B.box(K, 0.012, 0.300, 0.300, hl + 0.030, 0.30, 0.62, 0.004);
    B.box(K, 0.020, 0.034, 0.320, hl + 0.032, 0.15, 0.62, 0.004);
  }

  // The same end with both leaves swung open. This is a COVER PIECE: the shell
  // is a closed loop (outer skin plus an inner skin offset by the wall
  // thickness) and the roof and blind end are the same, so an open box has a
  // real dark interior you can see into and run through, and the two leaves
  // standing out at 100 and 75 degrees are the only non-orthogonal verticals in
  // a yard otherwise built out of right angles.
  function buildOpenDoorEnd(B, K, hl, hw, hh, seed) {
    var x = hl - 0.012;
    var leafW = hw - 0.085;
    var s, i;
    // the door frame stays: header, sill and the two corner posts
    B.box(K, 0.060, 0.090, C_W - 0.18, x + 0.016, hh - 0.140, 0, 0.006);
    B.box(K, 0.060, 0.100, C_W - 0.18, x + 0.016, -hh + 0.168, 0, 0.006);
    for (s = -1; s <= 1; s += 2) {
      B.box(K, 0.060, C_H - 0.26, 0.070, x + 0.016, 0, s * (hw - 0.070), 0.006);
      // the keepers the cams used to drop into, now empty
      B.box(K, 0.050, 0.038, 0.066, x + 0.026, hh - 0.150, s * 0.36, 0.005);
      B.box(K, 0.050, 0.038, 0.066, x + 0.026, -hh + 0.176, s * 0.36, 0.005);
    }
    for (s = -1; s <= 1; s += 2) {
      var hz = s * (hw - 0.060);
      var open = s > 0 ? 1.74 : 1.31;                    // 100 and 75 degrees
      // hinge column
      for (i = 0; i < 5; i++) {
        B.cyl(K, 0.026, 0.026, 0.105, x + 0.030, -hh + 0.30 + i * (C_H - 0.60) / 4, hz,
          0, 0, 0, 8);
      }
      // everything below is authored in the leaf's own frame, hinged on the
      // corner post, so the swing is one number rather than a coordinate hunt
      B.pushXYZ(x + 0.030, 0, hz, 0, -s * open, 0);
      var loop = corrugationLoop(leafW, 0.238, 0.017, 0.009, 0.006, seed * 5.7 + s);
      var leaf = extrudeY(loop, -hh + 0.135, hh - 0.108, false);
      B.add(K, leaf, makeM(0, 0, -s * (leafW * 0.5 + 0.026), 0, Math.PI * 0.5, 0));
      B.box(K, 0.046, C_H - 0.24, 0.050, 0.014, 0, -s * 0.030, 0.004);
      B.box(K, 0.046, C_H - 0.24, 0.050, 0.014, 0, -s * (leafW + 0.018), 0.004);
      B.box(K, 0.046, 0.054, leafW - 0.02, 0.014, hh - 0.136, -s * (leafW * 0.5 + 0.026), 0.004);
      B.box(K, 0.046, 0.054, leafW - 0.02, 0.014, -hh + 0.162, -s * (leafW * 0.5 + 0.026), 0.004);
      for (i = 0; i < 2; i++) {
        var bz = -s * (0.34 + i * 0.56);
        B.cyl(K, 0.017, 0.017, C_H - 0.40, 0.048, 0.01, bz, 0, 0, 0, 8);
        B.box(K, 0.068, 0.050, 0.034, 0.052, hh - 0.226, bz, 0.006);
        B.box(K, 0.068, 0.050, 0.034, 0.052, -hh + 0.246, bz, 0.006);
        B.boxR(K, 0.030, 0.028, 0.280, 0.070, 0.06, bz - s * 0.10, 0, 0, 0.16, 0.005);
      }
      B.pop();
    }
  }

  // The reefer end: a machinery pack instead of doors. Grille, two fan throats,
  // a control panel and the power lead socket.
  function buildReeferEnd(B, K, hl, hw, hh) {
    var x = hl - 0.012;
    var i;
    // recessed machinery bay
    B.box(K, 0.10, C_H - 0.32, C_W - 0.26, x - 0.16, 0, 0, 0.006);
    // the surrounding frame
    B.box(K, 0.16, 0.14, C_W - 0.20, x - 0.06, hh - 0.20, 0, 0.006);
    B.box(K, 0.16, 0.16, C_W - 0.20, x - 0.06, -hh + 0.22, 0, 0.006);
    for (var s = -1; s <= 1; s += 2) {
      B.box(K, 0.16, C_H - 0.30, 0.14, x - 0.06, 0, s * (hw - 0.16), 0.006);
    }
    // condenser grille - horizontal louvres
    for (i = 0; i < 9; i++) {
      B.boxR(K, 0.030, 0.052, 1.55, x - 0.10, hh - 0.42 - i * 0.115, -0.28,
        0.42, 0, 0, 0.004);
    }
    // two fan throats
    for (i = 0; i < 2; i++) {
      var fz = -0.28 + (i === 0 ? -0.34 : 0.34) * 0.0;
      B.cyl(K, 0.24, 0.24, 0.075, x - 0.13, hh - 0.62 + i * -0.62, -0.28,
        0, 0, Math.PI * 0.5, 14);
      B.cyl(K, 0.19, 0.19, 0.06, x - 0.155, hh - 0.62 + i * -0.62, -0.28,
        0, 0, Math.PI * 0.5, 12);
      if (fz) { /* placement is symmetric, kept for readability */ }
    }
    // control panel and display
    B.box(K, 0.10, 0.34, 0.44, x - 0.09, hh - 0.55, 0.66, 0.006);
    B.box(K, 0.030, 0.16, 0.24, x - 0.032, hh - 0.53, 0.66, 0.004);
    // power lead socket and coiled lead
    B.box(K, 0.10, 0.20, 0.16, x - 0.10, -hh + 0.55, 0.72, 0.006);
  }

  // Neutral, per-vertex value wear baked into the shared container geometry.
  // NEUTRAL is the whole point: this multiplies with instanceColor, so anything
  // chromatic here would tint a blue container's rust blue. Chroma belongs in
  // the decal layer and in the per-instance colour.
  function paintContainer(geo, hl, hw, hh, seed) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = GAME.noise;
    for (var i = 0; i < N; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var ny = nrm.getY(i);
      var f = 1.06;
      // macro paint blotching and chalking - a container is never one value.
      // Deliberately RESTRAINED: container enamel is calibrated at ~7% linear
      // albedo, and the first pass stacked five multiplicative darkening terms
      // on top of that, which took a stack in an unlit canyon to literally no
      // signal. Weathering is a VARIATION on a dark surface, not a second
      // exposure stop.
      f *= 0.94 + (noise.fbm3(x * 0.42 + seed, y * 0.55, z * 0.42, 3) * 0.5 + 0.5) * 0.24;
      // Chalked, sun-and-salt-bleached top surfaces - but restrained, because
      // the roof is the one container surface a mast shines straight down onto
      // and a 1.20x lift on top of a full lambert term is what made the roofs
      // in the establishing shot read as bright orange corduroy.
      if (ny > 0.35) f *= 1.05 + M.saturate(ny) * 0.06;
      // splash and road film up the bottom 450 mm
      var low = M.smoothstep(-hh + 0.52, -hh + 0.02, y);
      f *= 1 - low * 0.26;
      // Dirt gathers in the corrugation valleys - but only just. The rib
      // contrast in this level was measured at 8:1 and this term was pushing in
      // the same direction as the shading error, so it now reads as silt in the
      // fold rather than as a second black stripe under the first.
      var vall = M.saturate((hw - 0.014 - Math.abs(z)) / 0.05);
      f *= 1 - vall * 0.030;
      // weeping from the corner castings and down the top rail welds: a
      // vertical, noise-broken darkening that starts at a fixing and fades out
      var wx = Math.abs(x) / hl;
      var streakPhase = noise.fbm2(x * 3.1 + seed * 7.0, seed * 3.0, 2) * 0.5 + 0.5;
      var down = M.saturate((hh - 0.12 - y) / 1.9);
      var weep = M.smoothstep(0.56, 0.94, streakPhase) * (1 - down * 0.55) *
        M.saturate(1 - Math.abs(ny) * 1.6);
      f *= 1 - weep * 0.30;
      // heavier at the ends, where the castings are
      var corner = M.smoothstep(0.80, 1.0, wx) * M.saturate(1 - Math.abs(ny) * 1.4);
      f *= 1 - corner * M.smoothstep(0.05, 0.85, 1 - down) * 0.18;
      col[i * 3] = f; col[i * 3 + 1] = f * 0.995; col[i * 3 + 2] = f * 0.985;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // ============================================== STENCIL / WEATHERING ATLAS ==
  // A 1024 px, 4 x 4 cell alpha atlas drawn at build time: owner marks, serial
  // blocks, the mandatory weight/CSC stencils, hazard placards, rust weeps,
  // graffiti, ship draft marks. It is the only way a per-container marking can
  // differ when the container mesh itself is instanced.
  //
  // Operator names are INVENTED. No real shipping line's name, livery or logo
  // appears anywhere in this level.
  var ATLAS_N = 4, ATLAS_PX = 1024, ATLAS_CELL = ATLAS_PX / ATLAS_N;
  var CELL = {
    OWNER_A: 0, OWNER_B: 1, OWNER_C: 2, OWNER_D: 3,
    SERIAL_A: 4, SERIAL_B: 5, SERIAL_C: 6, PLACARD: 7,
    WEEP_A: 8, WEEP_B: 9, TAG_A: 10, TAG_B: 11,
    DATA: 12, CSC: 13, DRAFT: 14, WARN: 15
  };
  var OPERATORS = [
    ['MERIDIAN LINE', 'MRDU'],
    ['KESTREL SHIPPING', 'KSLU'],
    ['NORTHGATE', 'NGTU'],
    ['ATLAS BOX', 'ATBU']
  ];

  function atlasRect(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    return [cx * ATLAS_CELL, cy * ATLAS_CELL];
  }
  function atlasUV(cell) {
    var cx = cell % ATLAS_N, cy = (cell / ATLAS_N) | 0;
    var s = 1 / ATLAS_N;
    // canvas y is flipped relative to uv
    return [cx * s, 1 - (cy + 1) * s, (cx + 1) * s, 1 - cy * s];
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
    var FONT = '"Arial Narrow", "Helvetica Neue", Impact, Haettenschweiler, sans-serif';
    var i, j, o;

    // Break a stencil up so it reads as paint that has been on a steel box in
    // salt air for fifteen years rather than as a vector logo.
    function erode(x0, y0, w, h, amount) {
      g.save();
      g.globalCompositeOperation = 'destination-out';
      for (var k = 0; k < amount; k++) {
        var rx = x0 + rng.range(0, w), ry = y0 + rng.range(0, h);
        var rr = rng.range(1.5, 9.0);
        g.globalAlpha = rng.range(0.20, 0.85);
        g.beginPath();
        g.arc(rx, ry, rr, 0, 6.2832);
        g.fill();
      }
      g.restore();
    }

    // NOTE: its own loop counter. `text` is called from inside loops that use
    // the enclosing `i`, and sharing it silently corrupted the caller.
    function text(cell, lines, col, sizes, weights) {
      var r = atlasRect(cell);
      var n;
      g.save();
      g.translate(r[0], r[1]);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      var total = 0;
      for (n = 0; n < lines.length; n++) total += sizes[n] * 1.28;
      var y = (S - total) * 0.5 + sizes[0] * 0.7;
      for (n = 0; n < lines.length; n++) {
        g.fillStyle = col;
        g.font = (weights && weights[n] ? weights[n] : '700') + ' ' + sizes[n] + 'px ' + FONT;
        // maxWidth is not optional here: a 16-character operator name at 40 px
        // in a condensed face measures ~320 px against a 256 px cell, and the
        // overflow bled into the neighbouring cell. The quay capture showed
        // "MRDU 418 227 2" rendered as "DU 418KS" with a fragment of the next
        // stencil welded onto it.
        g.fillText(lines[n], S * 0.5, y, S * 0.88);
        y += sizes[n] * 1.28;
      }
      g.restore();
      erode(r[0], r[1], S, S, 150);
    }

    // ---- owner marks --------------------------------------------------------
    for (i = 0; i < 4; i++) {
      o = OPERATORS[i];
      var r0 = atlasRect(CELL.OWNER_A + i);
      g.save();
      g.translate(r0[0], r0[1]);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(236,240,242,0.96)';
      var fs = o[0].length > 12 ? 40 : 52;
      g.font = '800 ' + fs + 'px ' + FONT;
      g.fillText(o[0], S * 0.5, S * 0.42, S * 0.90);
      // a house device: three chevrons, a bar, a diamond - abstract, invented
      g.strokeStyle = 'rgba(236,240,242,0.9)';
      g.lineWidth = 7;
      g.beginPath();
      if (i === 0) { for (j = 0; j < 3; j++) { g.moveTo(S * 0.32 + j * 26, S * 0.68); g.lineTo(S * 0.36 + j * 26, S * 0.60); g.lineTo(S * 0.40 + j * 26, S * 0.68); } }
      else if (i === 1) { g.moveTo(S * 0.34, S * 0.66); g.lineTo(S * 0.66, S * 0.66); g.moveTo(S * 0.40, S * 0.72); g.lineTo(S * 0.60, S * 0.72); }
      else if (i === 2) { g.moveTo(S * 0.5, S * 0.58); g.lineTo(S * 0.62, S * 0.67); g.lineTo(S * 0.5, S * 0.76); g.lineTo(S * 0.38, S * 0.67); g.closePath(); }
      else { g.arc(S * 0.5, S * 0.67, 26, 0, 6.2832); }
      g.stroke();
      g.restore();
      erode(r0[0], r0[1], S, S, 220);
    }

    // ---- serial blocks ------------------------------------------------------
    var serials = [
      [OPERATORS[0][1] + ' 418 227 2', '45 G 1'],
      [OPERATORS[1][1] + ' 220 913 7', '22 G 1'],
      [OPERATORS[2][1] + ' 704 118 3', '45 R 1']
    ];
    for (i = 0; i < 3; i++) {
      text(CELL.SERIAL_A + i, serials[i], 'rgba(232,236,238,0.95)', [58, 46]);
    }

    // ---- hazard placard -----------------------------------------------------
    (function () {
      var r = atlasRect(CELL.PLACARD);
      g.save();
      g.translate(r[0] + S * 0.5, r[1] + S * 0.5);
      g.rotate(Math.PI * 0.25);
      g.fillStyle = '#d8641c';
      g.fillRect(-S * 0.30, -S * 0.30, S * 0.60, S * 0.60);
      g.strokeStyle = '#12140f'; g.lineWidth = 8;
      g.strokeRect(-S * 0.27, -S * 0.27, S * 0.54, S * 0.54);
      g.rotate(-Math.PI * 0.25);
      g.fillStyle = '#12140f';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '800 42px ' + FONT;
      g.fillText('1263', 0, -S * 0.06);
      g.font = '800 34px ' + FONT;
      g.fillText('3', 0, S * 0.16);
      g.restore();
      erode(r[0], r[1], S, S, 70);
    })();

    // ---- rust weeps ---------------------------------------------------------
    // Drawn as broken vertical runs with a noisy alpha ramp: alpha-tested, that
    // cutoff produces the ragged, streaky edge real weeping has.
    for (i = 0; i < 2; i++) {
      var rr = atlasRect(CELL.WEEP_A + i);
      g.save();
      g.translate(rr[0], rr[1]);
      var runs = 9 + i * 5;
      for (j = 0; j < runs; j++) {
        var wx0 = rng.range(0.06, 0.94) * S;
        var wtop = rng.range(0.0, 0.14) * S;
        var wlen = rng.range(0.35, 0.98) * S;
        var ww = rng.range(3, 15);
        var steps = 26;
        for (var k = 0; k < steps; k++) {
          var t = k / steps;
          var a = (1 - t) * (1 - t) * rng.range(0.55, 1.0);
          var hue = 22 + rng.range(-8, 10);
          var lig = 26 + t * 12 + rng.range(-5, 6);
          g.fillStyle = 'hsla(' + hue + ',' + (52 + rng.range(-12, 12)) + '%,' + lig + '%,' + a.toFixed(3) + ')';
          var jx = wx0 + Math.sin(t * 7.1 + j) * 3.0 + rng.range(-1.4, 1.4);
          g.fillRect(jx, wtop + t * wlen, ww * (1 - t * 0.55), wlen / steps + 1.5);
        }
        // the bloom around the fixing the run started at
        g.fillStyle = 'rgba(120,62,28,0.55)';
        g.beginPath();
        g.arc(wx0 + ww * 0.5, wtop + 4, ww * rng.range(0.9, 1.9), 0, 6.2832);
        g.fill();
      }
      g.restore();
    }

    // ---- graffiti tags ------------------------------------------------------
    for (i = 0; i < 2; i++) {
      var rt = atlasRect(CELL.TAG_A + i);
      g.save();
      g.translate(rt[0], rt[1]);
      g.lineCap = 'round'; g.lineJoin = 'round';
      var cols = i === 0 ? ['#e8e2d0', '#3a6fb0'] : ['#c8d84a', '#b03a52'];
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = cols[pass];
        g.lineWidth = pass === 0 ? 22 : 9;
        g.globalAlpha = pass === 0 ? 0.92 : 0.85;
        g.beginPath();
        var px = S * 0.10, py = S * 0.62;
        g.moveTo(px, py);
        for (j = 0; j < 7; j++) {
          var nx = px + S * rng.range(0.08, 0.17);
          var ny = S * rng.range(0.24, 0.78);
          g.quadraticCurveTo(px + (nx - px) * 0.4, S * rng.range(0.16, 0.86), nx, ny);
          px = nx; py = ny;
        }
        g.stroke();
      }
      g.globalAlpha = 1;
      g.restore();
      erode(rt[0], rt[1], S, S, 60);
    }

    // ---- data / CSC / draft / warning ---------------------------------------
    text(CELL.DATA, ['MAX GROSS  30,480 KG', 'TARE  3,740 KG', 'NET  26,740 KG',
      'CUBE  67.7 CU M'], 'rgba(228,232,234,0.92)', [34, 30, 30, 28], ['700', '600', '600', '600']);
    text(CELL.CSC, ['CSC SAFETY APPROVAL', 'GB / 4821 / 09', 'ACEP  GB-1174',
      'NEXT EXAM  06 / 26'], 'rgba(210,216,214,0.88)', [30, 28, 26, 24],
      ['700', '600', '600', '600']);
    (function () {
      var r = atlasRect(CELL.DRAFT);
      g.save();
      g.translate(r[0], r[1]);
      g.fillStyle = 'rgba(236,238,236,0.95)';
      g.textAlign = 'left'; g.textBaseline = 'middle';
      for (i = 0; i < 6; i++) {
        g.font = '800 34px ' + FONT;
        g.fillText(String(10 - i) + 'M', S * 0.30, S * (0.10 + i * 0.16));
        g.fillRect(S * 0.16, S * (0.10 + i * 0.16) - 4, S * 0.10, 8);
      }
      g.restore();
      erode(r[0], r[1], S, S, 100);
    })();
    text(CELL.WARN, ['DO NOT', 'CLIMB', '───', 'NO STEP'],
      'rgba(226,206,120,0.92)', [42, 42, 20, 30]);

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // Place one atlas card. `n` is the outward normal axis ('x'|'z'), `s` its sign.
  function decalCard(B, cell, x, y, z, w, h, axis, s, tintC, roll) {
    var uv = atlasUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var ry = axis === 'x' ? (s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5)
                          : (s > 0 ? 0 : Math.PI);
    var old = B.tint;
    if (tintC) B.tint = tintC;
    B.add('decal', g, makeM(x, y, z, 0, ry, roll || 0));
    B.tint = old;
  }

  // ================================================================ THE YARD ==
  // A ribbon of painted line following the slab. Worn lane and slot markings
  // are the cheapest thing in the level and they do more for the sense of a
  // working terminal than any prop: they give the ground scale, direction and
  // a leading line straight to the quay.
  function stripe(B, x0, z0, x1, z1, w, N, dashLen, gapLen) {
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) return;
    var ux = dx / len, uz = dz / len;
    var px = -uz * w * 0.5, pz = ux * w * 0.5;
    var step = 0.9;
    var t = 0;
    var pos = [], nor = [];
    while (t < len) {
      if (dashLen) {
        var cyc = dashLen + gapLen;
        var ph = t % cyc;
        if (ph > dashLen) { t += step; continue; }
      }
      var t1 = Math.min(t + step, len);
      var ax = x0 + ux * t, az = z0 + uz * t;
      var bx = x0 + ux * t1, bz = z0 + uz * t1;
      var q = [
        [ax + px, az + pz], [ax - px, az - pz], [bx - px, bz - pz], [bx + px, bz + pz]
      ];
      var ys = [];
      for (var i = 0; i < 4; i++) ys.push(apronY(q[i][0], q[i][1], N) + 0.009);
      pos.push(q[0][0], ys[0], q[0][1], q[1][0], ys[1], q[1][1], q[2][0], ys[2], q[2][1]);
      pos.push(q[0][0], ys[0], q[0][1], q[2][0], ys[2], q[2][1], q[3][0], ys[3], q[3][1]);
      for (i = 0; i < 6; i++) nor.push(0, 1, 0);
      t = t1;
    }
    if (!pos.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    B.add('painted_line', g, null);
  }

  function buildApron(L, B, rng, N) {
    var i, j;
    // ---- the slab -----------------------------------------------------------
    B.paint = 'apron';
    var slab = gridSurface(WEST_X - 3, EAST_X + 3, QUAY_Z, SOUTH_Z + 4, 1.25,
      function (x, z) { return apronY(x, z, N); });
    B.add('wet_concrete', slab, null);
    B.paint = 'metal';

    // A floor collider per 12 m tile keeps the capsule solve local and the
    // sweep cheap; the slab only varies by ~0.3 m so a flat plate per tile is
    // within a couple of centimetres of the mesh everywhere.
    for (i = 0; i < 8; i++) {
      for (j = 0; j < 6; j++) {
        var cx = WEST_X + 6 + i * 11.5;
        var cz = QUAY_Z + 6 + j * 11.5;
        var yy = apronY(cx, cz, N);
        L.addCollider(cx, yy - 0.6, cz, 5.9, 0.6, 5.9, 'concrete', true);
      }
    }

    // ---- painted markings ---------------------------------------------------
    B.paint = 'line';
    // lane edges either side of the central apron lane, running to the quay
    stripe(B, -LANE_HALF - 0.6, SOUTH_Z - 2, -LANE_HALF - 0.6, QUAY_Z + 1.5, 0.16, N);
    stripe(B, LANE_HALF + 0.6, SOUTH_Z - 2, LANE_HALF + 0.6, QUAY_Z + 1.5, 0.16, N);
    // centre dashes down the lane - the leading line from the spawn
    stripe(B, 0, SOUTH_Z - 3, 0, QUAY_Z + 3, 0.14, N, 2.4, 2.4);
    // quay keep-clear hatching
    for (i = 0; i < 26; i++) {
      var hx = -40 + i * 3.2;
      stripe(B, hx, QUAY_Z + 1.2, hx + 2.0, QUAY_Z + 4.4, 0.13, N);
    }
    stripe(B, WEST_X + 2, QUAY_Z + 4.6, EAST_X - 2, QUAY_Z + 4.6, 0.20, N);
    // slot markings under the west rows (they run N-S) ...
    var wrows = L.rowsW;
    for (i = 0; i < wrows.length; i++) {
      stripe(B, wrows[i] - 1.36, -25.2, wrows[i] - 1.36, 13.6, 0.10, N);
      stripe(B, wrows[i] + 1.36, -25.2, wrows[i] + 1.36, 13.6, 0.10, N);
    }
    // ... and across the east rows (they run E-W)
    var erows = L.rowsE;
    for (i = 0; i < erows.length; i++) {
      stripe(B, 15.2, erows[i] - 1.36, 41.0, erows[i] - 1.36, 0.10, N);
      stripe(B, 15.2, erows[i] + 1.36, 41.0, erows[i] + 1.36, 0.10, N);
    }
    // bay numbers as short cross ticks
    for (i = 0; i < 12; i++) {
      stripe(B, -44 + i * 2.4, 15.6, -44 + i * 2.4, 16.4, 0.12, N);
    }

    // ---- crane rail safety zone ---------------------------------------------
    // A hatched exclusion strip either side of each rail. These are the two
    // strongest horizontal lines in the yard, they run dead across the
    // player's approach, and they are the reason the crane reads as a machine
    // ON RAILS rather than as scenery bolted to the ground.
    var railZ = [CR_RAIL_A, CR_RAIL_B];
    for (i = 0; i < railZ.length; i++) {
      var rz0 = railZ[i];
      stripe(B, WEST_X + 2, rz0 - 1.45, EAST_X - 2, rz0 - 1.45, 0.15, N);
      stripe(B, WEST_X + 2, rz0 + 1.45, EAST_X - 2, rz0 + 1.45, 0.15, N);
      for (j = 0; j < 30; j++) {
        var chx = WEST_X + 2 + j * 3.0;
        if (chx > EAST_X - 3) break;
        stripe(B, chx, rz0 - 1.42, chx + 1.5, rz0 + 1.42, 0.12, N);
      }
    }

    // ---- the pedestrian route -----------------------------------------------
    // From the gate, up the east side of the lane, across to the shed. A
    // marked walkway is the one line in a terminal that is drawn for a HUMAN,
    // and it is the leading line the spawn framing and the crane framing both
    // stand on.
    var walk = [[4.6, SOUTH_Z - 1.5], [4.6, 17.0], [8.2, 14.0], [8.2, -2.0],
                [11.5, -6.0], [11.5, -21.0]];
    for (i = 0; i + 1 < walk.length; i++) {
      var wx0 = walk[i][0], wz0 = walk[i][1], wx1 = walk[i + 1][0], wz1 = walk[i + 1][1];
      var wdx = wx1 - wx0, wdz = wz1 - wz0;
      var wl2 = Math.sqrt(wdx * wdx + wdz * wdz) || 1;
      var nx2 = -wdz / wl2 * 0.62, nz2 = wdx / wl2 * 0.62;
      stripe(B, wx0 + nx2, wz0 + nz2, wx1 + nx2, wz1 + nz2, 0.13, N);
      stripe(B, wx0 - nx2, wz0 - nz2, wx1 - nx2, wz1 - nz2, 0.13, N);
      // rungs, so it reads as a walkway rather than as two more lane lines
      var rung = Math.max(1, Math.round(wl2 / 1.7));
      for (j = 0; j <= rung; j++) {
        var tt = j / rung;
        var rx = wx0 + wdx * tt, rz2 = wz0 + wdz * tt;
        stripe(B, rx + nx2, rz2 + nz2, rx - nx2, rz2 - nz2, 0.09, N);
      }
    }

    // ---- keep-clear chevrons off the shed doors ------------------------------
    for (i = 0; i < 7; i++) {
      var cz3 = 17.4 + i * 1.55;
      stripe(B, WH_X0 - 0.6, cz3, WH_X0 - 4.4, cz3 + 1.6, 0.13, N);
    }
    // and the hazard box round the toppled container, painted after the fact
    var hb = [[-13.5, -3.6], [-1.0, -3.6], [-1.0, 8.6], [-13.5, 8.6]];
    for (i = 0; i < 4; i++) {
      var a2 = hb[i], b2 = hb[(i + 1) % 4];
      stripe(B, a2[0], a2[1], b2[0], b2[1], 0.14, N, 1.1, 1.1);
    }
    B.paint = 'metal';

    // ---- drainage channels, grated ------------------------------------------
    B.paint = 'grate';
    var chans = [[-22.0, 'z'], [-1.5, 'z'], [19.5, 'z']];
    for (i = 0; i < chans.length; i++) {
      var cz2 = chans[i][0];
      for (j = 0; j < 30; j++) {
        var gx = WEST_X + 1.5 + j * 3.05;
        if (gx > EAST_X - 1.5) break;
        // grating only over part of each run; the rest is an open dished channel
        if ((j % 4) === 3) continue;
        B.box('steel_grate', 2.9, 0.05, 0.72, gx, apronY(gx, cz2, N) + 0.055, cz2, 0.008);
        B.box('steel_grate', 2.9, 0.10, 0.06, gx, apronY(gx, cz2, N) - 0.01, cz2 - 0.36, 0.005);
        B.box('steel_grate', 2.9, 0.10, 0.06, gx, apronY(gx, cz2, N) - 0.01, cz2 + 0.36, 0.005);
      }
    }
    // gully pots
    for (i = 0; i < 10; i++) {
      var px2 = -40 + i * 9.0;
      B.box('steel_grate', 0.62, 0.06, 0.62, px2, apronY(px2, -1.5, N) + 0.045, -1.5, 0.008);
    }
    B.paint = 'metal';

    // ---- crane rails ---------------------------------------------------------
    // Two 24 m gauge rails set in a continuous concrete beam. They are the
    // strongest horizontal lines in the yard and they run dead across the
    // player's approach, which is exactly what makes the crane read as a
    // machine on rails rather than as scenery.
    var railProf = [[-0.075, 0], [0.075, 0], [0.075, 0.055], [0.030, 0.075],
                    [0.030, 0.135], [0.075, 0.155], [0.075, 0.195],
                    [-0.075, 0.195], [-0.075, 0.155], [-0.030, 0.135],
                    [-0.030, 0.075], [-0.075, 0.055]];
    var rails = [CR_RAIL_A, CR_RAIL_B];
    for (i = 0; i < rails.length; i++) {
      var rz = rails[i];
      B.paint = 'quay';
      B.box('dock_concrete', EAST_X - WEST_X + 6, 0.42, 1.70, 0, -0.16, rz, 0.02);
      B.paint = 'metal';
      var rg = extrudeZ(railProf, EAST_X - WEST_X + 6);
      B.add('deck_plate', rg, makeM(0, 0.05, rz, 0, Math.PI * 0.5, 0));
      // rail clips
      for (j = 0; j < 60; j++) {
        var kx = WEST_X - 2 + j * 1.6;
        if (kx > EAST_X + 2) break;
        B.box('deck_plate', 0.10, 0.07, 0.30, kx, 0.075, rz, 0.008);
      }
    }

    // ---- saw-cut construction joints ------------------------------------------
    // Laid as ribbons that follow the slab, exactly like the painted markings,
    // because a 15 cm feature cannot be resolved by a 1.25 m height field and
    // a 0.3 m height field would be 70k quads. Segments under a container or a
    // building are skipped: a joint nobody will ever see is 40 triangles spent
    // on nothing.
    B.paint = 'joint';
    for (i = -8; i <= 8; i++) {
      var jz2 = i * JOINT_PITCH - 1.75;
      if (jz2 < QUAY_Z + 0.6 || jz2 > SOUTH_Z + 1) continue;
      jointRun(L, B, WEST_X - 1, jz2, EAST_X + 1, jz2, N);
    }
    for (i = -8; i <= 8; i++) {
      var jx2 = i * JOINT_PITCH - 3.05;
      if (jx2 < WEST_X - 1 || jx2 > EAST_X + 1) continue;
      jointRun(L, B, jx2, QUAY_Z + 0.6, jx2, SOUTH_Z + 1, N);
    }
    B.paint = 'metal';

    // ---- puddles -------------------------------------------------------------
    // Placed where the slab has genuinely sunk below its own surroundings, and
    // sized by how far that depression actually extends. Never painted onto
    // flat ground, and never onto ground a container is standing on.
    B.paint = 'water';
    var found = 0;
    for (var sz = QUAY_Z + 2; sz < SOUTH_Z - 1 && found < 38; sz += 2.1) {
      for (var sx = WEST_X + 2; sx < EAST_X - 2 && found < 38; sx += 2.1) {
        var jx = sx + rng.range(-0.8, 0.8), jz = sz + rng.range(-0.8, 0.8);
        var dep = waterDepth(jx, jz, N);
        if (dep < 0.006) continue;
        // reject anything a container or a building is standing on
        if (L._occupied(jx, jz, 1.6)) continue;
        var wl = waterY(jx, jz, N);
        // Grow until the rim comes up out of the water. Six of the eight
        // probes, not all eight: a real puddle is a lobed thing that runs out
        // along the slab's fall, and demanding a circular basin rejected almost
        // every genuine depression in the yard.
        var r = 0.7;
        while (r < 4.2) {
          var wet8 = 0;
          for (var a = 0; a < 8; a++) {
            var ang = a * 0.7854;
            if (waterDepth(jx + Math.cos(ang) * r, jz + Math.sin(ang) * r, N) > -0.004) wet8++;
          }
          if (wet8 < 6) break;
          r += 0.35;
        }
        if (r < 0.95) continue;
        var disc = blobDisc(rng, r * 1.12, rng.range(0.78, 1.18), 0.24);
        B.add('wet_concrete', disc, makeM(jx, wl + 0.004, jz, 0, rng.range(0, 6.28), 0));
        L.wetPatches.push({ x: jx, z: jz, r: r, y: wl });
        found++;
      }
    }
    B.paint = 'metal';
  }

  // A joint ribbon. Narrower and denser than a painted stripe, dropped a few
  // millimetres so the sealant sits proud of nothing and the line reads as a
  // cut rather than as tape.
  function jointRun(L, B, x0, z0, x1, z1, N) {
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.5) return;
    var ux = dx / len, uz = dz / len;
    var w = 0.085;
    var px = -uz * w, pz = ux * w;
    var pos = [], nor = [];
    var step = 1.6, t = 0;
    while (t < len) {
      var t1 = Math.min(t + step, len);
      var mx = x0 + ux * (t + t1) * 0.5, mz = z0 + uz * (t + t1) * 0.5;
      if (L._occupied(mx, mz, -0.35)) { t = t1; continue; }
      var ax = x0 + ux * t, az = z0 + uz * t;
      var bx = x0 + ux * t1, bz = z0 + uz * t1;
      var q = [[ax + px, az + pz], [ax - px, az - pz], [bx - px, bz - pz], [bx + px, bz + pz]];
      var ys = [], i;
      for (i = 0; i < 4; i++) ys.push(apronY(q[i][0], q[i][1], N) + 0.006);
      pos.push(q[0][0], ys[0], q[0][1], q[1][0], ys[1], q[1][1], q[2][0], ys[2], q[2][1]);
      pos.push(q[0][0], ys[0], q[0][1], q[2][0], ys[2], q[2][1], q[3][0], ys[3], q[3][1]);
      for (i = 0; i < 6; i++) nor.push(0, 1, 0);
      t = t1;
    }
    if (!pos.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    B.add('wet_concrete', g, null);
  }

  // ================================================================= THE SEA ==
  // ---------------------------------------------------------------------------
  // Two sheets, and the split buys the whole effect. The basin the camera can
  // actually reach - out to 50 m beyond the quay - is meshed at 2.2 m so a
  // Gerstner crest has something to sharpen against; everything past that is a
  // 12 m sheet, because at 80 m all it has to do is not end.
  //
  // The previous water was three sines totalling 18 cm of peak amplitude, in a
  // storm that is bending the rain 12 degrees off vertical. In `quay` and
  // `gangway` it was visually indistinguishable from wet concrete, which loses
  // the entire quay-edge premise: black water beyond the coping is one of this
  // level's two big spatial statements and it was reading as more apron.
  // ---------------------------------------------------------------------------
  function seaSheet(L, x0, x1, z0, z1, step, N, near) {
    var g = gridSurface(x0, x1, z0, z1, step, function (x, z) {
      return WATER_Y + N.fbm2(x * 0.045, z * 0.045, 2) * 0.10 +
        N.fbm2(x * 0.16 + 4, z * 0.16 - 2, 2) * 0.035;
    }, true);
    var mesh = new THREE.Mesh(g, L.material('sea_water', false));
    // The swell is animated in update(); keep the base positions so the water
    // is never a mirror-flat plate, which is the one thing that instantly
    // reads as "a plane with a shiny material on it".
    var base = new Float32Array(g.attributes.position.array);
    var n = g.attributes.position.count;
    var col = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var d = M.saturate((-g.attributes.position.getZ(i) - 30) / 90);
      var f = 1 - d * 0.28;
      col[i * 3] = f * 0.94; col[i * 3 + 1] = f * 1.0; col[i * 3 + 2] = f * 1.06;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    Geo.worldUV(g, SURF.sea_water.uv); Geo.copyUV1(g);
    mesh.name = near ? 'harbor_sea' : 'harbor_sea_far';
    mesh.receiveShadow = false; mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    L.root.add(mesh);
    L.meshes.push(mesh);
    return { mesh: mesh, geo: g, base: base, col: col, near: !!near };
  }

  function buildSea(L, B, rng, N) {
    B.paint = 'water';
    L._waters = [
      seaSheet(L, -112, 112, -82, QUAY_Z + 0.4, 2.2, N, true),
      seaSheet(L, -175, 175, -195, -82, 12.0, N, false)
    ];
    L._water = L._waters[0];
    // Published so weather.js can splash on the basin rather than guessing at
    // where the water is. The contract puts rain impacts in its court.
    L.waterPlane = {
      y: WATER_Y, x0: -112, x1: 112, z0: -195, z1: QUAY_Z + 0.4,
      quayZ: QUAY_Z - 0.55
    };
    B.paint = 'metal';
  }

  // ========================================================== THE QUAY EDGE ==
  function buildQuayEdge(L, B, rng, N) {
    var i;
    B.paint = 'quay';
    // quay wall down to the water, and the coping beam along its lip
    B.box('dock_concrete', EAST_X - WEST_X + 10, 4.2, 0.55, 0, -2.05, QUAY_Z - 0.28, 0.03);
    B.box('dock_concrete', EAST_X - WEST_X + 10, 0.34, 1.05, 0, -0.10, QUAY_Z + 0.30, 0.03);
    // the coping is cast in 3 m units; the joints are the only thing that gives
    // an 92 m straight edge any scale at all
    for (i = 0; i < 32; i++) {
      var jx = WEST_X - 3 + i * 3.05;
      B.box('dock_concrete', 0.045, 0.30, 1.02, jx, -0.09, QUAY_Z + 0.30, 0.006);
    }
    L.addCollider(0, -2.05, QUAY_Z - 0.28, (EAST_X - WEST_X) * 0.5 + 5, 2.1, 0.30, 'concrete');
    B.paint = 'metal';

    // ---- bollards ------------------------------------------------------------
    var bx = [-38, -26, -14, -2, 10, 22, 34];
    L.bollards = [];
    for (i = 0; i < bx.length; i++) {
      var x = bx[i], z = QUAY_Z + 1.15;
      var by = apronY(x, z, N);
      B.pushXYZ(x, by, z, 0, rng.range(-0.05, 0.05), 0);
      B.cyl('deck_plate', 0.40, 0.44, 0.10, 0, 0.05, 0, 0, 0, 0, 12);
      B.cyl('deck_plate', 0.20, 0.27, 0.62, 0, 0.40, 0, 0, 0, 0, 12);
      B.cyl('deck_plate', 0.31, 0.24, 0.16, 0, 0.78, 0, 0, 0, 0, 12);
      B.cyl('deck_plate', 0.22, 0.29, 0.09, 0, 0.90, 0, 0, 0, 0, 12);
      // holding-down bolts
      for (var b = 0; b < 4; b++) {
        var ba = b * 1.5708 + 0.7854;
        B.cyl('deck_plate', 0.035, 0.035, 0.06, Math.cos(ba) * 0.33, 0.11, Math.sin(ba) * 0.33,
          0, 0, 0, 6);
      }
      B.pop();
      L.bollards.push(new THREE.Vector3(x, by + 0.82, z));
      L.addCollider(x, by + 0.45, z, 0.34, 0.45, 0.34, 'metal');
    }

    // ---- chain rail between the bollards ------------------------------------
    for (i = 0; i < bx.length - 1; i++) {
      var ax = bx[i], bx2 = bx[i + 1];
      var n = Math.max(2, Math.round((bx2 - ax) / 3.0));
      var posts = [];
      for (var p = 0; p <= n; p++) {
        var px = ax + (bx2 - ax) * p / n;
        var py = apronY(px, QUAY_Z + 0.95, N);
        posts.push([px, py]);
        if (p > 0 && p < n) {
          B.cyl('deck_plate', 0.045, 0.055, 0.95, px, py + 0.475, QUAY_Z + 0.95, 0, 0, 0, 8);
          B.cyl('deck_plate', 0.075, 0.075, 0.05, px, py + 0.94, QUAY_Z + 0.95, 0, 0, 0, 8);
        }
      }
      for (p = 0; p < n; p++) {
        catenary(B, 'deck_plate', posts[p][0], posts[p][1] + 0.86, QUAY_Z + 0.95,
          posts[p + 1][0], posts[p + 1][1] + 0.86, QUAY_Z + 0.95, 0.16, 0.022, 5);
      }
    }

    // ---- fenders hung on the quay face --------------------------------------
    for (i = 0; i < 13; i++) {
      var fx = -42 + i * 7.0;
      B.cyl('rubber_fender', 0.36, 0.36, 1.9, fx, -1.05, QUAY_Z - 0.62,
        0, 0, Math.PI * 0.5, 12);
      B.cyl('rubber_fender', 0.20, 0.20, 1.94, fx, -1.05, QUAY_Z - 0.62,
        0, 0, Math.PI * 0.5, 10);
      // hanging chains
      catenary(B, 'deck_plate', fx - 0.8, -0.22, QUAY_Z - 0.30, fx - 0.8, -1.05, QUAY_Z - 0.44,
        0.10, 0.020, 4);
      catenary(B, 'deck_plate', fx + 0.8, -0.22, QUAY_Z - 0.30, fx + 0.8, -1.05, QUAY_Z - 0.44,
        0.10, 0.020, 4);
    }

    // ---- quay ladders --------------------------------------------------------
    for (i = 0; i < 2; i++) {
      var lx = i === 0 ? -20 : 18;
      B.paint = 'quay';
      B.box('dock_concrete', 0.90, 3.0, 0.34, lx, -1.55, QUAY_Z - 0.44, 0.02);
      B.paint = 'metal';
      for (var s = -1; s <= 1; s += 2) {
        B.cyl('deck_plate', 0.030, 0.030, 3.0, lx + s * 0.24, -1.35, QUAY_Z - 0.30, 0, 0, 0, 6);
      }
      for (var r = 0; r < 10; r++) {
        B.cyl('deck_plate', 0.022, 0.022, 0.48, lx, -2.75 + r * 0.31, QUAY_Z - 0.30,
          0, 0, Math.PI * 0.5, 6);
      }
    }
  }

  // ========================================================= THE CONTAINERS ==
  // Placement. Rows, groups, corridors, deliberate holes and deliberate
  // staircases: the container field has to be a space to FIGHT in, so it is
  // authored as corridors with cover, dead ends, gaps you can cut through and
  // stacks you can actually get on top of - not as a random scatter.
  // ---------------------------------------------------------------------------
  // LANE WIDTH CARRIES TACTICAL INFORMATION, so it is not one number.
  //
  // The first layout was eight rows on a single 6.24 m pitch: every corridor in
  // the terminal was exactly 3.80 m, four times over, against 4-high walls that
  // are 10.36 m. That is 1:2.7 - a SLOT, not a lane - and a player in one can
  // only go forward or back. It also failed "perfectly straight, perfectly
  // uniform anything" on the instant-fail list outright: every bay landed on
  // the same three lines, so each canyon wall was a dead-flat plane for 38 m.
  //
  // Now: a 6.10 m reach-stacker lane through the middle of the block (the hero
  // canyon, and the one the `containers` framing looks down), a 3.80 m slot
  // kept deliberately as a dead end on the far side, per-row bay stagger of
  // +/-1.25 m so the ends of the stacks break the wall plane, two authored
  // cross-cuts through row pairs for flanking, and heights that vary WITHIN a
  // row so the skyline is broken at 12 m rather than being one flat top per row.
  //
  //   rows 0,1,2  | 3.80 m dead-end slot | rows 3,4 | 6.10 m HERO | rows 5,6,7
  // ---------------------------------------------------------------------------
  var ROWS_W = [-44.40, -41.78, -39.16, -32.92, -30.30, -21.76, -19.14, -16.52];
  var BAYS_W = [-18.40, -5.86, 6.68];
  // per row, per bay: how far this stack is pushed along its own row. Nothing
  // here is larger than the 0.35 m working gap a straddle carrier needs, and
  // every one of them shows up as a broken corner in a 38 m wall.
  var BAYOFF_W = [
    [0.00, 0.95, -0.75],
    [-1.15, 0.30, 1.05],
    [0.60, -0.95, 0.35],
    [1.25, 0.00, -1.20],
    [-0.70, 1.10, 0.55],
    [0.35, -1.25, -0.45],
    [-1.00, 0.65, 1.20],
    [0.90, -0.55, -0.85]
  ];
  var ROWS_E = [-16.60, -13.98, -6.10, -3.48, 2.76, 5.38, 11.62];
  var BAYS_E = [21.60, 34.20];
  var BAYOFF_E = [
    [0.80, -0.55], [-0.95, 0.70], [0.45, 1.05], [-1.10, -0.35],
    [0.90, 0.25], [-0.40, -1.05], [1.05, 0.60]
  ];

  // Stack heights are AUTHORED, not rolled. A canyon whose two walls happen to
  // come up one-high is not a canyon, and the `containers` framing is the shot
  // this level exists for - it cannot be left to a die. 0 = a deliberate hole:
  // rows 3 and 4 share one at bay 1 and rows 5 and 6 share one at bay 0, and
  // those two holes ARE the cross-corridors - each cuts clean through a row
  // pair, so the hero canyon has a flanking route out of it at two different
  // depths instead of being a 38 m tube with two ends.
  //                bay:  -18.4  -5.86   6.68
  var HEIGHT_W = [
    /* -44.40 */ [4, 4, 3],
    /* -41.78 */ [3, 4, 2],
    /* -39.16 */ [2, 0, 3],
    /* -32.92 */ [4, 0, 2],   // cross-cut, west half
    /* -30.30 */ [3, 0, 4],   // cross-cut, west half - west wall of the hero canyon
    /* -21.76 */ [0, 3, 4],   // cross-cut, east half - east wall of the hero canyon
    /* -19.14 */ [0, 3, 2],   // cross-cut, east half
    /* -16.52 */ [1, 2, 3]    // the climbable staircase up the block's east face
  ];
  var HEIGHT_E = [
    /* -16.60 */ [3, 3],
    /* -13.98 */ [2, 4],
    /*  -6.10 */ [4, 2],
    /*  -3.48 */ [3, 0],
    /*   2.76 */ [2, 3],
    /*   5.38 */ [0, 4],
    /*  11.62 */ [3, 2]
  ];
  // A 20 ft box landed on the top tier of a 40 ft stack, at one end. Six metres
  // of resolution on the skyline instead of twelve, for one extra instance.
  // Only ever on a bay of 3 or more, and never on rows 3 and 4 or on bay 0 of
  // rows 1 and 3: those four cells all sit on the establishing shot's stand or
  // straight down its sightline, and a cap takes a stack from 10.36 m to
  // 12.95 m - i.e. from just under a camera standing on a four-high roof to
  // just over it. Measured the hard way.
  var CAP20_W = [
    [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0],
    [0, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1]
  ];

  function planContainers(L, rng) {
    var stacks = [];
    var i, j, h;
    // West block: rows run north-south, so the corridors between them are the
    // canyons the `containers` framing looks straight down.
    for (i = 0; i < ROWS_W.length; i++) {
      for (j = 0; j < BAYS_W.length; j++) {
        h = HEIGHT_W[i][j];
        if (!h) continue;
        stacks.push({ x: ROWS_W[i], z: BAYS_W[j] + BAYOFF_W[i][j],
                      yaw: Math.PI * 0.5 + rng.range(-0.055, 0.055),
                      n: h, len: C40_L, row: i, bay: j, side: 'W',
                      cap20: (h >= 3 && CAP20_W[i][j]) ? CAP20_W[i][j] : 0 });
      }
    }
    // East block: rows run east-west - a completely different read, cross
    // sightlines, and it gives the yard two kinds of space instead of one.
    for (i = 0; i < ROWS_E.length; i++) {
      for (j = 0; j < BAYS_E.length; j++) {
        h = HEIGHT_E[i][j];
        if (!h) continue;
        stacks.push({ x: BAYS_E[j] + BAYOFF_E[i][j], z: ROWS_E[i],
                      yaw: rng.range(-0.055, 0.055),
                      n: h, len: C40_L, row: i, bay: j, side: 'E',
                      cap20: (h >= 3 && ((i + j) & 1)) ? ((i & 1) ? 1 : -1) : 0 });
      }
    }
    // 20 ft boxes squeezed into the ends of the lanes: an odd module in a field
    // of 40 ft ones is what tells the eye the yard is real
    // NOTE: nothing stands in corridor B (x -27.88 .. -24.08). That corridor is
    // the `containers` framing and the first pass parked a two-high 20 ft box
    // 6 m up it, which turned a canyon into a dead end at point blank range.
    // The single 20 ft at its far mouth is deliberate - it terminates the
    // vanishing point without closing it.
    var shorts = [
      [-36.04, 11.5, Math.PI * 0.5, 2, 0], [-26.03, -26.4, Math.PI * 0.5, 1, 0],
      [16.8, -20.4, 0.06, 2, 0], [-3.0, 15.4, 0.0, 2, 0],
      [4.2, 30.2, 0.22, 1, 0], [9.6, 21.0, -0.14, 3, 0],
      // Two boxes standing off the block's south face, flanking the mouth of
      // the hero corridor 5 m from the `containers` eye. Without them that
      // framing's near ground is empty and the canyon walls start at 8.7 m -
      // a composition with no foreground at all.
      [-31.5, 15.6, 0.42, 1, 0], [-20.6, 15.1, -0.30, 1, 0],
      // ---- MID-LANE COVER IN THE HERO CANYON --------------------------------
      // The corridor is 6.10 m wide and 38 m long, and before this it had two
      // oil drums in it. These are on a 9-11 m rhythm down the west side, so a
      // player crossing it always has a next piece of cover and never a clean
      // 38 m sightline. `open` is a box with both leaves swung back: a real
      // shell you can duck through, and the only non-orthogonal vertical in the
      // whole block.
      // yaw -PI/2 on the open ones so the door end faces SOUTH, i.e. back down
      // the corridor at the approach and at the `containers` eye
      [-27.6, 8.4, -Math.PI * 0.5 + 0.10, 1, 1],
      [-24.4, -2.6, Math.PI * 0.5 - 0.22, 1, 0],
      [-27.9, -13.8, -Math.PI * 0.5 + 0.16, 2, 1],
      // and two in the east block's wide lane, for the same reason
      [27.4, -10.0, 0.12, 1, 1], [27.9, 1.4, -0.09, 2, 0]
    ];
    for (i = 0; i < shorts.length; i++) {
      stacks.push({ x: shorts[i][0], z: shorts[i][1], yaw: shorts[i][2], n: shorts[i][3],
                    len: C20_L, row: -1, bay: -1, side: 'S', open: !!shorts[i][4] });
    }
    // A pair of stacks standing in the open lane: cover on the approach, and a
    // strong near-foreground mass for the crane and overview framings.
    stacks.push({ x: -7.6, z: 17.4, yaw: 0.04, n: 2, len: C40_L, row: -1, bay: -1, side: 'L' });
    stacks.push({ x: 6.4, z: -12.6, yaw: -0.03, n: 3, len: C40_L, row: -1, bay: -1, side: 'L' });
    stacks.push({ x: -9.8, z: -21.0, yaw: 0.02, n: 1, len: C40_L, row: -1, bay: -1, side: 'L' });
    return stacks;
  }

  // ---------------------------------------------------------------------------
  // YARD FURNITURE. Not clutter - COVER, on the rhythm the corridors need, plus
  // the one thing a stack of containers cannot give a frame: an object smaller
  // than a person's height standing next to something twelve metres long.
  // ---------------------------------------------------------------------------
  function twistlockBin(B, L, x, y, z, yaw, rng) {
    B.pushXYZ(x, y, z, 0, yaw, 0);
    var K = 'deck_plate', i, s;
    // an open mesh stillage on skids
    for (s = -1; s <= 1; s += 2) {
      B.box(K, 1.24, 0.10, 0.14, 0, 0.06, s * 0.44, 0.010);
      B.box(K, 0.10, 0.86, 0.10, s * 0.57, 0.49, -0.44, 0.008);
      B.box(K, 0.10, 0.86, 0.10, s * 0.57, 0.49, 0.44, 0.008);
    }
    B.box(K, 1.30, 0.07, 1.02, 0, 0.16, 0, 0.010);
    // welded bar sides, not mesh: a chain-link panel is an alpha-cut surface
    // whose UVs come from its own quad, and a bevelled BOX carrying that
    // material stretches one cell of the weave across the whole face.
    for (i = 0; i < 4; i++) {
      B.box(K, 1.24, 0.022, 0.022, 0, 0.30 + i * 0.21, -0.44, 0.004);
      B.box(K, 1.24, 0.022, 0.022, 0, 0.30 + i * 0.21, 0.44, 0.004);
      B.box(K, 0.022, 0.022, 0.96, -0.57, 0.30 + i * 0.21, 0, 0.004);
      B.box(K, 0.022, 0.022, 0.96, 0.57, 0.30 + i * 0.21, 0, 0.004);
    }
    for (i = 0; i < 5; i++) {
      B.box(K, 0.020, 0.80, 0.020, -0.50 + i * 0.25, 0.55, -0.44, 0.004);
      B.box(K, 0.020, 0.80, 0.020, -0.50 + i * 0.25, 0.55, 0.44, 0.004);
    }
    // an open top frame, not a plate: a 1.3 m slab of deck plate two metres
    // from a lens is one flat specular highlight and nothing else
    B.box(K, 1.32, 0.075, 0.09, 0, 0.94, -0.47, 0.008);
    B.box(K, 1.32, 0.075, 0.09, 0, 0.94, 0.47, 0.008);
    B.box(K, 0.09, 0.075, 1.04, -0.60, 0.94, 0, 0.008);
    B.box(K, 0.09, 0.075, 1.04, 0.60, 0.94, 0, 0.008);
    // the twistlocks themselves, heaped
    for (i = 0; i < 7; i++) {
      B.boxR(K, 0.11, 0.05, 0.10, rng.range(-0.45, 0.45), 0.24 + rng.range(0, 0.22),
        rng.range(-0.34, 0.34), rng.range(-0.4, 0.4), rng.range(0, 3.1),
        rng.range(-0.4, 0.4), 0.006);
    }
    B.pop();
    L.addCollider(x, y + 0.50, z, 0.70, 0.50, 0.58, 'metal');
  }

  function lashingRack(B, L, x, y, z, yaw, rng) {
    B.pushXYZ(x, y, z, 0, yaw, 0);
    var K = 'deck_plate', i;
    B.box(K, 2.40, 0.11, 0.62, 0, 0.06, 0, 0.010);
    for (i = -1; i <= 1; i += 2) {
      B.box(K, 0.09, 1.05, 0.09, i * 1.10, 0.60, -0.24, 0.008);
      B.box(K, 0.09, 1.05, 0.09, i * 1.10, 0.60, 0.24, 0.008);
      B.strut(K, i * 1.10, 1.12, -0.24, i * 1.10, 1.12, 0.24, 0.05, 0.05);
    }
    // the lashing bars themselves, leaning in a bundle
    for (i = 0; i < 9; i++) {
      B.cyl(K, 0.021, 0.021, 2.15, rng.range(-0.9, 0.9), 0.62, rng.range(-0.17, 0.17),
        0, rng.range(-0.06, 0.06), Math.PI * 0.5 + rng.range(-0.05, 0.05), 6);
    }
    B.pop();
    L.addCollider(x, y + 0.60, z, 1.25, 0.60, 0.42, 'metal');
  }

  function gensetPack(B, L, x, y, z, yaw) {
    B.pushXYZ(x, y, z, 0, yaw, 0);
    var K = 'deck_plate', i;
    B.box(K, 3.30, 0.16, 1.32, 0, 0.10, 0, 0.014);
    B.box('reefer_panel', 3.10, 1.42, 1.20, 0, 0.90, 0, 0.03);
    // radiator grille one end, a louvred bank the other
    for (i = 0; i < 8; i++) {
      B.boxR(K, 0.05, 0.10, 1.06, -1.52, 0.42 + i * 0.15, 0, 0.42, 0, 0, 0.006);
    }
    for (i = 0; i < 5; i++) {
      B.box(K, 1.20, 0.05, 0.05, 0.55, 0.50 + i * 0.22, -0.62, 0.005);
    }
    B.cyl(K, 0.085, 0.085, 0.70, 1.35, 1.90, 0.36, 0, 0, 0, 8);      // exhaust
    B.cyl(K, 0.11, 0.11, 0.10, 1.35, 2.28, 0.36, 0, 0, 0, 8);
    B.box(K, 0.10, 0.34, 0.44, -1.62, 1.10, 0.30, 0.010);            // control box
    B.add('glass_lit', quad(0.16, 0.10, 0, 0, 1, 1), makeM(-1.69, 1.18, 0.30, 0, -Math.PI * 0.5, 0));
    B.pop();
    L.addCollider(x, y + 0.85, z, 1.70, 0.85, 0.70, 'metal');
  }

  // Where a stack is, in plan, so the puddle placer does not put water under a
  // container and the navgrid knows the footprint.
  function stackFootprint(s) {
    // The exact rotated AABB, not a snap to the nearest axis. Every stack now
    // carries up to 3.2 degrees of yaw jitter, which on a 12.19 m box is 0.34 m
    // of extent the snapped version simply lost - and lost it into the collider,
    // the navgrid and the puddle mask all at once.
    var c = Math.abs(Math.cos(s.yaw)), n = Math.abs(Math.sin(s.yaw));
    var hx = c * s.len * 0.5 + n * C_W * 0.5;
    var hz = n * s.len * 0.5 + c * C_W * 0.5;
    return { x: s.x, z: s.z, hx: hx, hz: hz, top: s.n * C_H };
  }

  // ============================================================== THE CRANE ==
  // A ship-to-shore gantry: 24 m rail gauge, 26 m portal clear, legs on bogies,
  // a sill beam at 15.4 m carrying the elevated walkway, an A-frame to 30 m and
  // a boom out over the ship. Stairs up the landward leg make the walkway a
  // real firing position over the whole container field.
  function latticeLeg(B, key, x, z, y0, y1, w0, w1, d0, d1) {
    var bays = Math.max(3, Math.round((y1 - y0) / 2.2));
    var i, s, t;
    function hw(y) { return M.lerp(w0, w1, (y - y0) / (y1 - y0)) * 0.5; }
    function hd(y) { return M.lerp(d0, d1, (y - y0) / (y1 - y0)) * 0.5; }
    // four chords
    for (s = -1; s <= 1; s += 2) {
      for (t = -1; t <= 1; t += 2) {
        for (i = 0; i < bays; i++) {
          var ya = y0 + (y1 - y0) * i / bays, yb = y0 + (y1 - y0) * (i + 1) / bays;
          B.strut(key, x + s * hw(ya), ya, z + t * hd(ya),
            x + s * hw(yb), yb, z + t * hd(yb), 0.26, 0.26);
        }
      }
    }
    // bracing on all four faces
    for (i = 0; i < bays; i++) {
      var ya2 = y0 + (y1 - y0) * i / bays, yb2 = y0 + (y1 - y0) * (i + 1) / bays;
      for (s = -1; s <= 1; s += 2) {
        B.strut(key, x + s * hw(ya2), ya2, z - hd(ya2), x + s * hw(yb2), yb2, z + hd(yb2), 0.13, 0.13);
        B.strut(key, x - hw(ya2), ya2, z + s * hd(ya2), x + hw(yb2), yb2, z + s * hd(yb2), 0.13, 0.13);
      }
      // horizontal frames
      for (s = -1; s <= 1; s += 2) {
        B.strut(key, x + s * hw(yb2), yb2, z - hd(yb2), x + s * hw(yb2), yb2, z + hd(yb2), 0.13, 0.13);
        B.strut(key, x - hw(yb2), yb2, z + s * hd(yb2), x + hw(yb2), yb2, z + s * hd(yb2), 0.13, 0.13);
      }
    }
  }

  // A box-truss girder between two points, braced. The boom and every portal
  // beam is one of these.
  function trussRun(B, key, ax, ay, az, bx, by, bz, depth, width, bayLen) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.2) return;
    var n = Math.max(2, Math.round(len / (bayLen || 3.0)));
    var ux = dx / len, uy = dy / len, uz = dz / len;
    // a lateral axis perpendicular to the run, in plan
    var lx = -uz, lz = ux;
    var ll = Math.sqrt(lx * lx + lz * lz) || 1;
    lx /= ll; lz /= ll;
    var hwd = width * 0.5, hdp = depth * 0.5;
    var i, s;
    function P(t, sv, yv) {
      return [ax + ux * len * t + lx * hwd * sv, ay + uy * len * t + yv * hdp,
              az + uz * len * t + lz * hwd * sv];
    }
    for (s = -1; s <= 1; s += 2) {
      for (var yv = -1; yv <= 1; yv += 2) {
        for (i = 0; i < n; i++) {
          var p0 = P(i / n, s, yv), p1 = P((i + 1) / n, s, yv);
          B.strut(key, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.22, 0.22);
        }
      }
    }
    for (i = 0; i < n; i++) {
      var t0 = i / n, t1 = (i + 1) / n;
      for (s = -1; s <= 1; s += 2) {
        var a1 = P(t0, s, -1), b1 = P(t1, s, 1);
        B.strut(key, a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], 0.11, 0.11);
        var a2 = P(t1, s, -1), b2 = P(t1, s, 1);
        B.strut(key, a2[0], a2[1], a2[2], b2[0], b2[1], b2[2], 0.11, 0.11);
      }
      var c1 = P(t0, -1, 1), c2 = P(t1, 1, 1);
      B.strut(key, c1[0], c1[1], c1[2], c2[0], c2[1], c2[2], 0.11, 0.11);
      var d1 = P(t1, -1, -1), d2 = P(t1, 1, -1);
      B.strut(key, d1[0], d1[1], d1[2], d2[0], d2[1], d2[2], 0.11, 0.11);
    }
  }

  // Handrail + kick plate along a walkway edge.
  function railing(B, key, ax, ay, az, bx, by, bz, h, side) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return;
    var n = Math.max(1, Math.round(len / 1.6));
    var i;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      B.cyl(key, 0.026, 0.026, h, ax + dx * t, ay + h * 0.5, az + dz * t, 0, 0, 0, 6);
    }
    for (i = 0; i < 2; i++) {
      var hy = ay + h - i * h * 0.44;
      B.strut(key, ax, hy, az, bx, hy, bz, 0.032, 0.032);
    }
    // kick plate
    B.strut(key, ax, ay + 0.075, az, bx, ay + 0.075, bz, 0.012, 0.15);
    if (side) { /* documented parameter, unused geometry-side */ }
  }

  // An industrial stair flight. Rise is kept under the controller's 0.35 m
  // STEP_HEIGHT so the player simply walks up it, and every tread gets its own
  // collider - a rotated ramp box would slide the capsule back down.
  function stairFlight(B, L, key, x, z, y0, steps, rise, going, dirX, dirZ, width) {
    var i;
    var hw2 = width * 0.5;
    for (i = 0; i < steps; i++) {
      var sy = y0 + (i + 1) * rise;
      var sx = x + dirX * (i + 0.5) * going;
      var sz = z + dirZ * (i + 0.5) * going;
      var tw = dirX !== 0 ? going + 0.02 : width;
      var td = dirX !== 0 ? width : going + 0.02;
      B.box(key, tw, 0.035, td, sx, sy, sz, 0.006);
      // riser
      B.box(key, dirX !== 0 ? 0.02 : width, rise * 0.72, dirX !== 0 ? width : 0.02,
        sx - dirX * going * 0.48, sy - rise * 0.38, sz - dirZ * going * 0.48, 0.004);
      L.addCollider(sx, sy - 0.14, sz, tw * 0.5, 0.16, td * 0.5, 'metal', true);
    }
    // stringers
    for (var s = -1; s <= 1; s += 2) {
      var ex = x + dirX * steps * going, ez = z + dirZ * steps * going;
      var ox = dirX !== 0 ? 0 : s * hw2, oz = dirX !== 0 ? s * hw2 : 0;
      B.strut(key, x + ox, y0 + 0.06, z + oz, ex + ox, y0 + steps * rise + 0.06, ez + oz,
        0.30, 0.05);
      // handrail
      var n = Math.max(2, Math.round(steps / 4));
      for (i = 0; i <= n; i++) {
        var t = i / n;
        var px = x + (ex - x) * t + ox, pz = z + (ez - z) * t + oz;
        var py = y0 + steps * rise * t;
        B.cyl(key, 0.024, 0.024, 1.05, px, py + 0.52, pz, 0, 0, 0, 6);
      }
      B.strut(key, x + ox, y0 + 1.05, z + oz, ex + ox, y0 + steps * rise + 1.05, ez + oz,
        0.030, 0.030);
      B.strut(key, x + ox, y0 + 0.60, z + oz, ex + ox, y0 + steps * rise + 0.60, ez + oz,
        0.026, 0.026);
    }
    return y0 + steps * rise;
  }

  // Ship-to-shore cranes are painted, and they are painted LIGHT - pale grey or
  // white, with the leg bases in hazard yellow. That is not decoration: at
  // night a dark lattice against a dark storm sky is black on black and the
  // first capture had a 30 m gantry in the middle of the frame that could not
  // be seen at all. A pale paint scheme is what lets the ambient and the
  // practicals put a value on the structure, and what silhouettes it against
  // the cloud. Vertex colour is an unclamped albedo multiplier, so this is a
  // paint statement, not a lighting cheat.
  // Cooled deliberately. The finding was that the gantry inherits the market's
  // warm palette on level 2's hero silhouette, and it did: an almost neutral
  // multiplier under 2000 K sodium at 6 m came back tan. Pushing the blue up
  // and the red down by 12% either side of the same luminance gives yard-enamel
  // grey that still reads as PAINTED under a sodium lamp instead of as rust.
  // 0x8d949a - the cold yard grey the finding asks for - renormalised to the
  // same luminance the old neutral multiplier had. A first pass at 1.66/1.86/
  // 2.10 was too far: the crane's west leg is a big area of `gangway`, and
  // pushing it that blue under a 5400 K mercury flood took that frame's
  // grade_split further negative rather than back toward zero.
  // Settled at barely-cool rather than at 0x8d949a's full ratio. The COLDNESS
  // of the crane in this level comes from the 5600 K floods that light it,
  // which is where it physically belongs; putting it in the paint as well made
  // the west leg - a large area of the `gangway` framing - a cold highlight
  // over cold shadows, and drove that frame's grade_split further negative.
  var CRANE_PAINT = new THREE.Color(1.87, 1.88, 1.90);
  var CRANE_HAZARD = new THREE.Color(2.10, 1.62, 0.42);
  var CLAD_PAINT = new THREE.Color(1.52, 1.55, 1.58);

  function buildCrane(L, B, rng, N) {
    // Two keys, and the split is the finding. `KS` is every rolled structural
    // member - chords, bracing, portal girders, A-frame, boom - mapped at 0.26
    // uv so the paint scales to the MEMBER. `K` stays checker plate, and is
    // kept for the things that genuinely are: bogies and machinery, walkway and
    // stair decking, handrails, the trolley and the headblock.
    var KS = 'struct_steel';
    var K = 'deck_plate';
    var i, s, t;
    B.paint = 'metal';
    B.tint = CRANE_PAINT;
    var legs = [[-CR_LEG_X, CR_RAIL_A], [CR_LEG_X, CR_RAIL_A],
                [-CR_LEG_X, CR_RAIL_B], [CR_LEG_X, CR_RAIL_B]];

    // ---- bogies --------------------------------------------------------------
    // Hazard-yellow at knee height on every leg: the one colour accent in an
    // otherwise monochrome machine, and the thing that says "industrial" from
    // 40 m even when the lattice above it has gone to silhouette.
    // Painted onto the BOGIE, which is a solid beam. Painted onto the leg it
    // would be a yellow slab floating inside an open lattice.
    B.tint = CRANE_HAZARD;
    for (i = 0; i < legs.length; i++) {
      B.box(K, 5.68, 0.30, 1.38, legs[i][0], 1.05, legs[i][1], 0.02);
      B.box(K, 5.68, 0.30, 1.38, legs[i][0], 0.60, legs[i][1], 0.02);
    }
    B.tint = CRANE_PAINT;
    for (i = 0; i < legs.length; i++) {
      var lx = legs[i][0], lz = legs[i][1];
      B.box(K, 5.6, 0.62, 1.30, lx, 0.85, lz, 0.03);
      B.box(K, 5.9, 0.24, 0.70, lx, 1.28, lz, 0.02);
      for (var w = 0; w < 6; w++) {
        var wx = lx - 2.25 + w * 0.9;
        B.cyl(K, 0.30, 0.30, 0.24, wx, 0.35, lz, 0, 0, Math.PI * 0.5, 12);
      }
      // rail sweeps and buffers
      for (s = -1; s <= 1; s += 2) {
        B.box(K, 0.22, 0.34, 0.60, lx + s * 2.95, 0.42, lz, 0.02);
      }
      L.addCollider(lx, 1.1, lz, 2.9, 1.1, 0.9, 'metal');
      latticeLeg(B, KS, lx, lz, 1.30, CR_SILL, 2.9, 2.0, 1.9, 1.5);
      L.addCollider(lx, (1.3 + CR_SILL) * 0.5, lz, 1.35, (CR_SILL - 1.3) * 0.5, 0.95, 'metal');
    }

    // ---- sill beams and the portal cross girders ------------------------------
    for (s = -1; s <= 1; s += 2) {
      trussRun(B, KS, s * CR_LEG_X, CR_SILL - 0.9, CR_RAIL_A,
        s * CR_LEG_X, CR_SILL - 0.9, CR_RAIL_B, 1.9, 1.6, 3.0);
    }
    trussRun(B, KS, -CR_LEG_X, CR_SILL - 0.9, CR_RAIL_A, CR_LEG_X, CR_SILL - 0.9, CR_RAIL_A,
      2.1, 1.8, 3.2);
    trussRun(B, KS, -CR_LEG_X, CR_SILL - 0.9, CR_RAIL_B, CR_LEG_X, CR_SILL - 0.9, CR_RAIL_B,
      2.1, 1.8, 3.2);

    // ---- the elevated walkway ------------------------------------------------
    // Grating deck at 15.6 m along the seaward cross girder, with a spur back
    // along the west portal beam to the stair head. This is the firing position
    // that looks down every canyon in the yard.
    var wy = CR_SILL + 0.2;
    B.paint = 'grate';
    B.box('steel_grate', 2 * CR_LEG_X + 1.0, 0.05, 1.50, 0, wy, CR_RAIL_A, 0.01);
    B.box('steel_grate', 1.50, 0.05, CR_RAIL_B - CR_RAIL_A, -CR_LEG_X, wy,
      (CR_RAIL_A + CR_RAIL_B) * 0.5, 0.01);
    B.paint = 'metal';
    L.addCollider(0, wy - 0.15, CR_RAIL_A, CR_LEG_X + 0.5, 0.16, 0.75, 'metal', true);
    L.addCollider(-CR_LEG_X, wy - 0.15, (CR_RAIL_A + CR_RAIL_B) * 0.5, 0.75, 0.16,
      (CR_RAIL_B - CR_RAIL_A) * 0.5, 'metal', true);
    railing(B, K, -CR_LEG_X - 0.5, wy, CR_RAIL_A - 0.72, CR_LEG_X + 0.5, wy, CR_RAIL_A - 0.72, 1.10);
    railing(B, K, -CR_LEG_X - 0.5, wy, CR_RAIL_A + 0.72, CR_LEG_X + 0.5, wy, CR_RAIL_A + 0.72, 1.10);
    railing(B, K, -CR_LEG_X - 0.72, wy, CR_RAIL_A + 0.8, -CR_LEG_X - 0.72, wy, CR_RAIL_B, 1.10);
    railing(B, K, -CR_LEG_X + 0.72, wy, CR_RAIL_A + 0.8, -CR_LEG_X + 0.72, wy, CR_RAIL_B, 1.10);
    // support brackets under the deck
    for (i = 0; i < 14; i++) {
      var bxk = -CR_LEG_X + i * (2 * CR_LEG_X / 13);
      B.strut(KS, bxk, wy - 0.06, CR_RAIL_A - 0.75, bxk, wy - 0.85, CR_RAIL_A, 0.08, 0.08);
      B.strut(KS, bxk, wy - 0.06, CR_RAIL_A + 0.75, bxk, wy - 0.85, CR_RAIL_A, 0.08, 0.08);
    }

    // ---- stairs up the landward west leg --------------------------------------
    // Four switchback flights on the outside of the leg, 13 treads of 300 mm.
    var sx0 = -CR_LEG_X, sz0 = CR_RAIL_B + 1.8;
    var y = 0.0;
    for (i = 0; i < 4; i++) {
      var dir = (i % 2) === 0 ? 1 : -1;
      var z0 = dir > 0 ? sz0 : sz0 + 13 * 0.30;
      y = stairFlight(B, L, K, sx0, z0, y, 13, 0.30, 0.30, 0, dir, 1.30);
      // landing
      var lz2 = dir > 0 ? sz0 + 13 * 0.30 + 0.65 : sz0 - 0.65;
      B.paint = 'grate';
      B.box('steel_grate', 1.30, 0.05, 1.40, sx0, y + 0.02, lz2, 0.01);
      B.paint = 'metal';
      L.addCollider(sx0, y - 0.13, lz2, 0.65, 0.15, 0.70, 'metal', true);
      railing(B, K, sx0 - 0.62, y + 0.02, lz2 - 0.7, sx0 - 0.62, y + 0.02, lz2 + 0.7, 1.05);
      railing(B, K, sx0 + 0.62, y + 0.02, lz2 - 0.7, sx0 + 0.62, y + 0.02, lz2 + 0.7, 1.05);
      // the tower's own corner posts
      if (i < 3) {
        for (s = -1; s <= 1; s += 2) {
          for (t = -1; t <= 1; t += 2) {
            B.strut(KS, sx0 + s * 0.66, y, sz0 + (t > 0 ? 4.5 : -0.9),
              sx0 + s * 0.66, y + 3.9, sz0 + (t > 0 ? 4.5 : -0.9), 0.13, 0.13);
          }
        }
      }
    }
    // bridge from the stair head onto the walkway
    B.paint = 'grate';
    B.box('steel_grate', 1.30, 0.05, 2.4, sx0, wy, CR_RAIL_B - 1.0, 0.01);
    B.paint = 'metal';
    L.addCollider(sx0, wy - 0.14, CR_RAIL_B - 1.0, 0.65, 0.15, 1.2, 'metal', true);

    // ---- upper structure, machinery house and A-frame -------------------------
    for (i = 0; i < legs.length; i++) {
      latticeLeg(B, KS, legs[i][0], legs[i][1], CR_SILL, 25.0, 2.0, 1.7, 1.5, 1.4);
    }
    for (s = -1; s <= 1; s += 2) {
      trussRun(B, KS, s * CR_LEG_X, 25.0, CR_RAIL_A, s * CR_LEG_X, 25.0, CR_RAIL_B, 1.7, 1.5, 3.4);
    }
    trussRun(B, KS, -CR_LEG_X, 25.0, CR_RAIL_A, CR_LEG_X, 25.0, CR_RAIL_A, 1.7, 1.5, 3.4);
    trussRun(B, KS, -CR_LEG_X, 25.0, CR_RAIL_B, CR_LEG_X, 25.0, CR_RAIL_B, 1.7, 1.5, 3.4);
    // A-frame to the apex
    for (s = -1; s <= 1; s += 2) {
      B.strut(KS, s * CR_LEG_X, 25.0, CR_RAIL_A, s * 4.5, CR_APEX, -14.0, 0.42, 0.42);
      B.strut(KS, s * CR_LEG_X, 25.0, CR_RAIL_B, s * 4.5, CR_APEX, -14.0, 0.42, 0.42);
    }
    B.strut(KS, -4.5, CR_APEX, -14.0, 4.5, CR_APEX, -14.0, 0.42, 0.42);
    // machinery house
    B.box('corrugated_roof', 8.4, 3.4, 6.6, 0, 26.9, CR_RAIL_B + 1.2, 0.05);
    B.box(K, 9.0, 0.22, 7.2, 0, 28.7, CR_RAIL_B + 1.2, 0.03);
    railing(B, K, -4.5, 28.8, CR_RAIL_B - 2.2, 4.5, 28.8, CR_RAIL_B - 2.2, 1.05);
    railing(B, K, -4.5, 28.8, CR_RAIL_B + 4.6, 4.5, 28.8, CR_RAIL_B + 4.6, 1.05);

    // ---- boom and backreach ---------------------------------------------------
    var boomY = 27.2;
    for (s = -1; s <= 1; s += 2) {
      trussRun(B, KS, s * 3.2, boomY, CR_RAIL_A, s * 3.2, boomY + 1.1, CR_TIP_Z, 2.6, 1.4, 4.0);
      trussRun(B, KS, s * 3.2, boomY, CR_RAIL_B, s * 3.2, boomY + 1.6, CR_BACK_Z, 2.6, 1.4, 4.0);
    }
    for (i = 0; i < 9; i++) {
      var bz2 = CR_RAIL_A - (i + 1) * (CR_RAIL_A - CR_TIP_Z) / 9;
      var byy = boomY + 1.1 * (i + 1) / 9;
      B.strut(KS, -3.2, byy - 1.3, bz2, 3.2, byy - 1.3, bz2, 0.16, 0.16);
      B.strut(KS, -3.2, byy + 1.3, bz2, 3.2, byy + 1.3, bz2, 0.16, 0.16);
    }
    // forestays and backstays from the apex
    for (s = -1; s <= 1; s += 2) {
      B.strut(KS, s * 4.5, CR_APEX, -14.0, s * 3.2, boomY + 1.1, CR_TIP_Z + 4, 0.13, 0.13);
      B.strut(KS, s * 4.5, CR_APEX, -14.0, s * 3.2, boomY + 1.6, CR_BACK_Z - 2, 0.13, 0.13);
    }
    // trolley and spreader over the ship
    var tz = -42.0;
    B.box(K, 5.6, 1.5, 3.4, 0, boomY - 1.6, tz, 0.04);
    for (s = -1; s <= 1; s += 2) {
      B.cyl(K, 0.024, 0.024, 12.0, s * 1.5, boomY - 8.4, tz - 0.8, 0, 0, 0, 5);
      B.cyl(K, 0.024, 0.024, 12.0, s * 1.5, boomY - 8.4, tz + 0.8, 0, 0, 0, 5);
    }
    B.box(K, 2.2, 0.9, 2.6, 0, boomY - 14.8, tz, 0.04);
    B.box('container_steel', 12.4, 0.55, 2.55, 0, boomY - 15.6, tz, 0.03);
    for (s = -1; s <= 1; s += 2) {
      B.box(K, 0.30, 0.55, 0.30, s * 5.9, boomY - 16.0, tz, 0.02);
    }
    // ---- the operator cab -----------------------------------------------------
    // Slung off the trolley, glazed on five sides and lit from inside. A crane
    // with nobody in it is scenery; one warm 2 x 2 m box of light hanging 25 m
    // over black water is the whole machine reading as manned.
    B.box(KS, 0.30, 2.10, 0.30, 3.35, boomY - 2.7, tz - 1.5, 0.02);
    B.box(KS, 0.30, 2.10, 0.30, 3.35, boomY - 2.7, tz + 1.5, 0.02);
    B.box(K, 2.55, 0.22, 3.30, 3.35, boomY - 3.85, tz, 0.03);
    B.box(K, 2.55, 0.20, 3.30, 3.35, boomY - 5.85, tz, 0.03);
    for (s = -1; s <= 1; s += 2) {
      B.box(K, 0.10, 1.85, 0.12, 3.35 + s * 1.20, boomY - 4.85, tz - 1.58, 0.008);
      B.box(K, 0.10, 1.85, 0.12, 3.35 + s * 1.20, boomY - 4.85, tz + 1.58, 0.008);
      B.add('glass_lit', quad(3.05, 1.70, 0, 0, 1, 1),
        makeM(3.35 + s * 1.26, boomY - 4.85, tz, 0, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0));
    }
    B.add('glass_lit', quad(2.40, 1.70, 0, 0, 1, 1),
      makeM(3.35, boomY - 4.85, tz - 1.66, 0, Math.PI, 0));
    // the sloped front screen an operator actually looks down through
    B.add('glass_lit', quad(2.40, 1.90, 0, 0, 1, 1),
      makeM(3.35, boomY - 5.10, tz + 1.85, -0.38, 0, 0));
    B.add('glass_lit', quad(2.30, 2.90, 0, 0, 1, 1),
      makeM(3.35, boomY - 5.90, tz, Math.PI * 0.5, 0, 0));

    // ---- crane lighting rig ----------------------------------------------------
    // A 30 m unlit lattice at night against an unlit storm sky is black on
    // black: the first capture had a gantry crane in the middle of the frame
    // and not one pixel of it was distinguishable. A real STS crane is covered
    // in its own light - floods on the sill beam, a lit walkway, ladder-cage
    // lamps and aviation obstruction beacons - and that self-luminous rig is
    // what draws the machine against the cloud. All of it is emissive geometry
    // except the two floods, which are published as practicals so the apron
    // underneath actually gets a pool.
    for (s = -1; s <= 1; s += 2) {
      B.box(K, 1.05, 0.40, 0.62, s * 8.0, CR_SILL - 2.4, CR_RAIL_A - 1.0, 0.03);
      B.boxR(K, 1.05, 0.16, 0.30, s * 8.0, CR_SILL - 2.62, CR_RAIL_A - 1.12, 0.35, 0, 0, 0.02);
      B.add('glass_lit', quad(0.86, 0.44, 0, 0, 1, 1),
        makeM(s * 8.0, CR_SILL - 2.66, CR_RAIL_A - 1.12, Math.PI * 0.42, 0, 0));
      // a second pair aimed out over the water, on the boom heel
      B.box(K, 0.85, 0.34, 0.55, s * 5.4, boomY - 2.6, CR_RAIL_A - 3.0, 0.03);
      B.add('glass_lit', quad(0.68, 0.36, 0, 0, 1, 1),
        makeM(s * 5.4, boomY - 2.80, CR_RAIL_A - 3.0, Math.PI * 0.42, 0, 0));
    }
    // strip lights down the walkway handrail: the horizontal line at 15.6 m is
    // what tells the eye the crane is a portal and not a tower
    for (i = 0; i < 11; i++) {
      var sxl = -CR_LEG_X + 0.4 + i * (2 * CR_LEG_X - 0.8) / 10;
      B.box(K, 0.24, 0.10, 0.14, sxl, wy + 1.02, CR_RAIL_A - 0.72, 0.012);
      B.add('glass_lit', quad(0.20, 0.09, 0, 0, 1, 1),
        makeM(sxl, wy + 0.97, CR_RAIL_A - 0.79, Math.PI * 0.30, 0, 0));
    }
    // ladder-cage lamps up the landward west leg
    for (i = 0; i < 4; i++) {
      B.add('glass_lit', quad(0.16, 0.16, 0, 0, 1, 1),
        makeM(-CR_LEG_X - 0.70, 3.6 + i * 3.9, CR_RAIL_B + 3.6, 0, -Math.PI * 0.5, 0));
    }
    // ---- underslung boom floods -----------------------------------------------
    // The machine's working light: four heads hung under the boom chords 26 m
    // up, throwing straight down onto the hatch. In a downpour that is a 20 m
    // column of lit rain standing over black water, which is the single most
    // spectacular thing this level has available and it was not being taken.
    for (i = 0; i < 2; i++) {
      // Over the HATCHES (the deck centreline is 9 m inboard of the shell), not
      // over the ship's side. Measured: at z -37 the 31-degree skirt put a 14 m
      // pool of cold 5600 K straight down the topsides, which took `gangway` to
      // mean 0.231 and inverted its colour grade - cold highlights over cold
      // shadows, the one thing grade_split exists to catch.
      var bfz = -50.0 - i * 7.0;
      for (s = -1; s <= 1; s += 2) {
        var bfy = boomY + 1.1 * (Math.abs(bfz - CR_RAIL_A) / Math.abs(CR_TIP_Z - CR_RAIL_A)) - 1.55;
        B.box(K, 0.62, 0.30, 0.90, s * 2.6, bfy, bfz, 0.02);
        B.strut(KS, s * 2.6, bfy + 0.28, bfz, s * 3.1, bfy + 1.30, bfz, 0.09, 0.09);
        B.add('glass_lit', quad(0.50, 0.74, 0, 0, 1, 1),
          makeM(s * 2.6, bfy - 0.17, bfz, Math.PI * 0.5, 0, 0));
      }
    }
    // aviation obstruction beacons: apex and boom tip, RED, because a red mark
    // at 30 m is the only thing in this level that puts a signal in the top of
    // the frame and it must not be averaged into the sodium palette.
    B.add('glass_red', quad(0.46, 0.46, 0, 0, 1, 1), makeM(0, CR_APEX + 0.58, -14.0, Math.PI * 0.5, 0, 0));
    for (s = -1; s <= 1; s += 2) {
      B.add('glass_red', quad(0.30, 0.36, 0, 0, 1, 1),
        makeM(s * 0.24, CR_APEX + 0.40, -14.0, 0, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0));
    }
    B.cyl(K, 0.13, 0.17, 0.5, 0, CR_APEX + 0.3, -14.0, 0, 0, 0, 8);
    B.add('glass_red', quad(0.38, 0.38, 0, 0, 1, 1),
      makeM(0, boomY + 1.75, CR_TIP_Z + 1.2, Math.PI * 0.5, 0, 0));
    // and one on each portal-beam corner, so the 26 m frame has its own outline
    for (s = -1; s <= 1; s += 2) {
      B.add('glass_red', quad(0.26, 0.26, 0, 0, 1, 1),
        makeM(s * (CR_LEG_X + 0.1), 25.9, CR_RAIL_A, Math.PI * 0.5, 0, 0));
      B.add('glass_red', quad(0.26, 0.26, 0, 0, 1, 1),
        makeM(s * (CR_LEG_X + 0.1), 25.9, CR_RAIL_B, Math.PI * 0.5, 0, 0));
    }
    for (s = -1; s <= 1; s += 2) {
      B.add('glass_lit', quad(0.55, 0.34, 0, 0, 1, 1),
        makeM(s * 4.55, 26.9, CR_RAIL_B - 2.35, 0, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0));
    }
    // machinery-house windows, seen from the apron as two lit slots at 27 m
    B.add('glass_lit', quad(3.4, 1.1, 0, 0, 1, 1), makeM(0, 27.4, CR_RAIL_B - 2.12, 0, Math.PI, 0));

    L.lightShafts.push({
      origin: new THREE.Vector3(0, CR_SILL - 2.6, CR_RAIL_A - 1.0),
      dir: new THREE.Vector3(0.05, -1, 0.12).normalize(),
      width: 5.0, length: 13.0, strength: 0.9, kind: 'quay'
    });
    // the two floods, for lighting.js
    // The two floods, for lighting.js. They carry an explicit aimPos: without
    // one lighting.js has to fall back to "straight down", and a 12.65 m
    // vertical cone seen edge-on from 12 m away is a wedge of lit air across
    // the middle of both the `quay` and `gangway` framings with nothing legible
    // behind it. Canted out over the quay they light the working strip - which
    // is what a ship-to-shore crane's floods are for - and the camera sees the
    // cone at an angle instead of down its barrel.
    L.craneFloods = [
      { name: 'crane_flood_w', kind: 'mercury', fixture: 'none',
        pos: [-8.0, CR_SILL - 2.75, CR_RAIL_A - 1.15], kelvin: 5600,
        intensity: 660, distance: 32, dayBase: 0.0, cone: 0.52, penumbra: 0.44,
        aimPos: [-13.5, 0.0, CR_RAIL_A - 5.0], beam: 0.62, halo: 2.1 },
      { name: 'crane_flood_e', kind: 'mercury', fixture: 'none',
        pos: [8.0, CR_SILL - 2.75, CR_RAIL_A - 1.15], kelvin: 5600,
        intensity: 660, distance: 32, dayBase: 0.0, cone: 0.52, penumbra: 0.44,
        aimPos: [13.5, 0.0, CR_RAIL_A - 5.0], beam: 0.62, halo: 2.1 },
      // The boom floods. Aimed dead down at the hatch from 26 m, which is what
      // the fixture geometry above is built to. Both are checked against every
      // published eye the way the mast table is: the nearest is the `gangway`
      // camera at 23 m lateral and 24 m below, i.e. 40 degrees off the axis,
      // against an authored 21-degree cone and a 30-degree skirt.
      { name: 'crane_boom_a', kind: 'mercury', fixture: 'none',
        pos: [0.0, 26.6, -50.0], kelvin: 5600,
        intensity: 640, distance: 40, dayBase: 0.0, cone: 0.30, penumbra: 0.40,
        aimPos: [0.5, 7.6, -51.4], beam: 0.80, halo: 2.4 },
      { name: 'crane_boom_b', kind: 'mercury', fixture: 'none',
        pos: [0.0, 26.9, -57.0], kelvin: 5600,
        intensity: 580, distance: 40, dayBase: 0.0, cone: 0.28, penumbra: 0.40,
        aimPos: [-0.5, 7.6, -58.4], beam: 0.76, halo: 2.2 }
    ];
    // Published so weather.js can run water off the horizontal members - the
    // weather contract puts drips in its court, not this file's, and a level
    // that models them itself ends up with two uncoordinated systems shedding
    // water off the same girder.
    L.dripEdges = L.dripEdges || [];
    for (s = -1; s <= 1; s += 2) {
      L.dripEdges.push({
        a: new THREE.Vector3(-CR_LEG_X, CR_SILL - 1.9, s > 0 ? CR_RAIL_A : CR_RAIL_B),
        b: new THREE.Vector3(CR_LEG_X, CR_SILL - 1.9, s > 0 ? CR_RAIL_A : CR_RAIL_B),
        fall: 15.0, rate: 1.0, kind: 'crane'
      });
      L.dripEdges.push({
        a: new THREE.Vector3(s * 3.2, boomY - 1.3, CR_RAIL_A),
        b: new THREE.Vector3(s * 3.2, boomY + 0.1, CR_TIP_Z * 0.55),
        fall: 26.0, rate: 0.8, kind: 'crane'
      });
    }
    B.tint = null;
  }

  // ========================================================== THE WAREHOUSE ==
  // A profiled-steel portal-frame shed: two roller doors on the yard face (one
  // open, one buckled off its guides), racking inside, and a hole punched in
  // the roof with rain coming through it. That hole is the whole point of the
  // interior framing - it is the only source in the building that makes a
  // visible shaft, and the pooled water under it is the only bright thing in a
  // dark box.
  var WH_MIDX = (WH_X0 + WH_X1) * 0.5;

  // A vertically-corrugated cladding panel in a plane. `face` is the outward
  // axis: '+x' | '-x' | '+z' | '-z'.
  function cladPanel(B, key, face, plane, c0, c1, y0, y1, pitch, depth) {
    var len = c1 - c0;
    if (len <= 0.05 || y1 - y0 <= 0.05) return;
    var loop = corrugationLoop(len, pitch || 0.24, depth || 0.019, 0.012, 0.004, c0 * 0.7);
    var g = extrudeY(loop, y0, y1, false);
    var ry = face === '+x' ? Math.PI * 0.5 : face === '-x' ? -Math.PI * 0.5
           : face === '+z' ? 0 : Math.PI;
    var mid = (c0 + c1) * 0.5;
    var m;
    if (face === '+x' || face === '-x') m = makeM(plane, 0, mid, 0, ry, 0);
    else m = makeM(mid, 0, plane, 0, ry, 0);
    B.add(key, g, m);
  }

  function buildWarehouse(L, B, rng, N) {
    var K = 'corrugated_roof';
    var i, s, z;
    B.paint = 'clad';
    B.tint = CLAD_PAINT;      // galvanised profiled sheet, not black steel

    // ---- floor slab ----------------------------------------------------------
    var fy = 0.14;
    B.paint = 'quay';
    B.box('dock_concrete', WH_X1 - WH_X0 + 0.4, 0.36, WH_Z1 - WH_Z0 + 0.4,
      WH_MIDX, fy - 0.18, (WH_Z0 + WH_Z1) * 0.5, 0.02);
    // the apron ramp at the open door
    B.box('dock_concrete', 2.6, 0.30, 5.4, WH_FACE + WH_OUT * 1.2, fy - 0.16, 20.0, 0.02);
    B.paint = 'clad';
    L.addCollider(WH_MIDX, fy - 0.6, (WH_Z0 + WH_Z1) * 0.5,
      (WH_X1 - WH_X0) * 0.5, 0.6, (WH_Z1 - WH_Z0) * 0.5, 'concrete', true);

    // ---- portal frames -------------------------------------------------------
    var frames = 6;
    for (i = 0; i < frames; i++) {
      z = WH_Z0 + 0.5 + i * (WH_Z1 - WH_Z0 - 1.0) / (frames - 1);
      for (s = -1; s <= 1; s += 2) {
        var cxp = s < 0 ? WH_X0 + 0.42 : WH_X1 - 0.42;
        B.box('deck_plate', 0.30, WH_EAVE, 0.55, cxp, WH_EAVE * 0.5, z, 0.012);
        B.strut('deck_plate', cxp, WH_EAVE, z, WH_MIDX, WH_RIDGE, z, 0.24, 0.46);
        // haunch
        B.strut('deck_plate', cxp, WH_EAVE - 1.1, z, cxp + s * -1.4, WH_EAVE + 0.28, z, 0.20, 0.30);
      }
      B.box('deck_plate', 0.36, 0.50, 0.50, WH_MIDX, WH_RIDGE - 0.2, z, 0.012);
    }
    // purlins
    for (i = 0; i < 14; i++) {
      var t = i / 13;
      var px = M.lerp(WH_X0 + 0.4, WH_X1 - 0.4, t);
      var py = px < WH_MIDX ? M.lerp(WH_EAVE, WH_RIDGE, (px - WH_X0) / (WH_MIDX - WH_X0))
                            : M.lerp(WH_RIDGE, WH_EAVE, (px - WH_MIDX) / (WH_X1 - WH_MIDX));
      B.box('deck_plate', 0.10, 0.18, WH_Z1 - WH_Z0 - 0.8, px, py - 0.24,
        (WH_Z0 + WH_Z1) * 0.5, 0.008);
    }

    // ---- cladding ------------------------------------------------------------
    // the back wall and the two gables are unbroken; the yard face carries the
    // doors. WH_OUT is which way the yard face looks, so the shed can be moved
    // from one side of the terminal to the other without a sign hunt.
    var faceTag = WH_OUT < 0 ? '-x' : '+x';
    var backTag = WH_OUT < 0 ? '+x' : '-x';
    var backX = WH_OUT < 0 ? WH_X1 : WH_X0;
    cladPanel(B, K, backTag, backX, WH_Z0, WH_Z1, 0, WH_EAVE);
    cladPanel(B, K, '-z', WH_Z0, WH_X0, WH_X1, 0, WH_EAVE);
    cladPanel(B, K, '+z', WH_Z1, WH_X0, WH_X1, 0, WH_EAVE);
    // gable triangles, as stepped panels
    for (i = 0; i < 8; i++) {
      var gx0 = WH_X0 + i * (WH_X1 - WH_X0) / 8;
      var gx1 = gx0 + (WH_X1 - WH_X0) / 8;
      var gm = (gx0 + gx1) * 0.5;
      var gh = gm < WH_MIDX ? M.lerp(WH_EAVE, WH_RIDGE, (gm - WH_X0) / (WH_MIDX - WH_X0))
                            : M.lerp(WH_RIDGE, WH_EAVE, (gm - WH_MIDX) / (WH_X1 - WH_MIDX));
      cladPanel(B, K, '-z', WH_Z0, gx0, gx1, WH_EAVE - 0.05, gh);
      cladPanel(B, K, '+z', WH_Z1, gx0, gx1, WH_EAVE - 0.05, gh);
    }
    // yard face: piers between the openings
    var dA0 = 17.5, dA1 = 22.5, dB0 = 26.0, dB1 = 31.0, dH = 5.0;
    cladPanel(B, K, faceTag, WH_FACE, WH_Z0, dA0, 0, WH_EAVE);
    cladPanel(B, K, faceTag, WH_FACE, dA1, dB0, 0, WH_EAVE);
    cladPanel(B, K, faceTag, WH_FACE, dB1, WH_Z1, 0, WH_EAVE);
    cladPanel(B, K, faceTag, WH_FACE, dA0, dA1, dH, WH_EAVE);
    cladPanel(B, K, faceTag, WH_FACE, dB0, dB1, dH, WH_EAVE);

    // ---- roof: flat sheets on down-slope ribs ---------------------------------
    // Corrugation modelled as ribs rather than as a folded shell: on a roof the
    // ribs are the only part that is ever read, and this keeps the hole easy to
    // cut honestly instead of faking it with a dark quad.
    var slopeLen = Math.sqrt(Math.pow(WH_MIDX - WH_X0, 2) + Math.pow(WH_RIDGE - WH_EAVE, 2));
    var pitchAng = Math.atan2(WH_RIDGE - WH_EAVE, WH_MIDX - WH_X0);
    // 5.2 m along the shed and all the way up to the ridge. A polite 2 m hole
    // makes a shaft you cannot see; the aperture has to be big enough that the
    // beam through it is a SUBJECT in the interior framing.
    var holeZ0 = 21.4, holeZ1 = 26.6, holeT0 = 0.30, holeT1 = 1.02;
    for (s = -1; s <= 1; s += 2) {
      var sign = s;                                   // -1 = west slope
      var my = (WH_EAVE + WH_RIDGE) * 0.5;
      // the west slope rises toward +X, the east slope toward -X
      var rot = sign < 0 ? pitchAng : -pitchAng;
      // sheets in bands along z, split into three up-slope sections so the hole
      // can be a real gap in a real sheet
      for (i = 0; i < 8; i++) {
        var z0 = WH_Z0 - 0.35 + i * (WH_Z1 - WH_Z0 + 0.7) / 8;
        var z1 = z0 + (WH_Z1 - WH_Z0 + 0.7) / 8;
        for (var k = 0; k < 3; k++) {
          var t0 = k / 3, t1 = (k + 1) / 3, tm = (t0 + t1) * 0.5;
          // the hole: a real gap in a real sheet on the yard-side slope
          var holed = sign === WH_OUT && z0 >= holeZ0 - 0.7 && z1 <= holeZ1 + 0.7 &&
            t0 >= holeT0 - 0.02 && t1 <= holeT1 + 0.02;
          if (holed) continue;
          var cx2 = sign < 0 ? M.lerp(WH_X0 - 0.35, WH_MIDX, tm)
                             : M.lerp(WH_X1 + 0.35, WH_MIDX, tm);
          var cy2 = M.lerp(WH_EAVE - 0.1, WH_RIDGE, tm);
          B.boxR(K, slopeLen / 3 + 0.02, 0.055, z1 - z0, cx2, cy2, (z0 + z1) * 0.5,
            0, 0, rot, 0.008);
        }
      }
      // ribs
      for (i = 0; i < 56; i++) {
        var rz = WH_Z0 - 0.3 + i * (WH_Z1 - WH_Z0 + 0.6) / 55;
        var inHole = sign === WH_OUT && rz > holeZ0 && rz < holeZ1;
        var rmx = sign < 0 ? (WH_X0 - 0.35 + WH_MIDX) * 0.5 : (WH_X1 + 0.35 + WH_MIDX) * 0.5;
        if (inHole) continue;
        B.boxR(K, slopeLen, 0.045, 0.055, rmx, my + 0.06, rz, 0, 0, rot, 0.006);
      }
      // eaves gutter and fascia
      var ex2 = sign < 0 ? WH_X0 - 0.28 : WH_X1 + 0.28;
      B.box('deck_plate', 0.26, 0.22, WH_Z1 - WH_Z0 + 0.8, ex2, WH_EAVE - 0.20,
        (WH_Z0 + WH_Z1) * 0.5, 0.012);
      // downpipes
      for (i = 0; i < 3; i++) {
        var dz2 = WH_Z0 + 2.0 + i * 8.0;
        B.cyl('deck_plate', 0.075, 0.075, WH_EAVE - 0.3, ex2, (WH_EAVE - 0.3) * 0.5, dz2, 0, 0, 0, 8);
      }
    }
    // ridge cap
    B.box(K, 0.55, 0.10, WH_Z1 - WH_Z0 + 0.7, WH_MIDX, WH_RIDGE + 0.06,
      (WH_Z0 + WH_Z1) * 0.5, 0.01);
    // torn flaps around the hole
    var holeX = WH_FACE - WH_OUT * 4.0;
    for (i = 0; i < 5; i++) {
      var fz = holeZ0 + (i + 0.5) * (holeZ1 - holeZ0) / 5;
      B.boxR(K, 0.85, 0.03, 0.30, holeX + WH_OUT * rng.range(0, 0.6), WH_EAVE + 1.35,
        fz, rng.range(-0.5, 0.5), rng.range(-0.4, 0.4),
        WH_OUT * (pitchAng - rng.range(0.3, 1.1)), 0.005);
    }

    // ---- roller doors --------------------------------------------------------
    // Door A: open, the curtain rolled into its hood. The bright rectangle it
    // leaves is the interior framing's whole composition.
    var fx0 = WH_FACE + WH_OUT * 0.06;
    B.box('deck_plate', 0.36, 0.30, dA1 - dA0 + 0.7, fx0, dH + 0.20, (dA0 + dA1) * 0.5, 0.012);
    B.cyl('deck_plate', 0.30, 0.30, dA1 - dA0 + 0.3, WH_FACE + WH_OUT * 0.24, dH + 0.42,
      (dA0 + dA1) * 0.5, 0, Math.PI * 0.5, 0, 12);
    for (s = -1; s <= 1; s += 2) {
      B.box('deck_plate', 0.22, dH + 0.4, 0.20, WH_FACE + WH_OUT * 0.10, (dH + 0.4) * 0.5,
        (dA0 + dA1) * 0.5 + s * (dA1 - dA0) * 0.5, 0.010);
    }
    // Door B: buckled, hanging half down and out of one guide
    for (i = 0; i < 11; i++) {
      var sy2 = dH - 0.22 - i * 0.30;
      if (sy2 < 1.9) break;
      var bend = (i / 11) * (i / 11) * 0.55;
      B.boxR('deck_plate', 0.05, 0.29, dB1 - dB0 - 0.1 - bend * 1.6,
        WH_FACE + WH_OUT * (0.14 + bend * 0.75), sy2, (dB0 + dB1) * 0.5 + bend * 0.9,
        0, bend * 0.55 * WH_OUT, 0, 0.006);
    }
    B.box('deck_plate', 0.36, 0.30, dB1 - dB0 + 0.7, fx0, dH + 0.20, (dB0 + dB1) * 0.5, 0.012);
    for (s = -1; s <= 1; s += 2) {
      B.box('deck_plate', 0.22, dH + 0.4, 0.20, WH_FACE + WH_OUT * 0.10, (dH + 0.4) * 0.5,
        (dB0 + dB1) * 0.5 + s * (dB1 - dB0) * 0.5, 0.010);
    }

    // ---- wall colliders (with the openings left open) -------------------------
    var fcx = WH_FACE + WH_OUT * 0.1;
    L.addCollider(backX - WH_OUT * 0.1, WH_EAVE * 0.5, (WH_Z0 + WH_Z1) * 0.5, 0.22,
      WH_EAVE * 0.5, (WH_Z1 - WH_Z0) * 0.5, 'metal');
    L.addCollider(WH_MIDX, WH_EAVE * 0.5, WH_Z0 - 0.1, (WH_X1 - WH_X0) * 0.5, WH_EAVE * 0.5, 0.22, 'metal');
    L.addCollider(WH_MIDX, WH_EAVE * 0.5, WH_Z1 + 0.1, (WH_X1 - WH_X0) * 0.5, WH_EAVE * 0.5, 0.22, 'metal');
    L.addCollider(fcx, WH_EAVE * 0.5, (WH_Z0 + dA0) * 0.5, 0.22, WH_EAVE * 0.5,
      (dA0 - WH_Z0) * 0.5, 'metal');
    L.addCollider(fcx, WH_EAVE * 0.5, (dA1 + dB0) * 0.5, 0.22, WH_EAVE * 0.5,
      (dB0 - dA1) * 0.5, 'metal');
    L.addCollider(fcx, WH_EAVE * 0.5, (dB1 + WH_Z1) * 0.5, 0.22, WH_EAVE * 0.5,
      (WH_Z1 - dB1) * 0.5, 'metal');
    L.addCollider(fcx, (dH + WH_EAVE) * 0.5, (dA0 + dA1) * 0.5, 0.22,
      (WH_EAVE - dH) * 0.5, (dA1 - dA0) * 0.5, 'metal');
    L.addCollider(fcx, (dH + WH_EAVE) * 0.5, (dB0 + dB1) * 0.5, 0.22,
      (WH_EAVE - dH) * 0.5, (dB1 - dB0) * 0.5, 'metal');

    // ---- racking -------------------------------------------------------------
    // Structure, not clutter: the racking is what makes the interior a space
    // with depth and cover instead of an empty shoebox.
    // Run 1 stops at z=27 and stands 2.6 m off the west wall so its END is a
    // 4 m foreground mass for the interior framing rather than a face 1.8 m off
    // the lens; run 2 stops at z=23 so it holds the right edge without standing
    // between the camera and the open roller door.
    // WH_OUT points OUT of the yard face, so it also points from the back wall
    // INTO the building - which is what these two offsets need.
    var runs = [[backX + WH_OUT * 2.6, 16.2, 28.0], [WH_MIDX - WH_OUT * 1.4, 15.5, 23.0]];
    for (i = 0; i < runs.length; i++) {
      var rx = runs[i][0], rz0 = runs[i][1], rz1 = runs[i][2];
      var uprights = Math.max(2, Math.round((rz1 - rz0) / 2.7));
      for (var u = 0; u <= uprights; u++) {
        var uz = rz0 + (rz1 - rz0) * u / uprights;
        for (s = -1; s <= 1; s += 2) {
          B.box('deck_plate', 0.09, 6.0, 0.11, rx + s * 0.52, fy + 3.0, uz, 0.008);
        }
        B.strut('deck_plate', rx - 0.52, fy + 0.4, uz, rx + 0.52, fy + 2.6, uz, 0.05, 0.05);
        B.strut('deck_plate', rx + 0.52, fy + 2.6, uz, rx - 0.52, fy + 4.8, uz, 0.05, 0.05);
      }
      for (var lv = 0; lv < 3; lv++) {
        var ly2 = fy + 1.6 + lv * 1.85;
        for (s = -1; s <= 1; s += 2) {
          B.box('deck_plate', 0.075, 0.15, rz1 - rz0, rx + s * 0.52, ly2, (rz0 + rz1) * 0.5, 0.008);
        }
        // pallets and shrink-wrapped loads
        for (var pl = 0; pl < Math.floor((rz1 - rz0) / 1.35); pl++) {
          if (rng.next() < 0.30) continue;
          var pz2 = rz0 + 0.7 + pl * 1.35;
          B.box('tarpaulin', 1.05, 0.85, 1.10, rx, ly2 + 0.55, pz2, 0.03);
          B.box('deck_plate', 1.10, 0.13, 1.15, rx, ly2 + 0.12, pz2, 0.01);
        }
      }
      L.addCollider(rx, fy + 3.0, (rz0 + rz1) * 0.5, 0.62, 3.0, (rz1 - rz0) * 0.5, 'metal');
    }

    // ---- the pool under the hole, and the shaft that makes it read -----------
    B.paint = 'water';
    var poolX = WH_FACE - WH_OUT * 5.5;
    var pool = blobDisc(rng, 2.35, 1.15, 0.30);
    B.add('wet_concrete', pool, makeM(poolX, fy + 0.012, 24.0, 0, 0.6, 0));
    var pool2 = blobDisc(rng, 1.15, 0.85, 0.35);
    B.add('wet_concrete', pool2, makeM(poolX - WH_OUT * 2.6, fy + 0.010, 22.2, 0, 2.1, 0));
    B.paint = 'clad';
    L.wetPatches.push({ x: poolX, z: 24.0, r: 2.35, y: fy + 0.012 });
    L.lightShafts.push({
      origin: new THREE.Vector3(WH_FACE - WH_OUT * 4.4, WH_EAVE + 1.5, 24.0),
      dir: new THREE.Vector3(WH_OUT * -0.10, -1, 0.03).normalize(),
      width: 2.9, length: 9.6, strength: 1.0, kind: 'warehouse'
    });

    // a run of conduit down the inside of the yard wall
    B.box('deck_plate', 0.06, 0.06, WH_Z1 - WH_Z0 - 1.0, WH_FACE - WH_OUT * 0.35,
      WH_EAVE - 1.1, (WH_Z0 + WH_Z1) * 0.5, 0.006);
    B.paint = 'metal';
    B.tint = null;
  }

  // =========================================================== THE FREIGHTER ==
  // The hull is not a wall with a texture on it: it is a lofted surface with
  // sheer, flare and a bilge, so the deck line curves against the sky and the
  // topsides catch the quay lamps at a different angle every metre along it.
  function hullZ(x) {
    if (x < -32) { var t = M.saturate((-32 - x) / 26); return SHIP_Z - Math.pow(t, 1.7) * 9.5; }
    if (x > 24) { var u = M.saturate((x - 24) / 14); return SHIP_Z - Math.pow(u, 1.9) * 6.5; }
    return SHIP_Z;
  }
  function sheerY(x) {
    return SHIP_DECK + Math.pow(M.saturate((-x - 16) / 42), 2) * 2.1 +
      Math.pow(M.saturate((x - 20) / 18), 2) * 0.8;
  }

  // Transverse frame spacing. Every real ship's side plating is sucked in a
  // couple of centimetres between its frames - the "hungry horse" ripple - and
  // it is the single reason a 96 m steel wall catches a different amount of
  // light every 3 m instead of reading as one flat plate. 2.8 cm over 3.2 m is
  // a normal deviation of under 2 degrees, so it cannot alias at any range; it
  // just refuses to be flat.
  var FRAME_SP = 3.20;

  function buildFreighter(L, B, rng, N) {
    var i, s, y;
    B.paint = 'hull';
    // ---- topsides ------------------------------------------------------------
    // 108 stations, not 48: the frame-bay ripple has a 3.2 m period and a 2 m
    // station spacing samples it below Nyquist, which would have turned the one
    // detail that stops the hull being flat into a beat pattern down its length.
    var stations = 108;
    var rows = [-3.6, -2.6, -1.35, 0.4, 2.2, 4.1, 5.6, 1.0];
    var pos = [], nor = [];
    function hullPt(x, y2) {
      // flare: the topsides lean out toward the deck, and the bilge tucks under
      var up = M.saturate((y2 + 3.6) / (sheerY(x) + 3.6));
      var flare = M.smoothstep(0.30, 1.0, up) * 0.62;
      var tuck = Math.pow(M.saturate(1 - up * 3.2), 2) * 0.85;
      // the panel between two frames is dished INWARD, fading out at the bilge
      // where the plate is curved and stiff and at the deck edge where the
      // sheer strake is doubled
      var bay = Math.sin((x / FRAME_SP) * Math.PI);
      var band = M.smoothstep(0.06, 0.26, up) * (1 - M.smoothstep(0.80, 0.99, up));
      return hullZ(x) + flare - tuck - bay * bay * 0.028 * band;
    }
    for (i = 0; i < stations; i++) {
      var x0 = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * i / stations;
      var x1 = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * (i + 1) / stations;
      var yTop0 = sheerY(x0), yTop1 = sheerY(x1);
      var nY = 9;
      for (var j = 0; j < nY; j++) {
        var ya0 = M.lerp(-3.6, yTop0, j / nY), ya1 = M.lerp(-3.6, yTop0, (j + 1) / nY);
        var yb0 = M.lerp(-3.6, yTop1, j / nY), yb1 = M.lerp(-3.6, yTop1, (j + 1) / nY);
        var A = [x0, ya0, hullPt(x0, ya0)], Bv = [x1, yb0, hullPt(x1, yb0)];
        var Cv = [x1, yb1, hullPt(x1, yb1)], D = [x0, ya1, hullPt(x0, ya1)];
        // wound so the outward normal points +Z, i.e. at the quay
        pushTri(pos, nor, A, Cv, D);
        pushTri(pos, nor, A, Bv, Cv);
      }
    }
    var hullGeo = new THREE.BufferGeometry();
    hullGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    hullGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    B.add('ship_hull', hullGeo, null);

    // ---- plating seams, strakes and the bulwark ------------------------------
    // The shell-plating grid is GEOMETRY, because a painted seam disappears at
    // the ten metres this wall is actually seen from. Butt joints every 6.4 m
    // (two frame bays) and strake seams every 1.9 m, both as 30 mm proud weld
    // beads: they are what turn a wall into a ship at conversational distance.
    var butts = Math.round((SHIP_STERN_X - SHIP_BOW_X) / (FRAME_SP * 2));
    for (i = 0; i <= butts; i++) {
      var sx2 = SHIP_BOW_X + 2 + i * (SHIP_STERN_X - SHIP_BOW_X - 4) / butts;
      B.box('ship_hull', 0.048, sheerY(sx2) + 3.4, 0.030, sx2, (sheerY(sx2) - 3.4) * 0.5,
        hullPt(sx2, 1.0) + 0.030, 0.005);
    }
    var strakes = [-3.1, -2.15, -1.20, -0.25, 0.70, 1.65, 2.60, 3.55, 4.50, 5.45];
    for (i = 0; i < strakes.length; i++) {
      y = strakes[i];
      var seg = 72;
      for (var k = 0; k < seg; k++) {
        var sa = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * k / seg;
        var sb = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * (k + 1) / seg;
        if (y > sheerY(sa) - 0.4) continue;
        B.strut('ship_hull', sa, y, hullPt(sa, y) + 0.030, sb, y, hullPt(sb, y) + 0.030,
          0.042, 0.032);
      }
    }
    // ---- scuppers and shell-door sills ---------------------------------------
    // Every long directional rust weep on a ship starts at one of these, so
    // they are placed first and the streaks are hung off them below.
    var scup = [];
    for (i = 0; i < 11; i++) {
      var scx = -46 + i * 8.2 + (i % 3) * 1.1;
      var scy = sheerY(scx) + 0.42;
      B.box('ship_hull', 0.34, 0.20, 0.14, scx, scy, hullPt(scx, scy) + 0.06, 0.012);
      B.cyl('deck_plate', 0.075, 0.075, 0.26, scx, scy - 0.03, hullPt(scx, scy) + 0.16,
        Math.PI * 0.5, 0, 0, 8);
      scup.push([scx, scy]);
    }
    // ---- draught marks, name, hawse pipe and anchor ---------------------------
    L.material('decal', false);
    if (L._atlasOk) {
      B.paint = 'flat';
      var markW = tint(0xf4f6f4, 0.12);
      // the draught ladder, forward and aft, standing on the stem and the
      // stern post exactly where a ship carries it
      decalCard(B, CELL.DRAFT, SHIP_BOW_X + 12.0, -0.30,
        hullPt(SHIP_BOW_X + 12.0, -0.30) + 0.055, 1.35, 5.60, 'z', 1, markW, 0);
      decalCard(B, CELL.DRAFT, SHIP_STERN_X - 5.0, -0.30,
        hullPt(SHIP_STERN_X - 5.0, -0.30) + 0.055, 1.20, 5.20, 'z', 1, markW, 0);
      // name on the bow, port of registry aft. Invented operator, as everywhere
      // else in this level.
      decalCard(B, CELL.OWNER_B, SHIP_BOW_X + 16.0, 4.55,
        hullPt(SHIP_BOW_X + 16.0, 4.55) + 0.055, 7.20, 1.55, 'z', 1, markW, -0.035);
      decalCard(B, CELL.OWNER_C, SHIP_STERN_X - 12.0, 4.45,
        hullPt(SHIP_STERN_X - 12.0, 4.45) + 0.055, 5.40, 1.30, 'z', 1, markW, 0.02);
      // long directional weeps, one under every scupper and shell-door sill
      var rustW = tint(0xffb27a, 0.95);
      for (i = 0; i < scup.length; i++) {
        var wpx = scup[i][0], wpy = scup[i][1];
        var wlen = 2.4 + (i % 4) * 1.35;
        decalCard(B, (i & 1) ? CELL.WEEP_A : CELL.WEEP_B, wpx + ((i % 3) - 1) * 0.22,
          wpy - wlen * 0.5, hullPt(wpx, wpy - wlen * 0.5) + 0.050,
          0.85 + (i % 3) * 0.42, wlen, 'z', 1, rustW, 0);
      }
      // and the big one out of the shell door
      decalCard(B, CELL.WEEP_A, -6.5, 2.10, hullPt(-6.5, 2.10) + 0.050, 3.10, 4.40,
        'z', 1, rustW, 0);
      B.paint = 'hull';
    }
    // hawse pipe with the anchor stowed in it - the one piece of hardware that
    // says "ship" from any distance and in any light
    var hpx = SHIP_BOW_X + 7.2, hpy = 3.9;
    B.cyl('ship_hull', 0.72, 0.62, 0.30, hpx, hpy, hullPt(hpx, hpy) + 0.10,
      Math.PI * 0.46, 0, 0.30, 12);
    B.cyl('deck_plate', 0.50, 0.50, 0.26, hpx, hpy, hullPt(hpx, hpy) + 0.20,
      Math.PI * 0.46, 0, 0.30, 12);
    B.boxR('deck_plate', 1.55, 0.42, 0.30, hpx + 0.05, hpy - 0.95,
      hullPt(hpx, hpy - 0.95) + 0.22, 0, 0, 0.22, 0.02);       // stock
    B.boxR('deck_plate', 0.34, 1.30, 0.26, hpx + 0.05, hpy - 0.55,
      hullPt(hpx, hpy - 0.55) + 0.22, 0, 0, 0.22, 0.02);       // shank
    for (s = -1; s <= 1; s += 2) {
      B.boxR('deck_plate', 0.62, 0.70, 0.22, hpx + 0.05 + s * 0.62, hpy - 1.32,
        hullPt(hpx, hpy - 1.32) + 0.22, 0, 0, s * 0.75, 0.02);  // flukes
    }
    // the chain climbing out of the pipe to the windlass
    for (i = 0; i < 7; i++) {
      var chy = hpy + 0.32 + i * 0.30;
      B.cyl('deck_plate', 0.055, 0.055, 0.28, hpx + 0.12 + i * 0.05, chy,
        hullPt(hpx, chy) + 0.16, 0.28, (i & 1) ? 1.4 : 0.2, 0, 6);
    }
    // ---- fenders between the hull and the quay -------------------------------
    // Two cylindrical pneumatics squeezed at the waterline. Without them the
    // ship and the wall are two objects that happen to be near each other; with
    // them the ship is MOORED.
    for (i = 0; i < 2; i++) {
      var fdx = i === 0 ? -22.0 : 14.0;
      var fdz = (hullZ(fdx) - 0.55 + QUAY_Z - 0.62) * 0.5;
      B.cyl('rubber_fender', 1.05, 1.05, 2.55, fdx, WATER_Y + 1.05, fdz,
        0, 0, Math.PI * 0.5, 14);
      B.cyl('rubber_fender', 0.62, 0.62, 2.62, fdx, WATER_Y + 1.05, fdz,
        0, 0, Math.PI * 0.5, 12);
      for (s = -1; s <= 1; s += 2) {
        B.cyl('deck_plate', 0.16, 0.16, 0.20, fdx + s * 1.30, WATER_Y + 1.05, fdz,
          0, 0, Math.PI * 0.5, 10);
      }
      catenary(B, 'rope', fdx, WATER_Y + 2.05, fdz - 0.4,
        fdx - 1.2, -0.18, QUAY_Z - 0.30, 0.35, 0.048, 6);
    }
    // bulwark and the deck edge
    for (i = 0; i < 40; i++) {
      var bxa = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * i / 40;
      var bxb = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * (i + 1) / 40;
      var bya = sheerY(bxa), byb = sheerY(bxb);
      B.strut('ship_hull', bxa, bya + 0.60, hullPt(bxa, bya) - 0.10,
        bxb, byb + 0.60, hullPt(bxb, byb) - 0.10, 1.20, 0.16);
      B.strut('deck_plate', bxa, bya + 1.24, hullPt(bxa, bya) - 0.10,
        bxb, byb + 1.24, hullPt(bxb, byb) - 0.10, 0.14, 0.30);
    }

    // ---- main deck -----------------------------------------------------------
    B.paint = 'metal';
    for (i = 0; i < 24; i++) {
      var dx0 = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * i / 24;
      var dx1 = SHIP_BOW_X + (SHIP_STERN_X - SHIP_BOW_X) * (i + 1) / 24;
      var dm = (dx0 + dx1) * 0.5;
      B.box('deck_plate', dx1 - dx0 + 0.05, 0.20, 18.0, dm, sheerY(dm) - 0.05,
        hullPt(dm, sheerY(dm)) - 9.2, 0.01);
    }
    // hatch coamings
    for (i = 0; i < 4; i++) {
      var hxc = -40 + i * 15.5;
      B.box('deck_plate', 12.4, 1.55, 13.5, hxc, sheerY(hxc) + 0.75, SHIP_Z - 8.6, 0.03);
      B.box('ship_hull', 12.9, 0.22, 14.0, hxc, sheerY(hxc) + 1.6, SHIP_Z - 8.6, 0.02);
    }

    // ---- accommodation block and funnel --------------------------------------
    var ax0 = 20.0, ay0 = sheerY(26);
    // ---- WHY THE WINDOWS ARE NOT ON A GRID -----------------------------------
    // A 7 x 5 lattice of identical lit rectangles is an office block, not a
    // superstructure. On a real accommodation block the cabin band is broken
    // by the stair tower, the lift trunk and the alleyway doors; the deck
    // heights are not all equal; and the boxes that are lit at two in the
    // morning are the mess, the ECR and whoever is on watch. So: a per-deck
    // horizontal offset, three window widths, and a lit stair tower that runs
    // the full height as one continuous vertical - which is also the strongest
    // single vertical the far side of the frame gets.
    var deckH = [2.72, 2.90, 2.78, 3.02, 2.86];
    var dy0 = ay0 + 1.4;
    for (i = 0; i < 5; i++) {
      var tw = 13.5 - i * 0.5;
      B.box('ship_hull', tw, deckH[i] - 0.05, 12.5, ax0 + 6, dy0 + deckH[i] * 0.5,
        SHIP_Z - 7.5, 0.06);
      var wy0 = dy0 + deckH[i] * 0.62;
      var wcur = ax0 + 0.5 + (i % 3) * 0.42;
      while (wcur < ax0 + 11.4) {
        var ww2 = (rng.next() < 0.3) ? 0.72 : ((rng.next() < 0.55) ? 1.12 : 1.68);
        if (wcur + ww2 > ax0 + 11.6) break;
        if (rng.next() > 0.42) {
          B.add('glass_lit', quad(ww2, 0.74, 0, 0, 1, 1),
            makeM(wcur + ww2 * 0.5, wy0, SHIP_Z - 1.30, 0, 0, 0));
          B.box('deck_plate', ww2 + 0.10, 0.84, 0.05, wcur + ww2 * 0.5, wy0,
            SHIP_Z - 1.26, 0.008);
        }
        wcur += ww2 + 0.32 + rng.range(0, 0.55);
      }
      // the alleyway door on the port side of every second deck
      if (i & 1) {
        B.box('deck_plate', 0.90, 1.95, 0.06, ax0 + 12.2, dy0 + 0.98, SHIP_Z - 1.28, 0.01);
      }
      dy0 += deckH[i];
    }
    // ---- the stair tower -----------------------------------------------------
    // Lit top to bottom, standing proud of the block's face. One continuous
    // vertical against five horizontal bands is what stops the superstructure
    // reading as a stack of identical slabs.
    B.box('ship_hull', 2.35, dy0 - (ay0 + 1.4) + 0.4, 1.60, ax0 + 13.3,
      (ay0 + 1.4 + dy0) * 0.5, SHIP_Z - 0.95, 0.05);
    for (i = 0; i < 9; i++) {
      B.add('glass_lit', quad(1.45, 0.95, 0, 0, 1, 1),
        makeM(ax0 + 13.3, ay0 + 2.5 + i * 1.62, SHIP_Z - 0.12, 0, 0, 0));
    }
    // bridge deck and wings
    B.box('ship_hull', 15.5, 3.1, 11.0, ax0 + 6, ay0 + 16.6, SHIP_Z - 7.5, 0.06);
    for (i = 0; i < 8; i++) {
      B.add('glass_lit', quad(1.55, 1.35, 0, 0, 1, 1),
        makeM(ax0 - 0.9 + i * 1.85, ay0 + 17.0, SHIP_Z - 2.05, 0, 0, -0.08));
    }
    // BRIDGE WINGS: the two cantilevered platforms a ship is conned from when
    // she is alongside, and the only thing on this superstructure that breaks
    // its rectangular plan.
    for (s = -1; s <= 1; s += 2) {
      var bwx = ax0 + 6 + s * 9.4;
      B.box('deck_plate', 4.20, 0.20, 3.60, bwx, ay0 + 15.05, SHIP_Z - 3.60, 0.02);
      B.box('ship_hull', 4.20, 1.05, 0.24, bwx, ay0 + 15.65, SHIP_Z - 1.86, 0.02);
      B.box('ship_hull', 0.24, 1.05, 3.60, bwx + s * 2.0, ay0 + 15.65, SHIP_Z - 3.60, 0.02);
      B.box('deck_plate', 4.30, 0.16, 3.70, bwx, ay0 + 18.20, SHIP_Z - 3.60, 0.02);
      for (var bp = 0; bp < 3; bp++) {
        B.cyl('deck_plate', 0.075, 0.075, 2.40, bwx + (bp - 1) * 1.7, ay0 + 16.95,
          SHIP_Z - 1.95, 0, 0, 0, 8);
      }
      B.strut('deck_plate', bwx + s * 1.9, ay0 + 14.95, SHIP_Z - 3.6,
        ax0 + 6 + s * 5.6, ay0 + 12.6, SHIP_Z - 4.6, 0.16, 0.16);
      B.add('glass_lit', quad(1.05, 0.62, 0, 0, 1, 1),
        makeM(bwx, ay0 + 15.75, SHIP_Z - 1.72, 0, 0, 0));
    }
    B.box('deck_plate', 16.5, 0.22, 12.0, ax0 + 6, ay0 + 18.3, SHIP_Z - 7.5, 0.03);
    // funnel
    B.box('ship_hull', 5.6, 7.2, 6.2, ax0 + 6, ay0 + 21.4, SHIP_Z - 11.4, 0.10);
    B.box('deck_plate', 6.0, 0.32, 6.6, ax0 + 6, ay0 + 25.1, SHIP_Z - 11.4, 0.03);
    // masthead and range lights
    B.cyl('deck_plate', 0.11, 0.16, 9.0, ax0 + 6, ay0 + 22.8, SHIP_Z - 3.0, 0, 0, 0, 8);

    // ---- deck cranes ---------------------------------------------------------
    for (i = 0; i < 2; i++) {
      var cxx = -30 + i * 26;
      B.cyl('ship_hull', 1.5, 1.8, 5.6, cxx, sheerY(cxx) + 2.8, SHIP_Z - 9.0, 0, 0, 0, 12);
      B.box('ship_hull', 3.2, 2.6, 4.0, cxx, sheerY(cxx) + 6.6, SHIP_Z - 9.0, 0.06);
      B.strut('deck_plate', cxx, sheerY(cxx) + 7.4, SHIP_Z - 9.0,
        cxx + 3.0, sheerY(cxx) + 17.5, SHIP_Z - 1.5, 0.55, 0.55);
      catenary(B, 'deck_plate', cxx + 3.0, sheerY(cxx) + 17.5, SHIP_Z - 1.5,
        cxx + 3.0, sheerY(cxx) + 9.0, SHIP_Z - 1.5, 0.0, 0.030, 3);
    }

    // ---- shell door and the gangway ------------------------------------------
    var gx = -6.5, gTop = 4.3;
    B.box('ship_hull', 3.2, 2.9, 0.35, gx, gTop + 1.1, SHIP_Z + 0.20, 0.03);
    B.box('deck_plate', 3.6, 0.14, 1.5, gx, gTop, SHIP_Z + 0.85, 0.02);
    // ---- warm bulkhead lights at the shell door and down the ladder ---------
    // The `gangway` framing is lit by a 5400 K flood and two 5600 K crane
    // floods, so its highlights AND its shadows measured cold and its colour
    // grade inverted. A ship's own accommodation lighting is tungsten-warm and
    // it hangs exactly here - over the shell door and at every ladder platform.
    // Emissive geometry, so it costs no practical slot.
    B.box('deck_plate', 0.34, 0.26, 0.20, gx, gTop + 2.35, SHIP_Z + 0.36, 0.012);
    B.add('glass_lit', quad(0.30, 0.20, 0, 0, 1, 1),
      makeM(gx, gTop + 2.29, SHIP_Z + 0.47, 0.55, 0, 0));
    B.add('glass_lit', quad(1.95, 0.34, 0, 0, 1, 1),
      makeM(gx, gTop + 0.52, SHIP_Z + 0.42, 0, 0, 0));
    for (var gl = -1; gl <= 1; gl += 2) {
      B.box('deck_plate', 0.14, 0.30, 0.14, gx + gl * 1.62, gTop + 1.02, SHIP_Z + 1.42, 0.010);
      B.add('glass_lit', quad(0.20, 0.20, 0, 0, 1, 1),
        makeM(gx + gl * 1.62, gTop + 0.90, SHIP_Z + 1.42, Math.PI * 0.5, 0, 0));
    }
    railing(B, 'deck_plate', gx - 1.7, gTop, SHIP_Z + 1.55, gx + 1.7, gTop, SHIP_Z + 1.55, 1.05);
    L.addCollider(gx, gTop - 0.12, SHIP_Z + 0.85, 1.8, 0.14, 0.75, 'metal', true);

    // the accommodation ladder itself: 26 treads at 27 degrees
    var q0x = gx, q0z = QUAY_Z - 0.35, q0y = 0.06;
    var stepsN = 26;
    for (i = 0; i < stepsN; i++) {
      var t2 = (i + 0.5) / stepsN;
      var px2 = M.lerp(q0x, gx, t2);
      var pz3 = M.lerp(q0z, SHIP_Z + 0.9, t2);
      var py3 = M.lerp(q0y, gTop, t2);
      B.boxR('steel_grate', 1.30, 0.045, 0.24, px2, py3, pz3, 0, 0, 0, 0.006);
      L.addCollider(px2, py3 - 0.14, pz3, 0.65, 0.15, 0.16, 'metal', true);
    }
    for (s = -1; s <= 1; s += 2) {
      B.strut('deck_plate', q0x + s * 0.72, q0y - 0.10, q0z, gx + s * 0.72, gTop - 0.10, SHIP_Z + 0.9,
        0.34, 0.06);
      for (i = 0; i <= 6; i++) {
        var tt = i / 6;
        B.cyl('deck_plate', 0.024, 0.024, 1.05, M.lerp(q0x, gx, tt) + s * 0.72,
          M.lerp(q0y, gTop, tt) + 0.52, M.lerp(q0z, SHIP_Z + 0.9, tt), 0, 0, 0, 6);
      }
      B.strut('deck_plate', q0x + s * 0.72, q0y + 1.05, q0z, gx + s * 0.72, gTop + 1.05, SHIP_Z + 0.9,
        0.030, 0.030);
      B.strut('deck_plate', q0x + s * 0.72, q0y + 0.58, q0z, gx + s * 0.72, gTop + 0.58, SHIP_Z + 0.9,
        0.026, 0.026);
    }
    // safety net slung UNDER it, sagging - not a flag standing above the treads
    B.paint = 'clad';
    for (i = 0; i < 3; i++) {
      var nt = (i + 0.5) / 3;
      B.boxR('chainlink', 2.9, 0.02, 3.2,
        gx, M.lerp(q0y, gTop, nt) - 0.95 - Math.sin(nt * Math.PI) * 0.35,
        M.lerp(q0z, SHIP_Z + 0.9, nt), -0.42, 0, 0, 0.004);
    }
    B.paint = 'metal';

    // ---- mooring lines under tension ------------------------------------------
    var fair = [[-34, 5.2], [-13, 5.0], [11, 5.0], [30, 5.6]];
    for (i = 0; i < fair.length; i++) {
      var fx2 = fair[i][0];
      var bo = L.bollards[i === 0 ? 1 : (i === 1 ? 2 : (i === 2 ? 4 : 6))];
      if (!bo) continue;
      var fz2 = hullPt(fx2, fair[i][1]) + 0.1;
      catenary(B, 'rope', bo.x, bo.y, bo.z, fx2, sheerY(fx2) + 0.5, fz2, 0.55, 0.075, 12);
      // ---- the spliced eye, dropped over the bollard head -------------------
      // Twelve chords of the same laid tube round the bollard, not a smooth
      // torus: this is the one part of the rope that is seen at arm's length
      // and a ring of rope has to be made of rope.
      var eyeR = 0.315, eyeSeg = 12, ep;
      for (ep = 0; ep < eyeSeg; ep++) {
        var a0 = ep / eyeSeg * 6.28318, a1 = (ep + 1) / eyeSeg * 6.28318;
        // squashed onto the long axis of the pull, the way a loaded eye sits
        var pull = Math.atan2(fx2 - bo.x, fz2 - bo.z);
        var cp = Math.cos(pull), sp = Math.sin(pull);
        var r0x = Math.cos(a0) * eyeR * 0.78, r0z = Math.sin(a0) * eyeR * 1.15;
        var r1x = Math.cos(a1) * eyeR * 0.78, r1z = Math.sin(a1) * eyeR * 1.15;
        B.add('rope', ropeTube(
          bo.x + r0x * cp - r0z * sp, bo.y + 0.02 + Math.sin(a0 * 2) * 0.012, bo.z + r0x * sp + r0z * cp,
          bo.x + r1x * cp - r1z * sp, bo.y + 0.02 + Math.sin(a1 * 2) * 0.012, bo.z + r1x * sp + r1z * cp,
          0, 0.062, 3, 7), null);
      }
      // whipping at the throat, and two frayed ends off it
      B.cyl('deck_plate', 0.084, 0.084, 0.075, bo.x + Math.sin(Math.atan2(fx2 - bo.x, fz2 - bo.z)) * 0.36,
        bo.y + 0.06, bo.z + Math.cos(Math.atan2(fx2 - bo.x, fz2 - bo.z)) * 0.36, 1.4, 0, 0, 8);
      for (ep = 0; ep < 3; ep++) {
        B.add('rope', ropeTube(bo.x - 0.10 + ep * 0.09, bo.y + 0.05, bo.z + 0.30,
          bo.x - 0.24 + ep * 0.16, bo.y - 0.02, bo.z + 0.62 + ep * 0.05,
          0.05, 0.016, 4, 6), null);
      }
      // rat guard
      B.cyl('deck_plate', 0.50, 0.50, 0.03, (bo.x + fx2) * 0.5, (bo.y + sheerY(fx2) + 0.5) * 0.5 - 0.45,
        (bo.z + fz2) * 0.5, 0.5, 0, 0, 12);
    }
    B.paint = 'metal';
  }

  function pushTri(pos, nor, a, b, c) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }

  // ============================================================ MAST LIGHTING ==
  // The masts are geometry; the lights themselves are published in
  // level.practicalLights so lighting.js owns them, and the cones are published
  // in level.lightShafts so lighting/postfx can build the volumetrics that this
  // level's art direction is built around.
  function lampMast(B, L, x, z, h, N, arm) {
    var y0 = apronY(x, z, N);
    B.paint = 'quay';
    B.box('dock_concrete', 1.05, 0.55, 1.05, x, y0 + 0.16, z, 0.02);
    B.paint = 'metal';
    var K = 'deck_plate';
    B.cyl(K, 0.115, 0.21, h, x, y0 + 0.42 + h * 0.5, z, 0, 0, 0, 10);
    B.box(K, 0.62, 0.05, 0.62, x, y0 + 0.44, z, 0.008);
    // cable duct and the rung ladder up the back
    B.box(K, 0.08, h * 0.9, 0.08, x - 0.20, y0 + 0.5 + h * 0.45, z, 0.006);
    for (var i = 0; i < Math.floor(h / 0.42); i++) {
      B.cyl(K, 0.014, 0.014, 0.34, x - 0.30, y0 + 0.9 + i * 0.42, z, 0, 0, Math.PI * 0.5, 5);
    }
    // bracket arm and the head
    var hy = y0 + 0.42 + h;
    B.strut(K, x, hy - 0.35, z, x + arm * 1.15, hy + 0.30, z, 0.10, 0.10);
    B.strut(K, x, hy - 1.05, z, x + arm * 0.95, hy + 0.10, z, 0.06, 0.06);
    var hx = x + arm * 1.35;
    B.box(K, 0.95, 0.20, 0.60, hx, hy + 0.42, z, 0.03);
    B.boxR(K, 0.95, 0.10, 0.30, hx, hy + 0.30, z, 0.30, 0, 0, 0.02);
    // the lit aperture, facing down
    B.add('glass_lit', quad(0.78, 0.46, 0, 0, 1, 1), makeM(hx, hy + 0.30, z, Math.PI * 0.5, 0, 0));
    L.lightShafts.push({
      origin: new THREE.Vector3(hx, hy + 0.24, z),
      dir: new THREE.Vector3(0, -1, 0),
      width: 2.4, length: hy + 0.24 - y0, strength: 1.0, kind: 'mast'
    });
    return { x: hx, y: hy + 0.30, z: z, ground: y0 };
  }

  // ---------------------------------------------------------------------------
  // A HIGH MAST: a 25-26 m tapered tower carrying a crown of six flood heads.
  //
  // This is what a container terminal is actually lit from, and its absence was
  // measurable rather than a matter of taste. Every previous lamp in this level
  // topped out at 13.5 m with its aim point on the ground within 4.5 m of its
  // own base, so NOTHING in the terminal was lit above 13.5 m - while the crane
  // apex is at 30 m, the ship's accommodation block reaches 28 m and the
  // warehouse ridge is 10.2 m. The consequences were both of the level's worst
  // remaining numbers: the crane was a flat black cut-out (crane.png mean
  // 0.0979, the only red-flagged capture) and the top third of five framings
  // was empty.
  //
  // A 26 m head also puts a 26 m column of lit rain in the frame, gives a high
  // camera something at its own eye level, and is the one fixture in the yard
  // whose cone reaches the crane's upper lattice at all.
  // ---------------------------------------------------------------------------
  function highMast(B, L, x, z, h, N, heads, tilt) {
    var y0 = apronY(x, z, N);
    var KS = 'struct_steel', K = 'deck_plate';
    var i;
    B.paint = 'quay';
    B.box('dock_concrete', 2.30, 0.95, 2.30, x, y0 + 0.30, z, 0.03);
    B.box('dock_concrete', 1.70, 0.30, 1.70, x, y0 + 0.86, z, 0.02);
    B.paint = 'metal';
    // base flange and holding-down bolts
    B.cyl(K, 0.62, 0.62, 0.09, x, y0 + 1.02, z, 0, 0, 0, 12);
    for (i = 0; i < 8; i++) {
      var ba = i * 0.7854;
      B.cyl(K, 0.038, 0.038, 0.16, x + Math.cos(ba) * 0.50, y0 + 1.10, z + Math.sin(ba) * 0.50,
        0, 0, 0, 6);
    }
    // three tapered sections with a slip joint between each
    var secs = [[0.44, 0.36], [0.36, 0.29], [0.29, 0.20]];
    var sy = y0 + 1.06, sh = h / 3;
    for (i = 0; i < 3; i++) {
      B.cyl(KS, secs[i][1], secs[i][0], sh, x, sy + sh * 0.5, z, 0, 0, 0, 12);
      if (i < 2) B.cyl(K, secs[i][1] + 0.05, secs[i][1] + 0.05, 0.14, x, sy + sh, z, 0, 0, 0, 12);
      sy += sh;
    }
    // the climbing ladder and its cable duct, up the landward face
    B.box(KS, 0.09, h * 0.94, 0.09, x - 0.36, y0 + 1.2 + h * 0.47, z, 0.006);
    for (i = 0; i < Math.floor(h / 0.46); i++) {
      B.cyl(K, 0.015, 0.015, 0.40, x - 0.50, y0 + 1.6 + i * 0.46, z, 0, 0, Math.PI * 0.5, 5);
    }
    // ---- the crown ----------------------------------------------------------
    var cy = y0 + 1.06 + h;
    B.cyl(K, 1.55, 1.30, 0.22, x, cy + 0.10, z, 0, 0, 0, 12);
    B.cyl(K, 1.62, 1.62, 0.09, x, cy + 0.34, z, 0, 0, 0, 12);
    heads = heads || 6;
    for (i = 0; i < heads; i++) {
      var a = i / heads * 6.28318 + 0.4;
      var hx = x + Math.cos(a) * 1.40, hz = z + Math.sin(a) * 1.40;
      // yoke, housing and the lit aperture, all canted down and outward
      B.cyl(K, 0.055, 0.055, 0.34, hx, cy + 0.28, hz, 0, 0, 0, 6);
      B.boxR(K, 0.86, 0.24, 0.62, hx, cy + 0.05, hz, 0.62, -a, 0, 0.02);
      B.boxR(K, 0.90, 0.09, 0.26, hx, cy - 0.09, hz, 0.62, -a, 0.0, 0.015);
      B.add('glass_lit', quad(0.70, 0.44, 0, 0, 1, 1),
        makeM(hx, cy - 0.13, hz, Math.PI * 0.5 - 0.55, -a, 0));
    }
    // obstruction beacon on the mast head
    B.cyl(K, 0.11, 0.14, 0.42, x, cy + 0.55, z, 0, 0, 0, 8);
    B.add('glass_red', quad(0.30, 0.30, 0, 0, 1, 1), makeM(x, cy + 0.82, z, Math.PI * 0.5, 0, 0));
    L.addCollider(x, y0 + h * 0.5, z, 0.50, h * 0.5, 0.50, 'metal');
    if (tilt) { /* the aim is published in the rig table, not built into the crown */ }
    return { x: x, y: cy - 0.10, z: z, ground: y0 };
  }

  // ---------------------------------------------------------------------------
  // A LOW RAKING FLOOD on a stub column. The masts light DISCS; a terminal also
  // has fittings that throw almost flat along the ground - quay-edge floods,
  // a lighting tower left rigged, the wall packs over a shed door - and those
  // are what put a lit surface between the pools.
  //
  // Grazing incidence is also the only geometry in which wet concrete pays out:
  // at 80 degrees off normal a water film reflects most of what hits it, so a
  // flat beam across a soaked apron draws a long specular streak where a mast
  // directly overhead draws a diffuse disc. It is the single strongest thing
  // available for the ground plane in this level, and none of it existed.
  //
  // A low fitting is also SAFE to make bright: lighting.js caps the volumetric
  // halo of anything under 3 m of mounting height, and the camera can never end
  // up inside a cone whose apex is at head height, which is the failure that
  // filled half of the first quay capture with flat orange.
  // ---------------------------------------------------------------------------
  function lowFlood(B, L, x, z, h, N, yaw, pitch) {
    var y0 = apronY(x, z, N);
    var K = 'deck_plate';
    B.paint = 'quay';
    B.box('dock_concrete', 0.72, 0.34, 0.72, x, y0 + 0.10, z, 0.02);
    B.paint = 'metal';
    B.cyl(K, 0.075, 0.11, h, x, y0 + 0.24 + h * 0.5, z, 0, 0, 0, 8);
    B.box(K, 0.44, 0.05, 0.44, x, y0 + 0.26, z, 0.006);
    // the head: a rectangular flood on a yoke, canted down a few degrees
    var hy = y0 + 0.24 + h;
    var cs = Math.cos(yaw), sn = Math.sin(yaw);
    B.pushXYZ(x, hy, z, 0, yaw, 0);
    B.box(K, 0.14, 0.40, 0.14, 0, 0.16, 0, 0.008);
    B.boxR(K, 0.30, 0.46, 0.62, 0, 0.36, 0.16, pitch, 0, 0, 0.02);
    B.boxR(K, 0.06, 0.40, 0.10, -0.20, 0.36, 0.16, pitch, 0, 0, 0.008);
    B.boxR(K, 0.06, 0.40, 0.10, 0.20, 0.36, 0.16, pitch, 0, 0, 0.008);
    // hood and the lit lens facing along the throw
    B.boxR(K, 0.40, 0.10, 0.26, 0, 0.58, 0.28, pitch, 0, 0, 0.01);
    B.add('glass_lit', quad(0.30, 0.36, 0, 0, 1, 1),
      makeM(0, 0.36 - Math.sin(pitch) * 0.30, 0.48, pitch, 0, 0));
    // the drop cable, clipped down the column
    B.pop();
    B.cyl(K, 0.022, 0.022, h * 0.85, x - 0.13 * cs, y0 + 0.3 + h * 0.42, z + 0.13 * sn, 0, 0, 0, 5);
    L.addCollider(x, y0 + h * 0.5, z, 0.22, h * 0.5, 0.22, 'metal');
    return { x: x, y: hy + 0.36, z: z, ground: y0 };
  }

  // ============================================================ THE FENCE ====
  // Chain-link is an ALPHA-TESTED surface or it is a wall, so this generates its
  // own mesh texture rather than trusting a name lookup to come back with an
  // alpha channel. If materials.js does supply `chainlink`, that wins.
  function chainLinkTexture() {
    var cv, g;
    try {
      cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      g = cv.getContext('2d');
    } catch (e) { return null; }
    if (!g) return null;
    g.clearRect(0, 0, 256, 256);
    g.lineCap = 'round';
    var pitch = 32;
    for (var pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass === 0 ? 'rgba(24,27,30,0.95)' : 'rgba(176,186,192,0.95)';
      g.lineWidth = pass === 0 ? 7.5 : 4.5;
      for (var i = -8; i < 16; i++) {
        g.beginPath();
        for (var k = 0; k <= 16; k++) {
          var y = k * pitch * 0.5;
          var x = i * pitch + ((k % 2) ? pitch * 0.5 : 0);
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        g.beginPath();
        for (k = 0; k <= 16; k++) {
          y = k * pitch * 0.5;
          x = i * pitch - ((k % 2) ? pitch * 0.5 : 0);
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    var t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }

  function fenceRun(B, L, x0, z0, x1, z1, N, gate) {
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    var n = Math.max(1, Math.round(len / 3.0));
    var ux = dx / len, uz = dz / len;
    var yaw = Math.atan2(ux, uz);
    var K = 'deck_plate';
    var i;
    for (i = 0; i <= n; i++) {
      var px = x0 + dx * i / n, pz = z0 + dz * i / n;
      if (gate && px > gate[0] && px < gate[1]) continue;
      var py = apronY(px, pz, N);
      B.cyl(K, 0.045, 0.055, 2.55, px, py + 1.28, pz, 0, 0, 0, 8);
      // barbed-wire arm, canted outward
      B.strut(K, px, py + 2.45, pz, px + uz * 0.42, py + 2.90, pz - ux * 0.42, 0.035, 0.035);
    }
    for (i = 0; i < n; i++) {
      var ax = x0 + dx * i / n, az = z0 + dz * i / n;
      var bx = x0 + dx * (i + 1) / n, bz = z0 + dz * (i + 1) / n;
      var mx = (ax + bx) * 0.5, mz = (az + bz) * 0.5;
      if (gate && mx > gate[0] && mx < gate[1]) continue;
      var my = apronY(mx, mz, N);
      var seg = len / n;
      B.paint = 'clad';
      B.add('chainlink', quad(seg, 2.35, 0, 0, seg / 2.35 * 1.35, 1.35),
        makeM(mx, my + 1.20, mz, 0, yaw + Math.PI * 0.5, 0));
      B.paint = 'metal';
      // top and bottom tension rails
      B.strut(K, ax, my + 2.40, az, bx, my + 2.40, bz, 0.032, 0.032);
      B.strut(K, ax, my + 0.10, az, bx, my + 0.10, bz, 0.026, 0.026);
      // three barbed strands on the arms
      for (var s = 0; s < 3; s++) {
        catenary(B, K, ax + uz * (0.14 + s * 0.14), my + 2.55 + s * 0.16, az - ux * (0.14 + s * 0.14),
          bx + uz * (0.14 + s * 0.14), my + 2.55 + s * 0.16, bz - ux * (0.14 + s * 0.14),
          0.05, 0.013, 3);
      }
      L.addCollider(mx, my + 1.3, mz, Math.abs(ux) * seg * 0.5 + 0.08, 1.3,
        Math.abs(uz) * seg * 0.5 + 0.08, 'metal');
    }
  }

  function buildFence(L, B, rng, N) {
    var gate = [-5.5, 5.5];
    fenceRun(B, L, WEST_X, SOUTH_Z, EAST_X, SOUTH_Z, N, gate);
    fenceRun(B, L, WEST_X, SOUTH_Z, WEST_X, -6.0, N, null);
    fenceRun(B, L, EAST_X, SOUTH_Z, EAST_X, -6.0, N, null);
    // gate posts and one leaf swung open into the yard
    var K = 'deck_plate';
    for (var s = -1; s <= 1; s += 2) {
      var gx = s * 5.5, gy = apronY(gx, SOUTH_Z, N);
      B.cyl(K, 0.10, 0.12, 3.1, gx, gy + 1.55, SOUTH_Z, 0, 0, 0, 10);
      B.strut(K, gx, gy + 3.05, SOUTH_Z, gx - s * 0.9, gy + 2.2, SOUTH_Z, 0.05, 0.05);
    }
    // the open leaf
    B.pushXYZ(-5.4, apronY(-5.4, SOUTH_Z, N), SOUTH_Z, 0, -1.05, 0);
    B.box(K, 5.2, 0.09, 0.09, 2.6, 2.25, 0, 0.008);
    B.box(K, 5.2, 0.09, 0.09, 2.6, 0.18, 0, 0.008);
    B.box(K, 0.09, 2.2, 0.09, 5.15, 1.2, 0, 0.008);
    B.strut(K, 0.05, 0.20, 0, 5.15, 2.20, 0, 0.05, 0.05);
    B.paint = 'clad';
    B.add('chainlink', quad(5.1, 2.0, 0, 0, 3.4, 1.3), makeM(2.6, 1.22, 0, 0, Math.PI * 0.5, 0));
    B.paint = 'metal';
    B.pop();
    L.addCollider(-3.0, 1.2, SOUTH_Z - 2.3, 2.6, 1.2, 0.12, 'metal');
  }

  // ========================================================== THE PORTACABIN ==
  function buildPortacabin(L, B, rng, N) {
    var x = CABIN_X, z = CABIN_Z, w = 7.4, d = 3.1, h = 2.62;
    var y0 = apronY(x, z, N);
    var K = 'corrugated_roof';
    B.pushXYZ(x, y0, z, 0, CABIN_YAW - 0.10, 0);
    B.paint = 'clad';
    // concrete blocks under the corners
    B.paint = 'quay';
    for (var s = -1; s <= 1; s += 2) {
      for (var t = -1; t <= 1; t += 2) {
        B.box('dock_concrete', 0.55, 0.40, 0.55, s * (w * 0.5 - 0.5), 0.20, t * (d * 0.5 - 0.4), 0.02);
      }
    }
    B.paint = 'clad';
    // chassis and body
    B.box('deck_plate', w, 0.22, d, 0, 0.50, 0, 0.02);
    cladPanel(B, K, '-z', -d * 0.5, -w * 0.5, w * 0.5, 0.60, 0.60 + h, 0.20, 0.020);
    cladPanel(B, K, '+z', d * 0.5, -w * 0.5, w * 0.5, 0.60, 0.60 + h, 0.20, 0.020);
    cladPanel(B, K, '-x', -w * 0.5, -d * 0.5, d * 0.5, 0.60, 0.60 + h, 0.20, 0.020);
    cladPanel(B, K, '+x', w * 0.5, -d * 0.5, d * 0.5, 0.60, 0.60 + h, 0.20, 0.020);
    B.box(K, w + 0.24, 0.10, d + 0.24, 0, 0.62 + h, 0, 0.02);
    B.box('deck_plate', w + 0.30, 0.09, 0.10, 0, 0.60 + h + 0.10, -d * 0.5 - 0.12, 0.01);
    // windows on the yard face, lit
    for (var i = 0; i < 3; i++) {
      var wx = -1.9 + i * 1.9;
      B.box('deck_plate', 1.32, 0.90, 0.06, wx, 1.86, -d * 0.5 - 0.03, 0.008);
      B.add('glass_lit', quad(1.20, 0.78, 0, 0, 1, 1), makeM(wx, 1.86, -d * 0.5 - 0.075, 0, Math.PI, 0));
      // a blind, half down in one of them
      if (i === 1) B.box('tarpaulin', 1.18, 0.36, 0.02, wx, 2.10, -d * 0.5 - 0.10, 0.004);
    }
    // door and steps at the west end
    B.box('deck_plate', 0.10, 2.02, 0.90, -w * 0.5 - 0.04, 1.61, 0.55, 0.01);
    B.box('deck_plate', 0.05, 0.42, 0.42, -w * 0.5 - 0.10, 2.32, 0.55, 0.008);
    for (i = 0; i < 3; i++) {
      B.box('deck_plate', 0.95, 0.06, 0.34, -w * 0.5 - 0.55, 0.24 + i * 0.20, 0.55, 0.008);
      L.addCollider(x - w * 0.5 - 0.55, y0 + 0.15 + i * 0.20, z + 0.55, 0.5, 0.10, 0.2, 'metal', true);
    }
    railing(B, 'deck_plate', -w * 0.5 - 1.0, 0.62, 0.10, -w * 0.5 - 1.0, 0.62, 1.00, 0.95);
    // aerial, cable drop and a satellite dish
    B.cyl('deck_plate', 0.018, 0.018, 2.4, w * 0.5 - 0.7, 0.62 + h + 1.2, 0.6, 0, 0, 0, 6);
    B.cyl('deck_plate', 0.34, 0.34, 0.06, w * 0.5 - 0.35, 0.62 + h + 0.45, -0.8, 0.9, 0.4, 0, 12);
    B.pop();
    B.paint = 'metal';
    L.addCollider(x, y0 + 0.6 + h * 0.5, z, w * 0.5, h * 0.5 + 0.35, d * 0.5, 'metal');
    // power drop from the nearest mast
    catenary(B, 'deck_plate', x - 3.4, y0 + 3.5, z, x - 9.0, y0 + 5.6, z - 3.0, 0.55, 0.022, 6);
  }

  // ===================================================== THE TOPPLED CONTAINER ==
  // The set piece in the lane. A 40 ft box rolled onto its flank, one door leaf
  // burst off its hinges and the load out on the concrete. It is deliberately
  // on the leading line from the spawn, and it is the only thing in the yard
  // that is not orthogonal - which is what makes the rest of the yard read as
  // deliberately orthogonal rather than as a grid nobody thought about.
  function buildToppled(L, B, rng, N) {
    var cx = -7.2, cz = 2.4, roll = -1.50, yaw = 0.30;
    var gy = apronY(cx, cz, N);
    L.toppled = { x: cx, z: cz, y: gy, roll: roll, yaw: yaw };
    B.pushXYZ(cx, gy + C_W * 0.5 + 0.02, cz, 0, yaw, 0);
    B.push(makeM(0, 0, 0, roll, 0, 0));
    // the burst door leaf, hanging off one hinge
    var K = 'container_steel';
    B.paint = 'clad';
    var loop = corrugationLoop(1.14, 0.238, 0.017, 0.010, 0.02, 9.1);
    var leaf = extrudeY(loop, -1.16, 1.16, false);
    B.add(K, leaf, makeM(C40_L * 0.5 + 0.55, -0.35, 0.62, 0.22, Math.PI * 0.5, -0.62));
    // the second leaf, flat on the ground beyond
    var loop2 = corrugationLoop(1.14, 0.238, 0.017, 0.010, 0.03, 4.4);
    var leaf2 = extrudeY(loop2, -1.16, 1.16, false);
    B.add(K, leaf2, makeM(C40_L * 0.5 + 2.4, -1.16, -0.9, 1.34, 0.4, 1.05));
    B.pop();
    B.pop();

    // ---- the spilled load ----------------------------------------------------
    // Big items only: the small debris belongs to props_harbor.
    B.paint = 'clad';
    var ang = yaw;
    var ox = Math.cos(ang), oz = Math.sin(ang);
    for (var i = 0; i < 9; i++) {
      var d = 7.4 + i * 0.85 + rng.range(-0.3, 0.3);
      var lat = rng.range(-2.2, 2.2);
      var px = cx + ox * d - oz * lat, pz = cz + oz * d + ox * lat;
      var py = apronY(px, pz, N);
      var wgt = rng.range(0.65, 1.15);
      B.boxR('tarpaulin', 1.15 * wgt, 0.90 * wgt, 1.15 * wgt, px, py + 0.45 * wgt, pz,
        rng.range(-0.3, 0.3), rng.range(0, 3.14), rng.range(-0.3, 0.3), 0.03);
      B.boxR('deck_plate', 1.20 * wgt, 0.12, 1.22 * wgt, px, py + 0.06, pz,
        0, rng.range(0, 3.14), 0, 0.012);
      L.addCollider(px, py + 0.5 * wgt, pz, 0.62 * wgt, 0.5 * wgt, 0.62 * wgt, 'wood');
    }
    // a run of steel drums out of the doorway
    for (i = 0; i < 6; i++) {
      var dx2 = cx + ox * (6.0 + i * 1.1) - oz * rng.range(-2.6, 1.2);
      var dz2 = cz + oz * (6.0 + i * 1.1) + ox * rng.range(-2.6, 1.2);
      var dy2 = apronY(dx2, dz2, N);
      var lying = rng.next() < 0.5;
      if (lying) {
        B.cyl('deck_plate', 0.29, 0.29, 0.88, dx2, dy2 + 0.29, dz2,
          Math.PI * 0.5, rng.range(0, 3.14), 0, 14);
        L.addCollider(dx2, dy2 + 0.29, dz2, 0.44, 0.29, 0.44, 'metal');
      } else {
        B.cyl('deck_plate', 0.29, 0.29, 0.88, dx2, dy2 + 0.44, dz2, 0, 0, 0, 14);
        for (var r = 0; r < 2; r++) {
          B.cyl('deck_plate', 0.31, 0.31, 0.05, dx2, dy2 + 0.26 + r * 0.36, dz2, 0, 0, 0, 14);
        }
        L.addCollider(dx2, dy2 + 0.44, dz2, 0.30, 0.44, 0.30, 'metal');
      }
    }
    B.paint = 'metal';
    // the container itself is placed as a rolled INSTANCE by _buildContainers
  }

  // ---------------------------------------------------------------------------
  // COVER, placed on the rhythm the corridors need rather than scattered. The
  // hero canyon runs 38 m; nothing in it should leave a player more than about
  // ten metres from the next thing they can get behind, and the pieces are
  // deliberately DIFFERENT heights - 1.0 m you shoot over, 1.7 m you shoot
  // round, 2.6 m you cannot see past - so the lane reads as a sequence rather
  // than as a row of identical blocks.
  // ---------------------------------------------------------------------------
  function buildYardCover(L, B, rng, N) {
    var i;
    var HERO_X = (ROWS_W[4] + ROWS_W[5]) * 0.5;
    var bins = [
      [HERO_X + 2.05, 13.6, 0.42], [HERO_X - 2.35, 3.2, -0.85],
      [HERO_X + 1.85, -7.4, 1.35], [HERO_X - 2.15, -19.6, 0.15],
      [-36.04, 4.6, 0.60],                       // in the dead-end slot
      [24.6, 8.4, -0.40], [30.2, -4.6, 1.10],    // the east block's wide lane
      [-9.4, 25.6, 0.25], [11.2, -18.4, -1.20]   // the open lane
    ];
    for (i = 0; i < bins.length; i++) {
      var bx = bins[i][0], bz = bins[i][1];
      twistlockBin(B, L, bx, apronY(bx, bz, N), bz, bins[i][2], rng);
      L._blockers.push([bx - 0.9, bx + 0.9, bz - 0.9, bz + 0.9]);
    }
    var racks = [
      [HERO_X - 1.95, 9.0, 0.10], [HERO_X + 2.20, -13.0, -0.06],
      [27.0, -15.8, 1.52], [-4.6, 20.8, 0.90], [-31.9, -22.4, 0.30]
    ];
    for (i = 0; i < racks.length; i++) {
      var rx = racks[i][0], rz = racks[i][1];
      lashingRack(B, L, rx, apronY(rx, rz, N), rz, racks[i][2], rng);
      L._blockers.push([rx - 1.4, rx + 1.4, rz - 1.4, rz + 1.4]);
    }
    var gens = [[HERO_X + 1.55, -25.0, 0.08], [13.6, 6.2, 1.62], [-16.0, -26.4, -0.20]];
    for (i = 0; i < gens.length; i++) {
      var gx = gens[i][0], gz = gens[i][1];
      gensetPack(B, L, gx, apronY(gx, gz, N), gz, gens[i][2]);
      L._blockers.push([gx - 1.9, gx + 1.9, gz - 1.9, gz + 1.9]);
    }
    // ---- the overview framing's foreground ----------------------------------
    // A stillage and a bar rack standing on the container roof the establishing
    // shot is taken from, 2.4 and 4.0 m out and just left of the axis. The
    // critique against that frame was that the nearest object was 25 m away and
    // the near corner of the picture was a void; these give it a front plane.
    // The roof is only 2.44 m wide, so "3 m out" is as far forward as anything
    // can stand before it is off the edge - which is why these are placed by
    // offset from the eye rather than eyeballed, and why there are two of them
    // and not four.
    var ovT = overviewStandY(L);
    if (ovT) {
      twistlockBin(B, L, ROWS_W[4] - 0.13, ovT + 0.02, OV_Z - 3.05, 0.62, rng);
      // a stanchion lamp on the roof edge: the near plane needs a SOURCE in it,
      // or the foreground is a black cut-out over a lit distance
      B.box('deck_plate', 0.085, 1.55, 0.085, ROWS_W[4] + 0.95, ovT + 0.78,
        OV_Z - 0.39, 0.008);
      B.box('deck_plate', 0.28, 0.17, 0.20, ROWS_W[4] + 0.95, ovT + 1.62,
        OV_Z - 0.39, 0.012);
      B.add('glass_lit', quad(0.22, 0.14, 0, 0, 1, 1),
        makeM(ROWS_W[4] + 0.95, ovT + 1.53, OV_Z - 0.30, Math.PI * 0.40, 0, 0));
      // a coil of lashing chain flaked down on the roof, for a soft shape
      // against all those right angles
      for (var cq = 0; cq < 5; cq++) {
        var ca2 = cq / 5 * 6.28318;
        catenary(B, 'rope', ROWS_W[4] + 0.30 + Math.cos(ca2) * 0.46, ovT + 0.06,
          OV_Z - 1.55 + Math.sin(ca2) * 0.46,
          ROWS_W[4] + 0.30 + Math.cos(ca2 + 1.26) * 0.46, ovT + 0.06,
          OV_Z - 1.55 + Math.sin(ca2 + 1.26) * 0.46, 0.0, 0.030, 3);
      }
    }
    // the bar rack lives on the apron now, not on the establishing shot's roof
    lashingRack(B, L, HERO_X + 2.35, apronY(HERO_X + 2.35, 16.4, N), 16.4, -0.28, rng);
  }

  // The roof the establishing shot stands on: row 4, bay 2 of the west block -
  // a four-high stack forming the hero canyon's west wall at its landward end.
  // Both the pose and its foreground props derive their height from this one
  // function, so they cannot drift apart when the layout moves.
  var OV_Z = BAYS_W[2] + BAYOFF_W[4][2];
  function overviewStandY(L) {
    for (var i = 0; i < L.stacks.length; i++) {
      var st = L.stacks[i];
      if (st.side === 'W' && st.row === 4 && st.bay === 2) {
        return (st.top !== undefined) ? st.top
          : (L.sampleGround(st.x, st.z) + st.n * C_H + (st.n - 1) * 0.014);
      }
    }
    return apronY(ROWS_W[4], OV_Z, L.noise) + 4 * C_H + 3 * 0.014;
  }

  // ======================================================= STACKED TARPAULINS ==
  function buildTarpStacks(L, B, rng, N) {
    var spots = [[-18.6, 22.0, 0.25], [-16.2, 28.6, -0.4], [26.5, 8.0, 0.8], [30.0, 4.5, 0.1]];
    B.paint = 'clad';
    for (var i = 0; i < spots.length; i++) {
      var x = spots[i][0], z = spots[i][1], a = spots[i][2];
      var y0 = apronY(x, z, N);
      B.pushXYZ(x, y0, z, 0, a, 0);
      var layers = 4 + (i & 1);
      for (var k = 0; k < layers; k++) {
        B.box('deck_plate', 2.45, 0.14, 1.25, 0, 0.07 + k * 0.36, 0, 0.012);
        B.box('tarpaulin', 2.30, 0.24, 1.14, 0, 0.26 + k * 0.36, 0, 0.03);
      }
      // the sheet over the top, sagging between the corners
      B.boxR('tarpaulin', 2.85, 0.06, 1.75, 0, 0.16 + layers * 0.36, 0,
        0.03, 0, -0.04, 0.02);
      for (var e = 0; e < 4; e++) {
        var ex = (e & 1) ? 1.3 : -1.3, ez = (e & 2) ? 0.8 : -0.8;
        catenary(B, 'rope', ex, 0.16 + layers * 0.36, ez, ex * 1.25, 0.02, ez * 1.3, 0.10, 0.020, 3);
      }
      B.pop();
      L.addCollider(x, y0 + layers * 0.20, z, 1.45, layers * 0.20, 0.95, 'wood');
    }
    B.paint = 'metal';
  }

  // ============================================================== THE LEVEL ==
  function LevelHarbor(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_harbor';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.instanced = [];
    // Published anchors for anyone who can draw a volumetric cone:
    // {origin, dir, width, length, strength, kind}. `dir` is the direction of
    // TRAVEL of the light. Purely additive - a consumer that ignores it costs
    // nothing.
    this.lightShafts = [];
    // Overrides lighting.js's own PRACTICALS table: the level knows where the
    // masts actually are, and this level's whole look is pools of lamp light
    // with genuine darkness between them.
    this.practicalLights = [];
    // Where water runs off a horizontal member and falls. weather.js owns
    // drips - the weather contract puts them in its court, and a level that
    // models its own ends up with two uncoordinated systems shedding water off
    // the same girder - so this file publishes the EDGES and nothing else.
    // {a:Vector3, b:Vector3, fall:metres, rate:0..1, kind}
    this.dripEdges = [];
    // The basin, for anyone who wants to put rain impacts on it.
    this.waterPlane = null;
    this.wetPatches = [];
    this.bollards = [];
    this.stacks = [];
    this.rowsW = ROWS_W;
    this.rowsE = ROWS_E;
    this.toppled = null;
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(5.0);
    this._stamp = 0;
    this._blockers = [];
    this._water = null;
    this._waters = null;
    this._atlasOk = false;
    this._t = 0;
    this._normalTick = 0;
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x4841524) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x48420);
    // Storm is the harbour's only condition and weather.js builds AFTER the
    // level, so the baked wetness comes from the level definition rather than
    // from a system that does not exist yet.
    var wx = 0.92;
    try {
      if (ctx && ctx.levelDef && ctx.levelDef.weather === 'drizzle') wx = 0.55;
      if (ctx && ctx.levelDef && ctx.levelDef.weather === 'clear') wx = 0.10;
    } catch (e) { /* storm */ }
    this.wetness = wx;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(WEST_X - 6, WATER_Y - 4, -70),
      new THREE.Vector3(EAST_X + 6, 34, SOUTH_Z + 6));
    this.mastRig = [];
    // THE PLACEMENT CONTRACT. Available before build() so a system that wants
    // to know where the warehouse is does not have to wait for, or guess at, a
    // camera pose. See the header of this file.
    this.anchors = buildAnchors(this.noise);
  }

  // ---------------------------------------------------------------------------
  // Every anchor is derived from the same constants the geometry is, so an
  // anchor and the thing it names cannot drift apart. Nothing in here reads a
  // camera pose, and nothing in here is a remembered number.
  // ---------------------------------------------------------------------------
  function buildAnchors(N) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    function gy(x, z) { return apronY(x, z, N); }
    var A = {};

    A.yard = {
      x0: WEST_X, x1: EAST_X, z0: QUAY_Z, z1: SOUTH_Z,
      laneHalf: LANE_HALF, waterY: WATER_Y,
      groundY: function (x, z) { return apronY(x, z, N); }
    };

    A.quayEdge = {
      z: QUAY_Z,
      coping: V(0, gy(0, QUAY_Z + 0.3), QUAY_Z + 0.30),
      yaw: Math.PI,                       // facing seaward
      bollardsX: [-38, -26, -14, -2, 10, 22, 34],
      ladderX: [-20, 18]
    };

    A.crane = {
      legX: CR_LEG_X, railA: CR_RAIL_A, railB: CR_RAIL_B,
      sill: CR_SILL, apex: CR_APEX, tipZ: CR_TIP_Z, backZ: CR_BACK_Z,
      centre: V(0, 0, (CR_RAIL_A + CR_RAIL_B) * 0.5),
      walkway: V(0, CR_SILL + 0.06, CR_RAIL_A),
      stairFoot: V(-CR_LEG_X, gy(-CR_LEG_X, CR_RAIL_B + 3.8), CR_RAIL_B + 3.8),
      machineHouse: V(0, 27.0, CR_RAIL_B - 2.2)
    };

    A.warehouse = {
      x0: WH_X0, x1: WH_X1, z0: WH_Z0, z1: WH_Z1,
      faceX: WH_FACE, outX: WH_OUT, eave: WH_EAVE, ridge: WH_RIDGE, floorY: 0.14,
      centre: V((WH_X0 + WH_X1) * 0.5, 0.14, (WH_Z0 + WH_Z1) * 0.5),
      // the yard face looks along -X, so a prop that belongs "outside the doors"
      // belongs at x < WH_X0
      yaw: Math.PI * 0.5 * WH_OUT,
      doorOpen: V(WH_FACE, 0.14, 20.0),
      doorBuckled: V(WH_FACE, 0.14, 28.6),
      roofHole: V(29.4, WH_RIDGE - 0.6, 24.6),
      pool: V(29.4, 0.14, 24.6)
    };

    A.reeferBank = {
      x: REEFER_X, z0: REEFER_Z0, z1: REEFER_Z0 + 2 * 2.92,
      rows: [REEFER_Z0, REEFER_Z0 + 2.92, REEFER_Z0 + 5.84],
      centre: V(REEFER_X, gy(REEFER_X, REEFER_Z0 + 2.92), REEFER_Z0 + 2.92),
      // the machinery ends face +X, into the lane the player spawns looking up
      machineFace: V(REEFER_X + C40_L * 0.5, 1.3, REEFER_Z0 + 2.92),
      socketRack: V(REEFER_X + C40_L * 0.5 + 3.6, 1.3, REEFER_Z0 + 2.92),
      yaw: 0, length: C40_L, high: 3
    };

    A.portacabin = {
      centre: V(CABIN_X, gy(CABIN_X, CABIN_Z), CABIN_Z),
      yaw: CABIN_YAW - 0.10, width: 7.4, depth: 3.1, height: 2.62,
      // the lit window face looks -Z in the cabin's own frame; in world terms
      // the yaw above turns that toward -X, i.e. back down the lane
      windowFace: V(CABIN_X - 1.65, 1.86, CABIN_Z),
      doorSide: V(CABIN_X + 0.55, 0.4, CABIN_Z + 3.75)
    };

    A.freighter = {
      z: SHIP_Z, deckY: SHIP_DECK, bowX: SHIP_BOW_X, sternX: SHIP_STERN_X,
      gangwayFoot: V(-6.0, gy(-6.0, QUAY_Z + 1.0), QUAY_Z + 1.0),
      gangwayHead: V(-9.5, SHIP_DECK - 1.4, SHIP_Z + 1.0)
    };

    // Corridor centre lines, computed from the row pitch rather than recalled.
    function gaps(rows, halfW) {
      var out = [];
      for (var i = 0; i + 1 < rows.length; i++) {
        var w = (rows[i + 1] - halfW * 2) - rows[i];
        if (w > 2.4 && w < 8.0) out.push((rows[i] + rows[i + 1]) * 0.5);
      }
      return out;
    }
    A.containersW = {
      rowsX: ROWS_W.slice(), baysZ: BAYS_W.slice(),
      corridorsX: gaps(ROWS_W, C_W * 0.5),
      heroCorridorX: (ROWS_W[4] + ROWS_W[5]) * 0.5,
      mouthZ: BAYS_W[2] + C40_L * 0.5,
      endZ: BAYS_W[0] - C40_L * 0.5,
      width: C_W, length: C40_L, unitH: C_H
    };
    A.containersE = {
      rowsZ: ROWS_E.slice(), baysX: BAYS_E.slice(),
      corridorsZ: gaps(ROWS_E, C_W * 0.5),
      width: C_W, length: C40_L, unitH: C_H
    };

    A.toppled = {
      centre: V(-7.2, gy(-7.2, 2.4) + C_W * 0.5, 2.4),
      yaw: 0.30, roll: -1.50,
      spillDir: V(Math.cos(0.30), 0, Math.sin(0.30))
    };

    A.gate = {
      centre: V(0, gy(0, SOUTH_Z), SOUTH_Z), halfWidth: 5.5, yaw: 0
    };

    A.spawn = { centre: V(0.9, gy(0.9, 32.2), 32.2), yaw: 0.025 };

    // The lamp rig, in world coordinates, mirrored out of the same table
    // practicalLights is built from. Filled in properly once the masts are
    // built (the head height depends on the ground); this is the plan.
    A.masts = [];
    var i;
    for (i = 0; i < MASTS.length; i++) {
      var m = MASTS[i];
      A.masts.push({
        name: 'harbor_mast_' + m.n, kind: m.kind, cone: m.cone,
        base: V(m.x, gy(m.x, m.z), m.z),
        head: V(m.x + m.arm * 1.35, gy(m.x, m.z) + 0.42 + m.h + 0.30, m.z),
        aim: V(m.aim[0], m.aim[1], m.aim[2])
      });
    }
    for (i = 0; i < HIGH.length; i++) {
      var hm = HIGH[i];
      A.masts.push({
        name: 'harbor_high_' + hm.n, kind: hm.kind, cone: hm.cone,
        base: V(hm.x, gy(hm.x, hm.z), hm.z),
        head: V(hm.x, gy(hm.x, hm.z) + 1.06 + hm.h - 0.10, hm.z),
        aim: V(hm.aim[0], hm.aim[1], hm.aim[2])
      });
    }
    for (i = 0; i < RAKES.length; i++) {
      var k = RAKES[i];
      A.masts.push({
        name: 'harbor_rake_' + k.n, kind: k.kind, cone: k.cone,
        base: V(k.x, gy(k.x, k.z), k.z),
        head: V(k.x, gy(k.x, k.z) + 0.24 + k.h + 0.36, k.z),
        aim: V(k.aim[0], k.aim[1], k.aim[2])
      });
    }
    return A;
  }

  // ---- material access, defensively -----------------------------------------
  // Every harbour material is requested BY THE NAME IN THE CONTRACT. If
  // materials.js does not know that name yet, the request falls back to a
  // library name that certainly exists and the harbour palette entry is forced
  // onto it with opts.color, so a red container is never a grey one.
  LevelHarbor.prototype.material = function (key, forInstancing) {
    var ck = key + (forInstancing ? '|i' : '|v');
    if (this._matCache[ck]) return this._matCache[ck];
    var surf = SURF[key] || SURF.dock_concrete;
    var m = null;
    var lib = this.ctx && this.ctx.materials;
    var libHas = false;
    try {
      libHas = !!(lib && typeof lib.has === 'function' && lib.has(key));
    } catch (e) { libHas = false; }

    if (key === 'decal') {
      m = this._decalMaterial();
    } else if (key === 'chainlink' && !libHas) {
      m = this._chainlinkMaterial();
    } else if (lib && typeof lib.get === 'function') {
      var name = libHas ? key : (surf.base || 'concrete');
      var opts = { vertexColors: true, wearMode: surf.wear ? 'wear' : 'multiply' };
      if (surf.emissive !== undefined) {
        opts.emissive = surf.emissive;
        opts.emissiveIntensity = surf.emissiveIntensity || 1.0;
      }
      // The sea is answered by materials.water(), whose defaults are written
      // for daylight: a 0x14313a in-scattering tint over a 7 m column reads as
      // a bright turquoise band along the coping, which at 02:00 under storm
      // cloud is the loudest wrong colour in the level. The absorption model is
      // materials.js's and stays; only the water body it is solved for is
      // declared here, because the LEVEL is what knows this is a deep,
      // silt-laden commercial basin at night and not a lagoon.
      if (key === 'sea_water') {
        opts.color = 0x070b10;
        opts.tint = 0x0a181e;
        opts.bed = 0x04070a;
        opts.depth = 14.0;
        opts.absorb = [0.72, 0.30, 0.22];
        opts.envMapIntensity = 2.2;
        opts.foam = 0x8d9ba0;
      }
      // Roughness, metalness, env response and albedo are materials.js's to
      // calibrate, and it calibrates them per harbour name with a wet/dry
      // window this file has no business second-guessing. The overrides below
      // exist ONLY for the fallback path, where the request has landed on some
      // other library entry (corrugated_metal standing in for container_red)
      // and would otherwise render as the wrong material entirely.
      if (!libHas) {
        if (surf.rough !== undefined) opts.roughness = surf.rough;
        if (surf.metal !== undefined) opts.metalness = surf.metal;
        if (surf.env !== undefined) opts.envMapIntensity = surf.env;
        if (surf.col !== undefined) opts.color = surf.col;
        if (surf.alphaTest !== undefined) {
          opts.alphaTest = surf.alphaTest; opts.side = 2;
        }
      }
      try { m = lib.get(name, opts); }
      catch (e2) { GAME.logError('harbor.material:' + key, e2); m = null; }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[ck] = m;
    return m;
  };

  LevelHarbor.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.dock_concrete;
    var surf = SURF[key] || SURF.dock_concrete;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2],
      // A stock material has no wear shader, so a WEAR MASK painted into the
      // colour attribute would be multiplied straight onto albedo - which
      // renders a soaking wet apron (R 0.4 / G 0.1 / B 0.9) as bright purple.
      // Wear surfaces therefore drop vertex colours entirely on this path.
      vertexColors: !surf.wear,
      envMapIntensity: surf.env !== undefined ? surf.env : 1.0
    });
    if (surf.emissive !== undefined) {
      m.emissive = new THREE.Color().setHex(surf.emissive, THREE.SRGBColorSpace);
      m.emissiveIntensity = surf.emissiveIntensity || 1.0;
    }
    m.name = 'harbor_fallback_' + key;
    return m;
  };

  LevelHarbor.prototype._decalMaterial = function () {
    var tex = null;
    try { tex = buildAtlas(this.rng.fork ? this.rng.fork(0xA71A5) : this.rng); }
    catch (e) { GAME.logError('harbor.atlas', e); tex = null; }
    this._atlasOk = !!tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.80, metalness: 0.0,
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
    m.name = 'harbor_markings';
    return m;
  };

  LevelHarbor.prototype._chainlinkMaterial = function () {
    var tex = null;
    try { tex = chainLinkTexture(); } catch (e) { tex = null; }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.52, metalness: 0.80,
      transparent: false, alphaTest: 0.42, side: THREE.DoubleSide,
      vertexColors: true, envMapIntensity: 1.2
    });
    if (!tex) { m.opacity = 0.22; m.transparent = true; m.alphaTest = 0; }
    m.name = 'harbor_chainlink';
    return m;
  };

  // ---- colliders -------------------------------------------------------------
  LevelHarbor.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
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

  // Is this patch of yard already occupied by a stack or a building? The puddle
  // placer asks so standing water never appears under a container.
  LevelHarbor.prototype._occupied = function (x, z, pad) {
    pad = pad || 0;
    for (var i = 0; i < this._blockers.length; i++) {
      var b = this._blockers[i];
      if (x > b[0] - pad && x < b[1] + pad && z > b[2] - pad && z < b[3] + pad) return true;
    }
    return false;
  };

  // ---- build -----------------------------------------------------------------
  LevelHarbor.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng, N = this.noise;
    var B = new Builder();
    var i;

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('harbor.' + name, e); }
    }

    // ---- plan first: the puddle placer and the navgrid both need to know
    //      where the boxes are going to stand before anything is built.
    stage('plan', function () {
      self.stacks = planContainers(self, rng);
      for (var k = 0; k < self.stacks.length; k++) {
        var f = stackFootprint(self.stacks[k]);
        self._blockers.push([f.x - f.hx, f.x + f.hx, f.z - f.hz, f.z + f.hz]);
      }
      // Reefer bank, standing in the landward lane where the player spawns
      // looking at it: humming machinery ends with their own indicator lights
      // are the strongest near-foreground the opening framing can have.
      self.reefers = [];
      for (k = 0; k < 3; k++) {
        var rz = REEFER_Z0 + k * 2.92;
        self.reefers.push({ x: REEFER_X, z: rz, n: 3 });
        self._blockers.push([REEFER_X - C40_L * 0.5, REEFER_X + C40_L * 0.5,
          rz - C_W * 0.5, rz + C_W * 0.5]);
      }
      self._blockers.push([WH_X0 - 2.5, WH_X1 + 1.5, WH_Z0 - 1, WH_Z1 + 1]);
      self._blockers.push([CABIN_X - 4.2, CABIN_X + 4.2, CABIN_Z - 2.2, CABIN_Z + 2.2]);
      self._blockers.push([-CR_LEG_X - 3.2, -CR_LEG_X + 3.2, CR_RAIL_A - 2, CR_RAIL_B + 6]);
      self._blockers.push([CR_LEG_X - 3.2, CR_LEG_X + 3.2, CR_RAIL_A - 2, CR_RAIL_B + 2]);
      self._blockers.push([-11.0, -2.0, -2.0, 12.0]);                // toppled + spill
      self._blockers.push([-21.5, -14.5, 20.0, 30.5]);               // tarp stacks
      self._blockers.push([24.5, 32.5, 4.0, 12.5]);
    });
    await GAME.yieldFrame();

    stage('apron', function () { buildApron(self, B, rng, N); });
    stage('sea', function () { buildSea(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('quay', function () { buildQuayEdge(self, B, rng, N); });
    stage('crane', function () { buildCrane(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('warehouse', function () { buildWarehouse(self, B, rng, N); });
    stage('freighter', function () { buildFreighter(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('portacabin', function () { buildPortacabin(self, B, rng, N); });
    stage('toppled', function () { buildToppled(self, B, rng, N); });
    stage('tarps', function () { buildTarpStacks(self, B, rng, N); });
    stage('fence', function () { buildFence(self, B, rng, N); });
    await GAME.yieldFrame();

    stage('masts', function () {
      self._buildMasts(B, N);
      // the rig is now standing on real ground; replace the planned anchors
      // with the built ones so the two can never disagree
      if (self.mastRig.length) self.anchors.masts = self.mastRig;
    });
    stage('containers', function () { self._buildContainers(B, rng); });
    // after the containers, because the overview framing's foreground stands on
    // a container roof and needs that stack's real top
    stage('cover', function () { buildYardCover(self, B, rng, N); });
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

  // ---- the mast lighting rig --------------------------------------------------
  // ---------------------------------------------------------------------------
  // THE LAMP RIG. Ten masts, two crane floods, two low raking floods and two
  // shed tubes - exactly lighting.js's harbour practical cap, published with
  // EXPLICIT world aim points so no lamp's direction depends on where a camera
  // happens to be standing.
  //
  // Two things were measured and both are now designed against.
  //
  // 1. COVERAGE. The rig threw eight 28-degree cones from 11.9 m, which is a
  //    6.5 m pool each: 16% of a 92 x 72 m yard lit and everything else at the
  //    ambient floor. The apron is the largest surface in five of the six
  //    framings, so 84% of it contributing nothing is exactly what the frame
  //    measured - a bottom half 3.7x darker than the top and a quarter of the
  //    frame below the visibility floor. Level 1's street lamps, which read,
  //    run cone 1.16 from 3.85 m. Cones here are 0.5-0.95 depending on how much
  //    room the fitting has, the yard masts are a metre taller, and the pools
  //    are meant to OVERLAP at their rims rather than sit as islands. That is
  //    still pools-and-darkness; it is not eight torches in a field.
  //
  // 2. THE CAMERA INSIDE THE CONE. A mast 6 m from an eye fills the frame with
  //    flat orange, because lighting.js correctly builds the volumetric from the
  //    spotlight's own angle. A wider cone makes that radius bigger, so every
  //    entry below is checked against all six published eyes: a lamp is only
  //    allowed a wide cone if (mountY - 1.65) * tan(cone) is comfortably less
  //    than its distance to the nearest eye. Where it is not - the canyon
  //    column standing in a 3.8 m slot, the east quay mast 11 m from the `quay`
  //    eye - the cone stays narrow and a low raking flood does the covering
  //    instead. `beam` is also scaled down as the cone widens, so a wider cone
  //    lights more ground WITHOUT putting more fog in the air.
  // ---------------------------------------------------------------------------
  var MASTS = [
    // ---- masts, seaward -------------------------------------------------------
    // west quay. Stood at x -13, which is 5 m from the re-solved `quay` eye and
    // therefore inside its own cone; pushed 17 m west it clears that eye by
    // 12.9 m, lights the whole west end of the quay strip the camera stands on,
    // and its cone is now a distant subject in the `gangway` framing instead of
    // a whiteout in the `quay` one.
    { n: 'quay_w', x: -30.0, z: -24.5, h: 12.5, arm: -1, kind: 'sodium', k: 2000,
      I: 720, d: 40, cone: 0.80, aim: [-26.0, 0.0, -27.0], shadow: true },
    // east quay. It used to stand at x 30, which is 7.6 m from the `quay` eye -
    // inside its own cone at any useful width, so it was stuck at a 34-degree
    // throw and the apron the hero eye stands on was the darkest ground in the
    // level. Moved 7 m further out along the quay it clears the eye by 12.6 m,
    // can open to 45 degrees, and its pool now reaches the camera's feet
    // instead of stopping 4 m short of them.
    { n: 'quay_e', x: 37.0, z: -25.0, h: 12.5, arm: 1, kind: 'sodium', k: 2000,
      I: 760, d: 40, cone: 0.78, aim: [31.0, 0.0, -22.0], shadow: true },
    // cold mercury flood over the gangway and the black water. 8.7 m from the
    // `quay` eye - outside its 5.6 m cone radius, so it is a hard cold cone
    // falling across the wet coping in the near-left of that framing, which is
    // the single image this level was written around.
    // Dimmed from 640. It is the correct fixture in the correct place - the art
    // direction asks for a cold flood over the gangway and the black water -
    // but at 640 cd it was the only thing setting the exposure AND the colour
    // of that whole framing, whose highlights and shadows both came back cold.
    // ...and warmed from 5400 K mercury to 2600 K. The cold half of this
    // level's palette is not in question - the crane's four floods, both high
    // masts, the shed tube and every lightning strike are 4200-7000 K - but ALL
    // of them plus a cold sky ambient were landing in one framing, and the
    // measurement says so: `gangway` came back with a grade_split of -0.038,
    // i.e. cold highlights over cold shadows, which is the colour grade
    // inverting. A ship alongside is worked under sodium. The cold accents in
    // that frame now come from the crane 30 m up and from the sky, which is
    // where the contrast belongs; the key light on the ladder is warm.
    { n: 'gangway_hg', x: -9.0, z: -28.6, h: 10.0, arm: -1, kind: 'sodium', k: 2600,
      I: 505, d: 32, cone: 0.56, aim: [-7.0, -1.4, -32.0] },
    // ---- masts, mid yard ------------------------------------------------------
    // The middle of the terminal had no lamp within 20 m of it in any direction
    // and it is the ground under the crane framing and half the overview.
    { n: 'mid_lane', x: 2.0, z: -6.0, h: 13.5, arm: 1, kind: 'sodium', k: 2000,
      I: 700, d: 38, cone: 0.80, aim: [4.5, 0.0, -10.0] },
    { n: 'east_apron', x: 27.0, z: 1.0, h: 13.5, arm: -1, kind: 'sodium', k: 2000,
      I: 660, d: 38, cone: 0.90, aim: [23.5, 0.0, -2.0] },
    // ---- masts, landward ------------------------------------------------------
    // the pair framing the lane the player spawns looking down
    { n: 'lane_w', x: -15.6, z: 10.0, h: 13.0, arm: -1, kind: 'sodium', k: 2000,
      I: 660, d: 38, cone: 0.84, aim: [-12.0, 0.0, 13.0] },
    { n: 'lane_e', x: 15.6, z: 10.0, h: 13.0, arm: 1, kind: 'sodium', k: 2000,
      I: 660, d: 38, cone: 0.84, aim: [12.0, 0.0, 13.0] },
    // the landward east corner, over the warehouse forecourt and the cabin
    { n: 'yard_se', x: 16.0, z: 33.0, h: 11.5, arm: 1, kind: 'sodium', k: 2000,
      I: 580, d: 32, cone: 0.74, aim: [19.5, 0.0, 28.0] },
    // ---- the canyon -----------------------------------------------------------
    // TWO columns standing IN the west corridor, hard against the stack so the
    // slot stays clear. The tall one lights the far half and puts a lit slot at
    // the end of the canyon; the short one washes the lower 2.4 m of both walls
    // in the near field, which is the half of the shot a single far mast cannot
    // reach. Both are narrow: the corridor is 3.8 m and the `containers` eye is
    // only 10.5 m from the short one.
    // (moved 0.8 m west with the corridor: the hero lane is now 6.10 m rather
    // than 3.80, so both columns stand hard against the west wall with 5.2 m of
    // clear lane beside them instead of splitting a slot in half)
    { n: 'canyon_far', x: -28.20, z: 1.0, h: 12.0, arm: 1, kind: 'sodium', k: 2000,
      I: 640, d: 32, cone: 0.52, aim: [-26.6, 0.0, 4.0] },
    { n: 'canyon_near', x: -28.20, z: 11.0, h: 6.0, arm: 1, kind: 'sodium', k: 2000,
      I: 210, d: 18, cone: 0.54, aim: [-26.6, 0.0, 13.0] }
  ];

  // ---------------------------------------------------------------------------
  // HIGH MASTS. Two towers at opposite corners of the yard, 25 and 26 m to the
  // crown, six heads each, 5600 K - the cold half of the palette against ten
  // 2000 K sodium masts. They are aimed within 13 degrees of straight down,
  // which is both what a real high mast does and what keeps every published eye
  // out of the cone: the nearest approach is the `gangway` camera 28 m from the
  // east tower, 40 degrees off its axis against a 25-degree authored cone and a
  // 37-degree skirt, and the `containers` camera 17.5 m from the west tower at
  // 27 degrees off axis - outside the visible cone, inside only the dim skirt,
  // and BEHIND the camera in that framing, where a little fill on the corridor
  // walls is worth having.
  // ---------------------------------------------------------------------------
  var HIGH = [
    // Intensity solved DOWN from a first pass at 1450: a 24 m head throwing
    // 2100 cd after lighting.js's 1.45 level gain puts 2.3 lux on a 30 m radius
    // of everything, which is a yard-wide fill rather than a pool, and it took
    // three framings from a 02:00 mean of ~0.16 to 0.23. At 880 they light the
    // upper volume and the crane's own lattice - which is what they are for -
    // without lifting the floor of the whole terminal.
    { n: 'high_e', x: 30.5, z: -19.5, h: 24.0, kind: 'mercury', k: 5600,
      I: 880, d: 46, cone: 0.44, heads: 6, aim: [25.0, 0.0, -14.0] },
    { n: 'high_w', x: -43.5, z: 19.0, h: 25.0, kind: 'mercury', k: 5600,
      I: 840, d: 46, cone: 0.40, heads: 6, aim: [-37.0, 0.0, 14.0] }
  ];

  // Low raking floods. Position, mount height, the point they throw at, and the
  // yaw/pitch the housing is built to so the fitting and the beam agree.
  var RAKES = [
    // Across the seaward apron, straight through the `quay` framing's near and
    // middle ground - the region the east quay mast cannot widen into.
    { n: 'apron_rake', x: 21.5, z: -6.5, h: 3.35, kind: 'led', k: 4200,
      I: 190, d: 48, cone: 0.30, aim: [-4.0, 0.10, -25.5] },
    // Down the spawn lane from the gate, under the crane portal. This is the
    // leading line of the `crane` and `overview` framings, and a beam running
    // along it is worth more than any amount of fill dropped on it.
    { n: 'lane_rake', x: -6.4, z: 34.6, h: 3.1, kind: 'sodium', k: 2100,
      I: 165, d: 46, cone: 0.27, aim: [1.5, 0.12, 8.0] },
    // Along the quay, throwing WEST - i.e. back INTO the `quay` and `gangway`
    // eyes from 45 m away. Direction is the whole point: a light behind the
    // camera lights concrete frontally and you get a grey floor, while a light
    // in front of it puts the specular lobe of every wet square metre between
    // the two straight down the lens. That is the "black mirror holding
    // stretched reflections" the brief opens with, and no downward cone can
    // make it, because a mast overhead reflects into the sky, not into you.
    { n: 'quay_rake', x: 20.0, z: -28.4, h: 3.3, kind: 'mercury', k: 5200,
      I: 235, d: 58, cone: 0.26, aim: [-34.0, 0.14, -25.6] },
    // ---- the gangway working light ------------------------------------------
    // The one WARM source in the `gangway` framing, and it is there for a
    // measured reason rather than for dressing. That frame is lit almost
    // entirely by the 5400 K mercury flood the art direction asks for over the
    // accommodation ladder, plus two 5600 K crane floods, so its highlights and
    // its shadows were both cold and grade_split came back at -0.036 - the
    // metric's definition of the grade failing to land. A sodium working light
    // at the foot of the ladder is what a ship alongside actually has, it puts
    // 2100 K on the coping, the ladder and the crane leg in the middle third of
    // that frame, and it costs the rig its last practical slot.
    //
    // Checked against both eyes it can reach: 146 degrees off axis from the
    // `gangway` camera 5.7 m away (i.e. the camera sees the beam side-on, from
    // behind the fitting) and 43 degrees from the `quay` camera at 17.8 m,
    // against a 16-degree cone and a 23-degree skirt.
    { n: 'gangway_foot', x: -1.5, z: -25.0, h: 3.2, kind: 'sodium', k: 2100,
      I: 310, d: 36, cone: 0.30, aim: [-7.5, 1.2, -33.0] }
  ];

  LevelHarbor.prototype._buildMasts = function (B, N) {
    var i, d;
    this.mastRig = [];
    for (i = 0; i < MASTS.length; i++) {
      var m = MASTS[i];
      var head = lampMast(B, this, m.x, m.z, m.h, N, m.arm);
      // A wide cone lights more ground; it must not therefore also put more
      // fog in the air, or defect 2 comes straight back.
      var beam = M.clamp(0.62 / Math.max(0.30, m.cone), 0.45, 1.0);
      d = {
        name: 'harbor_mast_' + m.n,
        kind: m.kind,
        fixture: 'mast',
        pos: [head.x, head.y - 0.10, head.z],
        kelvin: m.k, intensity: m.I, distance: m.d,
        dayBase: 0.0, cone: m.cone, penumbra: 0.40, haloScale: 0.30,
        shadow: !!m.shadow, halo: 3.2 * beam, beam: beam,
        aimPos: [m.aim[0], m.aim[1], m.aim[2]]
      };
      this.practicalLights.push(d);
      this.mastRig.push({
        name: d.name, kind: m.kind, cone: m.cone,
        base: new THREE.Vector3(m.x, head.ground, m.z),
        head: new THREE.Vector3(head.x, head.y, head.z),
        aim: new THREE.Vector3(m.aim[0], m.aim[1], m.aim[2])
      });
    }
    for (i = 0; i < HIGH.length; i++) {
      var hm = HIGH[i];
      var hh2 = highMast(B, this, hm.x, hm.z, hm.h, N, hm.heads, 0);
      var hbeam = M.clamp(0.62 / Math.max(0.30, hm.cone), 0.45, 1.0);
      d = {
        name: 'harbor_high_' + hm.n,
        kind: hm.kind, fixture: 'mast',
        pos: [hh2.x, hh2.y, hh2.z],
        kelvin: hm.k, intensity: hm.I, distance: hm.d,
        dayBase: 0.0, cone: hm.cone, penumbra: 0.42, haloScale: 0.26,
        shadow: false, halo: 2.6 * hbeam, beam: hbeam * 0.85,
        aimPos: [hm.aim[0], hm.aim[1], hm.aim[2]]
      };
      this.practicalLights.push(d);
      this.mastRig.push({
        name: d.name, kind: hm.kind, cone: hm.cone,
        base: new THREE.Vector3(hm.x, hh2.ground, hm.z),
        head: new THREE.Vector3(hh2.x, hh2.y, hh2.z),
        aim: new THREE.Vector3(hm.aim[0], hm.aim[1], hm.aim[2])
      });
      this.lightShafts.push({
        origin: new THREE.Vector3(hh2.x, hh2.y - 0.2, hh2.z),
        dir: new THREE.Vector3(hm.aim[0] - hm.x, -(hh2.y - hm.aim[1]), hm.aim[2] - hm.z).normalize(),
        width: 3.4, length: hh2.y - hh2.ground, strength: 1.0, kind: 'mast'
      });
    }
    for (i = 0; i < RAKES.length; i++) {
      var k = RAKES[i];
      var dx = k.aim[0] - k.x, dz = k.aim[2] - k.z;
      var yaw = Math.atan2(dx, dz);
      var hl = Math.sqrt(dx * dx + dz * dz) || 1;
      var pitch = Math.atan2((k.h + 0.36) - k.aim[1], hl);
      var hd = lowFlood(B, this, k.x, k.z, k.h, N, yaw, pitch);
      d = {
        name: 'harbor_rake_' + k.n,
        kind: k.kind, fixture: 'none',
        pos: [hd.x, hd.y, hd.z],
        kelvin: k.k, intensity: k.I, distance: k.d,
        dayBase: 0.0, cone: k.cone, penumbra: 0.52,
        // A near-horizontal beam is the WORST thing to put in a volumetric,
        // because the camera looks along its whole 45 m length instead of
        // across a 12 m one. Measured: at beam 0.55 the quay rake printed a
        // white wall across two thirds of the `gangway` frame and the ship
        // behind it disappeared. The light stays; the lit air is cut to a
        // quarter, which is also the physically honest answer - a hooded
        // flood 3 m off the deck has a fraction of the air column a mast head
        // twelve metres up in the same downpour has.
        shadow: false, halo: 0.35, haloGain: 0.14, beam: 0.22,
        aimPos: [k.aim[0], k.aim[1], k.aim[2]]
      };
      this.practicalLights.push(d);
      this.mastRig.push({
        name: d.name, kind: k.kind, cone: k.cone,
        base: new THREE.Vector3(k.x, hd.ground, k.z),
        head: new THREE.Vector3(hd.x, hd.y, hd.z),
        aim: new THREE.Vector3(k.aim[0], k.aim[1], k.aim[2])
      });
      // NO lightShafts entry for a rake. lighting.js already builds a
      // volumetric from the SpotLight's own angle, so a published shaft on top
      // of it is a second cone inside the first - and for a 45 m horizontal
      // throw that second cone is a wall of white right across the frame. The
      // entry is deliberately absent rather than merely unused: `kind: 'mast'`
      // marks the ones lighting.js must skip, and there is no equivalent flag
      // that means "there is a beam here, please do not draw it twice".
    }
    // The crane's own floods, authored in buildCrane alongside their lenses so
    // the light and the fixture can never drift apart.
    if (this.craneFloods) {
      for (i = 0; i < this.craneFloods.length; i++) {
        this.practicalLights.push(this.craneFloods[i]);
      }
    }
    // Interior practicals. The warehouse is a black box without them. The
    // portacabin gets none: its windows are emissive glass_lit and the
    // `yard_se` mast is 7 m from it, and a practical slot is worth more to the
    // shed than to a caravan already reading as lit.
    this.practicalLights.push({
      name: 'harbor_wh_tube_a', kind: 'fluoro', fixture: 'none',
      pos: [WH_MIDX - WH_OUT * 2.0, WH_EAVE - 1.4, 20.5], kelvin: 4200,
      intensity: 74, distance: 19, dayBase: 0.25
    });
    // ONE tube, not two. lighting.js's harbour practical cap is 16 and this
    // file now fills it exactly; the second tube was worth less than a raking
    // flood along 45 m of quay, and the shed still has the roof-hole shaft
    // (published in lightShafts) doing the work that matters in there.
  };

  // ---- the containers ---------------------------------------------------------
  LevelHarbor.prototype._buildContainers = function (B, rng) {
    var self = this;
    var geos = [
      containerGeometry({ len: C40_L, seed: 1.0, dent: 0.011 }),
      containerGeometry({ len: C40_L, seed: 2.3, dent: 0.017 }),
      containerGeometry({ len: C40_L, seed: 3.7, dent: 0.006 }),
      containerGeometry({ len: C20_L, seed: 5.1, dent: 0.013 }),
      containerGeometry({ len: C20_L, seed: 6.9, dent: 0.019 }),
      containerGeometry({ len: C40_L, seed: 8.2, dent: 0.008, reefer: true }),
      containerGeometry({ len: C20_L, seed: 4.4, dent: 0.015, openDoor: true })
    ];
    var FAM = ['container_red', 'container_blue', 'container_green', 'container_steel'];
    var buckets = Object.create(null);
    var mtx = new THREE.Matrix4();
    var col = new THREE.Color();

    function place(gi, fi, px, py, pz, yaw, roll, c) {
      var k = gi + '|' + fi;
      var b = buckets[k] || (buckets[k] = []);
      var m = new THREE.Matrix4();
      _e1.set(roll || 0, yaw, 0, 'YXZ');
      m.makeRotationFromEuler(_e1);
      m.elements[12] = px; m.elements[13] = py; m.elements[14] = pz;
      b.push({ m: m, c: c.clone() });
    }

    // ---------------------------------------------------------------------
    // Per-instance colour. NEUTRAL-ish so it multiplies the family's own hue
    // rather than replacing it.
    //
    // The spread was measured as too narrow: at v 0.84-1.32 with a rust term
    // that fired one box in four, every red container in the yard was the same
    // red and every blue the same blue, so a stack of thirty read as a cheerful
    // toy palette rather than as thirty units that have each had a different
    // fifteen years. Three things widened it:
    //   * value 0.60-1.28, nearly twice the range
    //   * a HUE jitter, applied as a channel-differential rather than as a
    //     brightness change, so two red boxes differ in colour and not just in
    //     exposure
    //   * an AGE term that takes a fifth of the fleet 60-80% of the way to a
    //     chalked grey-brown, which is what a box that has not been repainted
    //     since it was built actually looks like
    // ---------------------------------------------------------------------
    function bodyColour(out) {
      var v = rng.range(0.60, 1.28);
      var rust = rng.next() < 0.26 ? rng.range(0.30, 0.90) : rng.range(0.0, 0.18);
      var chalk = rng.next() < 0.26 ? rng.range(0.18, 0.52) : 0;
      var age = rng.next() < 0.20 ? rng.range(0.60, 0.80) : rng.range(0.0, 0.22);
      var hj = rng.range(-0.030, 0.030);
      var r = v * (1 + rust * 0.46) * (1 + chalk * 0.10) * (1 + hj * 2.2);
      var g = v * (1 - rust * 0.16) * (1 + chalk * 0.26) * (1 - hj * 0.4);
      var b2 = v * (1 - rust * 0.52) * (1 + chalk * 0.32) * (1 - hj * 2.4);
      // chalked grey-brown: mix the channels together and lift, which is a
      // desaturation of whatever family colour this instance is multiplying
      var mean = (r + g + b2) / 3;
      r = M.lerp(r, mean * 1.30, age);
      g = M.lerp(g, mean * 1.24, age);
      b2 = M.lerp(b2, mean * 1.14, age);
      out.setRGB(r, g, b2);
      return { rust: rust, v: v, age: age };
    }

    var i, lvl;
    for (i = 0; i < this.stacks.length; i++) {
      var s = this.stacks[i];
      var isShort = s.len < 9;
      var gy = this.sampleGround(s.x, s.z);
      for (lvl = 0; lvl < s.n; lvl++) {
        var gi = isShort ? (3 + rng.int(0, 1)) : rng.int(0, 2);
        if (s.open && lvl === 0) gi = 6;
        var fi = rng.int(0, 3);
        var jx = s.x + rng.range(-0.035, 0.035);
        var jz = s.z + rng.range(-0.035, 0.035);
        // a box is set down by a machine with a 30 tonne load swinging on it -
        // it lands within a few centimetres and a couple of degrees, never on
        // the nose. An open box keeps its authored yaw so the doors face the lane.
        var yaw = s.yaw + rng.range(-0.020, 0.020) +
          ((s.open && lvl === 0) ? 0 : (rng.bool() ? Math.PI : 0));
        var roll = rng.range(-0.0075, 0.0075);
        var py = gy + C_H * (lvl + 0.5) + lvl * 0.014;
        var meta = bodyColour(col);
        place(gi, fi, jx, py, jz, yaw, roll, col);
        this._decorate(B, rng, jx, py, jz, yaw, isShort ? C20_L : C40_L, meta.rust, lvl === s.n - 1);
      }
      // A 20 ft box on the top tier, at one end. Six metres of resolution on the
      // block's skyline instead of twelve, for one extra instance.
      if (s.cap20) {
        var capOff = s.cap20 * (C40_L - C20_L) * 0.5;
        var cyaw = s.yaw + rng.range(-0.035, 0.035);
        // ALONG the box, not across it: a container's length is its local +X,
        // which yaw about +Y maps to (cos, 0, -sin). Getting this backwards put
        // every cap three metres out to the side of the stack it belongs on.
        var cx2 = s.x + Math.cos(cyaw) * capOff, cz2 = s.z - Math.sin(cyaw) * capOff;
        var cpy = gy + C_H * (s.n + 0.5) + s.n * 0.014;
        bodyColour(col);
        place(3 + rng.int(0, 1), rng.int(0, 3), cx2, cpy, cz2, cyaw + (rng.bool() ? Math.PI : 0),
          rng.range(-0.008, 0.008), col);
      }
      // one collider for the whole column: 30 boxes with 30 colliders each
      // would put 900 boxes in the broadphase for no gameplay difference
      var f = stackFootprint(s);
      if (s.open) {
        // A box with its doors open is a SHELL. Two flank walls and a blind end,
        // so the player can actually run through the thing rather than bounce
        // off a solid volume that looks like cover you can use.
        var oc = Math.cos(s.yaw), os = Math.sin(s.yaw);
        var thx = Math.abs(oc) * 0.10 + Math.abs(os) * s.len * 0.5;
        var thz = Math.abs(os) * 0.10 + Math.abs(oc) * s.len * 0.5;
        for (var w2 = -1; w2 <= 1; w2 += 2) {
          this.addCollider(s.x + oc * w2 * (C_W * 0.5 - 0.06),
            gy + C_H * 0.5, s.z - os * w2 * (C_W * 0.5 - 0.06),
            thx + 0.06, C_H * 0.5, thz + 0.06, 'metal');
        }
        this.addCollider(s.x - os * (s.len * 0.5 - 0.10), gy + C_H * 0.5,
          s.z - oc * (s.len * 0.5 - 0.10),
          Math.abs(os) * 0.14 + Math.abs(oc) * C_W * 0.5,
          C_H * 0.5, Math.abs(oc) * 0.14 + Math.abs(os) * C_W * 0.5, 'metal');
        if (s.n > 1) {
          this.addCollider(s.x, gy + C_H + (s.n - 1) * C_H * 0.5, s.z, f.hx + 0.02,
            (s.n - 1) * C_H * 0.5, f.hz + 0.02, 'metal');
        }
      } else {
        this.addCollider(s.x, gy + s.n * C_H * 0.5, s.z, f.hx + 0.02, s.n * C_H * 0.5,
          f.hz + 0.02, 'metal');
      }
      s.groundY = gy;
      s.top = gy + s.n * C_H;
    }

    // ---- reefer bank ----------------------------------------------------------
    // Machinery ends face +X, i.e. into the lane the player spawns looking up.
    var rackX = REEFER_X + C40_L * 0.5 + 3.6;
    for (i = 0; i < this.reefers.length; i++) {
      var rf = this.reefers[i];
      var ry = this.sampleGround(rf.x, rf.z);
      for (lvl = 0; lvl < rf.n; lvl++) {
        bodyColour(col);
        col.setRGB(M.lerp(col.r, 1.0, 0.55), M.lerp(col.g, 1.0, 0.55), M.lerp(col.b, 1.0, 0.55));
        place(5, 4, rf.x, ry + C_H * (lvl + 0.5) + lvl * 0.014, rf.z, 0, 0, col);
      }
      this.addCollider(rf.x, ry + rf.n * C_H * 0.5, rf.z, C40_L * 0.5 + 0.02,
        rf.n * C_H * 0.5, C_W * 0.5 + 0.02, 'metal');
      rf.top = ry + rf.n * C_H;
      // power lead from the socket rack to each unit
      for (lvl = 0; lvl < rf.n; lvl++) {
        catenary(B, 'deck_plate', rackX, ry + 1.8, rf.z,
          rf.x + C40_L * 0.5 - 0.35, ry + C_H * (lvl + 0.6), rf.z - 0.7, 0.6, 0.030, 7);
      }
    }
    // the socket rack itself
    var rackZ = REEFER_Z0 + 2.92;
    var srY = this.sampleGround(rackX, rackZ);
    B.paint = 'metal';
    B.box('deck_plate', 0.30, 2.6, 9.2, rackX, srY + 1.3, rackZ, 0.02);
    for (i = 0; i < 9; i++) {
      B.box('reefer_panel', 0.34, 0.42, 0.32, rackX - 0.15, srY + 1.75,
        rackZ - 3.9 + i * 0.95, 0.02);
    }
    B.box('deck_plate', 0.55, 0.30, 9.6, rackX, srY + 2.72, rackZ, 0.02);
    this.addCollider(rackX, srY + 1.3, rackZ, 0.3, 1.3, 4.6, 'metal');

    // ---- the toppled container, as a rolled instance ---------------------------
    if (this.toppled) {
      col.setRGB(1.02, 0.72, 0.55);
      place(1, 3, this.toppled.x, this.toppled.y + C_W * 0.5 + 0.02, this.toppled.z,
        this.toppled.yaw, this.toppled.roll, col);
      this.addCollider(this.toppled.x, this.toppled.y + C_W * 0.5, this.toppled.z,
        C40_L * 0.5, C_W * 0.5, C_H * 0.5, 'metal', false,
        _e1.set(this.toppled.roll, this.toppled.yaw, 0, 'YXZ'));
    }

    // ---- a short stack of boxes on the freighter's deck ------------------------
    // Seen only in silhouette at 45 m, but a container ship with an empty deck
    // is not a container ship.
    for (i = 0; i < 10; i++) {
      var dx2 = -44 + i * 8.4;
      if (dx2 > 14) break;
      var dz2 = SHIP_Z - 6.0 - (i % 3) * 3.0;
      var dh = 2 + (i % 3);
      for (lvl = 0; lvl < dh; lvl++) {
        bodyColour(col);
        place(rng.int(0, 2), rng.int(0, 3), dx2, sheerY(dx2) + 1.7 + C_H * (lvl + 0.5), dz2,
          0, 0, col);
      }
    }

    // ---- realise the instanced meshes ------------------------------------------
    var keys = Object.keys(buckets);
    for (i = 0; i < keys.length; i++) {
      var parts = keys[i].split('|');
      var g = geos[parseInt(parts[0], 10)];
      var fam = FAM[parseInt(parts[1], 10)] || 'container_steel';
      if (parts[1] === '4') fam = 'reefer_panel';
      var list = buckets[keys[i]];
      var im = new THREE.InstancedMesh(g, this.material(fam, true), list.length);
      im.name = 'containers_' + keys[i];
      im.castShadow = true; im.receiveShadow = true;
      for (var n = 0; n < list.length; n++) {
        im.setMatrixAt(n, list[n].m);
        im.setColorAt(n, list[n].c);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = true;
      im.computeBoundingSphere();
      this.root.add(im);
      this.instanced.push(im);
    }
    if (self) { /* closure guard */ }
    if (mtx) { /* scratch, retained deliberately */ }
  };

  // Owner marks, serials, mandatory stencils, rust weeps and graffiti for one
  // container, in its own local frame.
  LevelHarbor.prototype._decorate = function (B, rng, px, py, pz, yaw, len, rust, isTop) {
    if (!this._atlasOk && this._matCache['decal|v']) return;
    // Touch the material once so the atlas exists before any card is placed.
    if (!this._matCache['decal|v']) this.material('decal', false);
    if (!this._atlasOk) return;
    B.pushXYZ(px, py, pz, 0, yaw, 0);
    B.paint = 'flat';
    var hw = C_W * 0.5 + 0.030;
    var side = rng.bool() ? 1 : -1;
    var o = rng.int(0, 3);
    var white = tint(0xf2f4f2, 0.15);
    var rustC = tint(0xffb27a, 0.9);
    // owner mark, high on one flank
    decalCard(B, CELL.OWNER_A + o, -len * 0.20, 0.58, side * hw,
      Math.min(3.1, len * 0.30), 0.92, 'z', side, white, rng.range(-0.012, 0.012));
    // serial and ISO size code, toward the door end
    decalCard(B, CELL.SERIAL_A + rng.int(0, 2), len * 0.29, 0.76, side * hw,
      1.75, 0.58, 'z', side, white, rng.range(-0.01, 0.01));
    // the mandatory data / CSC block, low on the other flank
    if (rng.next() < 0.55) {
      decalCard(B, rng.bool() ? CELL.DATA : CELL.CSC, -len * 0.26, -0.62, -side * hw,
        1.45, 0.50, 'z', -side, white, 0);
    }
    // ---- rust weeping ------------------------------------------------------
    // ANCHORED, and that is the whole difference. Rust does not appear in the
    // middle of a panel: it starts at a FIXING - a corner casting, a top-rail
    // weld, a door hinge, a scrape down to bare steel - and then runs
    // DOWNWARD under gravity, dark at the source and bleeding out as it goes.
    // Randomly-placed cards with their centres at mid-height gave soft round
    // orange patches with no direction and no cause, which is exactly the
    // "no rust weeping" instant-fail in different clothing.
    //
    // So: x is drawn from the fixing lines, and every card is positioned so its
    // TOP edge sits on the fixing it is weeping from, not its centre.
    var fixings = [
      len * 0.5 - 0.10, -(len * 0.5 - 0.10),          // corner castings
      len * 0.28, -len * 0.28, len * 0.09, -len * 0.16 // top-rail weld runs
    ];
    // Two at most, and narrow. Three full-height cards of alpha-tested noise on
    // one 12 m flank stops reading as weeping and starts reading as speckle -
    // the streak has to be a MARK on the paint, not a second surface over it.
    var weeps = rust > 0.42 ? 2 : 1;
    for (var i = 0; i < weeps; i++) {
      var ws = rng.bool() ? 1 : -1;
      var wh2 = rng.range(1.10, 2.05);
      var wx2 = fixings[rng.int(0, fixings.length - 1)] + rng.range(-0.10, 0.10);
      // most run from the top rail; one in four from the bottom-rail pool,
      // where water actually stands and the steel rots from below
      var fromTop = rng.next() > 0.25;
      var wy2 = fromTop ? (C_H * 0.5 - 0.06 - wh2 * 0.5)
                        : (-C_H * 0.5 + 0.05 + wh2 * 0.34);
      decalCard(B, rng.bool() ? CELL.WEEP_A : CELL.WEEP_B,
        wx2, wy2, ws * hw, rng.range(0.55, 1.15), wh2, 'z', ws, rustC,
        rng.range(-0.02, 0.02));
    }
    // and the standing pool along the bottom rail, where the water sits
    if (rust > 0.40) {
      var bs = rng.bool() ? 1 : -1;
      decalCard(B, CELL.WEEP_B, rng.range(-len * 0.3, len * 0.3),
        -C_H * 0.5 + 0.13, bs * hw, rng.range(1.2, 2.2), 0.26, 'z', bs, rustC, 0);
    }
    // graffiti, and the odd warning stencil
    if (rng.next() < 0.16) {
      var gs = rng.bool() ? 1 : -1;
      decalCard(B, rng.bool() ? CELL.TAG_A : CELL.TAG_B,
        rng.range(-len * 0.25, len * 0.25), rng.range(-0.35, 0.25), gs * hw,
        rng.range(2.2, 3.4), rng.range(1.2, 1.7), 'z', gs, null, rng.range(-0.05, 0.05));
    }
    if (isTop && rng.next() < 0.22) {
      decalCard(B, CELL.WARN, len * 0.5 + 0.055, 0.30, 0.55, 0.60, 0.60, 'x', 1, white, 0);
    }
    if (rng.next() < 0.30) {
      decalCard(B, CELL.PLACARD, len * 0.5 + 0.055, 0.30, 0.62, 0.30, 0.30, 'x', 1, null, 0);
    }
    B.paint = 'metal';
    B.pop();
  };

  // ---- merge + vertex-colour pass ---------------------------------------------
  LevelHarbor.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.dock_concrete;
      if (key === 'decal') {
        this.material('decal', false);
        if (!this._atlasOk) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('harbor.merge:' + key, e); continue; }
      // keepUV means the source geometry authored its own UVs (the rope's
      // twisted tube, the atlas cards, the chain-link quads). mergeAll drops the
      // whole uv attribute if ANY entry in the bucket lacks one, so the second
      // clause is not belt-and-braces: without it a single un-UV'd solid landing
      // in a keepUV bucket would hand a mapped material a geometry with no uv.
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('harbor.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key, false));
      mesh.name = 'harbor_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours. On `wear` surfaces this is materials.js's WEAR MASK -
  // white = pristine, R grime, G wetness, B edge wear - which is what buys the
  // apron its diffuse x0.48 / roughness 0.09 / specularF90 1.0 wet response.
  // On everything else it is a plain albedo multiplier, because a red container
  // whose body colour arrived through instanceColor cannot also be a wear mask.
  var WEAR_MODES = { apron: 1, water: 1, quay: 1, line: 1, grate: 1, joint: 1 };

  // A soft band, 1 at the centre line and 0 by `w` metres out, with a slow
  // wander so a wheel track is not a ruled line.
  function band(v, w, wobble) {
    var a = Math.abs(v + (wobble || 0));
    return a >= w ? 0 : 1 - a / w;
  }

  // How deeply this patch of yard sits in the lee of a stack or a building.
  // The storm runs in off the sea, so the sheltered side of anything is its
  // LANDWARD side, and the strip of dry-ish concrete behind a four-high stack
  // is the difference between a yard that has been rained on and one that has
  // been dipped.
  LevelHarbor.prototype._shelter = function (x, z) {
    var best = 0, B = this._blockers;
    for (var i = 0; i < B.length; i++) {
      var b = B[i];
      if (x < b[0] - 1.0 || x > b[1] + 1.0) continue;
      var d = z - b[3];
      if (d < -0.30 || d > 4.2) continue;
      var s = 1 - d / 4.2;
      if (s > best) { best = s; if (best > 0.98) break; }
    }
    return best;
  };

  LevelHarbor.prototype._paint = function (key, entries, geo) {
    var self = this;
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = this.noise;
    var W = this.wetness;
    var surf = SURF[key] || SURF.dock_concrete;
    var isWear = !!surf.wear;
    var isStruct = (key === 'struct_steel');
    var vi = 0, e, i, j;

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
        if (key === 'wet_concrete') {
          mode = (mode === 'water' || mode === 'joint') ? mode : 'apron';
        } else if (key === 'painted_line') mode = 'line';
        else if (key === 'steel_grate') mode = 'grate';
        else mode = 'quay';
      } else if (WEAR_MODES[mode]) {
        mode = 'metal';
      }
      if (key === 'glass_lit' || key === 'glass_red' || key === 'decal') {
        mode = 'flat';
        // a lamp lens takes no paint tint from whatever fixture it is bolted to
        if (key !== 'decal') { tr = 1; tg = 1; tb = 1; }
      } else if (key === 'chainlink') { mode = 'clad'; }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r, g, b;

        if (mode === 'apron' || mode === 'joint') {
          // ---- WETNESS -------------------------------------------------------
          // This channel carries ONLY what the level knows and the global
          // driver cannot: where the slab ponds. weather.js already soaks every
          // up-facing surface in the terminal through the material's own wet
          // path, and writing that same soak in here as well double-counted it -
          // the wear layer took albedo x0.48 and the wet layer then took the
          // result x0.42 on top of that. Measured: the apron came back at 0.017
          // effective albedo standing in a 10-lux pool, i.e. the single largest
          // surface in every framing returned nothing at all. Additive-only is
          // the rule the convention enforces, so this must stay near white
          // wherever the level has nothing extra to say.
          var dep = waterDepth(x, z, noise);
          var pud = M.saturate(dep / 0.026);
          var damp = M.smoothstep(-0.038, 0.001, dep) * (1 - pud);
          var shel = self._shelter(x, z);
          var wet = M.saturate((pud * 0.94 + damp * 0.26) * (1 - shel * 0.75));
          if (mode === 'joint') wet = M.saturate(wet * 0.5 + 0.55);
          // ---- GRIME ---------------------------------------------------------
          // Rubber laid down in the lanes, silt drifted at the edges, oil where
          // the reach stackers stand. Restrained: grime mixes toward a dark
          // brown AND darkens on top of that, so a yard-wide 0.5 is a second
          // exposure stop taken off the largest surface in the level.
          var gm = M.saturate(0.09 + 0.24 * (noise.fbm2(x * 0.12 + 4, z * 0.12 - 9, 3) * 0.5 + 0.5) +
            M.smoothstep(3.2, 0.4, Math.abs(Math.abs(x) - LANE_HALF)) * 0.13 +
            pud * 0.14);
          if (mode === 'joint') gm = M.saturate(gm + 0.34);
          // ---- EDGE WEAR / WHEEL TRACKS --------------------------------------
          // Every box in this yard arrived under a reach stacker and they all
          // run the same lines. Steel and solid rubber polish the laitance off
          // and expose the aggregate, so the tracks are the PALEST thing on the
          // ground - and they are the only reason a 90 m slab has any tonal
          // structure for a lamp to find. B is what buys that: the wear layer
          // mixes toward a pale substrate, so this channel BRIGHTENS.
          var wob = noise.fbm2(z * 0.09 + 3.3, x * 0.09 - 1.7, 2) * 0.55;
          var trk = band(Math.abs(x) - (LANE_HALF - 2.2), 1.15, wob);
          trk = Math.max(trk, band(z - 15.4, 1.25, wob * 0.8));
          trk = Math.max(trk, band(z + 26.2, 1.35, wob * 0.9));
          trk = Math.max(trk, band(z - 5.2, 1.05, wob));
          trk *= 0.55 + 0.45 * (noise.fbm2(x * 0.42 - 6, z * 0.42 + 2, 2) * 0.5 + 0.5);
          var ew = M.saturate(trk * 0.72
            + M.smoothstep(0.62, 0.92, noise.fbm2(x * 0.62 - 2, z * 0.62 + 5, 2) * 0.5 + 0.5) * 0.26
            + M.smoothstep(2.2, 0.2, Math.abs(z - CR_RAIL_A)) * 0.30
            + M.smoothstep(2.2, 0.2, Math.abs(z - CR_RAIL_B)) * 0.30);
          // ponded ground is not polished, it is silted
          ew *= 1 - pud * 0.85;
          r = 1 - gm * 0.72; g = 1 - wet; b = 1 - ew;
        } else if (mode === 'water') {
          // Standing water - but NOT quite as wet as the convention allows.
          // G 0.030 is 97% wetness, which resolves to roughness 0.09 with
          // specularF90 1.0: a mirror, and a 3 m mirror of an overcast sky
          // three metres from the lens is the brightest thing in the frame and
          // reads as sheet steel. 0.09-0.15 is still a black mirror with a
          // coherent lamp smear in it and no longer out-reflects the sky.
          var rip = noise.fbm2(x * 1.9, z * 1.9, 2) * 0.5 + 0.5;
          r = 0.86 - rip * 0.10; g = 0.090 + rip * 0.060; b = 0.94;
        } else if (mode === 'quay') {
          // Coping, plinths, rail beams, the warehouse slab. Sloped, sheltered
          // or above the water line - it does not pond, so the extra wetness it
          // asks for is only the splash zone at the quay face.
          var up = M.saturate(ny);
          var wq = M.saturate(M.smoothstep(0.30, -0.15, y) * 0.42 + up * 0.10 +
            M.smoothstep(0.4, -1.6, y) * 0.35);
          var gq = M.saturate(0.10 + 0.24 * (noise.fbm3(x * 0.30, y * 0.30, z * 0.30, 3) * 0.5 + 0.5));
          // splash and weed at the waterline, salt bloom above it
          gq += M.smoothstep(0.4, -1.6, y) * 0.40;
          var eq = M.smoothstep(0.60, 0.93, noise.fbm3(x * 0.9, y * 0.7, z * 0.9, 2) * 0.5 + 0.5) * 0.34 +
            up * 0.16;
          r = 1 - M.saturate(gq) * 0.70; g = 1 - wq; b = 1 - M.saturate(eq);
        } else if (mode === 'line') {
          // Worn paint. R does the work: grime both darkens and desaturates,
          // which is exactly what happens to a yard marking under steel wheels.
          // G stays high on purpose - a marking sits 9 mm PROUD of the slab, so
          // it is the one part of the apron standing water never covers, and it
          // is the brightest thing the lamps have to find down there.
          var wn = noise.fbm2(x * 1.35 + 3, z * 1.35 - 6, 3) * 0.5 + 0.5;
          var worn = M.saturate(M.smoothstep(0.34, 0.90, wn) * 1.10);
          r = 1 - worn * 0.80;
          g = 1 - M.saturate(waterDepth(x, z, noise) / 0.05) * 0.45;
          b = 1 - worn * 0.22;
        } else if (mode === 'grate') {
          // A grating sits over a running channel, so it genuinely is wet -
          // but it is also open steel over a void and most of what the eye
          // reads there is the bar edges catching a lamp.
          var gg = M.saturate(0.16 + 0.26 * (noise.fbm3(x * 0.9, y * 0.9, z * 0.9, 2) * 0.5 + 0.5));
          r = 1 - gg * 0.62;
          g = 1 - M.saturate(W * 0.58);
          b = 1 - M.saturate(M.smoothstep(0.45, 0.92, noise.fbm2(x * 2.2, z * 2.2, 2) * 0.5 + 0.5)) * 0.42;
        } else if (mode === 'hull') {
          // The hull's own paint scheme lives here: anti-fouling below the
          // boot top, dark topsides, a lighter sheer strake, and rust bleeding
          // out of every seam and freeing port.
          // Topsides are DARK. The bands do the reading at 12 m, not the
          // mottle: an even value across a 96 m side with a couple of hard
          // horizontal stripes in it is a ship, and the same side with a
          // wandering four-metre blotch in it is a rock.
          // Topsides come down from 0.72-0.94 to 0.60-0.86. A 96 m painted side
          // is the single largest surface in `gangway` and in half of `quay`,
          // so its multiplier sets those frames' exposure on its own: at the old
          // value the two of them measured 0.245 and 0.235 against a 02:00 band
          // of 0.10-0.18, and the ship read as a wall in daylight. "Metals are
          // dark and specular, not bright" is the direction, and the value has
          // to come back off the wet specular rather than off the albedo.
          var f2 = 0.60 + (noise.fbm3(x * 0.09, y * 0.55, z * 0.09, 3) * 0.5 + 0.5) * 0.26;
          // A ship's hull is three bands, and at 40 m in the dark the BANDS are
          // the only thing that reads: anti-fouling red below the boot top, a
          // near-black topside, and a pale sheer strake under the deck edge
          // that catches every lamp on the quay.
          var boot = M.smoothstep(-0.85, -1.25, y);
          var sheer = M.smoothstep(4.6, 5.4, y) * (1 - M.smoothstep(6.1, 6.7, y));
          // the boot-top stripe itself: a hard 250 mm white line at the
          // load line, which is the one thing that says "ship" at any range
          var bootTop = M.smoothstep(-0.55, -0.75, y) * (1 - M.smoothstep(-1.05, -1.22, y));
          var streak = M.smoothstep(0.55, 0.95,
            noise.fbm2(x * 1.7, y * 0.09, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny));
          // The sheer strake is the PALEST band on the ship and therefore the
          // thing the frame's highlight tint gets measured from. It was biased
          // blue (0.95 / 1.02 / 1.08), which is what drove `gangway` to a
          // grade_split of -0.038 - cold highlights over cold shadows, i.e. the
          // grade inverted. White enamel under a 2000 K quay lamp is warm.
          r = f2 * (1 + boot * 1.05 + sheer * 1.02 + bootTop * 1.05 + streak * 0.52);
          g = f2 * (1 - boot * 0.34 + sheer * 0.95 + bootTop * 1.00 - streak * 0.12);
          b = f2 * (1 - boot * 0.70 + sheer * 0.84 + bootTop * 0.94 - streak * 0.48);
          // ---- the wash band at the waterline --------------------------------
          // A moored ship in a swell has a metre of hull that is alternately in
          // and out of the water, and it is the palest, hardest-edged thing on
          // the whole side: salt bloom, scoured paint and weed. It is also what
          // ties the ship to the sea rather than leaving it standing in it.
          var wash = M.smoothstep(-2.30, -1.85, y) * (1 - M.smoothstep(-1.15, -0.75, y));
          var washN = 0.45 + 0.55 * (noise.fbm2(x * 0.95, y * 3.1, 2) * 0.5 + 0.5);
          r += wash * washN * 0.34; g += wash * washN * 0.33; b += wash * washN * 0.29;
          // and the green weed line just under it
          var weed = M.smoothstep(-2.75, -2.35, y) * (1 - M.smoothstep(-2.20, -1.95, y));
          r *= 1 - weed * 0.30; g *= 1 + weed * 0.18; b *= 1 - weed * 0.22;
          // the water film darkens everything below the sheer strake
          var wetH = M.saturate(W * (0.35 + 0.30 * M.saturate(ny)));
          r *= 1 - wetH * 0.32; g *= 1 - wetH * 0.32; b *= 1 - wetH * 0.30;
          // A warm cast on the paint itself. The hull is the largest surface in
          // `gangway` and the second largest in `quay`, and both are lit almost
          // entirely by 5400-5600 K sources against a cold sky ambient - so the
          // one lever this file still has over that frame's colour balance is
          // the albedo of the thing filling it. Ship topsides are a warm grey
          // anyway; this is 6% either side of neutral, not a colour cast.
          r *= 1.065; b *= 0.925;
        } else if (mode === 'clad') {
          var f3 = 0.84 + (noise.fbm3(x * 0.55, y * 0.42, z * 0.55, 3) * 0.5 + 0.5) * 0.34;
          // streaks below every fixing, and dirt thrown up off the yard
          var st = M.smoothstep(0.58, 0.94, noise.fbm2((Math.abs(nx) > Math.abs(nz) ? z : x) * 2.4,
            y * 0.11, 3) * 0.5 + 0.5) * M.saturate(1 - Math.abs(ny));
          f3 *= 1 - st * 0.34;
          f3 *= 1 - M.smoothstep(1.5, 0.05, y) * 0.30;
          if (ny > 0.4) f3 *= 1.08;
          var wetC = M.saturate(W * 0.55);
          r = f3 * (1 + st * 0.28) * (1 - wetC * 0.28);
          g = f3 * (1 - st * 0.04) * (1 - wetC * 0.30);
          b = f3 * (1 - st * 0.26) * (1 - wetC * 0.30);
        } else if (mode === 'flat') {
          r = 1; g = 1; b = 1;
        } else {
          // 'metal': structural steel. Value variation, rust blooming out of
          // every joint, road film up the first metre, and an overall darkening
          // from the water film - wet steel is DARKER in albedo and gets its
          // value back from the specular, not from the diffuse.
          //
          // struct_steel is the exception and it is deliberate: a gantry is
          // maintained and repainted, so it carries a fifth of the rust the
          // yard's loose ironwork does and a cold cast on top, which is what
          // keeps it reading as PAINT rather than as iron oxide when the only
          // thing lighting it is a 2000 K sodium lamp six metres away.
          var f4 = 0.80 + (noise.fbm3(x * 0.30, y * 0.28, z * 0.30, 3) * 0.5 + 0.5) * 0.36;
          var rs = M.smoothstep(0.52, 0.92, noise.fbm3(x * 0.85 + 3, y * 0.70, z * 0.85 - 4, 3) * 0.5 + 0.5);
          if (isStruct) rs *= 0.22;
          f4 *= 1 - M.smoothstep(1.2, 0.02, y) * 0.26;
          var wetM = M.saturate(W * (0.40 + 0.28 * M.saturate(ny)));
          r = f4 * (1 + rs * 0.40) * (1 - wetM * 0.34);
          g = f4 * (1 - rs * 0.06) * (1 - wetM * 0.35);
          b = f4 * (1 - rs * 0.38) * (1 - wetM * 0.34);
          if (isStruct) { r *= 0.93; b *= 1.10; }
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

  // ---- walkable surfaces --------------------------------------------------------
  LevelHarbor.prototype.sampleGround = function (x, z) {
    if (x > WH_X0 + 0.35 && x < WH_X1 - 0.35 && z > WH_Z0 + 0.35 && z < WH_Z1 - 0.35) {
      return 0.14;
    }
    if (z < QUAY_Z) return WATER_Y;
    return apronY(x, z, this.noise);
  };

  LevelHarbor.prototype._walkRects = function () {
    var R = [{ x0: WEST_X, x1: EAST_X, z0: QUAY_Z + 0.7, z1: SOUTH_Z - 0.3, apron: true }];
    R.push({ x0: WH_X0 + 0.5, x1: WH_X1 - 0.5, z0: WH_Z0 + 0.5, z1: WH_Z1 - 0.5, y: 0.14 });
    // the elevated walkway - AI has to be able to use the firing position it
    // looks down from, or it is scenery
    var wy = CR_SILL + 0.06;
    R.push({ x0: -CR_LEG_X - 0.6, x1: CR_LEG_X + 0.6, z0: CR_RAIL_A - 0.75, z1: CR_RAIL_A + 0.75, y: wy });
    R.push({ x0: -CR_LEG_X - 0.75, x1: -CR_LEG_X + 0.75, z0: CR_RAIL_A, z1: CR_RAIL_B + 0.6, y: wy });
    // stair tower landings
    for (var f = 0; f < 4; f++) {
      var ly = (f + 1) * 3.9;
      R.push({ x0: -CR_LEG_X - 0.65, x1: -CR_LEG_X + 0.65,
        z0: CR_RAIL_B + 1.15, z1: CR_RAIL_B + 6.55, y: ly });
    }
    // container tops the player can actually reach
    for (var i = 0; i < this.stacks.length; i++) {
      var s = this.stacks[i];
      if (s.n > 2) continue;
      var fp = stackFootprint(s);
      R.push({ x0: fp.x - fp.hx + 0.25, x1: fp.x + fp.hx - 0.25,
        z0: fp.z - fp.hz + 0.25, z1: fp.z + fp.hz - 0.25,
        y: (s.groundY || 0) + s.n * C_H });
    }
    return R;
  };

  LevelHarbor.prototype._buildNav = function () {
    var cell = 0.70;
    var ox = WEST_X - 2, oz = QUAY_Z - 2;
    var w = Math.ceil((EAST_X + 4 - ox) / cell);
    var h = Math.ceil((SOUTH_Z + 4 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var R = this._walkRects();
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
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
          var ry = q.apron ? this.sampleGround(x, z) : q.y;
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

  LevelHarbor.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + (yOff || 0.02), z), yaw: yaw
      });
    }
    // [0] is the player: landward end of the apron lane, looking north up it,
    // straight into the crane portal with the ship beyond.
    sp(0.9, 32.2, 0.025);
    sp(-6.6, 22.0, 0.10);   sp(7.8, 14.0, -0.12);
    sp(-25.5, 9.5, 0.05);   sp(-34.8, -4.0, 0.0);
    sp(-25.9, -20.0, 3.10); sp(18.5, -6.0, 1.55);
    sp(30.0, -18.5, 2.30);  sp(-4.0, -24.5, 3.05);
    sp(-33.0, 24.0, -1.55); sp(-28.0, 19.0, -1.20);
    sp(9.0, -22.0, 2.80);   sp(-16.5, 30.0, 0.30);

    // ---------------------------------------------------------------- framings --
    // Solved, not guessed: every one is a position plus a look-at target that is
    // an actual object in the level, so the composition survives the geometry
    // moving. Strong foreground, a leading line, and a lamp cone in shot.
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

    // ---- OVERVIEW ----------------------------------------------------------
    // RE-SOLVED, and the reason the old one failed is worth recording because
    // it is a whole class of mistake: it stood at 23 m, which is ABOVE every
    // light source in the terminal (the tallest mast was 13.5 m), 77 m from its
    // subject and pitched 11.9 degrees down. From there every lit container
    // flank is edge-on and invisible and what the camera actually photographs
    // is unlit container ROOFS - about half the frame. It measured exactly that
    // way: textured 9.0% and edges 0.109 against 22-38% and 0.20-0.23 on every
    // other framing, i.e. the level's supposed hero frame was objectively three
    // times less legible than the rest of it.
    //
    // The fix is not a nudge, it is a different kind of shot. The eye stands ON
    // the four-high stack that forms the hero canyon's west wall, at the west
    // edge of its roof, 1.68 m above a plane that every other stack in the yard
    // also sits at or below - so the roofs are 2 to 11 degrees below the eye,
    // edge-on, and contribute almost nothing - and looks NORTH-EAST across the
    // yard at 6.5 degrees down. What fills the frame instead:
    //
    //   * a stillage, a bar rack and a lit stanchion 2-4 m out on the same roof:
    //     a hard foreground inside 6 m, which the old frame had nothing at all at
    //   * the `canyon_far` mast head 7.6 m out at 9 degrees left, at eye level,
    //     its cone falling into the canyon below - a lit vertical in the near field
    //   * the crane straddling the frame: its four legs land at 17 left, 15
    //     right, 8 right and 33 right, and the apex sits 30 degrees up, just
    //     inside the top edge. The biggest silhouette in the level, framed
    //     diagonally instead of avoided
    //   * the freighter beyond it, the lit apron between the two blocks, and the
    //     west block's rows running away right as FLANKS rather than as roofs
    //
    // The sightline was checked stack by stack against the height table: it
    // passes 1.1 m over row 5's capped bay at 10 m, 0.9 m over row 6's at 13 m,
    // and clears everything after that.
    // ------------------------------------------------------------------------
    var overview = pose(ROWS_W[4] - 0.90, overviewStandY(this) + 1.68, OV_Z,
      1.0, 7.0, -22.0);

    // QUAY - standing ON the quay strip, 1.2 m off the bollard line, looking
    // EAST down 43 m of coping. Solved three times and it is worth recording
    // why the first two failed, because both were the same mistake in different
    // clothes: the quay runs east-west, so from a mark out in the yard the
    // coping, the bollards, the water and the freighter are all abeam or
    // behind, and what the camera actually photographs is a container flank
    // and a crane leg - a container framing under a quay label. The subject has
    // to be looked ALONG, not at.
    //
    //   * the bollard at x -14 - the one that carries a mooring line - is 5.1 m
    //     out and 10 degrees off axis, below eye level, with its line climbing
    //     away left to the ship's fairlead and the chain rail sagging past it
    //   * the coping and both crane rails run east to the vanishing point
    //   * the crane's west leg is the vertical, 6 m out, 13 degrees right
    //   * the mercury flood 8.7 m ahead-left drops a cold cone on wet concrete
    //   * the freighter's hull is a 7 m wall closing the whole left side
    //   * the quay rake is 39 m dead ahead throwing INTO the lens, so every
    //     wet square metre between here and there returns a streak
    gy = this.sampleGround(-19.0, -28.0);
    var quay = pose(-19.0, gy + 1.64, -28.0, 24.0, 2.4, -30.5);

    // CONTAINERS - on the centreline of the west block's second corridor,
    // 8.7 m BACK from its mouth. The first attempt stood 1.2 m off one wall
    // inside the slot: at that range a 10 m container flank is a flat plane
    // filling half the frame and the canyon does not read as a canyon at all.
    // From here the two four-high walls converge to a slot on the thirds, the
    // door ends of rows 4 and 5 flank it in the near ground, the sodium mast
    // 24 m up the corridor throws its cone across both walls, and the slot
    // opens onto the lit quay with the freighter's hull behind it.
    var heroX = (ROWS_W[4] + ROWS_W[5]) * 0.5;
    gy = this.sampleGround(heroX, 21.5);
    var containers = pose(heroX + 0.55, gy + 1.66, 21.5, heroX - 0.60, 3.2, -20.0);

    // CRANE - in the lane, pitched up 21 degrees so the gantry fills the top
    // two thirds against the cloud, with the marked pedestrian route running
    // away just left of centre as the leading line and a three-high 20 ft
    // stack holding the right edge.
    //
    // Re-solved: the old mark at (8.5, 24.0) stood 1.8 m off the south face of
    // the 7.8 m stack at (9.6, 21.0) and then pitched UP into it, so the
    // capture was one container flank corner to corner with no crane in it at
    // all. Moved 3 m west and 4 m south, that same stack becomes the right-hand
    // foreground mass it was always meant to be, the crane's apex sits at 44
    // degrees - just above the top of frame - and the portal legs 31 m away
    // frame the lane instead of being hidden by it.
    gy = this.sampleGround(5.5, 28.0);
    var crane = pose(5.5, gy + 1.70, 28.0, -1.5, 15.0, -6.0);

    // GANGWAY - on the quay looking along the accommodation ladder as it climbs
    // out over the black water to the shell door, hull filling the far side.
    gy = this.sampleGround(2.5, -21.0);
    var gangway = pose(2.5, gy + 1.62, -21.0, -6.5, 3.4, -33.0);

    // WAREHOUSE - inside, in the far corner, looking diagonally down the shed
    // and out through the open roller door. Solved against the geometry: the
    // sightline leaves through the middle of the 5 m opening, the pool under
    // the roof hole sits DEAD ON THE AXIS at 10.7 m so the shaft lands in the
    // middle third, the end of the west racking run is a 4 m foreground mass on
    // the left and the second run holds the right edge at 26 degrees. The first
    // attempt had a rack face 1.8 m off the lens, which is a black wedge, not a
    // foreground.
    var warehouse = pose(39.6, 1.91, 31.6, 25.5, 2.2, 22.0);

    this.cameraPoses = {
      overview: overview, quay: quay, containers: containers,
      crane: crane, gangway: gangway, warehouse: warehouse
    };
  };

  // ---- broadphase + raycast -----------------------------------------------------
  LevelHarbor.prototype._buildBroadphase = function () {
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

  LevelHarbor.prototype.raycast = function (origin, dir, maxDist) {
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

  // ---- per frame ------------------------------------------------------------------
  // The terminal itself is static. The sea is not: a mirror-flat plane with a
  // shiny material on it is the single loudest "this is a 3D scene" tell in a
  // night harbour, so the swell moves and the reflections of the quay lamps
  // break up along it.
  // Three Gerstner components. Wavelength, relative amplitude, steepness,
  // direction bias against the wind vector, and phase speed. Every wavelength
  // is at least four times the near sheet's 2.2 m cell, so nothing here can
  // alias into the same barcode the container flanks used to have.
  var SWELL = [
    { len: 27.0, amp: 0.50, q: 0.86, spread: 0.00, spd: 0.92 },
    { len: 15.5, amp: 0.31, q: 0.70, spread: 0.62, spd: 1.24 },
    { len: 9.4, amp: 0.19, q: 0.55, spread: -0.95, spd: 1.55 }
  ];

  LevelHarbor.prototype.update = function (dt, ctx) {
    var sheets = this._waters || (this._water ? [this._water] : null);
    if (!sheets || !sheets.length) return;
    this._t += (dt || 0);
    var t = this._t;
    // ---- the storm drives the sea, not a constant ---------------------------
    // Amplitude, steepness and foam all scale off ctx.weather.windSpeed. The
    // old code took the wind only as a speed multiplier on three fixed 18 cm
    // sines, so the basin was a millpond in a gale.
    var wsp = 1.0, wdx = 0.72, wdz = 0.69, wind = 11.0, rain = 0.85;
    try {
      if (ctx && ctx.weather) {
        if (isFinite(ctx.weather.windSpeed)) wind = ctx.weather.windSpeed;
        if (isFinite(ctx.weather.rainIntensity)) rain = ctx.weather.rainIntensity;
        if (ctx.weather.windDir && isFinite(ctx.weather.windDir.x)) {
          wdx = ctx.weather.windDir.x; wdz = ctx.weather.windDir.y;
        }
      }
    } catch (e) { /* the default storm is fine */ }
    var wl = Math.sqrt(wdx * wdx + wdz * wdz) || 1;
    wdx /= wl; wdz /= wl;
    wsp = M.clamp(wind / 12, 0.40, 2.0);
    // 0.20 m peak in a flat calm, 0.86 m in the storm preset
    var gain = 0.20 + 1.05 * M.saturate(wind / 15);
    var foamGain = M.saturate((wind - 5.5) / 9.0);

    var si, i, k;
    for (si = 0; si < sheets.length; si++) {
      var w = sheets[si];
      if (!w || !w.geo) continue;
      var p = w.geo.attributes.position;
      var ca = w.geo.attributes.color;
      var arr = p.array, base = w.base, cArr = ca ? ca.array : null;
      var n = p.count;
      var isNear = w.near;
      for (i = 0; i < n; i++) {
        var bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        var dy = 0, dx = 0, dz = 0, crest = 0;
        for (k = 0; k < SWELL.length; k++) {
          var S = SWELL[k];
          // each component runs a little off the mean wind, which is what
          // stops the surface being one corduroy direction
          var sx = wdx * Math.cos(S.spread) - wdz * Math.sin(S.spread);
          var sz = wdx * Math.sin(S.spread) + wdz * Math.cos(S.spread);
          var kk = 6.28318 / S.len;
          var ph = kk * (bx * sx + bz * sz) - t * S.spd * wsp * Math.sqrt(kk * 9.81) * 0.28;
          var A = S.amp * gain;
          var sn2 = Math.sin(ph), cs2 = Math.cos(ph);
          dy += A * sn2;
          // the horizontal term IS the Gerstner: crests sharpen and troughs
          // flatten instead of the whole surface staying a sine
          var qa = S.q * A;
          dx += qa * sx * cs2;
          dz += qa * sz * cs2;
          crest += sn2 * S.amp;
        }
        arr[i * 3] = bx + dx;
        arr[i * 3 + 1] = by + dy;
        arr[i * 3 + 2] = bz + dz;
        if (!cArr || !isNear) continue;
        // ---- foam ----------------------------------------------------------
        // Whitecaps on the crests, a wash band against the quay wall and
        // against the hull, and a fine surface stipple that stands in for a
        // million rain impacts the mesh could never resolve.
        var cn = crest / 1.00;
        var foam = M.smoothstep(0.58, 0.98, cn) * foamGain;
        var dq = (QUAY_Z - 0.62) - bz;                    // + is seaward
        if (bz < QUAY_Z && dq > -0.5 && dq < 4.2 && bx > -52 && bx < 52) {
          foam += M.smoothstep(4.0, 0.4, dq) *
            (0.42 + 0.58 * Math.sin(t * 1.15 + bx * 0.19)) * (0.35 + 0.65 * foamGain);
        }
        if (bx > SHIP_BOW_X - 2 && bx < SHIP_STERN_X + 2) {
          var dh = Math.abs(bz - (hullZ(bx) - 0.42));
          if (dh < 3.4) {
            foam += M.smoothstep(3.2, 0.25, dh) *
              (0.40 + 0.60 * Math.sin(t * 0.95 - bx * 0.22 + 1.7)) * (0.30 + 0.70 * foamGain);
          }
        }
        foam = M.saturate(foam);
        // the stipple: fine, fast, low contrast. It is the cheapest cue there
        // is that the dark area is WATER and not tarmac.
        var stip = Math.sin(bx * 2.31 + t * 5.7) * Math.sin(bz * 2.77 - t * 4.9);
        var sparkle = rain * 0.08 * M.saturate(stip * 0.5 + 0.5 - 0.62) * 3.0;
        var lift = 1 + foam * 1.45 + sparkle;
        // Foam is the brightest thing on the water, so it is what the frame's
        // HIGHLIGHT tint is measured from. The deep basin is blue-biased;
        // whitecaps under sodium masts are not, and leaving them blue drove
        // grade_split negative on `gangway` - cold highlights over cold
        // shadows, which is the grade inverting.
        cArr[i * 3] = M.lerp(0.94, 1.10, foam) * lift;
        cArr[i * 3 + 1] = M.lerp(1.00, 1.02, foam) * lift;
        cArr[i * 3 + 2] = M.lerp(1.06, 0.90, foam) * lift;
      }
      p.needsUpdate = true;
      if (ca && isNear) ca.needsUpdate = true;
    }
    // Normals every other frame: the swell is slow and 3k faces of cross
    // products every frame is not worth the exactness.
    if ((this._normalTick = (this._normalTick + 1) & 1) === 0) {
      for (si = 0; si < sheets.length; si++) {
        if (sheets[si] && sheets[si].geo) sheets[si].geo.computeVertexNormals();
      }
    }
  };

  GAME.LevelHarbor = LevelHarbor;
})(window.GAME, window.THREE);
