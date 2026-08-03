// ============================================================================
// OPERATION BLACKOUT - LEVEL 5 "MERIDIAN TOWER" - set dressing
// Module owner: props_highrise.  Exports GAME.PropsHighrise.
//
// level_highrise.js builds the FRAME: slab, soffit, columns, core, curtain
// wall, edge protection, scaffold, hoist, crane, and the five big laydown
// items (block packs, rebar bundle, glazing stack, site cabin, placing boom).
// This file builds everything a person left behind on it.
//
// ---------------------------------------------------------------------------
// WHAT MAKES A CONSTRUCTION FLOOR READ AS ONE
//
// Three observations drive every placement decision below, and none of them is
// "scatter props about":
//
//  1. A WORKING FLOOR IS SWEPT INTO LANES.  Material arrives at the hoist and
//     is barrowed inboard, so there is a clean ribbon from the hoist landing to
//     the core and a second one across to the west face - and everything else
//     is pushed to the margins of those ribbons.  The level already paints the
//     grime of those two lanes into the slab's wear mask (|z+13| and |z-6|);
//     this file reads the same two centrelines and keeps standing props OUT of
//     them, which is the single strongest cue that people walk here.
//
//  2. THE WIND SORTS THE RUBBISH.  The roster pins this level "clear, windy",
//     and the level publishes windDir = the direction the light travels,
//     (+0.75, +0.66) - i.e. in through the open west and north edges and out
//     across the core.  So litter and block dust bank against the WINDWARD face
//     of the core's west wall and the south glazing, tail away DOWNWIND of every
//     column and stack, and pile in the two corners the wind cannot leave.
//     Uniform scatter is on the instant-fail list; a wind field is the cheapest
//     honest alternative.
//
//  3. DUST FALLS UP-FACE.  Rain cleans horizontal surfaces; cutting blocks does
//     the exact opposite.  Everything here is painted through the wear contract
//     with grime WEIGHTED TO THE UP-FACING NORMAL - the inverse of the harbor's
//     wetness model, and the reason a bucket on this floor does not look like a
//     bucket borrowed from a level in a rainstorm.  The G (wetness) channel is
//     left at 1.0 almost everywhere: this level is DRY, materials.js has its wet
//     layer disabled for it, and a glistening prop would be the loudest possible
//     wrong note against a sunset.
//
// ---------------------------------------------------------------------------
// CONSTRAINTS
//   * < 80 draw calls for ALL props.  ~16 InstancedMesh batches, ~10 merged
//     static buckets, ~7 small vertex-animated meshes.
//   * Every placement resolves against level.anchors, never a camera pose.
//   * Every placement lands on ctx.level.sampleGround with a small random tilt,
//     and is rejected if a level collider or an earlier prop already occupies
//     the site.  ctx.level may be null; every access is guarded.
//   * Wind animation is done on the CPU, deliberately.  Six ribbons of ~60
//     vertices and a dozen instance matrices per frame is cheaper than a shader
//     injection, and it cannot fight materials.js's own onBeforeCompile chain -
//     which is where the harbor lost a round.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  A few thousand placements run through here at build time.
  // --------------------------------------------------------------------------
  var _m4 = new THREE.Matrix4();
  var _qt = new THREE.Quaternion();
  var _qs = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3();
  var _vs = new THREE.Vector3();
  var _va = new THREE.Vector3();
  var _vc = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _col = new THREE.Color();
  var _tc = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);
  var WHITE = new THREE.Color(1, 1, 1);

  // --------------------------------------------------------------------------
  // Transforms
  // --------------------------------------------------------------------------
  function T(px, py, pz, rx, ry, rz, sx, sy, sz) {
    _eu.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _qt.setFromEuler(_eu);
    _vp.set(px || 0, py || 0, pz || 0);
    _vs.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    return _m4.compose(_vp, _qt, _vs);
  }
  function Tn(px, py, pz, rx, ry, rz, sx, sy, sz) {
    return T(px, py, pz, rx, ry, rz, sx, sy, sz).clone();
  }

  // Map a unit-height Y-up primitive onto the segment a->b.  "From here to
  // there" is the natural description of a brace, a lead or a handrail.
  var _strutM = new THREE.Matrix4();
  function strutM(ax, ay, az, bx, by, bz, thick) {
    _vc.set(bx - ax, by - ay, bz - az);
    var len = _vc.length();
    if (!(len > 1e-6)) len = 1e-6;
    _vd.copy(_vc).multiplyScalar(1 / len);
    _qs.setFromUnitVectors(UP, _vd);
    _vp.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _vs.set(thick === undefined ? 1 : thick, len, thick === undefined ? 1 : thick);
    return _strutM.compose(_vp, _qs, _vs);
  }

  // --------------------------------------------------------------------------
  // Tinting.  An InstancedMesh colour and a material colour BOTH multiply the
  // albedo map, and the library material already carries a calibrated gain.
  // Writing a real mid-tone hex into either squares the albedo and the prop
  // renders as a cut-out.  Every tint is therefore normalised by its own max
  // channel and pulled back toward white: the hex is a HUE SHIFT, not paint.
  // Same helper as props.js / props_harbor.js, deliberately.
  // --------------------------------------------------------------------------
  function normTint(hex, strength, out) {
    out = out || _tc;
    out.setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(out.r, Math.max(out.g, out.b));
    if (!(mx > 1e-4)) mx = 1;
    out.multiplyScalar(1 / mx);
    var s = strength === undefined ? 0.60 : strength;
    out.r = 1 + (out.r - 1) * s;
    out.g = 1 + (out.g - 1) * s;
    out.b = 1 + (out.b - 1) * s;
    return out;
  }

  // --------------------------------------------------------------------------
  // Geometry primitives, cached.  Returned INDEXED where three.js makes them
  // that way - Geo.mergeAll converts a copy and disposes only the copy, so a
  // cache entry is never pulled out from under the next caller.
  // --------------------------------------------------------------------------
  var _boxC = new Map(), _cylC = new Map(), _sphC = new Map(), _torC = new Map();

  function boxG(w, h, d, bevel) {
    w = Math.max(w, 0.002); h = Math.max(h, 0.002); d = Math.max(d, 0.002);
    if (bevel === undefined) bevel = Math.min(0.008, Math.min(w, Math.min(h, d)) * 0.26);
    var k = w.toFixed(3) + '|' + h.toFixed(3) + '|' + d.toFixed(3) + '|' + bevel.toFixed(3);
    var g = _boxC.get(k);
    if (!g) { g = Geo.bevelBox(w, h, d, bevel); _boxC.set(k, g); }
    return g;
  }
  function cylG(rt, rb, h, seg, open) {
    seg = seg || 8;
    var k = rt.toFixed(4) + '|' + rb.toFixed(4) + '|' + h.toFixed(3) + '|' + seg + '|' + (open ? 1 : 0);
    var g = _cylC.get(k);
    if (!g) { g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open); _cylC.set(k, g); }
    return g;
  }
  function sphG(r, seg) {
    seg = seg || 8;
    var k = r.toFixed(4) + '|' + seg;
    var g = _sphC.get(k);
    if (!g) { g = new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1)); _sphC.set(k, g); }
    return g;
  }
  function torG(r, tube, seg, rad) {
    seg = seg || 8; rad = rad || 5;
    var k = r.toFixed(4) + '|' + tube.toFixed(4) + '|' + seg + '|' + rad;
    var g = _torC.get(k);
    if (!g) { g = new THREE.TorusGeometry(r, tube, rad, seg); _torC.set(k, g); }
    return g;
  }
  function disposeCaches() {
    function d(m) { m.forEach(function (g) { if (g && g.dispose) g.dispose(); }); m.clear(); }
    d(_boxC); d(_cylC); d(_sphC); d(_torC);
  }

  // A flat card in XY facing +Z, with explicit atlas UVs and an optional curl
  // so a sheet of paper is never a perfect rectangle.
  function cardG(w, h, u0, v0, u1, v1, curl, segs) {
    segs = segs || 2;
    var pos = [], nrm = [], uv = [], idx = [];
    var i, j;
    for (j = 0; j <= segs; j++) {
      for (i = 0; i <= segs; i++) {
        var fx = i / segs, fy = j / segs;
        var x = (fx - 0.5) * w, y = (fy - 0.5) * h;
        var z = curl ? (Math.sin(fx * Math.PI) * 0.5 + Math.sin(fy * Math.PI * 1.7) * 0.5) * curl : 0;
        pos.push(x, y, z);
        nrm.push(0, 0, 1);
        uv.push(u0 + (u1 - u0) * fx, v0 + (v1 - v0) * fy);
      }
    }
    for (j = 0; j < segs; j++) {
      for (i = 0; i < segs; i++) {
        var a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d2 = c + 1;
        idx.push(a, c, b, b, c, d2);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    if (curl) g.computeVertexNormals();
    return g;
  }

  // Displace every vertex by fbm.  The cheapest way to stop a primitive reading
  // as a primitive: a lump of broken slab is not a box, and a bulk bag full of
  // spoil is not a cube.
  function roughen(geo, noise, amount, freq, mode) {
    var p = geo.attributes.position;
    if (!p || !noise) return geo;
    freq = freq || 3;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * freq, y * freq, z * freq, 3, 2.1, 0.55);
      if (mode === 'radial') {
        var s = 1 + n1 * amount;
        p.setXYZ(i, x * s, y * (1 + n1 * amount * 0.4), z * s);
      } else if (mode === 'sag') {
        // bags and sacks: the sides bulge and the top slumps
        var r = Math.sqrt(x * x + z * z);
        p.setXYZ(i, x * (1 + n1 * amount), y - Math.max(0, y) * amount * (0.6 + n1) - r * 0.02,
          z * (1 + n1 * amount));
      } else {
        var n2 = noise.fbm3(x * freq + 31.7, y * freq - 11.3, z * freq + 5.1, 3, 2.1, 0.55);
        var n3 = noise.fbm3(x * freq - 7.9, y * freq + 23.4, z * freq - 17.2, 3, 2.1, 0.55);
        p.setXYZ(i, x + n1 * amount, y + n2 * amount, z + n3 * amount);
      }
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  // --------------------------------------------------------------------------
  // PartBuilder - accumulate {geometry, matrix} and merge once.  Every prop in
  // the kit is one of these, so a bucket with a rim, a base ring, a handle and
  // a slop of dried plaster in it is still a single geometry.
  // --------------------------------------------------------------------------
  function PB() { this.parts = []; }
  PB.prototype.add = function (g, m) {
    if (g) this.parts.push({ geometry: g, matrix: m ? m.clone() : null });
    return this;
  };
  PB.prototype.box = function (w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(boxG(w, h, d, bevel), T(x, y, z, rx, ry, rz));
  };
  PB.prototype.cyl = function (rt, rb, h, seg, x, y, z, rx, ry, rz, open) {
    return this.add(cylG(rt, rb, h, seg, open), T(x, y, z, rx, ry, rz));
  };
  PB.prototype.sph = function (r, seg, x, y, z, sx, sy, sz) {
    return this.add(sphG(r, seg), T(x, y, z, 0, 0, 0, sx, sy, sz));
  };
  PB.prototype.tor = function (r, tube, seg, rad, x, y, z, rx, ry, rz) {
    return this.add(torG(r, tube, seg, rad), T(x, y, z, rx, ry, rz));
  };
  // A round member between two points: conduit, a lead, a handle, a rail.
  PB.prototype.tube = function (ax, ay, az, bx, by, bz, r, seg) {
    return this.add(cylG(r, r, 1, seg || 6), strutM(ax, ay, az, bx, by, bz));
  };
  // A square member between two points: a leg, a brace, a stile.
  PB.prototype.bar = function (ax, ay, az, bx, by, bz, w, d) {
    return this.add(boxG(w, 1, d === undefined ? w : d), strutM(ax, ay, az, bx, by, bz));
  };
  PB.prototype.build = function () {
    if (!this.parts.length) return null;
    var g = null;
    try { g = Geo.mergeAll(this.parts); }
    catch (e) { GAME.logError('propsHR.merge', e); return null; }
    this.parts.length = 0;
    return g;
  };

  function mergeParts(parts) {
    if (!parts || !parts.length) return null;
    var g = null;
    try { g = Geo.mergeAll(parts); }
    catch (e) { GAME.logError('propsHR.mergeParts', e); return null; }
    return g;
  }
  function part(geometry, matrix) {
    return { geometry: geometry, matrix: matrix ? matrix.clone() : null };
  }

  // Every part list in this file holds geometry that was created for that list
  // and nothing else (the primitive caches are merged FROM, never INTO), so the
  // sources can be released the moment the merge is done.  Five hundred small
  // BufferGeometries left alive is a real number on a 60 fps budget.
  function disposeParts(parts) {
    if (!parts) return;
    var seen = new Set();
    for (var i = 0; i < parts.length; i++) {
      var g = parts[i].geometry;
      if (g && !seen.has(g)) { seen.add(g); if (g.dispose) g.dispose(); }
    }
    parts.length = 0;
  }

  // ==========================================================================
  // THE WEAR CONTRACT
  //
  // materials.js get(name, {vertexColors:true}) reads the geometry `color`
  // attribute as a wear MASK: white = pristine, and each channel darkens toward
  // a different kind of damage.
  //
  //     R -> grime / dust     G -> wetness      B -> edge wear
  //
  // so a channel is written as 1 - amount, never as amount.  Getting that
  // inverted paints a dust-covered floor showroom-clean, which is why the
  // arithmetic lives in one function with its own name.
  //
  // THE INVERSION THAT MATTERS HERE.  The harbor's model puts its heaviest
  // effect on UP-FACING surfaces because that is where rain sits, and its
  // undersides stay dry.  Cutting concrete does the same thing with the opposite
  // material: block dust settles on every horizontal face and leaves the
  // undersides comparatively clean.  So `dust` is weighted by +normal.y here,
  // and `wet` is left alone - this level is dry, and materials.js has its wet
  // layer switched off for it, so writing wetness would be writing to a channel
  // nobody reads while making the mask lie.
  // ==========================================================================
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var dust = o.dust === undefined ? 0.34 : o.dust;      // settles on up-faces
    var grime = o.grime === undefined ? 0.20 : o.grime;   // general film
    var edge = o.edge === undefined ? 0.18 : o.edge;      // handled corners
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.2 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      // dust lies on horizontal faces and slides off anything steep
      var up = M.saturate(ny);
      var lay = up * up * (0.25 + 0.75 * up);
      // the general film is heaviest at the foot, where the barrow wheel and
      // the broom throw it
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.30 + 0.90 * lowness * lowness) + dust * lay;
      // edge wear rides the outer, up-facing extremities: the corners hands,
      // boots and a barrow tyre actually hit
      var reach = M.saturate((Math.sqrt(x * x + z * z) - 0.06) * 1.7);
      var ed = edge * (0.22 + 0.88 * reach) * (0.30 + 0.80 * M.saturate(ny + 0.35));
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        gr = gr * (1 + nv * 0.85);
        ed = ed * (1 + nv * 1.05);
      }
      c[i * 3] = M.saturate(1 - M.saturate(gr));
      c[i * 3 + 1] = 1;                       // G: dry, and deliberately so
      c[i * 3 + 2] = M.saturate(1 - M.saturate(ed));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // For materials requested with wearMode 'multiply' (the coloured plastics),
  // the attribute is a plain albedo multiplier instead.  Kept in a tight band -
  // an instance colour multiplies this again, and two multipliers below 0.8
  // each is a black prop.
  function paintMul(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var noise = o.noise || null;
    var amt = o.amount === undefined ? 0.18 : o.amount;
    var hiY = o.hiY === undefined ? 0.5 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var lowness = 1 - M.saturate(y / Math.max(0.15, hiY));
      // dusty on top, scuffed pale on the rim, dirty at the foot
      var v = 1 - amt * (0.35 + 0.65 * lowness * lowness);
      v += M.saturate(ny) * amt * 0.35;
      if (noise) v *= 1 + noise.fbm3(x * 3.1, y * 3.1, z * 3.1, 2, 2.1, 0.55) * 0.10;
      v = M.clamp(v, 0.62, 1.10);
      c[i * 3] = v; c[i * 3 + 1] = v * 0.995; c[i * 3 + 2] = v * 0.985;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the same channels.  Multiplies the vertex mask,
  // so 1.0 leaves a channel alone: this is jitter, not a second coat.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(1 - rng.range(0, 0.22), 1, 1 - rng.range(0, 0.18));
    return out;
  }

  // ==========================================================================
  // Batch - InstancedMesh that counts up as you place into it.
  // ==========================================================================
  function Batch(geo, mat, max, castShadow) {
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
    this.mesh.count = 0;
    this.mesh.castShadow = castShadow === undefined ? true : !!castShadow;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.n = 0;
    this.max = Math.max(1, max);
    this.full = 0;
  }
  Batch.prototype.add = function (matrix, color) {
    if (this.n >= this.max) { this.full++; return false; }
    this.mesh.setMatrixAt(this.n, matrix);
    // Always write a colour: instanceColor is allocated lazily and an unwritten
    // entry can render black depending on three's fill policy.
    this.mesh.setColorAt(this.n, color || WHITE);
    this.n++;
    return true;
  };
  Batch.prototype.place = function (x, y, z, yaw, pitch, roll, sx, sy, sz, color) {
    return this.add(T(x, y, z, pitch || 0, yaw || 0, roll || 0, sx, sy, sz), color);
  };
  Batch.prototype.finish = function (parent, name) {
    if (this.n === 0) { this.mesh.dispose(); return null; }
    this.mesh.count = this.n;
    this.mesh.name = name || 'hr_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // ==========================================================================
  // Local texture kit.
  //
  // Structural surfaces come from ctx.materials by the names the contract
  // fixes.  Everything below is props-specific ART the shared library cannot
  // know about: the alpha atlas of site litter and floor dust, kraft cement-bag
  // paper, woven polypropylene, hi-vis, and dusty site polythene.
  // ==========================================================================
  var TX = {};

  TX.canvas = function (w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h || w;
    return c;
  };

  TX.tex = function (canvas, srgb, rx, ry, aniso, clamp) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    t.anisotropy = aniso || 8;
    t.needsUpdate = true;
    return t;
  };

  TX.normalFromCanvas = function (canvas, size, strength) {
    if (!canvas) return null;
    var g = canvas.getContext('2d');
    if (!g) return null;
    var src = g.getImageData(0, 0, canvas.width, canvas.height).data;
    var w = canvas.width;
    var h = new Float32Array(size * size);
    var x, y;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        var sx = Math.min(w - 1, Math.floor(x * w / size));
        var sy = Math.min(canvas.height - 1, Math.floor(y * canvas.height / size));
        h[y * size + x] = src[(sy * w + sx) * 4] / 255;
      }
    }
    strength = strength === undefined ? 1.8 : strength;
    var data = new Uint8Array(size * size * 4);
    for (y = 0; y < size; y++) {
      var ym = ((y - 1) + size) % size, yp = (y + 1) % size;
      for (x = 0; x < size; x++) {
        var xm = ((x - 1) + size) % size, xp = (x + 1) % size;
        var dx = (h[ym * size + xp] + 2 * h[y * size + xp] + h[yp * size + xp]) -
                 (h[ym * size + xm] + 2 * h[y * size + xm] + h[yp * size + xm]);
        var dy = (h[yp * size + xm] + 2 * h[yp * size + x] + h[yp * size + xp]) -
                 (h[ym * size + xm] + 2 * h[ym * size + x] + h[ym * size + xp]);
        var nx = -dx * strength, ny = -dy * strength, nz = 1;
        var il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        var i = (y * size + x) * 4;
        data[i] = (nx * il * 0.5 + 0.5) * 255;
        data[i + 1] = (ny * il * 0.5 + 0.5) * 255;
        data[i + 2] = (nz * il * 0.5 + 0.5) * 255;
        data[i + 3] = 255;
      }
    }
    var t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  // Tileable grunge, composited under everything generated locally.  One field
  // is an order of magnitude cheaper than running fbm per pixel per material.
  TX.grunge = function (size, seed, contrast) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var img = g.createImageData(size, size);
    var d = img.data;
    var noise = new GAME.Noise(seed);
    var inv = 1 / size;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x * inv * Math.PI * 2, v = y * inv * Math.PI * 2;
        var nx = Math.cos(u) * 1.4, ny = Math.sin(u) * 1.4;
        var nz = Math.cos(v) * 1.4, nw = Math.sin(v) * 1.4;
        var n = noise.fbm3(nx * 2.0, ny * 2.0, nz * 2.0, 4, 2.13, 0.52) * 0.62 +
                noise.fbm3(nz * 5.3 + 11, nw * 5.3 - 7, nx * 5.3 + 3, 3, 2.31, 0.5) * 0.38;
        var val = M.saturate(0.5 + n * (contrast || 1.15));
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // ---- invented script -----------------------------------------------------
  // Deliberately not any real alphabet, company or product: connected baseline
  // strokes with ascenders and diacritic dots, which reads as "printing in a
  // language I do not speak" at a glance and as nothing in particular up close.
  TX.scriptRun = function (g, x, y, size, width, rng, weight) {
    g.lineWidth = Math.max(1, size * (weight || 0.16));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    var cx = x, end = x + width, dots = [], guard = 0;
    g.beginPath();
    g.moveTo(cx, y);
    while (cx < end && guard++ < 50) {
      var w = size * rng.range(0.42, 0.95);
      if (cx + w > end) w = end - cx;
      var mode = rng.int(0, 5);
      if (mode === 0) g.quadraticCurveTo(cx + w * 0.5, y - size * 0.62, cx + w, y);
      else if (mode === 1) { g.lineTo(cx + w * 0.34, y - size * 0.70); g.lineTo(cx + w, y); }
      else if (mode === 2) g.quadraticCurveTo(cx + w * 0.5, y + size * 0.42, cx + w, y);
      else if (mode === 3) g.bezierCurveTo(cx + w * 0.15, y - size * 0.85, cx + w * 0.85, y - size * 0.2, cx + w, y);
      else if (mode === 4) {
        g.lineTo(cx + w * 0.5, y); g.lineTo(cx + w * 0.5, y - size * 0.55);
        g.moveTo(cx + w * 0.5, y); g.lineTo(cx + w, y);
      } else g.lineTo(cx + w, y);
      if (rng.bool(0.32)) dots.push([cx + w * 0.5, y - size * (rng.bool(0.6) ? 0.95 : -0.35), size * 0.09]);
      cx += w;
      if (rng.bool(0.15)) { cx += size * 0.32; g.moveTo(cx, y); }
    }
    g.stroke();
    for (var i = 0; i < dots.length; i++) {
      g.beginPath();
      g.arc(dots[i][0], dots[i][1], dots[i][2], 0, Math.PI * 2);
      g.fill();
    }
  };

  // ==========================================================================
  // THE ALPHA ATLAS.  4 x 4 cells at 1024, RGBA with real alpha.
  //
  // Two materials share it: a floor DECAL material (transparent, depth-write
  // off, polygon-offset, no shadow) and a LITTER material (alpha-tested,
  // double-sided, casts shadow).  One canvas, one upload, two draw calls.
  //
  // Floor dust is the highest-value thing in here.  A power-floated slab lit at
  // nine degrees is 2200 m2 of one value; the drifts, sweep piles and boot
  // lines are what give the raking key something to describe.
  // ==========================================================================
  var A_N = 4, A_PX = 1024, A_CELL = A_PX / A_N;
  var CELL = {
    drift: 0,      // wind-blown block dust, a long tapered wedge
    slurry: 1,     // spilled and dried mortar / grout
    boots: 2,      // a run of boot prints in the dust
    sweep: 3,      // the arc a broom leaves, dust piled at the far edge
    crumbs: 4,     // butts, washers, screws, small debris cluster
    chalk: 5,      // snapped chalk line and a scribbled dimension
    rust: 6,       // rust weep off a starter bar
    spatter: 7,    // spray overspray / paint splash
    paper: 8,      // a printed A4 sheet (litter)
    card: 9,       // torn cardboard (litter)
    bag: 10,       // a crumpled polythene bag (litter)
    sack: 11,      // a torn kraft cement-bag corner (litter)
    tape: 12,      // a length of barrier tape lying flat
    drill: 13,     // the cone of dust under a drilled hole
    oil: 14,       // a diesel / hydraulic drip stain
    scuff: 15      // black rubber scuff, barrow tyre and boot heel
  };

  function atlasUV(cell) {
    var cx = (cell % A_N) / A_N;
    var cy = Math.floor(cell / A_N) / A_N;
    var s = 1 / A_N;
    // Canvas row 0 is v = 1 after three's flipY, so v is inverted here.
    return [cx, 1 - cy - s, cx + s, 1 - cy];
  }

  TX.atlas = function (rng, grunge) {
    var cv = TX.canvas(A_PX);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, A_PX, A_PX);
    var S = A_CELL, i, k;

    function cell(id) {
      var cx = (id % A_N) * A_CELL, cy = Math.floor(id / A_N) * A_CELL;
      g.save();
      g.beginPath(); g.rect(cx, cy, A_CELL, A_CELL); g.clip();
      g.translate(cx, cy);
      return A_CELL;
    }
    function end() { g.restore(); }
    function rgba(r2, g2, b2, a) {
      return 'rgba(' + (r2 | 0) + ',' + (g2 | 0) + ',' + (b2 | 0) + ',' + a.toFixed(3) + ')';
    }
    // Soft grain sprayed inside a shape, so no decal has a clean edge.
    function speck(n, cw, ch, colour, amin, amax, rmin, rmax) {
      for (var q = 0; q < n; q++) {
        g.globalAlpha = rng.range(amin, amax);
        g.fillStyle = colour;
        g.beginPath();
        g.arc(rng.range(0, cw), rng.range(0, ch), rng.range(rmin, rmax), 0, 6.28318);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    // An irregular blob: a polygon with a noisy radius, feathered.
    function blob(cx, cy, r, wob, colour, alpha, pts) {
      pts = pts || 14;
      g.beginPath();
      for (var q = 0; q <= pts; q++) {
        var a = q / pts * 6.28318;
        var rr = r * (1 + Math.sin(a * 3.1 + cx) * wob * 0.5 + Math.cos(a * 5.7 - cy) * wob * 0.5);
        var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.82;
        if (q === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.globalAlpha = alpha;
      g.fillStyle = colour;
      g.fill();
      g.globalAlpha = 1;
    }

    // ---- 0 wind drift -------------------------------------------------------
    // A tapered wedge of pale block dust, dense at the obstruction end and
    // dissolving downwind.  This is the single most-used card in the level.
    cell(CELL.drift);
    for (i = 0; i < 40; i++) {
      var dy = rng.range(0.10, 0.90) * S;
      var len = rng.range(0.35, 0.98) * S;
      var grd = g.createLinearGradient(0, 0, len, 0);
      var a0 = rng.range(0.26, 0.62);
      grd.addColorStop(0, rgba(214, 209, 196, a0));
      grd.addColorStop(0.45, rgba(206, 200, 186, a0 * 0.5));
      grd.addColorStop(1, rgba(198, 192, 178, 0));
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(0, dy - rng.range(6, 26));
      g.lineTo(len, dy - rng.range(1, 5));
      g.lineTo(len, dy + rng.range(1, 5));
      g.lineTo(0, dy + rng.range(6, 26));
      g.closePath();
      g.fill();
    }
    // the ridge where it stops against whatever it hit
    var rg = g.createLinearGradient(0, 0, S * 0.16, 0);
    rg.addColorStop(0, rgba(222, 217, 204, 0.66));
    rg.addColorStop(1, rgba(214, 208, 194, 0));
    g.fillStyle = rg;
    g.fillRect(0, 0, S * 0.16, S);
    speck(320, S, S, '#cdc7b6', 0.05, 0.30, 0.8, 3.2);
    end();

    // ---- 1 dried slurry -----------------------------------------------------
    cell(CELL.slurry);
    blob(S * 0.48, S * 0.52, S * 0.34, 0.30, '#b9b4a6', 0.80);
    blob(S * 0.40, S * 0.44, S * 0.22, 0.42, '#c8c3b4', 0.72);
    for (i = 0; i < 9; i++) {
      blob(S * rng.range(0.12, 0.88), S * rng.range(0.12, 0.88), S * rng.range(0.03, 0.09),
        0.5, '#c2bdae', rng.range(0.35, 0.75), 9);
    }
    // shrinkage cracks: what tells you it dried rather than spilled
    g.strokeStyle = 'rgba(120,116,106,0.50)';
    g.lineWidth = 2.0;
    for (i = 0; i < 12; i++) {
      g.beginPath();
      var sx = S * rng.range(0.25, 0.75), sy = S * rng.range(0.25, 0.75);
      g.moveTo(sx, sy);
      for (k = 0; k < 3; k++) {
        sx += rng.range(-46, 46); sy += rng.range(-46, 46);
        g.lineTo(sx, sy);
      }
      g.stroke();
    }
    end();

    // ---- 2 boot prints ------------------------------------------------------
    // A walking line, not a stamp: alternating left/right with a real stride
    // and the tread breaking up as the dust runs out.
    cell(CELL.boots);
    for (i = 0; i < 7; i++) {
      var by = S * (0.08 + i * 0.132);
      var bx = S * (0.42 + (i % 2 ? 0.14 : -0.14)) + rng.range(-10, 10);
      var fade = 1 - i / 8;
      g.save();
      g.translate(bx, by);
      g.rotate(rng.range(-0.22, 0.22) + (i % 2 ? 0.10 : -0.10));
      g.globalAlpha = rng.range(0.30, 0.62) * fade;
      g.fillStyle = '#8e8a80';
      // sole and heel as two rounded blocks
      g.beginPath();
      g.ellipse(0, -S * 0.028, S * 0.026, S * 0.042, 0, 0, 6.28318);
      g.fill();
      g.beginPath();
      g.ellipse(0, S * 0.030, S * 0.023, S * 0.026, 0, 0, 6.28318);
      g.fill();
      // tread bars
      g.globalAlpha *= 0.55;
      g.fillStyle = '#dcd7c8';
      for (k = 0; k < 5; k++) {
        g.fillRect(-S * 0.022, -S * 0.062 + k * S * 0.016, S * 0.044, S * 0.006);
      }
      g.restore();
    }
    g.globalAlpha = 1;
    end();

    // ---- 3 broom sweep ------------------------------------------------------
    cell(CELL.sweep);
    for (i = 0; i < 26; i++) {
      var ar = S * rng.range(0.30, 0.70);
      g.strokeStyle = rgba(206, 201, 188, rng.range(0.10, 0.34));
      g.lineWidth = rng.range(2, 7);
      g.beginPath();
      g.arc(S * 0.5, S * 1.12, ar, Math.PI * 1.18, Math.PI * 1.82);
      g.stroke();
    }
    // the windrow the broom pushed up
    var sg = g.createLinearGradient(0, S * 0.16, 0, S * 0.42);
    sg.addColorStop(0, rgba(220, 214, 200, 0));
    sg.addColorStop(0.55, rgba(220, 214, 200, 0.72));
    sg.addColorStop(1, rgba(206, 200, 186, 0.12));
    g.fillStyle = sg;
    g.beginPath();
    g.moveTo(0, S * 0.42);
    for (i = 0; i <= 16; i++) {
      g.lineTo(i / 16 * S, S * (0.30 + Math.sin(i * 0.9) * 0.035 + rng.range(-0.02, 0.02)));
    }
    g.lineTo(S, S * 0.42);
    g.closePath();
    g.fill();
    speck(220, S, S * 0.5, '#cbc5b4', 0.06, 0.28, 1, 3.4);
    end();

    // ---- 4 crumbs -----------------------------------------------------------
    // Cigarette ends, screws, washers, snapped cable ties: the litter that is
    // too small to model and too characterful to leave out.
    cell(CELL.crumbs);
    for (i = 0; i < 34; i++) {
      var cx2 = S * rng.range(0.14, 0.86), cy2 = S * rng.range(0.14, 0.86);
      var kind = rng.int(0, 3);
      g.save();
      g.translate(cx2, cy2);
      g.rotate(rng.range(0, 6.28318));
      if (kind === 0) {                       // cigarette end
        g.fillStyle = 'rgba(226,214,182,0.95)';
        g.fillRect(-S * 0.020, -S * 0.005, S * 0.040, S * 0.010);
        g.fillStyle = 'rgba(58,44,32,0.95)';
        g.fillRect(S * 0.010, -S * 0.005, S * 0.010, S * 0.010);
      } else if (kind === 1) {                // screw / nail
        g.fillStyle = 'rgba(122,116,108,0.95)';
        g.fillRect(-S * 0.018, -S * 0.003, S * 0.036, S * 0.006);
      } else if (kind === 2) {                // washer
        g.strokeStyle = 'rgba(140,134,124,0.95)';
        g.lineWidth = 2.4;
        g.beginPath(); g.arc(0, 0, S * 0.009, 0, 6.28318); g.stroke();
      } else {                                // cable tie
        g.strokeStyle = 'rgba(40,40,44,0.90)';
        g.lineWidth = 2.0;
        g.beginPath();
        g.moveTo(-S * 0.024, 0);
        g.quadraticCurveTo(0, -S * 0.018, S * 0.024, S * 0.004);
        g.stroke();
      }
      g.restore();
    }
    speck(60, S, S, '#b8b2a4', 0.06, 0.20, 1, 2.6);
    end();

    // ---- 5 chalk line -------------------------------------------------------
    cell(CELL.chalk);
    g.strokeStyle = 'rgba(70,84,120,0.72)';
    g.lineWidth = 3.0;
    g.beginPath();
    for (i = 0; i <= 20; i++) g.lineTo(i / 20 * S, S * 0.42 + Math.sin(i * 1.7) * 2.0);
    g.stroke();
    g.strokeStyle = 'rgba(70,84,120,0.34)';
    g.lineWidth = 2.0;
    g.beginPath();
    for (i = 0; i <= 20; i++) g.lineTo(i / 20 * S, S * 0.62 + Math.sin(i * 2.3 + 1) * 2.4);
    g.stroke();
    g.fillStyle = 'rgba(66,78,110,0.80)';
    g.strokeStyle = 'rgba(66,78,110,0.80)';
    TX.scriptRun(g, S * 0.16, S * 0.30, S * 0.10, S * 0.42, rng, 0.20);
    // the tick marks a setting-out engineer leaves
    g.strokeStyle = 'rgba(180,60,44,0.72)';
    g.lineWidth = 3.4;
    for (i = 0; i < 4; i++) {
      var tx = S * (0.16 + i * 0.22);
      g.beginPath(); g.moveTo(tx, S * 0.36); g.lineTo(tx, S * 0.50); g.stroke();
    }
    end();

    // ---- 6 rust weep --------------------------------------------------------
    cell(CELL.rust);
    for (i = 0; i < 16; i++) {
      var wx = rng.range(0, S), ww = rng.range(4, 34);
      var grd2 = g.createLinearGradient(0, 0, 0, S);
      var rr2 = rng.range(112, 158), gg2 = rng.range(66, 100), bb2 = rng.range(40, 64);
      grd2.addColorStop(0, rgba(rr2, gg2, bb2, rng.range(0.34, 0.68)));
      grd2.addColorStop(0.5, rgba(rr2 * 0.9, gg2 * 0.9, bb2 * 0.9, rng.range(0.14, 0.34)));
      grd2.addColorStop(1, rgba(rr2 * 0.8, gg2 * 0.8, bb2 * 0.8, 0));
      g.fillStyle = grd2;
      g.fillRect(wx, rng.range(-S * 0.1, S * 0.15), ww, S);
    }
    end();

    // ---- 7 overspray --------------------------------------------------------
    cell(CELL.spatter);
    for (i = 0; i < 130; i++) {
      var d2 = rng.range(0, S * 0.44);
      var a2 = rng.range(0, 6.28318);
      g.globalAlpha = (1 - d2 / (S * 0.5)) * rng.range(0.20, 0.72);
      g.fillStyle = rng.bool(0.6) ? '#b8402f' : '#2a2c30';
      g.beginPath();
      g.arc(S * 0.5 + Math.cos(a2) * d2, S * 0.5 + Math.sin(a2) * d2,
        rng.range(1.2, 5.4), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    end();

    // ---- 8 printed sheet (LITTER) -------------------------------------------
    // A drawing register / method statement that blew off somebody's clipboard.
    cell(CELL.paper);
    g.fillStyle = '#ddd8cb';
    g.beginPath();
    g.moveTo(S * 0.10, S * 0.06);
    g.lineTo(S * 0.92, S * 0.10);
    g.lineTo(S * 0.88, S * 0.94);
    g.lineTo(S * 0.07, S * 0.90);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(56,54,52,0.86)';
    g.strokeStyle = 'rgba(56,54,52,0.86)';
    for (i = 0; i < 11; i++) {
      TX.scriptRun(g, S * 0.16, S * (0.20 + i * 0.062), S * 0.036, S * rng.range(0.35, 0.68), rng, 0.19);
    }
    g.strokeStyle = 'rgba(60,58,56,0.55)';
    g.lineWidth = 2;
    g.strokeRect(S * 0.14, S * 0.13, S * 0.70, S * 0.74);
    // the boot print on it, because it has been on the floor for a week
    g.globalAlpha = 0.30;
    g.fillStyle = '#7a756c';
    g.beginPath();
    g.ellipse(S * 0.58, S * 0.62, S * 0.10, S * 0.17, 0.4, 0, 6.28318);
    g.fill();
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.34;
      g.drawImage(grunge, 0, 0, S, S);
      g.globalCompositeOperation = 'destination-in';
      g.globalAlpha = 1;
      // re-cut the alpha, which the multiply pass just flattened
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(S * 0.10, S * 0.06);
      g.lineTo(S * 0.92, S * 0.10);
      g.lineTo(S * 0.88, S * 0.94);
      g.lineTo(S * 0.07, S * 0.90);
      g.closePath();
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    end();

    // ---- 9 cardboard (LITTER) ----------------------------------------------
    cell(CELL.card);
    g.fillStyle = '#a8845a';
    g.beginPath();
    g.moveTo(S * 0.06, S * 0.22);
    g.lineTo(S * 0.62, S * 0.08);
    g.lineTo(S * 0.94, S * 0.46);
    g.lineTo(S * 0.72, S * 0.92);
    g.lineTo(S * 0.14, S * 0.78);
    g.closePath();
    g.fill();
    // the fluting exposed along the torn edge
    g.strokeStyle = 'rgba(140,110,74,0.85)';
    g.lineWidth = 3;
    for (i = 0; i < 26; i++) {
      var fy = S * (0.10 + i * 0.032);
      g.beginPath(); g.moveTo(S * 0.08, fy); g.lineTo(S * 0.92, fy - S * 0.04); g.stroke();
    }
    g.globalAlpha = 0.55;
    g.fillStyle = '#6f5637';
    g.fillRect(S * 0.20, S * 0.34, S * 0.44, S * 0.06);
    g.globalAlpha = 1;
    end();

    // ---- 10 polythene bag (LITTER) -----------------------------------------
    cell(CELL.bag);
    g.fillStyle = 'rgba(206,208,206,0.78)';
    g.beginPath();
    g.moveTo(S * 0.20, S * 0.16);
    g.bezierCurveTo(S * 0.62, S * 0.02, S * 0.94, S * 0.30, S * 0.82, S * 0.62);
    g.bezierCurveTo(S * 0.74, S * 0.92, S * 0.28, S * 0.96, S * 0.14, S * 0.68);
    g.bezierCurveTo(S * 0.06, S * 0.48, S * 0.08, S * 0.26, S * 0.20, S * 0.16);
    g.closePath();
    g.fill();
    // creases: a bag is 90% crease
    g.strokeStyle = 'rgba(238,240,238,0.60)';
    g.lineWidth = 3.2;
    for (i = 0; i < 16; i++) {
      g.beginPath();
      var kx = S * rng.range(0.18, 0.78), ky = S * rng.range(0.18, 0.82);
      g.moveTo(kx, ky);
      g.quadraticCurveTo(kx + rng.range(-60, 60), ky + rng.range(-60, 60),
        kx + rng.range(-120, 120), ky + rng.range(-90, 120));
      g.stroke();
    }
    g.strokeStyle = 'rgba(120,124,124,0.42)';
    g.lineWidth = 2.0;
    for (i = 0; i < 10; i++) {
      g.beginPath();
      var mx2 = S * rng.range(0.20, 0.76), my2 = S * rng.range(0.20, 0.80);
      g.moveTo(mx2, my2);
      g.lineTo(mx2 + rng.range(-70, 70), my2 + rng.range(-70, 70));
      g.stroke();
    }
    end();

    // ---- 11 torn cement sack (LITTER) --------------------------------------
    cell(CELL.sack);
    g.fillStyle = '#c9b28a';
    g.beginPath();
    g.moveTo(S * 0.10, S * 0.30);
    g.lineTo(S * 0.86, S * 0.14);
    g.lineTo(S * 0.90, S * 0.72);
    g.lineTo(S * 0.24, S * 0.88);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(60,58,56,0.80)';
    g.strokeStyle = 'rgba(60,58,56,0.80)';
    TX.scriptRun(g, S * 0.18, S * 0.44, S * 0.11, S * 0.52, rng, 0.22);
    g.fillStyle = 'rgba(176,52,40,0.75)';
    g.fillRect(S * 0.16, S * 0.54, S * 0.62, S * 0.05);
    // the burst end, dusted white
    g.globalAlpha = 0.6;
    g.fillStyle = '#e6e2d6';
    blob(S * 0.24, S * 0.68, S * 0.16, 0.5, '#e6e2d6', 0.55);
    g.globalAlpha = 1;
    end();

    // ---- 12 barrier tape ----------------------------------------------------
    cell(CELL.tape);
    g.save();
    g.translate(0, S * 0.42);
    g.rotate(-0.06);
    g.fillStyle = '#e2ddd0';
    g.fillRect(-S * 0.05, 0, S * 1.1, S * 0.14);
    g.fillStyle = '#bb2c22';
    for (i = -1; i < 9; i++) {
      g.beginPath();
      var tx2 = i * S * 0.14;
      g.moveTo(tx2, 0);
      g.lineTo(tx2 + S * 0.07, 0);
      g.lineTo(tx2 + S * 0.03, S * 0.14);
      g.lineTo(tx2 - S * 0.04, S * 0.14);
      g.closePath();
      g.fill();
    }
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    for (i = 0; i < 40; i++) {
      g.globalAlpha = rng.range(0.3, 1.0);
      g.beginPath();
      g.arc(rng.range(0, S), S * (rng.bool() ? 0.42 : 0.56) + rng.range(-6, 6),
        rng.range(2, 9), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    end();

    // ---- 13 drill dust ------------------------------------------------------
    cell(CELL.drill);
    blob(S * 0.5, S * 0.5, S * 0.19, 0.22, '#dcd6c6', 0.72);
    blob(S * 0.5, S * 0.5, S * 0.11, 0.30, '#e8e3d4', 0.72);
    g.fillStyle = 'rgba(40,38,36,0.80)';
    g.beginPath(); g.arc(S * 0.5, S * 0.5, S * 0.030, 0, 6.28318); g.fill();
    speck(120, S, S, '#d6d0c0', 0.04, 0.22, 1, 3.0);
    end();

    // ---- 14 diesel drip -----------------------------------------------------
    cell(CELL.oil);
    blob(S * 0.5, S * 0.54, S * 0.26, 0.34, '#2a2620', 0.62);
    blob(S * 0.46, S * 0.48, S * 0.15, 0.40, '#1c1a16', 0.68);
    for (i = 0; i < 10; i++) {
      blob(S * rng.range(0.2, 0.8), S * rng.range(0.2, 0.8), S * rng.range(0.02, 0.06),
        0.5, '#241f1a', rng.range(0.3, 0.6), 8);
    }
    // the iridescent rim a fresh drip leaves
    g.globalAlpha = 0.22;
    g.strokeStyle = '#6e5a86';
    g.lineWidth = 5;
    g.beginPath(); g.arc(S * 0.5, S * 0.54, S * 0.24, 0, 6.28318); g.stroke();
    g.globalAlpha = 1;
    end();

    // ---- 15 rubber scuff ----------------------------------------------------
    cell(CELL.scuff);
    for (i = 0; i < 8; i++) {
      g.globalAlpha = rng.range(0.16, 0.46);
      g.strokeStyle = '#2c2a28';
      g.lineWidth = rng.range(5, 22);
      g.lineCap = 'round';
      g.beginPath();
      var ax2 = S * rng.range(0.02, 0.30), ay2 = S * rng.range(0.10, 0.90);
      g.moveTo(ax2, ay2);
      g.quadraticCurveTo(S * 0.5, ay2 + rng.range(-90, 90), S * rng.range(0.70, 0.98),
        ay2 + rng.range(-60, 60));
      g.stroke();
    }
    g.globalAlpha = 1;
    end();

    return cv;
  };

  // ---- kraft cement-bag paper ----------------------------------------------
  TX.kraft = function (size, seed, grunge) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#c8b189';
    g.fillRect(0, 0, size, size);
    // paper fibre
    var i;
    for (i = 0; i < 900; i++) {
      g.globalAlpha = rng.range(0.03, 0.13);
      g.strokeStyle = rng.bool() ? '#e0cba4' : '#a89170';
      g.lineWidth = rng.range(0.6, 1.8);
      g.beginPath();
      var x = rng.range(0, size), y = rng.range(0, size);
      g.moveTo(x, y);
      g.lineTo(x + rng.range(-26, 26), y + rng.range(-6, 6));
      g.stroke();
    }
    g.globalAlpha = 1;
    // printed bands and a maker's mark in the invented script
    g.fillStyle = 'rgba(168,46,34,0.80)';
    g.fillRect(0, size * 0.36, size, size * 0.055);
    g.fillRect(0, size * 0.60, size, size * 0.022);
    g.fillStyle = 'rgba(48,44,40,0.86)';
    g.strokeStyle = 'rgba(48,44,40,0.86)';
    TX.scriptRun(g, size * 0.10, size * 0.28, size * 0.075, size * 0.62, rng, 0.20);
    TX.scriptRun(g, size * 0.16, size * 0.74, size * 0.045, size * 0.52, rng, 0.20);
    // the cement dust that lives on every bag in the stack
    for (i = 0; i < 260; i++) {
      g.globalAlpha = rng.range(0.05, 0.30);
      g.fillStyle = '#e8e4d8';
      g.beginPath();
      g.arc(rng.range(0, size), rng.range(0, size), rng.range(2, 16), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.42;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- woven polypropylene (bulk bags) -------------------------------------
  TX.weave = function (size, seed, grunge) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#cfcabb';
    g.fillRect(0, 0, size, size);
    var pitch = size / 42, i;
    for (i = 0; i < 42; i++) {
      g.fillStyle = 'rgba(232,228,218,0.55)';
      g.fillRect(i * pitch, 0, pitch * 0.52, size);
      g.fillStyle = 'rgba(168,163,152,0.42)';
      g.fillRect(0, i * pitch, size, pitch * 0.52);
    }
    // the printed band and stitched seams
    g.fillStyle = 'rgba(60,80,112,0.26)';
    g.fillRect(0, size * 0.44, size, size * 0.10);
    g.fillStyle = 'rgba(96,108,124,0.55)';
    g.strokeStyle = 'rgba(96,108,124,0.55)';
    TX.scriptRun(g, size * 0.12, size * 0.51, size * 0.055, size * 0.60, rng, 0.22);
    g.strokeStyle = 'rgba(120,116,108,0.70)';
    g.lineWidth = 2.4;
    g.setLineDash([6, 7]);
    for (i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(0, size * (0.16 + i * 0.34));
      g.lineTo(size, size * (0.16 + i * 0.34));
      g.stroke();
    }
    g.setLineDash([]);
    // spoil staining up from the base
    for (i = 0; i < 200; i++) {
      g.globalAlpha = rng.range(0.04, 0.24);
      g.fillStyle = rng.bool(0.6) ? '#9a9080' : '#7f7666';
      g.beginPath();
      g.ellipse(rng.range(0, size), size * rng.range(0.55, 1.0),
        rng.range(4, 26), rng.range(3, 14), rng.range(0, 3), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.40;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- hi-vis ---------------------------------------------------------------
  TX.hivis = function (size, seed, grunge) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#d8641a';
    g.fillRect(0, 0, size, size);
    // the knit
    var i;
    for (i = 0; i < 130; i++) {
      g.globalAlpha = 0.08;
      g.strokeStyle = i % 2 ? '#f08a34' : '#a84a12';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(0, i * size / 130);
      g.lineTo(size, i * size / 130);
      g.stroke();
    }
    g.globalAlpha = 1;
    // retroreflective bands - the only near-white on a hi-vis, and the reason
    // it reads at 30 m against concrete
    g.fillStyle = '#c8ccce';
    g.fillRect(0, size * 0.30, size, size * 0.11);
    g.fillRect(0, size * 0.58, size, size * 0.11);
    g.fillStyle = 'rgba(160,166,170,0.7)';
    for (i = 0; i < 40; i++) {
      g.fillRect(i * size / 40, size * 0.30, size / 80, size * 0.11);
      g.fillRect(i * size / 40, size * 0.58, size / 80, size * 0.11);
    }
    for (i = 0; i < 160; i++) {
      g.globalAlpha = rng.range(0.05, 0.26);
      g.fillStyle = rng.bool(0.7) ? '#8a7a60' : '#5c5346';
      g.beginPath();
      g.arc(rng.range(0, size), rng.range(0, size), rng.range(3, 20), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.44;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- site polythene -------------------------------------------------------
  // Not new polythene: it has been on the floor for a month, it is grey with
  // block dust and it is about 60% opaque.  The level learned this the hard way
  // with its own sheeting - clean white sheet clips against a sunset sky and
  // reads as a luminous board hung in an opening.
  TX.poly = function (size, seed, grunge) {
    var c = TX.canvas(size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#9ea19f';
    g.fillRect(0, 0, size, size);
    var i;
    // creases, which is all a sheet of polythene has
    for (i = 0; i < 90; i++) {
      g.globalAlpha = rng.range(0.05, 0.24);
      g.strokeStyle = rng.bool(0.5) ? '#c6c9c6' : '#7a7d7c';
      g.lineWidth = rng.range(1.5, 7);
      g.beginPath();
      var x = rng.range(0, size), y = rng.range(0, size);
      g.moveTo(x, y);
      g.bezierCurveTo(x + rng.range(-90, 90), y + rng.range(-90, 90),
        x + rng.range(-140, 140), y + rng.range(-140, 140),
        x + rng.range(-200, 200), y + rng.range(-200, 200));
      g.stroke();
    }
    // dust and slurry splash on the low half
    for (i = 0; i < 180; i++) {
      g.globalAlpha = rng.range(0.05, 0.28);
      g.fillStyle = rng.bool(0.65) ? '#b9b3a4' : '#8c8578';
      g.beginPath();
      g.ellipse(rng.range(0, size), size * rng.range(0.4, 1.0),
        rng.range(3, 24), rng.range(2, 12), rng.range(0, 3), 0, 6.28318);
      g.fill();
    }
    g.globalAlpha = 1;
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.36;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ==========================================================================
  function PropsHighrise(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_highrise';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's stream, so adding a
    // dust mote somewhere else cannot reshuffle the floor.
    var seed = (((this.ctx.seed || 20260801) ^ 0x48525052) >>> 0);
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    this.tex = {};
    this.mats = {};
    this.B = {};                 // instanced batches
    this.S = {                   // one-off geometry, merged per material
      concrete: [], block: [], steel: [], galv: [], rust: [], paint: [],
      wood: [], ply: [], fabric: [], plastic: [], paper: [], hivis: []
    };
    this.flaps = [];             // vertex-animated ribbons (poly, tape)
    this.caught = [];            // litter caught on netting/rails, matrix-animated
    this._caughtBatch = null;
    this._occ = new Map();
    this._skipped = 0;
    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Fallback layout, overwritten by _probeLayout the moment the level
    // publishes anchors.  These are the level's own published constants; they
    // exist only so a missing level does not take this module down.
    this.plate = { x0: -27, x1: 27, z0: -21, z1: 21, y: 0, soffitY: 3.96, lowerY: -4.3 };
    this.core = { x0: 8, x1: 22, z0: -10, z1: 10 };
    this.lobby = { x0: 8.32, x1: 13.0, z0: -10, z1: 9.68 };
    this.voidRect = { x0: -5.6, x1: 1.8, z0: -4.6, z1: 3.4 };
    this.deckVoid = { x0: -25, x1: -15, z0: -18, z1: -8 };
    this.columns = [];
    this.stacks = [];
    this.wind = new THREE.Vector2(0.749, 0.663);
    this.windSpeed = 11;
    // The two swept traffic ribbons.  Read from the level's own grime lanes so
    // the clean concrete and the clean walking line are the same thing.
    this.lanes = [
      { x0: 26.0, z0: -13.4, x1: -24.0, z1: -13.0, w: 2.7 },
      { x0: 8.2, z0: 6.0, x1: -26.0, z1: 6.0, w: 2.4 }
    ];

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsHR.ctor', e); }
  }

  PropsHighrise.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsHR.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsHighrise.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('layout', this._probeLayout);
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('kit', this._buildKit);
    // Big first, small after.  The five vignettes need three or four clear
    // metres each; running them after the scatter had filled every site is how
    // the harbor lost three of its five plant items.
    await this._phase('hoist', this._dressHoistLanding);
    await this._phase('work', this._dressWorkstations);
    await this._phase('facade', this._dressFacade);
    await this._phase('lobby', this._dressLobby);
    await this._phase('void', this._dressVoid);
    await this._phase('edge', this._dressOpenEdge);
    await this._phase('columns', this._dressColumns);
    await this._phase('drift', this._dressDrift);
    await this._phase('floor', this._dressFloorMarks);
    await this._phase('commit', this._commit);
    disposeCaches();
    return this;
  };

  GAME.PropsHighrise = PropsHighrise;

  // The remaining prototype methods are attached below in build order.
  // --------------------------------------------------------------------------
  // LAYOUT
  // --------------------------------------------------------------------------
  PropsHighrise.prototype._probeLayout = function () {
    var lv = this.ctx && this.ctx.level;
    if (!lv) return;
    var a = lv.anchors;
    if (a) {
      if (a.plate) {
        this.plate = a.plate;
        if (typeof a.plate.groundY === 'function') this._groundFn = a.plate.groundY;
        if (typeof a.plate.sunlit === 'function') this._sunFn = a.plate.sunlit;
      }
      if (a.core) {
        this.core = a.core;
        if (a.core.lobby) this.lobby = a.core.lobby;
      }
      if (a.slabVoid) this.voidRect = a.slabVoid;
      if (a.deckVoid) this.deckVoid = a.deckVoid;
      if (a.columns) this.columns = a.columns;
      if (a.stacks) this.stacks = a.stacks;
      if (a.openEdge) this.openEdge = a.openEdge;
      if (a.curtainWall) this.curtain = a.curtainWall;
      if (a.hoist) this.hoist = a.hoist;
      if (a.scaffold) this.scaffold = a.scaffold;
      if (a.lamps) this.lamps = a.lamps;
    }
    if (lv.windDir && isFinite(lv.windDir.x)) {
      this.wind.set(lv.windDir.x, lv.windDir.y).normalize();
    }
    if (isFinite(lv.windSpeed) && lv.windSpeed > 0) this.windSpeed = lv.windSpeed;

    // Seed our own occupancy with everything the level already stood on the
    // plate, so a prop pass cannot drop a bucket inside the placing boom.
    var i;
    for (i = 0; i < this.stacks.length; i++) {
      var s = this.stacks[i];
      if (!s || !s.centre) continue;
      var r = Math.max(s.w || 1, s.d || 1) * 0.5 + 0.55;
      this._occupy(s.centre.x, s.centre.z, r);
    }
    for (i = 0; i < this.columns.length; i++) {
      this._occupy(this.columns[i].x, this.columns[i].z, 0.62);
    }

    // Broadphase over the level's own colliders, so _blocked can ask "is there
    // something in the way" without a raycast per placement.
    try {
      var cols = lv.colliders;
      if (cols && cols.length && GAME.SpatialHash) {
        this.hash = new GAME.SpatialHash(3.0);
        this._qout = [];
        for (i = 0; i < cols.length; i++) {
          if (cols[i].floor) continue;
          GAME.Collision.boxBounds(cols[i], _bmin, _bmax);
          this.hash.insert(cols[i], _bmin, _bmax);
        }
      }
    } catch (e2) { GAME.logError('propsHR.hash', e2); this.hash = null; }
  };

  // Height of the working slab.  sampleGround is the level's own plate
  // function, so a prop and the floor under it cannot disagree about where the
  // low spots are.  It returns the LOWER floor inside the slab void and a long
  // way down inside a lift shaft, which is exactly what _onPlate tests.
  PropsHighrise.prototype._ground = function (x, z) {
    var lv = this.ctx && this.ctx.level;
    if (lv && typeof lv.sampleGround === 'function') {
      try {
        var y = lv.sampleGround(x, z);
        if (isFinite(y)) return y;
      } catch (e) { /* fall through */ }
    }
    if (this._groundFn) {
      try { return this._groundFn(x, z); } catch (e2) { /* fall through */ }
    }
    return 0;
  };

  // Is this point standing on the working floor at all?
  PropsHighrise.prototype._onPlate = function (x, z, pad) {
    var p = this.plate;
    pad = pad || 0.35;
    if (x < p.x0 + pad || x > p.x1 - pad || z < p.z0 + pad || z > p.z1 - pad) return false;
    var v = this.voidRect;
    if (x > v.x0 - pad && x < v.x1 + pad && z > v.z0 - pad && z < v.z1 + pad) return false;
    return this._ground(x, z) > -0.6;
  };

  // How far below its own neighbourhood this patch sits.  The level bakes the
  // saw-cut joints and the pour's undulation into sampleGround, so a positive
  // dip here IS a hollow in the real slab - which is where dust settles and
  // where the little standing damp there is collects.
  PropsHighrise.prototype._dip = function (x, z) {
    var c = this._ground(x, z);
    var m = (this._ground(x + 1.1, z) + this._ground(x - 1.1, z) +
             this._ground(x, z + 1.1) + this._ground(x, z - 1.1)) * 0.25;
    return m - c;
  };

  PropsHighrise.prototype._sunlit = function (x, z) {
    if (this._sunFn) {
      try { return M.saturate(this._sunFn(x, z)); } catch (e) { /* fall through */ }
    }
    return 0.5;
  };

  PropsHighrise.prototype._blocked = function (x, y, z, r) {
    if (!this.hash) return false;
    _bmin.set(x - r, y - r, z - r);
    _bmax.set(x + r, y + r, z + r);
    var list;
    try { list = this.hash.query(_bmin, _bmax, this._qout); }
    catch (e) { return false; }
    _va.set(x, y, z);
    for (var i = 0; i < list.length; i++) {
      if (list[i].floor) continue;
      if (GAME.Collision.boxOverlapsSphere(list[i], _va, r)) return true;
    }
    return false;
  };

  PropsHighrise.prototype._occupied = function (x, z, r) {
    var cs = 3;
    var gx = Math.floor(x / cs), gz = Math.floor(z / cs);
    for (var ox = -1; ox <= 1; ox++) {
      for (var oz = -1; oz <= 1; oz++) {
        var l = this._occ.get((gx + ox) * 73856093 ^ (gz + oz) * 19349663);
        if (!l) continue;
        for (var i = 0; i < l.length; i += 3) {
          var dx = l[i] - x, dz = l[i + 1] - z;
          var rr = l[i + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  };
  PropsHighrise.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  // Distance from a swept walking line.  A lane is a cost, not a wall:
  // anything under about 25 cm - dust, litter, a dropped washer, a lead - lies
  // IN it, because a lane with literally nothing on it is not a working floor,
  // it is a corridor somebody hoovered.  Standing masses are excluded from the
  // whole ribbon; low things only from the middle fifth.
  PropsHighrise.prototype._laneClear = function (x, z, r, low) {
    for (var i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i];
      var vx = L.x1 - L.x0, vz = L.z1 - L.z0;
      var len2 = vx * vx + vz * vz;
      var t = len2 > 1e-6 ? M.saturate(((x - L.x0) * vx + (z - L.z0) * vz) / len2) : 0;
      var dx = x - (L.x0 + vx * t), dz = z - (L.z0 + vz * t);
      var half = low ? L.w * 0.22 : L.w * 0.5 + r;
      if (dx * dx + dz * dz < half * half) return false;
    }
    return true;
  };

  // The one call every scattered placement goes through.
  //
  //   opts: { r, tilt, yaw, scale, lane:false, low:true, sink, color,
  //           collider:[hx,hy,hz], material, h }
  //
  // Returns the height it settled at, or null if the site was rejected.
  PropsHighrise.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.35 : opts.r;
    if (!this._onPlate(x, z, opts.pad === undefined ? 0.35 : opts.pad)) { this._skipped++; return null; }
    if (opts.lane !== false && !this._laneClear(x, z, r, opts.low)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var y = this._ground(x, z);
    var cr = opts.clearR === undefined ? r * 0.8 : opts.clearR;
    if (this._blocked(x, y + (opts.h || 0.4) * 0.5, z, cr)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, M.TAU) : opts.yaw;
    // Nothing on a power-floated slab stands perfectly plumb: the float leaves
    // a 20 mm ripple and every bucket finds it.
    var tilt = opts.tilt === undefined ? 0.030 : opts.tilt;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var pitch = (opts.pitch || 0) + this.rng.gaussian(0, tilt);
    var roll = (opts.roll || 0) + this.rng.gaussian(0, tilt);
    var ok = batch.add(
      T(x, y - (opts.sink || 0) + (opts.lift || 0), z, pitch, yaw, roll,
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng));
    if (!ok) return null;
    this._occupy(x, z, opts.occ === undefined ? r : opts.occ);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    return y;
  };

  PropsHighrise.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  PropsHighrise.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // --------------------------------------------------------------------------
  // TEXTURES
  // --------------------------------------------------------------------------
  PropsHighrise.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;

    var grunge = TX.grunge(256, 0x51A3, 1.22);
    this._grunge = grunge;

    var atlasRng = new GAME.RNG(0x0A71A5);
    var atlasCv = TX.atlas(atlasRng, grunge);
    t.atlas = TX.tex(atlasCv, true, 1, 1, aniso, true);
    this._atlasOk = !!t.atlas;

    var kraftCv = TX.kraft(256, 0x1CE3, grunge);
    t.kraft = TX.tex(kraftCv, true, 1, 1, aniso);
    t.kraftN = TX.normalFromCanvas(kraftCv, 128, 1.1);

    var weaveCv = TX.weave(256, 0x2B4D, grunge);
    t.weave = TX.tex(weaveCv, true, 1, 1, aniso);
    t.weaveN = TX.normalFromCanvas(weaveCv, 128, 1.6);

    var hivisCv = TX.hivis(128, 0x3F19, grunge);
    t.hivis = TX.tex(hivisCv, true, 1, 1, aniso);

    var polyCv = TX.poly(256, 0x4D07, grunge);
    t.poly = TX.tex(polyCv, true, 1, 1, aniso);
    t.polyN = TX.normalFromCanvas(polyCv, 128, 0.9);
  };

  // --------------------------------------------------------------------------
  // MATERIALS
  //
  // Structural surfaces come from ctx.materials, which carries the detail
  // normals, macro variation and calibrated albedo gains that stop a surface
  // reading as plastic.  Everything is CLONED - mutating a cached library
  // material would corrupt it for level_highrise.js, which is sharing the same
  // library on the same frame.
  //
  // `albedoTarget` rather than `color` everywhere a hue is wanted: a raw
  // multiplier squares a mapped material, and a pale tint over a pale map lands
  // nowhere near either.
  // --------------------------------------------------------------------------
  PropsHighrise.prototype._material = function (name, opts, tintHex, tintStr) {
    var lib = this.ctx.materials;
    var mat = null;
    try {
      if (lib && lib.get) {
        var m = lib.get(name, opts || null);
        if (m && m.clone) mat = m.clone();
      }
    } catch (e) { GAME.logError('propsHR.mat:' + name, e); }
    if (!mat) mat = this._fallbackMaterial(name, opts);
    if (tintHex !== undefined) {
      normTint(tintHex, tintStr === undefined ? 0.6 : tintStr, _col);
      mat.color.multiply(_col);
    }
    mat.name = 'hr_' + name;
    return mat;
  };

  var FALLBACK = {
    concrete:          [0x8f8b84, 0.88, 0.0],
    rubble:            [0x8a857c, 0.94, 0.0],
    brick:             [0x9a938a, 0.92, 0.0],
    structural_steel:  [0x6a6a66, 0.62, 0.30],
    painted_metal:     [0x9aa1a6, 0.48, 0.60],
    rusted_metal:      [0x8a6a4a, 0.80, 0.55],
    wood_plank:        [0xa3886a, 0.88, 0.0],
    fabric:            [0xb8b2a2, 0.90, 0.0],
    plastic:           [0x9c9a96, 0.46, 0.0],
    rubber:            [0x232326, 0.72, 0.0]
  };

  PropsHighrise.prototype._fallbackMaterial = function (name, opts) {
    var fb = FALLBACK[name] || FALLBACK.concrete;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(fb[0], THREE.SRGBColorSpace),
      roughness: fb[1], metalness: fb[2], envMapIntensity: 1.0
    });
    if (this._grunge) {
      m.map = TX.tex(this._grunge, true, 2, 2, this._aniso);
      m.normalMap = TX.normalFromCanvas(this._grunge, 128, 1.0);
      if (m.normalMap) m.normalScale = new THREE.Vector2(0.55, 0.55);
    }
    if (opts) {
      if (opts.vertexColors) m.vertexColors = true;
      if (opts.side !== undefined) m.side = opts.side;
      if (opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
      if (opts.roughness !== undefined) m.roughness = opts.roughness;
      if (opts.metalness !== undefined) m.metalness = opts.metalness;
    }
    return m;
  };

  PropsHighrise.prototype._initMaterials = function () {
    var m = this.mats, t = this.tex;
    // Wear mode: R grime/dust, G wetness, B edge wear.
    var W = { vertexColors: true };
    // Multiply mode: the attribute is a plain albedo multiplier, so the
    // instance colour can carry a real hue.  Used only for the coloured
    // plastics, where one batch has to serve black, white and orange.
    var Mul = { vertexColors: true, wearMode: 'multiply' };

    m.concrete = this._material('concrete', W);
    m.rubble = this._material('rubble', W);
    m.block = this._material('brick', W);
    // The library's structural steel sits at 0.095 albedo, which is right for
    // a painted beam and far too dark for a trestle that has stood in block
    // dust for a month.  Every piece of site steel in this level is filthy and
    // pale, and in the shaded two thirds of the plate the difference between
    // 0.095 and 0.15 is the difference between an object and a hole.
    m.steel = this._material('structural_steel',
      { vertexColors: true, albedoTarget: 0x6e685e, roughness: 0.68 });
    // Galvanised scaffold tube and props: much brighter and colder than
    // structure, and a separate material so a bundle of tube never inherits the
    // frame's paint.
    m.galv = this._material('painted_metal',
      { vertexColors: true, albedoTarget: 0x9aa2a8, roughness: 0.42, metalness: 0.86,
        envMapIntensity: 1.15 });
    m.rust = this._material('rusted_metal',
      { vertexColors: true, roughness: 0.80, metalness: 0.62 });
    // Contractor's yellow.  The only saturated warm mass on a grey floor, and
    // at nine degrees of incidence it is what the eye lands on first.
    m.paint = this._material('painted_metal',
      { vertexColors: true, albedoTarget: 0xb08428, roughness: 0.52, metalness: 0.38 });
    m.wood = this._material('wood_plank', W);
    // Sheet material: OSB and plasterboard are both far paler and flatter than
    // structural timber, and they are the brightest thing on the shaded half of
    // the plate.
    m.ply = this._material('wood_plank',
      { vertexColors: true, albedoTarget: 0xb3a284, roughness: 0.90 });
    m.plastic = this._material('plastic', Mul);

    // ---- local art ---------------------------------------------------------
    function local(map, normal, rough, metal, opts) {
      var mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, map: map || null,
        roughness: rough === undefined ? 0.86 : rough,
        metalness: metal === undefined ? 0 : metal,
        envMapIntensity: 1.0, vertexColors: true
      });
      if (normal) { mat.normalMap = normal; mat.normalScale = new THREE.Vector2(0.8, 0.8); }
      if (opts) {
        if (opts.side !== undefined) mat.side = opts.side;
        if (opts.alphaTest !== undefined) mat.alphaTest = opts.alphaTest;
        if (opts.transparent) { mat.transparent = true; mat.depthWrite = false; }
        if (opts.polygonOffset) {
          mat.polygonOffset = true;
          mat.polygonOffsetFactor = -3;
          mat.polygonOffsetUnits = -6;
        }
        if (opts.vertexColors === false) mat.vertexColors = false;
      }
      return mat;
    }

    m.paper = local(t.kraft, t.kraftN, 0.92, 0);
    m.weave = local(t.weave, t.weaveN, 0.88, 0);
    m.hivis = local(t.hivis, null, 0.84, 0);
    // Site polythene: double sided (you see the back of every sheet), and no
    // shadow casting - an alpha-free translucent sheet casting a solid black
    // shadow is the fastest way to make a light material read as a board.
    m.poly = local(t.poly, t.polyN, 0.68, 0,
      { side: THREE.DoubleSide });
    m.poly.envMapIntensity = 0.45;

    // The atlas pair.  One texture, two materials, two draw calls.
    if (this._atlasOk) {
      m.decal = local(t.atlas, null, 0.94, 0,
        { transparent: true, polygonOffset: true, vertexColors: false });
      m.decal.envMapIntensity = 0.7;
      m.litter = local(t.atlas, null, 0.88, 0,
        { side: THREE.DoubleSide, alphaTest: 0.42, vertexColors: false });
    }
  };

  // Re-UV a merged prop to a consistent world texel density, copy uv1 for the
  // AO channel, and paint the wear mask AFTER the merge - Geo.mergeAll carries
  // position, normal and uv and nothing else.
  PropsHighrise.prototype._finishGeo = function (geo, uvScale, wear, mul) {
    if (!geo) return null;
    if (uvScale) {
      try { Geo.worldUV(geo, uvScale); } catch (e) { /* keep the builder uv */ }
    }
    Geo.copyUV1(geo);
    if (mul) paintMul(geo, mul);
    else if (wear !== false) paintWear(geo, wear || { noise: this.noise });
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  // ==========================================================================
  // THE KIT
  //
  // Every prop is a merged multi-part geometry with its origin at the point it
  // touches the floor, so a placement is T(x, groundY, z, tilt, yaw, tilt).
  // Nothing in here is a box standing in for an object: a bucket has a rolled
  // rim, a base ring, a wire handle and a slop of dried plaster in it, because
  // the silhouette is the whole reason a prop reads at 15 m.
  // ==========================================================================
  PropsHighrise.prototype._buildKit = function () {
    var self = this, R = this.rng, N = this.noise;
    var G = this.G = {};
    var b, i, k;

    function bat(key, geo, mat, max, shadow) {
      // A batch is ALWAYS created even if its geometry failed: thirty call
      // sites reach into this.B by name, and making one conditional turns a
      // cosmetic failure into a throw that loses every prop after it.
      if (!geo) geo = new THREE.BufferGeometry();
      self.B[key] = new Batch(geo, mat || self.mats.steel, max, shadow);
      return self.B[key];
    }

    // ---- bucket -------------------------------------------------------------
    // 20 litre, tapered, with the rolled rim and the wire bail that are the
    // only two things that make a truncated cone read as a bucket.
    b = new PB();
    b.cyl(0.150, 0.118, 0.290, 12, 0, 0.145, 0, 0, 0, 0, true);
    b.tor(0.152, 0.011, 12, 5, 0, 0.288, 0, Math.PI * 0.5, 0, 0);   // rim
    b.cyl(0.120, 0.120, 0.014, 12, 0, 0.007, 0);                     // base
    b.tor(0.122, 0.008, 12, 4, 0, 0.020, 0, Math.PI * 0.5, 0, 0);    // base ring
    // the bail, hanging over one side
    for (i = 0; i < 6; i++) {
      var a1 = -0.35 + i * 0.30, a2 = -0.35 + (i + 1) * 0.30;
      b.tube(Math.cos(a1) * 0.152, 0.288 + Math.sin(a1) * 0.11, Math.sin(a1) * 0.02,
        Math.cos(a2) * 0.152, 0.288 + Math.sin(a2) * 0.11, Math.sin(a2) * 0.02, 0.005, 4);
    }
    // the set plaster in the bottom - a bucket on a site is never empty
    b.cyl(0.112, 0.112, 0.030, 12, 0, 0.030, 0);
    G.bucket = this._finishGeo(b.build(), 1.9, null, { noise: N, amount: 0.20, hiY: 0.30 });
    bat('bucket', G.bucket, this.mats.plastic, 30, true);

    // ---- traffic cone -------------------------------------------------------
    b = new PB();
    b.box(0.32, 0.032, 0.32, 0, 0.016, 0, 0, 0, 0, 0.020);
    b.box(0.27, 0.022, 0.27, 0, 0.042, 0, 0, 0, 0, 0.014);
    b.cyl(0.038, 0.115, 0.46, 10, 0, 0.285, 0);
    b.cyl(0.048, 0.048, 0.035, 10, 0, 0.525, 0);
    b.cyl(0.086, 0.078, 0.085, 10, 0, 0.385, 0);   // reflective collar, proud
    G.cone = this._finishGeo(b.build(), 1.8, null, { noise: N, amount: 0.24, hiY: 0.55 });
    bat('cone', G.cone, this.mats.plastic, 34, true);

    // ---- broken slab / rubble chunk ----------------------------------------
    b = new PB();
    b.box(0.30, 0.15, 0.24, 0, 0.075, 0, 0, 0, 0, 0.02);
    b.box(0.18, 0.10, 0.16, 0.10, 0.16, 0.05, 0.3, 0.6, 0.2, 0.015);
    var rub = b.build();
    if (rub) roughen(rub, N, 0.055, 5.5);
    G.rubble = this._finishGeo(rub, 2.4,
      { noise: N, dust: 0.44, grime: 0.30, edge: 0.34, hiY: 0.3 });
    bat('rubble', G.rubble, this.mats.rubble, 190, true);

    // ---- snapped block ------------------------------------------------------
    b = new PB();
    b.box(0.44, 0.215, 0.10, 0, 0.108, 0, 0, 0, 0, 0.008);
    var blk = b.build();
    if (blk) {
      // knock one end off: a block that broke is not a block that was cut
      var bp = blk.attributes.position;
      for (i = 0; i < bp.count; i++) {
        var bx = bp.getX(i);
        if (bx > 0.14) {
          bp.setXYZ(i, bx + N.fbm3(bx * 9, bp.getY(i) * 9, bp.getZ(i) * 9, 2) * 0.05,
            bp.getY(i) + N.fbm3(bx * 7 + 3, bp.getY(i) * 7, bp.getZ(i) * 7, 2) * 0.03,
            bp.getZ(i) + N.fbm3(bx * 8 - 2, bp.getY(i) * 8, bp.getZ(i) * 8, 2) * 0.025);
        }
      }
      bp.needsUpdate = true;
      blk.computeVertexNormals();
    }
    G.block = this._finishGeo(blk, 2.2,
      { noise: N, dust: 0.46, grime: 0.26, edge: 0.30, hiY: 0.25 });
    bat('block', G.block, this.mats.block, 110, true);

    // ---- timber offcut ------------------------------------------------------
    b = new PB();
    b.box(1.05, 0.038, 0.14, 0, 0.019, 0, 0, 0, 0, 0.005);
    var tim = b.build();
    if (tim) roughen(tim, N, 0.006, 3.0);
    G.timber = this._finishGeo(tim, 2.0,
      { noise: N, dust: 0.40, grime: 0.28, edge: 0.32, hiY: 0.2 });
    bat('timber', G.timber, this.mats.wood, 130, true);

    // ---- rebar offcut -------------------------------------------------------
    b = new PB();
    b.cyl(0.011, 0.011, 1.30, 6, 0, 0, 0, 0, 0, Math.PI * 0.5);
    // the ribs, as three collars - the rusted_metal normal does the rest
    for (i = 0; i < 5; i++) {
      b.tor(0.013, 0.0035, 6, 4, -0.5 + i * 0.25, 0, 0, 0, 0, Math.PI * 0.5);
    }
    // a hooked end, which is what says "reinforcement" and not "pipe"
    b.tube(0.65, 0, 0, 0.74, 0.045, 0.03, 0.011, 5);
    G.rebar = this._finishGeo(b.build(), 2.6,
      { noise: N, dust: 0.26, grime: 0.34, edge: 0.24, hiY: 0.2 });
    bat('rebar', G.rebar, this.mats.rust, 90, true);

    // ---- loose scaffold tube -----------------------------------------------
    b = new PB();
    b.cyl(0.0245, 0.0245, 2.40, 7, 0, 0, 0, 0, 0, Math.PI * 0.5);
    b.cyl(0.041, 0.041, 0.085, 8, 0.62, 0, 0, 0, 0, Math.PI * 0.5);   // a coupler still on it
    b.box(0.055, 0.075, 0.075, 0.62, 0.045, 0, 0, 0, 0, 0.006);
    G.tube = this._finishGeo(b.build(), 2.2,
      { noise: N, dust: 0.30, grime: 0.22, edge: 0.20, hiY: 0.2 });
    bat('tube', G.tube, this.mats.galv, 70, true);

    // ---- adjustable steel prop (acrow) --------------------------------------
    // 2.5 m of it, and the reason it is here rather than in the level is that a
    // bundle of props leaning on a column is a PERSON's decision, not a
    // structure's.
    b = new PB();
    b.cyl(0.0245, 0.0245, 1.55, 7, 0, 0.775, 0);
    b.cyl(0.0195, 0.0195, 1.20, 7, 0, 1.90, 0);
    b.cyl(0.046, 0.046, 0.10, 10, 0, 1.55, 0);            // the collar
    b.box(0.10, 0.010, 0.10, 0, 0.008, 0, 0, 0, 0, 0.004); // base plate
    b.box(0.10, 0.010, 0.10, 0, 2.495, 0, 0, 0, 0, 0.004); // head plate
    b.cyl(0.006, 0.006, 0.16, 5, 0.04, 1.60, 0, 0, 0, Math.PI * 0.5);  // the pin
    // the pin holes, as a run of shallow rings
    for (i = 0; i < 7; i++) b.tor(0.021, 0.004, 6, 4, 0, 1.72 + i * 0.15, 0, Math.PI * 0.5, 0, 0);
    G.acrow = this._finishGeo(b.build(), 2.0,
      { noise: N, dust: 0.24, grime: 0.30, edge: 0.22, hiY: 1.6 });
    bat('acrow', G.acrow, this.mats.galv, 40, true);

    // ---- empty cement bag, crumpled ----------------------------------------
    b = new PB();
    b.box(0.50, 0.055, 0.34, 0, 0.028, 0, 0, 0, 0, 0.02);
    var bag = b.build();
    if (bag) roughen(bag, N, 0.035, 7.0);
    G.bagEmpty = this._finishGeo(bag, 1.6, null, { noise: N, amount: 0.26, hiY: 0.12 });
    bat('bagEmpty', G.bagEmpty, this.mats.paper, 34, true);

    // ---- full cement bag ----------------------------------------------------
    b = new PB();
    b.box(0.52, 0.115, 0.36, 0, 0.058, 0, 0, 0, 0, 0.045);
    var bag2 = b.build();
    if (bag2) roughen(bag2, N, 0.014, 5.0);
    G.bagFull = this._finishGeo(bag2, 1.6, null, { noise: N, amount: 0.20, hiY: 0.14 });

    // ---- bulk bag (FIBC) of spoil ------------------------------------------
    // NOT a box.  The first version was a bevelled box with a noise pass over
    // it, and at three metres in the hero1 foreground it photographed as a
    // crate with a printed band - the single most obviously wrong prop in the
    // level.  A tonne bag standing on a slab is a soft object: it bulges at a
    // third of its height, pulls in under its own loops, its corners are round
    // rather than chamfered, and its top slumps into a dish.  All four of those
    // need a subdivided surface to exist at all.
    var fib = new THREE.BoxGeometry(0.90, 0.98, 0.90, 5, 5, 5);
    (function () {
      var p = fib.attributes.position;
      var hw = 0.45, hh = 0.49;
      for (var q = 0; q < p.count; q++) {
        var x = p.getX(q), y = p.getY(q), z = p.getZ(q);
        var t = M.saturate((y + hh) / (hh * 2));
        // round the section: blend the square toward its inscribed circle
        var rr = Math.sqrt(x * x + z * z);
        if (rr > 1e-5) {
          var toCircle = hw / rr;
          var k = 0.40;
          x = x * (1 - k + k * toCircle);
          z = z * (1 - k + k * toCircle);
        }
        // bulge low, pull in at the neck where the loops gather it
        var bulge = 1 + 0.17 * Math.sin(Math.PI * Math.pow(t, 0.80)) - 0.20 * t * t * t;
        // and spread where it meets the floor, because a tonne is a tonne
        bulge += M.smoothstep(0.12, 0.0, t) * 0.06;
        x *= bulge; z *= bulge;
        // the top slumps into a dish
        var rn = M.saturate(Math.sqrt(x * x + z * z) / hw);
        if (t > 0.78) y -= (1 - rn * rn) * 0.085 * M.smoothstep(0.78, 1.0, t);
        p.setXYZ(q, x, y + hh, z);
      }
      p.needsUpdate = true;
    })();
    roughen(fib, N, 0.022, 3.4);
    // the four lifting loops, upright because it is waiting to be craned
    var loops = new PB();
    for (i = 0; i < 4; i++) {
      var lx = (i % 2 ? 0.36 : -0.36), lz = (i < 2 ? -0.36 : 0.36);
      for (k = 0; k < 5; k++) {
        var t0 = k / 5 * Math.PI, t1 = (k + 1) / 5 * Math.PI;
        loops.tube(lx + Math.cos(t0) * 0.09, 0.95 + Math.sin(t0) * 0.20, lz,
          lx + Math.cos(t1) * 0.09, 0.95 + Math.sin(t1) * 0.20, lz, 0.014, 4);
      }
    }
    var lg = loops.build();
    var fibParts = [];
    if (fib) fibParts.push(part(fib, null));
    if (lg) fibParts.push(part(lg, null));
    // Multiply, not wear: mats.weave is a local material, so its vertex colour
    // is a plain albedo multiplier rather than the library's wear mask.
    G.bulkBag = this._finishGeo(mergeParts(fibParts), 1.2, null,
      { noise: N, amount: 0.30, hiY: 1.0 });
    bat('bulkBag', G.bulkBag, this.mats.weave, 16, true);

    // ---- jerry can ----------------------------------------------------------
    b = new PB();
    b.box(0.175, 0.345, 0.325, 0, 0.173, 0, 0, 0, 0, 0.026);
    b.box(0.055, 0.045, 0.16, 0, 0.355, -0.06, 0, 0, 0, 0.010);  // spout
    b.cyl(0.030, 0.030, 0.030, 8, 0, 0.385, -0.06);
    b.box(0.10, 0.030, 0.030, 0, 0.360, 0.09, 0, 0, 0, 0.008);   // handle
    b.box(0.175, 0.018, 0.030, 0, 0.230, 0.163, 0, 0, 0, 0.006); // the swage line
    G.jerry = this._finishGeo(b.build(), 2.0, null, { noise: N, amount: 0.22, hiY: 0.36 });
    bat('jerry', G.jerry, this.mats.plastic, 14, true);

    // ---- hard hat -----------------------------------------------------------
    b = new PB();
    b.sph(0.115, 8, 0, 0.075, 0, 1, 0.85, 1.05);
    b.cyl(0.135, 0.128, 0.020, 10, 0, 0.030, 0);
    b.box(0.020, 0.055, 0.24, 0, 0.120, 0, 0, 0, 0, 0.008);  // the crown rib
    G.hat = this._finishGeo(b.build(), 2.4, null, { noise: N, amount: 0.24, hiY: 0.18 });
    bat('hat', G.hat, this.mats.plastic, 10, true);

    // ---- paper cup ----------------------------------------------------------
    b = new PB();
    b.cyl(0.041, 0.030, 0.095, 8, 0, 0.047, 0, 0, 0, 0, true);
    b.tor(0.042, 0.004, 8, 4, 0, 0.094, 0, Math.PI * 0.5, 0, 0);
    b.cyl(0.030, 0.030, 0.006, 8, 0, 0.003, 0);
    G.cup = this._finishGeo(b.build(), 3.0, null, { noise: N, amount: 0.26, hiY: 0.10 });
    bat('cup', G.cup, this.mats.paper, 22, true);

    // ---- pallet -------------------------------------------------------------
    b = new PB();
    for (i = 0; i < 3; i++) {
      b.box(0.10, 0.09, 1.00, -0.48 + i * 0.48, 0.045, 0, 0, 0, 0, 0.006);
      b.box(1.16, 0.020, 0.095, 0, 0.100, -0.44 + i * 0.44, 0, 0, 0, 0.004);
    }
    for (i = 0; i < 5; i++) {
      b.box(1.16, 0.020, 0.090, 0, 0.100, -0.44 + i * 0.22, 0, 0, 0, 0.004);
    }
    b.box(1.16, 0.018, 0.090, 0, 0.009, -0.42, 0, 0, 0, 0.004);
    b.box(1.16, 0.018, 0.090, 0, 0.009, 0.42, 0, 0, 0, 0.004);
    G.pallet = this._finishGeo(b.build(), 2.0,
      { noise: N, dust: 0.44, grime: 0.34, edge: 0.36, hiY: 0.2 });
    bat('pallet', G.pallet, this.mats.wood, 26, true);

    // ---- cards --------------------------------------------------------------
    // Floor decals and ground litter are STATIC quads, so they are merged
    // rather than instanced: a merged mesh can carry a different atlas cell on
    // every card, an InstancedMesh cannot (per-instance UV selection needs a
    // shader, and shader injection is what the harbor lost a round to).  One
    // draw call for every mark on 2200 m2 of slab, one for every scrap on it.
    this.decalParts = [];
    this.litterParts = [];
    // The one animated set: litter CAUGHT on the edge netting and the guard
    // rails, which has to move or the level's own snapping polythene shows it
    // up.  One instanced batch, matrices rewritten per frame.
    if (this._atlasOk) {
      var uvB = atlasUV(CELL.bag);
      G.caught = cardG(0.30, 0.28, uvB[0], uvB[1], uvB[2], uvB[3], 0.055, 3);
      Geo.copyUV1(G.caught);
      bat('caught', G.caught, this.mats.litter, 22, true);
      if (this.B.caught) {
        this.B.caught.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.B.caught.mesh.frustumCulled = false;
      }
    }
  };

  // A flat mark on the floor.  `size` is metres across; the card is laid in the
  // XZ plane at the local ground height, with a hair of lift so it never
  // z-fights the slab (the material also carries a polygon offset).
  PropsHighrise.prototype._decal = function (cellId, x, z, size, yaw, aspect, alpha) {
    if (!this._atlasOk || !this.decalParts) return false;
    if (this.decalParts.length > 340) return false;
    if (!this._onPlate(x, z, 0.15)) return false;
    var uv = atlasUV(cellId);
    var w = size, h = size * (aspect === undefined ? 1 : aspect);
    var g = cardG(w, h, uv[0], uv[1], uv[2], uv[3], 0, 1);
    var y = this._ground(x, z) + 0.006 + this.rng.range(0, 0.004);
    var p = part(g, Tn(x, y, z, -Math.PI * 0.5, yaw || 0, 0));
    // Carried through to the merge, where it becomes the card's vertex alpha.
    // A boot line at the same opacity as a dust drift reads as a sticker.
    p.alpha = alpha === undefined ? 1 : alpha;
    this.decalParts.push(p);
    return true;
  };

  // A scrap of paper, card, bag or sack lying on the floor.  Lies nearly flat
  // with a little lift on one corner, because nothing blown around a windy
  // floor for a fortnight is flat.
  PropsHighrise.prototype._litter = function (cellId, x, z, scale, yaw, y) {
    if (!this._atlasOk || !this.litterParts) return false;
    if (this.litterParts.length > 140) return false;
    if (y === undefined && !this._onPlate(x, z, 0.2)) return false;
    var uv = atlasUV(cellId);
    var sz = 0.30 * (scale || 1);
    var g = cardG(sz, sz * this.rng.range(0.78, 1.1), uv[0], uv[1], uv[2], uv[3],
      0.04 * (scale || 1), 3);
    var gy = y === undefined ? this._ground(x, z) : y;
    this.litterParts.push(part(g,
      Tn(x, gy + 0.012, z, -Math.PI * 0.5 + this.rng.gaussian(0, 0.16),
        yaw === undefined ? this.rng.range(0, M.TAU) : yaw, this.rng.gaussian(0, 0.16))));
    return true;
  };

  // ==========================================================================
  // ONE-OFF PROPS
  //
  // Each builder assembles its parts in LOCAL space with the origin where the
  // prop meets the floor, merges once per material, and hands the result to the
  // static bucket for that material with a single world matrix.  A prop that
  // spans two materials is two merged geometries, never two meshes.
  // ==========================================================================

  // A ribbon pinned along its top edge, for anything the wind gets hold of.
  // Local space: x across [-w/2, w/2], y from 0 (the pin) down to -h.
  // `sag` bakes a catenary into the base positions and tears the two ends.
  //
  // Stretched barrier tape does not run dead straight and it does not end in a
  // machine-cut square: it drops 60-120 mm between posts and the ends are torn,
  // dirty and twisted round whatever they were tied to. Both used to be left
  // entirely to the wind animation, which means a capture taken at a moment of
  // low gust photographed a ruler-straight vinyl ribbon glued across the frame -
  // and that ribbon runs through the lower third of two published framings.
  function ribbonG(w, h, nx, ny, u0, v0, u1, v1, sag) {
    var pos = [], nrm = [], uv = [], idx = [];
    var i, j;
    for (j = 0; j <= ny; j++) {
      for (i = 0; i <= nx; i++) {
        var fx = i / nx, fy = j / ny;
        var dy = 0, dz = 0;
        if (sag) {
          // catenary, plus a slow twist so the tape shows its back somewhere
          dy = -Math.sin(fx * Math.PI) * sag;
          dz = Math.sin(fx * Math.PI * 1.7 + 0.6) * sag * 0.35;
          // the torn ends: the last 6% of the run frays and narrows
          var endT = Math.max(0, 1 - Math.min(fx, 1 - fx) / 0.06);
          if (endT > 0) {
            var frayed = (Math.sin(fx * 813.7 + fy * 41.3) * 0.5 + 0.5);
            dy += endT * (fy - 0.5) * h * 0.55 * (0.4 + frayed);
            dz += endT * (frayed - 0.5) * h * 0.9;
          }
        }
        pos.push((fx - 0.5) * w, -fy * h + dy, dz);
        nrm.push(0, 0, 1);
        uv.push(u0 + (u1 - u0) * fx, v1 + (v0 - v1) * fy);
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
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(idx);
    return g;
  }

  // Register a wind-driven ribbon.  Kept as its own small mesh because the
  // vertices move: merging it into a static bucket would freeze it, and a sheet
  // of polythene hanging dead still on a level whose brief says "windy" is a
  // painted wall.
  PropsHighrise.prototype._flap = function (mat, geo, matrix, opts) {
    if (!geo || !mat) return null;
    opts = opts || {};
    Geo.copyUV1(geo);
    var pos = geo.attributes.position;
    var base = new Float32Array(pos.array.length);
    base.set(pos.array);
    // A vertexColors material with no `color` attribute reads undefined
    // attribute data and renders BLACK - so every ribbon carries its own, and
    // it is doing work while it is there: the free edge of a backlit sheet is
    // the brightest part of it, and creases are baked in as value.
    if (mat.vertexColors) {
      var cnt = pos.count;
      var cols = new Float32Array(cnt * 3);
      var h = Math.max(0.15, opts.h || 1);
      for (var q = 0; q < cnt; q++) {
        var vx = pos.getX(q), vy = pos.getY(q);
        var free = M.saturate(-vy / h);
        var v = (0.90 + free * 0.22) *
          (1 + this.noise.fbm2(vx * 3.1 + q * 0.01, vy * 3.1, 3) * 0.14);
        cols[q * 3] = v; cols[q * 3 + 1] = v * 0.995; cols[q * 3 + 2] = v * 0.985;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'hr_flap_' + this.flaps.length;
    mesh.castShadow = opts.cast === undefined ? false : !!opts.cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.matrixWorldNeedsUpdate = true;
    geo.computeBoundingSphere();
    if (geo.boundingSphere) geo.boundingSphere.radius *= 1.8;
    this.root.add(mesh);
    this.flaps.push({
      geo: geo, base: base, mesh: mesh,
      w: opts.w || 1, h: opts.h || 1,
      phase: this.rng.range(0, M.TAU),
      amp: opts.amp === undefined ? 1 : opts.amp,
      both: !!opts.both              // pinned at BOTH ends (tape, not sheet)
    });
    return mesh;
  };

  // ---- cable drum -----------------------------------------------------------
  PropsHighrise.prototype._cableDrum = function (x, z, yaw, r, lying) {
    var y = this._ground(x, z);
    r = r || 0.58;
    var self = this;
    var wood = new PB(), steel = new PB(), plastic = new PB();
    var i;
    var half = r * 0.52;
    // two flanges, each built from radial battens so the silhouette is not a
    // perfect disc
    for (var f = 0; f < 2; f++) {
      var fz = (f ? 1 : -1) * half;
      wood.cyl(r, r, 0.042, 16, 0, r, fz, Math.PI * 0.5, 0, 0);
      for (i = 0; i < 8; i++) {
        var a = i / 8 * M.TAU;
        wood.box(0.09, r * 1.86, 0.030, Math.cos(a) * r * 0.5, r + Math.sin(a) * r * 0.5,
          fz + (f ? 0.034 : -0.034), 0, 0, a, 0.006);
      }
      steel.tor(r * 0.98, 0.016, 14, 4, 0, r, fz + (f ? 0.05 : -0.05), 0, 0, 0);
    }
    // the wound cable and the hub
    plastic.cyl(r * 0.62, r * 0.62, half * 1.9, 14, 0, r, 0, Math.PI * 0.5, 0, 0);
    steel.cyl(0.055, 0.055, half * 2.3, 8, 0, r, 0, Math.PI * 0.5, 0, 0);
    // the free end trailing off the drum, which is what stops it being a wheel
    var px = r * 0.62, py = r * 0.30, pz = 0;
    for (i = 0; i < 7; i++) {
      var t = i / 7;
      var nx2 = px + 0.20 + t * 0.9, ny2 = M.lerp(py, 0.03, M.smoothstep(0, 0.6, t));
      var nz2 = pz + Math.sin(t * 4.1) * 0.32;
      plastic.tube(px, py, pz, nx2, ny2, nz2, 0.019, 5);
      px = nx2; py = ny2; pz = nz2;
    }
    var m = Tn(x, y, z, lying ? Math.PI * 0.5 : 0, yaw, 0);
    if (lying) m = Tn(x, y + r * 0.52, z, 0, yaw, Math.PI * 0.5);
    function push(key, pb) { var g = pb.build(); if (g) self._static(key, g, m); }
    push('wood', wood); push('steel', steel); push('plastic', plastic);
    this._collider(x, y, z, [r * 0.9, r, half * 1.2], yaw, 'wood');
    this._occupy(x, z, r + 0.5);
    return y;
  };

  // ---- stack of sheet material ----------------------------------------------
  // Plasterboard or OSB, leaning against a wall or a column.  The fan is the
  // point: sheets never lean at one angle, and the small differences are what
  // catch a nine-degree key as a run of bright edges.
  PropsHighrise.prototype._sheetStack = function (x, z, yaw, n, lean, tall) {
    var y = this._ground(x, z);
    var self = this, R = this.rng;
    var ply = new PB();
    var h = tall === undefined ? 2.44 : tall;
    var w = 1.20;
    // ---- NO TWO SHEETS THE SAME --------------------------------------------
    // The first cut leaned n identical 1.20 x 2.44 rectangles at 12 mrad
    // increments, and four of them appeared in one hero2 frame as the same
    // object copied four times. A real stack is a mixture: full sheets, cut
    // sheets, a half board, one that has slipped and is standing on its long
    // edge, one that has been sawn down the middle and lost a corner.
    for (var i = 0; i < n; i++) {
      var l = lean + i * 0.012 + R.range(-0.006, 0.006);
      var off = i * 0.021;
      var roll = R.next();
      var sw = w, sh = h;
      if (roll < 0.22) { sh = h * R.range(0.42, 0.62); }        // a cut sheet
      else if (roll < 0.38) { sw = w * R.range(0.48, 0.72); }   // a rip
      else if (roll < 0.50) { sw = h; sh = w; }                 // one on its side
      else { sh = h * R.range(0.94, 1.0); sw = w * R.range(0.93, 1.0); }
      var th = R.bool(0.28) ? 0.019 : 0.0125;                   // OSB vs ply
      // a sheet leaning at `l` from vertical, its foot kicked out
      ply.box(sw + R.range(-0.02, 0.02), sh, th,
        R.range(-0.10, 0.10) + (w - sw) * R.range(-0.4, 0.4),
        sh * 0.5 * Math.cos(l), off + sh * 0.5 * Math.sin(l),
        l, R.range(-0.05, 0.05), R.range(-0.035, 0.035), 0.003);
    }
    var m = Tn(x, y, z, 0, yaw, 0);
    var g = ply.build();
    if (g) this._static('ply', g, m);
    this._collider(x, y, z, [w * 0.6, h * 0.5, 0.18 + n * 0.011], yaw, 'wood');
    this._occupy(x, z, 0.95);
    // the offcuts and the dust that live at the foot of every sheet stack
    var fx = x - Math.sin(yaw) * 0.0, fz = z + Math.cos(yaw) * 0.0;
    this._decal(CELL.drift, fx + this.wind.x * 0.9, fz + this.wind.y * 0.9,
      R.range(1.6, 2.4), Math.atan2(this.wind.x, this.wind.y), 0.75, 0.85);
    return y;
  };

  // ---- trestle --------------------------------------------------------------
  // Built in the PARENT's local space (the caller applies the world yaw), so
  // nothing in here rotates: a trestle that yaws twice ends up across its own
  // bench top, which is exactly the kind of bug that only shows up in a capture.
  PropsHighrise.prototype._trestleG = function (pb, x, y, z, len) {
    len = len || 1.10;
    var hy = 0.78;
    var i;
    for (i = 0; i < 4; i++) {
      var sx = (i % 2 ? 1 : -1) * len * 0.44;
      var sz = (i < 2 ? -1 : 1) * 0.26;
      pb.bar(x + sx * 0.72, y, z + sz, x + sx * 0.45, y + hy, z + sz * 0.30, 0.045);
    }
    pb.box(len, 0.055, 0.10, x, y + hy + 0.026, z, 0, 0, 0, 0.008);
    pb.bar(x - len * 0.30, y + 0.34, z - 0.20, x + len * 0.30, y + 0.34, z + 0.20, 0.030);
    return hy + 0.05;
  };

  // ---- ladder ---------------------------------------------------------------
  PropsHighrise.prototype._ladder = function (x, z, yaw, lean, len) {
    var y = this._ground(x, z);
    len = len || 3.1;
    var galv = new PB();
    var w = 0.19, i;
    var tx = Math.sin(lean) * len, ty = Math.cos(lean) * len;
    for (i = 0; i < 2; i++) {
      var sx = (i ? w : -w);
      galv.bar(sx, 0, 0, sx, ty, tx, 0.030, 0.055);
    }
    var rungs = Math.floor(len / 0.28);
    for (i = 1; i < rungs; i++) {
      var t = i / rungs;
      galv.tube(-w, ty * t, tx * t, w, ty * t, tx * t, 0.014, 6);
    }
    // the anti-slip feet
    galv.box(0.075, 0.030, 0.11, -w, 0.015, 0.02, 0, 0, 0, 0.006);
    galv.box(0.075, 0.030, 0.11, w, 0.015, 0.02, 0, 0, 0, 0.006);
    var g = galv.build();
    if (g) this._static('galv', g, Tn(x, y, z, 0, yaw, 0));
    this._occupy(x, z, 0.5);
    return y;
  };

  // ---- gang box (site tool chest) -------------------------------------------
  PropsHighrise.prototype._gangBox = function (x, z, yaw) {
    var y = this._ground(x, z);
    // Contractor's yellow, not steel.  A dark box in the shaded end of a 20 m
    // concrete tube is a hole in the frame; a yellow one is the only warm mass
    // between the camera and the opening, and site tool chests really are
    // painted this colour.
    var paint = new PB(), steel = new PB();
    var w = 1.32, h = 0.72, d = 0.62;
    paint.box(w, h, d, 0, h * 0.5 + 0.06, 0, 0, 0, 0, 0.018);
    paint.box(w + 0.05, 0.075, d + 0.05, 0, h + 0.10, 0, 0, 0, 0, 0.014);  // lid lip
    // skids, so it can be dragged
    steel.box(w, 0.06, 0.09, 0, 0.03, -d * 0.36, 0, 0, 0, 0.010);
    steel.box(w, 0.06, 0.09, 0, 0.03, d * 0.36, 0, 0, 0, 0.010);
    // ribs, hasp and a padlock
    for (var i = 0; i < 3; i++) {
      steel.box(0.05, h - 0.06, d + 0.02, -w * 0.32 + i * w * 0.32, h * 0.5 + 0.06, 0, 0, 0, 0, 0.006);
    }
    steel.box(0.14, 0.16, 0.05, 0, h * 0.72, -d * 0.5 - 0.02, 0, 0, 0, 0.010);
    steel.tor(0.035, 0.010, 8, 4, 0, h * 0.72 - 0.10, -d * 0.5 - 0.03, 0, 0, 0);
    var mtx = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = paint.build(); if (g) this._static('paint', g, mtx);
    g = steel.build(); if (g) this._static('steel', g, mtx);
    this._collider(x, y, z, [w * 0.5, (h + 0.1) * 0.5, d * 0.5], yaw, 'metal');
    this._occupy(x, z, 1.0);
    // a hard hat and a pair of gloves left on the lid
    if (this.B.hat) {
      this.B.hat.add(T(x + Math.cos(yaw) * 0.3, y + h + 0.14, z + Math.sin(yaw) * 0.3,
        0.06, this.rng.range(0, M.TAU), 0.04), normTint(0xffd23a, 0.85, _col));
    }
    return y;
  };

  // ---- wheelbarrow ----------------------------------------------------------
  PropsHighrise.prototype._barrow = function (x, z, yaw, tipped) {
    var y = this._ground(x, z);
    var steel = new PB(), rub = new PB(), conc = new PB();
    var i;
    var lift = tipped ? 0 : 0.30;
    var pitch = tipped ? 0.62 : 0.10;
    // the pan: a tapered tub, built as a shallow box with splayed sides
    steel.box(0.66, 0.045, 0.86, 0, lift + 0.10, 0.05, pitch, 0, 0, 0.012);
    steel.box(0.045, 0.26, 0.86, -0.35, lift + 0.22, 0.05, pitch, 0, 0.22, 0.010);
    steel.box(0.045, 0.26, 0.86, 0.35, lift + 0.22, 0.05, pitch, 0, -0.22, 0.010);
    steel.box(0.70, 0.24, 0.045, 0, lift + 0.22, 0.48, pitch + 0.20, 0, 0, 0.010);
    steel.box(0.70, 0.20, 0.045, 0, lift + 0.20, -0.38, pitch - 0.24, 0, 0, 0.010);
    // handles and legs
    for (i = 0; i < 2; i++) {
      var sx = i ? 0.30 : -0.30;
      steel.bar(sx, lift + 0.08, 0.42, sx * 1.06, lift + 0.30, -0.86, 0.042);
      steel.bar(sx, lift + 0.08, 0.10, sx, lift - 0.24, 0.10, 0.036);
      steel.bar(sx * 0.55, lift + 0.06, 0.44, sx * 0.30, lift - 0.18, 0.86, 0.030);
    }
    // the wheel
    rub.tor(0.185, 0.062, 12, 6, 0, lift - 0.02, 0.92, 0, Math.PI * 0.5, 0);
    steel.cyl(0.075, 0.075, 0.070, 8, 0, lift - 0.02, 0.92, 0, 0, Math.PI * 0.5);
    // half a barrow of set mortar, which is why it was left
    conc.cyl(0.30, 0.24, 0.10, 10, 0, lift + 0.15, 0.05);
    var m = Tn(x, y + (tipped ? 0.24 : 0.26), z, tipped ? -0.34 : 0, yaw, 0);
    var g;
    g = steel.build(); if (g) this._static('steel', g, m);
    g = rub.build(); if (g) this._static('plastic', g, m);
    g = conc.build(); if (g) this._static('concrete', g, m);
    this._collider(x, y, z, [0.45, 0.32, 0.72], yaw, 'metal');
    this._occupy(x, z, 1.1);
    return y;
  };

  // ---- spoil heap -----------------------------------------------------------
  // Swept-up block dust and broken slab, in a real angle-of-repose cone with a
  // shovel bite out of one side.
  PropsHighrise.prototype._spoilHeap = function (x, z, r, h) {
    var y = this._ground(x, z);
    var seg = 14, rings = 3;
    var pos = [], idx = [];
    var N = this.noise, i, j;
    pos.push(0, h, 0);
    for (j = 1; j <= rings; j++) {
      var fr = j / rings;
      for (i = 0; i < seg; i++) {
        var a = i / seg * M.TAU;
        var wob = 1 + N.fbm2(Math.cos(a) * 2.2 + x, Math.sin(a) * 2.2 + z, 3) * 0.36;
        // the bite: one sector is scooped out where the shovel went in
        var bite = M.smoothstep(0.55, 0.0, Math.abs(M.wrapAngle(a - 1.1))) * 0.42;
        var rr = r * fr * wob * (1 - bite * (1 - fr) * 0.8);
        pos.push(Math.cos(a) * rr, h * (1 - fr * fr) * (1 - bite * 0.5), Math.sin(a) * rr);
      }
    }
    for (i = 0; i < seg; i++) idx.push(0, 1 + ((i + 1) % seg), 1 + i);
    for (j = 0; j < rings - 1; j++) {
      for (i = 0; i < seg; i++) {
        var a0 = 1 + j * seg + i, b0 = 1 + j * seg + ((i + 1) % seg);
        var a1 = a0 + seg, b1 = b0 + seg;
        idx.push(a0, b0, a1, b0, b1, a1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this._static('concrete', g, Tn(x, y, z, 0, this.rng.range(0, M.TAU), 0));
    this._occupy(x, z, r * 0.8);
    // and the dust that always spreads past the toe of a heap
    this._decal(CELL.drift, x + this.wind.x * (r + 0.6), z + this.wind.y * (r + 0.6),
      r * 2.6, Math.atan2(this.wind.x, this.wind.y), 0.8, 0.9);
    return y;
  };

  // ---- 110 V site transformer ------------------------------------------------
  PropsHighrise.prototype._transformer = function (x, z, yaw) {
    var y = this._ground(x, z);
    var paint = new PB(), plastic = new PB(), steel = new PB();
    paint.box(0.44, 0.34, 0.30, 0, 0.19, 0, 0, 0, 0, 0.030);
    paint.box(0.052, 0.30, 0.30, 0, 0.34, 0, 0, 0, 0, 0.012);   // the carry handle bar
    steel.tube(-0.16, 0.36, 0, 0.16, 0.36, 0, 0.016, 6);
    // the sockets: two round 16 A outlets, which is the whole read
    for (var i = 0; i < 2; i++) {
      plastic.cyl(0.052, 0.052, 0.055, 10, -0.10 + i * 0.20, 0.24, 0.155, Math.PI * 0.5, 0, 0);
      plastic.cyl(0.038, 0.038, 0.020, 8, -0.10 + i * 0.20, 0.24, 0.185, Math.PI * 0.5, 0, 0);
    }
    plastic.box(0.34, 0.05, 0.02, 0, 0.08, 0.16, 0, 0, 0, 0.006);
    var m = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = paint.build(); if (g) this._static('paint', g, m);
    g = plastic.build(); if (g) this._static('plastic', g, m);
    g = steel.build(); if (g) this._static('steel', g, m);
    this._occupy(x, z, 0.55);
    return y;
  };

  // ---- power float ----------------------------------------------------------
  // The machine that made the slab.  A ring guard, four blades, a small engine
  // and a long handle - the most specific object in the level, and it is
  // parked in the middle of the floor it finished.
  PropsHighrise.prototype._powerFloat = function (x, z, yaw) {
    var y = this._ground(x, z);
    var paint = new PB(), steel = new PB(), rub = new PB();
    var i;
    steel.tor(0.46, 0.020, 16, 5, 0, 0.16, 0, Math.PI * 0.5, 0, 0);
    for (i = 0; i < 8; i++) {
      var a = i / 8 * M.TAU;
      steel.bar(0, 0.19, 0, Math.cos(a) * 0.46, 0.16, Math.sin(a) * 0.46, 0.016);
    }
    for (i = 0; i < 4; i++) {
      var ab = i / 4 * M.TAU + 0.4;
      steel.box(0.40, 0.010, 0.13, Math.cos(ab) * 0.22, 0.022, Math.sin(ab) * 0.22,
        0, -ab, 0.10, 0.004);
    }
    paint.cyl(0.13, 0.15, 0.24, 10, 0, 0.36, 0);
    paint.box(0.30, 0.22, 0.26, 0, 0.52, 0, 0, 0, 0, 0.026);
    paint.box(0.16, 0.10, 0.20, 0.16, 0.50, 0.04, 0, 0, 0, 0.014);
    steel.cyl(0.030, 0.030, 0.20, 8, -0.14, 0.62, 0, 0.4, 0, 0);
    // the handle, running away at working angle
    steel.bar(0, 0.56, 0.12, 0, 0.98, 1.42, 0.036);
    steel.tube(-0.19, 0.98, 1.42, 0.19, 0.98, 1.42, 0.022, 6);
    rub.cyl(0.030, 0.030, 0.13, 8, -0.15, 0.98, 1.42, 0, 0, Math.PI * 0.5);
    rub.cyl(0.030, 0.030, 0.13, 8, 0.15, 0.98, 1.42, 0, 0, Math.PI * 0.5);
    var m = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = paint.build(); if (g) this._static('paint', g, m);
    g = steel.build(); if (g) this._static('steel', g, m);
    g = rub.build(); if (g) this._static('plastic', g, m);
    this._collider(x, y, z, [0.5, 0.4, 0.6], yaw, 'metal');
    this._occupy(x, z, 1.4);
    return y;
  };

  // ---- gas bottles in a stillage cage ---------------------------------------
  PropsHighrise.prototype._gasCage = function (x, z, yaw) {
    var y = this._ground(x, z);
    var steel = new PB(), paint = new PB();
    var i, k;
    var w = 1.05, d = 0.72, h = 1.30;
    for (i = 0; i < 4; i++) {
      steel.bar((i % 2 ? 1 : -1) * w * 0.5, 0, (i < 2 ? -1 : 1) * d * 0.5,
        (i % 2 ? 1 : -1) * w * 0.5, h, (i < 2 ? -1 : 1) * d * 0.5, 0.038);
    }
    for (k = 0; k < 3; k++) {
      var ry = 0.10 + k * 0.55;
      steel.tube(-w * 0.5, ry, -d * 0.5, w * 0.5, ry, -d * 0.5, 0.016, 5);
      steel.tube(-w * 0.5, ry, d * 0.5, w * 0.5, ry, d * 0.5, 0.016, 5);
      steel.tube(-w * 0.5, ry, -d * 0.5, -w * 0.5, ry, d * 0.5, 0.016, 5);
      steel.tube(w * 0.5, ry, -d * 0.5, w * 0.5, ry, d * 0.5, 0.016, 5);
    }
    steel.box(w, 0.04, d, 0, 0.02, 0, 0, 0, 0, 0.008);
    // three bottles, one of them shorter and lying down
    var cols = [0x9a2820, 0x1e5a86, 0x24513a];
    for (i = 0; i < 3; i++) {
      var bx = -0.30 + i * 0.30, bz = (i === 1 ? 0.14 : -0.10);
      paint.cyl(0.115, 0.115, 0.92, 10, bx, 0.48, bz);
      paint.cyl(0.115, 0.070, 0.14, 10, bx, 1.00, bz);
      steel.cyl(0.048, 0.048, 0.13, 8, bx, 1.12, bz);
      steel.tor(0.075, 0.014, 8, 4, bx, 1.16, bz, Math.PI * 0.5, 0, 0);
    }
    var m = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = steel.build(); if (g) this._static('steel', g, m);
    g = paint.build(); if (g) this._static('paint', g, m);
    this._collider(x, y, z, [w * 0.5, h * 0.5, d * 0.5], yaw, 'metal');
    this._occupy(x, z, 1.2);
    return y;
  };

  // ---- reinforcement mesh sheet, leaning ------------------------------------
  PropsHighrise.prototype._meshSheet = function (x, z, yaw, lean, n) {
    var y = this._ground(x, z);
    var rust = new PB();
    var w = 2.20, h = 2.40, i, k;
    n = n || 1;
    for (k = 0; k < n; k++) {
      var off = k * 0.035;
      var cs = Math.cos(lean), sn = Math.sin(lean);
      for (i = 0; i <= 10; i++) {
        var ux = -w * 0.5 + i * w / 10;
        rust.bar(ux, 0.02, off, ux, h * cs, off + h * sn, 0.008);
      }
      for (i = 0; i <= 11; i++) {
        var v = i / 11 * h;
        rust.bar(-w * 0.5, v * cs, off + v * sn + 0.010, w * 0.5, v * cs, off + v * sn + 0.010, 0.008);
      }
    }
    var g = rust.build();
    if (g) this._static('rust', g, Tn(x, y, z, 0, yaw, 0));
    this._collider(x, y, z, [w * 0.5, h * 0.4, 0.25], yaw, 'metal');
    this._occupy(x, z, 1.3);
    return y;
  };

  // ---- an extension lead snaking across the floor ---------------------------
  // The single most under-used piece of set dressing there is: a 30 m lead is a
  // continuous line that ties three unrelated vignettes into one story about
  // where the power comes from.
  PropsHighrise.prototype._leadRun = function (pts, r) {
    if (!pts || pts.length < 2) return;
    var plastic = new PB();
    r = r || 0.016;
    var prev = null;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var y = this._ground(p[0], p[1]) + r;
      if (prev) {
        // subdivide so the lead lies in the slab's own hollows instead of
        // bridging them
        var steps = Math.max(2, Math.ceil(Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 0.8));
        for (var s = 0; s < steps; s++) {
          var t0 = s / steps, t1 = (s + 1) / steps;
          var ax = M.lerp(prev[0], p[0], t0), az = M.lerp(prev[1], p[1], t0);
          var bx = M.lerp(prev[0], p[0], t1), bz = M.lerp(prev[1], p[1], t1);
          plastic.tube(ax, this._ground(ax, az) + r, az, bx, this._ground(bx, bz) + r, bz, r, 5);
        }
      }
      prev = [p[0], p[1], y];
    }
    var g = plastic.build();
    if (g) this._static('plastic', g, null);
  };

  // ---- mortar tub -----------------------------------------------------------
  PropsHighrise.prototype._tub = function (x, z, yaw, mortar) {
    var y = this._ground(x, z);
    var plastic = new PB(), conc = new PB();
    plastic.cyl(0.31, 0.24, 0.24, 12, 0, 0.12, 0, 0, 0, 0, true);
    plastic.tor(0.315, 0.014, 12, 5, 0, 0.238, 0, Math.PI * 0.5, 0, 0);
    plastic.cyl(0.24, 0.24, 0.014, 12, 0, 0.007, 0);
    if (mortar !== false) conc.cyl(0.27, 0.235, 0.08, 12, 0, 0.06, 0);
    var m = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = plastic.build(); if (g) this._static('plastic', g, m);
    g = conc.build(); if (g) this._static('concrete', g, m);
    this._occupy(x, z, 0.42);
    return y;
  };

  // ---- a long-handled tool leaning against something ------------------------
  PropsHighrise.prototype._tool = function (x, z, yaw, lean, kind, againstY) {
    var y = this._ground(x, z);
    var wood = new PB(), steel = new PB();
    var len = kind === 'broom' ? 1.55 : 1.35;
    var tx = Math.sin(lean) * len, ty = Math.cos(lean) * len;
    wood.bar(0, 0.02, 0, tx, ty, 0, 0.024);
    if (kind === 'broom') {
      steel.box(0.055, 0.075, 0.42, 0, 0.06, 0, 0, 0, 0, 0.008);
      for (var i = 0; i < 9; i++) {
        wood.bar(-0.01, 0.055, -0.19 + i * 0.048, 0.005, 0.005, -0.20 + i * 0.050, 0.010);
      }
    } else if (kind === 'shovel') {
      steel.box(0.26, 0.010, 0.32, 0, 0.035, 0.02, -0.10, 0, 0, 0.008);
      steel.box(0.10, 0.06, 0.10, 0, 0.075, -0.10, 0, 0, 0, 0.008);
    } else {
      steel.box(0.09, 0.09, 0.20, 0, 0.07, 0, 0, 0, 0, 0.012);
    }
    var m = Tn(x, y, z, 0, yaw, 0);
    var g;
    g = wood.build(); if (g) this._static('wood', g, m);
    g = steel.build(); if (g) this._static('steel', g, m);
    this._occupy(x, z, 0.3);
    return y;
  };

  // ---- a pile of stacked pallets --------------------------------------------
  PropsHighrise.prototype._palletStack = function (x, z, yaw, n) {
    var y = this._ground(x, z);
    if (!this.B.pallet) return y;
    for (var i = 0; i < n; i++) {
      this.B.pallet.add(
        T(x + this.rng.gaussian(0, 0.035), y + i * 0.145, z + this.rng.gaussian(0, 0.035),
          this.rng.gaussian(0, 0.010), yaw + this.rng.gaussian(0, 0.055),
          this.rng.gaussian(0, 0.010)),
        wearTint(this.rng));
    }
    this._collider(x, y, z, [0.62, n * 0.075, 0.55], yaw, 'wood');
    this._occupy(x, z, 0.95);
    return y + n * 0.145;
  };

  // ---- stack of cement bags on a pallet -------------------------------------
  PropsHighrise.prototype._bagStack = function (x, z, yaw, courses) {
    var y = this._palletStack(x, z, yaw, 1);
    var paper = new PB();
    var R = this.rng;
    var slumped = R.int(1, 3);
    for (var c = 0; c < courses; c++) {
      var per = c === courses - 1 ? R.int(2, 4) : 4;
      for (var i = 0; i < per; i++) {
        var rot = (c % 2) ? Math.PI * 0.5 : 0;
        var px = (i % 2 ? 0.27 : -0.27), pz = (i < 2 ? -0.19 : 0.19);
        if (rot) { var t = px; px = pz * 1.4; pz = t * 0.7; }
        paper.box(0.52, 0.115, 0.36,
          px + R.gaussian(0, 0.02), 0.058 + c * 0.115, pz + R.gaussian(0, 0.02),
          R.gaussian(0, 0.03), rot + R.gaussian(0, 0.05), R.gaussian(0, 0.03), 0.045);
      }
      if (c === slumped) {
        // one bag has slid off the stack and split on the floor
        paper.box(0.52, 0.09, 0.36, R.range(0.55, 0.75), -0.10, R.range(-0.3, 0.3),
          0.05, R.range(0, 3), 0.03, 0.04);
      }
    }
    var g = paper.build();
    if (g) {
      roughen(g, this.noise, 0.012, 6.0);
      this._static('paper', g, Tn(x, y, z, 0, yaw, 0));
    }
    this._collider(x, y - 0.145, z, [0.6, courses * 0.06 + 0.08, 0.45], yaw, 'concrete');
    this._occupy(x, z, 1.0);
    // burst cement makes a pale halo nothing else on this floor makes
    this._decal(CELL.drill, x + 0.75, z, 1.5, 0, 1, 0.8);
    return y + courses * 0.115;
  };

  // A bundle of long members stood on end against something.  Real bundles are
  // never parallel: every one of them leans a little differently and the tops
  // fan out, which is the whole silhouette.
  PropsHighrise.prototype._leanBundle = function (batch, x, z, yaw, n, len, lean, spread) {
    if (!batch) return;
    var R = this.rng;
    var y = this._ground(x, z);
    for (var i = 0; i < n; i++) {
      var a = yaw + R.gaussian(0, 0.26);
      var l = lean + R.range(-0.05, 0.06);
      var ox = R.gaussian(0, spread), oz = R.gaussian(0, spread);
      batch.add(T(x + ox, y + len * 0.5 * Math.cos(l), z + oz,
        l - Math.PI * 0.5, a, R.gaussian(0, 0.04)), wearTint(R));
    }
    this._occupy(x, z, 0.55 + spread);
  };

  // ==========================================================================
  // PASS 1 - THE HOIST LANDING
  //
  // Everything on this floor arrived through a 1.2 m cage on the east face and
  // was barrowed inboard, so this corner is where the material IS and the lane
  // west of it is what is kept clear.  Dressing it is what makes the rest of
  // the floor legible: it answers "how did any of this get up here".
  // ==========================================================================
  PropsHighrise.prototype._dressHoistLanding = function () {
    var R = this.rng, i;
    var land = (this.hoist && this.hoist.landing) ? this.hoist.landing : { x: 26.4, z: -13.4 };
    var lx = land.x, lz = land.z;

    // ---- what just came up, still on its pallet ----------------------------
    this._bagStack(lx - 2.2, lz - 3.3, 0.10, 4);
    this._palletStack(lx - 1.4, lz + 2.6, -0.22, 6);
    this._palletStack(lx - 3.6, lz + 3.4, 0.34, 3);

    // ---- what is going back down: spoil in bulk bags ------------------------
    var bags = [[lx - 3.4, lz - 5.0], [lx - 2.1, lz - 5.9], [lx - 4.5, lz - 6.2],
                [lx - 1.2, lz - 6.8]];
    for (i = 0; i < bags.length; i++) {
      this._drop(this.B.bulkBag, bags[i][0], bags[i][1], {
        r: 0.75, yaw: R.range(0, M.TAU), tilt: 0.02, h: 1.0,
        scale: R.range(0.88, 1.08), collider: [0.48, 0.5, 0.48], material: 'fabric'
      });
      // spoil spills round the foot of every one of them
      this._decal(CELL.drift, bags[i][0] + this.wind.x * 0.9, bags[i][1] + this.wind.y * 0.9,
        R.range(1.7, 2.4), Math.atan2(this.wind.x, this.wind.y), 0.8, 0.9);
    }
    this._spoilHeap(lx - 5.6, lz - 4.2, 1.05, 0.42);

    // ---- plant ---------------------------------------------------------------
    this._gasCage(lx - 0.9, lz - 4.4, -0.14);
    this._transformer(lx - 4.6, lz + 0.9, 0.6);
    this._gangBox(lx - 5.9, lz + 2.2, -0.35);
    for (i = 0; i < 3; i++) {
      this._drop(this.B.jerry, lx - 6.4 + R.range(-0.2, 0.2), lz - 1.1 + i * 0.42, {
        r: 0.26, yaw: R.range(0, M.TAU), h: 0.36,
        color: normTint(i === 1 ? 0xd8402a : 0x2f3134, 0.8, _col)
      });
    }

    // ---- sheet material leaning on the core's north wall --------------------
    // The one solid vertical face on this side of the floor, so it is where
    // everything sheet-shaped ends up.
    this._sheetStack(19.4, -10.45, 0, 9, 0.17);
    this._sheetStack(15.6, -10.45, 0.04, 7, 0.15);
    this._meshSheet(17.4, -10.5, 0.02, 0.16, 3);

    // ---- the lane itself ----------------------------------------------------
    // Cones down one side only.  A lane coned on both sides is a road; coned on
    // one it is a route somebody made up this morning.
    for (i = 0; i < 7; i++) {
      var cx = lx - 2.5 - i * 3.4;
      this._drop(this.B.cone, cx + R.range(-0.3, 0.3), lz + 1.55 + R.range(-0.25, 0.25), {
        r: 0.30, lane: false, yaw: R.range(0, M.TAU), tilt: 0.05, h: 0.55
      });
    }
    // the barrow that does the carrying, parked at the end of its run
    this._barrow(lx - 8.4, lz + 2.0, 1.9, false);
    // the lead that feeds the whole floor, running from the transformer to the
    // work faces - see _dressWorkstations, which picks it up again
    this._leadRun([[lx - 4.4, lz + 1.4], [lx - 9.0, lz + 2.6], [16.0, -9.0],
                   [9.5, -7.4], [4.0, -9.6], [-2.5, -13.2]], 0.017);
    this._leadRun([[lx - 4.8, lz + 0.6], [lx - 12.0, lz - 2.2], [8.0, -17.4],
                   [-1.0, -18.0], [-9.0, -17.0]], 0.014);

    // scuffed rubber down the lane where the barrow tyre runs
    for (i = 0; i < 9; i++) {
      var sx = lx - 1.5 - i * 3.0;
      this._decal(CELL.scuff, sx, lz + R.range(-0.7, 0.7), R.range(1.6, 2.6),
        Math.PI * 0.5 + R.range(-0.2, 0.2), 0.55, 0.55);
    }
  };

  // ==========================================================================
  // PASS 2 - THE WORK FACES
  //
  // Three vignettes, each of which is one person's afternoon: a block-cutting
  // station, a fixing station, and the place the gang sits at five o'clock.
  // A construction floor is not props on a floor, it is jobs half-finished.
  // ==========================================================================
  PropsHighrise.prototype._dressWorkstations = function () {
    var R = this.rng, i;

    // ---- the machine that made the slab ------------------------------------
    // Parked, handle down, in the sun.  Nothing else in the level explains why
    // 2200 m2 of concrete is burnished.
    this._powerFloat(-16.6, -12.2, 2.35);
    this._decal(CELL.sweep, -15.4, -13.4, 3.2, 2.35, 1.0, 0.8);

    // ---- station 1: cutting blocks -----------------------------------------
    // Against the column at (-4.5, -16): a bench of two trestles and a plank,
    // the saw on it, and a fan of block dust downwind of the blade.  The dust
    // fan is the whole point - it is the only thing in the level that records
    // an action rather than an object.
    (function (self) {
      var bx = -6.6, bz = -14.3, yaw = 0.42;
      var steel = new PB(), wood = new PB(), paint = new PB();
      var y = self._ground(bx, bz);
      self._trestleG(steel, -0.62, 0, 0, 1.0);
      self._trestleG(steel, 0.62, 0, 0, 1.0);
      wood.box(2.35, 0.045, 0.60, 0, 0.836, 0, 0, 0.02, 0, 0.008);
      wood.box(2.35, 0.045, 0.36, 0, 0.836, 0.42, 0, 0.02, 0.03, 0.008);
      // the cut-off saw: a body, a guard and a disc
      paint.box(0.42, 0.24, 0.20, 0.42, 0.98, -0.02, 0, 0.30, 0, 0.026);
      paint.cyl(0.020, 0.020, 0.46, 8, 0.72, 1.06, 0.06, 0, 0.30, 1.05);
      steel.cyl(0.175, 0.175, 0.006, 14, 0.86, 0.94, 0.14, 0, 0.30, 0);
      paint.cyl(0.20, 0.20, 0.055, 14, 0.86, 0.99, 0.14, 0, 0.30, 0);
      // the blocks waiting and the blocks cut
      var m = Tn(bx, y, bz, 0, yaw, 0);
      var g;
      g = steel.build(); if (g) self._static('steel', g, m);
      g = wood.build(); if (g) self._static('wood', g, m);
      g = paint.build(); if (g) self._static('paint', g, m);
      self._collider(bx, y, bz, [1.25, 0.5, 0.55], yaw, 'wood');
      self._occupy(bx, bz, 1.7);

      // the dust fan, thrown downwind of the blade
      var wx = self.wind.x, wz = self.wind.y;
      var wa = Math.atan2(wx, wz);
      for (i = 0; i < 5; i++) {
        var d = 0.9 + i * 1.05;
        self._decal(CELL.drift, bx + wx * d + R.gaussian(0, 0.5), bz + wz * d + R.gaussian(0, 0.5),
          2.2 + i * 0.7, wa, 0.7, 0.92 - i * 0.11);
      }
      self._decal(CELL.drill, bx + 0.7, bz + 0.5, 2.0, 0, 1, 0.95);
      // offcuts, thrown where a person throws them: behind the bench, in a heap
      for (i = 0; i < 16; i++) {
        var a = R.range(-1.0, 1.0) + yaw + Math.PI;
        var rr = R.range(0.9, 3.0);
        self._drop(self.B.block, bx + Math.sin(a) * rr, bz + Math.cos(a) * rr, {
          r: 0.24, low: true, yaw: R.range(0, M.TAU), tilt: 0.30,
          scale: R.range(0.62, 1.05), h: 0.2
        });
      }
      for (i = 0; i < 10; i++) {
        var a2 = R.range(0, M.TAU), r2 = R.range(0.6, 2.6);
        self._drop(self.B.rubble, bx + Math.sin(a2) * r2, bz + Math.cos(a2) * r2, {
          r: 0.16, low: true, tilt: 0.4, scale: R.range(0.5, 1.0), h: 0.15
        });
      }
      // the bucket the water for the saw came out of, and the tub beside it
      self._drop(self.B.bucket, bx - 1.5, bz + 0.9, { r: 0.28, h: 0.3,
        color: normTint(0x2a2c2e, 0.85, _col) });
      self._tub(bx - 2.1, bz + 0.4, 0.9);
      self._tool(bx - 0.2, bz - 1.25, yaw + 0.2, 0.34, 'broom');
    })(this);

    // ---- station 2: fixing ---------------------------------------------------
    // Mesh and bar against the column at (-13.5, -8), with the tails, the tying
    // wire and the offcut bar the fixers leave in a ring around themselves.
    (function (self) {
      var cx = -13.2, cz = -9.6;
      self._meshSheet(cx + 0.9, cz - 0.4, 0.15, 0.19, 4);
      self._leanBundle(self.B.tube, cx - 1.3, cz + 0.5, 0.4, 7, 2.40, 0.24, 0.09);
      for (i = 0; i < 14; i++) {
        var a = R.range(0, M.TAU), rr = R.range(0.8, 3.4);
        self._drop(self.B.rebar, cx + Math.sin(a) * rr, cz + Math.cos(a) * rr, {
          r: 0.22, low: true, yaw: R.range(0, M.TAU), tilt: 0.06,
          scale: R.range(0.5, 1.15), h: 0.1
        });
      }
      // the drum the tying wire comes off, lying on its side
      self._cableDrum(cx - 2.6, cz + 1.9, 0.7, 0.34, true);
      self._drop(self.B.bucket, cx + 1.9, cz + 1.4, { r: 0.28, h: 0.3,
        color: normTint(0xd8d2c4, 0.7, _col) });
      self._decal(CELL.rust, cx + 0.6, cz - 0.2, 2.4, 0.4, 1.0, 0.55);
      self._decal(CELL.crumbs, cx - 0.4, cz + 1.1, 1.8, 1.2, 1.0, 0.85);
    })(this);

    // ---- station 3: the break spot ------------------------------------------
    // Hard against the north edge, in the last of the sun, facing the view.
    // Two upturned buckets, a pallet for a table, cups, and the ring of butts
    // that is the most human mark on any building site in the world.
    (function (self) {
      var bx = -8.6, bz = -19.3;
      if (!self._onPlate(bx, bz, 0.3)) return;
      var y = self._palletStack(bx, bz, 0.34, 2);
      // seats
      self._drop(self.B.bucket, bx - 1.05, bz + 0.55, {
        r: 0.30, yaw: 0.5, pitch: Math.PI, lift: 0.30, h: 0.3, lane: false,
        color: normTint(0x2f3134, 0.85, _col)
      });
      self._drop(self.B.bucket, bx + 1.15, bz + 0.30, {
        r: 0.30, yaw: 2.1, pitch: Math.PI, lift: 0.30, h: 0.3, lane: false,
        color: normTint(0xd06a20, 0.7, _col)
      });
      // what is on the table
      if (self.B.cup) {
        for (i = 0; i < 3; i++) {
          self.B.cup.add(T(bx + R.range(-0.35, 0.35), y + 0.005, bz + R.range(-0.3, 0.3),
            R.gaussian(0, 0.05), R.range(0, M.TAU), R.gaussian(0, 0.05)),
            wearTint(R));
        }
      }
      var flask = new PB();
      flask.cyl(0.048, 0.052, 0.26, 10, 0, 0.13, 0);
      flask.cyl(0.054, 0.054, 0.035, 10, 0, 0.275, 0);
      flask.cyl(0.044, 0.044, 0.055, 10, 0.13, 0.028, 0.05);
      var fg = flask.build();
      if (fg) self._static('plastic', fg, Tn(bx + 0.25, y, bz - 0.15, 0, 0.7, 0));
      // the ring of butts, and the newspaper somebody weighted with a block
      for (i = 0; i < 5; i++) {
        var a = i / 5 * M.TAU + 0.4;
        self._decal(CELL.crumbs, bx + Math.sin(a) * R.range(0.9, 1.7),
          bz + Math.cos(a) * R.range(0.9, 1.7), R.range(0.7, 1.2), R.range(0, M.TAU), 1, 0.9);
      }
      self._litter(CELL.paper, bx + 1.6, bz - 0.9, 1.5, 0.6);
      self._drop(self.B.block, bx + 1.72, bz - 0.95, {
        r: 0.12, low: true, lane: false, tilt: 0.05, scale: 0.8, h: 0.1
      });
      self._drop(self.B.hat, bx - 0.55, bz - 0.65, {
        r: 0.20, low: true, lane: false, yaw: 1.2, tilt: 0.18,
        color: normTint(0xffd23a, 0.85, _col)
      });
      self._decal(CELL.boots, bx - 0.2, bz + 1.9, 2.6, 0.2, 1.4, 0.7);
    })(this);

    // ---- the mid-floor material dump ----------------------------------------
    // Between the two lanes, where a stack does not block either of them.
    this._sheetStack(1.9, -9.1, 1.62, 8, 0.16);
    this._palletStack(3.4, -10.4, 0.5, 4);
    this._drop(this.B.bulkBag, 0.4, -11.0, { r: 0.75, h: 1.0, yaw: 0.8,
      collider: [0.48, 0.5, 0.48], material: 'fabric' });

    // ---- the north strip: material stood UP against the sunlit columns ------
    //
    // Everything above is under a metre tall, and a floor dressed entirely
    // below knee height leaves the band the eye actually reads - one to two and
    // a half metres - completely empty.  The fix is not more clutter, it is the
    // one thing a site really does stand upright: long members leaned against a
    // column.  On the z = -16 and z = -8 grid lines those bundles sit squarely
    // in the raking light, each one throwing its own 20 m shadow beside the
    // column's, so they add vertical mass AND more of the level's own subject.
    var lean = [
      [-22.5, -16.0, 0.9], [-13.5, -16.0, -0.6], [-4.5, -16.0, 1.7],
      [4.5, -16.0, -1.3], [-13.5, -8.0, 2.4], [13.5, -16.0, 0.4]
    ];
    for (i = 0; i < lean.length; i++) {
      var lx = lean[i][0], lz = lean[i][1], la = lean[i][2];
      // against the face, not through it: the bundle stands 0.55 m off the
      // column and leans back into it
      var bx = lx + Math.sin(la) * 0.62, bz = lz + Math.cos(la) * 0.62;
      if (!this._onPlate(bx, bz, 0.6)) continue;
      this._leanBundle(i % 2 ? this.B.acrow : this.B.tube, bx, bz, la + Math.PI,
        R.int(6, 10), i % 2 ? 2.50 : 2.40, 0.19 + R.range(0, 0.06), 0.11);
      if (R.bool(0.5)) {
        this._leanBundle(i % 2 ? this.B.tube : this.B.acrow,
          bx + Math.cos(la) * 0.55, bz - Math.sin(la) * 0.55, la + Math.PI + 0.3,
          R.int(4, 7), i % 2 ? 2.40 : 2.50, 0.23, 0.09);
      }
      // and the debris that always collects between a bundle and its column
      this._decal(CELL.drift, lx + this.wind.x * 1.4, lz + this.wind.y * 1.4,
        R.range(2.4, 3.4), Math.atan2(this.wind.x, this.wind.y), 0.7, 0.85);
    }

    // Mesh panels stood on edge in the same band - a 2.2 m grid of bar against
    // a sunset is the most legible silhouette in the kit.
    this._meshSheet(-3.4, -18.7, 0.06, 0.17, 3);
    this._meshSheet(9.6, -17.9, -0.10, 0.15, 2);
    this._palletStack(-1.6, -19.0, 0.28, 5);
    this._drop(this.B.bulkBag, -16.4, -19.3, { r: 0.75, h: 1.0, yaw: -0.4,
      collider: [0.48, 0.5, 0.48], material: 'fabric' });
    this._drop(this.B.bulkBag, -15.2, -19.9, { r: 0.75, h: 1.0, yaw: 1.1,
      collider: [0.48, 0.5, 0.48], material: 'fabric' });

    // ---- THE SUNLIT RUN ------------------------------------------------------
    // The strip between the z = -16 and z = -8 grid lines is the largest surface
    // in five of the six framings and the one the signature shot looks straight
    // down, and it was carrying about one readable object per 300 m2 - one bulk
    // bag, one coil, one small stack. Meanwhile the module models a wheelbarrow,
    // a mortar tub, a 110 V transformer, a gas stillage and a spoil heap that
    // almost never reached camera. The budget is 500 draws / 4.5M triangles
    // against 320 / 1.05M, so this is triangles that were simply not being spent.
    //
    // Three or four readable objects per hundred square metres, on the two grid
    // lines rather than scattered, because material lands where the crane can
    // put it down and that is between the columns.
    this._barrow(6.2, -12.6, 1.15, false);
    this._tub(7.4, -13.4, 0.55);
    this._tub(5.1, -11.4, 2.35, true);
    this._transformer(9.2, -15.6, 1.30);
    this._leadRun([[9.6, -15.0], [7.4, -11.8], [4.2, -10.4], [1.0, -12.6]], 0.014);
    this._gangBox(12.6, -13.8, 0.35);
    this._spoilHeap(15.4, -11.0, 1.15, 0.44);
    this._spoilHeap(19.8, -8.6, 0.95, 0.36);
    this._gasCage(17.2, -14.6, -0.42);
    this._palletStack(13.4, -17.4, -0.22, 6);
    this._palletStack(20.6, -16.2, 0.41, 4);
    this._sheetStack(11.2, -11.2, 0.92, 7, 0.15);
    this._sheetStack(22.4, -12.4, -0.55, 5, 0.13);
    this._cableDrum(2.6, -8.6, 1.9, 0.62, false);
    this._meshSheet(17.8, -18.4, 0.22, 0.16, 3);
    this._drop(this.B.bulkBag, 8.6, -18.6, { r: 0.75, h: 1.0, yaw: 0.7,
      collider: [0.48, 0.5, 0.48], material: 'fabric' });
    this._tool(11.0, -15.9, 0.9, 0.30, 'shovel');
    this._tool(15.0, -12.2, 2.3, 0.36, 'broom');

    // and the offcuts, bag ends and tie wire that live on a floor between them.
    // Instanced, so 120 more objects is zero extra draw calls.
    var runDebris = 0, gd = 0;
    while (runDebris < 120 && gd++ < 900) {
      var dx = R.range(-2.0, 25.0), dz = R.range(-19.5, -6.5);
      if (!this._onPlate(dx, dz, 0.8)) continue;
      if (!this._laneClear(dx, dz, 0.2, true)) { if (!R.bool(0.25)) continue; }
      var roll3 = R.next();
      if (roll3 < 0.30) {
        if (this._drop(this.B.timber, dx, dz, { r: 0.22, low: true, tilt: 0.10,
          scale: R.range(0.35, 0.9), h: 0.08, yaw: R.range(0, M.TAU) })) runDebris++;
      } else if (roll3 < 0.56) {
        if (this._drop(this.B.rubble, dx, dz, { r: 0.13, low: true, tilt: 0.5,
          scale: R.range(0.3, 0.8), h: 0.10 })) runDebris++;
      } else if (roll3 < 0.74) {
        if (this._drop(this.B.block, dx, dz, { r: 0.15, low: true, tilt: 0.45,
          scale: R.range(0.35, 0.8), h: 0.12 })) runDebris++;
      } else if (roll3 < 0.88) {
        if (this._drop(this.B.rebar, dx, dz, { r: 0.20, low: true, tilt: 0.05,
          scale: R.range(0.5, 1.1), h: 0.08, yaw: R.range(0, M.TAU) })) runDebris++;
      } else {
        if (this._litter(R.pick([CELL.paper, CELL.card, CELL.sack, CELL.bag]),
          dx, dz, R.range(0.6, 1.1))) runDebris++;
      }
    }
    // the tyre ruts and barrow tracks between the hoist, the core and the edge:
    // a wear layer along the routes people actually take, which is the one thing
    // 2200 m2 of power-floated concrete cannot supply for itself
    var ROUTES = [
      [[25.5, -13.4], [16.0, -13.0], [8.6, -12.2]],
      [[8.6, -12.2], [2.0, -14.0], [-6.0, -17.0]],
      [[8.6, -12.2], [4.0, -8.0], [-2.0, -6.5]],
      [[13.0, -16.0], [13.5, -19.0], [8.0, -19.6]]
    ];
    for (i = 0; i < ROUTES.length; i++) {
      var rt = ROUTES[i];
      for (var seg = 0; seg < rt.length - 1; seg++) {
        var a0 = rt[seg], a1 = rt[seg + 1];
        var segLen = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
        var steps = Math.max(2, Math.round(segLen / 2.4));
        var ang2 = Math.atan2(a1[0] - a0[0], a1[1] - a0[1]);
        for (var q5 = 0; q5 < steps; q5++) {
          var tt = (q5 + 0.5) / steps;
          var rx = M.lerp(a0[0], a1[0], tt) + R.gaussian(0, 0.35);
          var rz = M.lerp(a0[1], a1[1], tt) + R.gaussian(0, 0.35);
          this._decal(CELL.scuff, rx, rz, R.range(2.6, 4.0), ang2 + R.gaussian(0, 0.10),
            R.range(0.35, 0.6), R.range(0.30, 0.55));
          if (R.bool(0.5)) {
            this._decal(CELL.boots, rx + R.gaussian(0, 0.5), rz + R.gaussian(0, 0.5),
              R.range(2.0, 3.0), ang2 + R.gaussian(0, 0.15), 1.5, R.range(0.30, 0.55));
          }
        }
      }
    }
  };

  // ==========================================================================
  // PASS 3 - THE INSTALLED FACADE
  //
  // The glazing gang's kit, running down the inside of the curtain wall.  This
  // is hero2's corridor: the mullion run is the leading line, so everything
  // here hugs the wall and leaves the middle open.
  // ==========================================================================
  PropsHighrise.prototype._dressFacade = function () {
    var R = this.rng, i;
    var cw = this.curtain;
    var wx = cw && cw.west ? cw.west.x : -26.82;      // the glass line
    var sz = cw && cw.south ? cw.south.z : 20.82;
    var standoff = 0.75;

    // ---- sheet packing and spare units, against the glass -------------------
    // Four stacks at an irregular rhythm down the run.  Seen against a curtain
    // wall with the sun behind it they are the only near-white in the frame and
    // they give the corridor its depth cue: each one is a step further away and
    // a stop darker.
    this._sheetStack(wx + standoff + 0.15, 7.9, -Math.PI * 0.5 - 0.04, 6, 0.16);
    this._sheetStack(wx + standoff + 0.15, 11.3, -Math.PI * 0.5 + 0.03, 4, 0.13);
    this._sheetStack(wx + standoff + 0.15, 15.2, -Math.PI * 0.5 + 0.05, 5, 0.14);

    // ---- the glazing gang's bench -------------------------------------------
    (function (self) {
      var bx = wx + 1.95, bz = 13.0, yaw = -1.62;
      var steel = new PB(), wood = new PB(), plastic = new PB();
      var y = self._ground(bx, bz);
      self._trestleG(steel, -0.55, 0, 0, 1.0);
      self._trestleG(steel, 0.55, 0, 0, 1.0);
      wood.box(2.10, 0.042, 0.55, 0, 0.834, 0, 0, 0, 0, 0.008);
      // sealant guns, cartridges and a coil of gasket
      for (i = 0; i < 5; i++) {
        plastic.cyl(0.026, 0.026, 0.22, 8, -0.7 + i * 0.13, 0.87, R.range(-0.12, 0.12),
          0, R.range(0, 3), Math.PI * 0.5);
      }
      steel.box(0.30, 0.07, 0.09, 0.5, 0.89, -0.10, 0, 0.3, 0, 0.010);
      steel.cyl(0.028, 0.028, 0.24, 8, 0.62, 0.89, -0.02, 0, 0.3, Math.PI * 0.5);
      for (i = 0; i < 4; i++) {
        plastic.tor(0.13 + i * 0.012, 0.014, 12, 4, -0.15, 0.87 + i * 0.028, 0.16, Math.PI * 0.5, 0, 0);
      }
      var m = Tn(bx, y, bz, 0, yaw, 0);
      var g;
      g = steel.build(); if (g) self._static('steel', g, m);
      g = wood.build(); if (g) self._static('wood', g, m);
      g = plastic.build(); if (g) self._static('plastic', g, m);
      self._collider(bx, y, bz, [1.1, 0.5, 0.45], yaw, 'wood');
      self._occupy(bx, bz, 1.5);
    })(this);

    // ---- the vacuum lifter, leaning on the glass ----------------------------
    // A glazing robot's frame is a big, legible, unmistakable object and it is
    // the one thing that says which trade is on this floor this week.
    (function (self) {
      var bx = wx + 0.95, bz = 4.5, yaw = -Math.PI * 0.5;
      var steel = new PB(), rub = new PB();
      var lean = 0.20, h = 1.95, w = 1.55;
      var cs = Math.cos(lean), sn = Math.sin(lean);
      steel.bar(-w * 0.5, 0.02, 0, -w * 0.5, h * cs, h * sn, 0.055);
      steel.bar(w * 0.5, 0.02, 0, w * 0.5, h * cs, h * sn, 0.055);
      steel.bar(-w * 0.5, h * 0.5 * cs, h * 0.5 * sn, w * 0.5, h * 0.5 * cs, h * 0.5 * sn, 0.045);
      steel.bar(-w * 0.5, h * cs, h * sn, w * 0.5, h * cs, h * sn, 0.045);
      // four suction pads
      for (i = 0; i < 4; i++) {
        var px = (i % 2 ? 0.42 : -0.42), py = (i < 2 ? 0.55 : 1.42);
        rub.cyl(0.155, 0.155, 0.055, 12, px, py * cs, py * sn + 0.06, lean, 0, 0);
        steel.cyl(0.045, 0.045, 0.10, 8, px, py * cs, py * sn + 0.01, lean, 0, 0);
      }
      steel.cyl(0.09, 0.09, 0.30, 10, 0, h * 0.55 * cs, h * 0.55 * sn - 0.14, lean + 1.57, 0, 0);
      var m = Tn(bx, self._ground(bx, bz), bz, 0, yaw, 0);
      var g;
      g = steel.build(); if (g) self._static('steel', g, m);
      g = rub.build(); if (g) self._static('plastic', g, m);
      self._collider(bx, self._ground(bx, bz), bz, [0.25, 0.95, 0.8], yaw, 'metal');
      self._occupy(bx, bz, 1.2);
    })(this);

    // ---- timber packing crates in the corner --------------------------------
    (function (self) {
      // Stacked clear of the wall-side walkway the glazing gang needs, which
      // also stops them piling into the corner the camera stands in.
      var sites = [[wx + 4.1, sz - 1.7, 0.12], [wx + 5.6, sz - 3.4, -0.28],
                   [wx + 4.4, sz - 5.6, 0.44]];
      for (var s = 0; s < sites.length; s++) {
        var cx = sites[s][0], cz = sites[s][1], yaw = sites[s][2];
        if (!self._onPlate(cx, cz, 0.5)) continue;
        var wood = new PB();
        var w = 1.75, h = 0.95, d = 0.72;
        var y = self._ground(cx, cz);
        // a crate is a frame with boarding, not a box
        for (var e = 0; e < 4; e++) {
          wood.bar((e % 2 ? 1 : -1) * w * 0.5, 0.02, (e < 2 ? -1 : 1) * d * 0.5,
            (e % 2 ? 1 : -1) * w * 0.5, h, (e < 2 ? -1 : 1) * d * 0.5, 0.075);
        }
        for (var q = 0; q < 4; q++) {
          wood.box(w + 0.02, 0.020, 0.19, 0, 0.14 + q * 0.24, -d * 0.5, 0, 0, 0, 0.004);
          wood.box(w + 0.02, 0.020, 0.19, 0, 0.14 + q * 0.24, d * 0.5, 0, 0, 0, 0.004);
        }
        wood.box(w, 0.030, d, 0, h, 0, 0, 0, 0, 0.006);
        wood.box(0.14, 0.90, 0.020, -w * 0.34, h * 0.5, -d * 0.5 - 0.012, 0, 0, 0.42, 0.004);
        var g = wood.build();
        if (g) self._static('wood', g, Tn(cx, y, cz, 0, yaw, 0));
        self._collider(cx, y, cz, [w * 0.5, h * 0.5, d * 0.5], yaw, 'wood');
        self._occupy(cx, cz, 1.2);
      }
    })(this);

    // ---- cones lining the run, on the wall side only ------------------------
    for (i = 0; i < 6; i++) {
      var cz2 = 4.0 + i * 2.9;
      this._drop(this.B.cone, wx + 1.25 + R.range(-0.2, 0.2), cz2 + R.range(-0.4, 0.4), {
        r: 0.32, yaw: R.range(0, M.TAU), tilt: 0.05, h: 0.55
      });
    }

    // ---- spare mullions in the unglazed bays --------------------------------
    this._leanBundle(this.B.tube, wx + 0.7, -1.4, -Math.PI * 0.5, 9, 2.40, 0.17, 0.10);
    this._leanBundle(this.B.tube, wx + 0.7, 1.2, -Math.PI * 0.5 + 0.2, 6, 2.40, 0.20, 0.09);

    // ---- the base of the run ------------------------------------------------
    // What actually accumulates along the foot of a curtain wall being glazed:
    // packers and setting blocks, cut gasket, spent cartridges, dust swept out
    // of the transom channel, and the odd bucket.  It is low, it is continuous,
    // and it is what stops a 22 m run of mullion from meeting the slab on a
    // clean line - which is the single most artificial thing a facade can do.
    for (i = 0; i < 13; i++) {
      var bz2 = 3.6 + i * 1.32;
      var bx2 = wx + R.range(0.35, 1.15);
      var roll2 = R.next();
      if (roll2 < 0.34) {
        this._drop(this.B.timber, bx2, bz2, {
          r: 0.24, low: true, tilt: 0.12, scale: R.range(0.35, 0.65), h: 0.1,
          yaw: R.range(0, M.TAU)
        });
      } else if (roll2 < 0.52) {
        this._drop(this.B.block, bx2, bz2, { r: 0.18, low: true, tilt: 0.4,
          scale: R.range(0.4, 0.7), h: 0.12 });
      } else if (roll2 < 0.64) {
        this._drop(this.B.bucket, bx2, bz2, { r: 0.28, h: 0.3,
          color: normTint(R.bool() ? 0xd8d2c4 : 0x2f3134, 0.75, _col) });
      } else if (roll2 < 0.80) {
        this._litter(R.pick([CELL.card, CELL.paper, CELL.sack]), bx2, bz2,
          R.range(0.7, 1.15));
      }
      // and the sweepings, running along the wall rather than across it
      this._decal(CELL.drift, wx + R.range(0.25, 0.8), bz2 + R.range(-0.5, 0.5),
        R.range(1.6, 2.6), Math.PI * 0.5 + R.range(-0.25, 0.25), 0.55,
        R.range(0.45, 0.8));
    }
    // the mullion shadows fall across this corner all evening; give them
    // something with relief to fall on
    this._spoilHeap(wx + 1.35, 17.4, 0.85, 0.30);

    // ---- and a dust sheet over the last crate, flapping ---------------------
    if (this.mats.poly) {
      var dx = wx + 4.4, dz = sz - 5.6;
      var g2 = ribbonG(1.9, 1.15, 6, 4, 0.02, 0.02, 0.65, 0.55);
      this._flap(this.mats.poly, g2, Tn(dx, this._ground(dx, dz) + 1.02, dz, 0, 0.44, 0),
        { w: 1.9, h: 1.15, amp: 0.55 });
      var g3 = ribbonG(1.5, 0.95, 5, 4, 0.30, 0.10, 0.95, 0.70);
      this._flap(this.mats.poly, g3, Tn(dx + 0.1, this._ground(dx, dz) + 1.00, dz - 0.34,
        0, 0.44 + Math.PI, 0), { w: 1.5, h: 0.95, amp: 0.42 });
    }
  };

  // ==========================================================================
  // PASS 4 - THE LIFT LOBBY
  //
  // The `interior` framing is a 20 m concrete tube with a bright hole at the
  // end.  Everything here hugs the two walls and leaves 1.6 m of clear middle,
  // because the tube IS the shot: fill the centre and the composition dies.
  // Nothing in here is wind-driven - it is four walls and a soffit.
  // ==========================================================================
  PropsHighrise.prototype._dressLobby = function () {
    var R = this.rng, i;
    var L = this.lobby;
    var wW = (L.x0 === undefined ? 8.32 : L.x0);     // west wall face
    var wE = (L.x1 === undefined ? 13.0 : L.x1);     // lift-bank wall face
    var z0 = -9.6, z1 = 9.4;

    // ---- against the west wall ---------------------------------------------
    this._sheetStack(wW + 0.62, 1.2, -Math.PI * 0.5, 7, 0.17);
    this._gangBox(wW + 0.78, 1.9, -1.52);
    this._tub(wW + 0.55, -1.8, 0.4);
    this._drop(this.B.bucket, wW + 0.42, -2.5, { r: 0.26, h: 0.3, lane: false,
      color: normTint(0xd8d2c4, 0.7, _col) });
    this._drop(this.B.bucket, wW + 0.70, -2.75, { r: 0.26, h: 0.3, lane: false,
      color: normTint(0x2f3134, 0.85, _col) });

    // ---- against the lift-bank wall ----------------------------------------
    // This wall never sees the sky and never sees a festoon bulb straight on -
    // it is the darkest surface in the level.  The first pass put a galvanised
    // ladder, a cable drum and a steel job box along it and every one of them
    // disappeared.  What goes here has to be PALE in its own right: sheet
    // material and kraft paper, which are the two brightest things in the kit.
    this._sheetStack(wE - 0.68, 1.6, Math.PI * 0.5, 6, 0.16);
    this._bagStack(wE - 1.05, -1.4, 1.48, 4);
    this._cableDrum(wE - 0.78, -8.4, 1.35, 0.56, false);
    this._ladder(wE - 0.60, -7.2, Math.PI * 0.5, 0.14, 3.1);
    this._tool(wE - 0.45, 6.6, Math.PI * 0.5 + 0.2, 0.26, 'broom');
    this._tool(wE - 0.55, 7.1, Math.PI * 0.5 - 0.3, 0.30, 'shovel');
    this._barrow(wE - 1.15, 8.3, 2.75, false);
    this._tub(wE - 0.70, 4.2, 2.1);
    // three buckets nested, which is how they are actually stored
    for (i = 0; i < 3; i++) {
      this._drop(this.B.bucket, wE - 0.52 + R.range(-0.05, 0.05), 3.2 + R.range(-0.05, 0.05), {
        r: 0.05, occ: 0.05, h: 0.3, lane: false, lift: i * 0.075, tilt: 0.02,
        color: normTint(i === 1 ? 0xd06a20 : 0xd8d2c4, 0.7, _col)
      });
    }
    // plasterboard offcuts stood against the wall between the two stacks: the
    // small pale verticals that keep a 20 m run from having two events in it
    for (i = 0; i < 5; i++) {
      this._drop(this.B.timber, wE - 0.42 + R.range(-0.10, 0.10), -3.6 - i * 0.9, {
        r: 0.22, low: true, lane: false, yaw: Math.PI * 0.5 + R.gaussian(0, 0.18),
        roll: R.range(1.06, 1.30), lift: 0.44, tilt: 0.04, h: 0.2,
        scale: R.range(0.9, 1.25)
      });
    }

    // ---- the lead that lights the lobby, and the dust it lies in ------------
    this._leadRun([[wE - 0.4, 9.2], [wE - 0.5, 3.0], [wW + 0.5, -1.0],
                   [wW + 0.6, -8.8]], 0.015);
    for (i = 0; i < 12; i++) {
      var t = i / 11;
      var dz = M.lerp(z1, z0, t);
      // sweepings run along BOTH wall feet and the middle stays swept
      this._decal(CELL.drift, wW + R.range(0.10, 0.55), dz + R.range(-0.6, 0.6),
        R.range(1.4, 2.3), R.range(-0.4, 0.4) + Math.PI * 0.5, 0.55, R.range(0.5, 0.85));
      this._decal(CELL.drift, wE - R.range(0.10, 0.55), dz + R.range(-0.6, 0.6),
        R.range(1.3, 2.2), R.range(-0.4, 0.4) - Math.PI * 0.5, 0.55, R.range(0.5, 0.85));
    }
    // and the walking line down the middle
    for (i = 0; i < 6; i++) {
      this._decal(CELL.boots, (wW + wE) * 0.5 + R.range(-0.5, 0.5), 7.0 - i * 3.1,
        R.range(2.2, 3.0), R.range(-0.12, 0.12), 1.5, R.range(0.4, 0.65));
    }
    // debris in the two corners a broom never reaches
    for (i = 0; i < 16; i++) {
      var cx = R.bool() ? wW + R.range(0.12, 0.6) : wE - R.range(0.12, 0.6);
      var cz = R.bool(0.5) ? R.range(-9.4, -7.2) : R.range(7.4, 9.3);
      this._drop(this.B.rubble, cx, cz, { r: 0.14, low: true, lane: false,
        tilt: 0.4, scale: R.range(0.45, 0.9), h: 0.12 });
    }
    for (i = 0; i < 7; i++) {
      this._litter(R.pick([CELL.paper, CELL.sack, CELL.card]),
        (R.bool() ? wW + R.range(0.15, 0.65) : wE - R.range(0.15, 0.65)),
        R.range(z0, z1), R.range(0.8, 1.3));
    }

    // ---- the vest on the lift barrier --------------------------------------
    // A hi-vis hung on the shaft barrier is the level's one splash of pure
    // chroma in a 20 m grey tube, and it sits exactly where the interior
    // framing's eye lands.
    if (this.mats.hivis) {
      var g = ribbonG(0.44, 0.62, 4, 5, 0.05, 0.05, 0.95, 0.95);
      this._flap(this.mats.hivis, g, Tn(wE - 0.075, 1.14, -5.0, 0, -Math.PI * 0.5, 0),
        { w: 0.44, h: 0.62, amp: 0.10, cast: true });
    }
  };

  // ==========================================================================
  // PASS 5 - THE SLAB VOID
  //
  // A double-height hole in the floor with a temporary stair in it.  Real sites
  // ring these with whatever is to hand: cones, a tube barrier, tape, and the
  // spoil that is being shovelled down them.
  // ==========================================================================
  PropsHighrise.prototype._dressVoid = function () {
    var R = this.rng, i;
    var V = this.voidRect;
    var cx = (V.x0 + V.x1) * 0.5, cz = (V.z0 + V.z1) * 0.5;

    // cones along the two approach sides, in a real line with real gaps
    var line = [];
    for (i = 0; i < 6; i++) line.push([V.x0 - 0.75, V.z0 - 0.6 + i * 1.7]);
    for (i = 0; i < 5; i++) line.push([V.x0 - 0.2 + i * 1.6, V.z0 - 0.85]);
    for (i = 0; i < line.length; i++) {
      if (R.bool(0.18)) continue;                    // the gap somebody moved
      this._drop(this.B.cone, line[i][0] + R.range(-0.18, 0.18),
        line[i][1] + R.range(-0.18, 0.18),
        { r: 0.34, yaw: R.range(0, M.TAU), tilt: 0.06, h: 0.55 });
    }
    // one cone knocked over, because one always is
    this._drop(this.B.cone, V.x0 - 1.55, V.z0 + 2.6, {
      r: 0.34, yaw: 1.1, pitch: 1.42, lift: 0.13, tilt: 0.05, h: 0.3
    });

    // tape strung across the corner, sagging and vibrating
    if (this.mats.litter && this._atlasOk) {
      var uv = atlasUV(CELL.tape);
      var g = ribbonG(3.4, 0.12, 16, 1, uv[0], uv[1], uv[2], uv[3], 0.085);
      this._flap(this.mats.litter, g,
        Tn(V.x0 - 0.75, this._ground(V.x0 - 0.75, V.z0 + 1.4) + 1.02, V.z0 + 1.4, 0, 0, 0),
        { w: 3.4, h: 0.12, amp: 0.5, both: true });
      var g2 = ribbonG(2.9, 0.12, 14, 1, uv[0], uv[1], uv[2], uv[3], 0.072);
      this._flap(this.mats.litter, g2,
        Tn(V.x0 + 1.3, this._ground(V.x0 + 1.3, V.z0 - 0.85) + 0.98, V.z0 - 0.85,
          0, Math.PI * 0.5, 0),
        { w: 2.9, h: 0.12, amp: 0.5, both: true });
    }

    // the spoil being fed into it, and the tools doing the feeding
    this._spoilHeap(V.x0 - 2.3, cz + 1.4, 1.25, 0.48);
    this._drop(this.B.bulkBag, V.x1 + 1.5, V.z1 + 0.9, {
      r: 0.75, h: 1.0, yaw: -0.5, collider: [0.48, 0.5, 0.48], material: 'fabric'
    });
    this._tool(V.x0 - 1.35, cz + 2.6, 0.9, 0.42, 'shovel');
    this._barrow(V.x1 + 2.3, V.z0 - 1.2, 0.6, true);

    // rubble on the lip: what has been swept toward the hole and not yet gone in
    for (i = 0; i < 26; i++) {
      var side = R.int(0, 1);
      var px = side ? R.range(V.x0 - 0.4, V.x1 + 0.4) : V.x0 - R.range(0.3, 2.0);
      var pz = side ? V.z0 - R.range(0.3, 1.8) : R.range(V.z0 - 0.4, V.z1 + 0.4);
      this._drop(R.bool(0.6) ? this.B.rubble : this.B.block, px, pz, {
        r: 0.16, low: true, tilt: 0.45, scale: R.range(0.45, 1.0), h: 0.15
      });
    }
    for (i = 0; i < 6; i++) {
      this._decal(CELL.drift, V.x0 - R.range(0.4, 2.4), R.range(V.z0 - 1.5, V.z1 + 1.0),
        R.range(1.8, 3.0), R.range(0, M.TAU), 0.7, R.range(0.6, 0.95));
    }
    this._decal(CELL.sweep, V.x0 - 2.0, V.z0 - 1.0, 3.4, 0.8, 1, 0.85);
    this._decal(CELL.boots, cx - 4.0, cz - 3.0, 3.0, 0.7, 1.5, 0.6);
  };

  // ==========================================================================
  // PASS 6 - THE OPEN EDGES
  //
  // 176 m of air starts here.  The dressing is what people leave at an edge
  // they are frightened of and keep looking over anyway: spare edge-protection
  // components, a rope coil, dropped tools, cones and tape across the missing
  // bay, and the butts of everyone who has stood there.
  // ==========================================================================
  PropsHighrise.prototype._dressOpenEdge = function () {
    var R = this.rng, i;
    var p = this.plate;
    var oe = this.openEdge;
    var nz = (oe && oe.north) ? oe.north.z : p.z0;     // the north edge line
    var gap = (oe && oe.gap) ? oe.gap : { x0: -12.5, x1: -3.5 };
    var inb = 0.85;                                   // how far inboard of it

    // ---- spare edge-protection components, stacked along the edge -----------
    var stacks = [[-20.5, nz + inb + 0.25], [-2.0, nz + inb + 0.15], [12.5, nz + inb + 0.3]];
    for (i = 0; i < stacks.length; i++) {
      var sx = stacks[i][0], sz = stacks[i][1];
      if (!this._onPlate(sx, sz, 0.4)) continue;
      var wood = new PB(), galv = new PB();
      var y = this._ground(sx, sz);
      // kickboards, lying flat and stacked
      var nBoards = R.int(3, 6);
      for (var k = 0; k < nBoards; k++) {
        wood.box(2.35, 0.030, 0.155, R.gaussian(0, 0.05), 0.016 + k * 0.032, R.gaussian(0, 0.04),
          0, R.gaussian(0, 0.035), 0, 0.005);
      }
      // and a few spare posts beside them
      var nPosts = R.int(2, 4);
      for (k = 0; k < nPosts; k++) {
        galv.box(0.055, 1.15, 0.055, R.range(-0.9, 0.9), 0.030 + k * 0.058, 0.42 + R.range(-0.1, 0.1),
          Math.PI * 0.5, R.gaussian(0, 0.10), 0, 0.006);
      }
      var g;
      g = wood.build(); if (g) this._static('wood', g, Tn(sx, y, sz, 0, R.gaussian(0, 0.12), 0));
      g = galv.build(); if (g) this._static('galv', g, Tn(sx, y, sz, 0, R.gaussian(0, 0.12), 0));
      this._occupy(sx, sz, 1.5);
      this._decal(CELL.drift, sx + this.wind.x * 1.6, sz + this.wind.y * 1.6,
        R.range(2.2, 3.2), Math.atan2(this.wind.x, this.wind.y), 0.8, 0.8);
    }

    // ---- the missing guard-rail bay: coned and taped ------------------------
    var gx0 = gap.x0, gx1 = gap.x1;
    this._drop(this.B.cone, gx0 - 0.4, nz + 0.95, { r: 0.34, yaw: 0.6, h: 0.55, lane: false });
    this._drop(this.B.cone, gx1 + 0.4, nz + 0.95, { r: 0.34, yaw: 2.2, h: 0.55, lane: false });
    this._drop(this.B.cone, (gx0 + gx1) * 0.5, nz + 1.05, { r: 0.34, yaw: 4.0, h: 0.55, lane: false });
    if (this.mats.litter && this._atlasOk) {
      var uv = atlasUV(CELL.tape);
      var span = (gx1 - gx0) * 0.5 + 0.8;
      var g2 = ribbonG(span, 0.12, 18, 1, uv[0], uv[1], uv[2], uv[3], 0.105);
      var mx = (gx0 + (gx0 + gx1) * 0.5) * 0.5;
      this._flap(this.mats.litter, g2,
        Tn(mx, this._ground(mx, nz + 0.98) + 0.62, nz + 0.98, 0, 0, 0),
        { w: span, h: 0.12, amp: 0.9, both: true });
      var mx2 = ((gx0 + gx1) * 0.5 + gx1) * 0.5;
      var g3 = ribbonG(span, 0.12, 18, 1, uv[0], uv[1], uv[2], uv[3], 0.092);
      this._flap(this.mats.litter, g3,
        Tn(mx2, this._ground(mx2, nz + 0.98) + 0.60, nz + 0.98, 0, 0.04, 0),
        { w: span, h: 0.12, amp: 0.9, both: true });
    }

    // ---- what is dropped at an edge ----------------------------------------
    this._tool(gx1 + 1.35, nz + 0.9, 2.4, 0.0, 'shovel');
    // a coil of lead, dumped rather than wound
    (function (self) {
      var lx = gx0 - 1.9, lz = nz + 1.25;
      if (!self._onPlate(lx, lz, 0.3)) return;
      var pb = new PB();
      for (var q = 0; q < 4; q++) {
        pb.tor(0.30 - q * 0.045, 0.016, 14, 4, R.gaussian(0, 0.03), 0.018 + q * 0.030,
          R.gaussian(0, 0.03), Math.PI * 0.5 + R.gaussian(0, 0.05), 0, R.gaussian(0, 0.05));
      }
      var g = pb.build();
      if (g) self._static('plastic', g, Tn(lx, self._ground(lx, lz), lz, 0, R.range(0, M.TAU), 0));
      self._occupy(lx, lz, 0.45);
    })(this);
    for (i = 0; i < 5; i++) {
      var bx = M.lerp(gx0, gx1, R.next());
      this._decal(CELL.crumbs, bx, nz + R.range(0.55, 1.35), R.range(0.8, 1.3),
        R.range(0, M.TAU), 1, 0.9);
    }
    this._decal(CELL.boots, (gx0 + gx1) * 0.5 + 1.0, nz + 2.4, 3.0, 0.25, 1.5, 0.62);
    this._decal(CELL.boots, gx0 - 0.5, nz + 3.2, 2.6, -0.4, 1.5, 0.5);

    // ---- litter caught downwind ---------------------------------------------
    // The east scaffold is the level's downwind boundary: everything the wind
    // picks up off 2200 m2 of floor ends up pressed against it.  A handful more
    // is caught in the eddy at the north edge netting, which is where it
    // actually happens on a real frame.
    var scafX = this.scaffold ? this.scaffold.x : p.x1;
    for (i = 0; i < 9; i++) {
      var cz2 = R.range(-5.0, 11.0);
      this._catch(scafX - 0.30, R.range(0.35, 1.55), cz2, -Math.PI * 0.5, R.range(0.8, 1.4));
    }
    for (i = 0; i < 6; i++) {
      var cx2 = R.range(p.x0 + 3, p.x1 - 8);
      if (cx2 > gx0 - 1 && cx2 < gx1 + 1) cx2 += 11;
      this._catch(cx2, R.range(0.28, 0.95), nz + 0.28, 0, R.range(0.7, 1.2));
    }
    for (i = 0; i < 4; i++) {
      this._catch(p.x0 + 0.30, R.range(0.28, 0.95), R.range(-16, 1.5), Math.PI * 0.5,
        R.range(0.7, 1.1));
    }
  };

  // Register a scrap of litter pinned to a vertical face.  Stored, not placed:
  // update() writes its matrix every frame so it flutters against the netting.
  PropsHighrise.prototype._catch = function (x, y, z, yaw, scale) {
    if (!this.B.caught || this.B.caught.n >= this.B.caught.max) return false;
    var e = {
      x: x, y: y, z: z, yaw: yaw, scale: scale || 1,
      phase: this.rng.range(0, M.TAU),
      rate: this.rng.range(0.8, 1.5),
      idx: this.B.caught.n
    };
    this.caught.push(e);
    this.B.caught.add(T(x, y, z, 0, yaw, 0, e.scale, e.scale, e.scale), WHITE);
    return true;
  };

  // ==========================================================================
  // PASS 7 - THE COLUMNS
  //
  // Twenty-odd 860 mm columns, each throwing a 23 m shadow, and each one an
  // obstruction the wind has to go round.  Debris tails DOWNWIND of every one -
  // which is also, at this hour, the shaded side, so the tail lands in the
  // column's own shadow and reads as depth rather than as scatter.
  // ==========================================================================
  PropsHighrise.prototype._dressColumns = function () {
    var R = this.rng, i, k;
    var wx = this.wind.x, wz = this.wind.y;
    var wa = Math.atan2(wx, wz);
    var cols = this.columns;
    if (!cols || !cols.length) return;

    for (i = 0; i < cols.length; i++) {
      var c = cols[i];
      var x = c.x, z = c.z, hw = (c.w || 0.86) * 0.5;
      if (!this._onPlate(x, z, 1.0)) continue;
      var sun = this._sunlit(x, z);

      // the drift tail, starting at the downwind face
      this._decal(CELL.drift, x + wx * (hw + 1.05), z + wz * (hw + 1.05),
        R.range(2.4, 3.4), wa, 0.62, R.range(0.65, 0.95));
      if (R.bool(0.5)) {
        this._decal(CELL.drift, x + wx * (hw + 2.6) + R.gaussian(0, 0.4),
          z + wz * (hw + 2.6) + R.gaussian(0, 0.4), R.range(1.8, 2.6), wa, 0.6, 0.5);
      }
      // and the smaller bank on the windward face, where it piles up against it
      this._decal(CELL.drift, x - wx * (hw + 0.55), z - wz * (hw + 0.55),
        R.range(1.2, 1.8), wa + Math.PI, 0.7, 0.55);

      // rubble and offcuts, biased hard into the lee
      var n = R.int(2, 6);
      for (k = 0; k < n; k++) {
        var a = wa + R.gaussian(0, 0.85);
        var rr = hw + R.range(0.25, 1.9);
        this._drop(R.bool(0.62) ? this.B.rubble : this.B.block,
          x + Math.sin(a) * rr, z + Math.cos(a) * rr, {
            r: 0.17, low: true, tilt: 0.42, scale: R.range(0.45, 1.05), h: 0.15
          });
      }
      // a timber offcut or two propped against the column
      if (R.bool(0.42)) {
        var ta = R.range(0, M.TAU);
        this._drop(this.B.timber, x + Math.sin(ta) * (hw + 0.30), z + Math.cos(ta) * (hw + 0.30), {
          r: 0.30, low: true, yaw: ta + Math.PI * 0.5, pitch: 0, roll: R.range(0.9, 1.25),
          lift: 0.42, tilt: 0.05, h: 0.2
        });
      }
      // and something a person put down and did not pick up
      if (R.bool(0.28)) {
        var ba = R.range(0, M.TAU);
        this._drop(this.B.bucket, x + Math.sin(ba) * (hw + 0.42), z + Math.cos(ba) * (hw + 0.42), {
          r: 0.28, h: 0.3, color: normTint(R.bool() ? 0x2f3134 : 0xd8d2c4, 0.75, _col)
        });
      }
      // litter blown against the base, on the windward side where it lodges
      if (R.bool(0.45)) {
        this._litter(R.pick([CELL.bag, CELL.sack, CELL.card, CELL.paper]),
          x - wx * (hw + R.range(0.15, 0.5)), z - wz * (hw + R.range(0.15, 0.5)),
          R.range(0.8, 1.35));
      }
      // in the sun the dust bleaches out; in the shade it is a dark rim
      if (sun < 0.35 && R.bool(0.5)) {
        this._decal(CELL.crumbs, x + R.gaussian(0, 0.7), z + R.gaussian(0, 0.7),
          R.range(0.9, 1.5), R.range(0, M.TAU), 1, 0.7);
      }
    }
  };

  // ==========================================================================
  // PASS 8 - THE DRIFT
  //
  // The wind field, made visible.  Three mechanisms, in order of how much they
  // carry the frame:
  //   1. banks against every WINDWARD wall face - the core's west and north
  //      walls and the south glazing, which are the three surfaces the wind
  //      actually stops against
  //   2. traps in the corners it cannot leave
  //   3. tails downwind of the level's own laydown stacks
  // Plus a thin general scatter weighted by the slab's own hollows, so the low
  // spots collect and the crowns stay swept.
  // ==========================================================================
  PropsHighrise.prototype._dressDrift = function () {
    var R = this.rng, i, k;
    var wx = this.wind.x, wz = this.wind.y;
    var wa = Math.atan2(wx, wz);
    var self = this;

    // ---- windward wall faces ------------------------------------------------
    // {x0,z0,x1,z1, nx,nz} where (nx,nz) is the OUTWARD normal of the face.
    var runs = [
      { x0: 8.0, z0: -9.9, x1: 8.0, z1: 9.9, nx: -1, nz: 0 },        // core, west face
      { x0: 13.1, z0: -10.0, x1: 21.9, z1: -10.0, nx: 0, nz: -1 },   // core, north face
      { x0: -26.6, z0: 20.7, x1: -6.4, z1: 20.7, nx: 0, nz: -1 },    // south glazing
      { x0: -26.7, z0: 3.4, x1: -26.7, z1: 20.4, nx: 1, nz: 0 }      // west glazing (lee)
    ];
    for (i = 0; i < runs.length; i++) {
      var rn = runs[i];
      // how hard the wind drives into this face: 1 head-on, 0 edge-on or lee
      var facing = M.saturate(-(rn.nx * wx + rn.nz * wz));
      var len = Math.hypot(rn.x1 - rn.x0, rn.z1 - rn.z0);
      var steps = Math.max(3, Math.round(len / 2.1));
      for (k = 0; k <= steps; k++) {
        var t = k / steps;
        var px = M.lerp(rn.x0, rn.x1, t) + rn.nx * R.range(0.25, 0.85);
        var pz = M.lerp(rn.z0, rn.z1, t) + rn.nz * R.range(0.25, 0.85);
        if (!this._onPlate(px, pz, 0.2)) continue;
        var strength = 0.28 + facing * 0.66;
        this._decal(CELL.drift, px, pz, R.range(1.8, 3.0) * (0.7 + facing * 0.6),
          Math.atan2(rn.nx, rn.nz) + Math.PI, 0.6, strength);
        if (R.bool(0.22 + facing * 0.45)) {
          this._litter(R.pick([CELL.bag, CELL.paper, CELL.sack, CELL.card]),
            px + rn.nx * R.range(-0.15, 0.2), pz + rn.nz * R.range(-0.15, 0.2),
            R.range(0.85, 1.4));
        }
        if (R.bool(0.20 + facing * 0.30)) {
          this._drop(this.B.rubble, px + R.gaussian(0, 0.3), pz + R.gaussian(0, 0.3), {
            r: 0.15, low: true, tilt: 0.4, scale: R.range(0.45, 0.9), h: 0.12
          });
        }
      }
    }

    // ---- corner traps -------------------------------------------------------
    // A corner the wind cannot get out of fills up.  Four of them, and the SW
    // one is hero2's foreground, so it is the deepest.
    var traps = [
      { x: -25.3, z: 19.1, r: 2.6, n: 16 },     // west glazing meets south glazing
      { x: -7.2, z: 19.6, r: 2.0, n: 9 },       // where the south glazing stops
      { x: 8.9, z: -9.3, r: 1.8, n: 8 },        // core, north-west internal corner
      { x: 8.9, z: 9.3, r: 1.6, n: 7 }          // core, south-west internal corner
    ];
    for (i = 0; i < traps.length; i++) {
      var tp = traps[i];
      this._decal(CELL.drift, tp.x, tp.z, tp.r * 2.4, R.range(0, M.TAU), 0.85, 0.95);
      this._decal(CELL.drift, tp.x + R.gaussian(0, 0.7), tp.z + R.gaussian(0, 0.7),
        tp.r * 1.6, R.range(0, M.TAU), 0.8, 0.75);
      for (k = 0; k < tp.n; k++) {
        var a = R.range(0, M.TAU), rr = tp.r * Math.sqrt(R.next());
        var qx = tp.x + Math.sin(a) * rr, qz = tp.z + Math.cos(a) * rr;
        if (R.bool(0.45)) {
          this._litter(R.pick([CELL.bag, CELL.paper, CELL.sack, CELL.card]), qx, qz,
            R.range(0.8, 1.5));
        } else {
          this._drop(R.bool(0.6) ? this.B.rubble : this.B.block, qx, qz, {
            r: 0.15, low: true, tilt: 0.5, scale: R.range(0.4, 1.0), h: 0.12
          });
        }
      }
      // one crumpled empty bag per trap: the biggest single scrap, and the one
      // that reads at 20 m
      this._drop(this.B.bagEmpty, tp.x + R.gaussian(0, 0.8), tp.z + R.gaussian(0, 0.8), {
        r: 0.30, low: true, tilt: 0.28, scale: R.range(0.9, 1.2), h: 0.1
      });
    }

    // ---- tails behind the level's own laydown -------------------------------
    for (i = 0; i < this.stacks.length; i++) {
      var s = this.stacks[i];
      if (!s || !s.centre) continue;
      var off = Math.max(s.w || 1, s.d || 1) * 0.5 + 1.0;
      this._decal(CELL.drift, s.centre.x + wx * off, s.centre.z + wz * off,
        R.range(2.6, 3.8), wa, 0.65, 0.8);
      for (k = 0; k < 3; k++) {
        this._drop(this.B.rubble, s.centre.x + wx * off + R.gaussian(0, 0.8),
          s.centre.z + wz * off + R.gaussian(0, 0.8), {
            r: 0.15, low: true, tilt: 0.45, scale: R.range(0.4, 0.9), h: 0.12
          });
      }
      if (R.bool(0.6)) {
        this._litter(R.pick([CELL.paper, CELL.bag, CELL.card]),
          s.centre.x - wx * (off - 0.4), s.centre.z - wz * (off - 0.4), R.range(0.8, 1.3));
      }
    }

    // ---- general scatter, weighted by the slab's own hollows ----------------
    // Rejection-sampled: a point in a hollow, off the lanes and away from the
    // sunlit crowns is far more likely to keep its debris than a swept high
    // spot, which is what stops this being a uniform sprinkle.
    var placed = 0, guard = 0;
    var p = this.plate;
    while (placed < 90 && guard++ < 900) {
      var gx = R.range(p.x0 + 1.5, p.x1 - 1.5);
      var gz = R.range(p.z0 + 1.5, p.z1 - 1.5);
      if (!this._onPlate(gx, gz, 1.0)) continue;
      var dip = M.saturate(this._dip(gx, gz) / 0.030);
      var keep = 0.12 + dip * 0.72;
      if (!this._laneClear(gx, gz, 0.2, true)) keep *= 0.25;
      if (!R.bool(keep)) continue;
      var roll = R.next();
      if (roll < 0.52) {
        if (this._drop(this.B.rubble, gx, gz, { r: 0.14, low: true, tilt: 0.5,
          scale: R.range(0.35, 0.85), h: 0.10 })) placed++;
      } else if (roll < 0.72) {
        if (this._drop(this.B.block, gx, gz, { r: 0.16, low: true, tilt: 0.45,
          scale: R.range(0.4, 0.9), h: 0.12 })) placed++;
      } else if (roll < 0.86) {
        if (this._drop(this.B.timber, gx, gz, { r: 0.28, low: true, tilt: 0.10,
          scale: R.range(0.5, 1.0), h: 0.08 })) placed++;
      } else {
        if (this._litter(R.pick([CELL.paper, CELL.card, CELL.sack]), gx, gz,
          R.range(0.7, 1.2))) placed++;
      }
    }
  };

  // ==========================================================================
  // PASS 9 - THE FLOOR ITSELF
  //
  // Setting-out marks, spillage and the stains under the plant.  A slab is a
  // record of what has been done on it, and at nine degrees of incidence every
  // one of these reads.
  // ==========================================================================
  PropsHighrise.prototype._dressFloorMarks = function () {
    var R = this.rng, i;
    var p = this.plate;

    // ---- setting-out: chalk lines on the bay grid ---------------------------
    var gx = p.colGridX || [-22.5, -13.5, -4.5, 4.5, 13.5, 22.5];
    var gz = p.colGridZ || [-16, -8, 0, 8, 16];
    for (i = 0; i < gx.length; i++) {
      for (var k = 0; k < 3; k++) {
        var cz = R.range(p.z0 + 3, p.z1 - 3);
        this._decal(CELL.chalk, gx[i] + R.range(-0.6, 0.6), cz, R.range(2.6, 4.2),
          R.range(-0.06, 0.06), 1.0, R.range(0.45, 0.8));
      }
    }
    for (i = 0; i < gz.length; i++) {
      for (var k2 = 0; k2 < 2; k2++) {
        var cx = R.range(p.x0 + 4, 6.0);
        this._decal(CELL.chalk, cx, gz[i] + R.range(-0.6, 0.6), R.range(2.6, 4.2),
          Math.PI * 0.5 + R.range(-0.06, 0.06), 1.0, R.range(0.45, 0.8));
      }
    }

    // ---- spillage: where concrete was placed and where it was mixed ---------
    var spills = [[3.2, -14.5, 3.2], [4.6, -12.0, 2.2], [1.4, -16.4, 2.0],
                  [-6.9, -13.6, 1.8], [9.2, -6.8, 1.6], [-19.0, 9.4, 2.0],
                  [-16.2, 12.6, 1.6]];
    for (i = 0; i < spills.length; i++) {
      this._decal(CELL.slurry, spills[i][0] + R.gaussian(0, 0.5),
        spills[i][1] + R.gaussian(0, 0.5), spills[i][2] * R.range(0.8, 1.25),
        R.range(0, M.TAU), R.range(0.75, 1.2), R.range(0.6, 0.9));
    }
    for (i = 0; i < 8; i++) {
      this._decal(CELL.spatter, R.range(-8, 8), R.range(-18, -10), R.range(1.2, 2.4),
        R.range(0, M.TAU), 1, R.range(0.35, 0.7));
    }

    // ---- diesel and hydraulic drips, only under things that leak ------------
    var leaks = [[-16.6, -12.2], [3.2, -14.5], [25.0, -13.4], [21.4, -12.0]];
    for (i = 0; i < leaks.length; i++) {
      this._decal(CELL.oil, leaks[i][0] + R.gaussian(0, 0.4), leaks[i][1] + R.gaussian(0, 0.4),
        R.range(0.9, 1.8), R.range(0, M.TAU), 1, R.range(0.5, 0.85));
    }

    // ---- the walking lines --------------------------------------------------
    // Boot prints down the two swept lanes, thinning as they leave them.  This
    // is the cheapest possible statement that people work here.
    for (i = 0; i < this.lanes.length; i++) {
      var L = this.lanes[i];
      var len = Math.hypot(L.x1 - L.x0, L.z1 - L.z0);
      var n = Math.round(len / 4.2);
      var ang = Math.atan2(L.x1 - L.x0, L.z1 - L.z0);
      for (var q = 0; q < n; q++) {
        var t = (q + 0.5) / n;
        var bx = M.lerp(L.x0, L.x1, t) + R.gaussian(0, 0.5);
        var bz = M.lerp(L.z0, L.z1, t) + R.gaussian(0, 0.5);
        this._decal(CELL.boots, bx, bz, R.range(2.4, 3.4), ang + R.gaussian(0, 0.12),
          1.5, R.range(0.35, 0.65));
      }
    }
    // and the branch line off the lane into the core, which is where everybody
    // actually walks
    for (i = 0; i < 5; i++) {
      this._decal(CELL.boots, M.lerp(6.0, 9.6, i / 4) + R.gaussian(0, 0.4),
        M.lerp(-11.5, -6.0, i / 4) + R.gaussian(0, 0.4), R.range(2.2, 3.0),
        0.62 + R.gaussian(0, 0.12), 1.5, R.range(0.35, 0.6));
    }
  };

  // ==========================================================================
  // COMMIT
  // ==========================================================================
  function vertCount(g) {
    return g.index ? g.index.count : g.attributes.position.count;
  }

  var STATIC_MAT = {
    concrete: 'concrete', block: 'block', steel: 'steel', galv: 'galv',
    rust: 'rust', paint: 'paint', wood: 'wood', ply: 'ply',
    fabric: 'weave', plastic: 'plastic', paper: 'paper', hivis: 'hivis'
  };
  var STATIC_UV = {
    concrete: 1.1, block: 1.6, steel: 1.7, galv: 1.9, rust: 2.1, paint: 1.5,
    wood: 1.5, ply: 0.85, fabric: 1.0, plastic: 2.1, paper: 1.2, hivis: 2.2
  };
  // Which buckets take the library's WEAR mask, and which take a plain albedo
  // multiplier.  Writing one into the other is silent and catastrophic - a
  // multiplier landing in a wear mask reads as heavy grime everywhere.
  var STATIC_MUL = { plastic: 1, paper: 1, hivis: 1, fabric: 1 };

  PropsHighrise.prototype._commit = function () {
    var key, i;

    // ---- floor decals -------------------------------------------------------
    if (this.decalParts && this.decalParts.length && this.mats.decal) {
      var alphas = [];
      for (i = 0; i < this.decalParts.length; i++) {
        alphas.push(this.decalParts[i].alpha === undefined ? 1 : this.decalParts[i].alpha,
          vertCount(this.decalParts[i].geometry));
      }
      var dg = mergeParts(this.decalParts);
      if (dg) {
        Geo.copyUV1(dg);
        // Per-card alpha, carried in a four-component colour attribute.
        // three.js turns on vertexAlphas when itemSize is 4, which is the only
        // way to vary opacity across a merged batch without a shader.
        var cnt = dg.attributes.position.count;
        var col = new Float32Array(cnt * 4);
        var vi = 0, N = this.noise;
        for (i = 0; i < alphas.length; i += 2) {
          var a = alphas[i], n = alphas[i + 1];
          for (var v = 0; v < n && vi < cnt; v++, vi++) {
            var px = dg.attributes.position.getX(vi), pz = dg.attributes.position.getZ(vi);
            // a slow value wander so no two marks are the same grey
            var tone = 1 + N.fbm2(px * 0.22, pz * 0.22, 2) * 0.16;
            col[vi * 4] = tone; col[vi * 4 + 1] = tone * 0.995; col[vi * 4 + 2] = tone * 0.985;
            col[vi * 4 + 3] = a;
          }
        }
        for (; vi < cnt; vi++) {
          col[vi * 4] = 1; col[vi * 4 + 1] = 1; col[vi * 4 + 2] = 1; col[vi * 4 + 3] = 1;
        }
        dg.setAttribute('color', new THREE.BufferAttribute(col, 4));
        this.mats.decal.vertexColors = true;
        this.mats.decal.needsUpdate = true;
        var dm = new THREE.Mesh(dg, this.mats.decal);
        dm.name = 'hr_decals';
        dm.castShadow = false;
        dm.receiveShadow = true;
        dm.renderOrder = 2;
        dm.matrixAutoUpdate = false;
        this.root.add(dm);
      }
      disposeParts(this.decalParts);
    }

    // ---- ground litter ------------------------------------------------------
    if (this.litterParts && this.litterParts.length && this.mats.litter) {
      var lg = mergeParts(this.litterParts);
      if (lg) {
        Geo.copyUV1(lg);
        var lm = new THREE.Mesh(lg, this.mats.litter);
        lm.name = 'hr_litter';
        lm.castShadow = true;
        lm.receiveShadow = true;
        lm.matrixAutoUpdate = false;
        this.root.add(lm);
      }
      disposeParts(this.litterParts);
    }

    // ---- static merges ------------------------------------------------------
    for (key in this.S) {
      var parts = this.S[key];
      if (!parts || !parts.length) continue;
      var geo = mergeParts(parts);
      disposeParts(parts);
      if (!geo) continue;
      try { Geo.worldUV(geo, STATIC_UV[key] || 1.4); } catch (e) { /* keep builder uv */ }
      Geo.copyUV1(geo);
      if (STATIC_MUL[key]) {
        paintMul(geo, { noise: this.noise, amount: 0.24, hiY: 1.4 });
      } else {
        paintWear(geo, { noise: this.noise, dust: 0.38, grime: 0.26, edge: 0.28, hiY: 1.8 });
      }
      try { geo.computeBoundingSphere(); } catch (e2) { /* ignore */ }
      var mat = this.mats[STATIC_MAT[key]] || this.mats.steel;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'hr_static_' + key;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
    }

    // ---- instanced batches --------------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      var b = this.B[key];
      if (!b) continue;
      if (b.full) this.stats.full.push(key + ':' + b.max);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'hr_' + key)) this.stats.instances += b.n;
      else delete this.B[key];
    }
    this._caughtBatch = this.B.caught || null;

    // ---- book-keeping -------------------------------------------------------
    var draws = 0, tris = 0;
    this.root.traverse(function (o) {
      if (!o.isMesh) return;
      draws++;
      var g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      var n = g.index ? g.index.count : g.attributes.position.count;
      tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
    });
    this.stats.drawCalls = draws;
    this.stats.tris = Math.round(tris);
    this.stats.colliders = this.colliders.length;
    this.stats.skipped = this._skipped;
    GAME.__hrProps = this.stats;
  };

  // ==========================================================================
  // PER FRAME
  //
  // Six ribbons of about sixty vertices and up to twenty instance matrices.
  // The roster pins this level "clear, WINDY" and the level's own polythene is
  // already moving; a prop set that stands dead still beside it is worse than
  // one that never moved at all.
  // ==========================================================================
  PropsHighrise.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    this.time += dt;
    var t = this.time;

    // The level's own gale unless weather.js is publishing one.
    var wind = this.windSpeed;
    try {
      if (ctx && ctx.weather && isFinite(ctx.weather.windSpeed) && ctx.weather.windSpeed > 0) {
        wind = ctx.weather.windSpeed;
      }
    } catch (e) { /* the level's own wind is fine */ }
    // A slow travelling gust envelope, so the whole floor does not breathe in
    // unison - the single clearest tell of procedural cloth.
    var gust = 0.55 + 0.45 * Math.sin(t * 0.43) * Math.sin(t * 0.19 + 1.1);
    var amp = M.clamp(wind / 11, 0.35, 2.0) * (0.5 + gust * 0.8);

    var i, k;
    for (i = 0; i < this.flaps.length; i++) {
      var f = this.flaps[i];
      if (!f.geo || !f.geo.attributes || !f.geo.attributes.position) continue;
      var p = f.geo.attributes.position;
      var arr = p.array, base = f.base;
      var n = p.count, ph = f.phase;
      var a = amp * f.amp;
      for (k = 0; k < n; k++) {
        var bx = base[k * 3], by = base[k * 3 + 1], bz = base[k * 3 + 2];
        var u = bx / Math.max(0.2, f.w) + 0.5;
        var free;
        if (f.both) {
          // pinned at both ends: a taut line bellies in the middle
          free = Math.sin(M.saturate(u) * Math.PI);
          free *= free;
        } else {
          // pinned along the top edge only
          free = M.saturate(-by / Math.max(0.15, f.h));
          free *= free;
        }
        var w1 = Math.sin(t * 3.10 + ph + u * 5.4 - free * 2.4);
        var w2 = Math.sin(t * 1.77 + ph * 1.6 + u * 2.1 + free * 3.1);
        var bill = Math.sin(t * 0.68 + ph) * 0.5 + 0.5;
        var out = (w1 * 0.17 + w2 * 0.11 + bill * 0.20) * free * a;
        arr[k * 3] = bx + w2 * 0.030 * free * a;
        arr[k * 3 + 1] = by + (f.both ? -Math.abs(out) * 0.28 : -Math.abs(out) * 0.10);
        arr[k * 3 + 2] = bz + out;
      }
      p.needsUpdate = true;
      f.geo.computeVertexNormals();
    }

    // ---- litter pinned against the netting ----------------------------------
    var cb = this._caughtBatch;
    if (cb && cb.mesh && this.caught.length) {
      for (i = 0; i < this.caught.length; i++) {
        var c = this.caught[i];
        var ph2 = c.phase, rt = c.rate;
        // it is HELD, not swinging: pinned at one corner and snapping about it
        var flut = Math.sin(t * 5.6 * rt + ph2) * 0.34 + Math.sin(t * 11.3 * rt + ph2 * 2.1) * 0.14;
        var lean = 0.22 + Math.sin(t * 0.9 * rt + ph2) * 0.10;
        cb.mesh.setMatrixAt(c.idx,
          T(c.x, c.y, c.z,
            lean * amp * 0.7, c.yaw + flut * amp * 0.5, flut * amp,
            c.scale, c.scale, c.scale));
      }
      cb.mesh.instanceMatrix.needsUpdate = true;
    }
  };
})(window.GAME, window.THREE);
