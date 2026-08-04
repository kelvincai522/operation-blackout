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
    // MOSS HAS TO BE AUTHORED AGAINST THIS LEVEL'S ILLUMINANT, NOT AGAINST A
    // COLOUR PICKER. Measured off the delivered frame, the light in here -
    // sky.js's civil-twilight key at (1.00 0.44 0.17), the horizon-glow half
    // of the IBL and postfx's dawn volumetrics, which are the same orange -
    // has a red:green ratio of about 3:1. Run a physically honest moss albedo
    // (0x5d6647, linear G/R = 1.21) through that and it comes out BROWN: the
    // whole level measured 0.15% of pixels with G above both R and B, against
    // the shipped market's 3.2%, and 66% of hero1's saturated pixels landed in
    // one 30-degree hue bin. The albedo has to carry a linear G/R above ~3 for
    // green to survive to the print at all. 0x3c7a2c measures 4.31, which
    // lands the rendered surface at G/R ~1.4 - unmistakably moss, and nowhere
    // near lurid once the orange key has had its way with it.
    mossy:      { uv: 0.42, cast: true,  recv: true, base: 'stone',
                  alb: 0x2a5417, rough: 0.94, hue: 0.98 },
    laterite:   { uv: 0.36, cast: true,  recv: true, base: 'rubble',
                  alb: 0x7d5f49, rough: 0.94, hue: 0.75 },
    // 0x8b8270, not 0x847763. sky.js publishes this level's ground albedo as
    // [0.230 0.215 0.165] linear and the whole exposure, the IBL's lower
    // hemisphere and the fog inscatter were balanced against it; 0x847763
    // measures [0.229 0.180 0.128], i.e. the level's single largest surface
    // sat 16% low in green and 22% low in blue against the number every other
    // system was solved for. On a floor lit by SKY ALONE - which is what the
    // whole precinct is at a 9.6-degree sun - that is most of the difference
    // between a lit ground plane and an unlit one, and an unlit ground plane
    // is on the instant-fail list. 0x8b8270 measures [0.258 0.223 0.169].
    paving:     { uv: 0.34, cast: false, recv: true, base: 'stone',
                  alb: 0x8b8270, rough: 0.88, hue: 0.45 },
    // The ONE surface on the plain-multiply path. Its vertex colours are hue
    // (moss green, leaf litter, pale silt at every water line), and the wear
    // convention has no vocabulary for hue - run through it, a green ground
    // reads as a dirty one. Everything else in the level wants grime/wet/edge
    // and stays on 'wear'.
    earth:      { uv: 0.30, cast: false, recv: true, base: 'dirt', mult: true,
                  alb: 0x6f6650, rough: 0.96, hue: 0.55 },
    // BARK IS ITS OWN MATERIAL, generated in this file. It used to point at
    // materials.js's 'wood_plank' - a SAWN TIMBER recipe - on a worldUV
    // cylinder, which produced regular horizontal ring seams down every
    // strangler-fig root and made them read as corrugated hose. wood_plank is
    // also the wrong VALUE: at 0x796f5e the roots measured 0.354 mean against
    // 0.232 for the masonry behind them, i.e. the second-brightest mass in
    // hero2. This recipe is vertical fibre with deep fissures, mapped off
    // limb()'s own arc-length uv, at 0x5f5648 so a root sits BELOW the stone.
    bark:       { uv: 1.40, cast: true,  recv: true, own: 'bark', keepUV: true },
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
    mossy:      [0x2a5417, 0.94, 0.0],
    laterite:   [0x7d5f49, 0.94, 0.0],
    paving:     [0x8e8778, 0.88, 0.0],
    earth:      [0x4a4030, 0.96, 0.0],
    bark:       [0x5f5648, 0.94, 0.0],
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
  // The default chamfer was 18 mm. On a 1.6 m sandstone block that is a razor
  // arris - the single loudest "this is a computer model" tell in the first
  // capture round, and the one thing on the list that costs NOTHING to fix:
  // bevelBox insets the corner vertices of a 12-triangle box, so a 45 mm
  // chamfer is exactly as expensive as an 18 mm one and every course in the
  // level suddenly catches a highlight along its top arris.
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.048, Math.min(w, Math.min(h, d)) * 0.20);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) {
      var src = Geo.bevelBox(w, h, d, bevel);
      g = src.toNonIndexed(); src.dispose();
      _boxCache.set(k, g);
    }
    return g;
  }

  // Quantised arris sizes. A block picks one of five rather than a continuous
  // value, so a wall's arrises vary from dressed-and-sharp to eaten-away
  // without multiplying the geometry cache by the number of blocks in the
  // level - the width/depth jitter already makes every entry unique enough.
  // Measured and pulled back: at a 9.5 cm top value two adjacent blocks put
  // 19 cm of chamfer into one joint, and photographed at 1.5 m in the gallery
  // the coursing read as a stack of shelves with black slots between them
  // rather than as ashlar. The point of the spread is that some arrises are
  // dressed and some are eaten away, not that every joint is a groove.
  var BEVELS = [0.013, 0.022, 0.034, 0.048, 0.066];

  // -------------------------------------------------------------- relief box --
  // A BLOCK THAT HAS BEEN EATEN, not a block with an eaten texture on it.
  //
  // Photographed at 1.5 m inside the gallery, every wall block in the level was
  // a mathematically perfect rectangular prism: four dead-flat faces, one
  // uniform chamfer on every arris, and materials.js's 5 cm mineral detail
  // normal spread over all of it at one scale. Measured, that reads as an
  // isotropic sandpaper speckle on cardboard, and no amount of albedo variation
  // fixes it, because the thing that is missing is not colour - it is that
  // nine hundred monsoons take stone away UNEVENLY. Differential erosion is a
  // shape.
  //
  // bevelBox at one segment is 8 corners; at two it is a 3 x 3 grid on every
  // face, i.e. a centre vertex, four arris midpoints and the corners - which is
  // the minimum topology that can carry
  //
  //   * a DISHED face   (the centre pulled in, so a face has a hollow and its
  //                      normal varies across it: the shading gradient a
  //                      9.6-degree key cannot otherwise put on a wall),
  //   * a WAVY ARRIS    (each midpoint pulled in a different amount, so no
  //                      edge in the level is a straight line any more),
  //   * a LOST CORNER   (one in four pulled in hard, which is a real chip with
  //                      a real silhouette rather than a chamfer).
  //
  // 48 triangles instead of 12. Measured over the whole level that is about
  // +230k triangles against 3.4M of headroom, which is what the headroom is
  // for. The displacement is hashed off the vertex's own LOCAL position plus a
  // per-block seed, so the three duplicate copies of a shared corner move
  // identically and the block stays welded; and it is applied to the INDEXED
  // geometry before computeVertexNormals, so a face is smooth across its hollow
  // while the arrises between faces stay hard.
  var _reliefCache = new Map();
  function frac(v) { return v - Math.floor(v); }
  function rhash(x, y, z, s) {
    return frac(Math.sin(x * 37.13 + y * 61.71 + z * 19.37 + s * 7.117) * 43758.5453);
  }
  function reliefBox(w, h, d, bevel, seed) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.048, Math.min(w, Math.min(h, d)) * 0.20);
    seed = seed | 0;
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' +
      bevel.toFixed(3) + ',' + seed;
    var g = _reliefCache.get(k);
    if (g) return g;
    var src;
    try { src = Geo.bevelBox(w, h, d, bevel, 2); }
    catch (e) { return box(w, h, d, bevel); }
    var p = src.attributes.position;
    var hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
    var lim = Math.min(w, Math.min(h, d));
    // MEASURED AND PULLED BACK, and it is the same trap the BEVELS table fell
    // into one round earlier. At a 5.2 cm scale a chipped corner lost 19 cm and
    // an eaten arris 12 cm; photographed at 60 cm inside the gallery, two
    // adjacent blocks put a third of a metre of void into one joint and the
    // coursing read as a stack of shelves with black canyons between them - on
    // top of the 6.6 cm chamfer each block already carries. The dish in the
    // FACE is what buys the differential erosion; the eat-back on the ARRIS
    // only has to stop the edge being a straight line. So the scale comes down
    // to 4 cm, the hard chip gets rarer (16% of corners, not 26%) and the
    // typical arris now moves under 2 cm.
    var dish = Math.min(0.040, lim * 0.13);
    var eps = bevel + 1e-4;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ax = Math.abs(x) >= hw - eps, ay = Math.abs(y) >= hh - eps,
        az = Math.abs(z) >= hd - eps;
      var n = (ax ? 1 : 0) + (ay ? 1 : 0) + (az ? 1 : 0);
      if (!n) continue;
      var r1 = rhash(x, y, z, seed);
      var r2 = rhash(z, x, y, seed + 11);
      var amt;
      if (n === 1) amt = dish * (0.28 + 0.62 * r1);                 // a hollow
      else if (n === 2) amt = dish * (r2 < 0.18 ? 0.62 + 0.62 * r1  // eaten back
        : 0.08 + 0.34 * r1);                                        // or just wavy
      else amt = dish * (r1 < 0.16 ? 0.85 + 0.85 * r2               // corner gone
        : 0.10 + 0.35 * r2);
      if (ax) x -= (x < 0 ? -1 : 1) * amt;
      if (ay) y -= (y < 0 ? -1 : 1) * amt;
      if (az) z -= (z < 0 ? -1 : 1) * amt;
      p.setXYZ(i, x, y, z);
    }
    src.computeVertexNormals();
    g = src.toNonIndexed(); src.dispose();
    _reliefCache.set(k, g);
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

  // A tapered, bent, FLUTED limb - tree trunks, buttress roots, the roots
  // pouring over the gallery wall. `pts` is [[x,y,z,r], ...].
  //
  // Round one emitted these at 6 radial segments with a constant per-station
  // radius, and every strangler-fig root in hero2 photographed as plastic
  // drainpipe: a visibly hexagonal tube of constant diameter with the sawn
  // horizontal ring seams of the 'wood_plank' recipe running across it. Three
  // things fix that and all three are in here now:
  //
  //   * 14+ radial segments, so the silhouette is a curve and not a hexagon;
  //   * a per-STATION radius driven by noise - a real aerial root bulges and
  //     pinches every 30-60 cm where it has gripped and let go - plus 3-5
  //     longitudinal flutes at a per-limb phase, so the cross-section is lobed
  //     and the silhouette has lobes to catch the rim light;
  //   * REAL UVS IN METRES. u runs around the circumference, v runs along the
  //     limb's own arc length, so the bark's vertical fibre runs along the
  //     root instead of a world-planar projection banding it into rings.
  function limb(pts, seg, opt) {
    seg = seg || 14;
    opt = opt || {};
    var uvm = opt.uv || 0.55;            // metres per uv unit
    var phase = opt.phase || 0;
    var lobes = opt.lobes === undefined ? 4 : opt.lobes;
    var flute = opt.flute === undefined ? 0.13 : opt.flute;
    var bulge = opt.bulge === undefined ? 0.16 : opt.bulge;
    var N = opt.noise || null;
    var pos = [], nor = [], uvs = [], i, j;
    var rings = [], vlen = [0];
    for (i = 1; i < pts.length; i++) {
      var ddx = pts[i][0] - pts[i - 1][0], ddy = pts[i][1] - pts[i - 1][1],
        ddz = pts[i][2] - pts[i - 1][2];
      vlen.push(vlen[i - 1] + Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz));
    }
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
      // per-station swell: a root is never a cone
      var sw = 1;
      if (N) sw = 1 + N.fbm2(vlen[i] * 2.1 + phase * 3.7, phase * 1.9, 2) * bulge * 2;
      else sw = 1 + Math.sin(vlen[i] * 4.6 + phase) * bulge;
      var ring = [];
      for (j = 0; j <= seg; j++) {
        var jj = j % seg;
        var ang = jj / seg * Math.PI * 2;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        // longitudinal flutes, phase-locked along the limb so a groove RUNS
        var rr = p[3] * sw * (1 + flute * Math.cos(ang * lobes + phase) +
          0.05 * Math.cos(ang * (lobes * 2 + 1) - phase * 0.6 + vlen[i] * 0.5));
        var dx = (sx * ca + tx * sa), dy = (sy * ca + ty * sa), dz = (sz * ca + tz * sa);
        ring.push([p[0] + dx * rr, p[1] + dy * rr, p[2] + dz * rr, dx, dy, dz,
          (j / seg) * (Math.PI * 2 * Math.max(0.05, p[3])) / uvm, vlen[i] / uvm]);
      }
      rings.push(ring);
    }
    for (i = 0; i + 1 < rings.length; i++) {
      var r0 = rings[i], r1 = rings[i + 1];
      for (j = 0; j < seg; j++) {
        var A = r0[j], B = r0[j + 1], C = r1[j + 1], D = r1[j];
        pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        nor.push(A[3], A[4], A[5], B[3], B[4], B[5], C[3], C[4], C[5]);
        uvs.push(A[6], A[7], B[6], B[7], C[6], C[7]);
        pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        nor.push(A[3], A[4], A[5], C[3], C[4], C[5], D[3], D[4], D[5]);
        uvs.push(A[6], A[7], C[6], C[7], D[6], D[7]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
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
    // Set while a carved face is being emitted. _paint uses it to bake
    // CONCAVITY OCCLUSION into the vertex colours - see the note there.
    this.faceTag = null;
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
    var e = { geometry: geo, matrix: wm, wear: this.wear, face: this.faceTag };
    b.push(e); this.count++;
    return e;
  };
  Builder.prototype.box = function (key, w, h, d, x, y, z, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z));
  };
  Builder.prototype.boxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(key, box(w, h, d, bevel), makeM(x, y, z, rx, ry, rz));
  };
  // The same, on the eroded atom. `relief` is recorded on the entry because
  // _paint's arris test works in NORMALISED local coordinates and a relief
  // block's corners have been pulled 2-7 cm inside its own bounding box; at the
  // 0.88 threshold a small one would fall out of its own edge band and lose the
  // pale-substrate paint that the chip in its silhouette has just earned.
  //
  // 0.78 is not a full restoration and that is deliberate. On a 1.5 x 0.6 x 0.9
  // wall block the long axes still clear it (0.89) while the 60 cm bed depth does
  // not (0.70), so what keeps the pale chip is the VERTICAL corner of each block
  // - which is where an arris really does spall and catch a raking key - and
  // what loses it is the horizontal top edge, which is the same surface the
  // up-facing gate in _paint is there to hold back anyway. The two mechanisms
  // agree; do not "fix" one without re-measuring the other.
  Builder.prototype.relBoxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel, seed) {
    var e = this.add(key, reliefBox(w, h, d, bevel, seed), makeM(x, y, z, rx, ry, rz));
    if (e) e.relief = 1;
    return e;
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
  // A limb between two points, in the WORLD frame. Bark geometry carries its
  // own metre-scale uv, so anything in the bark bucket has to come through
  // limb() rather than through box()/cyl() or its uv is a 0..1 face square
  // stretched over three metres of root.
  Builder.prototype.stick = function (key, ax, ay, az, bx, by, bz, r, seg, opt) {
    return this.add(key, limb([[ax, ay, az, r], [bx, by, bz, r * 0.92]],
      seg || 8, opt || { flute: 0.10, bulge: 0.10 }));
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
  function ctx2d(size, h) {
    var c = document.createElement('canvas');
    c.width = size; c.height = h || size;
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
  // 2048, not 1024. At a 256 px cell a 2.4 m moss mark carries 107 texels/m;
  // photographed at 4 m in a 107-degree frame that is 0.6 texels per pixel and
  // the mark reads as a flat patch of green PAINT, which is exactly how the
  // tier faces in the near field of hero1 came out. 512 px cells double it.
  function buildDecalAtlas(rng) {
    var S = 2048, C = S / ATLAS_N;
    var g = ctx2d(S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    var i, j;

    function cellOrigin(k) { return [(k % ATLAS_N) * C, ((k / ATLAS_N) | 0) * C]; }

    // ---- 0: moss sheet - the level's most-used mark -------------------------
    // TWO THINGS CHANGED AND BOTH WERE STRUCTURAL FAILURES, not tuning.
    //
    // (1) THE HUE. See the note on SURF.mossy: this level's illuminant runs
    //     about 3:1 red-to-green, so an honest moss albedo at linear G/R 1.85
    //     photographed as brown. These greens run 6-9:1 in linear, which is
    //     what it takes for the mark to still be moss after the key, the IBL's
    //     horizon half and the dawn volumetrics have all had a go at it.
    // (2) THE ALPHA. The decal material is alpha-blended, so a mark at 0.3-0.85
    //     is 15-70% of the WARM STONE UNDERNEATH. Compositing green over
    //     salmon at half strength gives olive, and olive is in hue bin 30, not
    //     in bin 90 - which is exactly why the "green pass" measured 0.53%
    //     while looking green to the eye. The core of a moss sheet is now
    //     opaque and only its frontier is transparent, which is also what a
    //     real moss sheet looks like.
    var o = cellOrigin(0);
    for (i = 0; i < 54; i++) {
      var mx = o[0] + rng.range(C * 0.14, C * 0.86);
      var my = o[1] + rng.range(C * 0.14, C * 0.86);
      var mr = rng.range(C * 0.07, C * 0.24);
      var v = rng.range(0, 1);
      g.globalAlpha = rng.range(0.68, 1.0);
      g.fillStyle = 'rgb(' + ((28 + v * 30) | 0) + ',' + ((96 + v * 58) | 0) + ',' +
        ((30 + v * 26) | 0) + ')';
      blob(g, mx, my, mr, rng, 3 + (i % 4), 1.0);
    }
    // dry, paler crust at the frontier - still green, just lighter and drier
    for (i = 0; i < 30; i++) {
      g.globalAlpha = rng.range(0.22, 0.55);
      g.fillStyle = rng.bool(0.5) ? 'rgb(112,158,72)' : 'rgb(78,124,54)';
      blob(g, o[0] + rng.range(C * 0.1, C * 0.9), o[1] + rng.range(C * 0.1, C * 0.9),
        rng.range(C * 0.03, C * 0.10), rng, 4, 1.2);
    }
    // a few near-black shadowed cushions, so the sheet has value range
    for (i = 0; i < 18; i++) {
      g.globalAlpha = rng.range(0.35, 0.80);
      g.fillStyle = 'rgb(18,44,20)';
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(0, C),
        rng.range(C * 0.02, C * 0.07), rng, 4, 1.2);
    }
    // ---- THE TWO HIGH-FREQUENCY OCTAVES ------------------------------------
    // Measured, this mark had 9.31e-3 of gradient energy against 18.37e-3 for
    // the STONE BLOCK UNDER IT: the moss carried half the surface detail of
    // the wall it sits on, when on a real masonry face a moss sheet is the
    // highest-frequency thing there is. Everything above works at 36-123 px in
    // a 512 px cell - three or four flat levels with polygon-stepped
    // boundaries, which at the interior's viewing distance is about 1.5 screen
    // pixels per texel and exposes the mask directly.
    //
    // A moss sheet is a colony of individual cushions 2-8 mm across. These two
    // passes are that: 1400 cushions at 3-10 px (6-20 mm at the new 0.9-1.2 m
    // footprint) and 2600 sporophyte specks at 1-3 px, both drawn only where
    // the sheet already is, so they break the flat levels up from the inside
    // instead of extending the mark.
    g.save();
    g.globalCompositeOperation = 'source-atop';
    for (i = 0; i < 1400; i++) {
      var hx0 = o[0] + rng.range(0, C), hy0 = o[1] + rng.range(0, C);
      var hv = rng.next();
      g.globalAlpha = rng.range(0.24, 0.62);
      g.fillStyle = hv < 0.34 ? 'rgb(20,58,22)'
        : (hv < 0.68 ? 'rgb(74,142,52)' : 'rgb(46,104,36)');
      blob(g, hx0, hy0, rng.range(C * 0.0055, C * 0.019), rng, 3 + (i % 3), 1.5);
    }
    // sporophyte capsules: the pin-sharp speckle that says "living surface"
    for (i = 0; i < 2600; i++) {
      g.globalAlpha = rng.range(0.28, 0.80);
      g.fillStyle = rng.bool(0.55) ? 'rgb(122,150,60)' : 'rgb(16,40,18)';
      var sr0 = rng.range(C * 0.0016, C * 0.0042);
      g.beginPath();
      g.arc(o[0] + rng.range(0, C), o[1] + rng.range(0, C), sr0, 0, 6.283);
      g.fill();
    }
    g.restore();
    g.globalAlpha = 1;

    // ---- 1: lichen rosettes -------------------------------------------------
    o = cellOrigin(1);
    for (i = 0; i < 70; i++) {
      var lx = o[0] + rng.range(C * 0.08, C * 0.92);
      var ly = o[1] + rng.range(C * 0.08, C * 0.92);
      var lr = rng.range(C * 0.012, C * 0.055);
      g.globalAlpha = rng.range(0.35, 0.85);
      var t = rng.next();
      g.fillStyle = t < 0.40 ? 'rgb(150,182,124)'
        : (t < 0.78 ? 'rgb(104,150,86)' : 'rgb(196,196,150)');
      blob(g, lx, ly, lr, rng, 5, 1.4);
      g.globalAlpha *= 0.5;
      g.fillStyle = 'rgb(52,84,44)';
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
    for (i = 0; i < 48; i++) {
      g.globalAlpha = rng.range(0.45, 0.95);
      var av = rng.next();
      g.fillStyle = av < 0.45 ? 'rgb(14,34,16)'
        : (av < 0.80 ? 'rgb(26,62,26)' : 'rgb(40,86,34)');
      blob(g, o[0] + rng.range(0, C), o[1] + rng.range(C * 0.25, C),
        rng.range(C * 0.05, C * 0.18), rng, 3, 1.3);
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
    grd9.addColorStop(0, 'rgba(34,96,32,0.98)');
    grd9.addColorStop(0.45, 'rgba(42,110,38,0.62)');
    grd9.addColorStop(1, 'rgba(58,124,50,0)');
    g.globalAlpha = 1; g.fillStyle = grd9;
    g.fillRect(o[0], o[1], C, C);
    for (i = 0; i < 54; i++) {
      g.globalAlpha = rng.range(0.35, 0.90);
      g.fillStyle = rng.bool(0.5) ? 'rgb(26,84,28)' : 'rgb(56,128,50)';
      blob(g, o[0] + rng.range(0, C), o[1] + C - Math.abs(rng.gaussian(0, C * 0.30)),
        rng.range(C * 0.02, C * 0.09), rng, 4, 1.3);
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

    // ---- FEATHER EVERY CELL --------------------------------------------------
    // A decal is a QUAD, and a mark whose alpha is still high where the quad
    // ends shows the quad. Once the moss cells were made opaque enough to
    // survive alpha-blending over warm stone (see cell 0) every moss mark on
    // the level turned into a hard-edged green RECTANGLE - visibly a decal,
    // pasted on. Erasing the outer eighth of each cell with a
    // destination-out ramp means the mark always dies out inside its own quad
    // and the only edge left is the moss's own frontier.
    (function () {
      var fp = C * 0.13;
      for (var fk = 0; fk < ATLAS_N * ATLAS_N; fk++) {
        var oo = cellOrigin(fk);
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.globalAlpha = 1;
        var sides = [
          [oo[0], oo[1], fp, C, oo[0], 0, oo[0] + fp, 0],
          [oo[0] + C - fp, oo[1], fp, C, oo[0] + C, 0, oo[0] + C - fp, 0],
          [oo[0], oo[1], C, fp, 0, oo[1], 0, oo[1] + fp],
          [oo[0], oo[1] + C - fp, C, fp, 0, oo[1] + C, 0, oo[1] + C - fp]
        ];
        for (var sq = 0; sq < 4; sq++) {
          var sv = sides[sq];
          var gr = g.createLinearGradient(sv[4], sv[5], sv[6], sv[7]);
          gr.addColorStop(0, 'rgba(0,0,0,1)');
          gr.addColorStop(0.55, 'rgba(0,0,0,0.45)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.fillRect(sv[0], sv[1], sv[2], sv[3]);
        }
        g.restore();
      }
    })();

    g.globalAlpha = 1;
    return g.canvas;
  }

  // A NORMAL MAP FOR THE MARKS, derived from the atlas's own alpha-weighted
  // luminance.
  //
  // The finding this answers: at 3x zoom the moss on the interior's right wall
  // resolved into three or four flat green levels with polygon-stepped
  // boundaries and NO INTERNAL TEXTURE - 9.31e-3 of gradient against 18.37e-3
  // for the stone under it. Extra octaves in the albedo (see cell 0) fix the
  // colour break-up, but a mark that carries no relief of its own still borrows
  // the HOST STONE'S normal, so a moss cushion lights exactly like the flat
  // sandstone it is pasted on and reads as paint whatever its albedo does.
  // A moss sheet standing 8-15 mm proud with a specular edge on every cushion
  // is the difference between growth and a stencil.
  //
  // Derived rather than authored because the alpha field IS the relief: where
  // the mark is opaque and bright it is a cushion crown, where it thins to its
  // frontier it lies down onto the stone. Per-cell strength keeps a water
  // stain flat (a stain is a colour change, not a surface) while the moss and
  // the root hair stand proud.
  var MARK_RELIEF = [
    1.65, 1.10, 0.22, 0.30,
    0.85, 0.55, 1.00, 0.45,
    1.25, 1.50, 0.35, 0.12,
    0, 0, 0, 0
  ];
  function buildDecalNormal(src) {
    if (!src) return null;
    var S = 1024;
    var g = ctx2d(S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    try { g.drawImage(src, 0, 0, S, S); }
    catch (e) { return null; }
    var img;
    try { img = g.getImageData(0, 0, S, S); }
    catch (e2) { return null; }
    var sd = img.data;
    var H = new Float32Array(S * S);
    var i, x, y;
    for (i = 0; i < S * S; i++) {
      var a = sd[i * 4 + 3] / 255;
      var lum = (sd[i * 4] * 0.30 + sd[i * 4 + 1] * 0.59 + sd[i * 4 + 2] * 0.11) / 255;
      H[i] = a * (0.28 + 0.72 * lum);
    }
    var out = g.createImageData(S, S);
    var od = out.data;
    var CS = S / ATLAS_N;
    for (y = 0; y < S; y++) {
      var row = ((y / CS) | 0) * ATLAS_N;
      var yu = y > 0 ? y - 1 : 0, yd2 = y < S - 1 ? y + 1 : S - 1;
      for (x = 0; x < S; x++) {
        var k = MARK_RELIEF[row + ((x / CS) | 0)];
        var xl = x > 0 ? x - 1 : 0, xr = x < S - 1 ? x + 1 : S - 1;
        var hx = H[y * S + xr] - H[y * S + xl];
        var hy = H[yd2 * S + x] - H[yu * S + x];
        var nx = -hx * 7.5 * k, ny = -hy * 7.5 * k, nz = 1.0;
        var l = Math.sqrt(nx * nx + ny * ny + 1);
        var o2 = (y * S + x) * 4;
        od[o2] = ((nx / l) * 0.5 + 0.5) * 255;
        od[o2 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
        od[o2 + 2] = ((nz / l) * 0.5 + 0.5) * 255;
        od[o2 + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
    return g.canvas;
  }

  // BARK. Vertical fibre and deep longitudinal fissures, tiled at 0.55 m per
  // uv unit off limb()'s arc-length parameterisation, so the grain runs ALONG
  // a root wherever that root goes. Returns [albedoCanvas, normalCanvas].
  function buildBarkTexture(rng, noise) {
    var S = 512;
    var g = ctx2d(S);
    if (!g) return null;
    var i, j, y;
    g.fillStyle = 'rgb(84,76,62)';
    g.fillRect(0, 0, S, S);
    // long fibres: many thin, slightly wandering vertical strokes
    for (i = 0; i < 900; i++) {
      var x = rng.range(0, S);
      var v = rng.next();
      var c = v < 0.34 ? 'rgba(52,46,36,' : (v < 0.70 ? 'rgba(104,95,76,' : 'rgba(132,120,94,');
      g.strokeStyle = c + rng.range(0.16, 0.55).toFixed(3) + ')';
      g.lineWidth = rng.range(0.8, 3.4);
      g.beginPath();
      g.moveTo(x, -4);
      var xx = x;
      for (j = 0; j <= 10; j++) {
        xx += rng.range(-2.2, 2.2);
        g.lineTo(xx, j / 10 * (S + 8) - 4);
      }
      g.stroke();
    }
    // fissures: dark, wide, wandering, with a pale lip on one side
    for (i = 0; i < 26; i++) {
      var fx = rng.range(0, S);
      var w = rng.range(3.5, 13.0);
      g.strokeStyle = 'rgba(30,26,20,' + rng.range(0.45, 0.85).toFixed(3) + ')';
      g.lineWidth = w;
      g.beginPath(); g.moveTo(fx, -6);
      var cx2 = fx;
      for (j = 0; j <= 12; j++) {
        cx2 += rng.range(-5.0, 5.0);
        g.lineTo(cx2, j / 12 * (S + 12) - 6);
      }
      g.stroke();
      g.strokeStyle = 'rgba(146,134,106,0.22)';
      g.lineWidth = Math.max(1, w * 0.30);
      g.stroke();
    }
    // lichen crust - the only place bark carries any chroma at all
    for (i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.06, 0.26);
      g.fillStyle = rng.bool(0.55) ? 'rgb(112,124,86)' : 'rgb(150,148,120)';
      blob(g, rng.range(0, S), rng.range(0, S), rng.range(S * 0.008, S * 0.05),
        rng, 5, 1.3);
    }
    g.globalAlpha = 1;
    var alb = g.canvas;

    // normal, derived from the same fibre field
    var gn = ctx2d(S);
    if (!gn) return [alb, null];
    var img = gn.createImageData(S, S);
    var d = img.data;
    function h(px, py) {
      return noise.fbm2(px * 0.32, py * 0.035, 3, 2.2, 0.55) * 1.0 +
        noise.fbm2(px * 1.20 + 17, py * 0.14 - 5, 2) * 0.42;
    }
    for (y = 0; y < S; y++) {
      for (var x2 = 0; x2 < S; x2++) {
        var hx = h(x2 + 1, y) - h(x2 - 1, y);
        var hy = h(x2, y + 1) - h(x2, y - 1);
        var nx = -hx * 2.4, ny = -hy * 0.9, nz = 1.0;
        var ln = Math.sqrt(nx * nx + ny * ny + nz * nz);
        var k = (y * S + x2) * 4;
        d[k] = ((nx / ln) * 0.5 + 0.5) * 255;
        d[k + 1] = ((ny / ln) * 0.5 + 0.5) * 255;
        d[k + 2] = ((nz / ln) * 0.5 + 0.5) * 255;
        d[k + 3] = 255;
      }
    }
    gn.putImageData(img, 0, 0);
    return [alb, gn.canvas];
  }

  // Canopy leaf clusters. 2 x 2 variants so no two cards on a tree carry the
  // same silhouette - a canopy of one repeated card reads instantly as cards.
  //
  // THE CELL IS 512 PX, NOT 256, AND THE LEAVES ARE SMALLER AND SPARSER.
  // Round one drew ~760 leaves of 3-7 px into a 256 px cell: 90% coverage, so
  // the individual leaves MERGED and what the silhouette actually showed was
  // the holes between them - the 60-100 px kidney beans that wreck the top
  // left of lv_overview and stamp the Buddha in hero2 with black amoebas.
  // Halving the leaf size, doubling the count and doubling the cell resolution
  // takes coverage to ~55%, quadruples texel density on a near card, and turns
  // both the silhouette and the cast shadow into dapple.
  function buildLeafTexture(rng) {
    var S = 1024, C = S / 2;
    var g = ctx2d(S);
    if (!g) return null;
    g.clearRect(0, 0, S, S);
    for (var v = 0; v < 4; v++) {
      var ox = (v % 2) * C, oy = ((v / 2) | 0) * C;
      // twigs first: a real cluster hangs off a visible armature
      g.globalAlpha = 0.85;
      g.strokeStyle = 'rgb(62,56,38)';
      for (var t = 0; t < 16; t++) {
        var a0 = (t / 16) * Math.PI * 2 + v * 0.4;
        g.lineWidth = rng.range(1.2, 2.8);
        g.beginPath();
        g.moveTo(ox + C * 0.5, oy + C * 0.5);
        g.lineTo(ox + C * (0.5 + Math.cos(a0) * rng.range(0.24, 0.46)),
          oy + C * (0.5 + Math.sin(a0) * rng.range(0.24, 0.46)));
        g.stroke();
      }
      var n = 2050 + (v * 71) % 260;
      for (var i = 0; i < n; i++) {
        // clustered along a few twigs rather than scattered
        var tw = (i % 16) / 16;
        var bx = ox + C * (0.5 + Math.cos(tw * 6.28 + v) * 0.28);
        var by = oy + C * (0.53 + Math.sin(tw * 6.28 + v) * 0.26);
        var lx = bx + rng.gaussian(0, C * 0.185);
        var ly = by + rng.gaussian(0, C * 0.175);
        if (lx < ox + 3 || lx > ox + C - 3 || ly < oy + 3 || ly > oy + C - 3) continue;
        // A card is 3-5 m across and the cell is 512 px, so a leaf at 1.0-2.2%
        // of the cell is a 4-10 cm leaf - which is what a silk-cotton leaflet
        // actually is, and small enough that 2000 of them do not merge.
        var lw = rng.range(C * 0.0095, C * 0.021);
        var la = rng.range(0, Math.PI * 2);
        var sh = rng.next();
        g.save(); g.translate(lx, ly); g.rotate(la);
        g.globalAlpha = rng.range(0.66, 1.0);
        // Authored against the level's 3:1 orange illuminant, not against a
        // colour picker - see SURF.mossy. At the honest greens this canopy
        // measured p90(G-R) = 0 in the delivered frame, i.e. the trees were
        // brown. These run linear G/R 4-6 and land the foliage at a rendered
        // G/R near 1.6.
        g.fillStyle = sh < 0.26 ? 'rgb(38,92,34)'
          : (sh < 0.55 ? 'rgb(54,124,46)'
            : (sh < 0.80 ? 'rgb(28,66,26)'
              : (sh < 0.93 ? 'rgb(82,156,60)' : 'rgb(122,158,52)')));
        g.beginPath();
        g.ellipse(0, 0, lw, lw * rng.range(0.30, 0.46), 0, 0, Math.PI * 2);
        g.fill();
        // midrib
        g.globalAlpha *= 0.55;
        g.strokeStyle = 'rgb(126,138,78)';
        g.lineWidth = 1.0;
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
    // THE FINE OCTAVE IS THE FIREFLY FACTORY AND IT HAS BEEN CUT BY TWO
    // THIRDS. Measured on hero3, the sun path over the moat resolved into a
    // field of discrete 2-4 pixel pure-white blobs with red/blue chromatic
    // fringes at 45.14e-3 of gradient energy - 3.4x the causeway beside it.
    // That is textbook specular aliasing: a normal map whose 3 cm ripple is
    // far below one screen pixel, driving a near-mirror BRDF. Mipmapping
    // averages the NORMAL correctly and the specular lobe wrongly, so the
    // only two levers that work are amplitude and roughness, and this is the
    // amplitude one. What is left is a 15-40 cm swell, which is the scale a
    // sheltered courtyard pool at dawn actually has and the scale that
    // survives minification as a broadening of the highlight rather than as a
    // handful of hot pixels.
    function h(x, y) {
      return noise.fbm2(x * 0.055, y * 0.055, 3, 2.1, 0.55) * 1.0 +
        noise.fbm2(x * 0.20 + 31.0, y * 0.20 - 12.0, 2) * 0.42 +
        noise.fbm2(x * 0.68 - 7.0, y * 0.68 + 19.0, 2) * 0.10;
    }
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var hx = h(x + 1, y) - h(x - 1, y);
        var hy = h(x, y + 1) - h(x, y - 1);
        var nx = -hx * 0.42, ny = -hy * 0.42, nz = 1.0;
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

  // Ground mist, as a TWO-CELL atlas.
  //
  //   left  (u 0..0.5)   a radially vignetted blob, for the flat layers
  //   right (u 0.5..1)   a BANK profile - dense along its bottom edge, thinning
  //                      to nothing by the top, soft at both ends - for the
  //                      upright cards that do the actual work.
  //
  // The bank cell is the one that matters and it did not exist. Measured on
  // hero3's far wall, saturation ROSE from 0.285 to 0.397 and luminance FELL
  // from 0.355 to 0.223 as the eye descended toward the ground: precisely
  // inverted from what a ground mist does, which is LIFT VALUE and KILL CHROMA
  // at ankle height. The level had three layers of mist cards and a volumetric
  // preset, and the delivered effect was a flat distance haze - because every
  // card was horizontal or nearly so, and a horizontal card seen from a 1.66 m
  // eye at 5-15 degrees of grazing presents almost no projected area and
  // contributes NOTHING between two objects at the same distance. Depth
  // separation is the whole read of this level and it was being asked of a
  // surface with no area.
  function buildMistTexture(noise) {
    var S = 256;
    var g = ctx2d(2 * S, S);
    if (!g) return null;
    var img = g.createImageData(2 * S, S);
    var d = img.data;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S - 0.5, v = y / S - 0.5;
        var r = Math.sqrt(u * u + v * v) * 2;
        var vig = M.smoothstep(1.0, 0.24, r);
        var n = noise.fbm2(x * 0.016 + 5.5, y * 0.016 - 2.5, 4, 2.2, 0.55) * 0.5 + 0.5;
        var n2 = noise.fbm2(x * 0.055 - 9.0, y * 0.055 + 4.0, 3) * 0.5 + 0.5;
        // ---- cell 0: the flat blob ---------------------------------------
        // A horizontal card covers every pixel below the horizon at a CONSTANT
        // alpha regardless of distance, which is the one thing real mist never
        // does. These only add local structure; the distance behaviour is the
        // sky's height fog and the bank cell.
        var a = M.saturate(vig * (n * 0.78 + n2 * 0.34 - 0.20)) * 0.26;
        var i = (y * (2 * S) + x) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = a * 255;
        // ---- cell 1: the bank --------------------------------------------
        // vv = 0 at the canvas TOP. CanvasTexture flips Y, so the canvas top
        // row lands at v = 1 - i.e. at the TOP of the card, where the bank has
        // to be thinnest. Density therefore runs with the canvas y.
        var vv = y / (S - 1);
        var lat = M.smoothstep(0.0, 0.16, x / S) * M.smoothstep(1.0, 0.80, x / S);
        // squared so the body of the bank sits in its lowest third and the
        // upper half is a torn frontier rather than a hem
        //
        // AND IT MUST GO TO ZERO AT THE BOTTOM EDGE TOO. THIS WAS THE BUG.
        //
        // vv = 1 is the canvas bottom row, which CanvasTexture's Y flip puts at
        // v = 0, i.e. at the card's BOTTOM POLYGON EDGE - and prof peaked at
        // exactly 1.0 there. So every bank card in the level ended in a straight
        // line of full-strength mist. Below the terrain that is invisible (the
        // card is sunk 12 cm), which is why it survived three rounds of review;
        // the moment the card crosses anything standing on the ground - a fallen
        // block, a slab, a plinth, a stair tread - that opaque hem emerges in
        // front of it as a dead-straight horizontal or diagonal edge. Measured
        // on hero1, the signature frame, it was cutting the foreground blocks at
        // 3.4 m and the great stair at 9 m, and it is what the critic read as
        // "a bright translucent wedge with a dead-straight edge", diagnosed as
        // a placement problem and treated with keep-out volumes for two rounds.
        //
        // No polygon edge of this cell may carry alpha: `lat` already closes the
        // sides, prof closes the top, and `hem` now closes the bottom. A card
        // with a soft frontier on all four edges can intersect any geometry at
        // any angle and read as air, which is also what let the near fade be
        // pulled back in so the level keeps its warm ground haze.
        var hem = M.smoothstep(1.0, 0.80, vv);
        var prof = vv * vv * (0.55 + 0.45 * vv) * hem;
        var nb = noise.fbm2(x * 0.021 - 3.5, y * 0.052 + 11.0, 4, 2.2, 0.58) * 0.5 + 0.5;
        var nb2 = noise.fbm2(x * 0.085 + 21.0, y * 0.16 - 6.0, 3) * 0.5 + 0.5;
        // 0.52, not 0.42: the hem costs the profile about a third of its peak,
        // and the point of the change is to lose the edge, not the medium.
        var ab = M.saturate(lat * prof * (nb * 1.05 + nb2 * 0.42 - 0.30)) * 0.52;
        var j2 = (y * (2 * S) + S + x) * 4;
        d[j2] = 255; d[j2 + 1] = 255; d[j2 + 2] = 255;
        d[j2 + 3] = ab * 255;
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
    // THE TWO COURTYARD SHEETS FLANK THE GREAT STAIR.
    //
    // The hero1 comment has always claimed "two sheets of standing water flank
    // the flight"; measured, court_west ran x -15.8..-2.7 (one wide sheet away
    // to the left, mostly outside the framing cone) and court_east sat at
    // x 3.2..12.6 z -6.6..0.8 - a third of which is under the tier-1 retaining
    // wall at z<-5 and therefore invisible. Neither flanked anything. They are
    // now a matched pair either side of the stair foot inside the 6.7 m strip
    // of open courtyard that actually exists between the terrace and the
    // gallery, which is the only place in this level a sheet CAN sit and be
    // seen from the courtyard floor.
    P.basins = [
      { name: 'court_west', x0: -13.8, x1: -4.6, z0: -4.6, z1: -0.9, depth: 0.32, soft: 1.4 },
      { name: 'court_east', x0: 4.6, x1: 12.4, z0: -4.5, z1: -0.8, depth: 0.28, soft: 1.4 },
      { name: 'srah', x0: -23.4, x1: -16.2, z0: -25.0, z1: -13.0, depth: 1.05, soft: 1.2 },
      { name: 'court_ne', x0: 14.6, x1: 21.8, z0: -20.8, z1: -13.4, depth: 0.30, soft: 1.5 },
      { name: 'east_pool', x0: 15.0, x1: 22.6, z0: -34.5, z1: -25.0, depth: 0.85, soft: 1.2 }
    ];
    P.pools = [
      { name: 'court_west', x0: -13.4, x1: -4.9, z0: -4.3, z1: -1.2, y: -0.130, algae: 0.55 },
      { name: 'court_east', x0: 4.9, x1: 12.0, z0: -4.2, z1: -1.1, y: -0.115, algae: 0.5 },
      { name: 'srah', x0: -23.0, x1: -16.6, z0: -24.6, z1: -13.4, y: -0.44, algae: 0.85 },
      { name: 'court_ne', x0: 14.9, x1: 21.5, z0: -20.4, z1: -13.8, y: -0.105, algae: 0.6 },
      { name: 'east_pool', x0: 15.4, x1: 22.2, z0: -34.1, z1: -25.4, y: -0.36, algae: 0.9 },
      // THE OUTER COURT SHEET, and it is a FILM ON THE PAVING rather than a
      // dug basin. The court sits in the gallery's own shadow at this hour -
      // measured, its flagstones came back at L 0.025 against 0.186 for the
      // gate they face, i.e. an unlit ground plane under the frame that was
      // moved here to cover it, which is on the roster's instant-fail list.
      // A court that has lost its drainage stands in water after rain; the
      // brief names standing water in courtyards as one of this level's four
      // features; and a sheet at grazing incidence returns the dawn sky, which
      // is the only way to light a floor here without inventing a lamp.
      // Laid at 0.175 over paving whose slab tops run 0.05-0.185, so the sunk
      // slabs are under it and the proud ones stand out of it as islands -
      // which is what a puddle on nine-hundred-year-old paving actually looks
      // like, and it costs no terrain change at all.
      { name: 'gate_court', x0: -7.8, x1: 1.2, z0: 8.8, z1: 13.4, y: 0.175,
        algae: 0.45, shallow: 1 },
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
      // TWO FIGS IN THE COURTYARD ITSELF, and they are a composition fix as
      // much as a story one. Measured on the signature frame, 32% of it was
      // registering as flat and the flat was concentrated in the top-left and
      // top-right - open sky above a gallery roofline that subtends only 9
      // degrees from a courtyard eye. Three prasats at 21 m span about 60 of
      // the frame's 107 degrees and nothing was filling the rest. These two
      // stand at 47 degrees left and 38 right of the hero1 axis at 33 m, so
      // their crowns close the upper corners at 26 degrees of elevation - and
      // a tree that came through the west breach and rooted in the courtyard
      // paving is exactly what the brief means by the jungle taking it back.
      { name: 'court_nw', x: -20.0, z: -30.5, h: 19.0, r: 1.25, lean: [-0.09, 0.07],
        kind: 'fig' },
      { name: 'court_e', x: 22.6, z: -13.0, h: 16.0, r: 1.05, lean: [0.11, -0.06],
        kind: 'fig' },
      // A FIG, not a palm, and taller. It stands on the enclosure's south run
      // 25 m from the hero2 standpoint and 5 degrees off that frame's axis, so
      // its crown is the organic mass that closes the sky above the gate - the
      // one thing the outer court had none of. A palm's crown is a rosette on
      // a stick and reads as a stick at 25 m.
      { name: 'gate_west', x: -16.4, z: 20.9, h: 15.5, r: 1.05, lean: [-0.10, 0.07],
        kind: 'fig' },
      // THE OVERVIEW'S FRAMING DEVICE, and the one thing in the level that had
      // to move rather than be tuned. The intent was always "a trunk at the
      // right edge"; what landed at (-36, 25) was a CANOPY 7.8 m from the
      // standpoint filling the top-left 12-15% of the establishing frame with
      // 60-100 px alpha-tested blobs - the first thing the eye hits in the
      // level. Re-solved against the standpoint (K.x+2, K.z-2) rather than
      // guessed: at (-36.1, 21.3) the trunk is 6.0 m out at 50 degrees off the
      // view axis, so it sits hard against the RIGHT edge, and at h 20 the
      // crown is 47 degrees up - well clear of a frame whose top edge is at
      // +23. Trunk and buttress in, canopy out, which is what a foreground is
      // supposed to be.
      // Re-solved twice. At (-36, 25) h 16 the CANOPY filled the top-left of
      // the establishing frame; at (-36.1, 21.3) h 20 the canopy cleared but
      // the six radiating BRANCHES dipped back into the top of the frame as a
      // row of floating bark strips. Pushed to 55 degrees off the view axis
      // and 26 m tall, the crown sits at 53 degrees of elevation against a
      // frame top of 23, and what is left in shot is a single vertical trunk
      // hard against the right edge, running the full height - which is what
      // an elevated standpoint needs and what the comment always claimed.
      // Re-solved a THIRD time, and this time by taking it out of the frame
      // rather than by trying to place it inside one. At (-35.6, 22.6) the
      // trunk sat 59.7 degrees off the establishing shot's view axis - just
      // outside the edge but INSIDE the top corner, where a frame's angular
      // reach is largest - so what the published overview actually carried was
      // a row of vertical bark limbs hanging in the top-right corner with
      // clear sky beneath and to the left of them: floating geometry in the
      // level's establishing shot, which is on the instant-fail list. Every
      // attempt to keep it as the right-edge repoussoir has produced the same
      // artefact in a different corner, because the standpoint is 12.5 m up on
      // a bare mound and anything close enough to be a foreground is also
      // close enough for its crown to leave the frame. At (-36.5, 26.5) it is
      // 87 degrees off the axis - behind the camera's shoulder - and the
      // overview's foreground is the ruined boundary shrine and the knoll's
      // own spilled stone, which are ON THE GROUND and cannot float.
      { name: 'knoll', x: -36.5, z: 26.5, h: 21.0, r: 0.80, lean: [0.05, 0.09],
        kind: 'fig' }
    ];

    // ---- rubble heaps ------------------------------------------------------
    // Where a structure came down, its stone is still lying under it. Placed
    // against the fallen tower, the gallery breach and the ruined library.
    // FOREGROUND STONE IS A HEAP LIKE ANY OTHER AND IT BELONGS IN THIS LIST.
    // The seven piles at the end were built by literal calls inside build()'s
    // 'rubble' stage, which meant they existed in the geometry but in no
    // published list - so props_ruins.js could not bank leaf or seed growth
    // against them (they are not anchors.rubble), and buildMist's `clear()`
    // could not keep a mist bank out of them. Both of those showed: the level's
    // signature frame had a 4.8 m mist card sliced by a block pile 3.4 m from
    // the lens, and the piles that are deliberately the nearest thing in every
    // hero framing carried no drift at all. They are heaps; the list is the
    // level's statement of where its heaps are.
    P.rubble = [
      { x: T_CX + 7.4, z: T_CZ - 7.4, r: 6.2, y: TIER[1].y, n: 46, big: 1.0 },
      { x: -G_X + 1.2, z: (BREACH_Z0 + BREACH_Z1) * 0.5, r: 6.8, y: 0.1, n: 52, big: 0.9 },
      { x: -G_X - 3.6, z: (BREACH_Z0 + BREACH_Z1) * 0.5 + 1.5, r: 5.0, y: 0.0, n: 26, big: 0.7 },
      { x: 17.0, z: 11.6, r: 4.6, y: 0.16, n: 24, big: 0.6 },
      { x: 30.4, z: -14.5, r: 5.4, y: 0.1, n: 30, big: 0.8 },
      { x: -6.0, z: -38.6, r: 4.2, y: 0.1, n: 20, big: 0.55 },
      // the hero foregrounds: hero1's near blocks, the inner-court spill, the
      // east-gallery collapse, and the three bands of gate spoil that carry
      // hero2's near and mid field
      { x: -8.4, z: -3.2, r: 3.2, y: 0, n: 16, big: 0.85 },
      { x: 4.6, z: -7.4, r: 2.8, y: 0, n: 12, big: 0.75 },
      { x: 19.8, z: -19.2, r: 3.0, y: 0, n: 16, big: 0.9 },
      { x: 16.2, z: -24.4, r: 3.4, y: 0, n: 16, big: 0.8 },
      { x: 2.0, z: 8.2, r: 2.4, y: 0, n: 16, big: 0.75 },
      { x: -4.5, z: 14.0, r: 3.4, y: 0, n: 20, big: 0.85 },
      { x: -2.2, z: 9.8, r: 2.6, y: 0, n: 14, big: 0.6 }
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
    // THE LOOTERS' CAMP IS THE LEVEL'S HUMAN STORY AND IT WAS NEVER IN A
    // PHOTOGRAPH. At (9.2, -3.6) it sat 66-76 degrees off the view axis of
    // both hero1 and hero2 - i.e. outside every published framing, built,
    // collided, navmeshed and invisible. Moved onto the first terrace ring at
    // (5.5, -6.5) it is 10.6 m from the hero1 standpoint at 34 degrees right,
    // which puts the brazier squarely in that frame's right third, 74 cm above
    // the eyeline, as a warm mark against the tier-2 facing behind it. It also
    // reads better as a story: somebody is camped ON the sanctuary, four
    // metres below a shrine that is still being lit.
    P.camp = { x: 5.5, z: -6.5, y: 0.0, yaw: -0.7 };
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
        // moss / grass. The 'earth' surface is the one MULTIPLY-mode material
        // in the level, so these really are tint multipliers on a warm dirt
        // map - and against a 3:1 orange illuminant a 0.78/1.14/0.60 tint
        // could never take the ground past olive. Pulling R down hard and G up
        // hard is what it costs to make a shaded courtyard floor read as moss
        // rather than as mud.
        r = M.lerp(r, 0.42, moss * 0.92);
        g = M.lerp(g, 1.52, moss * 0.92);
        b = M.lerp(b, 0.46, moss * 0.92);
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
        // `mossBias` lowers the threshold where a slab goes over to the moss
        // surface. The courtyard and the gallery corridor are the two floors a
        // published framing actually stands on, and they were coming out as
        // 100% clean paving because the threshold was tuned before the moss
        // albedo was authored against this level's orange illuminant.
        var key = (moss > (0.62 - (opts.mossBias || 0)) || sink < -0.05)
          ? 'mossy' : 'paving';
        // THE TRODDEN LINE. `trodX` names the centre of the route people
        // actually walk on this floor; slabs inside it are polished (more
        // grime headroom, so a brighter stone) and DAMP - and damp is the
        // whole point on the causeway. materials.js's G channel drives
        // roughness toward 0.09 and specularF90 toward 1.0, so a wet slab
        // under an open dawn sky at grazing incidence returns a broad Fresnel
        // reflection of the burning horizon. The causeway was 32 m of the one
        // leading line in the level sitting at half the luminance of the gate
        // it leads to; giving its worn centre a sheen lights it AND motivates
        // it as dawn-damp stone rather than as a fill light nobody could
        // point at.
        var trodD = (opts.trodX !== undefined) ? Math.abs(cx - opts.trodX)
          : (opts.trodZ !== undefined) ? Math.abs(cz - opts.trodZ) : -1;
        var trod = (trodD < 0) ? 0
          : M.smoothstep(opts.trodW || 2.2, 0.25, trodD) *
            (0.72 + 0.28 * (N.fbm2(cx * 0.5 + 3.0, cz * 0.22 - 8.0, 2) * 0.5 + 0.5));
        // 0.16 of wetness, not 0.34. At a third the flagstones went to
        // roughness 0.09 with specularF90 at 1.0 and returned the dawn sky
        // whole: every paved floor in the level photographed as a sheet of
        // pale blue-grey ice, which is the identical failure the first capture
        // round hit from the other direction. A damp trodden line wants to
        // catch a broad sheen at grazing incidence and nothing more.
        B.wear = {
          grime: 0.80 + (opts.lift || 0) + rng.range(-0.10, 0.16) - moss * 0.18 + trod * 0.15,
          wet: (1 - M.saturate(-sink * 2.6) * 0.16) *
            (1 - trod * (opts.trodWet === undefined ? 0.16 : opts.trodWet)),
          edge: 0.92 + rng.range(-0.08, 0.10)
        };
        // Bevel varies per slab. A uniform 4.8 cm arris on 1300 slabs is a
        // uniform highlight width on 1300 slabs; some of these are dressed and
        // sharp, some have had their arris eaten off entirely.
        // AND THE SLAB IS DISHED. A flagstone that has been walked on for nine
        // hundred years is a shallow bowl with rounded arrises, and at the
        // grazing incidence every floor in this level is seen at, that hollow is
        // the only thing that puts a shading gradient across a slab at all - a
        // flat slab under a 9.6-degree sun is one value edge to edge, which is
        // exactly how the outer court photographed.
        B.relBoxR(key, w, th, d, cx, yy + sink - th * 0.5, cz, tilt, rng.range(-0.03, 0.03), tilt2,
          Math.min(th * 0.42, BEVELS[rng.int(0, BEVELS.length - 1)]),
          ((cx * 53 + cz * 31) | 0));
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
    var P = self.plan, N = self.noise;
    for (var i = 0; i < P.pools.length; i++) {
      var p = P.pools[i];
      var w = p.x1 - p.x0, d = p.z1 - p.z0;
      // Subdivided at ~1.9 m, not ~6 m. Two reasons, and the second is the one
      // that matters: the ripple normal needs vertices to interpolate across,
      // AND a sheet of standing water in a ruin does not have an
      // axis-aligned rectangular edge. At this cell size the PERIMETER can be
      // eaten back by noise - the outer cells shrink and some go entirely -
      // so the margin wanders into a silt shelf instead of ending at a
      // dead-straight hard line at one value, which is what made hero1's
      // sheet read as wet concrete rather than as water.
      // 1.05 m cells, not 1.9. THE MARGIN IS THE WHOLE PROBLEM: a straight-edged
      // puddle is on the roster's instant-fail list, and at 1.9 m the two
      // courtyard sheets in hero1 are only 4 x 2 and 7 x 3 cells, so "eat the
      // perimeter back with noise" had a two-cell alphabet to work with and
      // came out as a rectangle with a couple of corners missing. At 1.05 m
      // the same sheets are 8 x 3 and 14 x 6, the bite operates at a scale
      // smaller than the eye reads as an edge, and the boundary wanders.
      var nx = Math.max(1, Math.round(w / 1.05)), nz = Math.max(1, Math.round(d / 1.05));
      var cw = w / nx, cd = d / nz;
      for (var a = 0; a < nx; a++) {
        for (var b = 0; b < nz; b++) {
          var cx = p.x0 + (a + 0.5) * cw, cz = p.z0 + (b + 0.5) * cd;
          var edge = Math.min(Math.min(a, nx - 1 - a) / Math.max(1, nx * 0.5),
            Math.min(b, nz - 1 - b) / Math.max(1, nz * 0.5));
          var bite = N.fbm2(cx * 0.62 + 17.0, cz * 0.62 - 6.0, 3) * 0.5 + 0.5;
          var sw = cw, sd = cd, sx2 = cx, sz2 = cz;
          // the bite now reaches two cells in from the rim rather than one,
          // so the frontier is a ragged band and not a nibbled outline
          if (edge < 0.55) {
            if (bite < 0.30 + edge * 0.30) continue;      // the margin is gone
            var k = M.lerp(0.42, 1.0, M.saturate((bite - 0.30) * 2.2));
            sw = cw * k; sd = cd * k;
            sx2 = cx + (cx < (p.x0 + p.x1) * 0.5 ? 1 : -1) * (cw - sw) * 0.5;
            sz2 = cz + (cz < (p.z0 + p.z1) * 0.5 ? 1 : -1) * (cd - sd) * 0.5;
          }
          // uv is 0.55 per metre, i.e. a ripple tile every 1.8 m. The first
          // pass ran 0.09 and stretched one tile over eleven metres, which is
          // a mirror with a smear on it rather than water.
          B.wear = { grime: 1 - p.algae * 0.30 * rng.range(0.5, 1), wet: 1, edge: 1 };
          B.add('water', quad(sw, sd, (sx2 - sw * 0.5 - p.x0) * 0.55,
            (sz2 - sd * 0.5 - p.z0) * 0.55, (sx2 + sw * 0.5 - p.x0) * 0.55,
            (sz2 + sd * 0.5 - p.z0) * 0.55),
            makeM(sx2, p.y, sz2, -Math.PI * 0.5, 0, 0));
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
      // COURSE HEIGHTS ARE NOT UNIFORM, and until now they were: hh/courses,
      // to the millimetre, on every wall in the level. That is the "same size"
      // half of the differential-erosion finding, and it is also why the
      // masonry read as a printed pattern - a perfectly regular horizontal
      // rhythm is a texture, not a wall. A Khmer quarry did not saw to a
      // module; a real elevation steps between a 45 cm bed and a 78 cm one and
      // the courses do not stay parallel over sixty metres. The bed heights
      // are drawn from a noise field along the run so NEIGHBOURING stations
      // agree (a course is continuous) while distant ones do not.
      var bedH = [], bedSum = 0, cc2;
      for (cc2 = 0; cc2 < courses; cc2++) {
        var bv = 1 + N.fbm2(a * 0.19 + cc2 * 5.7, b * 0.15 - cc2 * 2.3, 2) * 0.62;
        bedH.push(bv); bedSum += bv;
      }
      for (cc2 = 0; cc2 < courses; cc2++) bedH[cc2] *= hh / bedSum;
      var cyAcc = y + settle;
      for (var c = 0; c < courses; c++) {
        var ch = bedH[c];
        var cy = cyAcc + ch * 0.5;
        cyAcc += ch;
        if (d && cy < y + d.h) continue;                    // the opening
        var jog = N.fbm2(a * 0.9 + c * 3.1, b * 0.4, 2) * 0.035;
        var bt = o.batter ? (1 - (c / courses) * o.batter) : 1;
        var wgt = (c === courses - 1 && rng.bool(0.22)) ? 0.55 : 1.0;  // a lost top course
        var bw = step * rng.range(0.90, 0.99);
        // Clumped, not sprinkled. rng.bool(0.42) on every block in the bottom
        // 1.15 m turned the foot of every wall into a random green CHECKERBOARD
        // once the moss albedo was authored strongly enough to survive the
        // orange key. Moss grows in patches, so the mask is a noise field
        // sampled at the block and thresholded - neighbouring blocks agree,
        // and a patch has a frontier.
        // Gated hard on height as well as on the noise field. Even clumped,
        // whole BLOCKS of the moss surface at close range read as painted
        // green panels - a 1.6 m block is simply too big a unit for a mark
        // that should have a frontier inside it. The block surface now only
        // appears low down and sparsely; everything above 1.9 m carries moss
        // as a feathered DECAL instead, which is the right tool for it.
        // 0.84 / 0.26, not 0.78 / 0.38. A whole 1.6 m block of the moss
        // surface is still a flat green PANEL at close range whatever its
        // albedo does - the decal atlas is the right tool for a mark with a
        // frontier inside it, and now that the marks carry a detail normal and
        // two extra octaves of albedo break-up it is a much better one. This
        // pass is left only as the occasional block that has gone over
        // entirely, which is a real thing on a wall foot.
        var mAmt = N.fbm2(a * 0.30 + 13.0, cy * 0.62 - 4.0, 2) * 0.5 + 0.5;
        var mossy = (cy - y) < 1.9 && mAmt > 0.84 && rng.bool(0.26);
        B.wear = {
          grime: 0.78 + N.fbm2(a * 0.31, cy * 0.5, 2) * 0.20 - (cy - y < 0.9 ? 0.10 : 0),
          wet: 1 - M.smoothstep(1.4, 0.05, cy - y) * 0.30,
          edge: 0.88 + rng.range(-0.10, 0.14)
        };
        var kk = mossy ? 'mossy' : key;
        // PERFECTLY REGULAR COURSING IS THE INSTANT-FAIL. Round two jittered
        // the yaw by +/-0.006 rad and nothing else, so every joint was a
        // uniform-width black line and not one arris was spalled. Each block
        // now carries +/-1.5 cm of settlement in all three axes, +/-0.02 rad
        // of yaw and a small tilt, and ONE IN TWENTY-FIVE has tipped out of
        // the wall face - which is what a 900-year-old wall on a subsiding
        // laterite core actually does.
        var jx = rng.range(-0.015, 0.015), jy = rng.range(-0.014, 0.014);
        var jz2 = rng.range(-0.015, 0.015);
        var yw = rng.range(-0.020, 0.020), tl = rng.gaussian(0, 0.009);
        var tipped = rng.bool(0.040) && c > 0;
        if (tipped) {
          jx += (axis === 'x' ? 0 : 1) * rng.range(0.08, 0.20) * (o.batter ? -1 : 1);
          jz2 += (axis === 'x' ? rng.range(0.08, 0.20) : 0);
          yw += rng.range(-0.14, 0.14);
          tl += rng.gaussian(0, 0.07);
        }
        // CHIPPED ARRISES. Every edge in every published frame measured as a
        // perfect 90-degree line because every block in the level carried the
        // identical 4.8 cm chamfer. A quarried block that has stood nine
        // hundred years has one dressed arris, two rounded ones and one that
        // has spalled off entirely; bevelBox insets corner vertices, so a
        // 9.5 cm chamfer costs exactly what a 1.6 cm one does.
        var bev = BEVELS[rng.int(0, BEVELS.length - 1)];
        if (tipped) bev = BEVELS[BEVELS.length - 1];
        // and the block itself is EATEN - see reliefBox. Every block in every
        // wall in the level goes through it: this is the one surface family a
        // player stands within a metre of, and a perfect prism at a metre is the
        // "perfectly clean, straight, uniform anything" instant-fail however
        // good the map on it is.
        var rsd = ((a * 41 + cy * 97 + b * 13) | 0);
        if (axis === 'x') {
          B.relBoxR(kk, bw, ch * wgt * 0.985, t * bt, x + jx,
            cy - ch * (1 - wgt) * 0.5 + jy, z + jog + jz2, tl, yw, tl * 0.6, bev, rsd);
        } else {
          B.relBoxR(kk, t * bt, ch * wgt * 0.985, bw, x + jog + jx,
            cy - ch * (1 - wgt) * 0.5 + jy, z + jz2, tl * 0.6, yw, tl, bev, rsd);
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
        B.wear = { grime: 0.72 + rng.range(-0.08, 0.08), wet: 1,
          edge: 0.80 + rng.range(-0.08, 0.10) };
        // A REAL CORNICE PROFILE, not one slab. Khmer cornices are a fillet, a
        // cyma and a drip - three separate planes at three different angles to
        // the sky, which is why the originals carry a hard bright line along
        // every run under any light. A single stacked box has ONE plane, and
        // under a 9-degree key it has one value: this was a large part of why
        // the near-field stone measured flatter at every block scale than the
        // empty sky above it. Nine triangles a station buys the level's
        // longest highlight.
        var cy0 = y + cset + h;
        var jy2 = rng.range(-0.012, 0.012), jr2 = rng.range(-0.010, 0.010);
        // PUBLISH THE DRIP EDGE. Every projecting horizontal in the level is
        // created here or in faceTower, and props_ruins.js is the file that
        // owns weathering - so rather than have it guess where the cornices
        // are from the anchor boxes (it cannot: the towers taper and the
        // wall runs have gaps), the exact station is recorded as it is built
        // and published as level.anchors.cornices. The dark vertical drip
        // streak hanging below a projecting moulding is the single most
        // characteristic weathering on Khmer sandstone and the level carried
        // it on zero surfaces.
        if (self.cornices && self.cornices.length < 4000) {
          self.cornices.push({
            x: cx, y: cy0, z: cz, axis: axis, half: cstep * 0.48,
            t: t, run: 1
          });
        }
        if (axis === 'x') {
          B.boxR('sandstone', cstep * 0.97, capH * 0.34, t * 1.06,
            cx, cy0 + capH * 0.17 + jy2, cz, 0, jr2, 0);
          B.boxR('sandstone', cstep * 0.97, capH * 0.46, t * 1.30,
            cx, cy0 + capH * 0.57 + jy2, cz, 0, jr2, 0);
          B.boxR('sandstone', cstep * 0.97, capH * 0.30, t * 1.44,
            cx, cy0 + capH * 0.95 + jy2, cz, 0, jr2, 0);
          // the drip, undercut on the weather face
          B.boxR('sandstone', cstep * 0.94, capH * 0.26, t * 0.34,
            cx, cy0 + capH * 0.42 + jy2, cz + (o.dripSide || 1) * t * 0.70,
            0.55, jr2, 0);
        } else {
          B.boxR('sandstone', t * 1.06, capH * 0.34, cstep * 0.97,
            cx, cy0 + capH * 0.17 + jy2, cz, 0, jr2, 0);
          B.boxR('sandstone', t * 1.30, capH * 0.46, cstep * 0.97,
            cx, cy0 + capH * 0.57 + jy2, cz, 0, jr2, 0);
          B.boxR('sandstone', t * 1.44, capH * 0.30, cstep * 0.97,
            cx, cy0 + capH * 0.95 + jy2, cz, 0, jr2, 0);
          B.boxR('sandstone', t * 0.34, capH * 0.26, cstep * 0.94,
            cx + (o.dripSide || 1) * t * 0.70, cy0 + capH * 0.42 + jy2, cz,
            0, jr2, 0.55);
        }
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

  // The seven-headed hood that terminates a naga balustrade. `s` is which side
  // of the causeway it stands on, `face` is +1 for a hood rearing back down
  // the road and -1 for one rearing toward the gate.
  function nagaTerminus(self, B, rng, bx, hz, s, face) {
    B.wear = { grime: 0.70, wet: 1, edge: 0.78 };
    B.box('sandstone', 0.90, 0.50, 1.5, bx, CW_Y + 0.25, hz);
    // the coiled body rising into the hood
    B.add('sandstone', limb([
      [bx, CW_Y + 0.55, hz - face * 0.80, 0.30],
      [bx, CW_Y + 0.95, hz + face * 0.10, 0.34],
      [bx, CW_Y + 1.62, hz + face * 0.34, 0.30],
      [bx, CW_Y + 2.10, hz + face * 0.22, 0.24]
    ], 12, { noise: self.noise, phase: hz * 0.7, lobes: 5, flute: 0.15,
      bulge: 0.08, uv: 0.5 }));
    B.frus('sandstone', 0.82, 1.20, 0.62, 0.70, 0.55, bx, CW_Y + 0.80, hz);
    for (var f = -3; f <= 3; f++) {
      var fa = f * 0.30;
      // the fanned hood: seven necks, each one a tapered blade
      B.boxR('sandstone', 0.24, 1.30, 0.30,
        bx + Math.sin(fa) * 0.62 * s, CW_Y + 2.35, hz - Math.abs(f) * 0.10 * face,
        -0.12 * face, 0, fa * 0.9);
      // the head itself: a muzzle, a brow and two eyes, so it is a snake and
      // not a knob on a stick
      B.boxR('sandstone', 0.28, 0.30, 0.36,
        bx + Math.sin(fa) * 0.86 * s, CW_Y + 3.02, hz - Math.abs(f) * 0.12 * face,
        -0.30 * face, 0, fa * 0.9);
      B.boxR('sandstone', 0.20, 0.13, 0.30,
        bx + Math.sin(fa) * 0.94 * s, CW_Y + 2.92,
        hz - (Math.abs(f) * 0.12 + 0.20) * face, -0.30 * face, 0, fa * 0.9);
      B.boxR('carve', 0.30, 0.055, 0.10,
        bx + Math.sin(fa) * 0.90 * s, CW_Y + 3.12,
        hz - (Math.abs(f) * 0.12 + 0.16) * face, -0.30 * face, 0, fa * 0.9);
      for (var ey = -1; ey <= 1; ey += 2) {
        B.boxR('carve', 0.055, 0.055, 0.06,
          bx + (Math.sin(fa) * 0.86 + ey * 0.07) * s, CW_Y + 3.05,
          hz - (Math.abs(f) * 0.12 + 0.15) * face, 0, 0, 0);
      }
    }
    B.wear = null;
    self.addCollider(bx, CW_Y + 1.5, hz, 0.7, 1.5, 0.9, 'stone');
  }

  // =============================================================== causeway ==
  function buildCauseway(self, B, rng) {
    var P = self.plan, N = self.noise, i;

    // deck. 1.10 m module, not 1.44: this is the biggest single surface in
    // hero3 and the nearest, and joint density is the cheapest real
    // high-frequency detail a near-field floor can carry (12 triangles a slab).
    // `trodX` runs the wet, polished centre line down the middle of the road.
    pave(self, B, rng, { x0: -CW_HALF, x1: CW_HALF, z0: CW_Z0 + 0.2, z1: CW_Z1 },
      CW_Y, { pitch: 1.10, trodX: 0, trodW: 2.7, trodWet: 0.30 });

    // revetment down into the moat, both sides, laid in courses
    for (var s = -1; s <= 1; s += 2) {
      wallRun(self, B, rng, {
        axis: 'z', a0: CW_Z0, a1: CW_Z1, b: s * (CW_HALF + 0.28),
        y: MOAT_Y - 1.0, h: CW_Y - MOAT_Y + 1.0, t: 0.56, key: 'laterite',
        cap: false, batter: 0.10, collide: false
      });
      // THE NAGA BALUSTRADE.
      //
      // Round two built this as a plinth, a rounded prism and a plain
      // pyramidal post: thirty-two metres of chamfered kerb on the ONE leading
      // line the hero3 framing exists for, with no hood, no scales and no
      // terminus anywhere in the field of view. What is here now is a real
      // serpent: a LOBED body (limb at 12 radial with five longitudinal
      // flutes, so the section is scaly rather than circular), a dorsal ridge
      // of overlapping scutes that carries a hard highlight along the whole
      // run, a raised hood every ~7 m, and a seven-headed terminus at BOTH
      // ends of the causeway - which is also what the originals have, and
      // which is what finally puts one inside hero3's cone.
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
        // the body: lobed, swelling and pinching along its length
        B.add('sandstone', limb([
          [bx, CW_Y + 0.58, nz - 1.78, 0.235],
          [bx + s * 0.03, CW_Y + 0.60, nz - 0.60, 0.262],
          [bx - s * 0.02, CW_Y + 0.59, nz + 0.60, 0.248],
          [bx, CW_Y + 0.57, nz + 1.78, 0.230]
        ], 12, { noise: self.noise, phase: nz * 0.9 + s, lobes: 5,
          flute: 0.16, bulge: 0.07, uv: 0.5 }));
        // dorsal scutes - overlapping, alternating, and the thing that turns a
        // prism into a snake at 30 m
        for (var q = 0; q < 9; q++) {
          var qz = nz - 1.60 + q * 0.40;
          B.boxR('sandstone', 0.13, 0.17 + (q % 2) * 0.04, 0.24,
            bx, CW_Y + 0.79, qz, -0.16, 0, rng.range(-0.07, 0.07));
          // belly / flank scale course
          B.boxR('sandstone', 0.09, 0.13, 0.34, bx + s * 0.20, CW_Y + 0.50,
            qz + 0.10, 0, 0, s * 0.22);
        }
        // A RAISED HOOD every second station. It breaks 32 m of kerb into a
        // rhythm, and its silhouette against the moat is the whole point.
        if ((i % 2) === 1) {
          B.frus('sandstone', 0.46, 0.62, 0.34, 0.44, 0.72, bx, CW_Y + 1.02, nz);
          for (var hf = -2; hf <= 2; hf++) {
            B.boxR('sandstone', 0.13, 0.62, 0.17,
              bx + Math.sin(hf * 0.34) * 0.30 * s, CW_Y + 1.62,
              nz - Math.abs(hf) * 0.06, -0.10, 0, hf * 0.28);
          }
          B.add('sandstone', revolve([[0.17, 0], [0.22, 0.07], [0.14, 0.20],
            [0.05, 0.30]], 10), makeM(bx, CW_Y + 1.92, nz));
        }
        // post
        B.box('sandstone', 0.62, 0.98, 0.62, bx, CW_Y + 0.49, nz + 1.75);
        B.frus('sandstone', 0.74, 0.74, 0.40, 0.40, 0.34, bx, CW_Y + 1.15, nz + 1.75);
        B.add('sandstone', revolve([[0.20, 0], [0.26, 0.10], [0.17, 0.26], [0.05, 0.38]], 10),
          makeM(bx, CW_Y + 1.32, nz + 1.75));
        self.addCollider(bx, CW_Y + 0.55, nz, 0.36, 0.55, 1.8, 'stone');
      }
      B.wear = null;

      // ---- the seven-headed naga, at BOTH ends of the causeway --------------
      nagaTerminus(self, B, rng, bx, CW_Z1 - 0.6, s, 1);
      nagaTerminus(self, B, rng, bx, CW_Z0 + 1.1, s, -1);
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
      // Eaten, not extruded. These heaps are the closest stone to the lens in
      // every published framing - the pile at (-8.4,-3.2) is 3.4 m from the
      // hero1 standpoint - so a broken corner and a dished face on them is
      // worth more than the same relief anywhere else in the level.
      B.relBoxR(moss > 0.62 ? 'mossy' : 'sandstone', w, h, d, x, y, z,
        rng.gaussian(0, 0.22), rng.range(0, Math.PI), rng.gaussian(0, 0.22),
        undefined, ((x * 67 + z * 29 + y * 101) | 0));
      if (rng.bool(0.22)) {
        self.addCollider(x, y, z, w * 0.45, h * 0.6, d * 0.45, 'stone');
      }
    }
    B.wear = null;
  }

  // ================================================================== faces ==
  // THE BAYON FACE. This is the level's signature and the single asset most
  // able to fail: a face is either recognisably a face at 25 m or it is a lumpy
  // box, and there is no middle.
  //
  // ---------------------------------------------------------------------------
  // WHY THE PREVIOUS VERSION HAD NO FACE ON IT, MEASURED RATHER THAN GUESSED
  // ---------------------------------------------------------------------------
  // The old head was forty-odd BOXES in a local frame: a solid mass frustum
  // whose front plane sat at F = 1.30 dp, then every feature placed against F.
  // Photographed on the south-west prasat in hero1 (the biggest face in the
  // build at 184 x 93 px) and on the gopura in hero2 at 3.5x, what printed was
  // an inverted trapezoid with four thin horizontal bars under it on a dead-flat
  // panel - a console bracket and a string course, exactly as the critic read
  // it. Two mistakes, and the first is fatal on its own:
  //
  //  1. YOU CANNOT SUBTRACT WITH ADDITIVE GEOMETRY. Every recess on that head -
  //     the eye band at fz(-0.30), each almond at fz(-0.42), both canted rims,
  //     the canthus, the mouth line - was a DARK BOX PLACED AT A NEGATIVE PROUD
  //     VALUE, i.e. a box floating INSIDE the solid mass frustum, sealed behind
  //     stone and contributing not one pixel. Only the features standing in
  //     front of F survived, so the head was a flat plane with bars on it and
  //     there were no eye sockets anywhere in the level. The dark 'carve'
  //     albedo, the canted rims, the baked concavity occlusion and three rounds
  //     of tuning were all being spent on invisible geometry.
  //  2. THE NOSE WAS UPSIDE DOWN. frus(w0,d0,w1,d1,h) runs w0 at the BOTTOM to
  //     w1 at the TOP, and the nose was emitted w*0.155 -> w*0.235 wide and
  //     dp*1.10 -> dp*1.55 deep: narrow and shallow at the nostrils, broad and
  //     proud at the bridge. That inverted wedge is the loudest thing in the
  //     printed crop and it is why the head read as architecture.
  //
  // ---------------------------------------------------------------------------
  // WHAT IS HERE NOW: A HEIGHT FIELD WITH REAL VOIDS
  // ---------------------------------------------------------------------------
  // The head is one analytic relief surface z = faceZ(u, t) sampled on a grid
  // and emitted as a smooth-shaded shell with a skirt that dies inside the
  // tower. Everything a face needs follows from that and none of it is
  // reachable with boxes:
  //
  //   * A CUT IS A CUT. `-=` on a height field removes stone. The eye sockets
  //     are 0.64 dp of subtraction from the cheek plane, so each one is a real
  //     hollow with its own floor, its own rim silhouette and its own contact
  //     occlusion; the closed-lid line, the mouth line, the nostrils, the
  //     philtrum and the groove under the diadem are real grooves.
  //   * IT IS CURVED. A face is a set of convex masses - skull, cheeks, jaw,
  //     lids, lips - and the one thing forty flat boxes cannot do under a 1.05
  //     key at 9 degrees is run a value GRADIENT across a surface. Every lobe
  //     here is an ellipsoid, the normals are solved from the grid itself, and
  //     a sky-lit cheek therefore shades from its crest to its edge.
  //   * UP-FACING STONE IS THE LIGHT SOURCE. Almost nothing in this level takes
  //     the key; the illuminant is the sky, so irradiance tracks how much sky a
  //     normal sees. The crest of the brow, the bridge of the nose, the top of
  //     the diadem and the upper lip all face up and are bright; the undercut
  //     beneath each of them faces down and is dark. That is the terminator the
  //     old head was hoping a shadow would provide.
  //   * THE ALBEDO SPLIT IS SOLVED FROM THE FIELD. Triangles are sorted into
  //     three EXISTING buckets by their own depth and normal: below 0.70 dp into
  //     'carve' (0x39332a - the sockets, the grooves, the rim), a noise- and
  //     shelter-weighted subset into 'mossy', the rest into 'sandstone'. So the
  //     recesses are dark by albedo AND dark by geometry, the moss grows where
  //     water stops, and it costs no extra draw call because all three buckets
  //     already exist.
  //   * THE FACE SITS IN A FRAMED PEDIMENT (built by the caller). The storey
  //     tapers, which is what buried the chin of every previous attempt:
  //     registered on the half-width at its foot the head's lower third is
  //     inside the stone, registered at its top the foot floats. A projecting
  //     panel with a flat front gives the relief one datum at every height, and
  //     it is what a real prasat face storey has.
  //
  // Cost: about 3,800 triangles for a 5.7 m head, 700-1,400 for the small ones,
  // ~45k for all twenty-four in the level, and ZERO extra draw calls.
  // ---------------------------------------------------------------------------
  var FZ_GND = 0.40;                 // the carved ground: the head's own rim
  var FZ_RIM = -0.34;                // where the skirt dies, inside the panel
  var FZ_CHEEK = 1.00;               // the general cheek / forehead surface

  // The head's own outline: half-width in units of w, against t (0 at the
  // bottom of the chin, 1 at the top of the headdress). Broad and square with
  // the widest point at the cheekbones and a second flare at the diadem, which
  // is what makes the proportion Khmer rather than classical.
  var F_OUT = [
    [0.000, 0.112], [0.045, 0.210], [0.110, 0.300], [0.200, 0.382],
    [0.310, 0.444], [0.440, 0.462], [0.560, 0.458], [0.680, 0.438],
    [0.760, 0.440], [0.830, 0.472], [0.884, 0.416], [0.946, 0.312],
    [1.000, 0.168]
  ];
  function fOutline(t) {
    var i;
    if (t <= F_OUT[0][0]) return F_OUT[0][1];
    for (i = 1; i < F_OUT.length; i++) {
      if (t <= F_OUT[i][0]) {
        var k = (t - F_OUT[i - 1][0]) / (F_OUT[i][0] - F_OUT[i - 1][0] || 1);
        k = k * k * (3 - 2 * k);
        return F_OUT[i - 1][1] + (F_OUT[i][1] - F_OUT[i - 1][1]) * k;
      }
    }
    return F_OUT[F_OUT.length - 1][1];
  }

  // ---------------------------------------------------------------------------
  // ADDITIVE, NOT A UNION, AND THAT WAS THE SECOND STRUCTURAL FINDING OF THE
  // ROUND. The first version of this field took max() over ~30 ellipsoidal
  // lobes. Rendered offline at 420 px it was not a face: max() of steep-rimmed
  // ellipsoids gives every lobe a HARD RIM, so the skull, the cheeks, the lids
  // and both lips printed as a stack of separate hard-edged plates - the exact
  // failure mode of the box version it replaced, reproduced with curves. What
  // works is a single continuous base surface plus SIGNED ADDITIVE
  // displacements: addition merges without a seam, a subtraction is a groove
  // whose depth is exactly what you asked for, and the only hard edge left in
  // the model is the one that should be there - the head's own outline.
  // ---------------------------------------------------------------------------
  // The blank: one smooth mass over the whole outline. `rad` is a shell profile
  // in the radial coordinate |u|/half (exponent 2.7 keeps the middle of the face
  // broad and rolls it off near the edge); `vp` closes it at the chin and the
  // crown, so the base is exactly FZ_GND on every boundary and the skirt below
  // it is the same 0.40 dp step all the way round.
  function faceBase(u, t, half) {
    var ru = M.saturate(Math.abs(u) / Math.max(1e-4, half));
    var rad = Math.sqrt(M.saturate(1 - Math.pow(ru, 2.7)));
    var vp = M.smoothstep(0.0, 0.075, t) * M.smoothstep(1.0, 0.925, t);
    return FZ_GND + (FZ_CHEEK - FZ_GND) * rad * vp;
  }
  // An additive elliptical displacement. `p` above 1 feathers the edge (a
  // cheek), below 1 sharpens it (a groove).
  function fBump(u, t, cu, ct, ru, rt, amp, p) {
    var a = (u - cu) / ru, b = (t - ct) / rt;
    var r2 = a * a + b * b;
    if (r2 >= 1) return 0;
    return amp * Math.pow(1 - r2, p);
  }
  // The same, but its crest line is t = tc - which is the whole reason a Bayon
  // mouth reads as serene rather than as a slot: both lips and the mouth line
  // itself rise toward the corners.
  function fCrest(u, t, tc, ru, rt, amp, p) {
    var a = u / ru, b = (t - tc) / rt;
    var r2 = a * a + b * b;
    if (r2 >= 1) return 0;
    return amp * Math.pow(1 - r2, p);
  }

  // The field. u is -0.5..0.5 across the head, t is 0..1 up it, and the return
  // is the stone's distance out of the pediment panel in units of dp.
  function faceZ(u, t, half, N, sd, e) {
    var z = faceBase(u, t, half), q, cu, du, tl, f = 0;

    // ---- the masses: cheeks, chin, forehead -------------------------------
    f += fBump(u, t, -0.235, 0.335, 0.200, 0.160, 0.105, 1.5);
    f += fBump(u, t, 0.235, 0.335, 0.200, 0.160, 0.105, 1.5);
    f += fBump(u, t, 0.000, 0.115, 0.150, 0.080, 0.100, 1.4);
    f += fBump(u, t, 0.000, 0.700, 0.300, 0.110, 0.060, 1.5);

    // ---- the brow: one continuous arc over both eyes ----------------------
    // Its crest DROPS toward the temples, so the highlight along it bends. A
    // straight bar across a head is a string course, which is what the previous
    // five-segment brow printed as.
    var tb = 0.588 - 0.82 * u * u;
    f += fCrest(u, t, tb, 0.440, 0.056, 0.330, 1.25);
    // the undercut immediately beneath it: a down-facing surface under a sky
    // illuminant is the darkest thing on the head, and it is the terminator the
    // box version was hoping a shadow would provide
    f -= fCrest(u, t, tb - 0.052, 0.415, 0.024, 0.190, 0.80);

    // ---- the eyes ---------------------------------------------------------
    for (q = -1; q <= 1; q += 2) {
      cu = q * 0.198;
      if (e > 0.66 && q > 0 && ((sd >> 3) & 3) === 0) continue;   // spalled away
      f -= fBump(u, t, cu, 0.492, 0.216, 0.100, 0.400, 1.35);     // the socket
      f -= fBump(u, t, cu, 0.496, 0.162, 0.064, 0.170, 1.20);     // its deep core
      f += fBump(u, t, cu, 0.488, 0.152, 0.057, 0.300, 1.20);     // the ball
      f += fBump(u, t, cu, 0.516, 0.150, 0.033, 0.160, 1.00);     // upper lid
      f += fBump(u, t, cu, 0.456, 0.142, 0.025, 0.090, 1.00);     // lower lid
      // THE CLOSED-LID LINE. On a face this size it is 2-4 printed pixels and
      // it is still the strongest cue the head carries, because it is the only
      // long horizontal dark line inside a lit mass. It arcs.
      du = M.clamp((u - cu) / 0.136, -1, 1);
      tl = 0.487 + 0.019 * (1 - du * du) - 0.013 * du * q;
      f -= fBump(u, t, cu, tl, 0.136, 0.0125, 0.280, 0.70);
      // the outer canthus, cut back toward the ear
      f -= fBump(u, t, cu + q * 0.136, 0.478, 0.055, 0.028, 0.170, 1.00);
    }

    // ---- the nose: a tapering vertical ridge ------------------------------
    // NOT two stacked lobes, and not the old inverted frustum. Its half-width
    // and its amplitude are both functions of t, so it is narrow and shallow
    // where it leaves the brow and broad and proud at the nostrils - which is
    // the way round a nose actually is.
    if (!(e > 0.62 && (sd & 3) === 0)) {
      var wN = 0.062 + 0.078 * M.smoothstep(0.505, 0.320, t);
      var pN = M.smoothstep(0.568, 0.480, t) * M.smoothstep(0.268, 0.315, t);
      var aN = 0.175 + 0.355 * M.smoothstep(0.525, 0.350, t);
      if (pN > 0) {
        f += aN * pN * Math.pow(M.saturate(1 - (u / wN) * (u / wN)), 0.70);
      }
      f += fBump(u, t, 0.000, 0.320, 0.128, 0.048, 0.165, 1.15);  // the ball
      f += fBump(u, t, -0.115, 0.310, 0.060, 0.040, 0.115, 1.00); // the wings
      f += fBump(u, t, 0.115, 0.310, 0.060, 0.040, 0.115, 1.00);
      f -= fBump(u, t, 0.000, 0.286, 0.098, 0.020, 0.095, 1.00);  // under the tip
      f -= fBump(u, t, -0.068, 0.301, 0.038, 0.013, 0.185, 0.80); // nostril slots
      f -= fBump(u, t, 0.068, 0.301, 0.038, 0.013, 0.185, 0.80);
    } else {
      f -= fBump(u, t, 0.000, 0.365, 0.120, 0.100, 0.340, 1.30);  // struck off
    }
    f -= fBump(u, t, -0.186, 0.252, 0.062, 0.062, 0.110, 1.25);   // nasolabial
    f -= fBump(u, t, 0.186, 0.252, 0.062, 0.062, 0.110, 1.25);

    // ---- the mouth --------------------------------------------------------
    f -= fBump(u, t, 0.000, 0.200, 0.245, 0.070, 0.120, 1.30);    // the dish
    f += fCrest(u, t, 0.223 + 0.46 * u * u, 0.202, 0.040, 0.255, 1.00);
    f += fCrest(u, t, 0.166 + 0.42 * u * u, 0.178, 0.031, 0.200, 1.00);
    f -= fCrest(u, t, 0.197 + 0.44 * u * u, 0.198, 0.0115, 0.365, 0.62);
    f -= fBump(u, t, -0.176, 0.211, 0.032, 0.024, 0.150, 0.90);   // the corners
    f -= fBump(u, t, 0.176, 0.211, 0.032, 0.024, 0.150, 0.90);
    f -= fBump(u, t, 0.000, 0.264, 0.027, 0.024, 0.120, 1.00);    // philtrum
    f -= fBump(u, t, 0.000, 0.132, 0.140, 0.026, 0.110, 1.10);    // under the lip
    f += fBump(u, t, 0.000, 0.095, 0.120, 0.055, 0.075, 1.30);    // the chin knob

    // ---- the diadem and the tiered headdress ------------------------------
    f += fCrest(u, t, 0.812, 0.465, 0.034, 0.270, 0.85);
    for (q = -1; q <= 1; q++) {
      f += fBump(u, t, q * 0.168, 0.822, 0.046, 0.034, 0.150, 0.90);
    }
    f -= fCrest(u, t, 0.772, 0.455, 0.014, 0.185, 0.70);
    f += fBump(u, t, 0.000, 0.905, 0.300, 0.065, 0.150, 1.30);
    f += fBump(u, t, 0.000, 0.968, 0.190, 0.048, 0.120, 1.30);
    f -= fCrest(u, t, 0.866, 0.300, 0.013, 0.130, 0.70);
    f -= fCrest(u, t, 0.941, 0.215, 0.012, 0.110, 0.70);

    // ---- nine hundred monsoons -------------------------------------------
    // Two octaves so the stone's surface wanders the way weathered sandstone
    // does, plus one soft spall whose place is drawn off the per-face seed and
    // deliberately kept OFF the central features - a hollow through an eye
    // reads as a hole punched in a model, and the four heads on a tower being
    // the same head four times is a texture, not a ruin.
    if (N) {
      f += N.fbm2(u * 3.1 + sd * 0.37, t * 3.1 - sd * 0.19, 2) * (0.052 + e * 0.048);
      f += N.fbm2(u * 11.0 + sd * 1.7, t * 11.0 + 4.3, 2) * 0.028;
    }
    if (e > 0.30) {
      var gs = (sd % 2) ? 1 : -1;
      var gx = gs * (0.245 + ((sd * 37) % 100) / 100 * 0.155);
      var gt = 0.075 + ((sd * 61) % 100) / 100 * 0.545;
      f -= fBump(u, t, gx, gt, 0.10 + e * 0.09, 0.085 + e * 0.07,
        0.24 + e * 0.44, 1.80);
    }

    // The feature sum is tapered to nothing at the outline, so no polygon on
    // the head's boundary ring is ever proud of FZ_GND and the skirt below it
    // stays a clean vertical step.
    return z + f * M.smoothstep(1.0, 0.93, M.saturate(Math.abs(u) / Math.max(1e-4, half)));
  }

  // The shell. Three geometries back, one per material bucket, all in the head's
  // LOCAL frame (ox across, oy up from the foot, oz out of the panel).
  function faceShell(w, h, dp, sd, e, N) {
    var cell = 0.132;
    var NC = Math.max(16, Math.min(48, Math.round(w / cell)));
    var NR = Math.max(18, Math.min(52, Math.round(h / cell)));
    var i, j, k;
    var VN = (NC + 1) * (NR + 1);
    var P = new Float32Array(VN * 3);
    var CUT = new Float32Array(VN);
    for (j = 0; j <= NR; j++) {
      var t = j / NR;
      var half = fOutline(t);
      for (i = 0; i <= NC; i++) {
        var u = (i / NC * 2 - 1) * half;
        var zb = faceBase(u, t, half);
        var z = faceZ(u, t, half, N, sd, e);
        k = j * (NC + 1) + i;
        P[k * 3] = u * w; P[k * 3 + 1] = t * h; P[k * 3 + 2] = z * dp;
        // How far this vertex is BELOW its own local base surface. This, and not
        // the absolute depth, is what a cut is: the head's outline rolls back to
        // FZ_GND without being cut at all, so an absolute threshold paints a
        // wide dark vignette round the whole head instead of finding the
        // grooves. A socket floor returns ~0.41, the lid line ~0.67, the mouth
        // line ~0.30, the nostrils ~0.20, and the outline returns 0.
        CUT[k] = zb - z;
      }
    }
    // ---- normals from the grid itself -------------------------------------
    var NRM = new Float32Array(VN * 3);
    for (j = 0; j <= NR; j++) {
      for (i = 0; i <= NC; i++) {
        var i0 = i > 0 ? i - 1 : i, i1 = i < NC ? i + 1 : i;
        var j0 = j > 0 ? j - 1 : j, j1 = j < NR ? j + 1 : j;
        var ka = (j * (NC + 1) + i0) * 3, kb = (j * (NC + 1) + i1) * 3;
        var kc = (j0 * (NC + 1) + i) * 3, kd = (j1 * (NC + 1) + i) * 3;
        var ax = P[kb] - P[ka], ay = P[kb + 1] - P[ka + 1], az = P[kb + 2] - P[ka + 2];
        var bx = P[kd] - P[kc], by = P[kd + 1] - P[kc + 1], bz = P[kd + 2] - P[kc + 2];
        var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        var l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        k = (j * (NC + 1) + i) * 3;
        NRM[k] = nx / l; NRM[k + 1] = ny / l; NRM[k + 2] = nz / l;
      }
    }
    // ---- sort every triangle into one of three EXISTING buckets -----------
    var out = { light: [], dark: [], moss: [], ln: [], dn: [], mn: [] };
    function tri(ia, ib, ic) {
      var a = ia * 3, b = ib * 3, cc = ic * 3;
      var cut = (CUT[ia] + CUT[ib] + CUT[ic]) / 3;
      var nyc = (NRM[a + 1] + NRM[b + 1] + NRM[cc + 1]) / 3;
      var pv, nv;
      if (cut > 0.130) { pv = out.dark; nv = out.dn; }
      else {
        // Moss grows where water stops: on an up-facing surface, on the flat of
        // the cheek or the forehead, never on the crest of a nose or a lip that
        // sheds. Quantised to the triangle, which at a 13 cm cell is a 2 px
        // organic frontier at 20 m.
        var ux = (P[a] + P[b] + P[cc]) / (3 * w);
        var uy = (P[a + 1] + P[b + 1] + P[cc + 1]) / (3 * h);
        var ms = (N ? N.fbm2(ux * 5.4 + sd * 0.71, uy * 5.4 - sd * 0.43, 3) : 0) * 0.90
          + M.saturate(nyc) * 0.55
          + M.smoothstep(0.02, 0.12, cut) * 0.30
          - M.smoothstep(-0.06, -0.26, cut) * 1.20;
        if (ms > 0.50) { pv = out.moss; nv = out.mn; }
        else { pv = out.light; nv = out.ln; }
      }
      pv.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2],
        P[cc], P[cc + 1], P[cc + 2]);
      nv.push(NRM[a], NRM[a + 1], NRM[a + 2], NRM[b], NRM[b + 1], NRM[b + 2],
        NRM[cc], NRM[cc + 1], NRM[cc + 2]);
    }
    for (j = 0; j < NR; j++) {
      for (i = 0; i < NC; i++) {
        var v00 = j * (NC + 1) + i, v10 = v00 + 1;
        var v01 = (j + 1) * (NC + 1) + i, v11 = v01 + 1;
        tri(v00, v10, v11);
        tri(v00, v11, v01);
      }
    }
    // ---- the skirt: the head's edge falling back into the panel -----------
    // No polygon of the shell may end in mid-air, and the skirt is also the
    // silhouette: 0.40 dp of near-vertical stone all the way round the head,
    // which is the value break that separates it from the pediment behind it.
    function skirtQuad(ia, ib) {
      var a = ia * 3, b = ib * 3;
      var ax = P[a], ay = P[a + 1], az = P[a + 2];
      var bx = P[b], by = P[b + 1], bz = P[b + 2];
      var rz = FZ_RIM * dp;
      var nx = by - ay, ny = -(bx - ax);
      var l = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= l; ny /= l;
      var d = out.dark, n = out.dn;
      d.push(ax, ay, az, bx, by, bz, bx, by, rz);
      n.push(nx, ny, 0, nx, ny, 0, nx, ny, 0);
      d.push(ax, ay, az, bx, by, rz, ax, ay, rz);
      n.push(nx, ny, 0, nx, ny, 0, nx, ny, 0);
    }
    for (j = 0; j < NR; j++) {                      // left and right edges
      skirtQuad((j + 1) * (NC + 1), j * (NC + 1));
      skirtQuad(j * (NC + 1) + NC, (j + 1) * (NC + 1) + NC);
    }
    for (i = 0; i < NC; i++) {                      // bottom and top edges
      skirtQuad(i, i + 1);
      skirtQuad(NR * (NC + 1) + i + 1, NR * (NC + 1) + i);
    }
    function geoOf(pa, na) {
      if (!pa.length) return null;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pa), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(na), 3));
      return g;
    }
    return {
      light: geoOf(out.light, out.ln),
      dark: geoOf(out.dark, out.dn),
      moss: geoOf(out.moss, out.mn)
    };
  }


  // ---------------------------------------------------------------------------
  // (x, y, z) is the FOOT CENTRE OF THE HEAD ON THE PEDIMENT'S FRONT PLANE, and
  // +oz is the direction the face looks. `dp` is the relief unit: every depth in
  // faceZ is a multiple of it, so one number scales the whole carving.
  // ---------------------------------------------------------------------------
  function carvedFace(self, B, rng, x, y, z, yaw, w, h, dp, erode) {
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var e = erode || 0;
    var sd = (Math.abs((x * 131.7 + z * 57.1 + y * 19.3 + yaw * 41.0) | 0)) % 1000;
    function put(key, bw, bh, bd, ox, oy, oz, rz, rx) {
      return B.boxR(key, bw, bh, bd, x + ox * c + oz * s, y + oy, z - ox * s + oz * c,
        rx || 0, yaw, rz || 0);
    }
    function putF(key, w0, d0, w1, d1, hh, ox, oy, oz) {
      return B.add(key, frus(w0, d0, w1, d1, hh),
        makeM(x + ox * c + oz * s, y + oy, z - ox * s + oz * c, 0, yaw, 0));
    }

    B.wear = {
      grime: 0.66 + rng.range(-0.06, 0.10) - e * 0.10,
      wet: 1 - e * 0.08,
      edge: 0.74 + rng.range(-0.08, 0.14) - e * 0.12
    };
    // BAKED OCCLUSION, and it is only now that it can do anything. _paint reads
    // this tag, projects each vertex into the head's own frame and darkens by
    // how far BEHIND the cheek plane it sits. Under a 1.05 key at 9 degrees a
    // south elevation is lit by SKY ALONE and flat ambient does not carve, so a
    // 0.66 m socket needs a value drop that does not depend on a light source
    // reaching into it. Until this round every vertex it was darkening was
    // sealed inside the head mass; the field above gives it real hollows.
    B.faceTag = { x: x, z: z, y: y, c: c, s: s, dp: dp, F: FZ_CHEEK * dp, w: w, h: h };

    var sh = null;
    try { sh = faceShell(w, h, dp, sd, e, self.noise); }
    catch (e0) { sh = null; }
    if (sh) {
      var lm = makeM(x, y, z, 0, yaw, 0);
      if (sh.light) B.add('sandstone', sh.light, lm);
      if (sh.dark) B.add('carve', sh.dark, lm);
      if (sh.moss) B.add('mossy', sh.moss, lm);
    } else {
      // The shell IS the face. If it could not be built, a plain proud block is
      // a better failure than a hole in the tower.
      putF('sandstone', w * 0.86, dp * 1.1, w * 0.74, dp * 0.9, h * 0.92, 0, h * 0.46,
        dp * 0.5);
    }

    // ---- the ears --------------------------------------------------------
    // Outboard of the head's own outline, so they cannot come out of the height
    // field, and they run nearly the full height with pendulous lobes - which is
    // the proportion that says Khmer rather than classical.
    for (var q = -1; q <= 1; q += 2) {
      if (e > 0.70 && ((sd >> (q > 0 ? 6 : 8)) & 3) === 0) continue;
      var ex = q * w * 0.480;
      putF('sandstone', w * 0.105, dp * 1.20, w * 0.082, dp * 0.98, h * 0.400,
        ex, h * 0.348, dp * 0.60);
      put('carve', w * 0.052, h * 0.270, dp * 0.66, ex + q * w * 0.006, h * 0.362,
        dp * 1.02);
      put('sandstone', w * 0.092, h * 0.180, dp * 1.00, ex, h * 0.128, dp * 0.56);
      put('sandstone', w * 0.070, h * 0.062, dp * 0.78, ex, h * 0.052, dp * 0.52);
      // the ear ornament, a disc in the lobe
      B.add('sandstone', cyl(w * 0.030, w * 0.030, dp * 0.34, 8),
        makeM(x + ex * c + dp * 1.05 * s, y + h * 0.118, z - ex * s + dp * 1.05 * c,
          Math.PI * 0.5, yaw, 0));
    }
    B.wear = null;
    B.faceTag = null;
  }

  // ================================================================ prasats ==
  // A tower. Five diminishing storeys, a cornice between each, corner
  // pilasters that carry the silhouette, false doors on the cella and Bayon
  // faces on the storeys the caller asks for.
  function faceTower(self, B, rng, o) {
    var x = o.x, z = o.z, W = o.w, H = o.h;
    var e = o.erode || 0;
    var N2 = self.noise;
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
      // ---- THE STOREY IS COURSED ------------------------------------------
      // It used to be ONE tapered block per storey, and photographed at 20 m
      // in the signature framing that is what it looked like: the prasats read
      // as smooth cast concrete with stone mouldings applied to them. The
      // gallery walls two metres away carry visible ashlar; the towers - the
      // subject of hero1, the overview and hero4 - carried none, and a tower
      // whose surface has no joints in it has nothing for the water staining
      // and the lichen to be ON.
      //
      // Nine hundred kilos a block, ~62 cm to a bed, and the beds do not stay
      // parallel: each course is drawn from a noise field along the tower's
      // height so neighbouring courses agree while distant ones do not, each is
      // set back 0-2 cm from the one below and jogged +/-1 cm, and each carries
      // its own grime and edge value. That is the differential erosion the
      // towers were missing, and it costs twelve triangles a course.
      var nCourse = Math.max(2, Math.round(sh / 0.62));
      var cbedH = [], cbedSum = 0, cb;
      for (cb = 0; cb < nCourse; cb++) {
        var cbv = 1 + N2.fbm2(x * 0.21 + cb * 4.3, (z + y) * 0.17 - cb * 2.9, 2) * 0.48;
        cbedH.push(cbv); cbedSum += cbv;
      }
      var cAcc = 0;
      for (cb = 0; cb < nCourse; cb++) {
        var cbh = cbedH[cb] * sh / cbedSum;
        var u0 = cAcc / sh, u1 = (cAcc + cbh) / sh;
        cAcc += cbh;
        var wLo = M.lerp(a, b, u0), wHi = M.lerp(a, b, u1);
        // the recessed joint: a course set back from the one under it is what
        // throws the horizontal shadow line that reads as masonry at 20 m
        var setb = rng.range(0.004, 0.021) + (rng.bool(0.10) ? 0.030 : 0);
        var cg0 = 0.74 + rng.range(-0.10, 0.14) - (i === 0 ? 0.08 : 0);
        B.wear = {
          grime: cg0 + N2.fbm2(x * 0.3, (y + cAcc) * 0.55, 2) * 0.16,
          wet: 1 - (i === 0 ? 0.14 : 0),
          edge: 0.84 + rng.range(-0.12, 0.14) - e * 0.10
        };
        B.frus(mossy ? 'mossy' : 'sandstone', wLo - setb, wLo - setb,
          wHi - setb, wHi - setb, cbh * 1.004,
          x + rng.range(-0.010, 0.010), y + cAcc - cbh * 0.5,
          z + rng.range(-0.010, 0.010), rng.range(-0.004, 0.004));
      }
      B.wear = {
        grime: 0.74 + rng.range(-0.08, 0.12) - (i === 0 ? 0.08 : 0),
        wet: 1 - (i === 0 ? 0.14 : 0),
        edge: 0.84 + rng.range(-0.10, 0.12) - e * 0.10
      };
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
        //
        // THE STOREY TAPERS, AND THAT IS WHY THE FACE NOW SITS IN A PEDIMENT.
        // Two rounds were spent choosing WHICH half-width to register the head
        // against, and both answers are wrong because the question is: at the
        // face's foot the stone is 46 cm further out than at its top, so
        // registering on the foot buries the chin and registering on the top
        // floats it. A PROJECTING PANEL with a flat front gives the relief ONE
        // datum at every height - which is also what a real prasat face storey
        // has, and it brings a rectangular architectural frame with its own
        // shadow line for free. Two boxes per elevation, stepped, so the frame
        // reads as a moulding rather than as a slab.
        var fy = y + sh * 0.020;
        var fh = sh * 0.960;
        var hwBot = M.lerp(a, b, 0.02) * 0.5;
        var hwTop = M.lerp(a, b, 0.98) * 0.5;
        var hwMid = M.lerp(a, b, 0.50) * 0.5;
        // 1.02, not 1.10: a Bayon head including its headdress is about as tall
        // as it is wide, and at 1.10 the field's t axis was compressed enough
        // that the eye band and the mouth ran into each other.
        var fw = Math.min(hwMid * 1.86, fh * 1.02);
        // The panel front. 0.34 m clear of the storey at the face's foot, which
        // is also enough to clear the corner pilasters (they stand at
        // (a+b)*0.245 + a*0.065, i.e. inside hwBot) so the panel is never
        // coplanar with anything.
        var pR = hwBot + 0.34;
        // ... and its back is always 0.30 m inside the stone at the face's top,
        // which is the tightest point.
        var pD = (hwBot - hwTop) + 0.64;
        for (q = 0; q < 4; q++) {
          var fyaw = q * Math.PI * 0.5;
          var fsin = Math.sin(fyaw), fcos = Math.cos(fyaw);
          var fe = M.saturate(e * rng.range(0.5, 1.5));
          B.wear = { grime: 0.70 + rng.range(-0.06, 0.08), wet: 1,
            edge: 0.78 + rng.range(-0.08, 0.10) };
          var bR = pR - 0.16 - pD * 0.5;
          B.boxR('sandstone', fw + 0.62, fh + 0.42, pD,
            x + fsin * bR, fy + (fh + 0.42) * 0.5 - 0.18, z + fcos * bR, 0, fyaw, 0);
          var fR = pR - 0.12;
          B.boxR('sandstone', fw + 0.30, fh + 0.16, 0.24,
            x + fsin * fR, fy + (fh + 0.16) * 0.5 - 0.07, z + fcos * fR, 0, fyaw, 0);
          B.wear = null;
          // 0.180 of relief. A Bayon face stands about a metre proud of its
          // storey; the relief unit multiplies every depth in faceZ, so this one
          // number scales the whole carving against the head's own width.
          carvedFace(self, B, rng,
            x + fsin * pR, fy, z + fcos * pR,
            fyaw, fw, fh, fw * 0.180, fe);
          faceRec.push({
            x: x + fsin * (pR + fw * 0.30), y: fy + fh * 0.45,
            z: z + fcos * (pR + fw * 0.30), yaw: fyaw
          });
        }
      }
      y += sh;
      // cornice
      var ch = 0.020 * H;
      // the drip edge of a prasat cornice - see the note in wallRun. The
      // towers are weighted heaviest of anything in the level because they are
      // the subject of the overview and both courtyard framings and they
      // carried no marks at all above the plinth.
      if (self.cornices && self.cornices.length < 4000) {
        self.cornices.push({ x: x, y: y, z: z, hw: b * 0.50, proud: b * 0.08,
          drop: sh, ring: 1, face: wantFace ? 1 : 0 });
      }
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
        // A PILLAR IS A STACK OF DRUMS, not one extrusion. The colonnade is
        // the closest object in the `interior` framing and a single 3.5 m box
        // gave it one value, one joint and one moss state - with the moss
        // albedo authored strongly enough to survive this level's orange key,
        // "rng.bool(0.22) ? mossy" turned an entire pillar green. Four drums
        // course it, take four different per-block values out of _paint, and
        // let the moss stop where the damp does: heavy at the foot, gone by
        // shoulder height.
        var nDr = pl.broken ? 2 : 4;
        var drH = (ph - 0.24) / nDr;
        for (var dr = 0; dr < nDr; dr++) {
          var dy2 = floorY + 0.24 + (dr + 0.5) * drH;
          var damp = 1 - dr / nDr;
          B.boxR(rng.bool(0.30 * damp * damp) ? 'mossy' : 'sandstone',
            G_PILLAR * (1 - dr * 0.012), drH * 0.985, G_PILLAR * (1 - dr * 0.012),
            px + rng.range(-0.012, 0.012), dy2, pz + rng.range(-0.012, 0.012),
            rng.gaussian(0, 0.006), rng.range(-0.018, 0.018), rng.gaussian(0, 0.006));
        }
        if (!pl.broken) {
          // a real capital: necking, echinus, abacus - three mouldings where
          // there used to be one taper and one plate
          B.frus('sandstone', G_PILLAR * 0.94, G_PILLAR * 0.94, G_PILLAR * 1.06,
            G_PILLAR * 1.06, 0.10, px, floorY + 3.75, pz);
          B.frus('sandstone', G_PILLAR * 1.06, G_PILLAR * 1.06, G_PILLAR * 1.45,
            G_PILLAR * 1.45, 0.24, px, floorY + 3.92, pz);
          B.box('sandstone', G_PILLAR * 1.55, 0.10, G_PILLAR * 1.55, px, floorY + 4.09, pz);
          B.box('sandstone', G_PILLAR * 1.40, 0.03, G_PILLAR * 1.40, px, floorY + 4.155, pz);
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
            var cjit = rng.range(-0.014, 0.014);
            if (axis === 'x') {
              B.boxR('sandstone_d', sl * 0.99, 0.42, 0.98, sa, cy + cjit, oa,
                0, rng.range(-0.012, 0.012), 0);
              // THE FILLET THAT STOPS A CORBEL VAULT READING AS A STAIRCASE.
              // Four square steps a side is what a corbel IS, and photographed
              // dead-on it is a Minecraft staircase; the originals dress the
              // exposed inner arris of each course back at ~35 degrees so the
              // profile scallops toward the capstone. One rotated slab per
              // course per side, 8 triangles, and the vault has a curve.
              B.boxR('sandstone_d', sl * 0.99, 0.30, 0.30, sa, cy - 0.16,
                oa - sgn * 0.42, sgn * 0.62, 0, 0);
            } else {
              B.boxR('sandstone_d', 0.98, 0.42, sl * 0.99, oa, cy + cjit, sa,
                0, rng.range(-0.012, 0.012), 0);
              B.boxR('sandstone_d', 0.30, 0.30, sl * 0.99, oa - sgn * 0.42,
                cy - 0.16, sa, 0, 0, -sgn * 0.62);
            }
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
      var trodOpt = { pitch: 1.14, jitter: 0.7, mossBias: 0.26, trodW: 1.4 };
      if (axis === 'x') trodOpt.trodZ = corrMid; else trodOpt.trodX = corrMid;
      pave(self, B, rng, fr, floorY, trodOpt);
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
        T.y, { pitch: 1.22, skip: skip, jitter: 0.8, trodX: T_CX, trodW: 3.2 });
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
          s.y0, { pitch: 0.98, jitter: 0.6, trodX: T_CX, trodW: 1.8 });
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
        var sth = Math.abs(rise) / n + 0.30;
        var sd2 = Math.abs(run) / n * 1.25;
        // NINE CENTURIES OF FEET. Round two laid every riser identical, every
        // nosing razor-straight and unchipped, with no worn hollow in the
        // tread centres - the roster's own instant-fail. Each step is now cut
        // ACROSS ITS WIDTH into three blocks: two outer ones the width people
        // do not walk on, and a middle one that is 2-4 cm lower and slightly
        // shorter, which is the dished centre a temple stair actually has.
        // Each of the three carries its own settlement and its own yaw.
        var seat = rng.range(0.020, 0.042);
        var parts = broken ? [[0, 1, 0]] : [
          [-0.335, 0.330, 0], [0, 0.340, -seat], [0.335, 0.330, 0]
        ];
        for (var pq = 0; pq < parts.length; pq++) {
          var pw = STAIR_HALF * 2 * (broken ? rng.range(0.55, 0.9) : parts[pq][1]);
          var dz2 = parts[pq][2];
          B.wear = {
            grime: 0.70 + rng.range(-0.08, 0.10) - (dz2 ? 0.06 : 0),
            wet: 1 - (sy < 0.9 ? 0.22 : 0),
            // the middle of a tread is polished by feet, not chipped: less
            // pale substrate there, which also stops the flight reading as
            // cold poured concrete against warm sandstone
            edge: (dz2 ? 0.90 : 0.74) + rng.range(-0.08, 0.14)
          };
          B.boxR(broken ? 'mossy' : (rng.bool(0.10) ? 'mossy' : 'sandstone'),
            pw, sth - (dz2 ? 0.02 : 0), sd2 * (dz2 ? 0.96 : 1.0),
            T_CX + (broken ? rng.range(-0.5, 0.5) : parts[pq][0] * STAIR_HALF * 2) +
              rng.range(-0.015, 0.015),
            sy - sth * 0.5 + dz2 + rng.range(-0.012, 0.012),
            sz + rng.range(-0.015, 0.015),
            rng.gaussian(0, 0.014), rng.gaussian(0, 0.020), rng.gaussian(0, 0.012));
          B.wear = null;
        }
        // one step in twenty-five has lost a block off its nosing
        if (!broken && rng.bool(0.04)) {
          B.wear = { grime: 0.62, wet: 1, edge: 0.60 };
          B.boxR('sandstone', rng.range(0.4, 0.9), 0.22, rng.range(0.3, 0.6),
            T_CX + rng.range(-STAIR_HALF, STAIR_HALF),
            sy - sth - 0.10, sz + rng.range(0.4, 1.1),
            rng.gaussian(0, 0.35), rng.range(0, 3), rng.gaussian(0, 0.35));
          B.wear = null;
        }
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
    B.add('bark', limb(pts, 16, { noise: self.noise, phase: sp.x * 0.7 + sp.z,
      lobes: 5, flute: 0.11, bulge: 0.10, uv: 0.62 }));
    var topX = pts[n][0], topY = pts[n][1], topZ = pts[n][2];

    // ---- buttress roots ----------------------------------------------------
    var nr = sp.kind === 'palm' ? 4 : 8;
    for (i = 0; i < nr; i++) {
      var ang = (i / nr) * Math.PI * 2 + rng.range(-0.3, 0.3);
      var reach = R * rng.range(2.6, 4.6);
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var rp = [];
      for (j = 0; j <= 6; j++) {
        var u = j / 6;
        var rr = R * (0.62 - 0.50 * u) * (1 + 0.4 * (1 - u));
        var ry = gy + (1 - u) * (1 - u) * R * 2.1 - 0.30 * u;
        rp.push([sp.x + ca * reach * u + Math.sin(u * 4.1 + i) * R * 0.22,
          ry, sp.z + sa * reach * u + Math.cos(u * 3.7 + i) * R * 0.22,
          Math.max(0.06, rr)]);
      }
      B.add('bark', limb(rp, 14, { noise: self.noise, phase: i * 1.7 + sp.z,
        lobes: 3 + (i % 3), flute: 0.17, bulge: 0.22, uv: 0.55 }));
      // a second, thinner root braided over the first - a buttress is a web,
      // not a spoke. This replaces the flat box fin, which carried a stretched
      // 0..1 face uv and read as a plywood gusset.
      if (sp.kind !== 'palm') {
        var rp3 = [];
        for (j = 0; j <= 5; j++) {
          var u3 = j / 5;
          rp3.push([
            sp.x + ca * reach * u3 * 0.86 + sa * R * (0.55 - u3 * 0.30),
            gy + (1 - u3) * (1 - u3) * R * 1.35 - 0.22 * u3 + R * 0.18,
            sp.z + sa * reach * u3 * 0.86 - ca * R * (0.55 - u3 * 0.30),
            Math.max(0.05, R * (0.34 - 0.26 * u3))]);
        }
        B.add('bark', limb(rp3, 12, { noise: self.noise, phase: i * 2.3,
          lobes: 3, flute: 0.20, bulge: 0.26, uv: 0.5 }));
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
          [(sp.x + wallX) * 0.5 + 0.7, top * 0.86, zo + rng.range(-0.4, 0.4), R * 0.52],
          [wallX + 1.4, top * 0.75, zo + rng.range(-0.5, 0.5), R * 0.48],
          [wallX + 0.15, top, zo + rng.range(-0.6, 0.6), R * 0.40],
          [(wallX + inner) * 0.5, top - 0.5, zo + rng.range(-0.8, 0.8), R * 0.34],
          [inner + 0.2, 1.8, zo + rng.range(-1.0, 1.0), R * 0.27],
          [inner - 0.6, 0.30, zo + rng.range(-1.2, 1.2), R * 0.19]
        ];
        B.add('bark', limb(rp2, 15, { noise: self.noise, phase: i * 3.1 + zo,
          lobes: 3 + (i % 3), flute: 0.19, bulge: 0.26, uv: 0.55 }));
        // fingers spreading across the wall face
        for (j = 0; j < 4; j++) {
          var fz = zo + rng.range(-2.2, 2.2);
          B.add('bark', limb([
            [wallX + 0.55, top * rng.range(0.5, 0.9), zo, R * 0.16],
            [wallX + 0.50, top * rng.range(0.3, 0.6), fz, R * 0.11],
            [wallX + 0.46, rng.range(0.4, 1.4), fz + rng.range(-1.5, 1.5), R * 0.06]
          ], 10, { noise: self.noise, phase: j * 2.9 + i, lobes: 3,
            flute: 0.16, bulge: 0.20, uv: 0.42 }));
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
      B.add('bark', limb(bp, 12, { noise: self.noise, phase: i * 1.3 + sp.x,
        lobes: 4, flute: 0.13, bulge: 0.14, uv: 0.5 }));
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
      // THE KNOLL SUMMIT IS BARE. It is a mound of collapsed boundary shrine
      // with a metre of soil over it, so nothing big grows on its crown - and
      // the practical consequence is that the establishing standpoint on top
      // of it is not standing inside a tree. The forest generator was free to
      // seed here, and with the new bark recipe two trunks two metres from the
      // lens became a pair of black verticals across the middle of the frame.
      var K0 = self.plan.knoll;
      if (K0) {
        var kdx = x - K0.x, kdz = z - K0.z;
        // 17.5 m, i.e. the knoll's own radius: the mound is bare to its foot.
        // At 10 m the crown was clear but trees at 12-16 m still put their
        // canopies at 23-27 degrees of elevation from a standpoint 12.5 m up,
        // which is exactly the top edge of a 64-degree frame - and the wall of
        // leaf cards came straight back into the top left of the establishing
        // shot it was moved out of.
        if (kdx * kdx + kdz * kdz < 306) continue;
      }
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
      B.add('bark', limb(pts, 8, { noise: N, phase: x * 0.6 + z * 0.3,
        lobes: 4, flute: 0.12, bulge: 0.14, uv: 0.6 }));
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
      B.stick('bark', cp.x + rng.range(-0.5, 0.5), cy + 0.50, cp.z + rng.range(-0.5, 0.5),
        cp.x + rng.range(-0.7, 0.7), cy + 0.62, cp.z + rng.range(-0.7, 0.7), 0.030, 6);
    }
    B.wear = null;
    F.brazier = [cp.x, cy + 0.52, cp.z];
    // the tarp: four poles and a sagging sheet
    var tpx = cp.x + 1.9, tpz = cp.z - 0.9;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      B.wear = { grime: 0.68, wet: 1, edge: 0.78 };
      B.stick('bark', tpx + sx * 1.5, cy, tpz + sz * 1.4,
        tpx + sx * 1.42, cy + (sz > 0 ? 2.05 : 1.72), tpz + sz * 1.4, 0.045, 7);
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
    // a horizontal mark at an EXPLICIT height - cornices, tier tops, treads,
    // wall caps. `ground` cannot do these: they are not on the ground.
    function flat(cell, x, y, z, w, d, rot, tint) {
      B.wear = tint || { grime: 1, wet: 1, edge: 1 };
      B.quad('decal', w, d, x, y, z, -Math.PI * 0.5, 0, rot || 0, atlasUV(cell));
      B.wear = null;
    }
    var GREEN = { grime: 1, wet: 0.80, edge: 1 };

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
    // SMALLER MARKS, MORE OF THEM. A 3.0 x 2.0 m mark off a 512 px atlas cell
    // carries 171 texels/m; at 3 m from the lens that is under one texel per
    // screen pixel and the mask itself is what you see - which is exactly the
    // "posterised low-resolution stencil" finding. At 1.45 x 1.05 the same
    // cell delivers 353 texels/m, and the station pitch drops to match so the
    // fringe still runs continuously along the wall foot.
    for (i = 0; i < lines.length; i++) {
      var L = lines[i];
      var n = Math.round((L.a1 - L.a0) / 1.20);
      for (k = 0; k < n; k++) {
        var a = L.a0 + (k + 0.5) * (L.a1 - L.a0) / n + rng.range(-0.28, 0.28);
        var amt = N.fbm2(a * 0.16, L.b * 0.1, 2) * 0.5 + 0.5;
        if (amt < 0.32) continue;
        var fOut = 0.42 + Math.abs(rng.gaussian(0, 0.38));
        var bx = L.axis === 'x' ? a : L.b + L.out * fOut;
        var bz = L.axis === 'x' ? L.b + L.out * fOut : a;
        ground(rng.bool(0.6) ? FRINGE : MOSS, bx, bz,
          rng.range(1.05, 1.60), rng.range(0.80, 1.25),
          (L.axis === 'x' ? 0 : Math.PI * 0.5) + rng.range(-0.22, 0.22),
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
    // and the branch to the camp - up the first flight and along the tier-1
    // ring, which is the route a person would actually take now the camp is
    // on the terrace rather than on the courtyard floor
    for (i = 0; i < 8; i++) {
      ground(WORN, M.lerp(0.6, P.camp.x, i / 7) + rng.range(-0.5, 0.5),
        M.lerp(-5.95, P.camp.z, i / 7) + rng.range(-0.4, 0.4), 2.6, 2.2, rng.range(0, 3));
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
    for (i = 0; i < 96; i++) {
      var e = rng.int(0, 3);
      var aa, xx, zz, yaw2;
      if (e === 0) { aa = rng.range(-G_X, G_X); xx = aa; zz = G_ZS + 0.02; yaw2 = 0; }
      else if (e === 1) { aa = rng.range(G_ZN, G_ZS); xx = G_X + 0.02; zz = aa; yaw2 = Math.PI * 0.5; }
      else if (e === 2) { aa = rng.range(G_ZN, G_ZS); xx = -G_X - 0.02; zz = aa; yaw2 = -Math.PI * 0.5; }
      else { aa = rng.range(-G_X, G_X); xx = aa; zz = G_ZN - 0.02; yaw2 = Math.PI; }
      onWall(rng.bool(0.5) ? STAIN : (rng.bool(0.5) ? MOSS : EFFL),
        xx, 0.28 + rng.range(0.6, 2.8), zz, rng.range(0.8, 1.6), rng.range(1.0, 2.2), yaw2);
    }
    // cracks across the courtyard flagstones
    for (i = 0; i < 26; i++) {
      ground(CRACK, rng.range(-24, 24), rng.range(-36, 2), rng.range(3, 6),
        rng.range(3, 6), rng.range(0, 3));
    }

    // ========================================================================
    // THE GREEN PASS.
    //
    // The finding: green occupied 0.6% of hero1 and 0.4% of the interior, and
    // 66% / 85% of their saturated pixels sat in a single 30-degree hue bin -
    // i.e. the level was a monochrome salmon picture, not the "grey-gold /
    // moss" the roster specifies. The cause was that everything above only ran
    // over the gallery's OUTER wall and the tower faces. The terrace tiers,
    // the great stair, the gopura, the causeway and the whole gallery INTERIOR
    // - which between them are 100% of the near field of hero1, hero3, hero4
    // and interior - got no growth at all.
    //
    // Everything below follows WATER, because that is where moss actually
    // grows: the top of every horizontal ledge that holds rain, the vertical
    // face directly under it where the run-off streaks, the joint at the foot
    // of every pillar, and the inside of the treads where a stair holds a
    // puddle. None of it is scattered.
    var TIERS = TIER, tq, ta, tb;

    // ---- every tier: moss along the cornice top, streaks down the face ------
    var prevTY = -0.70;
    for (i = 0; i < TIERS.length; i++) {
      var T = TIERS[i];
      var tx0 = T_CX - T.hx, tx1 = T_CX + T.hx;
      var tz0 = T_CZ - T.hz, tz1 = T_CZ + T.hz;
      for (tq = 0; tq < 4; tq++) {
        var horiz = (tq < 2);
        var span = horiz ? (tx1 - tx0) : (tz1 - tz0);
        // 1.6 m stations, two marks each, both jittered along the run. At 3.2 m
        // stations with a fixed size the cornice marks lined up into a
        // perfectly regular green STRIPE along each tier - and a tier top seen
        // from a 1.66 m eye is nearly edge-on, so that stripe was one of the
        // most obviously artificial things in the frame.
        var nn = Math.max(4, Math.round(span / 1.6));
        for (k = 0; k < nn; k++) {
          var u3 = (k + 0.5 + rng.range(-0.34, 0.34)) / nn;
          var aa2 = horiz ? M.lerp(tx0, tx1, u3) : M.lerp(tz0, tz1, u3);
          var bb2 = horiz ? (tq === 0 ? tz1 : tz0) : (tq === 2 ? tx0 : tx1);
          var mx = horiz ? aa2 : bb2, mz = horiz ? bb2 : aa2;
          var amt2 = N.fbm2(mx * 0.22 + 5.1, mz * 0.22 - 2.2, 2) * 0.5 + 0.5;
          if (amt2 < 0.34) continue;
          // the cornice top: where the rain sits
          var cw2 = rng.range(0.9, 1.8), cd2 = rng.range(0.7, 1.4);
          flat(rng.bool(0.62) ? MOSS : (rng.bool(0.5) ? FRINGE : ROOTH),
            mx + (horiz ? rng.range(-0.4, 0.4) : (tq === 2 ? 0.5 : -0.5) + rng.range(-0.2, 0.2)),
            T.y + 0.028,
            mz + (horiz ? (tq === 0 ? -0.5 : 0.5) + rng.range(-0.2, 0.2) : rng.range(-0.4, 0.4)),
            horiz ? cw2 : cd2, horiz ? cd2 : cw2, rng.range(-0.25, 0.25), GREEN);
          // and the face under it, streaked. SMALL: a 2.9 m mark off a 512 px
          // atlas cell is 0.6 texels per screen pixel at 4 m and reads as
          // paint. Under 1.6 m it holds its own frontier.
          if (!rng.bool(0.88)) continue;
          var fyaw2 = horiz ? (tq === 0 ? 0 : Math.PI) : (tq === 2 ? -Math.PI * 0.5 : Math.PI * 0.5);
          var sel2 = rng.next();
          onWall(sel2 < 0.42 ? MOSS : (sel2 < 0.60 ? FRINGE
            : (sel2 < 0.82 ? STAIN : LICHEN)),
            mx + (horiz ? 0 : (tq === 2 ? -0.03 : 0.03)),
            M.lerp(prevTY, T.y, rng.range(0.16, 0.90)),
            mz + (horiz ? (tq === 0 ? 0.03 : -0.03) : 0),
            rng.range(0.7, 1.6), rng.range(0.6, 1.5), fyaw2,
            sel2 < 0.60 ? GREEN : null);
        }
      }
      // THE FOOT OF THE TIER. Water sheds off 14 m of terrace and stops in
      // this joint; it is also, from a 1.66 m eye in the courtyard, the one
      // continuous horizontal line running right across the middle of the
      // hero1 framing, so it is where growth is both most likely and most
      // visible. Run at 1.3 m and jittered so it is a damp margin rather than
      // a painted skirting.
      for (tq = 0; tq < 4; tq++) {
        var hz2 = (tq < 2);
        var sp2 = hz2 ? (tx1 - tx0) : (tz1 - tz0);
        var nf = Math.max(4, Math.round(sp2 / 1.3));
        for (k = 0; k < nf; k++) {
          if (!rng.bool(0.78)) continue;
          var uf = (k + 0.5 + rng.range(-0.3, 0.3)) / nf;
          var af = hz2 ? M.lerp(tx0, tx1, uf) : M.lerp(tz0, tz1, uf);
          var bf = hz2 ? (tq === 0 ? tz1 : tz0) : (tq === 2 ? tx0 : tx1);
          var ox4 = hz2 ? 0 : (tq === 2 ? -1 : 1) * rng.range(0.35, 0.95);
          var oz4 = hz2 ? (tq === 0 ? 1 : -1) * rng.range(0.35, 0.95) : 0;
          var fx4 = (hz2 ? af : bf) + ox4, fz4 = (hz2 ? bf : af) + oz4;
          if (Math.abs(fx4 - T_CX) < STAIR_HALF + 0.8 && tq === 0) continue;
          ground(rng.bool(0.55) ? FRINGE : (rng.bool(0.5) ? MOSS : ALGAE),
            fx4, fz4, rng.range(1.0, 2.0), rng.range(0.8, 1.6),
            rng.range(0, 3), GREEN);
        }
      }
      prevTY = T.y;
    }

    // ---- the great stair: mossy stringers, algae in the tread joints -------
    var segs2 = P.stairSegs || [];
    for (i = 0; i < segs2.length; i++) {
      var sg = segs2[i];
      var nSt = Math.max(3, Math.round(Math.abs(sg.z1 - sg.z0) / 0.75));
      for (k = 0; k < nSt; k++) {
        var us = (k + 0.5) / nSt;
        var szz = M.lerp(sg.z0, sg.z1, us), syy = M.lerp(sg.y0, sg.y1, us);
        // algae ponding in the joint at the back of the tread
        if (rng.bool(0.62)) {
          flat(rng.bool(0.5) ? ALGAE : MOSS,
            T_CX + rng.range(-STAIR_HALF * 0.92, STAIR_HALF * 0.92), syy + 0.03, szz,
            rng.range(0.7, 1.9), rng.range(0.4, 0.9), rng.range(-0.2, 0.2), GREEN);
        }
        // the cheek walls - the wettest, shadiest stone on the whole flight
        for (var sgn2 = -1; sgn2 <= 1; sgn2 += 2) {
          if (!rng.bool(0.66)) continue;
          flat(rng.bool(0.55) ? MOSS : FRINGE,
            T_CX + sgn2 * (STAIR_HALF + 0.34), syy + 0.62, szz,
            0.8, 1.5, 0, GREEN);
          onWall(rng.bool(0.5) ? MOSS : ROOTH,
            T_CX + sgn2 * (STAIR_HALF + 0.66), syy + rng.range(0.05, 0.45), szz,
            1.3, rng.range(0.6, 1.2), sgn2 * Math.PI * 0.5, GREEN);
        }
      }
    }

    // ---- a fringe at the foot of every gallery pillar -----------------------
    // Run-off off the corbelled vault lands in the colonnade and stops at the
    // pillar bases; that joint is the greenest thing in the interior framing
    // and it had nothing in it at all.
    for (i = 0; i < P.pillars.length; i++) {
      var pl2 = P.pillars[i];
      var pout = (pl2.side === 's') ? [0, 1] : (pl2.side === 'n') ? [0, -1]
        : (pl2.side === 'w') ? [-1, 0] : [1, 0];
      flat(rng.bool(0.55) ? FRINGE : MOSS,
        pl2.x + pout[0] * 0.55, 0.315, pl2.z + pout[1] * 0.55,
        rng.range(1.1, 1.8), rng.range(1.0, 1.6), rng.range(0, 3), GREEN);
      if (rng.bool(0.55)) {
        onWall(rng.bool(0.5) ? MOSS : LICHEN,
          pl2.x + pout[0] * 0.24, 0.28 + rng.range(0.25, 1.1), pl2.z + pout[1] * 0.24,
          0.55, rng.range(0.5, 1.2),
          pout[0] ? pout[0] * Math.PI * 0.5 : (pout[1] > 0 ? 0 : Math.PI), GREEN);
      }
      // and on the corridor side, against the outer wall
      if (rng.bool(0.5)) {
        flat(rng.bool(0.6) ? MOSS : ALGAE,
          pl2.x - pout[0] * rng.range(1.4, 3.0), 0.312,
          pl2.z - pout[1] * rng.range(1.4, 3.0),
          rng.range(1.4, 2.6), rng.range(1.2, 2.2), rng.range(0, 3), GREEN);
      }
    }

    // ---- the gallery INTERIOR: the inner face of the outer wall -------------
    // SMALLER MARKS, MORE OF THEM - the same fix, and the same arithmetic, as
    // the wall-foot fringe above, but this wall is the closest large surface to
    // any camera in the level. The interior framing stands 1.8 m off it; a 1.9 m
    // mark off a 512 px atlas cell delivers 269 texels/m against about 1100
    // screen pixels per metre at that range, so its painted lobes are magnified
    // four times past their own resolution and a moss sheet reads as a flat
    // green field with hard shapes in it. Photographed, two overlapping marks
    // covered most of the right-hand wall in exactly that. Under 1.2 m the same
    // cell keeps its frontier, and the station count goes up so the wall does
    // not lose coverage.
    for (i = 0; i < 190; i++) {
      var e3 = rng.int(0, 3);
      var ax3, xx3, zz3, yaw3;
      if (e3 === 0) { ax3 = rng.range(-G_X + 5, G_X - 5); xx3 = ax3; zz3 = G_ZS - G_WALL - 0.02; yaw3 = Math.PI; }
      else if (e3 === 1) { ax3 = rng.range(G_ZN + 5, G_ZS - 5); xx3 = G_X - G_WALL - 0.02; zz3 = ax3; yaw3 = -Math.PI * 0.5; }
      else if (e3 === 2) { ax3 = rng.range(G_ZN + 5, G_ZS - 5); xx3 = -G_X + G_WALL + 0.02; zz3 = ax3; yaw3 = Math.PI * 0.5; }
      else { ax3 = rng.range(-G_X + 5, G_X - 5); xx3 = ax3; zz3 = G_ZN + G_WALL + 0.02; yaw3 = 0; }
      var hgt3 = rng.next();
      onWall(hgt3 < 0.34 ? (rng.bool(0.6) ? MOSS : FRINGE)
        : (hgt3 < 0.70 ? STAIN : (rng.bool(0.5) ? LICHEN : EFFL)),
        xx3, 0.28 + M.lerp(0.2, 3.6, hgt3), zz3,
        rng.range(0.50, 1.20), rng.range(0.45, 1.15), yaw3,
        hgt3 < 0.34 ? GREEN : null);
      // and the floor joint right under it - the wettest line in the level,
      // where run-off off the corbelled vault ends up
      if (hgt3 < 0.42) {
        flat(rng.bool(0.6) ? FRINGE : MOSS,
          xx3 + Math.sin(yaw3) * rng.range(0.35, 1.10), 0.318,
          zz3 + Math.cos(yaw3) * rng.range(0.35, 1.10),
          rng.range(1.0, 1.9), rng.range(0.8, 1.5), yaw3 + rng.range(-0.3, 0.3),
          GREEN);
      }
    }

    // ---- the gopura, inside and out ----------------------------------------
    for (i = 0; i < 56; i++) {
      var gu = rng.next();
      var gx2 = rng.range(-GOP_HALF_X, GOP_HALF_X);
      var gz2 = (rng.bool(0.5) ? 1 : -1) * (GOP_HALF_Z + 0.03);
      onWall(gu < 0.45 ? MOSS : (gu < 0.75 ? STAIN : LICHEN),
        gx2, 0.30 + rng.range(0.2, 3.4), GOP_Z + gz2,
        rng.range(0.75, 1.55), rng.range(0.8, 1.8), gz2 > 0 ? 0 : Math.PI,
        gu < 0.45 ? GREEN : null);
      if (rng.bool(0.6)) {
        flat(rng.bool(0.6) ? FRINGE : MOSS, gx2, 0.322, GOP_Z + gz2 * 1.22,
          rng.range(1.0, 1.7), rng.range(0.7, 1.2), rng.range(-0.2, 0.2), GREEN);
      }
    }
    // The GATE TOWER itself, which had no marks of any kind - it is not in
    // P.towers (that list is the sanctuary quincunx) so the tower staining
    // pass above skipped it entirely, and it is the whole subject of hero4.
    for (i = 0; i < 34; i++) {
      var gq = (i % 4) * Math.PI * 0.5;
      // The tower TAPERS. A mark laid at a fixed half-width stood proud of the
      // stone above the first storey and hung in the sky beside the silhouette
      // as a green flag, so the offset tracks the taper and the run stops at
      // the top of the face storey.
      var gy2 = 5.60 + rng.range(0.3, 5.4);
      var ghw = 3.15 - ((gy2 - 5.60) / 8.6) * 1.35 - (i % 3) * 0.06;
      var gsel = rng.next();
      onWall(gsel < 0.34 ? MOSS : (gsel < 0.52 ? LICHEN
        : (gsel < 0.80 ? STAIN : EFFL)),
        Math.sin(gq) * (ghw + 0.05) + Math.cos(gq) * rng.range(-1.5, 1.5),
        gy2,
        GOP_Z + Math.cos(gq) * (ghw + 0.05) - Math.sin(gq) * rng.range(-1.5, 1.5),
        rng.range(0.8, 1.7), rng.range(0.9, 2.2), gq,
        gsel < 0.34 ? GREEN : null);
    }
    // the passage interior, where nothing dries out
    for (i = 0; i < 12; i++) {
      var pq2 = rng.bool(0.5) ? 1 : -1;
      onWall(rng.bool(0.6) ? MOSS : ALGAE, pq2 * 1.68,
        0.30 + rng.range(0.1, 2.2), GOP_Z + rng.range(-GOP_HALF_Z, GOP_HALF_Z),
        1.0, rng.range(0.8, 1.8), pq2 * Math.PI * 0.5, GREEN);
    }

    // ---- the causeway: the naga plinths and the deck joints -----------------
    // The causeway deck is WALKED ON and it is also 3 m of foreground in the
    // hero3 framing, so the marks here are small, sparse and mostly on the
    // revetment BELOW the deck where the moat damp is - a 1.5 x 2.4 m sheet of
    // moss laid on the deck two metres from the lens read as a green tarpaulin.
    for (i = 0; i < P.naga.length; i++) {
      for (var cs2 = -1; cs2 <= 1; cs2 += 2) {
        var cbx = cs2 * (CW_HALF + 0.34);
        if (rng.bool(0.34)) {
          flat(rng.bool(0.5) ? MOSS : FRINGE, cbx - cs2 * rng.range(0.5, 0.8),
            CW_Y + 0.045, P.naga[i].z + rng.range(-1.4, 1.4),
            rng.range(0.5, 0.95), rng.range(0.7, 1.3), rng.range(0, 3), GREEN);
        }
        // the wet band on the revetment, at and below the water line
        onWall(rng.bool(0.6) ? ALGAE : MOSS, cs2 * (CW_HALF + 0.60),
          CW_Y - rng.range(0.9, 1.7), P.naga[i].z + rng.range(-1.5, 1.5),
          rng.range(0.9, 1.6), rng.range(0.8, 1.4), cs2 * Math.PI * 0.5, GREEN);
      }
    }
    // AND THE OUTER COURT, which is now the whole near and mid field of hero2.
    // Tripled, and at a mark size that holds its own frontier at 4 m.
    for (i = 0; i < 96; i++) {
      var ox3 = rng.range(-ENC_X + 2, ENC_X - 2), oz3 = rng.range(ENC_ZN, GOP_Z - GOP_HALF_Z);
      if (Math.abs(ox3) < 3.2 && oz3 > 12) continue;      // keep the worn path clear
      ground(rng.bool(0.55) ? MOSS : (rng.bool(0.5) ? FRINGE : LITTER),
        ox3, oz3, rng.range(1.1, 2.1), rng.range(0.9, 1.7), rng.range(0, 3), GREEN);
    }
    // cracks and worn hollows across the outer-court paving - the near field of
    // hero2 is 10 m of flagstone and it had nothing on it but a grid
    for (i = 0; i < 34; i++) {
      ground(rng.bool(0.5) ? CRACK : WORN, rng.range(-ENC_X + 2, ENC_X - 2),
        rng.range(ENC_ZN + 0.5, GOP_Z - GOP_HALF_Z), rng.range(2.2, 4.4),
        rng.range(2.0, 4.0), rng.range(0, 3));
    }
    void ta; void tb;
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
    for (i = 0; i < 46; i++) seeds.push([rng.range(-26, 26), rng.range(-38, 2), 0.85]);
    for (i = 0; i < 15; i++) seeds.push([rng.range(-28, 28), rng.range(6, 20), 0.7]);
    for (i = 0; i < 18; i++) {
      seeds.push([rng.range(X_MIN + 10, X_MAX - 10), rng.range(Z_MIN + 10, Z_MAX - 10), 0.6]);
    }
    // SMALL cards. A 30 m card at 0.7 m covers every pixel below the horizon
    // at one alpha, which is a sheet of tracing paper over the level and is
    // exactly how round two photographed. At 11 m they read as discrete
    // patches lying in the hollows, which is what ground mist does.
    // THE THIRD LAYER IS THE ONE THAT MATTERS AND IT IS NOT HORIZONTAL.
    //
    // Round two emitted only the two flat layers below. From a 1.66 m eye
    // pitched a few degrees they are seen at 5-15 degrees of grazing, present
    // almost no projected area, and contribute nothing BETWEEN the towers -
    // so the level's named condition was absent from its signature image and
    // the long god rays the hero1 framing was designed around had no medium to
    // exist in. Where a flat card happened to lie over the moat it worked
    // beautifully, which proved the atlas and the tinting were never the
    // problem: the ORIENTATION was.
    //
    // THE THIRD LAYER IS AN UPRIGHT CROSS-CARD BANK, and that is the whole fix.
    //
    // Round three tilted the third layer 0.52 rad off horizontal and it still
    // did nothing, for a reason a tilt cannot solve: a single tilted card has
    // ONE normal, so its projected area collapses toward zero for half the
    // bearings you can look at it from. Rotating it further toward vertical
    // only trades "no area" for "a bright sliver that reads as a steam jet",
    // which is exactly what both previous attempts photographed.
    //
    // A CROSS - two upright quads at 90 degrees, sharing one origin - has no
    // such bearing. Whatever direction the camera looks from, one of the pair
    // is within 45 degrees of face-on, so the pair's projected area never
    // drops below 71% of a single card's and never spikes above 141%. That is
    // the standard way volumetric-looking media is faked without a volume, and
    // it is the only version of this that survives an arbitrary framing.
    //
    // They stand ON THE GROUND (bottom edge at the terrain, the bank cell's
    // density in its lowest third) and reach 1.5-2.4 m - ankle to head. So the
    // medium POOLS at ankle height, the towers stand out of it, and the
    // tower shadows crossing it have something to be shadows in.
    // A CARD THAT INTERSECTS A BUILDING SHOWS THE BUILDING'S OWN SILHOUETTE
    // CUT INTO IT. The first pass at this stood 13.5 m banks in the courtyard
    // and the tier and tower masses sliced them: what photographed was a
    // bright translucent wedge with a dead-straight edge lying across the
    // centre prasat, which reads as a rendering fault and not as air. There is
    // no depth-fade available here (postfx owns the depth buffer), so the
    // answer is geometric - keep the banks SMALL, keep them LOW, and keep them
    // out of the volume the masonry occupies. `clear` is that keep-out, and it
    // also stops mist forming inside the sealed gallery corridor, where a
    // roofed stone passage has no business steaming.
    function clear(px, pz) {
      var m2 = 2.6;
      // The sanctuary terrace needs only a token margin, because the real rule
      // that keeps mist off it is the GROUND-HEIGHT test in the caller. What
      // actually produced the bright wedge lying across the centre prasat was
      // not proximity: it was that sampleGround resolves the terrace tiers
      // analytically, so a seed inside the terrace footprint stood its card ON
      // TIER THREE at 5.5 m, three metres from a tower, and the tower sliced
      // it. Rejecting anything whose ground is above a metre fixes that at the
      // source and lets the medium run right up to the foot of the tier -
      // which is the wettest line in the courtyard, the one continuous
      // horizontal across the middle of hero1, and where a bank belongs.
      if (Math.abs(px - T_CX) < TIER[0].hx + 0.3 &&
          pz > T_CZ - TIER[0].hz - 0.3 && pz < T_CZ + TIER[0].hz + 0.3) return false;
      // the gallery ring: its walls, its corridor and its roof
      if (Math.abs(px) < G_X + m2 && pz > G_ZN - m2 && pz < G_ZS + m2 &&
          (Math.abs(px) > G_PX - m2 || pz > G_PZS - m2 || pz < G_PZN + m2)) return false;
      // the gate and its wings
      if (Math.abs(px) < GOP_HALF_X + m2 &&
          pz > GOP_Z - GOP_HALF_Z - m2 && pz < GOP_Z + GOP_HALF_Z + m2) return false;
      // the enclosure walls
      if (pz > ENC_ZN - m2 && pz < ENC_ZS + m2 &&
          (Math.abs(Math.abs(px) - ENC_X) < m2 ||
           (Math.abs(pz - ENC_ZS) < m2 && Math.abs(px) > GOP_HALF_X))) return false;
      // both libraries
      for (var q2 = 0; q2 < P.libraries.length; q2++) {
        var lb = P.libraries[q2];
        if (Math.abs(px - lb.x) < 4.4 + m2 && Math.abs(pz - lb.z) < 4.4 + m2) return false;
      }
      // the causeway deck and its balustrades
      if (Math.abs(px) < CW_HALF + 1.4 + m2 && pz > CW_Z0 - m2 && pz < CW_Z1 + m2) return false;
      // EVERY RUBBLE HEAP. The masonry keep-outs above are all buildings, and
      // buildings are not what actually sliced these cards: the block piles are
      // 2-3 m tall, they are deliberately placed 3-5 m in front of every hero
      // standpoint, and a bank standing among them shows their silhouettes cut
      // into it as dead-straight edges. The near fade handles the first two
      // metres; this handles the rest, at the source.
      for (var q3 = 0; q3 < P.rubble.length; q3++) {
        var rb = P.rubble[q3];
        var rdx = px - rb.x, rdz = pz - rb.z, rr3 = rb.r + 1.6;
        if (rdx * rdx + rdz * rdz < rr3 * rr3) return false;
      }
      return true;
    }
    var layers = [
      { y: 0.30, n: seeds.length, s: 11, o: 1.00, bank: 0 },
      { y: 0.62, n: Math.round(seeds.length * 0.50), s: 15, o: 0.60, bank: 0 },
      { n: Math.round(seeds.length * 4.0), s: 4.8, o: 1.00, bank: 1 }
    ];
    var UV_BLOB = [0.002, 0.004, 0.498, 0.996];
    var UV_BANK = [0.502, 0.004, 0.998, 0.996];
    var cols = [];
    for (var l = 0; l < layers.length; l++) {
      var L = layers[l];
      for (i = 0; i < L.n; i++) {
        var sd = seeds[(i * (l + 1) * 7 + l * 3) % seeds.length];
        var x = sd[0] + rng.gaussian(0, L.bank ? 5.5 : 3.5);
        var z = sd[1] + rng.gaussian(0, L.bank ? 5.5 : 3.5);
        var s = L.s * rng.range(0.7, 1.35) * (0.7 + 0.5 * sd[2]);
        var nCard = 1;
        if (L.bank) {
          // bottom edge on the terrain, top edge at 1.1-1.9 m - knee to chest.
          // Ground mist that reaches head height is fog, and this level already
          // has fog; what it did not have was a medium POOLING at ankle height
          // that a tower can stand out of.
          var bh = rng.range(1.1, 1.9);
          var gy0 = self.sampleGround(x, z);
          if (gy0 < -14) continue;
          // never on top of the temple: mist collects in the low ground
          if (gy0 > 1.05) continue;
          if (!clear(x, z)) continue;
          var yaw0 = rng.range(0, Math.PI * 2);
          var gq = quad(s, bh, UV_BANK[0], UV_BANK[1], UV_BANK[2], UV_BANK[3]);
          ents.push({ geometry: gq,
            matrix: makeM(x, gy0 + bh * 0.5 - 0.12, z, 0, yaw0, 0) });
          ents.push({ geometry: gq,
            matrix: makeM(x, gy0 + bh * 0.5 - 0.12, z, 0, yaw0 + Math.PI * 0.5, 0) });
          nCard = 2;
        } else {
          ents.push({
            geometry: quad(s, s, UV_BLOB[0], UV_BLOB[1], UV_BLOB[2], UV_BLOB[3]),
            matrix: makeM(x, L.y + rng.range(-0.18, 0.18), z,
              -Math.PI * 0.5, rng.range(0, Math.PI * 2), 0)
          });
        }
        // warmer toward the sun, cooler away: the mist is the only surface in
        // the level big enough to carry the level's whole colour axis, and
        // with the zenith of this sky measuring blue ABOVE green it is also
        // the only cool anchor the grade has to work against. The cool end is
        // pushed further into blue and the warm end further into the key's own
        // orange than the delivered ratio, deliberately - a monochrome frame
        // does not get separated by a medium that is itself monochrome.
        // The warm window was 0.30-0.98, which put the whole inner courtyard
        // at 0.24 of warm - i.e. the level's biggest volume of mist read COOL
        // in four of the five framings, and the highlight tint on the
        // signature frame fell from R-B +0.153 to +0.099 as the medium came
        // in. At dawn the mist between the eye and a sun on the horizon is
        // BACK-LIT and it glows; only the air on the far side of the temple is
        // cool. 0.22-0.90 puts the courtyard at 0.67 of warm and keeps the
        // blue anchor where it belongs, behind the north gallery.
        // 0.14-0.80, not 0.22-0.90, and this is the second half of the hem fix
        // rather than a new opinion. Removing the opaque bottom edge also removed
        // a card that had been sitting two metres from the lens at full strength
        // in every framing - i.e. a warm gel over the whole picture - and the
        // measurement says exactly that: hero1's brightest 5% went from R-B
        // +0.118 to +0.071 and its grade split from +0.043 to +0.010 while the
        // towers behind it did not move at all (L 0.234 to 0.238). A gel over the
        // sky is not a grade, so it is right that it is gone; but the level's own
        // argument for the ramp - at dawn the mist between the eye and a sun on
        // the horizon is BACK-LIT and glows, and only the air on the far side of
        // the temple is cool - was being under-served by the old window. At the
        // inner courtyard's own sunward value of 0.55 the old window returned
        // 0.48 of warm, i.e. neutral, for the volume the key is shining THROUGH
        // toward the camera. 0.14-0.80 returns 0.71 there and still leaves the
        // north courtyard and the far jungle on the cool end, which is where the
        // grade's blue anchor lives.
        var sunward = M.saturate((x * SUN_X + z * SUN_Z) / 60 * 0.5 + 0.5);
        var warm = M.smoothstep(0.14, 0.80, sunward);
        var amp = L.o * sd[2] * (L.bank ? 0.80 : 1.0);
        var cc = [
          M.lerp(0.088, 0.345, warm) * amp,
          M.lerp(0.126, 0.236, warm) * amp,
          M.lerp(0.208, 0.148, warm) * amp
        ];
        for (var nc = 0; nc < nCard; nc++) cols.push(cc);
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

  // ---------------------------------------------------------- the near fade --
  // THE ONE THING THE GEOMETRIC KEEP-OUT ABOVE CANNOT DO.
  //
  // `clear()` keeps the banks out of the volume the MASONRY occupies, and that
  // worked: no card is sliced by a wall or a tower any more. What it cannot
  // know about is the tumbled stone - the block piles at (-8.4,-3.2), the
  // toppled lintel at (-11.2,-5.6), the gate spoil in the outer court - which
  // is deliberately placed 3-5 m in front of every hero standpoint precisely
  // because a frame needs hard foreground. Measured on hero1, the level's
  // signature image: a 4.8 m bank standing 2 m from the lens laid a 0.28-alpha
  // wash over the near blocks with a DEAD-STRAIGHT diagonal where the card's
  // own polygon edge crossed them, and the same wedge cut the great stair in
  // the lower right. That reads as a rendering fault, not as air, and it was
  // costing the frame its whole foreground.
  //
  // The fix is not more keep-out volumes - a keep-out per rubble pile is a list
  // that goes stale the moment anything moves. It is that A PARTICIPATING
  // MEDIUM HAS NO NEAR FIELD: the inscatter along a ray is an integral over
  // path length, so at two metres there is almost nothing of it and the card
  // model - constant alpha regardless of distance - is simply wrong there. So
  // the alpha is ramped in over the first several metres of view distance.
  // Everything within 1.4 m of the eye disappears - a card that close subtends
  // most of the frame and its texture is magnified past its own frequency - and
  // by 7 m it is at full strength.
  //
  // The window used to be 2.8 to 13 m, which was a workaround for the opaque
  // bottom hem on the bank cell (see buildMistTexture): pushing the medium out
  // to 13 m was the only way to get the hard edge off the near geometry, and it
  // cost the signature frame half its grade split, because a warm back-lit haze
  // in the near field was the warmest thing in it (measured: highlight tint fell
  // from +0.030 R to +0.014 R when it went). With the hem fixed at source the
  // card has no edge to hide, so the window closes back to where a participating
  // medium actually wants it and the ground haze comes back.
  //
  // onBeforeCompile rather than a hand-written ShaderMaterial, because the
  // material must keep participating in sky.js's height fog (`fog: true`) and
  // in the vertex-colour tinting above, and re-implementing those is how a
  // level file quietly diverges from the shared atmosphere.
  function mistNearFade(mat) {
    try {
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uMistFade = { value: new THREE.Vector2(1.4, 7.0) };
        shader.vertexShader = 'varying float vMistD;\n' + shader.vertexShader
          .replace('#include <project_vertex>',
            '#include <project_vertex>\n\tvMistD = - mvPosition.z;');
        shader.fragmentShader = 'uniform vec2 uMistFade;\nvarying float vMistD;\n' +
          shader.fragmentShader.replace('#include <dithering_fragment>',
            '#include <dithering_fragment>\n' +
            '\tgl_FragColor.a *= smoothstep( uMistFade.x, uMistFade.y, vMistD );');
      };
      // Distinct from every other MeshBasicMaterial in the build, so three.js
      // never hands this program to one of them or vice versa.
      mat.customProgramCacheKey = function () { return 'ruins_mist_nearfade'; };
      mat.needsUpdate = true;
    } catch (e) { GAME.logError('ruins.mistFade', e); }
    return mat;
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
    // Every projecting horizontal this file builds, recorded as it is built
    // and published as anchors.cornices at the end of build() for
    // props_ruins.js's water-staining pass. See the note in wallRun.
    this.cornices = [];
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
      A.pools.push({ name: p.name, x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, waterY: p.y,
        shallow: !!p.shallow });
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
      else if (surf.own === 'bark') m = this._barkMaterial();
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
    // ROUGHNESS 0.075 -> 0.155 AND normalScale 0.72 -> 0.30. Both are the same
    // fix for the same measurement: hero3's sheet came back at Lstd 0.1985 and
    // 45e-3 of gradient - a black pool with a field of pure-white 2-4 px
    // specular fireflies on it, chromatically fringed, which is what a mirror
    // BRDF does when its normal map's detail is sub-pixel. Widening the lobe
    // integrates the sub-pixel ripple instead of sampling it.
    //
    // envMapIntensity 1.75 -> 2.9 AND a paler, greyer body. The sheet
    // measured L 0.124 under a sky measuring 0.384: water at grazing
    // incidence is dominated by Fresnel reflection and the FAR half of a
    // sheet should approach the sky's own luminance. MeshStandardMaterial
    // already has the Fresnel (specularF90 drives F to 1 at the horizon); what
    // it did not have was enough environment to reflect. A black pool under a
    // bright dawn sky is what made every courtyard in the level read as a
    // hole, and it is the single cheapest way to light the bottom of a frame.
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x232b28, THREE.SRGBColorSpace),
      roughness: 0.155, metalness: 0.0, vertexColors: true,
      envMapIntensity: 2.9
    });
    if (tex) {
      m.normalMap = tex;
      m.normalScale = new THREE.Vector2(0.30, 0.30);
    }
    m.name = 'ruins_water';
    this._waterMat = m;
    return m;
  };

  // BARK. Its own recipe rather than materials.js's sawn-plank one, mapped off
  // limb()'s arc-length uv so the fibre runs along the root. The albedo target
  // is deliberately BELOW the masonry: a fig root is a dark wet-looking mass
  // and in hero2 the roots were measuring half a stop brighter than the wall
  // they are prising apart, which inverted the whole read of the image.
  LevelRuins.prototype._barkMaterial = function () {
    var pair = null;
    try {
      pair = buildBarkTexture(this.rng.fork ? this.rng.fork(0xBA12) : this.rng, this.noise);
    } catch (e) { GAME.logError('ruins.barkTex', e); }
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x5f5648, THREE.SRGBColorSpace),
      roughness: 0.95, metalness: 0.0, vertexColors: true, envMapIntensity: 0.85
    });
    if (pair && pair[0]) {
      var a = makeTex(pair[0], true, this._aniso());
      if (a) { a.repeat.set(1, 1); m.map = a; m.color.setRGB(1, 1, 1); }
      if (pair[1]) {
        var n = makeTex(pair[1], false, this._aniso());
        if (n) { m.normalMap = n; m.normalScale = new THREE.Vector2(1.25, 1.25); }
      }
    }
    m.name = 'ruins_bark';
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
    var tex = null, nrm = null;
    try {
      this._atlas = buildDecalAtlas(this.rng.fork ? this.rng.fork(0xDECA1) : this.rng);
      tex = makeTex(this._atlas, true, this._aniso(), false);
    } catch (e) { GAME.logError('ruins.atlas', e); }
    try { nrm = makeTex(buildDecalNormal(this._atlas), false, this._aniso(), false); }
    catch (e2) { GAME.logError('ruins.atlasNormal', e2); }
    var m = new THREE.MeshStandardMaterial({
      map: tex, color: 0xffffff, roughness: 0.92, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.035,
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    if (nrm) {
      m.normalMap = nrm;
      m.normalScale = new THREE.Vector2(1.15, 1.15);
    }
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
          // the same argument as the outer court's `lift`, at half the amount:
          // the west gallery's own shadow reaches 15 m into this courtyard and
          // the terrace shades the rest of the near field, but unlike the outer
          // court this floor also holds standing water and moss, so it earns
          // less headroom.
          follow: true, pitch: 1.22, jitter: 0.9, mossBias: 0.22, lift: 0.08,
          trodX: 0, trodW: 2.6,
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
        // `lift` gives the outer court's paving 0.10 of grime headroom. This
        // floor stands in the gallery's shadow at 9.6 degrees of sun and is
        // lit by sky alone, and it is the whole near field of hero2: at the
        // shared default it measured L 0.025 against a gate at 0.186. Less
        // grime is a paler, warmer stone, which is also true of a court that
        // is swept and walked on rather than of a jungle floor.
        // `lift` at 0.18. WHY THIS FLOOR CAN ONLY EVER BE AN ALBEDO PROBLEM:
        // the gallery's south wall is 5.05 m and the sun is at 9.6 degrees, so
        // its shadow reaches 29.6 m to the south-east and the outer court is
        // only 10 m deep - every square metre of it is inside that shadow at
        // the one hour this level is set at, and there is no aperture that could
        // change it (traced, the ray from a court flagstone toward the sun
        // crosses the gallery wall 79 cm above its own footing). So no amount of
        // rig work lights this floor; a swept, walked precinct simply carries
        // less biological grime than the jungle mould the shared default is
        // solved for. Honest note on the size of the effect: the grime channel
        // already runs past 1.0 on most of these vertices once the per-block and
        // erosion terms are in, and 1.0 is where the shader's grime term
        // saturates, so this is a small lift on the darkest slabs only - not the
        // reason the frame improved.
        0.16, {
          pitch: 1.26, jitter: 1.0, trodX: 0, trodW: 2.8, lift: 0.18,
          skip: [
            { x0: -21.2, x1: -12.8, z0: 8.9, z1: 14.3 },
            { x0: 12.8, x1: 21.2, z0: 8.9, z1: 14.3 }
          ]
        });
      pave(self, B, rng,
        { x0: -GOP_HALF_X + 0.6, x1: GOP_HALF_X - 0.6,
          z0: GOP_Z - GOP_HALF_Z, z1: GOP_Z + GOP_HALF_Z },
        0.30, { pitch: 1.06, jitter: 0.7, trodX: 0, trodW: 1.9 });
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
      // FOREGROUND STONE and the GATE SPOIL that carries hero2's near field are
      // now the last seven entries of P.rubble (see the note there), so the loop
      // above has already built them and props_ruins.js and buildMist can both
      // see where they are.
      // a fallen pediment slab and a broken colonnette lying in the court -
      // silhouette, not scatter, at the near edge of the hero2 cone
      B.wear = { grime: 0.64, wet: 1, edge: 0.62 };
      B.boxR('sandstone', 2.10, 0.46, 1.15, 0.60, 0.44, 9.30, 0.10, 0.62, 0.22);
      B.boxR('mossy', 0.58, 2.35, 0.58, -1.90, 0.44, 11.60, 1.42, 0.9, 0.16);
      B.boxR('sandstone', 1.35, 0.38, 0.92, 3.10, 0.36, 12.40, -0.08, 1.15, 0.14);
      B.wear = null;
      self.addCollider(0.60, 0.40, 9.30, 1.05, 0.30, 0.60, 'stone');
      // A LINTEL STANDING ON END. It used to be one 0.72 x 3.05 x 0.94 box at
      // (-9.6, -1.8); with hero1 re-solved to x -9.00 that put a single
      // untextured slab 3.1 m from the lens filling the whole left third of
      // the level's signature frame - "any surface that is flat, untextured or
      // single-colour" straight off the instant-fail list, and it cost that
      // frame five points of measured flat_area. Moved out to 7 m and broken
      // into four pieces with a shed course at its foot, so what the left of
      // the frame carries is a silhouette with joints in it rather than a
      // monolith.
      B.wear = { grime: 0.66, wet: 1, edge: 0.68 };
      B.boxR('sandstone', 0.70, 1.35, 0.92, -11.20, 0.62, -5.60, 0.06, 0.55, 0.20);
      B.boxR('sandstone', 0.66, 1.05, 0.88, -11.12, 1.80, -5.72, 0.09, 0.61, 0.26);
      B.boxR('mossy', 0.62, 0.62, 0.84, -11.06, 2.58, -5.80, 0.14, 0.49, 0.31);
      B.boxR('sandstone', 1.15, 0.42, 0.78, -10.30, 0.24, -4.85, 0.10, 1.05, 0.34);
      B.boxR('mossy', 0.62, 2.60, 0.66, 15.8, 0.42, -19.4, 1.48, 0.9, 0.12);
      B.wear = null;
      self.addCollider(-11.15, 1.30, -5.66, 0.45, 1.50, 0.55, 'stone');
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
      mistNearFade(mat);
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

    // The drip-edge list is complete once every wall and tower is built, and
    // props_ruins.js's build() does not start until this one returns, so
    // publishing it here is safe. `anchors` is the same object the constructor
    // handed out, so nothing has to re-read anything.
    try { this.anchors.cornices = this.cornices; } catch (e0) { void e0; }

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
        // mieG 0.70 -> 0.55 and desaturate 0.10 -> 0.22.
        //
        // At mieG 0.70 the Henyey-Greenstein lobe is so forward-peaked that
        // gbFogSun - the burning horizon's own hard orange - was being mixed
        // over EVERYTHING past about 20 m in a 100-degree cone around the key,
        // and the level photographed as a monochrome salmon picture: 66% of
        // hero1's saturated pixels inside one 30-degree hue bin, green at
        // 0.6%, and the shadows measuring WARM where every other level in the
        // roster has a cool anchor. Broadening the lobe puts gbFogSky - which
        // at this hour is the violet-blue zenith - back into the mix
        // everywhere except a narrow cone straight into the sun, so the moat
        // streak in hero3 keeps its fire and the courtyard stops being pink.
        // desaturate goes ABOVE sky.js's 0.18 default rather than below it,
        // because aerial perspective at dawn in mist really does eat chroma
        // and because it is the term that stops the fog PAINTING its hue onto
        // distant stone instead of veiling it.
        // MEASURED AND REVERTED. Packing the same veiling lower (density
        // 0.0210, heightScale 3.4) looked like the obvious answer to "the
        // medium is not at ankle height", and it made the courtyard DARKER,
        // not lighter: 0.0243 to 0.0220 on hero1's near floor. At dawn the
        // inscatter this level is looking INTO for four of its five framings
        // is the cool anti-solar half of the sky, so more of it near the
        // ground veils the floor toward something darker than the stone it is
        // veiling. The ground-level medium has to be the mist GEOMETRY, whose
        // colour this file controls per card, and not the fog term, whose
        // colour it does not. These numbers are the ones that measured best.
        this.ctx.sky.setFog({
          density: 0.0175, heightScale: 4.6, baseY: -0.4,
          startDistance: 1.8, mieG: 0.55, maxOpacity: 0.88, desaturate: 0.22
        });
      }
    } catch (e) { GAME.logError('ruins.fog', e); }

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _reliefCache.forEach(function (g) { g.dispose(); }); _reliefCache.clear();
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _quadCache.forEach(function (g) { g.dispose(); }); _quadCache.clear();
    _frusCache.forEach(function (g) { g.dispose(); }); _frusCache.clear();
    return this;
  };

  // Which precinct a piece belongs to, from its world origin. Merging is what
  // keeps draw calls down; merging EVERYTHING is what defeats frustum culling,
  // and the measurement that proved it was that an aerial overview of the
  // whole site and a 1 m interior rendered 680K and 750K triangles - i.e. the
  // cost was global and the camera made no difference. Six precincts is the
  // right granularity: each one is a place a player stands in and cannot see
  // most of the others from, and the split costs at most five extra draws per
  // material against a 500-call budget the level was using 276 of.
  function precinctOf(x, y, z) {
    if (Math.abs(x) > 34 || z > 60 || z < -46) return 'far';
    if (z >= 24) return 'cway';
    if (z >= 14) return 'gate';
    if (z >= 2) return 'court';
    if (z >= -22) return 'inner';
    void y;
    return 'north';
  }

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
      // Below ~220 pieces a bucket is not worth splitting - one merged mesh is
      // already tiny and six of them would be six draws for nothing.
      var groups;
      if (entries.length < 220) {
        groups = [['all', entries]];
      } else {
        var by = Object.create(null);
        for (var q = 0; q < entries.length; q++) {
          var em = entries[q].matrix.elements;
          var pk = precinctOf(em[12], em[13], em[14]);
          (by[pk] || (by[pk] = [])).push(entries[q]);
        }
        groups = [];
        var gk = Object.keys(by);
        for (var q2 = 0; q2 < gk.length; q2++) groups.push([gk[q2], by[gk[q2]]]);
      }
      for (var gi = 0; gi < groups.length; gi++) {
        var gname = groups[gi][0], gents = groups[gi][1];
        if (!gents.length) continue;
        var geo;
        try { geo = Geo.mergeAll(gents); }
        catch (e) { GAME.logError('ruins.merge:' + key, e); continue; }
        if (!surf.keepUV || !geo.attributes.uv) Geo.worldUV(geo, surf.uv);
        Geo.copyUV1(geo);
        try { this._paint(key, gents, geo); }
        catch (e2) { GAME.logError('ruins.paint:' + key, e2); }
        geo.computeBoundingSphere();
        var mesh = new THREE.Mesh(geo, this.material(key));
        mesh.name = 'ruins_' + key + (gname === 'all' ? '' : '_' + gname);
        mesh.castShadow = surf.cast;
        mesh.receiveShadow = surf.recv;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        if (key === 'decal') mesh.renderOrder = 2;
        if (key === 'water') mesh.renderOrder = 1;
        this.root.add(mesh);
        this.meshes.push(mesh);
      }
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

      // ---- PER-BLOCK VARIATION ------------------------------------------
      // The finding this answers: "every block in a course carries the
      // identical isotropic sandpaper speckle at one scale, because the grime
      // term is fbm2(x*0.31, z*0.31) - a noise field continuous across the
      // whole wall, so adjacent blocks get the same value." A CONTINUOUS field
      // cannot make two neighbouring blocks differ; only a field quantised to
      // the block can. So the block's own value is drawn here, once, from its
      // world position, and it is what every vertex of that block carries.
      //
      // Two frequencies, deliberately:
      //   blk   per-block, +/-11% of value with an anti-correlated edge-wear
      //         term - so one block is dark and dusty, its neighbour paler and
      //         chipped, which is a hue shift as well as a value shift because
      //         grime pulls toward 0x4c4338 and edge wear toward 0xb9ae9a.
      //   ero   0.045/m differential erosion, so whole PANELS of the gallery
      //         and whole tiers of the terrace sit at different values. This
      //         is the macro variation the near-field stone measured as
      //         completely lacking (0.089 at 1 px against street's 0.161).
      var bx0 = ent.matrix.elements[12], by0 = ent.matrix.elements[13],
        bz0 = ent.matrix.elements[14];
      var blk = 0, ero = 0;
      if (!own) {
        // hash the block ORIGIN quantised to the 1.6 m coursing module's
        // eighth, i.e. 20 cm - fine enough that every block is its own draw
        var q = 5.0;
        var hqa = Math.sin(Math.floor(bx0 * q) * 12.9898 +
          Math.floor(by0 * q) * 78.233 + Math.floor(bz0 * q) * 37.719) * 43758.5453;
        var hqb = Math.sin(Math.floor(bx0 * q) * 39.3468 +
          Math.floor(by0 * q) * 11.135 + Math.floor(bz0 * q) * 83.155) * 24634.6345;
        blk = (hqa - Math.floor(hqa)) - 0.5;
        var blk2 = (hqb - Math.floor(hqb)) - 0.5;
        ero = noise.fbm2(bx0 * 0.048 + 3.7, bz0 * 0.048 - 9.1, 2) * 0.9 +
          noise.fbm2(by0 * 0.16 + 21.0, (bx0 + bz0) * 0.055, 2) * 0.5;
        // AMPLITUDES RAISED. At +/-11% of value the per-block break was inside
        // the noise floor of a frame this dim: the critic measured "every
        // course in a wall the same tone, the same size, the same everything"
        // and the measurement was right even though the mechanism was already
        // here. A real coursed wall on a subsiding core runs two stops between
        // its softest and its hardest block, because the quarry did not sort
        // them and nine hundred years of rain has found the soft ones.
        g0 *= 1 + blk * 0.34 + ero * 0.30;
        e0 *= 1 - blk * 0.30 + blk2 * 0.20;
        w0 *= 1 + blk2 * 0.12;
      }

      var ft = ent.face;
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
          } else if (key === 'bark') {
            // Bark's vertex colour is a straight multiplier on an already-dark
            // map, so it stays close to 1 - the wear values that suit a
            // WEAR-shaded stone block would take a root to a silhouette. What
            // it does carry is a damp, mossy foot (a fig root is black where
            // it meets the ground) and a per-limb value break.
            var bv = 1 + noise.fbm2(x * 0.55 + 13, y * 0.30 - 4, 3) * 0.20;
            var foot = M.smoothstep(1.6, -0.2, y - this.sampleGround(x, z));
            r = bv * (1 - foot * 0.34);
            g = bv * (1 - foot * 0.28);
            b2 = bv * (1 - foot * 0.36);
          }
          col[j] = r; col[j + 1] = g; col[j + 2] = b2;
          continue;
        }

        // ---- BAKED CONCAVITY OCCLUSION on a carved face -------------------
        // See the note in carvedFace. oz is the vertex's depth in the head's
        // own frame; F is the head's front plane. Everything behind F is in a
        // cut, and how far behind it is, is how dark it gets. Applied to BOTH
        // grime (darkens ~0.7x and pulls toward the dust colour) and wet
        // (darkens up to 0.48x), which together give the 2-3x drop that makes
        // an eye socket read as a socket under nothing but skylight.
        if (ft) {
          var ox = (x - ft.x) * ft.c - (z - ft.z) * ft.s;
          var oz = (x - ft.x) * ft.s + (z - ft.z) * ft.c;
          var oy2 = y - ft.y;
          // ft.F is the CHEEK PLANE (1.00 dp) now that the head is a height
          // field, not the old solid mass's front at 1.30 dp: everything at or
          // in front of the cheek is undarkened and every cut is measured back
          // from it. A socket floor at 0.40 dp returns deep 0.57, the skirt in
          // the pediment saturates at 1.0, the nose at 1.62 dp returns 0.
          var deep = M.saturate((ft.F - oz) / Math.max(0.05, ft.dp * 1.05));
          // the outer margin of the head is against the pediment and gets the
          // corner occlusion of an applied mass, the centre does not
          var lat = M.smoothstep(0.38, 0.54, Math.abs(ox) / Math.max(0.05, ft.w));
          var vert = M.smoothstep(0.10, -0.02, oy2 / Math.max(0.05, ft.h));
          var ao = M.saturate(deep * 1.15 + lat * 0.30 + vert * 0.35);
          // GATED ON THE BUCKET, because the two mechanisms stack. The deep
          // triangles of the shell are already in 'carve', whose albedo target
          // (0x39332a) measures 0.037 linear against sandstone's 0.245 - a
          // 6.6:1 head start. Handing them the full grime pull as well took an
          // eye socket to black, and no pure black is on the render rules.
          var aoK = key === 'carve' ? 0.34 : 0.78;
          r = g0 * (1 - ao * aoK);
          g = w0 * (1 - ao * 0.42);
          b2 = e0 * (1 - ao * 0.30);
        }

        // ---- grime: water runs DOWN, and it collects where it stops --------
        var gy = this.sampleGround(x, z);
        var hgt = y - gy;
        var streak = noise.fbm2(x * 1.35 + 11.0, y * 0.24 - 4.0, 3) * 0.5 + 0.5;
        var down = M.saturate(-ny * 0.5 + 0.5);         // 1 on an underside
        r *= 1 - streak * 0.16 * (1 - Math.abs(ny)) - down * 0.14;
        // THE DIRTY FOOT IS SPLASH-BACK AND IT BELONGS ON A VERTICAL FACE.
        //
        // This term used to run on every surface within 1.5 m of the ground,
        // and because sampleGround resolves BUILT PLATFORMS analytically,
        // "within 1.5 m of the ground" is true for the whole top surface of
        // every paved floor in the level at every height: the 32 m causeway
        // deck, the outer court, the courtyard, the gallery corridor and all
        // three terrace tops. So the one thing the level walks on was being
        // darkened 18% for being near a ground it IS. That is why the causeway
        // measured half the luminance of the gate it leads to, and it is also
        // why hero1's foreground measured less gradient energy than towers
        // 36 m behind it - gradient scales with luminance, so a dark surface
        // reads as flat cardboard whatever its material is doing.
        //
        // Rain splash throws about 40 cm and it fouls the WALL it hits. The
        // top of a tread is polished by feet, not fouled by them, so the
        // up-facing component keeps only a fifth of the term.
        var upF = M.saturate(ny);
        r *= 1 - M.smoothstep(1.5, 0.0, hgt) * 0.18 * (1 - upF * 0.80);
        // NOT fbm2(x*0.31, z*0.31): that is a 3 m field, continuous across a
        // whole wall, so it gave every block in a course the same value and is
        // exactly what made the near-field stone measure flatter than the
        // empty sky. The block's own value is carried by `blk`/`ero` above;
        // what is left here is a genuinely per-VERTEX micro break at 1.4 m,
        // which is smaller than a block and therefore cannot average out.
        r *= 1 + noise.fbm2(x * 0.72 + 4.0, (y * 0.5 + z * 0.72) + 9, 2) * 0.09;

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
        // GATED ON THE NORMAL, for the same reason the wet band above is, and
        // it is the same class of bug found from the other end.
        //
        // materials.js's B channel exposes PALE FRESH SUBSTRATE (0xb9ae9a).
        // On the vertical arris of a wall block that is exactly right: a
        // spalled corner really is paler than the weathered face beside it, and
        // it is what makes nine hundred years of coursing catch a light.
        // Applied to an UP-facing arris it is a lie with a measurable cost.
        // Every paved floor in this level is 1300 individually laid slabs, each
        // one proud of its neighbours by 2-3 cm, so the whole floor is arris;
        // and the outer court - which is the entire near half of the hero2
        // framing - stands in the gallery's shadow at a 9.6-degree sun and is
        // lit by SKY ALONE. Measured on that frame: the slab faces came back at
        // L 0.157 with B > R (0.144 / 0.158 / 0.177, cold, because the only
        // illuminant is the zenith) while their arrises measured L 0.441 and
        // near-neutral. A 2.8:1 rim-to-face ratio on a horizontal surface is
        // not weathering; it is a floor of dark glass tiles with the joints
        // glowing, which is what the frame photographed as.
        //
        // A trodden flagstone is POLISHED by feet, not spalled by them. So the
        // term keeps roughly half its strength on a fully up-facing edge and all
        // of it on a vertical one - the same shape of gate, and the same
        // reasoning, as the splash-back term thirty lines above.
        //
        // HALF, NOT A FIFTH, and the difference was measured. At 0.80 of
        // suppression the outer court went from a floor of glass tiles with
        // glowing joints to a floor with no joints at all: the near field
        // measured L 0.156 with its darkest 40% at 0.088, i.e. it traded one
        // instant-fail ("perfectly uniform anything") for the other ("an unlit
        // ground plane"). The arris was carrying the floor's whole read. At 0.55
        // the near field measures RGB 0.180 / 0.158 / 0.150 - WARM, where before
        // the change it measured 0.227 / 0.225 / 0.240, i.e. blue-dominant,
        // because a pale neutral substrate under a violet zenith is the only
        // thing that was lighting it.
        if (doEdges) {
          _pv.set(x, y, z).applyMatrix4(_pinv);
          var ex = Math.abs(_pv.x) / hx, ey = Math.abs(_pv.y) / hy, ez = Math.abs(_pv.z) / hz;
          var eT = ent.relief ? 0.78 : 0.88;
          var nEdge = (ex > eT ? 1 : 0) + (ey > eT ? 1 : 0) + (ez > eT ? 1 : 0);
          if (nEdge >= 2) {
            var chip = M.saturate(noise.fbm2(x * 2.3 + 17, z * 2.3 - 5, 2) * 1.6 + 0.35);
            b2 *= 1 - chip * 0.42 * (1 - upF * upF * 0.55);
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
        // 96 -> 52 and the halo pulled right in. At the old numbers this
        // 4300 K spot threw a discrete pale-blue CONE that read across a
        // quarter of the courtyard: in hero1 it stood as a vertical plume of
        // light in mid-air at 25 m with no visible cause, which is the exact
        // "rendering fault rather than light" failure the west breach was
        // deliberately left unpublished to avoid. At 52 it still pools on the
        // trench, still reads as the level's one cool source, and stops
        // being an object in every other framing.
        name: 'dig_worklight', kind: 'tungsten', pos: w.slice(),
        kelvin: 4300, intensity: 52, distance: 15, dayBase: 0.92,
        cone: 0.52, penumbra: 0.62,
        aimPos: [(tr.x0 + tr.x1) * 0.5, 0.05, (tr.z0 + tr.z1) * 0.5],
        haloScale: 0.7, haloMax: 1.25, haloGain: 0.28,
        bulbR: 0.09, bulbFlat: 0.45, fixed: 1
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
    // RE-SOLVED AGAIN, and this time against the LIGHT rather than against the
    // composition alone. At (-1.85, 1.20) aimed at x +0.25 the camera was
    // 1.85 m west of the axis looking 10 degrees EAST of north: the two sheets
    // of standing water the comment above claims flank the flight were both
    // outside the 53.75-degree half-cone (the near one measured 61 degrees
    // off-axis), the looters' camp was 70 degrees off it, and the corner
    // prasats were seen close to square-on so neither of their lit WEST faces
    // opened up. Moving 1.5 m further west and aiming 8 degrees further east
    // costs nothing on the stair - which stays 7 degrees off centre - and buys
    // all three: court_west enters bottom-left at 5 m, court_east enters right
    // at 9-11 m, the brazier lands 31 degrees right, and the south-east
    // prasat's west face - which the north-west key rakes at 58 degrees - is
    // now seen at 50 degrees from its own normal instead of nearly square.
    // RE-SOLVED A THIRD TIME, AND THIS TIME AGAINST THE ELEVATION THE KEY
    // ACTUALLY TOUCHES.
    //
    // The finding: "hero1's three prasats are the level's signature subject and
    // they are photographed on their unlit elevation - a measured 1.6:1
    // lit-face to shadow-face ratio, so 45 cm of relief has almost no shading
    // gradient to describe it." Correct, and the plan geometry says why. The
    // sun bears 31.6 degrees west of north, so of a tower's four faces only
    // the WEST and the NORTH take the key; from anywhere in the courtyard the
    // north face is behind the tower, which leaves the west face as the only
    // lit surface a courtyard camera can reach at all. At x -3.30 the camera
    // was 3.3 m west of a tower 20 m away: the west face presented 0.161 of
    // projected area against the shadowed south face's 0.987, i.e. the frame
    // was 86% shadow side.
    //
    // Moving to x -9.00 takes the west face to 0.406 - two and a half times
    // the lit area - and it costs nothing else, because the three things this
    // framing exists to photograph all survive the move:
    //   * the great stair still runs diagonally out of the lower right,
    //     head at 0.1 degrees off the frame centre;
    //   * both guardian lions are still in shot at 7 and 13 m;
    //   * the west sheet of standing water now enters the near foreground at
    //     4.8 m instead of sitting 61 degrees off the axis, and the fallen
    //     blocks at (-8.4, -3.2) land 4.5 m dead ahead as hard foreground.
    // The three towers stay separated - the south-west at 25 degrees left, the
    // central at 8 left, the south-east at 20 right - because the camera is
    // still south-east of the SW/central axis rather than on it.
    var h1x = -8.60, h1z = 0.20;
    g = this.sampleGround(h1x, h1z);
    // 12 degrees of pitch, not 16: at 16 the bottom of the frame was 4.3 m
    // out and the two guardian lions at the foot of the stair - the only hard
    // foreground the framing has - sat just under the edge. At 12 they anchor
    // the bottom corners, the sheet of standing water comes in on the left,
    // and the tower apex still clears the top of a 75-degree frame by 3.
    // Aimed at the central prasat itself rather than between it and the stair.
    // The first solve at this standpoint put the tower cluster 8 degrees left
    // of centre and gave the whole right third of the frame to sky, which
    // measured as flat_area 35.4% against the previous mark's 25.1% - a real
    // regression, and one the eye agrees with. On the tower the cluster runs
    // from 21 degrees left to 27 right, the stair still enters from the lower
    // right at 40 degrees, and the sky is a band above the towers rather than
    // a quarter of the picture.
    var hero1 = pose(h1x, g + 1.66, h1z, 0.00, 5.10, -16.60);

    // ---- HERO2 : THE OUTER COURT --------------------------------------------
    //
    // THIS MARK HAS BEEN MOVED, AND IT IS A TRADE MADE ON PURPOSE.
    //
    // Two rounds running, the outer court - both library annexes, the laterite
    // enclosure wall and the whole gate precinct - appeared in NO published
    // frame. Round one's remedy was to author a sixth pose, hero4, and wire it
    // into scenarios.js; but GENERIC in tools/shoot.py lists five standard
    // keys and hero4 is not one of them, so nothing ever rendered it and the
    // gap stayed open. The roster's instant-fail list names "a level that
    // photographs well in one pose and is empty everywhere else", and a
    // coverage claim cannot rest on a pose the tooling never runs.
    //
    // Of the five keys that DO ship, hero2 was the weakest by a distance: it
    // gave 17% of its area to featureless sky in the top-right, put the fig
    // half out of frame in the top-left corner and rested its crosshair on
    // blank stone. So hero2 is the one that moves. The Ta Prohm fig is still
    // built, still pulling the east gallery apart, and still in the overview -
    // but it is no longer a published close framing, and that is the price of
    // photographing the third of the level that was never photographed at all.
    //
    // THE STANDPOINT IS SOLVED, not chosen. Two constraints fix it:
    //
    //  (1) LIGHT. The key bears north-west, so only NORTH and WEST elevations
    //      take it. Everything worth photographing in the outer court - the
    //      gopura's cruciform mass, both wings, the enclosure's south run - is
    //      SOUTH of a camera standing in the court, which means the camera is
    //      looking at north elevations, the best-lit surfaces in the level
    //      (0.852 of the key against the south faces' zero).
    //  (2) GEOMETRY. The west library occupies x -19.4..-14.6 over z 8.0..15.2,
    //      which is nearly the full depth of a court only 10 m deep: every
    //      east-west sightline from the west end of the court runs straight
    //      through it, which is why the obvious "look along the court" mark
    //      photographs a library and nothing else. From (5.0, 6.6) the library
    //      is 23 m away on one side of the axis and the gate tower 14 m away
    //      on the other, 28.4 degrees off centre each - and neither occludes
    //      the other because they are 57 degrees apart in plan.
    //
    // What that lands, in depth order: fallen gate masonry at 3-8 m, the west
    // gopura wing and its roof prasat filling the centre at 20 m, the face
    // tower's LIT north-west corner at 14 m, the west library at 23 m, the
    // enclosure's south run at 28 m, its west return at 36 m, and the jungle
    // beyond. Six depths, the subject 28 degrees off the frame's centre rather
    // than on it, and no quadrant carrying nothing.
    var h2x = 5.00, h2z = 6.60;
    var h2g = this.sampleGround(h2x, h2z);
    var hero2 = pose(h2x, h2g + 1.66, h2z, -9.50, 5.00, 19.20);

    // ---- HERO3 : the causeway and the gate, OFF THE CENTRELINE ---------------
    // The arrival. Standing on the causeway deck with the naga balustrade
    // running away on both sides into the mist over the moat, the gate tower
    // and its four faces closing the vista at 18 m. The one framing in the set
    // with a low horizon and a large sky, which is what makes the other four
    // read as enclosed.
    // PITCH SOLVED, NOT GUESSED. Aimed at the gate tower's own face the
    // pitch came out at 23 degrees, which put the bottom of the frame 10 m
    // in front of the camera - i.e. the causeway deck and both naga
    // balustrades, the entire leading line the framing exists for, were
    // below the picture. Aiming at the lintel instead drops it to 6 and the
    // deck runs from the bottom edge to the gate, with the flooded moat in
    // both lower corners; the tower apex still clears the top by 17 degrees.
    //
    // OFF THE CENTRELINE. At (-1.05, 41) this was the third of three published
    // framings standing within 2 m of x = 0 and looking due north down the
    // same axis - the same symmetric one-point photograph three times, all of
    // them onto SOUTH elevations the key never touches. Standing hard against
    // the WEST balustrade and aiming across to the east side of the gate makes
    // the naga run DIAGONALLY out of the bottom-left corner instead of framing
    // the subject symmetrically, and it swings the sun (31.6 degrees west of
    // north) round to 49 degrees off the view axis - which puts its specular
    // streak on the west moat at about 19 m, on the left third rather than
    // dead centre. The 200 x 100 px of low sun on water that is the best
    // passage in the level is now a compositional element instead of an
    // accident.
    // Aimed slightly EAST of the gate axis from a standpoint on the WEST side
    // of the deck, which is the one arrangement that puts a LIT balustrade in
    // the frame: the key is north-west, so both runs show the camera their
    // inner face and only the EAST run's inner face takes the sun. Aiming at
    // x +1.75 from x -2.90 swings the lit east naga in from the bottom-right
    // as the leading line and leaves the unlit west run as a dark diagonal in
    // the bottom-left corner. The first attempt aimed the other way and filled
    // three metres of foreground with the unlit run seen from above.
    var h3z = 46.0, h3x = -2.90;
    var hero3 = pose(h3x, CW_Y + 1.66, h3z, 1.75, 4.05, GOP_Z + GOP_HALF_Z);

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
    // Pitched 2.6 degrees further DOWN than round two. Two findings meet here.
    // The frame gave 45% of its area to empty sky above a temple whose highest
    // point subtends only 7 degrees from a standpoint 12.5 m up and 58 m out;
    // and a row of bark limbs belonging to the knoll fig was clipping the
    // top-right corner with clear sky beneath it, which reads as floating
    // geometry in the level's own establishing shot. The tree has been moved
    // clear of the cone (see plan.trees) and the aim dropped so the frame is
    // paying for stone rather than for sky.
    var overview = pose(ovx, ovy, ovz, 2.0, 2.8, -17.0);

    // ---- HERO4 : the gate tower's LIT corner, from the outer court ----------
    //
    // Two separate findings collapse into this one mark, and both of them were
    // right.
    //
    // (1) THE FACES WERE ON THE WRONG SIDE OF THE LIGHT. The old hero4 stood
    //     at (0, 32) on the causeway looking due north at the gopura's SOUTH
    //     elevation from 9 m. SUN_X/SUN_Z put the key at azimuth north-WEST,
    //     so a south elevation is lit by sky alone: the entire head measured
    //     0.083-0.207 with the brow, socket and mouth steps a few percent
    //     apart, and it took a 6x zoom to confirm a face was there. Standing
    //     in the outer court, NORTH of the gate, the camera photographs the
    //     tower's north face - which the north-west key hits at 32 degrees,
    //     the most directly lit of its four - plus a raking sliver of the west
    //     face, and the unlit south elevation is nowhere in the frame.
    //
    //     The standpoint is solved, not chosen. A true west 3/4 is
    //     ARCHITECTURALLY IMPOSSIBLE here and the geometry says so: the west
    //     wing spans x -9.2..-2.2 at the same z as the passage tower and
    //     carries its own 11.5 m prasat, so every sightline from the west
    //     crosses it - the first attempt at (-11.0, 10.5) photographed the
    //     wing, not the face. The line from (-5.8, 6.6) to the tower crosses
    //     the wing's z band at x -1.7 and 6.9 m up: clear of the wing mass in
    //     plan AND over its 5.6 m roof.
    //
    // (2) THE OUTER COURT WAS NEVER PHOTOGRAPHED. Both libraries, the
    //     enclosure wall and the whole outer precinct are built, collided and
    //     navmeshed, and appeared in no published framing at all - the
    //     roster's own instant-fail. This standpoint stacks outer-court paving
    //     and a spill of gate masonry at 5-9 m, the two gopura wings at 11 m,
    //     the face tower at 12, the RUINED east library at 23 m on the left
    //     edge and the enclosure's east return at 36 - four depths, and the
    //     subject 5 degrees off the frame's centre rather than on it.
    var h4x = -4.80, h4z = 8.40;
    var hero4 = pose(h4x, this.sampleGround(h4x, h4z) + 1.66, h4z,
      -0.30, 4.80, 17.20);

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
