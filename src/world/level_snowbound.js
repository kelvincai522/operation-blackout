// ============================================================================
// OPERATION BLACKOUT - src/world/level_snowbound.js  ->  GAME.LevelSnowbound
//
// "KIROVSK PASS": an alpine road through a half-buried village, in a blizzard.
// Overcast day, whiteout, white / pale-blue palette, open valley + village -
// the deliberate opposite of both shipped levels on every axis.
//
// THE PLAN, in world coordinates (-Z is uphill/north, the player spawns at the
// southern end of the pass and walks up it):
//
//   z = +64 .. +46   the pass entrance: open snowfield, marker posts, the road
//                    curving in from the right
//   z = +46 .. -14   THE VILLAGE. Nine wooden dachas on both sides, snow-loaded
//                    roofs, shovelled trenches from the road to each door
//   z = +35 .. +2    THE STALLED CONVOY, five trucks nose-to-tail in the road
//   z = +10 .. -14   the stone church on the west side, its bell tower the one
//                    landmark that stays legible through the whiteout
//   z = -20 .. -38   THE GORGE and the COLLAPSED BRIDGE: the near half-span is
//                    cantilevered over 6.4 m of nothing, the centre span lies
//                    in the bottom of the gorge
//   |x| > 26         valley walls: pine forest west, rock buttress east
//
// ============================================================================
// SNOW IS THE MATERIAL, AND IT IS AUTHORED HERE RATHER THAN REQUESTED
// ============================================================================
// materials.js has no snow recipe and it is not this file's to add. Every
// other surface in the level goes through ctx.materials.get() by a name the
// library actually has (checked with materials.has, with a forced-colour
// fallback exactly like level_harbor), but the one surface that carries the
// whole level is generated here:
//
//   * ALBEDO is high and nearly neutral (linear ~0.80) because snow really is,
//     and because sky.js's GROUND_ALBEDO_BY_LEVEL already solves the overcast
//     deck, the IBL's lower hemisphere and the fog's inscatter against
//     [0.86 0.89 0.94]. A dull grey snow here would put the ground two stops
//     under the sky it is supposed to be doubling.
//   * The TONAL LIFE is not in the albedo, it is in the VERTEX COLOURS and in
//     the RELIEF. Concavity darkens AND cools (skylight is the only thing in a
//     drift hollow); crests brighten; the road is trodden grey; paths are
//     scuffed; soot collects under eaves.
//   * SPARKLE is two mechanisms, because one is not enough: sparse very-low-
//     roughness facets that catch the sky as pinpoint speculars, and a sparse
//     emissive speckle that survives into the bloom. Both are ~1 cm features,
//     so they mip away with distance instead of shimmering.
//   * TRANSLUCENCY is a sheen lobe with a pale blue sheen colour. A drift lip
//     seen against the light gains a soft rim instead of terminating hard,
//     which is the cheapest honest read of "light goes in and comes back out".
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// Every structure a props pass might want to stand something against is
// published by name in `level.anchors`, available immediately after
// `new LevelSnowbound(ctx)` - you do NOT have to wait for build().
//
//   anchors.valley       { x0,x1,z0,z1, roadX(z), roadY(z), groundY(x,z), wind }
//   anchors.road         { half, bermW, marks:[{x,z,y}], centre(z) }
//   anchors.spawn        { position, yaw }
//   anchors.dachas       [ {name, centre, yaw, w, d, eave, ridge, doorOuter,
//                           doorInner, porch, chimney, ruin, lit} ]
//   anchors.church       { centre, yaw, nave{x0,x1,z0,z1}, floorY, eave, ridge,
//                          tower{centre,base,cornice,drum,dome,apex},
//                          door, holeAbove, holeFloor, apse }
//   anchors.barn         { centre, yaw, w, d, eave, ridge, doorOuter }
//   anchors.convoy       [ {name, centre, yaw, kind, tailgate, bonnet, cabTop} ]
//   anchors.bridge       { nearLip, farLip, tornEdge, farStub, deckY, railY,
//                          fallenSpan, gorge{z,half,depth,floorY} }
//   anchors.ledge        { centre, yaw, top }        - the overview standpoint
//   anchors.paths        [ [ {x,z}, ... ] ]          - the shovelled trenches
//   anchors.treeline     { westX(z), eastX(z) }
//
//   DO NOT derive a world position from `level.cameraPoses`. A camera pose is
//   a COMPOSITION and it moves whenever the composition improves; the harbor
//   build put lamps and props in corridors that no longer existed exactly that
//   way. Anchors are the village's own survey and move only when it is rebuilt.
//
// Also published, both consumed generically by lighting.js:
//   level.practicalLights   every light source the level implies - lit dacha
//                           windows, the church candles, two truck headlights
//                           still burning, the hazard lamp on the bridge.
//   level.lightShafts       downward apertures only, which is the honest set in
//                           an overcast: the church shell hole and the roofless
//                           dacha. A headlight is a practical with a cone, not
//                           a shaft - lighting.js's shaft solver traces DOWN.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var X_MIN = -56, X_MAX = 56;
  var Z_MIN = -50, Z_MAX = 64;
  // 0.50 m rather than 0.62. The wheel ruts are a 1.2 m wide, 0.10 m deep pair
  // of depressions and the shovelled trenches have near-vertical walls; at
  // 0.62 m neither was resolved by more than a cell and a half, so both read as
  // paint rather than as geometry. This costs 102k triangles against 66k.
  var FIELD_CELL = 0.50;

  var ROAD_HALF = 4.60;          // ploughed carriageway half-width
  var BERM_W = 2.40;             // the bank the plough throws up
  var SNOW_BASE = 0.88;          // mean lying snow off the road

  // Wind. weather.js's blizzard blows toward (0.822, -0.569) in (X, Z) and
  // swings +-0.55 rad around it, so drifts belong on the +X / -Z side of
  // anything that stands up. Taken from that file rather than guessed, because
  // a drift that disagrees with the falling snow is the loudest possible tell.
  var WIND_X = 0.8221, WIND_Z = -0.5693;

  // The gorge the bridge used to cross.
  var GORGE_Z = -29.0, GORGE_HALF = 8.60, GORGE_DEPTH = 12.5;
  var BR_NEAR = -20.6;           // near lip / abutment face
  var BR_TORN = -26.7;           // where the surviving cantilever tears off
  var BR_FAR0 = -33.1;           // far stub, near end
  var BR_FAR1 = -37.3;           // far abutment face

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------- surface --
  // uv is world metres -> uv. The triplanar library entries (stone, concrete,
  // asphalt, gravel, dirt, rubble, plaster) ignore it and project in world
  // space; the planar ones do not, and their numbers below are solved against
  // each def's own `repeat` so every surface lands near 500 texels/m.
  //
  // `own` marks a surface this file generates for itself. `base` is the library
  // name to fall back to when materials.js does not know the snowbound name,
  // and `col` is forced onto that fallback so a green truck is never grey.
  var SURF = {
    snow:        { uv: 0.55, cast: true,  recv: true, own: 'snow' },
    // Same texel density as `snow`: the carriageway and the bridge deck share
    // this material and a density jump between them at the abutment is exactly
    // the tell a merged ground is supposed to avoid.
    snow_road:   { uv: 0.55, cast: false, recv: true, own: 'road' },
    ice:         { uv: 0.90, cast: false, recv: true, own: 'ice' },

    timber:      { uv: 0.85, cast: true,  recv: true, base: 'wood_plank',
                   col: 0x6b5540, rough: 0.86, metal: 0.0 },
    timber_dark: { uv: 0.62, cast: true,  recv: true, base: 'wood_plank',
                   col: 0x40352a, rough: 0.90, metal: 0.0 },
    stonework:   { uv: 0.40, cast: true,  recv: true, base: 'stone',
                   col: 0x8f8a80, rough: 0.88, metal: 0.0 },
    rock:        { uv: 0.16, cast: true,  recv: true, base: 'stone',
                   col: 0x6d6a66, rough: 0.94, metal: 0.0 },
    concrete:    { uv: 0.36, cast: true,  recv: true, base: 'concrete',
                   col: 0x8a8781, rough: 0.92, metal: 0.0 },
    truck_paint: { uv: 0.90, cast: true,  recv: true, base: 'paint_green',
                   col: 0x4b563f, rough: 0.62, metal: 0.45 },
    steel:       { uv: 0.90, cast: true,  recv: true, base: 'painted_metal',
                   col: 0x59606a, rough: 0.55, metal: 0.85 },
    rust:        { uv: 0.90, cast: true,  recv: true, base: 'rusted_metal',
                   col: 0x6f4530, rough: 0.86, metal: 0.62 },
    tin:         { uv: 0.75, cast: true,  recv: true, base: 'corrugated_metal',
                   col: 0x6a6f72, rough: 0.68, metal: 0.72 },
    canvas:      { uv: 1.00, cast: true,  recv: true, base: 'canvas_awning',
                   col: 0x6d6650, rough: 0.94, metal: 0.0 },
    rubber:      { uv: 1.40, cast: true,  recv: true, base: 'rubber',
                   col: 0x1c1e21, rough: 0.90, metal: 0.0 },
    bark:        { uv: 1.55, cast: true,  recv: true, base: 'wood_plank',
                   col: 0x3d3025, rough: 0.94, metal: 0.0 },
    needle:      { uv: 0.90, cast: true,  recv: true, base: 'foliage',
                   col: 0x2c3a2e, rough: 0.88, metal: 0.0 },
    glazing:     { uv: 0.50, cast: false, recv: false, base: 'glass',
                   col: 0x8fa2ad, rough: 0.10, metal: 0.0, env: 1.6 },
    // Lit panes and lamp lenses. Dark albedo, hot emissive - it has to READ as
    // a source, and postfx's veiling bloom is what turns it into one. In a
    // frame this cold and this bright these are the ONLY warm marks, so they
    // are also the entire warm leg of grade_split.
    glass_lit:   { uv: 0.60, cast: false, recv: false, own: 'lit', keepUV: true },
    // Alpha-cut ground marks: boot prints, tyre tread, shovel scrapes, grit.
    decal:       { uv: 1.00, cast: false, recv: true,  own: 'decal', keepUV: true }
  };

  // If materials.js is unavailable entirely the pass must still read as a snowy
  // village rather than as magenta error boxes.
  var FALLBACK = {
    snow:        [0xe9eef6, 0.62, 0.0],
    snow_road:   [0x9aa1ab, 0.74, 0.0],
    ice:         [0xa8c0d4, 0.14, 0.0],
    timber:      [0x6b5540, 0.86, 0.0],
    timber_dark: [0x40352a, 0.90, 0.0],
    stonework:   [0x8f8a80, 0.88, 0.0],
    rock:        [0x6d6a66, 0.94, 0.0],
    concrete:    [0x8a8781, 0.92, 0.0],
    truck_paint: [0x4b563f, 0.62, 0.45],
    steel:       [0x59606a, 0.55, 0.85],
    rust:        [0x6f4530, 0.86, 0.62],
    tin:         [0x6a6f72, 0.68, 0.72],
    canvas:      [0x6d6650, 0.94, 0.0],
    rubber:      [0x1c1e21, 0.90, 0.0],
    bark:        [0x3d3025, 0.94, 0.0],
    needle:      [0x2c3a2e, 0.88, 0.0],
    glazing:     [0x8fa2ad, 0.10, 0.0],
    glass_lit:   [0xffcf92, 0.20, 0.0],
    decal:       [0xffffff, 0.85, 0.0]
  };

  // ------------------------------------------------------- geometry helpers --
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
    if (bevel === undefined) bevel = Math.min(0.012, Math.min(w, Math.min(h, d)) * 0.26);
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

  var _quadCache = new Map();
  function quad(w, h, u0, v0, u1, v1) {
    if (u0 === undefined) { u0 = 0; v0 = 0; u1 = 1; v1 = 1; }
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + u0 + ',' + v0 + ',' + u1 + ',' + v1;
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

  // Extrude a 2D profile given in the ZY plane along X. This is the atom of
  // every snow-loaded roof in the level: the SHAPE of a snow load is the whole
  // read - it is thick at the ridge, it bulges at the eave, and it rolls over
  // and droops past the fascia rather than stopping at it. A slab of constant
  // thickness photographs as a lid.
  function extrudeX(pts, x0, x1, caps) {
    var n = pts.length, i;
    var area = 0;
    for (i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    var list = area < 0 ? pts.slice().reverse() : pts;
    var pos = [], nor = [];
    // per-segment normals in the ZY plane, averaged at soft turns so a rolled
    // snow lip shades as a continuous surface instead of as facets
    var sn = [];
    for (i = 0; i < n; i++) {
      var s0 = list[i], s1 = list[(i + 1) % n];
      var dz = s1[0] - s0[0], dy = s1[1] - s0[1];
      var l = Math.sqrt(dz * dz + dy * dy) || 1;
      sn.push([dy / l, -dz / l]);
    }
    var LIM = Math.cos(72 * Math.PI / 180);
    function blend(a, b, keep) {
      var d = a[0] * b[0] + a[1] * b[1];
      if (d < LIM) return keep;
      var bz = a[0] + b[0], by = a[1] + b[1];
      var bl = Math.sqrt(bz * bz + by * by);
      return bl < 1e-6 ? keep : [bz / bl, by / bl];
    }
    var na = [], nb = [];
    for (i = 0; i < n; i++) {
      na.push(blend(sn[(i - 1 + n) % n], sn[i], sn[i]));
      nb.push(blend(sn[i], sn[(i + 1) % n], sn[i]));
    }
    function vtx(x, z, y, nz, ny) { pos.push(x, y, z); nor.push(0, ny, nz); }
    for (i = 0; i < n; i++) {
      var p = list[i], q = list[(i + 1) % n];
      var A = na[i], Bn = nb[i];
      vtx(x0, p[0], p[1], A[0], A[1]); vtx(x1, p[0], p[1], A[0], A[1]);
      vtx(x1, q[0], q[1], Bn[0], Bn[1]);
      vtx(x0, p[0], p[1], A[0], A[1]); vtx(x1, q[0], q[1], Bn[0], Bn[1]);
      vtx(x0, q[0], q[1], Bn[0], Bn[1]);
    }
    if (caps !== false) {
      for (i = 1; i + 1 < n; i++) {
        var o = list[0], u = list[i], v = list[i + 1];
        pos.push(x0, o[1], o[0], x0, u[1], u[0], x0, v[1], v[0]);
        nor.push(-1, 0, 0, -1, 0, 0, -1, 0, 0);
        pos.push(x1, o[1], o[0], x1, v[1], v[0], x1, u[1], u[0]);
        nor.push(1, 0, 0, 1, 0, 0, 1, 0, 0);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  // Surface of revolution about +Y. Profile is [[r, y], ...] bottom to top.
  // The church's onion dome is the level's one true landmark silhouette and a
  // faceted cone will not do it.
  function revolve(profile, seg) {
    seg = seg || 16;
    var pos = [], nor = [], i, j;
    // profile normals
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

  // A shell over a surface of revolution whose thickness varies with AZIMUTH.
  // Snow does not lie evenly on an onion dome: driven snow plasters the flank
  // the wind hits and the lee flank stays bare metal, and a dome half-plastered
  // is a far stronger landmark silhouette than a clean one. `wx, wz` is the
  // direction, in the dome's own frame, that the snow is driven from.
  function revolveCap(profile, seg, wx, wz, tMin, tMax) {
    seg = seg || 20;
    var pos = [], nor = [], i, j;
    var pn = [];
    for (i = 0; i < profile.length; i++) {
      var a = profile[Math.max(0, i - 1)], b = profile[Math.min(profile.length - 1, i + 1)];
      var dr = b[0] - a[0], dy = b[1] - a[1];
      var l = Math.sqrt(dr * dr + dy * dy) || 1;
      pn.push([dy / l, -dr / l]);
    }
    function pt(pi, jj) {
      var ang = (jj % seg) / seg * Math.PI * 2;
      var c = Math.cos(ang), s = Math.sin(ang);
      var w = M.saturate(c * wx + s * wz);
      var t = tMin + (tMax - tMin) * w * w * (0.80 + 0.20 * Math.sin(ang * 5 + pi));
      var r = profile[pi][0] + pn[pi][0] * t;
      var y = profile[pi][1] + pn[pi][1] * t;
      return [r * c, y, r * s, pn[pi][0] * c, pn[pi][1], pn[pi][0] * s];
    }
    for (i = 0; i + 1 < profile.length; i++) {
      for (j = 0; j < seg; j++) {
        var A = pt(i, j), Bv = pt(i, j + 1), C = pt(i + 1, j + 1), D = pt(i + 1, j);
        pos.push(A[0], A[1], A[2], Bv[0], Bv[1], Bv[2], C[0], C[1], C[2]);
        nor.push(A[3], A[4], A[5], Bv[3], Bv[4], Bv[5], C[3], C[4], C[5]);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(A[3], A[4], A[5], C[3], C[4], C[5], D[3], D[4], D[5]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  function tint(hex, strength) {
    var c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(c.r, Math.max(c.g, c.b)) || 1;
    c.multiplyScalar(1 / mx);
    var s = strength === undefined ? 1 : strength;
    c.r = 1 + (c.r - 1) * s; c.g = 1 + (c.g - 1) * s; c.b = 1 + (c.b - 1) * s;
    return c;
  }

  function grey(v) { return new THREE.Color(v, v, v); }
  // A mark cut into snow is never neutral: the inside of the hole sees only
  // sky, and the sky here is the coldest thing in the frame.
  function cool(v) { return new THREE.Color(v * 0.84, v * 0.91, v * 1.06); }

  // ================================================================ Builder ==
  // Transform stack plus per-material geometry buckets. Same shape as the
  // harbor's builder, deliberately: this file follows that file's patterns
  // rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    // A multiplier applied UNDER every local tint, for a whole structure at a
    // time - so a house that burned can be taken to charcoal without rewriting
    // forty tint calls, and without dragging the snow lying on it down with it.
    this.base = null;
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
    var t = this.tint;
    if (this.base && key !== 'snow' && key !== 'ice' && key !== 'glass_lit') {
      t = t ? new THREE.Color(t.r * this.base.r, t.g * this.base.g, t.b * this.base.b)
        : this.base;
    }
    var e = { geometry: geo, matrix: wm, tint: t, dark: this.dark };
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
  Builder.prototype.worldPoint = function (x, y, z, out) {
    return (out || new THREE.Vector3()).set(x, y, z).applyMatrix4(this.top());
  };

  // A sagging wire between two points. Telegraph lines crusted with rime are
  // the level's leading line above eye level - the marker posts do it below.
  function wire(B, key, ax, ay, az, bx, by, bz, sag, r, segs) {
    segs = segs || 7;
    var px = ax, py = ay, pz = az;
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var qx = ax + (bx - ax) * t;
      var qz = az + (bz - az) * t;
      var qy = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      B.rod(key, px, py, pz, qx, qy, qz, r, 4);
      px = qx; py = qy; pz = qz;
    }
  }

  // ============================================================ THE GROUND ==
  // The valley is authored as ROCK + SNOW DEPTH and the split is load-bearing.
  // rock() is the shape of the pass: the road's grade and serpentine, the two
  // valley walls, the gorge. depth() is how much snow is lying on it, and that
  // is where every readable thing lives - the ploughed carriageway cut 1.2 m
  // below the field either side of it, the berms the plough threw up, the lee
  // drifts against every wall, the shovelled trenches to the doors, the tyre
  // ruts. Depth is what makes snow read as DEPTH rather than as white paint.

  // The road serpentines. A straight 110 m road is on the instant-fail list
  // and, more usefully, a curve is the only way the carriageway itself becomes
  // a leading line that goes somewhere instead of to a vanishing point.
  function roadX(z) { return 9.0 * Math.sin((z + 10) * 0.0175) - 1.2; }
  function roadY(z) { return -0.028 * z + 0.55 * Math.sin(z * 0.031 + 1.1); }

  // Valley cross-section, measured from the carriageway. West is a forested
  // slope that climbs gently; east is a rock buttress that climbs hard - so the
  // two sides of every framing have completely different silhouettes.
  function slopeW(a) {
    return 0.020 * a + 0.050 * Math.max(0, a - 14) +
      0.170 * Math.max(0, a - 30) + 0.46 * Math.max(0, a - 46);
  }
  function slopeE(a) {
    return 0.026 * a + 0.076 * Math.max(0, a - 12) +
      0.300 * Math.max(0, a - 26) + 0.92 * Math.max(0, a - 40);
  }

  function gorge(x, z) {
    var cz = GORGE_Z + 2.6 * Math.sin(x * 0.055) + 1.15 * Math.sin(x * 0.13 + 2.0);
    var a = Math.abs((z - cz) / GORGE_HALF);
    if (a >= 1) return 0;
    return GORGE_DEPTH * (1 - M.smoothstep(0.42, 1.0, a));
  }

  function rockY(x, z, P) {
    var N = P.noise;
    var u = x - roadX(z);
    var a = Math.abs(u);
    var y = roadY(z) + (u < 0 ? slopeW(a) : slopeE(a));
    // Broad ground undulation, damped across the carriageway so the road reads
    // as a road and not as a ploughed field.
    var damp = 0.25 + 0.75 * M.smoothstep(2.0, 15.0, a);
    y += N.fbm2(x * 0.028 + 3.1, z * 0.028 - 7.4, 3) * 1.55 * damp;
    y += N.fbm2(x * 0.085 - 1.7, z * 0.085 + 2.2, 2) * 0.42 * damp;
    y -= gorge(x, z);
    return y;
  }

  function segDist(px, pz, ax, az, bx, bz) {
    var vx = bx - ax, vz = bz - az;
    var wx = px - ax, wz = pz - az;
    var L = vx * vx + vz * vz;
    var t = L > 1e-6 ? M.saturate((wx * vx + wz * vz) / L) : 0;
    var dx = wx - vx * t, dz = wz - vz * t;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // A soft bump: 1 at `c`, 0 by `w` either side.
  function bump(v, c, w) {
    var a = Math.abs(v - c);
    return a >= w ? 0 : 1 - M.smoothstep(0, w, a);
  }

  // Drift banked against a standing rectangle. Deposition is on the LEE side,
  // which for weather.js's blizzard is +X / -Z, with a smaller windward ramp -
  // that asymmetry is most of why a drift reads as wind-made.
  function leeDrift(x, z, P) {
    var out = 0;
    var R = P.rects;
    for (var i = 0; i < R.length; i++) {
      var r = R[i];
      var dx = x - r.x, dz = z - r.z;
      var c = r.c, s = r.s;
      var lx = dx * c + dz * s, lz = -dx * s + dz * c;
      var ox = Math.abs(lx) - r.hx, oz = Math.abs(lz) - r.hz;
      var qx = Math.max(0, ox), qz = Math.max(0, oz);
      var dist = Math.sqrt(qx * qx + qz * qz);
      if (dist > 8.0) continue;
      // outward direction in world space
      var nx = 0, nz = 0;
      if (qx > 0 || qz > 0) {
        var wlx = (lx > 0 ? qx : -qx), wlz = (lz > 0 ? qz : -qz);
        nx = wlx * c - wlz * s; nz = wlx * s + wlz * c;
        var nl = Math.sqrt(nx * nx + nz * nz) || 1;
        nx /= nl; nz /= nl;
      } else { nx = WIND_X; nz = WIND_Z; }
      var lee = nx * WIND_X + nz * WIND_Z;                 // +1 downwind
      var reach = r.reach * (0.55 + 0.75 * M.saturate(lee * 0.5 + 0.5));
      var t = 1 - M.smoothstep(0, reach, dist);
      out += r.amp * (0.55 + 0.70 * M.saturate(lee * 0.5 + 0.5)) * t * t;
    }
    return out;
  }

  function snowDepth(x, z, P) {
    var N = P.noise;
    var u = x - roadX(z);
    var a = Math.abs(u);

    // ---- the open snowfield ------------------------------------------------
    // Sampled in a frame ALIGNED TO THE WIND and compressed across it, so the
    // drifts are long streamers running with the storm rather than isotropic
    // blobs. That anisotropy is the single cheapest cue that the white surface
    // was made by moving air.
    var al = x * WIND_X + z * WIND_Z;
    var ac = -x * WIND_Z + z * WIND_X;
    var d = SNOW_BASE;
    d += N.fbm2(al * 0.030 + 4.0, ac * 0.105 - 2.0, 3) * 0.98;
    d += N.fbm2(al * 0.110 - 6.0, ac * 0.340 + 3.0, 2) * 0.40;
    // sastrugi: wind ripples across the streamers, plus a mid-frequency
    // octave at ~2.6 m - the finest wavelength a 0.62 m lattice resolves,
    // and the one that gives a bank its tooth instead of a smooth ramp
    d += N.fbm2(al * 0.26 + 9.0, ac * 0.62 - 4.0, 3) * 0.185;
    d += Math.sin(ac * 1.85 + N.fbm2(al * 0.22, ac * 0.22, 2) * 5.0) * 0.080;
    d += leeDrift(x, z, P);

    // ---- what the plough did ----------------------------------------------
    var onRoad = 1 - M.smoothstep(ROAD_HALF - 0.45, ROAD_HALF + 0.80, a);
    if (onRoad > 0.001) {
      // Compacted snow-ice with two wheel tracks worn into it. 1.24 m wide and
      // 105 mm deep - CARVED, not painted. Two dark stripes on a flat surface
      // are a texture; a rut you can see the far wall of is what sells depth,
      // and at a 0.50 m lattice this is two and a half cells across so the far
      // wall genuinely exists.
      var rut = -0.105 * (bump(u, 1.42, 0.62) + bump(u, -1.42, 0.62));
      var packed = 0.100 + rut + N.fbm2(x * 0.9, z * 0.9, 2) * 0.020;
      d = d * (1 - onRoad) + packed * onRoad;
    }
    // the berm, thrown clear of the carriageway
    var bt = (a - (ROAD_HALF + 0.35)) / BERM_W;
    if (bt > -0.40 && bt < 1.30) {
      var shape = Math.max(0, 1 - Math.abs((bt - 0.34) / 0.80));
      shape = shape * shape * (3 - 2 * shape);
      d += (0.56 + 0.30 * N.fbm2(z * 0.34 + a * 0.2, a * 0.5, 2)) * shape;
    }

    // ---- shovelled trenches ------------------------------------------------
    var pth = P.paths;
    for (var i = 0; i < pth.length; i++) {
      var poly = pth[i];
      for (var j = 0; j + 1 < poly.length; j++) {
        var dd = segDist(x, z, poly[j][0], poly[j][1], poly[j + 1][0], poly[j + 1][1]);
        if (dd > 2.3) continue;
        // A shovelled path is a TRENCH: a flat cut floor, near-vertical walls,
        // and the spoil thrown up in a ridge along both lips. The wall was a
        // 0.5 m ramp, which at any sampling rate is a tonal change and not a
        // cut; 0.24 m is a wall you can see the shadowed inside of.
        var pw = 1 - M.smoothstep(0.60, 0.84, dd);
        if (pw > 0) d = M.lerp(d, 0.155 + N.fbm2(x * 1.4, z * 1.4, 2) * 0.045, pw);
        d += 0.60 * bump(dd, 1.20, 0.50);            // the spoil either side
      }
    }

    // ---- snow does not lie on a cliff -------------------------------------
    var gc = GORGE_Z + 2.6 * Math.sin(x * 0.055) + 1.15 * Math.sin(x * 0.13 + 2.0);
    var ga = Math.abs((z - gc) / GORGE_HALF);
    if (ga < 1.05) d *= 1 - 0.80 * bump(ga, 0.72, 0.30);
    d *= 1 - 0.55 * M.smoothstep(34, 52, a);
    return Math.max(0.015, d);
  }

  // Building pads. Flattened to the structure's own floor level so nothing
  // floats and nothing is buried; the blend band is deliberately narrow (0.55 m)
  // so the lee drift still banks right up against the wall.
  function padBlend(x, z, P) {
    var best = 0, py = 0;
    var A = P.pads;
    for (var i = 0; i < A.length; i++) {
      var p = A[i];
      var dx = x - p.x, dz = z - p.z;
      var lx = dx * p.c + dz * p.s, lz = -dx * p.s + dz * p.c;
      var ox = Math.abs(lx) - p.hx, oz = Math.abs(lz) - p.hz;
      var dist = Math.sqrt(Math.max(0, ox) * Math.max(0, ox) + Math.max(0, oz) * Math.max(0, oz));
      var w = 1 - M.smoothstep(0.05, 0.62, dist);
      if (w > best) { best = w; py = p.y; }
    }
    return { w: best, y: py };
  }

  function snowY(x, z, P) {
    var y = rockY(x, z, P) + snowDepth(x, z, P);
    var pb = padBlend(x, z, P);
    if (pb.w > 0) y = M.lerp(y, pb.y, pb.w);
    return y;
  }

  // ======================================================= PROCEDURAL SNOW ==
  // Tileable value noise. GAME.Noise is perlin on an unbounded lattice and is
  // therefore NOT tileable; a texture generated from it seams at every repeat,
  // and on a surface covering most of five framings a seam every 1.8 m is the
  // whole level. The lattice index is taken modulo the period instead.
  function hash2i(ix, iy, seed) {
    var h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^
      Math.imul(seed | 0, 0x9e3779b1);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }
  function tval(x, y, per, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    var v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    var x0 = ((xi % per) + per) % per, x1 = ((xi + 1) % per + per) % per;
    var y0 = ((yi % per) + per) % per, y1 = ((yi + 1) % per + per) % per;
    var a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
    var c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
    var ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  }
  function tfbm(x, y, per, seed, oct, gain) {
    var s = 0, amp = 1, f = 1, n = 0;
    gain = gain || 0.5;
    for (var i = 0; i < (oct || 4); i++) {
      s += amp * tval(x * f, y * f, per * f, seed + i * 97);
      n += amp; amp *= gain; f *= 2;
    }
    return s / n;
  }

  function makeTex(canvas, srgb, aniso) {
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (aniso) t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  }

  // ---------------------------------------------------------------------------
  // THE SNOW MAP SET. One height pass, three derived maps plus a sparkle map,
  // so the albedo, the relief and the gloss can never disagree about where a
  // ripple is.
  //
  //   height  = wind ripple (sastrugi) + granular crust + a coarse pack octave
  //   albedo  = high and near-neutral, faintly BLUER in the troughs, with a
  //             sparse scatter of grit. The range is only ~8% because snow
  //             genuinely has almost no albedo variation - the picture comes
  //             from the shape, and inventing albedo contrast here is exactly
  //             how procedural snow ends up looking like porridge.
  //   rough   = 0.70 base falling with exposure, PLUS ~1 cm facets at 0.055
  //             that catch the overcast dome as pinpoint speculars
  //   sparkle = the same facets as a sparse emissive speckle, so the brightest
  //             of them survive into postfx's veiling bloom
  // ---------------------------------------------------------------------------
  function snowMaps(size, seed, packed) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return null;
    var N = size;
    function cv() { var c = doc.createElement('canvas'); c.width = c.height = N; return c; }
    var cA = cv(), cN = cv(), cR = cv(), cS = cv();
    var gA = cA.getContext('2d'), gN = cN.getContext('2d');
    var gR = cR.getContext('2d'), gS = cS.getContext('2d');
    if (!gA || !gN || !gR || !gS) return null;
    var iA = gA.createImageData(N, N), iN = gN.createImageData(N, N);
    var iR = gR.createImageData(N, N), iS = gS.createImageData(N, N);
    var A = iA.data, Nd = iN.data, R = iR.data, S = iS.data;

    var H = new Float32Array(N * N);
    var G = new Float32Array(N * N);          // grit / soil mask
    var F = new Float32Array(N * N);          // sparkle facets
    var i, j, k;
    // Integer frequency pair - see the note above. atan2(5,7) = 0.62 rad.
    var rfu = packed ? 18 : 7, rfv = packed ? 13 : 5;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        var u = i / N, v = j / N;
        var h;
        if (packed) {
          // Compacted trafficked snow: broad polished pans, gritted, with the
          // scoured shear lines a tyre leaves rather than wind ripples.
          //
          // The first version's third term was a DIAGONAL ripple at a fine
          // pitch - i.e. sastrugi under another name, which meant a ploughed
          // road and a wind-blown bank carried the same surface. These are
          // LONGITUDINAL: |sin| streaks running along V (which the ground uv
          // maps to world Z, the road's own axis), wandering under a low
          // frequency warp so they are not a ruled corduroy. abs(sin(pi*n*u))
          // has period 1/n, so it tiles exactly.
          h = tfbm(u * 12, v * 12, 12, seed, 4) * 0.40;
          h += tfbm(u * 34, v * 34, 34, seed + 41, 3) * 0.24;
          var wv = tfbm(u * 4, v * 4, 4, seed + 7, 2);
          h += 0.36 * Math.abs(Math.sin((u * 11 + wv * 2.4) * Math.PI));
          h += tfbm(u * 60, v * 60, 60, seed + 23, 2) * 0.09;   // grit tooth
        } else {
          h = tfbm(u * 5, v * 5, 5, seed, 4) * 0.50;
          h += tfbm(u * 19, v * 19, 19, seed + 13, 3) * 0.22;
          // sastrugi: a ripple train, warped so it is not a ruled corduroy
          var w = tfbm(u * 3, v * 3, 3, seed + 5, 2);
          h += 0.28 * (0.5 + 0.5 * Math.sin((u * rfu + v * rfv) * Math.PI * 2 + w * 9.0));
          h += tfbm(u * 64, v * 64, 64, seed + 29, 2) * 0.10;   // granular crust
        }
        H[j * N + i] = h;
        var gg = tfbm(u * 33 + 5, v * 33 - 3, 33, seed + 71, 2);
        G[j * N + i] = packed ? M.smoothstep(0.48, 0.82, gg) : M.smoothstep(0.83, 0.99, gg);
      }
    }
    var lo = 1e9, hi = -1e9;
    for (k = 0; k < H.length; k++) { if (H[k] < lo) lo = H[k]; if (H[k] > hi) hi = H[k]; }
    var inv = 1 / Math.max(1e-5, hi - lo);
    for (k = 0; k < H.length; k++) H[k] = (H[k] - lo) * inv;

    // sparkle facets - deterministic, ~1 cm, moderate density
    var rng = new GAME.RNG((seed ^ 0x5EED) >>> 0);
    var nF = Math.round(N * N * (packed ? 0.00050 : 0.00150));
    for (k = 0; k < nF; k++) {
      var fx = rng.int(0, N - 1), fy = rng.int(0, N - 1);
      var rad = rng.next() < 0.75 ? 1 : 2;
      var amp = rng.range(0.55, 1.0);
      for (var oy = -rad; oy <= rad; oy++) {
        for (var ox = -rad; ox <= rad; ox++) {
          var d2 = ox * ox + oy * oy;
          if (d2 > rad * rad + 0.25) continue;
          var px = ((fx + ox) % N + N) % N, py = ((fy + oy) % N + N) % N;
          var vv = amp * (1 - d2 / (rad * rad + 1));
          if (vv > F[py * N + px]) F[py * N + px] = vv;
        }
      }
    }

    var strength = packed ? 2.3 : 3.1;
    for (j = 0; j < N; j++) {
      for (i = 0; i < N; i++) {
        k = j * N + i;
        var o = k * 4;
        var h0 = H[k];
        var hx = H[j * N + ((i + 1) % N)] - H[j * N + ((i - 1 + N) % N)];
        var hy = H[((j + 1) % N) * N + i] - H[((j - 1 + N) % N) * N + i];
        var nx = -hx * strength, ny = -hy * strength, nz = 1;
        var f = F[k];
        if (f > 0) {
          // a glint is a FACET, so it gets its own tilt; without this the low
          // roughness dots are holes in the surface rather than crystals
          nx += (hash2i(i, j, seed + 3) - 0.5) * f * 2.6;
          ny += (hash2i(i, j, seed + 9) - 0.5) * f * 2.6;
        }
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        Nd[o] = Math.round((nx / nl * 0.5 + 0.5) * 255);
        Nd[o + 1] = Math.round((ny / nl * 0.5 + 0.5) * 255);
        Nd[o + 2] = Math.round((nz / nl * 0.5 + 0.5) * 255);
        Nd[o + 3] = 255;

        var grit = G[k];
        var lum, r, g, b;
        if (packed) {
          // Compacted trafficked snow is a value or two under fresh snow, not
          // three stops under it. 0.76 against fresh's 0.905.
          lum = 0.760 + h0 * 0.118;
          r = lum * (1 - grit * 0.15);
          g = lum * (1 - grit * 0.142);
          b = lum * (1 - grit * 0.098) * 1.020;
        } else {
          // The trough/crest chroma split lives in the ALBEDO as well as in the
          // vertex colours, because the vertex lattice is 0.50 m and the map is
          // 1.8 m per tile - between them they cover the whole scale range a
          // snowfield varies over. It was a 5% R-B spread, which measured as a
          // dead-neutral surface and put two of five framings on the 0.040
          // monochrome limit; at 11% a trough is visibly the colour of the sky
          // it is the only thing seeing, and a crest is not.
          lum = 0.905 + (h0 - 0.5) * 0.080;
          var tro = 1 - h0;
          r = lum * (1 - tro * 0.066) * (1 - grit * 0.15);
          g = lum * (1 - tro * 0.030) * (1 - grit * 0.14);
          b = lum * (1 + tro * 0.046) * (1 - grit * 0.10);
        }
        A[o] = Math.round(M.saturate(r) * 255);
        A[o + 1] = Math.round(M.saturate(g) * 255);
        A[o + 2] = Math.round(M.saturate(b) * 255);
        A[o + 3] = 255;

        var rough = (packed ? 0.60 : 0.70) - h0 * (packed ? 0.26 : 0.16) + grit * 0.14;
        if (f > 0) rough = M.lerp(rough, 0.055, M.saturate(f * 1.2));
        var rq = Math.round(M.saturate(rough) * 255);
        R[o] = rq; R[o + 1] = rq; R[o + 2] = rq; R[o + 3] = 255;

        var sp = Math.round(M.saturate(f * (packed ? 0.55 : 1.0)) * 255);
        S[o] = sp; S[o + 1] = sp; S[o + 2] = Math.round(M.saturate(f) * 255);
        S[o + 3] = 255;
      }
    }
    gA.putImageData(iA, 0, 0);
    gN.putImageData(iN, 0, 0);
    gR.putImageData(iR, 0, 0);
    gS.putImageData(iS, 0, 0);
    return { albedo: cA, normal: cN, rough: cR, sparkle: cS };
  }

  // ---------------------------------------------------------------------------
  // GROUND MARK ATLAS. 2x2 alpha-cut cells laid as merged cards: boot prints,
  // tyre tread, shovel scrapes, grit and diesel. The brief asks for footprints
  // and tyre ruts by name and neither survives a 0.62 m height lattice - the
  // ruts are modelled in the field AND stencilled here, the prints only here.
  //   0 boot   1 tyre tread   2 shovel scrape   3 grit + oil
  // ---------------------------------------------------------------------------
  var ATLAS_N = 2, ATLAS_PX = 512, ATLAS_CELL = ATLAS_PX / ATLAS_N;
  var CELL = { boot: 0, tyre: 1, scrape: 2, grit: 3 };

  function atlasUV(cell) {
    var s = 1 / ATLAS_N;
    var cx = (cell % ATLAS_N) * s, cy = Math.floor(cell / ATLAS_N) * s;
    var pad = 0.004 * s;
    return [cx + pad, cy + pad, cx + s - pad, cy + s - pad];
  }

  function buildAtlas(rng) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return null;
    var c = doc.createElement('canvas');
    c.width = c.height = ATLAS_PX;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    var S = ATLAS_CELL;
    function origin(n) { return [(n % ATLAS_N) * S, Math.floor(n / ATLAS_N) * S]; }
    var o, i, j;

    // ---- 0 : a boot print. Sole and heel as separate pads, with lugs. -------
    // A print in snow is a HOLE: a blue interior with a bright squeezed rim.
    // The interior is therefore pushed well under the snow's own value and hard
    // to blue, and the derived normal map below gives it a real negative bump
    // so the sheen lobe can light the rim.
    o = origin(CELL.boot);
    g.save(); g.translate(o[0], o[1]);
    g.fillStyle = 'rgba(58,72,100,0.94)';
    function pad(x, y, w, h, r) {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
      g.fill();
    }
    pad(S * 0.30, S * 0.10, S * 0.40, S * 0.52, S * 0.16);
    pad(S * 0.32, S * 0.66, S * 0.36, S * 0.26, S * 0.09);
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,0.78)';
    for (j = 0; j < 7; j++) {
      for (i = 0; i < 3; i++) {
        g.fillRect(S * (0.345 + i * 0.115), S * (0.145 + j * 0.062), S * 0.062, S * 0.030);
      }
    }
    for (j = 0; j < 3; j++) {
      g.fillRect(S * 0.355, S * (0.700 + j * 0.070), S * 0.29, S * 0.032);
    }
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(252,254,255,0.62)';
    g.lineWidth = S * 0.026;
    if (g.roundRect) {
      g.beginPath();
      g.roundRect(S * 0.284, S * 0.084, S * 0.432, S * 0.553, S * 0.17);
      g.stroke();
      g.beginPath();
      g.roundRect(S * 0.306, S * 0.646, S * 0.388, S * 0.288, S * 0.10);
      g.stroke();
    }
    g.restore();

    // ---- 1 : tyre tread, tiling top to bottom ------------------------------
    o = origin(CELL.tyre);
    g.save(); g.translate(o[0], o[1]);
    g.fillStyle = 'rgba(64,76,100,0.68)';
    g.fillRect(S * 0.14, 0, S * 0.72, S);
    g.fillStyle = 'rgba(26,32,46,0.86)';
    for (j = 0; j < 12; j++) {
      var ty = j * S / 12;
      g.beginPath();
      g.moveTo(S * 0.16, ty + S * 0.010);
      g.lineTo(S * 0.50, ty + S * 0.036);
      g.lineTo(S * 0.84, ty + S * 0.010);
      g.lineTo(S * 0.84, ty + S * 0.046);
      g.lineTo(S * 0.50, ty + S * 0.072);
      g.lineTo(S * 0.16, ty + S * 0.046);
      g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(250,253,255,0.66)';
    g.lineWidth = S * 0.030;
    g.beginPath(); g.moveTo(S * 0.138, 0); g.lineTo(S * 0.138, S); g.stroke();
    g.beginPath(); g.moveTo(S * 0.862, 0); g.lineTo(S * 0.862, S); g.stroke();
    g.restore();

    // ---- 2 : a shovel scrape, the edge of a cleared patch ------------------
    o = origin(CELL.scrape);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(112,122,138,' + (0.09 + i * 0.050).toFixed(3) + ')';
      g.beginPath();
      g.moveTo(0, S * (0.30 + i * 0.02));
      for (var t = 0; t <= 12; t++) {
        g.lineTo(S * t / 12, S * (0.30 + i * 0.02) + Math.sin(t * 1.7 + i) * S * 0.035);
      }
      g.lineTo(S, S); g.lineTo(0, S); g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(250,253,255,0.46)';
    g.lineWidth = S * 0.016;
    g.beginPath();
    for (var t2 = 0; t2 <= 24; t2++) {
      var xx2 = S * t2 / 24, yy2 = S * 0.30 + Math.sin(t2 * 0.72) * S * 0.035;
      if (t2 === 0) g.moveTo(xx2, yy2); else g.lineTo(xx2, yy2);
    }
    g.stroke();
    g.restore();

    // ---- 3 : grit, salt and a diesel stain ---------------------------------
    o = origin(CELL.grit);
    g.save(); g.translate(o[0], o[1]);
    var grd = g.createRadialGradient(S * 0.5, S * 0.5, S * 0.05, S * 0.5, S * 0.5, S * 0.5);
    grd.addColorStop(0, 'rgba(24,22,20,0.68)');
    grd.addColorStop(0.55, 'rgba(46,44,40,0.30)');
    grd.addColorStop(1, 'rgba(60,58,54,0.0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    for (i = 0; i < 800; i++) {
      var px = rng.range(0, S), py = rng.range(0, S);
      var rr = rng.range(0.5, 2.3);
      var vv2 = rng.range(0.10, 0.42);
      g.fillStyle = 'rgba(' + Math.round(70 + vv2 * 90) + ',' + Math.round(62 + vv2 * 80) +
        ',' + Math.round(54 + vv2 * 70) + ',' + (0.28 + vv2).toFixed(2) + ')';
      g.fillRect(px, py, rr, rr);
    }
    g.restore();

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    // ---- the relief, derived from what was just drawn ----------------------
    // The brief names footprints and tyre ruts and neither read, because a flat
    // alpha card lying on snow is a stain and a print is a HOLE. Height is
    // taken as -alpha weighted by darkness (an opaque dark pixel is the deepest
    // part of the print), lightly blurred so a one-pixel alpha edge does not
    // become a vertical cliff, then differenced into a tangent-space normal.
    // The strong negative bump plus the snow material's own sheen lobe is what
    // puts a bright rim round every print.
    var nrm = null;
    try {
      var src = g.getImageData(0, 0, ATLAS_PX, ATLAS_PX).data;
      var np = ATLAS_PX;
      var H = new Float32Array(np * np), Hb = new Float32Array(np * np);
      var q;
      for (q = 0; q < H.length; q++) {
        var al = src[q * 4 + 3] / 255;
        var lu = (src[q * 4] * 0.30 + src[q * 4 + 1] * 0.59 + src[q * 4 + 2] * 0.11) / 255;
        H[q] = -al * (0.45 + 0.55 * (1 - lu));
      }
      var bx, by;
      for (by = 0; by < np; by++) {
        for (bx = 0; bx < np; bx++) {
          var xm = Math.max(0, bx - 1), xp2 = Math.min(np - 1, bx + 1);
          var ym = Math.max(0, by - 1), yp2 = Math.min(np - 1, by + 1);
          Hb[by * np + bx] = (H[by * np + xm] + H[by * np + xp2] +
            H[ym * np + bx] + H[yp2 * np + bx] + H[by * np + bx] * 2) / 6;
        }
      }
      var nc = doc.createElement('canvas');
      nc.width = nc.height = np;
      var ng = nc.getContext('2d');
      if (ng) {
        var ni = ng.createImageData(np, np), nd = ni.data;
        for (by = 0; by < np; by++) {
          for (bx = 0; bx < np; bx++) {
            var i2 = by * np + bx;
            var hx2 = Hb[by * np + Math.min(np - 1, bx + 1)] - Hb[by * np + Math.max(0, bx - 1)];
            var hy2 = Hb[Math.min(np - 1, by + 1) * np + bx] - Hb[Math.max(0, by - 1) * np + bx];
            var nx2 = -hx2 * 5.4, ny2 = -hy2 * 5.4, nz2 = 1;
            var nl2 = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1;
            nd[i2 * 4] = Math.round((nx2 / nl2 * 0.5 + 0.5) * 255);
            nd[i2 * 4 + 1] = Math.round((ny2 / nl2 * 0.5 + 0.5) * 255);
            nd[i2 * 4 + 2] = Math.round((nz2 / nl2 * 0.5 + 0.5) * 255);
            nd[i2 * 4 + 3] = 255;
          }
        }
        ng.putImageData(ni, 0, 0);
        nrm = new THREE.CanvasTexture(nc);
        nrm.wrapS = nrm.wrapT = THREE.ClampToEdgeWrapping;
        nrm.colorSpace = THREE.NoColorSpace;
        nrm.needsUpdate = true;
      }
    } catch (eN) { GAME.logError('snowbound.atlasNormal', eN); nrm = null; }

    return { map: tex, normal: nrm };
  }

  // A ground mark lying flat, in atlas cell `cell`.
  function markCard(B, cell, x, y, z, w, h, yaw, tintC) {
    var uv = atlasUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var old = B.tint;
    if (tintC) B.tint = tintC;
    B.add('decal', g, makeM(x, y, z, -Math.PI * 0.5, yaw || 0, 0));
    B.tint = old;
  }

  // ---------------------------------------------------------------------------
  // A MODELLED SNOW COLLAR at the foot of anything that stands in the snow.
  //
  // This is the level's answer to the worst thing in its own screenshots: a
  // post, a pail, a fence or a bench terminating on a hard silhouette against
  // lying snow, with nothing banked against it and no scour seam, photographs
  // as a cutout pasted onto a white plane - and correcting the object's Y does
  // not touch that, because Y was never what the eye reads.
  //
  // Built from the SAME material as the ground so it welds visually, and
  // deliberately not a circle: banked and proud on the lee (+WIND_X, +WIND_Z),
  // scoured to nothing on the windward side, which is the same asymmetry
  // leeDrift() puts into the height field around every building.
  function snowCollar(B, x, y, z, r, h, seed) {
    var seg = 10, rings = 3;
    var inR = Math.max(0.035, r * 0.55);
    var grid = [], ri, si;
    for (ri = 0; ri <= rings; ri++) {
      var t = ri / rings;
      var row = [];
      for (si = 0; si <= seg; si++) {
        var a = (si % seg) / seg * Math.PI * 2;
        var c = Math.cos(a), s = Math.sin(a);
        var lee = M.saturate((c * WIND_X + s * WIND_Z) * 0.5 + 0.5);
        // The jitter has to be SMOOTH and PERIODIC in the azimuth. A per-vertex
        // hash makes adjacent segments differ by half their radius, and a ten
        // segment ring with that on it is a star, not a drift - which is
        // exactly what the first capture put at the foot of every prop.
        var ph = (seed | 0) * 0.618;
        var jit = 0.88 + 0.13 * Math.sin(a * 2 + ph) + 0.08 * Math.sin(a * 3 - ph * 1.7);
        var rOut = r * (0.92 + 0.78 * lee * lee) * jit;
        var rr = inR + (rOut - inR) * t;
        // proud against the object, crest a third of the way out, feathering
        // to just BELOW the surrounding snow at the rim so it cannot read as a
        // washer sitting on top of the ground
        var prof = (1 - t) * 0.50 + Math.max(0, 1 - Math.abs((t - 0.32) / 0.64)) * 0.78;
        var yy = h * (0.28 + 1.15 * lee) * jit * prof - 0.045 * t * t;
        row.push([c * rr, yy, s * rr]);
      }
      grid.push(row);
    }
    var pos = [], nor = [];
    function tri(A, Bv, C) {
      var ux = Bv[0] - A[0], uy = Bv[1] - A[1], uz = Bv[2] - A[2];
      var vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= l; ny /= l; nz /= l;
      pos.push(A[0], A[1], A[2], Bv[0], Bv[1], Bv[2], C[0], C[1], C[2]);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    }
    for (ri = 0; ri < rings; ri++) {
      for (si = 0; si < seg; si++) {
        var A = grid[ri][si], Bv = grid[ri][si + 1];
        var C = grid[ri + 1][si + 1], D = grid[ri + 1][si];
        tri(A, Bv, C); tri(A, C, D);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    var old = B.tint;
    B.tint = grey(1.02);
    B.add('snow', g, makeM(x, y, z));
    B.tint = old;
  }

  // Register a contact occluder AND draw its collar in one call, so the two can
  // never disagree about where something is standing.
  function ground(L, B, x, y, z, r, h, seed) {
    snowCollar(B, x, y, z, r, h === undefined ? 0.10 : h, seed || 0);
    L._occluders.push({ x: x, z: z, r: r });
  }
  // ============================================================== THE PLAN ==
  // Everything that stands up is laid out HERE, in the constructor, before any
  // geometry exists - because the ground has to know where the drifts and the
  // pads go before it can be rasterised, and `anchors` has to be answerable the
  // instant the level is constructed.
  //
  // Nothing below reads a camera pose. Every structure is placed against the
  // road's own centreline function, so moving the road moves the village with
  // it and a framing can never drag a building out from under itself.
  function plan(P) {
    var i;
    P.rects = [];       // drift sources
    P.pads = [];        // flattened building pads
    P.paths = [];       // shovelled trenches

    function rect(x, z, hx, hz, yaw, amp, reach) {
      var c = Math.cos(yaw), s = Math.sin(yaw);
      P.rects.push({ x: x, z: z, hx: hx, hz: hz, c: c, s: s,
        amp: amp === undefined ? 1.05 : amp, reach: reach === undefined ? 4.2 : reach });
    }
    function pad(x, z, hx, hz, yaw, y) {
      P.pads.push({ x: x, z: z, hx: hx, hz: hz, c: Math.cos(yaw), s: Math.sin(yaw), y: y });
    }
    // Ground level BEFORE any pad exists - the pad is derived from it, so this
    // is deliberately the rock plus the open-field snow depth at that point.
    function raw(x, z) { return rockY(x, z, P) + SNOW_BASE * 0.35; }

    // ---- the dachas --------------------------------------------------------
    // side: -1 west, +1 east. `off` is the setback from the carriageway centre.
    // The yaw faces the gable end at the road, which is how a road-frontage
    // izba actually sits and gives every one of them a triangular silhouette
    // toward the camera rather than a long blank flank.
    var D = [
      // off 19 rather than 13.5: this house's own depth runs across the road,
      // so at 13.5 its gable end reached to 8.7 m from the carriageway centre
      // and its yard fence to 6.3 - which put hero1's standpoint half a metre
      // outside somebody's washing line. It is the last house at the pass
      // entrance and standing further back suits it.
      { z: 41.0, side: -1, off: 19.0, w: 7.4, d: 9.6, h: 3.05, lit: 1, kind: 'log' },
      { z: 35.5, side: 1, off: 12.0, w: 6.6, d: 8.8, h: 2.85, lit: 0, kind: 'log' },
      { z: 24.5, side: -1, off: 15.5, w: 8.2, d: 10.4, h: 3.30, lit: 1, kind: 'log' },
      // burnt: this palette has no black in it anywhere, and charred timber is
      // one of only two materials that can supply one. It sits 30 m up the road
      // on the east side, which is inside hero1's right third.
      { z: 16.5, side: 1, off: 13.0, w: 7.0, d: 9.0, h: 2.95, lit: 0, kind: 'log',
        ruin: 1, burnt: 1 },
      { z: 27.5, side: 1, off: 24.5, w: 6.2, d: 8.2, h: 2.75, lit: 0, kind: 'plank' },
      { z: 6.0, side: 1, off: 15.0, w: 7.8, d: 9.8, h: 3.10, lit: 1, kind: 'log' },
      { z: 9.5, side: -1, off: 26.0, w: 6.8, d: 8.6, h: 2.90, lit: 0, kind: 'log' },
      { z: -7.5, side: 1, off: 12.5, w: 7.2, d: 9.2, h: 3.00, lit: 1, kind: 'log' },
      { z: -15.5, side: -1, off: 14.0, w: 6.4, d: 8.4, h: 2.80, lit: 0, kind: 'plank', ruin: 1 }
    ];
    P.dachas = [];
    for (i = 0; i < D.length; i++) {
      var s = D[i];
      var rx = roadX(s.z);
      var cx = rx + s.side * s.off;
      var cz = s.z;
      // face the road: the gable (local -Z) points at the carriageway
      var yaw = s.side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      yaw += (hash2i(i, 7, 991) - 0.5) * 0.22;         // nothing is square here
      var y = raw(cx, cz) + 0.10;
      var hx = s.w * 0.5, hz = s.d * 0.5;
      P.dachas.push({
        name: 'dacha_' + i, x: cx, z: cz, y: y, yaw: yaw, side: s.side,
        w: s.w, d: s.d, h: s.h, kind: s.kind, ruin: !!s.ruin, lit: !!s.lit,
        burnt: !!s.burnt, idx: i
      });
      pad(cx, cz, hx + 0.30, hz + 0.30, yaw, y);
      rect(cx, cz, hx, hz, yaw, 1.25, 4.6);
      // the shovelled trench from the carriageway edge to the door
      var doorX = cx - Math.sin(yaw) * 0, doorZ = cz;
      // local -Z is the gable that faces the carriageway, and the door is in it
      var dirx = -Math.sin(yaw), dirz = -Math.cos(yaw);
      var outX = cx + dirx * (hz + 0.45), outZ = cz + dirz * (hz + 0.45);
      var edgeZ = cz + (hash2i(i, 3, 55) - 0.5) * 2.2;
      var edgeX = roadX(edgeZ) + s.side * (ROAD_HALF + BERM_W * 0.85);
      var midX = (outX + edgeX) * 0.5 + (hash2i(i, 11, 77) - 0.5) * 2.4;
      var midZ = (outZ + edgeZ) * 0.5 + (hash2i(i, 13, 79) - 0.5) * 2.4;
      P.paths.push([[edgeX, edgeZ], [midX, midZ], [outX, outZ]]);
      P.dachas[i].doorOuter = [outX, outZ];
      P.dachas[i].pathEdge = [edgeX, edgeZ];
      void doorX; void doorZ;
    }

    // ---- the church --------------------------------------------------------
    // West side, and it has to be: hero1 looks north up a road that curves LEFT,
    // so a landmark on the west sits inside the outer edge of that curve and
    // stays in frame for the whole approach. On the east it would leave frame
    // by 20 m.
    var chZ = -2.0;
    var chX = roadX(chZ) - 17.0;
    var chY = raw(chX, chZ) + 0.22;
    P.church = {
      x: chX, z: chZ, y: chY, yaw: 0.06,
      naveHW: 5.5, naveHZ: 7.8,          // nave half-extents (local x, z)
      wall: 6.6, ridge: 10.4,
      towerHW: 3.1, towerZ: 9.4,         // tower centre offset in local +Z
      towerTop: 13.2, domeApex: 20.6,
      apseZ: -9.4, apseR: 4.2
    };
    pad(chX, chZ, P.church.naveHW + 0.55, P.church.naveHZ + 0.55, P.church.yaw, chY);
    pad(chX + Math.sin(P.church.yaw) * P.church.towerZ,
      chZ + Math.cos(P.church.yaw) * P.church.towerZ,
      P.church.towerHW + 0.6, P.church.towerHW + 0.6, P.church.yaw, chY);
    rect(chX, chZ, P.church.naveHW, P.church.naveHZ, P.church.yaw, 1.55, 6.2);
    rect(chX + Math.sin(P.church.yaw) * P.church.towerZ,
      chZ + Math.cos(P.church.yaw) * P.church.towerZ,
      P.church.towerHW, P.church.towerHW, P.church.yaw, 1.35, 5.0);
    // the path to the church door, trodden by more feet than any other
    var cdX = chX + Math.sin(P.church.yaw) * (P.church.towerZ + P.church.towerHW + 0.9);
    var cdZ = chZ + Math.cos(P.church.yaw) * (P.church.towerZ + P.church.towerHW + 0.9);
    var ceZ = 9.5, ceX = roadX(ceZ) - (ROAD_HALF + BERM_W * 0.85);
    P.paths.push([[ceX, ceZ], [(ceX + cdX) * 0.5 - 1.4, (ceZ + cdZ) * 0.5 + 0.8], [cdX, cdZ]]);
    P.church.door = [cdX, cdZ];
    P.church.pathEdge = [ceX, ceZ];

    // ---- the barn ----------------------------------------------------------
    var bnZ = 48.0, bnX = roadX(bnZ) + 20.0;
    var bnY = raw(bnX, bnZ) + 0.08;
    P.barn = { x: bnX, z: bnZ, y: bnY, yaw: -Math.PI * 0.5 + 0.14, w: 9.2, d: 14.0,
      eave: 4.6, ridge: 7.2 };
    pad(bnX, bnZ, 4.9, 7.3, P.barn.yaw, bnY);
    rect(bnX, bnZ, 4.6, 7.0, P.barn.yaw, 1.45, 5.6);

    // ---- the stalled convoy ------------------------------------------------
    // Nose to tail up the carriageway, each one a little off the centreline in
    // a different direction: a column that has stopped badly, not a car park.
    var TR = [
      { z: 2.4, off: 0.9, yaw: 0.62, kind: 'tilt', lights: 0 },
      { z: 11.6, off: -1.0, yaw: 0.05, kind: 'burnt', lights: 0 },
      { z: 19.8, off: 0.7, yaw: -0.14, kind: 'tilt', lights: 1 },
      { z: 28.0, off: -0.6, yaw: 0.08, kind: 'open', lights: 0 },
      { z: 36.4, off: 0.8, yaw: 0.03, kind: 'tilt', lights: 1 }
    ];
    P.trucks = [];
    for (i = 0; i < TR.length; i++) {
      var t = TR[i];
      var tx = roadX(t.z) + t.off;
      var ty = rockY(tx, t.z, P) + 0.10;
      P.trucks.push({ name: 'truck_' + i, x: tx, y: ty, z: t.z, yaw: t.yaw,
        kind: t.kind, lights: !!t.lights, idx: i });
      rect(tx, t.z, 1.5, 3.9, t.yaw, 0.55, 2.8);
    }

    // ---- the wreck ---------------------------------------------------------
    // A burnt-out cab that was shoved off the carriageway into the deep snow,
    // 7 m short of hero1's standpoint and 26 degrees off its axis. Two jobs:
    // it is the near-field mass in the left third that stops the signature
    // frame being a bilaterally symmetric one-point corridor, and charred
    // steel is a genuine BLACK in a palette whose world histogram otherwise
    // runs 0.317 to 0.790 with 0.89% of pixels below 0.25.
    var wkZ = 43.5;
    var wkX = roadX(wkZ) - 7.6;                 // clear of the berm foot at 7.0
    P.wreck = { x: wkX, z: wkZ, y: rockY(wkX, wkZ, P), yaw: -0.68,
      pitch: 0.06, roll: 0.09 };
    rect(wkX, wkZ, 1.3, 2.7, P.wreck.yaw, 0.65, 3.0);

    // ---- the rock ledge the overview stands on ----------------------------
    var lgZ = 9.0, lgX = roadX(lgZ) + 31.0;
    P.ledge = { x: lgX, z: lgZ, y: rockY(lgX, lgZ, P) + 8.0, yaw: -1.25 };
    // The overview's standpoint is PLANNED, not chosen by the pose code, so
    // buildRocks can keep clear of it. The first attempt at this framing put
    // the eye 10 m south along the ledge and landed inside a 4 m buttress
    // boulder: the establishing shot was a close-up of a rock face.
    P.ledge.eyeX = lgX - 7.4;
    P.ledge.eyeZ = lgZ + 9.6;
    P.ledge.eyeClear = 3.4;
    // The aim is planned too, so the ledge dressing knows which way the shot
    // faces and can put its foreground on that side instead of behind the lens.
    // 35 m rather than 46: at 46 m the barrier was the subject and this level's
    // fog had already taken it, so the establishing shot established fog. The
    // near carriageway and two trucks at 27-30 m are what carry it, with the
    // bridge beyond them and the church tower on the left third.
    P.ledge.aimX = roadX(-3) - 1.0;
    P.ledge.aimZ = -3.0;
    P.ledge.aimY = 3.5;
    pad(lgX, lgZ, 9.0, 11.0, 0, P.ledge.y);
    rect(lgX, lgZ, 4.0, 5.0, 0, 0.55, 3.2);

    // ---- the bridge --------------------------------------------------------
    P.bridge = {
      x: roadX((BR_NEAR + BR_FAR1) * 0.5),
      nearZ: BR_NEAR, tornZ: BR_TORN, farZ0: BR_FAR0, farZ1: BR_FAR1,
      deckY: roadY(BR_NEAR) + 0.35,
      gorgeFloor: rockY(roadX(GORGE_Z), GORGE_Z, P)
    };
    return P;
  }

  // ============================================================= THE GROUND ==
  // One indexed grid over the playable valley plus a coarse skirt out to the
  // whiteout. The grid IS the height field the rest of the level samples, so
  // sampleGround, the navgrid, the collider tiles and the vertex paint can
  // never disagree with what the camera sees.
  function buildGround(L, rng) {
    var P = L.plan, N = L.noise;
    var cell = FIELD_CELL;
    var w = Math.round((X_MAX - X_MIN) / cell) + 1;
    var h = Math.round((Z_MAX - Z_MIN) / cell) + 1;
    var field = new Float32Array(w * h);
    var i, j, k, x, z;

    for (j = 0; j < h; j++) {
      z = Z_MIN + j * cell;
      for (i = 0; i < w; i++) {
        x = X_MIN + i * cell;
        field[j * w + i] = snowY(x, z, P);
      }
    }
    L.field = { a: field, w: w, h: h, cell: cell, x0: X_MIN, z0: Z_MIN };

    var pos = new Float32Array(w * h * 3);
    var col = new Float32Array(w * h * 3);
    var uv = new Float32Array(w * h * 2);
    var idx = [];

    // ---- vertex paint ------------------------------------------------------
    // The whole tonal structure of the level is in this loop. Snow albedo is
    // nearly constant; what a photograph of snow actually contains is
    //   * hollows that are darker AND BLUER, because a drift trough sees only
    //     sky and the sky here is the coldest thing in the frame
    //   * crests that are a fraction brighter, which is what gives a field of
    //     drifts its direction
    //   * everything a human or a vehicle has touched, which is grey
    // Getting those three right is worth more than any amount of albedo detail.
    //
    // ROADC is a multiplier on the PACKED map, not on the fresh one. The
    // carriageway used to be the fresh sastrugi map at 0.545 - a three-stop
    // step that read as wet asphalt, and carried the identical 1.5 m diagonal
    // ripple train as the bank beside it. It is now its own draw group on
    // material('snow_road'), whose albedo already sits ~0.81 of fresh, so this
    // only has to take it a further value down rather than three.
    var HOLLOW = [0.610, 0.718, 0.955];
    var ROADC = [0.928, 0.940, 0.972];
    var RUTC = [0.780, 0.802, 0.876];
    var TRENCH = [0.520, 0.570, 0.700];
    var PATHC = [0.800, 0.815, 0.862];
    for (j = 0; j < h; j++) {
      z = Z_MIN + j * cell;
      for (i = 0; i < w; i++) {
        x = X_MIN + i * cell;
        k = j * w + i;
        var y = field[k];
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x; uv[k * 2 + 1] = z;

        // discrete laplacian -> concavity. Positive = a hollow.
        var im = field[j * w + Math.max(0, i - 1)], ip = field[j * w + Math.min(w - 1, i + 1)];
        var jm = field[Math.max(0, j - 1) * w + i], jp = field[Math.min(h - 1, j + 1) * w + i];
        var lap = (im + ip + jm + jp) * 0.25 - y;
        var hollow = M.saturate(lap * 5.2);
        var crest = M.saturate(-lap * 5.2);

        var r = 1, g = 1, b = 1;
        r = M.lerp(r, HOLLOW[0], hollow * 0.92);
        g = M.lerp(g, HOLLOW[1], hollow * 0.92);
        b = M.lerp(b, HOLLOW[2], hollow * 0.92);
        // A crest is not just brighter, it is WARMER: it is the one part of a
        // drift field that sees the whole dome including the thin bright patch
        // where the sun is, while the trough sees only the cold zenith. Pushing
        // the two apart in chroma as well as value is what stops a white/blue
        // brief measuring 0.039 saturation and tripping the monochrome flag.
        r *= 1 + crest * 0.112; g *= 1 + crest * 0.082; b *= 1 + crest * 0.038;

        // Macro variation so a 1.8 m tile does not read as a 1.8 m tile - and
        // it is CHROMATIC, not a neutral gain. Snow covers 60% of every framing
        // here, so a low-frequency warm/cool wander across it is the single
        // biggest lever this level has on mean saturation, which was sitting on
        // the 0.040 monochrome limit in two of five frames.
        var mv = N.fbm2(x * 0.042 + 12.0, z * 0.042 - 5.0, 2);
        var mv2 = N.fbm2(x * 0.16 - 4.0, z * 0.16 + 9.0, 2);
        r *= 1 + mv * 0.088 + mv2 * 0.030;
        g *= 1 + mv * 0.058 + mv2 * 0.021;
        b *= 1 + mv * 0.014 + mv2 * 0.010 + 0.022;

        // ---- the carriageway ------------------------------------------------
        var u = x - roadX(z);
        var a = Math.abs(u);
        var onRoad = 1 - M.smoothstep(ROAD_HALF - 0.55, ROAD_HALF + 0.55, a);
        if (onRoad > 0.002) {
          var dirt = M.saturate(0.74 + N.fbm2(x * 0.6, z * 0.6, 2) * 0.28) * onRoad;
          r = M.lerp(r, ROADC[0], dirt);
          g = M.lerp(g, ROADC[1], dirt);
          b = M.lerp(b, ROADC[2], dirt);
          // the two wheel tracks: polished, greyer and a shade bluer than the
          // pan between them, so the ruts read even where the geometry is
          // edge-on to the camera
          var rut = M.saturate(bump(u, 1.42, 0.72) + bump(u, -1.42, 0.72)) * onRoad;
          r = M.lerp(r, RUTC[0], rut * 0.86);
          g = M.lerp(g, RUTC[1], rut * 0.86);
          b = M.lerp(b, RUTC[2], rut * 0.86);
        }
        // the plough berm's cut face is scraped clean and bright
        var bt = (a - (ROAD_HALF + 0.35)) / BERM_W;
        if (bt > -0.30 && bt < 0.45) {
          var bl = 1 + 0.030 * (1 - Math.abs(bt / 0.4));
          r *= bl; g *= bl; b *= bl;
        }

        // ---- the trodden paths ----------------------------------------------
        var pmin = 9;
        for (var pi = 0; pi < P.paths.length; pi++) {
          var poly = P.paths[pi];
          for (var pj = 0; pj + 1 < poly.length; pj++) {
            var dd = segDist(x, z, poly[pj][0], poly[pj][1], poly[pj + 1][0], poly[pj + 1][1]);
            if (dd < pmin) pmin = dd;
          }
        }
        if (pmin < 2.0) {
          // The trench INTERIOR, not a tonal wash over the whole path corridor.
          // Squared falloff so the cut floor is genuinely dark and blue - a
          // trench that is 0.7 m deep sees a strip of sky and nothing else -
          // while the spoil ridge on its lip is lifted instead.
          var deep = 1 - M.smoothstep(0.42, 1.00, pmin);
          var pw = deep * deep * 0.92;
          r = M.lerp(r, TRENCH[0], pw);
          g = M.lerp(g, TRENCH[1], pw);
          b = M.lerp(b, TRENCH[2], pw);
          var trod = (1 - M.smoothstep(1.00, 1.80, pmin)) * (1 - deep) * 0.55;
          r = M.lerp(r, PATHC[0], trod);
          g = M.lerp(g, PATHC[1], trod);
          b = M.lerp(b, PATHC[2], trod);
          var spoil = bump(pmin, 1.20, 0.44) * 0.055;
          r *= 1 + spoil; g *= 1 + spoil; b *= 1 + spoil * 1.10;
        }

        // ---- sky occlusion at the foot of every wall ------------------------
        // Ambient IS the lighting here, so the only thing that grounds a
        // structure is how much sky its own bulk takes away from the snow at
        // its foot. GTAO measures 15% under a dacha eave, which is nowhere near
        // enough. This is a modelled contact gradient and it is driven BLUE,
        // because what is being removed is skylight and skylight is the coldest
        // thing in the frame - a neutral darkening here reads as dirt.
        var near = 9;
        for (var di = 0; di < P.rects.length; di++) {
          var rr = P.rects[di];
          var ddx = x - rr.x, ddz = z - rr.z;
          var lx = ddx * rr.c + ddz * rr.s, lz = -ddx * rr.s + ddz * rr.c;
          var ox = Math.max(0, Math.abs(lx) - rr.hx), oz = Math.max(0, Math.abs(lz) - rr.hz);
          var dn = Math.sqrt(ox * ox + oz * oz);
          if (dn < near) near = dn;
        }
        if (near < 2.8) {
          var occ = 1 - M.smoothstep(0.0, 2.8, near);
          occ = occ * occ;
          r *= 1 - occ * 0.54; g *= 1 - occ * 0.47; b *= 1 - occ * 0.33;
        }
        // the steep gorge walls are bare rock showing through
        var gsp = 1 - Math.abs(field[k] - rockY(x, z, P)) / 0.45;
        if (gsp > 0) {
          var bare = M.saturate(gsp) * 0.85;
          r = M.lerp(r, 0.235, bare); g = M.lerp(g, 0.228, bare); b = M.lerp(b, 0.242, bare);
        }
        // sky occlusion in the ravine itself
        var gz2 = GORGE_Z + 2.6 * Math.sin(x * 0.055) + 1.15 * Math.sin(x * 0.13 + 2.0);
        var ga2 = Math.abs((z - gz2) / GORGE_HALF);
        if (ga2 < 1.0) {
          var occ = (1 - M.smoothstep(0.30, 1.0, ga2)) * 0.62;
          r *= 1 - occ * 0.72; g *= 1 - occ * 0.68; b *= 1 - occ * 0.58;
        }

        col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
      }
    }
    // ---- two draw groups: the field, and the ploughed carriageway ----------
    // The whole reason material('snow_road') exists is that a compacted,
    // trafficked surface is a DIFFERENT surface - polished pans, grit, and the
    // scoured shear lines a tyre leaves instead of wind ripples. It used to be
    // reachable from exactly one call site (the bridge deck) while the 800 m2
    // carriageway that dominates five of eight framings ran the fresh-snow
    // sastrugi map darkened by a vertex multiply. One extra draw call fixes it.
    var idxRoad = [];
    for (j = 0; j + 1 < h; j++) {
      var zc = Z_MIN + (j + 0.5) * cell;
      var rxc = roadX(zc);
      for (i = 0; i + 1 < w; i++) {
        var a0 = j * w + i, b0 = a0 + 1, c0 = a0 + w, d0 = c0 + 1;
        var xc = X_MIN + (i + 0.5) * cell;
        var t6 = (Math.abs(xc - rxc) < ROAD_HALF + 0.30) ? idxRoad : idx;
        t6.push(a0, c0, b0, b0, c0, d0);
      }
    }
    var nField = idx.length;
    for (k = 0; k < idxRoad.length; k++) idx.push(idxRoad[k]);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    var uvs = new Float32Array(uv.length);
    for (k = 0; k < uv.length; k++) uvs[k] = uv[k] * SURF.snow.uv;
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx.length > 65535 ? new THREE.Uint32BufferAttribute(idx, 1)
      : new THREE.Uint16BufferAttribute(idx, 1));
    geo.addGroup(0, nField, 0);
    geo.addGroup(nField, idxRoad.length, 1);
    geo.computeVertexNormals();
    Geo.copyUV1(geo);
    geo.computeBoundingSphere();

    var mesh = new THREE.Mesh(geo, [L.material('snow'), L.material('snow_road')]);
    mesh.name = 'snowbound_ground';
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    L.root.add(mesh); L.meshes.push(mesh);

    // Keep the un-occluded colours so contact rings can be re-applied as a
    // single accumulated mask rather than compounding multiplicatively - two
    // props a metre apart would otherwise punch a hole in the snow between them.
    L._groundGeo = geo;
    L._groundBaseCol = col.slice(0);
    L._contactMask = new Float32Array(w * h);

    // ---- the skirt ---------------------------------------------------------
    // Coarse ground out to 150 m so the valley walls climb into the whiteout
    // instead of ending at a visible edge. It is never walked on and it is
    // never closer than 56 m, so 4 m cells are ample.
    buildSkirt(L);
    return L.field;
  }

  function buildSkirt(L) {
    var P = L.plan;
    var step = 4.5;
    var x0 = -150, x1 = 150, z0 = -140, z1 = 130;
    var w = Math.round((x1 - x0) / step) + 1;
    var h = Math.round((z1 - z0) / step) + 1;
    var pos = [], col = [], uvA = [], idx = [];
    var map = new Int32Array(w * h);
    var n = 0, i, j;
    for (j = 0; j < h; j++) {
      var z = z0 + j * step;
      for (i = 0; i < w; i++) {
        var x = x0 + i * step;
        var inner = (x > X_MIN - step && x < X_MAX + step && z > Z_MIN - step && z < Z_MAX + step);
        if (inner) { map[j * w + i] = -1; continue; }
        var y = rockY(x, z, P) + SNOW_BASE * 1.15 +
          L.noise.fbm2(x * 0.035, z * 0.035, 2) * 1.2;
        map[j * w + i] = n++;
        pos.push(x, y, z);
        var sh = M.saturate(L.noise.fbm2(x * 0.06, z * 0.06, 2) * 0.5 + 0.5);
        col.push(0.96 + sh * 0.05, 0.97 + sh * 0.04, 1.00 + sh * 0.02);
        uvA.push(x * SURF.snow.uv, z * SURF.snow.uv);
      }
    }
    for (j = 0; j + 1 < h; j++) {
      for (i = 0; i + 1 < w; i++) {
        var a = map[j * w + i], b = map[j * w + i + 1];
        var c = map[(j + 1) * w + i], d = map[(j + 1) * w + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (!idx.length) return;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvA), 2));
    geo.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    Geo.copyUV1(geo);
    geo.computeBoundingSphere();
    var mesh = new THREE.Mesh(geo, L.material('snow'));
    mesh.name = 'snowbound_skirt';
    mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    L.root.add(mesh); L.meshes.push(mesh);
  }
  // ========================================================= SNOW ON A ROOF ==
  // The single most characteristic shape in the level and the one most easily
  // got wrong. A snow load is NOT a slab of constant thickness parallel to the
  // roof: it is thickest a third of the way up the slope, it creeps, and at the
  // eave it ROLLS OVER the fascia and droops into a lip that eventually calves.
  // It is also never straight along the ridge, which is why this lays a run of
  // 5-9 independent sections with their own thickness, overhang and droop.
  //
  // Two convex extrusions per section rather than one concave one: extrudeX
  // caps with a triangle fan, and a fan across a concave profile folds. Two
  // convex pieces are cheaper than an ear-clipper and cannot fail.
  function roofSnowRun(B, key, za, zb, run, drop, base, rng, icicle) {
    var n = Math.max(3, Math.round(Math.abs(zb - za) / 1.35));
    for (var i = 0; i < n; i++) {
      var s0 = za + (zb - za) * (i / n);
      var s1 = za + (zb - za) * ((i + 1) / n);
      var t = base * rng.range(0.82, 1.24);
      var over = rng.range(0.16, 0.40);
      var sag = rng.range(0.10, 0.42) * (i % 2 ? 1.15 : 0.8);
      // slab: ridge -> eave, thickest at 40% of the slope
      var slab = [
        [0, t * 0.86],
        [run * 0.40, -drop * 0.40 + t * 1.18],
        [run, -drop + t * 0.90],
        [run, -drop],
        [0, 0]
      ];
      B.add(key, extrudeX(slab, s0, s1), null);
      // the lip rolling over the fascia
      var lip = [
        [run - 0.10, -drop + t * 0.95],
        [run + over, -drop + t * 0.30],
        [run + over * 0.86, -drop - sag],
        [run - 0.10, -drop - sag * 0.30]
      ];
      B.add(key, extrudeX(lip, s0, s1), null);
      if (icicle && rng.next() < 0.65) {
        var nI = rng.int(1, 3);
        for (var k = 0; k < nI; k++) {
          var ix = M.lerp(s0, s1, rng.range(0.15, 0.85));
          var len = rng.range(0.16, 0.72);
          B.add('ice', cyl(0.001, rng.range(0.022, 0.045), len, 5),
            makeM(ix, -drop - sag * 0.6 - len * 0.5, run + over * 0.7));
        }
      }
    }
  }

  // A pitched roof plane made of BOARDS, not one quad. A roof is the largest
  // uninterrupted surface on a building and it is the first thing that reads as
  // untextured geometry if it is a single face.
  function boardedSlope(B, key, za, zb, run, drop, thick, rng, sign) {
    var n = Math.max(4, Math.round(Math.abs(zb - za) / 0.62));
    var len = Math.sqrt(run * run + drop * drop);
    var pitch = Math.atan2(drop, run);
    for (var i = 0; i < n; i++) {
      var s0 = za + (zb - za) * (i / n);
      var s1 = za + (zb - za) * ((i + 1) / n);
      var w = Math.abs(s1 - s0) * 0.94;
      var lift = rng.range(-0.012, 0.020);
      B.add(key, box(len, thick, w),
        makeM(sign * run * 0.5, -drop * 0.5 + thick * 0.5 + lift, (s0 + s1) * 0.5,
          0, 0, -sign * pitch));
    }
  }

  // ================================================================= DACHA ==
  // A log izba: stacked round logs with the ends protruding at the corners, a
  // planked gable to the road with carved window surrounds, a steep snow-shed
  // roof, a stove chimney and a porch. Built in a local frame with the ridge
  // along +Z and the ROAD GABLE at -Z, so the framings see a triangle rather
  // than a blank flank.
  function buildDacha(L, B, rng, S) {
    var hw = S.w * 0.5, hd = S.d * 0.5;
    var wallH = S.h;
    var over = 0.52;                     // eave overhang
    var run = hw + over;
    var rise = run * 0.86;               // steep: a roof that sheds
    var eaveY = wallH;
    var ridgeY = wallH + rise;
    var logR = 0.145, course = 0.245;
    var nC = Math.max(6, Math.round(wallH / course));
    var i, j;

    B.pushXYZ(S.x, S.y, S.z, 0, S.yaw, 0);
    // A house that burned. Charcoal under every local tint - the snow lying on
    // what is left of it is exempted in Builder.add, because a burnt roof under
    // fresh snow is still white, and the contrast between the two is the point.
    B.base = S.burnt ? new THREE.Color(0.185, 0.170, 0.165) : null;

    // ---- plinth: field stones under the sill logs -------------------------
    B.tint = grey(0.86);
    for (i = 0; i < 14; i++) {
      var pa = i / 14 * Math.PI * 2;
      var pr = Math.max(hw, hd) * 0.96;
      var px = Math.cos(pa) * hw * 1.02, pz = Math.sin(pa) * hd * 1.02;
      B.boxR('stonework', rng.range(0.4, 0.8), rng.range(0.26, 0.42), rng.range(0.35, 0.6),
        px, -0.14, pz, rng.range(-0.2, 0.2), rng.range(0, 3.1), rng.range(-0.2, 0.2));
      void pr;
    }
    B.tint = null;

    // ---- log courses -------------------------------------------------------
    var openings = [];
    // door in the road gable
    var doorW = 0.98, doorH = 1.95;
    openings.push({ face: 'zmin', c: -0.15, w: doorW, y0: 0, y1: doorH, door: 1 });
    // windows in the road gable, either side of the door
    openings.push({ face: 'zmin', c: -0.15 - doorW * 0.5 - 1.15, w: 0.86, y0: 1.05, y1: 2.15 });
    if (S.w > 6.8) {
      openings.push({ face: 'zmin', c: -0.15 + doorW * 0.5 + 1.15, w: 0.86, y0: 1.05, y1: 2.15 });
    }
    // windows in the flanks
    openings.push({ face: 'xmin', c: -hd * 0.34, w: 0.86, y0: 1.05, y1: 2.15 });
    openings.push({ face: 'xmin', c: hd * 0.42, w: 0.86, y0: 1.05, y1: 2.15 });
    openings.push({ face: 'xmax', c: 0.0, w: 0.86, y0: 1.05, y1: 2.15 });
    openings.push({ face: 'zmax', c: 0.3, w: 0.80, y0: 1.15, y1: 2.10 });

    function skipsFor(face, y) {
      var out = [];
      for (var k = 0; k < openings.length; k++) {
        var o = openings[k];
        if (o.face !== face) continue;
        if (y < o.y0 - logR || y > o.y1 + logR) continue;
        out.push([o.c - o.w * 0.5, o.c + o.w * 0.5]);
      }
      return out;
    }

    var logKey = S.kind === 'plank' ? 'timber_dark' : 'timber';
    if (S.burnt) logKey = 'timber_dark';
    for (i = 0; i < nC; i++) {
      var y = 0.06 + i * course;
      if (y > wallH) break;
      var ext = 0.26 + (i % 2) * 0.06;
      var jitter = rng.range(-0.012, 0.012);
      // flanks: logs running along Z at x = +-hw
      logRun(B, logKey, -hw, -hd - ext, -hw, hd + ext, y + jitter, logR,
        skipsFor('xmin', y), -hd - ext, hd + ext);
      logRun(B, logKey, hw, -hd - ext, hw, hd + ext, y - jitter, logR,
        skipsFor('xmax', y), -hd - ext, hd + ext);
      // gables: logs running along X at z = +-hd
      var ext2 = 0.26 + ((i + 1) % 2) * 0.06;
      logRun(B, logKey, -hw - ext2, -hd, hw + ext2, -hd, y + course * 0.5, logR,
        skipsFor('zmin', y + course * 0.5), -hw - ext2, hw + ext2);
      logRun(B, logKey, -hw - ext2, hd, hw + ext2, hd, y + course * 0.5, logR,
        skipsFor('zmax', y + course * 0.5), -hw - ext2, hw + ext2);
    }

    // ---- gable triangles, planked vertically ------------------------------
    var gz = [-hd, hd];
    for (var gi = 0; gi < 2; gi++) {
      var zz = gz[gi] * 0.995;
      var np = 12;
      for (i = 0; i < np; i++) {
        var t0 = (i + 0.5) / np;
        var px2 = M.lerp(-hw, hw, t0);
        var hh = rise * (1 - Math.abs(px2) / hw);
        if (hh < 0.05) continue;
        B.tint = grey(rng.range(0.86, 1.06));
        B.add('timber_dark', box(hw * 2 / np * 0.92, hh, 0.075),
          makeM(px2, eaveY + hh * 0.5, zz));
      }
      B.tint = null;
      // bargeboards along the two rakes, and a finial where they meet
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        B.add('timber_dark', box(Math.sqrt(run * run + rise * rise), 0.20, 0.055),
          makeM(sgn * run * 0.5, eaveY + rise * 0.5 + 0.03, zz + gi * 0.0 - (gi ? -0.11 : 0.11),
            0, 0, sgn * -Math.atan2(rise, run)));
      }
      B.add('timber_dark', box(0.16, 0.62, 0.10), makeM(0, ridgeY + 0.18, zz + (gi ? -0.14 : 0.14)));
    }

    // ---- purlins and rafter tails -----------------------------------------
    for (var rsgn = -1; rsgn <= 1; rsgn += 2) {
      var nr = Math.max(4, Math.round(S.d / 0.85));
      for (i = 0; i <= nr; i++) {
        var rz = M.lerp(-hd - 0.18, hd + 0.18, i / nr);
        B.add('timber_dark', box(Math.sqrt(run * run + rise * rise) + 0.12, 0.10, 0.09),
          makeM(rsgn * run * 0.5, eaveY + rise * 0.5 - 0.06, rz, 0, 0, rsgn * -Math.atan2(rise, run)));
      }
    }

    // ---- roof boards + snow load -------------------------------------------
    var ruinCut = S.ruin ? 0.42 : 1.0;
    for (var psgn = -1; psgn <= 1; psgn += 2) {
      var zEnd = hd + 0.18;
      var zStart = -hd - 0.18;
      if (S.ruin && psgn > 0) zEnd = M.lerp(zStart, zEnd, ruinCut);
      B.pushXYZ(0, ridgeY, 0, 0, 0, 0);
      B.tint = grey(0.92);
      boardedSlope(B, 'timber', zStart, zEnd, run, rise, 0.075, rng, psgn);
      B.tint = null;
      B.pop();
      // The snow. Extruded along the ridge, so the profile frame is rotated so
      // that extrudeX's ridge axis lands on world/local Z.
      B.pushXYZ(0, ridgeY, 0, 0, psgn > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0);
      var za = psgn > 0 ? -zEnd : zStart, zb = psgn > 0 ? -zStart : zEnd;
      roofSnowRun(B, 'snow', za, zb, run + 0.05, rise, 0.30 + rng.range(0, 0.14), rng, true);
      B.pop();
    }
    if (S.ruin) {
      // the collapsed half: rafters snapped and fallen inward, snow drifted in
      B.tint = grey(0.7);
      for (i = 0; i < 7; i++) {
        var fz = M.lerp(hd * ruinCut, hd, rng.next());
        B.strut('timber_dark', rng.range(-hw, hw * 0.2), eaveY + rng.range(-0.2, 0.4), fz,
          rng.range(-hw * 0.3, hw), 0.15, fz + rng.range(-1.2, 1.2), 0.11, 0.10);
      }
      B.tint = null;
      B.tint = grey(1.02);
      for (i = 0; i < 5; i++) {
        B.boxR('snow', rng.range(1.2, 2.6), rng.range(0.30, 0.62), rng.range(1.0, 2.2),
          rng.range(-hw * 0.7, hw * 0.7), 0.16, M.lerp(hd * ruinCut, hd - 0.4, rng.next()),
          rng.range(-0.1, 0.1), rng.range(0, 3), rng.range(-0.1, 0.1));
      }
      B.tint = null;
    }
    // ridge cap
    B.add('timber_dark', box(0.30, 0.13, S.d + 0.5), makeM(0, ridgeY + 0.06, 0));

    // ---- openings: frames, glazing, shutters, carved surrounds -------------
    for (i = 0; i < openings.length; i++) {
      var o = openings[i];
      var ox = 0, oz = 0, oyaw = 0;
      if (o.face === 'zmin') { oz = -hd - 0.02; oyaw = 0; ox = o.c; }
      else if (o.face === 'zmax') { oz = hd + 0.02; oyaw = Math.PI; ox = o.c; }
      else if (o.face === 'xmin') { ox = -hw - 0.02; oyaw = Math.PI * 0.5; oz = o.c; }
      else { ox = hw + 0.02; oyaw = -Math.PI * 0.5; oz = o.c; }
      B.pushXYZ(ox, 0, oz, 0, oyaw, 0);
      if (o.door) buildDoor(B, rng, o, S);
      else buildWindow(B, rng, o, S, L);
      B.pop();
    }

    // ---- porch over the road door ------------------------------------------
    var pw = 2.0, pd = 1.35, ph = 2.35;
    B.pushXYZ(-0.15, 0, -hd - pd * 0.5 - 0.05, 0, 0, 0);
    B.tint = grey(0.9);
    for (var pp = -1; pp <= 1; pp += 2) {
      B.add('timber_dark', box(0.14, ph, 0.14), makeM(pp * (pw * 0.5 - 0.1), ph * 0.5, -pd * 0.5 + 0.1));
      B.add('timber_dark', box(0.09, 0.42, 0.09),
        makeM(pp * (pw * 0.5 - 0.1) - pp * 0.16, ph - 0.34, -pd * 0.5 + 0.24, 0, 0, pp * 0.7));
    }
    B.add('timber_dark', box(pw, 0.12, pd), makeM(0, ph, 0, 0.30, 0, 0));
    B.tint = null;
    B.pushXYZ(0, ph + 0.10, 0, 0.30, 0, 0);
    B.tint = grey(1.0);
    B.box('snow', pw + 0.10, 0.20, pd + 0.16, 0, 0.10, 0);
    B.tint = null;
    B.pop();
    // steps, trodden clear
    for (i = 0; i < 3; i++) {
      B.add('timber_dark', box(1.30 - i * 0.05, 0.15, 0.34),
        makeM(0, 0.075 + (2 - i) * 0.15, -pd * 0.5 + 0.2 + i * 0.34));
    }
    B.pop();

    // ---- chimney ------------------------------------------------------------
    var cx2 = hw * 0.42, cz2 = hd * 0.20;
    var chTop = ridgeY + 1.05;
    B.tint = grey(0.80);
    B.box('stonework', 0.62, chTop, 0.58, cx2, chTop * 0.5, cz2);
    B.box('stonework', 0.80, 0.16, 0.76, cx2, chTop + 0.02, cz2);
    B.tint = null;
    B.tint = grey(1.02);
    B.box('snow', 0.86, 0.12, 0.82, cx2, chTop + 0.15, cz2);
    B.tint = null;

    B.base = null;
    B.pop();

    // ---- colliders ---------------------------------------------------------
    var eul = new THREE.Euler(0, S.yaw, 0);
    L.addCollider(S.x, S.y + wallH * 0.5, S.z, hw + 0.16, wallH * 0.5 + 0.4, hd + 0.16,
      'wood', false, eul);
    L.addCollider(S.x, S.y + wallH + rise * 0.45, S.z, hw * 0.62, rise * 0.45, hd + 0.2,
      'wood', false, eul);
    return {
      name: S.name, position: new THREE.Vector3(S.x, S.y, S.z), yaw: S.yaw,
      w: S.w, d: S.d, eave: S.y + eaveY, ridge: S.y + ridgeY,
      doorOuter: new THREE.Vector3(S.doorOuter[0], S.y, S.doorOuter[1]),
      chimney: new THREE.Vector3(
        S.x + cx2 * Math.cos(S.yaw) + cz2 * Math.sin(S.yaw), S.y + chTop,
        S.z - cx2 * Math.sin(S.yaw) + cz2 * Math.cos(S.yaw)),
      lit: S.lit, ruin: S.ruin
    };
  }

  // A run of logs between two points, skipping the window and door openings.
  function logRun(B, key, ax, az, bx, bz, y, r, skips, s0lim, s1lim) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.02) return;
    var ux = dx / len, uz = dz / len;
    // skips are given in the run's own coordinate (world x or z of the centre)
    var spans = [[0, 1]];
    if (skips && skips.length) {
      for (var s = 0; s < skips.length; s++) {
        var a0 = (skips[s][0] - s0lim) / (s1lim - s0lim);
        var a1 = (skips[s][1] - s0lim) / (s1lim - s0lim);
        if (a1 < a0) { var tmp = a0; a0 = a1; a1 = tmp; }
        var next = [];
        for (var q = 0; q < spans.length; q++) {
          var p0 = spans[q][0], p1 = spans[q][1];
          if (a1 <= p0 || a0 >= p1) { next.push([p0, p1]); continue; }
          if (a0 > p0) next.push([p0, a0]);
          if (a1 < p1) next.push([a1, p1]);
        }
        spans = next;
      }
    }
    for (var i = 0; i < spans.length; i++) {
      var t0 = spans[i][0], t1 = spans[i][1];
      if (t1 - t0 < 0.02) continue;
      var px = ax + ux * len * t0, pz = az + uz * len * t0;
      var qx = ax + ux * len * t1, qz = az + uz * len * t1;
      var mx = (px + qx) * 0.5, mz = (pz + qz) * 0.5;
      var l2 = len * (t1 - t0);
      var yaw = Math.atan2(qx - px, qz - pz);
      B.add(key, cyl(r, r * 0.98, l2, 7), makeM(mx, y, mz, Math.PI * 0.5, yaw, 0));
    }
  }

  function buildWindow(B, rng, o, S, L) {
    var w = o.w, h = o.y1 - o.y0, cy = (o.y0 + o.y1) * 0.5;
    var fr = 0.075;
    B.tint = grey(1.06);
    B.box('timber', w + fr * 2, fr, 0.10, 0, o.y0 - fr * 0.5, -0.03);
    B.box('timber', w + fr * 2, fr, 0.10, 0, o.y1 + fr * 0.5, -0.03);
    B.box('timber', fr, h, 0.10, -(w + fr) * 0.5, cy, -0.03);
    B.box('timber', fr, h, 0.10, (w + fr) * 0.5, cy, -0.03);
    B.box('timber', w, 0.045, 0.045, 0, cy, -0.06);
    B.box('timber', 0.045, h, 0.045, 0, cy, -0.06);
    B.tint = null;
    // the carved surround an izba always has - it is the level's one piece of
    // deliberate ornament and it is what stops the gable reading as a shed end
    B.tint = grey(0.94);
    B.box('timber_dark', w + 0.46, 0.13, 0.055, 0, o.y1 + 0.19, -0.08);
    for (var t = -1; t <= 1; t += 2) {
      B.add('timber_dark', box(0.34, 0.10, 0.05),
        makeM(t * (w * 0.5 + 0.10), o.y1 + 0.30, -0.08, 0, 0, t * 0.55));
    }
    B.box('timber_dark', w + 0.30, 0.10, 0.05, 0, o.y0 - 0.11, -0.08);
    B.tint = null;
    // glazing, or a lit pane
    var lit = S.lit && rng.next() < 0.62;
    if (lit) {
      B.add('glass_lit', quad(w - 0.06, h - 0.06), makeM(0, cy, -0.055, 0, Math.PI, 0));
      L._litPanes.push({ house: S, y: cy });
    } else if (rng.next() < 0.22) {
      // boarded up
      B.tint = grey(0.86);
      for (var bI = 0; bI < 3; bI++) {
        B.add('timber_dark', box(w + 0.16, 0.16, 0.04),
          makeM(0, o.y0 + 0.22 + bI * 0.42, -0.09, 0, 0, rng.range(-0.09, 0.09)));
      }
      B.tint = null;
    } else {
      B.add('glazing', quad(w - 0.06, h - 0.06), makeM(0, cy, -0.05, 0, Math.PI, 0));
      // frost creeping up the inside of the pane
      B.tint = grey(1.1);
      B.add('ice', quad(w - 0.10, (h - 0.06) * 0.42), makeM(0, o.y0 + h * 0.22, -0.062, 0, Math.PI, 0));
      B.tint = null;
    }
    // shutters, one of them swinging
    var open = rng.next() < 0.55;
    for (var sh = -1; sh <= 1; sh += 2) {
      var ang = open && sh > 0 ? rng.range(1.1, 1.9) : rng.range(0.05, 0.22);
      B.pushXYZ(sh * (w * 0.5 + 0.06), cy, -0.10, 0, 0, 0);
      B.tint = grey(rng.range(0.72, 0.92));
      B.add('timber_dark', box(w * 0.52, h - 0.02, 0.05),
        makeM(sh * w * 0.26 * Math.cos(ang), 0, -w * 0.26 * Math.sin(ang), 0, sh * ang, 0));
      B.tint = null;
      B.pop();
    }
    // snow lying on the sill and a small drift against the boards below
    B.tint = grey(1.02);
    B.box('snow', w + 0.36, 0.09, 0.13, 0, o.y0 - 0.045, -0.10);
    B.tint = null;
  }

  function buildDoor(B, rng, o) {
    var w = o.w, h = o.y1 - o.y0;
    B.tint = grey(1.02);
    B.box('timber', w + 0.16, 0.10, 0.13, 0, o.y1 + 0.05, -0.04);
    B.box('timber', 0.10, h + 0.1, 0.13, -(w + 0.10) * 0.5, o.y0 + h * 0.5, -0.04);
    B.box('timber', 0.10, h + 0.1, 0.13, (w + 0.10) * 0.5, o.y0 + h * 0.5, -0.04);
    B.tint = null;
    var ajar = rng.next() < 0.3 ? rng.range(0.25, 0.7) : 0;
    B.pushXYZ(-w * 0.5, o.y0 + h * 0.5, -0.055, 0, ajar, 0);
    B.tint = grey(0.80);
    for (var i = 0; i < 4; i++) {
      B.box('timber_dark', w * 0.235, h - 0.03, 0.055, (i + 0.5) * w * 0.25, 0, 0);
    }
    // ledge and brace
    B.box('timber_dark', w - 0.04, 0.10, 0.035, w * 0.5, h * 0.30, -0.045);
    B.box('timber_dark', w - 0.04, 0.10, 0.035, w * 0.5, -h * 0.30, -0.045);
    B.add('timber_dark', box(Math.sqrt(w * w + h * h) * 0.9, 0.09, 0.032),
      makeM(w * 0.5, 0, -0.045, 0, 0, Math.atan2(h * 0.6, w)));
    B.tint = null;
    B.tint = grey(0.6);
    B.cyl('steel', 0.030, 0.030, 0.22, w * 0.86, 0.02, -0.09, Math.PI * 0.5, 0, 0, 6);
    B.tint = null;
    B.pop();
  }
  // ============================================================== MASONRY ==
  // A wall panel in the local XY plane, x in [-L/2, L/2], y in [0, H], `t`
  // thick along Z, with rectangular or round-headed openings cut out of it.
  // The core is solid so the wall is watertight; the READ comes from the
  // scatter of proud stones on the outer face and from real voussoirs over
  // every arch. A flat box with a stone texture on it is on the instant-fail
  // list and a church is the level's landmark.
  function wallPanel(B, key, L, H, t, openings, rng, opts) {
    opts = opts || {};
    openings = openings || [];
    var i, j;
    var cuts = openings.slice().sort(function (a, b) { return a.c - b.c; });
    var x = -L * 0.5;
    for (i = 0; i < cuts.length; i++) {
      var o = cuts[i];
      var a0 = o.c - o.w * 0.5, a1 = o.c + o.w * 0.5;
      if (a0 > x) B.box(key, a0 - x, H, t, (x + a0) * 0.5, H * 0.5, 0);
      var head = o.y1 + (o.arch ? o.w * 0.5 : 0);
      if (o.y0 > 0.001) B.box(key, o.w, o.y0, t, o.c, o.y0 * 0.5, 0);
      if (head < H) B.box(key, o.w, H - head, t, o.c, (head + H) * 0.5, 0);
      if (o.arch) {
        var nv = 9, r = o.w * 0.5;
        for (j = 0; j < nv; j++) {
          var ang = Math.PI * (j + 0.5) / nv;
          B.add(key, box(o.w * 0.34, o.w * 0.26, t * 1.02),
            makeM(o.c + Math.cos(ang) * r * 0.86, o.y1 + Math.sin(ang) * r * 0.86, 0,
              0, 0, ang - Math.PI * 0.5));
        }
      }
      x = a1;
    }
    if (x < L * 0.5) B.box(key, L * 0.5 - x, H, t, (x + L * 0.5) * 0.5, H * 0.5, 0);

    // proud stones on the outer face
    var n = opts.stones === undefined ? Math.round(L * H * 0.55) : opts.stones;
    for (i = 0; i < n; i++) {
      var sx = rng.range(-L * 0.5 + 0.3, L * 0.5 - 0.3);
      var sy = rng.range(0.15, H - 0.2);
      var blocked = false;
      for (j = 0; j < cuts.length; j++) {
        var c = cuts[j];
        if (Math.abs(sx - c.c) < c.w * 0.62 && sy > c.y0 - 0.25 &&
          sy < c.y1 + c.w * 0.62 + 0.25) { blocked = true; break; }
      }
      if (blocked) continue;
      B.tint = grey(rng.range(0.74, 1.10));
      B.boxR(key, rng.range(0.26, 0.62), rng.range(0.20, 0.38), rng.range(0.05, 0.12),
        sx, sy, -t * 0.5 - 0.04, rng.range(-0.08, 0.08), 0, rng.range(-0.16, 0.16));
      B.tint = null;
    }
    // a plinth course and a string course, both snow-catching
    B.tint = grey(0.88);
    B.box(key, L + 0.24, 0.42, t + 0.20, 0, 0.21, 0);
    B.tint = null;
    if (opts.string) {
      B.tint = grey(0.94);
      B.box(key, L + 0.10, 0.16, t + 0.14, 0, opts.string, 0);
      B.tint = null;
      B.tint = grey(1.02);
      B.box('snow', L + 0.10, 0.07, t + 0.20, 0, opts.string + 0.11, -0.02);
      B.tint = null;
    }
  }

  // ================================================================ CHURCH ==
  function buildChurch(L, B, rng) {
    var C = L.plan.church;
    var hw = C.naveHW, hz = C.naveHZ, H = C.wall;
    var run = hw + 0.55, rise = C.ridge - C.wall;
    var i;
    B.pushXYZ(C.x, C.y, C.z, 0, C.yaw, 0);
    B.tint = grey(0.98);

    // ---- nave walls --------------------------------------------------------
    var flank = [
      { c: -3.4, w: 1.15, y0: 2.30, y1: 4.05, arch: 1 },
      { c: 0.4, w: 1.15, y0: 2.30, y1: 4.05, arch: 1 },
      { c: 4.2, w: 1.15, y0: 2.30, y1: 4.05, arch: 1 }
    ];
    B.pushXYZ(-hw, 0, 0, 0, -Math.PI * 0.5, 0);
    wallPanel(B, 'stonework', hz * 2, H, 0.72, flank, rng, { string: H - 0.55 });
    B.pop();
    B.pushXYZ(hw, 0, 0, 0, Math.PI * 0.5, 0);
    wallPanel(B, 'stonework', hz * 2, H, 0.72, flank, rng, { string: H - 0.55 });
    B.pop();
    // north (apse) end
    B.pushXYZ(0, 0, -hz, 0, Math.PI, 0);
    wallPanel(B, 'stonework', hw * 2, H, 0.72,
      [{ c: 0, w: 1.30, y0: 2.5, y1: 4.3, arch: 1 }], rng, { string: H - 0.55 });
    B.pop();
    // south end, mostly taken up by the tower arch
    B.pushXYZ(0, 0, hz, 0, 0, 0);
    wallPanel(B, 'stonework', hw * 2, H, 0.72,
      [{ c: 0, w: 2.30, y0: 3.4, y1: 5.0, arch: 1 }], rng, {});
    B.pop();

    // ---- lopatki : the flat pilaster strips a Russian church divides its ----
    // ---- facade with. This is the macro read at 20-40 m; the stone texture --
    // ---- has mipped to nothing by then and a wall with no bays is a box. ----
    var bayZ = [-6.2, -1.5, 2.3, 6.4];
    for (var ls = -1; ls <= 1; ls += 2) {
      for (i = 0; i < bayZ.length; i++) {
        B.tint = grey(rng.range(0.86, 1.02));
        B.box('stonework', 0.30, H - 0.30, 0.78, ls * (hw + 0.12), (H - 0.30) * 0.5 + 0.10, bayZ[i]);
        B.box('stonework', 0.38, 0.26, 0.92, ls * (hw + 0.16), H - 0.20, bayZ[i]);
        B.tint = null;
        B.tint = grey(1.02);
        B.box('snow', 0.44, 0.09, 0.98, ls * (hw + 0.16), H - 0.04, bayZ[i]);
        B.tint = null;
      }
      // a stepped cornice with two returns, running the whole flank
      B.tint = grey(0.92);
      B.box('stonework', 0.24, 0.22, hz * 2 + 0.5, ls * (hw + 0.10), H - 0.62, 0);
      B.box('stonework', 0.36, 0.20, hz * 2 + 0.5, ls * (hw + 0.16), H - 0.40, 0);
      B.box('stonework', 0.50, 0.18, hz * 2 + 0.5, ls * (hw + 0.23), H - 0.20, 0);
      B.tint = null;
      B.tint = grey(1.02);
      B.box('snow', 0.56, 0.08, hz * 2 + 0.5, ls * (hw + 0.23), H - 0.07, 0);
      B.tint = null;
    }

    // ---- the apse ----------------------------------------------------------
    var ap = [];
    for (i = 0; i <= 7; i++) {
      var a = Math.PI * (0.5 + i / 7);
      // i = 0 is the panel that sits square across the nave axis 2.7 m in front
      // of the icon screen, and it is what actually closed the interior
      // framing's one-point perspective: a flat pale plane at the vanishing
      // point, measured at 0.0094 gradient energy. The sanctuary is open to the
      // nave, as it should be, and the screen in front of it does the closing.
      if (i === 0) continue;
      B.add('stonework', box(C.apseR * 0.92, H, 0.66),
        makeM(Math.cos(a) * C.apseR * 0.92, H * 0.5, -hz + Math.sin(a) * C.apseR * 0.92 - 0.6,
          0, -a + Math.PI * 0.5, 0));
      // a plinth course and a string course round the apse, both snow-catching
      B.tint = grey(0.88);
      B.add('stonework', box(C.apseR * 0.95, 0.40, 0.84),
        makeM(Math.cos(a) * (C.apseR * 0.94), 0.20,
          -hz + Math.sin(a) * (C.apseR * 0.94) - 0.6, 0, -a + Math.PI * 0.5, 0));
      B.add('stonework', box(C.apseR * 0.95, 0.18, 0.80),
        makeM(Math.cos(a) * (C.apseR * 0.94), H - 0.85,
          -hz + Math.sin(a) * (C.apseR * 0.94) - 0.6, 0, -a + Math.PI * 0.5, 0));
      B.tint = null;
      ap.push(a);
    }
    // conical roof over the apse, with its own snow. The metal is deliberately
    // DARK: a pale roof under a pale snow load is one grey plane, and the whole
    // point of a 30 cm load is the value step between it and what it lies on.
    B.tint = grey(0.54);
    B.add('tin', revolve([[C.apseR + 0.35, H], [C.apseR * 0.62, H + 1.5], [0.12, H + 2.5]], 14),
      makeM(0, 0, -hz - 0.6));
    B.tint = null;
    B.tint = grey(1.03);
    B.add('snow', revolve([[C.apseR + 0.58, H - 0.02], [C.apseR + 0.40, H + 0.22],
      [C.apseR * 0.60, H + 1.66], [0.10, H + 2.66]], 14),
      makeM(0, 0, -hz - 0.6));
    B.tint = null;

    // ---- nave roof, with the shell hole ------------------------------------
    // The hole is on the WEST slope at the apse end rather than the east slope
    // amidships, and that is a composition decision, not an arbitrary one: from
    // the interior standpoint by the tower arch the old position sat 41 degrees
    // above the eye, i.e. above the top of any frame that also contained the
    // floor. From here it is 27 degrees up and 12.6 m away, so the hole, the
    // daylight coming through it and the cone of drifted snow underneath it are
    // all in one picture and the interior snow is explained rather than assumed.
    var holeZ = -4.40, holeX = -3.55, holeR = 2.10;
    for (var psgn = -1; psgn <= 1; psgn += 2) {
      var n = 22;
      for (i = 0; i < n; i++) {
        var z0 = M.lerp(-hz - 0.3, hz + 0.3, i / n);
        var z1 = M.lerp(-hz - 0.3, hz + 0.3, (i + 1) / n);
        var zc = (z0 + z1) * 0.5;
        if (psgn < 0 && Math.abs(zc - holeZ) < holeR * 1.05) continue;
        B.pushXYZ(0, C.wall + rise, 0, 0, 0, 0);
        B.tint = grey(rng.range(0.46, 0.62));
        boardedSlope(B, 'tin', z0, z1, run, rise, 0.09, rng, psgn);
        B.tint = null;
        B.pop();
      }
      B.pushXYZ(0, C.wall + rise, 0, 0, psgn > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0);
      var za = -(hz + 0.3), zb = hz + 0.3;
      if (psgn < 0) {
        // on this side local x runs WITH world z, so the gap is at holeZ
        roofSnowRun(B, 'snow', za, holeZ - holeR * 1.2, run + 0.05, rise, 0.46, rng, true);
        roofSnowRun(B, 'snow', holeZ + holeR * 1.2, zb, run + 0.05, rise, 0.46, rng, true);
      } else {
        roofSnowRun(B, 'snow', za, zb, run + 0.05, rise, 0.48, rng, true);
      }
      B.pop();
    }
    // torn rafters around the hole
    B.tint = grey(0.42);
    for (i = 0; i < 10; i++) {
      var ra = rng.range(0, Math.PI * 2);
      var rr = holeR * rng.range(0.75, 1.15);
      var rz2 = holeZ + Math.sin(ra) * rr;
      var rx2 = holeX + Math.cos(ra) * rr * 0.6;
      var ry2 = C.wall + rise - Math.abs(rx2) * (rise / run);
      B.strut('timber_dark', rx2, ry2, rz2, rx2 + rng.range(-0.5, 0.5),
        ry2 + rng.range(-0.7, 0.25), rz2 + rng.range(-0.6, 0.6), 0.10, 0.09);
    }
    B.tint = null;
    // gable copings
    for (var gs = -1; gs <= 1; gs += 2) {
      for (var gg = 0; gg < 2; gg++) {
        B.add('stonework', box(Math.sqrt(run * run + rise * rise), 0.30, 0.34),
          makeM(gs * run * 0.5, C.wall + rise * 0.5, (gg ? 1 : -1) * (hz + 0.18),
            0, 0, gs * -Math.atan2(rise, run)));
      }
    }

    // ---- the bell tower : the level's landmark -----------------------------
    var tz = C.towerZ, thw = C.towerHW, tTop = C.towerTop;
    B.pushXYZ(0, 0, tz, 0, 0, 0);
    var belfry = [{ c: 0, w: 1.9, y0: tTop - 3.5, y1: tTop - 1.5, arch: 1 }];
    var doorOp = [{ c: 0, w: 1.6, y0: 0, y1: 2.5, arch: 1 }];
    B.pushXYZ(0, 0, thw, 0, 0, 0);
    wallPanel(B, 'stonework', thw * 2, tTop, 0.70, doorOp.concat(belfry), rng, { string: 5.6 });
    B.pop();
    B.pushXYZ(0, 0, -thw, 0, Math.PI, 0);
    wallPanel(B, 'stonework', thw * 2, tTop, 0.70, belfry, rng, { string: 5.6 });
    B.pop();
    B.pushXYZ(-thw, 0, 0, 0, -Math.PI * 0.5, 0);
    wallPanel(B, 'stonework', thw * 2, tTop, 0.70, belfry, rng, { string: 5.6 });
    B.pop();
    B.pushXYZ(thw, 0, 0, 0, Math.PI * 0.5, 0);
    wallPanel(B, 'stonework', thw * 2, tTop, 0.70, belfry, rng, { string: 5.6 });
    B.pop();

    // ---- what makes it a landmark instead of a grey box --------------------
    // At the range hero3 and the overview photograph this from, the triplanar
    // stone map has mipped to a flat value. Everything below is macro: quoins
    // that break all four corners into alternating blocks, pilaster strips
    // running the full height between them, a stepped cornice with two returns,
    // a plinth, a boarded belfry opening on the lee face, and a spalled render
    // patch on the windward one showing the rubble core through it.
    var qc = 0.62, nQ = Math.max(4, Math.round(tTop / qc));
    for (var qi = 0; qi < nQ; qi++) {
      var qy = 0.42 + (qi + 0.5) * (tTop - 0.42) / nQ;
      var qbig = qi % 2;
      for (var qq = 0; qq < 4; qq++) {
        var qsx = (qq & 1) ? 1 : -1, qsz = (qq & 2) ? 1 : -1;
        var qlx = qbig ? 0.78 : 0.42, qlz = qbig ? 0.42 : 0.78;
        B.tint = grey(rng.range(0.78, 1.12));
        B.box('stonework', qlx, qc * 0.84, 0.22,
          qsx * (thw - qlx * 0.5 + 0.10), qy, qsz * (thw + 0.10));
        B.box('stonework', 0.22, qc * 0.84, qlz,
          qsx * (thw + 0.10), qy, qsz * (thw - qlz * 0.5 + 0.10));
        B.tint = null;
      }
    }
    // pilaster strips, two down each face, proud enough to catch a shadow
    for (var pf = 0; pf < 4; pf++) {
      var pnx = (pf === 0) ? 1 : (pf === 1 ? -1 : 0);
      var pnz = (pf === 2) ? 1 : (pf === 3 ? -1 : 0);
      for (var pk = -1; pk <= 1; pk += 2) {
        B.tint = grey(rng.range(0.82, 1.0));
        B.box('stonework', pnx ? 0.30 : 0.52, tTop - 1.0, pnz ? 0.30 : 0.52,
          pnx * (thw + 0.15) + (pnx ? 0 : pk * 1.05),
          (tTop - 1.0) * 0.5 + 0.42,
          pnz * (thw + 0.15) + (pnz ? 0 : pk * 1.05));
        B.tint = null;
      }
    }
    // Three string courses banding the shaft. Without them the face is a 6 m
    // by 13 m plane whose only marks are the corner quoins, and at 70 m that
    // measures as flat as it looks - the macro read has to be horizontal as
    // well as vertical.
    var bandY = [3.05, 6.85, 10.20];
    for (var bI = 0; bI < bandY.length; bI++) {
      B.tint = grey(rng.range(0.86, 1.02));
      B.box('stonework', thw * 2 + 0.34, 0.24, thw * 2 + 0.34, 0, bandY[bI], 0);
      B.box('stonework', thw * 2 + 0.22, 0.13, thw * 2 + 0.22, 0, bandY[bI] + 0.18, 0);
      B.tint = null;
      B.tint = grey(1.02);
      B.box('snow', thw * 2 + 0.40, 0.075, thw * 2 + 0.40, 0, bandY[bI] + 0.155, 0);
      B.tint = null;
    }
    // a boarded-over belfry opening on the lee face, and the spall opposite
    B.tint = grey(0.50);
    for (var bb = 0; bb < 5; bb++) {
      B.add('timber_dark', box(2.0, 0.22, 0.06),
        makeM(0, tTop - 3.35 + bb * 0.42, thw + 0.16, 0, 0, rng.range(-0.055, 0.055)));
    }
    B.add('timber_dark', box(0.16, 2.1, 0.05),
      makeM(0, tTop - 2.55, thw + 0.20, 0, 0, 0.62));
    B.tint = null;
    // the render has come off the windward flank: a recessed patch of rubble
    B.tint = grey(0.58);
    B.box('rock', 2.30, 3.10, 0.16, -thw - 0.05, 4.30, -0.40);
    B.tint = null;
    for (var sp = 0; sp < 26; sp++) {
      B.tint = grey(rng.range(0.52, 0.90));
      B.boxR('rock', rng.range(0.16, 0.42), rng.range(0.12, 0.26), rng.range(0.06, 0.13),
        -thw - 0.10, 4.30 + rng.gaussian(0, 0.95), -0.40 + rng.gaussian(0, 0.72),
        0, Math.PI * 0.5, rng.range(-0.30, 0.30));
      B.tint = null;
    }

    // cornice, octagonal drum, onion dome, cross. The overhang is 0.25-0.65 m,
    // not the 1.1 m the first pass gave it: at three stops of oversize the
    // stepped cornice stopped reading as a cornice and started reading as a hat.
    B.tint = grey(0.96);
    B.box('stonework', thw * 2.14, 0.26, thw * 2.14, 0, tTop + 0.13, 0);
    B.tint = null;
    B.tint = grey(0.86);
    B.box('stonework', thw * 2.28, 0.22, thw * 2.28, 0, tTop + 0.37, 0);
    B.tint = null;
    B.tint = grey(0.99);
    B.box('stonework', thw * 2.42, 0.18, thw * 2.42, 0, tTop + 0.57, 0);
    B.tint = null;
    B.tint = grey(1.02);
    B.box('snow', thw * 2.50, 0.14, thw * 2.50, 0, tTop + 0.73, 0);
    B.tint = null;
    var dY = tTop + 0.94;
    B.add('stonework', revolve([[thw * 0.95, dY], [thw * 0.95, dY + 2.15],
      [thw * 1.02, dY + 2.15], [thw * 1.02, dY + 2.45]], 8), makeM(0, 0, 0, 0, 0.39, 0));
    // the drum's own cornice and the snow ledge it holds
    B.tint = grey(0.90);
    B.box('stonework', thw * 1.68, 0.20, thw * 1.68, 0, dY + 2.55, 0);
    B.tint = null;
    B.tint = grey(1.02);
    B.box('snow', thw * 1.76, 0.11, thw * 1.76, 0, dY + 2.70, 0);
    B.tint = null;
    var oY = dY + 2.45;
    // A Russian onion is TALLER THAN IT IS WIDE and it necks in hard at the
    // base. The first profile ran 3.7 m across against 3.5 m high, which from
    // 17 m photographed as a grey saucer sitting on a box. This one is 4.6 m
    // over a 2.3 m maximum girth, waisted at the springing.
    var DOME = [
      [thw * 0.30, oY], [thw * 0.56, oY + 0.35], [thw * 0.74, oY + 1.05],
      [thw * 0.75, oY + 1.85], [thw * 0.62, oY + 2.70], [thw * 0.40, oY + 3.45],
      [thw * 0.19, oY + 4.05], [thw * 0.07, oY + 4.45], [0.04, oY + 4.60]
    ];
    B.tint = grey(0.40);
    B.add('tin', revolve(DOME, 20), makeM(0, 0, 0));
    B.tint = null;
    // RIBBING. A smooth revolve carrying a pure Lambert gradient is the one
    // thing an onion dome must not be: the standing seams between the tin
    // sheets are what give it a read at all, and they are also the only thing
    // that makes it turn in the light.
    B.tint = grey(0.30);
    for (var rbi = 0; rbi < 12; rbi++) {
      var rba = rbi / 12 * Math.PI * 2;
      var rbc = Math.cos(rba), rbs = Math.sin(rba);
      for (var rbj = 0; rbj + 2 < DOME.length; rbj++) {
        B.strut('tin',
          rbc * DOME[rbj][0] * 1.03, DOME[rbj][1], rbs * DOME[rbj][0] * 1.03,
          rbc * DOME[rbj + 1][0] * 1.03, DOME[rbj + 1][1], rbs * DOME[rbj + 1][0] * 1.03,
          0.085, 0.085);
      }
    }
    B.tint = null;
    // SNOW, plastered on the windward flank and bare on the lee. A dome half
    // covered has a silhouette; a clean one is a saucer. The direction is the
    // blizzard's own, rotated into the church's frame rather than guessed.
    var cwc = Math.cos(C.yaw), cws = Math.sin(C.yaw);
    var dwx = -WIND_X * cwc - (-WIND_Z) * cws;
    var dwz = -WIND_X * cws + (-WIND_Z) * cwc;
    var dwl = Math.sqrt(dwx * dwx + dwz * dwz) || 1;
    dwx /= dwl; dwz /= dwl;
    B.tint = grey(1.02);
    B.add('snow', revolveCap(DOME.slice(1, 8), 20, dwx, dwz, 0.010, 0.40), makeM(0, 0, 0));
    B.tint = null;
    var crossY = oY + 4.60;
    B.tint = grey(0.42);
    B.cyl('steel', 0.055, 0.070, 1.25, 0, crossY + 0.58, 0, 0, 0, 0, 6);
    B.box('steel', 0.95, 0.105, 0.105, 0, crossY + 0.86, 0);
    B.box('steel', 0.52, 0.090, 0.090, 0, crossY + 1.22, 0);
    B.add('steel', box(0.52, 0.085, 0.085), makeM(0, crossY + 0.38, 0, 0, 0, 0.42));
    B.tint = null;
    // the bell, hanging in the belfry
    B.tint = grey(0.62);
    B.add('rust', revolve([[0.05, tTop - 1.65], [0.46, tTop - 2.35],
      [0.52, tTop - 2.95], [0.46, tTop - 3.02], [0.0, tTop - 3.02]], 12), makeM(0, 0, 0));
    B.box('timber_dark', thw * 2.0, 0.16, 0.18, 0, tTop - 1.58, 0);
    B.tint = null;
    B.pop();

    // ---- interior ----------------------------------------------------------
    B.tint = new THREE.Color(0.60, 0.63, 0.70);
    B.box('stonework', hw * 2 - 0.4, 0.10, hz * 2 + 4.0, 0, 0.05, -0.8);
    B.tint = null;
    // ---- the piers ---------------------------------------------------------
    // They were 0.72 m boxes and they measured 0.0128 gradient energy against
    // 0.0297 for the stonework beside them - two smooth pale slabs in the
    // centre of the interior framing at conversational distance. An octagonal
    // shaft with chamfered arrises catches a different value on every facet,
    // and the plinth / capital / spalled render give it the three horizontal
    // events every real pier has.
    for (var pi = 0; pi < 4; pi++) {
      var px = (pi & 1) ? 2.9 : -2.9;
      var pz = (pi < 2) ? 3.2 : -3.4;
      var shaftH = H - 1.28;
      B.tint = grey(0.90);
      // stepped plinth
      B.box('stonework', 1.02, 0.20, 1.02, px, 0.10, pz);
      B.box('stonework', 0.90, 0.16, 0.90, px, 0.28, pz);
      B.box('stonework', 0.80, 0.14, 0.80, px, 0.43, pz);
      B.tint = null;
      // octagonal shaft: a square core plus four chamfer faces
      B.tint = grey(0.86);
      B.box('stonework', 0.68, shaftH, 0.68, px, 0.50 + shaftH * 0.5, pz);
      B.tint = null;
      for (var ch = 0; ch < 4; ch++) {
        var cha = Math.PI * 0.25 + ch * Math.PI * 0.5;
        B.tint = grey(0.72 + (ch % 2) * 0.22);
        B.add('stonework', box(0.30, shaftH, 0.12),
          makeM(px + Math.cos(cha) * 0.335, 0.50 + shaftH * 0.5, pz + Math.sin(cha) * 0.335,
            0, -cha + Math.PI * 0.5, 0));
        B.tint = null;
      }
      // capital band and abacus
      B.tint = grey(0.94);
      B.box('stonework', 0.80, 0.14, 0.80, px, 0.50 + shaftH + 0.07, pz);
      B.box('stonework', 0.94, 0.13, 0.94, px, 0.50 + shaftH + 0.20, pz);
      B.box('stonework', 1.06, 0.20, 1.06, px, 0.50 + shaftH + 0.36, pz);
      B.tint = null;
      // the render has come off in patches, showing the rubble core
      for (var rp = 0; rp < 9; rp++) {
        var rpa = rng.range(0, Math.PI * 2);
        B.tint = grey(rng.range(0.50, 0.82));
        B.boxR('rock', rng.range(0.10, 0.24), rng.range(0.09, 0.20), rng.range(0.05, 0.10),
          px + Math.cos(rpa) * 0.36, rng.range(0.7, shaftH * 0.9), pz + Math.sin(rpa) * 0.36,
          0, -rpa, rng.range(-0.3, 0.3));
        B.tint = null;
      }
    }

    // ---- the iconostasis ---------------------------------------------------
    // This closes a one-point perspective and it was twelve flat boards at
    // gradient energy 0.0094 - the worst possible thing to put at a vanishing
    // point. A real icon screen is the most ornate object in the building:
    // three tiers of framed panels, turned colonnettes between them, a cornice
    // over each tier, and the royal doors in the middle standing open onto the
    // dark of the sanctuary.
    // At the nave's north end rather than 0.55 m off the back wall: it has to
    // stand IN FRONT of the apse ring, because that ring's front panel is what
    // the eye lands on down the nave axis.
    var icoZ = -5.55, icoW = hw * 2 - 0.9, icoH = 4.55;
    var tierY = [0.10, 1.72, 3.06];
    var tierH = [1.52, 1.24, 1.06];
    // Near black. Measured at grey(0.34) the screen still came back as a pale
    // wall of regular blocks - it read as masonry, not as an icon screen, and
    // it gave the interior's vanishing point nothing. Stained dark wood with
    // gilt framing is both what it is and the only way it separates from the
    // stone behind it.
    B.tint = grey(0.15);
    B.box('timber_dark', icoW, icoH, 0.16, 0, icoH * 0.5, icoZ);
    B.tint = null;
    for (var tI = 0; tI < 3; tI++) {
      var nPan = tI === 0 ? 6 : (tI === 1 ? 8 : 9);
      for (i = 0; i < nPan; i++) {
        var pxx = M.lerp(-icoW * 0.5 + 0.28, icoW * 0.5 - 0.28, (i + 0.5) / nPan);
        // the royal doors: a gap in the bottom tier, dead centre
        if (tI === 0 && Math.abs(pxx) < 0.92) continue;
        var pw2 = icoW / nPan * 0.80;
        B.tint = grey(rng.range(0.20, 0.42));
        B.box('timber_dark', pw2, tierH[tI] * 0.86, 0.07, pxx,
          tierY[tI] + tierH[tI] * 0.5, icoZ - 0.11);
        B.tint = null;
        // gilt frame - four thin members proud of the panel
        B.tint = new THREE.Color(1.45, 1.28, 0.86);
        B.box('timber', pw2 + 0.09, 0.055, 0.05, pxx, tierY[tI] + 0.02, icoZ - 0.15);
        B.box('timber', pw2 + 0.09, 0.055, 0.05, pxx,
          tierY[tI] + tierH[tI] * 0.88, icoZ - 0.15);
        B.box('timber', 0.055, tierH[tI] * 0.90, 0.05, pxx - pw2 * 0.5 - 0.02,
          tierY[tI] + tierH[tI] * 0.45, icoZ - 0.15);
        B.box('timber', 0.055, tierH[tI] * 0.90, 0.05, pxx + pw2 * 0.5 + 0.02,
          tierY[tI] + tierH[tI] * 0.45, icoZ - 0.15);
        B.tint = null;
      }
      // the cornice over the tier
      B.tint = grey(0.24);
      B.box('timber_dark', icoW + 0.10, 0.13, 0.24, 0,
        tierY[tI] + tierH[tI] + 0.06, icoZ - 0.10);
      B.box('timber_dark', icoW + 0.16, 0.09, 0.30, 0,
        tierY[tI] + tierH[tI] + 0.17, icoZ - 0.13);
      B.tint = null;
    }
    // the royal doors, standing open on the dark of the sanctuary
    for (var rd = -1; rd <= 1; rd += 2) {
      B.tint = grey(0.18);
      B.add('timber_dark', box(0.82, 2.05, 0.06),
        makeM(rd * 1.26, 1.12, icoZ - 0.30, 0, rd * 0.62, 0));
      B.tint = null;
      B.tint = new THREE.Color(1.40, 1.24, 0.84);
      B.add('timber', box(0.86, 0.07, 0.045), makeM(rd * 1.26, 2.13, icoZ - 0.32, 0, rd * 0.62, 0));
      B.tint = null;
    }
    // an arched head over the doorway, and the crowning cross
    B.tint = grey(0.26);
    for (var av = 0; av < 7; av++) {
      var ava = Math.PI * (av + 0.5) / 7;
      B.add('timber_dark', box(0.36, 0.20, 0.13),
        makeM(Math.cos(ava) * 1.15, 1.62 + Math.sin(ava) * 1.05, icoZ - 0.12,
          0, 0, ava - Math.PI * 0.5));
    }
    B.tint = null;
    B.tint = new THREE.Color(1.35, 1.20, 0.82);
    B.box('timber_dark', 0.09, 0.62, 0.09, 0, icoH + 0.38, icoZ);
    B.box('timber_dark', 0.40, 0.08, 0.08, 0, icoH + 0.52, icoZ);
    B.tint = null;
    // fallen roof timbers and the drift under the hole
    B.tint = grey(0.6);
    for (i = 0; i < 8; i++) {
      B.strut('timber_dark', rng.range(-1, 4), rng.range(0.1, 1.4), holeZ + rng.range(-3, 3),
        rng.range(-4, 3), 0.12, holeZ + rng.range(-3.5, 3.5), 0.13, 0.11);
    }
    B.tint = null;
    B.tint = grey(1.03);
    B.add('snow', revolve([[2.55, 0.02], [1.75, 0.42], [0.85, 0.86], [0, 1.08]], 14),
      makeM(holeX, 0.06, holeZ));
    for (i = 0; i < 6; i++) {
      B.boxR('snow', rng.range(0.5, 1.5), rng.range(0.1, 0.3), rng.range(0.5, 1.4),
        holeX + rng.range(-3.0, 3.0), 0.10, holeZ + rng.range(-3.2, 3.2),
        rng.range(-0.1, 0.1), rng.range(0, 3), rng.range(-0.1, 0.1));
    }
    B.tint = null;
    // candles on a stand: the only warm light inside, and the reason the
    // interior framing has a subject at all
    B.tint = grey(0.5);
    B.box('rust', 0.62, 0.06, 0.42, -2.2, 0.92, 1.6);
    B.cyl('rust', 0.05, 0.07, 0.90, -2.2, 0.46, 1.6, 0, 0, 0, 6);
    B.tint = null;
    for (i = 0; i < 9; i++) {
      var cxx = -2.2 + ((i % 3) - 1) * 0.18, czz = 1.6 + (Math.floor(i / 3) - 1) * 0.14;
      B.cyl('glass_lit', 0.014, 0.016, 0.20, cxx, 1.05 + rng.range(-0.03, 0.03), czz, 0, 0, 0, 5);
    }

    B.tint = null;
    B.pop();

    // ---- colliders ---------------------------------------------------------
    var eul = new THREE.Euler(0, C.yaw, 0);
    function wallCol(lx, lz, ex, ez) {
      var wx = C.x + lx * Math.cos(C.yaw) + lz * Math.sin(C.yaw);
      var wz = C.z - lx * Math.sin(C.yaw) + lz * Math.cos(C.yaw);
      L.addCollider(wx, C.y + H * 0.5, wz, ex, H * 0.5, ez, 'stone', false, eul);
    }
    wallCol(-hw, 0, 0.42, hz);
    wallCol(hw, 0, 0.42, hz);
    wallCol(0, -hz, hw, 0.42);
    L.addCollider(C.x + Math.sin(C.yaw) * tz, C.y + tTop * 0.5, C.z + Math.cos(C.yaw) * tz,
      thw + 0.3, tTop * 0.5, thw + 0.3, 'stone', false, eul);
    L.addCollider(C.x, C.y + 0.05, C.z - 0.8, hw, 0.30, hz + 2.0, 'stone', true, eul);

    var toWorld = function (lx, ly, lz) {
      return new THREE.Vector3(
        C.x + lx * Math.cos(C.yaw) + lz * Math.sin(C.yaw), C.y + ly,
        C.z - lx * Math.sin(C.yaw) + lz * Math.cos(C.yaw));
    };
    return {
      centre: new THREE.Vector3(C.x, C.y, C.z), yaw: C.yaw,
      nave: { hw: hw, hz: hz }, floorY: C.y + 0.10,
      eave: C.y + H, ridge: C.y + C.ridge,
      tower: {
        centre: toWorld(0, 0, tz), half: thw, cornice: C.y + tTop,
        dome: C.y + oY, apex: C.y + crossY + 1.1
      },
      door: toWorld(0, 0, tz + thw + 0.9),
      holeAbove: toWorld(holeX, C.wall + rise - Math.abs(holeX) * (rise / run) + 0.4, holeZ),
      holeFloor: toWorld(holeX, 0.12, holeZ),
      apse: toWorld(0, 0, -hz - C.apseR * 0.6),
      candles: toWorld(-2.2, 1.05, 1.6),
      // RAKED OFF THE CENTRELINE. The old mark stood on the nave axis looking
      // straight down it, which made a corridor of a space and put the only
      // subject (the candle stand) hard against the left margin. From here the
      // near pier frames the right edge at 2.5 m, the roof hole and the drift
      // cone under it stack in the left at 11 m, the candle stand is properly
      // in shot at 30 degrees left, and the iconostasis closes the frame just
      // right of centre instead of dead on it.
      //
      // z = 5.40, not 6.40: the tower's own walls start at local z = 6.3, so
      // the first attempt at this mark stood 0.2 m inside the tower's
      // south-east corner and photographed the inside of a pier.
      interiorEye: toWorld(1.60, 1.64, 5.40),
      interiorTarget: toWorld(-1.40, 3.60, -6.00)
    };
  }
  // ================================================================= TRUCK ==
  // A 6x6 military lorry. Local frame: +Z is forward, origin on the ground
  // between the axles. The convoy is hero1's whole middle ground, so this is
  // modelled rather than boxed: real wheels with tread blocks, a bonnet and
  // grille, a cab with glazing and mirrors, a chassis you can see under, hoops
  // and a canvas tilt with sag between them, and a snow load on top of all of
  // it. `kind` is 'tilt' | 'open' | 'burnt'.
  function buildTruck(L, B, rng, S) {
    var burnt = S.kind === 'burnt';
    var body = burnt ? 'rust' : 'truck_paint';
    var bodyTint = burnt ? grey(0.30) : grey(rng.range(0.88, 1.08));
    var i, j;
    B.pushXYZ(S.x, S.y, S.z, 0, S.yaw, 0);

    // ---- wheels ------------------------------------------------------------
    var axZ = [2.35, -1.30, -2.62];
    for (i = 0; i < axZ.length; i++) {
      for (var sgn = -1; sgn <= 1; sgn += 2) {
        var wx = sgn * 1.02, wz = axZ[i];
        B.tint = grey(burnt ? 0.35 : 0.9);
        B.cyl('rubber', 0.62, 0.62, 0.38, wx, 0.62, wz, 0, 0, Math.PI * 0.5, 14);
        // tread blocks: a tyre with a smooth silhouette is a black disc
        for (j = 0; j < 14; j++) {
          var ta = j / 14 * Math.PI * 2 + i * 0.3;
          B.add('rubber', box(0.16, 0.11, 0.40),
            makeM(wx, 0.62 + Math.sin(ta) * 0.615, wz + Math.cos(ta) * 0.615,
              -ta + Math.PI * 0.5, Math.PI * 0.5, 0));
        }
        B.tint = null;
        B.tint = grey(burnt ? 0.4 : 0.75);
        B.cyl('steel', 0.31, 0.31, 0.40, wx, 0.62, wz, 0, 0, Math.PI * 0.5, 10);
        B.tint = null;
        // snow packed into the arch behind each wheel
        if (!burnt) {
          B.tint = grey(1.0);
          B.box('snow', 0.30, 0.34, 0.62, sgn * 1.04, 0.20, wz, 0.02);
          B.tint = null;
        }
      }
      // axle + differential
      B.tint = grey(0.45);
      B.cyl('rust', 0.09, 0.09, 2.0, 0, 0.62, axZ[i], 0, 0, Math.PI * 0.5, 7);
      B.box('rust', 0.42, 0.42, 0.5, 0, 0.62, axZ[i]);
      B.tint = null;
    }

    // ---- chassis -----------------------------------------------------------
    B.tint = grey(0.42);
    for (var cs = -1; cs <= 1; cs += 2) {
      B.box('rust', 0.16, 0.24, 6.9, cs * 0.44, 0.92, -0.25);
    }
    for (i = 0; i < 5; i++) {
      B.box('rust', 1.0, 0.14, 0.14, 0, 0.92, -3.3 + i * 1.5);
    }
    B.cyl('rust', 0.26, 0.26, 1.1, -0.95, 0.95, 0.0, 0, 0, Math.PI * 0.5, 10);  // fuel tank
    B.tint = null;

    // ---- bonnet, grille, wings ---------------------------------------------
    B.tint = bodyTint;
    B.box(body, 1.90, 0.86, 1.30, 0, 1.52, 2.62);
    B.box(body, 1.94, 0.20, 0.30, 0, 1.98, 2.00);
    for (var ws = -1; ws <= 1; ws += 2) {
      B.boxR(body, 0.34, 0.16, 1.30, ws * 1.06, 1.42, 2.40, 0, 0, ws * 0.22);
      B.boxR(body, 0.30, 0.55, 0.18, ws * 1.06, 1.16, 1.82, 0.3, 0, 0);
    }
    B.box(body, 2.20, 0.24, 0.24, 0, 0.86, 3.30);        // bumper
    B.tint = null;
    B.tint = grey(0.30);
    B.box('rust', 1.44, 0.72, 0.10, 0, 1.50, 3.24);      // grille frame
    for (i = 0; i < 8; i++) {
      B.box('rust', 1.32, 0.045, 0.07, 0, 1.20 + i * 0.085, 3.28);
    }
    B.tint = null;
    // headlights
    for (var hs = -1; hs <= 1; hs += 2) {
      B.tint = grey(0.6);
      B.cyl('steel', 0.20, 0.22, 0.16, hs * 0.86, 1.62, 3.20, Math.PI * 0.5, 0, 0, 10);
      B.tint = null;
      if (S.lights && !burnt) {
        B.add('glass_lit', quad(0.34, 0.34), makeM(hs * 0.86, 1.62, 3.30));
      } else {
        B.tint = grey(0.8);
        B.add('glazing', quad(0.34, 0.34), makeM(hs * 0.86, 1.62, 3.30));
        B.tint = null;
      }
    }

    // ---- cab ---------------------------------------------------------------
    B.tint = bodyTint;
    B.box(body, 2.30, 1.42, 1.55, 0, 1.86, 1.18);
    B.box(body, 2.34, 0.12, 1.60, 0, 2.60, 1.18);          // roof
    B.tint = null;
    if (!burnt) {
      B.tint = grey(0.9);
      B.add('glazing', quad(1.72, 0.78), makeM(0, 2.16, 1.98, 0.16, 0, 0));
      for (var gs2 = -1; gs2 <= 1; gs2 += 2) {
        B.add('glazing', quad(0.86, 0.70), makeM(gs2 * 1.17, 2.14, 1.18, 0, gs2 * Math.PI * 0.5, 0));
      }
      B.tint = null;
      // snow banked on the windscreen and the wiper arc swept clear
      B.tint = grey(1.0);
      B.box('snow', 1.76, 0.10, 0.16, 0, 1.78, 2.03, 0.02);
      B.tint = null;
    }
    B.tint = grey(0.35);
    for (var ms = -1; ms <= 1; ms += 2) {
      B.rod('steel', ms * 1.16, 2.30, 1.85, ms * 1.52, 2.42, 1.92, 0.022, 5);
      B.box('steel', 0.10, 0.34, 0.20, ms * 1.55, 2.36, 1.94);
    }
    B.cyl('rust', 0.055, 0.055, 1.85, 1.10, 3.10, 0.62, 0, 0, 0, 7);   // exhaust stack
    B.box('rust', 0.16, 0.05, 0.16, 1.10, 4.05, 0.62);
    B.tint = null;
    // roof snow
    B.tint = grey(1.02);
    B.box('snow', 2.32, 0.14, 1.58, 0, 2.73, 1.18, 0.03);
    B.box('snow', 1.92, 0.11, 1.28, 0, 2.02, 2.62, 0.03);
    B.tint = null;

    // ---- cargo bed + tilt ---------------------------------------------------
    B.tint = bodyTint;
    B.box(body, 2.36, 0.14, 4.10, 0, 1.30, -1.55);
    for (var bs = -1; bs <= 1; bs += 2) {
      for (i = 0; i < 3; i++) {
        B.box(body, 0.09, 0.26, 4.10, bs * 1.16, 1.50 + i * 0.29, -1.55);
      }
    }
    B.box(body, 2.30, 0.80, 0.10, 0, 1.75, -3.62);
    B.tint = null;
    var hoopY = 2.92, hoopN = 5;
    B.tint = grey(burnt ? 0.32 : 0.55);
    for (i = 0; i < hoopN; i++) {
      var hz2 = -3.50 + i * 1.0;
      var bendF = burnt ? (i === 2 ? 0.55 : 1.0) : 1.0;
      var prof = [];
      for (j = 0; j <= 8; j++) {
        var pa = Math.PI * j / 8;
        prof.push([Math.cos(pa) * 1.14, 1.62 + Math.sin(pa) * (hoopY - 1.62) * bendF]);
      }
      for (j = 0; j + 1 < prof.length; j++) {
        B.rod('steel', prof[j][0], prof[j][1], hz2, prof[j + 1][0], prof[j + 1][1], hz2, 0.035, 5);
      }
    }
    B.tint = null;
    if (S.kind === 'tilt') {
      B.tint = grey(rng.range(0.82, 1.0));
      var segs = 14;
      for (i = 0; i < segs; i++) {
        var a0 = Math.PI * i / segs, a1 = Math.PI * (i + 1) / segs;
        var x0 = Math.cos(a0) * 1.17, y0 = 1.62 + Math.sin(a0) * (hoopY - 1.62);
        var x1 = Math.cos(a1) * 1.17, y1 = 1.62 + Math.sin(a1) * (hoopY - 1.62);
        var mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5;
        var seglen = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
        B.add('canvas', box(seglen, 0.035, 4.9),
          makeM(mx, my, -1.55, 0, 0, Math.atan2(y1 - y0, x1 - x0)));
      }
      // end flaps, one of them loose
      B.add('canvas', box(2.30, 1.28, 0.04), makeM(0, 2.30, -3.98));
      B.add('canvas', box(2.30, 1.28, 0.04), makeM(0, 2.30, 0.92));
      B.tint = null;
      // the snow load: a full shell over the tilt, which is the biggest and
      // brightest shape any truck in the convoy contributes to a framing
      B.tint = grey(1.02);
      for (i = 0; i < segs; i++) {
        var b0 = Math.PI * i / segs, b1 = Math.PI * (i + 1) / segs;
        if (Math.cos(b0) > 0.72 || Math.cos(b1) < -0.72) continue;
        var sx0 = Math.cos(b0) * 1.24, sy0 = 1.62 + Math.sin(b0) * (hoopY - 1.50);
        var sx1 = Math.cos(b1) * 1.24, sy1 = 1.62 + Math.sin(b1) * (hoopY - 1.50);
        var smx = (sx0 + sx1) * 0.5, smy = (sy0 + sy1) * 0.5;
        var sl = Math.sqrt((sx1 - sx0) * (sx1 - sx0) + (sy1 - sy0) * (sy1 - sy0));
        B.add('snow', box(sl * 1.05, 0.16, 4.98),
          makeM(smx, smy, -1.55, 0, 0, Math.atan2(sy1 - sy0, sx1 - sx0)));
      }
      B.tint = null;
    } else if (S.kind === 'open') {
      B.tint = grey(1.02);
      B.box('snow', 2.24, 0.34, 4.0, 0, 1.52, -1.55, 0.04);
      B.tint = null;
    }
    if (burnt) {
      B.tint = grey(0.25);
      for (i = 0; i < 5; i++) {
        B.boxR('rust', rng.range(0.3, 0.9), 0.04, rng.range(0.4, 1.1),
          rng.range(-1, 1), 1.40, rng.range(-3.2, 0.2), rng.range(-0.2, 0.2),
          rng.range(0, 3), rng.range(-0.2, 0.2));
      }
      B.tint = null;
    }
    B.pop();

    var eul = new THREE.Euler(0, S.yaw, 0);
    L.addCollider(S.x, S.y + 1.35, S.z - 0.3, 1.25, 1.35, 3.7, 'metal', false, eul);
    var fw = function (lx, ly, lz) {
      return new THREE.Vector3(S.x + lx * Math.cos(S.yaw) + lz * Math.sin(S.yaw), S.y + ly,
        S.z - lx * Math.sin(S.yaw) + lz * Math.cos(S.yaw));
    };
    // six wheels standing in packed snow. A lorry whose tyres meet the
    // carriageway on a hard line is a model of a lorry sitting on a photograph
    // of snow, and it is the largest object in the hero framing.
    for (i = 0; i < axZ.length; i++) {
      for (var ows = -1; ows <= 1; ows += 2) {
        var wp = fw(ows * 1.02, 0, axZ[i]);
        var wy = L.sampleGround(wp.x, wp.z);
        snowCollar(B, wp.x, Math.min(wy, S.y) - 0.02, wp.z, 0.62, 0.15,
          (wp.x * 11 + wp.z * 5) | 0);
        L._occluders.push({ x: wp.x, z: wp.z, r: 0.62 });
      }
    }
    return {
      name: S.name, centre: new THREE.Vector3(S.x, S.y, S.z), yaw: S.yaw, kind: S.kind,
      tailgate: fw(0, 1.4, -3.9), bonnet: fw(0, 1.95, 2.7), cabTop: fw(0, 2.66, 1.18),
      headlightL: fw(-0.86, 1.62, 3.28), headlightR: fw(0.86, 1.62, 3.28),
      aim: fw(0, 0.6, 22.0), lights: !!S.lights
    };
  }

  // ================================================================= WRECK ==
  // A burnt-out lorry cab, half buried, shoved off the carriageway by the
  // plough. It is modelled as a FRAME rather than a body - four cab posts, a
  // peeled header, an open windscreen aperture, bare chassis rails - because
  // the whole reason it is here is silhouette: a shape with holes in it,
  // rendered near black, at seven metres, in a frame that otherwise has no
  // value below 0.25 anywhere except the viewmodel.
  function buildWreck(L, B, rng) {
    var W = L.plan.wreck;
    if (!W) return null;
    var gy = L.sampleGround(W.x, W.z);
    var i;

    // Built by buildTruck, deliberately. The first version was bespoke - a cab
    // skeleton of posts and panels - and at nine metres a frame of 0.12 m
    // members photographs as a heap of black slabs at odd angles rather than as
    // a vehicle. The convoy's lorries already read as lorries in every framing,
    // so the wreck is one of THOSE, burnt, dropped 0.42 m into the drift and
    // taken further down toward charcoal by the builder's base tint.
    var old = B.base;
    B.base = new THREE.Color(0.44, 0.415, 0.405);
    buildTruck(L, B, rng, {
      name: 'wreck', x: W.x, y: gy - 0.42, z: W.z, yaw: W.yaw,
      kind: 'burnt', lights: false, idx: 90
    });
    B.base = old;

    // the fire took the tilt and most of the bed; what is left is scrap in it
    B.pushXYZ(W.x, gy - 0.42, W.z, 0, W.yaw, 0);
    B.tint = grey(0.14);
    for (i = 0; i < 12; i++) {
      B.boxR('rust', rng.range(0.25, 0.85), 0.035, rng.range(0.30, 1.00),
        rng.range(-0.95, 0.95), 1.42, rng.range(-3.3, -0.3),
        rng.range(-0.30, 0.30), rng.range(0, 3), rng.range(-0.30, 0.30));
    }
    B.tint = null;
    B.tint = grey(1.02);
    // snow driven into the open bed and lying along the cab roof
    for (i = 0; i < 6; i++) {
      B.boxR('snow', rng.range(0.7, 1.7), rng.range(0.16, 0.40), rng.range(0.6, 1.6),
        rng.range(-0.9, 0.9), 1.46, rng.range(-3.4, -0.5),
        rng.range(-0.12, 0.12), rng.range(0, 3), rng.range(-0.12, 0.12));
    }
    B.tint = null;
    B.pop();

    // the drift the level's own height field already banks against it, plus a
    // modelled collar so it is not sitting on a plane
    snowCollar(B, W.x + WIND_X * 1.9, gy - 0.05, W.z + WIND_Z * 1.9, 1.75, 0.32, 771);
    snowCollar(B, W.x - WIND_X * 1.7, gy - 0.05, W.z - WIND_Z * 1.7, 1.35, 0.18, 773);
    L._occluders.push({ x: W.x, z: W.z, r: 2.2 });

    return {
      centre: new THREE.Vector3(W.x, gy, W.z), yaw: W.yaw,
      cabTop: new THREE.Vector3(W.x, gy + 2.2, W.z)
    };
  }

  // ================================================================== BARN ==
  function buildBarn(L, B, rng) {
    var S = L.plan.barn;
    var hw = S.w * 0.5, hd = S.d * 0.5;
    var rise = S.ridge - S.eave, run = hw + 0.5;
    var i;
    B.pushXYZ(S.x, S.y, S.z, 0, S.yaw, 0);
    B.tint = grey(0.72);
    // vertical board-and-batten, gappy: light through the gaps is what makes a
    // barn read as a barn rather than as a shed-shaped box
    for (var face = 0; face < 4; face++) {
      var alongX = (face < 2);
      var len = alongX ? S.w : S.d;
      var n = Math.round(len / 0.34);
      for (i = 0; i < n; i++) {
        var t = (i + 0.5) / n;
        var pos = M.lerp(-len * 0.5, len * 0.5, t);
        var skip = (face === 0 && Math.abs(pos) < 1.9);      // the big doorway
        if (skip) continue;
        var jw = 0.34 * rng.range(0.80, 0.98);
        var lean = rng.range(-0.02, 0.02);
        B.tint = grey(rng.range(0.60, 0.90));
        if (alongX) {
          B.add('timber_dark', box(jw, S.eave, 0.07),
            makeM(pos, S.eave * 0.5, (face ? 1 : -1) * hd, 0, 0, lean));
        } else {
          B.add('timber_dark', box(0.07, S.eave, jw),
            makeM((face === 2 ? -1 : 1) * hw, S.eave * 0.5, pos, 0, 0, lean));
        }
      }
    }
    B.tint = null;
    // gable infill
    for (var gf = 0; gf < 2; gf++) {
      var nz = 10;
      for (i = 0; i < nz; i++) {
        var gx = M.lerp(-hw, hw, (i + 0.5) / nz);
        var gh = rise * (1 - Math.abs(gx) / hw);
        if (gh < 0.06) continue;
        B.tint = grey(rng.range(0.6, 0.9));
        B.box('timber_dark', hw * 2 / nz * 0.92, gh, 0.07, gx, S.eave + gh * 0.5,
          (gf ? 1 : -1) * hd);
      }
    }
    B.tint = null;
    // corrugated roof + snow
    for (var ps = -1; ps <= 1; ps += 2) {
      B.pushXYZ(0, S.ridge, 0, 0, 0, 0);
      B.tint = grey(0.86);
      boardedSlope(B, 'tin', -hd - 0.3, hd + 0.3, run, rise, 0.08, rng, ps);
      B.tint = null;
      B.pop();
      B.pushXYZ(0, S.ridge, 0, 0, ps > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0);
      roofSnowRun(B, 'snow', -(hd + 0.3), hd + 0.3, run + 0.05, rise, 0.32, rng, true);
      B.pop();
    }
    // the big sliding door, half open on its track
    B.tint = grey(0.55);
    B.box('timber_dark', 4.4, 0.14, 0.12, 0, 3.9, -hd - 0.14);
    B.tint = null;
    B.tint = grey(0.68);
    for (i = 0; i < 7; i++) {
      B.box('timber_dark', 0.30, 3.7, 0.06, -1.7 + i * 0.32 - 1.5, 1.85, -hd - 0.22);
    }
    B.tint = null;
    B.pop();
    var eul = new THREE.Euler(0, S.yaw, 0);
    L.addCollider(S.x, S.y + S.eave * 0.5, S.z, hw, S.eave * 0.5, hd, 'wood', false, eul);
    return { centre: new THREE.Vector3(S.x, S.y, S.z), yaw: S.yaw, w: S.w, d: S.d,
      eave: S.y + S.eave, ridge: S.y + S.ridge,
      doorOuter: new THREE.Vector3(S.x - Math.sin(S.yaw) * (hd + 1.4), S.y,
        S.z - Math.cos(S.yaw) * (hd + 1.4)) };
  }
  // ====================================================== COLLAPSED BRIDGE ==
  // The road ends here. A three-span girder bridge over the gorge with the
  // centre span gone: the near half is cantilevered over 6.4 m of nothing with
  // its slab torn off and its rebar bent down, and the span itself is lying in
  // the bottom half-buried. It is hero2, so the composition is designed in -
  // a torn edge in the near ground, a hole with real depth behind it, and the
  // far abutment dissolving.
  function buildBridge(L, B, rng) {
    var Bg = L.plan.bridge;
    var i, j;
    var W = 4.5;                       // deck half-width
    function deckY(z) { return roadY(z) + 0.42; }
    function cx(z) { return roadX(z); }

    function deckRun(z0, z1, torn) {
      var n = Math.max(2, Math.round(Math.abs(z1 - z0) / 1.2));
      for (i = 0; i < n; i++) {
        var a = M.lerp(z0, z1, i / n), b = M.lerp(z0, z1, (i + 1) / n);
        var zc = (a + b) * 0.5;
        var tornT = torn ? M.smoothstep(z0, z1, zc) : 0;
        var half = W * (1 - tornT * 0.10);
        B.tint = grey(0.86);
        B.box('concrete', half * 2, 0.52, Math.abs(b - a) * 1.02, cx(zc), deckY(zc) - 0.26, zc);
        B.tint = null;
        // the wearing course under a thin skin of driven snow
        B.tint = grey(0.95);
        B.box('snow_road', half * 2 - 0.5, 0.09, Math.abs(b - a) * 1.02,
          cx(zc), deckY(zc) + 0.045, zc);
        B.tint = null;
        // kerbs and the parapet
        for (var s = -1; s <= 1; s += 2) {
          B.tint = grey(0.80);
          B.box('concrete', 0.34, 0.30, Math.abs(b - a) * 1.02,
            cx(zc) + s * (half - 0.17), deckY(zc) + 0.15, zc);
          B.tint = null;
        }
      }
      // parapet posts and rails
      var np = Math.max(2, Math.round(Math.abs(z1 - z0) / 2.0));
      for (i = 0; i <= np; i++) {
        var pz = M.lerp(z0, z1, i / np);
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var lean = (torn && i > np - 2) ? rng.range(0.25, 0.9) : rng.range(-0.05, 0.05);
          B.tint = grey(0.55);
          B.add('steel', box(0.10, 1.05, 0.10),
            makeM(cx(pz) + s2 * (W - 0.20), deckY(pz) + 0.55, pz, 0, 0, s2 * lean));
          B.tint = null;
        }
      }
      for (var rI = 0; rI < 2; rI++) {
        for (var s3 = -1; s3 <= 1; s3 += 2) {
          var ry = deckY(z0) + 0.42 + rI * 0.42;
          B.tint = grey(0.5);
          B.rod('steel', cx(z0) + s3 * (W - 0.20), ry, z0,
            cx(z1) + s3 * (W - 0.20), deckY(z1) + 0.42 + rI * 0.42, z1, 0.038, 5);
          B.tint = null;
        }
      }
      // girders under the deck
      for (var g = -1; g <= 1; g++) {
        B.tint = grey(0.42);
        B.rod('rust', cx(z0) + g * 2.6, deckY(z0) - 1.05, z0,
          cx(z1) + g * 2.6, deckY(z1) - 1.05, z1, 0.30, 6);
        B.tint = null;
      }
    }

    deckRun(BR_NEAR + 1.4, BR_TORN, true);
    deckRun(BR_FAR0, BR_FAR1 - 1.0, false);

    // ---- the torn edge -----------------------------------------------------
    B.tint = grey(0.78);
    // Every fragment sits ON the surviving slab, not beyond it. The first
    // version scattered them across BR_TORN +- 0.5, i.e. half of them hung in
    // the middle of the 6.4 m gap with nothing under them, and a floating prop
    // is item one on the roster's instant-fail list.
    for (i = 0; i < 18; i++) {
      var tx = cx(BR_TORN) + rng.range(-W + 0.35, W - 0.35);
      var tz = BR_TORN - rng.range(0.15, 1.35);
      B.boxR('concrete', rng.range(0.35, 0.95), rng.range(0.30, 0.60), rng.range(0.35, 0.85),
        tx, deckY(BR_TORN) - rng.range(0.18, 0.46), tz,
        rng.range(-0.35, 0.35), rng.range(0, 3), rng.range(-0.35, 0.35));
    }
    B.tint = null;
    B.tint = grey(0.40);
    for (i = 0; i < 22; i++) {
      var bx = cx(BR_TORN) + rng.range(-W + 0.3, W - 0.3);
      var by = deckY(BR_TORN) - rng.range(0.15, 0.55);
      B.rod('rust', bx, by, BR_TORN - 0.35,
        bx + rng.range(-0.30, 0.30), by - rng.range(0.35, 1.2), BR_TORN + rng.range(0.15, 0.95),
        0.020, 4);
    }
    // girder stubs bent down into the gorge
    for (i = -1; i <= 1; i++) {
      B.rod('rust', cx(BR_TORN) + i * 2.6, deckY(BR_TORN) - 1.05, BR_TORN - 0.2,
        cx(BR_TORN) + i * 2.6 + rng.range(-0.4, 0.4), deckY(BR_TORN) - 4.4,
        BR_TORN + 1.9, 0.28, 6);
    }
    B.tint = null;

    // ---- abutments and the surviving pier ----------------------------------
    B.tint = grey(0.82);
    for (var ab = 0; ab < 2; ab++) {
      var az = ab ? BR_FAR1 - 0.4 : BR_NEAR + 0.9;
      B.box('stonework', W * 2 + 1.6, 6.0, 2.2, cx(az), deckY(az) - 3.2, az);
      for (var ws = -1; ws <= 1; ws += 2) {
        B.add('stonework', box(0.8, 4.2, 4.6),
          makeM(cx(az) + ws * (W + 0.6), deckY(az) - 2.4, az + (ab ? -2.6 : 2.6),
            0, ws * 0.20, 0));
      }
    }
    B.box('stonework', 3.0, 8.5, 2.0, cx(BR_TORN - 1.5), deckY(BR_TORN) - 5.6, BR_TORN - 1.2);
    B.tint = null;

    // ---- the fallen span, in the bottom -------------------------------------
    var fz = (BR_TORN + BR_FAR0) * 0.5 - 0.8;
    var fy = Bg.gorgeFloor + 1.1;
    B.pushXYZ(cx(fz) - 1.2, fy, fz, 0.36, 0.28, -0.16);
    B.tint = grey(0.74);
    B.box('concrete', 8.4, 0.55, 6.0, 0, 0, 0);
    B.tint = null;
    B.tint = grey(0.40);
    for (i = -1; i <= 1; i++) B.box('rust', 0.34, 0.9, 6.2, i * 2.6, -0.72, 0);
    B.tint = null;
    B.tint = grey(1.03);
    B.box('snow', 8.0, 0.42, 5.4, 0, 0.44, 0.2, 0.05);
    B.tint = null;
    B.pop();
    // boulders and a frozen stream in the gorge floor
    for (i = 0; i < 30; i++) {
      var gx = cx(GORGE_Z) + M.clamp(rng.gaussian(0, 8.0), -17, 17);
      var gz = GORGE_Z + M.clamp(rng.gaussian(0, 2.6), -3.2, 3.2);
      var gy = rockY(gx, gz, L.plan) + 0.1;
      B.tint = grey(rng.range(0.62, 0.95));
      B.boxR('rock', rng.range(0.7, 2.6), rng.range(0.5, 1.7), rng.range(0.7, 2.4),
        gx, gy, gz, rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.3, 0.3));
      B.tint = null;
      B.tint = grey(1.02);
      B.boxR('snow', rng.range(0.6, 2.2), rng.range(0.1, 0.3), rng.range(0.6, 2.0),
        gx, gy + rng.range(0.3, 0.8), gz, rng.range(-0.2, 0.2), rng.range(0, 3),
        rng.range(-0.2, 0.2));
      B.tint = null;
    }

    // ---- the barrier that closed the road ----------------------------------
    var bz = BR_NEAR + 3.6;
    B.tint = grey(0.9);
    for (var bp = -1; bp <= 1; bp += 2) {
      B.box('steel', 0.12, 1.15, 0.12, cx(bz) + bp * 3.2, roadY(bz) + 0.68, bz);
    }
    for (i = 0; i < 8; i++) {
      B.tint = i % 2 ? tint(0xd03020, 0.95) : grey(1.05);
      B.box('steel', 6.6 / 8 * 0.96, 0.26, 0.09,
        cx(bz) - 3.3 + (i + 0.5) * 6.6 / 8, roadY(bz) + 1.02, bz);
    }
    B.tint = null;
    L.addCollider(cx(bz), roadY(bz) + 0.7, bz, 3.4, 0.7, 0.15, 'metal');
    L.addCollider(cx(BR_NEAR - 1), deckY(BR_NEAR) - 0.3, (BR_NEAR + BR_TORN) * 0.5,
      W, 0.35, Math.abs(BR_TORN - BR_NEAR) * 0.5, 'concrete', true);

    return {
      nearLip: new THREE.Vector3(cx(BR_NEAR), deckY(BR_NEAR), BR_NEAR),
      tornEdge: new THREE.Vector3(cx(BR_TORN), deckY(BR_TORN), BR_TORN),
      farStub: new THREE.Vector3(cx(BR_FAR0), deckY(BR_FAR0), BR_FAR0),
      farLip: new THREE.Vector3(cx(BR_FAR1), deckY(BR_FAR1), BR_FAR1),
      barrier: new THREE.Vector3(cx(bz), roadY(bz) + 1.0, bz),
      deckY: deckY(BR_TORN), railY: deckY(BR_TORN) + 0.85,
      fallenSpan: new THREE.Vector3(cx(fz) - 1.2, fy, fz),
      gorge: { z: GORGE_Z, half: GORGE_HALF, depth: GORGE_DEPTH, floorY: Bg.gorgeFloor }
    };
  }

  // ============================================================ PINE FOREST ==
  // Two instanced variants, each split into a DARK mesh (trunk + needles) and a
  // SNOW mesh sharing the same transforms. One InstancedMesh cannot carry two
  // materials, and a snow-laden conifer whose snow is the same material as its
  // needles is just a green tree - the value split between the two is the whole
  // silhouette. Four draw calls for the entire treeline.
  // A single drooping, TAPERED needle spray, unit length along +Z with its base
  // at the origin and half-width 0.5 at the base falling to nothing at the tip.
  // The old fronds were 0.09 m solid boxes - 24 to 48 rectangular slabs skewered
  // on a pole, and at the range hero3 photographs them you could count the
  // planks. A tapered sliver costs the same six triangles and has an edge.
  // materials.js's `foliage` def is side:2, so a flat ribbon is legal here.
  var _frondCache = new Map();
  function frondGeo(spans, curl) {
    var key = spans + ',' + curl;
    var cached = _frondCache.get(key);
    if (cached) return cached;
    var pos = [], nor = [], uvv = [];
    var pts = [], i;
    for (i = 0; i <= spans; i++) {
      var t = i / spans;
      pts.push([0.5 * Math.pow(1 - t * 0.985, 0.68), -curl * t * t, t]);
    }
    function vtx(w, p) {
      var slope = 2 * curl * p[2];
      var nl = Math.sqrt(1 + slope * slope) || 1;
      pos.push(w, p[1], p[2]);
      nor.push(0, 1 / nl, slope / nl);
      uvv.push(w + 0.5, p[2]);
    }
    for (i = 0; i < spans; i++) {
      var a = pts[i], b = pts[i + 1];
      vtx(-a[0], a); vtx(a[0], a); vtx(b[0], b);
      vtx(-a[0], a); vtx(b[0], b); vtx(-b[0], b);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvv), 2));
    _frondCache.set(key, g);
    return g;
  }

  function pineGeometry(rng, tall) {
    var dark = [], snow = [];
    var h = tall ? 12.6 : 8.2;
    var tiers = tall ? 7 : 5;
    var baseR = tall ? 2.95 : 2.45;
    var i, j;
    var FR = frondGeo(3, 0.22);
    var FR2 = frondGeo(2, 0.30);
    // trunk
    dark.push({ geometry: cyl(0.07, 0.30, h * 0.98, 6), matrix: makeM(0, h * 0.49, 0) });
    // `roll` is about the frond's OWN long axis, and it is what makes a flat
    // ribbon work: a horizontal blade seen from a horizontal viewpoint has no
    // area at all, so an unrolled crown reads as a bare pole with white flecks
    // on it. Rolled 30-70 degrees and alternating, half the sprays present to
    // any given camera and the crown gets volume.
    function place(list, geo, x, y, z, azim, pitch, wid, len, roll) {
      var m = new THREE.Matrix4();
      _e1.set(pitch, -azim + Math.PI * 0.5, roll || 0, 'YXZ');
      m.makeRotationFromEuler(_e1);
      m.elements[0] *= wid; m.elements[1] *= wid; m.elements[2] *= wid;
      m.elements[4] *= len; m.elements[5] *= len; m.elements[6] *= len;
      m.elements[8] *= len; m.elements[9] *= len; m.elements[10] *= len;
      m.elements[12] = x; m.elements[13] = y; m.elements[14] = z;
      list.push({ geometry: geo, matrix: m });
      return m;
    }
    // THE CORE. Measured, the first version of this crown came back at L 0.658
    // at 30 m against a sky of 0.765 - and the blades themselves measured 0.325,
    // so the pale reading was not the needles, it was the SKY between them. A
    // conifer at that range is an opaque dark mass with a ragged edge, and 41
    // flat blades on a pole is 60% hole. This stepped open-ended spindle costs
    // 16 triangles a tier and is what the fronds are silhouetted against.
    // The core is a thin dark SPINE, not the silhouette: at 0.6 of the frond
    // reach it became the whole tree and the treeline photographed as a row of
    // smooth pale cones, which is the untextured-geometry failure the fronds
    // exist to avoid. At 0.30 it is what the sprays are seen against and
    // nothing more. The tier radii carry their own jitter so the outline is
    // never a straight-sided cone.
    var tierY = [], tierR = [];
    for (i = 0; i < tiers; i++) {
      var tt = i / (tiers - 1);
      tierY.push(h * (0.11 + 0.86 * tt));
      tierR.push((baseR * (1 - tt) * (1 - tt * 0.28) + 0.20) * rng.range(0.86, 1.16));
    }
    for (i = 0; i + 1 < tiers; i++) {
      var yc0 = tierY[i] - (i === 0 ? 0.80 : 0.10);
      var yc1 = tierY[i + 1];
      dark.push({
        geometry: cyl(tierR[i + 1] * 0.26, tierR[i] * 0.34, Math.max(0.25, yc1 - yc0), 7, true),
        matrix: makeM(0, (yc0 + yc1) * 0.5, 0)
      });
    }
    dark.push({
      geometry: cyl(0.04, tierR[tiers - 1] * 0.32, h * 0.16, 6, true),
      matrix: makeM(0, tierY[tiers - 1] + h * 0.06, 0)
    });

    for (i = 0; i < tiers; i++) {
      var t = i / (tiers - 1);
      var y = tierY[i];
      var r = tierR[i];
      var nF = Math.max(6, Math.round(12 - t * 4));
      var droop = 0.36 + t * 0.22;
      for (j = 0; j < nF; j++) {
        var a = (j / nF) * Math.PI * 2 + i * 0.79;
        var len = r * rng.range(0.88, 1.32);
        // NARROW. At 0.34 + r*0.24 the base of a frond was 1.1 m across, which
        // at five metres photographs as a grey PLATE - the plank read the
        // fronds were supposed to fix, wearing a taper. A real branch spray is
        // a couple of hand-widths at the trunk, and the mass comes from having
        // twelve of them a tier rather than from any one being large.
        var wid = (0.16 + r * 0.115) * rng.range(0.82, 1.20);
        var roll = (j % 2 ? 1 : -1) * rng.range(0.30, 0.85);
        place(dark, FR, 0, y, 0, a, droop, wid, len, roll);
        // A SECOND, FINER GENERATION. This is what turns a plank edge into a
        // ragged one: two smaller sprays hanging off each main frond, drooping
        // harder, splayed either side of it.
        for (var sf = 0; sf < 2; sf++) {
          var st = sf ? 0.72 : 0.44;
          var sd = droop + rng.range(0.18, 0.44);
          var sa = a + (sf ? 1 : -1) * rng.range(0.34, 0.72);
          var cx3 = st * len * Math.cos(droop) * Math.cos(a);
          var cz3 = st * len * Math.cos(droop) * Math.sin(a);
          var cy3 = y - st * len * Math.sin(droop);
          place(dark, FR2, cx3, cy3, cz3, sa, sd,
            wid * rng.range(0.55, 0.86), len * rng.range(0.36, 0.58),
            -roll * rng.range(0.5, 1.1));
        }
        // The load, on ONE spray in three. Every frond carrying a matching
        // white slab is what made the treeline measure L 0.725 against a sky of
        // 0.771 - the same value as what it was silhouetted against. A conifer
        // in a blizzard is a DARK mass with snow caught in it, and the value
        // split between the two is the entire silhouette.
        if ((i + j) % 3 === 0) {
          place(snow, FR, 0, y + 0.065, 0, a, droop * 0.90, wid * 0.74, len * 0.80,
            roll * 0.55);
        }
      }
    }
    // the leader
    dark.push({ geometry: cyl(0.02, 0.14, h * 0.17, 5), matrix: makeM(0, h * 0.95, 0) });
    snow.push({ geometry: cyl(0.015, 0.11, h * 0.11, 5), matrix: makeM(0, h * 0.99, 0) });
    return { dark: Geo.mergeAll(dark), snow: Geo.mergeAll(snow) };
  }

  function buildForest(L, rng) {
    var P = L.plan, N = L.noise;
    var variants = [pineGeometry(rng.fork(11), true), pineGeometry(rng.fork(12), false)];
    var lists = [[], []];
    var tries = 0, placed = 0;
    // 215 trees over 236 x 226 m is one per 250 m2 - a sparse orchard, and
    // hero3 duly photographed about a dozen isolated specimens on bare slope.
    // A forest needs a mass. 780 is three and a half times the density and,
    // with the cheaper frond, costs about 570k triangles against 280k.
    var CAP = 700;
    while (placed < CAP && tries < 42000) {
      tries++;
      var x = rng.range(-122, 122);
      var z = rng.range(-124, 112);
      var u = x - roadX(z);
      var a = Math.abs(u);
      if (a < 15) continue;                                    // clear of the village
      if (Math.abs(z - GORGE_Z) < GORGE_HALF * 0.85) continue; // not in the gorge
      // STANDS AND CLEARINGS, not a scatter. A uniform-random rejection sampler
      // distributes evenly, which is item four on the instant-fail list and is
      // also just not what a treeline looks like: the edge of a forest is
      // ragged because the trees come in clumps with gaps between them. Hard
      // threshold on the density field so "in a stand" and "in a clearing" are
      // different places rather than two draws from the same distribution.
      var f2 = M.saturate(N.fbm2(x * 0.026 + 20, z * 0.026 - 11, 3) * 0.5 + 0.5);
      var stand = M.smoothstep(0.42, 0.60, f2);
      var dens = (u < 0 ? 1.0 : 0.46) * M.smoothstep(15, 25, a) * (0.05 + 0.95 * stand);
      if (rng.next() > dens) continue;
      var blocked = false;
      for (var i = 0; i < P.rects.length; i++) {
        var rr = P.rects[i];
        if (Math.abs(x - rr.x) < rr.hx + 4.5 && Math.abs(z - rr.z) < rr.hz + 4.5) {
          blocked = true; break;
        }
      }
      if (blocked) continue;
      var y = (x > X_MIN + 1 && x < X_MAX - 1 && z > Z_MIN + 1 && z < Z_MAX - 1)
        ? L.sampleGround(x, z) - 0.25
        : rockY(x, z, P) + SNOW_BASE * 0.65;
      var big = rng.next() < (u < 0 ? 0.60 : 0.3);
      var s = rng.range(0.72, 1.35) * (big ? 1.15 : 0.9);
      // THE LEVEL'S BLACK. Measured, the old treeline came back at L 0.725 with
      // std 0.016 against a sky of 0.771 - the same value as what it was
      // silhouetted against, contributing nothing to depth and nothing to the
      // frame's black point. A conifer stand is one of only two things in this
      // palette that can be genuinely dark, and the west slope is the one that
      // faces every published framing, so it gets the darker end.
      var vd = (u < 0 ? rng.range(0.40, 0.58) : rng.range(0.56, 0.78)) *
        M.clamp(rng.gaussian(1.0, 0.09), 0.78, 1.22);
      L.treeXZ.push(x, z, s);
      lists[big ? 0 : 1].push({ x: x, y: y, z: z, s: s, yaw: rng.range(0, 6.28),
        tiltX: rng.gaussian(0, 0.035), tiltZ: rng.gaussian(0, 0.035),
        v: M.clamp(vd, 0.30, 0.86),
        vs: M.clamp(rng.gaussian(0.88, 0.07), 0.68, 1.02) });
      placed++;
    }
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    var sc = new THREE.Vector3(), pv = new THREE.Vector3();
    var col = new THREE.Color();
    for (var vi = 0; vi < 2; vi++) {
      var list = lists[vi];
      if (!list.length) continue;
      var pair = [
        { geo: variants[vi].dark, key: 'needle', name: 'pine' + vi },
        { geo: variants[vi].snow, key: 'snow', name: 'pinesnow' + vi }
      ];
      for (var pi = 0; pi < 2; pi++) {
        var g2 = pair[pi].geo;
        Geo.worldUV(g2, SURF[pair[pi].key].uv);
        Geo.copyUV1(g2);
        // Every material in this level runs vertexColors. A geometry with no
        // `color` attribute does not fall back to white - WebGL hands the shader
        // the default generic attribute, which is BLACK, and the whole treeline
        // renders as silhouettes. So the instanced geometry carries its own.
        if (!g2.attributes.color) {
          var wc = new Float32Array(g2.attributes.position.count * 3);
          for (var wi = 0; wi < wc.length; wi++) wc[wi] = 1;
          g2.setAttribute('color', new THREE.BufferAttribute(wc, 3));
        }
        var im = new THREE.InstancedMesh(g2, L.material(pair[pi].key), list.length);
        im.name = 'snowbound_' + pair[pi].name;
        // NO SHADOW CASTING, and it is a considered decision rather than a
        // saving. Under a 0.09-turbidity overcast the sun term is soft and low
        // and a conifer at 25-100 m throws nothing a camera can see; what the
        // cascades DO see is 780 instances re-rendered per split, which was
        // costing about 1.1M triangles a frame. props_snowbound turns its alpha
        // cards off for the same reason. The trees are grounded by the contact
        // rings in the ground vertex colours instead, which is a stronger cue
        // here than a shadow would have been.
        im.castShadow = false; im.receiveShadow = true;
        for (var k = 0; k < list.length; k++) {
          var t2 = list[k];
          e.set(t2.tiltX, t2.yaw, t2.tiltZ, 'YXZ');
          q.setFromEuler(e);
          sc.set(t2.s, t2.s * rng.range(0.94, 1.10), t2.s);
          pv.set(t2.x, t2.y, t2.z);
          m4.compose(pv, q, sc);
          im.setMatrixAt(k, m4);
          if (pi) {
            var vs = t2.vs;
            col.setRGB(vs * 0.985, vs, vs * 1.030);      // caught snow, faintly blue
          } else {
            var v = t2.v;
            // pushed harder toward green: this and the lit panes are the only
            // chroma the level has that is not a shade of blue
            col.setRGB(v * 0.80, v, v * 0.70);
          }
          im.setColorAt(k, col);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.frustumCulled = true;
        L.root.add(im);
        L.instanced.push(im);
      }
      // colliders only for the trunks the player can actually reach, and a
      // contact ring for every tree standing inside the rasterised field
      for (var ci = 0; ci < list.length; ci++) {
        var c2 = list[ci];
        if (c2.x > X_MIN + 2 && c2.x < X_MAX - 2 && c2.z > Z_MIN + 2 && c2.z < Z_MAX - 2) {
          L._occluders.push({ x: c2.x, z: c2.z, r: 0.55 * c2.s });
        }
        if (Math.abs(c2.x - roadX(c2.z)) > 34) continue;
        if (c2.z < Z_MIN || c2.z > Z_MAX) continue;
        L.addCollider(c2.x, c2.y + 2.5, c2.z, 0.30 * c2.s, 2.5, 0.30 * c2.s, 'wood');
      }
    }
    L.anchors.treeCount = placed;
  }
  // ========================================================= ROAD FURNITURE ==
  // The marker posts are the level's leading line and they are not decoration:
  // in a whiteout the edge of the carriageway is genuinely invisible, which is
  // why real alpine roads are posted every few metres. Two receding rows of
  // red-and-white ticks converging on a curve is the strongest bit of
  // perspective the level owns, and it costs almost nothing.
  function buildRoadFurniture(L, B, rng) {
    var marks = [];
    var z, i;
    for (z = Z_MAX - 2; z > BR_NEAR + 2.0; z -= 6.5) {
      for (var s = -1; s <= 1; s += 2) {
        if (z < 2 && s > 0 && rng.next() < 0.4) continue;   // some are gone
        var x = roadX(z) + s * (ROAD_HALF - 0.18);
        var gy = L.sampleGround(x, z);
        var lean = rng.gaussian(0, 0.10);
        var H = 1.55;
        B.pushXYZ(x, gy - 0.10, z, lean, rng.range(-0.3, 0.3), rng.gaussian(0, 0.09));
        B.tint = grey(0.96);
        B.box('steel', 0.085, H, 0.085, 0, H * 0.5, 0);
        B.tint = null;
        // three red bands + a reflector
        for (i = 0; i < 3; i++) {
          B.tint = tint(0xc8281c, 0.92);
          B.box('steel', 0.095, 0.19, 0.095, 0, 0.42 + i * 0.42, 0);
          B.tint = null;
        }
        B.tint = grey(1.15);
        B.add('ice', quad(0.07, 0.11), makeM(0, H - 0.16, -0.052));
        B.tint = null;
        // snow plastered on the windward face
        B.tint = grey(1.02);
        B.box('snow', 0.055, H * 0.62, 0.055, WIND_X * -0.055, H * 0.42, WIND_Z * -0.055);
        B.tint = null;
        B.pop();
        ground(L, B, x, gy - 0.03, z, 0.30, 0.11, (z * 13) | 0);
        marks.push({ x: x, y: gy, z: z });
      }
    }

    // ---- telegraph line ----------------------------------------------------
    var prev = null;
    for (z = Z_MAX - 4; z > BR_NEAR + 1; z -= 13.0) {
      var px = roadX(z) + (ROAD_HALF + BERM_W + 1.6);
      var py = L.sampleGround(px, z);
      var H2 = 7.4 + rng.range(-0.4, 0.5);
      var lean2 = rng.gaussian(0, 0.045);
      B.pushXYZ(px, py - 0.35, z, lean2, rng.range(-0.2, 0.2), rng.gaussian(0, 0.05));
      B.tint = grey(rng.range(0.66, 0.86));
      B.cyl('bark', 0.10, 0.16, H2, 0, H2 * 0.5, 0, 0, 0, 0, 8);
      B.tint = null;
      B.tint = grey(0.72);
      B.box('timber_dark', 1.70, 0.09, 0.09, 0, H2 - 0.45, 0);
      B.box('timber_dark', 1.30, 0.09, 0.09, 0, H2 - 1.05, 0);
      B.add('timber_dark', box(0.9, 0.07, 0.07), makeM(0.36, H2 - 0.75, 0, 0, 0, 0.9));
      B.add('timber_dark', box(0.9, 0.07, 0.07), makeM(-0.36, H2 - 0.75, 0, 0, 0, -0.9));
      B.tint = null;
      for (i = -2; i <= 2; i++) {
        if (!i) continue;
        B.tint = grey(1.1);
        B.cyl('glazing', 0.055, 0.045, 0.13, i * 0.40, H2 - 0.34, 0, 0, 0, 0, 6);
        B.tint = null;
      }
      B.tint = grey(1.02);
      B.box('snow', 1.78, 0.055, 0.11, 0, H2 - 0.38, 0);
      B.tint = null;
      B.pop();
      ground(L, B, px, py - 0.30, z, 0.52, 0.16, (z * 29 + 5) | 0);
      var head = { x: px, y: py - 0.35 + H2 - 0.45, z: z };
      if (prev) {
        for (i = -2; i <= 2; i++) {
          if (!i) continue;
          B.tint = grey(0.5);
          wire(B, 'steel', prev.x + i * 0.40, prev.y, prev.z,
            head.x + i * 0.40, head.y, head.z, 1.15, 0.022, 6);
          B.tint = null;
        }
      }
      prev = head;
    }
    return marks;
  }

  // Split-rail plot fences, most of them buried to the top rail. A fence line
  // that vanishes into a drift and comes out again 6 m later says "deep snow"
  // more clearly than any amount of white.
  function buildFences(L, B, rng) {
    var P = L.plan;
    for (var d = 0; d < P.dachas.length; d++) {
      var S = P.dachas[d];
      if (S.ruin && rng.next() < 0.5) continue;
      var hw = S.w * 0.5 + 2.6, hd = S.d * 0.5 + 2.4;
      var pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
      for (var i = 0; i + 1 < pts.length; i++) {
        var n = Math.round(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) / 1.55);
        for (var j = 0; j < n; j++) {
          var t0 = j / n, t1 = (j + 1) / n;
          var lx0 = M.lerp(pts[i][0], pts[i + 1][0], t0);
          var lz0 = M.lerp(pts[i][1], pts[i + 1][1], t0);
          var lx1 = M.lerp(pts[i][0], pts[i + 1][0], t1);
          var lz1 = M.lerp(pts[i][1], pts[i + 1][1], t1);
          var wx = S.x + lx0 * Math.cos(S.yaw) + lz0 * Math.sin(S.yaw);
          var wz = S.z - lx0 * Math.sin(S.yaw) + lz0 * Math.cos(S.yaw);
          var wx1 = S.x + lx1 * Math.cos(S.yaw) + lz1 * Math.sin(S.yaw);
          var wz1 = S.z - lx1 * Math.sin(S.yaw) + lz1 * Math.cos(S.yaw);
          if (Math.abs(wx - roadX(wz)) < ROAD_HALF + BERM_W) continue;
          var gy = L.sampleGround(wx, wz);
          var top = 1.15;
          B.tint = grey(rng.range(0.58, 0.86));
          B.add('timber_dark', box(0.11, top, 0.11),
            makeM(wx, gy + top * 0.5 - 0.25, wz, rng.gaussian(0, 0.10), rng.range(0, 3),
              rng.gaussian(0, 0.10)));
          for (var r = 0; r < 2; r++) {
            var ry = gy + 0.45 + r * 0.42;
            B.rod('timber_dark', wx, ry, wz, wx1, L.sampleGround(wx1, wz1) + 0.45 + r * 0.42,
              wz1, 0.045, 4);
          }
          B.tint = null;
          if (rng.next() < 0.5) {
            B.tint = grey(1.02);
            B.rod('snow', wx, gy + 0.90, wz, wx1, L.sampleGround(wx1, wz1) + 0.90, wz1, 0.075, 5);
            B.tint = null;
          }
          // every post gets a collar: a fence line whose stakes each stop dead
          // on a white plane is nine cutouts in a row
          if (j % 2 === 0) ground(L, B, wx, gy - 0.04, wz, 0.26, 0.09, (wx * 17 + wz * 3) | 0);
          else L._occluders.push({ x: wx, z: wz, r: 0.22 });
        }
      }
    }
  }

  // Rock. The east buttress and the ledge the overview stands on: the only
  // genuinely dark mass in the level, and therefore the whole reason the
  // whiteout has a value range at all.
  function buildRocks(L, B, rng) {
    var P = L.plan, i;
    var Lg = P.ledge;
    // Nothing on the ledge may stand where the overview stands, or in the
    // metre or two around it. A boulder in front of the lens is not foreground,
    // it is the whole photograph.
    function clearOfEye(x, z, half) {
      var dx = x - Lg.eyeX, dz = z - Lg.eyeZ;
      return Math.sqrt(dx * dx + dz * dz) > (Lg.eyeClear + (half || 0));
    }
    // the crag BEHIND the standpoint - it is the mass that makes the ledge a
    // ledge, and it is east of the eye where it cannot occlude the valley
    for (i = 0; i < 14; i++) {
      var x = Lg.x + rng.range(3.5, 12.0), z = Lg.z + rng.range(-10, 10);
      if (!clearOfEye(x, z, 3.0)) continue;
      var y = L.sampleGround(x, z) + rng.range(0.4, 2.4);
      B.tint = grey(rng.range(0.55, 0.95));
      B.boxR('rock', rng.range(2.2, 5.0), rng.range(2.0, 5.5), rng.range(2.2, 4.6),
        x, y, z, rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.2, 0.2));
      B.tint = null;
    }
    // north and south buttresses: the two edges of the frame
    for (var bsd = -1; bsd <= 1; bsd += 2) {
      for (i = 0; i < 7; i++) {
        var qx = Lg.x + rng.range(-6.5, 2.5);
        var qz = Lg.z + bsd * rng.range(6.5, 12.0);
        if (!clearOfEye(qx, qz, 2.6)) continue;
        var qy = L.sampleGround(qx, qz) + rng.range(-0.4, 1.4);
        B.tint = grey(rng.range(0.52, 0.92));
        B.boxR('rock', rng.range(1.8, 4.2), rng.range(1.6, 4.2), rng.range(1.8, 3.8),
          qx, qy, qz, rng.range(-0.25, 0.25), rng.range(0, 3), rng.range(-0.25, 0.25));
        B.tint = null;
      }
    }
    // the lip: low stone the camera looks OVER, capped with snow. Tops are
    // pinned 0.75 m below the eye so this can never become an occluder again.
    // Kept 6.4 m back, because the first attempt let a 4 m boulder stand three
    // metres in front of the lens and the establishing shot became a rock face.
    for (i = 0; i < 15; i++) {
      var bx = Lg.x + rng.range(-9.6, -5.2), bz = Lg.z + rng.range(-8.5, 10.5);
      if (!clearOfEye(bx, bz, 3.0)) continue;
      var bh = rng.range(0.6, 1.5);
      // sunk into the real surface, and the top pinned below the published eye
      var by = Math.min(L.sampleGround(bx, bz) + bh * 0.30, Lg.y + 0.72 - bh * 0.5);
      B.tint = grey(rng.range(0.50, 0.90));
      B.boxR('rock', rng.range(0.9, 2.2), bh, rng.range(0.9, 2.0),
        bx, by, bz, rng.range(-0.28, 0.28), rng.range(0, 3), rng.range(-0.28, 0.28));
      B.tint = null;
      B.tint = grey(1.03);
      B.boxR('snow', rng.range(0.8, 2.0), rng.range(0.14, 0.34), rng.range(0.8, 1.9),
        bx, by + bh * 0.5 + 0.09, bz, rng.range(-0.16, 0.16), rng.range(0, 3),
        rng.range(-0.16, 0.16));
      B.tint = null;
    }

    // ---- the standpoint's own near field -----------------------------------
    // An overview from a ledge with nothing inside six metres has no scale
    // reference and no black point, and it photographs as a fog test. These sit
    // 3.2-5.6 m out, spread across the published view direction, with their
    // tops pinned 1.5 m below the eye so they occupy the bottom third and
    // occlude nothing. Anchored to the ledge's planned mark, not to a pose.
    // A WIND CORNICE along the west lip of the ledge. Buried boulders were
    // tried here first and they cannot work: the pad is a flat plane, so a part
    // sunk box shows as a dark lozenge with a white slab floating over it. What
    // a wind-scoured alpine shelf actually grows is a cornice - a lip of
    // packed snow overhanging the drop, thick at the crest and curling under -
    // and it is the same profile the roof loads use, laid on its side.
    B.pushXYZ(Lg.x - 8.9, Lg.y - 0.05, Lg.z, 0, -Math.PI * 0.5, 0);
    B.tint = grey(1.02);
    roofSnowRun(B, 'snow', -11.5, 11.5, 1.55, 0.62, 0.46, rng, false);
    B.tint = null;
    B.pop();
    // and stone breaking out of the slope below it, so the drop has a bottom
    var aim0 = Math.atan2(Lg.aimX - Lg.eyeX, Lg.aimZ - Lg.eyeZ);
    for (i = 0; i < 10; i++) {
      var foff = (i - 4.5) * 0.20 + rng.range(-0.05, 0.05);
      var fd = rng.range(7.0, 15.0);
      var fx2 = Lg.eyeX + Math.sin(aim0 + foff) * fd;
      var fz2 = Lg.eyeZ + Math.cos(aim0 + foff) * fd;
      var fw2 = rng.range(1.2, 3.0), fh2 = rng.range(0.9, 2.2);
      var fy2 = L.sampleGround(fx2, fz2) + fh2 * 0.16;
      B.tint = grey(rng.range(0.34, 0.72));
      B.boxR('rock', fw2, fh2, rng.range(1.0, 2.6),
        fx2, fy2, fz2, rng.range(-0.26, 0.26), rng.range(0, 3), rng.range(-0.26, 0.26));
      B.tint = null;
      B.tint = grey(1.03);
      B.boxR('snow', fw2 * rng.range(0.70, 0.94), rng.range(0.16, 0.32), rng.range(0.8, 2.2),
        fx2, fy2 + fh2 * 0.5 - 0.06, fz2, rng.range(-0.16, 0.16), rng.range(0, 3),
        rng.range(-0.16, 0.16));
      B.tint = null;
      snowCollar(B, fx2, fy2 - fh2 * 0.42, fz2, fw2 * 0.72, 0.24, (i * 37 + 11) | 0);
    }

    L.addCollider(Lg.x, Lg.y - 1.6, Lg.z, 7.0, 1.8, 8.2, 'stone', true);
    B.tint = null;

    // crags breaking out of the east valley wall and the gorge shoulders
    for (i = 0; i < 60; i++) {
      var cz = rng.range(Z_MIN + 4, Z_MAX - 4);
      var side = rng.next() < 0.72 ? 1 : -1;
      var cu = rng.range(24, 52) * side;
      var cx2 = roadX(cz) + cu;
      if (cx2 < X_MIN + 2 || cx2 > X_MAX - 2) continue;
      var cy = L.sampleGround(cx2, cz) - rng.range(0.2, 1.4);
      B.tint = grey(rng.range(0.55, 0.95));
      B.boxR('rock', rng.range(1.2, 4.0), rng.range(1.0, 3.4), rng.range(1.2, 3.6),
        cx2, cy, cz, rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.3, 0.3));
      B.tint = null;
    }
    // gorge walls: exposed strata either side of the bridge
    for (i = 0; i < 46; i++) {
      var gx = rng.range(-40, 40);
      var sgn = rng.next() < 0.5 ? -1 : 1;
      var gz = GORGE_Z + sgn * rng.range(GORGE_HALF * 0.45, GORGE_HALF * 0.95) +
        2.6 * Math.sin(gx * 0.055);
      var gy = rockY(gx, gz, P) + rng.range(0.2, 3.0);
      B.tint = grey(rng.range(0.50, 0.88));
      B.boxR('rock', rng.range(1.4, 4.2), rng.range(0.6, 1.8), rng.range(1.0, 2.6),
        gx, gy, gz, rng.range(-0.2, 0.2), rng.range(0, 3), rng.range(-0.35, 0.35));
      B.tint = null;
    }
  }

  // Boot prints, tyre tread and shovel scrapes, as merged alpha cards. The
  // brief names footprints and tyre ruts specifically and a 0.62 m height field
  // resolves neither; the ruts are ALSO modelled in the field, these are what
  // makes them read at 4 m.
  function buildGroundMarks(L, B, rng) {
    var P = L.plan, i, j, k;
    // ---- tyre tracks up the carriageway ------------------------------------
    for (var side = -1; side <= 1; side += 2) {
      for (var z = Z_MAX - 3; z > BR_NEAR + 4; z -= 1.55) {
        var x = roadX(z) + side * 1.42 + rng.range(-0.10, 0.10);
        var y = L.sampleGround(x, z) + 0.012;
        var yaw = Math.atan2(roadX(z - 1) - roadX(z + 1), -2);
        markCard(B, CELL.tyre, x, y, z, 0.70, 1.62, yaw,
          cool(rng.range(0.74, 0.98)));
      }
    }
    // grit and diesel where the convoy has been standing
    for (i = 0; i < P.trucks.length; i++) {
      var T = P.trucks[i];
      for (j = 0; j < 5; j++) {
        var gx = T.x + rng.gaussian(0, 1.6), gz = T.z + rng.gaussian(0, 2.4);
        markCard(B, CELL.grit, gx, L.sampleGround(gx, gz) + 0.014, gz,
          rng.range(1.6, 3.4), rng.range(1.6, 3.4), rng.range(0, 6.28), grey(0.95));
      }
    }
    // ---- boot prints along every shovelled trench --------------------------
    for (i = 0; i < P.paths.length; i++) {
      var poly = P.paths[i];
      for (j = 0; j + 1 < poly.length; j++) {
        var ax = poly[j][0], az = poly[j][1], bx = poly[j + 1][0], bz = poly[j + 1][1];
        var len = Math.hypot(bx - ax, bz - az);
        var n = Math.max(2, Math.round(len / 0.62));
        var yawp = Math.atan2(bx - ax, bz - az);
        for (k = 0; k < n; k++) {
          var t = (k + 0.5) / n;
          var lat = (k % 2 ? 0.16 : -0.16) + rng.range(-0.05, 0.05);
          var px = M.lerp(ax, bx, t) + Math.cos(yawp) * lat;
          var pz = M.lerp(az, bz, t) - Math.sin(yawp) * lat;
          markCard(B, CELL.boot, px, L.sampleGround(px, pz) + 0.013, pz,
            0.25, 0.42, yawp + rng.range(-0.22, 0.22), cool(rng.range(0.72, 0.98)));
        }
      }
      // the scrape at the mouth where the trench meets the berm
      var e0 = poly[0];
      markCard(B, CELL.scrape, e0[0], L.sampleGround(e0[0], e0[1]) + 0.012, e0[1],
        2.6, 2.2, rng.range(0, 6.28), grey(1.0));
    }
    // a few wandering tracks across open snow, going nowhere
    for (i = 0; i < 5; i++) {
      var sx = roadX(20 - i * 9) + rng.range(-24, 24);
      var sz = 20 - i * 9 + rng.range(-6, 6);
      var dir = rng.range(0, 6.28);
      for (k = 0; k < 16; k++) {
        dir += rng.gaussian(0, 0.16);
        sx += Math.sin(dir) * 0.66; sz += Math.cos(dir) * 0.66;
        if (sx < X_MIN + 2 || sx > X_MAX - 2 || sz < Z_MIN + 2 || sz > Z_MAX - 2) break;
        markCard(B, CELL.boot, sx, L.sampleGround(sx, sz) + 0.013, sz,
          0.23, 0.39, dir, cool(rng.range(0.74, 1.0)));
      }
    }
  }
  // ================================================================== LEVEL ==
  function LevelSnowbound(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_snowbound';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.instanced = [];
    this.lightShafts = [];
    this.practicalLights = [];
    this.dripEdges = [];
    this.anchors = {};
    this.field = null;
    this._groundGeo = null;
    this._groundBaseCol = null;
    this._contactMask = null;
    this._occluders = [];          // {x,z,r} - anything of ours standing on snow
    this.treeXZ = [];              // flat [x, z, scale, ...] for the pose search
    this._litPanes = [];
    this._matCache = Object.create(null);
    this._snowTex = null;
    this._roadTex = null;
    this._atlas = null;
    this._litMat = null;
    this._hash = new GAME.SpatialHash(5.0);
    this._stamp = 0;
    this._t = 0;

    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x534E4F57) : new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x5B0117) >>> 0);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(X_MIN - 8, -30, Z_MIN - 8),
      new THREE.Vector3(X_MAX + 8, 40, Z_MAX + 8));

    // The survey. Available the instant the level is constructed, exactly as
    // the harbor's is, so props_snowbound never has to wait for build() or -
    // worse - read a camera pose.
    this.plan = plan({ noise: this.noise });
    this.anchors = buildAnchors(this.plan);
  }

  function buildAnchors(P) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    var A = {};
    A.valley = {
      x0: X_MIN, x1: X_MAX, z0: Z_MIN, z1: Z_MAX,
      wind: new THREE.Vector2(WIND_X, WIND_Z),
      roadX: roadX, roadY: roadY,
      groundY: function (x, z) { return snowY(x, z, P); }
    };
    A.road = {
      half: ROAD_HALF, bermW: BERM_W, snowBase: SNOW_BASE,
      centre: function (z) { return V(roadX(z), roadY(z) + 0.10, z); }
    };
    A.spawn = { position: V(roadX(54) + 0.9, roadY(54) + 0.10, 54), yaw: 0 };
    A.paths = P.paths;
    A.dachas = [];
    for (var i = 0; i < P.dachas.length; i++) {
      var d = P.dachas[i];
      A.dachas.push({
        name: d.name, centre: V(d.x, d.y, d.z), yaw: d.yaw, w: d.w, d: d.d,
        eave: d.y + d.h, ridge: d.y + d.h + (d.w * 0.5 + 0.52) * 0.86,
        doorOuter: V(d.doorOuter[0], d.y, d.doorOuter[1]),
        pathEdge: V(d.pathEdge[0], d.y, d.pathEdge[1]),
        ruin: d.ruin, lit: d.lit, side: d.side
      });
    }
    var C = P.church;
    A.church = {
      centre: V(C.x, C.y, C.z), yaw: C.yaw, floorY: C.y + 0.10,
      nave: { hw: C.naveHW, hz: C.naveHZ }, eave: C.y + C.wall, ridge: C.y + C.ridge,
      door: V(C.door[0], C.y, C.door[1]),
      pathEdge: V(C.pathEdge[0], C.y, C.pathEdge[1]),
      tower: V(C.x + Math.sin(C.yaw) * C.towerZ, C.y, C.z + Math.cos(C.yaw) * C.towerZ),
      apex: C.y + C.domeApex
    };
    A.barn = {
      centre: V(P.barn.x, P.barn.y, P.barn.z), yaw: P.barn.yaw,
      w: P.barn.w, d: P.barn.d, eave: P.barn.y + P.barn.eave, ridge: P.barn.y + P.barn.ridge
    };
    A.convoy = [];
    for (i = 0; i < P.trucks.length; i++) {
      var t = P.trucks[i];
      A.convoy.push({ name: t.name, centre: V(t.x, t.y, t.z), yaw: t.yaw,
        kind: t.kind, lights: t.lights });
    }
    A.ledge = { centre: V(P.ledge.x, P.ledge.y, P.ledge.z), yaw: P.ledge.yaw,
      top: P.ledge.y };
    A.wreck = { centre: V(P.wreck.x, P.wreck.y, P.wreck.z), yaw: P.wreck.yaw,
      w: 2.6, d: 5.6 };
    A.bridge = {
      nearLip: V(roadX(BR_NEAR), roadY(BR_NEAR) + 0.42, BR_NEAR),
      tornEdge: V(roadX(BR_TORN), roadY(BR_TORN) + 0.42, BR_TORN),
      farStub: V(roadX(BR_FAR0), roadY(BR_FAR0) + 0.42, BR_FAR0),
      farLip: V(roadX(BR_FAR1), roadY(BR_FAR1) + 0.42, BR_FAR1),
      gorge: { z: GORGE_Z, half: GORGE_HALF, depth: GORGE_DEPTH }
    };
    A.treeline = {
      westX: function (z) { return roadX(z) - 26; },
      eastX: function (z) { return roadX(z) + 28; }
    };
    return A;
  }

  // ---- materials, defensively -----------------------------------------------
  LevelSnowbound.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.snow;
    var m = null;
    if (surf.own === 'snow') m = this._snowMaterial(false);
    else if (surf.own === 'road') m = this._snowMaterial(true);
    else if (surf.own === 'ice') m = this._iceMaterial();
    else if (surf.own === 'lit') m = this._litMaterial();
    else if (surf.own === 'decal') m = this._decalMaterial();
    else {
      var lib = this.ctx && this.ctx.materials;
      var name = surf.base || 'concrete';
      var has = false;
      try { has = !!(lib && typeof lib.has === 'function' && lib.has(name)); }
      catch (e) { has = false; }
      if (lib && typeof lib.get === 'function' && has) {
        var opts = { vertexColors: true, wearMode: 'multiply' };
        if (surf.env !== undefined) opts.envMapIntensity = surf.env;
        try { m = lib.get(name, opts); }
        catch (e2) { GAME.logError('snowbound.material:' + key, e2); m = null; }
      }
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelSnowbound.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.snow;
    var surf = SURF[key] || SURF.snow;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2], vertexColors: true,
      envMapIntensity: surf.env !== undefined ? surf.env : 1.0
    });
    m.name = 'snowbound_fallback_' + key;
    return m;
  };

  // ---------------------------------------------------------------------------
  // THE SNOW MATERIAL.
  //
  // MeshPhysicalMaterial rather than Standard for exactly one reason: `sheen`.
  // A sheen lobe with a pale blue sheen colour lifts the grazing angles, which
  // is the cheapest honest read of subsurface scattering there is - a drift lip
  // seen edge-on against the sky gains a soft translucent rim instead of
  // terminating on a hard shading edge. Everything else (the sparkle, the
  // blue-shifted troughs, the roughness range) is in the maps.
  //
  // The albedo is deliberately HIGH. sky.js already solves this level's
  // overcast deck, its IBL lower hemisphere and its fog inscatter against a
  // ground albedo of [0.86 0.89 0.94]; a "safe" grey snow here would sit two
  // stops under a sky that has been calibrated to be doubled by it, which is
  // precisely how a whiteout ends up looking like an overcast car park.
  // ---------------------------------------------------------------------------
  LevelSnowbound.prototype._snowMaterial = function (packed) {
    var cache = packed ? '_roadTex' : '_snowTex';
    var set = this[cache];
    if (!set) {
      try { set = snowMaps(packed ? 512 : 1024, packed ? 0x51AB : 0x5E01, packed); }
      catch (e) { GAME.logError('snowbound.snowMaps', e); set = null; }
      this[cache] = set || {};
    }
    var aniso = 4;
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (caps && caps.getMaxAnisotropy) aniso = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
    } catch (e2) { /* a nicety */ }
    // The packed variant used to carry a 0xdfe4ea tint ON TOP of an already
    // darker map, which compounded to 0.60 of fresh before the road's vertex
    // multiply had even been applied. The map does the value work; the tint is
    // white and the vertex colours take it the rest of the way.
    var opts = {
      color: 0xffffff,
      roughness: 1.0, metalness: 0.0,
      vertexColors: true,
      envMapIntensity: packed ? 1.10 : 1.22
    };
    var m = new THREE.MeshPhysicalMaterial(opts);
    if (set && set.albedo) {
      m.map = makeTex(set.albedo, true, aniso);
      m.normalMap = makeTex(set.normal, false, aniso);
      m.roughnessMap = makeTex(set.rough, false, aniso);
      m.normalScale = new THREE.Vector2(packed ? 0.92 : 1.45, packed ? 0.92 : 1.45);
      m.emissive = new THREE.Color(0.62, 0.72, 0.92);
      m.emissiveMap = makeTex(set.sparkle, true, aniso);
      m.emissiveIntensity = packed ? 0.14 : 0.30;
    } else {
      m.color = new THREE.Color().setHex(packed ? 0xa8b0ba : 0xeaeff7, THREE.SRGBColorSpace);
      m.roughness = packed ? 0.72 : 0.62;
    }
    m.sheen = packed ? 0.26 : 0.70;
    m.sheenRoughness = 0.86;
    m.sheenColor = new THREE.Color().setHex(packed ? 0x9fb0c4 : 0xa9c6ea, THREE.SRGBColorSpace);
    m.name = packed ? 'snowbound_snow_packed' : 'snowbound_snow';
    return m;
  };

  LevelSnowbound.prototype._iceMaterial = function () {
    var m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setHex(0xb9d2e6, THREE.SRGBColorSpace),
      roughness: 0.13, metalness: 0.0, vertexColors: true,
      transparent: true, opacity: 0.72, envMapIntensity: 2.1,
      transmission: 0.0, side: THREE.DoubleSide, depthWrite: false
    });
    m.name = 'snowbound_ice';
    return m;
  };

  LevelSnowbound.prototype._litMaterial = function () {
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x2a1c0e, THREE.SRGBColorSpace),
      roughness: 0.30, metalness: 0.0, vertexColors: true,
      emissive: new THREE.Color().setHex(0xffa842, THREE.SRGBColorSpace),
      emissiveIntensity: 5.2, side: THREE.DoubleSide, fog: true
    });
    m.name = 'snowbound_lit';
    this._litMat = m;
    return m;
  };

  LevelSnowbound.prototype._decalMaterial = function () {
    var set = null;
    try { set = buildAtlas(this.rng.fork ? this.rng.fork(0xD3CA1) : this.rng); }
    catch (e) { GAME.logError('snowbound.atlas', e); set = null; }
    var tex = set && set.map ? set.map : null;
    this._atlas = tex;
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.80, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.04,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    if (set && set.normal) {
      m.normalMap = set.normal;
      // A print is a depression, so the bump is deliberately strong: this is
      // the whole difference between a stain lying on the snow and a hole cut
      // into it, and the snow's sheen lobe does the rim for free.
      m.normalScale = new THREE.Vector2(2.2, 2.2);
    }
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      var an = caps && caps.getMaxAnisotropy
        ? Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1)) : 1;
      if (tex) tex.anisotropy = an;
      if (set && set.normal) set.normal.anisotropy = an;
    } catch (e2) { /* nicety */ }
    m.name = 'snowbound_marks';
    return m;
  };

  // ---- colliders --------------------------------------------------------------
  LevelSnowbound.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
    var q = new THREE.Quaternion();
    if (euler) q.setFromEuler(euler);
    var c = {
      type: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'snow',
      floor: !!isFloor
    };
    this.colliders.push(c);
    return c;
  };

  // ---- build ------------------------------------------------------------------
  LevelSnowbound.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng;
    var B = new Builder();
    var i;

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('snowbound.' + name, e); }
    }

    stage('ground', function () { buildGround(self, rng); });
    await GAME.yieldFrame();

    stage('floorColliders', function () { self._buildFloor(); });
    stage('dachas', function () {
      self.builtDachas = [];
      for (var d = 0; d < self.plan.dachas.length; d++) {
        self.builtDachas.push(buildDacha(self, B, rng, self.plan.dachas[d]));
      }
    });
    await GAME.yieldFrame();

    stage('church', function () { self.builtChurch = buildChurch(self, B, rng); });
    stage('barn', function () { self.builtBarn = buildBarn(self, B, rng); });
    await GAME.yieldFrame();

    stage('convoy', function () {
      self.builtTrucks = [];
      for (var t = 0; t < self.plan.trucks.length; t++) {
        self.builtTrucks.push(buildTruck(self, B, rng, self.plan.trucks[t]));
      }
    });
    stage('bridge', function () { self.builtBridge = buildBridge(self, B, rng); });
    stage('wreck', function () { self.builtWreck = buildWreck(self, B, rng); });
    await GAME.yieldFrame();

    stage('rocks', function () { buildRocks(self, B, rng); });
    stage('furniture', function () { self.anchors.road.marks = buildRoadFurniture(self, B, rng); });
    stage('fences', function () { buildFences(self, B, rng); });
    await GAME.yieldFrame();

    stage('marks', function () { buildGroundMarks(self, B, rng); });
    stage('forest', function () { buildForest(self, rng); });
    await GAME.yieldFrame();

    stage('contact', function () { self.paintGroundContact(self._occluders); });
    stage('merge', function () { self._finalize(B); });
    await GAME.yieldFrame();

    stage('lights', function () { self._buildLights(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('nav', function () { self._buildNav(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    void i;
    return this;
  };

  LevelSnowbound.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.snow;
      if (key === 'decal') {
        this.material('decal');
        if (!this._atlas) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('snowbound.merge:' + key, e); continue; }
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('snowbound.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'snowbound_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'decal') mesh.renderOrder = 2;
      if (key === 'ice' || key === 'glazing') mesh.renderOrder = 1;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours are a plain albedo MULTIPLIER on every bucket (wearMode
  // 'multiply'), because nothing in this level wants the wet/grime wear
  // convention - it is a dry, frozen level and materials.js's wet path is not
  // even compiled here. What they do carry is the thing a merged bucket cannot
  // get any other way: per-piece value spread, plus a height-driven cool shift
  // on snow so a roof load and a drift agree about which way the sky is.
  LevelSnowbound.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = this.noise;
    var isSnow = (key === 'snow');
    var vi = 0, e, i, j;
    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var ny = na[j + 1];
        var r = tr * dk, g = tg * dk, b = tb * dk;
        var v = noise.fbm2(x * 0.55 + 3.0, z * 0.55 - 2.0, 2);
        if (isSnow) {
          // Up-facing snow keeps its full sky-lit albedo; a vertical face or an
          // underside is lit only by bounce off more snow, so it goes darker AND
          // bluer. This is the single term that stops every snow load in the
          // level reading as one flat white shape.
          var facing = M.saturate(ny * 0.5 + 0.5);
          var down = 1 - facing;
          r *= (0.80 + 0.20 * facing) * (1 + v * 0.030);
          g *= (0.845 + 0.155 * facing) * (1 + v * 0.026);
          b *= (0.925 + 0.075 * facing) * (1 + v * 0.020);
          // a touch of extra cool in the deepest undersides
          b *= 1 + down * 0.045;
        } else {
          var vv = 1 + v * 0.075;
          r *= vv; g *= vv; b *= vv;
          // everything picks up a cold cast from the sky it is standing under
          b *= 1.015;
        }
        col[j] = r; col[j + 1] = g; col[j + 2] = b;
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };
  // ---- contact rings -------------------------------------------------------
  // PUBLIC. Callers (this file, and props_snowbound from its commit pass) hand
  // in a list of {x, z, r} occluders - anything that stands ON the snow - and
  // this rasterises a sky-occlusion ring into the ground mesh's vertex colours.
  //
  // Why this exists at all: a post, a pail or a bench meeting lying snow with
  // no contact information photographs as a cutout pasted onto a white plane.
  // A vertical profile through a marker pole measured 0.437 +/- 0.004 for the
  // next 64 pixels beneath it - sixty-four pixels of mathematically flat snow
  // under a 1.55 m post. _settle() solves Y, and Y was never what the eye reads.
  //
  // The ring is BLUE-driven and proud on the windward side: what is being
  // removed at the foot of a standing object is skylight, and there is a drift
  // collar banked into it upwind. Accumulated as a MAX mask over a saved base
  // colour so repeated calls and overlapping props stay bounded.
  LevelSnowbound.prototype.paintGroundContact = function (list) {
    var F = this.field, geo = this._groundGeo;
    if (!F || !geo || !this._contactMask || !this._groundBaseCol) return 0;
    if (!list || !list.length) return 0;
    var mask = this._contactMask, base = this._groundBaseCol;
    var attr = geo.attributes.color;
    if (!attr) return 0;
    var col = attr.array;
    var touched = 0, k;
    for (k = 0; k < list.length; k++) {
      var o = list[k];
      if (!o || !isFinite(o.x) || !isFinite(o.z)) continue;
      var r = isFinite(o.r) ? Math.max(0.10, o.r) : 0.35;
      var reach = r * 1.55 + 0.62;
      var i0 = Math.max(0, Math.floor((o.x - reach - F.x0) / F.cell));
      var i1 = Math.min(F.w - 1, Math.ceil((o.x + reach - F.x0) / F.cell));
      var j0 = Math.max(0, Math.floor((o.z - reach - F.z0) / F.cell));
      var j1 = Math.min(F.h - 1, Math.ceil((o.z + reach - F.z0) / F.cell));
      for (var j = j0; j <= j1; j++) {
        var z = F.z0 + j * F.cell;
        for (var i = i0; i <= i1; i++) {
          var x = F.x0 + i * F.cell;
          var dx = x - o.x, dz = z - o.z;
          var d = Math.sqrt(dx * dx + dz * dz);
          if (d >= reach) continue;
          var t = 1 - M.smoothstep(r * 0.40, reach, d);
          t = t * t;
          // scoured on the lee, banked (and therefore brighter, so occluded
          // less) on the windward side - the ring is not a circle
          var lee = (dx * WIND_X + dz * WIND_Z) / Math.max(0.05, d);
          t *= 0.80 + 0.34 * M.saturate(lee);
          var kk = j * F.w + i;
          if (t > mask[kk]) { mask[kk] = t; touched++; }
        }
      }
    }
    if (!touched) return 0;
    for (k = 0; k < mask.length; k++) {
      var m0 = mask[k];
      if (m0 <= 0) continue;
      var q = k * 3;
      col[q] = base[q] * (1 - m0 * 0.46);
      col[q + 1] = base[q + 1] * (1 - m0 * 0.39);
      col[q + 2] = base[q + 2] * (1 - m0 * 0.24);
    }
    attr.needsUpdate = true;
    return touched;
  };

  // ---- ground sampling ---------------------------------------------------------
  LevelSnowbound.prototype.sampleGround = function (x, z) {
    var F = this.field;
    if (F) {
      var fx = (x - F.x0) / F.cell, fz = (z - F.z0) / F.cell;
      if (fx >= 0 && fz >= 0 && fx <= F.w - 1.001 && fz <= F.h - 1.001) {
        var i0 = fx | 0, j0 = fz | 0;
        var tx = fx - i0, tz = fz - j0;
        var a = F.a[j0 * F.w + i0], b = F.a[j0 * F.w + i0 + 1];
        var c = F.a[(j0 + 1) * F.w + i0], d = F.a[(j0 + 1) * F.w + i0 + 1];
        return M.lerp(M.lerp(a, b, tx), M.lerp(c, d, tx), tz);
      }
    }
    return snowY(x, z, this.plan);
  };

  // Thick floor slabs following the terrain. The player controller resolves
  // against colliders, not against sampleGround, so without these the valley
  // has no floor at all. 4 m tiles taking the MAXIMUM of their samples: a
  // player standing a few centimetres proud of a drift is invisible, a player
  // sunk into one is not.
  LevelSnowbound.prototype._buildFloor = function () {
    var step = 4.0;
    var x0 = -42, x1 = 42, z0 = -46, z1 = 62;
    for (var z = z0; z < z1; z += step) {
      for (var x = x0; x < x1; x += step) {
        var top = -1e9;
        for (var sj = 0; sj <= 2; sj++) {
          for (var si = 0; si <= 2; si++) {
            var y = this.sampleGround(x + si * step * 0.5, z + sj * step * 0.5);
            if (y > top) top = y;
          }
        }
        if (top < -1e8) continue;
        this.addCollider(x + step * 0.5, top - 1.2, z + step * 0.5,
          step * 0.5, 1.2, step * 0.5, 'snow', true);
      }
    }
  };

  // ---- the light rig -------------------------------------------------------
  // An overcast noon has no practicals in the open, and inventing a street lamp
  // here would be a lie. What a half-buried village at 11:00 in a blizzard does
  // have is INTERIOR light leaking out of the few houses still occupied, a
  // church full of candles, and the two trucks in the column that never got
  // switched off. Those are also the only warm marks in an entirely cold frame,
  // which is exactly what keeps grade_split positive without warming the snow.
  LevelSnowbound.prototype._buildLights = function () {
    var P = this.plan, i;
    var A = this.anchors;
    var pl = this.practicalLights = [];
    var rng = this.rng;

    for (i = 0; i < A.dachas.length; i++) {
      var d = A.dachas[i];
      if (!d.lit) continue;
      var out = new THREE.Vector3(-Math.sin(d.yaw), 0, -Math.cos(d.yaw));
      var px = d.centre.x + out.x * (d.d * 0.5 + 0.35);
      var pz = d.centre.z + out.z * (d.d * 0.5 + 0.35);
      pl.push({
        name: 'dacha_lamp_' + i, kind: 'tungsten',
        pos: [px, d.centre.y + 1.62, pz],
        kelvin: 2320, intensity: 26, distance: 11, dayBase: 0.95,
        cone: 1.05, penumbra: 0.55,
        aimPos: [px + out.x * 4.2, d.centre.y + 0.10, pz + out.z * 4.2],
        haloScale: 0.85, haloMax: 1.9, bulbR: 0.10, fixed: 1
      });
    }
    // the church: candlelight through the south door and the belfry openings
    if (A.church) {
      var C = this.builtChurch;
      var cand = (C && C.candles) || A.church.centre;
      pl.push({
        name: 'church_candles', kind: 'tungsten',
        pos: [cand.x, cand.y + 0.35, cand.z],
        kelvin: 1950, intensity: 30, distance: 15, dayBase: 1.0,
        haloScale: 1.15, haloMax: 2.4, bulbR: 0.12, fixed: 1
      });
      pl.push({
        name: 'church_door', kind: 'tungsten',
        pos: [A.church.door.x, A.church.floorY + 1.5, A.church.door.z],
        kelvin: 2150, intensity: 16, distance: 10, dayBase: 0.9,
        cone: 0.95, penumbra: 0.6,
        aimPos: [A.church.door.x + Math.sin(A.church.yaw) * 4,
          A.church.floorY, A.church.door.z + Math.cos(A.church.yaw) * 4],
        haloScale: 0.8, haloMax: 1.8, bulbR: 0.09, fixed: 1
      });
    }
    // the two trucks still burning their headlights
    var T = this.builtTrucks || [];
    for (i = 0; i < T.length; i++) {
      if (!T[i].lights) continue;
      var t = T[i];
      var pair = [t.headlightL, t.headlightR];
      for (var h = 0; h < 2; h++) {
        pl.push({
          name: t.name + '_hl' + h, kind: 'tungsten',
          pos: [pair[h].x, pair[h].y, pair[h].z],
          kelvin: 3150, intensity: 230, distance: 42, dayBase: 1.0,
          cone: 0.30, penumbra: 0.48,
          aimPos: [t.aim.x, t.aim.y, t.aim.z],
          haloScale: 1.05, haloMax: 2.2, haloGain: 0.55,
          bulbR: 0.16, bulbFlat: 0.55, fixed: 1
        });
      }
    }
    // the hazard lamp on the barrier at the broken bridge
    var Bg = this.builtBridge;
    if (Bg && Bg.barrier) {
      // Turned right down. At intensity 34 over a 16 m radius this sodium lamp
      // put a warm pool on the carriageway measuring RGB (0.537, 0.487, 0.483)
      // at saturation 0.101 in a frame whose global saturation is 0.055 - the
      // most chromatic thing on screen, in a level briefed white and pale blue,
      // and it read as a desert-sand material rather than as a hazard lamp. A
      // 20 W amber beacon at eleven in the morning under a bright overcast
      // barely marks the snow, which is what it does now: it reads as a source
      // (the lens is still emissive) without repainting eight square metres of
      // road.
      pl.push({
        name: 'bridge_hazard', kind: 'sodium',
        pos: [Bg.barrier.x + 3.2, Bg.barrier.y + 0.45, Bg.barrier.z],
        kelvin: 2280, intensity: 8, distance: 7.5, dayBase: 0.35,
        haloScale: 0.75, haloMax: 1.4, bulbR: 0.10, fixed: 1
      });
    }

    // ---- shafts ------------------------------------------------------------
    // Downward apertures only. An overcast sky has no beam in the open air -
    // publishing one outdoors would be the level arguing with its own weather -
    // so the two entries here are the two holes in a roof, and both of them are
    // holes the geometry actually has.
    var shafts = this.lightShafts = [];
    if (this.builtChurch && this.builtChurch.holeAbove) {
      shafts.push({
        kind: 'church_hole',
        origin: this.builtChurch.holeAbove.clone(),
        dir: new THREE.Vector3(0.10, -1, 0.06).normalize(),
        width: 3.1, length: 9.5, strength: 1.0
      });
    }
    for (i = 0; i < A.dachas.length; i++) {
      if (!A.dachas[i].ruin) continue;
      var dd = A.dachas[i];
      shafts.push({
        kind: 'dacha_hole_' + i,
        origin: new THREE.Vector3(dd.centre.x, dd.ridge - 0.4, dd.centre.z + 1.2),
        dir: new THREE.Vector3(0.05, -1, 0.05).normalize(),
        width: 2.4, length: 7.0, strength: 0.8
      });
      break;
    }
    void rng;
  };

  // ---- spawns and the published framings -------------------------------------
  LevelSnowbound.prototype._buildSpawns = function () {
    var self = this;
    var A = this.anchors;
    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + (yOff || 0.03), z), yaw: yaw
      });
    }
    // [0] is the player: the southern end of the pass, in the carriageway,
    // looking north up it with the whole convoy ahead.
    sp(roadX(52) + 1.1, 52, 0.04);
    sp(roadX(44) - 2.0, 44, 0.02);
    sp(roadX(33) + 2.4, 33, -0.10);
    sp(roadX(24) - 2.2, 24, 0.08);
    sp(roadX(14) + 2.6, 14, 0.05);
    sp(roadX(4) - 2.4, 4, 0.0);
    sp(roadX(-8) + 2.2, -8, 3.10);
    sp(roadX(-16) - 2.0, -16, 3.05);
    sp(A.church.door.x + 1.2, A.church.door.z + 1.4, 3.14);
    sp(A.dachas[2].doorOuter.x, A.dachas[2].doorOuter.z, 1.55);
    sp(A.dachas[5].doorOuter.x, A.dachas[5].doorOuter.z, -1.55);
    sp(A.barn.centre.x - 3.0, A.barn.centre.z + 4.0, 2.4);
    sp(roadX(BR_NEAR + 6) - 2.6, BR_NEAR + 6, 3.14);

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

    // ---- HERO1 : the signature image ---------------------------------------
    // Standing in the carriageway at the tail of the convoy, on the east wheel
    // track, looking north up the pass. Everything the level is about is in one
    // frame and each element is at a DIFFERENT depth, which is what stops a
    // whiteout collapsing into a flat wash:
    //   *  6 m : the tailgate and snow-loaded tilt of the last truck, left of
    //            centre, the darkest mass in the frame
    //   *  4 m : the plough berm and the first marker posts on the right, the
    //            leading line, running away on the road's own curve
    //   * 15-40 m : three more trucks nose to tail, the middle one burnt out
    //   * 22 m : dachas either side with lit windows - the only warm marks
    //   * 44 m : the church tower, the one thing that survives the whiteout
    //   * 70 m+ : the pines and the far valley dissolving into white
    // The eye is 1.5 m to the east of the road centre so the column is not
    // symmetrical about the frame, and the aim point is the third truck rather
    // than the vanishing point, which puts the tower on the left third.
    // RE-SOLVED. The published mark stood 1.1 m off the road centre at eye
    // height and aimed down it, which produced the most generic composition
    // available: two near-identical dachas mirroring each other left and right
    // at the same depth, the road dead down the middle, and the church dome
    // occupying the vanishing point. A bilaterally symmetric one-point
    // corridor with no foreground, no depth layering and no diagonal - and,
    // masking the viewmodel, a world histogram of p05 0.317 / p50 0.556 /
    // p95 0.790 with 0.89% of pixels below 0.25. The frame had no darks; the
    // published dynamic range came entirely from a black rifle in the corner.
    //
    // The symmetry is broken at the POSE, not by moving the village:
    //   * 6.2 m WEST of the road centre, i.e. up on the plough berm, and the
    //     eye dropped to 1.52 - so the carriageway is seen across rather than
    //     along, and enters bottom-RIGHT at 39 degrees off axis and sweeps to
    //     9 degrees left in the distance. A diagonal, not a corridor.
    //   * the burnt wreck at 7 m and 26 degrees LEFT: a near-field black mass
    //     in the left third, low enough that the church tower (33 degrees left,
    //     41 m, dome 24 degrees up) rises clear above it. Foreground / convoy /
    //     landmark now sit in three separate depth planes.
    //   * the burnt dacha 32 m out on the right at 19 degrees, so the two
    //     darkest things in the level are on opposite thirds.
    var h1z = 52.2;
    var h1x = roadX(h1z) - 6.2;
    g = this.sampleGround(h1x, h1z);
    var hero1 = pose(h1x, g + 1.52, h1z, roadX(20) + 2.2, 3.0, 20.0);

    // ---- HERO2 : the collapsed bridge ---------------------------------------
    // On the surviving cantilever, 3 m short of where it tears off, looking
    // across 6.4 m of nothing at the far stub. Foreground is the torn slab, the
    // bent rebar and a parapet post that has folded over the edge; behind that
    // the gorge drops 12 m to the fallen span, and behind THAT the far bank
    // goes to white. Pitched 9 degrees down so the hole is the subject rather
    // than the sky.
    // RE-SOLVED, off the deck entirely. Standing ON the cantilever and looking
    // straight up the road put the far stub at eye level and the ravine
    // underneath the frame: the deck filled two thirds of the picture and the
    // 12.5 m hole - the entire subject - was a pale band behind it. From the
    // bank 17 m to the south-west the same structure is seen ACROSS its own
    // span, so the torn edge, the bent girders, the fallen centre section in
    // the bottom and the far abutment stack in depth, and the gorge is a real
    // void under all of it instead of a horizon.
    // Three marks and the third is the one that works, so all three are worth
    // recording. ON the cantilever put the far stub at eye level and the hole
    // under the frame. On the bank 14 m WEST it stood inside the last dacha -
    // the church nave occupies z -9.8..+5.8 right across that side. Out in the
    // snowfield 16 m EAST it was clear, but at 21 m the bridge was a detail.
    //
    // The answer is the APPROACH: on the carriageway 15 m short of the torn
    // edge, on its east side. The striped road barrier is 5 m out and is the
    // only saturated thing in the northern half of the level; the parapet, the
    // kerb and the marker line converge on the break; the break itself is at
    // 15.6 m, which is close enough to read the bent rebar; and beyond it the
    // gorge, the fallen span and the far abutment go away into white. A
    // leading line that ends in a hole.
    //
    // RE-SOLVED AGAIN, on standoff and pitch rather than position. At z = -12
    // aiming 0.9 m BELOW the deck the camera was pitched 10.6 degrees down at a
    // 15 m target, which put the whole subject - the barrier line - into a thin
    // horizontal band at the horizon and gave the lower 55% of the frame to
    // featureless rippled carriageway. Backing off to z = -6.5 puts the
    // checkpoint at 10 m instead of 4, so it occupies the middle third; aiming
    // at DECK level instead of under it takes the pitch to about 4 degrees, so
    // the gorge sits behind the barrier rather than under the frame.
    var h2z = -6.5;
    var h2x = roadX(h2z) + 2.6;
    var h2g = this.sampleGround(h2x, h2z);
    var hero2 = pose(h2x, h2g + 1.74, h2z,
      roadX(BR_TORN) + 0.4, roadY(BR_TORN) + 0.55, BR_TORN);

    // ---- HERO3 : the church, and the verticality ---------------------------
    // From the shovelled path in front of the tower, close in and pitched UP so
    // the belfry and the onion dome sit in the top third against the cloud. The
    // porch drift and the path are the foreground, the tower is the subject, and
    // the nave roof's snow load runs away to the right as the leading line.
    // SOLVED, NOT GUESSED - and it is worth recording why, because the first
    // two marks were both arithmetic that ignored the village.
    //
    // The tower is 20.6 m from ground to cross, so the standoff is set by the
    // lens: under about 20 m the dome leaves the top of a 75-degree frame. Both
    // hand-picked marks at that radius landed against a building - the second
    // one 0.35 m from the third dacha's porch, so the "landmark" framing
    // photographed a gable end from touching distance.
    //
    // So the mark is SEARCHED instead, over the fan of bearings that face the
    // tower from the south and east (the side the player approaches from) and
    // over 20-30 m of standoff. A candidate is rejected if it stands inside
    // 4.5 m of any structure, or if the sightline to the tower passes within
    // 2.6 m of one - that second test is the one that matters, because a mark
    // can be in clear air and still be looking through a dacha. Among what
    // survives it prefers the largest clearance at close to 24 m.
    var ch = A.church;
    var P3 = this.plan;
    function clearOf(x, z) {
      var best = 1e9;
      for (var q = 0; q < P3.rects.length; q++) {
        var r3 = P3.rects[q];
        var dx3 = x - r3.x, dz3 = z - r3.z;
        var lx3 = dx3 * r3.c + dz3 * r3.s, lz3 = -dx3 * r3.s + dz3 * r3.c;
        var ox3 = Math.abs(lx3) - r3.hx - 1.2, oz3 = Math.abs(lz3) - r3.hz - 1.2;
        var d3 = (ox3 < 0 && oz3 < 0) ? -Math.min(-ox3, -oz3)
          : Math.sqrt(Math.max(0, ox3) * Math.max(0, ox3) + Math.max(0, oz3) * Math.max(0, oz3));
        if (d3 < best) best = d3;
      }
      return best;
    }
    // ...and clear of the forest. buildForest runs before this, so the trunk
    // list is available: a 700-tree treeline can put a spruce two metres off a
    // candidate mark, and a conifer crown at that range fills a third of the
    // frame with its own construction.
    var TXZ = this.treeXZ || [];
    function clearOfTrees(x, z, want) {
      for (var q = 0; q < TXZ.length; q += 3) {
        var dx4 = x - TXZ[q], dz4 = z - TXZ[q + 1];
        if (dx4 * dx4 + dz4 * dz4 < want * want) return false;
      }
      return true;
    }
    // The occlusion probe must stop SHORT of the subject. Walking it all the
    // way to the tower meant its last samples were inside the church's own
    // footprint, so every candidate in the fan measured as blocked, the search
    // returned nothing, and the fallback mark stood 2.3 m off the flank of a
    // truck. It now stops at 0.66 of the run - past every other structure,
    // short of the one being photographed.
    //
    // 17 m rather than 24: the village is dense and the clear ground near the
    // church is the shovelled path, so the honest answer is to go LOW and
    // CLOSE. At 17 m with the aim 3.5 m above the eaves the cross sits 22
    // degrees above centre and the porch 32 below - the whole 20.6 m landmark
    // in frame, from underneath, which is what "shows verticality" means.
    var bestPose = null, bestScore = -1e9;
    for (var bAng = -0.40; bAng < 2.65; bAng += 0.05) {
      for (var bD = 14.0; bD <= 26.0; bD += 0.75) {
        var cxp = ch.tower.x + Math.sin(bAng) * bD;
        var czp = ch.tower.z + Math.cos(bAng) * bD;
        if (cxp < X_MIN + 6 || cxp > X_MAX - 6 || czp < Z_MIN + 6 || czp > Z_MAX - 6) continue;
        var cl = clearOf(cxp, czp);
        if (cl < 3.4) continue;
        if (!clearOfTrees(cxp, czp, 4.2)) continue;
        var minSight = 1e9;
        var sightTrees = true;
        for (var st = 0.10; st < 0.67; st += 0.05) {
          var sxp = M.lerp(cxp, ch.tower.x, st), szp = M.lerp(czp, ch.tower.z, st);
          var sc = clearOf(sxp, szp);
          if (sc < minSight) minSight = sc;
          if (st < 0.30 && !clearOfTrees(sxp, szp, 2.4)) sightTrees = false;
        }
        if (minSight < 2.0 || !sightTrees) continue;
        var score = Math.min(cl, 8) - Math.abs(bD - 17.0) * 0.55 + Math.min(minSight, 8) * 0.40;
        if (score > bestScore) { bestScore = score; bestPose = [cxp, czp]; }
      }
    }
    var h3x = bestPose ? bestPose[0] : (A.church.pathEdge.x + ch.tower.x) * 0.5;
    var h3z = bestPose ? bestPose[1] : (A.church.pathEdge.z + ch.tower.z) * 0.5;
    g = this.sampleGround(h3x, h3z);
    var hero3 = pose(h3x, g + 1.64, h3z, ch.tower.x, A.church.eave + 3.5, ch.tower.z);

    // ---- INTERIOR : the church nave ----------------------------------------
    // Just inside the tower arch, looking north down the nave. The shell hole
    // in the roof is 9 m ahead and slightly right, so its shaft and the cone of
    // drifted snow under it land on the middle third; the two nearer piers
    // frame the shot; the iconostasis closes the far end.
    var interior;
    if (this.builtChurch && this.builtChurch.interiorEye) {
      var ie = this.builtChurch.interiorEye, it = this.builtChurch.interiorTarget;
      interior = pose(ie.x, this.anchors.church.floorY + 1.64, ie.z, it.x, it.y, it.z);
    } else {
      interior = pose(ch.centre.x, ch.floorY + 1.64, ch.centre.z + 6,
        ch.centre.x, ch.floorY + 1.5, ch.centre.z - 6);
    }

    // ---- OVERVIEW ----------------------------------------------------------
    // From the rock ledge on the east buttress, 12 m above the carriageway,
    // looking WSW down the valley. The boulders and a pine on the ledge give it
    // a hard foreground inside 6 m - which is the single thing the harbor's
    // first overview lacked - and from here the road's whole serpentine, the
    // convoy, the village and the church tower stack in depth instead of
    // presenting as roofs.
    // RE-SOLVED. From the middle of the ledge looking due west the frame was
    // four grey pitched roofs stacked over each other in the lower half, an
    // untextured church in the middle and a wash of pale trees above: 77.4% of
    // pixels inside a single 0.25-wide luminance band, no ground visible
    // anywhere, and an establishing shot that established nothing.
    //
    // An overview of THIS level has to show the three things that make it
    // legible - the road, the convoy and the gorge - so the mark moves 10 m
    // south along the same ledge (still inside its own pad, so the standpoint
    // is still flat) and aims 40 degrees west at the closed bridge. The
    // carriageway then runs as a dark diagonal from the lower left, with two
    // trucks on it at 28 and 31 m, past the roof of the nearest dacha, to the
    // barrier and the torn edge at 47 and 56 m; the church tower stands 35
    // degrees left at 46 m; and the fog stages ITSELF, because the near
    // village is now at 13-18 m, the landmark at 46 and the treeline beyond 90.
    var lg = A.ledge;
    var LP = this.plan.ledge;
    var overview = pose(LP.eyeX, lg.top + 1.75, LP.eyeZ, LP.aimX, LP.aimY, LP.aimZ);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior,
      // kept so an operator can ask for them by the level's own names too
      road: hero1, bridge: hero2, church: hero3
    };
  };

  // ---- nav ---------------------------------------------------------------------
  LevelSnowbound.prototype._buildNav = function () {
    var cell = 0.85;
    var ox = -42, oz = -46;
    var w = Math.ceil((42 - ox) / cell);
    var h = Math.ceil((62 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var obst = [], i;
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      var he = c.halfExtents, ce = c.center;
      obst.push([ce.x - he.x - 0.32, ce.x + he.x + 0.32, ce.z - he.z - 0.32, ce.z + he.z + 0.32,
        ce.y - he.y, ce.y + he.y]);
    }
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var u = Math.abs(x - roadX(z));
        var idx = iz * w + ix;
        var y = this.sampleGround(x, z);
        height[idx] = y;
        // the gorge and the upper valley walls are not walkable
        if (u > 30) continue;
        if (Math.abs(z - (GORGE_Z + 2.6 * Math.sin(x * 0.055))) < GORGE_HALF * 0.95 &&
          !(z > BR_NEAR - 1.0 && z < BR_TORN + 0.5 && u < 5.0)) continue;
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          if (o[5] > y + 0.40 && o[4] < y + 1.80) { ok = 0; break; }
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

  // ---- broadphase + raycast ------------------------------------------------------
  LevelSnowbound.prototype._buildBroadphase = function () {
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

  LevelSnowbound.prototype.raycast = function (origin, dir, maxDist) {
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

  // ---- per frame ------------------------------------------------------------------
  // The pass is static. What is not is the light inside it: every lit pane in
  // the village is a kerosene lamp or a stove, and a perfectly steady emissive
  // rectangle in a frame where everything else is moving is the tell. One
  // shared material, so this is a single uniform write per frame.
  LevelSnowbound.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);
    var m = this._litMat;
    if (!m) return;
    var t = this._t;
    var f = 0.86 + 0.10 * Math.sin(t * 2.7) + 0.06 * Math.sin(t * 6.31 + 1.7) +
      0.05 * Math.sin(t * 11.9 + 0.4);
    // a gust squeezes the flame - read off the weather rather than invented, so
    // the flicker and the snow surge together
    var gust = 0;
    try {
      if (ctx && ctx.weather && isFinite(ctx.weather.windSpeed)) {
        gust = M.saturate((ctx.weather.windSpeed - 9.0) / 9.0);
      }
    } catch (e) { gust = 0; }
    m.emissiveIntensity = 5.2 * (f + gust * 0.14 * Math.sin(t * 8.3));
  };

  GAME.LevelSnowbound = LevelSnowbound;
})(window.GAME, window.THREE);
