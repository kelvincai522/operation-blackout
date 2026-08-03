// ============================================================================
// OPERATION BLACKOUT - "AMARG BONEYARD" - set dressing
// Module owner: props_boneyard.  Exports GAME.PropsBoneyard.
//
// level_boneyard.js builds the PLACE: 200 m of heat-cracked slab, thirty-four
// airframes in ruled rows, a hangar, a parts yard, a water tower and a fence.
// This file is what makes it a place somebody WORKS in.
//
// The environment is the opposite of the harbor's in every respect and the
// props have to invert with it:
//
//   * THE ACCUMULANT IS DUST, NOT WATER.  The harbor set writes wetness into
//     the vertex G channel and pools water where props meet the ground.  In a
//     desert at noon the G channel stays at 1.0 (bone dry) everywhere except
//     three fresh hydraulic spills, and the whole budget goes into the B
//     channel - which materials.js blends toward `wearColor`, set here to a
//     pale sand - so every up-facing surface and every edge in the yard is
//     bleached and dusted.  A crisp, saturated, clean prop in this level reads
//     as a decal pasted onto the frame.
//   * SAND MOVES, SO DRIFTS ARE DIRECTIONAL.  Every drift, every bank of
//     tumbleweed and every litter trap is placed on the LEE side of whatever
//     stopped the wind, along the same vector the level's windsock reads.
//   * SHADE IS THE SCARCE RESOURCE.  Anything a human would choose to stand a
//     tool cart, a crate stack or a chair in goes into level.shadeZones - which
//     the level publishes precisely so this file does not have to re-solve the
//     sun.
//
// Constraints that shaped the code, unchanged from the harbor set:
//   * < 80 draw calls for ALL props.  Everything repeated is an InstancedMesh
//     with per-instance rotation, scale and wear jitter; everything one-off is
//     merged per material into ten static batches.
//   * Nothing floats.  Every placement resolves its height through
//     ctx.level.sampleGround / ctx.level.raycast and every site is rejected if
//     a level collider already occupies it.
//   * Nothing derives a position from a camera pose.  Everything hangs off
//     level.anchors, which the level publishes for exactly this reason.  The
//     poses are read ONCE, as a keep-out list, so a prop cannot end up inside
//     the lens.
//   * Every cross-module call is guarded.  ctx.level, ctx.materials and
//     ctx.weather may all be missing; we degrade, never throw.
// ============================================================================
(function (GAME, THREE) {
  'use strict';

  if (!GAME || !THREE) return;

  var M = GAME.Math;
  var Geo = GAME.Geo;

  // --------------------------------------------------------------------------
  // Scratch.  Build-time code runs several thousand placements.
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
  var _colA = new THREE.Color();
  var _colB = new THREE.Color();
  var _bmin = new THREE.Vector3();
  var _bmax = new THREE.Vector3();
  var _rayO = new THREE.Vector3();
  var _rayD = new THREE.Vector3(0, -1, 0);

  var UP = new THREE.Vector3(0, 1, 0);
  var SIDE_X = new THREE.Vector3(1, 0, 0);
  var WHITE = new THREE.Color(1, 1, 1);
  var TAU = Math.PI * 2;

  // --------------------------------------------------------------------------
  // Tinting.  An InstancedMesh colour and a material colour BOTH multiply the
  // albedo map, and the library material already carries a calibrated gain
  // solved from its own map, so a raw mid-tone hex squares the albedo and the
  // prop renders as a cut-out.  Every tint is normalised by its own max channel
  // and pulled back toward white: the hex is a HUE SHIFT, not a second coat.
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
  // there" is the natural description of a brace, a hose or a hydraulic ram.
  function strutM(ax, ay, az, bx, by, bz) {
    _vc.set(bx - ax, by - ay, bz - az);
    var len = _vc.length();
    if (!(len > 1e-6)) len = 1e-6;
    _vd.copy(_vc).multiplyScalar(1 / len);
    _qs.setFromUnitVectors(UP, _vd);
    _vp.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
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
    catch (e) { GAME.logError('propsB.merge', e); return null; }
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
  // as a primitive: a drum that has been kicked round a yard for thirty years
  // does not have a perfectly circular section, and a desert rock is not a
  // sphere.
  function roughen(geo, noise, amount, freq, mode) {
    var p = geo.attributes.position;
    if (!p) return geo;
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

  // A closed 2D profile extruded along Z with fan-triangulated caps.  Wheel
  // chocks, jersey barriers, channel sections, angle iron - anything with a
  // recognisable cross-section rather than a rectangle.
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

  // A cylindrically-UV'd lathe.  THREE.LatheGeometry gives v along the profile
  // and u round the axis, which is exactly what a drum skin, a gas bottle and a
  // cone all want, so anything that carries its own painted texture is one of
  // these rather than a CylinderGeometry.
  function lathe(profile, segs, uRepeat, vRepeat) {
    var pts = [];
    for (var i = 0; i < profile.length; i++) {
      pts.push(new THREE.Vector2(Math.max(1e-4, profile[i][0]), profile[i][1]));
    }
    var g = new THREE.LatheGeometry(pts, segs || 18);
    var uv = g.attributes.uv;
    if (uv && (uRepeat || vRepeat)) {
      for (var k = 0; k < uv.count; k++) {
        uv.setXY(k, uv.getX(k) * (uRepeat || 1), uv.getY(k) * (vRepeat || 1));
      }
      uv.needsUpdate = true;
    }
    return g;
  }

  // Alpha card.  Plants, streamers, litter.  Carries a `v` gradient in uv.y so
  // the wind snippet can pin the base and free the top.
  // `yOff` shifts the card's own origin.  Default 0 puts the base of the card
  // on the pivot, which is what a rooted plant wants; -h/2 centres it, which is
  // what anything ROTATED about its middle (a tumbleweed, a litter scrap) wants
  // - rotating a base-pivoted card and then lifting it is how the first pass
  // ended up with tumbleweed hovering half a metre off the slab.
  function card(w, h, u0, v0, u1, v1, yOff) {
    var hw = w * 0.5;
    var y0 = yOff || 0, y1 = y0 + h;
    var pos = new Float32Array([
      -hw, y0, 0, hw, y0, 0, hw, y1, 0,
      -hw, y0, 0, hw, y1, 0, -hw, y1, 0
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

  // A cached bevelled box.  Perfectly sharp 90-degree edges never catch a
  // highlight, which under a hard overhead key is the single loudest "computer
  // graphics" tell in the level.
  var _boxCache = new Map();
  function bx(w, h, d, bevel) {
    w = Math.max(w, 0.004); h = Math.max(h, 0.004); d = Math.max(d, 0.004);
    if (bevel === undefined) bevel = Math.min(0.012, Math.min(w, Math.min(h, d)) * 0.26);
    var k = w.toFixed(3) + ',' + h.toFixed(3) + ',' + d.toFixed(3) + ',' + bevel.toFixed(3);
    var g = _boxCache.get(k);
    if (!g) { g = Geo.bevelBox(w, h, d, bevel); _boxCache.set(k, g); }
    return g;
  }
  var _cylCache = new Map();
  function cy(rTop, rBot, len, seg, open) {
    seg = seg || 10;
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
  // An instanced prop must end up as ONE geometry per material, and a one-off
  // prop must end up merged into the shared static batch for its material.  The
  // same builder produces both: build the item once into buckets, then either
  // merge each bucket into a batch geometry or push the parts straight into
  // this.S.
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
  Item.prototype.pop = function () { this._st.pop(); return this; };
  Item.prototype.add = function (key, geo, local) {
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
    return this.add(key, bx(w, 1, d === undefined ? w : d, Math.min(0.006, w * 0.25)),
      strutM(ax, ay, az, bx2, by, bz).clone());
  };
  Item.prototype.tube = function (key, r, ax, ay, az, bx2, by, bz, seg) {
    var len = Math.sqrt((bx2 - ax) * (bx2 - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az));
    if (len < 1e-4) return this;
    return this.add(key, cy(r, r, 1, seg || 6), strutM(ax, ay, az, bx2, by, bz).clone());
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
    this.mult = false;          // set by the kit for stock-multiply materials
  }
  // Two colours in, one out.  A Combo can mix a library wear material with a
  // locally-textured multiply one (a crate is stencilled plywood plus timber
  // battens), and the two want OPPOSITE instance jitter: a wear channel is
  // three independent damage masks, a multiply tint is one value.  Passing both
  // and letting each batch take the one it can use is the only way a single
  // placement can drive both without one of them coming out hue-shifted.
  Batch.prototype.add = function (matrix, cWear, cMult) {
    if (this.n >= this.max) { this.full++; return false; }
    this.mesh.setMatrixAt(this.n, matrix);
    // Always write a colour: instanceColor allocates lazily and an unwritten
    // entry can render black depending on three's fill policy.
    this.mesh.setColorAt(this.n, (this.mult ? (cMult || cWear) : cWear) || WHITE);
    this.n++;
    return true;
  };
  Batch.prototype.finish = function (parent, name) {
    if (this.n === 0) { this.mesh.dispose(); return null; }
    this.mesh.count = this.n;
    this.mesh.name = name || 'boneyard_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // A multi-material instanced prop: N parallel batches sharing one matrix.
  // A tyre is rubber AND a steel rim; forcing it into one material to save a
  // draw call costs the object its read.
  function Combo(list) { this.list = list || []; this.n = 0; }
  Combo.prototype.add = function (matrix, cWear, cMult) {
    var ok = false;
    for (var i = 0; i < this.list.length; i++) {
      if (this.list[i] && this.list[i].add(matrix, cWear, cMult)) ok = true;
    }
    if (ok) this.n++;
    return ok;
  };

  // ==========================================================================
  // THE WEAR CHANNEL, INVERTED FOR A DESERT.
  //
  // materials.js reads the geometry `color` attribute as a wear mask, white =
  // pristine:
  //     R -> grime      G -> WETNESS      B -> edge wear (toward `wearColor`)
  //
  // The harbor set spends its budget on G.  Here G is left at 1.0 - this yard
  // has not seen rain in four months and a prop with a wet sheen in it destroys
  // the shot faster than any lighting mistake - and the budget goes to B, with
  // every prop material carrying wearColor 0xc6baa1, a pale sand.  So the B
  // channel is literally the DUST FILM: high on up-facing surfaces (where dust
  // settles), high on outer edges (where thirty summers of blown grit has
  // scoured the paint off), and low on undersides and in crevices, which is
  // where the R channel takes over with soot, hydraulic staining and shade.
  //
  // NOTE: Geo.mergeAll carries only position/normal/uv, so every merged
  // geometry must be painted AFTER the merge.  Every caller here does.
  // ==========================================================================
  function paintDust(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var dust = o.dust === undefined ? 0.34 : o.dust;
    var grime = o.grime === undefined ? 0.22 : o.grime;
    var edge = o.edge === undefined ? 0.20 : o.edge;
    var wet = o.wet === undefined ? 0 : o.wet;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.2 : o.hiY;
    var inner = o.inner === undefined ? 0.08 : o.inner;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var upf = M.saturate(ny);
      var down = M.saturate(-ny);
      // Dust settles: an up-face collects it, an underside keeps none.
      var du = dust * (0.14 + 0.86 * upf * upf);
      // Sand blast and UV: the outer extremities and the up-facing edges.
      var reach = M.saturate((Math.sqrt(x * x + z * z) - inner) * 1.5);
      var ed = edge * (0.22 + 0.88 * reach) * (0.30 + 0.75 * upf);
      // Grime: heavy at the base (splash, tyre wash, spilled oil) and on the
      // undersides where the shade and the leaks are.
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.28 + 0.92 * lowness * lowness) * (0.62 + 0.62 * down);
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        du = du * (1 + nv * 0.55);
        ed = ed * (1 + nv * 1.05);
        gr = gr * (1 + nv * 0.85);
      }
      c[i * 3] = M.saturate(1 - gr);
      c[i * 3 + 1] = M.saturate(1 - wet);          // G: 1.0 = bone dry
      c[i * 3 + 2] = M.saturate(1 - (du + ed * 0.7));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the same three channels.  Multiplies the vertex
  // mask, so this is jitter, not a second coat: 1.0 leaves a channel alone.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.20),      // grime
      1,                           // dry, always
      1 - rng.range(0, 0.26));     // dust / bleach
    return out;
  }

  // ==========================================================================
  // THE SAME DUST, FOR MATERIALS THAT ARE NOT THE LIBRARY'S.
  //
  // Four surfaces in this file carry local canvas art rather than a library
  // material - the drum skin, the crate stencilling, the plants and the
  // streamers - because none of those exists in the shared set.  They are plain
  // MeshStandardMaterials, so `vertexColors` on them is stock three.js: the
  // colour attribute MULTIPLIES ALBEDO, it is not a wear mask.
  //
  // Feeding those four the wear mask (which is what the first pass did, because
  // one paint function served everything) multiplies R by ~0.75, G by 1.0 and B
  // by ~0.55 - a hard green-yellow shift.  Tan plywood crates photographed as
  // olive ammunition boxes and straw weeds photographed as salad.  The channels
  // have to move TOGETHER here, with only a slight warm bias where the dust
  // sits, because that is what a dust film actually does to an albedo.
  // ==========================================================================
  function paintTint(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var dust = o.dust === undefined ? 0.30 : o.dust;
    var grime = o.grime === undefined ? 0.22 : o.grime;
    var noise = o.noise || null;
    var ph = o.seed || 0;
    var loY = o.loY === undefined ? 0 : o.loY;
    var hiY = o.hiY === undefined ? 1.2 : o.hiY;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var ny = n.getY(i);
      var upf = M.saturate(ny), down = M.saturate(-ny);
      // dust LIGHTENS toward sand on the up-faces; grime DARKENS in the shade
      var du = dust * (0.10 + 0.90 * upf * upf);
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.25 + 0.95 * lowness * lowness) * (0.55 + 0.70 * down);
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        du *= (1 + nv * 0.55);
        gr *= (1 + nv * 0.85);
      }
      du = M.saturate(du); gr = M.saturate(gr);
      var v = M.clamp(1 - gr * 0.45, 0.42, 1.0);
      // the warm bias: sand is redder than the surface it lands on, and the
      // separation stays under 8% so nothing hue-shifts
      c[i * 3] = M.clamp(v * (1 + du * 0.070), 0, 1);
      c[i * 3 + 1] = M.clamp(v * (1 + du * 0.020), 0, 1);
      c[i * 3 + 2] = M.clamp(v * (1 - du * 0.055), 0, 1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Instance jitter for the same four: a VALUE change, not a channel change.
  function dustTint(rng, out) {
    out = out || _col;
    var v = 1 - rng.range(0, 0.17);
    var warm = rng.range(-0.025, 0.035);
    out.setRGB(M.saturate(v + warm), M.saturate(v), M.saturate(v - warm));
    return out;
  }

  // Which materials are stock multiply rather than the library's wear shader.
  var MULT = { drumSkin: 1, crateSkin: 1, plant: 1, streamer: 1 };

  // ==========================================================================
  // Local texture kit.
  //
  // Generic surfaces come from ctx.materials by the names the contract fixes.
  // What lives here is props-specific ART the shared library cannot know
  // about: a 200-litre drum's rolling hoops and stencilling, plywood crate
  // markings, creosote and tumbleweed alphas, hydraulic stains, and the red
  // REMOVE BEFORE FLIGHT streamers that are the one saturated colour in a
  // bleached frame.
  // ==========================================================================
  var TX = {};

  TX.canvas = function (w, h) {
    if (typeof document === 'undefined') return null;
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
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  };

  TX.heightFromCanvas = function (canvas) {
    var g = canvas.getContext('2d');
    if (!g) return null;
    var d;
    try { d = g.getImageData(0, 0, canvas.width, canvas.height).data; }
    catch (e) { return null; }
    var n = canvas.width * canvas.height;
    var h = new Float32Array(n);
    for (var i = 0; i < n; i++) h[i] = d[i * 4] / 255;
    return h;
  };

  TX.normalFromHeight = function (h, size, strength) {
    if (!h) return null;
    var data = new Uint8Array(size * size * 4);
    strength = strength === undefined ? 2.0 : strength;
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

  // Shared tileable grunge, composited as a multiply layer under everything
  // generated locally.  One field is far cheaper than running fbm per pixel per
  // material, and it keeps every local texture in the same dirt family.
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
        var u = x * inv * TAU, v = y * inv * TAU;
        var nx = Math.cos(u) * 1.4, ny = Math.sin(u) * 1.4;
        var nz = Math.cos(v) * 1.4, nw = Math.sin(v) * 1.4;
        var n = noise.fbm3(nx * 2.0, ny * 2.0, nz * 2.0, 4, 2.13, 0.52) * 0.6 +
                noise.fbm3(nz * 5.3 + 11, nw * 5.3 - 7, nx * 5.3 + 3, 3, 2.31, 0.5) * 0.4;
        var w = noise.worley2(x * inv * 7 + 3, y * inv * 7 - 2, 1.0);
        n = n * 0.72 + (w.edge - 0.35) * 0.28;
        var val = M.saturate(0.5 + n * (contrast || 1.15));
        var i = (y * size + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = val * 255;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  };

  // Dust settling down a vertical surface: the desert equivalent of the
  // harbor's rust weeping, and the thing that stops painted steel reading as
  // painted board.  Streaks run DOWN from every horizontal ledge because that
  // is where rain (three times a year) carries the dust it has collected.
  TX.dustStreaks = function (g, size, rng, count, alpha, hue) {
    hue = hue || '198,182,150';
    for (var i = 0; i < count; i++) {
      var x = rng.range(0, size), y = rng.range(0, size * 0.55);
      var len = rng.range(size * 0.10, size * 0.48);
      var w = rng.range(1.4, 5.5);
      var grd = g.createLinearGradient(x, y, x, y + len);
      var a = alpha * rng.range(0.45, 1);
      grd.addColorStop(0, 'rgba(' + hue + ',' + a.toFixed(3) + ')');
      grd.addColorStop(0.4, 'rgba(' + hue + ',' + (a * 0.66).toFixed(3) + ')');
      grd.addColorStop(1, 'rgba(' + hue + ',0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(x - w, y);
      g.lineTo(x + w, y);
      g.lineTo(x + w * rng.range(0.2, 0.7), y + len);
      g.lineTo(x - w * rng.range(0.2, 0.7), y + len);
      g.closePath();
      g.fill();
    }
  };

  // Stencilled paint is never solid: erode the edges and punch UV-faded holes
  // through the middle of every stroke.
  TX.erode = function (g, x0, y0, w, h, amount) {
    var img;
    try { img = g.getImageData(x0, y0, w, h); } catch (e) { return; }
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      var px = (i >> 2) % w, py = ((i >> 2) / w) | 0;
      var n = Math.sin(px * 0.29 + py * 0.19) * 0.5 + Math.sin(px * 0.11 - py * 0.37) * 0.5;
      d[i + 3] = d[i + 3] * (1 - amount * M.saturate(n * 0.5 + 0.5));
    }
    g.putImageData(img, x0, y0);
  };

  // Blocky stencil glyphs.  Invented, monospaced, sprayed through a plate - a
  // seven-segment skeleton with the bridges a real stencil plate needs, so it
  // reads as "a code somebody sprayed on" without being any real marking.
  TX.stencilRun = function (g, x, y, cell, count, rng) {
    for (var i = 0; i < count; i++) {
      var ox = x + i * cell * 1.16;
      var seg = rng.int(0, 63) | 1;
      g.lineWidth = Math.max(1, cell * 0.20);
      g.lineCap = 'butt';
      var h = cell * 1.5, w = cell * 0.82;
      var S = [
        [0, 0, 1, 0], [1, 0, 1, 0.5], [1, 0.5, 1, 1], [0, 1, 1, 1],
        [0, 0.5, 0, 1], [0, 0, 0, 0.5], [0.12, 0.5, 0.88, 0.5]
      ];
      g.beginPath();
      for (var s = 0; s < 7; s++) {
        if (!((seg >> s) & 1)) continue;
        g.moveTo(ox + S[s][0] * w, y + S[s][1] * h);
        g.lineTo(ox + S[s][2] * w, y + S[s][3] * h);
      }
      g.stroke();
    }
  };

  // ---- the 200 litre drum --------------------------------------------------
  // u runs round the barrel, v along it.  The two rolling hoops, the chimes at
  // each end, the stencil band and the dent-and-rust field are all painted
  // rather than modelled, which is what lets ninety drums cost one draw call
  // and still read as ninety individual drums.
  TX.drumSkin = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    // four vertical lots across the u axis so a single texture gives four
    // different drum colours; the geometry picks a lot by uv offset
    var lots = ['#4a5a4a', '#7c4a30', '#3f5468', '#8a8378'];
    var band = size / 4;
    for (var L = 0; L < 4; L++) {
      g.fillStyle = lots[L];
      g.fillRect(0, L * band, size, band);
      // vertical roll-forming ribs
      g.globalAlpha = 0.10;
      for (var r = 0; r < size; r += 7) {
        g.fillStyle = (r % 14) ? '#000' : '#fff';
        g.fillRect(r, L * band, 2, band);
      }
      g.globalAlpha = 1;
      // the two rolling hoops, as a lit bead over a shadow
      var hoops = [L * band + band * 0.30, L * band + band * 0.62];
      for (var hh = 0; hh < 2; hh++) {
        var hy = hoops[hh];
        g.fillStyle = 'rgba(0,0,0,0.34)';
        g.fillRect(0, hy - band * 0.055, size, band * 0.11);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fillRect(0, hy - band * 0.030, size, band * 0.022);
      }
      // chimes
      g.fillStyle = 'rgba(0,0,0,0.40)';
      g.fillRect(0, L * band, size, band * 0.035);
      g.fillRect(0, (L + 1) * band - band * 0.035, size, band * 0.035);
      // stencilled contents band
      g.save();
      g.fillStyle = 'rgba(226,222,210,0.86)';
      g.strokeStyle = 'rgba(226,222,210,0.86)';
      g.font = '700 ' + Math.round(band * 0.115) + 'px "Arial Narrow", system-ui, sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      var words = ['HYD FLUID', 'WASTE OIL', 'SOLVENT', 'LUBE 2190'];
      g.fillText(words[L], size * 0.06, L * band + band * 0.46);
      TX.stencilRun(g, size * 0.06, L * band + band * 0.50, band * 0.055, 6, rng);
      g.stroke();
      g.restore();
      // a hazard lozenge on the far side of the barrel
      g.save();
      g.translate(size * 0.62, L * band + band * 0.45);
      g.rotate(Math.PI / 4);
      g.strokeStyle = 'rgba(214,200,120,0.72)';
      g.lineWidth = size * 0.006;
      g.strokeRect(-band * 0.10, -band * 0.10, band * 0.20, band * 0.20);
      g.restore();
      // dents and rust blooms
      g.globalAlpha = 0.42;
      for (var k = 0; k < 46; k++) {
        var dx = rng.range(0, size), dy = L * band + rng.range(band * 0.06, band * 0.94);
        g.fillStyle = rng.bool(0.55) ? 'rgba(96,58,34,1)' : 'rgba(30,28,26,0.7)';
        g.beginPath();
        g.ellipse(dx, dy, rng.range(1.5, 8), rng.range(1.5, 5), rng.range(0, 3.14), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      TX.dustStreaks(g, size, rng, 10, 0.30);
    }
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.46;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- plywood crate -------------------------------------------------------
  TX.crateSkin = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#9a8158';
    g.fillRect(0, 0, size, size);
    // ply grain
    g.globalAlpha = 0.20;
    for (var i = 0; i < 260; i++) {
      g.strokeStyle = rng.bool(0.5) ? '#6a5433' : '#c1a878';
      g.lineWidth = rng.range(0.6, 2.4);
      var y = rng.range(0, size);
      g.beginPath();
      g.moveTo(0, y);
      for (var t = 0; t <= 8; t++) {
        g.lineTo(t * size / 8, y + Math.sin(t * 1.3 + i) * size * 0.006);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    // battens
    g.fillStyle = 'rgba(96,76,48,0.45)';
    g.fillRect(0, 0, size, size * 0.055);
    g.fillRect(0, size * 0.945, size, size * 0.055);
    g.fillRect(0, size * 0.47, size, size * 0.05);
    g.fillRect(0, 0, size * 0.05, size);
    g.fillRect(size * 0.95, 0, size * 0.05, size);
    // stencilled unit codes and a fragile mark
    g.fillStyle = 'rgba(38,40,44,0.86)';
    g.strokeStyle = 'rgba(38,40,44,0.86)';
    g.font = '700 ' + Math.round(size * 0.062) + 'px "Arial Narrow", system-ui, sans-serif';
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText('AMARG DM', size * 0.10, size * 0.20);
    TX.stencilRun(g, size * 0.10, size * 0.27, size * 0.036, 7, rng);
    g.stroke();
    g.font = '700 ' + Math.round(size * 0.048) + 'px "Arial Narrow", system-ui, sans-serif';
    g.fillText('SECT 4  BAY C', size * 0.10, size * 0.62);
    g.fillText('USE NO HOOKS', size * 0.10, size * 0.70);
    // two arrows-up
    g.strokeStyle = 'rgba(38,40,44,0.7)';
    g.lineWidth = size * 0.010;
    for (var a = 0; a < 2; a++) {
      var ax = size * (0.68 + a * 0.13);
      g.beginPath();
      g.moveTo(ax, size * 0.78); g.lineTo(ax, size * 0.60);
      g.moveTo(ax - size * 0.03, size * 0.65); g.lineTo(ax, size * 0.60);
      g.lineTo(ax + size * 0.03, size * 0.65);
      g.stroke();
    }
    TX.erode(g, 0, 0, size, size, 0.34);
    // water/dust staining and split corners
    g.globalAlpha = 0.30;
    for (var s = 0; s < 30; s++) {
      g.fillStyle = rng.bool(0.6) ? '#6c5636' : '#3a3128';
      g.beginPath();
      g.ellipse(rng.range(0, size), rng.range(0, size), rng.range(4, 26), rng.range(3, 14),
        rng.range(0, 3.14), 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    TX.dustStreaks(g, size, rng, 16, 0.34, '206,190,158');
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.44;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ---- desert plant atlas --------------------------------------------------
  // RGBA, four cells.  These are NOT tropical leaf cards recoloured: creosote
  // is a wiry shrub with tiny resinous olive leaflets and a lot of visible bare
  // stem, which is why it reads as desert at 40 m even as a flat card.  Cell 0
  // creosote, 1 dead brittlebush, 2 a joint-weed tuft, 3 tumbleweed.
  TX.plants = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    var H = size / 2;

    function stem(x0, y0, x1, y1, w, col) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo((x0 + x1) * 0.5 + rng.range(-w * 4, w * 4), (y0 + y1) * 0.5, x1, y1);
      g.stroke();
    }
    function leaflet(x, y, r, col) {
      g.fillStyle = col;
      g.beginPath();
      g.ellipse(x, y, r, r * rng.range(0.5, 0.9), rng.range(0, 3.14), 0, TAU);
      g.fill();
    }

    // ---- cell 0: creosote, a live bush ------------------------------------
    (function () {
      var ox = 0, oy = 0;
      var baseX = ox + H * 0.5, baseY = oy + H * 0.98;
      for (var b = 0; b < 13; b++) {
        var ang = -Math.PI * 0.5 + rng.range(-1.05, 1.05);
        var len = H * rng.range(0.42, 0.86);
        var tx = baseX + Math.cos(ang) * len, ty = baseY + Math.sin(ang) * len;
        stem(baseX + rng.range(-4, 4), baseY, tx, ty, H * rng.range(0.008, 0.018), '#5d4c33');
        for (var s = 0; s < 22; s++) {
          var t = rng.range(0.25, 1.0);
          var lx = baseX + (tx - baseX) * t + rng.range(-H * 0.05, H * 0.05);
          var ly = baseY + (ty - baseY) * t + rng.range(-H * 0.05, H * 0.05);
          leaflet(lx, ly, H * rng.range(0.008, 0.020),
            rng.bool(0.62) ? 'rgba(84,96,52,0.96)' : 'rgba(112,116,66,0.94)');
        }
      }
    })();

    // ---- cell 1: dead brittlebush, bleached sticks -------------------------
    (function () {
      var ox = H, oy = 0;
      var baseX = ox + H * 0.5, baseY = oy + H * 0.98;
      for (var b = 0; b < 22; b++) {
        var ang = -Math.PI * 0.5 + rng.range(-1.25, 1.25);
        var len = H * rng.range(0.30, 0.78);
        var tx = baseX + Math.cos(ang) * len, ty = baseY + Math.sin(ang) * len;
        stem(baseX + rng.range(-6, 6), baseY, tx, ty, H * rng.range(0.006, 0.014), '#c2b291');
        if (rng.bool(0.5)) {
          stem(tx, ty, tx + rng.range(-H * 0.16, H * 0.16), ty - rng.range(0, H * 0.18),
            H * 0.006, '#b0a184');
        }
      }
      for (var l = 0; l < 26; l++) {
        leaflet(baseX + rng.gaussian(0, H * 0.16), baseY - rng.range(0, H * 0.5),
          H * rng.range(0.008, 0.017), 'rgba(196,176,132,0.80)');
      }
    })();

    // ---- cell 2: a joint weed tuft ----------------------------------------
    (function () {
      var ox = 0, oy = H;
      var baseX = ox + H * 0.5, baseY = oy + H * 0.97;
      for (var b = 0; b < 34; b++) {
        var ang = -Math.PI * 0.5 + rng.range(-0.95, 0.95);
        var len = H * rng.range(0.32, 0.80);
        var tx = baseX + Math.cos(ang) * len * 0.55, ty = baseY + Math.sin(ang) * len;
        // Straw, not salad.  The first pass drew this at (126,124,70) with
        // nine fat pale seed heads on top and it photographed as a clump of
        // white asparagus in the hero framing - the brightest, greenest and
        // most out-of-palette object in a bleached tan level.  Apron grass in
        // August is dead at the tips and olive only at the base.
        g.strokeStyle = rng.bool(0.40) ? 'rgba(92,90,50,0.95)' : 'rgba(124,108,64,0.93)';
        g.lineWidth = H * rng.range(0.006, 0.013);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(baseX + rng.range(-H * 0.05, H * 0.05), baseY);
        g.quadraticCurveTo(baseX + (tx - baseX) * 0.4, baseY + (ty - baseY) * 0.55, tx, ty);
        g.stroke();
      }
      // a few dry seed heads, small and the same value as the stems
      for (var h = 0; h < 6; h++) {
        leaflet(baseX + rng.gaussian(0, H * 0.13), baseY - rng.range(H * 0.34, H * 0.70),
          H * rng.range(0.008, 0.014), 'rgba(136,120,74,0.82)');
      }
    })();

    // ---- cell 3: tumbleweed, a hollow tangle -------------------------------
    (function () {
      var ox = H, oy = H;
      var cx = ox + H * 0.5, cy = oy + H * 0.5, R = H * 0.44;
      g.lineCap = 'round';
      // 190 branches, not 60, and biased toward the middle.  At sixty it drew a
      // thin ring with a hollow centre and five stacked cards of it photographed
      // as a wire hoop lying on the concrete - closer to a bicycle wheel than to
      // a plant.  Real tumbleweed is a dense tangle that is nearly opaque
      // through the core and only ragged at the rim.
      for (var b = 0; b < 190; b++) {
        var a0 = rng.range(0, TAU), a1 = a0 + rng.range(0.35, 2.1);
        // sqrt-free bias: most chords cross the middle
        var r0 = R * rng.next() * rng.range(0.55, 1.05);
        var r1 = R * rng.next() * rng.range(0.55, 1.05);
        var deep = 1 - Math.max(r0, r1) / R;
        g.strokeStyle = 'rgba(' + Math.round(150 - deep * 44) + ',' +
          Math.round(131 - deep * 40) + ',' + Math.round(90 - deep * 30) + ',' +
          (0.62 + deep * 0.34).toFixed(2) + ')';
        g.lineWidth = H * rng.range(0.004, 0.010);
        g.beginPath();
        g.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
        g.quadraticCurveTo(cx + Math.cos((a0 + a1) * 0.5) * R * rng.range(0.55, 1.02),
          cy + Math.sin((a0 + a1) * 0.5) * R * rng.range(0.55, 1.02),
          cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1);
        g.stroke();
      }
    })();

    return c;
  };

  // ---- ground stain atlas --------------------------------------------------
  // 2x2: hydraulic pool, dry oil drip field, tyre scrub, dust smear.  These are
  // the only marks on 200 m of concrete that say a machine has been here.
  TX.stains = function (size, seed) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.clearRect(0, 0, size, size);
    var H = size / 2;

    function blob(cx, cy, r, col, n) {
      for (var i = 0; i < n; i++) {
        var a = rng.range(0, TAU), d = Math.sqrt(rng.next()) * r;
        var rr = r * rng.range(0.10, 0.34);
        var grd = g.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0,
          cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr);
        grd.addColorStop(0, col);
        grd.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
        g.fillStyle = grd;
        g.beginPath();
        g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, 0, TAU);
        g.fill();
      }
    }
    // 0 - a fresh hydraulic pool, dark and slick with a dry halo
    blob(H * 0.5, H * 0.5, H * 0.30, 'rgba(24,20,16,0.86)', 34);
    blob(H * 0.5, H * 0.5, H * 0.44, 'rgba(58,48,34,0.34)', 26);
    // 1 - a drip field: many small dry spots under an engine
    for (var i = 0; i < 70; i++) {
      var dx = H + rng.gaussian(H * 0.5, H * 0.20);
      var dy = rng.gaussian(H * 0.5, H * 0.20);
      g.fillStyle = 'rgba(40,34,26,' + rng.range(0.18, 0.62).toFixed(3) + ')';
      g.beginPath();
      g.ellipse(dx, dy, rng.range(1.5, 7), rng.range(1.5, 6), rng.range(0, 3), 0, TAU);
      g.fill();
    }
    // 2 - tyre scrub: parallel arcs of rubber laid into concrete
    g.save();
    g.translate(0, H);
    for (var t = 0; t < 12; t++) {
      g.strokeStyle = 'rgba(28,26,25,' + rng.range(0.12, 0.42).toFixed(3) + ')';
      g.lineWidth = rng.range(2, 9);
      g.lineCap = 'round';
      g.beginPath();
      var y0 = rng.range(H * 0.15, H * 0.85);
      g.moveTo(0, y0);
      g.bezierCurveTo(H * 0.3, y0 + rng.range(-14, 14), H * 0.7, y0 + rng.range(-20, 20), H, y0 + rng.range(-8, 8));
      g.stroke();
    }
    g.restore();
    // 3 - blown sand lying on the slab.  PALE rather than dark, which is what
    // makes it the odd one out and what made the first version fail: at 0.44
    // alpha over a 40-blob field it printed as a big soft luminous oval on the
    // concrete that read as a lens artefact rather than as material. Sand on
    // concrete is a thin, grainy, low-contrast veil with visible RIPPLES in it,
    // so the alpha comes down by two thirds and the structure goes up.
    g.save();
    g.translate(H, H);
    for (var s = 0; s < 34; s++) {
      var sx = rng.gaussian(H * 0.5, H * 0.20), sy = rng.gaussian(H * 0.5, H * 0.22);
      var grd2 = g.createRadialGradient(sx, sy, 0, sx, sy, rng.range(H * 0.05, H * 0.18));
      grd2.addColorStop(0, 'rgba(198,176,138,0.17)');
      grd2.addColorStop(1, 'rgba(198,176,138,0)');
      g.fillStyle = grd2;
      g.beginPath();
      g.arc(sx, sy, H * 0.19, 0, TAU);
      g.fill();
    }
    // wind ripples: the thing that says sand rather than smudge
    for (var rp = 0; rp < 26; rp++) {
      g.strokeStyle = 'rgba(206,186,148,' + rng.range(0.06, 0.20).toFixed(3) + ')';
      g.lineWidth = rng.range(1.5, 4.5);
      g.beginPath();
      var ry = rng.range(H * 0.14, H * 0.86);
      g.moveTo(H * 0.06, ry);
      g.bezierCurveTo(H * 0.34, ry + rng.range(-9, 9), H * 0.66, ry + rng.range(-12, 12),
        H * 0.94, ry + rng.range(-6, 6));
      g.stroke();
    }
    g.restore();
    return c;
  };

  // ---- REMOVE BEFORE FLIGHT streamer ---------------------------------------
  // Sun-killed red webbing with white lettering.  Twenty of these across the
  // yard are the only saturated hue in a bleached frame, and they move, which
  // in a level with no rain and no sea is most of the life it has.
  TX.streamer = function (w, h, seed) {
    var c = TX.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#963226';
    g.fillRect(0, 0, w, h);
    // webbing weave
    g.globalAlpha = 0.18;
    for (var i = 0; i < h; i += 3) {
      g.fillStyle = (i % 6) ? '#000' : '#fff';
      g.fillRect(0, i, w, 1.3);
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(232,228,218,0.90)';
    g.font = '700 ' + Math.round(h * 0.44) + 'px "Arial Narrow", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('REMOVE BEFORE FLIGHT', w * 0.5, h * 0.5);
    TX.erode(g, 0, 0, w, h, 0.30);
    // sun bleaching along the free end
    var grd = g.createLinearGradient(w * 0.55, 0, w, 0);
    grd.addColorStop(0, 'rgba(214,196,164,0)');
    grd.addColorStop(1, 'rgba(214,196,164,0.46)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    for (var d = 0; d < 30; d++) {
      g.fillStyle = 'rgba(60,44,36,' + rng.range(0.05, 0.22).toFixed(3) + ')';
      g.fillRect(rng.range(0, w), rng.range(0, h), rng.range(2, 12), rng.range(1, 5));
    }
    return c;
  };

  // ---- placard / sign ------------------------------------------------------
  TX.placard = function (w, h, seed, spec) {
    var c = TX.canvas(w, h);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = spec.bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = spec.bar;
    g.fillRect(0, 0, w, h * 0.16);
    g.fillStyle = spec.fg;
    g.font = '800 ' + Math.round(h * 0.24) + 'px "Arial Narrow", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(spec.a, w * 0.5, h * 0.42);
    g.font = '700 ' + Math.round(h * 0.15) + 'px "Arial Narrow", system-ui, sans-serif';
    g.fillText(spec.b, w * 0.5, h * 0.68);
    g.strokeStyle = spec.fg;
    g.lineWidth = Math.max(1.5, h * 0.02);
    g.strokeRect(h * 0.06, h * 0.24, w - h * 0.12, h * 0.68);
    TX.erode(g, 0, 0, w, h, 0.22);
    g.globalAlpha = 0.42;
    for (var i = 0; i < 30; i++) {
      g.fillStyle = rng.bool(0.5) ? '#8d8271' : '#4a4238';
      g.beginPath();
      g.ellipse(rng.range(0, w), rng.range(0, h), rng.range(1, 6), rng.range(1, 4),
        rng.range(0, 3), 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    return c;
  };

  // ---- hazard diagonals ----------------------------------------------------
  TX.hazard = function (size, seed, grunge) {
    var c = TX.canvas(size, size);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    g.fillStyle = '#b79b34';
    g.fillRect(0, 0, size, size);
    g.save();
    g.translate(size * 0.5, size * 0.5);
    g.rotate(-Math.PI / 4);
    g.translate(-size, -size);
    var band = size * 0.19;
    g.fillStyle = '#22242a';
    for (var i = 0; i < 16; i++) g.fillRect(i * band * 2, 0, band, size * 2);
    g.restore();
    g.globalAlpha = 0.5;
    for (var k = 0; k < 90; k++) {
      g.fillStyle = rng.bool(0.5) ? '#6a6459' : '#7a6a4c';
      g.beginPath();
      g.ellipse(rng.range(0, size), rng.range(0, size), rng.range(1, 5.5),
        rng.range(1, 4), rng.range(0, 3.14), 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    TX.dustStreaks(g, size, rng, 14, 0.34);
    if (grunge) {
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 0.48;
      g.drawImage(grunge, 0, 0, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
    }
    return c;
  };

  // ==========================================================================
  // THE PROP LIBRARY
  //
  // Every entry returns an Item whose buckets are keyed by MATERIAL NAME, so a
  // prop that is genuinely two materials (a tyre on a rim, a cone with a
  // reflective band, a tool cart with a red top) stays two materials instead of
  // being flattened into one grey mass to save a draw call.
  //
  // Everything is authored with y = 0 at the ground, +Z forward, so a placement
  // is a ground height and a yaw and nothing ever floats or interpenetrates by
  // construction.
  // ==========================================================================
  var K = {};

  // ---- wheel chock ---------------------------------------------------------
  // The single most-repeated object in a real boneyard: two per wheel, at every
  // main gear in the yard.  A wedge with a scalloped tyre face, a moulded rib
  // and a rope handle - not a triangle, because at 3 m in the hero framing the
  // triangle is what gives away that nobody modelled it.
  K.chock = function (N, rng) {
    var it = new Item();
    var L = 0.44, H = 0.21, W = 0.30;
    // wedge profile in x/y, extruded along z (the wheel axis is z here)
    var pts = [
      { x: -L * 0.5, y: 0 }, { x: L * 0.5, y: 0 },
      { x: L * 0.5, y: H * 0.30 }, { x: L * 0.16, y: H },
      { x: -L * 0.20, y: H }, { x: -L * 0.5, y: H * 0.34 }
    ];
    it.add('yellow', extrudeProfile(pts, W, 2.2), Tn(0, 0, 0, 0, 0, 0));
    // moulded stiffening ribs across the top face
    for (var i = 0; i < 3; i++) {
      it.box('yellow', L * 0.60, 0.018, 0.030, -L * 0.02, H * 0.86, -W * 0.30 + i * W * 0.30, 0.006);
    }
    // rubber foot strip so it does not read as floating on the slab
    it.box('rubber', L * 0.94, 0.022, W * 0.92, 0, 0.011, 0, 0.006);
    // rope handle: an arc of small segments through the two eyes
    var eyeY = H * 0.62;
    var arc = function (t) {
      return [-L * 0.5 - 0.02 - Math.sin(t * Math.PI) * 0.11,
        eyeY + Math.sin(t * Math.PI) * 0.05 - 0.02,
        M.lerp(-W * 0.28, W * 0.28, t)];
    };
    for (var s = 0; s < 7; s++) {
      var a = arc(s / 7), b = arc((s + 1) / 7);
      it.tube('rubber', 0.011, a[0], a[1], a[2], b[0], b[1], b[2], 5);
    }
    return it;
  };

  // ---- traffic cone --------------------------------------------------------
  // The reflective bands are NOT a second material.  materials.js blends the
  // vertex B channel toward `wearColor`, and the cone material declares a near
  // white one, so writing B = 0 on the band rings paints them for free - which
  // is the difference between a cone and an orange spike.
  K.cone = function (N, rng, knocked) {
    var it = new Item();
    var prof = [
      [0.155, 0.0], [0.155, 0.022], [0.118, 0.028], [0.106, 0.055],
      [0.082, 0.24], [0.062, 0.40], [0.046, 0.55], [0.030, 0.66],
      [0.020, 0.70], [0.0, 0.715]
    ];
    var g = lathe(prof, 12, 1, 1);
    it.add('cone', g, null);
    // square base flange, and the two bands as thin sleeves
    it.box('cone', 0.31, 0.024, 0.31, 0, 0.012, 0, 0.010);
    // The sleeves have to stand PROUD of the cone, not sit on it.  The first
    // pass solved their radii from the same profile the body uses, which put
    // them exactly on the surface: they z-fought into a faint ribbing and the
    // cone photographed as a plain orange spike with no bands at all.  A real
    // sleeve is a wrap over the moulding, so it is 4 mm bigger.
    it.add('coneBand', lathe([[0.1005, 0.128], [0.0862, 0.258]], 12, 1, 1), null);
    it.add('coneBand', lathe([[0.0632, 0.428], [0.0532, 0.523]], 12, 1, 1), null);
    if (knocked) {
      // lay it over: bake the rotation so the batch stays one geometry
      var out = new Item();
      var keys = it.keys();
      for (var k = 0; k < keys.length; k++) {
        var src = it.buckets[keys[k]];
        for (var i = 0; i < src.length; i++) {
          var m = new THREE.Matrix4().multiplyMatrices(
            Tn(0, 0.155, 0, Math.PI * 0.5, 0.4, 0), src[i].matrix);
          out.add(keys[k], src[i].geometry, null);
          out.buckets[keys[k]][out.buckets[keys[k]].length - 1].matrix = m;
        }
      }
      return out;
    }
    return it;
  };

  // ---- 200 litre drum ------------------------------------------------------
  K.drum = function (N, rng, lot, fallen) {
    var it = new Item();
    var R = 0.293, Hh = 0.88;
    // the skin carries four colour lots stacked in v; pick one
    var v0 = lot / 4 + 0.006, v1 = (lot + 1) / 4 - 0.006;
    var prof = [
      [0.0, 0.0], [R * 0.86, 0.0], [R * 0.98, 0.016], [R, 0.05],
      [R * 1.03, 0.28], [R, 0.42], [R * 1.03, 0.60], [R, 0.80],
      [R * 0.98, Hh - 0.016], [R * 0.86, Hh], [0.0, Hh]
    ];
    var g = lathe(prof, 16, 1, 1);
    // remap v into the lot's band
    var uv = g.attributes.uv;
    for (var i = 0; i < uv.count; i++) uv.setY(i, M.lerp(v0, v1, uv.getY(i)));
    uv.needsUpdate = true;
    it.add('drumSkin', g, null);
    // bung plate on the lid
    it.cyl('drumSkin', 0.042, 0.042, 0.020, R * 0.55, Hh + 0.008, 0, 0, 0, 0, 8);
    if (fallen) {
      var out = new Item();
      var keys = it.keys();
      for (var k = 0; k < keys.length; k++) {
        var src = it.buckets[keys[k]];
        for (var j = 0; j < src.length; j++) {
          var m = new THREE.Matrix4().multiplyMatrices(
            Tn(0, R * 1.02, 0, Math.PI * 0.5, 0, 0), src[j].matrix);
          out.add(keys[k], src[j].geometry, null);
          out.buckets[keys[k]][out.buckets[keys[k]].length - 1].matrix = m;
        }
      }
      return out;
    }
    return it;
  };

  // ---- pallet --------------------------------------------------------------
  K.pallet = function (N, rng) {
    var it = new Item();
    var W = 1.20, D = 0.80, TH = 0.022;
    // three bearers
    for (var b = 0; b < 3; b++) {
      var bz = -D * 0.5 + 0.045 + b * (D - 0.09) * 0.5;
      it.box('wood', W, 0.075, 0.09, 0, 0.037 + TH, bz, 0.006);
      // bottom boards
      it.box('wood', W, TH, 0.10, 0, TH * 0.5, bz, 0.005);
    }
    // top deck boards, with the real 5-3-5 gap pattern and two split ends
    for (var i = 0; i < 6; i++) {
      var x = -W * 0.5 + 0.05 + i * (W - 0.10) / 5;
      var wob = (i === 2) ? 0.012 : 0;
      it.boxR('wood', 0.095, TH, D, x, 0.075 + TH * 1.5 + wob, 0, wob * 0.4, 0, 0, 0.005);
    }
    return it;
  };

  // ---- plywood crate -------------------------------------------------------
  K.crate = function (N, rng, w, h, d) {
    var it = new Item();
    // panels rather than one box: the corner battens stand proud, which is what
    // gives a crate its silhouette and its shadow line
    it.box('crateSkin', w, h, d, 0, h * 0.5, 0, 0.008);
    var bt = 0.045;
    for (var i = 0; i < 4; i++) {
      var sx = (i & 1) ? w * 0.5 : -w * 0.5;
      var sz = (i & 2) ? d * 0.5 : -d * 0.5;
      it.box('wood', bt, h, bt, sx, h * 0.5, sz, 0.006);
    }
    // top and bottom rails
    for (var s = 0; s < 2; s++) {
      var sy = s ? h - bt * 0.5 : bt * 0.5;
      it.box('wood', w + 0.008, bt, bt, 0, sy, -d * 0.5, 0.006);
      it.box('wood', w + 0.008, bt, bt, 0, sy, d * 0.5, 0.006);
      it.box('wood', bt, bt, d, -w * 0.5, sy, 0, 0.006);
      it.box('wood', bt, bt, d, w * 0.5, sy, 0, 0.006);
    }
    // a diagonal brace on one face, and skids underneath
    it.strut('wood', -w * 0.5, bt, -d * 0.5 - 0.004, w * 0.5, h - bt, -d * 0.5 - 0.004, 0.038, 0.026);
    it.box('wood', w * 0.9, 0.05, 0.09, 0, -0.025, -d * 0.30, 0.006);
    it.box('wood', w * 0.9, 0.05, 0.09, 0, -0.025, d * 0.30, 0.006);
    return it;
  };

  // ---- aircraft main wheel -------------------------------------------------
  // Tyre and rim as two batches on one matrix.  A main-gear tyre is 1.1 m tall
  // and stacked four high in a parts yard, which makes it one of the few props
  // that gives the frame a human scale reference at 30 m.
  K.wheel = function (N, rng, R) {
    var it = new Item();
    var w = R * 0.62;
    // A torus is authored in the XY plane, i.e. axis along +Z, and the rim and
    // hub below are built axis-along-X.  Rotating the torus about X (which the
    // first pass did) leaves the two halves of the same wheel at ninety degrees
    // to each other - a flat doughnut with a cylinder skewered sideways through
    // it, which is exactly what the capture showed on the tyre stacks.
    var tor = new THREE.TorusGeometry(R * 0.78, R * 0.30, 8, 16);
    it.add('rubber', tor, Tn(0, R, 0, 0, Math.PI * 0.5, 0));
    // tread shoulder: two flattened rings so it is not a doughnut
    it.add('rubber', cy(R * 1.0, R * 1.0, w * 0.62, 16, true), Tn(0, R, 0, 0, 0, Math.PI * 0.5));
    // rim halves and the tie bolts
    it.add('steel', cy(R * 0.52, R * 0.52, w * 0.92, 14), Tn(0, R, 0, 0, 0, Math.PI * 0.5));
    it.add('steel', cy(R * 0.20, R * 0.20, w * 1.02, 10), Tn(0, R, 0, 0, 0, Math.PI * 0.5));
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * TAU;
      it.cyl('steel', 0.018, 0.018, w * 1.06,
        0, R + Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36, 0, 0, Math.PI * 0.5, 6);
    }
    return it;
  };

  // ---- drip pan ------------------------------------------------------------
  K.dripPan = function (N, rng) {
    var it = new Item();
    var w = 0.92, d = 0.66, h = 0.075;
    it.box('steel', w, 0.014, d, 0, 0.010, 0, 0.004);
    it.box('steel', w, h, 0.020, 0, h * 0.5, -d * 0.5, 0.005);
    it.box('steel', w, h, 0.020, 0, h * 0.5, d * 0.5, 0.005);
    it.box('steel', 0.020, h, d, -w * 0.5, h * 0.5, 0, 0.005);
    it.box('steel', 0.020, h, d, w * 0.5, h * 0.5, 0, 0.005);
    // the fluid in it: a slick, and the ONE place the G (wetness) channel is
    // legitimately used in this level
    it.box('spill', w * 0.86, 0.006, d * 0.80, 0, 0.019, 0, 0.002);
    return it;
  };

  // ---- rolling tool cabinet ------------------------------------------------
  K.toolCart = function (N, rng) {
    var it = new Item();
    var w = 0.82, d = 0.48, h = 0.94;
    it.box('red', w, h - 0.10, d, 0, 0.10 + (h - 0.10) * 0.5, 0, 0.012);
    // drawer fronts with pull handles - the reason it is not a red box
    for (var i = 0; i < 5; i++) {
      var y = 0.20 + i * 0.145;
      it.box('red', w + 0.010, 0.125, 0.014, 0, y, d * 0.5 + 0.004, 0.006);
      it.box('steel', w * 0.44, 0.020, 0.026, 0, y, d * 0.5 + 0.018, 0.006);
    }
    // worktop, side rail, castors
    it.box('steel', w + 0.05, 0.026, d + 0.05, 0, h, 0, 0.008);
    it.box('steel', 0.024, 0.19, d * 0.9, -w * 0.5 - 0.04, h - 0.11, 0, 0.006);
    for (var c = 0; c < 4; c++) {
      var cx = (c & 1) ? w * 0.38 : -w * 0.38;
      var cz = (c & 2) ? d * 0.32 : -d * 0.32;
      it.cyl('rubber', 0.050, 0.050, 0.032, cx, 0.050, cz, 0, 0, Math.PI * 0.5, 8);
      it.box('steel', 0.030, 0.055, 0.030, cx, 0.082, cz, 0.006);
    }
    // clutter on the lid: a rag and a socket tray
    it.box('steel', 0.30, 0.030, 0.20, w * 0.18, h + 0.028, -d * 0.14, 0.006);
    it.boxR('canvasProp', 0.22, 0.014, 0.17, -w * 0.22, h + 0.020, d * 0.12, 0.05, 0.4, -0.03, 0.004);
    return it;
  };

  // ---- maintenance ladder --------------------------------------------------
  K.ladder = function (N, rng, h) {
    var it = new Item();
    var w = 0.44;
    for (var s = 0; s < 2; s++) {
      var sx = s ? w * 0.5 : -w * 0.5;
      it.boxR('alu', 0.048, h, 0.062, sx, h * 0.5, 0, 0, 0, 0, 0.008);
      it.box('rubber', 0.055, 0.028, 0.070, sx, 0.014, 0, 0.006);
    }
    var n = Math.max(3, Math.round(h / 0.28));
    for (var i = 1; i < n; i++) {
      it.cyl('alu', 0.017, 0.017, w, 0, i * h / n, 0, 0, 0, Math.PI * 0.5, 8);
    }
    // a rubber-shod standoff at the top so it leans on a fuselage without
    // marking it - a real detail, and it stops the ladder reading as a stencil
    it.box('rubber', w + 0.10, 0.055, 0.055, 0, h - 0.06, -0.10, 0.010);
    it.strut('alu', -w * 0.5, h - 0.06, 0, -w * 0.5 - 0.03, h - 0.06, -0.10, 0.026);
    it.strut('alu', w * 0.5, h - 0.06, 0, w * 0.5 + 0.03, h - 0.06, -0.10, 0.026);
    return it;
  };

  // ---- gas cylinder --------------------------------------------------------
  K.gasBottle = function (N, rng) {
    var it = new Item();
    var R = 0.115, Hh = 1.32;
    var prof = [
      [0.0, 0.0], [R * 0.94, 0.0], [R, 0.03], [R, Hh - 0.22],
      [R * 0.92, Hh - 0.10], [R * 0.55, Hh - 0.02], [R * 0.32, Hh + 0.02],
      [R * 0.30, Hh + 0.10], [0.0, Hh + 0.12]
    ];
    it.add('gas', lathe(prof, 12, 1, 1), null);
    // neck ring and valve guard
    it.cyl('steel', R * 0.46, R * 0.46, 0.11, 0, Hh + 0.09, 0, 0, 0, 0, 10);
    it.cyl('steel', R * 0.52, R * 0.52, 0.030, 0, Hh + 0.15, 0, 0, 0, 0, 10);
    it.box('steel', 0.055, 0.035, 0.10, R * 0.30, Hh + 0.06, 0, 0.008);
    return it;
  };

  // ---- jerrycan ------------------------------------------------------------
  K.jerrycan = function (N, rng) {
    var it = new Item();
    var w = 0.17, h = 0.47, d = 0.34;
    it.box('olive', w, h, d, 0, h * 0.5, 0, 0.020);
    // the pressed X on both faces
    for (var s = 0; s < 2; s++) {
      var sx = s ? w * 0.5 : -w * 0.5;
      it.add('olive', bx(0.012, 0.30, 0.030, 0.004),
        Tn(sx, h * 0.5, 0, 0, 0, 0.72));
      it.add('olive', bx(0.012, 0.30, 0.030, 0.004),
        Tn(sx, h * 0.5, 0, 0, 0, -0.72));
    }
    // three-handle bar and the spout
    it.box('olive', w * 0.9, 0.030, 0.20, 0, h + 0.020, -d * 0.10, 0.008);
    it.cyl('olive', 0.038, 0.042, 0.055, 0, h + 0.045, d * 0.30, 0, 0, 0, 8);
    return it;
  };

  // ---- stackable parts bin -------------------------------------------------
  K.partsBin = function (N, rng) {
    var it = new Item();
    var w = 0.40, h = 0.20, d = 0.30;
    it.boxR('binPlastic', w, h, d, 0, h * 0.5, 0, 0, 0, 0, 0.018);
    // the tapered front lip and the label pocket
    it.box('binPlastic', w * 0.94, 0.024, 0.016, 0, h - 0.012, -d * 0.5, 0.006);
    it.box('binPlastic', w * 0.55, 0.075, 0.010, 0, h * 0.46, -d * 0.5 - 0.006, 0.004);
    // stacking feet
    for (var i = 0; i < 4; i++) {
      it.box('binPlastic', 0.05, 0.022, 0.05,
        (i & 1) ? w * 0.36 : -w * 0.36, 0.011, (i & 2) ? d * 0.32 : -d * 0.32, 0.006);
    }
    return it;
  };

  // ---- jersey barrier ------------------------------------------------------
  K.barrier = function (N, rng) {
    var it = new Item();
    var h = 0.82, len = 2.4;
    var pts = [
      { x: -0.30, y: 0 }, { x: 0.30, y: 0 }, { x: 0.30, y: 0.075 },
      { x: 0.13, y: 0.34 }, { x: 0.095, y: h }, { x: -0.095, y: h },
      { x: -0.13, y: 0.34 }, { x: -0.30, y: 0.075 }
    ];
    var g = extrudeProfile(pts, len, 1.6);
    roughen(g, N, 0.008, 1.4);
    it.add('concreteProp', g, Tn(0, 0, 0, 0, Math.PI * 0.5, 0));
    // lifting eyes and the joint plate on one end
    it.cyl('rustProp', 0.014, 0.014, 0.16, -len * 0.24, h + 0.045, 0, Math.PI * 0.5, 0, 0, 6);
    it.cyl('rustProp', 0.014, 0.014, 0.16, len * 0.24, h + 0.045, 0, Math.PI * 0.5, 0, 0, 6);
    it.box('rustProp', 0.026, 0.34, 0.24, len * 0.5, 0.30, 0, 0.006);
    return it;
  };

  // ---- salvage: a torn skin panel ------------------------------------------
  // Curved, because a fuselage panel is a piece of a cylinder and a flat plate
  // reads as sheet metal off a shed.  Leaned against a rack or a hulk it is one
  // of the most boneyard-specific objects there is.
  K.panel = function (N, rng, seed) {
    var it = new Item();
    var r = new GAME.RNG(seed | 0);
    var W = r.range(1.0, 1.8), Hh = r.range(0.8, 1.5), R = r.range(1.4, 3.2);
    var nx = 7, ny = 4;
    var pos = [], nor = [], uv = [];
    var i, j;
    var grid = [];
    for (j = 0; j <= ny; j++) {
      var row = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx, v = j / ny;
        var a = (u - 0.5) * (W / R);
        // a torn, non-rectangular outline
        var tearL = r.range(0, 0.10), tearR = r.range(0, 0.10);
        var vv = v * (1 - (u < 0.5 ? tearL * (1 - u * 2) : tearR * (u * 2 - 1)) * 0.35);
        row.push([Math.sin(a) * R, vv * Hh, (Math.cos(a) - 1) * R * 0.5]);
      }
      grid.push(row);
    }
    function push(p, n, u, v) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); uv.push(u, v); }
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var a0 = grid[j][i], b0 = grid[j][i + 1], c0 = grid[j + 1][i], d0 = grid[j + 1][i + 1];
        var ux = b0[0] - a0[0], uy = b0[1] - a0[1], uz = b0[2] - a0[2];
        var vx = c0[0] - a0[0], vy = c0[1] - a0[1], vz = c0[2] - a0[2];
        var Nx = uy * vz - uz * vy, Ny = uz * vx - ux * vz, Nz = ux * vy - uy * vx;
        var l = Math.sqrt(Nx * Nx + Ny * Ny + Nz * Nz) || 1;
        var nn = [Nx / l, Ny / l, Nz / l];
        push(a0, nn, i / nx, j / ny); push(c0, nn, i / nx, (j + 1) / ny); push(b0, nn, (i + 1) / nx, j / ny);
        push(b0, nn, (i + 1) / nx, j / ny); push(c0, nn, i / nx, (j + 1) / ny); push(d0, nn, (i + 1) / nx, (j + 1) / ny);
        // and the back face, so a leaning panel is not see-through
        var bn = [-nn[0], -nn[1], -nn[2]];
        push(a0, bn, i / nx, j / ny); push(b0, bn, (i + 1) / nx, j / ny); push(c0, bn, i / nx, (j + 1) / ny);
        push(b0, bn, (i + 1) / nx, j / ny); push(d0, bn, (i + 1) / nx, (j + 1) / ny); push(c0, bn, i / nx, (j + 1) / ny);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    it.add('alu', g, null);
    // the internal stringers along the back - what you actually see when a
    // panel is stood on edge, and the reason it is not a bent card
    for (i = 0; i < 3; i++) {
      var sy = Hh * (0.22 + i * 0.30);
      it.boxR('alu', W * 0.92, 0.030, 0.045, 0, sy, -0.05, 0, 0, 0, 0.006);
    }
    return it;
  };

  // ---- scrap offcut --------------------------------------------------------
  K.scrap = function (N, rng, seed) {
    var it = new Item();
    var r = new GAME.RNG(seed | 0);
    var kind = r.int(0, 2);
    if (kind === 0) {
      // a bent plate
      var w = r.range(0.25, 0.75), d = r.range(0.18, 0.55);
      it.boxR('alu', w, 0.010, d, 0, 0.006, 0, 0, 0, 0, 0.003);
      it.boxR('alu', w * 0.5, 0.010, d, w * 0.35, 0.05, 0, 0, 0, -0.9, 0.003);
    } else if (kind === 1) {
      // a length of extruded angle
      var L2 = r.range(0.4, 1.2);
      it.boxR('alu', 0.055, 0.008, L2, 0, 0.012, 0, 0, r.range(0, 3.1), 0, 0.003);
      it.boxR('alu', 0.008, 0.055, L2, 0.026, 0.036, 0, 0, 0, 0, 0.003);
    } else {
      // a crushed duct section
      var R2 = r.range(0.08, 0.20);
      it.add('alu', cy(R2, R2 * 0.75, r.range(0.3, 0.8), 8, true),
        Tn(0, R2 * 0.8, 0, Math.PI * 0.5, r.range(0, 3.1), 0.2));
    }
    return it;
  };

  // ---- ducting / pipe ------------------------------------------------------
  K.duct = function (N, rng) {
    var it = new Item();
    var R = 0.19, L = 1.6;
    it.add('alu', cy(R, R, L, 12, true), Tn(0, R, 0, Math.PI * 0.5, 0, 0));
    it.cyl('alu', R * 1.12, R * 1.12, 0.030, 0, R, -L * 0.5, Math.PI * 0.5, 0, 0, 12);
    it.cyl('alu', R * 1.12, R * 1.12, 0.030, 0, R, L * 0.5, Math.PI * 0.5, 0, 0, 12);
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * TAU;
      it.cyl('alu', 0.012, 0.012, 0.020,
        Math.cos(a) * R * 1.05, R + Math.sin(a) * R * 1.05, -L * 0.5, Math.PI * 0.5, 0, 0, 5);
    }
    return it;
  };

  // ---- compressor spool ----------------------------------------------------
  // A gutted engine's rotating assembly, lying on the ground.  Nothing else in
  // the kit says "these aeroplanes are being taken apart" as directly.
  K.spool = function (N, rng) {
    var it = new Item();
    var R = 0.44;
    it.cyl('steel', 0.16, 0.16, 0.95, 0, R * 0.55, 0, Math.PI * 0.5, 0, 0, 12);
    for (var s = 0; s < 4; s++) {
      var sz = -0.34 + s * 0.23;
      it.cyl('steel', R * (0.55 + s * 0.11), R * (0.55 + s * 0.11), 0.030,
        0, R * 0.55, sz, Math.PI * 0.5, 0, 0, 14);
      // blade ring, hinted as a thin skirt rather than modelled per blade
      for (var b = 0; b < 14; b++) {
        var a = (b / 14) * TAU;
        var rr = R * (0.55 + s * 0.11);
        it.add('alu', bx(0.028, 0.10, 0.020, 0.004),
          Tn(Math.cos(a) * rr, R * 0.55 + Math.sin(a) * rr, sz, 0, 0, a + 0.5));
      }
    }
    return it;
  };

  // ---- bucket --------------------------------------------------------------
  K.bucket = function (N, rng) {
    var it = new Item();
    it.add('steel', lathe([[0.0, 0.0], [0.115, 0.0], [0.145, 0.28], [0.152, 0.30], [0.143, 0.30]],
      10, 1, 1), null);
    var hp0 = function (t) { return [M.lerp(-0.145, 0.145, t), 0.30 + Math.sin(t * Math.PI) * 0.13, 0]; };
    for (var s = 0; s < 5; s++) {
      var a = hp0(s / 5), b = hp0((s + 1) / 5);
      it.tube('steel', 0.008, a[0], a[1], a[2], b[0], b[1], b[2], 5);
    }
    return it;
  };

  // ---- small step platform -------------------------------------------------
  K.stepStand = function (N, rng) {
    var it = new Item();
    var w = 0.72, d = 0.62, h = 0.62;
    for (var i = 0; i < 4; i++) {
      var lx = (i & 1) ? w * 0.5 - 0.05 : -w * 0.5 + 0.05;
      var lz = (i & 2) ? d * 0.5 - 0.05 : -d * 0.5 + 0.05;
      it.box('yellow', 0.048, h, 0.048, lx, h * 0.5, lz, 0.008);
      it.cyl('rubber', 0.032, 0.032, 0.018, lx, 0.009, lz, 0, 0, 0, 6);
    }
    it.box('yellow', w, 0.030, d, 0, h, 0, 0.008);
    it.box('yellow', w, 0.026, d * 0.44, 0, h * 0.52, d * 0.28, 0.008);
    for (var r = 0; r < 3; r++) {
      it.box('yellow', w, 0.024, 0.024, 0, h + 0.30 + r * 0.24, -d * 0.5 + 0.05, 0.006);
    }
    it.box('yellow', 0.024, 0.80, 0.024, -w * 0.5 + 0.05, h + 0.40, -d * 0.5 + 0.05, 0.006);
    it.box('yellow', 0.024, 0.80, 0.024, w * 0.5 - 0.05, h + 0.40, -d * 0.5 + 0.05, 0.006);
    return it;
  };

  // ---- wheeled fire extinguisher -------------------------------------------
  K.fireExt = function (N, rng) {
    var it = new Item();
    it.add('red', lathe([[0.0, 0.16], [0.155, 0.20], [0.17, 0.40], [0.17, 0.88],
      [0.13, 0.98], [0.055, 1.02], [0.0, 1.03]], 12, 1, 1), null);
    // frame, wheels, hose
    it.box('steel', 0.42, 0.040, 0.040, 0, 0.14, 0, 0.008);
    it.cyl('rubber', 0.16, 0.16, 0.040, -0.24, 0.16, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('rubber', 0.16, 0.16, 0.040, 0.24, 0.16, 0, 0, 0, Math.PI * 0.5, 10);
    it.strut('steel', -0.16, 0.16, 0, -0.16, 1.05, -0.02, 0.028);
    it.strut('steel', 0.16, 0.16, 0, 0.16, 1.05, -0.02, 0.028);
    it.box('steel', 0.40, 0.030, 0.030, 0, 1.06, -0.02, 0.006);
    var hose = function (t) {
      var a = t * Math.PI * 2.4;
      return [Math.cos(a) * 0.20, 0.62 + t * 0.12, 0.18 + Math.sin(a) * 0.10];
    };
    for (var s = 0; s < 8; s++) {
      var a2 = hose(s / 8), b2 = hose((s + 1) / 8);
      it.tube('rubber', 0.016, a2[0], a2[1], a2[2], b2[0], b2[1], b2[2], 5);
    }
    return it;
  };

  // ---- portable work light -------------------------------------------------
  K.workLight = function (N, rng) {
    var it = new Item();
    var h = 1.62;
    it.cyl('steel', 0.030, 0.030, h, 0, h * 0.5, 0, 0, 0, 0, 8);
    for (var i = 0; i < 3; i++) {
      var a = (i / 3) * TAU;
      it.strut('steel', 0, h * 0.34, 0, Math.cos(a) * 0.34, 0.02, Math.sin(a) * 0.34, 0.026);
    }
    it.box('steel', 0.44, 0.030, 0.030, 0, h, 0, 0.006);
    for (var s = 0; s < 2; s++) {
      var sx = s ? 0.18 : -0.18;
      it.boxR('yellow', 0.22, 0.16, 0.11, sx, h - 0.07, 0, 0.34, 0, 0, 0.012);
      it.boxR('lamp', 0.18, 0.13, 0.012, sx, h - 0.10, 0.055, 0.34, 0, 0, 0.004);
    }
    return it;
  };

  // ---- sand drift ----------------------------------------------------------
  // NOT a symmetric mound.  A drift has a long shallow windward ramp and a
  // short steep lee slip-face, and getting that round the right way is what
  // makes forty of them read as one wind rather than as forty piles.  +Z is
  // downwind, so the slip face is on +Z.
  K.drift = function (N, rng, seed) {
    var it = new Item();
    var r = new GAME.RNG(seed | 0);
    var W = r.range(1.6, 3.4), Dw = r.range(1.5, 3.0), Hh = r.range(0.16, 0.42);
    var nx = 9, nz = 8;
    var pos = [], nor = [], uv = [];
    var grid = [], i, j;
    for (j = 0; j <= nz; j++) {
      var row = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx * 2 - 1;              // -1..1 across
        var v = j / nz * 2 - 1;              // -1 windward .. +1 lee
        var rad = Math.sqrt(u * u + v * v * (v > 0 ? 1.9 : 0.55));
        var hgt = Math.max(0, 1 - rad);
        hgt = Math.pow(hgt, v > 0 ? 0.62 : 1.25);
        var wob = N.fbm2(u * 2.2 + seed, v * 2.2 - seed, 3) * 0.22;
        var y = Hh * hgt * (1 + wob);
        row.push([u * W * 0.5, Math.max(0, y), v * Dw * 0.5]);
      }
      grid.push(row);
    }
    function push(p, n, u, v) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); uv.push(u, v); }
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var A = grid[j][i], B = grid[j][i + 1], C = grid[j + 1][i], D = grid[j + 1][i + 1];
        var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
        var vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        var Nx = uy * vz - uz * vy, Ny = uz * vx - ux * vz, Nz = ux * vy - uy * vx;
        var l = Math.sqrt(Nx * Nx + Ny * Ny + Nz * Nz) || 1;
        var nn = [Nx / l, Ny / l, Nz / l];
        if (nn[1] < 0) { nn[0] = -nn[0]; nn[1] = -nn[1]; nn[2] = -nn[2]; }
        push(A, nn, A[0], A[2]); push(C, nn, C[0], C[2]); push(B, nn, B[0], B[2]);
        push(B, nn, B[0], B[2]); push(C, nn, C[0], C[2]); push(D, nn, D[0], D[2]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    it.add('sandProp', g, null);
    return it;
  };

  // ---- desert rock ---------------------------------------------------------
  K.rock = function (N, rng, seed) {
    var it = new Item();
    var r = new GAME.RNG(seed | 0);
    var R = r.range(0.14, 0.46);
    var g = new THREE.IcosahedronGeometry(R, 1);
    roughen(g, N, R * 0.42, 3.4 / R);
    // squash it: a desert cobble sits, it does not perch
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      p.setY(i, p.getY(i) * r.range(0.52, 0.72) + R * 0.42);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    it.add('rockProp', g, null);
    return it;
  };

  // ---- plants --------------------------------------------------------------
  // Cross-cards, but not the two-plane X that gives foliage away from above:
  // five cards on an irregular fan with a horizontal top card, so an overhead
  // key finds something to light and the overview framing (which looks DOWN on
  // everything) does not see a row of paper.
  K.plant = function (N, rng, cell, w, h, cards) {
    var it = new Item();
    var u0 = (cell % 2) * 0.5 + 0.004, v0 = 1 - ((cell / 2 | 0) + 1) * 0.5 + 0.004;
    var u1 = u0 + 0.5 - 0.008, v1 = v0 + 0.5 - 0.008;
    var n = cards || 4;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI + rng.range(-0.16, 0.16);
      var sc = 1 - (i % 2) * 0.16;
      it.add('plant', card(w * sc, h * sc, u0, v0, u1, v1),
        Tn(rng.range(-w * 0.10, w * 0.10), 0, rng.range(-w * 0.10, w * 0.10), 0, a, 0));
    }
    // one near-horizontal card through the crown
    it.add('plant', card(w * 0.85, h * 0.62, u0, v0, u1, v1),
      Tn(0, h * 0.44, 0, -1.32, rng.range(0, 3.1), 0));
    return it;
  };

  // ---- tumbleweed ----------------------------------------------------------
  K.tumbleweed = function (N, rng, R) {
    var it = new Item();
    // Five cards, each squashed on a different axis.  Equal circular cards
    // stack into a perfect disc from every angle, which is the one shape a
    // wind-rolled tangle never has.
    for (var i = 0; i < 5; i++) {
      var a = (i / 5) * Math.PI;
      var sx = rng.range(0.82, 1.10), sy = rng.range(0.78, 1.06);
      it.add('plant', card(R * 2 * sx, R * 2 * sy, 0.504, 0.004, 0.996, 0.496, -R * sy),
        Tn(rng.range(-R * 0.12, R * 0.12), R * 0.96, rng.range(-R * 0.12, R * 0.12),
          rng.range(-0.5, 0.5), a, rng.range(-0.4, 0.4)));
    }
    return it;
  };

  // ---- REMOVE BEFORE FLIGHT tag -------------------------------------------
  K.streamerTag = function (N, rng) {
    var it = new Item();
    // the cover / pin body
    it.cyl('steel', 0.030, 0.030, 0.10, 0, 0, 0, Math.PI * 0.5, 0, 0, 8);
    // the ribbon, hanging: cards down -Y so the wind snippet can stream it
    var segs = 5, L = 0.44;
    for (var i = 0; i < segs; i++) {
      var y0 = -0.03 - i * L / segs;
      var g = card(0.075, L / segs, 0, i / segs, 1, (i + 1) / segs);
      it.add('streamer', g, Tn(0, y0 - L / segs, 0, 0, 0, 0));
    }
    return it;
  };

  // ==========================================================================
  // ONE-OFF PLANT.
  //
  // These are built once each and merged into the shared static batches, so a
  // tug, a forklift, a flatbed and a bowser cost ZERO extra draw calls between
  // them.  They exist because the yard's whole subject is 20-45 m aeroplanes
  // and a frame full of aeroplanes has no scale: a 3.6 m tow tractor parked
  // under a wing is what tells you the wing is six metres up.
  // ==========================================================================

  // ---- aircraft tow tractor ------------------------------------------------
  K.tug = function (N, rng) {
    var it = new Item();
    var L = 3.6, W = 1.9;
    // ballasted low body with a stepped nose - the shape that makes a tug a tug
    it.box('yellow', W, 0.46, L * 0.86, 0, 0.62, 0, 0.030);
    it.box('yellow', W * 0.92, 0.30, L * 0.34, 0, 0.98, -L * 0.24, 0.030);
    it.box('rustProp', W * 1.02, 0.22, 0.34, 0, 0.50, -L * 0.5, 0.020);
    it.box('rustProp', W * 1.02, 0.22, 0.34, 0, 0.50, L * 0.5, 0.020);
    // operator platform, seat, wheel, roll bar
    it.box('yellow', W * 0.86, 0.05, 0.70, 0, 0.86, L * 0.20, 0.012);
    it.box('binPlastic', 0.52, 0.12, 0.46, -0.12, 1.16, L * 0.26, 0.030);
    it.box('binPlastic', 0.52, 0.44, 0.10, -0.12, 1.38, L * 0.44, 0.026);
    it.cyl('steel', 0.030, 0.030, 0.62, -0.12, 1.24, L * 0.02, -0.42, 0, 0, 8);
    it.add('steel', new THREE.TorusGeometry(0.17, 0.020, 6, 12),
      Tn(-0.12, 1.48, L * 0.02 - 0.24, 1.15, 0, 0));
    for (var s = 0; s < 2; s++) {
      var sx = s ? W * 0.44 : -W * 0.44;
      it.strut('steel', sx, 0.88, L * 0.40, sx, 2.02, L * 0.36, 0.060);
      it.strut('steel', sx, 0.88, L * 0.04, sx, 2.02, L * 0.08, 0.060);
    }
    it.box('steel', W * 0.92, 0.06, 0.34, 0, 2.03, L * 0.22, 0.014);
    it.box('canvasProp', W * 0.94, 0.02, 0.86, 0, 2.06, L * 0.20, 0.008);
    // amber beacon and a work lamp bar
    it.cyl('lamp', 0.070, 0.085, 0.13, W * 0.30, 2.12, L * 0.22, 0, 0, 0, 8);
    it.box('lamp', 0.44, 0.075, 0.05, 0, 1.12, -L * 0.44, 0.010);
    // wheels: big solid rears, smaller steered fronts
    var wh = [[-W * 0.5, L * 0.28, 0.42], [W * 0.5, L * 0.28, 0.42],
              [-W * 0.46, -L * 0.30, 0.34], [W * 0.46, -L * 0.30, 0.34]];
    for (var i = 0; i < wh.length; i++) {
      it.add('rubber', new THREE.TorusGeometry(wh[i][2] * 0.74, wh[i][2] * 0.30, 7, 12),
        Tn(wh[i][0], wh[i][2], wh[i][1], 0, 0, Math.PI * 0.5));
      it.add('rubber', cy(wh[i][2], wh[i][2], 0.30, 12, true),
        Tn(wh[i][0], wh[i][2], wh[i][1], 0, 0, Math.PI * 0.5));
      it.add('steel', cy(wh[i][2] * 0.46, wh[i][2] * 0.46, 0.32, 10),
        Tn(wh[i][0], wh[i][2], wh[i][1], 0, 0, Math.PI * 0.5));
    }
    // the tow bar, dropped on the slab ahead of it
    it.box('rustProp', 0.11, 0.11, 2.4, 0.24, 0.16, -L * 0.5 - 1.35, 0.014);
    it.box('rustProp', 0.34, 0.09, 0.30, 0.24, 0.16, -L * 0.5 - 2.45, 0.012);
    it.cyl('rubber', 0.17, 0.17, 0.09, 0.62, 0.17, -L * 0.5 - 1.10, 0, 0, Math.PI * 0.5, 8);
    it.cyl('rubber', 0.17, 0.17, 0.09, -0.14, 0.17, -L * 0.5 - 1.10, 0, 0, Math.PI * 0.5, 8);
    return it;
  };

  // ---- forklift ------------------------------------------------------------
  K.forklift = function (N, rng) {
    var it = new Item();
    var L = 2.5, W = 1.15;
    it.box('yellow', W, 0.86, L, 0, 0.72, 0, 0.030);
    it.box('yellow', W * 0.94, 0.28, 0.62, 0, 1.28, L * 0.26, 0.026);
    it.box('binPlastic', 0.46, 0.10, 0.42, 0, 1.34, L * 0.20, 0.024);
    it.box('binPlastic', 0.46, 0.40, 0.09, 0, 1.56, L * 0.38, 0.020);
    it.box('rustProp', W * 1.04, 0.30, 0.26, 0, 0.44, L * 0.5, 0.016);
    // mast: two channels, a carriage and the forks
    for (var s = 0; s < 2; s++) {
      var sx = s ? W * 0.32 : -W * 0.32;
      it.box('steel', 0.085, 2.55, 0.13, sx, 1.30, -L * 0.5 - 0.10, 0.012);
      it.box('steel', 0.055, 2.10, 0.10, sx, 1.45, -L * 0.5 - 0.20, 0.010);
      it.strut('steel', sx, 0.90, L * 0.30, sx, 2.16, L * 0.24, 0.055);
    }
    it.box('steel', W * 0.86, 0.09, 0.09, 0, 0.34, -L * 0.5 - 0.20, 0.010);
    it.box('steel', W * 0.86, 0.09, 0.09, 0, 0.92, -L * 0.5 - 0.20, 0.010);
    it.cyl('steel', 0.055, 0.055, 1.7, 0, 1.20, -L * 0.5 - 0.02, 0, 0, 0, 8);
    for (var f = 0; f < 2; f++) {
      var fx = f ? 0.28 : -0.28;
      it.box('steel', 0.12, 0.035, 1.05, fx, 0.045, -L * 0.5 - 0.72, 0.008);
      it.box('steel', 0.12, 0.44, 0.035, fx, 0.24, -L * 0.5 - 0.22, 0.008);
    }
    it.box('steel', W * 0.94, 0.05, 0.42, 0, 2.20, L * 0.26, 0.010);
    var wh = [[-W * 0.5, -L * 0.30, 0.34], [W * 0.5, -L * 0.30, 0.34],
              [-W * 0.34, L * 0.36, 0.24], [W * 0.34, L * 0.36, 0.24]];
    for (var i = 0; i < wh.length; i++) {
      it.add('rubber', cy(wh[i][2], wh[i][2], 0.24, 12, true),
        Tn(wh[i][0], wh[i][2], wh[i][1], 0, 0, Math.PI * 0.5));
      it.add('steel', cy(wh[i][2] * 0.44, wh[i][2] * 0.44, 0.26, 8),
        Tn(wh[i][0], wh[i][2], wh[i][1], 0, 0, Math.PI * 0.5));
    }
    return it;
  };

  // ---- flatbed parts trailer ----------------------------------------------
  K.trailer = function (N, rng) {
    var it = new Item();
    var L = 5.2, W = 2.1, deck = 0.72;
    it.box('rustProp', W, 0.16, L, 0, deck - 0.08, 0, 0.016);
    for (var s = 0; s < 2; s++) {
      var sx = s ? W * 0.5 : -W * 0.5;
      it.box('rustProp', 0.08, 0.34, L, sx, deck - 0.18, 0, 0.012);
      // stake pockets and two stakes still in
      for (var p = 0; p < 4; p++) {
        var pz = -L * 0.36 + p * L * 0.24;
        it.box('rustProp', 0.10, 0.16, 0.10, sx, deck + 0.02, pz, 0.010);
        if (p % 3 === 0) it.box('wood', 0.08, 0.86, 0.08, sx, deck + 0.45, pz, 0.010);
      }
    }
    it.box('rustProp', W * 0.9, 0.10, 0.10, 0, deck - 0.30, -L * 0.4, 0.010);
    it.box('rustProp', W * 0.9, 0.10, 0.10, 0, deck - 0.30, L * 0.4, 0.010);
    // drawbar and jockey wheel
    it.box('rustProp', 0.14, 0.14, 1.5, 0, deck - 0.34, -L * 0.5 - 0.65, 0.014);
    it.cyl('rustProp', 0.075, 0.075, 0.12, 0, deck - 0.34, -L * 0.5 - 1.35, Math.PI * 0.5, 0, 0, 8);
    it.cyl('steel', 0.036, 0.036, 0.46, 0, deck - 0.58, -L * 0.5 - 0.95, 0, 0, 0, 8);
    it.cyl('rubber', 0.10, 0.10, 0.06, 0, 0.10, -L * 0.5 - 0.95, 0, 0, Math.PI * 0.5, 8);
    // four wheels on a bogie
    for (var i = 0; i < 4; i++) {
      var wx = (i & 1) ? W * 0.5 : -W * 0.5;
      var wz = (i & 2) ? 0.62 : -0.06;
      it.add('rubber', cy(0.36, 0.36, 0.22, 12, true), Tn(wx, 0.36, wz, 0, 0, Math.PI * 0.5));
      it.add('steel', cy(0.16, 0.16, 0.24, 8), Tn(wx, 0.36, wz, 0, 0, Math.PI * 0.5));
    }
    return it;
  };

  // ---- ground power unit ---------------------------------------------------
  K.gpu = function (N, rng) {
    var it = new Item();
    var L = 2.2, W = 1.15, Hh = 1.25;
    it.box('steel', W, Hh, L, 0, 0.44 + Hh * 0.5, 0, 0.024);
    // louvred radiator end and an exhaust stack
    for (var i = 0; i < 7; i++) {
      it.boxR('steel', W * 0.78, 0.045, 0.030, 0, 0.62 + i * 0.11, -L * 0.5 - 0.010, 0.22, 0, 0, 0.006);
    }
    it.cyl('rustProp', 0.075, 0.075, 0.72, W * 0.32, 0.44 + Hh + 0.36, L * 0.30, 0, 0, 0, 8);
    it.cyl('rustProp', 0.100, 0.075, 0.10, W * 0.32, 0.44 + Hh + 0.74, L * 0.30, 0, 0, 0, 8);
    // access doors with handles, and the control panel
    it.box('steel', 0.012, Hh * 0.72, L * 0.40, W * 0.5, 0.44 + Hh * 0.48, -L * 0.12, 0.006);
    it.box('steel', 0.030, 0.055, 0.16, W * 0.51, 0.44 + Hh * 0.48, -L * 0.28, 0.008);
    it.boxR('lamp', 0.014, 0.30, 0.42, -W * 0.5 - 0.006, 0.44 + Hh * 0.64, L * 0.10, 0, 0, 0, 0.006);
    // the cable, coiled on a hook and running off downwind
    it.cyl('steel', 0.030, 0.030, 0.28, -W * 0.5 - 0.10, 0.44 + Hh * 0.30, L * 0.30, 0, 0, Math.PI * 0.5, 6);
    var loop = function (t) {
      var a = t * TAU * 2.2;
      return [-W * 0.5 - 0.10 + Math.cos(a) * 0.24, 0.44 + Hh * 0.30 - 0.10 - t * 0.14,
        L * 0.30 + Math.sin(a) * 0.24];
    };
    for (var c = 0; c < 12; c++) {
      var a1 = loop(c / 12), b1 = loop((c + 1) / 12);
      it.tube('rubber', 0.028, a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], 5);
    }
    // chassis, drawbar, wheels
    it.box('rustProp', W * 1.06, 0.16, L * 1.02, 0, 0.36, 0, 0.014);
    it.box('rustProp', 0.11, 0.11, 1.1, 0, 0.30, -L * 0.5 - 0.5, 0.012);
    for (var w = 0; w < 4; w++) {
      var wx = (w & 1) ? W * 0.52 : -W * 0.52;
      var wz = (w & 2) ? L * 0.28 : -L * 0.22;
      it.add('rubber', cy(0.28, 0.28, 0.16, 10, true), Tn(wx, 0.28, wz, 0, 0, Math.PI * 0.5));
      it.add('steel', cy(0.12, 0.12, 0.18, 8), Tn(wx, 0.28, wz, 0, 0, Math.PI * 0.5));
    }
    return it;
  };

  // ---- pickup truck --------------------------------------------------------
  K.pickup = function (N, rng) {
    var it = new Item();
    var L = 5.3, W = 1.98, sill = 0.78;
    it.box('body', W, 0.62, L * 0.94, 0, sill + 0.31, 0, 0.045);
    // cab: greenhouse set in, so it is not a second box
    it.box('body', W * 0.94, 0.62, L * 0.34, 0, sill + 0.92, -L * 0.10, 0.055);
    it.box('glassProp', W * 0.86, 0.44, 0.030, 0, sill + 0.98, -L * 0.10 - L * 0.17, 0.008);
    it.box('glassProp', 0.030, 0.40, L * 0.28, W * 0.47, sill + 0.98, -L * 0.10, 0.008);
    it.box('glassProp', 0.030, 0.40, L * 0.28, -W * 0.47, sill + 0.98, -L * 0.10, 0.008);
    it.box('glassProp', W * 0.84, 0.36, 0.030, 0, sill + 0.98, -L * 0.10 + L * 0.17, 0.008);
    it.box('body', W * 0.96, 0.06, L * 0.36, 0, sill + 1.24, -L * 0.10, 0.030);
    // bed with side walls and a tailgate
    it.box('body', W, 0.42, 0.05, 0, sill + 0.52, L * 0.46, 0.020);
    it.box('body', 0.06, 0.42, L * 0.40, W * 0.5, sill + 0.52, L * 0.25, 0.016);
    it.box('body', 0.06, 0.42, L * 0.40, -W * 0.5, sill + 0.52, L * 0.25, 0.016);
    // bumpers, grille, lights
    it.box('steel', W * 1.02, 0.16, 0.16, 0, sill - 0.08, -L * 0.48, 0.018);
    it.box('steel', W * 1.02, 0.16, 0.16, 0, sill - 0.08, L * 0.48, 0.018);
    it.box('steel', W * 0.74, 0.24, 0.05, 0, sill + 0.32, -L * 0.48, 0.012);
    it.box('lamp', 0.30, 0.16, 0.05, W * 0.32, sill + 0.34, -L * 0.48, 0.012);
    it.box('lamp', 0.30, 0.16, 0.05, -W * 0.32, sill + 0.34, -L * 0.48, 0.012);
    // arches and wheels
    var wh = [[-W * 0.5, -L * 0.30], [W * 0.5, -L * 0.30], [-W * 0.5, L * 0.30], [W * 0.5, L * 0.30]];
    for (var i = 0; i < wh.length; i++) {
      it.add('rubber', new THREE.TorusGeometry(0.30, 0.115, 7, 12),
        Tn(wh[i][0], 0.40, wh[i][1], 0, 0, Math.PI * 0.5));
      it.add('rubber', cy(0.40, 0.40, 0.26, 12, true),
        Tn(wh[i][0], 0.40, wh[i][1], 0, 0, Math.PI * 0.5));
      it.add('steel', cy(0.19, 0.19, 0.28, 10), Tn(wh[i][0], 0.40, wh[i][1], 0, 0, Math.PI * 0.5));
    }
    // roof light bar and a whip aerial: the two things that say "airfield ops"
    it.box('lamp', 0.90, 0.10, 0.14, 0, sill + 1.32, -L * 0.10, 0.016);
    it.cyl('steel', 0.010, 0.010, 1.3, -W * 0.42, sill + 1.35, L * 0.02, 0.10, 0, 0.06, 5);
    return it;
  };

  // ---- 20 ft parts container -----------------------------------------------
  K.container = function (N, rng) {
    var it = new Item();
    var L = 6.06, W = 2.44, Hh = 2.59;
    // corrugated flanks, built as ribs so the silhouette is not a slab
    it.box('corrProp', W, Hh, L, 0, Hh * 0.5 + 0.13, 0, 0.020);
    for (var i = 0; i < 24; i++) {
      var z = -L * 0.5 + 0.14 + i * (L - 0.28) / 23;
      it.box('corrProp', W + 0.045, Hh * 0.86, 0.055, 0, Hh * 0.5 + 0.13, z, 0.010);
    }
    // corner castings and rails
    for (var c = 0; c < 8; c++) {
      var cx = (c & 1) ? W * 0.5 : -W * 0.5;
      var cz = (c & 2) ? L * 0.5 : -L * 0.5;
      var cyy = (c & 4) ? Hh + 0.13 : 0.24;
      it.box('rustProp', 0.18, 0.20, 0.18, cx, cyy, cz, 0.014);
    }
    it.box('rustProp', W + 0.03, 0.14, L, 0, Hh + 0.13, 0, 0.012);
    it.box('rustProp', W + 0.03, 0.14, L, 0, 0.16, 0, 0.012);
    // doors on one end: two leaves, four locking bars, a hasp
    it.box('corrProp', W * 0.98, Hh * 0.94, 0.05, 0, Hh * 0.5 + 0.13, -L * 0.5 - 0.03, 0.012);
    for (var b = 0; b < 4; b++) {
      var bxp = -W * 0.36 + b * W * 0.24;
      it.cyl('rustProp', 0.028, 0.028, Hh * 0.92, bxp, Hh * 0.5 + 0.13, -L * 0.5 - 0.07, 0, 0, 0, 8);
      it.box('rustProp', 0.075, 0.11, 0.075, bxp, Hh * 0.5 + 0.13, -L * 0.5 - 0.11, 0.010);
    }
    return it;
  };

  // ---- skip / waste bin ----------------------------------------------------
  K.skip = function (N, rng) {
    var it = new Item();
    var L = 3.0, W = 1.7, h0 = 0.95, h1 = 1.35;
    // the classic tapered body: front lower than back
    var pts = [
      { x: -L * 0.5, y: 0.14 }, { x: L * 0.5, y: 0.14 },
      { x: L * 0.5, y: h1 }, { x: L * 0.32, y: h1 },
      { x: -L * 0.32, y: h0 }, { x: -L * 0.5, y: h0 }
    ];
    it.add('rustProp', extrudeProfile(pts, W, 1.4), Tn(0, 0, 0, 0, Math.PI * 0.5, 0));
    it.box('rustProp', W + 0.05, 0.10, L * 0.99, 0, 0.09, 0, 0.012);
    // lifting lugs and the rim rail
    for (var s = 0; s < 2; s++) {
      var sx = s ? W * 0.5 : -W * 0.5;
      it.box('rustProp', 0.05, 0.30, 0.30, sx, h1 * 0.62, L * 0.30, 0.010);
      it.cyl('rustProp', 0.018, 0.018, 0.24, sx + (s ? 0.05 : -0.05), h1 * 0.78, L * 0.30, 0, 0, Math.PI * 0.5, 6);
    }
    // what is in it: cut skin, a wing rib, offcuts sticking out over the rim
    it.boxR('alu', 1.5, 0.02, 0.9, -0.2, h1 * 0.92, 0.2, 0.22, 0.5, 0.14, 0.004);
    it.boxR('alu', 1.1, 0.02, 0.7, 0.5, h1 * 0.86, -0.3, -0.18, 1.2, 0.28, 0.004);
    it.boxR('alu', 0.10, 0.10, 1.7, 0.7, h1 * 1.02, 0.1, 0.34, 0.9, 0, 0.010);
    it.boxR('wood', 0.9, 0.06, 0.20, -0.8, h1 * 0.98, -0.35, -0.26, 0.3, 0.12, 0.008);
    return it;
  };

  // ---- portable toilet -----------------------------------------------------
  K.portaloo = function (N, rng) {
    var it = new Item();
    var W = 1.12, D = 1.12, Hh = 2.28;
    it.box('binPlastic', W, Hh, D, 0, Hh * 0.5, 0, 0.030);
    // vertical mouldings and the roof vent
    for (var i = 0; i < 5; i++) {
      it.box('binPlastic', 0.045, Hh * 0.92, D + 0.020, -W * 0.4 + i * W * 0.2, Hh * 0.5, 0, 0.010);
    }
    it.box('binPlastic', W * 1.04, 0.09, D * 1.04, 0, Hh + 0.045, 0, 0.024);
    it.box('binPlastic', 0.30, 0.14, 0.30, W * 0.2, Hh + 0.13, D * 0.2, 0.024);
    // door with a frame and a handle
    it.box('binPlastic', W * 0.62, Hh * 0.86, 0.030, 0, Hh * 0.47, -D * 0.5 - 0.020, 0.012);
    it.box('steel', 0.05, 0.15, 0.045, W * 0.24, Hh * 0.45, -D * 0.5 - 0.045, 0.010);
    it.box('binPlastic', W * 0.34, 0.24, 0.020, 0, Hh * 0.80, -D * 0.5 - 0.035, 0.008);
    return it;
  };

  // ---- shade canopy frame --------------------------------------------------
  // The cloth is a separate wind mesh; this is only the tube frame it hangs on.
  K.canopyFrame = function (N, rng, w, d, h) {
    var it = new Item();
    for (var i = 0; i < 4; i++) {
      var px = (i & 1) ? w * 0.5 : -w * 0.5;
      var pz = (i & 2) ? d * 0.5 : -d * 0.5;
      it.cyl('steel', 0.036, 0.042, h, px, h * 0.5, pz, 0, 0, 0, 8);
      it.box('steel', 0.16, 0.020, 0.16, px, 0.010, pz, 0.006);
      // guy line to a stake, downwind
      it.strut('steel', px, h - 0.06, pz, px * 1.34, 0.02, pz * 1.34, 0.010);
    }
    it.box('steel', w, 0.055, 0.055, 0, h, -d * 0.5, 0.010);
    it.box('steel', w, 0.055, 0.055, 0, h, d * 0.5, 0.010);
    it.box('steel', 0.055, 0.055, d, -w * 0.5, h, 0, 0.010);
    it.box('steel', 0.055, 0.055, d, w * 0.5, h, 0, 0.010);
    it.box('steel', 0.045, 0.045, d, 0, h + 0.13, 0, 0.010);
    it.strut('steel', -w * 0.5, h, 0, 0, h + 0.13, 0, 0.038);
    it.strut('steel', w * 0.5, h, 0, 0, h + 0.13, 0, 0.038);
    return it;
  };

  // ---- cable / hose reel ---------------------------------------------------
  K.reel = function (N, rng, R) {
    var it = new Item();
    it.cyl('rustProp', R, R, 0.055, 0, R, -0.24, 0, 0, Math.PI * 0.5, 14);
    it.cyl('rustProp', R, R, 0.055, 0, R, 0.24, 0, 0, Math.PI * 0.5, 14);
    it.cyl('rustProp', R * 0.36, R * 0.36, 0.44, 0, R, 0, 0, 0, Math.PI * 0.5, 12);
    // the wound hose, as three fat rings
    for (var i = 0; i < 3; i++) {
      it.add('rubber', new THREE.TorusGeometry(R * (0.48 + i * 0.11), 0.055, 6, 14),
        Tn(0, R, -0.14 + i * 0.14, 0, 0, 0));
    }
    // A-frame stand and a crank
    it.strut('rustProp', -0.34, 0, -0.30, 0, R, -0.26, 0.045);
    it.strut('rustProp', 0.34, 0, -0.30, 0, R, -0.26, 0.045);
    it.strut('rustProp', -0.34, 0, 0.30, 0, R, 0.26, 0.045);
    it.strut('rustProp', 0.34, 0, 0.30, 0, R, 0.26, 0.045);
    it.cyl('steel', 0.016, 0.016, 0.22, 0, R, 0.34, 0, 0, Math.PI * 0.5, 6);
    it.cyl('steel', 0.016, 0.016, 0.16, 0.16, R, 0.44, 0, 0, 0, 6);
    return it;
  };

  // ---- workshop bench clutter ---------------------------------------------
  // Not a bench: the level already built the bench run down the hangar's back
  // wall.  This is what is ON it, which is what the interior framing is short
  // of and what turns a shed into a workshop.
  K.benchClutter = function (N, rng, len) {
    var it = new Item();
    var r = rng;
    var n = Math.max(3, Math.round(len / 0.55));
    for (var i = 0; i < n; i++) {
      var z = -len * 0.5 + (i + 0.5) * len / n + r.range(-0.06, 0.06);
      var kind = r.int(0, 5);
      if (kind === 0) {
        it.box('binPlastic', 0.34, 0.17, 0.26, r.range(-0.10, 0.10), 0.085, z, 0.016);
        it.box('binPlastic', 0.34, 0.17, 0.26, r.range(-0.10, 0.10), 0.255, z, 0.016);
      } else if (kind === 1) {
        it.cyl('steel', 0.075, 0.075, 0.24, r.range(-0.1, 0.1), 0.12, z, 0, 0, 0, 8);
        it.cyl('steel', 0.055, 0.055, 0.20, r.range(-0.1, 0.1) + 0.18, 0.10, z, 0, 0, 0, 8);
      } else if (kind === 2) {
        it.boxR('steel', 0.42, 0.10, 0.24, 0, 0.05, z, 0, r.range(-0.3, 0.3), 0, 0.010);
        it.boxR('steel', 0.30, 0.06, 0.16, 0.04, 0.13, z, 0, r.range(-0.3, 0.3), 0, 0.008);
      } else if (kind === 3) {
        // a bench vice - the one recognisable silhouette on any workbench
        it.box('steel', 0.14, 0.10, 0.20, 0, 0.05, z, 0.012);
        it.box('steel', 0.11, 0.16, 0.09, 0, 0.16, z - 0.06, 0.012);
        it.box('steel', 0.11, 0.16, 0.09, 0, 0.16, z + 0.06, 0.012);
        it.cyl('steel', 0.016, 0.016, 0.34, 0, 0.20, z + 0.16, Math.PI * 0.5, 0, 0, 6);
      } else if (kind === 4) {
        it.boxR('crateSkin', 0.30, 0.22, 0.26, r.range(-0.08, 0.08), 0.11, z, 0, r.range(-0.4, 0.4), 0, 0.012);
      } else {
        it.boxR('canvasProp', 0.26, 0.05, 0.20, r.range(-0.10, 0.10), 0.025, z, 0.06, r.range(0, 3), -0.04, 0.006);
      }
    }
    return it;
  };

  // ==========================================================================
  // WIND.
  //
  // The desert breeze is not the harbor's gale, and the difference is the whole
  // point: a plant in an 5 m/s wind twitches, it does not thrash.  What moves
  // here is the streamers (hard, snapping), the plants (a slow lean with a
  // faster leaf shiver on top) and the canopy cloth.
  //
  // The injection CHAINS onto whatever onBeforeCompile the library material
  // already carries - materials.js does triplanar projection, detail normals,
  // parallax and the wear blend in there, and clobbering it turns a calibrated
  // surface into flat plastic.  Program identity is controlled with
  // customProgramCacheKey, which three.js prefers over onBeforeCompile
  // .toString(), so per-material closures do not each get their own program.
  // ==========================================================================
  var WIND_PARS = [
    'uniform float byTime;',
    'uniform vec4 byWind;',
    'uniform vec2 byWindDir;',
    'attribute float aFlex;'
  ].join('\n');

  var WIND_BODY = [
    'vec3 byOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#ifdef USE_INSTANCING',
    'byOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
    '#endif',
    'vec3 byP = byOrg + transformed;',
    // A travelling gust envelope, so a hundred bushes across 200 m of yard do
    // not breathe in unison - which is the single loudest tell of instanced
    // vegetation.
    'float byG = 0.55 + 0.45 * sin( byTime * 0.41 + byP.x * 0.045 + byP.z * 0.037 );',
    'byG *= 0.74 + 0.26 * sin( byTime * 0.137 + byP.z * 0.021 - byP.x * 0.016 );',
    'float byPh = byTime * byWind.y + ( byP.x * 0.29 + byP.z * 0.21 ) * byWind.w;',
    'float byS1 = sin( byPh );',
    'float byS2 = sin( byPh * 2.37 + 1.7 );',
    'float byS3 = sin( byPh * 5.10 + byP.y * 6.1 + byP.x * 2.2 );',
    'float byA = byWind.x * aFlex * byG;',
    // A steady lean downwind PLUS the oscillation about it: a streamer in a
    // breeze is held out, not swinging symmetrically about vertical.
    'transformed.x += byA * ( byWindDir.x * 0.92 + byS1 * 0.48 + byS2 * 0.14 );',
    'transformed.z += byA * ( byWindDir.y * 0.92 + byS2 * 0.34 - byS1 * 0.11 );',
    'transformed.y += byA * byWind.z * ( byS3 * 0.44 - 0.20 );'
  ].join('\n');

  var WIND_ANCHOR = ['#include <begin_vertex>', '#include <project_vertex>'];

  function injectAfter(src, anchors, code) {
    for (var i = 0; i < anchors.length; i++) {
      if (src.indexOf(anchors[i]) >= 0) {
        return { src: src.replace(anchors[i], anchors[i] + '\n' + code), idx: i };
      }
    }
    return { src: src, idx: -1 };
  }

  function chainCompile(mat, key, fn) {
    var prev = (mat.onBeforeCompile &&
      mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) ? mat.onBeforeCompile : null;
    var prevKey = mat.customProgramCacheKey;
    var hadKey = typeof prevKey === 'function' &&
      prevKey !== THREE.Material.prototype.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) { try { prev.call(mat, shader, renderer); } catch (e) { GAME.logError('propsB.chain', e); } }
      try { fn(shader, mat); } catch (e2) { GAME.logError('propsB.inject', e2); }
    };
    mat.customProgramCacheKey = function () {
      var pk = '';
      if (hadKey) { try { pk = prevKey.call(mat) || ''; } catch (e) { pk = ''; } }
      return pk + '|' + key;
    };
    mat.needsUpdate = true;
    return mat;
  }

  function applyWind(mat, uTime, uWind, uWindDir, keySuffix) {
    if (!mat) return mat;
    return chainCompile(mat, 'bywind' + (keySuffix || ''), function (shader) {
      shader.uniforms.byTime = uTime;
      shader.uniforms.byWind = uWind;
      shader.uniforms.byWindDir = uWindDir;
      var v = injectAfter(shader.vertexShader, WIND_ANCHOR, WIND_BODY);
      if (v.idx < 0) return;
      shader.vertexShader = v.src.replace('#include <common>', '#include <common>\n' + WIND_PARS);
    });
  }

  // Alpha-tested cloth with a rigid shadow is an obvious tell, so anything that
  // moves gets a depth material running the SAME displacement.
  // ==========================================================================
  // SUN-THROUGH.
  //
  // The measurement that produced this: a tumbleweed sitting on 0.0898 linear
  // apron measured 0.0342 - a backlit straw ball, in a level whose entire
  // subject is the sun, coming out DARKER than the concrete under it.  That is
  // the same failure mode as the 2,626 ferns that rendered as black confetti,
  // and it has the same cause: an alpha card is opaque to the renderer, so a
  // plant lit from behind is a silhouette and nothing else.
  //
  // Real dry vegetation is close to a diffuser.  Two terms, both cheap:
  //   WRAP      the lambert term is remapped so light still arrives at up to
  //             ~60 degrees past the terminator, which is what a thin leaf or a
  //             straw stem does
  //   BACK      a view-dependent lobe along the light's direction of travel, so
  //             a ball of dry twigs between the camera and the sun GLOWS rather
  //             than blocking
  // The sun vector is a uniform this module owns and refreshes from
  // ctx.sky.sunDirection, not a guess at which entry of directionalLights[] the
  // key happens to be.
  // ==========================================================================
  var TRANS_PARS = [
    'uniform vec3 byfSunDir;',
    'uniform vec3 byfSunCol;',
    'uniform float byfTrans;'
  ].join('\n');

  var TRANS_BODY = [
    '{',
    '  vec3 byLw = normalize( byfSunDir );',
    '  vec3 byLv = normalize( ( viewMatrix * vec4( byLw, 0.0 ) ).xyz );',
    '  vec3 byV = normalize( vViewPosition );',
    // past-the-terminator wrap: 0 at 145 degrees, 1 facing the sun
    '  float byWrapT = max( 0.0, ( dot( normal, byLv ) + 0.82 ) / 1.82 );',
    // and the forward lobe: the camera looking INTO the light through the plant
    '  float byBack = pow( max( 0.0, dot( byV, -byLv ) ), 2.4 );',
    '  vec3 byT = diffuseColor.rgb * byfSunCol * byfTrans *',
    '             ( byWrapT * 0.34 + byBack * 1.05 * byWrapT );',
    '  gl_FragColor.rgb += byT;',
    '}'
  ].join('\n');

  var TRANS_ANCHOR = ['#include <opaque_fragment>', '#include <output_fragment>'];

  function applyTranslucency(mat, uSunDir, uSunCol, uAmt, keySuffix) {
    if (!mat) return mat;
    return chainCompile(mat, 'bytrans' + (keySuffix || ''), function (shader) {
      shader.uniforms.byfSunDir = uSunDir;
      shader.uniforms.byfSunCol = uSunCol;
      shader.uniforms.byfTrans = uAmt;
      var f = injectAfter(shader.fragmentShader, TRANS_ANCHOR, TRANS_BODY);
      if (f.idx < 0) return;
      shader.fragmentShader = f.src.replace('#include <common>',
        '#include <common>\n' + TRANS_PARS);
    });
  }

  function windDepthMaterial(uTime, uWind, uWindDir, map, alphaTest, side) {
    var d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    if (map) { d.map = map; d.alphaTest = alphaTest === undefined ? 0.5 : alphaTest; }
    d.side = side || THREE.FrontSide;
    return applyWind(d, uTime, uWind, uWindDir, 'd');
  }

  // Every wind geometry needs aFlex.  fn(x,y,z,i) -> 0..1+
  function setFlex(geo, fn) {
    var p = geo.attributes.position;
    var a = new Float32Array(p.count);
    for (var i = 0; i < p.count; i++) a[i] = fn(p.getX(i), p.getY(i), p.getZ(i), i);
    geo.setAttribute('aFlex', new THREE.BufferAttribute(a, 1));
    return geo;
  }

  // ==========================================================================
  // GEAR GEOMETRY, BY PUBLISHED TYPE NAME.
  //
  // level.aircraft publishes `type`, `x`, `z`, `yaw`, `scale`, `onJacks` and an
  // `info` block, but not where the wheels are - and a chock has to be AT a
  // wheel or it is a yellow brick lying on concrete.  These are the gear
  // stations for each published type, in the level's own local frame (nose
  // toward -Z, starboard +X, y = 0 at the ground).  They are proportions of
  // published dimensions wherever one exists, so a type that is rescaled moves
  // its chocks with it; a type this table does not know simply gets no chocks
  // rather than wrong ones.
  // ==========================================================================
  var GEAR = {
    transport4: { h: 2.05, wheelR: 0.56, mainZ: 3.6, mainX: 2.35, noseZ: -15.0, twin: true },
    transport2: { h: 1.85, wheelR: 0.50, mainZ: 2.4, mainX: 1.75, noseZ: -11.0, twin: true },
    fighter: { h: 1.55, wheelR: 0.36, mainZ: 1.4, mainX: 1.25, noseZ: -4.6 },
    trainer: { h: 1.30, wheelR: 0.32, mainZ: 0.9, mainX: 1.05, noseZ: -3.6 }
  };

  // ==========================================================================
  // GAME.PropsBoneyard
  // ==========================================================================
  function PropsBoneyard(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_boneyard';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's RNG stream, so
    // adding a particle somewhere else cannot reshuffle the yard.
    var seed = ((this.ctx.seed || 20260801) ^ 0x42594152) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x2545F491) >>> 0);

    this.time = 0;
    this.uTime = { value: 0 };
    // amplitude (m), frequency (rad/s), vertical billow, spatial phase
    this.uWind = { value: new THREE.Vector4(0.055, 1.9, 0.40, 0.50) };
    // The desert breeze the level authors its windsock against.  Placement -
    // drift orientation, tumbleweed banking, litter traps - is baked against
    // this at build time; the animation adopts ctx.weather.windDir if a weather
    // system ever appears on this level.
    this.windDir = new THREE.Vector2(0.66, 0.75).normalize();
    this.uWindDir = { value: this.windDir.clone() };
    this.windSpeed = 5.0;
    // The key, for the vegetation sun-through term. Seeded with the bearing
    // level_boneyard authors against (319 at 30 degrees up) and replaced by
    // ctx.sky.sunDirection on the first frame that has one.
    this.uSunDir = { value: new THREE.Vector3(-0.571, 0.500, -0.651).normalize() };
    this.uSunCol = { value: new THREE.Color(1.0, 0.92, 0.78) };
    this.uTrans = { value: 1.0 };
    this.devils = [];

    this.tex = {};
    this.mats = {};
    this.B = {};                   // instanced batches
    this.C = {};                   // multi-material combos
    this.S = {                     // one-off geometry, merged per material
      steel: [], yellow: [], rustProp: [], alu: [], wood: [], rubber: [],
      canvasProp: [], concreteProp: [], binPlastic: [], corrProp: [],
      body: [], glassProp: [], lamp: [], red: [], olive: [], crateSkin: [],
      sandProp: [], gas: [], cone: [], coneBand: [], drumSkin: [],
      spill: [], rockProp: []
    };
    this.windMeshes = [];
    this.stainParts = [];
    this.signParts = [];
    this._occ = new Map();
    this._skipped = 0;
    this._keepOut = [];            // camera eyes: a rejection filter, never a source
    this.hash = null;
    this._qout = [];

    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // Nominal footprint, overwritten by _probeLayout the moment the level
    // publishes anchors.  They exist so a broken level cannot take this module
    // down with it.
    this.bounds = { x0: -100, x1: 104, z0: -96, z1: 72 };
    this.fence = { x0: -118, x1: 122, z0: -114, z1: 86 };
    this.groundY = 0;
    this.A = null;

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsB.ctor', e); }
  }

  PropsBoneyard.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsB.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsBoneyard.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // Plant BEFORE clutter: the big machinery needs four clear metres and the
    // parts-yard passes will otherwise have filled every site it could use.
    // A yard is blocked out with its plant and filled in around it, which is
    // also how a real one is laid out.
    await this._phase('plant', this._dressPlant);
    await this._phase('aircraft', this._dressAircraft);
    await this._phase('partsyard', this._dressPartsYard);
    await this._phase('hangar', this._dressHangar);
    await this._phase('ops', this._dressOps);
    await this._phase('taxiway', this._dressTaxiway);
    await this._phase('hulks', this._dressHulks);
    await this._phase('perimeter', this._dressPerimeter);
    await this._phase('desert', this._dressDesert);
    await this._phase('joints', this._dressJointWeeds);
    await this._phase('drifts', this._dressDrifts);
    await this._phase('shade', this._dressShade);
    await this._phase('devils', this._dressDevils);
    await this._phase('commit', this._commit);
    clearCaches();
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsBoneyard.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;

    var grunge = TX.grunge(256, 0x8A11E, 1.18);
    this._grunge = grunge;

    t.drum = TX.tex(TX.drumSkin(512, 0x31, grunge), true, 1, 1, aniso, true);
    var drumH = TX.heightFromCanvas(TX.drumSkin(256, 0x31, null));
    t.drumN = TX.normalFromHeight(drumH, 256, 1.4);

    t.crate = TX.tex(TX.crateSkin(512, 0x41, grunge), true, 1, 1, aniso, true);
    var crateH = TX.heightFromCanvas(TX.crateSkin(256, 0x41, null));
    t.crateN = TX.normalFromHeight(crateH, 256, 1.2);

    t.plants = TX.tex(TX.plants(512, 0x51), true, 1, 1, aniso, true);
    t.stains = TX.tex(TX.stains(512, 0x61), true, 1, 1, aniso, true);
    t.streamer = TX.tex(TX.streamer(256, 48, 0x71), true, 1, 1, aniso, true);
    t.hazard = TX.tex(TX.hazard(256, 0x81, grunge), true, 1, 1, aniso);
    if (grunge) t.grungeN = TX.normalFromHeight(TX.heightFromCanvas(grunge), 256, 1.0);

    t.signA = TX.tex(TX.placard(512, 256, 0x91,
      { bg: '#a8a396', fg: '#26292e', bar: '#b0982c', a: 'RESTRICTED', b: 'AMARG SECTOR 4 / NO ENTRY' }),
      true, 1, 1, aniso, true);
    t.signB = TX.tex(TX.placard(512, 256, 0x92,
      { bg: '#8d3428', fg: '#e6e1d4', bar: '#26292e', a: 'NO SMOKING', b: 'FUEL VAPOUR / IGNITION HAZARD' }),
      true, 1, 1, aniso, true);
    t.signC = TX.tex(TX.placard(512, 256, 0x93,
      { bg: '#9a9488', fg: '#26292e', bar: '#3c5f78', a: 'ROW C  BAYS 14-19', b: 'TOW SPEED 8 KM/H MAX' }),
      true, 1, 1, aniso, true);
  };

  // --------------------------------------------------------------------------
  // Materials
  //
  // Everything from the library is CLONED - mutating a cached library material
  // would corrupt it for the level and every other consumer - and every prop
  // material declares the SAME pale-sand wearColor, which is what makes the
  // whole prop set read as one dusty place rather than as a kit of objects that
  // happen to be standing in a desert.
  // --------------------------------------------------------------------------
  var DUST_WEAR = 0xc6baa1;

  PropsBoneyard.prototype._material = function (name, opts) {
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
    } catch (e) { GAME.logError('propsB.mat:' + name, e); }
    if (!mat) mat = this._fallbackMaterial(name, opts);
    mat.name = 'by_' + name;
    return mat;
  };

  var FALLBACK_SPEC = {
    painted_metal: [0x8a8f93, 0.56, 0.60],
    rusted_metal: [0x6d4a34, 0.86, 0.45],
    corrugated_metal: [0x99988f, 0.60, 0.55],
    wood_plank: [0x8d7856, 0.90, 0.0],
    rubber: [0x2a2a2b, 0.88, 0.0],
    canvas_awning: [0xa2957a, 0.92, 0.0],
    concrete: [0x8d887c, 0.92, 0.0],
    plastic: [0xa8a49a, 0.55, 0.0],
    glass: [0x3d474c, 0.20, 0.0],
    sand: [0xb9a081, 0.97, 0.0],
    gravel: [0x8f836e, 0.95, 0.0]
  };

  PropsBoneyard.prototype._fallbackMaterial = function (name, opts) {
    var s = FALLBACK_SPEC[name] || FALLBACK_SPEC.painted_metal;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(s[0], THREE.SRGBColorSpace),
      roughness: s[1], metalness: s[2], envMapIntensity: 1.0
    });
    // No wear shader on this path, so a wear MASK would be multiplied straight
    // onto albedo and every prop would come out three shades too dark.
    if (opts && opts.side !== undefined) m.side = opts.side;
    if (opts && opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
    if (this.tex.grungeN) { m.normalMap = this.tex.grungeN; m.normalScale = new THREE.Vector2(0.5, 0.5); }
    return m;
  };

  PropsBoneyard.prototype._initMaterials = function () {
    var m = this.mats;
    var self = this;
    // The desert wear contract, in one place: vertex colours on, wear mode, no
    // wetness, and the pale sand every B channel blends toward.
    function W(extra) {
      var o = { vertexColors: true, wearMode: 'wear', wet: false, wearColor: DUST_WEAR };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return o;
    }

    m.steel = this._material('painted_metal', W({ albedoTarget: 0x878c92, roughness: 0.56, metalness: 0.58 }));
    // The one saturated family in a bleached yard: ground support equipment is
    // painted safety yellow everywhere on earth, and it is the only thing that
    // stops the frame being tan-on-tan.
    m.yellow = this._material('painted_metal', W({ albedoTarget: 0xb09328, roughness: 0.64, metalness: 0.20 }));
    m.red = this._material('painted_metal', W({ albedoTarget: 0x92382a, roughness: 0.60, metalness: 0.22 }));
    m.olive = this._material('painted_metal', W({ albedoTarget: 0x5e5f45, roughness: 0.74, metalness: 0.16 }));
    m.body = this._material('painted_metal', W({ albedoTarget: 0x7d8a90, roughness: 0.44, metalness: 0.38 }));
    // Bare alclad, matched to the level's own airframe entry so a salvaged skin
    // panel leaning on a rack is the same metal as the aeroplane it came off.
    m.alu = this._material('painted_metal', W({ albedoTarget: 0x8e9498, roughness: 0.42, metalness: 0.72, envMapIntensity: 1.25 }));
    m.rustProp = this._material('rusted_metal', W({ albedoTarget: 0x6d4a34, roughness: 0.86, metalness: 0.42 }));
    m.corrProp = this._material('corrugated_metal', W({ albedoTarget: 0x99988f, roughness: 0.60, metalness: 0.52 }));
    m.wood = this._material('wood_plank', W({ albedoTarget: 0x8d7856, roughness: 0.90 }));
    m.rubber = this._material('rubber', W({ albedoTarget: 0x2b2b2c, roughness: 0.88, metalness: 0.0 }));
    m.canvasProp = this._material('canvas_awning', W({ albedoTarget: 0xa2957a, roughness: 0.93, side: THREE.DoubleSide }));
    m.concreteProp = this._material('concrete', W({ albedoTarget: 0x8d887c, roughness: 0.93 }));
    m.binPlastic = this._material('plastic', W({ albedoTarget: 0x9d9a92, roughness: 0.52 }));
    m.gas = this._material('painted_metal', W({ albedoTarget: 0x4e6f5c, roughness: 0.50, metalness: 0.45 }));
    m.sandProp = this._material('sand', W({ albedoTarget: 0xbaa384, roughness: 0.97 }));
    m.rockProp = this._material('gravel', W({ albedoTarget: 0x8b8069, roughness: 0.95 }));
    // Cone: the wearColor is pushed almost white so the B channel written into
    // the band rings paints the retroreflective sleeves for free.
    m.cone = this._material('plastic', W({ albedoTarget: 0xa8461c, roughness: 0.62 }));
    m.coneBand = this._material('plastic', W({ albedoTarget: 0xb8b2a4, roughness: 0.44, wearColor: 0xe4e0d4 }));

    // ---- glass -------------------------------------------------------------
    try {
      m.glassProp = (this.ctx.materials && this.ctx.materials.glass)
        ? this.ctx.materials.glass({ tint: 0x2c3a42, roughness: 0.10 })
        : null;
    } catch (e) { m.glassProp = null; }
    if (!m.glassProp) {
      m.glassProp = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x2c3a42, THREE.SRGBColorSpace),
        roughness: 0.12, metalness: 0.10, envMapIntensity: 1.6
      });
    }

    // ---- lamp lenses -------------------------------------------------------
    // Dark and glassy at noon, but genuinely emissive, so the same props read
    // at any other hour the level might be posed at.
    m.lamp = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x4a3a1e, THREE.SRGBColorSpace),
      roughness: 0.26, metalness: 0.0,
      emissive: new THREE.Color().setHex(0xffb648, THREE.SRGBColorSpace),
      emissiveIntensity: 0.55, envMapIntensity: 1.4
    });
    m.lamp.name = 'by_lamp';

    // ---- drum and crate: local art, cylindrically UV'd ---------------------
    m.drumSkin = new THREE.MeshStandardMaterial({
      map: this.tex.drum || null, color: 0xffffff,
      normalMap: this.tex.drumN || null,
      roughness: 0.68, metalness: 0.34, vertexColors: true, envMapIntensity: 1.0
    });
    if (this.tex.drumN) m.drumSkin.normalScale = new THREE.Vector2(0.85, 0.85);
    m.drumSkin.name = 'by_drum';

    m.crateSkin = new THREE.MeshStandardMaterial({
      map: this.tex.crate || null, color: 0xffffff,
      normalMap: this.tex.crateN || null,
      roughness: 0.90, metalness: 0.0, vertexColors: true, envMapIntensity: 0.9
    });
    if (this.tex.crateN) m.crateSkin.normalScale = new THREE.Vector2(0.7, 0.7);
    m.crateSkin.name = 'by_crate';

    // ---- the one wet surface in the level ----------------------------------
    // A drip pan of used hydraulic fluid.  Deliberately its OWN material rather
    // than a wetness channel on the steel: three of these in the whole yard is
    // the right amount of "something leaked here", and the moment the wet layer
    // is available to the general prop materials somebody uses it.
    // roughness 0.22, NOT the 0.09 the first pass used.  A horizontal near-
    // mirror under a noon sky reflects the brightest thing in the hemisphere
    // straight back at the lens: the drip pans photographed as blown-white
    // lozenges lying on the slab, which in a frame whose whole problem is
    // contrast is the most expensive possible place to put a specular hit.
    // Used hydraulic fluid in a steel tray is a dark gloss, not a mirror.
    m.spill = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(0x14120f, THREE.SRGBColorSpace),
      roughness: 0.22, metalness: 0.0, envMapIntensity: 0.85
    });
    m.spill.name = 'by_spill';

    // ---- plants ------------------------------------------------------------
    m.plant = new THREE.MeshStandardMaterial({
      map: this.tex.plants || null, color: 0xffffff,
      roughness: 0.86, metalness: 0.0,
      side: THREE.DoubleSide, alphaTest: 0.42, transparent: false,
      envMapIntensity: 1.0, vertexColors: true
    });
    m.plant.shadowSide = THREE.DoubleSide;
    m.plant.name = 'by_plant';
    applyWind(m.plant, this.uTime, this.uWind, this.uWindDir, 'p');
    applyTranslucency(m.plant, this.uSunDir, this.uSunCol, this.uTrans, 'p');
    this.plantDepth = windDepthMaterial(this.uTime, this.uWind, this.uWindDir,
      this.tex.plants, 0.42, THREE.DoubleSide);

    // ---- streamers ---------------------------------------------------------
    m.streamer = new THREE.MeshStandardMaterial({
      map: this.tex.streamer || null, color: 0xffffff,
      roughness: 0.88, metalness: 0.0, side: THREE.DoubleSide,
      envMapIntensity: 0.9, vertexColors: true
    });
    m.streamer.name = 'by_streamer';
    applyWind(m.streamer, this.uTime, this.uWind, this.uWindDir, 's');
    this.streamerDepth = windDepthMaterial(this.uTime, this.uWind, this.uWindDir,
      null, 0, THREE.DoubleSide);

    // ---- canopy cloth ------------------------------------------------------
    m.cloth = this._material('canvas_awning', W({ albedoTarget: 0x9a8f74, roughness: 0.94, side: THREE.DoubleSide }));
    applyWind(m.cloth, this.uTime, this.uWind, this.uWindDir, 'c');
    this.clothDepth = windDepthMaterial(this.uTime, this.uWind, this.uWindDir,
      null, 0, THREE.DoubleSide);

    // ---- ground stains -----------------------------------------------------
    // polygonOffset rather than a lifted quad: the slab has a crown and a joint
    // dip, so a stain floated 2 cm clear to beat z-fighting visibly hovers when
    // the camera is at eye height nine metres away, which is exactly where the
    // hero framing puts it.
    m.stain = new THREE.MeshStandardMaterial({
      map: this.tex.stains || null, color: 0xffffff,
      roughness: 0.62, metalness: 0.0,
      transparent: true, depthWrite: false, alphaTest: 0.02,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      envMapIntensity: 0.7
    });
    m.stain.name = 'by_stain';

    // ---- signage -----------------------------------------------------------
    function signMat(tex) {
      var s = new THREE.MeshStandardMaterial({
        map: tex || null, color: 0xffffff, roughness: 0.72, metalness: 0.05,
        side: THREE.DoubleSide, envMapIntensity: 0.9
      });
      return s;
    }
    m.signA = signMat(this.tex.signA);
    m.signB = signMat(this.tex.signB);
    m.signC = signMat(this.tex.signC);
    void self;
  };

  // ==========================================================================
  // LAYOUT - read the level's published anchors, and nothing else.
  //
  // level_boneyard.js publishes `anchors` from the constructor precisely so
  // that a consumer never has to derive a position from a camera pose.  The
  // poses ARE read here, but only into `_keepOut`: a prop dropped on top of the
  // hero eye is a prop nobody ever sees and a shot nobody can use.
  // ==========================================================================
  PropsBoneyard.prototype._probeLayout = function () {
    var lv = this.ctx.level;
    var A = (lv && lv.anchors) || null;
    this.A = A;

    if (A && A.yard) {
      this.bounds = { x0: A.yard.x0, x1: A.yard.x1, z0: A.yard.z0, z1: A.yard.z1 };
    }
    if (A && A.fence) {
      this.fence = { x0: A.fence.x0, x1: A.fence.x1, z0: A.fence.z0, z1: A.fence.z1 };
    }
    this.groundY = this._ground((this.bounds.x0 + this.bounds.x1) * 0.5,
      (this.bounds.z0 + this.bounds.z1) * 0.5);

    // Broadphase over the LEVEL's colliders so nothing is placed inside an
    // aeroplane, a hangar wall or the water tower's legs.
    try {
      if (lv && lv.colliders && lv.colliders.length) {
        this.hash = new GAME.SpatialHash(6.0);
        var mn = new THREE.Vector3(), mx = new THREE.Vector3();
        for (var i = 0; i < lv.colliders.length; i++) {
          var c = lv.colliders[i];
          GAME.Collision.boxBounds(c, mn, mx);
          this.hash.insert(c, mn, mx);
        }
      }
    } catch (e) { GAME.logError('propsB.hash', e); this.hash = null; }

    // The airframe inventory, if the level published it.  Everything degrades
    // to the anchor rows if it did not.
    this.aircraft = [];
    try {
      var src = (lv && lv.aircraft) || null;
      if (src && src.length) {
        for (var a = 0; a < src.length; a++) {
          var s = src[a];
          if (!s || !isFinite(s.x)) continue;
          this.aircraft.push({
            x: s.x, z: s.z, yaw: s.yaw, type: s.type, scale: s.scale || 1,
            onJacks: !!s.onJacks, noWings: !!s.noWings, big: false,
            info: s.info || null, gy: isFinite(s.groundY) ? s.groundY : this._ground(s.x, s.z)
          });
        }
      }
    } catch (e2) { /* the level may not publish its plan */ }
    try {
      var bsrc = (lv && lv.bigAircraft) || null;
      if (bsrc && bsrc.length) {
        for (var b = 0; b < bsrc.length; b++) {
          var t = bsrc[b];
          if (!t || !isFinite(t.x)) continue;
          this.aircraft.push({
            x: t.x, z: t.z, yaw: t.yaw, type: t.type, scale: 1,
            onJacks: false, noWings: false, big: true, name: t.name,
            info: t.info || null, gy: isFinite(t.groundY) ? t.groundY : this._ground(t.x, t.z)
          });
        }
      }
    } catch (e3) { /* ditto */ }
    // Last-resort inventory from the anchors alone.
    if (!this.aircraft.length && A && A.rows) {
      for (var r = 0; r < A.rows.length; r++) {
        for (var k = 0; k < A.rows[r].bays.length; k++) {
          var rx = A.rows[r].x, rz = A.rows[r].bays[k];
          this.aircraft.push({
            x: rx, z: rz, yaw: Math.PI, type: 'fighter', scale: 1,
            onJacks: false, noWings: false, big: false, info: null, gy: this._ground(rx, rz)
          });
        }
      }
    }

    // Shade, straight from the level.  Anything a human would choose to put in
    // the shade goes in one of these rectangles.
    this.shade = [];
    try {
      var Z = (lv && lv.shadeZones) || (A && A.shadeZones) || [];
      for (var s2 = 0; s2 < Z.length; s2++) {
        var zz = Z[s2];
        if (!zz || !isFinite(zz.x0)) continue;
        this.shade.push(zz);
      }
    } catch (e4) { /* advisory */ }

    // Camera eyes: a KEEP-OUT list, never a placement source.
    this._keepOut = [];
    try {
      var poses = (lv && lv.cameraPoses) || null;
      if (poses) {
        for (var key in poses) {
          if (!Object.prototype.hasOwnProperty.call(poses, key)) continue;
          var p = poses[key];
          if (p && p.position && isFinite(p.position.x)) {
            this._keepOut.push({ x: p.position.x, z: p.position.z, r: 1.35 });
          }
        }
      }
      var sp = (lv && lv.spawnPoints) || null;
      if (sp) {
        for (var q = 0; q < sp.length; q++) {
          if (sp[q] && sp[q].position) this._keepOut.push({ x: sp[q].position.x, z: sp[q].position.z, r: 1.1 });
        }
      }
    } catch (e5) { /* poses are optional */ }
  };

  // --------------------------------------------------------------------------
  // Placement primitives
  // --------------------------------------------------------------------------

  // The yard's ground is analytic and the level publishes it, so sampleGround
  // is both cheaper and more accurate than a ray.  The ray is the fallback for
  // anything standing on a level STRUCTURE (the hangar floor slab, a cradle
  // timber) rather than on the slab.
  PropsBoneyard.prototype._ground = function (x, z) {
    var lv = this.ctx.level;
    if (lv && lv.sampleGround) {
      try {
        var s = lv.sampleGround(x, z);
        if (isFinite(s)) return s;
      } catch (e) { /* fall through */ }
    }
    if (this.A && this.A.yard && this.A.yard.groundY) {
      try {
        var g = this.A.yard.groundY(x, z);
        if (isFinite(g)) return g;
      } catch (e2) { /* fall through */ }
    }
    return this.groundY || 0;
  };

  // Does level geometry already occupy this sphere?
  //
  // FLOOR COLLIDERS ARE EXCLUDED, and that exclusion is the point: the slab is
  // a plate whose top face IS the ground, so a test sphere sitting on the
  // ground always overlaps it, and including it would silently reject every
  // site in the yard.  We ask "is something in the way", never "is there a
  // floor here".
  PropsBoneyard.prototype._blocked = function (x, y, z, r) {
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

  PropsBoneyard.prototype._occupied = function (x, z, r) {
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
  PropsBoneyard.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  PropsBoneyard.prototype._inLens = function (x, z, r) {
    for (var i = 0; i < this._keepOut.length; i++) {
      var k = this._keepOut[i];
      var dx = x - k.x, dz = z - k.z;
      var rr = k.r + (r || 0);
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };

  // Inside the fence and off the taxiway centre.  Taxiway Alpha is the level's
  // leading line and a working tow route: its EDGES collect everything and its
  // middle stays clear, which is both true and what keeps the hero framing's
  // vanishing line readable.
  PropsBoneyard.prototype._inBounds = function (x, z, pad, opts) {
    var f = this.fence;
    pad = pad || 0;
    if (!(x > f.x0 + pad + 2 && x < f.x1 - pad - 2 && z > f.z0 + pad + 2 && z < f.z1 - pad - 2)) return false;
    if (opts && opts.taxi) return true;
    var A = this.A;
    if (A && A.taxiway && z > A.taxiway.z0 && z < A.taxiway.z1) {
      var half = (opts && opts.low) ? A.taxiway.half * 0.52 : A.taxiway.half * 0.92;
      if (Math.abs(x - A.taxiway.x) < half) return false;
    }
    return true;
  };

  // The one call every ground placement goes through.
  //
  //   opts: { r clearance, tilt max random tilt, yaw, scale, sink, collider,
  //           low true for anything under half a metre, taxi to allow the
  //           taxiway, color instance colour override }
  //
  // Returns the ground height it settled at, or null if the site was rejected.
  PropsBoneyard.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.5 : opts.r;
    if (!this._inBounds(x, z, 0.3, opts)) { this._skipped++; return null; }
    if (this._inLens(x, z, r * 0.8)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var y = opts.y === undefined ? this._ground(x, z) : opts.y;
    var cr = opts.clearR === undefined ? r * 0.8 : opts.clearR;
    if (!opts.noClear && this._blocked(x, y + (opts.h || 0.5) * 0.5, z, cr)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, TAU) : opts.yaw;
    // Every prop sits with a slight tilt.  On a slab that settles 0.4 m over
    // 200 m, a yard of objects standing dead plumb is the "perfectly straight
    // anything" the quality bar rejects on sight.
    var tilt = opts.tilt === undefined ? 0.030 : opts.tilt;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    // `pitch`/`roll`/`lift` are what let ONE batch serve a standing cone and a
    // knocked-over one, a standing drum and a drum on its side, a 3.1 m ladder
    // and a 1.9 m one.  Every variant folded back into its parent batch is a
    // draw call recovered, and the budget for this level is 80 for everything.
    var ok = batch.add(
      T(x, y - (opts.sink || 0) + (opts.lift || 0), z,
        (opts.pitch || 0) + this.rng.gaussian(0, tilt), yaw,
        (opts.roll || 0) + this.rng.gaussian(0, tilt),
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      opts.color || wearTint(this.rng, _colA),
      opts.color || dustTint(this.rng, _colB));
    if (!ok) return null;
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    // Anything standing on sand or on the pad edge has blown material heaped
    // round its foot.  This is the desert's version of the harbor's wet halo,
    // and it is what stops a prop terminating on a hard line against the slab.
    if (opts.foot !== false && r >= 0.28 && this.B.drift) {
      this._footDrift(x, z, Math.min(r * 1.5, 1.5));
    }
    return y;
  };

  PropsBoneyard.prototype._footDrift = function (x, z, r) {
    if (this._footCount === undefined) this._footCount = 0;
    if (this._footCount >= 210) return;
    if (this.rng.next() > 0.42) return;
    var b = this.B.drift;
    if (!b || b.n >= b.max) return;
    var w = this.windDir;
    // downwind of the obstruction, which is where the slip face builds
    var d = r * this.rng.range(0.55, 0.95);
    var px = x + w.x * d, pz = z + w.y * d;
    var y = this._ground(px, pz);
    b.add(T(px, y - 0.03, pz,
      this.rng.gaussian(0, 0.02), Math.atan2(w.x, w.y) + this.rng.gaussian(0, 0.22),
      this.rng.gaussian(0, 0.02),
      r * this.rng.range(0.42, 0.72), this.rng.range(0.34, 0.62), r * this.rng.range(0.42, 0.72)),
      wearTint(this.rng));
    this._footCount++;
  };

  PropsBoneyard.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  PropsBoneyard.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // Drop a whole Item into the static batches at a world transform.
  PropsBoneyard.prototype._place = function (item, x, y, z, yaw, scale) {
    if (!item) return;
    var base = Tn(x, y, z, 0, yaw || 0, 0, scale || 1, scale || 1, scale || 1);
    var keys = item.keys();
    for (var k = 0; k < keys.length; k++) {
      var list = item.buckets[keys[k]];
      for (var i = 0; i < list.length; i++) {
        this._static(keys[k], list[i].geometry,
          new THREE.Matrix4().multiplyMatrices(base, list[i].matrix));
      }
    }
  };

  // A ground stain.  `cell` picks the atlas quarter: 0 fresh pool, 1 drip
  // field, 2 tyre scrub, 3 dust smear.
  PropsBoneyard.prototype._stain = function (cell, x, z, w, d, yaw) {
    if (this.stainParts.length >= 260) return;
    if (!this._inBounds(x, z, 0.0, { taxi: true, low: true })) return;
    var u0 = (cell % 2) * 0.5 + 0.004, v0 = 1 - ((cell / 2 | 0) + 1) * 0.5 + 0.004;
    var g = card(w, d, u0, v0, u0 + 0.5 - 0.008, v0 + 0.5 - 0.008);
    var y = this._ground(x, z);
    this.stainParts.push(part(g, Tn(x, y + 0.006, z, -Math.PI * 0.5, yaw || 0, 0)));
  };

  PropsBoneyard.prototype._uvScale = function (name, texels) {
    try {
      if (this.ctx.materials && this.ctx.materials.uvScaleFor) {
        var s = this.ctx.materials.uvScaleFor(name, texels || 480);
        if (isFinite(s) && s > 0) return s;
      }
    } catch (e) { /* library still booting */ }
    return 1.2;
  };

  // Re-UV a merged prop to the library's declared texel density, copy uv1 for
  // the AO channel, and paint the dust mask.  Every instanced prop goes through
  // here so density does not visibly jump between a 0.2 m chock and a 3 m skip
  // - which is the tell that a prop set was authored piecemeal.
  PropsBoneyard.prototype._finishGeo = function (geo, matName, wear, texels, keepUV, matKey) {
    if (!geo) return null;
    if (!keepUV) {
      try { Geo.worldUV(geo, this._uvScale(matName, texels)); } catch (e) { /* keep builder uv */ }
    }
    Geo.copyUV1(geo);
    if (matKey && MULT[matKey]) paintTint(geo, wear || {});
    else paintDust(geo, wear || {});
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  // ==========================================================================
  // KIT - every repeated prop becomes an InstancedMesh (or a Combo of them).
  //
  // A batch is ALWAYS created, even if its builder returned nothing: a dozen
  // dressing call sites reach into this.B by name, and making one of them
  // conditional on a geometry that might be null turns a cosmetic failure into
  // a throw in the middle of a pass, which loses every prop after it.  An empty
  // batch is dropped in _commit and costs nothing.
  // ==========================================================================
  PropsBoneyard.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats;
    var self = this;

    // wear presets, by what the object actually is
    var W = {
      // painted steel plant: dust on top, oil and shade underneath, sandblasted
      // edges where the grit has stripped it back to primer
      plant: { noise: N, dust: 0.42, grime: 0.30, edge: 0.30, hiY: 1.4 },
      // ground clutter: more dust than anything, because it never moves
      ground: { noise: N, dust: 0.52, grime: 0.26, edge: 0.24, hiY: 0.9 },
      // timber: the sun destroys it, so edge wear (toward pale sand) dominates
      timber: { noise: N, dust: 0.44, grime: 0.22, edge: 0.44, hiY: 1.0 },
      // rubber holds dust and shows almost no bleach
      rubber: { noise: N, dust: 0.46, grime: 0.34, edge: 0.10, hiY: 1.0 },
      // salvage aluminium: chalked, oxidised, dusty
      alu: { noise: N, dust: 0.50, grime: 0.20, edge: 0.38, hiY: 1.2 },
      // sand is sand
      sand: { noise: N, dust: 0.16, grime: 0.10, edge: 0.06, hiY: 0.5 },
      // plants: the R channel does the dying, not the B
      plantLife: { noise: N, dust: 0.26, grime: 0.30, edge: 0.10, hiY: 1.0 }
    };
    // Published, because the dressing passes build one-off geometry too (hose
    // runs, cable runs) and a wear preset invented at the call site is how a
    // prop set stops reading as one place.
    this.W = W;

    // Build one Item into a set of parallel batches.
    function combo(key, item, spec, max, shadow) {
      var subs = [];
      var keys = item ? item.keys() : [];
      for (var i = 0; i < keys.length; i++) {
        var mk = keys[i];
        var geo = item.merge(mk);
        if (!geo) continue;
        var sp = (spec && spec[mk]) || (spec && spec['*']) || {};
        self._finishGeo(geo, sp.uvName || 'painted_metal', sp.wear || W.ground,
          sp.texels, sp.keepUV, mk);
        var mat = self.mats[mk] || self.mats.steel;
        var b = new Batch(geo, mat, max, shadow);
        b.mult = !!MULT[mk];
        self.B[key + ':' + mk] = b;
        subs.push(b);
      }
      var c = new Combo(subs);
      self.C[key] = c;
      self.B[key] = c;                 // _drop only needs .add
      return c;
    }

    // ---- servicing ---------------------------------------------------------
    combo('chock', K.chock(N, R), {
      yellow: { uvName: 'painted_metal', wear: { noise: N, dust: 0.50, grime: 0.34, edge: 0.44, hiY: 0.24 } },
      rubber: { uvName: 'rubber', wear: W.rubber }
    }, 190);

    // ONE cone batch serves both the standing cones and the knocked-over ones:
    // _drop's `pitch` and `lift` do what a second batch used to.
    combo('cone', K.cone(N, R, false), {
      cone: { uvName: 'plastic', wear: { noise: N, dust: 0.46, grime: 0.30, edge: 0.20, hiY: 0.75 } },
      coneBand: { uvName: 'plastic', wear: { noise: N, dust: 0.30, grime: 0.20, edge: 0.62, hiY: 0.6 } }
    }, 130);

    // Four colour lots so ninety drums are not ninety identical drums.  The lot
    // is baked into the geometry's v, so it costs four batches rather than
    // ninety materials - and a drum on its side is the same batch pitched over.
    for (var lot = 0; lot < 4; lot++) {
      combo('drum' + lot, K.drum(N, R, lot, false), {
        drumSkin: { keepUV: true, wear: { noise: N, dust: 0.46, grime: 0.34, edge: 0.30, hiY: 0.95 } }
      }, 40);
    }

    combo('pallet', K.pallet(N, R), { wood: { uvName: 'wood_plank', wear: W.timber } }, 95);
    // The small crate is this same batch at 0.57/0.52/0.65 scale.
    combo('crate', K.crate(N, R, 1.15, 0.85, 0.80), {
      crateSkin: { keepUV: true, wear: W.timber },
      wood: { uvName: 'wood_plank', wear: W.timber }
    }, 110);

    // Nose-gear wheels are this batch at 0.61.
    combo('wheel', K.wheel(N, R, 0.56), {
      rubber: { uvName: 'rubber', wear: W.rubber },
      steel: { uvName: 'painted_metal', wear: W.plant }
    }, 110);

    combo('dripPan', K.dripPan(N, R), {
      steel: { uvName: 'painted_metal', wear: { noise: N, dust: 0.30, grime: 0.66, edge: 0.24, hiY: 0.2 } },
      spill: { uvName: 'painted_metal', wear: { dust: 0, grime: 0, edge: 0 } }
    }, 48);

    // The short ladder is this one at 0.61 in y.
    combo('ladder', K.ladder(N, R, 3.1), {
      alu: { uvName: 'painted_metal', wear: W.alu },
      rubber: { uvName: 'rubber', wear: W.rubber }
    }, 56);

    combo('gasBottle', K.gasBottle(N, R), {
      gas: { uvName: 'painted_metal', wear: W.plant },
      steel: { uvName: 'painted_metal', wear: W.plant }
    }, 56);
    combo('jerrycan', K.jerrycan(N, R), { olive: { uvName: 'painted_metal', wear: W.ground } }, 48);
    combo('partsBin', K.partsBin(N, R), { binPlastic: { uvName: 'plastic', wear: W.ground } }, 80);
    combo('bucket', K.bucket(N, R), { steel: { uvName: 'painted_metal', wear: W.ground } }, 44);

    // ---- salvage -----------------------------------------------------------
    // Two panel and three scrap variants, chosen per placement, so a hundred
    // offcuts are not one offcut a hundred times.
    var pi;
    for (pi = 0; pi < 2; pi++) {
      combo('panel' + pi, K.panel(N, R, 0x1000 + pi * 37), {
        alu: { uvName: 'painted_metal', wear: W.alu }
      }, 44);
    }
    for (pi = 0; pi < 3; pi++) {
      combo('scrap' + pi, K.scrap(N, R, 0x2000 + pi * 53), {
        alu: { uvName: 'painted_metal', wear: { noise: N, dust: 0.62, grime: 0.30, edge: 0.44, hiY: 0.3 } }
      }, 80, false);
    }
    combo('duct', K.duct(N, R), { alu: { uvName: 'painted_metal', wear: W.alu } }, 46);

    // ---- one-off plant, as MERGED statics ----------------------------------
    // A tool cart, a step stand, a fire bottle, a work light, a jersey barrier,
    // a cable reel and a compressor spool are each placed 12-24 times.  At that
    // count an InstancedMesh costs one to three whole draw calls apiece and the
    // merged alternative costs NONE, because every part lands in a static batch
    // this file already emits.  They still get per-placement yaw, scale and
    // ground tilt through _place, so nothing about them reads as cloned.
    this.oneOff = {
      toolCart: K.toolCart(N, R),
      stepStand: K.stepStand(N, R),
      fireExt: K.fireExt(N, R),
      workLight: K.workLight(N, R),
      barrier: K.barrier(N, R),
      reel: K.reel(N, R, 0.52),
      spool: K.spool(N, R),
      tug: K.tug(N, R),
      forklift: K.forklift(N, R),
      trailer: K.trailer(N, R),
      gpu: K.gpu(N, R),
      pickup: K.pickup(N, R),
      container: K.container(N, R),
      skip: K.skip(N, R),
      portaloo: K.portaloo(N, R),
      canopy: K.canopyFrame(N, R, 4.2, 3.0, 2.4),
      bench: K.benchClutter(N, R, 4.0)
    };

    // ---- nature ------------------------------------------------------------
    // Cell 0 creosote, 1 dead brittlebush, 2 joint weed, 3 tumbleweed.  Plants
    // carry aFlex from the base up so the wind snippet pins the root.  Size
    // variation is per-instance scale, not a second batch.
    function plantBatch(key, cell, w, h, cards, max) {
      var item = K.plant(N, R, cell, w, h, cards);
      var geo = item.merge('plant');
      if (!geo) { self.B[key] = new Batch(new THREE.BoxGeometry(0.01, 0.01, 0.01), m.plant, 1); return; }
      Geo.copyUV1(geo);
      paintTint(geo, W.plantLife);
      setFlex(geo, function (x, y) { return M.saturate(y / Math.max(0.2, h)) * 0.9; });
      var b = new Batch(geo, m.plant, max, true);
      b.mult = true;
      b.mesh.customDepthMaterial = self.plantDepth;
      self.B[key] = b;
      self.windMeshes.push(b.mesh);
    }
    plantBatch('creosote', 0, 1.55, 1.35, 4, 300);
    plantBatch('brittle', 1, 1.10, 0.92, 4, 150);
    // 0.62 m, not the 0.42 the first pass used.  Measured, not preferred: a
    // joint weed is the only prop in this level whose whole job is to be seen
    // at 15-30 m across an empty slab, and at 0.42 m it resolved to about ten
    // pixels in the hero framing and simply did not exist.  Real apron grass in
    // a saw-cut joint is knee-high by August.
    plantBatch('weed', 2, 0.62, 0.52, 3, 620);

    (function () {
      var item = K.tumbleweed(N, R, 0.46);
      var geo = item.merge('plant');
      if (!geo) return;
      Geo.copyUV1(geo);
      paintTint(geo, { noise: N, dust: 0.34, grime: 0.18, hiY: 0.9 });
      setFlex(geo, function (x, y) { return M.saturate(y / 0.9) * 0.5; });
      var b = new Batch(geo, m.plant, 130, true);
      b.mult = true;
      b.mesh.customDepthMaterial = self.plantDepth;
      self.B.tumbleweed = b;
      self.windMeshes.push(b.mesh);
    })();

    // ---- accumulation ------------------------------------------------------
    (function () {
      var geo = K.drift(N, R, 0x3001).merge('sandProp');
      if (!geo) return;
      self._finishGeo(geo, 'sand', W.sand, 420);
      // A drift casts almost nothing and receives everything; leaving it out of
      // the shadow pass saves a real cost across 200 instances.
      self.B.drift = new Batch(geo, m.sandProp, 340, false);
    })();
    for (pi = 0; pi < 2; pi++) {
      combo('rock' + pi, K.rock(N, R, 0x4000 + pi * 91), {
        rockProp: { uvName: 'gravel', wear: { noise: N, dust: 0.34, grime: 0.16, edge: 0.10, hiY: 0.4 } }
      }, 130, false);
    }

    // ---- streamers ---------------------------------------------------------
    (function () {
      var item = K.streamerTag(N, R);
      var gs = item.merge('streamer');
      var gm = item.merge('steel');
      if (gs) {
        Geo.copyUV1(gs);
        paintTint(gs, { noise: N, dust: 0.34, grime: 0.20, hiY: 0.1 });
        // aFlex grows with distance BELOW the anchor: the tag body is pinned,
        // the free end streams.
        setFlex(gs, function (x, y) { return M.saturate(-y / 0.46); });
        var b = new Batch(gs, m.streamer, 90, false);
        b.mult = true;
        b.mesh.customDepthMaterial = self.streamerDepth;
        self.B['streamer:streamer'] = b;
        self.windMeshes.push(b.mesh);
      }
      var b2 = null;
      if (gm) {
        self._finishGeo(gm, 'painted_metal', W.plant);
        b2 = new Batch(gm, m.steel, 90, false);
        self.B['streamer:steel'] = b2;
      }
      self.B.streamer = new Combo([self.B['streamer:streamer'] || null, b2]);
    })();

    void R;
  };

  // --------------------------------------------------------------------------
  // Place a one-off item, merged into the static batches.
  // --------------------------------------------------------------------------
  PropsBoneyard.prototype._put = function (name, x, z, opts) {
    opts = opts || {};
    var item = this.oneOff && this.oneOff[name];
    if (!item) return null;
    var r = opts.r === undefined ? 1.2 : opts.r;
    if (!this._inBounds(x, z, 0.3, opts)) { this._skipped++; return null; }
    if (this._inLens(x, z, r)) { this._skipped++; return null; }
    if (this._occupied(x, z, r)) { this._skipped++; return null; }
    var y = opts.y === undefined ? this._ground(x, z) : opts.y;
    var cr = opts.clearR === undefined ? r * 0.7 : opts.clearR;
    if (!opts.noClear && this._blocked(x, y + (opts.h || 1.0) * 0.5, z, cr)) { this._skipped++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, TAU) : opts.yaw;
    var tilt = opts.tilt === undefined ? 0.020 : opts.tilt;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    var base = Tn(x, y, z,
      (opts.pitch || 0) + this.rng.gaussian(0, tilt), yaw, this.rng.gaussian(0, tilt),
      sc, sc, sc);
    var keys = item.keys();
    for (var k = 0; k < keys.length; k++) {
      var list = item.buckets[keys[k]];
      for (var i = 0; i < list.length; i++) {
        this._static(keys[k], list[i].geometry,
          new THREE.Matrix4().multiplyMatrices(base, list[i].matrix));
      }
    }
    this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    if (opts.foot !== false) this._footDrift(x, z, Math.min(r * 1.3, 1.8));
    return y;
  };

  PropsBoneyard.prototype._var = function (stem, n) {
    return this.B[stem + this.rng.int(0, n - 1)];
  };

  // Is (x,z) inside one of the level's published shade rectangles?  Anything a
  // human would CHOOSE to leave somewhere goes here, and asking the level means
  // this file never has to re-solve the sun.
  PropsBoneyard.prototype._inShade = function (x, z) {
    for (var i = 0; i < this.shade.length; i++) {
      var s = this.shade[i];
      if (x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1) return true;
    }
    return false;
  };

  // A point in the deep shade of a named source, if the level published one.
  PropsBoneyard.prototype._shadeSpot = function (source, t, u) {
    for (var i = 0; i < this.shade.length; i++) {
      var s = this.shade[i];
      if (s.source !== source) continue;
      return { x: M.lerp(s.x0, s.x1, t), z: M.lerp(s.z0, s.z1, u) };
    }
    return null;
  };

  // Local -> world for an airframe in the level's own convention (nose -Z,
  // starboard +X), matching level_boneyard's _addAircraftColliders exactly.
  function acWorld(a, lx, lz, out) {
    var c = Math.cos(a.yaw), s = Math.sin(a.yaw);
    var sc = a.scale || 1;
    out.x = a.x + (lx * sc) * c + (lz * sc) * s;
    out.z = a.z - (lx * sc) * s + (lz * sc) * c;
    return out;
  }

  // ==========================================================================
  // PASS 1 - THE PLANT
  //
  // Blocked out first, because these are the only objects in the kit that need
  // four clear metres and the later passes will otherwise have filled every
  // site they could use.  Every one of them is placed against an anchor, and
  // three of them are placed in SHADE the level published, because a vehicle
  // left in a yard at noon is parked where the shade is.
  // ==========================================================================
  PropsBoneyard.prototype._dressPlant = function () {
    var A = this.A;
    if (!A) return;
    var R = this.rng;

    // ---- the tug, under Sierra Seven's port wing ---------------------------
    // The hero framing looks along that wing from inside its shadow band.  A
    // 3.6 m tractor parked in the same band at 20 m is the ONE object in the
    // frame whose size the audience already knows, and it is what converts the
    // wing above it from a shape into six metres of aluminium.
    if (A.sierra7 && A.sierra7.shade && A.sierra7.shade.at) {
      var tx = A.sierra7.centre.x - 20.5;
      var band = A.sierra7.shade.at(tx);
      if (band) {
        this._put('tug', tx, band.centre, {
          yaw: A.sierra7.yaw + 0.34, r: 3.4, h: 2.1,
          collider: [1.2, 0.9, 2.2], material: 'metal'
        });
        this._stain(1, tx, band.centre + 2.2, 3.0, 2.4, 0.4);
      }
      // a ground power unit under the nose, cable run out to the aircraft
      var gx = A.sierra7.centre.x - 7.5;
      var gband = A.sierra7.shade.at(gx);
      if (gband) {
        this._put('gpu', gx, gband.centre - 1.0, {
          yaw: A.sierra7.yaw - 0.2, r: 2.4, h: 1.8,
          collider: [0.75, 0.9, 1.3], material: 'metal'
        });
      }
    }

    // ---- the hangar apron --------------------------------------------------
    if (A.hangar) {
      var hg = A.hangar;
      this._put('forklift', hg.x0 + 6.5, hg.z0 + 27.0, {
        yaw: -1.35, r: 2.2, h: 1.8, y: hg.floorY, noClear: true, foot: false,
        collider: [0.7, 0.9, 1.4], material: 'metal'
      });
      this._put('skip', hg.x0 - 5.2, hg.z1 + 3.6, {
        yaw: 1.62, r: 2.6, h: 1.4, collider: [1.0, 0.7, 1.7], material: 'metal'
      });
      this._put('tug', hg.x0 - 9.0, hg.doorZ1 + 5.0, {
        yaw: 0.92, r: 3.2, h: 2.1, collider: [1.2, 0.9, 2.2], material: 'metal'
      });
      // a work light and two fire bottles at the door, where they legally are
      this._put('workLight', hg.x0 - 1.4, hg.doorZ0 - 1.6, { yaw: 0.6, r: 0.8, h: 1.6, foot: false });
      this._put('fireExt', hg.x0 - 0.9, hg.doorZ1 + 1.1, { yaw: -1.5, r: 0.7, h: 1.0, foot: false });
      this._put('fireExt', hg.x0 - 0.9, hg.doorZ1 + 1.9, { yaw: -1.4, r: 0.7, h: 1.0, foot: false });
    }

    // ---- the parts yard ----------------------------------------------------
    if (A.partsYard) {
      var py = A.partsYard;
      // two containers used as parts stores, end-on so they close the yard's
      // north end without walling the framing off
      this._put('container', py.x1 - 3.2, py.z1 - 4.0, {
        yaw: 0.06, r: 4.2, h: 2.8, collider: [1.3, 1.4, 3.1], material: 'metal'
      });
      this._put('container', py.x1 - 3.2, py.z1 - 11.0, {
        yaw: -0.04, r: 4.2, h: 2.8, collider: [1.3, 1.4, 3.1], material: 'metal'
      });
      this._put('trailer', py.x0 + 3.0, py.z0 + 6.5, {
        yaw: 1.48, r: 3.6, h: 1.2, collider: [1.1, 0.8, 2.6], material: 'metal'
      });
      this._put('forklift', py.x0 + 5.6, py.z1 - 9.0, {
        yaw: 2.35, r: 2.2, h: 1.8, collider: [0.7, 0.9, 1.4], material: 'metal'
      });
      this._put('skip', py.x0 + 2.4, py.z1 - 2.5, {
        yaw: -0.24, r: 2.6, h: 1.4, collider: [1.0, 0.7, 1.7], material: 'metal'
      });
      this._put('spool', py.x0 + 8.5, py.z0 + 1.5, { yaw: 0.8, r: 1.2, h: 0.9 });
      this._put('spool', py.x0 + 10.4, py.z0 + 0.4, { yaw: -0.3, r: 1.2, h: 0.9 });
      this._put('reel', py.x0 + 1.6, py.z0 + 13.0, { yaw: 1.2, r: 1.0, h: 1.0 });
      this._put('reel', py.x0 + 1.4, py.z0 + 15.2, { yaw: 1.4, r: 1.0, h: 1.0 });
      this._stain(2, py.x0 + 5.0, py.z0 + 10.0, 9.0, 7.0, 0.2);
    }

    // ---- the ops shack -----------------------------------------------------
    if (A.opsShack) {
      var op = A.opsShack;
      // the pickup goes on the SHADED side, which the level publishes.
      var ss = op.shadeSide;
      this._put('pickup', ss.x + 1.4, ss.z + 1.2, {
        yaw: op.yaw + 1.62, r: 3.4, h: 1.6,
        collider: [1.05, 0.95, 2.7], material: 'metal'
      });
      this._put('portaloo', op.centre.x - 7.4, op.centre.z + 2.6, {
        yaw: op.yaw + 0.12, r: 1.3, h: 2.3, collider: [0.6, 1.15, 0.6], material: 'plastic'
      });
      // a shade canopy over the crew's table: the only human-scale roof in the
      // level outside the hangar
      var cx = op.centre.x + 2.6, cz = op.centre.z + 7.4;
      if (this._put('canopy', cx, cz, { yaw: op.yaw - 0.1, r: 3.2, h: 2.4, foot: false }) !== null) {
        this._canopy = { x: cx, z: cz, y: this._ground(cx, cz), yaw: op.yaw - 0.1, w: 4.2, d: 3.0, h: 2.4 };
      }
      this._put('barrier', op.centre.x - 6.0, op.centre.z - 5.4, {
        yaw: op.yaw + 0.02, r: 1.6, h: 0.9, collider: [1.25, 0.42, 0.32], material: 'concrete'
      });
      this._put('barrier', op.centre.x - 3.4, op.centre.z - 5.5, {
        yaw: op.yaw - 0.03, r: 1.6, h: 0.9, collider: [1.25, 0.42, 0.32], material: 'concrete'
      });
      this._put('fireExt', op.doorSide.x + 1.9, op.doorSide.z - 0.5, { yaw: 0.2, r: 0.7, h: 1.0, foot: false });
      this._stain(2, op.centre.x + 6.0, op.centre.z + 2.0, 8.0, 7.0, 0.5);
    }

    // ---- the gate ----------------------------------------------------------
    if (A.fence && A.fence.gate) {
      var gt = A.fence.gate;
      for (var i = 0; i < 4; i++) {
        this._put('barrier', gt.centre.x + (i < 2 ? -1 : 1) * (gt.halfWidth + 1.6 + (i % 2) * 2.5),
          gt.centre.z - 3.0 - (i % 2) * 0.4, {
            yaw: 0.02 + R.range(-0.05, 0.05), r: 1.5, h: 0.9, taxi: true,
            collider: [1.25, 0.42, 0.32], material: 'concrete'
          });
      }
    }
    void R;
  };

  // ==========================================================================
  // PASS 2 - THE AIRFRAMES
  //
  // Everything here hangs off a real wheel, a real nacelle or a real tie-down
  // point.  A chock that is not at a wheel is a yellow brick; a drip pan that
  // is not under something that leaks is a tray.
  // ==========================================================================
  PropsBoneyard.prototype._dressAircraft = function () {
    var R = this.rng;
    var w = new THREE.Vector3();
    var list = this.aircraft || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var g = GEAR[a.type];
      var sc = a.scale || 1;
      var yaw = a.yaw;
      var chockYaw = yaw + Math.PI * 0.5;      // the chock's wedge faces the tyre

      // ---- chocks, fore and aft of each main wheel -------------------------
      if (g && !a.onJacks) {
        var mains = [-g.mainX, g.mainX];
        for (var s = 0; s < mains.length; s++) {
          for (var f = 0; f < 2; f++) {
            var lz = g.mainZ + (f ? 1 : -1) * (g.wheelR + 0.30);
            acWorld(a, mains[s], lz, w);
            this._drop(this.B.chock, w.x, w.z, {
              r: 0.32, yaw: chockYaw + (f ? Math.PI : 0) + R.gaussian(0, 0.09),
              scale: sc * R.range(0.94, 1.08), tilt: 0.035, low: true, taxi: true,
              noClear: true, foot: false
            });
          }
        }
        // and one at the nose wheel, on the side the tug came in from
        acWorld(a, 0, g.noseZ + g.wheelR + 0.28, w);
        this._drop(this.B.chock, w.x, w.z, {
          r: 0.30, yaw: chockYaw + R.gaussian(0, 0.12), scale: sc * 0.92,
          low: true, taxi: true, noClear: true, foot: false
        });
      }

      // ---- REMOVE BEFORE FLIGHT tags --------------------------------------
      // On the gear leg and, on anything with an intake, on the intake plug.
      if (g && R.next() < 0.62) {
        acWorld(a, g.mainX * (R.bool() ? 1 : -1), g.mainZ, w);
        var legY = this._ground(w.x, w.z) + g.h * sc * R.range(0.55, 0.80);
        this._drop(this.B.streamer, w.x, w.z, {
          r: 0.10, y: legY, yaw: R.range(0, TAU), scale: sc,
          low: true, taxi: true, noClear: true, foot: false, tilt: 0.02
        });
      }

      // ---- ground staining under the engines and the belly -----------------
      // A boneyard aircraft has been drained, but forty years of it has gone
      // into the slab underneath, and it is the only tonal break in a bay.
      if (a.big) {
        this._stain(1, a.x + R.range(-3, 3), a.z + R.range(-6, 6), 7.5, 6.0, yaw);
        this._stain(0, a.x + R.range(-2, 2), a.z + R.range(-4, 4), 2.4, 2.0, R.range(0, 3));
      } else if (R.next() < 0.55) {
        this._stain(1, a.x + R.range(-1.6, 1.6), a.z + R.range(-2.6, 2.6), 3.4, 2.8, yaw);
      }
      // the tow-in scrub where a tug dragged it onto its line
      if (R.next() < 0.35) {
        this._stain(2, a.x + R.range(-1, 1), a.z - 6.5 + R.range(-2, 2), 5.5, 7.0, yaw);
      }

      // ---- drip pan under a nacelle ---------------------------------------
      if (a.big && g) {
        acWorld(a, (R.bool() ? 1 : -1) * R.range(4.0, 8.0), R.range(-2, 3), w);
        this._drop(this.B.dripPan, w.x, w.z, {
          r: 0.62, yaw: yaw + R.gaussian(0, 0.2), low: true, taxi: true, noClear: true, foot: false
        });
      } else if (R.next() < 0.22) {
        acWorld(a, R.range(-1.2, 1.2), R.range(-1.5, 2.0), w);
        this._drop(this.B.dripPan, w.x, w.z, {
          r: 0.62, yaw: yaw + R.gaussian(0, 0.3), low: true, taxi: true, noClear: true, foot: false
        });
      }

      // ---- being worked on -------------------------------------------------
      // A ladder leans on a fuselage, a tool cart stands beside it, and both go
      // on the aircraft's SHADED flank, because that is where a human works.
      var working = a.onJacks || a.noWings || a.big || R.next() < 0.16;
      if (working) {
        var side = R.bool() ? 1 : -1;
        var offX = (a.info && a.info.r ? a.info.r : 1.0) * sc + 0.55;
        acWorld(a, side * offX, R.range(-2.5, 2.5), w);
        if (R.next() < 0.62) {
          this._drop(this.B.ladder, w.x, w.z, {
            r: 0.55, yaw: yaw + (side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5) + R.gaussian(0, 0.12),
            pitch: R.range(0.16, 0.26), scale: a.big ? 1.0 : R.range(0.58, 0.68),
            taxi: true, noClear: true, foot: false
          });
        }
        acWorld(a, side * (offX + 1.5), R.range(-3.5, 3.5), w);
        if (R.next() < 0.55) {
          this._put('toolCart', w.x, w.z, {
            yaw: yaw + R.range(-0.5, 0.5), r: 0.9, h: 1.0, taxi: true, noClear: true, foot: false
          });
        }
        acWorld(a, side * (offX + 0.8), R.range(-4.0, 4.0), w);
        if (R.next() < 0.45) {
          this._put('stepStand', w.x, w.z, {
            yaw: yaw + R.range(-0.6, 0.6), r: 0.7, h: 0.8, taxi: true, noClear: true, foot: false
          });
        }
      }

      // ---- what came off it ------------------------------------------------
      // A stripped airframe has its own parts lying beside it: that adjacency
      // is the whole story of the place, and scattering the same objects at
      // random across the yard would tell none of it.
      if (a.noWings || a.onJacks) {
        var n = R.int(2, 5);
        for (var k = 0; k < n; k++) {
          var ang = R.range(0, TAU), rad = R.range(3.0, 7.5);
          var px = a.x + Math.cos(ang) * rad, pz = a.z + Math.sin(ang) * rad;
          this._drop(this._var('scrap', 3), px, pz, {
            r: 0.42, low: true, taxi: true, noClear: true, foot: false,
            scale: R.range(0.7, 1.35), tilt: 0.09
          });
        }
        if (R.next() < 0.45) {
          acWorld(a, R.range(-6, 6), R.range(-5, 5), w);
          this._drop(this._var('panel', 2), w.x, w.z, {
            r: 0.9, yaw: R.range(0, TAU), pitch: R.range(-0.30, -0.16),
            taxi: true, noClear: true, scale: R.range(0.85, 1.2)
          });
        }
        if (R.next() < 0.40) {
          acWorld(a, R.range(-5, 5), R.range(-6, 6), w);
          this._drop(this.B.wheel, w.x, w.z, {
            r: 0.55, yaw: R.range(0, TAU), pitch: Math.PI * 0.5, lift: -0.40,
            scale: R.range(0.72, 1.0), taxi: true, noClear: true, foot: false
          });
        }
      }

      // ---- sand banked against the wheels ----------------------------------
      // Twenty years parked in a desert and the wind always from the same
      // quarter: there is a drift on the lee side of every tyre in the yard,
      // and its absence is what makes CG aeroplanes look freshly delivered.
      if (g && !a.onJacks && R.next() < 0.7) {
        var sgn = R.bool() ? 1 : -1;
        acWorld(a, sgn * g.mainX, g.mainZ, w);
        var b = this.B.drift;
        if (b && b.n < b.max) {
          var d = 0.55;
          var dx = w.x + this.windDir.x * d, dz = w.z + this.windDir.y * d;
          b.add(T(dx, this._ground(dx, dz) - 0.02, dz,
            R.gaussian(0, 0.02), Math.atan2(this.windDir.x, this.windDir.y) + R.gaussian(0, 0.2),
            R.gaussian(0, 0.02),
            R.range(0.34, 0.52), R.range(0.30, 0.50), R.range(0.34, 0.52)),
            wearTint(R));
        }
      }
    }
  };

  // --------------------------------------------------------------------------
  // Placement patterns.
  //
  // Uniform random scatter is on the instant-fail list and it is on it for a
  // reason: real objects are put down BY somebody, against something, in a
  // line, or they end up where the wind put them.  These three helpers are the
  // only ways anything in this file reaches the ground.
  // --------------------------------------------------------------------------

  // A run of props against a wall / rack / container face.  `nx,nz` is the
  // outward normal of the face; everything lands with its back to it.
  PropsBoneyard.prototype._against = function (batch, x0, z0, x1, z1, nx, nz, n, opts) {
    opts = opts || {};
    var R = this.rng;
    var placed = 0;
    var yaw0 = Math.atan2(nx, nz);
    for (var i = 0; i < n; i++) {
      var t = (i + 0.5) / n + R.gaussian(0, 0.35 / n);
      if (t < 0 || t > 1) continue;
      var off = (opts.off === undefined ? 0.55 : opts.off) * R.range(0.85, 1.35);
      var px = M.lerp(x0, x1, t) + nx * off;
      var pz = M.lerp(z0, z1, t) + nz * off;
      var o = {
        r: opts.r === undefined ? 0.45 : opts.r,
        yaw: yaw0 + R.gaussian(0, opts.spread === undefined ? 0.22 : opts.spread),
        scale: opts.scale ? opts.scale() : R.range(0.94, 1.06),
        low: opts.low, taxi: true, noClear: opts.noClear,
        collider: opts.collider, material: opts.material, tilt: opts.tilt,
        y: opts.y, foot: opts.foot, h: opts.h
      };
      if (opts.put) { if (this._put(opts.put, px, pz, o) !== null) placed++; }
      else if (this._drop(batch, px, pz, o) !== null) placed++;
    }
    return placed;
  };

  // A heap: dense in the middle, thinning outward, with the long axis along the
  // wind.  Debris does not spread evenly; it piles.
  PropsBoneyard.prototype._heap = function (batch, cx, cz, n, radius, opts) {
    opts = opts || {};
    var R = this.rng;
    var placed = 0;
    for (var i = 0; i < n; i++) {
      var a = R.range(0, TAU);
      // sqrt-free: bias hard toward the centre
      var d = radius * R.next() * R.next();
      var px = cx + Math.cos(a) * d * (opts.ax || 1);
      var pz = cz + Math.sin(a) * d * (opts.az || 1);
      var o = {
        r: opts.r === undefined ? 0.35 : opts.r,
        scale: opts.scale ? opts.scale() : R.range(0.75, 1.30),
        low: opts.low === undefined ? true : opts.low,
        taxi: true, noClear: true, foot: opts.foot === undefined ? false : opts.foot,
        tilt: opts.tilt === undefined ? 0.10 : opts.tilt,
        pitch: opts.pitch, lift: opts.lift, yaw: opts.yaw
      };
      if (opts.put) { if (this._put(opts.put, px, pz, o) !== null) placed++; }
      else if (this._drop(batch, px, pz, o) !== null) placed++;
    }
    return placed;
  };

  // A row of upright aircraft tyres, leaned against each other.
  //
  // NOT a flat stack.  The kit's wheel is authored upright (axis along X,
  // sitting on its tread) because that is how it is used at every gear station
  // in the yard, and laying one flat would need either a second geometry - two
  // more draw calls - or a rotation whose translation is yaw-dependent.  A row
  // of tyres stood on edge against a rack is the other way they are actually
  // stored, it needs neither, and the lean gives a better silhouette than a
  // stack of doughnuts anyway.
  PropsBoneyard.prototype._tyreRow = function (x, z, n, yaw, opts) {
    opts = opts || {};
    var R = this.rng;
    var dx = Math.cos(yaw), dz = Math.sin(yaw);
    var placed = 0;
    for (var i = 0; i < n; i++) {
      var t = (i - (n - 1) * 0.5) * 0.30;
      var px = x + dx * t, pz = z + dz * t;
      // r 0.13, not 0.30: the members of a leaning row TOUCH, and a keep-apart
      // radius larger than the pitch made _occupied reject every tyre after the
      // first - the capture came back with one tyre where four were asked for.
      if (this._drop(this.B.wheel, px, pz, {
        r: 0.13, yaw: yaw + Math.PI * 0.5 + R.gaussian(0, 0.05),
        roll: R.range(0.10, 0.22) * (i < n * 0.5 ? 1 : -1),
        scale: R.range(0.92, 1.06),
        taxi: true, noClear: true, foot: i === 0
      }) !== null) placed++;
    }
    if (placed && opts.collider) this._collider(x, this._ground(x, z), z, opts.collider, yaw, 'rubber');
    return placed;
  };

  // A vertical stack: crates on crates, drums on a pallet, pallets on pallets.
  PropsBoneyard.prototype._stack = function (batch, x, z, layers, step, opts) {
    opts = opts || {};
    var R = this.rng;
    var base = this._ground(x, z);
    if (!this._inBounds(x, z, 0.3, { taxi: true })) return 0;
    if (this._inLens(x, z, 1.0)) return 0;
    if (this._occupied(x, z, opts.r === undefined ? 0.8 : opts.r)) return 0;
    if (this._blocked(x, base + 0.6, z, (opts.r === undefined ? 0.8 : opts.r) * 0.7)) return 0;
    var yaw0 = opts.yaw === undefined ? R.range(0, TAU) : opts.yaw;
    var placed = 0;
    for (var i = 0; i < layers; i++) {
      // each course is set down a little off the one below - nobody stacks
      // perfectly, and a perfectly aligned stack is the loudest tell there is
      var jx = x + R.gaussian(0, 0.055 * (i + 1));
      var jz = z + R.gaussian(0, 0.055 * (i + 1));
      var ok = batch.add(
        T(jx, base + i * step, jz,
          R.gaussian(0, 0.012), yaw0 + R.gaussian(0, 0.10 + i * 0.05), R.gaussian(0, 0.012),
          opts.sx || 1, opts.sy || 1, opts.sz || 1),
        wearTint(R, _colA), dustTint(R, _colB));
      if (ok) placed++;
    }
    this._occupy(x, z, opts.r === undefined ? 0.8 : opts.r);
    if (opts.collider) this._collider(x, base, z, opts.collider, yaw0, opts.material);
    this._footDrift(x, z, 1.1);
    return placed;
  };

  // ==========================================================================
  // PASS 3 - THE PARTS YARD
  //
  // The subject of hero2, and the other half of what a boneyard IS: a salvage
  // depot with aeroplanes attached.  Everything here is stacked against the
  // racks, the containers and the cradles the level already built - the point
  // of a parts yard is that things are PUT somewhere.
  // ==========================================================================
  PropsBoneyard.prototype._dressPartsYard = function () {
    var A = this.A;
    if (!A || !A.partsYard) return;
    var py = A.partsYard, R = this.rng;
    var i;

    // ---- drums, banked against the container line -------------------------
    for (i = 0; i < 4; i++) {
      this._against(this.B['drum' + (i % 4)],
        py.x1 - 6.2, py.z1 - 14.5, py.x1 - 6.2, py.z1 - 2.5, -1, 0, 4,
        { r: 0.40, off: 0.4 + i * 0.62, low: false, noClear: true });
    }
    // a bunded row on pallets, which is how fluids are actually stored
    for (i = 0; i < 4; i++) {
      var bx0 = py.x0 + 2.2 + i * 1.28;
      this._drop(this.B.pallet, bx0, py.z0 + 2.6, { r: 0.62, yaw: 0.04, noClear: true, foot: false });
      this._drop(this.B['drum' + (i % 4)], bx0, py.z0 + 2.6, {
        r: 0.40, y: this._ground(bx0, py.z0 + 2.6) + 0.12, noClear: true, foot: false,
        yaw: R.range(0, TAU)
      });
    }
    // and three on their side, rolled off the end of the row
    for (i = 0; i < 3; i++) {
      this._drop(this.B['drum' + ((i + 1) % 4)], py.x0 + 7.4 + i * 0.72, py.z0 + 2.0 + R.range(-0.5, 0.5), {
        r: 0.48, pitch: Math.PI * 0.5, lift: 0.293, yaw: R.range(0, TAU),
        tilt: 0.05, noClear: true
      });
    }

    // ---- crates: two stacks against the wing racks, loose ones round them --
    for (i = 0; i < A.partsYard.wingRacks.length; i++) {
      var wr = A.partsYard.wingRacks[i];
      this._stack(this.B.crate, wr.x - 5.4, wr.z - 1.8, 2, 0.90,
        { r: 0.95, yaw: 0.08 + R.gaussian(0, 0.15), collider: [0.62, 0.85, 0.45], material: 'wood' });
      this._against(this.B.crate, wr.x - 4.6, wr.z + 1.4, wr.x - 4.6, wr.z + 3.4, -1, 0, 2,
        { r: 0.75, off: 0.6, noClear: true, scale: function () { return R.range(0.55, 0.66); } });
      // salvaged skin panels leaning against the rack legs - the single most
      // boneyard-specific silhouette in the kit
      this._drop(this._var('panel', 2), wr.x - 4.5, wr.z - 3.4, {
        r: 0.8, yaw: Math.PI * 0.5 + R.gaussian(0, 0.2), pitch: -0.24,
        noClear: true, scale: R.range(0.9, 1.25)
      });
      this._drop(this._var('panel', 2), wr.x + 4.5, wr.z + 2.9, {
        r: 0.8, yaw: -Math.PI * 0.5 + R.gaussian(0, 0.2), pitch: -0.22,
        noClear: true, scale: R.range(0.9, 1.25)
      });
      // scrap collects in the corner under every rack
      this._heap(this._var('scrap', 3), wr.x + 4.2, wr.z - 2.6, 7, 1.5, { r: 0.30 });
    }

    // ---- tyres: stacked four high, which is how they are stored ------------
    var tyreSpots = [[py.x0 + 1.8, py.z0 + 20.0], [py.x0 + 3.1, py.z0 + 20.6],
                     [py.x0 + 2.2, py.z0 + 22.1], [py.x1 - 4.4, py.z0 + 5.0]];
    for (i = 0; i < tyreSpots.length; i++) {
      this._tyreRow(tyreSpots[i][0], tyreSpots[i][1], R.int(3, 5),
        R.range(0, Math.PI), { collider: [0.75, 0.56, 0.55] });
    }

    // ---- gas bottles, chained upright in a run ------------------------------
    this._against(this.B.gasBottle, py.x1 - 5.0, py.z0 + 8.2, py.x1 - 5.0, py.z0 + 11.4, -1, 0, 7,
      { r: 0.20, off: 0.35, noClear: true, spread: 0.5, foot: false });
    this._heap(this.B.gasBottle, py.x0 + 9.5, py.z0 + 15.0, 4, 1.1,
      { r: 0.22, low: false, pitch: Math.PI * 0.5, lift: 0.12, tilt: 0.02 });

    // ---- engine cradles: what is on the ground beside each one -------------
    for (i = 0; i < py.engineCradles.length; i++) {
      var ec = py.engineCradles[i];
      if (R.next() < 0.62) {
        this._drop(this.B.dripPan, ec.x + R.range(-1.4, 1.4), ec.z + R.range(-2.0, 2.0), {
          r: 0.6, low: true, noClear: true, foot: false
        });
        this._stain(0, ec.x + R.range(-1, 1), ec.z + R.range(-1.5, 1.5), 1.8, 1.5, R.range(0, 3));
      }
      if (R.next() < 0.5) {
        this._drop(this.B.duct, ec.x + R.range(-2.2, 2.2), ec.z + R.range(-2.4, 2.4), {
          r: 0.5, yaw: R.range(0, TAU), low: true, noClear: true, foot: false,
          scale: R.range(0.8, 1.25)
        });
      }
      if (R.next() < 0.4) {
        this._drop(this.B.partsBin, ec.x + R.range(-1.8, 1.8), ec.z + R.range(-2.2, 2.2), {
          r: 0.3, low: true, noClear: true, foot: false
        });
      }
      this._heap(this._var('scrap', 3), ec.x + R.range(-1.5, 1.5), ec.z + R.range(-2, 2), 4, 1.1, { r: 0.28 });
    }

    // ---- the fin stillage end ----------------------------------------------
    if (py.finRack) {
      this._heap(this._var('scrap', 3), py.finRack.x - 5.4, py.finRack.z + 1.6, 9, 2.0, { r: 0.32 });
      this._drop(this._var('panel', 2), py.finRack.x + 5.2, py.finRack.z - 0.6, {
        r: 0.85, yaw: R.range(0, TAU), pitch: -0.22, noClear: true
      });
      this._put('reel', py.finRack.x - 6.2, py.finRack.z - 2.2, { yaw: 0.9, r: 1.0, h: 1.0 });
    }

    // ---- pallets and bins: stacked flat where a forklift left them ----------
    for (i = 0; i < 5; i++) {
      this._stack(this.B.pallet, py.x0 + 6.4 + R.gaussian(0, 0.5), py.z0 + 24.5 + i * 1.15,
        R.int(3, 6), 0.145, { r: 0.75 });
    }
    this._against(this.B.partsBin, py.x1 - 6.6, py.z1 - 16.0, py.x1 - 6.6, py.z1 - 20.0, -1, 0, 5,
      { r: 0.28, off: 0.35, low: true, noClear: true, foot: false });

    // ---- the ground itself --------------------------------------------------
    this._stain(2, py.centre.x, py.centre.z, 16.0, 22.0, 0.1);
    this._stain(3, py.x0 + 3.0, py.z1 - 8.0, 10.0, 12.0, 0.6);

    // ---- THE TOW ROUTE ------------------------------------------------------
    // The apron between taxiway Alpha and the parts yard is the approach the
    // second hero framing stands on, and it came back as thirty square metres
    // of bare slab.  What is actually on a tow route is the route itself: edge
    // cones, the scrub of every set of tyres that has used it, and whatever the
    // wind has rolled across it since.  The polyline is derived from three
    // anchors - the taxiway, the parts yard and the hangar apron - so it tracks
    // the painted route without hard-coding a single one of its coordinates.
    var route = [];
    if (A.taxiway) route.push([A.taxiway.x + A.taxiway.half + 1.5, A.taxiway.z1 - 12]);
    route.push([py.x0 - 3.5, py.z1 - 8.0]);
    route.push([py.centre.x, py.z1 - 3.0]);
    if (A.hangar) route.push([A.hangar.apron.x - 1.5, A.hangar.apron.z + 3.0]);
    for (i = 0; i + 1 < route.length; i++) {
      var ax = route[i][0], az = route[i][1];
      var bx2 = route[i + 1][0], bz2 = route[i + 1][1];
      var seg = Math.sqrt((bx2 - ax) * (bx2 - ax) + (bz2 - az) * (bz2 - az));
      var nseg = Math.max(2, Math.round(seg / 5.5));
      // the outward normal of the run, so the cones sit BESIDE it, not on it
      var nX = -(bz2 - az) / seg, nZ = (bx2 - ax) / seg;
      for (var s2 = 0; s2 < nseg; s2++) {
        var tt = (s2 + 0.5) / nseg;
        var side = (s2 % 2) ? 1 : -1;
        var cx2 = M.lerp(ax, bx2, tt) + nX * side * R.range(3.0, 4.4) + R.gaussian(0, 0.5);
        var cz2 = M.lerp(az, bz2, tt) + nZ * side * R.range(3.0, 4.4) + R.gaussian(0, 0.5);
        var kn = R.next() < 0.15;
        this._drop(this.B.cone, cx2, cz2, {
          r: 0.26, low: true, taxi: true, noClear: true, foot: false,
          pitch: kn ? Math.PI * 0.47 : 0, lift: kn ? 0.155 : 0, tilt: 0.05
        });
        // the wind rolls tumbleweed across a tow route and the cones catch it
        if (R.next() < 0.34) {
          this._drop(this.B.tumbleweed, cx2 + this.windDir.x * R.range(0.6, 2.4),
            cz2 + this.windDir.y * R.range(0.6, 2.4), {
              r: 0.36, taxi: true, noClear: true, foot: false,
              scale: R.range(0.6, 1.15), tilt: 0.18
            });
        }
        this._stain(2, M.lerp(ax, bx2, tt), M.lerp(az, bz2, tt), 8.0, 10.0,
          Math.atan2(bx2 - ax, bz2 - az));
      }
      // scrap shaken off a trailer, and the drift that builds in its lee
      this._heap(this._var('scrap', 3), M.lerp(ax, bx2, 0.45) + nX * 5.0,
        M.lerp(az, bz2, 0.45) + nZ * 5.0, 6, 2.2, { r: 0.30 });
      var db = this.B.drift;
      for (var dk = 0; dk < 4 && db && db.n < db.max; dk++) {
        var dtx = M.lerp(ax, bx2, R.next()) + nX * R.range(4.5, 8.0);
        var dtz = M.lerp(az, bz2, R.next()) + nZ * R.range(4.5, 8.0);
        db.add(T(dtx, this._ground(dtx, dtz) - 0.04, dtz,
          R.gaussian(0, 0.02), Math.atan2(this.windDir.x, this.windDir.y) + R.gaussian(0, 0.3),
          R.gaussian(0, 0.02),
          R.range(1.2, 2.4), R.range(0.4, 0.8), R.range(1.1, 2.2)), wearTint(R));
      }
    }
  };

  // ==========================================================================
  // PASS 4 - THE HANGAR
  //
  // The `interior` framing, and the only place in the level with a roof.  Two
  // rules make it read as a workshop rather than a shed with an aeroplane in
  // it: everything is against a wall or against the aircraft on jacks (nobody
  // leaves anything in the middle of a hangar floor - it has to be towable),
  // and NOTHING in here is dusted on top, because a covered floor does not
  // collect blown sand.  That contrast between the dusty yard and the merely
  // dirty shed is most of what sells the door as a threshold.
  // ==========================================================================
  PropsBoneyard.prototype._dressHangar = function () {
    var A = this.A;
    if (!A || !A.hangar) return;
    var hg = A.hangar, R = this.rng;
    var fy = hg.floorY;
    var i;
    // Indoors: skip the ground query entirely (the level returns the flat floor
    // height in here anyway) and skip every foot-drift.
    var IN = { y: fy, noClear: true, foot: false, taxi: true };
    function o(extra) {
      var out = { y: IN.y, noClear: true, foot: false, taxi: true };
      for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      return out;
    }

    // ---- the bench run: what is ON the benches the level built -------------
    // level_boneyard puts five bench units down the east wall at x1-1.6 on a
    // 6 m pitch with their tops at floor+0.92.  Clutter goes on top of them.
    for (i = 0; i < 5; i++) {
      var bz = hg.z0 + 3.5 + i * 6.0;
      this._put('bench', hg.x1 - 1.6, bz, o({
        yaw: Math.PI * 0.5, r: 0.4, y: fy + 0.97, tilt: 0.004
      }));
      if (i % 2 === 0) {
        this._against(this.B.partsBin, hg.x1 - 2.6, bz - 1.6, hg.x1 - 2.6, bz + 1.6, -1, 0, 3,
          o({ r: 0.26, off: 0.3, low: true, y: fy + 2.34, tilt: 0.004 }));
      }
    }

    // ---- against the north and south walls ---------------------------------
    this._against(this.B.crate, hg.x0 + 5.0, hg.z0 + 1.4, hg.x0 + 22.0, hg.z0 + 1.4, 0, 1, 5,
      o({ r: 0.85, off: 0.9, collider: [0.62, 0.45, 0.45], material: 'wood' }));
    this._against(this.B.crate, hg.x0 + 24.0, hg.z1 - 1.4, hg.x1 - 3.0, hg.z1 - 1.4, 0, -1, 4,
      o({ r: 0.85, off: 0.9, scale: function () { return R.range(0.55, 0.70); } }));
    for (i = 0; i < 4; i++) {
      this._against(this.B['drum' + i], hg.x1 - 6.5, hg.z1 - 3.0, hg.x1 - 6.5, hg.z1 - 8.0, 0, 0, 2,
        o({ r: 0.36, off: 0.0 }));
    }
    // gas bottles chained to the wall, which is where they legally live
    this._against(this.B.gasBottle, hg.x0 + 2.0, hg.z1 - 2.2, hg.x0 + 6.4, hg.z1 - 2.2, 0, -1, 6,
      o({ r: 0.19, off: 0.5, spread: 0.35 }));
    this._put('reel', hg.x0 + 1.9, hg.z1 - 6.5, o({ yaw: 1.5, r: 0.9, h: 1.0 }));

    // ---- around the airframe on jacks --------------------------------------
    // The level's `interior` framing puts it in the door beam; everything a
    // team would have round a stripped fighter goes with it.
    var jk = hg.jackStand;
    if (jk) {
      this._put('toolCart', jk.x - 2.6, jk.z - 1.4, o({ yaw: 0.35, r: 0.9, h: 1.0 }));
      this._put('toolCart', jk.x + 2.4, jk.z + 2.2, o({ yaw: -1.9, r: 0.9, h: 1.0 }));
      this._put('stepStand', jk.x - 2.9, jk.z + 2.6, o({ yaw: 1.1, r: 0.75, h: 0.8 }));
      this._put('workLight', jk.x + 2.8, jk.z - 3.4, o({ yaw: -0.5, r: 0.8, h: 1.6 }));
      this._put('spool', jk.x + 4.2, jk.z + 5.6, o({ yaw: 0.6, r: 1.2, h: 0.9 }));
      this._drop(this.B.ladder, jk.x - 2.0, jk.z - 4.2, o({
        r: 0.5, yaw: 0.2, pitch: 0.2, scale: 0.72
      }));
      this._drop(this.B.dripPan, jk.x + 0.4, jk.z + 0.6, o({ r: 0.6, yaw: 0.3, low: true }));
      this._drop(this.B.dripPan, jk.x - 0.6, jk.z - 2.4, o({ r: 0.6, yaw: -0.4, low: true }));
      // the parts that came off it, laid out on the floor in a row - which is
      // exactly how a strip-down is actually done
      for (i = 0; i < 7; i++) {
        this._drop(this._var('scrap', 3), jk.x - 4.6 + R.gaussian(0, 0.4), jk.z - 3.0 + i * 1.05, o({
          r: 0.3, low: true, tilt: 0.03, scale: R.range(0.8, 1.2)
        }));
      }
      this._drop(this._var('panel', 2), jk.x - 6.2, jk.z + 1.2, o({
        r: 0.85, yaw: Math.PI * 0.5, pitch: -0.25
      }));
      this._heap(this.B.partsBin, jk.x - 5.4, jk.z + 4.2, 6, 1.3, o({ r: 0.28, low: true, tilt: 0.02 }));
      this._stain(0, jk.x + 0.6, jk.z + 1.4, 2.6, 2.2, 0.4);
      this._stain(1, jk.x, jk.z, 6.0, 8.0, 0.0);
    }

    // ---- the door threshold ------------------------------------------------
    // Cones and a barrier across the open half, and the tyre scrub of every
    // aircraft that has ever been towed over the sill.
    for (i = 0; i < 5; i++) {
      var dz = hg.doorZ0 + 1.0 + i * ((hg.doorZ1 - hg.doorZ0 - 2.0) / 4);
      this._drop(this.B.cone, hg.x0 + 1.6 + R.gaussian(0, 0.3), dz, o({
        r: 0.26, low: true, tilt: 0.04
      }));
    }
    this._stain(2, hg.x0 + 4.0, (hg.doorZ0 + hg.doorZ1) * 0.5, 9.0, 16.0, 0.0);
    this._stain(2, hg.x0 - 5.0, (hg.doorZ0 + hg.doorZ1) * 0.5, 11.0, 16.0, 0.0);

    // ---- loose floor life --------------------------------------------------
    this._heap(this.B.bucket, hg.x0 + 9.0, hg.z0 + 5.0, 3, 1.2, o({ r: 0.24, low: true }));
    this._heap(this.B.jerrycan, hg.x0 + 3.2, hg.z0 + 6.5, 4, 1.4, o({ r: 0.24, low: true }));
    this._drop(this.B.pallet, hg.x0 + 12.0, hg.z1 - 4.0, o({ r: 0.7, yaw: 0.9 }));
    this._drop(this.B.pallet, hg.x0 + 13.1, hg.z1 - 4.6, o({ r: 0.7, yaw: 1.1 }));
    this._put('fireExt', hg.x0 + 1.3, hg.z0 + 2.2, o({ yaw: 0.6, r: 0.7, h: 1.0 }));
    this._put('barrier', hg.x0 + 26.0, hg.z0 + 2.6, o({
      yaw: Math.PI * 0.5, r: 1.5, h: 0.9, collider: [0.32, 0.42, 1.25], material: 'concrete'
    }));

    // ---- THE FLOOR ---------------------------------------------------------
    // Measured at 0.0284 linear with a 0.074 local sd across a 400 x 130 px
    // sample: an empty grey plane. This is the level's best frame and its floor
    // carried literally nothing - no bay lines, no oil, no swarf, no hoses, no
    // bay number - which is the "empty geometry with no props, clutter or wear"
    // instant-fail wearing a good light rig.
    var fw = hg.x1 - hg.x0, fd = hg.z1 - hg.z0;
    var bayY = fy + 0.010;

    // Bay outline paint. Two bays, laid out on the door centreline the way a
    // real shed is marked, in the same worn safety yellow as the stands.
    function line(x0, z0, x1, z1, wdt) {
      var ddx = x1 - x0, ddz = z1 - z0;
      var len = Math.sqrt(ddx * ddx + ddz * ddz);
      if (len < 0.1) return;
      var yaw = Math.atan2(ddx, ddz);
      // broken into 1.4 m runs so the paint can be missing in places
      var n = Math.max(1, Math.round(len / 1.4));
      for (var q = 0; q < n; q++) {
        if (R.next() < 0.13) continue;
        var t0 = (q + 0.06 + R.range(0, 0.10)) / n, t1 = (q + 0.94 - R.range(0, 0.10)) / n;
        var mx = M.lerp(x0, x1, (t0 + t1) * 0.5), mz = M.lerp(z0, z1, (t0 + t1) * 0.5);
        self.S.yellow.push(part(bx(wdt * R.range(0.85, 1.1), 0.012, len * (t1 - t0), 0.004),
          Tn(mx, bayY, mz, 0, yaw, 0)));
      }
    }
    var self = this;
    var b1x0 = hg.x0 + 5.0, b1x1 = hg.x0 + 26.0;
    var b1z0 = hg.doorZ0 - 2.0, b1z1 = hg.doorZ1 + 2.0;
    line(b1x0, b1z0, b1x1, b1z0, 0.14);
    line(b1x0, b1z1, b1x1, b1z1, 0.14);
    line(b1x0, b1z0, b1x0, b1z1, 0.14);
    line(b1x1, b1z0, b1x1, b1z1, 0.14);
    // the nose-stop T and the centreline the aircraft is towed in on
    line(hg.x0 + 2.0, (b1z0 + b1z1) * 0.5, b1x1 - 3.0, (b1z0 + b1z1) * 0.5, 0.11);
    line(b1x1 - 3.0, (b1z0 + b1z1) * 0.5 - 1.6, b1x1 - 3.0, (b1z0 + b1z1) * 0.5 + 1.6, 0.16);
    // a walkway edge down the bench side, and the hazard hatching at the door
    line(hg.x1 - 3.4, hg.z0 + 2.0, hg.x1 - 3.4, hg.z1 - 2.0, 0.10);
    for (i = 0; i < 9; i++) {
      var hx = hg.x0 + 1.2 + i * 0.9;
      line(hx, hg.doorZ0 - 3.4, hx - 0.9, hg.doorZ0 - 1.6, 0.10);
    }

    // The bay number, stencilled on the floor where an inventory yard puts it.
    this._sign('signC', hg.x0 + 3.0, hg.z0 + 4.4, Math.PI * 0.5, 1.5, 0.78, 2.0);

    // Swarf, rivet heads and offcuts: the field of small bright metal a
    // strip-down leaves on a floor. Clustered under the aircraft and along the
    // bench run, never scattered evenly.
    if (jk) {
      for (i = 0; i < 26; i++) {
        var sa = R.range(0, TAU), sr2 = Math.sqrt(R.next()) * 5.5;
        this._drop(this._var('scrap', 3), jk.x + Math.cos(sa) * sr2, jk.z + Math.sin(sa) * sr2, o({
          r: 0.10, low: true, tilt: 0.5, scale: R.range(0.16, 0.34), noClear: true
        }));
      }
      // hose and cable runs, from the wall to the aircraft - the thing that
      // makes a hangar read as plugged in rather than as a shed with a jet in it
      var hose = new Item();
      var hx0 = hg.x1 - 2.2, hz0 = jk.z - 4.0;
      var px2 = hx0, pz2 = hz0;
      for (i = 1; i <= 7; i++) {
        var t2 = i / 7;
        var nx2 = M.lerp(hx0, jk.x + 1.2, t2) + Math.sin(t2 * 5.1) * 0.9;
        var nz2 = M.lerp(hz0, jk.z - 0.6, t2) + Math.cos(t2 * 4.3) * 0.7;
        hose.tube('rubber', 0.035, px2, fy + 0.035, pz2, nx2, fy + 0.035, nz2, 6);
        px2 = nx2; pz2 = nz2;
      }
      var hg2 = hose.merge('rubber');
      if (hg2) {
        this._finishGeo(hg2, 'rubber', this.W && this.W.rubber, 420);
        this.S.rubber.push(part(hg2, null));
      }
      var cab = new Item();
      var cx3 = hg.x0 + 1.6, cz3 = jk.z + 4.6;
      var qx = cx3, qz = cz3;
      for (i = 1; i <= 6; i++) {
        var t3 = i / 6;
        var mx3 = M.lerp(cx3, jk.x - 1.0, t3) + Math.sin(t3 * 3.7 + 1.1) * 1.1;
        var mz3 = M.lerp(cz3, jk.z + 1.2, t3) + Math.cos(t3 * 6.1) * 0.6;
        cab.tube('steel', 0.026, qx, fy + 0.026, qz, mx3, fy + 0.026, mz3, 5);
        qx = mx3; qz = mz3;
      }
      var cg = cab.merge('steel');
      if (cg) {
        this._finishGeo(cg, 'painted_metal', this.W && this.W.plant, 420);
        this.S.steel.push(part(cg, null));
      }
      // more drip pans, in the cluster a jacked airframe actually has
      for (i = 0; i < 3; i++) {
        this._drop(this.B.dripPan, jk.x + R.range(-2.4, 2.4), jk.z + R.range(-4.5, 4.5), o({
          r: 0.55, yaw: R.range(0, TAU), low: true
        }));
      }
      this._stain(1, jk.x - 1.4, jk.z + 3.2, 3.4, 3.0, 0.7);
      this._stain(0, jk.x + 1.8, jk.z - 2.6, 1.8, 1.6, 1.9);
      this._stain(3, hg.x0 + 6.0, jk.z, 10.0, 12.0, 0.0);
    }
    void fw; void fd;
  };

  // ==========================================================================
  // PASS 5 - THE OPS SHACK
  // The one place in 200 m of yard where people actually are.
  // ==========================================================================
  PropsBoneyard.prototype._dressOps = function () {
    var A = this.A;
    if (!A || !A.opsShack) return;
    var op = A.opsShack, R = this.rng;
    var cx = op.centre.x, cz = op.centre.z;

    // Drums and pallets stacked against the windward wall, which is also the
    // wall that gets the drift.
    this._against(this.B.drum2, cx - 4.2, cz + 2.7, cx + 4.2, cz + 2.7, 0, 1, 4,
      { r: 0.38, off: 0.62, noClear: true });
    this._stack(this.B.pallet, cx + 5.6, cz - 1.6, R.int(4, 7), 0.145, { r: 0.75, yaw: op.yaw });
    this._heap(this.B.jerrycan, cx + 4.4, cz + 3.4, 4, 1.0, { r: 0.24 });
    this._drop(this.B.bucket, cx - 2.2, cz - 3.9, { r: 0.24, low: true, noClear: true, foot: false });

    // Under the canopy: a table made of a crate and a pallet, and the crew's
    // cooler.  Two objects, and they are the difference between a work site and
    // a diorama.
    if (this._canopy) {
      var c = this._canopy;
      this._drop(this.B.crate, c.x - 0.4, c.z + 0.2, {
        r: 0.7, yaw: c.yaw + 0.1, noClear: true, foot: false, scale: 0.92
      });
      this._drop(this.B.crate, c.x + 1.1, c.z - 0.7, {
        r: 0.5, yaw: c.yaw - 0.4, noClear: true, foot: false,
        sx: 0.57, sy: 0.52, sz: 0.65
      });
      this._drop(this.B.partsBin, c.x + 1.1, c.z - 0.7, {
        r: 0.2, y: this._ground(c.x + 1.1, c.z - 0.7) + 0.45, noClear: true, foot: false, yaw: c.yaw
      });
      this._drop(this.B.crate, c.x - 1.5, c.z - 1.1, {
        r: 0.4, yaw: c.yaw + 0.9, noClear: true, foot: false,
        sx: 0.57, sy: 0.52, sz: 0.65
      });
    }

    // The walking line from the door to the taxiway, scrubbed into the slab.
    this._stain(3, op.doorSide.x + 2.0, op.doorSide.z - 4.0, 6.0, 9.0, op.yaw);
    this._stain(2, cx + 8.0, cz - 2.0, 7.0, 9.0, op.yaw);

    // Cones and a fire bottle at the door, plus the yard sign on its post.
    this._drop(this.B.cone, op.doorSide.x - 1.3, op.doorSide.z - 1.6, {
      r: 0.26, low: true, noClear: true, foot: false
    });
    this._sign('signA', cx - 6.6, cz - 6.4, op.yaw + 0.06, 1.5, 0.78, 1.9);
  };

  // A placard on a post: two boxes and a quad, but the one thing in the level
  // that is WRITTEN in a place a player stands next to.
  PropsBoneyard.prototype._sign = function (matKey, x, z, yaw, w, h, top) {
    var y = this._ground(x, z);
    var it = new Item();
    it.cyl('steel', 0.045, 0.050, top, -w * 0.34, top * 0.5, 0, 0, 0, 0, 8);
    it.cyl('steel', 0.045, 0.050, top, w * 0.34, top * 0.5, 0, 0, 0, 0, 8);
    it.box('steel', w + 0.05, 0.04, 0.05, 0, top - h * 0.5 + h * 0.5 - 0.03, 0, 0.008);
    it.box('steel', w * 0.9, h + 0.06, 0.030, 0, top - h * 0.55, -0.03, 0.010);
    this._place(it, x, y, z, yaw, 1);
    // the face itself, double-sided, in its own material
    var g = card(w, h, 0.02, 0.02, 0.98, 0.98);
    this.signParts.push({
      mat: matKey,
      geometry: g,
      matrix: Tn(x, y + top - h * 1.05, z, 0, yaw, 0)
    });
    this._occupy(x, z, 0.7);
  };

  // ==========================================================================
  // PASS 6 - THE TAXIWAY AND SIERRA SEVEN'S STAND
  //
  // The signature framing looks straight up this.  It has to stay READABLE -
  // the centreline is the leading line and the wing shadow is the subject - so
  // the middle of the taxiway carries nothing above ankle height and everything
  // of mass goes to the edges, which is also exactly how a live taxiway works.
  // ==========================================================================
  PropsBoneyard.prototype._dressTaxiway = function () {
    var A = this.A;
    if (!A || !A.taxiway) return;
    var tw = A.taxiway, R = this.rng;
    var i;

    // Edge cones down both sides, thinning toward the far end.
    for (i = 0; i < 22; i++) {
      var t = i / 21;
      var z = M.lerp(tw.z1 - 6, tw.z0 + 10, t);
      var side = (i % 2) ? 1 : -1;
      if (R.next() > 0.62 - t * 0.22) continue;
      var down = R.next() < 0.18;
      this._drop(this.B.cone, tw.x + side * (tw.half - R.range(0.4, 1.6)), z + R.gaussian(0, 1.2), {
        r: 0.26, low: true, taxi: true, noClear: true, foot: false,
        pitch: down ? Math.PI * 0.48 : 0, lift: down ? 0.155 : 0
      });
    }

    // ---- THE EAST EDGE OF ALPHA, AND WHY IT CARRIES THE HERO FRAME ---------
    // Sierra Seven's stand straddles taxiway Alpha's east edge, so the whole
    // near ground of the signature framing is LIVE TAXIWAY: it has to stay
    // clear of anything a wingtip would hit, which is why the first pass came
    // back with six metres of bare slab under the lens.  What legitimately
    // lives on a taxiway edge is edge markers, and a continuous run of them at
    // x = +half is both true and the strongest thing that can be put in that
    // frame - a receding line of hard orange verticals crossing the wing's
    // shadow diagonal, on the one line in the level that has perspective.
    var ez0 = tw.z1 - 8, ez1 = tw.z0 + 20;
    for (i = 0; i < 34; i++) {
      var et = i / 33;
      var epz = M.lerp(ez0, ez1, et * et * 0.85 + et * 0.15);
      var epx = tw.x + tw.half + R.range(-0.55, 0.30);
      var knocked = R.next() < 0.14;
      this._drop(this.B.cone, epx, epz, {
        r: 0.28, low: true, taxi: true, noClear: true, foot: false,
        pitch: knocked ? Math.PI * 0.47 : 0, lift: knocked ? 0.155 : 0,
        tilt: knocked ? 0.06 : 0.05, scale: R.range(0.94, 1.08)
      });
      // and what the wind has piled against the ones that stopped it
      if (R.next() < 0.22) {
        this._drop(this.B.tumbleweed, epx + this.windDir.x * 0.7, epz + this.windDir.y * 0.7, {
          r: 0.34, taxi: true, noClear: true, foot: false,
          scale: R.range(0.55, 0.95), tilt: 0.18
        });
      }
    }

    // The scrub a hundred tows have laid into the slab, straight down the
    // centreline: the only large-area tonal break the taxiway has.
    for (i = 0; i < 9; i++) {
      this._stain(2, tw.x + R.gaussian(0, 1.6), tw.z1 - 10 - i * 11, 9.0, 13.0, R.gaussian(0, 0.06));
    }
    for (i = 0; i < 6; i++) {
      this._stain(3, tw.x + (i % 2 ? 1 : -1) * R.range(7, 10.5), tw.z1 - 16 - i * 14, 8.0, 12.0, 0.2);
    }

    // Sierra Seven's stand: the objects that make the hero frame's near ground.
    var s7 = A.sierra7;
    if (s7 && s7.shade && s7.shade.at) {
      // ---- the staging line, OFF the taxiway --------------------------------
      // Everything with mass goes east of the edge, on the stand proper, in the
      // 12-28 m band where it reads at size without fouling the tow lane.
      var stageX = tw.x + tw.half + R.range(2.4, 3.2);
      for (i = 0; i < 4; i++) {
        var sz2 = -2.0 - i * 3.1;
        this._drop(this.B.pallet, stageX + R.gaussian(0, 0.25), sz2, {
          r: 0.64, yaw: s7.yaw + R.gaussian(0, 0.12), taxi: true, noClear: true, foot: false
        });
        this._drop(this.B['drum' + (i % 4)], stageX + R.gaussian(0, 0.20), sz2, {
          r: 0.40, y: this._ground(stageX, sz2) + 0.12,
          yaw: R.range(0, TAU), taxi: true, noClear: true, foot: false
        });
      }
      // a tyre stack and a tool cart at the head of the line
      this._tyreRow(stageX + 1.3, 1.9, 4, s7.yaw + 0.15, { collider: [0.75, 0.56, 0.55] });
      this._put('toolCart', stageX + 1.8, -14.2, {
        yaw: s7.yaw + 0.5, r: 0.9, h: 1.0, taxi: true, noClear: true, foot: false
      });
      this._put('stepStand', stageX - 0.4, -17.6, {
        yaw: s7.yaw - 0.3, r: 0.8, h: 0.8, taxi: true, noClear: true, foot: false
      });
      // the tug, parked on the stand beside the port wing where every
      // photograph of a stored transport has one
      this._put('tug', s7.centre.x - 8.5, s7.centre.z + 12.5, {
        yaw: s7.yaw + 1.35, r: 3.4, h: 2.1, taxi: true,
        collider: [1.2, 0.9, 2.2], material: 'metal'
      });
      // and the salvage that came off its port wing, leaned on the gear
      this._drop(this._var('panel', 2), s7.centre.x - 5.6, s7.centre.z - 8.5, {
        r: 0.9, yaw: s7.yaw + 0.6, pitch: -0.26, taxi: true, noClear: true,
        scale: R.range(1.1, 1.4)
      });
      this._heap(this._var('scrap', 3), s7.centre.x - 7.5, s7.centre.z - 5.0, 9, 2.4,
        { r: 0.32, taxi: true });
      // A chock pair and a drip pan on the shadow LINE, 9-14 m from the hero
      // eye, so the hard-edged diagonal the whole level is built around has
      // something crossing it that the audience can size.
      for (i = 0; i < 3; i++) {
        var sx = s7.centre.x - 16.0 + i * 3.4;
        var band = s7.shade.at(sx);
        if (!band) continue;
        this._drop(this.B.chock, sx, band.z1 - R.range(0.2, 1.4), {
          r: 0.30, yaw: R.range(0, TAU), low: true, taxi: true, noClear: true, foot: false,
          tilt: 0.05
        });
      }
      var b2 = s7.shade.at(s7.centre.x - 11.0);
      if (b2) {
        this._drop(this.B.dripPan, s7.centre.x - 11.0, b2.centre, {
          r: 0.6, yaw: 0.3, low: true, taxi: true, noClear: true, foot: false
        });
        this._stain(0, s7.centre.x - 11.0, b2.centre + 0.9, 2.2, 1.8, 0.2);
      }
      // A tumbleweed caught against the outboard nacelle strut - the one thing
      // in the frame that says the wind still blows through here.
      if (s7.nacelles && s7.nacelles.length) {
        var nac = s7.nacelles[0];
        var tx = nac.x + this.windDir.x * 1.6, tz = nac.z + this.windDir.y * 1.6;
        this._drop(this.B.tumbleweed, tx, tz, {
          r: 0.42, taxi: true, noClear: true, foot: false,
          scale: R.range(0.85, 1.15), tilt: 0.10
        });
      }
      // A work stand and a cart in the deep shade under the body.
      var bodyShade = this._shadeSpot('sierra7_body', 0.5, 0.62);
      if (bodyShade) {
        this._put('stepStand', bodyShade.x + 1.6, bodyShade.z, {
          yaw: s7.yaw + 0.4, r: 0.8, h: 0.8, taxi: true, noClear: true, foot: false
        });
      }
    }

    // The blast blocks at the taxiway mouth already exist; what belongs with
    // them is the litter that collects behind anything that stops the wind.
    this._heap(this._var('scrap', 3), tw.x - tw.half - 2.6, tw.z1 - 12.0, 6, 2.0, { r: 0.3, taxi: true });
    this._heap(this.B.tumbleweed, tw.x + tw.half + 2.2, tw.z1 - 14.0, 4, 2.4,
      { r: 0.45, low: false, scale: function () { return R.range(0.7, 1.2); } });
  };

  // ==========================================================================
  // PASS 7 - THE HULK ROW
  // Six severed fuselages on cradles.  Everything that came out of them is on
  // the ground beside them, which is the one place in the level where a pure
  // debris field is the truth rather than laziness.
  // ==========================================================================
  PropsBoneyard.prototype._dressHulks = function () {
    var A = this.A;
    if (!A || !A.hulkRow) return;
    var R = this.rng;
    for (var i = 0; i < A.hulkRow.length; i++) {
      var h = A.hulkRow[i];
      var cx = h.centre.x, cz = h.centre.z;
      // the cut-out sections, leaned against the cradle on the shaded flank
      this._drop(this._var('panel', 2), cx - 3.4, cz + R.range(-4, 4), {
        r: 0.9, yaw: -Math.PI * 0.5 + R.gaussian(0, 0.25), pitch: -0.26,
        noClear: true, scale: R.range(0.9, 1.3)
      });
      this._drop(this._var('panel', 2), cx + 3.4, cz + R.range(-4, 4), {
        r: 0.9, yaw: Math.PI * 0.5 + R.gaussian(0, 0.25), pitch: -0.24,
        noClear: true, scale: R.range(0.9, 1.3)
      });
      // scrap in two heaps, one either end, not a ring
      this._heap(this._var('scrap', 3), cx + R.range(-1, 1), cz - h.len * 0.42, 11, 2.6, { r: 0.30 });
      this._heap(this._var('scrap', 3), cx + R.range(-1, 1), cz + h.len * 0.40, 8, 2.2, { r: 0.30 });
      this._heap(this.B.duct, cx + 2.8, cz + R.range(-3, 3), 3, 1.6,
        { r: 0.45, low: true, scale: function () { return R.range(0.7, 1.2); } });
      // a drum and a bin where the fluids were drained
      this._drop(this.B['drum' + (i % 4)], cx - 2.6, cz + R.range(-5, 5), {
        r: 0.4, noClear: true, pitch: R.next() < 0.4 ? Math.PI * 0.5 : 0,
        lift: R.next() < 0.4 ? 0.293 : 0
      });
      this._stain(1, cx, cz, 5.5, 9.0, h.yaw);
      // sand banked along the lee side of the cradle timbers
      var b = this.B.drift;
      if (b) {
        for (var k = 0; k < 3; k++) {
          var dx = cx + this.windDir.x * 2.4 + R.gaussian(0, 0.6);
          var dz = cz - h.len * 0.3 + k * h.len * 0.3 + this.windDir.y * 2.4;
          if (b.n >= b.max) break;
          b.add(T(dx, this._ground(dx, dz) - 0.03, dz,
            R.gaussian(0, 0.02), Math.atan2(this.windDir.x, this.windDir.y) + R.gaussian(0, 0.2),
            R.gaussian(0, 0.02),
            R.range(0.9, 1.5), R.range(0.5, 0.9), R.range(0.9, 1.4)), wearTint(R));
        }
      }
    }
  };

  // ==========================================================================
  // PASS 8 - THE PERIMETER
  //
  // A 240 m chain-link fence in a desert is a SIEVE, and what it catches is the
  // most honest wind indicator in the level: tumbleweed banked two deep against
  // the downwind runs and nothing at all against the upwind ones.  Getting that
  // asymmetry right is why the wind vector is a build-time input and not just
  // an animation parameter.
  // ==========================================================================
  PropsBoneyard.prototype._dressPerimeter = function () {
    var A = this.A;
    if (!A || !A.fence) return;
    var f = A.fence, R = this.rng;
    var w = this.windDir;
    var runs = [
      { x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z0, nx: 0, nz: -1 },
      { x0: f.x0, z0: f.z1, x1: f.x1, z1: f.z1, nx: 0, nz: 1 },
      { x0: f.x0, z0: f.z0, x1: f.x0, z1: f.z1, nx: -1, nz: 0 },
      { x0: f.x1, z0: f.z0, x1: f.x1, z1: f.z1, nx: 1, nz: 0 }
    ];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      // How much this run faces INTO the wind.  1 = the wind blows straight at
      // its inside face and everything loose in the yard piles here; -1 = the
      // lee run, which stays clean.
      var facing = run.nx * w.x + run.nz * w.y;
      var density = M.saturate(facing) * 0.9 + 0.06;
      var len = Math.sqrt((run.x1 - run.x0) * (run.x1 - run.x0) + (run.z1 - run.z0) * (run.z1 - run.z0));
      var n = Math.round(len * density * 0.28);
      for (var i = 0; i < n; i++) {
        // clumped, not spaced: tumbleweed piles where the first one stopped
        var t = R.next();
        t = t * t * (t < 0.5 ? 1 : 1);
        var cx = M.lerp(run.x0, run.x1, R.next());
        var cz = M.lerp(run.z0, run.z1, R.next());
        var clump = R.int(1, 4);
        for (var c = 0; c < clump; c++) {
          var px = cx - run.nx * R.range(0.35, 1.5) + R.gaussian(0, 0.7);
          var pz = cz - run.nz * R.range(0.35, 1.5) + R.gaussian(0, 0.7);
          this._drop(this.B.tumbleweed, px, pz, {
            r: 0.40, taxi: true, noClear: true, foot: false,
            scale: R.range(0.62, 1.25), tilt: 0.16
          });
        }
        void t;
      }
      // and the sand ramp that builds against the same face
      var dn = Math.round(len * (M.saturate(facing) * 0.5 + 0.08) * 0.10);
      var b = this.B.drift;
      for (var d = 0; d < dn && b && b.n < b.max; d++) {
        var dx = M.lerp(run.x0, run.x1, R.next()) - run.nx * R.range(0.2, 1.1);
        var dz = M.lerp(run.z0, run.z1, R.next()) - run.nz * R.range(0.2, 1.1);
        b.add(T(dx, this._ground(dx, dz) - 0.04, dz,
          R.gaussian(0, 0.02), Math.atan2(w.x, w.y) + R.gaussian(0, 0.25), R.gaussian(0, 0.02),
          R.range(1.1, 2.2), R.range(0.5, 1.1), R.range(1.1, 2.0)), wearTint(R));
      }
    }
    // Two signs wired to the fence either side of the gate.
    if (f.gate) {
      this._sign('signB', f.gate.centre.x - f.gate.halfWidth - 4.5, f.gate.centre.z + 0.4, 0.04, 1.4, 0.72, 1.8);
      this._sign('signC', f.gate.centre.x + f.gate.halfWidth + 4.5, f.gate.centre.z + 0.4, -0.03, 1.4, 0.72, 1.8);
    }
  };

  // ==========================================================================
  // PASS 9 - THE DESERT
  //
  // Everything OUTSIDE the pad.  Creosote does not grow in a lawn: it grows in
  // widely spaced clumps with bare ground between them (each bush poisons its
  // own root zone, which is why a real creosote flat looks planted on a grid it
  // is not), it grows THICKER in the drainage lines, and it grows right up
  // against the pad edge where the runoff goes.
  // ==========================================================================
  PropsBoneyard.prototype._dressDesert = function () {
    var A = this.A;
    if (!A || !A.yard) return;
    var R = this.rng, N = this.noise;
    var y = A.yard, f = this.fence;
    var i;

    // How far outside the pad, in metres (negative = inside).
    var self = this;
    function outside(x, z) {
      return -Math.min(Math.min(x - y.x0, y.x1 - x), Math.min(z - y.z0, y.z1 - z));
    }

    // ---- bushes -------------------------------------------------------------
    // The sample box runs to fence + 55 m, not fence + 12.  The level's desert
    // ring is 540 m across and the first pass only seeded a 12 m strip outside
    // the wire, so from the water-tower framing - the one shot in the level
    // whose whole subject is the desert the yard sits in - the flat came back
    // as an unbroken sheet of tan with nothing growing on it anywhere.
    var OUTER = 55;
    var tries = 3000;
    for (i = 0; i < tries; i++) {
      var px = R.range(f.x0 - OUTER, f.x1 + OUTER);
      var pz = R.range(f.z0 - OUTER, f.z1 + OUTER);
      var out = outside(px, pz);
      if (out < 1.5) continue;                              // on the slab
      // a clumped density field, so the flat has open ground and thickets
      var dens = N.fbm2(px * 0.028 + 12.5, pz * 0.028 - 7.1, 3) * 0.5 + 0.5;
      // thicker in the first 25 m off the pad, where the runoff sheets out -
      // and creosote poisons its own root zone, so what a real flat looks like
      // is widely spaced clumps with bare ground between them, never a lawn
      dens += M.smoothstep(25, 3, out) * 0.34;
      dens *= M.smoothstep(OUTER + 40, OUTER - 5, out) * 0.55 + 0.45;
      if (R.next() > dens * 0.55) continue;
      var dead = R.next() < 0.34;
      this._drop(dead ? this.B.brittle : this.B.creosote, px, pz, {
        r: dead ? 0.55 : 0.85, taxi: true, noClear: true, foot: false,
        scale: R.range(0.55, 1.35), tilt: 0.06
      });
    }

    // ---- rocks and cobble ---------------------------------------------------
    for (i = 0; i < 1400; i++) {
      var rx = R.range(f.x0 - 24, f.x1 + 24);
      var rz = R.range(f.z0 - 24, f.z1 + 24);
      if (outside(rx, rz) < 2.5) continue;
      var rd = N.fbm2(rx * 0.05 - 3.3, rz * 0.05 + 9.4, 2) * 0.5 + 0.5;
      if (R.next() > rd * 0.5) continue;
      this._drop(this._var('rock', 2), rx, rz, {
        r: 0.30, taxi: true, noClear: true, foot: false,
        scale: R.range(0.55, 1.5), tilt: 0.30, sink: R.range(0.02, 0.09)
      });
    }

    // ---- the pad edge -------------------------------------------------------
    // A ramp of blown sand runs the whole way round the slab, which is what
    // stops the hardstanding reading as a card laid on the desert.
    var b = this.B.drift;
    var edges = [
      [y.x0, y.z0, y.x1, y.z0, 0, -1], [y.x0, y.z1, y.x1, y.z1, 0, 1],
      [y.x0, y.z0, y.x0, y.z1, -1, 0], [y.x1, y.z0, y.x1, y.z1, 1, 0]
    ];
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e];
      var elen = Math.sqrt((ed[2] - ed[0]) * (ed[2] - ed[0]) + (ed[3] - ed[1]) * (ed[3] - ed[1]));
      var en = Math.round(elen / 11);
      for (i = 0; i < en && b && b.n < b.max; i++) {
        var t = (i + 0.5) / en + R.gaussian(0, 0.3 / en);
        var ex = M.lerp(ed[0], ed[2], t) + ed[4] * R.range(0.4, 2.2);
        var ez = M.lerp(ed[1], ed[3], t) + ed[5] * R.range(0.4, 2.2);
        b.add(T(ex, this._ground(ex, ez) - 0.05, ez,
          R.gaussian(0, 0.015), Math.atan2(-ed[4], -ed[5]) + R.gaussian(0, 0.3), R.gaussian(0, 0.015),
          R.range(1.6, 3.2), R.range(0.5, 1.0), R.range(1.4, 2.6)), wearTint(R));
      }
    }
    void self;
  };

  // ==========================================================================
  // PASS 10 - WEEDS IN THE JOINTS
  //
  // The highest-value hundred triangles in the whole file.  Nothing says
  // "nobody has driven on this in fifteen years" like grass coming up through
  // the saw-cut joints of an apron, and nothing says "this is a 3D model" like
  // 200 m of perfectly clean concrete.
  //
  // The joints are on the level's own 7.62 m (25 ft) airfield bay pitch with
  // the same phase its jointDip() uses, so a weed is IN a joint rather than
  // near one; and weed density is a TRAFFIC map - zero down the taxiway and the
  // row centrelines, heavy in the bays nothing has moved in.
  // ==========================================================================
  var BAY_PITCH = 7.62;

  PropsBoneyard.prototype._dressJointWeeds = function () {
    var A = this.A;
    if (!A || !A.yard) return;
    var R = this.rng, N = this.noise;
    var y = A.yard;
    var b = this.B.weed;
    if (!b) return;

    // Traffic: 1 where wheels go (no weed), 0 where nothing has been for years.
    var rows = (A.rows || []).map(function (r) { return r.x; });
    var self = this;
    function traffic(x, z) {
      var t = 0;
      if (A.taxiway && z > A.taxiway.z0 && z < A.taxiway.z1) {
        t = Math.max(t, M.smoothstep(A.taxiway.half + 3, 1.5, Math.abs(x - A.taxiway.x)));
      }
      for (var i = 0; i < rows.length; i++) {
        t = Math.max(t, M.smoothstep(5.0, 1.0, Math.abs(x - rows[i])) * 0.85);
      }
      if (A.crossLane && x > A.crossLane.x0 && x < A.crossLane.x1) {
        var cz = (A.crossLane.z0 + A.crossLane.z1) * 0.5;
        t = Math.max(t, M.smoothstep(9.0, 3.0, Math.abs(z - cz)) * 0.8);
      }
      if (A.hangar) {
        var hx = M.clamp(x, A.hangar.x0 - 14, A.hangar.x1);
        var hz = M.clamp(z, A.hangar.doorZ0 - 6, A.hangar.doorZ1 + 6);
        var d = Math.sqrt((x - hx) * (x - hx) + (z - hz) * (z - hz));
        t = Math.max(t, M.smoothstep(10, 0, d) * 0.9);
      }
      return M.saturate(t);
    }

    // Walk the joint grid.  Longitudinal joints first, then transverse.
    var i, j;
    var xs = [], zs = [];
    for (i = Math.ceil((y.x0 + 3.81) / BAY_PITCH); i * BAY_PITCH - 3.81 < y.x1; i++) xs.push(i * BAY_PITCH - 3.81);
    for (j = Math.ceil((y.z0 + 1.9) / BAY_PITCH); j * BAY_PITCH - 1.9 < y.z1; j++) zs.push(j * BAY_PITCH - 1.9);

    // ---- CANDIDATES FIRST, THEN SHUFFLE, THEN SPEND -----------------------
    // The first version walked the joint grid in x order and simply ran out of
    // instance budget somewhere over the west storage field, so the entire east
    // half of the yard - the taxiway edge, Sierra Seven's stand, the parts yard
    // and the hangar apron, i.e. four of the five published framings - got no
    // weed at all while the far west corner had six hundred.  Collecting every
    // candidate and shuffling spends the same budget evenly over the yard, and
    // it costs one array.
    var cand = [];
    var z, x, tr, gf;
    for (i = 0; i < xs.length; i++) {
      var jx = xs[i];
      for (z = y.z0 + 2; z < y.z1 - 2; z += R.range(0.7, 2.6)) {
        tr = traffic(jx, z);
        // a growth field: seed lands where water sits and where the wind drops
        gf = N.fbm2(jx * 0.06 + 4.4, z * 0.06 - 2.2, 3) * 0.5 + 0.5;
        if (R.next() > (1 - tr) * gf * 0.75) continue;
        cand.push(jx + R.gaussian(0, 0.06), z + R.gaussian(0, 0.30));
      }
    }
    // Transverse joints, sparser: they shed rather than pond.
    for (j = 0; j < zs.length; j++) {
      var jz = zs[j];
      for (x = y.x0 + 2; x < y.x1 - 2; x += R.range(1.2, 4.5)) {
        tr = traffic(x, jz);
        gf = N.fbm2(x * 0.06 - 8.1, jz * 0.06 + 5.5, 3) * 0.5 + 0.5;
        if (R.next() > (1 - tr) * gf * 0.40) continue;
        cand.push(x + R.gaussian(0, 0.30), jz + R.gaussian(0, 0.06));
      }
    }
    // Fisher-Yates on the pair array
    for (i = cand.length / 2 - 1; i > 0; i--) {
      var k = R.int(0, i);
      var ax = cand[i * 2], az = cand[i * 2 + 1];
      cand[i * 2] = cand[k * 2]; cand[i * 2 + 1] = cand[k * 2 + 1];
      cand[k * 2] = ax; cand[k * 2 + 1] = az;
    }
    for (i = 0; i < cand.length / 2 && b.n < b.max; i++) {
      this._drop(b, cand[i * 2], cand[i * 2 + 1], {
        r: 0.10, low: true, taxi: true, noClear: true, foot: false,
        scale: R.range(0.55, 1.7), tilt: 0.15, sink: 0.02
      });
    }
    void self;
  };

  // ==========================================================================
  // PASS 11 - DRIFTS IN THE OPEN
  //
  // Whatever drift budget the placement passes did not spend goes into the
  // yard's own lee pockets: behind every big airframe, in the corners of the
  // cross lane, and along the row of bays nothing has been towed out of.
  // ==========================================================================
  PropsBoneyard.prototype._dressDrifts = function () {
    var A = this.A;
    var b = this.B.drift;
    if (!A || !b) return;
    var R = this.rng;
    var w = this.windDir;
    var wy = Math.atan2(w.x, w.y);
    var i;

    function bank(self, cx, cz, n, spread, sMin, sMax) {
      for (var k = 0; k < n && b.n < b.max; k++) {
        var px = cx + R.gaussian(0, spread), pz = cz + R.gaussian(0, spread);
        if (!self._inBounds(px, pz, 0.2, { taxi: true, low: true })) continue;
        b.add(T(px, self._ground(px, pz) - 0.04, pz,
          R.gaussian(0, 0.02), wy + R.gaussian(0, 0.28), R.gaussian(0, 0.02),
          R.range(sMin, sMax), R.range(0.4, 0.9), R.range(sMin, sMax)), wearTint(R));
      }
    }

    // behind the big airframes
    if (A.bigAircraft) {
      for (i = 0; i < A.bigAircraft.length; i++) {
        var ba = A.bigAircraft[i];
        bank(this, ba.centre.x + w.x * ba.span * 0.34, ba.centre.z + w.y * ba.span * 0.34,
          5, 3.4, 1.2, 2.6);
      }
    }
    // in the lee of every parked airframe in the west rows: the storage field
    // is where the sand actually collects, because nothing there has moved
    if (A.rows) {
      for (i = 0; i < A.rows.length; i++) {
        var row = A.rows[i];
        for (var j = 0; j < row.bays.length; j++) {
          if (R.next() < 0.45) continue;
          bank(this, row.x + w.x * 5.5 + R.gaussian(0, 1.5),
            row.bays[j] + w.y * 5.5 + R.gaussian(0, 1.5), 2, 1.8, 0.8, 1.8);
        }
      }
    }
    // the cross lane's downwind corner
    if (A.crossLane) {
      bank(this, A.crossLane.centre.x + w.x * 8, A.crossLane.centre.z + w.y * 8, 6, 4.0, 1.2, 2.4);
    }
    // and against the hangar's windward wall
    if (A.hangar) {
      var hx = (A.hangar.x0 + A.hangar.x1) * 0.5 - w.x * (A.hangar.x1 - A.hangar.x0) * 0.5 - w.x * 1.2;
      var hz = (A.hangar.z0 + A.hangar.z1) * 0.5 - w.y * (A.hangar.z1 - A.hangar.z0) * 0.5 - w.y * 1.2;
      bank(this, hx, hz, 7, 5.0, 1.4, 2.8);
    }
  };

  // ==========================================================================
  // COMMIT
  // ==========================================================================
  var STATIC_UVNAME = {
    steel: 'painted_metal', yellow: 'painted_metal', red: 'painted_metal',
    olive: 'painted_metal', body: 'painted_metal', gas: 'painted_metal',
    alu: 'painted_metal', rustProp: 'rusted_metal', corrProp: 'corrugated_metal',
    wood: 'wood_plank', rubber: 'rubber', canvasProp: 'canvas_awning',
    concreteProp: 'concrete', binPlastic: 'plastic', glassProp: 'glass',
    lamp: 'plastic', sandProp: 'sand', rockProp: 'gravel',
    cone: 'plastic', coneBand: 'plastic'
  };
  var STATIC_WEAR = {
    wood: { dust: 0.44, grime: 0.24, edge: 0.46, hiY: 1.6 },
    rubber: { dust: 0.46, grime: 0.36, edge: 0.10, hiY: 1.2 },
    alu: { dust: 0.50, grime: 0.22, edge: 0.38, hiY: 1.8 },
    canvasProp: { dust: 0.58, grime: 0.34, edge: 0.30, hiY: 2.0 },
    glassProp: { dust: 0.26, grime: 0.30, edge: 0.06, hiY: 2.0 },
    lamp: { dust: 0.30, grime: 0.20, edge: 0.08, hiY: 2.0 },
    sandProp: { dust: 0.16, grime: 0.10, edge: 0.06, hiY: 0.6 }
  };

  PropsBoneyard.prototype._commit = function () {
    var key, i;

    // ---- the canopy cloth ---------------------------------------------------
    // Built here rather than in the ops pass because it is a wind mesh with its
    // own material, and a lone extra draw call is worth one thing that moves in
    // the only piece of human-scale shade in the level.
    if (this._canopy) {
      try { this._buildCanopyCloth(); } catch (e) { GAME.logError('propsB.canopy', e); }
    }

    // ---- static merges ------------------------------------------------------
    for (key in this.S) {
      var parts = this.S[key];
      if (!parts || !parts.length) continue;
      var geo = mergeParts(parts);
      disposeParts(parts);
      if (!geo) continue;
      var uvName = STATIC_UVNAME[key] || 'painted_metal';
      // The two locally-textured families carry their own UVs (a drum skin and
      // a crate stencil are authored to the object, not to a world density) and
      // re-projecting them would smear the stencilling into noise.
      if (key !== 'drumSkin' && key !== 'crateSkin' && key !== 'spill') {
        try { Geo.worldUV(geo, this._uvScale(uvName, 480)); }
        catch (e2) { /* keep the builder's uv */ }
      }
      Geo.copyUV1(geo);
      var wear = STATIC_WEAR[key] || { dust: 0.44, grime: 0.28, edge: 0.28, hiY: 1.8 };
      wear.noise = this.noise;
      if (MULT[key]) paintTint(geo, wear); else paintDust(geo, wear);
      var mat = this.mats[key] || this.mats.steel;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'boneyard_static_' + key;
      mesh.castShadow = (key !== 'sandProp' && key !== 'spill');
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    // ---- ground stains ------------------------------------------------------
    if (this.stainParts.length) {
      var sg = mergeParts(this.stainParts);
      disposeParts(this.stainParts);
      if (sg) {
        Geo.copyUV1(sg);
        var sm = new THREE.Mesh(sg, this.mats.stain);
        sm.name = 'boneyard_stains';
        sm.castShadow = false;
        sm.receiveShadow = true;
        sm.renderOrder = 2;
        this.root.add(sm);
      }
    }

    // ---- signage ------------------------------------------------------------
    // One mesh per placard artwork; three in the level, three draws, and they
    // are the only text a player can walk up to.
    var byMat = {};
    for (i = 0; i < this.signParts.length; i++) {
      var sp = this.signParts[i];
      (byMat[sp.mat] || (byMat[sp.mat] = [])).push(part(sp.geometry, sp.matrix));
    }
    for (key in byMat) {
      var gg = mergeParts(byMat[key]);
      disposeParts(byMat[key]);
      if (!gg) continue;
      Geo.copyUV1(gg);
      var mm = new THREE.Mesh(gg, this.mats[key] || this.mats.signA);
      mm.name = 'boneyard_' + key;
      mm.castShadow = true;
      mm.receiveShadow = true;
      this.root.add(mm);
    }

    // ---- instanced batches --------------------------------------------------
    this.stats.batch = {};
    for (key in this.B) {
      var b = this.B[key];
      if (!b || !b.mesh) continue;                 // Combos are indices, not meshes
      if (b.full) this.stats.full.push(key + ':' + b.max);
      this.stats.batch[key] = b.n;
      if (b.finish(this.root, 'boneyard_' + key)) this.stats.instances += b.n;
      else delete this.B[key];
    }

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

    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise,
    // and it is the only way to see instance-budget overflow, which is
    // otherwise silent: Batch.add returns false and the last pass built gets
    // nothing.  Written into the DOM as well as the console because headless
    // --dump-dom can read the DOM and cannot read the console.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({
          st: this.stats, bounds: this.bounds, groundY: this.groundY,
          aircraft: (this.aircraft || []).length, shade: (this.shade || []).length,
          anchors: !!this.A, keepOut: this._keepOut.length
        });
        if (window.console && console.log) console.log('BONEYARDPROPS ' + dbg);
        if (typeof document !== 'undefined' && document.body) {
          var d = document.createElement('div');
          d.id = 'boneyardpropstat';
          d.style.display = 'none';
          d.textContent = dbg;
          document.body.appendChild(d);
        }
      }
    } catch (e3) { /* diagnostics never break a build */ }

    // Opt-in isolation (?propshide=drum,static or =1 for all).  "Which module
    // owns that object?" is otherwise unanswerable from a screenshot.
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
    } catch (e4) { /* diagnostics never break a build */ }

    if (this.ctx && this.ctx.bus && this.ctx.bus.emit) {
      this.ctx.bus.emit('props:ready', this);
    }
  };

  // A sagging shade sheet lashed over the canopy frame.  aFlex is zero at the
  // four corners (they are tied down) and maximum in the middle of each edge,
  // which is where a real sheet lifts and cracks.
  PropsBoneyard.prototype._buildCanopyCloth = function () {
    var c = this._canopy;
    var nx = 8, nz = 6;
    var pos = [], nor = [], uv = [];
    var grid = [], i, j;
    for (j = 0; j <= nz; j++) {
      var row = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx, v = j / nz;
        var sagU = Math.sin(u * Math.PI), sagV = Math.sin(v * Math.PI);
        row.push([(u - 0.5) * c.w * 1.05, c.h + 0.14 - sagU * sagV * 0.22, (v - 0.5) * c.d * 1.05]);
      }
      grid.push(row);
    }
    function push(p, n, u, v) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); uv.push(u, v); }
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var A0 = grid[j][i], B0 = grid[j][i + 1], C0 = grid[j + 1][i], D0 = grid[j + 1][i + 1];
        var nn = [0, 1, 0];
        push(A0, nn, i / nx, j / nz); push(C0, nn, i / nx, (j + 1) / nz); push(B0, nn, (i + 1) / nx, j / nz);
        push(B0, nn, (i + 1) / nx, j / nz); push(C0, nn, i / nx, (j + 1) / nz); push(D0, nn, (i + 1) / nx, (j + 1) / nz);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.computeVertexNormals();
    Geo.copyUV1(g);
    paintDust(g, { noise: this.noise, dust: 0.62, grime: 0.34, edge: 0.34, hiY: 3.0 });
    var hw = c.w * 0.5, hd = c.d * 0.5;
    setFlex(g, function (x, y, z) {
      var eu = 1 - Math.abs(x) / Math.max(0.01, hw * 1.05);
      var ev = 1 - Math.abs(z) / Math.max(0.01, hd * 1.05);
      // free in the middle of an edge, pinned hard at every corner
      return M.saturate(Math.min(eu, ev) * 2.2) * 0.55;
    });
    var mesh = new THREE.Mesh(g, this.mats.cloth);
    mesh.name = 'boneyard_canopy_cloth';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.clothDepth;
    mesh.position.set(c.x, c.y, c.z);
    mesh.rotation.y = c.yaw;
    mesh.updateMatrix();
    this.root.add(mesh);
    this.windMeshes.push(mesh);
  };

  // ==========================================================================
  // SHADE IS THE SCARCE RESOURCE, AND IT IS WHERE THINGS GET PUT DOWN.
  //
  // The level publishes 34 shade rectangles for exactly this and this file read
  // them once. The count that mattered: inside the hero1 90 m frustum there
  // were ~355 instances, of which 150 were weeds, 48 chocks and 31 sand drifts,
  // so the readable clutter was a couple of dozen objects across a 200 m yard -
  // and what there was read as evenly-sprinkled confetti on open concrete
  // rather than as gear grouped where crews work.
  //
  // A crew working an airframe at noon does not put its cart in the sun. So
  // every shade zone gets a small, coherent CLUSTER on its lee side: a couple
  // of drums, a pallet stack, a bin, a cart, a couple of crates. Same objects,
  // ten times the read, and none of it is a new asset.
  // ==========================================================================
  PropsBoneyard.prototype._dressShade = function () {
    if (!this.shade || !this.shade.length) return;
    var R = this.rng;
    var wd = this.windDir;
    for (var i = 0; i < this.shade.length; i++) {
      var s = this.shade[i];
      if (!s || s.source === 'hangar') continue;      // the shed has its own pass
      var hw = (s.x1 - s.x0) * 0.5, hd = (s.z1 - s.z0) * 0.5;
      if (!(hw > 1.2 && hd > 1.2)) continue;
      // the lee corner of the zone, which is also the deepest part of it
      var cx = M.lerp(s.x0, s.x1, 0.5 + R.range(-0.28, 0.28)) + wd.x * hw * 0.35;
      var cz = M.lerp(s.z0, s.z1, 0.5 + R.range(-0.28, 0.28)) + wd.y * hd * 0.35;
      var kind = i % 5;
      if (kind === 0) {
        // a pair of drums and a jerrycan beside them
        this._against(this._var('drum', 4), cx - 0.9, cz, cx + 0.9, cz, 0, 1, 2,
          { r: 0.34, off: 0.10, low: true, noClear: true, foot: false });
        this._drop(this.B.jerrycan, cx + 1.5, cz + 0.5, {
          r: 0.22, low: true, noClear: true, foot: false, yaw: R.range(0, TAU)
        });
      } else if (kind === 1) {
        this._stack(this.B.pallet, cx, cz, R.int(3, 6), 0.145,
          { r: 0.7, yaw: R.range(0, TAU) });
        this._drop(this.B.partsBin, cx + 1.3, cz - 0.7, {
          r: 0.24, low: true, noClear: true, foot: false, yaw: R.range(0, TAU)
        });
      } else if (kind === 2) {
        this._put('toolCart', cx, cz, {
          yaw: R.range(0, TAU), r: 0.9, h: 1.0, taxi: true, noClear: true, foot: false
        });
        this._heap(this.B.partsBin, cx + 1.6, cz + 0.9, 3, 0.9,
          { r: 0.24, low: true, tilt: 0.03 });
      } else if (kind === 3) {
        this._drop(this.B.crate, cx, cz, {
          r: 0.7, yaw: R.range(0, TAU), noClear: true, foot: false,
          scale: R.range(0.80, 1.0)
        });
        this._drop(this.B.crate, cx + 1.15, cz + 0.35, {
          r: 0.5, yaw: R.range(0, TAU), noClear: true, foot: false,
          sx: 0.58, sy: 0.54, sz: 0.66
        });
        this._drop(this.B.bucket, cx - 0.9, cz + 0.8, {
          r: 0.22, low: true, noClear: true, foot: false
        });
      } else {
        this._tyreRow(cx, cz, R.int(3, 5), R.range(0, Math.PI), {});
        this._drop(this.B.dripPan, cx + 1.4, cz - 1.0, {
          r: 0.55, low: true, noClear: true, foot: false, yaw: R.range(0, TAU)
        });
      }
      // and the mark a stack leaves after twenty summers in the same spot
      if (R.next() < 0.45) this._stain(3, cx, cz, R.range(2.4, 4.4), R.range(2.0, 3.6), R.range(0, 3));
    }
  };

  // --------------------------------------------------------------------------
  // A dust-devil column: a soft vertical alpha smear, tiling in v so the UV
  // scroll never shows a seam, with a torn edge so the column is ragged.
  // --------------------------------------------------------------------------
  TX.devil = function (size, seed) {
    var c = TX.canvas(size, size * 2);
    if (!c) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed);
    var W = c.width, H = c.height, i;
    g.clearRect(0, 0, W, H);
    // the core: a dense vertical band that thins toward the edges
    for (i = 0; i < 260; i++) {
      var x = W * 0.5 + rng.gaussian(0, W * 0.17);
      var y = rng.next() * H;
      var r = rng.range(W * 0.03, W * 0.16);
      var a = (1 - Math.abs(x - W * 0.5) / (W * 0.5)) * rng.range(0.14, 0.46);
      if (a <= 0) continue;
      var gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(216,190,150,' + a.toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(214,188,148,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      // wrapped copy so the vertical scroll is seamless
      var y2 = y > H * 0.5 ? y - H : y + H;
      var gr2 = g.createRadialGradient(x, y2, 0, x, y2, r);
      gr2.addColorStop(0, 'rgba(216,190,150,' + a.toFixed(3) + ')');
      gr2.addColorStop(1, 'rgba(214,188,148,0)');
      g.fillStyle = gr2;
      g.beginPath(); g.arc(x, y2, r, 0, TAU); g.fill();
    }
    // fade the top so the column dissipates instead of ending
    var fade = g.createLinearGradient(0, 0, 0, H * 0.28);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, W, H * 0.28);
    g.globalCompositeOperation = 'source-over';
    return c;
  };

  PropsBoneyard.prototype._dressDevils = function () {
    var A = this.A;
    if (!A || !A.dustDevils || !A.dustDevils.length) return;
    var R = this.rng;
    var canvas = TX.devil(128, 0xD3711);
    var tex = TX.tex(canvas, true, 1, 1, this._aniso || 4);
    if (!tex) return;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Only two at a time. A yard with a devil at every published fetch reads as
    // a weather event; two is a hot afternoon.
    var pick = [0, 1];
    for (var k = 0; k < pick.length; k++) {
      var a = A.dustDevils[pick[k] % A.dustDevils.length];
      if (!a) continue;
      // fog:false, and it is not a shortcut. A dust column IS haze, and at
      // 140 m the shader fog was blending it toward the very colour it is made
      // of - so a 16 m column dissolved into the sky it was standing against
      // and the frame gained nothing. It carries its own aerial perspective in
      // its albedo instead: a sunlit dust column at noon is brighter and warmer
      // than the horizon sky behind it, which is exactly what makes one
      // readable in a photograph from two kilometres away.
      var mat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xe4d2ae, transparent: true, opacity: 0.7,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
        blending: THREE.NormalBlending
      });
      mat.name = 'by_devil';
      var obj = new THREE.Object3D();
      var H = R.range(13.0, 19.0);
      // Four cards on a fan, each a tapered trapezoid: wide and soft at the
      // top, tight at the foot, which is the shape of the real thing.
      for (var i = 0; i < 4; i++) {
        var g = new THREE.PlaneGeometry(1, 1, 1, 3);
        var p = g.attributes.position, uvA = g.attributes.uv;
        for (var v = 0; v < p.count; v++) {
          var fy = uvA.getY(v);                       // 0 at the foot, 1 at the top
          var wdt = M.lerp(1.5, 6.5, Math.pow(fy, 0.75));
          p.setX(v, p.getX(v) * wdt);
          p.setY(v, fy * H);
          // the column leans downwind as it rises
          p.setZ(v, fy * fy * 2.2);
        }
        g.computeVertexNormals();
        var mesh = new THREE.Mesh(g, mat);
        mesh.rotation.y = (i / 4) * Math.PI + R.range(-0.12, 0.12);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        obj.add(mesh);
      }
      obj.position.set(a.x, this._ground(a.x, a.z) - 0.2, a.z);
      obj.matrixAutoUpdate = false;
      obj.updateMatrix();
      this.root.add(obj);
      this.devils.push({
        obj: obj, mat: mat, x: a.x, z: a.z,
        rate: R.range(1.5, 2.6), phase: R.range(0, TAU),
        pulse: R.range(0.09, 0.16), speed: R.range(0.9, 1.6), run: 90,
        alpha: R.range(0.52, 0.72)
      });
    }
  };

  // ==========================================================================
  // PER FRAME
  //
  // The yard is dead aeroplanes on hot concrete; the only things alive in it
  // are the wind and the sun.  Everything else is static and matrixAutoUpdate
  // false, so this costs three uniform writes a frame.
  // ==========================================================================
  var _wdir = new THREE.Vector2();

  PropsBoneyard.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    // Drive from ctx.time when the engine provides it so deterministic capture
    // runs reproduce exactly; integrate dt otherwise.
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    this.uTime.value = this.time;

    // weather.js owns the wind; we only read it, and only through a guard,
    // because on this level the preset is `clear` and `clear` is ABSENT - so
    // ctx.weather is legitimately inert or missing and the desert breeze the
    // placement was baked against has to survive that.
    var w = ctx && ctx.weather;
    if (w) {
      if (w.windDir && isFinite(w.windDir.x) && isFinite(w.windDir.y)) {
        _wdir.copy(w.windDir);
        if (_wdir.lengthSq() > 1e-6) {
          _wdir.normalize();
          this.uWindDir.value.copy(_wdir);
        }
      }
      if (typeof w.windSpeed === 'number' && isFinite(w.windSpeed) && w.windSpeed > 0.01) {
        this.windSpeed = w.windSpeed;
      }
    }
    // Amplitude and frequency both rise with wind speed: a streamer in a gust
    // moves further AND faster, and scaling only one of them reads as slow
    // motion.  A thermal gust cycle rides on top, because a desert at noon does
    // not have a steady wind - it has convection.
    var thermal = 1 + 0.30 * Math.sin(this.time * 0.19) + 0.16 * Math.sin(this.time * 0.53 + 1.9);
    var s = M.clamp((this.windSpeed / 5.0) * thermal, 0.30, 2.4);
    var wv = this.uWind.value;
    wv.x = 0.030 + 0.050 * s;
    wv.y = 1.35 + 1.20 * s;
    wv.z = 0.30 + 0.26 * s;

    // The key, for the vegetation sun-through term.  Read, never written.
    try {
      var sd = ctx && ctx.sky && ctx.sky.sunDirection;
      if (sd && isFinite(sd.x) && (sd.x * sd.x + sd.y * sd.y + sd.z * sd.z) > 0.5) {
        this.uSunDir.value.copy(sd).normalize();
      }
      if (ctx && ctx.sky && ctx.sky.sunColor && ctx.sky.sunColor.isColor) {
        this.uSunCol.value.copy(ctx.sky.sunColor);
      }
    } catch (e) { /* the authored bearing is a fine fallback */ }

    this._updateDevils(dt);
  };

  // --------------------------------------------------------------------------
  // THE DUST DEVILS.
  //
  // level.anchors.dustDevils has published four open-fetch positions since the
  // level was written and nothing in src/ ever read them, so the brief's dust
  // devils were simply absent - and the only airborne particulate in any
  // boneyard frame was the shared VFX dust field, which at this sky area prints
  // as 1-2 px white squares scattered over the upper sky and reads as stuck
  // sensor pixels.
  //
  // A devil is a rotating column of alpha cards with a warm tan tint, a slow
  // vertical UV scroll and a downwind drift.  It is the only moving vertical
  // element the far field has, and it goes in the open right half of the
  // establishing shot where there is otherwise nothing at all.
  // --------------------------------------------------------------------------
  PropsBoneyard.prototype._updateDevils = function (dt) {
    var i, d;
    if (!this.devils || !this.devils.length) return;
    var wd = this.uWindDir.value;
    for (i = 0; i < this.devils.length; i++) {
      d = this.devils[i];
      var t = this.time * d.rate + d.phase;
      d.obj.rotation.y = t;
      // it wanders and leans, and its life cycle fades it in and out so the
      // yard never has the same two columns standing in the same two places
      var life = 0.5 + 0.5 * Math.sin(this.time * d.pulse + d.phase * 2.1);
      var drift = (this.time * d.speed) % d.run;
      d.obj.position.x = d.x + wd.x * drift + Math.sin(t * 0.31) * 1.6;
      d.obj.position.z = d.z + wd.y * drift + Math.cos(t * 0.27) * 1.6;
      d.obj.rotation.z = 0.06 * Math.sin(this.time * 0.44 + d.phase);
      d.obj.scale.set(1, 0.72 + 0.44 * life, 1);
      if (d.mat) d.mat.opacity = d.alpha * (0.58 + 0.42 * life);
      if (d.mat && d.mat.map) d.mat.map.offset.y = -this.time * 0.11 * d.rate;
      d.obj.updateMatrix();
    }
  };

  PropsBoneyard.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsBoneyard.prototype.dispose = function () {
    try {
      this.root.traverse(function (o) {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.isInstancedMesh && o.dispose) o.dispose();
      });
      var k;
      for (k in this.mats) { if (this.mats[k] && this.mats[k].dispose) this.mats[k].dispose(); }
      for (k in this.tex) { if (this.tex[k] && this.tex[k].dispose) this.tex[k].dispose(); }
      if (this.root.parent) this.root.parent.remove(this.root);
    } catch (e) { GAME.logError('propsB.dispose', e); }
    this.colliders.length = 0;
  };

  GAME.PropsBoneyard = PropsBoneyard;

})(window.GAME, window.THREE);
