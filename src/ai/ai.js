// ============================================================================
// OPERATION BLACKOUT - enemy AI + procedural character animation
// Owns: src/ai/ai.js  ->  GAME.AISystem
//
// Contents
//   1. bone rig definition, hitbox table
//   2. procedural geometry helpers (lathe limbs, blobs, bevelled boxes)
//   3. CharBuilder - assembles a skinned humanoid + carbine into ONE geometry
//   4. the character shader (vertex colour + per-vertex roughness/metalness +
//      procedural micro-normal) so a whole militiaman is 1 draw call
//   5. PathFinder (A* over level.navGrid) and CoverSystem
//   6. Ragdoll (verlet particles + distance constraints)
//   7. Enemy - pose generation, IK, state machine, combat
//   8. AISystem - squad coordination, time-slicing, spawning
//
// Everything here is generated in code; there are no assets and no addons.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var V3 = THREE.Vector3;

  // Module scratch. Allocating inside update() causes GC hitches that read as
  // stutter, so every per-frame vector/quaternion comes from here.
  var _v0 = new V3(), _v1 = new V3(), _v2 = new V3(), _v3 = new V3();
  var _v4 = new V3(), _v5 = new V3(), _v6 = new V3(), _v7 = new V3();
  var _v8 = new V3(), _v9 = new V3(), _va = new V3(), _vb = new V3();
  var _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion();
  var _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
  var _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4();
  var _col = new THREE.Color();
  var _box = {
    type: 'box', center: new V3(), halfExtents: new V3(),
    quaternion: new THREE.Quaternion()
  };
  var _rayHit = { point: new V3(), normal: new V3() };
  var UPY = new V3(0, 1, 0);

  function v(x, y, z) { return new V3(x, y, z); }

  // --------------------------------------------------------------------------
  // 1. RIG
  //
  // Real proportions for a 1.8 m adult male (anthropometric 50th percentile):
  // hip joint 0.93, shoulder 1.42, chin 1.57, crown 1.80. Getting these ratios
  // wrong is the single most obvious "amateur character" tell, more than any
  // amount of polygon detail.
  //
  // The character's local +Z is FORWARD (so yaw = atan2(dir.x, dir.z)) and
  // every bone has an identity rest rotation, which means an animation channel
  // is just a rotation about that bone's own axis-aligned frame.
  // --------------------------------------------------------------------------
  var BONES = [
    // name      parent   bind x     y      z
    ['hips',      -1,    0.000,  0.980,  0.000],
    ['spine',      0,    0.000,  1.115, -0.006],
    ['chest',      1,    0.000,  1.265,  0.000],
    ['neck',       2,    0.000,  1.495, -0.014],
    ['head',       3,    0.000,  1.575,  0.006],
    ['clavL',      2,    0.040,  1.440,  0.010],
    ['armL',       5,    0.178,  1.424, -0.006],
    ['foreL',      6,    0.222,  1.140,  0.014],
    ['handL',      7,    0.250,  0.884,  0.030],
    ['clavR',      2,   -0.040,  1.440,  0.010],
    ['armR',       9,   -0.178,  1.424, -0.006],
    ['foreR',     10,   -0.222,  1.140,  0.014],
    ['handR',     11,   -0.250,  0.884,  0.030],
    ['upLegL',     0,    0.098,  0.930,  0.000],
    ['loLegL',    13,    0.102,  0.500,  0.014],
    ['footL',     14,    0.104,  0.086, -0.014],
    ['toeL',      15,    0.104,  0.030,  0.112],
    ['upLegR',     0,   -0.098,  0.930,  0.000],
    ['loLegR',    17,   -0.102,  0.500,  0.014],
    ['footR',     18,   -0.104,  0.086, -0.014],
    ['toeR',      19,   -0.104,  0.030,  0.112]
  ];
  var BI = {};                       // name -> index
  var BIND = [];                     // bind world position
  var BLOCAL = [];                   // bind position relative to parent
  (function () {
    var i;
    for (i = 0; i < BONES.length; i++) {
      BI[BONES[i][0]] = i;
      BIND.push(v(BONES[i][2], BONES[i][3], BONES[i][4]));
    }
    for (i = 0; i < BONES.length; i++) {
      var p = BONES[i][1];
      BLOCAL.push(p < 0 ? BIND[i].clone() : BIND[i].clone().sub(BIND[p]));
    }
  })();

  // Skinning influence segments. A vertex is weighted by its distance to these
  // capsule axes, so the deformation follows the anatomy rather than a naive
  // nearest-joint assignment (which tears at the shoulders and hips).
  var SEG = [];
  (function () {
    var i, p, tail, kids = [];
    for (i = 0; i < BONES.length; i++) kids.push([]);
    for (i = 0; i < BONES.length; i++) { p = BONES[i][1]; if (p >= 0) kids[p].push(i); }
    for (i = 0; i < BONES.length; i++) {
      if (kids[i].length) {
        tail = new V3();
        for (var k = 0; k < kids[i].length; k++) tail.add(BIND[kids[i][k]]);
        tail.multiplyScalar(1 / kids[i].length);
      } else {
        // leaf: extrapolate along the parent->bone direction
        p = BONES[i][1];
        tail = BIND[i].clone().sub(BIND[p]).setLength(0.10).add(BIND[i]);
      }
      SEG.push({ a: BIND[i].clone(), b: tail });
    }
    function set(name, ax, ay, az, bx, by, bz) {
      var s = SEG[BI[name]];
      s.a.set(ax, ay, az); s.b.set(bx, by, bz);
    }
    // torso segments must span their flesh, not just joint-to-joint
    set('hips', 0, 0.885, 0, 0, 1.045, 0);
    set('spine', 0, 1.045, 0, 0, 1.200, 0);
    set('chest', 0, 1.200, 0, 0, 1.470, 0);
    set('neck', 0, 1.448, -0.01, 0, 1.556, 0);
    set('head', 0, 1.562, 0, 0, 1.774, 0.008);
    set('clavL', 0.030, 1.440, 0.01, 0.168, 1.428, 0);
    set('clavR', -0.030, 1.440, 0.01, -0.168, 1.428, 0);
    set('handL', 0.250, 0.884, 0.03, 0.258, 0.752, 0.058);
    set('handR', -0.250, 0.884, 0.03, -0.258, 0.752, 0.058);
    set('toeL', 0.104, 0.030, 0.112, 0.104, 0.026, 0.195);
    set('toeR', -0.104, 0.030, 0.112, -0.104, 0.026, 0.195);
  })();

  // Hitboxes, in the local frame of their bone. mult is the damage multiplier -
  // a head shot at 4.6x makes any primary weapon lethal in one round.
  var HITBOX_DEF = [
    ['head', 'head', 0.000, 0.085, 0.012, 0.088, 0.122, 0.104, 4.6],
    ['neck', 'neck', 0.000, 0.048, 0.000, 0.056, 0.052, 0.058, 2.2],
    ['chest', 'chest', 0.000, 0.112, 0.005, 0.190, 0.140, 0.118, 1.00],
    ['stomach', 'spine', 0.000, 0.055, 0.000, 0.160, 0.096, 0.108, 1.15],
    ['pelvis', 'hips', 0.000, -0.020, 0.000, 0.150, 0.098, 0.110, 1.00],
    ['armL', 'armL', 0.020, -0.140, 0.005, 0.062, 0.160, 0.062, 0.75],
    ['forearmL', 'foreL', 0.012, -0.128, 0.012, 0.054, 0.150, 0.054, 0.62],
    ['armR', 'armR', -0.020, -0.140, 0.005, 0.062, 0.160, 0.062, 0.75],
    ['forearmR', 'foreR', -0.012, -0.128, 0.012, 0.054, 0.150, 0.054, 0.62],
    ['thighL', 'upLegL', 0.000, -0.210, 0.005, 0.088, 0.225, 0.092, 0.85],
    ['shinL', 'loLegL', 0.000, -0.200, 0.010, 0.070, 0.210, 0.078, 0.70],
    ['footL', 'footL', 0.000, -0.042, 0.062, 0.058, 0.048, 0.140, 0.45],
    ['thighR', 'upLegR', 0.000, -0.210, 0.005, 0.088, 0.225, 0.092, 0.85],
    ['shinR', 'loLegR', 0.000, -0.200, 0.010, 0.070, 0.210, 0.078, 0.70],
    ['footR', 'footR', 0.000, -0.042, 0.062, 0.058, 0.048, 0.140, 0.45]
  ];

  // Surface kinds understood by the character shader.
  // RUBBER is an alias for LEATHER: the shader's pebbled-leather micro-normal
  // is exactly what a moulded lug sole wants, and adding a seventh branch to a
  // per-pixel if-chain for no visual gain is not worth the instruction count.
  var K = { CLOTH: 0, LEATHER: 1, RUBBER: 1, SKIN: 2, METAL: 3, WEBBING: 4, HAIR: 5 };

  // Weapon reference points, expressed in the RIGHT HAND bone's local space.
  // The carbine is skinned rigidly to that bone, so controlling the hand's
  // world transform aims the rifle exactly - and the muzzle flash then comes
  // from the real barrel instead of a guessed offset.
  var W_MUZZLE = v(0, 0.062, 0.560);
  var W_SIGHT = v(0, 0.124, 0.142);
  var W_BUTT = v(0, 0.048, -0.250);
  var W_RECEIVER = v(0, 0.062, 0.110);
  // Support-hand target, expressed as the position the LEFT HAND BONE must
  // reach (the bone sits ~44 mm above the middle of whatever it is gripping).
  // It was 300 mm down the rail, then 262 - both past the reach of a 546 mm
  // arm in a shouldered pose, so the elbow locked out dead straight and the
  // hand still fell short. Both arms then rendered level and extended: the
  // "sleepwalker T" the critics measured across the whole squad. At 220 mm the
  // support arm closes on the rail with the elbow still bent in every pose,
  // which is what puts the support elbow BELOW the shoulder line.
  var W_FOREGRIP = v(0, 0.056, 0.220);

  // --------------------------------------------------------------------------
  // 2. GEOMETRY HELPERS
  // --------------------------------------------------------------------------

  // Orthonormal frame with +Y along (b-a) and +Z as close to `ref` as possible.
  // Quaternion.setFromUnitVectors() is unusable here: for a limb pointing
  // straight down it picks an arbitrary roll, which mirrors the elliptical
  // cross-section of anything squashed.
  function orient(a, b, sx, sz, out) {
    _v0.copy(b).sub(a);
    var len = _v0.length() || 1e-5;
    _v1.copy(_v0).divideScalar(len);                 // Y
    _v2.set(0, 0, 1);
    if (Math.abs(_v1.z) > 0.94) _v2.set(0, 1, 0);
    _v3.crossVectors(_v1, _v2).normalize();          // X = Y x Zref
    _v2.crossVectors(_v3, _v1).normalize();          // Z = X x Y
    _v3.multiplyScalar(sx); _v2.multiplyScalar(sz);
    out.makeBasis(_v3, _v1, _v2);
    out.setPosition(a);
    return len;
  }

  // Radius profile sampler: ctrl is [[t,r], ...] sorted by t over 0..1.
  function ctrlRadius(ctrl, t) {
    if (t <= ctrl[0][0]) return ctrl[0][1];
    for (var i = 1; i < ctrl.length; i++) {
      if (t <= ctrl[i][0]) {
        var t0 = ctrl[i - 1][0], t1 = ctrl[i][0];
        var f = (t - t0) / Math.max(1e-5, t1 - t0);
        f = f * f * (3 - 2 * f);                      // smooth so limbs bulge
        return M.lerp(ctrl[i - 1][1], ctrl[i][1], f);
      }
    }
    return ctrl[ctrl.length - 1][1];
  }

  // A tapered, capped limb built as a surface of revolution. LatheGeometry is
  // core three.js, gives correct normals and UVs, and lets the silhouette carry
  // the deltoid/calf bulge that makes a limb read as a limb.
  function limbGeo(a, b, ctrl, o) {
    o = o || {};
    var radial = o.radial || 9;
    var rings = o.rings || 7;
    var cap0 = o.cap0 === undefined ? 0.85 : o.cap0;   // rounded bottom cap
    var cap1 = o.cap1 === undefined ? 0.85 : o.cap1;   // rounded top cap
    var len = _v0.copy(b).sub(a).length() || 1e-4;
    var pts = [], i, t, r, y;

    var r0 = ctrlRadius(ctrl, 0), r1 = ctrlRadius(ctrl, 1);
    if (cap0 > 0.001) {
      var h0 = r0 * cap0, n0 = 3;
      for (i = 0; i < n0; i++) {
        var ph = (i / n0) * Math.PI * 0.5;
        pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.sin(ph)), -h0 * Math.cos(ph)));
      }
    }
    for (i = 0; i <= rings; i++) {
      t = i / rings;
      r = ctrlRadius(ctrl, t);
      y = t * len;
      pts.push(new THREE.Vector2(Math.max(1e-4, r), y));
    }
    if (cap1 > 0.001) {
      var h1 = r1 * cap1, n1 = 3;
      for (i = 1; i <= n1; i++) {
        var ph1 = (i / n1) * Math.PI * 0.5;
        pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(ph1)), len + h1 * Math.sin(ph1)));
      }
    }
    var g = new THREE.LatheGeometry(pts, radial);
    orient(a, b, o.sx === undefined ? 1 : o.sx, o.sz === undefined ? 1 : o.sz, _m0);
    g.applyMatrix4(_m0);
    return g;
  }

  // Squashed sphere - skulls, deltoids, knee pads, trapezius mass.
  function blobGeo(c, rx, ry, rz, o) {
    o = o || {};
    var g = new THREE.SphereGeometry(1, o.radial || 10, o.rings || 7);
    _m0.makeScale(rx, ry, rz);
    if (o.euler) {
      _m1.makeRotationFromEuler(o.euler);
      _m0.premultiply(_m1);
    }
    _m0.setPosition(c.x, c.y, c.z);
    g.applyMatrix4(_m0);
    return g;
  }

  // Bevelled box - pouches, plates, boots, receiver. Sharp 90 degree edges
  // never catch a highlight, which is why cheap 3D reads as plastic.
  function boxGeo(c, w, h, d, o) {
    o = o || {};
    var g = GAME.Geo.bevelBox(w, h, d, o.bevel === undefined ? 0.008 : o.bevel, o.seg || 1);
    if (o.euler) g.applyMatrix4(_m0.makeRotationFromEuler(o.euler));
    g.applyMatrix4(_m0.makeTranslation(c.x, c.y, c.z));
    return g;
  }

  // Open band - belts, cuffs, the wrap of a shemagh.
  function bandGeo(cy, radius, height, o) {
    o = o || {};
    var t = o.thick === undefined ? 0.012 : o.thick;
    var pts = [
      new THREE.Vector2(radius, -height * 0.5),
      new THREE.Vector2(radius + t, -height * 0.34),
      new THREE.Vector2(radius + t * 1.2, 0),
      new THREE.Vector2(radius + t, height * 0.34),
      new THREE.Vector2(radius, height * 0.5)
    ];
    var g = new THREE.LatheGeometry(pts, o.radial || 14);
    _m0.makeScale(o.sx === undefined ? 1 : o.sx, 1, o.sz === undefined ? 1 : o.sz);
    _m0.setPosition(o.cx || 0, cy, o.cz || 0);
    g.applyMatrix4(_m0);
    return g;
  }

  // Squared tube (handguard, stock) - cylinder with few sides reads as a
  // machined part rather than a smooth rod.
  function tubeGeo(a, b, r, sides, o) {
    o = o || {};
    var len = _v0.copy(b).sub(a).length() || 1e-4;
    var g = new THREE.CylinderGeometry(r * (o.rTop || 1), r, len, sides, 1, !!o.open);
    g.translate(0, len * 0.5, 0);
    orient(a, b, o.sx === undefined ? 1 : o.sx, o.sz === undefined ? 1 : o.sz, _m0);
    g.applyMatrix4(_m0);
    return g;
  }

  // --------------------------------------------------------------------------
  // 3. CHARACTER BUILDER
  //
  // Every piece of the militiaman - body, webbing, headwear and carbine - is
  // accumulated here and merged into ONE geometry with per-vertex colour and
  // per-vertex surface parameters. That is what buys us a fully dressed,
  // multi-material-looking character for a single draw call.
  // --------------------------------------------------------------------------
  function CharBuilder(rng) {
    this.rng = rng;
    this.parts = [];
    this._xf = null;                  // pending transform, see xform()
  }

  // opts: {bones:[names], color:hex|fn, r:roughness, m:metalness, k:kind,
  //        dust:0..1, ao:0..1, value:scalar}
  CharBuilder.prototype.add = function (geo, opts) {
    if (!geo) return;
    if (this._xf) geo.applyMatrix4(this._xf);
    this.parts.push({ geometry: geo, o: opts || {} });
  };

  // Apply a rotation about a pivot to everything added until it is cleared.
  // Used to sit a hat on the head at an angle - four men in four identically
  // level hats is the thing that makes a squad read as clones.
  CharBuilder.prototype.xform = function (euler, pivot) {
    if (!euler) { this._xf = null; return; }
    var m = new THREE.Matrix4().makeRotationFromEuler(euler);
    if (pivot) {
      m.premultiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
      m.multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    }
    this._xf = m;
  };
  CharBuilder.prototype.limb = function (a, b, ctrl, o) { this.add(limbGeo(a, b, ctrl, o), o); };
  CharBuilder.prototype.blob = function (c, rx, ry, rz, o) { this.add(blobGeo(c, rx, ry, rz, o), o); };
  CharBuilder.prototype.box = function (c, w, h, d, o) { this.add(boxGeo(c, w, h, d, o), o); };
  CharBuilder.prototype.band = function (cy, r, h, o) { this.add(bandGeo(cy, r, h, o), o); };
  CharBuilder.prototype.tube = function (a, b, r, s, o) { this.add(tubeGeo(a, b, r, s, o), o); };

  // Squared distance from p to the segment ab.
  function distSeg(px, py, pz, s) {
    var ax = s.a.x, ay = s.a.y, az = s.a.z;
    var bx = s.b.x - ax, by = s.b.y - ay, bz = s.b.z - az;
    var d2 = bx * bx + by * by + bz * bz;
    var t = d2 > 1e-9 ? ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / d2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var dx = px - (ax + bx * t), dy = py - (ay + by * t), dz = pz - (az + bz * t);
    return dx * dx + dy * dy + dz * dz;
  }

  // ------------------------------------------------------------ AO BAKE -----
  // Round 1 approximated ambient obscurance with a hand-written list of capsule
  // "occluders". By construction such a list cannot see anything that is not in
  // it - so the chest rig, authored as eighteen separate boxes, pouches, straps
  // and buckles, was completely invisible to the term and rendered as one flat
  // moulded apron. Adding more capsules by hand is the tuning pass that already
  // failed; this replaces it with a real bake.
  //
  // The merged body is splatted into a 14 mm occupancy volume and every vertex
  // ray-marches that volume through a five-ray cone around its own normal. A
  // magazine pouch standing 48 mm proud of the front panel now casts onto that
  // panel, the sleeve casts into the armpit, the boot casts onto the trouser
  // cuff and the brim casts onto the eyes - all of it emergent, none of it
  // authored. Cost is one-time per body variant (~8 of them), hidden behind
  // GAME.yieldFrame during build.
  var AO_CELL = 0.0135;
  // cone: the normal plus four rays tilted 32 degrees, cosine-weighted
  var AO_TILT = 0.53;
  var AO_STEP = [0.030, 0.052, 0.082, 0.120, 0.170, 0.235];
  var AO_SW = [1.00, 0.80, 0.60, 0.42, 0.26, 0.13];

  function bakeAO(pos, nrm, count) {
    var i, k;
    var minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
    for (i = 0; i < count; i++) {
      k = i * 3;
      var x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    var pad = AO_CELL * 4;
    minx -= pad; miny -= pad; minz -= pad;
    var gw = Math.ceil((maxx + pad - minx) / AO_CELL) + 1;
    var gh = Math.ceil((maxy + pad - miny) / AO_CELL) + 1;
    var gd = Math.ceil((maxz + pad - minz) / AO_CELL) + 1;
    if (gw < 2 || gh < 2 || gd < 2 || gw * gh * gd > 3000000) return null;
    var vol = new Uint8Array(gw * gh * gd);
    var inv = 1 / AO_CELL;
    var wh = gw * gh;

    function mark(x, y, z) {
      var ix = (x - minx) * inv | 0;
      var iy = (y - miny) * inv | 0;
      var iz = (z - minz) * inv | 0;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= gw || iy >= gh || iz >= gd) return;
      vol[iz * wh + iy * gw + ix] = 1;
    }

    // ---- splat every triangle, densely enough that no cell-sized hole opens
    var tri = (count / 3) | 0;
    for (i = 0; i < tri; i++) {
      k = i * 9;
      var ax = pos[k], ay = pos[k + 1], az = pos[k + 2];
      var e1x = pos[k + 3] - ax, e1y = pos[k + 4] - ay, e1z = pos[k + 5] - az;
      var e2x = pos[k + 6] - ax, e2y = pos[k + 7] - ay, e2z = pos[k + 8] - az;
      var l1 = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
      var l2 = Math.sqrt(e2x * e2x + e2y * e2y + e2z * e2z);
      var n1 = Math.min(10, Math.max(1, Math.ceil(l1 * inv * 1.5)));
      var n2 = Math.min(10, Math.max(1, Math.ceil(l2 * inv * 1.5)));
      for (var u = 0; u <= n1; u++) {
        var fu = u / n1;
        for (var w2 = 0; w2 <= n2; w2++) {
          var fw = w2 / n2;
          if (fu + fw > 1) break;
          mark(ax + e1x * fu + e2x * fw, ay + e1y * fu + e2y * fw,
            az + e1z * fu + e2z * fw);
        }
      }
    }
    // the street itself is an occluder: without it the sole, the heel and the
    // trouser cuff meet fully-lit asphalt with no darkening at all
    var floorRows = Math.max(0, Math.min(gh - 1, Math.ceil((0.004 - miny) * inv)));
    for (var fy = 0; fy <= floorRows; fy++) {
      for (var fz = 0; fz < gd; fz++) {
        var base = fz * wh + fy * gw;
        for (var fx = 0; fx < gw; fx++) vol[base + fx] = 1;
      }
    }

    // ---- cone-march
    var out = new Float32Array(count);
    var dirx = [0, 0, 0, 0, 0], diry = [0, 0, 0, 0, 0], dirz = [0, 0, 0, 0, 0];
    var dw = [1.0, 0.866, 0.866, 0.866, 0.866];
    var wsum = dw[0] + dw[1] + dw[2] + dw[3] + dw[4];
    var st = Math.sin(AO_TILT), ct = Math.cos(AO_TILT);
    var swTotal = 0;
    for (i = 0; i < AO_SW.length; i++) swTotal = Math.max(swTotal, AO_SW[i]);

    for (i = 0; i < count; i++) {
      k = i * 3;
      var px = pos[k], py = pos[k + 1], pz = pos[k + 2];
      var nx = nrm[k], ny = nrm[k + 1], nz = nrm[k + 2];
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // tangent basis
      var tx, ty, tz;
      if (Math.abs(ny) < 0.9) { tx = -nz; ty = 0; tz = nx; }
      else { tx = 1; ty = 0; tz = 0; }
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      var bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      dirx[0] = nx; diry[0] = ny; dirz[0] = nz;
      dirx[1] = nx * ct + tx * st; diry[1] = ny * ct + ty * st; dirz[1] = nz * ct + tz * st;
      dirx[2] = nx * ct - tx * st; diry[2] = ny * ct - ty * st; dirz[2] = nz * ct - tz * st;
      dirx[3] = nx * ct + bx * st; diry[3] = ny * ct + by * st; dirz[3] = nz * ct + bz * st;
      dirx[4] = nx * ct - bx * st; diry[4] = ny * ct - by * st; dirz[4] = nz * ct - bz * st;
      // lift the origin clear of the vertex's own surface cell
      var ox = px + nx * 0.020, oy = py + ny * 0.020, oz = pz + nz * 0.020;
      var occ = 0;
      for (var d = 0; d < 5; d++) {
        var ddx = dirx[d], ddy = diry[d], ddz = dirz[d];
        for (var s = 0; s < AO_STEP.length; s++) {
          var h = AO_STEP[s];
          var sx = (ox + ddx * h - minx) * inv | 0;
          var sy = (oy + ddy * h - miny) * inv | 0;
          var sz = (oz + ddz * h - minz) * inv | 0;
          if (sx < 0 || sy < 0 || sz < 0 || sx >= gw || sy >= gh || sz >= gd) break;
          if (vol[sz * wh + sy * gw + sx]) { occ += dw[d] * AO_SW[s]; break; }
        }
      }
      out[i] = M.saturate(occ / wsum);
      // The ground plane above is an occluder for EVERY ray, so a boot vertex
      // sees nothing but floor and lands at occ ~1.0 - and then the CSM and the
      // contact patch darken the same region again. Three independent terms
      // multiplying the same occlusion is what turned the boots into a void
      // with no readable sole, welt or lace. Clamp the bake near the ground and
      // let the CSM own the shadowing down there.
      if (py < 0.30) {
        var flr = M.lerp(0.55, 0.30, M.saturate((py - 0.05) / 0.25));
        if (out[i] > flr) out[i] = flr;
      }
    }
    return out;
  }

  var DUST = new THREE.Color().setHex(0xc9b08a, THREE.SRGBColorSpace);

  // --------------------------------------------------------------------------
  // 3b. FACE ATLAS
  //
  // A face cannot be shaded by vertex colour. The face mass is a 128 mm-wide
  // blob at radial 14 / rings 10, i.e. ~30 x 19 mm of vertex spacing: a 29 mm
  // eye socket spans two vertices and a 26 mm nasolabial crease spans less than
  // one, so both average away to nothing. Worse, a vertex tint is ALBEDO - the
  // "socket" and the "cheekbone shadow" look identical no matter where the sun
  // is, so the face front renders as a flat disc with a seam down the midline.
  // That is why the head read as a featureless ovoid despite fifty lines of
  // authored facial structure.
  //
  // Every head therefore carries a CYLINDRICAL UV and samples one shared
  // 768 x 2048 atlas - eight 768 x 256 slots, one per body variant - holding a
  // painted albedo multiplier AND a real height field converted to a tangent
  // space normal map. Brow, sockets, iris, nostrils, philtrum, lips and stubble
  // resolve at PIXEL rate and light like geometry instead of like paint.
  //
  // The head is a second geometry GROUP so the body keeps the untextured
  // vertex-colour path unchanged: two draw calls per man, not one, which is the
  // whole cost of the fix.
  // --------------------------------------------------------------------------
  var FACE_SLOTS = 8;
  var FACE_W = 768, FACE_SLOT_H = 256, FACE_H = FACE_SLOT_H * FACE_SLOTS;
  var FACE_Y0 = 1.535, FACE_YS = 0.245;   // bind-space y band a slot covers
  var FACE_PAD = 0.055;                   // guard band so mips cannot bleed
  var FACE_NS = 0.5;                      // height-field canvas scale
  // The map can only DARKEN, so the head's vertex colour carries 1.6x headroom
  // and the texture's neutral value gives it straight back. Without that there
  // is no way to paint a sclera brighter than the cheek it sits in.
  // Measured, not guessed: at 1.60 / 0.58 (an effective 0.93) the forehead came
  // back at 0.492 against a sunlit-plaster median of 0.444 - still the
  // brightest thing on the man. 1.35 / 0.50 is an effective 0.675, and it
  // still leaves the sclera 2.0x the cheek, which is all an eye needs.
  var FACE_HEADROOM = 1.35;
  var FACE_NEU = 0.50;
  var INV_TAU = 1 / (Math.PI * 2);

  // Surface z of the face mass at (x, y). A feature painted with a straight
  // linear u = x * pxPerMetre is only correct on the midline; by 55 mm out it
  // lands 16 mm inboard of the cheek it was meant for.
  function faceZAt(mx, my) {
    var a = mx / 0.066, b = (my - 1.612) / 0.074;
    var q = 1 - a * a - b * b;
    return 0.020 + 0.080 * Math.sqrt(q > 0.05 ? q : 0.05);
  }
  function faceV(slot, my) {
    var p = (my - FACE_Y0) / FACE_YS;
    p = p < 0 ? 0 : (p > 1 ? 1 : p);
    return (slot + FACE_PAD + (1 - 2 * FACE_PAD) * p) / FACE_SLOTS;
  }
  function lin2byte(x) {
    x = x < 0 ? 0 : (x > 1 ? 1 : x);
    var s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  }

  function FaceAtlas() {
    this.ok = false;
    this.canvas = null; this.g2 = null;
    this.hcan = null; this.hg = null;
    this.map = null; this.normalMap = null;
  }

  FaceAtlas.prototype.init = function () {
    if (typeof document === 'undefined' || !document.createElement) return false;
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = FACE_W; this.canvas.height = FACE_H;
      this.g2 = this.canvas.getContext('2d');
      this.hcan = document.createElement('canvas');
      this.hcan.width = Math.round(FACE_W * FACE_NS);
      this.hcan.height = Math.round(FACE_H * FACE_NS);
      this.hg = this.hcan.getContext('2d');
      if (!this.g2 || !this.hg) return false;
      this.g2.fillStyle = 'rgb(' + lin2byte(FACE_NEU) + ',' +
        lin2byte(FACE_NEU) + ',' + lin2byte(FACE_NEU) + ')';
      this.g2.fillRect(0, 0, FACE_W, FACE_H);
      this.hg.fillStyle = 'rgb(128,128,128)';
      this.hg.fillRect(0, 0, this.hcan.width, this.hcan.height);
      this.hg.setTransform(FACE_NS, 0, 0, FACE_NS, 0, 0);
      this.ok = true;
      return true;
    } catch (e) {
      GAME.logError('ai.faceAtlas', e);
      this.ok = false;
      return false;
    }
  };

  FaceAtlas.prototype.paint = function (slot, look, rng) {
    if (!this.ok || slot < 0 || slot >= FACE_SLOTS) return;
    try { paintFace(this.g2, this.hg, slot, look, rng); }
    catch (e) { GAME.logError('ai.facePaint', e); }
  };

  FaceAtlas.prototype.commit = function () {
    if (!this.ok) return false;
    try {
      var tex = new THREE.CanvasTexture(this.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this.map = tex;

      // ---- height field -> tangent-space normal map -----------------------
      var w = this.hcan.width, h = this.hcan.height;
      var src = this.hg.getImageData(0, 0, w, h).data;
      var out = new Uint8Array(w * h * 4);
      var gain = 3.9;
      for (var y = 0; y < h; y++) {
        var ym = (y > 0 ? y - 1 : 0) * w, yp = (y < h - 1 ? y + 1 : h - 1) * w;
        var yc = y * w;
        for (var x = 0; x < w; x++) {
          var xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
          var dx = (src[(yc + xp) * 4] - src[(yc + xm) * 4]) * (gain / 255);
          // texture v runs UP the canvas (flipY), so dh/dv = -dh/dCanvasY
          var dy = (src[(yp + x) * 4] - src[(ym + x) * 4]) * (gain / 255);
          var l = Math.sqrt(dx * dx + dy * dy + 1);
          var k = (yc + x) * 4;
          out[k] = Math.round((-dx / l * 0.5 + 0.5) * 255);
          out[k + 1] = Math.round((dy / l * 0.5 + 0.5) * 255);
          out[k + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
          out[k + 3] = 255;
        }
      }
      var nt = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
      nt.colorSpace = THREE.NoColorSpace;
      nt.wrapS = THREE.RepeatWrapping;
      nt.wrapT = THREE.ClampToEdgeWrapping;
      nt.minFilter = THREE.LinearMipmapLinearFilter;
      nt.magFilter = THREE.LinearFilter;
      nt.generateMipmaps = true;
      nt.needsUpdate = true;
      this.normalMap = nt;
      return true;
    } catch (e) {
      GAME.logError('ai.faceCommit', e);
      this.ok = false;
      return false;
    }
  };

  FaceAtlas.prototype.dispose = function () {
    if (this.map) { this.map.dispose(); this.map = null; }
    if (this.normalMap) { this.normalMap.dispose(); this.normalMap = null; }
    this.ok = false;
  };

  // Everything below is authored in BIND-SPACE METRES and projected through the
  // same cylinder the UV writer uses, so a nostril painted at x = 8.5 mm lands
  // on the nostril.
  function paintFace(g2, hg, slot, look, rng) {
    var PMY = (1 - 2 * FACE_PAD) / FACE_YS * FACE_SLOT_H;
    var slotTop = FACE_H - (slot + 1) * FACE_SLOT_H;

    function X(mx, my) {
      return (Math.atan2(mx, faceZAt(mx, my)) * INV_TAU + 0.5) * FACE_W;
    }
    function Y(my) { return (1 - faceV(slot, my)) * FACE_H; }
    function C(r, g, b) {
      return lin2byte(FACE_NEU * r) + ',' + lin2byte(FACE_NEU * g) + ',' +
        lin2byte(FACE_NEU * b);
    }
    // soft elliptical wash: source-over so overlapping features LERP toward
    // their target instead of stacking multiplicatively into black
    function soft(g, mx, my, hw, hh, col, a) {
      var xa = X(mx - hw, my), xb = X(mx + hw, my);
      var rx = Math.max(1.2, (xb - xa) * 0.5), cx = (xa + xb) * 0.5;
      var ry = Math.max(1.2, hh * PMY), cy = Y(my);
      g.save();
      g.translate(cx, cy); g.scale(rx, ry);
      var grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grd.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')');
      grd.addColorStop(0.42, 'rgba(' + col + ',' + (a * 0.76).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(' + col + ',0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    function hard(g, mx, my, hw, hh, col, a) {
      var xa = X(mx - hw, my), xb = X(mx + hw, my);
      var rx = Math.max(0.7, (xb - xa) * 0.5), cx = (xa + xb) * 0.5;
      var ry = Math.max(0.7, hh * PMY), cy = Y(my);
      g.save();
      g.translate(cx, cy); g.scale(rx, ry);
      g.globalAlpha = a;
      g.fillStyle = 'rgb(' + col + ')';
      g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    function pair(fn, g, mx, my, hw, hh, col, a) {
      fn(g, mx, my, hw, hh, col, a); fn(g, -mx, my, hw, hh, col, a);
    }
    var H = function (v) { var b = Math.round(M.clamp(v, 0, 255)); return b + ',' + b + ',' + b; };

    // ---- clip to this slot: nothing may leak into a neighbour --------------
    g2.save();
    g2.beginPath(); g2.rect(0, slotTop, FACE_W, FACE_SLOT_H); g2.clip();
    hg.save();
    hg.beginPath(); hg.rect(0, slotTop, FACE_W, FACE_SLOT_H); hg.clip();

    g2.fillStyle = 'rgb(' + C(1, 1, 1) + ')';
    g2.fillRect(0, slotTop, FACE_W, FACE_SLOT_H);
    hg.fillStyle = 'rgb(128,128,128)';
    hg.fillRect(0, slotTop, FACE_W, FACE_SLOT_H);

    var i, t, mx, my, a;

    // ---- skin mottle: blotch, sunburn and grime, never a flat tone ---------
    for (i = 0; i < 230; i++) {
      mx = rng.range(-0.30, 0.30);
      my = rng.range(FACE_Y0, FACE_Y0 + FACE_YS);
      var k = rng.range(0.86, 1.09);
      soft(g2, mx, my, rng.range(0.006, 0.024), rng.range(0.004, 0.016),
        C(k, k * rng.range(0.96, 1.02), k * rng.range(0.92, 1.0)), rng.range(0.10, 0.26));
    }

    // ---- broad form: the planes of a face, as VALUE not as geometry --------
    // The forehead is a near-horizontal plane pointed straight at the sky, so
    // it is already the brightest part of the head before any paint touches it.
    // It gets a hairline shadow, not a lift.
    soft(g2, 0, 1.712, 0.060, 0.026, C(0.72, 0.69, 0.67), 0.55);      // hairline
    soft(g2, 0, 1.690, 0.048, 0.022, C(0.93, 0.92, 0.90), 0.30);      // frontal
    pair(soft, g2, 0.058, 1.674, 0.026, 0.032, C(0.74, 0.70, 0.68), 0.52);  // temples
    pair(soft, g2, 0.041, 1.636, 0.026, 0.020, C(1.09, 1.06, 1.02), 0.30);  // malar
    pair(soft, g2, 0.056, 1.6475, 0.019, 0.011, C(1.11, 1.07, 1.03), 0.32); // zygomatic
    pair(soft, g2, 0.037, 1.605, 0.026, 0.020, C(0.76, 0.70, 0.68), 0.44);  // hollow
    pair(soft, g2, 0.052, 1.588, 0.026, 0.026, C(0.64, 0.59, 0.58), 0.48);  // jaw side
    pair(soft, g2, 0.0405, 1.5735, 0.023, 0.010, C(0.58, 0.53, 0.52), 0.44);// jaw underside
    soft(g2, 0, 1.559, 0.062, 0.022, C(0.44, 0.41, 0.41), 0.72);           // under jaw
    soft(g2, 0, 1.578, 0.024, 0.012, C(1.06, 1.03, 1.00), 0.30);           // chin ball
    for (i = 0; i < 3; i++) {                                              // brow lines
      soft(g2, rng.range(-0.006, 0.006), 1.684 + i * 0.008, 0.036, 0.0022,
        C(0.84, 0.80, 0.78), 0.30);
    }

    // ---- brow ridge and eye sockets ---------------------------------------
    pair(soft, g2, 0.030, 1.6735, 0.031, 0.009, C(1.06, 1.04, 1.01), 0.26);
    pair(soft, g2, 0.029, 1.6545, 0.026, 0.012, C(0.44, 0.38, 0.36), 0.78);
    soft(g2, 0, 1.658, 0.011, 0.010, C(1.02, 1.00, 0.98), 0.26);           // glabella
    // eyebrow hair, drawn as short strokes so it is not a decal bar
    for (i = 0; i < 34; i++) {
      t = (i % 17) / 16;
      mx = 0.014 + t * 0.031;
      my = 1.6665 + Math.sin(t * 2.4) * 0.0024 - t * 0.0018;
      a = i < 17 ? 1 : -1;
      soft(g2, mx * a, my, rng.range(0.005, 0.009), rng.range(0.0026, 0.0044),
        C(0.24, 0.20, 0.18), rng.range(0.70, 0.98));
    }

    // ---- the eye ----------------------------------------------------------
    for (i = 0; i < 2; i++) {
      var ex = i === 0 ? 0.029 : -0.029;
      soft(g2, ex, 1.6485, 0.0135, 0.0055, C(1.62, 1.58, 1.50), 0.90);      // sclera
      soft(g2, ex - (i === 0 ? 0.011 : -0.011), 1.6475, 0.005, 0.004,
        C(0.62, 0.50, 0.47), 0.55);                                          // canthus
      hard(g2, ex, 1.6478, 0.0056, 0.0056, C(0.36, 0.25, 0.17), 0.95);       // iris
      hard(g2, ex, 1.6478, 0.0026, 0.0026, C(0.10, 0.09, 0.09), 0.95);       // pupil
      hard(g2, ex - (i === 0 ? 0.0024 : -0.0024), 1.6502, 0.0014, 0.0014,
        C(1.70, 1.70, 1.70), 0.95);                                          // catchlight
      hard(g2, ex, 1.6524, 0.0128, 0.0013, C(0.20, 0.16, 0.15), 0.85);       // lash line
      soft(g2, ex, 1.6535, 0.0140, 0.0038, C(0.46, 0.40, 0.38), 0.72);       // lid crease
      soft(g2, ex, 1.6432, 0.0120, 0.0024, C(1.14, 1.06, 1.00), 0.40);       // lower lid
      soft(g2, ex, 1.6410, 0.0140, 0.0040, C(0.74, 0.66, 0.64), 0.42);       // tear trough
    }

    // ---- nose -------------------------------------------------------------
    soft(g2, 0, 1.636, 0.0075, 0.020, C(1.12, 1.09, 1.05), 0.42);
    pair(soft, g2, 0.0135, 1.632, 0.0075, 0.019, C(0.70, 0.63, 0.60), 0.55);
    soft(g2, 0, 1.6215, 0.010, 0.0075, C(1.10, 1.06, 1.02), 0.36);
    pair(soft, g2, 0.0140, 1.6165, 0.0072, 0.0060, C(0.62, 0.53, 0.50), 0.60);
    pair(hard, g2, 0.0086, 1.6132, 0.0040, 0.0026, C(0.12, 0.10, 0.10), 0.90);
    soft(g2, 0, 1.6095, 0.016, 0.0048, C(0.54, 0.46, 0.44), 0.58);

    // ---- mouth ------------------------------------------------------------
    pair(soft, g2, 0.0046, 1.6025, 0.0024, 0.0055, C(0.82, 0.76, 0.74), 0.45);
    soft(g2, 0, 1.5975, 0.0195, 0.0050, C(0.88, 0.72, 0.68), 0.52);
    hard(g2, 0, 1.5945, 0.0198, 0.0016, C(0.28, 0.20, 0.19), 0.82);
    soft(g2, 0, 1.5905, 0.0175, 0.0058, C(1.06, 0.88, 0.83), 0.44);
    soft(g2, 0, 1.5845, 0.0155, 0.0048, C(0.62, 0.55, 0.53), 0.52);
    pair(soft, g2, 0.0190, 1.5945, 0.0042, 0.0040, C(0.50, 0.42, 0.40), 0.58);

    // ---- nasolabial fold --------------------------------------------------
    for (i = 0; i < 5; i++) {
      t = i / 4;
      soft(g2, 0.016 + t * 0.021, 1.6085 - t * 0.0165, 0.0042, 0.0050,
        C(0.68, 0.60, 0.58), 0.42);
      soft(g2, -(0.016 + t * 0.021), 1.6085 - t * 0.0165, 0.0042, 0.0050,
        C(0.68, 0.60, 0.58), 0.42);
    }

    // ---- stubble ----------------------------------------------------------
    var stub = look.beard ? 0.34 : 0.20;
    for (i = 0; i < 170; i++) {
      mx = rng.range(-0.060, 0.060);
      my = rng.range(1.556, 1.618);
      if (Math.abs(mx) < 0.021 && my > 1.5985 && my < 1.6125) continue;   // lips clear
      soft(g2, mx, my, rng.range(0.004, 0.011), rng.range(0.003, 0.007),
        C(0.66, 0.62, 0.60), rng.range(stub * 0.5, stub));
    }
    if (look.moustache) {
      for (i = 0; i < 40; i++) {
        soft(g2, rng.range(-0.022, 0.022), rng.range(1.6035, 1.6115),
          rng.range(0.004, 0.009), rng.range(0.0022, 0.0042),
          C(0.42, 0.38, 0.34), rng.range(0.25, 0.55));
      }
    }

    // ---- grime: sweat-cut dirt on the cheekbones and brow ------------------
    for (i = 0; i < 22; i++) {
      mx = rng.range(-0.062, 0.062);
      my = rng.range(1.596, 1.700);
      soft(g2, mx, my, rng.range(0.004, 0.013), rng.range(0.006, 0.020),
        C(0.66, 0.60, 0.54), rng.range(0.10, 0.24));
    }

    // ======================================================================
    // HEIGHT FIELD - this is the half that makes the face respond to the sun
    // ======================================================================
    // Relief depths, deepened across the board. The previous set peaked at
    // 196/88 around the brow and socket - a 108/255 step spread over eight
    // texels, which after the mip chain and a 3.4 gain came back as a gentle
    // undulation. The head therefore lit like a smooth ovoid with a picture of
    // a face on it, which is exactly the critique. Nothing here changes the
    // ALBEDO, so the face cannot get dirtier or blotchier; only its response to
    // the raking sun changes.
    pair(soft, hg, 0.031, 1.6705, 0.033, 0.011, H(214), 0.92);   // brow ridge
    soft(hg, 0, 1.662, 0.013, 0.010, H(176), 0.72);              // glabella
    pair(soft, hg, 0.029, 1.6525, 0.027, 0.013, H(62), 0.94);    // socket
    pair(soft, hg, 0.029, 1.6485, 0.0130, 0.0060, H(150), 0.72); // eyeball
    pair(soft, hg, 0.029, 1.6535, 0.0135, 0.0028, H(72), 0.94);  // lid crease
    pair(soft, hg, 0.058, 1.674, 0.026, 0.030, H(90), 0.60);     // temple
    soft(hg, 0, 1.694, 0.050, 0.028, H(154), 0.48);              // frontal bone
    soft(hg, 0, 1.636, 0.0072, 0.022, H(208), 0.88);             // nose ridge
    pair(soft, hg, 0.0132, 1.632, 0.0072, 0.020, H(80), 0.80);   // nose sides
    soft(hg, 0, 1.6215, 0.010, 0.0075, H(198), 0.74);            // nose tip
    pair(soft, hg, 0.0155, 1.6145, 0.0085, 0.0072, H(168), 0.70);// alae
    pair(hard, hg, 0.0086, 1.6132, 0.0040, 0.0026, H(40), 0.95); // nostrils
    soft(hg, 0, 1.6085, 0.015, 0.0045, H(84), 0.74);             // subnasal
    soft(hg, 0, 1.6025, 0.0060, 0.0060, H(96), 0.78);            // philtrum
    soft(hg, 0, 1.5975, 0.0195, 0.0050, H(180), 0.82);           // upper lip
    hard(hg, 0, 1.5945, 0.0198, 0.0016, H(60), 0.95);            // lip line
    soft(hg, 0, 1.5905, 0.0175, 0.0058, H(190), 0.82);           // lower lip
    soft(hg, 0, 1.5845, 0.0155, 0.0046, H(96), 0.70);            // mentolabial
    soft(hg, 0, 1.5765, 0.024, 0.011, H(154), 0.52);             // chin ball
    pair(soft, hg, 0.0425, 1.6395, 0.027, 0.021, H(186), 0.72);  // cheekbone
    pair(soft, hg, 0.0575, 1.6480, 0.020, 0.012, H(176), 0.60);  // zygomatic arch
    pair(soft, hg, 0.037, 1.605, 0.026, 0.020, H(84), 0.62);     // cheek hollow
    pair(soft, hg, 0.0500, 1.5880, 0.020, 0.014, H(170), 0.60);  // gonial angle
    pair(soft, hg, 0.0420, 1.5715, 0.024, 0.010, H(78), 0.55);   // under the jaw
    for (i = 0; i < 5; i++) {
      t = i / 4;
      soft(hg, 0.016 + t * 0.021, 1.6085 - t * 0.0165, 0.0042, 0.0050, H(98), 0.55);
      soft(hg, -(0.016 + t * 0.021), 1.6085 - t * 0.0165, 0.0042, 0.0050, H(98), 0.55);
    }
    for (i = 0; i < 200; i++) {                                   // pore / stubble grain
      soft(hg, rng.range(-0.075, 0.075), rng.range(1.548, 1.712),
        rng.range(0.0022, 0.0058), rng.range(0.0018, 0.0040),
        H(rng.range(112, 148)), rng.range(0.25, 0.6));
    }

    hg.restore();
    g2.restore();
  }

  CharBuilder.prototype.finish = function () {
    var parts = this.parts, i, j;
    // Head skin moves to the END of the buffer so it can be ONE contiguous
    // geometry group with its own textured material, leaving the body on the
    // untouched vertex-colour path. Stable partition: nothing else about the
    // part order matters, every attribute is generated per part.
    var fslot = this.faceSlot === undefined ? -1 : this.faceSlot;
    var faceStart = -1;
    if (fslot >= 0) {
      var bodyP = [], faceP = [];
      for (i = 0; i < parts.length; i++) {
        if (parts[i].o && parts[i].o.face) faceP.push(parts[i]); else bodyP.push(parts[i]);
      }
      if (faceP.length && bodyP.length) {
        parts = bodyP.concat(faceP);
        this.parts = parts;
      } else fslot = -1;
    }
    var entries = [];
    for (i = 0; i < parts.length; i++) entries.push({ geometry: parts[i].geometry });

    // mergeAll gives us one position/normal/uv buffer; the skinning and shading
    // attributes are then generated from the merged bind-space positions.
    var geo = GAME.Geo.mergeAll(entries);
    var pos = geo.attributes.position;
    var nrm = geo.attributes.normal;
    var count = pos.count;

    var colA = new Float32Array(count * 3);
    var srfA = new Float32Array(count * 4);
    var skI = new Uint16Array(count * 4);
    var skW = new Float32Array(count * 4);
    if (fslot >= 0 && !geo.attributes.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    var uvA = geo.attributes.uv ? geo.attributes.uv.array : null;

    // one bake for the whole assembled body, against the real triangles
    var aoBake = null;
    try {
      aoBake = bakeAO(pos.array, nrm.array, count);
    } catch (e) {
      aoBake = null;
      GAME.logError('ai.aoBake', e);
    }

    var noise = GAME.noise;
    var wIdx = [0, 0, 0, 0], wVal = [0, 0, 0, 0];
    var off = 0;

    for (i = 0; i < parts.length; i++) {
      var g = parts[i].geometry;
      var n = g.index ? g.index.count : g.attributes.position.count;
      var o = parts[i].o;
      var bones = o.bones || ['hips'];
      var bidx = [];
      for (j = 0; j < bones.length; j++) {
        if (BI[bones[j]] !== undefined) bidx.push(BI[bones[j]]);
      }
      if (!bidx.length) bidx.push(0);

      var baseCol = _col.setHex(o.color === undefined ? 0x808080 : o.color, THREE.SRGBColorSpace);
      var br = baseCol.r, bg = baseCol.g, bb = baseCol.b;
      // per-part value jitter: three identical pouches read as one moulded
      // lump, the same three at +/-15% value read as three separate pouches
      if (o.value !== undefined) { br *= o.value; bg *= o.value; bb *= o.value; }
      var rough = o.r === undefined ? 0.85 : o.r;
      var metal = o.m === undefined ? 0.0 : o.m;
      var kind = o.k === undefined ? K.CLOTH : o.k;
      var dust = o.dust === undefined ? 0.5 : o.dust;
      var aoK = o.ao === undefined ? 1.0 : o.ao;
      // webbing is a self-shadowing pile of straps and pouches; it needs far
      // more contact darkening than a smooth sleeve does
      var aoScale = kind === K.WEBBING ? 1.00 : (kind === K.LEATHER ? 0.90 : 0.80);
      var tintFn = typeof o.tint === 'function' ? o.tint : null;
      var isFace = fslot >= 0 && !!o.face;
      if (isFace && faceStart < 0) faceStart = off;

      for (j = 0; j < n; j++) {
        var vi = off + j;
        var px = pos.getX(vi), py = pos.getY(vi), pz = pos.getZ(vi);

        // ---- skin weights -------------------------------------------------
        var k, w, total = 0, used = 0;
        wIdx[0] = wIdx[1] = wIdx[2] = wIdx[3] = 0;
        wVal[0] = wVal[1] = wVal[2] = wVal[3] = 0;
        for (k = 0; k < bidx.length; k++) {
          var d2 = distSeg(px, py, pz, SEG[bidx[k]]);
          w = 1 / (d2 * d2 + 1e-7);           // 1/d^4 - tight, well-behaved falloff
          // insertion sort into the top-4
          var slot = -1;
          for (var s = 0; s < 4; s++) { if (w > wVal[s]) { slot = s; break; } }
          if (slot >= 0) {
            for (var t2 = 3; t2 > slot; t2--) { wVal[t2] = wVal[t2 - 1]; wIdx[t2] = wIdx[t2 - 1]; }
            wVal[slot] = w; wIdx[slot] = bidx[k];
            if (used < 4) used++;
          }
        }
        for (k = 0; k < 4; k++) total += wVal[k];
        if (total <= 0) { wVal[0] = 1; wIdx[0] = bidx[0]; total = 1; }
        for (k = 0; k < 4; k++) {
          skI[vi * 4 + k] = wIdx[k];
          skW[vi * 4 + k] = wVal[k] / total;
        }

        // ---- colour: base + mottling + baked AO + ground dust --------------
        var r = br, gg = bg, b = bb;
        if (tintFn) { tintFn(px, py, pz, _col.setRGB(r, gg, b)); r = _col.r; gg = _col.g; b = _col.b; }
        var mott = 1 + 0.13 * noise.fbm3(px * 11, py * 11, pz * 11, 3);
        r *= mott; gg *= mott; b *= mott;
        // Road dust ROUGHENS and DESATURATES; it must not lift a dark albedo.
        // Lerping toward the dust colour turned 0.033-linear boot leather into
        // 0.147 and made the boots brighter than the trousers - a 4.4x lift
        // that inverted the whole value structure of the costume. The ramp also
        // stops at the boot top now instead of climbing to mid-calf.
        var dirt = M.saturate((0.22 - py) / 0.22) * dust;
        if (dirt > 0.001) {
          var lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
          var des = dirt * 0.28, veil = dirt * 0.085;
          r = M.lerp(r, lum, des); gg = M.lerp(gg, lum, des); b = M.lerp(b, lum, des);
          r = M.lerp(r, r * 0.60 + DUST.r * 0.40, veil);
          gg = M.lerp(gg, gg * 0.60 + DUST.g * 0.40, veil);
          b = M.lerp(b, b * 0.60 + DUST.b * 0.40, veil);
        }
        // Occlusion is applied in TWO places for a reason. A small power of it
        // goes into the albedo (real cavities are dirtier and darker), but the
        // bulk of it rides in aSurf.w and multiplies irradiance in the shader,
        // so it darkens the sky fill and the IBL specular as well - which is
        // what actually separates a pouch from the panel it is bolted to.
        var occ = aoBake ? aoBake[vi] * aoScale * aoK : 0;
        var ao = M.saturate(1 - occ);
        var aoAlb = Math.pow(ao, 0.45);
        r *= aoAlb; gg *= aoAlb; b *= aoAlb;
        colA[vi * 3] = r; colA[vi * 3 + 1] = gg; colA[vi * 3 + 2] = b;

        // ---- surface parameters -------------------------------------------
        // dusty cloth is rougher; worn edges on metal are smoother
        srfA[vi * 4] = M.saturate(rough * (0.92 + 0.16 * noise.perlin3(px * 6, py * 6, pz * 6)) + dirt * 0.18);
        srfA[vi * 4 + 1] = metal;
        srfA[vi * 4 + 2] = kind;
        // never let the ambient term go fully to zero - pure black shadow is
        // the single most obvious amateur tell there is
        srfA[vi * 4 + 3] = 0.16 + 0.84 * ao;

        // ---- cylindrical face UV ------------------------------------------
        if (isFace && uvA) {
          uvA[vi * 2] = Math.atan2(px, pz) * INV_TAU + 0.5;
          uvA[vi * 2 + 1] = faceV(fslot, py);
        }
      }
      off += n;
      g.dispose();
    }

    // A cylindrical projection has one seam, at the back of the skull, where u
    // jumps 0 <-> 1 inside a single triangle and smears the whole atlas across
    // it. Unwrap those triangles past 1.0 instead and let RepeatWrapping do the
    // rest - the buffer is non-indexed, so a triangle is three consecutive
    // vertices and this is exact.
    if (faceStart >= 0 && uvA) {
      for (i = faceStart; i + 2 < count; i += 3) {
        var ua = uvA[i * 2], ub = uvA[i * 2 + 2], uc = uvA[i * 2 + 4];
        var umin = Math.min(ua, Math.min(ub, uc));
        var umax = Math.max(ua, Math.max(ub, uc));
        if (umax - umin > 0.5) {
          if (ua < 0.5) uvA[i * 2] = ua + 1;
          if (ub < 0.5) uvA[i * 2 + 2] = ub + 1;
          if (uc < 0.5) uvA[i * 2 + 4] = uc + 1;
        }
      }
      geo.addGroup(0, faceStart, 0);
      geo.addGroup(faceStart, count - faceStart, 1);
      geo.userData.faceGroup = true;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(srfA, 4));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skI, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skW, 4));
    // No aoMap is used (occlusion is baked per-vertex above), so a second UV
    // set via GAME.Geo.copyUV1 would only waste memory here.
    geo.computeBoundingBox();
    // Generous bounds: the bind pose is not the animated extent, and a tight
    // sphere makes three cull characters that are still on screen.
    geo.boundingSphere = new THREE.Sphere(new V3(0, 1.0, 0), 1.55);
    this.parts.length = 0;
    return geo;
  };

  // --------------------------------------------------------------------------
  // 4. CHARACTER MATERIAL
  //
  // One MeshStandardMaterial for every enemy. Vertex colour carries albedo,
  // aSurf.x/y carry roughness/metalness and aSurf.z selects a procedural
  // micro-normal (weave, pebbled leather, skin pores, brushed metal). Doing the
  // detail in the shader means no texture memory, no UV seams and no tiling.
  // --------------------------------------------------------------------------
  var CHAR_VS_DECL = [
    'attribute vec4 aSurf;',
    'varying vec4 vSurf;',
    'varying vec3 vBindPos;',
    'varying float vDist;'
  ].join('\n');

  var CHAR_FS_DECL = [
    'varying vec4 vSurf;',
    'varying vec3 vBindPos;',
    'varying float vDist;',
    'uniform vec3 uSunDirView;',
    'uniform vec3 uSunColor;',
    'uniform vec3 uSkyColor;',
    'float boHash(vec3 p){',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.zyx + 31.32);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    'float boNoise(vec3 x){',
    '  vec3 i = floor(x), f = fract(x);',
    '  f = f * f * (3.0 - 2.0 * f);',
    '  float a = mix(boHash(i), boHash(i + vec3(1.0,0.0,0.0)), f.x);',
    '  float b = mix(boHash(i + vec3(0.0,1.0,0.0)), boHash(i + vec3(1.0,1.0,0.0)), f.x);',
    '  float c = mix(boHash(i + vec3(0.0,0.0,1.0)), boHash(i + vec3(1.0,0.0,1.0)), f.x);',
    '  float d = mix(boHash(i + vec3(0.0,1.0,1.0)), boHash(i + vec3(1.0,1.0,1.0)), f.x);',
    '  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);',
    '}',
    // height field per surface kind, amplitude already in "millimetres-ish"
    // Frequencies are deliberately below what the old code used: a 780 cycles/m
    // weave is 1.3 mm, which is exactly one pixel on a militiaman at 3 m, and
    // it moired into a visible checkerboard across the trousers.
    'float boSurf(vec3 p, float kind){',
    '  if (kind < 0.5) {',
    '    float w = sin(dot(p, vec3(0.94,0.21,0.27)) * 290.0) * sin(dot(p, vec3(-0.26,0.88,0.40)) * 290.0);',
    '    return w * 0.17 + boNoise(p * 105.0) * 0.60 + boNoise(p * 32.0) * 0.28;',
    '  } else if (kind < 1.5) {',
    '    return boNoise(p * 190.0) * 0.70 + boNoise(p * 52.0) * 0.38;',
    '  } else if (kind < 2.5) {',
    '    return boNoise(p * 300.0) * 0.26 + boNoise(p * 70.0) * 0.24;',
    '  } else if (kind < 3.5) {',
    '    return boNoise(vec3(p.x * 420.0, p.y * 420.0, p.z * 30.0)) * 0.40;',
    '  } else if (kind < 4.5) {',
    '    return sin(p.y * 240.0) * 0.34 + boNoise(p * 95.0) * 0.50;',
    '  }',
    '  return boNoise(vec3(p.x * 240.0, p.y * 50.0, p.z * 240.0)) * 0.8;',
    '}',
    // Analytic mean of boSurf per kind. The albedo breakup used to be
    // 0.88 + 0.24*boH, which only averages to 1.0 if boH averages 0.5 - it does
    // not, and the error runs from -7% on metal to +1% on leather. Subtracting
    // the mean makes the term exactly value-preserving, so it breaks a surface
    // up without quietly shifting the whole costume's value hierarchy.
    'float boMean(float kind){',
    '  if (kind < 0.5) return 0.44;',
    '  else if (kind < 1.5) return 0.54;',
    '  else if (kind < 2.5) return 0.25;',
    '  else if (kind < 3.5) return 0.20;',
    '  else if (kind < 4.5) return 0.25;',
    '  return 0.40;',
    '}'
  ].join('\n');

  // Join GLSL lines, dropping any entry a `wet ? ... : null` ternary left empty.
  // With no night entries present the result is byte-identical to .join('\n'),
  // which is how the market program stays exactly what it was.
  function glsl(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) { if (a[i]) out.push(a[i]); }
    return out.join('\n');
  }

  // Extra fragment declarations for the WET NIGHT variant. Never injected into
  // the market program - see makeCharacterMaterial(face, night).
  var CHAR_FS_WET_DECL = [
    'uniform vec3 uKeyDirView;',   // view-space direction TOWARD the dominant practical
    'uniform vec3 uKeyColor;',     // its colour, already scaled by its irradiance here
    'uniform vec3 uBounceColor;',  // sodium bounced back up off the wet apron
    'uniform vec3 uUpView;',       // world +Y in view space
    'uniform float uWet;'          // 0..1 surface wetness from GAME.Weather
  ].join('\n');

  // `face` is an optional FaceAtlas. When present this material is the one
  // bound to the head group and carries the painted albedo + normal map.
  //
  // `night` selects the WET NIGHT variant (Cold Harbor). Everything this file
  // does to keep a militiaman from glowing - a 0.42 envMapIntensity, a hard AO
  // choke on irradiance/iblIrradiance/radiance, a 0.58 albedo crush with range,
  // and a rim/wrap pair keyed to sky.sunIntensity - was authored against a
  // 5.2-intensity afternoon sun. Point the same material at 02:00 in a storm
  // and every one of those terms still fires while the thing they were
  // balancing against is gone: measured on the harbor portrait, sunIntensity
  // is 0.187, so the rim gain kSun sits on its 0.02 floor and contributes
  // nothing, the level's key is a 6.5 m sodium mast BEHIND the subject at
  // irradiance 3.87, and the whole camera-facing front of the man is lit by
  // ambient alone - which this material then multiplies by 0.42 x vSurf.w.
  // The trousers photographed at 0.0036 display-linear against 0.0273 for the
  // container directly behind him: a 7.6:1 inversion, i.e. a black cut-out.
  //
  // The night variant does not brighten his costume. It gives him the light
  // the level actually has: the practical's rim and wrap, the sodium bounced
  // up off a wet apron that photographs at 0.22, a storm-dome sheen on soaked
  // cloth, and the market's anti-glow clamps relaxed to night strength.
  function makeCharacterMaterial(face, night) {
    var hasFace = !!(face && face.ok && face.map);
    var wet = !!night;
    var mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,          // modulated per-vertex by aSurf.x
      metalness: 1.0,          // modulated per-vertex by aSurf.y
      vertexColors: true,
      // A body is a self-occluding volume: it never sees a full hemisphere.
      // At 0.9 the sky floods the whole chest rig with flat uniform fill and
      // every pouch, strap and buckle collapses to one value.
      //
      // That is a DAYLIGHT argument: it is guarding against a 5.2-intensity sky
      // dome. The harbor's dome is a storm deck at scene.environmentIntensity
      // 0.41, and 0.42 x 0.41 leaves the man with no environment at all - which
      // on a level whose whole look is "wet surfaces get their value from
      // reflections" removes the one thing that would sell him as soaked.
      // 0.62 and not the 1.05 this started at: measured against a control
      // render of the market program in the same harbor build, 1.05 stacked on
      // top of the level's own practicals and turned him into a smooth orange
      // mannequin with the whole costume fused to one value. 1.5x the market,
      // not 2.5x.
      envMapIntensity: wet ? 0.62 : 0.42,
      dithering: true
    });
    mat.name = hasFace ? 'ai_character_face' : 'ai_character';
    if (wet) mat.name += '_wet';
    if (hasFace) {
      mat.map = face.map;
      if (face.normalMap) {
        mat.normalMap = face.normalMap;
        mat.normalScale = new THREE.Vector2(0.85, 0.85);
      }
    }
    // Shared, live uniforms - one material serves every enemy, so AISystem
    // refreshes these once a frame from ctx.sky rather than per instance.
    var uni = {
      uSunDirView: { value: new THREE.Vector3(0.0, 0.24, -0.97) },
      uSunColor: { value: new THREE.Color(1.0, 0.84, 0.62) },
      uSkyColor: { value: new THREE.Color(0.30, 0.42, 0.60) }
    };
    if (wet) {
      // Sensible standing values so the first frame is never black even if the
      // practical solve has nothing to work with yet.
      uni.uKeyDirView = { value: new THREE.Vector3(0.0, 0.70, -0.71) };
      uni.uKeyColor = { value: new THREE.Color(0.55, 0.20, 0.05) };
      uni.uBounceColor = { value: new THREE.Color(0.30, 0.16, 0.08) };
      uni.uUpView = { value: new THREE.Vector3(0.0, 1.0, 0.0) };
      uni.uWet = { value: 1.0 };
    }
    mat.userData.charUniforms = uni;
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uSunDirView = uni.uSunDirView;
      shader.uniforms.uSunColor = uni.uSunColor;
      shader.uniforms.uSkyColor = uni.uSkyColor;
      if (wet) {
        shader.uniforms.uKeyDirView = uni.uKeyDirView;
        shader.uniforms.uKeyColor = uni.uKeyColor;
        shader.uniforms.uBounceColor = uni.uBounceColor;
        shader.uniforms.uUpView = uni.uUpView;
        shader.uniforms.uWet = uni.uWet;
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + CHAR_VS_DECL)
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n  vSurf = aSurf;\n  vBindPos = transformed;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\n  vDist = -mvPosition.z;');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\n' + CHAR_FS_DECL + (wet ? '\n' + CHAR_FS_WET_DECL : ''))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          // Do not fade the surface detail out with distance - COARSEN it. The
          // old window killed every trace of cloth weave past 13 m, and a
          // firefight happens at 25-32 m, so every enemy the player will ever
          // shoot at was a flat vertex-coloured blob. Scaling the sampling
          // frequency down instead turns the micro weave into a macro mottle
          // that survives the distance without aliasing.
          '  float boFar = smoothstep(3.0, 24.0, vDist);',
          '  vec3 boP = vBindPos * mix(1.0, 0.30, boFar);',
          '  float boH = boSurf(boP, vSurf.z);',
          '  float boFade = 1.0 - smoothstep(18.0, 55.0, vDist);',
          // albedo breakup runs at full strength at EVERY distance - it costs
          // one noise fetch and it is the only thing between us and a blob.
          // Mean-subtracted, so it cannot bias the costume's value hierarchy.
          '  diffuseColor.rgb *= 1.0 + 0.26 * (boH - boMean(vSurf.z));',
          // ---- distance contrast -------------------------------------------
          // At 27 m the militiaman measured BRIGHTER than the plaster wall
          // behind him: fog lift plus a full-hemisphere sky fill plus an albedo
          // breakup that averaged above 1.0. In a shipped shooter the enemy is
          // the dark, saturated shape against the bright wall, and that
          // inversion is why the squad read as ghosts. Pull the albedo down
          // with range and let the rim term below do the separating instead.
          // The ramp used to start at 12 m and finish at 30. The capture framing
          // compresses a squad to roughly 22-27 m, so the term was only ever
          // half engaged in the one frame it exists for, and the near
          // militiaman still measured 1.11x the plaster behind him. Starting at
          // 8 m puts it at full strength across the whole engagement band.
          // Measured, not guessed: in the capture the near militiaman subtends
          // 46 px of a 720-line frame, which puts him at 14-24 m depending on
          // FOV - so a ramp that only reaches full strength at 26-30 m was
          // barely engaged in the exact frame it was written for, and moving
          // its endpoint changed the measured torso luminance by under 1%.
          // 5-18 m is the band an engagement actually happens in.
          '  float boRange = smoothstep(5.0, 18.0, vDist);',
          // ...and NONE of that reasoning survives the move to 02:00. The thing
          // this crush exists to stop - an enemy measuring brighter than the
          // sunlit wall behind him - cannot happen on a level with no sun; the
          // harbor firefight stands its squad at 11-30 m, i.e. squarely inside
          // the ramp, so at night it simply removes 42% of the albedo from
          // every man the player is actually shooting at. Held at a token
          // strength there so the near/far ordering still reads.
          // 0.66, not the 0.88 this started at: measured on the harbor
          // firefight, the man at ~27 m stands on a stack top inside a mercury
          // flood and photographed at 0.644 mean against 0.242 for the
          // container behind him, with a p95 of 0.99 - clipping, and the exact
          // enemy-brighter-than-his-backdrop inversion this crush exists to
          // stop. It just does not need the DAYLIGHT strength to stop it. This
          // term is exactly zero at the portrait's 3.5 m either way, so none of
          // this trades against the close framing.
          wet ? '  diffuseColor.rgb *= mix(1.0, 0.66, boRange);'
              : '  diffuseColor.rgb *= mix(1.0, 0.58, boRange);',
          // Skin gets its warmth from subsurface scatter, not from a bright
          // albedo. Lifting the raw albedo instead made the forehead the
          // brightest object in the frame, brighter than sunlit plaster - and
          // the round-2 capture measured exactly that again (forehead 0.460,
          // cheek 0.474 against a sunlit-plaster median of 0.416). The lift is
          // now gated on the TERMINATOR: it warms the turn of the form, where
          // light really does bleed through the skin, instead of flooding the
          // whole face front, and the gain is roughly halved. It has to be
          // applied after <normal_fragment_maps> (there is no `normal` yet at
          // <color_fragment>), which is still before <lights_physical_fragment>
          // reads diffuseColor, so the lighting sees it.
          '  float boSkin = 1.0 - smoothstep(0.0, 0.55, abs(vSurf.z - 2.0));'
        ].join('\n'))
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor *= vSurf.x * (0.93 + 0.14 * boH);')
        .replace('#include <metalnessmap_fragment>',
          '#include <metalnessmap_fragment>\n  metalnessFactor *= vSurf.y;')
        .replace('#include <normal_fragment_maps>', glsl([
          '#include <normal_fragment_maps>',
          // ---- WET (harbor only) --------------------------------------------
          // Everything else in this level is soaked; a bone-dry militiaman in a
          // downpour is the tell that he was dropped in from another build.
          // Water does two things to cloth and neither of them is "lighten it":
          // the film fills the fibre pile so the surface goes GLOSSY, and the
          // extra internal reflection makes the albedo DARKER and more
          // saturated. The gloss is what makes him read at night - a soaked
          // shoulder catches the storm dome and the sodium pool where a dry one
          // returns nothing - so the darkening is kept mild and the roughness
          // does the work.
          //
          // Rain falls DOWN, so the mask is weighted by how much of the sky a
          // surface can see: vSurf.w is the openness bake (a pouch gusset stays
          // comparatively dry) and the up-facing term soaks shoulders, the hat
          // crown, forearms and boot uppers hardest.
          wet ? glsl([
            '  float boUpF = saturate(dot(normal, uUpView));',
            '  float boWetM = uWet * (0.34 + 0.66 * vSurf.w) * (0.72 + 0.28 * boUpF);'
          ]) : null,
          // only the NORMAL perturbation fades - it is the part that shimmers
          '  if (boFade > 0.002) {',
          '    vec3 boA = abs(normal.z) < 0.9 ? vec3(0.0,0.0,1.0) : vec3(1.0,0.0,0.0);',
          '    vec3 boT1 = normalize(cross(normal, boA));',
          '    vec3 boT2 = cross(normal, boT1);',
          // the epsilon lives in boP space, so it tracks the coarsening for free
          '    float boE = 0.0025;',
          '    float boH1 = boSurf(boP + boT1 * boE, vSurf.z);',
          '    float boH2 = boSurf(boP + boT2 * boE, vSurf.z);',
          // The wet variant deliberately does NOT raise this amplitude. It was
          // tried - beaded water really is extra relief, and it breaks up the
          // flat bright polygons an eight-sided lathe shoulder presents to a
          // mast - but the cloth height field runs at 290 cycles/m, which is
          // sub-pixel on a man at 3.5 m, and a 70% louder version of a
          // sub-pixel field is a diagonal moire across both thighs. The facets
          // are damped by the roughness term below instead, which cannot alias.
          '    normal = normalize(normal - (boT1 * (boH1 - boH) + boT2 * (boH2 - boH)) * (0.14 * boFade));',
          '  }',
          // These two move TOGETHER and that is the whole point. Water darkens
          // cloth and sharpens its highlight at the same time, so pairing a
          // 0.42 roughness multiplier with a 0.80 albedo multiplier raises the
          // CONTRAST between a soaked sleeve and the sheen running along it
          // without raising the mean - which is what "wet" actually looks like,
          // and which also keeps the man a shade under the lit crates behind
          // him rather than level with them. The roughness floor exists because
          // nothing on a person is a mirror, wet or not.
          wet ? '  roughnessFactor = max(roughnessFactor * mix(1.0, 0.42, boWetM), 0.22);' : null,
          wet ? '  diffuseColor.rgb *= mix(1.0, 0.80, boWetM);' : null,
          // ---- specular anti-aliasing --------------------------------------
          // The receiver band peaked at 0.93 luminance - 2.1x the brightest
          // sunlit plaster in the frame - because a flat, coplanar, near-mirror
          // plate presents one specular lobe straight at a low sun. Round 1
          // tried to tune the roughness value; the problem is geometric, so the
          // fix has to be geometric too: widen the lobe by exactly the amount
          // the normal varies inside the pixel (Kaplanyan/Tokuyoshi filtering),
          // and hold a hard roughness floor on anything flagged METAL.
          '  vec3 boDx = dFdx(normal), boDy = dFdy(normal);',
          '  float boVar = max(dot(boDx, boDx), dot(boDy, boDy));',
          '  roughnessFactor = sqrt(min(1.0, roughnessFactor * roughnessFactor + 2.0 * boVar));',
          '  if (abs(vSurf.z - 3.0) < 0.5) roughnessFactor = max(roughnessFactor, 0.34);',
          // subsurface warmth, on the TERMINATOR only (see <color_fragment>)
          '  float boTerm = 1.0 - saturate(dot(normal, uSunDirView));',
          '  diffuseColor.rgb += boSkin * boTerm * (diffuseColor.rgb * vec3(0.20, 0.06, 0.02)',
          '                               + vec3(0.012, 0.004, 0.003));'
        ]))
        // ---- baked occlusion on the AMBIENT term ---------------------------
        // aSurf.w carries the volumetric bake. Multiplying albedo alone (what
        // round 1 did) cannot make a pouch read against the panel it is bolted
        // to, because both get the same flat sky fill on top. Multiplying
        // irradiance and iblIrradiance is what actually darkens the crevice.
        .replace('#include <lights_fragment_maps>', glsl([
          '#include <lights_fragment_maps>',
          // The full-strength choke is a daylight instrument. Under a 5.2 sun
          // the ambient is a luxury and taking 60% of it out of a crevice is
          // free; under a storm deck it is the ONLY light reaching the whole
          // camera-facing front of a backlit man, and taking 60% out of that
          // leaves 0.0036 display-linear - a hole in the frame. Softened to a
          // 60% blend at night: the pouch still sits under the panel, but the
          // panel still exists.
          wet ? '  irradiance *= mix(1.0, vSurf.w, 0.80);'
              : '  irradiance *= vSurf.w;',
          wet ? '  iblIrradiance *= mix(1.0, vSurf.w, 0.85) * mix(1.0, 0.55, boRange);'
              : '  iblIrradiance *= vSurf.w * mix(1.0, 0.45, boRange);',
          // ---- sodium bounced up off the wet apron (harbor only) ------------
          // The single biggest thing missing from a character at Cold Harbor.
          // The apron under a mast photographs at 0.22 display-linear - it is
          // the brightest surface anywhere near the subject - and a wet apron
          // is closer to a mirror than to a diffuser, so it throws that light
          // back UP. That is the fill that puts a chin, a chest rig and the
          // front of a thigh back into the picture when the only key in the
          // level is 5 m above and behind the man's shoulder. Weighted over the
          // lower hemisphere (1.0 straight down, 0.5 on a vertical, 0 on a
          // shoulder), which is the correct form factor for a ground plane, and
          // sized in JS from the practical's real irradiance at his feet.
          wet ? '  irradiance += uBounceColor * (0.5 - 0.5 * dot(normal, uUpView)) *' : null,
          wet ? '                mix(1.0, vSurf.w, 0.55);' : null,
          // ---- grazing-angle specular occlusion ------------------------------
          // Fresnel goes to 1.0 at grazing incidence, so a 0.02-linear nylon
          // band or a hat brim seen edge-on gets a FULL-strength environment
          // reflection and renders as a neutral white hairline. Measured on the
          // brow band: 131/125/122 against 100/80/70 of lit skin either side -
          // a cool grey line straight across the forehead. Real rough cloth
          // self-occludes that reflection; three has no term for it, so this is
          // it. Keyed on roughness, so the carbine keeps its edge.
          '  float boNV = saturate(dot(normal, normalize(vViewPosition)));',
          // Wet cloth genuinely DOES carry a grazing reflection - that sheen IS
          // what "soaked" looks like - so the fibre self-occlusion floor is
          // relaxed with wetness, and the range crush on the environment lobe,
          // which exists only to stop a sunlit enemy glowing, comes out.
          wet ? '  float boGF = mix(0.16, 0.46, uWet);' : null,
          wet ? '  float boGraze = mix(1.0, boGF + (1.0 - boGF) * boNV * boNV, material.roughness);'
              : '  float boGraze = mix(1.0, 0.16 + 0.84 * boNV * boNV, material.roughness);',
          wet ? '  radiance *= mix(1.0, vSurf.w, 0.45) * mix(1.0, 0.62, boRange) * boGraze;'
              : '  radiance *= mix(1.0, vSurf.w, 0.7) * mix(1.0, 0.45, boRange) * boGraze;'
        ]))
        // ---- rim / backlight ------------------------------------------------
        // The single highest-leverage tool for separating a character from a
        // busy plate, and the reason a backlit enemy pops against rubble. There
        // was none anywhere in this file. Added as indirect specular so it
        // reaches outgoingLight without being multiplied by albedo.
        .replace('#include <lights_fragment_end>', glsl([
          '#include <lights_fragment_end>',
          // Exponent and gain both matter more than they look. At pow 3 with a
          // 0.55 gain the term covered the whole outer HALF of every rounded
          // mass - a militiaman's skull, deltoids, sleeves and the eight
          // near-cylindrical parts of his carbine are all high-curvature, so
          // "the silhouette edge" was most of the character. The result was a
          // pale grey shroud over the man and a rifle that read as bare chrome:
          // the receiver measured p90 0.757 against a frame p95 of 0.728. A rim
          // is a HIGHLIGHT, not a coat of paint. pow 5 with a 0.34 gain and a
          // 0.22 ceiling keeps it in the last few degrees of grazing angle where
          // it belongs, and metal - which already gets its edge from the IBL
          // specular lobe - is damped to 45%.
          // Grazing specular, part two: the DIRECT lobe. Fresnel goes to 1.0 at
          // the horizon, so wherever a hat crown crosses the skull, a strap
          // crosses a panel or a band crosses a cuff, the last few pixels of
          // the upper surface present a near-tangential sliver that lights up
          // like chrome and reads as a ruled white line. Rough cloth loses that
          // lobe to its own microfacet shadowing; three keeps it.
          '  reflectedLight.directSpecular *= boGraze;',
          '  vec3 boV = normalize(vViewPosition);',
          '  float boRim = 1.0 - saturate(dot(normal, boV));',
          '  boRim = boRim * boRim * boRim * boRim * boRim;',
          '  float boBack = saturate(-dot(boV, uSunDirView));',
          '  boBack *= boBack;',
          '  float boMet = 1.0 - 0.55 * saturate(1.0 - abs(vSurf.z - 3.0));',
          // and rough cloth does not carry a mirror rim either - on a 0.02
          // albedo an unconditional 0.22 IS the pixel
          '  vec3 boRimC = boRim * boMet * (1.0 - 0.55 * material.roughness) *',
          '                (0.34 * boBack * uSunColor + 0.05 * uSkyColor);',
          '  reflectedLight.indirectSpecular += min(boRimC, vec3(0.20)) * vSurf.w;',
          // Wrapped diffuse on skin: a backlit ear and nose bridge glow because
          // light travels through them. Without it a face lit from behind is a
          // flat cut-out.
          //
          // This lives OUTSIDE the light loop, so nothing multiplied it by the
          // shadow factor: a militiaman standing in a building's shadow still
          // got a sun term on every square millimetre of exposed skin, which is
          // half of why his head and both forearms measured brighter than the
          // sunlit plaster behind him. GAME.Lighting publishes getCSMShadow()
          // into shadowmap_pars_fragment, so the same cascade lookup the direct
          // path uses is available here for one extra call.
          '  float boNdl = dot(normal, uSunDirView);',
          '  float boWrap = saturate((boNdl + 0.32) / 1.32) - saturate(boNdl);',
          '  reflectedLight.directDiffuse += boSkin * boWrap * boSunVis * 0.22 * uSunColor * diffuseColor.rgb;',
          // ---- THE PRACTICAL KEY (harbor only) -------------------------------
          // Every term above is hung off uSunDirView / uSunColor, and AISystem
          // scales those by sky.sunIntensity so a militiaman does not glow at
          // midnight. At Cold Harbor sunIntensity is 0.187 and the gain sits on
          // its 0.02 floor, so the ENTIRE rim/backlight apparatus - the one
          // thing this file calls "the single highest-leverage tool for
          // separating a character from a busy plate" - is switched off in the
          // one level that needs it most, because the level's key is not the
          // sun. It is a sodium mast. uKeyDirView / uKeyColor carry that mast
          // (solved per frame in _syncKey), so the same apparatus runs again
          // against the light that is actually there.
          //
          // pow 4 rather than the sun rim's pow 5: a 6.5 m lamp head 5 m away
          // is a far bigger source relative to a man than the sun is, so its
          // wrap around the silhouette is genuinely wider. The 0.28 pedestal on
          // boBack keeps a side-lit shoulder from losing its edge entirely.
          wet ? glsl([
            '  float boRimK = 1.0 - saturate(dot(normal, boV));',
            '  boRimK = boRimK * boRimK * boRimK * boRimK;',
            '  float boBackK = saturate(-dot(boV, uKeyDirView));',
            '  boBackK = 0.28 + 0.72 * boBackK * boBackK;',
            // The cold half is deliberately worth almost as much as the warm
            // one. A man lit only by sodium is a monochrome orange cut-out; the
            // storm deck is a real second source and putting it on the OTHER
            // edge is what gives the silhouette two colours and a direction.
            '  vec3 boRimK2 = boRimK * boMet * boBackK *',
            '                 (0.55 * uKeyColor + 0.65 * uSkyColor);',
            '  reflectedLight.indirectSpecular += min(boRimK2, vec3(0.26)) * mix(1.0, vSurf.w, 0.55);',
            // Wrapped key. A lamp head is a metre of glass at 5 m, not a point,
            // and rain scatter widens it further; the terminator on a man under
            // one is soft. This is the difference between a chest rig with
            // pouches in it and a black rectangle.
            '  float boNdlK = dot(normal, uKeyDirView);',
            '  float boWrapK = saturate((boNdlK + 0.62) / 1.62) - saturate(boNdlK);',
            '  reflectedLight.directDiffuse += boWrapK * 0.30 * uKeyColor *',
            '                                  diffuseColor.rgb * mix(1.0, vSurf.w, 0.7);'
          ]) : null
        ]));

      // The lookup degrades to "lit" rather than failing to compile when the
      // CSM patch is not present (shadows off, or an unexpected three build).
      var vis = '  float boSunVis = 1.0;\n';
      try {
        if (THREE.ShaderChunk && THREE.ShaderChunk.shadowmap_pars_fragment &&
          THREE.ShaderChunk.shadowmap_pars_fragment.indexOf('getCSMShadow') >= 0) {
          vis = [
            '  float boSunVis = 1.0;',
            '  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0',
            '  boSunVis = getCSMShadow( geometryNormal, uSunDirView );',
            '  #endif',
            ''
          ].join('\n');
        }
      } catch (e) { vis = '  float boSunVis = 1.0;\n'; }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_end>', vis + '#include <lights_fragment_end>');
    };
    // A stable cache key keeps three from recompiling this program per instance.
    mat.customProgramCacheKey = function () {
      return (hasFace ? 'blackout-character-face' : 'blackout-character') +
        (wet ? '-wet' : '');
    };
    return mat;
  }

  // --------------------------------------------------------------------------
  // 4b. THE MILITIAMAN
  //
  // Dark utility trousers, dark shirt, olive/tan chest rig with pouches, boots,
  // gloves and mismatched headwear - per ART_DIRECTION. The silhouette targets
  // are the shoulder line, the bulk of the rig, and the head shape.
  // --------------------------------------------------------------------------
  // Dark, but never black - flat black cloth is the amateur tell that kills a
  // character in a shadowed street. These sit around 0.06-0.12 linear so the
  // cool sky fill still finds them.
  // The value hierarchy is deliberate and it is the thing that makes a militia
  // silhouette readable at 30 m:
  //   skin ~0.20 lin > rig ~0.13 > trouser ~0.055 > shirt ~0.042 > boot ~0.028
  // The old palette ran skin at 0.487 against cloth at 0.065 - a 7.5:1 face-to-
  // shirt albedo ratio that does not exist in nature and that made a bald
  // forehead the brightest object in the frame, brighter than sunlit plaster.
  var PAL = {
    skin: [0x7d5c40, 0x8a6743, 0x6b4f38, 0x855f42, 0x74553a],
    shirt: [0x3b382f, 0x453f31, 0x4a3d2b, 0x333c39, 0x524a39, 0x40352d],
    // Measured in the round-3 portrait the thigh came back at 0.229 and the
    // shin at 0.220 - BRIGHTER than the chest rig at 0.191 and level with the
    // street at 0.203, so the legs neither separated from the ground nor sat
    // under the webbing. The torso is buried under the carrier and both arms
    // and picks up a lot of occlusion; the legs stand in the open and pick up
    // none, so the albedo has to carry the difference.
    trouser: [0x3a382f, 0x444335, 0x4d4130, 0x333530, 0x3f3b33],
    rig: [0x625f3d, 0x7e7252, 0x66573a, 0x4d4d31, 0x736446],
    // Boot leather at 0x2c231b is 0.028 linear, and the whole boot family under
    // it (sole 0x231e17, lugs 0x191510) ran 0.010-0.014. Measured in the
    // capture the boots came out at 0.041 median with a p05 of 0.026 - a black
    // void with no readable sole, welt, heel or lace, so the legs simply
    // dissolved into the street with no ground contact. Lifted to 0.030-0.045
    // linear, which is still the darkest note on the figure by a clear margin.
    boot: [0x453a2c, 0x4d4131, 0x3e352d],
    // The gloves used to be DARKER than the boots (0.020-0.031 against 0.028),
    // inverting this file's own stated value hierarchy, and at 0.052 measured
    // against a 0.0735 carbine the hand and the weapon fused into one black
    // mass - the "mitten" read. They now sit between trouser and boot.
    // Tactical gloves. At 0x453e34 / 0x4d443a the whole hand measured 0.043
    // median in the closeup - inside the boot's value band and below anything
    // the eye can resolve shape in, which is half of why the hands read as one
    // undifferentiated mitten. Lifted ~35% in linear terms so the modelled
    // gulleys between the fingers have something to be darker THAN; still well
    // under skin (0.126) and well over the boots (0.030-0.045).
    glove: [0x4f463b, 0x574d42],
    // hair and beard sit around 0.04 linear. At 0.012 a beard rendered as a
    // black balaclava glued to the jaw, which is worse than no beard at all.
    hair: [0x2b231b, 0x342a20, 0x3e3126],
    // A beard has to land ~2.5 stops under the cheek or it reads as tape. The
    // old set measured only 18% below the cheek because dust:0.15 and an
    // unshadowed skin wrap both lifted it.
    beard: [0x332b22, 0x2b2419, 0x3b3228],
    // Headwear is the brightest note on a militiaman and it sits at the top of
    // his silhouette, so it sets whether the whole figure reads darker than the
    // wall behind him. A dusty shemagh in the field is not bleached cotton; the
    // old 0x938b78 measured 0.26 linear and made the head the brightest object
    // on the man by a factor of two.
    hat: [0x63603f, 0x524d38, 0x6e6749, 0x3e3b2c],
    // The shemagh ran 0.17-0.24 linear - BRIGHTER than skin at 0.126 - so
    // wherever the wrap's lower edge turned to face the camera it lit up as a
    // pale band ruled straight across the brow (measured 110/106/106 against a
    // 60-70 dome). A dusty field shemagh is not bleached cotton; 0.09-0.13
    // linear puts it under the face where it belongs.
    scarf: [0x635c4c, 0x6e6657, 0x524d41, 0x5a5347],
    // near-black nylon webbing and bare hardware. Straps at the same colour and
    // roughness as the pouch bodies is what turned the rig into a flat apron.
    nylon: [0x1a1814, 0x1f1c16, 0x16150f],
    buckle: [0x4a4640, 0x3a3833]
  };

  function pickLook(rng) {
    var hatRoll = rng.next();
    var hat = hatRoll < 0.28 ? 'shemagh' : (hatRoll < 0.54 ? 'boonie' :
      (hatRoll < 0.76 ? 'cap' : 'bare'));
    // Stature and build are the only silhouette cues the player gets at 25 m,
    // and they are negatively correlated in a real crowd - a taller man is
    // usually the lighter build.
    var tall = rng.range(0, 1);
    var heightScale = M.lerp(0.92, 1.09, tall);
    var bulk = M.lerp(1.18, 0.86, tall) + rng.range(-0.09, 0.09);
    var rigRoll = rng.next();
    return {
      skin: rng.pick(PAL.skin),
      shirt: rng.pick(PAL.shirt),
      trouser: rng.pick(PAL.trouser),
      rig: rng.pick(PAL.rig),
      nylon: rng.pick(PAL.nylon),
      buckle: rng.pick(PAL.buckle),
      boot: rng.pick(PAL.boot),
      glove: rng.pick(PAL.glove),
      hair: rng.pick(PAL.hair),
      beardColor: rng.pick(PAL.beard),
      hat: hat,
      hatColor: rng.pick(PAL.hat),
      hatTilt: rng.range(-0.13, 0.13),
      brimPhase: rng.range(0, Math.PI * 2),
      scarf: rng.pick(PAL.scarf),
      sleeves: rng.bool(0.45),      // rolled sleeves show forearms
      mask: rng.bool(0.3),
      beard: rng.bool(0.45),
      moustache: rng.bool(0.55),
      // rig configuration is a second silhouette axis: a plate carrier, a
      // bandolier over one shoulder, or no rig at all read differently at 30 m
      rigStyle: rigRoll < 0.58 ? 'carrier' : (rigRoll < 0.86 ? 'bandolier' : 'none'),
      openShirt: rng.bool(0.32),    // an open overshirt widens the shoulder line
      heightScale: heightScale,
      bulk: M.clamp(bulk, 0.84, 1.20)
    };
  }

  // Smooth ellipsoidal falloff, 1 at the centre and 0 at the shell.
  function ellipFall(dx, dy, dz, rx, ry, rz) {
    var a = dx / rx, b = dy / ry, c = dz / rz;
    var d = Math.sqrt(a * a + b * b + c * c);
    if (d >= 1) return 0;
    var f = 1 - d;
    return f * f * (3 - 2 * f);
  }

  // FALLBACK ONLY. Baked facial structure as a MULTIPLIER on the skin albedo
  // in bind space. It cannot resolve a 29 mm socket on a mesh whose vertices
  // are 30 mm apart and it cannot respond to the sun, which is exactly why the
  // face atlas replaced it - but in an environment with no 2D canvas it is
  // still better than a blank egg, so it survives on that branch. The y
  // constants track the taller skull.
  function makeFaceShade(look) {
    var brimR = 0, brimY = 1.664, brimDark = 1;
    if (look.hat === 'boonie') { brimR = 0.145; brimY = 1.664; brimDark = 0.50; }
    else if (look.hat === 'cap') { brimR = 0.120; brimY = 1.672; brimDark = 0.55; }
    else if (look.hat === 'shemagh') { brimR = 0.110; brimY = 1.670; brimDark = 0.66; }
    return function (px, py, pz, c) {
      var m = 1;
      // Eye sockets - the single biggest readability win on a head. The old
      // radii (rz 0.030, ry 0.022) were centred at pz 0.076 with the actual
      // face surface out at z = 0.10-0.12, so the falloff reached zero BEFORE
      // it got to the skin: the eye had 4% contrast against the cheek and the
      // face read as having no eyes at all. rz 0.055 / ry 0.030 puts the
      // shell past the surface, which is the whole point of a baked socket.
      // Width matters as much as depth. At rx 0.036 centred +/-0.031 the two
      // sockets spanned 134 mm of a 156 mm-wide head and merged into ONE dark
      // band across the face - the man read as if he were wearing sunglasses.
      // 29 mm half-width leaves a lit nose bridge between them and lit malar
      // bone outboard of them, which is what makes two eyes read as two eyes.
      m *= 1 - 0.46 * ellipFall(px - 0.029, py - 1.6495, pz - 0.070, 0.029, 0.028, 0.055);
      m *= 1 - 0.46 * ellipFall(px + 0.029, py - 1.6495, pz - 0.070, 0.029, 0.028, 0.055);
      // upper-lid shadow: the brow ridge overhangs the eye and that overhang is
      // the darkest note on a lit face
      m *= 1 - 0.28 * ellipFall(px - 0.029, py - 1.6625, pz - 0.072, 0.032, 0.015, 0.058);
      m *= 1 - 0.28 * ellipFall(px + 0.029, py - 1.6625, pz - 0.072, 0.032, 0.015, 0.058);
      // cheekbone shadow and the nasolabial crease beside the nose
      m *= 1 - 0.30 * ellipFall(px - 0.036, py - 1.606, pz - 0.060, 0.026, 0.028, 0.040);
      m *= 1 - 0.30 * ellipFall(px + 0.036, py - 1.606, pz - 0.060, 0.026, 0.028, 0.040);
      // under the jaw and behind the mandible
      m *= 1 - 0.40 * ellipFall(px, py - 1.558, pz - 0.010, 0.078, 0.040, 0.072);
      // temples
      m *= 1 - 0.22 * ellipFall(px - 0.062, py - 1.674, pz - 0.024, 0.026, 0.042, 0.040);
      m *= 1 - 0.22 * ellipFall(px + 0.062, py - 1.674, pz - 0.024, 0.026, 0.042, 0.040);
      // the brim shadow across the eyes
      if (brimR > 0 && py > brimY - 0.022) {
        var rad = Math.sqrt(px * px + pz * pz);
        if (rad < brimR) {
          var t = M.saturate((py - (brimY - 0.022)) / 0.030);
          var e = M.saturate((brimR - rad) / 0.034);
          m *= M.lerp(1, brimDark, t * e);
        }
      }
      c.setRGB(c.r * m, c.g * m, c.b * m);
      return c;
    };
  }

  function buildMilitiaman(rng, look) {
    var B = new CharBuilder(rng);
    B.faceSlot = look.faceSlot === undefined ? -1 : look.faceSlot;
    var bulk = look.bulk;
    var cloth = { r: 0.90, m: 0.0, k: K.CLOTH, dust: 0.85 };
    var s, side, sgn;

    function opt(base, extra) {
      var o = {}, kk;
      for (kk in base) o[kk] = base[kk];
      for (kk in extra) o[kk] = extra[kk];
      return o;
    }

    // ---- pelvis and legs (dark utility trousers) ---------------------------
    B.limb(v(0, 0.885, 0.004), v(0, 1.050, 0.0),
      [[0, 0.126 * bulk], [0.45, 0.148 * bulk], [1, 0.146 * bulk]],
      opt(cloth, { sx: 1.05, sz: 0.76, bones: ['hips', 'spine', 'upLegL', 'upLegR'], color: look.trouser, radial: 12, rings: 4, cap0: 0.75, cap1: 0.2 }));

    for (s = 0; s < 2; s++) {
      sgn = s === 0 ? 1 : -1;
      side = s === 0 ? 'L' : 'R';
      // thigh - full at the hip, tapering to the knee, trousers slightly baggy
      B.limb(v(sgn * 0.098, 0.960, 0.005), v(sgn * 0.102, 0.505, 0.012),
        [[0, 0.100 * bulk], [0.35, 0.092 * bulk], [1, 0.070]],
        opt(cloth, { sx: 1, sz: 0.96, bones: ['upLeg' + side, 'loLeg' + side, 'hips'], color: look.trouser, radial: 10, rings: 5, cap0: 0.45, cap1: 0.25 }));
      // calf - bulge at 30% down from the knee reads as a leg, not a pipe
      B.limb(v(sgn * 0.102, 0.510, 0.010), v(sgn * 0.104, 0.150, -0.006),
        [[0, 0.070], [0.30, 0.078], [1, 0.050]],
        opt(cloth, { sx: 1, sz: 0.96, bones: ['loLeg' + side, 'foot' + side, 'upLeg' + side], color: look.trouser, radial: 10, rings: 5, cap0: 0.2, cap1: 0.1 }));
      // Trouser blousing gathered over the boot top. It has to OVERLAP the
      // boot shaft, not butt against it: a cuff that stops exactly where the
      // leather starts reads as two separate cylinders stacked on each other.
      B.band(0.238, 0.056, 0.078, { cx: sgn * 0.104, cz: -0.004, radial: 12, thick: 0.014, bones: ['foot' + side, 'loLeg' + side], color: look.trouser, r: 0.92, k: K.CLOTH, dust: 0.9, value: 0.90 });
      B.band(0.212, 0.061, 0.040, { cx: sgn * 0.104, cz: -0.004, radial: 12, thick: 0.010, bones: ['foot' + side, 'loLeg' + side], color: look.trouser, r: 0.93, k: K.CLOTH, dust: 0.95, value: 0.80 });
      // Cargo pocket on the outer thigh. A utility trouser leg is not a smooth
      // 450 mm tube - the bellows pocket is the single most recognisable thing
      // about it, and it is what breaks the "grey wetsuit legs" read at any
      // distance. Standing ~20 mm proud of the thigh surface it also catches
      // its own occlusion from the volumetric bake, so it darkens the trouser
      // behind it instead of being one more coplanar decal.
      B.box(v(sgn * 0.150, 0.752, 0.062), 0.084, 0.138, 0.062,
        { bevel: 0.014, bones: ['upLeg' + side, 'loLeg' + side], color: look.trouser, r: 0.92, m: 0, k: K.CLOTH, dust: 0.7, value: 1.26 });
      B.box(v(sgn * 0.150, 0.814, 0.066), 0.088, 0.022, 0.066,
        { bevel: 0.006, bones: ['upLeg' + side], color: look.trouser, r: 0.90, m: 0, k: K.CLOTH, dust: 0.6, value: 0.66 });
      // Outseam. A 450 mm trouser leg with nothing running down it is a smooth
      // grey tube however good the albedo is; the seam is the one line that
      // says "garment" from the front at any distance.
      B.box(v(sgn * 0.166, 0.760, 0.006), 0.010, 0.400, 0.012,
        { bevel: 0.003, bones: ['upLeg' + side, 'loLeg' + side], color: look.trouser, r: 0.94, m: 0, k: K.CLOTH, dust: 0.7, value: 0.72 });
      B.box(v(sgn * 0.132, 0.376, 0.008), 0.010, 0.240, 0.012,
        { bevel: 0.003, bones: ['loLeg' + side, 'foot' + side], color: look.trouser, r: 0.94, m: 0, k: K.CLOTH, dust: 0.8, value: 0.72 });
      // A KNEE, always. It used to be a 50% kneepad roll and nothing at all
      // otherwise, so most of the squad had a smooth hose from hip to ankle
      // with no joint corner anywhere in it. The men who should not have gear
      // get the same mass in trouser cloth at a low value, which reads as a
      // patella rather than as a pad.
      if (rng.bool(0.5)) {
        B.blob(v(sgn * 0.103, 0.512, 0.050), 0.048, 0.058, 0.032,
          { radial: 8, rings: 5, bones: ['loLeg' + side, 'upLeg' + side], color: 0x33302c, r: 0.72, m: 0.0, k: K.LEATHER, dust: 0.9, value: 1.26 });
      } else {
        B.blob(v(sgn * 0.103, 0.512, 0.050), 0.048, 0.058, 0.032,
          { radial: 8, rings: 5, bones: ['loLeg' + side, 'upLeg' + side], color: look.trouser, r: 0.90, m: 0.0, k: K.CLOTH, dust: 0.8, value: 1.10 });
      }
      // ---- boot: lugged sole, vamp, ankle shaft ----------------------------
      // The boots must be the DARKEST note on the figure. Dust weights here are
      // deliberately tiny: a dust-lightened sole reads as a pale sock, and it
      // used to measure brighter than the trousers above it.
      // A boot is WIDER than the ankle above it. At 104 mm against a 134 mm
      // trouser blousing the foot read as a thin wedge poking out of a trouser
      // leg - the leg looked like it terminated in a peg.
      // Sole unit. It stands 8 mm PROUD of the leather on both sides, so a
      // hard highlight line separates sole from upper at every angle - that
      // step is what stops a boot reading as an ankle band. 132 mm wide against
      // a 122 mm upper.
      // The whole boot family used to run 0.010-0.014 linear and measured 0.041
      // median / 0.026 p05 in the capture: a black void below ART_DIRECTION's
      // "no pure black" bar, with every authored detail - five lug notches, the
      // midsole welt, the heel break, the toe cap stitch, four lace bands -
      // completely invisible, so the legs dissolved and the figure had no
      // ground contact at all. Three terms were stacking on the same occlusion
      // (albedo, the ground occluder in bakeAO, the CSM and the contact patch);
      // bakeAO now clamps near the floor and these values sit at 0.030-0.045.
      // ao is deliberately relieved on the whole boot family. The volumetric
      // bake treats the STREET as an occluder, so a vertex 30 mm off the ground
      // sees nothing but floor and comes back at occ ~1 - and then the CSM, the
      // contact patch and the character's own shadow darken exactly the same
      // pixels. Four terms multiplying one occlusion is what produced a 0.041
      // median black void where a boot should be.
      var sole = { bevel: 0.006, bones: ['foot' + side, 'toe' + side], color: 0x453d33, r: 0.88, m: 0, k: K.RUBBER, dust: 0.10, ao: 0.72 };
      B.box(v(sgn * 0.104, 0.016, 0.030), 0.132, 0.026, 0.270, sole);
      // Midsole welt. Inset 4 mm and run bright: a light edge line the length
      // of the sole/upper break is the single thing that separates a boot from
      // an ankle-shaped hole in the road.
      B.box(v(sgn * 0.104, 0.037, 0.030), 0.122, 0.015, 0.258,
        { bevel: 0.004, bones: ['foot' + side, 'toe' + side], color: 0x50473b, r: 0.72, m: 0, k: K.RUBBER, dust: 0.10, ao: 0.60, value: 1.45 });
      // heel block - the profile needs a heel break or it reads as a slipper
      B.box(v(sgn * 0.104, 0.026, -0.062), 0.126, 0.046, 0.092,
        { bevel: 0.006, bones: ['foot' + side], color: 0x3e372e, r: 0.90, m: 0, k: K.RUBBER, dust: 0.08, ao: 0.72 });
      // lug notches down the sole's side face - at 3.5 m this is the detail
      // that says "combat boot" rather than "dark rectangle"
      for (var lg = 0; lg < 5; lg++) {
        B.box(v(sgn * 0.104, 0.014, -0.056 + lg * 0.040), 0.140, 0.011, 0.014,
          { bevel: 0.003, bones: ['foot' + side, 'toe' + side], color: 0x342d25, r: 0.92, m: 0, k: K.RUBBER, dust: 0.05, ao: 0.72, value: 0.80 });
      }
      // toe box: tall enough to read as a boot rather than a clog
      B.box(v(sgn * 0.103, 0.078, 0.094), 0.116, 0.078, 0.146,
        { bevel: 0.026, bones: ['toe' + side, 'foot' + side], color: look.boot, r: 0.58, m: 0.02, k: K.LEATHER, dust: 0.25, ao: 0.72 });
      // toe cap - a separate panel with a stitch break across the vamp
      B.box(v(sgn * 0.103, 0.076, 0.140), 0.108, 0.062, 0.062,
        { bevel: 0.022, bones: ['toe' + side, 'foot' + side], color: look.boot, r: 0.48, m: 0.03, k: K.LEATHER, dust: 0.18, ao: 0.66, value: 1.14 });
      B.box(v(sgn * 0.104, 0.096, 0.004), 0.120, 0.126, 0.166,
        { bevel: 0.024, bones: ['foot' + side], color: look.boot, r: 0.58, m: 0.02, k: K.LEATHER, dust: 0.25, ao: 0.72 });
      // ankle shaft, laced up under the trouser blousing
      B.box(v(sgn * 0.104, 0.180, -0.014), 0.116, 0.112, 0.132,
        { bevel: 0.028, bones: ['foot' + side, 'loLeg' + side], color: look.boot, r: 0.64, m: 0.02, k: K.LEATHER, dust: 0.25, ao: 0.78, value: 1.06 });
      // Lace panel. It used to carry value 1.5, which made it the brightest
      // element on the whole lower leg - it read as a reflective strap, not as
      // laces. Now it is a recessed dark tongue with alternating cross-bands.
      B.box(v(sgn * 0.104, 0.132, 0.062), 0.048, 0.096, 0.048,
        { bevel: 0.006, bones: ['foot' + side], color: look.nylon, r: 0.86, m: 0, k: K.WEBBING, dust: 0.20, ao: 0.80, value: 0.85 });
      for (var lc = 0; lc < 4; lc++) {
        B.box(v(sgn * 0.104, 0.096 + lc * 0.024, 0.076), 0.056, 0.006, 0.024,
          { bevel: 0.002, bones: ['foot' + side], color: 0x4a4238, r: 0.78, m: 0, k: K.WEBBING, dust: 0.15, ao: 0.66, value: 1.35 });
      }
    }

    // ---- torso -------------------------------------------------------------
    // abdomen
    B.limb(v(0, 1.030, 0.0), v(0, 1.215, 0.005),
      [[0, 0.150 * bulk], [1, 0.158 * bulk]],
      opt(cloth, { sx: 1, sz: 0.70, bones: ['hips', 'spine', 'chest'], color: look.shirt, radial: 12, rings: 4, cap0: 0.15, cap1: 0.1 }));
    // chest - widens toward the shoulders
    B.limb(v(0, 1.190, 0.0), v(0, 1.462, -0.004),
      [[0, 0.160 * bulk], [0.45, 0.180 * bulk], [0.85, 0.176 * bulk], [1, 0.140]],
      opt(cloth, { sx: 1, sz: 0.72, bones: ['spine', 'chest'], color: look.shirt, radial: 12, rings: 6, cap0: 0.1, cap1: 0.35 }));
    // Trapezius / shoulder yoke - this is the line that says "human male". The
    // measured shoulder span was only 2.2-2.5 head-widths where a militiaman in
    // a plate carrier should be ~3.0, because the trapezius and the deltoid
    // formed ONE continuous slope from neck to arm with no corner in it. The
    // acromion blob below breaks that curve into a corner, and a broken
    // shoulder line is what reads as "adult male" in silhouette at 30 m.
    B.blob(v(0.124, 1.430, -0.004), 0.108, 0.062, 0.092,
      { radial: 9, rings: 6, bones: ['chest', 'clavL', 'armL'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.4 });
    B.blob(v(-0.124, 1.430, -0.004), 0.108, 0.062, 0.092,
      { radial: 9, rings: 6, bones: ['chest', 'clavR', 'armR'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.4 });
    // acromion: a small hard-edged corner at the very end of the shoulder line
    B.box(v(0.190, 1.432, -0.004), 0.052, 0.044, 0.086,
      { bevel: 0.014, bones: ['clavL', 'armL', 'chest'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.35, value: 1.05 });
    B.box(v(-0.190, 1.432, -0.004), 0.052, 0.044, 0.086,
      { bevel: 0.014, bones: ['clavR', 'armR', 'chest'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.35, value: 1.05 });
    // an open overshirt hanging off the shoulders - a second silhouette axis,
    // so a squad is not four identical torso outlines
    if (look.openShirt) {
      for (s = 0; s < 2; s++) {
        sgn = s === 0 ? 1 : -1;
        side = s === 0 ? 'L' : 'R';
        B.box(v(sgn * 0.112, 1.244, 0.030), 0.070, 0.310, 0.190, {
          bevel: 0.024, euler: new THREE.Euler(0, 0, sgn * 0.10),
          bones: ['chest', 'spine', 'clav' + side], color: look.shirt,
          r: 0.92, k: K.CLOTH, dust: 0.5, value: 1.22
        });
        B.blob(v(sgn * 0.148, 1.420, -0.006), 0.062, 0.052, 0.086, {
          radial: 8, rings: 5, bones: ['chest', 'clav' + side, 'arm' + side],
          color: look.shirt, r: 0.92, k: K.CLOTH, dust: 0.4, value: 1.22
        });
      }
    }

    // ---- neck and head -----------------------------------------------------
    // The face is TEXTURED, not vertex-shaded: see the FACE ATLAS block. Every
    // skin part of the head carries face:true, which moves it into its own
    // geometry group, gives it a cylindrical UV and binds it to the atlas
    // material. makeFaceShade() survives only as the fallback for an
    // environment with no 2D canvas, where it is better than a blank egg.
    var hasAtlas = look.faceSlot !== undefined && look.faceSlot >= 0;
    var faceShade = hasAtlas ? null : makeFaceShade(look);
    var neckO = { color: look.skin, r: 0.60, m: 0, k: K.SKIN, dust: 0.05 };
    // The map can only darken, so the head's vertex colour carries the headroom
    // and the atlas's neutral value hands it straight back.
    var headO = { color: look.skin, r: 0.60, m: 0, k: K.SKIN, dust: 0.05 };
    if (hasAtlas) { headO.face = true; headO.value = FACE_HEADROOM; }
    else headO.tint = faceShade;
    function skin(extra) {
      var o = {}, kk;
      for (kk in headO) o[kk] = headO[kk];
      for (kk in extra) o[kk] = extra[kk];
      return o;
    }
    function neck(extra) {
      var o = {}, kk;
      for (kk in neckO) o[kk] = neckO[kk];
      for (kk in extra) o[kk] = extra[kk];
      return o;
    }
    // neck: tapers hard into the jaw, and a trapezius wedge stops the head
    // sitting on the collar like a ball on a post. Its top comes down 16 mm
    // with the longer skull, so the mandible sits OVER the neck instead of the
    // two competing for the same 20 mm of throat.
    B.limb(v(0, 1.424, -0.014), v(0, 1.566, 0.0), [[0, 0.064], [0.55, 0.058], [1, 0.046]],
      neck({ sx: 1, sz: 0.92, bones: ['neck', 'chest', 'head'], r: 0.62, dust: 0.1, radial: 9, rings: 4, cap0: 0.1, cap1: 0.1 }));
    B.blob(v(0.052, 1.448, -0.020), 0.062, 0.036, 0.058,
      { radial: 8, rings: 5, bones: ['chest', 'neck', 'clavL'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.3 });
    B.blob(v(-0.052, 1.448, -0.020), 0.062, 0.036, 0.058,
      { radial: 8, rings: 5, bones: ['chest', 'neck', 'clavR'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.3 });
    // Head proportions. Round 2 measured chin 1.562 to crown 1.742 - 180 mm of
    // height against 158 mm of width, a ratio of 0.88 where a human skull is
    // 0.65. It was geometrically a BALL, and no amount of surface detail stops
    // a ball reading as a ball; that, not the missing features, is why the head
    // still read adolescent. 50 mm goes on vertically and 12 mm comes off the
    // width: 1.776 - 1.546 = 230 mm tall at 148 mm wide, ratio 0.64.
    // A human skull is widest at the PARIETAL eminence, just above the ears,
    // and is flat across the top - so it stays two masses, a wide low vault
    // and a shallow crown cap, both taller than they were.
    B.blob(v(0, 1.674, -0.010), 0.074, 0.068, 0.086,
      skin({ radial: 16, rings: 11, bones: ['head'], r: 0.58 }));
    B.blob(v(0, 1.712, -0.010), 0.062, 0.064, 0.072,
      skin({ radial: 14, rings: 9, bones: ['head'], r: 0.58 }));
    // occipital mass at the back - a real head is deeper than it is wide
    B.blob(v(0, 1.648, -0.048), 0.066, 0.062, 0.058,
      skin({ radial: 12, rings: 8, bones: ['head'], r: 0.58 }));
    // Forehead plane. It used to be a 100 mm-tall ellipsoid that ran almost
    // CONCENTRIC with the hat crown above it - same curvature, 1 mm of
    // clearance - so the two surfaces stayed within a millimetre of each other
    // for 25 mm of height and the skull emerged from under the hat as a long,
    // near-tangential sliver. That sliver faces the sky, so it rendered as a
    // bright NEUTRAL 2 px line ruled straight across the forehead (measured
    // 110/106/106 against 113/78/56 skin either side). Flattened to a 64 mm
    // ellipsoid, it now crosses the hat decisively: 7 mm proud at y 1.690,
    // 4 mm buried at 1.700.
    B.blob(v(0, 1.680, 0.040), 0.064, 0.032, 0.054,
      skin({ radial: 13, rings: 8, bones: ['head'], r: 0.58 }));
    // face mass / jaw - narrower, longer and pushed forward
    B.blob(v(0, 1.612, 0.022), 0.064, 0.070, 0.078,
      skin({ radial: 14, rings: 11, bones: ['head'], r: 0.58 }));
    // Cheekbone and mandible structure is PAINTED, not modelled: blobs standing
    // proud of the cheek turned the head into a frog. Only features that break
    // the silhouette are geometry.
    // Chin. Widened and pulled back 5 mm: at 27 x 26 x 25 mm standing 16 mm off
    // the jaw ellipsoid it read as a golf ball glued to the face once the
    // mentolabial crease under it was deepened. A male chin is WIDE and only
    // moderately prominent.
    B.blob(v(0, 1.5745, 0.0740), 0.0310, 0.0250, 0.0215,
      skin({ radial: 9, rings: 6, bones: ['head'] }));                    // chin
    // Brow ridge: two curved supraorbital blobs following the cranium, so there
    // is no flat face and no plane highlight. The atlas paints the hair; the
    // geometry only has to carry the overhang that shadows the eye. Pushed out
    // 2.5 mm so the ridge genuinely stands in front of the eyeball and casts on
    // it in a raking sun - but no further, because the hat band sits at exactly
    // this height and a brow through a cap brim is worse than a shallow one.
    B.blob(v(0.029, 1.6685, 0.0705), 0.032, 0.0135, 0.027,
      skin({ radial: 9, rings: 5, bones: ['head'], r: 0.60,
        euler: new THREE.Euler(0, 0.24, 0.10) }));
    B.blob(v(-0.029, 1.6685, 0.0705), 0.032, 0.0135, 0.027,
      skin({ radial: 9, rings: 5, bones: ['head'], r: 0.60,
        euler: new THREE.Euler(0, -0.24, -0.10) }));

    // ---- ZYGOMATIC ARCH ----------------------------------------------------
    // The cheekbone is a RIDGE running front-to-back from the outer eye socket
    // to the ear, and it is the single landmark that separates an adult male
    // skull from an egg. An earlier round modelled it as a pad on the FRONT of
    // the cheek and turned the head into a frog; that failure was the placement,
    // not the feature. Bizygomatic width comes out at ~137 mm against a 148 mm
    // parietal, which is the correct anthropometric relationship.
    // It is built as ONE lathe tube per side, not as a row of spheres. Four
    // blobs on a 21 mm pitch with a 14 mm radius barely touch, and the union
    // rendered as a string of separate beads stuck to the cheek - the same
    // failure the beard shell hit and for the same reason. A tube has no seams
    // to read.
    for (s = 0; s < 2; s++) {
      sgn = s === 0 ? 1 : -1;
      B.limb(v(sgn * 0.0428, 1.6438, 0.0570), v(sgn * 0.0578, 1.6505, -0.0120),
        [[0, 0.0084], [0.30, 0.0106], [0.75, 0.0102], [1, 0.0078]],
        skin({ radial: 8, rings: 5, bones: ['head'], r: 0.58, cap0: 0.9, cap1: 0.9 }));
    }
    // ---- MANDIBLE ----------------------------------------------------------
    // A jaw that curves smoothly from chin to ear is a child's. The corner at
    // the gonion and the vertical ramus climbing to the ear are what put an
    // angle in the silhouette; both are kept shallow (3-5 mm proud) so the jaw
    // gains a corner without gaining width, and both are tubes for the same
    // reason the arch is.
    for (s = 0; s < 2; s++) {
      sgn = s === 0 ? 1 : -1;
      B.limb(v(sgn * 0.0300, 1.5735, 0.0480), v(sgn * 0.0498, 1.5872, -0.0090),
        [[0, 0.0098], [0.55, 0.0122], [1, 0.0128]],
        skin({ radial: 8, rings: 5, bones: ['head'], r: 0.58, cap0: 0.9, cap1: 0.6 }));
      B.limb(v(sgn * 0.0498, 1.5872, -0.0095), v(sgn * 0.0540, 1.6215, -0.0135),
        [[0, 0.0126], [1, 0.0098]],
        skin({ radial: 8, rings: 4, bones: ['head'], r: 0.58, cap0: 0.4, cap1: 0.8 }));
    }
    B.blob(v(0, 1.658, 0.076), 0.014, 0.012, 0.020,
      skin({ radial: 7, rings: 5, bones: ['head'], r: 0.60 }));           // glabella
    // Nose. It projected 10 mm past the cheek plane, which at 3 m is no
    // projection at all: the middle of the face rendered as one continuous
    // curve with a painted shadow drawn on it. A male nose stands ~18 mm proud
    // and it is the only feature that throws a hard cast shadow in a raking
    // sun - which is most of what tells the eye a head is a head.
    B.blob(v(0, 1.6425, 0.0875), 0.0125, 0.0265, 0.0225,
      skin({ radial: 8, rings: 6, bones: ['head'], r: 0.55 }));           // dorsum
    B.blob(v(0, 1.6285, 0.0935), 0.0135, 0.0130, 0.0215,
      skin({ radial: 8, rings: 6, bones: ['head'], r: 0.55 }));           // mid dorsum
    B.blob(v(0, 1.6195, 0.0975), 0.0165, 0.0150, 0.0195,
      skin({ radial: 9, rings: 7, bones: ['head'], r: 0.55 }));           // tip
    // alae: the flare that makes the underside of the nose a shape rather than
    // a smooth cone, and what the painted nostrils sit between
    B.blob(v(0.0155, 1.6135, 0.0885), 0.0092, 0.0088, 0.0118,
      skin({ radial: 7, rings: 5, bones: ['head'], r: 0.56 }));
    B.blob(v(-0.0155, 1.6135, 0.0885), 0.0092, 0.0088, 0.0118,
      skin({ radial: 7, rings: 5, bones: ['head'], r: 0.56 }));
    // Eyeballs, brows and lips are now VALUE-NEUTRAL geometry. Painting them a
    // second time in the vertex colour on top of an atlas that already has an
    // iris, a lash line and a lip line would double every one of them; all
    // these blobs have to do is carry the bulge and the crease.
    B.blob(v(0.029, 1.6485, 0.0765), 0.014, 0.011, 0.014,
      skin({ radial: 7, rings: 5, bones: ['head'], r: 0.34,
        value: hasAtlas ? 1.0 : 0.46 }));
    B.blob(v(-0.029, 1.6485, 0.0765), 0.014, 0.011, 0.014,
      skin({ radial: 7, rings: 5, bones: ['head'], r: 0.34,
        value: hasAtlas ? 1.0 : 0.46 }));
    B.blob(v(0.030, 1.6655, 0.0745), 0.026, 0.007, 0.014,
      skin({ radial: 7, rings: 4, bones: ['head'], r: 0.82,
        k: hasAtlas ? K.SKIN : K.HAIR, value: hasAtlas ? 1.0 : 0.42 }));
    B.blob(v(-0.030, 1.6655, 0.0745), 0.026, 0.007, 0.014,
      skin({ radial: 7, rings: 4, bones: ['head'], r: 0.82,
        k: hasAtlas ? K.SKIN : K.HAIR, value: hasAtlas ? 1.0 : 0.42 }));
    B.blob(v(0, 1.5935, 0.0885), 0.021, 0.006, 0.010,
      skin({ radial: 7, rings: 3, bones: ['head'], r: 0.52,
        value: hasAtlas ? 1.0 : 0.55 }));                                 // lips
    // Ears. A shemagh is wrapped over them; leaving them out from under the
    // wrap gave the man two tan points sticking out at eye level that read as
    // elf ears in the closeup. Tucked in and shortened for any wrapped head.
    // A single squashed ellipsoid per side is a lump, and a lump at eye level
    // reads as an injury rather than as an ear. Four masses give it the two
    // things an ear is recognised by at 3 m: a raised helix rim running round
    // the back edge, and a lobe hanging off the bottom.
    var earX = look.hat === 'shemagh' ? 0.065 : 0.072;
    var earY = look.hat === 'shemagh' ? 0.021 : 0.028;
    for (s = 0; s < 2; s++) {
      sgn = s === 0 ? 1 : -1;
      B.blob(v(sgn * earX, 1.6565, -0.008), 0.0105, earY, 0.019,
        skin({ radial: 7, rings: 6, bones: ['head'], r: 0.58 }));          // concha plate
      B.blob(v(sgn * (earX + 0.0038), 1.6620, -0.0150), 0.0062, earY * 0.66, 0.0078,
        skin({ radial: 6, rings: 5, bones: ['head'], r: 0.60 }));          // helix, rear
      B.blob(v(sgn * (earX + 0.0032), 1.6655, 0.0010), 0.0058, 0.0092, 0.0074,
        skin({ radial: 6, rings: 4, bones: ['head'], r: 0.60 }));          // helix, top
      B.blob(v(sgn * (earX - 0.0012), 1.6370, -0.0035), 0.0078, 0.0086, 0.0102,
        skin({ radial: 6, rings: 5, bones: ['head'], r: 0.58 }));          // lobe
      B.blob(v(sgn * (earX - 0.0060), 1.6520, 0.0105), 0.0052, 0.0072, 0.0058,
        skin({ radial: 5, rings: 4, bones: ['head'], r: 0.58 }));          // tragus
    }
    // Facial hair. The old beard was a solid 140 x 92 x 140 mm ellipsoid
    // booleaned into the skull - a second head-sized MASS, not a shell - whose
    // front face reached z = 0.088 while the chin blob reached z = 0.102. The
    // chin therefore punched straight back out through it, which is exactly
    // what the capture showed: a hard-edged band across the mouth with a bare
    // skin island under it, reading as tape or a wound.
    //
    // It is a shell now: nine small blobs swept along the mandible arc from the
    // point of the chin to just in front of the ear, standing ~8 mm proud of
    // the skin the whole way, plus a dedicated chin patch that fully COVERS the
    // chin blob instead of being overrun by it.
    if (look.beard && !(look.hat === 'shemagh' && look.mask)) {
      var hairO = function (vv, rad, rings) {
        return {
          radial: rad || 8, rings: rings || 6, bones: ['head'],
          color: look.beardColor, r: 0.86, k: K.HAIR, dust: 0.03, value: vv
        };
      };
      // Chin FIRST, and placed against the chin blob rather than against the
      // face mass: the chin stands 25 mm proud of the jaw ellipsoid, so
      // anything fitted to the ellipsoid is guaranteed to be punched through.
      B.blob(v(0, 1.5715, 0.093), 0.030, 0.026, 0.019, hairO(1.0, 9, 6));
      B.blob(v(0, 1.5845, 0.090), 0.026, 0.019, 0.019, hairO(0.94, 8, 5));
      // Mandible arc: [angle about the head axis, height, radius]. Two rows -
      // the jaw line and the cheek line - each blob dropped onto the face
      // ellipsoid at 90% radius so the union stands ~12 mm proud of the skin
      // and follows it, instead of being a second solid head.
      // [aStart, aEnd, count, yStart, yEnd, radius]. The spheres have to overlap
      // HEAVILY - 8 mm of spacing against a 19 mm radius - or the union reads
      // as a string of separate balls strapped to the jaw rather than as one
      // mass of hair.
      var BEARD_ROWS = [
        [0.16, 1.28, 11, 1.562, 1.622, 0.0195],
        [0.50, 1.34, 8, 1.592, 1.634, 0.0172]
      ];
      var br2, bd, bt, ba, by, brd, bq, bf, bcx, bcz;
      for (br2 = 0; br2 < BEARD_ROWS.length; br2++) {
        var rw = BEARD_ROWS[br2];
        for (bd = 0; bd < rw[2]; bd++) {
          bt = bd / (rw[2] - 1);
          ba = M.lerp(rw[0], rw[1], bt);
          by = M.lerp(rw[3], rw[4], bt);
          brd = rw[5];
          bq = (by - 1.612) / 0.070;
          bf = 1 - bq * bq;
          bf = bf > 0.05 ? Math.sqrt(bf) : 0.22;
          bcx = 0.064 * bf * Math.sin(ba) * 0.93;
          bcz = 0.022 + 0.078 * bf * Math.cos(ba) * 0.93;
          // Value spread kept narrow: at +/-11% every blob reads as its own
          // ball instead of as tonal variation inside one mass.
          B.blob(v(bcx, by, bcz), brd, brd * 1.05, brd,
            hairO(0.95 + 0.06 * Math.abs(Math.sin(ba * 5.3 + br2)), 10, 7));
          B.blob(v(-bcx, by, bcz), brd, brd * 1.05, brd,
            hairO(0.95 + 0.06 * Math.abs(Math.sin(ba * 4.1 + 1.1 - br2)), 10, 7));
        }
      }
      if (look.moustache) {
        // The old one sat at z 0.089-0.100, behind a nose tip at z 0.110, so it
        // was buried and never showed at all.
        B.blob(v(0, 1.6045, 0.100), 0.027, 0.0075, 0.012, hairO(0.98, 9, 5));
        B.blob(v(0, 1.6005, 0.096), 0.021, 0.0060, 0.011, hairO(0.92, 8, 4));
      }
    }

    buildHeadwear(B, rng, look);

    // ---- arms --------------------------------------------------------------
    for (s = 0; s < 2; s++) {
      sgn = s === 0 ? 1 : -1;
      side = s === 0 ? 'L' : 'R';
      // deltoid - pushed out to +/-190 mm so the shoulder line clears the
      // trapezius instead of merging into it
      B.blob(v(sgn * 0.188, 1.406, -0.004), 0.074, 0.082, 0.074,
        { radial: 9, rings: 6, bones: ['arm' + side, 'clav' + side, 'chest'], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.3 });
      // Upper arm. The old profile tapered 0.058 -> 0.052 -> 0.042 straight
      // into the forearm with no bicep swell and no elbow, so the limb read as
      // one continuous smooth hose from deltoid to wrist and the eye had no
      // landmark to divide it at the halfway point - which is precisely the
      // "arms read long" complaint. Real limb lengths were always fine; it was
      // the missing joint. Mass sits high now, so the taper INTO the elbow is
      // visible as a taper.
      B.limb(v(sgn * 0.180, 1.418, -0.004), v(sgn * 0.222, 1.145, 0.012),
        [[0, 0.058 * bulk], [0.30, 0.066 * bulk], [0.72, 0.048 * bulk], [1, 0.042]],
        { sx: 1, sz: 0.95, bones: ['arm' + side, 'fore' + side, 'clav' + side], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.3, radial: 9, rings: 6, cap0: 0.2, cap1: 0.2 });
      // Sleeve seam below the deltoid. On the long-sleeved variants the arm was
      // one unbroken 540 mm tube of shirt from the trapezius to the glove cuff,
      // and an unbroken tube has no scale - which is the whole of the "arms read
      // long" complaint. The bone lengths measure correct (288 mm humerus,
      // 258 mm forearm, 672 mm shoulder to fingertip on a 1.8 m man); what was
      // missing was a landmark at the top third. 2.5 mm proud, so it is a seam
      // and not a bracelet.
      B.band(1.312, 0.0592, 0.026, {
        cx: sgn * 0.1966, cz: -0.001, radial: 11, thick: 0.0072,
        bones: ['arm' + side, 'clav' + side], color: look.shirt,
        r: 0.92, k: K.CLOTH, dust: 0.3, value: 1.10
      });
      // olecranon: the corner that says "elbow"
      B.blob(v(sgn * 0.222, 1.148, -0.008), 0.048, 0.046, 0.052,
        { radial: 8, rings: 6, bones: ['fore' + side, 'arm' + side], color: look.shirt, r: 0.90, k: K.CLOTH, dust: 0.35, value: 1.12 });
      // forearm - bare if the sleeves are rolled
      var fc = look.sleeves ? look.skin : look.shirt;
      var fk = look.sleeves ? K.SKIN : K.CLOTH;
      // The forearm deliberately does NOT list hand<side>. With the wrist
      // carrying the whole weapon orientation, any hand weight on the distal
      // forearm shears it into a candy-wrapper; the cuff in buildHand is the
      // only thing that spans the joint, and it is built to hide exactly that.
      B.limb(v(sgn * 0.222, 1.148, 0.012), v(sgn * 0.250, 0.892, 0.028),
        [[0, 0.046], [0.25, 0.048], [1, 0.036]],
        { sx: 1, sz: 0.92, bones: ['fore' + side, 'arm' + side], color: fc, r: look.sleeves ? 0.62 : 0.90, k: fk, dust: 0.4, radial: 9, rings: 5, cap0: 0.15, cap1: 0.1 });
      if (look.sleeves) {
        B.band(1.160, 0.050, 0.048, { cx: sgn * 0.222, cz: 0.012, radial: 9, thick: 0.010, bones: ['fore' + side, 'arm' + side], color: look.shirt, r: 0.92, k: K.CLOTH, dust: 0.3 });
      }
      buildHand(B, sgn, side, look);
    }

    buildChestRig(B, rng, look);
    buildCarbine(B, rng);

    return B.finish();
  }

  // A GRIPPING hand, not a paddle. The old hand was a 36 mm slab plus one cube
  // for all four fingers - narrower than the 64 mm forearm it terminated - so
  // every arm tapered to a rounded stump and the rifle floated, held by nothing.
  //
  // Built in bind space, where the hand hangs at the hip with the palm facing
  // medially. Both hands wrap a vertical column (the pistol grip for the right,
  // the handguard for the left), so the four fingers stack along Y and each one
  // sweeps forward and then inward around the front of that column.
  //
  // Every part of the hand proper is weighted to ONE bone - hand<side> - and
  // nothing else. That is not a tidiness preference, it is the fix for the
  // missing right hand: buildCarbine skins the rifle 100% to handR while the
  // palm used to carry a ~40% foreR weight, and the animation layer then
  // overwrites handR's local rotation with the entire weapon orientation, a
  // >90 degree wrist twist. Linear blend skinning candy-wrappered the palm into
  // the wrist axis until it vanished inside the forearm cap, while the rigid
  // carbine swung free 40 mm away - the "floating white rectangle beside him".
  // With hand and weapon sharing one rigid transform they can never separate by
  // construction, and _buildMesh asserts that they still do not.
  function buildHand(B, sgn, side, look) {
    var bones = ['hand' + side];
    var g = { color: look.glove, r: 0.74, m: 0, k: K.LEATHER, dust: 0.25, bones: bones };
    function o(extra) {
      var out = {}, kk;
      for (kk in g) out[kk] = g[kk];
      for (kk in extra) out[kk] = extra[kk];
      return out;
    }
    var x = sgn * 0.252;
    // The cuff is the ONE part that blends fore->hand. It is the gauntlet, it
    // straddles the joint, and it is what hides the shear the wrist rotation
    // puts into the distal forearm.
    //
    // It also has to SWALLOW the forearm's distal cap. At 42 x 62 mm against a
    // forearm that ends at y 0.892 with r 36 mm, the bare skin of a rolled
    // sleeve terminated in a bright rounded cap with a hard specular rim - a
    // 6:1 value step across one pixel at the wrist - and THAT bright cap, not
    // the glove below it, is what the eye read as the hand. Hence "mitten".
    // 54 x 112 mm puts the skin-to-glove transition on a cylinder.
    B.band(0.906, 0.054, 0.112, {
      cx: sgn * 0.248, cz: 0.026, radial: 11, thick: 0.012,
      bones: ['hand' + side, 'fore' + side],
      color: look.glove, r: 0.80, k: K.LEATHER, dust: 0.25, value: 0.90
    });
    // knurled cuff strap, so the gauntlet is not one smooth tube
    B.band(0.944, 0.058, 0.020, {
      cx: sgn * 0.248, cz: 0.024, radial: 11, thick: 0.007,
      bones: ['fore' + side, 'hand' + side],
      color: look.nylon, r: 0.88, k: K.WEBBING, dust: 0.25, value: 1.10
    });
    // palm: thin across (x), tall (y), broad front-to-back (z)
    B.box(v(x + sgn * 0.004, 0.848, 0.040), 0.038, 0.084, 0.078, o({ bevel: 0.014 }));
    // knuckle ridge
    B.blob(v(x, 0.812, 0.056), 0.020, 0.016, 0.038, o({ radial: 7, rings: 4, value: 1.12 }));
    // heel of the hand
    B.blob(v(x + sgn * 0.006, 0.870, 0.014), 0.019, 0.026, 0.028, o({ radial: 7, rings: 4 }));
    // Knuckle guard: the moulded panel across the back of a tactical glove. One
    // hard-edged rectangle on the outboard face is the cheapest possible cue
    // that this is a GLOVE and not a fist-shaped lump, and unlike the fingers
    // it survives being in shadow because it is a silhouette step, not a tonal
    // one.
    B.box(v(x + sgn * 0.0215, 0.8330, 0.0475), 0.011, 0.052, 0.062,
      o({ bevel: 0.005, color: look.nylon, r: 0.62, k: K.RUBBER, value: 1.08 }));
    B.box(v(x + sgn * 0.0225, 0.8690, 0.0300), 0.010, 0.018, 0.048,
      o({ bevel: 0.004, color: look.nylon, r: 0.70, k: K.WEBBING, value: 0.86 }));

    // ---- FINGERS -----------------------------------------------------------
    // Four fingers were already modelled and still read as one mitten, because
    // at 21 mm diameter on a 19 mm pitch adjacent tubes INTERSECT: the union is
    // a single slab with a wavy edge, and no amount of per-tube value grading
    // recovers a boundary that is not there. 20 mm on a 21.5 mm pitch leaves a
    // real 1.5 mm gulley between neighbours, and each finger now carries three
    // segments with a knuckle at every joint so the top edge is scalloped
    // instead of smooth.
    var i, fy, fr;
    for (i = 0; i < 4; i++) {
      fy = 0.8235 - i * 0.0215;
      fr = 0.0100 - i * 0.0008;
      // proximal - runs forward off the knuckle
      B.limb(v(x + sgn * 0.002, fy, 0.004), v(x, fy - 0.003, 0.046),
        [[0, fr], [0.6, fr * 0.95], [1, fr * 0.88]],
        o({ radial: 7, rings: 2, cap0: 0.5, cap1: 0.15, value: 1.36 - i * 0.055 }));
      // knuckle over the proximal joint: a bump on the top surface, which is
      // what breaks the tube into a finger
      B.blob(v(x + sgn * 0.0015, fy + 0.0038, 0.0115), fr * 0.92, fr * 0.66, fr * 1.15,
        o({ radial: 6, rings: 4, value: 1.36 - i * 0.05 }));
      // middle - curls inward around the front of the grip
      B.limb(v(x, fy - 0.003, 0.044), v(x - sgn * 0.0135, fy - 0.0075, 0.0665),
        [[0, fr * 0.90], [1, fr * 0.78]],
        o({ radial: 7, rings: 1, cap0: 0.2, cap1: 0.2, value: 1.10 - i * 0.04 }));
      B.blob(v(x - sgn * 0.0060, fy - 0.0042, 0.0555), fr * 0.80, fr * 0.60, fr * 0.86,
        o({ radial: 6, rings: 4, value: 1.20 - i * 0.04 }));            // mid knuckle
      // distal - the tip, closing on the palm
      B.limb(v(x - sgn * 0.0130, fy - 0.0074, 0.0655), v(x - sgn * 0.0225, fy - 0.0112, 0.0765),
        [[0, fr * 0.76], [1, fr * 0.60]],
        o({ radial: 6, rings: 1, cap0: 0.2, cap1: 0.95, value: 0.96 - i * 0.03 }));
      // The gulley between adjacent fingers. Narrow in y and DARK - it is the
      // shadow line that the eye actually counts fingers by.
      if (i < 3) {
        B.blob(v(x + sgn * 0.0010, fy - 0.0107, 0.028), 0.0165, 0.0030, 0.027,
          o({ radial: 6, rings: 4, value: 0.46 }));
        B.blob(v(x - sgn * 0.0055, fy - 0.0130, 0.058), 0.0125, 0.0026, 0.014,
          o({ radial: 5, rings: 3, value: 0.50 }));
      }
    }
    // ---- THUMB -------------------------------------------------------------
    // The thumb had no base. A 14 mm rod leaving a flat palm is a spur; what
    // makes a thumb read is the thenar eminence - the fist-sized muscle pad at
    // its root - and the fact that it is visibly THICKER than any finger.
    B.blob(v(x - sgn * 0.0035, 0.8665, 0.0305), 0.0175, 0.0225, 0.0250,
      o({ radial: 8, rings: 6, value: 1.06 }));                          // thenar pad
    B.limb(v(x - sgn * 0.0055, 0.8720, 0.0175), v(x - sgn * 0.0155, 0.8490, 0.0555),
      [[0, 0.0152], [0.55, 0.0146], [1, 0.0132]],
      o({ radial: 7, rings: 2, cap0: 0.45, cap1: 0.2, value: 1.22 }));
    B.blob(v(x - sgn * 0.0150, 0.8500, 0.0530), 0.0122, 0.0098, 0.0122,
      o({ radial: 6, rings: 4, value: 1.32 }));                          // thumb knuckle
    B.limb(v(x - sgn * 0.0150, 0.8480, 0.0525), v(x - sgn * 0.0080, 0.8305, 0.0790),
      [[0, 0.0126], [1, 0.0098]],
      o({ radial: 6, rings: 1, cap0: 0.2, cap1: 0.95, value: 1.04 }));
    // the crease between the thumb web and the index finger
    B.blob(v(x - sgn * 0.0025, 0.8380, 0.0300), 0.0130, 0.0034, 0.0175,
      o({ radial: 6, rings: 4, value: 0.58 }));
  }

  function buildHeadwear(B, rng, look) {
    var hc = look.hatColor;
    // Nobody wears a hat perfectly level. A per-man tilt about the head pivot
    // is one of the cheapest ways to stop four spawned militia reading as four
    // copies of the same man.
    // mostly yaw - the crown is near-symmetric about Y so a yaw never lifts it
    // off the skull, whereas roll exposes bare scalp through the hat
    B.xform(new THREE.Euler(look.hatTilt * 0.5, look.hatTilt * 1.6, look.hatTilt * 0.35),
      v(0, 1.655, 0));
    buildHeadwearParts(B, rng, look, hc);
    B.xform(null);
  }

  function buildHeadwearParts(B, rng, look, hc) {
    if (look.hat === 'shemagh') {
      // A shemagh reads by its WRAP, not by its check. The old head was a
      // single 180 mm crown blob at radial 12 carrying a 26 cycles/m
      // checkerboard: 38 mm cells sampled at 47 mm vertex spacing, so the
      // pattern aliased into a flat pale grey and the man rendered with a
      // smooth lavender swim cap on his head. Layered, offset wrap turns with
      // per-turn value jitter, a knot, and a tail that actually reaches the
      // shoulder - that is what says "wrapped cloth" at 3.5 m and at 30 m.
      // The vertex-colour pattern is now a coarse directional stripe whose
      // period (~140 mm) the vertex spacing can genuinely carry.
      var stripe = function (x, y, z, c) {
        var s1 = Math.sin((x * 0.60 + y * 1.90 + z * 0.55) * 46.0);
        var s2 = Math.sin((x * 1.70 - z * 1.35) * 23.0);
        c.multiplyScalar(1 + 0.17 * s1 + 0.11 * s2);
        return c;
      };
      var scarfO = function (extra) {
        var o = {
          bones: ['head'], color: look.scarf, tint: stripe,
          r: 0.94, k: K.CLOTH, dust: 0.6
        }, kk;
        for (kk in extra) o[kk] = extra[kk];
        return o;
      };
      // crown, then a second turn pulled off-centre so one side carries a
      // visible layered edge instead of a perfect dome. Raised 24 mm and
      // narrowed with the taller, narrower skull - at the old height the new
      // crown at y 1.776 punched straight out through the top of the wrap.
      B.blob(v(0, 1.706, -0.006), 0.084, 0.090, 0.092,
        scarfO({ radial: 18, rings: 13 }));
      B.blob(v(0.012, 1.698, -0.016), 0.081, 0.080, 0.087,
        scarfO({ radial: 16, rings: 11, value: 0.86 }));
      // A wrap turn CANNOT be a full lathe ring at eye height. bandGeo's outer
      // radius (r + 1.2*thick, then scaled in z) put the old 1.652 ring's front
      // face at z = 0.099 while the face surface at that height is at 0.092 -
      // so the "headband" passed 7 mm in FRONT of the eyes and rendered as a
      // blindfold straight across the face. That single ring, not the socket
      // bake, is what made every shemagh-wearing militiaman look like he was in
      // sunglasses. The only ring left sits ABOVE the brow where a real
      // headband sits; the bulk of the wrap is behind and beside the ears,
      // built from masses that cannot reach the face at all.
      B.band(1.734, 0.078, 0.034, scarfO({ cz: -0.026, radial: 18, thick: 0.013, sz: 1.02, value: 1.10 }));
      B.blob(v(0, 1.658, -0.054), 0.082, 0.076, 0.068,
        scarfO({ radial: 14, rings: 9, value: 0.94 }));
      // flattened against the skull and set back behind the cheekbone, or the
      // side turns bulge forward at ear level and read as headphones
      B.blob(v(0.072, 1.656, -0.030), 0.018, 0.066, 0.070,
        scarfO({ radial: 9, rings: 8, value: 1.04 }));
      B.blob(v(-0.072, 1.656, -0.030), 0.018, 0.066, 0.070,
        scarfO({ radial: 9, rings: 8, value: 1.04 }));
      // the knot, low and behind the ear
      B.blob(v(0.066, 1.608, -0.034), 0.028, 0.026, 0.032,
        scarfO({ radial: 8, rings: 6, value: 1.12 }));
      // tail falling onto the shoulder, in two overlapping panels
      B.box(v(0.054, 1.562, -0.070), 0.118, 0.152, 0.062,
        scarfO({ bevel: 0.020, euler: new THREE.Euler(0.22, 0.15, 0.12), bones: ['head', 'neck'], dust: 0.7, value: 0.94 }));
      B.box(v(0.078, 1.498, -0.048), 0.078, 0.128, 0.050,
        scarfO({ bevel: 0.018, euler: new THREE.Euler(0.14, 0.24, 0.26), bones: ['neck', 'chest'], dust: 0.8, value: 0.82 }));
      if (look.mask) {
        // A face mask has to COVER the nose and mouth. The old single blob at
        // z 0.026 + rz 0.078 reached z = 0.104 while the face surface at that
        // height is at 0.099 and the nose tip is at 0.110, so it emerged as a
        // 15 mm grey BAND across the mouth with bare chin below it and the nose
        // punched straight through - the single worst artifact in the hero
        // portrait. Two masses now, both clear of the nose tip.
        B.blob(v(0, 1.584, 0.046), 0.068, 0.052, 0.086,
          scarfO({ radial: 13, rings: 9, dust: 0.4 }));
        B.blob(v(0, 1.620, 0.054), 0.056, 0.030, 0.078,
          scarfO({ radial: 12, rings: 7, dust: 0.4, value: 1.06 }));
      }
    } else if (look.hat === 'boonie') {
      // the crown has to CLEAR the cranium, or the bald skull pokes through the
      // top of the hat - which is exactly what it was doing
      B.blob(v(0, 1.706, -0.002), 0.082, 0.090, 0.090,
        { radial: 13, rings: 8, bones: ['head'], color: hc, r: 0.92, k: K.CLOTH, dust: 0.7 });
      // Brim. 152 mm radius (a real boonie is ~300 mm across, not 408), 28
      // lathe segments so the silhouette is not a visible 16-gon, and the rim
      // height driven by sin(2*theta) so the front and back droop while the
      // sides kick up - a flat plate reads as a sombrero.
      var brim = new THREE.LatheGeometry([
        new THREE.Vector2(0.080, 0.010), new THREE.Vector2(0.112, 0.004),
        new THREE.Vector2(0.144, -0.012), new THREE.Vector2(0.150, -0.022),
        new THREE.Vector2(0.145, -0.026), new THREE.Vector2(0.111, -0.012),
        new THREE.Vector2(0.081, -0.002)
      ], 28);
      var bp = brim.attributes.position;
      for (var bi = 0; bi < bp.count; bi++) {
        var bx = bp.getX(bi), bz = bp.getZ(bi);
        var rr = Math.sqrt(bx * bx + bz * bz);
        var th = Math.atan2(bx, bz);
        var w = M.saturate((rr - 0.080) / 0.070);
        bp.setY(bi, bp.getY(bi) - (0.026 * Math.sin(2 * th + look.brimPhase) + 0.008) * w * w);
      }
      brim.computeVertexNormals();
      // Raised 18 mm: with the taller skull the old brim's drooping front edge
      // landed at y 1.638, BELOW the brow at 1.668, and cut straight across the
      // eyes in the portrait.
      B.add(brim.translate(0, 1.700, -0.002),
        { bones: ['head'], color: hc, r: 0.92, k: K.CLOTH, dust: 0.6, value: 0.94 });
      // Set BACK 24 mm. A lathe ring centred on the head axis has a constant
      // radius, but the forehead blob reaches z = 0.098 while the ring only
      // reaches 0.090, so the forehead punched through it and the band emerged
      // as a 2 px sliver straight across the brow - which then caught a grazing
      // environment reflection and rendered as a bright neutral headband. The
      // band now only ever surfaces behind the temples, where it belongs.
      B.band(1.694, 0.082, 0.030, { cz: -0.024, radial: 14, thick: 0.008, bones: ['head'], color: look.nylon, r: 0.9, k: K.WEBBING, dust: 0.4 });
      // chinstrap, hanging loose under the jaw
      B.band(1.586, 0.076, 0.014, { cz: 0.004, sz: 0.94, radial: 12, thick: 0.005, bones: ['head'], color: look.nylon, r: 0.9, k: K.WEBBING, dust: 0.3 });
    } else if (look.hat === 'cap') {
      B.blob(v(0, 1.706, -0.004), 0.084, 0.090, 0.092,
        { radial: 12, rings: 8, bones: ['head'], color: hc, r: 0.88, k: K.CLOTH, dust: 0.6 });
      // THE cap peak, and the source of the bright ruled line across the brow
      // in the round-3 portrait. A 126 x 16 x 84 mm slab held at -9 degrees
      // presents its 16 mm FRONT FACE almost square-on to a camera at chest
      // height: a horizontal strip of lit cloth exactly the width of the head,
      // 3 px tall, which reads as a white headband and not as a peak. Raked to
      // -22 degrees and thinned, it shows its shaded underside instead, and its
      // tip clears the brow at y 1.685.
      B.box(v(0, 1.712, 0.100), 0.124, 0.012, 0.094,
        { bevel: 0.005, euler: new THREE.Euler(-0.38, 0, 0), bones: ['head'], color: hc, r: 0.90, k: K.CLOTH, dust: 0.5, value: 0.74 });
      // stitched edge binding, so the peak has a line of its own
      B.box(v(0, 1.694, 0.144), 0.118, 0.008, 0.012,
        { bevel: 0.003, euler: new THREE.Euler(-0.38, 0, 0), bones: ['head'], color: look.nylon, r: 0.92, k: K.WEBBING, dust: 0.4, value: 1.10 });
      B.band(1.700, 0.084, 0.024, { cz: -0.026, radial: 12, thick: 0.006, bones: ['head'], color: look.nylon, r: 0.9, k: K.WEBBING, dust: 0.4 });
    } else {
      // Bare head: a cropped cap that clears the cranium at the top and back
      // and sits INSIDE it at the front, so the intersection curve lands where
      // a hairline belongs instead of tearing a jagged patch across the skull.
      B.blob(v(0, 1.710, -0.016), 0.079, 0.082, 0.084,
        { radial: 13, rings: 9, bones: ['head'], color: look.hair, r: 0.78, k: K.HAIR, dust: 0.2 });
      B.blob(v(0, 1.672, -0.048), 0.070, 0.058, 0.052,
        { radial: 11, rings: 7, bones: ['head'], color: look.hair, r: 0.78, k: K.HAIR, dust: 0.2, value: 0.92 });
    }
  }

  // The chest rig is the one piece of kit that says "armed combatant", and it
  // only reads if it is built from THREE materials, not one: pouch bodies in
  // the rig colour, webbing and PALS ladders in near-black nylon, and hardware
  // (buckles, snap studs, the grenade spoon) in bare metal that catches a
  // glint. Two same-coloured, coplanar-lit boxes 65 mm apart produce no value
  // difference at all - which is why it used to read as a beige washboard.
  function buildChestRig(B, rng, look) {
    var i, x;
    var body = { r: 0.88, m: 0.0, k: K.WEBBING, dust: 0.55, color: look.rig };
    var web = { r: 0.92, m: 0.0, k: K.WEBBING, dust: 0.35, color: look.nylon };
    // Hardware at r 0.28 / m 0.85 is a mirror, and a mirror on a flat coplanar
    // plate facing a 14-degree sun is what blew the rig's buckles out. Worn
    // anodised furniture is roughness 0.55-0.65; the shader also holds a hard
    // 0.34 floor on anything flagged METAL and widens the lobe by the pixel's
    // normal variance, so this can no longer clip whatever the geometry does.
    var hard = { r: 0.58, m: 0.85, k: K.METAL, dust: 0.20, color: look.buckle };
    function o(base, extra) {
      var out = {}, kk;
      for (kk in base) out[kk] = base[kk];
      for (kk in extra) out[kk] = extra[kk];
      return out;
    }
    var CHEST = ['chest', 'spine'];
    var HIPS = ['hips', 'spine'];

    // belt - everyone gets one, it breaks the torso from the legs
    B.band(1.010, 0.152, 0.056, { sz: 0.74, radial: 14, thick: 0.014, bones: HIPS, color: 0x241f1a, r: 0.74, m: 0.02, k: K.LEATHER, dust: 0.5 });
    B.box(v(0, 1.010, 0.116), 0.052, 0.048, 0.016, o(hard, { bevel: 0.004, bones: HIPS }));

    if (look.rigStyle === 'none') {
      // no rig at all: just a belt, a canteen and a slung bandolier of nothing.
      // One man in four with no webbing changes the squad's read completely.
      B.box(v(-0.060, 1.040, -0.146), 0.086, 0.110, 0.062,
        o(body, { bevel: 0.016, bones: HIPS, dust: 0.7, value: 0.9 }));
      B.box(v(0.148, 1.052, 0.052), 0.070, 0.096, 0.070,
        o(body, { bevel: 0.016, bones: HIPS, dust: 0.7, value: 1.05 }));
      return;
    }

    if (look.rigStyle === 'bandolier') {
      // a single strap of pouches over one shoulder - a completely different
      // silhouette at 30 m from a plate carrier
      B.box(v(0.030, 1.310, 0.086), 0.076, 0.300, 0.030,
        o(web, { bevel: 0.008, euler: new THREE.Euler(0.10, 0, 0.42), bones: CHEST }));
      B.box(v(0.106, 1.446, -0.030), 0.070, 0.036, 0.160,
        o(web, { bevel: 0.008, bones: ['chest', 'clavL'] }));
      B.box(v(-0.006, 1.300, -0.104), 0.072, 0.280, 0.028,
        o(web, { bevel: 0.008, euler: new THREE.Euler(-0.08, 0, 0.40), bones: CHEST }));
      for (i = 0; i < 3; i++) {
        x = 0.086 - i * 0.052;
        B.box(v(x, 1.372 - i * 0.088, 0.104 + i * 0.010), 0.066, 0.082, 0.050,
          o(body, {
            bevel: 0.012, bones: CHEST, dust: 0.6,
            euler: new THREE.Euler(0, rng.range(-0.10, 0.10) + 0.18, 0.40),
            value: rng.range(0.85, 1.15)
          }));
        B.box(v(x - 0.004, 1.406 - i * 0.088, 0.112 + i * 0.010), 0.062, 0.014, 0.044,
          o(web, { bevel: 0.006, bones: CHEST, euler: new THREE.Euler(0, 0.18, 0.40) }));
      }
      B.box(v(-0.150, 1.048, 0.030), 0.070, 0.086, 0.066,
        o(body, { bevel: 0.016, bones: HIPS, dust: 0.7, value: 0.92 }));
      B.blob(v(0.116, 1.208, 0.116), 0.026, 0.036, 0.026,
        { radial: 7, rings: 5, bones: ['chest'], color: 0x2f3628, r: 0.72, m: 0.25, k: K.METAL, dust: 0.35 });
      return;
    }

    // ---- plate carrier ------------------------------------------------------
    // The front panel used to be a single flat 300 x 280 x 62 mm box at
    // z = 0.118 floating in front of a chest that is 360 mm wide and 260 mm
    // deep: a razor-straight top edge at y 1.432, razor-straight sides at
    // x = +/-0.150 that follow nothing, no wrap around the flanks at all, and
    // the shirt visible outboard of it on both sides. It read as a sheet of
    // olive card taped to his chest, and it is the largest single surface on
    // the character.
    //
    // Five tapered strips fanned around the ribcage instead. Each is yawed to
    // its own tangent so the panel hugs the chest and self-shades across its
    // width, and the strip heights dip at the sternum and rise at the yokes so
    // the top edge is a shaped line rather than a ruler.
    var bk = look.bulk || 1;
    var pcH = [0.292, 0.274, 0.242, 0.274, 0.292];
    var pcZ = function (pa) { return (0.076 + 0.056 * Math.cos(pa)) * (0.72 + 0.28 * bk); };
    var pa, pj;
    for (i = 0; i < 5; i++) {
      pa = (i - 2) * 0.42;
      B.box(v(0.158 * bk * Math.sin(pa), 1.292 + (pcH[i] - 0.276) * 0.5, pcZ(pa)),
        0.074, pcH[i], 0.048,
        o(body, {
          euler: new THREE.Euler(0, -pa, 0), bevel: 0.014, bones: CHEST,
          value: 0.90 + 0.06 * Math.cos(pa)
        }));
    }
    // rear panel
    B.box(v(0, 1.292, -0.116), 0.286, 0.264, 0.052,
      o(body, { bevel: 0.022, bones: CHEST, value: 0.88 }));
    // Cummerbund. Without it the carrier hangs off the FRONT of the man instead
    // of wrapping him, and the flanks show bare shirt between panel and arm.
    B.band(1.150, 0.185, 0.090, o(body, {
      sz: 0.72, radial: 14, thick: 0.016, bones: CHEST, value: 0.86
    }));
    B.band(1.196, 0.188, 0.020, o(web, {
      sz: 0.72, radial: 14, thick: 0.008, bones: CHEST, value: 1.05
    }));
    // PALS ladders. Segmented per strip and yawed with it, so the webbing rides
    // the curve instead of cutting a straight chord across it.
    for (i = 0; i < 3; i++) {
      for (pj = -1; pj <= 1; pj++) {
        pa = pj * 0.42;
        B.box(v(0.158 * bk * Math.sin(pa), 1.206 + i * 0.056, pcZ(pa) + 0.026),
          0.068, 0.011, 0.010,
          o(web, { bevel: 0.002, bones: CHEST, euler: new THREE.Euler(0, -pa, 0) }));
      }
    }
    // shoulder straps and yokes, in nylon rather than pouch fabric
    for (i = 0; i < 2; i++) {
      x = i === 0 ? 0.086 : -0.086;
      B.box(v(x, 1.420, 0.078), 0.062, 0.120, 0.034,
        o(web, { bevel: 0.010, euler: new THREE.Euler(0.42, 0, 0), bones: ['chest', 'clav' + (i === 0 ? 'L' : 'R')] }));
      B.box(v(x * 1.06, 1.452, -0.010), 0.064, 0.032, 0.150,
        o(web, { bevel: 0.010, bones: ['chest', 'clav' + (i === 0 ? 'L' : 'R')] }));
      B.box(v(x, 1.400, -0.100), 0.058, 0.110, 0.028,
        o(web, { bevel: 0.010, euler: new THREE.Euler(-0.35, 0, 0), bones: ['chest'] }));
      // buckle on each strap - a hard specular note against all that cloth
      B.box(v(x, 1.372, 0.098), 0.044, 0.026, 0.014,
        o(hard, { bevel: 0.003, euler: new THREE.Euler(0.42, 0, 0), bones: ['chest'] }));
    }
    // three rifle magazine pouches across the front, each a different value so
    // they read as three pouches and not one moulded lump
    for (i = 0; i < 3; i++) {
      x = (i - 1) * 0.088;
      B.box(v(x, 1.238, 0.166), 0.080, 0.150, 0.058, o(body, {
        bevel: 0.014, euler: new THREE.Euler(rng.range(-0.05, 0.05), rng.range(-0.08, 0.08) + (i - 1) * 0.12, 0),
        bones: CHEST, dust: 0.65, value: rng.range(0.85, 1.15)
      }));
      // flap in nylon, standing proud of the pouch body
      B.box(v(x, 1.306, 0.174), 0.078, 0.030, 0.050, o(web, {
        bevel: 0.008, bones: CHEST
      }));
      // snap stud on the flap
      B.blob(v(x, 1.294, 0.198), 0.007, 0.007, 0.005,
        o(hard, { radial: 6, rings: 4, bones: CHEST }));
    }
    // utility pouches on the hips, canteen at the back
    B.box(v(0.148, 1.052, 0.052), 0.070, 0.096, 0.070,
      o(body, { bevel: 0.016, bones: HIPS, dust: 0.75, value: rng.range(0.85, 1.1) }));
    B.box(v(-0.150, 1.048, 0.030), 0.070, 0.086, 0.066,
      o(body, { bevel: 0.016, bones: HIPS, dust: 0.75, value: rng.range(0.85, 1.1) }));
    B.box(v(-0.060, 1.040, -0.146), 0.086, 0.110, 0.062,
      o(body, { bevel: 0.016, bones: HIPS, dust: 0.75, value: 0.92 }));
    // a grenade clipped to the rig reads instantly as "armed combatant"
    B.blob(v(0.108, 1.352, 0.150), 0.026, 0.036, 0.026,
      { radial: 7, rings: 5, bones: ['chest'], color: 0x2f3628, r: 0.72, m: 0.25, k: K.METAL, dust: 0.35 });
    B.box(v(0.108, 1.384, 0.150), 0.010, 0.030, 0.020,
      o(hard, { bevel: 0.002, bones: ['chest'] }));
  }

  // M4-pattern carbine, built in RIGHT HAND local space and skinned rigidly to
  // that bone. Silhouette detail matters more than polygon count: handguard,
  // magwell flare, magazine, collapsible stock, optic, vertical foregrip.
  function buildCarbine(B, rng) {
    var h = BIND[BI.handR];
    // The receiver measured 0.929 luminance against a frame 99th percentile of
    // 0.719 - the enemy's rifle was 2.1x brighter than the brightest sunlit
    // architecture in the shot, and THAT is the "floating white rectangle".
    // Round 1 read this as a value problem and tuned r from 0.28 up to 0.40; it
    // did not work because the cause is geometric (large flat coplanar face +
    // narrow mirror lobe + low sun). The value is corrected here to what a worn
    // matte-anodised carbine actually is - roughness 0.55-0.65 at metalness 0.9
    // - and the geometry is broken up with chamfer flutes below, but the actual
    // guarantee comes from the specular anti-aliasing in the character shader.
    var metal = { color: 0x2a2c30, r: 0.62, m: 0.88, k: K.METAL, dust: 0.25, bones: ['handR'] };
    var poly = { color: 0x1d1f21, r: 0.72, m: 0.03, k: K.LEATHER, dust: 0.3, bones: ['handR'] };
    var wear = { color: 0x55514a, r: 0.55, m: 0.82, k: K.METAL, dust: 0.15, bones: ['handR'] };

    function P(x, y, z) { return v(h.x + x, h.y + y, h.z + z); }
    function o(base, extra) {
      var out = {}, kk;
      for (kk in base) out[kk] = base[kk];
      for (kk in extra) out[kk] = extra[kk];
      return out;
    }

    // upper + lower receiver
    B.box(P(0, 0.062, 0.090), 0.046, 0.052, 0.230, o(metal, { bevel: 0.006 }));
    B.box(P(0, 0.022, 0.048), 0.040, 0.048, 0.120, o(metal, { bevel: 0.006 }));
    // Shallow chamfered fluting down both receiver flats. A single 46 x 230 mm
    // coplanar face can present one uninterrupted mirror lobe to the sun; three
    // 6 mm steps break it into strips that can never all catch it at once.
    for (var fl = 0; fl < 3; fl++) {
      B.box(P(0.0238, 0.040 + fl * 0.021, 0.090), 0.005, 0.009, 0.216,
        o(metal, { bevel: 0.002, color: 0x212327, r: 0.70, value: 0.92 }));
      B.box(P(-0.0238, 0.040 + fl * 0.021, 0.090), 0.005, 0.009, 0.216,
        o(metal, { bevel: 0.002, color: 0x212327, r: 0.70, value: 0.92 }));
    }
    // magwell flare
    B.box(P(0, -0.006, 0.058), 0.044, 0.036, 0.062, o(metal, { bevel: 0.008, euler: new THREE.Euler(0.10, 0, 0) }));
    // STANAG magazine, raked forward. Widened and given a floorplate step: at
    // 30 m the magazine is the one shape that says "assault rifle" rather than
    // "stick", and it was too slim to break the silhouette at all.
    B.box(P(0, -0.090, 0.078), 0.036, 0.156, 0.078, o(metal, { bevel: 0.007, euler: new THREE.Euler(0.13, 0, 0), color: 0x24262a, r: 0.66, m: 0.35 }));
    B.box(P(0, -0.166, 0.090), 0.042, 0.020, 0.086, o(metal, { bevel: 0.005, euler: new THREE.Euler(0.13, 0, 0), color: 0x1b1d20, r: 0.72, m: 0.2 }));
    B.box(P(0, -0.016, 0.062), 0.032, 0.026, 0.066, o(wear, { bevel: 0.005 }));   // mag lips, bare alloy
    // pistol grip (in the hand) and trigger guard
    B.box(P(0, -0.048, -0.010), 0.032, 0.104, 0.044, o(poly, { bevel: 0.012, euler: new THREE.Euler(0.30, 0, 0) }));
    B.box(P(0, -0.006, 0.028), 0.028, 0.008, 0.058, o(metal, { bevel: 0.004 }));
    // Free-float M-LOK handguard - an octagonal tube with slot notches. Thicker
    // than it was (38 mm radius, not 31): at 27 m the old handguard was under
    // two pixels across and the whole weapon disappeared into the body, so
    // nothing in a firefight frame said "these men are armed".
    B.tube(P(0, 0.062, 0.202), P(0, 0.062, 0.396), 0.038, 8, o(metal, { color: 0x25272b, r: 0.60 }));
    B.box(P(0.036, 0.062, 0.300), 0.008, 0.020, 0.120, o(metal, { bevel: 0.002, color: 0x131416, r: 0.78, m: 0.3 }));
    B.box(P(-0.036, 0.062, 0.300), 0.008, 0.020, 0.120, o(metal, { bevel: 0.002, color: 0x131416, r: 0.78, m: 0.3 }));
    B.box(P(0, 0.098, 0.300), 0.030, 0.010, 0.140, o(metal, { bevel: 0.002, color: 0x1f2124, r: 0.66 }));
    // top rail runs the full length of the receiver and handguard, so the
    // optic actually sits on something instead of floating
    B.box(P(0, 0.091, 0.180), 0.026, 0.012, 0.430, o(metal, { bevel: 0.003, color: 0x1f2124 }));
    // gas block, barrel, flash hider
    B.box(P(0, 0.064, 0.404), 0.028, 0.036, 0.036, o(metal, { bevel: 0.005 }));
    B.tube(P(0, 0.062, 0.416), P(0, 0.062, 0.526), 0.0105, 8, o(metal, { color: 0x1e2023, r: 0.36 }));
    B.tube(P(0, 0.062, 0.520), P(0, 0.062, 0.566), 0.0165, 8, o(metal, { color: 0x1a1c1e, r: 0.30 }));
    // charging handle and ejection port
    B.box(P(0, 0.090, -0.014), 0.060, 0.012, 0.030, o(wear, { bevel: 0.004 }));
    B.box(P(0.025, 0.072, 0.108), 0.008, 0.030, 0.070, o(metal, { bevel: 0.003, color: 0x1c1e21 }));
    // buffer tube + collapsible stock
    B.tube(P(0, 0.056, -0.030), P(0, 0.052, -0.196), 0.0145, 8, o(metal, { color: 0x2e3033 }));
    B.box(P(0, 0.046, -0.212), 0.042, 0.086, 0.086, o(poly, { bevel: 0.014 }));
    B.box(P(0, 0.086, -0.150), 0.030, 0.020, 0.070, o(poly, { bevel: 0.008 }));   // cheek weld
    // red-dot optic, seated on the rail - a slim housing and a large clear
    // glass area, not a grey ring
    B.box(P(0, 0.108, 0.140), 0.028, 0.030, 0.052, o(metal, { bevel: 0.005, color: 0x1a1c1f, r: 0.62, m: 0.7 }));
    B.tube(P(0, 0.124, 0.116), P(0, 0.124, 0.168), 0.0155, 10, o(metal, { color: 0x141618, r: 0.55, m: 0.8 }));
    // vertical foregrip where the support hand goes - kept inside the support
    // arm's reach envelope so the left hand actually closes on it
    B.box(P(0, 0.014, 0.220), 0.032, 0.086, 0.034, o(poly, { bevel: 0.010, euler: new THREE.Euler(-0.12, 0, 0) }));
    B.box(P(0, -0.022, 0.220), 0.036, 0.014, 0.038, o(poly, { bevel: 0.004 }));
    // sling loop and the strap running back to the buffer tube
    B.box(P(0.022, 0.040, -0.028), 0.012, 0.026, 0.010, o(metal, { bevel: 0.003 }));
    B.tube(P(0.019, 0.038, -0.026), P(0.014, 0.062, 0.238), 0.005, 5,
      o(poly, { color: 0x201d18, r: 0.90, m: 0.0, k: K.WEBBING }));
  }

  // --------------------------------------------------------------------------
  // 5. SKELETON + INVERSE KINEMATICS
  // --------------------------------------------------------------------------
  var _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  var _qc = new THREE.Quaternion(), _qd = new THREE.Quaternion();
  var _sc = new V3();

  // Bind pose has identity rotations everywhere, so a bone's inverse bind
  // matrix is just a translation - no traversal needed to build a skeleton.
  function makeBoneInverses(scale) {
    var inv = [];
    for (var i = 0; i < BONES.length; i++) {
      inv.push(new THREE.Matrix4().makeTranslation(
        -BIND[i].x * scale, -BIND[i].y * scale, -BIND[i].z * scale));
    }
    return inv;
  }

  function makeSkeleton(scale, inverses) {
    var bones = [], i;
    for (i = 0; i < BONES.length; i++) {
      var b = new THREE.Bone();
      b.name = BONES[i][0];
      b.position.copy(BLOCAL[i]).multiplyScalar(scale);
      bones.push(b);
    }
    for (i = 0; i < BONES.length; i++) {
      var p = BONES[i][1];
      if (p >= 0) bones[p].add(bones[i]);
    }
    return { bones: bones, root: bones[0], skeleton: new THREE.Skeleton(bones, inverses) };
  }

  function worldQuatOf(obj, out) { return out.setFromRotationMatrix(obj.matrixWorld); }
  function worldPosOf(obj, out) {
    var e = obj.matrixWorld.elements;
    return out.set(e[12], e[13], e[14]);
  }

  // Analytic two-bone IK. `pole` is a world-space direction the middle joint
  // should bend toward - knees forward, elbows down-and-back. Working from the
  // current pose (rather than a canonical rest) preserves the twist the
  // procedural animation put in, so the IK layers cleanly on top of it.
  function solveTwoBone(root, mid, tipLocal, target, pole, outTip) {
    if (!root || !mid) return false;
    var L1 = mid.position.length();
    var L2 = tipLocal.length();
    if (L1 < 1e-5 || L2 < 1e-5) return false;

    worldPosOf(root, _v4);
    worldQuatOf(root, _qa);
    if (root.parent) worldQuatOf(root.parent, _qb); else _qb.identity();

    _v5.copy(target).sub(_v4);
    var d = _v5.length();
    if (d < 1e-5) { _v5.set(0, -1, 0); d = 1e-5; }
    var maxD = (L1 + L2) * 0.998;
    var minD = Math.abs(L1 - L2) * 1.02 + 1e-4;
    d = M.clamp(d, minD, maxD);
    _v5.normalize();

    // interior angle at the root between the chain direction and the first bone
    var cosA = (d * d + L1 * L1 - L2 * L2) / (2 * d * L1);
    var a = Math.acos(M.clamp(cosA, -1, 1));

    _v6.crossVectors(_v5, pole);
    if (_v6.lengthSq() < 1e-8) {
      _v6.crossVectors(_v5, Math.abs(_v5.y) > 0.9 ? _v0.set(1, 0, 0) : UPY);
      if (_v6.lengthSq() < 1e-8) _v6.set(1, 0, 0);
    }
    _v6.normalize();

    // direction of the first bone, and the resulting joint position
    _v7.copy(_v5).applyAxisAngle(_v6, a);
    _v8.copy(_v4).addScaledVector(_v7, L1);              // mid joint world pos
    _v9.copy(_v4).addScaledVector(_v5, d).sub(_v8).normalize();  // mid -> tip

    // root: rotate its current child-offset direction onto _v7
    _va.copy(mid.position).normalize().applyQuaternion(_qa);
    _qc.setFromUnitVectors(_va, _v7).multiply(_qa);       // new root world quat
    root.quaternion.copy(_qb).invert().multiply(_qc);

    // mid: rotate its current tip direction onto _v9
    _qd.copy(_qc).multiply(mid.quaternion);
    _vb.copy(tipLocal).normalize().applyQuaternion(_qd);
    _qa.setFromUnitVectors(_vb, _v9).multiply(_qd);       // new mid world quat
    mid.quaternion.copy(_qc).invert().multiply(_qa);

    if (outTip) {
      outTip.pos.copy(_v8).addScaledVector(_v9, L2);
      outTip.quat.copy(_qa);
    }
    return true;
  }

  var _ikOut = { pos: new V3(), quat: new THREE.Quaternion() };

  // Swing/twist split about `axis` (unit, expressed in the bone's PARENT frame,
  // i.e. the bone's own rest direction). Clamps the twist component of `q` to
  // +/-limit in place and returns the residual angle, which the caller rolls
  // into the parent bone. A forearm has a radius and an ulna; a wrist does not
  // rotate 120 degrees. Applying the whole weapon orientation to the wrist
  // alone is what candy-wrappered the glove into the sleeve.
  var _qe = new THREE.Quaternion();
  function clampTwist(q, axis, limit) {
    var d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
    var len = Math.sqrt(d * d + q.w * q.w);
    if (len < 1e-7) return 0;
    var ang = 2 * Math.atan2(d / len, q.w / len);
    if (ang > Math.PI) ang -= Math.PI * 2;
    else if (ang < -Math.PI) ang += Math.PI * 2;
    var cl = ang < -limit ? -limit : (ang > limit ? limit : ang);
    var resid = ang - cl;
    if (resid > -1e-4 && resid < 1e-4) return 0;
    _qe.setFromAxisAngle(axis, resid).invert();
    q.premultiply(_qe);
    return resid;
  }

  // Orthonormal frame from an up vector and a right hint - used to rebuild
  // torso orientation from ragdoll particles.
  function quatFromUpRight(up, right, out) {
    _v0.copy(up).normalize();
    _v1.copy(right);
    _v2.crossVectors(_v1, _v0);
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1);
    _v2.normalize();                              // forward = right x up
    _v1.crossVectors(_v0, _v2).normalize();       // right   = up x forward
    _m0.makeBasis(_v1, _v0, _v2);
    return out.setFromRotationMatrix(_m0);
  }

  // --------------------------------------------------------------------------
  // 6. PATHFINDING - A* over level.navGrid with string-pulled smoothing
  // --------------------------------------------------------------------------
  function PathFinder(grid) {
    this.grid = grid;
    var n = grid.w * grid.h;
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Int32Array(n);     // avoids clearing 40k arrays per query
    this.state = new Uint8Array(n);
    this.epoch = 0;
    this.heap = new Int32Array(Math.min(n, 8192));
    this.heapLen = 0;
    this.nodeBudget = 2600;             // hard cap so one query never spikes
  }

  PathFinder.prototype.idx = function (gx, gz) { return gz * this.grid.w + gx; };
  PathFinder.prototype.walkable = function (gx, gz) {
    var g = this.grid;
    if (gx < 0 || gz < 0 || gx >= g.w || gz >= g.h) return false;
    return !!g.walkable[gz * g.w + gx];
  };
  PathFinder.prototype.toGrid = function (p, out) {
    var g = this.grid;
    out.x = Math.floor((p.x - g.origin.x) / g.cellSize);
    out.z = Math.floor((p.z - (g.origin.z !== undefined ? g.origin.z : g.origin.y)) / g.cellSize);
    return out;
  };
  PathFinder.prototype.toWorld = function (gx, gz, out) {
    var g = this.grid;
    out.set(g.origin.x + (gx + 0.5) * g.cellSize, 0,
      (g.origin.z !== undefined ? g.origin.z : g.origin.y) + (gz + 0.5) * g.cellSize);
    return out;
  };

  // nearest walkable cell within `r` rings - spawn/target points are often just
  // off the grid, and refusing to path in that case looks like broken AI
  PathFinder.prototype.nearestWalkable = function (gx, gz, r) {
    if (this.walkable(gx, gz)) return true;
    for (var ring = 1; ring <= r; ring++) {
      for (var dx = -ring; dx <= ring; dx++) {
        for (var dz = -ring; dz <= ring; dz++) {
          if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          if (this.walkable(gx + dx, gz + dz)) {
            this._nx = gx + dx; this._nz = gz + dz;
            return 'moved';
          }
        }
      }
    }
    return false;
  };

  PathFinder.prototype._push = function (i) {
    if (this.heapLen >= this.heap.length) return;
    var h = this.heap, f = this.f, k = this.heapLen++;
    h[k] = i;
    while (k > 0) {
      var p = (k - 1) >> 1;
      if (f[h[p]] <= f[h[k]]) break;
      var t = h[p]; h[p] = h[k]; h[k] = t; k = p;
    }
  };
  PathFinder.prototype._pop = function () {
    var h = this.heap, f = this.f;
    var top = h[0];
    this.heapLen--;
    if (this.heapLen > 0) {
      h[0] = h[this.heapLen];
      var k = 0;
      for (;;) {
        var l = k * 2 + 1, r = l + 1, s = k;
        if (l < this.heapLen && f[h[l]] < f[h[s]]) s = l;
        if (r < this.heapLen && f[h[r]] < f[h[s]]) s = r;
        if (s === k) break;
        var t = h[s]; h[s] = h[k]; h[k] = t; k = s;
      }
    }
    return top;
  };

  var _g0 = { x: 0, z: 0 }, _g1 = { x: 0, z: 0 };
  var DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.41421], [1, -1, 1.41421], [-1, 1, 1.41421], [-1, -1, 1.41421]];

  PathFinder.prototype.find = function (start, goal, outPath) {
    var g = this.grid, i;
    outPath.length = 0;
    this.toGrid(start, _g0);
    this.toGrid(goal, _g1);
    var m = this.nearestWalkable(_g0.x, _g0.z, 4);
    if (!m) return false;
    if (m === 'moved') { _g0.x = this._nx; _g0.z = this._nz; }
    m = this.nearestWalkable(_g1.x, _g1.z, 5);
    if (!m) return false;
    if (m === 'moved') { _g1.x = this._nx; _g1.z = this._nz; }

    var s = this.idx(_g0.x, _g0.z), e = this.idx(_g1.x, _g1.z);
    if (s === e) { this.toWorld(_g1.x, _g1.z, _v0); outPath.push(_v0.clone()); return true; }

    this.epoch++;
    this.heapLen = 0;
    this.g[s] = 0;
    this.f[s] = this._h(_g0.x, _g0.z, _g1.x, _g1.z);
    this.from[s] = -1;
    this.stamp[s] = this.epoch;
    this.state[s] = 1;
    this._push(s);

    var expanded = 0, found = false, best = s, bestH = 1e9;
    while (this.heapLen > 0 && expanded < this.nodeBudget) {
      var cur = this._pop();
      if (this.state[cur] === 2) continue;
      this.state[cur] = 2;
      expanded++;
      if (cur === e) { found = true; break; }
      var cx = cur % g.w, cz = (cur / g.w) | 0;
      var hh = this._h(cx, cz, _g1.x, _g1.z);
      if (hh < bestH) { bestH = hh; best = cur; }
      for (i = 0; i < 8; i++) {
        var nx = cx + DIRS[i][0], nz = cz + DIRS[i][1];
        if (!this.walkable(nx, nz)) continue;
        // no cutting diagonal corners through a blocked cell
        if (DIRS[i][0] && DIRS[i][1] &&
          (!this.walkable(cx + DIRS[i][0], cz) || !this.walkable(cx, cz + DIRS[i][1]))) continue;
        var ni = this.idx(nx, nz);
        if (this.stamp[ni] !== this.epoch) {
          this.stamp[ni] = this.epoch; this.state[ni] = 0; this.g[ni] = 1e30;
        }
        if (this.state[ni] === 2) continue;
        var ng = this.g[cur] + DIRS[i][2];
        if (ng < this.g[ni]) {
          this.g[ni] = ng;
          this.f[ni] = ng + this._h(nx, nz, _g1.x, _g1.z) * 1.08;  // slight greed
          this.from[ni] = cur;
          this.state[ni] = 1;
          this._push(ni);
        }
      }
    }

    var node = found ? e : best;
    if (!found && bestH > 1e8) return false;
    var raw = [];
    var guard = 0;
    while (node >= 0 && guard++ < 4096) {
      raw.push(node);
      node = this.from[node];
    }
    raw.reverse();
    this._smooth(raw, outPath);
    return outPath.length > 0;
  };

  PathFinder.prototype._h = function (ax, az, bx, bz) {
    var dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
    return (dx + dz) + (1.41421 - 2) * Math.min(dx, dz);   // octile
  };

  // Grid line-of-sight (supercover) used for string pulling. Without this the
  // agents walk in visible 45-degree staircases.
  PathFinder.prototype.gridLOS = function (ax, az, bx, bz) {
    var dx = Math.abs(bx - ax), dz = Math.abs(bz - az);
    var x = ax, z = az;
    var n = dx + dz;
    var xi = bx > ax ? 1 : -1, zi = bz > az ? 1 : -1;
    var err = dx - dz;
    dx *= 2; dz *= 2;
    for (; n > 0; n--) {
      if (!this.walkable(x, z)) return false;
      if (err > 0) { x += xi; err -= dz; }
      else if (err < 0) { z += zi; err += dx; }
      else {
        // pass exactly through a corner: both adjacent cells must be open
        if (!this.walkable(x + xi, z) || !this.walkable(x, z + zi)) return false;
        x += xi; z += zi; err -= dz; err += dx; n--;
      }
    }
    return this.walkable(bx, bz);
  };

  PathFinder.prototype._smooth = function (raw, out) {
    var g = this.grid, i = 0;
    if (!raw.length) return;
    var pts = [];
    for (var k = 0; k < raw.length; k++) {
      pts.push({ x: raw[k] % g.w, z: (raw[k] / g.w) | 0 });
    }
    while (i < pts.length - 1) {
      var j = pts.length - 1;
      for (; j > i + 1; j--) {
        if (this.gridLOS(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) break;
      }
      var p = new V3();
      this.toWorld(pts[j].x, pts[j].z, p);
      out.push(p);
      i = j;
    }
  };

  // --------------------------------------------------------------------------
  // 7. WORLD QUERIES
  //
  // Every one of these degrades gracefully: with no level module at all the AI
  // still fights on a flat plane instead of throwing.
  // --------------------------------------------------------------------------
  function World() {
    this.level = null;
    this.hash = null;
    this.hashCount = -1;
    this.tmpList = [];
    this.groundY = 0;
  }

  World.prototype.attach = function (level) {
    this.level = level || null;
    this.rebuild();
  };

  World.prototype.rebuild = function () {
    var lv = this.level;
    if (!lv || !lv.colliders || !lv.colliders.length) { this.hash = null; this.hashCount = 0; return; }
    var hash = new GAME.SpatialHash(6);
    var min = new V3(), max = new V3();
    for (var i = 0; i < lv.colliders.length; i++) {
      var c = lv.colliders[i];
      if (!c) continue;
      if (c.type === 'sphere') {
        min.set(c.center.x - c.radius, c.center.y - c.radius, c.center.z - c.radius);
        max.set(c.center.x + c.radius, c.center.y + c.radius, c.center.z + c.radius);
      } else if (c.halfExtents) {
        GAME.Collision.boxBounds(c, min, max);
      } else continue;
      hash.insert(c, min, max);
    }
    this.hash = hash;
    this.hashCount = lv.colliders.length;
  };

  World.prototype.collidersNear = function (min, max) {
    if (!this.hash) return null;
    return this.hash.query(min, max, this.tmpList);
  };

  // Returns hit distance along dir, or -1. `out` (optional) receives point+normal.
  World.prototype.raycast = function (origin, dir, maxDist, out) {
    var lv = this.level;
    if (lv && typeof lv.raycast === 'function') {
      var r = null;
      try { r = lv.raycast(origin, dir, maxDist); } catch (e) { r = null; }
      if (r && (r.hit === undefined ? r.point : r.hit)) {
        var dist = r.distance;
        if (dist === undefined && r.point) dist = _v0.copy(r.point).sub(origin).length();
        if (dist !== undefined && dist >= 0 && dist <= maxDist) {
          if (out) {
            if (r.point) out.point.copy(r.point); else out.point.copy(origin).addScaledVector(dir, dist);
            if (r.normal) out.normal.copy(r.normal); else out.normal.set(0, 1, 0);
          }
          return dist;
        }
      }
      if (r) return -1;
    }
    return this.raycastColliders(origin, dir, maxDist, out);
  };

  World.prototype.raycastColliders = function (origin, dir, maxDist, out) {
    var lv = this.level;
    if (!lv || !lv.colliders) return -1;
    if (this.hashCount !== lv.colliders.length) this.rebuild();
    var list = lv.colliders;
    if (this.hash) {
      _v1.copy(origin); _v2.copy(origin).addScaledVector(dir, maxDist);
      _v3.set(Math.min(_v1.x, _v2.x), Math.min(_v1.y, _v2.y), Math.min(_v1.z, _v2.z));
      _v4.set(Math.max(_v1.x, _v2.x), Math.max(_v1.y, _v2.y), Math.max(_v1.z, _v2.z));
      list = this.hash.query(_v3, _v4, this.tmpList);
    }
    var best = -1;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], t = -1;
      if (!c) continue;
      if (c.type === 'sphere') t = GAME.Collision.raycastSphere(origin, dir, c.center, c.radius, _rayHit);
      else if (c.halfExtents) t = GAME.Collision.raycastBox(origin, dir, c, _rayHit);
      if (t >= 0 && t <= maxDist && (best < 0 || t < best)) {
        best = t;
        if (out) { out.point.copy(_rayHit.point); out.normal.copy(_rayHit.normal); }
      }
    }
    return best;
  };

  // True when something solid sits between the two points.
  World.prototype.blocked = function (from, to, slack) {
    _v0.copy(to).sub(from);
    var d = _v0.length();
    if (d < 1e-4) return false;
    _v0.divideScalar(d);
    var t = this.raycast(from, _v0, d - (slack === undefined ? 0.12 : slack), null);
    return t >= 0;
  };

  // Ground height under (x,z). Falls back to y=0 so agents never sink.
  World.prototype.ground = function (x, z, fromY, outNormal) {
    _v0.set(x, fromY, z);
    _v1.set(0, -1, 0);
    var t = this.raycast(_v0, _v1, fromY + 4, _rayHit);
    if (t >= 0) {
      if (outNormal) outNormal.copy(_rayHit.normal);
      return _rayHit.point.y;
    }
    if (outNormal) outNormal.set(0, 1, 0);
    return this.groundY;
  };

  // --------------------------------------------------------------------------
  // 8. COVER
  //
  // Cover use is what separates competent shooter AI from targets. Candidates
  // are harvested once from the nav grid (a walkable cell touching a blocked
  // cell) or from collider silhouettes, then scored per query against the
  // current threat position and verified with two raycasts.
  // --------------------------------------------------------------------------
  function CoverSystem(world) {
    this.world = world;
    this.points = [];
    this.built = false;
  }

  CoverSystem.prototype.build = function (level) {
    this.points.length = 0;
    this.built = true;
    if (!level) return;
    var pts = this.points;
    var grid = level.navGrid;
    var i;

    if (grid && grid.walkable && grid.w && grid.h) {
      var oz = grid.origin.z !== undefined ? grid.origin.z : grid.origin.y;
      var cs = grid.cellSize;
      var step = cs < 0.8 ? 2 : 1;      // thin the harvest on fine grids
      for (var gz = 1; gz < grid.h - 1; gz += step) {
        for (var gx = 1; gx < grid.w - 1; gx += step) {
          if (!grid.walkable[gz * grid.w + gx]) continue;
          var nx = 0, nz = 0, n = 0;
          for (var d = 0; d < 4; d++) {
            var dx = d === 0 ? 1 : (d === 1 ? -1 : 0);
            var dz = d === 2 ? 1 : (d === 3 ? -1 : 0);
            if (!grid.walkable[(gz + dz) * grid.w + (gx + dx)]) { nx -= dx; nz -= dz; n++; }
          }
          if (!n || n > 2) continue;    // n>2 is a dead-end pocket, not cover
          var p = new V3(grid.origin.x + (gx + 0.5) * cs, 0, oz + (gz + 0.5) * cs);
          _v0.set(nx, 0, nz).normalize();
          pts.push({
            pos: p, normal: _v0.clone(), low: false, tall: false,
            claim: -1, checked: false, score: 0
          });
          if (pts.length >= 900) break;
        }
        if (pts.length >= 900) break;
      }
    }

    if (!pts.length && level.colliders) {
      // no nav grid: ring each waist-to-head-height box with cover slots
      for (i = 0; i < level.colliders.length && pts.length < 400; i++) {
        var c = level.colliders[i];
        if (!c || !c.halfExtents) continue;
        var hy = c.halfExtents.y, top = c.center.y + hy;
        if (top < 0.55 || c.center.y - hy > 1.4) continue;
        var ex = c.halfExtents.x + 0.55, ez = c.halfExtents.z + 0.55;
        var dirs = [[1, 0, ex, 0], [-1, 0, ex, 0], [0, 1, 0, ez], [0, -1, 0, ez]];
        for (var k = 0; k < 4; k++) {
          var off = _v0.set(dirs[k][0] * dirs[k][2], 0, dirs[k][1] * dirs[k][3]);
          if (c.quaternion) off.applyQuaternion(c.quaternion);
          pts.push({
            pos: new V3(c.center.x + off.x, 0, c.center.z + off.z),
            normal: off.clone().setY(0).normalize(),
            low: top < 1.25, tall: top >= 1.25,
            claim: -1, checked: true, score: 0
          });
        }
      }
    }
    // ground the points once so scoring works in 3D
    for (i = 0; i < pts.length; i++) {
      pts[i].pos.y = this.world.ground(pts[i].pos.x, pts[i].pos.z, 3.0, null);
    }
  };

  CoverSystem.prototype.release = function (id) {
    for (var i = 0; i < this.points.length; i++) {
      if (this.points[i].claim === id) this.points[i].claim = -1;
    }
  };

  // Score = protection from the threat, plus a preferred engagement band, minus
  // travel cost. The top few are then verified with real raycasts.
  CoverSystem.prototype.best = function (from, threat, id, minDist, maxDist, exclude) {
    var pts = this.points;
    if (!pts.length) return null;
    var cand = _coverCand;
    cand.length = 0;
    for (var i = 0; i < pts.length; i++) {
      var c = pts[i];
      if (c.claim >= 0 && c.claim !== id) continue;
      if (exclude && c === exclude) continue;
      var dx = c.pos.x - from.x, dz = c.pos.z - from.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d > maxDist) continue;
      var tx = threat.x - c.pos.x, tz = threat.z - c.pos.z;
      var td = Math.sqrt(tx * tx + tz * tz) || 1e-4;
      if (td < minDist) continue;
      // the obstacle must be between the cover slot and the threat
      var protect = -(c.normal.x * tx + c.normal.z * tz) / td;
      if (protect < 0.15) continue;
      var band = 1 - M.saturate(Math.abs(td - 14) / 22);
      var s = protect * 3.0 + band * 1.4 - d * 0.10;
      // slight preference for moving forward, so squads advance
      var toward = ((threat.x - from.x) * dx + (threat.z - from.z) * dz);
      if (toward > 0) s += 0.5;
      c.score = s;
      cand.push(c);
    }
    if (!cand.length) return null;
    cand.sort(byScore);
    // verify the leaders: eye line must be blocked from crouch height
    var checks = Math.min(4, cand.length);
    // NOTE: world.blocked() consumes _v0.._v4, so the endpoints live in the
    // high scratch registers.
    for (var j = 0; j < checks; j++) {
      var p = cand[j];
      _v6.set(p.pos.x, p.pos.y + 0.95, p.pos.z);
      _v7.set(threat.x, threat.y + 1.35, threat.z);
      var lowBlocked = this.world.blocked(_v6, _v7, 0.25);
      if (!lowBlocked) continue;
      _v6.y = p.pos.y + 1.55;
      p.tall = this.world.blocked(_v6, _v7, 0.25);
      p.low = !p.tall;
      p.checked = true;
      return p;
    }
    return null;
  };
  var _coverCand = [];
  function byScore(a, b) { return b.score - a.score; }

  // --------------------------------------------------------------------------
  // 9. RAGDOLL
  //
  // Verlet particles at the joints with distance constraints, ground contact
  // and friction. Seeded from the live animated pose and from the killing
  // blow's impulse, so a body carries its momentum, folds, and settles. A rigid
  // falling mannequin is the single most obvious "cheap game" tell there is.
  // --------------------------------------------------------------------------
  var RP = [
    ['pelvis', 'hips', 0, 0, 0, 0.13],
    ['chest', 'chest', 0, 0.10, 0, 0.16],
    ['head', 'head', 0, 0.03, 0, 0.09],
    ['headTop', 'head', 0, 0.19, 0.01, 0.10],
    ['shL', 'armL', 0, 0, 0, 0.08],
    ['shR', 'armR', 0, 0, 0, 0.08],
    ['elL', 'foreL', 0, 0, 0, 0.06],
    ['elR', 'foreR', 0, 0, 0, 0.06],
    ['wrL', 'handL', 0, 0, 0, 0.06],
    ['wrR', 'handR', 0, 0, 0, 0.06],
    ['hipL', 'upLegL', 0, 0, 0, 0.10],
    ['hipR', 'upLegR', 0, 0, 0, 0.10],
    ['knL', 'loLegL', 0, 0, 0, 0.08],
    ['knR', 'loLegR', 0, 0, 0, 0.08],
    ['anL', 'footL', 0, 0, 0, 0.07],
    ['anR', 'footR', 0, 0, 0, 0.07],
    ['toeL', 'toeL', 0, 0, 0.06, 0.06],
    ['toeR', 'toeR', 0, 0, 0.06, 0.06]
  ];
  var RPI = {};
  for (var _i = 0; _i < RP.length; _i++) RPI[RP[_i][0]] = _i;

  // [a, b, kind, stiffness]  kind: 0 exact, 1 max-only (joint limit)
  var RCON = (function () {
    var c = [], I = RPI;
    function add(a, b, kind, st) { c.push([I[a], I[b], kind || 0, st === undefined ? 1 : st]); }
    add('pelvis', 'chest'); add('chest', 'head'); add('head', 'headTop');
    add('chest', 'shL'); add('chest', 'shR');
    add('shL', 'elL'); add('elL', 'wrL'); add('shR', 'elR'); add('elR', 'wrR');
    add('pelvis', 'hipL'); add('pelvis', 'hipR');
    add('hipL', 'knL'); add('knL', 'anL'); add('anL', 'toeL');
    add('hipR', 'knR'); add('knR', 'anR'); add('anR', 'toeR');
    // shape braces - without these the torso collapses into a bag
    add('shL', 'shR'); add('hipL', 'hipR');
    add('shL', 'hipL'); add('shR', 'hipR'); add('shL', 'hipR'); add('shR', 'hipL');
    add('pelvis', 'shL'); add('pelvis', 'shR');
    add('chest', 'hipL'); add('chest', 'hipR');
    add('headTop', 'shL', 0, 0.6); add('headTop', 'shR', 0, 0.6);
    add('head', 'shL', 0, 0.7); add('head', 'shR', 0, 0.7);
    add('chest', 'elL', 1, 0.5); add('chest', 'elR', 1, 0.5);
    // joint travel limits: knees and elbows may fold but not invert
    add('hipL', 'anL', 1, 0.8); add('hipR', 'anR', 1, 0.8);
    add('shL', 'wrL', 1, 0.7); add('shR', 'wrR', 1, 0.7);
    return c;
  })();

  function Ragdoll() {
    this.p = [];
    this.prev = [];
    this.rest = new Float32Array(RCON.length);
    this.r = new Float32Array(RP.length);
    this.active = false;
    this.sleeping = false;
    this.settle = 0;
    this.ground = 0;
    this.time = 0;
    for (var i = 0; i < RP.length; i++) {
      this.p.push(new V3());
      this.prev.push(new V3());
      this.r[i] = RP[i][5];
    }
    this.worldQ = [];
    for (i = 0; i < BONES.length; i++) this.worldQ.push(new THREE.Quaternion());
  }

  // Seed from the live pose. Rest lengths come from the sampled pose, so the
  // body never snaps on the first frame and per-character scale is automatic.
  Ragdoll.prototype.start = function (bones, scale, impulse, hitIndex, groundY) {
    var i;
    for (i = 0; i < RP.length; i++) {
      var b = bones[BI[RP[i][1]]];
      if (!b) { this.p[i].set(0, 1, 0); }
      else {
        _v0.set(RP[i][2] * scale, RP[i][3] * scale, RP[i][4] * scale);
        this.p[i].copy(_v0.applyMatrix4(b.matrixWorld));
      }
      this.r[i] = RP[i][5] * scale;
      this.prev[i].copy(this.p[i]);
    }
    for (i = 0; i < RCON.length; i++) {
      this.rest[i] = this.p[RCON[i][0]].distanceTo(this.p[RCON[i][1]]);
    }
    // momentum: whole-body push plus a sharper kick at the struck part
    for (i = 0; i < RP.length; i++) {
      this.prev[i].addScaledVector(impulse, -1 / 60);
    }
    if (hitIndex >= 0 && hitIndex < RP.length) {
      this.prev[hitIndex].addScaledVector(impulse, -2.2 / 60);
    }
    // a little spin so bodies do not fall like planks
    _v1.crossVectors(impulse, UPY).multiplyScalar(0.06);
    this.prev[RPI.head].addScaledVector(_v1, -1 / 60);
    this.prev[RPI.anL].addScaledVector(_v1, 1 / 60);
    this.prev[RPI.anR].addScaledVector(_v1, 1 / 60);

    this.ground = groundY;
    this.active = true;
    this.sleeping = false;
    this.settle = 0;
    this.time = 0;
    return this;
  };

  Ragdoll.prototype.step = function (dt, world) {
    if (!this.active || this.sleeping) return;
    this.time += dt;
    dt = Math.min(dt, 1 / 45);
    var i, j, drag = Math.exp(-0.9 * dt);
    var moved = 0;

    // integrate
    for (i = 0; i < this.p.length; i++) {
      var p = this.p[i], pr = this.prev[i];
      var vx = (p.x - pr.x) * drag, vy = (p.y - pr.y) * drag, vz = (p.z - pr.z) * drag;
      pr.copy(p);
      p.x += vx; p.y += vy - 9.81 * dt * dt; p.z += vz;
      moved += Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
    }

    // constraints
    for (j = 0; j < 4; j++) {
      for (i = 0; i < RCON.length; i++) {
        var c = RCON[i];
        var a = this.p[c[0]], b = this.p[c[1]];
        var dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-5;
        var rest = this.rest[i];
        if (c[2] === 1 && d <= rest) continue;         // limit constraint, slack
        var diff = ((d - rest) / d) * 0.5 * c[3];
        dx *= diff; dy *= diff; dz *= diff;
        a.x += dx; a.y += dy; a.z += dz;
        b.x -= dx; b.y -= dy; b.z -= dz;
      }
      this._collide(world);
    }

    // sleep once the body has stopped moving; corpses must stay put
    if (moved < 0.006 * this.p.length) {
      this.settle += dt;
      if (this.settle > 0.45) this.sleeping = true;
    } else this.settle = 0;
    if (this.time > 14) this.sleeping = true;
  };

  Ragdoll.prototype._collide = function (world) {
    var i;
    var minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (i = 0; i < this.p.length; i++) {
      var p = this.p[i], r = this.r[i];
      // ground plane with friction: kill the tangential slide so limbs stick
      var gy = this.ground + r;
      if (p.y < gy) {
        var pen = gy - p.y;
        p.y = gy;
        var pr = this.prev[i];
        pr.x += (p.x - pr.x) * 0.55;
        pr.z += (p.z - pr.z) * 0.55;
        pr.y = p.y - (p.y - pr.y) * 0.18 - pen * 0.05;
      }
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    if (!world || !world.hash) return;
    _v0.set(minX - 0.3, minY - 0.3, minZ - 0.3);
    _v1.set(maxX + 0.3, maxY + 0.3, maxZ + 0.3);
    var list = world.hash.query(_v0, _v1, world.tmpList);
    if (!list.length) return;
    for (i = 0; i < this.p.length; i++) {
      var pp = this.p[i], rr = this.r[i];
      for (var k = 0; k < list.length; k++) {
        var col = list[k];
        if (!col || !col.halfExtents) continue;
        if (!GAME.Collision.boxOverlapsSphere(col, pp, rr)) continue;
        // capsuleBoxMTV with a zero-height capsule is exactly a sphere MTV
        _v2.set(pp.x, pp.y - rr, pp.z);
        var depth = GAME.Collision.capsuleBoxMTV(_v2, rr, rr * 2, col, _v3);
        if (depth > 0) {
          pp.addScaledVector(_v3, depth);
          this.prev[i].lerp(pp, 0.4);
        }
      }
    }
  };

  // Rebuild bone rotations from the particle cloud.
  Ragdoll.prototype.applyToBones = function (bones, group) {
    var i, wq = this.worldQ;
    var P = this.p;
    var groupQ = group.quaternion;

    // torso frames come from an explicit up/right basis - much more stable than
    // chaining look-ats through the spine
    _v0.copy(P[RPI.chest]).sub(P[RPI.pelvis]);
    _v1.copy(P[RPI.shL]).sub(P[RPI.shR]);
    quatFromUpRight(_v0, _v1, wq[BI.hips]);
    _v0.copy(P[RPI.head]).sub(P[RPI.chest]);
    quatFromUpRight(_v0, _v1, wq[BI.chest]);
    wq[BI.spine].copy(wq[BI.hips]).slerp(wq[BI.chest], 0.5);
    _v0.copy(P[RPI.headTop]).sub(P[RPI.head]);
    quatFromUpRight(_v0, _v1, wq[BI.head]);
    wq[BI.neck].copy(wq[BI.chest]).slerp(wq[BI.head], 0.6);
    wq[BI.clavL].copy(wq[BI.chest]);
    wq[BI.clavR].copy(wq[BI.chest]);

    this._aim(wq, BI.armL, BI.foreL, P[RPI.shL], P[RPI.elL]);
    this._aim(wq, BI.foreL, BI.handL, P[RPI.elL], P[RPI.wrL]);
    this._aim(wq, BI.armR, BI.foreR, P[RPI.shR], P[RPI.elR]);
    this._aim(wq, BI.foreR, BI.handR, P[RPI.elR], P[RPI.wrR]);
    wq[BI.handL].copy(wq[BI.foreL]);
    wq[BI.handR].copy(wq[BI.foreR]);
    this._aim(wq, BI.upLegL, BI.loLegL, P[RPI.hipL], P[RPI.knL]);
    this._aim(wq, BI.loLegL, BI.footL, P[RPI.knL], P[RPI.anL]);
    this._aim(wq, BI.footL, BI.toeL, P[RPI.anL], P[RPI.toeL]);
    wq[BI.toeL].copy(wq[BI.footL]);
    this._aim(wq, BI.upLegR, BI.loLegR, P[RPI.hipR], P[RPI.knR]);
    this._aim(wq, BI.loLegR, BI.footR, P[RPI.knR], P[RPI.anR]);
    this._aim(wq, BI.footR, BI.toeR, P[RPI.anR], P[RPI.toeR]);
    wq[BI.toeR].copy(wq[BI.footR]);

    // wq holds WORLD rotations; convert to parent-local (BONES is ordered
    // parents-first, so a single pass is enough)
    for (i = 0; i < BONES.length; i++) {
      var par = BONES[i][1];
      _qc.copy(par < 0 ? groupQ : wq[par]).invert().multiply(wq[i]);
      bones[i].quaternion.copy(_qc);
    }
    // root translation: hips follow the pelvis particle
    group.worldToLocal(_v0.copy(P[RPI.pelvis]));
    bones[BI.hips].position.copy(_v0);
  };

  // Orient bone `bi` so its bind direction toward `child` points along (b-a).
  Ragdoll.prototype._aim = function (wq, bi, child, a, b) {
    _v2.copy(b).sub(a);
    if (_v2.lengthSq() < 1e-8) { wq[bi].copy(wq[BONES[bi][1]] || wq[0]); return; }
    _v2.normalize();
    var par = BONES[bi][1];
    _qa.copy(par >= 0 ? wq[par] : wq[0]);
    _v3.copy(BLOCAL[child]).normalize().applyQuaternion(_qa);
    _qb.setFromUnitVectors(_v3, _v2);
    wq[bi].copy(_qb).multiply(_qa);
  };

  // --------------------------------------------------------------------------
  // 10. ENEMY
  // --------------------------------------------------------------------------
  var TAU = Math.PI * 2;
  var ONE = new V3(1, 1, 1);
  var _euler = new THREE.Euler(0, 0, 0, 'ZXY');

  // Phase-wrapped gaussian: the building block of every gait curve here.
  function pgauss(p, mu, s) {
    var d = p - mu;
    d -= Math.round(d);
    d /= s;
    return Math.exp(-d * d);
  }

  var ENEMY_ID = 1;

  function Enemy(sys, variant, position) {
    var i;
    this.sys = sys;
    this.id = ENEMY_ID++;
    this.name = 'MILITIA-' + (100 + (this.id * 37) % 800);
    this.rng = sys.rng.fork ? sys.rng.fork(this.id * 7919) : new GAME.RNG(this.id * 7919);
    this.variant = variant;
    this.scale = variant ? variant.scale : 1;
    this.look = variant ? variant.look : null;

    this.group = new THREE.Group();
    this.group.name = 'enemy_' + this.id;
    this.position = this.group.position;         // feet position, shared object
    if (position) this.position.copy(position);
    this.velocity = new V3();
    this.yaw = 0;
    this.desiredYaw = 0;
    this.aimDir = new V3(0, 0, 1);
    this.aimTarget = new V3();
    this.eye = new V3();
    this.muzzle = new V3();
    this.muzzleDir = new V3(0, 0, 1);

    this.maxHealth = 100;
    this.health = 100;
    this.alive = true;
    this.dying = 0;

    // --- combat state
    // Burst discipline, not a hose. Six rounds at 620 rpm is 0.58 s of
    // continuous fire; two men doing that with any accuracy at all is 130 dps
    // into a 100 hp player, which is what killed him in 1.3 s. Shorter bursts,
    // longer gaps between them, and a per-round damage that needs FIVE hits to
    // matter rather than eight.
    this.weapon = {
      name: 'ak74', rpm: 620, damage: 11, magSize: 30, range: 90,
      burstMin: 2, burstMax: 5, climb: 0.016
    };
    this.ammo = 30;
    this.fireTimer = 0;
    this.burstLeft = 0;
    this.burstShot = 0;         // index within the current burst, for climb
    this.burstPause = this.rng.range(0.2, 1.1);
    this.reload = 0;
    this.grenades = this.rng.int(0, 2);
    this.grenadeCd = this.rng.range(6, 16);
    this.timeOnTarget = 0;
    this.aimBias = new V3();
    this.suppression = 0;
    // Per-man skill spread, so a squad is not nine identical marksmen. Applied
    // to the convergence rate and to the standing error, both.
    this.skill = this.rng.range(0.78, 1.24);

    // --- perception / behaviour
    this.state = 'idle';
    this.prevState = '';
    this.stateTime = 0;
    this.think = this.rng.range(0, 0.12);
    this.awareness = 0;
    this.canSeeTarget = false;
    this.losTimer = 0;
    this.reactTimer = 0;
    // Time the player has to be inside this man's cone before he even STARTS
    // building awareness. Nine men who all acquire on the same frame is what
    // turns a spawn into an execution; a 0.1-0.9 s spread means contact rolls
    // through the squad instead of arriving as one wall of fire.
    this.noticeDelay = this.rng.range(0.12, 0.90);
    this.timeSinceSeen = 999;
    this.lastKnown = new V3();
    this.hasLastKnown = false;
    this.role = 'hold';
    this.cover = null;
    // How long he returns fire from where he stands before breaking for cover,
    // and a lockout so a failed cover query cannot bounce him back and forth.
    this.coverUrge = this.rng.range(1.3, 3.2);
    this.coverBlocked = 0;
    this.coverPeek = 0;
    this.peekSide = this.rng.sign();
    this.peekTimer = this.rng.range(0.4, 1.6);
    this.crouch = 0;
    this.path = [];
    this.pathIndex = 0;
    this.pathGoal = new V3();
    this.pathAge = 99;
    this.pathPending = false;
    this.moveTarget = null;
    this.speedWanted = 0;
    this.patrol = [];
    this.patrolIndex = 0;
    this.stuck = 0;
    this.groundY = this.position.y;
    this.groundNormal = new V3(0, 1, 0);

    // --- animation
    this.anim = {
      gait: this.rng.next(),
      speed: 0, run: 0, move: 0,
      lean: 0, breath: this.rng.range(0, TAU), breathRate: this.rng.range(0.85, 1.15),
      sway: this.rng.range(0, 64),
      stance: this.rng.sign(), stanceBlend: 0, stanceTimer: this.rng.range(3, 9),
      headYaw: 0, headPitch: 0, headTargetYaw: 0, headTargetPitch: 0,
      headYawV: { v: 0 }, headPitchV: { v: 0 }, glance: this.rng.range(1, 4),
      weaponUp: 0, weaponUpTarget: 0, grip: 1,
      gripFail: 0, gripLock: 0,
      recoil: 0, recoilV: 0,
      pelvisOff: 0, pelvisSide: 0, pelvisIK: 0, pelvisIKPrev: 0, crouch: 0, peek: 0,
      footOff: [0, 0], footNormal: [new V3(0, 1, 0), new V3(0, 1, 0)],
      stagger: new V3()
    };
    this.rot = new Float32Array(BONES.length * 3);
    this.imp = new Float32Array(BONES.length * 6);

    // ---- per-man pose seed
    // Four men in an identical stance is the "stiff mannequins" instant-fail in
    // both ART_DIRECTION and ARCHITECTURE section 9, and firefight.png had all
    // four bolt upright with both arms level and extended. Every asymmetry a
    // real squad has - which foot is forward, how far the hips are bladed off
    // the aim axis, how deep the knees are - is drawn ONCE here, from this
    // enemy's own deterministic stream, and held for the character's life.
    this.pose = {
      blade: this.rng.range(0.42, 0.70) * this.rng.sign(),   // 24-40 deg
      counter: this.rng.range(0.86, 1.06),
      lean: this.rng.range(-0.06, 0.06),
      elbowDrop: this.rng.range(0.62, 1.05),
      elbowTuck: this.rng.range(0.80, 1.20),
      stanceW: this.rng.range(0.86, 1.22),
      posture: 0,                     // 0 stand, 1 crouch, 2 kneel
      headBias: this.rng.range(-0.10, 0.10)
    };

    this.retreatPos = null;
    this.crouchWanted = 0;
    this.captureCrouch = 0;         // capture-only posture floor, see _captureStage
    this.groundTimer = 0;
    this._los = false;

    this.hitboxes = [];
    this.boundsCenter = new V3();
    this.boundsRadius = 1.35 * this.scale;

    this.ragdoll = null;
    this.mesh = null;
    this.bones = null;

    this._buildMesh();
    for (i = 0; i < HITBOX_DEF.length; i++) {
      var d = HITBOX_DEF[i];
      this.hitboxes.push({
        type: 'box', name: d[0], bone: BI[d[1]],
        off: v(d[2], d[3], d[4]).multiplyScalar(this.scale),
        center: new V3(),
        halfExtents: v(d[5], d[6], d[7]).multiplyScalar(this.scale),
        quaternion: new THREE.Quaternion(),
        mult: d[8]
      });
    }
  }

  // The right hand vanished for an entire review cycle because a 40% foreR
  // weight on the palm sheared it into the wrist axis while the 100%-handR
  // carbine swung free. Nothing in the build reported it. This does: it samples
  // the palm centroid in bind space and asserts that hand and weapon really do
  // share one rigid transform, so the regression cannot recur silently.
  function assertRigidHand(geo, scale) {
    var pos = geo.attributes.position;
    var si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!pos || !si || !sw) return;
    var s = scale || 1;
    var sides = [['handR', -0.252 * s, 0.848 * s, 0.040 * s],
    ['handL', 0.252 * s, 0.848 * s, 0.040 * s]];
    for (var q = 0; q < sides.length; q++) {
      var bi = BI[sides[q][0]];
      var cx = sides[q][1], cy = sides[q][2], cz = sides[q][3];
      var best = -1, bestD = 1e9, i, k;
      for (i = 0; i < pos.count; i++) {
        var dx = pos.getX(i) - cx, dy = pos.getY(i) - cy, dz = pos.getZ(i) - cz;
        var d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > 0.0025 * s * s) continue;
      var w = 0;
      for (k = 0; k < 4; k++) {
        if (si.getComponent(best, k) === bi) w += sw.getComponent(best, k);
      }
      if (w < 0.95) {
        GAME.logError('ai.rig',
          'palm near ' + sides[q][0] + ' is only ' + w.toFixed(3) +
          ' weighted to it; hand and weapon will separate under wrist twist');
      }
    }
  }

  Enemy.prototype._buildMesh = function () {
    var vr = this.variant;
    if (!vr || !vr.geometry || !vr.material) return;
    try {
      var sk = makeSkeleton(this.scale, vr.inverses);
      var mesh = new THREE.SkinnedMesh(vr.geometry, vr.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The variant geometry - and therefore its bounding sphere - is SHARED by
      // every enemy using that body, and a skinned pose can leave it. Culling
      // against it dropped characters out of the shadow cascade, so a figure in
      // full sun threw nothing at all. One extra draw call per off-screen enemy
      // is a trade worth making; 16 of them is still inside the budget.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;          // the mesh itself never moves
      mesh.add(sk.root);
      mesh.bind(sk.skeleton);
      this.group.add(mesh);
      this.mesh = mesh;
      this.bones = sk.bones;
      this.skeleton = sk.skeleton;
      this._buildContact();
    } catch (e) {
      GAME.logError('ai.buildMesh', e);
    }
  };

  // ------------------------------------------------------------- contact ----
  // A soft occlusion patch under the boots. The CSM is the primary shadow, but
  // a character with no contact occlusion is visually pasted onto the asphalt -
  // and if the cascade ever drops him, this is the only thing keeping him on
  // the ground. Multiplicative-looking, never pure black, and it tightens as
  // the feet plant.
  // The old patch was a SINGLE 1.10 m disc pinned under the pelvis, made of
  // MeshBasicMaterial at opacity 0.16-0.46 in colour 0x1b2126. Two things were
  // wrong with it and both are structural. First, the contrapposto stance this
  // file deliberately produces puts one boot ~0.25 m forward and the feet
  // 0.21 m apart, so a disc centred on the pelvis sits under NEITHER boot -
  // exactly where a contact shadow does nothing. Second, an alpha-blended
  // constant colour TINTS rather than DARKENS: over bright sunlit asphalt it
  // lifts toward teal and disappears, which is the textbook "pasted on" tell.
  // Two patches now, one per foot, driven from the world-space foot positions
  // and ground normals the foot IK already computes, and composited with
  // MultiplyBlending so they genuinely multiply the street down.
  var _contactGeo = null, _contactMat = null;
  function contactAssets() {
    if (_contactGeo) return true;
    if (typeof document === 'undefined' || !document.createElement) return false;
    var N = 64;
    var cv = document.createElement('canvas');
    cv.width = cv.height = N;
    var g2 = cv.getContext('2d');
    if (!g2) return false;
    var img = g2.createImageData(N, N);
    var d = img.data;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var dx = (x + 0.5) / N * 2 - 1, dy = (y + 0.5) / N * 2 - 1;
        var r = Math.sqrt(dx * dx + dy * dy);
        var a = M.saturate(1 - r);
        a = a * a * (3 - 2 * a);
        a = a * a;                                    // tight core, soft skirt
        // MULTIPLIER, not a colour: 1.0 at the rim leaves the ground alone,
        // 0.30 under the sole darkens it. Slightly warmer in blue so the
        // darkening carries the scene's cool skylight fill rather than going
        // neutral grey.
        var i = (y * N + x) * 4;
        d[i] = Math.round(255 * (1 - a * 0.72));
        d[i + 1] = Math.round(255 * (1 - a * 0.70));
        d[i + 2] = Math.round(255 * (1 - a * 0.64));
        d[i + 3] = 255;
      }
    }
    g2.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    // NoColorSpace: this texture is a linear multiplier, not an albedo. Tagging
    // it sRGB would push 0.30 down to 0.07 and punch a black hole in the road.
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    _contactGeo = new THREE.PlaneGeometry(1, 1);
    _contactGeo.rotateX(-Math.PI / 2);
    // A multiply blend ignores alpha entirely, so material.opacity cannot fade
    // it - the fade has to happen inside the shader by lerping the multiplier
    // back toward 1.0. Twelve lines of ShaderMaterial; no fog and no tone
    // mapping, both of which would push a multiplier past 1.0 and BRIGHTEN the
    // ground under the boot.
    _contactMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: tex }, uK: { value: 1 } },
      vertexShader: [
        'varying vec2 vCUv;',
        'void main() {',
        '  vCUv = uv;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D uMap;',
        'uniform float uK;',
        'varying vec2 vCUv;',
        'void main() {',
        '  vec3 m = texture2D(uMap, vCUv).rgb;',
        '  gl_FragColor = vec4(mix(vec3(1.0), m, uK), 1.0);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, fog: false,
      // NOT THREE.MultiplyBlending. r180's WebGLState refuses that preset unless
      // material.premultipliedAlpha is true - it logs
      //   "MultiplyBlending requires material.premultipliedAlpha = true"
      // and then leaves whatever blend func the previous draw set, which here
      // was straight alpha blending. The patch therefore composited its own
      // near-white multiplier as OPAQUE COLOUR and put two blown white squares
      // under every enemy's boots. Spelling the multiply out as CustomBlending
      // goes down WebGLState's explicit-factor path, which has no such
      // precondition: dst = src * dst exactly, alpha untouched.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor
    });
    return true;
  }

  Enemy.prototype._buildContact = function () {
    if (!contactAssets()) return;
    var i, m;
    this.contactFeet = [];
    for (i = 0; i < 2; i++) {
      m = new THREE.Mesh(_contactGeo, _contactMat.clone());
      m.scale.setScalar(0.45 * this.scale);
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 3;
      m.frustumCulled = false;
      m.matrixAutoUpdate = true;
      this.group.add(m);
      this.contactFeet.push(m);
    }
    // The pelvis disc survives for the ragdoll case only: a settled corpse has
    // no meaningful foot plant, and one broad patch under the mass is right.
    m = new THREE.Mesh(_contactGeo, _contactMat.clone());
    m.scale.setScalar(1.4 * this.scale);
    m.position.set(0, 0.02, 0.02);
    m.visible = false;
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 3;
    m.matrixAutoUpdate = true;
    this.group.add(m);
    this.contact = m;
  };

  var _cq = new THREE.Quaternion();
  Enemy.prototype._updateContact = function () {
    var m = this.contact, i;
    var feet = this.contactFeet;
    var s = this.scale || 1;
    if (this.ragdoll && this.ragdoll.active) {
      if (feet) for (i = 0; i < 2; i++) feet[i].visible = false;
      if (!m) return;
      m.visible = true;
      this.group.worldToLocal(_v0.copy(this.ragdoll.p[RPI.pelvis]));
      m.position.set(_v0.x, 0.02, _v0.z);
      m.quaternion.identity();
      m.scale.setScalar(1.5 * s);
      return;
    }
    if (m) m.visible = false;
    if (!feet || !this.bones) return;
    var ankleRest = BIND[BI.footL].y * s;
    for (i = 0; i < 2; i++) {
      var f = feet[i];
      // real world foot position -> group space, so the patch tracks the
      // actual planted boot through the contrapposto offset, not the pelvis
      worldPosOf(this.bones[i === 0 ? BI.footL : BI.footR], _v0);
      var sole = _v0.y - ankleRest;
      this.group.worldToLocal(_v0);
      // strength by plant height: full at contact, gone by 0.30 m of lift
      var lift = Math.max(0, sole - this.position.y);
      var plant = 1 - M.saturate(lift / (0.30 * s));
      if (plant < 0.03) { f.visible = false; continue; }
      f.visible = true;
      f.position.set(_v0.x, 0.016 + i * 0.002, _v0.z + 0.035 * s);
      // lie flat on the street camber, not on an imaginary level plane
      var n = this.anim.footNormal[i];
      if (n && n.y < 0.9995) {
        _v1.copy(n).applyQuaternion(_cq.setFromEuler(_euler.set(0, -this.yaw, 0, 'ZXY')));
        f.quaternion.setFromUnitVectors(UPY, _v1.normalize());
      } else f.quaternion.identity();
      f.scale.set((0.34 + 0.16 * plant) * s, 1, (0.44 + 0.20 * plant) * s);
      if (f.material.uniforms) f.material.uniforms.uK.value = 0.30 + 0.70 * plant;
    }
  };

  // ---------------------------------------------------------------- posing --
  Enemy.prototype._clearPose = function () {
    var r = this.rot;
    for (var i = 0; i < r.length; i++) r[i] = 0;
  };

  Enemy.prototype._add = function (bone, rx, ry, rz) {
    var i = bone * 3;
    this.rot[i] += rx; this.rot[i + 1] += ry; this.rot[i + 2] += rz;
  };

  // IDLE: weight on one leg, slow breathing, drifting head, never still.
  Enemy.prototype._poseIdle = function (dt, w) {
    var a = this.anim, t = this.sys.time;
    var st = a.stance;                    // +1 = weight on the left leg
    a.stanceTimer -= dt;
    if (a.stanceTimer <= 0) { a.stance = -a.stance; a.stanceTimer = this.rng.range(4, 11); }
    a.stanceBlend = M.damp(a.stanceBlend, a.stance, 1.6, dt);
    var sb = a.stanceBlend;

    // Contrapposto: the pelvis rides over the loaded leg, the other hip drops,
    // the free knee softens and the free foot turns out. Symmetrical
    // feet-together standing is the classic dead-mannequin look.
    // The amplitudes below are roughly double what they were. At 2.6 m, 2.9
    // degrees of pelvis roll and 3.5 degrees of stance width simply do not
    // read: the figure came out bilaterally symmetric with both knees locked
    // and both feet parallel, which is exactly the dead-mannequin stance this
    // layer exists to avoid.
    var loadSign = sb > 0 ? 1 : -1;
    var amt = Math.abs(sb);
    a.pelvisSide += 0.045 * sb * w;
    this._add(BI.hips, 0, 0, -0.110 * sb * w);
    this._add(BI.spine, 0.02 * w, 0, 0.062 * sb * w);
    // the shoulder line opposes the hip line - that counter-rotation is what
    // makes contrapposto read as weight rather than as a lean
    this._add(BI.chest, 0, 0.035 * sb * w, -0.055 * sb * w);
    this._add(BI.clavL, 0, 0, -0.030 * sb * w);
    this._add(BI.clavR, 0, 0, -0.030 * sb * w);
    var loaded = sb > 0 ? BI.upLegL : BI.upLegR;
    var free = sb > 0 ? BI.upLegR : BI.upLegL;
    var loadedK = sb > 0 ? BI.loLegL : BI.loLegR;
    var freeK = sb > 0 ? BI.loLegR : BI.loLegL;
    // base stance width - boots apart and toes out, not heels together, and
    // per-man so a squad is not four identically-planted pairs of boots
    var sw2 = this.pose ? this.pose.stanceW : 1;
    this._add(BI.upLegL, 0, 0, 0.084 * w * sw2);
    this._add(BI.upLegR, 0, 0, -0.084 * w * sw2);
    this._add(BI.footL, 0, 0.15 * w * sw2, 0);
    this._add(BI.footR, 0, -0.15 * w * sw2, 0);
    this._add(loaded, 0.02 * amt * w, 0, -0.055 * loadSign * amt * w);
    this._add(loadedK, 0.045 * amt * w, 0, 0);
    // free leg: hip flexed forward so the boot sits ahead of the loaded one,
    // knee soft, foot turned out
    this._add(free, 0.21 * amt * w, -0.20 * loadSign * amt * w, -0.080 * loadSign * amt * w);
    this._add(freeK, 0.34 * amt * w, 0, 0);
    this._add(sb > 0 ? BI.footR : BI.footL, -0.17 * amt * w, 0.10 * loadSign * amt * w, 0);

    // breathing: the chest lifts and the shoulders roll back a little
    a.breath += dt * a.breathRate * 1.5;
    var br = Math.sin(a.breath);
    this._add(BI.chest, -0.020 * br * w, 0, 0);
    this._add(BI.spine, 0.008 * br * w, 0, 0);
    this._add(BI.clavL, -0.030 * br * w, 0, -0.012 * br * w);
    this._add(BI.clavR, -0.030 * br * w, 0, 0.012 * br * w);

    // slow whole-body sway from smooth noise - the thing that stops a character
    // reading as a frozen statue between animations
    var n = GAME.noise;
    var s1 = n.perlin2(a.sway + t * 0.13, 0.0);
    var s2 = n.perlin2(0.0, a.sway + t * 0.11);
    this._add(BI.hips, 0.020 * s1 * w, 0.030 * s2 * w, 0.016 * s2 * w);
    this._add(BI.spine, 0.014 * s2 * w, 0.020 * s1 * w, 0);
    a.pelvisOff += 0.004 * s1 * w;

    // ---- permanent asymmetry ----------------------------------------------
    // Contrapposto plus a sway still PRESENTS as symmetrical from the front:
    // shoulders level, both elbows flared the same amount, weapon vertical on
    // the body midline, feet level and close together. Symmetry is the
    // mannequin tell the instant-fail list names, and the hero closeup was
    // reading as a mirror image of itself.
    //
    // The carbine is skinned rigidly to handR, so every militiaman in this
    // build is right-handed and the blade has to be signed that way - a random
    // sign would put half the squad in a mirrored stance holding a right-handed
    // rifle. pose.blade supplies the per-man MAGNITUDE, so no two men are
    // bladed by the same amount, and nothing here decays with the sway.
    var bmag = M.clamp(Math.abs(this.pose.blade) / 0.56, 0.75, 1.30);
    // firing (right) clavicle rolls forward and drops; support side opens
    this._add(BI.clavR, 0.16 * bmag * w, -0.05 * bmag * w, 0.20 * bmag * w);
    this._add(BI.clavL, -0.06 * bmag * w, 0.05 * bmag * w, 0.09 * bmag * w);
    // hips yaw OPPOSITE the shoulder line, so the stance is bladed not square
    this._add(BI.hips, 0, 0.14 * bmag * w, 0);
    this._add(BI.chest, 0, -0.09 * bmag * w, 0);
    // head yawed off the chest axis, per man
    this._add(BI.head, 0, (0.09 * bmag + this.pose.headBias * 2.0) * w, 0);
    // Support (left) foot forward of the strong foot, knees unequal. Kept to
    // ~0.16 m: at 0.24 the two legs lined up one behind the other in a
    // front-on portrait and the pair read as a single column.
    this._add(BI.upLegL, 0.17 * bmag * w, 0.05 * w, 0.030 * w);
    this._add(BI.upLegR, -0.10 * bmag * w, -0.09 * w, -0.042 * w);
    this._add(BI.loLegL, 0.09 * bmag * w, 0, 0);
    this._add(BI.loLegR, 0.22 * bmag * w, 0, 0);
    this._add(BI.footL, 0.04 * w, 0, 0);
    this._add(BI.footR, -0.10 * w, 0, 0);
  };

  // WALK / RUN. The cycle phase is driven by distance travelled, which is the
  // only way to make feet stop sliding when speed changes.
  Enemy.prototype._poseLocomotion = function (dt, w) {
    var a = this.anim;
    var run = a.run;
    var p = a.gait;
    var amp = 0.55 + 0.45 * run;
    var i, sgn, leg, phase;

    for (i = 0; i < 2; i++) {
      phase = i === 0 ? p : (p + 0.5) % 1;
      sgn = i === 0 ? 1 : -1;
      var hipF = (0.06 + 0.34 * amp) * Math.cos(TAU * phase) + 0.05 * run;
      // knee: a small loading flex just after contact, a big swing flex at 72%
      var kneeF = 0.08 + (0.16 + 0.14 * run) * pgauss(phase, 0.14, 0.10) +
        (0.72 + 0.62 * run) * pgauss(phase, 0.72, 0.13);
      // ankle: dorsiflex at heel strike, plantarflex hard at toe-off
      var ankF = 0.12 * pgauss(phase, 0.02, 0.09) -
        (0.34 + 0.20 * run) * pgauss(phase, 0.50, 0.09) +
        0.20 * pgauss(phase, 0.78, 0.17);
      var up = i === 0 ? BI.upLegL : BI.upLegR;
      var lo = i === 0 ? BI.loLegL : BI.loLegR;
      var ft = i === 0 ? BI.footL : BI.footR;
      var to = i === 0 ? BI.toeL : BI.toeR;
      this._add(up, -hipF * w, 0, sgn * 0.03 * w);
      this._add(lo, kneeF * w, 0, 0);
      this._add(ft, -ankF * w, 0, 0);
      // toe-off roll through the ball of the foot
      this._add(to, -0.35 * pgauss(phase, 0.47, 0.08) * w * (0.6 + run), 0, 0);

      // contralateral arm swing - only the free (left) arm swings, the right
      // hand is on the pistol grip and is driven by IK
      if (i === 0) {
        this._add(BI.armR, 0, 0, 0);
      } else {
        var sw = (0.22 + 0.42 * run) * Math.cos(TAU * phase);
        this._add(BI.armL, -sw * w, 0, 0);
        this._add(BI.foreL, (0.35 + 0.55 * run + 0.30 * Math.max(0, sw)) * w, 0, 0);
      }
    }

    // pelvis: vertical bob (twice per cycle, lowest just after each contact),
    // lateral sway toward the stance leg, transverse rotation and a frontal
    // drop toward the swing side
    var bob = (0.016 + 0.026 * run) * Math.cos(2 * TAU * (p - 0.30));
    a.pelvisOff += (bob - 0.012 - 0.030 * run) * w;
    a.pelvisSide += 0.026 * amp * Math.sin(TAU * p) * w;
    this._add(BI.hips, 0.03 * run * w, -0.13 * amp * Math.cos(TAU * p) * w,
      0.055 * amp * Math.sin(TAU * p) * w);
    // torso counter-rotates against the pelvis; lean grows with speed
    this._add(BI.spine, (0.06 + 0.16 * run) * w, 0.07 * amp * Math.cos(TAU * p) * w, 0);
    this._add(BI.chest, (0.04 + 0.10 * run) * w, 0.05 * amp * Math.cos(TAU * p) * w,
      -0.03 * amp * Math.sin(TAU * p) * w);
    // head stays level - real people stabilise their gaze while running
    this._add(BI.neck, -(0.06 + 0.16 * run) * w * 0.7, 0, 0);
  };

  // Additive impulse springs: hit reactions and recoil absorb. These layer on
  // top of whatever the base pose did, then decay.
  Enemy.prototype._poseImpulses = function (dt) {
    var im = this.imp, i, k;
    var stiff = 190, damp = 15;
    for (i = 0; i < BONES.length; i++) {
      k = i * 6;
      var any = im[k] || im[k + 1] || im[k + 2] || im[k + 3] || im[k + 4] || im[k + 5];
      if (!any) continue;
      for (var c = 0; c < 3; c++) {
        var x = im[k + c], vv = im[k + 3 + c];
        vv += (-stiff * x - damp * vv) * dt;
        x += vv * dt;
        if (Math.abs(x) < 1e-4 && Math.abs(vv) < 1e-3) { x = 0; vv = 0; }
        im[k + c] = x; im[k + 3 + c] = vv;
      }
      this._add(i, im[k], im[k + 1], im[k + 2]);
    }
  };

  Enemy.prototype.addImpulse = function (bone, rx, ry, rz, spread) {
    if (bone === undefined || bone < 0) return;
    var k = bone * 6;
    this.imp[k + 3] += rx; this.imp[k + 4] += ry; this.imp[k + 5] += rz;
    if (spread) {
      // propagate up the chain with damping so the whole body absorbs the hit
      var p = BONES[bone][1], f = 0.5;
      while (p >= 0 && f > 0.05) {
        var kk = p * 6;
        this.imp[kk + 3] += rx * f; this.imp[kk + 4] += ry * f; this.imp[kk + 5] += rz * f;
        f *= 0.5; p = BONES[p][1];
      }
    }
  };

  // Head look: a spring toward the target so tracking is alive, not rigid.
  Enemy.prototype._poseHead = function (dt) {
    var a = this.anim;
    var ty = a.headTargetYaw, tp = a.headTargetPitch;
    if (this.state === 'idle' || this.state === 'patrol') {
      a.glance -= dt;
      if (a.glance <= 0) {
        a.glance = this.rng.range(1.6, 5.0);
        a.headTargetYaw = this.rng.range(-0.6, 0.6);
        a.headTargetPitch = this.rng.range(-0.14, 0.10);
      }
      var n = GAME.noise.perlin2(a.sway * 0.7 + this.sys.time * 0.25, 3.1);
      ty = a.headTargetYaw + n * 0.10;
      tp = a.headTargetPitch;
    }
    a.headYaw = M.springDamp(a.headYaw, M.clamp(ty, -1.2, 1.2), a.headYawV, 0.22, dt);
    a.headPitch = M.springDamp(a.headPitch, M.clamp(tp, -0.7, 0.7), a.headPitchV, 0.20, dt);
    // split the look between the neck and the head so the whole spine reads
    this._add(BI.neck, a.headPitch * 0.45, a.headYaw * 0.42, 0);
    this._add(BI.head, a.headPitch * 0.55, a.headYaw * 0.58, a.headYaw * 0.06);
  };

  Enemy.prototype._applyPose = function () {
    var b = this.bones, r = this.rot, i;
    if (!b) return;
    for (i = 0; i < BONES.length; i++) {
      var k = i * 3;
      _euler.set(r[k], r[k + 1], r[k + 2], 'ZXY');
      b[i].quaternion.setFromEuler(_euler);
    }
    b[BI.hips].position.set(
      BLOCAL[BI.hips].x * this.scale + this.anim.stagger.x + this.anim.pelvisSide * this.scale,
      BLOCAL[BI.hips].y * this.scale + this.anim.pelvisOff * this.scale,
      BLOCAL[BI.hips].z * this.scale + this.anim.stagger.z);
  };

  // ------------------------------------------------------------- animation --
  var _ikOut2 = { pos: new V3(), quat: new THREE.Quaternion() };
  var _fwd = new V3(), _lft = new V3(), _anchor = new V3(), _ref = new V3();
  var _handPos = new V3(), _pole = new V3(), _Q = new THREE.Quaternion();
  var _QL = new THREE.Quaternion(), _tipLocal = new V3();

  function quatLookZ(dir, out) {
    _v1.copy(dir).normalize();
    _v2.copy(UPY);
    if (Math.abs(_v1.y) > 0.985) _v2.set(0, 0, _v1.y > 0 ? -1 : 1);
    _v3.crossVectors(_v2, _v1).normalize();          // X = up x forward
    _v2.crossVectors(_v1, _v3).normalize();          // Y = forward x X
    _m0.makeBasis(_v3, _v2, _v1);
    return out.setFromRotationMatrix(_m0);
  }

  Enemy.prototype.animate = function (dt, ctx, near) {
    var a = this.anim;
    if (!this.bones) return;

    if (this.ragdoll && this.ragdoll.active) {
      // once a body has settled it stops costing anything at all
      if (this.ragdoll.sleeping && this._settled) return;
      this.ragdoll.step(dt, this.sys.world);
      this.ragdoll.applyToBones(this.bones, this.group);
      this.group.updateMatrixWorld(true);
      this._updateHitboxes();
      this._updateContact();
      if (this.ragdoll.sleeping) this._settled = true;
      return;
    }
    if (!this.alive) return;

    // ---- blends ----------------------------------------------------------
    var sp = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    a.speed = M.damp(a.speed, sp, 10, dt);
    a.run = M.saturate((a.speed - 1.65) / 2.3);
    a.move = M.saturate(a.speed / 0.55);
    // stride length scales with gait so the cycle stays locked to the ground
    var stride = M.lerp(0.80, 1.62, a.run) * this.scale;
    a.gait = (a.gait + (a.speed * dt) / stride) % 1;
    if (a.gait < 0) a.gait += 1;
    a.weaponUp = M.damp(a.weaponUp, a.weaponUpTarget, 6.5, dt);
    a.recoilV += (-260 * a.recoil - 22 * a.recoilV) * dt;
    a.recoil += a.recoilV * dt;
    a.stagger.multiplyScalar(Math.exp(-6 * dt));

    // ---- pose layers -----------------------------------------------------
    this._clearPose();
    a.pelvisOff = a.pelvisIK || 0;
    a.pelvisSide = 0;
    var idleW = 1 - a.move;
    if (idleW > 0.01) this._poseIdle(dt, idleW);
    if (a.move > 0.01) this._poseLocomotion(dt, a.move);

    // Crouch (behind low cover, or suppressed). The foot IK pulls the pelvis
    // back UP to keep both soles on the ground, so a 0.30 m drop with a shallow
    // knee bend netted out at about 0.10 m of actual crouch - four pixels at
    // 27 m, which is why "two of the four are crouched" never read in the
    // frame. Deeper drop, deeper knees, and deliberately asymmetric.
    if (a.crouch > 0.01) {
      var c = a.crouch;
      var kb = this.pose.blade > 0 ? 1 : -1;
      a.pelvisOff -= 0.44 * c;
      this._add(BI.upLegL, (-0.98 - 0.22 * kb) * c, 0, 0.10 * c);
      this._add(BI.upLegR, (-0.98 + 0.22 * kb) * c, 0, -0.10 * c);
      this._add(BI.loLegL, (1.62 + 0.30 * kb) * c, 0, 0);
      this._add(BI.loLegR, (1.62 - 0.30 * kb) * c, 0, 0);
      this._add(BI.footL, -0.60 * c, 0, 0);
      this._add(BI.footR, -0.60 * c, 0, 0);
      this._add(BI.spine, 0.22 * c, 0, 0.05 * kb * c);
      this._add(BI.hips, 0.16 * c, 0.10 * kb * c, 0);
    }
    // a small permanent torso lean, per man - nobody stands plumb
    this._add(BI.spine, this.pose.lean, 0, this.pose.lean * 0.7);

    // Upper body turns toward the aim direction; the legs stay on the yaw. With
    // a bladed stance the legs are DELIBERATELY 25-40 degrees off the aim axis,
    // so the spine and chest have to recover the whole of that offset or the
    // shoulders never come back square onto the target. 0.30 + 0.45 = 0.75 left
    // a permanent 15-degree residual; the extra term closes it once shouldered.
    var aimYaw = Math.atan2(this.aimDir.x, this.aimDir.z);
    var dYaw = M.wrapAngle(aimYaw - this.yaw);
    var aimPitch = Math.asin(M.clamp(this.aimDir.y, -1, 1));
    var up = a.weaponUp;
    this._add(BI.spine, aimPitch * 0.18 * up, dYaw * (0.30 + 0.10 * up), 0);
    this._add(BI.chest, aimPitch * 0.30 * up + 0.05 * up, dYaw * (0.45 + 0.15 * up), 0);
    // recoil absorbs through the shoulder and rocks the chest back
    this._add(BI.chest, -a.recoil * 0.16, 0, 0);
    this._add(BI.clavR, -a.recoil * 0.10, 0, a.recoil * 0.08);
    // cheek weld: the head tips down and rolls onto the stock when shouldered
    this._add(BI.head, 0.10 * up, 0, -0.075 * up);
    this._add(BI.clavR, -0.16 * up, 0.10 * up, 0);
    this._add(BI.clavL, -0.10 * up, -0.16 * up, 0);
    // lean out of cover
    if (a.peek) {
      this._add(BI.spine, 0, 0, -a.peek * 0.16);
      this._add(BI.hips, 0, 0, -a.peek * 0.10);
    }

    if (this.state !== 'idle' && this.state !== 'patrol') {
      a.headTargetYaw = M.clamp(dYaw * 0.6, -0.9, 0.9);
      a.headTargetPitch = M.clamp(aimPitch * 0.7, -0.5, 0.5);
    }
    this._poseImpulses(dt);
    this._poseHead(dt);
    this._applyPose();

    this.group.updateMatrixWorld(true);

    // ---- IK --------------------------------------------------------------
    var s = this.scale;
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    _lft.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // always run the pelvis/foot solve (it is what keeps them on the ground);
    // only the ground raycasts are reserved for nearby agents
    this._footIK(dt, near);

    // Weapon aim direction, blended between a low carry and a shouldered aim.
    // -0.78 rad is 45 degrees below horizontal: that is a muzzle pointed at the
    // man's own boots, not a low ready. A real low ready is 25-30 degrees, and
    // at 45 the support hand could not reach the rail at all, which is what
    // tripped the gripLock path and produced a two-handed rifle carried
    // one-handed in the hero portrait.
    // A vertical muzzle on the body midline is the other half of the mannequin
    // read. The carry now sits off the strong-side hip and the muzzle tips
    // down-and-outboard rather than standing up the centreline.
    _v0.copy(this.aimDir);
    var cYaw = this.yaw + 0.24 + 0.22 * (1 - up), cPitch = -0.42 - 0.10 * (1 - up);
    _v1.set(Math.sin(cYaw) * Math.cos(cPitch), Math.sin(cPitch), Math.cos(cYaw) * Math.cos(cPitch));
    _v1.lerp(_v0, up).normalize();
    quatLookZ(_v1, _Q);
    _Q.multiply(_q3.setFromAxisAngle(_v2.set(0, 0, 1), -0.06 - 0.05 * up));   // weapon cant

    worldPosOf(this.bones[BI.head], _v4);
    worldPosOf(this.bones[BI.chest], _v5);
    worldPosOf(this.bones[BI.armR], _v3);
    // Low ready: the hand must stay well clear of the chest or the elbow folds
    // past its minimum reach and the arm flies out sideways.
    _anchor.copy(_v5)
      .addScaledVector(_fwd, 0.34 * s).addScaledVector(_lft, -0.21 * s)
      .addScaledVector(UPY, -0.14 * s);
    _ref.copy(W_RECEIVER).multiplyScalar(s);
    _handPos.copy(_anchor).sub(_v2.copy(_ref).applyQuaternion(_Q));

    if (up > 0.01) {
      // Shouldered. Two constraints, blended: the buttstock wants to sit in the
      // shoulder pocket and the optic wants to sit on the eye line. Solving
      // only for the sight floats the whole rifle up beside the head; solving
      // only for the stock drops it below the chin. The blend reads correctly.
      _v6.copy(_v3).addScaledVector(UPY, 0.085 * s)
        .addScaledVector(_fwd, 0.03 * s).addScaledVector(_lft, 0.015 * s);
      _v6.sub(_v2.copy(W_BUTT).multiplyScalar(s).applyQuaternion(_Q));
      _v7.copy(_v4).addScaledVector(UPY, 0.055 * s)
        .addScaledVector(_lft, -0.034 * s).addScaledVector(_v1, 0.09 * s);
      _v7.sub(_v2.copy(W_SIGHT).multiplyScalar(s).applyQuaternion(_Q));
      _v6.lerp(_v7, 0.35);
      _handPos.lerp(_v6, up);
    }
    _handPos.addScaledVector(_v1, -a.recoil * 0.055 * s);

    // ---- close the IK loop ------------------------------------------------
    // solveTwoBone clamps an unreachable target instead of refusing it, so an
    // out-of-reach foregrip does not fail - it silently leaves the support arm
    // stretched straight with the hand short of the rail, and the rifle reads
    // as held by nothing. Pull the WEAPON back to the hands instead: the firing
    // arm has slack, the support arm does not.
    if (a.grip > 0.5) {
      worldPosOf(this.bones[BI.armL], _v8);
      var reachL = (this.bones[BI.foreL].position.length() +
        BLOCAL[BI.handL].length() * s) * 0.94;
      _m0.compose(_handPos, _Q, ONE);
      _v9.copy(W_FOREGRIP).multiplyScalar(s).applyMatrix4(_m0);
      var over = _v9.distanceTo(_v8) - reachL;
      // The old fallback RELEASED the support hand and capped weaponUp at 0.30,
      // producing exactly the "two-handed weapon held in one hand, support hand
      // gripping air" that its own comment said it existed to prevent - the
      // failure path WAS the failure mode. Rather than build a slung carry that
      // the rigid handR binding cannot express (the carbine is skinned to the
      // hand, so a slung rifle would drag the hand onto the chest with it), the
      // fix is to make the reach always close: pull the weapon back along its
      // own axis as far as needed. The firing arm has slack, the support arm
      // does not, so the rifle moves and both hands stay on it.
      if (over > 0) {
        _handPos.addScaledVector(_v1, -Math.min(over * 1.25, 0.26 * s));
        if (over > 0.26 * s) a.gripFail += dt; else a.gripFail = 0;
      } else if (a.gripFail > 0) {
        a.gripFail = Math.max(0, a.gripFail - dt);
      }
      if (a.gripFail > 1.5) {
        a.gripFail = 0;
        GAME.logError('ai.grip',
          'support hand still short of the foregrip on enemy ' + this.id);
      }
    }

    // Firing elbow: down and tucked toward the ribs, not level with the
    // shoulder. Both arms extended level from the shoulder is exactly the
    // "sleepwalker T" the squad was rendering.
    var pv = this.pose;
    _pole.copy(UPY).multiplyScalar(-1.0 - 0.35 * up)
      .addScaledVector(_lft, -0.26 * pv.elbowTuck)
      .addScaledVector(_fwd, -0.10);
    _tipLocal.copy(BLOCAL[BI.handR]).multiplyScalar(s);
    if (solveTwoBone(this.bones[BI.armR], this.bones[BI.foreR], _tipLocal, _handPos, _pole, _ikOut)) {
      // Wrist twist limit. handR's local rotation is the FULL weapon
      // orientation relative to the forearm, which for a shouldered carbine is
      // well past 90 degrees of roll. Applied raw it shears the glove; a real
      // arm rolls the radius over the ulna instead. Decompose into swing +
      // twist about the forearm's own axis, keep +/-75 degrees on the wrist and
      // push the residual back into the forearm's roll.
      _q0.copy(_ikOut.quat).invert().multiply(_Q);
      _v2.copy(BLOCAL[BI.handR]).normalize();
      var resid = clampTwist(_q0, _v2, 1.31);
      if (resid !== 0) {
        _q1.setFromAxisAngle(_v2, resid);
        this.bones[BI.foreR].quaternion.multiply(_q1);
        _ikOut.quat.multiply(_q1);
        this.group.updateMatrixWorld(true);
      }
      this.bones[BI.handR].quaternion.copy(_q0);
      _m1.compose(_ikOut.pos, _Q, ONE);
    } else {
      _m1.compose(_handPos, _Q, ONE);
    }
    this.muzzle.copy(W_MUZZLE).multiplyScalar(s).applyMatrix4(_m1);
    this.muzzleDir.set(0, 0, 1).applyQuaternion(_Q);

    // support hand on the vertical foregrip
    if (a.grip > 0.5) {
      _v7.copy(W_FOREGRIP).multiplyScalar(s).applyMatrix4(_m1);
      // Support elbow drops 35-55 degrees below the shoulder line - that
      // asymmetry against the tucked firing elbow is the whole read of a
      // shouldered rifle. Level support elbows are what made these men zombies.
      _pole.copy(UPY).multiplyScalar(-1.0 - 0.55 * pv.elbowDrop * up)
        .addScaledVector(_lft, 0.20).addScaledVector(_fwd, -0.14);
      _tipLocal.copy(BLOCAL[BI.handL]).multiplyScalar(s);
      if (solveTwoBone(this.bones[BI.armL], this.bones[BI.foreL], _tipLocal, _v7, _pole, _ikOut2)) {
        _QL.copy(_Q).multiply(_q3.setFromAxisAngle(_v2.set(0, 0, 1), 1.45));
        _QL.multiply(_q3.setFromAxisAngle(_v2.set(1, 0, 0), 0.30));
        this.bones[BI.handL].quaternion.copy(_ikOut2.quat).invert().multiply(_QL);
      }
    }

    this.group.updateMatrixWorld(true);
    this._updateHitboxes();
    this._updateContact();
  };

  // Foot IK. Two jobs:
  //   1. keep the character standing ON the ground - a purely procedural gait
  //      always leaves both feet slightly airborne at some phase, and floating
  //      characters are the single most obvious animation bug there is;
  //   2. put each planted foot on the real surface under it (kerbs, rubble,
  //      the street camber) and roll the sole onto that surface normal.
  var LEGS = [[0, 0, 0, 0], [0, 0, 0, 0]];
  Enemy.prototype._footIK = function (dt, useRays) {
    var a = this.anim, w = this.sys.world, i;
    LEGS[0][0] = BI.upLegL; LEGS[0][1] = BI.loLegL; LEGS[0][2] = BI.footL;
    LEGS[1][0] = BI.upLegR; LEGS[1][1] = BI.loLegR; LEGS[1][2] = BI.footR;
    var ankleRest = BIND[BI.footL].y * this.scale;      // sole clearance
    var ay = _footTmp.ay, want = _footTmp.want, plant = _footTmp.plant;
    var adjust = 1e9;

    for (i = 0; i < 2; i++) {
      worldPosOf(this.bones[LEGS[i][2]], _v0);
      ay[i] = _v0.y;
      _footTmp.pos[i].copy(_v0);
      var gy;
      if (useRays) {
        gy = w.ground(_v0.x, _v0.z, _v0.y + 0.65, a.footNormal[i]);
        if (Math.abs(gy - this.position.y) > 0.7) gy = this.position.y;   // bad sample
      } else {
        gy = this.position.y;
        a.footNormal[i].set(0, 1, 0);
      }
      want[i] = gy + ankleRest;
      // stance/swing weight straight off the gait phase
      var ph = i === 0 ? a.gait : (a.gait + 0.5) % 1;
      plant[i] = 1 - M.saturate(pgauss(ph, 0.80, 0.15) * 1.7) * a.move;
      if (plant[i] > 0.35) adjust = Math.min(adjust, want[i] - ay[i]);
    }
    if (adjust > 1e8) adjust = Math.min(want[0] - ay[0], want[1] - ay[1]);
    adjust = M.clamp(adjust, -0.40, 0.14);

    // converge the pelvis height; the correction feeds back through next
    // frame's ankle positions, so damping keeps it stable
    var s = this.scale || 1;
    a.pelvisIK = M.damp(a.pelvisIK, a.pelvisIK + adjust / s, 16, dt);
    var applied = (a.pelvisIK - (a.pelvisIKPrev || 0)) * s;
    a.pelvisIKPrev = a.pelvisIK;

    _footTmp.lowest = 1e9;
    for (i = 0; i < 2; i++) {
      var lg = LEGS[i];
      _v0.copy(_footTmp.pos[i]);
      _v0.y = M.lerp(ay[i] + applied, want[i], plant[i] * 0.85);
      if (_v0.y < want[i] - 0.01) _v0.y = want[i] - 0.01;   // never sink
      // sole height, for the contact-shadow tightness
      if (_v0.y - ankleRest < _footTmp.lowest) _footTmp.lowest = _v0.y - ankleRest;
      // knees bend forward, splayed a few degrees outward
      _pole.copy(_fwd).addScaledVector(_lft, i === 0 ? 0.16 : -0.16).normalize();
      _tipLocal.copy(BLOCAL[lg[2]]).multiplyScalar(s);
      if (!solveTwoBone(this.bones[lg[0]], this.bones[lg[1]], _tipLocal, _v0, _pole, _ikOut2)) continue;
      // roll the sole onto the surface normal, weighted by how planted it is
      var n = a.footNormal[i];
      if (n.y < 0.999) {
        _q0.setFromUnitVectors(UPY, n);
        _q1.copy(_ikOut2.quat).multiply(this.bones[lg[2]].quaternion);   // foot world
        _q3.identity();
        _q2.copy(_q0).slerp(_q3, 1 - 0.55 * plant[i]).multiply(_q1);
        this.bones[lg[2]].quaternion.copy(_ikOut2.quat).invert().multiply(_q2);
      }
    }
  };
  var _footTmp = {
    ay: [0, 0], want: [0, 0], plant: [1, 1], pos: [new V3(), new V3()], lowest: 0
  };

  Enemy.prototype._updateHitboxes = function () {
    var b = this.bones, i;
    if (!b) return;
    for (i = 0; i < this.hitboxes.length; i++) {
      var hb = this.hitboxes[i];
      var bone = b[hb.bone];
      if (!bone) continue;
      bone.matrixWorld.decompose(_v0, _q0, _sc);
      hb.quaternion.copy(_q0);
      hb.center.copy(hb.off).applyQuaternion(_q0).add(_v0);
    }
    // broadphase sphere for ballistics: centred between hips and chest so it
    // still contains the feet and the top of the head
    worldPosOf(b[BI.spine], this.boundsCenter);
    this.boundsCenter.y -= 0.12 * this.scale;
    worldPosOf(b[BI.head], _v0);
    this.eye.set(_v0.x, _v0.y + 0.10 * this.scale, _v0.z);
  };

  // ------------------------------------------------------------ perception --
  // Vision cone with distance falloff, a line-of-sight ray (time-sliced by the
  // system) and a reaction delay. Enemies that acquire instantly feel like
  // aimbots; the delay is what makes a firefight readable.
  Enemy.prototype._perceive = function (dt, ctx, allowRay) {
    var sys = this.sys, th = sys.threat;
    this.timeSinceSeen += dt;
    if (!th.valid) { this.canSeeTarget = false; return; }

    _v0.copy(th.chest).sub(this.eye);
    var d = _v0.length();
    var vis = false;
    if (d < sys.viewDistance) {
      _v0.divideScalar(d || 1);
      _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      var cone = _v0.x * _v1.x + _v0.z * _v1.z;
      var alert = this.awareness > 0.55;
      // peripheral vision widens once alert, and is near-total up close
      var need = d < 4 ? -0.4 : (alert ? 0.10 : 0.34);
      if (cone > need) {
        if (allowRay) this._los = !sys.world.blocked(this.eye, th.chest, 0.25);
        vis = this._los;
      }
    }
    // Personal notice delay burns down first. Until it is spent this man has
    // the player inside his cone but has not registered him, and that has to
    // suppress the whole perception result - not just awareness. Leaving
    // canSeeTarget true here let timeOnTarget bank during the delay, so a man
    // who noticed late opened up as accurately as one who noticed immediately
    // and the stagger bought nothing.
    if (vis && this.noticeDelay > 0) {
      this.noticeDelay -= dt * (d < 12 ? 1.8 : 1);
      vis = false;
    }
    this.canSeeTarget = vis;
    if (vis) {
      this.timeSinceSeen = 0;
      this.lastKnown.copy(th.pos);
      this.hasLastKnown = true;
      // detection speed: close, moving, or already suspicious = much faster
      var rate = 2.4 * (1 - M.saturate(d / sys.viewDistance) * 0.65);
      if (th.moving) rate *= 1.45;
      if (th.sprinting) rate *= 1.35;
      if (this.awareness > 0.3) rate *= 1.5;
      this.awareness = M.saturate(this.awareness + rate * dt);
    } else {
      this.awareness = M.saturate(this.awareness - dt * (this.timeSinceSeen > 6 ? 0.20 : 0.06));
    }
  };

  Enemy.prototype.hearNoise = function (pos, loud) {
    if (!this.alive) return;
    var d = this.position.distanceTo(pos);
    if (d > loud) return;
    var gain = (1 - d / loud);
    this.awareness = M.saturate(this.awareness + gain * 0.55);
    if (!this.hasLastKnown || this.timeSinceSeen > 2) {
      // heard, not seen: only a rough bearing, so they investigate wide
      this.lastKnown.copy(pos);
      this.lastKnown.x += this.rng.gaussian(0, 1.2 * (1 - gain) + 0.3);
      this.lastKnown.z += this.rng.gaussian(0, 1.2 * (1 - gain) + 0.3);
      this.hasLastKnown = true;
    }
    if (this.awareness > 0.5 && this.state === 'idle') this.setState('alert');
  };

  Enemy.prototype.suppress = function (amount) {
    this.suppression = M.saturate(this.suppression + amount);
  };

  // ------------------------------------------------------------- behaviour --
  Enemy.prototype.setState = function (s) {
    if (this.state === s) return;
    this.prevState = this.state;
    this.state = s;
    this.stateTime = 0;
    var sys = this.sys;
    if (s === 'alert') { this.reactTimer = sys.reaction * this.rng.range(0.7, 1.5); this._bark('contact'); }
    else if (s === 'engage') {
      // Shouldering and settling before the first round. Without this the man
      // steps out of 'alert' and fires on the same tick the reaction timer
      // expires, which is exactly the aimbot read the reaction delay exists to
      // prevent. Never applied to a burst already in flight.
      if (this.burstLeft <= 0 && this.prevState !== 'suppress') {
        this.burstPause = Math.max(this.burstPause, this.rng.range(0.22, 0.55));
      }
    } else if (s === 'seekCover') this._bark('moving');
    else if (s === 'flank') this._bark('flanking');
    else if (s === 'suppress') this._bark('suppress');
    else if (s === 'retreat') this._bark('fallback');
    if (sys.bus) sys.bus.emit('enemy:state', this, s);
  };

  Enemy.prototype._bark = function (kind) {
    var sys = this.sys;
    if (sys.time - sys.lastBark < 0.9) return;      // squads should not chatter
    sys.lastBark = sys.time;
    if (!sys.ctx || !sys.ctx.audio || !sys.ctx.audio.play) return;
    try {
      sys.ctx.audio.play('bark_' + kind, { position: this.eye, volume: 0.9 });
    } catch (e) { /* audio module may not know this cue */ }
  };

  Enemy.prototype._think = function (ctx) {
    var sys = this.sys, th = sys.threat;
    var a = this.anim;
    var d = th.valid ? this.position.distanceTo(th.pos) : 999;
    var st = this.state;

    // default posture
    a.weaponUpTarget = 0;
    a.grip = 1;
    this.speedWanted = 0;
    this.moveTarget = null;

    if (this.reactTimer > 0) this.reactTimer -= sys.thinkDt;
    this.suppression = Math.max(0, this.suppression - sys.thinkDt * 0.35);

    switch (st) {
      case 'idle':
      case 'patrol':
        a.weaponUpTarget = 0;
        if (this.patrol.length) {
          this.state = 'patrol';
          this.moveTarget = this.patrol[this.patrolIndex % this.patrol.length];
          this.speedWanted = 1.15;
          if (this.position.distanceTo(this.moveTarget) < 1.1) {
            this.patrolIndex++;
            this.moveTarget = null;
            this.speedWanted = 0;
          }
        }
        if (this.awareness > 0.55) this.setState('alert');
        break;

      case 'alert':
        a.weaponUpTarget = 0.75;
        this.speedWanted = 0;
        if (this.hasLastKnown) this._faceTowards(this.lastKnown);
        if (this.reactTimer > 0) break;
        if (this.canSeeTarget) {
          // Shoot, THEN move. Sending every alerted man straight to a cover
          // slot meant the whole squad spent the opening seven seconds running
          // and the player took no fire at all until the engagement was already
          // at knife range. A rifleman who has just been surprised in the open
          // returns fire first; the cover urge lives in 'engage' now.
          this.setState('engage');
        } else if (this.hasLastKnown && this.awareness > 0.4) {
          this.setState('investigate');
        } else if (this.awareness < 0.2) {
          this.setState('patrol');
        }
        break;

      case 'investigate':
        a.weaponUpTarget = 0.9;
        this.moveTarget = this.lastKnown;
        this.speedWanted = 2.2;
        if (this.canSeeTarget && this.reactTimer <= 0) this.setState('seekCover');
        else if (this.position.distanceTo(this.lastKnown) < 1.4 || this.stateTime > 12) {
          this.awareness *= 0.5;
          this.setState('patrol');
        }
        break;

      case 'seekCover':
        a.weaponUpTarget = 0.55;
        if (!this.cover && sys.canQuery(this, 'cover')) {
          this.cover = sys.coverSys.best(this.position, th.valid ? th.pos : this.lastKnown,
            this.id, 5.0, 26, null);
          if (this.cover) this.cover.claim = this.id;
        }
        if (this.cover) {
          this.moveTarget = this.cover.pos;
          this.speedWanted = 3.9;
          if (this.position.distanceTo(this.cover.pos) < 0.75) {
            this.setState('engage');
          }
        } else {
          // No slot available. Do not come straight back here next tick or the
          // man ping-pongs between engage and seekCover and never fires.
          this.coverBlocked = sys.time + 7;
          this.setState(this.canSeeTarget ? 'engage' : 'investigate');
        }
        if (this.stateTime > 9) { this._dropCover(); this.setState('engage'); }
        break;

      case 'engage':
        a.weaponUpTarget = 1;
        this._faceTowards(th.valid ? th.pos : this.lastKnown);
        this._coverBehaviour(sys.thinkDt, d);
        if (!this.cover && this.stateTime > this.coverUrge && sys.wantsCover(this) &&
          sys.time > this.coverBlocked) {
          this.setState('seekCover');
        } else if (this.role === 'flank' && this.stateTime > 1.5 && d > 7) this.setState('flank');
        else if (this.role === 'suppress' && !this.canSeeTarget && this.hasLastKnown &&
          this.timeSinceSeen > 1.5 && this.timeSinceSeen < 9) this.setState('suppress');
        else if (this.health < this.maxHealth * 0.28 && this.rng.bool(0.35) && d < 14) {
          this.setState('retreat');
        } else if (!this.canSeeTarget && this.timeSinceSeen > (this.cover ? 13 : 7) &&
          this.coverPeek > 0.5) {
          // only give up after actually leaning out and finding nobody there
          this.setState('investigate');
        } else if (this.cover && this.canSeeTarget && this.timeSinceSeen < 0.4 &&
          this.stateTime > 6 && this._coverCompromised()) {
          this.setState('reposition');
        }
        break;

      case 'suppress':
        // fire on the last known position to pin the player while others move
        a.weaponUpTarget = 1;
        this._faceTowards(this.lastKnown);
        this._coverBehaviour(sys.thinkDt, d);
        this.coverPeek = 1;
        if (this.canSeeTarget || this.timeSinceSeen > 9 || this.role !== 'suppress') {
          this.setState('engage');
        }
        break;

      case 'reposition':
      case 'flank': {
        a.weaponUpTarget = 0.6;
        var goal = null;
        if (st === 'flank') {
          goal = sys.flankPosition(this, th.valid ? th.pos : this.lastKnown, this.rng);
        } else if (sys.canQuery(this, 'cover')) {
          var old = this.cover;
          this._dropCover();
          this.cover = sys.coverSys.best(this.position, th.valid ? th.pos : this.lastKnown,
            this.id, 6, 22, old);
          if (this.cover) { this.cover.claim = this.id; goal = this.cover.pos; }
        } else if (this.cover) goal = this.cover.pos;
        if (goal) {
          this.moveTarget = goal;
          this.speedWanted = 4.3;
          if (this.position.distanceTo(goal) < 1.0) this.setState('engage');
        }
        if (this.stateTime > 10) this.setState('engage');
        break;
      }

      case 'retreat':
        a.weaponUpTarget = 0.5;
        if (!this.retreatPos && sys.canQuery(this, 'cover')) {
          this._dropCover();
          this.cover = sys.coverSys.best(this.position, th.valid ? th.pos : this.lastKnown,
            this.id, 16, 40, null);
          if (this.cover) { this.cover.claim = this.id; this.retreatPos = this.cover.pos; }
        }
        if (this.retreatPos) {
          this.moveTarget = this.retreatPos;
          this.speedWanted = 4.6;
          if (this.position.distanceTo(this.retreatPos) < 1.2) {
            this.retreatPos = null;
            this.setState('engage');
          }
        } else if (this.stateTime > 3) this.setState('engage');
        break;
    }

    // A stationary, alert combatant always has both hands on the weapon. The
    // hero portrait is exactly that case and it was rendering a two-handed
    // rifle carried one-handed with the support hand gripping air.
    if (this.awareness > 0.5 && this.speedWanted < 0.5) a.grip = 1;

    // crouch/peek posture targets
    var wantCrouch = 0;
    if (this.cover && this.cover.low && (this.state === 'engage' || this.state === 'suppress')) {
      wantCrouch = this.coverPeek > 0.5 ? 0.25 : 0.95;
    }
    if (this.suppression > 0.6) wantCrouch = Math.max(wantCrouch, 0.7);
    if (this.reload > 0 && this.cover) wantCrouch = Math.max(wantCrouch, 0.85);
    // a capture-seeded posture has to survive the first think tick, or the
    // whole squad springs back upright half a second into the shot
    if (this.captureCrouch) wantCrouch = Math.max(wantCrouch, this.captureCrouch);
    this.crouchWanted = wantCrouch;
  };

  Enemy.prototype._dropCover = function () {
    if (this.cover) { this.cover.claim = -1; this.cover = null; }
  };

  Enemy.prototype._coverCompromised = function () {
    if (!this.cover) return false;
    var th = this.sys.threat;
    if (!th.valid) return false;
    _v0.set(th.pos.x - this.cover.pos.x, 0, th.pos.z - this.cover.pos.z).normalize();
    return (this.cover.normal.x * _v0.x + this.cover.normal.z * _v0.z) > -0.05;
  };

  // Pop out to shoot, duck back to reload. This rhythm is the single biggest
  // reason cover-based AI reads as competent rather than as a wall of targets.
  Enemy.prototype._coverBehaviour = function (dt, dist) {
    if (!this.cover) { this.coverPeek = 1; return; }
    this.peekTimer -= dt;
    if (this.peekTimer <= 0) {
      if (this.coverPeek > 0.5) {
        this.coverPeek = 0;
        this.peekTimer = this.rng.range(0.9, 2.4) * (this.suppression > 0.4 ? 1.8 : 1);
      } else if (this.reload <= 0 && this.ammo > 0) {
        this.coverPeek = 1;
        this.peekSide = this.rng.bool(0.7) ? this.peekSide : -this.peekSide;
        this.peekTimer = this.rng.range(1.1, 2.6);
      } else {
        this.peekTimer = 0.4;
      }
    }
    if (this.reload > 0) this.coverPeek = 0;
  };

  Enemy.prototype._faceTowards = function (p) {
    this.desiredYaw = Math.atan2(p.x - this.position.x, p.z - this.position.z);
  };

  // -------------------------------------------------------------- movement --
  Enemy.prototype._move = function (dt, ctx) {
    var sys = this.sys, a = this.anim;
    var goal = this.moveTarget;
    var wp = null;

    if (goal) {
      // repath when the goal drifts, the path runs out, or it goes stale
      if (!this.path.length || this.pathGoal.distanceToSquared(goal) > 4 || this.pathAge > 2.5) {
        if (!this.pathPending && sys.canQuery(this, 'path')) {
          this.pathGoal.copy(goal);
          this.pathAge = 0;
          sys.requestPath(this, goal);
        }
      }
      this.pathAge += dt;
      if (this.path.length) {
        while (this.pathIndex < this.path.length - 1 &&
          horizDist2(this.position, this.path[this.pathIndex]) < 0.5) this.pathIndex++;
        wp = this.path[this.pathIndex];
        if (this.pathIndex === this.path.length - 1 && horizDist2(this.position, wp) < 0.35) {
          wp = null;
        }
      } else {
        wp = goal;      // no nav grid: steer straight at it and slide on walls
      }
    } else {
      this.path.length = 0;
      this.pathIndex = 0;
    }

    // ---- desired velocity ------------------------------------------------
    _v0.set(0, 0, 0);
    if (wp && this.speedWanted > 0.01) {
      _v0.set(wp.x - this.position.x, 0, wp.z - this.position.z);
      var dd = _v0.length();
      if (dd > 0.001) {
        _v0.divideScalar(dd);
        // ease into the last metre so they do not overshoot cover
        _v0.multiplyScalar(this.speedWanted * M.saturate(dd / 1.2));
      }
    }
    // lateral step out of cover to shoot
    if (this.cover && this.coverPeek > 0.5 && this.state !== 'seekCover') {
      _v1.set(-this.cover.normal.z, 0, this.cover.normal.x).multiplyScalar(this.peekSide * 0.55);
      _v2.copy(this.cover.pos).add(_v1).sub(this.position);
      _v2.y = 0;
      if (_v2.lengthSq() > 0.02) _v0.addScaledVector(_v2.normalize(), 1.5);
    }

    // ---- local avoidance: squadmates and geometry -------------------------
    var others = sys.enemies;
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (o === this || !o.alive) continue;
      var dx = this.position.x - o.position.x, dz = this.position.z - o.position.z;
      var d2 = dx * dx + dz * dz;
      if (d2 > 1.44 || d2 < 1e-6) continue;
      var f = (1.2 - Math.sqrt(d2)) * 2.6;
      _v0.x += (dx / Math.sqrt(d2)) * f;
      _v0.z += (dz / Math.sqrt(d2)) * f;
    }
    if (sys.threat.valid) {
      // never walk into the player's face
      var pdx = this.position.x - sys.threat.pos.x, pdz = this.position.z - sys.threat.pos.z;
      var pd2 = pdx * pdx + pdz * pdz;
      if (pd2 < 2.25 && pd2 > 1e-5) {
        var pf = (1.5 - Math.sqrt(pd2)) * 3.0 / Math.sqrt(pd2);
        _v0.x += pdx * pf; _v0.z += pdz * pf;
      }
    }

    var maxSp = Math.max(this.speedWanted, 0.6);
    if (_v0.lengthSq() > maxSp * maxSp) _v0.setLength(maxSp);

    // ---- integrate --------------------------------------------------------
    var accel = this.speedWanted > 3 ? 11 : 8;
    this.velocity.x = M.damp(this.velocity.x, _v0.x, accel, dt);
    this.velocity.z = M.damp(this.velocity.z, _v0.z, accel, dt);
    if (Math.abs(this.velocity.x) < 0.02) this.velocity.x = 0;
    if (Math.abs(this.velocity.z) < 0.02) this.velocity.z = 0;

    var beforeX = this.position.x, beforeZ = this.position.z;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this._resolveCollisions();

    // stuck detection - a jammed agent that keeps pushing looks broken
    var movedSq = (this.position.x - beforeX) * (this.position.x - beforeX) +
      (this.position.z - beforeZ) * (this.position.z - beforeZ);
    if (this.speedWanted > 0.5 && movedSq < 1e-5) {
      this.stuck += dt;
      if (this.stuck > 0.9) {
        this.stuck = 0;
        this.path.length = 0;
        this.pathAge = 99;
        this.peekSide = -this.peekSide;
      }
    } else this.stuck = 0;

    // ---- ground -----------------------------------------------------------
    this.groundTimer = (this.groundTimer || 0) - dt;
    if (this.groundTimer <= 0) {
      this.groundTimer = 0.10 + this.rng.next() * 0.05;
      this.groundY = sys.world.ground(this.position.x, this.position.z,
        this.position.y + 1.2, this.groundNormal);
    }
    this.position.y = M.damp(this.position.y, this.groundY, 14, dt);

    // ---- facing -----------------------------------------------------------
    var sp2 = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    var aiming = a.weaponUpTarget > 0.5 || this.state === 'engage' || this.state === 'suppress';
    if (!aiming && sp2 > 0.09) {
      this.desiredYaw = Math.atan2(this.velocity.x, this.velocity.z);
    } else if (aiming && sys.threat.valid && (this.canSeeTarget || this.hasLastKnown)) {
      var tp = this.canSeeTarget ? sys.threat.pos : this.lastKnown;
      // Bladed stance: nobody shoots square-on. The hips sit 24-40 degrees off
      // the aim axis (sign and magnitude per man) and the spine/chest counter-
      // rotate to bring the shoulders back onto the target - which is what puts
      // one foot forward, breaks the shoulder line and stops four men reading
      // as four copies of the same statue.
      this.desiredYaw = Math.atan2(tp.x - this.position.x, tp.z - this.position.z) +
        this.pose.blade * a.weaponUp;
    } else if (sp2 > 0.25) {
      this.desiredYaw = Math.atan2(this.velocity.x, this.velocity.z);
    }
    this.yaw = M.dampAngle(this.yaw, this.desiredYaw, aiming ? 7 : 5, dt);
    this.group.rotation.y = this.yaw;

    // posture blends
    a.crouch = M.damp(a.crouch, this.crouchWanted || 0, 6, dt);
    a.peek = M.damp(a.peek, this.cover && this.coverPeek > 0.5 ? this.peekSide * 0.8 : 0, 5, dt);
    a.grip = (a.weaponUp > 0.35 || sp2 < 9) ? 1 : 0;
  };

  function horizDist2(a, b) {
    var dx = a.x - b.x, dz = a.z - b.z;
    return dx * dx + dz * dz;
  }

  Enemy.prototype._resolveCollisions = function () {
    var w = this.sys.world;
    if (!w.hash) return;
    var r = 0.32 * this.scale, h = 1.72 * this.scale;
    _v3.set(this.position.x - r - 0.1, this.position.y - 0.1, this.position.z - r - 0.1);
    _v4.set(this.position.x + r + 0.1, this.position.y + h + 0.1, this.position.z + r + 0.1);
    var list = w.hash.query(_v3, _v4, w.tmpList);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.halfExtents) continue;
      var depth = GAME.Collision.capsuleBoxMTV(this.position, r, h, c, _v5);
      if (depth > 0) {
        // horizontal-only response: vertical is owned by the ground sampler,
        // otherwise agents get launched by kerbs
        _v5.y = 0;
        var l = _v5.length();
        if (l > 1e-5) {
          _v5.multiplyScalar(depth / l);
          this.position.x += _v5.x;
          this.position.z += _v5.z;
          var vd = this.velocity.x * _v5.x + this.velocity.z * _v5.z;
          if (vd < 0) {
            this.velocity.x -= _v5.x * vd / (depth * depth || 1);
            this.velocity.z -= _v5.z * vd / (depth * depth || 1);
          }
        }
      }
    }
  };

  // ---------------------------------------------------------------- combat --
  Enemy.prototype._aimUpdate = function (dt, ctx) {
    var sys = this.sys, th = sys.threat, a = this.anim;
    var target = null;
    if (this.canSeeTarget && th.valid) target = th.chest;
    else if (this.hasLastKnown && (this.state === 'engage' || this.state === 'suppress' ||
      this.state === 'alert' || this.state === 'investigate')) {
      _v6.copy(this.lastKnown); _v6.y += 1.25;
      target = _v6;
    }
    if (target) {
      this.aimTarget.copy(target);
      _v0.copy(target).sub(this.eye).normalize();
      // convergence rate: snappier once they have been on target a while
      var rate = 4.5 + 5.5 * M.saturate(this.timeOnTarget * 0.8);
      this.aimDir.lerp(_v0, 1 - Math.exp(-rate * dt)).normalize();
    } else {
      _v0.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.aimDir.lerp(_v0, 1 - Math.exp(-3 * dt)).normalize();
    }

    // TIME ON TARGET is the whole difficulty curve, so it is deliberately hard
    // to bank. Standing still in the open is what lets an enemy dial you in;
    // walking cuts his rate by more than half and sprinting all but stops it,
    // which is what makes "keep moving" the correct answer to being shot at
    // instead of a superstition.
    if (this.canSeeTarget) {
      var g = 1;
      if (th.sprinting) g = 0.10;
      else if (th.moving) g = 0.28;
      if (this.anim.speed > 0.6) g *= 0.55;          // he is moving too
      if (this.suppression > 0.35) g *= 0.45;
      this.timeOnTarget = Math.min(this.sys.aimTime * 2.5,
        this.timeOnTarget + g * this.skill * dt);
    } else {
      this.timeOnTarget = Math.max(0, this.timeOnTarget - dt * 2.2);
    }
  };

  // Angular scatter of a single round, in radians. This is the *grouping*, not
  // the aiming error - see aimError() for the part that decides whether the
  // group is centred on the player at all.
  Enemy.prototype.spread = function () {
    var sys = this.sys;
    var s = sys.baseSpread * Math.exp(-this.timeOnTarget / sys.aimTime) + sys.minSpread;
    s *= 1 + this.suppression * 1.6;
    if (this.anim.speed > 0.6) s *= 1.7;
    if (this.state === 'suppress') s *= 2.2;
    if (this.anim.crouch > 0.5) s *= 0.85;
    return s;
  };

  // Aiming error expressed in METRES at the target, not in radians.
  //
  // An angular cone alone cannot express "the first burst goes wide": at 5 m a
  // 5-degree cone is 0.4 m across, which is the width of the player, so a man
  // who spawns in your face lands every round no matter how bad his cone is.
  // That is precisely how the old model killed the player in 1.35 s from 5.3 m.
  // A range-independent lateral error does what a real time-on-target ramp
  // does: the opening burst walks past you by a metre or two whether it is
  // fired from across the street or from the next doorway, and only closes if
  // you stay still and exposed long enough for him to correct.
  Enemy.prototype.aimError = function () {
    var sys = this.sys;
    var k = Math.exp(-this.timeOnTarget / sys.aimTime);
    var e = sys.aimErrorMin + (sys.aimErrorStart - sys.aimErrorMin) * k;
    e /= this.skill;
    e *= 1 + this.suppression * 1.3;
    if (this.anim.speed > 0.6) e *= 1.6;
    if (this.state === 'suppress') e *= 2.4;         // suppressors shoot NEAR you
    if (this.anim.crouch > 0.5) e *= 0.88;
    return e;
  };

  Enemy.prototype._combat = function (dt, ctx) {
    var sys = this.sys, th = sys.threat, a = this.anim;
    this._aimUpdate(dt, ctx);

    if (this.reload > 0) {
      this.reload -= dt;
      if (this.reload <= 0) { this.ammo = this.weapon.magSize; this.burstPause = 0.35; }
      return;
    }
    if (this.ammo <= 0) {
      this.reload = 2.4 + this.rng.range(0, 0.5);
      this._bark('reloading');
      this.coverPeek = 0;
      this.peekTimer = Math.max(this.peekTimer, this.reload);
      return;
    }

    var mayFire = a.weaponUp > 0.62 && this.reactTimer <= 0 &&
      (this.state === 'engage' || this.state === 'suppress') &&
      (this.cover ? this.coverPeek > 0.5 : true) && sys.canFire(this);
    if (this.state === 'engage' && !this.canSeeTarget) mayFire = false;
    if (this.state === 'suppress' && !this.hasLastKnown) mayFire = false;
    // do not fire until the weapon is actually pointing at the target
    if (mayFire && th.valid) {
      _v0.copy(this.aimTarget).sub(this.eye).normalize();
      if (_v0.dot(this.aimDir) < 0.985) mayFire = false;
    }

    if (this.burstLeft > 0) {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) {
        this._shoot(ctx);
        this.burstLeft--;
        this.burstShot++;
        this.fireTimer = 60 / this.weapon.rpm;
        if (this.burstLeft <= 0) {
          var far = th.valid ? this.position.distanceTo(th.pos) : 20;
          // Long enough to be a rhythm the player can read and move inside.
          // 0.42-1.25 s against a 0.58 s burst was a ~45% duty cycle per man.
          this.burstPause = this.rng.range(0.70, 1.60) + M.saturate((far - 12) / 40);
          if (this.state === 'suppress') this.burstPause *= 0.8;
        }
      }
    } else if (mayFire) {
      this.burstPause -= dt;
      if (this.burstPause <= 0) {
        var n = this.rng.int(this.weapon.burstMin, this.weapon.burstMax);
        if (this.state === 'suppress') n += 2;
        this.burstLeft = Math.min(n, this.ammo);
        this.burstShot = 0;
        this.fireTimer = 0;
        // A fresh burst is thrown off in ONE direction and stays there for the
        // length of the burst. That reads as "he has not got my range yet";
        // re-rolling per round just reads as noise and lands a hit or two by
        // accident anyway. Unit-ish magnitude; aimError() supplies the metres.
        //
        // The vertical term is deliberately skewed UP. The player capsule is
        // 1.8 m tall and the aim point is his chest at 1.30 m, so a round that
        // goes a metre low still hits him in the shin - a symmetric error is
        // nearly twice as lethal as it looks. High and wide is also what an
        // unsupported rifle actually does.
        this.aimBias.set(this.rng.gaussian(0, 1), this.rng.gaussian(0.42, 0.72),
          this.rng.gaussian(0, 1));
        var bl = this.aimBias.length() || 1;
        this.aimBias.multiplyScalar(this.rng.range(0.72, 1.35) / bl);
      }
    }

    // grenades: only against a player who is dug in, and never into a teammate
    this.grenadeCd -= dt;
    if (this.grenades > 0 && this.grenadeCd <= 0 && this.state === 'engage' &&
      th.valid && this.hasLastKnown && sys.canThrow(this)) {
      var d = this.position.distanceTo(th.pos);
      if (d > 7 && d < 26 && this.timeSinceSeen < 4) {
        this.grenades--;
        this.grenadeCd = this.rng.range(14, 26);
        sys.throwGrenade(this, this.lastKnown);
        this._bark('grenade');
      } else {
        this.grenadeCd = 2.5;
      }
    }
  };

  // Ray vs a vertical capsule - the player's collision volume.
  function rayCapsuleY(ro, rd, base, radius, height) {
    var ox = ro.x - base.x, oz = ro.z - base.z;
    var a = rd.x * rd.x + rd.z * rd.z;
    var best = -1;
    if (a > 1e-9) {
      var b = 2 * (ox * rd.x + oz * rd.z);
      var c = ox * ox + oz * oz - radius * radius;
      var disc = b * b - 4 * a * c;
      if (disc >= 0) {
        var sq = Math.sqrt(disc);
        var t0 = (-b - sq) / (2 * a), t1 = (-b + sq) / (2 * a);
        var t = t0 >= 0 ? t0 : t1;
        if (t >= 0) {
          var y = ro.y + rd.y * t - base.y;
          if (y >= radius && y <= height - radius) best = t;
        }
      }
    }
    _v9.set(base.x, base.y + radius, base.z);
    var ts = GAME.Collision.raycastSphere(ro, rd, _v9, radius, null);
    if (ts >= 0 && (best < 0 || ts < best)) best = ts;
    _v9.set(base.x, base.y + height - radius, base.z);
    ts = GAME.Collision.raycastSphere(ro, rd, _v9, radius, null);
    if (ts >= 0 && (best < 0 || ts < best)) best = ts;
    return best;
  }

  Enemy.prototype._shoot = function (ctx) {
    var sys = this.sys, th = sys.threat;
    var origin = _v7.copy(this.muzzle);
    // aim from the actual muzzle at the actual target, then add the error cone
    _v8.copy(this.aimTarget).sub(origin);
    var dist = _v8.length() || 1;
    _v8.divideScalar(dist);
    var spread = this.spread();
    this.rng.inCone(_v8, spread, _v6);
    // Lateral aiming error, converted from metres-at-the-target into radians
    // for THIS range. Held below 6 m so a point-blank enemy is dangerous rather
    // than comically incompetent, but never so tight that a spawn-camping
    // militiaman is an instant kill.
    var err = this.aimError();
    if (dist < 8) err *= M.lerp(0.55, 1, M.saturate((dist - 2.5) / 5.5));
    var biasAmt = Math.min(0.30, err / Math.max(1.5, dist));
    _v6.addScaledVector(this.aimBias, biasAmt);
    // muzzle climb across the burst: round five is a full degree high
    _v6.y += (this.weapon.climb || 0.011) * this.burstShot;
    _v6.normalize();

    this.ammo--;
    this.anim.recoilV += 7.5;
    this.addImpulse(BI.chest, -0.35, this.rng.range(-0.1, 0.1), 0, false);
    this.addImpulse(BI.head, -0.10, 0, 0, false);
    this.suppression = Math.max(0, this.suppression - 0.05);

    var maxD = 150;
    var wallT = sys.world.raycast(origin, _v6, maxD, _rayHit);
    var hitPoint = _v5;
    var hitPlayer = false;
    if (th.valid) {
      var pT = rayCapsuleY(origin, _v6, th.pos, 0.34, th.height);
      if (pT >= 0 && (wallT < 0 || pT < wallT)) {
        hitPlayer = true;
        hitPoint.copy(origin).addScaledVector(_v6, pT);
      }
    }
    if (!hitPlayer) {
      if (wallT >= 0) hitPoint.copy(_rayHit.point);
      else hitPoint.copy(origin).addScaledVector(_v6, maxD);
    }

    // ---- feedback ---------------------------------------------------------
    var c = sys.ctx || ctx;
    if (c) {
      if (c.vfx) {
        try {
          if (c.vfx.muzzleFlash) c.vfx.muzzleFlash(origin, this.muzzleDir, this.weapon);
          if (c.vfx.tracer) c.vfx.tracer(origin, hitPoint, 260);
          if (c.vfx.ejectShell) c.vfx.ejectShell(origin, this.muzzleDir, this.weapon);
          if (!hitPlayer && wallT >= 0 && c.vfx.impact) {
            c.vfx.impact(hitPoint, _rayHit.normal, 'concrete');
            if (c.vfx.decal) c.vfx.decal(hitPoint, _rayHit.normal, 'bullet', 0.06);
          }
        } catch (e) { GAME.logError('ai.vfx', e); }
      }
      if (c.audio) {
        try {
          if (c.audio.playGunshot) c.audio.playGunshot(this.weapon, origin);
          else if (c.audio.play) c.audio.play('gunshot', { position: origin });
        } catch (e) { /* audio optional */ }
      }
      // Under capture the squad is seeded straight into a firefight, so at
      // 12 m four men land rounds on the player within the first second and the
      // HUD paints the whole frame red. The flashes and the tracers are the
      // point of the shot; the damage vignette is not.
      if (hitPlayer && c.capture) hitPlayer = false;
      // Pacing: a round inside the window falls through to the near-miss branch
      // below, so it still cracks past him and still suppresses.
      if (hitPlayer && !sys.allowPlayerHit(c.player)) hitPlayer = false;
      if (hitPlayer && c.player && c.player.takeDamage) {
        _v4.copy(this.eye).sub(th.pos).normalize();
        var dmg = this.weapon.damage * sys.damageScale *
          M.lerp(1, 0.62, M.saturate((dist - 25) / 55));
        try { c.player.takeDamage(dmg, _v4); } catch (e) { GAME.logError('ai.damagePlayer', e); }
        if (c.hud && c.hud.damageIndicator) {
          try { c.hud.damageIndicator(_v4); } catch (e) { /* hud optional */ }
        }
      } else if (th.valid) {
        // near miss: crack past the player's head and suppress them
        _v4.copy(th.chest).sub(origin);
        var along = _v4.dot(_v6);
        if (along > 0) {
          _v4.addScaledVector(_v6, -along);
          if (_v4.lengthSq() < 2.2) {
            if (sys.bus) sys.bus.emit('enemy:nearmiss', this, _v4.length());
            if (c.audio && c.audio.play) {
              try { c.audio.play('bullet_snap', { position: th.chest, volume: 0.7 }); }
              catch (e) { /* optional */ }
            }
          }
        }
      }
    }
    if (sys.bus) sys.bus.emit('enemy:fired', this, origin, _v6);
  };

  // ---------------------------------------------------------------- damage --
  var HIT_TO_PARTICLE = {
    head: RPI.head, neck: RPI.head, chest: RPI.chest, stomach: RPI.pelvis,
    pelvis: RPI.pelvis, armL: RPI.elL, forearmL: RPI.wrL, armR: RPI.elR,
    forearmR: RPI.wrR, thighL: RPI.knL, shinL: RPI.anL, footL: RPI.anL,
    thighR: RPI.knR, shinR: RPI.anR, footR: RPI.anR
  };
  var HIT_TO_BONE = {
    head: 'head', neck: 'neck', chest: 'chest', stomach: 'spine', pelvis: 'hips',
    armL: 'armL', forearmL: 'foreL', armR: 'armR', forearmR: 'foreR',
    thighL: 'upLegL', shinL: 'loLegL', footL: 'footL',
    thighR: 'upLegR', shinR: 'loLegR', footR: 'footR'
  };

  // amount   raw weapon damage
  // hitPart  a hitbox object from enemy.hitboxes, or its name string
  // direction world-space travel direction of the round
  Enemy.prototype.takeDamage = function (amount, hitPart, direction) {
    if (!this.alive) return 0;
    var name = 'chest', mult = 1, hb = null, i;
    if (typeof hitPart === 'string') name = hitPart;
    else if (hitPart && hitPart.name) { name = hitPart.name; hb = hitPart; }
    if (!hb) {
      for (i = 0; i < this.hitboxes.length; i++) {
        if (this.hitboxes[i].name === name) { hb = this.hitboxes[i]; break; }
      }
    }
    mult = hb ? hb.mult : (name === 'head' ? 4.6 : 1);
    var dmg = Math.max(0, amount) * mult;
    this.health -= dmg;

    var dir = _v0;
    if (direction && direction.isVector3) dir.copy(direction).normalize();
    else dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(-1);

    // instant hard alert: being shot tells you exactly where the shooter is
    this.awareness = 1;
    this.suppress(0.45);
    if (!this.canSeeTarget && this.sys.threat.valid) {
      this.lastKnown.copy(this.sys.threat.pos);
      this.hasLastKnown = true;
    }
    if (this.state === 'idle' || this.state === 'patrol') {
      this.reactTimer = this.sys.reaction * 0.4;
      this.setState('alert');
    }

    // --- hit reaction: an impulse on the struck part that propagates and damps
    var bname = HIT_TO_BONE[name] || 'chest';
    var bi = BI[bname];
    var mag = M.clamp(dmg / 42, 0.12, 0.9);
    _v1.copy(dir).multiplyScalar(mag);
    // convert the world push into rough local pitch/roll for that bone
    var local = M.wrapAngle(Math.atan2(dir.x, dir.z) - this.yaw);
    this.addImpulse(bi, -Math.cos(local) * mag * 9, 0, Math.sin(local) * mag * 7, true);
    this.anim.stagger.x += Math.sin(local) * mag * 0.05;
    this.anim.stagger.z += Math.cos(local) * mag * 0.05;
    this.timeOnTarget *= 0.4;                 // being hit spoils your aim
    this.burstPause = Math.max(this.burstPause, 0.15);

    var c = this.sys.ctx;
    if (c && c.vfx && c.vfx.bloodSpray) {
      try {
        _v2.copy(hb ? hb.center : this.boundsCenter);
        c.vfx.bloodSpray(_v2, _v3.copy(dir).multiplyScalar(-1));
      } catch (e) { /* vfx optional */ }
    }
    if (this.sys.bus) this.sys.bus.emit('enemy:hit', this, dmg, name);

    if (this.health <= 0) this.die(dir, name, dmg);
    else if (this.rng.bool(0.35)) this._bark('hit');
    return dmg;
  };

  Enemy.prototype.die = function (dir, partName, dmg) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.state = 'dead';
    this.velocity.set(0, 0, 0);
    this._dropCover();
    this.burstLeft = 0;
    this.anim.crouch = 0;

    // ragdoll seeded from the live pose plus the killing blow's momentum
    try {
      var imp = _v4.copy(dir).multiplyScalar(M.clamp(1.2 + dmg * 0.045, 1.4, 5.2));
      imp.y += 1.1 + this.rng.range(0, 0.8);
      var pi = HIT_TO_PARTICLE[partName];
      this.ragdoll = new Ragdoll().start(this.bones, this.scale, imp,
        pi === undefined ? RPI.chest : pi, this.groundY);
    } catch (e) {
      GAME.logError('ai.ragdoll', e);
      this.ragdoll = null;
    }

    var c = this.sys.ctx;
    if (c) {
      if (c.hud && c.hud.addKillfeed) {
        var wname = (c.weapons && c.weapons.current && c.weapons.current.name) || 'M4A1';
        try { c.hud.addKillfeed('YOU', this.name, wname); } catch (e) { /* hud optional */ }
      }
      // ballistics normally owns hitmarkers; only fill in if it is missing
      if (!c.ballistics && c.hud && c.hud.showHitmarker) {
        try { c.hud.showHitmarker('kill'); } catch (e) { /* hud optional */ }
      }
      if (c.audio && c.audio.play) {
        try { c.audio.play('bark_death', { position: this.eye, volume: 1 }); }
        catch (e) { /* audio optional */ }
      }
    }
    if (this.sys.bus) this.sys.bus.emit('enemy:killed', this, partName);
    this.sys.onDeath(this);
  };

  // ------------------------------------------------------------------ tick --
  Enemy.prototype.update = function (dt, ctx, near, allowRay) {
    if (!this.alive) {
      this.dying += dt;
      this.animate(dt, ctx, false);
      return;
    }
    this.stateTime += dt;
    this._perceive(dt, ctx, allowRay);

    this.think -= dt;
    if (this.think <= 0) {
      this.think = this.sys.thinkDt;
      this._think(ctx);
    }
    this._move(dt, ctx);
    this._combat(dt, ctx);
    this.animate(dt, ctx, near);
  };

  Enemy.prototype.dispose = function () {
    var i;
    if (this.contactFeet) {
      for (i = 0; i < this.contactFeet.length; i++) {
        var f = this.contactFeet[i];
        if (f.material && f.material.dispose) f.material.dispose();
        this.group.remove(f);
      }
      this.contactFeet = null;
    }
    if (this.contact) {
      if (this.contact.material && this.contact.material.dispose) this.contact.material.dispose();
      this.group.remove(this.contact);
      this.contact = null;
    }
    if (this.mesh) {
      if (this.mesh.skeleton && this.mesh.skeleton.dispose) this.mesh.skeleton.dispose();
      if (this.group.parent) this.group.parent.remove(this.group);
    }
  };

  // --------------------------------------------------------------------------
  // 11. AI SYSTEM
  // --------------------------------------------------------------------------
  function AISystem(ctx) {
    this.ctx = ctx || null;
    this.enemies = [];
    this.time = 0;
    this.frame = 0;
    this.lastBark = -99;

    // Own RNG stream, derived from the world seed. Forking rather than drawing
    // from ctx.rng keeps captures deterministic no matter what the other
    // systems consume.
    var seed = (ctx && ctx.seed) || 20260801;
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x41694d) : new GAME.RNG(seed ^ 0x41694d);

    this.world = new World();
    this.coverSys = new CoverSystem(this.world);
    this.pathfinder = null;
    this.variants = [];
    this.material = null;        // body: vertex colour only
    this.faceMaterial = null;    // head group: face atlas map + normal map
    this.faceAtlas = null;
    this.materials = null;       // [body, face], handed to the SkinnedMesh
    this.bus = (ctx && ctx.bus) || GAME.bus;

    this.root = new THREE.Group();
    this.root.name = 'ai';
    if (ctx && ctx.scene) ctx.scene.add(this.root);

    this.threat = {
      valid: false, pos: new V3(), chest: new V3(), eye: new V3(),
      height: 1.8, moving: false, sprinting: false, prev: new V3(), inited: false
    };

    // ---- difficulty knobs --------------------------------------------------
    // Measured against tools/playtest.py, not guessed. The previous set killed
    // the player 1.35 s after spawn: two men opened up from 5.3 m with a 0.068
    // rad cone, which at that range is narrower than the player's own hitbox,
    // so 8 of 8 rounds connected for 13 each. Every number below exists to make
    // the OPENING engagement survivable while a dug-in player is still punished.
    this.viewDistance = 72;
    this.reaction = 0.40;       // x0.7-1.5 per man => 280-600 ms before firing
    this.aimTime = 2.3;         // seconds of SETTLED time-on-target to converge
    this.baseSpread = 0.055;    // ~3.2 degrees of grouping on acquisition
    // The floor is deliberately NOT tight. A burst carries one bias for its
    // whole length, so with a 0.6-degree group an on-target burst put every
    // single round into the player - four hits, 44 damage, from one trigger
    // pull. At 1.4 degrees the group is about as wide as the player at 13 m,
    // so a burst that is aimed right still only lands part of itself.
    this.minSpread = 0.028;
    this.aimErrorStart = 1.6;   // metres of lateral miss on first contact
    // The floor matters more than the start: a man who has held line of sight
    // for five seconds is the one who actually kills you. 0.31 m keeps a fully
    // converged rifleman landing roughly one round in four rather than the
    // whole burst, which is the difference between "pinned" and "executed".
    this.aimErrorMin = 0.31;
    this.maxShooters = 2;       // simultaneous bursts on the player
    this.minSpawnRange = 13;    // interactive spawns never land in his lap
    // ---- incoming-fire pacing ----------------------------------------------
    // An accuracy model alone is a coin flip with a long tail: a burst that is
    // aimed right lands ALL of it, so the same tuning produced 22 damage on one
    // run and 88 on the next off nothing but a shifted random stream. This
    // bounds the tail without touching the aiming model. Rounds that would land
    // inside the window are turned into near-misses instead - the player still
    // gets the crack past his ear and the suppression, just not a second health
    // bar's worth of damage inside half a second. The window widens as he gets
    // hurt, which is what gives a losing fight a way out.
    this.hitSpacing = 0.70;
    this.hitSpacingHurt = 1.10;
    this._lastPlayerHit = -99;
    this.damageScale = 1.0;
    this.thinkDt = 0.12;
    this.maxEnemies = 16;

    this._pathQueue = [];
    this._budget = { los: 0, path: 0, cover: 0 };
    this._roleTimer = 0;
    this._grenades = [];
    this._grenadeCd = 0;
    this._lastAmmo = -1;
    this._losCursor = 0;
    this._staged = false;       // capture composition pass has run
    this._capScale = 0;         // shared squad depth compression, see _frameForCapture
    this._night = false;        // wet-night material variant (Cold Harbor)
    // Solved once a frame in _syncKey: the dominant practical over the squad.
    this._key = {
      dir: new V3(0, 0.70, -0.71),          // WORLD direction toward the lamp
      col: new THREE.Color(0.55, 0.20, 0.05),
      bounce: new THREE.Color(0.30, 0.16, 0.08),
      found: false
    };

    this._bindEvents();
  }

  AISystem.prototype._bindEvents = function () {
    var self = this;
    if (!this.bus || !this.bus.on) return;
    // Gunfire is the main stimulus. Module names vary, so listen broadly.
    var names = ['weapon:fired', 'weapon:fire', 'gunshot', 'player:fired', 'shot'];
    var onShot = function (a, b) {
      var p = (a && a.isVector3) ? a : ((b && b.isVector3) ? b : null);
      if (!p && self.threat.valid) p = self.threat.pos;
      if (p) self.hearNoise(p, 55);
    };
    for (var i = 0; i < names.length; i++) this.bus.on(names[i], onShot);
    this.bus.on('explosion', function (a) {
      var p = (a && a.isVector3) ? a : (a && a.point) || null;
      if (p) self.hearNoise(p, 90);
    });
    this.bus.on('player:footstep', function (a) {
      var p = (a && a.isVector3) ? a : null;
      if (p) self.hearNoise(p, 9);
    });
  };

  AISystem.prototype.build = async function (ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    try {
      if (ctx && ctx.scene && this.root.parent !== ctx.scene) ctx.scene.add(this.root);
      this.world.attach(ctx && ctx.level);
      // Which lighting world are we in? Read the LEVEL, not the weather state:
      // `weather` builds one slot before `ai`, but its wetness has not ramped
      // yet at build time (it measures 0.00 here and 1.00 by frame 40), so a
      // wetness test would compile the daylight program for the harbor.
      // levelDef.weather is the declaration and is available from boot.
      var ld = ctx && ctx.levelDef;
      this._night = !!(ctx && (ctx.levelId === 'harbor' ||
        (ld && ld.weather && ld.weather !== 'clear')));
      this.material = makeCharacterMaterial(null, this._night);

      var lv = ctx && ctx.level;
      if (lv && lv.navGrid && lv.navGrid.walkable && lv.navGrid.w > 1) {
        this.pathfinder = new PathFinder(lv.navGrid);
      }
      this.coverSys.build(lv);

      // A handful of pre-built bodies gives visible variety without paying the
      // generation cost per spawn. Each is a separate geometry; all of them
      // share one material and one program. Eight rather than five: with a
      // four-man squad, five bodies means a visible duplicate more often than
      // not, and stature is one of only two silhouette cues at 30 m.
      var count = 8;
      // One shared face atlas, one slot per variant - eight painted faces cost
      // ONE texture pair and ONE extra material, not eight of each.
      this.faceAtlas = new FaceAtlas();
      this.faceAtlas.init();
      for (var i = 0; i < count; i++) {
        this._buildVariant();
        if (GAME.yieldFrame) await GAME.yieldFrame();
      }
      if (this.faceAtlas.ok && this.faceAtlas.commit()) {
        this.faceMaterial = makeCharacterMaterial(this.faceAtlas, this._night);
        this.materials = [this.material, this.faceMaterial];
        for (i = 0; i < this.variants.length; i++) {
          if (this.variants[i].geometry && this.variants[i].geometry.userData.faceGroup) {
            this.variants[i].material = this.materials;
          }
        }
      }

      // populate the level for interactive play; captures spawn explicitly so
      // a screenshot is always reproducible
      if (ctx && !ctx.capture) this._populate(ctx);
    } catch (e) {
      GAME.logError('ai.build', e);
    }
  };

  AISystem.prototype._buildVariant = function () {
    try {
      var rng = this.rng.fork ? this.rng.fork(this.variants.length * 131 + 7) :
        new GAME.RNG(this.variants.length * 131 + 7);
      var look = pickLook(rng);
      // One atlas slot per variant; the head geometry writes a cylindrical UV
      // into it and paintFace() fills it. -1 = no canvas, fall back to the
      // vertex-colour face bake.
      look.faceSlot = (this.faceAtlas && this.faceAtlas.ok &&
        this.variants.length < FACE_SLOTS) ? this.variants.length : -1;
      if (look.faceSlot >= 0) {
        this.faceAtlas.paint(look.faceSlot, look,
          rng.fork ? rng.fork(0xfaceb1 + look.faceSlot * 977) : rng);
      }
      var geo = buildMilitiaman(rng, look);
      var s = look.heightScale;
      if (Math.abs(s - 1) > 1e-4) geo.scale(s, s, s);
      // set the culling bounds AFTER scaling; a tight bind-pose sphere would
      // pop characters out of view when they animate
      geo.boundingSphere = new THREE.Sphere(new V3(0, 1.0 * s, 0), 1.6 * s);
      try { assertRigidHand(geo, s); } catch (ae) { /* assertion must never throw */ }
      // A geometry with face groups MUST get the material array: three renders
      // an array material group by group, so a grouped geometry handed a single
      // material would still draw, but a single-group geometry handed an array
      // would draw nothing at all. build() upgrades these once the atlas is
      // committed; a spawn-time variant built before that keeps the body-only
      // material and simply has no painted face.
      this.variants.push({
        geometry: geo,
        material: (geo.userData.faceGroup && this.materials) ? this.materials : this.material,
        look: look, scale: s, inverses: makeBoneInverses(s)
      });
    } catch (e) {
      GAME.logError('ai.variant', e);
    }
  };

  // Nobody spawns inside the player's opening engagement envelope.
  //
  // The level publishes militia spawns at 6.9 m and 8.6 m from the player's own
  // spawn point. Walking forward for one second put the player inside seven
  // metres of two alerted riflemen before he had finished orienting, and no
  // amount of accuracy ramping makes that survivable - a burst fired from seven
  // metres is on target by geometry alone. The fix is positional: hold the
  // nearest militiaman out past minSpawnRange so first contact happens at
  // fifteen-plus metres, where the ramp has room to work and the player has
  // room to move.
  AISystem.prototype._populate = function (ctx) {
    var lv = ctx && ctx.level;
    var spots = [];
    var i, c;
    var home = (lv && lv.spawnPoints && lv.spawnPoints[0] && lv.spawnPoints[0].position) ||
      (ctx && ctx.player && ctx.player.position) || null;
    var minR = this.minSpawnRange || 0;
    var far = function (p) {
      if (!p || !home || minR <= 0) return true;
      var dx = p.x - home.x, dz = p.z - home.z;
      return (dx * dx + dz * dz) >= minR * minR;
    };
    if (lv && lv.spawnPoints && lv.spawnPoints.length > 1) {
      // skip the first spawn - that is the player's
      for (i = 1; i < lv.spawnPoints.length && spots.length < 10; i++) {
        if (lv.spawnPoints[i] && lv.spawnPoints[i].position &&
          far(lv.spawnPoints[i].position)) spots.push(lv.spawnPoints[i].position);
      }
    }
    // top up from cover so culling the close spawns does not thin the squad
    if (spots.length < 9 && this.coverSys.points.length) {
      for (i = 0; i < 60 && spots.length < 9; i++) {
        c = this.coverSys.points[this.rng.int(0, this.coverSys.points.length - 1)];
        if (!c || !far(c.pos)) continue;
        var clash = false;
        for (var q = 0; q < spots.length; q++) {
          if (spots[q].distanceToSquared(c.pos) < 6.25) { clash = true; break; }
        }
        if (!clash) spots.push(c.pos);
      }
    }
    if (!spots.length) {
      for (i = 0; i < 6; i++) spots.push(v(this.rng.range(-6, 6), 0, -18 - i * 4));
    }
    var n = Math.min(9, spots.length);
    for (i = 0; i < n; i++) this.spawn(spots[i]);
  };

  // --------------------------------------------------------------------------
  // CAPTURE COMPOSITION
  //
  // enemy_closeup shipped empty for who knows how many capture cycles: the
  // scenario points the camera SOUTH (yaw = PI maps the camera's local -Z onto
  // world +Z) and spawns the militiaman 3.4 m due north, directly behind it.
  // spawn() accepted the position, added the group to the scene, emitted
  // 'enemy:spawned' and returned successfully - a completely silent failure.
  // firefight put four men on the street centreline 25-32 m out, which is
  // exactly where the blown-out sun, the arch and the muzzle flash all sit.
  //
  // So under ctx.capture the AI owns its own framing. A requested position is
  // mirrored in front of the lens if it is behind it, compressed into a band
  // where a 1.8 m man is actually a readable number of pixels, fitted to the
  // frame, and biased off both the sun disc and the dead centre. Interactive
  // play never touches any of this.
  // --------------------------------------------------------------------------
  var CAP_FAR = 10.0;         // beyond this a militiaman is a smudge at 720p
  var CAP_NEAR = 3.2;

  AISystem.prototype._frameForCapture = function (pos, out, idx) {
    var ctx = this.ctx;
    out.copy(pos);
    var cam = ctx && ctx.camera;
    if (!ctx || !ctx.capture || !cam) return false;
    cam.updateMatrixWorld(true);
    _m0.copy(cam.matrixWorld).invert();
    _v0.set(pos.x, pos.y + 0.95, pos.z).applyMatrix4(_m0);
    var cx = _v0.x, cy = _v0.y, cz = _v0.z, k, den;
    var moved = false;
    var dist = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1e-3;

    // 1. behind the lens -> mirror through the camera plane, distance preserved
    if (cz > -CAP_NEAR) {
      cz = -Math.sqrt(Math.max(CAP_NEAR * CAP_NEAR, dist * dist - cx * cx - cy * cy));
      moved = true;
    }
    var depth = -cz;

    // 2. too far to read -> compress by ONE factor shared across the squad, so
    //    the formation keeps its depth ordering instead of collapsing into a
    //    firing line all at the same range
    if (depth > CAP_FAR) {
      if (!this._capScale) this._capScale = CAP_FAR / depth;
      k = this._capScale;
      cx *= k; cy *= k; cz *= k; depth = -cz;
      moved = true;
    }

    // 3. fit the whole figure in frame - the man does not scale with distance,
    //    so push out until 1.9 m of him fits inside 88% of the frame
    var tanY = Math.tan((cam.fov || 60) * 0.5 * Math.PI / 180);
    var tanX = tanY * (cam.aspect || 1.6);
    var kf = 1;
    den = 0.88 * depth * tanY - Math.abs(cy);
    kf = den > 1e-3 ? Math.max(kf, 1.10 / den) : 4;
    den = 0.88 * depth * tanX - Math.abs(cx);
    if (den > 1e-3) kf = Math.max(kf, 0.55 / den);
    kf = M.clamp(kf, 1, 5);
    if (kf > 1.001) { cx *= kf; cy *= kf; cz *= kf; depth = -cz; moved = true; }

    // 4. composition. Only the horizontal is touched: the ground owns the
    //    vertical, and any push in y is undone by the re-grounding below.
    if (depth > 8) {
      // Keep the squad out of the frame centre, where the crosshair, the
      // vanishing point and the muzzle flash all sit. When a viewmodel is on
      // screen the right half of the frame is a rifle, so string them down the
      // left instead - four men stacked behind a handguard is no better than
      // four men lost in the sun. The spread is expressed in METRES, not in
      // screen space: at 18 m an innocuous-looking 0.4 of NDC is 10 m of
      // lateral offset, which puts a man through a shopfront.
      var vm = ctx.viewScene && ctx.viewScene.visible !== false && ctx.weapons;
      var lat;
      if (vm) {
        lat = -(1.5 + 1.15 * (idx || 0));
        if (cx > lat + 0.6) { cx = lat; moved = true; }
      } else {
        lat = ((idx & 1) ? 1 : -1) * (1.1 + 0.85 * Math.floor((idx || 0) / 2));
        if (Math.abs(cx) < Math.abs(lat) - 0.4) { cx = lat; moved = true; }
      }
    } else {
      // even a portrait wants the subject off dead centre, and dead centre in
      // this street happens to be a lamp post
      var latN = -(0.45 + 0.32 * (idx || 0));
      if (Math.abs(cx) < Math.abs(latN)) { cx = latN; moved = true; }
    }
    var nx = cx / (depth * tanX);
    var ny = cy / (depth * tanY);
    var sky = ctx.sky;
    if (sky && sky.sunDirection && sky.sunDirection.isVector3) {
      _v1.copy(sky.sunDirection).transformDirection(_m0);
      if (_v1.z < -0.05) {
        var sx = (_v1.x / -_v1.z) / tanX, sy = (_v1.y / -_v1.z) / tanY;
        if (Math.abs(nx - sx) < 0.22 && Math.abs(ny - sy) < 0.45) {
          nx = sx + (nx >= sx ? 0.22 : -0.22);
          moved = true;
        }
      }
    }
    nx = M.clamp(nx, -0.74, 0.74);
    cx = nx * depth * tanX;

    _v0.set(cx, cy, cz).applyMatrix4(cam.matrixWorld);
    out.set(_v0.x, _v0.y - 0.95, _v0.z);
    return moved;
  };

  // Put a moved agent back on real, walkable, unoccupied ground.
  AISystem.prototype._settle = function (e, rings) {
    var pf = this.pathfinder;
    if (pf) {
      pf.toGrid(e.position, _g0);
      var m = pf.nearestWalkable(_g0.x, _g0.z, rings || 6);
      if (m === 'moved') {
        pf.toWorld(pf._nx, pf._nz, _v0);
        e.position.x = _v0.x; e.position.z = _v0.z;
      }
    }
    e.groundY = this.world.ground(e.position.x, e.position.z, e.position.y + 2.2, e.groundNormal);
    e.position.y = e.groundY;
    try { e._resolveCollisions(); } catch (err) { /* no colliders is fine */ }
    e.groundY = this.world.ground(e.position.x, e.position.z, e.position.y + 2.2, e.groundNormal);
    e.position.y = e.groundY;
    e.group.updateMatrixWorld(true);
    e._updateHitboxes();
  };

  // Closest unclaimed cover slot within `r`. Used only by the capture staging.
  AISystem.prototype._nearestCover = function (pos, r) {
    var pts = this.coverSys.points, best = null, bestD = r * r;
    for (var i = 0; i < pts.length; i++) {
      var c = pts[i];
      if (c.claim >= 0) continue;
      var dx = c.pos.x - pos.x, dz = c.pos.z - pos.z;
      var d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  };

  AISystem.prototype._inFrustum = function (e) {
    var cam = this.ctx && this.ctx.camera;
    if (!cam) return true;
    cam.updateMatrixWorld(true);
    _v0.copy(e.boundsCenter).project(cam);
    return Math.abs(_v0.x) <= 1 && Math.abs(_v0.y) <= 1 && _v0.z > 0 && _v0.z < 1;
  };

  // Runs once, on the first simulated frame. It cannot run inside spawn():
  // enemy_closeup spawns BEFORE it places the camera and then overwrites the
  // position afterwards, so a check at spawn time tests the wrong camera and
  // the wrong position.
  AISystem.prototype._captureStage = function (ctx) {
    if (this._staged) return;
    this._staged = true;
    if (!ctx || !ctx.capture || !ctx.camera || !this.enemies.length) return;
    var th = this.threat, i, e, live = 0;
    for (i = 0; i < this.enemies.length; i++) {
      e = this.enemies[i];
      if (!e.alive) continue;
      if (this._frameForCapture(e.position, _v6, live)) {
        e.position.set(_v6.x, _v6.y, _v6.z);
        this._settle(e, 8);
      }
      // Put somebody actually behind the jersey barrier. A squad standing in
      // the open in front of unused cover is what makes a firefight read as a
      // shooting gallery. Only snap if the slot is close to the framed spot and
      // the man survives the move in frustum, so composition still wins.
      if (live < 2 && this.coverSys && this.coverSys.points.length) {
        _v8.copy(e.position);
        var cp = this._nearestCover(e.position, 3.2);
        if (cp) {
          e.position.set(cp.pos.x, cp.pos.y, cp.pos.z);
          this._settle(e, 4);
          if (!this._inFrustum(e)) {
            e.position.copy(_v8);
            this._settle(e, 4);
          } else {
            e.cover = cp;
            cp.claim = e.id;
          }
        }
      }

      var d = th.valid ? e.position.distanceTo(th.pos) : 14;
      if (th.valid) {
        e.yaw = Math.atan2(th.pos.x - e.position.x, th.pos.z - e.position.z);
        e.desiredYaw = e.yaw;
        e.group.rotation.y = e.yaw;
        e.aimDir.copy(th.chest).sub(e.eye);
        if (e.aimDir.lengthSq() < 1e-6) e.aimDir.set(0, 0, 1);
        e.aimDir.normalize();
        e.lastKnown.copy(th.pos);
        e.hasLastKnown = true;
      }
      // Seed a live combat posture. A squad standing bolt upright in the open
      // with its weapons down reads as a shooting gallery even when it IS
      // visible, and five seconds into a firefight is far too late to still be
      // blending up from an idle.
      e.awareness = 0.95;
      e.timeSinceSeen = 0;
      e.stateTime = 0;
      e.noticeDelay = 0;          // a staged squad has already seen him
      // A capture is a COMPOSITION. The engage->seekCover break that stops
      // interactive enemies standing in the open would have this man sprint out
      // of the framed shot 1.3 s into a 3 s capture.
      e.coverUrge = 1e9;
      e.think = 0.02 + live * 0.01;
      if (d < 9) {
        // portrait framing: alert and aiming, never firing - a muzzle flash
        // four metres from the lens destroys the shot it is meant to show
        e.state = 'alert';
        e.reactTimer = 999;
        e.anim.weaponUpTarget = 0.8;
        e.anim.weaponUp = 0.8;
      } else {
        e.state = 'engage';
        e.reactTimer = 0;
        e.anim.weaponUpTarget = 1;
        e.anim.weaponUp = 1;
        e.role = live === 0 ? 'assault' : 'suppress';
        // Deal postures round-robin across the squad. Round 1 set crouchWanted
        // on two of four and it never read in the frame, because the foot IK
        // was quietly lifting the pelvis back up and because the values were
        // identical between the two men who got it. Deep, varied, and applied
        // to the blend directly so it is already there on frame one.
        var deck = [0.0, 0.95, 0.34, 0.72];
        var dc = deck[live % deck.length];
        e.captureCrouch = dc;
        e.crouchWanted = dc;
        e.anim.crouch = dc;
        // one man leans out of cover rather than standing square behind it
        if (live === 2) { e.coverPeek = 1; e.anim.peek = e.peekSide * 0.8; }
        e.burstPause = 0.10 + live * 0.20;
        e.timeOnTarget = 0.5;
      }
      // blade the stance immediately - a capture never waits for the damp
      e.yaw += e.pose.blade * e.anim.weaponUp;
      e.desiredYaw = e.yaw;
      e.group.rotation.y = e.yaw;
      live++;
    }
    // hold the seeded roles for the length of any capture
    this._roleTimer = 6.0;
    for (i = 0; i < this.enemies.length; i++) {
      e = this.enemies[i];
      if (e.alive && !this._inFrustum(e)) {
        GAME.logError('ai.spawn.offscreen', 'enemy ' + e.id + ' at ' +
          e.position.x.toFixed(2) + ',' + e.position.y.toFixed(2) + ',' +
          e.position.z.toFixed(2) + ' is outside the capture frustum');
      }
    }
  };

  AISystem.prototype.spawn = function (position) {
    try {
      if (!this.variants.length) {
        // build() may not have run (or may have failed); make one on demand so
        // a spawn request never returns nothing
        this.material = this.material || makeCharacterMaterial();
        this._buildVariant();
      }
      if (this.enemies.length >= this.maxEnemies) return null;
      var vr = this.variants[this.rng.int(0, this.variants.length - 1)] || this.variants[0];
      // Captures walk the variants in order instead of rolling for them, and
      // skip the no-rig body for the first man: a portrait scenario that draws
      // the one militiaman with no webbing on him is a wasted frame, and a
      // random draw duplicates bodies inside a four-man squad about 40% of the
      // time. Interactive play keeps the random pick.
      if (this.ctx && this.ctx.capture && this.variants.length) {
        // Two passes, best first. A portrait scenario that draws the one
        // militiaman with no webbing on him is a wasted frame - and so is one
        // that draws the man whose face is behind a shemagh mask, now that the
        // face is the most detailed thing on the model.
        var pool = [], q, lk;
        for (q = 0; q < this.variants.length; q++) {
          lk = this.variants[q].look;
          if (lk && lk.rigStyle !== 'none' && !lk.mask) pool.push(this.variants[q]);
        }
        for (q = 0; q < this.variants.length; q++) {
          lk = this.variants[q].look;
          if (lk && lk.rigStyle !== 'none' && lk.mask) pool.push(this.variants[q]);
        }
        if (!pool.length) pool = this.variants;
        vr = pool[this.enemies.length % pool.length];
      }
      var pos = position;
      if (pos && !pos.isVector3) {
        pos = v(pos[0] || pos.x || 0, pos[1] || pos.y || 0, pos[2] || pos.z || 0);
      }
      var e = new Enemy(this, vr, pos || v(0, 0, -10));
      // face roughly toward the player if there is one - a squad that spawns
      // pointing at random walls reads as broken, and it makes the capture
      // scenarios frame a front three-quarter view instead of a back
      this._updateThreat(this.ctx);
      if (this.threat.valid) {
        e.yaw = Math.atan2(this.threat.pos.x - e.position.x, this.threat.pos.z - e.position.z) +
          this.rng.range(-0.5, 0.5);
      } else {
        e.yaw = this.rng.range(-Math.PI, Math.PI);
      }
      e.desiredYaw = e.yaw;
      e.group.rotation.y = e.yaw;
      e.groundY = this.world.ground(e.position.x, e.position.z, e.position.y + 1.5, e.groundNormal);
      e.position.y = e.groundY;
      e.aimDir.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
      this._makePatrol(e);
      this.root.add(e.group);
      e.group.updateMatrixWorld(true);
      e._updateHitboxes();
      this.enemies.push(e);
      // A capture spawn placed after the composition pass has to frame itself
      // immediately - there is no second pass coming. A spawn that lands
      // outside the frustum in a capture never returns silently again.
      if (this._staged && this.ctx && this.ctx.capture) {
        if (this._frameForCapture(e.position, _v6, this.enemies.length - 1)) {
          e.position.set(_v6.x, _v6.y, _v6.z);
          this._settle(e, 8);
        }
        if (!this._inFrustum(e)) {
          GAME.logError('ai.spawn.offscreen', 'enemy ' + e.id + ' spawned outside the capture frustum');
        }
      }
      if (this.bus) this.bus.emit('enemy:spawned', e);
      return e;
    } catch (err) {
      GAME.logError('ai.spawn', err);
      return null;
    }
  };

  AISystem.prototype._makePatrol = function (e) {
    var pf = this.pathfinder;
    if (!pf || !this.rng.bool(0.55)) return;
    var g = pf.grid;
    var oz = g.origin.z !== undefined ? g.origin.z : g.origin.y;
    for (var i = 0; i < 3; i++) {
      for (var tries = 0; tries < 12; tries++) {
        var ang = this.rng.range(0, TAU), rad = this.rng.range(3, 11);
        var x = e.position.x + Math.cos(ang) * rad;
        var z = e.position.z + Math.sin(ang) * rad;
        var gx = Math.floor((x - g.origin.x) / g.cellSize);
        var gz = Math.floor((z - oz) / g.cellSize);
        if (pf.walkable(gx, gz)) {
          e.patrol.push(v(x, e.position.y, z));
          break;
        }
      }
    }
  };

  // ------------------------------------------------------------------ tick --
  AISystem.prototype.update = function (dt, ctx) {
    ctx = ctx || this.ctx;
    this.ctx = ctx;
    this.time += dt;
    this.frame++;
    if (dt <= 0) return;

    try { this._updateThreat(ctx); } catch (e) { GAME.logError('ai.threat', e); }
    try { this._syncMaterial(ctx); } catch (e) { GAME.logError('ai.matsync', e); }
    if (!this._staged) {
      try { this._captureStage(ctx); } catch (e) { GAME.logError('ai.capture', e); }
    }

    // per-frame query budgets: expensive work is spread across frames so a
    // twelve-man squad never spikes a single frame
    this._budget.path = 0;
    this._budget.cover = 0;

    this._roleTimer -= dt;
    if (this._roleTimer <= 0) {
      this._roleTimer = 1.1;
      try { this._assignRoles(); } catch (e) { GAME.logError('ai.roles', e); }
    }

    var cam = ctx && ctx.camera ? ctx.camera.position : null;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      var near = true;
      if (cam) {
        var dx = e.position.x - cam.x, dz = e.position.z - cam.z;
        near = (dx * dx + dz * dz) < 1225;              // full foot IK inside 35m
      }
      // line-of-sight rays round-robin: each agent re-tests about 20x a second
      var allowRay = ((i + this.frame) % 3) === 0;
      try { e.update(dt, ctx, near, allowRay); }
      catch (err) { GAME.logError('ai.enemy', err); }
    }

    try { this._processPaths(); } catch (e) { GAME.logError('ai.path', e); }
    try { this._updateGrenades(dt, ctx); } catch (e) { GAME.logError('ai.grenade', e); }
  };

  // Feed the character shader the live sun. One material serves every enemy, so
  // this runs once a frame, not once per instance.
  AISystem.prototype._syncMaterial = function (ctx) {
    if (this._night) { try { this._syncKey(ctx); } catch (e) { GAME.logError('ai.key', e); } }
    this._syncOne(this.material, ctx);
    this._syncOne(this.faceMaterial, ctx);
  };

  // --------------------------------------------------------------------------
  // THE PRACTICAL KEY  (harbor only; never runs in the market)
  //
  // Cold Harbor's key light is not a light this file can ask ctx.sky for - it
  // is whichever sodium mast or mercury flood the squad happens to be standing
  // under, and it changes as they move. lighting.js publishes them as
  // `lighting.practicals` ([{light, ...}]), so the dominant one is solvable
  // exactly the way the renderer solves it: intensity / d^2, times the spot
  // cone, times the distance cutoff. Measured on the harbor portrait this picks
  // the 6.5 m mast at 7.0 m and irradiance 3.87 - the same light the frame is
  // actually lit by - over a 12.5 m mast at 18.2 m and 0.64.
  //
  // Everything degrades: no lighting system, no practicals array, nothing in
  // range, all give the standing cold-from-above default rather than black.
  // --------------------------------------------------------------------------
  var _kA = new V3(), _kB = new V3(), _kC = new V3();
  var KEY_RIM_GAIN = 0.26;      // practical irradiance -> rim/wrap radiance
  // The analytic size of this term is larger than the value shipped, and that
  // is deliberate. The mast puts E ~ 3.9 on the apron at the subject's feet; a
  // wet apron returns roughly a quarter of that (diffuse plus the smeared
  // specular of the lamp itself), so the radiance leaving it is
  // ~3.9 * 0.25 / PI = 0.31, and a VERTICAL surface standing on it receives
  // about L * PI/2 = 0.49 of that back - which is a gain around 0.4.
  //
  // It is shipped at 0.16 because lighting.js is ALSO paying for this physics
  // (a hemisphere pair plus a dedicated sodium up-bounce), and a control render
  // - the market program running unchanged in the same harbor build - showed
  // the level's own practicals already carrying the subject. Sized against that
  // control rather than against the analytic ceiling, this is a fill that opens
  // the shadow side by ~40% instead of a second key light. It scales with the
  // measured practical irradiance, so it tracks the rig if the level relights.
  var KEY_BOUNCE_GAIN = 0.16;   // ...and -> apron bounce irradiance
  var KEY_BOUNCE_CAP = 1.0;     // standing under a 1200 cd flood must not blow
  var KEY_DESAT = 0.42;         // the apron is grey; it desaturates what it returns

  AISystem.prototype._syncKey = function (ctx) {
    var k = this._key;
    k.found = false;
    if (!ctx) return;

    // Subject point: the live squad, else where the camera looks.
    //
    // Weighted TOWARD THE CAMERA, not a plain centroid. One material serves the
    // whole squad, so there is exactly one key to publish, and the harbor
    // firefight spreads four men over 9 m across and 10 m deep - far enough
    // that the plain mean landed under a mercury flood while the man the player
    // is actually looking at stood in a sodium pool 6 m away, and he got the
    // wrong colour of rim. 1/(2+d)^2 puts the nearest man in charge without the
    // discontinuity that picking one outright would cause when he dies.
    var n = 0, i, wsum = 0;
    _kA.set(0, 0, 0);
    var camP = ctx.camera ? ctx.camera.position : null;
    for (i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (!e || e.alive === false) continue;
      var wgt = 1;
      if (camP) { wgt = 1 / (2 + e.position.distanceTo(camP)); wgt *= wgt; }
      _kA.x += e.position.x * wgt;
      _kA.y += (e.position.y + 1.35) * wgt;
      _kA.z += e.position.z * wgt;
      wsum += wgt;
      n++;
    }
    if (n && wsum > 0) _kA.multiplyScalar(1 / wsum);
    else if (ctx.camera) {
      _kB.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
      _kA.copy(ctx.camera.position).addScaledVector(_kB, 6);
    } else return;

    var pr = (ctx.lighting && ctx.lighting.practicals) || null;
    if (!pr || !pr.length) return;

    var bestE = 0, best = null;
    for (i = 0; i < pr.length; i++) {
      var L = pr[i] && pr[i].light;
      if (!L || !L.visible || !(L.intensity > 0) || !L.position) continue;
      _kB.subVectors(L.position, _kA);
      var d2 = _kB.lengthSq();
      if (d2 < 1e-4) continue;
      var d = Math.sqrt(d2);
      var att = 1;
      if (L.distance > 0) {
        if (d >= L.distance) continue;
        att = 1 - d / L.distance;
      }
      var sf = 1;
      if (L.isSpotLight && L.target) {
        L.target.updateMatrixWorld();
        _kC.setFromMatrixPosition(L.target.matrixWorld).sub(L.position);
        if (_kC.lengthSq() < 1e-8) continue;
        _kC.normalize();
        var cosA = -_kB.dot(_kC) / d;          // _kB points AT the lamp
        var ca = Math.cos(L.angle);
        if (cosA <= ca) continue;
        sf = M.saturate((cosA - ca) / Math.max(1e-4, (1 - ca) * Math.max(0.02, L.penumbra || 0.02)));
      }
      var E = L.intensity / d2 * att * sf;
      if (E > bestE) { bestE = E; best = L; k.dir.copy(_kB).multiplyScalar(1 / d); }
    }
    if (!best) return;

    k.found = true;
    // The gains are the one thing here that is a judgement rather than a
    // measurement, so they are held low enough that the rim reads as an EDGE
    // and not as a coat of paint - the exact failure this file already fixed
    // once for the sun rim. Ceilinged so standing directly under a 1200 cd
    // flood cannot blow the man out.
    var g = Math.min(bestE, 7.0);
    k.col.copy(best.color).multiplyScalar(M.clamp(g * KEY_RIM_GAIN, 0.03, 1.15));
    // What comes back off the apron is the lamp's colour muddied by wet
    // concrete, not the lamp's colour.
    var lum = best.color.r * 0.2126 + best.color.g * 0.7152 + best.color.b * 0.0722;
    k.bounce.setRGB(
      M.lerp(best.color.r, lum, KEY_DESAT),
      M.lerp(best.color.g, lum, KEY_DESAT),
      M.lerp(best.color.b, lum, KEY_DESAT)
    ).multiplyScalar(M.clamp(g * KEY_BOUNCE_GAIN, 0.02, KEY_BOUNCE_CAP));
  };

  AISystem.prototype._syncOne = function (mat, ctx) {
    var u = mat && mat.userData && mat.userData.charUniforms;
    if (!u) return;
    var cam = ctx && ctx.camera;
    var sky = ctx && ctx.sky;
    if (cam && sky && sky.sunDirection && sky.sunDirection.isVector3) {
      cam.updateMatrixWorld();
      _m0.copy(cam.matrixWorld).invert();
      u.uSunDirView.value.copy(sky.sunDirection).transformDirection(_m0).normalize();
    }
    var inten = (sky && typeof sky.sunIntensity === 'number') ? sky.sunIntensity : 4.5;
    // the rim has to die at night with the sun, or every militiaman glows
    // Scaled so a full-strength 14-degree sun puts the rim at roughly 0.25 of a
    // sunlit-plaster radiance rather than matching it outright. At 0.26/1.7 the
    // backlight term alone was worth a full stop of key light on every curved
    // surface, which is how the squad turned into grey ghosts.
    var kSun = M.clamp(inten * 0.16, 0.02, 0.95);
    if (sky && sky.sunColor && sky.sunColor.isColor) {
      u.uSunColor.value.copy(sky.sunColor).multiplyScalar(kSun);
    } else {
      u.uSunColor.value.setRGB(1.00 * kSun, 0.84 * kSun, 0.62 * kSun);
    }
    var kSky = M.clamp(inten * 0.14, 0.02, 0.85);
    var sc = (sky && sky.skyColor && sky.skyColor.isColor) ? sky.skyColor : null;
    if (sc) u.uSkyColor.value.copy(sc).multiplyScalar(kSky);
    else u.uSkyColor.value.setRGB(0.34 * kSky, 0.48 * kSky, 0.70 * kSky);

    // ---- wet-night variant only ---------------------------------------------
    if (!u.uKeyDirView) return;
    if (cam) {
      cam.updateMatrixWorld();
      _m0.copy(cam.matrixWorld).invert();
      u.uKeyDirView.value.copy(this._key.dir).transformDirection(_m0).normalize();
      u.uUpView.value.set(0, 1, 0).transformDirection(_m0).normalize();
    }
    u.uKeyColor.value.copy(this._key.col);
    // Nothing bounces off a dry apron. Fading the bounce with wetness also means
    // the term is honestly zero on a `clear` preset instead of silently on.
    var wetv = (ctx && ctx.weather && typeof ctx.weather.wetness === 'number')
      ? M.saturate(ctx.weather.wetness) : 1.0;
    u.uBounceColor.value.copy(this._key.bounce).multiplyScalar(0.35 + 0.65 * wetv);
    u.uWet.value = wetv;
    // The sun-referenced sky gain is meaningless at 02:00 - kSky sits on its
    // 0.02 floor - and this variant uses uSkyColor for the COLD half of the rim
    // (the storm dome behind the man). Re-reference it to the dome that is
    // actually lighting the level.
    var envI = (ctx && ctx.scene && typeof ctx.scene.environmentIntensity === 'number')
      ? ctx.scene.environmentIntensity : 1.0;
    var kNight = M.clamp(0.16 + 0.42 * envI, 0.08, 0.55);
    if (sc) u.uSkyColor.value.copy(sc).multiplyScalar(kNight);
    else u.uSkyColor.value.setRGB(0.42 * kNight, 0.56 * kNight, 0.78 * kNight);
  };

  AISystem.prototype._updateThreat = function (ctx) {
    var th = this.threat;
    var pl = ctx && ctx.player;
    var cam = ctx && ctx.camera;
    var eyeH = (pl && pl.eyeHeight) || 1.65;
    if (pl && pl.position) {
      th.pos.copy(pl.position);
      th.eye.set(th.pos.x, th.pos.y + eyeH, th.pos.z);
    } else if (cam) {
      th.eye.copy(cam.position);
      th.pos.set(cam.position.x, cam.position.y - eyeH, cam.position.z);
    } else {
      th.valid = false;
      return;
    }
    var crouched = pl && (pl.state === 'crouch' || pl.state === 'slide');
    th.height = crouched ? 1.35 : 1.8;
    th.chest.set(th.pos.x, th.pos.y + th.height * 0.72, th.pos.z);

    if (th.inited) {
      var dx = th.pos.x - th.prev.x, dz = th.pos.z - th.prev.z;
      var sp = Math.sqrt(dx * dx + dz * dz) / Math.max(1e-4, ctx.dt || 1 / 60);
      th.moving = sp > 0.6;
      th.sprinting = sp > 4.2 || (pl && pl.state === 'sprint');
    }
    th.prev.copy(th.pos);
    th.inited = true;
    th.valid = !(pl && typeof pl.health === 'number' && pl.health <= 0);

    // player gunfire: infer it from the magazine count so we do not depend on
    // any particular event name existing
    var w = ctx && ctx.weapons && ctx.weapons.current;
    if (w && typeof w.ammo === 'number') {
      if (this._lastAmmo >= 0 && w.ammo < this._lastAmmo) this.hearNoise(th.eye, 58);
      this._lastAmmo = w.ammo;
    }
  };

  // Squad discipline: at most two men manoeuvre at once, everyone else holds
  // and suppresses. Everybody charging at once is what makes bad AI feel like
  // a shooting gallery.
  AISystem.prototype._assignRoles = function () {
    var live = [], i, e;
    for (i = 0; i < this.enemies.length; i++) {
      e = this.enemies[i];
      if (!e.alive) continue;
      if (e.awareness < 0.4) { e.role = 'hold'; continue; }
      live.push(e);
    }
    if (!live.length || !this.threat.valid) return;
    var th = this.threat;
    live.sort(function (a, b) {
      return a.position.distanceToSquared(th.pos) - b.position.distanceToSquared(th.pos);
    });
    var pushers = live.length >= 4 ? 2 : 1;
    for (i = 0; i < live.length; i++) {
      e = live[i];
      if (e.health < e.maxHealth * 0.3) { e.role = 'suppress'; continue; }
      if (i < pushers) {
        e.role = (i === 1 || (live.length > 2 && e.rng.bool(0.4))) ? 'flank' : 'assault';
      } else {
        e.role = 'suppress';
      }
    }
  };

  AISystem.prototype.canQuery = function (e, kind) {
    if (kind === 'path') {
      if (this._budget.path >= 2) return false;
      this._budget.path++;
      return true;
    }
    if (kind === 'cover') {
      if (this._budget.cover >= 1) return false;
      this._budget.cover++;
      return true;
    }
    return true;
  };

  // Firing slots. Everyone else in the squad is still manoeuvring, holding or
  // waiting for a gap - which is what a real fire team does and what keeps the
  // incoming DPS bounded no matter how many men are alerted. Captures get a
  // wider cap because simultaneous muzzle flashes are the point of the shot.
  AISystem.prototype.canFire = function (e) {
    if (e.burstLeft > 0) return true;
    var cap = (this.ctx && this.ctx.capture) ? 4 : (this.maxShooters || 2);
    var n = 0;
    for (var i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].alive && this.enemies[i].burstLeft > 0) n++;
    }
    return n < cap;
  };

  // Gate on how recently the player last took a round. Returns true and starts
  // a fresh window, or false to convert this round into a near-miss.
  AISystem.prototype.allowPlayerHit = function (pl) {
    var frac = 1;
    if (pl && typeof pl.health === 'number') {
      var mx = (typeof pl.maxHealth === 'number' && pl.maxHealth > 0) ? pl.maxHealth : 100;
      frac = M.saturate(pl.health / mx);
    }
    var need = this.hitSpacing + this.hitSpacingHurt * (1 - frac);
    if (this.time - this._lastPlayerHit < need) return false;
    this._lastPlayerHit = this.time;
    return true;
  };

  AISystem.prototype.wantsCover = function (e) {
    if (!this.coverSys.points.length) return false;
    if (!this.threat.valid) return false;
    return e.position.distanceTo(this.threat.pos) > 5.5;
  };

  AISystem.prototype.flankPosition = function (e, threatPos, rng) {
    if (e.flankGoal && this.time - e.flankTime < 9) return e.flankGoal;
    _v0.set(e.position.x - threatPos.x, 0, e.position.z - threatPos.z);
    var r = M.clamp(_v0.length(), 8, 17);
    var ang = Math.atan2(_v0.x, _v0.z) + rng.sign() * rng.range(0.85, 1.75);
    _v1.set(threatPos.x + Math.sin(ang) * r, e.position.y, threatPos.z + Math.cos(ang) * r);
    var pf = this.pathfinder;
    if (pf) {
      pf.toGrid(_v1, _g0);
      var m = pf.nearestWalkable(_g0.x, _g0.z, 6);
      if (!m) return null;
      if (m === 'moved') pf.toWorld(pf._nx, pf._nz, _v1);
      _v1.y = e.position.y;
    }
    e.flankGoal = _v1.clone();
    e.flankTime = this.time;
    return e.flankGoal;
  };

  AISystem.prototype.requestPath = function (e, goal) {
    if (!this.pathfinder) { e.path.length = 0; return; }
    if (e.pathPending) return;
    e.pathPending = true;
    this._pathQueue.push({ e: e, goal: goal.clone() });
    if (this._pathQueue.length > 24) {
      var drop = this._pathQueue.shift();
      drop.e.pathPending = false;
    }
  };

  AISystem.prototype._processPaths = function () {
    if (!this.pathfinder) return;
    var n = 0;
    while (this._pathQueue.length && n < 2) {          // hard cap: 2 A* / frame
      var job = this._pathQueue.shift();
      n++;
      var e = job.e;
      e.pathPending = false;
      if (!e.alive) continue;
      var out = [];
      if (this.pathfinder.find(e.position, job.goal, out) && out.length) {
        e.path = out;
        e.pathIndex = 0;
      } else {
        e.path.length = 0;
        e.pathIndex = 0;
      }
    }
  };

  // ------------------------------------------------------------- grenades ---
  AISystem.prototype.canThrow = function (e) {
    if (this._grenadeCd > 0) return false;
    // never frag a teammate
    for (var i = 0; i < this.enemies.length; i++) {
      var o = this.enemies[i];
      if (o === e || !o.alive) continue;
      if (o.position.distanceToSquared(e.lastKnown) < 25) return false;
    }
    return true;
  };

  AISystem.prototype.throwGrenade = function (e, target) {
    var ctx = this.ctx;
    this._grenadeCd = 9;
    var from = _v0.copy(e.muzzle);
    from.y += 0.15;
    // pick a flight time, then solve the launch velocity for the arc
    var dist = from.distanceTo(target);
    var T = M.clamp(dist / 11, 0.75, 2.1);
    var vel = new V3(
      (target.x - from.x) / T,
      (target.y + 0.4 - from.y) / T + 0.5 * 9.81 * T,
      (target.z - from.z) / T);
    var g = {
      pos: from.clone(), vel: vel, fuse: T + 0.65, mesh: null,
      spin: new V3(this.rng.range(-8, 8), this.rng.range(-8, 8), this.rng.range(-8, 8))
    };
    if (!this._nadeGeo) {
      this._nadeGeo = new THREE.SphereGeometry(0.045, 8, 6);
      this._nadeGeo.scale(1, 1.35, 1);
      this._nadeMat = new THREE.MeshStandardMaterial({
        color: 0x3a4030, roughness: 0.62, metalness: 0.35
      });
    }
    g.mesh = new THREE.Mesh(this._nadeGeo, this._nadeMat);
    g.mesh.castShadow = true;
    g.mesh.position.copy(g.pos);
    this.root.add(g.mesh);
    this._grenades.push(g);
    if (ctx && ctx.audio && ctx.audio.play) {
      try { ctx.audio.play('grenade_throw', { position: from }); } catch (err) { /* optional */ }
    }
  };

  AISystem.prototype._updateGrenades = function (dt, ctx) {
    this._grenadeCd = Math.max(0, this._grenadeCd - dt);
    for (var i = this._grenades.length - 1; i >= 0; i--) {
      var g = this._grenades[i];
      g.vel.y -= 9.81 * dt;
      _v6.copy(g.vel).multiplyScalar(dt);
      var step = _v6.length();
      if (step > 1e-4) {
        _v7.copy(_v6).divideScalar(step);
        var t = this.world.raycast(g.pos, _v7, step + 0.05, _rayHit);
        if (t >= 0) {
          // bounce with loss; grenades that skitter read far better than ones
          // that stick where they land
          g.pos.copy(_rayHit.point).addScaledVector(_rayHit.normal, 0.05);
          var vn = g.vel.dot(_rayHit.normal);
          g.vel.addScaledVector(_rayHit.normal, -1.55 * vn).multiplyScalar(0.55);
          if (ctx && ctx.audio && ctx.audio.play && g.vel.lengthSq() > 1) {
            try { ctx.audio.play('grenade_bounce', { position: g.pos, volume: 0.5 }); }
            catch (e) { /* optional */ }
          }
        } else {
          g.pos.add(_v6);
        }
      }
      var gy = this.world.ground(g.pos.x, g.pos.z, g.pos.y + 0.6, null);
      if (g.pos.y < gy + 0.045) {
        g.pos.y = gy + 0.045;
        if (g.vel.y < 0) g.vel.y = -g.vel.y * 0.4;
        g.vel.x *= 0.72; g.vel.z *= 0.72;
      }
      if (g.mesh) {
        g.mesh.position.copy(g.pos);
        g.mesh.rotation.x += g.spin.x * dt;
        g.mesh.rotation.z += g.spin.z * dt;
      }
      g.fuse -= dt;
      if (g.fuse <= 0) {
        this._detonate(g, ctx);
        if (g.mesh) this.root.remove(g.mesh);
        this._grenades.splice(i, 1);
      }
    }
  };

  AISystem.prototype._detonate = function (g, ctx) {
    var radius = 5.5;
    if (ctx && ctx.vfx && ctx.vfx.explosion) {
      try { ctx.vfx.explosion(g.pos.clone(), radius); } catch (e) { GAME.logError('ai.explosion', e); }
    }
    if (ctx && ctx.audio && ctx.audio.play) {
      try { ctx.audio.play('explosion', { position: g.pos, volume: 1 }); } catch (e) { /* optional */ }
    }
    if (ctx && ctx.postfx && ctx.postfx.addImpulse) {
      try { ctx.postfx.addImpulse('explosion', 1); } catch (e) { /* optional */ }
    }
    var th = this.threat;
    if (th.valid && ctx && ctx.player && ctx.player.takeDamage) {
      var d = g.pos.distanceTo(th.chest);
      if (d < radius) {
        _v8.copy(th.chest).sub(g.pos).normalize();
        var falloff = 1 - d / radius;
        // line of sight matters: a wall between you and the blast saves you
        if (!this.world.blocked(g.pos, th.chest, 0.2)) {
          try { ctx.player.takeDamage(78 * falloff * falloff, _v8.multiplyScalar(-1)); }
          catch (e) { GAME.logError('ai.blast', e); }
        }
      }
    }
    this.hearNoise(g.pos, 90);
  };

  // ------------------------------------------------------------- utilities --
  AISystem.prototype.hearNoise = function (pos, loud) {
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.alive) e.hearNoise(pos, loud || 40);
    }
  };

  AISystem.prototype.alertAll = function (pos) {
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (!e.alive) continue;
      e.awareness = 1;
      if (pos) { e.lastKnown.copy(pos); e.hasLastKnown = true; }
      if (e.state === 'idle' || e.state === 'patrol') e.setState('alert');
    }
  };

  AISystem.prototype.onDeath = function (e) {
    this.coverSys.release(e.id);
    this._roleTimer = 0;                     // re-plan the squad immediately
    for (var i = 0; i < this.enemies.length; i++) {
      var o = this.enemies[i];
      if (o === e || !o.alive) continue;
      // seeing a squadmate drop is a stimulus in itself
      if (o.position.distanceToSquared(e.position) < 400) {
        o.awareness = Math.max(o.awareness, 0.8);
        o.suppress(0.3);
        if (!o.hasLastKnown && this.threat.valid) {
          o.lastKnown.copy(this.threat.pos);
          o.hasLastKnown = true;
        }
      }
    }
  };

  // Convenience for ballistics: closest hitbox hit along a ray.
  AISystem.prototype.raycastEnemies = function (origin, dir, maxDist, includeDead) {
    var best = null, bestT = maxDist;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (!e.alive && !includeDead) continue;
      var t = GAME.Collision.raycastSphere(origin, dir, e.boundsCenter, e.boundsRadius, null);
      if (t < 0 || t > bestT + e.boundsRadius) {
        // still allow a ray that starts inside the bounding sphere
        _v0.copy(e.boundsCenter).sub(origin);
        if (_v0.lengthSq() > e.boundsRadius * e.boundsRadius) continue;
      }
      for (var h = 0; h < e.hitboxes.length; h++) {
        var hb = e.hitboxes[h];
        var d = GAME.Collision.raycastBox(origin, dir, hb, _rayHit);
        if (d >= 0 && d < bestT) {
          bestT = d;
          best = best || { enemy: null, hitbox: null, distance: 0, point: new V3(), normal: new V3() };
          best.enemy = e;
          best.hitbox = hb;
          best.distance = d;
          best.point.copy(_rayHit.point);
          best.normal.copy(_rayHit.normal);
        }
      }
    }
    return best;
  };

  AISystem.prototype.setDifficulty = function (d) {
    d = d || {};
    if (d.reaction !== undefined) this.reaction = d.reaction;
    if (d.aimTime !== undefined) this.aimTime = d.aimTime;
    if (d.spread !== undefined) this.baseSpread = d.spread;
    if (d.damage !== undefined) this.damageScale = d.damage;
    if (d.view !== undefined) this.viewDistance = d.view;
    if (d.aimError !== undefined) this.aimErrorStart = d.aimError;
    if (d.aimErrorMin !== undefined) this.aimErrorMin = d.aimErrorMin;
    if (d.shooters !== undefined) this.maxShooters = d.shooters;
  };

  AISystem.prototype.despawnAll = function () {
    for (var i = 0; i < this.enemies.length; i++) this.enemies[i].dispose();
    this.enemies.length = 0;
    this._pathQueue.length = 0;
    for (i = 0; i < this._grenades.length; i++) {
      if (this._grenades[i].mesh) this.root.remove(this._grenades[i].mesh);
    }
    this._grenades.length = 0;
  };

  AISystem.prototype.dispose = function () {
    this.despawnAll();
    for (var i = 0; i < this.variants.length; i++) {
      if (this.variants[i].geometry) this.variants[i].geometry.dispose();
    }
    this.variants.length = 0;
    if (this.material) this.material.dispose();
    if (this.faceMaterial) this.faceMaterial.dispose();
    if (this.faceAtlas) this.faceAtlas.dispose();
    this.materials = null;
    if (this._nadeGeo) this._nadeGeo.dispose();
    if (this._nadeMat) this._nadeMat.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  };

  GAME.AISystem = AISystem;

})(window.GAME, window.THREE);
