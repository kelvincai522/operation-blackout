// ============================================================================
// OPERATION BLACKOUT - "FACILITY K-17" - set dressing
// Module owner: props_bunker.  Exports GAME.PropsBunker.
//
// level_bunker.js builds the PLACE: an approach tunnel that has come in, a
// blast door stopped 2.9 m into its pocket, 42 m of 3.9 m spine, a control
// room, a plant room, a 28 x 26 x 11 m reactor gallery and a flooded lower
// level.  This file is what makes it a place that was WORKED IN - by a watch
// crew for forty years, then by a maintenance gang who were mid-shift on the
// coolant circuit when the alarm went, and then by nobody.
//
// ----------------------------------------------------------------------------
// HOW THIS SET INVERTS THE METRO SET (the other sealed level)
// ----------------------------------------------------------------------------
// Both are underground, both have sky 'none', both cap metalness, and that is
// where it stops:
//
//   * THE ACCUMULANT IS DUST, NOT WATER.  props_metro spends the vertex G
//     channel on the FOOT of everything, because the water is standing on the
//     floor and rises by capillary action.  Here, above y = -3.6, G is
//     essentially unused: the facility is DRY.  What accumulates is forty years
//     of settled concrete dust, and dust lands on UP-FACING surfaces.  So this
//     file spends the B channel - which brightens toward a pale substrate - on
//     `ny > 0`, exactly as level_bunker.js does on its own decks and soffits.
//     A prop whose top is a shade paler and flatter than its sides reads as
//     "nobody has touched this since 1986" from across the gallery; the same
//     prop uniformly grimy reads as "this is a dirty object".
//     Only props BELOW the deck are wet, and they are wet because they are
//     standing in 58 cm of water, which the flood gradient in `paintWear`
//     handles off the prop's own foot height.
//   * THE PALETTE IS THE LEVEL'S OWN, DELIBERATELY SHORT.  Cold-war facility
//     stock is oxide red (the dado, fire gear, valve bodies), an institutional
//     grey-green (cases, cabinets, ammunition boxes), a bone cream (files,
//     signage grounds, enamel shades) and hazard ochre (gas cylinders, waste
//     drums, barriers).  Running every prop through those four is what ties the
//     dressing to the dado band the level already carries, instead of
//     introducing a second, unrelated colour story.  The ochre is doing real
//     work: in a frame that is grey concrete and red alarm, it is the only warm
//     saturated accent, and a grey cylinder under a fluorescent photographs as
//     a lump of nothing.
//   * DEBRIS DOES NOT SCATTER, IT COLLECTS.  There is no wind in here and there
//     never was.  Everything on the floor is either (a) against a wall, a
//     pilaster base, a kerb or a machine skirt, where it was swept or kicked,
//     (b) in the corner of a bay, where dust settles out of the air, or (c) on
//     the walking line, where it was DROPPED - and the walking lines are kept
//     clear because forty years of boots keep them clear.  The route down the
//     spine centreline and the west bridge onto the operating platform carry
//     nothing but the odd dropped page.
//   * THERE IS NO WEATHER AND NO WIND.  ctx.weather is inert here by contract.
//     What moves is water arriving through the roof into the flooded well, the
//     dust hanging in the beams of the fittings that still strike, and the
//     ventilation draught off the plant room trunk, which is the only air
//     movement in the facility and which is what stirs the hung suits and the
//     cut cable ends.
//
// ----------------------------------------------------------------------------
// CONSTRAINTS THAT SHAPED THE CODE
// ----------------------------------------------------------------------------
//   * < 80 draw calls for ALL props.  Anything appearing more than about six
//     times is an InstancedMesh with per-instance yaw, tilt, scale and wear
//     jitter; everything one-off merges into a per-material static batch.
//   * METALNESS IS CAPPED AT 0.26 AND IT IS NOT A STYLE CHOICE.  sky is 'none',
//     so the environment probe is near black.  A metal returns almost nothing
//     but its environment; at metalness 0.5 every drum, cabinet and cylinder in
//     the facility renders as a black silhouette with no readable form.  Every
//     metal here sits at 0.10-0.26 so the diffuse term - which the practicals
//     CAN light - keeps the object's shape.
//   * NOTHING FLOATS AND NOTHING IS DROPPED LEVEL.  Every ground placement goes
//     through `_settle`, which samples level.sampleGround across the prop's OWN
//     footprint and tilts the prop onto the measured gradient.  The deck settles
//     up to 9 cm, the slab has 13 mm joints every 2.44 m and the pit floor falls
//     22 cm into the sump; a crate set dead level in the pit floats its downhill
//     corner by two centimetres, which at 3 m reads instantly.
//   * NOTHING derives a position from a camera pose.  Everything hangs off
//     level.anchors, which level_bunker.js publishes for exactly this reason and
//     which is available before build().  The poses are read ONCE, as a keep-out
//     list, so a prop cannot end up inside the lens.
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
  var _set = { y: 0, rx: 0, rz: 0 };

  var UP = new THREE.Vector3(0, 1, 0);
  var WHITE = new THREE.Color(1, 1, 1);
  var TAU = Math.PI * 2;

  // --------------------------------------------------------------------------
  // Tinting.  An InstancedMesh colour and a material colour BOTH multiply the
  // albedo, and a library material already carries a calibrated gain solved from
  // its own map, so a raw mid-tone hex squares the albedo and the prop renders
  // as a cut-out.  Every tint is normalised by its own max channel and pulled
  // back toward white: the hex is a HUE SHIFT, not a second coat.
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
  // as a primitive: a drum that has been rolled down a gallery for thirty years
  // does not have a circular section, and a spoil heap is not an ellipsoid.
  // NEVER called on a cached geometry - always on a clone.
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
          p.setXYZ(i, x * s, y + n1 * amount * 0.22, z * s);
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
  // sections, angle iron, bent sheet, a cast trolley end frame - anything with a
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

  // A cylindrically-UV'd lathe.  v runs along the profile and u round the axis,
  // which is what a drum, a bucket, a cylinder and a lampshade all want, so
  // anything carrying its own painted label is one of these rather than a
  // CylinderGeometry.
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

  // Alpha card, base at y = 0, standing in +Y.  Placards, tags, hung suits.
  function card(w, h, u0, v0, u1, v1) {
    var hw = w * 0.5;
    var pos = new Float32Array([
      -hw, 0, 0, hw, 0, 0, hw, h, 0,
      -hw, 0, 0, hw, h, 0, -hw, h, 0
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 2] = 1;
    var uv = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // A horizontal quad centred on the origin, normal +Y.  Dust patches, oil
  // stains and dropped paper all lie ON something, and authoring them flat means
  // a placement is a yaw and a scale rather than a rotation nobody can read back.
  //
  // WINDING MATTERS HERE AND IT COST A WHOLE CAPTURE ROUND.  The obvious vertex
  // order (-x-z, +x-z, +x+z) has a CLOCKWISE winding seen from above, i.e. a
  // geometric normal of -Y.  Writing +Y into the normal attribute does NOT fix
  // it: these cards are DoubleSide, and three.js flips the shading normal on
  // back faces (`normal *= float(gl_FrontFacing)*2.0-1.0`), so a camera looking
  // DOWN at the card sees the back face, gets -Y, and every dropped page and
  // dust patch in the facility renders as a hard-edged PURE BLACK rectangle
  // lying on a lit floor.  The order below winds counter-clockwise from above.
  function flatQuad(w, d, uv) {
    var hw = w * 0.5, hd = d * 0.5;
    var pos = new Float32Array([
      -hw, 0, hd, hw, 0, hd, hw, 0, -hd,
      -hw, 0, hd, hw, 0, -hd, -hw, 0, -hd
    ]);
    var nor = new Float32Array(18);
    for (var i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
    var u = uv || [0, 0, 1, 1];
    var t = new Float32Array([
      u[0], u[3], u[2], u[3], u[2], u[1],
      u[0], u[3], u[2], u[1], u[0], u[1]
    ]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t, 2));
    return g;
  }

  // A limp sheet: a subdivided quad sagging between its corners with a fold
  // across it, so a dust sheet over a spares pallet or a hung coverall is not a
  // flat plane.
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
        // wound so the face normal is +Y (see the note in K.drift)
        pos.push(a[0], a[1], a[2], d2[0], d2[1], d2[2], c[0], c[1], c[2]);
        uv.push(u0, v0, u0, v1, u1, v1);
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
        uv.push(u0, v0, u1, v1, u1, v0);
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

  // A hanging curtain / coverall: a strip that hangs from y = 0 downward with a
  // fold pattern, so the ventilation draught has something to move.
  function drape(w, h, folds, segsY, noise, seed) {
    segsY = segsY || 5;
    var nx = 7;
    var pos = [], uv = [], i, j;
    var grid = [];
    for (j = 0; j <= segsY; j++) {
      grid[j] = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx, v = j / segsY;
        var amp = folds * (0.35 + 0.65 * v);
        var n = noise ? noise.fbm2(u * 4.0 + (seed || 0), v * 2.0, 2) : 0;
        grid[j][i] = [(u - 0.5) * w, -v * h,
          Math.sin(u * Math.PI * 3 + (seed || 0)) * amp + n * amp * 0.6];
      }
    }
    for (j = 0; j < segsY; j++) {
      for (i = 0; i < nx; i++) {
        var a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
        var u0 = i / nx, u1 = (i + 1) / nx, v0 = j / segsY, v1 = (j + 1) / segsY;
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        uv.push(u0, 1 - v0, u1, 1 - v0, u1, 1 - v1);
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
        uv.push(u0, 1 - v0, u1, 1 - v1, u0, 1 - v1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    g.computeVertexNormals();
    return g;
  }

  // A cached bevelled box.  Perfectly sharp 90-degree edges never catch a
  // highlight, and in a facility lit entirely by small fittings a caught edge
  // highlight is most of what describes a shape at all.
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
  function cy(rTop, rBot, len, seg, open) {
    seg = seg || 10;
    var k = rTop.toFixed(4) + ',' + rBot.toFixed(4) + ',' + len.toFixed(3) + ',' + seg + (open ? 'o' : '');
    var g = _cylCache.get(k);
    if (!g) { g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, !!open); _cylCache.set(k, g); }
    return g;
  }
  var _sphCache = new Map();
  function sph(r, wseg, hseg) {
    var k = r.toFixed(4) + ',' + (wseg || 10) + ',' + (hseg || 7);
    var g = _sphCache.get(k);
    if (!g) { g = new THREE.SphereGeometry(r, wseg || 10, hseg || 7); _sphCache.set(k, g); }
    return g;
  }
  function clearCaches() {
    _boxCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _boxCache.clear();
    _cylCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _cylCache.clear();
    _sphCache.forEach(function (g) { if (g.dispose) g.dispose(); });
    _sphCache.clear();
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

  // 4x4 atlas cell -> uv rectangle, with a half-texel inset so a mip does not
  // bleed the neighbouring cell into a card's torn edge.
  function cellUV(cell, n, eps) {
    n = n || 2;
    eps = eps === undefined ? 0.004 : eps;
    var cx = cell % n, cyc = (cell / n) | 0;
    var s = 1 / n;
    var u0 = cx * s + eps, v0 = 1 - (cyc + 1) * s + eps;
    return [u0, v0, u0 + s - eps * 2, v0 + s - eps * 2];
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
  // A sagging run of cable or hose between two points.  Every facility is strung
  // with these and the catenary is the only curve in a place built out of
  // straight lines.
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
  // A hose or cable lying ON the floor, snaking.  Placed by its two ends plus a
  // lateral wander, because a hose that has been dragged does not run straight
  // and a straight one is the "perfectly straight anything" the bar rejects.
  Item.prototype.snake = function (key, ax, az, bx2, bz, y, r, wander, noise, seed, segs) {
    segs = segs || 8;
    var dx = bx2 - ax, dz = bz - az;
    var len = Math.sqrt(dx * dx + dz * dz) || 1;
    var px2 = -dz / len, pz2 = dx / len;
    var lx = ax, lz = az, ly = y + r;
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var off = Math.sin(t * Math.PI * 2.2 + (seed || 0)) * wander;
      if (noise) off += noise.fbm2(t * 4.0 + (seed || 0), seed || 0, 2) * wander * 0.7;
      var qx = ax + dx * t + px2 * off;
      var qz = az + dz * t + pz2 * off;
      this.tube(key, r, lx, ly, lz, qx, ly, qz, 6);
      lx = qx; lz = qz;
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
  //
  // The cap is the silent failure mode of this whole file: add() past `max`
  // returns false and the caller has no idea, so every batch records `full` and
  // _commit reports it under ?propsdbg=1.
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
    this.mesh.name = name || 'bunker_inst';
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    try { this.mesh.computeBoundingSphere(); } catch (e) { /* older three */ }
    parent.add(this.mesh);
    return this.mesh;
  };

  // A multi-material instanced prop: N parallel batches sharing one matrix.  A
  // gas cylinder is ochre enamel AND a bare brass valve, and forcing it into one
  // material to save a draw call costs the object its read.
  function Combo(list) { this.list = list || []; this.n = 0; this.max = 1e9; this.full = 0; }
  Combo.prototype.add = function (matrix, color) {
    var ok = false;
    for (var i = 0; i < this.list.length; i++) {
      if (this.list[i] && this.list[i].add(matrix, color)) ok = true;
    }
    if (ok) this.n++; else this.full++;
    return ok;
  };

  // ==========================================================================
  // THE WEAR CHANNEL, SPENT ON DUST INSTEAD OF WATER.
  //
  // materials.js reads the geometry `color` attribute as a wear mask, white =
  // pristine:
  //     R -> grime      G -> wetness      B -> edge wear (toward `wearColor`)
  //
  // level_bunker.js drives B off an UP-FACING DUST term rather than off polish,
  // because B brightens toward a pale substrate and that is exactly what forty
  // years of settled concrete dust does to a horizontal face.  Every prop in
  // this file matches that contract or it will not sit in the same room as the
  // deck it is standing on:
  //
  //   `dust`  amount of settled film on up-faces        -> B, scaled by ny
  //   `edge`  handled corners, kicked bases, worn lids  -> B, scaled by reach
  //   `grime` finger dirt, oil, soot                    -> R, heaviest low down
  //           and under every overhang
  //   `soak`  ONLY for props standing in the flooded lower level; fades out
  //           over `rise` metres above `loY`.  Above the deck this is 0 and the
  //           facility is dry, which is the whole separation from the metro.
  //
  // NOTE: Geo.mergeAll carries only position/normal/uv, so every merged geometry
  // must be painted AFTER the merge.  Every caller here does.
  // ==========================================================================
  function paintWear(geo, o) {
    var p = geo.attributes.position, n = geo.attributes.normal;
    if (!p || !n) return geo;
    o = o || {};
    var dust = o.dust === undefined ? 0.34 : o.dust;
    var edge = o.edge === undefined ? 0.20 : o.edge;
    var grime = o.grime === undefined ? 0.40 : o.grime;
    var soak = o.soak === undefined ? 0 : o.soak;
    var rise = o.rise === undefined ? 0.55 : o.rise;
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
      // ---- DUST ------------------------------------------------------------
      // Quadratic in `up`: a 45-degree face holds a quarter of what a flat top
      // holds, which is about right, and it keeps the transition off the
      // silhouette edge where a linear term puts a visible band.
      var du = dust * up * up * (0.55 + 0.60 * up);
      // ---- EDGE ------------------------------------------------------------
      // `reach` is distance from the geometry's OWN origin, which is only
      // meaningful for a prop authored around its origin.  A merged static batch
      // is in WORLD space - a cabinet at x = -26 has every vertex 26 m from the
      // origin - so reach saturates to 1 and the whole batch gets maximum edge
      // wear, blending every surface toward the pale substrate.  That is the bug
      // that turned the metro's ticket gates into glowing white bollards.
      // Callers working in world space pass worldOrigin:true.
      var ed;
      if (o.worldOrigin) {
        ed = edge * (0.34 + 0.72 * up);
      } else {
        var reach = M.saturate((Math.sqrt(x * x + z * z) - inner) * 1.6);
        ed = edge * (0.22 + 0.90 * reach) * (0.34 + 0.72 * up);
      }
      // ---- GRIME -----------------------------------------------------------
      var lowness = 1 - M.saturate((y - loY) / Math.max(0.2, hiY - loY));
      var gr = grime * (0.28 + 0.92 * lowness * lowness) * (0.68 + 0.60 * down);
      // ---- WATER, only in the flooded lower level ---------------------------
      var wet = soak > 0 ? soak * (1 - M.smoothstep(loY, loY + rise, y)) : 0;
      if (o.drip) wet += o.drip * up * up;
      if (noise) {
        var nv = noise.fbm3(x * 2.6 + ph, y * 2.6, z * 2.6 - ph, 3, 2.1, 0.55);
        gr = gr * (1 + nv * 0.85);
        du = du * (1 + nv * 0.80);
        ed = ed * (1 + nv * 1.05);
        wet = wet * (1 + nv * 0.30);
      }
      c[i * 3] = M.saturate(1 - gr);
      c[i * 3 + 1] = M.saturate(1 - M.saturate(wet));
      c[i * 3 + 2] = M.saturate(1 - M.saturate(du + ed));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // Per-instance modulation of the same three channels.  Multiplies the vertex
  // mask, so this is jitter and not a second coat: 1.0 leaves a channel alone.
  // On a wear-shaded material this IS the per-instance colour variation - it
  // moves albedo, roughness and Fresnel per instance - and it is why a row of
  // fourteen identical drums does not read as fourteen copies of one drum.
  function wearTint(rng, out) {
    out = out || _col;
    out.setRGB(
      1 - rng.range(0, 0.26),      // grime
      1 - rng.range(0, 0.10),      // wetness (small: the facility is dry)
      1 - rng.range(0, 0.24));     // dust + edge
    return out;
  }

  // A plain albedo multiplier for the local canvas-textured cards (paper,
  // placards, stains).  Those materials have no wear shader, so a WEAR MASK
  // written into their colour attribute would be multiplied straight onto
  // albedo and every page would come back three shades of mud.  This writes an
  // honest, gentle multiplier instead: a little dirtier toward the base.
  function paintCard(geo, noise, base, damp) {
    var p = geo.attributes.position;
    if (!p) return geo;
    base = base === undefined ? 0.90 : base;
    damp = damp === undefined ? 0.22 : damp;
    var c = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      var n = noise ? (noise.fbm3(p.getX(i) * 3.1, y * 3.1, p.getZ(i) * 3.1, 2, 2.1, 0.5) * 0.5 + 0.5) : 0.5;
      var lo = 1 - damp * M.saturate(1 - y * 1.4);
      var v = M.saturate(base * lo * (0.86 + n * 0.28));
      c[i * 3] = v;
      c[i * 3 + 1] = v * (0.99 - 0.03 * (1 - lo));
      c[i * 3 + 2] = v * (0.96 - 0.07 * (1 - lo));
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  }

  // ==========================================================================
  // Local texture kit.
  //
  // Generic surfaces come from ctx.materials by the names the contract fixes.
  // What lives here is props-specific ART the shared library cannot know about:
  // typed log sheets and plotting charts in an invented script, drum and
  // cylinder placards, the dust drift and oil stain patches that let a prop
  // terminate into the floor instead of on a hard line, and the falling-drip
  // streak over the flooded well.
  //
  // The glyphs are CONSTRUCTED STENCIL forms, not text.  A headless capture
  // machine cannot be relied on to have any particular face in whatever the CSS
  // stack lands on, and a sign that renders as tofu boxes on one machine and as
  // text on another is not a sign, it is a lottery.
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

  TX.tex = function (cv, isSRGB, rx, ry, aniso, clamp) {
    if (!cv) return null;
    var t;
    try { t = new THREE.CanvasTexture(cv); } catch (e) { return null; }
    t.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || 1);
    t.anisotropy = Math.max(1, aniso || 1);
    t.needsUpdate = true;
    return t;
  };

  // One constructed stencil letterform on a common baseline, with the bridges a
  // real stencil needs so a closed counter cannot fall out.
  TX.glyph = function (g, x, y, w, h, id) {
    var l = x, r = x + w, t = y, b = y + h;
    var mx = x + w * 0.5, my = y + h * 0.50;
    var br = h * 0.13;
    g.beginPath();
    switch (((id % 11) + 11) % 11) {
      case 0:
        g.moveTo(l, t); g.lineTo(r, t); g.moveTo(r, t + br); g.lineTo(r, b);
        g.moveTo(r - br, b); g.lineTo(l, b); g.moveTo(l, b - br); g.lineTo(l, t + br);
        break;
      case 1:
        g.moveTo(l, t); g.lineTo(l, b);
        g.moveTo(l + br, t); g.lineTo(r, t);
        g.moveTo(l + br, my); g.lineTo(r - w * 0.2, my);
        break;
      case 2:
        g.moveTo(l, b); g.lineTo(mx, t); g.lineTo(r, b);
        g.moveTo(l + w * 0.18, my); g.lineTo(mx - br * 0.5, my);
        g.moveTo(mx + br * 0.5, my); g.lineTo(r - w * 0.18, my);
        break;
      case 3:
        g.moveTo(l, t); g.lineTo(r, t); g.moveTo(mx, t + br); g.lineTo(mx, b);
        break;
      case 4:
        g.moveTo(l, t); g.lineTo(r, t); g.lineTo(l, b); g.lineTo(r, b);
        break;
      case 5:
        g.moveTo(l, t); g.lineTo(l, b - w * 0.2); g.lineTo(l + w * 0.24, b);
        g.lineTo(r - w * 0.24, b); g.lineTo(r, b - w * 0.2); g.lineTo(r, t);
        break;
      case 6:
        g.moveTo(r, t); g.lineTo(l, t); g.lineTo(l, b); g.lineTo(r, b);
        g.moveTo(l + br, my); g.lineTo(r - w * 0.18, my);
        break;
      case 7:
        g.moveTo(l, b); g.lineTo(l, t); g.lineTo(r, b); g.lineTo(r, t);
        break;
      case 8:
        g.moveTo(l, t); g.lineTo(mx, my); g.lineTo(r, t);
        g.moveTo(mx, my + br * 0.4); g.lineTo(mx, b);
        break;
      case 9:
        g.moveTo(l, t); g.lineTo(l, b);
        g.moveTo(l + br, my); g.lineTo(r, t);
        g.moveTo(l + br, my); g.lineTo(r, b);
        break;
      default:
        g.moveTo(l, t); g.lineTo(l, b); g.moveTo(r, t); g.lineTo(r, b);
        g.moveTo(l + br, my); g.lineTo(r - br, my);
        break;
    }
    g.stroke();
  };

  TX.word = function (g, cx, cy2, h, n, rng, weight) {
    var w = h * 0.58, gap = h * 0.30;
    var total = n * w + (n - 1) * gap;
    var x = cx - total * 0.5;
    g.lineWidth = Math.max(1.5, h * (weight || 0.20));
    g.lineCap = 'butt'; g.lineJoin = 'miter';
    for (var i = 0; i < n; i++) {
      TX.glyph(g, x, cy2 - h * 0.5, w, h, rng.int(0, 10));
      x += w + gap;
    }
    return total;
  };

  // Rows of illegible typed body copy.  A log page is 95% texture and 5% legible
  // form, and drawing every character as a glyph both costs a fortune and reads
  // as gibberish; short dashes at type size read as typing at any distance a
  // player will ever see this from.
  TX.copyBlock = function (g, x, y, w, lines, lh, rng, alpha) {
    g.save();
    for (var i = 0; i < lines; i++) {
      var yy = y + i * lh;
      var xx = x;
      var lim = x + w * rng.range(0.55, 1.0);
      while (xx < lim) {
        var ww = rng.range(lh * 0.5, lh * 2.6);
        g.globalAlpha = alpha * rng.range(0.55, 1.0);
        g.fillRect(xx, yy, ww, Math.max(1, lh * 0.32));
        xx += ww + lh * 0.42;
      }
    }
    g.restore();
  };

  TX.erode = function (g, x0, y0, w, h, amount, rng, rmin, rmax) {
    var n = Math.round(w * amount);
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (var i = 0; i < n; i++) {
      g.globalAlpha = rng.range(0.25, 1.0);
      g.beginPath();
      g.arc(x0 + rng.range(0, w), y0 + rng.range(0, h),
        rng.range(rmin || 1, rmax || 5), 0, TAU);
      g.fill();
    }
    g.restore();
  };

  TX.soil = function (g, x0, y0, w, h, amount, rng, colA, colB) {
    g.save();
    for (var i = 0; i < amount; i++) {
      g.globalAlpha = rng.range(0.03, 0.16);
      g.fillStyle = rng.bool() ? colA : colB;
      var r = rng.range(w * 0.03, w * 0.24);
      g.beginPath();
      g.ellipse(x0 + rng.range(0, w), y0 + rng.range(0, h), r, r * rng.range(0.5, 1.4),
        rng.range(0, TAU), 0, TAU);
      g.fill();
    }
    g.restore();
  };

  // ---- paper: 2x2 atlas of sheets, alpha cut to a torn outline ---------------
  TX.paper = function (size, seed) {
    var cv = TX.canvas(size, size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed || 0x9911);
    var h = size * 0.5;
    g.clearRect(0, 0, size, size);

    function sheetShape(ox, oy, w2, hh, ground, tear) {
      // A sheet with a slightly ragged outline: a perfect rectangle at this
      // scale reads as a decal, and every page down here has been trodden on.
      g.save();
      g.beginPath();
      var steps = 22, i;
      var pts = [];
      for (i = 0; i < steps; i++) {
        var t = i / steps;
        pts.push([ox + t * w2, oy + rng.range(-tear, tear)]);
      }
      for (i = 0; i < steps; i++) {
        var t2 = i / steps;
        pts.push([ox + w2 + rng.range(-tear, tear), oy + t2 * hh]);
      }
      for (i = 0; i < steps; i++) {
        var t3 = i / steps;
        pts.push([ox + w2 - t3 * w2, oy + hh + rng.range(-tear, tear)]);
      }
      for (i = 0; i < steps; i++) {
        var t4 = i / steps;
        pts.push([ox + rng.range(-tear, tear), oy + hh - t4 * hh]);
      }
      g.moveTo(pts[0][0], pts[0][1]);
      for (i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillStyle = ground;
      g.fill();
      g.clip();
      return g;
    }

    var pad = size * 0.045;
    var sw = h - pad * 2, shh = h - pad * 2;

    // cell 0: a typed watch log, ruled, with a stamp
    sheetShape(pad, pad, sw, shh, '#d9d4c2', size * 0.006);
    TX.soil(g, pad, pad, sw, shh, 26, rng, '#b8ac8c', '#8d8570');
    g.fillStyle = 'rgba(30,28,24,0.80)';
    TX.copyBlock(g, pad + sw * 0.10, pad + shh * 0.22, sw * 0.78, 13, shh * 0.052, rng, 0.9);
    g.strokeStyle = 'rgba(40,38,32,0.55)'; g.lineWidth = size * 0.004;
    g.beginPath(); g.moveTo(pad + sw * 0.08, pad + shh * 0.17);
    g.lineTo(pad + sw * 0.92, pad + shh * 0.17); g.stroke();
    g.strokeStyle = 'rgba(30,28,24,0.85)';
    TX.word(g, pad + sw * 0.44, pad + shh * 0.10, shh * 0.075, 5, rng, 0.20);
    g.save();
    g.strokeStyle = 'rgba(120,32,26,0.62)'; g.lineWidth = size * 0.008;
    g.translate(pad + sw * 0.70, pad + shh * 0.80); g.rotate(-0.22);
    g.strokeRect(-sw * 0.16, -shh * 0.07, sw * 0.32, shh * 0.14);
    TX.word(g, 0, 0, shh * 0.062, 3, rng, 0.22);
    g.restore();
    TX.erode(g, pad, pad, sw, shh, 0.10, rng, 1, size * 0.012);
    g.restore();

    // cell 1: a plotting chart - graph rule with a pen trace
    sheetShape(h + pad, pad, sw, shh, '#cfcdbb', size * 0.005);
    g.strokeStyle = 'rgba(70,96,86,0.40)'; g.lineWidth = Math.max(1, size * 0.0016);
    var kk;
    for (kk = 0; kk <= 16; kk++) {
      g.beginPath();
      g.moveTo(h + pad + sw * kk / 16, pad); g.lineTo(h + pad + sw * kk / 16, pad + shh);
      g.moveTo(h + pad, pad + shh * kk / 16); g.lineTo(h + pad + sw, pad + shh * kk / 16);
      g.stroke();
    }
    g.strokeStyle = 'rgba(150,40,30,0.85)'; g.lineWidth = Math.max(1.5, size * 0.004);
    g.beginPath();
    var yv = pad + shh * 0.55;
    g.moveTo(h + pad, yv);
    for (kk = 1; kk <= 40; kk++) {
      var tx2 = h + pad + sw * kk / 40;
      yv += rng.range(-shh * 0.035, shh * 0.035);
      if (kk > 26) yv -= shh * 0.020;
      yv = M.clamp(yv, pad + shh * 0.06, pad + shh * 0.94);
      g.lineTo(tx2, yv);
    }
    g.stroke();
    TX.soil(g, h + pad, pad, sw, shh, 20, rng, '#a89c80', '#7d7666');
    TX.erode(g, h + pad, pad, sw, shh, 0.09, rng, 1, size * 0.010);
    g.restore();

    // cell 2: a blueprint / mimic sheet, faded ferroprussiate blue
    sheetShape(pad, h + pad, sw, shh, '#4a6274', size * 0.006);
    g.strokeStyle = 'rgba(226,236,240,0.72)'; g.lineWidth = Math.max(1, size * 0.0022);
    for (kk = 0; kk < 12; kk++) {
      var ax = pad + rng.range(sw * 0.08, sw * 0.80);
      var ay = h + pad + rng.range(shh * 0.10, shh * 0.86);
      var bw = rng.range(sw * 0.10, sw * 0.34), bh2 = rng.range(shh * 0.05, shh * 0.16);
      g.strokeRect(ax, ay, bw, bh2);
      g.beginPath();
      g.moveTo(ax + bw, ay + bh2 * 0.5);
      g.lineTo(ax + bw + rng.range(sw * 0.04, sw * 0.14), ay + bh2 * 0.5);
      g.stroke();
      if (kk % 3 === 0) { g.beginPath(); g.arc(ax + bw * 0.5, ay + bh2 * 0.5, bh2 * 0.32, 0, TAU); g.stroke(); }
    }
    g.strokeStyle = 'rgba(226,236,240,0.85)';
    TX.word(g, pad + sw * 0.5, h + pad + shh * 0.94, shh * 0.060, 6, rng, 0.20);
    TX.soil(g, pad, h + pad, sw, shh, 18, rng, '#2c3d49', '#6d8290');
    TX.erode(g, pad, h + pad, sw, shh, 0.11, rng, 1, size * 0.013);
    g.restore();

    // cell 3: a manila folder / card with a big stencilled index number
    sheetShape(h + pad, h + pad, sw, shh, '#b39a6c', size * 0.007);
    g.fillStyle = 'rgba(120,98,62,0.40)';
    g.fillRect(h + pad, h + pad, sw, shh * 0.12);
    g.strokeStyle = 'rgba(48,40,28,0.80)';
    TX.word(g, h + pad + sw * 0.5, h + pad + shh * 0.46, shh * 0.30, 3, rng, 0.22);
    g.strokeStyle = 'rgba(120,36,28,0.60)'; g.lineWidth = size * 0.005;
    g.beginPath();
    g.moveTo(h + pad + sw * 0.10, h + pad + shh * 0.76);
    g.lineTo(h + pad + sw * 0.90, h + pad + shh * 0.76); g.stroke();
    TX.soil(g, h + pad, h + pad, sw, shh, 22, rng, '#8b7448', '#6a5a3c');
    TX.erode(g, h + pad, h + pad, sw, shh, 0.12, rng, 1, size * 0.014);
    g.restore();

    return cv;
  };

  // ---- marks: 2x2 atlas of placards and stencils ----------------------------
  TX.marks = function (size, seed) {
    var cv = TX.canvas(size, size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed || 0x7733);
    var h = size * 0.5;
    g.clearRect(0, 0, size, size);
    var i;

    // cell 0: radiation trefoil on an ochre ground - the waste drum placard
    g.save();
    g.fillStyle = '#c9a02a';
    g.fillRect(size * 0.03, size * 0.03, h - size * 0.06, h - size * 0.06);
    g.strokeStyle = '#241f14'; g.lineWidth = size * 0.012;
    g.strokeRect(size * 0.05, size * 0.05, h - size * 0.10, h - size * 0.10);
    var tcx = h * 0.5, tcy = h * 0.44, tr = h * 0.28;
    g.fillStyle = '#241f14';
    for (i = 0; i < 3; i++) {
      var a0 = -Math.PI * 0.5 + i * TAU / 3 - 0.52;
      var a1 = a0 + 1.04;
      g.beginPath();
      g.moveTo(tcx, tcy);
      g.arc(tcx, tcy, tr, a0, a1);
      g.closePath(); g.fill();
    }
    g.beginPath(); g.arc(tcx, tcy, tr * 0.22, 0, TAU); g.fill();
    g.strokeStyle = '#241f14'; g.lineWidth = h * 0.014;
    TX.word(g, tcx, h * 0.86, h * 0.10, 5, rng, 0.20);
    TX.soil(g, 0, 0, h, h, 22, rng, '#7a6428', '#3c3420');
    TX.erode(g, 0, 0, h, h, 0.09, rng, 1, size * 0.011);
    g.restore();

    // cell 1: a stencilled transit-case legend, sprayed straight onto timber
    g.save();
    g.strokeStyle = 'rgba(28,26,22,0.88)';
    TX.word(g, h + h * 0.50, h * 0.30, h * 0.16, 6, rng, 0.22);
    TX.word(g, h + h * 0.36, h * 0.56, h * 0.12, 4, rng, 0.22);
    g.lineWidth = size * 0.008;
    g.beginPath();
    g.moveTo(h + h * 0.16, h * 0.72); g.lineTo(h + h * 0.84, h * 0.72); g.stroke();
    // the "this way up" arrows every crate in the world carries
    for (i = 0; i < 2; i++) {
      var axx = h + h * (0.30 + i * 0.40);
      g.beginPath();
      g.moveTo(axx, h * 0.94); g.lineTo(axx, h * 0.78);
      g.moveTo(axx - h * 0.05, h * 0.83); g.lineTo(axx, h * 0.78);
      g.lineTo(axx + h * 0.05, h * 0.83);
      g.stroke();
    }
    TX.erode(g, h, 0, h, h, 0.22, rng, 1, size * 0.014);
    g.restore();

    // cell 2: a gas-cylinder shoulder label, band + legend
    g.save();
    g.fillStyle = '#8f2f24';
    g.fillRect(size * 0.03, h + h * 0.08, h - size * 0.06, h * 0.22);
    g.fillStyle = '#d8d2be';
    g.fillRect(size * 0.03, h + h * 0.38, h - size * 0.06, h * 0.34);
    g.strokeStyle = 'rgba(28,26,22,0.86)';
    TX.word(g, h * 0.5, h + h * 0.55, h * 0.15, 5, rng, 0.22);
    g.strokeStyle = 'rgba(230,226,210,0.90)';
    TX.word(g, h * 0.5, h + h * 0.19, h * 0.10, 4, rng, 0.24);
    TX.soil(g, 0, h, h, h, 20, rng, '#5c5040', '#2e2a22');
    TX.erode(g, 0, h, h, h, 0.13, rng, 1, size * 0.012);
    g.restore();

    // cell 3: hand-painted bay number and a chalked tally - the human mark
    g.save();
    g.strokeStyle = 'rgba(226,220,198,0.80)'; g.lineWidth = size * 0.016;
    g.lineCap = 'round';
    TX.word(g, h + h * 0.5, h + h * 0.40, h * 0.36, 2, rng, 0.24);
    g.lineWidth = size * 0.007;
    for (i = 0; i < 7; i++) {
      var sx2 = h + h * 0.22 + i * h * 0.085;
      g.beginPath();
      g.moveTo(sx2 + rng.range(-2, 2), h + h * 0.70);
      g.lineTo(sx2 + rng.range(-4, 4), h + h * 0.86);
      g.stroke();
    }
    TX.erode(g, h, h, h, h, 0.26, rng, 1, size * 0.016);
    g.restore();

    return cv;
  };

  // ---- grime: 2x2 atlas of ground patches, alpha ----------------------------
  // 0 dust drift  1 oil stain  2 silt/rust ring  3 scuff
  TX.grime = function (size, seed) {
    var cv = TX.canvas(size, size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed || 0x5511);
    var h = size * 0.5;
    g.clearRect(0, 0, size, size);
    var i;

    function blob(cx, cy2, r, col, alpha, squash) {
      g.save();
      g.globalAlpha = alpha;
      var grd = g.createRadialGradient(cx, cy2, 0, cx, cy2, r);
      grd.addColorStop(0, col);
      grd.addColorStop(0.55, col);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(cx, cy2, r, r * (squash || 1), rng.range(0, TAU), 0, TAU);
      g.fill();
      g.restore();
    }

    // 0: pale settled dust, soft, cloudy
    for (i = 0; i < 30; i++) {
      blob(h * 0.5 + rng.gaussian(0, h * 0.15), h * 0.5 + rng.gaussian(0, h * 0.15),
        rng.range(h * 0.10, h * 0.34), 'rgba(206,199,182,0.55)', rng.range(0.18, 0.44),
        rng.range(0.5, 1.3));
    }
    // 1: oil - dark, hard, with a rainbow-free grey rim
    for (i = 0; i < 12; i++) {
      blob(h * 1.5 + rng.gaussian(0, h * 0.13), h * 0.5 + rng.gaussian(0, h * 0.13),
        rng.range(h * 0.08, h * 0.26), 'rgba(26,24,22,0.95)', rng.range(0.35, 0.85),
        rng.range(0.6, 1.5));
    }
    for (i = 0; i < 8; i++) {
      blob(h * 1.5 + rng.gaussian(0, h * 0.20), h * 0.5 + rng.gaussian(0, h * 0.20),
        rng.range(h * 0.04, h * 0.12), 'rgba(52,48,42,0.7)', rng.range(0.2, 0.5), 1);
    }
    // 2: rust / silt ring, an annulus with a soft interior
    g.save();
    for (i = 0; i < 5; i++) {
      g.globalAlpha = rng.range(0.20, 0.45);
      g.strokeStyle = 'rgba(122,74,44,0.85)';
      g.lineWidth = rng.range(h * 0.02, h * 0.07);
      g.beginPath();
      g.ellipse(h * 0.5, h * 1.5, h * rng.range(0.20, 0.34), h * rng.range(0.18, 0.32),
        rng.range(0, TAU), 0, TAU);
      g.stroke();
    }
    g.restore();
    for (i = 0; i < 14; i++) {
      blob(h * 0.5 + rng.gaussian(0, h * 0.14), h * 1.5 + rng.gaussian(0, h * 0.14),
        rng.range(h * 0.06, h * 0.22), 'rgba(96,66,42,0.7)', rng.range(0.12, 0.34),
        rng.range(0.6, 1.4));
    }
    // 3: boot scuff - directional, streaky
    g.save();
    for (i = 0; i < 26; i++) {
      g.globalAlpha = rng.range(0.10, 0.32);
      g.fillStyle = 'rgba(48,45,40,0.9)';
      var ex = h * 1.5 + rng.gaussian(0, h * 0.20);
      var ey = h * 1.5 + rng.gaussian(0, h * 0.16);
      g.beginPath();
      g.ellipse(ex, ey, rng.range(h * 0.06, h * 0.24), rng.range(h * 0.010, h * 0.035),
        rng.range(-0.5, 0.5), 0, TAU);
      g.fill();
    }
    g.restore();
    return cv;
  };

  // ---- drip: a falling thread of water, clamped across, tiling down ---------
  TX.drip = function (w, h, seed) {
    var cv = TX.canvas(w, h);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    var rng = new GAME.RNG(seed || 0x3131);
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    var grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0.0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.44, 'rgba(150,168,178,0.55)');
    grd.addColorStop(0.50, 'rgba(226,238,244,1.0)');
    grd.addColorStop(0.56, 'rgba(150,168,178,0.55)');
    grd.addColorStop(1.0, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    // a broken thread, not a bar: real falling water is beads with gaps
    var y = 0;
    while (y < h) {
      var seg = rng.range(h * 0.03, h * 0.16);
      g.globalAlpha = rng.range(0.30, 1.0);
      g.fillRect(0, y, w, seg);
      y += seg + rng.range(h * 0.02, h * 0.10);
    }
    g.globalAlpha = 1;
    return cv;
  };

  // ---- mote: one soft dust particle -----------------------------------------
  TX.mote = function (size) {
    var cv = TX.canvas(size, size);
    if (!cv) return null;
    var g = cv.getContext('2d');
    if (!g) return null;
    var grd = g.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
    grd.addColorStop(0.0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.30, 'rgba(255,250,238,0.55)');
    grd.addColorStop(1.0, 'rgba(255,250,238,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return cv;
  };

  // ==========================================================================
  // THE KIT.
  //
  // Every builder returns an Item authored around its OWN origin with its base
  // at y = 0, so `_settle` can put it on a measured surface and `paintWear`'s
  // `reach` term means something.  Nothing here is a bare primitive: a box
  // standing in for an object is on the instant-fail list, and in a facility lit
  // by small sources the silhouette detail is what makes a prop read at all.
  // ==========================================================================
  var K = {};

  // ---- 200 litre drum -------------------------------------------------------
  // Lathe, not a cylinder: the rolled hoops and the chime rims are the drum's
  // whole silhouette, and a drum without them is a bin.
  K.drum = function (rng, noise, uvS) {
    var it = new Item();
    var r = 0.291, h = 0.882;
    var g = lathe([
      [0.00, 0.000], [0.255, 0.000], [0.283, 0.022], [0.286, 0.052],
      [0.272, 0.075], [0.272, 0.175],
      [0.291, 0.205], [0.291, 0.255], [0.272, 0.285],   // lower rolling hoop
      [0.272, 0.560],
      [0.291, 0.590], [0.291, 0.640], [0.272, 0.670],   // upper rolling hoop
      [0.272, h - 0.075], [0.286, h - 0.052], [0.283, h - 0.022],
      [0.262, h], [0.230, h - 0.014], [0.00, h - 0.014]
    ], 18, uvS ? r * TAU * uvS : 2.2, uvS ? h * uvS : 1.4);
    it.add('rust', g, null);
    // the two bungs on the head
    it.cyl('rust', 0.042, 0.042, 0.020, 0.150, h - 0.006, 0, 0, 0, 0, 8);
    it.cyl('rust', 0.030, 0.030, 0.018, -0.120, h - 0.006, 0.09, 0, 0, 0, 8);
    // the placard, wired to the upper hoop
    var uv = cellUV(0);
    it.add('marks', card(0.30, 0.30, uv[0], uv[1], uv[2], uv[3]),
      Tn(0, 0.30, r + 0.006, 0, 0, 0));
    return it;
  };

  // ---- timber transit crate -------------------------------------------------
  K.crateW = function (rng, noise, w, h, d) {
    var it = new Item();
    w = w || 0.78; h = h || 0.58; d = d || 0.62;
    var i;
    // boarded faces, with a real gap between boards - a crate is slats, and the
    // dark lines between them are most of what says "timber" at 4 m
    var nb = 4, bw = (h - 0.02) / nb;
    for (i = 0; i < nb; i++) {
      var by = 0.01 + (i + 0.5) * bw;
      it.box('wood', w, bw - 0.012, d, 0, by, 0);
    }
    // corner posts and the cleats
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      it.box('wood', 0.055, h, 0.055, sx * (w * 0.5 - 0.020), h * 0.5, sz * (d * 0.5 - 0.020));
    }
    it.box('wood', w + 0.012, 0.042, 0.055, 0, h * 0.52, d * 0.5 + 0.006);
    it.box('wood', w + 0.012, 0.042, 0.055, 0, h * 0.52, -d * 0.5 - 0.006);
    // the lid, always a shade proud and never quite square
    it.boxR('wood', w + 0.022, 0.034, d + 0.022, 0.004, h + 0.017, 0.003, 0, 0.016, 0.004);
    // strapping
    it.box('rust', w + 0.030, 0.016, 0.008, 0, h * 0.62, d * 0.5 + 0.014);
    it.box('rust', 0.008, 0.016, d + 0.030, w * 0.28, h * 0.62, 0);
    var uv = cellUV(1);
    it.add('marks', card(w * 0.74, w * 0.74 * 0.5, uv[0], uv[1], uv[2], uv[3]),
      Tn(0.02, h * 0.30, d * 0.5 + 0.006));
    return it;
  };

  // ---- olive steel equipment case ------------------------------------------
  K.caseS = function (rng) {
    var it = new Item();
    var w = 0.62, h = 0.34, d = 0.34;
    it.box('green', w, h, d, 0, h * 0.5, 0);
    // the pressed rib that stops a thin steel case oil-canning
    it.box('green', w * 0.62, h * 0.44, d + 0.014, 0, h * 0.52, 0, 0.02);
    // lid rim, hinges, over-centre latches, a rope handle at each end
    it.box('steel', w + 0.014, 0.028, d + 0.014, 0, h - 0.028, 0);
    it.box('steel', 0.10, 0.030, 0.045, -w * 0.26, h - 0.014, -d * 0.5 - 0.010);
    it.box('steel', 0.10, 0.030, 0.045, w * 0.26, h - 0.014, -d * 0.5 - 0.010);
    it.box('steel', 0.075, 0.070, 0.024, -w * 0.24, h - 0.070, d * 0.5 + 0.010);
    it.box('steel', 0.075, 0.070, 0.024, w * 0.24, h - 0.070, d * 0.5 + 0.010);
    it.tube('steel', 0.012, -w * 0.5 - 0.012, h * 0.60, -0.055,
      -w * 0.5 - 0.055, h * 0.52, 0, 6);
    it.tube('steel', 0.012, -w * 0.5 - 0.055, h * 0.52, 0,
      -w * 0.5 - 0.012, h * 0.60, 0.055, 6);
    it.box('steel', 0.04, 0.026, d * 0.7, w * 0.5 + 0.014, h * 0.56, 0);
    return it;
  };

  // ---- sandbag / cement sack ------------------------------------------------
  K.sack = function (rng, noise, seed) {
    var it = new Item();
    var g = sph(0.5, 10, 7).clone();
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // A slumped, over-filled bag: low, waisted at the tied ends, and never
      // circular in section.  Sized to a REAL filled sandbag - about 0.46 long,
      // 0.30 across and 0.17 high.  The first pass had it at 0.70 x 0.43 x 0.32
      // and a revetment of them photographed as a row of pillows: at that size
      // the eye reads them against a 2 m doorway and gets the scale of the whole
      // vestibule wrong.
      var yy = y * 0.44 + 0.5 * 0.44;
      var wob = 1 + noise.fbm3(x * 3.4 + seed, y * 3.4, z * 3.4, 3, 2.1, 0.55) * 0.22;
      var waist = 1 - Math.abs(x) * 0.62;
      p.setXYZ(i, x * 1.02 * wob, yy * (0.72 + 0.60 * waist), z * 0.66 * wob * (0.55 + 0.55 * waist));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.scale(0.455, 0.400, 0.455);
    it.add('fabric', g, null);
    return it;
  };

  // ---- industrial gas cylinder ---------------------------------------------
  K.cylinder = function (rng, uvS) {
    var it = new Item();
    var r = 0.113, h = 1.36;
    var g = lathe([
      [0.00, 0.00], [r - 0.012, 0.00], [r, 0.020], [r, h - 0.34],
      [r - 0.014, h - 0.24], [r * 0.62, h - 0.115], [0.036, h - 0.055],
      [0.034, h - 0.020], [0.00, h - 0.020]
    ], 14, uvS ? r * TAU * uvS : 1.2, uvS ? h * uvS : 1.6);
    it.add('ochre', g, null);
    // the foot ring, the valve, its handwheel, and the neck ring that says
    // "this is a gas cylinder" from across the hall
    it.cyl('ochre', r, r + 0.006, 0.055, 0, 0.027, 0, 0, 0, 0, 14);
    it.cyl('steel', 0.048, 0.048, 0.090, 0, h + 0.020, 0, 0, 0, 0, 10);
    it.cyl('steel', 0.028, 0.028, 0.060, 0.052, h + 0.030, 0, 0, 0, Math.PI * 0.5, 8);
    it.cyl('steel', 0.052, 0.052, 0.014, 0, h + 0.072, 0, 0, 0, 0, 12);
    it.cyl('steel', 0.070, 0.072, 0.030, 0, h - 0.052, 0, 0, 0, 0, 14);
    var uv = cellUV(2);
    it.add('marks', card(0.15, 0.22, uv[0], uv[1], uv[2], uv[3]),
      Tn(0, h - 0.62, r + 0.004));
    return it;
  };

  // ---- fire bucket ----------------------------------------------------------
  K.bucket = function (rng) {
    var it = new Item();
    it.add('red', lathe([
      [0.00, 0.000], [0.108, 0.000], [0.112, 0.012],
      [0.148, 0.276], [0.156, 0.292], [0.150, 0.300], [0.142, 0.284],
      [0.106, 0.020], [0.00, 0.020]
    ], 14, 1.0, 1.0), null);
    it.tube('red', 0.008, -0.150, 0.286, 0, 0, 0.372, 0, 6);
    it.tube('red', 0.008, 0, 0.372, 0, 0.150, 0.286, 0, 6);
    return it;
  };

  // ---- operator swivel chair ------------------------------------------------
  // Five-star base, gas column, tipped-forward seat pan and a sprung back.  It
  // is the single most human object in the control room and a four-legged box
  // would throw that away.
  K.chair = function (rng) {
    var it = new Item();
    var i;
    for (i = 0; i < 5; i++) {
      var a = i / 5 * TAU + 0.3;
      it.tube('steel', 0.018, 0, 0.055, 0, Math.cos(a) * 0.255, 0.032, Math.sin(a) * 0.255, 6);
      it.cyl('rubber', 0.026, 0.026, 0.030, Math.cos(a) * 0.268, 0.028, Math.sin(a) * 0.268,
        Math.PI * 0.5, a, 0, 8);
    }
    it.cyl('steel', 0.030, 0.030, 0.30, 0, 0.200, 0, 0, 0, 0, 10);
    it.cyl('steel', 0.048, 0.048, 0.075, 0, 0.380, 0, 0, 0, 0, 10);
    it.boxR('vinyl', 0.44, 0.070, 0.42, 0, 0.428, 0.010, -0.055, 0, 0);
    it.box('steel', 0.13, 0.045, 0.20, 0, 0.392, -0.13);
    it.strut('steel', 0, 0.400, -0.185, 0, 0.545, -0.235, 0.030, 0.030);
    it.boxR('vinyl', 0.42, 0.40, 0.075, 0, 0.740, -0.250, 0.115, 0, 0);
    return it;
  };

  // ---- waste bin ------------------------------------------------------------
  K.bin = function (rng, noise, seed) {
    var it = new Item();
    var g = lathe([
      [0.00, 0.000], [0.150, 0.000], [0.152, 0.014],
      [0.186, 0.430], [0.192, 0.452], [0.186, 0.462],
      [0.176, 0.446], [0.144, 0.022], [0.00, 0.022]
    ], 14, 1.2, 1.0);
    // A bin that has been kicked down a corridor for thirty years has no
    // circular section left.
    roughen(g, noise, 0.010, 5.5, 'radial');
    it.add('steel', g, null);
    it.cyl('steel', 0.176, 0.176, 0.012, 0, 0.240, 0, 0, 0, 0, 14);
    return it;
  };

  // ---- cantilever toolbox ---------------------------------------------------
  K.toolbox = function (rng) {
    var it = new Item();
    it.box('red', 0.46, 0.155, 0.20, 0, 0.078, 0);
    it.box('red', 0.44, 0.115, 0.185, 0.010, 0.212, 0.012);
    it.box('steel', 0.46, 0.014, 0.20, 0, 0.158, 0);
    it.strut('steel', -0.115, 0.272, 0.012, -0.100, 0.336, 0.012, 0.016, 0.016);
    it.strut('steel', 0.130, 0.272, 0.012, 0.115, 0.336, 0.012, 0.016, 0.016);
    it.tube('steel', 0.011, -0.100, 0.336, 0.012, 0.115, 0.336, 0.012, 6);
    it.box('steel', 0.055, 0.038, 0.014, -0.150, 0.100, 0.102);
    return it;
  };

  // ---- timber pallet --------------------------------------------------------
  K.pallet = function (rng) {
    var it = new Item();
    var i, w = 1.16, d = 0.96;
    for (i = 0; i < 3; i++) {
      it.box('wood', 0.095, 0.075, d, -w * 0.5 + 0.048 + i * (w - 0.096) * 0.5, 0.037, 0);
    }
    for (i = 0; i < 3; i++) {
      it.box('wood', w, 0.022, 0.115, 0, 0.086, -d * 0.5 + 0.058 + i * (d - 0.116) * 0.5);
    }
    for (i = 0; i < 5; i++) {
      it.box('wood', w, 0.020, 0.105, 0, 0.108, -d * 0.5 + 0.052 + i * (d - 0.104) * 0.25);
    }
    return it;
  };

  // ---- cable drum -----------------------------------------------------------
  K.reel = function (rng, noise) {
    var it = new Item();
    var R = 0.46, hw = 0.24;
    it.cyl('wood', R, R, 0.045, 0, R, -hw, Math.PI * 0.5, 0, 0, 18);
    it.cyl('wood', R, R, 0.045, 0, R, hw, Math.PI * 0.5, 0, 0, 18);
    it.cyl('wood', 0.145, 0.145, hw * 2, 0, R, 0, Math.PI * 0.5, 0, 0, 12);
    // the wound cable itself: three coarse turns so the drum reads as loaded
    for (var i = 0; i < 3; i++) {
      it.cyl('cable', 0.145 + 0.055 + i * 0.052, 0.145 + 0.055 + i * 0.052,
        hw * 2 - 0.055 - i * 0.030, 0, R, 0, Math.PI * 0.5, 0, 0, 14);
    }
    // radial cleats on the cheeks, and the cut end hanging off
    for (var k = 0; k < 6; k++) {
      var a = k / 6 * TAU;
      it.strut('wood', Math.cos(a) * 0.16, R + Math.sin(a) * 0.16, -hw - 0.024,
        Math.cos(a) * (R - 0.05), R + Math.sin(a) * (R - 0.05), -hw - 0.024, 0.036, 0.020);
    }
    it.sag('cable', 0.20, R + 0.30, hw * 0.4, 0.62, 0.03, hw * 0.8, 0.16, 0.016, 5);
    return it;
  };

  // ---- 20 litre jerrycan ----------------------------------------------------
  K.jerrycan = function (rng) {
    var it = new Item();
    var w = 0.165, h = 0.465, d = 0.345;
    it.box('green', w, h, d, 0, h * 0.5, 0, 0.020);
    // the three-handle top and the pressed X panels are the only reason a
    // jerrycan is recognisable at all
    it.box('green', w * 0.62, 0.026, d * 0.86, 0, h + 0.010, 0);
    it.box('steel', 0.028, 0.045, 0.115, 0, h + 0.030, -0.100);
    it.box('steel', 0.028, 0.045, 0.115, 0, h + 0.030, 0);
    it.box('steel', 0.028, 0.045, 0.115, 0, h + 0.030, 0.100);
    it.cyl('steel', 0.038, 0.038, 0.030, 0, h + 0.020, 0.128, 0, 0, 0, 10);
    for (var s = -1; s <= 1; s += 2) {
      it.boxR('green', 0.006, 0.30, 0.020, s * (w * 0.5 + 0.002), h * 0.52, 0.055, 0, 0, 0.72);
      it.boxR('green', 0.006, 0.30, 0.020, s * (w * 0.5 + 0.002), h * 0.52, -0.055, 0, 0, -0.72);
    }
    return it;
  };

  // ---- fire extinguisher ----------------------------------------------------
  K.extinguisher = function (rng) {
    var it = new Item();
    var r = 0.082, h = 0.52;
    it.add('red', lathe([
      [0.00, 0.000], [r - 0.008, 0.006], [r, 0.026], [r, h - 0.10],
      [r * 0.80, h - 0.030], [0.030, h], [0.028, h + 0.014], [0.00, h + 0.014]
    ], 12, 1.0, 1.2), null);
    it.cyl('steel', 0.036, 0.036, 0.055, 0, h + 0.040, 0, 0, 0, 0, 8);
    it.box('steel', 0.020, 0.016, 0.090, 0, h + 0.072, 0.028);
    it.tube('steel', 0.012, 0.030, h + 0.052, 0, 0.088, h * 0.72, 0.03, 6);
    it.sag('rubber', 0.088, h * 0.72, 0.03, 0.045, h * 0.30, r + 0.020, 0.10, 0.011, 4);
    it.cyl('steel', 0.026, 0.020, 0.075, 0.045, h * 0.30, r + 0.030, Math.PI * 0.42, 0, 0, 8);
    return it;
  };

  // ---- loose timber ---------------------------------------------------------
  K.plank = function (rng, noise, seed) {
    var it = new Item();
    var g = bx(1.55, 0.038, 0.145, 0.006).clone();
    roughen(g, noise, 0.010, 2.4);
    it.add('wood', g, Tn(0, 0.019, 0));
    return it;
  };

  // ---- loose pipe length ----------------------------------------------------
  K.pipeLen = function (rng) {
    var it = new Item();
    it.cyl('rust', 0.058, 0.058, 1.42, 0, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('rust', 0.074, 0.074, 0.055, -0.70, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('rust', 0.074, 0.074, 0.055, 0.70, 0.058, 0, 0, 0, Math.PI * 0.5, 10);
    return it;
  };

  // ---- spalled concrete -----------------------------------------------------
  K.chunk = function (rng, noise, seed) {
    var it = new Item();
    var g = sph(0.5, 8, 6).clone();
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var n = noise.fbm3(x * 4.2 + seed, y * 4.2, z * 4.2, 3, 2.2, 0.55);
      // faceted, not lumpy: fractured concrete breaks on planes
      var q = 1 + n * 0.42;
      p.setXYZ(i, Math.round(x * q * 7) / 7, Math.round(y * q * 6) / 6 * 0.62,
        Math.round(z * q * 7) / 7);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.scale(0.42, 0.42, 0.42);
    g.translate(0, 0.13, 0);
    it.add('concrete', g, null);
    return it;
  };

  // ---- a drift of dust and fines --------------------------------------------
  // This is the level's most important prop and it is not an object.  Dust
  // settling out of still air for forty years builds a soft wedge against every
  // vertical face, and it is the one thing that stops every prop and every wall
  // in the facility terminating on a hard line against the floor.  Authored
  // wide, low and asymmetric, with its steep face on -Z so a caller can yaw it
  // into a wall.
  K.drift = function (rng, noise, seed) {
    var it = new Item();
    var nx = 12, nz = 6;
    var pos = [], i, j;
    var grid = [];
    for (j = 0; j <= nz; j++) {
      grid[j] = [];
      for (i = 0; i <= nx; i++) {
        var u = i / nx, v = j / nz;
        var along = Math.sin(u * Math.PI);
        var prof = Math.pow(1 - v, 1.65);
        var n = noise.fbm2(u * 3.4 + seed, v * 2.2 - seed, 3) * 0.5 + 0.5;
        var hh = along * prof * (0.55 + 0.75 * n);
        grid[j][i] = [(u - 0.5) * 2.0, hh * 0.22, v * 0.78];
      }
    }
    for (j = 0; j < nz; j++) {
      for (i = 0; i < nx; i++) {
        var a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
        // WINDING.  (a,b,c) with i running +x and j running +z gives a normal
        // pointing DOWN, which renders the whole drift as an unlit black wedge
        // lying against the wall - and because it is the substrate colour that
        // is meant to be doing the work, a black one is worse than none at all.
        // (a,d,c)+(a,c,b) is the same two triangles wound the other way.
        pos.push(a[0], a[1], a[2], d[0], d[1], d[2], c[0], c[1], c[2]);
        pos.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
    g.computeVertexNormals();
    it.add('concrete', g, null);
    return it;
  };

  // ---- canvas kit bag -------------------------------------------------------
  K.bagKit = function (rng, noise, seed) {
    var it = new Item();
    var g = sph(0.5, 12, 8).clone();
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var taper = 1 - Math.abs(x) * 0.55;
      var n = noise.fbm3(x * 4.0 + seed, y * 4.0, z * 4.0, 3, 2.1, 0.55);
      p.setXYZ(i, x * 1.55, (y * 0.52 + 0.52) * (0.75 + 0.35 * taper) * (1 + n * 0.16),
        z * 0.60 * taper * (1 + n * 0.20));
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    g.scale(0.42, 0.42, 0.44);
    it.add('fabric', g, null);
    // the strap, lying where it fell
    it.sag('fabric', -0.24, 0.18, 0.12, 0.24, 0.18, 0.12, -0.16, 0.020, 5);
    return it;
  };

  // ---- ring binder / file stack ---------------------------------------------
  K.binder = function (rng) {
    var it = new Item();
    var n = 2 + (rng.int(0, 2));
    var y = 0;
    for (var i = 0; i < n; i++) {
      var t = 0.045 + rng.range(0, 0.026);
      it.boxR('cream', 0.30, t, 0.235, rng.range(-0.02, 0.02), y + t * 0.5,
        rng.range(-0.02, 0.02), 0, rng.range(-0.22, 0.22), 0, 0.004);
      y += t;
    }
    return it;
  };

  // ---- enamel mug / tin -----------------------------------------------------
  K.cup = function (rng) {
    var it = new Item();
    it.add('cream', lathe([
      [0.00, 0.000], [0.038, 0.000], [0.040, 0.008],
      [0.043, 0.092], [0.045, 0.098], [0.041, 0.100], [0.038, 0.010], [0.00, 0.010]
    ], 12, 1, 1), null);
    it.tube('cream', 0.006, 0.045, 0.078, 0, 0.070, 0.062, 0, 5);
    it.tube('cream', 0.006, 0.070, 0.062, 0, 0.070, 0.030, 0, 5);
    it.tube('cream', 0.006, 0.070, 0.030, 0, 0.045, 0.020, 0, 5);
    return it;
  };

  // ---- steel locker ---------------------------------------------------------
  K.locker = function (rng) {
    var it = new Item();
    var w = 0.38, h = 1.82, d = 0.46;
    it.box('green', w, h, d, 0, h * 0.5, 0, 0.008);
    // legs, so the base is off the floor and reads as a locker rather than a
    // wardrobe-shaped block
    it.box('steel', 0.035, 0.11, 0.035, -w * 0.5 + 0.035, 0.055, -d * 0.5 + 0.035);
    it.box('steel', 0.035, 0.11, 0.035, w * 0.5 - 0.035, 0.055, -d * 0.5 + 0.035);
    it.box('steel', 0.035, 0.11, 0.035, -w * 0.5 + 0.035, 0.055, d * 0.5 - 0.035);
    it.box('steel', 0.035, 0.11, 0.035, w * 0.5 - 0.035, 0.055, d * 0.5 - 0.035);
    // door: recessed panel, louvres, hasp and a slam handle
    it.box('green', w - 0.05, h - 0.30, 0.020, 0, h * 0.5 + 0.02, d * 0.5 + 0.010, 0.006);
    for (var i = 0; i < 4; i++) {
      it.boxR('steel', w - 0.14, 0.016, 0.020, 0, h - 0.22 - i * 0.055, d * 0.5 + 0.020,
        0.42, 0, 0);
    }
    it.box('steel', 0.030, 0.115, 0.026, w * 0.5 - 0.070, h * 0.55, d * 0.5 + 0.024);
    it.box('steel', 0.048, 0.036, 0.020, w * 0.5 - 0.070, h * 0.55 - 0.10, d * 0.5 + 0.022);
    it.box('steel', w, 0.024, d, 0, h + 0.012, 0);
    return it;
  };

  // ---- coiled hose ----------------------------------------------------------
  K.hoseCoil = function (rng, noise, seed) {
    var it = new Item();
    var turns = 3, seg = 13;
    for (var t = 0; t < turns; t++) {
      var R = 0.30 + t * 0.075;
      var yy = 0.028 + (turns - 1 - t) * 0.008;
      var px = null, pz = null;
      for (var i = 0; i <= seg; i++) {
        var a = i / seg * TAU * 1.02;
        var wob = 1 + noise.fbm2(a * 1.6 + seed + t, t * 3.1, 2) * 0.11;
        var x = Math.cos(a) * R * wob, z = Math.sin(a) * R * wob;
        if (px !== null) it.tube('rubber', 0.026, px, yy, pz, x, yy, z, 6);
        px = x; pz = z;
      }
    }
    // the cut end, thrown out of the coil
    it.snake('rubber', 0.44, 0.02, 1.05, -0.34, 0.002, 0.026, 0.10, noise, seed, 4);
    it.cyl('steel', 0.034, 0.034, 0.070, 1.05, 0.028, -0.34, 0, 0, Math.PI * 0.5, 8);
    return it;
  };

  // ---- barrier stand --------------------------------------------------------
  K.barrier = function (rng) {
    var it = new Item();
    it.add('ochre', lathe([
      [0.00, 0.000], [0.180, 0.000], [0.186, 0.020], [0.150, 0.056],
      [0.052, 0.078], [0.042, 0.110], [0.040, 0.94], [0.046, 0.96],
      [0.030, 0.985], [0.00, 0.985]
    ], 12, 1, 1), null);
    it.cyl('ochre', 0.044, 0.044, 0.020, 0, 0.72, 0, 0, 0, 0, 12);
    it.cyl('steel', 0.052, 0.052, 0.024, 0, 0.90, 0, 0, 0, 0, 12);
    // the chain, hanging from the eye - a barrier post with no chain on it is
    // a bollard
    it.sag('steel', 0, 0.90, 0.045, 0, 0.90, 0.78, 0.16, 0.011, 5);
    return it;
  };

  // ==========================================================================
  // GAME.PropsBunker
  // ==========================================================================
  function PropsBunker(ctx) {
    this.ctx = ctx || {};
    this.root = new THREE.Object3D();
    this.root.name = 'props_bunker';
    this.root.matrixAutoUpdate = false;
    this.colliders = [];

    // Deterministic and independent of every other system's stream, so adding a
    // lamp somewhere else cannot reshuffle the gallery.
    var seed = ((this.ctx.seed || 20260801) ^ 0x424E4B52) >>> 0;
    this.rng = new GAME.RNG(seed);
    this.noise = new GAME.Noise((seed ^ 0x1F35A7C3) >>> 0);

    this.time = 0;
    // The ventilation draught.  A buried facility on standby still has one
    // fan running somewhere, and this is the only air movement in a level with
    // no weather at all.
    this.draught = 0.30;
    this.windDir = new THREE.Vector2(1, 0);

    this.tex = {};
    this.mats = {};
    this.B = {};
    this.S = {
      steel: [], rust: [], wood: [], concrete: [], plastic: [], rubber: [],
      cable: [], fabric: [], canvas: [], grate: [], red: [], green: [],
      cream: [], ochre: [], vinyl: [], glass: [], paper: [], marks: [], grime: []
    };
    this._occ = new Map();
    this._qout = [];
    // Every Batch ever created, in creation order.  `this.B` holds Combos as
    // well as Batches and a Combo carries no mesh, so _commit walks THIS list
    // rather than this.B - a Combo's member batches would otherwise never be
    // finished and the whole instanced half of the set would silently vanish.
    this._batches = [];
    this._skipped = 0;
    // Why a placement was refused, by cause.  A skip is silent by design - _drop
    // just returns null - so without this the only symptom of a pass that placed
    // nothing is a batch count of zero, and no way at all to tell a reserved
    // walking line from a collider clash.  Reported under ?propsdbg=1.
    this._reject = { bounds: 0, lens: 0, occ: 0, blocked: 0, full: 0 };
    this._keepOut = [];
    this._drapes = [];
    this._rings = [];
    this._dripParts = [];
    this._grimeCount = 0;
    this._paperCount = 0;
    this._moteData = null;

    this.stats = { instances: 0, drawCalls: 0, tris: 0, colliders: 0, skipped: 0, full: [] };

    // ---- anchor fallbacks --------------------------------------------------
    // These are level_bunker.js's own published numbers.  They exist so a level
    // that failed to build does not take the props pass down with it - never as
    // a source of truth.  Every one is overwritten in _probeLayout when the
    // anchors are there.
    this.deckY = 0.0;
    this.spine = { x0: -33, x1: 9, hz: 1.95, y: 0, ceil: 2.86, beamPitch: 2.60,
      doorsX: [-32.6, -3.2, 8.4], markerY: 0.34, trayZ: 1.61 };
    this.vest = { x0: -46, x1: -33, hz: 6.60, y: 0, ceil: 5.40,
      cabin: { x0: -43.4, x1: -38.6, y: 2.95, z: 5.05 },
      decon: [], approach: { x0: -55, x1: -47, hz: 2.90, collapse: null } };
    this.blast = { plane: -45.4, w: 5.0, h: 4.3, thick: 1.35, openZ: 2.92 };
    this.ctl = { x0: -30, x1: -13.6, z0: 4.6, z1: 17.4, floorY: 0.30, ceil: 3.70,
      consoles: [], voidPanels: [], racks: null, doorway: null,
      statusWall: { z: 17.3, x0: -28.6, x1: -15.4 } };
    this.plant = { x0: -12.5, x1: -3.5, z0: -8.6, z1: -1.95, y: 0, ceil: 3.20,
      cabinets: [], transformer: null, ahu: null };
    this.hall = { x0: 9, x1: 37, hz: 13.2, deckY: 0, ceil: 11.0,
      wellX0: 14.4, wellX1: 33.6, wellZ0: -9.6, wellZ1: 9.6, heatExchangers: [] };
    this.reactor = { centre: new THREE.Vector3(24, 0, 0), bioR: 5.5, bioTop: 1.10,
      platR0: 5.65, platR1: 7.60, gantryY: 5.70, gantryR0: 6.20, gantryR1: 8.40,
      craneY: 9.70, craneX: 27.40, bridges: [] };
    this.lower = { floorY: -4.60, waterY: -4.02, x0: 14.4, x1: 33.6, z0: -9.6, z1: 9.6,
      innerR: 5.5, stair: null, sump: null, pumps: [] };
    this.lamps = [];
    this.shafts = [];
    this.bounds = { x0: -57, x1: 39, z0: -15.5, z1: 19.5 };
    this.waterY = -4.02;

    try { if (this.ctx.scene) this.ctx.scene.add(this.root); }
    catch (e) { GAME.logError('propsB.ctor', e); }
  }

  PropsBunker.prototype._phase = function (name, fn) {
    try { fn.call(this); } catch (e) { GAME.logError('propsB.' + name, e); }
    return GAME.yieldFrame();
  };

  PropsBunker.prototype.build = async function (ctx) {
    if (ctx) this.ctx = ctx;
    await this._phase('textures', this._initTextures);
    await this._phase('materials', this._initMaterials);
    await this._phase('layout', this._probeLayout);
    await this._phase('kit', this._buildKit);
    // THE WORK SITE FIRST.  The gang's plant needs three clear metres on the
    // west deck and it is the level's story; running it after the general
    // clutter had filled the deck band meant the welding set and the tower
    // simply never landed.
    await this._phase('worksite', this._dressWorkSite);
    await this._phase('hall', this._dressHall);
    await this._phase('platform', this._dressPlatform);
    await this._phase('pit', this._dressPit);
    await this._phase('spine', this._dressSpine);
    await this._phase('control', this._dressControl);
    await this._phase('plant', this._dressPlant);
    await this._phase('vestibule', this._dressVestibule);
    await this._phase('approach', this._dressApproach);
    await this._phase('drift', this._dressDrift);
    await this._phase('water', this._dressWater);
    await this._phase('motes', this._dressMotes);
    await this._phase('commit', this._commit);
    clearCaches();
    return this;
  };

  // --------------------------------------------------------------------------
  // Textures
  // --------------------------------------------------------------------------
  PropsBunker.prototype._initTextures = function () {
    var t = this.tex;
    var aniso = 8;
    try {
      if (this.ctx.renderer && this.ctx.renderer.capabilities) {
        aniso = Math.min(8, this.ctx.renderer.capabilities.getMaxAnisotropy() || 8);
      }
    } catch (e) { /* headless */ }
    this._aniso = aniso;
    t.paper = TX.tex(TX.paper(512, 0x9911), true, 1, 1, aniso, true);
    t.marks = TX.tex(TX.marks(512, 0x7733), true, 1, 1, aniso, true);
    t.grime = TX.tex(TX.grime(512, 0x5511), true, 1, 1, aniso, true);
    t.drip = TX.tex(TX.drip(64, 256, 0x3131), true, 1, 1, aniso);
    if (t.drip) { t.drip.wrapS = THREE.ClampToEdgeWrapping; t.drip.wrapT = THREE.RepeatWrapping; }
    t.mote = TX.tex(TX.mote(32), true, 1, 1, 1, true);
  };

  // --------------------------------------------------------------------------
  // Materials
  //
  // Everything from the library is CLONED - mutating a cached library material
  // would corrupt it for level_bunker.js and every other consumer.
  //
  // Two things are declared on every prop material and they are what make the
  // set read as one dry, dusty facility rather than a kit of objects standing
  // in one: `wearColor` (the substrate the B channel exposes) is a PALE
  // CONCRETE DUST rather than the library's bare-metal default, because down
  // here B is spent on settled dust and not on polish; and metalness is capped
  // (see the file header).
  // --------------------------------------------------------------------------
  PropsBunker.prototype._material = function (name, opts) {
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
    mat.name = 'bk_' + name;
    return mat;
  };

  var FALLBACK_SPEC = {
    painted_metal: [0x7b8288, 0.54, 0.24],
    rusted_metal: [0x6e4736, 0.82, 0.18],
    wood_plank: [0x6f6152, 0.92, 0.0],
    concrete: [0x8a877e, 0.94, 0.0],
    plastic: [0x8a8578, 0.55, 0.0],
    rubber: [0x2a2c2d, 0.86, 0.0],
    sandbag: [0x7d7663, 0.95, 0.0],
    fabric: [0x7d7663, 0.95, 0.0],
    canvas_awning: [0x6b6552, 0.94, 0.0],
    steel_grate: [0x4c4944, 0.70, 0.26],
    structural_steel: [0x6a6e72, 0.62, 0.14],
    glass: [0x3a4246, 0.16, 0.0]
  };

  PropsBunker.prototype._fallbackMaterial = function (name, opts) {
    var s = FALLBACK_SPEC[name] || FALLBACK_SPEC.painted_metal;
    var m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHex(s[0], THREE.SRGBColorSpace),
      roughness: s[1], metalness: s[2], envMapIntensity: 1.0
    });
    // No wear shader on this path, so a wear MASK would be multiplied straight
    // onto albedo and every prop would come out three shades too dark.
    if (opts && opts.side !== undefined) m.side = opts.side;
    if (opts && opts.alphaTest !== undefined) m.alphaTest = opts.alphaTest;
    return m;
  };

  PropsBunker.prototype._initMaterials = function () {
    var m = this.mats;
    function W(extra) {
      var o = { vertexColors: true, wearMode: 'wear' };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return o;
    }
    // THE SUBSTRATE.  B exposes this, and down here B is DUST, so it is a pale
    // concrete grey on everything rather than the library's bare-metal silver.
    // Bright bare metal on the top face of every drum in a sealed facility is
    // exactly wrong: nothing has been polished in here since 1986.
    var SUB_DUST = 0xa8a294;
    var SUB_TIMBER = 0x8d8371;

    // ---- METALNESS IS CAPPED LOW, AND IT IS NOT AN ARTISTIC CHOICE ---------
    // sky is 'none': the probe irradiance is about 0.02 and every photon comes
    // from a handful of small local sources.  A metal returns almost nothing but
    // its environment, so painted steel at 0.55 photographs as a black block
    // with no readable form.  0.10-0.26 hands the surface back to the diffuse
    // term, which the practicals CAN light.
    m.steel = this._material('painted_metal',
      W({ albedoTarget: 0x8d9498, roughness: 0.50, metalness: 0.24, wearColor: SUB_DUST }));
    m.rust = this._material('rusted_metal',
      W({ albedoTarget: 0x7a533e, roughness: 0.82, metalness: 0.18, wearColor: 0x9c8b74 }));
    m.wood = this._material('wood_plank',
      W({ albedoTarget: 0x776854, roughness: 0.93, wearColor: SUB_TIMBER }));
    m.concrete = this._material('concrete',
      W({ albedoTarget: 0x8e8a80, roughness: 0.94, wearColor: SUB_DUST }));
    m.plastic = this._material('plastic',
      W({ albedoTarget: 0x8a8578, roughness: 0.56, wearColor: SUB_DUST }));
    m.rubber = this._material('rubber',
      W({ albedoTarget: 0x2e3032, roughness: 0.88, wearColor: 0x6d6a64 }));
    m.cable = this._material('rubber',
      W({ albedoTarget: 0x262a2e, roughness: 0.90, wearColor: 0x6d6a64 }));
    // Deliberately a shade darker than a clean sandbag: the revetment stands in
    // the vestibule flood's hot pool, which is the one part of this level that
    // was already clipping before a single prop was placed.
    m.fabric = this._material('sandbag',
      W({ albedoTarget: 0x6f6656, roughness: 0.96, wearColor: 0x8a8272 }));
    m.canvas = this._material('canvas_awning',
      W({ albedoTarget: 0x6d6754, roughness: 0.95, wearColor: 0x968f7c }));
    m.grate = this._material('steel_grate',
      W({ side: THREE.DoubleSide, alphaTest: 0.5, metalness: 0.24 }));
    // ---- THE FACILITY PALETTE, DELIBERATELY FOUR COLOURS -------------------
    // Oxide red is the level's own dado; institutional grey-green is what every
    // case, cabinet and locker in a cold-war facility is; bone cream is the
    // signage ground and the files; hazard ochre is the gas and waste stock -
    // and in a frame that is otherwise grey concrete and red alarm it is the
    // ONLY warm saturated accent.  A grey cylinder under a fluorescent
    // photographs as a lump of nothing.
    m.red = this._material('painted_metal',
      W({ albedoTarget: 0x93402f, roughness: 0.56, metalness: 0.12, wearColor: SUB_DUST }));
    m.green = this._material('painted_metal',
      W({ albedoTarget: 0x56624a, roughness: 0.62, metalness: 0.12, wearColor: SUB_DUST }));
    m.cream = this._material('painted_metal',
      W({ albedoTarget: 0xbfb7a1, roughness: 0.58, metalness: 0.06, wearColor: 0xcac2ad }));
    m.ochre = this._material('painted_metal',
      W({ albedoTarget: 0xa8842e, roughness: 0.58, metalness: 0.10, wearColor: SUB_DUST }));
    // Chair upholstery is the one soft-goods surface in the control room and it
    // is NOT painted_metal: that base is a chipped enamel, and on a 0.42 m seat
    // pan its chip pattern reads as military camouflage rather than as worn
    // vinyl - which is exactly what the first interior capture came back with.
    // `plastic` is a smooth polymer sheet, metal 0, so it also cannot go black
    // under a dead probe.
    m.vinyl = this._material('plastic',
      W({ albedoTarget: 0x515c48, roughness: 0.60, metalness: 0.0, wearColor: 0x8f8b7d }));

    try {
      m.glass = (this.ctx.materials && this.ctx.materials.glass)
        ? this.ctx.materials.glass({ tint: 0x39423f, roughness: 0.18 })
        : null;
    } catch (e) { m.glass = null; }
    if (!m.glass) {
      m.glass = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHex(0x39423f, THREE.SRGBColorSpace),
        roughness: 0.20, metalness: 0.08, envMapIntensity: 1.2
      });
    }

    // ---- local canvas art ---------------------------------------------------
    m.paper = new THREE.MeshStandardMaterial({
      map: this.tex.paper || null, color: 0xffffff,
      roughness: 0.90, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, alphaTest: 0.34, envMapIntensity: 0.9
    });
    m.paper.shadowSide = THREE.DoubleSide;
    m.paper.name = 'bk_paper';

    m.marks = new THREE.MeshStandardMaterial({
      map: this.tex.marks || null, color: 0xffffff,
      roughness: 0.62, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, alphaTest: 0.34, envMapIntensity: 1.0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    m.marks.name = 'bk_marks';

    // Ground patches: dust drift, oil, silt ring, scuff.  They lie ON the deck,
    // so they must not write depth or they z-fight the level's own slab.
    m.grime = new THREE.MeshStandardMaterial({
      map: this.tex.grime || null, color: 0xffffff,
      roughness: 0.88, metalness: 0.0, vertexColors: true,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      alphaTest: 0.02, envMapIntensity: 0.9,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    m.grime.name = 'bk_grime';

    // Falling water, additive and faint.  A drip lit by a failing fluorescent is
    // a highlight on a thread of water, never a white bar.
    m.drip = new THREE.MeshBasicMaterial({
      map: this.tex.drip || null, color: 0x8ea4b0,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, opacity: 0.50, fog: true
    });
    m.drip.name = 'bk_drip';

    m.ripple = new THREE.MeshBasicMaterial({
      map: this.tex.grime || null, color: 0x6f7c84,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, opacity: 0.22, fog: true
    });
    m.ripple.name = 'bk_ripple';

    // DUST IN THE BEAMS.  The brief asks for it by name and it is the one thing
    // in the level that says the air itself is dirty.  Additive, tone-mapped OFF
    // so the composite curve cannot crush it, and deliberately dim: motes are a
    // suggestion of a volume, and at any real brightness they read as snow.
    m.mote = new THREE.PointsMaterial({
      map: this.tex.mote || null, color: 0xbfae92, size: 0.055,
      sizeAttenuation: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.42, fog: true,
      vertexColors: true
    });
    m.mote.toneMapped = false;
    m.mote.name = 'bk_mote';
  };

  // --------------------------------------------------------------------------
  // Layout: read the level's published survey.  Nothing here reads a camera pose
  // except _keepOut, which is a keep-out list and never a placement.
  // --------------------------------------------------------------------------
  PropsBunker.prototype._probeLayout = function () {
    var lv = this.ctx.level;
    var A = (lv && lv.anchors) || null;
    this.A = A;
    var i;

    function has(o) { return !!(o && typeof o === 'object'); }

    if (A) {
      if (has(A.spine)) this.spine = A.spine;
      if (has(A.vestibule)) this.vest = A.vestibule;
      if (has(A.blastDoor)) this.blast = A.blastDoor;
      if (has(A.control)) this.ctl = A.control;
      if (has(A.plant)) this.plant = A.plant;
      if (has(A.hall)) this.hall = A.hall;
      if (has(A.reactor)) this.reactor = A.reactor;
      if (has(A.lower)) this.lower = A.lower;
      if (A.lamps && A.lamps.length) this.lamps = A.lamps;
    }
    if (lv && lv.lightShafts && lv.lightShafts.length) this.shafts = lv.lightShafts;
    if (lv && lv.waterPlane && isFinite(lv.waterPlane.y)) this.waterY = lv.waterPlane.y;
    else if (this.lower && isFinite(this.lower.waterY)) this.waterY = this.lower.waterY;
    this.deckY = isFinite(this.hall.deckY) ? this.hall.deckY : 0;

    this.bounds = {
      x0: (this.vest.approach ? this.vest.approach.x0 : this.vest.x0) - 2,
      x1: this.hall.x1 + 2,
      z0: -this.hall.hz - 2,
      z1: Math.max(this.hall.hz, this.ctl.z1) + 2
    };

    // Broadphase over the level's colliders so nothing lands inside a console,
    // a heat exchanger, the bioshield or a blast door leaf.
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
    } catch (e) { GAME.logError('propsB.hash', e); this.hash = null; }

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
        this._keepOut.push({ x: p.position.x, z: p.position.z, r: 1.35 });
      }
      var sp = (lv && lv.spawnPoints) || null;
      if (sp) {
        for (i = 0; i < sp.length; i++) {
          if (sp[i] && sp[i].position) {
            this._keepOut.push({ x: sp[i].position.x, z: sp[i].position.z, r: 0.90 });
          }
        }
      }
    } catch (e2) { /* poses are optional */ }
  };

  // --------------------------------------------------------------------------
  // Placement primitives
  // --------------------------------------------------------------------------

  // The facility's floors are analytic and the level publishes them, so
  // sampleGround is both cheaper and more accurate than a ray.
  PropsBunker.prototype._ground = function (x, z) {
    var lv = this.ctx.level;
    if (lv && lv.sampleGround) {
      try {
        var s = lv.sampleGround(x, z);
        if (isFinite(s)) return s;
      } catch (e) { /* fall through */ }
    }
    if (this.hall && this.hall.groundY) {
      try {
        var g = this.hall.groundY(x, z);
        if (isFinite(g)) return g;
      } catch (e2) { /* fall through */ }
    }
    return this.deckY;
  };

  PropsBunker.prototype._rayGround = function (x, z, fromY, maxDist, fallback) {
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

  // ---- SETTLING -------------------------------------------------------------
  // Measure the ground gradient across the PROP'S OWN FOOTPRINT and return the
  // tilt that lands every corner of the base on the surface.  A crate dropped
  // level on a slab that has settled 9 cm across the gallery floats its downhill
  // edge, and at 3 m that gap is the first thing the eye finds.
  //
  // The two subtleties that make this work rather than make it worse:
  //   * samples are taken at the prop's OWN radius, not at a fixed offset, so a
  //     0.3 m toolbox reads the 13 mm slab joint it is standing across and a
  //     1.6 m pallet correctly ignores it;
  //   * a sample more than `lim` from the centre is DISCARDED.  The gallery
  //     floor drops 4.6 m at the well kerb and 0.3 m at the control-room
  //     threshold; without the guard, a drum standing 40 cm from the kerb reads
  //     a 4.6 m gradient and is thrown on its side.
  PropsBunker.prototype._settle = function (x, z, r, yaw, out) {
    out = out || _set;
    r = Math.max(0.10, r || 0.30);
    var c = this._ground(x, z);
    var xa = this._ground(x - r, z), xb = this._ground(x + r, z);
    var za = this._ground(x, z - r), zb = this._ground(x, z + r);
    var lim = 0.45 * r + 0.06;
    if (!isFinite(xa) || Math.abs(xa - c) > lim) xa = c;
    if (!isFinite(xb) || Math.abs(xb - c) > lim) xb = c;
    if (!isFinite(za) || Math.abs(za - c) > lim) za = c;
    if (!isFinite(zb) || Math.abs(zb - c) > lim) zb = c;
    // The base plane sits on the HIGHEST point under the footprint, not the
    // mean: a prop resting on a high spot rocks, it does not sink into it.
    out.y = Math.max(c, Math.max(Math.max(xa, xb), Math.max(za, zb))) * 0.55 +
      (c * 2 + xa + xb + za + zb) / 6 * 0.45;
    var gx = (xb - xa) / (2 * r);
    var gz = (zb - za) / (2 * r);
    // Rotate the gradient into the prop's own frame - the tilt is applied under
    // the yaw, so a gradient expressed in world axes lands on the wrong pair.
    var cy2 = Math.cos(yaw || 0), sy2 = Math.sin(yaw || 0);
    var glx = gx * cy2 - gz * sy2;
    var glz = gx * sy2 + gz * cy2;
    out.rz = M.clamp(glx, -0.26, 0.26);
    out.rx = M.clamp(-glz, -0.26, 0.26);
    return out;
  };

  // Does level geometry already occupy this sphere?
  //
  // FLOOR COLLIDERS ARE EXCLUDED and that exclusion is the point: a deck is a
  // box whose top face IS the ground, so a test sphere standing on the ground
  // always overlaps it.  We ask "is something in the way", never "is there a
  // floor here".
  PropsBunker.prototype._blocked = function (x, y, z, r) {
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

  PropsBunker.prototype._occupied = function (x, z, r) {
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
  PropsBunker.prototype._occupy = function (x, z, r) {
    var cs = 3;
    var k = Math.floor(x / cs) * 73856093 ^ Math.floor(z / cs) * 19349663;
    var l = this._occ.get(k);
    if (!l) { l = []; this._occ.set(k, l); }
    l.push(x, z, r);
  };

  PropsBunker.prototype._inLens = function (x, z, r) {
    for (var i = 0; i < this._keepOut.length; i++) {
      var k = this._keepOut[i];
      var dx = x - k.x, dz = z - k.z;
      var rr = k.r + (r || 0);
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  };

  // How well lit a spot is, from the level's published rig.  Used to BIAS
  // clutter density, not to gate it.
  //
  // This is not a rendering trick, it is the same reasoning as the walking
  // lines: people put things down where they can see, and a gang working a
  // corridor with four tubes still alight in sixteen works under those four.
  // It also happens to be the only way clutter earns its draw calls in a level
  // whose brief asks for long dark stretches - a crate in a 40 m black stretch
  // is a crate nobody will ever photograph.
  PropsBunker.prototype._litness = function (x, z) {
    var lm = this.lamps;
    if (!lm || !lm.length) return 0.5;
    var best = 1e9;
    for (var i = 0; i < lm.length; i++) {
      var p = lm[i] && lm[i].pos;
      if (!p) continue;
      var dx = p.x - x, dz = p.z - z;
      var d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    if (best > 1e8) return 0.5;
    return M.saturate(1 - Math.sqrt(best) / 9.0);
  };

  PropsBunker.prototype._inBounds = function (x, z, pad) {
    var b = this.bounds;
    pad = pad || 0;
    return x > b.x0 + pad && x < b.x1 - pad && z > b.z0 + pad && z < b.z1 - pad;
  };

  // The one call every ground placement goes through.
  //
  //   opts: { r clearance, y explicit height (skips settling), tilt extra,
  //           yaw, scale, sink, collider [hx,hy,hz], material, low, color,
  //           noClear, halo, lens, dry, flat }
  //
  // Returns the height it settled at, or null if the site was rejected.
  PropsBunker.prototype._drop = function (batch, x, z, opts) {
    if (!batch || !batch.add) return null;
    opts = opts || {};
    var r = opts.r === undefined ? 0.40 : opts.r;
    if (!this._inBounds(x, z, 0.15)) { this._skipped++; this._reject.bounds++; return null; }
    if (!opts.lens && this._inLens(x, z, r * 0.75)) { this._skipped++; this._reject.lens++; return null; }
    // `stack` means this placement is ON something already placed - a second
    // course of sandbags, a crate on a crate, a mug on a console - so the
    // ground-plane occupancy grid must be neither tested nor written.  Without
    // it every stacked thing in the facility silently collapsed to one course:
    // the bag directly above another bag is 20 cm from it in plan and the grid
    // rejected it, so a three-course revetment photographed as a line of
    // sandbags lying flat on the floor.
    if (!opts.stack && this._occupied(x, z, r)) { this._skipped++; this._reject.occ++; return null; }
    var yaw = opts.yaw === undefined ? this.rng.range(0, TAU) : opts.yaw;
    var y, rx, rz;
    if (opts.y === undefined) {
      var s = this._settle(x, z, Math.max(0.12, r * (opts.foot === undefined ? 0.85 : opts.foot)),
        yaw, _set);
      y = s.y; rx = s.rx; rz = s.rz;
    } else {
      y = opts.y; rx = 0; rz = 0;
    }
    // THE CLEARANCE RADIUS IS CAPPED, and the cap is load bearing.
    //
    // `r` is a prop's PLAN footprint and it is also what keeps props apart, so
    // it is generous - a cable drum asks for 0.58 m.  Feeding that straight into
    // the level-collider test asks "is there anything within 0.42 m of this
    // drum", and the answer against a corridor wall is always yes, because the
    // wall IS a collider and the drum is deliberately standing against it.  The
    // first build lost every reel, every big crate and every loose pipe length
    // in the facility that way, silently, and the tell was a batch count of 1
    // where the passes had asked for eight.  0.34 m is a body check, not a
    // personal-space check: it still rejects a prop inside a blast-door leaf or
    // a heat exchanger, which is the thing this test is actually for.
    var cr = opts.clearR === undefined ? Math.min(r * 0.60, 0.34) : opts.clearR;
    if (!opts.noClear && this._blocked(x, y + (opts.h || 0.5) * 0.5, z, cr)) {
      this._skipped++; this._reject.blocked++; return null;
    }
    // Every prop also carries a little slop on top of the measured gradient:
    // nothing in a forty-year-old facility stands dead plumb, and a hall of
    // objects that do is the "perfectly straight anything" the bar rejects.
    var tilt = opts.tilt === undefined ? 0.024 : opts.tilt;
    rx += this.rng.gaussian(0, tilt);
    rz += this.rng.gaussian(0, tilt);
    // `lay` rolls the prop onto its side or its back.  A drum that was knocked
    // over, a bin that went with it, a chair on its side - these are not extra
    // geometry, they are the same geometry through 90 degrees, and a store where
    // every single object is upright has never been used by anybody.  The caller
    // pairs it with a negative `sink` to lift the object onto its new footprint.
    if (opts.lay) rx += opts.lay;
    var sc = opts.scale === undefined ? 1 : opts.scale;
    // WETNESS IS DECIDED HERE, NOT IN THE GEOMETRY.
    //
    // One geometry serves every instance of a prop, so its painted mask suits
    // the COMMON case - a dry, dusty deck - or a drum in the flooded pit comes
    // out chalk-dry.  The instances actually standing in the water say so
    // through the instance colour, which multiplies the mask: G down is wetter,
    // and the dust term goes with it, because dust does not settle on water.
    var tint = opts.color || wearTint(this.rng);
    if (!opts.dry && y < this.waterY + 0.42) {
      _col2.copy(tint);
      _col2.g *= 0.34;
      _col2.r *= 0.82;
      _col2.b = M.clamp(_col2.b * 1.10, 0, 1);
      tint = _col2;
    }
    var ok = batch.add(
      T(x, y - (opts.sink || 0), z, rx, yaw, rz,
        sc * (opts.sx || 1), sc * (opts.sy || 1), sc * (opts.sz || 1)),
      tint);
    if (!ok) { this._reject.full++; return null; }
    if (!opts.stack) this._occupy(x, z, r);
    if (opts.collider) this._collider(x, y, z, opts.collider, yaw, opts.material);
    // A DUST HALO.  Anything standing still in a dusty facility grows a fillet
    // of fines where it meets the floor, and it is what stops a prop terminating
    // on a hard line against the deck.  Below the water line it is a silt ring
    // instead, which is the same physics with a different accumulant.
    if (opts.halo !== false && r >= 0.20) {
      this._floorPatch(y < this.waterY + 0.30 ? 2 : 0, x, y, z,
        Math.min(r * 2.4, 2.2), 0.55);
    }
    return y;
  };

  PropsBunker.prototype._collider = function (x, y, z, he, yaw, material) {
    _eu.set(0, yaw || 0, 0, 'YXZ');
    this.colliders.push({
      type: 'box',
      center: new THREE.Vector3(x, y + he[1], z),
      halfExtents: new THREE.Vector3(he[0], he[1], he[2]),
      quaternion: new THREE.Quaternion().setFromEuler(_eu),
      material: material || 'metal'
    });
  };

  PropsBunker.prototype._static = function (key, geometry, matrix) {
    var arr = this.S[key];
    if (!arr) arr = this.S[key] = [];
    arr.push(part(geometry, matrix));
  };

  // Drop a whole Item into the static batches at a world transform.
  PropsBunker.prototype._place = function (item, x, y, z, yaw, scale, roll, pitch) {
    if (!item) return;
    var base = Tn(x, y, z, pitch || 0, yaw || 0, roll || 0,
      scale || 1, scale || 1, scale || 1);
    var keys = item.keys();
    for (var k = 0; k < keys.length; k++) {
      var list = item.buckets[keys[k]];
      for (var i = 0; i < list.length; i++) {
        this._static(keys[k], list[i].geometry,
          new THREE.Matrix4().multiplyMatrices(base, list[i].matrix));
      }
    }
  };

  // A placard or a stencil on a wall / a machine flank.  `nx/nz` is the outward
  // normal of the surface it is fixed to.
  PropsBunker.prototype._placard = function (cell, x, y, z, nx, nz, w, h, tilt) {
    var uv = cellUV(cell);
    var g = card(w, h, uv[0], uv[1], uv[2], uv[3]);
    this._static('marks', g, Tn(x, y - h * 0.5, z, 0, Math.atan2(nx, nz), tilt || 0));
  };

  // A ground patch: 0 dust drift, 1 oil, 2 silt ring, 3 boot scuff.
  PropsBunker.prototype._floorPatch = function (cell, x, y, z, r, alpha) {
    if (this._grimeCount >= 420) return;
    var uv = cellUV(cell);
    var g = flatQuad(1, 1, uv);
    var s = r * this.rng.range(0.82, 1.35);
    this._static('grime', g,
      Tn(x + this.rng.gaussian(0, r * 0.10), y + 0.011,
        z + this.rng.gaussian(0, r * 0.10),
        0, this.rng.range(0, TAU), 0, s, 1, s * this.rng.range(0.75, 1.25)));
    this._grimeCount++;
    if (alpha) { /* alpha is carried by the texture; kept for call-site clarity */ }
  };

  // A dropped page.  Paper lies FLAT and slightly curled, and it collects in the
  // same places dust does - against a kick plate, in the lee of a console, at
  // the foot of a stair - because that is where a draught of 0.3 m/s puts it.
  PropsBunker.prototype._paper = function (x, y, z, w, yaw, cell) {
    if (this._paperCount >= 340) return;
    var uv = cellUV(cell === undefined ? this.rng.int(0, 3) : cell);
    var h = w * this.rng.range(0.62, 0.90);
    var g = flatQuad(w, h, uv);
    this._static('paper', g,
      Tn(x, y + 0.006 + this.rng.range(0, 0.010), z,
        this.rng.gaussian(0, 0.10), yaw === undefined ? this.rng.range(0, TAU) : yaw,
        this.rng.gaussian(0, 0.10)));
    this._paperCount++;
  };

  PropsBunker.prototype._uvScale = function (name, texels) {
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
  // here so density does not visibly jump between a 0.1 m spall chip and a 1.8 m
  // locker - the tell that a prop set was authored piecemeal.
  PropsBunker.prototype._finishGeo = function (geo, matName, wear, texels, keepUV) {
    if (!geo) return null;
    if (!keepUV) {
      try { Geo.worldUV(geo, this._uvScale(matName, texels)); } catch (e) { /* keep builder uv */ }
    }
    Geo.copyUV1(geo);
    paintWear(geo, wear || {});
    try { geo.computeBoundingSphere(); geo.computeBoundingBox(); } catch (e2) { /* ignore */ }
    return geo;
  };

  // Which library material a bucket's UV density should be solved against.
  var UVNAME = {
    steel: 'painted_metal', rust: 'rusted_metal', wood: 'wood_plank',
    concrete: 'concrete', plastic: 'plastic', rubber: 'rubber', cable: 'rubber',
    fabric: 'sandbag', canvas: 'canvas_awning', grate: 'steel_grate',
    red: 'painted_metal', green: 'painted_metal', cream: 'painted_metal',
    ochre: 'painted_metal', vinyl: 'plastic', glass: 'glass'
  };

  // ==========================================================================
  // KIT - every repeated prop becomes an InstancedMesh (or a Combo of them).
  //
  // A batch is ALWAYS created, even when its builder returned nothing: fifty
  // dressing call sites reach into this.B by name, and making one of them
  // conditional on a geometry that might be null turns a cosmetic failure into a
  // throw in the middle of a pass, which loses every prop after it.  An empty
  // batch is dropped in _commit and costs nothing.
  // ==========================================================================
  PropsBunker.prototype._buildKit = function () {
    var N = this.noise, R = this.rng, m = this.mats;
    var self = this;

    // Wear presets, by what the object actually IS.  `dust` is the settled film
    // on up-faces, `edge` the handled corners, `grime` the finger dirt.  The
    // spread across these numbers is what makes a timber crate and a steel case
    // standing side by side read as two materials rather than two colours.
    function wr(dust, edge, grime, extra) {
      var o = { dust: dust, edge: edge, grime: grime, noise: N,
        seed: R.range(0, 40), loY: 0, hiY: 1.0 };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return o;
    }

    // Build a Combo from an Item: one Batch per material bucket, all sharing the
    // same instance matrix.
    function combo(name, item, specs, max, cast) {
      var list = [];
      for (var i = 0; i < specs.length; i++) {
        var sp = specs[i];
        var g = item.merge(sp.b);
        if (!g) continue;
        if (sp.card) {
          // A card bucket authored its own atlas UVs, and its material has no
          // wear shader - a wear MASK there is multiplied straight onto albedo
          // and every placard comes back three shades of mud.
          Geo.copyUV1(g);
          paintCard(g, N, 0.94, 0.06);
        } else {
          self._finishGeo(g, UVNAME[sp.b] || 'painted_metal', sp.w, sp.tx);
        }
        try { g.computeBoundingSphere(); } catch (e) { /* ignore */ }
        var bt = new Batch(g, m[sp.b] || m.steel, max, cast === undefined ? true : cast);
        bt.label = 'bunker_' + name + '_' + sp.b;
        self._batches.push(bt);
        list.push(bt);
      }
      var c = new Combo(list);
      c.max = max;
      return c;
    }

    // ---- the containers -----------------------------------------------------
    this.B.drum = combo('drum', K.drum(R, N), [
      { b: 'rust', w: wr(0.46, 0.30, 0.42, { hiY: 0.9 }), tx: 820 },
      { b: 'marks', card: true }
    ], 96);

    this.B.crate = combo('crate', K.crateW(R, N), [
      { b: 'wood', w: wr(0.44, 0.34, 0.44, { hiY: 0.6 }) },
      { b: 'rust', w: wr(0.30, 0.26, 0.50, { hiY: 0.6 }) },
      { b: 'marks', card: true }
    ], 88);

    this.B.crateBig = combo('crateBig', K.crateW(R, N, 1.24, 0.86, 0.92), [
      { b: 'wood', w: wr(0.46, 0.30, 0.42, { hiY: 0.9 }) },
      { b: 'rust', w: wr(0.30, 0.24, 0.50, { hiY: 0.9 }) },
      { b: 'marks', card: true }
    ], 40);

    this.B.caseS = combo('caseS', K.caseS(R), [
      { b: 'green', w: wr(0.42, 0.34, 0.36, { hiY: 0.4 }), tx: 1050 },
      { b: 'steel', w: wr(0.34, 0.40, 0.34, { hiY: 0.4 }), tx: 1050 }
    ], 66);

    this.B.sack = combo('sack', K.sack(R, N, 3.1), [
      { b: 'fabric', w: wr(0.26, 0.12, 0.54, { hiY: 0.28 }), tx: 1000 }
    ], 190);

    this.B.cylinder = combo('cylinder', K.cylinder(R), [
      { b: 'ochre', w: wr(0.30, 0.26, 0.40, { hiY: 1.4 }), tx: 1000 },
      { b: 'steel', w: wr(0.26, 0.34, 0.44, { hiY: 1.5 }), tx: 1000 },
      { b: 'marks', card: true }
    ], 46);

    this.B.bucket = combo('bucket', K.bucket(R), [
      { b: 'red', w: wr(0.40, 0.32, 0.38, { hiY: 0.4 }), tx: 1100 }
    ], 34);

    this.B.chair = combo('chair', K.chair(R), [
      { b: 'steel', w: wr(0.26, 0.34, 0.40, { hiY: 0.8 }), tx: 1150 },
      { b: 'vinyl', w: wr(0.30, 0.26, 0.44, { hiY: 0.8 }), tx: 900 },
      { b: 'rubber', w: wr(0.18, 0.20, 0.56, { hiY: 0.3 }), tx: 1150 }
    ], 34);

    this.B.bin = combo('bin', K.bin(R, N, 5.5), [
      { b: 'steel', w: wr(0.38, 0.36, 0.46, { hiY: 0.5 }), tx: 1050 }
    ], 34);

    this.B.toolbox = combo('toolbox', K.toolbox(R), [
      { b: 'red', w: wr(0.34, 0.38, 0.44, { hiY: 0.4 }), tx: 1150 },
      { b: 'steel', w: wr(0.26, 0.42, 0.40, { hiY: 0.4 }), tx: 1150 }
    ], 40);

    this.B.pallet = combo('pallet', K.pallet(R), [
      { b: 'wood', w: wr(0.48, 0.32, 0.48, { hiY: 0.2 }) }
    ], 52);

    this.B.reel = combo('reel', K.reel(R, N), [
      { b: 'wood', w: wr(0.42, 0.30, 0.44, { hiY: 0.9 }) },
      { b: 'cable', w: wr(0.34, 0.14, 0.48, { hiY: 0.9 }) }
    ], 30);

    this.B.jerrycan = combo('jerrycan', K.jerrycan(R), [
      { b: 'green', w: wr(0.36, 0.34, 0.40, { hiY: 0.5 }), tx: 1100 },
      { b: 'steel', w: wr(0.28, 0.38, 0.40, { hiY: 0.5 }), tx: 1100 }
    ], 40);

    this.B.exting = combo('exting', K.extinguisher(R), [
      { b: 'red', w: wr(0.30, 0.26, 0.34, { hiY: 0.6 }), tx: 1150 },
      { b: 'steel', w: wr(0.24, 0.30, 0.38, { hiY: 0.6 }), tx: 1150 },
      { b: 'rubber', w: wr(0.20, 0.18, 0.44, { hiY: 0.6 }), tx: 1150 }
    ], 30);

    this.B.plank = combo('plank', K.plank(R, N, 1.7), [
      { b: 'wood', w: wr(0.52, 0.30, 0.46, { hiY: 0.12 }) }
    ], 110);

    this.B.pipeLen = combo('pipeLen', K.pipeLen(R), [
      { b: 'rust', w: wr(0.44, 0.24, 0.46, { hiY: 0.2 }) }
    ], 70);

    this.B.chunk = combo('chunk', K.chunk(R, N, 2.3), [
      { b: 'concrete', w: wr(0.56, 0.34, 0.40, { hiY: 0.3 }) }
    ], 300, false);

    this.B.drift = combo('drift', K.drift(R, N, 4.7), [
      // Pure dust: no grime at all, and the edge term off, because a drift IS
      // the substrate.  If this reads grey it has failed - it is what puts a
      // pale value at the foot of every wall in the facility.
      { b: 'concrete', w: wr(0.86, 0.0, 0.10, { hiY: 0.3, worldOrigin: true }) }
    ], 230, false);

    this.B.bag = combo('bag', K.bagKit(R, N, 6.2), [
      { b: 'fabric', w: wr(0.36, 0.20, 0.50, { hiY: 0.4 }), tx: 1050 }
    ], 46);

    this.B.binder = combo('binder', K.binder(R), [
      { b: 'cream', w: wr(0.40, 0.34, 0.38, { hiY: 0.2 }), tx: 1250 }
    ], 70);

    this.B.cup = combo('cup', K.cup(R), [
      { b: 'cream', w: wr(0.34, 0.40, 0.46, { hiY: 0.12 }), tx: 1400 }
    ], 50, false);

    this.B.locker = combo('locker', K.locker(R), [
      { b: 'green', w: wr(0.44, 0.28, 0.40, { hiY: 1.8 }), tx: 900 },
      { b: 'steel', w: wr(0.34, 0.36, 0.44, { hiY: 1.8 }), tx: 900 }
    ], 30);

    this.B.hose = combo('hose', K.hoseCoil(R, N, 8.4), [
      { b: 'rubber', w: wr(0.32, 0.14, 0.52, { hiY: 0.2 }) },
      { b: 'steel', w: wr(0.24, 0.30, 0.48, { hiY: 0.2 }) }
    ], 30, false);

    this.B.barrier = combo('barrier', K.barrier(R), [
      { b: 'ochre', w: wr(0.30, 0.30, 0.38, { hiY: 1.0 }), tx: 1000 },
      { b: 'steel', w: wr(0.24, 0.32, 0.42, { hiY: 1.0 }), tx: 1000 }
    ], 40);

    // ---- the ripple rings the drips make on the flood ----------------------
    var ring = flatQuad(1, 1, cellUV(2));
    Geo.copyUV1(ring);
    paintCard(ring, null, 1.0, 0);
    this.B.ring = new Batch(ring, m.ripple, 26, false);
    this.B.ring.mesh.receiveShadow = false;
    this.B.ring.label = 'bunker_ripples';
    this._batches.push(this.B.ring);
  };

  // Reserve a walking line so the clutter passes cannot fill it.
  //
  // This is the physical-plausibility rule stated as code: forty years of boots
  // keep a route clear, and everything that is on the floor is on the floor
  // because it was pushed OFF that route.  Stamping the route into the same
  // occupancy grid the props test against means no pass has to remember to
  // avoid it, and the routes are the level's own - spine centreline, the west
  // bridge walkway, the ring round the vessel, the pit stair.
  PropsBunker.prototype._reserve = function (x0, z0, x1, z1, r, step) {
    step = step || Math.max(0.5, r * 0.9);
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    var n = Math.max(1, Math.round(len / step));
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      this._occupy(x0 + dx * t, z0 + dz * t, r);
    }
  };

  // ==========================================================================
  // THE WORK SITE - the west deck band of the reactor gallery.
  //
  // This is the level's signature framing and its story: a maintenance gang was
  // mid-shift on the coolant circuit when the alarm went.  Everything here is
  // arranged as work-in-progress rather than as storage - the welding set still
  // rigged, the pipe run part-stripped and stacked on bearers, the reel paid out
  // across the deck, the barrier chain across the bridge - and it all sits to
  // one side of the sight line down the bridge, so it frames the vessel instead
  // of blocking it.
  // ==========================================================================
  PropsBunker.prototype._dressWorkSite = function () {
    var R = this.rng, N = this.noise;
    var H = this.hall, W = this.reactor;
    var wx0 = H.x0, wx1 = H.wellX0;
    var i;

    // ---- reserve the routes -------------------------------------------------
    // the portal -> bridge -> platform sight line, and the walkway half of the
    // west bridge (the pipe-rack half may carry props, and does)
    this._reserve(H.x0 + 0.4, 0, H.wellX0 + 0.2, 0, 1.05, 1.1);
    this._reserve(H.wellX0, -0.95, W.centre.x - W.platR1, -0.95, 0.85, 0.9);
    // The ring route round the operating platform.  Reserved on the OUTER half
    // of the 1.95 m annulus, tightly: a 0.72 m circle on the centre line ate the
    // whole width and every prop the platform pass tried to place was rejected
    // as occupied - silently, because a rejected placement is just a skip.
    for (i = 0; i < 24; i++) {
      var a = i / 24 * TAU;
      this._occupy(W.centre.x + Math.cos(a) * (W.platR1 - 0.28),
        W.centre.z + Math.sin(a) * (W.platR1 - 0.28), 0.24);
    }
    // the perimeter walking route round the well
    this._reserve(H.wellX0 - 1.5, H.wellZ0 - 0.85, H.wellX1 + 1.5, H.wellZ0 - 0.85, 0.66, 1.5);
    this._reserve(H.wellX0 - 1.5, H.wellZ1 + 0.85, H.wellX1 + 1.5, H.wellZ1 + 0.85, 0.66, 1.5);

    // ---- THE WORK SITE SITS EAST OF THE STANDPOINT --------------------------
    // The signature framing is taken from the middle of this deck band looking
    // east down the bridge, so anything placed WEST of about x = 12 is behind
    // the eye and photographs nothing.  The heavy plant is therefore set between
    // x = 12.3 and the well kerb at 14.4, flanking the sight line at |z| > 2.6,
    // where it frames the bridge instead of blocking it.
    this._weldingTrolley(wx0 + 3.45, -3.35, 0.55);
    // two spare bottles in their rack beside it, chained
    for (i = 0; i < 4; i++) {
      this._drop(this.B.cylinder, wx0 + 4.75 + R.range(-0.04, 0.04), -6.42 + i * 0.30,
        { r: 0.13, yaw: R.range(0, TAU), tilt: 0.012, scale: R.range(0.94, 1.05),
          collider: [0.14, 0.68, 0.14], material: 'metal' });
    }
    this._cylinderRack(wx0 + 5.05, -5.90, -Math.PI * 0.5);

    // ---- the part-stripped pipe run, stacked on timber bearers -------------
    this._pipeStack(wx0 + 4.15, 6.30, 0.42);

    // ---- the trestle tower --------------------------------------------------
    // 2.6 m of scaffold on the deck.  It is the only prop in the hall that puts
    // structure in the MIDDLE height band of the frame, between the deck clutter
    // and the crane girder 9 m up.
    this._trestle(wx0 + 3.85, 3.75, -0.32);

    // ---- pallets of spares along the wall ----------------------------------
    var pz = [-7.6, -6.0, 6.2, 7.9];
    for (i = 0; i < pz.length; i++) {
      var px = wx0 + 1.05 + R.range(-0.14, 0.20);
      var py = this._drop(this.B.pallet, px, pz[i], {
        r: 0.78, yaw: R.range(-0.16, 0.16) + (R.bool() ? 0 : Math.PI * 0.5),
        collider: [0.60, 0.06, 0.50], material: 'wood', halo: true
      });
      if (py === null) continue;
      // what is ON the pallet.  A bare pallet is a pallet; a loaded one is a
      // store.
      var kind = i % 3;
      if (kind === 0) {
        this._stack(this.B.crate, px, pz[i], py + 0.115, 2, 0.78, 0.62, 0.62);
      } else if (kind === 1) {
        this._drop(this.B.crateBig, px + R.range(-0.06, 0.06), pz[i], {
          r: 0.66, y: py + 0.115, yaw: R.range(-0.2, 0.2), noClear: true, halo: false,
          stack: true, lens: true
        });
      } else {
        for (var k = 0; k < 5; k++) {
          this._drop(this.B.sack, px + R.range(-0.30, 0.30), pz[i] + R.range(-0.24, 0.24), {
            r: 0.20, y: py + 0.115 + (k > 2 ? 0.17 : 0), yaw: R.range(0, TAU),
            scale: R.range(0.88, 1.10), noClear: true, halo: false, tilt: 0.10,
            stack: true, lens: true
          });
        }
      }
    }

    // ---- the kerb line: what gets put down at the edge of a job ------------
    // Everything here is inside the signature framing's near field and its job
    // is to give the bottom third of that frame a foreground.  Drums are the
    // right prop for it: a 0.88 m cylinder catches a rim highlight off the
    // worklight and reads at a glance even in a dim frame.
    var KZ = [-8.55, -7.05, -5.60, -4.15, 3.55, 5.00, 6.50, 8.05];
    for (i = 0; i < KZ.length; i++) {
      var kx = H.wellX0 - R.range(0.45, 0.95);
      this._drop(this.B.drum, kx, KZ[i] + R.range(-0.12, 0.12), {
        r: 0.30, yaw: R.range(0, TAU), scale: R.range(0.95, 1.04),
        collider: [0.30, 0.44, 0.30], material: 'metal', tilt: 0.020
      });
    }
    for (i = 0; i < 2; i++) {
      var kpz = i ? 4.35 : -4.95;
      var kpy = this._drop(this.B.pallet, H.wellX0 - 1.55, kpz, {
        r: 0.76, yaw: Math.PI * 0.5 + R.range(-0.14, 0.14),
        collider: [0.48, 0.06, 0.58], material: 'wood'
      });
      if (kpy !== null) this._stack(this.B.crateBig, H.wellX0 - 1.55, kpz, kpy + 0.115,
        i ? 1 : 2, 1.24, 0.90, 0.92);
    }

    // ---- the reel, paid out across the deck --------------------------------
    var rlx = wx0 + 2.4, rlz = -5.35;
    this._drop(this.B.reel, rlx, rlz, {
      r: 0.60, yaw: 0.42, collider: [0.50, 0.46, 0.28], material: 'wood'
    });
    this._cableRun(rlx + 0.35, rlz + 0.25, wx0 + 4.9, -8.5, 0.019, 7);
    this._cableRun(wx0 + 4.9, -8.5, H.wellX0 - 0.5, -9.1, 0.019, 6);

    // ---- barriers and chain across the head of the bridge ------------------
    for (i = 0; i < 2; i++) {
      this._drop(this.B.barrier, H.wellX0 - 0.55, -2.05 + i * 4.2, {
        r: 0.26, yaw: R.range(0, TAU), tilt: 0.02, lens: true, halo: true
      });
    }
    this._drop(this.B.barrier, H.wellX0 - 3.1, 2.55, { r: 0.26, tilt: 0.02 });

    // ---- ON THE BRIDGE -----------------------------------------------------
    // The bridge deck IS the near field of the signature framing - the deck band
    // behind it falls below the bottom of that frame entirely - so the only
    // props that can give that frame a foreground are the ones standing on it.
    // They sit on the south edge of the 3.2 m walkway, clear of the reserved
    // centre line, where they read against the lit water below.
    var br = (W.bridges && W.bridges.length) ? W.bridges[0] : null;
    var bx0 = br ? br.from.x : H.wellX0;
    var bx1 = br ? br.to.x : (W.centre.x - W.platR1);
    var bez = br && br.walkZ ? br.walkZ[0] + 0.28 : -2.32;
    this._drop(this.B.toolbox, bx0 + 0.95, bez, {
      r: 0.30, y: H.deckY, yaw: 1.15, tilt: 0.03, noClear: true, lens: true, dry: true
    });
    this._drop(this.B.hose, bx0 + 1.75, bez - 0.05, {
      r: 0.46, y: H.deckY, yaw: R.range(0, TAU), noClear: true, lens: true, dry: true,
      halo: false
    });
    this._drop(this.B.jerrycan, bx0 + 0.35, bez + 0.10, {
      r: 0.20, y: H.deckY, yaw: -0.45, tilt: 0.03, noClear: true, lens: true, dry: true,
      halo: false
    });
    this._drop(this.B.bucket, bx1 - 0.30, bez + 0.14, {
      r: 0.18, y: H.deckY, yaw: 0.9, tilt: 0.05, noClear: true, lens: true, dry: true,
      halo: false
    });
    this._drop(this.B.cylinder, bx0 + 1.20, bez - 0.10, {
      r: 0.16, y: H.deckY, yaw: 0.4, tilt: 0.02, lay: 1.52, sink: -0.11,
      noClear: true, lens: true, dry: true, halo: false
    });
    for (i = 0; i < 4; i++) {
      this._paper(bx0 + 0.4 + i * 0.45, H.deckY, bez + R.range(-0.25, 0.45),
        R.range(0.18, 0.27));
    }

    // ---- the small stuff that says "someone was working here" --------------
    this._drop(this.B.toolbox, wx0 + 2.85, -1.95, { r: 0.34, yaw: -0.55, tilt: 0.03 });
    this._drop(this.B.toolbox, H.wellX0 - 1.15, 2.75, { r: 0.34, yaw: 1.15, tilt: 0.03 });
    this._drop(this.B.hose, wx0 + 4.15, 1.85, { r: 0.60, yaw: R.range(0, TAU), halo: true });
    this._drop(this.B.bucket, wx0 + 3.55, -3.35, { r: 0.20, tilt: 0.05 });
    this._drop(this.B.jerrycan, wx0 + 1.05, -1.25, { r: 0.15, yaw: 0.30 });
    this._drop(this.B.jerrycan, wx0 + 1.38, -1.02, { r: 0.15, yaw: -0.42 });
    this._drop(this.B.bag, wx0 + 2.15, 2.35, { r: 0.34, yaw: 2.1, tilt: 0.06 });
    this._drop(this.B.cup, wx0 + 2.62, -1.62, { r: 0.09, tilt: 0.04, halo: false });

    // a couple of pages that got away from a clipboard, against the kerb
    for (i = 0; i < 7; i++) {
      var qx = H.wellX0 - R.range(0.25, 0.85);
      var qz = R.range(-8.2, 8.2);
      if (Math.abs(qz) < 3.0) continue;
      this._paper(qx, this._ground(qx, qz), qz, R.range(0.20, 0.30));
    }

    // oil where the plant stands, boot scuff where the gang walked
    this._floorPatch(1, wx0 + 1.9, this._ground(wx0 + 1.9, -2.7), -2.7, 1.5);
    this._floorPatch(1, wx0 + 3.4, this._ground(wx0 + 3.4, 4.7), 4.7, 1.2);
    for (i = 0; i < 9; i++) {
      var sx = wx0 + R.range(0.6, 5.0), sz = R.range(-9.0, 9.0);
      this._floorPatch(3, sx, this._ground(sx, sz), sz, R.range(1.2, 2.6));
    }
  };

  // A vertical stack of N crates, each one shifted and yawed off the one below.
  // A stack that is plumb and square is a warehouse render; every real stack
  // walks as it goes up.
  PropsBunker.prototype._stack = function (batch, x, z, y, n, w, h, d) {
    var R = this.rng;
    var cx = x, cz = z, cy = y;
    for (var i = 0; i < n; i++) {
      // _drop returns the height it actually settled at, and THAT is what the
      // next course sits on - not the requested height.  On the first course cy
      // is undefined, which is the whole point: the bottom box settles onto the
      // measured slab and everything above it inherits the settlement.
      var got = this._drop(batch, cx, cz, {
        r: w * 0.5, y: cy, yaw: R.range(0, TAU), noClear: i > 0,
        halo: i === 0 && y === undefined, tilt: 0.018 + i * 0.010,
        lens: i > 0 || y !== undefined,
        // An explicit start height means this stack is going ON something -
        // a pallet, a bench, another stack - and that something has already
        // written its own footprint into the occupancy grid, so the bottom
        // course must not be tested against it.  Without this every crate the
        // set ever tried to put on a pallet was rejected by the pallet.
        stack: (y !== undefined) || i > 0
      });
      if (got === null) break;
      cy = got + h;
      cx += R.gaussian(0, w * 0.055);
      cz += R.gaussian(0, d * 0.055);
    }
  };

  // ==========================================================================
  // THE REACTOR GALLERY - the four perimeter deck bands.
  //
  // The hall is 28 x 26 m and the establishing frame looks straight down it, so
  // the bands are what fill the middle distance.  Stores against the walls,
  // never in the open: a 26 m room with objects scattered evenly across it reads
  // as a level editor, and a 26 m room with everything stacked against its walls
  // reads as a room somebody worked in.
  // ==========================================================================
  PropsBunker.prototype._dressHall = function () {
    var R = this.rng, N = this.noise;
    var H = this.hall, W = this.reactor;
    var i, k;

    // ---- the north and south stores ----------------------------------------
    // Bays every 2.6 m along both long walls, each one with a role decided by
    // noise, and roughly a third of them left empty - the long dark stretches
    // the brief asks for are made of gaps, not of dimmer light.
    for (var s = -1; s <= 1; s += 2) {
      var wallZ = s * (H.hz - 0.55);
      for (i = 0; i < 11; i++) {
        var bx2 = H.x0 + 2.1 + i * 2.85;
        if (bx2 > H.x1 - 1.6) break;
        var role = M.smoothstep(0.30, 0.72, N.fbm2(bx2 * 0.42, wallZ * 0.42 + s * 3.1, 2) * 0.5 + 0.5);
        var jz = wallZ - s * R.range(0, 0.45);
        if (role < 0.24) continue;                       // an empty bay
        if (role < 0.50) {
          // a drum row, shoulder to shoulder against the wall
          var nD = 2 + R.int(0, 2);
          for (k = 0; k < nD; k++) {
            this._drop(this.B.drum, bx2 - 0.90 + k * 0.62 + R.range(-0.05, 0.05),
              jz + R.range(-0.10, 0.10), {
                r: 0.30, yaw: R.range(0, TAU), scale: R.range(0.96, 1.03),
                collider: [0.30, 0.44, 0.30], material: 'metal', tilt: 0.018
              });
          }
        } else if (role < 0.64) {
          this._stack(this.B.crate, bx2, jz, undefined, 1 + R.int(0, 1), 0.78, 0.60, 0.62);
          this._drop(this.B.caseS, bx2 + R.range(0.7, 1.1), jz + R.range(-0.2, 0.2),
            { r: 0.36, yaw: R.range(0, TAU), tilt: 0.03 });
        } else if (role < 0.74) {
          var py = this._drop(this.B.pallet, bx2, jz, {
            r: 0.76, yaw: s > 0 ? Math.PI * 0.5 : -Math.PI * 0.5,
            collider: [0.58, 0.06, 0.48], material: 'wood'
          });
          if (py !== null) this._stack(this.B.crateBig, bx2, jz, py + 0.115, 2, 1.24, 0.90, 0.92);
        } else if (role < 0.84) {
          for (k = 0; k < 3; k++) {
            this._drop(this.B.locker, bx2 - 0.42 + k * 0.42, jz, {
              r: 0.26, yaw: s > 0 ? Math.PI : 0, tilt: 0.010,
              collider: [0.20, 0.92, 0.24], material: 'metal'
            });
          }
        } else {
          for (k = 0; k < 4; k++) {
            this._drop(this.B.cylinder, bx2 - 0.45 + k * 0.30, jz + R.range(-0.05, 0.05), {
              r: 0.13, yaw: R.range(0, TAU), tilt: 0.014,
              collider: [0.13, 0.70, 0.13], material: 'metal'
            });
          }
          // the rack that stops them falling over
          this._cylinderRack(bx2, jz, s > 0 ? Math.PI : 0);
        }
      }
    }

    // ---- the east store, behind the vessel ---------------------------------
    var ex = (H.wellX1 + H.x1) * 0.5;
    for (i = 0; i < 5; i++) {
      var sz2 = -6.6 + i * 3.3;
      var epy = this._drop(this.B.pallet, H.x1 - 1.35 + R.range(-0.10, 0.10), sz2, {
        r: 0.76, yaw: Math.PI * 0.5 + R.range(-0.12, 0.12),
        collider: [0.48, 0.06, 0.58], material: 'wood'
      });
      if (epy !== null && i % 2 === 0) {
        this._stack(this.B.crateBig, H.x1 - 1.35, sz2, epy + 0.115, 2, 1.24, 0.90, 0.92);
      } else if (epy !== null) {
        for (k = 0; k < 4; k++) {
          this._drop(this.B.drum, H.x1 - 1.60 + (k % 2) * 0.60, sz2 - 0.28 + ((k / 2) | 0) * 0.56, {
            r: 0.30, y: epy + 0.115, yaw: R.range(0, TAU), noClear: true, halo: false,
            tilt: 0.02, stack: true, lens: true
          });
        }
      }
    }
    this._drop(this.B.reel, H.x1 - 2.55, 8.4, { r: 0.60, yaw: 1.2 });
    this._drop(this.B.reel, H.x1 - 2.20, 9.5, { r: 0.60, yaw: -0.4 });

    // ---- under the crane: the lifting tackle -------------------------------
    this._liftTackle(W.craneX + 1.6, -8.4, 0.62);

    // ---- fire points on the wall, where a fire point actually goes ---------
    var FP = [[H.x0 + 1.2, -H.hz + 0.30, 0], [H.x0 + 1.2, H.hz - 0.30, Math.PI],
              [24.0, -H.hz + 0.30, 0], [24.0, H.hz - 0.30, Math.PI],
              [H.x1 - 1.2, -H.hz + 0.30, 0]];
    for (i = 0; i < FP.length; i++) this._firePoint(FP[i][0], FP[i][1], FP[i][2]);

    // ---- spall and fines along the kerb and the wall bases -----------------
    for (i = 0; i < 46; i++) {
      var cx2, cz2;
      if (R.bool()) {
        cx2 = R.range(H.x0 + 0.8, H.x1 - 0.8);
        cz2 = (R.bool() ? 1 : -1) * (H.hz - R.range(0.12, 1.05));
      } else {
        cz2 = R.range(-H.hz + 1, H.hz - 1);
        cx2 = R.bool() ? H.x0 + R.range(0.12, 0.95) : H.x1 - R.range(0.12, 0.95);
      }
      this._drop(this.B.chunk, cx2, cz2, {
        r: 0.16, yaw: R.range(0, TAU), scale: R.range(0.42, 1.25),
        tilt: 0.30, halo: false, noClear: true, dry: true
      });
    }
    // Dropped pipe lengths, laid out beside the stack they were pulled from
    // rather than scattered: a stripped pipe run gets stacked, and the odd
    // length that would not go on the stack is laid down beside it.
    for (i = 0; i < 8; i++) {
      var lx = H.x0 + 2.90 + (i % 2) * 0.44 + R.range(-0.10, 0.10);
      var lz = -9.05 + ((i / 2) | 0) * 0.98 + R.range(-0.14, 0.14);
      this._drop(this.B.pipeLen, lx, lz, {
        r: 0.34, yaw: 1.55 + R.range(-0.18, 0.18), tilt: 0.03,
        halo: i < 2, noClear: true, clearR: 0.20
      });
    }
  };

  // ==========================================================================
  // THE OPERATING PLATFORM - the annulus round the vessel at deck level.
  //
  // A working platform, not a store: instruments, a trolley, the coolant
  // manifold's spanners, a hose still coupled.  Everything is placed in POLAR
  // coordinates against the bioshield so it hugs the drum's curve, which is what
  // makes the annulus read as an annulus.
  // ==========================================================================
  PropsBunker.prototype._dressPlatform = function () {
    var R = this.rng;
    var W = this.reactor;
    var cx = W.centre.x, cz = W.centre.z;
    var i;
    // The WEST arc (a near pi) is the one the signature framing looks straight
    // at, so it carries the most, and it carries the tallest things on the
    // platform: at 12 m a 0.3 m toolbox is a smudge and a 1.0 m barrier post
    // against a lit bioshield is a silhouette.
    var SPOT = [
      { a: 0.62, r: 0.42, k: 'trolley' },
      { a: 1.35, r: 0.28, k: 'toolbox' },
      { a: 2.15, r: 0.32, k: 'drum' },
      { a: 2.48, r: 0.32, k: 'drum' },
      { a: 2.80, r: 0.28, k: 'barrier' },
      { a: 3.14, r: 0.30, k: 'drum' },
      { a: 3.44, r: 0.28, k: 'case' },
      { a: 3.74, r: 0.42, k: 'hose' },
      { a: 4.05, r: 0.28, k: 'case' },
      { a: 4.65, r: 0.24, k: 'bucket' },
      { a: 5.35, r: 0.28, k: 'barrier' },
      { a: 5.95, r: 0.28, k: 'binder' }
    ];
    for (i = 0; i < SPOT.length; i++) {
      var sp = SPOT[i];
      // hug the bioshield: the outer half of the annulus is the walking side
      var rr = W.platR0 + 1.02 + (i % 3) * 0.10;
      var px = cx + Math.cos(sp.a) * rr;
      var pz = cz + Math.sin(sp.a) * rr;
      // face the drum
      var yaw = sp.a + Math.PI * 0.5;
      var o = { r: sp.r, yaw: yaw + R.range(-0.25, 0.25), tilt: 0.02, y: W.platY,
        noClear: true };
      if (sp.k === 'trolley') { this._instrumentCart(px, pz, yaw); continue; }
      if (sp.k === 'toolbox') this._drop(this.B.toolbox, px, pz, o);
      else if (sp.k === 'barrier') this._drop(this.B.barrier, px, pz, o);
      else if (sp.k === 'drum') {
        o.collider = [0.30, 0.44, 0.30]; o.material = 'metal';
        this._drop(this.B.drum, px, pz, o);
      } else if (sp.k === 'hose') this._drop(this.B.hose, px, pz, o);
      else if (sp.k === 'case') this._drop(this.B.caseS, px, pz, o);
      else if (sp.k === 'bucket') this._drop(this.B.bucket, px, pz, o);
      else if (sp.k === 'barrier') this._drop(this.B.barrier, px, pz, o);
      else if (sp.k === 'binder') this._drop(this.B.binder, px, pz, o);
    }
    // the coupled hose, running from the manifold round the drum
    this._hoseRun(cx + Math.cos(3.35) * (W.platR0 + 0.55), cz + Math.sin(3.35) * (W.platR0 + 0.55),
      cx, cz, W.platR0 + 0.42, 3.35, 4.95, W.platY);

    // ---- THE GANTRY RING, 5.7 m up ----------------------------------------
    // Four props on the ring's west and south arcs.  They exist for one reason:
    // the establishing and signature framings both have a wide empty band
    // between the deck clutter and the crane girder 9.7 m up, and a toolbox on a
    // catwalk at 5.7 m is the cheapest thing that gives that band a scale
    // reference.  Explicit y, because sampleGround knows nothing about a
    // catwalk hung off the vessel.
    var GA = [
      { a: 3.05, k: 'toolbox' }, { a: 3.70, k: 'drum' },
      { a: 4.42, k: 'bucket' }, { a: 2.40, k: 'caseS' }
    ];
    for (i = 0; i < GA.length; i++) {
      var gr = (W.gantryR0 + W.gantryR1) * 0.5 + R.range(-0.30, 0.30);
      var gx = cx + Math.cos(GA[i].a) * gr, gz = cz + Math.sin(GA[i].a) * gr;
      var go = { r: 0.30, y: W.gantryY, yaw: GA[i].a + Math.PI * 0.5 + R.range(-0.4, 0.4),
        tilt: 0.02, noClear: true, halo: false, dry: true };
      if (GA[i].k === 'toolbox') this._drop(this.B.toolbox, gx, gz, go);
      else if (GA[i].k === 'drum') this._drop(this.B.drum, gx, gz, go);
      else if (GA[i].k === 'bucket') this._drop(this.B.bucket, gx, gz, go);
      else this._drop(this.B.caseS, gx, gz, go);
    }

    // pages against the bioshield skirt, blown there and stuck
    for (i = 0; i < 6; i++) {
      var aa = R.range(0, TAU);
      var qr = W.platR0 + R.range(0.12, 0.55);
      this._paper(cx + Math.cos(aa) * qr, W.platY, cz + Math.sin(aa) * qr,
        R.range(0.18, 0.28));
    }
    // and the fines that have washed to the inside of the annulus
    for (i = 0; i < 14; i++) {
      var ab = i / 14 * TAU + R.range(-0.1, 0.1);
      var br = W.platR0 + R.range(0.10, 0.45);
      this._drop(this.B.chunk, cx + Math.cos(ab) * br, cz + Math.sin(ab) * br, {
        r: 0.10, y: W.platY, yaw: R.range(0, TAU), scale: R.range(0.35, 0.85),
        tilt: 0.30, halo: false, noClear: true, dry: true
      });
    }
  };

  // ==========================================================================
  // THE FLOODED LOWER LEVEL.
  //
  // 58 cm of standing water over the pit floor.  Two rules do all the work here:
  // anything below the deck is WET (which _drop decides off the settled height,
  // not off a flag a caller might forget), and anything floating has DRIFTED to
  // an obstruction, because the ring main and the pump skids are what stop
  // things moving.  A raft of debris in open water in a room with no current is
  // the uniform-scatter failure with a hat on.
  // ==========================================================================
  PropsBunker.prototype._dressPit = function () {
    var R = this.rng, N = this.noise;
    var L = this.lower, W = this.reactor;
    var i, k;
    var wy = this.waterY;

    // reserve the wading route round the ring and the stair run
    this._reserve(L.x0 + 1.9, 0, L.x1 - 1.9, 0, 0.85, 1.5);
    if (L.stair) {
      this._reserve(L.stair.x0 - 0.1, L.stair.z0, L.stair.x1 + 0.1, L.stair.z1, 0.62, 1.2);
    }

    // ---- drums against the pit walls, half sunk, listing -------------------
    // Stood off 1.85 m, NOT against the wall face: the level runs its ring main
    // in two tiers at 0.75 and 1.15 m off every pit wall, and the first pass put
    // this whole row inside those pipes.  A prop intersecting a 280 mm main is
    // worse than no prop, and nothing in the collider set would have caught it -
    // the ring main is geometry, not collision.
    var SIDE = [
      { x: L.x0 + 1.85, z0: L.z0 + 2.2, z1: L.z1 - 2.2, ax: 1 },
      { x: L.x1 - 1.85, z0: L.z0 + 2.2, z1: L.z1 - 2.2, ax: 1 }
    ];
    for (i = 0; i < SIDE.length; i++) {
      for (k = 0; k < 5; k++) {
        var dz = SIDE[i].z0 + (k + R.range(0.1, 0.9)) * (SIDE[i].z1 - SIDE[i].z0) / 5;
        // a third of them have gone over and rolled to the wall, which is where
        // a floating drum in a flooded room ends up
        var lie = R.bool(0.34);
        this._drop(this.B.drum, SIDE[i].x + R.range(-0.20, 0.20), dz, {
          r: lie ? 0.48 : 0.32, yaw: R.range(0, TAU),
          tilt: lie ? 0.04 : 0.09,
          lay: lie ? Math.PI * 0.5 : 0,
          sink: lie ? -0.27 : R.range(0.02, 0.12),
          scale: R.range(0.95, 1.04), halo: true,
          collider: lie ? null : [0.30, 0.44, 0.30], material: 'metal'
        });
      }
    }
    // the ones that fell in from the deck and are lying where they landed
    for (i = 0; i < 5; i++) {
      var fx = R.range(L.x0 + 2.2, L.x1 - 2.2);
      var fz = R.range(L.z0 + 1.4, L.z1 - 1.4);
      if (Math.abs(fx - W.centre.x) < W.bioR + 1.1 && Math.abs(fz - W.centre.z) < W.bioR + 1.1) continue;
      this._drop(this.B.drum, fx, fz, {
        r: 0.48, yaw: R.range(0, TAU), tilt: 0.06, halo: true,
        lay: Math.PI * 0.5 + R.range(-0.14, 0.14), sink: -0.26
      });
    }

    // ---- THE WEST LEG, which is the flooded framing -------------------------
    // The lower-level frame wades north-to-south up this leg, so the 3 m band
    // between the ring main and the bioshield at x = 16.2..18.4 is its whole
    // subject.  Half-sunk drums and a raft of timber against the pump skid are
    // the only props that read at 8-14 m in 58 cm of water under a red strip.
    // THE WADEABLE FLOOR IS NARROWER THAN THE WELL.  level.sampleGround answers
    // DECK_Y anywhere inside the operating platform annulus (radius 7.6 about
    // the vessel) or on either access bridge, because those ARE the ground
    // there - they are decks 4.6 m above the water.  So the west leg is only
    // actually flooded for |z| > about 2.7, and the first pass put half this
    // group at |z| < 2, where every one of them was quietly placed on the
    // bridge deck instead and photographed as nothing at all.  These positions
    // are solved against that boundary, not against the well rectangle.
    var NEAR = [
      { x: 15.35, z: 4.75, k: 'drum', lay: 1 },
      { x: 16.35, z: 3.70, k: 'drum', lay: 0 },
      { x: 14.95, z: 3.05, k: 'crate', lay: 0 },
      { x: 15.85, z: 2.85, k: 'drum', lay: 0 },
      { x: 16.55, z: 4.95, k: 'plank', lay: 0 },
      { x: 14.80, z: 5.55, k: 'drum', lay: 1 },
      { x: 15.75, z: -3.85, k: 'drum', lay: 0 },
      { x: 17.15, z: -4.90, k: 'drum', lay: 1 },
      { x: 16.05, z: -6.15, k: 'crate', lay: 0 },
      { x: 17.70, z: -7.35, k: 'drum', lay: 0 }
    ];
    for (i = 0; i < NEAR.length; i++) {
      var nr = NEAR[i];
      var no = { r: nr.lay ? 0.50 : 0.34, yaw: R.range(0, TAU), tilt: 0.05,
        halo: true, noClear: true };
      if (nr.lay) { no.lay = Math.PI * 0.5 + R.range(-0.12, 0.12); no.sink = -0.25; }
      else no.sink = R.range(0.03, 0.15);
      if (nr.k === 'drum') this._drop(this.B.drum, nr.x, nr.z, no);
      else if (nr.k === 'crate') this._drop(this.B.crate, nr.x, nr.z, no);
      else if (nr.k === 'plank') {
        no.r = 0.55; no.sink = 0.01; no.tilt = 0.04;
        this._drop(this.B.plank, nr.x, nr.z, no);
      } else {
        no.r = 0.70; no.sink = 0.02;
        var pny = this._drop(this.B.pallet, nr.x, nr.z, no);
        if (pny !== null) {
          for (k = 0; k < 3; k++) {
            this._drop(this.B.plank, nr.x + R.range(-0.30, 0.30), nr.z + R.range(-0.26, 0.26), {
              r: 0.55, y: pny + 0.115, yaw: R.range(0, TAU), tilt: 0.06,
              stack: true, noClear: true, halo: false, lens: true
            });
          }
        }
      }
    }

    // ---- what has drifted against the pump skids and the ring main --------
    var pumps = (L.pumps && L.pumps.length) ? L.pumps : [];
    for (i = 0; i < pumps.length; i++) {
      var p = pumps[i];
      if (!p) continue;
      // planks and crates stranded on the upstream face of the skid
      for (k = 0; k < 3; k++) {
        var a = R.range(0, TAU);
        var rr = R.range(0.95, 1.7);
        this._drop(this.B.plank, p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr, {
          r: 0.62, yaw: a + Math.PI * 0.5 + R.range(-0.4, 0.4), tilt: 0.06,
          sink: R.range(0.0, 0.05), halo: false, noClear: true
        });
      }
      if (i % 2 === 0) {
        this._drop(this.B.crate, p.x + R.range(-1.5, 1.5), p.z + R.range(-1.5, 1.5), {
          r: 0.46, yaw: R.range(0, TAU), tilt: 0.10, sink: 0.16, halo: true
        });
      }
      // the suction hose off the skid, lying in the water
      if (i === 0) this._hoseSnake(p.x + 0.5, p.z + 1.2, p.x + 4.2, p.z + 3.4, wy - 0.10);
    }

    // ---- the sump: the deepest, filthiest corner ---------------------------
    if (L.sump) {
      for (i = 0; i < 9; i++) {
        var sa = R.range(0, TAU), sr = R.range(0.5, 2.6);
        this._drop(this.B.chunk, L.sump.x + Math.cos(sa) * sr, L.sump.z + Math.sin(sa) * sr, {
          r: 0.14, yaw: R.range(0, TAU), scale: R.range(0.5, 1.35), tilt: 0.32,
          halo: false, noClear: true
        });
      }
      this._drop(this.B.bin, L.sump.x + 1.15, L.sump.z - 0.75, {
        r: 0.24, yaw: 1.9, tilt: 0.42, sink: 0.10, halo: true
      });
      this._floorPatch(1, L.sump.x, wy - 0.008, L.sump.z, 3.4);
    }

    // ---- what is visible from the deck above --------------------------------
    // The signature framing looks down into the far half of the well, so the
    // band x = 20..31 at |z| = 5..9 is the only part of the flood that
    // photographs from up there.  A drum on its side floating against the ring
    // main is the largest, most legible thing that can go in it.
    for (i = 0; i < 6; i++) {
      var vx = 20.5 + (i % 3) * 4.6 + R.range(-0.7, 0.7);
      var vz = (i < 3 ? 1 : -1) * R.range(5.6, 8.6);
      this._drop(this.B.drum, vx, vz, {
        r: 0.50, yaw: R.range(0, TAU), tilt: 0.05,
        lay: Math.PI * 0.5 + R.range(-0.12, 0.12), sink: -0.24, halo: true
      });
      this._drop(this.B.plank, vx + R.range(-1.4, 1.4), vz + R.range(-1.2, 1.2), {
        r: 0.60, yaw: R.range(0, TAU), tilt: 0.04, sink: R.range(-0.01, 0.03),
        halo: false, noClear: true
      });
    }

    // ---- the ladder that was left down here --------------------------------
    this._ladder(W.centre.x - W.bioR - 0.34, W.centre.z + 2.35, -0.30, 3.6);

    // ---- planks and pipe floating against the bioshield skirt --------------
    for (i = 0; i < 8; i++) {
      var pa = R.range(0, TAU);
      var pr = W.bioR + R.range(0.20, 0.65);
      var px2 = W.centre.x + Math.cos(pa) * pr, pz2 = W.centre.z + Math.sin(pa) * pr;
      if (px2 < L.x0 + 0.8 || px2 > L.x1 - 0.8 || pz2 < L.z0 + 0.8 || pz2 > L.z1 - 0.8) continue;
      this._drop(this.B.plank, px2, pz2, {
        r: 0.58, yaw: pa + Math.PI * 0.5 + R.range(-0.3, 0.3), tilt: 0.05,
        sink: R.range(-0.01, 0.03), halo: false, noClear: true
      });
    }
    // and the silt rings the water has left round everything
    for (i = 0; i < 16; i++) {
      var gx = R.range(L.x0 + 0.7, L.x1 - 0.7);
      var gz = R.range(L.z0 + 0.7, L.z1 - 0.7);
      if (Math.sqrt((gx - W.centre.x) * (gx - W.centre.x) +
        (gz - W.centre.z) * (gz - W.centre.z)) < W.bioR + 0.35) continue;
      this._floorPatch(R.bool(0.6) ? 2 : 1, gx, wy - 0.006, gz, R.range(1.4, 3.4));
    }
  };

  // ==========================================================================
  // THE SPINE - 42 m of corridor.
  //
  // The corridor framing is the level's claustrophobic argument, and the way to
  // dress it is NOT to fill it.  Bays between the pilasters at 2.6 m centres get
  // a role from noise and about a third of them get nothing at all, because the
  // long dark stretches the brief asks for are made of gaps.  The centreline is
  // reserved before anything is placed: everything on this floor is on this
  // floor because it was pushed off the route.
  // ==========================================================================
  PropsBunker.prototype._dressSpine = function () {
    var R = this.rng, N = this.noise;
    var S = this.spine;
    var i, k;
    var hz = S.hz;

    this._reserve(S.x0 + 0.5, 0, S.x1 - 0.5, 0, 0.86, 1.2);
    // and the two side openings, so the way into the control room and the plant
    // room is not barricaded
    if (S.junctions) {
      for (i = 0; i < S.junctions.length; i++) {
        var j = S.junctions[i];
        this._reserve(j.x, j.dir * (hz - 0.6), j.x, j.dir * (hz + 1.4), 0.85, 0.9);
      }
    }

    // ---- THE MID-CORRIDOR CACHE, placed before the procedural bays ---------
    // The corridor framing stands at x = -12.6 and looks the length of the
    // spine, so the 8 m in front of it is the only part of 42 m of corridor
    // that a still frame can resolve at all - and it happens to be the stretch
    // where two of the four surviving battens are.  These are hand-placed
    // rather than left to the bay roles for exactly that reason: the roles are
    // noise, and noise does not know which bay is the subject of a photograph.
    // Placed FIRST so the procedural pass fills round them, never over them.
    var CACHE = [
      { x: -11.15, z: 1.52, k: 'drum' },
      { x: -10.55, z: 1.55, k: 'drum' },
      { x: -9.10, z: 1.48, k: 'crateStack' },
      { x: -7.42, z: 1.56, k: 'locker' },
      { x: -6.98, z: 1.56, k: 'locker' },
      { x: -6.20, z: -1.52, k: 'drum' },
      { x: -5.62, z: -1.50, k: 'drum' },
      { x: -8.20, z: -1.55, k: 'crateStack' },
      { x: -4.35, z: -1.44, k: 'barrier' },
      { x: -10.10, z: -1.50, k: 'reel' }
    ];
    for (i = 0; i < CACHE.length; i++) {
      var ch = CACHE[i];
      var cz3 = ch.z;
      if (ch.k === 'crateStack') {
        this._stack(this.B.crate, ch.x, cz3, undefined, 2, 0.78, 0.62, 0.62);
      } else if (ch.k === 'locker') {
        this._drop(this.B.locker, ch.x, cz3, {
          r: 0.24, yaw: cz3 > 0 ? Math.PI : 0, tilt: 0.010,
          collider: [0.20, 0.92, 0.24], material: 'metal'
        });
      } else if (ch.k === 'drum') {
        this._drop(this.B.drum, ch.x, cz3, {
          r: 0.29, yaw: R.range(0, TAU), scale: R.range(0.96, 1.03), tilt: 0.020,
          collider: [0.30, 0.44, 0.30], material: 'metal'
        });
      } else if (ch.k === 'reel') {
        this._drop(this.B.reel, ch.x, cz3, { r: 0.50, yaw: R.range(0, TAU) });
      } else {
        this._drop(this.B.barrier, ch.x, cz3, { r: 0.24, tilt: 0.02 });
      }
    }

    var nBay = Math.floor((S.x1 - S.x0) / S.beamPitch);
    for (i = 1; i < nBay; i++) {
      var bx2 = S.x0 + (i + 0.5) * S.beamPitch;
      if (bx2 > S.x1 - 1.4) break;
      for (var s = -1; s <= 1; s += 2) {
        var role = M.smoothstep(0.30, 0.72, N.fbm2(bx2 * 0.55 + s * 7.3, s * 2.1, 2) * 0.5 + 0.5);
        // Biased toward the bays a fitting still lights - see _litness.  A bay
        // in a dead 12 m stretch keeps a one-in-four chance so the darkness has
        // something in it when a torch or a muzzle flash finds it.
        role += this._litness(bx2, s * hz) * 0.34 - 0.10;
        if (role < 0.30) continue;                        // an empty bay
        var wz = s * (hz - R.range(0.34, 0.52));
        if (role < 0.48) {
          // drums, shoulder to the wall
          for (k = 0; k < 1 + R.int(0, 1); k++) {
            this._drop(this.B.drum, bx2 - 0.32 + k * 0.62, wz, {
              r: 0.30, yaw: R.range(0, TAU), scale: R.range(0.96, 1.03),
              collider: [0.30, 0.44, 0.30], material: 'metal', tilt: 0.020
            });
          }
        } else if (role < 0.60) {
          this._stack(this.B.crate, bx2, wz, undefined, 1 + R.int(0, 1), 0.78, 0.62, 0.62);
        } else if (role < 0.68) {
          for (k = 0; k < 2 + R.int(0, 1); k++) {
            this._drop(this.B.caseS, bx2 - 0.30 + k * 0.34, wz + R.range(-0.08, 0.08), {
              r: 0.24, y: undefined, yaw: s > 0 ? Math.PI : 0, tilt: 0.03,
              sink: 0, scale: R.range(0.94, 1.06)
            });
          }
        } else if (role < 0.76) {
          // a two-course pile of sacks, the top course short
          var sy0 = null;
          for (k = 0; k < 3; k++) {
            var got = this._drop(this.B.sack, bx2 - 0.42 + k * 0.42,
              wz + R.range(-0.10, 0.10), {
                r: 0.24, yaw: R.range(0, TAU), scale: R.range(0.90, 1.08), tilt: 0.09
              });
            if (got !== null && sy0 === null) sy0 = got;
          }
          if (sy0 !== null) {
            for (k = 0; k < 2; k++) {
              this._drop(this.B.sack, bx2 - 0.20 + k * 0.42, wz + R.range(-0.08, 0.08), {
                r: 0.20, y: sy0 + 0.165, yaw: R.range(0, TAU), scale: R.range(0.88, 1.05),
                tilt: 0.11, noClear: true, halo: false, lens: true, stack: true
              });
            }
          }
        } else if (role < 0.83) {
          this._drop(this.B.reel, bx2, wz, { r: 0.52, yaw: R.range(0, TAU) });
        } else if (role < 0.91) {
          this._drop(this.B.locker, bx2, wz - s * 0.06, {
            r: 0.26, yaw: s > 0 ? Math.PI : 0, tilt: 0.010,
            collider: [0.20, 0.92, 0.24], material: 'metal'
          });
          this._drop(this.B.locker, bx2 + 0.42, wz - s * 0.06, {
            r: 0.26, yaw: s > 0 ? Math.PI : 0, tilt: 0.010,
            collider: [0.20, 0.92, 0.24], material: 'metal'
          });
        } else {
          this._drop(this.B.bin, bx2, wz, { r: 0.24, yaw: R.range(0, TAU), tilt: 0.05 });
          this._drop(this.B.bag, bx2 + R.range(0.4, 0.7), wz + R.range(-0.15, 0.15),
            { r: 0.32, yaw: R.range(0, TAU), tilt: 0.07 });
        }
      }
    }

    // ---- fire points and wall furniture ------------------------------------
    // Placed on the SOUTH wall between the trunk flanges, which is where a fire
    // point goes when the north wall is three tiers of cable tray.
    var FPX = [S.x0 + 3.4, S.x0 + 12.6, -14.2, -1.9, S.x1 - 2.2];
    for (i = 0; i < FPX.length; i++) {
      this._firePoint(FPX[i], -hz + 0.10, 0);
    }
    this._noticeBoard(S.x0 + 7.9, hz - 0.09, Math.PI, 1.35, 0.95, 1.62);
    this._noticeBoard(-11.4, -hz + 0.09, 0, 1.15, 0.85, 1.58);
    this._telephone(-19.8, -hz + 0.10, 0, 1.42);
    this._telephone(1.8, hz - 0.10, Math.PI, 1.42);

    // ---- the trolley that was abandoned at the mid blast door ---------------
    var dm = (S.doorsX && S.doorsX.length > 1) ? S.doorsX[1] : -3.2;
    this._trolley(dm - 2.35, -1.05, 1.28, true);

    // ---- what a draught of 0.3 m/s does with forty years of paper ----------
    // It strands it against the kick line, not in the middle of the floor.
    for (i = 0; i < 46; i++) {
      var px = R.range(S.x0 + 1.0, S.x1 - 1.0);
      var ss = R.bool() ? 1 : -1;
      var pz = ss * (hz - R.range(0.06, 0.62));
      this._paper(px, this._ground(px, pz), pz, R.range(0.18, 0.30));
    }
    // and spall from the soffit, where the beams have shed their arrises
    for (i = 0; i < 34; i++) {
      var cx2 = R.range(S.x0 + 0.8, S.x1 - 0.8);
      var cs2 = R.bool() ? 1 : -1;
      var cz2 = cs2 * (hz - R.range(0.10, 0.95));
      this._drop(this.B.chunk, cx2, cz2, {
        r: 0.13, yaw: R.range(0, TAU), scale: R.range(0.30, 0.95), tilt: 0.30,
        halo: false, noClear: true, dry: true
      });
    }
    // boot scuff down the route itself - the ONE thing that goes on the
    // centreline, because that is where the boots are
    for (i = 0; i < 16; i++) {
      var wx2 = S.x0 + 1.6 + i * 2.55;
      if (wx2 > S.x1 - 1.2) break;
      this._floorPatch(3, wx2 + R.range(-0.6, 0.6), this._ground(wx2, 0),
        R.range(-0.9, 0.9), R.range(1.6, 2.9));
    }
  };

  // ==========================================================================
  // THE CONTROL ROOM.
  //
  // The enclosed framing.  It is dressed as a room that was EVACUATED, not
  // abandoned: chairs pushed back and one on its side, a mug still on a
  // worktop, forty years of log sheets on the floor, a bin gone over, the
  // access-floor panels still up from whatever the duty electrician was
  // chasing.  Every desk item hangs off level.anchors.control.consoles, so a
  // mug is on a console that actually exists.
  // ==========================================================================
  PropsBunker.prototype._dressControl = function () {
    var R = this.rng, N = this.noise;
    var C = this.ctl;
    var fy = C.floorY;
    var i, k;
    var cons = C.consoles || [];

    // the aisle in front of the status wall and the run to the doorway
    this._reserve(C.x0 + 1.4, C.z1 - 1.6, C.x1 - 1.4, C.z1 - 1.6, 0.75, 1.4);
    if (C.doorway) this._reserve(C.doorway.x, C.z0 + 0.4, C.doorway.x, C.z1 - 2.0, 0.75, 1.4);

    // ---- chairs -------------------------------------------------------------
    for (i = 0; i < cons.length; i++) {
      var cn = cons[i];
      if (!cn || !cn.centre) continue;
      var roll = N.fbm2(cn.centre.x * 1.7, cn.centre.z * 1.7, 2) * 0.5 + 0.5;
      if (roll < 0.30) continue;                    // that position had no chair
      // the operator sits on the switch-fascia side, which is +Z
      var chx = cn.centre.x + R.range(-0.30, 0.30);
      var chz = cn.centre.z + R.range(0.86, 1.24);
      if (roll > 0.86) {
        // one of them has been shoved right out of the row - a person left in a
        // hurry, and a room of chairs squared up to their desks did not
        chx += R.range(-1.4, 1.4) * (R.bool() ? 1 : -1);
        chz += R.range(0.4, 1.3);
      }
      this._drop(this.B.chair, chx, chz, {
        r: 0.42, y: fy, yaw: Math.PI + R.range(-0.9, 0.9), tilt: 0.02,
        collider: [0.28, 0.42, 0.28], material: 'metal', halo: true
      });
    }
    // and the one that went over
    if (cons.length > 3 && cons[3].centre) {
      this._drop(this.B.chair, cons[3].centre.x + 1.55, cons[3].centre.z + 1.95, {
        r: 0.48, y: fy, yaw: 2.35, tilt: 0, lay: 1.42, sink: -0.30, halo: true
      });
    }

    // ---- what is ON the consoles -------------------------------------------
    var topY = fy + 0.818;
    for (i = 0; i < cons.length; i++) {
      var c2 = cons[i];
      if (!c2 || !c2.centre) continue;
      var pick = (N.fbm2(c2.centre.x * 3.1 + 5, c2.centre.z * 3.1, 2) * 0.5 + 0.5);
      if (pick > 0.30) {
        this._drop(this.B.binder, c2.centre.x + R.range(-0.42, 0.42), c2.centre.z + 0.16, {
          r: 0.20, y: topY, yaw: R.range(0, TAU), tilt: 0.02,
          noClear: true, halo: false, dry: true, stack: true
        });
      }
      if (pick > 0.52) {
        this._drop(this.B.cup, c2.centre.x + R.range(-0.55, 0.55), c2.centre.z + 0.24, {
          r: 0.08, y: topY, yaw: R.range(0, TAU), tilt: 0.015,
          noClear: true, halo: false, dry: true, stack: true
        });
      }
      if (pick > 0.70) this._headset(c2.centre.x + R.range(-0.3, 0.3), topY, c2.centre.z + 0.10);
    }

    // ---- the racks along the west wall get their printout ------------------
    if (C.racks) {
      for (i = 0; i < 4; i++) {
        this._drop(this.B.binder, C.racks.x + R.range(-0.25, 0.25),
          C.racks.z + 0.9 + i * 1.05, {
            r: 0.20, y: fy + 2.06, yaw: R.range(0, TAU), tilt: 0.02,
            noClear: true, halo: false, dry: true, stack: true
          });
      }
      this._drop(this.B.bin, C.racks.x + 0.9, C.racks.z - 0.7,
        { r: 0.24, y: fy, yaw: 0.6, tilt: 0.04 });
    }

    // ---- the lifted access-floor panels: somebody was working under there ---
    var vp = C.voidPanels || [];
    for (i = 0; i < vp.length; i++) {
      var v = vp[i];
      if (!v || !v.centre) continue;
      this._drop(this.B.toolbox, v.centre.x + v.hx + 0.62, v.centre.z + R.range(-0.3, 0.3), {
        r: 0.32, y: fy, yaw: R.range(0, TAU), tilt: 0.03, noClear: true
      });
      this._drop(this.B.reel, v.centre.x - v.hx - 0.95, v.centre.z + R.range(-0.4, 0.4), {
        r: 0.55, y: fy, yaw: R.range(0, TAU), noClear: true, scale: 0.72
      });
      // cable pulled up out of the void and left across the floor
      this._groundRun('cable', v.centre.x, v.centre.z, v.centre.x + R.range(1.6, 3.0),
        v.centre.z + R.range(-2.4, 2.4), 0.017, 0.22, 6, fy);
      for (k = 0; k < 4; k++) {
        this._paper(v.centre.x + R.range(-1.1, 1.1), fy, v.centre.z + R.range(-1.1, 1.1),
          R.range(0.20, 0.30));
      }
    }

    // ---- THE AISLE BETWEEN THE ROWS ----------------------------------------
    // The enclosed framing stands at the west end of the room and looks
    // north-east across the console rows, so the 2 m band between them is the
    // ONLY floor in that frame that is both lit and near.  Everything here is
    // low - nothing taller than a console back - so it fills the near field
    // without closing the composition off.
    var aisleZ = (cons.length > 4 && cons[0].centre && cons[cons.length - 1].centre)
      ? (cons[0].centre.z + cons[cons.length - 1].centre.z) * 0.5 : 10.0;
    this._drop(this.B.bin, C.x0 + 4.6, aisleZ - 0.35, {
      r: 0.26, y: fy, yaw: 2.1, tilt: 0.04, noClear: true
    });
    this._drop(this.B.reel, C.x0 + 2.9, aisleZ + 0.30, {
      r: 0.55, y: fy, yaw: 1.15, noClear: true, scale: 0.80
    });
    for (i = 0; i < 3; i++) {
      this._drop(this.B.caseS, C.x0 + 6.4 + i * 0.18, aisleZ + 0.55 + i * 0.05, {
        r: 0.30, y: fy + i * 0.35, yaw: 1.5 + R.range(-0.2, 0.2), tilt: 0.03,
        noClear: true, halo: i === 0, stack: i > 0, dry: true
      });
    }
    this._drop(this.B.toolbox, C.x0 + 8.2, aisleZ - 0.55, {
      r: 0.32, y: fy, yaw: -0.6, tilt: 0.03, noClear: true
    });
    this._drop(this.B.bag, C.x0 + 1.7, aisleZ - 0.15, {
      r: 0.34, y: fy, yaw: 2.4, tilt: 0.07, noClear: true
    });
    for (i = 0; i < 10; i++) {
      this._paper(C.x0 + R.range(0.9, 9.5), fy, aisleZ + R.range(-1.0, 1.0),
        R.range(0.19, 0.30));
    }

    // ---- the plotting table, the coat stand and the urn ---------------------
    this._plotTable(-16.9, 9.7, 0.32, fy);
    this._coatStand(C.x1 - 1.35, C.z0 + 1.55, fy);
    this._sideTable(C.x0 + 1.45, C.z1 - 1.75, fy);

    // ---- filing, along the east wall ---------------------------------------
    for (i = 0; i < 5; i++) {
      this._drop(this.B.locker, C.x1 - 0.42, C.z0 + 4.1 + i * 0.44, {
        r: 0.26, y: fy, yaw: -Math.PI * 0.5, tilt: 0.008,
        collider: [0.24, 0.92, 0.20], material: 'metal'
      });
    }

    // ---- THE PAPER.  A control room that was walked out of is ankle deep ----
    // Concentrated where a draught and forty years put it: against the kick
    // lines of the consoles, in the lee of the racks, and at the doorway.
    for (i = 0; i < cons.length; i++) {
      var c3 = cons[i];
      if (!c3 || !c3.centre) continue;
      var nP = 2 + R.int(0, 4);
      for (k = 0; k < nP; k++) {
        var sgn = R.bool() ? 1 : -1;
        this._paper(c3.centre.x + R.gaussian(0, 0.55),
          fy, c3.centre.z + sgn * R.range(0.50, 1.05), R.range(0.19, 0.30));
      }
    }
    for (i = 0; i < 26; i++) {
      var px2 = R.range(C.x0 + 0.7, C.x1 - 0.7);
      var pz2 = R.range(C.z0 + 0.7, C.z1 - 0.7);
      // the lee of the room: the corners and the wall lines, not the middle
      var edge = Math.min(Math.min(px2 - C.x0, C.x1 - px2), Math.min(pz2 - C.z0, C.z1 - pz2));
      if (edge > 1.7 && R.bool(0.72)) continue;
      this._paper(px2, fy, pz2, R.range(0.18, 0.30));
    }
    // the bin that went over, and its spill
    var bnx = -19.6, bnz = 6.4;
    this._drop(this.B.bin, bnx, bnz, {
      r: 0.30, y: fy, yaw: 1.1, tilt: 0, lay: 1.48, sink: -0.19, halo: true
    });
    for (i = 0; i < 9; i++) {
      var ta = R.range(-0.9, 0.9) + 1.1;
      var tr = R.range(0.20, 1.15);
      this._paper(bnx + Math.cos(ta) * tr, fy, bnz + Math.sin(ta) * tr, R.range(0.17, 0.26));
    }
    // binders that came off a rack
    for (i = 0; i < 5; i++) {
      this._drop(this.B.binder, R.range(C.x0 + 1.0, C.x0 + 3.2), R.range(C.z0 + 2.0, C.z0 + 6.0), {
        r: 0.24, y: fy, yaw: R.range(0, TAU), tilt: 0.20, halo: false
      });
    }
    // dust and scuff on the access floor
    for (i = 0; i < 12; i++) {
      var gx2 = R.range(C.x0 + 0.8, C.x1 - 0.8), gz2 = R.range(C.z0 + 0.8, C.z1 - 0.8);
      this._floorPatch(R.bool(0.6) ? 0 : 3, gx2, fy, gz2, R.range(1.6, 3.4));
    }
  };

  // ==========================================================================
  // THE PLANT ROOM.  Its job in the level is to stop the spine being a pure
  // tube, so what it needs is depth and silhouette in a side opening seen at an
  // angle: a bench with things standing ON it, drums with a top edge to catch
  // the fitting, and a reel.
  // ==========================================================================
  PropsBunker.prototype._dressPlant = function () {
    var R = this.rng;
    var P = this.plant;
    var i;
    this._reserve(P.x0 + 1.0, (P.z0 + P.z1) * 0.5, P.x1 - 1.0, (P.z0 + P.z1) * 0.5, 0.66, 1.3);

    this._workbench(P.x1 - 1.30, P.z0 + 2.60, -Math.PI * 0.5);

    for (i = 0; i < 4; i++) {
      this._drop(this.B.drum, P.x0 + 0.85 + R.range(-0.10, 0.10), P.z1 - 1.05 - i * 0.66, {
        r: 0.30, yaw: R.range(0, TAU), collider: [0.30, 0.44, 0.30], material: 'metal',
        tilt: 0.02
      });
    }
    for (i = 0; i < 3; i++) {
      this._drop(this.B.jerrycan, P.x0 + 1.85 + i * 0.32, P.z1 - 0.68, {
        r: 0.15, yaw: R.range(-0.3, 0.3), tilt: 0.03
      });
    }
    this._drop(this.B.reel, P.x0 + 3.30, P.z0 + 0.95, { r: 0.58, yaw: 0.9 });
    this._drop(this.B.toolbox, P.x1 - 2.55, P.z0 + 0.85, { r: 0.32, yaw: -0.4, tilt: 0.03 });
    this._drop(this.B.bucket, P.x0 + 4.60, P.z0 + 0.80, { r: 0.20, tilt: 0.06 });
    this._drop(this.B.bin, P.x1 - 0.75, P.z1 - 0.80, { r: 0.24, yaw: 2.4, tilt: 0.04 });
    for (i = 0; i < 4; i++) {
      this._drop(this.B.cylinder, P.x1 - 3.95 + i * 0.30, P.z0 + 2.75, {
        r: 0.13, yaw: R.range(0, TAU), tilt: 0.014,
        collider: [0.13, 0.70, 0.13], material: 'metal'
      });
    }
    this._cylinderRack(P.x1 - 3.5, P.z0 + 2.75, 0);
    this._firePoint(P.x0 + 0.10, P.z0 + 3.20, Math.PI * 0.5);
    // the spill tray under the transformer, and the oil that got past it
    if (P.transformer) {
      this._floorPatch(1, P.transformer.x, this._ground(P.transformer.x, P.transformer.z),
        P.transformer.z, 2.4);
      this._floorPatch(1, P.transformer.x - 1.2, this._ground(P.transformer.x - 1.2, P.transformer.z - 0.9),
        P.transformer.z - 0.9, 1.5);
    }
    for (i = 0; i < 8; i++) {
      var px = R.range(P.x0 + 0.6, P.x1 - 0.6), pz = R.range(P.z0 + 0.6, P.z1 - 0.6);
      this._drop(this.B.chunk, px, pz, {
        r: 0.12, yaw: R.range(0, TAU), scale: R.range(0.3, 0.9), tilt: 0.3,
        halo: false, noClear: true, dry: true
      });
    }
  };

  // ==========================================================================
  // THE BLAST VESTIBULE - the landmark framing.
  //
  // A checkpoint, a decontamination line and a guard post, and then somebody
  // built a firing position across it facing the aperture.  The sandbag
  // emplacement is the level's one piece of narrative dressing and it is placed
  // where a firing position goes: back from the opening, off the axis, with the
  // door's own rams for cover on the flank.
  // ==========================================================================
  PropsBunker.prototype._dressVestibule = function () {
    var R = this.rng, N = this.noise;
    var V = this.vest, BD = this.blast;
    var i, k;
    var hz = V.hz;

    this._reserve(BD.plane + 1.5, 0, V.x1 - 0.6, 0, 0.95, 1.3);

    // ---- the emplacement ----------------------------------------------------
    // Two courses, stretcher bond, curved so it faces the aperture, with the
    // top course short on the firing side.
    this._sandbagWall(V.x0 + 4.9, -2.55, V.x0 + 4.4, 1.35, 5, 0.148);
    this._sandbagWall(V.x0 + 4.55, 1.60, V.x0 + 6.9, 3.35, 4, 0.148);
    this._drop(this.B.caseS, V.x0 + 5.65, -0.55, { r: 0.36, yaw: 1.4, tilt: 0.03 });
    this._drop(this.B.caseS, V.x0 + 5.60, -0.10, { r: 0.36, yaw: 1.2, tilt: 0.04, noClear: true });
    this._drop(this.B.bag, V.x0 + 6.15, 0.85, { r: 0.34, yaw: 0.6, tilt: 0.07 });
    this._drop(this.B.cup, V.x0 + 5.95, -1.05, { r: 0.09, tilt: 0.05, halo: false });

    // ---- the decontamination line ------------------------------------------
    // Hung coveralls on a rail beside the stalls: the only soft, moving thing in
    // the facility above the water line, and the only prop the ventilation
    // draught can act on.
    this._coverallRail(V.x0 + 8.40, -hz + 1.60, 2.10, 4);
    for (i = 0; i < 6; i++) {
      this._drop(this.B.bucket, V.x0 + 1.45 + i * 0.42, -hz + 0.42, {
        r: 0.16, yaw: R.range(0, TAU), tilt: 0.05, halo: i === 0
      });
    }
    // boot pairs at the step-over line
    for (i = 0; i < 5; i++) this._boots(V.x0 + 1.9 + i * 0.52, -hz + 2.35, R.range(0, TAU));

    // ---- lockers, east of the cabin stair ----------------------------------
    for (i = 0; i < 6; i++) {
      this._drop(this.B.locker, V.x1 - 1.15 - i * 0.42, hz - 0.42, {
        r: 0.26, yaw: Math.PI, tilt: 0.008,
        collider: [0.20, 0.92, 0.24], material: 'metal'
      });
    }

    // ---- the checkpoint desk ------------------------------------------------
    // Under the vestibule flood, which is the one fixture in this room that
    // throws a hard warm pool - a desk in the dark half of the room is a desk
    // nobody can see.
    this._deskUnit(V.x0 + 7.40, -2.90, -0.35, false);
    this._drop(this.B.chair, V.x0 + 6.85, -3.80, {
      r: 0.42, yaw: 2.9, tilt: 0.03, collider: [0.28, 0.42, 0.28], material: 'metal'
    });

    // ---- the guard cabin, 2.95 m up ----------------------------------------
    var cab = V.cabin;
    if (cab) {
      var cy2 = cab.y === undefined ? 2.95 : cab.y;
      var cbx = (cab.x0 + cab.x1) * 0.5, cbz = cab.z === undefined ? hz - 1.55 : cab.z;
      this._deskUnit(cbx + 0.35, cbz - 0.35, Math.PI, true, cy2);
      this._drop(this.B.chair, cbx - 0.55, cbz + 0.35, {
        r: 0.40, y: cy2, yaw: 0.9, tilt: 0.02, noClear: true, halo: false, dry: true,
        scale: 0.98
      });
      this._drop(this.B.cup, cbx + 0.62, cbz - 0.32, {
        r: 0.08, y: cy2 + 0.755, tilt: 0.02, noClear: true, halo: false, dry: true,
        stack: true, lens: true
      });
      this._drop(this.B.binder, cbx + 0.05, cbz - 0.40, {
        r: 0.18, y: cy2 + 0.755, yaw: 0.4, tilt: 0.02, noClear: true, halo: false, dry: true,
        stack: true, lens: true
      });
      this._drop(this.B.bin, cbx + 1.55, cbz + 0.30, {
        r: 0.22, y: cy2, yaw: 1.2, tilt: 0.04, noClear: true, halo: false, dry: true
      });
    }

    // ---- stores against the walls ------------------------------------------
    for (i = 0; i < 4; i++) {
      this._drop(this.B.drum, V.x1 - 1.05, -hz + 1.15 + i * 0.64, {
        r: 0.30, yaw: R.range(0, TAU), collider: [0.30, 0.44, 0.30], material: 'metal',
        tilt: 0.02
      });
    }
    this._stack(this.B.crateBig, V.x1 - 2.55, -hz + 1.35, undefined, 2, 1.24, 0.90, 0.92);
    this._stack(this.B.crate, V.x0 + 1.45, hz - 1.05, undefined, 2, 0.78, 0.60, 0.62);
    var py = this._drop(this.B.pallet, V.x0 + 2.65, hz - 1.15, {
      r: 0.74, yaw: R.range(-0.15, 0.15), collider: [0.58, 0.06, 0.48], material: 'wood'
    });
    if (py !== null) {
      for (k = 0; k < 5; k++) {
        this._drop(this.B.sack, V.x0 + 2.65 + R.range(-0.30, 0.30),
          hz - 1.15 + R.range(-0.24, 0.24), {
            r: 0.20, y: py + 0.115 + (k > 2 ? 0.17 : 0), yaw: R.range(0, TAU),
            scale: R.range(0.9, 1.1), noClear: true, halo: false, tilt: 0.11,
            stack: true, lens: true
          });
      }
    }
    this._firePoint(V.x1 - 0.10, -hz + 4.6, -Math.PI * 0.5);
    this._firePoint(V.x0 + 1.60, hz - 0.10, Math.PI);

    // ---- kit dropped where people came through -----------------------------
    for (i = 0; i < 5; i++) {
      var kx = R.range(V.x0 + 2.0, V.x0 + 8.5);
      var kz = (R.bool() ? 1 : -1) * R.range(1.7, 4.6);
      this._drop(this.B.bag, kx, kz, { r: 0.34, yaw: R.range(0, TAU), tilt: 0.08 });
    }
    for (i = 0; i < 16; i++) {
      var qx = R.range(V.x0 + 0.8, V.x1 - 0.8);
      var qz = (R.bool() ? 1 : -1) * (hz - R.range(0.10, 1.10));
      this._paper(qx, this._ground(qx, qz), qz, R.range(0.18, 0.30));
    }
    for (i = 0; i < 10; i++) {
      var fx = R.range(V.x0 + 1.0, V.x1 - 1.0), fz = R.range(-hz + 0.6, hz - 0.6);
      this._floorPatch(R.bool(0.5) ? 3 : 0, fx, this._ground(fx, fz), fz, R.range(1.8, 3.6));
    }
  };

  // ==========================================================================
  // THE APPROACH TUNNEL.  It has come in at the far end, and the story of the
  // spill is the story of the collapse: coarse close to the face, fines running
  // out toward the door, and the things people dropped getting out.
  // ==========================================================================
  PropsBunker.prototype._dressApproach = function () {
    var R = this.rng, N = this.noise;
    var V = this.vest;
    var A = V.approach;
    if (!A) return;
    var i;
    var hz = A.hz;
    var faceX = A.collapse ? A.collapse.x : (A.x0 + 3.4);

    for (i = 0; i < 44; i++) {
      // density falls off away from the face, and the pieces get smaller with it
      var t = Math.pow(R.range(0, 1), 1.7);
      var cx = faceX + 2.2 + t * 7.0;
      if (cx > A.x1 - 0.3) continue;
      var cz = R.gaussian(0, hz * 0.52);
      cz = M.clamp(cz, -hz + 0.25, hz - 0.25);
      this._drop(this.B.chunk, cx, cz, {
        r: 0.16, yaw: R.range(0, TAU), scale: R.range(0.30, 1.5) * (1.25 - t * 0.6),
        tilt: 0.35, halo: false, noClear: true, dry: true
      });
    }
    for (i = 0; i < 5; i++) {
      var px = faceX + R.range(2.4, 6.5);
      this._drop(this.B.plank, px, R.range(-hz + 0.5, hz - 0.5), {
        r: 0.62, yaw: R.range(0, TAU), tilt: 0.22, halo: false, noClear: true
      });
    }
    // two drums that were in the tunnel when it came down
    this._drop(this.B.drum, faceX + 3.35, -hz + 0.85, {
      r: 0.46, yaw: 0.7, tilt: 0, lay: 1.51, sink: -0.29, halo: true, dry: true
    });
    this._drop(this.B.drum, faceX + 5.10, hz - 0.90, {
      r: 0.32, yaw: 2.2, tilt: 0.13, collider: [0.30, 0.44, 0.30], material: 'metal'
    });
    this._drop(this.B.bag, faceX + 6.35, 0.55, { r: 0.34, yaw: 1.9, tilt: 0.10 });
    this._drop(this.B.bucket, faceX + 4.70, 0.95, { r: 0.20, tilt: 0.30 });
    for (i = 0; i < 8; i++) {
      var qx = R.range(faceX + 2.0, A.x1 - 0.6);
      var qz = R.range(-hz + 0.3, hz - 0.3);
      this._paper(qx, this._ground(qx, qz), qz, R.range(0.17, 0.28));
    }
    for (i = 0; i < 6; i++) {
      var gx = R.range(faceX + 1.6, A.x1 - 0.5), gz = R.range(-hz + 0.4, hz - 0.4);
      this._floorPatch(0, gx, this._ground(gx, gz), gz, R.range(2.0, 3.6));
    }
  };

  // ==========================================================================
  // THE DRIFT PASS.
  //
  // Forty years of dust settling out of still air builds a soft wedge against
  // every vertical face in the facility.  It is run LAST of the placement passes
  // so it can bank against the props the earlier passes put down as well as
  // against the walls, and it is the single most valuable thing in this file:
  // without it every wall in the level meets its floor on a hard line, and a
  // hard line is what makes a room read as a model.
  // ==========================================================================
  PropsBunker.prototype._dressDrift = function () {
    var R = this.rng, N = this.noise;
    var self = this;
    var S = this.spine, V = this.vest, C = this.ctl, H = this.hall, P = this.plant;

    // A wall line: (x0,z0)-(x1,z1) with the wall on the side the inward normal
    // points.  `dens` scales how much of the run carries a drift, because a
    // corridor nobody used for forty years banks more than a gallery that was
    // swept.
    function run(x0, z0, x1, z1, nx, nz, dens, sc, yOverride) {
      var dx = x1 - x0, dz = z1 - z0;
      var len = Math.sqrt(dx * dx + dz * dz);
      if (!(len > 0.5)) return;
      var n = Math.max(1, Math.round(len / 1.75));
      // The drift is authored with its HIGH edge at local z = 0, tapering out to
      // z = +0.78.  So local +Z has to map to the INWARD normal - the direction
      // the bank runs out into the room.  Getting this backwards (atan2(-nx,-nz))
      // buries the entire wedge inside the wall it is banked against, which is
      // exactly as invisible as not placing it at all.
      var yaw = Math.atan2(nx, nz);
      for (var i = 0; i < n; i++) {
        var t = (i + R.range(0.15, 0.85)) / n;
        var d = N.fbm2((x0 + dx * t) * 0.31, (z0 + dz * t) * 0.31, 2) * 0.5 + 0.5;
        if (d < 1 - dens) continue;
        var off = R.range(0.02, 0.16);
        var px = x0 + dx * t + nx * off;
        var pz = z0 + dz * t + nz * off;
        var yy = yOverride === undefined ? undefined : yOverride;
        self._drop(self.B.drift, px, pz, {
          r: 0.14, y: yy, yaw: yaw + R.range(-0.10, 0.10),
          scale: (sc || 1) * R.range(0.62, 1.30),
          sy: R.range(0.55, 1.35), sz: R.range(0.75, 1.30),
          tilt: 0.010, halo: false, noClear: true, dry: true, lens: true
        });
      }
    }
    // A corner gets a heavier, taller cone: two walls feed it and nothing sweeps
    // it out.
    function corner(x, z, nx, nz, sc) {
      self._drop(self.B.drift, x + nx * 0.24, z + nz * 0.24, {
        r: 0.14, yaw: Math.atan2(nx, nz) + R.range(-0.3, 0.3),
        scale: (sc || 1) * R.range(0.85, 1.35), sy: R.range(1.1, 1.8),
        tilt: 0.02, halo: false, noClear: true, dry: true, lens: true
      });
    }

    // ---- the spine ---------------------------------------------------------
    run(S.x0 + 0.4, S.hz - 0.02, S.x1 - 0.4, S.hz - 0.02, 0, -1, 0.82, 1.0);
    run(S.x0 + 0.4, -S.hz + 0.02, S.x1 - 0.4, -S.hz + 0.02, 0, 1, 0.82, 1.0);
    // every pilaster is an obstruction, and dust banks on both sides of it
    var nBay = Math.floor((S.x1 - S.x0) / S.beamPitch);
    for (var i = 0; i < nBay; i++) {
      var bx2 = S.x0 + i * S.beamPitch;
      if (bx2 < S.x0 + 1 || bx2 > S.x1 - 1) continue;
      corner(bx2 - 0.28, S.hz - 0.10, 0, -1, 0.55);
      corner(bx2 + 0.28, -S.hz + 0.10, 0, 1, 0.55);
    }

    // ---- the vestibule and its approach ------------------------------------
    run(V.x0 + 0.5, V.hz - 0.02, V.x1 - 0.5, V.hz - 0.02, 0, -1, 0.62, 1.25);
    run(V.x0 + 0.5, -V.hz + 0.02, V.x1 - 0.5, -V.hz + 0.02, 0, 1, 0.62, 1.25);
    run(V.x1 - 0.02, -V.hz + 0.6, V.x1 - 0.02, V.hz - 0.6, -1, 0, 0.55, 1.1);
    corner(V.x1 - 0.30, V.hz - 0.30, -0.7, -0.7, 1.5);
    corner(V.x1 - 0.30, -V.hz + 0.30, -0.7, 0.7, 1.5);
    corner(V.x0 + 0.30, V.hz - 0.30, 0.7, -0.7, 1.5);
    if (V.approach) {
      run(V.approach.x0 + 1.0, V.approach.hz - 0.02, V.approach.x1 - 0.3,
        V.approach.hz - 0.02, 0, -1, 0.90, 1.0);
      run(V.approach.x0 + 1.0, -V.approach.hz + 0.02, V.approach.x1 - 0.3,
        -V.approach.hz + 0.02, 0, 1, 0.90, 1.0);
    }

    // ---- the control room --------------------------------------------------
    run(C.x0 + 0.5, C.z0 + 0.03, C.x1 - 0.5, C.z0 + 0.03, 0, 1, 0.50, 0.9, C.floorY);
    run(C.x0 + 0.5, C.z1 - 0.03, C.x1 - 0.5, C.z1 - 0.03, 0, -1, 0.42, 0.9, C.floorY);
    run(C.x0 + 0.03, C.z0 + 0.6, C.x0 + 0.03, C.z1 - 0.6, 1, 0, 0.50, 0.9, C.floorY);
    run(C.x1 - 0.03, C.z0 + 0.6, C.x1 - 0.03, C.z1 - 0.6, -1, 0, 0.50, 0.9, C.floorY);

    // ---- the plant room ----------------------------------------------------
    run(P.x0 + 0.4, P.z0 + 0.03, P.x1 - 0.4, P.z0 + 0.03, 0, 1, 0.62, 1.0);
    run(P.x0 + 0.03, P.z0 + 0.5, P.x0 + 0.03, P.z1 - 0.5, 1, 0, 0.55, 1.0);

    // ---- the reactor gallery ----------------------------------------------
    run(H.x0 + 0.6, H.hz - 0.03, H.x1 - 0.6, H.hz - 0.03, 0, -1, 0.66, 1.5);
    run(H.x0 + 0.6, -H.hz + 0.03, H.x1 - 0.6, -H.hz + 0.03, 0, 1, 0.66, 1.5);
    run(H.x0 + 0.03, -H.hz + 1.0, H.x0 + 0.03, H.hz - 1.0, 1, 0, 0.60, 1.4);
    run(H.x1 - 0.03, -H.hz + 1.0, H.x1 - 0.03, H.hz - 1.0, -1, 0, 0.60, 1.4);
    corner(H.x0 + 0.4, H.hz - 0.4, 0.7, -0.7, 2.0);
    corner(H.x0 + 0.4, -H.hz + 0.4, 0.7, 0.7, 2.0);
    corner(H.x1 - 0.4, H.hz - 0.4, -0.7, -0.7, 2.0);
    corner(H.x1 - 0.4, -H.hz + 0.4, -0.7, 0.7, 2.0);
    // and the well kerb, which is the strongest obstruction on the deck
    run(H.wellX0 - 0.42, H.wellZ0 + 0.6, H.wellX0 - 0.42, H.wellZ1 - 0.6, -1, 0, 0.52, 1.1);
    run(H.wellX1 + 0.42, H.wellZ0 + 0.6, H.wellX1 + 0.42, H.wellZ1 - 0.6, 1, 0, 0.52, 1.1);
    run(H.wellX0 + 0.8, H.wellZ0 - 0.42, H.wellX1 - 0.8, H.wellZ0 - 0.42, 0, -1, 0.52, 1.1);
    run(H.wellX0 + 0.8, H.wellZ1 + 0.42, H.wellX1 - 0.8, H.wellZ1 + 0.42, 0, 1, 0.52, 1.1);
  };

  // ==========================================================================
  // ONE-OFF PROPS.
  //
  // Anything that appears fewer than about six times is authored here and merged
  // into the shared static batch for its material, so a welding set costs no
  // draw call of its own.  Every one of them exists because a repeated prop
  // cannot do its job: a trolley, a bench and a plotting table are the objects
  // that say a PERSON was here, and a facility dressed only in drums and crates
  // is a warehouse.
  // ==========================================================================

  // A run of cable or hose following the floor, wandering as a dragged line
  // does.  `yAbs` pins it to a deck; otherwise it follows sampleGround.
  PropsBunker.prototype._groundRun = function (key, x0, z0, x1, z1, r, wander, segs, yAbs) {
    var it = new Item();
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 0.05)) return;
    var px = -dz / len, pz = dx / len;
    var seed = this.rng.range(0, 10);
    segs = segs || 8;
    var lx = x0, lz = z0;
    var ly = (yAbs === undefined ? this._ground(x0, z0) : yAbs) + r;
    for (var i = 1; i <= segs; i++) {
      var t = i / segs;
      var off = Math.sin(t * Math.PI * 2.3 + seed) * wander +
        this.noise.fbm2(t * 3.4 + seed, seed, 2) * wander * 0.8;
      var qx = x0 + dx * t + px * off;
      var qz = z0 + dz * t + pz * off;
      var qy = (yAbs === undefined ? this._ground(qx, qz) : yAbs) + r;
      it.tube(key, r, lx, ly, lz, qx, qy, qz, 6);
      lx = qx; lz = qz; ly = qy;
    }
    this._place(it, 0, 0, 0, 0, 1);
  };
  PropsBunker.prototype._cableRun = function (x0, z0, x1, z1, r, segs) {
    this._groundRun('cable', x0, z0, x1, z1, r, 0.30, segs);
  };
  PropsBunker.prototype._hoseSnake = function (x0, z0, x1, z1, y) {
    this._groundRun('rubber', x0, z0, x1, z1, 0.030, 0.42, 9, y);
  };
  // A hose following an arc round the bioshield - the only way a coupled line
  // gets from the manifold to the far side of a drum.
  PropsBunker.prototype._hoseRun = function (sx, sz, cx, cz, r, a0, a1, y) {
    var it = new Item();
    var n = 10;
    var lx = sx, lz = sz;
    for (var i = 1; i <= n; i++) {
      var a = a0 + (a1 - a0) * (i / n);
      var rr = r + Math.sin(i / n * Math.PI) * 0.14;
      var qx = cx + Math.cos(a) * rr, qz = cz + Math.sin(a) * rr;
      it.tube('rubber', 0.030, lx, y + 0.030, lz, qx, y + 0.030, qz, 6);
      lx = qx; lz = qz;
    }
    this._place(it, 0, 0, 0, 0, 1);
  };

  // ---- the welding set: two bottles on a trolley, torch and leads -----------
  PropsBunker.prototype._weldingTrolley = function (x, z, yaw) {
    var it = new Item();
    var i;
    // frame: two uprights, an axle with wheels, a tipping foot, a bottle cradle
    for (i = -1; i <= 1; i += 2) {
      it.strut('steel', i * 0.20, 0.10, -0.06, i * 0.20, 1.02, -0.06, 0.032, 0.032);
      it.cyl('rubber', 0.115, 0.115, 0.045, i * 0.255, 0.115, -0.10,
        0, 0, Math.PI * 0.5, 12);
      it.cyl('steel', 0.045, 0.045, 0.020, i * 0.278, 0.115, -0.10,
        0, 0, Math.PI * 0.5, 8);
    }
    it.box('steel', 0.50, 0.030, 0.34, 0, 0.115, 0.06);
    it.strut('steel', -0.20, 1.02, -0.06, 0.20, 1.02, -0.06, 0.028, 0.028);
    it.strut('steel', -0.20, 0.62, -0.06, 0.20, 0.62, -0.06, 0.024, 0.024);
    it.strut('steel', -0.20, 0.05, 0.22, 0.20, 0.05, 0.22, 0.026, 0.026);
    // the two bottles, strapped in
    for (i = -1; i <= 1; i += 2) {
      it.push(Tn(i * 0.135, 0.13, 0.06, 0.055, 0, 0));
      it.add('ochre', lathe([
        [0.00, 0.00], [0.108, 0.00], [0.115, 0.020], [0.115, 0.96],
        [0.100, 1.05], [0.062, 1.13], [0.034, 1.17], [0.032, 1.20], [0.00, 1.20]
      ], 12, 1.1, 1.5), null);
      it.cyl('steel', 0.045, 0.045, 0.085, 0, 1.235, 0, 0, 0, 0, 10);
      it.cyl('steel', 0.026, 0.026, 0.055, 0.045, 1.245, 0, 0, 0, Math.PI * 0.5, 8);
      it.cyl('steel', 0.070, 0.072, 0.028, 0, 1.155, 0, 0, 0, 0, 12);
      var uv = cellUV(2);
      it.add('marks', card(0.14, 0.20, uv[0], uv[1], uv[2], uv[3]), Tn(0, 0.42, 0.117));
      it.pop();
    }
    it.strut('steel', -0.24, 0.72, 0.12, 0.24, 0.72, 0.12, 0.020, 0.020);
    // the leads, coiled over the frame and paid out onto the deck
    it.sag('rubber', -0.22, 1.00, -0.05, 0.22, 1.00, -0.05, 0.22, 0.017, 5);
    it.sag('rubber', 0.22, 0.86, -0.05, 0.55, 0.03, 0.42, 0.10, 0.017, 5);
    it.sag('cable', -0.22, 0.80, -0.05, -0.62, 0.03, 0.30, 0.12, 0.015, 5);
    // the torch, lying where it was put down
    it.cyl('steel', 0.020, 0.014, 0.24, 0.72, 0.025, 0.55, 0, 0.6, Math.PI * 0.5, 8);
    var s = this._settle(x, z, 0.45, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [0.42, 0.62, 0.34], yaw, 'metal');
    this._occupy(x, z, 0.75);
    this._floorPatch(1, x, s.y, z, 1.6);
  };

  // ---- a part-stripped pipe run, stacked on timber bearers -----------------
  PropsBunker.prototype._pipeStack = function (x, z, yaw) {
    var it = new Item();
    var R = this.rng;
    var i, k;
    for (i = -1; i <= 1; i += 2) {
      it.box('wood', 0.14, 0.10, 1.10, i * 1.05, 0.05, 0);
      it.box('wood', 0.10, 0.16, 0.10, i * 1.05, 0.13, -0.54);
      it.box('wood', 0.10, 0.16, 0.10, i * 1.05, 0.13, 0.54);
    }
    // three courses, each one offset, and the top course short - a stack that
    // is full to the top on every course is a texture, not a stack
    var rows = [5, 4, 2];
    var rr = 0.098;
    for (k = 0; k < rows.length; k++) {
      var y = 0.10 + rr + k * (rr * 1.74);
      var off = (k % 2) ? rr : 0;
      for (i = 0; i < rows[k]; i++) {
        var zz = -((rows[k] - 1) * 0.5) * (rr * 2.05) + i * (rr * 2.05) + off;
        it.cyl('rust', rr, rr, 2.42, 0, y, zz, 0, 0, Math.PI * 0.5, 10);
        it.cyl('rust', rr * 1.22, rr * 1.22, 0.06, -1.21, y, zz, 0, 0, Math.PI * 0.5, 10);
        it.cyl('rust', rr * 1.22, rr * 1.22, 0.06, 1.21, y, zz, 0, 0, Math.PI * 0.5, 10);
      }
    }
    // the strap and the one that rolled off
    it.strut('steel', -1.05, 0.10, -0.60, -1.05, 0.62, -0.60, 0.014, 0.014);
    it.cyl('rust', rr, rr, 2.42, 0.06, rr, -0.86, 0, 0.03, Math.PI * 0.5, 10);
    var s = this._settle(x, z, 1.0, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [1.25, 0.34, 0.62], yaw, 'metal');
    this._occupy(x, z, 1.5);
    this._floorPatch(0, x, s.y, z, 3.0);
  };

  // ---- a scaffold trestle tower --------------------------------------------
  PropsBunker.prototype._trestle = function (x, z, yaw) {
    var it = new Item();
    var i, k;
    var w = 0.90, d = 0.74, h = 2.55;
    for (i = -1; i <= 1; i += 2) {
      for (k = -1; k <= 1; k += 2) {
        it.cyl('steel', 0.024, 0.024, h, i * w * 0.5, h * 0.5, k * d * 0.5, 0, 0, 0, 8);
        it.cyl('steel', 0.040, 0.040, 0.030, i * w * 0.5, 0.015, k * d * 0.5, 0, 0, 0, 8);
      }
    }
    // ledgers, transoms and the diagonal that makes it a tower rather than a
    // table
    for (i = 0; i < 4; i++) {
      var y = 0.42 + i * 0.68;
      if (y > h) break;
      it.tube('steel', 0.020, -w * 0.5, y, -d * 0.5, w * 0.5, y, -d * 0.5, 7);
      it.tube('steel', 0.020, -w * 0.5, y, d * 0.5, w * 0.5, y, d * 0.5, 7);
      it.tube('steel', 0.020, -w * 0.5, y, -d * 0.5, -w * 0.5, y, d * 0.5, 7);
    }
    it.tube('steel', 0.018, -w * 0.5, 0.42, -d * 0.5, w * 0.5, 2.46, -d * 0.5, 7);
    it.tube('steel', 0.018, w * 0.5, 0.42, d * 0.5, -w * 0.5, 2.46, d * 0.5, 7);
    // the boarded platform, two scaffold boards with a gap between them
    for (i = -1; i <= 1; i += 2) {
      it.box('wood', w + 0.14, 0.038, 0.30, 0, 1.80, i * 0.17);
    }
    it.box('wood', w + 0.14, 0.038, 0.30, 0, 2.48, -0.17);
    // a bucket and a coil of flex left on the platform
    it.add('red', lathe([
      [0.00, 0.000], [0.100, 0.000], [0.104, 0.012], [0.138, 0.250],
      [0.146, 0.264], [0.140, 0.272], [0.132, 0.256], [0.098, 0.020], [0.00, 0.020]
    ], 12, 1, 1), Tn(0.20, 1.82, -0.15));
    for (i = 0; i < 3; i++) {
      var Rr = 0.16 + i * 0.035;
      var px = null, pz = null;
      for (k = 0; k <= 10; k++) {
        var a = k / 10 * TAU;
        var qx = -0.24 + Math.cos(a) * Rr, qz = 0.16 + Math.sin(a) * Rr;
        if (px !== null) it.tube('cable', 0.014, px, 1.836 + i * 0.022, pz,
          qx, 1.836 + i * 0.022, qz, 5);
        px = qx; pz = qz;
      }
    }
    var s = this._settle(x, z, 0.55, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [w * 0.55, 1.28, d * 0.55], yaw, 'metal');
    this._occupy(x, z, 0.85);
    this._floorPatch(0, x, s.y, z, 2.2);
  };

  // ---- a cylinder rack ------------------------------------------------------
  PropsBunker.prototype._cylinderRack = function (x, z, yaw) {
    var it = new Item();
    it.box('steel', 1.45, 0.055, 0.055, 0, 1.02, -0.13);
    it.box('steel', 0.045, 1.05, 0.045, -0.70, 0.525, -0.13);
    it.box('steel', 0.045, 1.05, 0.045, 0.70, 0.525, -0.13);
    it.box('steel', 1.45, 0.030, 0.030, 0, 0.36, -0.13);
    it.tube('cable', 0.012, -0.66, 0.98, -0.10, 0.66, 0.98, -0.10, 6);
    var s = this._settle(x, z, 0.6, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
  };

  // ---- a wall fire point ----------------------------------------------------
  // The extinguisher and the bucket are instanced; the board, the bracket and
  // the placard are one-offs.  A fire point is one of the few places in a
  // facility where you are guaranteed a saturated red at eye height, which is
  // exactly what a grey corridor needs.
  PropsBunker.prototype._firePoint = function (x, z, yaw) {
    var it = new Item();
    var nx = Math.sin(yaw), nz = Math.cos(yaw);
    // backboard, standing proud of the wall on battens
    it.box('red', 1.05, 0.85, 0.030, 0, 1.28, 0.030);
    it.box('wood', 0.06, 0.80, 0.022, -0.48, 1.28, 0.012);
    it.box('wood', 0.06, 0.80, 0.022, 0.48, 1.28, 0.012);
    // the bracket the extinguisher hangs on, and the bucket rail
    it.box('steel', 0.13, 0.030, 0.10, -0.29, 0.98, 0.085);
    it.box('steel', 0.13, 0.030, 0.10, -0.29, 1.32, 0.085);
    it.tube('steel', 0.014, 0.02, 1.02, 0.115, 0.52, 1.02, 0.115, 6);
    it.box('steel', 0.024, 0.16, 0.024, 0.02, 1.10, 0.10);
    it.box('steel', 0.024, 0.16, 0.024, 0.52, 1.10, 0.10);
    var uv = cellUV(3);
    it.add('marks', card(0.34, 0.26, uv[0], uv[1], uv[2], uv[3]), Tn(0.10, 1.55, 0.034));
    this._place(it, x, this._ground(x, z), z, yaw, 1);
    // the extinguisher on its bracket
    this._drop(this.B.exting, x - nz * 0.29 + nx * 0.10, z + nx * 0.29 + nz * 0.10, {
      r: 0.12, y: this._ground(x, z) + 0.90, yaw: yaw + Math.PI, tilt: 0.010,
      noClear: true, halo: false, dry: true, stack: true, lens: true
    });
    // and the two buckets hung on the rail, one of them missing
    this._drop(this.B.bucket, x + nz * 0.14 + nx * 0.12, z - nx * 0.14 + nz * 0.12, {
      r: 0.14, y: this._ground(x, z) + 0.72, yaw: yaw, tilt: 0.06,
      noClear: true, halo: false, dry: true, lay: 0.12, stack: true, lens: true
    });
    this._occupy(x + nx * 0.2, z + nz * 0.2, 0.55);
  };

  // ---- the lifting tackle under the crane -----------------------------------
  PropsBunker.prototype._liftTackle = function (x, z, yaw) {
    var it = new Item();
    var i;
    // a spreader beam on timber packers
    it.box('steel', 3.20, 0.24, 0.20, 0, 0.24, 0);
    it.box('steel', 0.24, 0.34, 0.20, -1.52, 0.29, 0);
    it.box('steel', 0.24, 0.34, 0.20, 1.52, 0.29, 0);
    it.box('wood', 0.30, 0.12, 0.42, -1.20, 0.06, 0);
    it.box('wood', 0.30, 0.12, 0.42, 1.20, 0.06, 0);
    for (i = -1; i <= 1; i += 2) {
      it.cyl('steel', 0.070, 0.070, 0.055, i * 1.52, 0.44, 0, 0, 0, Math.PI * 0.5, 10);
    }
    // shackles and a heap of chain sling on the deck
    for (i = 0; i < 12; i++) {
      var a = i / 12 * TAU * 1.6;
      var rr = 0.30 + i * 0.018;
      it.cyl('steel', 0.036, 0.036, 0.020, 1.05 + Math.cos(a) * rr, 0.020 + (i % 3) * 0.012,
        0.85 + Math.sin(a) * rr, Math.PI * 0.5, a, 0, 8);
    }
    it.sag('steel', -1.52, 0.44, 0, -0.95, 0.03, 0.72, 0.05, 0.020, 5);
    var s = this._settle(x, z, 1.2, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [1.65, 0.24, 0.30], yaw, 'metal');
    this._occupy(x, z, 1.7);
    this._floorPatch(0, x, s.y, z, 3.2);
  };

  // ---- the instrument cart on the operating platform ------------------------
  PropsBunker.prototype._instrumentCart = function (x, z, yaw) {
    var it = new Item();
    var i;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 0.28 : -0.28, sz = (i & 2) ? 0.20 : -0.20;
      it.cyl('rubber', 0.048, 0.048, 0.026, sx, 0.048, sz, 0, 0, Math.PI * 0.5, 8);
      it.strut('steel', sx, 0.075, sz, sx, 0.86, sz, 0.024, 0.024);
    }
    it.box('steel', 0.66, 0.026, 0.50, 0, 0.42, 0);
    it.box('steel', 0.66, 0.026, 0.50, 0, 0.755, 0);
    it.box('steel', 0.66, 0.030, 0.030, 0, 0.94, -0.20);
    // the instrument itself: a bakelite case with a meter face and a lamp
    it.box('green', 0.50, 0.26, 0.36, 0, 0.895, 0.02);
    it.box('cream', 0.20, 0.14, 0.020, -0.10, 0.915, 0.202);
    it.cyl('steel', 0.034, 0.034, 0.026, 0.14, 0.915, 0.202, Math.PI * 0.5, 0, 0, 10);
    it.cyl('steel', 0.020, 0.020, 0.022, 0.14, 0.985, 0.202, Math.PI * 0.5, 0, 0, 8);
    it.sag('cable', 0.20, 0.87, -0.16, 0.55, 0.02, -0.60, 0.14, 0.014, 5);
    // spares on the lower shelf
    it.box('cream', 0.22, 0.075, 0.17, -0.14, 0.470, 0.04);
    it.box('cream', 0.20, 0.060, 0.15, 0.14, 0.462, -0.02);
    var s = this._settle(x, z, 0.35, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [0.34, 0.50, 0.28], yaw, 'metal');
    this._occupy(x, z, 0.62);
  };

  // ---- an access ladder standing in the flood -------------------------------
  PropsBunker.prototype._ladder = function (x, z, yaw, len) {
    var it = new Item();
    var i;
    var lean = 0.26;
    for (i = -1; i <= 1; i += 2) {
      it.strut('steel', i * 0.19, 0, 0, i * 0.19, len * Math.cos(lean), len * Math.sin(lean),
        0.045, 0.028);
    }
    var n = Math.floor(len / 0.30);
    for (i = 1; i < n; i++) {
      var t = i / n;
      it.tube('steel', 0.016, -0.19, len * Math.cos(lean) * t, len * Math.sin(lean) * t,
        0.19, len * Math.cos(lean) * t, len * Math.sin(lean) * t, 7);
    }
    var y = this._ground(x, z);
    this._place(it, x, y, z, yaw, 1);
    this._occupy(x, z, 0.45);
  };

  // ---- a two-wheeled sack trolley, tipped over ------------------------------
  PropsBunker.prototype._trolley = function (x, z, yaw, tipped) {
    var it = new Item();
    var i;
    for (i = -1; i <= 1; i += 2) {
      it.strut('steel', i * 0.22, 0.02, 0, i * 0.20, 1.18, -0.16, 0.030, 0.030);
      it.cyl('rubber', 0.115, 0.115, 0.048, i * 0.265, 0.115, 0.02,
        0, 0, Math.PI * 0.5, 12);
      it.cyl('steel', 0.040, 0.040, 0.022, i * 0.290, 0.115, 0.02, 0, 0, Math.PI * 0.5, 8);
    }
    it.box('steel', 0.50, 0.022, 0.22, 0, 0.035, 0.14);
    for (i = 0; i < 3; i++) {
      it.tube('steel', 0.018, -0.215, 0.30 + i * 0.40, -0.04 - i * 0.055,
        0.215, 0.30 + i * 0.40, -0.04 - i * 0.055, 7);
    }
    it.tube('steel', 0.020, -0.20, 1.18, -0.16, 0.20, 1.18, -0.16, 7);
    var y = this._ground(x, z);
    // tipped: rolled onto its back, which is how a sack trolley is always found
    this._place(it, x, y + (tipped ? 0.24 : 0), z, yaw, 1, 0, tipped ? -1.42 : 0);
    this._occupy(x, z, tipped ? 0.75 : 0.45);
    this._floorPatch(3, x, y, z, 1.6);
  };

  // ---- a notice board with its paper still on it ---------------------------
  PropsBunker.prototype._noticeBoard = function (x, z, yaw, w, h, y) {
    var it = new Item();
    var R = this.rng;
    it.box('wood', w, h, 0.026, 0, 0, 0.013);
    it.box('steel', w + 0.03, 0.026, 0.034, 0, h * 0.5, 0.020);
    it.box('steel', w + 0.03, 0.026, 0.034, 0, -h * 0.5, 0.020);
    var n = 4 + R.int(0, 3);
    for (var i = 0; i < n; i++) {
      var pw = R.range(0.17, 0.28);
      var uv = cellUV(R.int(0, 3));
      it.add('paper', card(pw, pw * R.range(0.7, 1.15), uv[0], uv[1], uv[2], uv[3]),
        Tn(R.range(-w * 0.36, w * 0.36), R.range(-h * 0.30, h * 0.24), 0.029,
          0, 0, R.range(-0.14, 0.14)));
    }
    this._place(it, x, y, z, yaw, 1);
  };

  // ---- a wall telephone -----------------------------------------------------
  PropsBunker.prototype._telephone = function (x, z, yaw, y) {
    var it = new Item();
    it.box('green', 0.20, 0.30, 0.115, 0, 0, 0.058);
    it.box('green', 0.15, 0.055, 0.075, 0, 0.175, 0.040);
    it.cyl('cream', 0.030, 0.030, 0.19, -0.115, -0.02, 0.075, 0, 0, 0.10, 8);
    it.cyl('cream', 0.042, 0.042, 0.030, -0.122, 0.068, 0.075, 0, 0, 0.10, 8);
    it.cyl('cream', 0.042, 0.042, 0.030, -0.108, -0.108, 0.075, 0, 0, 0.10, 8);
    // the curly cord, which is the only thing that makes it read as a telephone
    it.sag('cable', -0.115, -0.10, 0.075, 0.02, -0.14, 0.075, 0.14, 0.010, 5);
    this._place(it, x, y, z, yaw, 1);
  };

  // ---- the plotting table ---------------------------------------------------
  PropsBunker.prototype._plotTable = function (x, z, yaw, fy) {
    var it = new Item();
    var R = this.rng;
    var i;
    var w = 1.85, d = 1.15, h = 0.90;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      it.box('steel', 0.055, h - 0.06, 0.055, sx * (w * 0.5 - 0.09), (h - 0.06) * 0.5,
        sz * (d * 0.5 - 0.09));
    }
    it.strut('steel', -w * 0.5 + 0.09, 0.18, -d * 0.5 + 0.09, w * 0.5 - 0.09, 0.18, -d * 0.5 + 0.09, 0.026, 0.026);
    it.strut('steel', -w * 0.5 + 0.09, 0.18, d * 0.5 - 0.09, w * 0.5 - 0.09, 0.18, d * 0.5 - 0.09, 0.026, 0.026);
    // a sloped drawing top with a ledge, and the chart pinned to it
    it.boxR('wood', w, 0.040, d, 0, h - 0.02, 0, -0.13, 0, 0);
    it.box('steel', w, 0.030, 0.038, 0, h - 0.09, d * 0.5 - 0.01);
    for (i = 0; i < 3; i++) {
      var uv = cellUV(i === 1 ? 2 : 1);
      it.add('paper', card(R.range(0.42, 0.62), R.range(0.34, 0.48),
        uv[0], uv[1], uv[2], uv[3]),
        Tn(R.range(-0.55, 0.55), h + 0.005, R.range(-0.30, 0.20),
          -Math.PI * 0.5 - 0.13, R.range(-0.25, 0.25), 0));
    }
    // an anglepoise clamped to the ledge, dead
    it.cyl('steel', 0.030, 0.030, 0.075, w * 0.5 - 0.16, h + 0.02, -d * 0.5 + 0.10, 0, 0, 0, 8);
    it.strut('steel', w * 0.5 - 0.16, h + 0.06, -d * 0.5 + 0.10,
      w * 0.5 - 0.38, h + 0.44, -d * 0.5 + 0.22, 0.016, 0.016);
    it.strut('steel', w * 0.5 - 0.38, h + 0.44, -d * 0.5 + 0.22,
      w * 0.5 - 0.62, h + 0.28, -d * 0.5 + 0.40, 0.016, 0.016);
    it.add('cream', lathe([
      [0.00, 0.00], [0.085, -0.075], [0.088, -0.082], [0.020, -0.006], [0.00, 0.00]
    ], 12, 1, 1), Tn(w * 0.5 - 0.64, h + 0.28, -d * 0.5 + 0.42, 0.5, 0, 0));
    this._place(it, x, fy, z, yaw, 1);
    this._collider(x, fy, z, [w * 0.5, h * 0.5, d * 0.5], yaw, 'metal');
    this._occupy(x, z, 1.25);
  };

  // ---- a coat stand with one coat still on it ------------------------------
  PropsBunker.prototype._coatStand = function (x, z, fy) {
    var it = new Item();
    var i;
    for (i = 0; i < 3; i++) {
      var a = i / 3 * TAU;
      it.strut('steel', 0, 0.02, 0, Math.cos(a) * 0.24, 0.11, Math.sin(a) * 0.24, 0.028, 0.028);
    }
    it.cyl('steel', 0.024, 0.024, 1.72, 0, 0.88, 0, 0, 0, 0, 8);
    for (i = 0; i < 4; i++) {
      var b = i / 4 * TAU + 0.4;
      it.strut('steel', 0, 1.70, 0, Math.cos(b) * 0.14, 1.78, Math.sin(b) * 0.14, 0.018, 0.018);
      it.add('steel', sph(0.020, 6, 5), Tn(Math.cos(b) * 0.15, 1.79, Math.sin(b) * 0.15));
    }
    // the coat: a drape with shoulders, hanging off one hook
    var g = drape(0.52, 1.05, 0.055, 5, this.noise, 3.7);
    it.add('canvas', g, Tn(0.13, 1.66, 0.10, 0, 0.7, 0));
    it.box('canvas', 0.44, 0.10, 0.16, 0.13, 1.62, 0.10, 0.02);
    this._place(it, x, fy, z, this.rng.range(0, TAU), 1);
    this._occupy(x, z, 0.40);
  };

  // ---- a side table with the urn on it -------------------------------------
  PropsBunker.prototype._sideTable = function (x, z, fy) {
    var it = new Item();
    var i;
    for (i = 0; i < 4; i++) {
      var sx = (i & 1) ? 1 : -1, sz = (i & 2) ? 1 : -1;
      it.box('steel', 0.040, 0.72, 0.040, sx * 0.34, 0.36, sz * 0.24);
    }
    it.box('wood', 0.80, 0.036, 0.56, 0, 0.738, 0);
    it.box('steel', 0.72, 0.020, 0.48, 0, 0.20, 0);
    // the urn
    it.add('steel', lathe([
      [0.00, 0.000], [0.115, 0.000], [0.120, 0.020], [0.118, 0.055],
      [0.148, 0.085], [0.150, 0.375], [0.140, 0.400], [0.100, 0.415],
      [0.070, 0.442], [0.068, 0.452], [0.00, 0.452]
    ], 16, 1.1, 1.2), Tn(-0.16, 0.756, 0.02));
    it.cyl('steel', 0.020, 0.020, 0.075, -0.16 + 0.145, 0.86, 0.02, 0, 0, Math.PI * 0.42, 8);
    it.tube('cream', 0.010, -0.16 - 0.145, 0.94, 0.02, -0.16 - 0.20, 0.98, 0.02, 6);
    it.add('cream', lathe([
      [0.00, 0.000], [0.036, 0.000], [0.040, 0.008], [0.042, 0.086],
      [0.038, 0.092], [0.00, 0.092]
    ], 10, 1, 1), Tn(0.20, 0.756, -0.10));
    it.add('cream', lathe([
      [0.00, 0.000], [0.036, 0.000], [0.040, 0.008], [0.042, 0.086],
      [0.038, 0.092], [0.00, 0.092]
    ], 10, 1, 1), Tn(0.28, 0.756, 0.08));
    it.sag('cable', -0.30, 0.75, 0.02, -0.55, 0.02, 0.30, 0.12, 0.012, 5);
    this._place(it, x, fy, z, this.rng.range(-0.3, 0.3), 1);
    this._collider(x, fy, z, [0.42, 0.38, 0.30], 0, 'metal');
    this._occupy(x, z, 0.62);
  };

  // ---- a workbench with a vice and a tool board ----------------------------
  PropsBunker.prototype._workbench = function (x, z, yaw) {
    var it = new Item();
    var R = this.rng;
    var i;
    var w = 2.10, d = 0.72, h = 0.88;
    for (i = -1; i <= 1; i += 2) {
      it.box('steel', 0.075, h - 0.06, 0.075, i * (w * 0.5 - 0.12), (h - 0.06) * 0.5, -d * 0.5 + 0.10);
      it.box('steel', 0.075, h - 0.06, 0.075, i * (w * 0.5 - 0.12), (h - 0.06) * 0.5, d * 0.5 - 0.10);
      it.strut('steel', i * (w * 0.5 - 0.12), 0.24, -d * 0.5 + 0.10,
        i * (w * 0.5 - 0.12), 0.24, d * 0.5 - 0.10, 0.030, 0.030);
    }
    it.strut('steel', -w * 0.5 + 0.12, 0.24, 0, w * 0.5 - 0.12, 0.24, 0, 0.030, 0.030);
    // a timber top, scarred
    it.box('wood', w, 0.062, d, 0, h - 0.03, 0);
    it.box('steel', w, 0.026, 0.030, 0, h - 0.075, d * 0.5 + 0.006);
    // the vice
    it.box('steel', 0.16, 0.12, 0.13, -w * 0.5 + 0.30, h + 0.06, -0.05);
    it.box('steel', 0.14, 0.10, 0.10, -w * 0.5 + 0.30, h + 0.05, 0.07);
    it.cyl('steel', 0.020, 0.020, 0.30, -w * 0.5 + 0.30, h + 0.07, 0.16,
      Math.PI * 0.5, 0, Math.PI * 0.5, 8);
    // the tool board behind it
    it.box('wood', w * 0.8, 0.90, 0.024, 0, h + 0.48, -d * 0.5 - 0.012);
    for (i = 0; i < 9; i++) {
      var tx = -w * 0.36 + i * (w * 0.72 / 8);
      var tl = R.range(0.16, 0.34);
      it.box('steel', R.range(0.020, 0.042), tl, 0.018, tx, h + 0.66 - tl * 0.5,
        -d * 0.5 + 0.004);
    }
    // under the bench: a bin, a drum of swarf, offcuts
    it.add('steel', lathe([
      [0.00, 0.000], [0.150, 0.000], [0.186, 0.400], [0.192, 0.418],
      [0.178, 0.416], [0.144, 0.020], [0.00, 0.020]
    ], 12, 1, 1), Tn(w * 0.5 - 0.42, 0.0, 0.02));
    it.box('wood', 0.42, 0.045, 0.10, -0.30, 0.022, 0.10, 0.006);
    it.box('wood', 0.34, 0.045, 0.10, -0.22, 0.022, -0.06, 0.006);
    var s = this._settle(x, z, 0.9, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._collider(x, s.y, z, [w * 0.5, h * 0.5, d * 0.5], yaw, 'metal');
    this._occupy(x, z, 1.3);
    this._floorPatch(1, x, s.y, z, 2.2);
  };

  // ---- a desk with a log book and a lamp -----------------------------------
  PropsBunker.prototype._deskUnit = function (x, z, yaw, small, yAbs) {
    var it = new Item();
    var R = this.rng;
    var i;
    var w = small ? 1.15 : 1.55, d = small ? 0.60 : 0.72, h = 0.755;
    it.box('green', w, h - 0.05, d, 0, (h - 0.05) * 0.5, 0);
    it.box('wood', w + 0.05, 0.045, d + 0.05, 0, h - 0.02, 0);
    // a drawer stack that is not closed
    for (i = 0; i < 3; i++) {
      it.box('green', w * 0.36, 0.17, 0.030, w * 0.26,
        h - 0.16 - i * 0.20, d * 0.5 + 0.016 + (i === 1 ? 0.10 : 0));
      it.box('steel', 0.11, 0.022, 0.022, w * 0.26,
        h - 0.16 - i * 0.20, d * 0.5 + 0.034 + (i === 1 ? 0.10 : 0));
    }
    it.box('green', w - 0.04, 0.04, 0.024, -w * 0.02, 0.06, d * 0.5 + 0.006);
    // the log book, open, and a pen tray
    var uv = cellUV(0);
    it.add('cream', bx(0.34, 0.030, 0.25, 0.004), Tn(-w * 0.22, h + 0.016, 0.02, 0, 0.24, 0));
    it.add('paper', card(0.30, 0.22, uv[0], uv[1], uv[2], uv[3]),
      Tn(-w * 0.22, h + 0.033, 0.02, -Math.PI * 0.5, 0.24, 0));
    it.box('steel', 0.16, 0.020, 0.05, w * 0.30, h + 0.012, -0.14);
    if (!small) {
      // the desk lamp
      it.cyl('steel', 0.075, 0.080, 0.020, w * 0.34, h + 0.012, 0.12, 0, 0, 0, 10);
      it.strut('steel', w * 0.34, h + 0.02, 0.12, w * 0.30, h + 0.34, 0.02, 0.016, 0.016);
      it.add('green', lathe([
        [0.00, 0.00], [0.095, -0.085], [0.098, -0.092], [0.024, -0.008], [0.00, 0.00]
      ], 12, 1, 1), Tn(w * 0.30, h + 0.34, 0.02, 0.62, 0, 0));
    }
    var yy = yAbs === undefined ? this._ground(x, z) : yAbs;
    this._place(it, x, yy, z, yaw, 1);
    this._collider(x, yy, z, [w * 0.5, h * 0.5, d * 0.5], yaw, 'metal');
    this._occupy(x, z, w * 0.6);
  };

  // ---- a headset abandoned on a console ------------------------------------
  PropsBunker.prototype._headset = function (x, y, z) {
    var it = new Item();
    var i;
    for (i = 0; i <= 8; i++) {
      var a = Math.PI * (i / 8);
      var b = Math.PI * ((i + 1) / 8);
      it.tube('cable', 0.008,
        Math.cos(a) * 0.085, 0.012 + Math.sin(a) * 0.020, Math.sin(a) * 0.055,
        Math.cos(b) * 0.085, 0.012 + Math.sin(b) * 0.020, Math.sin(b) * 0.055, 5);
    }
    it.cyl('cable', 0.036, 0.036, 0.024, -0.085, 0.014, 0, 0, 0, Math.PI * 0.5, 10);
    it.cyl('cable', 0.036, 0.036, 0.024, 0.085, 0.014, 0, 0, 0, Math.PI * 0.5, 10);
    it.sag('cable', 0.085, 0.012, 0.02, 0.42, 0.006, 0.18, 0.008, 0.006, 5);
    this._place(it, x, y, z, this.rng.range(0, TAU), 1);
  };

  // ---- a sandbag revetment --------------------------------------------------
  // Stretcher bond: each course offset by half a bag, each bag yawed and sunk
  // into the one below.  A wall of bags standing in a grid is the single most
  // obvious "instanced prop" tell there is.
  PropsBunker.prototype._sandbagWall = function (x0, z0, x1, z1, courses, bagH) {
    var R = this.rng;
    var dx = x1 - x0, dz = z1 - z0;
    var len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 0.2)) return;
    var ux = dx / len, uz = dz / len;
    // A bag is laid as a STRETCHER - long axis along the run - so the pitch is
    // the bag's own length plus a slump allowance, not an arbitrary number.
    var yaw = Math.atan2(ux, uz) + Math.PI * 0.5;
    var per = 0.40;
    var n = Math.max(2, Math.round(len / per));
    var baseY = this._ground((x0 + x1) * 0.5, (z0 + z1) * 0.5);
    for (var c = 0; c < courses; c++) {
      // the top course is short at both ends, so the wall has a real profile
      var i0 = c === courses - 1 ? 1 : 0;
      var i1 = c === courses - 1 ? n - 1 : n;
      var off = (c % 2) ? 0.5 : 0.0;
      for (var i = i0; i < i1; i++) {
        var t = (i + 0.5 + off) / n;
        if (t > 1.02) continue;
        var px = x0 + dx * t + R.gaussian(0, 0.035);
        var pz = z0 + dz * t + R.gaussian(0, 0.035);
        this._drop(this.B.sack, px, pz, {
          r: 0.15, y: baseY + c * bagH + R.range(-0.010, 0.010),
          yaw: yaw + R.gaussian(0, 0.15), tilt: 0.05,
          scale: R.range(0.94, 1.10), sy: R.range(0.88, 1.08),
          noClear: true, halo: c === 0, dry: true, lens: true, stack: c > 0
        });
      }
    }
    this._collider((x0 + x1) * 0.5, baseY, (z0 + z1) * 0.5,
      [len * 0.5, courses * bagH * 0.44, 0.24], yaw, 'sandbag');
  };

  // ---- a rail of hung coveralls --------------------------------------------
  // The only soft prop above the water line, and the only thing the ventilation
  // draught has to act on - see update().
  PropsBunker.prototype._coverallRail = function (x, z, y, n) {
    var R = this.rng;
    var it = new Item();
    it.tube('steel', 0.018, -0.95, y, 0, 0.95, y, 0, 7);
    it.strut('steel', -0.92, y, 0, -0.92, y + 0.42, 0, 0.016, 0.016);
    it.strut('steel', 0.92, y, 0, 0.92, y + 0.42, 0, 0.016, 0.016);
    it.box('steel', 0.10, 0.030, 0.09, -0.92, y + 0.42, -0.03);
    it.box('steel', 0.10, 0.030, 0.09, 0.92, y + 0.42, -0.03);
    this._place(it, x, 0, z, 0, 1);

    if (!this.B.coverall) {
      var g = drape(0.56, 1.30, 0.070, 6, this.noise, 5.9);
      Geo.worldUV(g, this._uvScale('canvas_awning', 500));
      Geo.copyUV1(g);
      paintWear(g, { dust: 0.30, edge: 0.16, grime: 0.52, noise: this.noise,
        seed: 3.4, loY: -1.3, hiY: 0.1 });
      this.B.coverall = new Batch(g, this.mats.canvas, 16, true);
      this.B.coverall.mesh.material.side = THREE.DoubleSide;
      this.B.coverall.label = 'bunker_coveralls';
      this._batches.push(this.B.coverall);
    }
    for (var i = 0; i < n; i++) {
      var px = x - 0.72 + i * (1.44 / Math.max(1, n - 1));
      var yaw = R.range(-0.35, 0.35);
      this.B.coverall.add(T(px, y - 0.045, z, 0, yaw, 0,
        R.range(0.92, 1.08), R.range(0.92, 1.05), 1), wearTint(R));
      this._drapes.push({ x: px, y: y - 0.045, z: z, yaw: yaw,
        phase: R.range(0, TAU), sx: 1, sy: 1 });
      // the hanger
      var it2 = new Item();
      it2.tube('steel', 0.007, -0.16, 0.02, 0, 0, 0.055, 0, 5);
      it2.tube('steel', 0.007, 0, 0.055, 0, 0.16, 0.02, 0, 5);
      it2.tube('steel', 0.007, 0, 0.055, 0, 0.005, 0.10, 0, 5);
      this._place(it2, px, y - 0.055, z, yaw, 1);
    }
  };

  // ---- a pair of boots left at the step-over line --------------------------
  PropsBunker.prototype._boots = function (x, z, yaw) {
    var it = new Item();
    for (var i = -1; i <= 1; i += 2) {
      it.push(Tn(i * 0.075, 0, 0, 0, i * 0.10, 0));
      it.box('rubber', 0.105, 0.055, 0.27, 0, 0.028, 0.010, 0.014);
      it.box('rubber', 0.098, 0.115, 0.145, 0, 0.108, -0.050, 0.014);
      it.box('rubber', 0.108, 0.020, 0.28, 0, 0.008, 0.010, 0.006);
      it.pop();
    }
    var s = this._settle(x, z, 0.16, yaw, _set);
    this._place(it, x, s.y, z, yaw, 1, s.rz, s.rx);
    this._occupy(x, z, 0.22);
  };

  // ==========================================================================
  // WATER.  The only thing in this facility that is still moving.
  //
  // Drips arrive through the gallery soffit and through the well kerb, fall
  // 9-15 m, and land on the flood.  The streaks are additive and faint - a drip
  // lit by a failing fluorescent is a highlight on a thread of water, never a
  // white bar - and each one owns a ripple ring that expands and fades where it
  // lands, which is what makes the standing water read as a surface rather than
  // as a dark floor.
  // ==========================================================================
  PropsBunker.prototype._dressWater = function () {
    var R = this.rng;
    var L = this.lower, H = this.hall, W = this.reactor;
    var i;
    var DRIP = [];
    // from the gallery soffit, down the full 15 m into the well
    for (i = 0; i < 7; i++) {
      var dx = R.range(L.x0 + 1.2, L.x1 - 1.2);
      var dz = R.range(L.z0 + 1.2, L.z1 - 1.2);
      if (Math.sqrt((dx - W.centre.x) * (dx - W.centre.x) +
        (dz - W.centre.z) * (dz - W.centre.z)) < W.bioR + 1.2) continue;
      DRIP.push([dx, dz, H.ceil - 0.7, this.waterY]);
    }
    // and off the kerb nosing, which is where a leak on the deck actually goes
    for (i = 0; i < 5; i++) {
      DRIP.push([L.x0 + 0.12, R.range(L.z0 + 2, L.z1 - 2), -0.15, this.waterY]);
      DRIP.push([L.x1 - 0.12, R.range(L.z0 + 2, L.z1 - 2), -0.15, this.waterY]);
    }
    for (i = 0; i < DRIP.length; i++) {
      var d = DRIP[i];
      var h = d[2] - d[3];
      if (!(h > 0.4)) continue;
      var w = 0.055 + R.range(0, 0.030);
      // a cross of two quads, so the thread reads from any angle
      this._dripParts.push(part(card(w, h, 0, 0, 1, h * 0.5), Tn(d[0], d[3], d[1])));
      this._dripParts.push(part(card(w, h, 0, 0, 1, h * 0.5),
        Tn(d[0], d[3], d[1], 0, Math.PI * 0.5, 0)));
      if (this.B.ring && this.B.ring.n < this.B.ring.max) {
        this._rings.push({ x: d[0], y: this.waterY + 0.014, z: d[1], phase: R.range(0, 1) });
        this.B.ring.add(T(d[0], this.waterY + 0.014, d[1], 0, 0, 0, 0.3, 1, 0.3), WHITE);
      }
    }
    // a couple in the corridor too, from the cable-tray fixings
    var S = this.spine;
    for (i = 0; i < 3; i++) {
      var sx = S.x0 + 6.0 + i * 12.0;
      if (sx > S.x1 - 2) break;
      var sz = (i % 2 ? 1 : -1) * (S.hz - 0.55);
      var gy = this._ground(sx, sz);
      this._dripParts.push(part(card(0.045, S.ceil - 0.5 - gy, 0, 0, 1, 1.6),
        Tn(sx, gy, sz)));
      this._floorPatch(2, sx, gy, sz, 1.1);
    }
  };

  // ==========================================================================
  // DUST IN THE BEAMS.
  //
  // The brief asks for it by name and it is what says the AIR is dirty rather
  // than just the surfaces.  Motes are seeded INSIDE the published light shafts
  // and around the fittings that still strike, never uniformly through the
  // volume: dust is everywhere, but you can only see the dust that is in a beam,
  // and a uniform field is indistinguishable from a dirty lens.
  // ==========================================================================
  PropsBunker.prototype._dressMotes = function () {
    var R = this.rng;
    var MAX = 900;
    var pos = [], col = [], base = [];
    var i, k;
    var c = new THREE.Color();

    function push(x, y, z, bright) {
      if (pos.length / 3 >= MAX) return;
      pos.push(x, y, z);
      // warm, because every source down here that is not the alarm is a
      // fluorescent seen through forty years of dust
      c.setRGB(bright * R.range(0.80, 1.0), bright * R.range(0.72, 0.92),
        bright * R.range(0.55, 0.76));
      col.push(c.r, c.g, c.b);
      base.push(x, y, z, R.range(0, TAU));
    }

    // ---- inside the published shafts ---------------------------------------
    var sh = this.shafts || [];
    for (i = 0; i < sh.length; i++) {
      var s = sh[i];
      if (!s || !s.origin || !s.dir) continue;
      var o = s.origin, d = s.dir;
      var dl = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
      var ux = d.x / dl, uy = d.y / dl, uz = d.z / dl;
      // an orthonormal pair across the beam
      var ax = -uz, az = ux;
      var al = Math.sqrt(ax * ax + az * az) || 1;
      ax /= al; az /= al;
      var bx2 = uy * az, by2 = uz * ax - ux * az, bz2 = -uy * ax;
      var n = Math.round(58 + (s.width || 2) * 22);
      for (k = 0; k < n; k++) {
        var t = Math.pow(R.range(0, 1), 0.75) * (s.length || 6);
        var w = (s.width || 2) * 0.5 * (0.25 + 0.85 * (t / Math.max(0.5, s.length || 6)));
        var u1 = R.gaussian(0, w * 0.45), u2 = R.gaussian(0, w * 0.45);
        push(o.x + ux * t + ax * u1 + bx2 * u2,
          o.y + uy * t + by2 * u2,
          o.z + uz * t + az * u1 + bz2 * u2,
          R.range(0.55, 1.0) * (s.strength === undefined ? 0.8 : s.strength));
      }
    }

    // ---- a thin haze under the fittings that still strike -------------------
    var lm = this.lamps || [];
    for (i = 0; i < lm.length && i < 14; i++) {
      var L = lm[i];
      if (!L || !L.pos) continue;
      for (k = 0; k < 16; k++) {
        push(L.pos.x + R.gaussian(0, 0.85),
          L.pos.y - R.range(0.15, 1.65),
          L.pos.z + R.gaussian(0, 0.85),
          R.range(0.30, 0.72));
      }
    }

    if (!pos.length) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.computeBoundingSphere();
    var pts = new THREE.Points(g, this.mats.mote);
    pts.name = 'bunker_motes';
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    this.root.add(pts);
    this._motes = pts;
    this._moteData = new Float32Array(base);
  };

  // ==========================================================================
  // COMMIT
  // ==========================================================================
  var STATIC_CARD = { paper: 1, marks: 1, grime: 1 };

  PropsBunker.prototype._commit = function () {
    var key, i;

    // ---- falling water ------------------------------------------------------
    if (this._dripParts.length) {
      var dg = mergeParts(this._dripParts);
      disposeParts(this._dripParts);
      if (dg) {
        Geo.copyUV1(dg);
        var dm = new THREE.Mesh(dg, this.mats.drip);
        dm.name = 'bunker_drips';
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
        try { Geo.worldUV(geo, this._uvScale(UVNAME[key] || 'painted_metal', 500)); }
        catch (e) { /* keep the builder's uv */ }
      }
      Geo.copyUV1(geo);
      if (isCard) {
        paintCard(geo, this.noise, key === 'grime' ? 1.0 : 0.92, 0);
      } else {
        // A one-off is painted with the same dust gradient as everything else,
        // measured over the FACILITY's height rather than a prop's - these
        // vertices are in world space, which is what worldOrigin says.
        paintWear(geo, {
          noise: this.noise, dust: 0.40, edge: 0.20, grime: 0.44,
          loY: this.deckY, hiY: 2.4, worldOrigin: true
        });
      }
      var mat = this.mats[key] || this.mats.steel;
      var mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'bunker_static_' + key;
      mesh.castShadow = !isCard;
      mesh.receiveShadow = true;
      if (isCard) mesh.renderOrder = key === 'grime' ? 2 : 1;
      this.root.add(mesh);
    }

    // ---- instanced batches --------------------------------------------------
    this.stats.batch = {};
    for (i = 0; i < this._batches.length; i++) {
      var b = this._batches[i];
      if (!b || !b.mesh) continue;
      this.stats.batch[b.label || ('b' + i)] = b.n;
      if (b.full) this.stats.full.push((b.label || 'b' + i) + ':' + b.max);
      if (b.finish(this.root, b.label || ('bunker_inst_' + i))) this.stats.instances += b.n;
    }
    this._coverallMesh = this.B.coverall ? this.B.coverall.mesh : null;
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
    this.stats.reject = this._reject;
    this.stats.paper = this._paperCount;
    this.stats.grime = this._grimeCount;

    this.root.userData.colliders = this.colliders;
    this.root.userData.stats = this.stats;
    this.root.updateMatrixWorld(true);

    // Opt-in build diagnostic (index.html?...&propsdbg=1).  Inert otherwise, and
    // it is the only way to see instance-budget overflow, which is silent:
    // Batch.add just returns false and the last pass built gets nothing.
    try {
      if (typeof location !== 'undefined' && /propsdbg=1/.test(location.search || '')) {
        var dbg = JSON.stringify({ st: this.stats, bounds: this.bounds,
          anchors: !!this.A, lamps: (this.lamps || []).length,
          shafts: (this.shafts || []).length });
        if (window.console && console.log) console.log('BUNKERPROPS ' + dbg);
        if (typeof document !== 'undefined' && document.body) {
          var el = document.createElement('div');
          el.id = 'bunkerpropstat';
          el.style.display = 'none';
          el.textContent = dbg;
          document.body.appendChild(el);
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
  // Three things move and all three are the same physical fact: a sealed
  // facility still has one fan running, and there is water arriving through the
  // roof.  Nothing here reads a camera and nothing allocates.
  // ==========================================================================
  PropsBunker.prototype.update = function (dt, ctx) {
    if (!(dt > 0)) dt = 0;
    ctx = ctx || this.ctx;
    if (ctx && typeof ctx.time === 'number' && isFinite(ctx.time)) this.time = ctx.time;
    else this.time += dt;
    var t = this.time;
    var i;

    // ctx.weather is inert on this level by contract, so the draught is a
    // fallback and not a dependency - but if a weather system IS present
    // (someone re-uses this set on a level that has one) its wind drives the
    // same motion rather than a second, contradictory one.
    var w = ctx && ctx.weather;
    var speed = 0.30;
    if (w && typeof w.windSpeed === 'number' && isFinite(w.windSpeed) && w.windSpeed > 0) {
      speed = M.clamp(w.windSpeed * 0.30, 0.20, 2.5);
      if (w.windDir && isFinite(w.windDir.x)) this.windDir.copy(w.windDir);
    }
    this.draught = speed;

    // ---- the hung coveralls -------------------------------------------------
    var cm = this._coverallMesh;
    if (cm && this._drapes.length) {
      var amp = 0.012 + speed * 0.030;
      for (i = 0; i < this._drapes.length && i < cm.count; i++) {
        var d = this._drapes[i];
        var a1 = Math.sin(t * 0.61 + d.phase) * amp;
        var a2 = Math.sin(t * 1.13 + d.phase * 1.7) * amp * 0.5;
        cm.setMatrixAt(i, T(d.x, d.y, d.z, a1 + a2 * 0.4, d.yaw + a2 * 0.5, a2 - a1 * 0.3));
      }
      cm.instanceMatrix.needsUpdate = true;
    }

    // ---- the rings the drips make -------------------------------------------
    var gm = this._ringMesh;
    if (gm && this._rings.length) {
      for (i = 0; i < this._rings.length && i < gm.count; i++) {
        var g2 = this._rings[i];
        var ph = (t * 0.55 + g2.phase) % 1;
        var sc = 0.22 + ph * 1.55;
        gm.setMatrixAt(i, T(g2.x, g2.y, g2.z, 0, g2.phase * 6.28, 0, sc, 1, sc));
        var fade = (1 - ph) * (1 - ph) * 0.85;
        _col.setRGB(fade, fade, fade);
        gm.setColorAt(i, _col);
      }
      gm.instanceMatrix.needsUpdate = true;
      if (gm.instanceColor) gm.instanceColor.needsUpdate = true;
    }

    // ---- the falling water itself -------------------------------------------
    if (this.mats.drip && this.mats.drip.map) {
      var off = this.mats.drip.map.offset;
      off.y = (off.y - dt * 1.15) % 1;
    }

    // ---- the dust in the beams ----------------------------------------------
    // A slow, decorrelated drift on all three axes.  Dust in still air does not
    // fall - it hangs and wanders - and anything that reads as falling reads as
    // snow, which is another level's material entirely.
    var mp = this._motes;
    if (mp && this._moteData) {
      var arr = mp.geometry.attributes.position.array;
      var bd = this._moteData;
      var n2 = bd.length / 4;
      var drift = 0.055 + speed * 0.10;
      for (i = 0; i < n2; i++) {
        var ph2 = bd[i * 4 + 3];
        arr[i * 3] = bd[i * 4] + Math.sin(t * 0.21 + ph2) * drift +
          Math.sin(t * 0.083 + ph2 * 2.3) * drift * 1.6;
        arr[i * 3 + 1] = bd[i * 4 + 1] + Math.sin(t * 0.13 + ph2 * 1.7) * drift * 0.75;
        arr[i * 3 + 2] = bd[i * 4 + 2] + Math.cos(t * 0.17 + ph2 * 0.9) * drift +
          Math.cos(t * 0.061 + ph2 * 1.3) * drift * 1.4;
      }
      mp.geometry.attributes.position.needsUpdate = true;
    }
  };

  PropsBunker.prototype.resize = function () { /* nothing viewport-dependent */ };

  PropsBunker.prototype.dispose = function () {
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

  GAME.PropsBunker = PropsBunker;

})(window.GAME, window.THREE);
