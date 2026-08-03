// ============================================================================
// OPERATION BLACKOUT - src/world/level_ruins.js  ->  GAME.LevelRuins
//
// "BAYON RUINS": an overgrown stone temple complex at dawn, in ground mist.
// The quietest level in the roster - its power is atmosphere and scale, not
// intensity - so every decision below is made for DEPTH SEPARATION rather than
// for contrast. Nothing in this level is allowed to snap.
//
// ---------------------------------------------------------------------------
// THE PLAN, in world coordinates (-Z is north / deeper into the temple, +Z is
// south, where the player arrives; the whole complex is on the cardinal axes)
// ---------------------------------------------------------------------------
//
//   z = +56 .. +24   THE CAUSEWAY. A raised stone road 7.2 m wide over a
//                    flooded moat, naga (serpent) balustrades either side,
//                    boundary posts. This is the leading line of the level.
//   z = +24 .. +16   THE SOUTH GOPURA: the gate tower. Cruciform, a face tower
//                    over the passage, wings with false doors, one wing down.
//   z = +16 ..  +6   the outer courtyard, laterite enclosure wall around it,
//                    two library annexes.
//   z =  +6 .. -42   THE GALLERY: a rectangular colonnade ring, |x| <= 30,
//                    corbelled stone roof, pillars every 2.4 m. The WEST run
//                    is collapsed over z -12..-21 and that gap is what lets
//                    the dawn sun into the courtyard as a wedge of light.
//                    The EAST run is being pulled apart by a silk-cotton tree.
//   z =  +2 .. -38   the inner courtyard: flagstones, standing water, mist.
//   z =  -5 .. -33   THE SANCTUARY: a three-tier terrace, |x| <= 14, carrying
//                    the CENTRAL FACE TOWER (22.5 m) and four corner towers
//                    (14.2 m). One corner tower is down in its own rubble.
//
// SUN. main.js's env profile puts this level at timeOfDay 0.22, which is
// sky.js's civil-twilight branch: the disc is on the horizon, so the published
// key is the burning band - 1.05 of intensity, hard orange (1.00 0.44 0.17),
// lifted to about 9.6 degrees of elevation, at azimuth -0.552 rad. That is a
// horizontal bearing of (-0.524, -0.852) TOWARD the sun, i.e. the sun sits
// 31.6 degrees WEST of the -Z axis. Everything in the level is placed against
// that single fact:
//
//   * the causeway runs on -Z, so a player walking in has the sun 32 degrees
//     off his left shoulder and the whole temple back-lit,
//   * the collapsed section of the WEST gallery is on the sun's bearing from
//     the courtyard, so the beam through it crosses the courtyard air,
//   * the tower cluster is the occluder that breaks that light into shafts,
//   * and every face carved on a tower's west side is the only stonework in
//     the level that takes the key directly. The rest is skylight.
//
// A 1.05 key is weak. That is the point, and it is why the level is authored
// with a bright floor rather than a bright key: standing water reflecting the
// dawn sky, pale flagstones, and a mist layer that is itself a light source.
// The lit:unlit ratio across the whole level is inside ~12:1.
//
// ---------------------------------------------------------------------------
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ---------------------------------------------------------------------------
// Published by the CONSTRUCTOR, so props_ruins.js has them the instant the
// level object exists and never has to wait for build() - and never, ever has
// to read a camera pose. A pose is a composition and moves whenever the
// composition improves; the harbor build put fixtures in corridors that had
// been moved out from under them exactly that way.
//
//   anchors.site        { x0,x1,z0,z1, groundY(x,z), sunDir, axisZ }
//   anchors.causeway    { z0,z1, half, deckY, centre(z), nagaL, nagaR }
//   anchors.moat        { x0,x1,z0,z1, waterY }
//   anchors.gopura      { centre, yaw, passage{...}, wings, towerBase, apex }
//   anchors.enclosure   { x0,x1,z0,z1, capY }        (outer laterite wall)
//   anchors.libraries   [ {name, centre, yaw, w, d, eave, door, ruin} ]
//   anchors.gallery     { x0,x1,z0,z1, wallT, corridorW, pillarX, pillarZ,
//                         roofY, capY, runs:[{side,...}], doors:[...],
//                         breach:{...}, pillars:[{x,z,side}] }
//   anchors.courtyard   { x0,x1,z0,z1, floorY }
//   anchors.terrace     { centre, tiers:[{x0,x1,z0,z1,y}], stair{...} }
//   anchors.towers      [ {name, centre, baseY, apexY, halfW, faceY, fallen} ]
//   anchors.pools       [ {x0,x1,z0,z1, waterY, name} ]
//   anchors.trees       [ {name, centre, baseY, height, radius, kind} ]
//   anchors.rubble      [ {centre, radius} ]
//   anchors.camp        { centre, brazier, tarp }
//   anchors.dig         { centre, trench{x0,x1,z0,z1}, light }
//   anchors.shrine      { centre, altar, yaw }
//   anchors.spawn       { position, yaw }
//
// Also published, both consumed generically by lighting.js:
//   level.practicalLights   every source this level implies - the shrine's oil
//                           lamps, three hurricane lanterns hung in the south
//                           gallery, a looter camp's brazier (kind 'fire'), a
//                           battery worklight left burning over the dig trench,
//                           and a votive lamp in the gopura passage. Every one
//                           of them has a FIXTURE built here at the same
//                           coordinate: a light with no visible source is not
//                           a light.
//   level.lightShafts       real apertures only, and all four are holes this
//                           file actually cut: two collapsed roof bays in the
//                           south gallery, the gopura's passage light well,
//                           and the open shaft of the fallen corner tower.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ------------------------------------------------------------------ site --
  var X_MIN = -64, X_MAX = 64;
  var Z_MIN = -62, Z_MAX = 66;
  var CELL = 1.0;                    // terrain field cell

  // The sun's horizontal bearing, taken from sky.js's solar solve at
  // timeOfDay 0.22 rather than guessed. Used to orient drift, staining,
  // the gallery breach and the shafts so they all agree with the shadows.
  var SUN_X = -0.5240, SUN_Z = -0.8517;
  var SUN_EL = 0.1675;               // rad, the LIFTED twilight key elevation

  // Causeway
  var CW_HALF = 3.60, CW_Y = 0.86, CW_Z0 = 24.0, CW_Z1 = 56.0;
  // Moat
  var MOAT_Y = -0.78;
  // Gopura
  var GOP_Z = 20.0, GOP_HALF_X = 9.2, GOP_HALF_Z = 3.9;
  // Outer enclosure wall
  var ENC_X = 30.0, ENC_ZS = 20.0, ENC_ZN = 6.0, ENC_CAP = 2.55;
  // Gallery ring
  var G_X = 30.0, G_ZS = 6.0, G_ZN = -42.0;
  var G_WALL = 0.90;                 // outer wall thickness
  var G_CORR = 3.40;                 // corridor clear width
  var G_PILLAR = 0.44;               // pillar section
  var G_ROOF = 4.05;                 // corridor ceiling underside
  var G_CAP = 5.05;                  // outer wall cap / roof ridge top
  var G_PITCH = 2.40;                // pillar spacing
  // inner pillar-line coordinates
  var G_PX = G_X - G_WALL - G_CORR;      // 25.70
  var G_PZS = G_ZS - G_WALL - G_CORR;    //  1.70
  var G_PZN = G_ZN + G_WALL + G_CORR;    // -37.70
  // the collapsed run of the WEST gallery - on the sun's bearing
  var BREACH_Z0 = -21.5, BREACH_Z1 = -11.5;

  // Sanctuary terrace
  var T_CX = 0.0, T_CZ = -19.0;
  var TIER = [
    { hx: 14.0, hz: 14.0, y: 1.90 },
    { hx: 10.0, hz: 10.0, y: 3.80 },
    { hx: 6.80, hz: 6.50, y: 5.50 }
  ];
  var STAIR_Z0 = -3.40, STAIR_Z1 = -11.0, STAIR_HALF = 2.60;

  var UP = new THREE.Vector3(0, 1, 0);

  // ------------------------------------------------------------- surfaces --
  //
  // `base` is the materials.js recipe. `alb` is an albedoTarget: the library
  // solves a per-channel gain so the surface's MEAN linear albedo lands there
  // while the map's own variation survives - which is the documented way to
  // re-purpose a shared map, and the reason five stone surfaces here can share
  // one 'stone' recipe without any two of them looking like the same rock.
  //
  // `uv` is world metres -> uv. The triplanar entries (stone, rubble, dirt)
  // ignore it and project in world space; the planar ones (wood, metals) do
  // not, and their numbers are solved against each def's own `repeat` so every
  // surface lands near 500 texels/m.
  //
  // VERTEX COLOURS on every library surface use materials.js's WEAR
  // convention, not tinting, because it is exactly the vocabulary this level
  // needs:  R = grime/water staining,  G = wetness (dew, damp, pool edges),
  // B = edge wear (chipped stone showing pale fresh substrate). See _paint.
  var SURF = {
    // The stone targets are solved against sky.js's own published ground
    // albedo for this level ([0.230 0.215 0.165] linear): 0x8a8172 measures
    // [0.245 0.211 0.163], so the precinct really is the surface the sky, the
    // IBL's lower hemisphere and the fog inscatter were all balanced against.
    // The first pass ran 0xa2988a and the towers photographed as wedding cake.
    sandstone:  { uv: 0.42, cast: true,  recv: true, base: 'stone',
                  alb: 0x8f8067, rough: 0.86, hue: 0.55 },
    sandstone_d:{ uv: 0.42, cast: true,  recv: true, base: 'stone',
                  alb: 0x645b4b, rough: 0.90, hue: 0.55 },
    // The deepest cuts of the carving - eye sockets, the line between the
    // lips, the channel under the brow, the ear whorl. Almost every surface in
    // this level is lit by SKY rather than by the 1.05 key, and flat ambient
    // does not carve: a relief whose shadows are hoped for reads as a bump. At
    // 0x39332a these are dark by ALBEDO, so a Bayon face keeps its eyes and
    // its smile at 25 m in any light.
    carve:      { uv: 0.42, cast: true,  recv: true, base: 'stone',
                  alb: 0x39332a, rough: 0.95, hue: 0.55 },
    mossy:      { uv: 0.42, cast: true,  recv: true, base: 'stone',
                  alb: 0x5d6647, rough: 0.94, hue: 0.85 },
    laterite:   { uv: 0.36, cast: true,  recv: true, base: 'rubble',
                  alb: 0x7d5f49, rough: 0.94, hue: 0.75 },
    paving:     { uv: 0.34, cast: false, recv: true, base: 'stone',
                  alb: 0x847763, rough: 0.88, hue: 0.45 },
    // The ONE surface on the plain-multiply path. Its vertex colours are hue
    // (moss green, leaf litter, pale silt at every water line), and the wear
    // convention has no vocabulary for hue - run through it, a green ground
    // reads as a dirty one. Everything else in the level wants grime/wet/edge
    // and stays on 'wear'.
    earth:      { uv: 0.30, cast: false, recv: true, base: 'dirt', mult: true,
                  alb: 0x6f6650, rough: 0.96, hue: 0.55 },
    bark:       { uv: 0.62, cast: true,  recv: true, base: 'wood_plank',
                  alb: 0x796f5e, rough: 0.94, hue: 0.75 },
    timber:     { uv: 0.85, cast: true,  recv: true, base: 'wood_plank',
                  alb: 0x594736, rough: 0.90 },
    tarp:       { uv: 0.70, cast: true,  recv: true, base: 'canvas_awning',
                  alb: 0x6e6450, rough: 0.94, hue: 0.45 },
    metal:      { uv: 0.90, cast: true,  recv: true, base: 'rusted_metal',
                  alb: null, rough: 0.86, metal: 0.55 },
    brass:      { uv: 0.90, cast: true,  recv: true, base: 'painted_metal',
                  alb: 0x6b5227, rough: 0.52, metal: 0.60 },
    // Own materials, generated in this file.
    water:      { uv: 1.00, cast: false, recv: true, own: 'water', keepUV: true },
    leaf:       { uv: 1.00, cast: true,  recv: true, own: 'leaf',  keepUV: true },
    lit:        { uv: 1.00, cast: false, recv: false, own: 'lit',  keepUV: true },
    decal:      { uv: 1.00, cast: false, recv: true, own: 'decal', keepUV: true }
  };

  // If materials.js is unavailable entirely the temple must still read as a
  // mossy stone temple rather than as magenta error boxes.
  var FALLBACK = {
    sandstone:  [0xa2988a, 0.86, 0.0],
    sandstone_d:[0x645b4b, 0.90, 0.0],
    carve:      [0x39332a, 0.95, 0.0],
    mossy:      [0x5d6647, 0.94, 0.0],
    laterite:   [0x7d5f49, 0.94, 0.0],
    paving:     [0x8e8778, 0.88, 0.0],
    earth:      [0x4a4030, 0.96, 0.0],
    bark:       [0x796f5e, 0.94, 0.0],
    timber:     [0x594736, 0.90, 0.0],
    tarp:       [0x6e6450, 0.94, 0.0],
    metal:      [0x6a5044, 0.86, 0.55],
    brass:      [0x6b5227, 0.52, 0.60],
    water:      [0x1c2a26, 0.08, 0.0],
    leaf:       [0x46562f, 0.88, 0.0],
    lit:        [0xffb45a, 0.30, 0.0],
    decal:      [0xffffff, 0.90, 0.0]
  };

  // -------------------------------------------------------- geometry atoms --
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
    if (bevel === undefined) bevel = Math.min(0.018, Math.min(w, Math.min(h, d)) * 0.24);
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
  function cyl(rTop, rBot, len, seg, open) {
    seg = seg || 8;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg +
      (open ? 'o' : 'c');
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, !!open);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  // A four-sided tapered block: the atom of every temple tier and every tower
  // storey in the level. A tower built from stacked BOXES photographs as a
  // stack of boxes; the taper is the entire silhouette read.
  var _frusCache = new Map();
  function frus(w0, d0, w1, d1, h) {
    var k = w0.toFixed(3) + ',' + d0.toFixed(3) + ',' + w1.toFixed(3) + ',' +
      d1.toFixed(3) + ',' + h.toFixed(3);
    var g = _frusCache.get(k);
    if (g) return g;
    var a = w0 * 0.5, b = d0 * 0.5, c = w1 * 0.5, e = d1 * 0.5, y0 = -h * 0.5, y1 = h * 0.5;
    var P = [], N = [];
    function quadFace(p0, p1, p2, p3) {
      var ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      var vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      var t = [p0, p1, p2, p0, p2, p3];
      for (var i = 0; i < 6; i++) {
        P.push(t[i][0], t[i][1], t[i][2]);
        N.push(nx, ny, nz);
      }
    }
    // +Z, -Z, +X, -X, top, bottom
    quadFace([-a, y0, b], [a, y0, b], [c, y1, e], [-c, y1, e]);
    quadFace([a, y0, -b], [-a, y0, -b], [-c, y1, -e], [c, y1, -e]);
    quadFace([a, y0, b], [a, y0, -b], [c, y1, -e], [c, y1, e]);
    quadFace([-a, y0, -b], [-a, y0, b], [-c, y1, e], [-c, y1, -e]);
    quadFace([-c, y1, e], [c, y1, e], [c, y1, -e], [-c, y1, -e]);
    quadFace([-a, y0, -b], [a, y0, -b], [a, y0, b], [-a, y0, b]);
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
    _frusCache.set(k, g);
    return g;
  }

  var _quadCache = new Map();
  function quad(w, h, u0, v0, u1, v1) {
    if (u0 === undefined) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + u0.toFixed(4) + ',' +
      v0.toFixed(4) + ',' + u1.toFixed(4) + ',' + v1.toFixed(4);
    var g = _quadCache.get(k);
    if (g) return g;
    var hw = w * 0.5, hh = h * 0.5;
    var pos = new Float32Array([
      -hw, -hh, 0, hw, -hh, 0, hw, hh, 0,
      -hw, -hh, 0, hw, hh, 0, -hw, hh, 0]);
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

  // Surface of revolution about +Y, profile [[r,y],...] bottom to top. The
  // lotus finials on every tower and the water jars in the courtyard.
  function revolve(profile, seg) {
    seg = seg || 12;
    var pos = [], nor = [], i, j;
    var pn = [];
    for (i = 0; i < profile.length; i++) {
      var a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 1)];
      var dr = b[0] - a[0], dy = b[1] - a[1];
      var l = Math.sqrt(dr * dr + dy * dy) || 1;
      pn.push([dy / l, -dr / l]);
    }
    for (i = 0; i + 1 < profile.length; i++) {
      var p0 = profile[i], p1 = profile[i + 1];
      var n0 = pn[i], n1 = pn[i + 1];
      for (j = 0; j < seg; j++) {
        var a0 = j / seg * Math.PI * 2, a1 = (j + 1) / seg * Math.PI * 2;
        var c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        var A = [p0[0] * c0, p0[1], p0[0] * s0], An = [n0[0] * c0, n0[1], n0[0] * s0];
        var B = [p0[0] * c1, p0[1], p0[0] * s1], Bn = [n0[0] * c1, n0[1], n0[0] * s1];
        var C = [p1[0] * c1, p1[1], p1[0] * s1], Cn = [n1[0] * c1, n1[1], n1[0] * s1];
        var D = [p1[0] * c0, p1[1], p1[0] * s0], Dn = [n1[0] * c0, n1[1], n1[0] * s0];
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        nor.push(An[0], An[1], An[2], Bn[0], Bn[1], Bn[2], Cn[0], Cn[1], Cn[2]);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(An[0], An[1], An[2], Cn[0], Cn[1], Cn[2], Dn[0], Dn[1], Dn[2]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // A tapered, slightly bent limb - tree trunks, buttress roots, the roots
  // pouring over the gallery wall. `pts` is [[x,y,z,r], ...].
  function limb(pts, seg) {
    seg = seg || 6;
    var pos = [], nor = [], i, j;
    var rings = [];
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      var nx, ny, nz;
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      nx = b[0] - a[0]; ny = b[1] - a[1]; nz = b[2] - a[2];
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      // a stable frame
      var ux, uy, uz;
      if (Math.abs(ny) < 0.9) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
      var sx = uy * nz - uz * ny, sy = uz * nx - ux * nz, sz = ux * ny - uy * nx;
      var sl = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      var tx = ny * sz - nz * sy, ty = nz * sx - nx * sz, tz = nx * sy - ny * sx;
      var ring = [];
      for (j = 0; j < seg; j++) {
        var ang = j / seg * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        // gentle fluting so a trunk is not a smooth pipe
        var rr = p[3] * (1 + 0.10 * Math.cos(ang * 5 + i * 0.7));
        var dx = (sx * ca + tx * sa), dy = (sy * ca + ty * sa), dz = (sz * ca + tz * sa);
        ring.push([p[0] + dx * rr, p[1] + dy * rr, p[2] + dz * rr, dx, dy, dz]);
      }
      rings.push(ring);
    }
    for (i = 0; i + 1 < rings.length; i++) {
      var r0 = rings[i], r1 = rings[i + 1];
      for (j = 0; j < seg; j++) {
        var k = (j + 1) % seg;
        var A = r0[j], B = r0[k], C = r1[k], D = r1[j];
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        nor.push(A[3], A[4], A[5], B[3], B[4], B[5], C[3], C[4], C[5]);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(A[3], A[4], A[5], C[3], C[4], C[5], D[3], D[4], D[5]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  function tintOf(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  // ================================================================ Builder ==
  // Transform stack plus per-material geometry buckets - the same shape as the
  // harbor's and the pass's builders, deliberately: this file follows those
  // files' patterns rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.wear = null;          // {grime, wet, edge} multipliers for this piece
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
    var e = { geometry: geo, matrix: wm, wear: this.wear };
    b.push(e); this.count++;
    return e;
  };
  Builder.prototype.box = function (key, w, h, d, x, y, z, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z));
  };
  Builder.prototype.boxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.frus = function (key, w0, d0, w1, d1, h, x, y, z, ry) {
    return this.add(key, frus(w0, d0, w1, d1, h), makeM(x, y, z, 0, ry || 0, 0));
  };
  Builder.prototype.cyl = function (key, r0, r1, len, x, y, z, rx, ry, rz, seg) {
    return this.add(key, cyl(r0, r1, len, seg), makeM(x, y, z, rx, ry, rz));
  };
  Builder.prototype.quad = function (key, w, h, x, y, z, rx, ry, rz, uv) {
    var g = uv ? quad(w, h, uv[0], uv[1], uv[2], uv[3]) : quad(w, h);
    return this.add(key, g, makeM(x, y, z, rx, ry, rz));
  };
  // A member between two arbitrary points in the CURRENT frame.
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
  Builder.prototype.rod = function (key, ax, ay, az, bx, by, bz, r, seg) {
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
    return this.add(key, cyl(r, r, len, seg || 6), m);
  };

  // ==================================================== procedural textures ==
  // Four map sets are authored here rather than requested from textures.js,
  // because none of them exists in that library and it is not this file's to
  // extend: the growth/stain decal atlas, the canopy leaf clusters, the still
  // water ripple normal, and the ground mist.
  function ctx2d(size) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    return c.getContext('2d');
  }

  function makeTex(canvas, srgb, aniso, wrap) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = wrap === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = aniso || 1;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  // An irregular organic blob. Moss does not grow in circles and lichen does
  // not grow in squares; both grow as a cluster of overlapping lobes with a
  // ragged frontier, which is one loop of jittered radial samples.
  function blob(g, cx, cy, r, rng, lobes, ragged, fill) {
    g.beginPath();
    var n = 28;
    for (var i = 0; i <= n; i++) {
      var a = i / n * Math.PI * 2;
      var k = 1 + 0.30 * ragged * Math.sin(a * lobes + rng.range(0, 0.4)) +
        0.18 * ragged * Math.sin(a * (lobes * 2.7 + 1) + 1.1);
      var rr = r * k * (1 + rng.range(-0.06, 0.06) * ragged);
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    if (fill !== false) g.fill();
  }

  var ATLAS_N = 4;                 // 4 x 4 cells
  function atlasUV(i, pad) {
    pad = pad === undefined ? 0.004 : pad;
    var c = i % ATLAS_N, r = (i / ATLAS_N) | 0;
    var s = 1 / ATLAS_N;
    return [c * s + pad, 1 - (r + 1) * s + pad, (c + 1) * s - pad, 1 - r * s - pad];
  }

  // 0 moss sheet   1 lichen rosettes   2 water stain    3 worn dirt
  // 4 black algae  5 crack             6 leaf litter    7 efflorescence
  // 8 root hair    9 moss fringe      10 silt          11 wet sheen
  function buildDecalAtlas(rng) {
    var S = 1024, C = S / ATLAS_N;
    var g = ctx2d(S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    var i, j;

    function cellOrigin(k) { return [(k % ATLAS_N) * C, ((k / ATLAS_N) | 0) * C]; }

    // ---- 0: moss sheet - the level's most-used mark -------------------------
    var o = cellOrigin(0);
    for (i = 0; i < 46; i++) {
      var mx = o[0] + rng.range(C * 0.18, C * 0.82);
      var my = o[1] + rng.range(C * 0.18, C * 0.82);
      var mr = rng.range(C * 0.06, C * 0.20);
      var v = rng.range(0, 1);
      g.globalAlpha = rng.range(0.30, 0.85);
      g.fillStyle = 'rgb(' + ((44 + v * 34) | 0) + ',' + ((62 + v * 42) | 0) + ',' +
        ((28 + v * 22) | 0) + ')';
      blob(g, mx, my, mr, rng, 3 + (i % 4), 1.0);
    }
    // dry, paler crust at the frontier
    for (i = 0; i < 26; i++) {
      g.globalAlpha = rng.range(0.10, 0.30);
      g.fillStyle = 'rgb(118,124,86)';
      blob(g, o[0] + rng.range(C * 0.1, C * 0.9), o[1] + rng.range(C * 0.1, C * 0.9),
        rng.range(C * 0.03, C * 0.09), rng, 4, 1.2);
    }

    // ---- 1: lichen rosettes -------------------------------------------------
    o = cellOrigin(1);
    for (i = 0; i < 70; i++) {
      var lx = o[0] + rng.range(C * 0.08, C * 0.92);
      var ly = o[1] + rng.range(C * 0.08, C * 0.92);
      var lr = rng.range(C * 0.012, C * 0.055);
      g.globalAlpha = rng.range(0.25, 0.70);
      var t = rng.next();
      g.fillStyle = t < 0.45 ? 'rgb(168,174,146)'
        : (t < 0.8 ? 'rgb(126,140,104)' : 'rgb(196,186,150)');
      blob(g, lx, ly, lr, rng, 5, 1.4);
      g.globalAlpha *= 0.5;
      g.fillStyle = 'rgb(74,82,58)';
      blob(g, lx, ly, lr * 0.45, rng, 4, 1.2);
    }

    // ---- 2: water stain, running DOWN ---------------------------------------
    o = cellOrigin(2);
    for (i = 0; i < 34; i++) {
      var sx = o[0] + rng.range(C * 0.04, C * 0.96);
      var w = rng.range(C * 0.010, C * 0.055);
      var top = o[1] + rng.range(0, C * 0.22);
      var len = rng.range(C * 0.35, C * 0.95);
      var grd = g.createLinearGradient(0, top, 0, top + len);
      var dv = rng.range(0.30, 0.72);
      grd.addColorStop(0, 'rgba(46,42,34,' + dv.toFixed(3) + ')');
      grd.addColorStop(0.55, 'rgba(58,54,44,' + (dv * 0.6).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(70,66,56,0)');
      g.globalAlpha = 1;
      g.fillStyle = grd;
      g.fillRect(sx - w * 0.5, top, w, Math.min(len, o[1] + C - top));
    }

    // ---- 3: worn dirt / a path polished into the stone ----------------------
    o = cellOrigin(3);
    var grd3 = g.createRadialGradient(o[0] + C * 0.5, o[1] + C * 0.5, C * 0.06,
      o[0] + C * 0.5, o[1] + C * 0.5, C * 0.50);
    grd3.addColorStop(0, 'rgba(84,70,50,0.72)');
    grd3.addColorStop(0.6, 'rgba(90,78,58,0.40)');
    grd3.addColorStop(1, 'rgba(96,84,64,0)');
    g.globalAlpha = 1; g.fillStyle = grd3;
    g.fillRect(o[0], o[1], C, C);
    for (i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.05, 0.24);
      g.fillStyle = rng.bool(0.5) ? 'rgb(64,54,38)' : 'rgb(122,108,84)';
      blob(g, o[0] + rng.gaussian(C * 0.5, C * 0.17), o[1] + rng.gaussian(C * 0.5, C * 0.17),
        rng.range(C * 0.01, C * 0.05), rng, 4, 1.1);
    }

    // ---- 4: black algae - the tide line of standing water --------------------
    o = cellOrigin(4);
    for (i = 0; i < 40; i++) {
      g.globalAlpha = rng.range(0.28, 0.80);
      g.fillStyle = rng.bool(0.6) ? 'rgb(22,28,22)' : 'rgb(34,42,30)';
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(C * 0.35, C),
        rng.range(C * 0.05, C * 0.17), rng, 3, 1.3);
    }
    var grd4 = g.createLinearGradient(0, o[1], 0, o[1] + C);
    grd4.addColorStop(0, 'rgba(0,0,0,0)');
    grd4.addColorStop(0.42, 'rgba(0,0,0,0)');
    grd4.addColorStop(1, 'rgba(18,24,18,0.42)');
    g.globalAlpha = 1; g.fillStyle = grd4;
    g.fillRect(o[0], o[1], C, C);

    // ---- 5: cracks ----------------------------------------------------------
    o = cellOrigin(5);
    g.globalAlpha = 1;
    g.lineCap = 'round';
    for (i = 0; i < 9; i++) {
      var px = o[0] + rng.range(C * 0.1, C * 0.9), py = o[1] + rng.range(0, C * 0.3);
      var ang = rng.range(1.1, 2.0);
      g.strokeStyle = 'rgba(30,26,20,' + rng.range(0.45, 0.85).toFixed(3) + ')';
      g.lineWidth = rng.range(1.6, 5.0);
      g.beginPath(); g.moveTo(px, py);
      for (j = 0; j < 14; j++) {
        ang += rng.range(-0.35, 0.35);
        px += Math.cos(ang) * C * 0.055; py += Math.sin(ang) * C * 0.055;
        g.lineTo(px, py);
      }
      g.stroke();
    }

    // ---- 6: leaf litter ------------------------------------------------------
    o = cellOrigin(6);
    for (i = 0; i < 130; i++) {
      var lxx = o[0] + rng.range(0, C), lyy = o[1] + rng.range(0, C);
      var la = rng.range(0, Math.PI);
      var lw = rng.range(C * 0.010, C * 0.035);
      g.save(); g.translate(lxx, lyy); g.rotate(la);
      g.globalAlpha = rng.range(0.35, 0.9);
      var tt = rng.next();
      g.fillStyle = tt < 0.4 ? 'rgb(96,74,38)' : (tt < 0.75 ? 'rgb(66,58,30)' : 'rgb(50,60,32)');
      g.beginPath();
      g.ellipse(0, 0, lw, lw * rng.range(0.35, 0.6), 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // ---- 7: efflorescence / bird lime - the pale marks -----------------------
    o = cellOrigin(7);
    for (i = 0; i < 34; i++) {
      g.globalAlpha = rng.range(0.10, 0.40);
      g.fillStyle = rng.bool(0.6) ? 'rgb(214,208,192)' : 'rgb(190,186,176)';
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(0, C),
        rng.range(C * 0.03, C * 0.13), rng, 4, 1.1);
    }

    // ---- 8: root hair over stone --------------------------------------------
    o = cellOrigin(8);
    g.globalAlpha = 1;
    for (i = 0; i < 30; i++) {
      var rx = o[0] + rng.range(0, C), ry = o[1] + rng.range(0, C * 0.25);
      var ra = rng.range(1.2, 1.95);
      g.strokeStyle = 'rgba(' + (72 + (rng.next() * 30) | 0) + ',' +
        (60 + (rng.next() * 24) | 0) + ',46,' + rng.range(0.35, 0.8).toFixed(3) + ')';
      g.lineWidth = rng.range(2.0, 7.0);
      g.beginPath(); g.moveTo(rx, ry);
      for (j = 0; j < 12; j++) {
        ra += rng.range(-0.25, 0.25);
        rx += Math.cos(ra) * C * 0.07; ry += Math.sin(ra) * C * 0.07;
        g.lineTo(rx, ry);
      }
      g.stroke();
    }

    // ---- 9: moss fringe - a soft-edged sheet for wall bases -----------------
    o = cellOrigin(9);
    var grd9 = g.createLinearGradient(0, o[1] + C, 0, o[1]);
    grd9.addColorStop(0, 'rgba(52,68,34,0.88)');
    grd9.addColorStop(0.45, 'rgba(58,74,40,0.44)');
    grd9.addColorStop(1, 'rgba(64,80,46,0)');
    g.globalAlpha = 1; g.fillStyle = grd9;
    g.fillRect(o[0], o[1], C, C);
    for (i = 0; i < 40; i++) {
      g.globalAlpha = rng.range(0.15, 0.55);
      g.fillStyle = 'rgb(46,62,30)';
      blob(g, o[0] + rng.range(0, C), o[1] + C - Math.abs(rng.gaussian(0, C * 0.30)),
        rng.range(C * 0.02, C * 0.08), rng, 4, 1.3);
    }

    // ---- 10: silt / dried mud rim -------------------------------------------
    o = cellOrigin(10);
    for (i = 0; i < 60; i++) {
      g.globalAlpha = rng.range(0.12, 0.42);
      g.fillStyle = rng.bool(0.5) ? 'rgb(112,100,74)' : 'rgb(84,74,54)';
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(0, C),
        rng.range(C * 0.03, C * 0.12), rng, 5, 1.0);
    }

    // ---- 11: a wet sheen patch ----------------------------------------------
    o = cellOrigin(11);
    for (i = 0; i < 22; i++) {
      g.globalAlpha = rng.range(0.20, 0.55);
      g.fillStyle = 'rgb(30,34,34)';
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(0, C),
        rng.range(C * 0.05, C * 0.18), rng, 3, 0.9);
    }

    g.globalAlpha = 1;
    return g.canvas;
  }

  // Canopy leaf clusters. 2 x 2 variants so no two cards on a tree carry the
  // same silhouette - a canopy of one repeated card reads instantly as cards.
  function buildLeafTexture(rng) {
    var S = 512, C = S / 2;
    var g = ctx2d(S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    for (var v = 0; v < 4; v++) {
      var ox = (v % 2) * C, oy = ((v / 2) | 0) * C;
      var n = 760 + (v * 41) % 120;
      for (var i = 0; i < n; i++) {
        // clustered along a few twigs rather than scattered
        var tw = (i % 9) / 9;
        var bx = ox + C * (0.5 + Math.cos(tw * 6.28 + v) * 0.26);
        var by = oy + C * (0.55 + Math.sin(tw * 6.28 + v) * 0.24);
        var lx = bx + rng.gaussian(0, C * 0.20);
        var ly = by + rng.gaussian(0, C * 0.19);
        if (lx < ox + 3 || lx > ox + C - 3 || ly < oy + 3 || ly > oy + C - 3) continue;
        // Leaf size is the scale reference for the whole canopy: a card is
        // 4-6 m across, so a leaf at 5% of the cell is a 25 cm leaf and the
        // overview photographed as a hedge pressed against the lens.
        var lw = rng.range(C * 0.011, C * 0.027);
        var la = rng.range(0, Math.PI * 2);
        var sh = rng.next();
        g.save(); g.translate(lx, ly); g.rotate(la);
        g.globalAlpha = rng.range(0.72, 1.0);
        g.fillStyle = sh < 0.30 ? 'rgb(58,78,38)'
          : (sh < 0.62 ? 'rgb(78,100,48)'
            : (sh < 0.86 ? 'rgb(46,62,32)' : 'rgb(104,120,60)'));
        g.beginPath();
        g.ellipse(0, 0, lw, lw * rng.range(0.34, 0.52), 0, 0, Math.PI * 2);
        g.fill();
        // midrib
        g.globalAlpha *= 0.5;
        g.strokeStyle = 'rgb(112,124,70)';
        g.lineWidth = 1.1;
        g.beginPath(); g.moveTo(-lw, 0); g.lineTo(lw, 0); g.stroke();
        g.restore();
      }
    }
    g.globalAlpha = 1;
    return g.canvas;
  }

  // Still water: two octaves of very low-amplitude ripple. A courtyard pool at
  // dawn is nearly a mirror, so the normal map's job is only to stop it being
  // a PERFECT one - a perfect mirror renders the environment map at full
  // sharpness and reads as chrome.
  function buildWaterNormal(noise) {
    var S = 256;
    var g = ctx2d(S);
    if (!g) return null;
    var img = g.createImageData(S, S);
    var d = img.data;
    var f = 1 / S;
    function h(x, y) {
      return noise.fbm2(x * 0.055, y * 0.055, 3, 2.1, 0.55) * 1.0 +
        noise.fbm2(x * 0.20 + 31.0, y * 0.20 - 12.0, 2) * 0.32;
    }
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var hx = h(x + 1, y) - h(x - 1, y);
        var hy = h(x, y + 1) - h(x, y - 1);
        var nx = -hx * 0.55, ny = -hy * 0.55, nz = 1.0;
        var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        var i = (y * S + x) * 4;
        d[i] = ((nx / l) * 0.5 + 0.5) * 255;
        d[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
        d[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    void f;
    return g.canvas;
  }

  // Ground mist. Soft, radially vignetted so a card has no edge to see, and
  // authored with real internal structure - a flat alpha ramp reads as a sheet
  // of tracing paper laid over the scene.
  function buildMistTexture(noise) {
    var S = 256;
    var g = ctx2d(S);
    if (!g) return null;
    var img = g.createImageData(S, S);
    var d = img.data;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S - 0.5, v = y / S - 0.5;
        var r = Math.sqrt(u * u + v * v) * 2;
        var vig = M.smoothstep(1.0, 0.24, r);
        var n = noise.fbm2(x * 0.016 + 5.5, y * 0.016 - 2.5, 4, 2.2, 0.55) * 0.5 + 0.5;
        var n2 = noise.fbm2(x * 0.055 - 9.0, y * 0.055 + 4.0, 3) * 0.5 + 0.5;
        // Peak alpha is deliberately ~0.34. A horizontal card covers every
        // pixel below the horizon at a CONSTANT alpha regardless of distance,
        // which is the one thing real mist never does - at 0.9 it replaced the
        // floor of every framing in the level with a flat pale sheet and the
        // first capture round read as ice. The distance behaviour is the sky's
        // height fog; these cards only add local structure.
        var a = M.saturate(vig * (n * 0.78 + n2 * 0.34 - 0.20)) * 0.26;
        var i = (y * S + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return g.canvas;
  }

  // ======================================================= terrain + survey ==
  function rectFall(x, z, x0, x1, z0, z1, soft) {
    var a = M.smoothstep(x0 - soft, x0 + soft, x) * M.smoothstep(x1 + soft, x1 - soft, x);
    var b = M.smoothstep(z0 - soft, z0 + soft, z) * M.smoothstep(z1 + soft, z1 - soft, z);
    return a * b;
  }

  // Natural ground only. Every built floor (causeway, gopura, gallery,
  // terrace) is a PLATFORM resolved analytically in sampleGround, so the field
  // never has to express a vertical face and can stay smooth enough to
  // interpolate.
  function terrainY(x, z, N, P) {
    var dx = Math.max(0, Math.abs(x) - 33.0);
    var dz = Math.max(0, Math.max(z - 60.0, -47.0 - z));
    var wild = M.smoothstep(1.0, 15.0, Math.sqrt(dx * dx + dz * dz));

    var big = N.fbm2(x * 0.0165 + 11.3, z * 0.0165 - 4.7, 4) * 3.1;
    var mid = N.fbm2(x * 0.058 - 3.1, z * 0.058 + 8.2, 3) * 0.62;
    var fine = N.fbm2(x * 0.31 + 21.0, z * 0.31 - 7.0, 2) * 0.075;

    var y = (big + mid) * wild + fine * (0.30 + 0.70 * wild);
    // the levelled precinct itself is not a drawing board: 6 cm of settlement
    y += N.fbm2(x * 0.115 - 40.0, z * 0.115 + 17.0, 2) * 0.075 * (1 - wild);

    // ---- the moat ----------------------------------------------------------
    y -= 1.62 * rectFall(x, z, -25.5, -5.6, 24.5, 57.5, 2.4);
    y -= 1.62 * rectFall(x, z, 5.6, 25.5, 24.5, 57.5, 2.4);

    // ---- the overview knoll -------------------------------------------------
    if (P && P.knoll) {
      var kd = Math.sqrt((x - P.knoll.x) * (x - P.knoll.x) + (z - P.knoll.z) * (z - P.knoll.z));
      y += P.knoll.h * M.smoothstep(P.knoll.r, P.knoll.r * 0.22, kd);
    }

    // ---- under every built floor -------------------------------------------
    // The flagstones are laid as individual slabs a few centimetres thick, so
    // the natural ground has to be BELOW them or it grows up through the
    // joints. Taken as a max of the masks rather than a sum: two overlapping
    // platforms must not dig twice as deep as one.
    if (P && P.platforms) {
      var pav = 0;
      for (var q = 0; q < P.platforms.length; q++) {
        var pl = P.platforms[q];
        pav = Math.max(pav, rectFall(x, z, pl.x0, pl.x1, pl.z0, pl.z1, 1.1));
      }
      y -= 0.22 * pav;
    }

    // ---- courtyard basins --------------------------------------------------
    if (P && P.basins) {
      for (var i = 0; i < P.basins.length; i++) {
        var b = P.basins[i];
        y -= b.depth * rectFall(x, z, b.x0, b.x1, b.z0, b.z1, b.soft);
      }
    }
    return y;
  }

  // ---------------------------------------------------------------- survey --
  // Everything the level and props_ruins.js need to know about where things
  // are. Computed once, in the constructor, from the seeded RNG - so it is
  // identical on every boot and available before build().
  function plan(N, rng) {
    var P = {};

    // ---- water ------------------------------------------------------------
    // Standing water is the level's brightest surface. At dawn a still sheet
    // at grazing incidence returns the burning horizon almost intact, so
    // these are what keeps the BOTTOM of every framing lit - the metric that
    // killed the harbor (vertical_imbalance) is solved with geometry here, not
    // with a fill light.
    P.basins = [
      { name: 'court_west', x0: -15.8, x1: -2.7, z0: -10.4, z1: -0.4, depth: 0.34, soft: 1.7 },
      { name: 'court_east', x0: 3.2, x1: 12.6, z0: -6.6, z1: 0.8, depth: 0.28, soft: 1.5 },
      { name: 'srah', x0: -23.4, x1: -16.2, z0: -25.0, z1: -13.0, depth: 1.05, soft: 1.2 },
      { name: 'court_ne', x0: 14.6, x1: 21.8, z0: -20.8, z1: -13.4, depth: 0.30, soft: 1.5 },
      { name: 'east_pool', x0: 15.0, x1: 22.6, z0: -34.5, z1: -25.0, depth: 0.85, soft: 1.2 }
    ];
    P.pools = [
      { name: 'court_west', x0: -15.4, x1: -2.9, z0: -10.0, z1: -0.6, y: -0.115, algae: 0.55 },
      { name: 'court_east', x0: 3.4, x1: 12.2, z0: -6.2, z1: 0.6, y: -0.095, algae: 0.5 },
      { name: 'srah', x0: -23.0, x1: -16.6, z0: -24.6, z1: -13.4, y: -0.44, algae: 0.85 },
      { name: 'court_ne', x0: 14.9, x1: 21.5, z0: -20.4, z1: -13.8, y: -0.105, algae: 0.6 },
      { name: 'east_pool', x0: 15.4, x1: 22.2, z0: -34.1, z1: -25.4, y: -0.36, algae: 0.9 },
      { name: 'moat_w', x0: -25.2, x1: -5.9, z0: 24.8, z1: 57.2, y: MOAT_Y, algae: 0.7 },
      { name: 'moat_e', x0: 5.9, x1: 25.2, z0: 24.8, z1: 57.2, y: MOAT_Y, algae: 0.7 }
    ];

    // ---- built floors ------------------------------------------------------
    P.platforms = [
      { name: 'causeway', x0: -CW_HALF, x1: CW_HALF, z0: CW_Z0 + 2.4, z1: CW_Z1, y: CW_Y },
      { name: 'gopura', x0: -GOP_HALF_X, x1: GOP_HALF_X, z0: GOP_Z - GOP_HALF_Z, z1: GOP_Z + GOP_HALF_Z, y: 0.30 },
      { name: 'outer_court', x0: -ENC_X + 0.9, x1: ENC_X - 0.9, z0: ENC_ZN, z1: GOP_Z - GOP_HALF_Z, y: 0.16 },
      { name: 'gal_s', x0: -G_X, x1: G_X, z0: G_PZS, z1: G_ZS, y: 0.28 },
      { name: 'gal_n', x0: -G_X, x1: G_X, z0: G_ZN, z1: G_PZN, y: 0.28 },
      { name: 'gal_w', x0: -G_X, x1: -G_PX, z0: G_ZN, z1: G_ZS, y: 0.28 },
      { name: 'gal_e', x0: G_PX, x1: G_X, z0: G_ZN, z1: G_ZS, y: 0.28 },
      { name: 'tier1', x0: T_CX - TIER[0].hx, x1: T_CX + TIER[0].hx, z0: T_CZ - TIER[0].hz, z1: T_CZ + TIER[0].hz, y: TIER[0].y },
      { name: 'tier2', x0: T_CX - TIER[1].hx, x1: T_CX + TIER[1].hx, z0: T_CZ - TIER[1].hz, z1: T_CZ + TIER[1].hz, y: TIER[1].y },
      { name: 'tier3', x0: T_CX - TIER[2].hx, x1: T_CX + TIER[2].hx, z0: T_CZ - TIER[2].hz, z1: T_CZ + TIER[2].hz, y: TIER[2].y }
    ];
    P.ramps = [
      // the causeway lets down onto the gate platform rather than stepping
      { name: 'cw_in', x0: -CW_HALF, x1: CW_HALF, z0: CW_Z0 - 0.2, z1: CW_Z0 + 2.4, y0: 0.30, y1: CW_Y },
      // the gate lets down into the outer court
      { name: 'gop_out', x0: -2.6, x1: 2.6, z0: GOP_Z - GOP_HALF_Z - 1.4, z1: GOP_Z - GOP_HALF_Z, y0: 0.16, y1: 0.30 },
      // the great stair is piecewise (see stairSegs) and is resolved there
      { name: '_none', x0: 0, x1: 0, z0: 0, z1: 0, y0: 0, y1: 0 }
    ];
    // THE GREAT STAIR. Three flights at 34 degrees with a landing on each
    // tier, which is the real pitch of a temple-mountain stair and the reason
    // the sanctuary reads as a climb rather than as a ramp.
    P.stairSegs = [
      { z0: -5.70, z1: -3.00, y0: 1.90, y1: 0.10 },
      { z0: -7.00, z1: -5.70, y0: 1.90, y1: 1.90 },
      { z0: -9.70, z1: -7.00, y0: 3.80, y1: 1.90 },
      { z0: -10.50, z1: -9.70, y0: 3.80, y1: 3.80 },
      { z0: -13.20, z1: -10.50, y0: 5.50, y1: 3.80 }
    ];

    // ---- the gallery -------------------------------------------------------
    // Four runs. `side` is which cardinal it is, `open` is the side the
    // colonnade faces (always the courtyard).
    P.runs = [
      { side: 's', axis: 'x', a0: -G_X, a1: G_X, wallB: G_ZS, pillarB: G_PZS + G_PILLAR * 0.5, dir: -1 },
      { side: 'n', axis: 'x', a0: -G_X, a1: G_X, wallB: G_ZN, pillarB: G_PZN - G_PILLAR * 0.5, dir: 1 },
      { side: 'w', axis: 'z', a0: G_ZN, a1: G_ZS, wallB: -G_X, pillarB: -G_PX - G_PILLAR * 0.5, dir: 1 },
      { side: 'e', axis: 'z', a0: G_ZN, a1: G_ZS, wallB: G_X, pillarB: G_PX + G_PILLAR * 0.5, dir: -1 }
    ];
    P.breach = { side: 'w', z0: BREACH_Z0, z1: BREACH_Z1 };
    // Axial and secondary doorways through the outer wall of the ring.
    P.doors = [
      { side: 's', a: 0, w: 2.60, h: 3.30, main: true },
      { side: 's', a: -14.4, w: 1.90, h: 2.80 },
      { side: 's', a: 14.4, w: 1.90, h: 2.80 },
      { side: 'n', a: 0, w: 2.40, h: 3.10, blocked: true },
      { side: 'e', a: -19.0, w: 2.20, h: 3.00 },
      { side: 'w', a: -32.0, w: 2.20, h: 3.00 }
    ];
    // Pillar stations. Solved once so the lanterns, the interior pose and
    // props all hang off the SAME list rather than three copies of a loop.
    P.pillars = [];
    var r, a;
    for (r = 0; r < P.runs.length; r++) {
      var run = P.runs[r];
      var span = run.a1 - run.a0;
      var n = Math.floor(span / G_PITCH);
      for (var i = 0; i <= n; i++) {
        a = run.a0 + (i + 0.5) * (span / (n + 1));
        if (Math.abs(a) > G_X - 4.4 && run.axis === 'x') continue;   // corner block
        if (run.axis === 'z' && (a < G_ZN + 4.4 || a > G_ZS - 4.4)) continue;
        var px = run.axis === 'x' ? a : run.pillarB;
        var pz = run.axis === 'x' ? run.pillarB : a;
        var broken = 0;
        if (run.side === 'w' && a > BREACH_Z0 - 1.2 && a < BREACH_Z1 + 1.2) {
          broken = 1;                          // inside the collapse
        }
        P.pillars.push({ x: px, z: pz, side: run.side, a: a, broken: broken });
      }
    }

    // ---- the towers --------------------------------------------------------
    // One central prasat and four at the corners of the second tier. The
    // north-east one is DOWN - a symmetric ruin is not a ruin, it is a model.
    P.towers = [
      { name: 'central', x: T_CX, z: T_CZ, base: TIER[2].y, w: 7.40, h: 17.20,
        faces: 2, erode: 0.30, fallen: false },
      { name: 'sw', x: T_CX - 7.40, z: T_CZ + 7.40, base: TIER[1].y, w: 4.60, h: 10.40,
        faces: 1, erode: 0.45, fallen: false },
      { name: 'se', x: T_CX + 7.40, z: T_CZ + 7.40, base: TIER[1].y, w: 4.60, h: 10.40,
        faces: 1, erode: 0.55, fallen: false },
      { name: 'nw', x: T_CX - 7.40, z: T_CZ - 7.40, base: TIER[1].y, w: 4.60, h: 10.40,
        faces: 1, erode: 0.62, fallen: false },
      { name: 'ne', x: T_CX + 7.40, z: T_CZ - 7.40, base: TIER[1].y, w: 4.60, h: 3.20,
        faces: 0, erode: 1.0, fallen: true }
    ];

    // ---- libraries ---------------------------------------------------------
    P.libraries = [
      { name: 'lib_w', x: -17.0, z: 11.6, yaw: Math.PI * 0.5, w: 7.2, d: 4.8,
        eave: 3.30, ruin: 0.0 },
      { name: 'lib_e', x: 17.0, z: 11.6, yaw: -Math.PI * 0.5, w: 7.2, d: 4.8,
        eave: 3.30, ruin: 0.75 }
    ];

    // ---- the trees ---------------------------------------------------------
    // Three hero silk-cottons, each doing a different job:
    //   east_gallery  the Ta Prohm image - roots pouring over a wall it has
    //                 pulled apart. Faces the camera in hero2 and takes the
    //                 key directly on its west flank.
    //   west_north    stands ON the sun's bearing from the courtyard, so it is
    //                 the occluder that breaks the dawn light into shafts.
    //   terrace       small, growing out of the fallen corner tower.
    P.trees = [
      { name: 'east_gallery', x: 33.2, z: -14.5, h: 17.5, r: 1.35, lean: [-0.16, 0.05],
        wall: 'e', kind: 'fig' },
      { name: 'west_north', x: -34.0, z: -30.0, h: 15.5, r: 1.10, lean: [0.10, 0.12],
        kind: 'fig' },
      { name: 'court_ne', x: 20.5, z: -37.0, h: 12.5, r: 0.85, lean: [-0.06, -0.10],
        kind: 'palm' },
      { name: 'terrace_ne', x: 10.6, z: -28.4, h: 8.4, r: 0.55, lean: [0.14, -0.08],
        base: TIER[0].y, kind: 'fig' },
      { name: 'gate_west', x: -16.0, z: 20.6, h: 13.0, r: 0.90, lean: [-0.08, 0.06],
        kind: 'palm' },
      // the overview's framing device: a trunk at 4 m on the right edge, which
      // is the only way an elevated standpoint gets a foreground at all
      { name: 'knoll', x: -36.0, z: 25.0, h: 16.0, r: 0.85, lean: [0.06, 0.10],
        kind: 'fig' }
    ];

    // ---- rubble heaps ------------------------------------------------------
    // Where a structure came down, its stone is still lying under it. Placed
    // against the fallen tower, the gallery breach and the ruined library.
    P.rubble = [
      { x: T_CX + 7.4, z: T_CZ - 7.4, r: 6.2, y: TIER[1].y, n: 46, big: 1.0 },
      { x: -G_X + 1.2, z: (BREACH_Z0 + BREACH_Z1) * 0.5, r: 6.8, y: 0.1, n: 52, big: 0.9 },
      { x: -G_X - 3.6, z: (BREACH_Z0 + BREACH_Z1) * 0.5 + 1.5, r: 5.0, y: 0.0, n: 26, big: 0.7 },
      { x: 17.0, z: 11.6, r: 4.6, y: 0.16, n: 24, big: 0.6 },
      { x: 30.4, z: -14.5, r: 5.4, y: 0.1, n: 30, big: 0.8 },
      { x: -6.0, z: -38.6, r: 4.2, y: 0.1, n: 20, big: 0.55 }
    ];

    // ---- occupation --------------------------------------------------------
    // Somebody is using this place. Three of them, and every one is a light.
    P.shrine = { x: 0.0, z: T_CZ + 5.10, y: TIER[2].y, yaw: 0 };
    // the overview standpoint: a jungle knoll outside the south-west corner,
    // 8.5 m up, from which the whole precinct is seen ACROSS its own axis at
    // 80 degrees to the key rather than into it
    // 12.5 m, not 7. From 7 m the gallery's own 5 m roofline hid the entire
    // courtyard and the establishing shot established a wall. The temple
    // stands on levelled ground and everything around it is jungle hill, so a
    // mound is honest; it also gives the level a second, older ruin.
    P.knoll = { x: -44.0, z: 22.0, r: 17.0, h: 12.5 };
    P.camp = { x: 9.2, z: -3.6, y: 0.0, yaw: -0.7 };
    P.dig = { x: 19.4, z: -8.0, y: 0.05, yaw: 1.2,
      trench: { x0: 16.4, x1: 22.4, z0: -11.6, z1: -5.2 } };

    // ---- naga balustrade stations -----------------------------------------
    P.naga = [];
    for (var z = CW_Z0 + 1.2; z <= CW_Z1 - 0.6; z += 3.6) {
      P.naga.push({ z: z, fallen: rng.bool(0.14) });
    }
    return P;
  }

  // ============================================================== the ground ==
  // One indexed heightfield over the whole site. It is the only mesh in the
  // level that is not merged into a material bucket, because it is already one
  // draw call and un-indexing it would triple its memory for nothing.
  //
  // Its VERTEX COLOURS carry the whole biological story of the floor: leaf
  // litter and mud under the canopy, moss where it is flat and shaded, pale
  // silt at every water line, and a dark damp band around each pool. The
  // material is a triplanar 'dirt', so there is no uv seam to fight and the
  // colour is doing the work a second texture would otherwise have to.
  function buildGround(self, rng) {
    var N = self.noise, P = self.plan;
    var F = self.field;
    var W = F.w, H = F.h, i, j;
    var nV = W * H;
    var pos = new Float32Array(nV * 3);
    var nor = new Float32Array(nV * 3);
    var uv = new Float32Array(nV * 2);
    var col = new Float32Array(nV * 3);

    // nearest standing water, for the damp band and the silt line
    function waterNear(x, z) {
      var best = 1e9, wy = -99;
      for (var k = 0; k < P.pools.length; k++) {
        var p = P.pools[k];
        var dx = Math.max(p.x0 - x, 0, x - p.x1);
        var dz = Math.max(p.z0 - z, 0, z - p.z1);
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d < best) { best = d; wy = p.y; }
      }
      return [best, wy];
    }

    for (j = 0; j < H; j++) {
      var z = F.z0 + j * F.cell;
      for (i = 0; i < W; i++) {
        var x = F.x0 + i * F.cell;
        var idx = j * W + i;
        var y = F.a[idx];
        pos[idx * 3] = x; pos[idx * 3 + 1] = y; pos[idx * 3 + 2] = z;
        uv[idx * 2] = x * 0.30; uv[idx * 2 + 1] = z * 0.30;

        // ---- normal from the field --------------------------------------
        var hl = F.a[j * W + Math.max(0, i - 1)];
        var hr = F.a[j * W + Math.min(W - 1, i + 1)];
        var hd = F.a[Math.max(0, j - 1) * W + i];
        var hu = F.a[Math.min(H - 1, j + 1) * W + i];
        var gx = (hr - hl) / (2 * F.cell), gz = (hu - hd) / (2 * F.cell);
        var nl = Math.sqrt(gx * gx + 1 + gz * gz);
        nor[idx * 3] = -gx / nl; nor[idx * 3 + 1] = 1 / nl; nor[idx * 3 + 2] = -gz / nl;

        // ---- colour ------------------------------------------------------
        var slope = 1 - 1 / nl;                       // 0 flat .. ~1 cliff
        var wn = waterNear(x, z);
        var dw = wn[0], wy = wn[1];
        var above = y - wy;

        var moss = M.saturate(N.fbm2(x * 0.048 + 3.3, z * 0.048 - 8.1, 3) * 1.5 + 0.42);
        moss *= M.smoothstep(0.42, 0.10, slope);
        // the precinct is walked on; the jungle is not
        var inside = rectFall(x, z, -G_X - 3, G_X + 3, G_ZN - 3, GOP_Z + 6, 5.0);
        moss = M.lerp(moss * 1.10, moss * 0.52, inside);

        var damp = M.smoothstep(0.85, -0.05, above) * M.smoothstep(9.0, 0.5, dw);
        var silt = M.smoothstep(2.6, 0.2, dw) * M.smoothstep(-0.35, 0.55, above);
        var litter = M.saturate(N.fbm2(x * 0.13 - 20.0, z * 0.13 + 6.0, 2) * 1.2 + 0.35) *
          (0.35 + 0.65 * (1 - inside));

        // base: warm damp earth
        var r = 1.02, g = 0.96, b = 0.86;
        // moss / grass
        r = M.lerp(r, 0.78, moss * 0.85);
        g = M.lerp(g, 1.14, moss * 0.85);
        b = M.lerp(b, 0.60, moss * 0.85);
        // leaf litter warms and lightens
        r = M.lerp(r, r * 1.30, litter * 0.55);
        g = M.lerp(g, g * 1.10, litter * 0.55);
        b = M.lerp(b, b * 0.78, litter * 0.55);
        // pale silt rim - the single brightest thing on the floor and the
        // reason a pool edge reads as an edge
        r = M.lerp(r, 1.62, silt * 0.62);
        g = M.lerp(g, 1.56, silt * 0.62);
        b = M.lerp(b, 1.38, silt * 0.62);
        // damp darkens and cools
        var dk = 1 - damp * 0.42;
        r *= dk; g *= dk * 1.02; b *= dk * 1.10;

        var v = N.fbm2(x * 0.62 + 40.0, z * 0.62 - 11.0, 2);
        r *= 1 + v * 0.10; g *= 1 + v * 0.09; b *= 1 + v * 0.07;

        col[idx * 3] = r; col[idx * 3 + 1] = g; col[idx * 3 + 2] = b;
      }
    }

    var tri = (W - 1) * (H - 1) * 6;
    var idxArr = tri > 65535 ? new Uint32Array(tri) : new Uint16Array(tri);
    var t = 0;
    for (j = 0; j < H - 1; j++) {
      for (i = 0; i < W - 1; i++) {
        var a = j * W + i, b2 = a + 1, c = a + W, d = c + 1;
        idxArr[t++] = a; idxArr[t++] = c; idxArr[t++] = b2;
        idxArr[t++] = b2; idxArr[t++] = c; idxArr[t++] = d;
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    Geo.copyUV1(geo);
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geo.computeBoundingSphere();

    var mesh = new THREE.Mesh(geo, self.material('earth'));
    mesh.name = 'ruins_ground';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    self.root.add(mesh);
    self.meshes.push(mesh);
    void rng;
  }

  // ------------------------------------------------------------- flagstones --
  // Individually laid slabs, not a plane with a tile texture. Every one is
  // rotated a degree or two, sunk or lifted a few centimetres and cracked off
  // its neighbours - which is the difference between a temple floor and a
  // kitchen. About 1300 of them merge into two draw calls.
  function pave(self, B, rng, rect, y, opts) {
    opts = opts || {};
    var pitch = opts.pitch || 1.58;
    var skip = opts.skip || null;
    var jitter = opts.jitter === undefined ? 1 : opts.jitter;
    // `follow` lays the slabs on the terrain instead of on a flat platform, so
    // the inner courtyard can dish toward its own standing water instead of
    // being a billiard table with a puddle painted on it.
    var follow = !!opts.follow;
    var x0 = rect.x0, x1 = rect.x1, z0 = rect.z0, z1 = rect.z1;
    var nx = Math.max(1, Math.round((x1 - x0) / pitch));
    var nz = Math.max(1, Math.round((z1 - z0) / pitch));
    var sx = (x1 - x0) / nx, sz = (z1 - z0) / nz;
    var N = self.noise;
    var out = 0;
    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < nz; j++) {
        var cx = x0 + (i + 0.5) * sx, cz = z0 + (j + 0.5) * sz;
        var hit = false;
        if (skip) {
          for (var k = 0; k < skip.length; k++) {
            var s = skip[k];
            if (cx > s.x0 && cx < s.x1 && cz > s.z0 && cz < s.z1) { hit = true; break; }
          }
        }
        if (hit) continue;
        // a slab that is simply missing is worth more than a slab that is
        // there, so a few are gone entirely and show the earth beneath
        var gone = N.fbm2(cx * 0.19 + 7.0, cz * 0.19 - 3.0, 2);
        if (gone > 0.34 && rng.bool(0.55)) continue;
        var w = sx * rng.range(0.86, 0.955), d = sz * rng.range(0.86, 0.955);
        var tilt = rng.gaussian(0, 0.016) * jitter;
        var tilt2 = rng.gaussian(0, 0.016) * jitter;
        var sink = (gone > 0.16 ? -rng.range(0.02, 0.11) : rng.range(-0.03, 0.025)) * jitter;
        var th = rng.range(0.13, 0.20);
        var moss = M.saturate(N.fbm2(cx * 0.14 - 12.0, cz * 0.14 + 21.0, 2) * 1.6 + 0.30);
        var yy = follow ? self.sampleGround(cx, cz) + 0.07 : y;
        var key = (moss > 0.62 || sink < -0.05) ? 'mossy' : 'paving';
        // Only a slab that has sunk enough to hold water is wet, and only a
        // little: see the note in _paint about what the G channel does to a
        // horizontal surface under an open sky.
        B.wear = {
          grime: 0.80 + rng.range(-0.10, 0.16) - moss * 0.18,
          wet: 1 - M.saturate(-sink * 2.6) * 0.16,
          edge: 0.92 + rng.range(-0.08, 0.10)
        };
        B.boxR(key, w, th, d, cx, yy + sink - th * 0.5, cz, tilt, rng.range(-0.03, 0.03), tilt2);
        out++;
      }
    }
    B.wear = null;
    return out;
  }

  // ----------------------------------------------------------------- water --
  // Flat sheets at the published level. The material is nearly a mirror, so
  // what these actually draw is the dawn sky - which is exactly the point:
  // they are the light in the bottom of the frame.
  function buildWater(self, B, rng) {
    var P = self.plan;
    for (var i = 0; i < P.pools.length; i++) {
      var p = P.pools[i];
      var w = p.x1 - p.x0, d = p.z1 - p.z0;
      // subdivided so the ripple normal has vertices to interpolate across and
      // so the fog term varies over a 30 m sheet instead of being flat
      var nx = Math.max(1, Math.round(w / 6)), nz = Math.max(1, Math.round(d / 6));
      for (var a = 0; a < nx; a++) {
        for (var b = 0; b < nz; b++) {
          var cw = w / nx, cd = d / nz;
          var cx = p.x0 + (a + 0.5) * cw, cz = p.z0 + (b + 0.5) * cd;
          // uv is 0.55 per metre, i.e. a ripple tile every 1.8 m. The first
          // pass ran 0.09 and stretched one tile over eleven metres, which is
          // a mirror with a smear on it rather than water.
          B.wear = { grime: 1 - p.algae * 0.30 * rng.range(0.5, 1), wet: 1, edge: 1 };
          B.add('water', quad(cw, cd, (cx - p.x0) * 0.55, (cz - p.z0) * 0.55,
            (cx - p.x0 + cw) * 0.55, (cz - p.z0 + cd) * 0.55),
            makeM(cx, p.y, cz, -Math.PI * 0.5, 0, 0));
        }
      }
    }
    B.wear = null;
  }

  // ================================================================== walls ==
  // Every wall in the level is COURSED - laid as individual blocks with their
  // own settlement, their own missing top course and their own moss - because
  // a single long box with a stone texture on it is the flat-untextured-
  // surface failure with extra steps. About 1.6 m per block, which is the real
  // size of the sandstone the originals are built from.
  //
  // o = { axis:'x'|'z', a0, a1, b, y, h, t, key, cap, capH, doors:[{a,w,h}],
  //       gaps:[{a0,a1,h}], batter, colliderMat, collide }
  function wallRun(self, B, rng, o) {
    var N = self.noise;
    var axis = o.axis, key = o.key || 'sandstone';
    var t = o.t, y = o.y, h = o.h, b = o.b;
    var len = o.a1 - o.a0;
    var seg = o.seg || 1.62;
    var n = Math.max(1, Math.round(len / seg));
    var step = len / n;
    var doors = o.doors || [], gaps = o.gaps || [];
    var i, k;

    function doorAt(a) {
      for (k = 0; k < doors.length; k++) {
        var d = doors[k];
        if (a > d.a - d.w * 0.5 - 0.02 && a < d.a + d.w * 0.5 + 0.02) return d;
      }
      return null;
    }
    function gapAt(a) {
      for (k = 0; k < gaps.length; k++) {
        if (a > gaps[k].a0 && a < gaps[k].a1) return gaps[k];
      }
      return null;
    }

    for (i = 0; i < n; i++) {
      var a = o.a0 + (i + 0.5) * step;
      var x = axis === 'x' ? a : b;
      var z = axis === 'x' ? b : a;
      var d = doorAt(a), gp = gapAt(a);
      var hh = h;
      if (gp) {
        // ruined span: the wall is down to a stub with a ragged top
        var f = M.smoothstep(gp.a0, gp.a0 + 2.4, a) * M.smoothstep(gp.a1, gp.a1 - 2.4, a);
        hh = M.lerp(h, gp.h, f) * (1 + N.fbm2(a * 0.7, b * 0.31, 2) * 0.22);
      }
      // settlement: courses do not stay level over 60 m
      var settle = N.fbm2(a * 0.085 + 4.0, b * 0.085 - 2.0, 3) * 0.09;
      var courses = Math.max(1, Math.round(hh / 0.62));
      var ch = hh / courses;
      for (var c = 0; c < courses; c++) {
        var cy = y + settle + (c + 0.5) * ch;
        if (d && cy < y + d.h) continue;                    // the opening
        var jog = N.fbm2(a * 0.9 + c * 3.1, b * 0.4, 2) * 0.035;
        var bt = o.batter ? (1 - (c / courses) * o.batter) : 1;
        var wgt = (c === courses - 1 && rng.bool(0.22)) ? 0.55 : 1.0;  // a lost top course
        var bw = step * rng.range(0.90, 0.99);
        var mossy = (cy - y) < 1.15 && rng.bool(0.42);
        B.wear = {
          grime: 0.78 + N.fbm2(a * 0.31, cy * 0.5, 2) * 0.20 - (cy - y < 0.9 ? 0.10 : 0),
          wet: 1 - M.smoothstep(1.4, 0.05, cy - y) * 0.30,
          edge: 0.88 + rng.range(-0.10, 0.14)
        };
        var kk = mossy ? 'mossy' : key;
        if (axis === 'x') {
          B.boxR(kk, bw, ch * wgt * 0.985, t * bt, x, cy - ch * (1 - wgt) * 0.5, z + jog,
            0, rng.range(-0.006, 0.006), 0);
        } else {
          B.boxR(kk, t * bt, ch * wgt * 0.985, bw, x + jog, cy - ch * (1 - wgt) * 0.5, z,
            0, rng.range(-0.006, 0.006), 0);
        }
      }
      // a lintel over each opening
      if (d && !d.noLintel && Math.abs(a - d.a) < step * 0.6) {
        var ly = y + settle + d.h + 0.28;
        if (axis === 'x') B.box('sandstone', d.w + 1.0, 0.56, t * 1.12, x, ly, z);
        else B.box('sandstone', t * 1.12, 0.56, d.w + 1.0, x, ly, z);
      }
    }
    B.wear = null;

    // ---- cap / cornice course ---------------------------------------------
    if (o.cap !== false) {
      var capH = o.capH || 0.30;
      var cn = Math.max(1, Math.round(len / 2.6));
      var cstep = len / cn;
      for (i = 0; i < cn; i++) {
        var ca = o.a0 + (i + 0.5) * cstep;
        if (gapAt(ca)) continue;
        var cset = N.fbm2(ca * 0.085 + 4.0, b * 0.085 - 2.0, 3) * 0.09;
        var cx = axis === 'x' ? ca : b, cz = axis === 'x' ? b : ca;
        B.wear = { grime: 0.72, wet: 1, edge: 0.80 };
        if (axis === 'x') B.box('sandstone', cstep * 0.97, capH, t * 1.35, cx, y + cset + h + capH * 0.5, cz);
        else B.box('sandstone', t * 1.35, capH, cstep * 0.97, cx, y + cset + h + capH * 0.5, cz);
      }
      B.wear = null;
    }

    // ---- collision ---------------------------------------------------------
    if (o.collide !== false) {
      var cn2 = Math.max(1, Math.round(len / 4.0));
      var cs2 = len / cn2;
      for (i = 0; i < cn2; i++) {
        var aa = o.a0 + (i + 0.5) * cs2;
        var g2 = gapAt(aa);
        var ph = g2 ? Math.min(h, g2.h + 0.4) : h;
        var dd = doorAt(aa);
        if (dd && Math.abs(aa - dd.a) < dd.w * 0.5) continue;
        if (axis === 'x') {
          self.addCollider(aa, y + ph * 0.5, b, cs2 * 0.5, ph * 0.5, t * 0.7,
            o.colliderMat || 'stone');
        } else {
          self.addCollider(b, y + ph * 0.5, aa, t * 0.7, ph * 0.5, cs2 * 0.5,
            o.colliderMat || 'stone');
        }
      }
    }
  }

  // =============================================================== causeway ==
  function buildCauseway(self, B, rng) {
    var P = self.plan, N = self.noise, i;

    // deck
    pave(self, B, rng, { x0: -CW_HALF, x1: CW_HALF, z0: CW_Z0 + 0.2, z1: CW_Z1 },
      CW_Y, { pitch: 1.44 });

    // revetment down into the moat, both sides, laid in courses
    for (var s = -1; s <= 1; s += 2) {
      wallRun(self, B, rng, {
        axis: 'z', a0: CW_Z0, a1: CW_Z1, b: s * (CW_HALF + 0.28),
        y: MOAT_Y - 1.0, h: CW_Y - MOAT_Y + 1.0, t: 0.56, key: 'laterite',
        cap: false, batter: 0.10, collide: false
      });
      // the naga balustrade: a plinth, a rounded serpent body, and posts
      var bx = s * (CW_HALF + 0.34);
      for (i = 0; i < P.naga.length; i++) {
        var nz = P.naga[i].z;
        var fallen = P.naga[i].fallen;
        B.wear = { grime: 0.76 + rng.range(-0.08, 0.12), wet: 1, edge: 0.86 };
        if (fallen) {
          // knocked off the plinth and lying in the road
          B.boxR('sandstone', 0.52, 0.44, 2.6, bx - s * rng.range(0.6, 1.5),
            CW_Y + 0.24, nz + rng.range(-0.4, 0.4),
            rng.range(-0.2, 0.2), rng.range(-0.4, 0.4), rng.range(0.7, 1.3));
          continue;
        }
        B.box('sandstone', 0.66, 0.34, 3.5, bx, CW_Y + 0.17, nz);       // plinth
        B.box('sandstone', 0.46, 0.30, 3.4, bx, CW_Y + 0.49, nz);       // body
        B.cyl('sandstone', 0.19, 0.19, 3.4, bx, CW_Y + 0.66, nz, Math.PI * 0.5, 0, 0, 8);
        // scales / crest along the serpent's back
        for (var q = 0; q < 5; q++) {
          B.boxR('sandstone', 0.11, 0.19, 0.30, bx, CW_Y + 0.80,
            nz - 1.4 + q * 0.70, 0, 0, rng.range(-0.08, 0.08));
        }
        // post
        B.box('sandstone', 0.62, 0.98, 0.62, bx, CW_Y + 0.49, nz + 1.75);
        B.frus('sandstone', 0.74, 0.74, 0.40, 0.40, 0.34, bx, CW_Y + 1.15, nz + 1.75);
        B.add('sandstone', revolve([[0.20, 0], [0.26, 0.10], [0.17, 0.26], [0.05, 0.38]], 8),
          makeM(bx, CW_Y + 1.32, nz + 1.75));
        self.addCollider(bx, CW_Y + 0.55, nz, 0.36, 0.55, 1.8, 'stone');
      }
      B.wear = null;

      // ---- the seven-headed naga at the head of the causeway ---------------
      var hz = CW_Z1 - 0.6;
      B.wear = { grime: 0.70, wet: 1, edge: 0.78 };
      B.box('sandstone', 0.90, 0.50, 1.5, bx, CW_Y + 0.25, hz);
      B.frus('sandstone', 0.82, 1.20, 0.62, 0.70, 1.55, bx, CW_Y + 1.25, hz);
      for (var f = -3; f <= 3; f++) {
        var fa = f * 0.30;
        B.boxR('sandstone', 0.24, 1.30, 0.30,
          bx + Math.sin(fa) * 0.62 * s, CW_Y + 2.35, hz - Math.abs(f) * 0.10,
          -0.12, 0, fa * 0.9);
        B.boxR('sandstone', 0.28, 0.30, 0.36,
          bx + Math.sin(fa) * 0.86 * s, CW_Y + 3.02, hz - Math.abs(f) * 0.12,
          -0.30, 0, fa * 0.9);
      }
      B.wear = null;
      self.addCollider(bx, CW_Y + 1.5, hz, 0.7, 1.5, 0.9, 'stone');
    }

    // boundary posts marching out into the jungle beyond the moat
    for (i = 0; i < 7; i++) {
      var pz = CW_Z1 + 1.5 + i * 2.4;
      if (pz > Z_MAX - 4) break;
      for (var t2 = -1; t2 <= 1; t2 += 2) {
        var px = t2 * (CW_HALF + 2.4 + i * 0.35);
        var gyy = self.sampleGround(px, pz);
        var lean = N.fbm2(px * 0.4, pz * 0.4, 2) * 0.14;
        var ph2 = rng.range(1.5, 2.3);
        B.wear = { grime: 0.70, wet: 0.90, edge: 0.82 };
        B.boxR('sandstone', 0.42, ph2, 0.42, px, gyy + ph2 * 0.5 - 0.12, pz, lean, rng.range(0, 1), lean * 0.7);
        B.frus('sandstone', 0.50, 0.50, 0.20, 0.20, 0.30, px, gyy + ph2 - 0.10, pz);
        B.wear = null;
        self.addCollider(px, gyy + ph2 * 0.5, pz, 0.25, ph2 * 0.5, 0.25, 'stone');
      }
    }
  }

  // ======================================================= enclosure + gate ==
  function buildEnclosure(self, B, rng) {
    // The laterite wall boxing in the outer court. Deliberately LOW (2.55 m):
    // it has to contain the space without hiding the gallery behind it.
    var gaps = [
      { a0: -24.0, a1: -17.0, h: 0.95 },
      { a0: 12.0, a1: 16.5, h: 1.25 }
    ];
    var s;
    for (s = -1; s <= 1; s += 2) {
      // the south face, running out from the gate wings to the corners
      wallRun(self, B, rng, {
        axis: 'x', a0: s > 0 ? GOP_HALF_X : -ENC_X, a1: s > 0 ? ENC_X : -GOP_HALF_X,
        b: ENC_ZS, y: 0.16, h: ENC_CAP, t: 0.84, key: 'laterite',
        capH: 0.26, gaps: s > 0 ? gaps : [], colliderMat: 'stone'
      });
      // the returns north to the gallery
      wallRun(self, B, rng, {
        axis: 'z', a0: ENC_ZN, a1: ENC_ZS, b: s * ENC_X,
        y: 0.16, h: ENC_CAP, t: 0.84, key: 'laterite', capH: 0.26,
        gaps: s < 0 ? [{ a0: 9.5, a1: 13.5, h: 1.1 }] : [], colliderMat: 'stone'
      });
    }
  }

  // The south gopura. A cruciform gate with a face tower over the passage -
  // the first Bayon face the player meets, at 20 m, framed by the causeway.
  function buildGopura(self, B, rng) {
    var z = GOP_Z, y0 = 0.30, i;
    var wingTop = 5.30;

    // ---- the two wings -----------------------------------------------------
    for (var s = -1; s <= 1; s += 2) {
      var cx = s * 5.70;
      var ruined = s > 0 ? 0.55 : 0.0;         // the east wing has lost its top
      var wt = wingTop - ruined * 1.45;
      // outer skin, coursed on all four faces
      wallRun(self, B, rng, {
        axis: 'x', a0: cx - 3.5, a1: cx + 3.5, b: z + GOP_HALF_Z, y: y0,
        h: wt, t: 0.78, key: 'sandstone', capH: 0.34, collide: false
      });
      wallRun(self, B, rng, {
        axis: 'x', a0: cx - 3.5, a1: cx + 3.5, b: z - GOP_HALF_Z, y: y0,
        h: wt, t: 0.78, key: 'sandstone', capH: 0.34, collide: false
      });
      wallRun(self, B, rng, {
        axis: 'z', a0: z - GOP_HALF_Z, a1: z + GOP_HALF_Z, b: s * GOP_HALF_X, y: y0,
        h: wt, t: 0.78, key: 'sandstone', capH: 0.34, collide: false
      });
      // the mass between the skins
      B.wear = { grime: 0.80, wet: 1, edge: 0.90 };
      B.box('sandstone_d', 6.4, wt, 6.6, cx, y0 + wt * 0.5, z);
      B.wear = null;
      // pilasters and a false door on the south face
      falseDoor(self, B, rng, cx, y0, z + GOP_HALF_Z + 0.06, 0, 2.05, 3.15, 0.30);
      falseDoor(self, B, rng, cx, y0, z - GOP_HALF_Z - 0.06, Math.PI, 2.05, 3.15, 0.30);
      for (i = -1; i <= 1; i += 2) {
        B.wear = { grime: 0.74, wet: 1, edge: 0.84 };
        B.box('sandstone', 0.52, wt - 0.2, 0.30, cx + i * 2.85, y0 + (wt - 0.2) * 0.5, z + GOP_HALF_Z + 0.10);
        B.box('sandstone', 0.52, wt - 0.2, 0.30, cx + i * 2.85, y0 + (wt - 0.2) * 0.5, z - GOP_HALF_Z - 0.10);
        B.wear = null;
      }
      // a small prasat on the wing roof; the east one is a stump
      if (ruined < 0.3) {
        faceTower(self, B, rng, {
          x: cx, z: z, base: wt + y0 + 0.34, w: 3.30, h: 5.20, faces: 0,
          erode: 0.5, name: 'gopura_wing_' + s
        });
      } else {
        B.wear = { grime: 0.66, wet: 1, edge: 0.70 };
        B.frus('sandstone', 3.3, 3.3, 2.9, 2.9, 1.15, cx, wt + y0 + 0.9, z);
        B.wear = null;
        scatterBlocks(self, B, rng, cx + 2.2, wt + y0 + 0.4, z + 1.2, 2.4, 8, 0.5);
      }
      self.addCollider(cx, y0 + wt * 0.5, z, 3.6, wt * 0.5, 3.9, 'stone');
    }

    // ---- the passage -------------------------------------------------------
    // Jambs, a corbelled vault, and a light well at the crown: the one place
    // in the level where a shaft is a real hole in a real roof.
    var jw = 0.72;
    for (var q = -1; q <= 1; q += 2) {
      wallRun(self, B, rng, {
        axis: 'z', a0: z - GOP_HALF_Z, a1: z + GOP_HALF_Z, b: q * (1.70 + jw * 0.5),
        y: y0, h: 4.10, t: jw, key: 'sandstone', cap: false, collide: false
      });
      self.addCollider(q * (1.70 + jw * 0.5), y0 + 2.05, z, jw * 0.6, 2.05, GOP_HALF_Z, 'stone');
      // colonnettes flanking the entry
      B.wear = { grime: 0.70, wet: 1, edge: 0.80 };
      for (var e = -1; e <= 1; e += 2) {
        B.cyl('sandstone', 0.15, 0.17, 3.05, q * 1.86, y0 + 1.52, z + e * (GOP_HALF_Z + 0.14), 0, 0, 0, 8);
        B.box('sandstone', 0.40, 0.22, 0.40, q * 1.86, y0 + 3.16, z + e * (GOP_HALF_Z + 0.14));
      }
      B.wear = null;
    }
    // corbelled vault over the passage
    var cw = [3.40, 2.50, 1.60, 0.90];
    var cy = 4.10 + y0;
    B.wear = { grime: 0.86, wet: 1, edge: 0.92 };
    for (i = 0; i < cw.length; i++) {
      var cut = (i === cw.length - 1);
      var seglen = GOP_HALF_Z * 2;
      if (cut) {
        // the light well: the crown course is missing for 1.6 m
        B.box('sandstone_d', cw[i], 0.44, (seglen - 1.6) * 0.5, 0, cy + 0.22, z - 0.8 - (seglen - 1.6) * 0.25);
        B.box('sandstone_d', cw[i], 0.44, (seglen - 1.6) * 0.5, 0, cy + 0.22, z + 0.8 + (seglen - 1.6) * 0.25);
      } else {
        B.box('sandstone_d', cw[i], 0.44, seglen, 0, cy + 0.22, z);
      }
      cy += 0.44;
    }
    B.wear = null;
    // lintels over both mouths
    for (var m = -1; m <= 1; m += 2) {
      B.wear = { grime: 0.68, wet: 1, edge: 0.74 };
      B.box('sandstone', 4.6, 0.62, 0.52, 0, y0 + 3.42, z + m * (GOP_HALF_Z + 0.10));
      // a pediment: a stepped triangular gable over the lintel
      for (i = 0; i < 4; i++) {
        B.box('sandstone', 4.2 - i * 0.9, 0.36, 0.40, 0, y0 + 3.90 + i * 0.36, z + m * (GOP_HALF_Z + 0.14));
      }
      B.wear = null;
    }

    // ---- the face tower over the passage -----------------------------------
    faceTower(self, B, rng, {
      x: 0, z: z, base: 5.30 + y0, w: 6.30, h: 8.60, faces: 1, erode: 0.38,
      name: 'gopura'
    });
    self.addCollider(0, 5.30 + y0 + 4.3, z, 3.2, 4.3, 3.2, 'stone');
  }

  // A blind door: the standard Khmer elevation - two colonnettes, a lintel, a
  // stepped pediment and a recessed panel carved to look like a real one.
  function falseDoor(self, B, rng, x, y, z, yaw, w, h, d) {
    var c = Math.cos(yaw), s = Math.sin(yaw);
    function put(key, bw, bh, bd, ox, oy, oz) {
      B.boxR(key, bw, bh, bd, x + ox * c + oz * s, y + oy, z - ox * s + oz * c, 0, yaw, 0);
    }
    B.wear = { grime: 0.72 + rng.range(-0.06, 0.08), wet: 1, edge: 0.80 };
    put('sandstone_d', w, h, d * 0.5, 0, h * 0.5, d * 0.25);            // recessed panel
    put('sandstone', 0.30, h + 0.2, d, -(w * 0.5 + 0.15), (h + 0.2) * 0.5, d * 0.5);
    put('sandstone', 0.30, h + 0.2, d, (w * 0.5 + 0.15), (h + 0.2) * 0.5, d * 0.5);
    put('sandstone', w + 0.9, 0.34, d * 1.2, 0, h + 0.37, d * 0.6);     // lintel
    for (var i = 0; i < 3; i++) {
      put('sandstone', w + 0.6 - i * 0.62, 0.26, d * 1.05, 0, h + 0.66 + i * 0.26, d * 0.55);
    }
    // panel relief: five horizontal bands, which is what stops a blind door
    // reading as a hole cut in a wall
    for (var j = 0; j < 5; j++) {
      put('sandstone', w * 0.82, 0.09, d * 0.75, 0, h * (0.14 + j * 0.18), d * 0.38);
    }
    B.wear = null;
  }

  // ============================================================ tumbled stone ==
  // Fallen masonry, settled onto whatever it landed on. Blocks are ANGULAR
  // slabs at the size the walls are coursed in, not rounded boulders, so a
  // heap reads as a building that came down rather than as a pile of rocks.
  function scatterBlocks(self, B, rng, cx, cy, cz, r, n, big, opts) {
    opts = opts || {};
    var N = self.noise;
    for (var i = 0; i < n; i++) {
      var ang = rng.range(0, Math.PI * 2);
      var rr = r * Math.sqrt(rng.next());
      var x = cx + Math.cos(ang) * rr;
      var z = cz + Math.sin(ang) * rr;
      var mound = (1 - rr / r);
      var base = opts.flat ? cy : self.sampleGround(x, z);
      var w = rng.range(0.42, 1.15) * (0.55 + big);
      var h = rng.range(0.26, 0.55) * (0.6 + big * 0.7);
      var d = rng.range(0.42, 1.10) * (0.55 + big);
      var y = base + h * 0.42 + mound * mound * r * 0.30 * big;
      var moss = M.saturate(N.fbm2(x * 0.2 + 3, z * 0.2 - 5, 2) * 1.5 + 0.25);
      B.wear = {
        grime: 0.70 + rng.range(-0.08, 0.14),
        wet: 1 - M.saturate(0.5 - (y - base)) * 0.25,
        edge: 0.78 + rng.range(-0.10, 0.18)
      };
      B.boxR(moss > 0.58 ? 'mossy' : 'sandstone', w, h, d, x, y, z,
        rng.gaussian(0, 0.22), rng.range(0, Math.PI), rng.gaussian(0, 0.22));
      if (rng.bool(0.22)) {
        self.addCollider(x, y, z, w * 0.45, h * 0.6, d * 0.45, 'stone');
      }
    }
    B.wear = null;
  }

  // ================================================================== faces ==
  // THE BAYON FACE. This is the level's signature and the single asset most
  // able to fail: a face is either recognisably a face at 25 m or it is a
  // lumpy box, and there is no middle. It is built as 24 pieces in a local
  // frame whose +Z is the direction the face looks, and it is deliberately
  // ASYMMETRIC in its erosion - the same face carved four times on one tower
  // and then weathered identically is a texture, not a ruin.
  //
  //   * the mass comes forward out of the wall as a tapered block, so the
  //     silhouette against the sky is a head and not a slab,
  //   * the brow is a single hard horizontal that catches the low key,
  //   * the eyes are CLOSED and downcast - two lids sloping toward the nose,
  //   * the mouth is three segments with the outer two lifted, which is the
  //     entire famous smile and the only reason it reads as serene,
  //   * the ears run the full height with pendulous lobes, which is what
  //     makes the proportion Khmer rather than classical.
  function carvedFace(self, B, rng, x, y, z, yaw, w, h, dp, erode) {
    var c = Math.cos(yaw), s = Math.sin(yaw);
    function put(key, bw, bh, bd, ox, oy, oz, rz, rx) {
      var wx = x + ox * c + oz * s;
      var wz = z - ox * s + oz * c;
      return B.boxR(key, bw, bh, bd, wx, y + oy, wz, rx || 0, yaw, rz || 0);
    }
    function putF(key, w0, d0, w1, d1, hh, ox, oy, oz) {
      var wx = x + ox * c + oz * s;
      var wz = z - ox * s + oz * c;
      return B.add(key, frus(w0, d0, w1, d1, hh), makeM(wx, y + oy, wz, 0, yaw, 0));
    }
    var e = erode || 0;
    var key = rng.bool(0.35 + e * 0.3) ? 'mossy' : 'sandstone';
    B.wear = {
      grime: 0.62 + rng.range(-0.06, 0.10) - e * 0.10,
      wet: 1 - e * 0.10,
      edge: 0.70 + rng.range(-0.08, 0.14) - e * 0.12
    };

    // ------------------------------------------------------------------------
    // EVERY oz IS MEASURED AGAINST F, THE FRONT OF THE HEAD MASS. Two rounds
    // were lost to getting this wrong in two different ways, and both are
    // worth recording because they are the same mistake at different scales:
    //
    //   1. The head was 2.0*dp deep with its front at 1.5*dp while the brow
    //      sat at 1.40 and the eyes at 1.20 - every feature except the nose
    //      was inside the block it was supposed to be carved on.
    //   2. The face was then registered against the storey's half-width at its
    //      MID height. The storey tapers, so at the face's foot the stone was
    //      further out than the face was, and the chin, mouth and nose were
    //      buried while only the crown cleared - four faces reduced to a small
    //      stepped ornament on the top of each storey.
    //
    // The third thing, which no amount of geometry fixes on its own: under a
    // 1.05 key at 9 degrees almost every surface here is lit by SKY, and flat
    // ambient does not carve. So the eye sockets and the mouth line are not
    // shadows we hope for - they are RECESSED BLOCKS in the darker stone,
    // which read at 20 m whatever the light is doing.
    // ------------------------------------------------------------------------
    var dk = 'carve';
    var F = 1.30;                       // front plane of the head, in dp
    function fz(proud, depth) { return (F + proud - depth * 0.5) * dp; }

    // ---- the mass: a full jaw, a narrower forehead --------------------------
    putF(key, w * 0.92, dp * 1.50, w * 0.84, dp * 1.32, h * 0.62, 0, h * 0.32, dp * 0.55);
    putF(key, w * 0.86, dp * 1.34, w * 0.78, dp * 1.20, h * 0.20, 0, h * 0.71, dp * 0.62);
    // chin, and the jaw line under it
    putF(key, w * 0.56, dp * 1.34, w * 0.34, dp * 0.86, h * 0.14, 0, h * 0.075, fz(0.20, 1.34));
    put(dk, w * 0.70, h * 0.030, dp * 0.60, 0, h * 0.010, fz(-0.10, 0.60));

    // ---- the mouth: a recessed line with a full lip either side -------------
    // WIDE. The mouth and the eyes are the two features the eye locks onto,
    // and everything else on the head is context for them.
    put(dk, w * 0.56, h * 0.085, dp * 0.66, 0, h * 0.166, fz(-0.16, 0.66));
    for (var k = -1; k <= 1; k++) {
      // the smile: three segments, the outer two lifted. This is the whole
      // reason the face reads as serene rather than as a mask.
      put(key, w * 0.205, h * 0.058, dp * 0.62, k * w * 0.176,
        h * 0.204 + Math.abs(k) * h * 0.022, fz(0.26, 0.62), -k * 0.19);
      put(key, w * 0.205, h * 0.048, dp * 0.56, k * w * 0.174,
        h * 0.134 + Math.abs(k) * h * 0.018, fz(0.20, 0.56), -k * 0.16);
    }

    // ---- the nose: a broad bridge from the brow, a flat wide tip ------------
    if (!(e > 0.55 && rng.bool(e * 0.55))) {
      putF(key, w * 0.155, dp * 1.10, w * 0.235, dp * 1.55, h * 0.235, 0, h * 0.352,
        fz(0.30, 1.10));
      put(key, w * 0.215, h * 0.062, dp * 1.10, 0, h * 0.243, fz(0.62, 1.10));
      for (var q = -1; q <= 1; q += 2) {
        put(key, w * 0.088, h * 0.055, dp * 0.66, q * w * 0.098, h * 0.232, fz(0.34, 0.66));
      }
    } else {
      put(dk, w * 0.24, h * 0.20, dp * 0.50, 0, h * 0.33, fz(-0.12, 0.50), rng.range(-0.2, 0.2));
    }

    // ---- the eyes: sockets sunk into the mass, heavy downcast lids ----------
    put(dk, w * 0.80, h * 0.150, dp * 0.72, 0, h * 0.505, fz(-0.18, 0.72));
    for (q = -1; q <= 1; q += 2) {
      if (e > 0.62 && q > 0 && rng.bool(e - 0.40)) continue;        // spalled away
      // upper lid, heavy, sloping down toward the nose
      put(key, w * 0.320, h * 0.072, dp * 0.66, q * w * 0.222, h * 0.532,
        fz(0.18, 0.66), -q * 0.15);
      // lower lid
      put(key, w * 0.300, h * 0.048, dp * 0.58, q * w * 0.216, h * 0.464,
        fz(0.12, 0.58), -q * 0.12);
      // the fold above the lid
      put(key, w * 0.260, h * 0.036, dp * 0.48, q * w * 0.208, h * 0.580,
        fz(0.22, 0.48), -q * 0.17);
    }

    // ---- the brow: one hard horizontal, overhanging the sockets -------------
    put(key, w * 0.80, h * 0.070, dp * 0.86, 0, h * 0.618, fz(0.34, 0.86));
    put(dk, w * 0.80, h * 0.026, dp * 0.50, 0, h * 0.582, fz(0.06, 0.50));

    // ---- ears, full height, outboard of the mass, with pendulous lobes ------
    for (q = -1; q <= 1; q += 2) {
      put(key, w * 0.135, h * 0.42, dp * 1.15, q * w * 0.500, h * 0.385, dp * 0.60);
      put(dk, w * 0.070, h * 0.30, dp * 0.66, q * w * 0.500, h * 0.400, dp * 1.02);
      put(key, w * 0.115, h * 0.155, dp * 0.95, q * w * 0.500, h * 0.128, dp * 0.56);
      put(key, w * 0.090, h * 0.062, dp * 0.70, q * w * 0.500, h * 0.052, dp * 0.52);
    }

    // ---- diadem and crown ---------------------------------------------------
    put(key, w * 1.00, h * 0.082, dp * 1.20, 0, h * 0.790, fz(0.30, 1.20));
    put(dk, w * 0.96, h * 0.028, dp * 0.62, 0, h * 0.744, fz(0.02, 0.62));
    for (k = -2; k <= 2; k++) {
      put(key, w * 0.086, h * 0.054, dp * 0.46, k * w * 0.186, h * 0.790, fz(0.58, 0.46));
    }
    putF(key, w * 0.78, dp * 1.25, w * 0.42, dp * 0.78, h * 0.140, 0, h * 0.900, dp * 0.72);
    for (k = -1; k <= 1; k++) {
      putF(key, w * 0.145, dp * 0.52, w * 0.028, dp * 0.13, h * 0.095,
        k * w * 0.175, h * 1.015, dp * (0.70 + Math.abs(k) * 0.05));
    }
    B.wear = null;
  }

  // ================================================================ prasats ==
  // A tower. Five diminishing storeys, a cornice between each, corner
  // pilasters that carry the silhouette, false doors on the cella and Bayon
  // faces on the storeys the caller asks for.
  function faceTower(self, B, rng, o) {
    var x = o.x, z = o.z, W = o.w, H = o.h;
    var e = o.erode || 0;
    // The FACE STOREY is the tall one. A prasat whose storeys are all the same
    // proportion has nowhere to put a face that is not squashed: at 0.24 of H
    // the storey was 2.4 m tall and 5.4 m wide, and a face that fits inside
    // that is a letterbox.
    var hs = [0.200, 0.340, 0.130, 0.090, 0.055];
    var wA = [1.000, 0.930, 0.750, 0.560, 0.380];
    var wB = [0.930, 0.800, 0.600, 0.420, 0.260];
    var nS = 5;
    if (e > 0.50 && rng.bool((e - 0.35) * 1.4)) nS = 4;
    if (e > 0.75 && rng.bool((e - 0.60) * 1.4)) nS = 3;
    var y = o.base, i, k, q;
    var faceRec = [];

    for (i = 0; i < nS; i++) {
      var sh = hs[i] * H;
      var a = wA[i] * W, b = wB[i] * W;
      var mossy = (i === 0 && rng.bool(0.35)) || (i > 2 && rng.bool(0.25));
      B.wear = {
        grime: 0.74 + rng.range(-0.08, 0.12) - (i === 0 ? 0.08 : 0),
        wet: 1 - (i === 0 ? 0.14 : 0),
        edge: 0.84 + rng.range(-0.10, 0.12) - e * 0.10
      };
      B.frus(mossy ? 'mossy' : 'sandstone', a, a, b, b, sh, x, y + sh * 0.5, z);
      // corner pilasters - the vertical accents that stop a taper reading as
      // a cone. They step in with the storey.
      for (q = 0; q < 4; q++) {
        var sx = (q & 1) ? 1 : -1, sz = (q & 2) ? 1 : -1;
        B.add('sandstone', frus(a * 0.13, a * 0.13, b * 0.13, b * 0.13, sh),
          makeM(x + sx * (a + b) * 0.245, y + sh * 0.5, z + sz * (a + b) * 0.245));
      }
      // horizontal string course halfway up each storey
      B.box('sandstone', (a + b) * 0.505, sh * 0.055, (a + b) * 0.505, x, y + sh * 0.5, z);
      B.wear = null;

      // false doors on the cella
      if (i === 0 && H > 5.0) {
        var dw = Math.min(a * 0.34, 2.1), dh = Math.min(sh * 0.72, 3.2);
        for (q = 0; q < 4; q++) {
          var yaw = q * Math.PI * 0.5;
          var off = (a * 0.5) * 0.985;
          falseDoor(self, B, rng, x + Math.sin(yaw) * off, y,
            z + Math.cos(yaw) * off, yaw, dw, dh, 0.26);
        }
      }
      // faces
      var wantFace = (i === 1 && o.faces >= 1) || (i === 2 && o.faces >= 2);
      if (wantFace) {
        // The face has to OWN its storey. The first pass sized it at 1.3 of
        // the storey's half-width with 0.145 of relief and it photographed as
        // a stepped ziggurat with some texture on it at 20 m - the level's
        // signature simply was not in the frame. A real Bayon face fills its
        // face of the tower and stands a metre proud of it.
        // THE STOREY TAPERS, so which half-width the face is registered
        // against decides whether it exists. Round one used the half-width at
        // the face's MID height; the storey is wider than that at the face's
        // foot, so the chin, mouth, nose and eyes were all inside the stone
        // and only the crown cleared it - four faces reduced to a small
        // stepped ornament at the top of each storey. Registered against the
        // half-width at the face's FOOT (the widest point it spans) the whole
        // head stands proud, and it stands progressively prouder toward the
        // top as the tower draws in, which is what the real ones do.
        var fy = y + sh * 0.03;
        var fh = sh * 0.94;
        var hwBot = M.lerp(a, b, 0.03) * 0.5;
        var hwMid = M.lerp(a, b, 0.50) * 0.5;
        var fw = Math.min(hwMid * 1.86, fh * 1.10);
        var oR = hwBot - Math.min(0.24, fw * 0.08);
        for (q = 0; q < 4; q++) {
          var fyaw = q * Math.PI * 0.5;
          var fe = M.saturate(e * rng.range(0.5, 1.5));
          carvedFace(self, B, rng,
            x + Math.sin(fyaw) * oR, fy, z + Math.cos(fyaw) * oR,
            fyaw, fw, fh, fw * 0.150, fe);
          faceRec.push({
            x: x + Math.sin(fyaw) * (oR + fw * 0.30), y: fy + fh * 0.45,
            z: z + Math.cos(fyaw) * (oR + fw * 0.30), yaw: fyaw
          });
        }
      }
      y += sh;
      // cornice
      var ch = 0.020 * H;
      B.wear = { grime: 0.68, wet: 1, edge: 0.74 };
      B.frus('sandstone', b * 1.16, b * 1.16, b * 1.02, b * 1.02, ch, x, y + ch * 0.5, z);
      // antefixes at the cornice corners
      for (q = 0; q < 4; q++) {
        var ax = (q & 1) ? 1 : -1, az = (q & 2) ? 1 : -1;
        B.boxR('sandstone', b * 0.10, ch * 2.1, b * 0.10,
          x + ax * b * 0.55, y + ch * 1.05, z + az * b * 0.55, 0, 0.78, 0);
      }
      B.wear = null;
      y += ch;
    }

    // ---- the finial ---------------------------------------------------------
    if (nS >= 5 || !rng.bool(e)) {
      var fr = wB[Math.min(nS, 4)] * W * 0.5;
      B.wear = { grime: 0.66, wet: 1, edge: 0.70 };
      B.add('sandstone', revolve([
        [fr * 1.15, 0], [fr * 1.30, H * 0.012], [fr * 0.92, H * 0.030],
        [fr * 1.05, H * 0.050], [fr * 0.72, H * 0.075], [fr * 0.34, H * 0.092],
        [fr * 0.12, H * 0.100]
      ], 10), makeM(x, y, z));
      B.wear = null;
      y += H * 0.100;
    } else {
      // sheared off: a ragged stump and its stone on the roof below
      scatterBlocks(self, B, rng, x + rng.range(-0.6, 0.6), y, z + rng.range(-0.6, 0.6),
        wA[0] * W * 0.6, 7, 0.55, { flat: true });
    }

    o.apex = y;
    o.faceRec = faceRec;
    // one collider for the shaft; the tiers below already have their own
    self.addCollider(x, o.base + (y - o.base) * 0.5, z,
      W * 0.46, (y - o.base) * 0.5, W * 0.46, 'stone');
    return o;
  }

  // ================================================================ gallery ==
  function buildGallery(self, B, rng) {
    var P = self.plan, N = self.noise;
    var floorY = 0.28;
    var r, i, k;

    // holes punched in the corbelled vault - the level's real apertures. Two
    // in the south run because that is where the `interior` framing looks.
    var HOLES = {
      s: [[-9.6, -6.2], [4.6, 7.4]],
      n: [[-3.0, 0.6]],
      e: [[-16.0, -12.0]],
      w: [[BREACH_Z0 - 1, BREACH_Z1 + 1]]
    };
    function holed(side, a) {
      var hl = HOLES[side];
      if (!hl) return false;
      for (var q = 0; q < hl.length; q++) if (a > hl[q][0] && a < hl[q][1]) return true;
      return false;
    }

    for (r = 0; r < P.runs.length; r++) {
      var run = P.runs[r];
      var axis = run.axis;
      var wc = run.wallB + run.dir * G_WALL * 0.5;          // wall centre line
      var innerFace = run.wallB + run.dir * G_WALL;
      var pillarB = run.pillarB;
      var corrMid = (innerFace + pillarB) * 0.5;
      var corrW = Math.abs(innerFace - pillarB);
      var doors = [], wins = [];
      for (k = 0; k < P.doors.length; k++) {
        if (P.doors[k].side === run.side) {
          doors.push({ a: P.doors[k].a, w: P.doors[k].w, h: P.doors[k].h, y0: 0 });
        }
      }
      // windows with balusters, skipped where a door or the breach already is
      var span = run.a1 - run.a0;
      var nw = Math.floor(span / 4.6);
      for (i = 1; i < nw; i++) {
        var wa = run.a0 + i * (span / nw);
        var clash = false;
        for (k = 0; k < doors.length; k++) {
          if (Math.abs(wa - doors[k].a) < doors[k].w * 0.5 + 1.4) clash = true;
        }
        if (run.side === 'w' && wa > BREACH_Z0 - 2 && wa < BREACH_Z1 + 2) clash = true;
        if (axis === 'x' && Math.abs(wa) > G_X - 5) clash = true;
        if (axis === 'z' && (wa < G_ZN + 5 || wa > G_ZS - 5)) clash = true;
        if (clash) continue;
        wins.push({ a: wa, w: 1.15, h: 3.05, y0: 1.10 });
      }

      var gaps = (run.side === 'w')
        ? [{ a0: BREACH_Z0, a1: BREACH_Z1, h: 1.15 }] : [];

      // 4.62 is not arbitrary: it is exactly where the architrave over the
      // colonnade lands (pillar 3.70 + capital 0.30 + abacus 0.16 + beam
      // 0.46), so the corbelled vault sits on the wall and the pillars at the
      // same height instead of leaving a 0.7 m slot of daylight down the
      // outside of every run.
      wallRun(self, B, rng, {
        axis: axis, a0: run.a0, a1: run.a1, b: wc, y: floorY, h: 4.62,
        t: G_WALL, key: 'sandstone', cap: false,
        doors: doors.concat(wins), gaps: gaps, colliderMat: 'stone'
      });

      // ---- baluster colonnettes in every window ---------------------------
      for (i = 0; i < wins.length; i++) {
        var wv = wins[i];
        B.wear = { grime: 0.74, wet: 1, edge: 0.80 };
        for (k = -1; k <= 1; k++) {
          var ba = wv.a + k * 0.34;
          var bx = axis === 'x' ? ba : wc, bz = axis === 'x' ? wc : ba;
          B.add('sandstone', revolve([
            [0.085, 0], [0.115, 0.18], [0.075, 0.52], [0.105, 0.92], [0.075, 1.30],
            [0.115, 1.72], [0.085, 1.95]
          ], 8), makeM(bx, floorY + wv.y0, bz));
        }
        B.wear = null;
      }

      // ---- the colonnade ---------------------------------------------------
      for (i = 0; i < P.pillars.length; i++) {
        var pl = P.pillars[i];
        if (pl.side !== run.side) continue;
        var px = pl.x, pz = pl.z;
        var ph = pl.broken ? rng.range(0.55, 1.5) : 3.70;
        B.wear = {
          grime: 0.76 + rng.range(-0.08, 0.12), wet: 1 - (pl.broken ? 0.14 : 0),
          edge: 0.82 + rng.range(-0.10, 0.12)
        };
        B.box('sandstone', G_PILLAR * 1.35, 0.24, G_PILLAR * 1.35, px, floorY + 0.12, pz);
        B.box(rng.bool(0.22) ? 'mossy' : 'sandstone', G_PILLAR, ph - 0.24, G_PILLAR,
          px, floorY + 0.24 + (ph - 0.24) * 0.5, pz);
        if (!pl.broken) {
          B.frus('sandstone', G_PILLAR, G_PILLAR, G_PILLAR * 1.45, G_PILLAR * 1.45,
            0.30, px, floorY + 3.85, pz);
          B.box('sandstone', G_PILLAR * 1.55, 0.16, G_PILLAR * 1.55, px, floorY + 4.08, pz);
        } else {
          // the shaft it dropped, lying across the corridor
          B.boxR('sandstone', G_PILLAR, rng.range(1.6, 2.8), G_PILLAR,
            px + (axis === 'x' ? rng.range(-0.6, 0.6) : rng.range(0.4, 1.6)) * run.dir * -1,
            floorY + G_PILLAR * 0.55,
            pz + (axis === 'x' ? rng.range(0.4, 1.6) * run.dir * -1 : rng.range(-0.6, 0.6)),
            Math.PI * 0.5, rng.range(0, 3.14), rng.range(-0.15, 0.15));
        }
        B.wear = null;
        self.addCollider(px, floorY + ph * 0.5, pz, G_PILLAR * 0.62, ph * 0.5,
          G_PILLAR * 0.62, 'stone');
      }

      // ---- architrave + corbelled vault -------------------------------------
      var segL = 2.9;
      var nseg = Math.max(1, Math.round(span / segL));
      var sl = span / nseg;
      for (i = 0; i < nseg; i++) {
        var sa = run.a0 + (i + 0.5) * sl;
        var down = (run.side === 'w' && sa > BREACH_Z0 - 1.0 && sa < BREACH_Z1 + 1.0);
        var openTop = holed(run.side, sa);
        var settle = N.fbm2(sa * 0.085 + 4.0, wc * 0.085 - 2.0, 3) * 0.09;
        // architrave over the pillars, present even in the collapse (it is
        // what the fallen roof was resting on)
        if (!down) {
          B.wear = { grime: 0.74, wet: 1, edge: 0.80 };
          if (axis === 'x') B.box('sandstone', sl * 0.98, 0.46, 0.66, sa, floorY + 4.39 + settle, pillarB);
          else B.box('sandstone', 0.66, 0.46, sl * 0.98, pillarB, floorY + 4.39 + settle, sa);
          B.wear = null;
        }
        if (down || openTop) {
          if (down && rng.bool(0.7)) {
            // roof stones in the corridor where they fell
            scatterBlocks(self, B, rng,
              axis === 'x' ? sa : corrMid, floorY, axis === 'x' ? corrMid : sa,
              1.5, 5, 0.85, { flat: true });
          }
          continue;
        }
        // four corbel courses per side, closing to a capstone
        B.wear = { grime: 0.84 + rng.range(-0.06, 0.08), wet: 1, edge: 0.90 };
        for (k = 0; k < 4; k++) {
          var off = corrW * 0.36 - k * 0.34;
          var cy = floorY + 4.62 + settle + k * 0.40;
          for (var sgn = -1; sgn <= 1; sgn += 2) {
            var oa = corrMid + sgn * (off + 0.45);
            if (axis === 'x') B.box('sandstone_d', sl * 0.99, 0.42, 0.98, sa, cy, oa);
            else B.box('sandstone_d', 0.98, 0.42, sl * 0.99, oa, cy, sa);
          }
        }
        var capY = floorY + 4.62 + settle + 4 * 0.40;
        if (axis === 'x') B.box('sandstone', sl * 0.99, 0.36, 1.30, sa, capY, corrMid);
        else B.box('sandstone', 1.30, 0.36, sl * 0.99, corrMid, capY, sa);
        // ridge moulding, so the roofline is not a flat extrusion
        if (axis === 'x') B.box('sandstone', sl * 0.60, 0.22, 0.52, sa, capY + 0.28, corrMid);
        else B.box('sandstone', 0.52, 0.22, sl * 0.60, corrMid, capY + 0.28, sa);
        B.wear = null;
      }

      // roof collider so the player cannot walk through the gallery from above
      var cn = Math.max(1, Math.round(span / 6));
      for (i = 0; i < cn; i++) {
        var ca = run.a0 + (i + 0.5) * (span / cn);
        if (run.side === 'w' && ca > BREACH_Z0 - 1 && ca < BREACH_Z1 + 1) continue;
        if (axis === 'x') {
          self.addCollider(ca, floorY + 5.4, corrMid, span / cn * 0.5, 1.0, corrW * 0.62, 'stone');
        } else {
          self.addCollider(corrMid, floorY + 5.4, ca, corrW * 0.62, 1.0, span / cn * 0.5, 'stone');
        }
      }

      // ---- gallery floor ----------------------------------------------------
      var fr = axis === 'x'
        ? { x0: run.a0, x1: run.a1, z0: Math.min(innerFace, pillarB) - 0.4, z1: Math.max(innerFace, pillarB) + 0.4 }
        : { x0: Math.min(innerFace, pillarB) - 0.4, x1: Math.max(innerFace, pillarB) + 0.4, z0: run.a0, z1: run.a1 };
      pave(self, B, rng, fr, floorY, { pitch: 1.42, jitter: 0.7 });
    }

    // the breach spoil - the wall that came down, spread both sides
    var bz = (BREACH_Z0 + BREACH_Z1) * 0.5;
    scatterBlocks(self, B, rng, -G_X - 1.6, 0, bz, 5.2, 34, 0.95);
    scatterBlocks(self, B, rng, -G_PX + 0.4, 0.28, bz, 4.4, 26, 0.85);
    // one big lintel left standing on end in the gap - a vertical in the gap
    B.wear = { grime: 0.70, wet: 1, edge: 0.72 };
    B.boxR('sandstone', 0.62, 3.4, 0.86, -G_X + 1.1, 1.6, bz + 2.6, 0.14, 0.4, 0.10);
    B.wear = null;
    self.addCollider(-G_X + 1.1, 1.6, bz + 2.6, 0.4, 1.7, 0.5, 'stone');

    return HOLES;
  }

  // ============================================================== sanctuary ==
  // The temple-mountain: three retaining tiers carrying five prasats. Each
  // tier is a laterite core with a coursed sandstone facing, a moulded plinth
  // and a cornice, and each is paved as a RING - laying slabs under the tier
  // above them would be 400 hidden draw-call-worth of triangles.
  function buildTerrace(self, B, rng) {
    var prevY = -0.70;
    var t, i;
    for (t = 0; t < TIER.length; t++) {
      var T = TIER[t];
      var x0 = T_CX - T.hx, x1 = T_CX + T.hx;
      var z0 = T_CZ - T.hz, z1 = T_CZ + T.hz;
      var h = T.y - prevY;

      // core
      B.wear = { grime: 0.86, wet: 1, edge: 0.94 };
      B.box('laterite', T.hx * 2 - 1.3, h + 0.5, T.hz * 2 - 1.3, T_CX, prevY + h * 0.5 - 0.25, T_CZ);
      B.wear = null;

      // facing on all four sides, with the great stair cut through the south
      var stairGap = { a: T_CX, w: STAIR_HALF * 2 + 1.2, h: h + 0.1, y0: 0, noLintel: true };
      var faces = [
        { axis: 'x', a0: x0, a1: x1, b: z1 - 0.42, doors: [stairGap] },
        { axis: 'x', a0: x0, a1: x1, b: z0 + 0.42, doors: [] },
        { axis: 'z', a0: z0, a1: z1, b: x0 + 0.42, doors: [] },
        { axis: 'z', a0: z0, a1: z1, b: x1 - 0.42, doors: [] }
      ];
      for (i = 0; i < faces.length; i++) {
        var f = faces[i];
        wallRun(self, B, rng, {
          axis: f.axis, a0: f.a0, a1: f.a1, b: f.b, y: prevY, h: h, t: 0.84,
          key: 'sandstone', capH: 0.34, doors: f.doors, batter: 0.06,
          seg: 1.9, colliderMat: 'stone'
        });
        // moulded plinth at the foot
        var pl = f.a1 - f.a0;
        var pn = Math.max(1, Math.round(pl / 3.0));
        for (var q = 0; q < pn; q++) {
          var pa = f.a0 + (q + 0.5) * (pl / pn);
          if (f.doors.length && Math.abs(pa - T_CX) < STAIR_HALF + 0.6) continue;
          B.wear = { grime: 0.68, wet: 0.86, edge: 0.80 };
          if (f.axis === 'x') B.box('sandstone', pl / pn * 0.98, 0.30, 1.20, pa, prevY + 0.15, f.b);
          else B.box('sandstone', 1.20, 0.30, pl / pn * 0.98, f.b, prevY + 0.15, pa);
          B.wear = null;
        }
      }

      // top: paved ring, skipping the footprint of the tier above
      var skip = [];
      if (t + 1 < TIER.length) {
        skip.push({
          x0: T_CX - TIER[t + 1].hx - 0.2, x1: T_CX + TIER[t + 1].hx + 0.2,
          z0: T_CZ - TIER[t + 1].hz - 0.2, z1: T_CZ + TIER[t + 1].hz + 0.2
        });
      }
      // and the stair landing, which is built as steps
      skip.push({ x0: T_CX - STAIR_HALF - 0.3, x1: T_CX + STAIR_HALF + 0.3,
        z0: z1 - 2.2, z1: z1 + 0.5 });
      pave(self, B, rng, { x0: x0 + 0.2, x1: x1 - 0.2, z0: z0 + 0.2, z1: z1 - 0.2 },
        T.y, { pitch: 1.52, skip: skip, jitter: 0.8 });
      prevY = T.y;
    }

    // ---- THE GREAT STAIR ----------------------------------------------------
    // 5.4 m of rise in three flights at 34 degrees. Real temple stairs are
    // this steep and it is the reason the sanctuary reads as a climb rather
    // than as a ramp with a handrail.
    var segs = self.plan.stairSegs || [];
    for (i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (Math.abs(s.y1 - s.y0) < 0.02) {
        // a landing
        pave(self, B, rng, { x0: T_CX - STAIR_HALF, x1: T_CX + STAIR_HALF, z0: s.z0, z1: s.z1 },
          s.y0, { pitch: 1.2, jitter: 0.6 });
        continue;
      }
      var run = s.z1 - s.z0;
      var rise = s.y1 - s.y0;
      var n = Math.max(2, Math.round(Math.abs(rise) / 0.235));
      for (var k = 0; k < n; k++) {
        var f2 = (k + 0.5) / n;
        var sz = s.z0 + run * f2;
        var sy = s.y0 + rise * f2;
        var broken = rng.bool(0.10);
        B.wear = {
          grime: 0.70 + rng.range(-0.08, 0.10), wet: 1 - (sy < 0.9 ? 0.22 : 0),
          edge: 0.72 + rng.range(-0.10, 0.16)
        };
        var sth = Math.abs(rise) / n + 0.30;
        B.boxR(broken ? 'mossy' : 'sandstone',
          STAIR_HALF * 2 * (broken ? rng.range(0.55, 0.9) : 1.0),
          sth, Math.abs(run) / n * 1.25,
          T_CX + (broken ? rng.range(-0.5, 0.5) : 0), sy - sth * 0.5, sz,
          rng.gaussian(0, 0.012), 0, rng.gaussian(0, 0.010));
        B.wear = null;
      }
      // cheek walls with a naga rail, both sides
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var cx = T_CX + sgn * (STAIR_HALF + 0.34);
        var mz = (s.z0 + s.z1) * 0.5, my = (s.y0 + s.y1) * 0.5;
        var ang = Math.atan2(rise, run);
        var L = Math.sqrt(run * run + rise * rise);
        B.wear = { grime: 0.72, wet: 1, edge: 0.78 };
        B.boxR('sandstone', 0.62, 0.72, L, cx, my + 0.10, mz, -ang, 0, 0);
        B.boxR('sandstone', 0.40, 0.26, L, cx, my + 0.56, mz, -ang, 0, 0);
        B.wear = null;
        self.addCollider(cx, my + 0.5, mz, 0.34, Math.abs(rise) * 0.5 + 0.5, Math.abs(run) * 0.5, 'stone');
      }
    }
    // guardian lions at the foot of the stair
    for (i = -1; i <= 1; i += 2) {
      var lx = T_CX + i * (STAIR_HALF + 1.05), lz = self.plan.stairSegs[0].z1 + 0.5;
      var ly = self.sampleGround(lx, lz);
      B.wear = { grime: 0.68, wet: 0.88, edge: 0.70 };
      B.box('sandstone', 1.05, 0.42, 1.35, lx, ly + 0.21, lz);
      B.frus('sandstone', 0.80, 1.10, 0.62, 0.90, 0.85, lx, ly + 0.85, lz);
      B.boxR('sandstone', 0.46, 0.72, 0.42, lx, ly + 1.58, lz - 0.24, -0.18, 0, 0);
      B.box('sandstone', 0.52, 0.30, 0.46, lx, ly + 1.92, lz - 0.32);   // head
      B.box('sandstone', 0.20, 0.20, 0.26, lx, ly + 1.88, lz - 0.60);   // muzzle
      for (var e2 = -1; e2 <= 1; e2 += 2) {
        B.box('sandstone', 0.14, 0.20, 0.14, lx + e2 * 0.19, ly + 2.10, lz - 0.28);
        B.boxR('sandstone', 0.17, 0.62, 0.17, lx + e2 * 0.28, ly + 1.20, lz - 0.46, 0.22, 0, 0);
      }
      B.wear = null;
      self.addCollider(lx, ly + 1.0, lz, 0.55, 1.0, 0.7, 'stone');
    }
  }

  // ============================================================== libraries ==
  function buildLibrary(self, B, rng, L) {
    var y = 0.16;
    var hw = L.w * 0.5, hd = L.d * 0.5;
    var ruined = L.ruin || 0;
    var c = Math.cos(L.yaw), s = Math.sin(L.yaw);
    function W(o) {
      // o in local (a along the wall, b across) -> world
      var wx = L.x + o.bx * c + o.bz * s;
      var wz = L.z - o.bx * s + o.bz * c;
      return [wx, wz];
    }
    // plinth
    B.wear = { grime: 0.80, wet: 0.88, edge: 0.88 };
    B.boxR('laterite', L.w + 1.4, 0.44, L.d + 1.4, L.x, y + 0.22, L.z, 0, L.yaw, 0);
    B.wear = null;
    var fy = y + 0.44;
    // four walls, coursed, with the far end fallen when ruined
    var eh = L.eave - 0.44;
    var q, p;
    for (q = 0; q < 4; q++) {
      var along = (q % 2) === 0 ? L.w : L.d;
      var off = (q % 2) === 0 ? hd : hw;
      var sgn = q < 2 ? 1 : -1;
      var pts = [];
      var n = Math.max(2, Math.round(along / 1.5));
      for (p = 0; p < n; p++) {
        var a = -along * 0.5 + (p + 0.5) * (along / n);
        var lx = (q % 2) === 0 ? a : sgn * off;
        var lz = (q % 2) === 0 ? sgn * off : a;
        var wr = W({ bx: lx, bz: lz });
        var hh = eh;
        if (ruined > 0.3 && lz > 0) hh *= M.lerp(1, 0.35, ruined * M.smoothstep(-hd, hd, lz));
        // a doorway on the courtyard side
        var isDoor = (q === 1 && Math.abs(a) < 0.9);
        var courses = Math.max(1, Math.round(hh / 0.58));
        for (var cc = 0; cc < courses; cc++) {
          var cy = fy + (cc + 0.5) * (hh / courses);
          if (isDoor && cy < fy + 2.35) continue;
          B.wear = { grime: 0.76 + rng.range(-0.08, 0.1), wet: 1, edge: 0.84 };
          B.boxR(rng.bool(0.2) ? 'mossy' : 'sandstone',
            (q % 2) === 0 ? along / n * 0.96 : 0.62, hh / courses * 0.98,
            (q % 2) === 0 ? 0.62 : along / n * 0.96,
            wr[0], cy, wr[1], 0, L.yaw, 0);
          B.wear = null;
        }
      }
    }
    // corbelled roof, running along the long axis
    if (ruined < 0.5) {
      for (var k = 0; k < 4; k++) {
        var wgt = L.d * (1 - k * 0.21);
        var ky = fy + eh + 0.22 + k * 0.40;
        B.wear = { grime: 0.72, wet: 1, edge: 0.80 };
        B.boxR('sandstone', L.w + 0.5, 0.40, wgt, L.x, ky, L.z, 0, L.yaw, 0);
        B.wear = null;
      }
    } else {
      scatterBlocks(self, B, rng, L.x, y, L.z, hw + 1.2, 22, 0.85);
    }
    // the box is yawed, so its world extents are not its local ones
    var ac = Math.abs(c), as = Math.abs(s);
    self.addCollider(L.x, fy + eh * 0.5, L.z,
      ac * (hw + 0.4) + as * (hd + 0.4), eh * 0.5 + 0.4,
      as * (hw + 0.4) + ac * (hd + 0.4), 'stone');
    void W;
  }

  // ================================================================== trees ==
  // Silk-cotton / strangler fig. The important half is not the canopy, it is
  // the ROOT SYSTEM: a fig on a temple wall reads as a fig on a temple wall
  // because its roots run OVER the masonry and grip the far side, splitting
  // the courses as they thicken. Roots are generated against the wall the tree
  // is published as sitting on, not scattered near it.
  function buildTree(self, B, rng, sp) {
    var gy = sp.base != null ? sp.base : self.sampleGround(sp.x, sp.z);
    var H = sp.h, R = sp.r, i, j;
    var trunkH = H * (sp.kind === 'palm' ? 0.74 : 0.58);
    var lx = sp.lean[0], lz = sp.lean[1];

    // ---- trunk -------------------------------------------------------------
    var pts = [];
    var n = 6;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var yy = gy - 0.35 + trunkH * t;
      var wob = self.noise.fbm2(t * 3.1 + sp.x, sp.z, 2) * R * 0.35;
      pts.push([
        sp.x + lx * trunkH * t * t + wob,
        yy,
        sp.z + lz * trunkH * t * t + wob * 0.6,
        R * (1 - 0.58 * t) * (i === 0 ? 1.75 : 1)
      ]);
    }
    B.wear = { grime: 0.80, wet: 0.92, edge: 0.90 };
    B.add('bark', limb(pts, 9));
    var topX = pts[n][0], topY = pts[n][1], topZ = pts[n][2];

    // ---- buttress roots ----------------------------------------------------
    var nr = sp.kind === 'palm' ? 4 : 7;
    for (i = 0; i < nr; i++) {
      var ang = (i / nr) * Math.PI * 2 + rng.range(-0.3, 0.3);
      var reach = R * rng.range(2.6, 4.6);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var rp = [];
      for (j = 0; j <= 4; j++) {
        var u = j / 4;
        var rr = R * (0.62 - 0.50 * u) * (1 + 0.4 * (1 - u));
        var ry = gy + (1 - u) * (1 - u) * R * 2.1 - 0.30 * u;
        rp.push([sp.x + ca * reach * u, ry, sp.z + sa * reach * u, Math.max(0.06, rr)]);
      }
      B.add('bark', limb(rp, 6));
      // a fin of the buttress standing proud
      if (sp.kind !== 'palm') {
        B.boxR('bark', 0.20, R * 1.5, reach * 0.62,
          sp.x + ca * reach * 0.30, gy + R * 0.70, sp.z + sa * reach * 0.30,
          0, Math.atan2(ca, sa) + Math.PI * 0.5, 0);
      }
    }

    // ---- roots over a wall --------------------------------------------------
    if (sp.wall === 'e') {
      var wallX = G_X, inner = G_PX;
      for (i = 0; i < 9; i++) {
        var zo = sp.z + rng.range(-4.2, 4.2);
        var top = 0.28 + 3.70 + rng.range(-0.6, 1.4);
        var rp2 = [
          [sp.x + rng.range(-0.5, 0.5), gy + rng.range(0.4, 2.6), zo, R * 0.56],
          [wallX + 1.4, top * 0.75, zo + rng.range(-0.5, 0.5), R * 0.48],
          [wallX + 0.15, top, zo + rng.range(-0.6, 0.6), R * 0.40],
          [(wallX + inner) * 0.5, top - 0.5, zo + rng.range(-0.8, 0.8), R * 0.34],
          [inner + 0.2, 1.8, zo + rng.range(-1.0, 1.0), R * 0.27],
          [inner - 0.6, 0.30, zo + rng.range(-1.2, 1.2), R * 0.19]
        ];
        B.add('bark', limb(rp2, 6));
        // fingers spreading across the wall face
        for (j = 0; j < 3; j++) {
          var fz = zo + rng.range(-2.2, 2.2);
          B.add('bark', limb([
            [wallX + 0.55, top * rng.range(0.5, 0.9), zo, R * 0.16],
            [wallX + 0.50, top * rng.range(0.3, 0.6), fz, R * 0.11],
            [wallX + 0.46, rng.range(0.4, 1.4), fz + rng.range(-1.5, 1.5), R * 0.06]
          ], 5));
        }
      }
    }
    B.wear = null;

    // ---- branches + canopy ---------------------------------------------------
    var nb = sp.kind === 'palm' ? 7 : 6;
    var tips = [];
    for (i = 0; i < nb; i++) {
      var ba = (i / nb) * Math.PI * 2 + rng.range(-0.35, 0.35);
      var bl = H * rng.range(0.20, 0.34);
      var bc = Math.cos(ba), bs = Math.sin(ba);
      var up = sp.kind === 'palm' ? 0.25 : 0.75;
      var bp = [];
      for (j = 0; j <= 3; j++) {
        var v = j / 3;
        bp.push([
          topX + bc * bl * v, topY + bl * up * v - bl * 0.28 * v * v,
          topZ + bs * bl * v, R * (0.52 - 0.42 * v)
        ]);
      }
      B.wear = { grime: 0.82, wet: 0.94, edge: 0.90 };
      B.add('bark', limb(bp, 6));
      B.wear = null;
      tips.push(bp[3]);
    }
    // A canopy is a VOLUME, not a decoration. At 26 cards of 0.2 H the hero
    // figs photographed as bare saplings with confetti round them; the count
    // and the card size both have to be big enough that the crown reads as an
    // opaque mass with light coming through its edges.
    var nc = sp.kind === 'palm' ? 26 : 48;
    for (i = 0; i < nc; i++) {
      var tip = tips[i % tips.length];
      var cs = H * rng.range(0.20, 0.34);
      var cx = tip[0] + rng.gaussian(0, H * 0.085);
      var cy = tip[1] + rng.gaussian(0, H * 0.055) + H * 0.02;
      var cz = tip[2] + rng.gaussian(0, H * 0.085);
      B.wear = { grime: 0.86 + rng.range(-0.10, 0.14), wet: 1, edge: 1 };
      B.quad('leaf', cs, cs * rng.range(0.7, 1.1), cx, cy, cz,
        rng.range(-0.5, 0.5), rng.range(0, Math.PI * 2), rng.range(-0.4, 0.4),
        atlasLeaf(rng));
      B.wear = null;
    }
    self.addCollider(sp.x + lx * trunkH * 0.3, gy + trunkH * 0.5, sp.z + lz * trunkH * 0.3,
      R * 1.05, trunkH * 0.5, R * 1.05, 'wood');
    return { x: sp.x, y: gy, z: sp.z, top: topY, canopy: H };
  }

  var _leafUV = null;
  function atlasLeaf(rng) {
    if (!_leafUV) {
      _leafUV = [[0.004, 0.504, 0.496, 0.996], [0.504, 0.504, 0.996, 0.996],
        [0.004, 0.004, 0.496, 0.496], [0.504, 0.004, 0.996, 0.496]];
    }
    return _leafUV[rng.int(0, 3)];
  }

  // The wall of jungle the complex stands in. Merged, not instanced: at 46
  // triangles each these are cheaper as static geometry than as two
  // InstancedMeshes, and a merged bucket cannot silently overflow a cap.
  function buildForest(self, B, rng) {
    var N = self.noise, i;
    var placed = 0;
    for (i = 0; i < 900 && placed < 190; i++) {
      var x = rng.range(X_MIN + 2, X_MAX - 2);
      var z = rng.range(Z_MIN + 2, Z_MAX - 2);
      // keep out of the precinct and off the causeway
      if (Math.abs(x) < G_X + 5.5 && z > G_ZN - 5.5 && z < GOP_Z + 6) continue;
      if (Math.abs(x) < 27 && z > 20 && z < 60) continue;
      var d = Math.max(Math.abs(x) - G_X, Math.max(z - GOP_Z, G_ZN - z));
      var dens = M.saturate(N.fbm2(x * 0.05, z * 0.05, 2) * 1.4 + 0.55) *
        M.smoothstep(3.0, 16.0, d);
      if (!rng.bool(dens)) continue;
      var gy = self.sampleGround(x, z);
      if (gy < MOAT_Y + 0.25) continue;
      placed++;
      var H = rng.range(9, 21) * (0.75 + 0.25 * dens);
      var R = H * rng.range(0.020, 0.034);
      var lx = rng.gaussian(0, 0.06), lz = rng.gaussian(0, 0.06);
      var pts = [];
      for (var j = 0; j <= 3; j++) {
        var t = j / 3;
        pts.push([x + lx * H * t * t, gy - 0.3 + H * 0.66 * t, z + lz * H * t * t,
          R * (1 - 0.55 * t) * (j === 0 ? 1.5 : 1)]);
      }
      B.wear = { grime: 0.80, wet: 0.94, edge: 0.92 };
      B.add('bark', limb(pts, 5));
      B.wear = null;
      var tx = pts[3][0], ty = pts[3][1], tz = pts[3][2];
      var nc = 8;
      for (var c = 0; c < nc; c++) {
        var cs = H * rng.range(0.26, 0.44);
        B.wear = { grime: 0.84 + rng.range(-0.12, 0.12), wet: 1, edge: 1 };
        B.quad('leaf', cs, cs * rng.range(0.7, 1.0),
          tx + rng.gaussian(0, H * 0.10), ty + rng.gaussian(0, H * 0.09) + H * 0.06,
          tz + rng.gaussian(0, H * 0.10),
          rng.range(-0.4, 0.4), rng.range(0, Math.PI * 2), rng.range(-0.35, 0.35),
          atlasLeaf(rng));
        B.wear = null;
      }
      if (rng.bool(0.30)) {
        self.addCollider(x, gy + H * 0.3, z, R * 1.4, H * 0.3, R * 1.4, 'wood');
      }
    }
    return placed;
  }

  // =============================================================== fixtures ==
  // Every practical this level publishes has a body built here, at the same
  // coordinate, because lighting.js gives a lamp an emissive bulb and a halo
  // but it cannot invent the object the bulb is sitting in. A light with no
  // visible source is not a light.
  function buildFixtures(self, B, rng) {
    var P = self.plan;
    var F = self.fix = { lanterns: [], flames: [] };

    // ---- the shrine: oil lamps and candle stubs on a stone altar -----------
    var sh = P.shrine;
    var sy = sh.y;
    B.wear = { grime: 0.66, wet: 1, edge: 0.74 };
    B.box('sandstone', 1.90, 0.24, 1.05, sh.x, sy + 0.12, sh.z);
    B.box('sandstone', 1.55, 0.52, 0.80, sh.x, sy + 0.50, sh.z);
    B.box('sandstone', 1.95, 0.16, 1.10, sh.x, sy + 0.84, sh.z);
    // a lingam-like pedestal behind it
    B.add('sandstone', revolve([[0.34, 0], [0.30, 0.18], [0.22, 0.24], [0.22, 0.72],
      [0.20, 0.86], [0.13, 0.96], [0, 1.02]], 10), makeM(sh.x, sy + 0.92, sh.z - 0.06));
    B.wear = null;
    // five brass lamp bowls with flames
    for (var i = 0; i < 5; i++) {
      var lx = sh.x - 0.72 + i * 0.36;
      var lz = sh.z + 0.30;
      B.wear = { grime: 0.70, wet: 1, edge: 0.72 };
      B.add('brass', revolve([[0.055, 0], [0.085, 0.03], [0.10, 0.075], [0.075, 0.10]], 8),
        makeM(lx, sy + 0.92, lz));
      B.wear = null;
      B.add('lit', revolve([[0.030, 0], [0.042, 0.045], [0.020, 0.11], [0, 0.16]], 6),
        makeM(lx, sy + 1.01, lz));
      F.flames.push([lx, sy + 1.07, lz]);
    }
    // incense sticks
    for (i = 0; i < 6; i++) {
      B.rod('metal', sh.x + rng.range(-0.5, 0.5), sy + 1.00, sh.z - 0.22,
        sh.x + rng.range(-0.5, 0.5), sy + 1.42, sh.z - 0.24, 0.008, 4);
    }
    F.shrine = [sh.x, sy + 1.12, sh.z + 0.28];

    // ---- three hurricane lanterns in the south gallery ---------------------
    var galZ = G_PZS + G_PILLAR * 0.5;
    var lampX = [-12.24, -2.64, 6.96];
    for (i = 0; i < lampX.length; i++) {
      var px = lampX[i], pz = galZ;
      var hy = 0.28 + 2.55;
      // an iron bracket off the pillar, into the corridor
      B.wear = { grime: 0.62, wet: 1, edge: 0.70 };
      B.rod('metal', px, hy, pz + 0.22, px, hy, pz + 0.86, 0.022, 5);
      B.rod('metal', px, hy - 0.34, pz + 0.24, px, hy - 0.02, pz + 0.80, 0.018, 5);
      B.rod('metal', px, hy, pz + 0.80, px, hy - 0.20, pz + 0.80, 0.014, 5);
      // the lantern: a cage, a fount, a glass, a cap
      B.add('metal', revolve([[0.075, 0], [0.085, 0.035], [0.070, 0.085]], 8),
        makeM(px, hy - 0.30, pz + 0.80));
      for (var q = 0; q < 4; q++) {
        var a2 = q * Math.PI * 0.5 + 0.4;
        B.rod('metal',
          px + Math.cos(a2) * 0.062, hy - 0.28, pz + 0.80 + Math.sin(a2) * 0.062,
          px + Math.cos(a2) * 0.055, hy - 0.06, pz + 0.80 + Math.sin(a2) * 0.055, 0.008, 4);
      }
      B.add('metal', revolve([[0.078, 0], [0.095, 0.03], [0.055, 0.075], [0.030, 0.09]], 8),
        makeM(px, hy - 0.055, pz + 0.80));
      B.wear = null;
      B.add('lit', cyl(0.052, 0.058, 0.20, 8), makeM(px, hy - 0.18, pz + 0.80));
      F.lanterns.push([px, hy - 0.18, pz + 0.80]);
    }

    // ---- the looters' camp: a brazier under a tarp -------------------------
    var cp = P.camp;
    var cy = self.sampleGround(cp.x, cp.z);
    B.wear = { grime: 0.60, wet: 1, edge: 0.66 };
    B.add('metal', revolve([[0.42, 0], [0.46, 0.10], [0.40, 0.26], [0.36, 0.30]], 10),
      makeM(cp.x, cy + 0.34, cp.z));
    for (i = 0; i < 3; i++) {
      var la = i * 2.094 + 0.5;
      B.rod('metal', cp.x + Math.cos(la) * 0.30, cy + 0.34, cp.z + Math.sin(la) * 0.30,
        cp.x + Math.cos(la) * 0.40, cy, cp.z + Math.sin(la) * 0.40, 0.026, 5);
    }
    // embers and a couple of half-burnt sticks
    for (i = 0; i < 7; i++) {
      B.boxR('lit', rng.range(0.05, 0.13), 0.05, rng.range(0.05, 0.13),
        cp.x + rng.gaussian(0, 0.16), cy + 0.46, cp.z + rng.gaussian(0, 0.16),
        0, rng.range(0, 3), 0);
    }
    for (i = 0; i < 4; i++) {
      B.rod('bark', cp.x + rng.range(-0.5, 0.5), cy + 0.50, cp.z + rng.range(-0.5, 0.5),
        cp.x + rng.range(-0.7, 0.7), cy + 0.62, cp.z + rng.range(-0.7, 0.7), 0.030, 4);
    }
    B.wear = null;
    F.brazier = [cp.x, cy + 0.52, cp.z];
    // the tarp: four poles and a sagging sheet
    var tpx = cp.x + 1.9, tpz = cp.z - 0.9;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      B.wear = { grime: 0.68, wet: 1, edge: 0.78 };
      B.rod('bark', tpx + sx * 1.5, cy, tpz + sz * 1.4,
        tpx + sx * 1.42, cy + (sz > 0 ? 2.05 : 1.72), tpz + sz * 1.4, 0.045, 5);
      B.wear = null;
    }
    B.wear = { grime: 0.72, wet: 1, edge: 0.86 };
    for (i = 0; i < 3; i++) {
      var f3 = (i + 0.5) / 3;
      var sag = -0.16 * Math.sin(f3 * Math.PI);
      B.boxR('tarp', 3.05, 0.035, 2.85 / 3 * 1.02,
        tpx, cy + M.lerp(1.72, 2.05, 1 - f3) + sag, tpz - 1.4 + f3 * 2.8,
        -0.11, 0, rng.range(-0.02, 0.02));
    }
    B.wear = null;
    self.addCollider(tpx, cy + 1.0, tpz, 1.6, 1.0, 1.5, 'wood');

    // ---- the dig: a trench, boards, spoil, and a worklight on a tripod -----
    var dg = P.dig, tr = dg.trench;
    var dy = self.sampleGround(dg.x, dg.z);
    B.wear = { grime: 0.55, wet: 0.82, edge: 0.86 };
    for (i = 0; i < 5; i++) {
      var bz2 = tr.z0 + (i + 0.5) * (tr.z1 - tr.z0) / 5;
      B.boxR('timber', 0.28, 0.05, tr.x1 - tr.x0 - 0.4, tr.x0 + 1.2, dy + 0.03, bz2,
        0, rng.range(-0.04, 0.04), 0);
    }
    for (i = 0; i < 4; i++) {
      B.boxR('timber', 1.4, 0.06, 0.22, dg.x + rng.range(-1.5, 1.5), dy + 0.05,
        dg.z + rng.range(-2.0, 2.0), 0, rng.range(0, 3), 0);
    }
    B.wear = null;
    scatterBlocks(self, B, rng, dg.x - 2.4, dy, dg.z + 2.6, 2.2, 16, 0.5);
    // the tripod
    var wl = [dg.x + 0.4, dy + 1.62, dg.z - 1.3];
    B.wear = { grime: 0.58, wet: 1, edge: 0.66 };
    for (i = 0; i < 3; i++) {
      var ta = i * 2.094 + 0.3;
      B.rod('metal', wl[0] + Math.cos(ta) * 0.62, dy, wl[2] + Math.sin(ta) * 0.62,
        wl[0], wl[1] - 0.12, wl[2], 0.022, 5);
    }
    B.box('metal', 0.34, 0.24, 0.22, wl[0], wl[1], wl[2]);
    B.box('metal', 0.40, 0.30, 0.05, wl[0], wl[1], wl[2] + 0.13);
    B.box('metal', 0.30, 0.22, 0.34, dg.x - 1.5, dy + 0.11, dg.z - 1.9);   // battery
    B.wear = null;
    B.quad('lit', 0.30, 0.20, wl[0], wl[1], wl[2] + 0.155, 0, 0, 0);
    F.worklight = wl;

    // ---- a votive lamp in the gopura passage -------------------------------
    var vx = 1.35, vy = 0.30 + 1.05, vz = GOP_Z + 0.9;
    B.wear = { grime: 0.66, wet: 1, edge: 0.74 };
    B.box('sandstone', 0.46, 0.60, 0.34, vx, vy - 0.30, vz);
    B.box('sandstone', 0.56, 0.10, 0.42, vx, vy + 0.05, vz);
    B.add('brass', revolve([[0.06, 0], [0.10, 0.04], [0.085, 0.10]], 8),
      makeM(vx, vy + 0.10, vz));
    B.wear = null;
    B.add('lit', revolve([[0.032, 0], [0.045, 0.05], [0.018, 0.12], [0, 0.17]], 6),
      makeM(vx, vy + 0.19, vz));
    F.votive = [vx, vy + 0.26, vz];
    F.flames.push([vx, vy + 0.26, vz]);
  }

  // ================================================================== marks ==
  // Alpha-cut growth and staining laid over the stone. This is where moss
  // stops being a material choice and becomes a PATTERN - a fringe at every
  // wall base, a stain under every cornice, algae at every water line, litter
  // under every canopy - which is the difference between weathered stone and
  // stone that has been painted green.
  function buildMarks(self, B, rng) {
    var P = self.plan, N = self.noise, i, k;
    var MOSS = 0, LICHEN = 1, STAIN = 2, WORN = 3, ALGAE = 4, CRACK = 5,
      LITTER = 6, EFFL = 7, ROOTH = 8, FRINGE = 9, SILT = 10;

    function ground(cell, x, z, w, d, rot, tint) {
      var y = self.sampleGround(x, z) + 0.022;
      B.wear = tint || { grime: 1, wet: 1, edge: 1 };
      B.quad('decal', w, d, x, y, z, -Math.PI * 0.5, 0, rot || 0, atlasUV(cell));
      B.wear = null;
    }
    function onWall(cell, x, y, z, w, h, yaw, tint) {
      B.wear = tint || { grime: 1, wet: 1, edge: 1 };
      B.quad('decal', w, h, x, y, z, 0, yaw, 0, atlasUV(cell));
      B.wear = null;
    }

    // ---- moss fringe along every wall foot ---------------------------------
    var lines = [
      { axis: 'x', a0: -G_X, a1: G_X, b: G_ZS - G_WALL * 0.5, y: 0.28, out: 1 },
      { axis: 'x', a0: -G_X, a1: G_X, b: G_ZN + G_WALL * 0.5, y: 0.28, out: -1 },
      { axis: 'z', a0: G_ZN, a1: G_ZS, b: -G_X + G_WALL * 0.5, y: 0.28, out: -1 },
      { axis: 'z', a0: G_ZN, a1: G_ZS, b: G_X - G_WALL * 0.5, y: 0.28, out: 1 },
      { axis: 'x', a0: -ENC_X, a1: ENC_X, b: ENC_ZS, y: 0.16, out: 1 },
      { axis: 'z', a0: ENC_ZN, a1: ENC_ZS, b: -ENC_X, y: 0.16, out: -1 },
      { axis: 'z', a0: ENC_ZN, a1: ENC_ZS, b: ENC_X, y: 0.16, out: 1 }
    ];
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      var n = Math.round((L.a1 - L.a0) / 2.6);
      for (k = 0; k < n; k++) {
        var a = L.a0 + (k + 0.5) * (L.a1 - L.a0) / n;
        var amt = N.fbm2(a * 0.16, L.b * 0.1, 2) * 0.5 + 0.5;
        if (amt < 0.32) continue;
        var bx = L.axis === 'x' ? a : L.b + L.out * 0.75;
        var bz = L.axis === 'x' ? L.b + L.out * 0.75 : a;
        ground(rng.bool(0.6) ? FRINGE : MOSS, bx, bz, 3.0, 2.0,
          L.axis === 'x' ? 0 : Math.PI * 0.5,
          { grime: 1, wet: 0.85, edge: 1 });
      }
    }

    // ---- the worn path: causeway -> gate -> court -> stair -----------------
    var path = [
      [0.4, 54], [0.2, 46], [-0.3, 38], [0.1, 30], [0, 24], [0.2, 18],
      [-0.4, 12], [0.3, 6], [0, 2], [-0.2, -2], [0.1, -4]
    ];
    for (i = 0; i + 1 < path.length; i++) {
      var steps = 4;
      for (k = 0; k < steps; k++) {
        var u = (k + 0.5) / steps;
        var px = M.lerp(path[i][0], path[i + 1][0], u) + rng.range(-0.5, 0.5);
        var pz = M.lerp(path[i][1], path[i + 1][1], u);
        ground(WORN, px, pz, rng.range(3.0, 4.6), rng.range(2.6, 4.0), rng.range(0, 3));
      }
    }
    // and the branch to the camp and the dig
    for (i = 0; i < 10; i++) {
      ground(WORN, M.lerp(0, P.camp.x, i / 9) + rng.range(-0.6, 0.6),
        M.lerp(-1.0, P.camp.z, i / 9) + rng.range(-0.6, 0.6), 3.0, 2.6, rng.range(0, 3));
    }

    // ---- algae and silt around every pool ----------------------------------
    for (i = 0; i < P.pools.length; i++) {
      var p = P.pools[i];
      var per = 2 * ((p.x1 - p.x0) + (p.z1 - p.z0));
      var n2 = Math.min(60, Math.round(per / 2.4));
      for (k = 0; k < n2; k++) {
        var t = k / n2 * 4;
        var side = t | 0, u2 = t - side;
        var ex, ez;
        if (side === 0) { ex = M.lerp(p.x0, p.x1, u2); ez = p.z0; }
        else if (side === 1) { ex = p.x1; ez = M.lerp(p.z0, p.z1, u2); }
        else if (side === 2) { ex = M.lerp(p.x1, p.x0, u2); ez = p.z1; }
        else { ex = p.x0; ez = M.lerp(p.z1, p.z0, u2); }
        ground(rng.bool(0.55) ? ALGAE : SILT, ex + rng.range(-0.6, 0.6),
          ez + rng.range(-0.6, 0.6), rng.range(2.4, 4.0), rng.range(2.0, 3.4),
          rng.range(0, 3), { grime: 1, wet: 0.55, edge: 1 });
      }
    }

    // ---- leaf litter under every canopy ------------------------------------
    for (i = 0; i < P.trees.length; i++) {
      var tr = P.trees[i];
      for (k = 0; k < 16; k++) {
        var ang = rng.range(0, 6.283), rr = tr.h * 0.30 * Math.sqrt(rng.next());
        ground(rng.bool(0.7) ? LITTER : ROOTH, tr.x + Math.cos(ang) * rr,
          tr.z + Math.sin(ang) * rr, rng.range(2.6, 4.4), rng.range(2.4, 4.0),
          rng.range(0, 3));
      }
    }

    // ---- water staining down the tower and gallery faces -------------------
    for (i = 0; i < P.towers.length; i++) {
      var tw = P.towers[i];
      if (tw.fallen) continue;
      for (k = 0; k < 10; k++) {
        var fyaw = (k % 4) * Math.PI * 0.5;
        var hw = tw.w * 0.46;
        var hy = tw.base + tw.h * rng.range(0.10, 0.55);
        onWall(rng.bool(0.55) ? STAIN : LICHEN,
          tw.x + Math.sin(fyaw) * (hw + 0.06) + Math.cos(fyaw) * rng.range(-hw * 0.6, hw * 0.6),
          hy,
          tw.z + Math.cos(fyaw) * (hw + 0.06) - Math.sin(fyaw) * rng.range(-hw * 0.6, hw * 0.6),
          rng.range(1.2, 2.4), rng.range(2.0, 4.0), fyaw);
      }
    }
    // and down the gallery's outer wall, where the cornice sheds
    for (i = 0; i < 46; i++) {
      var e = rng.int(0, 3);
      var aa, xx, zz, yaw2;
      if (e === 0) { aa = rng.range(-G_X, G_X); xx = aa; zz = G_ZS + 0.02; yaw2 = 0; }
      else if (e === 1) { aa = rng.range(G_ZN, G_ZS); xx = G_X + 0.02; zz = aa; yaw2 = Math.PI * 0.5; }
      else if (e === 2) { aa = rng.range(G_ZN, G_ZS); xx = -G_X - 0.02; zz = aa; yaw2 = -Math.PI * 0.5; }
      else { aa = rng.range(-G_X, G_X); xx = aa; zz = G_ZN - 0.02; yaw2 = Math.PI; }
      onWall(rng.bool(0.5) ? STAIN : (rng.bool(0.5) ? MOSS : EFFL),
        xx, 0.28 + rng.range(0.6, 2.8), zz, rng.range(1.4, 2.8), rng.range(1.8, 3.4), yaw2);
    }
    // cracks across the courtyard flagstones
    for (i = 0; i < 26; i++) {
      ground(CRACK, rng.range(-24, 24), rng.range(-36, 2), rng.range(3, 6),
        rng.range(3, 6), rng.range(0, 3));
    }
  }

  // =================================================================== mist ==
  // The ground mist is REAL GEOMETRY, not only a fog term, because a fog term
  // cannot sit BETWEEN two objects at the same distance and this level's whole
  // read is depth separation - a tower base dissolving while its crown does
  // not. Three layers of large soft cards, drifting on the same bearing the
  // sun comes from, with the sunward half warmed.
  function buildMist(self, rng) {
    var N = self.noise;
    var ents = [], i;
    // Small, low, patchy - anchored on the places that would actually be
    // steaming at first light: the standing water, the moat, the shaded
    // courtyard behind the gallery, the low ground under the trees. A card
    // above eye height is always wrong (you see its underside as a ceiling),
    // so nothing here reaches 0.9 m.
    var seeds = [];
    var P = self.plan;
    for (i = 0; i < P.pools.length; i++) {
      var p = P.pools[i];
      var per = Math.max(2, Math.round(((p.x1 - p.x0) * (p.z1 - p.z0)) / 46));
      for (var q = 0; q < per; q++) {
        seeds.push([rng.range(p.x0 - 4, p.x1 + 4), rng.range(p.z0 - 4, p.z1 + 4), 1.0]);
      }
    }
    for (i = 0; i < 10; i++) seeds.push([rng.range(-26, 26), rng.range(-38, 2), 0.85]);
    for (i = 0; i < 6; i++) seeds.push([rng.range(-28, 28), rng.range(6, 20), 0.7]);
    for (i = 0; i < 14; i++) {
      seeds.push([rng.range(X_MIN + 10, X_MAX - 10), rng.range(Z_MIN + 10, Z_MAX - 10), 0.6]);
    }
    // SMALL cards. A 30 m card at 0.7 m covers every pixel below the horizon
    // at one alpha, which is a sheet of tracing paper over the level and is
    // exactly how round two photographed. At 11 m they read as discrete
    // patches lying in the hollows, which is what ground mist does.
    var layers = [
      { y: 0.30, n: seeds.length, s: 11, o: 1.00 },
      { y: 0.62, n: Math.round(seeds.length * 0.50), s: 15, o: 0.60 }
    ];
    var cols = [];
    for (var l = 0; l < layers.length; l++) {
      var L = layers[l];
      for (i = 0; i < L.n; i++) {
        var sd = seeds[(i * (l + 1) * 7 + l * 3) % seeds.length];
        var x = sd[0] + rng.gaussian(0, 3.5);
        var z = sd[1] + rng.gaussian(0, 3.5);
        var s = L.s * rng.range(0.7, 1.35) * (0.7 + 0.5 * sd[2]);
        var g = quad(s, s);
        ents.push({
          geometry: g,
          matrix: makeM(x, L.y + rng.range(-0.18, 0.18), z,
            -Math.PI * 0.5, 0, rng.range(0, Math.PI * 2))
        });
        // warmer toward the sun, cooler away: the mist is the only surface in
        // the level big enough to carry the level's whole colour axis
        var sunward = M.saturate((x * SUN_X + z * SUN_Z) / 60 * 0.5 + 0.5);
        var warm = M.smoothstep(0.35, 0.95, sunward);
        cols.push([
          M.lerp(0.115, 0.290, warm) * L.o * sd[2],
          M.lerp(0.134, 0.216, warm) * L.o * sd[2],
          M.lerp(0.168, 0.152, warm) * L.o * sd[2]
        ]);
      }
    }
    if (!ents.length) return null;
    var geo;
    try { geo = Geo.mergeAll(ents); }
    catch (e) { GAME.logError('ruins.mist', e); return null; }
    // per-card colour
    var cnt = geo.attributes.position.count;
    var col = new Float32Array(cnt * 3);
    var per = 6;
    for (i = 0; i < cnt; i++) {
      var c = cols[Math.min(cols.length - 1, (i / per) | 0)];
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    void N;
    return geo;
  }

  // ============================================================== LevelRuins ==
  function LevelRuins(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_ruins';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.instanced = [];
    this.lightShafts = [];
    this.practicalLights = [];
    this.anchors = {};
    this.field = null;
    this.fix = null;
    this._matCache = Object.create(null);
    this._atlas = null;
    this._leafTex = null;
    this._waterMat = null;
    this._litMat = null;
    this._mist = null;
    this._hash = new GAME.SpatialHash(5.0);
    this._stamp = 0;
    this._t = 0;

    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x5255494e) : new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x8A17E3) >>> 0);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(X_MIN - 6, -20, Z_MIN - 6),
      new THREE.Vector3(X_MAX + 6, 46, Z_MAX + 6));

    try {
      this.plan = plan(this.noise, this.rng.fork ? this.rng.fork(0x51A) : this.rng);
      this._buildField();
      this.anchors = buildAnchors(this, this.plan);
    } catch (e) {
      GAME.logError('ruins.survey', e);
      this.plan = this.plan || { pools: [], platforms: [], ramps: [], stairSegs: [],
        basins: [], pillars: [], towers: [], trees: [], rubble: [], doors: [], runs: [],
        libraries: [], naga: [] };
      this.anchors = this.anchors || {};
    }
  }

  // The heightfield, sampled once so sampleGround is a bilinear lookup rather
  // than four octaves of fbm per call - props and the AI hit it thousands of
  // times a frame.
  LevelRuins.prototype._buildField = function () {
    var w = Math.round((X_MAX - X_MIN) / CELL) + 1;
    var h = Math.round((Z_MAX - Z_MIN) / CELL) + 1;
    var a = new Float32Array(w * h);
    for (var j = 0; j < h; j++) {
      var z = Z_MIN + j * CELL;
      for (var i = 0; i < w; i++) {
        a[j * w + i] = terrainY(X_MIN + i * CELL, z, this.noise, this.plan);
      }
    }
    this.field = { x0: X_MIN, z0: Z_MIN, cell: CELL, w: w, h: h, a: a };
  };

  // ---------------------------------------------------------------- anchors --
  function buildAnchors(self, P) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    var A = {};
    var i;
    A.site = {
      x0: X_MIN, x1: X_MAX, z0: Z_MIN, z1: Z_MAX, axisZ: true,
      sunDir: new THREE.Vector3(SUN_X, Math.tan(SUN_EL), SUN_Z).normalize(),
      groundY: function (x, z) { return self.sampleGround(x, z); }
    };
    A.causeway = {
      z0: CW_Z0, z1: CW_Z1, half: CW_HALF, deckY: CW_Y,
      centre: function (z) { return V(0, CW_Y, z); },
      nagaL: -(CW_HALF + 0.34), nagaR: CW_HALF + 0.34,
      posts: P.naga
    };
    A.moat = { x0: -25.2, x1: 25.2, z0: 24.8, z1: 57.2, waterY: MOAT_Y, half: CW_HALF + 2.3 };
    A.gopura = {
      centre: V(0, 0.30, GOP_Z), yaw: 0,
      halfX: GOP_HALF_X, halfZ: GOP_HALF_Z, floorY: 0.30,
      passage: { x0: -1.70, x1: 1.70, z0: GOP_Z - GOP_HALF_Z, z1: GOP_Z + GOP_HALF_Z,
        headY: 0.30 + 4.10 },
      wings: [V(-5.70, 0.30, GOP_Z), V(5.70, 0.30, GOP_Z)],
      wingTop: 5.30, towerBase: 5.60, apex: 14.20
    };
    A.enclosure = { x0: -ENC_X, x1: ENC_X, z0: ENC_ZN, z1: ENC_ZS, capY: 0.16 + ENC_CAP };
    A.libraries = [];
    for (i = 0; i < P.libraries.length; i++) {
      var L = P.libraries[i];
      A.libraries.push({
        name: L.name, centre: V(L.x, 0.16, L.z), yaw: L.yaw, w: L.w, d: L.d,
        eave: 0.16 + L.eave, ruin: L.ruin,
        door: V(L.x - Math.sin(L.yaw) * (L.d * 0.5 + 0.4), 0.60,
          L.z - Math.cos(L.yaw) * (L.d * 0.5 + 0.4))
      });
    }
    A.gallery = {
      x0: -G_X, x1: G_X, z0: G_ZN, z1: G_ZS,
      wallT: G_WALL, corridorW: G_CORR, pillarX: G_PX, pillarZ: G_PZS,
      floorY: 0.28, roofY: 0.28 + 4.62, capY: 0.28 + 4.62 + 4 * 0.40 + 0.36,
      pillars: P.pillars, doors: P.doors, runs: P.runs,
      breach: { side: 'w', x: -G_X, z0: BREACH_Z0, z1: BREACH_Z1,
        centre: V(-G_X + 1.0, 0.6, (BREACH_Z0 + BREACH_Z1) * 0.5) },
      corridorMid: {
        s: ((G_ZS - G_WALL) + (G_PZS + G_PILLAR * 0.5)) * 0.5,
        n: ((G_ZN + G_WALL) + (G_PZN - G_PILLAR * 0.5)) * 0.5,
        w: ((-G_X + G_WALL) + (-G_PX - G_PILLAR * 0.5)) * 0.5,
        e: ((G_X - G_WALL) + (G_PX + G_PILLAR * 0.5)) * 0.5
      }
    };
    A.courtyard = { x0: -G_PX, x1: G_PX, z0: G_PZN, z1: G_PZS, floorY: 0.0 };
    A.terrace = {
      centre: V(T_CX, 0, T_CZ),
      tiers: [], stair: { half: STAIR_HALF, segs: P.stairSegs,
        foot: V(T_CX, 0.10, P.stairSegs[0].z1), head: V(T_CX, TIER[2].y, P.stairSegs[4].z0) }
    };
    for (i = 0; i < TIER.length; i++) {
      A.terrace.tiers.push({
        x0: T_CX - TIER[i].hx, x1: T_CX + TIER[i].hx,
        z0: T_CZ - TIER[i].hz, z1: T_CZ + TIER[i].hz, y: TIER[i].y
      });
    }
    A.towers = [];
    for (i = 0; i < P.towers.length; i++) {
      var t = P.towers[i];
      A.towers.push({
        name: t.name, centre: V(t.x, t.base, t.z), baseY: t.base,
        apexY: t.base + t.h, halfW: t.w * 0.5,
        faceY: t.base + t.h * 0.40, fallen: !!t.fallen
      });
    }
    A.pools = [];
    for (i = 0; i < P.pools.length; i++) {
      var p = P.pools[i];
      A.pools.push({ name: p.name, x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, waterY: p.y });
    }
    A.trees = [];
    for (i = 0; i < P.trees.length; i++) {
      var tr = P.trees[i];
      A.trees.push({
        name: tr.name, centre: V(tr.x, tr.base != null ? tr.base : self.sampleGround(tr.x, tr.z), tr.z),
        height: tr.h, radius: tr.r, kind: tr.kind
      });
    }
    A.rubble = [];
    for (i = 0; i < P.rubble.length; i++) {
      A.rubble.push({ centre: V(P.rubble[i].x, P.rubble[i].y, P.rubble[i].z), radius: P.rubble[i].r });
    }
    A.shrine = { centre: V(P.shrine.x, P.shrine.y, P.shrine.z), yaw: 0,
      altar: V(P.shrine.x, P.shrine.y + 0.92, P.shrine.z) };
    A.camp = { centre: V(P.camp.x, self.sampleGround(P.camp.x, P.camp.z), P.camp.z),
      yaw: P.camp.yaw,
      brazier: V(P.camp.x, self.sampleGround(P.camp.x, P.camp.z) + 0.5, P.camp.z),
      tarp: V(P.camp.x + 1.9, self.sampleGround(P.camp.x + 1.9, P.camp.z - 0.9) + 1.9, P.camp.z - 0.9) };
    A.dig = { centre: V(P.dig.x, self.sampleGround(P.dig.x, P.dig.z), P.dig.z),
      yaw: P.dig.yaw, trench: P.dig.trench,
      light: V(P.dig.x + 0.4, self.sampleGround(P.dig.x, P.dig.z) + 1.62, P.dig.z - 1.3) };
    A.knoll = { centre: V(P.knoll.x, self.sampleGround(P.knoll.x, P.knoll.z), P.knoll.z),
      radius: P.knoll.r };
    A.spawn = { position: V(0.9, CW_Y + 0.05, CW_Z1 - 2.5), yaw: 0 };
    return A;
  }

  // ------------------------------------------------------- ground sampling --
  // The natural field, then every BUILT floor on top of it. A platform wins
  // over the terrain and a stair flight wins over both, so a caller asking
  // "what is under this point" gets the surface a player would stand on
  // whether that is mud, a flagstone or the fortieth step.
  LevelRuins.prototype.sampleGround = function (x, z) {
    var y = -1e9;
    var F = this.field;
    if (F) {
      var fx = (x - F.x0) / F.cell, fz = (z - F.z0) / F.cell;
      if (fx >= 0 && fz >= 0 && fx <= F.w - 1.001 && fz <= F.h - 1.001) {
        var i0 = fx | 0, j0 = fz | 0;
        var tx = fx - i0, tz = fz - j0;
        var a = F.a[j0 * F.w + i0], b = F.a[j0 * F.w + i0 + 1];
        var c = F.a[(j0 + 1) * F.w + i0], d = F.a[(j0 + 1) * F.w + i0 + 1];
        y = M.lerp(M.lerp(a, b, tx), M.lerp(c, d, tx), tz);
      } else {
        y = terrainY(x, z, this.noise, this.plan);
      }
    }
    var P = this.plan;
    if (!P) return y;
    var k, p;
    for (k = 0; k < P.platforms.length; k++) {
      p = P.platforms[k];
      if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1 && p.y > y) y = p.y;
    }
    for (k = 0; k < P.ramps.length; k++) {
      p = P.ramps[k];
      if (p.z1 <= p.z0) continue;
      if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) {
        var ry = M.lerp(p.y0, p.y1, (z - p.z0) / (p.z1 - p.z0));
        if (ry > y) y = ry;
      }
    }
    if (Math.abs(x - T_CX) < STAIR_HALF + 0.15) {
      for (k = 0; k < P.stairSegs.length; k++) {
        var s = P.stairSegs[k];
        if (z >= s.z0 && z <= s.z1) {
          var sy = M.lerp(s.y0, s.y1, (z - s.z0) / (s.z1 - s.z0 || 1));
          if (sy > y) y = sy;
        }
      }
    }
    return y;
  };

  // ------------------------------------------------------------- materials --
  LevelRuins.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.sandstone;
    var m = null;
    try {
      if (surf.own === 'water') m = this._waterMaterial();
      else if (surf.own === 'leaf') m = this._leafMaterial();
      else if (surf.own === 'lit') m = this._litMaterial();
      else if (surf.own === 'decal') m = this._decalMaterial();
      else {
        var lib = this.ctx && this.ctx.materials;
        var name = surf.base || 'stone';
        var has = false;
        try { has = !!(lib && typeof lib.has === 'function' && lib.has(name)); }
        catch (e) { has = false; }
        if (lib && typeof lib.get === 'function' && has) {
          var opts = { vertexColors: true, wearMode: surf.mult ? 'multiply' : 'wear' };
          if (surf.alb != null) opts.albedoTarget = surf.alb;
          if (surf.hue != null) opts.hue = surf.hue;
          if (surf.env != null) opts.envMapIntensity = surf.env;
          m = lib.get(name, opts);
        }
      }
    } catch (e2) {
      GAME.logError('ruins.material:' + key, e2);
      m = null;
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelRuins.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.sandstone;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2], vertexColors: true
    });
    m.name = 'ruins_fallback_' + key;
    return m;
  };

  LevelRuins.prototype._aniso = function () {
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (caps && caps.getMaxAnisotropy) return Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
    } catch (e) { /* a nicety */ }
    return 4;
  };

  // STILL WATER. The single brightest surface in the level and the only one
  // that carries the dawn sky down into the bottom of the frame. Nearly a
  // mirror (roughness 0.075) with a very shallow ripple normal, and DARK -
  // a courtyard pool is 30 cm of tea over silt, so almost everything it
  // returns is a reflection rather than a body colour.
  LevelRuins.prototype._waterMaterial = function () {
    var tex = null;
    try { tex = makeTex(buildWaterNormal(this.noise), false, this._aniso()); }
    catch (e) { GAME.logError('ruins.waterNormal', e); }
    if (tex) tex.repeat.set(1, 1);
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x161f1c, THREE.SRGBColorSpace),
      roughness: 0.075, metalness: 0.0, vertexColors: true,
      envMapIntensity: 1.75
    });
    if (tex) {
      m.normalMap = tex;
      m.normalScale = new THREE.Vector2(0.38, 0.38);
    }
    m.name = 'ruins_water';
    this._waterMat = m;
    return m;
  };

  LevelRuins.prototype._leafMaterial = function () {
    var tex = null;
    try {
      this._leafTex = buildLeafTexture(this.rng.fork ? this.rng.fork(0x1EAF) : this.rng);
      tex = makeTex(this._leafTex, true, this._aniso(), false);
    } catch (e) { GAME.logError('ruins.leafTex', e); }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.86, metalness: 0.0,
      alphaTest: 0.32, side: THREE.DoubleSide, vertexColors: true
    });
    if (!tex) m.color = new THREE.Color().setHex(0x46562f, THREE.SRGBColorSpace);
    m.name = 'ruins_leaf';
    return m;
  };

  // Flames and lamp glass. Dark albedo, hot emissive - it has to READ as a
  // source and postfx's veiling bloom is what turns it into one. In a frame
  // graded to a narrow rose-gold these are the only saturated marks.
  LevelRuins.prototype._litMaterial = function () {
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x241408, THREE.SRGBColorSpace),
      roughness: 0.40, metalness: 0.0, vertexColors: true,
      emissive: new THREE.Color().setHex(0xffa54a, THREE.SRGBColorSpace),
      emissiveIntensity: 4.4, side: THREE.DoubleSide, fog: true
    });
    m.name = 'ruins_lit';
    this._litMat = m;
    return m;
  };

  LevelRuins.prototype._decalMaterial = function () {
    var tex = null;
    try {
      this._atlas = buildDecalAtlas(this.rng.fork ? this.rng.fork(0xDECA1) : this.rng);
      tex = makeTex(this._atlas, true, this._aniso(), false);
    } catch (e) { GAME.logError('ruins.atlas', e); }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.92, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.035,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.name = 'ruins_marks';
    return m;
  };

  // ------------------------------------------------------------- colliders --
  LevelRuins.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
    var q = new THREE.Quaternion();
    if (euler) q.setFromEuler(euler);
    var c = {
      type: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'stone',
      floor: !!isFloor
    };
    this.colliders.push(c);
    return c;
  };

  // ------------------------------------------------------------------ build --
  LevelRuins.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng;
    var B = new Builder();

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('ruins.' + name, e); }
    }

    stage('ground', function () { buildGround(self, rng); });
    await GAME.yieldFrame();

    stage('causeway', function () { buildCauseway(self, B, rng); });
    stage('enclosure', function () { buildEnclosure(self, B, rng); });
    await GAME.yieldFrame();

    stage('gopura', function () { buildGopura(self, B, rng); });
    stage('gallery', function () { self._holes = buildGallery(self, B, rng); });
    await GAME.yieldFrame();

    stage('court', function () {
      // The inner courtyard, paved to the terrain so it dishes toward its own
      // standing water. The terrace footprint, the stair and the two deep
      // pools are skipped - laying slabs under a tier or under a metre of
      // water is geometry nobody will ever see.
      var P = self.plan;
      pave(self, B, rng,
        { x0: -G_PX + 0.3, x1: G_PX - 0.3, z0: G_PZN + 0.3, z1: G_PZS - 0.3 },
        0, {
          follow: true, pitch: 1.66, jitter: 0.9,
          skip: [
            { x0: T_CX - TIER[0].hx - 0.5, x1: T_CX + TIER[0].hx + 0.5,
              z0: T_CZ - TIER[0].hz - 0.5, z1: T_CZ + TIER[0].hz + 0.5 },
            { x0: T_CX - STAIR_HALF - 1.1, x1: T_CX + STAIR_HALF + 1.1,
              z0: -14.0, z1: -2.4 },
            { x0: P.basins[2].x0 - 1.0, x1: P.basins[2].x1 + 1.0,
              z0: P.basins[2].z0 - 1.0, z1: P.basins[2].z1 + 1.0 },
            { x0: P.basins[4].x0 - 1.0, x1: P.basins[4].x1 + 1.0,
              z0: P.basins[4].z0 - 1.0, z1: P.basins[4].z1 + 1.0 }
          ]
        });
      // the outer court, and the gate platform
      pave(self, B, rng,
        { x0: -ENC_X + 1.2, x1: ENC_X - 1.2, z0: ENC_ZN + 0.2, z1: GOP_Z - GOP_HALF_Z },
        0.16, {
          pitch: 1.72, jitter: 1.0,
          skip: [
            { x0: -21.2, x1: -12.8, z0: 8.9, z1: 14.3 },
            { x0: 12.8, x1: 21.2, z0: 8.9, z1: 14.3 }
          ]
        });
      pave(self, B, rng,
        { x0: -GOP_HALF_X + 0.6, x1: GOP_HALF_X - 0.6,
          z0: GOP_Z - GOP_HALF_Z, z1: GOP_Z + GOP_HALF_Z },
        0.30, { pitch: 1.35, jitter: 0.7 });
    });
    stage('terrace', function () { buildTerrace(self, B, rng); });
    stage('towers', function () {
      var P = self.plan;
      for (var i = 0; i < P.towers.length; i++) {
        var t = P.towers[i];
        if (t.fallen) {
          // a stump, its own stone around it, and one slab still leaning
          B.wear = { grime: 0.66, wet: 1, edge: 0.66 };
          B.frus('sandstone', t.w, t.w, t.w * 0.92, t.w * 0.92, t.h, t.x, t.base + t.h * 0.5, t.z);
          B.boxR('sandstone', t.w * 0.55, 3.4, 0.9, t.x + t.w * 0.75, t.base + 1.5,
            t.z - t.w * 0.35, 0.42, 0.6, 0.18);
          B.wear = null;
          self.addCollider(t.x, t.base + t.h * 0.5, t.z, t.w * 0.5, t.h * 0.5, t.w * 0.5, 'stone');
          continue;
        }
        faceTower(self, B, rng, t);
      }
    });
    await GAME.yieldFrame();

    stage('libraries', function () {
      for (var i = 0; i < self.plan.libraries.length; i++) {
        buildLibrary(self, B, rng, self.plan.libraries[i]);
      }
    });
    stage('rubble', function () {
      var P = self.plan;
      for (var i = 0; i < P.rubble.length; i++) {
        var r = P.rubble[i];
        scatterBlocks(self, B, rng, r.x, r.y, r.z, r.r, r.n, r.big);
      }
      // FOREGROUND STONE. Every published framing needs something inside 6 m
      // or it photographs as a diorama: these piles are placed against the
      // hero standpoints deliberately and are the closest thing in each frame.
      scatterBlocks(self, B, rng, -8.4, 0, -3.2, 3.2, 16, 0.85);
      scatterBlocks(self, B, rng, 4.6, 0, -7.4, 2.8, 12, 0.75);
      scatterBlocks(self, B, rng, 19.8, 0, -19.2, 3.0, 16, 0.9);
      scatterBlocks(self, B, rng, 16.2, 0, -24.4, 3.4, 16, 0.8);
      scatterBlocks(self, B, rng, -3.0, 0, 9.6, 3.0, 14, 0.7);
      // a fallen lintel standing on end, and a toppled colonnette
      B.wear = { grime: 0.66, wet: 1, edge: 0.68 };
      B.boxR('sandstone', 0.72, 3.05, 0.94, -9.6, 1.35, -1.8, 0.10, 0.55, 0.32);
      B.boxR('mossy', 0.62, 2.60, 0.66, 15.8, 0.42, -19.4, 1.48, 0.9, 0.12);
      B.wear = null;
      self.addCollider(-9.6, 1.2, -1.8, 0.5, 1.4, 0.6, 'stone');
      // the knoll's ruined boundary shrine - the overview's foreground
      var K = self.plan.knoll;
      // THE OLDER SHRINE on the hill: a 9 m prasat stub, sheared off, that the
      // jungle took first. It is the overview's left-hand vertical - an
      // elevated standpoint cannot have a foreground on the GROUND (from 14 m
      // up the nearest visible ground is 17 m away), so its foreground has to
      // be something TALL and close, and this and the fig are it.
      var kx = K.x + 2.5, kz = K.z - 12.0;
      var ky = self.sampleGround(kx, kz);
      B.wear = { grime: 0.60, wet: 1, edge: 0.62 };
      B.box('laterite', 5.4, 0.7, 5.4, kx, ky + 0.35, kz);
      B.frus('sandstone', 4.4, 4.4, 3.9, 3.9, 3.0, kx, ky + 2.2, kz);
      B.frus('sandstone', 3.7, 3.7, 3.1, 3.1, 2.7, kx, ky + 5.0, kz);
      B.frus('mossy', 2.9, 2.9, 2.3, 2.3, 2.0, kx - 0.15, ky + 7.3, kz + 0.1);
      B.boxR('mossy', 2.1, 1.5, 2.1, kx + 1.9, ky + 1.6, kz + 1.7, 0.30, 0.4, 0.20);
      B.wear = null;
      falseDoor(self, B, rng, kx, ky + 0.7, kz + 2.25, 0, 1.5, 2.3, 0.24);
      // stone spilling down the slope toward the standpoint
      scatterBlocks(self, B, rng, kx + 2.0, ky, kz + 3.0, 6.0, 30, 0.9);
      scatterBlocks(self, B, rng, K.x + 7.0, ky, K.z - 6.0, 6.0, 22, 0.75);
      self.addCollider(kx, ky + 4.2, kz, 2.4, 4.2, 2.4, 'stone');
    });
    await GAME.yieldFrame();

    stage('trees', function () {
      var P = self.plan;
      self.builtTrees = [];
      for (var i = 0; i < P.trees.length; i++) {
        self.builtTrees.push(buildTree(self, B, rng, P.trees[i]));
      }
    });
    stage('forest', function () { self._forestN = buildForest(self, B, rng); });
    await GAME.yieldFrame();

    stage('water', function () { buildWater(self, B, rng); });
    stage('fixtures', function () { buildFixtures(self, B, rng); });
    stage('marks', function () { buildMarks(self, B, rng); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    stage('mist', function () {
      var g = buildMist(self, rng);
      if (!g) return;
      var mat = new THREE.MeshBasicMaterial({
        map: makeTex(buildMistTexture(self.noise), true, 4, false),
        transparent: true, depthWrite: false, vertexColors: true,
        side: THREE.DoubleSide, fog: true, opacity: 1.0, toneMapped: true
      });
      var mesh = new THREE.Mesh(g, mat);
      mesh.name = 'ruins_mist';
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      mesh.castShadow = false; mesh.receiveShadow = false;
      self.root.add(mesh);
      self._mist = mesh;
      self._mistMat = mat;
    });
    await GAME.yieldFrame();

    stage('floor', function () { self._buildFloor(); });
    stage('lights', function () { self._buildLights(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('nav', function () { self._buildNav(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    // The atmosphere this level is about. sky.js's fog block is the AUTHORED
    // BASE and its own schedule multiplies it, so setting it here is the
    // documented way for a level to say "the air is different in here" without
    // touching a shared file. A LOW e-folding height is the whole trick: the
    // mist has to end below the tower cornices so a prasat rises OUT of it.
    try {
      if (this.ctx && this.ctx.sky && this.ctx.sky.setFog) {
        this.ctx.sky.setFog({
          density: 0.0175, heightScale: 4.6, baseY: -0.4,
          startDistance: 1.8, mieG: 0.70, maxOpacity: 0.88, desaturate: 0.10
        });
      }
    } catch (e) { GAME.logError('ruins.fog', e); }

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    _frusCache.forEach(function (g) { g.dispose(); }); _frusCache.clear();
    return this;
  };

  LevelRuins.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.sandstone;
      if (key === 'decal' || key === 'leaf') {
        this.material(key);                       // force the atlas to exist
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('ruins.merge:' + key, e); continue; }
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('ruins.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'ruins_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'water') mesh.renderOrder = 1;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // ---------------------------------------------------------------- paint --
  // materials.js's WEAR convention, which is exactly the vocabulary a ruin
  // needs:  R grime (water staining, soot, dirt in the crevices),  G wetness
  // (dew, the damp band at the foot of every wall, pool margins),  B edge wear
  // (chipped arrises showing pale unweathered sandstone). All three are
  // MODULATED per vertex here rather than per piece, because the difference
  // between "a weathered wall" and "a wall with a weathered texture on it" is
  // whether the weathering knows where the ground and the edges are.
  var _pv = new THREE.Vector3();
  var _pinv = new THREE.Matrix4();
  LevelRuins.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = this.noise;
    var surf = SURF[key] || SURF.sandstone;
    var own = !!surf.own;
    var doEdges = !own && key !== 'earth';
    var vi = 0, e, i, j;

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var w = ent.wear;
      var g0 = w ? w.grime : 1, w0 = w ? w.wet : 1, e0 = w ? w.edge : 1;
      var hx = 1, hy = 1, hz = 1;
      if (doEdges) {
        var bb = ent.geometry.__rbb;
        if (!bb) {
          ent.geometry.computeBoundingBox();
          var b = ent.geometry.boundingBox;
          bb = ent.geometry.__rbb = [
            Math.max(1e-3, (b.max.x - b.min.x) * 0.5),
            Math.max(1e-3, (b.max.y - b.min.y) * 0.5),
            Math.max(1e-3, (b.max.z - b.min.z) * 0.5)
          ];
        }
        hx = bb[0]; hy = bb[1]; hz = bb[2];
        _pinv.copy(ent.matrix).invert();
      }
      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var ny = na[j + 1];
        var r = g0, g = w0, b2 = e0;

        if (own) {
          // no wear shader behind these - a plain multiplier, kept neutral so
          // a leaf card never picks up a magenta cast from a grime channel
          var vv = 1 + noise.fbm2(x * 0.42 + 3, z * 0.42 - 7, 2) * 0.14;
          r = g0 * vv; g = g0 * vv; b2 = g0 * vv;
          if (key === 'water') {
            // algae is a real green, so the water bucket does tint
            var alg = M.saturate(noise.fbm2(x * 0.16 + 5, z * 0.16 + 2, 3) * 1.3 + 0.35);
            r = g0 * (1 - alg * 0.22); g = g0 * (1 + alg * 0.10); b2 = g0 * (1 - alg * 0.12);
          }
          col[j] = r; col[j + 1] = g; col[j + 2] = b2;
          continue;
        }

        // ---- grime: water runs DOWN, and it collects where it stops --------
        var gy = this.sampleGround(x, z);
        var hgt = y - gy;
        var streak = noise.fbm2(x * 1.35 + 11.0, y * 0.24 - 4.0, 3) * 0.5 + 0.5;
        var down = M.saturate(-ny * 0.5 + 0.5);         // 1 on an underside
        r *= 1 - streak * 0.16 * (1 - Math.abs(ny)) - down * 0.14;
        r *= 1 - M.smoothstep(1.5, 0.0, hgt) * 0.18;    // the dirty foot
        r *= 1 + noise.fbm2(x * 0.31, z * 0.31 + 9, 2) * 0.10;

        // ---- wet: the damp band at the foot of a wall ----------------------
        // GATED ON THE NORMAL, and that gate is the whole lesson of the first
        // capture round. materials.js's G channel drops roughness and raises
        // specular; applied to every surface within a metre of the ground it
        // turned every FLAGSTONE in the level into a mirror, and a mirror
        // lying flat under a dawn sky returns the sky at grazing incidence -
        // so the courtyard, the causeway deck and the gallery floor all
        // photographed as sheets of pale blue ice with no material at all.
        // Water films run down vertical faces and pool in joints; a swept
        // flagstone in the dry season is dry.
        g *= 1 - M.smoothstep(0.75, -0.10, hgt) * 0.30 * (1 - M.saturate(ny) * 0.92);

        // ---- edge wear: chipped arrises -----------------------------------
        if (doEdges) {
          _pv.set(x, y, z).applyMatrix4(_pinv);
          var ex = Math.abs(_pv.x) / hx, ey = Math.abs(_pv.y) / hy, ez = Math.abs(_pv.z) / hz;
          var nEdge = (ex > 0.88 ? 1 : 0) + (ey > 0.88 ? 1 : 0) + (ez > 0.88 ? 1 : 0);
          if (nEdge >= 2) {
            var chip = M.saturate(noise.fbm2(x * 2.3 + 17, z * 2.3 - 5, 2) * 1.6 + 0.35);
            b2 *= 1 - chip * 0.42;
          }
        }
        col[j] = M.clamp(r, 0.05, 1.6);
        col[j + 1] = M.clamp(g, 0.05, 1.6);
        col[j + 2] = M.clamp(b2, 0.05, 1.6);
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // Thick floor slabs under the whole play area. The player controller
  // resolves against colliders, not against sampleGround, so without these
  // there is no floor at all.
  LevelRuins.prototype._buildFloor = function () {
    var step = 2.6;
    for (var z = -50; z < 60; z += step) {
      for (var x = -46; x < 46; x += step) {
        var top = -1e9;
        for (var sj = 0; sj <= 2; sj++) {
          for (var si = 0; si <= 2; si++) {
            var y = this.sampleGround(x + si * step * 0.5, z + sj * step * 0.5);
            if (y > top) top = y;
          }
        }
        if (top < -1e8) continue;
        this.addCollider(x + step * 0.5, top - 1.0, z + step * 0.5,
          step * 0.5, 1.0, step * 0.5, 'stone', true);
      }
    }
  };

  // =============================================================== the rig ==
  // A temple at first light has no street lighting and inventing some would be
  // a lie. What it does have is FIRE: the shrine's oil lamps, lit before dawn
  // and still burning; three hurricane lanterns somebody hung along the south
  // gallery; a looters' brazier in the courtyard, down to embers; a votive
  // lamp in the gate passage. Against those, one cold source - a battery
  // worklight over the dig trench that has been running all night - which is
  // the level's only cool practical and the thing that keeps the frame from
  // being one temperature.
  //
  // Every one has dayBase near 1: the env profile puts this level on the 'sun'
  // rig, whose lamp gate reads about 0.29 at a horizon sun, and a shrine lamp
  // that dims itself at sunrise because a global schedule says so would be
  // wrong in the one direction nobody would ever check.
  LevelRuins.prototype._buildLights = function () {
    var F = this.fix || {};
    var pl = this.practicalLights = [];
    var i;

    if (F.shrine) {
      pl.push({
        name: 'shrine_lamps', kind: 'fire', pos: F.shrine.slice(),
        kelvin: 1900, intensity: 26, distance: 13, dayBase: 1.0,
        haloScale: 1.15, haloMax: 2.3, bulbR: 0.11, fixed: 1
      });
    }
    var lan = F.lanterns || [];
    for (i = 0; i < lan.length; i++) {
      pl.push({
        name: 'gallery_lantern_' + i, kind: 'fire', pos: lan[i].slice(),
        kelvin: 2150, intensity: 15, distance: 9.5, dayBase: 1.0,
        haloScale: 0.85, haloMax: 1.8, bulbR: 0.065, fixed: 1
      });
    }
    if (F.brazier) {
      pl.push({
        name: 'camp_brazier', kind: 'fire', pos: F.brazier.slice(),
        kelvin: 1820, intensity: 34, distance: 15, dayBase: 1.0,
        haloScale: 1.25, haloMax: 2.6, bulbR: 0.17, bulbFlat: 0.5, fixed: 1
      });
    }
    if (F.votive) {
      pl.push({
        name: 'gopura_votive', kind: 'fire', pos: F.votive.slice(),
        kelvin: 2000, intensity: 13, distance: 9, dayBase: 1.0,
        haloScale: 0.9, haloMax: 1.9, bulbR: 0.07, fixed: 1
      });
    }
    if (F.worklight && this.plan.dig) {
      var w = F.worklight;
      var tr = this.plan.dig.trench;
      pl.push({
        name: 'dig_worklight', kind: 'tungsten', pos: w.slice(),
        kelvin: 4300, intensity: 96, distance: 21, dayBase: 0.92,
        cone: 0.62, penumbra: 0.55,
        aimPos: [(tr.x0 + tr.x1) * 0.5, 0.05, (tr.z0 + tr.z1) * 0.5],
        haloScale: 1.0, haloMax: 2.1, haloGain: 0.6,
        bulbR: 0.10, bulbFlat: 0.45, fixed: 1
      });
    }

    // ---- shafts ------------------------------------------------------------
    // Four, and all four are holes this file actually cut. lighting.js's shaft
    // solver traces DOWNWARD from the published origin and a declarative level
    // is treated as authoritative about where its own apertures are, so these
    // are real coordinates on real geometry - not a wish for a beam.
    var shafts = this.lightShafts = [];
    var lean = new THREE.Vector3(SUN_X * 0.30, -1, SUN_Z * 0.30).normalize();
    var corrS = ((G_ZS - G_WALL) + (G_PZS + G_PILLAR * 0.5)) * 0.5;
    var roofY = 0.28 + 4.62 + 4 * 0.40;
    var H = this._holes || {};
    var sH = H.s || [[-9.6, -6.2], [4.6, 7.4]];
    for (i = 0; i < sH.length && i < 2; i++) {
      shafts.push({
        kind: 'gallery_hole_' + i,
        origin: new THREE.Vector3((sH[i][0] + sH[i][1]) * 0.5, roofY - 0.2, corrS),
        dir: lean.clone(),
        width: Math.min(2.9, sH[i][1] - sH[i][0]), length: 7.0, strength: 1.0
      });
    }
    // the gate passage's light well
    shafts.push({
      kind: 'gopura_well',
      origin: new THREE.Vector3(0, 0.30 + 4.10 + 4 * 0.44 - 0.15, GOP_Z),
      dir: lean.clone(), width: 1.55, length: 5.4, strength: 0.9
    });
    // The east gallery's collapsed bay. The west breach is deliberately NOT
    // published: it is open sky, so postfx's volumetric pass already carries
    // the beam through it off the key's own cascade, and adding a lighting.js
    // cone there stood a discrete white wedge in mid-air that read as a
    // rendering fault rather than as light. A shaft entry is for an aperture
    // with a ROOF over it.
    var eH = (H.e && H.e[0]) || [-16.0, -12.0];
    var corrE = ((G_X - G_WALL) + (G_PX + G_PILLAR * 0.5)) * 0.5;
    shafts.push({
      kind: 'east_gallery_hole',
      origin: new THREE.Vector3(corrE, roofY - 0.2, (eH[0] + eH[1]) * 0.5),
      dir: lean.clone(), width: 2.6, length: 6.5, strength: 0.85
    });
  };

  // ------------------------------------------- spawns and published framings --
  LevelRuins.prototype._buildSpawns = function () {
    var self = this;
    var A = this.anchors;
    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + (yOff || 0.03), z),
        yaw: yaw
      });
    }
    // [0] is the player: the head of the causeway, looking up it at the gate.
    sp(0.9, CW_Z1 - 3.0, 0.02);
    sp(-1.8, CW_Z1 - 12.0, 0.0);
    sp(2.2, 30.0, -0.04);
    sp(-6.0, 12.0, 0.10);
    sp(9.5, 10.0, -0.20);
    sp(-3.0, 3.0, 0.0);
    sp(-14.0, -4.0, 0.6);
    sp(12.0, -6.0, -0.5);
    sp(-18.0, -20.0, 1.4);
    sp(18.0, -22.0, -1.4);
    sp(0.0, -36.0, 3.14);
    sp(-24.0, 3.6, 1.55);
    sp(24.0, -30.0, -1.55);
    sp(0.0, -12.0, 0.0, 0.05);

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
    var g;

    // ---- HERO1 : the signature image ----------------------------------------
    // Standing in the inner courtyard, west of the axis, looking north-north-
    // west at the sanctuary. Everything the level is is in one frame and every
    // element is at a DIFFERENT depth, which is the only thing that keeps a
    // misty dawn from collapsing into a flat wash:
    //    3-6 m : the guardian lion at the foot of the great stair and a pile
    //            of fallen blocks - the darkest, hardest masses in the frame
    //   2-11 m : the sheet of standing water over the flagstones, which is
    //            reflecting the burning horizon and is the BRIGHTEST thing in
    //            the bottom half of the picture
    //  10-20 m : the three flights of the stair and the tier cornices
    //  20-24 m : the central prasat, its faces at 13-17 m, and the two near
    //            corner towers flanking it
    //     40 m : the north gallery roofline dissolving
    // The sun is 31.6 degrees to the LEFT of the view axis and 9.6 degrees up,
    // so it clears the west gallery roof and rakes ACROSS the frame: every
    // west-facing face is lit, every south-facing one is not, and the shadows
    // of the towers run 80 m toward the camera through the mist. That is where
    // the god rays come from - they are the towers' own shadows in the volume,
    // not an effect asked for by name.
    // RE-SOLVED. The first mark stood 5.2 m WEST of the axis at the courtyard
    // edge and aimed at the tower base: the great stair - the one leading line
    // the sanctuary has - fell outside the frame entirely, and the picture was
    // a wall of tier facing with towers on top of it. On the axis instead, and
    // pitched to put the horizon of the frame at 4 m, the stair runs from the
    // bottom edge to the tower, a guardian lion sits at each bottom corner,
    // and the two sheets of standing water flank the flight.
    var h1x = -1.85, h1z = 1.20;
    g = this.sampleGround(h1x, h1z);
    // 12 degrees of pitch, not 16: at 16 the bottom of the frame was 4.3 m
    // out and the two guardian lions at the foot of the stair - the only hard
    // foreground the framing has - sat just under the edge. At 12 they anchor
    // the bottom corners, the sheet of standing water comes in on the left,
    // and the tower apex still clears the top of a 75-degree frame by 3.
    var hero1 = pose(h1x, g + 1.66, h1z, 0.25, 4.3, -11.0);

    // ---- HERO2 : the fig on the east gallery --------------------------------
    // The Ta Prohm image, and deliberately the OPPOSITE lighting to hero1: the
    // sun is behind the camera's left shoulder, so the tree, the roots pouring
    // over the gallery wall and the broken colonnade are all front-lit and
    // warm, with their shadows running away from the lens. The shallow pool
    // starting 1.4 m ahead carries the bottom of the frame.
    var h2x = 19.0, h2z = -21.4;
    var h2g = this.sampleGround(h2x, h2z);
    var hero2 = pose(h2x, h2g + 1.66, h2z, 25.8, 4.6, -12.6);

    // ---- HERO3 : the causeway and the gate ----------------------------------
    // The arrival. Standing on the causeway deck with the naga balustrade
    // running away on both sides into the mist over the moat, the gate tower
    // and its four faces closing the vista at 18 m. The one framing in the set
    // with a low horizon and a large sky, which is what makes the other four
    // read as enclosed.
    // PITCH SOLVED, NOT GUESSED. Aimed at the gate tower's own face the
    // pitch came out at 23 degrees, which put the bottom of the frame 10 m
    // in front of the camera - i.e. the causeway deck and both naga
    // balustrades, the entire leading line the framing exists for, were
    // below the picture. Aiming at the lintel instead drops it to 7 and the
    // deck runs from the bottom edge to the gate, with the flooded moat in
    // both lower corners; the tower apex still clears the top by 11 degrees.
    var h3z = 41.0, h3x = -1.05;
    var hero3 = pose(h3x, CW_Y + 1.66, h3z, 0.35, 4.6, GOP_Z + GOP_HALF_Z);

    // ---- INTERIOR : the south gallery ---------------------------------------
    // Inside the colonnade, looking east down 40 m of corridor. The corbelled
    // vault is overhead, the courtyard light comes in sideways between the
    // pillars on the right, two bays of the roof are missing 6 m and 22 m
    // ahead and drop shafts across the floor, and a hurricane lantern hangs
    // 3.5 m in on the left. Nothing in it is lit by the sun at all.
    var corrS = ((G_ZS - G_WALL) + (G_PZS + G_PILLAR * 0.5)) * 0.5;
    var interior = pose(-15.6, 0.28 + 1.64, corrS - 0.25, 12.0, 1.55, corrS - 0.10);

    // ---- OVERVIEW ------------------------------------------------------------
    // From the jungle knoll outside the south-west corner, 8.5 m above the
    // precinct, looking north-east ACROSS the axis. Two reasons this mark and
    // not the obvious one on the causeway: it is 80 degrees off the key, so
    // the complex is modelled by side light instead of being a silhouette; and
    // it has a real foreground - a ruined boundary shrine at 10 m and the
    // knoll's own stone - which is the single thing the harbor's first
    // overview lacked.
    var K = this.plan.knoll || { x: -44, z: 22 };
    var ovx = K.x + 2.0, ovz = K.z - 2.0;
    var ovy = this.sampleGround(ovx, ovz) + 1.72;
    var overview = pose(ovx, ovy, ovz, 2.0, 6.5, -14.0);

    // A fifth framing, published under the optional `hero4` key scenarios.js
    // already understands: the central prasat's south face from the courtyard,
    // close enough to read the carving. The level's signature asset deserves
    // one framing that is only about it.
    var hero4 = pose(0.0, CW_Y + 1.66, 32.0, 0.0, 8.95, GOP_Z + 3.05);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      hero4: hero4, interior: interior,
      // the level's own names for the same marks
      sanctuary: hero1, fig: hero2, causeway: hero3, gallery: interior
    };
    void A;
  };

  // ------------------------------------------------------------------- nav --
  LevelRuins.prototype._buildNav = function () {
    var cell = 0.85;
    var ox = -46, oz = -50;
    var w = Math.ceil((46 - ox) / cell);
    var h = Math.ceil((60 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      obst.push([ce.x - he.x - 0.30, ce.x + he.x + 0.30, ce.z - he.z - 0.30, ce.z + he.z + 0.30,
        ce.y - he.y, ce.y + he.y]);
    }
    var P = this.plan;
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var idx = iz * w + ix;
        var y = this.sampleGround(x, z);
        height[idx] = y;
        var ok = 1;
        // the moat and the deep pools are not walkable
        for (var k = 0; k < P.pools.length; k++) {
          var p = P.pools[k];
          if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1 && p.y - y > 0.45) { ok = 0; break; }
        }
        if (ok) {
          for (i = 0; i < obst.length; i++) {
            var o = obst[i];
            if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
            if (o[5] > y + 0.42 && o[4] < y + 1.85) { ok = 0; break; }
          }
        }
        walkable[idx] = ok;
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

  // ------------------------------------------------------ broadphase + ray --
  LevelRuins.prototype._buildBroadphase = function () {
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

  LevelRuins.prototype.raycast = function (origin, dir, maxDist) {
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
    var guard = 0, t = 0;
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

  // ----------------------------------------------------------------- frame --
  // The stone does not move. Two things do, and both of them are the reason
  // the level is not a photograph of a model: every flame in it is a flame,
  // and the mist is AIR - it drifts, on the same bearing the sun comes from,
  // slowly enough that no single frame shows it moving and no two frames of a
  // capture are identical.
  LevelRuins.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);
    var t = this._t;
    var m = this._litMat;
    if (m) {
      var f = 0.88 + 0.09 * Math.sin(t * 2.3) + 0.06 * Math.sin(t * 5.7 + 1.3) +
        0.05 * Math.sin(t * 10.9 + 0.6);
      m.emissiveIntensity = 4.4 * f;
    }
    if (this._mist) {
      this._mist.position.set(
        SUN_X * -0.16 * t + Math.sin(t * 0.07) * 0.8,
        Math.sin(t * 0.11) * 0.09,
        SUN_Z * -0.16 * t + Math.cos(t * 0.05) * 0.8);
      // wrap so a long capture cannot drift the bank off the site
      if (Math.abs(this._mist.position.x) > 24) this._mist.position.x *= -1;
      if (Math.abs(this._mist.position.z) > 24) this._mist.position.z *= -1;
    }
    if (this._waterMat && this._waterMat.normalMap) {
      var nm = this._waterMat.normalMap;
      nm.offset.set(t * 0.0045, t * 0.0031);
    }
    void ctx;
  };

  GAME.LevelRuins = LevelRuins;
})(window.GAME, window.THREE);
