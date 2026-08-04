// ============================================================================
// OPERATION BLACKOUT - "LINE 4 / ZARECHNAYA" - set dressing
// Module owner: props_metro.  Exports GAME.PropsMetro.
//
// level_metro.js builds the PLACE: 70 m of flooded pylon station, two track
// halls, four running tunnels, a derailed train and an escalator bank.  This
// file is what makes it a place that was USED - by passengers for forty years,
// then by a maintenance gang who were still trying to pump it out when they
// left, and then by nobody at all.
//
// ----------------------------------------------------------------------------
// HOW THIS SET INVERTS THE HARBOUR SET
// ----------------------------------------------------------------------------
// Both levels are wet and both write wetness into the vertex G channel, and
// that is where the similarity stops:
//
//   * THE WATER COMES FROM BELOW, NOT ABOVE.  In a downpour the up-facing
//     surfaces hold a film and the undersides stay dry, so props_harbor soaks
//     by `up`.  Down here the flood is standing at y = 0.26 and everything is
//     soaked from the FOOT UPWARD by capillary rise - the bottom 40-60 cm of
//     every bag, crate, bench leg and bin is black and glossy, and the top of
//     the same object is dry, dusty and matte.  That vertical gradient on a
//     prop is the single strongest signal that the room is flooded, and a
//     uniformly-wet prop throws it away.  The exception is anything standing
//     under a drip line, which holds a film on its up-faces as well; `drip` in
//     the paint call is that, and it is only ever set for props placed under
//     the vent shaft, the collapse or a cracked vault rib.
//   * THERE IS NO WIND AND NO WEATHER.  ctx.weather is inert by contract on
//     this level, so nothing here may depend on it - but the station is not
//     still: a deep tube breathes, and the draught down the running tunnels is
//     what moves the hanging straps, the cut cable ends and the litter rafts
//     on the water.  The sway driver reads ctx.weather.windSpeed IF weather
//     exists (so the module still behaves on a level that has one) and falls
//     back to a slow 0.4 m/s tunnel draught along the X axis, which is the axis
//     the tunnels run on.
//   * THE ACCUMULANT IS RUBBISH AND SILT, NOT SAND OR SPRAY.  Litter does not
//     scatter; it strands.  Every drift in this file is placed against
//     something that stopped it - a pier base, the platform coping, a rail, the
//     wreck's flank, the sandbag dike - and every raft on the water is placed
//     on the upstream side of an obstruction.
//
// ----------------------------------------------------------------------------
// CONSTRAINTS THAT SHAPED THE CODE (unchanged from the harbour and boneyard)
// ----------------------------------------------------------------------------
//   * < 80 draw calls for ALL props.  Anything appearing more than about six
//     times is an InstancedMesh with per-instance yaw, tilt, scale and wear
//     jitter; everything one-off is merged per material into a dozen static
//     batches.
//   * Nothing floats.  Every placement resolves its height through
//     ctx.level.sampleGround or ctx.level.raycast, and every site is rejected
//     if a level collider already occupies it.
//   * NOTHING derives a position from a camera pose.  Everything hangs off
//     level.anchors, which level_metro.js publishes for exactly this reason and
//     which is available before build().  The poses are read ONCE, as a
//     keep-out list, so a prop cannot end up inside the lens.
//   * Every cross-module call is guarded.  ctx.level, ctx.materials and
//     ctx.weather may all be missing or broken; we degrade, never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  Build-time code runs several thousand placements; a Matrix4 per
  // placement is a measurable chunk of the boot budget.
  // --------------------------------------------------------------------------
  var _m4 = new THREE.Matrix4();
  var _m4b = new THREE.Matrix4();
  var _qt = new THREE.Quaternion();
  var _qs = new THREE.Quaternion();
  var _eu = new THREE.Euler();
  var _vp = new THREE.Vector3();
  var _vs = new THREE.Vector3();
  var _va = new THREE.Vector3();
  var _vc = new THREE.Vector3();
  var _vd = new THREE.Vector3();
  var _col = new THREE.Color();
  var _col2 = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var WHITE = new THREE.Color(1, 1, 1);
  var TAU = Math.PI * 2;

  // --------------------------------------------------------------------------
  // Tinting.  An InstancedMesh colour and a material colour BOTH multiply the
  // albedo, and a library material already carries a calibrated gain solved
  // from its own map, so a raw mid-tone hex squares the albedo and the prop
  // renders as a cut-out.  Every tint is normalised by its own max channel and
  // pulled back toward white: the hex is a HUE SHIFT, not a second coat.
  // --------------------------------------------------------------------------
  var _tc = new THREE.Color();
  function normTint(hex, strength, out) {
    out = out || _tc;
    out.setHex(hex, THREE.SRGBColorSpace);
    var mx = Math.max(out.r, Math.max(out.g, out.b));
    if (!(mx > 1e-4)) mx = 1;
    out.multiplyScalar(1 / mx);
    var s = strength === undefined ? 0.6 : strength;
    out.r = 1 + (out.r - 1) * s;
    out.g = 1 + (out.g - 1) * s;
    out.b = 1 + (out.b - 1) * s;
    return out;
  }

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
  // there" is the natural description of a brace, a conduit or a hose; an Euler
  // is not.
  function strutM(ax, ay, az, bx2, by, bz) {
    _vc.set(bx2 - ax, by - ay, bz - az);
    var len = _vc.length();
    if (!(len > 1e-6)) len = 1e-6;
    _vd.copy(_vc).multiplyScalar(1 / len);
    _qs.setFromUnitVectors(UP, _vd);
    _vp.set((ax + bx2) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _vs.set(1, len, 1);
    return _m4b.compose(_vp, _qs, _vs);
  }

  function part(geometry, matrix) {
    return { geometry: geometry, matrix: matrix ? matrix.clone() : null };
  }

  function mergeParts(parts) {
    if (!parts || !parts.length) return null;
    var g = null;
    try { g = Geo.mergeAll(parts); }
    catch (e) { GAME.logError('propsM.merge', e); return null; }
    return g;
  }

  function disposeParts(parts) {
    var seen = new Set();
    for (var i = 0; i < parts.length; i++) {
      var g = parts[i].geometry;
      if (g && !seen.has(g)) { seen.add(g); if (g.dispose) g.dispose(); }
    }
    parts.length = 0;
  }

  // Displace every vertex by fbm.  The cheapest way to stop a primitive reading
  // as a primitive: a bin that has been kicked down a platform for thirty years
  // does not have a circular section, and a sandbag is not an ellipsoid.
  function roughen(geo, noise, amount, freq, mode) {
    var p = geo.attributes.position;
    if (!p || !noise) return geo;
    freq = freq || 3;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n1 = noise.fbm3(x * freq, y * freq, z * freq, 3, 2.1, 0.55);
      if (mode === 'radial') {
        var r = Math.sqrt(x * x + z * z);
        if (r > 1e-5) {
          var s = 1 + n1 * amount;
          p.setXYZ(i, x * s, y + n1 * amount * 0.2, z * s);
        }
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

  // A closed 2D profile extruded along Z with fan-triangulated caps.  Channel
  // sections, angle iron, bent sheet, the cast end frame of a platform bench -
  // anything with a recognisable cross-section rather than a rectangle.
  function extrudeProfile(pts, depth, uvScale) {
    var n = pts.length, hz = depth * 0.5;
    var pos = [], nrm = [], uv = [];
    var i, a, b;
    function push(px, py, pz, nx, ny, nz, u, v) {
      pos.push(px, py, pz); nrm.push(nx, ny, nz); uv.push(u, v);
    }
    for (i = 0; i < n; i++) {
      a = pts[i]; b = pts[(i + 1) % n];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = dy / len, ny = -dx / len;
      var u1 = len * (uvScale || 1);
      var vd = depth * (uvScale || 1);
      push(a.x, a.y, -hz, nx, ny, 0, 0, 0);
      push(b.x, b.y, -hz, nx, ny, 0, u1, 0);
      push(b.x, b.y, hz, nx, ny, 0, u1, vd);
      push(a.x, a.y, -hz, nx, ny, 0, 0, 0);
      push(b.x, b.y, hz, nx, ny, 0, u1, vd);
      push(a.x, a.y, hz, nx, ny, 0, 0, vd);
    }
    for (i = 1; i < n - 1; i++) {
      var p0 = pts[0], p1 = pts[i], p2 = pts[i + 1];
      push(p0.x, p0.y, hz, 0, 0, 1, p0.x, p0.y);
      push(p1.x, p1.y, hz, 0, 0, 1, p1.x, p1.y);
      push(p2.x, p2.y, hz, 0, 0, 1, p2.x, p2.y);
      push(p0.x, p0.y, -hz, 0, 0, -1, p0.x, p0.y);
      push(p2.x, p2.y, -hz, 0, 0, -1, p2.x, p2.y);
      push(p1.x, p1.y, -hz, 0, 0, -1, p1.x, p1.y);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeBoundingSphere();
    return g;
  }

  // A cylindrically-UV'd lathe.  v runs along the profile and u round the axis,
  // which is what a bin, a drum, a bucket and a bottle all want, so anything
  // carrying its own painted texture is one of these rather than a cylinder.
  function lathe(profile, segs, uRepeat, vRepeat) {
    var pts = [];
    for (var i = 0; i < profile.length; i++) {
      pts.push(new THREE.Vector2(Math.max(1e-4, profile[i][0]), profile[i][1]));
    }
    var g = new THREE.LatheGeometry(pts, segs || 16);
    var uv = g.attributes.uv;
    if (uv && (uRepeat || vRepeat)) {
      for (var k = 0; k < uv.count; k++) {
        uv.setXY(k, uv.getX(k) * (uRepeat || 1), uv.getY(k) * (vRepeat || 1));
      }
      uv.needsUpdate = true;
    }
    return g;
  }

  // Alpha card, base at y = 0, standing in +Y.  Litter, posters, scum, drips.
  function card(w, h, u0, v0, u1, v1) {
    var hw = w * 0.5;
    var pos = new Float32Array([
      -hw, 0, 0, hw, 0, 0, hw, h, 0,
      -hw, 0, 0, hw, h, 0, -hw, h, 0
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var uv = new Float32Array([
      u0, v0, u1, v0, u1, v1,
      u0, v0, u1, v1, u0, v1
    ]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A limp sheet: a subdivided quad sagging between its corners with a fold
  // across it, so a dropped tarpaulin or a torn poster is not a flat plane.
  function sheet(w, d, nx, nz, sag, noise, seed) {
    nx = nx || 6; nz = nz || 4;
    var pos = [], nrm = [], uv = [];
    var i, j;
    function hAt(u, v) {
      var s = Math.sin(u * Math.PI) * Math.sin(v * Math.PI);
      var n = noise ? noise.fbm2(u * 3.1 + (seed || 0), v * 3.1 - (seed || 0), 3) : 0;
      return -sag * s + n * sag * 0.55;
    }
    var grid = [];
    for (j = 0; j <= nz; j++) {
      grid[j] = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx, v = j / nz;
        grid[j][i] = [(u - 0.5) * w, hAt(u, v), (v - 0.5) * d];
      }
    }
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d2 = grid[j + 1][i];
        var u0 = i / nx, u1 = (i + 1) / nx, v0 = j / nz, v1 = (j + 1) / nz;
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        uv.push(u0, v0, u1, v0, u1, v1);
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d2[0], d2[1], d2[2]);
        uv.push(u0, v0, u1, v1, u0, v1);
      }
    }
    for (i = 0; i < pos.length; i++) nrm.push(0);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    return g;
  }

  // A cached bevelled box.  Perfectly sharp 90-degree edges never catch a
  // highlight, and in a level lit entirely by long thin fluorescent sources a
  // caught highlight along an edge is most of what makes a prop read at all.
  var _boxCache = new Map();
  function bx(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.010, Math.min(w, Math.min(h, d)) * 0.26);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) { g = Geo.bevelBox(w, h, d, bevel); _boxCache.set(k, g); }
    return g;
  }
  var _cylCache = new Map();
  // The default was 10 and the scaffold standards, the ladder stiles and the
  // hose runs all passed 6 or 7 explicitly - visibly faceted on a 26 mm tube
  // standing four metres from the hero1 lens. 14 on a level running at an
  // eighth of its triangle budget, and the cache is keyed on segment count so
  // the cost is bounded.
  function cy(rTop, rBot, len, seg, open) {
    seg = seg || 14;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg + (open ? 'o' : '');
    var g = _cylCache.get(k);
    if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, !!open); _cylCache.set(k, g); }
    return g;
  }
  function clearCaches() {
    _boxCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _boxCache.clear();
    _cylCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _cylCache.clear();
  }

  // ==========================================================================
  // Item - a transform stack that sorts parts into per-material buckets.
  //
  // An instanced prop must end up as ONE geometry per material and a one-off
  // prop must end up merged into the shared static batch for its material.  The
  // same builder produces both.
  // ==========================================================================
  function Item() {
    this.buckets = Object.create(null);
    this._st = [new THREE.Matrix4()];
  }
  Item.prototype.top = function () { return this._st[this._st.length - 1]; };
  Item.prototype.push = function (m) {
    this._st.push(new THREE.Matrix4().multiplyMatrices(this.top(), m));
    return this;
  };
  Item.prototype.pushXYZ = function (x, y, z, rx, ry, rz, sx, sy, sz) {
    return this.push(Tn(x, y, z, rx, ry, rz, sx, sy, sz));
  };
  Item.prototype.pop = function () { if (this._st.length > 1) this._st.pop(); return this; };
  Item.prototype.add = function (key, geo, local) {
    if (!geo) return this;
    var b = this.buckets[key] || (this.buckets[key] = []);
    var wm = new THREE.Matrix4();
    if (local) wm.multiplyMatrices(this.top(), local); else wm.copy(this.top());
    b.push({ geometry: geo, matrix: wm });
    return this;
  };
  Item.prototype.box = function (key, w, h, d, x, y, z, bevel) {
    return this.add(key, bx(w, h, d, bevel), Tn(x, y, z));
  };
  Item.prototype.boxR = function (key, w, h, d, x, y, z, rx, ry, rz, bevel) {
    return this.add(key, bx(w, h, d, bevel), Tn(x, y, z, rx, ry, rz));
  };
  Item.prototype.cyl = function (key, r0, r1, len, x, y, z, rx, ry, rz, seg) {
    return this.add(key, cy(r0, r1, len, seg), Tn(x, y, z, rx, ry, rz));
  };
  Item.prototype.strut = function (key, ax, ay, az, bx2, by, bz, w, d) {
    var len = Math.sqrt((bx2 - ax) * (bx2 - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
    if (len < 1e-4) return this;
    return this.add(key, bx(w, 1, d === undefined ? w : d, Math.min(0.005, w * 0.25)),
      strutM(ax, ay, az, bx2, by, bz).clone());
  };
  Item.prototype.tube = function (key, r, ax, ay, az, bx2, by, bz, seg) {
    var len = Math.sqrt((bx2 - ax) * (bx2 - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
    if (len < 1e-4) return this;
    return this.add(key, cy(r, r, 1, seg || 7), strutM(ax, ay, az, bx2, by, bz).clone());
  };
  // A sagging run of cable or hose between two points.  Every metro tunnel is
  // strung with these and the catenary is the only curve in a level built out
  // of straight lines.
  Item.prototype.sag = function (key, ax, ay, az, bx2, by, bz, drop, r, segs) {
    segs = segs || 6;
    var px = ax, py = ay, pz = az;
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var qx = ax + (bx2 - ax) * t;
      var qz = az + (bz - az) * t;
      var qy = ay + (by - ay) * t - Math.sin(t * Math.PI) * drop;
      this.tube(key, r, px, py, pz, qx, qy, qz, 6);
      px = qx; py = qy; pz = qz;
    }
    return this;
  };
  Item.prototype.merge = function (key) {
    var p = this.buckets[key];
    if (!p || !p.length) return null;
    return mergeParts(p);
  };
  Item.prototype.keys = function () { return Object.keys(this.buckets); };

  // ==========================================================================
  // Batch - InstancedMesh that counts up as you place.
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
    // Always write a colour: instanceColor allocates lazily and an unwritten
    // entry can render black depending on three's fill policy.
    this.mesh.setColorAt(this.n, color || WHITE);
    this.n++;
    return true;
  };
  Batch.prototype.finish = function (parent, name) {
    if (this.n === 0) { this.mesh.dispose(); return null; }
    this.mesh.count = this.n;
    this.mesh.name = name || 'metro_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // A multi-material instanced prop: N parallel batches sharing one matrix.  A
  // bench is cast iron AND timber, and forcing it into one material to save a
  // draw call costs the object its read.
  function Combo(list) { this.list = list || []; this.n = 0; this.max = 1e9; }
  Combo.prototype.add = function (matrix, color) {
    var ok = false;
    for (var i = 0; i < this.list.length; i++) {
      if (this.list[i] && this.list[i].add(matrix, color)) ok = true;
    }
    if (ok) this.n++;
    return ok;
  };

  // ==========================================================================
  // THE WEAR CHANNEL, TURNED UPSIDE DOWN FOR A FLOODED TUNNEL.
  //
  // materials.js reads the geometry `color` attribute as a wear mask, white =
  // pristine:
  //     R -> grime      G -> WETNESS      B -> edge wear (toward `wearColor`)
  //
  // props_harbor spends G on UP-facing surfaces, because its water falls out of
  // the sky.  Here the water is standing on the floor, so G is spent on the
  // bottom of every object and dies off with height: `soak` is the wetness at
  // the foot and `rise` is the capillary height over which it fades.  A crate
  // that is black and mirror-glossy for its bottom 30 cm and dry, dusty and
  // matte above that reads as "this room is flooded" from ten metres away; the
  // same crate soaked uniformly reads as "this crate was dipped".
  //
  // `drip` adds a film to up-faces, and is only ever set for props under the
  // vent shaft, under the collapse or under a weeping vault rib.
  //
  // NOTE: Geo.mergeAll carries only position/normal/uv, so every merged
  // geometry must be painted AFTER the merge.  Every caller here does.
  // ==========================================================================
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var soak = o.soak === undefined ? 0.62 : o.soak;
    var rise = o.rise === undefined ? 0.55 : o.rise;
    var drip = o.drip === undefined ? 0.10 : o.drip;
    var grime = o.grime === undefined ? 0.44 : o.grime;
    var edge = o.edge === undefined ? 0.22 : o.edge;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.2 : o.hiY;
    var inner = o.inner === undefined ? 0.08 : o.inner;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var up = M.saturate(ny), down = M.saturate(-ny);
      // capillary rise out of the flood, plus a film where it drips from above
      var wet = soak * (1 - M.smoothstep(loY, loY + rise, y)) + drip * up * up;
      // grime: heaviest low down and under every overhang, where the silt and
      // the rat runs are
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.30 + 0.90 * lowness * lowness) * (0.70 + 0.55 * down);
      // Edge wear rides the up-facing extremities: the corners that hands,
      // boots and barrow wheels actually hit.
      //
      // `reach` is distance from the geometry's OWN origin, which is only
      // meaningful for a prop authored around its origin.  A merged static
      // batch is in WORLD space - a kiosk at x = 36 has every vertex 36 m from
      // the origin - so reach saturates to 1 and the whole batch gets maximum
      // edge wear, which blends every surface toward the pale substrate.  That
      // is exactly what turned the ticket gates into glowing white bollards and
      // put 2.5% of the escalator framing into hard clipping.  Callers working
      // in world space pass worldOrigin:true and get the up-facing term only.
      var ed;
      if (o.worldOrigin) {
        ed = edge * (0.30 + 0.80 * up);
      } else {
        var reach = M.saturate((Math.sqrt(x * x + z * z) - inner) * 1.5);
        ed = edge * (0.24 + 0.86 * reach) * (0.30 + 0.80 * up);
      }
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        gr = gr * (1 + nv * 0.85);
        ed = ed * (1 + nv * 1.05);
        wet = wet * (1 + nv * 0.30);
      }
      c[i * 3] = M.saturate(1 - gr);
      c[i * 3 + 1] = M.saturate(1 - M.saturate(wet));
      c[i * 3 + 2] = M.saturate(1 - ed);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the same three channels.  Multiplies the vertex
  // mask, so this is jitter and not a second coat: 1.0 leaves a channel alone.
  // On a wear-shaded material this IS the per-instance colour variation - it
  // moves albedo, roughness and Fresnel per instance - and it is why a row of
  // twelve identical bins does not read as twelve copies of one bin.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.24),      // grime
      1 - rng.range(0, 0.18),      // wetness
      1 - rng.range(0, 0.20));     // edge wear
    return out;
  }

  // Collapse debris, which is a different animal from a prop that has merely
  // got dirty. B = 1 is deliberate and it is the whole fix: the B channel is
  // EDGE WEAR and materials.js blends it toward a pale substrate, so the
  // default jitter was quietly lightening every chunk, panel and tile shard in
  // the rubble field until they photographed brighter than the deck they were
  // lying on - 46 chamfered cubes reading as polystyrene packaging. A slab that
  // came off a vault a decade ago and has been under water since is silted (low
  // R), soaked (low G) and has no bright edges at all (B = 1).
  var _dbg = new THREE.Color();
  function debrisTint(rng) {
    _dbg.setRGB(
      0.40 + rng.range(0, 0.16),
      0.46 + rng.range(0, 0.20),
      0.96 + rng.range(0, 0.04));
    return _dbg;
  }

  // ==========================================================================
  // Local texture kit.
  //
  // Generic surfaces come from ctx.materials by the names the contract fixes.
  // What lives here is props-specific ART the shared library cannot know about:
  // soviet-era advertising in an invented script, enamel platform signage,
  // sodden newsprint, the algal scum that grows on standing water in the dark,
  // rust weep and efflorescence stains, and the falling-drip streak.
  // ==========================================================================
  var TX = {};

  TX.canvas = function (w, h) {
    if (typeof document === 'undefined') return null;
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h || w;
      return c;
    } catch (e) { return null; }
  };

  TX.tex = function (canvas, srgb, rx, ry, aniso, clamp) {
    if (!canvas) return null;
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || rx || 1);
    t.anisotropy = aniso || 8;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  };

  TX.heightFromCanvas = function (canvas) {
    if (!canvas) return null;
    try {
      var g = canvas.getContext('2d');
      var d = g.getImageData(0, 0, canvas.width, canvas.height).data;
      var n = canvas.width * canvas.height;
      var h = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        h[i] = (d[i * 4] * 0.30 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
      }
      return h;
    } catch (e) { return null; }
  };

  TX.normalFromHeight = function (h, size, strength) {
    if (!h) return null;
    var data = new Uint8Array(size * size * 4);
    strength = strength === undefined ? 1.6 : strength;
    for (var y = 0; y < size; y++) {
      var ym = ((y - 1) + size) % size, yp = (y + 1) % size;
      for (var x = 0; x < size; x++) {
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

  // Two octaves of value noise, as a canvas.  The base grime layer everything
  // painted in here is multiplied by.
  TX.grunge = function (size, seed, gain) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var N = new GAME.Noise(seed >>> 0);
    var img = g.createImageData(size, size);
    var d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x / size * 6, v = y / size * 6;
        var n = N.fbm2(u, v, 4, 2.1, 0.55) * 0.5 + 0.5;
        var w = N.worley2(u * 1.6, v * 1.6, 1).f1;
        n = M.saturate(n * 0.78 + (1 - M.saturate(w)) * 0.30) * (gain || 1);
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = M.saturate(n) * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  };

  // ---- the invented script --------------------------------------------------
  // Heavy grotesque strokes on a common baseline so a row reads as a WORD
  // rather than as a row of symbols.  Deliberately the same construction
  // language as level_metro.js's own signage atlas - the station and the
  // advertising posted in it have to be written in the same alphabet, and two
  // different invented scripts in one room reads as two different art passes.
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

  function word(g, cx, cy, h, n, rng, weight) {
    var w = h * 0.62, gap = h * 0.26;
    var total = n * w + (n - 1) * gap;
    var x = cx - total * 0.5;
    g.lineWidth = Math.max(1.5, h * (weight || 0.19));
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    for (var i = 0; i < n; i++) {
      glyph(g, x, cy - h * 0.5, w, h, rng.int(0, 11));
      x += w + gap;
    }
    return total;
  }

  // A block of body copy: bars, not glyphs.  At the distance a poster on a
  // pier is ever seen, real letterforms would be a grey smear anyway, and bars
  // read as text at every distance without ever resolving into gibberish.
  function copyBlock(g, x, y, w, lines, lh, rng, alpha) {
    g.save();
    for (var i = 0; i < lines; i++) {
      var lw = w * rng.range(0.55, 1.0);
      g.globalAlpha = alpha === undefined ? 0.75 : alpha;
      g.fillRect(x, y + i * lh, lw, lh * 0.42);
    }
    g.restore();
  }

  // Damage: eat holes out of whatever has just been drawn.
  function erode(g, x0, y0, w, h, amount, rng, rmin, rmax) {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (var e = 0; e < amount; e++) {
      g.globalAlpha = rng.range(0.16, 0.85);
      g.beginPath();
      g.arc(x0 + rng.range(0, w), y0 + rng.range(0, h),
        rng.range(rmin || 1.5, rmax || 9), 0, TAU);
      g.fill();
    }
    g.restore();
  }

  // Stain: multiply a wash over whatever has just been drawn.
  function soil(g, x0, y0, w, h, amount, rng, colA, colB) {
    g.save();
    g.globalCompositeOperation = 'multiply';
    for (var e = 0; e < amount; e++) {
      var rx = x0 + rng.range(0, w), ry = y0 + rng.range(0, h);
      var rr = rng.range(w * 0.05, w * 0.42);
      var grd = g.createRadialGradient(rx, ry, 0, rx, ry, rr);
      grd.addColorStop(0, rng.bool() ? colA : colB);
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
    }
    g.restore();
  }

  // ---- advertising --------------------------------------------------------
  // Four posters in one 2x2 atlas.  Soviet transit advertising: one flat
  // saturated ground, one big geometric device, a headline, three lines of
  // copy, a rule.  Then forty years of damp: the paper cockles, the ink runs
  // downward, mould blooms from the bottom edge and the corners tear away.
  TX.posters = function (size, seed) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    var S = size * 0.5;
    var PAL = [
      ['#8d3226', '#e8dfc6', '#c8a03a'],
      ['#26453a', '#e2e6d4', '#c46a24'],
      ['#1f3b52', '#dfe4e6', '#b8402c'],
      ['#5c4a1e', '#e6e0cc', '#8a3a2c']
    ];
    g.clearRect(0, 0, size, size);
    for (var c = 0; c < 4; c++) {
      var ox = (c % 2) * S, oy = ((c / 2) | 0) * S;
      var p = PAL[c];
      g.save();
      g.translate(ox, oy);
      // paper
      g.fillStyle = p[1];
      g.fillRect(S * 0.03, S * 0.03, S * 0.94, S * 0.94);
      // ground block
      g.fillStyle = p[0];
      g.fillRect(S * 0.03, S * 0.03, S * 0.94, S * 0.52);
      // device: a wheel, a chevron stack or a star, depending on the lot
      g.fillStyle = p[2];
      if (c === 0) {
        g.beginPath(); g.arc(S * 0.30, S * 0.29, S * 0.16, 0, TAU); g.fill();
        g.globalCompositeOperation = 'destination-out';
        g.beginPath(); g.arc(S * 0.30, S * 0.29, S * 0.075, 0, TAU); g.fill();
        g.globalCompositeOperation = 'source-over';
      } else if (c === 1) {
        for (var k = 0; k < 3; k++) {
          g.beginPath();
          g.moveTo(S * 0.16, S * (0.13 + k * 0.12));
          g.lineTo(S * 0.34, S * (0.20 + k * 0.12));
          g.lineTo(S * 0.16, S * (0.27 + k * 0.12));
          g.closePath(); g.fill();
        }
      } else if (c === 2) {
        g.fillRect(S * 0.14, S * 0.12, S * 0.26, S * 0.34);
        g.fillStyle = p[1];
        g.fillRect(S * 0.19, S * 0.18, S * 0.16, S * 0.10);
      } else {
        g.beginPath();
        for (var s2 = 0; s2 < 10; s2++) {
          var a = -Math.PI * 0.5 + s2 * Math.PI / 5;
          var rr = (s2 % 2 === 0) ? S * 0.17 : S * 0.07;
          var px = S * 0.29 + Math.cos(a) * rr, py = S * 0.28 + Math.sin(a) * rr;
          if (s2 === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath(); g.fill();
      }
      // headline over the ground, body copy under it
      g.strokeStyle = p[1];
      word(g, S * 0.66, S * 0.20, S * 0.10, 4, rng, 0.20);
      word(g, S * 0.63, S * 0.38, S * 0.075, 5, rng, 0.20);
      g.fillStyle = 'rgba(38,40,36,0.9)';
      copyBlock(g, S * 0.09, S * 0.62, S * 0.80, 4, S * 0.055, rng, 0.8);
      g.fillStyle = p[0];
      g.fillRect(S * 0.09, S * 0.86, S * 0.82, S * 0.035);
      g.strokeStyle = 'rgba(40,42,38,0.92)';
      word(g, S * 0.50, S * 0.925, S * 0.055, 7, rng, 0.22);
      g.restore();
      // ---- forty years of damp -------------------------------------------
      soil(g, ox, oy, S, S, 22, rng, 'rgba(120,132,96,0.55)', 'rgba(96,84,58,0.6)');
      // ink running down from the wet bottom edge
      g.save();
      g.globalCompositeOperation = 'multiply';
      for (var r2 = 0; r2 < 26; r2++) {
        var sx = ox + rng.range(S * 0.05, S * 0.95);
        var sy = oy + rng.range(S * 0.45, S * 0.90);
        g.fillStyle = 'rgba(84,80,62,' + rng.range(0.10, 0.30).toFixed(3) + ')';
        g.fillRect(sx, sy, rng.range(1, 4), oy + S - sy);
      }
      g.restore();
      // the corners and the bottom edge come away first
      erode(g, ox, oy + S * 0.62, S, S * 0.38, 90, rng, 3, 16);
      erode(g, ox, oy, S, S, 46, rng, 2, 9);
      erode(g, ox, oy, S * 0.22, S * 0.22, 26, rng, 4, 18);
      erode(g, ox + S * 0.78, oy, S * 0.22, S * 0.22, 26, rng, 4, 18);
    }
    return cv;
  };

  // ---- enamel platform signage --------------------------------------------
  // Vitreous enamel on steel: it does not rot, it chips.  Four plates - a
  // direction sign, a numbered plate, a warning triangle band and a "no entry"
  // staff plate - all on the level's own sickly green so the props' signage and
  // the station's own agree.
  TX.signs = function (size, seed) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    var S = size * 0.5;
    g.clearRect(0, 0, size, size);
    function plate(ox, oy, bg, fg) {
      g.save(); g.translate(ox, oy);
      g.fillStyle = bg;
      g.fillRect(S * 0.05, S * 0.20, S * 0.90, S * 0.60);
      g.strokeStyle = fg; g.lineWidth = Math.max(2, S * 0.012);
      g.strokeRect(S * 0.08, S * 0.235, S * 0.84, S * 0.53);
      g.restore();
    }
    // 0: direction plate with an arrow
    plate(0, 0, '#2c4a38', '#dfe6d2');
    g.save();
    g.strokeStyle = '#dfe6d2';
    word(g, S * 0.56, S * 0.50, S * 0.15, 5, rng, 0.20);
    g.fillStyle = '#dfe6d2';
    g.beginPath();
    g.moveTo(S * 0.10, S * 0.50); g.lineTo(S * 0.24, S * 0.36);
    g.lineTo(S * 0.24, S * 0.44); g.lineTo(S * 0.34, S * 0.44);
    g.lineTo(S * 0.34, S * 0.56); g.lineTo(S * 0.24, S * 0.56);
    g.lineTo(S * 0.24, S * 0.64); g.closePath(); g.fill();
    g.restore();
    // 1: numbered service plate
    plate(S, 0, '#c9c2a8', '#2a2c26');
    g.save(); g.translate(S, 0);
    g.strokeStyle = '#2a2c26';
    word(g, S * 0.50, S * 0.40, S * 0.17, 3, rng, 0.22);
    word(g, S * 0.50, S * 0.63, S * 0.085, 6, rng, 0.20);
    g.restore();
    // 2: hazard band
    g.save(); g.translate(0, S);
    g.fillStyle = '#b8992a';
    g.fillRect(S * 0.05, S * 0.22, S * 0.90, S * 0.56);
    g.fillStyle = '#26282a';
    for (var i = -2; i < 12; i++) {
      g.save();
      g.beginPath();
      g.moveTo(S * (0.05 + i * 0.08), S * 0.22);
      g.lineTo(S * (0.05 + i * 0.08 + 0.04), S * 0.22);
      g.lineTo(S * (0.05 + i * 0.08 - 0.03), S * 0.78);
      g.lineTo(S * (0.05 + i * 0.08 - 0.07), S * 0.78);
      g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = 'rgba(200,196,180,0.92)';
    g.fillRect(S * 0.16, S * 0.36, S * 0.68, S * 0.28);
    g.strokeStyle = '#26282a';
    word(g, S * 0.50, S * 0.50, S * 0.10, 5, rng, 0.22);
    g.restore();
    // 3: staff / no entry plate
    plate(S, S, '#8b3226', '#e4e0d0');
    g.save(); g.translate(S, S);
    g.strokeStyle = '#e4e0d0';
    word(g, S * 0.50, S * 0.42, S * 0.11, 4, rng, 0.21);
    word(g, S * 0.50, S * 0.62, S * 0.07, 6, rng, 0.20);
    g.restore();
    // chipping and rust bleed at the fixing holes
    for (var c = 0; c < 4; c++) {
      var ox2 = (c % 2) * S, oy2 = ((c / 2) | 0) * S;
      soil(g, ox2, oy2, S, S, 10, rng, 'rgba(122,74,50,0.6)', 'rgba(110,116,92,0.5)');
      erode(g, ox2 + S * 0.03, oy2 + S * 0.18, S * 0.94, S * 0.64, 60, rng, 1.2, 5);
      g.save();
      g.fillStyle = 'rgba(122,70,44,0.85)';
      for (var k2 = 0; k2 < 2; k2++) {
        var hx = ox2 + (k2 ? S * 0.86 : S * 0.14), hy = oy2 + S * 0.30;
        g.beginPath(); g.arc(hx, hy, S * 0.018, 0, TAU); g.fill();
        var grd = g.createLinearGradient(hx, hy, hx, hy + S * 0.30);
        grd.addColorStop(0, 'rgba(122,70,44,0.55)');
        grd.addColorStop(1, 'rgba(122,70,44,0)');
        g.fillStyle = grd;
        g.fillRect(hx - S * 0.014, hy, S * 0.028, S * 0.30);
        g.fillStyle = 'rgba(122,70,44,0.85)';
      }
      g.restore();
    }
    return cv;
  };

  // ---- litter --------------------------------------------------------------
  // 2x2 atlas: a sodden newspaper sheet, a crumpled ticket/paper wad, a
  // cardboard scrap and a plastic bag.  Every cell is alpha-cut to an irregular
  // outline: a rectangular piece of litter is a decal, not a piece of litter.
  TX.litter = function (size, seed) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    var S = size * 0.5;
    g.clearRect(0, 0, size, size);

    function blob(ox, oy, fill, jag, n) {
      g.save(); g.translate(ox + S * 0.5, oy + S * 0.5);
      g.beginPath();
      for (var i = 0; i <= n; i++) {
        var a = i / n * TAU;
        var rr = S * (0.30 + rng.range(-jag, jag));
        var px = Math.cos(a) * rr * 1.05, py = Math.sin(a) * rr * 0.86;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.restore();
    }
    // 0: newspaper, folded once, print showing through the wet
    blob(0, 0, '#b9b6a6', 0.075, 13);
    g.save();
    g.fillStyle = 'rgba(48,48,44,0.62)';
    for (var i = 0; i < 9; i++) {
      copyBlock(g, S * 0.20, S * 0.20 + i * S * 0.062, S * 0.58, 1, S * 0.05, rng, 0.55);
    }
    g.fillStyle = 'rgba(40,42,38,0.55)';
    g.fillRect(S * 0.20, S * 0.15, S * 0.56, S * 0.035);
    g.restore();
    soil(g, 0, 0, S, S, 14, rng, 'rgba(116,120,92,0.7)', 'rgba(88,80,60,0.65)');
    // 1: crumpled wad
    blob(S, 0, '#cdc9bb', 0.10, 11);
    g.save();
    g.strokeStyle = 'rgba(70,70,64,0.45)';
    g.lineWidth = Math.max(1, S * 0.008);
    for (var k = 0; k < 16; k++) {
      g.beginPath();
      g.moveTo(S + rng.range(S * 0.22, S * 0.78), rng.range(S * 0.22, S * 0.78));
      g.lineTo(S + rng.range(S * 0.22, S * 0.78), rng.range(S * 0.22, S * 0.78));
      g.stroke();
    }
    g.restore();
    soil(g, S, 0, S, S, 10, rng, 'rgba(110,112,88,0.6)', 'rgba(92,84,64,0.55)');
    // 2: cardboard scrap, corrugation showing along the torn edge
    blob(0, S, '#9a7c56', 0.06, 9);
    g.save();
    g.strokeStyle = 'rgba(60,46,30,0.35)';
    g.lineWidth = Math.max(1, S * 0.01);
    for (var c2 = 0; c2 < 14; c2++) {
      g.beginPath();
      g.moveTo(S * 0.18 + c2 * S * 0.048, S + S * 0.22);
      g.lineTo(S * 0.18 + c2 * S * 0.048, S + S * 0.78);
      g.stroke();
    }
    g.restore();
    soil(g, 0, S, S, S, 14, rng, 'rgba(80,68,44,0.7)', 'rgba(64,72,52,0.6)');
    // 3: plastic bag / sheet, pale and translucent
    blob(S, S, 'rgba(206,208,198,0.86)', 0.12, 15);
    soil(g, S, S, S, S, 8, rng, 'rgba(120,126,104,0.5)', 'rgba(150,150,140,0.4)');
    // every cell gets its edges chewed
    for (var q = 0; q < 4; q++) {
      erode(g, (q % 2) * S, ((q / 2) | 0) * S, S, S, 40, rng, 2, 10);
    }
    return cv;
  };

  // ---- algal scum on standing water ---------------------------------------
  // What actually grows on water that has stood in the dark for years: a
  // greenish-black biofilm with a bloom of paler foam at its edge, plus the
  // rainbow sheen where somebody's hydraulic oil got into it.
  TX.scum = function (size, seed) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    g.clearRect(0, 0, size, size);
    var N = new GAME.Noise((seed ^ 0x51D) >>> 0);
    var img = g.createImageData(size, size);
    var d = img.data;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var u = x / size, v = y / size;
        var dx = u - 0.5, dy = v - 0.5;
        var r = Math.sqrt(dx * dx + dy * dy) * 2;
        var n = N.fbm2(u * 5.5, v * 5.5, 4, 2.2, 0.55) * 0.5 + 0.5;
        var a = M.saturate((1 - r) * 1.5) * M.saturate(n * 1.5 - 0.28);
        var edge = M.saturate(1 - Math.abs(r - 0.72) * 6) * n;
        var i = (y * size + x) * 4;
        // biofilm green-black, foam pale at the rim
        d[i] = (36 + edge * 120 + n * 22);
        d[i + 1] = (48 + edge * 118 + n * 30);
        d[i + 2] = (34 + edge * 96 + n * 18);
        d[i + 3] = M.saturate(a * 1.15 + edge * 0.35) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  };

  // ---- stains --------------------------------------------------------------
  // 2x2: rust weep, water streak / efflorescence, soot, mould bloom.  These go
  // on walls under fixings and on the floor under everything.
  TX.stains = function (size, seed) {
    var cv = TX.canvas(size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    var S = size * 0.5;
    g.clearRect(0, 0, size, size);
    var i, k;
    // 0: rust weep, running downward from a point
    g.save(); g.translate(0, 0);
    for (i = 0; i < 26; i++) {
      var wx = S * 0.5 + rng.gaussian(0, S * 0.10);
      var grd = g.createLinearGradient(wx, S * 0.12, wx, S * 0.95);
      grd.addColorStop(0, 'rgba(126,68,38,' + rng.range(0.30, 0.62).toFixed(3) + ')');
      grd.addColorStop(0.6, 'rgba(112,64,40,0.28)');
      grd.addColorStop(1, 'rgba(100,62,42,0)');
      g.fillStyle = grd;
      g.fillRect(wx - rng.range(1, 5), S * 0.12, rng.range(2, 9), S * 0.83);
    }
    g.restore();
    // 1: water streak with a pale mineral bloom
    g.save(); g.translate(S, 0);
    for (i = 0; i < 22; i++) {
      var sx = rng.range(S * 0.1, S * 0.9);
      var grd2 = g.createLinearGradient(sx, 0, sx, S);
      grd2.addColorStop(0, 'rgba(206,208,196,' + rng.range(0.18, 0.42).toFixed(3) + ')');
      grd2.addColorStop(1, 'rgba(180,186,172,0)');
      g.fillStyle = grd2;
      g.fillRect(sx - rng.range(2, 8), 0, rng.range(4, 16), S);
    }
    g.restore();
    // 2: soot / scorch
    g.save(); g.translate(0, S);
    for (i = 0; i < 18; i++) {
      var cx = rng.range(S * 0.25, S * 0.75), cyy = S * 0.5 + rng.range(-S * 0.2, S * 0.2);
      var rr = rng.range(S * 0.12, S * 0.38);
      var grd3 = g.createRadialGradient(cx, cyy, 0, cx, cyy, rr);
      grd3.addColorStop(0, 'rgba(24,22,20,' + rng.range(0.30, 0.60).toFixed(3) + ')');
      grd3.addColorStop(1, 'rgba(24,22,20,0)');
      g.fillStyle = grd3;
      g.fillRect(cx - rr, cyy - rr, rr * 2, rr * 2);
    }
    g.restore();
    // 3: mould bloom
    g.save(); g.translate(S, S);
    for (i = 0; i < 120; i++) {
      var mx = rng.range(0, S), my = rng.range(0, S);
      var mr = rng.range(S * 0.01, S * 0.07);
      var e = 1 - M.saturate(Math.sqrt((mx / S - 0.5) * (mx / S - 0.5) + (my / S - 0.5) * (my / S - 0.5)) * 2.1);
      g.fillStyle = 'rgba(' + (60 + rng.int(0, 26)) + ',' + (72 + rng.int(0, 30)) + ',' +
        (48 + rng.int(0, 20)) + ',' + (e * rng.range(0.25, 0.55)).toFixed(3) + ')';
      g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fill();
    }
    g.restore();
    for (k = 0; k < 4; k++) {
      erode(g, (k % 2) * S, ((k / 2) | 0) * S, S, S, 30, rng, 4, 22);
    }
    return cv;
  };

  // ---- the falling drip ----------------------------------------------------
  // A vertical streak that scrolls downward.  Additive and faint: water falling
  // through a fluorescent beam is a highlight, not a white bar.
  TX.drip = function (w, h, seed) {
    var cv = TX.canvas(w, h);
    if (!cv) return null;
    var g = cv.getContext('2d');
    var rng = new GAME.RNG(seed >>> 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    for (var i = 0; i < 14; i++) {
      var x = rng.range(w * 0.2, w * 0.8);
      var y0 = rng.range(0, h);
      var len = rng.range(h * 0.06, h * 0.22);
      var grd = g.createLinearGradient(x, y0, x, y0 + len);
      grd.addColorStop(0, 'rgba(190,214,196,0)');
      grd.addColorStop(0.55, 'rgba(206,224,208,' + rng.range(0.35, 0.8).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(190,214,196,0)');
      g.fillStyle = grd;
      g.fillRect(x - rng.range(0.6, 1.8), y0, rng.range(1.2, 3.4), len);
    }
    return cv;
  };

  // ==========================================================================
  // THE KIT.
  //
  // Every builder authors its prop with y = 0 AT THE BASE and the origin at the
  // footprint centre, so _drop can put it on the ground without knowing what it
  // is.  Anything that hangs (a strap, a stalactite, a cut cable) is authored
  // with y = 0 at its FIXING instead, and says so.
  //
  // Bucket keys are material names resolved in _initMaterials:
  //   steel rust wood concrete tile plastic rubber fabric grate glass
  //   red green cream cable poster sign
  // ==========================================================================
  var K = {};

  // ---- platform furniture --------------------------------------------------

  // Soviet platform bench: two cast frames, timber slats, and forty years of
  // boots on the front edge of the seat.  1.9 m long, seat at 0.44.
  K.bench = function (N, R) {
    var it = new Item();
    var HL = 0.86;
    var s, i;
    for (s = -1; s <= 1; s += 2) {
      var ex = s * HL;
      // foot, leg, and the cast scroll that carries the seat
      it.box('rust', 0.09, 0.035, 0.62, ex, 0.018, 0);
      it.boxR('rust', 0.065, 0.44, 0.075, ex, 0.22, -0.22, 0, 0, s * 0.03);
      it.boxR('rust', 0.065, 0.44, 0.075, ex, 0.22, 0.20, 0, 0, -s * 0.03);
      it.box('rust', 0.055, 0.055, 0.50, ex, 0.42, -0.01);
      // the back stanchion, raked
      it.boxR('rust', 0.06, 0.56, 0.06, ex, 0.70, 0.26, -0.20, 0, 0);
      // a diagonal in the frame, which is what stops the end reading as a slab
      it.strut('rust', ex, 0.06, -0.20, ex, 0.40, 0.18, 0.035, 0.035);
    }
    // seat slats, front one worn thin
    for (i = 0; i < 5; i++) {
      var sz = -0.20 + i * 0.10;
      it.boxR('wood', HL * 2 - 0.10, 0.030 + (i === 0 ? -0.004 : 0), 0.082,
        0, 0.452, sz, 0, 0, (R ? R.range(-0.006, 0.006) : 0));
    }
    // back slats, raked back with the stanchions
    for (i = 0; i < 3; i++) {
      var by = 0.58 + i * 0.135;
      it.boxR('wood', HL * 2 - 0.14, 0.028, 0.075, 0, by, 0.255 - (by - 0.58) * 0.20,
        -0.20, 0, (R ? R.range(-0.008, 0.008) : 0));
    }
    return it;
  };

  // Cast litter bin.  The rim is a separate ring so the silhouette has a lip -
  // a bin without one is a cup.
  K.bin = function (N, R) {
    var it = new Item();
    var prof = [
      [0, 0], [0.175, 0], [0.195, 0.055], [0.180, 0.56], [0.205, 0.645],
      [0.203, 0.685], [0.186, 0.678], [0.172, 0.60], [0.168, 0.10],
      [0.100, 0.055], [0, 0.045]
    ];
    var g = lathe(prof, 16, 2, 1);
    if (N) roughen(g, N, 0.010, 6, 'radial');
    it.add('rust', g);
    // two hoop bands and three vertical straps
    it.cyl('rust', 0.192, 0.192, 0.030, 0, 0.20, 0, 0, 0, 0, 16);
    it.cyl('rust', 0.190, 0.190, 0.026, 0, 0.42, 0, 0, 0, 0, 16);
    for (var k = 0; k < 3; k++) {
      var a = k / 3 * TAU + 0.4;
      it.boxR('rust', 0.030, 0.60, 0.022, Math.cos(a) * 0.186, 0.32, Math.sin(a) * 0.186,
        0, -a, 0);
    }
    return it;
  };

  // Slatted timber crate.  Boards with gaps, corner battens and one board
  // sprung off its nails - a crate built as a solid box is a cardboard cube.
  K.crate = function (N, R) {
    var it = new Item();
    var W = 0.74, H = 0.50, D = 0.52;
    var i, s;
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 3; i++) {
        var by = 0.06 + i * 0.19;
        var sprung = (s > 0 && i === 2) ? R.range(0.04, 0.10) : 0;
        it.boxR('wood', W, 0.12, 0.022, 0, by + sprung * 0.4, s * (D * 0.5),
          0, 0, sprung * 0.5);
      }
      for (i = 0; i < 3; i++) {
        it.box('wood', 0.022, 0.12, D - 0.05, s * (W * 0.5), 0.06 + i * 0.19, 0);
      }
    }
    // corner battens
    for (s = -1; s <= 1; s += 2) {
      for (i = -1; i <= 1; i += 2) {
        it.box('wood', 0.045, H, 0.045, s * (W * 0.5 - 0.02), H * 0.5, i * (D * 0.5 - 0.02));
      }
    }
    // lid boards, one missing
    for (i = 0; i < 3; i++) {
      if (i === 1 && R.bool(0.5)) continue;
      it.boxR('wood', W - 0.04, 0.020, 0.15, 0, H + 0.010, -0.17 + i * 0.17,
        0, 0, R.range(-0.01, 0.01));
    }
    return it;
  };

  // 200 litre steel drum, dented.
  K.drum = function (N, R) {
    var it = new Item();
    var prof = [
      [0, 0], [0.278, 0], [0.288, 0.025], [0.288, 0.10], [0.298, 0.135],
      [0.298, 0.19], [0.288, 0.225], [0.288, 0.52], [0.298, 0.555],
      [0.298, 0.61], [0.288, 0.645], [0.288, 0.83], [0.276, 0.862], [0, 0.868]
    ];
    var g = lathe(prof, 18, 2, 1);
    if (N) roughen(g, N, 0.014, 5, 'radial');
    it.add('rust', g);
    it.cyl('rust', 0.055, 0.055, 0.024, 0.14, 0.874, 0.04, 0, 0, 0, 8);
    return it;
  };

  // Sandbag.  A squashed, lumpy ellipsoid with a tied neck; the neck is what
  // makes a row of them read as bags rather than as pillows.
  K.sandbag = function (N, R) {
    var it = new Item();
    var g = new THREE.SphereGeometry(0.5, 10, 7);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      p.setXYZ(i, x * 0.46, y * 0.155 + 0.155, z * 0.30);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    if (N) roughen(g, N, 0.022, 5);
    it.add('fabric', g);
    it.boxR('fabric', 0.10, 0.075, 0.10, 0.235, 0.115, 0, 0, 0, 0.5);
    return it;
  };

  // Traffic cone with a retroreflective sleeve.  The sleeve is a separate
  // bucket so it can carry a pale material - it is one of very few bright
  // things in a level with no daylight in it.
  K.cone = function () {
    var it = new Item();
    it.box('plastic', 0.30, 0.028, 0.30, 0, 0.014, 0);
    var g = lathe([
      [0.145, 0.02], [0.135, 0.06], [0.088, 0.30], [0.060, 0.48],
      [0.048, 0.53], [0.030, 0.545], [0, 0.545]
    ], 12, 2, 1);
    it.add('plastic', g);
    it.cyl('cream', 0.098, 0.086, 0.085, 0, 0.315, 0, 0, 0, 0, 12);
    return it;
  };

  // Folding trestle barrier: two A-frames and a striped board.
  K.barrier = function (R) {
    var it = new Item();
    var s;
    for (s = -1; s <= 1; s += 2) {
      var ex = s * 0.62;
      it.strut('steel', ex, 0.0, -0.30, ex, 0.96, 0.0, 0.045, 0.045);
      it.strut('steel', ex, 0.0, 0.30, ex, 0.96, 0.0, 0.045, 0.045);
      it.box('steel', 0.05, 0.03, 0.56, ex, 0.42, 0);
    }
    it.box('red', 1.42, 0.20, 0.045, 0, 0.86, 0);
    it.box('steel', 1.36, 0.05, 0.035, 0, 0.62, 0);
    return it;
  };

  // Cable reel: two timber discs, a wound core and a stub of cable hanging off
  // it.  Authored lying on its rim, which is how one abandoned mid-job sits.
  K.reel = function (N, R) {
    var it = new Item();
    var Rd = 0.60;
    for (var s = -1; s <= 1; s += 2) {
      it.cyl('wood', Rd, Rd, 0.055, 0, Rd, s * 0.31, 0, 0, Math.PI * 0.5, 16);
      for (var k = 0; k < 6; k++) {
        var a = k / 6 * TAU;
        it.boxR('wood', 0.075, Rd * 1.7, 0.030, Math.cos(a) * 0.0, Rd, s * 0.345,
          0, 0, a);
      }
    }
    it.cyl('wood', 0.22, 0.22, 0.60, 0, Rd, 0, 0, 0, Math.PI * 0.5, 14);
    it.cyl('cable', 0.44, 0.44, 0.52, 0, Rd, 0, 0, 0, Math.PI * 0.5, 16);
    return it;
  };

  // Abandoned luggage.  A hard case and a soft holdall, because a platform full
  // of identical suitcases is a shop window.
  K.suitcase = function (R) {
    var it = new Item();
    it.box('plastic', 0.52, 0.36, 0.175, 0, 0.18, 0, 0.014);
    it.box('plastic', 0.53, 0.022, 0.185, 0, 0.185, 0);
    for (var s = -1; s <= 1; s += 2) {
      for (var k = -1; k <= 1; k += 2) {
        it.box('rust', 0.05, 0.05, 0.19, s * 0.24, 0.18 + k * 0.15, 0);
      }
    }
    it.box('rust', 0.16, 0.035, 0.035, 0, 0.375, 0);
    it.box('rust', 0.035, 0.035, 0.035, -0.07, 0.36, 0);
    it.box('rust', 0.035, 0.035, 0.035, 0.07, 0.36, 0);
    return it;
  };

  K.duffel = function (N, R) {
    var it = new Item();
    var g = new THREE.CapsuleGeometry(0.16, 0.34, 4, 10);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i), p.getY(i) * 0.86, p.getZ(i) * 0.90);
    }
    p.needsUpdate = true; g.computeVertexNormals();
    if (N) roughen(g, N, 0.020, 5);
    it.add('fabric', g, Tn(0, 0.16, 0, 0, 0, Math.PI * 0.5));
    it.strut('fabric', -0.12, 0.30, 0, 0.12, 0.30, 0, 0.035, 0.010);
    return it;
  };

  K.bucket = function () {
    var it = new Item();
    it.add('plastic', lathe([
      [0, 0], [0.105, 0], [0.115, 0.02], [0.150, 0.27], [0.158, 0.285],
      [0.146, 0.288], [0.138, 0.27], [0.104, 0.03], [0, 0.025]
    ], 12, 2, 1));
    it.strut('rust', -0.145, 0.27, 0, 0, 0.36, 0, 0.014, 0.014);
    it.strut('rust', 0.145, 0.27, 0, 0, 0.36, 0, 0.014, 0.014);
    return it;
  };

  K.plank = function (N, R) {
    var it = new Item();
    var g = bx(1.30, 0.035, 0.165, 0.006).clone();
    if (N) roughen(g, N, 0.008, 2.2);
    it.add('wood', g);
    it.box('rust', 0.020, 0.010, 0.020, -0.52, 0.021, 0.05);
    it.box('rust', 0.020, 0.010, 0.020, 0.48, 0.021, -0.04);
    return it;
  };

  // Fallen ceiling panel: a pressed sheet with a return lip, bent where it hit
  // the floor.  These came off the vault and they are the brief's own prop.
  K.panel = function (N, R, seed) {
    var it = new Item();
    var g = sheet(0.92, 0.60, 5, 3, 0.055, N, seed || 3.1);
    it.add('steel', g, Tn(0, 0.055, 0, 0, 0, 0));
    it.boxR('steel', 0.92, 0.035, 0.020, 0, 0.048, -0.29, 0.25, 0, 0);
    it.boxR('steel', 0.92, 0.035, 0.020, 0, 0.048, 0.29, -0.25, 0, 0);
    return it;
  };

  // Concrete rubble chunk.
  K.chunk = function (N, R) {
    var g = new THREE.IcosahedronGeometry(0.24, 0);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      p.setXYZ(i, p.getX(i) * 1.25, p.getY(i) * 0.68 + 0.16, p.getZ(i) * 1.05);
    }
    p.needsUpdate = true;
    if (N) roughen(g, N, 0.055, 4);
    var it = new Item();
    it.add('concrete', g);
    return it;
  };

  // Broken wall tile: a chip with a glazed face.  These bank against every pier
  // base in the station.
  K.shard = function (R) {
    var it = new Item();
    it.boxR('tile', 0.115, 0.014, 0.085, 0, 0.007, 0, 0, 0, 0, 0.003);
    return it;
  };

  K.rebar = function (R) {
    var it = new Item();
    var ax = -0.55, ay = 0.02, az = 0;
    for (var i = 0; i < 4; i++) {
      var bx2 = ax + R.range(0.22, 0.40);
      var by = ay + R.range(-0.02, 0.10);
      var bz = az + R.range(-0.10, 0.10);
      it.tube('rust', 0.011, ax, ay, az, bx2, by, bz, 5);
      ax = bx2; ay = by; az = bz;
    }
    return it;
  };

  K.bottle = function () {
    var it = new Item();
    it.add('plastic', lathe([
      [0, 0], [0.036, 0], [0.039, 0.02], [0.039, 0.135], [0.030, 0.165],
      [0.015, 0.185], [0.015, 0.225], [0.019, 0.232], [0.017, 0.240], [0, 0.240]
    ], 10, 2, 1));
    return it;
  };

  K.pipe = function () {
    var it = new Item();
    it.cyl('rust', 0.058, 0.058, 2.20, 0, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('rust', 0.070, 0.070, 0.06, -1.07, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('rust', 0.070, 0.070, 0.06, 1.07, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    return it;
  };

  // A hanging strap in a saloon.  Authored with y = 0 AT THE RAIL so the
  // animation can swing it about its own fixing.
  K.strap = function () {
    var it = new Item();
    it.box('rubber', 0.030, 0.26, 0.012, 0, -0.13, 0);
    var g = new THREE.TorusGeometry(0.055, 0.013, 5, 10);
    it.add('rubber', g, Tn(0, -0.31, 0, 0, 0, 0));
    it.box('steel', 0.024, 0.030, 0.024, 0, -0.008, 0);
    return it;
  };

  // Broken glass on the floor.
  K.glassShard = function (R) {
    var it = new Item();
    it.boxR('glass', 0.085, 0.005, 0.055, 0, 0.003, 0, 0, 0, 0, 0.02);
    return it;
  };

  // A weeping stalactite of dissolved lime under a cracked joint.  Authored
  // hanging DOWN from y = 0.
  K.stalactite = function (N) {
    var it = new Item();
    it.add('concrete', lathe([
      [0.062, 0], [0.048, -0.10], [0.030, -0.24], [0.016, -0.36],
      [0.007, -0.44], [0, -0.47]
    ], 8, 1, 1));
    return it;
  };

  // ---- maintenance kit -----------------------------------------------------

  K.toolbox = function () {
    var it = new Item();
    it.box('red', 0.46, 0.18, 0.21, 0, 0.09, 0, 0.010);
    it.box('red', 0.47, 0.055, 0.215, 0, 0.20, 0, 0.010);
    it.box('rust', 0.14, 0.028, 0.028, 0, 0.245, 0);
    it.box('rust', 0.028, 0.055, 0.030, -0.07, 0.225, 0);
    it.box('rust', 0.028, 0.055, 0.030, 0.07, 0.225, 0);
    it.box('rust', 0.05, 0.05, 0.024, 0, 0.155, 0.107);
    return it;
  };

  K.jerrycan = function () {
    var it = new Item();
    it.box('green', 0.175, 0.44, 0.34, 0, 0.22, 0, 0.016);
    for (var s = -1; s <= 1; s += 2) {
      it.boxR('green', 0.012, 0.34, 0.030, s * 0.088, 0.24, 0.07, 0, 0, 0.55);
      it.boxR('green', 0.012, 0.34, 0.030, s * 0.088, 0.24, -0.07, 0, 0, -0.55);
    }
    it.box('green', 0.14, 0.045, 0.10, 0, 0.455, -0.10);
    it.cyl('rust', 0.035, 0.035, 0.05, 0, 0.465, 0.09, 0, 0, 0, 8);
    return it;
  };

  K.hoseCoil = function () {
    var it = new Item();
    for (var i = 0; i < 3; i++) {
      var g = new THREE.TorusGeometry(0.30 - i * 0.055, 0.036, 5, 14);
      it.add('rubber', g, Tn(0, 0.038 + i * 0.055, 0, Math.PI * 0.5, i * 0.4, 0));
    }
    return it;
  };

  K.extinguisher = function () {
    var it = new Item();
    it.add('red', lathe([
      [0, 0], [0.078, 0.01], [0.082, 0.04], [0.082, 0.38], [0.070, 0.42],
      [0.030, 0.44], [0.026, 0.47], [0, 0.47]
    ], 10, 2, 1));
    it.cyl('rust', 0.030, 0.030, 0.05, 0, 0.495, 0, 0, 0, 0, 8);
    it.boxR('rust', 0.11, 0.020, 0.030, 0.045, 0.525, 0, 0, 0, -0.25);
    it.box('rust', 0.10, 0.035, 0.11, 0, 0.20, -0.085);
    return it;
  };

  // Trackside relay cabinet: louvred, padlocked, and weeping rust from the
  // hinge line.  These are the only vertical objects on a cess walkway.
  K.signalBox = function (R) {
    var it = new Item();
    it.box('green', 0.52, 1.05, 0.34, 0, 0.60, 0, 0.012);
    it.box('green', 0.56, 0.055, 0.38, 0, 1.15, 0);
    it.box('steel', 0.10, 0.10, 0.10, 0, 0.075, 0);
    for (var i = 0; i < 4; i++) {
      it.boxR('steel', 0.34, 0.022, 0.030, 0, 0.75 + i * 0.075, 0.176, 0.30, 0, 0);
    }
    it.box('rust', 0.030, 0.16, 0.030, -0.245, 0.90, 0.16);
    it.box('rust', 0.030, 0.16, 0.030, -0.245, 0.42, 0.16);
    it.box('rust', 0.055, 0.075, 0.030, 0.22, 0.66, 0.18);
    it.tube('cable', 0.030, 0.10, 0.06, -0.16, 0.10, 0.55, -0.16, 6);
    return it;
  };

  // ---- the obstructions ----------------------------------------------------
  // The 5 m walking corridor down 70 m of deck was completely bare: everything
  // _dressPlatform placed sat at backZ +/- 0.36, hard against the pier line, so
  // the level's own brief ("tight sightlines, hard corners") had not one
  // sightline break, one piece of cover or one thing to flank around on it -
  // and the firefight framing put an enemy upright in the open with nothing to
  // use. These four are staged ACROSS the walking line, not against a wall.

  // A platform advertising hoarding that has come off the arcade and fallen.
  // Authored already toppled - the tilt is in the geometry, not in a placement
  // euler - so its feet are on the deck and its top edge is 1.5 m up.
  K.hoarding = function (N, R) {
    var it = new Item();
    // 66 degrees off vertical, i.e. very nearly FLAT. At the 35 degrees the
    // first version used, the board's wide faces were near-vertical, so from
    // the overview gallery - which looks down the hall from 5.6 m up, the one
    // framing this prop exists for - all that was in shot was its blank back
    // edge, and it photographed as a black slab lying on the deck. Nearly flat,
    // its advertising face is what the camera sees, and the poster is authored
    // ON that face rather than hoped for.
    var W = 3.10, H = 2.05, tilt = 0.96;
    var ct = Math.cos(tilt), st = Math.sin(tilt);
    var s, i;
    // the board, buckled: five strakes each with its own small break
    for (i = 0; i < 5; i++) {
      var v = (i + 0.5) / 5 - 0.5;
      var by = 0.06 + (v + 0.5) * H * ct;
      var bz = (v + 0.5) * H * st;
      it.boxR('cream', W - Math.abs(v) * 0.10, 0.030, H / 5 + 0.01,
        R ? R.range(-0.03, 0.03) : 0, by, bz,
        -(Math.PI * 0.5 - tilt) + (R ? R.range(-0.03, 0.03) : 0), 0, 0);
    }
    // ---- the advertising face -------------------------------------------
    // The board's outward normal is (0, sin tilt, -cos tilt); a card built
    // facing +Z reaches it with a single rotation of (tilt - PI) about X, and
    // its own +Y then runs (0, -cos tilt, -sin tilt), which is what the centring
    // offset below undoes. Authored inside the item so the poster can never
    // drift off the board.
    var cw = W - 0.42, chh = H - 0.36;
    var uvp = cellUV(0);
    it.add('poster', card(cw, chh, uvp[0], uvp[1], uvp[2], uvp[3]),
      Tn(0.02,
        0.06 + 0.5 * H * ct + st * 0.024 + ct * chh * 0.5,
        0.5 * H * st - ct * 0.024 + st * chh * 0.5,
        tilt - Math.PI, 0, 0));
    // the angle-iron frame behind it, bent at one corner
    for (s = -1; s <= 1; s += 2) {
      it.strut('rust', s * (W * 0.5 - 0.06), 0.04, 0.0,
        s * (W * 0.5 - 0.10), 0.06 + H * ct, H * st, 0.055, 0.055);
    }
    it.strut('rust', -W * 0.5 + 0.06, 0.06 + H * ct * 0.55, H * st * 0.55,
      W * 0.5 - 0.06, 0.06 + H * ct * 0.55, H * st * 0.55, 0.045, 0.045);
    // the two legs it was standing on, sheared off at the base
    for (s = -1; s <= 1; s += 2) {
      it.strut('rust', s * (W * 0.5 - 0.30), 0.02, 0.02,
        s * (W * 0.5 - 0.44), 0.30, -0.34, 0.05, 0.05);
    }
    // the light fitting that was inside it, hanging out on its flex
    it.box('steel', 1.10, 0.09, 0.14, -0.55, 0.08 + H * ct * 0.92, H * st * 0.92);
    it.sag('cable', -1.05, 0.08 + H * ct * 0.92, H * st * 0.92,
      -1.45, 0.16, H * st * 0.55, 0.26, 0.020, 5);
    return it;
  };

  // A section of vault soffit panel still hanging by two of its hangers, at
  // chest height. The one obstruction in the level you have to duck under.
  K.hangPanel = function (N, R, drop) {
    var it = new Item();
    drop = drop || 3.2;
    var W = 2.30, D = 1.45;
    var i;
    // ---- BOXES, NOT A SHEET ------------------------------------------------
    // The first version used sheet(), which is a single-sided surface with its
    // normals up. Hanging at chest height it is seen from BELOW, so the panel
    // itself never drew and all that reached the frame was its two perimeter
    // tees - two bright straight bars floating in mid air with a black cable
    // slung between them, which is the "boxes standing in for objects" failure
    // with the boxes missing. Six bent strakes are closed solids: they read
    // from any side, they buckle, and the buckle is the whole silhouette.
    for (i = 0; i < 6; i++) {
      var v = (i + 0.5) / 6 - 0.5;                       // -0.42 .. 0.42
      var sag = -0.16 * Math.cos(v * Math.PI);           // the panel's own dish
      it.boxR('steel', W - Math.abs(v) * 0.22, 0.022, D / 6 + 0.012,
        (R ? R.range(-0.02, 0.02) : 0), sag, v * D,
        v * 0.62, (R ? R.range(-0.02, 0.02) : 0), (R ? R.range(-0.03, 0.03) : 0));
    }
    // the perimeter tee the panel was clipped into, twisted. Thin, and RUST -
    // as painted steel these read as two lit rails and out-competed the panel.
    it.strut('rust', -W * 0.5, -0.14, -D * 0.5, W * 0.5, -0.02, -D * 0.5 + 0.10, 0.022, 0.030);
    it.strut('rust', -W * 0.5, -0.20, D * 0.5, W * 0.5, -0.10, D * 0.5 - 0.08, 0.022, 0.030);
    // a torn corner, folded right back on itself
    it.boxR('steel', 0.62, 0.020, 0.48, W * 0.42, 0.06, -D * 0.34, -0.9, 0.4, 0.25);
    // the two hangers that held, and two cut ends that did not
    for (i = -1; i <= 1; i += 2) {
      it.tube('rust', 0.010, i * (W * 0.42), -0.02, i * (D * 0.30), i * (W * 0.42) + 0.12,
        drop, i * (D * 0.30) - 0.10, 5);
      it.tube('rust', 0.010, i * (W * 0.30), -0.04, -i * (D * 0.36),
        i * (W * 0.30) + 0.06, 0.38, -i * (D * 0.36) + 0.14, 5);
    }
    // cable that came down with it, still looped over the tee
    it.sag('cable', -W * 0.42, -0.02, -D * 0.20, W * 0.30, -0.06, D * 0.24, 0.55, 0.020, 6);
    return it;
  };

  // A barricade of platform seats: somebody dragged four benches into a line
  // across the deck and stacked two of them. Cover, and a story.
  K.seatStack = function (N, R) {
    var it = new Item();
    var b = K.bench(N, R);
    var keys = b.keys(), k, i;
    var LAY = [
      [-1.05, 0.0, 0.02, 0.06], [0.95, 0.0, -0.05, -0.04],
      [-0.55, 0.50, 1.62, 0.10], [0.60, 0.52, 1.58, -0.09]
    ];
    for (i = 0; i < LAY.length; i++) {
      var base = Tn(LAY[i][0], LAY[i][1], LAY[i][3] * 0.4, LAY[i][3] * 0.5, LAY[i][2], 0);
      for (k = 0; k < keys.length; k++) {
        var list = b.buckets[keys[k]];
        for (var q = 0; q < list.length; q++) {
          it.add(keys[k], list[q].geometry,
            new THREE.Matrix4().multiplyMatrices(base, list[q].matrix));
        }
      }
    }
    return it;
  };

  K.ladder = function (h) {
    var it = new Item();
    h = h || 2.6;
    for (var s = -1; s <= 1; s += 2) {
      it.box('rust', 0.045, h, 0.030, s * 0.21, h * 0.5, 0);
    }
    var n = Math.max(3, Math.round(h / 0.30));
    for (var i = 1; i < n; i++) {
      it.cyl('rust', 0.017, 0.017, 0.42, 0, i * (h / n), 0, 0, 0, Math.PI * 0.5, 6);
    }
    return it;
  };

  // Platform barrow: the thing a station porter shifted parcels on.
  K.trolley = function () {
    var it = new Item();
    it.box('steel', 1.00, 0.045, 0.60, 0, 0.30, 0);
    for (var s = -1; s <= 1; s += 2) {
      it.box('rust', 0.045, 0.28, 0.045, s * 0.44, 0.16, -0.26);
      it.box('rust', 0.045, 0.28, 0.045, s * 0.44, 0.16, 0.26);
      var g = new THREE.TorusGeometry(0.16, 0.045, 5, 12);
      it.add('rubber', g, Tn(s * 0.40, 0.16, 0.31, 0, Math.PI * 0.5, 0));
    }
    it.strut('rust', -0.48, 0.32, -0.26, -0.62, 0.92, -0.26, 0.035, 0.035);
    it.strut('rust', -0.48, 0.32, 0.26, -0.62, 0.92, 0.26, 0.035, 0.035);
    it.box('rust', 0.05, 0.05, 0.58, -0.62, 0.92, 0);
    return it;
  };

  // ---- the big one-offs ----------------------------------------------------

  // The pump set somebody rigged to fight the flood, and lost.  Skid frame,
  // motor, volute, discharge flange and a control box; the hose is run at
  // placement time so it can actually reach the water.
  K.pumpSet = function () {
    var it = new Item();
    it.box('rust', 1.15, 0.10, 0.66, 0, 0.05, 0);
    it.box('rust', 0.10, 0.16, 0.66, -0.52, 0.16, 0);
    it.box('rust', 0.10, 0.16, 0.66, 0.52, 0.16, 0);
    it.cyl('steel', 0.20, 0.20, 0.62, -0.16, 0.30, 0, 0, 0, Math.PI * 0.5, 14);
    it.cyl('steel', 0.115, 0.115, 0.14, 0.20, 0.30, 0, 0, 0, Math.PI * 0.5, 10);
    it.add('rust', lathe([
      [0, 0], [0.24, 0], [0.26, 0.06], [0.24, 0.28], [0.14, 0.34], [0, 0.34]
    ], 14, 2, 1), Tn(0.40, 0.12, 0, 0, 0, 0));
    it.cyl('rust', 0.085, 0.085, 0.22, 0.40, 0.50, 0, 0, 0, 0, 10);
    it.cyl('rust', 0.105, 0.105, 0.035, 0.40, 0.615, 0, 0, 0, 0, 10);
    it.box('green', 0.26, 0.34, 0.20, -0.42, 0.42, 0.16, 0.012);
    it.box('steel', 0.055, 0.055, 0.055, -0.42, 0.60, 0.16);
    return it;
  };

  // Generator set on skids, louvred one end, exhaust up the other.
  K.genset = function () {
    var it = new Item();
    it.box('green', 1.35, 0.72, 0.78, 0, 0.50, 0, 0.018);
    it.box('rust', 1.45, 0.14, 0.86, 0, 0.07, 0);
    it.box('green', 1.10, 0.075, 0.70, 0, 0.875, 0);
    for (var i = 0; i < 6; i++) {
      it.box('grate', 0.020, 0.44, 0.62, 0.60 + 0.0, 0.50, 0);
    }
    it.box('grate', 0.030, 0.46, 0.60, 0.676, 0.50, 0);
    it.cyl('rust', 0.055, 0.055, 0.55, -0.50, 1.10, -0.24, 0, 0, 0, 8);
    it.cyl('rust', 0.075, 0.075, 0.10, -0.50, 1.36, -0.24, 0, 0, 0, 8);
    it.cyl('steel', 0.075, 0.075, 0.05, 0.28, 0.90, 0.20, 0, 0, 0, 8);
    it.box('steel', 0.24, 0.16, 0.12, -0.10, 0.72, 0.395);
    return it;
  };

  // Scaffold tower under the collapse: four standards, ledgers, two boards, a
  // ladder up one face.  The only vertical structure a props file adds to a
  // level whose ceiling is the story.
  K.scaffold = function (h) {
    var it = new Item();
    h = h || 2.85;
    var HW = 0.72, HD = 0.55;
    var s, k, i;
    for (s = -1; s <= 1; s += 2) {
      for (k = -1; k <= 1; k += 2) {
        it.cyl('rust', 0.026, 0.026, h, s * HW, h * 0.5, k * HD, 0, 0, 0, 16);
        it.box('rust', 0.14, 0.020, 0.14, s * HW, 0.010, k * HD);
      }
    }
    for (i = 1; i <= 3; i++) {
      var ly = i * (h / 3.4);
      for (s = -1; s <= 1; s += 2) {
        it.cyl('rust', 0.022, 0.022, HD * 2, s * HW, ly, 0, Math.PI * 0.5, 0, 0, 14);
      }
      for (k = -1; k <= 1; k += 2) {
        it.cyl('rust', 0.022, 0.022, HW * 2, 0, ly, k * HD, 0, 0, Math.PI * 0.5, 14);
      }
    }
    it.strut('rust', -HW, 0.05, -HD, HW, h * 0.62, -HD, 0.024, 0.024);
    it.strut('rust', HW, 0.05, HD, -HW, h * 0.62, HD, 0.024, 0.024);
    for (i = 0; i < 3; i++) {
      it.boxR('wood', HW * 2 - 0.06, 0.032, 0.30, 0, h * 0.885, -0.32 + i * 0.32,
        0, 0, 0.004);
    }
    // ------------------------------------------------------------------------
    // WHAT IS ON THE DECK, and why it is not optional.
    //
    // This tower stands in the vent shaft's beam - the one column of light in
    // the level - so its boards are lit from directly above and measured 0.635
    // mean, 2.6x the hero1 frame mean and brighter than every lit fitting in
    // the frame except the emitters themselves. A broad pale horizontal plane in
    // the beam is the OPPOSITE of the silhouette the placement comment promises.
    //
    // The fix is not to dim the boards - a scaffold board really is pale timber
    // and the beam really does land on it - it is to put something ON them. A
    // sheet of polythene weighted at the corners covers two thirds of the deck,
    // a coil of hose hangs over the edge and a stack of boards stands on end
    // against the guard rail. All three break the plane, all three are what a
    // working gang actually leaves, and together they turn the brightest
    // horizontal in the frame into a legible cluster of objects.
    // ------------------------------------------------------------------------
    var dy = h * 0.885 + 0.020;
    for (i = 0; i < 5; i++) {
      var sw = HW * 2 - 0.10;
      // the sheet sags between the boards and lifts at the free corner
      var sag = Math.sin((i + 0.5) / 5 * Math.PI) * 0.035;
      it.boxR('fabric', sw, 0.012, 0.20, 0.03, dy + 0.014 - sag,
        -0.42 + i * 0.20, 0, 0, (i - 2) * 0.010);
    }
    // the free corner lifted and folded back on itself
    it.boxR('fabric', HW * 1.1, 0.011, 0.34, -0.18, dy + 0.10, 0.50, 0.34, 0.22, -0.16);
    it.boxR('fabric', HW * 0.7, 0.011, 0.26, 0.42, dy + 0.05, 0.44, -0.20, -0.30, 0.10);
    // a coil of hose hung over the deck edge and hanging down the outside
    for (i = 0; i < 7; i++) {
      var ha = i / 7 * TAU;
      it.tube('cable', 0.030,
        HW - 0.06 + Math.cos(ha) * 0.16, dy + 0.06 + Math.sin(ha) * 0.14, -0.30,
        HW - 0.06 + Math.cos(ha + 0.95) * 0.16, dy + 0.06 + Math.sin(ha + 0.95) * 0.14, -0.30, 6);
    }
    it.sag('cable', HW - 0.06, dy + 0.02, -0.30, HW + 0.10, dy - 0.85, -0.42, 0.30, 0.030, 6);
    it.sag('cable', HW + 0.10, dy - 0.85, -0.42, HW - 0.22, 0.06, -0.60, 0.24, 0.030, 6);
    // boards stood on end against the guard rail - a vertical against a
    // horizontal, which is the whole point
    for (i = 0; i < 4; i++) {
      it.boxR('wood', 0.036, 1.35, 0.19, -HW + 0.14 + i * 0.055, dy + 0.70, -HD + 0.16,
        0.05 + i * 0.012, 0.03, -0.10 - i * 0.02);
    }
    // and the guard rail they lean on
    it.cyl('rust', 0.022, 0.022, HW * 2, 0, dy + 0.98, -HD, 0, 0, Math.PI * 0.5, 14);
    it.cyl('rust', 0.022, 0.022, HW * 2, 0, dy + 0.52, -HD, 0, 0, Math.PI * 0.5, 14);
    for (k = -1; k <= 1; k += 2) {
      it.cyl('rust', 0.024, 0.024, 1.06, k * HW, dy + 0.53, -HD, 0, 0, 0, 14);
    }
    return it;
  };

  // The kiosk.  Closed since the day the station shut: shutter down, fascia
  // rotted, side wall three posters deep.
  K.kiosk = function (N, R) {
    var it = new Item();
    var W = 2.45, D = 1.45, H = 2.35;
    var s, i;
    it.box('concrete', W + 0.14, 0.12, D + 0.14, 0, 0.06, 0);
    // frame posts
    for (s = -1; s <= 1; s += 2) {
      for (i = -1; i <= 1; i += 2) {
        it.box('steel', 0.09, H, 0.09, s * (W * 0.5 - 0.03), H * 0.5 + 0.10, i * (D * 0.5 - 0.03));
      }
    }
    // back and sides
    it.box('steel', W, H - 0.16, 0.06, 0, H * 0.5 + 0.12, -D * 0.5);
    it.box('steel', 0.06, H - 0.16, D, -W * 0.5, H * 0.5 + 0.12, 0);
    it.box('steel', 0.06, H - 0.16, D, W * 0.5, H * 0.5 + 0.12, 0);
    // the counter front with the shutter down over it
    it.box('steel', W, 0.75, 0.10, 0, 0.50, D * 0.5);
    for (i = 0; i < 16; i++) {
      it.box('rust', W - 0.10, 0.055, 0.045, 0, 0.92 + i * 0.072, D * 0.5 + 0.02);
    }
    it.box('rust', W - 0.06, 0.075, 0.075, 0, 2.10, D * 0.5 + 0.03);
    // counter shelf and fascia
    it.box('wood', W + 0.10, 0.055, 0.34, 0, 0.90, D * 0.5 + 0.13);
    it.box('green', W + 0.16, 0.34, D + 0.16, 0, 2.35, 0);
    it.box('cream', W + 0.06, 0.10, D + 0.20, 0, 2.14, 0);
    // canopy over the counter
    it.boxR('steel', W + 0.20, 0.045, 0.50, 0, 2.05, D * 0.5 + 0.26, 0.12, 0, 0);
    it.strut('rust', -W * 0.4, 2.28, D * 0.5, -W * 0.4, 2.02, D * 0.5 + 0.46, 0.024, 0.024);
    it.strut('rust', W * 0.4, 2.28, D * 0.5, W * 0.4, 2.02, D * 0.5 + 0.46, 0.024, 0.024);
    return it;
  };

  // Ticket machine.  Sloped fascia, dead screen, coin tray, jemmied open.
  K.ticketMachine = function (R) {
    var it = new Item();
    it.box('steel', 0.62, 0.10, 0.46, 0, 0.05, 0);
    it.box('green', 0.58, 1.28, 0.42, 0, 0.72, 0, 0.014);
    it.boxR('green', 0.58, 0.44, 0.10, 0, 1.42, 0.10, -0.42, 0, 0);
    it.boxR('glass', 0.34, 0.24, 0.02, 0, 1.45, 0.155, -0.42, 0, 0);
    it.box('steel', 0.30, 0.10, 0.030, 0, 1.20, 0.215);
    it.box('steel', 0.22, 0.075, 0.030, 0, 0.52, 0.215);
    it.box('rust', 0.10, 0.030, 0.030, 0.18, 0.86, 0.215);
    it.box('green', 0.60, 0.075, 0.44, 0, 1.60, 0);
    return it;
  };

  // Turnstile: pedestal, a cream capping, and a tripod with one arm bent.
  //
  // The arms are the whole read of this object and they were built too thin and
  // in rust the first time - at three metres, under a worklight, a 26 mm dark
  // tube against a dark hall is nothing at all, and a row of gates photographed
  // as a row of concrete blocks.  35 mm in the pale steel catches the beam.
  K.turnstile = function (R) {
    var it = new Item();
    // MEASURED, twice.  This row stands a couple of metres from the escalator
    // hall's rigged worklight, and it is the only prop in the level big enough
    // and close enough to a source to blow the frame out on its own: in pale
    // steel it took the hero3 framing from 1.0% clipped pixels to 3.1%, which
    // reads as a row of glowing white bollards.  Corroded steel for every large
    // face, pale steel kept for the arms alone - they are the read, they are
    // thin, and they cost 0.3%.
    it.box('green', 0.34, 0.90, 0.62, 0, 0.45, 0, 0.014);
    it.box('rust', 0.36, 0.10, 0.64, 0, 0.95, 0, 0.012);
    it.box('rust', 0.30, 0.045, 0.56, 0, 1.02, 0);
    it.cyl('rust', 0.080, 0.080, 0.16, 0.14, 1.06, 0, 0, 0, Math.PI * 0.5, 10);
    for (var k = 0; k < 3; k++) {
      var a = k / 3 * TAU + (R ? R.range(0, 0.6) : 0.2);
      it.tube('steel', 0.035, 0.22, 1.06, 0, 0.22 + Math.cos(a) * 0.03, 1.06 + Math.sin(a) * 0.50,
        Math.cos(a) * 0.50, 7);
      it.cyl('steel', 0.045, 0.045, 0.05, 0.22 + Math.cos(a) * 0.03, 1.06 + Math.sin(a) * 0.50,
        Math.cos(a) * 0.50, 0, 0, Math.PI * 0.5, 7);
    }
    it.box('red', 0.10, 0.035, 0.18, 0, 1.05, -0.22);
    it.box('rust', 0.30, 0.06, 0.58, 0, 0.03, 0);
    return it;
  };

  // Wall telephone in its acoustic hood.
  K.phone = function () {
    var it = new Item();
    it.box('steel', 0.44, 0.60, 0.24, 0, 0.30, 0, 0.012);
    it.boxR('steel', 0.50, 0.30, 0.26, 0, 0.70, 0.02, 0.22, 0, 0);
    it.box('green', 0.30, 0.34, 0.030, 0, 0.34, 0.125);
    it.box('rust', 0.075, 0.22, 0.075, -0.14, 0.34, 0.14);
    it.sag('cable', -0.14, 0.26, 0.16, 0.02, 0.10, 0.13, 0.10, 0.014, 4);
    return it;
  };

  // Merge several of an Item's buckets into one geometry.  A suitcase's corner
  // caps are steel and its shell is fibre, but eight suitcases do not justify
  // two draw calls, so the minor bucket rides with the major one.
  function mergeKeys(item, keys) {
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var b = item.buckets[keys[i]];
      if (b && b.length) parts = parts.concat(b);
    }
    if (!parts.length) return null;
    return mergeParts(parts);
  }

  // A plain albedo multiplier for the local canvas-textured cards (litter,
  // posters, stains).  Those materials have no wear shader, so a WEAR MASK
  // written into their colour attribute would be multiplied straight onto
  // albedo and every poster would come back three shades of mud.  This writes
  // an honest, gentle multiplier instead: darker and greener toward the base,
  // where the damp is.
  function paintCard(geo, noise, base, damp) {
    var p = geo.attributes.position;
    if (!p) return geo;
    base = base === undefined ? 0.86 : base;
    damp = damp === undefined ? 0.34 : damp;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      var n = noise ? (noise.fbm3(p.getX(i) * 3.1, y * 3.1, p.getZ(i) * 3.1, 2, 2.1, 0.5) * 0.5 + 0.5) : 0.5;
      var lo = 1 - damp * M.saturate(1 - y * 1.4);
      var v = M.saturate(base * lo * (0.86 + n * 0.28));
      c[i * 3] = v;
      c[i * 3 + 1] = v * (0.98 - 0.06 * (1 - lo));
      c[i * 3 + 2] = v * (0.94 - 0.10 * (1 - lo));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // 2x2 atlas cell -> uv rectangle, with a half-texel inset so a mip does not
  // bleed the neighbouring cell into a card's torn edge.
  function cellUV(cell, eps) {
    eps = eps === undefined ? 0.004 : eps;
    var cx = cell % 2, cyc = (cell / 2) | 0;
    var u0 = cx * 0.5 + eps, v0 = 1 - (cyc + 1) * 0.5 + eps;
    return [u0, v0, u0 + 0.5 - eps * 2, v0 + 0.5 - eps * 2];
  }

  // ==========================================================================
  // GAME.PropsMetro
  // ==========================================================================
  function PropsMetro(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_metro';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's stream, so adding a
    // lamp somewhere else cannot reshuffle the platform.
    var seed = ((this.ctx.seed || 20260801) ^ 0x4D54524F) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    // The draught. A deep tube is never still - it breathes along its own axis -
    // and this is the only environmental motion in a level with no weather.
    this.draught = 0.45;
    this.windDir = new THREE.Vector2(1, 0);

    this.tex = {};
    this.mats = {};
    this.B = {};
    this.S = {
      steel: [], rust: [], wood: [], concrete: [], tile: [], plastic: [],
      rubber: [], fabric: [], grate: [], glass: [], red: [], green: [],
      cream: [], cable: [], poster: [], sign: [], stain: []
    };
    this._occ = new Map();
    this._skipped = 0;
    this._keepOut = [];
    this._straps = [];
    this._rafts = [];
    this._rings = [];
    this._dripParts = [];
    this._stainCount = 0;
    this._scumCount = 0;

    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Fallbacks for every anchor this file reads.  They are the level's own
    // published numbers, and they exist so that a level which failed to build
    // does not take the props pass down with it - never as a source of truth.
    this.hall = { x0: -40, x1: 30, platY: 1.10, trackY: 0, waterY: 0.26,
      edgeZ: 5.15, hallHz: 9.80, crown: 6.60, spring: 4.20 };
    this.plat = { hz: 5.15, y: 1.10, walkHz: 4.10, backZ: 4.25 };
    this.piersX = [-33, -27, -21, -15, -9, -3, 3, 9, 15, 21];
    this.brokenX = [-3, 3];
    this.trkCz = 6.60;
    this.tunW = { portalX: -41.2, endX: -72, cz: [-6.6, 6.6], walkwayY: 0.62, invertY: -0.12 };
    this.tunE = { portalX: 31.2, endX: 54, cz: [-6.6, 6.6], walkwayY: 0.62, invertY: -0.12 };
    this.esc = { x0: 30, x1: 58, hz: 6.20, footY: 1.10, headY: 8.60, incX0: 39, incX1: 52 };
    this.bal = { x0: 27.4, x1: 31.6, hz: 3.40, y: 3.90 };
    this.vent = { x: -9, z: 3.2, r: 1.35 };
    this.collapse = { x0: -8.5, x1: 1.5, z0: -5.15, z1: -1.20 };
    this.cross = { x: -21 };
    this.cars = [];
    this.lamps = [];
    this.bounds = { x0: -74, x1: 60, z0: -10.6, z1: 10.6 };

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsM.ctor', e); }
  }

  PropsMetro.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsM.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsMetro.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // The work site FIRST.  The gang's plant needs three clear metres and it is
    // the level's story; running it after the passenger clutter had filled the
    // platform meant the pump and the tower simply never landed.
    await this._phase('worksite', this._dressWorkSite);
    await this._phase('platform', this._dressPlatform);
    // The staged obstructions go in BEFORE the signage and after the platform
    // furniture: they need the walking line clear of the pier-line dressing but
    // they must claim their footprint before the litter drifts are scattered.
    await this._phase('obstructions', this._dressObstructions);
    await this._phase('signage', this._dressSignage);
    await this._phase('wreck', this._dressWreck);
    await this._phase('tracks', this._dressTrackHalls);
    await this._phase('tunnels', this._dressTunnels);
    await this._phase('escalator', this._dressEscalator);
    await this._phase('gallery', this._dressGallery);
    await this._phase('saloon', this._dressSaloon);
    await this._phase('water', this._dressWater);
    await this._phase('drift', this._dressDrift);
    await this._phase('weeps', this._dressWeeps);
    await this._phase('commit', this._commit);
    clearCaches();
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsMetro.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;

    var grunge = TX.grunge(256, 0x4D31, 1.15);
    this._grunge = grunge;
    if (grunge) t.grungeN = TX.normalFromHeight(TX.heightFromCanvas(grunge), 256, 1.0);

    t.poster = TX.tex(TX.posters(512, 0x11), true, 1, 1, aniso, true);
    t.sign = TX.tex(TX.signs(512, 0x21), true, 1, 1, aniso, true);
    t.litter = TX.tex(TX.litter(512, 0x31), true, 1, 1, aniso, true);
    t.scum = TX.tex(TX.scum(256, 0x41), true, 1, 1, aniso, true);
    t.stain = TX.tex(TX.stains(512, 0x51), true, 1, 1, aniso, true);
    t.drip = TX.tex(TX.drip(64, 256, 0x61), true, 1, 1, aniso);
    if (t.drip) { t.drip.wrapS = THREE.ClampToEdgeWrapping; t.drip.wrapT = THREE.RepeatWrapping; }
  };

  // --------------------------------------------------------------------------
  // Materials
  //
  // Everything from the library is CLONED - mutating a cached library material
  // would corrupt it for level_metro.js and every other consumer.
  //
  // Every prop material declares the same two things, and they are what make
  // the set read as one flooded room rather than as a kit of objects standing
  // in one: `wearColor` (the substrate the B channel exposes) is a wet grey
  // rather than the library's default pale beige - bleached driftwood is the
  // one thing timber that has stood in water for years is not - and the wear
  // mask is painted with the capillary gradient in paintWear.
  // --------------------------------------------------------------------------
  PropsMetro.prototype._material = function (name, opts) {
    opts = opts || {};
    var lib = this.ctx.materials;
    var mat = null;
    try {
      if (lib && lib.get) {
        var want = name;
        if (lib.has && !lib.has(name)) want = 'painted_metal';
        var m = lib.get(want, opts);
        // clone() is overridden by materials.js to preserve its shader work, so
        // any local chaining must be applied AFTER this call, never before.
        if (m && m.clone) mat = m.clone();
      }
    } catch (e) { GAME.logError('propsM.mat:' + name, e); }
    if (!mat) mat = this._fallbackMaterial(name, opts);
    mat.name = 'mt_' + name;
    return mat;
  };

  var FALLBACK_SPEC = {
    painted_metal: [0x7b8288, 0.54, 0.55],
    rusted_metal: [0x6e4736, 0.82, 0.42],
    wood_plank: [0x6f6152, 0.92, 0.0],
    concrete: [0x8a877e, 0.94, 0.0],
    tile: [0xa8a89a, 0.42, 0.0],
    plastic: [0x8a8578, 0.55, 0.0],
    rubber: [0x2a2c2d, 0.86, 0.0],
    sandbag: [0x7d7663, 0.95, 0.0],
    fabric: [0x7d7663, 0.95, 0.0],
    steel_grate: [0x4c4944, 0.70, 0.66],
    glass: [0x2a3230, 0.16, 0.0]
  };

  PropsMetro.prototype._fallbackMaterial = function (name, opts) {
    var s = FALLBACK_SPEC[name] || FALLBACK_SPEC.painted_metal;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(s[0], THREE.SRGBColorSpace),
      roughness: s[1], metalness: s[2], envMapIntensity: 1.0
    });
    // No wear shader on this path, so a wear MASK would be multiplied straight
    // onto albedo and every prop would come out three shades too dark.
    if (opts && opts.side !== undefined) m.side = opts.side;
    if (opts && opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
    if (this.tex.grungeN) { m.normalMap = this.tex.grungeN; m.normalScale = new THREE.Vector2(0.55, 0.55); }
    return m;
  };

  PropsMetro.prototype._initMaterials = function () {
    var m = this.mats;
    function W(extra) {
      var o = { vertexColors: true, wearMode: 'wear' };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return o;
    }
    // WET GREY, not pale beige.  See the header on _initMaterials.
    var SUB_DIELECTRIC = 0x8d8a80;
    var SUB_TIMBER = 0x6b6459;

    // ---- ONE HONEST SET OF METALS, SHARED WITH level_metro.js -------------
    // The previous pass capped every metal here at 0.18-0.26 because the sealed
    // probe left a conductor with nothing to return, and the LEVEL meanwhile
    // ran the same families at 0.62-0.90 - so in hero1 the scaffold (this file)
    // and the train (that one) stood a metre apart with two different, both
    // wrong, metal responses.  0.2-0.3 is the worst of the two: it is neither
    // dielectric nor conductor and always photographs as plastic.
    //
    // level_metro.js now raises scene.environmentIntensity 5x in its update, so
    // a conductor HAS something to return, and both files sit on one split:
    //     painted enamel -> metalness 0.0, roughness 0.40-0.45
    //     bare / galvanised / oxidised steel -> 0.85-0.90, roughness 0.55-0.75
    // Nothing in between.
    //
    // normalScale is also pulled back across the set.  With the probe raised,
    // every library bump detail became its own specular glint: the 0.58 m drum
    // in the hero1 foreground photographed as a chocolate-chip log and the
    // barrier rail beside the rubble as coral.  A prop under a metre across is
    // carried by its silhouette and its specular streak, not by its bump.
    m.steel = this._material('painted_metal',
      W({ albedoTarget: 0x8d9498, roughness: 0.44, metalness: 0.0,
        normalScale: 0.42, envMapIntensity: 1.15, detail: 0.36, meso: 0.35 }));
    m.rust = this._material('rusted_metal',
      W({ albedoTarget: 0x76503c, roughness: 0.80, metalness: 0.86,
        normalScale: 0.58, envMapIntensity: 1.30, detail: 0.42, meso: 0.40 }));
    m.wood = this._material('wood_plank',
      W({ albedoTarget: 0x6d6053, roughness: 0.93, wearColor: SUB_TIMBER,
        normalScale: 0.72, detail: 0.50 }));
    m.concrete = this._material('concrete',
      W({ albedoTarget: 0x7a7770, roughness: 0.94, wearColor: SUB_DIELECTRIC,
        normalScale: 0.70, detail: 0.45, meso: 0.40 }));
    m.tile = this._material('tile',
      W({ albedoTarget: 0xa4a496, roughness: 0.40, wearColor: SUB_DIELECTRIC,
        normalScale: 0.46, detail: 0.38 }));
    m.plastic = this._material('plastic',
      W({ albedoTarget: 0x8a8578, roughness: 0.56, wearColor: SUB_DIELECTRIC,
        normalScale: 0.40, detail: 0.34 }));
    m.rubber = this._material('rubber',
      W({ albedoTarget: 0x2b2d2e, roughness: 0.86 }));
    m.cable = this._material('rubber',
      W({ albedoTarget: 0x23252a, roughness: 0.88 }));
    m.fabric = this._material('sandbag',
      W({ albedoTarget: 0x796f5c, roughness: 0.96, wearColor: 0x8b8474 }));
    m.grate = this._material('steel_grate',
      W({ side: THREE.DoubleSide, alphaTest: 0.5 }));
    // The three paint lots.  Soviet transport livery is a very short palette -
    // a sickly institutional green, an oxide red for anything to do with fire,
    // and a bone cream for signage grounds - and running the props through
    // exactly those three is what ties them to the station's own dado band
    // instead of introducing a second, unrelated colour story.
    m.green = this._material('painted_metal',
      W({ albedoTarget: 0x5a6a4c, roughness: 0.60, metalness: 0.0, normalScale: 0.40, detail: 0.32 }));
    m.red = this._material('painted_metal',
      W({ albedoTarget: 0x8a3a2c, roughness: 0.56, metalness: 0.0, normalScale: 0.40, detail: 0.32 }));
    m.cream = this._material('painted_metal',
      W({ albedoTarget: 0xa79f8b, roughness: 0.52, metalness: 0.0, normalScale: 0.40, detail: 0.32 }));
    // Hazard orange, and the only warm saturated thing on the platform.  In a
    // hall lit entirely by green fluorescents and red emergency gear it is what
    // separates "somebody cordoned this off" from "there is rubbish here" - and
    // a grey cone under a green tube photographs as a lump of concrete, which
    // is what the first capture came back with.
    m.orange = this._material('plastic',
      W({ albedoTarget: 0x9c4a1e, roughness: 0.58, wearColor: 0xc0b6a2,
        normalScale: 0.38 }));
    // Pale worn strap plastic.  The saloon's whole upper half is black - its
    // only sources are two emissive ceiling runs that light nothing - and the
    // straps are the only props up there, so they are the only thing that can
    // put any value in the top of that framing.  Dark rubber straps measured
    // 18.7% dead cells; pale ones are what a forty-year-old car actually has.
    m.strap = this._material('plastic',
      W({ albedoTarget: 0x9e978a, roughness: 0.62, wearColor: 0xb4ada0 }));

    try {
      m.glass = (this.ctx.materials && this.ctx.materials.glass)
        ? this.ctx.materials.glass({ tint: 0x28312e, roughness: 0.14 })
        : null;
    } catch (e) { m.glass = null; }
    if (!m.glass) {
      m.glass = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x28312e, THREE.SRGBColorSpace),
        roughness: 0.16, metalness: 0.10, envMapIntensity: 1.5
      });
    }

    // ---- local canvas art ---------------------------------------------------
    // ---- ONE-SIDED, AND THAT IS THE POINT ---------------------------------
    // Both of these were DoubleSide, so a plate whose quad had been oriented
    // from the wrong wall normal did not fail - it quietly printed its legend
    // MIRRORED, and at least one of them did exactly that in a published hero
    // frame.  The invented twelve-glyph alphabet exists specifically to avoid a
    // font lottery, and a Soviet-era metro sign that reads as garbled backwards
    // English is a worse failure than tofu boxes would have been.
    //
    // FrontSide makes the defect loud: a wrong-facing plate disappears, which
    // shows up in a capture immediately.  Every call site now goes through
    // _wallCard(), which takes the wall's outward normal rather than a yaw, and
    // every one of them was re-derived from the surface it is pasted to.
    m.poster = new THREE.MeshStandardMaterial({
      map: this.tex.poster || null, color: 0xffffff,
      roughness: 0.88, metalness: 0.0, vertexColors: true,
      side: THREE.FrontSide, alphaTest: 0.34, envMapIntensity: 0.9,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.poster.name = 'mt_poster';

    m.sign = new THREE.MeshStandardMaterial({
      map: this.tex.sign || null, color: 0xffffff,
      roughness: 0.44, metalness: 0.0, vertexColors: true,
      side: THREE.FrontSide, alphaTest: 0.34, envMapIntensity: 1.15,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.sign.name = 'mt_sign';

    m.litter = new THREE.MeshStandardMaterial({
      map: this.tex.litter || null, color: 0xffffff,
      roughness: 0.72, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, alphaTest: 0.40, envMapIntensity: 0.9
    });
    m.litter.shadowSide = THREE.DoubleSide;
    m.litter.name = 'mt_litter';

    // Scum: a translucent biofilm lying ON the water, so it must not write
    // depth or it z-fights the level's own flood sheet, which is 8 mm below it.
    m.scum = new THREE.MeshStandardMaterial({
      map: this.tex.scum || null, color: 0xffffff,
      roughness: 0.30, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      alphaTest: 0.02, envMapIntensity: 1.2
    });
    m.scum.name = 'mt_scum';

    m.stain = new THREE.MeshStandardMaterial({
      map: this.tex.stain || null, color: 0xffffff,
      roughness: 0.70, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      alphaTest: 0.02, envMapIntensity: 0.8,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    m.stain.name = 'mt_stain';

    // Falling water, additive and faint.  A drip lit by a failing fluorescent
    // is a highlight on a thread of water, never a white bar.
    m.drip = new THREE.MeshBasicMaterial({
      map: this.tex.drip || null, color: 0xffffff,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, opacity: 0.55, fog: true
    });
    m.drip.name = 'mt_drip';

    m.ripple = new THREE.MeshBasicMaterial({
      map: this.tex.scum || null, color: 0xbfd0c2,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, opacity: 0.30, fog: true
    });
    m.ripple.name = 'mt_ripple';
  };

  // --------------------------------------------------------------------------
  // Layout: read the level's published survey.  Nothing here reads a camera
  // pose except _keepOut, which is a keep-out list and never a placement.
  // --------------------------------------------------------------------------
  PropsMetro.prototype._probeLayout = function () {
    var lv = this.ctx.level;
    var A = (lv && lv.anchors) || null;
    this.A = A;
    var i;

    if (A) {
      if (A.hall) {
        this.hall = {
          x0: A.hall.x0, x1: A.hall.x1, platY: A.hall.platY, trackY: A.hall.trackY,
          waterY: A.hall.waterY, edgeZ: A.hall.edgeZ, hallHz: A.hall.hallHz,
          crown: A.hall.crown, spring: A.hall.spring
        };
      }
      if (A.platform) {
        this.plat = {
          hz: A.platform.hz, y: A.platform.y,
          walkHz: A.platform.walkHz !== undefined ? A.platform.walkHz : A.platform.hz - 1.05,
          backZ: A.arcadeS ? A.arcadeS.backZ : A.platform.hz - 0.9,
          x0: A.platform.x0, x1: A.platform.x1
        };
      }
      if (A.arcadeN) {
        if (A.arcadeN.piersX && A.arcadeN.piersX.length) this.piersX = A.arcadeN.piersX.slice();
        if (A.arcadeN.brokenX) this.brokenX = A.arcadeN.brokenX.slice();
        if (A.arcadeN.backZ !== undefined) this.plat.backZ = Math.abs(A.arcadeN.backZ);
      }
      if (A.trackS && A.trackS.cz !== undefined) this.trkCz = Math.abs(A.trackS.cz);
      if (A.tunnelW) this.tunW = A.tunnelW;
      if (A.tunnelE) this.tunE = A.tunnelE;
      if (A.escalator) this.esc = A.escalator;
      if (A.balcony) {
        this.bal = { x0: A.balcony.x0, x1: A.balcony.x1, hz: A.balcony.hz, y: A.balcony.y };
      }
      if (A.ventShaft && A.ventShaft.centre) {
        this.vent = { x: A.ventShaft.centre.x, z: A.ventShaft.centre.z, r: A.ventShaft.r };
      }
      if (A.collapse) {
        this.collapse = { x0: A.collapse.x0, x1: A.collapse.x1, z0: A.collapse.z0, z1: A.collapse.z1,
          rubble: A.collapse.rubble || null };
      }
      if (A.crossPassage) this.cross = { x: A.crossPassage.x };
      if (A.train && A.train.cars) this.cars = A.train.cars;
      if (A.train) { this.trainNose = A.train.nose; this.trainImpact = A.train.impact; }
      if (A.lamps) this.lamps = A.lamps;
    }
    this.waterY = this.hall.waterY;
    this.bounds = {
      x0: Math.min(this.tunW.endX, this.hall.x0) - 2,
      x1: Math.max(this.esc.x1, this.tunE.endX) + 2,
      z0: -this.hall.hallHz - 0.8, z1: this.hall.hallHz + 0.8
    };

    // Broadphase over the level's colliders so nothing lands inside a pier, the
    // wreck, or the escalator truss.
    try {
      if (lv && lv.colliders && lv.colliders.length) {
        this.hash = new GAME.SpatialHash(5.0);
        var mn = new THREE.Vector3(), mx = new THREE.Vector3();
        for (i = 0; i < lv.colliders.length; i++) {
          var c = lv.colliders[i];
          GAME.Collision.boxBounds(c, mn, mx);
          this.hash.insert(c, mn, mx);
        }
      }
    } catch (e) { GAME.logError('propsM.hash', e); this.hash = null; }

    // Camera eyes and spawn points: a KEEP-OUT list.  A prop inside the lens is
    // the one placement error a capture cannot recover from.
    this._keepOut = [];
    try {
      var poses = (lv && lv.cameraPoses) || null;
      var seen = {};
      for (var key in poses) {
        if (!Object.prototype.hasOwnProperty.call(poses, key)) continue;
        var p = poses[key];
        if (!p || !p.position || !isFinite(p.position.x)) continue;
        var sk = p.position.x.toFixed(2) + ',' + p.position.z.toFixed(2);
        if (seen[sk]) continue;
        seen[sk] = 1;
        this._keepOut.push({ x: p.position.x, z: p.position.z, r: 1.45 });
      }
      var sp = (lv && lv.spawnPoints) || null;
      if (sp) {
        for (i = 0; i < sp.length; i++) {
          if (sp[i] && sp[i].position) {
            this._keepOut.push({ x: sp[i].position.x, z: sp[i].position.z, r: 0.95 });
          }
        }
      }
    } catch (e2) { /* poses are optional */ }
  };

  // --------------------------------------------------------------------------
  // Placement primitives
  // --------------------------------------------------------------------------

  // The station's floors are analytic and the level publishes them, so
  // sampleGround is both cheaper and more accurate than a ray.  The ray is for
  // anything standing on a STRUCTURE - the gallery slab, a cess walkway, the
  // saloon floor - where the analytic ground is the thing underneath it.
  PropsMetro.prototype._ground = function (x, z) {
    var lv = this.ctx.level;
    if (lv && lv.sampleGround) {
      try {
        var s = lv.sampleGround(x, z);
        if (isFinite(s)) return s;
      } catch (e) { /* fall through */ }
    }
    if (this.A && this.A.hall && this.A.hall.groundY) {
      try {
        var g = this.A.hall.groundY(x, z);
        if (isFinite(g)) return g;
      } catch (e2) { /* fall through */ }
    }
    return this.hall.platY;
  };

  PropsMetro.prototype._rayGround = function (x, z, fromY, maxDist, fallback) {
    var lv = this.ctx.level;
    if (lv && lv.raycast) {
      try {
        _rayO.set(x, fromY, z);
        _rayD.set(0, -1, 0);
        var r = lv.raycast(_rayO, _rayD, maxDist === undefined ? 6 : maxDist);
        if (r && r.hit && r.point && isFinite(r.point.y)) return r.point.y;
      } catch (e) { /* degrade */ }
    }
    return fallback === undefined ? this._ground(x, z) : fallback;
  };

  // Does level geometry already occupy this sphere?
  //
  // FLOOR COLLIDERS ARE EXCLUDED and that exclusion is the point: a deck is a
  // box whose top face IS the ground, so a test sphere standing on the ground
  // always overlaps it.  We ask "is something in the way", never "is there a
  // floor here".
  PropsMetro.prototype._blocked = function (x, y, z, r) {
    if (!this.hash) return false;
    _bmin.set(x - r, y - r, z - r);
    _bmax.set(x + r, y + r, z + r);
    var list = this.hash.query(_bmin, _bmax, this._qout);
    _va.set(x, y, z);
    for (var i = 0; i < list.length; i++) {
      if (list[i].floor) continue;
      if (GAME.Collision.boxOverlapsSphere(list[i], _va, r)) return true;
    }
    return false;
  };

  PropsMetro.prototype._occupied = function (x, z, r) {
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
  PropsMetro.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  PropsMetro.prototype._inLens = function (x, z, r) {
    for (var i = 0; i < this._keepOut.length; i++) {
      var k = this._keepOut[i];
      var dx = x - k.x, dz = z - k.z;
      var rr = k.r + (r || 0);
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };

  PropsMetro.prototype._inBounds = function (x, z, pad) {
    var b = this.bounds;
    pad = pad || 0;
    return x > b.x0 + pad && x < b.x1 - pad && z > b.z0 + pad && z < b.z1 - pad;
  };

  // The one call every ground placement goes through.
  //
  //   opts: { r clearance, y explicit height, tilt, yaw, scale, sink,
  //           collider, low, color, noClear, halo }
  //
  // Returns the height it settled at, or null if the site was rejected.
  PropsMetro.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.45 : opts.r;
    if (!this._inBounds(x, z, 0.2)) { this._skipped++; return null; }
    if (!opts.lens && this._inLens(x, z, r * 0.8)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var y = opts.y === undefined ? this._ground(x, z) : opts.y;
    var cr = opts.clearR === undefined ? r * 0.75 : opts.clearR;
    if (!opts.noClear && this._blocked(x, y + (opts.h || 0.5) * 0.5, z, cr)) {
      this._skipped++; return null;
    }
    var yaw = opts.yaw === undefined ? this.rng.range(0, TAU) : opts.yaw;
    // Every prop sits with a slight tilt.  The deck settles up to 11 cm across
    // the hall and the trackbed is loose ballast; a station of objects standing
    // dead plumb is the "perfectly straight anything" the bar rejects on sight.
    var tilt = opts.tilt === undefined ? 0.030 : opts.tilt;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    // WETNESS IS DECIDED HERE, NOT IN THE GEOMETRY.
    //
    // One geometry serves every instance of a prop, so its painted mask has to
    // suit the COMMON case - a damp platform two feet above the flood - or a
    // suitcase in a dry saloon comes out as a black mirror.  The instances that
    // are actually standing IN the water say so through the instance colour,
    // which multiplies the mask: G down is wetter.  So the same crate reads
    // damp on the platform and soaked in the trench, from one geometry.
    var tint = opts.color || wearTint(this.rng);
    if (!opts.dry && y < this.waterY + 0.34) {
      _col2.copy(tint);
      _col2.g *= 0.40;
      _col2.r *= 0.86;
      tint = _col2;
    }
    var ok = batch.add(
      T(x, y - (opts.sink || 0), z,
        this.rng.gaussian(0, tilt), yaw, this.rng.gaussian(0, tilt),
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      tint);
    if (!ok) return null;
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    // Anything standing in a flooded room grows a tide ring where it meets the
    // water: silt against the upstream face, biofilm all round.  This is the
    // metro's version of the harbour's wet halo and it is what stops a prop
    // terminating on a hard line against the floor.
    if (opts.halo !== false && r >= 0.24 && y < this.hall.platY + 0.05) {
      this._scum(x, z, Math.min(r * 1.5, 1.3), y);
    }
    return y;
  };

  PropsMetro.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  PropsMetro.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // Drop a whole Item into the static batches at a world transform.
  PropsMetro.prototype._place = function (item, x, y, z, yaw, scale, roll) {
    if (!item) return;
    var base = Tn(x, y, z, roll || 0, yaw || 0, 0, scale || 1, scale || 1, scale || 1);
    var keys = item.keys();
    for (var k = 0; k < keys.length; k++) {
      var list = item.buckets[keys[k]];
      for (var i = 0; i < list.length; i++) {
        this._static(keys[k], list[i].geometry,
          new THREE.Matrix4().multiplyMatrices(base, list[i].matrix));
      }
    }
  };

  // A poster or an enamel plate on a wall.  `nx/nz` is the outward normal of
  // the wall it is pasted to.
  //
  // ORIENTATION COMES FROM THE WALL NORMAL, NEVER FROM A YAW.  card() builds
  // its quad facing local +Z, and yaw = atan2(nx, nz) maps local +Z onto
  // (nx, nz) exactly - so as long as the caller hands over the OUTWARD normal
  // of the surface it is pasting to, the legend can only ever face out of the
  // wall.  The normal is normalised here rather than trusted, because a caller
  // that passes (0, -s) with s already negative used to produce a plate facing
  // INTO the masonry, which under the old DoubleSide material printed as
  // mirrored text instead of disappearing.  It now disappears, loudly.
  PropsMetro.prototype._poster = function (kind, cell, x, y, z, nx, nz, w, h, tilt, pitch) {
    var len = Math.sqrt(nx * nx + nz * nz);
    if (!(len > 1e-4)) return;
    nx /= len; nz /= len;
    var uv = cellUV(cell);
    var g = card(w, h, uv[0], uv[1], uv[2], uv[3]);
    var yaw = Math.atan2(nx, nz);
    // stand the plate off the wall along its own normal, so a 1.5 cm authored
    // offset cannot be swallowed by a settled or jittered surface
    this._static(kind, g,
      Tn(x + nx * 0.012, y - h * 0.5, z + nz * 0.012, pitch || 0, yaw, tilt || 0));
  };

  // A stain card.  `cell`: 0 rust weep, 1 water streak, 2 soot, 3 mould.
  // A wall stain hangs from (x,y,z) downward; a floor stain lies flat.
  PropsMetro.prototype._stain = function (cell, x, y, z, w, h, nx, ny, nz, roll) {
    if (this._stainCount >= 300) return;
    var uv = cellUV(cell);
    var g, m;
    if (ny > 0.5) {
      g = flatQuad(w, h, uv);
      m = Tn(x, y, z, 0, roll || 0, 0);
    } else {
      g = card(w, h, uv[0], uv[1], uv[2], uv[3]);
      m = Tn(x, y - h, z, 0, Math.atan2(nx, nz), roll || 0);
    }
    this._static('stain', g, m);
    this._stainCount++;
  };

  // Biofilm and silt on the water, or a tide ring round a standing prop.
  PropsMetro.prototype._scum = function (x, z, r, y) {
    if (this._scumCount >= 200) return;
    if (!this.B.scum) return;
    var b = this.B.scum;
    if (b.n >= b.max) return;
    var wy = (y === undefined ? this.waterY : Math.max(y, this.waterY - 0.02)) + 0.012;
    _col.setRGB(
      0.80 + this.rng.range(0, 0.30),
      0.84 + this.rng.range(0, 0.26),
      0.72 + this.rng.range(0, 0.28));
    b.add(T(x, wy, z, 0, this.rng.range(0, TAU), 0,
      r * this.rng.range(0.85, 1.45), 1, r * this.rng.range(0.85, 1.45)), _col);
    this._scumCount++;
  };

  PropsMetro.prototype._uvScale = function (name, texels) {
    try {
      if (this.ctx.materials && this.ctx.materials.uvScaleFor) {
        var s = this.ctx.materials.uvScaleFor(name, texels || 500);
        if (isFinite(s) && s > 0) return s;
      }
    } catch (e) { /* library still booting */ }
    return 1.3;
  };

  // Re-UV a merged prop to the library's declared texel density, copy uv1 for
  // the AO channel, and paint the wear mask.  Every instanced prop goes through
  // here so density does not visibly jump between a 0.1 m tile shard and a
  // 2.4 m kiosk - the tell that a prop set was authored piecemeal.
  // TEXEL DENSITY IS DRIVEN BY THE PROP'S OWN SIZE, not by a constant.
  //
  // Every instanced prop used to ask for a flat 500 texels/m regardless of what
  // it was, which is a reasonable number for a 1-2 m object and wrong at both
  // ends. At 500 the library's mineral and metal detail lands at roughly 3 cm
  // features in world space: on the 0.58 m drum in the hero1 foreground that is
  // hemispherical popcorn - it photographed as a chocolate-chip log - and on
  // the barrier rail beside the rubble it reads as coral. On a 3 m panel the
  // same density is too fine to register at all and just costs shimmer.
  // Hand-sized objects want the detail small (high texels/m), big flat ones
  // want it coarse (low), and the number is now solved off the bounding box.
  function texelsForSize(size) {
    if (!(size > 0)) return 500;
    if (size >= 2.4) return 240;
    if (size >= 1.2) return 340;
    if (size >= 0.7) return 520;
    if (size >= 0.35) return 800;
    return 1150;
  }

  PropsMetro.prototype._finishGeo = function (geo, matName, wear, texels, keepUV) {
    if (!geo) return null;
    if (!keepUV) {
      if (texels === undefined) {
        try {
          geo.computeBoundingBox();
          var bb = geo.boundingBox;
          texels = texelsForSize(Math.max(bb.max.x - bb.min.x,
            Math.max(bb.max.y - bb.min.y, bb.max.z - bb.min.z)));
        } catch (eb) { texels = 500; }
      }
      try { Geo.worldUV(geo, this._uvScale(matName, texels)); } catch (e) { /* keep builder uv */ }
    }
    Geo.copyUV1(geo);
    paintWear(geo, wear || {});
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  // A horizontal quad centred on the origin, normal +Y.  Scum, floor stains and
  // litter all lie ON something, and authoring them flat means a placement is a
  // yaw and a scale rather than a rotation nobody can read back.
  function flatQuad(w, d, uv) {
    var hw = w * 0.5, hd = d * 0.5;
    var pos = new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, hw, 0, hd,
      -hw, 0, -hd, hw, 0, hd, -hw, 0, hd
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
    var u = uv || [0, 0, 1, 1];
    var t = new Float32Array([
      u[0], u[1], u[2], u[1], u[2], u[3],
      u[0], u[1], u[2], u[3], u[0], u[3]
    ]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t, 2));
    return g;
  }

  function remapUV(geo, r) {
    var uv = geo.attributes.uv;
    if (!uv) return geo;
    for (var i = 0; i < uv.count; i++) {
      uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    }
    uv.needsUpdate = true;
    return geo;
  }

  // ==========================================================================
  // KIT - every repeated prop becomes an InstancedMesh (or a Combo of them).
  //
  // A batch is ALWAYS created, even when its builder returned nothing: forty
  // dressing call sites reach into this.B by name, and making one of them
  // conditional on a geometry that might be null turns a cosmetic failure into
  // a throw in the middle of a pass, which loses every prop after it.  An empty
  // batch is dropped in _commit and costs nothing.
  // ==========================================================================
  PropsMetro.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats;
    var self = this;

    // Wear presets, by what the object actually IS.  `soak` is the wetness at
    // the foot and `rise` the height it dies off over: timber and hessian wick
    // hardest and highest, painted steel barely at all, and anything already
    // lying in the water is soaked through.
    var W = {
      metal: { noise: N, soak: 0.42, rise: 0.45, grime: 0.46, edge: 0.30, hiY: 1.0 },
      iron: { noise: N, soak: 0.52, rise: 0.50, grime: 0.54, edge: 0.34, hiY: 1.0 },
      timber: { noise: N, soak: 0.62, rise: 0.55, grime: 0.44, edge: 0.26, hiY: 0.9 },
      cloth: { noise: N, soak: 0.58, rise: 0.34, grime: 0.56, edge: 0.10, hiY: 0.5 },
      // Anything lying flat.  MEASURED, not chosen: at soak 0.92 over a 14 cm
      // rise the whole of a 12 cm pipe or a 4 cm panel is inside the capillary
      // band, G goes to nearly zero over the entire object, and materials.js
      // takes albedo to x0.48 at roughness 0.09 - which photographs as a black
      // glossy slab with no silhouette at all.  A soaked object still has to
      // return its own shape.
      ground: { noise: N, soak: 0.55, rise: 0.28, grime: 0.50, edge: 0.24, hiY: 0.4 },
      // THIN objects lying flat - a plank, a ceiling panel, a length of pipe, a
      // tile chip.  For these the capillary band covers the WHOLE object, so
      // `soak` stops being a gradient and becomes the object's total wetness;
      // left at the ground preset's 0.74 the entire prop lands at G ~ 0.1,
      // which materials.js renders as a black mirror with no silhouette.  Half
      // that reads as "wet through" and still returns its own shape.
      flat: { noise: N, soak: 0.38, rise: 0.45, grime: 0.48, edge: 0.22, hiY: 0.4 },
      stone: { noise: N, soak: 0.55, rise: 0.30, grime: 0.52, edge: 0.30, hiY: 0.5 },
      // anything hanging or high: no capillary rise, but it holds the drip film
      hung: { noise: N, soak: 0.0, rise: 0.2, drip: 0.34, grime: 0.38, edge: 0.18, hiY: 0.6 },
      // the big one-offs get their gradient measured over their own height
      plant: { noise: N, soak: 0.45, rise: 0.55, grime: 0.50, edge: 0.30, hiY: 1.6 }
    };
    this._W = W;

    function fin(g, name, wear, texels, keepUV) {
      return self._finishGeo(g, name, wear, texels, keepUV);
    }
    function bat(key, geo, mat, max, shadow) {
      if (!geo) geo = new THREE.BufferGeometry();
      if (!geo.attributes || !geo.attributes.position) geo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
      self.B[key] = new Batch(geo, mat || self.mats.steel, max, shadow);
      return self.B[key];
    }

    var it;

    // ---- platform furniture -------------------------------------------------
    it = K.bench(N, R);
    bat('benchWood', fin(mergeKeys(it, ['wood']), 'wood_plank', W.timber), m.wood, 18);
    bat('benchIron', fin(mergeKeys(it, ['rust']), 'rusted_metal', W.iron), m.rust, 18);
    this.B.bench = new Combo([this.B.benchWood, this.B.benchIron]);

    it = K.bin(N, R);
    bat('bin', fin(mergeKeys(it, ['rust']), 'rusted_metal', W.iron), m.rust, 16);

    it = K.crate(N, R);
    bat('crate', fin(mergeKeys(it, ['wood']), 'wood_plank', W.timber), m.wood, 40);

    it = K.drum(N, R);
    bat('drum', fin(mergeKeys(it, ['rust']), 'rusted_metal', W.iron), m.rust, 30);

    it = K.sandbag(N, R);
    bat('sandbag', fin(mergeKeys(it, ['fabric']), 'sandbag', W.cloth), m.fabric, 170);

    it = K.cone();
    bat('coneBody', fin(mergeKeys(it, ['plastic']), 'plastic', W.ground), m.orange, 24);
    bat('coneBand', fin(mergeKeys(it, ['cream']), 'painted_metal', W.ground), m.cream, 24);
    this.B.cone = new Combo([this.B.coneBody, this.B.coneBand]);

    it = K.barrier(R);
    bat('barrierLeg', fin(mergeKeys(it, ['steel']), 'painted_metal', W.metal), m.steel, 16);
    bat('barrierBoard', fin(mergeKeys(it, ['red']), 'painted_metal', W.metal), m.red, 16);
    this.B.barrier = new Combo([this.B.barrierLeg, this.B.barrierBoard]);

    it = K.reel(N, R);
    bat('reelWood', fin(mergeKeys(it, ['wood']), 'wood_plank', W.timber), m.wood, 10);
    bat('reelCable', fin(mergeKeys(it, ['cable']), 'rubber', W.metal), m.cable, 10);
    this.B.reel = new Combo([this.B.reelWood, this.B.reelCable]);

    it = K.suitcase(R);
    bat('suitcase', fin(mergeKeys(it, ['plastic', 'rust']), 'plastic', W.cloth), m.plastic, 16);

    it = K.duffel(N, R);
    bat('duffel', fin(mergeKeys(it, ['fabric']), 'sandbag', W.cloth), m.fabric, 14);

    it = K.bucket();
    bat('bucket', fin(mergeKeys(it, ['plastic', 'rust']), 'plastic', W.ground), m.plastic, 16);

    it = K.plank(N, R);
    bat('plank', fin(mergeKeys(it, ['wood', 'rust']), 'wood_plank', W.flat), m.wood, 46);

    it = K.panel(N, R, 2.7);
    bat('panel', fin(mergeKeys(it, ['steel']), 'painted_metal', W.flat), m.steel, 36);

    it = K.chunk(N, R);
    bat('chunk', fin(mergeKeys(it, ['concrete']), 'concrete', W.stone), m.concrete, 110);

    it = K.shard(R);
    bat('shard', fin(mergeKeys(it, ['tile']), 'tile', W.flat), m.tile, 240, false);

    it = K.rebar(R);
    bat('rebar', fin(mergeKeys(it, ['rust']), 'rusted_metal', W.flat), m.rust, 30);

    it = K.bottle();
    bat('bottle', fin(mergeKeys(it, ['plastic']), 'plastic', W.flat), m.plastic, 70, false);

    it = K.pipe();
    bat('pipe', fin(mergeKeys(it, ['rust']), 'rusted_metal', W.flat), m.rust, 26);

    it = K.glassShard(R);
    bat('glassShard', fin(mergeKeys(it, ['glass']), 'glass', W.flat), m.glass, 110, false);

    it = K.stalactite(N);
    bat('stalactite', fin(mergeKeys(it, ['concrete']), 'concrete', W.hung), m.concrete, 48, false);

    it = K.strap();
    bat('strap', fin(mergeKeys(it, ['rubber', 'steel']), 'plastic',
      { noise: N, soak: 0, rise: 0.2, drip: 0.12, grime: 0.34, edge: 0.24, hiY: 0.4 }), m.strap, 30, false);

    it = K.signalBox(R);
    bat('sigBody', fin(mergeKeys(it, ['green']), 'painted_metal', W.plant), m.green, 14);
    bat('sigTrim', fin(mergeKeys(it, ['steel', 'rust', 'cable']), 'rusted_metal', W.plant), m.rust, 14);
    this.B.signal = new Combo([this.B.sigBody, this.B.sigTrim]);

    // ---- litter -------------------------------------------------------------
    // Four separate batches rather than one, because an InstancedMesh cannot
    // choose an atlas cell per instance without a custom attribute, and a
    // platform strewn with two hundred copies of the same folded newspaper is
    // worse than the four draw calls this costs.
    var LIT = [[0.48, 0.37], [0.25, 0.22], [0.42, 0.33], [0.46, 0.39]];
    var LITN = [150, 110, 100, 100];
    for (var c = 0; c < 4; c++) {
      var lg = sheet(LIT[c][0], LIT[c][1], 4, 3, 0.030 + c * 0.006, N, 3.7 + c);
      remapUV(lg, cellUV(c));
      Geo.copyUV1(lg);
      paintCard(lg, N, 0.90, 0.20);
      bat('litter' + c, lg, m.litter, LITN[c], false);
    }

    // ---- water dressing ------------------------------------------------------
    var sg = flatQuad(1.0, 1.0, [0.02, 0.02, 0.98, 0.98]);
    Geo.copyUV1(sg);
    paintCard(sg, N, 1.0, 0.0);
    bat('scum', sg, m.scum, 200, false);

    // A raft of debris: two planks and a scrap of ply that drifted together and
    // stopped against something.  One batch, animated as a unit.
    it = new Item();
    it.boxR('wood', 0.90, 0.030, 0.14, 0, 0.015, -0.10, 0, 0.12, 0);
    it.boxR('wood', 0.72, 0.028, 0.12, 0.06, 0.015, 0.10, 0, -0.22, 0);
    it.boxR('wood', 0.34, 0.018, 0.30, -0.24, 0.012, 0.16, 0, 0.5, 0);
    bat('raft', fin(mergeKeys(it, ['wood']), 'wood_plank', W.flat), m.wood, 70, false);

    var rg = new THREE.RingGeometry(0.30, 0.50, 18, 1);
    rg.rotateX(-Math.PI * 0.5);
    Geo.copyUV1(rg);
    bat('ring', rg, m.ripple, 18, false);

    this.stats.kit = Object.keys(this.B).length;
  };


  // ==========================================================================
  // DRESSING PASSES
  //
  // Reading order matters: this is a story told in props.  A maintenance gang
  // was pumping the station out.  They had a tower up under the hole in the
  // vault, a generator and a pump on the platform edge, worklights rigged where
  // the level says they are, and a stack of materials down the north side.
  // Then the train came through the arcade and they left everything where it
  // stood.  Every pass below places against level.anchors, never against a pose.
  // ==========================================================================

  // The gang's kit, dropped round the foot of a rigged worklight.  The lamp
  // positions come from level.anchors.lamps, so the tools are where the light
  // is - which is the whole reason the light is there.
  PropsMetro.prototype._gangKit = function (x, z, sc) {
    var R = this.rng;
    sc = sc || 1;
    var gy = this._ground(x, z);
    this._place(K.toolbox(), x + R.range(0.5, 0.9), gy, z + R.range(-0.7, 0.7),
      R.range(0, TAU), 1, R.range(-0.02, 0.02));
    this._place(K.jerrycan(), x - R.range(0.6, 1.0), gy, z + R.range(-0.8, 0.8),
      R.range(0, TAU));
    this._place(K.hoseCoil(), x + R.range(-1.4, -0.7), gy, z + R.range(0.6, 1.3),
      R.range(0, TAU));
    this._drop(this.B.bucket, x + R.range(0.9, 1.5), z + R.range(-1.2, -0.5),
      { r: 0.28, tilt: 0.10, yaw: R.range(0, TAU) });
    this._drop(this.B.plank, x + R.range(-2.0, -1.2), z + R.range(-1.6, -0.9),
      { r: 0.5, tilt: 0.02, yaw: R.range(0, TAU) });
    // spilled oil and boot traffic where somebody stood all day
    this._stain(2, x + R.range(-0.6, 0.6), gy + 0.006, z + R.range(-0.6, 0.6),
      R.range(1.2, 2.0), R.range(1.0, 1.8), 0, 1, 0, R.range(0, TAU));
  };

  PropsMetro.prototype._dressWorkSite = function () {
    var R = this.rng, i;
    var platY = this.hall.platY;

    // ---- the tower under the hole ------------------------------------------
    // A gang works under the hole in the roof because that is where the water
    // is coming in.  It stands IN the vent shaft's beam, which is the one
    // vertical column of light in the level - a silhouette against it is worth
    // more than any amount of clutter on the floor.
    // ---- WHERE IT STANDS, MEASURED RATHER THAN ASSUMED --------------------
    // Round 2 asked for this tower to be moved to vent.x + 1.9, vent.z - 1.9 on
    // the grounds that it sits "3.7 m in front of hero1's stand and directly on
    // the sightline to the wreck nose". Projected against the published pose -
    // eye (-14.90, 2.55, 0.90), forward (0.921, -0.389), 75 deg vertical FOV -
    // the tower at (-9.20, 2.90) lands at screen x 1066 of 1280 and the nose
    // lands at 618. It is in the right sixth of the frame and always was; the
    // suggested coordinate projects to 867, i.e. it would have moved the tower
    // TOWARD the subject, which is the opposite of the intent. Moved a further
    // 0.65 m south instead (screen x 1158): still inside the vent beam, further
    // clear of the sightline, and reading as a right-hand framing element.
    var tx = this.vent.x - 0.20, tz = this.vent.z + 0.35;
    var ty = this._ground(tx, tz);
    this._place(K.scaffold(2.85), tx, ty, tz, 0.06);
    this._collider(tx, ty, tz, [0.80, 1.45, 0.62], 0.06, 'metal');
    this._occupy(tx, tz, 1.15);
    this._place(K.ladder(2.55), tx + 0.86, ty, tz + 0.10, -0.10, 1, 0.05);
    // materials on the tower deck and at its foot
    this._drop(this.B.bucket, tx - 0.30, tz + 0.42, { y: ty + 2.55, r: 0.22, noClear: true, halo: false, tilt: 0.02 });
    this._drop(this.B.plank, tx + 0.10, tz - 0.36, { y: ty + 2.55, r: 0.30, noClear: true, halo: false, yaw: 0.05, tilt: 0.01 });
    for (i = 0; i < 3; i++) {
      this._drop(this.B.chunk, tx + R.range(-1.8, 1.8), tz + R.range(-1.6, 1.6),
        { r: 0.35, scale: R.range(0.7, 1.3) });
    }

    // ---- the pump, at the platform edge, hose over the side -----------------
    var px = this.vent.x - 2.6, pz = -(this.plat.hz - 0.95);
    var py = this._ground(px, pz);
    this._place(K.pumpSet(), px, py, pz, Math.PI * 0.5 + 0.06);
    this._collider(px, py, pz, [0.42, 0.34, 0.66], 0, 'metal');
    this._occupy(px, pz, 1.1);
    // the suction hose, over the coping and into the trench.  It is the only
    // curve in the frame and it is what says the pump was WORKING, not stored.
    var hose = new Item();
    hose.sag('cable', 0, 0.42, 0.30, 0, 0.30, -1.10, 0.22, 0.055, 5);
    hose.sag('cable', 0, 0.30, -1.10, 0.35, -0.62, -2.20, 0.50, 0.055, 6);
    hose.tube('cable', 0.055, 0.35, -0.62, -2.20, 0.9, -0.84, -2.9, 6);
    this._place(hose, px, py, pz, 0);
    // discharge, running the other way down the platform to a drain
    var dis = new Item();
    dis.sag('cable', 0, 0.55, 0, 1.6, 0.10, 0.9, 0.30, 0.045, 6);
    dis.sag('cable', 1.6, 0.10, 0.9, 4.4, 0.06, 1.5, 0.10, 0.045, 6);
    this._place(dis, px, py, pz, 0);

    // ---- the generator, back from the edge, with its cable run --------------
    var gx = px - 3.4, gz = pz + 1.4;
    var gy = this._ground(gx, gz);
    this._place(K.genset(), gx, gy, gz, -Math.PI * 0.5 + 0.04);
    this._collider(gx, gy, gz, [0.48, 0.50, 0.78], 0, 'metal');
    this._occupy(gx, gz, 1.3);
    var run = new Item();
    run.sag('cable', 0, 0.30, 0, 2.2, 0.05, -1.1, 0.16, 0.028, 6);
    run.sag('cable', 2.2, 0.05, -1.1, 3.6, 0.05, -1.6, 0.06, 0.028, 4);
    this._place(run, gx, gy, gz, 0);
    this._stain(2, gx + 0.9, gy + 0.006, gz + 0.4, 1.5, 1.2, 0, 1, 0, R.range(0, TAU));

    // ---- the gang's kit at every rigged worklight ---------------------------
    var lamps = this.lamps || [];
    var kits = 0;
    for (i = 0; i < lamps.length && kits < 4; i++) {
      var L = lamps[i];
      if (!L || !L.pos) continue;
      if (L.kind !== 'led') continue;             // the worklights, not the fittings
      var lx = L.pos.x, lz = L.pos.z;
      if (!this._inBounds(lx, lz, 1.0)) continue;
      // a lamp head 2.5 m up is on a tripod whose feet are on the floor here
      this._gangKit(lx, lz, 1);
      kits++;
    }

    // ---- the stores line ----------------------------------------------------
    // Materials stacked down the north half of the platform between the tower
    // and the crash, off the walking line, exactly the way a possession is laid
    // out: pipe on dunnage, sleepers, drums of grout, bagged aggregate.
    var sx0 = this.vent.x - 5.6;
    for (i = 0; i < 5; i++) {
      var mx = sx0 + i * 1.55;
      var mz = -2.55 + R.range(-0.35, 0.35);
      if (i % 2 === 0) {
        this._drop(this.B.pipe, mx, mz, { r: 0.65, yaw: R.range(-0.06, 0.06), tilt: 0.012 });
        this._drop(this.B.pipe, mx + 0.14, mz + 0.16, { r: 0.20, yaw: R.range(-0.06, 0.06), tilt: 0.012, noClear: true });
      } else {
        this._drop(this.B.crate, mx, mz, { r: 0.55, yaw: R.range(-0.4, 0.4), tilt: 0.02,
          collider: [0.42, 0.26, 0.32], material: 'wood' });
        if (R.bool(0.6)) {
          this._drop(this.B.crate, mx + R.range(-0.12, 0.12), mz + R.range(-0.10, 0.10),
            { y: this._ground(mx, mz) + 0.50, r: 0.30, yaw: R.range(-0.5, 0.5), tilt: 0.03,
              noClear: true, halo: false });
        }
      }
    }
    // bagged aggregate against the pier line, stacked in courses
    this._sandbagStack(sx0 - 1.5, -3.35, 0, 4, 3, 0.16);
    this._drop(this.B.drum, sx0 + 7.2, -2.9, { r: 0.44 });
    this._drop(this.B.drum, sx0 + 7.7, -3.45, { r: 0.44 });
    this._drop(this.B.reel, sx0 + 5.6, -3.2, { r: 0.75, yaw: R.range(0, 3.14), tilt: 0.02 });

    // ---- what got carried to the tower and dropped -------------------------
    // The tower is where the work is, so the last few metres of the walk to it
    // are where a gang puts down what it is carrying: this cluster sits between
    // the stores line and the tower, on the centre of the platform rather than
    // against a wall, because that is where a dropped load actually lands.
    var fx = this.vent.x - 3.9, fz = 1.05;
    this._drop(this.B.crate, fx, fz, { r: 0.55, yaw: 0.34, tilt: 0.02,
      collider: [0.42, 0.26, 0.32], material: 'wood' });
    this._drop(this.B.drum, fx + 1.05, fz - 0.85, { r: 0.46, tilt: 0.04 });
    this._place(K.hoseCoil(), fx - 0.85, this._ground(fx - 0.85, fz + 0.55), fz + 0.55, 1.2);
    this._drop(this.B.bucket, fx + 0.30, fz + 0.95, { r: 0.26, tilt: 0.24, yaw: 2.4 });
    this._drop(this.B.plank, fx + 1.9, fz + 0.5, { r: 0.5, yaw: 0.42, tilt: 0.015 });
    this._drop(this.B.plank, fx + 2.0, fz + 0.66, { r: 0.2, yaw: 0.36, tilt: 0.015, noClear: true });
    this._drift(fx + 0.6, fz + 0.2, 5, 0.75);
    this._stain(2, fx + 0.4, this._ground(fx, fz) + 0.006, fz + 0.1, 2.6, 2.2, 0, 1, 0, 0.7);
  };

  // A stack of sandbags: courses, staggered, each bag jittered.  Sandbags are
  // the one prop in the kit that is ALWAYS in a wall - a scatter of individual
  // bags reads as rubbish, a course reads as a flood defence somebody built.
  PropsMetro.prototype._sandbagStack = function (x, z, yaw, len, courses, bagH) {
    var R = this.rng;
    var b = this.B.sandbag;
    if (!b) return;
    bagH = bagH || 0.16;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var gy = this._ground(x, z);
    for (var k = 0; k < courses; k++) {
      var n = Math.max(1, len - Math.floor(k * 0.4));
      var off = (k % 2) * 0.22 + (len - n) * 0.22;
      for (var i = 0; i < n; i++) {
        var t = (i - (n - 1) * 0.5) * 0.44 + off * 0.2;
        var bxp = x + c * t, bzp = z + s * t;
        var m = T(bxp + R.range(-0.02, 0.02), gy + k * bagH * 0.92, bzp + R.range(-0.03, 0.03),
          R.gaussian(0, 0.05), yaw + R.gaussian(0, 0.10), R.gaussian(0, 0.06),
          R.range(0.92, 1.08), R.range(0.88, 1.06), R.range(0.92, 1.08));
        // Every bag carries the same painted mask, so the COURSE is what varies:
        // G is raised up the stack (G = 1 is dry), which is the whole point of a
        // sandbag wall - the bottom course is black with water and the top one
        // is still hessian.  Without this a dike reads as one moulded object.
        _col.setRGB(1 - R.range(0, 0.22),
          M.saturate(0.68 + k * 0.11 + R.range(0, 0.10)),
          1 - R.range(0, 0.18));
        b.add(m, _col);
      }
    }
    this._occupy(x, z, len * 0.24);
    this._collider(x, gy, z, [Math.abs(c) * len * 0.24 + 0.20, courses * bagH * 0.5,
      Math.abs(s) * len * 0.24 + 0.20], 0, 'dirt');
  };

  // ---- the platform ---------------------------------------------------------
  PropsMetro.prototype._dressPlatform = function () {
    var R = this.rng;
    var backZ = this.plat.backZ;
    var s, i;
    var wreckX = this.trainImpact ? this.trainImpact.x : -3.6;

    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < this.piersX.length; i++) {
        var px = this.piersX[i];
        // the two piers the train took out, and the bay it came through, carry
        // wreckage instead of furniture
        var broken = (s < 0 && this.brokenX.indexOf(px) >= 0);
        if (broken) continue;
        if (s < 0 && Math.abs(px - wreckX) < 7.0) continue;
        var fz = s * (backZ - 0.36);
        var faceYaw = (s > 0) ? 0 : Math.PI;      // bench back to the pier
        // ---- BREAK THE RHYTHM --------------------------------------------
        // `(i*3 + s) % 5` over ten piers repeats EXACTLY every five, so the
        // dressing that existed read as a pattern rather than as forty years of
        // accumulation. A 7-long table over 10 piers never closes, and two bays
        // are then made genuinely anomalous rather than being another cycle
        // value: bay 4 north is stripped completely bare (the furniture went out
        // when the station closed) and bay 7 south is buried under a stack that
        // somebody piled two courses high and left.
        var VAR = [0, 3, 1, 4, 2, 0, 3];
        var kind = VAR[(i * 3 + (s > 0 ? 1 : 0)) % 7];
        if (s < 0 && i === 4) { kind = -1; }         // stripped bare
        if (s > 0 && i === 7) { kind = 9; }          // buried

        if (kind === -1) {
          // the bare bay: nothing but the ghost of what stood here - four rust
          // stains where a bench was bolted down, and the clean rectangle the
          // grime never reached
          for (var gk = 0; gk < 4; gk++) {
            this._stain(0, px - 0.85 + (gk & 1) * 1.70, this._ground(px, fz) + 0.006,
              s * (backZ - 0.42) + ((gk >> 1) ? 0.26 : -0.26),
              0.16, 0.16, 0, 1, 0, R.range(0, TAU));
          }
        } else if (kind === 9) {
          // the buried bay: two courses of crates, drums on top, sandbags at the
          // foot, everything the gang cleared out of the cross passage
          var buY = this._ground(px, fz);
          for (var bk = 0; bk < 5; bk++) {
            var bxx = px - 1.5 + bk * 0.78;
            this._drop(this.B.crate, bxx, s * (backZ - 0.44), {
              r: 0.36, yaw: faceYaw + R.range(-0.3, 0.3), tilt: 0.02, noClear: true,
              collider: [0.40, 0.26, 0.30], material: 'wood'
            });
            if (R.bool(0.75)) {
              this._drop(this.B.crate, bxx + R.range(-0.12, 0.12), s * (backZ - 0.44),
                { y: buY + 0.50, r: 0.28, yaw: faceYaw + R.range(-0.7, 0.7), tilt: 0.04,
                  noClear: true, halo: false });
            }
          }
          this._drop(this.B.drum, px + 1.55, s * (backZ - 0.52), { r: 0.44, tilt: 0.03 });
          this._drop(this.B.drum, px - 1.85, s * (backZ - 0.60), { r: 0.44, tilt: 0.06 });
          this._sandbagStack(px + 0.2, s * (backZ - 1.15), 0, 4, 2, 0.16);
        } else if (kind === 0 || kind === 3) {
          // bench, backed against the pier
          var bz = s * (backZ - 0.42);
          if (this._drop(this.B.bench, px + R.range(-0.25, 0.25), bz, {
            r: 1.05, yaw: faceYaw + R.range(-0.03, 0.03), tilt: 0.012,
            collider: [0.95, 0.24, 0.34], material: 'wood'
          }) !== null) {
            // what collects under a bench: everything
            this._drift(px + R.range(-0.8, 0.8), s * (backZ - 0.20), 3, 0.5);
            if (R.bool(0.5)) {
              this._drop(this.B.bottle, px + R.range(-0.9, 0.9), s * (backZ - 0.75),
                { r: 0.10, tilt: 1.55, yaw: R.range(0, TAU), halo: false });
            }
          }
        } else if (kind === 1) {
          // a bin at the pier corner, where a bin actually goes
          var cx = px + (R.bool() ? 1.45 : -1.45);
          this._drop(this.B.bin, cx, s * (backZ - 0.30), {
            r: 0.34, tilt: R.bool(0.25) ? 0.16 : 0.02, yaw: R.range(0, TAU)
          });
          this._drift(cx + R.range(-0.4, 0.4), s * (backZ - 0.55), 4, 0.55);
        } else if (kind === 2) {
          // abandoned luggage, left in a group the way a family's is
          var lx = px + R.range(-1.0, 1.0), lz = s * (backZ - 0.55);
          this._drop(this.B.suitcase, lx, lz, { r: 0.38, yaw: R.range(0, TAU), tilt: 0.04 });
          if (R.bool(0.7)) {
            this._drop(this.B.duffel, lx + R.range(-0.7, 0.7), lz + s * R.range(-0.5, 0.2),
              { r: 0.32, yaw: R.range(0, TAU), tilt: 0.05 });
          }
        } else {
          // a stack of crates against the pier, and a bin beside it
          var kx = px + R.range(-0.9, 0.9);
          var kz = s * (backZ - 0.40);
          var gy = this._drop(this.B.crate, kx, kz, {
            r: 0.52, yaw: faceYaw + R.range(-0.25, 0.25), tilt: 0.015,
            collider: [0.40, 0.26, 0.30], material: 'wood'
          });
          if (gy !== null && R.bool(0.65)) {
            this._drop(this.B.crate, kx + R.range(-0.10, 0.10), kz + R.range(-0.08, 0.08),
              { y: gy + 0.50, r: 0.30, yaw: faceYaw + R.range(-0.6, 0.6), tilt: 0.03,
                noClear: true, halo: false });
          }
        }

        // Broken tile banked against every pier base.  The glaze is coming off
        // this station a square metre at a time and it all ends up here.
        var nSh = R.int(4, 9);
        for (var k = 0; k < nSh; k++) {
          var sx = px + R.gaussian(0, 1.5);
          var sz = s * (backZ - Math.abs(R.gaussian(0, 0.22)) - 0.03);
          this._drop(this.B.shard, sx, sz, {
            r: 0.05, yaw: R.range(0, TAU), tilt: 0.28, scale: R.range(0.7, 1.5),
            halo: false, noClear: true, lens: true
          });
        }
      }
    }

    // The cross-passage recess is where the gang built their dike against the
    // water coming down the passage.  It is also the one place the 70 m arcade
    // rhythm breaks, so it earns a set piece.
    var cx2 = this.cross.x;
    this._sandbagStack(cx2 - 0.2, -(backZ - 0.55), 0, 6, 3, 0.16);
    this._sandbagStack(cx2 + 1.9, -(backZ - 0.75), 0.35, 3, 2, 0.16);
    this._drop(this.B.bucket, cx2 + 1.2, -(backZ - 1.15), { r: 0.26, tilt: 0.22, yaw: 1.1 });
    this._drop(this.B.plank, cx2 - 2.2, -(backZ - 0.9), { r: 0.5, yaw: 0.15, tilt: 0.02 });

    // The far west end: the last few metres before the tunnel door, where the
    // station's own rubbish was piled and never taken out.
    var wx = this.hall.x0 + 2.4;
    this._drop(this.B.bin, wx, 3.2, { r: 0.34, tilt: 0.30, yaw: 2.1 });
    this._drift(wx + 0.7, 3.5, 7, 0.9);
    this._drop(this.B.crate, wx + 1.4, -3.3, { r: 0.5, yaw: 0.4, tilt: 0.02 });
    this._drop(this.B.crate, wx + 2.1, -3.5, { r: 0.5, yaw: -0.3, tilt: 0.02 });
    this._drop(this.B.drum, wx + 0.9, -2.6, { r: 0.44, tilt: 0.05 });
  };

  // ---- THE WALKING LINE -----------------------------------------------------
  // Four staged obstructions ACROSS the corridor, at four different heights and
  // four different reads: something to walk round (the hoarding), something to
  // duck under (the panel), something to vault (the trolley) and something to
  // shoot over (the seat barricade). Every one is placed against a published
  // anchor - a pier centre, the collapse edge, the kiosk line - never against a
  // camera pose, and every one carries a real collider so the AI has to path
  // round it and the player can actually use it.
  PropsMetro.prototype._dressObstructions = function () {
    var R = this.rng, i;
    var backZ = this.plat.backZ;
    var N = this.noise;

    // 1. THE TOPPLED HOARDING, mid-hall on the walking line, lying across the
    //    corridor at 40 degrees to the platform axis with its top edge 1.5 m up.
    //    It is the overview's foreground and the first thing that breaks the
    //    70 m of empty deck the establishing frame used to photograph.
    var hx = 16.60, hz = -0.90;
    var hy = this._ground(hx, hz);
    // Yawed so the advertising face looks EAST, up the overview's cone. hero1
    // and the overview read this hall from opposite ends, and a fallen board is
    // one-sided, so it has to pick: at 11.7 m from the gallery it is the
    // establishing frame's foreground, and at 31 m from the hero1 stand it is a
    // silhouette either way.
    this._place(K.hoarding(N, R), hx, hy, hz, 0.72 + Math.PI);
    this._collider(hx, hy, hz, [1.55, 0.48, 1.05], 0.72, 'metal');
    this._occupy(hx, hz, 1.8);
    this._drop(this.B.chunk, hx + 1.6, hz + 1.1, { r: 0.3, scale: 1.1 });
    this._drift(hx - 1.1, hz + 1.4, 6, 1.0);

    // 2. A second hoarding at the west end, still on its feet but leaning on the
    //    pier line, so the west third has a vertical in it too.
    var wx2 = -24.60, wz2 = 1.55;
    var wy2 = this._ground(wx2, wz2);
    this._place(K.hoarding(N, R), wx2, wy2, wz2, -2.35);
    this._collider(wx2, wy2, wz2, [1.30, 0.80, 0.90], -2.35, 'metal');
    this._occupy(wx2, wz2, 1.7);

    // 3. THE HANGING PANEL, just west of the collapse edge, at chest height on
    //    two surviving hangers. hero1's mid-ground gets a real sightline break
    //    5.4 m in front of the eye instead of an uninterrupted run to the wreck.
    // Set 2.1 m off the hall centre line, deliberately: at z = -1.3 it hung
    // dead across the hero1 axis and occluded the cab end - the level's own
    // subject - which is a worse defect than the bare corridor it was fixing.
    // From here it is a foreground element 18 degrees left of the crosshair.
    var px2 = this.collapse.x0 - 2.10, pz2 = -2.90;
    var py2 = this._ground(px2, pz2) + 1.42;
    this._place(K.hangPanel(N, R, this.hall.crown - py2 - 0.25), px2, py2, pz2, -0.42);
    this._collider(px2, py2 - 0.30, pz2, [1.15, 0.34, 0.80], -0.42, 'metal');
    this._occupy(px2, pz2, 1.4);
    // and what fell out of the void it left
    for (i = 0; i < 5; i++) {
      this._drop(this.B.chunk, px2 + R.gaussian(0, 0.9), pz2 + R.gaussian(0, 0.7),
        { r: 0.22, scale: R.range(0.6, 1.2), noClear: true });
    }
    this._stain(1, px2, this._ground(px2, pz2) + 0.006, pz2, 2.4, 2.0, 0, 1, 0, 0.4);

    // 4. THE STALLED WORKS TROLLEY with its cable drum, half way between the
    //    wreck and the kiosk, parked across the line where it stopped.
    var tx2 = 2.60, tz2 = 1.85;
    var ty2 = this._ground(tx2, tz2);
    this._place(K.trolley(), tx2, ty2, tz2, 1.28);
    this._collider(tx2, ty2, tz2, [0.62, 0.48, 0.42], 1.28, 'metal');
    this._occupy(tx2, tz2, 1.1);
    this._drop(this.B.reel, tx2 - 0.35, tz2 + 0.20, { r: 0.62, y: ty2 + 0.32,
      yaw: 1.28, tilt: 0.02, noClear: true, halo: false });
    this._drop(this.B.bucket, tx2 + 1.05, tz2 - 0.55, { r: 0.26, tilt: 0.18, yaw: 0.9 });
    this._place(K.hoseCoil(), tx2 - 1.35, this._ground(tx2 - 1.35, tz2 - 0.9), tz2 - 0.9, 0.4);

    // 5. THE SEAT BARRICADE. Four benches dragged off the pier line and stacked
    //    two high across the corridor - waist-high hard cover in the middle of
    //    the deck, which is what the firefight framing had none of.
    var sx2 = 8.60, sz2 = -1.35;
    var sy2 = this._ground(sx2, sz2);
    this._place(K.seatStack(N, R), sx2, sy2, sz2, 1.62);
    this._collider(sx2, sy2, sz2, [0.55, 0.52, 1.15], 1.62, 'wood');
    this._occupy(sx2, sz2, 1.6);
    this._drop(this.B.crate, sx2 - 0.30, sz2 + 1.55, { r: 0.5, yaw: 1.5, tilt: 0.03,
      collider: [0.40, 0.26, 0.30], material: 'wood' });
    this._drift(sx2 + 0.7, sz2 - 1.3, 5, 0.9);
  };

  // ---- signage, the kiosk and the fixed wall furniture ----------------------
  PropsMetro.prototype._dressSignage = function () {
    var R = this.rng;
    var backZ = this.plat.backZ;
    var platY = this.hall.platY;
    var s, i;

    // Posters on the pier faces.  Two per pier at most, at eye height, and
    // never on the broken ones.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < this.piersX.length; i++) {
        var px = this.piersX[i];
        if (s < 0 && this.brokenX.indexOf(px) >= 0) continue;
        var fz = s * (backZ - 0.015);
        var nz = -s;
        // level_metro.js hangs the illuminated STATION NAME PLATE on the south
        // faces of piers -3 and +9, sized so the invented letterforms resolve
        // in the hero1 and overview cones. A random paste-up over the top of it
        // is the one thing that would throw that away, so those two faces are
        // reserved. The stains below still run - a lit plate on a clean pier
        // would be the odd one out.
        var reserved = (s > 0 && (Math.abs(px + 3) < 0.01 || Math.abs(px - 9) < 0.01));
        if (!reserved && R.bool(0.62)) {
          this._poster('poster', R.int(0, 3), px + R.range(-0.55, 0.55),
            platY + R.range(1.55, 1.95), fz, 0, nz,
            R.range(0.80, 1.05), R.range(1.10, 1.45), R.range(-0.03, 0.03));
        }
        if (!reserved && R.bool(0.30)) {
          this._poster('sign', R.int(0, 3), px + R.range(-0.5, 0.5),
            platY + R.range(2.45, 2.75), fz, 0, nz,
            R.range(0.55, 0.80), R.range(0.28, 0.40), R.range(-0.02, 0.02));
        }
        // rust weeping from the fixings, and mould at the floor line
        if (R.bool(0.5)) {
          this._stain(0, px + R.range(-1.0, 1.0), platY + R.range(2.1, 2.9), fz, 0.5, 1.3, 0, 0, nz);
        }
        if (R.bool(0.7)) {
          this._stain(3, px + R.range(-1.1, 1.1), platY + R.range(0.55, 0.95), fz, 1.1, 0.9, 0, 0, nz);
        }
      }
      // the solid end bays take a big paste-up each
      this._poster('poster', R.int(0, 3), this.hall.x0 + 3.4, platY + 1.95, s * (backZ - 0.015),
        0, -s, 1.35, 1.85, 0.01);
      this._poster('poster', R.int(0, 3), this.hall.x1 - 4.2, platY + 1.90, s * (backZ - 0.015),
        0, -s, 1.25, 1.70, -0.015);
    }

    // ---- the kiosk ----------------------------------------------------------
    // Backed onto the south arcade mid-hall: the one landmark between the west
    // end and the escalator, and the thing that stops the overview being 70 m
    // of identical bays.
    var kx = 14.6, kz = backZ - 0.92;
    var ky = this._ground(kx, kz);
    this._place(K.kiosk(this.noise, R), kx, ky, kz, Math.PI);
    this._collider(kx, ky, kz, [1.28, 1.20, 0.80], 0, 'metal');
    this._occupy(kx, kz, 1.8);
    // it is papered over, and there is a crate of unsold stock still outside
    for (i = 0; i < 3; i++) {
      this._poster('poster', R.int(0, 3), kx - 1.25, ky + 1.05 + i * 0.62, kz + R.range(-0.5, 0.5),
        -1, 0, R.range(0.55, 0.85), R.range(0.75, 1.05), R.range(-0.04, 0.04));
    }
    this._poster('sign', 1, kx, ky + 2.34, kz - 0.80, 0, -1, 1.30, 0.46, 0);
    this._drop(this.B.crate, kx - 1.65, kz - 0.45, { r: 0.5, yaw: 0.3, tilt: 0.02 });
    this._drop(this.B.bin, kx + 1.55, kz - 0.30, { r: 0.34, tilt: 0.06 });
    this._drift(kx + 1.2, kz - 0.9, 6, 0.9);

    // ---- ticket machines, north side, near the east end ---------------------
    for (i = 0; i < 2; i++) {
      var tx = 19.4 + i * 1.15, tz = -(backZ - 0.30);
      var ty = this._ground(tx, tz);
      this._place(K.ticketMachine(R), tx, ty, tz, 0, 1, R.range(-0.01, 0.01));
      this._collider(tx, ty, tz, [0.32, 0.72, 0.26], 0, 'metal');
      this._occupy(tx, tz, 0.6);
      this._stain(0, tx, ty + 1.35, tz + 0.24, 0.45, 0.9, 0, 0, 1);
    }
    this._drift(20.6, -(backZ - 0.75), 5, 0.8);

    // ---- wall furniture -----------------------------------------------------
    // A telephone hood and two extinguishers, on the piers, where the station
    // would have put them.
    this._place(K.phone(), this.piersX[2] + 0.0, platY + 1.15, (backZ - 0.02), Math.PI);
    this._place(K.phone(), this.piersX[7] + 0.0, platY + 1.15, -(backZ - 0.02), 0);
    for (i = 0; i < 4; i++) {
      var ex = this.piersX[1 + i * 2] + (i % 2 ? 0.85 : -0.85);
      var es = (i % 2) ? 1 : -1;
      var ez = es * (backZ - 0.10);
      this._place(K.extinguisher(), ex, platY + 0.95, ez, es > 0 ? Math.PI : 0);
      this._stain(0, ex, platY + 0.92, ez - es * 0.02, 0.30, 0.75, 0, 0, -es);
    }
  };

  // ---- the crash ------------------------------------------------------------
  PropsMetro.prototype._dressWreck = function () {
    var R = this.rng, i;
    var imp = this.trainImpact || { x: -3.6, y: this.hall.platY, z: -3.6 };
    var nose = this.trainNose || { x: -4.2, y: 2.0, z: -4.2 };
    var col = this.collapse;
    var cx = (col.x0 + col.x1) * 0.5, cz = (col.z0 + col.z1) * 0.5;

    // Ceiling panels.  The brief's own prop: the vault came down here and the
    // panels went everywhere, folded where they hit.  Densest under the hole,
    // thinning out across the platform, with three still hanging.
    for (i = 0; i < 26; i++) {
      var t = R.next();
      var pxp = cx + R.gaussian(0, 3.4);
      var pzp = cz + R.gaussian(0, 1.9);
      if (Math.abs(pzp) > this.plat.hz - 0.3) continue;
      this._drop(this.B.panel, pxp, pzp, {
        r: 0.42, yaw: R.range(0, TAU), tilt: 0.22 + t * 0.35,
        scale: R.range(0.75, 1.25), halo: false, lens: true, noClear: true,
        color: debrisTint(R)
      });
    }
    // panels still hanging off the vault edge, folded down
    for (i = 0; i < 3; i++) {
      var hx = col.x0 + 1.2 + i * 3.1;
      var hzp = col.z1 - 0.35;
      this._place(K.panel(this.noise, R, 5.1 + i), hx, this.hall.crown - 0.55, hzp,
        R.range(0, TAU), 1, R.range(0.9, 1.5));
    }

    // Reinforcement torn out of the slab, and the concrete it was in.
    for (i = 0; i < 16; i++) {
      this._drop(this.B.rebar, cx + R.gaussian(0, 3.0), cz + R.gaussian(0, 1.7), {
        r: 0.30, yaw: R.range(0, TAU), tilt: 0.30, scale: R.range(0.7, 1.4),
        halo: false, noClear: true, lens: true, color: debrisTint(R)
      });
    }
    for (i = 0; i < 22; i++) {
      var qx = cx + R.gaussian(0, 3.6), qz = cz + R.gaussian(0, 2.0);
      if (Math.abs(qz) > this.plat.hz - 0.2) continue;
      this._drop(this.B.chunk, qx, qz, {
        r: 0.22, yaw: R.range(0, TAU), tilt: 0.5, scale: R.range(0.5, 1.4),
        halo: false, noClear: true, lens: true, color: debrisTint(R)
      });
    }
    // and the tile that came off the two piers the car demolished
    for (i = 0; i < 60; i++) {
      var tx2 = imp.x + R.gaussian(0, 3.2), tz2 = imp.z + R.gaussian(0, 1.8);
      if (Math.abs(tz2) > this.plat.hz - 0.15) continue;
      this._drop(this.B.shard, tx2, tz2, {
        r: 0.04, yaw: R.range(0, TAU), tilt: 0.35, scale: R.range(0.7, 1.6),
        halo: false, noClear: true, lens: true, color: debrisTint(R)
      });
    }
    // glass out of the cab, thrown forward of the nose
    for (i = 0; i < 34; i++) {
      var ang = R.range(0, TAU), rr = Math.abs(R.gaussian(0, 2.2)) + 0.3;
      this._drop(this.B.glassShard, nose.x + Math.cos(ang) * rr, nose.z + Math.sin(ang) * rr * 0.7, {
        r: 0.04, yaw: R.range(0, TAU), tilt: 0.25, scale: R.range(0.6, 1.5),
        halo: false, noClear: true, lens: true
      });
    }

    // Cable pulled out of the ceiling tray, hanging into the hole.  Three runs,
    // sagging, with cut ends - the only thing in the level that moves in the
    // draught apart from the straps in the saloon.
    var cables = new Item();
    for (i = 0; i < 4; i++) {
      var ax = col.x0 + 0.8 + i * 2.4;
      cables.sag('cable', ax, this.hall.crown - 0.75, col.z1 - 0.1,
        ax + R.range(1.6, 2.6), this.hall.crown - 0.95, col.z0 + R.range(0.6, 1.8),
        R.range(0.5, 1.5), 0.030, 6);
    }
    this._place(cables, 0, 0, 0, 0);

    // The gang cordoned the crash off before they left: barriers across the
    // platform, cones on the walking line, a lamp still lying where it fell.
    for (i = 0; i < 3; i++) {
      var bxx = imp.x - 4.6 + i * 0.15;
      var bzz = -1.2 + i * 1.55;
      this._drop(this.B.barrier, bxx, bzz, {
        r: 0.80, yaw: Math.PI * 0.5 + R.range(-0.10, 0.10), tilt: 0.02,
        collider: [0.10, 0.50, 0.70], material: 'metal'
      });
    }
    for (i = 0; i < 5; i++) {
      this._drop(this.B.cone, imp.x - 5.6 + R.range(-0.5, 2.4), -0.4 + i * 0.95 + R.range(-0.3, 0.3), {
        r: 0.26, yaw: R.range(0, TAU), tilt: R.bool(0.3) ? 0.5 : 0.05
      });
    }
    // soot and scorch where the traction gear arced when it came off
    this._stain(2, imp.x + 0.8, this.hall.platY + 0.008, imp.z + 0.9, 3.4, 2.6, 0, 1, 0, 0.4);
    this._stain(2, nose.x - 1.4, this.hall.platY + 0.008, nose.z + 0.4, 2.2, 1.8, 0, 1, 0, 1.1);
    // and the dust the impact drove into the wet floor, tracked outward
    this._stain(3, imp.x - 2.0, this.hall.platY + 0.006, imp.z + 1.6, 3.0, 2.4, 0, 1, 0, 2.0);
  };

  // ---- the two station trenches --------------------------------------------
  PropsMetro.prototype._dressTrackHalls = function () {
    var R = this.rng, s, i;
    var edge = this.plat.hz, hz = this.hall.hallHz, cz = this.trkCz;
    var x0 = this.hall.x0 + 2, x1 = this.hall.x1 - 2;

    for (s = -1; s <= 1; s += 2) {
      // Drums and bins that went over the platform edge, standing in 26 cm of
      // water against the trench wall - which is where anything that falls in
      // ends up, not in the middle of the track.
      for (i = 0; i < 5; i++) {
        var dx = x0 + R.range(0, 1) * (x1 - x0);
        var dz = s * (hz - R.range(0.7, 1.4));
        this._drop(this.B.drum, dx, dz, { r: 0.5, tilt: R.bool(0.3) ? 0.22 : 0.05 });
      }
      // planks and sleeper offcuts, stranded across the rails
      for (i = 0; i < 7; i++) {
        var px = x0 + R.range(0, 1) * (x1 - x0);
        var pz = s * (cz + R.range(-1.5, 1.5));
        this._drop(this.B.plank, px, pz, {
          r: 0.42, yaw: R.range(0, TAU), tilt: 0.08, halo: false, noClear: true
        });
      }
      // rubbish rafted against the platform coping, which is the upstream face
      for (i = 0; i < 12; i++) {
        var rx = x0 + R.range(0, 1) * (x1 - x0);
        this._raft(rx, s * (edge + R.range(0.25, 0.75)), R.range(0.7, 1.15));
      }
      // silt and biofilm along both waterlines
      for (i = 0; i < 14; i++) {
        this._scum(x0 + R.range(0, 1) * (x1 - x0), s * (edge + R.range(0.15, 0.55)),
          R.range(0.8, 2.0));
        this._scum(x0 + R.range(0, 1) * (x1 - x0), s * (hz - R.range(0.3, 0.9)),
          R.range(0.7, 1.8));
      }
      // the tide mark on the trench wall: this water has been up and down for
      // years and it has left a line
      for (i = 0; i < 9; i++) {
        var wx = x0 + 2 + i * ((x1 - x0 - 4) / 9);
        this._stain(1, wx, this.waterY + R.range(0.55, 0.95), s * (hz - 0.06),
          R.range(2.0, 3.6), R.range(0.6, 1.1), 0, 0, -s);
        if (R.bool(0.6)) {
          this._stain(3, wx + R.range(-1.5, 1.5), this.waterY + R.range(0.30, 0.55),
            s * (hz - 0.06), R.range(1.6, 3.0), R.range(0.5, 0.8), 0, 0, -s);
        }
      }
      // and rust weeping from the cable brackets above it
      for (i = 0; i < 6; i++) {
        this._stain(0, x0 + 3 + R.range(0, 1) * (x1 - x0 - 6), 2.30, s * (hz - 0.06),
          R.range(0.4, 0.8), R.range(1.2, 2.0), 0, 0, -s);
      }
    }

    // A works trolley left on the north road, half derailed, with its load
    // still on it.  The trench needs one object with a silhouette or it is a
    // ditch with rails in it.
    var tx = this.hall.x0 + 8.5, tz = -cz + 0.35;
    var ty = Math.max(this._ground(tx, tz), this.waterY - 0.10);
    this._place(K.trolley(), tx, ty, tz, 0.10, 1, 0.06);
    this._occupy(tx, tz, 1.2);
    this._drop(this.B.drum, tx - 0.25, tz + 0.05, { y: ty + 0.32, r: 0.30, noClear: true, halo: false, tilt: 0.06 });
    this._drop(this.B.pipe, tx + 0.35, tz - 0.10, { y: ty + 0.33, r: 0.30, noClear: true, halo: false, yaw: 0.08, tilt: 0.02 });
    this._scum(tx, tz, 1.6);
  };

  // ---- the running tunnels --------------------------------------------------
  PropsMetro.prototype._dressTunnels = function () {
    var R = this.rng, i, s, t;
    var runs = [
      { x0: this.tunW.endX + 3, x1: this.tunW.portalX - 1.5, dir: -1 },
      { x0: this.tunE.portalX + 1.5, x1: this.tunE.endX - 3, dir: 1 }
    ];
    var walkY = (this.tunW.walkwayY === undefined ? 0.62 : this.tunW.walkwayY) + 0.048;

    for (t = 0; t < runs.length; t++) {
      var run = runs[t];
      if (!(run.x1 > run.x0 + 4)) continue;
      for (s = -1; s <= 1; s += 2) {
        var cz = s * this.trkCz;
        var side = s;                       // the walkway is on the outboard side
        var wz = cz + side * 2.05;

        // Relay cabinets on the walkway, at the spacing they are actually at.
        var nCab = Math.max(1, Math.floor((run.x1 - run.x0) / 11));
        for (i = 0; i < nCab; i++) {
          var sx = run.x0 + 3 + i * 11 + R.range(-1.2, 1.2);
          if (sx > run.x1 - 2) break;
          this._drop(this.B.signal, sx, wz - side * 0.12, {
            y: walkY, r: 0.55, yaw: side > 0 ? Math.PI : 0, tilt: 0.012,
            noClear: true, halo: false, collider: [0.30, 0.55, 0.20], material: 'metal'
          });
          this._stain(0, sx, walkY + 0.95, wz - side * 0.34, 0.4, 0.8, 0, 0, -side);
        }
        // Materials left on the walkway between possessions.
        var nKit = Math.max(2, Math.floor((run.x1 - run.x0) / 7));
        for (i = 0; i < nKit; i++) {
          var kx = run.x0 + 2 + R.range(0, 1) * (run.x1 - run.x0 - 4);
          var kz = wz + R.range(-0.22, 0.22);
          var pick = R.int(0, 5);
          if (pick === 0) {
            this._drop(this.B.pipe, kx, kz, { y: walkY, r: 0.6, yaw: R.range(-0.05, 0.05),
              tilt: 0.01, noClear: true, halo: false });
          } else if (pick === 1) {
            this._drop(this.B.bucket, kx, kz, { y: walkY, r: 0.26, yaw: R.range(0, TAU),
              tilt: R.bool(0.3) ? 0.4 : 0.03, noClear: true, halo: false });
          } else if (pick === 2) {
            this._drop(this.B.crate, kx, kz, { y: walkY, r: 0.5, yaw: R.range(0, TAU),
              tilt: 0.02, noClear: true, halo: false });
          } else if (pick === 3) {
            this._drop(this.B.plank, kx, kz, { y: walkY, r: 0.45, yaw: R.range(-0.15, 0.15),
              tilt: 0.01, noClear: true, halo: false });
          } else if (pick === 4) {
            this._place(K.hoseCoil(), kx, walkY, kz, R.range(0, TAU));
          } else {
            this._drop(this.B.drum, kx, kz, { y: walkY, r: 0.45, tilt: 0.03,
              noClear: true, halo: false });
          }
        }
        // Cable slung between the wall brackets, sagging between fixings, with
        // one run cut and hanging.
        var cabRun = new Item();
        var nSag = Math.max(2, Math.floor((run.x1 - run.x0) / 6));
        for (i = 0; i < nSag; i++) {
          var ax = run.x0 + i * 6, bx2 = ax + 6;
          if (bx2 > run.x1) break;
          cabRun.sag('cable', ax, 2.05, cz - side * 2.28, bx2, 2.05, cz - side * 2.28,
            R.range(0.10, 0.26), 0.026, 5);
        }
        this._place(cabRun, 0, 0, 0, 0);

        // Rafts of rubbish on the water, stranded against the rails and the
        // walkway legs.
        for (i = 0; i < 8; i++) {
          var fx = run.x0 + R.range(0, 1) * (run.x1 - run.x0);
          this._raft(fx, cz + R.range(-1.9, 1.9), R.range(0.7, 1.2));
        }
        for (i = 0; i < 9; i++) {
          this._scum(run.x0 + R.range(0, 1) * (run.x1 - run.x0), cz + R.range(-2.1, 2.1),
            R.range(0.9, 2.2));
        }
        // Tide line and efflorescence on the segment rings.
        for (i = 0; i < 7; i++) {
          var vx = run.x0 + 2 + R.range(0, 1) * (run.x1 - run.x0 - 4);
          this._stain(1, vx, this.waterY + R.range(0.5, 1.3), cz - side * 2.55,
            R.range(1.6, 3.0), R.range(0.7, 1.4), 0, 0, side);
          if (R.bool(0.7)) {
            this._stain(3, vx + R.range(-2, 2), this.waterY + R.range(0.25, 0.6),
              cz + side * 2.55, R.range(1.4, 2.6), R.range(0.5, 0.9), 0, 0, -side);
          }
        }
        // Lime hanging off the ring joints, and the drips that made it.
        for (i = 0; i < 5; i++) {
          var dx2 = run.x0 + 2 + R.range(0, 1) * (run.x1 - run.x0 - 4);
          var dz2 = cz + R.range(-1.2, 1.2);
          this._stalactites(dx2, dz2, 4.35, R.int(2, 4), 0.5);
          if (i < 2) this._drip(dx2, 4.30, dz2, this.waterY, 0.055);
        }
      }
    }

    // A ladder up to a cross-passage door in the west tunnel, and the kit at
    // its foot: this is the hero2 framing's mid-ground and the only thing in it
    // built by a person.
    var lx = this.tunW.portalX - 12.5, lz = -this.trkCz - 2.45;
    this._place(K.ladder(2.35), lx, 0.668, lz, Math.PI * 0.5, 1, -0.05);
    this._place(K.toolbox(), lx + 1.1, 0.668, lz + 0.10, 0.6);
    this._drop(this.B.bucket, lx - 0.9, lz + 0.05, { y: 0.668, r: 0.26, tilt: 0.05, noClear: true, halo: false });
    this._place(K.jerrycan(), lx + 1.9, 0.668, lz - 0.05, -0.4);
  };

  // ---- the escalator hall ---------------------------------------------------
  PropsMetro.prototype._dressEscalator = function () {
    var R = this.rng, i;
    var footY = this.esc.footY === undefined ? this.hall.platY : this.esc.footY;
    var hz = this.esc.hz;
    var incX0 = this.esc.incX0;

    // The ticket line.  Five gates across the lower landing, one folded back,
    // and the queue rail furniture that survived.
    //
    // Set at 6.2 m from the hall mouth rather than 4.6: the hero3 eye stands
    // 1.8 m inside the mouth, and at 4.6 the gates were cropped by the bottom
    // of the frame so only their tops were in shot - a row of blocks.  At 6.2
    // the whole gate, arms included, is in the lower third, which is where the
    // level's own worklight beam crosses it.
    var gx = this.esc.x0 + 6.9;
    for (i = 0; i < 3; i++) {
      var gz = -0.6 + i * 1.5;
      var gy = this._rayGround(gx, gz, footY + 1.2, 2.4, footY);
      this._place(K.turnstile(R), gx + R.range(-0.06, 0.06), gy, gz,
        R.range(-0.03, 0.03), 1, R.range(-0.01, 0.01));
      this._collider(gx, gy, gz, [0.20, 0.50, 0.34], 0, 'metal');
      this._occupy(gx, gz, 0.55);
    }
    // barriers and cones across the gate line: the station was closed, and
    // somebody closed it
    this._drop(this.B.barrier, gx - 1.9, -1.0, { y: footY, r: 0.8, yaw: 0.05, tilt: 0.02,
      collider: [0.70, 0.50, 0.10], material: 'metal' });
    this._drop(this.B.barrier, gx - 1.9, 1.3, { y: footY, r: 0.8, yaw: -0.04, tilt: 0.02,
      collider: [0.70, 0.50, 0.10], material: 'metal' });
    for (i = 0; i < 4; i++) {
      this._drop(this.B.cone, gx - 2.6 + R.range(-0.4, 0.4), -2.6 + i * 1.7 + R.range(-0.3, 0.3),
        { y: footY, r: 0.26, yaw: R.range(0, TAU), tilt: R.bool(0.25) ? 0.45 : 0.04 });
    }
    // and a second cordon at the foot of the incline itself, which is the one
    // place in this framing that has both a light on it and a floor
    for (i = 0; i < 3; i++) {
      this._drop(this.B.cone, incX0 - 2.2 + R.range(-0.6, 0.6), -3.0 + i * 3.0 + R.range(-0.4, 0.4),
        { y: footY, r: 0.26, yaw: R.range(0, TAU), tilt: R.bool(0.3) ? 0.5 : 0.04 });
    }
    this._drop(this.B.barrier, incX0 - 1.6, 2.9, { y: footY, r: 0.8, yaw: 0.9, tilt: 0.03,
      collider: [0.60, 0.50, 0.30], material: 'metal' });
    this._drop(this.B.drum, incX0 - 1.6, -4.2, { y: footY, r: 0.46, tilt: 0.05 });
    this._place(K.hoseCoil(), incX0 - 1.9, footY, 3.9, 0.8);

    // Ticket machines and a bench against the landing walls.
    // BOTH machines on the south wall, and the gate bank pulled to the far side
    // of the hall.  Measured: the level's escalator worklight is 150 cd and this
    // level's exposure puts white at a few lux, so a vertical face within about
    // four metres of it clips flat no matter what its albedo is - the first
    // version put five gates and a machine straight into that cone and took the
    // framing from 1.0% clipped pixels to 3.1%.  Distance is the only control
    // a props file has over somebody else's lamp.
    for (i = 0; i < 2; i++) {
      var s = 1;
      var mx = this.esc.x0 + 2.2 + i * 1.3;
      var mz = s * (hz - 0.45);
      var my = this._rayGround(mx, mz, footY + 1.2, 2.4, footY);
      this._place(K.ticketMachine(R), mx, my, mz, s > 0 ? Math.PI : 0);
      this._collider(mx, my, mz, [0.32, 0.72, 0.26], 0, 'metal');
      this._occupy(mx, mz, 0.6);
      this._stain(0, mx, my + 1.30, mz - s * 0.24, 0.4, 0.9, 0, 0, -s);
      this._poster('poster', R.int(0, 3), mx + 2.4, my + 1.85, s * (hz - 0.04), 0, -s,
        1.0, 1.35, R.range(-0.02, 0.02));
      this._poster('sign', R.int(0, 3), mx + 4.6, my + 2.35, s * (hz - 0.04), 0, -s,
        0.75, 0.38, 0);
    }

    // What a closed ticket hall collects: the cleaner's bucket, a crate of
    // stock nobody came back for, and litter blown against the walls.
    this._drop(this.B.bucket, this.esc.x0 + 6.6, -hz + 0.9, { y: footY, r: 0.26, tilt: 0.30, yaw: 2.2 });
    this._drop(this.B.crate, this.esc.x0 + 7.6, hz - 1.1, { y: footY, r: 0.5, yaw: 0.5, tilt: 0.02 });
    this._drop(this.B.crate, this.esc.x0 + 8.3, hz - 1.3, { y: footY, r: 0.5, yaw: -0.2, tilt: 0.02 });
    this._drop(this.B.bin, this.esc.x0 + 3.1, hz - 0.7, { y: footY, r: 0.34, tilt: 0.10 });
    for (i = 0; i < 5; i++) {
      this._drift(this.esc.x0 + 2 + R.range(0, 7), (R.bool() ? 1 : -1) * (hz - R.range(0.35, 0.9)), 5, 0.8);
    }

    // On the incline itself: a case somebody dropped and did not come back for,
    // and litter caught in the comb plate.  The escalator is hero3's whole
    // subject and it needs something with a scale on it.
    var sx = incX0 + 3.2;
    var sy = footY + (sx - incX0) * ((this.esc.headY - footY) / (this.esc.incX1 - incX0));
    this._drop(this.B.suitcase, sx, -2.40, { y: sy + 0.03, r: 0.3, yaw: 0.8, tilt: 0.16,
      noClear: true, halo: false });
    this._drop(this.B.duffel, incX0 + 1.4, 2.40, {
      y: footY + (1.4) * ((this.esc.headY - footY) / (this.esc.incX1 - incX0)) + 0.03,
      r: 0.28, yaw: 2.1, tilt: 0.12, noClear: true, halo: false });
    for (i = 0; i < 6; i++) {
      var lxx = incX0 - 1.4 + R.range(0, 3.0);
      var lzz = R.pick([-2.4, 0, 2.4]) + R.range(-0.35, 0.35);
      var lyy = footY + Math.max(0, lxx - incX0) * ((this.esc.headY - footY) / (this.esc.incX1 - incX0));
      this._drift(lxx, lzz, 3, 0.4, lyy + 0.02);
    }
  };

  // ---- the overlook gallery -------------------------------------------------
  PropsMetro.prototype._dressGallery = function () {
    var R = this.rng, i;
    var by = this.bal.y;
    var x0 = this.bal.x0 + 0.6, x1 = this.bal.x1 - 0.5;
    // Everything here is read from the OVERVIEW framing at eye height, so it is
    // dressed as what a gallery over a closed station actually holds: stores
    // that were carried up out of the water.
    var sites = [
      [x0 + 0.4, -2.35, 'crate'], [x0 + 0.9, -1.75, 'crate'], [x0 + 1.9, -2.5, 'drum'],
      [x0 + 0.5, 2.30, 'reel'], [x0 + 2.3, 2.05, 'crate'], [x0 + 2.9, -1.2, 'bin']
    ];
    for (i = 0; i < sites.length; i++) {
      var sx = sites[i][0], sz = sites[i][1];
      if (sx > x1) continue;
      var sy = this._rayGround(sx, sz, by + 1.6, 3.0, by);
      var opt = { y: sy, r: 0.5, yaw: R.range(0, TAU), tilt: 0.02, noClear: true, halo: false };
      if (sites[i][2] === 'crate') this._drop(this.B.crate, sx, sz, opt);
      else if (sites[i][2] === 'drum') this._drop(this.B.drum, sx, sz, opt);
      else if (sites[i][2] === 'bin') this._drop(this.B.bin, sx, sz, opt);
      else this._drop(this.B.reel, sx, sz, opt);
    }
    this._place(K.toolbox(), x0 + 1.4, this._rayGround(x0 + 1.4, 0.9, by + 1.6, 3.0, by), 0.9, 0.7);
    this._drift(x0 + 1.6, -0.6, 4, 0.6, by + 0.02);
  };

  // ---- inside the second car ------------------------------------------------
  PropsMetro.prototype._dressSaloon = function () {
    var R = this.rng, i, s;
    var cars = this.cars || [];
    if (!cars.length) return;
    for (var c = 0; c < cars.length; c++) {
      var car = cars[c];
      if (!car || !car.centre) continue;
      var walk = !!car.walkable;
      var cx = car.centre.x, cz = car.centre.z;
      var fy = (car.floorY === undefined ? car.centre.y + 0.90 : car.floorY) + 0.035;
      var yaw = car.yaw || 0;
      var cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      // local -> world for a point on the car's floor.  The cars are rotated in
      // three axes and authored in their own frame, so every placement in here
      // goes through this rather than guessing a world coordinate.
      var W2 = function (lx, lz) {
        return [cx + lx * cosY + lz * sinY, cz - lx * sinY + lz * cosY];
      };

      // Hanging straps.  Authored at their fixing, animated in update: the
      // draught down a running tunnel moves them, and a car full of dead-still
      // straps is a photograph of a model.
      if (this.B.strap) {
        var railZ = 0.86;
        for (i = 0; i < 20; i++) {
          if (!walk && R.bool(0.6)) continue;
          var lx = -7.4 + i * 0.78;
          if (R.bool(0.22)) continue;                 // torn off
          s = R.bool() ? 1 : -1;
          var w = W2(lx, s * railZ);
          var ph = R.range(0, TAU);
          var sy = (car.centre.y + 3.14);
          if (this.B.strap.add(T(w[0], sy, w[1], 0, yaw, 0, 1, 1, 1), wearTint(R))) {
            this._straps.push({ x: w[0], y: sy, z: w[1], yaw: yaw, phase: ph });
          }
        }
      }

      // Advertising panels above the windows, both sides.
      //
      // Raked DOWN 14 degrees, and that is not a decoration: the only light in
      // a saloon is the two runs on the ceiling directly above these panels, so
      // a panel flush with the wall is edge-on to every photon in the car and
      // photographs as a black strip.  Every transit operator on earth rakes
      // them for the same reason - so a standing passenger can read them.
      for (i = 0; i < 5; i++) {
        for (s = -1; s <= 1; s += 2) {
          if (R.bool(0.22)) continue;
          var ax = -7.2 + i * 3.6;
          var aw = W2(ax, s * 1.16);
          // the panel faces INTO the saloon: local -z on the +z side, which is
          // world (-s*sinY, -s*cosY) once the car's yaw is applied
          this._poster('poster', R.int(0, 3), aw[0], car.centre.y + 2.84, aw[1],
            -s * sinY, -s * cosY, 1.30, 0.36, R.range(-0.02, 0.02), -0.24);
        }
      }

      if (!walk) continue;

      // The floor of a car that has stood open for years: paper, bottles,
      // glass under every broken window, one case and one bag.  Paper banks
      // against the seat kicks and in the door wells, which is where a car's
      // own draught puts it - not evenly down the middle of the aisle.
      for (i = 0; i < 30; i++) {
        var px = R.range(-8.0, 8.0);
        var pz = R.bool(0.62) ? R.pick([-0.92, 0.92]) + R.range(-0.16, 0.16) : R.range(-0.9, 0.9);
        var pw = W2(px, pz);
        this._drift(pw[0], pw[1], 1, 0.26, fy);
      }
      for (i = 0; i < 4; i++) {
        var dwx = R.pick([-6.15, -2.05, 2.05, 6.15]);
        var dwz = R.pick([-1, 1]) * R.range(0.75, 1.05);
        var dww = W2(dwx + R.range(-0.5, 0.5), dwz);
        this._drift(dww[0], dww[1], 3, 0.34, fy);
      }
      // And on the bench seats themselves - a folded paper and a bag left on a
      // seat is the most specific "somebody was sitting here" a prop set has,
      // and the seat tops are the one horizontal surface in the car at chest
      // height for the light to find.
      for (i = 0; i < 7; i++) {
        var stx = R.range(-5.4, 5.4);
        var stz = R.pick([-1, 1]) * 0.99;
        var stw = W2(stx, stz);
        this._drift(stw[0], stw[1], R.int(1, 2), 0.24, car.centre.y + 1.395);
      }
      var bgw = W2(-4.6, -0.99);
      this._drop(this.B.duffel, bgw[0], bgw[1], { y: car.centre.y + 1.39, r: 0.26,
        yaw: yaw + 1.4, tilt: 0.05, scale: 0.8, noClear: true, halo: false, dry: true });
      for (i = 0; i < 15; i++) {
        // bottles roll to the low side and stop against the seat kick
        var bw = W2(R.range(-8, 8), R.bool(0.6) ? R.pick([-0.86, 0.86]) : R.range(-1.0, 1.0));
        this._drop(this.B.bottle, bw[0], bw[1], {
          y: fy, r: 0.10, yaw: R.range(0, TAU), tilt: 1.55, noClear: true, halo: false
        });
      }
      for (i = 0; i < 16; i++) {
        var gw = W2(R.range(-8, 8), R.pick([-1.05, 1.05]) + R.range(-0.15, 0.15));
        this._drop(this.B.glassShard, gw[0], gw[1], {
          y: fy, r: 0.03, yaw: R.range(0, TAU), tilt: 0.06, scale: R.range(0.7, 1.4),
          noClear: true, halo: false, lens: true
        });
      }
      // Luggage in the aisle, in the one place a saloon is actually lit: the
      // two car lamps aim DOWN the car at the floor, so anything standing on
      // the floor of the aisle is the only prop in here that gets a key.
      var sw = W2(2.9, -0.55);
      this._drop(this.B.suitcase, sw[0], sw[1], { y: fy, r: 0.35, yaw: yaw + 0.6, tilt: 0.10,
        noClear: true, halo: false });
      var sw2 = W2(-1.8, 0.42);
      this._drop(this.B.suitcase, sw2[0], sw2[1], { y: fy, r: 0.32, yaw: yaw - 1.1, tilt: 0.42,
        noClear: true, halo: false });
      var cw = W2(0.6, -0.62);
      this._drop(this.B.crate, cw[0], cw[1], { y: fy, r: 0.4, yaw: yaw + 0.9, tilt: 0.05,
        noClear: true, halo: false });
      // One object in the NEAR field of the saloon.  The car is a 2.7 m tube
      // with black walls and its only light points down the aisle at the floor,
      // so the floor of the aisle is the only place a prop can be seen at all -
      // and without something within three metres the framing has no scale in
      // it and reads as a corridor rather than as a carriage.
      // LEFT of the aisle, deliberately: the viewmodel owns the right half of a
      // first-person frame, and the first version of this cluster sat behind
      // the gun where nothing could see it.
      //
      // And the clipping in this framing runs the other way from every other
      // one in the level.  Measured: the two car lamps point straight down at
      // the aisle FLOOR from 1.9 m, so the floor is what blows out - taking the
      // near cluster away raised the clipped fraction from 1.72% to 1.88%,
      // because it uncovered more of the hot floor.  Here props are the
      // solution to the exposure rather than the cause of it, so the near end
      // of the aisle carries a crate, a bag and a fallen panel: they break the
      // hotspot up and give the framing its only near-field scale.
      var nw = W2(-2.95, -0.52);
      this._drop(this.B.crate, nw[0], nw[1], { y: fy, r: 0.42, yaw: yaw - 0.4, tilt: 0.06,
        noClear: true, halo: false, collider: [0.40, 0.26, 0.30], material: 'wood' });
      var nw2 = W2(-2.30, -0.90);
      this._drop(this.B.duffel, nw2[0], nw2[1], { y: fy, r: 0.30, yaw: yaw + 2.2, tilt: 0.05,
        noClear: true, halo: false });
      var nw3 = W2(-1.55, 0.30);
      this._drop(this.B.panel, nw3[0], nw3[1], { y: fy, r: 0.36, yaw: yaw + 0.7, tilt: 0.14,
        scale: 0.75, noClear: true, halo: false });
      var nw4 = W2(-0.55, -0.62);
      this._drop(this.B.plank, nw4[0], nw4[1], { y: fy, r: 0.34, yaw: yaw + 1.35, tilt: 0.02,
        noClear: true, halo: false });
      this._drift(nw[0] + 0.35, nw[1] - 0.10, 5, 0.35, fy);
      this._drift(nw3[0], nw3[1] + 0.2, 4, 0.4, fy);
      var pw2 = W2(-0.4, 0.30);
      this._drop(this.B.plank, pw2[0], pw2[1], { y: fy, r: 0.35, yaw: yaw + 0.25, tilt: 0.02,
        noClear: true, halo: false });
      var dw = W2(-3.4, 0.62);
      this._drop(this.B.duffel, dw[0], dw[1], { y: fy, r: 0.30, yaw: yaw - 0.9, tilt: 0.08,
        noClear: true, halo: false });
      var kw = W2(6.2, 0.30);
      this._drop(this.B.panel, kw[0], kw[1], { y: fy, r: 0.4, yaw: yaw + 1.2, tilt: 0.22,
        scale: 0.8, noClear: true, halo: false });
      var kw2 = W2(-5.4, -0.35);
      this._drop(this.B.panel, kw2[0], kw2[1], { y: fy, r: 0.4, yaw: yaw - 0.7, tilt: 0.26,
        scale: 0.72, noClear: true, halo: false });
      // The extinguisher by the gangway door, and the bucket somebody bailed
      // with: the two objects that say people were still working in here after
      // it flooded.
      var ew = W2(-8.2, -1.10);
      this._place(K.extinguisher(), ew[0], fy, ew[1], yaw + Math.PI * 0.5);
      var bw2 = W2(7.4, -0.80);
      this._drop(this.B.bucket, bw2[0], bw2[1], { y: fy, r: 0.26, yaw: yaw + 1.9,
        tilt: 0.35, noClear: true, halo: false });
    }
  };

  // ---- everything the water carries ----------------------------------------
  PropsMetro.prototype._raft = function (x, z, sc) {
    if (!this.B.raft) return null;
    var R = this.rng;
    if (!this._inBounds(x, z, 0.3)) return null;
    if (this._inLens(x, z, 0.5)) return null;
    var y = this.waterY - 0.012;
    var ph = R.range(0, TAU);
    var yaw = R.range(0, TAU);
    if (!this.B.raft.add(T(x, y, z, R.gaussian(0, 0.03), yaw, R.gaussian(0, 0.03),
      sc, sc, sc), wearTint(R))) return null;
    this._rafts.push({ x: x, y: y, z: z, yaw: yaw, s: sc, phase: ph });
    // a raft always has scum round it - it has been there long enough to grow
    if (R.bool(0.6)) this._scum(x + R.range(-0.4, 0.4), z + R.range(-0.4, 0.4), sc * R.range(0.9, 1.6));
    return y;
  };

  PropsMetro.prototype._dressWater = function () {
    var R = this.rng, i, s;
    // The biggest scum mats form where the water is stillest: the dead ends of
    // the trenches, the corners against the end walls, and under the platform
    // overhang where nothing disturbs it.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 5; i++) {
        this._scum(this.hall.x0 + R.range(1.5, 6.0), s * (this.plat.hz + R.range(0.3, 2.6)),
          R.range(1.6, 3.2));
        this._scum(this.hall.x1 - R.range(1.5, 6.0), s * (this.plat.hz + R.range(0.3, 2.6)),
          R.range(1.6, 3.0));
      }
      // rafts jammed into the corner where the trench meets the end wall
      for (i = 0; i < 4; i++) {
        this._raft(this.hall.x0 + R.range(0.8, 3.2), s * (this.trkCz + R.range(-1.6, 1.6)),
          R.range(0.8, 1.3));
        this._raft(this.hall.x1 - R.range(0.8, 3.2), s * (this.trkCz + R.range(-1.6, 1.6)),
          R.range(0.8, 1.3));
      }
    }
    // and against the wreck, which is the biggest obstruction in the water
    if (this.cars && this.cars.length) {
      for (var c = 0; c < this.cars.length; c++) {
        var car = this.cars[c];
        if (!car || !car.centre) continue;
        for (i = 0; i < 5; i++) {
          var t = R.range(-8, 8);
          var sgn = R.bool() ? 1 : -1;
          var wx = car.centre.x + t * Math.cos(car.yaw || 0);
          var wz = car.centre.z - t * Math.sin(car.yaw || 0) + sgn * R.range(1.5, 2.1);
          this._raft(wx, wz, R.range(0.7, 1.1));
          this._scum(wx + R.range(-0.5, 0.5), wz + sgn * R.range(0, 0.5), R.range(1.0, 2.2));
        }
      }
    }
  };

  // ---- litter drift ---------------------------------------------------------
  // Litter does not scatter, it strands.  Every drift is a cluster with a
  // direction: against the thing that stopped it.
  PropsMetro.prototype._drift = function (x, z, n, spread, y) {
    var R = this.rng;
    for (var i = 0; i < n; i++) {
      var b = this.B['litter' + R.int(0, 3)];
      if (!b) continue;
      var dx = x + R.gaussian(0, spread * 0.75);
      var dz = z + R.gaussian(0, spread * 0.55);
      if (!this._inBounds(dx, dz, 0.2)) continue;
      if (this._inLens(dx, dz, 0.25)) continue;
      var gy = (y === undefined ? this._ground(dx, dz) : y) + 0.008 + R.range(0, 0.006);
      _col.setRGB(0.80 + R.range(0, 0.30), 0.80 + R.range(0, 0.26), 0.74 + R.range(0, 0.30));
      b.add(T(dx, gy, dz, R.gaussian(0, 0.10), R.range(0, TAU), R.gaussian(0, 0.10),
        R.range(0.8, 1.5), R.range(0.7, 1.3), R.range(0.8, 1.5)), _col);
    }
  };

  PropsMetro.prototype._dressDrift = function () {
    var R = this.rng, i, s;
    var backZ = this.plat.backZ, edge = this.plat.hz;
    // Along the arcade base, both sides, the whole length: this is the line the
    // draught runs down and where everything ends up.
    for (s = -1; s <= 1; s += 2) {
      for (i = 0; i < 34; i++) {
        var x = this.hall.x0 + 2 + R.range(0, 1) * (this.hall.x1 - this.hall.x0 - 4);
        this._drift(x, s * (backZ - R.range(0.08, 0.55)), R.int(2, 5), 0.55);
      }
      // and along the platform coping, where it stops before going over
      for (i = 0; i < 16; i++) {
        this._drift(this.hall.x0 + 3 + R.range(0, 1) * (this.hall.x1 - this.hall.x0 - 6),
          s * (edge - R.range(0.25, 0.62)), R.int(1, 3), 0.4);
      }
    }
    // In the corners of the hall, where two draughts meet and nothing moves.
    for (i = 0; i < 6; i++) {
      this._drift(this.hall.x0 + R.range(0.8, 3.0), (R.bool() ? 1 : -1) * (backZ - R.range(0.2, 1.2)),
        R.int(4, 8), 0.7);
      this._drift(this.hall.x1 - R.range(0.8, 3.0), (R.bool() ? 1 : -1) * (backZ - R.range(0.2, 1.2)),
        R.int(3, 7), 0.7);
    }
    // Boot-trodden paper on the walking line itself - flattened, single sheets,
    // never heaped.  A swept centre line with nothing whatever on it is not a
    // used platform, it is a corridor somebody hoovered; a heap in the middle
    // of it is somebody's art direction.  One card at a time is the difference.
    for (i = 0; i < 44; i++) {
      this._drift(this.hall.x0 + 4 + R.range(0, 1) * (this.hall.x1 - this.hall.x0 - 8),
        R.range(-2.6, 2.6), 1, 0.35);
    }
    // and the same on the escalator landing and the trench cess
    for (i = 0; i < 10; i++) {
      this._drift(this.esc.x0 + 1.5 + R.range(0, 7.5), R.range(-3.4, 3.4), 1, 0.4,
        this.esc.footY);
    }
  };

  // ---- water coming through the roof ---------------------------------------
  PropsMetro.prototype._stalactites = function (x, z, y, n, spread) {
    var R = this.rng;
    var b = this.B.stalactite;
    if (!b) return;
    for (var i = 0; i < n; i++) {
      var dx = x + R.gaussian(0, spread), dz = z + R.gaussian(0, spread * 0.7);
      b.add(T(dx, y, dz, R.gaussian(0, 0.05), R.range(0, TAU), R.gaussian(0, 0.05),
        R.range(0.7, 1.5), R.range(0.6, 1.6), R.range(0.7, 1.5)), wearTint(R));
    }
  };

  // A thread of falling water plus the ring it makes where it lands.  Two
  // cards and one instance; there is no particle system involved and at 12
  // sites it costs one draw call for all of them.
  PropsMetro.prototype._drip = function (x, yTop, z, yFloor, w) {
    var R = this.rng;
    var h = yTop - yFloor;
    if (!(h > 0.4)) return;
    var uw = w || 0.05;
    var g1 = card(uw, h, 0, 0, 1, Math.max(1, h * 0.55));
    this._dripParts.push(part(g1, Tn(x, yFloor, z, 0, R.range(0, TAU), 0)));
    var g2 = card(uw, h, 0, 0, 1, Math.max(1, h * 0.55));
    this._dripParts.push(part(g2, Tn(x, yFloor, z, 0, R.range(0, TAU) + 1.57, 0)));
    if (this.B.ring && this.B.ring.n < this.B.ring.max) {
      this.B.ring.add(T(x, yFloor + 0.014, z, 0, 0, 0, 0.5, 1, 0.5), WHITE);
      this._rings.push({ x: x, y: yFloor + 0.014, z: z, phase: R.range(0, 1) });
    }
  };

  PropsMetro.prototype._dressWeeps = function () {
    var R = this.rng, i, s;
    var crown = this.hall.crown, platY = this.hall.platY;
    var col = this.collapse;

    // The vent shaft is an open hole to the surface: it rains down it, and it
    // is the one place in the level where the water is visibly ARRIVING.
    this._drip(this.vent.x + 0.35, crown - 0.15, this.vent.z + 0.25, platY, 0.06);
    this._drip(this.vent.x - 0.42, crown - 0.15, this.vent.z - 0.30, platY, 0.045);
    this._stalactites(this.vent.x, this.vent.z, crown - 0.12, 7, 0.85);
    this._stain(1, this.vent.x, platY + 0.006, this.vent.z, 3.4, 3.0, 0, 1, 0, 0.3);

    // The collapse weeps along its whole torn edge.
    for (i = 0; i < 5; i++) {
      var cx = col.x0 + 0.8 + i * ((col.x1 - col.x0 - 1.6) / 4);
      var cz = col.z0 + R.range(0.4, 2.4);
      this._stalactites(cx, cz, crown - 0.45, R.int(2, 5), 0.6);
      if (i % 2 === 0) this._drip(cx + R.range(-0.5, 0.5), crown - 0.55, cz, platY, 0.05);
    }

    // Weeping joints down the length of the vault, on the ribs, where a
    // segmental vault always fails first.
    for (i = 0; i < 7; i++) {
      var vx = this.hall.x0 + 5 + i * ((this.hall.x1 - this.hall.x0 - 10) / 6);
      if (vx > col.x0 - 2 && vx < col.x1 + 2) continue;
      var vz = R.range(-3.2, 3.2);
      this._stalactites(vx, vz, crown - 0.42, R.int(1, 3), 0.45);
      if (R.bool(0.45)) this._drip(vx, crown - 0.50, vz, platY, 0.04);
      // and the streak it leaves down the vault and the arcade below it
      this._stain(1, vx, this.hall.spring - 0.05, (vz > 0 ? 1 : -1) * (this.plat.backZ - 0.02),
        R.range(0.8, 1.6), R.range(1.4, 2.4), 0, 0, vz > 0 ? -1 : 1);
    }

    // Puddle rings on the platform where the drips land, and the mineral halo
    // round each one.
    for (i = 0; i < this._rings.length; i++) {
      var r = this._rings[i];
      this._stain(1, r.x, r.y + 0.004, r.z, R.range(0.9, 1.6), R.range(0.9, 1.6), 0, 1, 0,
        R.range(0, TAU));
    }
  };


  // ==========================================================================
  // COMMIT - merge, count, publish.
  // ==========================================================================
  var STATIC_MAT = {
    steel: 'steel', rust: 'rust', wood: 'wood', concrete: 'concrete', tile: 'tile',
    plastic: 'plastic', rubber: 'rubber', fabric: 'fabric', grate: 'grate',
    glass: 'glass', red: 'red', green: 'green', cream: 'cream', cable: 'cable',
    poster: 'poster', sign: 'sign', stain: 'stain'
  };
  var STATIC_UV = {
    steel: 'painted_metal', rust: 'rusted_metal', wood: 'wood_plank',
    concrete: 'concrete', tile: 'tile', plastic: 'plastic', rubber: 'rubber',
    fabric: 'sandbag', grate: 'steel_grate', glass: 'glass', red: 'painted_metal',
    green: 'painted_metal', cream: 'painted_metal', cable: 'rubber'
  };
  // The card buckets author their own UVs into an atlas; re-projecting them
  // with worldUV would sample the whole sheet across one poster.
  var STATIC_CARD = { poster: 1, sign: 1, stain: 1 };
  // Per-material texel density for the merged one-offs. These batches are in
  // WORLD space and hold a mix of sizes, so they cannot be solved off a
  // bounding box the way the instanced kit is - but they are not a mix of
  // KINDS: `rust` is almost entirely scaffold tube, ladder stile, handrail and
  // bracket, i.e. thin members whose whole read is silhouette plus a specular
  // streak, and at the old flat 500 the library's 3 cm metal detail put one
  // hemispherical bump across a 26 mm tube and made it shimmer along its
  // length. Denser detail on the thin families, coarser on the big flat ones.
  var STATIC_TEXELS = {
    rust: 900, steel: 620, cable: 900, rubber: 900, grate: 700,
    concrete: 300, wood: 480, tile: 900, plastic: 700, glass: 800,
    red: 620, green: 560, cream: 620, fabric: 420
  };

  PropsMetro.prototype._commit = function () {
    var key, i;

    // ---- falling water ------------------------------------------------------
    if (this._dripParts.length) {
      var dg = mergeParts(this._dripParts);
      disposeParts(this._dripParts);
      if (dg) {
        Geo.copyUV1(dg);
        var dm = new THREE.Mesh(dg, this.mats.drip);
        dm.name = 'metro_drips';
        dm.castShadow = false;
        dm.receiveShadow = false;
        dm.renderOrder = 4;
        dm.frustumCulled = false;
        this.root.add(dm);
        this.dripMesh = dm;
      }
    }

    // ---- static merges ------------------------------------------------------
    for (key in this.S) {
      if (!Object.prototype.hasOwnProperty.call(this.S, key)) continue;
      var parts = this.S[key];
      if (!parts || !parts.length) continue;
      var geo = mergeParts(parts);
      disposeParts(parts);
      if (!geo) continue;
      var isCard = !!STATIC_CARD[key];
      if (!isCard) {
        try {
          Geo.worldUV(geo, this._uvScale(STATIC_UV[key] || 'painted_metal',
            STATIC_TEXELS[key] || 500));
        } catch (e) { /* keep the builder's uv */ }
      }
      Geo.copyUV1(geo);
      if (isCard) {
        paintCard(geo, this.noise, key === 'stain' ? 1.0 : 0.90, key === 'stain' ? 0.0 : 0.26);
      } else {
        // A one-off is painted with the same capillary gradient as everything
        // else, measured over its own height rather than a prop's.
        paintWear(geo, {
          noise: this.noise, soak: 0.62, rise: 0.60, drip: 0.10,
          grime: 0.48, edge: 0.20, loY: this.hall.trackY, hiY: 2.6,
          worldOrigin: true
        });
      }
      var mat = this.mats[STATIC_MAT[key]] || this.mats.steel;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'metro_static_' + key;
      mesh.castShadow = !isCard;
      mesh.receiveShadow = true;
      if (isCard) mesh.renderOrder = key === 'stain' ? 2 : 1;
      this.root.add(mesh);
    }

    // ---- instanced batches --------------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      if (!Object.prototype.hasOwnProperty.call(this.B, key)) continue;
      var b = this.B[key];
      if (!b || !b.mesh) continue;                  // Combos carry no mesh
      if (b.full) this.stats.full.push(key + ':' + b.max);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'metro_' + key)) this.stats.instances += b.n;
      else delete this.B[key];
    }
    this._strapMesh = this.B.strap ? this.B.strap.mesh : null;
    this._raftMesh = this.B.raft ? this.B.raft.mesh : null;
    this._ringMesh = this.B.ring ? this.B.ring.mesh : null;

    // ---- book-keeping -------------------------------------------------------
    var draws = 0, tris = 0;
    this.root.traverse(function (o) {
      if (!(o.isMesh || o.isPoints)) return;
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
    this.stats.straps = this._straps.length;
    this.stats.rafts = this._rafts.length;
    this.stats.rings = this._rings.length;

    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise,
    // and it is the only way to see instance-budget overflow, which is silent:
    // Batch.add just returns false and the last pass built gets nothing.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({ st: this.stats, bounds: this.bounds,
          anchors: !!this.A, cars: (this.cars || []).length, lamps: (this.lamps || []).length });
        if (window.console && console.log) console.log('METROPROPS ' + dbg);
        if (typeof document !== 'undefined' && document.body) {
          var d = document.createElement('div');
          d.id = 'metropropstat';
          d.style.display = 'none';
          d.textContent = dbg;
          document.body.appendChild(d);
        }
      }
    } catch (e2) { /* diagnostics never break a build */ }

    try {
      var hm = typeof location !== 'undefined' && /propshide=([A-Za-z0-9_,]+)/.exec(location.search || '');
      if (hm) {
        var want = hm[1].split(',');
        if (want.indexOf('1') >= 0) this.root.visible = false;
        else {
          for (var wi = 0; wi < want.length; wi++) {
            (function (needle, root) {
              root.traverse(function (o) {
                if (o.name && o.name.indexOf(needle) >= 0) o.visible = false;
              });
            })(want[wi], this.root);
          }
        }
      }
    } catch (e3) { /* diagnostics never break a build */ }

    if (this.ctx && this.ctx.bus && this.ctx.bus.emit) {
      this.ctx.bus.emit('props:ready', this);
    }
  };

  // ==========================================================================
  // Per-frame.
  //
  // Four things move, and all four are the same physical fact: a deep tube
  // breathes along its own axis, and there is water arriving through the roof.
  // Nothing here reads a camera and nothing allocates.
  // ==========================================================================
  PropsMetro.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    var t = this.time;

    // The draught.  ctx.weather is inert on this level by contract, so this is
    // a fallback and not a dependency - but if a weather system IS present
    // (someone re-uses this set on a level that has one) its wind drives the
    // same motion rather than a second, contradictory one.
    var w = ctx && ctx.weather;
    var speed = 0.45;
    if (w && typeof w.windSpeed === 'number' && isFinite(w.windSpeed) && w.windSpeed > 0) {
      speed = M.clamp(w.windSpeed * 0.35, 0.25, 3.0);
      if (w.windDir && isFinite(w.windDir.x)) this.windDir.copy(w.windDir);
    }
    this.draught = speed;

    // ---- hanging straps -----------------------------------------------------
    var mesh = this._strapMesh, i, s2;
    if (mesh && this._straps.length) {
      var amp = 0.022 + speed * 0.030;
      for (i = 0; i < this._straps.length && i < mesh.count; i++) {
        s2 = this._straps[i];
        var a1 = Math.sin(t * 0.83 + s2.phase) * amp;
        var a2 = Math.sin(t * 1.47 + s2.phase * 1.7) * amp * 0.55;
        mesh.setMatrixAt(i, T(s2.x, s2.y, s2.z, a1 + a2 * 0.4, s2.yaw, a2 - a1 * 0.3));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // ---- rafts on the water -------------------------------------------------
    // Standing water is not still water: the draught pushes the surface film
    // along the tunnel and everything floating on it turns very slowly.
    var rm = this._raftMesh;
    if (rm && this._rafts.length) {
      var bob = 0.006 + speed * 0.004;
      for (i = 0; i < this._rafts.length && i < rm.count; i++) {
        var r = this._rafts[i];
        var yy = r.y + Math.sin(t * 0.42 + r.phase) * bob;
        var yaw = r.yaw + Math.sin(t * 0.17 + r.phase * 1.3) * (0.04 + speed * 0.03);
        rm.setMatrixAt(i, T(r.x, yy, r.z,
          Math.sin(t * 0.31 + r.phase) * 0.012, yaw,
          Math.cos(t * 0.27 + r.phase * 0.7) * 0.012, r.s, r.s, r.s));
      }
      rm.instanceMatrix.needsUpdate = true;
    }

    // ---- the rings the drips make -------------------------------------------
    var gm = this._ringMesh;
    if (gm && this._rings.length) {
      for (i = 0; i < this._rings.length && i < gm.count; i++) {
        var g2 = this._rings[i];
        var ph = (t * 0.72 + g2.phase) % 1;
        var sc = 0.28 + ph * 1.35;
        gm.setMatrixAt(i, T(g2.x, g2.y, g2.z, 0, g2.phase * 6.28, 0, sc, 1, sc));
        var fade = (1 - ph) * (1 - ph) * 0.9;
        _col.setRGB(fade, fade, fade);
        gm.setColorAt(i, _col);
      }
      gm.instanceMatrix.needsUpdate = true;
      if (gm.instanceColor) gm.instanceColor.needsUpdate = true;
    }

    // ---- the falling water itself -------------------------------------------
    if (this.mats.drip && this.mats.drip.map) {
      var off = this.mats.drip.map.offset;
      off.y = (off.y + dt * 1.35) % 1;
    }
  };

  PropsMetro.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsMetro.prototype.dispose = function () {
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      var k;
      for (k in this.mats) { if (this.mats[k] && this.mats[k].dispose) this.mats[k].dispose(); }
      for (k in this.tex) { if (this.tex[k] && this.tex[k].dispose) this.tex[k].dispose(); }
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('propsM.dispose', e); }
    this.colliders.length = 0;
  };


  GAME.PropsMetro = PropsMetro;
})(window.GAME, window.THREE);
