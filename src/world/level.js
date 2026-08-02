// ============================================================================
// OPERATION BLACKOUT - src/world/level.js  ->  GAME.Level
//
// "AL-BAKR MARKET DISTRICT": a 72 m war-damaged market street running along -Z,
// 14 m facade-to-facade, 2-4 storey plaster-over-concrete blocks either side.
//
// Everything here is composed from a small MODULAR KIT (wall rect, window bay,
// door bay, shopfront, awning, canopy, balcony, string course, cornice,
// parapet, pilaster, stair flight, arch). Buildings differ in height, floor
// rhythm, bay count, colour, damage and are deliberately mis-aligned, because
// a facade kit used without variation reads as a tiling texture.
//
// Depth is the whole game: every opening has a 36 cm reveal, a protruding sill
// with a drip, a lintel, and a 3.5 cm plaster skin over a concrete/brick core
// so that where the plaster has spalled off you get a real chipped edge that
// catches the low sun. Nothing here is a flat extruded box.
//
// Geometry is authored into per-material buckets and merged once with
// GAME.Geo.mergeAll, so the whole level is ~18 draw calls. UVs come from
// GAME.Geo.worldUV for constant texel density, uv1 is copied for AO, and a
// vertex-colour pass paints ground grime, streaks under openings, sun bleach
// and scorch after the merge (materials.js consumes vertex colours).
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // ---------------------------------------------------------------- layout --
  var STREET_HALF = 5.0;    // kerb line, |x|  -> 10 m of roadway
  var FACADE_X = 7.0;       // building faces, |x| -> 14 m street
  var KERB_H = 0.15;
  var Z_SOUTH = 17.0;       // south end of the street (player spawns here)
  var Z_NORTH = -55.0;      // north end, closed by an arched cross-block
  var WALL_T = 0.36;        // structural wall thickness
  var SKIN_T = 0.035;       // plaster skin thickness -> spall depth
  var REVEAL = 0.26;        // glass plane sits this far behind the facade
  var UP = new THREE.Vector3(0, 1, 0);

  // Surface UV density (world metres -> uv). Consistent texel density across
  // wildly different surface sizes is the single cheapest realism win.
  var SURF = {
    asphalt:          { uv: 0.30, cast: false, recv: true },
    concrete:         { uv: 0.42, cast: true,  recv: true },
    // Precast units - jersey barriers. 'concrete' runs at 0.42 uv, which is one
    // texture tile per 2.4 m: across the 0.86 m face of a barrier that samples
    // a single low-contrast patch, so the unit rendered as a pale slab with no
    // aggregate, no grain and no readable material at all - the "floating white
    // rectangle" in enemy_closeup. Same map, twice the texel density.
    precast:          { uv: 0.82, cast: true,  recv: true, base: 'concrete' },
    concrete_wall:    { uv: 0.34, cast: true,  recv: true },
    plaster:          { uv: 0.36, cast: true,  recv: true },
    brick:            { uv: 0.55, cast: true,  recv: true },
    sand:             { uv: 0.55, cast: false, recv: true },
    gravel:           { uv: 1.05, cast: true,  recv: true },
    // roofing felt: same bitumen as the road but at building-detail texel
    // density, so a roof deck never reads as a gravel path
    rooffelt:         { uv: 1.55, cast: false, recv: true, base: 'gravel' },
    // Hessian sacking. Asks the library for its own `sandbag` material (which
    // exists, and now has a real jute recipe behind it in textures.js) rather
    // than hijacking the red awning canvas. Whatever albedo comes back is
    // MEASURED and corrected onto hessian in the vertex-colour pass, so the
    // sacks stay right whether or not the library's routing is fixed today.
    // `rough` is forced high: jute sacking has no sheen whatsoever, and the
    // library's default gave every bag in the revetment a broad plastic
    // highlight that made a hundred of them read as moulded shells.
    sandbag:          { uv: 2.10, cast: true,  recv: true, rough: 0.98 },
    tile:             { uv: 0.85, cast: false, recv: true },
    // Standing water. Borrows the concrete grain, then overrides roughness and
    // env response so the alley puddle actually mirrors the sky instead of
    // being a dry slab painted 34% darker. `rough`/`env` are consumed by
    // Level.material(); anything without them is untouched.
    wet:              { uv: 0.55, cast: false, recv: true, base: 'concrete',
                        rough: 0.085, env: 1.7 },
    wood_plank:       { uv: 0.85, cast: true,  recv: true },
    rusted_metal:     { uv: 0.90, cast: true,  recv: true },
    painted_metal:    { uv: 0.90, cast: true,  recv: true },
    corrugated_metal: { uv: 0.75, cast: true,  recv: true },
    fabric:           { uv: 1.05, cast: true,  recv: true },
    rubber:           { uv: 1.20, cast: true,  recv: true },
    glass:            { uv: 0.50, cast: false, recv: false },
    backdrop:         { uv: 0.34, cast: false, recv: true, base: 'concrete_wall' },
    // Receives, but deliberately does NOT cast: at a 14 degree sun a 20 m
    // distant block throws an 80 m shadow, which would land straight across the
    // playable street from something the player can never see.
    //
    // `own` -> the far ring does NOT borrow a library material. Everything in
    // the library is authored at centimetre scale, and at 34-124 m a 1 tile/m
    // map minifies to nothing but its own mean: measured on rooftop.png, a
    // whole distant tower came back at luminance std 0.007, i.e. a flat
    // single-colour surface, straight off the instant-fail list. The only
    // features that survive that range are ARCHITECTURAL ones - storey lines,
    // openings, piers, sills, parapets - so the far city gets its own map whose
    // feature size is metres (distantFacadeTexture), box-projected per block at
    // an integer tile count per face (_distantUV) so no opening is ever cut and
    // no two neighbouring towers share a window rhythm. `uv` is unused here.
    distant:          { uv: 0.22, cast: false, recv: true, own: true }
  };

  // Fallback appearance if materials.js is missing or throws - the level must
  // still read as architecture rather than as magenta error boxes.
  var FALLBACK = {
    asphalt:          [0x46443f, 0.94, 0.0],
    concrete:         [0x9a958c, 0.88, 0.0],
    precast:          [0x8e887e, 0.90, 0.0],
    concrete_wall:    [0x8d877e, 0.90, 0.0],
    plaster:          [0xcbb392, 0.86, 0.0],
    brick:            [0x94614a, 0.90, 0.0],
    sand:             [0xc9b08a, 0.96, 0.0],
    gravel:           [0x8b8378, 0.95, 0.0],
    rooffelt:         [0x4b4843, 0.95, 0.0],
    sandbag:          [0xa08f6c, 0.96, 0.0],
    tile:             [0x9a948a, 0.55, 0.0],
    wood_plank:       [0x6b5540, 0.82, 0.0],
    rusted_metal:     [0x7a4530, 0.80, 0.65],
    painted_metal:    [0x545b64, 0.55, 0.55],
    corrugated_metal: [0x877f72, 0.62, 0.62],
    // neutral cloth: canopy/sandbag colour comes from per-piece vertex tints,
    // so the base must not fight them
    fabric:           [0xb0a48c, 0.95, 0.0],
    rubber:           [0x222429, 0.95, 0.0],
    glass:            [0x2a3a42, 0.08, 0.0],
    backdrop:         [0x4a453f, 0.95, 0.0],
    // Only reached if the canvas 2d context is unavailable. Deliberately below
    // sunlit plaster (#d9c3a0): a far city that out-values the foreground it
    // sits behind inverts the depth read.
    distant:          [0x77715f, 0.95, 0.0],
    wet:              [0x6d7076, 0.09, 0.0]
  };

  // --------------------------------------------------------- small helpers --
  var _e1 = new THREE.Euler();
  var _tmpV = new THREE.Vector3();

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

  // Bevelled boxes are the atom of the whole level. They are cached by size and
  // pre-converted to non-indexed so mergeAll does not re-expand them 8000 times.
  var _boxCache = new Map();
  function box(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.012, Math.min(w, h, d) * 0.3);
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

  // Rounded "pillow" box - cloth bundles, kit rolls. seg 2 leaves mid vertices
  // un-chamfered so the faces bulge instead of going flat.
  var _pillowCache = new Map();
  function pillow(w, h, d, bevel) {
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3);
    var g = _pillowCache.get(k);
    if (!g) {
      var src = Geo.bevelBox(w, h, d, bevel || Math.min(w, h, d) * 0.42, 2);
      g = src.toNonIndexed(); src.dispose();
      _pillowCache.set(k, g);
    }
    return g;
  }

  // ---- filled sacks ---------------------------------------------------------
  // A sandbag is NOT a box. One cached bevelled box laid in courses gives every
  // bag in a revetment an identical rectangular silhouette in perfect running
  // bond, which is what made the emplacement read as a brick wall in every
  // street framing. These are squashed, noise-displaced spheres: six variants,
  // ~90 tris each, cached, so the cost is six geometries no matter how many
  // bags are laid, and no two neighbours share an outline.
  var _sackCache = [];
  var SACK_N = 6;
  // Size classes. Bags arrive from different sources and are filled by
  // different people; without a spread the COURSE LINE stays a straight line
  // and the wall reads as masonry however lumpy each individual bag is.
  var SACK_SIZE = [0.84, 0.93, 1.0, 1.0, 1.08, 1.18];
  // Hessian, faded polypropylene (the green and blue ones), and bags that have
  // been out in the sun for two summers. A revetment is never one colour.
  var SACK_HUE = [0xa89a78, 0x9c8f70, 0xb3a582, 0x8d8268, 0xbfae90, 0x8a7f62,
                  0x7f8467, 0x6f7a63, 0xc0b393, 0x94896f];
  function sackGeo(idx, noise) {
    var g = _sackCache[idx];
    if (g) return g;
    var src = new THREE.SphereGeometry(0.5, 11, 7);
    var p = src.attributes.position;
    var seed = 13.7 + idx * 9.31;
    // half extents of a filled bag laid flat: 460 x 170 x 300 mm
    var hx = 0.23, hy = 0.085, hz = 0.15;
    // p-norm exponent. A SQUASHED SPHERE was the mistake: scaling a sphere
    // anisotropically leaves the equator as a knife edge, and a wall of them
    // reads as a stack of clam shells - which is exactly what the street
    // capture showed. A p-norm of ~3.4 gives a genuine pillow: flat-ish top
    // and bottom, generously rounded corners, a rounded-RECTANGLE silhouette.
    var NEXP = 3.4, i, x, y, z;
    for (i = 0; i < p.count; i++) {
      // unit direction (the source sphere has radius 0.5)
      x = p.getX(i) * 2; y = p.getY(i) * 2; z = p.getZ(i) * 2;
      var q = Math.pow(Math.pow(Math.abs(x), NEXP) + Math.pow(Math.abs(y), NEXP) +
        Math.pow(Math.abs(z), NEXP), 1 / NEXP);
      var r = 1 / Math.max(1e-4, q);
      p.setXYZ(i, x * r * hx, y * r * hy, z * r * hz);
    }
    src.computeVertexNormals();
    var nrm = src.attributes.normal;
    for (i = 0; i < p.count; i++) {
      x = p.getX(i); y = p.getY(i); z = p.getZ(i);
      // Two lobes: a wide one, because the fill always settles to one end and
      // a filled bag is asymmetric, and a tighter one for the wrinkles and the
      // slack fabric at the tied end. A single high-frequency term only gave
      // an evenly pebbled surface, which at street distance still read smooth.
      var d = noise
        ? noise.fbm3(seed + x * 4.6, seed * 0.7 + y * 4.6, seed * 1.3 + z * 4.6, 2) * 0.040 +
          noise.fbm3(seed * 2.7 + x * 15.0, seed + y * 15.0, seed * 0.4 + z * 15.0, 2) * 0.014
        : 0;
      var nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      // vertical displacement is damped: bags are squeezed flat by the course
      // above them, so they bulge sideways far more than they bulge upward
      p.setXYZ(i, x + nx * d, y + ny * d * 0.45, z + nz * d);
    }
    src.computeVertexNormals();
    g = src.toNonIndexed(); src.dispose();
    _sackCache[idx] = g;
    return g;
  }

  // An irregular disc: puddles, sand drifts, ponding stains. A rectangle laid
  // flat on the ground is the loudest possible "decal" tell.
  function blobDisc(rng, r, aspect, ragged) {
    var n = 18, pos = [], nor = [], i;
    var rad = [];
    var ph = rng.range(0, 6.283), ph2 = rng.range(0, 6.283);
    for (i = 0; i < n; i++) {
      var a = i / n * 6.28318;
      rad.push(r * (1 + ragged * (0.42 * Math.sin(a * 2 + ph) + 0.26 * Math.sin(a * 3.3 + ph2)
        + 0.14 * Math.sin(a * 5.1 - ph))));
    }
    for (i = 0; i < n; i++) {
      var a0 = i / n * 6.28318, a1 = (i + 1) / n * 6.28318;
      var r0 = rad[i], r1 = rad[(i + 1) % n];
      pos.push(0, 0, 0,
        Math.cos(a0) * r0, 0, Math.sin(a0) * r0 * aspect,
        Math.cos(a1) * r1, 0, Math.sin(a1) * r1 * aspect);
      nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  var _cylCache = new Map();
  function cyl(rTop, rBot, len, seg) {
    seg = seg || 8;
    var k = rTop.toFixed(3) + ',' + rBot.toFixed(3) + ',' + len.toFixed(3) + ',' + seg;
    var g = _cylCache.get(k);
    if (!g) {
      var src = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, false);
      g = src.toNonIndexed(); src.dispose();
      _cylCache.set(k, g);
    }
    return g;
  }

  // Extrude a closed CCW 2D profile along Z. Used for jersey barriers, kerb
  // stones and cornice mouldings, where a box would kill the silhouette.
  function extrudeProfile(pts, len) {
    var n = pts.length, hl = len * 0.5;
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
    var i, a, b;
    for (i = 0; i < n; i++) {
      a = pts[i]; b = pts[(i + 1) % n];
      tri(a[0], a[1], -hl, b[0], b[1], -hl, b[0], b[1], hl);
      tri(a[0], a[1], -hl, b[0], b[1], hl, a[0], a[1], hl);
    }
    var cx = 0, cy = 0;
    for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    for (i = 0; i < n; i++) {
      a = pts[i]; b = pts[(i + 1) % n];
      tri(cx, cy, hl, a[0], a[1], hl, b[0], b[1], hl);
      tri(cx, cy, -hl, b[0], b[1], -hl, a[0], a[1], -hl);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    return g;
  }

  var _profCache = new Map();
  function profileGeo(name, pts, len) {
    var k = name + '|' + len.toFixed(3);
    var g = _profCache.get(k);
    if (!g) { g = extrudeProfile(pts, len); _profCache.set(k, g); }
    return g;
  }

  var JERSEY = [[-0.31, 0], [0.31, 0], [0.31, 0.11], [0.155, 0.34],
                [0.115, 0.86], [-0.115, 0.86], [-0.155, 0.34], [-0.31, 0.11]];
  var KERBSTONE = [[-0.16, -0.34], [0.16, -0.34], [0.16, 0.10], [0.10, 0.16], [-0.16, 0.16]];

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
  // A transform stack + per-material geometry buckets. Every kit function
  // authors in a convenient local frame and the stack does the rest.
  function Builder() {
    this.buckets = Object.create(null);
    this._stack = [new THREE.Matrix4()];
    this.tint = null;
    this.paint = 'wall';
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
  Builder.prototype.worldPoint = function (x, y, z, out) {
    return (out || new THREE.Vector3()).set(x, y, z).applyMatrix4(this.top());
  };

  // ================================================= spall / hole subdivision =
  // A kd-subdivision of a wall rectangle that skips anything swallowed by a
  // blob. Only the blob boundary gets subdivided, so an undamaged rect stays a
  // single box: this is what keeps 14 detailed facades inside the tri budget.
  function blobRadius(b, ang) {
    return b.r * (1 + 0.30 * Math.sin(ang * 3 + b.p) + 0.16 * Math.sin(ang * 5.3 - b.p * 2.1));
  }
  function subdivide(x0, y0, x1, y1, blobs, minSize, out) {
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0.006 || h <= 0.006) return;
    var cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
    var cr = Math.sqrt(w * w + h * h) * 0.5;
    var partial = false, i, b, dx, dy, d;
    for (i = 0; i < blobs.length; i++) {
      b = blobs[i];
      dx = cx - b.x; dy = cy - b.y;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d + cr <= b.r * 0.54) return;          // swallowed whole
      if (d - cr < b.r * 1.46) partial = true;   // straddles an edge
    }
    if (!partial) { out.push([x0, y0, x1, y1, 0]); return; }
    if (Math.max(w, h) <= minSize) {
      out.push([x0, y0, x1, y1, 1]);             // chipped edge cell
      return;
    }
    if (w >= h) {
      var mx = (x0 + x1) * 0.5;
      subdivide(x0, y0, mx, y1, blobs, minSize, out);
      subdivide(mx, y0, x1, y1, blobs, minSize, out);
    } else {
      var my = (y0 + y1) * 0.5;
      subdivide(x0, y0, x1, my, blobs, minSize, out);
      subdivide(x0, my, x1, y1, blobs, minSize, out);
    }
  }

  function overlapping(blobs, x0, y0, x1, y1, pad) {
    var out = null;
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i], r = b.r * 1.5 + (pad || 0);
      if (b.x + r < x0 || b.x - r > x1 || b.y + r < y0 || b.y - r > y1) continue;
      (out || (out = [])).push(b);
    }
    return out || EMPTY;
  }
  var EMPTY = [];

  // --------------------------------------------------------- cell coalescing --
  // The kd-subdivision above only exists to find the DAMAGE BOUNDARY, but it
  // leaves the intact interior chopped into a grid of cells. Emitting one box
  // per cell gave every 0.3 m of undamaged wall its own silhouette edge, its own
  // bevel highlight and its own shading break - a literal checkerboard, and the
  // measured source of the wall repetition. Run-length merging along x then y
  // turns an intact 3 x 3 m region back into ONE box.
  function cmpX(a, b) { return a[0] - b[0]; }
  function cmpY(a, b) { return a[1] - b[1]; }
  function mergeAxis(list, axis) {
    var groups = new Map(), i, c, key, g;
    for (i = 0; i < list.length; i++) {
      c = list[i]; if (c[5]) continue;
      key = axis === 0 ? (c[1].toFixed(4) + ',' + c[3].toFixed(4))
        : (c[0].toFixed(4) + ',' + c[2].toFixed(4));
      g = groups.get(key); if (!g) groups.set(key, g = []);
      g.push(c);
    }
    var changed = false;
    groups.forEach(function (grp) {
      grp.sort(axis === 0 ? cmpX : cmpY);
      var cur = null;
      for (var q = 0; q < grp.length; q++) {
        var e = grp[q];
        if (cur && Math.abs(axis === 0 ? (e[0] - cur[2]) : (e[1] - cur[3])) < 1e-4) {
          if (axis === 0) cur[2] = e[2]; else cur[3] = e[3];
          e[5] = 1; changed = true;
        } else cur = e;
      }
    });
    return changed;
  }
  function coalesce(cells) {
    var live = [], i;
    for (i = 0; i < cells.length; i++) {
      if (cells[i][4] === 0) { cells[i][5] = 0; live.push(cells[i]); }
    }
    var guard = 0, changed = true;
    while (changed && guard++ < 5) {
      changed = mergeAxis(live, 0);
      if (mergeAxis(live, 1)) changed = true;
      var nl = [];
      for (i = 0; i < live.length; i++) if (!live[i][5]) nl.push(live[i]);
      live = nl;
    }
    return live;
  }

  // Pull a boundary cell back onto the blob outline. The cell's OUTER edge stays
  // put and its inner edge lands exactly on blobRadius, so the damage edge is a
  // chord of the real outline instead of an axis-aligned staircase step.
  function clipToBlobs(c, blobs) {
    var cw = c[2] - c[0], ch = c[3] - c[1];
    var cx = (c[0] + c[2]) * 0.5, cy = (c[1] + c[3]) * 0.5;
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var dx = cx - b.x, dy = cy - b.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-4) return null;
      var ux = dx / d, uy = dy / d;
      var R = blobRadius(b, Math.atan2(dy, dx));
      var hd = 0.5 * (Math.abs(ux) * cw + Math.abs(uy) * ch);
      var pen = R - (d - hd);
      if (pen <= 0) continue;                       // blob does not reach here
      if (pen >= 2 * hd - 0.005) return null;       // cell swallowed whole
      cw -= pen * Math.abs(ux); ch -= pen * Math.abs(uy);
      cx += ux * pen * 0.5; cy += uy * pen * 0.5;
      if (cw < 0.06 || ch < 0.06) return null;   // invisible sliver, not worth a box
    }
    c[0] = cx - cw * 0.5; c[1] = cy - ch * 0.5;
    c[2] = cx + cw * 0.5; c[3] = cy + ch * 0.5;
    return c;
  }
  function chipCells(cells, blobs, out) {
    out.length = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i][4] !== 1) continue;
      if (clipToBlobs(cells[i], blobs)) out.push(cells[i]);
    }
    return out;
  }
  var _chipBuf = [];

  // GAME.Geo.bevelBox with seg 1 pulls all eight corners inward, so a "bevel" of
  // b does not chamfer - it SHRINKS the box by 2b on every axis. For wall panels
  // that have to butt against their neighbours that 2b is a dark gap straight
  // through to the core, which is what drew a seam around every spall cell. The
  // nominal size is therefore padded back out so the solid is exactly w x h x d
  // and the rounding stays purely cosmetic.
  function padBox(B, key, w, h, d, x, y, z, bevel) {
    var b2 = bevel * 2;
    return B.box(key, w + b2, h + b2, d + b2, x, y, z, bevel);
  }

  // Same, but rolled about the surface normal and slightly overscaled. This is
  // what kills the staircase: the kd-subdivision can only resolve a damage
  // boundary to axis-aligned cells, so every spall patch came out as a
  // rectangle with hard 90-degree corners at the subdivision pitch. Rolling
  // each boundary cell a few degrees and letting it overlap its neighbours
  // means adjacent cell edges are never collinear and the margin reads ragged.
  function padBoxR(B, key, w, h, d, x, y, z, rz, over, bevel) {
    var b2 = bevel * 2;
    return B.boxR(key, w * over + b2, h * over + b2, d + b2, x, y, z, 0, 0, rz, bevel);
  }

  // Per-chip albedo jitter. Exposed render/masonry that has come off a wall in
  // three different decades is never one value: this varies lightness and
  // pushes each patch warm or cool by a few percent off the building tint.
  function chipTint(base, rng) {
    var f = rng.range(0.88, 1.14);
    var wc = rng.range(-0.06, 0.06);
    var c = new THREE.Color(f * (1 + wc), f * (1 - wc * 0.15), f * (1 - wc));
    if (base) { c.r *= base.r; c.g *= base.g; c.b *= base.b; }
    return c;
  }

  // A solid piece of wall: concrete/brick core + plaster skin with spall.
  // `holes` punch through the core as well (shell damage), `spall` only lifts
  // the plaster off.
  //
  // Surface variation lives in the vertex-colour pass, NOT in per-cell geometry
  // offsets: a 2 mm z-jitter per tile plus a bevel per tile draws a visible seam
  // around every tile, which is exactly what a wall must never have.
  function wallRect(B, x0, y0, x1, y1, rng, S) {
    var w = x1 - x0, h = y1 - y0;
    if (w <= 0.01 || h <= 0.01) return;
    var coreT = WALL_T - SKIN_T;
    var holes = overlapping(S.holes, x0, y0, x1, y1, 0.1);
    var i, c, full, chip;

    // ---- structural core -------------------------------------------------
    if (holes.length === 0) {
      B.box(S.coreKey, w, h, coreT, (x0 + x1) * 0.5, (y0 + y1) * 0.5, -SKIN_T - coreT * 0.5, 0.01);
    } else {
      var cells = [];
      subdivide(x0, y0, x1, y1, holes, S.spallMin ? S.spallMin + 0.02 : 0.36, cells);
      full = coalesce(cells);
      for (i = 0; i < full.length; i++) {
        c = full[i];
        padBox(B, S.coreKey, c[2] - c[0], c[3] - c[1], coreT, (c[0] + c[2]) * 0.5,
          (c[1] + c[3]) * 0.5, -SKIN_T - coreT * 0.5, 0.006);
      }
      chip = chipCells(cells, holes, _chipBuf);
      for (i = 0; i < chip.length; i++) {
        c = chip[i];
        var dep = coreT * rng.pick(CHIP);
        padBoxR(B, S.coreKey, c[2] - c[0], c[3] - c[1], dep, (c[0] + c[2]) * 0.5,
          (c[1] + c[3]) * 0.5, -WALL_T + dep * 0.5,
          rng.range(-0.35, 0.35), 1.08, 0.005).tint = chipTint(B.tint, rng);
      }
    }

    // ---- plaster skin ----------------------------------------------------
    var sb = overlapping(S.skinBlobs, x0, y0, x1, y1, 0.1);
    var all = sb.length ? (holes.length ? sb.concat(holes) : sb) : holes;
    var scells = [];
    if (all.length === 0) scells.push([x0, y0, x1, y1, 0]);
    else subdivide(x0, y0, x1, y1, all, S.spallMin || 0.34, scells);
    full = coalesce(scells);
    for (i = 0; i < full.length; i++) {
      c = full[i];
      padBox(B, 'plaster', c[2] - c[0], c[3] - c[1], SKIN_T, (c[0] + c[2]) * 0.5,
        (c[1] + c[3]) * 0.5, -SKIN_T * 0.5, 0.005);
    }
    chip = chipCells(scells, all, _chipBuf);
    for (i = 0; i < chip.length; i++) {
      c = chip[i];
      var d = SKIN_T * rng.pick(CHIP);
      var ce = padBoxR(B, 'plaster', c[2] - c[0], c[3] - c[1], d, (c[0] + c[2]) * 0.5,
        (c[1] + c[3]) * 0.5, -SKIN_T + d * 0.5,
        rng.range(-0.35, 0.35), 1.08, 0.004);
      ce.dark = rng.range(0.05, 0.28);
      ce.tint = chipTint(B.tint, rng);
    }
  }
  var CHIP = [0.34, 0.5, 0.62, 0.78, 0.9];

  // Mineral-surfaced bitumen felt. The albedo comes from 'gravel' (the only
  // library surface whose grain is actually roofing chippings). The 0.60 grey
  // this used to multiply by took the deck to roughly 8% reflectance, which
  // under a 14-degree sun and behind a 1 m parapet rendered as a literal black
  // hole across the bottom half of the rooftop framing. The VALUE is now pinned
  // by a measured albedo correction (see FELT_TARGET) and this is only the warm
  // dust cast on top of it.
  var FELT = new THREE.Color(1.00, 0.97, 0.91);
  // Weathered bitumen under desert dust, and the linear albedo it must land on.
  // 15.5% is a dusty felt roof; bare new bitumen would be 6% and unshootable.
  var FELT_TARGET = 0x8f8577;

  // Worn thermoplastic line marking, lifted off the concrete albedo it borrows.
  var LINE_PAINT = new THREE.Color(1.95, 1.88, 1.70);

  // Limewash over render, for the surfaces that never see the sun: the alley
  // flanks and its dead end. ~1.65x bare render's reflectance, very slightly
  // warm so it does not go blue when the cool sky fill is the only light on it.
  var LIMEWASH = new THREE.Color(1.44, 1.40, 1.31);
  // The same idea for a shaded ground plane, at a gentler ratio.
  var PAVE_LIFT = new THREE.Color(1.26, 1.24, 1.19);
  // Glazed wall tile: the cool green-white dado every shop and stair hall in
  // this city has to about a metre. Deliberately COOLER than everything around
  // it - one cold band under a warm plaster wall is the cheapest material break
  // an interior can have, and it is what stops a lit room reading as one beige
  // plane. An unclamped multiplier, like LIMEWASH: glazed tile really is far
  // brighter than bare render.
  var TILE_DADO = new THREE.Color(1.06, 1.22, 1.24);
  // Pale terrazzo, for counter tops and thresholds. Lifted well above the
  // library's tile albedo because a horizontal surface under a ceiling sees no
  // sky at all, and at a mid albedo it renders as a black plane.
  var TERRAZZO = new THREE.Color(1.36, 1.31, 1.20);
  // Faded gloss on back-of-house doors, lifted off painted_metal's gunmetal.
  var DOOR_G = new THREE.Color(1.42, 1.66, 1.34);
  var DOOR_R = new THREE.Color(1.85, 1.36, 1.02);
  // Precast concrete, cast on five different days and weathered for five
  // different lengths of time. All BELOW 1: the library's concrete albedo is a
  // fresh-slab value and a street barrier is never that bright.
  var PRECAST = [
    new THREE.Color(0.80, 0.78, 0.73), new THREE.Color(0.74, 0.72, 0.68),
    new THREE.Color(0.86, 0.83, 0.75), new THREE.Color(0.70, 0.69, 0.67),
    new THREE.Color(0.82, 0.79, 0.70)
  ];

  // ============================================================== FACADE KIT ==
  // All kit functions author in a local frame where +Z is the OUTWARD normal,
  // +X runs along the street and y = 0 is the pavement. One kit, four
  // orientations (west face, east face, and the two cross-block terminators).

  function windowFrame(B, cx, cy, w, h, S) {
    var t = 0.055, z = -(S.reveal || REVEAL), key = S.frameKey;
    B.box(key, w + t, t, t * 1.5, cx, cy + h * 0.5 + t * 0.5, z, 0.008);
    B.box(key, w + t, t, t * 1.5, cx, cy - h * 0.5 - t * 0.5, z, 0.008);
    B.box(key, t, h, t * 1.5, cx - w * 0.5 - t * 0.5, cy, z, 0.008);
    B.box(key, t, h, t * 1.5, cx + w * 0.5 + t * 0.5, cy, z, 0.008);
    B.box(key, 0.04, h, t * 1.2, cx, cy, z, 0.006);
    B.box(key, w, 0.04, t * 1.2, cx, cy + h * 0.12, z, 0.006);
  }

  // Blown-out glazing: jagged remnants clinging to the frame read far better
  // than an empty hole, and they catch a specular from the low sun.
  //
  // `depth` is the LOCAL z of the glazing plane and is explicit on purpose: it
  // used to be hard-coded to the facade-kit reveal, so every caller that was not
  // inside a facade transform dumped its shards into open air metres away from
  // any window. An optional argument cannot be got wrong silently.
  function brokenGlass(B, cx, cy, w, h, rng, depth) {
    var n = rng.int(4, 8);
    var gz = (depth === undefined) ? -REVEAL - 0.012 : depth;
    for (var i = 0; i < n; i++) {
      var side = i % 4;
      var sw = rng.range(0.07, 0.26), sh = rng.range(0.08, 0.30);
      var px = cx, py = cy;
      if (side === 0) { px = cx + rng.range(-w * 0.45, w * 0.45); py = cy + h * 0.5 - sh * 0.5; }
      else if (side === 1) { px = cx + rng.range(-w * 0.45, w * 0.45); py = cy - h * 0.5 + sh * 0.5; }
      else if (side === 2) { px = cx - w * 0.5 + sw * 0.5; py = cy + rng.range(-h * 0.4, h * 0.4); }
      else { px = cx + w * 0.5 - sw * 0.5; py = cy + rng.range(-h * 0.4, h * 0.4); }
      B.boxR('glass', sw, sh, 0.008, px, py, gz,
        rng.range(-0.12, 0.12), 0, rng.range(-0.5, 0.5), 0.003);
    }
  }

  // Hinged about its outer stile so a half-open shutter throws a real shadow.
  function shutter(B, hingeX, cy, w, h, dir, ang, S) {
    B.pushXYZ(hingeX, cy, -0.045, 0, dir * ang, 0);
    var t = 0.045;
    B.box(S.frameKey, w, t * 1.4, t, dir * w * 0.5, h * 0.5 - t * 0.7, 0, 0.006);
    B.box(S.frameKey, w, t * 1.4, t, dir * w * 0.5, -h * 0.5 + t * 0.7, 0, 0.006);
    B.box(S.frameKey, t, h, t, dir * t * 0.5, 0, 0, 0.006);
    B.box(S.frameKey, t, h, t, dir * (w - t * 0.5), 0, 0, 0.006);
    var slats = Math.max(4, Math.floor(h / 0.16));
    for (var i = 0; i < slats; i++) {
      var sy = -h * 0.5 + t * 1.4 + (i + 0.5) * (h - t * 2.8) / slats;
      B.boxR(S.frameKey, w - t * 2, 0.026, 0.032, dir * w * 0.5, sy, 0.004, -0.34, 0, 0, 0.004);
    }
    B.pop();
  }

  // Segmental-arched head over an opening: a ring of voussoirs plus a keystone.
  // One of the three opening archetypes that stop twelve buildings reading as
  // one continuous kit.
  function archHead(B, cx, y, w, rise, S) {
    var r = (w * w * 0.25 + rise * rise) / (2 * rise);   // segment radius
    var half = Math.asin(Math.min(1, w * 0.5 / r));
    var yc = y - (r - rise);
    var n = Math.max(7, Math.round(w / 0.24));
    for (var i = 0; i < n; i++) {
      var a = -half + (i + 0.5) * (2 * half / n);
      B.boxR('concrete', 0.22, r * 2 * half / n * 1.25, 0.20,
        cx + Math.sin(a) * (r + 0.10), yc + Math.cos(a) * (r + 0.10), 0.05,
        0, 0, -a, 0.012);
      // the wall infill between the arch line and the flat top of the bay
      var sh = (y + rise) - (yc + Math.cos(a) * r);
      if (sh > 0.02) {
        B.box(S.coreKey, w / n + 0.006, sh, WALL_T - SKIN_T,
          cx + Math.sin(a) * r, yc + Math.cos(a) * r + sh * 0.5, -SKIN_T - (WALL_T - SKIN_T) * 0.5, 0.006);
        B.box('plaster', w / n + 0.006, sh, SKIN_T,
          cx + Math.sin(a) * r, yc + Math.cos(a) * r + sh * 0.5, -SKIN_T * 0.5, 0.004);
      }
    }
    B.box('concrete', 0.26, rise * 0.72 + 0.26, 0.24, cx, y + rise * 0.2, 0.06, 0.014);
  }

  // ---- the workhorse: one window bay ---------------------------------------
  function windowBay(B, x0, x1, ybase, h, rng, S, opt) {
    opt = opt || {};
    var REV = S.reveal || REVEAL;
    var bayW = x1 - x0, cx = (x0 + x1) * 0.5;
    // Three archetypes on top of the plain rectangle: a segmental-arched head,
    // a full-height balcony door with no apron wall under it, and a small
    // square loophole/vent for stair cores and top floors.
    var kind = opt.kind || 'win';
    if (kind === 'vent') {
      var vw = M.clamp(bayW * 0.22, 0.42, 0.72), vh = vw * rng.range(0.8, 1.15);
      var vy = ybase + h * 0.52;
      wallRect(B, x0, ybase, cx - vw * 0.5, ybase + h, rng, S);
      wallRect(B, cx + vw * 0.5, ybase, x1, ybase + h, rng, S);
      wallRect(B, cx - vw * 0.5, ybase, cx + vw * 0.5, vy, rng, S);
      wallRect(B, cx - vw * 0.5, vy + vh, cx + vw * 0.5, ybase + h, rng, S);
      B.box('concrete', vw + 0.22, 0.06, 0.15, cx, vy - 0.03, 0.04, 0.01);
      B.box('concrete', vw + 0.24, 0.09, 0.1, cx, vy + vh + 0.045, 0.025, 0.01);
      B.dark = 0.8;
      B.box('backdrop', vw, vh, 0.1, cx, vy + vh * 0.5, -REV - 0.02, 0.008);
      B.dark = 0;
      for (var vb = 0; vb < 3; vb++) {
        B.cyl('rusted_metal', 0.016, 0.016, vh, cx - vw * 0.3 + vb * vw * 0.3,
          vy + vh * 0.5, -REV + 0.03, 0, 0, 0, 5);
      }
      return { cx: cx, sy: vy, winW: vw, winH: vh };
    }
    var door = (kind === 'door');
    var winW = M.clamp(bayW * (door ? 0.40 : 0.44), 0.82, 1.5);
    var winH = M.clamp(h * (opt.tall ? 0.62 : 0.52), 1.05, 1.95);
    var sy = ybase + h * (opt.tall ? 0.26 : 0.32);
    if (door) { sy = ybase + 0.06; winH = M.clamp(h * 0.66, 1.9, 2.35); }
    var wx0 = cx - winW * 0.5, wx1 = cx + winW * 0.5;
    var wy1 = sy + winH;
    var rise = 0;
    if (kind === 'arch') {
      rise = M.clamp(winW * 0.22, 0.2, 0.42);
      rise = Math.min(rise, Math.max(0, (ybase + h - wy1) * 0.62));
      if (rise < 0.1) rise = 0;
    }

    wallRect(B, x0, ybase, wx0, ybase + h, rng, S);
    wallRect(B, wx1, ybase, x1, ybase + h, rng, S);
    if (sy > ybase + 0.03) wallRect(B, wx0, ybase, wx1, sy, rng, S);
    wallRect(B, wx0, wy1 + rise, wx1, ybase + h, rng, S);

    // Sill protrudes with an under-drip, so it casts a hard line and seeds the
    // dirt streak the vertex-colour pass paints below it. The projection scales
    // with the reveal, which is a per-building value.
    var proj = M.clamp(REV * 0.62, 0.10, 0.26);
    if (door) {
      B.box('concrete', winW + 0.36, 0.09, proj + 0.24, cx, ybase + 0.045, proj * 0.7, 0.012);
    } else {
      B.box('concrete', winW + 0.30, 0.075, proj - 0.05, cx, sy - 0.037, proj * 0.26, 0.012);
      B.box('concrete', winW + 0.21, 0.032, proj - 0.11, cx, sy - 0.090, proj * 0.15, 0.008);
    }
    if (rise > 0) archHead(B, cx, wy1, winW + 0.06, rise, S);
    else B.box('concrete', winW + 0.34, 0.125, 0.11, cx, wy1 + 0.062, 0.028, 0.012);

    windowFrame(B, cx, sy + winH * 0.5, winW - 0.02, winH - 0.02, S);
    if (rng.next() > S.blownChance) {
      var g = B.box('glass', winW - 0.12, winH - 0.12, 0.012, cx, sy + winH * 0.5, -REV - 0.028, 0.004);
      g.paint = 'flat';
      g.dark = rng.range(0, 0.25);
    } else {
      brokenGlass(B, cx, sy + winH * 0.5, winW - 0.1, winH - 0.1, rng, -REV - 0.012);
      S.scorch.push({ p: B.worldPoint(cx, wy1 + 0.3, 0.06), r: rng.range(0.9, 1.5), k: 0.55 });
    }

    var roll = rng.next();
    if (roll < S.shutterChance) {
      var ang = rng.bool(0.45) ? rng.range(0.9, 2.0) : rng.range(0.05, 0.35);
      shutter(B, wx0 + 0.02, sy + winH * 0.5, winW * 0.5, winH, -1, ang, S);
      shutter(B, wx1 - 0.02, sy + winH * 0.5, winW * 0.5, winH, 1,
        rng.bool(0.5) ? ang * rng.range(0.4, 1.1) : rng.range(0.05, 0.3), S);
    } else if (roll < S.shutterChance + 0.15) {
      for (var p = 0; p < 3; p++) {
        B.boxR('wood_plank', winW + rng.range(0.05, 0.22), rng.range(0.16, 0.24), 0.028,
          cx + rng.range(-0.06, 0.06), sy + winH * (0.22 + p * 0.3), -0.055,
          0, 0, rng.range(-0.10, 0.10), 0.006);
      }
    }
    if (opt.balcony) balcony(B, cx, sy, Math.min(bayW - 0.35, winW + 1.05), rng);
    return { cx: cx, sy: sy, winW: winW, winH: winH };
  }

  // ---- balcony --------------------------------------------------------------
  function balcony(B, cx, y, w, rng) {
    var d = rng.range(0.85, 1.15), i;
    B.box('concrete', w, 0.15, d, cx, y - 0.075, d * 0.5, 0.014);
    B.box('concrete', w + 0.08, 0.05, d + 0.06, cx, y - 0.17, d * 0.5, 0.01);
    for (i = -1; i <= 1; i += 2) {
      B.boxR('concrete', 0.14, 0.26, d * 0.62, cx + i * (w * 0.5 - 0.16), y - 0.3, d * 0.33,
        0.24, 0, 0, 0.012);
    }
    if (rng.bool(0.45)) {
      var bh = 0.92, seg = Math.max(3, Math.round(w / 0.44));
      B.box('plaster', w, 0.16, 0.13, cx, y + bh - 0.08, d - 0.07, 0.01);
      B.box('plaster', w, 0.2, 0.13, cx, y + 0.1, d - 0.07, 0.01);
      for (i = 0; i < seg; i++) {
        B.box('plaster', w / seg * 0.42, bh - 0.44, 0.12,
          cx - w * 0.5 + (i + 0.5) * (w / seg), y + 0.2 + (bh - 0.44) * 0.5, d - 0.07, 0.008);
      }
      for (i = -1; i <= 1; i += 2) {
        B.box('plaster', 0.16, bh, 0.15, cx + i * (w * 0.5 - 0.08), y + bh * 0.5, d - 0.07, 0.01);
      }
    } else {
      // thin rusted railing - reads as a lace of shadow on the wall behind
      var rh = 0.98, n = Math.max(6, Math.round(w / 0.13));
      B.cyl('rusted_metal', 0.017, 0.017, w, cx, y + rh, d - 0.05, 0, 0, Math.PI / 2, 6);
      B.cyl('rusted_metal', 0.014, 0.014, w, cx, y + rh * 0.45, d - 0.05, 0, 0, Math.PI / 2, 6);
      for (i = 0; i < n; i++) {
        B.box('rusted_metal', 0.018, rh, 0.018, cx - w * 0.5 + (i + 0.5) * (w / n), y + rh * 0.5, d - 0.05, 0.004);
      }
      for (i = -1; i <= 1; i += 2) {
        B.box('rusted_metal', 0.03, rh, 0.03, cx + i * (w * 0.5 - 0.02), y + rh * 0.5, d - 0.05, 0.005);
        B.cyl('rusted_metal', 0.015, 0.015, d - 0.06, cx + i * (w * 0.5 - 0.02), y + rh, d * 0.5 - 0.02,
          Math.PI / 2, 0, 0, 6);
      }
    }
  }

  // ---- door bay -------------------------------------------------------------
  function doorBay(B, x0, x1, ybase, h, rng, S) {
    var bayW = x1 - x0, cx = (x0 + x1) * 0.5;
    var dw = M.clamp(bayW * 0.4, 0.95, 1.25), dh = 2.15;
    var dx0 = cx - dw * 0.5, dx1 = cx + dw * 0.5;
    wallRect(B, x0, ybase, dx0, ybase + h, rng, S);
    wallRect(B, dx1, ybase, x1, ybase + h, rng, S);
    wallRect(B, dx0, ybase + dh, dx1, ybase + h, rng, S);
    // raised architrave gives the entrance weight and a hard cast shadow
    B.box('concrete', dw + 0.42, 0.16, 0.13, cx, ybase + dh + 0.2, 0.065, 0.012);
    B.box('concrete', 0.16, dh + 0.28, 0.11, dx0 - 0.08, ybase + (dh + 0.28) * 0.5, 0.055, 0.01);
    B.box('concrete', 0.16, dh + 0.28, 0.11, dx1 + 0.08, ybase + (dh + 0.28) * 0.5, 0.055, 0.01);
    B.box('concrete', dw + 0.36, 0.11, 0.42, cx, ybase + 0.055, 0.14, 0.014);   // step
    // reveal jambs
    B.box('concrete_wall', 0.13, dh, 0.9, dx0 + 0.065, ybase + dh * 0.5, -0.45, 0.008).dark = 0.3;
    B.box('concrete_wall', 0.13, dh, 0.9, dx1 - 0.065, ybase + dh * 0.5, -0.45, 0.008).dark = 0.3;
    B.box('concrete_wall', dw, 0.14, 0.9, cx, ybase + dh - 0.07, -0.45, 0.008).dark = 0.45;
    if (rng.bool(0.62)) {
      var ajar = rng.range(0.15, 1.4);
      B.pushXYZ(dx0 + 0.05, ybase + dh * 0.5, -(S.reveal || REVEAL) + 0.02, 0, -ajar, 0);
      B.box('wood_plank', dw - 0.08, dh - 0.06, 0.05, (dw - 0.08) * 0.5, 0, 0, 0.008);
      for (var i = 0; i < 3; i++) {
        B.box('wood_plank', dw * 0.32, dh * 0.22, 0.018, (dw - 0.08) * 0.5,
          -dh * 0.28 + i * dh * 0.28, 0.032, 0.006);
      }
      B.cyl('rusted_metal', 0.022, 0.022, 0.09, dw - 0.2, 0, 0.06, Math.PI / 2, 0, 0, 6);
      B.pop();
    }
    B.dark = 0.8;
    B.box('backdrop', dw + 0.1, dh, 0.12, cx, ybase + dh * 0.5, -0.95, 0.01);
    B.dark = 0;
  }

  // ---- corrugated awning ----------------------------------------------------
  function awning(B, cx, y, w, rng) {
    var d = rng.range(1.15, 1.65), drop = rng.range(0.22, 0.4);
    var ang = Math.atan2(drop, d), i;
    B.pushXYZ(cx, y, 0, -ang, 0, 0);
    B.box('corrugated_metal', w, 0.03, d, 0, 0, d * 0.5, 0.006).dark = rng.range(0, 0.14);
    var ribs = Math.max(4, Math.round(w / 0.34));
    for (i = 0; i < ribs; i++) {
      B.box('corrugated_metal', 0.035, 0.045, d - 0.03, -w * 0.5 + (i + 0.5) * (w / ribs), 0.036, d * 0.5, 0.005);
    }
    B.box('corrugated_metal', w + 0.03, 0.09, 0.05, 0, 0.03, d, 0.008);
    B.pop();
    var nb = Math.max(2, Math.round(w / 1.8));
    for (i = 0; i < nb; i++) {
      var bx = cx - w * 0.5 + (i + 0.5) * (w / nb);
      B.boxR('rusted_metal', 0.035, Math.sqrt(d * d + 0.81), 0.035, bx, y - 0.45, d * 0.5,
        Math.atan2(d, 0.9), 0, 0, 0.006);
      B.box('rusted_metal', 0.05, 0.16, 0.08, bx, y - 0.9, 0.04, 0.008);
    }
  }

  // ---- striped cloth canopy (the market note in the art direction) ----------
  function canopyGeo(w, d, sag, nu, nv, u0, u1) {
    u0 = (u0 === undefined) ? 0 : u0;
    u1 = (u1 === undefined) ? 1 : u1;
    var pos = [], nor = [], idx = [], u, v;
    for (v = 0; v <= nv; v++) {
      for (u = 0; u <= nu; u++) {
        var fu = M.lerp(u0, u1, u / nu), fv = v / nv;
        pos.push((fu - 0.5) * w,
          -sag * Math.sin(Math.PI * fu) * (0.25 + 0.75 * fv) - fv * fv * 0.28,
          fv * d);
        nor.push(0, 1, 0);
      }
    }
    for (v = 0; v < nv; v++) {
      for (u = 0; u < nu; u++) {
        var a = v * (nu + 1) + u, b = a + 1, c = a + nu + 1;
        idx.push(a, c, b, b, c, c + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  var CANOPY_COLS = [
    [0xb8503a, 0xd9c3a0], [0xc08a3a, 0xd9c3a0],
    [0x3f7f82, 0xcdc0ad], [0x8f4a4a, 0xc9b08a]
  ];
  // Stripes are built as separate cloth panels rather than painted per-vertex:
  // a vertex-colour stripe on a coarse mesh just aliases into mush, whereas
  // alternating panels give the crisp faded awning stripe the market needs.
  function canopy(B, cx, y, w, rng) {
    var d = rng.range(1.4, 1.95), sag = rng.range(0.14, 0.26);
    var pair = rng.pick(CANOPY_COLS);
    var tilt = -rng.range(0.05, 0.14);
    var ca = tint(pair[0], 0.62), cb = tint(pair[1], 0.5);
    var n = Math.max(5, Math.round(w / 0.44)) | 1;   // odd count: ends match
    var i;
    for (i = 0; i < n; i++) {
      var e = B.add('fabric', canopyGeo(w, d, sag, 2, 4, i / n, (i + 1) / n),
        makeM(cx, y, 0, tilt, 0, 0));
      e.tint = (i & 1) ? cb : ca;
      e.dark = rng.range(0, 0.1);
    }
    // scalloped valance on the free edge, same rhythm
    for (i = 0; i < n; i++) {
      var vx = cx - w * 0.5 + (i + 0.5) * (w / n);
      B.boxR('fabric', w / n - 0.01, 0.2, 0.01, vx,
        y - sag * Math.sin(Math.PI * (i + 0.5) / n) - 0.36 + tilt * d, d * 0.98,
        0.14, 0, 0, 0.004).tint = (i & 1) ? cb : ca;
    }
    for (i = -1; i <= 1; i += 2) {
      B.cyl('rusted_metal', 0.022, 0.026, y - 0.05, cx + i * (w * 0.5 - 0.06),
        (y - 0.05) * 0.5, d - 0.06, 0, 0, 0, 6);
    }
    B.cyl('rusted_metal', 0.016, 0.016, w, cx, y - sag * 0.4, d - 0.06, 0, 0, Math.PI / 2, 6);
  }

  // ---- shopfront ------------------------------------------------------------
  function shopFront(B, x0, x1, ybase, h, rng, S) {
    var w = x1 - x0, cx = (x0 + x1) * 0.5, i;
    var pier = M.clamp(w * 0.14, 0.34, 0.62);
    var opW = w - pier * 2;
    var opH = Math.min(h - 0.95, 2.85);
    wallRect(B, x0, ybase, x0 + pier, ybase + h, rng, S);
    wallRect(B, x1 - pier, ybase, x1, ybase + h, rng, S);
    wallRect(B, x0 + pier, ybase + opH + 0.3, x1 - pier, ybase + h, rng, S);

    // Dark recess 1 m back - an opening that shows sky destroys the illusion.
    // Skipped where the shop is genuinely enterable; there the real room is
    // behind and a fake backdrop would float in the middle of it.
    if (!S.openGround) {
      // Dark, but never crushed: a pure black opening is on the instant-fail
      // list, and a shop interior always catches some bounce off its own floor.
      B.dark = 0.62;
      B.box('backdrop', opW + 0.2, opH, 0.16, cx, ybase + opH * 0.5, -1.05, 0.01);
      B.dark = 0;
      B.box('concrete_wall', 0.2, opH, 1.0, x0 + pier + 0.1, ybase + opH * 0.5, -0.5, 0.01).dark = 0.3;
      B.box('concrete_wall', 0.2, opH, 1.0, x1 - pier - 0.1, ybase + opH * 0.5, -0.5, 0.01).dark = 0.3;
      B.box('concrete_wall', opW, 0.2, 1.0, cx, ybase + opH - 0.1, -0.5, 0.01).dark = 0.42;
      // a lit floor plane inside the recess, so it reads as a room not a void
      B.box('concrete', opW, 0.1, 1.0, cx, ybase + 0.05, -0.55, 0.01).dark = 0.26;
      // back-of-shop shelving, barely legible - enough to imply depth
      for (var sv = 0; sv < 3; sv++) {
        B.box('wood_plank', opW * 0.8, 0.05, 0.3, cx, ybase + 0.7 + sv * 0.72, -0.92, 0.008).dark = 0.45;
      }
    }

    B.box('concrete', opW, 0.36, 0.34, cx, ybase + 0.18, -0.28, 0.012);
    B.box('tile', opW - 0.04, 0.3, 0.05, cx, ybase + 0.19, -0.09, 0.006);
    B.box('concrete', opW + pier * 1.4, 0.3, 0.44, cx, ybase + opH + 0.15, 0.06, 0.014);
    B.box('concrete', opW + pier * 1.4 + 0.1, 0.07, 0.5, cx, ybase + opH + 0.33, 0.08, 0.01);

    if (rng.bool(S.openGround ? 0.55 : 0.72)) {
      // On the enterable shop the shutter is forced high, so the room and the
      // street stay visually connected from both sides.
      var cover = S.openGround ? rng.range(0.1, 0.3) : rng.range(0.18, 0.96);
      var sh = (opH - 0.36) * cover;
      B.boxR('corrugated_metal', opW - 0.06, sh, 0.05, cx, ybase + opH - sh * 0.5, -0.14,
        rng.range(-0.02, 0.02), 0, 0, 0.008).dark = rng.range(0.05, 0.3);
      B.box('painted_metal', opW + 0.1, 0.26, 0.3, cx, ybase + opH - 0.13, -0.16, 0.01);
      for (i = -1; i <= 1; i += 2) {
        B.box('rusted_metal', 0.06, opH - 0.3, 0.09, cx + i * (opW * 0.5 - 0.02),
          ybase + opH * 0.5 - 0.1, -0.14, 0.008);
      }
      if (cover < 0.75 && rng.bool(0.6)) {
        // a peeled-back corner where somebody levered it open
        B.boxR('corrugated_metal', rng.range(0.4, 0.8), rng.range(0.3, 0.55), 0.04,
          cx + rng.range(-opW * 0.3, opW * 0.3), ybase + opH - sh - 0.1, -0.11,
          rng.range(0.3, 0.8), rng.range(-0.3, 0.3), rng.range(-0.4, 0.4), 0.006).dark = 0.25;
      }
    } else {
      B.box('wood_plank', 0.07, opH - 0.4, 0.07, cx, ybase + 0.36 + (opH - 0.4) * 0.5, -0.2, 0.008);
      if (rng.bool(0.4)) {
        var gp = B.box('glass', opW - 0.16, opH - 0.5, 0.012, cx, ybase + 0.4 + (opH - 0.5) * 0.5, -0.21, 0.004);
        gp.paint = 'flat'; gp.dark = 0.15;
      } else {
        brokenGlass(B, cx, ybase + 0.4 + (opH - 0.5) * 0.5, opW - 0.2, opH - 0.55, rng);
      }
    }

    var ay = ybase + opH + 0.55;
    if (rng.bool(0.45)) canopy(B, cx, ay, opW + pier * 0.8, rng);
    else awning(B, cx, ay, opW + pier * 0.8, rng);

    if (rng.bool(0.7)) {
      var sgn = B.box('painted_metal', opW * rng.range(0.55, 0.95), rng.range(0.34, 0.5), 0.05,
        cx + rng.range(-0.1, 0.1), ybase + opH + 0.55, 0.12, 0.008);
      sgn.paint = 'flat';
      sgn.tint = tint(rng.pick([0x2f4f6b, 0x6b3a2a, 0x2c5a3f, 0x7a6320]), 0.9);
    }
  }

  // ---- horizontal + vertical trim ------------------------------------------
  function stringCourse(B, W, y) {
    B.box('concrete', W + 0.06, 0.11, 0.14, W * 0.5, y, 0.05, 0.012);
    B.box('concrete', W + 0.06, 0.035, 0.19, W * 0.5, y - 0.07, 0.07, 0.008);
  }
  function pilaster(B, x, y0, y1, w) {
    var h = y1 - y0;
    B.box('plaster', w, h, 0.13, x, y0 + h * 0.5, 0.06, 0.012);
    B.box('concrete', w + 0.09, 0.14, 0.19, x, y1 - 0.07, 0.09, 0.012);
    B.box('concrete', w + 0.11, 0.20, 0.21, x, y0 + 0.10, 0.10, 0.012);
  }

  // ---- cornice + parapet ----------------------------------------------------
  function crown(B, W, y, rng, S) {
    var i;
    // three stepped bands - a single band never sells as a cornice
    B.box('concrete', W + 0.22, 0.085, 0.30, W * 0.5, y + 0.042, 0.09, 0.012);
    B.box('concrete', W + 0.34, 0.135, 0.42, W * 0.5, y + 0.152, 0.14, 0.014);
    B.box('concrete', W + 0.26, 0.075, 0.32, W * 0.5, y + 0.257, 0.09, 0.01);
    var n = Math.floor(W / 0.32);
    for (i = 0; i < n; i++) {
      if (rng.bool(0.06)) continue;                       // a few dentils gone
      B.box('concrete', 0.11, 0.10, 0.15, (i + 0.5) * (W / n), y - 0.045, 0.07, 0.008);
    }
    var py = y + 0.295, ph = S.parapetH;
    // render stops short of the coping so the sky edge is stone, not stipple
    var pp = Math.max(0.2, ph - 0.10);
    // An optional BREACH through the parapet (S.parapetGap = {x0,x1}). Only the
    // accessible roof asks for one: a 1 m unbroken coping running dead level
    // across the bottom of the rooftop framing is a wall between the camera and
    // the one thing worth being up there for. Two courses gone and the coping
    // above them in the street turns that band into a leading line instead.
    // The parapet COLLIDER is untouched, so nothing can walk or fall through it.
    var gap = S.parapetGap;
    var g0 = gap ? M.clamp(gap.x0, 0, W) : 0;
    var g1 = gap ? M.clamp(gap.x1, 0, W) : 0;
    if (!gap || g1 - g0 < 0.05) {
      B.box('plaster', W, pp, 0.25, W * 0.5, py + pp * 0.5, -0.115, 0.012);
      B.box('concrete', W, ph - pp, 0.28, W * 0.5, py + (pp + ph) * 0.5, -0.115, 0.01);
    } else {
      var runs = [[0, g0], [g1, W]];
      for (i = 0; i < 2; i++) {
        var r0 = runs[i][0], r1 = runs[i][1];
        if (r1 - r0 < 0.04) continue;
        B.box('plaster', r1 - r0, pp, 0.25, (r0 + r1) * 0.5, py + pp * 0.5, -0.115, 0.012);
        B.box('concrete', r1 - r0, ph - pp, 0.28, (r0 + r1) * 0.5,
          py + (pp + ph) * 0.5, -0.115, 0.01);
      }
      // the two surviving courses of blockwork inside the breach, with a
      // ragged upper edge rather than a sawn one
      var gn = Math.max(2, Math.round((g1 - g0) / 0.26));
      for (i = 0; i < gn; i++) {
        var gt = (i + 0.5) / gn;                          // 0..1 across the gap
        var edge = Math.min(gt, 1 - gt) * 2;              // 0 at the jaws, 1 mid
        var gh = M.clamp(pp * (0.86 - Math.pow(edge, 0.7) * 0.66) *
          rng.range(0.85, 1.15), 0.10, pp);
        B.boxR(rng.bool(0.4) ? 'brick' : 'plaster', (g1 - g0) / gn + 0.006, gh, 0.25,
          g0 + gt * (g1 - g0), py + gh * 0.5, -0.115,
          0, rng.range(-0.05, 0.05), rng.range(-0.06, 0.06), 0.01);
      }
    }
    var cn = Math.max(3, Math.round(W / 0.72));
    for (i = 0; i < cn; i++) {
      if (rng.bool(0.08)) continue;                       // missing coping stones
      var cxs = (i + 0.5) * (W / cn);
      if (gap && cxs > g0 - 0.22 && cxs < g1 + 0.22) continue;
      var j = rng.range(-0.012, 0.012);
      B.boxR('concrete', W / cn - 0.02, 0.09, 0.34, cxs,
        py + ph + 0.045 + Math.abs(j), -0.115, 0, j * 1.6, j * 2.4, 0.01);
    }
  }

  // ---- semicircular arched opening -----------------------------------------
  // Used at the street terminators; a flat rectangle at the vanishing point
  // would waste the strongest compositional slot in the level.
  function archOpening(B, cx, ybase, w, springH, thickness, S) {
    var r = w * 0.5, top = ybase + springH + r, i;
    for (i = 0; i < 26; i++) {
      var fx = -r + (i + 0.5) * (w / 26);
      var yb = ybase + springH + Math.sqrt(Math.max(0, r * r - fx * fx));
      if (top - yb < 0.01) continue;
      B.box(S.coreKey, w / 26 + 0.004, top - yb, thickness, cx + fx, (yb + top) * 0.5,
        -thickness * 0.5, 0.006);
    }
    for (i = 0; i < 19; i++) {
      var a = Math.PI * (i + 0.5) / 19;
      B.boxR('concrete', 0.24, Math.PI * r / 19 * 1.3, 0.24,
        cx - Math.cos(a) * (r + 0.14), ybase + springH + Math.sin(a) * (r + 0.14), 0.04,
        0, 0, a - Math.PI / 2, 0.012);
    }
    B.box('concrete', 0.30, 0.42, 0.30, cx, ybase + springH + r + 0.16, 0.06, 0.014);
    for (i = -1; i <= 1; i += 2) {
      B.box('concrete', 0.26, 0.18, 0.26, cx + i * (r + 0.08), ybase + springH, 0.05, 0.012);
    }
  }

  // ---- external stair flight ------------------------------------------------
  // Treads are separate blocks with a nosing so each catches its own highlight.
  function stairFlight(B, x0, y0, dir, steps, rise, run, width) {
    for (var i = 0; i < steps; i++) {
      var sx = x0 + dir * (i + 0.5) * run;
      var sy = y0 + (i + 1) * rise;
      B.box('concrete', run, 0.11, width, sx, sy - 0.055, 0, 0.012);
      B.box('concrete', run + 0.045, 0.035, width, sx - dir * 0.02, sy - 0.11, 0, 0.008);
      B.box('concrete', 0.09, rise, width - 0.02, sx - dir * (run * 0.5 - 0.045),
        sy - rise * 0.5 - 0.05, 0, 0.008);
    }
    var len = steps * run, h = steps * rise;
    B.boxR('concrete', Math.sqrt(len * len + h * h), 0.34, 0.16,
      x0 + dir * len * 0.5, y0 + h * 0.5 - 0.24, -width * 0.5 + 0.08,
      0, 0, dir * Math.atan2(h, len), 0.012);
    return y0 + h;
  }

  // ---- exposed rebar --------------------------------------------------------
  // Bent bars sagging out of a shell hole. The single strongest "this was hit
  // by something" read, and almost free in triangles.
  function rebar(B, x, y, z, len, dirX, dirY, dirZ, rng) {
    var pts = [];
    var px = x, py = y, pz = z;
    var dx = dirX, dy = dirY, dz = dirZ;
    for (var i = 0; i <= 4; i++) {
      pts.push(new THREE.Vector3(px, py, pz));
      px += dx * len * 0.25; py += dy * len * 0.25; pz += dz * len * 0.25;
      dy -= 0.22 + rng.range(0, 0.2);                     // gravity droop
      dx += rng.range(-0.14, 0.14); dz += rng.range(-0.1, 0.1);
    }
    var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, 0.0085, 4, false);
    B.add('rusted_metal', g, null);
  }

  // ---- a sagging cable run --------------------------------------------------
  // Catenaries are the cheapest thing in the kit that reads as "people live
  // here": they are the only long thin diagonals on a roofscape otherwise made
  // entirely of boxes and verticals, and they cross the frame without occluding
  // anything behind them. Authored in the caller's local frame.
  function wire(B, key, ax, ay, az, bx, by, bz, sag, rad) {
    var pts = [], n = 6, i;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      pts.push(new THREE.Vector3(
        ax + (bx - ax) * t,
        ay + (by - ay) * t - Math.sin(Math.PI * t) * sag,
        az + (bz - az) * t));
    }
    var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 9, rad || 0.014, 4, false);
    var e = B.add(key || 'rubber', g, null);
    e.paint = 'flat';
    return e;
  }

  // =========================================================== BUILDING SHELL =
  // Local frame as above. `S` carries everything the kit needs to know about
  // this particular building: its damage blobs, its trim keys, its rhythm.

  // rect A minus rect B, as up to four axis-aligned pieces (x0,x1,z0,z1)
  function subtractRect(ax0, ax1, az0, az1, bx0, bx1, bz0, bz1) {
    var out = [];
    bx0 = Math.max(ax0, bx0); bx1 = Math.min(ax1, bx1);
    bz0 = Math.max(az0, bz0); bz1 = Math.min(az1, bz1);
    if (bx0 >= bx1 || bz0 >= bz1) return [[ax0, ax1, az0, az1]];
    if (bx0 - ax0 > 0.02) out.push([ax0, bx0, az0, az1]);
    if (ax1 - bx1 > 0.02) out.push([bx1, ax1, az0, az1]);
    if (bz0 - az0 > 0.02) out.push([bx0, bx1, az0, bz0]);
    if (az1 - bz1 > 0.02) out.push([bx0, bx1, bz1, az1]);
    return out;
  }

  // ---- a wall in the XY plane with real openings cut through it -------------
  // Interior walls were single boxes with dark quads pasted onto their faces, so
  // every "shell hole" and every "niche" in the shop rendered as a flat black
  // rectangle stuck on a flat beige plane - depth-free at both ends. This splits
  // the panel into vertical strips around each opening, so the wall's own
  // thickness forms the reveal and the recess has a back you can see into.
  // `cuts`: [{x0,x1,y0,y1,back,backKey,dark,side}] - side is +1 when the recess
  // opens toward -z (the room is at lower z) and -1 the other way. Cuts must not
  // overlap in x.
  function pierceWallZ(B, key, xa, xb, ya, yb, zc, t, cuts) {
    var xs = [xa, xb], i, k;
    for (i = 0; i < cuts.length; i++) {
      xs.push(M.clamp(cuts[i].x0, xa, xb));
      xs.push(M.clamp(cuts[i].x1, xa, xb));
    }
    xs.sort(function (p, q) { return p - q; });
    for (i = 0; i < xs.length - 1; i++) {
      var s0 = xs[i], s1 = xs[i + 1];
      if (s1 - s0 < 0.02) continue;
      var mid = (s0 + s1) * 0.5, cut = null;
      for (k = 0; k < cuts.length; k++) {
        if (mid > cuts[k].x0 && mid < cuts[k].x1) { cut = cuts[k]; break; }
      }
      if (!cut) {
        B.box(key, s1 - s0, yb - ya, t, mid, (ya + yb) * 0.5, zc, 0.014);
        continue;
      }
      if (cut.y0 - ya > 0.02) {
        B.box(key, s1 - s0, cut.y0 - ya, t, mid, (ya + cut.y0) * 0.5, zc, 0.014);
      }
      if (yb - cut.y1 > 0.02) {
        B.box(key, s1 - s0, yb - cut.y1, t, mid, (cut.y1 + yb) * 0.5, zc, 0.014);
      }
      if (cut.back > 0.005) {
        var bk = B.box(cut.backKey || key, s1 - s0, cut.y1 - cut.y0, cut.back,
          mid, (cut.y0 + cut.y1) * 0.5,
          zc + (t - cut.back) * 0.5 * (cut.side || 1), 0.01);
        if (cut.dark) bk.dark = cut.dark;
      }
    }
  }

  // `out` pushes the whole wall assembly along its own outward normal.
  //
  // Flank and rear elevations are laid ON the face of the building's solid
  // mass, and the kit authors its plaster skin from local z = 0 INWARD. That
  // put the finished plaster face exactly coplanar with the mass box, so every
  // back and gable in the level was z-fighting with the block behind it - at
  // the grazing angles those walls are actually seen from (the alley, the
  // roofscape) that resolves as alternating bands of plaster and bare core,
  // which is precisely the "repeating patchwork of rectangles" read. Standing
  // the assembly 6 cm proud puts the whole 3.5 cm skin and its spall in front
  // of the mass with clear air between them.
  var WALL_OUT = 0.06;
  function facadeOrient(facing, ox, oy, oz, out) {
    var ry = facing === 'px' ? Math.PI / 2 : facing === 'mx' ? -Math.PI / 2
      : facing === 'pz' ? 0 : Math.PI;
    if (out) {
      if (facing === 'px') ox += out;
      else if (facing === 'mx') ox -= out;
      else if (facing === 'pz') oz += out;
      else oz -= out;
    }
    return makeM(ox, oy, oz, 0, ry, 0);
  }

  // Height of the intact wall at local x, or -1 where the building has been
  // taken off by a shell. A diagonal cut gives a far better silhouette than a
  // horizontal one - it reads as failure, not as an unfinished model.
  function cutAt(S, x) {
    if (!S.collapse) return 1e9;
    var c = S.collapse;
    return c.y0 + (x - c.x0) * c.slope;
  }

  // A ragged masonry edge: stacked blocks of falling height with the odd brick
  // left proud, plus rebar where a floor slab was torn through.
  function jaggedTop(B, x0, x1, y, rng, S, withRebar) {
    var n = Math.max(2, Math.round((x1 - x0) / 0.3));
    for (var i = 0; i < n; i++) {
      var bx = x0 + (i + 0.5) * ((x1 - x0) / n);
      var bh = Math.abs(rng.gaussian(0, 1)) * 0.26 + 0.04;
      var key = rng.bool(0.35) ? 'brick' : S.coreKey;
      B.boxR(key, (x1 - x0) / n + 0.01, bh, WALL_T * rng.range(0.5, 1.0),
        bx, y + bh * 0.5 - 0.02, -WALL_T * rng.range(0.3, 0.55),
        0, rng.range(-0.06, 0.06), rng.range(-0.09, 0.09), 0.01);
    }
    if (withRebar) {
      for (var r = 0; r < 4; r++) {
        rebar(B, x0 + rng.range(0.1, 0.9) * (x1 - x0), y + rng.range(0, 0.1),
          -WALL_T * 0.5, rng.range(0.5, 1.0),
          rng.range(-0.3, 0.3), rng.range(0.5, 1), rng.range(0.3, 1.0), rng);
      }
    }
  }

  function buildFloorBand(B, S, rng, f, yb, h, W) {
    var nb = S.bays, i;
    var isGround = (f === 0);
    // Core exposure is per floor band, not per building: a single coin flip for
    // a whole facade meant every spall on it revealed the same colour, which is
    // the opposite of how a building that has been patched for decades reads.
    if (S.coreBands) S.coreKey = S.coreBands[f % S.coreBands.length];
    // Deliberately uneven bay widths: an exactly regular rhythm is the single
    // biggest "kit-bashed" tell on a procedural facade.
    var edges = [0];
    var acc = 0, weights = [];
    for (i = 0; i < nb; i++) { var wgt = 1 + rng.range(-0.16, 0.16); weights.push(wgt); acc += wgt; }
    for (i = 0; i < nb; i++) edges.push(edges[i] + W * weights[i] / acc);
    edges[nb] = W;

    for (i = 0; i < nb; i++) {
      var x0 = edges[i], x1 = edges[i + 1];
      var yc = Math.min(cutAt(S, x0), cutAt(S, x1));
      if (yc <= yb + 0.15) {
        if (yc > yb - 2.2) jaggedTop(B, x0, x1, Math.max(yb, yc), rng, S, true);
        continue;                                     // this bay is gone
      }
      if (yc < yb + h) {
        wallRect(B, x0, yb, x1, yc, rng, S);
        jaggedTop(B, x0, x1, yc, rng, S, true);
        continue;
      }
      if (isGround) {
        if (S.ground === 'shop') shopFront(B, x0, x1, yb, h, rng, S);
        else if (S.ground === 'door' && i === S.doorBay) doorBay(B, x0, x1, yb, h, rng, S);
        else windowBay(B, x0, x1, yb, h, rng, S, { tall: true, kind: S.headKind });
      } else {
        var bal = S.balconies && f === S.balconyFloor && rng.bool(0.62);
        // typology, not just parametrics: a balcony gets a full-height door with
        // no apron under it, the top floor of some blocks is a service/stair
        // band with loopholes, everything else takes the block's head type.
        var kind = bal ? 'door' : S.headKind;
        if (!bal && S.ventTop && f === S.floors.length - 1 && rng.bool(0.55)) kind = 'vent';
        windowBay(B, x0, x1, yb, h, rng, S, { balcony: bal, kind: kind });
      }
    }
    if (!isGround && cutAt(S, W * 0.5) > yb) stringCourse(B, W, yb - 0.02);
  }

  function buildFacade(B, S, rng) {
    var W = S.width, floors = S.floors, i;
    var totalH = 0;
    for (i = 0; i < floors.length; i++) totalH += floors[i];
    S.totalH = totalH;

    // Backdrop plane: without it every window and door shows raw sky. On a
    // building with a real interior it must start above that interior,
    // otherwise it walls the room off 1.3 m behind the shopfront.
    var bdY0 = S.hollowGround ? floors[0] : -0.7;
    B.dark = 0.66;
    B.box('backdrop', W + 0.3, totalH + 1.3 - bdY0, 0.25, W * 0.5,
      bdY0 + (totalH + 1.3 - bdY0) * 0.5, -1.28, 0.01);
    B.dark = 0;

    var y = 0;
    for (i = 0; i < floors.length; i++) {
      buildFloorBand(B, S, rng, i, y, floors[i], W);
      y += floors[i];
    }

    // pilasters run the full height on some buildings, breaking the flatness
    if (S.pilasters) {
      var np = S.bays;
      for (i = 1; i < np; i++) {
        var px = W * i / np;
        var yc = cutAt(S, px);
        if (yc < 1.0) continue;
        pilaster(B, px, floors[0] * 0.0, Math.min(totalH, yc), M.clamp(W / np * 0.14, 0.22, 0.4));
      }
    }

    // crown only where the building still has a top
    if (!S.collapse) {
      crown(B, W, totalH, rng, S);
    } else {
      var xEnd = M.clamp((totalH - S.collapse.y0) / S.collapse.slope + S.collapse.x0, 0, W);
      if (xEnd > 0.6) {
        B.pushXYZ(0, 0, 0);
        crown(B, xEnd, totalH, rng, S);
        B.pop();
      }
    }
  }

  // ---- blank flank wall (only built where a gap exposes it) -----------------
  function flankWall(B, w, h, rng, S) {
    var nWin = Math.max(1, Math.floor(h / 3.4));
    var i;
    // Openings on a back elevation are cut where the rooms are, not on a grid.
    // Equal rows of equal openings on a blank wall is the single loudest source
    // of measured repetition after the spall grid itself.
    var xs = [], ws = [], hs = [], ys = [];
    var yCur = rng.range(1.1, 1.9);
    for (i = 0; i < nWin; i++) {
      xs.push(rng.range(0.14, 0.86) * w);
      ws.push(rng.range(0.42, 1.05));
      hs.push(rng.range(0.5, 1.25));
      ys.push(yCur);
      yCur += hs[i] + rng.range(1.3, 2.6);
      if (yCur > h - 0.9) { nWin = i + 1; break; }
    }
    var y = 0, frev = -(S.reveal || REVEAL);
    for (i = 0; i < nWin; i++) {
      var wy = ys[i], ww = ws[i], wh = hs[i];
      wallRect(B, 0, y, w, wy, rng, S);
      wallRect(B, 0, wy, xs[i] - ww * 0.5, wy + wh, rng, S);
      wallRect(B, xs[i] + ww * 0.5, wy, w, wy + wh, rng, S);
      B.box('concrete', ww + 0.24, 0.07, 0.18, xs[i], wy - 0.035, 0.045, 0.01);
      B.box('concrete', ww + 0.26, 0.1, 0.09, xs[i], wy + wh + 0.05, 0.025, 0.01);
      // a real reveal + a dark box behind, so the opening is not a flat hole
      // straight onto the untextured mass
      B.box('concrete_wall', 0.1, wh, 0.44, xs[i] - ww * 0.5 + 0.05, wy + wh * 0.5, -0.22, 0.008).dark = 0.34;
      B.box('concrete_wall', 0.1, wh, 0.44, xs[i] + ww * 0.5 - 0.05, wy + wh * 0.5, -0.22, 0.008).dark = 0.34;
      B.dark = 0.8;
      B.box('backdrop', ww, wh, 0.12, xs[i], wy + wh * 0.5, -0.62, 0.01);
      B.dark = 0;
      if (rng.bool(0.45)) brokenGlass(B, xs[i], wy + wh * 0.5, ww, wh, rng, frev - 0.012);
      else if (rng.bool(0.6)) {
        B.box('glass', ww - 0.06, wh - 0.06, 0.01, xs[i], wy + wh * 0.5, frev, 0.004).paint = 'flat';
      } else {
        // boarded up with whatever was to hand
        for (var bp = 0; bp < 3; bp++) {
          B.boxR('wood_plank', ww + rng.range(0.02, 0.2), wh / 3 - 0.02, 0.026,
            xs[i] + rng.range(-0.05, 0.05), wy + wh * (bp + 0.5) / 3, -0.05,
            0, 0, rng.range(-0.08, 0.08), 0.005);
        }
      }
      y = wy + wh;
    }
    wallRect(B, 0, y, w, h, rng, S);

    // soil stack + hopper: vertical pipes are what make a blank flank believable
    var pn = rng.int(1, 2);
    for (i = 0; i < pn; i++) {
      var px = rng.range(0.1, 0.9) * w;
      B.cyl('rusted_metal', 0.055, 0.055, h - 0.3, px, (h - 0.3) * 0.5, 0.09, 0, 0, 0, 8);
      for (var b = 0; b < Math.floor(h / 1.6); b++) {
        B.box('rusted_metal', 0.16, 0.05, 0.09, px, 0.6 + b * 1.6, 0.05, 0.008);
      }
      B.cyl('rusted_metal', 0.11, 0.075, 0.26, px, h - 0.25, 0.09, 0, 0, 0, 8);
      B.boxR('rusted_metal', 0.09, 0.34, 0.09, px, 0.2, 0.16, 0.5, 0, 0, 0.008);
      S.streaks.push({ p: B.worldPoint(px, h * 0.5, 0.1), r: 1.2 });
    }
    // Air-conditioner brackets. A blank flank in a market district is never
    // blank - it is where every service that would not fit inside ended up, and
    // the macro shadows they throw are what stop the wall reading as a repeating
    // texture no matter how good the plaster is.
    var na = rng.int(1, 3);
    for (i = 0; i < na; i++) {
      var ax = rng.range(0.12, 0.88) * w, ay = rng.range(2.2, Math.max(2.5, h - 1.2));
      B.box('rusted_metal', 0.62, 0.045, 0.42, ax, ay, 0.21, 0.008);
      B.boxR('rusted_metal', 0.03, 0.5, 0.03, ax - 0.24, ay - 0.2, 0.2, -0.7, 0, 0, 0.006);
      B.boxR('rusted_metal', 0.03, 0.5, 0.03, ax + 0.24, ay - 0.2, 0.2, -0.7, 0, 0, 0.006);
      if (rng.bool(0.7)) {
        B.box('painted_metal', 0.56, 0.4, 0.36, ax, ay + 0.22, 0.2, 0.012)
          .tint = tint(0xb9b6ae, 0.7);
        B.cyl('rubber', 0.022, 0.022, rng.range(0.5, 1.1), ax + 0.2,
          ay - rng.range(0.3, 0.6), 0.06, 0, 0, 0, 5).paint = 'flat';
      }
      S.streaks.push({ p: B.worldPoint(ax, ay - 0.3, 0.1), r: 1.0 });
    }
    // a conduit run and a couple of random brackets: verticals and horizontals
    // at different scales are the cheapest possible break-up
    if (rng.bool(0.75)) {
      var cy2 = rng.range(2.0, Math.max(2.4, h - 2.0));
      var cx2 = rng.range(0.05, 0.35) * w, cw2 = rng.range(0.35, 0.85) * w;
      B.box('rusted_metal', cw2, 0.05, 0.05, cx2 + cw2 * 0.5, cy2, 0.07, 0.008);
      for (i = 0; i < Math.max(2, Math.round(cw2 / 1.4)); i++) {
        B.box('rusted_metal', 0.05, 0.14, 0.09, cx2 + (i + 0.5) * cw2 / Math.max(2, Math.round(cw2 / 1.4)),
          cy2 - 0.09, 0.045, 0.006);
      }
      B.boxR('rusted_metal', 0.05, rng.range(0.8, 2.2), 0.05,
        cx2 + cw2, cy2 - rng.range(0.5, 1.3), 0.07, 0, 0, rng.range(-0.05, 0.05), 0.008);
    }
    // a shallow ledge / string course at an arbitrary height on some flanks
    if (rng.bool(0.45)) {
      var ly = rng.range(1.8, Math.max(2.2, h - 1.6));
      B.box('concrete', w, 0.13, 0.16, w * 0.5, ly, 0.06, 0.012);
      B.box('concrete', w, 0.04, 0.21, w * 0.5, ly - 0.085, 0.08, 0.008);
    }
  }

  // ---- roof furniture -------------------------------------------------------
  function roofDeck(B, W, depth, y, rng, S, opt) {
    opt = opt || {};
    var i;
    // The deck must run all the way forward to the street parapet that crown()
    // laid down, or the roof has an open slot along its front edge.
    var zF = -0.12, zB = -(depth + 1.3);
    var D = zF - zB, zC = (zF + zB) * 0.5;
    B.box('concrete', W, 0.22, D, W * 0.5, y - 0.11, zC, 0.014);
    // Bitumen felt, not gravel: a roof is a roof, and 'gravel' at its texel
    // density laid golf balls across the deck in every rooftop framing. Bays run
    // across the deck with a proud lap seam at every joint - that seam rhythm is
    // what reads as roofing rather than as paving.
    //
    // One 12 m x 1.35 m box per bay carries exactly four corners of vertex
    // colour, so the deck could hold no value variation at all and rendered as
    // one unbroken black plane - 51% of the rooftop framing measured flat.
    // Each bay is therefore laid in 3-5 SHEETS end to end (which is how felt is
    // actually laid: 1 m rolls, lapped, patched over the years in different
    // batches), every sheet carrying its own value. Still ~250 triangles.
    B.paint = 'felt';
    var bay = 1.35;
    var strips = Math.max(2, Math.round(D / bay));
    var sw = D / strips;
    for (i = 0; i < strips; i++) {
      var sz = zF - (i + 0.5) * sw;
      var nsh = 3 + (i % 3);
      var shw = W / nsh;
      for (var sh2 = 0; sh2 < nsh; sh2++) {
        // sheets overlap along the run, and bays overlap across it, so no gap
        // ever shows the deck slab through
        var fe = B.box('rooffelt', shw + 0.09, 0.03, sw + 0.03,
          (sh2 + 0.5) * shw, y + 0.015 + rng.range(-0.004, 0.006), sz, 0.005);
        fe.dark = rng.range(0, 0.30);
        fe.tint = FELT;
      }
      if (i > 0) {
        var se = B.box('rooffelt', W - 0.14, 0.018, 0.055, W * 0.5, y + 0.028,
          sz + sw * 0.5, 0.004);
        se.dark = rng.range(0.03, 0.20);
        se.tint = FELT;
      }
    }
    // Patch repairs: darker, glossier bitumen brushed over splits, laid at an
    // angle to the bay rhythm so the deck is never a set of parallel bands.
    for (i = 0; i < 5; i++) {
      var pw2 = rng.range(0.6, 1.9), pd2 = rng.range(0.5, 1.4);
      var pe2 = B.boxR('rooffelt', pw2, 0.014, pd2,
        rng.range(0.8, W - 0.8), y + 0.042, zF - rng.range(0.6, D - 0.6),
        0, rng.range(-0.7, 0.7), 0, 0.006);
      pe2.dark = rng.range(0.24, 0.52); pe2.tint = FELT;
    }
    // Wind-blown sand. Every flat roof in a dry city carries a drift, and it is
    // the single thing that stops a bitumen deck reading as a black hole under
    // a 14-degree sun. Irregular discs, never rectangles.
    for (i = 0; i < 9; i++) {
      var dr = rng.range(0.5, 1.7);
      var de = B.add('sand', blobDisc(rng, dr, rng.range(0.55, 1.1), 0.46),
        makeM(rng.range(0.5, W - 0.5), y + 0.05,
          zF - rng.range(0.4, D - 0.4), 0, rng.range(0, 6.283), 0));
      de.paint = 'ground';
      de.dark = rng.range(0, 0.22);
    }
    // and a heavier bank in the two back corners, where it always ends up
    for (i = 0; i < 2; i++) {
      B.boxR('sand', rng.range(1.4, 2.4), 0.09, rng.range(0.5, 0.9),
        i ? W - 1.4 : 1.4, y + 0.06, zB + rng.range(0.5, 0.9),
        0.2, rng.range(-0.3, 0.3), (i ? -1 : 1) * 0.18, 0.02)
        .dark = rng.range(0, 0.12);
    }
    // spalled chippings and blown-off render, scattered
    for (i = 0; i < 12; i++) {
      B.boxR(rng.bool(0.6) ? 'concrete' : 'brick',
        rng.range(0.06, 0.19), rng.range(0.02, 0.06), rng.range(0.06, 0.19),
        rng.range(0.4, W - 0.4), y + 0.06, zF - rng.range(0.4, D - 0.4),
        rng.range(-0.5, 0.5), rng.range(-1.5, 1.5), rng.range(-0.5, 0.5), 0.006)
        .paint = 'rubble';
    }
    B.paint = 'wall';
    // back + side parapets so the roofline is never a bare slab edge.
    // The plaster stops 0.1 m short of the top and a concrete band owns the
    // coping line, so the silhouette against the sky is a smooth stone edge
    // instead of a stippled render that aliases along the whole run.
    var ph = S.parapetH, pp = Math.max(0.2, ph - 0.10);
    B.box('plaster', W, pp, 0.24, W * 0.5, y + pp * 0.5, zB + 0.12, 0.012);
    B.box('plaster', 0.24, pp, D, 0.12, y + pp * 0.5, zC, 0.012);
    B.box('plaster', 0.24, pp, D, W - 0.12, y + pp * 0.5, zC, 0.012);
    B.box('concrete', W, ph - pp, 0.27, W * 0.5, y + (pp + ph) * 0.5, zB + 0.12, 0.01);
    B.box('concrete', 0.27, ph - pp, D, 0.12, y + (pp + ph) * 0.5, zC, 0.01);
    B.box('concrete', 0.27, ph - pp, D, W - 0.12, y + (pp + ph) * 0.5, zC, 0.01);
    B.box('concrete', W, 0.085, 0.34, W * 0.5, y + ph + 0.042, zB + 0.12, 0.01);
    B.box('concrete', 0.34, 0.085, D, 0.12, y + ph + 0.042, zC, 0.01);
    B.box('concrete', 0.34, 0.085, D, W - 0.12, y + ph + 0.042, zC, 0.01);
    // upstand fillet + a chipping border where the felt turns up the parapet
    B.boxR('rooffelt', W, 0.1, 0.13, W * 0.5, y + 0.06, zB + 0.27, 0.7, 0, 0, 0.01).tint = FELT;
    B.boxR('rooffelt', 0.13, 0.1, D, 0.27, y + 0.06, zC, 0, 0, -0.7, 0.01).tint = FELT;
    B.boxR('rooffelt', 0.13, 0.1, D, W - 0.27, y + 0.06, zC, 0, 0, 0.7, 0.01).tint = FELT;
    B.box('gravel', W - 0.5, 0.04, 0.4, W * 0.5, y + 0.05, zB + 0.55, 0.008).dark = rng.range(0, 0.14);
    B.box('gravel', 0.4, 0.04, D - 1.0, 0.55, y + 0.05, zC, 0.008).dark = rng.range(0, 0.14);
    B.box('gravel', 0.4, 0.04, D - 1.0, W - 0.55, y + 0.05, zC, 0.008).dark = rng.range(0, 0.14);
    // scuppers through the street parapet - and the rust stain they leave
    for (i = 0; i < 2; i++) {
      var sx = W * (0.28 + i * 0.44);
      B.box('rusted_metal', 0.14, 0.1, 0.5, sx, y + 0.12, -0.05, 0.006);
      S.streaks.push({ p: B.worldPoint(sx, y - 0.4, 0.08), r: 1.4 });
    }
    // vent stacks and chimney pots: a bare deck reads as an unfinished model,
    // and these are what give the roofscape its silhouette from above.
    var nv = rng.int(2, 4);
    for (i = 0; i < nv; i++) {
      var vx = rng.range(0.12, 0.88) * W, vz = zF - rng.range(1.2, D - 0.9);
      var vh = rng.range(0.55, 1.35);
      B.box('brick', rng.range(0.4, 0.7), vh, rng.range(0.4, 0.7), vx, y + vh * 0.5, vz, 0.014);
      B.box('concrete', 0.6, 0.09, 0.6, vx, y + vh + 0.045, vz, 0.01);
      if (rng.bool(0.6)) {
        B.cyl('rusted_metal', 0.09, 0.11, rng.range(0.35, 0.8), vx + rng.range(-0.14, 0.14),
          y + vh + 0.3, vz, 0, 0, 0, 8);
      }
    }
    // a low division wall between neighbouring roofs
    if (rng.bool(0.5)) {
      B.box('plaster', 0.2, rng.range(0.5, 0.9), D * rng.range(0.4, 0.85),
        W * rng.range(0.3, 0.7), y + 0.35, zC + rng.range(-1, 1), 0.012);
    }
    // A second-stage plant room set back on the rear of the roof. Roughly half
    // the blocks get one, so seen from above the roofscape is not twelve
    // identical extruded rectangles with identical parapets.
    if (opt.plant && D > 5) {
      var qw = W * rng.range(0.36, 0.62), qd = Math.min(D * 0.42, 4.4);
      var qx = M.clamp(W * rng.range(0.28, 0.72), qw * 0.5 + 0.4, W - qw * 0.5 - 0.4);
      var qz = zB + qd * 0.5 + 0.7, qh = rng.range(2.1, 3.1);
      B.box('plaster', qw, qh, qd, qx, y + qh * 0.5, qz, 0.016);
      B.box('concrete', qw + 0.3, 0.15, qd + 0.3, qx, y + qh + 0.075, qz, 0.012);
      B.box('concrete', qw + 0.16, 0.1, qd + 0.16, qx, y + qh * 0.62, qz, 0.01);
      B.dark = 0.7;
      for (i = -1; i <= 1; i += 2) {
        B.box('backdrop', 0.9, 0.75, 0.1, qx + i * qw * 0.22, y + qh * 0.62,
          qz + qd * 0.5 - 0.04, 0.01);
      }
      B.dark = 0;
      B.cyl('rusted_metal', 0.13, 0.15, rng.range(0.7, 1.4), qx + qw * 0.3,
        y + qh + rng.range(0.4, 0.8), qz, 0, 0, 0, 8);
    }
    if (opt.bulkhead) {
      // stair head house - the foreground mass for the rooftop framing
      var bx = opt.bulkhead.x, bz = opt.bulkhead.z, bw = 2.3, bd = 2.0, bh = 2.5;
      B.box('plaster', bw, bh, bd, bx, y + bh * 0.5, bz, 0.014);
      B.box('concrete', bw + 0.24, 0.16, bd + 0.24, bx, y + bh + 0.08, bz, 0.012);
      B.dark = 0.75;
      B.box('backdrop', 1.0, 2.05, 0.14, bx + bw * 0.5 - 0.02, y + 1.03, bz + bd * 0.28, 0.01);
      B.dark = 0;
      B.box('rusted_metal', 0.06, 2.05, 0.9, bx + bw * 0.5 + 0.02, y + 1.03, bz + bd * 0.28, 0.008);
    }
    if (opt.tank) {
      // water tank on a block plinth
      var tx = opt.tank.x, tz = opt.tank.z;
      for (i = -1; i <= 1; i += 2) {
        B.box('concrete', 0.4, 0.5, 1.5, tx + i * 0.75, y + 0.25, tz, 0.012);
      }
      B.cyl('rusted_metal', 0.62, 0.62, 1.25, tx, y + 1.12, tz, 0, 0, Math.PI / 2, 12);
      B.cyl('rusted_metal', 0.1, 0.1, 0.5, tx + 0.3, y + 1.85, tz, 0, 0, 0, 6);
      B.box('rusted_metal', 1.5, 0.05, 0.05, tx, y + 1.78, tz, 0.006);
    }
    if (opt.set) roofSet(B, W, D, zF, zB, y, rng, opt.noise, ph);
  }

  // ---- dressing for the ONE accessible roof ---------------------------------
  // The rooftop is one of five hero framings and it graded as the weakest. Not
  // because the roof was undressed - it already carried a condenser bank, an
  // aerial mast, a tank and a stair head - but because every one of them sat
  // 6-9 m BACK from the street parapet, and scenarios.js does not shoot from
  // where this file publishes: composeRooftop marches laterally from the anchor
  // until the collision data says the roof has run out, so the frame is always
  // taken at the parapet edge looking down the street. Solved against that
  // standpoint the condenser bank came out 71 degrees off axis and the tank 86 -
  // both behind the camera's left shoulder - and the shipped frame measured two
  // whole eighth-tiles at luminance 0.05 with a standard deviation of 0.04, i.e.
  // flat black deck where the content was supposed to be.
  //
  // Everything below is therefore laid out in the 2-11 m band along that SOLVED
  // sightline - roughly local x 3.5-12.5, local z -0.3 to -5.6 - and kept to the
  // LEFT of the street, so it fills the empty half of the frame without ever
  // occluding the canyon the framing exists for. The tall pieces are positioned
  // where they break the HORIZON rather than the deck: the mast at 4.3 m and the
  // stair head at 2.5 m both clear the eye line and silhouette against haze.
  function roofSet(B, W, D, zF, zB, y, rng, noise, parapetH) {
    var i, j, e, ce;
    var pH = parapetH || 0.95;

    // ---- the inside face of the street parapet ------------------------------
    // crown() builds the parapet from y+0.295 up, in a frame that leaves a
    // 0.3 m slot between the deck and the parapet base, and its inner face is
    // the one surface on this roof that NEVER sees the sun: the shipped frame
    // measured that band at luminance 0.05 with a standard deviation of 0.04
    // across two whole eighth-tiles - a black wedge straight through the middle
    // of the composition. The slot is closed with an upstand and the face gets
    // the same limewash the alley flanks got, for the same reason: it is what
    // people actually do to a surface that has no light of its own.
    B.box('concrete', W - 0.24, 0.46, 0.16, W * 0.5, y + 0.23, zF - 0.10, 0.01);
    e = B.box('plaster', W - 0.30, pH + 0.20, 0.035, W * 0.5, y + 0.30 + (pH + 0.20) * 0.5,
      zF - 0.155, 0.008);
    e.tint = LIMEWASH;
    // a painted skirting band along the foot of it, and the drip line under the
    // coping: two horizontals that stop the face reading as one panel
    B.box('painted_metal', W - 0.30, 0.20, 0.045, W * 0.5, y + 0.40, zF - 0.16, 0.008)
      .tint = tint(0x4d6b74, 0.55);
    B.box('concrete', W - 0.30, 0.055, 0.075, W * 0.5, y + 0.30 + pH + 0.14, zF - 0.175, 0.008);

    // ---- what came out of the parapet breach --------------------------------
    // crown() has taken two courses out at 0.275 of the width (S.parapetGap).
    // The masonry that used to be there is on the deck behind it, and two coping
    // stones went over into the street. Without the spill the breach reads as a
    // modelling mistake rather than as damage.
    var gx = W * 0.275 + 0.78;
    B.dark = 0.2;
    for (i = 0; i < 7; i++) {
      B.boxR('concrete', rng.range(0.30, 0.62), rng.range(0.07, 0.10), rng.range(0.26, 0.34),
        gx + rng.range(-1.0, 1.0), y + 0.07 + rng.range(0, 0.06), zF - rng.range(0.30, 1.05),
        rng.range(-0.22, 0.22), rng.range(-0.9, 0.9), rng.range(-0.18, 0.18), 0.01)
        .paint = 'rubble';
    }
    B.dark = 0;
    rubblePile(B, gx, y + 0.01, zF - 0.62, 1.15, 0.22, 30, rng);
    // reinforcement left standing out of the broken jaw
    for (i = 0; i < 3; i++) {
      rebar(B, gx + rng.range(-0.7, 0.7), y + 0.42, zF - 0.1,
        rng.range(0.30, 0.55), rng.range(-0.4, 0.4), 0.9, rng.range(0.2, 0.7), rng);
    }
    // Blown sand banked against the inside of the parapet and drifted across the
    // deck the framing actually sees. This is not decoration: a bitumen deck at
    // 15% albedo standing in its own parapet's shadow measured at luminance
    // 0.05, and sand is the only material on a roof bright enough to pull that
    // back without touching the exposure everything else is graded against.
    for (i = 0; i < 5; i++) {
      e = B.add('sand', blobDisc(rng, rng.range(0.55, 1.15), rng.range(0.35, 0.6), 0.5),
        makeM(W * (0.18 + i * 0.16) + rng.range(-0.3, 0.3), y + 0.055,
          zF - rng.range(0.22, 0.55), 0, rng.range(0, 6.283), 0));
      e.paint = 'ground'; e.dark = rng.range(0, 0.10);
    }
    for (i = 0; i < 6; i++) {
      // the visible wedge: local x 3-12, z -0.6 to -0.72 * x, which is what this
      // camera can see of the deck at all
      var sdx = 3.0 + i * 1.55 + rng.range(-0.4, 0.4);
      var sdz = zF - rng.range(0.7, Math.max(1.0, 0.55 * sdx));
      e = B.add('sand', blobDisc(rng, rng.range(0.60, 1.35), rng.range(0.5, 0.95), 0.52),
        makeM(sdx, y + 0.055, sdz, 0, rng.range(0, 6.283), 0));
      e.paint = 'ground'; e.dark = rng.range(0, 0.16);
    }
    // a swept apron of pale mineral chippings around the fighting position -
    // where somebody has actually been walking, the felt is worn back to them
    for (i = 0; i < 3; i++) {
      e = B.add('gravel', blobDisc(rng, rng.range(0.9, 1.5), rng.range(0.5, 0.8), 0.4),
        makeM(W * 0.32 + i * 1.4, y + 0.05, zF - rng.range(0.8, 1.7),
          0, rng.range(0, 6.283), 0));
      e.paint = 'ground'; e.dark = rng.range(0, 0.10);
    }
    // Two BIG drifts across the near deck. The corner of a flat roof behind a
    // parapet is where two years of dust ends up, and at this sun angle it is
    // the difference between a deck that reads as ground and one that reads as
    // a hole: the near quadrant measured 0.09 mean luminance without them.
    for (i = 0; i < 3; i++) {
      e = B.add('sand', blobDisc(rng, rng.range(1.0, 1.5), rng.range(0.55, 0.85), 0.50),
        makeM(3.4 + i * 2.6, y + 0.06, zF - 1.45 - i * 0.9, 0, rng.range(0, 6.283), 0));
      e.paint = 'ground'; e.dark = rng.range(0.02, 0.16);
    }

    // ---- a fighting position built into the street parapet ------------------
    // The reason the player can get up here, and the frame's foreground: it
    // solves to 19 degrees left of the axis at 3.7 m. Sandbags on the coping
    // with a loophole left in the top course, a corrugated sheet propped over it
    // for overhead concealment, an ammo crate, a mat and a spent-case scatter.
    // The revetment is an L, not a straight run. The camera stands ON the
    // parapet line and looks ALONG it, so a wall laid on the coping is seen
    // end-on and renders as a totem of four pale lumps - which is exactly what
    // the first pass produced. Two courses go along the coping, where they read
    // as a lumpy line, and the mass of the position is a three-course blast wall
    // running back into the deck at the far end, which the frame sees broadside.
    var fx0 = W * 0.30, fz = zF - 0.62;
    var bagHue = [0xa89a78, 0x9c8f70, 0xb3a582, 0x8d8268, 0xbfae90];
    function layBag(bx, by, bz, yaw) {
      var m = makeM(bx + rng.range(-0.05, 0.05), by + rng.range(-0.02, 0.02),
        bz + rng.range(-0.06, 0.06),
        rng.range(-0.14, 0.14), yaw + rng.range(-0.22, 0.22) + (rng.bool(0.14) ? 1.57 : 0),
        rng.range(-0.16, 0.16));
      m.scale(_tmpV.set(rng.range(0.9, 1.12), rng.range(0.85, 1.1), rng.range(0.9, 1.12)));
      var se = B.add('sandbag', sackGeo(rng.int(0, SACK_N - 1), noise), m);
      se.paint = 'sack';
      se.tint = tint(rng.pick(bagHue), rng.range(0.16, 0.5));
      return se;
    }
    for (var c = 0; c < 3; c++) {                 // the sill along the coping
      var off = rng.range(-0.2, 0.2);
      for (i = 0; i < 9 - c; i++) {
        if (c === 2 && (i === 3 || i === 4)) continue;   // the loophole
        layBag(fx0 + off + i * 0.44, y + 0.05 + 0.15 * (c + 0.5), fz + (c ? 0.05 : 0), 0);
      }
    }
    var bwx = fx0 + 3.70;                          // the blast wall, broadside
    for (c = 0; c < 3; c++) {
      var bn2 = 5 - (c === 2 ? 1 : 0);
      for (i = 0; i < bn2; i++) {
        if (c === 2 && i === 3) continue;
        layBag(bwx + (c === 1 ? 0.09 : 0), y + 0.05 + 0.15 * (c + 0.5),
          fz - 0.30 - i * 0.32, 1.5708);
      }
    }
    // a low ammunition shelf of bags in the elbow of the L
    for (i = 0; i < 3; i++) {
      layBag(bwx - 0.55 - i * 0.42, y + 0.10, fz - 1.55, 0.35);
    }
    // two uprights and a sheet of corrugated iron laid over the position: a
    // strong diagonal in the near foreground, and the only thing in the frame
    // that throws a hard shadow onto the deck
    for (i = -1; i <= 1; i += 2) {
      B.boxR('rusted_metal', 0.07, 1.15, 0.07, fx0 + 1.35 + i * 1.05, y + 0.58, fz - 1.02,
        0, 0, i * 0.05, 0.008);
    }
    B.boxR('corrugated_metal', 2.15, 0.035, 1.05, fx0 + 1.35, y + 1.02, fz - 0.62,
      -0.30, 0.06, 0.02, 0.008).dark = rng.range(0.0, 0.10);
    B.boxR('fabric', 1.8, 0.03, 0.48, fx0 + 1.35, y + 1.13, fz - 1.02,
      -0.12, 0, 0, 0.008).tint = tint(0x8a8067, 0.6);
    // a shooting mat of folded sacking and a discarded ammo box behind it
    B.boxR('fabric', 1.15, 0.05, 0.75, fx0 + 1.3, y + 0.06, fz - 0.95,
      0, rng.range(-0.2, 0.2), 0, 0.012).tint = tint(0x6f6a58, 0.7);
    B.boxR('painted_metal', 0.45, 0.24, 0.28, fx0 + 2.5, y + 0.14, fz - 0.85,
      0, 0.4, 0, 0.012).tint = tint(0x5d6350, 0.85);
    B.boxR('painted_metal', 0.45, 0.05, 0.28, fx0 + 2.35, y + 0.28, fz - 1.05,
      0.5, 0.35, 0, 0.008).tint = tint(0x5d6350, 0.85);
    // a second crate stack and a jerrycan, so the position has a footprint
    for (i = 0; i < 2; i++) {
      B.boxR('wood_plank', 0.56, 0.30, 0.38, fx0 + 3.15 + i * 0.06,
        y + 0.16 + i * 0.31, fz - 1.32 + i * 0.05,
        0, rng.range(-0.25, 0.25), 0, 0.012).tint = tint(0x8a7350, 0.75);
    }
    B.boxR('painted_metal', 0.24, 0.42, 0.36, fx0 - 0.55, y + 0.22, fz - 1.15,
      0, 0.5, 0.04, 0.014).tint = tint(0x5a6350, 0.8);
    for (i = 0; i < 20; i++) {
      B.cyl('rusted_metal', 0.0055, 0.0055, 0.045,
        fx0 + rng.range(0.2, 3.0), y + 0.05, fz - rng.range(0.35, 1.6),
        1.4 + rng.range(-0.25, 0.25), rng.range(0, 3.14), 0, 5).paint = 'flat';
    }

    // ---- condenser bank on a light steel frame: the FOREGROUND MASS ---------
    // 3 m out at 43 degrees left, deliberately close enough that its left edge
    // runs off the frame. A hero framing needs one object near enough to have
    // parallax against everything behind it, and on a roof this is the only
    // candidate that is both big and believable. Three units, and the frame
    // stands the bank off the deck - a machine sitting flush on a roof is the
    // tell that it was placed rather than installed.
    var ax = W * 0.44, az = zF - 2.05;
    for (i = -1; i <= 1; i += 2) {
      for (j = -1; j <= 1; j += 2) {
        B.box('rusted_metal', 0.07, 0.36, 0.07, ax + i * 1.35, y + 0.18, az + j * 0.5, 0.008);
      }
      B.box('concrete', 0.34, 0.10, 1.3, ax + i * 1.35, y + 0.05, az, 0.01);
    }
    B.box('rusted_metal', 3.0, 0.06, 1.2, ax, y + 0.39, az, 0.008);
    for (i = -1; i <= 1; i += 2) {
      var ux = ax + i * 0.78;
      // A plain 1.35 m box in painted_metal at 80% tint rendered as a pale
      // CONCRETE slab at 4 m: no panel line, no louvre, nothing at machine
      // scale. The case is darker painted steel now and carries the two things
      // that actually say "condenser" at this range - a louvred flank and a
      // seam round the service panel.
      // paint 'flat' on every painted-steel face: the 'wall' mode lays two
      // octaves of masonry blotching over whatever it touches, and on a 1.35 m
      // machine seen at 3.6 m that reads as weathered CONCRETE, which is why
      // the bank came back looking like a stack of precast blocks. A painted
      // case is smooth; its interest has to come from the louvres and the seams.
      ce = B.box('painted_metal', 1.35, 0.72, 1.0, ux, y + 0.78, az, 0.016);
      ce.tint = tint(0x9aa0a2, 0.75).multiplyScalar(0.64); ce.paint = 'flat';
      for (j = 0; j < 7; j++) {
        ce = B.boxR('painted_metal', 1.26, 0.035, 0.045, ux, y + 0.50 + j * 0.075, az - 0.50,
          -0.32, 0, 0, 0.006);
        ce.tint = tint(0x9aa0a2, 0.75).multiplyScalar(0.80); ce.paint = 'flat';
      }
      ce = B.box('painted_metal', 1.12, 0.03, 0.03, ux, y + 1.09, az + 0.50, 0.005);
      ce.tint = tint(0x9aa0a2, 0.75).multiplyScalar(0.44); ce.paint = 'flat';
      ce = B.box('painted_metal', 0.03, 0.52, 0.03, ux - 0.55, y + 0.80, az + 0.50, 0.005);
      ce.tint = tint(0x9aa0a2, 0.75).multiplyScalar(0.44); ce.paint = 'flat';
      B.box('rusted_metal', 1.3, 0.06, 0.06, ux, y + 1.15, az, 0.008);
      // fan cowl + guard bars, the thing that reads as an AC unit at 12 m
      B.cyl('rusted_metal', 0.34, 0.34, 0.07, ux, y + 1.16, az, 0, 0, 0, 12);
      for (j = 0; j < 4; j++) {
        B.boxR('rusted_metal', 0.62, 0.018, 0.018, ux, y + 1.2, az,
          0, j * 0.7854, 0, 0.004);
      }
      B.dark = 0.6;
      B.box('backdrop', 0.06, 0.5, 0.82, ux + 0.68, y + 0.78, az, 0.008);
      B.dark = 0;
    }
    // a third, older split unit dumped on the deck beyond the position
    var a3x = W * 0.672, a3z = zF - 0.93;
    e = B.boxR('painted_metal', 1.0, 0.58, 0.72, a3x, y + 0.30, a3z,
      0.06, -0.34, 0.03, 0.014);
    e.tint = tint(0x9c9789, 0.75).multiplyScalar(0.56); e.paint = 'flat';
    B.cyl('rusted_metal', 0.26, 0.26, 0.06, a3x, y + 0.34, a3z + 0.37,
      1.5708, -0.34, 0, 12);
    // lagged pipework running off the frame and down the bulkhead wall
    B.cyl('painted_metal', 0.055, 0.055, 2.2, ax + 1.6, y + 0.62, az, 0, 0, 1.5708, 8)
      .tint = tint(0xb9b3a6, 0.7);
    B.cyl('painted_metal', 0.055, 0.055, 0.6, ax + 2.68, y + 0.33, az, 0, 0, 0, 8)
      .tint = tint(0xb9b3a6, 0.7);
    // condensate drain run to the parapet scupper
    B.cyl('rubber', 0.022, 0.022, 2.0, ax + 0.3, y + 0.07, az + 1.1, 0, 0.35, 1.5708, 5)
      .paint = 'flat';

    // ---- a second, lighter water tank on a block stand ----------------------
    // The brief's plural. A poly drum on blockwork beside the big steel one, so
    // the mid-ground has two masses at different heights instead of one.
    var wx = W * 0.60, wz = zF - 3.7;
    for (i = -1; i <= 1; i += 2) {
      B.box('concrete', 0.30, 0.62, 0.72, wx + i * 0.40, y + 0.31, wz, 0.012);
    }
    // tint() normalises its argument to a maximum of 1 before it lerps toward
    // white, so a dark hex comes back BRIGHT and saturated - which is how the
    // first pass put a mint-green bucket in the frame. Dark objects have to be
    // scaled down after the hue is chosen.
    var POLY = tint(0x2f3a36, 0.85).multiplyScalar(0.34);
    B.box('wood_plank', 1.20, 0.07, 0.86, wx, y + 0.65, wz, 0.01)
      .tint = tint(0x6b5540, 0.8).multiplyScalar(0.60);
    e = B.cyl('painted_metal', 0.44, 0.46, 0.92, wx, y + 1.15, wz, 0, 0.3, 0, 12);
    e.tint = POLY; e.paint = 'flat';
    e = B.cyl('painted_metal', 0.47, 0.47, 0.05, wx, y + 1.63, wz, 0, 0.3, 0, 12);
    e.tint = POLY; e.paint = 'flat';
    for (i = 0; i < 2; i++) {
      e = B.cyl('painted_metal', 0.455, 0.455, 0.035, wx, y + 0.86 + i * 0.42, wz, 0, 0.3, 0, 12);
      e.tint = tint(0x2f3a36, 0.85).multiplyScalar(0.48); e.paint = 'flat';
    }
    B.cyl('rusted_metal', 0.028, 0.028, 1.30, wx + 0.36, y + 0.62, wz + 0.30, 0, 0, 0.16, 6);

    // ---- aerial mast + dish cluster: the silhouette against the sky ---------
    var mx = W * 0.76, mz = zF - 4.45;
    B.box('concrete', 0.7, 0.22, 0.7, mx, y + 0.11, mz, 0.012);
    B.cyl('rusted_metal', 0.045, 0.055, 4.3, mx, y + 2.3, mz, 0, 0, 0, 6);
    for (i = 0; i < 3; i++) {
      // guys back to the deck - three thin diagonals do more for a roofscape
      // silhouette than another box ever will
      var ga = i * 2.094 + 0.5;
      B.boxR('rusted_metal', 0.016, 3.5, 0.016,
        mx + Math.cos(ga) * 0.62, y + 2.0, mz + Math.sin(ga) * 0.62,
        Math.sin(ga) * 0.33, 0, -Math.cos(ga) * 0.33, 0.004);
    }
    for (i = 0; i < 4; i++) {
      var ey = y + 2.5 + i * 0.42;
      B.box('rusted_metal', 1.05 - i * 0.13, 0.02, 0.02, mx, ey, mz, 0.004);
    }
    // three satellite dishes on stub poles, facing different satellites. Kept
    // clear of the stair head's footprint at 0.875 of the width.
    var dOffX = [-1.15, -2.05, -0.45], dOffZ = [0.80, -0.55, -1.45];
    var dYaw = [0.72, -1.05, 0.25], dRad = [0.44, 0.32, 0.26];
    for (i = 0; i < 3; i++) {
      var dx2 = mx + dOffX[i], dz2 = mz + dOffZ[i], dr2 = dRad[i];
      B.cyl('rusted_metal', 0.035, 0.035, 0.85, dx2, y + 0.42, dz2, 0, 0, 0, 6);
      B.boxR('painted_metal', dr2 * 2, dr2 * 2, 0.06, dx2, y + 0.95, dz2,
        -0.55, dYaw[i], 0, dr2 * 0.5).tint = tint(0xc6c0b4, 0.55);
      B.boxR('rusted_metal', 0.03, 0.03, 0.4, dx2, y + 1.0, dz2, -0.55, dYaw[i], 0, 0.006);
    }

    // ---- cabling ------------------------------------------------------------
    // Feeder off the mast to the stair head, a drop down the bulkhead, and the
    // service run that leaves the roof over the street parapet. Long thin
    // diagonals against sky: nothing else in the kit does that job.
    wire(B, 'rubber', mx + 0.05, y + 3.55, mz, W * 0.875 - 0.9, y + 2.35, -4.6 + 0.7, 0.42, 0.016);
    wire(B, 'rubber', mx - 0.05, y + 2.95, mz, ax + 0.9, y + 1.30, az + 0.2, 0.55, 0.014);
    wire(B, 'rubber', ax + 1.5, y + 1.25, az - 0.2, W * 0.60 + 0.2, y + 1.70, wz + 0.2, 0.22, 0.012);
    wire(B, 'rubber', W * 0.875 - 1.1, y + 1.85, -4.6 + 1.0, W * 0.72, y + 0.32, zF - 0.45, 0.30, 0.013);
    // a coil of spare cable lying on the deck
    for (i = 0; i < 3; i++) {
      B.boxR('rubber', 0.46 - i * 0.06, 0.035, 0.46 - i * 0.06, W * 0.515, y + 0.06 + i * 0.035,
        zF - 2.45, 0, i * 0.6, 0, 0.02).paint = 'flat';
    }

    // ---- vent stacks on the sightline ---------------------------------------
    var vxs = [W * 0.57, W * 0.83], vzs = [zF - 1.45, zF - 1.30];
    for (i = 0; i < 2; i++) {
      var vh = [0.95, 1.25][i];
      B.box('brick', 0.52, vh, 0.52, vxs[i], y + vh * 0.5, vzs[i], 0.014);
      B.box('concrete', 0.68, 0.09, 0.68, vxs[i], y + vh + 0.045, vzs[i], 0.01);
      B.cyl('rusted_metal', 0.10, 0.12, 0.42, vxs[i] + 0.1, y + vh + 0.26, vzs[i], 0, 0, 0, 8);
      B.cyl('rusted_metal', 0.14, 0.14, 0.06, vxs[i] + 0.1, y + vh + 0.50, vzs[i], 0, 0, 0, 8);
    }

    // ---- duckboard walkway --------------------------------------------------
    // The path worn between the stair head and the firing position. A line ON
    // the deck is what turns a flat plane into ground you could walk over.
    var DUCK = tint(0x6b5540, 0.8).multiplyScalar(0.70);
    for (i = 0; i < 11; i++) {
      B.boxR('wood_plank', 0.17, 0.04, 0.72, 6.05 + i * 0.44, y + 0.05,
        zF - 3.25 + rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05),
        rng.range(-0.03, 0.03), 0.006).tint = DUCK;
    }
    for (i = 0; i < 2; i++) {
      B.box('wood_plank', 4.6, 0.03, 0.06, 8.25, y + 0.025, zF - 3.25 + (i ? 0.28 : -0.28), 0.005)
        .tint = DUCK;
    }

    // ---- the north parapet, shot through, spilling onto the deck ------------
    var bx2 = W - 0.12, bz2 = zB + D * rng.range(0.35, 0.6);
    B.dark = 0.35;
    for (i = 0; i < 9; i++) {
      B.boxR('brick', rng.range(0.12, 0.3), rng.range(0.09, 0.2), rng.range(0.1, 0.24),
        bx2 - rng.range(0.1, 0.55), y + rng.range(0.05, 0.7), bz2 + rng.range(-0.9, 0.9),
        rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), 0.01).paint = 'rubble';
    }
    B.dark = 0;
    rubblePile(B, bx2 - 0.9, y - 0.02, bz2, 1.5, 0.28, 26, rng);

    // ---- odds and ends: spare felt rolls, a bitumen drum, a broken chair ----
    var qx = W * 0.77, qz = zF - 2.60;
    for (i = 0; i < 3; i++) {
      B.cyl('rooffelt', 0.16, 0.16, 0.95, qx + i * 0.36, y + 0.17 + (i === 2 ? 0.3 : 0),
        qz + rng.range(-0.1, 0.1), 0, rng.range(-0.3, 0.3), 1.5708, 8).tint = FELT;
    }
    B.cyl('rusted_metal', 0.28, 0.28, 0.58, qx + 1.5, y + 0.29, qz - 0.5, 0, 0, 0, 12);
    B.cyl('rusted_metal', 0.29, 0.29, 0.05, qx + 1.5, y + 0.58, qz - 0.5, 0, 0, 0, 12)
      .dark = 0.3;
    B.boxR('wood_plank', 0.42, 0.05, 0.42, qx + 2.3, y + 0.24, qz + 0.35,
      0.25, 0.7, 0.4, 0.008).tint = tint(0x6b5540, 0.8);
    for (i = 0; i < 4; i++) {
      B.boxR('wood_plank', 0.04, 0.42, 0.04, qx + 2.3 + [-0.15, 0.15, -0.15, 0.15][i],
        y + 0.06, qz + 0.35 + [-0.15, -0.15, 0.15, 0.15][i],
        0.25, 0.7, 0.4, 0.006).tint = tint(0x6b5540, 0.8);
    }
  }

  // ================================================================= LAYOUT ==
  // Both sides deliberately break at different z values so the two rows never
  // line up, and the gaps sit roughly opposite each other around z = -5 so the
  // low sun throws a bright cross-band across the street there. The burnt-out
  // sedan is parked straddling that band.
  var BLOCKS = [
    // --- west side (facades at x = -7, looking east) ---
    { id: 'W1', side: 'W', zS: 17.0, zN: 6.6, floors: [3.7, 3.15, 3.05], bays: 4,
      ground: 'shop', depth: 12.5, hue: 0xd9c3a0, damage: 0.25, pilasters: true, balconies: true },
    { id: 'W2', side: 'W', zS: 6.0, zN: -4.0, floors: [4.0, 3.25], bays: 3,
      ground: 'shop', depth: 12.0, hue: 0xcbb392, damage: 0.55, hollowGround: true,
      openGround: true, roof: 'none',
      shaft: { x0: -13.0, x1: -10.6, z0: 1.4, z1: 3.8 } },
    { id: 'W3', side: 'W', zS: -8.4, zN: -21.2, floors: [3.4, 2.8, 2.8], bays: 4,
      ground: 'door', depth: 12.0, hue: 0xc2b49a, damage: 0.35, roof: 'access', pilasters: true },
    { id: 'W4', side: 'W', zS: -21.2, zN: -33.8, floors: [3.5, 3.0, 3.0, 2.9], bays: 4,
      ground: 'shop', depth: 12.5, hue: 0xd0bb95, damage: 0.85, balconies: true,
      collapseFrom: 0.52 },
    { id: 'W5', side: 'W', zS: -36.2, zN: -46.4, floors: [3.8, 3.3], bays: 3,
      ground: 'shop', depth: 11.0, hue: 0xbfae90, damage: 0.6 },
    { id: 'W6', side: 'W', zS: -46.4, zN: -55.0, floors: [3.3, 3.0, 2.9], bays: 3,
      ground: 'door', depth: 11.5, hue: 0xd4c0a2, damage: 0.4, pilasters: true },
    // --- east side (facades at x = +7, looking west) ---
    { id: 'E1', side: 'E', zS: 17.0, zN: 5.2, floors: [3.6, 3.1, 3.0], bays: 4,
      ground: 'door', depth: 12.0, hue: 0xc9b08a, damage: 0.3, balconies: true },
    { id: 'E2', side: 'E', zS: 5.2, zN: -3.0, floors: [3.9, 3.1], bays: 3,
      ground: 'shop', depth: 11.5, hue: 0xd9c3a0, damage: 0.45 },
    { id: 'E3', side: 'E', zS: -6.7, zN: -19.6, floors: [3.6, 3.1, 3.0, 2.9], bays: 4,
      ground: 'shop', depth: 13.0, hue: 0xbcae94, damage: 0.7, pilasters: true, balconies: true },
    { id: 'E4', side: 'E', zS: -19.6, zN: -32.0, floors: [3.5, 3.0, 3.0], bays: 4,
      ground: 'shop', depth: 12.0, hue: 0xd3bd99, damage: 0.5, balconies: true },
    { id: 'E5', side: 'E', zS: -34.4, zN: -46.4, floors: [3.6, 3.1, 3.0], bays: 4,
      ground: 'door', depth: 12.5, hue: 0xc4b190, damage: 0.55, pilasters: true },
    { id: 'E6', side: 'E', zS: -46.4, zN: -55.0, floors: [3.4, 3.05], bays: 3,
      ground: 'shop', depth: 11.0, hue: 0xcdb896, damage: 0.35 }
  ];

  // Gaps that expose flank walls (and let the sun through).
  var GAPS = [
    { side: 'W', zS: -4.0, zN: -8.4, kind: 'courtyard' },
    { side: 'W', zS: -33.8, zN: -36.2, kind: 'slot' },
    { side: 'E', zS: -3.0, zN: -6.7, kind: 'alley' },
    { side: 'E', zS: -32.0, zN: -34.4, kind: 'slot' }
  ];

  function makeSpec(blk, rng) {
    var S = {
      id: blk.id, side: blk.side, zS: blk.zS, zN: blk.zN, depth: blk.depth,
      width: blk.zS - blk.zN, floors: blk.floors, bays: blk.bays,
      ground: blk.ground, doorBay: rng.int(0, blk.bays - 1),
      coreKey: rng.bool(0.45) ? 'brick' : 'concrete_wall',
      // one core material per floor band rather than one per building
      coreBands: [rng.bool(0.45) ? 'brick' : 'concrete_wall',
        rng.bool(0.5) ? 'brick' : 'concrete_wall',
        rng.bool(0.4) ? 'brick' : 'concrete_wall'],
      // the reveal is a property of the BUILDING, not of the module: 18 cm on a
      // thin later block, 42 cm on a heavy older one, and the sill projects to
      // match. A single constant across twelve buildings is why the two rows
      // read as one continuous kit.
      reveal: rng.range(0.18, 0.42),
      headKind: rng.bool(0.34) ? 'arch' : 'win',
      ventTop: rng.bool(0.4),
      frameKey: rng.bool(0.55) ? 'wood_plank' : 'painted_metal',
      parapetH: rng.range(0.72, 1.15),
      plasterTint: tint(blk.hue, rng.range(0.55, 0.85)),
      blownChance: M.clamp(0.18 + blk.damage * 0.6, 0, 0.95),
      shutterChance: rng.range(0.22, 0.44),
      balconies: !!blk.balconies, balconyFloor: 1,
      pilasters: !!blk.pilasters,
      damage: blk.damage,
      holes: [], skinBlobs: [], scorch: [], streaks: [],
      collapse: null, hollowGround: !!blk.hollowGround, roof: blk.roof || null,
      openGround: !!blk.openGround, shaft: blk.shaft || null,
      parapetGap: null
    };
    // Only the accessible roof gets its street parapet blown through, and it is
    // placed at 0.28 of the width because that is where the SOLVED rooftop
    // standpoint (see roofSet) puts it: 2-3 m ahead of the camera and within a
    // few degrees of the frame centre, so the breach opens the canyon rather
    // than being a hole in a wall nobody is looking at.
    if (S.roof === 'access') {
      S.parapetGap = { x0: S.width * 0.275, x1: S.width * 0.275 + 1.55 };
    }
    var totalH = 0, i;
    for (i = 0; i < blk.floors.length; i++) totalH += blk.floors[i];
    S.totalH = totalH;

    // plaster spalls: gravity-biased toward the base where splash and blast
    // strip the render first
    var nS = Math.round(6 + blk.damage * 22);
    for (i = 0; i < nS; i++) {
      S.skinBlobs.push({
        x: rng.range(-0.3, S.width + 0.3),
        y: Math.pow(rng.next(), 1.9) * totalH,
        // capped: a blob wide enough to swallow a whole wallRect leaves the
        // bare core showing as one hard-edged rectangle
        r: rng.range(0.22, 0.26 + blk.damage * 0.52),
        p: rng.range(0, 6.283)
      });
    }
    // shell holes punch the core as well
    var nH = Math.round(blk.damage * 4.2);
    for (i = 0; i < nH; i++) {
      var hx = rng.range(0.6, S.width - 0.6);
      var hy = rng.range(1.2, totalH - 0.8);
      S.holes.push({ x: hx, y: hy, r: rng.range(0.42, 0.35 + blk.damage * 0.8), p: rng.range(0, 6.283) });
    }
    if (blk.collapseFrom !== undefined) {
      // diagonal shear: intact at the south end, taken off toward the north
      S.collapse = { x0: S.width * blk.collapseFrom, y0: totalH + 0.4, slope: -1.05 };
    }
    return S;
  }

  // Places one block: facade, solid mass, roof, and any exposed flanks.
  function buildBlock(L, B, S, rng) {
    var west = S.side === 'W';
    var fx = west ? -FACADE_X : FACADE_X;
    var totalH = S.totalH;
    var i;

    B.tint = S.plasterTint;
    B.push(facadeOrient(west ? 'px' : 'mx', fx, 0, west ? S.zS : S.zN));
    buildFacade(B, S, rng);

    // roof deck lives in the same local frame
    if (S.roof === 'none') {
      /* custom roof built by the interior pass (it needs a hole in it) */
    } else if (!S.collapse) {
      roofDeck(B, S.width, S.depth - 1.4, totalH, rng, S, S.roof === 'access'
        // Laid out against the SOLVED rooftop standpoint, not the published
        // anchor: scenarios.js marches laterally to the street parapet before it
        // shoots, so anything more than ~5 m back from that edge leaves the
        // frame entirely. The tank sits 7 m out at 29 degrees left, the stair
        // head 10 m out at 38, tall enough to break the horizon line.
        ? { bulkhead: { x: S.width * 0.875, z: -4.6 },
            tank: { x: S.width * 0.70, z: -2.35 },
            set: true, noise: L.noise }
        : { plant: rng.bool(0.5),
            tank: rng.bool(0.5) ? { x: S.width * rng.range(0.25, 0.75), z: -rng.range(3.5, 7) } : null });
    } else {
      // partial roof over the surviving portion, with the torn slab edge shown
      var xEnd = M.clamp((totalH - S.collapse.y0) / S.collapse.slope + S.collapse.x0, 0, S.width);
      if (xEnd > 1.0) roofDeck(B, xEnd, S.depth - 1.4, totalH, rng, S, {});
      for (i = 0; i < S.floors.length; i++) {
        var fy = 0; for (var k = 0; k <= i; k++) fy += S.floors[k];
        if (fy >= totalH - 0.01) continue;
        var xc = M.clamp((fy - S.collapse.y0) / S.collapse.slope + S.collapse.x0, 0, S.width);
        if (xc <= 0.4 || xc >= S.width - 0.2) continue;
        // exposed floor slab jutting into open air - reads instantly as a section
        B.box('concrete', S.width - xc, 0.24, 3.6, (xc + S.width) * 0.5, fy - 0.12, -2.2, 0.014);
        B.box('concrete', S.width - xc, 0.06, 0.1, (xc + S.width) * 0.5, fy - 0.26, -0.45, 0.008);
        for (var r = 0; r < 5; r++) {
          rebar(B, xc + rng.range(0, S.width - xc), fy - 0.05, -0.35, rng.range(0.4, 0.9),
            rng.range(-0.4, 0.4), rng.range(-0.2, 0.6), rng.range(0.5, 1), rng);
        }
      }
    }
    B.pop();
    B.tint = null;

    // ---- solid mass behind the facade ----
    // The front 1.45 m stays hollow so window reveals and shopfront recesses
    // have somewhere to be. A light shaft (S.shaft) splits the mass in four.
    var massFront = 1.45;
    var massY0 = S.hollowGround ? S.floors[0] : 0;
    var mxA = west ? fx - S.depth : fx + massFront;
    var mxB = west ? fx - massFront : fx + S.depth;
    var mh = totalH + S.parapetH * 0.4 - massY0;
    var rects = S.shaft
      ? subtractRect(mxA, mxB, S.zN, S.zS, S.shaft.x0, S.shaft.x1, S.shaft.z0, S.shaft.z1)
      : [[mxA, mxB, S.zN, S.zS]];
    B.tint = S.plasterTint; B.dark = 0.06;
    for (i = 0; i < rects.length; i++) {
      var R = rects[i];
      B.box('concrete_wall', R[1] - R[0], mh, R[3] - R[2],
        (R[0] + R[1]) * 0.5, massY0 + mh * 0.5, (R[2] + R[3]) * 0.5, 0.02);
      // Collision stops at the roof DECK, not at the mesh top: otherwise the
      // building solids swallow their own roof and the nav pass writes it off.
      L.addCollider((R[0] + R[1]) * 0.5, massY0 + (totalH - massY0) * 0.5, (R[2] + R[3]) * 0.5,
        (R[1] - R[0]) * 0.5, (totalH - massY0) * 0.5, (R[3] - R[2]) * 0.5, 'plaster');
    }
    B.dark = 0; B.tint = null;
    // The facade slab stops at the deck too, so it forms the front strip of
    // the roof floor rather than a 1.45 m plinth standing on it.
    L.addCollider(west ? (fx - massFront * 0.5) : (fx + massFront * 0.5),
      massY0 + (totalH - massY0) * 0.5, (S.zS + S.zN) * 0.5,
      massFront * 0.5, (totalH - massY0) * 0.5, S.width * 0.5, 'plaster');
    // the street parapet, always solid (bullets stop in it too)
    L.addCollider(west ? (fx - 0.15) : (fx + 0.15), totalH + S.parapetH * 0.5,
      (S.zS + S.zN) * 0.5, 0.19, S.parapetH * 0.5, S.width * 0.5, 'plaster');
    // stop the player walking off an accessible roof
    if (S.roof === 'access') {
      var rbx = west ? fx - S.depth : fx + S.depth;
      L.addCollider((rbx + (west ? 0.12 : -0.12)), totalH + S.parapetH * 0.5, (S.zS + S.zN) * 0.5,
        0.16, S.parapetH * 0.5, S.width * 0.5, 'plaster');
      for (i = -1; i <= 1; i += 2) {
        L.addCollider(west ? (fx - S.depth * 0.5) : (fx + S.depth * 0.5),
          totalH + S.parapetH * 0.5, (S.zS + S.zN) * 0.5 + i * (S.width * 0.5 - 0.12),
          S.depth * 0.5, S.parapetH * 0.5, 0.16, 'plaster');
      }
    }

    // ---- rear elevation ------------------------------------------------------
    // Every non-street face of the mass was a bare untextured box, and any
    // framing that clears the roofline sees them - overview measured 27% of the
    // frame as flat. flankWall is almost entirely wallRect, so giving the back
    // of every block real openings, a soil stack, a hopper and spall costs a few
    // hundred triangles each. The two side faces are left alone deliberately:
    // the blocks abut, so they are only ever exposed at the four GAPS, which
    // already get a flank.
    if (S.depth > 4.0) {
      var rh = totalH + S.parapetH * 0.4 - massY0;
      var Fs = {
        coreKey: S.coreKey, frameKey: S.frameKey, parapetH: S.parapetH,
        holes: EMPTY, skinBlobs: [], scorch: [], streaks: [],
        blownChance: S.blownChance,
        // Back elevations are only ever seen from 30 m up, so their spall
        // resolves at half the street facades' rate. This is where the
        // triangle budget for the extra twelve elevations comes from.
        spallMin: 0.80
      };
      var nrb = 6 + Math.round(S.damage * 3);
      for (i = 0; i < nrb; i++) {
        Fs.skinBlobs.push({
          x: rng.range(-0.3, S.width + 0.3),
          y: Math.pow(rng.next(), 1.9) * rh,
          r: rng.range(0.3, 0.4 + S.damage * 0.7),
          p: rng.range(0, 6.283)
        });
      }
      B.tint = S.plasterTint;
      B.push(facadeOrient(west ? 'mx' : 'px',
        west ? (fx - S.depth) : (fx + S.depth), massY0, west ? S.zN : S.zS, WALL_OUT));
      flankWall(B, S.width, Math.max(2.5, rh), rng, Fs);
      B.pop();
      B.tint = null;
      L.streaks.push.apply(L.streaks, Fs.streaks);
    }

    L.scorches.push.apply(L.scorches, S.scorch);
    L.streaks.push.apply(L.streaks, S.streaks);

    // rebar + soot ring inside each shell hole
    B.push(facadeOrient(west ? 'px' : 'mx', fx, 0, west ? S.zS : S.zN));
    for (i = 0; i < S.holes.length; i++) {
      var hl = S.holes[i];
      for (var b = 0; b < 3; b++) {
        rebar(B, hl.x + rng.range(-hl.r * 0.6, hl.r * 0.6), hl.y + rng.range(-hl.r * 0.5, hl.r * 0.5),
          -WALL_T * 0.6, rng.range(0.35, 0.7), rng.range(-0.5, 0.5), rng.range(-0.3, 0.5),
          rng.range(0.4, 1.0), rng);
      }
      L.scorches.push({ p: B.worldPoint(hl.x, hl.y, 0.04), r: hl.r * 2.6, k: 0.62 });
      // spalled lip: broken masonry pushed out around the entry wound
      for (var s = 0; s < 6; s++) {
        var a = rng.range(0, 6.283);
        B.boxR(rng.bool(0.5) ? 'brick' : 'concrete', rng.range(0.1, 0.24), rng.range(0.08, 0.2),
          rng.range(0.05, 0.13), hl.x + Math.cos(a) * hl.r * 1.15, hl.y + Math.sin(a) * hl.r * 1.15,
          rng.range(-0.06, 0.05), rng.range(-0.6, 0.6), rng.range(-0.6, 0.6), rng.range(-0.6, 0.6), 0.01);
      }
    }
    B.pop();
  }

  // A flank wall exposed by a gap between two blocks.
  function buildFlank(L, B, blk, rng, facingNorth, gap) {
    var west = blk.side === 'W';
    var h = 0, i;
    for (i = 0; i < blk.floors.length; i++) h += blk.floors[i];
    var S = makeSpec(blk, rng);
    S.skinBlobs.length = Math.min(S.skinBlobs.length, 10);
    S.holes.length = 0;
    // The alley's two flanks are a published hero framing seen from 4 m, so
    // their damage boundary resolves at half the pitch. That is a few hundred
    // extra boxes on two walls, not across all twelve blocks.
    var kind = gap && gap.kind;
    S.spallMin = kind === 'alley' ? 0.17 : kind === 'courtyard' ? 0.24 : 0.34;
    // The alley is a 3.7 m slot between two four-storey blocks: no direct sun
    // ever reaches its lower two storeys, so those flanks are lit by sky bounce
    // alone and rendered at 13% mean - two near-black walls across 70% of a
    // hero framing. The honest fix is not exposure, it is ALBEDO: back alleys
    // in this city are limewashed precisely because it makes them usable, and
    // limewash is 75% reflectance against bare render's 45%. tint() normalises
    // to <=1 by construction, so this is built directly; vertex colour is an
    // unclamped multiplier and a value above 1 is legal (see SACK_TARGET).
    if (kind === 'alley') S.plasterTint = LIMEWASH;
    B.tint = S.plasterTint;
    var z = facingNorth ? blk.zN : blk.zS;
    var ox, facing;
    if (west) {
      if (facingNorth) { facing = 'mz'; ox = -FACADE_X; }
      else { facing = 'pz'; ox = -FACADE_X - blk.depth; }
    } else {
      if (facingNorth) { facing = 'mz'; ox = FACADE_X + blk.depth; }
      else { facing = 'pz'; ox = FACADE_X; }
    }
    B.push(facadeOrient(facing, ox, 0, z, WALL_OUT));
    flankWall(B, blk.depth, h + 0.6, rng, S);
    B.pop();
    B.tint = null;
    L.streaks.push.apply(L.streaks, S.streaks);
  }

  // ================================================================= GROUND ==
  // Cambered asphalt with a real gutter, potholes, tar patches and settlement.
  // A dead-flat plane under a street is a giveaway even before you texture it.
  function roadY(x, z, F, noise) {
    var t = Math.abs(x) / STREET_HALF;
    var y = -0.135 * t * t;                                   // camber
    y -= 0.055 * M.smoothstep(0.74, 1.0, t);                  // gutter channel
    y += 0.014 * noise.fbm2(x * 0.55, z * 0.5, 3);            // settlement ripple
    y += 0.006 * noise.fbm2(x * 3.1, z * 3.1, 2);             // coarse aggregate
    for (var i = 0; i < F.potholes.length; i++) {
      var p = F.potholes[i];
      var dx = x - p.x, dz = z - p.z;
      var d = Math.sqrt(dx * dx + dz * dz) / p.r;
      if (d < 1) y -= p.d * (1 - d * d) * (1 - d * d);
    }
    for (var j = 0; j < F.patches.length; j++) {
      var q = F.patches[j];
      if (x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1) {
        var e = Math.min(Math.min(x - q.x0, q.x1 - x), Math.min(z - q.z0, q.z1 - z));
        y += q.h * M.smoothstep(0, 0.35, e);
      }
    }
    return y;
  }

  function buildRoad(B, L, rng, noise) {
    var F = L.roadFeatures;
    // The carriageway runs well past both arched passages: looking through an
    // arch and finding the world stops 50 cm behind it is an instant tell.
    var z0 = Z_SOUTH + 16, z1 = Z_NORTH - 18;
    var nx = 26, nz = 142;
    var pos = [], idx = [];
    var ix, iz;
    for (iz = 0; iz <= nz; iz++) {
      var z = M.lerp(z0, z1, iz / nz);
      for (ix = 0; ix <= nx; ix++) {
        var x = M.lerp(-STREET_HALF, STREET_HALF, ix / nx);
        pos.push(x, roadY(x, z, F, noise), z);
      }
    }
    for (iz = 0; iz < nz; iz++) {
      for (ix = 0; ix < nx; ix++) {
        var a = iz * (nx + 1) + ix, b = a + 1, c = a + nx + 1;
        idx.push(a, b, c, b, c + 1, c);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    B.paint = 'road';
    B.add('asphalt', g, null);
    B.paint = 'wall';

    // tar-band repairs sitting proud of the surface
    for (var p = 0; p < F.patches.length; p++) {
      var q = F.patches[p];
      var e = B.box('asphalt', q.x1 - q.x0, 0.02, q.z1 - q.z0, (q.x0 + q.x1) * 0.5,
        roadY((q.x0 + q.x1) * 0.5, (q.z0 + q.z1) * 0.5, F, noise) + q.h + 0.012,
        (q.z0 + q.z1) * 0.5, 0.01);
      e.paint = 'flat'; e.dark = rng.range(0.18, 0.38);
    }
    // manhole covers and a drain grate, each set slightly below grade
    for (var m = 0; m < F.manholes.length; m++) {
      var mh = F.manholes[m];
      var my = roadY(mh.x, mh.z, F, noise);
      B.cyl('rusted_metal', 0.34, 0.35, 0.06, mh.x, my - 0.005, mh.z, 0, rng.range(0, 3), 0, 14);
      B.cyl('concrete', 0.44, 0.44, 0.10, mh.x, my - 0.045, mh.z, 0, 0, 0, 14);
    }
    for (var d = 0; d < F.drains.length; d++) {
      var dr = F.drains[d];
      var dy = roadY(dr.x, dr.z, F, noise);
      B.box('concrete', 0.5, 0.14, 0.72, dr.x, dy - 0.03, dr.z, 0.012);
      for (var s = 0; s < 6; s++) {
        B.box('rusted_metal', 0.34, 0.05, 0.045, dr.x, dy + 0.012, dr.z - 0.28 + s * 0.11, 0.006);
      }
    }

    // ---- worn centre line -----------------------------------------------
    // The carriageway had no surface story at all: no markings, no cracks, no
    // silt line. The broken centre line is also the strongest leading line in
    // the street framing, running straight at the arch.
    var lz = Z_SOUTH + 12;
    while (lz > Z_NORTH - 14) {
      var pitch = 5.4 + rng.range(-0.35, 0.35);
      var keep = rng.next();
      if (keep > 0.30) {                        // 45-70% worn through / missing
        var dl = 2.4 * (keep > 0.62 ? 1 : rng.range(0.30, 0.8));
        var lx = rng.range(-0.22, 0.22);
        // sits 3 cm proud: the road material carries ~1.4 cm of parallax and
        // the carriageway mesh only samples its own height field every 0.75 m,
        // so anything laid flatter than this gets swallowed by the asphalt
        var le = B.box('concrete', 0.17, 0.022, dl, lx,
          roadY(lx, lz - dl * 0.5, F, noise) + 0.030, lz - dl * 0.5, 0.004);
        le.paint = 'flat';
        // road paint has to read BRIGHTER than the asphalt it sits on; tinting
        // concrete only ever darkens, so this lifts it instead
        le.tint = LINE_PAINT;
        le.dark = rng.range(0.05, 0.42);
      }
      lz -= pitch;
    }

    // ---- crack network radiating out of the potholes ----------------------
    for (var pk = 0; pk < F.potholes.length; pk++) {
      var ph = F.potholes[pk];
      if (rng.bool(0.35)) continue;
      var nb = rng.int(2, 4);
      for (var br = 0; br < nb; br++) {
        var ang = rng.range(0, 6.283);
        var cxk = ph.x + Math.cos(ang) * ph.r * 0.9;
        var czk = ph.z + Math.sin(ang) * ph.r * 0.9;
        var segs = rng.int(2, 4);
        for (var sg = 0; sg < segs; sg++) {
          var len = rng.range(0.5, 1.4);
          var nx2 = cxk + Math.cos(ang) * len, nz2 = czk + Math.sin(ang) * len;
          if (Math.abs((cxk + nx2) * 0.5) > STREET_HALF - 0.3) break;
          var ck = B.boxR('asphalt', 0.05, 0.03, len, (cxk + nx2) * 0.5,
            roadY((cxk + nx2) * 0.5, (czk + nz2) * 0.5, F, noise) + 0.016,
            (czk + nz2) * 0.5, 0, -ang + Math.PI * 0.5, 0, 0.006);
          ck.paint = 'flat'; ck.dark = rng.range(0.5, 0.75);
          cxk = nx2; czk = nz2;
          ang += rng.range(-0.55, 0.55);
        }
      }
    }
  }

  // Kerb + paving. Instanced because there are hundreds of them and each wants
  // its own tiny height/rotation error - a perfectly straight kerb reads CAD.
  function buildKerbsAndPaving(L, rng, noise) {
    var z0 = Z_SOUTH + 6.0, z1 = Z_NORTH - 7.0;
    var len = z0 - z1;
    var kerbLen = 0.92;
    var nk = Math.floor(len / kerbLen);
    // Own geometry, not the shared build cache: the caches are disposed once
    // construction finishes, and these two meshes outlive that.
    var kg = extrudeProfile(KERBSTONE, kerbLen - 0.015);
    Geo.worldUV(kg, SURF.concrete.uv); Geo.copyUV1(kg);
    var km = L.material('concrete', true);
    var kerb = new THREE.InstancedMesh(kg, km, nk * 2);
    kerb.castShadow = true; kerb.receiveShadow = true;
    kerb.name = 'kerbstones';
    var mtx = new THREE.Matrix4(), col = new THREE.Color();
    var i, side, n = 0;
    for (side = -1; side <= 1; side += 2) {
      for (i = 0; i < nk; i++) {
        var z = z0 - (i + 0.5) * kerbLen;
        var y = KERB_H - 0.16 + rng.range(-0.011, 0.011);
        var x = side * (STREET_HALF + 0.16) + rng.range(-0.012, 0.012);
        mtx.makeRotationFromEuler(_e1.set(rng.range(-0.012, 0.012), Math.PI * 0.5,
          rng.range(-0.02, 0.02) * side, 'YXZ'));
        mtx.elements[12] = x; mtx.elements[13] = y; mtx.elements[14] = z;
        kerb.setMatrixAt(n, mtx);
        var g = rng.range(0.72, 1.0);
        col.setRGB(g * 1.02, g * 0.98, g * 0.92);
        kerb.setColorAt(n, col);
        n++;
      }
    }
    kerb.instanceMatrix.needsUpdate = true;
    if (kerb.instanceColor) kerb.instanceColor.needsUpdate = true;
    L.root.add(kerb);
    L.instanced.push(kerb);

    // paving slabs, two courses per side
    var slabZ = 1.02, slabX = 0.92;
    var ns = Math.floor(len / slabZ);
    var pgSrc = Geo.bevelBox(slabX, 0.14, slabZ - 0.03, 0.014);
    var pg = pgSrc.toNonIndexed(); pgSrc.dispose();
    Geo.worldUV(pg, SURF.concrete.uv); Geo.copyUV1(pg);
    var pm = L.material('concrete', true);
    var pav = new THREE.InstancedMesh(pg, pm, ns * 4);
    pav.castShadow = false; pav.receiveShadow = true;
    pav.name = 'paving';
    n = 0;
    for (side = -1; side <= 1; side += 2) {
      for (var row = 0; row < 2; row++) {
        for (i = 0; i < ns; i++) {
          var pz = z0 - (i + 0.5) * slabZ;
          var px = side * (STREET_HALF + 0.34 + row * (slabX + 0.035));
          var settle = noise.fbm2(px * 0.4, pz * 0.4, 3) * 0.016;
          mtx.makeRotationFromEuler(_e1.set(rng.range(-0.018, 0.018), 0, rng.range(-0.018, 0.018), 'YXZ'));
          mtx.elements[12] = px + rng.range(-0.01, 0.01);
          mtx.elements[13] = KERB_H - 0.07 + settle;
          mtx.elements[14] = pz;
          pav.setMatrixAt(n, mtx);
          // grime rises toward the wall, traffic polishes the kerb edge
          var wear = row === 0 ? 1.0 : 0.9;
          var gg = rng.range(0.72, 1.0) * wear;
          col.setRGB(gg * 1.03, gg * 0.99, gg * 0.9);
          pav.setColorAt(n, col);
          n++;
        }
      }
    }
    pav.instanceMatrix.needsUpdate = true;
    if (pav.instanceColor) pav.instanceColor.needsUpdate = true;
    L.root.add(pav);
    L.instanced.push(pav);
  }

  // Sand drifted into every corner: a wedge strip along the kerb and the wall
  // bases. This is the single cheapest way to stop the ground/wall junction
  // reading as two boxes intersecting.
  function buildSandDrift(B, rng, noise) {
    var z0 = Z_SOUTH + 5, z1 = Z_NORTH - 6;
    var seg = 1.6;
    var n = Math.floor((z0 - z1) / seg);
    for (var side = -1; side <= 1; side += 2) {
      for (var i = 0; i < n; i++) {
        var z = z0 - (i + 0.5) * seg;
        // The gutter wedge is CONTINUOUS: skipping the low segments left the
        // road/kerb junction as a clean intersection of two boxes for metres at
        // a time, which is the one place a street never has a hard edge.
        var amt = Math.max(0.16, M.saturate(noise.fbm2(z * 0.16, side * 3.7, 3) * 0.5 + 0.62));
        // in the gutter
        var w = 0.35 + amt * 0.75;
        B.boxR('sand', w, 0.045 + amt * 0.05, seg + 0.05,
          side * (STREET_HALF - w * 0.45), -0.16 + amt * 0.02, z,
          0, 0, side * 0.09, 0.02).dark = rng.range(0, 0.1);
        // against the facade
        if (amt > 0.4) {
          var w2 = 0.3 + amt * 0.6;
          B.boxR('sand', w2, 0.05 + amt * 0.07, seg + 0.05,
            side * (FACADE_X - w2 * 0.45), KERB_H + 0.01, z,
            0, 0, -side * 0.16, 0.02).dark = rng.range(0, 0.12);
        }
      }
    }
  }

  function buildSidewalkBase(B) {
    // the slab the paving sits on, and the kerb face, as one continuous mass
    for (var side = -1; side <= 1; side += 2) {
      B.box('concrete', FACADE_X - STREET_HALF, 0.5,
        (Z_SOUTH + 6) - (Z_NORTH - 7),
        side * (FACADE_X + STREET_HALF) * 0.5, KERB_H - 0.25 - 0.02,
        ((Z_SOUTH + 6) + (Z_NORTH - 7)) * 0.5, 0.02).paint = 'ground';
    }
  }

  // ============================================================ TERMINATORS ==
  // Cross-blocks close both ends of the street. The north one carries a deep
  // arched passage: it is the vanishing point of the hero shot, so it gets a
  // real arch and a glowing tunnel rather than a flat wall.
  function buildTerminator(L, B, rng, north) {
    var z = north ? Z_NORTH : Z_SOUTH;
    var depth = north ? 6.5 : 6.0;
    var facing = north ? 'pz' : 'mz';
    var xL = -19, xR = 21, W = xR - xL;
    var floors = north ? [4.4, 3.4] : [3.9, 3.2, 3.0];
    var totalH = 0, i;
    for (i = 0; i < floors.length; i++) totalH += floors[i];
    var blk = { id: north ? 'NT' : 'ST', side: 'W', zS: z, zN: z, floors: floors,
      bays: 12, ground: 'window', depth: depth, hue: north ? 0xc7b193 : 0xd2bd9a,
      damage: north ? 0.6 : 0.35 };
    var S = makeSpec(blk, rng);
    S.width = W;
    S.bays = 12;

    var pw = north ? 4.5 : 4.8;
    var pcWorld = north ? -0.25 : 0.2;
    // local x of the passage centre
    var pcx = north ? (pcWorld - xL) : (xR - pcWorld);
    var origin = north ? xL : xR;

    B.tint = S.plasterTint;
    B.push(facadeOrient(facing, origin, 0, z));

    // Backdrop, split around the passage: the tunnel must stay see-through or
    // the vanishing point of the whole street turns into a painted wall.
    var bpL = pcx - pw * 0.5 - 0.35, bpR = pcx + pw * 0.5 + 0.35;
    B.dark = 0.78;
    B.box('backdrop', bpL, totalH + 1.3, 0.25, bpL * 0.5, (totalH + 1.3) * 0.5 - 0.65, -1.28, 0.01);
    B.box('backdrop', W - bpR, totalH + 1.3, 0.25, (W + bpR) * 0.5, (totalH + 1.3) * 0.5 - 0.65, -1.28, 0.01);
    B.box('backdrop', bpR - bpL, totalH + 1.3 - floors[0], 0.25, (bpL + bpR) * 0.5,
      floors[0] + (totalH + 1.3 - floors[0]) * 0.5 - 0.65, -1.28, 0.01);
    B.dark = 0;

    var y = 0;
    for (var f = 0; f < floors.length; f++) {
      var h = floors[f];
      var nb = 13;
      for (i = 0; i < nb; i++) {
        var x0 = W * i / nb, x1 = W * (i + 1) / nb;
        var overlapsArch = (x1 > pcx - pw * 0.5 - 0.3) && (x0 < pcx + pw * 0.5 + 0.3);
        if (f === 0 && overlapsArch) continue;
        if (f === 0) windowBay(B, x0, x1, y, h, rng, S, { tall: true });
        else windowBay(B, x0, x1, y, h, rng, S, {});
      }
      if (f === 0) {
        // wall either side of the passage plus the arch head
        wallRect(B, pcx - pw * 0.5 - 0.3, y, pcx - pw * 0.5, y + h, rng, S);
        wallRect(B, pcx + pw * 0.5, y, pcx + pw * 0.5 + 0.3, y + h, rng, S);
        archOpening(B, pcx, y, pw, h - pw * 0.5 - 0.35, WALL_T, S);
      }
      y += h;
    }
    crown(B, W, totalH, rng, S);
    B.pop();
    B.tint = null;

    // solid mass, split around the passage
    var mzC = north ? z - depth * 0.5 - 0.4 : z + depth * 0.5 + 0.4;
    var pL = pcWorld - pw * 0.5, pR = pcWorld + pw * 0.5;
    var pieces = [[xL, pL], [pR, xR]];
    B.tint = S.plasterTint; B.dark = 0.06;
    for (i = 0; i < 2; i++) {
      var w = pieces[i][1] - pieces[i][0];
      B.box('concrete_wall', w, totalH, depth, (pieces[i][0] + pieces[i][1]) * 0.5,
        totalH * 0.5, mzC, 0.02);
      L.addCollider((pieces[i][0] + pieces[i][1]) * 0.5, totalH * 0.5, mzC,
        w * 0.5, totalH * 0.5, depth * 0.5, 'plaster');
    }
    // ceiling of the passage
    var ph = floors[0] - pw * 0.5 - 0.35 + pw * 0.5;
    B.box('concrete_wall', pw, totalH - ph, depth, pcWorld, ph + (totalH - ph) * 0.5, mzC, 0.02);
    B.dark = 0; B.tint = null;
    L.addCollider(pcWorld, ph + (totalH - ph) * 0.5, mzC, pw * 0.5, (totalH - ph) * 0.5, depth * 0.5, 'concrete');
    // passage side walls, lit only by the far end - a dark frame around bright fog
    B.dark = 0.5;
    for (i = -1; i <= 1; i += 2) {
      B.box('plaster', 0.25, ph, depth, pcWorld + i * (pw * 0.5 + 0.12), ph * 0.5, mzC, 0.012);
    }
    B.box('concrete', pw + 0.5, 0.35, depth, pcWorld, ph + 0.17, mzC, 0.014);
    B.dark = 0;
  }

  // ============================================== COURTYARD + EXTERNAL STAIR ==
  // The gap between W2 and W3. It admits a shaft across the street and carries
  // the stair that makes the rooftop genuinely reachable.
  function buildCourtyard(L, B, rng) {
    var zS = -4.0, zN = -8.4, xBack = -19.0;
    var i;
    // floor
    B.box('concrete', FACADE_X + xBack * -1 - FACADE_X + 12.0, 0.4, zS - zN,
      (xBack + (-FACADE_X)) * 0.5, KERB_H - 0.2, (zS + zN) * 0.5, 0.02).paint = 'ground';
    L.addCollider((xBack - FACADE_X) * 0.5, KERB_H - 0.2, (zS + zN) * 0.5,
      6.0, 0.2, (zS - zN) * 0.5, 'concrete', true);
    // back wall
    B.tint = tint(0xc2b49a, 0.6);
    B.box('plaster', 0.4, 9.6, zS - zN + 0.2, xBack - 0.2, 4.8, (zS + zN) * 0.5, 0.02);
    B.tint = null;
    L.addCollider(xBack - 0.2, 4.8, (zS + zN) * 0.5, 0.2, 4.8, (zS - zN) * 0.5 + 0.1, 'plaster');

    // three flights climbing the north wall to W3's roof at y = 9.0
    var wall = zN + 0.9;                  // stair centre-line, hard against W3
    var y0 = KERB_H;
    B.push(makeM(0, 0, wall, 0, Math.PI * 0.5, 0));   // local +X -> world -Z? see note
    B.pop();
    // Flights are authored directly in world space: x runs along the flight,
    // z is the tread width. Simpler than another local frame for three runs.
    var runs = [
      { x0: -8.2, dir: -1, steps: 10, rise: 0.295, run: 0.44, y: y0 },
      { x0: -13.0, dir: 1, steps: 10, rise: 0.295, run: 0.44, y: y0 + 2.95 },
      { x0: -8.2, dir: -1, steps: 10, rise: 0.31, run: 0.44, y: y0 + 5.9 }
    ];
    var width = 1.5;
    B.push(makeM(0, 0, wall));
    for (i = 0; i < runs.length; i++) {
      var r = runs[i];
      stairFlight(B, r.x0, r.y, r.dir, r.steps, r.rise, r.run, width);
      var len = r.steps * r.run, h = r.steps * r.rise;
      L.addCollider(r.x0 + r.dir * len * 0.5, r.y + h * 0.5 + 0.12, wall,
        len * 0.5, 0.28, width * 0.5, 'concrete', true,
        new THREE.Euler(0, 0, -r.dir * Math.atan2(h, len), 'YXZ'));
      // landing at the top of each flight
      var lx = r.x0 + r.dir * (len + 0.55);
      B.box('concrete', 1.4, 0.24, width, lx, r.y + h - 0.12, 0, 0.014);
      L.addCollider(lx, r.y + h - 0.12, wall, 0.7, 0.12, width * 0.5, 'concrete', true);
    }
    // railing along the outer edge of the run
    for (i = 0; i < 3; i++) {
      var rr = runs[i], rl = rr.steps * rr.run, rh2 = rr.steps * rr.rise;
      B.boxR('rusted_metal', Math.sqrt(rl * rl + rh2 * rh2), 0.045, 0.045,
        rr.x0 + rr.dir * rl * 0.5, rr.y + rh2 * 0.5 + 0.98, wall - width * 0.5 + 0.06,
        0, 0, -rr.dir * Math.atan2(rh2, rl), 0.008);
      for (var p = 0; p < 6; p++) {
        var t = (p + 0.5) / 6;
        B.box('rusted_metal', 0.032, 1.0, 0.032, rr.x0 + rr.dir * rl * t,
          rr.y + rh2 * t + 0.5, wall - width * 0.5 + 0.06, 0.006);
      }
    }
    B.pop();
    // parapet doorway from the top landing onto the roof
    B.box('concrete', 0.3, 2.1, 1.2, -13.6, 9.0 + 1.05, wall, 0.014);
  }

  // ==================================================== ALLEY + FIRE ESCAPE ==
  function buildAlley(L, B, rng, noise) {
    var zS = -3.0, zN = -6.7, xEnd = 20.8;
    var i;
    // Same reasoning as the flanks: nothing here is ever in sun, so the slab
    // carries a lifted albedo or the whole lower half of the framing is black.
    B.tint = PAVE_LIFT;
    B.box('concrete', xEnd - FACADE_X, 0.4, zS - zN,
      (FACADE_X + xEnd) * 0.5, KERB_H - 0.2, (zS + zN) * 0.5, 0.02).paint = 'ground';
    B.tint = null;
    L.addCollider((FACADE_X + xEnd) * 0.5, KERB_H - 0.2, (zS + zN) * 0.5,
      (xEnd - FACADE_X) * 0.5, 0.2, (zS - zN) * 0.5, 'concrete', true);

    // ---- the art direction's WET PATCH ------------------------------------
    // It used to be a dry matte slab of concrete darkened 34%: no roughness
    // change, no reflection, a hard rectangular outline. Standing water is the
    // one thing in a shadowed alley that carries the sky, so it gets its own
    // near-mirror surface and an organic outline, feathered with two smaller
    // overlapping films at the margin where it is drying out.
    var wetC = [[11.5, -4.85, 1.42, 0.86], [10.35, -4.15, 0.72, 0.72],
                [12.45, -5.5, 0.62, 0.9], [9.55, -5.35, 0.44, 0.8]];
    for (i = 0; i < wetC.length; i++) {
      var wp = wetC[i];
      var we = B.add('wet', blobDisc(rng, wp[2], wp[3], i === 0 ? 0.30 : 0.44),
        makeM(wp[0], KERB_H + 0.004 + i * 0.0015, wp[1], 0, rng.range(0, 6.283), 0));
      we.paint = 'flat';
      we.tint = tint(0x9fb0bd, 0.5);
      we.dark = i === 0 ? 0.30 : rng.range(0.42, 0.6);
      L.wetPatches.push({ x: wp[0], z: wp[1], r: wp[2] });
    }
    // silt ring the water has dried back from
    for (i = 0; i < 3; i++) {
      var se = B.add('sand', blobDisc(rng, rng.range(0.8, 1.7), rng.range(0.7, 1.1), 0.5),
        makeM(rng.range(9.4, 12.9), KERB_H + 0.0015, rng.range(-5.7, -3.9),
          0, rng.range(0, 6.283), 0));
      se.paint = 'flat';
      se.dark = rng.range(0.28, 0.5);
    }
    // Cast-iron gully at the low point, seated in a haunching of concrete.
    B.tint = PAVE_LIFT;
    B.box('concrete', 0.62, 0.09, 0.84, 11.5, KERB_H - 0.03, -4.85, 0.012).dark = 0.2;
    for (i = 0; i < 7; i++) {
      B.box('rusted_metal', 0.44, 0.045, 0.05, 11.5, KERB_H + 0.012,
        -5.16 + i * 0.104, 0.006).dark = rng.range(0.1, 0.32);
    }
    B.box('rusted_metal', 0.52, 0.05, 0.06, 11.5, KERB_H + 0.008, -4.44, 0.008);
    B.box('rusted_metal', 0.52, 0.05, 0.06, 11.5, KERB_H + 0.008, -5.26, 0.008);
    // The alley falls to that gully: a shallow channel of dished paving so the
    // floor is not a dead-flat plane the width of the framing.
    for (i = 0; i < 7; i++) {
      B.boxR('concrete', rng.range(0.9, 1.5), 0.035, 0.9,
        8.4 + i * 1.65, KERB_H - 0.012, -4.85 + rng.range(-0.35, 0.35),
        0, rng.range(-0.1, 0.1), rng.range(-0.03, 0.03), 0.014).dark = rng.range(0.1, 0.3);
    }
    // Kerb step across the mouth - the alley sits a course above the pavement.
    for (i = 0; i < 4; i++) {
      B.boxR('concrete', 0.34, 0.11, 0.95, 7.05 + rng.range(-0.02, 0.02),
        KERB_H + 0.05, -3.35 - i * 0.92, 0, rng.range(-0.02, 0.02),
        rng.range(-0.02, 0.02), 0.012).dark = rng.range(0, 0.16);
    }
    B.tint = null;

    // dead-end wall, blank, with the alley's one bright shaft landing on it
    B.tint = LIMEWASH;
    B.box('plaster', 0.45, 11.0, zS - zN + 0.6, xEnd + 0.22, 5.5, (zS + zN) * 0.5, 0.02);
    B.tint = null;
    L.addCollider(xEnd + 0.22, 5.5, (zS + zN) * 0.5, 0.22, 5.5, (zS - zN) * 0.5 + 0.3, 'plaster');

    // ---- south wall (z = -3.0) service run, dead in the alley framing -----
    // Two soil stacks with hopper heads and a low conduit: vertical pipes at
    // two different diameters are what turn a blank rendered flank into a back
    // elevation, and they are almost free.
    var wS = zS - WALL_OUT - 0.02;
    for (i = 0; i < 2; i++) {
      var sx2 = [12.4, 16.1][i], sh2 = [7.2, 6.4][i];
      B.cyl('rusted_metal', 0.058, 0.058, sh2, sx2, KERB_H + sh2 * 0.5, wS - 0.09, 0, 0, 0, 8);
      for (var bq = 0; bq < Math.floor(sh2 / 1.5); bq++) {
        B.box('rusted_metal', 0.17, 0.05, 0.10, sx2, KERB_H + 0.7 + bq * 1.5, wS - 0.05, 0.008);
      }
      // hopper head
      B.cyl('rusted_metal', 0.125, 0.075, 0.3, sx2, KERB_H + sh2 - 0.1, wS - 0.09, 0, 0, 0, 8);
      // shoe discharging onto the paving, and the stain it has left
      B.boxR('rusted_metal', 0.10, 0.36, 0.10, sx2, KERB_H + 0.2, wS - 0.17, 0.5, 0, 0, 0.008);
      L.streaks.push({ p: new THREE.Vector3(sx2, KERB_H + sh2 * 0.55, wS), r: 1.3 });
      var pe = B.add('wet', blobDisc(rng, 0.42, 0.8, 0.5),
        makeM(sx2, KERB_H + 0.005, wS - 0.3, 0, rng.range(0, 6.283), 0));
      pe.paint = 'flat'; pe.dark = 0.5; pe.tint = tint(0x8f9aa2, 0.5);
    }
    // a low cable run stapled along the wall at head height
    B.box('rusted_metal', 8.6, 0.045, 0.045, 13.6, KERB_H + 2.35, wS - 0.06, 0.008);
    for (i = 0; i < 7; i++) {
      B.box('rusted_metal', 0.05, 0.13, 0.09, 9.6 + i * 1.35, KERB_H + 2.27, wS - 0.03, 0.006);
    }
    B.boxR('rusted_metal', 0.045, 1.6, 0.045, 18.0, KERB_H + 1.6, wS - 0.06,
      0, 0, 0.03, 0.008);
    // a window AC condenser on the same wall, dripping
    B.box('rusted_metal', 0.66, 0.05, 0.44, 14.9, KERB_H + 3.05, wS - 0.22, 0.008);
    B.box('painted_metal', 0.6, 0.42, 0.38, 14.9, KERB_H + 3.3, wS - 0.21, 0.012)
      .tint = tint(0xb0aca4, 0.7);
    for (i = -1; i <= 1; i += 2) {
      B.boxR('rusted_metal', 0.03, 0.52, 0.03, 14.9 + i * 0.26, KERB_H + 2.85, wS - 0.2,
        -0.7, 0, 0, 0.006);
    }
    B.cyl('rubber', 0.02, 0.02, 0.9, 15.12, KERB_H + 2.6, wS - 0.07, 0, 0, 0.06, 5).paint = 'flat';
    L.streaks.push({ p: new THREE.Vector3(14.9, KERB_H + 2.9, wS), r: 1.1 });

    // ---- back-of-house doors and boxes on both flanks ----------------------
    // The published alley pose puts two 11 m walls across 70% of the frame, so
    // whatever is on them IS the shot. A blank rendered flank with one fire
    // escape is not a back elevation; these are the things that are always on
    // one, they sit at eye height where the camera actually looks, and they
    // cost a few hundred triangles between them.
    var nW = zN + WALL_OUT + 0.02;                 // inner face of E3's flank
    // steel back door in a rebated frame, with its step and its kick plate
    for (var dd = 0; dd < 2; dd++) {
      var dX = [17.55, 11.3][dd];
      var dZ = dd ? nW : wS, dS = dd ? 1 : -1;
      B.tint = PAVE_LIFT;
      B.box('concrete', 1.32, 2.24, 0.13, dX, KERB_H + 1.12, dZ + dS * 0.06, 0.012)
        .dark = 0.06;
      B.tint = null;
      // Faded paint, lifted well above the library's dark gunmetal base: these
      // sit in permanent shade, and at the library's own value they rendered as
      // two black rectangles cut out of the wall.
      B.box('painted_metal', 1.0, 2.06, 0.06, dX, KERB_H + 1.03, dZ + dS * 0.13, 0.008)
        .tint = dd ? DOOR_G : DOOR_R;
      B.box('rusted_metal', 1.0, 0.22, 0.03, dX, KERB_H + 0.14, dZ + dS * 0.17, 0.006);
      B.box('rusted_metal', 0.05, 0.16, 0.05, dX + 0.38, KERB_H + 1.02, dZ + dS * 0.19, 0.008);
      B.box('concrete', 1.5, 0.10, 0.34, dX, KERB_H + 0.05, dZ + dS * 0.2, 0.012)
        .dark = rng.range(0.1, 0.3);
      L.streaks.push({ p: new THREE.Vector3(dX, KERB_H + 2.2, dZ), r: 1.1 });
    }
    // meter cupboard, isolator and the conduit dropping to it
    B.box('painted_metal', 0.46, 0.62, 0.24, 9.6, KERB_H + 1.55, wS - 0.13, 0.012)
      .tint = tint(0x8d9184, 0.8);
    B.box('rusted_metal', 0.5, 0.06, 0.28, 9.6, KERB_H + 1.89, wS - 0.14, 0.008);
    B.cyl('rusted_metal', 0.026, 0.026, 1.3, 9.6, KERB_H + 0.6, wS - 0.05, 0, 0, 0, 6);
    B.box('painted_metal', 0.2, 0.28, 0.14, 10.15, KERB_H + 1.6, wS - 0.08, 0.01)
      .tint = tint(0x6f6a5e, 0.85);
    // bricked-up arch on the north flank: a real back elevation always has one
    B.box('concrete', 1.5, 0.14, 0.16, 19.4, KERB_H + 2.35, nW + 0.07, 0.012);
    B.box('brick', 1.24, 2.2, 0.1, 19.4, KERB_H + 1.2, nW + 0.05, 0.01).dark = 0.14;
    for (i = 0; i < 5; i++) {
      B.boxR('plaster', rng.range(0.14, 0.34), rng.range(0.1, 0.28), 0.05,
        19.4 + rng.range(-0.6, 0.6), KERB_H + rng.range(0.3, 2.2), nW + 0.09,
        0, 0, rng.range(-0.4, 0.4), 0.006).dark = rng.range(0.05, 0.2);
    }
    // louvred vent + its stained render below
    B.box('concrete', 0.86, 0.1, 0.14, 15.0, KERB_H + 2.72, nW + 0.06, 0.01);
    B.box('rusted_metal', 0.7, 0.56, 0.07, 15.0, KERB_H + 2.4, nW + 0.06, 0.008).dark = 0.1;
    for (i = 0; i < 5; i++) {
      B.boxR('rusted_metal', 0.68, 0.055, 0.06, 15.0, KERB_H + 2.18 + i * 0.115,
        nW + 0.10, 0.35, 0, 0, 0.005);
    }
    L.streaks.push({ p: new THREE.Vector3(15.0, KERB_H + 2.2, nW), r: 1.3 });
    // a low conduit run and two junction boxes along the north flank
    B.box('rusted_metal', 7.2, 0.04, 0.04, 16.4, KERB_H + 1.72, nW + 0.05, 0.006);
    for (i = 0; i < 5; i++) {
      B.box('rusted_metal', 0.045, 0.11, 0.08, 13.3 + i * 1.55, KERB_H + 1.66, nW + 0.03, 0.006);
    }

    // ---- sand drifted into all four corners -------------------------------
    var corners = [[7.6, zS - 0.35], [7.6, zN + 0.35], [xEnd - 0.6, zS - 0.35],
                   [xEnd - 0.6, zN + 0.35], [13.0, zS - 0.28], [17.4, zN + 0.3]];
    for (i = 0; i < corners.length; i++) {
      var cn = corners[i];
      var sgn = cn[1] > (zS + zN) * 0.5 ? 1 : -1;
      B.boxR('sand', rng.range(0.9, 2.0), rng.range(0.07, 0.13), rng.range(0.35, 0.7),
        cn[0] + rng.range(-0.3, 0.3), KERB_H + 0.02, cn[1] + rng.range(-0.12, 0.12),
        sgn * 0.22, rng.range(-0.12, 0.12), rng.range(-0.05, 0.05), 0.02)
        .dark = rng.range(0, 0.14);
    }

    // fire escape on the north wall (E3's flank), zig-zagging up four storeys
    var wz = zN + 0.28;
    B.push(makeM(0, 0, wz));
    var lvl, y = 2.9;
    for (lvl = 0; lvl < 3; lvl++) {
      var lx = 10.6 + (lvl % 2) * 3.0;
      // landing: grating slats over two channel beams
      B.box('rusted_metal', 2.6, 0.05, 1.15, lx, y, 0.6, 0.008);
      for (i = 0; i < 11; i++) {
        B.box('rusted_metal', 2.55, 0.03, 0.045, lx, y + 0.035, 0.09 + i * 0.098, 0.005);
      }
      B.box('rusted_metal', 2.7, 0.14, 0.06, lx, y - 0.07, 1.14, 0.008);
      // railings
      B.cyl('rusted_metal', 0.02, 0.02, 2.7, lx, y + 1.02, 1.14, 0, 0, Math.PI / 2, 6);
      B.cyl('rusted_metal', 0.017, 0.017, 2.7, lx, y + 0.52, 1.14, 0, 0, Math.PI / 2, 6);
      for (i = 0; i < 9; i++) {
        B.box('rusted_metal', 0.022, 1.05, 0.022, lx - 1.28 + i * 0.32, y + 0.52, 1.14, 0.004);
      }
      // brackets back into the wall
      for (i = -1; i <= 1; i += 2) {
        B.boxR('rusted_metal', 0.05, 1.0, 0.05, lx + i * 1.2, y - 0.42, 0.55, -0.9, 0, 0, 0.008);
      }
      // the flight down to the level below
      var dirs = (lvl % 2) ? -1 : 1;
      var sl = 2.55, sh = y - (lvl === 0 ? 0.15 : y - 2.9);
      var fh = lvl === 0 ? (y - 0.15) : 2.9;
      B.boxR('rusted_metal', Math.sqrt(sl * sl + fh * fh), 0.1, 0.92,
        lx + dirs * 1.5, y - fh * 0.5, 0.55, 0, 0, -dirs * Math.atan2(fh, sl), 0.008);
      for (i = 0; i < 9; i++) {
        var t = (i + 0.5) / 9;
        B.box('rusted_metal', 0.24, 0.03, 0.86, lx + dirs * (0.3 + t * sl),
          y - fh * t + 0.055, 0.55, 0.006);
      }
      y += 2.9;
    }
    // ladder to the roof
    for (i = 0; i < 14; i++) {
      B.cyl('rusted_metal', 0.016, 0.016, 0.42, 13.6, y - 2.9 + i * 0.3, 0.42, 0, 0, Math.PI / 2, 5);
    }
    B.cyl('rusted_metal', 0.024, 0.024, 4.4, 13.39, y - 2.9 + 2.0, 0.42, 0, 0, 0, 6);
    B.cyl('rusted_metal', 0.024, 0.024, 4.4, 13.81, y - 2.9 + 2.0, 0.42, 0, 0, 0, 6);
    B.pop();
    L.addCollider(11.9, 2.9, wz + 0.6, 2.9, 0.06, 0.6, 'metal', true);

    // cables and a lamp bracket over the alley mouth
    B.boxR('rusted_metal', 0.06, 1.5, 0.06, 7.4, 4.6, -4.85, 0, 0, -0.9, 0.008);
    B.cyl('painted_metal', 0.16, 0.22, 0.24, 8.3, 4.2, -4.85, Math.PI, 0, 0, 10);

    // ---- the art direction's ONE SHAFT OF LIGHT ---------------------------
    // level.js cannot draw a volumetric beam - that belongs to postfx and to
    // the lighting rig - but it CAN say where the beam has to be, which is the
    // half of the job nobody else can do. Published defensively: a consumer
    // that ignores lightShafts costs exactly nothing.
    // Direction of TRAVEL, taken off the real sun vector when the sky exists
    // so the beam can never disagree with the shadows in the same frame.
    var sd = new THREE.Vector3(0.06, 0.32, -0.945);
    try {
      if (L.ctx && L.ctx.sky && L.ctx.sky.sunDirection &&
          L.ctx.sky.sunDirection.lengthSq() > 0.2) sd.copy(L.ctx.sky.sunDirection);
    } catch (e) { /* the fallback rake is fine */ }
    var travel = sd.clone().multiplyScalar(-1).normalize();
    L.lightShafts.push({
      // over the E3 parapet at the alley, landing high on the south flank
      origin: new THREE.Vector3(13.6, 8.4, -6.5),
      dir: travel, width: 3.2, length: 10.0, strength: 1.0, kind: 'alley'
    });
  }

  // ========================================================= SHOP INTERIOR ==
  // The gutted shop in W2. Lit by three street openings, a courtyard window,
  // and a shell hole punched clean through two floors and the roof - that
  // vertical shaft is the whole point of the interior framing.
  function buildShopInterior(L, B, rng) {
    var x0 = -14.8, x1 = -7.0, z0 = -3.7, z1 = 5.6;
    var fy = 0.16, ceil = 4.0, roofY = 7.25;
    var sh = { x0: -13.0, x1: -10.6, z0: 1.4, z1: 3.8 };
    var i, R;

    // ---- floor -------------------------------------------------------------
    // One tiled plane across the whole room gave a perfect uniform grid with
    // identical grout lines edge to edge - the single most placeholder-looking
    // thing in the hero interior framing. Instead: a screed slab, then four
    // tiled regions each with its own UV rotation and origin so the grout
    // lattice BREAKS at the region joints, a scatter of individual tiles lifted
    // and skewed where the slab has heaved, and a patch missing altogether.
    B.paint = 'ground';
    B.box('concrete', x1 - x0, 0.30, z1 - z0, (x0 + x1) * 0.5, fy - 0.17, (z0 + z1) * 0.5, 0.014);
    var bare = { x0: -12.55, x1: -11.15, z0: 2.05, z1: 3.55 };   // screed showing
    var regions = [
      { x0: x0, x1: -11.6, z0: z0, z1: 1.35, rot: 0.0 },
      { x0: -11.6, x1: x1, z0: z0, z1: 1.35, rot: 1.5708 },
      { x0: x0, x1: -10.4, z0: 1.35, z1: z1, rot: 0.20 },
      { x0: -10.4, x1: x1, z0: 1.35, z1: z1, rot: 1.42 }
    ];
    for (i = 0; i < regions.length; i++) {
      R = regions[i];
      var sub = subtractRect(R.x0, R.x1, R.z0, R.z1, bare.x0, bare.x1, bare.z0, bare.z1);
      for (var q3 = 0; q3 < sub.length; q3++) {
        var Q = sub[q3];
        var fe2 = B.box('tile', Q[1] - Q[0], 0.024, Q[3] - Q[2],
          (Q[0] + Q[1]) * 0.5, fy - 0.012, (Q[2] + Q[3]) * 0.5, 0.006);
        fe2.uvRot = R.rot;
        fe2.uvOff = [i * 0.37, i * 0.61];
        fe2.dark = rng.range(0.02, 0.14);
      }
    }
    // heaved / lifted individual tiles - the grout lines stop being straight
    for (i = 0; i < 14; i++) {
      var tx2 = rng.range(x0 + 0.4, x1 - 0.4), tz2 = rng.range(z0 + 0.4, z1 - 0.4);
      if (tx2 > bare.x0 - 0.2 && tx2 < bare.x1 + 0.2 && tz2 > bare.z0 - 0.2 && tz2 < bare.z1 + 0.2) continue;
      var lt = B.boxR('tile', rng.range(0.26, 0.34), 0.022, rng.range(0.26, 0.34),
        tx2, fy - 0.011 + rng.range(0.003, 0.008), tz2,
        rng.range(-0.05, 0.05), rng.range(-0.5, 0.5), rng.range(-0.05, 0.05), 0.005);
      lt.uvRot = rng.range(0, 3.14);
      lt.uvOff = [rng.range(0, 4), rng.range(0, 4)];
      lt.dark = rng.range(0.05, 0.3);
    }
    // debris fringe around the bare screed patch
    for (i = 0; i < 20; i++) {
      var ba = rng.range(0, 6.283), br2 = rng.range(0.62, 1.15);
      B.boxR(rng.bool(0.6) ? 'tile' : 'concrete', rng.range(0.07, 0.24), rng.range(0.018, 0.05),
        rng.range(0.07, 0.24),
        (bare.x0 + bare.x1) * 0.5 + Math.cos(ba) * br2 * 0.9,
        fy + rng.range(0.005, 0.05),
        (bare.z0 + bare.z1) * 0.5 + Math.sin(ba) * br2 * 1.05,
        rng.range(-0.7, 0.7), rng.range(-1.5, 1.5), rng.range(-0.7, 0.7), 0.006).paint = 'rubble';
    }
    B.paint = 'wall';
    L.addCollider((x0 + x1) * 0.5, fy - 0.16, (z0 + z1) * 0.5,
      (x1 - x0) * 0.5, 0.16, (z1 - z0) * 0.5, 'tile', true);

    B.tint = tint(0xcbb392, 0.5);
    // back wall with a service doorway into a dark store room
    B.box('plaster', 0.32, ceil, (z1 - z0) * 0.5 - 0.55, x0 - 0.16, ceil * 0.5, z0 + ((z1 - z0) * 0.5 - 0.55) * 0.5, 0.014);
    B.box('plaster', 0.32, ceil, (z1 - z0) * 0.5 - 0.55, x0 - 0.16, ceil * 0.5, z1 - ((z1 - z0) * 0.5 - 0.55) * 0.5, 0.014);
    B.box('plaster', 0.32, ceil - 2.15, 1.1, x0 - 0.16, 2.15 + (ceil - 2.15) * 0.5, (z0 + z1) * 0.5, 0.014);
    B.dark = 0.72;
    B.box('backdrop', 2.6, 2.15, 0.2, x0 - 1.4, fy + 1.07, (z0 + z1) * 0.5, 0.01);
    B.dark = 0;
    // ---- south wall: the one the interior framing looks THROUGH -------------
    // From the published pose this wall owns the right third of the frame, and
    // it shipped as a single 8 m box with two hard-edged brick rectangles and
    // one flat black quad stuck to it - measured luminance 0.34 at a standard
    // deviation of 0.13, with an eighth-tile at 0.057. It now carries a blocked-
    // up doorway with a full 0.3 m reveal, a recessed shelf bay at eye level and
    // the shell hole as an actual hole, all cut by pierceWallZ so the wall's own
    // thickness does the work.
    var swZ = z1 + 0.15, swT = 0.30;
    var DOOR_X = [-11.225, -10.175], NICHE_X = [-9.00, -7.70], HOLE_X = [-10.05, -9.15];
    pierceWallZ(B, 'plaster', x0 - 0.2, x1 + 0.2, 0, ceil, swZ, swT, [
      // doorway to the stair, blocked up with reclaimed brick years ago
      { x0: DOOR_X[0], x1: DOOR_X[1], y0: 0, y1: 2.20,
        back: 0.13, backKey: 'brick', dark: 0.22, side: 1 },
      // the shell hole - a void with a lit-ish crawl space behind it, not a decal
      { x0: HOLE_X[0], x1: HOLE_X[1], y0: 1.80, y1: 2.62,
        back: 0.10, backKey: 'backdrop', dark: 0.62, side: 1 },
      // shelf bay at eye level: free depth, and the one place in the room the
      // shopfront light can rake across a stack of horizontals
      { x0: NICHE_X[0], x1: NICHE_X[1], y0: 1.25, y1: 2.35,
        back: 0.09, backKey: 'plaster', dark: 0.26, side: 1 }
    ]);
    // lintels over both openings, and the shelf bay's timber lining + shelves
    B.box('concrete', DOOR_X[1] - DOOR_X[0] + 0.26, 0.13, 0.34,
      (DOOR_X[0] + DOOR_X[1]) * 0.5, 2.265, swZ - 0.02, 0.012);
    B.box('wood_plank', DOOR_X[1] - DOOR_X[0] + 0.10, 0.07, 0.09,
      (DOOR_X[0] + DOOR_X[1]) * 0.5, 2.17, swZ - swT * 0.5 - 0.045, 0.008)
      .tint = tint(0x6b5540, 0.8);
    B.box('concrete', NICHE_X[1] - NICHE_X[0] + 0.20, 0.09, 0.30,
      (NICHE_X[0] + NICHE_X[1]) * 0.5, 2.40, swZ - 0.03, 0.01);
    for (i = 0; i < 4; i++) {
      B.box('wood_plank', NICHE_X[1] - NICHE_X[0] - 0.02, 0.035, 0.19,
        (NICHE_X[0] + NICHE_X[1]) * 0.5, 1.36 + i * 0.34, swZ - 0.115, 0.006)
        .tint = tint(0x6b5540, 0.85);
    }
    // what is left on those shelves: a few boxes and tins, tipped and gappy.
    // A perfectly stocked shelf and an empty one are equally unconvincing.
    for (i = 0; i < 9; i++) {
      var gsx = rng.range(NICHE_X[0] + 0.10, NICHE_X[1] - 0.10);
      var gsy = 1.395 + rng.int(0, 3) * 0.34;
      if (rng.bool(0.45)) {
        B.boxR('painted_metal', rng.range(0.07, 0.12), rng.range(0.11, 0.17),
          rng.range(0.07, 0.12), gsx, gsy + 0.07, swZ - 0.115,
          0, rng.range(-0.5, 0.5), rng.bool(0.2) ? 1.4 : 0, 0.008)
          .tint = tint(rng.pick([0x8a6a3a, 0x5d6350, 0x7a4a3a, 0x9a8f6c]), 0.8);
      } else {
        B.boxR('wood_plank', rng.range(0.16, 0.30), rng.range(0.10, 0.18),
          rng.range(0.10, 0.16), gsx, gsy + 0.07, swZ - 0.12,
          0, rng.range(-0.4, 0.4), rng.range(-0.12, 0.12), 0.008)
          .tint = tint(0x8a7350, 0.8);
      }
    }
    // glazed dado + skirting + cap. A cool tile band under a warm plaster wall
    // is the single cheapest material break this room has, and it sits exactly
    // where the light coming in off the street lands.
    var dadoRuns = [[x0 - 0.2, DOOR_X[0] - 0.045], [DOOR_X[1] + 0.045, x1 + 0.2]];
    for (i = 0; i < 2; i++) {
      var d0 = dadoRuns[i][0], d1 = dadoRuns[i][1];
      if (d1 - d0 < 0.1) continue;
      B.box('tile', d1 - d0, 1.02, 0.05, (d0 + d1) * 0.5, fy + 0.51, swZ - swT * 0.5 - 0.025, 0.006)
        .tint = TILE_DADO;
      B.box('concrete', d1 - d0, 0.055, 0.085, (d0 + d1) * 0.5, fy + 1.05,
        swZ - swT * 0.5 - 0.042, 0.008);
      B.box('concrete', d1 - d0, 0.11, 0.075, (d0 + d1) * 0.5, fy + 0.055,
        swZ - swT * 0.5 - 0.037, 0.008);
    }
    // north wall toward the courtyard, with a high window that cross-lights the room
    B.box('plaster', (x1 - x0) * 0.5 - 0.6, ceil, 0.3, x0 + ((x1 - x0) * 0.5 - 0.6) * 0.5 - 0.2, ceil * 0.5, z0 - 0.15, 0.014);
    B.box('plaster', (x1 - x0) * 0.5 - 0.6, ceil, 0.3, x1 - ((x1 - x0) * 0.5 - 0.6) * 0.5, ceil * 0.5, z0 - 0.15, 0.014);
    B.box('plaster', 1.2, 1.35, 0.3, -10.9, 0.68, z0 - 0.15, 0.014);
    B.box('plaster', 1.2, ceil - 2.85, 0.3, -10.9, 2.85 + (ceil - 2.85) * 0.5, z0 - 0.15, 0.014);
    B.box('concrete', 1.5, 0.08, 0.42, -10.9, 1.35, z0 - 0.08, 0.01);
    // The interior is authored in WORLD space, so the glazing plane has to be
    // named: the north wall's inner face is at z0 - 0.15 + 0.15. Without this
    // the shards used to land at world z = -0.27, 3.6 m adrift and hanging in
    // mid-air in the middle of the room.
    brokenGlass(B, -10.9, 2.1, 1.1, 1.4, rng, z0 - 0.19);
    B.tint = null;
    L.addCollider(x0 - 0.16, ceil * 0.5, (z0 + z1) * 0.5, 0.16, ceil * 0.5, (z1 - z0) * 0.5, 'plaster');
    L.addCollider((x0 + x1) * 0.5, ceil * 0.5, z1 + 0.15, (x1 - x0) * 0.5, ceil * 0.5, 0.15, 'plaster');
    L.addCollider((x0 + x1) * 0.5, ceil * 0.5, z0 - 0.15, (x1 - x0) * 0.5, ceil * 0.5, 0.15, 'plaster');
    // solid remainder of the footprint behind the shop
    B.tint = tint(0xcbb392, 0.4); B.dark = 0.1;
    B.box('concrete_wall', 4.0, ceil, 10.0, -17.0, ceil * 0.5, 1.0, 0.02);
    B.dark = 0; B.tint = null;
    L.addCollider(-17.0, ceil * 0.5, 1.0, 2.0, ceil * 0.5, 5.0, 'concrete');

    // ---- ceiling slab, split around the shell hole ----
    // Was bare 'concrete' with no tint: a downward-facing concrete soffit sees
    // only ground-bounce in the IBL, so it rendered as an unbroken black band
    // across the top third of the hero interior framing - the flat black read
    // ARCHITECTURE 7.6 forbids outright. A shop soffit in this city is
    // limewashed, so it is plaster at near-white value; the SAME light now
    // returns four times the radiance and the ceiling reads as a ceiling.
    //
    // The slit between the slab soffit and the shopfront lintel - which let a
    // wedge of full sunlit exterior through at the top of the wall, and is the
    // bright "missing material" quad in the upper left of interior.png - is
    // closed by the fascia beam below, NOT by pushing the slab out past the
    // facade line, which would hang a 0.2 m stub over the street.
    var CEIL_T = tint(0xe9e0cd, 0.88);
    var cr = subtractRect(x0, x1, z0, z1, sh.x0, sh.x1, sh.z0, sh.z1);
    B.tint = CEIL_T;
    for (i = 0; i < cr.length; i++) {
      R = cr[i];
      B.box('plaster', R[1] - R[0], 0.26, R[3] - R[2],
        (R[0] + R[1]) * 0.5, ceil - 0.13, (R[2] + R[3]) * 0.5, 0.014);
      L.addCollider((R[0] + R[1]) * 0.5, ceil - 0.13, (R[2] + R[3]) * 0.5,
        (R[1] - R[0]) * 0.5, 0.13, (R[3] - R[2]) * 0.5, 'concrete');
    }
    // Downstand beams across the room. A 9 m soffit with nothing on it is a
    // dead plane whatever its value; three beams give it a rhythm, catch a
    // grazing highlight off the shopfront, and read as structure.
    for (i = 0; i < 3; i++) {
      var dbz = z0 + 1.9 + i * 2.5;
      if (dbz > sh.z0 - 0.35 && dbz < sh.z1 + 0.35) continue;
      B.box('plaster', x1 - x0 + 0.2, 0.28, 0.34, (x0 + x1) * 0.5 + 0.1,
        ceil - 0.40, dbz, 0.012);
    }
    // Shopfront fascia: the beam every shop has over its front, closing the
    // head of the opening from inside and giving the bright window band a hard
    // dark edge instead of bleeding into the ceiling.
    B.box('plaster', 0.34, 0.70, z1 - z0 + 0.3, x1 - 0.17, ceil - 0.53,
      (z0 + z1) * 0.5, 0.014);
    B.tint = null;
    // torn rim of the hole + rebar hanging into the room
    for (i = 0; i < 22; i++) {
      var t = i / 22, ex, ez;
      if (i < 11) { ex = M.lerp(sh.x0, sh.x1, (i % 11) / 11); ez = (i < 6) ? sh.z0 : sh.z1; }
      else { ex = (i < 17) ? sh.x0 : sh.x1; ez = M.lerp(sh.z0, sh.z1, ((i - 11) % 6) / 6); }
      B.boxR('concrete', rng.range(0.18, 0.4), rng.range(0.1, 0.26), rng.range(0.18, 0.4),
        ex + rng.range(-0.12, 0.12), ceil - 0.13 + rng.range(-0.1, 0.05), ez + rng.range(-0.12, 0.12),
        rng.range(-0.4, 0.4), rng.range(-0.6, 0.6), rng.range(-0.4, 0.4), 0.012);
    }
    for (i = 0; i < 6; i++) {
      rebar(B, M.lerp(sh.x0, sh.x1, rng.next()), ceil - 0.2, M.lerp(sh.z0, sh.z1, rng.next()),
        rng.range(0.5, 1.0), rng.range(-0.5, 0.5), -1, rng.range(-0.5, 0.5), rng);
    }
    L.scorches.push({ p: new THREE.Vector3((sh.x0 + sh.x1) * 0.5, ceil, (sh.z0 + sh.z1) * 0.5), r: 3.2, k: 0.4 });

    // ---- shaft walls through the first floor ----
    // 0.45 is the floor, not 0.55: these four faces are what the shell-hole
    // shaft is seen against, and crushing them takes the shaft with them.
    B.dark = 0.42;
    B.tint = tint(0xb8a68c, 0.5);
    B.box('plaster', 0.22, roofY - ceil, sh.z1 - sh.z0, sh.x0 - 0.11, (ceil + roofY) * 0.5, (sh.z0 + sh.z1) * 0.5, 0.012);
    B.box('plaster', 0.22, roofY - ceil, sh.z1 - sh.z0, sh.x1 + 0.11, (ceil + roofY) * 0.5, (sh.z0 + sh.z1) * 0.5, 0.012);
    B.box('plaster', sh.x1 - sh.x0 + 0.44, roofY - ceil, 0.22, (sh.x0 + sh.x1) * 0.5, (ceil + roofY) * 0.5, sh.z0 - 0.11, 0.012);
    B.box('plaster', sh.x1 - sh.x0 + 0.44, roofY - ceil, 0.22, (sh.x0 + sh.x1) * 0.5, (ceil + roofY) * 0.5, sh.z1 + 0.11, 0.012);
    B.dark = 0; B.tint = null;

    // ---- roof of W2, holed above the shaft ----
    var rr = subtractRect(-19.0, -7.1, -4.0, 6.0, sh.x0 - 0.3, sh.x1 + 0.3, sh.z0 - 0.3, sh.z1 + 0.3);
    for (i = 0; i < rr.length; i++) {
      R = rr[i];
      B.box('concrete', R[1] - R[0], 0.24, R[3] - R[2], (R[0] + R[1]) * 0.5, roofY - 0.12, (R[2] + R[3]) * 0.5, 0.014);
      var fq = B.box('rooffelt', R[1] - R[0] - 0.06, 0.04, R[3] - R[2] - 0.06,
        (R[0] + R[1]) * 0.5, roofY + 0.02, (R[2] + R[3]) * 0.5, 0.008);
      fq.dark = 0.08; fq.tint = FELT;
      L.addCollider((R[0] + R[1]) * 0.5, roofY - 0.12, (R[2] + R[3]) * 0.5,
        (R[1] - R[0]) * 0.5, 0.12, (R[3] - R[2]) * 0.5, 'concrete', true);
    }
    // roof parapet
    B.tint = tint(0xcbb392, 0.55);
    var pr = [[-19.0, -7.1, 5.75, 6.0], [-19.0, -7.1, -4.0, -3.75], [-19.0, -18.75, -4.0, 6.0]];
    for (i = 0; i < pr.length; i++) {
      R = pr[i];
      B.box('plaster', R[1] - R[0], 0.95, R[3] - R[2], (R[0] + R[1]) * 0.5, roofY + 0.48, (R[2] + R[3]) * 0.5, 0.012);
      B.box('concrete', R[1] - R[0] + 0.14, 0.09, R[3] - R[2] + 0.14, (R[0] + R[1]) * 0.5, roofY + 0.99, (R[2] + R[3]) * 0.5, 0.01);
    }
    B.tint = null;
    for (i = 0; i < 16; i++) {
      var a = rng.range(0, 6.283), rad = rng.range(1.5, 2.6);
      B.boxR('concrete', rng.range(0.12, 0.3), rng.range(0.08, 0.2), rng.range(0.12, 0.3),
        (sh.x0 + sh.x1) * 0.5 + Math.cos(a) * rad, roofY + 0.06, (sh.z0 + sh.z1) * 0.5 + Math.sin(a) * rad,
        rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), 0.01);
    }

    // ---- exposed joists where the ceiling plaster came away ----
    B.tint = tint(0x6b5540, 0.7);
    for (i = 0; i < 7; i++) {
      var jz = z0 + 1.0 + i * 1.15;
      if (jz > sh.z0 - 0.3 && jz < sh.z1 + 0.3) continue;
      B.box('wood_plank', 5.2, 0.2, 0.11, -11.4, ceil - 0.36, jz, 0.01);
    }
    B.tint = null;

    // ---- the shop counter: the interior framing's foreground SUBJECT --------
    // Measured on the shipped frame the two counter tops came back at luminance
    // 0.05-0.07 with a standard deviation of 0.04 - a flat black plane across
    // the whole lower left of a hero framing, which is the first entry on the
    // instant-fail list. Three things were wrong and all three are fixed here:
    //   1. the top was a mid-value GLOSSY tile, and a horizontal surface under a
    //      4 m soffit sees no sky to be glossy about, so it went black. It is
    //      pale terrazzo now, laid in separate slabs with an open joint.
    //   2. the carcass was two extruded boxes. Real shop counters have a
    //      recessed plinth, a panelled face and an open rack on the staff side -
    //      and the camera is standing INSIDE the L, on the staff side, so that
    //      rack is what it is actually looking at.
    //   3. there was nothing standing on it. The window light now falls across a
    //      smashed display case, a set of scales, tins and a scatter of glass.
    var cxA = -10.3, cTopY = fy + 0.99, cH = 0.80;
    var CARC = tint(0xc7b79c, 0.55);
    // -- main leg, running along z at x = cxA, staff side facing -x -----------
    B.tint = CARC;
    B.box('concrete', 0.50, 0.14, 3.24, cxA, fy + 0.07, -0.4, 0.01);        // plinth
    B.box('plaster', 0.21, cH, 3.30, cxA + 0.205, fy + 0.14 + cH * 0.5, -0.4, 0.012);
    B.tint = null;
    // staff-side rack: six dividers, two shelves, a dark liner behind
    B.dark = 0.30;
    B.box('plaster', 0.05, cH - 0.04, 3.26, cxA + 0.075, fy + 0.14 + cH * 0.5, -0.4, 0.008);
    B.dark = 0;
    B.tint = tint(0x6b5540, 0.85);
    for (i = 0; i < 6; i++) {
      B.box('wood_plank', 0.40, cH - 0.04, 0.05, cxA - 0.10,
        fy + 0.14 + cH * 0.5, -2.02 + i * 0.66, 0.008);
    }
    for (i = 0; i < 2; i++) {
      B.box('wood_plank', 0.40, 0.04, 3.26, cxA - 0.10, fy + 0.30 + i * 0.31, -0.4, 0.006);
    }
    B.tint = null;
    // what is still in the rack: ledgers, a stack of trays, a few tins
    for (i = 0; i < 10; i++) {
      var rkz = rng.range(-1.95, 1.15), rky = fy + 0.20 + rng.int(0, 2) * 0.31;
      if (rng.bool(0.5)) {
        B.boxR('wood_plank', 0.30, rng.range(0.10, 0.20), rng.range(0.22, 0.42),
          cxA - 0.10, rky + 0.09, rkz, 0, rng.range(-0.12, 0.12), 0, 0.008)
          .tint = tint(rng.pick([0x8a7350, 0x6f6a58, 0x7a5a3a]), 0.8);
      } else {
        B.cyl('painted_metal', 0.055, 0.055, rng.range(0.11, 0.16),
          cxA - 0.12, rky + 0.09, rkz, 0, 0, 0, 8)
          .tint = tint(rng.pick([0x8a6a3a, 0x5d6350, 0x9a8f6c]), 0.85);
      }
    }
    // -- return leg, running along x at z = -1.9, staff side facing +z --------
    B.tint = CARC;
    B.box('concrete', 1.84, 0.14, 0.50, cxA - 0.95, fy + 0.07, -1.9, 0.01);
    B.box('plaster', 1.90, cH, 0.21, cxA - 0.95, fy + 0.14 + cH * 0.5, -2.105, 0.012);
    B.tint = null;
    B.dark = 0.30;
    B.box('plaster', 1.86, cH - 0.04, 0.05, cxA - 0.95, fy + 0.14 + cH * 0.5, -1.975, 0.008);
    B.dark = 0;
    B.tint = tint(0x6b5540, 0.85);
    for (i = 0; i < 5; i++) {
      B.box('wood_plank', 0.05, cH - 0.04, 0.40, cxA - 1.85 + i * 0.45,
        fy + 0.14 + cH * 0.5, -1.79, 0.008);
    }
    B.box('wood_plank', 1.86, 0.04, 0.40, cxA - 0.95, fy + 0.42, -1.79, 0.006);
    B.tint = null;
    // -- tops: separate slabs with an open joint, a nosing and a back kerb ----
    // Three slabs and two, not one 3.4 m plane: the joints break the specular
    // run, and the 45 mm overhang on the staff side throws the one hard shadow
    // line that tells you the thing has thickness.
    for (i = 0; i < 3; i++) {
      B.box('concrete', 0.76, 0.075, 1.055, cxA - 0.025, cTopY, -1.51 + i * 1.11, 0.008)
        .tint = TERRAZZO;
    }
    for (i = 0; i < 2; i++) {
      B.box('concrete', 0.95, 0.075, 0.76, cxA - 1.42 + i * 0.95, cTopY, -1.925, 0.008)
        .tint = TERRAZZO;
    }
    B.box('concrete', 0.05, 0.035, 3.30, cxA - 0.375, cTopY - 0.052, -0.4, 0.006).dark = 0.22;
    B.box('concrete', 1.90, 0.035, 0.05, cxA - 0.95, cTopY - 0.052, -2.275, 0.006).dark = 0.22;
    B.box('concrete', 0.055, 0.085, 3.30, cxA + 0.29, cTopY + 0.08, -0.4, 0.008)
      .tint = TERRAZZO;                                        // back kerb
    // a cool tile band under the counter lip, matching the wall dado
    B.box('tile', 0.045, 0.15, 3.28, cxA - 0.325, fy + 0.82, -0.4, 0.006).tint = TILE_DADO;
    B.box('tile', 1.88, 0.15, 0.045, cxA - 0.95, fy + 0.82, -2.245, 0.006).tint = TILE_DADO;
    // -- the wreck of a glazed display case on the counter --------------------
    var dcz = 0.35, dcx = cxA - 0.02;
    for (i = 0; i < 4; i++) {
      B.box('painted_metal', 0.032, 0.44, 0.032,
        dcx + (i < 2 ? -0.26 : 0.26), cTopY + 0.26, dcz + ((i & 1) ? -0.52 : 0.52), 0.006)
        .tint = tint(0x6d6a63, 0.85);
    }
    B.box('painted_metal', 0.56, 0.03, 0.03, dcx, cTopY + 0.47, dcz + 0.52, 0.005)
      .tint = tint(0x6d6a63, 0.85);
    B.box('painted_metal', 0.03, 0.03, 1.07, dcx - 0.26, cTopY + 0.47, dcz, 0.005)
      .tint = tint(0x6d6a63, 0.85);
    B.boxR('painted_metal', 0.56, 0.03, 0.9, dcx, cTopY + 0.44, dcz - 0.06, 0.14, 0.05, 0, 0.005)
      .tint = tint(0x6d6a63, 0.85);
    B.box('glass', 0.028, 0.40, 1.02, dcx - 0.26, cTopY + 0.25, dcz, 0.004).paint = 'flat';
    // the front pane is gone; its shards are on the top and on the floor
    for (i = 0; i < 14; i++) {
      var shX = rng.bool(0.55);
      B.boxR('glass', rng.range(0.04, 0.16), 0.006, rng.range(0.04, 0.16),
        shX ? dcx + rng.range(-0.34, 0.34) : cxA - rng.range(0.45, 1.35),
        shX ? cTopY + 0.045 : fy + 0.012,
        shX ? dcz + rng.range(-0.6, 0.6) : rng.range(-1.3, 0.9),
        rng.range(-0.1, 0.1), rng.range(0, 3.14), rng.range(-0.1, 0.1), 0.003).paint = 'flat';
    }
    // a set of brass scales - the one object in the room with a real silhouette
    B.cyl('painted_metal', 0.075, 0.10, 0.045, cxA - 0.05, cTopY + 0.06, -1.45, 0, 0, 0, 10)
      .tint = tint(0x9a7b3a, 0.9);
    B.cyl('painted_metal', 0.016, 0.016, 0.34, cxA - 0.05, cTopY + 0.25, -1.45, 0, 0, 0, 6)
      .tint = tint(0x9a7b3a, 0.9);
    B.boxR('painted_metal', 0.44, 0.014, 0.014, cxA - 0.05, cTopY + 0.42, -1.45, 0, 0, 0.10, 0.004)
      .tint = tint(0x9a7b3a, 0.9);
    for (i = -1; i <= 1; i += 2) {
      B.cyl('painted_metal', 0.085, 0.055, 0.035, cxA - 0.05 + i * 0.21,
        cTopY + 0.42 + i * 0.021 - 0.10, -1.45, 0, 0, 0, 10).tint = tint(0x9a7b3a, 0.9);
      B.boxR('painted_metal', 0.008, 0.10, 0.008, cxA - 0.05 + i * 0.21,
        cTopY + 0.42 + i * 0.021 - 0.05, -1.45, 0, 0, 0, 0.003).tint = tint(0x9a7b3a, 0.9);
    }
    // tins, a ledger and a spilled crate on the top
    for (i = 0; i < 7; i++) {
      B.cyl('painted_metal', 0.048, 0.048, rng.range(0.10, 0.15),
        cxA + rng.range(-0.2, 0.18), cTopY + 0.10, rng.range(-1.15, 1.15), 0, 0, 0, 8)
        .tint = tint(rng.pick([0x8a6a3a, 0x5d6350, 0x7a4a3a, 0x9a8f6c]), 0.85);
    }
    B.boxR('wood_plank', 0.30, 0.035, 0.22, cxA - 0.14, cTopY + 0.055, 1.02,
      0, 0.4, 0, 0.006).tint = tint(0x6f6a58, 0.8);
    // Dust, grit and fallen ceiling on the RETURN leg. That slab is the nearest
    // 1.5 m of the framing and it measured a standard deviation of 0.035 with
    // nothing on it - flat, which at this distance is worse than dark. A shop
    // that has had a shell through its roof does not have a swept counter.
    for (i = 0; i < 22; i++) {
      var dbx = cxA - rng.range(0.35, 1.85), dbz = -1.925 + rng.range(-0.32, 0.32);
      if (rng.bool(0.45)) { dbx = cxA + rng.range(-0.30, 0.24); dbz = rng.range(-1.45, 1.15); }
      B.boxR(rng.bool(0.55) ? 'concrete' : 'plaster',
        rng.range(0.03, 0.13), rng.range(0.012, 0.05), rng.range(0.03, 0.13),
        dbx, cTopY + 0.05, dbz,
        rng.range(-0.6, 0.6), rng.range(-1.5, 1.5), rng.range(-0.6, 0.6), 0.005)
        .paint = 'rubble';
    }
    for (i = 0; i < 3; i++) {
      B.boxR('plaster', rng.range(0.22, 0.42), 0.03, rng.range(0.18, 0.34),
        cxA - rng.range(0.5, 1.7), cTopY + 0.055, -1.925 + rng.range(-0.2, 0.2),
        rng.range(-0.14, 0.14), rng.range(0, 3.14), rng.range(-0.14, 0.14), 0.006)
        .tint = tint(0xe0d5be, 0.8);
    }
    // and the near corner of the slab knocked off, so the silhouette of the
    // foreground edge is broken rather than ruler-straight
    for (i = 0; i < 5; i++) {
      B.boxR('concrete', rng.range(0.10, 0.20), 0.08, rng.range(0.10, 0.20),
        cxA - 1.86 + rng.range(-0.06, 0.10), cTopY + rng.range(-0.02, 0.02),
        -2.26 + rng.range(0, 0.5),
        rng.range(-0.3, 0.3), rng.range(-1, 1), rng.range(-0.3, 0.3), 0.006)
        .tint = TERRAZZO;
    }
    // the smashed end of the counter, laid open
    for (i = 0; i < 14; i++) {
      B.boxR('brick', rng.range(0.1, 0.26), rng.range(0.06, 0.13), rng.range(0.1, 0.2),
        cxA + rng.range(-0.5, 0.5), fy + rng.range(0.03, 0.9), 1.3 + rng.range(-0.5, 0.6),
        rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), 0.008).paint = 'rubble';
    }
    L.addCollider(cxA, fy + 0.46, -0.4, 0.31, 0.46, 1.65, 'concrete');
    L.addCollider(cxA - 0.95, fy + 0.46, -1.9, 0.95, 0.46, 0.31, 'concrete');

    // shelf niches in the back wall - free depth, and they catch the shaft light
    B.dark = 0.4;
    for (i = 0; i < 3; i++) {
      B.box('backdrop', 0.16, 0.62, 1.5, x0 + 0.06, 1.1 + i * 0.8, 3.4, 0.01);
      B.box('wood_plank', 0.28, 0.045, 1.5, x0 + 0.14, 0.8 + i * 0.8, 3.4, 0.008);
    }
    B.dark = 0;

    // ---- interior wear: the walls in here take the same treatment as the
    // outside, otherwise the room reads as a clean box bolted into a ruin ----
    // Each patch used to be ONE box of brick: a hard-edged rectangle of masonry
    // pasted on a plaster wall, which is "perfectly straight, perfectly uniform
    // anything" from the instant-fail list and read as wallpaper in the shipped
    // frame. Every patch is now three to five overlapping sub-rectangles of
    // different size and depth with the plaster lip STRADDLING the boundary, so
    // no straight edge survives anywhere around it.
    var patch = [
      [-14.6, 0.9, 4.4, 1.5, 1.2], [-14.6, 2.3, -2.2, 1.1, 1.6],
      [-13.3, 1.1, 5.42, 1.8, 1.4], [-8.35, 3.30, 5.42, 1.35, 1.1],
      [-12.6, 0.7, -3.52, 1.7, 1.0]
    ];
    for (i = 0; i < patch.length; i++) {
      var pt = patch[i];
      var vertical = Math.abs(pt[2]) > 5 || pt[2] < -3.4;
      var nsub = rng.int(3, 5);
      for (var q1 = 0; q1 < nsub; q1++) {
        var sw = pt[3] * rng.range(0.42, 0.86), shh = pt[4] * rng.range(0.42, 0.90);
        var sox = (pt[3] - sw) * rng.range(-0.5, 0.5);
        var soy = (pt[4] - shh) * rng.range(-0.5, 0.5);
        B.box('brick', vertical ? sw : 0.055 + q1 * 0.004, shh,
          vertical ? 0.055 + q1 * 0.004 : sw,
          pt[0] + (vertical ? sox : 0), pt[1] + soy,
          pt[2] + (vertical ? 0 : sox), 0.008).dark = rng.range(0.10, 0.24);
      }
      // ragged plaster lip, laid ON the boundary rather than inside it
      for (var q2 = 0; q2 < 9; q2++) {
        var la = q2 / 9 * 6.283 + rng.range(-0.3, 0.3);
        B.boxR('plaster', rng.range(0.14, 0.38), rng.range(0.12, 0.34), 0.055,
          pt[0] + (vertical ? Math.cos(la) * pt[3] * 0.52 : 0),
          pt[1] + Math.sin(la) * pt[4] * 0.52,
          pt[2] + (vertical ? 0 : Math.cos(la) * pt[3] * 0.52),
          0, vertical ? 0 : 1.5708, rng.range(-0.5, 0.5), 0.006).dark = rng.range(0.02, 0.14);
      }
    }
    // ---- the shell hole through the south wall ------------------------------
    // pierceWallZ has already cut the void and given it a 0.3 m reveal, so all
    // that is left here is the wreckage: the blown lip of masonry standing proud
    // of the opening, rebar sagging out of it, and the spill on the sill. What
    // was here before was a black quad on a flat wall.
    var hcx = (HOLE_X[0] + HOLE_X[1]) * 0.5, hcy = 2.21, hzf = swZ - swT * 0.5;
    for (i = 0; i < 14; i++) {
      var ha = rng.range(0, 6.283);
      B.boxR(rng.bool(0.55) ? 'brick' : 'concrete',
        rng.range(0.10, 0.26), rng.range(0.08, 0.22), rng.range(0.09, 0.22),
        hcx + Math.cos(ha) * rng.range(0.42, 0.62),
        hcy + Math.sin(ha) * rng.range(0.36, 0.54), hzf - rng.range(0.02, 0.14),
        rng.range(-0.6, 0.6), rng.range(-0.6, 0.6), rng.range(-0.6, 0.6), 0.01);
    }
    // masonry that fell inward and is sitting on the sill of the hole
    for (i = 0; i < 6; i++) {
      B.boxR('brick', rng.range(0.09, 0.19), rng.range(0.05, 0.10), rng.range(0.07, 0.15),
        hcx + rng.range(-0.34, 0.34), 1.83 + rng.range(0, 0.04), swZ - rng.range(0.02, 0.12),
        rng.range(-0.5, 0.5), rng.range(-1, 1), rng.range(-0.5, 0.5), 0.008).paint = 'rubble';
    }
    for (i = 0; i < 4; i++) {
      rebar(B, hcx + rng.range(-0.3, 0.3), hcy + rng.range(-0.3, 0.3), swZ - 0.05,
        rng.range(0.4, 0.8), rng.range(-0.6, 0.6), rng.range(-0.6, 0.4), -1, rng);
    }
    L.scorches.push({ p: new THREE.Vector3(hcx, hcy + 0.2, hzf - 0.15), r: 2.8, k: 0.5 });
    L.streaks.push({ p: new THREE.Vector3(-10.9, 1.35, -3.6), r: 1.3 });

    // ---- SOMETHING FOR THE WINDOW LIGHT TO FALL ACROSS ----------------------
    // The room's whole midground - the 3 m band between the counter and the
    // shopfront, which is where the only direct light in here lands - was bare
    // floor. Light with nothing in it does not read as light. A market trestle
    // and a toppled steel shelving rack now stand in the beam: the trestle is a
    // stack of horizontals at 0.8 m that catches the rake side-on, the rack is a
    // long diagonal lying across the pool of it.
    var mtx = -8.8, mtz = -1.55;
    B.tint = tint(0x6b5540, 0.85);
    B.box('wood_plank', 1.55, 0.055, 0.86, mtx, fy + 0.78, mtz, 0.008);
    B.box('wood_plank', 1.62, 0.035, 0.10, mtx, fy + 0.75, mtz + 0.42, 0.006);
    for (i = -1; i <= 1; i += 2) {
      // trestle A-frames, not table legs: two diagonals per end
      for (var q4 = -1; q4 <= 1; q4 += 2) {
        B.boxR('wood_plank', 0.055, 0.82, 0.055, mtx + i * 0.62,
          fy + 0.38, mtz + q4 * 0.30, q4 * 0.16, 0, 0, 0.008);
      }
      B.box('wood_plank', 0.05, 0.045, 0.72, mtx + i * 0.62, fy + 0.22, mtz, 0.006);
    }
    B.tint = null;
    // produce crates on and under the trestle, one tipped off the end
    for (i = 0; i < 5; i++) {
      var ctx2 = [-0.5, 0.05, 0.52, -0.42, 0.30][i];
      var cty = [0.90, 0.90, 0.90, 0.13, 0.13][i];
      B.boxR('wood_plank', rng.range(0.34, 0.46), 0.24, rng.range(0.26, 0.34),
        mtx + ctx2, fy + cty, mtz + rng.range(-0.22, 0.22),
        0, rng.range(-0.4, 0.4), i === 2 ? 0.32 : 0, 0.01)
        .tint = tint(rng.pick([0x8a7350, 0x7a6440, 0x9a8258]), 0.8);
      // slat gaps: two rails proud of each crate so it is not a closed box
      for (var q5 = 0; q5 < 2; q5++) {
        B.boxR('wood_plank', rng.range(0.34, 0.46) + 0.02, 0.045, 0.02,
          mtx + ctx2, fy + cty - 0.06 + q5 * 0.12, mtz + 0.17,
          0, 0, i === 2 ? 0.32 : 0, 0.004).tint = tint(0x6b5540, 0.8);
      }
    }
    // the toppled shelving rack, lying across the light
    var rkx = -9.35, rkz = 1.35, rkA = 0.36;
    B.tint = tint(0x5d6350, 0.85);
    for (i = 0; i < 4; i++) {
      B.boxR('painted_metal', 1.85, 0.035, 0.42, rkx + i * 0.07, fy + 0.10 + i * 0.30,
        rkz + i * 0.30, rkA, 0.18, 0.03, 0.006);
    }
    for (i = -1; i <= 1; i += 2) {
      B.boxR('painted_metal', 1.92, 0.05, 0.05, rkx, fy + 0.62, rkz + 0.45 + i * 0.18,
        rkA, 0.18, 0.03, 0.006);
      B.boxR('painted_metal', 0.05, 0.05, 1.30, rkx + i * 0.92, fy + 0.62, rkz + 0.45,
        rkA, 0.18, 0.03, 0.006);
    }
    B.tint = null;
    for (i = 0; i < 12; i++) {
      B.boxR(rng.bool(0.5) ? 'wood_plank' : 'painted_metal',
        rng.range(0.10, 0.26), rng.range(0.05, 0.14), rng.range(0.09, 0.20),
        rkx + rng.range(-1.1, 1.1), fy + rng.range(0.03, 0.10), rkz + rng.range(-0.6, 1.3),
        rng.range(-0.5, 0.5), rng.range(-1.5, 1.5), rng.range(-0.5, 0.5), 0.008)
        .tint = tint(rng.pick([0x8a7350, 0x5d6350, 0x6f6a58]), 0.8);
    }
    // sheets of ceiling plaster that came down whole, edge-on to the light
    for (i = 0; i < 5; i++) {
      B.boxR('plaster', rng.range(0.5, 1.1), 0.035, rng.range(0.4, 0.9),
        rng.range(-12.3, -8.2), fy + rng.range(0.02, 0.16), rng.range(-2.6, 3.4),
        rng.range(-0.35, 0.35), rng.range(0, 3.14), rng.range(-0.35, 0.35), 0.008)
        .tint = tint(0xe0d5be, 0.8);
    }

    // ---- ceiling services: a conduit run and a pendant on its flex ----------
    // Silhouettes against the bright shopfront band, and the only thing in the
    // upper half of the room that is not a plane.
    B.tint = tint(0x8d8a82, 0.8);
    B.box('rusted_metal', 5.6, 0.045, 0.045, -9.9, ceil - 0.30, 0.15, 0.006);
    B.box('rusted_metal', 0.045, 0.045, 2.4, -12.6, ceil - 0.30, -0.95, 0.006);
    for (i = 0; i < 6; i++) {
      B.box('rusted_metal', 0.05, 0.09, 0.07, -12.5 + i * 0.95, ceil - 0.24, 0.15, 0.005);
    }
    B.tint = null;
    for (i = 0; i < 2; i++) {
      var lx = [-9.55, -11.65][i], lz = [0.2, 0.15][i];
      B.cyl('rubber', 0.009, 0.009, [0.95, 0.55][i], lx, ceil - 0.30 - [0.48, 0.28][i],
        lz, 0, 0, [0.10, -0.07][i], 5).paint = 'flat';
      B.cyl('painted_metal', 0.055, 0.075, 0.09, lx + [0.05, -0.02][i],
        ceil - [1.26, 0.86][i], lz, 0, 0, 0, 8).tint = tint(0x6d6a63, 0.85);
      if (i === 0) {
        // one shade survived; the other is a bare, broken holder
        B.cyl('painted_metal', 0.19, 0.055, 0.14, lx + 0.06, ceil - 1.37, lz, 0, 0, 0, 10)
          .tint = tint(0x8a7f6c, 0.75);
      }
    }

    // ---- the interior's own shaft of light ---------------------------------
    // Published for whoever can draw a volume (lighting.js builds up to two).
    // The aperture is the shell hole through the ceiling and the roof above it:
    // it is the ONE place in this room where a beam has 7 m of clear air to
    // exist in, and it lands on the rubble pile the room is built around. As in
    // the alley, the direction comes off the real sun when there is one so the
    // beam can never disagree with the shadows in the same frame.
    var isd = new THREE.Vector3(0.06, 0.32, -0.945);
    try {
      if (L.ctx && L.ctx.sky && L.ctx.sky.sunDirection &&
          L.ctx.sky.sunDirection.lengthSq() > 0.2) isd.copy(L.ctx.sky.sunDirection);
    } catch (e5) { /* the fallback rake is fine */ }
    L.lightShafts.push({
      origin: new THREE.Vector3((sh.x0 + sh.x1) * 0.5, roofY + 0.6, (sh.z0 + sh.z1) * 0.5),
      dir: isd.clone().multiplyScalar(-1).normalize(),
      width: 1.5, length: 7.6, strength: 0.80, kind: 'interior'
    });

    // rubble spilled under the hole
    rubblePile(B, (sh.x0 + sh.x1) * 0.5, fy, (sh.z0 + sh.z1) * 0.5, 2.2, 0.5, 46, rng);
    L.addCollider((sh.x0 + sh.x1) * 0.5, fy + 0.18, (sh.z0 + sh.z1) * 0.5, 1.5, 0.18, 1.4, 'gravel', true);
  }

  // =============================================================== RUBBLE ====
  function rubblePile(B, cx, cy, cz, radius, height, count, rng) {
    for (var i = 0; i < count; i++) {
      var a = rng.range(0, 6.283);
      var r = Math.sqrt(rng.next()) * radius;
      var fall = 1 - r / radius;
      var s = rng.range(0.07, 0.34) * (0.5 + fall * 0.9);
      var key = rng.bool(0.55) ? 'concrete' : (rng.bool(0.6) ? 'brick' : 'gravel');
      B.boxR(key, s * rng.range(0.7, 1.6), s * rng.range(0.5, 1.0), s * rng.range(0.7, 1.5),
        cx + Math.cos(a) * r, cy + fall * fall * height * rng.range(0.15, 1.0) + s * 0.2,
        cz + Math.sin(a) * r,
        rng.range(-1.5, 1.5), rng.range(-1.5, 1.5), rng.range(-1.5, 1.5), 0.012).paint = 'rubble';
    }
    // a few bars of reinforcement poking out of the heap
    for (var b = 0; b < Math.max(2, count / 14); b++) {
      var ba = rng.range(0, 6.283), br = rng.range(0, radius * 0.7);
      rebar(B, cx + Math.cos(ba) * br, cy + 0.05, cz + Math.sin(ba) * br,
        rng.range(0.5, 1.3), rng.range(-1, 1), rng.range(0.4, 1), rng.range(-1, 1), rng);
    }
  }

  // ========================================================= BURNT-OUT SEDAN =
  // Authored upright and forward along +X, then rolled onto its side by the
  // caller. Because it lies on its flank the UNDERSIDE faces the street, so
  // that is where the detail budget goes: chassis rails, axle, exhaust, tank.
  function buildCar(B, rng) {
    var i;
    B.paint = 'burn';
    var body = tint(0x3a3634, 0.9);
    B.tint = body;

    // Shell is 'rusted_metal', not painted: the paint is what burned off, and
    // an oxidised dielectric-ish surface reads far better than gloss paint.
    var SH = 'rusted_metal';
    // main tub
    B.box(SH, 4.30, 0.60, 1.72, 0, 0.62, 0, 0.05);
    B.box(SH, 4.10, 0.22, 1.78, 0, 0.36, 0, 0.06);         // sill line
    // bonnet / boot, gently sloped
    B.boxR(SH, 1.42, 0.14, 1.66, 1.52, 0.99, 0, 0, 0, -0.06, 0.03);
    B.boxR(SH, 1.10, 0.14, 1.64, -1.62, 1.00, 0, 0, 0, 0.05, 0.03);
    // greenhouse: A pillar, roof, C pillar. Burnt cars keep their pillars.
    B.boxR(SH, 0.13, 1.05, 1.58, 0.66, 1.42, 0, 0, 0, -0.55, 0.02);
    B.boxR(SH, 0.12, 0.95, 1.54, -1.02, 1.40, 0, 0, 0, 0.42, 0.02);
    B.box(SH, 0.10, 0.92, 0.10, -0.18, 1.40, 0.80, 0.02);
    B.box(SH, 0.10, 0.92, 0.10, -0.18, 1.40, -0.80, 0.02);
    B.boxR(SH, 1.85, 0.09, 1.52, -0.20, 1.88, 0, 0, 0, 0.015, 0.03);
    B.box(SH, 1.9, 0.06, 0.09, -0.2, 1.86, 0.76, 0.02);
    B.box(SH, 1.9, 0.06, 0.09, -0.2, 1.86, -0.76, 0.02);
    // doors, one hanging open
    for (i = -1; i <= 1; i += 2) {
      B.box(SH, 1.02, 0.86, 0.06, 0.14, 0.86, i * 0.87, 0.02);
      if (i > 0) {
        B.pushXYZ(-0.42, 0.86, 0.87, 0, -0.62, 0);
        B.box(SH, 1.00, 0.86, 0.06, 0.5, 0, 0, 0.02);
        B.box('rusted_metal', 0.16, 0.04, 0.05, 0.9, 0.12, 0.04, 0.008);
        B.pop();
      } else {
        B.box(SH, 1.00, 0.86, 0.06, -0.42, 0.86, i * 0.87, 0.02);
      }
    }
    // arches + bumpers + grille
    for (i = 0; i < 4; i++) {
      var ax = (i < 2) ? 1.34 : -1.30, az = (i % 2 ? 1 : -1) * 0.86;
      B.boxR(SH, 0.86, 0.30, 0.10, ax, 0.86, az, 0, 0, 0, 0.02);
      B.box(SH, 0.80, 0.16, 0.22, ax, 0.62, az * 0.93, 0.02);
    }
    B.box(SH, 0.22, 0.30, 1.74, 2.12, 0.60, 0, 0.03);
    B.box(SH, 0.20, 0.28, 1.70, -2.10, 0.60, 0, 0.03);
    for (i = 0; i < 6; i++) {
      B.box('rusted_metal', 0.05, 0.05, 1.30, 2.16, 0.80 + i * 0.055, 0, 0.008);
    }
    B.dark = 0.55;
    B.box('backdrop', 0.1, 0.26, 0.44, 2.14, 0.94, 0.62, 0.01);        // burnt-out lamps
    B.box('backdrop', 0.1, 0.26, 0.44, 2.14, 0.94, -0.62, 0.01);
    B.box('backdrop', 1.8, 0.9, 1.5, -0.2, 1.35, 0, 0.02);             // gutted cabin
    B.dark = 0;

    // ---- underside: the face the street actually sees ----
    B.tint = tint(0x4a3a2c, 0.9);
    for (i = -1; i <= 1; i += 2) {
      B.box('rusted_metal', 3.9, 0.14, 0.13, -0.1, 0.30, i * 0.52, 0.015);   // chassis rail
    }
    B.box('rusted_metal', 1.3, 0.10, 1.05, -0.1, 0.30, 0, 0.015);            // crossmember
    B.box('rusted_metal', 0.55, 0.34, 1.36, -1.30, 0.34, 0, 0.02);           // fuel tank
    B.cyl('rusted_metal', 0.075, 0.075, 1.42, 1.36, 0.32, 0, 0, 0, Math.PI / 2, 8);   // front axle
    B.cyl('rusted_metal', 0.085, 0.085, 1.42, -1.28, 0.32, 0, 0, 0, Math.PI / 2, 8);  // rear axle
    B.cyl('rusted_metal', 0.05, 0.05, 2.3, 0.1, 0.26, 0.22, 0, 0, 0, 8);     // prop shaft
    B.cyl('rusted_metal', 0.038, 0.038, 3.1, -0.2, 0.22, -0.34, 0, 0, 0, 8); // exhaust
    B.cyl('rusted_metal', 0.11, 0.11, 0.5, -1.55, 0.22, -0.34, 0, 0, 0, 8);  // silencer
    B.cyl('rusted_metal', 0.19, 0.19, 0.34, 0.0, 0.30, 0.22, 0, 0, Math.PI / 2, 10);  // gearbox
    B.box('rusted_metal', 0.7, 0.34, 0.9, 1.55, 0.55, 0, 0.02);              // engine block
    for (i = -1; i <= 1; i += 2) {
      B.boxR('rusted_metal', 0.62, 0.07, 0.14, 1.34, 0.30, i * 0.45, 0, 0, i * 0.2, 0.01);
      B.boxR('rusted_metal', 0.5, 0.07, 0.13, -1.30, 0.30, i * 0.45, 0, 0, -i * 0.2, 0.01);
      B.cyl('rusted_metal', 0.06, 0.06, 0.42, 1.36, 0.5, i * 0.6, 0, 0, 0, 6);
    }

    // wheels: three burnt tyres, one bare hub where the rubber went
    B.tint = tint(0x1e2024, 0.9);
    var wp = [[1.36, 0.86], [1.36, -0.86], [-1.28, 0.86], [-1.28, -0.86]];
    for (i = 0; i < 4; i++) {
      if (i === 1) {
        B.cyl('rusted_metal', 0.24, 0.24, 0.16, wp[i][0], 0.32, wp[i][1], 0, 0, Math.PI / 2, 12);
        continue;
      }
      B.cyl('rubber', 0.335, 0.335, 0.22, wp[i][0], 0.33, wp[i][1], 0, 0, Math.PI / 2, 14);
      B.cyl('rusted_metal', 0.21, 0.21, 0.24, wp[i][0], 0.33, wp[i][1], 0, 0, Math.PI / 2, 10);
    }
    B.tint = null;
    B.paint = 'wall';
  }

  // ====================================================== STREET FURNITURE ==
  function buildSandbags(L, B, rng, noise) {
    // L-shaped emplacement on the east side of the roadway. Placed close to
    // the street framing so it is a real foreground mass, not a distant lump.
    // Filled bags slump and interlock: the placement pitch is deliberately
    // SMALLER than the bag so courses overlap. Spacing them at their nominal
    // size leaves daylight streaming through the wall.
    //
    // Every bag is one of six pre-built lumpy sacks (see sackGeo), never a box:
    // the running-bond read dies because no two neighbours share a silhouette.
    // A real wall is also laid by tired men in the dark, so the jitter is wide,
    // roughly one bag in six goes in as a header, and the top courses slump.
    // The PITCH is not the bag size. Laying 0.46 m bags on a 0.46 m pitch left
    // a millimetre-wide slot between every neighbour, and with a lit street
    // behind the emplacement those slots became a grid of bright pinholes -
    // which is exactly what made the wall read as a lattice of lozenges rather
    // than as a packed mass. Real bags are rammed down onto the course below
    // and squeezed against their neighbours: roughly 22% overlap each way.
    // Geometry of the position is set by the STREET FRAMING, not by tactics.
    // The published street pose stands at x = 1.85, so a corner at x = 1.9 put
    // the return leg dead on the sightline and the revetment plus the wire
    // behind it closed off the bottom third of the hero shot. A foreground mass
    // is good composition; a wall across the shot is not. The corner moves 0.85
    // m right of the camera axis, the return leg is cut from 3.2 m to 2.1 m so
    // it no longer runs toward the vanishing point, and the wall loses a course
    // so its crest sits clear of eye height and the street reads over the top.
    // It is still 1.03 m of stacked sand: chest cover from the north, which is
    // what it is for.
    var courses = 9, bw = 0.355, bh = 0.124;
    var runs = [
      { x: 2.7, z: 10.35, dx: 1, len: 13 },
      { x: 2.7, z: 10.35, dx: 0, len: 6 }
    ];
    var minX = 99, maxX = -99, minZ = 99, maxZ = -99;
    var slumpAt = [];
    for (var r = 0; r < runs.length; r++) {
      var R = runs[r];
      for (var c = 0; c < courses; c++) {
        var n = R.len - Math.floor(c * 0.5);
        // Every course starts at its own arbitrary phase, not on a two-step
        // stretcher/header alternation: an exact half-bag offset repeated up
        // eight courses IS running bond, however lumpy the bag is.
        var offs = rng.range(-0.30, 0.30);
        // the top two courses have been knocked about and settle unevenly
        var top = Math.max(0, c - (courses - 3)) / 3;
        for (var i = 0; i < n; i++) {
          var px = R.dx ? (R.x + offs + i * bw) : R.x;
          var pz = R.dx ? R.z : (R.z - offs - i * bw);
          if (!R.dx && i === 0) continue;                 // corner shared
          var header = rng.bool(0.17);                    // laid across the wall
          var lean = top * rng.range(0.12, 0.25);
          var sag = top * rng.range(0.25, 0.5) * bh;
          // Bags come off different pallets and are filled by different people:
          // a wide size spread is what stops even lumpy geometry laid on a grid
          // reading as a grid, because the COURSE LINE stops being a line.
          var cls = rng.pick(SACK_SIZE);
          var sx = cls * rng.range(0.92, 1.14), sy = cls * rng.range(0.86, 1.16),
            sz = cls * rng.range(0.92, 1.16);
          var yaw = (R.dx ? 0 : Math.PI / 2) + (header ? Math.PI / 2 : 0) + rng.range(-0.26, 0.26);
          // ALONG the wall the jitter has to stay under the overlap or the bags
          // pull apart again; ACROSS it, it can be wide, and that is what makes
          // the face of the revetment rough instead of a flat plane of lozenges.
          var jA = rng.range(-0.042, 0.042), jC = rng.range(-0.10, 0.10);
          var mtx = makeM(px + (R.dx ? jA : jC),
            0.03 + bh * (c + 0.5) - sag + rng.range(-0.018, 0.018),
            pz + (R.dx ? jC : jA),
            rng.range(-0.16, 0.16), yaw,
            (R.dx ? -1 : 1) * lean + rng.range(-0.16, 0.16));
          mtx.scale(_tmpV.set(sx, sy, sz));
          var e = B.add('sandbag', sackGeo(rng.int(0, SACK_N - 1), noise), mtx);
          e.paint = 'sack';
          e.tint = tint(rng.pick(SACK_HUE), rng.range(0.3, 0.85));
          minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
          if (top > 0.3 && rng.bool(0.18)) slumpAt.push([px, 0.02 + bh * c, pz]);
        }
      }
    }
    // a few burst bags slumped at the foot
    for (var f = 0; f < 10; f++) {
      var bm = makeM(rng.range(2.4, 6.9), 0.075, rng.range(9.35, 10.3),
        rng.range(-0.5, 0.5), rng.range(0, 3.14), rng.range(-0.5, 0.5));
      bm.scale(_tmpV.set(rng.range(0.95, 1.2), rng.range(0.5, 0.8), rng.range(0.95, 1.2)));
      var e2 = B.add('sandbag', sackGeo(rng.int(0, SACK_N - 1), noise), bm);
      e2.paint = 'sack';
      e2.tint = tint(0x9c8f70, rng.range(0.2, 0.5));
    }
    // spilled fill where the top courses have burst, so the silhouette of the
    // wall is broken by sand rather than by a clean missing block
    for (var s = 0; s < slumpAt.length; s++) {
      var sp = slumpAt[s];
      B.boxR('sand', rng.range(0.35, 0.62), rng.range(0.06, 0.12), rng.range(0.3, 0.5),
        sp[0] + rng.range(-0.1, 0.1), sp[1] + 0.03, sp[2] + rng.range(-0.1, 0.1),
        rng.range(-0.12, 0.12), rng.range(0, 3.14), rng.range(-0.12, 0.12),
        0.02).dark = rng.range(0, 0.12);
    }
    // sand drifted out of the base along the whole run
    for (var w = 0; w < 9; w++) {
      B.boxR('sand', rng.range(0.5, 1.0), rng.range(0.05, 0.1), rng.range(0.45, 0.8),
        rng.range(2.3, 7.1), 0.01, rng.range(9.2, 9.65),
        0, rng.range(0, 3.14), rng.range(-0.1, 0.1), 0.02).dark = rng.range(0, 0.1);
    }
    // firing step and a corrugated overhead - gives the position a silhouette
    B.box('wood_plank', 2.4, 0.14, 0.7, 4.2, 0.24, 9.5, 0.012).tint = tint(0x6b5540, 0.75);
    B.boxR('corrugated_metal', 2.2, 0.04, 1.1, 5.4, 1.32, 10.05, 0.16, 0.1, 0, 0.008);
    B.cyl('rusted_metal', 0.035, 0.035, 1.3, 4.4, 0.65, 10.45, 0, 0, 0, 6);
    B.cyl('rusted_metal', 0.035, 0.035, 1.3, 6.4, 0.65, 10.45, 0, 0, 0, 6);
    L.addCollider((minX + maxX) * 0.5 + 0.27, 0.55, 10.35, (maxX - minX) * 0.5 + 0.35, 0.55, 0.22, 'sand');
    L.addCollider(2.7, 0.55, (minZ + maxZ) * 0.5 - 0.2, 0.22, 0.55, (maxZ - minZ) * 0.5 + 0.35, 'sand');
  }

  // Lowest point of the jersey profile after a roll of `rz`, so a barrier can be
  // re-seated flush on the cambered road instead of hovering or balancing.
  function jerseySeat(rz) {
    var s = Math.sin(rz), c = Math.cos(rz), lo = 1e9;
    for (var i = 0; i < JERSEY.length; i++) {
      var y = JERSEY[i][0] * s + JERSEY[i][1] * c;
      if (y < lo) lo = y;
    }
    return lo;
  }

  function buildBarriers(L, B, rng, noise) {
    // a chicane forcing traffic to weave - strong leading diagonals in frame.
    // {x, z, yaw, tip} - `tip` rolls the barrier onto its flank about its own
    // long base edge, which is the only way a knocked-over one sits flush.
    var spots = [
      { x: -3.2, z: 3.6, yaw: 0.06 }, { x: -1.4, z: 3.9, yaw: -0.02 },
      { x: 0.4, z: 4.1, yaw: 0.05, tip: 1.46 },
      { x: 3.9, z: 0.6, yaw: 1.52 }, { x: 3.9, z: -0.7, yaw: 1.55 },
      { x: 3.9, z: -2.0, yaw: 1.49 },
      { x: -4.2, z: -13.5, yaw: 0.03 }, { x: -2.5, z: -13.9, yaw: 0.12, tip: -1.42 },
      { x: 1.9, z: -21.0, yaw: 1.4 }
    ];
    var F = L.roadFeatures;
    // Cast in three 0.84 m units, not one 2.4 m extrusion. A precast barrier
    // run IS a line of separate units, and giving each its own millimetre-scale
    // seating error is what breaks the razor-straight 4 m crown that carried a
    // single unbroken specular sliver along its whole length in every frame it
    // appeared in - the "floating white slab" behind the enemy.
    var SEGL = 0.86, SEGP = 0.80, NSEG = 3;
    var g = profileGeo('jersey', JERSEY, SEGL);
    for (var i = 0; i < spots.length; i++) {
      var s = spots[i];
      var rz = (s.tip || 0) + rng.range(-0.04, 0.04);
      var rx = rng.range(-0.03, 0.03);
      // sit on the actual cambered, guttered, potholed carriageway
      var gy = (F && noise) ? roadY(s.x, s.z, F, noise) : -0.02;
      var y = gy - jerseySeat(rz) - 0.02;
      var m = makeM(s.x, y, s.z, rx, s.yaw, rz);
      var seg, sm, e, b;
      for (seg = 0; seg < NSEG; seg++) {
        var off = (seg - (NSEG - 1) * 0.5) * SEGP;
        sm = new THREE.Matrix4().multiplyMatrices(m,
          makeM(0, rng.range(-0.012, 0.004), off,
            rng.range(-0.02, 0.02), rng.range(-0.035, 0.035), rng.range(-0.025, 0.025)));
        e = B.add('precast', g, sm);
        e.paint = 'jersey';                  // aggregate + road-splash grounding
        // Each unit was cast on a different day and has weathered differently;
        // and NONE of them is the near-white the old 0.6-strength tint gave.
        // A four-year-old barrier on a dusty street is a mid warm grey.
        e.tint = PRECAST[(i + seg) % PRECAST.length];
        e.dark = rng.range(0.04, 0.24);
      }
      var hx = 1.2 * Math.abs(Math.cos(s.yaw)) + 0.42 * Math.abs(Math.sin(s.yaw));
      var hz = 0.42 * Math.abs(Math.cos(s.yaw)) + 1.2 * Math.abs(Math.sin(s.yaw));
      L.addCollider(s.x, gy + (s.tip ? 0.24 : 0.43), s.z, hx,
        s.tip ? 0.24 : 0.45, hz, 'concrete');
      B.push(m);
      // Scuffed reflective banding, long since dulled - INSET into the profile
      // and carried on the barrier's own transform, so it is part of the
      // silhouette rather than a rectangle floating 6 cm proud of it.
      for (b = -1; b <= 1; b += 2) {
        B.boxR('painted_metal', 0.028, 0.15, 0.44, b * 0.138, 0.42, rng.range(-0.5, 0.5),
          0, 0, 0, 0.005).paint = 'flat';
      }
      // Two rebar lifting loops bent over the crown, and the rust weep under
      // them. A unit with no lifting point has never been craned anywhere.
      for (b = -1; b <= 1; b += 2) {
        var lz = b * rng.range(0.55, 0.72);
        B.cyl('rusted_metal', 0.014, 0.014, 0.15, 0, 0.90, lz - 0.055, 0, 0, 0, 5);
        B.cyl('rusted_metal', 0.014, 0.014, 0.15, 0, 0.90, lz + 0.055, 0, 0, 0, 5);
        B.cyl('rusted_metal', 0.014, 0.014, 0.13, 0, 0.965, lz, Math.PI / 2, 0, 0, 5);
      }
      // Chipped crown and a spalled corner: 3 knocks along the run, each a
      // rolled slab of exposed aggregate sitting in the arris, so the top
      // highlight is interrupted instead of running the full length.
      var nch = rng.int(2, 3);
      for (b = 0; b < nch; b++) {
        var cz = rng.range(-1.05, 1.05);
        var cw = rng.range(0.10, 0.25);
        B.boxR('gravel', 0.16, rng.range(0.045, 0.09), cw,
          rng.range(-0.03, 0.03), 0.855, cz,
          rng.range(-0.3, 0.3), rng.range(-0.4, 0.4), rng.range(-0.35, 0.35), 0.006)
          .dark = rng.range(0.18, 0.42);
      }
      // a corner knocked clean off, showing darker aggregate
      var ce = rng.bool() ? 1 : -1;
      B.boxR('gravel', 0.30, 0.22, 0.26, 0, 0.16, ce * (1.2 - 0.09),
        rng.range(-0.4, 0.4), rng.range(-0.3, 0.3), 0.6 * ce, 0.01).dark = rng.range(0.2, 0.4);
      B.pop();
      // Grounding: a wedge of pushed-up grit on the windward side, and a drift
      // of broken kerb running the WHOLE 2.4 m length so the contact line is
      // never straight. Nothing on a street sits on a line.
      // local +Z (the run) and local +X (across it) in world terms
      var ax = Math.sin(s.yaw), az = Math.cos(s.yaw);   // along
      var px2 = Math.cos(s.yaw), pz2 = -Math.sin(s.yaw); // across
      B.boxR('sand', rng.range(0.7, 1.3), rng.range(0.05, 0.09), rng.range(0.28, 0.5),
        s.x + px2 * 0.34 + rng.range(-0.2, 0.2), gy + 0.03,
        s.z + pz2 * 0.34 + rng.range(-0.2, 0.2),
        0, s.yaw + rng.range(-0.2, 0.2), rng.range(-0.08, 0.08), 0.02).dark = rng.range(0, 0.12);
      for (b = 0; b < 4; b++) {
        var t3 = (b - 1.5) * 0.68;
        var dx = ax * t3, dz = az * t3;
        rubblePile(B, s.x - px2 * 0.30 + dx, gy - 0.02, s.z - pz2 * 0.30 + dz,
          0.44, 0.10, 6, rng);
        B.boxR('sand', rng.range(0.5, 0.85), rng.range(0.035, 0.07), rng.range(0.2, 0.34),
          s.x - px2 * 0.26 + dx + rng.range(-0.1, 0.1), gy + 0.022,
          s.z - pz2 * 0.26 + dz + rng.range(-0.1, 0.1),
          0, s.yaw + rng.range(-0.35, 0.35), rng.range(-0.06, 0.06), 0.02)
          .dark = rng.range(0.05, 0.22);
      }
    }
  }

  function buildBusShelter(L, B, rng) {
    var cx = 6.05, cz = 2.2;
    B.tint = tint(0x4c5560, 0.85);
    for (var i = -1; i <= 1; i += 2) {
      B.box('painted_metal', 0.09, 2.45, 0.09, cx - 0.62, KERB_H + 1.22, cz + i * 1.75, 0.012);
      B.box('painted_metal', 0.09, 2.45, 0.09, cx + 0.62, KERB_H + 1.22, cz + i * 1.75, 0.012);
    }
    B.box('painted_metal', 1.5, 0.08, 3.8, cx, KERB_H + 2.48, cz, 0.012);
    B.box('painted_metal', 1.6, 0.14, 0.1, cx, KERB_H + 2.52, cz + 1.9, 0.012);
    // back panel: one sheet of laminate left, the rest shot out
    B.box('painted_metal', 0.06, 2.0, 1.2, cx + 0.62, KERB_H + 1.1, cz - 1.05, 0.008);
    var gp = B.box('glass', 0.02, 1.05, 1.3, cx + 0.62, KERB_H + 0.72, cz + 1.0, 0.006);
    gp.paint = 'flat'; gp.dark = 0.2;
    // The shot-out top half of that pane, still clinging to the frame. This
    // used to be called with the builder stack at identity, which put the
    // shards at world zero - loose glass in the middle of the carriageway.
    B.push(makeM(cx + 0.62, KERB_H + 1.72, cz + 1.0, 0, Math.PI * 0.5, 0));
    brokenGlass(B, 0, 0, 1.2, 0.7, rng, 0);
    B.pop();
    B.tint = null;
    // bench
    B.tint = tint(0x6b5540, 0.8);
    for (i = 0; i < 4; i++) {
      B.box('wood_plank', 0.42, 0.05, 3.2, cx + 0.16, KERB_H + 0.46, cz, 0.008);
      break;
    }
    B.box('wood_plank', 0.42, 0.05, 3.2, cx + 0.16, KERB_H + 0.46, cz, 0.008);
    B.box('wood_plank', 0.34, 0.05, 3.2, cx + 0.52, KERB_H + 0.78, cz, 0.008);
    B.tint = null;
    for (i = -1; i <= 1; i += 2) {
      B.box('painted_metal', 0.5, 0.44, 0.06, cx + 0.28, KERB_H + 0.24, cz + i * 1.2, 0.008);
    }
    L.addCollider(cx, KERB_H + 0.5, cz, 0.6, 0.5, 1.9, 'metal');
    L.addCollider(cx + 0.62, KERB_H + 1.2, cz, 0.06, 1.2, 1.9, 'metal');
  }

  // A balcony that let go, still hinged on its rebar, spilling its slab into
  // the street. The strongest diagonal in the mid-ground of the street shot.
  function buildCollapsedBalcony(L, B, rng) {
    var bz = -26.0, by = 3.62;
    B.tint = tint(0xd0bb95, 0.6);
    // the stub still attached to the wall
    B.box('concrete', 0.9, 0.16, 1.05, -6.62, by - 0.08, bz + 1.3, 0.014);
    // the fallen slab, hinged down at 52 degrees
    B.boxR('concrete', 2.9, 0.17, 1.15, -5.35, by - 1.35, bz - 0.55, 0, 0.16, -0.95, 0.014);
    B.boxR('concrete', 2.9, 0.05, 0.12, -5.35, by - 1.35, bz - 1.1, 0, 0.16, -0.95, 0.008);
    B.tint = null;
    for (var i = 0; i < 7; i++) {
      rebar(B, -6.7 + rng.range(0, 0.5), by - 0.1, bz + rng.range(-0.4, 1.5),
        rng.range(0.7, 1.5), rng.range(0.4, 1), rng.range(-0.9, -0.2), rng.range(-0.6, 0.2), rng);
    }
    // twisted railing dragged down with it
    B.boxR('rusted_metal', 2.7, 0.04, 0.04, -5.2, by - 2.4, bz - 1.15, 0, 0.2, -0.9, 0.006);
    for (i = 0; i < 9; i++) {
      B.boxR('rusted_metal', 0.024, 0.85, 0.024, -6.3 + i * 0.3, by - 1.9 - i * 0.16, bz - 1.05,
        rng.range(-0.3, 0.3), 0, -0.9 + rng.range(-0.2, 0.2), 0.005);
    }
    L.addCollider(-5.35, by - 1.35, bz - 0.55, 1.45, 0.35, 0.6, 'concrete',
      false, new THREE.Euler(0, 0.16, -0.95, 'YXZ'));
    rubblePile(B, -4.6, -0.06, bz - 1.4, 3.0, 0.85, 90, rng);
    L.addCollider(-4.6, 0.24, bz - 1.4, 2.4, 0.3, 1.9, 'gravel', true);
    L.scorches.push({ p: new THREE.Vector3(-6.9, by + 1.2, bz + 0.4), r: 3.4, k: 0.45 });
  }

  // ========================================================= OVERHEAD CABLES =
  // Cables crossing the street break up the sky, add leading lines toward the
  // vanishing point, and are almost free. They do not cast (sub-texel).
  function buildCables(L, B, rng) {
    var spans = [
      [-7.1, 7.4, 12.0, 7.05, 6.9, 11.2], [-7.05, 8.2, 3.2, 7.1, 7.6, 2.0],
      [-7.1, 6.6, -2.4, 7.05, 9.0, -3.4], [-7.05, 8.4, -12.5, 7.1, 8.0, -11.0],
      [-7.1, 9.6, -22.0, 7.05, 7.4, -23.4], [-7.05, 7.0, -31.0, 7.1, 8.6, -30.2],
      [-7.1, 6.8, -40.0, 7.05, 6.4, -41.0]
    ];
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var nCab = rng.int(2, 4);
      for (var c = 0; c < nCab; c++) {
        var off = (c - (nCab - 1) * 0.5) * 0.16;
        var sag = rng.range(0.55, 1.15);
        var pts = [];
        for (var t = 0; t <= 6; t++) {
          var f = t / 6;
          pts.push(new THREE.Vector3(
            M.lerp(s[0], s[3], f),
            M.lerp(s[1], s[4], f) + off - Math.sin(Math.PI * f) * sag,
            M.lerp(s[2], s[5], f) + off * 0.4));
        }
        var g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.021, 4, false);
        var e = B.add('rubber', g, null);
        e.paint = 'flat';
        e.tint = tint(0x30302e, 0.9);
      }
      // stand-off brackets where the cables meet the walls
      B.box('rusted_metal', 0.4, 0.07, 0.07, s[0] + 0.2, s[1], s[2], 0.008);
      B.box('rusted_metal', 0.4, 0.07, 0.07, s[3] - 0.2, s[4], s[5], 0.008);
    }
    // Two cloth banners on their own rope. Backlit fabric is one of the
    // strongest cheap depth cues in a hazy street - but it has to hang from
    // something visible or it reads as a floating slab.
    var bn = [[-1.0, 6.35, 1.6, 2.6, 1.45, 0xb8503a], [1.1, 6.55, -26.0, 2.2, 1.25, 0x3f7f82]];
    for (var b = 0; b < bn.length; b++) {
      var q = bn[b];
      var ropeY = q[1] + 0.16;
      // the rope it hangs from, spanning the street
      var rp = [];
      for (var s2 = 0; s2 <= 5; s2++) {
        var ff = s2 / 5;
        rp.push(new THREE.Vector3(M.lerp(-7.05, 7.05, ff), ropeY + 0.55 - Math.sin(Math.PI * ff) * 0.55, q[2]));
      }
      var e3 = B.add('rubber', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rp), 10, 0.016, 4, false), null);
      e3.paint = 'flat'; e3.tint = tint(0x33322e, 0.9);
      var ca2 = tint(q[5], 0.62), cb2 = tint(0xd9c3a0, 0.45);
      var n2 = 5;
      for (var s3 = 0; s3 < n2; s3++) {
        var e2 = B.add('fabric', canopyGeo(q[3], q[4], 0.05, 2, 4, s3 / n2, (s3 + 1) / n2),
          makeM(q[0], ropeY, q[2], Math.PI * 0.5 + 0.05, rng.range(-0.18, 0.18), 0));
        e2.tint = (s3 & 1) ? cb2 : ca2;
      }
      // ties
      for (var t2 = -1; t2 <= 1; t2 += 2) {
        B.cyl('rubber', 0.01, 0.01, 0.18, q[0] + t2 * q[3] * 0.44, ropeY + 0.08, q[2], 0, 0, 0, 4).paint = 'flat';
      }
    }
  }

  // ============================================================== BACKDROP ===
  // Low-detail city beyond the playable block. It never casts or receives -
  // it exists purely to give the haze something to fade, which is what sells
  // atmospheric depth in the overview and rooftop framings.
  // A single fogged-out desert plain under everything. Without it, any view
  // that clears a parapet shows void where the ground should be, and the
  // distant blocks read as floating.
  // The rim used to stop at 150 m, where the global fog is only ~0.89 opaque
  // against a 0.86 cap: the plain therefore drew a DEAD STRAIGHT horizontal
  // seam across overview.png where its own residual albedo met the sky (a
  // measured ~0.04 luminance step, and a ruler-straight line is exactly what
  // the instant-fail list means by "perfectly straight anything"). Two changes
  // kill it: push the rim out to 430 m so the residual is as small as the cap
  // allows, and let the far ground RISE into low dunes so the terminating line
  // is a wavy ridge rather than an edge. The 'outer' paint mode then lifts the
  // rim's albedo toward the haze so the residual has almost no contrast left.
  var OUTER_HALF = 430;
  function buildOuterGround(B, L, rng, noise) {
    var half = OUTER_HALF, n = 30;
    var pos = [], idx = [], ix, iz;
    for (iz = 0; iz <= n; iz++) {
      for (ix = 0; ix <= n; ix++) {
        // Cells are graded so the near half of the plain keeps the density it
        // had and the extra reach costs almost nothing: u^2.1 puts 60% of the
        // rows inside the old 150 m footprint.
        var sx = (ix / n) * 2 - 1, sz = (iz / n) * 2 - 1;
        var x = Math.sign(sx) * Math.pow(Math.abs(sx), 2.1) * half;
        var z = Math.sign(sz) * Math.pow(Math.abs(sz), 2.1) * half - 18;
        var rr = Math.sqrt(x * x + (z + 18) * (z + 18));
        var d = Math.max(Math.abs(x) / 24, Math.abs(z + 18) / 60);
        // flat under the block, dunes further out, then a low ridge line at the
        // rim so the plain never terminates against the sky as a straight edge
        var y = -0.45 + noise.fbm2(x * 0.012, z * 0.012, 3) * 2.6 * M.smoothstep(1.6, 4.2, d);
        y += (noise.fbm2(x * 0.0026 + 7.7, z * 0.0026 - 3.1, 3) * 0.5 + 0.55) * 7.5 *
          M.smoothstep(120, 400, rr);
        pos.push(x, y, z);
      }
    }
    for (iz = 0; iz < n; iz++) {
      for (ix = 0; ix < n; ix++) {
        var a = iz * (n + 1) + ix;
        idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    B.paint = 'outer';
    B.add('sand', g, null);
    B.paint = 'wall';
    // a safety floor so nothing can fall out of the world
    L.addCollider(0, -1.6, -18, 150, 1.0, 150, 'sand', true);
  }

  // ---- the far-city facade map ----------------------------------------------
  // ONE tile = DIST_COLS window bays wide by (DIST_ROWS + 1) bands tall. One
  // band carries no openings at all: it is the spandrel/parapet course, and
  // _distantUV parks every non-facade piece (roof furniture, parapet caps, the
  // minaret) inside it so those pieces get render and grain but never a window.
  // Because each face maps an INTEGER number of tiles, the band always lands
  // exactly under the roofline, which is where a real parapet is.
  //
  // The band is canvas ROW 0. three.js flips canvas textures on upload
  // (flipY defaults true), so v = 1 is the TOP of the canvas, and the top of
  // every mapped face lands on an integer v - i.e. on canvas row 0. Getting
  // this backwards puts the band under the building and makes every band-mapped
  // piece sample one horizontal line THROUGH a window row, which renders as a
  // comb of vertical bars along every parapet in the far city.
  var DIST_COLS = 3, DIST_ROWS = 4;
  var DIST_TILEROWS = DIST_ROWS + 1;
  var DIST_BANDC = (DIST_TILEROWS - 0.5) / DIST_TILEROWS;   // centre of the band
  var DIST_BANDH = 0.34 / DIST_TILEROWS;                    // safe half-height

  var _distTex = null, _distTexTried = false;
  function distantFacadeTexture(rng) {
    if (_distTexTried) return _distTex;
    _distTexTried = true;
    if (typeof document === 'undefined' || !document.createElement) return null;
    var S = 256;
    var cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    var g = cv.getContext('2d');
    if (!g) return null;
    var cw = S / DIST_COLS, chh = S / DIST_TILEROWS;
    var i, c, r, v;

    function rgba(a, b2, c2, al) {
      return 'rgba(' + (a | 0) + ',' + (b2 | 0) + ',' + (c2 | 0) + ',' + al.toFixed(3) + ')';
    }
    // Blobs are drawn nine times on the torus so the map wraps with no seam -
    // a seam on a tiling facade map is a vertical scar every N metres.
    function blob(x, y, rad, R, G, Bc, al) {
      g.fillStyle = rgba(R, G, Bc, al);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          g.beginPath(); g.arc(x + dx * S, y + dy * S, rad, 0, 6.28318); g.fill();
        }
      }
    }

    // ---- render coat --------------------------------------------------------
    // Deliberately BELOW sunlit plaster (#d9c3a0): a far city that out-values
    // the foreground it sits behind inverts the depth read of the whole frame.
    g.fillStyle = '#877f71'; g.fillRect(0, 0, S, S);
    for (i = 0; i < 120; i++) {
      v = rng.range(-26, 22);
      blob(rng.range(0, S), rng.range(0, S), rng.range(7, 42),
        135 + v, 127 + v * 0.95, 113 + v * 0.8, rng.range(0.10, 0.26));
    }
    // ---- storey bands + string courses --------------------------------------
    for (r = 0; r < DIST_TILEROWS; r++) {
      v = rng.range(-9, 9);
      g.fillStyle = rgba(135 + v, 127 + v, 113 + v, 0.24);
      g.fillRect(0, r * chh, S, chh);
      g.fillStyle = rgba(56, 52, 45, 0.36);            // shadow under the course
      g.fillRect(0, r * chh + chh - 2.4, S, 1.4);
      g.fillStyle = rgba(168, 160, 143, 0.55);         // the course itself, lit
      g.fillRect(0, r * chh + chh - 1.4, S, 1.4);
    }
    // ---- piers --------------------------------------------------------------
    // Never into row 0: that is the plain band, and a vertical there becomes a
    // comb of bars along every parapet in the city.
    for (c = 0; c < DIST_COLS; c++) {
      if (!rng.bool(0.55)) continue;
      g.fillStyle = rgba(152, 145, 129, 0.28);
      g.fillRect(c * cw + 1, chh, 3.5, S - chh);
      g.fillStyle = rgba(64, 60, 52, 0.20);
      g.fillRect(c * cw + 4.5, chh, 2, S - chh);
    }
    // ---- openings -----------------------------------------------------------
    for (r = 1; r <= DIST_ROWS; r++) {
      for (c = 0; c < DIST_COLS; c++) {
        if (rng.bool(0.09)) continue;                  // blind bay
        var ww = cw * rng.range(0.40, 0.58);
        var wh = chh * rng.range(0.40, 0.58);
        var wx = c * cw + (cw - ww) * 0.5 + rng.range(-1.5, 1.5);
        var wy = r * chh + chh * 0.26 + rng.range(-1.5, 1.5);
        // reveal first, so the opening has a depth edge and not a pasted rect
        g.fillStyle = rgba(46, 43, 38, 0.88);
        g.fillRect(wx - 1.6, wy - 1.6, ww + 3.2, wh + 3.2);
        var kind = rng.range(0, 1);
        if (kind < 0.18) {                             // boarded / shuttered
          v = rng.range(-16, 16);
          g.fillStyle = rgba(104 + v, 91 + v, 71 + v, 1);
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = rgba(62, 54, 42, 0.55);
          for (i = 1; i < 3; i++) g.fillRect(wx, wy + wh * i / 3, ww, 1);
        } else if (kind < 0.31) {                      // blown out
          g.fillStyle = rgba(20, 19, 18, 1);
          g.fillRect(wx, wy, ww, wh);
        } else {                                       // glazed, sky in the head
          v = rng.range(-10, 18);
          g.fillStyle = rgba(46 + v, 48 + v, 53 + v, 1);
          g.fillRect(wx, wy, ww, wh);
          g.fillStyle = rgba(126, 138, 154, rng.range(0.10, 0.36));
          g.fillRect(wx, wy, ww, wh * rng.range(0.16, 0.34));
        }
        // sill - the single brightest feature left on a hazed facade, and the
        // stain that weeps off one end of it
        g.fillStyle = rgba(182, 174, 156, 0.82);
        g.fillRect(wx - 1.8, wy + wh, ww + 3.6, 1.8);
        g.fillStyle = rgba(74, 69, 58, 0.20);
        g.fillRect(wx + rng.range(0, ww * 0.5), wy + wh + 1.8,
          ww * rng.range(0.18, 0.5), chh * rng.range(0.20, 0.55));
      }
    }
    // ---- grain --------------------------------------------------------------
    try {
      var id = g.getImageData(0, 0, S, S), dt = id.data;
      for (i = 0; i < dt.length; i += 4) {
        var nn = rng.range(-11, 11);
        dt[i] = M.clamp(dt[i] + nn, 0, 255);
        dt[i + 1] = M.clamp(dt[i + 1] + nn * 0.95, 0, 255);
        dt[i + 2] = M.clamp(dt[i + 2] + nn * 0.86, 0, 255);
      }
      g.putImageData(id, 0, 0);
    } catch (eg) { /* never throw out of a build */ }

    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    _distTex = tex;
    return tex;
  }

  // Roof furniture on a distant block. Deliberately THIN and TALL: the old
  // version emitted 0.7-1.5 m cubes, which at 80 m are three-pixel squares that
  // only thicken the roofline. What actually breaks a silhouette at that range
  // is a VERTICAL - a mast, a stair head, a tank up on a stand.
  function distantRoofJunk(B, x, y, z, w, d, rng, ct, col) {
    for (var i = 0; i < ct; i++) {
      var jx = x + rng.range(-0.34, 0.34) * w;
      var jz = z + rng.range(-0.34, 0.34) * d;
      var kind = rng.range(0, 1), e;
      if (kind < 0.34) {
        var tr = rng.range(0.45, 0.9), th = rng.range(0.9, 1.7), lh = rng.range(0.5, 1.3);
        e = B.add('distant', box(tr * 1.5, lh, tr * 0.24, 0.03), makeM(jx, y + lh * 0.5, jz));
        e.tint = col; e.dark = 0.45;
        e = B.add('distant', cyl(tr, tr, th, 8),
          makeM(jx, y + lh + th * 0.5, jz, 0, rng.range(0, 1.5), 0));
        e.tint = col; e.dark = rng.range(0.10, 0.32);
      } else if (kind < 0.64) {
        var mh = rng.range(2.6, 7.0);
        e = B.add('distant', box(0.11, mh, 0.11, 0.02), makeM(jx, y + mh * 0.5, jz));
        e.tint = col; e.dark = rng.range(0.28, 0.52);
        if (rng.bool(0.55)) {
          e = B.add('distant', box(rng.range(0.8, 1.6), 0.08, 0.08, 0.02),
            makeM(jx, y + mh * rng.range(0.55, 0.9), jz, 0, rng.range(0, 3.1), 0));
          e.tint = col; e.dark = 0.42;
        }
      } else {
        var bw = rng.range(0.10, 0.22) * w + 0.9, bd = rng.range(0.10, 0.22) * d + 0.9;
        var bh = rng.range(1.5, 3.0);
        e = B.add('distant', box(bw, bh, bd, 0.05),
          makeM(jx, y + bh * 0.5, jz, 0, rng.range(-0.3, 0.3), 0));
        e.tint = col; e.dark = rng.range(0, 0.20);
      }
    }
  }

  var DIST_HUE = [0xd9c3a0, 0xc9b08a, 0xbfae90, 0xcdb896, 0xb6ab97, 0xc4b49a, 0xada192];

  // One far-city block: mass, projecting parapet cap, an optional SET-BACK
  // upper enclosure, roof furniture, and the per-block window rhythm the facade
  // map is projected at.
  function distantBlock(B, rng, x, z, yaw, w, d, h) {
    var dist = Math.sqrt(x * x + (z + 8) * (z + 8));
    var t = M.clamp((dist - 34) / 110, 0, 1);
    // Per-block VALUE STEP. This is the term that stops ten blocks stacking
    // into one silhouette; the map alone cannot do it, because two adjacent
    // towers at the same value merge whatever is printed on them. The spread
    // NARROWS with distance - that is what aerial perspective does to contrast
    // - while the mean is left almost alone, because the global height fog
    // already owns depth cueing and double-counting it washes the far ring back
    // out to the white wall this replaced.
    // Measured: with the mean at 0.80 the nearest tower came back at luminance
    // 0.665 against a 0.619 sky, i.e. still out-valuing the sky it silhouettes
    // against. Distant massing in haze has to sit AT or just under the sky.
    // Measured on the rooftop framing after the first pass: the nearest tower
    // face came back at luminance 0.611 against a 0.538 sky directly above it,
    // i.e. the far city was 14% BRIGHTER than the air it is supposed to be
    // dissolving into, and desaturated to 0.24 against a 0.47 horizon - which is
    // exactly the "flat untextured light box" read. Massing in haze has to sit
    // AT or just under the sky and has to carry the haze's hue, so the value
    // comes down about 15% and tint() keeps far more of the sand hue at every
    // distance. The spread still narrows with range, because that is what aerial
    // perspective does to contrast.
    var spread = M.lerp(0.17, 0.075, t);
    var col = tint(rng.pick(DIST_HUE), M.lerp(0.76, 0.46, t) * rng.range(0.75, 1.15));
    col.multiplyScalar(M.lerp(0.565, 0.68, t) + rng.range(-spread, spread));
    var trim = col.clone().multiplyScalar(rng.range(1.06, 1.20));

    // Three pitch classes each way, chosen per block, so no two neighbours run
    // the same window rhythm even though they share one 256 px map.
    var pv = rng.pick([2.9, 3.4, 4.1]), pu = rng.pick([2.3, 3.0, 3.8]);
    // Anything over 15 m gets at least two tiles. With one, the tile's plain
    // band is a fifth of the whole mass, and on a tall block seen from a roof -
    // where only the top of it clears the near parapet - the ONLY thing visible
    // is that band, which put the flat pale slab straight back in frame.
    var tv = M.clamp(Math.round(h / (DIST_TILEROWS * pv)), h > 15 ? 2 : 1, 3);
    var tu = M.clamp(Math.round(w / (DIST_COLS * pu)), 1, 3);
    var ou = rng.int(0, DIST_COLS - 1) / DIST_COLS;

    var e = B.add('distant', box(w, h, d, 0.05), makeM(x, h * 0.5, z, 0, yaw, 0));
    e.tint = col;
    e.win = [w * 0.5, h * 0.5, d * 0.5, tu, tv, ou, 0];

    // a real projecting cap, not a bigger box stacked on top
    B.add('distant', box(w + 0.30, 0.55, d + 0.30, 0.04),
      makeM(x, h + 0.22, z, 0, yaw, 0)).tint = trim;

    var top = h + 0.5;
    if (rng.bool(0.62)) {
      // 0.6-1.2 m set-back upper enclosure: blockwork, no openings, so it maps
      // into the plain band. This is the single cheapest way to stop a distant
      // block terminating in one flat horizontal line.
      var sb = rng.range(0.6, 1.2);
      var aw = Math.max(2.6, w - sb * 2), ad = Math.max(2.6, d - sb * 2);
      // A ROOF ENCLOSURE, not another storey. Taller than about 2.6 m it starts
      // to read as a windowless upper floor, and windowless upper floors are
      // what made the far ring look like stacked cardboard in the first place.
      var ah = rng.range(1.1, 2.6);
      var ax = x + rng.range(-0.4, 0.4) * sb, az = z + rng.range(-0.4, 0.4) * sb;
      var att = B.add('distant', box(aw, ah, ad, 0.05),
        makeM(ax, h + ah * 0.5, az, 0, yaw, 0));
      att.tint = col; att.dark = rng.range(0.04, 0.20);
      B.add('distant', box(aw + 0.24, 0.36, ad + 0.24, 0.03),
        makeM(ax, h + ah + 0.14, az, 0, yaw, 0)).tint = trim;
      top = h + ah + 0.32;
      distantRoofJunk(B, ax, top, az, aw, ad, rng, rng.int(1, 3), col);
      if (rng.bool(0.5)) distantRoofJunk(B, x, h + 0.5, z, w, d, rng, 1, col);
    } else {
      distantRoofJunk(B, x, top, z, w, d, rng, rng.int(2, 4), col);
    }
    return e;
  }

  function buildDistantCity(B, rng) {
    // 'far' is 'wall' plus a BAKED sun/sky split (see _paint). The far ring is
    // deliberately excluded from the shadow cascades, so in practice its only
    // directional cue was a single N.L term that the height fog then flattened
    // to nothing: every face of every tower rendered at the same value, which is
    // why forty blocks read as one pale cardboard cut-out. Baking the split into
    // vertex colour costs nothing and is legitimate here precisely because this
    // geometry can never move, never be shadowed and is never seen up close.
    B.paint = 'far';
    var i, x, z, w, d, h;
    // a low cluster directly beyond the north arch, so the tunnel reads as
    // leading somewhere rather than into blank fog
    for (i = 0; i < 5; i++) {
      distantBlock(B, rng, rng.range(-17, 17), -rng.range(72, 104),
        rng.range(-0.35, 0.35), rng.range(9, 17), rng.range(9, 17), rng.range(8, 14));
    }
    for (i = 0; i < 46; i++) {
      var side = rng.bool() ? -1 : 1;
      var far = rng.range(34, 82);
      x = side * far * rng.range(0.55, 1.0);
      z = rng.range(-124, 40);
      // never close enough to read as part of the playable block - a distant
      // silhouette that crowds the real facades looks like a floating slab
      if (Math.abs(x) < 31 && z > -74 && z < 34) continue;
      w = rng.range(7, 19); d = rng.range(7, 19);
      // Height CLASSES, not one flat range. A uniform [6,21] draws a level top
      // line right across the ring, which is the other half of why ten blocks
      // read as one wall.
      var hc = rng.range(0, 1);
      h = hc < 0.48 ? rng.range(7, 12) : (hc < 0.85 ? rng.range(12, 19) : rng.range(19, 30));
      distantBlock(B, rng, x, z, rng.range(-0.4, 0.4), w, d, h);
    }
    // A minaret to break the flat skyline on the north-west horizon. Built as a
    // tapered octagonal shaft with a projecting muezzin's gallery and a slim
    // finial - three stacked boxes and a fat cone read as a chess pawn.
    var mx = -46, mz = -78;
    var mSh = tint(0xd9c3a0, 0.5), mTr = tint(0xc9b08a, 0.5);
    B.add('distant', box(4.6, 1.2, 4.6, 0.08), makeM(mx, 0.6, mz)).tint = mTr;
    B.add('distant', box(3.8, 1.6, 3.8, 0.08), makeM(mx, 2.0, mz)).tint = mSh;
    B.add('distant', cyl(1.10, 1.60, 16.0, 8), makeM(mx, 10.8, mz, 0, 0.39, 0)).tint = mSh;
    // gallery ring on its corbel course, at 0.72 of the height
    B.add('distant', cyl(1.55, 1.30, 0.45, 8), makeM(mx, 15.6, mz, 0, 0.39, 0)).tint = mTr;
    B.add('distant', cyl(1.30, 1.30, 0.90, 8), makeM(mx, 16.4, mz, 0, 0.39, 0)).tint = mSh;
    B.add('distant', cyl(1.42, 1.42, 0.16, 8), makeM(mx, 16.95, mz, 0, 0.39, 0)).tint = mTr;
    // upper shaft, cap and finial
    B.add('distant', cyl(0.78, 1.00, 4.6, 8), makeM(mx, 19.3, mz, 0, 0.39, 0)).tint = mSh;
    B.add('distant', cyl(0.10, 1.05, 2.3, 8), makeM(mx, 22.7, mz, 0, 0.39, 0)).tint = mTr;
    B.add('distant', cyl(0.06, 0.14, 0.90, 6), makeM(mx, 24.3, mz)).tint = mTr;
    B.paint = 'wall';
  }

  // Horizontal sun azimuth, for the baked far-city shading. Taken off the real
  // sun when the sky exists so the far ring can never disagree with the shadows
  // in the same frame; the fallback is the art direction's rake down -Z.
  function sunAzimuth(ctx, out) {
    out.set(0.06, 0, -0.998);
    try {
      var sd = ctx && ctx.sky && ctx.sky.sunDirection;
      if (sd && isFinite(sd.x) && (sd.x * sd.x + sd.z * sd.z) > 1e-4) {
        out.set(sd.x, 0, sd.z);
      }
    } catch (e) { /* the fallback rake is fine */ }
    return out.normalize();
  }

  // ============================================================== THE LEVEL ==
  function Level(ctx) {
    this.ctx = ctx || null;
    this.root = new THREE.Object3D();
    this.root.name = 'level';
    this.colliders = [];
    this.spawnPoints = [];
    this.navGrid = null;
    this.cameraPoses = {};
    this.meshes = [];
    this.instanced = [];
    this.scorches = [];
    this.streaks = [];
    // Published anchors for anyone who can draw a god ray: {origin, dir, width,
    // length, strength, kind}. `dir` is the direction of TRAVEL of the light.
    // Purely additive - nothing in the contract depends on it.
    this.lightShafts = [];
    this.wetPatches = [];
    this._matCache = Object.create(null);
    this._hash = new GAME.SpatialHash(4.5);
    this._stamp = 0;
    var seed = (ctx && ctx.seed) || 20260801;
    // A forked stream so the level is reproducible no matter what else has
    // pulled from ctx.rng before us.
    this.rng = (ctx && ctx.rng && ctx.rng.fork) ? ctx.rng.fork(0x51EE7) : new GAME.RNG(seed);
    this.noise = new GAME.Noise(seed ^ 0x4C56);
    this.roadFeatures = null;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-22, -1, Z_NORTH - 9),
      new THREE.Vector3(24, 26, Z_SOUTH + 8));
  }

  // ---- material access, defensively -----------------------------------------
  Level.prototype.material = function (key, forInstancing) {
    var ck = key + (forInstancing ? '|i' : '|v');
    if (this._matCache[ck]) return this._matCache[ck];
    var surf = SURF[key] || SURF.concrete;
    if (surf.own) {
      var mo = this._distantMaterial();
      this._matCache[ck] = mo;
      return mo;
    }
    var name = surf.base || key;
    var base = null;
    var lib = this.ctx && this.ctx.materials;
    if (lib && typeof lib.get === 'function') {
      try { base = lib.get(name); } catch (e) { GAME.logError('level.material:' + name, e); }
    }
    if (!base || !base.isMaterial) {
      var fb = FALLBACK[key] || FALLBACK.concrete;
      base = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
        roughness: fb[1], metalness: fb[2],
        transparent: key === 'glass', opacity: key === 'glass' ? 0.32 : 1.0
      });
      base.name = 'level_fallback_' + key;
    }
    var m = base;
    // Merged level geometry carries vertex colours (grime, streaks, tints).
    // Enabling them on the shared library material would turn every other
    // consumer's colour-less geometry black, so take a clone instead.
    var wantClone = (!forInstancing && !base.vertexColors) ||
      surf.rough !== undefined || surf.env !== undefined;
    if (wantClone) {
      try {
        m = base.clone();
        if (!forInstancing) { m.vertexColors = true; }
        m.name = (base.name || name) + (forInstancing ? '_lv' : '_vc');
        // Surface-level overrides: a puddle needs the concrete grain but not
        // its roughness, and no library material is going to volunteer that.
        // With a roughnessMap bound, `roughness` is a multiplier - which is
        // exactly what we want, and it leaves the shader defines alone.
        if (surf.rough !== undefined) m.roughness = surf.rough;
        if (surf.env !== undefined) m.envMapIntensity = surf.env;
      } catch (e2) { m = base; }
    }
    this._matCache[ck] = m;
    return m;
  };

  // Self-contained material for the far city. It is not in the library because
  // nothing else in the game is ever seen from 80 m, and a map whose smallest
  // feature is a whole window would be useless at arm's length.
  Level.prototype._distantMaterial = function () {
    var tex = null;
    try {
      var r = (this.rng && this.rng.fork) ? this.rng.fork(0xD157A) : this.rng;
      tex = distantFacadeTexture(r);
    } catch (e) { GAME.logError('level.distantTex', e); tex = null; }
    var fb = FALLBACK.distant;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(tex ? 0xffffff : fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: 0.0, vertexColors: true
    });
    if (tex) {
      try {
        var caps = this.ctx && this.ctx.renderer && this.ctx.renderer.capabilities;
        if (caps && caps.getMaxAnisotropy) {
          tex.anisotropy = Math.max(1, Math.min(8, caps.getMaxAnisotropy() || 1));
        }
      } catch (e2) { /* anisotropy is a nicety, never a failure */ }
      m.map = tex;
    }
    m.name = 'level_distantFacade';
    return m;
  };

  // Box-project the far city per block instead of world-projecting it.
  //
  // World projection is right for everything the player can walk up to and
  // wrong here for two reasons: it puts a single global lattice across every
  // tower (so all forty share one window rhythm and all their openings line up
  // across a hundred metres of city), and it cuts openings in half at every
  // corner. This maps each face to an INTEGER number of tiles of the facade
  // map, chosen per block from three pitch classes, so the rhythm differs
  // block to block, nothing is ever cut, and - because the tile's top band
  // carries no openings - the parapet band always lands exactly at the
  // roofline. Anything without a `win` record (roof furniture, parapet caps,
  // the minaret) is parked inside that plain band.
  Level.prototype._distantUV = function (entries, geo) {
    var uvA = geo && geo.attributes && geo.attributes.uv;
    if (!uvA) return;
    var uv = uvA.array;
    var vi = 0, e, i;
    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var sg = ent.geometry;
      var cnt = vertCount(sg);
      var pa = sg.attributes && sg.attributes.position;
      var na = sg.attributes && sg.attributes.normal;
      // Only non-indexed sources line up 1:1 with the merged buffer; every
      // geometry that reaches this bucket is, but never assume it.
      if (!pa || !na || sg.index || pa.count !== cnt) { vi += cnt; continue; }
      var win = ent.win;
      var hw = win ? win[0] : 1, hh = win ? win[1] : 1, hd = win ? win[2] : 1;
      var tu = win ? win[3] : 1, tv = win ? win[4] : 1;
      var ou = win ? win[5] : 0, ov = win ? win[6] : 0;
      // keep the pitch square around the block instead of stretching it
      var tuz = win ? Math.max(1, Math.round(tu * hd / Math.max(0.01, hw))) : 1;
      for (i = 0; i < cnt; i++) {
        var x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        var j = (vi + i) * 2;
        if (!win) {
          // Coarse enough that a 2 m parapet cap gets under one tile of the
          // band's grain rather than a fence of repeats.
          uv[j] = x * 0.26 + z * 0.10;
          uv[j + 1] = DIST_BANDC + M.clamp(y * 0.024, -DIST_BANDH, DIST_BANDH);
          continue;
        }
        var nx = Math.abs(na.getX(i)), ny = Math.abs(na.getY(i)), nz = Math.abs(na.getZ(i));
        if (ny >= nx && ny >= nz) {
          uv[j] = x * 0.20 + ou;
          uv[j + 1] = DIST_BANDC + M.clamp(z * 0.020, -DIST_BANDH, DIST_BANDH);
        } else if (nx >= nz) {
          uv[j] = (z / (2 * hd) + 0.5) * tuz + ou;
          uv[j + 1] = (y / (2 * hh) + 0.5) * tv + ov;
        } else {
          uv[j] = (x / (2 * hw) + 0.5) * tu + ou;
          uv[j + 1] = (y / (2 * hh) + 0.5) * tv + ov;
        }
      }
      vi += cnt;
    }
    uvA.needsUpdate = true;
  };

  // ---- colliders -------------------------------------------------------------
  Level.prototype.addCollider = function (cx, cy, cz, hx, hy, hz, material, isFloor, euler) {
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
  Level.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    var rng = this.rng, noise = this.noise;
    var B = new Builder();
    this._builder = B;
    var i;

    this.roadFeatures = {
      potholes: [], patches: [],
      manholes: [{ x: -0.4, z: 4.2 }, { x: 1.1, z: -14.6 }, { x: -1.6, z: -34.0 }],
      drains: [{ x: -4.55, z: 1.5 }, { x: 4.55, z: -9.0 }, { x: -4.55, z: -27.5 },
               { x: 4.55, z: -38.0 }]
    };
    for (i = 0; i < 16; i++) {
      this.roadFeatures.potholes.push({
        x: rng.range(-4.4, 4.4), z: rng.range(Z_NORTH - 3, Z_SOUTH + 3),
        r: rng.range(0.5, 1.7), d: rng.range(0.035, 0.115)
      });
    }
    for (i = 0; i < 11; i++) {
      var px = rng.range(-4.2, 4.2), pz = rng.range(Z_NORTH - 2, Z_SOUTH + 2);
      var pw = rng.range(0.9, 3.4), pd = rng.range(1.2, 5.0);
      this.roadFeatures.patches.push({
        x0: px - pw * 0.5, x1: px + pw * 0.5, z0: pz - pd * 0.5, z1: pz + pd * 0.5,
        h: rng.range(0.008, 0.028)
      });
    }

    var self = this;
    function stage(name, fn) {
      try { fn(); } catch (e) { GAME.logError('level.' + name, e); }
    }

    // ---- ground -------------------------------------------------------------
    stage('road', function () { buildRoad(B, self, rng, noise); });
    stage('sidewalk', function () { buildSidewalkBase(B); });
    stage('sand', function () { buildSandDrift(B, rng, noise); });
    // road collision as three camber steps per side - within 2 cm of the mesh
    var zMid = ((Z_SOUTH + 16) + (Z_NORTH - 18)) * 0.5;
    var zHalf = ((Z_SOUTH + 16) - (Z_NORTH - 18)) * 0.5;
    this.addCollider(0, -0.005 - 0.6, zMid, 1.5, 0.6, zHalf, 'asphalt', true);
    for (i = -1; i <= 1; i += 2) {
      this.addCollider(i * 2.25, -0.03 - 0.6, zMid, 0.75, 0.6, zHalf, 'asphalt', true);
      this.addCollider(i * 4.0, -0.09 - 0.6, zMid, 1.0, 0.6, zHalf, 'asphalt', true);
      this.addCollider(i * (FACADE_X + STREET_HALF) * 0.5, KERB_H - 0.6, zMid,
        (FACADE_X - STREET_HALF) * 0.5, 0.6, zHalf, 'concrete', true);
    }
    await GAME.yieldFrame();

    // ---- blocks --------------------------------------------------------------
    this.specs = [];
    for (i = 0; i < BLOCKS.length; i++) {
      var spec = makeSpec(BLOCKS[i], rng);
      this.specs.push(spec);
      /* jshint loopfunc:true */
      (function (sp) {
        stage('block:' + sp.id, function () { buildBlock(self, B, sp, rng); });
      })(spec);
      if ((i & 3) === 3) await GAME.yieldFrame();
    }
    await GAME.yieldFrame();

    // ---- flank walls exposed by the gaps -------------------------------------
    for (i = 0; i < GAPS.length; i++) {
      /* jshint loopfunc:true */
      (function (gap) {
        stage('gap', function () {
          for (var b = 0; b < BLOCKS.length; b++) {
            var blk = BLOCKS[b];
            if (blk.side !== gap.side) continue;
            if (Math.abs(blk.zN - gap.zS) < 0.05) buildFlank(self, B, blk, rng, true, gap);
            if (Math.abs(blk.zS - gap.zN) < 0.05) buildFlank(self, B, blk, rng, false, gap);
          }
        });
      })(GAPS[i]);
    }
    await GAME.yieldFrame();

    stage('terminator.n', function () { buildTerminator(self, B, rng, true); });
    stage('terminator.s', function () { buildTerminator(self, B, rng, false); });
    await GAME.yieldFrame();

    stage('courtyard', function () { buildCourtyard(self, B, rng); });
    stage('alley', function () { buildAlley(self, B, rng, noise); });
    stage('interior', function () { buildShopInterior(self, B, rng); });
    await GAME.yieldFrame();

    // ---- set pieces -----------------------------------------------------------
    stage('car', function () {
      // Rolled onto its flank so the exposed underside faces the street camera.
      B.push(makeM(-1.55, 1.02, -7.8, -1.58, 0.42, 0));
      buildCar(B, rng);
      B.pop();
      self.addCollider(-1.55, 0.78, -7.8, 2.1, 0.78, 0.95, 'metal');
      self.scorches.push({ p: new THREE.Vector3(-1.55, 0.4, -7.8), r: 4.6, k: 0.5 });
      // scorched halo on the road under it
      rubblePile(B, -1.2, -0.08, -6.2, 1.6, 0.16, 22, rng);
    });
    stage('sandbags', function () { buildSandbags(self, B, rng, noise); });
    stage('barriers', function () { buildBarriers(self, B, rng, noise); });
    stage('shelter', function () { buildBusShelter(self, B, rng); });
    stage('balcony', function () { buildCollapsedBalcony(self, B, rng); });
    stage('rubble', function () {
      // rubble at the foot of the collapsed corner, and in the north passage
      rubblePile(B, -6.0, -0.02, -32.6, 3.4, 1.0, 110, rng);
      self.addCollider(-6.0, 0.35, -32.6, 2.6, 0.45, 2.4, 'gravel', true);
      rubblePile(B, 6.2, -0.02, -18.5, 2.4, 0.7, 70, rng);
      self.addCollider(6.2, 0.28, -18.5, 1.8, 0.35, 1.8, 'gravel', true);
      rubblePile(B, 0.0, -0.02, -50.5, 3.6, 0.55, 80, rng);
      rubblePile(B, 8.6, 0.14, -5.0, 1.5, 0.4, 34, rng);
    });
    stage('cables', function () { buildCables(self, B, rng); });
    stage('outerground', function () { buildOuterGround(B, self, rng, noise); });
    stage('distant', function () { buildDistantCity(B, rng); });
    await GAME.yieldFrame();

    // ---- realise the geometry -------------------------------------------------
    stage('merge', function () { self._finalize(B); });
    stage('instanced', function () { buildKerbsAndPaving(self, rng, noise); });
    await GAME.yieldFrame();

    stage('nav', function () { self._buildNav(); });
    stage('spawns', function () { self._buildSpawns(); });
    stage('broadphase', function () { self._buildBroadphase(); });

    if (this.ctx && this.ctx.scene) this.ctx.scene.add(this.root);

    // cached construction geometry is no longer referenced by anything live
    _boxCache.forEach(function (g) { g.dispose(); }); _boxCache.clear();
    _pillowCache.forEach(function (g) { g.dispose(); }); _pillowCache.clear();
    for (i = 0; i < _sackCache.length; i++) { if (_sackCache[i]) _sackCache[i].dispose(); }
    _sackCache.length = 0;
    _cylCache.forEach(function (g) { g.dispose(); }); _cylCache.clear();
    _profCache.forEach(function (g) { g.dispose(); }); _profCache.clear();
    this._builder = null;
    return this;
  };

  Level.prototype.update = function () { /* level geometry is static */ };

  // ---- merge + vertex-colour pass --------------------------------------------
  Level.prototype._finalize = function (B) {
    var keys = Object.keys(B.buckets);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var entries = B.buckets[key];
      if (!entries || !entries.length) continue;
      var geo;
      try { geo = Geo.mergeAll(entries); }
      catch (e) { GAME.logError('level.merge:' + key, e); continue; }
      var surf = SURF[key] || SURF.concrete;
      Geo.worldUV(geo, surf.uv);
      if (surf.own) {
        // The far ring is box-projected per block, not world-projected: see
        // _distantUV. worldUV above just guarantees the attribute exists.
        try { this._distantUV(entries, geo); }
        catch (e4) { GAME.logError('level.distantUV', e4); }
      } else {
        try { this._stochasticUV(key, entries, geo); }
        catch (e3) { GAME.logError('level.uv:' + key, e3); }
      }
      Geo.copyUV1(geo);                       // three.js reads aoMap from uv1
      try { this._paint(key, entries, geo); }
      catch (e2) { GAME.logError('level.paint:' + key, e2); }
      geo.computeBoundingSphere();
      var mesh = new THREE.Mesh(geo, this.material(key, false));
      mesh.name = 'level_' + key;
      mesh.castShadow = surf.cast;
      mesh.receiveShadow = surf.recv;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.root.add(mesh);
      this.meshes.push(mesh);
      B.buckets[key] = null;
    }
  };

  // ---- stochastic UV ---------------------------------------------------------
  // Geo.worldUV lays ONE continuous planar projection over the whole level, so
  // every material repeats on an exact, axis-aligned, world-space lattice: at
  // plaster's 0.36 uv/m that is a hard 2.78 m grid running dead level along
  // fourteen facades. A rigid grid is what the eye reads as "texture tiling"
  // long before it can name the texture, and no amount of albedo tuning in the
  // vertex-colour pass removes a grid.
  //
  // Two things happen here. Neither needs a custom shader, because materials
  // are owned by another module, shared between consumers, and must not be
  // mutated from in here.
  //
  //  1. A low-frequency DOMAIN WARP of the uv field. The lattice stops being a
  //     lattice - rows bend, phase drifts across a facade, and two windows 6 m
  //     apart no longer sit on the same texel - while the mapping stays C1
  //     continuous across every face and every merged box, so no seam appears
  //     anywhere. Amplitude is expressed in TILES, not metres, so a surface at
  //     any texel density gets the same relative break-up.
  //
  //     Deliberately NOT per-tile random rotation. These textures carry
  //     gravity-driven streaking and directional trowel marks; rotating a
  //     quarter of every wall by 90 degrees runs the weathering sideways, which
  //     is a worse and much more expensive-looking artefact than the repeat it
  //     was meant to cure. Warping translates, it never rotates.
  //
  //     The warp gradient is held to roughly +/-17% of the base uv rate at
  //     typical amplitude, so texel density wobbles like real render thickness
  //     rather than smearing.
  //
  //  2. Explicit per-entry uv rotation/offset for pieces that ASK for it via
  //     `uvRot` / `uvOff` - the shop floor's four tile fields and its lifted
  //     individual tiles, where a visible joint between differently-laid areas
  //     is exactly the desired read.
  //
  // Surfaces the library projects triplanar ignore the uv attribute entirely,
  // in which case this is a no-op that costs a build-time loop and nothing else.
  var UVWARP = {
    plaster: 1.00, concrete_wall: 1.00, backdrop: 0.9, brick: 0.85,
    concrete: 0.80, precast: 0.55, asphalt: 0.65, sand: 0.75, gravel: 0.60,
    rooffelt: 0.55, tile: 0.45, wood_plank: 0.35, distant: 0.5,
    corrugated_metal: 0.0, rusted_metal: 0.30, painted_metal: 0.25,
    fabric: 0.0, sandbag: 0.0, glass: 0.0, rubber: 0.0, wet: 0.35
  };
  // world-space frequency of the warp (1/m) and its amplitude in tiles
  var UVW_F = 0.055, UVW_A = 0.55;

  Level.prototype._stochasticUV = function (key, entries, geo) {
    var uvA = geo && geo.attributes && geo.attributes.uv;
    if (!uvA) return;
    var uv = uvA.array;
    var posA = geo.attributes.position;
    var pa = posA.array;
    var i, j, e;

    // ---- (2) explicit per-entry uv frame ------------------------------------
    // Runs first so a rotated tile field still gets warped with its neighbours
    // and cannot separate out as a differently-behaved island.
    var vi = 0;
    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var rot = ent.uvRot || 0, off = ent.uvOff;
      if (rot || off) {
        var ca = Math.cos(rot), sa = Math.sin(rot);
        var ox = 0, oy = 0;
        for (i = 0; i < cnt; i++) { j = (vi + i) * 2; ox += uv[j]; oy += uv[j + 1]; }
        ox /= (cnt || 1); oy /= (cnt || 1);
        var dx = off ? off[0] : 0, dy = off ? off[1] : 0;
        for (i = 0; i < cnt; i++) {
          j = (vi + i) * 2;
          var u0 = uv[j] - ox, v0 = uv[j + 1] - oy;
          uv[j] = ox + u0 * ca - v0 * sa + dx;
          uv[j + 1] = oy + u0 * sa + v0 * ca + dy;
        }
      }
      vi += cnt;
    }

    // ---- (1) domain warp ----------------------------------------------------
    var w = UVWARP[key];
    if (w === undefined) w = 0.7;
    if (w > 0) {
      var n = this.noise, N = posA.count;
      var A = UVW_A * w, F = UVW_F;
      for (i = 0; i < N; i++) {
        var px = pa[i * 3], py = pa[i * 3 + 1], pz = pa[i * 3 + 2];
        j = i * 2;
        // two decorrelated fbm fields, 2 octaves -> 18 m and 9 m wavelengths
        uv[j] += A * n.fbm3(px * F, py * F * 0.8, pz * F, 2);
        uv[j + 1] += A * n.fbm3(px * F + 41.3, py * F * 0.8 - 17.9, pz * F + 63.1, 2);
      }
    }
    uvA.needsUpdate = true;
  };

  // Whatever the material library hands back for 'sandbag', the revetment has
  // to end up hessian. So MEASURE the material - the mean colour of its albedo
  // map times the neutral gain three.js is multiplying it by - and solve the
  // vertex-colour multiplier that lands that measurement on jute. If the
  // library is already returning real jute the correction comes out at ~1 and
  // nothing happens; if it is still routing through the red awning canvas the
  // correction neutralises it. Vertex colour is an unclamped multiplier, so a
  // correction above 1 is legal.
  var SACK_TARGET = 0xb0a07c;

  // Mean LINEAR colour of a material's albedo map, or null if it cannot be
  // read (DataTexture without pixels, no 2d context, cross-origin, ...).
  var _meanCanvas = null;
  Level.prototype._mapMean = function (mat) {
    try {
      var tex = mat && mat.map;
      var img = tex && tex.image;
      if (!img) return null;
      var srgb = !tex.colorSpace || tex.colorSpace === THREE.SRGBColorSpace;
      var r = 0, g = 0, b = 0, n = 0, i;
      function acc(v0, v1, v2) {
        var f0 = v0 / 255, f1 = v1 / 255, f2 = v2 / 255;
        if (srgb) {
          f0 = f0 <= 0.04045 ? f0 / 12.92 : Math.pow((f0 + 0.055) / 1.055, 2.4);
          f1 = f1 <= 0.04045 ? f1 / 12.92 : Math.pow((f1 + 0.055) / 1.055, 2.4);
          f2 = f2 <= 0.04045 ? f2 / 12.92 : Math.pow((f2 + 0.055) / 1.055, 2.4);
        }
        r += f0; g += f1; b += f2; n++;
      }
      if (img.data && img.data.length && img.width) {
        // DataTexture: walk the buffer directly on a coarse stride
        var w = img.width, h = img.height || 1, ch = img.data.length / (w * h);
        if (ch < 3) return null;
        var step = Math.max(1, Math.floor(Math.sqrt(w * h) / 24));
        var isF = !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray);
        for (var yy = 0; yy < h; yy += step) {
          for (var xx = 0; xx < w; xx += step) {
            var o = (yy * w + xx) * ch;
            if (isF) { r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++; }
            else acc(img.data[o], img.data[o + 1], img.data[o + 2]);
          }
        }
        if (isF && n) { return new THREE.Color(r / n, g / n, b / n); }
      } else if (typeof document !== 'undefined' && (img.width || img.videoWidth)) {
        var N = 24;
        if (!_meanCanvas) {
          _meanCanvas = document.createElement('canvas');
          _meanCanvas.width = N; _meanCanvas.height = N;
        }
        var cx2 = _meanCanvas.getContext('2d', { willReadFrequently: true });
        if (!cx2) return null;
        cx2.clearRect(0, 0, N, N);
        cx2.drawImage(img, 0, 0, N, N);
        var d = cx2.getImageData(0, 0, N, N).data;
        for (i = 0; i < d.length; i += 4) acc(d[i], d[i + 1], d[i + 2]);
      }
      if (!n) return null;
      return new THREE.Color(r / n, g / n, b / n);
    } catch (e) { return null; }
  };

  // `lumScale` is the LINEAR albedo the corrected surface should end up at, so
  // the result can never run away however dark or bright the library's map is:
  // the hue is rebased onto the target and the level is pinned by hand.
  function lumOf(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
  Level.prototype._albedoCorrection = function (key, targetHex, fallback, lumScale) {
    var c = new THREE.Color(fallback[0], fallback[1], fallback[2]);
    try {
      var m = this.material(key, false);
      var mc = m && m.color;
      if (!mc || Math.max(mc.r, Math.max(mc.g, mc.b)) <= 0.01) return c;
      var t = new THREE.Color().setHex(targetHex, THREE.SRGBColorSpace);
      var lt = lumOf(t);
      if (lt < 1e-4) return c;
      // effective albedo = map mean x material colour (the library's own gain)
      var mean = this._mapMean(m);
      var er = mc.r, eg = mc.g, eb = mc.b;
      if (mean && (mean.r + mean.g + mean.b) > 0.003) {
        er *= mean.r; eg *= mean.g; eb *= mean.b;
      }
      var k = (lumScale || lt) / lt;
      c.setRGB(M.clamp(t.r / Math.max(0.004, er) * k, 0.12, 8),
        M.clamp(t.g / Math.max(0.004, eg) * k, 0.12, 8),
        M.clamp(t.b / Math.max(0.004, eb) * k, 0.12, 8));
    } catch (e) { /* keep the fallback */ }
    return c;
  };

  // Vertex colours are a multiplier on albedo. Everything here is about
  // breaking uniformity: macro blotching, grime rising off the ground, streaks
  // weeping below openings, sun bleach on up-facing surfaces, and soot.
  Level.prototype._paint = function (key, entries, geo) {
    var pos = geo.attributes.position, nrm = geo.attributes.normal;
    var pa = pos.array, na = nrm.array;
    var N = pos.count;
    var col = new Float32Array(N * 3);
    var noise = this.noise;
    var scor = this.scorches, streaks = this.streaks;
    var vi = 0, e, i, j;
    var sunA = sunAzimuth(this.ctx, _tmpV);
    var sunAx = sunA.x, sunAz = sunA.z;
    var cr = 1, cg = 1, cb = 1;
    if (key === 'sandbag') {
      var cc = this._albedoCorrection('sandbag', SACK_TARGET, [1.10, 0.98, 0.78], 0.235);
      cr = cc.r; cg = cc.g; cb = cc.b;
    } else if (key === 'rooffelt') {
      // The roof deck borrows 'gravel', whose value is a path surface, not a
      // roof covering. Pin it by measurement rather than by a guessed constant.
      var cf = this._albedoCorrection('rooffelt', FELT_TARGET, [1.55, 1.48, 1.34], 0.155);
      cr = cf.r; cg = cf.g; cb = cf.b;
    }

    for (e = 0; e < entries.length; e++) {
      var ent = entries[e];
      var cnt = vertCount(ent.geometry);
      var tr = cr, tg = cg, tb = cb;
      if (ent.tint) { tr *= ent.tint.r; tg *= ent.tint.g; tb *= ent.tint.b; }
      var t2r = tr, t2g = tg, t2b = tb;
      if (ent.tint2) { t2r = cr * ent.tint2.r; t2g = cg * ent.tint2.g; t2b = cb * ent.tint2.b; }
      var dk = ent.dark ? Math.max(0.05, 1 - ent.dark) : 1;
      var mode = ent.paint || 'wall';
      var stripeX = ent.stripeAxis === 'x';

      // Only the scorch/streak sources near this piece can affect it; testing
      // all of them per vertex would cost millions of distance checks.
      var ex = ent.matrix.elements[12], ey = ent.matrix.elements[13], ez = ent.matrix.elements[14];
      var localScor = null, localStreak = null;
      for (i = 0; i < scor.length; i++) {
        var sc = scor[i];
        var sdx = sc.p.x - ex, sdy = sc.p.y - ey, sdz = sc.p.z - ez;
        if (sdx * sdx + sdy * sdy + sdz * sdz < (sc.r + 3.5) * (sc.r + 3.5)) {
          (localScor || (localScor = [])).push(sc);
        }
      }
      for (i = 0; i < streaks.length; i++) {
        var st = streaks[i];
        var tdx = st.p.x - ex, tdz = st.p.z - ez;
        if (tdx * tdx + tdz * tdz < 9) (localStreak || (localStreak = [])).push(st);
      }

      for (i = 0; i < cnt; i++) {
        j = (vi + i) * 3;
        var x = pa[j], y = pa[j + 1], z = pa[j + 2];
        var nx = na[j], ny = na[j + 1], nz = na[j + 2];
        var r = tr, g = tg, b = tb, f = 1;

        if (mode === 'canopy') {
          var su = stripeX ? x : z;
          var band = su * 2.35;
          band = band - Math.floor(band);
          if (band < 0.5) { r = t2r; g = t2g; b = t2b; }
          f = 0.86 + 0.2 * (noise.fbm2(x * 0.9, z * 0.9, 2) * 0.5 + 0.5);
          // sun-bleached along the crest, grubby toward the fringe
          f *= 1 - M.saturate((0.5 - ny) * 0.22);
        } else if (mode === 'road') {
          var d = Math.abs(x);
          var gut = M.smoothstep(3.3, 5.0, d);
          var wob = noise.fbm2(x * 0.42, z * 0.42, 4) * 0.5 + 0.5;
          var fine = noise.fbm2(x * 2.6, z * 2.6, 2) * 0.5 + 0.5;
          // Sun-baked asphalt is a MID grey. The old 0.80 floor plus a 0.4 oil
          // multiply crushed the crown of the road to near-black in every
          // eye-level frame while the sky blew out in the same shot.
          f = 0.96 + wob * 0.25 + fine * 0.09;
          // wheel paths polished, crown stained with oil, sand in the gutter
          var track = Math.exp(-Math.pow((d - 1.7) * 1.5, 2));
          f *= 1 + track * 0.10;
          var oil = M.smoothstep(0.62, 0.92, noise.fbm2(x * 0.8 + 11, z * 0.5 - 7, 3) * 0.5 + 0.5)
            * (1 - M.smoothstep(0.0, 2.6, d));
          f *= 1 - oil * 0.28;
          var sand = M.saturate(gut * (0.35 + 0.65 * wob));
          // A fine dust film over the WHOLE carriageway, not just the gutter.
          // Without it the road is a neutral dark surface lit only by a cool
          // sky in shadow, and a neutral dark surface under cool light plus a
          // teal shadow grade reads BLUE-PURPLE - which is what the enemy and
          // firefight framings showed across their entire lower half.
          var film = M.saturate(0.30 + 0.44 * wob);
          r = f * M.lerp(1.0, 1.34, sand) * (1 + film * 0.14);
          g = f * M.lerp(1.0, 1.24, sand) * (1 + film * 0.085);
          b = f * M.lerp(1.0, 1.03, sand) * (1 + film * 0.010);
          col[j] = r * dk; col[j + 1] = g * dk; col[j + 2] = b * dk;
          continue;
        } else if (mode === 'burn') {
          var bn = noise.fbm3(x * 2.2, y * 2.2, z * 2.2, 4) * 0.5 + 0.5;
          var rust = M.smoothstep(0.54, 0.86, bn);
          // Charred steel is dark but NEVER flat black - it goes chalky grey
          // where the paint burned off and orange where it has since rusted.
          var soot = 0.30 + bn * 0.34;
          r = soot + rust * 0.34; g = soot + rust * 0.17; b = soot + rust * 0.06;
          var ash = M.smoothstep(0.72, 1.0, bn) * 0.28;
          r += ash; g += ash * 0.98; b += ash * 0.92;
          // panels that faced up burned hotter and are chalkier
          if (ny > 0.4) { r *= 1.24; g *= 1.20; b *= 1.14; }
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'sack') {
          // Per-bag variation at a scale of one bag, plus sun bleach on the
          // crown and ground grime up the first course. Identically-shaded
          // sacks read as a masonry course however lumpy the geometry is.
          var sn = noise.fbm3(x * 2.6, y * 3.4, z * 2.6, 3) * 0.5 + 0.5;
          f = 0.80 + sn * 0.42;
          f *= 1 + M.saturate(ny) * 0.16;                 // bleached tops
          f *= 1 - M.saturate((0.35 - y) / 0.5) * 0.22;   // splash at the foot
          var damp = M.smoothstep(0.62, 0.9, sn) * 0.2;   // still-damp fill
          r = f * (1 - damp * 0.1); g = f * (1 - damp * 0.2); b = f * (1 - damp * 0.34);
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'jersey') {
          // Precast concrete: aggregate mottle, a chalky bloom on the top
          // surfaces and a hard band of road splash up the bottom 200 mm. The
          // splash is what grounds the barrier instead of letting it float.
          var jn = noise.fbm3(x * 1.8, y * 1.8, z * 1.8, 3) * 0.5 + 0.5;
          var jf = noise.fbm3(x * 7.5, y * 7.5, z * 7.5, 2) * 0.5 + 0.5;
          f = 0.72 + jn * 0.32 + jf * 0.12;
          f *= 1 + M.saturate((ny - 0.3) / 0.7) * 0.13;
          // Road splash reaches higher and bites harder than 30%: the bottom
          // 300 mm of a street barrier is the dirtiest surface in the scene,
          // and it is the only thing that grounds the unit to the carriageway.
          var splash = M.smoothstep(0.42, 0.01, y - ey);
          f *= 1 - splash * 0.46;
          r = f * (1 - splash * 0.04); g = f * (1 - splash * 0.11); b = f * (1 - splash * 0.24);
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'felt') {
          // A felt roof is not one material: it is bitumen, mineral chippings,
          // patch repairs of three different ages, dust, and the dark green
          // stain of everywhere the falls are wrong and water stands. Vertex
          // colour can only carry what the geometry can resolve, so this is
          // deliberately LOW frequency - the chipping grain comes from the map,
          // the sheet-to-sheet value break comes from per-sheet `dark`, and
          // this supplies the wide drifts between them.
          var pn = noise.fbm2(x * 0.22, z * 0.22, 3) * 0.5 + 0.5;
          var pn2 = noise.fbm2(x * 0.72 + 13.1, z * 0.72 - 4.6, 2) * 0.5 + 0.5;
          f = 0.80 + pn * 0.26 + pn2 * 0.16;
          var pond = M.smoothstep(0.60, 0.94, pn);
          f *= 1 - pond * 0.26;
          var dust = M.saturate((pn2 * 0.7 + pn * 0.5 - 0.32) * 1.5);
          r = f * M.lerp(1.0, 1.30, dust);
          g = f * M.lerp(1.0, 1.19, dust) * (1 - pond * 0.05);
          b = f * M.lerp(1.0, 0.98, dust) * (1 - pond * 0.14);
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'rubble') {
          var rn = noise.fbm3(x * 1.4, y * 1.4, z * 1.4, 3) * 0.5 + 0.5;
          f = 0.72 + rn * 0.44;
          // powdered concrete dust settles on every up-face
          var up = M.saturate((ny - 0.2) / 0.8);
          r = f * (1 + up * 0.16); g = f * (1 + up * 0.12); b = f * (1 + up * 0.05);
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'outer') {
          // The desert plain outside the block. The global height fog caps at
          // 0.86 opacity, so even at 400 m this surface still contributes 14%
          // of its own value - and 14% of a dark sand plane against a bright
          // hazed sky is a visible, dead-straight horizon seam. Lift the rim's
          // albedo toward the haze until that residual has almost no contrast
          // left to draw the line with. Near the block nothing changes: the
          // lift is zero inside 90 m, where this reads as ordinary ground.
          var orr = Math.sqrt(x * x + (z + 18) * (z + 18));
          var on = noise.fbm2(x * 0.02, z * 0.02, 3) * 0.5 + 0.5;
          var on2 = noise.fbm2(x * 0.16 + 5.2, z * 0.16 - 8.8, 2) * 0.5 + 0.5;
          f = 0.90 + on * 0.22 + on2 * 0.10;
          var oLift = M.smoothstep(90, 370, orr);
          f *= 1 + oLift * 1.55;
          r = f * 1.03; g = f * (1 - oLift * 0.02); b = f * (0.92 + oLift * 0.05);
          col[j] = r * tr * dk; col[j + 1] = g * tg * dk; col[j + 2] = b * tb * dk;
          continue;
        } else if (mode === 'flat') {
          col[j] = r * dk; col[j + 1] = g * dk; col[j + 2] = b * dk;
          continue;
        } else {
          // 'wall', 'ground' and 'far'
          // Two scales of blotching. The wall geometry used to carry its own
          // per-cell variation and that read as tiling; all of the surface
          // interest now lives here, where it costs nothing and has no edges.
          var nLow = noise.fbm3(x * 0.085, y * 0.06, z * 0.085, 3);
          var nMid = noise.fbm3(x * 0.44, y * 0.36, z * 0.44, 2);
          f = 1 + nLow * 0.09 + nMid * 0.085;
          var grime = mode === 'ground'
            ? 0.16 + 0.2 * (noise.fbm2(x * 0.6, z * 0.6, 3) * 0.5 + 0.5)
            : Math.pow(M.smoothstep(2.5, 0.02, y), 1.6) * 0.44;
          var vert = 1 - Math.abs(ny);
          if (vert > 0.4) {
            // vertical weeping below sills; the 3.05 m interval matches the
            // typical floor pitch so the streaks land under the openings
            var u = (Math.abs(nx) > Math.abs(nz)) ? z : x;
            var s = noise.fbm2(u * 2.7, y * 0.10, 3) * 0.5 + 0.5;
            var ph = y * 0.3279; ph = ph - Math.floor(ph);
            f *= 1 - M.smoothstep(0.55, 0.93, s) * (1 - M.smoothstep(0, 0.6, ph)) * vert * 0.30;
          }
          if (ny > 0.5) f *= 1.05;                     // dust + bleach on top faces
          var warm = grime;
          r = tr * f * (1 - warm * 0.30);
          g = tg * f * (1 - warm * 0.40);
          b = tb * f * (1 - warm * 0.58);
          // Big irregular render patches: a wall that has been made good twice
          // in forty years is never one colour, and this is the term that stops
          // a coalesced 4 m panel reading as a single flat plane.
          if (mode === 'wall' || mode === 'far') {
            var rep = M.smoothstep(0.16, 0.62, nLow + nMid * 0.4);
            r *= 1 - rep * 0.055; g *= 1 - rep * 0.020; b *= 1 + rep * 0.075;
          }
          if (mode === 'far') {
            // Baked sun/sky split for the far ring. A face turned toward the sun
            // azimuth takes warm key, a face turned away takes cool sky fill,
            // and the up-faces take both. +-14% is deliberately modest: this is
            // FORM, not lighting, and the height fog is going to compress it -
            // pushed harder the towers start reading as painted flats.
            var fdot = nx * sunAx + nz * sunAz;              // -1 away .. +1 into
            var lit = M.saturate(fdot * 0.5 + 0.5);
            var facing = 1 - Math.abs(ny);                   // 0 on a roof deck
            var kf = 1 + (lit - 0.5) * 0.28 * facing;
            r *= kf * (1 + (lit - 0.5) * 0.075 * facing);
            g *= kf;
            b *= kf * (1 - (lit - 0.5) * 0.095 * facing);
            // roofs and caps read one step up: they see the whole sky
            if (ny > 0.55) { r *= 1.07; g *= 1.07; b *= 1.09; }
            // Aerial perspective WITHIN a block. A 20 m tower renders as one
            // 80 px quad, and vertex colour on a bevelled box is the only place
            // a gradient can live: without it the tallest faces measured a
            // standard deviation of 0.029, which is a flat single-colour surface
            // by any definition. Height fog is denser at the base, so the foot
            // of a distant block genuinely sits closer to the haze than its top.
            var hz = 1.055 - 0.115 * M.saturate(y / 26);
            r *= hz; g *= hz * 0.998; b *= hz * 0.994;
          }
        }

        // localised rust/dirt weeping from pipes and scuppers
        if (localStreak) {
          for (var q = 0; q < localStreak.length; q++) {
            var s2 = localStreak[q];
            var ddx = x - s2.p.x, ddz = z - s2.p.z;
            var lat = Math.sqrt(ddx * ddx + ddz * ddz);
            if (lat > s2.r) continue;
            var below = M.saturate((s2.p.y - y) / 3.2);
            var amt = (1 - lat / s2.r) * below * 0.5;
            r *= 1 - amt * 0.10; g *= 1 - amt * 0.28; b *= 1 - amt * 0.42;
          }
        }
        // soot
        if (localScor) {
          for (var s3 = 0; s3 < localScor.length; s3++) {
            var sc2 = localScor[s3];
            var cdx = x - sc2.p.x, cdy = y - sc2.p.y, cdz = z - sc2.p.z;
            var cd = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);
            if (cd > sc2.r) continue;
            var a = Math.pow(1 - cd / sc2.r, 1.6) * (sc2.k || 0.55);
            // soot desaturates as well as darkens - pure multiply looks like paint
            var lum = (r + g + b) * 0.3333;
            r = M.lerp(r, lum * 0.30, a); g = M.lerp(g, lum * 0.29, a); b = M.lerp(b, lum * 0.30, a);
          }
        }
        col[j] = r * dk; col[j + 1] = g * dk; col[j + 2] = b * dk;
      }
      vi += cnt;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  };

  // ---- walkable surfaces ------------------------------------------------------
  var WALK = [
    { x0: -STREET_HALF, x1: STREET_HALF, z0: Z_NORTH - 7, z1: Z_SOUTH + 6, y: -0.04 },
    { x0: -FACADE_X, x1: -STREET_HALF, z0: Z_NORTH - 7, z1: Z_SOUTH + 6, y: KERB_H },
    { x0: STREET_HALF, x1: FACADE_X, z0: Z_NORTH - 7, z1: Z_SOUTH + 6, y: KERB_H },
    { x0: FACADE_X, x1: 20.8, z0: -6.7, z1: -3.0, y: KERB_H },          // alley
    { x0: -19.0, x1: -FACADE_X, z0: -8.4, z1: -4.0, y: KERB_H },        // courtyard
    { x0: -14.8, x1: -FACADE_X, z0: -3.7, z1: 5.6, y: 0.16 },           // shop floor
    { x0: -18.6, x1: -FACADE_X, z0: -20.8, z1: -8.4, y: 9.0 }           // W3 roof
  ];

  Level.prototype.sampleGround = function (x, z) {
    for (var i = 0; i < 6; i++) {
      var w = WALK[i];
      if (x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1) {
        if (i === 0 && this.roadFeatures) return roadY(x, z, this.roadFeatures, this.noise);
        return w.y;
      }
    }
    return 0;
  };

  // Rasterise the walkable regions, then knock out anything an obstacle box
  // occupies between ankle and chest height. Coarse boxes, not triangles - the
  // AI only needs to know where it can put its feet.
  Level.prototype._buildNav = function () {
    var cell = 0.5;
    var ox = -21, oz = Z_NORTH - 9;
    var w = Math.ceil((25 - ox) / cell), h = Math.ceil((Z_SOUTH + 8 - oz) / cell);
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
        var y = -1e9;
        for (var r = 0; r < WALK.length; r++) {
          var R = WALK[r];
          if (x < R.x0 || x > R.x1 || z < R.z0 || z > R.z1) continue;
          var ry = (r === 0 && this.roadFeatures) ? roadY(x, z, this.roadFeatures, this.noise) : R.y;
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
      // convenience for ai.js - never assume it exists, but it is cheap to give
      at: function (px, pz) {
        var gx = Math.floor((px - ox) / cell), gz = Math.floor((pz - oz) / cell);
        if (gx < 0 || gz < 0 || gx >= w || gz >= h) return 0;
        return walkable[gz * w + gx];
      }
    };
  };

  Level.prototype._buildSpawns = function () {
    var self = this;
    function sp(x, z, yaw) {
      self.spawnPoints.push({
        position: new THREE.Vector3(x, self.sampleGround(x, z) + 0.02, z), yaw: yaw
      });
    }
    // [0] is the player: south end of the street, looking north down -Z.
    sp(0.9, 14.6, 0.03);
    sp(-3.4, 9.2, 0.05);  sp(3.6, 6.4, -0.08);
    sp(-2.2, -3.5, 0.1);  sp(2.8, -12.0, 0.2);
    sp(-3.9, -22.5, 0.0); sp(3.2, -30.0, 0.15);
    sp(-1.0, -41.0, 0.0); sp(11.5, -4.9, 1.55);
    sp(-11.0, 1.4, -1.2); sp(-12.0, -6.2, -0.6);

    // Framings. Chosen as a cinematographer would: a strong foreground mass,
    // the kerb and cable lines leading to the arch at the vanishing point, the
    // camera off-centre so the street reads on the thirds, and the low sun
    // raking along -Z through the gaps at z = -5 and z = -34.
    var V = THREE.Vector3;
    this.cameraPoses = {
      // Lower and less steep than before: at 20 m and -26 degrees the two roof
      // planes ate 40% of the frame and the canyon flattened into a plan view
      // with the arch a 30 px smear. From here the roofs are a bottom band, the
      // east row holds the right third, and the arch sits on the upper-third
      // line where the haze gradient can silhouette it.
      overview: { position: new V(3.2, 13.5, 15.0), yaw: 0.075, pitch: -0.28 },
      // Eye level, sandbags hard in the right foreground, the barrier chicane
      // leading in, the wreck sitting in the cross-lit band at z = -8, the
      // arched passage glowing at the vanishing point.
      street: { position: new V(1.85, 1.66, 13.6), yaw: 0.062, pitch: -0.018 },
      // Standing BEHIND the shop counter, inside the L of it, looking out at the
      // street through the three shopfront bays. Solved, not guessed: at 3.1 m
      // and 1 degree off the axis the smashed display case on the counter sits
      // dead centre with the bright opening behind it, the counter top runs out
      // of the bottom-left corner as the foreground, the market trestle stands
      // in the light at 30 degrees left, and the recessed shelf bay and blocked
      // doorway in the south wall hold the right third. 0.3 m further back and
      // 2 degrees further down than before: the near corner of the counter used
      // to be 0.73 m from the lens, which is what filled the lower left with an
      // unreadable black wedge, and the ceiling ate the top fifth of the frame.
      interior: { position: new V(-13.10, 1.63, -1.10), yaw: -2.03, pitch: -0.052 },
      // Deep in the alley looking back toward the street: converging walls,
      // the fire escape framing the upper right, bright slot at the end.
      // On the CENTRELINE and pitched down 4 degrees, not hard against the
      // south flank looking level: from 0.95 m off one wall the two flanks ate
      // 70% of the frame and the alley's own floor - the gully, the dished
      // channel and the art direction's mandated wet patch, which is the one
      // thing in a shadowed alley that carries the sky - never appeared at all.
      alley: { position: new V(16.8, 1.60, -4.72), yaw: 1.505, pitch: -0.075 },
      // Across the diagonal of W3's roof from the far corner, not standing on
      // the parapet. The deck runs away as the bottom third, the water tank is
      // the near right foreground mass, the stair-head bulkhead silhouettes
      // against the low sun just left of centre, and the street canyon opens
      // about 20 degrees off the axis into the right third.
      rooftop: { position: new V(-16.6, 11.12, -10.35), yaw: -0.635, pitch: -0.048 }
    };
  };

  // ---- broadphase + raycast ---------------------------------------------------
  Level.prototype._buildBroadphase = function () {
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

  // Voxel-walk the spatial hash along the ray and slab-test only the colliders
  // in the cells actually crossed. Testing every box per shot would be fine at
  // one shot per frame and disastrous during a penetration chain.
  Level.prototype.raycast = function (origin, dir, maxDist) {
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
      if (bestC && best <= tNext) break;         // nothing further out can win
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

  GAME.Level = Level;
})(window.GAME, window.THREE);

