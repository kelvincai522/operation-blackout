// ============================================================================
// OPERATION BLACKOUT - src/world/level_jungle.js  ->  GAME.LevelJungle
//
// "MEKONG DELTA": dense tropical growth around a river and a ruined firebase.
// Midday, humid drizzle, filtered canopy light, saturated green. The deliberate
// opposite of every other level in the roster on every axis - it is the only
// ORGANIC space in the build, the only one whose dominant material is alive,
// and the only one whose occlusion is soft rather than architectural.
//
// THE PLAN, in world coordinates. -Z is upriver/north; the player lands at the
// southern end of the track and works north to the firebase.
//
//   x = -42 .. -14    THE RIVER, a sinuous brown channel 20-26 m wide. It is
//                     the level's only open sky and therefore its only bright
//                     floor: a horizontal band of reflected cloud low in every
//                     framing that looks west.
//   x = -14 .. -4     the east bank: mangrove roots, mud shelf, elephant grass
//   x =  -4 ..  +8    THE TRACK, a rutted mud road from z = +60 to the firebase
//   z = +26           THE CREEK and the collapsed bamboo footbridge, plus the
//                     French sluice headwall where the creek meets the river
//   (-14, +10)        THE DOWNED HUEY, nose in the shallows, tail on the bank,
//                     reclaimed by growth. hero2's subject.
//   (11, -24)         THE FIREBASE on its knoll: sandbag perimeter, command
//                     bunker (sunk, shell-holed roof), watchtower on stilts,
//                     mortar pit, PSP helipad, comms mast.
//   |x| > 30, |z| > 46  the forest wall and the rising ground that closes it
//
// ============================================================================
// FOLIAGE IS THE MATERIAL, AND IT IS AUTHORED HERE
// ============================================================================
// materials.js has one foliage recipe and it is DRY MEDITERRANEAN - small hard
// leaves, dust tints, a yellow-olive palette. That is the wrong plant and the
// wrong hemisphere, so this file generates its own two-material set:
//
//   BLADE  solid, two-sided, NO alpha cut. Every piece of foliage the player
//          can walk up to - elephant grass, fern pinnae, banana, taro, palm
//          leaflets - is real ribbon geometry with a folded midrib, because
//          DEVELOPMENT.md's third-ranked weak point is "foliage is alpha-tested
//          cards; it does not hold up close" and the understory of a jungle
//          level is, by definition, the thing closest to the camera.
//   CANOPY alpha-cut cards, used ONLY above 8 m where nothing is ever seen at
//          arm's length: the canopy tiers, hanging lianas, dead fronds.
//
// Both carry an emissiveMap keyed to their own albedo at low intensity. That is
// the cheap honest read of leaf translucency: a leaf in shade never goes black,
// which is the instant tell, and at 0.09 intensity it is 5% of a lit leaf and
// invisible where the light already is.
//
// THE FOREST IS FOUR STRATA, and a forest reads as DEPTH only when it has all
// of them. Each is its own scatter pass and each one exists because the frame
// measurably lacked it:
//
//   LITTER      0-0.1 m   scatterLitter  -> `deadleaf`, real fallen-leaf drifts.
//               The floor is 30-40% of every exterior framing and was carrying
//               its whole information budget in one 39 cm triplanar tile.
//   UNDERSTORY  0-2 m     scatterUnderstory -> grass, fern, taro, banana.
//   MID-STOREY  1.5-6 m   scatterMidstorey  -> the SAME kinds at 1.5-3x, plus
//               palms. Costs no new draw calls and is what closed the two-to-nine
//               metre hole that made every middle distance a milky void.
//   CANOPY      9.5-30 m  scatterCanopy     -> alpha cards, three tiers, with a
//               ring over the firebase cut and a margin over the river so the
//               canopy horizon has no holes in it.
//
// "Saturated green must not become a flat green wash." The value range is built
// in four independent places so no single one has to carry it:
//   * the CANOPY is cool and dark, the UNDERSTORY warm and light - foliage
//     vertex colour runs a warm/cool ramp on height, not just a value ramp
//   * the ground is painted by sky exposure: bright in the clearings, the track
//     and the water's edge, deep and cold under closed canopy
//   * four light shafts land as FIXTURES (lux, not solar), so the pools exist
//     whatever the overcast does to the sun
//   * the only non-green things in the level - the river, the bleached
//     sandbags, the aluminium of the wreck, the shrine's candles - are placed
//     where the framings put them, not scattered
//
// ============================================================================
// THE PLACEMENT CONTRACT  -  `level.anchors`
// ============================================================================
// Published by the CONSTRUCTOR, so props_jungle.js can read it the instant the
// object exists and never has to wait for build().
//
//   anchors.delta      { x0,x1,z0,z1, waterY, groundY(x,z), riverC(z),
//                        riverHalf(z), trackX(z), wind }
//   anchors.river      { waterY, centre(z), half(z), eastEdge(z), westEdge(z) }
//   anchors.track      { half, centre(z), pts, gate }
//   anchors.spawn      { position, yaw }
//   anchors.firebase   { centre, yaw, radius, topY, gate, breach, mortarPit,
//                        helipad{centre,r}, mast, drum, perimeter[] }
//   anchors.bunker     { centre, yaw, w, d, floorY, roofY, door, holeAbove,
//                        holeFloor, interiorEye, interiorTarget }
//   anchors.tower      { base, platform, roof, yaw, legR }
//   anchors.heli       { centre, yaw, nose, tail, rotorHub, doorSill, beacon }
//   anchors.creek      { half, centreZ(x), floorY, bridge{nearLip,farLip,deckY} }
//   anchors.sluice     { centre, yaw, topY, mouth }
//   anchors.shrine     { centre, yaw, topY, candle }
//   anchors.trees      [ {centre, r, height, canopyY, buttress} ]
//   anchors.clearings  [ {centre, r} ]        - where sky reaches the floor
//   anchors.logs       [ {a, b, r} ]          - fallen trunks
//
//   DO NOT derive a world position from `level.cameraPoses`. A pose is a
//   COMPOSITION and moves whenever the composition improves; the harbor build
//   put fixtures in corridors that had stopped existing exactly that way.
//
// Also published, all consumed generically:
//   level.practicalLights   the shrine candles, the firebase brazier, the
//                           bunker lantern and worklight, the wreck's beacon.
//                           A midday jungle has almost no practicals and
//                           inventing street lighting would be a lie - these
//                           five are all things that burn regardless of hour,
//                           and every one of them has visible geometry.
//   level.lightShafts       five canopy gaps plus the bunker's shell hole,
//                           published with `lux` so they are FIXTURES: the sky
//                           preset is 'overcast', so a shaft gated on the solar
//                           disc would simply not exist, and "light arrives as
//                           shafts filtered through canopy" is the first line of
//                           the brief. The five live in shaftSpecs() as DATA, and
//                           shaftPool() paints their landing into the floor light
//                           bake, the per-instance plant tint and the merged
//                           bucket colour - because lighting.js fades a haze cone
//                           to nothing over its last 22% and the spot's few lux
//                           against an overcast dome is a third of a stop, so
//                           without the pool the shafts hang in the air.
//   level.dripEdges         leaf tips and eaves that weather.js hangs its drip
//                           ropes from. The brief puts the water ON THE LEAVES.
//   level.foliage           THE FOLIAGE KIT. The two materials, the atlas cell
//                           table, and the generators that made every leaf in
//                           the level - so props_jungle grows the SAME plant
//                           rather than authoring a second, subtly different
//                           green. See the constructor.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var X_MIN = -62, X_MAX = 58;
  var Z_MIN = -58, Z_MAX = 66;

  var WATER_Y = 0.0;
  var CH_DEPTH = 2.55;          // river bed below the surface, mid-channel
  var BANK_H = 3.05;            // bank crest above the water
  var KNOLL_H = 4.35;           // the firebase sits on this

  var TRACK_HALF = 2.45;        // rutted carriageway half-width
  var TRACK_SHOULDER = 4.3;     // where the flattening blends out

  var CREEK_Z = 26.0, CREEK_HALF = 3.9, CREEK_DEPTH = 2.15;

  var FB_X = 11.0, FB_Z = -24.0, FB_R = 17.4, FB_YAW = 0.26;

  // Drizzle blows toward (0.70, 0.71) at 1.6 m/s (weather.js PRESETS.drizzle
  // takes its default wind vector from the library). Nearly still air under a
  // canopy - what moves is the mist, not the drops - so this only decides which
  // way the lianas hang and which flank of a trunk carries the wet streak.
  var WIND_X = 0.70, WIND_Z = 0.71;

  var UP = new THREE.Vector3(0, 1, 0);

  // ---------------------------------------------------------------- surface --
  // `uv` is world metres -> uv for the planar entries; the triplanar library
  // materials (dirt, concrete, stone, rubble) project in world space and ignore
  // it. `own` marks a surface generated in this file. `base` is the library
  // name to fall back on, `col` the colour forced onto the fallback so an olive
  // airframe never renders grey.
  var SURF = {
    mud:        { uv: 0.50, cast: false, recv: true, own: 'mud' },
    silt:       { uv: 0.50, cast: false, recv: true, own: 'silt' },
    water:      { uv: 0.25, cast: false, recv: false, own: 'water' },

    bark:       { uv: 1.00, cast: true,  recv: true, own: 'bark', keepUV: true },
    blade:      { uv: 1.00, cast: true,  recv: true, own: 'blade', keepUV: true },
    canopy:     { uv: 1.00, cast: true,  recv: true, own: 'canopy', keepUV: true },
    lit:        { uv: 1.00, cast: false, recv: false, own: 'lit', keepUV: true },
    lit2:       { uv: 1.00, cast: false, recv: false, own: 'lit2', keepUV: true },
    mark:       { uv: 1.00, cast: false, recv: true,  own: 'mark', keepUV: true },
    puddle:     { uv: 1.00, cast: false, recv: false, own: 'puddle', keepUV: true },

    // Raw red subsoil. materials.js's `dirt` was authored as WARM DESERT SOIL,
    // which is the wrong floor for a rainforest (hence _mudMaterial's
    // albedoTarget re-solve) and exactly the right cut face for a laterite
    // bank - so this entry takes the library material as it comes.
    laterite:   { uv: 0.55, cast: true,  recv: true, base: 'dirt',
                  col: 0xa5522a, rough: 0.95, metal: 0.0 },
    timber:     { uv: 0.80, cast: true,  recv: true, base: 'wood_plank',
                  col: 0x6a583f, rough: 0.92, metal: 0.0 },
    timber_wet: { uv: 0.62, cast: true,  recv: true, base: 'wood_plank',
                  col: 0x3c3327, rough: 0.94, metal: 0.0 },
    bamboo:     { uv: 1.30, cast: true,  recv: true, base: 'wood_plank',
                  col: 0x9a9663, rough: 0.72, metal: 0.0 },
    // keepUV, and it is load-bearing. Without it _finalize runs
    // Geo.worldUV(geo, 0.95) over the merged bucket and the hessian weave is
    // projected from the WORLD AXES: on a pillow whose surface faces every
    // direction that shears across the curve and lands as a hard-edged
    // rectangular patch on some bags and not others - which is exactly what the
    // hero3 and interior crops photographed, a wall of cardboard egg-carton
    // cells with grid patches floating on them. bagGeo now authors its own
    // parametric uv scaled so the weave wraps AROUND the bag.
    // albedoTarget 0x6e6d54: the library's hessian is authored for a DRY
    // desert emplacement and rendered at 0.18 linear with R-B = +0.13, so the
    // perimeter and the mortar ring photographed from the tower as a chain of
    // pale pink lozenges lying on a green field. A sandbag that has been in a
    // monsoon for two years is algae-stained olive drab at about 0.15.
    sandbag:    { uv: 0.95, cast: true,  recv: true, base: 'sandbag',
                  col: 0x8b8161, rough: 0.96, metal: 0.0, keepUV: true,
                  alb: 0x6e6d54 },
    concrete:   { uv: 0.40, cast: true,  recv: true, base: 'concrete',
                  col: 0x7f8076, rough: 0.94, metal: 0.0 },
    stonework:  { uv: 0.34, cast: true,  recv: true, base: 'stone',
                  col: 0x6f7168, rough: 0.93, metal: 0.0 },
    // RUST IS AN OXIDE, AND AN OXIDE IS A DIELECTRIC. The library def carries
    // metalness 0.70, which is right for bare steel and wrong for something
    // that has stood ten monsoons: it throws away 70% of the diffuse response
    // on objects whose entire read in an overcast forest is diffuse, and the
    // six oil drums in the establishing shot photographed as near-black
    // cylinders at 0.026 luminance against mud at 0.112. `metalness` is a
    // hashed option so this gets its own cache entry - no other level is
    // touched.
    rust:       { uv: 0.85, cast: true,  recv: true, base: 'rusted_metal',
                  col: 0x6b4229, rough: 0.90, metal: 0.55, metalness: 0.26,
                  alb: 0x7d5a42 },
    // CONCERTINA WIRE, AND IT DOES NOT CAST. 132 coils x 7 rods at r = 0.018 m
    // is ~900 sub-texel casters shoved into the cascaded shadow map, and what
    // comes back is not a shadow - it is a barcode of quantised shadow-map
    // texels lying across the firebase field at 15:1 contrast with zero
    // penumbra, measured on adjacent pixels of the same mud in lv_overview.
    // That is ARCHITECTURE.md 9's "hard-edged aliased shadows" and 7.6's "flat
    // black shadows" in one object, in the establishing shot. The wire keeps
    // its ground contact through painted mark cards instead (see buildFirebase).
    wire:       { uv: 0.85, cast: false, recv: true, base: 'rusted_metal',
                  col: 0x6b4229, rough: 0.90, metal: 0.55, metalness: 0.26,
                  alb: 0x7d5a42 },
    tin:        { uv: 0.72, cast: true,  recv: true, base: 'corrugated_metal',
                  col: 0x5e5c50, rough: 0.78, metal: 0.60 },
    olive:      { uv: 0.90, cast: true,  recv: true, base: 'paint_green',
                  col: 0x3d4634, rough: 0.68, metal: 0.42 },
    alu:        { uv: 0.90, cast: true,  recv: true, base: 'painted_metal',
                  col: 0x767a72, rough: 0.52, metal: 0.72 },
    canvas:     { uv: 1.00, cast: true,  recv: true, base: 'canvas_awning',
                  col: 0x5c5b44, rough: 0.95, metal: 0.0 },
    rope:       { uv: 2.00, cast: true,  recv: true, base: 'rope',
                  col: 0x6a604c, rough: 0.95, metal: 0.0 },
    rubber:     { uv: 1.30, cast: true,  recv: true, base: 'rubber',
                  col: 0x1b1d1d, rough: 0.92, metal: 0.0 },
    glazing:    { uv: 0.60, cast: false, recv: false, base: 'glass',
                  col: 0x8fa0a2, rough: 0.12, metal: 0.0, env: 1.4 }
  };

  // If materials.js is unavailable entirely the delta must still read as a
  // green river valley rather than as magenta error boxes.
  var FALLBACK = {
    mud:        [0x3b3a26, 0.95, 0.0],
    silt:       [0x4a412c, 0.93, 0.0],
    water:      [0x1d2417, 0.10, 0.0],
    bark:       [0x4a4438, 0.93, 0.0],
    blade:      [0x40632c, 0.62, 0.0],
    canopy:     [0x33501f, 0.70, 0.0],
    lit:        [0xffb060, 0.30, 0.0],
    lit2:       [0xff3018, 0.30, 0.0],
    mark:       [0x6a6046, 0.92, 0.0],
    puddle:     [0x0d1210, 0.06, 0.0],
    laterite:   [0xa5522a, 0.95, 0.0],
    timber:     [0x6a583f, 0.92, 0.0],
    timber_wet: [0x3c3327, 0.94, 0.0],
    bamboo:     [0x9a9663, 0.72, 0.0],
    sandbag:    [0x8b8161, 0.96, 0.0],
    concrete:   [0x7f8076, 0.94, 0.0],
    stonework:  [0x6f7168, 0.93, 0.0],
    rust:       [0x6b4229, 0.90, 0.55],
    wire:       [0x6b4229, 0.90, 0.55],
    tin:        [0x5e5c50, 0.78, 0.60],
    olive:      [0x3d4634, 0.68, 0.42],
    alu:        [0x767a72, 0.52, 0.72],
    canvas:     [0x5c5b44, 0.95, 0.0],
    rope:       [0x6a604c, 0.95, 0.0],
    rubber:     [0x1b1d1d, 0.92, 0.0],
    glazing:    [0x8fa0a2, 0.12, 0.0]
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
    if (bevel === undefined) bevel = Math.min(0.014, Math.min(w, Math.min(h, d)) * 0.24);
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

  // A matrix with a non-uniform scale, for the sandbag pillows below - they are
  // authored once at unit size and then squashed into whatever the run needs.
  var _mS = new THREE.Matrix4(), _mR = new THREE.Matrix4();
  function makeMS(x, y, z, rx, ry, rz, sx, sy, sz) {
    var m = new THREE.Matrix4();
    _e1.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    m.makeRotationFromEuler(_e1);
    _mS.makeScale(sx, sy, sz);
    m.multiply(_mS);
    m.elements[12] = x; m.elements[13] = y; m.elements[14] = z;
    return m;
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

  // A tapered, bent tube through a list of [x,y,z,r] stations. This is the atom
  // of every trunk, buttress-free branch, liana, mangrove prop root and bamboo
  // culm in the level: a straight cylinder reads as pipework, and pipework in a
  // forest is the loudest possible tell.
  //   mod(i, j)  optional per-ring radius multiplier. A rainforest trunk is not
  //              a circle in section - it is fluted, buttressed and lumpy, and a
  //              perfectly elliptical silhouette on the biggest object in the
  //              frame is the loudest tell there is. Passing a modulator here
  //              costs nothing and breaks the outline at every height.
  function tube(stations, seg, capTop, mod) {
    seg = seg || 7;
    var n = stations.length;
    if (n < 2) return new THREE.BufferGeometry();
    var pos = [], nor = [], uv = [];
    var i, j;
    // per-station frame
    var frames = [];
    for (i = 0; i < n; i++) {
      var a = stations[Math.max(0, i - 1)], b = stations[Math.min(n - 1, i + 1)];
      var tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // pick a stable up
      var ux = 0, uy = 1, uz = 0;
      if (Math.abs(ty) > 0.94) { ux = 1; uy = 0; uz = 0; }
      var nx = uy * tz - uz * ty, ny = uz * tx - ux * tz, nz = ux * ty - uy * tx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      var bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      frames.push([nx, ny, nz, bx, by, bz]);
    }
    var vlen = 0, vs = [0];
    for (i = 1; i < n; i++) {
      var dx = stations[i][0] - stations[i - 1][0];
      var dy = stations[i][1] - stations[i - 1][1];
      var dz = stations[i][2] - stations[i - 1][2];
      vlen += Math.sqrt(dx * dx + dy * dy + dz * dz);
      vs.push(vlen);
    }
    function ring(i, j) {
      var s = stations[i], f = frames[i];
      var th = j / seg * Math.PI * 2;
      var c = Math.cos(th), sn = Math.sin(th);
      var dx = f[0] * c + f[3] * sn, dy = f[1] * c + f[4] * sn, dz = f[2] * c + f[5] * sn;
      var rr = s[3];
      if (mod) rr *= mod(i, ((j % seg) + seg) % seg, seg);
      return [s[0] + dx * rr, s[1] + dy * rr, s[2] + dz * rr, dx, dy, dz];
    }
    for (i = 0; i + 1 < n; i++) {
      for (j = 0; j < seg; j++) {
        var A = ring(i, j), B = ring(i, j + 1), C = ring(i + 1, j + 1), D = ring(i + 1, j);
        var u0 = j / seg, u1 = (j + 1) / seg;
        var v0 = vs[i], v1 = vs[i + 1];
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        nor.push(A[3], A[4], A[5], B[3], B[4], B[5], C[3], C[4], C[5]);
        uv.push(u0, v0, u1, v0, u1, v1);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(A[3], A[4], A[5], C[3], C[4], C[5], D[3], D[4], D[5]);
        uv.push(u0, v0, u1, v1, u0, v1);
      }
    }
    if (capTop) {
      var t = stations[n - 1];
      for (j = 0; j < seg; j++) {
        var P = ring(n - 1, j), Q = ring(n - 1, j + 1);
        pos.push(t[0], t[1], t[2], P[0], P[1], P[2], Q[0], Q[1], Q[2]);
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
        uv.push(0.5, vlen, 0, vlen, 1, vlen);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    return g;
  }

  // A LEAF BLADE, as real geometry. Three columns of vertices - left edge,
  // raised midrib, right edge - so the blade FOLDS along its spine and catches
  // two different shading values across its own width. A flat ribbon shades as
  // one tone and reads as a paper cutout at any distance under 4 m, which is
  // the whole reason the understory here is not made of cards.
  //
  //   len    tip-to-base length
  //   wid    half-width at the widest point
  //   arc    how far the tip droops (metres, downward at the tip)
  //   bend   lateral sweep of the spine
  //   fold   midrib rise as a fraction of half-width
  //   segs   subdivisions along the blade
  //   shape  0 grass (widest near base, long taper) 1 broadleaf (widest mid)
  //   cols   vertex columns ACROSS the blade. 3 is the original L-midrib-R
  //          crease. 5 makes the cross-section a parabola instead of a chevron,
  //          so a big eye-height leaf CUPS - and a cupped leaf has a continuous
  //          shading gradient across its width plus a curved silhouette, which is
  //          the difference between a leaf and a folded piece of paper at 40 cm.
  function blade(len, wid, arc, bend, fold, segs, shape, cols) {
    segs = segs || 8;
    cols = cols || 3;
    if (cols < 3) cols = 3;
    if (!(cols & 1)) cols += 1;
    var pos = [], nor = [], uv = [];
    var rows = [];
    var i;
    for (i = 0; i <= segs; i++) {
      var t = i / segs;
      // spine: rises, then droops. cubic so the tip falls away instead of
      // hinging - a straight blade with a bent tip reads as broken.
      var y = len * t - arc * t * t * t;
      var x = bend * t * t;
      var z = 0;
      var w;
      if (shape === 1) {
        // broadleaf / banana: narrow at the petiole, widest at 0.42, drip tip
        w = wid * Math.sin(Math.pow(M.saturate(t * 1.02), 0.62) * Math.PI);
        w = Math.max(w, 0.004) * (1 - 0.10 * t);
      } else {
        // grass: widest at 0.18, long linear taper to a fine point
        w = wid * (0.30 + 0.70 * M.smoothstep(0, 0.18, t)) * (1 - Math.pow(t, 1.55));
        w = Math.max(w, 0.0025);
      }
      var mid = w * fold;
      rows.push([x, y, z, w, mid, t]);
    }
    function push(a, b, c) {
      var ax = a[0], ay = a[1], az = a[2];
      var bx = b[0], by = b[1], bz = b[2];
      var cx = c[0], cy = c[1], cz = c[2];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uv.push(a[3], a[4], b[3], b[4], c[3], c[4]);
    }
    // One column of vertices at lateral parameter s in [-1, 1]. The z profile is
    // a parabola through the same three points the old chevron used (s = -1 and
    // +1 at -0.35*mid, s = 0 at +mid), so a 3-column blade is byte-identical to
    // what shipped and a 5- or 7-column one simply resolves the curve.
    function colOf(r, s) {
      var w = r[3], mid = r[4];
      var f = 1 - 1.35 * s * s;
      return [r[0] + s * w, r[1] + mid * 0.22 * (1 - s * s), r[2] + mid * f,
        0.02 + 0.96 * (s * 0.5 + 0.5), r[5]];
    }
    var A0 = [], A1 = [], ci;
    for (i = 0; i + 1 < rows.length; i++) {
      var r0 = rows[i], r1 = rows[i + 1];
      A0.length = 0; A1.length = 0;
      for (ci = 0; ci < cols; ci++) {
        var sc = (ci / (cols - 1)) * 2 - 1;
        A0.push(colOf(r0, sc));
        A1.push(colOf(r1, sc));
      }
      for (ci = 0; ci + 1 < cols; ci++) {
        push(A0[ci], A0[ci + 1], A1[ci + 1]);
        push(A0[ci], A1[ci + 1], A1[ci]);
      }
    }
    // SMOOTH THE NORMALS. push() emits flat per-triangle normals, which on the
    // old three-column blade read as one crease and was fine. On a five-column
    // cupped leaf it reads as eight facets, and the foreground taro in hero2
    // photographed as a folded plastic box. Averaging at shared positions turns
    // the parabola into a curve and is what makes the leaf CUP rather than
    // crease - which was the whole point of the extra columns.
    smoothNormals(pos, nor);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    return g;
  }

  // Average face normals at coincident positions. Base geometries only - these
  // are built once per kind and then instanced, so the string keys cost nothing
  // that matters.
  function smoothNormals(pos, nor) {
    var map = Object.create(null);
    var i, k, e;
    for (i = 0; i < pos.length; i += 3) {
      k = Math.round(pos[i] * 2000) + ',' + Math.round(pos[i + 1] * 2000) + ',' +
        Math.round(pos[i + 2] * 2000);
      e = map[k];
      if (!e) { e = map[k] = [0, 0, 0, []]; }
      e[0] += nor[i]; e[1] += nor[i + 1]; e[2] += nor[i + 2];
      e[3].push(i);
    }
    for (k in map) {
      e = map[k];
      var l = Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]);
      if (l < 1e-5) continue;
      var nx = e[0] / l, ny = e[1] / l, nz = e[2] / l;
      for (i = 0; i < e[3].length; i++) {
        var o = e[3][i];
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
      }
    }
  }

  function applyMatrix(g, m) {
    g.applyMatrix4(m);
    return g;
  }

  // Concatenate a list of geometries that all share the same attribute set.
  // Cheaper than Geo.mergeAll for the small per-plant assemblies below, which
  // are built once and then instanced.
  function weld(list) {
    var entries = [];
    for (var i = 0; i < list.length; i++) entries.push({ geometry: list[i] });
    var g = Geo.mergeAll(entries);
    for (i = 0; i < list.length; i++) list[i].dispose();
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

  function segDist(px, pz, ax, az, bx, bz) {
    var vx = bx - ax, vz = bz - az;
    var wx = px - ax, wz = pz - az;
    var L = vx * vx + vz * vz;
    var t = L > 1e-6 ? M.saturate((wx * vx + wz * vz) / L) : 0;
    var dx = wx - vx * t, dz = wz - vz * t;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // GAME.Noise.fbm2 is PERLIN and therefore SIGNED, roughly -0.6..0.6. Every
  // mask in this file that thresholds it wants 0..1, and the first build
  // thresholded the raw value: smoothstep(0.42, 0.86, fbm2) is essentially
  // always zero, so the leaf litter, the moss, the water staining and the bark
  // growth were all authored, all paid for, and all invisible. Remap once,
  // here, and never threshold a signed field again.
  function n01(v) { return v * 0.5 + 0.5; }

  function bump(v, c, w) {
    var a = Math.abs(v - c);
    return a >= w ? 0 : 1 - M.smoothstep(0, w, a);
  }

  // ================================================================ Builder ==
  // Transform stack plus per-material geometry buckets. Same shape as the
  // harbor's and the snowbound's builders, deliberately - this file follows
  // those files' patterns rather than inventing new ones.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
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
    var e = { geometry: geo, matrix: wm, tint: this.tint, dark: this.dark };
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

  // A sagging line between two points - guy wires, comms cable, the footbridge
  // handrail, and the hanging lianas that give the canopy a vertical read.
  function droop(B, key, ax, ay, az, bx, by, bz, sag, r, segs) {
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

  // ============================================================ THE TERRAIN ==
  // The delta is authored as CHANNEL + BANK + FLOOR, and the split is
  // load-bearing. The channel is the only place the sky reaches the ground
  // uninterrupted, which makes the river the level's brightest floor and its
  // one horizontal leading line. Everything else is a soft, undulating,
  // root-broken forest floor whose shape exists to stop a green frame reading
  // as a flat green wash.

  function riverC(z) {
    return -30.0 + 6.0 * Math.sin((z + 22) * 0.0168) + 2.6 * Math.sin(z * 0.0415 + 1.2);
  }
  function riverHalf(z) {
    return 11.0 + 1.8 * Math.sin(z * 0.026 + 0.7);
  }

  // The track is a POLYLINE, not a sine. A sine cannot arrive anywhere: the
  // road has to leave the southern landing, hug the bank, cross the creek at a
  // right angle (which is where a bridge goes) and then climb the knoll into
  // the firebase gate. Parametrised on z because z is monotonic along it.
  var TRACK_PTS = [
    [4.6, 64], [4.2, 56], [3.6, 46], [3.0, 36], [2.9, 30], [2.9, 22],
    [2.3, 14], [1.2, 6], [1.4, 0], [4.2, -3.5], [8.0, -5.8], [9.3, -7.0],
    [10.4, -12.0], [11.0, -18.0]
  ];
  function trackX(z) {
    var P = TRACK_PTS;
    if (z >= P[0][1]) return P[0][0];
    var last = P.length - 1;
    if (z <= P[last][1]) return P[last][0];
    for (var i = 0; i < last; i++) {
      var a = P[i], b = P[i + 1];
      if (z <= a[1] && z >= b[1]) {
        var t = (a[1] - z) / Math.max(1e-4, a[1] - b[1]);
        return M.lerp(a[0], b[0], t * t * (3 - 2 * t));
      }
    }
    return P[last][0];
  }

  function creekZ(x) {
    return CREEK_Z + 2.6 * Math.sin(x * 0.052) + 1.15 * Math.sin(x * 0.115 + 0.8);
  }

  // Raw ground before pads and the track cut. `P` carries the noise field so
  // the function stays pure and can be called from the anchors before build().
  function rawY(x, z, P) {
    var N = P.noise;
    var rc = riverC(z), rh = riverHalf(z);
    var a = Math.abs(x - rc) / rh;
    var y;
    if (a < 1) {
      // The bed is not a bathtub: a scoured outer bend and a silt bar on the
      // inner one, keyed off which way the channel is turning.
      var turn = (riverC(z + 6) - riverC(z - 6)) * 0.06;
      var side = (x - rc) / rh;
      var scour = 1 + M.clamp(side * turn * 5.0, -0.32, 0.34);
      y = -CH_DEPTH * scour * (1 - M.smoothstep(0.28, 1.0, a));
      y += N.fbm2(x * 0.10 + 21.0, z * 0.10 - 5.0, 2) * 0.18;
    } else {
      y = BANK_H * M.smoothstep(1.0, 1.42, a);
    }
    var damp = M.smoothstep(0.70, 1.28, a);
    y += N.fbm2(x * 0.0215 + 3.1, z * 0.0215 - 7.4, 3) * 3.10 * damp;
    y += N.fbm2(x * 0.078 - 1.7, z * 0.078 + 2.2, 2) * 0.82 * damp;
    y += N.fbm2(x * 0.30 + 9.0, z * 0.30 - 4.0, 2) * 0.17 * damp;

    // The forest wall. Rising ground on three sides closes the space without a
    // fence: it is the reason the level has a horizon of canopy rather than a
    // horizon of fog with a visible edge.
    y += 0.34 * Math.max(0, x - 28) + 0.42 * Math.max(0, x - 42);
    y += 0.30 * Math.max(0, -38 - z) + 0.30 * Math.max(0, z - 50);
    var wb = (rc - rh - 5.0) - x;                       // west of the far bank
    y += 0.26 * Math.max(0, wb) + 0.34 * Math.max(0, wb - 12);

    // the knoll the firebase was cut into
    var kdx = x - FB_X, kdz = z - FB_Z;
    var kd = Math.sqrt(kdx * kdx + kdz * kdz);
    y += KNOLL_H * (1 - M.smoothstep(8.5, 27.0, kd));

    // the creek, east of the river only
    if (x > rc - rh * 0.2) {
      var cd = Math.abs(z - creekZ(x)) / CREEK_HALF;
      if (cd < 1.25) {
        y -= CREEK_DEPTH * (1 - M.smoothstep(0.30, 1.0, cd)) *
          M.smoothstep(rc - rh * 0.2, rc - rh * 0.2 + 5.0, x);
      }
    }
    return y;
  }

  // Building pads, flattened to the structure's own floor. The blend band is
  // narrow so the undergrowth still banks right up against a sandbag wall.
  function padBlend(x, z, P) {
    var best = 0, py = 0;
    var A = P.pads;
    for (var i = 0; i < A.length; i++) {
      var p = A[i];
      var w;
      if (p.r) {
        var dx0 = x - p.x, dz0 = z - p.z;
        var d0 = Math.sqrt(dx0 * dx0 + dz0 * dz0);
        w = 1 - M.smoothstep(p.r - p.fade, p.r, d0);
      } else {
        var dx = x - p.x, dz = z - p.z;
        var lx = dx * p.c + dz * p.s, lz = -dx * p.s + dz * p.c;
        var ox = Math.abs(lx) - p.hx, oz = Math.abs(lz) - p.hz;
        var dist = Math.sqrt(Math.max(0, ox) * Math.max(0, ox) +
          Math.max(0, oz) * Math.max(0, oz));
        w = 1 - M.smoothstep(0.05, p.fade || 0.70, dist);
      }
      // >= not >, so a pad pushed LATER wins a tie. The bunker is excavated
      // into the firebase plateau and both pads read w = 1 inside it; with a
      // strict > the plateau won, the excavation never happened, and the
      // interior framing stood on open ground looking out over walls that
      // were buried to their eaves.
      if (w >= best) { best = w; py = p.y; }
    }
    return { w: best, y: py };
  }

  function groundY(x, z, P) {
    var y = rawY(x, z, P);
    // ---- the track ---------------------------------------------------------
    // Cut, not painted. A road that is only a texture change photographs as a
    // stripe; a road worn 25 cm into the mud with a spoil lip either side and
    // two 8 cm ruts down the middle photographs as a road.
    var tx = trackX(z);
    var u = x - tx;
    var au = Math.abs(u);
    if (au < TRACK_SHOULDER + 1.6) {
      var tw = 1 - M.smoothstep(TRACK_HALF, TRACK_SHOULDER, au);
      if (tw > 0.001) {
        var ty = rawY(tx, z, P) - 0.24;
        ty -= 0.085 * (bump(u, 0.95, 0.42) + bump(u, -0.95, 0.42));
        ty += P.noise.fbm2(x * 1.1, z * 1.1, 2) * 0.035;
        y = M.lerp(y, ty, tw * 0.92);
      }
      // the berm of spoil the traffic pushed aside
      var bt = (au - TRACK_HALF) / 1.7;
      if (bt > -0.2 && bt < 1.5) {
        var sh = Math.max(0, 1 - Math.abs((bt - 0.55) / 0.72));
        y += 0.20 * sh * sh * (3 - 2 * sh);
      }
    }
    var pb = padBlend(x, z, P);
    if (pb.w > 0) y = M.lerp(y, pb.y, pb.w);
    return y;
  }

  // How much sky a floor point can see, ANALYTICALLY, from the level's own
  // plan. This is what paints the ground: bright at the water, on the track and
  // in the clearings; deep and cold under closed canopy. It is not a light -
  // it is the vertex-colour field that gives a green level its value range.
  function skyOpen(x, z, P) {
    var rc = riverC(z), rh = riverHalf(z);
    var a = Math.abs(x - rc) / rh;
    var open = 0.14;
    // the channel and its banks
    open = Math.max(open, 1.0 - M.smoothstep(0.85, 1.9, a));
    // the track
    var au = Math.abs(x - trackX(z));
    // 0.50, not 0.62. A track cut through primary forest is a slot, not a
    // clearing: the crowns still meet over it in most places and only break
    // where a big tree has come down. At 0.62 the canopy thinned enough over
    // the road that hero1 - which stands IN the road - lost its ceiling and
    // photographed bright fog across the top of the frame.
    open = Math.max(open, 0.50 * (1 - M.smoothstep(TRACK_HALF, 8.5, au)));
    // the creek
    var cd = Math.abs(z - creekZ(x)) / (CREEK_HALF * 1.9);
    if (x > rc && cd < 1.2) open = Math.max(open, 0.58 * (1 - M.smoothstep(0.3, 1.2, cd)));
    // the firebase and the clearings it was cut out of
    for (var i = 0; i < P.clearings.length; i++) {
      var cl = P.clearings[i];
      var dx = x - cl.x, dz = z - cl.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      open = Math.max(open, cl.open * (1 - M.smoothstep(cl.r * 0.55, cl.r, d)));
    }
    // canopy thickness noise, so the boundary between light and shade is
    // ragged rather than a set of circles
    open *= 0.80 + 0.34 * P.noise.fbm2(x * 0.055 + 17.0, z * 0.055 - 9.0, 2);
    return M.saturate(open);
  }

  // THE CANOPY BREAK. skyOpen decides WHERE the roof is open; this breaks that
  // up at leaf scale so the floor gets sharp-edged, non-repeating POOLS instead
  // of a smooth ten-metre gradient. "Light arrives as shafts filtered through
  // canopy, dappling everything" is the first line of the brief and the level
  // shipped with four discrete cones and a flat floor between them, because the
  // canopy sits at 13-23 m on alpha-cut cards - far outside the near shadow
  // cascades - and the ground vertex lattice cannot resolve a 40 cm pool.
  // Baking it is the only way, and it works under overcast where a shadow
  // gated on the solar disc does not exist at all.
  function leafBreak(x, z) {
    var a = tfbm(x * 0.40 + 31.0, z * 0.40 - 17.0, 4096, 0x5EAF, 3, 0.55);
    var b = tval(x * 1.30 - 8.0, z * 1.30 + 5.0, 4096, 0x1EA3);
    var c = tval(x * 2.70 + 3.0, z * 2.70 - 9.0, 4096, 0x2BAD);
    var v = a * 0.50 + b * 0.33 + c * 0.17;
    return M.saturate((v - 0.335) * 2.45);
  }

  // How much a published standpoint's SIGHTLINE wants this square metre left
  // clear. 1 = keep it empty, 0 = plant anything. `tall` widens the cone for
  // things that block a view rather than merely stand in front of one.
  function camClear(x, z, P, tall) {
    var best = 0;
    var A = P.camMarks;
    for (var i = 0; i < A.length; i++) {
      var C = A[i];
      var dx = x - C.x, dz = z - C.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-4) return 1;
      if (d < C.r + (tall ? 1.5 : 0)) return 1;
      var reach = C.reach + (tall ? 5.0 : 0);
      if (d > reach) continue;
      var half = C.half + (tall ? 0.12 : 0);
      var ang = Math.acos(M.clamp((dx * C.bx + dz * C.bz) / d, -1, 1));
      if (ang > half) continue;
      var w = (1 - M.smoothstep(half * 0.58, half, ang)) *
        (1 - M.smoothstep(reach * 0.72, reach, d));
      if (w > best) best = w;
    }
    return best;
  }

  // ==================================================== THE SHAFTS, AS DATA ==
  // ONE TABLE, READ BY FOUR PLACES, and that is the entire reason it exists.
  //
  // The six canopy gaps used to be six literal `gap(...)` calls inside
  // _buildLights, so nothing else in the level knew where they were - and
  // measured, that is why the level's only lighting event did not land.
  // lighting.js takes BOTH ends of a haze cone to zero on purpose (a cone that
  // stops at a finite brightness draws its own rim, and a visible rim turns a
  // beam back into a cone-shaped object), so the last 22% of every shaft fades
  // out before it reaches the floor. The landing is supposed to come from the
  // SpotLight underneath - but that puts `lux` on the mud against an overcast
  // dome already delivering several times as much, so hero1 photographed as a
  // milky column stopping two metres above a floor whose value was identical
  // inside and outside it. A shaft that does not land is a searchlight in fog.
  //
  // Published as DATA, the POOL can be painted by everything in the level that
  // has a colour: the floor light bake, the per-instance plant tint and the
  // merged-bucket vertex colour. That is the only way a pool survives an
  // overcast key, it costs no draw calls and no triangles, and it puts the light
  // on the plants standing IN the shaft as well as on the mud under it - which
  // is what a shaft arriving through a canopy actually does.
  //
  // The landing point is derived exactly the way lighting.js derives it, and
  // that agreement is load-bearing: _solveShaft keeps the published `dir`'s
  // AZIMUTH and replaces its elevation with a 0.18 horizontal lean on a unit
  // downward axis, so the beam drifts 0.18 * rise from the aperture over its
  // run. A pool painted at the aperture's own (x, z) would sit two metres off
  // the light.
  function shaftSpecs(P) {
    if (P._shafts) return P._shafts;
    var raw = [
      // kind, x, z, rise, dx, dz, width, lux, colour
      // The lux is a step down from the values that shipped, because the pool no
      // longer depends on it: haze opacity is lux * 0.055 in lighting.js, so the
      // same number that has to make the floor bright also decides how opaque
      // the column is, and those two wants are opposed. The bake carries the
      // landing now, so the column can be the thinner thing it should be.
      ['hero1', P.clearings[0].x + 0.4, P.clearings[0].z, 13.5, 0.17, 0.11, 3.4, 8.0, 0xe4f0a0],
      ['hero2', P.heli.x + 1.2, P.heli.z - 1.6, 10.5, -0.12, 0.15, 3.0, 6.0, 0xe2eea4],
      ['hero3', P.firebase.x - 3.0, P.firebase.z + 5.0, 8.0, 0.13, -0.09, 2.6, 4.2, 0xe8f29c],
      ['hero1b', P.clearings[4].x - 1.2, P.clearings[4].z + 1.0, 11.0, -0.10, 0.16, 2.8, 4.8, 0xdceca4],
      ['mid', P.clearings[1].x + 1.0, P.clearings[1].z - 1.5, 12.0, 0.14, -0.12, 2.6, 3.6, 0xe0eea6]
    ];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      var hl = Math.sqrt(s[4] * s[4] + s[5] * s[5]) || 1;
      var fr = s[6] * 0.5;
      out.push({
        kind: s[0], x: s[1], z: s[2], rise: s[3],
        dx: s[4], dz: s[5], width: s[6], lux: s[7], col: s[8],
        fx: s[1] + (s[4] / hl) * 0.18 * s[3],
        fz: s[2] + (s[5] / hl) * 0.18 * s[3],
        fr: fr, fr2: (fr * 2.7) * (fr * 2.7)
      });
    }
    P._shafts = out;
    return out;
  }

  // 0..1 pool weight at a floor point. The rim is broken by the same leaf field
  // the dapple uses, because a shaft through a canopy lands as a ragged patch of
  // overlapping ellipses and never as a clean one - and a pool without an edge
  // is only a slightly brighter piece of floor.
  function shaftPool(x, z, P) {
    var A = shaftSpecs(P);
    var best = 0;
    for (var i = 0; i < A.length; i++) {
      var s = A[i];
      var dx = x - s.fx, dz = z - s.fz;
      var d2 = dx * dx + dz * dz;
      if (d2 > s.fr2) continue;
      var d = Math.sqrt(d2);
      var w = 1 - M.smoothstep(s.fr * 0.40, s.fr * 1.50, d);
      w *= 0.36 + 0.64 * M.smoothstep(0.16, 0.70, leafBreak(x, z));
      // the skirt: sun-fleck spill beyond the cone's own footprint
      w += (1 - M.smoothstep(s.fr * 1.35, s.fr * 2.7, d)) * 0.18 *
        M.smoothstep(0.44, 0.88, leafBreak(x * 1.7 + 13.0, z * 1.7 - 8.0));
      if (w > best) best = w;
    }
    return M.saturate(best);
  }

  // ==================================================== PROCEDURAL TEXTURES ==
  // GAME.Noise is perlin on an unbounded lattice and is therefore NOT tileable.
  // Bark wraps a trunk and repeats up it; a seam every 1.4 m on the biggest
  // object in the frame is the whole level. The lattice index is taken modulo
  // the period instead. (Same fix level_snowbound made, same reason.)
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

  function makeTex(canvas, srgb, aniso, clamp) {
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (aniso) t.anisotropy = aniso;
    t.needsUpdate = true;
    return t;
  }

  function canvasOf(n) {
    var doc = (typeof document !== 'undefined') ? document : null;
    if (!doc) return null;
    var c = doc.createElement('canvas');
    c.width = c.height = n;
    return c;
  }

  // Sobel a height buffer into an RGBA normal map, wrapping at the edges.
  function heightToNormal(H, N, strength, out) {
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var k = j * N + i, o = k * 4;
        var hx = H[j * N + ((i + 1) % N)] - H[j * N + ((i - 1 + N) % N)];
        var hy = H[((j + 1) % N) * N + i] - H[((j - 1 + N) % N) * N + i];
        var nx = -hx * strength, ny = -hy * strength, nz = 1;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        out[o] = Math.round((nx / nl * 0.5 + 0.5) * 255);
        out[o + 1] = Math.round((ny / nl * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round((nz / nl * 0.5 + 0.5) * 255);
        out[o + 3] = 255;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // THE CANOPY ATLAS. 4 x 4 alpha-cut cells at 1024, used ONLY above eight
  // metres. Everything the player can reach is real geometry (see blade()).
  //
  //   0 canopy cluster A   1 canopy cluster B    2 canopy cluster C (dark)
  //   3 palm frond         4 fern frond          5 banana leaf
  //   6 bamboo sprig       7 hanging liana       8 creeper leaves
  //   9 dead frond        10 leaf litter        11 grass fan (distant)
  // ---------------------------------------------------------------------------
  var ATL_N = 4, ATL_PX = 1024, ATL_CELL = ATL_PX / ATL_N;
  var CELL = {
    canopyA: 0, canopyB: 1, canopyC: 2, palm: 3,
    fern: 4, banana: 5, bamboo: 6, liana: 7,
    creeper: 8, dead: 9, litter: 10, grass: 11
  };

  // CANVAS Y RUNS DOWN AND TEXTURE V RUNS UP.
  //
  // THREE.CanvasTexture leaves flipY at its default true, so canvas row 0 is
  // sampled at v = 1, not v = 0. Computing the cell's v range straight from the
  // row index therefore reads the atlas UPSIDE DOWN BY ROWS: the three canopy
  // cells (row 0) were sampling row 3, which this atlas never draws into, so
  // every canopy card in the level was fully transparent and the canopy simply
  // did not exist - while the bamboo cards, asking for row 1, were rendering
  // the LEAF LITTER cell and printing the swarm of dark specks that two rounds
  // of capture blamed on the alpha threshold. Invert the row, keep the image
  // the right way up (v0 = bottom of the cell = bottom of the card).
  function atlasUV(cell, inset) {
    var s = 1 / ATL_N;
    var row = Math.floor(cell / ATL_N);
    var cx = (cell % ATL_N) * s, cy = (ATL_N - 1 - row) * s;
    // 6% of the cell, not 0.6%. An atlas sampled through a mip chain bleeds
    // from its neighbours: at mip 2 the whole sheet is 256 px, a cell is 64,
    // and a one-pixel gutter is gone - which is how brown dead-frond and
    // liana texels ended up scattered through the green canopy in the first
    // capture. 15 base pixels survives the two mip levels a canopy card
    // actually reaches at 30-120 m.
    var pad = (inset === undefined ? 0.060 : inset) * s;
    return [cx + pad, cy + pad, cx + s - pad, cy + s - pad];
  }

  function buildCanopyAtlas(rng) {
    var cA = canvasOf(ATL_PX);
    if (!cA) return null;
    var gA = cA.getContext('2d');
    var cH = canvasOf(ATL_PX);
    var gH = cH && cH.getContext('2d');
    if (!gA || !gH) return null;
    gA.clearRect(0, 0, ATL_PX, ATL_PX);
    gH.fillStyle = '#000000';
    gH.fillRect(0, 0, ATL_PX, ATL_PX);
    var S = ATL_CELL;

    function origin(n) { return [(n % ATL_N) * S, Math.floor(n / ATL_N) * S]; }

    // One leaf outline, built under a transform so it lands in device space and
    // can be filled after the restore. `tip` is the drip tip every wet-tropical
    // leaf has and no dry-mediterranean one does.
    function leafPath(g, cx, cy, len, wid, ang, tip, curl) {
      g.save();
      g.translate(cx, cy);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(wid + curl, len * 0.34, wid * 0.30 + curl * 0.6, len * 0.80);
      g.quadraticCurveTo(wid * 0.16, len * (0.90 + tip * 0.08), 0, len * (1 + tip));
      g.quadraticCurveTo(-wid * 0.16, len * (0.90 + tip * 0.08), -wid * 0.30 + curl * 0.6, len * 0.80);
      g.quadraticCurveTo(-wid + curl, len * 0.34, 0, 0);
      g.closePath();
      g.restore();
    }

    // Draw one leaf into BOTH buffers. The height buffer gets a gradient that
    // peaks on the midrib, so the derived normal has a real leaf cross-section
    // rather than a flat card with an outline.
    function leaf(cx, cy, len, wid, ang, hue, val, tip, curl) {
      var g = gA;
      leafPath(g, cx, cy, len, wid, ang, tip, curl || 0);
      var ex = cx + Math.sin(-ang) * 0, ey = cy;
      var grd = g.createLinearGradient(
        cx - Math.cos(ang) * wid, cy - Math.sin(ang) * wid,
        cx + Math.cos(ang) * wid, cy + Math.sin(ang) * wid);
      var r0 = Math.round(hue[0] * val), g0 = Math.round(hue[1] * val), b0 = Math.round(hue[2] * val);
      grd.addColorStop(0.0, 'rgb(' + Math.round(r0 * 0.68) + ',' + Math.round(g0 * 0.70) + ',' + Math.round(b0 * 0.72) + ')');
      grd.addColorStop(0.46, 'rgb(' + r0 + ',' + g0 + ',' + b0 + ')');
      grd.addColorStop(0.54, 'rgb(' + Math.round(r0 * 1.18) + ',' + Math.round(g0 * 1.16) + ',' + Math.round(b0 * 1.10) + ')');
      grd.addColorStop(1.0, 'rgb(' + Math.round(r0 * 0.62) + ',' + Math.round(g0 * 0.66) + ',' + Math.round(b0 * 0.70) + ')');
      g.fillStyle = grd;
      g.fill();
      void ex; void ey;
      // venation: a midrib plus a few laterals, drawn dark then a highlight
      g.save();
      g.translate(cx, cy); g.rotate(ang);
      g.strokeStyle = 'rgba(20,32,14,0.36)';
      g.lineWidth = Math.max(0.7, wid * 0.075);
      g.beginPath(); g.moveTo(0, len * 0.03); g.lineTo(0, len * (0.94 + tip)); g.stroke();
      g.lineWidth = Math.max(0.5, wid * 0.040);
      g.strokeStyle = 'rgba(28,44,18,0.24)';
      for (var v = 1; v <= 5; v++) {
        var t = v / 6;
        g.beginPath();
        g.moveTo(0, len * t);
        g.quadraticCurveTo(wid * 0.42, len * (t + 0.06), wid * 0.80 * (1 - t * 0.5), len * (t + 0.12));
        g.stroke();
        g.beginPath();
        g.moveTo(0, len * t);
        g.quadraticCurveTo(-wid * 0.42, len * (t + 0.06), -wid * 0.80 * (1 - t * 0.5), len * (t + 0.12));
        g.stroke();
      }
      g.restore();

      // height
      var h = gH;
      leafPath(h, cx, cy, len, wid, ang, tip, curl || 0);
      var hg = h.createLinearGradient(
        cx - Math.cos(ang) * wid, cy - Math.sin(ang) * wid,
        cx + Math.cos(ang) * wid, cy + Math.sin(ang) * wid);
      hg.addColorStop(0.0, 'rgb(70,70,70)');
      hg.addColorStop(0.5, 'rgb(220,220,220)');
      hg.addColorStop(1.0, 'rgb(70,70,70)');
      h.fillStyle = hg;
      h.fill();
    }

    // A CANOPY CARD IS A SOLID MASS WITH A LEAFY EDGE. IT IS NOT A STIPPLE.
    //
    // This cell was authored twice and both attempts failed the same way. The
    // first drew 46 separate leaves; alpha coverage per card came out around a
    // quarter, so eight cards in a cluster still let three quarters of the sky
    // through and the canopy was decoration rather than roof. The second drew
    // 165 small leaves, which raised coverage on the BASE mip and then lost it
    // all again: a canopy card is 40-110 px on screen against a 256 px cell, so
    // it is sampled at mip 1-2, and averaging a stipple of separate leaves down
    // two levels turns a leaf into a grey speck below the alpha threshold. The
    // capture came back as a swarm of dark specks over blown white sky.
    //
    // The fix is the one every shipped foliage atlas uses: the INTERIOR is a
    // continuous opaque blob so its alpha survives any mip level, and only the
    // RIM is individual leaves, where a broken silhouette is what the eye
    // actually reads. All the interior variation is in COLOUR - overlapping
    // light and dark leaf masses, a dark under-crown, a lit upper surface -
    // which mips down gracefully because it never has to survive a threshold.
    function clusterCell(n, hue, count, big, dark) {
      var o = origin(n);
      var cx = o[0] + S * 0.5, cy = o[1] + S * 0.5;
      var i, ang, rad;
      var val = dark ? 0.78 : 1.0;

      // ---- PER-LEAF HUE, AND IT IS THE LEVEL'S BIGGEST LEVER --------------
      // Every leaf in a cell was drawn from ONE rgb triple, so the canopy -
      // 35-40% of every exterior frame - carried a single hue with a measured
      // interquartile range of 38 degrees. A real crown is not one green: new
      // growth at the rim is yellow-green, mature shaded leaf is blue-green,
      // and the difference between them is 70-80 degrees of hue. Rotating each
      // leaf's triple between those two ends opens the band without inventing a
      // colour a rainforest does not have, and it costs nothing at all.
      //   t = 0  yellow-green (~60 deg)   t = 1  blue-green (~135 deg)
      function hv(h, t) {
        var k = t - 0.5;
        return [M.clamp(h[0] * (1 - k * 0.78), 0, 255),
          M.clamp(h[1] * (1 + k * 0.06), 0, 255),
          M.clamp(h[2] * (1 + k * 1.18), 0, 255)];
      }

      function rgb(h, v) {
        return 'rgb(' + Math.round(M.clamp(h[0] * v, 0, 255)) + ',' +
          Math.round(M.clamp(h[1] * v, 0, 255)) + ',' +
          Math.round(M.clamp(h[2] * v, 0, 255)) + ')';
      }
      function blob(g, x, y, rx, ry, rot, fill) {
        g.save();
        g.translate(x, y); g.rotate(rot);
        g.beginPath();
        g.ellipse ? g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
          : g.arc(0, 0, rx, 0, Math.PI * 2);
        g.restore();
        g.fillStyle = fill;
        g.fill();
      }

      // ---- 1. the opaque core, built from overlapping lobes ----------------
      // 48 small lobes, not 26 big ones. The core has to stay a continuous
      // opaque mass (its alpha is what survives the mip chain), but a lobe
      // 1.8 m across on the finished card has a readable elliptical EDGE, and
      // half a dozen of those is the "canopy is a stamp" tell.
      for (i = 0; i < 48; i++) {
        ang = rng.range(0, Math.PI * 2);
        rad = Math.sqrt(rng.next()) * S * 0.235;
        var rx = S * rng.range(0.072, 0.128), ry = rx * rng.range(0.60, 1.0);
        var lv = val * rng.range(0.60, 0.84);
        blob(gA, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, rx, ry,
          rng.range(0, Math.PI), rgb(hv(hue, rng.next()), lv));
        blob(gH, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, rx, ry,
          rng.range(0, Math.PI), 'rgb(150,150,150)');
      }
      // ---- 2. tonal structure ON the core ----------------------------------
      // A crown is not one value. Sunlit lobes on the upper left, deep shade
      // pockets underneath, and a scatter of individual leaf shapes catching
      // light - this is the whole read at 20 m and it costs no alpha at all.
      for (i = 0; i < Math.round(count * 0.55); i++) {
        ang = rng.range(0, Math.PI * 2);
        rad = Math.sqrt(rng.next()) * S * 0.255;
        var lx = cx + Math.cos(ang) * rad, ly = cy + Math.sin(ang) * rad;
        // upper-left lobes are lit, lower-right are in the crown's own shade
        var sun = M.saturate(0.5 - (lx - cx) / (S * 0.6) - (ly - cy) / (S * 0.6));
        var len = S * rng.range(big * 0.55, big * 1.15);
        // sunlit lobes run yellow-green, shaded ones blue-green - the hue
        // follows the light rather than being a random sprinkle
        leaf(lx, ly, len, len * rng.range(0.28, 0.44),
          ang + Math.PI * 0.5 + rng.range(-0.8, 0.8),
          hv(hue, M.saturate(0.86 - sun * 0.72 + rng.range(-0.22, 0.22))),
          val * M.lerp(0.42, 1.28, sun) * rng.range(0.85, 1.15),
          rng.range(0.10, 0.24), 0);
      }
      // ---- 3. the rim: individual leaves, and only here ---------------------
      // The silhouette is the only place a leaf SHAPE has to survive, and the
      // only place alpha is doing work.
      for (i = 0; i < count; i++) {
        ang = rng.range(0, Math.PI * 2);
        rad = S * (0.185 + Math.pow(rng.next(), 0.55) * 0.190);
        var edge = M.saturate((rad / S - 0.185) / 0.190);
        var el = S * rng.range(big * 0.55, big) * (1 - edge * 0.32);
        // the rim is NEW GROWTH, so it runs to the yellow end
        leaf(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad,
          el, el * rng.range(0.26, 0.42),
          ang + Math.PI * 0.5 + rng.range(-0.7, 0.7),
          hv(hue, M.saturate(0.42 - edge * 0.34 + rng.range(-0.30, 0.30))),
          val * (1.05 - edge * 0.42) * rng.range(0.80, 1.15),
          rng.range(0.10, 0.24), rng.range(-0.10, 0.10) * el);
      }
    }

    // ---- 0,1,2 : the three canopy tiers ------------------------------------
    // Three separate cells rather than one reused three times: an instanced
    // canopy built from ONE card is a repeating stamp and the eye finds it in
    // about a second. A is the sunlit crown, B the mid tier, C the shaded
    // underside of the canopy, which is what the player actually looks up into.
    // CANOPY LEAVES WERE THE SIZE OF A CAR. At big = 0.16-0.20 of a 256 px cell
    // on a 2.9 m card scaled to 1.70, one leaf shape was up to a metre long and
    // an opaque core lobe up to 1.8 m across; with the roof at 13.5-23 m the
    // nearest cards sat 8-12 m from the lens and those leaves subtended 8-10
    // degrees, so the top 45% of three published framings was a mush of
    // individually readable cabbage. Worse, it destroyed SCALE: the trunks read
    // as small because the leaves read as huge.
    //
    // 0.10-0.12 with twice the count is a SPRAY of small leaves instead of
    // eight big ones - about a 0.5 m leaf on a 5 m card, i.e. 2 degrees at the
    // 12-16 m the raised roof now keeps them at.
    //
    // MEASURED AND PULLED BACK ONCE. The first attempt went to 0.062-0.075 with
    // three times the count, and the frame came back with the exact failure the
    // cell was authored twice to avoid: at 18 px a rim leaf is a sub-pixel
    // high-contrast speck by the time it is 15 m away, so postfx's chromatic
    // aberration and bloom turned the whole canopy into rainbow glitter. The
    // silhouette needs leaves the eye can resolve, just not ones it can COUNT.
    clusterCell(CELL.canopyA, [126, 170, 76], 128, 0.118, false);
    clusterCell(CELL.canopyB, [98, 146, 64], 136, 0.108, false);
    clusterCell(CELL.canopyC, [66, 108, 50], 144, 0.098, true);

    // ---- 3 : palm / nipa frond ---------------------------------------------
    (function () {
      var o = origin(CELL.palm);
      var bx = o[0] + S * 0.5, by = o[1] + S * 0.96;
      var tipx = o[0] + S * 0.5, tipy = o[1] + S * 0.06;
      var i, t, px, py;
      for (i = 0; i < 26; i++) {
        t = i / 25;
        px = M.lerp(bx, tipx, t) + Math.sin(t * 2.1) * S * 0.03;
        py = M.lerp(by, tipy, t);
        var ll = S * (0.30 - t * 0.20) * rng.range(0.85, 1.10);
        var lw = ll * rng.range(0.085, 0.135);
        var back = 0.78 + t * 0.42;
        leaf(px, py, ll, lw, back, [104, 148, 66], rng.range(0.80, 1.06), 0.06, 0);
        leaf(px, py, ll, lw, Math.PI - back, [104, 148, 66], rng.range(0.76, 1.02), 0.06, 0);
      }
      // rachis
      gA.strokeStyle = 'rgb(96,104,54)';
      gA.lineWidth = S * 0.020;
      gA.beginPath(); gA.moveTo(bx, by); gA.lineTo(tipx, tipy); gA.stroke();
      gH.strokeStyle = 'rgb(235,235,235)';
      gH.lineWidth = S * 0.020;
      gH.beginPath(); gH.moveTo(bx, by); gH.lineTo(tipx, tipy); gH.stroke();
    })();

    // ---- 4 : fern frond -----------------------------------------------------
    (function () {
      var o = origin(CELL.fern);
      var bx = o[0] + S * 0.5, by = o[1] + S * 0.97;
      var i, t;
      for (i = 0; i < 20; i++) {
        t = i / 19;
        var px = bx + Math.sin(t * 1.4) * S * 0.05;
        var py = M.lerp(by, o[1] + S * 0.05, t);
        var ll = S * (0.24 - t * 0.19) * rng.range(0.9, 1.1);
        leaf(px, py, ll, ll * 0.30, 1.05 + t * 0.35, [86, 130, 56], rng.range(0.82, 1.08), 0.05, 0);
        leaf(px, py, ll, ll * 0.30, Math.PI - 1.05 - t * 0.35, [86, 130, 56], rng.range(0.80, 1.04), 0.05, 0);
      }
      gA.strokeStyle = 'rgb(84,96,48)';
      gA.lineWidth = S * 0.014;
      gA.beginPath(); gA.moveTo(bx, by); gA.lineTo(o[0] + S * 0.5, o[1] + S * 0.05); gA.stroke();
    })();

    // ---- 5 : one big banana leaf -------------------------------------------
    (function () {
      var o = origin(CELL.banana);
      leaf(o[0] + S * 0.5, o[1] + S * 0.96, S * 0.90, S * 0.30, Math.PI,
        [110, 158, 66], 1.0, 0.02, 0);
      // wind tears: a mature banana leaf is split to the midrib, and the splits
      // are what make it read as a banana rather than as a giant generic leaf
      gA.save();
      gA.globalCompositeOperation = 'destination-out';
      gA.fillStyle = 'rgba(0,0,0,1)';
      for (var i = 0; i < 9; i++) {
        var t = 0.16 + i * 0.085;
        var side = (i & 1) ? 1 : -1;
        var y = o[1] + S * (0.96 - t * 0.88);
        gA.beginPath();
        gA.moveTo(o[0] + S * 0.5 + side * S * 0.012, y);
        gA.lineTo(o[0] + S * 0.5 + side * S * rng.range(0.20, 0.31), y - S * rng.range(0.01, 0.04));
        gA.lineTo(o[0] + S * 0.5 + side * S * rng.range(0.20, 0.31), y + S * rng.range(0.012, 0.030));
        gA.closePath();
        gA.fill();
      }
      gA.restore();
    })();

    // ---- 6 : bamboo sprig ---------------------------------------------------
    (function () {
      var o = origin(CELL.bamboo);
      var bx = o[0] + S * 0.5, by = o[1] + S * 0.97;
      gA.strokeStyle = 'rgb(132,136,80)';
      gA.lineWidth = S * 0.018;
      gA.beginPath(); gA.moveTo(bx, by); gA.lineTo(bx + S * 0.05, o[1] + S * 0.08); gA.stroke();
      for (var i = 0; i < 16; i++) {
        var t = 0.10 + rng.next() * 0.85;
        var px = M.lerp(bx, bx + S * 0.05, t), py = M.lerp(by, o[1] + S * 0.08, t);
        var ll = S * rng.range(0.16, 0.30);
        leaf(px, py, ll, ll * rng.range(0.075, 0.115),
          rng.range(0.6, 2.6), [118, 152, 72], rng.range(0.80, 1.10), 0.14, 0);
      }
    })();

    // ---- 7 : hanging liana --------------------------------------------------
    (function () {
      var o = origin(CELL.liana);
      var x0 = o[0] + S * 0.50;
      gA.strokeStyle = 'rgb(74,66,44)';
      gA.lineWidth = S * 0.022;
      gA.beginPath();
      gA.moveTo(x0, o[1] + S * 0.02);
      gA.quadraticCurveTo(x0 + S * 0.13, o[1] + S * 0.5, x0 - S * 0.05, o[1] + S * 0.99);
      gA.stroke();
      gH.strokeStyle = 'rgb(210,210,210)';
      gH.lineWidth = S * 0.022;
      gH.beginPath();
      gH.moveTo(x0, o[1] + S * 0.02);
      gH.quadraticCurveTo(x0 + S * 0.13, o[1] + S * 0.5, x0 - S * 0.05, o[1] + S * 0.99);
      gH.stroke();
      for (var i = 0; i < 24; i++) {
        var t = i / 23;
        var mt = 1 - t;
        var px = mt * mt * x0 + 2 * mt * t * (x0 + S * 0.13) + t * t * (x0 - S * 0.05);
        var py = o[1] + S * (mt * mt * 0.02 + 2 * mt * t * 0.5 + t * t * 0.99);
        var ll = S * rng.range(0.10, 0.18);
        leaf(px, py, ll, ll * rng.range(0.34, 0.50),
          (i & 1 ? 1 : -1) * rng.range(1.0, 2.0) + 1.6,
          [92, 138, 58], rng.range(0.78, 1.10), 0.22, 0);
      }
    })();

    // ---- 8 : creeper, small heart leaves on stems ---------------------------
    (function () {
      var o = origin(CELL.creeper);
      for (var s = 0; s < 4; s++) {
        var sx = o[0] + S * rng.range(0.12, 0.88);
        gA.strokeStyle = 'rgba(78,74,44,0.9)';
        gA.lineWidth = S * 0.010;
        gA.beginPath();
        gA.moveTo(sx, o[1]);
        gA.quadraticCurveTo(sx + S * rng.range(-0.2, 0.2), o[1] + S * 0.5,
          sx + S * rng.range(-0.25, 0.25), o[1] + S);
        gA.stroke();
        for (var i = 0; i < 11; i++) {
          var t = i / 10;
          var px = sx + Math.sin(t * 4.0 + s) * S * 0.10;
          var py = o[1] + S * t;
          var ll = S * rng.range(0.07, 0.13);
          leaf(px, py, ll, ll * 0.62, rng.range(0, 6.28), [104, 150, 62],
            rng.range(0.78, 1.12), 0.26, 0);
        }
      }
    })();

    // ---- 9 : dead frond -----------------------------------------------------
    (function () {
      var o = origin(CELL.dead);
      var bx = o[0] + S * 0.5, by = o[1] + S * 0.95;
      for (var i = 0; i < 22; i++) {
        var t = i / 21;
        var px = M.lerp(bx, o[0] + S * 0.46, t) + Math.sin(t * 3.0) * S * 0.04;
        var py = M.lerp(by, o[1] + S * 0.08, t);
        var ll = S * (0.28 - t * 0.19) * rng.range(0.7, 1.05);
        var hue = [148, 118, 62];
        leaf(px, py, ll, ll * 0.10, 0.95 + t * 0.5, hue, rng.range(0.62, 0.96), 0.04, 0);
        leaf(px, py, ll, ll * 0.10, Math.PI - 0.95 - t * 0.5, hue, rng.range(0.60, 0.92), 0.04, 0);
      }
    })();

    // ---- 10 : fallen leaf litter -------------------------------------------
    (function () {
      var o = origin(CELL.litter);
      for (var i = 0; i < 34; i++) {
        var ll = S * rng.range(0.10, 0.22);
        var hue = rng.bool(0.45) ? [150, 118, 60] : (rng.bool(0.5) ? [104, 96, 52] : [82, 104, 48]);
        leaf(o[0] + S * rng.range(0.06, 0.94), o[1] + S * rng.range(0.06, 0.94),
          ll, ll * rng.range(0.26, 0.42), rng.range(0, 6.28), hue,
          rng.range(0.55, 1.00), 0.16, rng.range(-0.2, 0.2) * ll);
      }
    })();

    // ---- 11 : a distant grass fan ------------------------------------------
    (function () {
      var o = origin(CELL.grass);
      var bx = o[0] + S * 0.5, by = o[1] + S * 0.99;
      for (var i = 0; i < 30; i++) {
        var ang = rng.range(-0.62, 0.62);
        var ll = S * rng.range(0.55, 0.95);
        leaf(bx + rng.range(-0.10, 0.10) * S, by, ll, ll * rng.range(0.030, 0.055),
          Math.PI + ang, [110, 146, 62], rng.range(0.70, 1.10), 0.02,
          rng.range(-0.25, 0.25) * ll * 0.06);
      }
    })();

    // ---- derive normal + roughness from the drawn buffers -------------------
    var N = ATL_PX;
    var imgA = gA.getImageData(0, 0, N, N);
    var A = imgA.data;
    var imgH = gH.getImageData(0, 0, N, N);
    var Hd = imgH.data;
    var H = new Float32Array(N * N);
    var k, i2;
    for (k = 0; k < N * N; k++) H[k] = Hd[k * 4] / 255;
    var cN = canvasOf(N), cR = canvasOf(N);
    var gN = cN.getContext('2d'), gR = cR.getContext('2d');
    var iN = gN.createImageData(N, N), iR = gR.createImageData(N, N);
    heightToNormal(H, N, 1.9, iN.data);
    var R = iR.data;
    for (k = 0; k < N * N; k++) {
      i2 = k * 4;
      var lum = (A[i2] * 0.30 + A[i2 + 1] * 0.59 + A[i2 + 2] * 0.11) / 255;
      // A wet tropical leaf is WAXY: low roughness on the lamina, higher on the
      // veins and much higher on anything dead. Drives the specular sheen that
      // separates a lit canopy from a flat green wash.
      //
      // FLOORED AT 0.56, NOT 0.36. At 0.36 against a bright overcast dome the
      // lobe is tight enough to resolve, and the atlas's own 1.9-strength normal
      // tilts every painted leaf a different way - so the mid-tier cards at
      // 10-15 m photographed as CRUMPLED TINFOIL: silver shards following the leaf
      // shapes, right through the top third of hero1, hero2 and hero3. A leaf
      // twelve metres away seen through mist has no resolvable specular; what it
      // has is a broad sheen, which is what 0.56-0.84 gives. The lamina/vein
      // contrast is kept, just at a third of the range.
      var ro = 0.72 - 0.16 * M.saturate(lum * 1.5) + (1 - H[k]) * 0.12;
      var q = Math.round(M.saturate(ro) * 255);
      R[i2] = q; R[i2 + 1] = q; R[i2 + 2] = q; R[i2 + 3] = 255;
      // Widen the alpha slightly so the mip chain does not eat the leaf tips:
      // an alpha-tested card whose coverage shrinks with distance dissolves,
      // and a canopy that dissolves at 30 m is a canopy with holes in the sky.
      if (A[i2 + 3] > 8 && A[i2 + 3] < 250) A[i2 + 3] = 255;
    }

    // ---- DILATE THE COLOUR INTO THE HOLES -----------------------------------
    // clearRect leaves the transparent texels at RGB 0, and a mip chain does
    // not know they are transparent - it averages that black straight into the
    // leaf colour. The result is a dark halo round every leaf that gets worse
    // with distance, which is exactly what a "dirty grey canopy" looks like.
    // Four passes of nearest-opaque flood is enough to cover the two mip levels
    // a canopy card ever reaches.
    var mask = new Uint8Array(N * N);
    for (k = 0; k < N * N; k++) mask[k] = A[k * 4 + 3] > 8 ? 1 : 0;
    var next = new Uint8Array(N * N);
    for (var pass = 0; pass < 4; pass++) {
      next.set(mask);
      for (var jj = 0; jj < N; jj++) {
        for (var ii = 0; ii < N; ii++) {
          k = jj * N + ii;
          if (mask[k]) continue;
          var sr = 0, sg = 0, sb = 0, sn = 0;
          for (var oy = -1; oy <= 1; oy++) {
            for (var ox = -1; ox <= 1; ox++) {
              if (!ox && !oy) continue;
              var qx = ii + ox, qy = jj + oy;
              if (qx < 0 || qy < 0 || qx >= N || qy >= N) continue;
              var q = qy * N + qx;
              if (!mask[q]) continue;
              sr += A[q * 4]; sg += A[q * 4 + 1]; sb += A[q * 4 + 2]; sn++;
            }
          }
          if (!sn) continue;
          A[k * 4] = (sr / sn) | 0;
          A[k * 4 + 1] = (sg / sn) | 0;
          A[k * 4 + 2] = (sb / sn) | 0;
          next[k] = 1;
        }
      }
      mask.set(next);
    }
    gN.putImageData(iN, 0, 0);
    gR.putImageData(iR, 0, 0);
    gA.putImageData(imgA, 0, 0);
    return { albedo: cA, normal: cN, rough: cR };
  }

  // ---------------------------------------------------------------------------
  // THE BLADE SURFACE. One tiling map used by every piece of solid understory
  // geometry: u runs ACROSS the blade (0 = left edge, 0.5 = midrib, 1 = right
  // edge) and v ALONG it (0 = petiole, 1 = tip). Every plant in the understory
  // is a blade with a midrib, so one map serves grass, fern pinnae, banana,
  // taro and palm leaflets and they all agree about where the light runs.
  // ---------------------------------------------------------------------------
  function buildBladeMaps(seed) {
    var N = 512;
    var cA = canvasOf(N);
    if (!cA) return null;
    var gA = cA.getContext('2d');
    var cN = canvasOf(N), cR = canvasOf(N);
    var gN = cN.getContext('2d'), gR = cR.getContext('2d');
    if (!gA || !gN || !gR) return null;
    var iA = gA.createImageData(N, N), iN = gN.createImageData(N, N);
    var iR = gR.createImageData(N, N);
    var A = iA.data, R = iR.data;
    var H = new Float32Array(N * N);
    var i, j, k;

    for (j = 0; j < N; j++) {
      var v = j / N;
      for (i = 0; i < N; i++) {
        var u = i / N;
        k = j * N + i;
        // distance from the midrib, 0 at the spine, 1 at the edges
        var e = Math.abs(u - 0.5) * 2;
        // ---- VENATION, DRAWN RATHER THAN NOISED -----------------------------
        // 34 cycles of |sin| in v with an fbm warp on it is a CONTOUR PLOT, not
        // a leaf: on a taro blade 30 cm across that is a vein every 9 mm, all
        // of them the same weight, none of them attached to the midrib. A real
        // broadleaf has ONE midrib and 9-13 secondaries leaving it at 35-50
        // degrees, alternating left and right, each one thinning as it runs
        // out to the margin. That is what the frequencies below draw.
        //
        //   nSec       11 secondaries per blade
        //   slope      tan(42 deg) = 0.90, so a secondary crosses one unit of
        //              e for every 1.11 units of v - the angle a leaf has
        //   alt        0.5 offsets the right-hand set against the left so the
        //              pairs alternate up the rib instead of meeting it
        var nSec = 11.0;
        var side = (u < 0.5) ? 0.0 : 0.5;
        var warp = (tfbm(u * 4, v * 4, 4, seed + 3, 2) - 0.5) * 0.10;
        // parameter that is constant along one secondary: v minus the run-out
        var sPar = (v - e * 1.11 + warp) * nSec + side;
        var sFrac = Math.abs(sPar - Math.floor(sPar) - 0.5) * 2.0;
        // secondaries thin toward the margin and stop at it
        var vein = Math.pow(M.saturate(1.0 - sFrac), 5.0) *
          M.smoothstep(0.98, 0.72, e) * M.smoothstep(0.02, 0.10, v);
        // tertiary cross-linking, a much finer reticulate net between them
        var tPar = (v * 2.4 + e * 5.6 + warp * 3.0) * nSec;
        vein += Math.pow(M.saturate(1.0 - Math.abs(tPar - Math.floor(tPar) - 0.5) * 2.0),
          14.0) * 0.30 * M.smoothstep(0.95, 0.55, e);
        vein = M.saturate(vein);
        var midrib = Math.pow(M.saturate(1 - e * 7.0), 1.6);
        var mottle = tfbm(u * 5, v * 9, 5, seed, 4);
        var fine = tfbm(u * 40, v * 70, 40, seed + 17, 2);
        var blotch = M.smoothstep(0.70, 0.93, tfbm(u * 3 + 5, v * 7 - 2, 3, seed + 31, 3));

        // WATER BEADS. The level publishes wetness 0.58 and there was not one
        // bead on the leaf nearest the lens. A blade tile is roughly 0.30 m
        // across on a taro leaf, so 26 cycles is a 1.2 cm droplet - the scale a
        // drop actually is on a waxy cuticle, and small enough that it reads as
        // specular structure rather than as a bump pattern.
        var bd = tfbm(u * 26 + 3.0, v * 26 - 7.0, 26, seed + 61, 2);
        var bead = Math.pow(M.saturate((bd - 0.56) * 3.6), 0.65);

        // Veins are RAISED RIBS on the underside and channels on top; either
        // way they are the leaf's only relief and at 0.12 they were a tenth of
        // the midrib and invisible at the 1.2 m the foreground taro is actually
        // photographed from. 0.26 is still under the midrib's 0.42, which is
        // the right hierarchy.
        var h = 0.5 + midrib * 0.42 + vein * 0.26 - e * e * 0.14 +
          (fine - 0.5) * 0.05 + bead * 0.10;
        H[k] = h;

        // Colour. A tropical understory leaf is a deep blue-green with a
        // yellow-green translucent lamina between the veins; the edge is
        // darker and slightly redder where it has dried.
        var lum = 0.80 + mottle * 0.34 + (fine - 0.5) * 0.14;
        lum *= 1 - e * e * 0.22;
        var r = 0.235 * lum, g = 0.415 * lum, b = 0.150 * lum;
        // veins are paler, yellower and much less saturated than the lamina -
        // on a taro blade they are the strongest pattern the leaf has, and the
        // whole reason the eye reads it as a leaf rather than as a paddle
        r += (vein * 1.05 + midrib * 1.0) * 0.13;
        g += (vein * 1.00 + midrib * 1.0) * 0.135;
        b += (vein * 0.55 + midrib * 0.8) * 0.055;
        // a scatter of brown leaf-spot, which is what stops a jungle looking
        // like a nursery
        r = M.lerp(r, 0.30, blotch * 0.55);
        g = M.lerp(g, 0.22, blotch * 0.55);
        b = M.lerp(b, 0.09, blotch * 0.55);
        // the outermost 4% dries out
        var dry = M.smoothstep(0.90, 1.0, e);
        r = M.lerp(r, 0.32, dry * 0.6);
        g = M.lerp(g, 0.26, dry * 0.6);
        b = M.lerp(b, 0.11, dry * 0.6);

        var o = k * 4;
        A[o] = Math.round(Math.sqrt(M.saturate(r)) * 255);
        A[o + 1] = Math.round(Math.sqrt(M.saturate(g)) * 255);
        A[o + 2] = Math.round(Math.sqrt(M.saturate(b)) * 255);
        A[o + 3] = 255;

        // Waxy cuticle: genuinely glossy between the veins, matte on them and
        // on the blotches. This is where a wet leaf gets its highlight, and the
        // highlight is the only thing that separates two overlapping leaves of
        // the same value.
        var ro = 0.30 + vein * 0.30 + blotch * 0.34 + dry * 0.30 +
          (1 - M.saturate(mottle)) * 0.10 - bead * 0.26;
        var q = Math.round(M.saturate(ro) * 255);
        R[o] = q; R[o + 1] = q; R[o + 2] = q; R[o + 3] = 255;
      }
    }
    heightToNormal(H, N, 2.6, iN.data);
    gA.putImageData(iA, 0, 0);
    gN.putImageData(iN, 0, 0);
    gR.putImageData(iR, 0, 0);
    return { albedo: cA, normal: cN, rough: cR };
  }

  // ---------------------------------------------------------------------------
  // BARK. Tileable, and it carries the level's biological growth: a rainforest
  // trunk is never bare wood - it is bark under moss under lichen under algae,
  // wettest and greenest at the base and cleaner higher up. materials.js has
  // wood_plank (sawn timber) and stone, and neither is a living trunk.
  //
  // v runs UP the trunk, so the moss gradient is applied by the consumer's uv,
  // not baked in: one map serves a buttress at 0.4 m and a limb at 22 m.
  // ---------------------------------------------------------------------------
  function buildBarkMaps(seed) {
    var N = 768;
    var cA = canvasOf(N);
    if (!cA) return null;
    var gA = cA.getContext('2d');
    var cN = canvasOf(N), cR = canvasOf(N);
    var gN = cN.getContext('2d'), gR = cR.getContext('2d');
    if (!gA || !gN || !gR) return null;
    var iA = gA.createImageData(N, N), iN = gN.createImageData(N, N);
    var iR = gR.createImageData(N, N);
    var A = iA.data, R = iR.data;
    var H = new Float32Array(N * N);
    var i, j, k;

    for (j = 0; j < N; j++) {
      var v = j / N;
      for (i = 0; i < N; i++) {
        var u = i / N;
        k = j * N + i;
        // RE-AUTHORED FOR A 1.82 m TILE (BARK_UV 0.55). Every frequency below is
        // quoted in real centimetres at that tile size, which is the only way to
        // author bark that survives to thirty metres:
        //   plate     4 cycles  -> 45 cm scale plates, the macro read
        //   fissure  11 cycles  -> 17 cm clefts between them
        //   strand   34 cycles  -> 5 cm vertical fibre
        //   fine    150 cycles  -> 1.2 cm grain, the detail term
        var strand = tfbm(u * 34, v * 4, 34, seed, 3);
        var fissure = tfbm(u * 11, v * 2.5, 11, seed + 11, 3);
        var deep = M.smoothstep(0.40, 0.10, fissure);           // dark clefts
        var plate = tfbm(u * 4, v * 2.5, 4, seed + 23, 2);
        var plateEdge = M.smoothstep(0.44, 0.30, plate);        // the shed lip
        var fine = tfbm(u * 150, v * 50, 150, seed + 37, 2);

        var h = 0.42 + strand * 0.22 + plate * 0.34 - deep * 0.62 -
          plateEdge * 0.14 + (fine - 0.5) * 0.10;
        H[k] = h;

        // Base bark: a WARM grey-brown, not a neutral one. At r 0.072 g 0.062
        // b 0.046 the wood was already almost achromatic before the moss went
        // on it, and after the moss it measured a median hue of 90 degrees - the
        // dead hardwood in the signature frame was green. This is the level's
        // warm mass and it has to start warm.
        var lum = 0.30 + strand * 0.24 + plate * 0.20 - deep * 0.26;
        var r = 0.105 * (lum * 2.4), g = 0.078 * (lum * 2.4), b = 0.052 * (lum * 2.4);
        // a fresher, redder heartwood showing where a plate has shed
        r = M.lerp(r, 0.155, plateEdge * 0.42);
        g = M.lerp(g, 0.098, plateEdge * 0.42);
        b = M.lerp(b, 0.058, plateEdge * 0.42);

        // ---- moss and algae -------------------------------------------------
        // Two separate growths, because they colonise differently: a soft moss
        // that fills the clefts (so it follows the fissure field) and a flat
        // crustose lichen that sits on the raised plates (so it follows the
        // inverse).
        // MOSS COVERAGE HALVED. The map is tiled up the whole trunk, so anything
        // it paints is painted at 22 m as well as at 0.2 m - and at 0.92 strength
        // over a 0.52-threshold field it covered most of the surface, which is
        // how a brown trunk became a green one. The HEIGHT ramp that decides
        // where growth actually is now lives in _paint (bottom three metres
        // only); this layer just supplies the texture of it.
        var moss = M.smoothstep(0.64, 0.93, tfbm(u * 9 + 3, v * 6 - 4, 9, seed + 53, 3)) *
          (0.30 + deep * 0.85);
        var lich = M.smoothstep(0.72, 0.94, tfbm(u * 17 - 6, v * 11 + 2, 17, seed + 71, 3)) *
          M.saturate(1 - deep * 1.6);
        r = M.lerp(r, 0.058, moss * 0.50);
        g = M.lerp(g, 0.135, moss * 0.50);
        b = M.lerp(b, 0.040, moss * 0.50);
        // The lichen is the pale crustose one and it is deliberately WARM grey -
        // it is most of what breaks a wet trunk out of the green band.
        r = M.lerp(r, 0.235, lich * 0.62);
        g = M.lerp(g, 0.228, lich * 0.62);
        b = M.lerp(b, 0.176, lich * 0.62);

        var o = k * 4;
        A[o] = Math.round(Math.sqrt(M.saturate(r)) * 255);
        A[o + 1] = Math.round(Math.sqrt(M.saturate(g)) * 255);
        A[o + 2] = Math.round(Math.sqrt(M.saturate(b)) * 255);
        A[o + 3] = 255;

        // Wet bark is dark and only slightly glossy; moss is completely matte.
        var ro = 0.90 - strand * 0.14 + deep * 0.06 - lich * 0.10 + moss * 0.06;
        var q = Math.round(M.saturate(ro) * 255);
        R[o] = q; R[o + 1] = q; R[o + 2] = q; R[o + 3] = 255;
      }
    }
    heightToNormal(H, N, 3.4, iN.data);
    gA.putImageData(iA, 0, 0);
    gN.putImageData(iN, 0, 0);
    gR.putImageData(iR, 0, 0);
    return { albedo: cA, normal: cN, rough: cR };
  }

  // ---------------------------------------------------------------------------
  // GROUND MARK ATLAS. 2 x 2 alpha cells laid as flat cards where the terrain
  // lattice cannot resolve the thing: boot prints filling with water, a tyre
  // rut, a spill of leaf litter, and the algal scum at the water's edge.
  // ---------------------------------------------------------------------------
  var MARK_N = 2, MARK_PX = 512, MARK_CELL = MARK_PX / MARK_N;
  var MARK = { boot: 0, tread: 1, litter: 2, scum: 3 };

  // Same row inversion as atlasUV, same reason - without it the boot prints
  // draw as leaf litter and the litter draws as boot prints.
  function markUV(cell) {
    var s = 1 / MARK_N;
    var cx = (cell % MARK_N) * s, cy = (MARK_N - 1 - Math.floor(cell / MARK_N)) * s;
    var pad = 0.005 * s;
    return [cx + pad, cy + pad, cx + s - pad, cy + s - pad];
  }

  function buildMarkAtlas(rng) {
    var c = canvasOf(MARK_PX);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, MARK_PX, MARK_PX);
    var S = MARK_CELL;
    function origin(n) { return [(n % MARK_N) * S, Math.floor(n / MARK_N) * S]; }
    var o, i, j;

    // ---- 0 : a jungle boot print, holding water ---------------------------
    o = origin(MARK.boot);
    g.save(); g.translate(o[0], o[1]);
    g.fillStyle = 'rgba(24,26,18,0.80)';
    function pad(x, y, w, h, r) {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
      g.fill();
    }
    pad(S * 0.31, S * 0.09, S * 0.38, S * 0.54, S * 0.15);
    pad(S * 0.33, S * 0.67, S * 0.34, S * 0.25, S * 0.09);
    // the panama sole's chevrons, cut back out
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,0.62)';
    for (j = 0; j < 8; j++) {
      var cy = S * (0.135 + j * 0.058);
      g.beginPath();
      g.moveTo(S * 0.345, cy);
      g.lineTo(S * 0.50, cy + S * 0.022);
      g.lineTo(S * 0.655, cy);
      g.lineTo(S * 0.655, cy + S * 0.020);
      g.lineTo(S * 0.50, cy + S * 0.042);
      g.lineTo(S * 0.345, cy + S * 0.020);
      g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // standing water inside the print catches the sky - the print reads as a
    // depression rather than as a dark sticker
    g.strokeStyle = 'rgba(150,168,150,0.34)';
    g.lineWidth = S * 0.016;
    if (g.roundRect) {
      g.beginPath();
      g.roundRect(S * 0.30, S * 0.08, S * 0.40, S * 0.56, S * 0.16);
      g.stroke();
    }
    g.restore();

    // ---- 1 : a tyre rut, tiling top to bottom ------------------------------
    // A RUT IS A DEPRESSION, NOT A LADDER PAINTED ON THE GROUND. At 0.52 base
    // and 0.72 chevron alpha over near-black this cell printed a hard black
    // rung ladder across the establishing shot, on a floor the fixes above have
    // just spent three stops of dynamic range getting right. A tyre track in
    // wet mud is a soft darkening with a faint tread inside it.
    o = origin(MARK.tread);
    g.save(); g.translate(o[0], o[1]);
    g.fillStyle = 'rgba(46,48,34,0.30)';
    g.fillRect(S * 0.16, 0, S * 0.68, S);
    g.fillStyle = 'rgba(30,32,22,0.26)';
    for (j = 0; j < 14; j++) {
      var ty = j * S / 14;
      g.beginPath();
      g.moveTo(S * 0.18, ty + S * 0.008);
      g.lineTo(S * 0.50, ty + S * 0.030);
      g.lineTo(S * 0.82, ty + S * 0.008);
      g.lineTo(S * 0.82, ty + S * 0.038);
      g.lineTo(S * 0.50, ty + S * 0.060);
      g.lineTo(S * 0.18, ty + S * 0.038);
      g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(158,172,150,0.20)';
    g.lineWidth = S * 0.020;
    g.beginPath(); g.moveTo(S * 0.165, 0); g.lineTo(S * 0.165, S); g.stroke();
    g.beginPath(); g.moveTo(S * 0.835, 0); g.lineTo(S * 0.835, S); g.stroke();
    g.restore();

    // ---- 2 : a drift of fallen leaves --------------------------------------
    o = origin(MARK.litter);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 90; i++) {
      var lx = rng.range(0, S), ly = rng.range(0, S);
      var ll = rng.range(S * 0.035, S * 0.10);
      var la = rng.range(0, Math.PI * 2);
      var warm = rng.next();
      g.save(); g.translate(lx, ly); g.rotate(la);
      g.fillStyle = warm > 0.62
        ? 'rgba(' + Math.round(rng.range(96, 140)) + ',' + Math.round(rng.range(74, 100)) + ',36,0.86)'
        : (warm > 0.30
          ? 'rgba(' + Math.round(rng.range(58, 88)) + ',' + Math.round(rng.range(62, 92)) + ',32,0.84)'
          : 'rgba(' + Math.round(rng.range(38, 60)) + ',' + Math.round(rng.range(48, 70)) + ',26,0.82)');
      g.beginPath();
      g.moveTo(0, -ll);
      g.quadraticCurveTo(ll * 0.42, 0, 0, ll);
      g.quadraticCurveTo(-ll * 0.42, 0, 0, -ll);
      g.fill();
      g.restore();
    }
    g.restore();

    // ---- 3 : algal scum and silt at the water line -------------------------
    o = origin(MARK.scum);
    g.save(); g.translate(o[0], o[1]);
    for (i = 0; i < 6; i++) {
      g.fillStyle = 'rgba(' + Math.round(rng.range(52, 84)) + ',' +
        Math.round(rng.range(70, 104)) + ',' + Math.round(rng.range(30, 52)) + ',' +
        (0.10 + i * 0.055).toFixed(3) + ')';
      g.beginPath();
      var y0 = S * (0.20 + i * 0.035);
      g.moveTo(0, y0);
      for (var t = 0; t <= 14; t++) {
        g.lineTo(S * t / 14, y0 + Math.sin(t * 1.4 + i * 1.7) * S * 0.045);
      }
      g.lineTo(S, S); g.lineTo(0, S); g.closePath(); g.fill();
    }
    for (i = 0; i < 240; i++) {
      g.fillStyle = 'rgba(120,140,70,' + rng.range(0.10, 0.45).toFixed(2) + ')';
      g.fillRect(rng.range(0, S), rng.range(S * 0.2, S), rng.range(1, 4), rng.range(1, 3));
    }
    g.restore();

    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // A ground mark lying flat in atlas cell `cell`.
  function markCard(B, cell, x, y, z, w, h, yaw, tintC) {
    var uv = markUV(cell);
    var g = quad(w, h, uv[0], uv[1], uv[2], uv[3]);
    var old = B.tint;
    if (tintC) B.tint = tintC;
    B.add('mark', g, makeM(x, y, z, -Math.PI * 0.5, yaw || 0, 0));
    B.tint = old;
  }

  // ============================================================ THE SANDBAG ==
  // A CHAMFERED BOX CANNOT BE A SANDBAG, AND TWO ROUNDS OF TRYING PROVED IT.
  //
  // Geo.bevelBox INSETS: at min(w,h,d) * 0.24 every joint in a running-bond
  // course became a V-groove 16 cm wide and 8 cm deep in a perfectly regular
  // lattice, so the bunker revetment photographed as a perforated breeze-block
  // screen with daylight through the top course, and no amount of widening the
  // box fixed it because the FACES stayed flat and the GRID stayed a grid.
  //
  // This is a real pillow: a superellipsoid (rounded rectangle in every
  // section, so stacked bags leave no diamond gaps the way ellipsoids do) with
  // a sagging top, a spread base, a seam ridge across the closed end and a
  // three-axis noise displacement. Seven variants are baked once and shared -
  // five sound, one slumped, one burst - so a run differs in KIND along its
  // length and not merely in degree.
  //
  // 72 triangles each against the old box's 12. At ~2000 bags in the level that
  // is +120k triangles, which is the single best-spent 3% of the budget here:
  // the revetment is in four of the five published framings.
  var _bagCache = null;

  function sgnPow(t, e) {
    var a = Math.abs(t);
    var v = Math.pow(a, e);
    return t < 0 ? -v : v;
  }

  // How many times the hessian weave wraps a single bag. The bag is authored at
  // unit size and squashed to roughly 0.44 x 0.42 x 0.74 m, so 3.4 tiles round
  // its girth is a ~12 cm weave repeat - the scale sacking actually is, and
  // small enough that the tile never reads as a pattern at hero3's range.
  var BAG_UV = 3.4;

  function bagGeo(rng, variant, hi) {
    // NU is latitude and it is what draws the TOP RIM in silhouette; NV is
    // longitude and it is what draws the girth. 5 x 8 put a countable polyline
    // along the top course of every run at hero3's range. 7 x 10 is +75%
    // triangles on this object only, and it is paid for by the concertina (924
    // sub-texel rods -> 616, and out of the shadow pass entirely).
    var NU = hi ? 7 : 5, NV = hi ? 10 : 8;
    // MEASURED AND SOFTENED ONCE. At 0.34 / 0.42 the superellipsoid is a
    // rounded BOX: 89% of its height is reached by the second latitude ring, so
    // it has a flat top, a flat front and a hard edge between them - and under
    // the bunker's one warm lantern that edge banded, and the revetment
    // photographed as a wall of overlapping roof shingles. 0.50 / 0.54 rolls the
    // top over into the face so the highlight travels instead of stopping,
    // which is what a bag full of sand does. Still far enough from 1.0 that the
    // section is a rounded rectangle and stacked bags leave no diamond gaps -
    // the failure an ellipsoid would bring straight back.
    // e1 IS THE VERTICAL PROFILE AND 0.50 IS A SQUIRCLE, NOT A PILLOW.
    // A superellipsoid's vertical section is |r|^(2/e1) + |y|^(2/e1) = 1, so at
    // e1 = 0.50 that is |r|^4 + |y|^4 = 1: a rounded BOX. Measured on the
    // seven-band bag, the rings above the equator sat at 0.70 / 0.795 / 0.82 of
    // full height - i.e. the top 30% of the bag is a flat plate with a hard
    // shoulder falling away from it - and at hero3's range the revetment
    // photographed as a stack of roof tiles with a bright rim on every one.
    // 0.90 makes the vertical section very nearly a circle (rings at
    // 0.25 / 0.59 / 0.76 / 0.78), which is a pillow. e2 stays at 0.54 because
    // that is the PLAN section, and a rounded-rectangle plan is what stops
    // stacked bags leaving diamond gaps - the failure an ellipsoid brings back.
    var e1 = 0.90, e2 = 0.54;
    var slump = variant === 5, burst = variant === 6;
    var pos = [], nor = [], uvv = [];
    var pts = [], iu, iv;
    var noiseAmp = burst ? 0.15 : 0.065;
    var seedA = rng.range(0, 100), seedB = rng.range(0, 100);
    for (iu = 0; iu <= NU; iu++) {
      var eta = -Math.PI * 0.5 + Math.PI * (iu / NU);
      var ce = Math.cos(eta), se = Math.sin(eta);
      var row = [];
      for (iv = 0; iv <= NV; iv++) {
        var w = -Math.PI + Math.PI * 2 * (iv / NV);
        var cw = Math.cos(w), sw = Math.sin(w);
        var x = sgnPow(ce, e1) * sgnPow(cw, e2);
        var y = sgnPow(se, e1);
        var z = sgnPow(ce, e1) * sgnPow(sw, e2);
        // A FILLED BAG IS A PILLOW: it bulges at the waist and its top is a
        // slightly FLATTENED DOME. The first attempt subtracted 0.40 from the
        // top pole while leaving the ring below it where it was, which with
        // four latitude bands put the pole at 0.60 under a ring at 0.74 - i.e.
        // it dished the top, and eleven courses of dished tops photographed as
        // a wall of paper plates. Scale the whole upper hemisphere instead, so
        // the surface stays convex everywhere.
        // THE TOP WAS DISHED, AND THAT IS WHY THE REVETMENT PHOTOGRAPHED AS A
        // WALL OF CARDBOARD EGG-CARTON CELLS. The flattening was driven by
        // rad = 1 - (x^2 + z^2), which is ~1 at the pole and ~0.4 at the ring
        // below it - so the pole came down to 0.850 while the ring below stayed
        // at 0.903, i.e. every bag in the level had a CRATER in its top face.
        // Smooth normals then shaded that crater as a scoop and eleven courses
        // of scoops is exactly the "stacked cardboard" read, at every range.
        // Driving the flattening off y itself keeps dy/deta positive
        // everywhere (d/dy[y - k y^3] = 1 - 3k y^2 > 0 for k <= 0.30), so the
        // surface stays CONVEX: a flattened dome, which is what a bag of sand
        // with another bag on top of it actually is.
        var fl = slump ? 0.34 : 0.24;
        if (y > 0) y *= 1 - fl * y * y;
        else { var sp = 1 + 0.16 * (-y); x *= sp; z *= sp; }
        if (slump) { y *= 0.62; x *= 1.18; z *= 1.14; }
        if (burst) {
          // one end has split and spilled: the far half collapses and splays
          var f = M.saturate((x + 0.4) / 1.2);
          y *= M.lerp(1.0, 0.34, f);
          z *= M.lerp(1.0, 1.45, f);
          x *= 1.16;
        }
        // three-axis lump. Deterministic in the vertex's own direction so the
        // two ends of the seam agree and the shape stays closed.
        var nse = tval(x * 2.6 + seedA, z * 2.6 + y * 1.7 + seedB, 64, 7) - 0.5;
        var nse2 = tval(y * 3.9 + seedB, x * 3.1 - z * 2.2 + seedA, 64, 23) - 0.5;
        var gain = 1 + noiseAmp * (nse * 2.2 + nse2 * 1.4);
        x *= gain; y *= gain * 0.9; z *= gain;
        // the stitched seam runs across the closed end
        if (!burst && y > 0.15) {
          var sr = Math.exp(-(z * z) * 26.0) * M.smoothstep(0.15, 0.55, y);
          y += 0.032 * sr;
        }
        row.push([x * 0.5, y * 0.5, z * 0.5]);
      }
      pts.push(row);
    }
    for (iu = 0; iu < NU; iu++) {
      for (iv = 0; iv < NV; iv++) {
        var A = pts[iu][iv], Bp = pts[iu][iv + 1];
        var C = pts[iu + 1][iv + 1], D = pts[iu + 1][iv];
        // PARAMETRIC uv, scaled so the weave tiles around the pillow and
        // follows its curvature. SURF.sandbag carries keepUV so _finalize keeps
        // these rather than reprojecting them from the world axes.
        var ua = (iv / NV) * BAG_UV, ub = ((iv + 1) / NV) * BAG_UV;
        var va = (iu / NU) * BAG_UV * 0.62, vb = ((iu + 1) / NU) * BAG_UV * 0.62;
        pushQuad(pos, nor, uvv, A, Bp, C, D,
          [ua, va], [ub, va], [ub, vb], [ua, vb]);
      }
    }
    // SMOOTH, NOT FLAT. THREE.BufferGeometry.computeVertexNormals() on a
    // NON-INDEXED geometry writes the FACE normal to all three vertices, so the
    // pillow came out as sixty-four hard facets - and eleven courses of hard
    // facets under the bunker's one warm lantern photographed as a wall of
    // overlapping roof shingles, which is a different wrong object from the
    // breeze-block screen but every bit as wrong.
    smoothNormals(pos, nor);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvv), 2));
    return g;
  }

  var _bagCacheHi = null;
  function bagShapes(rng, hi) {
    if (hi) {
      if (_bagCacheHi) return _bagCacheHi;
      _bagCacheHi = [];
      for (var h = 0; h < 7; h++) _bagCacheHi.push(bagGeo(rng, h, true));
      return _bagCacheHi;
    }
    if (_bagCache) return _bagCache;
    _bagCache = [];
    for (var v = 0; v < 7; v++) _bagCache.push(bagGeo(rng, v, false));
    return _bagCache;
  }

  // WHERE THE SILHOUETTE HAS TO SURVIVE. A revetment is in four of five
  // published framings but only ever from a handful of standpoints, so the
  // extra latitude bands are spent where a rim is actually resolvable and the
  // far side of the perimeter keeps the cheap pillow. Filled in by plan().
  var _bagDetail = null;
  function bagLOD(x, z) {
    var A = _bagDetail;
    if (!A) return true;
    for (var i = 0; i < A.length; i++) {
      var dx = x - A[i][0], dz = z - A[i][1];
      if (dx * dx + dz * dz < A[i][2]) return true;
    }
    return false;
  }

  // ============================================================== THE PLANTS ==
  // Every generator below returns geometry in LOCAL space with its origin at
  // the base of the plant, so the wind sway (which scales with local y) and the
  // instance transform both behave.

  function whiteColor(g) {
    var n = g.attributes.position.count;
    var a = new Float32Array(n * 3);
    for (var i = 0; i < n * 3; i++) a[i] = 1;
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  }

  // Elephant grass. The signature understory of the delta and the thing the
  // camera stands in, so it is real folded ribbon geometry, never a card.
  function grassClump(rng, scale, blades) {
    var list = [];
    var n = blades || rng.int(9, 13);
    for (var i = 0; i < n; i++) {
      var yaw = rng.range(0, Math.PI * 2);
      var tilt = rng.range(0.10, 0.62) * (rng.bool(0.25) ? 1.7 : 1.0);
      var len = rng.range(0.80, 2.05) * scale;
      var wid = rng.range(0.026, 0.052) * (0.7 + scale * 0.4);
      var g = blade(len, wid, len * rng.range(0.30, 0.58), len * rng.range(-0.10, 0.10),
        0.62, 6, 0);
      var off = rng.range(0, 0.13) * scale;
      applyMatrix(g, makeM(Math.sin(yaw) * off, 0, Math.cos(yaw) * off, tilt, yaw, 0));
      list.push(g);
    }
    return whiteColor(weld(list));
  }

  // Fern. A crown of pinnate fronds; each frond is a rachis with alternating
  // leaflets that shorten toward the tip.
  // MEASURED AND TRIMMED. The fern was 634k triangles - the single largest
  // object in the level, a third of the whole main pass - at 900 triangles a
  // plant for something that is knee-high and mostly seen at five metres.
  // Fewer fronds, fewer pinnae and a 3-sided rachis takes it to about 480 and
  // pays for the taro's cupped leaves and the pillow sandbags.
  function fernPlant(rng, scale, nf, np0) {
    var list = [];
    nf = nf || rng.int(3, 5);
    for (var f = 0; f < nf; f++) {
      var yaw = rng.range(0, Math.PI * 2);
      var tilt = rng.range(0.45, 1.02);
      var len = rng.range(0.62, 1.10) * scale;
      var st = [];
      var seg = 4, i;
      for (i = 0; i <= seg; i++) {
        var t = i / seg;
        st.push([0, len * t - len * 0.34 * t * t * t, 0, 0.016 * (1 - t * 0.72) * scale]);
      }
      var rach = tube(st, 3, false);
      var sub = [rach];
      var np = np0 || rng.int(5, 7);
      for (i = 1; i <= np; i++) {
        var t2 = i / (np + 1);
        var py = len * t2 - len * 0.34 * t2 * t2 * t2;
        var pl = len * (0.30 - t2 * 0.22) * rng.range(0.85, 1.15);
        var pw = pl * 0.30;
        for (var s = -1; s <= 1; s += 2) {
          var lg = blade(pl, pw, pl * 0.22, 0, 0.5, 3, 1);
          applyMatrix(lg, makeM(0, py, 0, 0, s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, 0));
          applyMatrix(lg, makeM(0, 0, 0, -1.15 + t2 * 0.30, 0, 0));
          sub.push(lg);
        }
      }
      var frond = weld(sub);
      applyMatrix(frond, makeM(0, 0, 0, tilt, yaw, 0));
      list.push(frond);
    }
    return whiteColor(weld(list));
  }

  // Taro / philodendron. Big soft heart-shaped leaves held out nearly flat on
  // long petioles. These are the level's largest single leaves at eye height
  // and the surface the shafts actually land on.
  function taroPlant(rng, scale, n) {
    var list = [];
    n = n || rng.int(3, 5);
    for (var i = 0; i < n; i++) {
      var yaw = rng.range(0, Math.PI * 2);
      var ph = rng.range(0.45, 0.95) * scale;
      var lean = rng.range(0.30, 0.72);
      var st = [];
      for (var k = 0; k <= 3; k++) {
        var t = k / 3;
        st.push([0, ph * t, 0, 0.022 * (1 - t * 0.35) * scale]);
      }
      var pet = tube(st, 5, false);
      var ll = rng.range(0.34, 0.58) * scale;
      // 9 segments and 5 columns, not 5 and 3. A taro leaf at 40 cm from the
      // lens is the single largest thing in the understory and it was reading
      // with six countable silhouette points per edge and three broad tonal
      // bands. Nine gives a smooth outline; the fifth column turns the chevron
      // crease into a parabola, so the leaf CUPS and carries a continuous
      // gradient across its own width.
      // fold 0.34, not 0.58: with five columns the fold is a real cross-section
      // curve rather than a crease angle, and 0.58 of the half-width made a
      // taco. A taro leaf is a shallow dish.
      var lf = blade(ll, ll * 0.48, ll * 0.34, ll * rng.range(-0.10, 0.10), 0.34, 9, 1, 5);
      applyMatrix(lf, makeM(0, ph, 0, rng.range(1.05, 1.55), rng.range(-0.5, 0.5), 0));
      var whole = weld([pet, lf]);
      applyMatrix(whole, makeM(0, 0, 0, lean, yaw, 0));
      list.push(whole);
    }
    return whiteColor(weld(list));
  }

  // Banana. A pseudostem and six to nine enormous split leaves. Placed at the
  // water's edge and around the firebase, where they break a straight sandbag
  // line with something soft and very large.
  function bananaPlant(rng, scale, n0) {
    var list = [];
    var h = rng.range(1.15, 1.90) * scale;
    var st = [];
    for (var k = 0; k <= 4; k++) {
      var t = k / 4;
      st.push([0, h * t, 0, (0.135 - t * 0.055) * scale]);
    }
    list.push(tube(st, 6, false));
    var n = n0 || rng.int(5, 7);
    for (var i = 0; i < n; i++) {
      var yaw = i * (Math.PI * 2 / n) + rng.range(-0.35, 0.35);
      var ll = rng.range(1.05, 1.75) * scale;
      var lf = blade(ll, ll * 0.20, ll * rng.range(0.42, 0.72), ll * rng.range(-0.12, 0.12),
        0.40, 9, 1, 5);
      applyMatrix(lf, makeM(0, h * rng.range(0.72, 1.0), 0, rng.range(0.55, 1.35), yaw, 0));
      list.push(lf);
    }
    return whiteColor(weld(list));
  }

  // Palm. Trunk plus a crown of pinnate fronds - the mid-storey silhouette,
  // and the one plant whose shape reads at 40 m through mist.
  function palmTree(rng, scale) {
    var h = rng.range(4.2, 7.4) * scale;
    var lean = rng.range(-0.30, 0.30);
    var st = [], k;
    for (k = 0; k <= 6; k++) {
      var t = k / 6;
      st.push([lean * t * t * h * 0.30, h * t, lean * 0.4 * t * t * h * 0.30,
        (0.185 - t * 0.062) * scale]);
    }
    return { trunk: whiteColor(tube(st, 8, false)), top: h, lean: lean };
  }

  function palmCrown(rng, scale, n) {
    var list = [];
    n = n || rng.int(8, 11);
    for (var f = 0; f < n; f++) {
      var yaw = f * (Math.PI * 2 / n) + rng.range(-0.22, 0.22);
      var len = rng.range(1.8, 3.1) * scale;
      var st = [], i;
      for (i = 0; i <= 6; i++) {
        var t = i / 6;
        st.push([0, len * t * 0.55 - len * 0.42 * t * t * t, len * t * 0.82, 0.030 * (1 - t * 0.7) * scale]);
      }
      var sub = [tube(st, 4, false)];
      var np = 7;
      for (i = 1; i <= np; i++) {
        var t2 = i / (np + 1);
        var py = len * t2 * 0.55 - len * 0.42 * t2 * t2 * t2;
        var pz = len * t2 * 0.82;
        var pl = len * (0.34 - t2 * 0.20) * rng.range(0.85, 1.15);
        for (var s = -1; s <= 1; s += 2) {
          var lg = blade(pl, pl * 0.085, pl * 0.30, 0, 0.7, 3, 0);
          applyMatrix(lg, makeM(0, py, pz, -0.55, s > 0 ? 1.15 : -1.15, 0));
          sub.push(lg);
        }
      }
      var frond = weld(sub);
      applyMatrix(frond, makeM(0, 0, 0, rng.range(-0.45, 0.25), yaw, 0));
      list.push(frond);
    }
    return whiteColor(weld(list));
  }

  // Bamboo. Splayed segmented culms; the leaves ride as separate cards on the
  // same instance transform so the clump costs two draw calls, not two hundred.
  function bambooCulms(rng, scale, n) {
    var list = [];
    n = n || rng.int(6, 10);
    for (var i = 0; i < n; i++) {
      var yaw = rng.range(0, Math.PI * 2);
      var splay = rng.range(0.04, 0.24);
      var h = rng.range(5.0, 10.5) * scale;
      var r = rng.range(0.035, 0.062) * scale;
      var st = [], k;
      var segs = 7;
      for (k = 0; k <= segs; k++) {
        var t = k / segs;
        var bendv = Math.pow(t, 2.2) * h * splay;
        st.push([Math.sin(yaw) * bendv, h * t, Math.cos(yaw) * bendv,
          r * (1 - t * 0.42) * (1 + 0.16 * Math.sin(t * segs * Math.PI))]);
      }
      var off = rng.range(0, 0.55) * scale;
      var oy = rng.range(0, Math.PI * 2);
      var g = tube(st, 5, false);
      applyMatrix(g, makeM(Math.sin(oy) * off, 0, Math.cos(oy) * off, 0, 0, 0));
      list.push(g);
    }
    return whiteColor(weld(list));
  }

  // The alpha-cut half of the level, used only above eight metres.
  function cardGeo(w, h, cell) {
    var uv = atlasUV(cell);
    return quad(w, h, uv[0], uv[1], uv[2], uv[3]);
  }

  // A canopy blob: crossed cards on a squashed sphere. Six to ten cards each,
  // three atlas cells, so no two clusters in the level are the same stamp.
  function canopyCluster(rng, radius, cell) {
    var list = [];
    // Fourteen to eighteen cards, and they cost two triangles each. A canopy is
    // the cheapest geometry in the level and the one thing the level cannot do
    // without, so it gets the density; the understory pays for it.
    var n = rng.int(14, 18);
    for (var i = 0; i < n; i++) {
      var yaw = rng.range(0, Math.PI * 2);
      var pit = rng.range(-0.75, 0.55);
      var rr = radius * Math.sqrt(rng.next()) * 0.95;
      var s = radius * rng.range(1.20, 1.85);
      var g = cardGeo(s, s * rng.range(0.74, 1.0), cell).clone();
      applyMatrix(g, makeM(0, 0, 0, 0, 0, rng.range(0, Math.PI * 2)));
      applyMatrix(g, makeM(Math.sin(yaw) * rr, Math.sin(pit) * radius * 0.60,
        Math.cos(yaw) * rr, pit, yaw + Math.PI * 0.5, 0));
      list.push(g);
    }
    return whiteColor(weld(list));
  }

  // A DRIFT OF FALLEN LEAVES, AS GEOMETRY.
  //
  // The forest floor is 30-40% of every exterior framing in this level and it
  // was carrying its whole information budget in one 39 cm triplanar tile.
  // Measured: hero1 and hero2 - the two framings that matter - reported 11.0%
  // and 13.5% flat area against 5.1-6.3% on the other three, and cropped to one
  // metre the near bank is a uniform ochre grain with no object of any kind
  // lying on it. Flat `mark` cards were already being painted there and they
  // read as exactly what they are: dark amoebae with no silhouette and no
  // shading.
  //
  // Six real broadleaves lying nearly flat plus two twigs is 132 triangles. It
  // has an outline, it self-shadows, it catches the sheen and clearcoat the
  // blade material already carries off weather.wetness, and its instance tint
  // runs it dead-brown - which makes the litter the largest warm mass in a level
  // whose named failure mode is "saturated green must not become a flat green
  // wash". It rides the `blade` material, so it costs no new material and no new
  // texture, and it never casts.
  function deadLeaves(rng, scale) {
    var list = [];
    var i, k, t;
    // 5 blades and 1 twig, not 7 and 2, and it is a BUDGET decision rather than an
    // art one. lv_firefight - the level's worst frame, because it carries the AI
    // and the VFX on top of the world - measured 485 draws and 4.39 M triangles
    // against ceilings of 500 and 4.5 M, i.e. two per cent of margin. The litter
    // is ~4200 instances and by far the largest single line of the new spend, so
    // 148 triangles a drift down to 98 is where the margin comes back. A drift of
    // five leaves reads the same as one of seven at any range a player sees it.
    var n = 5;
    for (i = 0; i < n; i++) {
      var a = i * (Math.PI * 2 / n) + rng.range(-0.55, 0.55);
      // 11-26 cm, MEASURED AND HALVED. The first pass authored 19-42 cm blades
      // and then scaled them up to 1.7, so the near field of hero1 came back as a
      // carpet of 60 cm dinner plates - which is a stand of collapsed taro, not
      // litter. A fallen forest leaf is hand-sized.
      var ln = rng.range(0.11, 0.26) * scale;
      // shape 1 (widest at mid-length) with a shallow fold. A leaf on the
      // ground has curled, so it is not a flat card - but it is not a dish
      // either, and at 0.26 the section is the low arch a drying leaf holds.
      var g = blade(ln, ln * 0.50, ln * 0.10, ln * rng.range(-0.14, 0.14),
        0.26, 4, 1, 3);
      // rx near pi/2 lays the blade's +Y length axis down into the ground plane.
      // The SPREAD is what matters and 0.20 was not enough: every leaf presented
      // very nearly the same face to the sky, so the blade material's sheen and
      // clearcoat lit the whole drift as one sheet of wet plastic. At +/-0.40 the
      // leaves catch the dome at a dozen different angles, which is what a drift
      // of curled leaves does.
      applyMatrix(g, makeM(
        Math.sin(a) * rng.range(0.02, 0.20) * scale,
        rng.range(0.004, 0.030) * scale,
        Math.cos(a) * rng.range(0.02, 0.20) * scale,
        1.30 + rng.range(-0.55, 0.55), a, rng.range(-0.65, 0.65)));
      list.push(g);
    }
    for (i = 0; i < 1; i++) {
      var ta = rng.range(0, Math.PI * 2);
      var tl = rng.range(0.16, 0.34) * scale;
      var tr = rng.range(0.008, 0.016) * scale;
      var st = [];
      for (k = 0; k <= 3; k++) {
        t = k / 3;
        st.push([Math.sin(ta) * tl * t,
          (0.010 + t * t * 0.014) * scale,
          Math.cos(ta) * tl * t, tr * (1 - t * 0.55)]);
      }
      list.push(tube(st, 3, false));
    }
    return whiteColor(weld(list));
  }

  function bambooLeafCards(rng, scale, n) {
    var list = [];
    n = n || rng.int(10, 16);
    for (var i = 0; i < n; i++) {
      var yaw = rng.range(0, Math.PI * 2);
      var h = rng.range(4.4, 9.5) * scale;
      var s = rng.range(0.9, 1.7) * scale;
      var g = cardGeo(s, s * 1.3, CELL.bamboo).clone();
      applyMatrix(g, makeM(Math.sin(yaw) * rng.range(0.2, 1.5) * scale, h,
        Math.cos(yaw) * rng.range(0.2, 1.5) * scale,
        rng.range(-0.3, 0.3), yaw, rng.range(-0.4, 0.4)));
      list.push(g);
    }
    return whiteColor(weld(list));
  }

  // ================================================================ THE PLAN ==
  // Everything with a world position is decided here, once, before build().
  // props_jungle.js reads it through level.anchors the instant the level object
  // exists - it never has to wait for geometry and never reads a camera pose.
  function plan(P) {
    var rng = P.rng;
    var i;

    // ---- the clearings ------------------------------------------------------
    // Where sky reaches the floor. These are the level's value range: without
    // them a canopy level is one flat shade of green from edge to edge. Each
    // one is somewhere a framing looks, and three of the four carry a shaft.
    P.clearings = [
      { x: 3.0, z: 36.0, r: 10.5, open: 0.92 },     // the track, south of the creek
      { x: 1.4, z: 8.0, r: 8.6, open: 0.86 },       // the track, mid
      { x: -13.0, z: 10.5, r: 14.5, open: 1.00 },   // the wreck, at the water
      // 30 m, not 21. A firebase clears a field of fire, and the OVERVIEW
      // framing stands on the tower inside it: with a 21 m clearing the canopy
      // closed to within twelve metres of the platform and the establishing
      // shot was a close-up of leaves.
      { x: FB_X, z: FB_Z, r: 30.0, open: 1.00 },    // the firebase, cut flat
      { x: 3.2, z: 26.5, r: 8.0, open: 0.80 }       // the creek crossing
    ];

    // ---- the firebase -------------------------------------------------------
    P.pads = [];
    var fbTop = rawY(FB_X, FB_Z, P);
    var fb = P.firebase = {
      x: FB_X, z: FB_Z, y: fbTop, yaw: FB_YAW, r: FB_R,
      wallH: 1.38, wallT: 1.15,
      gateB: -0.10,          // bearing of the gate, 0 = toward +Z
      breachB: 2.05
    };
    P.pads.push({ x: FB_X, z: FB_Z, r: 15.8, fade: 5.4, y: fbTop });

    var c = Math.cos(FB_YAW), s = Math.sin(FB_YAW);
    function fbW(lx, lz) { return [FB_X + lx * c + lz * s, FB_Z - lx * s + lz * c]; }
    P.fbW = fbW;

    var bunkerP = fbW(-5.2, -3.2);
    P.bunker = {
      x: bunkerP[0], z: bunkerP[1], yaw: FB_YAW + 0.14,
      w: 9.8, d: 6.6, y: fbTop,
      sink: 1.38, wall: 2.55, roof: 0.55
    };
    // Pushed AFTER the plateau pad so padBlend's tie-break picks it: this is
    // the hole the command post sits in, and without it the level has a
    // sandbag box standing on a flat field instead of a dug-in bunker.
    P.pads.push({ x: P.bunker.x, z: P.bunker.z,
      hx: P.bunker.w * 0.5 - 0.15, hz: P.bunker.d * 0.5 - 0.15,
      c: Math.cos(P.bunker.yaw), s: Math.sin(P.bunker.yaw),
      fade: 0.75, y: fbTop - P.bunker.sink });

    var towerP = fbW(7.4, 4.6);
    P.tower = {
      // The tower's yaw is not decorative. The OVERVIEW framing stands on its
      // platform, and a platform has a rail, a sandbag parapet and four roof
      // posts round it - so the tower is turned until one clear parapet edge
      // faces the shot. Looking out over an EDGE puts the rail 77 degrees
      // below the eye and the two corner posts 86 degrees off axis, i.e. all
      // three out of frame; looking out over a CORNER, which is what the first
      // build did, put a post and a handrail straight through the middle of
      // the establishing shot.
      // -1.30, not -1.87. THE ESTABLISHING SHOT WAS A PHOTOGRAPH OF A ROOF: at
      // -1.87 the pose stood 14.8 m from the command bunker ON ITS AXIS, so the
      // sandbag roof plus the PSP pad filled the bottom two thirds and nothing
      // at ground level inside the wire was in shot - not the fire, the fuel
      // point, the stores dump, the billet, the gate or the mortar pit.
      //
      // Bearings from this platform: bunker -1.86, shelter -1.87, drum -1.53,
      // mortar -1.16, gate -0.60. Turning to -1.30 puts the bunker roof 32
      // degrees off axis (it falls to the left edge, where a big near mass
      // belongs) and brings the drum, the mortar pit and the gate into the
      // middle and right of the frame. The tower turns with it so its one clear
      // parapet edge still faces the shot - looking out over a CORNER puts a
      // post and a handrail through the middle of the establishing shot, which
      // is what the first build did.
      x: towerP[0], z: towerP[1], yaw: -1.30,
      legR: 1.72, platY: 8.15, roofY: 10.75, y: fbTop, lean: 0.045
    };
    var mortarP = fbW(-8.2, 7.0);
    P.mortar = { x: mortarP[0], z: mortarP[1], r: 2.75, y: fbTop, sink: 0.85 };
    var padP = fbW(3.0, -9.2);
    P.helipad = { x: padP[0], z: padP[1], r: 6.4, y: fbTop, yaw: FB_YAW + 0.5 };
    var mastP = fbW(10.2, -7.4);
    P.mast = { x: mastP[0], z: mastP[1], y: fbTop, h: 9.4 };
    var drumP = fbW(-1.6, 2.6);
    P.drum = { x: drumP[0], z: drumP[1], y: fbTop, yaw: 0.4 };
    var shelP = fbW(-10.8, -6.8);
    P.shelter = { x: shelP[0], z: shelP[1], y: fbTop, yaw: FB_YAW + 1.1 };
    var gateP = [FB_X + Math.sin(fb.gateB) * FB_R, FB_Z + Math.cos(fb.gateB) * FB_R];
    P.gate = { x: gateP[0], z: gateP[1], y: fbTop };

    // ---- the wreck ----------------------------------------------------------
    // Nose in the shallows, tail up the bank, rolled onto its left side. Solved
    // against the channel rather than guessed so it never floats or sinks: the
    // nose sits on the bed under 30-40 cm of water, the tail on dry mud.
    var hz = 10.5;
    var heliYaw = -1.02;                        // fuselage axis, world
    var hx = riverC(hz) + riverHalf(hz) * 0.86;
    P.heli = {
      x: hx, z: hz, yaw: heliYaw, roll: 0.44, pitch: -0.16,
      y: rawY(hx, hz, P) + 0.30
    };
    P.pads.push({ x: hx, z: hz, hx: 5.2, hz: 4.4, c: Math.cos(heliYaw),
      s: Math.sin(heliYaw), fade: 3.0, y: P.heli.y - 0.30 });

    // ---- the creek crossing -------------------------------------------------
    var bx = trackX(CREEK_Z), bz = creekZ(bx);
    P.bridge = {
      x: bx, z: bz, w: 2.6,
      nearZ: bz + CREEK_HALF + 0.9,
      farZ: bz - CREEK_HALF - 0.9,
      y: rawY(bx, bz + CREEK_HALF + 2.4, P) - 0.10
    };
    P.pads.push({ x: bx, z: P.bridge.nearZ, hx: 3.4, hz: 1.5, c: 1, s: 0,
      fade: 1.4, y: P.bridge.y });
    P.pads.push({ x: bx, z: P.bridge.farZ, hx: 3.4, hz: 1.5, c: 1, s: 0,
      fade: 1.4, y: P.bridge.y });

    // ---- the French sluice, where the creek meets the river -----------------
    var sx = riverC(CREEK_Z) + riverHalf(CREEK_Z) - 1.4;
    var sz = creekZ(sx);
    P.sluice = { x: sx, z: sz, yaw: 0.12, y: WATER_Y + 0.10, h: 3.4, w: 6.6 };
    P.pads.push({ x: sx, z: sz, hx: 3.6, hz: 2.4, c: 1, s: 0, fade: 1.8,
      y: WATER_Y + 0.10 });

    // ---- the spirit house ---------------------------------------------------
    // A san phra phum on a post beside the track. It is the only warm thing in
    // the southern half of the level and the only human mark that is not
    // military, and it is deliberately in hero1's frame: the candles inside it
    // are what keeps grade_split positive in a picture that is otherwise green.
    var shz = 38.5;
    var shx = trackX(shz) + 3.9;
    P.shrine = { x: shx, z: shz, yaw: -0.62, y: rawY(shx, shz, P), h: 1.28 };
    P.pads.push({ x: shx, z: shz, hx: 1.1, hz: 1.1, c: 1, s: 0, fade: 1.0,
      y: P.shrine.y });

    // ---- where the camera stands --------------------------------------------
    // A published framing is useless if a 1.4 m taro leaf is growing 40 cm in
    // front of the lens, and the scatter has no way to know that on its own -
    // hero2 came back as a wall of flat green paper with the wreck somewhere
    // behind it. The standpoints are decided HERE, in the plan, from the same
    // anchors the framings use, so the planting can be told to leave them
    // alone. This is the one thing in the file that the camera and the world
    // are allowed to share, and it goes in this direction only: the plan tells
    // the camera where it may stand, never the other way round.
    // CLEAR THE SIGHTLINE, NOT THE STANDPOINT. The old marks were radial: a
    // 2.6 m bubble round each pose plus a 2.3 m keep-out either side of the
    // track centreline. hero1 stands 1.45 m off that centreline, so BOTH
    // applied to the same ground and the nearest three metres of a level
    // briefed as "dense tropical growth" was bare floor in its own signature
    // image. A cone does the job the bubble was meant to do - it keeps the
    // SUBJECT clear - and lets plants grow beside and behind the lens, which is
    // where a first-person frame gets its foreground from.
    //
    //   r      a small hard bubble right at the lens
    //   tx,tz  what the pose is looking at
    //   reach  how far down the sightline the subject needs clear air
    //   half   half-angle of the cone, radians
    function mark(x, z, tx, tz, r, reach, half) {
      var dx = tx - x, dz = tz - z;
      var dl = Math.sqrt(dx * dx + dz * dz) || 1;
      return { x: x, z: z, r: r, bx: dx / dl, bz: dz / dl,
        reach: reach, half: half };
    }
    var h1x0 = trackX(48) - 1.45;
    P.camMarks = [
      mark(h1x0, 48.0, trackX(33.0), 33.0, 1.05, 13.0, 0.42),
      // Perpendicular to the fuselage axis (yaw -1.02), so the framing gets the
      // machine in PROFILE - nose, cabin, mast, torn boom, drooping blade, all
      // reading as separate shapes. The tail quarter, which is where the first
      // search put it, is a box seen end-on. One cone down the whole corridor
      // replaces the five overlapping bubbles that used to walk to the wreck.
      mark(P.heli.x + 5.49, P.heli.z + 8.95, P.heli.x, P.heli.z, 1.15, 13.5, 0.40)
    ];

    // hero3's standpoint, solved here so the planting and the pose agree.
    //
    // MEASURED AND CORRECTED TWICE, and both corrections are worth recording
    // because both were arithmetic rather than taste.
    //
    // (1) The first attempt stepped 3.4 m along the camera's own RIGHT vector
    //     to widen the gap between the tower and the brazier. Moving right
    //     swings the world LEFT in frame, so the command bunker - which bears
    //     0.11 rad against the tower's 0.89 - came round into the shot and
    //     filled the bottom-right 55% of it with revetment at four metres.
    // (2) The second stepped BACK, which put the camera 3.6 m inside the
    //     south-west perimeter revetment and made THAT the right half.
    //
    // (3) And forward walked into the bunker's rear wall at 1.2 m.
    //
    // The standpoint is SOLVED, not nudged: it stands on the PSP pad, which is
    // the only large piece of open ground inside the wire, and every mass in
    // the base is measured off it. From fbW(2.0, -9.6) the tower bears 0.62 and
    // the brazier -0.03 - 37 degrees apart, the widest separation available
    // anywhere in the firebase - the bunker falls 52 degrees off axis and out
    // of frame, the perimeter is 7.7 m behind the lens, and nothing stands
    // between the camera and either subject.
    P.h3Cam = fbW(2.0, -9.6);
    P.camMarks.push(mark(P.h3Cam[0], P.h3Cam[1], P.tower.x, P.tower.z,
      1.10, 12.0, 0.40));

    // The three standpoints that photograph sandbags close enough for a rim to
    // be resolvable: inside the bunker, on the PSP, and on the tower platform.
    // [x, z, radius^2]
    // ONE ENTRY, and it is the bunker. lv_interior stands 1.5 m off a
    // revetment that fills 45% of the frame; nothing else in the level ever
    // sees a bag closer than seven metres, and at seven metres a 0.42 m bag is
    // 34 px tall - three latitude bands is already below the resolution limit.
    // Two more entries here cost 150k triangles for a rim nothing can resolve.
    // RE-WIDENED once the concertina and the broadleaf shadow passes had given
    // the budget back: the level now measures 3.0-3.2 M triangles against a
    // 4.5 M ceiling, and a revetment rim is the single most visible thing left
    // to spend it on. Everything inside the wire gets the seven-band pillow;
    // the mortar pit and the tower parapet come with it.
    _bagDetail = [
      [P.bunker.x, P.bunker.z, 16.0 * 16.0],
      [P.h3Cam[0], P.h3Cam[1], 17.0 * 17.0],
      [P.tower.x, P.tower.z, 12.0 * 12.0]
    ];

    // ---- the trees ----------------------------------------------------------
    // A jittered lattice with rejection, not a uniform random scatter: uniform
    // scatter is on the instant-fail list and, more usefully, a lattice with
    // jitter actually produces the clumping and the gaps a forest has.
    var trees = P.trees = [];
    var step = 9.4;
    for (var gz = Z_MIN + 3; gz < Z_MAX - 3; gz += step) {
      for (var gx = X_MIN + 3; gx < X_MAX - 3; gx += step) {
        var tx = gx + rng.range(-3.4, 3.4);
        var tz = gz + rng.range(-3.4, 3.4);
        if (tx < X_MIN + 2 || tx > X_MAX - 2 || tz < Z_MIN + 2 || tz > Z_MAX - 2) continue;
        var rc = riverC(tz), rh = riverHalf(tz);
        var a = Math.abs(tx - rc) / rh;
        if (a < 1.06) continue;                                   // in the water
        // 6.2 m, not 4.4. A cart track through forest has cleared verges, and
        // more to the point hero1 STANDS in the road: at 4.4 the nearest
        // buttressed giant could be three metres off the lens and the
        // signature framing was two trunks with a slot between them.
        if (Math.abs(tx - trackX(tz)) < 6.2) continue;            // on the road
        var dfx = tx - FB_X, dfz = tz - FB_Z;
        if (Math.sqrt(dfx * dfx + dfz * dfz) < FB_R + 4.5) continue;
        var cdd = Math.abs(tz - creekZ(tx));
        if (cdd < CREEK_HALF + 1.6 && tx > rc) continue;          // in the creek
        var keep = true;
        for (i = 0; i < P.clearings.length; i++) {
          var cl = P.clearings[i];
          var ddx = tx - cl.x, ddz = tz - cl.z;
          var dd = Math.sqrt(ddx * ddx + ddz * ddz);
          if (dd < cl.r && rng.next() < (1 - dd / cl.r) * cl.open) { keep = false; break; }
        }
        if (!keep) continue;
        var big = rng.next();
        var hgt = M.lerp(15.5, 27.5, Math.pow(big, 0.85));
        trees.push({
          x: tx, z: tz, y: rawY(tx, tz, P),
          h: hgt,
          r: M.lerp(0.58, 1.55, Math.pow(big, 0.85)),
          lean: rng.range(-0.045, 0.045),
          leanY: rng.range(0, Math.PI * 2),
          buttress: rng.int(4, 7),
          bh: M.lerp(0.9, 3.2, big) * rng.range(0.8, 1.2),
          variant: rng.int(0, 2),
          liana: rng.bool(0.34),
          seed: rng.int(0, 65535)
        });
      }
    }
    // three shell-shattered survivors inside the wire - a firebase was cut out
    // of the forest, it did not arrive in a field
    var stumps = [[-9.5, 10.0], [12.5, 6.0], [-13.0, -10.0]];
    for (i = 0; i < stumps.length; i++) {
      var sp = fbW(stumps[i][0], stumps[i][1]);
      trees.push({
        x: sp[0], z: sp[1], y: fbTop, h: rng.range(6.5, 10.5),
        r: rng.range(0.55, 0.85), lean: rng.range(-0.10, 0.10),
        leanY: rng.range(0, 6.28), buttress: rng.int(3, 5), bh: rng.range(1.2, 2.2),
        variant: 2, liana: false, shattered: true, seed: rng.int(0, 65535)
      });
    }

    // ---- fallen trunks ------------------------------------------------------
    // Three, and every one of them is doing compositional work: one across the
    // track as an obstacle and a foreground bar, one half in the river as a
    // sightline into the water, one on the firebase slope.
    P.logs = [];
    function log(ax, az, bxx, bzz, r, sink) {
      var ay = rawY(ax, az, P) + r * (1 - (sink || 0.35));
      var by = rawY(bxx, bzz, P) + r * (1 - (sink || 0.35));
      P.logs.push({ ax: ax, ay: ay, az: az, bx: bxx, by: by, bz: bzz, r: r,
        seed: rng.int(0, 65535) });
    }
    log(trackX(43) - 6.0, 44.5, trackX(41) + 4.4, 40.0, 0.62, 0.42);
    log(riverC(-2) + riverHalf(-2) - 3.0, -3.0, riverC(-2) + riverHalf(-2) + 8.5, 1.5, 0.52, 0.30);
    log(FB_X - 21.0, FB_Z + 9.0, FB_X - 13.5, FB_Z + 14.0, 0.46, 0.40);

    // ---- mangrove stands ----------------------------------------------------
    // Prop-rooted clumps standing in the shallows down both banks. They are why
    // the water's edge is a tangle rather than a drawn line, and their arches
    // are the only place in the level you can see through a solid object.
    P.mangroves = [];
    for (var mz = Z_MIN + 6; mz < Z_MAX - 6; mz += 5.4) {
      for (var side = 0; side < 2; side++) {
        if (rng.next() > 0.62) continue;
        var mrc = riverC(mz), mrh = riverHalf(mz);
        var edge = side ? mrc + mrh : mrc - mrh;
        var mx = edge + (side ? -1 : 1) * rng.range(-1.6, 2.6);
        var mzz = mz + rng.range(-1.8, 1.8);
        if (mx < X_MIN + 2 || mx > X_MAX - 2) continue;
        if (camClear(mx, mzz, P, true) > 0.42) continue;
        P.mangroves.push({
          x: mx, z: mzz, y: rawY(mx, mzz, P),
          r: rng.range(0.13, 0.24), h: rng.range(3.2, 6.4),
          roots: rng.int(5, 9), seed: rng.int(0, 65535)
        });
      }
    }

    // ---- rock outcrop -------------------------------------------------------
    // The overview standpoint, and the only hard mineral silhouette in a level
    // made of soft things.
    var ox = 30.0, oz = 12.0;
    P.outcrop = { x: ox, z: oz, y: rawY(ox, oz, P), r: 9.5, h: 6.2 };
    P.pads.push({ x: ox - 1.5, z: oz + 1.0, hx: 3.0, hz: 3.0, c: 1, s: 0, fade: 2.2,
      y: rawY(ox, oz, P) + 5.6 });

    return P;
  }

  // ============================================================== THE GROUND ==
  // One indexed heightfield for the floor and one channel-shaped ribbon for the
  // water. The floor's VERTEX COLOURS are where a green level gets its value
  // range: they are painted from the analytic sky-exposure field, so the track,
  // the clearings and the water's edge are two stops up on the closed canopy
  // and the boundary between them is ragged rather than circular.
  // 0.62, not 0.80. Every vertex-colour term the floor carries - the litter
  // drift, the moss, the laterite, the churned track - was authored on a
  // 0.80 m lattice, which cannot resolve a rut, a wallow or a boot-worn descent.
  // The whole ground was 23.5k vertices; at 0.62 it is 39k, i.e. +62k triangles
  // against a million of headroom, and the rut in the road becomes a thing the
  // colour field can actually draw.
  var GROUND_CELL = 0.62;

  // ================================================ THE FLOOR LIGHT BAKE ==
  // One 1024^2 map over the whole play area at 12 cm per texel, handed to the
  // mud material as `lightMap` on uv1. It carries THREE things that the level
  // could not previously express at all:
  //
  //   1. THE DAPPLE. skyOpen modulated by leafBreak() - real, sharp-edged,
  //      non-repeating pools of filtered daylight on the forest floor, for one
  //      texture and zero extra draw calls.
  //   2. MACRO COLOUR AT A SECOND SCALE. The floor was one green craquelure
  //      cell pattern at one scale from the lens to the fog. This adds warm
  //      ochre leaf drifts, red laterite where boots and wheels have cut the
  //      surface, and green algal wash at the water line, at 12 cm to 20 m -
  //      the entire band the tiling albedo and the 0.62 m vertex lattice both
  //      miss.
  //   3. WARM MASS. lightMap is ADDITIVE irradiance, so everything it puts on
  //      the floor is light that was not there. 97% of the coloured pixels in
  //      the signature frame sat in a 100-degree hue band; this is the largest
  //      single surface in the level and it is now the largest warm object too.
  //
  // Occluded under the bunker and the tower platform, because filtered daylight
  // does not reach through a sandbag roof.
  var LM_PX = 1024;
  // Peak irradiance the floor bake may add, in the same lux the shafts use.
  //
  // MEASURED AND CUT BY TWO THIRDS. At 42 this map was FICTITIOUS LIGHT that
  // only the mud received: in lv_overview a drum lid rendered at 0.158 and the
  // bare ground 40 cm from it at 0.574 - 1.9 stops between two horizontal
  // sky-facing surfaces under one overcast dome - so every drum, crate, plank
  // and sandbag in the level read as a black sticker pasted onto a bright
  // field. The energy that comes out here goes back in two places that ALL
  // buckets share: the dapple term in _paint (a prop standing in a pool is now
  // lit by that pool) and the shafts, which are real fixtures.
  var LIGHTMAP_LUX = 15.0;

  function buildFloorLight(L) {
    var P = L.plan;
    var SX = X_MAX - X_MIN, SZ = Z_MAX - Z_MIN;
    var i, j;
    // Coarse sky-exposure grid, ~1.35 m, bilinear on the way out. skyOpen costs
    // a clearing walk plus an fbm2 and this map is a million texels.
    var CW = 90, CH = 94;
    var open = new Float32Array(CW * CH);
    for (j = 0; j < CH; j++) {
      for (i = 0; i < CW; i++) {
        open[j * CW + i] = skyOpen(X_MIN + (i / (CW - 1)) * SX,
          Z_MIN + (j / (CH - 1)) * SZ, P);
      }
    }
    function openAt(fx, fz) {
      var u = fx * (CW - 1), v = fz * (CH - 1);
      var i0 = Math.min(CW - 2, Math.max(0, u | 0));
      var j0 = Math.min(CH - 2, Math.max(0, v | 0));
      var tu = u - i0, tv = v - j0;
      var a = open[j0 * CW + i0], b = open[j0 * CW + i0 + 1];
      var c = open[(j0 + 1) * CW + i0], d = open[(j0 + 1) * CW + i0 + 1];
      return M.lerp(M.lerp(a, b, tu), M.lerp(c, d, tu), tv);
    }

    var K = P.bunker;
    var bc = Math.cos(K.yaw), bs = Math.sin(K.yaw);
    var T = P.tower;

    var data = new Uint8Array(LM_PX * LM_PX * 4);
    var N = L.noise;
    for (j = 0; j < LM_PX; j++) {
      var fz = (j + 0.5) / LM_PX;
      var z = Z_MIN + fz * SZ;
      for (i = 0; i < LM_PX; i++) {
        var fx = (i + 0.5) / LM_PX;
        var x = X_MIN + fx * SX;
        var o = (j * LM_PX + i) * 4;

        var op = openAt(fx, fz);
        var br = leafBreak(x, z);
        // Even under closed canopy some light gets through; the pools are what
        // sits on top of it. The (1 - 0.55 * op) taper matters: where the sky is
        // genuinely OPEN - the channel, the firebase's cleared field of fire -
        // the real skylight is already lighting the floor and the bake has
        // nothing to add. Without it the firebase floor doubled and photographed
        // as a sand pit. What this map is FOR is the broken light under a roof.
        // A LINEAR RAMP IN br DEPOSITS A WASH, NOT POOLS. The whole premise of
        // the level is that light arrives broken, and a pool without an EDGE is
        // just a slightly brighter piece of floor. Putting a contrast curve on
        // the leaf-break field turns the same field into pools with rims for
        // the same texel.
        var dap = op * (0.20 + 0.80 * M.smoothstep(0.35, 0.75, br)) *
          (1.0 - 0.55 * op);

        // The colour of light that has been through forty metres of leaf is
        // yellow-green; the colour of light over the channel and the clearings
        // is cool skylight. Blend on how open the sky is.
        var warmL = 1 - M.saturate(op * 1.25);
        var lr = M.lerp(0.74, 0.82, warmL);
        var lg = M.lerp(0.96, 1.00, warmL);
        var lb = M.lerp(0.94, 0.50, warmL);
        var r = dap * lr, g = dap * lg, b = dap * lb;

        // ---- warm mass ------------------------------------------------------
        // Ochre leaf drift, AND ONLY UNDER A CLOSED ROOF. Gated at
        // (0.55 + 0.45*(1-op)) it survived at 55% strength across the OPEN
        // firebase field and the track, and being additive irradiance on the
        // largest surface in the level it is what drove the floor to RGB
        // 0.686/0.572/0.264 - R above G, R-B = +0.30 - on the one level in the
        // roster pinned to "saturated green", in direct contradiction of the
        // [0.085 0.120 0.062] ground albedo sky.js bounces its IBL off. Squared
        // on (1 - op) it dies where the sky is open, which is where a leaf
        // drift does not collect anyway: it washes away.
        var closed = (1 - op) * (1 - op);
        var lt = M.smoothstep(0.32, 0.68,
          n01(N.fbm2(x * 0.145 + 11.0, z * 0.145 - 6.0, 3))) * closed;
        lt *= 0.55 + 0.45 * tval(x * 0.9 + 61, z * 0.9 - 12, 4096, 0x11FA);
        r += lt * 0.150; g += lt * 0.098; b += lt * 0.030;

        // Laterite. Red subsoil, wherever a boot or a wheel has cut the skin
        // off: the track and its verges, the knoll the firebase was cut into,
        // and the bank crests. The vertex-colour term gated this on SLOPE
        // alone, which is precisely the set of places nobody walks.
        var au = Math.abs(x - trackX(z));
        var tprox = 1 - M.smoothstep(TRACK_HALF * 0.35, TRACK_SHOULDER + 1.8, au);
        var kdx = x - FB_X, kdz = z - FB_Z;
        var knoll = 1 - M.smoothstep(6.0, FB_R + 2.0, Math.sqrt(kdx * kdx + kdz * kdz));
        // knoll * 0.20, not 0.45: a firebase was CUT into the knoll, not
        // ploughed, so the red subsoil belongs where boots and wheels actually
        // run - the track, the gate, the paths - not across the whole plateau.
        var cut = Math.max(tprox, knoll * 0.20);
        var lat = cut * M.smoothstep(0.36, 0.74,
          n01(N.fbm2(x * 0.34 + 44.0, z * 0.34 - 21.0, 2)));
        r += lat * 0.150; g += lat * 0.072; b += lat * 0.030;

        // Algal wash at the water line: the one COOL green accent, and the
        // thing that says the river has a shore rather than an edge.
        var rc = riverC(z), rh = riverHalf(z);
        var aa = Math.abs(x - rc) / rh;
        var shore = 1 - M.smoothstep(0.0, 0.22, Math.abs(aa - 1.0));
        r += shore * 0.030; g += shore * 0.100; b += shore * 0.038;

        // ---- WHERE THE SHAFTS LAND ------------------------------------------
        // The pool, painted from the same table the SpotLights are built from.
        // See shaftSpecs(): the haze cone is faded to nothing over its last 22%
        // so it draws no rim, and the spot's `lux` against an overcast dome is a
        // third of a stop - so the level's four published shafts photographed as
        // columns hanging in the air over a floor that had not noticed them.
        // Additive irradiance in the same lux the shafts are quoted in, so a pool
        // is a real 9 lux of broken daylight rather than a brighter texture, and
        // it is warm-yellow-green because that is what light is after forty
        // metres of leaf. Painted BEFORE the occlusion block below, so the
        // bunker's roof still stops it.
        var pw = shaftPool(x, z, P);
        if (pw > 0) {
          r += pw * 0.60; g += pw * 0.66; b += pw * 0.26;
        }

        // ---- occlusion ------------------------------------------------------
        var ddx = x - K.x, ddz = z - K.z;
        var klx = ddx * bc - ddz * bs, klz = ddx * bs + ddz * bc;
        if (Math.abs(klx) < K.w * 0.5 + 0.9 && Math.abs(klz) < K.d * 0.5 + 0.9) {
          r *= 0.04; g *= 0.04; b *= 0.04;
        }
        var tdx = x - T.x, tdz = z - T.z;
        if (tdx * tdx + tdz * tdz < 7.5) { r *= 0.28; g *= 0.28; b *= 0.28; }

        data[o] = Math.round(M.saturate(Math.sqrt(M.saturate(r))) * 255);
        data[o + 1] = Math.round(M.saturate(Math.sqrt(M.saturate(g))) * 255);
        data[o + 2] = Math.round(M.saturate(Math.sqrt(M.saturate(b))) * 255);
        data[o + 3] = 255;
      }
    }
    var tex = new THREE.DataTexture(data, LM_PX, LM_PX, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    // MeshStandardMaterial.lightMap reads uv1, and Texture.channel defaults to
    // 0 - without this line the map would be sampled with the world-planar uv0
    // and tile sixty times across the delta.
    tex.channel = 1;
    tex.anisotropy = L._aniso();
    tex.needsUpdate = true;
    tex.name = 'jungle_floor_light';
    return tex;
  }

  // uv1 for the floor light bake: the play area normalised to 0..1. Used by the
  // ground heightfield and by every merged `mud` surface, so the two agree.
  function playUV1(geo) {
    var p = geo.attributes.position;
    var n = p.count;
    var a = new Float32Array(n * 2);
    var sx = 1 / (X_MAX - X_MIN), sz = 1 / (Z_MAX - Z_MIN);
    for (var i = 0; i < n; i++) {
      a[i * 2] = (p.getX(i) - X_MIN) * sx;
      a[i * 2 + 1] = (p.getZ(i) - Z_MIN) * sz;
    }
    geo.setAttribute('uv1', new THREE.BufferAttribute(a, 2));
    return geo;
  }

  function buildGround(L, rng) {
    var P = L.plan;
    var N = L.noise;
    var x0 = X_MIN, z0 = Z_MIN;
    var w = Math.ceil((X_MAX - X_MIN) / GROUND_CELL) + 1;
    var h = Math.ceil((Z_MAX - Z_MIN) / GROUND_CELL) + 1;

    var pos = new Float32Array(w * h * 3);
    var col = new Float32Array(w * h * 3);
    var uv = new Float32Array(w * h * 2);
    var field = new Float32Array(w * h);
    var i, j, k;

    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        k = j * w + i;
        var x = x0 + i * GROUND_CELL, z = z0 + j * GROUND_CELL;
        var y = groundY(x, z, P);
        field[k] = y;
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x * 0.5; uv[k * 2 + 1] = z * 0.5;
      }
    }
    L.field = { x0: x0, z0: z0, cell: GROUND_CELL, w: w, h: h, a: field };

    // ---- colour -------------------------------------------------------------
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        k = j * w + i;
        var px = x0 + i * GROUND_CELL, pz = z0 + j * GROUND_CELL;
        var py = field[k];
        var open = skyOpen(px, pz, P);

        // slope, from the baked field
        var hxp = field[j * w + Math.min(w - 1, i + 1)];
        var hxm = field[j * w + Math.max(0, i - 1)];
        var hzp = field[Math.min(h - 1, j + 1) * w + i];
        var hzm = field[Math.max(0, j - 1) * w + i];
        var slope = Math.min(1, Math.sqrt(
          Math.pow((hxp - hxm) / (2 * GROUND_CELL), 2) +
          Math.pow((hzp - hzm) / (2 * GROUND_CELL), 2)) * 0.75);

        // Base value. 0.34 -> 1.42 is a 4:1 ground range: enough that a shaft
        // pool reads as a pool, shallow enough that the closed canopy still has
        // material detail in it rather than crushing to a silhouette.
        // The floor floor. 0.34 measured a vertical imbalance of 2.77 on the
        // 40-degree portrait lens, which crops out the canopy's dark half and
        // leaves a bright leaf ceiling over a near-black road. 0.44 lifts the
        // deep shade by a third of a stop without touching the lit end, so the
        // 4:1 ground range the shafts need is intact and the tight crop lands
        // under 2.5.
        // 0.40, not 0.44, and a wider top. The anti-crush floor was costing the
        // level its near/far read: the floor light bake now lifts the shade
        // additively, so the ALBEDO can afford to go a little darker and the
        // ratio between a pool and the canopy shade widens.
        var lit = 0.45 + 1.10 * open;
        var r = lit, g = lit, b = lit;
        // Light here has come through leaves, so it is GREEN, and the shade is
        // greener still - a jungle's shadow is not blue. The warm/cool split
        // the brief asks for is carried by the LITTER and the SILT below, which
        // are the two things in a forest that are not chlorophyll.
        // The blue floor is 0.80, not 0.70: at 0.70 the open field ran a 2.3:1
        // r/b split on TOP of the albedo's own 2.55:1, and the two of them
        // multiplied is most of how a green level's floor became desert ochre.
        r *= 0.86 + 0.09 * open;
        g *= 1.04;
        b *= 0.80 + 0.09 * open;

        // LEAF LITTER: warm ochre drifts, and ONLY under a closed roof. At
        // (0.55 + 0.45 * (1 - open)) this survived at 55% strength on the open
        // firebase field and the track, where it stacked multiplicatively with
        // the laterite below and clamped the red channel at its 2.0 ceiling
        // while the blue sat at 0.88. Squared on (1 - open) it collects where
        // dead leaf actually collects and washes out where the rain gets at it.
        var closedG = (1 - open) * (1 - open);
        var lt = M.smoothstep(0.34, 0.66, n01(N.fbm2(px * 0.145 + 11.0, pz * 0.145 - 6.0, 3))) *
          (0.16 + 0.84 * closedG);
        r = M.lerp(r, r * 1.46, lt * 0.80);
        g = M.lerp(g, g * 1.20, lt * 0.80);
        b = M.lerp(b, b * 0.78, lt * 0.80);

        // moss, on flat shaded ground and never on a slope. Biased COOL rather
        // than merely green: the level's hue interquartile range measured 18-38
        // degrees in every sampled region and the only way to open it without
        // inventing a colour the delta does not have is to push the shade
        // toward blue-green and leave the litter as the single warm mass.
        var mo = M.smoothstep(0.54, 0.86, n01(N.fbm2(px * 0.22 - 4.0, pz * 0.22 + 8.0, 2))) *
          (1 - slope) * (1 - open * 0.55);
        r = M.lerp(r, r * 0.58, mo * 0.50);
        g = M.lerp(g, g * 1.20, mo * 0.50);
        b = M.lerp(b, b * 0.86, mo * 0.50);

        // LATERITE: the red subsoil. `saturate(slope * 1.35 - 0.10)` put it on
        // the bank scarps and nowhere else - i.e. on the only surfaces in the
        // level nobody ever walks over - so the flat track, the knoll top and
        // the bank crest, which are exactly where a boot or a wheel exposes it,
        // never saw a gram of red. It is now driven off track proximity and the
        // churn field as well as off slope, and it is the second-largest warm
        // mass in the frame after the litter.
        var trk = 1 - M.smoothstep(TRACK_HALF * 0.35, TRACK_SHOULDER + 1.8,
          Math.abs(px - trackX(pz)));
        var kdx0 = px - FB_X, kdz0 = pz - FB_Z;
        var knoll = 1 - M.smoothstep(6.0, FB_R + 2.0,
          Math.sqrt(kdx0 * kdx0 + kdz0 * kdz0));
        var churn = M.smoothstep(0.36, 0.74,
          n01(N.fbm2(px * 0.34 + 44.0, pz * 0.34 - 21.0, 2)));
        // knoll * 0.30, not 0.85. The plateau is not a quarry floor - the red
        // belongs on the track, the gate approach and the cut scarps.
        var lat = M.saturate(Math.max(slope * 1.35 - 0.10,
          Math.max(trk, knoll * 0.30) * churn));
        // The TRACK keeps its warm mass - it is the one surface in the level a
        // wheel has actually cut, it is where hero1 stands, and the level needs
        // somewhere warm that is not the canopy. It is the KNOLL that had to
        // stop being red, not the road.
        r = M.lerp(r, r * 1.42 + 0.09, lat * 0.64);
        g = M.lerp(g, g * 0.99, lat * 0.64);
        b = M.lerp(b, b * 0.64, lat * 0.64);

        // silt and algal scum at the water line, and the wet dark bed below it
        var rc = riverC(pz), rh = riverHalf(pz);
        var aa = Math.abs(px - rc) / rh;
        var shore = (1 - M.smoothstep(0.0, 0.30, Math.abs(aa - 1.0)));
        r = M.lerp(r, 1.10, shore * 0.55);
        g = M.lerp(g, 1.18, shore * 0.55);
        b = M.lerp(b, 1.00, shore * 0.55);
        if (aa < 1.0) {
          var sub = 1 - M.smoothstep(0.72, 1.0, aa);
          r *= 1 - sub * 0.52; g *= 1 - sub * 0.44; b *= 1 - sub * 0.40;
        }

        // the churned track: wetter, darker, more saturated than its verges
        var tr = 1 - M.smoothstep(TRACK_HALF * 0.7, TRACK_SHOULDER, Math.abs(px - trackX(pz)));
        r = M.lerp(r, r * 0.86, tr * 0.7);
        g = M.lerp(g, g * 0.88, tr * 0.7);
        b = M.lerp(b, b * 0.80, tr * 0.7);

        // ---- MACRO BREAK, at the one scale nothing else in the stack covers --
        // Everything above runs at 3-8 m (the litter and churn fields) or at
        // 9 cm (the triplanar dirt map). Between them, at 8-20 m, the floor had
        // NOTHING, which is why fifteen thousand square metres of it read as one
        // uniform speckle carpet from the lens to the fog. This band is
        // deliberately a HUE break as well as a value one: damp shaded hollows
        // run blue-green, drier rises run olive, and the two of them together
        // are what stop a green level being one green.
        var mac = n01(N.fbm2(px * 0.062 - 27.0, pz * 0.062 + 15.0, 3));
        var macK = (mac - 0.5) * 2;                     // -1 .. +1
        r *= 1 + macK * 0.20;
        g *= 1 + macK * 0.05;
        b *= 1 - macK * 0.24;
        var damp = M.saturate(-macK) *
          M.smoothstep(0.42, 0.85, n01(N.fbm2(px * 0.11 + 6.0, pz * 0.11 - 19.0, 2)));
        r = M.lerp(r, r * 0.80, damp * 0.45);
        g = M.lerp(g, g * 0.94, damp * 0.45);
        b = M.lerp(b, b * 1.05, damp * 0.45);

        // and never perfectly uniform
        var v = N.fbm2(px * 0.9 + 3.0, pz * 0.9 - 2.0, 2);
        var vv = 1 + (v - 0.0) * 0.10;
        col[k * 3] = M.clamp(r * vv, 0.05, 2.0);
        col[k * 3 + 1] = M.clamp(g * vv, 0.05, 2.0);
        col[k * 3 + 2] = M.clamp(b * vv, 0.05, 2.0);
        void py;
      }
    }

    var idx = [];
    for (j = 0; j + 1 < h; j++) {
      for (i = 0; i + 1 < w; i++) {
        var a0 = j * w + i, b0 = j * w + i + 1;
        var c0 = (j + 1) * w + i, d0 = (j + 1) * w + i + 1;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
      : new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.computeVertexNormals();
    playUV1(geo);
    var mesh = new THREE.Mesh(geo, L.material('mud'));
    mesh.name = 'jungle_ground';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    L.root.add(mesh);
    L.meshes.push(mesh);
    void rng;
  }

  function buildWater(L) {
    var nz = 74, nt = 22;
    var pos = new Float32Array((nz + 1) * (nt + 1) * 3);
    var uv = new Float32Array((nz + 1) * (nt + 1) * 2);
    var i, j, k;
    for (j = 0; j <= nz; j++) {
      var z = Z_MIN - 4 + (Z_MAX - Z_MIN + 8) * (j / nz);
      var rc = riverC(z), rh = riverHalf(z);
      for (i = 0; i <= nt; i++) {
        k = j * (nt + 1) + i;
        var t = (i / nt) * 2 - 1;
        var x = rc + t * rh * 1.015;
        pos[k * 3] = x; pos[k * 3 + 1] = WATER_Y; pos[k * 3 + 2] = z;
        uv[k * 2] = x * 0.25; uv[k * 2 + 1] = z * 0.25;
      }
    }
    var idx = [];
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nt; i++) {
        var a = j * (nt + 1) + i, b = a + 1;
        var c = (j + 1) * (nt + 1) + i, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, L.material('water'));
    mesh.name = 'jungle_river';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = 1;
    L.root.add(mesh);
    L.meshes.push(mesh);

    // ---- DRIZZLE RINGS ------------------------------------------------------
    // A drizzle on still water is nothing BUT concentric rings, and the river -
    // the brightest floor in the level and half of hero2 - had not one. The sea
    // shader in materials.js models waves, absorption, Fresnel and foam and has
    // no rain-impact term, and its ripple field is a PUDDLE normal driven by
    // rain intensity, not a set of impacts on open water.
    //
    // So the rings are a level-owned LAYER: the same channel ribbon at a
    // quarter of the resolution, 1.5 cm above the surface, near-black and
    // nearly a mirror, with the ring mask in its ALPHA. Where a ring is, the
    // layer shows the sky; where it is not, the water beneath shows through
    // unchanged. One draw call, ~800 triangles, no shared system touched, and
    // it degrades to invisible rather than to wrong if the injection ever fails.
    var rz = 40, rt = 10;
    var rpos = new Float32Array((rz + 1) * (rt + 1) * 3);
    var ruv = new Float32Array((rz + 1) * (rt + 1) * 2);
    for (j = 0; j <= rz; j++) {
      var zz2 = Z_MIN - 4 + (Z_MAX - Z_MIN + 8) * (j / rz);
      var rc2 = riverC(zz2), rh2 = riverHalf(zz2);
      for (i = 0; i <= rt; i++) {
        k = j * (rt + 1) + i;
        var t2 = (i / rt) * 2 - 1;
        var x2 = rc2 + t2 * rh2 * 0.995;
        rpos[k * 3] = x2; rpos[k * 3 + 1] = WATER_Y + 0.015; rpos[k * 3 + 2] = zz2;
        ruv[k * 2] = x2 * 0.25; ruv[k * 2 + 1] = zz2 * 0.25;
      }
    }
    var ridx = [];
    for (j = 0; j < rz; j++) {
      for (i = 0; i < rt; i++) {
        var ra = j * (rt + 1) + i, rb = ra + 1;
        var rcI = (j + 1) * (rt + 1) + i, rd = rcI + 1;
        ridx.push(ra, rcI, rb, rb, rcI, rd);
      }
    }
    var rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3));
    rgeo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
    rgeo.setIndex(new THREE.BufferAttribute(new Uint16Array(ridx), 1));
    rgeo.computeVertexNormals();
    var rmesh = new THREE.Mesh(rgeo, L._rippleMaterial());
    rmesh.name = 'jungle_rain_rings';
    rmesh.castShadow = false;
    rmesh.receiveShadow = false;
    rmesh.matrixAutoUpdate = false;
    rmesh.updateMatrix();
    rmesh.renderOrder = 2;
    L.root.add(rmesh);
    L.meshes.push(rmesh);
  }

  // ================================================================ THE TREES ==
  function pushQuad(pos, nor, uvv, a, b, c, d, ua, ub, uc, ud) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (var q = 0; q < 6; q++) nor.push(nx, ny, nz);
    uvv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    uvv.push(ua[0], ua[1], uc[0], uc[1], ud[0], ud[1]);
  }

  // A buttress root: the flying fin a rainforest giant stands on. Concave
  // hypotenuse, thinning outward, and it is what turns a cylinder into a tree.
  function buttressFin(r0, reach, hgt, thick, uvS) {
    var n = 7, i;
    var pos = [], nor = [], uvv = [];
    var pts = [];
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var x = r0 * 0.55 + (reach - r0 * 0.55) * t;
      var y = hgt * Math.pow(1 - t, 1.75);
      var th = thick * (1 - t * 0.62) * 0.5;
      pts.push([x, y, th]);
    }
    for (i = 0; i < n; i++) {
      var A = pts[i], Bp = pts[i + 1];
      var u0 = A[0] * uvS, u1 = Bp[0] * uvS;
      pushQuad(pos, nor, uvv,
        [A[0], A[1], A[2]], [A[0], 0, A[2]], [Bp[0], 0, Bp[2]], [Bp[0], Bp[1], Bp[2]],
        [u0, A[1] * uvS], [u0, 0], [u1, 0], [u1, Bp[1] * uvS]);
      pushQuad(pos, nor, uvv,
        [A[0], A[1], -A[2]], [Bp[0], Bp[1], -Bp[2]], [Bp[0], 0, -Bp[2]], [A[0], 0, -A[2]],
        [u0, A[1] * uvS], [u1, Bp[1] * uvS], [u1, 0], [u0, 0]);
      pushQuad(pos, nor, uvv,
        [A[0], A[1], A[2]], [Bp[0], Bp[1], Bp[2]], [Bp[0], Bp[1], -Bp[2]], [A[0], A[1], -A[2]],
        [u0, 0], [u1, 0], [u1, A[2] * 2 * uvS], [u0, A[2] * 2 * uvS]);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvv), 2));
    return g;
  }

  // 0.53 metres per tile put every feature buildBarkMaps draws - 3.5 cm fissures,
  // 1.1 cm strands - under one screen pixel past about eight metres, so the
  // twelve-metre hero trunk photographed as a Lambert cylinder with film grain
  // on it. 0.55 tiles/m is a 1.82 m tile: the same map's fissures land at 12 cm,
  // its plates at 45 cm and its strands at 4 cm, which are the sizes bark
  // actually is and which survive to thirty metres. The fine layer is still in
  // there at 1.5 cm as the detail term.
  var BARK_UV = 0.55;

  //   flute  vertical ribbing depth as a fraction of the radius. A tube with a
  //          perfectly circular section reads as pipework; a rainforest trunk is
  //          fluted between its buttresses all the way up.
  function barkTube(stations, seg, flute, seed, uvScale) {
    var g;
    if (flute) {
      var lobes = 3 + ((seed || 0) % 4);
      var ph = ((seed || 0) % 17) * 0.37;
      g = tube(stations, seg, false, function (i, j, sg) {
        var th = (j / sg) * Math.PI * 2;
        return 1 + flute * (Math.sin(th * lobes + ph + i * 0.31) * 0.62 +
          Math.sin(th * (lobes * 2 + 1) - ph * 1.7 + i * 0.17) * 0.38);
      });
    } else {
      g = tube(stations, seg, false);
    }
    var uv = g.attributes.uv;
    var rAvg = 0;
    for (var i = 0; i < stations.length; i++) rAvg += stations[i][3];
    rAvg = (rAvg / stations.length) || 0.2;
    var circ = Math.PI * 2 * rAvg;
    var us = uvScale || BARK_UV;
    for (i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * circ * us, uv.getY(i) * us);
    }
    // SMOOTH, NOT FACETED. tube() emits non-indexed triangles, so
    // computeVertexNormals() writes the FACE normal to all three vertices and
    // an 11-sided fluted trunk shades as an 11-sided prism - which on an 11 m
    // fallen log 5 m from the lens is precisely the "constant-radius smooth
    // tube" read the flute was added to break. Averaging at coincident
    // positions turns the flutes into curved ribs, which is what they are.
    if (flute) {
      g.computeVertexNormals();
      var pA = g.attributes.position.array, nA = g.attributes.normal.array;
      smoothNormals(pA, nA);
      g.attributes.normal.needsUpdate = true;
    }
    return g;
  }

  function buildTree(L, B, rng, T) {
    var i;
    var st = [];
    var segs = 8;
    var lx = Math.sin(T.leanY) * T.lean, lz = Math.cos(T.leanY) * T.lean;
    var sway = L.noise;
    for (i = 0; i <= segs; i++) {
      var t = i / segs;
      var r = T.r * M.lerp(1.75, 0.26, Math.pow(t, 0.50));
      // a sinuous axis, not a plumb line
      var wob = sway.fbm2(T.seed * 0.013 + t * 2.2, T.seed * 0.007, 2) * 0.9;
      st.push([
        lx * T.h * t * t + wob * 0.30 * t,
        T.h * t,
        lz * T.h * t * t + wob * 0.24 * t,
        r
      ]);
    }
    if (T.shattered) {
      // a splintered crown: the top station collapses to a ragged point
      st[segs][3] = T.r * 0.42;
      st[segs][1] = T.h;
    }
    // Warm the trunk deliberately. A dead-standing hardwood measured MEDIAN HUE
    // 90 degrees in the signature frame - the wood was greener than the leaves.
    // The tint here is the level's warm mass: it runs brown, the bark map's own
    // base is now a warm grey-brown, and the moss is capped by height in _paint.
    B.tint = new THREE.Color(rng.range(1.02, 1.24), rng.range(0.86, 1.00),
      rng.range(0.62, 0.80));
    B.add('bark', barkTube(st, T.r > 0.8 ? 12 : 9, T.r > 0.5 ? 0.085 : 0.05, T.seed),
      makeM(T.x, T.y, T.z));

    // buttresses
    for (i = 0; i < T.buttress; i++) {
      var ang = i * (Math.PI * 2 / T.buttress) + rng.range(-0.28, 0.28);
      var reach = T.r * rng.range(2.0, 3.6);
      var hg = T.bh * rng.range(0.75, 1.25);
      var fin = buttressFin(T.r * 1.55, reach, hg, T.r * rng.range(0.30, 0.52), BARK_UV);
      B.add('bark', fin, makeM(T.x, T.y, T.z, 0, ang, 0));
    }

    // branches, and the canopy that hangs off them
    var nb = T.shattered ? rng.int(1, 3) : rng.int(3, 6);
    var canopyLow = 1e9;
    for (i = 0; i < nb; i++) {
      var by = T.h * rng.range(T.shattered ? 0.70 : 0.60, 0.96);
      var bang = rng.range(0, Math.PI * 2);
      var blen = T.h * rng.range(0.12, 0.30);
      var brs = [];
      for (var s = 0; s <= 3; s++) {
        var bt = s / 3;
        brs.push([
          Math.sin(bang) * blen * bt,
          by + blen * bt * rng.range(0.20, 0.55) - blen * bt * bt * 0.10,
          Math.cos(bang) * blen * bt,
          T.r * (0.30 - bt * 0.20)
        ]);
      }
      B.add('bark', barkTube(brs, 5), makeM(T.x, T.y, T.z, 0, 0, 0));
      if (!T.shattered) {
        var tipx = T.x + Math.sin(bang) * blen;
        var tipz = T.z + Math.cos(bang) * blen;
        var tipy = T.y + by + blen * 0.42;
        var cr = T.r * rng.range(3.6, 6.0) + 1.4;
        L.addInst('canopy' + rng.int(0, 2),
          makeM(tipx, tipy, tipz, rng.range(-0.2, 0.2), rng.range(0, 6.28), 0),
          cr / 3.0, T.y + by);
        if (tipy < canopyLow) canopyLow = tipy;
        L.dripEdges.push({ position: new THREE.Vector3(tipx, tipy - cr * 0.5, tipz),
          fall: Math.min(3.0, (tipy - T.y) * 0.35) });
      }
    }
    // a top cluster so the crown closes
    if (!T.shattered) {
      L.addInst('canopy' + rng.int(0, 2),
        makeM(T.x + lx * T.h, T.y + T.h * 1.01, T.z + lz * T.h,
          0, rng.range(0, 6.28), 0), (T.r * 5.0 + 2.0) / 3.0, T.y + T.h);
    }
    B.tint = null;

    // hanging lianas: the level's only vertical line above eye height, and the
    // thing that tells you how high the canopy is
    if (T.liana) {
      var nl = rng.int(2, 4);
      for (i = 0; i < nl; i++) {
        var la = rng.range(0, Math.PI * 2);
        var lr = T.r * rng.range(2.5, 5.5);
        var lyTop = T.y + T.h * rng.range(0.62, 0.86);
        var lyBot = T.y + rng.range(0.6, 4.0);
        var lxx = T.x + Math.sin(la) * lr, lzz = T.z + Math.cos(la) * lr;
        var cardH = lyTop - lyBot;
        if (cardH < 2.0) continue;
        var uvv = atlasUV(CELL.liana);
        var cg = quad(cardH * 0.30, cardH, uvv[0], uvv[1], uvv[2], uvv[3]);
        B.add('canopy', cg, makeM(lxx, (lyTop + lyBot) * 0.5, lzz, 0, rng.range(0, 6.28), 0));
        B.add('canopy', cg, makeM(lxx, (lyTop + lyBot) * 0.5, lzz, 0,
          rng.range(0, 6.28) + 1.57, 0));
        L.dripEdges.push({ position: new THREE.Vector3(lxx, lyBot + 0.1, lzz), fall: 1.6 });
      }
    }
    void canopyLow;

    // CREEPERS ON THE TRUNKS THE FRAMINGS ACTUALLY LOOK AT. A rainforest trunk
    // is never bare, and a bare vertical cylinder is what the hero1 trunk
    // photographed as under a 4x contrast boost. Two or three cards each, only
    // within twenty metres of a published standpoint, so the cost is a few
    // dozen quads rather than a few hundred.
    var nearPose = false;
    for (i = 0; i < L.plan.camMarks.length; i++) {
      var CMc = L.plan.camMarks[i];
      var cmx = T.x - CMc.x, cmz = T.z - CMc.z;
      if (cmx * cmx + cmz * cmz < 400) { nearPose = true; break; }
    }
    if (nearPose) {
      var ncr = rng.int(2, 3);
      for (i = 0; i < ncr; i++) {
        var ca = rng.range(0, Math.PI * 2);
        var ch = rng.range(1.6, 3.4);
        var cy = T.y + rng.range(0.7, Math.min(5.5, T.h * 0.35));
        var cuv = atlasUV(CELL.creeper);
        B.add('canopy', quad(ch * 0.55, ch, cuv[0], cuv[1], cuv[2], cuv[3]),
          makeM(T.x + Math.sin(ca) * (T.r * 1.06), cy,
            T.z + Math.cos(ca) * (T.r * 1.06), 0, ca, rng.range(-0.18, 0.18)));
      }
    }

    L.addCollider(T.x + lx * 0.6, T.y + T.h * 0.5, T.z + lz * 0.6,
      T.r * 1.20, T.h * 0.5, T.r * 1.20, 'wood');
  }

  // Mangrove: a low crown on a cage of arching prop roots. The one place in the
  // level you can see THROUGH a solid object, which is what a tangle means.
  function buildMangrove(L, B, rng, Mg) {
    var i;
    B.tint = grey(rng.range(0.78, 1.00));
    var st = [];
    for (i = 0; i <= 4; i++) {
      var t = i / 4;
      st.push([0, Mg.h * t, 0, Mg.r * (1.15 - t * 0.55)]);
    }
    var trunk = barkTube(st, 7);
    B.add('bark', trunk, makeM(Mg.x, Mg.y + 0.9, Mg.z, 0, 0, 0));
    for (i = 0; i < Mg.roots; i++) {
      var ang = i * (Math.PI * 2 / Mg.roots) + rng.range(-0.3, 0.3);
      var reach = rng.range(0.9, 2.3);
      var top = 0.9 + rng.range(0.2, 1.1);
      var rs = [];
      for (var s = 0; s <= 4; s++) {
        var t2 = s / 4;
        rs.push([
          Math.sin(ang) * reach * Math.sin(t2 * Math.PI * 0.5),
          top * (1 - t2 * t2) - 0.35 * t2,
          Math.cos(ang) * reach * Math.sin(t2 * Math.PI * 0.5),
          Mg.r * (0.42 - t2 * 0.20)
        ]);
      }
      B.add('bark', barkTube(rs, 5), makeM(Mg.x, Mg.y, Mg.z, 0, 0, 0));
    }
    B.tint = null;
    L.addInst('canopy' + rng.int(0, 2),
      makeM(Mg.x, Mg.y + Mg.h + 0.6, Mg.z, 0, rng.range(0, 6.28), 0),
      rng.range(0.55, 0.95), Mg.y + Mg.h);
    L.dripEdges.push({ position: new THREE.Vector3(Mg.x + 1.0, Mg.y + Mg.h + 0.2, Mg.z),
      fall: Math.max(0.6, Mg.h * 0.6) });
  }

  function buildLog(L, B, rng, lg) {
    var i;
    var dx = lg.bx - lg.ax, dy = lg.by - lg.ay, dz = lg.bz - lg.az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.5) return;
    // A CONSTANT-RADIUS TUBE IS A PIPE, AND THIS ONE IS THE LEADING LINE OF TWO
    // PUBLISHED FRAMINGS. A fallen hardwood swells at the root plate, taper
    // toward the crown, has a bulge at every branch collar and ends in a
    // splintered break - none of which the old +/-10% sine gave it. The radius
    // now runs +/-18% off a per-log noise band, the flute is doubled so the
    // bark plates break the outline at every station, and the far end collapses
    // to a ragged 30% ring so the log READS as broken rather than as sawn.
    var st = [];
    var segs = 11;
    var sd = (lg.seed % 97) * 0.137;
    for (i = 0; i <= segs; i++) {
      var t = i / segs;
      var swell = 1 + 0.18 * (Math.sin(t * 5.1 + sd) * 0.62 +
        Math.sin(t * 11.3 - sd * 1.7) * 0.38);
      var rr = lg.r * (1.14 - t * 0.30) * swell;
      if (i === segs) rr *= 0.30;                    // the splintered break
      else if (i === segs - 1) rr *= 0.86;
      st.push([lg.ax + dx * t, lg.ay + dy * t + Math.sin(t * 3.0) * 0.06,
        lg.az + dz * t, rr]);
    }
    // A dead hardwood on the forest floor is the one large BROWN mass the level
    // has in its signature framing, so it is tinted warm - but DARK warm. At
    // (1.16, 0.95, 0.66) it came out pale tan, i.e. the exact value and hue of
    // sawn timber, which is why it read as a plank and not as a wet fallen
    // trunk. A log that has lain in a monsoon delta is a dark umber, and its
    // interest is in the moss on top of it and the fungus on its flank.
    // BARK_UV 0.55 is a 1.82 m tile, which puts buildBarkMaps' plates at 45 cm
    // and its strands at 4 cm - the right sizes on a 25 m standing trunk seen
    // from ten metres, and far too fine on a log lying FIVE metres from the
    // lens, where 70 strands wrapped round the visible half average down to a
    // smooth lengthwise gradient. A plank grain, in other words. 0.26 is a
    // 3.8 m tile: 95 cm plates, 35 cm fissures, 11 cm fibre - bark you can see.
    B.tint = new THREE.Color(0.86, 0.74, 0.54);
    B.add('bark', barkTube(st, 11, 0.16, lg.seed, 0.26));
    B.tint = null;
    // the splinters at the broken end: a fan of shards out of the last ring
    var ex = lg.ax + dx, ey = lg.ay + dy, ez = lg.az + dz;
    var ux = dx / len, uy = dy / len, uz = dz / len;
    B.tint = new THREE.Color(1.24, 1.02, 0.72);
    for (i = 0; i < 7; i++) {
      var sa = (i / 7) * Math.PI * 2 + rng.range(-0.3, 0.3);
      var sr = lg.r * rng.range(0.30, 0.86);
      var sl = rng.range(0.24, 0.72);
      B.rod('bark',
        ex - ux * 0.25 + Math.cos(sa) * sr * 0.6, ey + Math.sin(sa) * sr,
        ez - uz * 0.25 + Math.cos(sa) * sr * 0.6,
        ex + ux * sl + Math.cos(sa) * sr * 0.9, ey + Math.sin(sa) * sr * 1.1,
        ez + uz * sl + Math.cos(sa) * sr * 0.9,
        lg.r * rng.range(0.05, 0.11), 4);
    }
    B.tint = null;
    // BRANCH STUBS, tapered and collared. A rod of constant radius sticking out
    // of a trunk is a dowel; a stub is a cone with a swelling where it left the
    // wood, and four of them are most of what breaks a straight silhouette.
    for (i = 0; i < 4; i++) {
      var t3 = rng.range(0.12, 0.88);
      var px = lg.ax + dx * t3, py = lg.ay + dy * t3, pz = lg.az + dz * t3;
      var a2 = rng.range(0, 6.28), l2 = rng.range(0.45, 1.35);
      var sbr = lg.r * rng.range(0.20, 0.34);
      var stb = [
        [px, py, pz, sbr * 1.5],
        [px + Math.sin(a2) * l2 * 0.35, py + rng.range(0.10, 0.34),
          pz + Math.cos(a2) * l2 * 0.35, sbr],
        [px + Math.sin(a2) * l2, py + rng.range(0.28, 0.95),
          pz + Math.cos(a2) * l2, sbr * 0.22]
      ];
      B.tint = new THREE.Color(1.12, 0.94, 0.68);
      B.add('bark', barkTube(stb, 5, 0.10, lg.seed + i * 7, 0.60));
      B.tint = null;
    }
    // BRACKET FUNGUS. Three or four shelves on the shaded flank - the one
    // detail that says "this has been lying here for years" and the level's
    // only pale warm mass at knee height.
    for (i = 0; i < 4; i++) {
      var ft = rng.range(0.10, 0.92);
      var fa = rng.range(0.9, 2.4) * (rng.bool() ? 1 : -1);
      var fx2 = lg.ax + dx * ft + Math.sin(fa) * lg.r * 0.92;
      var fz2 = lg.az + dz * ft + Math.cos(fa) * lg.r * 0.92;
      var fy2 = lg.ay + dy * ft + rng.range(-0.05, 0.16);
      B.tint = new THREE.Color(rng.range(1.18, 1.45), rng.range(1.02, 1.20),
        rng.range(0.72, 0.94));
      B.cyl('timber', lg.r * rng.range(0.34, 0.62), lg.r * rng.range(0.12, 0.24),
        0.035, fx2, fy2, fz2, rng.range(0.18, 0.42), fa, rng.range(-0.2, 0.2), 9);
      B.tint = null;
    }
    // moss and fern colonising the top
    var nb = Math.max(2, Math.round(len / 1.4));
    for (i = 0; i < nb; i++) {
      var t4 = (i + 0.5) / nb;
      L.addInst('fern' + rng.int(0, 1),
        makeM(lg.ax + dx * t4 + rng.range(-0.3, 0.3), lg.ay + dy * t4 + lg.r * 0.72,
          lg.az + dz * t4 + rng.range(-0.3, 0.3), 0, rng.range(0, 6.28), 0),
        rng.range(0.35, 0.62), lg.ay);
    }
    // ORIENTED, not axis-aligned. The first log is an 11.3 m trunk lying
    // diagonally across the hero1 approach; as an AABB its collider was
    // 11.6 x 5.7 m - an invisible waist-high wall claiming about 60 m2 of ground
    // the trunk is nowhere near, and the first thing the player walks into in
    // the level's signature space. addCollider already supports a quaternion
    // (sandbagRun uses it), so the box follows the trunk.
    // FOUR SHORT BOXES, NOT ONE LONG ONE. The collider is oriented, but every
    // consumer that needs a world AABB - _buildNav, the spatial hash, and
    // scenarios.js's walkable() through navGrid - takes the ENCLOSING BOX of
    // the rotated one, and the enclosing box of an 11.6 m trunk lying at 45
    // degrees is 11.6 x 5.7 m. That is 66 m2 of the hero1 approach marked
    // unwalkable for a trunk that occupies 14, which is what makes the
    // firefight scenario's standoff search walk its squad out of the frame.
    // Four segments cut the union to about 24 m2 for three extra boxes.
    var segsC = 4;
    for (var sc2 = 0; sc2 < segsC; sc2++) {
      var ta = sc2 / segsC, tb = (sc2 + 1) / segsC;
      var sax = lg.ax + dx * ta, saz = lg.az + dz * ta;
      var sbx = lg.ax + dx * tb, sbz = lg.az + dz * tb;
      var say = lg.ay + dy * ta, sby = lg.ay + dy * tb;
      var shl = Math.sqrt((sbx - sax) * (sbx - sax) + (sbz - saz) * (sbz - saz)) * 0.5;
      L.addCollider((sax + sbx) * 0.5, (say + sby) * 0.5 - lg.r * 0.15,
        (saz + sbz) * 0.5, shl + lg.r * 0.6, lg.r * 0.9, lg.r * 1.05, 'wood',
        false, _e1.set(0, Math.atan2(-dz, dx), 0, 'YXZ'));
    }
  }

  // =========================================================== THE FIREBASE ==
  // Individual bags, not a wall with a bag texture. A revetment is the one
  // structure in the level whose whole read is its silhouette - the lumpy top
  // course, the bags that have burst and slumped, the ones that have gone green
  // - and none of that survives being painted onto a box.
  function sandbagRun(B, rng, ax, ay, az, bx, by, bz, courses, bagH, seg) {
    var dx = bx - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.2) return;
    var ux = dx / len, uz = dz / len;
    var yaw = Math.atan2(ux, uz);
    var pitch = 0.52;
    var n = Math.max(1, Math.round(len / pitch));
    pitch = len / n;
    var shapes = bagShapes(rng, bagLOD((ax + bx) * 0.5, (az + bz) * 0.5));
    // THE COURSE LINE WANDERS. A revetment is laid by hand on uneven ground and
    // the giveaway of the old wall was that every course ran dead level for its
    // whole length, which is what turned a running bond into a checkerboard.
    // One low-frequency wave per run, weighted toward the upper courses so the
    // footing stays put and the top is ragged.
    var wPh = rng.range(0, 6.3), wK = rng.range(0.45, 1.15);
    var wA = bagH * rng.range(0.28, 0.62);
    for (var c = 0; c < courses; c++) {
      var yy = c * bagH * 0.78;
      // ---- EVERY COURSE USED TO RIDE THE SAME WAVE ---------------------------
      // wPh / wK / wA were solved once per RUN, so all eleven courses of the
      // bunker wall were the same curve scaled by cf: the rows stayed exactly
      // parallel, the columns stayed exactly aligned, and the interior framing -
      // where the revetment is 45% of the picture at 1.5 m - photographed as a
      // wavy GRID of identical lozenges. Seven bag silhouettes and a per-bag tint
      // cannot fix that, because what the eye is reading is the lattice, not the
      // unit: this object has been through four rounds of varying the bag and the
      // grid was never touched.
      //
      // Per-course phase, frequency, amplitude and datum, plus per-bag jitter
      // along the run and in height, is what turns parallel rows into masonry.
      // Every magnitude here is bounded by the OVERLAP, which is the thing that
      // must not break: a bag is 1.42 x the course pitch along the run and 1.24 x
      // the course rise, so worst-case adjacent jitters of 0.11 of a pitch and
      // 4.5 cm still leave 10 cm of along-run and 5 cm of vertical overlap. A
      // revetment with a hole in it lets the daylight through, and this object
      // has already had that failure once.
      var cJit = rng.range(-0.045, 0.045);
      var cWA = wA * rng.range(0.55, 1.35);
      var cWPh = wPh + rng.range(-1.2, 1.2);
      var cWK = wK * rng.range(0.74, 1.32);
      // The running bond is not a machined half-lap either: a hand-laid course
      // steps over by "about half a bag".
      var off = (c & 1) ? pitch * rng.range(0.34, 0.66) : pitch * rng.range(-0.09, 0.09);
      var cn = (c & 1) ? n - 1 : n;
      // the top course is ragged: bags missing, bags knocked off
      var frac = c === courses - 1 ? 0.70 : 1.0;
      var cf = courses > 1 ? c / (courses - 1) : 0;
      for (var i = 0; i < cn; i++) {
        if (rng.next() > frac) continue;
        var t = (i + 0.5) * pitch + off + rng.range(-0.11, 0.11) * pitch;
        var px = ax + ux * t, pz = az + uz * t;
        var rise = cWA * Math.sin(t * cWK + cWPh) * cf + cJit +
          rng.range(-0.026, 0.026);
        var py = ay + (by - ay) * (t / len) + yy + bagH * 0.5 + rise;
        var jx = rng.range(-0.055, 0.055);
        var sag = rng.range(0.90, 1.10);
        // WET HESSIAN IS NOT ORANGE. At a blue floor of 0.58 the revetment
        // measured R 0.254 / B 0.038 - R-B = +0.22 - and it is 45% of the
        // interior framing and 20% of hero3, so it was most of what pushed
        // those frames into a single sepia hue. A sandbag that has been in a
        // monsoon for two years is a grey-olive drab with a warm cast, not a
        // terracotta tile.
        B.tint = new THREE.Color(
          rng.range(0.80, 1.06), rng.range(0.84, 1.02), rng.range(0.74, 0.98));
        // bags rot green from the bottom up
        if (c === 0 || rng.bool(0.20)) {
          B.tint.multiply(new THREE.Color(0.72, 0.98, 0.74));
        }
        // One bag in five differs in KIND, not in degree: slumped or burst.
        // A silhouette that only varies by a few per cent still reads as a
        // repeated unit, which is the whole failure this object had.
        var vk = rng.next();
        var shp = vk < 0.09 ? 6 : (vk < 0.21 ? 5 : rng.int(0, 4));
        // AXES. yaw = atan2(ux, uz) turns LOCAL +Z along the run and LOCAL +X
        // across it. The previous two attempts at this object both sized the
        // box as (w = along-run, d = thickness) and got it exactly backwards:
        // the bag was 0.68 m thick and 0.49 m long on a 0.52 m pitch, and after
        // Geo.bevelBox's 8 cm inset only 0.33 m of that 0.52 was solid. That
        // arithmetic - not the yaw jitter, not the tint - is the hole the
        // daylight came through.
        //   z  1.42 x the course pitch  -> 0.18 m of overlap after a 0.35 rad yaw
        //   y  1.34 x the bag height    -> 1.7 x the 0.265 m course pitch
        //   x  0.50 m                   -> one bag laid header-wise
        var sAlong = pitch * 1.42;
        var sUp = bagH * 1.24 * sag * (shp === 5 ? 1.06 : 1.0);
        var sThick = 0.44 * (shp === 6 ? 1.18 : 1.0);
        B.add('sandbag', shapes[shp],
          makeMS(px + jx * uz, py, pz - jx * ux,
            rng.range(-0.10, 0.10), yaw + rng.range(-0.30, 0.30),
            rng.range(-0.13, 0.13), sThick, sUp, sAlong));
        void seg;
      }
    }
    B.tint = null;
  }

  function buildFirebase(L, B, rng) {
    var P = L.plan, F = P.firebase, i;
    var out = { perimeter: [] };
    var NSEG = 26;

    // ---- the revetment ring -------------------------------------------------
    for (i = 0; i < NSEG; i++) {
      var b0 = (i / NSEG) * Math.PI * 2 - Math.PI;
      var b1 = ((i + 1) / NSEG) * Math.PI * 2 - Math.PI;
      var bm = (b0 + b1) * 0.5;
      var dg = Math.abs(M.wrapAngle(bm - F.gateB));
      var db = Math.abs(M.wrapAngle(bm - F.breachB));
      if (dg < 0.19) continue;                       // the gate
      var courses = 4;
      if (db < 0.30) courses = rng.int(0, 2);        // the breach: blown flat
      else if (db < 0.52) courses = rng.int(2, 3);
      if (courses <= 0) continue;
      var r0 = F.r + rng.range(-0.35, 0.35);
      var ax = F.x + Math.sin(b0) * r0, az = F.z + Math.cos(b0) * r0;
      var bx = F.x + Math.sin(b1) * r0, bz = F.z + Math.cos(b1) * r0;
      var ay = L.sampleGround(ax, az), by = L.sampleGround(bx, bz);
      sandbagRun(B, rng, ax, ay, az, bx, by, bz, courses, 0.34, 1);
      out.perimeter.push({ x: (ax + bx) * 0.5, z: (az + bz) * 0.5,
        y: (ay + by) * 0.5, yaw: bm });
      // ORIENTED, not axis-aligned. A 4 m chord of a 17 m circle taken as an
      // AABB is a 4 x 4 block, so an axis-aligned perimeter would be a solid
      // ring four metres thick - it would eat the walkable floor inside the
      // wire and, worse, shadow the whole firebase in the sky-visibility bake.
      var segLen = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      L.addCollider((ax + bx) * 0.5, (ay + by) * 0.5 + courses * 0.16,
        (az + bz) * 0.5, segLen * 0.5 + 0.15, courses * 0.16, 0.62, 'sandbag',
        false, _e1.set(0, Math.atan2(-(bz - az), bx - ax), 0, 'YXZ'));
    }

    // ---- gate posts and a fallen barrier ------------------------------------
    var gy = L.sampleGround(P.gate.x, P.gate.z);
    for (i = -1; i <= 1; i += 2) {
      var gx = P.gate.x + Math.cos(F.gateB) * i * 2.4;
      var gz = P.gate.z - Math.sin(F.gateB) * i * 2.4;
      B.tint = grey(0.86);
      B.cyl('timber', 0.13, 0.16, 2.5, gx, L.sampleGround(gx, gz) + 1.25, gz,
        rng.range(-0.05, 0.05), 0, rng.range(-0.07, 0.07), 7);
      B.tint = null;
      L.addCollider(gx, L.sampleGround(gx, gz) + 1.2, gz, 0.18, 1.2, 0.18, 'wood');
    }
    // the barrier pole, dropped and half buried
    B.tint = tint(0xd8d2c0, 0.6);
    B.boxR('timber', 4.6, 0.13, 0.13,
      P.gate.x + 1.2, gy + 0.16, P.gate.z + 0.7, 0.04, F.gateB + 0.9, 0.02);
    B.tint = null;

    // ---- concertina wire, outside the wall ----------------------------------
    // ON THE `wire` BUCKET, WHICH DOES NOT CAST. See SURF.wire: 132 coils x 7
    // rods at r = 0.018 m is ~900 casters two orders of magnitude finer than a
    // shadow-map texel, and what the cascade resolves is not a shadow but a
    // barcode of quantised rectangles at 15:1 contrast lying across the whole
    // firebase field in three published framings. The wire keeps its GROUND
    // CONTACT through a painted rut of mark cards along the ring, which is a
    // soft, penumbra-shaped, correctly-coloured occlusion for one bucket that
    // was already being drawn.
    //
    // 88 coils, not 132, and 3 rod segments, not 4: the coil pitch stays under
    // half a metre so the ring still reads continuous, and the triangles pay
    // for the sandbag rim.
    var wr = F.r + 3.0;
    var coils = 88;
    for (i = 0; i < coils; i++) {
      var ang = (i / coils) * Math.PI * 2;
      var dgc = Math.abs(M.wrapAngle(ang - F.gateB));
      if (dgc < 0.24) continue;
      var jx2 = rng.range(-0.35, 0.35);
      var cx = F.x + Math.sin(ang) * (wr + jx2);
      var cz = F.z + Math.cos(ang) * (wr + jx2);
      var cy = L.sampleGround(cx, cz);
      var rr = rng.range(0.44, 0.62);
      var tang = ang + Math.PI * 0.5;
      B.tint = grey(rng.range(0.7, 1.0));
      for (var k = 0; k < 7; k++) {
        var a0 = (k / 7) * Math.PI * 2, a1 = ((k + 1) / 7) * Math.PI * 2;
        var p0x = Math.cos(a0) * rr, p0y = Math.sin(a0) * rr + rr;
        var p1x = Math.cos(a1) * rr, p1y = Math.sin(a1) * rr + rr;
        B.rod('wire',
          cx + Math.sin(tang) * p0x, cy + p0y, cz + Math.cos(tang) * p0x,
          cx + Math.sin(tang) * p1x, cy + p1y, cz + Math.cos(tang) * p1x,
          0.018, 3);
        void p0y; void p1y;
      }
      B.tint = null;
      if ((i % 6) === 0) {
        B.cyl('wire', 0.035, 0.035, 1.3, cx, cy + 0.65, cz, 0, 0, 0, 5);
      }
      // The contact shadow the CSM is no longer allowed to draw: a soft,
      // trodden, litter-dark ellipse under each coil. A card is one quad and it
      // lands with a real penumbra because it is a texture, not a depth test.
      if ((i % 2) === 0) {
        // SCUM, not litter. The litter cell draws 90 discrete leaf shapes, and
        // 44 of those laid in a ring at 1.6 m each read as a chain of boulders
        // round the perimeter - a worse artefact than the one being replaced.
        // The scum cell is a soft banded gradient with no readable shapes in
        // it, which is what an occlusion smudge under wire actually looks like.
        markCard(B, MARK.scum, cx + rng.range(-0.18, 0.18), cy + 0.014,
          cz + rng.range(-0.18, 0.18), rr * 3.6, rr * 3.0, tang,
          new THREE.Color(0.30, 0.34, 0.28));
      }
    }

    // ---- the mortar pit -----------------------------------------------------
    var Mp = P.mortar;
    var mpY = L.sampleGround(Mp.x, Mp.z);
    for (i = 0; i < 14; i++) {
      var ma0 = (i / 14) * Math.PI * 2, ma1 = ((i + 1) / 14) * Math.PI * 2;
      sandbagRun(B, rng,
        Mp.x + Math.sin(ma0) * Mp.r, mpY, Mp.z + Math.cos(ma0) * Mp.r,
        Mp.x + Math.sin(ma1) * Mp.r, mpY, Mp.z + Math.cos(ma1) * Mp.r,
        3, 0.34, 2);
    }
    // the pit floor, sunk
    B.tint = grey(0.72);
    B.cyl('mud', Mp.r - 0.4, Mp.r - 0.4, 0.5, Mp.x, mpY - Mp.sink - 0.25, Mp.z, 0, 0, 0, 14);
    B.tint = null;
    L.addCollider(Mp.x, mpY + 0.5, Mp.z, Mp.r + 0.5, 0.5, Mp.r + 0.5, 'sandbag');

    // ---- the PSP helipad ----------------------------------------------------
    // Pierced steel planking, laid in interlocking runs and now buckling as the
    // ground beneath it settles. The only large flat man-made plane in the
    // level, and its brightness is what keeps the firebase floor off the deck.
    var Hp = P.helipad;
    var hpY = L.sampleGround(Hp.x, Hp.z);
    var planks = Math.ceil(Hp.r * 2 / 0.42);
    for (i = 0; i < planks; i++) {
      var pu = -Hp.r + (i + 0.5) * 0.42;
      var halfw = Math.sqrt(Math.max(0, Hp.r * Hp.r - pu * pu));
      if (halfw < 0.6) continue;
      var segsN = Math.max(1, Math.round(halfw * 2 / 3.0));
      for (var sN = 0; sN < segsN; sN++) {
        var v0 = -halfw + (sN / segsN) * halfw * 2;
        var v1 = -halfw + ((sN + 1) / segsN) * halfw * 2;
        if (rng.next() < 0.06) continue;             // a plank lifted out
        var vm = (v0 + v1) * 0.5;
        var wx = Hp.x + pu * Math.cos(Hp.yaw) + vm * Math.sin(Hp.yaw);
        var wz = Hp.z - pu * Math.sin(Hp.yaw) + vm * Math.cos(Hp.yaw);
        B.tint = grey(rng.range(0.72, 1.05));
        B.boxR('tin', 0.40, 0.045, (v1 - v0) * 0.96,
          wx, hpY + 0.04 + rng.range(-0.02, 0.06), wz,
          rng.range(-0.035, 0.035), Hp.yaw, rng.range(-0.04, 0.04));
        B.tint = null;
      }
    }
    // the faded H, in a paler tint on the same material
    B.tint = tint(0xe8e4d2, 0.85);
    B.boxR('tin', 0.34, 0.05, 3.1, Hp.x - 1.05 * Math.cos(Hp.yaw), hpY + 0.09,
      Hp.z + 1.05 * Math.sin(Hp.yaw), 0, Hp.yaw, 0);
    B.boxR('tin', 0.34, 0.05, 3.1, Hp.x + 1.05 * Math.cos(Hp.yaw), hpY + 0.09,
      Hp.z - 1.05 * Math.sin(Hp.yaw), 0, Hp.yaw, 0);
    B.boxR('tin', 2.2, 0.05, 0.34, Hp.x, hpY + 0.09, Hp.z, 0, Hp.yaw, 0);
    B.tint = null;
    // weeds coming up through it
    for (i = 0; i < 46; i++) {
      var wa = rng.range(0, 6.28), wrr = Math.sqrt(rng.next()) * Hp.r;
      L.addInst('grass' + rng.int(0, 2),
        makeM(Hp.x + Math.sin(wa) * wrr, hpY + 0.06, Hp.z + Math.cos(wa) * wrr,
          0, rng.range(0, 6.28), 0), rng.range(0.30, 0.62), hpY);
    }

    // ---- the comms mast -----------------------------------------------------
    var Ms = P.mast;
    var msY = L.sampleGround(Ms.x, Ms.z);
    B.tint = grey(0.9);
    B.cyl('rust', 0.045, 0.075, Ms.h, Ms.x, msY + Ms.h * 0.5, Ms.z, 0.03, 0, 0.02, 6);
    for (i = 0; i < 3; i++) {
      var ga = i * 2.09 + 0.4;
      droop(B, 'rust', Ms.x, msY + Ms.h * 0.88, Ms.z,
        Ms.x + Math.sin(ga) * 5.2, msY + 0.1, Ms.z + Math.cos(ga) * 5.2, 0.30, 0.012, 5);
      B.cyl('rust', 0.03, 0.03, 0.7, Ms.x + Math.sin(ga) * 5.2, msY + 0.35,
        Ms.z + Math.cos(ga) * 5.2, 0, 0, 0, 5);
    }
    // a bent dipole at the top
    B.rod('rust', Ms.x, msY + Ms.h, Ms.z, Ms.x + 1.5, msY + Ms.h + 0.9, Ms.z + 0.3, 0.020, 4);
    B.rod('rust', Ms.x, msY + Ms.h, Ms.z, Ms.x - 1.2, msY + Ms.h + 1.2, Ms.z - 0.5, 0.020, 4);
    B.tint = null;
    L.addCollider(Ms.x, msY + Ms.h * 0.5, Ms.z, 0.16, Ms.h * 0.5, 0.16, 'metal');

    // ---- the collapsed A-frame shelter --------------------------------------
    var Sh = P.shelter;
    var shY = L.sampleGround(Sh.x, Sh.z);
    B.pushXYZ(Sh.x, shY, Sh.z, 0, Sh.yaw, 0);
    for (i = 0; i < 5; i++) {
      var zz = -2.4 + i * 1.2;
      var fall = i > 2 ? (i - 2) * 0.42 : 0;
      B.tint = grey(rng.range(0.7, 0.95));
      B.boxR('timber_wet', 0.10, 3.0, 0.10, -1.05 + fall * 0.5, 1.30 - fall, zz,
        0, 0, 0.62 + fall * 0.25);
      B.boxR('timber_wet', 0.10, 3.0, 0.10, 1.05 - fall * 0.5, 1.30 - fall, zz,
        0, 0, -0.62 - fall * 0.25);
      B.tint = null;
    }
    B.tint = grey(0.62);
    B.boxR('canvas', 3.0, 0.03, 5.4, 0, 1.05, -0.4, 0.10, 0, 0.28);
    B.boxR('canvas', 2.2, 0.03, 3.0, 0.9, 0.24, 2.0, 0.06, 0.3, -0.10);
    B.tint = null;
    B.pop();
    L.addCollider(Sh.x, shY + 0.7, Sh.z, 2.2, 0.7, 3.0, 'wood');

    // ---- the fire drum ------------------------------------------------------
    var Dr = P.drum;
    var drY = L.sampleGround(Dr.x, Dr.z);
    B.tint = tint(0x8a4a26, 0.9);
    B.cyl('rust', 0.30, 0.30, 0.88, Dr.x, drY + 0.44, Dr.z, 0.03, Dr.yaw, 0.02, 12);
    B.tint = null;
    for (i = 0; i < 3; i++) {
      B.cyl('rust', 0.315, 0.315, 0.05, Dr.x, drY + 0.16 + i * 0.30, Dr.z, 0, 0, 0, 12);
    }
    // the fire itself, so the practical has a visible source
    B.add('lit', cyl(0.24, 0.20, 0.42, 9), makeM(Dr.x, drY + 0.95, Dr.z));
    out.drum = new THREE.Vector3(Dr.x, drY + 0.90, Dr.z);
    L.addCollider(Dr.x, drY + 0.44, Dr.z, 0.32, 0.44, 0.32, 'metal');

    // ---- ammunition revetment, a low horseshoe by the gate ------------------
    var arP = P.fbW(9.6, -0.5);
    var arY = L.sampleGround(arP[0], arP[1]);
    for (i = 0; i < 9; i++) {
      var aa0 = -1.2 + (i / 9) * 4.2, aa1 = -1.2 + ((i + 1) / 9) * 4.2;
      sandbagRun(B, rng,
        arP[0] + Math.sin(aa0) * 2.4, arY, arP[1] + Math.cos(aa0) * 2.4,
        arP[0] + Math.sin(aa1) * 2.4, arY, arP[1] + Math.cos(aa1) * 2.4,
        3, 0.34, 1);
    }
    out.ammo = new THREE.Vector3(arP[0], arY, arP[1]);
    return out;
  }

  // ---- the command bunker ---------------------------------------------------
  // Sunk a metre into the knoll, sandbag revetted, roofed with beams, tin and
  // two courses of bags, and shell-holed. The hole is the whole point: it is
  // the level's INTERIOR framing, and without a hole an interior lit by one
  // doorway is a black rectangle.
  function buildBunker(L, B, rng) {
    var P = L.plan, K = P.bunker;
    var out = {};
    var hw = K.w * 0.5, hd = K.d * 0.5;
    var floorY = K.y - K.sink;
    var topY = K.y + K.wall - K.sink;          // top of the wall above ground
    var c = Math.cos(K.yaw), s = Math.sin(K.yaw);
    function W(lx, lz) { return [K.x + lx * c + lz * s, K.z - lx * s + lz * c]; }

    // the cut floor. Cooler than the exterior mud on purpose: this is the one
    // surface in the level lit almost entirely by a 2260 K lamp, so an albedo
    // that starts warm renders as amber and takes the whole room with it.
    B.tint = new THREE.Color(0.44, 0.60, 0.54);
    B.boxR('mud', K.w + 1.4, 0.6, K.d + 1.4, K.x, floorY - 0.30, K.z, 0, K.yaw, 0);
    B.tint = null;
    L.addCollider(K.x, floorY - 0.30, K.z, (K.w + 1.4) * 0.5, 0.30, (K.d + 1.4) * 0.5,
      'dirt', true, _e1.set(0, K.yaw, 0, 'YXZ'));

    // the four revetted walls, with a door gap in the +Z face
    var corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    var doorW = 1.35, doorAt = -1.6;
    for (var e = 0; e < 4; e++) {
      var A = corners[e], Bc = corners[(e + 1) % 4];
      if (e === 2) {
        // +Z wall: two runs either side of the doorway
        var wA = W(A[0], A[1]), wD0 = W(doorAt - doorW * 0.5, hd);
        var wD1 = W(doorAt + doorW * 0.5, hd), wB = W(Bc[0], Bc[1]);
        sandbagRun(B, rng, wA[0], floorY, wA[1], wD0[0], floorY, wD0[1], 11, 0.34, 2);
        sandbagRun(B, rng, wD1[0], floorY, wD1[1], wB[0], floorY, wB[1], 11, 0.34, 2);
        // a lintel over the door
        var wDm = W(doorAt, hd);
        B.tint = grey(0.8);
        B.boxR('timber', doorW + 0.7, 0.20, 0.30, wDm[0], floorY + 1.95, wDm[1],
          0, K.yaw, 0);
        B.tint = null;
        out.door = new THREE.Vector3(wDm[0], floorY, wDm[1]);
      } else {
        var w0 = W(A[0], A[1]), w1 = W(Bc[0], Bc[1]);
        sandbagRun(B, rng, w0[0], floorY, w0[1], w1[0], floorY, w1[1], 11, 0.34, 2);
      }
      var mA = W((A[0] + Bc[0]) * 0.5, (A[1] + Bc[1]) * 0.5);
      L.addCollider(mA[0], floorY + 1.1, mA[1],
        Math.abs(Bc[0] - A[0]) * 0.5 + 0.45, 1.15,
        Math.abs(Bc[1] - A[1]) * 0.5 + 0.45, 'sandbag', false,
        _e1.set(0, K.yaw, 0, 'YXZ'));
    }

    // ---- the roof -----------------------------------------------------------
    var roofY = floorY + 2.62;
    var holeX = 2.35, holeZ = 0.55, holeR = 1.30;
    function inHole(lx, lz) {
      var dx = lx - holeX, dz = lz - holeZ;
      return dx * dx + dz * dz < holeR * holeR;
    }
    B.pushXYZ(K.x, 0, K.z, 0, K.yaw, 0);
    // beams
    for (var bI = 0; bI < 8; bI++) {
      var bx = -hw + 0.55 + bI * ((K.w - 1.1) / 7);
      B.tint = grey(rng.range(0.72, 0.98));
      if (Math.abs(bx - holeX) < holeR * 0.9) {
        // blown through: two stubs and a splintered gap
        B.boxR('timber_wet', 0.18, 0.20, (hd + holeZ - holeR) * 0.98,
          bx, roofY, (-hd + (holeZ - holeR)) * 0.5, 0, 0, 0);
        B.boxR('timber_wet', 0.18, 0.20, (hd - holeZ - holeR) * 0.98,
          bx, roofY + rng.range(0, 0.10), (hd + holeZ + holeR) * 0.5,
          rng.range(-0.10, 0.10), 0, 0);
      } else {
        B.boxR('timber_wet', 0.18, 0.20, K.d + 0.9, bx, roofY, 0, 0, 0, 0);
      }
      B.tint = null;
    }
    // corrugated sheets
    for (var sI = 0; sI < 5; sI++) {
      var sz = -hd + 0.6 + sI * ((K.d - 1.2) / 4);
      B.tint = grey(rng.range(0.68, 1.0));
      if (Math.abs(sz - holeZ) < holeR) {
        var cut = Math.sqrt(Math.max(0.01, holeR * holeR - (sz - holeZ) * (sz - holeZ)));
        B.boxR('tin', (hw + holeX - cut) * 0.98, 0.02, 1.05,
          (-hw + (holeX - cut)) * 0.5, roofY + 0.13, sz, 0, 0, 0);
        B.boxR('tin', (hw - holeX - cut) * 0.98, 0.02, 1.05,
          (hw + holeX + cut) * 0.5, roofY + 0.13, sz, 0, 0, rng.range(-0.14, 0.14));
      } else {
        B.boxR('tin', K.w + 0.6, 0.02, 1.05, 0, roofY + 0.13, sz, 0, 0, 0);
      }
      B.tint = null;
    }
    // two courses of bags on top, minus the hole
    // The roof bags never get closer to a lens than nine metres (the overview
    // is on the tower platform, hero3 is across the wire) so they keep the
    // cheap pillow - 500 bags at the interior tessellation is 64k triangles for
    // a rim that is four pixels tall.
    var roofBags = bagShapes(rng, false);
    var bagN = Math.round((K.w + 0.6) / 0.52);
    var bagM = Math.round((K.d + 0.6) / 0.40);
    for (var q = 0; q < 2; q++) {
      for (var ii = 0; ii < bagN; ii++) {
        for (var jj = 0; jj < bagM; jj++) {
          // A PERFECT LATTICE, AND THE OVERVIEW LOOKS STRAIGHT DOWN ON IT. This
          // is 360 bags on an exact 0.52 x 0.40 grid with no positional jitter at
          // all, seen in plan from the tower platform nine metres above it - so
          // whatever the bag silhouettes and tints do, the roof photographed as a
          // woven mat of identical cells across a fifth of the establishing shot.
          // The bags are 0.72 x 0.56 on a 0.52 x 0.40 pitch, so 0.20 m and 0.16 m
          // of overlap; +/-0.07 and +/-0.05 leaves at least 6 cm of it and is what
          // turns the mat back into a roof somebody stacked.
          var lx = -hw - 0.3 + (ii + 0.5) * 0.52 + (q ? 0.20 : 0) +
            rng.range(-0.07, 0.07);
          var lz = -hd - 0.3 + (jj + 0.5) * 0.40 + rng.range(-0.05, 0.05);
          if (inHole(lx, lz)) continue;
          var edge = Math.sqrt((lx - holeX) * (lx - holeX) + (lz - holeZ) * (lz - holeZ));
          if (edge < holeR + 0.55 && rng.bool(0.55)) continue;
          if (rng.next() > (q ? 0.72 : 0.94)) continue;
          B.tint = new THREE.Color(rng.range(0.82, 1.04), rng.range(0.86, 1.02),
            rng.range(0.76, 0.98));
          if (rng.bool(0.30)) B.tint.multiply(new THREE.Color(0.70, 1.00, 0.72));
          var rvk = rng.next();
          var rshp = rvk < 0.10 ? 6 : (rvk < 0.24 ? 5 : rng.int(0, 4));
          var rsg = rng.range(0.90, 1.10);
          B.add('sandbag', roofBags[rshp],
            makeMS(lx, roofY + 0.28 + q * 0.24 + rng.range(-0.035, 0.035), lz,
              rng.range(-0.14, 0.14), rng.range(-0.55, 0.55), rng.range(-0.16, 0.16),
              0.72 * rsg, 0.30 * rsg, 0.56 * rsg));
          B.tint = null;
        }
      }
    }
    // an interior post that survived, and the two that did not
    B.tint = grey(0.7);
    B.boxR('timber_wet', 0.16, 2.25, 0.16, -2.6, floorY + 1.12, -1.2, 0, 0, 0);
    B.boxR('timber_wet', 0.16, 2.25, 0.16, -0.4, floorY + 1.12, 1.4, 0.03, 0, -0.02);
    B.boxR('timber_wet', 0.16, 1.9, 0.16, 2.9, floorY + 0.55, -1.9, 1.15, 0.4, 0);
    B.tint = null;
    // spoil and splinters under the hole
    B.tint = grey(0.62);
    B.add('mud', cyl(1.35, 0.7, 0.42, 10), makeM(holeX, floorY + 0.16, holeZ));
    B.tint = null;
    B.pop();

    // ---- roof OCCLUDERS -----------------------------------------------------
    // Geometry alone does not darken an interior. lighting.js bakes its sky
    // visibility volume from level.colliders, so a roof with no collider is a
    // roof the skylight walks straight through - which is exactly why the first
    // interior capture came back as a sunlit field with beams floating over it.
    // Four slabs, shaped around the shell hole so the shaft still has something
    // to come through and the hole is the only light in the room.
    // hz 2.85, not 3.6: the occluders stop 75 cm short of both eaves. A roof of
    // beams, tin and bags is not a slab, and the grazing daylight that gets in
    // along the wall head is the only thing that keeps the revetment's vertical
    // faces off pure black - without it the sky-visibility floor of 0.055 put
    // the room 250:1 under the shaft pool and the bags photographed as a row of
    // floating lids.
    var roofSlabs = [
      [-2.075, 0, 3.125, 2.85],
      [4.425, 0, 0.775, 2.85],
      [2.35, -1.90, 1.30, 1.15],
      [2.35, 2.45, 1.30, 0.60]
    ];
    for (var rs = 0; rs < roofSlabs.length; rs++) {
      var R4 = roofSlabs[rs];
      var wp4 = W(R4[0], R4[1]);
      L.addCollider(wp4[0], roofY + 0.30, wp4[1], R4[2], 0.28, R4[3],
        'wood', false, _e1.set(0, K.yaw, 0, 'YXZ'));
    }

    var hw2 = W(holeX, holeZ);
    out.holeAbove = new THREE.Vector3(hw2[0], roofY + 1.30, hw2[1]);
    out.holeFloor = new THREE.Vector3(hw2[0], floorY + 0.20, hw2[1]);
    out.floorY = floorY;
    out.roofY = roofY;
    // The interior framing: standing just inside the door, looking across the
    // shaft at the far wall. Solved from the bunker's own geometry so it can
    // never drift off the hole it exists to photograph.
    var eyeP = W(doorAt - 0.2, hd - 1.15);
    out.interiorEye = new THREE.Vector3(eyeP[0], floorY, eyeP[1]);
    var tgtP = W(holeX + 0.7, holeZ - 1.5);
    out.interiorTarget = new THREE.Vector3(tgtP[0], floorY + 0.55, tgtP[1]);
    // BOTH FIXTURES ARE PLACED IN THE INTERIOR FRAMING, not tidily by the door.
    // A light with no visible source is not a light, and a light behind the
    // camera is not a source. The lantern hangs off the centre beam on the
    // view axis; the worklight is clamped to the beam over the left-hand wall
    // so it throws a warm pool across the revetment the shaft does not reach.
    var lanP = W(0.85, 0.45);
    out.lantern = new THREE.Vector3(lanP[0], floorY + 1.86, lanP[1]);
    var wlP = W(-2.4, -1.1);
    out.worklight = new THREE.Vector3(wlP[0], floorY + 2.05, wlP[1]);
    // the lantern's own body, hung off the lintel
    B.tint = grey(0.8);
    B.cyl('rust', 0.055, 0.075, 0.19, out.lantern.x, out.lantern.y + 0.10,
      out.lantern.z, 0, 0, 0, 8);
    B.rod('rust', out.lantern.x, out.lantern.y + 0.19, out.lantern.z,
      out.lantern.x, roofY - 0.10, out.lantern.z, 0.010, 4);
    B.tint = null;
    B.add('lit', cyl(0.048, 0.048, 0.11, 8),
      makeM(out.lantern.x, out.lantern.y, out.lantern.z));
    B.add('lit', quad(0.16, 0.10),
      makeM(out.worklight.x, out.worklight.y, out.worklight.z, 0.9, K.yaw + 0.4, 0));
    B.tint = grey(0.75);
    B.cyl('rust', 0.10, 0.12, 0.10, out.worklight.x, out.worklight.y + 0.07,
      out.worklight.z, 1.1, K.yaw + 0.4, 0, 8);
    B.tint = null;

    // vines coming in over the roof edge - the growth is reclaiming it
    for (var v = 0; v < 7; v++) {
      var vx = -hw + rng.range(0.4, K.w - 0.4);
      var wp = W(vx, hd + 0.25);
      var uvv = atlasUV(CELL.liana);
      var vh = rng.range(1.4, 2.6);
      B.add('canopy', quad(vh * 0.34, vh, uvv[0], uvv[1], uvv[2], uvv[3]),
        makeM(wp[0], roofY + 0.55 - vh * 0.42, wp[1], 0, K.yaw + rng.range(-0.4, 0.4), 0));
      L.dripEdges.push({ position: new THREE.Vector3(wp[0], roofY + 0.2, wp[1]), fall: 1.6 });
    }
    return out;
  }

  // ---- the watchtower -------------------------------------------------------
  function buildTower(L, B, rng) {
    var P = L.plan, T = P.tower, i;
    var gy = L.sampleGround(T.x, T.z);
    var lean = T.lean, leanY = T.yaw + 0.8;
    var out = {};
    B.pushXYZ(T.x, gy, T.z, 0, T.yaw, 0);
    var R = T.legR;
    var legs = [[-R, -R], [R, -R], [R, R], [-R, R]];
    var plat = T.platY, roof = T.roofY;
    var top = [];
    for (i = 0; i < 4; i++) {
      var lx = legs[i][0], lz = legs[i][1];
      // legs splay out at the base and lean with the tower
      var bx = lx * 1.42 + Math.sin(leanY) * -lean * plat;
      var bz = lz * 1.42 + Math.cos(leanY) * -lean * plat;
      var tx = lx + Math.sin(leanY) * lean * plat * 0.5;
      var tz = lz + Math.cos(leanY) * lean * plat * 0.5;
      B.tint = grey(rng.range(0.74, 0.98));
      B.strut('timber_wet', bx, 0, bz, tx, plat, tz, 0.20, 0.20);
      B.tint = null;
      top.push([tx, tz]);
      L.addCollider(T.x + (bx + tx) * 0.5 * Math.cos(T.yaw) + (bz + tz) * 0.5 * Math.sin(T.yaw),
        gy + plat * 0.5,
        T.z - (bx + tx) * 0.5 * Math.sin(T.yaw) + (bz + tz) * 0.5 * Math.cos(T.yaw),
        0.22, plat * 0.5, 0.22, 'wood');
    }
    // cross bracing, three levels, alternating diagonals
    for (var lvl = 0; lvl < 3; lvl++) {
      var y0 = 1.5 + lvl * 2.2, y1 = y0 + 2.2;
      for (i = 0; i < 4; i++) {
        var a = legs[i], b = legs[(i + 1) % 4];
        var f0 = 1 + 0.42 * (1 - y0 / plat), f1 = 1 + 0.42 * (1 - y1 / plat);
        B.tint = grey(rng.range(0.7, 0.95));
        if ((lvl + i) & 1) {
          B.strut('timber_wet', a[0] * f0, y0, a[1] * f0, b[0] * f1, y1, b[1] * f1, 0.09, 0.09);
        } else {
          B.strut('timber_wet', b[0] * f0, y0, b[1] * f0, a[0] * f1, y1, a[1] * f1, 0.09, 0.09);
        }
        B.strut('timber_wet', a[0] * f1, y1, a[1] * f1, b[0] * f1, y1, b[1] * f1, 0.08, 0.08);
        B.tint = null;
      }
    }
    // the platform
    var px = Math.sin(leanY) * lean * plat * 0.5, pz = Math.cos(leanY) * lean * plat * 0.5;
    B.tint = grey(0.82);
    for (i = 0; i < 9; i++) {
      if (rng.next() < 0.10) continue;                 // a rotted-out plank
      B.boxR('timber_wet', 0.30, 0.055, R * 2.6, px + (-R * 1.2 + i * (R * 2.4 / 8)),
        plat + 0.05, pz, 0, 0, 0);
    }
    B.boxR('timber_wet', R * 2.7, 0.14, 0.14, px, plat - 0.05, pz - R * 1.3, 0, 0, 0);
    B.boxR('timber_wet', R * 2.7, 0.14, 0.14, px, plat - 0.05, pz + R * 1.3, 0, 0, 0);
    B.tint = null;
    // a sandbag parapet on two sides and a rail on the others
    var wp0 = [px - R * 1.3, pz - R * 1.3], wp1 = [px + R * 1.3, pz - R * 1.3];
    var wp2 = [px + R * 1.3, pz + R * 1.3], wp3 = [px - R * 1.3, pz + R * 1.3];
    B.pop();
    B.pushXYZ(T.x, gy + plat + 0.08, T.z, 0, T.yaw, 0);
    sandbagRun(B, rng, wp0[0], 0, wp0[1], wp1[0], 0, wp1[1], 3, 0.30, 2);
    sandbagRun(B, rng, wp1[0], 0, wp1[1], wp2[0], 0, wp2[1], 3, 0.30, 2);
    B.tint = grey(0.8);
    B.strut('timber_wet', wp2[0], 0.95, wp2[1], wp3[0], 0.95, wp3[1], 0.07, 0.07);
    B.strut('timber_wet', wp3[0], 0.95, wp3[1], wp0[0], 0.95, wp0[1], 0.07, 0.07);
    // corner posts and the roof
    var rh = roof - plat;
    for (i = 0; i < 4; i++) {
      var cp = [wp0, wp1, wp2, wp3][i];
      B.boxR('timber_wet', 0.11, rh, 0.11, cp[0], rh * 0.5, cp[1], 0, 0, 0);
    }
    B.tint = null;
    B.tint = grey(rng.range(0.7, 0.95));
    for (i = 0; i < 4; i++) {
      // 1.62 wide on a 1.548 pitch, i.e. the sheets OVERLAP the way roofing
      // sheets do. At 0.95 they left 0.6 m gaps and the roof photographed as
      // four dark slats floating over the platform.
      B.boxR('tin', R * 3.0, 0.02, 1.62, 0, rh + 0.18 - Math.abs(i - 1.5) * 0.06,
        -R * 1.35 + i * (R * 2.7 / 3), 0.06 * (i < 2 ? 1 : -1), 0, 0);
    }
    B.tint = null;
    B.pop();

    // the ladder, up the south leg
    B.pushXYZ(T.x, gy, T.z, 0, T.yaw, 0);
    B.tint = grey(0.78);
    var lx0 = -R * 0.9, lz0 = R * 1.9;
    B.strut('timber_wet', lx0 - 0.28, 0, lz0 + 0.4, lx0 - 0.28, plat, lz0 - 0.3, 0.07, 0.07);
    B.strut('timber_wet', lx0 + 0.28, 0, lz0 + 0.4, lx0 + 0.28, plat, lz0 - 0.3, 0.07, 0.07);
    for (i = 1; i < 20; i++) {
      var t = i / 20;
      if (rng.next() < 0.08) continue;
      B.boxR('timber_wet', 0.62, 0.045, 0.045, lx0, plat * t,
        lz0 + 0.4 - 0.7 * t, 0, 0, 0);
    }
    B.tint = null;
    B.pop();

    out.base = new THREE.Vector3(T.x, gy, T.z);
    out.platform = new THREE.Vector3(T.x + px, gy + plat, T.z + pz);
    out.roof = new THREE.Vector3(T.x + px, gy + roof, T.z + pz);
    L.addCollider(T.x + px, gy + plat + 0.2, T.z + pz, R * 1.5, 0.35, R * 1.5, 'wood');
    L.dripEdges.push({ position: new THREE.Vector3(T.x + px + R * 1.4, gy + roof, T.z + pz),
      fall: 2.6 });
    L.dripEdges.push({ position: new THREE.Vector3(T.x + px - R * 1.4, gy + roof, T.z + pz - 0.6),
      fall: 2.6 });
    return out;
  }

  // ============================================================== THE WRECK ==
  // A slick down at the water's edge, rolled onto its left side with the boom
  // snapped aft of the cabin. Everything is built in a local frame where y = 0
  // is the skid line and +z is the nose, then the whole assembly is rolled,
  // pitched and yawed onto the bank - so the geometry never has to know which
  // way up it ended.
  function buildHeli(L, B, rng) {
    var P = L.plan, H = P.heli, i;
    var out = {};
    B.pushXYZ(H.x, H.y, H.z, H.pitch, H.yaw, H.roll);

    // ---- cabin --------------------------------------------------------------
    B.tint = tint(0xbcc9ac, 0.75);
    B.boxR('olive', 2.50, 1.95, 4.00, 0, 1.78, 1.30, 0, 0, 0, 0.10);
    // roof, slightly domed
    B.boxR('olive', 2.34, 0.16, 3.90, 0, 2.80, 1.30, 0, 0, 0, 0.06);
    // belly, tapering in
    B.boxR('olive', 2.10, 0.42, 3.90, 0, 0.72, 1.30, 0, 0, 0, 0.10);
    // nose: three stacked slabs that shrink and drop, giving the Huey's chin
    B.boxR('olive', 2.20, 1.55, 0.75, 0, 1.72, 3.62, -0.10, 0, 0, 0.08);
    B.boxR('olive', 1.72, 1.20, 0.62, 0, 1.55, 4.16, -0.24, 0, 0, 0.08);
    B.boxR('olive', 1.15, 0.72, 0.42, 0, 1.34, 4.52, -0.42, 0, 0, 0.06);
    // engine deck and the transmission hump
    B.boxR('olive', 1.85, 0.95, 1.55, 0, 2.95, -0.85, 0.06, 0, 0, 0.07);
    B.boxR('alu', 1.30, 0.62, 1.10, 0, 3.42, -0.55, 0, 0, 0, 0.06);
    B.tint = null;
    // exhaust stack, burnt
    B.tint = tint(0x6a4a34, 0.9);
    B.cyl('rust', 0.24, 0.28, 0.95, 0.30, 3.30, -1.55, 1.25, 0.2, 0, 9);
    B.tint = null;

    // ---- THE GREENHOUSE -----------------------------------------------------
    // A Huey's single most recognisable feature is its glazing: a raked
    // two-pane windscreen, a wraparound corner quarterlight each side, an
    // overhead greenskin panel and two chin bubbles under the pilots' feet.
    // Without it the nose is a solid opaque olive plate and the landmark of the
    // level is a chamfered box - which is exactly what the hero2 crop showed.
    // Half of it is broken out, which is the whole difference between a wreck
    // and a parked aircraft: the surviving panes are on the UP side (the
    // machine is rolled 0.44 rad to port) and the down side is an empty frame.
    B.tint = grey(0.92);
    // windscreen: two raked panes meeting on the centreline
    B.boxR('glazing', 1.14, 1.34, 0.05, -0.52, 2.02, 3.66, -0.60, 0.14, 0);
    // the port half is gone - only its frame remains (below)
    // overhead greenskin, over the pilots
    B.boxR('glazing', 1.86, 0.05, 0.72, 0, 2.66, 3.05, -0.14, 0, 0);
    // corner quarterlights
    B.boxR('glazing', 0.05, 0.90, 1.05, 1.08, 1.98, 3.28, 0, 0, 0.10);
    // chin bubble, starboard only - the port one is smashed
    B.boxR('glazing', 0.80, 0.05, 0.86, 0.44, 1.06, 4.02, -0.95, 0, 0);
    // cabin window in the surviving door
    B.boxR('glazing', 0.04, 0.52, 0.76, -1.30, 2.16, 1.34, 0, -0.62, 0.10);
    B.tint = null;
    // the shattered port windscreen: a fringe of remaining shards round its frame
    B.tint = grey(1.25);
    for (i = 0; i < 7; i++) {
      var shg = -1.05 + i * 0.175;
      B.boxR('glazing', 0.17, rng.range(0.10, 0.30), 0.03,
        shg, 1.62 + rng.range(0, 0.14), 3.86 - shg * 0.18,
        -0.60, 0.14, rng.range(-0.3, 0.3));
    }
    B.tint = null;

    // ---- doors: one hanging open, one torn off entirely ---------------------
    B.tint = tint(0xbcc9ac, 0.75);
    B.boxR('olive', 0.06, 1.55, 1.60, -1.28, 1.85, 1.30, 0, -0.62, 0.10);
    B.tint = null;
    // THE CARGO BAY, OPEN AND BLACK. A slick with two flat flanks is a crate;
    // the void where the doors used to be is most of what says helicopter, and
    // it is also the only strong dark in a framing full of mid greens.
    B.tint = grey(0.10);
    B.boxR('olive', 0.30, 1.42, 1.72, 1.16, 1.82, 1.24, 0, 0, 0, 0.04);
    B.tint = null;
    B.tint = tint(0xbcc9ac, 0.75);
    B.boxR('olive', 0.16, 0.10, 1.90, 1.27, 2.60, 1.24, 0, 0, 0);   // door rail
    B.boxR('olive', 0.22, 0.12, 1.90, 1.24, 1.02, 1.24, 0, 0, 0);   // sill
    // the windscreen frame and the chin bubble surround
    B.boxR('olive', 2.16, 0.09, 1.30, 0, 2.28, 3.35, -0.62, 0, 0, 0.03);
    B.boxR('olive', 0.11, 1.15, 1.30, 1.02, 1.86, 3.42, -0.62, 0, 0, 0.03);
    B.boxR('olive', 0.11, 1.15, 1.30, -1.02, 1.86, 3.42, -0.62, 0, 0, 0.03);
    // the centre post between the two windscreen panes
    B.boxR('olive', 0.09, 1.32, 0.10, 0, 2.02, 3.68, -0.60, 0, 0);
    B.tint = null;

    // ---- THE CABIN, SEEN INTO -----------------------------------------------
    // A void behind a door aperture is a black hole; a FLOOR behind it is a
    // helicopter. The deck plate catches the sky through the open starboard
    // door and gives the one strong dark in the framing something to be dark
    // AGAINST, and the two troop-seat frames give it scale.
    B.tint = tint(0x9aa38c, 0.7);
    B.boxR('alu', 2.10, 0.06, 3.40, 0, 1.05, 1.30, 0, 0, 0);        // deck
    B.tint = null;
    B.tint = tint(0x7f8a72, 0.8);
    for (i = -1; i <= 1; i += 2) {
      B.boxR('alu', 0.05, 0.55, 1.35, i * 0.42, 1.33, 0.35, 0, 0, 0); // seat back
      B.boxR('alu', 0.62, 0.05, 0.42, i * 0.55, 1.10, 1.15, 0, 0, 0); // pan
    }
    // the bulkhead behind the pilots, with the console cut into it
    B.boxR('alu', 1.90, 0.90, 0.07, 0, 1.62, 2.45, 0, 0, 0);
    B.tint = null;
    B.tint = grey(0.22);
    B.boxR('rust', 1.30, 0.34, 0.30, 0, 1.60, 3.05, -0.35, 0, 0);   // instrument coaming
    B.tint = null;

    // ---- TORN SKIN, AND IT IS BLACK AT THE EDGE ------------------------------
    // The aircraft came down hard enough to break the boom off; the flank it
    // landed on has a panel peeled up off its frames with the fire-blackened
    // edge that a fuel fire leaves. Four bent plates and a scorch band, on the
    // side hero2 photographs.
    B.tint = tint(0xb4c1a4, 0.8);
    for (i = 0; i < 4; i++) {
      var pz3 = -0.30 + i * 0.52;
      B.boxR('alu', 0.05, 0.62 + i * 0.10, 0.46,
        1.22 + i * 0.055, 2.30 + rng.range(-0.06, 0.10), pz3,
        rng.range(-0.10, 0.10), rng.range(-0.45, -0.16), rng.range(-0.22, 0.10));
    }
    B.tint = null;
    B.tint = grey(0.12);
    B.boxR('olive', 0.04, 0.72, 2.30, 1.19, 2.02, 0.62, 0, 0, 0.03); // scorch band
    B.boxR('olive', 0.04, 0.34, 1.10, 1.19, 2.66, -0.70, 0, 0, 0);   // soot off the deck
    B.tint = null;
    // exposed frames inside the tear
    B.tint = tint(0x8c9680, 0.8);
    for (i = 0; i < 3; i++) {
      B.boxR('alu', 0.30, 0.90, 0.05, 1.06, 2.10, -0.10 + i * 0.62, 0, 0, 0);
    }
    B.tint = null;

    // ---- skids --------------------------------------------------------------
    B.tint = grey(0.8);
    for (i = -1; i <= 1; i += 2) {
      var st = [];
      for (var k = 0; k <= 5; k++) {
        var t = k / 5;
        var z = -0.95 + t * 4.75;
        var yy = 0.02 + Math.pow(M.saturate((t - 0.72) / 0.28), 2) * 0.55;
        st.push([1.22 * i + (i < 0 ? Math.pow(t, 2) * 0.35 : 0), yy, z, 0.055]);
      }
      B.add('alu', tube(st, 6, false));
      // cross struts
      B.strut('alu', 1.22 * i, 0.05, 0.15, 0.62 * i, 0.72, 0.15, 0.09, 0.09);
      B.strut('alu', 1.22 * i, 0.05, 2.55, 0.62 * i, 0.72, 2.55, 0.09, 0.09);
    }
    B.tint = null;

    // ---- the boom, snapped --------------------------------------------------
    var boom = [];
    for (i = 0; i <= 5; i++) {
      var tb = i / 5;
      boom.push([0, 2.62 - tb * 0.28, -1.35 - tb * 3.35, 0.44 - tb * 0.13]);
    }
    B.tint = tint(0x9fb08e, 0.55);
    B.add('olive', tube(boom, 9, false));
    B.tint = null;
    // torn edge: a ring of bent skin
    B.tint = grey(0.95);
    for (i = 0; i < 9; i++) {
      var ta = (i / 9) * Math.PI * 2;
      B.boxR('alu', 0.10, 0.34, 0.03,
        Math.sin(ta) * 0.30, 2.35 + Math.cos(ta) * 0.30, -4.72,
        rng.range(-0.5, 0.5), ta, rng.range(-0.4, 0.4));
    }
    B.tint = null;
    B.pop();

    // The aft section came to rest separately: same yaw, different everything.
    var ax = H.x - Math.sin(H.yaw) * 7.4 + Math.cos(H.yaw) * 2.6;
    var az = H.z - Math.cos(H.yaw) * 7.4 - Math.sin(H.yaw) * 2.6;
    var ay = L.sampleGround(ax, az);
    B.pushXYZ(ax, ay + 0.35, az, 0.24, H.yaw + 1.15, 1.35);
    var boom2 = [];
    for (i = 0; i <= 4; i++) {
      var t2 = i / 4;
      boom2.push([0, 0, -1.6 + t2 * 3.2, 0.31 - t2 * 0.11]);
    }
    B.tint = tint(0x9fb08e, 0.55);
    B.add('olive', tube(boom2, 9, false));
    // the fin and the horizontal stabiliser
    B.boxR('olive', 0.07, 1.45, 1.05, 0, 0.72, -1.35, 0.22, 0, 0, 0.05);
    B.boxR('olive', 2.20, 0.06, 0.42, 0, 0.05, -0.55, 0, 0, 0.04);
    B.tint = null;
    // tail rotor, one blade bent
    B.tint = grey(0.85);
    B.cyl('alu', 0.10, 0.10, 0.22, 0.14, 1.15, -1.45, 0, 0, 1.57, 8);
    B.boxR('alu', 0.05, 1.30, 0.16, 0.26, 1.15, -1.45, 0, 0, 0.15);
    B.boxR('alu', 0.05, 1.05, 0.16, 0.26, 1.15, -1.45, 0, 0, 1.75);
    B.tint = null;
    B.pop();
    out.tail = new THREE.Vector3(ax, ay, az);
    L.addCollider(ax, ay + 0.6, az, 1.6, 0.7, 1.6, 'metal');

    // ---- the main rotor -----------------------------------------------------
    B.pushXYZ(H.x, H.y, H.z, H.pitch, H.yaw, H.roll);
    B.tint = grey(0.86);
    B.cyl('alu', 0.13, 0.16, 1.15, 0, 3.62, 0.55, 0, 0, 0, 9);
    B.cyl('alu', 0.34, 0.30, 0.30, 0, 4.20, 0.55, 0, 0, 0, 10);
    B.tint = null;
    B.pop();
    // Blades are placed in WORLD space: one folded down into the mud, one
    // still out over the water. Bolting them to the rolled frame put both
    // through the ground.
    var hubX = H.x + Math.sin(H.yaw) * 0.55 * Math.cos(H.roll);
    var hubZ = H.z + Math.cos(H.yaw) * 0.55;
    var hubY = H.y + 4.20 * Math.cos(H.roll) - 0.35;
    out.rotorHub = new THREE.Vector3(hubX, hubY, hubZ);
    B.tint = grey(0.80);
    for (i = 0; i < 2; i++) {
      var ba = H.yaw + 0.75 + i * Math.PI;
      var blen = 6.4;
      var bst = [];
      for (var s2 = 0; s2 <= 5; s2++) {
        var tb2 = s2 / 5;
        var bxx = hubX + Math.sin(ba) * blen * tb2;
        var bzz = hubZ + Math.cos(ba) * blen * tb2;
        var gnd = L.sampleGround(bxx, bzz);
        // the blade droops until it finds the ground, then stops
        var byy = Math.max(gnd + 0.12, hubY - (i ? 2.9 : 0.8) * tb2 * tb2);
        bst.push([bxx, byy, bzz, 0.05]);
      }
      for (s2 = 0; s2 + 1 < bst.length; s2++) {
        var q0 = bst[s2], q1 = bst[s2 + 1];
        B.strut('alu', q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], 0.42, 0.055);
      }
    }
    B.tint = null;

    // ---- the growth reclaiming it -------------------------------------------
    for (i = 0; i < 14; i++) {
      var ga = rng.range(0, 6.28), gr = rng.range(0.5, 4.2);
      var gx = H.x + Math.sin(ga) * gr, gz = H.z + Math.cos(ga) * gr;
      L.addInst('grass' + rng.int(0, 2),
        makeM(gx, L.sampleGround(gx, gz), gz, 0, rng.range(0, 6.28), 0),
        rng.range(0.7, 1.25), L.sampleGround(gx, gz));
    }
    // GROWTH COLONISES SEAMS, NOT CENTRELINES. One vertical strand of
    // identically-sized, evenly-spaced, identically-oriented heart leaves reads
    // as a plastic garland - which is precisely what the hero2 crop showed. The
    // creeper now runs in three CLUMPS anchored to the places a plant can
    // actually get a root into a machine (the door sill, the engine deck seam
    // and the boom break), with per-card scale 0.5-1.6x, free yaw and free
    // pitch, plus a scatter of small individual leaves between them.
    // Local to the airframe, so a "door sill" is the door sill whatever the
    // machine's roll and yaw did to it - and so nothing lands over the
    // greenhouse, which is the one part of the silhouette that has to read.
    B.pushXYZ(H.x, H.y, H.z, H.pitch, H.yaw, H.roll);
    var seams = [
      [-1.30, 1.30, 1.10],    // port door sill, the low side
      [0.20, 3.05, -0.85],    // engine deck / transmission seam
      [0.10, 2.55, -4.40],    // the boom break
      [1.28, 1.20, 0.35]      // starboard sill, aft of the opening
    ];
    for (i = 0; i < seams.length; i++) {
      var sm = seams[i];
      var nvc = rng.int(3, 6);
      for (var vc = 0; vc < nvc; vc++) {
        var vv = atlasUV(CELL.creeper);
        var vh = rng.range(0.9, 2.4) * rng.range(0.55, 1.30);
        var rad = Math.pow(rng.next(), 0.62) * 1.2;
        var vang = rng.range(0, 6.28);
        B.add('canopy', quad(vh * rng.range(0.55, 1.05), vh,
          vv[0], vv[1], vv[2], vv[3]),
          makeM(sm[0] + Math.sin(vang) * rad,
            sm[1] + rng.range(-0.55, 0.55),
            sm[2] + Math.cos(vang) * rad,
            rng.range(-0.5, 0.5), rng.range(0, 6.28), rng.range(-0.7, 0.7)));
      }
    }
    B.pop();
    L.addInst('banana0',
      makeM(H.x - Math.sin(H.yaw) * 1.6, H.y + 0.6, H.z - Math.cos(H.yaw) * 1.6,
        0, rng.range(0, 6.28), 0), 0.85, H.y);

    // the anti-collision beacon, still weakly turning over
    var bcx = H.x - Math.sin(H.yaw) * 2.4;
    var bcz = H.z - Math.cos(H.yaw) * 2.4;
    var bcy = H.y + 3.05 * Math.cos(H.roll);
    out.beacon = new THREE.Vector3(bcx, bcy, bcz);
    B.add('lit2', cyl(0.075, 0.085, 0.13, 8), makeM(bcx, bcy, bcz));

    out.centre = new THREE.Vector3(H.x, H.y, H.z);
    out.nose = new THREE.Vector3(H.x + Math.sin(H.yaw) * 4.3, H.y + 1.2,
      H.z + Math.cos(H.yaw) * 4.3);
    out.doorSill = new THREE.Vector3(H.x - Math.cos(H.yaw) * 1.5, H.y + 1.0,
      H.z + Math.sin(H.yaw) * 1.5);
    L.addCollider(H.x, H.y + 1.5, H.z, 2.9, 1.5, 3.4, 'metal', false,
      _e1.set(0, H.yaw, 0, 'YXZ'));
    L.dripEdges.push({ position: new THREE.Vector3(H.x, H.y + 2.7, H.z), fall: 2.2 });
    return out;
  }

  // ========================================== THE CREEK CROSSING AND SLUICE ==
  function buildBridge(L, B, rng) {
    var P = L.plan, Br = P.bridge, i;
    var out = {};
    var nearY = Br.y, farY = Br.y - 0.06;
    var span = Br.nearZ - Br.farZ;
    var breakT = 0.52;                        // where the stringers gave way
    var brZ = Br.nearZ - span * breakT;
    var brY = nearY - 1.35;

    // abutment piles
    B.tint = grey(0.8);
    for (i = -1; i <= 1; i += 2) {
      B.cyl('timber_wet', 0.11, 0.13, 1.6, Br.x + i * (Br.w * 0.5 + 0.1),
        nearY - 0.55, Br.nearZ - 0.2, 0.05, 0, 0, 7);
      B.cyl('timber_wet', 0.11, 0.13, 1.6, Br.x + i * (Br.w * 0.5 + 0.1),
        farY - 0.55, Br.farZ + 0.2, -0.05, 0, 0, 7);
    }
    B.tint = null;

    // three bamboo stringers, sagging to the break
    for (i = -1; i <= 1; i++) {
      var sx = Br.x + i * (Br.w * 0.42);
      var st = [];
      for (var k = 0; k <= 6; k++) {
        var t = k / 6;
        var zz = Br.nearZ - span * breakT * t;
        var yy = nearY - 1.35 * t * t;
        st.push([sx + Math.sin(t * 2.4 + i) * 0.05, yy, zz, 0.055]);
      }
      B.tint = tint(0xd8d29a, 0.75);
      B.add('bamboo', tube(st, 6, false));
      B.tint = null;
    }
    // the deck planks that survive
    var np = 20;
    for (i = 0; i < np; i++) {
      var t2 = (i + 0.5) / np;
      if (rng.next() < 0.24) continue;
      var pz = Br.nearZ - span * breakT * t2;
      var py = nearY - 1.35 * t2 * t2 + 0.06;
      B.tint = tint(0xcfc898, rng.range(0.5, 0.9));
      B.boxR('bamboo', Br.w, 0.055, 0.20, Br.x + rng.range(-0.05, 0.05), py, pz,
        rng.range(-0.05, 0.05), rng.range(-0.06, 0.06), rng.range(-0.09, 0.09));
      B.tint = null;
    }
    // the fallen far half, lying in the creek
    var fx = Br.x + rng.range(-0.4, 0.4);
    for (i = -1; i <= 1; i++) {
      var st2 = [];
      for (k = 0; k <= 4; k++) {
        var t3 = k / 4;
        st2.push([fx + i * 0.5 + t3 * 0.6,
          brY - 0.35 + Math.sin(t3 * 2.0) * 0.10,
          brZ - span * 0.30 * t3, 0.055]);
      }
      B.tint = tint(0xb4ae82, 0.7);
      B.add('bamboo', tube(st2, 6, false));
      B.tint = null;
    }
    for (i = 0; i < 9; i++) {
      var t4 = i / 9;
      B.tint = tint(0xb4ae82, rng.range(0.4, 0.8));
      B.boxR('bamboo', Br.w * 0.9, 0.055, 0.20, fx + t4 * 0.6 + rng.range(-0.2, 0.2),
        brY - 0.30 + rng.range(-0.05, 0.10), brZ - span * 0.30 * t4,
        rng.range(-0.2, 0.2), rng.range(-0.3, 0.3), rng.range(-0.25, 0.25));
      B.tint = null;
    }

    // a rope handrail on one side, still standing on the near half
    B.tint = grey(0.85);
    var posts = 4;
    for (i = 0; i < posts; i++) {
      var t5 = i / (posts - 1) * breakT;
      var hz = Br.nearZ - span * t5;
      var hy = nearY - 1.35 * (t5 / breakT) * (t5 / breakT);
      B.cyl('timber_wet', 0.045, 0.055, 1.0, Br.x + Br.w * 0.5, hy + 0.5, hz,
        rng.range(-0.08, 0.08), 0, rng.range(-0.10, 0.10), 6);
    }
    droop(B, 'rope', Br.x + Br.w * 0.5, nearY + 0.92, Br.nearZ,
      Br.x + Br.w * 0.5, brY + 0.55, brZ, 0.24, 0.022, 6);
    B.tint = null;

    L.addCollider(Br.x, nearY - 0.4, Br.nearZ - span * 0.13,
      Br.w * 0.6, 0.30, span * 0.15, 'wood', true);
    out.nearLip = new THREE.Vector3(Br.x, nearY, Br.nearZ);
    out.farLip = new THREE.Vector3(Br.x, farY, Br.farZ);
    out.breakPoint = new THREE.Vector3(Br.x, brY, brZ);
    out.deckY = nearY;
    L.dripEdges.push({ position: new THREE.Vector3(Br.x, nearY, Br.nearZ - 1.2), fall: 1.4 });
    return out;
  }

  // A French-era sluice headwall at the creek mouth. The only orthogonal
  // man-made thing between the spawn and the firebase, and therefore the only
  // place a straight line survives in the southern half of the level.
  function buildSluice(L, B, rng) {
    var P = L.plan, S = P.sluice;
    var out = {};
    B.pushXYZ(S.x, S.y, S.z, 0, S.yaw, 0);
    B.tint = tint(0xb6bcae, 0.55);
    B.boxR('concrete', S.w, S.h, 0.85, 0, S.h * 0.5 - 0.55, 0, 0, 0, 0);
    B.tint = null;
    // wing walls, one of them cracked away from the headwall
    B.tint = tint(0xa8b0a4, 0.5);
    B.boxR('concrete', 0.62, S.h * 0.78, 3.4, -S.w * 0.5 + 0.3, S.h * 0.35 - 0.55, -1.8, 0, 0, 0);
    B.boxR('concrete', 0.62, S.h * 0.70, 3.0, S.w * 0.5 - 0.3, S.h * 0.30 - 0.60, -1.7,
      0.05, 0.09, -0.06);
    B.tint = null;
    // two culvert mouths
    for (var i = -1; i <= 1; i += 2) {
      B.tint = grey(0.16);
      B.cyl('concrete', 0.78, 0.78, 0.95, i * 1.55, 0.35, 0.05, Math.PI * 0.5, 0, 0, 12);
      B.tint = null;
      B.tint = tint(0xc4c8ba, 0.6);
      B.cyl('concrete', 0.98, 0.98, 0.22, i * 1.55, 0.35, 0.44, Math.PI * 0.5, 0, 0, 14);
      B.tint = null;
    }
    // the screw-gate frame and its handwheel
    B.tint = tint(0x8a5030, 0.9);
    B.boxR('rust', 0.12, 2.3, 0.12, -1.55, S.h * 0.55, -0.35, 0, 0, 0);
    B.boxR('rust', 0.12, 2.3, 0.12, -0.85, S.h * 0.55, -0.35, 0, 0, 0);
    B.boxR('rust', 0.95, 0.14, 0.14, -1.20, S.h * 0.55 + 1.15, -0.35, 0, 0, 0);
    B.cyl('rust', 0.032, 0.032, 1.5, -1.20, S.h * 0.55 + 0.45, -0.35, 0, 0, 0, 6);
    B.cyl('rust', 0.30, 0.30, 0.05, -1.20, S.h * 0.55 + 1.25, -0.35, Math.PI * 0.5, 0, 0, 12);
    for (i = 0; i < 5; i++) {
      var sa = i * 1.257;
      B.rod('rust', -1.20, S.h * 0.55 + 1.25, -0.35,
        -1.20 + Math.sin(sa) * 0.30, S.h * 0.55 + 1.25, -0.35 + Math.cos(sa) * 0.30, 0.02, 4);
    }
    B.tint = null;
    // the apron, silted over
    B.tint = grey(0.72);
    B.boxR('concrete', S.w - 0.6, 0.28, 2.4, 0, -0.62, 1.5, -0.06, 0, 0);
    B.tint = null;
    // creepers hanging down the face - a bare concrete wall in a jungle is a
    // wall nobody has looked at
    for (i = 0; i < 8; i++) {
      var uvv = atlasUV(CELL.creeper);
      var vh = rng.range(1.2, 2.6);
      B.add('canopy', quad(vh * 0.75, vh, uvv[0], uvv[1], uvv[2], uvv[3]),
        makeM(-S.w * 0.45 + rng.range(0, S.w * 0.9), S.h - 0.55 - vh * 0.42 + rng.range(-0.3, 0.4),
          0.46, 0, rng.range(-0.35, 0.35), 0));
    }
    B.pop();
    L.addCollider(S.x, S.y + S.h * 0.5 - 0.55, S.z, S.w * 0.5, S.h * 0.5, 0.55,
      'concrete', false, _e1.set(0, S.yaw, 0, 'YXZ'));
    out.centre = new THREE.Vector3(S.x, S.y, S.z);
    out.topY = S.y + S.h - 0.55;
    L.dripEdges.push({ position: new THREE.Vector3(S.x, S.y + S.h - 0.55, S.z + 0.5),
      fall: 2.2 });
    return out;
  }

  // The spirit house. Small, warm, and deliberately in hero1's frame: it is the
  // only thing in the southern half of the level that is not green, not
  // military and not decaying, and its two candles are the entire warm leg of
  // the grade split in a picture that is otherwise chlorophyll from edge to edge.
  function buildShrine(L, B, rng) {
    var P = L.plan, S = P.shrine;
    var out = {};
    var gy = L.sampleGround(S.x, S.z);
    B.pushXYZ(S.x, gy, S.z, 0, S.yaw, 0);
    B.tint = tint(0xd9d2c2, 0.55);
    B.boxR('concrete', 0.24, S.h, 0.24, 0, S.h * 0.5, 0, 0, 0, 0.02);
    B.boxR('concrete', 0.86, 0.09, 0.74, 0, S.h + 0.05, 0, 0, 0, 0.01);
    B.tint = null;
    // the house itself
    B.tint = tint(0xe0c48c, 0.8);
    B.boxR('timber', 0.62, 0.46, 0.52, 0, S.h + 0.32, -0.02, 0, 0, 0);
    B.tint = null;
    // the opening, dark, with the candles inside
    B.tint = grey(0.10);
    B.boxR('timber', 0.40, 0.30, 0.05, 0, S.h + 0.30, 0.25, 0, 0, 0);
    B.tint = null;
    // tiered roof
    B.tint = tint(0xc4553a, 0.85);
    B.boxR('timber', 0.86, 0.05, 0.72, 0, S.h + 0.58, -0.02, 0, 0, 0);
    B.boxR('timber', 0.62, 0.05, 0.52, 0, S.h + 0.68, -0.02, 0, 0, 0);
    B.boxR('timber', 0.34, 0.05, 0.30, 0, S.h + 0.77, -0.02, 0, 0, 0);
    B.cyl('timber', 0.015, 0.03, 0.22, 0, S.h + 0.90, -0.02, 0, 0, 0, 6);
    B.tint = null;
    // corner posts of the veranda
    B.tint = tint(0xe0c48c, 0.7);
    for (var i = 0; i < 2; i++) {
      B.boxR('timber', 0.04, 0.28, 0.04, (i ? 1 : -1) * 0.27, S.h + 0.20, 0.30, 0, 0, 0);
    }
    B.tint = null;
    // candles and joss sticks
    B.add('lit', cyl(0.016, 0.018, 0.11, 6), makeM(-0.09, S.h + 0.19, 0.20));
    B.add('lit', cyl(0.016, 0.018, 0.08, 6), makeM(0.08, S.h + 0.17, 0.22));
    B.tint = tint(0xd8b070, 0.8);
    B.cyl('timber', 0.006, 0.006, 0.24, 0.15, S.h + 0.26, 0.16, 0.10, 0, 0.16, 4);
    B.tint = null;
    // a garland over the eave
    B.tint = tint(0xd8a030, 0.9);
    droop(B, 'rope', -0.40, S.h + 0.55, 0.34, 0.40, S.h + 0.55, 0.34, 0.10, 0.018, 5);
    B.tint = null;
    B.pop();
    out.centre = new THREE.Vector3(S.x, gy, S.z);
    out.candle = new THREE.Vector3(
      S.x + Math.sin(S.yaw) * 0.18 * 0 + Math.cos(S.yaw) * -0.02,
      gy + S.h + 0.22,
      S.z + Math.cos(S.yaw) * 0.20);
    out.topY = gy + S.h + 0.95;
    L.addCollider(S.x, gy + S.h * 0.5, S.z, 0.20, S.h * 0.5, 0.20, 'concrete');
    L.dripEdges.push({ position: new THREE.Vector3(S.x + 0.4, gy + S.h + 0.58, S.z),
      fall: 1.1 });
    void rng;
    return out;
  }

  // The rock outcrop on the east rim: the overview standpoint, a hard mineral
  // silhouette in a level made of soft things, and a foreground for hero3.
  function buildOutcrop(L, B, rng) {
    var P = L.plan, O = P.outcrop, i;
    var top = L.sampleGround(O.x - 1.5, O.z + 1.0);
    for (i = 0; i < 11; i++) {
      var a = (i / 11) * Math.PI * 2 + rng.range(-0.25, 0.25);
      var r = O.r * rng.range(0.35, 1.0);
      var bx = O.x + Math.sin(a) * r, bz = O.z + Math.cos(a) * r;
      var by = L.sampleGround(bx, bz);
      var w = rng.range(2.0, 4.6), hh = rng.range(1.4, 4.2), d = rng.range(2.0, 4.4);
      B.tint = grey(rng.range(0.74, 1.06));
      B.boxR('stonework', w, hh, d, bx, by + hh * 0.35, bz,
        rng.range(-0.22, 0.22), rng.range(0, 6.28), rng.range(-0.22, 0.22),
        Math.min(w, Math.min(hh, d)) * 0.28);
      B.tint = null;
      L.addCollider(bx, by + hh * 0.35, bz, w * 0.42, hh * 0.5, d * 0.42, 'stone');
      // ferns and moss in every crack
      for (var f = 0; f < 3; f++) {
        var fa = rng.range(0, 6.28), fr = rng.range(w * 0.4, w * 0.8);
        var fx = bx + Math.sin(fa) * fr, fz = bz + Math.cos(fa) * fr;
        L.addInst('fern' + rng.int(0, 1),
          makeM(fx, L.sampleGround(fx, fz), fz, 0, rng.range(0, 6.28), 0),
          rng.range(0.6, 1.1), L.sampleGround(fx, fz));
      }
    }
    // the shelf the camera stands on
    B.tint = grey(0.92);
    B.boxR('stonework', 5.4, 1.1, 5.0, O.x - 1.5, top - 0.45, O.z + 1.0,
      0.03, 0.4, -0.02, 0.25);
    B.tint = null;
    L.addCollider(O.x - 1.5, top - 0.45, O.z + 1.0, 2.7, 0.55, 2.5, 'stone', true);
    return { centre: new THREE.Vector3(O.x, top, O.z), top: top };
  }

  // ================================================== THE WARM MASS OBJECTS ==
  // The level's own header claimed the warm mass was "the river, the bleached
  // sandbags, the aluminium of the wreck, the shrine's candles", and a
  // measurement of the signature frame demolished all four: the river is a grey
  // slab, the sandbags are inside the wire and out of three framings, and the
  // shrine is a 30 cm object at 10 m. 97% of the coloured pixels sat inside a
  // 100-degree hue band.
  //
  // These are the answer to that: WARM MASS, on the hero1 and hero2 axes,
  // large enough to occupy real frame area. A laterite cut where the track has
  // been dug into the bank, a rusted French culvert half buried at the foot of
  // it, and a tarp over a dump of rice sacks - three objects a delta track
  // would have and none of which is green.
  function buildWarmMass(L, B, rng) {
    var P = L.plan;
    var i;

    // ---- the laterite cut, on hero1's axis ----------------------------------
    // The track at z = 40 runs along the foot of rising ground; a cart road cut
    // into a laterite bank leaves a raw red scarp with a spoil apron under it
    // and roots hanging out of the top. It sits 8 m up the road from hero1's
    // standpoint on the east side, so it is a warm wall behind the fallen trunk.
    var cz = 39.5, cx = trackX(cz) + TRACK_SHOULDER + 1.15;
    var cyaw = Math.atan2(trackX(cz - 6) - trackX(cz + 6), -12);
    var cbase = L.sampleGround(cx, cz);
    B.pushXYZ(cx, cbase, cz, 0, cyaw, 0);
    for (i = 0; i < 9; i++) {
      var t = (i / 8) * 2 - 1;
      var hgt = 1.55 + Math.sin(i * 1.31 + 0.4) * 0.42 + rng.range(-0.12, 0.12);
      var dep = 0.85 + rng.range(-0.16, 0.22);
      // The cut face runs REDDER and BRIGHTER as it climbs: the topsoil is a
      // dark humus lip, the exposed subsoil beneath it is raw laterite.
      B.tint = new THREE.Color(rng.range(1.62, 2.05), rng.range(0.94, 1.12),
        rng.range(0.46, 0.68));
      B.boxR('laterite', 1.30, hgt, dep, t * 4.1, hgt * 0.5 - 0.25,
        rng.range(-0.22, 0.22), rng.range(-0.10, 0.10),
        rng.range(-0.16, 0.16), rng.range(-0.09, 0.09), 0.16);
      B.tint = null;
      // the dark humus lip that overhangs it
      B.tint = new THREE.Color(0.62, 0.72, 0.44);
      B.boxR('mud', 1.34, 0.30, dep + 0.34, t * 4.1, hgt - 0.10,
        -0.12, rng.range(-0.09, 0.09), rng.range(-0.14, 0.14), 0, 0.08);
      B.tint = null;
      // spoil at the foot
      if (rng.bool(0.7)) {
        B.tint = new THREE.Color(rng.range(1.40, 1.80), rng.range(0.82, 0.98), 0.52);
        B.cyl('laterite', rng.range(0.32, 0.62), rng.range(0.42, 0.75), 0.26,
          t * 4.1 + rng.range(-0.5, 0.5), -0.10, rng.range(0.5, 0.95),
          0, rng.range(0, 6.28), 0, 8);
        B.tint = null;
      }
      // roots hanging out of the cut
      if (rng.bool(0.6)) {
        var rx = t * 4.1 + rng.range(-0.4, 0.4);
        B.tint = grey(0.7);
        B.rod('bark', rx, hgt - 0.28, -0.35, rx + rng.range(-0.25, 0.25),
          hgt - rng.range(0.7, 1.2), 0.42, 0.035, 4);
        B.tint = null;
      }
    }
    B.pop();
    L.addCollider(cx, cbase + 0.9, cz, 4.6, 0.9, 0.75, 'dirt', false,
      _e1.set(0, cyaw, 0, 'YXZ'));

    // ---- the culvert, at the foot of the cut --------------------------------
    // A French-era corrugated pipe that used to take the run-off under the road
    // and is now a rusted orange tube lying in the ditch. Pure warm mass, right
    // on the axis, at eight metres - the distance at which hero1 had nothing.
    var vx = trackX(41.5) + TRACK_SHOULDER - 0.4, vz = 41.5;
    var vy = L.sampleGround(vx, vz);
    B.tint = new THREE.Color(1.42, 0.78, 0.42);
    B.cyl('rust', 0.46, 0.46, 3.2, vx, vy + 0.34, vz, 0.06, cyaw + 1.42, 0.09, 12);
    for (i = 0; i < 9; i++) {
      B.cyl('rust', 0.50, 0.50, 0.07, vx + Math.sin(cyaw + 1.42) * (-1.5 + i * 0.36),
        vy + 0.34, vz + Math.cos(cyaw + 1.42) * (-1.5 + i * 0.36),
        0.06, cyaw + 1.42, 0.09, 12);
    }
    B.tint = null;
    B.tint = grey(0.10);
    B.cyl('rust', 0.38, 0.38, 0.12, vx + Math.sin(cyaw + 1.42) * 1.62,
      vy + 0.34, vz + Math.cos(cyaw + 1.42) * 1.62, 0.06, cyaw + 1.42, 0.09, 12);
    B.tint = null;
    L.addCollider(vx, vy + 0.34, vz, 1.7, 0.46, 0.5, 'metal', false,
      _e1.set(0, cyaw + 1.42, 0, 'YXZ'));

    // ---- the tarp over a rice dump, on hero2's approach ---------------------
    // On the bank above the wreck, so it lands in the second hero framing on
    // the same side as the black dome the critique found there. A weathered
    // orange-brown tarp over a stack of sacks: soft, warm, man-made and 2 m
    // across, which is the size of thing that shifts a hue histogram.
    // SOLVED IN THE POSE'S OWN FRAME, not guessed in world coordinates. The
    // first placement used the mark's bearing components in the wrong order and
    // put the tarp 5.4 m to the side at 3.2 m depth - i.e. 59 degrees off axis
    // and out of frame. forward is (bx, bz); screen-right is (-bz, bx).
    var HC = P.camMarks[1];
    var tw = HC.x + HC.bx * 5.2 - HC.bz * 3.0;
    var tz = HC.z + HC.bz * 5.2 + HC.bx * 3.0;
    if (L._inPlay(tw, tz) && L.sampleGround(tw, tz) > WATER_Y + 0.12) {
      var ty = L.sampleGround(tw, tz);
      var tyaw = Math.atan2(HC.bx, HC.bz) + 0.7;
      B.pushXYZ(tw, ty, tz, 0, tyaw, 0);
      // the sacks under it
      B.tint = new THREE.Color(1.06, 0.98, 0.72);
      for (i = 0; i < 6; i++) {
        B.boxR('sandbag', 0.72, 0.26, 0.46,
          rng.range(-0.55, 0.55), 0.13 + (i % 3) * 0.24, rng.range(-0.35, 0.35),
          rng.range(-0.08, 0.08), rng.range(0, 3.14), rng.range(-0.10, 0.10), 0.10);
      }
      B.tint = null;
      // the tarp: four panels sagging over them
      B.tint = new THREE.Color(1.62, 0.94, 0.52);
      for (i = 0; i < 4; i++) {
        var px2 = -0.75 + i * 0.50;
        B.boxR('canvas', 0.56, 0.03, 1.75, px2,
          0.86 - Math.abs(i - 1.5) * 0.10, 0.0,
          rng.range(-0.05, 0.05), rng.range(-0.07, 0.07),
          (i < 2 ? 0.16 : -0.16) + rng.range(-0.05, 0.05));
      }
      // the corner that has come loose and hangs
      B.boxR('canvas', 0.90, 0.03, 0.80, 0.92, 0.42, 0.72, 0.85, 0.3, 0.20);
      B.tint = null;
      // the rope holding it down and the stakes
      B.tint = grey(0.85);
      droop(B, 'rope', -1.05, 0.92, -0.85, 1.05, 0.90, 0.85, 0.10, 0.014, 5);
      for (i = -1; i <= 1; i += 2) {
        B.cyl('timber', 0.032, 0.032, 0.55, i * 1.15, 0.16, i * 0.95,
          0.22, 0.4, 0.14, 5);
      }
      B.tint = null;
      B.pop();
      L.addCollider(tw, ty + 0.45, tz, 1.15, 0.45, 1.0, 'fabric', false,
        _e1.set(0, tyaw, 0, 'YXZ'));
    }

    // ---- the bank crest, on hero2's right ------------------------------------
    // A featureless mound occupied 22% of the second hero framing at 2-4 m with
    // a perfectly clean geometric arc for a silhouette and a high-pass micro-
    // contrast of 0.042 - the untextured-mound failure this project has been
    // burned by once already. It is the ground the camera stands on so it
    // cannot be removed; it has to be BROKEN. Laterite clods torn out of the
    // crest, a slumped cut face with red subsoil showing, and mangrove prop
    // roots arching over it - all of them silhouette breakers placed on the
    // camera's flank rather than in its sightline.
    var sc = -1;
    for (i = 0; i < 22; i++) {
      var sa = rng.range(0, Math.PI * 2);
      var sr = 2.4 + Math.sqrt(rng.next()) * 5.6;
      var sx2 = HC.x + Math.sin(sa) * sr, sz2 = HC.z + Math.cos(sa) * sr;
      if (!L._inPlay(sx2, sz2)) continue;
      if (camClear(sx2, sz2, P, false) > 0.28) continue;
      var sy2 = L.sampleGround(sx2, sz2);
      if (sy2 < WATER_Y + 0.25) continue;
      sc++;
      if (sc % 4 === 3) {
        // a mangrove prop-root arch straddling the crest
        B.tint = new THREE.Color(1.10, 0.92, 0.66);
        var ma2 = rng.range(0, Math.PI * 2);
        for (var mr = 0; mr < 4; mr++) {
          var mb = ma2 + mr * 1.57 + rng.range(-0.2, 0.2);
          var reach2 = rng.range(0.7, 1.5);
          var rs2 = [];
          for (var ms = 0; ms <= 4; ms++) {
            var mt = ms / 4;
            rs2.push([Math.sin(mb) * reach2 * Math.sin(mt * Math.PI * 0.5),
              rng.range(0.75, 1.25) * (1 - mt * mt) - 0.30 * mt,
              Math.cos(mb) * reach2 * Math.sin(mt * Math.PI * 0.5),
              0.075 * (1 - mt * 0.45)]);
          }
          B.add('bark', barkTube(rs2, 5, 0.06, sc * 13 + mr),
            makeM(sx2, sy2, sz2, 0, 0, 0));
        }
        B.tint = null;
      } else {
        // a clod of raw laterite torn out of the crest
        B.tint = new THREE.Color(rng.range(1.45, 1.95), rng.range(0.88, 1.06),
          rng.range(0.44, 0.66));
        var cw2 = rng.range(0.42, 1.15);
        B.boxR('laterite', cw2, cw2 * rng.range(0.34, 0.68), cw2 * rng.range(0.6, 1.1),
          sx2, sy2 + cw2 * 0.16, sz2,
          rng.range(-0.35, 0.35), rng.range(0, 6.28), rng.range(-0.35, 0.35),
          cw2 * 0.22);
        B.tint = null;
        if (rng.bool(0.55)) {
          L.addInst('grass' + rng.int(0, 2),
            makeM(sx2 + rng.range(-0.6, 0.6), sy2, sz2 + rng.range(-0.6, 0.6),
              0, rng.range(0, 6.28), 0), rng.range(0.45, 0.95), sy2);
        }
      }
    }
  }

  // ========================================================== THE UNDERSTORY ==
  // A jittered lattice with a kind chosen from the sky-exposure field, so the
  // planting agrees with the light: elephant grass where the sky reaches the
  // floor, ferns and taro in the shade, banana and mangrove at the water,
  // bamboo in the disturbed ground along the track. A uniform random scatter of
  // one plant is on the instant-fail list and, more usefully, is the single
  // clearest tell that a forest was generated rather than grown.
  function scatterUnderstory(L, rng) {
    var P = L.plan;
    var N = L.noise;
    var i;
    // ---- CLUSTERED, NOT LATTICED -------------------------------------------
    // A 2.05 m lattice with +/-0.95 jitter is a LATTICE: the jitter is smaller
    // than the cell, so the plants can never actually touch and can never
    // actually leave a gap, and in lv_overview the mid-ground taro read as a
    // row of evenly spaced camera-facing cards. The roster's instant-fail list
    // names "props that scatter uniformly at random"; this was the mirror
    // failure - uniformly NOT at random, which reads as a grid.
    //
    // Seeds on a 5.6 m jittered lattice, 3-9 plants per seed inside 1.4 m, and
    // the plant KIND chosen once per seed so a clump is a stand of one species
    // rather than a fruit salad. Same instance budget, completely different
    // read: real patches with real bare ground between them.
    var SEED_STEP = 5.6;
    for (var gz = Z_MIN + 2; gz < Z_MAX - 2; gz += SEED_STEP) {
      for (var gx = X_MIN + 2; gx < X_MAX - 2; gx += SEED_STEP) {
        var sx0 = gx + rng.range(-2.4, 2.4);
        var sz0 = gz + rng.range(-2.4, 2.4);
        // clump strength decides how many plants this seed carries, so the
        // patchiness runs at TWO scales: the seed lattice and this field.
        var seedClump = n01(N.fbm2(sx0 * 0.185 + 71.0, sz0 * 0.185 - 33.0, 2));
        var nPl = Math.round(M.lerp(2.0, 9.0, M.saturate(seedClump * 1.35 - 0.10)));
        var nearBand = (sx0 > -30 && sx0 < 26);
        if (!nearBand) nPl = Math.round(nPl * 0.62);
        if (nPl < 1) continue;
        var seedRoll = rng.next();
        for (var pI = 0; pI < nPl; pI++) {
        var pa0 = rng.range(0, Math.PI * 2);
        var pr0 = 0.30 + Math.pow(rng.next(), 0.62) * 1.55;
        var x = sx0 + Math.sin(pa0) * pr0;
        var z = sz0 + Math.cos(pa0) * pr0;
        if (x < X_MIN + 2 || x > X_MAX - 2 || z < Z_MIN + 2 || z > Z_MAX - 2) continue;
        var rc = riverC(z), rh = riverHalf(z);
        var a = Math.abs(x - rc) / rh;
        var y = L.sampleGround(x, z);
        if (a < 1.0 && y < WATER_Y - 0.32) continue;         // under water
        var au = Math.abs(x - trackX(z));
        // 1.55 m, not 2.33. The carriageway itself stays bare; the rut lips and
        // the verge grow, which is what a cart track through forest looks like
        // and what hero1 needs in its bottom corners.
        var onRoad = au < TRACK_HALF * 0.63;
        if (onRoad) continue;
        var verge = au < TRACK_HALF * 1.05;
        var dfx = x - FB_X, dfz = z - FB_Z;
        var fbd = Math.sqrt(dfx * dfx + dfz * dfz);
        if (fbd < FB_R - 1.2) {
          // inside the wire the ground was cleared and is only now coming back
          if (rng.next() > 0.18) continue;
        }
        var clear = camClear(x, z, P, false);
        var open = skyOpen(x, z, P);
        var shore = 1 - M.smoothstep(0.9, 1.9, a);
        var kind, scale;
        // ONE ROLL PER SEED, so a clump is a STAND. The species roll used to be
        // per plant, which is why a "clump" of anything was a fern, a taro, a
        // grass and a banana standing in a metre of each other - botanically
        // impossible and, more to the point, it destroys the silhouette that
        // makes a patch read as one mass.
        var roll = seedRoll * 0.78 + rng.next() * 0.22;
        if (shore > 0.5 && roll < 0.34) {
          kind = 'banana' + rng.int(0, 1); scale = rng.range(0.72, 1.25);
        } else if (au < 7.0 && roll < 0.055) {
          kind = 'bamboo'; scale = rng.range(0.72, 1.12);
        } else if (open > 0.55) {
          kind = roll < 0.74 ? 'grass' + rng.int(0, 2)
            : (roll < 0.90 ? 'fern' + rng.int(0, 1) : 'taro' + rng.int(0, 1));
          scale = rng.range(0.78, 1.35);
        } else if (open > 0.28) {
          kind = roll < 0.40 ? 'grass' + rng.int(0, 2)
            : (roll < 0.78 ? 'fern' + rng.int(0, 1) : 'taro' + rng.int(0, 1));
          scale = rng.range(0.70, 1.15);
        } else {
          kind = roll < 0.46 ? 'fern' + rng.int(0, 1)
            : (roll < 0.86 ? 'taro' + rng.int(0, 1) : 'palm');
          scale = rng.range(0.62, 1.05);
        }
        if (kind === 'palm' && rng.next() > 0.22) kind = 'fern' + rng.int(0, 1);
        // In a sightline, or on the rut lip, only LOW ground cover survives -
        // creeping grass under half a metre, which cannot mask a subject and
        // does stop the nearest three metres of the level being bare floor.
        if (clear > 0.32 || verge) {
          kind = 'grass' + rng.int(0, 2);
          scale = rng.range(0.24, 0.46) * (1 - clear * 0.35);
        } else if (clear > 0) {
          scale *= 1 - clear * 0.85;
        }
        // Per-instance scale spread INSIDE the clump: 0.55-1.5x. Plants of one
        // species in one patch are different ages, and a stand of identical
        // silhouettes is the same tell as a lattice.
        scale *= rng.range(0.62, 1.42);
        L.addInst(kind, makeM(x, y, z, rng.range(-0.09, 0.09), rng.range(0, 6.28),
          rng.range(-0.09, 0.09)), scale, y);
        // fallen leaf litter cards where the canopy is closed
        if (rng.bool(open < 0.5 ? 0.34 : 0.20)) {
          L.litter.push([x + rng.range(-0.6, 0.6), y + 0.02, z + rng.range(-0.6, 0.6),
            rng.range(0.7, 1.7), rng.range(0, 6.28)]);
        }
        }
      }
    }

    // ---- THE NEAR FIELD OF THE SIGNATURE FRAME ------------------------------
    // hero1's foreground measured four isolated grass clumps across the whole
    // bottom of the frame with bare mud between them, because the sightline
    // cone that (correctly) keeps the SUBJECT clear was also keeping the
    // FOREGROUND clear. A first-person frame gets its depth from the near
    // field, so the cone now gets creeping cover explicitly: nothing over
    // 45 cm, clustered, planted right up to the lens and thinning out toward
    // the subject so it can never mask it.
    for (var cm = 0; cm < P.camMarks.length; cm++) {
      var CM2 = P.camMarks[cm];
      for (var ci2 = 0; ci2 < 34; ci2++) {
        var cax = rng.range(0, Math.PI * 2);
        var car = 1.0 + Math.pow(rng.next(), 0.55) * 6.5;
        var ccx = CM2.x + Math.sin(cax) * car, ccz = CM2.z + Math.cos(cax) * car;
        var nSub = rng.int(2, 5);
        for (var cj2 = 0; cj2 < nSub; cj2++) {
          var qx = ccx + rng.range(-0.8, 0.8), qz = ccz + rng.range(-0.8, 0.8);
          if (!L._inPlay(qx, qz)) continue;
          var qa = Math.abs(qx - riverC(qz)) / riverHalf(qz);
          var qy = L.sampleGround(qx, qz);
          if (qa < 1.02 || qy < WATER_Y + 0.10) continue;
          if (Math.abs(qx - trackX(qz)) < TRACK_HALF * 0.52) continue;
          // THE SIGHTLINE GETS COVER TOO - IT JUST GETS ANKLE COVER.
          // The first version of this pass planted 0.9 m elephant grass
          // straight down the hero2 corridor and buried the wreck in it, which
          // traded the level's one framing the critique said to leave alone for
          // some foreground texture. But excluding the cone entirely leaves the
          // nearest three metres of a level briefed as "dense tropical growth"
          // as bare mud in its own signature image. So the cone keeps creeping
          // grass at 0.14-0.28 scale - 15-30 cm blades, below the muzzle, which
          // cannot mask a subject at ten metres - plus flat leaf litter, which
          // cannot mask anything at all.
          var qc = camClear(qx, qz, P, false);
          L.addInst('grass' + rng.int(0, 2),
            makeM(qx, qy, qz, rng.range(-0.16, 0.16), rng.range(0, 6.28),
              rng.range(-0.16, 0.16)),
            qc > 0.26 ? rng.range(0.14, 0.28) : rng.range(0.18, 0.36), qy);
          if (rng.bool(0.55)) {
            L.litter.push([qx + rng.range(-0.5, 0.5), qy + 0.02,
              qz + rng.range(-0.5, 0.5), rng.range(0.6, 1.5),
              rng.range(0, 6.28)]);
          }
        }
      }
    }

    // ---- THE FOREGROUND LEAF -------------------------------------------------
    // hero2's best asset is a big taro blade under the lens with the river
    // running away behind it, and a scatter - however well clustered - cannot
    // be relied on to put one there. Three big leaves per hero standpoint,
    // placed in the POSE'S OWN FRAME just off the axis (forward is (bx,bz),
    // screen-right is (-bz,bx)), so they frame the subject from the bottom
    // corners instead of standing in front of it.
    var FG = [
      // [markIndex, forward, right, scale]
      [1, 1.35, -1.30, 1.55], [1, 2.30, -1.85, 1.30], [1, 1.90, 1.70, 1.15],
      [0, 1.55, -1.45, 1.45], [0, 2.40, 1.55, 1.20]
    ];
    for (i = 0; i < FG.length; i++) {
      var fg = FG[i];
      var FM = P.camMarks[fg[0]];
      if (!FM) continue;
      var fgx = FM.x + FM.bx * fg[1] - FM.bz * fg[2];
      var fgz = FM.z + FM.bz * fg[1] + FM.bx * fg[2];
      if (!L._inPlay(fgx, fgz)) continue;
      var fgy = L.sampleGround(fgx, fgz);
      if (fgy < WATER_Y + 0.06) continue;
      L.addInst(i === 2 ? 'banana0' : 'taro0',
        makeM(fgx, fgy, fgz, rng.range(-0.10, 0.10),
          Math.atan2(FM.bx, FM.bz) + rng.range(-1.2, 1.2), rng.range(-0.10, 0.10)),
        fg[3], fgy);
    }

    // ---- THE HERO2 BANK CREST -----------------------------------------------
    // A featureless mound occupied 22% of the second hero framing at 2-4 m with
    // a perfectly clean geometric arc for a silhouette and no surface
    // information on it at all. It cannot be removed - it is the ground the
    // camera stands on - so it gets DRESSED: elephant grass and mangrove prop
    // roots ON the crest to break the arc against the sky, planted on the
    // camera's own flanks where the old radial camMark had forbidden anything.
    var HC = P.camMarks[1];
    for (i = 0; i < 90; i++) {
      var ba = rng.range(0, Math.PI * 2);
      var brr = 1.6 + Math.sqrt(rng.next()) * 6.4;
      var bxp = HC.x + Math.sin(ba) * brr, bzp = HC.z + Math.cos(ba) * brr;
      if (!L._inPlay(bxp, bzp)) continue;
      if (camClear(bxp, bzp, P, false) > 0.30) continue;
      var byp = L.sampleGround(bxp, bzp);
      if (byp < WATER_Y + 0.05) continue;
      var bk = rng.next();
      L.addInst(bk < 0.62 ? 'grass' + rng.int(0, 2)
        : (bk < 0.88 ? 'fern' + rng.int(0, 1) : 'taro0'),
        makeM(bxp, byp, bzp, rng.range(-0.10, 0.10), rng.range(0, 6.28), 0),
        rng.range(0.55, 1.20), byp);
    }
    // a second, denser grass pass along the water's edge and the track verge -
    // these are the two places the camera stands, and thin ground cover under
    // the lens is the clearest possible statement that the level is a mesh
    for (i = 0; i < 420; i++) {
      var t = rng.next();
      var zz, xx;
      if (t < 0.5) {
        zz = rng.range(Z_MIN + 3, Z_MAX - 3);
        xx = riverC(zz) + (rng.bool() ? 1 : -1) * riverHalf(zz) * rng.range(1.0, 1.30);
      } else {
        zz = rng.range(Z_MIN + 3, Z_MAX - 3);
        xx = trackX(zz) + (rng.bool() ? 1 : -1) * rng.range(TRACK_HALF, TRACK_HALF + 3.4);
      }
      if (xx < X_MIN + 2 || xx > X_MAX - 2) continue;
      var yy = L.sampleGround(xx, zz);
      if (yy < WATER_Y - 0.25) continue;
      L.addInst('grass' + rng.int(0, 2),
        makeM(xx, yy, zz, rng.range(-0.06, 0.06), rng.range(0, 6.28), 0),
        rng.range(0.55, 1.30), yy);
    }
  }

  // ========================================================== THE MID-STOREY ==
  // THE HOLE IN THIS FOREST WAS BETWEEN TWO METRES AND NINE.
  //
  // The level had an understory (0-2 m, real folded-ribbon geometry) and a
  // canopy (9.5-27 m, alpha cards), and between them nothing whatever except the
  // four per cent of understory rolls that happened to survive as a palm. So at
  // eye height, past about six metres, every exterior framing looked straight
  // through bare trunks into vapour: cropped, hero1's 15-40 m band is a milky
  // pale wash with no occluding plane and almost no contrast in it, which is the
  // brief's named "flat green wash" failure arriving as a flat PALE one. A forest
  // reads as DEPTH because it has four or five overlapping planes between the
  // lens and the far field. This is the one that was missing.
  //
  // IT COSTS NO NEW DRAW CALLS, and that is the whole design of the pass. Every
  // kind in it is a kind the level already instances, planted at 1.6-3.0x scale:
  // a banana at 2.3 is a four-metre wild plantain, a fern at 2.6 is a tree fern,
  // a taro at 2.0 is a three-metre philodendron. All three are real plants of a
  // delta understory, all three are already generated, tested and merged into an
  // existing InstancedMesh, and none of them casts. The pass is pure triangles,
  // which is the budget this level actually has (3.32 M against 4.5 M).
  //
  // `tall` is passed to camClear, so this stratum may never grow inside a
  // published sightline - only beside and behind it. A four-metre plant in a
  // cone is a wall, and the level has been round that loop already.
  function scatterMidstorey(L, rng) {
    var P = L.plan;
    var N = L.noise;
    var STEP = 6.1;
    for (var gz = Z_MIN + 3; gz < Z_MAX - 3; gz += STEP) {
      for (var gx = X_MIN + 3; gx < X_MAX - 3; gx += STEP) {
        // Two scales of patchiness, exactly as the understory does it: the
        // lattice, and a field that decides how many this cell carries. A
        // mid-storey is thickets and gaps, never an even sprinkle.
        var band = n01(N.fbm2(gx * 0.088 + 51.0, gz * 0.088 - 24.0, 2));
        var nPl = Math.round(M.lerp(0.3, 4.2, M.saturate(band * 1.45 - 0.18)));
        if (nPl < 1) continue;
        for (var p = 0; p < nPl; p++) {
          var x = gx + rng.range(-2.9, 2.9);
          var z = gz + rng.range(-2.9, 2.9);
          if (!L._inPlay(x, z)) continue;
          var rc = riverC(z), rh = riverHalf(z);
          var a = Math.abs(x - rc) / rh;
          var y = L.sampleGround(x, z);
          if (a < 1.04 || y < WATER_Y + 0.12) continue;              // in the river
          if (Math.abs(x - trackX(z)) < TRACK_HALF * 1.45) continue;  // in the road
          var dfx = x - FB_X, dfz = z - FB_Z;
          if (dfx * dfx + dfz * dfz < (FB_R - 0.5) * (FB_R - 0.5)) continue;
          if (camClear(x, z, P, true) > 0.14) continue;
          // A HARD BUBBLE ROUND EVERY STANDPOINT, on top of the cone. camClear's
          // own bubble is only C.r + 1.5 (about 2.6 m) because it was sized for
          // knee-high understory; a four-metre wild plantain three metres off the
          // lens on the camera's FLANK is outside the cone and still fills a
          // quarter of the frame with one flat sheet, which is what hero2 came
          // back as. Nothing in this stratum inside six metres of a pose.
          var tooNear = false;
          for (var cm2 = 0; cm2 < P.camMarks.length; cm2++) {
            var CB2 = P.camMarks[cm2];
            var bdx = x - CB2.x, bdz = z - CB2.z;
            if (bdx * bdx + bdz * bdz < 36.0) { tooNear = true; break; }
          }
          if (tooNear) continue;
          var open = skyOpen(x, z, P);
          var roll = rng.next();
          var kind, scale;
          if (roll < 0.62) {
            // TREE FERN, and it carries the pass. A fern at 2-3x is a feathery
            // mound of 1.2-3.3 m fronds whose leaves start at the GROUND: it
            // occludes without reading as a distinct object, which is exactly what
            // a middle distance needs.
            kind = 'fern0'; scale = rng.range(1.85, 2.90);
          } else if (roll < 0.90) {
            // Wild plantain. The broadest single silhouette available and the one
            // that still reads at thirty metres through mist. 1.25-1.70, NOT
            // 1.5-2.45: bananaPlant hangs all six leaves in the top quarter of its
            // pseudostem, so at 2x it stops being a plant and becomes a rosette on
            // a bare pole - measured in hero1, a row of cabbages on sticks at six
            // metres. At 1.25-1.70 it is a 2-3 m clump, which is what it is.
            kind = 'banana0'; scale = rng.range(1.25, 1.70);
          } else if (roll < 0.95) {
            // A palm is 2040 triangles against a banana's 480 and a fern's 576, so
            // it is one in twenty rather than one in ten: it is the tallest thing
            // in the stratum and it earns its place on silhouette, not on mass, and
            // one in twenty is still ~30 of them in the delta.
            kind = 'palm'; scale = rng.range(0.72, 1.10);
          } else {
            kind = 'fern0'; scale = rng.range(2.00, 2.90);
          }
          // TARO IS NOT A MID-STOREY PLANT AT 2x. taroPlant is four leaves on
          // four long petioles, which at knee height is a plant and at two metres
          // is four flat discs on bare sticks - and that is exactly how the first
          // pass photographed in lv_overview and hero1: a field of lollipops.
          // The species that scale are the ones whose leaves start at the ground.
          // A gap grows a thicket; deep shade grows the shade-tolerant ones
          // smaller. This is the only place openness enters, and it is a SIZE
          // term rather than a species one - the species are all understory
          // plants and all of them occur under a closed roof.
          scale *= 0.86 + 0.26 * open;
          L.addInst(kind, makeM(x, y, z, rng.range(-0.11, 0.11),
            rng.range(0, 6.28), rng.range(-0.11, 0.11)), scale, y + 2.4);
        }
      }
    }
  }

  // ============================================================== THE LITTER ==
  // DEPOSITION, NOT SCATTER. Leaf litter collects; it does not distribute. The
  // seeds sit on a 3.4 m jittered lattice weighted by how CLOSED the roof above
  // them is - a leaf falls out of a canopy, so there is none where there is no
  // canopy - and by the same macro field buildGround's own litter drift and
  // buildFloorLight's warm mass are painted from, so the geometry lands ON the
  // drift the floor already has rather than beside it.
  //
  // It is allowed on the track and inside the wire on purpose: leaves blow into
  // a rut and pile against a sandbag, and a flat 4 cm leaf cannot mask a subject
  // at any range, so this is the one planting pass with no sightline exclusion at
  // all. That is exactly why it can fix the near field of a published framing.
  function scatterLitter(L, rng) {
    var P = L.plan;
    var N = L.noise;
    var i;

    function put(x, z, s) {
      if (!L._inPlay(x, z)) return;
      if (Math.abs(x - riverC(z)) / riverHalf(z) < 1.02) return;
      var y = L.sampleGround(x, z);
      if (y < WATER_Y + 0.06) return;
      L.addInst('deadleaf', makeM(x, y + 0.012, z,
        rng.range(-0.055, 0.055), rng.range(0, 6.28), rng.range(-0.055, 0.055)),
        s, y);
    }

    var STEP = 3.4;
    for (var gz = Z_MIN + 2; gz < Z_MAX - 2; gz += STEP) {
      for (var gx = X_MIN + 2; gx < X_MAX - 2; gx += STEP) {
        var sx = gx + rng.range(-1.5, 1.5), sz = gz + rng.range(-1.5, 1.5);
        var open = skyOpen(sx, sz, P);
        var drift = M.smoothstep(0.30, 0.70,
          n01(N.fbm2(sx * 0.145 + 11.0, sz * 0.145 - 6.0, 3)));
        // MEASURED AND DOUBLED. At (0.28 + 0.72 * (1 - open)) the open ground got
        // nothing: hero2 stands on a bank crest where skyOpen is 1.0, so the pass
        // put 0-1 drifts in a 3.4 m cell and the mound came back as the same
        // uniform granular carpet it had been, only green instead of ochre. Open
        // ground in a delta is not swept clean - it is where flood debris and
        // wind-blown leaf ends up - so the openness term is a bias now, not a gate.
        // 0.36, between the 0.28 that left the open ground bare and the 0.46 that
        // put isolated bright flecks all over the firebase field. A cleared field
        // of fire is swept and trodden; a closed forest floor is buried.
        var dens = (0.30 + 0.70 * drift) * (0.36 + 0.64 * (1 - open));
        var nn = Math.round(M.lerp(0, 5.6, dens));
        for (i = 0; i < nn; i++) {
          put(sx + rng.range(-1.7, 1.7), sz + rng.range(-1.7, 1.7),
            rng.range(0.70, 1.55));
        }
      }
    }

    // ---- AND THICKEST RIGHT UNDER THE LENS ----------------------------------
    // The nearest three metres of hero1 and hero2 are bare ochre grain, because
    // the sightline cone that correctly keeps the SUBJECT clear was also the only
    // thing standing between the camera and the floor. Litter has no height, so
    // it is the one thing that can go there.
    for (var cm = 0; cm < P.camMarks.length; cm++) {
      var CM = P.camMarks[cm];
      // 300, not 110. A drift is about 0.09 m2 of coverage, so 110 over a disc of
      // 190 m2 is five per cent - i.e. arithmetically incapable of changing what
      // the floor under the lens looks like. 300 out to 8.5 m is the density at
      // which the near field stops being ground with objects on it and starts
      // being a forest floor.
      for (i = 0; i < 300; i++) {
        var la = rng.range(0, Math.PI * 2);
        var lr = 0.6 + Math.pow(rng.next(), 0.55) * 8.5;
        put(CM.x + Math.sin(la) * lr, CM.z + Math.cos(la) * lr,
          rng.range(0.80, 1.70));
      }
    }
  }

  // ================================================================ THE ROOF ==
  // THE CANOPY IS A LAYER, NOT A DECORATION ON THE TREES.
  //
  // The first build hung five clusters off each trunk's branches and called
  // that a canopy. Measured, that is about 450 blobs over sixteen thousand
  // square metres - one every 37 m2 - so the sky came straight through, the top
  // half of every framing was blown white overcast, and the level read as a
  // flooded pole forest rather than as jungle. A closed canopy is the single
  // most important thing in this brief and it has to be built as its own
  // stratum, on its own lattice, with its own holes.
  //
  // The holes are the point of the whole level: density is 1 - skyOpen, so the
  // roof closes over the forest and opens exactly where the river, the track,
  // the clearings and the firebase are - which is where the shafts land, where
  // the ground is painted bright, and where every published framing looks.
  //
  // It costs almost nothing: ~1700 blobs at 16 two-triangle cards is 55k
  // triangles, against the 2.4 M the understory spends on real leaf geometry.
  // A CARD DEEP INSIDE A CLUSTER IS IN SHADE, AND NOTHING WAS SAYING SO.
  // Every canopy card rendered at one value over its whole area with no
  // self-shadowing between overlapping clusters, so the roof - 35-40% of every
  // exterior frame - read as a sheet of flat painted cut-outs with neighbours
  // jumping from near-black to near-white and nothing in between. That is
  // CARD-level lighting where the eye wants LEAF-level.
  //
  // The fix is a two-pass scatter: collect every card first, then darken each
  // one by how many others sit within 1.6 m AND ABOVE it. A card under six
  // neighbours loses 45%; a card on the sunlit outside of the crown loses
  // nothing. It costs one array and an O(n) bucket pass at build time and
  // nothing at all per frame, and it is the difference between a canopy that
  // has a top and a bottom and one that does not.
  function scatterCanopy(L, rng) {
    var P = L.plan;
    var step = 2.85;
    var pad = 10;
    var cards = [];
    function card(kind, x, y, z, rx, ry, rz, s, shadeY) {
      cards.push([kind, x, y, z, rx, ry, rz, s, shadeY]);
    }
    for (var gz = Z_MIN - pad; gz < Z_MAX + pad; gz += step) {
      for (var gx = X_MIN - pad; gx < X_MAX + pad; gx += step) {
        var x = gx + rng.range(-1.5, 1.5);
        var z = gz + rng.range(-1.5, 1.5);
        var cx = M.clamp(x, X_MIN, X_MAX), cz = M.clamp(z, Z_MIN, Z_MAX);
        var gy = L.sampleGround(cx, cz);
        var open = skyOpen(cx, cz, P);
        // Outside the play area the roof is solid: that is the level's horizon
        // and it must not have a visible edge in it.
        var outside = (x < X_MIN + 2 || x > X_MAX - 2 || z < Z_MIN + 2 || z > Z_MAX - 2);
        var dens = outside ? 1.0 : (1 - open * 0.94);
        // HARD exclusion of the inner base, not a probability. The firebase was
        // CUT out of the forest, so nothing overhangs it - and the overview
        // framing stands on the tower platform inside it, where a six-per-cent
        // chance of a blob was enough to hang a nine-metre leaf card two metres
        // in front of the establishing shot's lens.
        //
        // BUT THE FOREST STILL ARCHES OVER THE EDGE OF THE CUT, and the level was
        // saying otherwise out to 20 m plus everything skyOpen > 0.80 covered -
        // about 30 m. hero3 stands 9.8 m off the base's centre looking across it,
        // so its canopy horizon fell just below the top of the frame and the upper
        // sixth of the level's third hero framing was bare blown overcast with the
        // watchtower silhouetted against it. The pose's own comment says the
        // canopy standing behind the tower is the point, "because a tower
        // photographed against sky could be anywhere".
        //
        // So: the mid and low tiers keep the hard exclusion (they sit at the
        // tower platform's own height, and one of them is what hung the card in
        // front of the establishing shot), and the HIGH tier comes back in the
        // ring from 18 m out at 42% density and 21-30 m up - five to fifteen
        // metres above the tower roof, and far enough out that a 4.5 m card
        // half-extent still cannot reach the platform.
        // ---- AND THE CROWNS LEAN OUT OVER THE RIVER ---------------------------
        // skyOpen is 1.0 across the whole channel, so dens fell to 0.06 and the
        // roof simply stopped at the water. That is right for the CENTRE - the
        // open channel is the level's one bright floor and its band of reflected
        // cloud - and wrong for the edges: a 26 m creek through primary forest has
        // 25 m crowns arching out over both banks, and without them hero1's
        // upper-left corner (which looks over the east bank toward the water) is a
        // blown pale wash with 42% flat area in it, and the establishing shot's
        // canopy horizon has a hole in it.
        //
        // High tier only, and only from 0.95 of the half-width outward, so the
        // channel keeps its sky and the water keeps its reflection.
        var rvA = Math.abs(cx - riverC(cz)) / riverHalf(cz);
        var rvEdge = !outside && rvA > 0.95 && rvA < 1.40;
        var fbRing = false;
        if (!outside) {
          var fdx = x - FB_X, fdz = z - FB_Z;
          var fd2 = fdx * fdx + fdz * fdz;
          if (fd2 < 18.0 * 18.0) continue;
          if (fd2 < (FB_R + 10.0) * (FB_R + 10.0)) {
            if (rng.next() > 0.42) continue;
            fbRing = true;
          } else if (rvEdge) {
            if (rng.next() > 0.55) continue;
          } else if (open > 0.80) continue;
        }
        if (!fbRing && !rvEdge && rng.next() > dens) continue;
        // High tier - the roof. 17-27 m, not 13.5-23: the nearest cards in a
        // 75-degree framing were 8-12 m from the lens, which is close enough to
        // read an individual leaf on them. Raising the deck four metres puts the
        // nearest at 12-16 m and, together with the leaf-size fix above, drops
        // what one leaf subtends from 8-10 degrees to about 2.
        // In the firebase ring the deck goes up nine metres, so the cut's own
        // canopy horizon stands clear above the watchtower roof rather than
        // level with it.
        card('canopy' + (rng.next() < 0.34 ? 0 : (rng.next() < 0.5 ? 1 : 2)),
          x, gy + (fbRing ? rng.range(21.0, 30.0) : rng.range(17.0, 27.0)), z,
          rng.range(-0.25, 0.25), rng.range(0, 6.28), rng.range(-0.25, 0.25),
          rng.range(1.00, 1.70), gy + (fbRing ? 25 : 22));
        // mid tier - the thing that was missing between the understory and the
        // roof, and the reason the middle distance was nothing but bare poles.
        // 0.52, not 0.34: with the shadow budget freed up this is the cheapest
        // depth cue in the level - two triangles a card, no shadow pass, and it
        // is what puts a fourth and fifth plane between the trunk at 12 m and
        // the fog at 60.
        if (!fbRing && !rvEdge && rng.bool(0.52)) {
          card('canopy' + (rng.next() < 0.6 ? 2 : 1),
            x + rng.range(-2.0, 2.0), gy + rng.range(9.5, 15.0),
            z + rng.range(-2.0, 2.0),
            rng.range(-0.35, 0.35), rng.range(0, 6.28), rng.range(-0.35, 0.35),
            rng.range(0.75, 1.35), gy + 10);
        }
        // a dead frond caught on the way down, and a hanging liana, only under
        // the closed part of the roof
        if (!fbRing && !rvEdge && !outside && open < 0.4 && rng.bool(0.05)) {
          card('canopy2',
            x + rng.range(-1.5, 1.5), gy + rng.range(3.5, 6.5),
            z + rng.range(-1.5, 1.5), rng.range(-0.6, 0.6), rng.range(0, 6.28), 0,
            rng.range(0.5, 0.9), gy + 5);
        }
      }
    }

    // ---- the occlusion pass -------------------------------------------------
    // Bucketed on a 3.2 m grid so the neighbour test is O(n) rather than
    // O(n^2): ~2400 cards against a 38 x 39 lattice is a couple of dozen
    // candidates each.
    var CB = 3.2;
    var bx0 = X_MIN - pad - 4, bz0 = Z_MIN - pad - 4;
    var bw = Math.ceil(((X_MAX - X_MIN) + pad * 2 + 8) / CB) + 1;
    var bh = Math.ceil(((Z_MAX - Z_MIN) + pad * 2 + 8) / CB) + 1;
    var buckets = new Array(bw * bh);
    var ci, cj, k2;
    for (ci = 0; ci < cards.length; ci++) {
      var cc = cards[ci];
      var bi = M.clamp(Math.floor((cc[1] - bx0) / CB), 0, bw - 1);
      var bj = M.clamp(Math.floor((cc[3] - bz0) / CB), 0, bh - 1);
      k2 = bj * bw + bi;
      (buckets[k2] || (buckets[k2] = [])).push(ci);
    }
    for (ci = 0; ci < cards.length; ci++) {
      var C0 = cards[ci];
      var gi = M.clamp(Math.floor((C0[1] - bx0) / CB), 0, bw - 1);
      var gj = M.clamp(Math.floor((C0[3] - bz0) / CB), 0, bh - 1);
      var above = 0;
      for (var oj = -1; oj <= 1; oj++) {
        for (var oi = -1; oi <= 1; oi++) {
          var qi = gi + oi, qj = gj + oj;
          if (qi < 0 || qj < 0 || qi >= bw || qj >= bh) continue;
          var bk = buckets[qj * bw + qi];
          if (!bk) continue;
          for (cj = 0; cj < bk.length; cj++) {
            if (bk[cj] === ci) continue;
            var C1 = cards[bk[cj]];
            if (C1[2] <= C0[2] + 0.35) continue;        // must be ABOVE
            var ddx = C1[1] - C0[1], ddz = C1[3] - C0[3];
            if (ddx * ddx + ddz * ddz > 2.56) continue;  // within 1.6 m
            above++;
            if (above >= 8) break;
          }
          if (above >= 8) break;
        }
        if (above >= 8) break;
      }
      var occ = 1 - 0.45 * M.saturate(above / 6);
      L.addInst(C0[0], makeM(C0[1], C0[2], C0[3], C0[4], C0[5], C0[6]),
        C0[7], C0[8], occ);
    }
  }

  // Standing water, laid where water actually stands: in the two wheel ruts of
  // the track, in the boot-churned ground at the gate and the bridge lip, and in
  // any hollow the heightfield has cut. Each one is a small flat quad sunk to
  // the LOWEST of its four corners so it never floats out of its own rut.
  function buildPuddles(L, B, rng) {
    var P = L.plan;
    var n = 0;
    function pool(x, z, w, d, yaw) {
      if (!L._inPlay(x, z)) return;
      var c = Math.cos(yaw), s = Math.sin(yaw);
      var lo = 1e9, i;
      for (i = 0; i < 4; i++) {
        var ox = (i & 1 ? 1 : -1) * w * 0.5, oz = (i & 2 ? 1 : -1) * d * 0.5;
        var y = L.sampleGround(x + ox * c + oz * s, z - ox * s + oz * c);
        if (y < lo) lo = y;
      }
      if (lo < WATER_Y + 0.05) return;               // that is the river
      B.tint = grey(rng.range(0.80, 1.25));
      B.add('puddle', quad(w, d), makeM(x, lo + 0.022, z, -Math.PI * 0.5, yaw, 0));
      B.tint = null;
      n++;
    }
    // the two wheel ruts, down the track and no further than the gate
    for (var z = Z_MAX - 8; z > -8; z -= 2.15) {
      var tx = trackX(z);
      var yaw = Math.atan2(trackX(z - 2) - trackX(z + 2), -4);
      for (var k = -1; k <= 1; k += 2) {
        if (rng.next() > 0.62) continue;
        pool(tx + k * 0.95 + rng.range(-0.10, 0.10), z + rng.range(-0.4, 0.4),
          rng.range(0.42, 0.62), rng.range(0.9, 2.2), yaw);
      }
      // and the churned middle, where the wheels have thrown it up
      if (rng.bool(0.24)) {
        pool(tx + rng.range(-0.45, 0.45), z + rng.range(-0.6, 0.6),
          rng.range(0.5, 1.1), rng.range(0.5, 1.0), yaw + rng.range(-0.5, 0.5));
      }
    }
    // the trodden ground at the gate, the bridge lip and the shrine
    var spots = [[P.gate.x, P.gate.z], [P.bridge.x, P.bridge.nearZ + 1.4],
      [P.shrine.x - 1.7, P.shrine.z], [P.mortar.x - 2.2, P.mortar.z + 2.0],
      [P.helipad.x - 4.0, P.helipad.z + 3.2]];
    for (var i = 0; i < spots.length; i++) {
      for (var j = 0; j < 4; j++) {
        pool(spots[i][0] + rng.range(-2.2, 2.2), spots[i][1] + rng.range(-2.2, 2.2),
          rng.range(0.5, 1.5), rng.range(0.5, 1.4), rng.range(0, 6.28));
      }
    }

    // ---- STANDING WATER IN EVERY HOLLOW -------------------------------------
    // It is a monsoon delta under active drizzle and the only standing water in
    // fifteen thousand square metres was in the wheel ruts. A puddle is the one
    // thing on a forest floor that carries the SKY'S value, so it is the only
    // thing that can make a dark floor read as dark rather than as
    // underexposed - and at two triangles each on a material that is already
    // one draw call for the whole level, it is the cheapest quality in the
    // file. Placed where water actually stands: local minima of the
    // heightfield, tested against the four corners the pool() helper already
    // samples, so nothing ever floats out of its own hollow.
    for (i = 0; i < 620; i++) {
      var px = rng.range(X_MIN + 4, X_MAX - 4);
      var pz = rng.range(Z_MIN + 4, Z_MAX - 4);
      var pyc = L.sampleGround(px, pz);
      if (pyc < WATER_Y + 0.20) continue;                 // that is the river
      // concavity: the centre has to sit below the mean of a 1.6 m ring
      var ring = 0;
      for (var q = 0; q < 6; q++) {
        var qa = q * 1.047;
        ring += L.sampleGround(px + Math.sin(qa) * 0.8, pz + Math.cos(qa) * 0.8);
      }
      if (pyc > ring / 6 - 0.012) continue;
      pool(px, pz, rng.range(0.45, 1.55), rng.range(0.40, 1.35),
        rng.range(0, 6.28));
    }
    void n;
  }

  function buildGroundMarks(L, B, rng) {
    var i, k;
    // Tyre ruts down the track, and the track STOPS AT THE GATE. Running them
    // to z = -20 laid rut cards straight across the middle of the firebase
    // plateau, where nothing has ever driven, in the establishing shot.
    for (var z = Z_MAX - 6; z > -7.5; z -= 1.9) {
      var tx = trackX(z);
      var yaw = Math.atan2(trackX(z - 2) - trackX(z + 2), -4);
      for (k = -1; k <= 1; k += 2) {
        var rx = tx + k * 0.95 + rng.range(-0.10, 0.10);
        markCard(B, MARK.tread, rx, L.sampleGround(rx, z) + 0.016, z,
          0.62, 2.1, yaw, grey(rng.range(0.80, 1.10)));
      }
    }
    // boot traffic at the gate, the bridge and the shrine
    var walks = [
      [L.plan.gate.x, L.plan.gate.z, 0.2],
      [L.plan.bridge.x, L.plan.bridge.nearZ + 1.0, 3.1],
      [L.plan.shrine.x - 1.6, L.plan.shrine.z, 1.6]
    ];
    for (i = 0; i < walks.length; i++) {
      var sx = walks[i][0], sz = walks[i][1], dir = walks[i][2];
      for (k = 0; k < 22; k++) {
        dir += rng.gaussian(0, 0.17);
        sx += Math.sin(dir) * 0.62; sz += Math.cos(dir) * 0.62;
        if (sx < X_MIN + 2 || sx > X_MAX - 2 || sz < Z_MIN + 2 || sz > Z_MAX - 2) break;
        markCard(B, MARK.boot, sx, L.sampleGround(sx, sz) + 0.018, sz,
          0.17, 0.32, dir, grey(rng.range(0.85, 1.10)));
      }
    }
    // The leaf drift under closed canopy - the STAIN the real fallen-leaf
    // geometry stands on (see deadLeaves / scatterLitter). Tinted warm rather
    // than neutral so the painted drift and the modelled leaves agree: with a
    // neutral tint the card took its hue from the atlas alone and the two read as
    // two different materials lying on top of each other.
    for (i = 0; i < L.litter.length; i++) {
      var lt = L.litter[i];
      markCard(B, MARK.litter, lt[0], lt[1], lt[2], lt[3], lt[3], lt[4],
        new THREE.Color(rng.range(1.18, 1.52), rng.range(0.88, 1.06),
          rng.range(0.48, 0.74)));
    }
    // algal scum along both banks
    for (i = 0; i < 210; i++) {
      var zz = rng.range(Z_MIN + 2, Z_MAX - 2);
      var side = rng.bool() ? 1 : -1;
      var xx = riverC(zz) + side * riverHalf(zz) * rng.range(0.94, 1.10);
      if (xx < X_MIN + 1 || xx > X_MAX - 1) continue;
      var yy = L.sampleGround(xx, zz);
      markCard(B, MARK.scum, xx, yy + 0.02, zz, rng.range(1.6, 3.4),
        rng.range(1.6, 3.4), rng.range(0, 6.28),
        new THREE.Color(rng.range(0.8, 1.15), rng.range(0.9, 1.2), rng.range(0.7, 1.0)));
    }
  }

  // ================================================================== LEVEL ==
  function LevelJungle(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level_jungle';
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
    this.litter = [];
    this._inst = Object.create(null);
    this._matCache = Object.create(null);
    this._atlas = null;
    this._bladeSet = null;
    this._barkSet = null;
    this._markTex = null;
    this._litMat = null;
    this._litMat2 = null;
    this._clock = { value: 0 };
    this._hash = new GAME.SpatialHash(5.0);
    this._stamp = 0;
    this._t = 0;

    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x4A554E47) : new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x3E17A9) >>> 0);
    // min.y is -4, one metre under the deepest point of the river bed, and it
    // is NOT slack. lighting.js maps its sky-visibility volume as a fixed 26 m
    // slab starting at bounds.min.y, and svTrace returns -1 immediately for a
    // ray that starts outside it - so a generous -14 here put every canopy-gap
    // shaft origin above the lattice and _solveShaft silently returned null for
    // all four. The level's one lighting event, deleted by a bounding box.
    this.bounds = new THREE.Box3(
      new THREE.Vector3(X_MIN - 8, -4.0, Z_MIN - 8),
      new THREE.Vector3(X_MAX + 8, 42, Z_MAX + 8));

    // The survey. Available the instant the level is constructed, so
    // props_jungle never waits for build() and never reads a camera pose.
    this.plan = plan({ noise: this.noise, rng: this.rng.fork(0x504C41) });
    this.anchors = buildAnchors(this.plan, this);

    // ---- THE FOLIAGE KIT, published ----------------------------------------
    // props_jungle has to dress this set with plants, and there is exactly one
    // way that can go wrong: it authors a second green. Two foliage recipes in
    // one level is the same defect as two grades in one level - the eye reads
    // the seam instantly and there is no lighting fix for it. So the level
    // hands over its own materials, its atlas cell table and the two generators
    // that made every leaf in it. Anything props grows out of these is the same
    // plant as the ones already standing next to it.
    var self = this;
    this.foliage = {
      canopyMaterial: function () { return self.material('canopy'); },
      bladeMaterial: function () { return self.material('blade'); },
      barkMaterial: function () { return self.material('bark'); },
      markMaterial: function () { return self.material('mark'); },
      litMaterial: function () { return self.material('lit'); },
      CELL: CELL, atlasUV: atlasUV, cardGeo: cardGeo,
      MARK: MARK, markUV: markUV,
      blade: blade, tube: tube,
      grassClump: grassClump, fernPlant: fernPlant, taroPlant: taroPlant,
      bananaPlant: bananaPlant, palmCrown: palmCrown, canopyCluster: canopyCluster
    };
  }

  function buildAnchors(P, L) {
    function V(x, y, z) { return new THREE.Vector3(x, y, z); }
    var A = {};
    A.delta = {
      x0: X_MIN, x1: X_MAX, z0: Z_MIN, z1: Z_MAX, waterY: WATER_Y,
      wind: new THREE.Vector2(WIND_X, WIND_Z),
      riverC: riverC, riverHalf: riverHalf, trackX: trackX,
      groundY: function (x, z) { return L.sampleGround(x, z); },
      skyOpen: function (x, z) { return skyOpen(x, z, P); }
    };
    A.river = {
      waterY: WATER_Y,
      centre: function (z) { return V(riverC(z), WATER_Y, z); },
      half: riverHalf,
      eastEdge: function (z) { return V(riverC(z) + riverHalf(z), WATER_Y, z); },
      westEdge: function (z) { return V(riverC(z) - riverHalf(z), WATER_Y, z); }
    };
    A.track = {
      half: TRACK_HALF, shoulder: TRACK_SHOULDER, pts: TRACK_PTS,
      centre: function (z) { return V(trackX(z), L.sampleGround(trackX(z), z), z); }
    };
    A.spawn = { position: V(trackX(56), 0, 56), yaw: 0 };
    A.clearings = [];
    for (var i = 0; i < P.clearings.length; i++) {
      A.clearings.push({ centre: V(P.clearings[i].x, 0, P.clearings[i].z),
        r: P.clearings[i].r, open: P.clearings[i].open });
    }
    A.firebase = {
      centre: V(P.firebase.x, P.firebase.y, P.firebase.z), yaw: P.firebase.yaw,
      radius: P.firebase.r, topY: P.firebase.y,
      gate: V(P.gate.x, P.gate.y, P.gate.z),
      gateBearing: P.firebase.gateB, breachBearing: P.firebase.breachB,
      mortarPit: V(P.mortar.x, P.mortar.y, P.mortar.z),
      helipad: { centre: V(P.helipad.x, P.helipad.y, P.helipad.z),
        r: P.helipad.r, yaw: P.helipad.yaw },
      mast: V(P.mast.x, P.mast.y, P.mast.z),
      drum: V(P.drum.x, P.drum.y, P.drum.z),
      shelter: V(P.shelter.x, P.shelter.y, P.shelter.z),
      local: P.fbW
    };
    A.bunker = {
      centre: V(P.bunker.x, P.bunker.y, P.bunker.z), yaw: P.bunker.yaw,
      w: P.bunker.w, d: P.bunker.d,
      floorY: P.bunker.y - P.bunker.sink, roofY: P.bunker.y - P.bunker.sink + 2.62
    };
    A.tower = {
      base: V(P.tower.x, P.tower.y, P.tower.z), yaw: P.tower.yaw,
      legR: P.tower.legR, platformY: P.tower.y + P.tower.platY,
      roofY: P.tower.y + P.tower.roofY
    };
    A.heli = {
      centre: V(P.heli.x, P.heli.y, P.heli.z), yaw: P.heli.yaw,
      roll: P.heli.roll, pitch: P.heli.pitch
    };
    A.creek = {
      half: CREEK_HALF, depth: CREEK_DEPTH, centreZ: creekZ,
      bridge: { centre: V(P.bridge.x, P.bridge.y, P.bridge.z),
        nearLip: V(P.bridge.x, P.bridge.y, P.bridge.nearZ),
        farLip: V(P.bridge.x, P.bridge.y, P.bridge.farZ),
        w: P.bridge.w, deckY: P.bridge.y }
    };
    A.sluice = { centre: V(P.sluice.x, P.sluice.y, P.sluice.z), yaw: P.sluice.yaw,
      w: P.sluice.w, h: P.sluice.h };
    A.shrine = { centre: V(P.shrine.x, P.shrine.y, P.shrine.z), yaw: P.shrine.yaw,
      postH: P.shrine.h };
    A.outcrop = { centre: V(P.outcrop.x, P.outcrop.y, P.outcrop.z), r: P.outcrop.r };
    A.trees = [];
    for (i = 0; i < P.trees.length; i++) {
      var T = P.trees[i];
      A.trees.push({ centre: V(T.x, T.y, T.z), r: T.r, height: T.h,
        canopyY: T.y + T.h * 0.72, buttress: T.bh, shattered: !!T.shattered });
    }
    A.logs = [];
    for (i = 0; i < P.logs.length; i++) {
      A.logs.push({ a: V(P.logs[i].ax, P.logs[i].ay, P.logs[i].az),
        b: V(P.logs[i].bx, P.logs[i].by, P.logs[i].bz), r: P.logs[i].r });
    }
    A.mangroves = [];
    for (i = 0; i < P.mangroves.length; i++) {
      A.mangroves.push({ centre: V(P.mangroves[i].x, P.mangroves[i].y, P.mangroves[i].z),
        r: P.mangroves[i].r, height: P.mangroves[i].h });
    }
    return A;
  }

  // ---- materials, defensively -----------------------------------------------
  LevelJungle.prototype.material = function (key) {
    if (this._matCache[key]) return this._matCache[key];
    var surf = SURF[key] || SURF.mud;
    var m = null;
    try {
      if (surf.own === 'mud') m = this._mudMaterial(false);
      else if (surf.own === 'silt') m = this._mudMaterial(true);
      else if (surf.own === 'water') m = this._waterMaterial();
      else if (surf.own === 'bark') m = this._barkMaterial();
      else if (surf.own === 'blade') m = this._foliageMaterial(false);
      else if (surf.own === 'canopy') m = this._foliageMaterial(true);
      else if (surf.own === 'lit') m = this._litMaterial(false);
      else if (surf.own === 'lit2') m = this._litMaterial(true);
      else if (surf.own === 'mark') m = this._markMaterial();
      else if (surf.own === 'puddle') m = this._puddleMaterial();
      else {
        var lib = this.ctx && this.ctx.materials;
        var name = surf.base || 'concrete';
        var has = false;
        try { has = !!(lib && typeof lib.has === 'function' && lib.has(name)); }
        catch (e) { has = false; }
        if (lib && typeof lib.get === 'function' && has) {
          var opts = { vertexColors: true, wearMode: 'multiply' };
          if (surf.env !== undefined) opts.envMapIntensity = surf.env;
          if (surf.metalness !== undefined) opts.metalness = surf.metalness;
          // genRustedMetal's own mean is 0.067 linear luminance - the albedo of
          // WET COAL, not of rust. Re-solving it to 0.121 is what stops every
          // drum, mast and culvert in the level reading as a black cut-out
          // against a 0.11 floor.
          if (surf.alb !== undefined) opts.albedoTarget = surf.alb;
          m = lib.get(name, opts);
        }
      }
    } catch (e2) {
      GAME.logError('jungle.material:' + key, e2);
      m = null;
    }
    if (!m || !m.isMaterial) m = this._fallbackMaterial(key);
    this._matCache[key] = m;
    return m;
  };

  LevelJungle.prototype._fallbackMaterial = function (key) {
    var fb = FALLBACK[key] || FALLBACK.mud;
    var surf = SURF[key] || SURF.mud;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2], vertexColors: true,
      envMapIntensity: surf.env !== undefined ? surf.env : 1.0
    });
    m.name = 'jungle_fallback_' + key;
    return m;
  };

  // THE FOREST FLOOR. materials.js's `dirt` is a world-projected triplanar with
  // a real meso band, which is exactly what a churned mud floor wants - what it
  // does NOT have is the colour, because it was authored as warm desert soil.
  // albedoTarget re-solves its per-channel gain so the mean lands on the same
  // dark leaf-litter olive that sky.js is already using for this level's ground
  // bounce (GROUND_ALBEDO_BY_LEVEL.jungle = [0.085 0.120 0.062]); a warm brown
  // floor here would disagree with the IBL that is lighting it.
  LevelJungle.prototype._mudMaterial = function (silt) {
    var lib = this.ctx && this.ctx.materials;
    if (!lib || typeof lib.get !== 'function') return null;
    // The wet contract needs its ripple field, and this level is not one of the
    // ids materials.js turns it on for, so ask for it explicitly.
    try { if (typeof lib.rippleTexture === 'function') lib.rippleTexture(); }
    catch (e) { /* the puddles simply stay flat */ }
    var m = lib.get('dirt', {
      vertexColors: true, wearMode: 'multiply',
      // 0x526146, SOLVED rather than picked. sky.js bounces this level's IBL
      // off GROUND_ALBEDO_BY_LEVEL.jungle = [0.085 0.120 0.062] LINEAR, and
      // 0x545f38 decodes to [0.0975 0.1170 0.0382] - a 2.55:1 red/blue ratio
      // against the solve's 1.37:1. The floor was therefore both brighter and
      // very much warmer than the light it was supposedly bouncing, and every
      // multiplicative warm term above it started from a red bias it did not
      // know about. 0x526146 decodes to [0.085 0.120 0.062] exactly.
      albedoTarget: silt ? 0x63694c : 0x526146,
      hue: 1.0,
      wet: true, puddle: silt ? 0.30 : 0.52,
      // genDirt's crazing is a fixed feature of the map, so the only control
      // over how it reads is the world scale it is projected at. At 1 tile/m
      // the cracks are 20 cm and print as a net of cells right under the lens;
      // at 2.1 they are 9 cm and read as wet soil grain, which is what a
      // rained-on forest floor actually looks like.
      // triScale 2.55, not 1.35. genDirt's crazing is a fixed feature of the
      // map, so the only control over how it reads is the world scale it is
      // projected at, and at 1.35 the cracks are 15 cm - a net of cells the eye
      // counts from the lens to the fog, which is exactly the "one ground
      // texture at one scale over fifteen thousand square metres" finding. At
      // 2.55 they are 8 cm and read as wet soil grain. The MACRO band that
      // carries the scales above that is pushed out to 17 / 4.5 / 1.4 / 0.36 m
      // so the floor has structure at every scale between 8 cm and 17 m, which
      // it previously had at none.
      detail: 0.42, macro: 1.0, macroScale: 0.22, parallax: 0.006,
      triScale: 2.55, envMapIntensity: 0.85
    });
    // genDirt is authored as sun-cracked desert soil and its normal map draws
    // a hard crazing pattern that reads as dragon skin on a wet forest floor -
    // and, tiled at one metre under the lens, as the single most obvious
    // repeat in the frame. Halving the normal keeps the meso relief that makes
    // puddles sit in hollows and drops the crazing to a damp mottle.
    try { if (m.normalScale) m.normalScale.set(0.42, 0.42); }
    catch (e2) { /* fallback material has none */ }
    // THE FLOOR LIGHT BAKE. Only the walkable floor gets it - the silt variant
    // is the river bed and is under water. See buildFloorLight().
    if (!silt) {
      try {
        var lm = buildFloorLight(this);
        // MEASURED, TWICE. lightMap is ADDED to irradiance and this build works
        // in PHOTOMETRIC units - the shafts are published in lux and the level's
        // open floor collects of order fifty of them. At the 1.25 and 3.2 that
        // look like sensible numbers for a 0..1 map the whole bake moved the
        // floor by under two per cent, which an A/B against a SOLID RED map
        // confirmed: the plumbing was right and the magnitude was three orders
        // of nothing. LIGHTMAP_LUX is quoted in the same units as the shafts.
        if (lm) { m.lightMap = lm; m.lightMapIntensity = LIGHTMAP_LUX; this._floorLight = lm; }
      } catch (e3) { GAME.logError('jungle.floorLight', e3); }
    }
    return m;
  };

  LevelJungle.prototype._waterMaterial = function () {
    var lib = this.ctx && this.ctx.materials;
    if (!lib || typeof lib.water !== 'function') return null;
    // A delta river is silt, not sea: it absorbs BLUE hardest (the sea absorbs
    // red), so the transmitted colour is brown-green and the surface takes
    // nearly all its value from the sky it reflects. That reflection is why the
    // river is the brightest floor in the level and why it can carry the bottom
    // half of a framing on its own.
    // MEASURED: THE RIVER WAS DARKER THAN TAR. This file's own header calls the
    // channel "the level's only open sky and therefore its only bright floor: a
    // horizontal band of reflected cloud low in every framing that looks west",
    // and hero2's near water measured a median of 0.040 linear luminance against
    // 0.254 for the vapour directly above it - two and two-thirds stops the WRONG
    // WAY for a near-mirror at 9 degrees of incidence. The planar pass is on and
    // is working (there is real structure and a real specular lane), but its
    // default handover of 0.5 toward grazing hands the surface over to the
    // ABSOLUTE brightness of the reflected canopy, and the reflected canopy is
    // the darkest thing in the level. graze 0.34 keeps the structure the pass
    // exists for and gives most of the authored level back, and the probe term is
    // lifted with it. Both are water() options; no shared system is touched.
    return lib.water({
      color: 0x131a12,
      roughness: 0.085,
      envMapIntensity: 2.00,
      reflect: { graze: 0.30 },
      // A SILT RIVER IS TURBID, AND TURBID WATER IS NOT DARK. The reflection lifts
      // the far channel, where the incidence is grazing; the NEAR channel is where
      // the eye looks steeply down, the reflection term falls away and the surface
      // takes its value from the body - and the body was 0x131a12 over a 0x2a2414
      // bed at 2.4 m of absorption, i.e. near black. A Mekong reach carries so much
      // suspended silt you cannot see 30 cm into it, and what that looks like is a
      // milky olive-brown that scatters light back OUT. Shallower absorption plus a
      // lighter bed and in-scatter tint is what turns the near water from tar into
      // water; the transmitted hue stays brown-green because blue is still absorbed
      // hardest, which is the one thing a delta does opposite to the sea.
      depth: 1.85,
      absorb: [0.17, 0.27, 0.62],
      bed: 0x3b3420,
      tint: 0x55583a,
      foam: 0x9aa07a,
      foamWidth: 1.1,
      waveAmp: 0.42
    });
  };

  LevelJungle.prototype._barkMaterial = function () {
    if (!this._barkSet) {
      try { this._barkSet = buildBarkMaps(0xBA12) || {}; }
      catch (e) { GAME.logError('jungle.bark', e); this._barkSet = {}; }
    }
    var set = this._barkSet;
    if (!set.albedo) return null;
    var aniso = this._aniso();
    var m = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0.0,
      vertexColors: true, envMapIntensity: 0.80
    });
    m.map = makeTex(set.albedo, true, aniso);
    m.normalMap = makeTex(set.normal, false, aniso);
    m.roughnessMap = makeTex(set.rough, false, aniso);
    m.normalScale = new THREE.Vector2(1.30, 1.30);
    m.name = 'jungle_bark';
    return m;
  };

  // THE TWO FOLIAGE MATERIALS.
  //
  // `canopy` is alpha-cut cards off the atlas and is used only above eight
  // metres. `blade` is the same shader with no alpha cut at all, applied to the
  // real folded-ribbon geometry that makes up everything at eye height.
  //
  // The emissiveMap is the albedo and the emissive is a deep green at 0.09-0.11
  // intensity. That is not a glow - against a lit leaf it is five per cent and
  // invisible - it is the guarantee that a leaf in shadow never reaches black,
  // which is the single loudest tell in procedural foliage and the reason a
  // canopy interior usually photographs as a silhouette.
  LevelJungle.prototype._foliageMaterial = function (isCanopy) {
    var set;
    if (isCanopy) {
      if (!this._atlas) {
        try { this._atlas = buildCanopyAtlas(this.rng.fork(0xC410)) || {}; }
        catch (e) { GAME.logError('jungle.atlas', e); this._atlas = {}; }
      }
      set = this._atlas;
    } else {
      if (!this._bladeSet) {
        try { this._bladeSet = buildBladeMaps(0xB1AD) || {}; }
        catch (e2) { GAME.logError('jungle.blade', e2); this._bladeSet = {}; }
      }
      set = this._bladeSet;
    }
    if (!set || !set.albedo) return null;
    var aniso = this._aniso();
    var m = isCanopy
      ? new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        side: THREE.DoubleSide, vertexColors: true,
        transparent: false, alphaTest: 0.42, envMapIntensity: 1.00
      })
      : new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 1.0, metalness: 0.0,
        side: THREE.DoubleSide, vertexColors: true,
        transparent: false, envMapIntensity: 1.10
      });
    m.map = makeTex(set.albedo, true, aniso, !isCanopy ? false : true);
    m.normalMap = makeTex(set.normal, false, aniso, !isCanopy ? false : true);
    m.roughnessMap = makeTex(set.rough, false, aniso, !isCanopy ? false : true);
    m.normalScale = new THREE.Vector2(isCanopy ? 0.85 : 1.65, isCanopy ? 0.85 : 1.65);
    m.emissiveMap = m.map;
    m.emissive = new THREE.Color().setHex(isCanopy ? 0x2a5218 : 0x38661c,
      THREE.SRGBColorSpace);
    // 0.048 / 0.058, not 0.075 / 0.095. The anti-crush lift was costing the
    // level its entire near/far read: with every leaf in the frame carrying a
    // floor, the trunk at 12 m measured 0.408 and the far bank at 55 m measured
    // 0.401 - a depth ramp that is not merely shallow but NON-MONOTONIC. It can
    // come down now that the fog is lifting the distance and the floor light
    // bake is lifting the shade.
    m.emissiveIntensity = isCanopy ? 0.048 : 0.058;
    m.shadowSide = THREE.DoubleSide;
    if (!isCanopy) {
      // The waxy cuticle. On a level publishing wetness 0.58 there was not one
      // water bead and not one rim highlight on the leaf nearest the lens, so
      // the sheen is stronger, there is a clearcoat over it (update() drives
      // both off weather.wetness), and buildBladeMaps now carries a 1-2 cm
      // beading layer in its normal so a wet leaf has specular STRUCTURE
      // rather than one broad smear.
      m.sheen = 0.72;
      m.sheenRoughness = 0.42;
      m.sheenColor = new THREE.Color().setHex(0xd4ecae, THREE.SRGBColorSpace);
      m.clearcoat = 0.18;
      m.clearcoatRoughness = 0.30;
      this._bladeMat = m;
    }
    this._addSway(m, isCanopy ? 0.030 : 0.016, !isCanopy);
    m.name = isCanopy ? 'jungle_canopy' : 'jungle_blade';
    return m;
  };

  // A two-band object-space sway, applied before project_vertex and scaled by
  // the vertex's own local height so a plant pivots about its base. Same
  // technique materials.js uses for its foliage; the shadow pass runs
  // MeshDepthMaterial and does not sway, which at two centimetres is invisible.
  LevelJungle.prototype._addSway = function (mat, amount, backlit) {
    var clock = this._clock;
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.jgTime = clock;
      shader.uniforms.jgWind = { value: amount };
      shader.vertexShader = 'uniform float jgTime;\nuniform float jgWind;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'float jgPh = transformed.x * 1.7 + transformed.z * 2.3;',
          'float jgS = sin( jgTime * 1.15 + jgPh ) * 0.65 +',
          '            sin( jgTime * 2.60 + jgPh * 2.1 ) * 0.35;',
          'transformed.x += jgS * jgWind * max( transformed.y, 0.0 );',
          'transformed.z += jgS * jgWind * 0.6 * max( transformed.y, 0.0 );'
        ].join('\n'));
      // BACKLIT TRANSLUCENCY, for the price of one line.
      //
      // A real transmission lobe needs a transmission render target and is not
      // worth its cost on two thousand instanced plants. But every blade in the
      // understory is DoubleSide, so gl_FrontFacing already tells the shader
      // whether it is looking at the lit face of a leaf or through the back of
      // one - and a leaf seen from behind is exactly the case where a real leaf
      // glows. Tripling the (already tiny) emissive on back faces is the honest
      // cheap read of it, and it is what makes the understory stop looking like
      // painted card.
      if (backlit) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>', [
            '#include <emissivemap_fragment>',
            'totalEmissiveRadiance *= gl_FrontFacing ? 1.0 : 3.1;'
          ].join('\n'));
      }
    };
    mat.customProgramCacheKey = function () {
      return 'jgSway' + amount.toFixed(3) + (backlit ? 'B' : '');
    };
  };

  LevelJungle.prototype._litMaterial = function (red) {
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(red ? 0x2a0806 : 0x2c1a08, THREE.SRGBColorSpace),
      roughness: 0.42, metalness: 0.0, vertexColors: true,
      emissive: new THREE.Color().setHex(red ? 0xff2a14 : 0xffa848, THREE.SRGBColorSpace),
      emissiveIntensity: red ? 3.4 : 6.2, side: THREE.DoubleSide, fog: true
    });
    m.name = red ? 'jungle_beacon' : 'jungle_flame';
    if (red) this._litMat2 = m; else this._litMat = m;
    return m;
  };

  LevelJungle.prototype._markMaterial = function () {
    var tex = null;
    try { tex = buildMarkAtlas(this.rng.fork(0xDECA1)); }
    catch (e) { GAME.logError('jungle.marks', e); tex = null; }
    this._markTex = tex;
    if (tex) tex.anisotropy = this._aniso();
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.92, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.04,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.name = 'jungle_marks';
    return m;
  };

  // STANDING WATER. The env profile publishes wetness 0.58 and the floor had
  // not one puddle, not one wet specular patch, on a level briefed as "humid
  // drizzle" with a "rutted mud road" through it. The dirt material's own wet
  // contract darkens and glosses the surface but it cannot put a MIRROR in a
  // rut, and a mirror is the whole point: a puddle is the only thing on a
  // forest floor that carries the sky's value, so it is the only thing that can
  // make the floor's dark read as dark rather than as underexposed.
  //
  // Near-black albedo, roughness 0.055, and the env map doing all the work.
  // One draw call for the whole level.
  LevelJungle.prototype._puddleMaterial = function () {
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x0e1310, THREE.SRGBColorSpace),
      roughness: 0.055, metalness: 0.0, vertexColors: true,
      envMapIntensity: 1.55, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    m.name = 'jungle_puddle';
    return m;
  };

  // The rain-ring layer's material. Near-black, nearly a mirror, and its ALPHA
  // is the ring mask - so it is invisible except where a drop has just landed,
  // and there it shows the sky. `jgRain` is driven from update() off
  // weather.rainIntensity, so the rings stop when the drizzle does.
  LevelJungle.prototype._rippleMaterial = function () {
    // metalness 0.55 rather than 0: a dielectric at normal incidence reflects
    // 4% and the first pass came back as a set of DARK rings on dark water,
    // which is the wrong sign - an impact ring is visible because its tilted
    // face catches the sky. Pushing F0 up makes the ring a silver arc; the
    // alpha mask means nothing but the arcs is ever drawn, so the layer cannot
    // read as metal.
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x66756c, THREE.SRGBColorSpace),
      roughness: 0.11, metalness: 0.55,
      envMapIntensity: 1.9,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
      fog: true
    });
    m.name = 'jungle_rings';
    var clock = this._clock;
    var amt = this._rainAmt = { value: 1.0 };
    m.onBeforeCompile = function (shader) {
      shader.uniforms.jgT = clock;
      shader.uniforms.jgRain = amt;
      shader.vertexShader = 'varying vec3 jgWP;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'jgWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;'
        ].join('\n'));
      var head = [
        'uniform float jgT;',
        'uniform float jgRain;',
        'varying vec3 jgWP;',
        'float jgH( vec2 p ) {',
        '  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );',
        '}',
        // One impact per 0.85 m cell, phase hashed off the cell so no two
        // rings are in step. A ring expands to 40 cm in one second and fades
        // as it goes, which is what a 2 mm drop on slack water does.
        'vec2 jgRings( vec2 p ) {',
        '  vec2 g = floor( p / 0.75 );',
        '  float m = 0.0, sl = 0.0;',
        '  for ( int j = -1; j <= 1; j++ ) {',
        '    for ( int i = -1; i <= 1; i++ ) {',
        '      vec2 c = g + vec2( float( i ), float( j ) );',
        '      float h1 = jgH( c );',
        '      float h2 = jgH( c + 17.3 );',
        '      vec2 ctr = ( c + vec2( h1, h2 ) ) * 0.75;',
        '      float ph = fract( jgT * 0.85 + h1 * 7.31 + h2 * 3.17 );',
        '      float rad = ph * 0.40;',
        '      float d = length( p - ctr ) - rad;',
        '      float w = 0.030 + ph * 0.045;',
        '      float ring = exp( - ( d * d ) / ( w * w ) ) * ( 1.0 - ph ) * ( 1.0 - ph );',
        '      m += ring;',
        '      sl += ring * sign( d );',
        '    }',
        '  }',
        '  return vec2( min( m, 1.0 ), sl );',
        '}'
      ].join('\n');
      shader.fragmentShader = head + '\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          'vec2 jgR = jgRings( jgWP.xz );',
          'vec2 jgDir = normalize( jgWP.xz - floor( jgWP.xz / 0.75 ) * 0.75 - 0.375 + 1e-4 );',
          'normal = normalize( normal + vec3( jgDir.x, 0.0, jgDir.y ) * jgR.y * 0.55 );'
        ].join('\n'));
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>', [
          '#include <alphamap_fragment>',
          'diffuseColor.a *= clamp( jgRings( jgWP.xz ).x, 0.0, 1.0 ) * 0.92 * jgRain;'
        ].join('\n'));
    };
    m.customProgramCacheKey = function () { return 'jgRainRings'; };
    return m;
  };

  LevelJungle.prototype._aniso = function () {
    try {
      var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
      if (caps && caps.getMaxAnisotropy) {
        return Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
      }
    } catch (e) { /* a nicety */ }
    return 4;
  };

  // ---- colliders --------------------------------------------------------------
  LevelJungle.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
    var q = new THREE.Quaternion();
    if (euler) q.setFromEuler(euler);
    var c = {
      type: 'box',
      center: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(Math.abs(hx), Math.abs(hy), Math.abs(hz)),
      quaternion: q,
      material: material || 'dirt',
      floor: !!isFloor
    };
    this.colliders.push(c);
    return c;
  };

  // ---- instancing --------------------------------------------------------------
  // Sized to the accumulated array, never to a guessed cap. An InstancedMesh
  // that overflows its capacity silently drops everything past it and the
  // failure is invisible until somebody counts, so there is nothing to overflow.
  var INST_MAT = {
    grass0: 'blade', grass1: 'blade', grass2: 'blade',
    fern0: 'blade', fern1: 'blade',
    taro0: 'blade', taro1: 'blade',
    banana0: 'blade', banana1: 'blade',
    palmTrunk: 'bark', palmCrown: 'blade',
    bambooCulm: 'bark', bambooLeaf: 'canopy',
    canopy0: 'canopy', canopy1: 'canopy', canopy2: 'canopy',
    deadleaf: 'blade'
  };
  var NO_SHADOW = {
    grass0: 1, grass1: 1, grass2: 1, fern0: 1, fern1: 1,
    canopy0: 1, canopy1: 1, canopy2: 1, palmCrown: 1, bambooLeaf: 1,
    // Thin verticals in a mid-storey under an overcast deck. Their shadows are
    // invisible and each one costs a draw call per chunk per cascade.
    palmTrunk: 1, bambooCulm: 1,
    // AND THE BROADLEAVES. lv_firefight rendered 507 draw calls against a ~500
    // ceiling, and taro and banana were the last two understory kinds still
    // paying the 4x: two kinds x up to four chunks x up to four cascades, for a
    // soft blob under a plant that is itself standing on the pool the floor
    // light bake already draws. Under an OVERCAST dome a knee-high leaf casts
    // essentially nothing, and this is the same trade the file already made for
    // the canopy and the palm crowns.
    taro0: 1, taro1: 1, banana0: 1, banana1: 1,
    // A leaf lying flat on the mud casts nothing an overcast dome could resolve.
    deadleaf: 1
  };
  // EVERY EXTRA KIND IS A DRAW CALL IN EVERY CHUNK AND IN EVERY CASCADE. These
  // four existed only as a size variant of another kind, which addInst's own
  // per-instance scale already provides - so they are folded in with the scale
  // they used to carry, and the level pays four fewer meshes per chunk for a
  // difference nothing in a frame could see.
  var INST_ALIAS = {
    grass2: ['grass0', 0.72], fern1: ['fern0', 1.35],
    taro1: ['taro0', 1.15], banana1: ['banana0', 1.15]
  };

  // ONE InstancedMesh PER KIND IS ONE BOUNDING SPHERE PER KIND, AND A BOUNDING
  // SPHERE ROUND THE WHOLE DELTA IS NEVER OUTSIDE THE FRUSTUM. Every grass
  // clump in fifteen thousand square metres was therefore submitted on every
  // frame, in the main pass and in all four shadow cascades - which is why the
  // level cost 3.5-5.5 M triangles to photograph 30 m of forest, and why adding
  // any density at all blew the budget instantly.
  //
  // Splitting each kind across a 3 x 4 chunk grid (40 x 31 m) gives the
  // renderer something it can actually cull. It costs a handful of draw calls
  // for the chunks that ARE visible and returns more than half the triangle
  // budget, which is what pays for the understory density, the cupped leaves
  // and the pillow sandbags in this pass.
  var INST_NX = 2, INST_NZ = 2;
  var INST_CX = (X_MAX - X_MIN) / INST_NX, INST_CZ = (Z_MAX - Z_MIN) / INST_NZ;

  LevelJungle.prototype.addInst = function (kind, m, scale, shadeY, occ) {
    if (kind === 'palm') {
      this.addInst('palmTrunk', m, scale, shadeY, occ);
      this.addInst('palmCrown', m.clone(), scale, shadeY, occ);
      return;
    }
    if (kind === 'bamboo') {
      this.addInst('bambooCulm', m, scale, shadeY, occ);
      this.addInst('bambooLeaf', m.clone(), scale, shadeY, occ);
      return;
    }
    var al = INST_ALIAS[kind];
    if (al) { kind = al[0]; scale = (scale === undefined ? 1 : scale) * al[1]; }
    if (!INST_MAT[kind]) return;
    var el = m.elements;
    // CHUNKING BUYS NOTHING FOR THE LITTER, SO IT PAYS NOTHING FOR IT. The chunk
    // grid is 2 x 2 over 120 x 124 m, so a chunk's bounding sphere is 43 m in
    // radius - which any camera standing in the middle of the delta intersects on
    // all four. Measured: the mid-storey and litter passes added an almost
    // IDENTICAL 915 k triangles to every one of the five framings, i.e. the chunk
    // culling was not rejecting any of it. For the plant strata the split still
    // earns its keep at the edges of the map, but the litter is a flat carpet that
    // covers the whole floor and is never rejected anywhere, so four meshes is
    // three draw calls spent on nothing - and lv_firefight is the frame with two
    // per cent of draw-call margin in it.
    var slotKey;
    if (kind === 'deadleaf') {
      slotKey = kind + '#0';
    } else {
      var ci = M.clamp(Math.floor((el[12] - X_MIN) / INST_CX), 0, INST_NX - 1);
      var cj = M.clamp(Math.floor((el[14] - Z_MIN) / INST_CZ), 0, INST_NZ - 1);
      slotKey = kind + '#' + (cj * INST_NX + ci);
    }
    var slot = this._inst[slotKey] ||
      (this._inst[slotKey] = { kind: kind, m: [], c: [] });
    var s = scale === undefined ? 1 : scale;
    m.scale(new THREE.Vector3(s, s, s));
    slot.m.push(m);
    var rng = this.rng;
    // Per-instance colour is where the forest stops being one shade of green.
    // Height drives a warm/cool ramp - understory is warm and light because it
    // is lit by bounce off the litter, canopy is cool and dark because it is
    // lit by sky through more leaves - and the random value spread on top of
    // that is what breaks the repeated stamp.
    // 0.68-1.14, not 0.62-1.22. With the per-card cluster occlusion below now
    // carrying a real 45% range of its own, the random value spread on top of
    // it was pushing the brightest unoccluded cards against the fog ceiling -
    // and a near-white leaf card beside a near-black one, with nothing in
    // between, is card-level lighting rather than leaf-level.
    var v = rng.range(0.68, 1.14);
    var warm = M.saturate(1 - (shadeY === undefined ? 0 : (shadeY / 26)));
    // The BLUE leg runs the other way from the red one: understory is warm and
    // light because it is lit by bounce off the litter, canopy is COOL and dark
    // because it is lit by sky through more leaves. It used to fall with height
    // alongside the red, which made the ramp a pure value ramp with no hue in
    // it - and the level measured a hue interquartile range of 18-38 degrees in
    // every sampled region, i.e. the whole picture lived in a 35-degree wedge.
    var r = v * (0.78 + 0.36 * warm);
    var g = v * (0.98 + 0.10 * warm);
    var b = v * (0.92 - 0.16 * warm);
    if (kind === 'bambooCulm' || kind === 'palmTrunk') {
      r = v * 1.12; g = v * 1.06; b = v * 0.78;
    } else if (kind === 'deadleaf') {
      // DEAD, AND THAT IS THE POINT OF IT. The level's chroma measured an 18-38
      // degree hue interquartile range in every sampled region - the whole
      // picture living in one wedge - and the floor is the largest surface it can
      // put OUTSIDE that wedge. So the litter runs ochre through to a rotted
      // near-black brown, with about one leaf in six freshly enough down to be
      // still holding its colour. Ignoring the green ramp above is deliberate:
      // a dead leaf is not a cool leaf, it is a different pigment.
      // A MULTIPLIER CANNOT MAKE A GREEN TEXTURE BROWN AT 1.3 : 0.9. The blade
      // albedo is a live leaf - roughly (0.15, 0.35, 0.08) linear - so green is
      // already the largest channel by 2.3 : 1 and a 1.4 : 1 red bias still comes
      // out olive. Measured: the first litter pass photographed as a carpet of
      // FRESH GREEN leaves, which added silhouette to the floor and nothing at all
      // to its hue range. Brown needs the red channel about three times the green
      // one, so the ceiling in the clamp below is 2.6 rather than 2.0.
      // The RATIO makes it brown, the MAGNITUDE makes it litter. At 2.30 : 0.76
      // the leaves came out ochre and correct in hue and a full stop too BRIGHT -
      // a drift of pale straw lying on a dark forest floor, which reads as
      // sawdust. Dead leaf under a closed canopy is a dark umber; the ratio is
      // kept and the whole thing is scaled down by a quarter.
      // SOLVED AGAINST THE MEASUREMENT, TWICE. At 1.72 : 0.57 the litter rendered
      // with a mean of [0.097 0.095 0.039] - red equal to green, i.e. olive-yellow
      // rather than brown - because the blade albedo's green is about three times
      // its red, so a 3 : 1 multiplier only gets you back to parity. Brown wants
      // r/g around 1.5 in the OUTPUT, so the multiplier ratio has to be about
      // 4.4 : 1. The luminance is held roughly where it was (the litter already
      // measured 0.055 median against 0.084 for the ground beside it, which is
      // correct - dead leaf is darker than wet mud, not brighter).
      // SOLVED FROM THE RENDERED MEAN, not from the multiplier. At (1.72, 0.57,
      // 0.23) the litter measured [0.097 0.095 0.039] - olive-yellow, red equal to
      // green - and at (1.95, 0.44, 0.16) it went ORANGE and read as confetti
      // scattered on the firebase field. Wet leaf litter in shade is about
      // [0.055 0.038 0.022] linear: r/g near 1.5 in the OUTPUT and roughly half
      // the luminance of the first attempt. Scaling the measurement gives
      // (1.15, 0.27, 0.15), and the wide per-leaf value spread on top of it is what
      // makes a DRIFT rather than a set of identical bright flecks - a real drift
      // runs from a pale newly-fallen leaf to a near-black rotted one.
      var fresh = rng.next() < 0.16 ? 1 : 0;
      var wj = rng.range(0.62, 1.34);
      r = v * M.lerp(1.15, 0.74, fresh) * wj;
      g = v * M.lerp(0.27, 0.50, fresh) * wj * rng.range(0.88, 1.10);
      b = v * M.lerp(0.15, 0.30, fresh) * wj * rng.range(0.66, 1.34);
    } else {
      // PER-PLANT HUE. The whole understory shares ONE albedo map, so the only
      // place its hue can vary is here - and without it 2500 plants are 2500
      // copies of one green, which is half of why the level's chroma measured
      // an 18-38 degree interquartile range in every sampled region. A hue
      // rotation is not a desaturation: the plant stays as saturated, it just
      // sits somewhere else in the yellow-green to blue-green band a real
      // understory spans.
      var hj = rng.range(-1, 1);
      r *= 1 - hj * 0.22;
      g *= 1 + hj * 0.02;
      b *= 1 + hj * 0.34;
    }
    // per-card cluster occlusion, from scatterCanopy's neighbour pass
    if (occ !== undefined && occ < 1) {
      // shade is not just darker, it is COOLER: a leaf under six other leaves
      // is lit by what got through them, and what got through them is sky.
      r *= occ; g *= occ * 1.03; b *= occ * 1.14;
    }
    // THE DAPPLE REACHES THE UNDERSTORY TOO. The floor light bake gives the
    // ground its broken light; without this the plants standing in the pools
    // would be the only things in the frame that had not noticed. Sampled at
    // the plant's own base from the same analytic field the bake uses, so a
    // clump standing in a pool is a stop and a half up on one standing two
    // metres away in the shade - which is most of what makes an understory read
    // as depth rather than as a texture.
    var m12 = m.elements;
    var dp = leafBreak(m12[12], m12[14]);
    var op2 = skyOpen(m12[12], m12[14], this.plan);
    var dl = 0.72 + 0.46 * op2 * (0.25 + 0.75 * dp);
    r *= dl; g *= dl; b *= dl * (1 - 0.10 * dp);
    // AND THE SHAFT POOL REACHES THE PLANTS IN IT. A shaft whose pool exists
    // only on the mud is a projected slide: the four things standing in hero1's
    // cone were the same value as the four standing two metres outside it, which
    // is the tell that says the light is painted on the floor rather than
    // arriving through the roof. Warm, because forty metres of leaf is a filter.
    var pl2 = shaftPool(m12[12], m12[14], this.plan);
    if (pl2 > 0) {
      var pg = 1 + 0.42 * pl2;
      r *= pg; g *= pg * 0.99; b *= pg * 0.80;
    }
    slot.c.push(new THREE.Color(
      M.clamp(r, 0.03, 2.6), M.clamp(g, 0.03, 2.6), M.clamp(b, 0.03, 2.6)));
  };

  LevelJungle.prototype._buildInstances = function () {
    var rng = this.rng.fork(0x1451);
    var factory = {
      // EVERY COUNT HERE IS EXPLICIT, and that is a budget contract rather
      // than a style choice. Each kind has exactly ONE base geometry, shared by
      // every instance of it in the level, so the internal rng.int() ranges
      // these generators carry buy no variety at all - and they DO decide the
      // level's triangle count. A run in which fernPlant happened to draw five
      // fronds of seven pinnae instead of three of five measured 734k triangles
      // of fern against 362k, i.e. the frame budget was a lottery nobody could
      // see. The variety comes from the instance transforms and colours.
      grass0: function () { return grassClump(rng, 1.00, 10); },
      grass1: function () { return grassClump(rng, 1.35, 16); },
      grass2: function () { return grassClump(rng, 0.72, 13); },
      fern0: function () { return fernPlant(rng, 1.00, 4, 5); },
      fern1: function () { return fernPlant(rng, 1.35, 4, 5); },
      taro0: function () { return taroPlant(rng, 1.00, 4); },
      taro1: function () { return taroPlant(rng, 1.15, 4); },
      banana0: function () { return bananaPlant(rng, 1.00, 6); },
      banana1: function () { return bananaPlant(rng, 1.15, 6); },
      palmTrunk: function () { return palmTree(rng, 1.0).trunk; },
      palmCrown: null,
      bambooCulm: function () { return bambooCulms(rng, 1.0, 7); },
      bambooLeaf: function () { return bambooLeafCards(rng, 1.0, 12); },
      canopy0: function () { return canopyCluster(rng, 2.9, CELL.canopyA); },
      canopy1: function () { return canopyCluster(rng, 2.9, CELL.canopyB); },
      canopy2: function () { return canopyCluster(rng, 2.9, CELL.canopyC); },
      deadleaf: function () { return deadLeaves(rng, 1.0); }
    };
    // The crown has to sit on top of the trunk it shares an instance transform
    // with, so it is generated from the same palm.
    var palm = palmTree(rng.fork(0x9A1), 1.0);
    factory.palmTrunk = function () { return palm.trunk; };
    factory.palmCrown = function () {
      var crown = palmCrown(rng, 1.0, 9);
      applyMatrix(crown, makeM(palm.lean * palm.top * 0.30, palm.top,
        palm.lean * 0.4 * palm.top * 0.30));
      return whiteColor(crown);
    };

    // The base geometry is made ONCE per kind and shared by every chunk - two
    // chunks that grew a different fern would print a seam along the boundary.
    var geoCache = Object.create(null);
    for (var slotKey in this._inst) {
      var slot = this._inst[slotKey];
      if (!slot || !slot.m.length) continue;
      var kind = slot.kind;
      var make = factory[kind];
      if (!make) continue;
      var geo = geoCache[kind];
      if (geo === undefined) {
        try { geo = make(); }
        catch (e) { GAME.logError('jungle.plant:' + kind, e); geo = null; }
        if (geo && geo.attributes && geo.attributes.position) geo.computeBoundingSphere();
        else geo = null;
        geoCache[kind] = geo;
      }
      if (!geo) continue;
      var matKey = INST_MAT[kind] || 'blade';
      var surf = SURF[matKey] || SURF.blade;
      var mesh = new THREE.InstancedMesh(geo, this.material(matKey), slot.m.length);
      mesh.name = 'jungle_' + slotKey;
      // WHAT CASTS IS THE WHOLE TRIANGLE BUDGET. Measured: the main pass is
      // 1.84 M triangles and the frame reported 4.22 M, because every caster is
      // re-submitted into all four shadow cascades. The canopy sits at 17-27 m,
      // entirely outside the near cascades, and the palm crowns at 4-7 m throw a
      // soft blob the floor light bake now draws far better - so neither earns
      // its 4x. Grass and fern never cast (they never did).
      mesh.castShadow = surf.cast && !NO_SHADOW[kind];
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (var i = 0; i < slot.m.length; i++) {
        mesh.setMatrixAt(i, slot.m[i]);
        mesh.setColorAt(i, slot.c[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.instanced.push(mesh);
      slot.m.length = 0; slot.c.length = 0;
    }
  };


  // ---- build ------------------------------------------------------------------
  LevelJungle.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var self = this;
    var rng = this.rng;
    var B = new Builder();
    var i;

    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('jungle.' + name, e); }
    }

    stage('ground', function () { buildGround(self, rng); });
    await GAME.yieldFrame();
    stage('water', function () { buildWater(self); });
    stage('floorColliders', function () { self._buildFloor(); });
    await GAME.yieldFrame();

    stage('trees', function () {
      for (var t = 0; t < self.plan.trees.length; t++) {
        buildTree(self, B, rng, self.plan.trees[t]);
      }
    });
    await GAME.yieldFrame();
    stage('mangroves', function () {
      for (var t = 0; t < self.plan.mangroves.length; t++) {
        buildMangrove(self, B, rng, self.plan.mangroves[t]);
      }
    });
    stage('logs', function () {
      for (var t = 0; t < self.plan.logs.length; t++) {
        buildLog(self, B, rng, self.plan.logs[t]);
      }
    });
    await GAME.yieldFrame();

    stage('firebase', function () { self.builtFirebase = buildFirebase(self, B, rng); });
    await GAME.yieldFrame();
    stage('bunker', function () { self.builtBunker = buildBunker(self, B, rng); });
    stage('tower', function () { self.builtTower = buildTower(self, B, rng); });
    await GAME.yieldFrame();

    stage('heli', function () { self.builtHeli = buildHeli(self, B, rng); });
    stage('bridge', function () { self.builtBridge = buildBridge(self, B, rng); });
    stage('sluice', function () { self.builtSluice = buildSluice(self, B, rng); });
    stage('shrine', function () { self.builtShrine = buildShrine(self, B, rng); });
    stage('outcrop', function () { self.builtOutcrop = buildOutcrop(self, B, rng); });
    stage('warmMass', function () { buildWarmMass(self, B, rng); });
    await GAME.yieldFrame();

    stage('understory', function () { scatterUnderstory(self, rng); });
    await GAME.yieldFrame();
    stage('midstorey', function () { scatterMidstorey(self, rng); });
    await GAME.yieldFrame();
    stage('litter', function () { scatterLitter(self, rng); });
    await GAME.yieldFrame();
    stage('canopy', function () { scatterCanopy(self, rng); });
    await GAME.yieldFrame();
    stage('marks', function () { buildGroundMarks(self, B, rng); });
    stage('puddles', function () { buildPuddles(self, B, rng); });
    await GAME.yieldFrame();

    stage('merge', function () { self._finalize(B); });
    await GAME.yieldFrame();
    stage('instances', function () { self._buildInstances(); });
    await GAME.yieldFrame();

    stage('lights', function () { self._buildLights(); });
    stage('fog', function () { self._applyFog(); });
    stage('shelter', function () { self._buildRainShelters(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('nav', function () { self._buildNav(); });
    stage('broadphase', function () { self._buildBroadphase(); });
    stage('foam', function () { self._publishFoam(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    void i;
    return this;
  };

  LevelJungle.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var surf = SURF[key] || SURF.mud;
      if (key === 'mark') {
        this.material('mark');
        if (!this._markTex) { B.buckets[key] = null; continue; }
      }
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('jungle.merge:' + key, e); continue; }
      if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
      // The mud bucket shares its material - and therefore its floor light bake
      // - with the ground heightfield, so it has to share the bake's uv1 too.
      // Everything else keeps the world-planar copy the AO path expects.
      if (key === 'mud') playUV1(geo); else Geo.copyUV1(geo);
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('jungle.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key));
      mesh.name = 'jungle_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'mark') mesh.renderOrder = 2;
      if (key === 'glazing') mesh.renderOrder = 1;
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // Vertex colours are a plain albedo MULTIPLIER on every bucket. What they
  // carry that a merged bucket cannot get any other way is per-piece value
  // spread plus, on everything that stands in a rainforest, a MOSS GRADIENT:
  // biological growth on any surface is a function of how near the ground it is
  // and which way it faces, and painting that in is most of what stops the
  // firebase reading as a set of clean boxes dropped into a jungle.
  LevelJungle.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = this.noise;
    var organic = (key === 'bark' || key === 'canopy' || key === 'blade');
    var emissive = (key === 'lit' || key === 'lit2');
    var vi = 0, e, i, j;
    var plan = this.plan;
    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = 1, tg = 1, tb = 1;
      if (ent.tint) { tr = ent.tint.r; tg = ent.tint.g; tb = ent.tint.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      // ---- THE DAPPLE REACHES EVERYTHING THAT STANDS ON THE FLOOR ----------
      // The floor light bake gave the mud sharp-edged pools of filtered
      // daylight and gave NOTHING that stands in them a photon of it, so a drum
      // lid measured 0.158 against bare ground 40 cm away at 0.574 - 1.9 stops
      // between two horizontal surfaces under one dome - and every prop in the
      // level read as a black sticker on a bright field. Sampled ONCE per
      // placed piece from the same analytic field the bake uses (a whole drum
      // is in a pool or it is not; there is no point paying for it per vertex),
      // so a crate standing in a shaft pool is a stop up on one two metres away
      // in the shade, which is what a dapple MEANS.
      var em = ent.matrix.elements;
      var edp = leafBreak(em[12], em[14]);
      var eop = skyOpen(em[12], em[14], plan);
      var dl = 0.74 + 0.70 * eop * (0.22 + 0.78 * M.smoothstep(0.35, 0.75, edp));
      if (!emissive) { tr *= dl; tg *= dl; tb *= dl * (1 - 0.06 * edp); }
      // ...and so does the shaft pool. Same reason as in addInst: the sandbag
      // run, the drum and the revetment post standing in a cone have to be lit
      // by it, or the cone is a slide projected onto the mud.
      if (!emissive) {
        var epl = shaftPool(em[12], em[14], plan);
        if (epl > 0) {
          var pg2 = 1 + 0.36 * epl;
          tr *= pg2; tg *= pg2 * 0.99; tb *= pg2 * 0.82;
        }
      }
      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var ny = na[j + 1];
        var r = tr * dk, g = tg * dk, b = tb * dk;
        if (emissive) { col[j] = r; col[j + 1] = g; col[j + 2] = b; continue; }
        var v = noise.fbm2(x * 0.42 + 3.0, z * 0.42 - 2.0, 2);
        var gy = this.sampleGround(x, z);
        var above = y - gy;

        if (!organic) {
          // sky exposure: the underside of everything in a forest is lit only
          // by bounce off leaf litter, so it goes darker AND warmer
          var facing = M.saturate(ny * 0.5 + 0.5);
          // 0.74, not 0.62. A prop's own underside term was costing it a third
          // of a stop on TOP of the missing floor light, and an overcast dome
          // does not have a 1.7:1 up/down ratio - a hemisphere over a bright
          // floor is closer to 1.35:1.
          var lit = 0.74 + 0.34 * facing;
          r *= lit * (1 + v * 0.10);
          g *= lit * (1 + v * 0.085);
          b *= lit * (1 - v * 0.02) * 0.97;
          // MOSS. Thickest within a metre of the ground, on up-facing and
          // north-facing surfaces, and it decays to nothing by three metres.
          // Its darkening is halved: at 0.52 red it was taking a drum lid to a
          // third of its albedo and doing it on the horizontal faces, which is
          // where the sky is. Growth is a COLOUR shift, not a lights-out.
          var mo = M.saturate(1 - above / 2.6) *
            M.saturate(0.30 + facing * 0.9) *
            M.smoothstep(0.42, 0.80, n01(noise.fbm2(x * 0.55 - 8.0, z * 0.55 + 5.0, 2)));
          r = M.lerp(r, r * 0.74, mo * 0.62);
          g = M.lerp(g, g * 1.16, mo * 0.62);
          b = M.lerp(b, b * 0.80, mo * 0.62);
          // water staining runs DOWN, so it lives on the vertical faces
          var vert = 1 - Math.abs(ny);
          var st = vert * M.smoothstep(0.52, 0.88,
            n01(noise.fbm2(x * 1.5 + 21.0, y * 0.35, 2)));
          r *= 1 - st * 0.26; g *= 1 - st * 0.22; b *= 1 - st * 0.18;
          // THE SPLASH ZONE. It is raining, and the bottom 30 cm of everything
          // standing in a monsoon delta is permanently dark: rain rebounding
          // off the mud throws it up the face, and a wet surface traps light in
          // its pores. Nothing in the level was saying so - the sandbags, the
          // drums and the revetment posts all ran the same value from ground to
          // top, which is the tell that says "dropped in", not "stood here".
          //
          // IT MUST NOT REACH THE GROUND MARKS. A decal card lies AT above = 0.02,
          // so every boot print, tyre rut, leaf drift and scum patch in the level
          // was taking the full 34% - i.e. the marks were a third of a stop darker
          // than the mud they are painted on, which is why the leaf drift under
          // the closed canopy photographed as a set of dark amoebae rather than as
          // a drift. Splash is a term about the bottom of a STANDING object; the
          // floor cannot splash itself.
          if (key !== 'mark') {
            var splash = Math.pow(M.saturate(1 - above / 0.34), 1.8);
            r *= 1 - splash * 0.34; g *= 1 - splash * 0.30; b *= 1 - splash * 0.22;
          }
        } else {
          // Bark and leaf: the same moss idea, plus a height ramp that cools
          // and darkens as it climbs into the canopy. The blue leg CLIMBS with
          // height rather than falling with it - "cools as it goes up" was
          // implemented as "loses ten per cent of everything", which is a value
          // ramp with no hue in it at all, on the level whose named failure is
          // "saturated green must not become a flat green wash".
          var hh = M.saturate(above / 22.0);
          r *= (1.12 - hh * 0.40) * (1 + v * 0.10);
          g *= (1.02 - hh * 0.10) * (1 + v * 0.07);
          b *= (0.86 + hh * 0.22) * (1 - v * 0.04);
          if (key === 'bark') {
            // THE MOSS IS CAPPED AT THE BOTTOM THIRD AND THE TOP RUNS BROWN.
            // A trunk covered in moss to 3.4 m at 0.85 strength is a green
            // column, and a green column in front of green leaves has no
            // silhouette at all. Growth now dies out by 2.4 m, and above that
            // the wood is pushed WARMER as it climbs so the trunk reads
            // brown-against-green rather than green-on-green - which is the
            // whole warm/cool separation the brief asks for, on the largest
            // objects in the level.
            // MOSS GROWS ON THE TOP OF A FALLEN LOG. The gradient was driven by
            // height above ground and by noise and by nothing else, so the one
            // large horizontal piece of dead wood in the signature framing - the
            // trunk that is hero1's and lv_firefight's leading line - got the
            // same treatment as a vertical trunk and came back bare. `ny` costs
            // nothing and is the difference between a log and a pipe.
            var upFace = M.saturate(0.22 + ny * 1.05);
            var bm = M.saturate(1 - above / 2.4) * upFace *
              M.smoothstep(0.46, 0.86, n01(noise.fbm2(x * 0.62 + 4.0, y * 0.30 - 1.0, 2)));
            var dry = M.smoothstep(1.6, 5.0, above);
            r *= 1 + dry * 0.22;
            g *= 1 - dry * 0.03;
            b *= 1 - dry * 0.20;
            // Moss BLUE is 0.74, not 0.50. The level's whole chroma lived in a
            // 35-degree wedge; biasing the growth toward blue-green rather than
            // desaturating it is the one place there is a lot of surface area to
            // open the hue band with, and wet moss in shade genuinely is cooler
            // than the leaves above it.
            r = M.lerp(r, r * 0.52, bm * 0.66);
            g = M.lerp(g, g * 1.22, bm * 0.66);
            b = M.lerp(b, b * 0.74, bm * 0.66);
            // and a WET FLANK: the windward side of every trunk in a drizzle
            // runs dark and saturated, which is the cheapest possible directional
            // cue on an object that is otherwise radially symmetric.
            var wet = M.saturate((na[j] * WIND_X + na[j + 2] * WIND_Z)) *
              M.smoothstep(0.35, 0.75, n01(noise.fbm2(x * 0.28 - 6.0, y * 0.16 + 3.0, 2)));
            r *= 1 - wet * 0.30; g *= 1 - wet * 0.26; b *= 1 - wet * 0.20;
          }
        }
        col[j] = M.clamp(r, 0.04, 2.2);
        col[j + 1] = M.clamp(g, 0.04, 2.2);
        col[j + 2] = M.clamp(b, 0.04, 2.2);
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ---- ground sampling ---------------------------------------------------------
  LevelJungle.prototype._inPlay = function (x, z) {
    return x > X_MIN + 2 && x < X_MAX - 2 && z > Z_MIN + 2 && z < Z_MAX - 2;
  };

  LevelJungle.prototype.sampleGround = function (x, z) {
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
    return groundY(x, z, this.plan);
  };

  // Thick floor slabs following the terrain. The player controller resolves
  // against colliders, not against sampleGround, so without these the delta has
  // no floor at all. 4 m tiles taking the MAXIMUM of nine samples: standing a
  // few centimetres proud of a root buttress is invisible, sinking into one is
  // not. The river bed gets its own slabs so wading is possible.
  LevelJungle.prototype._buildFloor = function () {
    var step = 4.0;
    var Bk = this.plan.bunker;
    var bc = Math.cos(Bk.yaw), bs = Math.sin(Bk.yaw);
    for (var z = Z_MIN; z < Z_MAX; z += step) {
      for (var x = X_MIN; x < X_MAX; x += step) {
        // The bunker is a pit with its own floor slab. A 4 m tile taking the
        // MAXIMUM of nine samples would take the plateau lip and pave straight
        // over the room.
        var ddx = (x + step * 0.5) - Bk.x, ddz = (z + step * 0.5) - Bk.z;
        if (Math.abs(ddx * bc - ddz * bs) < Bk.w * 0.5 + 1.6 &&
            Math.abs(ddx * bs + ddz * bc) < Bk.d * 0.5 + 1.6) continue;
        var top = -1e9;
        for (var sj = 0; sj <= 2; sj++) {
          for (var si = 0; si <= 2; si++) {
            var y = this.sampleGround(x + si * step * 0.5, z + sj * step * 0.5);
            if (y > top) top = y;
          }
        }
        if (top < -1e8) continue;
        this.addCollider(x + step * 0.5, top - 1.4, z + step * 0.5,
          step * 0.5, 1.4, step * 0.5, 'dirt', true);
      }
    }
  };

  // ---- the light rig ---------------------------------------------------------
  // A midday jungle has almost no practicals and inventing street lighting here
  // would be a lie. What it does have is things that burn regardless of the
  // hour: two candles in a spirit house, a brazier in the firebase, a hurricane
  // lamp and a worklight in a bunker that gets no daylight, and a wreck whose
  // beacon has not finished dying. Every one of them has visible geometry in
  // this file - a light with no visible source is not a light - and every one
  // is deliberately in a published framing.
  //
  // The SHAFTS are the level's real lighting event and they are published with
  // `lux`, which makes them FIXTURES rather than solar. That is not a cheat: the
  // env profile pins sky = 'overcast', so a shaft gated on the solar disc would
  // simply not exist, and "light arrives as shafts filtered through canopy" is
  // the first line of the brief. Their colour is yellow-green because that is
  // what light is after it has been through forty metres of leaf.
  LevelJungle.prototype._buildLights = function () {
    var P = this.plan;
    var pl = this.practicalLights = [];
    var Sh = this.builtShrine, Fb = this.builtFirebase, Bk = this.builtBunker;
    var He = this.builtHeli;

    if (Sh && Sh.candle) {
      pl.push({
        name: 'shrine_candles', kind: 'fire',
        pos: [Sh.candle.x, Sh.candle.y, Sh.candle.z],
        kelvin: 1880, intensity: 7.0, distance: 5.0, dayBase: 1.0,
        haloScale: 0.55, haloMax: 1.05, haloGain: 0.6,
        bulbR: 0.035, bulbGain: 1.4, fixed: 1
      });
    }
    if (Fb && Fb.drum) {
      pl.push({
        name: 'firebase_brazier', kind: 'fire',
        pos: [Fb.drum.x, Fb.drum.y + 0.32, Fb.drum.z],
        kelvin: 1760, intensity: 30, distance: 13, dayBase: 1.0,
        haloScale: 1.05, haloMax: 2.1, haloGain: 0.7,
        bulbR: 0.20, bulbGain: 1.2, fixed: 1
      });
    }
    // THE WARM FILL IS A FILL. At 46 + 58 against an 8 lux warm-white shaft the
    // two practicals WERE the interior's lighting and the room graded to a
    // single orange hue (saturation 0.547, highlight blue -0.224). Halved, with
    // the shell-hole shaft cooled and raised, they become what a hurricane lamp
    // in a daylit room actually is: a warm accent inside a cool key.
    if (Bk && Bk.lantern) {
      pl.push({
        name: 'bunker_lantern', kind: 'tungsten',
        pos: [Bk.lantern.x, Bk.lantern.y, Bk.lantern.z],
        kelvin: 2260, intensity: 24, distance: 8.0, dayBase: 1.0,
        haloScale: 0.72, haloMax: 1.6, bulbR: 0.055, fixed: 1
      });
    }
    if (Bk && Bk.worklight) {
      pl.push({
        name: 'bunker_worklight', kind: 'fluoro',
        pos: [Bk.worklight.x, Bk.worklight.y, Bk.worklight.z],
        kelvin: 3600, intensity: 28, distance: 9.0, dayBase: 1.0,
        cone: 1.05, penumbra: 0.55,
        aimPos: [Bk.worklight.x - 1.6, Bk.floorY + 0.35, Bk.worklight.z - 2.6],
        haloScale: 0.68, haloMax: 1.5, bulbR: 0.07, bulbFlat: 0.5, fixed: 1
      });
    }
    // THE DOORWAY IS A LIGHT. The bunker has a 1.35 m opening onto an overcast
    // sky and the level was modelling exactly nothing coming through it, so the
    // only fill in the room was a 2260 K hurricane lamp and the frame graded to
    // one hue. This is skylight, so it is COOL, it has real visible geometry
    // (the door aperture itself) and it sits behind the interior standpoint
    // where a fill belongs - it lights the far revetment, not the lens.
    if (Bk && Bk.door) {
      pl.push({
        name: 'bunker_doorlight', kind: 'sky',
        pos: [Bk.door.x, Bk.floorY + 1.45, Bk.door.z],
        kelvin: 7600, intensity: 30, distance: 10.0, dayBase: 1.0,
        haloScale: 0, haloMax: 0, haloGain: 0, bulbR: 0, fixed: 1
      });
    }
    if (He && He.beacon) {
      pl.push({
        name: 'heli_beacon', kind: 'sodium',
        pos: [He.beacon.x, He.beacon.y, He.beacon.z],
        color: 0xff3418, intensity: 6.5, distance: 7.0, dayBase: 1.0,
        haloScale: 0.62, haloMax: 1.25, bulbR: 0.075, fixed: 1
      });
    }

    // ---- the shafts ---------------------------------------------------------
    // FIVE CANOPY GAPS, READ OUT OF shaftSpecs() RATHER THAN WRITTEN HERE. The
    // table is the one place their positions live, so the floor light bake, the
    // per-instance plant tint and the merged-bucket vertex colour can all put
    // the POOL down at exactly the point lighting.js is going to land the beam.
    // Before this the shafts were literals in this function and nothing else in
    // the level had any way to know where they were - which is why they hung in
    // the air over a floor that was the same value inside them and outside.
    var shafts = this.lightShafts = [];
    var specs = shaftSpecs(P);
    for (var si = 0; si < specs.length; si++) {
      var sp2 = specs[si];
      shafts.push({
        kind: sp2.kind,
        origin: new THREE.Vector3(sp2.x, this.sampleGround(sp2.x, sp2.z) + sp2.rise,
          sp2.z),
        dir: new THREE.Vector3(sp2.dx, -1, sp2.dz).normalize(),
        width: sp2.width, length: sp2.rise, strength: 1.0,
        lux: sp2.lux, always: true, color: sp2.col
      });
    }
    // A GOD RAY YOU CANNOT SEE THROUGH IS A SEARCHLIGHT, and the haze opacity
    // lighting.js applies is lux * 0.055 - so the same number that decides how
    // bright the pool is also decides how OPAQUE the column is, and those two
    // wants are opposed. At 15 the columns clipped at 0.83 and erased a whole
    // revetment run; at 9 they were translucent and the pool was a third of a
    // stop. The table now carries 8 / 6 / 4.2 / 4.8 / 3.6 and the POOL is painted
    // separately by shaftSpecs / shaftPool, which is what breaks the deadlock.
    //
    // The SPREAD is deliberate: a 3.6 lux shaft at the back of the frame is what
    // makes the 8 lux one at the front read as bright. Widths stay at 2.6-3.4 m
    // (the API clamps at 6) so the cone TAPERS over its length instead of
    // standing there as a tube - at 6 m the hero1 cone was parallel-sided over
    // its whole 13.5 m and landed as a milky curtain the same hue and value as
    // the fog it stood in. The colours are a step warmer than the fog so the
    // shafts separate by HUE as well as by value, which is the only way a pale
    // column reads against pale vapour.
    //
    //   1 hero1   the track clearing south of the creek. hero1's subject.
    //   2 hero2   the gap the helicopter came down through. hero2's key.
    //   3 hero3   over the firebase, between the shattered survivors.
    //   4 hero1b  a second, dimmer pool further down hero1's road, which is what
    //             makes the near one read as near.
    //   5 mid     the creek crossing.
    // All five now live in shaftSpecs() at the top of the file. lighting.js
    // builds up to eight for a declarative level and only the first casts a
    // shadow, so the fourth and fifth cost one unshadowed SpotLight and one
    // additive cone each.
    //
    // 6 - the shell hole in the bunker roof. The whole reason the interior
    //     framing is not a black rectangle. It keeps the most lux of the four
    //     because the room around it is genuinely dark, not merely shaded.
    //     IT IS THE COOLEST LIGHT IN THE BUILDING, NOT THE WARMEST. Published
    //     at 0xe6e2bc it was a warm white - warmer than the 2180 K hurricane
    //     lamp it is supposed to contrast with - and with no cool key anywhere
    //     the interior framing collapsed to one hue: saturation 0.547 and a
    //     grade highlight of [+0.193, +0.031, -0.224] against ~0.29 and
    //     [+0.04, +0.03, -0.07] on every exterior. Under an OVERCAST dome a
    //     hole in a roof admits sky, and sky under cloud is blue-grey. The
    //     lantern and the candle emissives stay warm; that is the whole point.
    if (Bk && Bk.holeAbove) {
      shafts.push({
        kind: 'interior',
        origin: Bk.holeAbove.clone(),
        dir: new THREE.Vector3(0.07, -1, 0.12).normalize(),
        width: 2.2, length: 4.2, strength: 1.0,
        lux: 15.0, always: true, color: 0xb4c8dc
      });
    }

  };

  // ---- IT RAINS INSIDE THE BUNKER ---------------------------------------------
  // The interior framing shipped with bright drizzle streaks falling through a
  // solid sandbag-and-timber roof. weather.js has a roof mask and two ways in:
  // an explicit `level.rainShelters` publication, or AXIS-ALIGNED box colliders.
  // Every roof slab here is added with a 0.40 rad yaw, whose quaternion w is
  // 0.980 - under weather.js's 0.9995 identity test - so all four were skipped
  // and the level was fully unsheltered.
  //
  // The interesting half is the CANOPY. A closed 25 m roof in drizzle should
  // attenuate the rain at ground level almost to nothing and replace it with
  // drip off the leaf tips (which this level already publishes as dripEdges).
  // Publishing coarse rects wherever the canopy is closed makes the rain visible
  // ONLY IN THE GAPS - and rain that falls only where the sky is open IS the
  // canopy, drawn for free, in the one place a canopy is hardest to draw.
  //
  // Merged into runs along x before publishing: weather.js's bake is
  // O(128 * 128 * rects) and a raw 5 m grid over 15,000 m2 is 500 of them.
  LevelJungle.prototype._buildRainShelters = function () {
    var out = this.rainShelters = [];
    var P = this.plan;
    var A = this.anchors;

    // 1 - the command bunker. Its yaw is only 0.40 rad, so a shrunk AABB of the
    //     footprint sits comfortably inside the walls.
    var K = P.bunker;
    var kr = Math.max(K.w, K.d) * 0.5;
    var kin = Math.min(K.w, K.d) * 0.5 - 0.7;
    void kr;
    out.push({ x0: K.x - kin, x1: K.x + kin, z0: K.z - kin, z1: K.z + kin,
      h: (A.bunker.roofY || (K.y - K.sink + 2.62)) + 0.45 });

    // 2 - the watchtower platform and its tin roof.
    var T = P.tower;
    out.push({ x0: T.x - T.legR * 1.15, x1: T.x + T.legR * 1.15,
      z0: T.z - T.legR * 1.15, z1: T.z + T.legR * 1.15,
      h: T.y + T.roofY + 0.4 });

    // 3 - the collapsed A-frame and its tarp.
    var Sh = P.shelter;
    out.push({ x0: Sh.x - 1.5, x1: Sh.x + 1.5, z0: Sh.z - 2.6, z1: Sh.z + 2.6,
      h: this.sampleGround(Sh.x, Sh.z) + 1.6 });

    // 4 - THE CANOPY. A 5 m lattice, kept where the roof is closed, merged into
    //     runs. The height is the canopy UNDERSIDE, so the volume between the
    //     floor and the leaves goes dry and the clearings, the track slot and
    //     the whole river keep their rain.
    var step = 5.0;
    var nz = Math.ceil((Z_MAX - Z_MIN) / step);
    var nx = Math.ceil((X_MAX - X_MIN) / step);
    for (var j = 0; j < nz; j++) {
      var z0 = Z_MIN + j * step, z1 = z0 + step;
      var zc = z0 + step * 0.5;
      var runStart = -1;
      for (var i = 0; i <= nx; i++) {
        var xc = X_MIN + (i + 0.5) * step;
        var closed = false;
        if (i < nx) {
          var op = skyOpen(xc, zc, P);
          var gy = this.sampleGround(xc, zc);
          closed = (op < 0.38) && (gy > WATER_Y - 0.4);
        }
        if (closed && runStart < 0) runStart = i;
        if (!closed && runStart >= 0) {
          out.push({
            x0: X_MIN + runStart * step, x1: X_MIN + i * step,
            z0: z0, z1: z1,
            h: this.sampleGround(X_MIN + (runStart + 0.5) * step, zc) + 11.0
          });
          runStart = -1;
        }
      }
    }
  };

  // ---- the air ----------------------------------------------------------------
  // NO AERIAL PERSPECTIVE AT ALL: the far bank at 55 m measured DARKER than the
  // near trunk at 12 m, and the near trunk's silhouette against the mist beside
  // it read at 1.35:1 where a misty jungle wants 3-5:1 and takes its whole depth
  // cue from it. sky.setFog() is a public API this level had never called.
  //
  // Under the 'overcast' deck sky.js overrides heightScale, mieG, startDistance
  // and desaturate with its own preset (34 m, 0.30, 1.4 m, 0.30 - all of which
  // are already right for a 25 m canopy), and takes DENSITY as a multiple of
  // whatever this file authors. So density is the one number worth publishing,
  // and it is the one that lifts the distance.
  LevelJungle.prototype._applyFog = function () {
    var sky = this.ctx && this.ctx.sky;
    if (!sky || typeof sky.setFog !== 'function') return;
    try {
      // 0.0175 authored -> 0.023-0.039 effective once the overcast deck's 2.2x
      // multiplier is on it, against 0.0198-0.0330 before. Modest on purpose:
      // the effective number was already inside the range a misty jungle wants,
      // so most of the missing depth was never the fog - it was that the near
      // field had an anti-crush floor under it (the foliage emissive and the
      // ground vertex floor, both pulled back in this pass) and the far field
      // had nothing lifting it. glowGain is the one aerial-perspective control
      // the overcast deck does NOT override.
      // MEASURED AND PULLED BACK. At 0.0148 / 1.10 the inscatter term made the
      // EMPTY MIDDLE DISTANCE the subject of the signature frame: the 20-60 m
      // band measured median 0.624 / p95 0.795 at saturation 0.202 - the
      // brightest, largest and least saturated region in the picture - while
      // the firebase it is supposed to be about sat at 0.252 and the near
      // ground at 0.289. Fog is a depth cue, not a light source; glowGain is
      // the one aerial-perspective control the overcast deck does not override
      // and it is what was lifting the void.
      sky.setFog({ density: 0.0100, glowGain: 0.80 });
    } catch (e) { GAME.logError('jungle.fog', e); }
  };

  // The sea shader lays scum and foam along whatever edges it is given. Without
  // them the river is a clean plane butted against the bank, which is the
  // clearest possible statement that it IS a plane.
  LevelJungle.prototype._publishFoam = function () {
    var lib = this.ctx && this.ctx.materials;
    if (!lib || typeof lib.setWaterFoamEdges !== 'function') return;
    var segs = [];
    var zs = [-52, -36, -20, -6, 8, 22, 36, 50, 64];
    for (var i = 0; i + 1 < zs.length && segs.length < 14; i++) {
      var z0 = zs[i], z1 = zs[i + 1];
      segs.push([riverC(z0) + riverHalf(z0), z0, riverC(z1) + riverHalf(z1), z1]);
      if (segs.length < 14) {
        segs.push([riverC(z0) - riverHalf(z0), z0, riverC(z1) - riverHalf(z1), z1]);
      }
    }
    try { lib.setWaterFoamEdges(segs); }
    catch (e) { GAME.logError('jungle.foam', e); }
  };

  // ---- spawns and the published framings -------------------------------------
  LevelJungle.prototype._buildSpawns = function () {
    var self = this;
    var P = this.plan;
    var V = THREE.Vector3;

    function sp(x, z, yaw, yOff) {
      self.spawnPoints.push({
        position: new V(x, self.sampleGround(x, z) + (yOff || 0.03), z), yaw: yaw
      });
    }
    function pose(px, py, pz, tx, ty, tz) {
      var dx = tx - px, dy = ty - py, dz = tz - pz;
      var horiz = Math.sqrt(dx * dx + dz * dz);
      return {
        position: new V(px, py, pz),
        yaw: Math.atan2(-dx, -dz),
        pitch: Math.atan2(dy, Math.max(1e-4, horiz))
      };
    }

    // [0] is the player: the southern landing, on the track, facing north up it
    // with the whole approach to the firebase ahead.
    sp(trackX(57) + 0.8, 57, 0.03);
    sp(trackX(48) - 1.4, 48, 0.02);
    sp(trackX(39) + 2.0, 39, -0.06);
    sp(trackX(30) - 1.8, 30, 0.04);
    sp(trackX(20) + 1.6, 20, 0.02);
    sp(trackX(10) - 2.2, 10, 0.0);
    sp(trackX(2) + 2.4, 2, 0.0);
    sp(P.gate.x - 1.4, P.gate.z + 2.2, 0.0);
    sp(P.helipad.x, P.helipad.z, 2.6);
    sp(P.mortar.x - 3.4, P.mortar.z + 1.0, 1.9);
    var bkA = this.anchors.bunker;
    sp(bkA.centre.x + 2.4, bkA.centre.z + 5.0, 3.14);
    sp(P.heli.x + 5.0, P.heli.z + 2.5, -1.5);
    sp(P.bridge.x + 1.6, P.bridge.nearZ + 2.0, 0.0);
    sp(P.sluice.x + 3.0, P.sluice.z + 3.0, -1.0);

    var g;

    // ---- HERO1 : the signature image ---------------------------------------
    // Standing in the track ruts at z = 48, west of the crown so the road
    // curves away to the right, looking north. Six depths, and each one is a
    // different KIND of thing, which is what stops a canopy frame collapsing
    // into one wash of green:
    //   * 0-2 m  elephant grass at the verge, in the bottom corners
    //   * 5-8 m  the fallen trunk lying across the road - the foreground bar
    //   * 10 m   the spirit house on the right verge, the only warm mark
    //   * 12 m   the canopy gap: a shaft landing in the ruts, with mist in it
    //   * 21 m   the collapsed bamboo footbridge over the creek
    //   * 40 m+  the track climbing to the firebase, dissolving into vapour
    // The aim is at the road surface 15 m out rather than at the vanishing
    // point, which puts the canopy ceiling on the upper third for free and
    // keeps the bright overcast out of the top of the frame - a jungle whose
    // top half is sky is not a jungle, and it is also how a vertical imbalance
    // metric goes to four.
    var h1z = 48.0;
    var h1x = trackX(h1z) - 1.45;
    g = this.sampleGround(h1x, h1z);
    var hero1 = pose(h1x, g + 1.66, h1z,
      trackX(33.0), this.sampleGround(trackX(33.0), 33.0) + 1.15, 33.0);

    // ---- HERO2 : the wreck --------------------------------------------------
    // SOLVED, not guessed. The requirement is specific: the camera has to be on
    // the LAND side so the airframe is read against the bright river rather
    // than against more forest, close enough that the rotor and the torn boom
    // are legible, and high enough on the bank to see the skids in the water
    // without turning the shot into a plan view. A fan of bearings is scored
    // against exactly those three things.
    var hx = P.heli.x, hz = P.heli.z, hy = P.heli.y;
    // AUTHORED, NOT SEARCHED, and the reason is worth recording. Three rounds of
    // scored search were run over the bank and every one of them traded the
    // subject away for its own scoring terms: the first stood off the TAIL
    // quarter, where a slick is a box seen end-on; the second found clear ground
    // seventeen metres out and made the wreck a detail; the third walked down to
    // the waterline and put a mangrove clump across half the frame. The pose has
    // exactly one correct answer - square onto the fuselage, at ten metres, on
    // the bank - and plan() has already cleared the understory and the mangroves
    // along that bearing (P.camMarks). Searching for something the plan has
    // already decided just gives the search a chance to be wrong.
    var beam = P.heli.yaw + Math.PI * 0.5;
    var bx0 = Math.sin(beam), bz0 = Math.cos(beam);
    var hd2 = 10.0, hcx = 0, hcz = 0, hcy = 0;
    for (var hstep = 0; hstep < 7; hstep++) {
      hcx = hx + bx0 * hd2; hcz = hz + bz0 * hd2;
      hcy = this.sampleGround(hcx, hcz);
      // step back only if the mark landed in the water
      if (hcy > WATER_Y + 0.35) break;
      hd2 += 1.2;
    }
    var hero2 = pose(hcx, hcy + 1.62, hcz, hx, hy + 1.75, hz);

    // ---- HERO3 : the watchtower, and the verticality ------------------------
    // Standing on the PSP at the north end of the firebase looking back south
    // across it. The brazier is 13 m out on the left third with its own light
    // on the sandbags around it; the command bunker's shell-holed roof closes
    // the left edge; the tower is 19 m away at centre-right with its whole
    // 10.7 m in frame from underneath, and the canopy stands behind it - which
    // is the point, because a tower photographed against sky could be anywhere.
    // MEASURED, NOT GUESSED. From the old standpoint the tower bore 0.891 rad
    // and the brazier 0.434 - twenty-six degrees apart - and the pose aimed
    // straight at the tower, so the tower sat on the vertical centreline with
    // the crosshair on it and the viewmodel filling the lower right, while the
    // brazier (the shot's only warm source, and the whole reason the framing
    // exists) fell outside the frame entirely. Stepping 3.4 m right along the
    // camera's own right vector and aiming 14 degrees left of the tower puts
    // the tower on the RIGHT third and the fire on the LEFT third with its
    // light on the revetment behind it, which is the composition the pose was
    // always described as having.
    var TW = this.anchors.tower;
    var camL = P.h3Cam || P.fbW(-4.0, -11.0);
    var h3g = this.sampleGround(camL[0], camL[1]);
    // AIM OFF THE SUBJECT, NOT AT IT. pose() derives yaw from the target, so
    // aiming at the tower puts the tower on the crosshair no matter where the
    // camera stands. The target is therefore a point 19 degrees LEFT of the
    // tower's bearing, at the tower's own range - which lands the tower on the
    // right third and swings the brazier into the left third with its light on
    // the revetment behind it. Aimed at the tower's WAIST, not its base: from
    // nineteen metres a 10.7 m mast has to cross the frame diagonally or its
    // height does not read at all.
    var t3x = TW.base.x - camL[0], t3z = TW.base.z - camL[1];
    var t3d = Math.sqrt(t3x * t3x + t3z * t3z) || 1;
    var t3b = Math.atan2(t3x, t3z) - 0.300;
    var hero3 = pose(camL[0], h3g + 1.34, camL[1],
      camL[0] + Math.sin(t3b) * t3d, P.firebase.y + 6.2,
      camL[1] + Math.cos(t3b) * t3d);

    // ---- INTERIOR : the command bunker --------------------------------------
    // Just inside the doorway, looking across the cone of light coming through
    // the shell hole. Solved from the bunker's own geometry (see buildBunker)
    // so it can never drift off the hole it exists to photograph.
    var interior;
    if (this.builtBunker && this.builtBunker.interiorEye) {
      var ie = this.builtBunker.interiorEye, it = this.builtBunker.interiorTarget;
      interior = pose(ie.x, this.builtBunker.floorY + 1.58, ie.z, it.x, it.y, it.z);
    } else {
      var bc = this.anchors.bunker;
      interior = pose(bc.centre.x, bc.floorY + 1.58, bc.centre.z + 3.0,
        bc.centre.x, bc.floorY + 1.2, bc.centre.z - 3.0);
    }

    // ---- OVERVIEW ------------------------------------------------------------
    // From the watchtower platform. This is the ONLY place in the level you can
    // get above the understory, which is the honest answer for a jungle: there
    // is no hillside to stand on because the canopy is 25 m tall and closed.
    // From up here the firebase is laid out below, the track runs away south
    // through the canopy, the river opens on the right, and the far bank goes
    // into vapour - the whole level in one frame, in four depths.
    // The pose stands BACK on the platform rather than out at its lip, so the
    // near rail, the plank deck and the corner post are all in the bottom of
    // the frame: an establishing shot needs a near plane, and the only one
    // available at nine metres up is the tower itself. Aiming 30 m out at
    // ground + 2.4 rather than 40 m out at ground + 4.0 drops the horizon and
    // puts the firebase floor across the lower half instead of the roof.
    var tYaw = P.tower.yaw;
    var fwdX = Math.sin(tYaw), fwdZ = Math.cos(tYaw);
    var tp = (this.builtTower && this.builtTower.platform) || null;
    var ovx = (tp ? tp.x : TW.base.x) + fwdX * 2.05;
    var ovy = (tp ? tp.y : TW.platformY) + 1.66;
    var ovz = (tp ? tp.z : TW.base.z) + fwdZ * 2.05;
    var ovtx = ovx + fwdX * 26.0, ovtz = ovz + fwdZ * 26.0;
    var overview = pose(ovx, ovy, ovz,
      ovtx, this.sampleGround(M.clamp(ovtx, X_MIN, X_MAX),
        M.clamp(ovtz, Z_MIN, Z_MAX)) + 2.0, ovtz);

    // ---- HERO4 : the firebase from outside the wire --------------------------
    // Not one of the five standard keys, so nothing is obliged to shoot it - but
    // the level's whole subject is a fortified knoll in a forest and no
    // published framing ever showed it as a SILHOUETTE. From the knoll shoulder
    // to the north-west the wire, the revetment, the tower and the mast stack up
    // against the canopy in one read.
    var h4b = P.fbW(-24.0, 6.0);
    var h4g = this.sampleGround(h4b[0], h4b[1]);
    var hero4 = pose(h4b[0], h4g + 1.66, h4b[1],
      P.tower.x, P.firebase.y + 5.4, P.tower.z);

    this.cameraPoses = {
      overview: overview, hero1: hero1, hero2: hero2, hero3: hero3,
      interior: interior, hero4: hero4,
      // kept so an operator can ask for them by the level's own names too
      track: hero1, wreck: hero2, firebase: hero3, bunker: interior,
      tower: overview, knoll: hero4
    };
  };

  // ---- nav ---------------------------------------------------------------------
  LevelJungle.prototype._buildNav = function () {
    var cell = 0.85;
    var ox = X_MIN + 2, oz = Z_MIN + 2;
    var w = Math.ceil((X_MAX - 2 - ox) / cell);
    var h = Math.ceil((Z_MAX - 2 - oz) / cell);
    var walkable = new Uint8Array(w * h);
    var height = new Float32Array(w * h);
    var obst = [], i;
    var min = new THREE.Vector3(), max = new THREE.Vector3();
    for (i = 0; i < this.colliders.length; i++) {
      var c = this.colliders[i];
      if (c.floor) continue;
      GAME.Collision.boxBounds(c, min, max);
      obst.push([min.x - 0.30, max.x + 0.30, min.z - 0.30, max.z + 0.30, min.y, max.y]);
    }
    for (var iz = 0; iz < h; iz++) {
      var z = oz + (iz + 0.5) * cell;
      for (var ix = 0; ix < w; ix++) {
        var x = ox + (ix + 0.5) * cell;
        var idx = iz * w + ix;
        var y = this.sampleGround(x, z);
        height[idx] = y;
        // deep water is not walkable; the shallows and the mud bars are
        if (y < WATER_Y - 0.55) continue;
        // nor is the steep ground of the rim or the creek scarp
        var s1 = this.sampleGround(x + cell, z), s2 = this.sampleGround(x, z + cell);
        if (Math.abs(s1 - y) > 0.85 || Math.abs(s2 - y) > 0.85) continue;
        var ok = 1;
        for (i = 0; i < obst.length; i++) {
          var o = obst[i];
          if (x < o[0] || x > o[1] || z < o[2] || z > o[3]) continue;
          if (o[5] > y + 0.42 && o[4] < y + 1.80) { ok = 0; break; }
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
  LevelJungle.prototype._buildBroadphase = function () {
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

  LevelJungle.prototype.raycast = function (origin, dir, maxDist) {
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
    var ix = Math.floor(origin.x / cell), iy = Math.floor(origin.y / cell);
    var iz = Math.floor(origin.z / cell);
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
  // The delta itself is static. What is not: the air moves the leaves, the fire
  // in the drum and the two candles are flames rather than lamps, and the
  // wreck's beacon is still cycling on a dying battery.
  //
  // The wetness line is the one that matters. materials.js only drives its soak
  // layer on levels whose registry entry declares a weather preset, and this
  // level declares its drizzle inside `env` instead - so the whole wet contract
  // would sit at zero on a level whose brief is "humid drizzle, water dripping
  // from leaves". setWetness/setRainIntensity are public API and this is what
  // they exist for: the level knows it is raining even when the registry
  // heuristic does not.
  LevelJungle.prototype.update = function (dt, ctx) {
    this._t += (dt || 0);
    var t = this._t;
    this._clock.value = t;

    try {
      var lib = ctx && ctx.materials;
      var w = ctx && ctx.weather;
      if (lib && w && !lib.wetEnabled) {
        if (typeof lib.setWetness === 'function' && isFinite(w.wetness)) {
          lib.setWetness(w.wetness);
        }
        if (typeof lib.setRainIntensity === 'function' && isFinite(w.rainIntensity)) {
          lib.setRainIntensity(w.rainIntensity);
        }
        if (typeof lib.setWind === 'function' && w.windDir && isFinite(w.windSpeed)) {
          lib.setWind(w.windDir.x, w.windDir.y, w.windSpeed);
        }
      }
      // The leaves are wet too. Both slots are initialised non-zero in
      // _foliageMaterial, so USE_CLEARCOAT and USE_SHEEN are already compiled
      // in and this is a uniform update rather than a shader rebuild.
      // The rings stop when the rain does.
      if (this._rainAmt && w && isFinite(w.rainIntensity)) {
        this._rainAmt.value = 0.30 + 0.85 * M.saturate(w.rainIntensity);
      }
      var bm = this._bladeMat;
      if (bm && w && isFinite(w.wetness)) {
        var wetF = M.saturate(w.wetness);
        bm.clearcoat = 0.05 + 0.32 * wetF;
        bm.clearcoatRoughness = 0.42 - 0.20 * wetF;
        bm.sheen = 0.40 + 0.44 * wetF;
      }
    } catch (e) { /* the level renders dry rather than not at all */ }

    // Flame, driven by two decorrelated noise bands and never a sine: a sine
    // reads as an animation curve within about two cycles.
    var m = this._litMat;
    if (m) {
      var f1 = this.noise.fbm2(t * 2.7, 3.1, 3, 2, 0.5);
      var f2 = this.noise.perlin2(t * 0.83, 17.4);
      m.emissiveIntensity = 6.2 * M.clamp(1.0 + f1 * 0.34 + f2 * 0.20, 0.42, 1.75);
    }
    var m2 = this._litMat2;
    if (m2) {
      // a dying rotating beacon: mostly off, a hard flash, a slow decay
      var ph = (t * 0.72) % 1;
      var flash = Math.pow(M.saturate(1 - ph * 3.0), 2.0);
      m2.emissiveIntensity = 0.35 + 4.2 * flash;
    }
  };

  GAME.LevelJungle = LevelJungle;
})(window.GAME, window.THREE);
